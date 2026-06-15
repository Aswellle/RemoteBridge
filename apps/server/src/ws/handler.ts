import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import { verifyToken, TokenPayload } from '../utils/jwt';
import { db } from '../db/client';
import { sessions, messages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { WSMessage, WSMessageType } from '@remotebridge/shared';
import {
  sendWSMessage,
  relayMessage,
  relayToClient,
  notifyHost,
} from './relay';
import {
  ConnectionMeta,
  registerHost,
  unregisterHost,
  registerClient,
  unregisterClient,
  getClientSocket,
  rebindClientToHost,
  clearHostClients,
  forEachHost,
  forEachClient,
  clearAll,
} from './connection-registry';
import { resolvePendingRequest } from './pending-requests';
import { resolveFileTunnelMessage } from './file-tunnel';

// ===== 心跳配置 =====
const HEARTBEAT_INTERVAL = 30000;  // 30 秒
const HEARTBEAT_TIMEOUT = 60000;   // 60 秒无响应则关闭

// ===== 设置 WebSocket 处理 =====
export function setupWebSocket(app: FastifyInstance): void {
  // 心跳定时器
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();

    // 检查所有 Host 连接（超时只 close，由 close 事件统一清理房间，避免重复/竞态删除）
    forEachHost((hostId, ws) => {
      const meta = (ws as any).__meta as ConnectionMeta;
      if (meta && now - meta.lastPong > HEARTBEAT_TIMEOUT) {
        app.log.warn(`Host ${hostId} 心跳超时，关闭连接`);
        ws.close(4000, 'Heartbeat timeout');
      } else {
        sendWSMessage(ws, { type: WSMessageType.PING, timestamp: now });
      }
    });

    // 检查所有 Client 连接
    forEachClient((clientId, ws) => {
      const meta = (ws as any).__meta as ConnectionMeta;
      if (meta && now - meta.lastPong > HEARTBEAT_TIMEOUT) {
        app.log.warn(`Client ${clientId} 心跳超时，关闭连接`);
        ws.close(4000, 'Heartbeat timeout');
      } else {
        sendWSMessage(ws, { type: WSMessageType.PING, timestamp: now });
      }
    });
  }, HEARTBEAT_INTERVAL);

  // WebSocket 端点
  app.get('/ws', { websocket: true }, (connection, req) => {
    const socket = connection.socket as WebSocket;

    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const type = url.searchParams.get('type') as 'host' | 'client';

    // 验证参数
    if (!token || !type || !['host', 'client'].includes(type)) {
      socket.close(4001, 'Missing or invalid parameters');
      return;
    }

    // 验证 JWT（refresh token 不可用于建立 WS 连接）
    let payload: TokenPayload;
    try {
      payload = verifyToken(token);
      if (payload.type !== type) {
        throw new Error('Token type mismatch');
      }
      if ((payload as any).use === 'refresh') {
        throw new Error('Refresh token not allowed');
      }
    } catch (err) {
      app.log.warn('WebSocket 认证失败:', err as any);
      socket.close(4001, 'Unauthorized');
      return;
    }

    // 设置连接元数据
    const meta: ConnectionMeta = {
      type,
      id: payload.sub,
      lastPong: Date.now(),
    };

    if (type === 'client') {
      meta.sessionId = (payload as any).sessionId;
      meta.hostId = (payload as any).hostId;
      meta.connectedAt = Date.now();
    }

    (socket as any).__meta = meta;

    // 注册到房间管理
    if (type === 'host') {
      registerHost(payload.sub, socket);
      app.log.info(`Host ${payload.sub} 已连接`);

      // Host（重）上线：Host 掉线时 close 事件清空了房间映射，
      // 仍在线的 Client 的映射必须在这里重建，否则它们的 CMD_* 永远 PEER_OFFLINE；
      // 同时广播 HOST_ONLINE，让 Web 端解除"主机离线"状态
      forEachClient((clientId, clientWs) => {
        const clientMeta = (clientWs as any).__meta as ConnectionMeta | undefined;
        if (clientMeta?.hostId === payload.sub) {
          rebindClientToHost(clientId, payload.sub);
          sendWSMessage(clientWs, {
            type: WSMessageType.HOST_ONLINE,
            payload: { hostId: payload.sub, timestamp: Date.now() },
            timestamp: Date.now(),
          });
        }
      });
    } else {
      registerClient(payload.sub, socket, meta.hostId);
      app.log.info(`Client ${payload.sub} 已连接`);

      // 异步校验会话是否已被吊销（JWT 2h 内仍有效，但吊销必须立即生效），
      // 顺带取 clientLabel；校验通过后才通知 Host 有新 Client 加入
      validateClientSession(socket, meta, app);
    }

    // 消息处理
    socket.on('message', (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        handleMessage(socket, message, meta);
      } catch (err) {
        app.log.error('解析 WebSocket 消息失败:', err as any);
        sendWSMessage(socket, {
          type: WSMessageType.ERROR,
          payload: { code: 'INVALID_MESSAGE', message: '消息格式无效' },
          timestamp: Date.now(),
        });
      }
    });

    // 连接关闭
    socket.on('close', (code: number, reason: Buffer) => {
      const meta = (socket as any).__meta as ConnectionMeta;
      if (meta) {
        if (meta.type === 'host') {
          // 重连竞态保护：仅当房间里登记的还是“本”socket 才清理。
          // 否则新连接已覆盖该条目，旧 socket 的 close 不应误删新连接。
          if (!unregisterHost(meta.id, socket)) {
            app.log.info(`Host ${meta.id} 旧连接关闭（已被新连接替换）`);
            return;
          }
          app.log.info(`Host ${meta.id} 已断开 (${code}: ${reason})`);

          // 通知所有关联的 Client
          clearHostClients(meta.id).forEach((clientId) => {
            const clientWs = getClientSocket(clientId);
            if (clientWs) {
              sendWSMessage(clientWs, {
                type: WSMessageType.HOST_OFFLINE,
                payload: { hostId: meta.id, timestamp: Date.now() },
                timestamp: Date.now(),
              });
            }
          });
        } else {
          if (!unregisterClient(meta.id, socket)) {
            app.log.info(`Client ${meta.id} 旧连接关闭（已被新连接替换）`);
            return;
          }
          app.log.info(`Client ${meta.id} 已断开 (${code}: ${reason})`);

          // 通知 Host
          if (meta.hostId) {
            notifyHost(meta.hostId, WSMessageType.CLIENT_LEFT, {
              clientId: meta.id,
              timestamp: Date.now(),
            });
          }
        }
      }
    });

    // 错误处理
    socket.on('error', (err: Error) => {
      app.log.error('WebSocket 错误:', err as any);
    });

    // 发送连接成功消息
    sendWSMessage(socket, {
      type: WSMessageType.ACK,
      payload: { message: 'Connected', type },
      timestamp: Date.now(),
    });
  });

  // 优雅关闭：清理定时器并主动断开所有连接（code 1001），
  // 房间状态是纯内存的，干净断开能让 Host/Client 立即触发重连到新实例
  app.addHook('onClose', () => {
    clearInterval(heartbeatTimer);
    forEachHost((_hostId, ws) => ws.close(1001, 'Server shutting down'));
    forEachClient((_clientId, ws) => ws.close(1001, 'Server shutting down'));
    clearAll();
  });
}

// ===== 客户端会话校验（吊销检查 + clientLabel 加载） =====
async function validateClientSession(
  socket: WebSocket,
  meta: ConnectionMeta,
  app: FastifyInstance,
): Promise<void> {
  try {
    if (!meta.sessionId) {
      socket.close(4003, 'Missing session');
      return;
    }

    const rows = await db.select()
      .from(sessions)
      .where(eq(sessions.id, meta.sessionId))
      .limit(1);

    if (!rows.length || rows[0].revokedAt) {
      app.log.warn(`Client ${meta.id} 会话已吊销或不存在，拒绝连接`);
      socket.close(4003, 'Session revoked');
      return;
    }

    meta.clientLabel = rows[0].clientLabel || undefined;

    // 校验通过，通知 Host 有新 Client 加入（带标签，供 Host 端展示/登记）
    if (meta.hostId) {
      notifyHost(meta.hostId, WSMessageType.CLIENT_JOINED, {
        clientId: meta.id,
        clientLabel: meta.clientLabel,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    app.log.error('校验客户端会话失败:', err as any);
  }
}

// ===== 消息处理 =====
async function handleMessage(socket: WebSocket, message: WSMessage, meta: ConnectionMeta): Promise<void> {
  switch (message.type) {
    case WSMessageType.PONG:
      // 更新最后响应时间
      (socket as any).__meta.lastPong = Date.now();
      break;

    case WSMessageType.PING:
      // 回显请求 id —— 对端依赖 id 匹配 pending ping 来计算 RTT
      sendWSMessage(socket, {
        id: message.id,
        type: WSMessageType.PONG,
        timestamp: Date.now(),
      } as Partial<WSMessage>);
      break;

    case WSMessageType.MSG_TEXT: {
      // Host 连接的 meta 没有 sessionId（一个 Host 可对应多个会话），
      // 它发消息只带目标 clientId —— sessionId 必须从目标 Client 的连接元数据反查。
      // 不补这个字段的话，Host→Client 的消息会因 sessionId 为空而从不持久化，
      // Web 端拉历史永远看不到主机发来的消息。
      if (meta.type === 'host' && !message.sessionId) {
        const targetClientId = (message.payload as { clientId?: string } | undefined)?.clientId;
        const targetWs = targetClientId ? getClientSocket(targetClientId) : undefined;
        const targetMeta = targetWs ? ((targetWs as any).__meta as ConnectionMeta | undefined) : undefined;
        if (targetMeta?.sessionId) {
          message.sessionId = targetMeta.sessionId;
        }
      }

      // 消息持久化：将聊天消息写入 messages 表。
      // 主键优先用发送端的原始消息 id（relay 注入的 messageId / 顶层 id）——
      // Web/桌面端本地列表用的是同一个 id，历史拉取时才能按 id 去重，
      // 否则"在线收到 + 历史加载"会出现同一条消息两个 id 的重复。
      try {
        const payload = message.payload as { content?: string; messageId?: string };
        const now = Math.floor(Date.now() / 1000);
        const direction = meta.type === 'host' ? 'host_to_client' : 'client_to_host';
        const sessionId = meta.sessionId || message.sessionId || '';

        if (sessionId && payload.content) {
          await db.insert(messages).values({
            id: payload.messageId || message.id || nanoid(),
            sessionId,
            direction,
            content: payload.content,
            type: 'text',
            createdAt: now,
          }).onConflictDoNothing();
        }
      } catch (err) {
        console.error('持久化消息失败:', err);
      }
      // 继续中继消息给对方
      relayMessage(socket, message, meta);
      break;
    }

    case WSMessageType.CMD_LIST_DIR:
    case WSMessageType.CMD_LIST_ALLOWED:
    case WSMessageType.CMD_REQUEST_DOWNLOAD:
    case WSMessageType.CMD_REQUEST_PREVIEW:
      // 中继消息给对方
      relayMessage(socket, message, meta);
      break;

    case WSMessageType.RESP_FILE_CHUNK:
    case WSMessageType.RESP_FILE_ERROR:
      // 文件隧道帧只属于服务端代理，永不中继给 Client
      // （无主帧——传输已超时/被取消——也在 resolve 内静默丢弃）
      resolveFileTunnelMessage(message);
      break;

    case WSMessageType.RESP_DIR_LIST:
    case WSMessageType.RESP_DIR_ERROR:
    case WSMessageType.RESP_DOWNLOAD_READY:
    case WSMessageType.RESP_DOWNLOAD_ERROR:
    case WSMessageType.RESP_PREVIEW_READY:
    case WSMessageType.RESP_PREVIEW_ERROR:
    case WSMessageType.MSG_NOTIFICATION:
      // 先检查是否为服务端（代理）发起的请求 —— 命中则消费，不向 Client 中继
      if (resolvePendingRequest(message)) {
        break;
      }
      // Host 响应，转发给对应的 Client
      {
        const sessionId = message.sessionId || (message.payload as any)?.sessionId;
        const clientId = (message.payload as any)?.clientId;
        relayToClient(message, clientId || '', sessionId);
      }
      break;

    default:
      sendWSMessage(socket, {
        type: WSMessageType.ERROR,
        payload: { code: 'UNKNOWN_TYPE', message: `未知消息类型: ${message.type}` },
        timestamp: Date.now(),
      });
  }
}
