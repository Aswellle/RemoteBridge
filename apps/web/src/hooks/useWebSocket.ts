'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { WSMessage, WSMessageType, RespUploadAckPayload, RespUploadErrorPayload } from '@remotebridge/shared';
import { useAppStore } from '@/store/app-store';
import api, { refreshAccessToken } from '@/lib/api';
import { handleDownloadReady, handleDownloadError } from '@/lib/download-manager';
import { logger } from '@/lib/logger';
import { RELAY_WS_URL } from '@/lib/env';

// ===== WebSocket 管理器 =====
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectAttempts = 0;
  // 主动断开（用户操作/会话终结）后置位，阻止任何后续自动重连
  private stopped = false;
  // 防止 connect() 被并发重入：this.ws 只在换票+建连完成后才赋值，
  // 期间（尤其是 await fetchWsTicket() 那段）第二次 connect() 调用会绕过
  // 上面那个"已连接/正在连接"判断（this.ws 此时仍是 null），各自换一张票据、
  // 各建一条 WS——React StrictMode 的双重 effect、或 layout 与某个页面各自调用
  // 一次 connect() 都会触发，结果是同一个 clientId 建两条连接，Host 端收到两次
  // CLIENT_JOINED 通知。用这个字段把并发调用收敛到同一个 in-flight Promise 上。
  private connectPromise: Promise<void> | null = null;

  constructor(
    private url: string,
    private store: typeof useAppStore
  ) {}

  // 获取 30 秒一次性 WS 票据（02a-S11）
  // api 实例已配置 withCredentials，rb_access cookie 自动携带
  private async fetchWsTicket(): Promise<string> {
    const response = await api.get('/auth/ws-ticket');
    return (response.data.data as { ticket: string }).ticket;
  }

  async connect(): Promise<void> {
    // 已连接或正在连接时为幂等 no-op —— 这让 connect() 可以被
    // layout / 各页面 / online 事件随意调用而不会重复建连
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    // 已有一次 connect() 在途（还没到给 this.ws 赋值那一步）：复用同一个
    // Promise，而不是各自换票各建一条连接
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopped = false;

    // 以 sessionId 在 localStorage 中的存在作为"已有会话"的判断依据
    const sessionId = typeof window !== 'undefined' ? localStorage.getItem('sessionId') : null;
    if (!sessionId) {
      this.store.getState().setConnectionStatus('disconnected');
      return;
    }

    // 换取短生命期 WS 票据（服务端用 httpOnly cookie 中的 rb_access 验证身份）
    let ticket: string;
    try {
      ticket = await this.fetchWsTicket();
    } catch (err: any) {
      if (err?.response?.status === 401) {
        // cookie 可能已过期，先刷新再重试
        try {
          await refreshAccessToken();
          ticket = await this.fetchWsTicket();
        } catch {
          this.terminateSession('expired', '会话已过期，请重新连接');
          return;
        }
      } else {
        // 网络错误或服务端暂不可达 → 退避重连
        this.scheduleReconnect();
        return;
      }
    }

    const wsUrl = `${this.url}?ticket=${encodeURIComponent(ticket)}&type=client`;
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
        // 票据过期或 token 失效：直接重新 connect()，内部会重新换票并在必要时刷新 cookie
        void this.connect();
        return;
      }

      // 其他异常关闭：持续重连（指数退避、30s 封顶、不设次数上限）
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

      case WSMessageType.RESP_UPLOAD_ACK: {
        const p = message.payload as RespUploadAckPayload;
        this.store.getState().updateFileMessage(p.uploadId, {
          uploadStatus: 'completed',
          savedPath: p.savedPath,
          uploadProgress: 100,
        });
        toast.success('文件已接收', { description: `${p.fileName} 已保存至桌面端` });
        break;
      }

      case WSMessageType.RESP_UPLOAD_ERROR: {
        const p = message.payload as RespUploadErrorPayload;
        this.store.getState().updateFileMessage(p.uploadId, {
          uploadStatus: 'error',
        });
        toast.error('文件发送失败', { description: p.message });
        break;
      }

      case WSMessageType.HOST_DIRS_UPDATED: {
        // Host 目录/权限发生变更：若当前正在浏览根白名单列表则立即刷新，否则静默记录
        const { currentPath, listAllowed } = this.store.getState();
        if (currentPath === null) {
          listAllowed();
        }
        break;
      }
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
      void this.connect();
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
    if (sharedManager && localStorage.getItem('sessionId')) {
      void sharedManager.connect();
    }
  });
}

// ===== React Hook =====
export function useWebSocket() {
  const store = useAppStore;

  const connect = useCallback(() => {
    const { sessionId } = store.getState();
    if (!sessionId) return;

    // manager 可复用：connect() 对已连接/连接中的实例是 no-op，
    // 对断开的实例则重新建连（之前"已有 manager 就直接 return"——
    // 断开后重新登录时永远不会再建连，必须刷新页面）
    if (!sharedManager) {
      sharedManager = new WebSocketManager(RELAY_WS_URL, store);
    }
    void sharedManager.connect();
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
