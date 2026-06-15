'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { WSMessage, WSMessageType } from '@remotebridge/shared';
import { useAppStore } from '@/store/app-store';
import { refreshAccessToken } from '@/lib/api';
import { handleDownloadReady, handleDownloadError } from '@/lib/download-manager';
import { logger } from '@/lib/logger';

// ===== WebSocket 管理器 =====
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectAttempts = 0;
  // 主动断开（用户操作/会话终结）后置位，阻止任何后续自动重连
  private stopped = false;

  constructor(
    private url: string,
    private store: typeof useAppStore
  ) {}

  connect(): void {
    // 已连接或正在连接时为幂等 no-op —— 这让 connect() 可以被
    // layout / 各页面 / online 事件随意调用而不会重复建连
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopped = false;

    // 每次（重）连接都读取最新 accessToken。
    // localStorage 优先：REST 401 拦截器刷新 token 后先写 localStorage，
    // 它才是跨模块的单一事实来源（store 同步可能滞后）。
    const token = (typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null) ||
      this.store.getState().accessToken;
    if (!token) {
      this.store.getState().setConnectionStatus('disconnected');
      return;
    }

    const wsUrl = `${this.url}?token=${token}&type=client`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      logger.info('WebSocket 连接成功');
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.store.getState().setConnectionStatus('connected');
      this.store.getState().setWsInstance(this.ws);
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (err) {
        logger.error('解析 WebSocket 消息失败:', err);
      }
    };

    this.ws.onclose = (event) => {
      logger.info('WebSocket 连接关闭:', event.code, event.reason);
      this.store.getState().setConnectionStatus('disconnected');
      this.store.getState().setWsInstance(null);

      if (this.stopped || event.code === 1000) return;

      if (event.code === 4003) {
        // 握手阶段就被拒：会话已被主机吊销
        this.terminateSession('revoked', '会话已被主机吊销');
        return;
      }

      if (event.code === 4001) {
        // 认证失败：access token 大概率已过期，刷新后立即重连；
        // 刷新也失败则会话彻底失效，回到连接页
        refreshAccessToken()
          .then(() => this.connect())
          .catch(() => this.terminateSession('expired', '会话已过期，请重新连接'));
        return;
      }

      // 其他异常关闭：持续重连（指数退避、30s 封顶、不设次数上限——
      // 之前 10 次后放弃，用户只能刷新页面才能恢复）
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      logger.error('WebSocket 错误:', error);
      this.store.getState().setConnectionStatus('error');
    };
  }

  private handleMessage(message: WSMessage): void {
    switch (message.type) {
      case WSMessageType.PING:
        this.send({ ...message, type: WSMessageType.PONG });
        break;

      case WSMessageType.RESP_DIR_LIST:
        // path 为 null 表示白名单根列表
        this.store.getState().setCurrentPath((message.payload as any).path ?? null);
        this.store.getState().setDirEntries((message.payload as any).entries);
        this.store.getState().setIsLoadingDir(false);
        break;

      case WSMessageType.RESP_DIR_ERROR: {
        this.store.getState().setIsLoadingDir(false);
        const errMsg = (message.payload as any).message || '目录访问被拒绝';
        logger.error('目录访问错误:', errMsg);
        // 之前只打 console，用户面对的是转完圈后凭空消失的加载态
        toast.error('无法打开目录', { description: errMsg });
        break;
      }

      // 下载响应统一交给 download-manager（含 127.0.0.1 → relay 代理改写、
      // 鉴权流式下载与真实进度回写）
      case WSMessageType.RESP_DOWNLOAD_READY:
        void handleDownloadReady(message.payload as any);
        break;

      case WSMessageType.RESP_DOWNLOAD_ERROR:
        handleDownloadError(message.payload as any);
        break;

      case WSMessageType.MSG_TEXT:
        this.store.getState().addMessage({
          id: message.id,
          content: (message.payload as any).content,
          // Relay 中继时注入 senderType；'host' 即来自主机的消息
          direction: (message.senderType === 'host' || (message.payload as any).senderType === 'host')
            ? 'host_to_client' : 'client_to_host',
          type: 'text',
          timestamp: message.timestamp,
        });
        break;

      case WSMessageType.HOST_OFFLINE:
        this.store.getState().setIsLoadingDir(false);
        this.store.getState().setHostInfo(
          this.store.getState().hostInfo
            ? { ...this.store.getState().hostInfo!, online: false }
            : null
        );
        this.store.getState().addMessage({
          id: message.id,
          content: '远程主机已离线',
          direction: 'host_to_client',
          type: 'system',
          timestamp: message.timestamp,
        });
        toast.warning('远程主机已离线', { description: '主机恢复在线后会自动通知' });
        break;

      case WSMessageType.HOST_ONLINE:
        // 服务端在 Host 重连时会重建路由并广播本消息
        this.store.getState().setHostInfo(
          this.store.getState().hostInfo
            ? { ...this.store.getState().hostInfo!, online: true }
            : null
        );
        this.store.getState().addMessage({
          id: message.id,
          content: '远程主机已重新上线',
          direction: 'host_to_client',
          type: 'system',
          timestamp: message.timestamp,
        });
        toast.success('远程主机已重新上线');
        break;

      case WSMessageType.MSG_SYSTEM:
        this.store.getState().addMessage({
          id: message.id,
          content: (message.payload as any).content,
          direction: 'host_to_client',
          type: 'system',
          timestamp: message.timestamp,
        });
        break;

      case WSMessageType.SESSION_REVOKED:
        this.terminateSession('revoked', '会话已被主机吊销');
        break;
    }
  }

  // ===== 会话终结（吊销/过期）：清理 + 提示 + 回连接页 =====
  // 之前的处理是静默踢回首页，用户不知道发生了什么；
  // reason 通过 query 传给首页，刷新后提示也不丢
  private terminateSession(reason: 'revoked' | 'expired', description: string): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    toast.error('连接已断开', { description });
    this.store.getState().disconnect();
    if (typeof window !== 'undefined') {
      window.location.href = `/?reason=${reason}`;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    );

    logger.debug(`将在 ${this.reconnectDelay}ms 后重连 (第 ${this.reconnectAttempts} 次)`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  send(message: Partial<WSMessage>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        id: message.id || crypto.randomUUID(),
        type: message.type,
        payload: message.payload || {},
        timestamp: message.timestamp || Date.now(),
        sessionId: message.sessionId,
      }));
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }
  }
}

// ===== 模块级单例 =====
// manager 必须全局唯一：layout 和各页面都会调用 connect()，
// 组件级实例会导致重复建连；组件卸载时也不能断开共享连接
// （否则从文件页切到消息页时 WS 就被杀掉了）。
let sharedManager: WebSocketManager | null = null;

// 网络恢复时立即重连，不等退避计时器走完
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (sharedManager && localStorage.getItem('accessToken')) {
      sharedManager.connect();
    }
  });
}

// ===== React Hook =====
export function useWebSocket() {
  const store = useAppStore;

  const connect = useCallback(() => {
    const { accessToken } = store.getState();
    if (!accessToken) return;

    // manager 可复用：connect() 对已连接/连接中的实例是 no-op，
    // 对断开的实例则重新建连（之前"已有 manager 就直接 return"——
    // 断开后重新登录时永远不会再建连，必须刷新页面）
    if (!sharedManager) {
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws';
      sharedManager = new WebSocketManager(wsUrl, store);
    }
    sharedManager.connect();
  }, [store]);

  const disconnect = useCallback(() => {
    if (sharedManager) {
      sharedManager.disconnect();
      sharedManager = null;
    }
  }, []);

  const send = useCallback((message: Partial<WSMessage>) => {
    if (sharedManager) {
      sharedManager.send(message);
    }
  }, []);

  return { connect, disconnect, send };
}
