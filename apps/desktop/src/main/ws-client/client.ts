import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import { WSMessage, WSMessageType } from '@remotebridge/shared';
import { app, BrowserWindow } from 'electron';

// ===== Relay 客户端配置 =====
interface RelayClientConfig {
  relayUrl: string;
  hostId: string;
  hostToken: string;
  onMessage?: (message: WSMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  /** 认证失败（close 4001，token 过期/被吊销）。设置后 4001 不再盲目重连，由回调走重新注册流程 */
  onAuthFailure?: () => void;
}

// ===== RTT 追踪配置 =====
const RTT_MAX_SAMPLES = 10;

// ===== Relay 客户端类 =====
export class RelayClient {
  private ws: WebSocket | null = null;
  private config: RelayClientConfig;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectAttempts = 0;
  private messageHandlers = new Map<string, (payload: unknown) => void>();
  private isConnecting = false;
  private rttSamples: number[] = [];
  private pendingPings = new Map<string, number>();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(config: RelayClientConfig) {
    this.config = config;
  }

  // ===== 连接到 Relay Server =====
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }

    this.isConnecting = true;

    try {
      const wsUrl = `${this.config.relayUrl}?token=${this.config.hostToken}&type=host`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('已连接到 Relay Server');
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.isConnecting = false;
        this.config.onConnect?.();

        // 开始定期发送 PING 以测量 RTT
        this.startPingLoop();
      });

      this.ws.on('message', (data) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (err) {
          console.error('解析消息失败:', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`连接关闭: ${code} - ${reason}`);
        this.isConnecting = false;
        this.stopPingLoop();
        this.config.onDisconnect?.();

        // 4001 = token 被拒（过期/主机记录丢失）。
        // 拿同一个旧 token 重连只会无限 4001 —— 交给恢复回调重新校验/注册身份
        if (code === 4001 && this.config.onAuthFailure) {
          this.config.onAuthFailure();
          return;
        }

        // 非正常关闭时持续重连（Host 是常驻代理，放弃重连等于永久离线）
        if (code !== 1000) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket 错误:', error);
        this.isConnecting = false;
        this.config.onError?.(error as Error);
      });
    } catch (error) {
      this.isConnecting = false;
      this.config.onError?.(error as Error);
    }
  }

  // ===== 消息处理 =====
  private handleMessage(message: WSMessage): void {
    // 处理心跳 — 收到 PING 时回复 PONG
    if (message.type === WSMessageType.PING) {
      this.send({ ...message, type: WSMessageType.PONG });
      return;
    }

    // 处理 PONG — 计算 RTT
    if (message.type === WSMessageType.PONG) {
      const pingId = message.id;
      const sentAt = this.pendingPings.get(pingId);
      if (sentAt) {
        const rtt = Date.now() - sentAt;
        this.pendingPings.delete(pingId);
        this.rttSamples.push(rtt);
        if (this.rttSamples.length > RTT_MAX_SAMPLES) {
          this.rttSamples.shift();
        }
      }
      return;
    }

    // 调用通用处理器
    this.config.onMessage?.(message);

    // 调用类型特定处理器
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message.payload);
    }
  }

  // ===== 调度重连 =====
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    );

    console.log(`将在 ${this.reconnectDelay}ms 后重连 (第 ${this.reconnectAttempts} 次)`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  // ===== 发送消息 =====
  // 返回是否实际发出：连接未 OPEN 时消息会被静默丢弃，调用方可据此决定是否
  // 中止后续工作（例如文件隧道在发送失败时停止继续读盘）。
  send(message: Partial<WSMessage>): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        id: message.id || nanoid(),
        type: message.type,
        payload: message.payload || {},
        timestamp: message.timestamp || Date.now(),
        sessionId: message.sessionId,
      }));
      return true;
    }
    console.warn(`send: 连接未就绪 (readyState=${this.ws?.readyState}), 丢弃消息 type=${message.type}`);
    return false;
  }

  // ===== 注册消息处理器 =====
  on(type: string, handler: (payload: unknown) => void): void {
    this.messageHandlers.set(type, handler);
  }

  // ===== 移除消息处理器 =====
  off(type: string): void {
    this.messageHandlers.delete(type);
  }

  // ===== 断开连接 =====
  disconnect(): void {
    this.stopPingLoop();
    this.pendingPings.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }
  }

  // ===== 检查连接状态 =====
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ===== 发送缓冲区水位（文件隧道按此做背压，避免大文件把内存撑爆） =====
  getBufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  // ===== 定期发送 PING 测量 RTT =====
  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // 清理超过 30s 未应答的 ping，防止 Map 无限增长
        const cutoff = Date.now() - 30000;
        this.pendingPings.forEach((sentAt, pingId) => {
          if (sentAt < cutoff) {
            this.pendingPings.delete(pingId);
          }
        });

        const id = nanoid();
        this.pendingPings.set(id, Date.now());
        this.send({ id, type: WSMessageType.PING, payload: {} });
      }
    }, 5000);
  }

  // ===== 停止 PING 循环 =====
  private stopPingLoop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ===== 获取平均 RTT =====
  getAverageRtt(): number {
    if (this.rttSamples.length === 0) return 0;
    const sum = this.rttSamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.rttSamples.length);
  }
}

// ===== 创建全局实例 =====
let relayClient: RelayClient | null = null;

export function getRelayClient(): RelayClient | null {
  return relayClient;
}

export function createRelayClient(config: RelayClientConfig): RelayClient {
  if (relayClient) {
    relayClient.disconnect();
  }
  relayClient = new RelayClient(config);
  return relayClient;
}
