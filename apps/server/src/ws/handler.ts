import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import { verifyToken, TokenPayload } from '../utils/jwt';
import { db, isSessionRevoked } from '../db/client';
import { sessions, messages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { WSMessage, WSMessageType } from '@remotebridge/shared';
import {
  sendWSMessage,
  relayMessage,
  relayToClient,
  notifyHost,
  broadcastToHostClients,
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
  getConnMeta,
  setConnMeta,
} from './connection-registry';
import { resolvePendingRequest } from './pending-requests';
import { resolveFileTunnelMessage, resolveFileTunnelBinaryFrame } from './file-tunnel';
import { redeemTicket } from './tickets';
import { decodeFileChunkFrame } from '@remotebridge/shared';
import { logger } from '../utils/logger';

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
      const meta = getConnMeta(ws);
      if (meta && now - meta.lastPong > HEARTBEAT_TIMEOUT) {
        app.log.warn(`Host ${hostId} 心跳超时，关闭连接`);
        ws.close(4000, 'Heartbeat timeout');
      } else {
        sendWSMessage(ws, { type: WSMessageType.PING, timestamp: now });
      }
    });

    // 检查所有 Client 连接
    forEachClient((clientId, ws) => {
      const meta = getConnMeta(ws);
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
    const ticket = url.searchParams.get('ticket');
    const type = url.searchParams.get('type') as 'host' | 'client';

    if (!type || !['host', 'client'].includes(type)) {
      socket.close(4001, 'Missing or invalid parameters');
      return;
    }

    // 设置连接元数据（两条认证路径均填充到同一 meta 结构）
    let meta: ConnectionMeta;

    if (type === 'client' && ticket) {
      // --- 新路径：一次性 WS 票据（web 客户端，02a-S11）---
      const ticketData = redeemTicket(ticket);
      if (!ticketData) {
        app.log.warn('WebSocket 票据无效或已过期');
        socket.close(4001, 'Invalid or expired ticket');
        return;
      }
      meta = {
        type: 'client',
        id: ticketData.clientId,
        sessionId: ticketData.sessionId,
        hostId: ticketData.hostId,
        lastPong: Date.now(),
        connectedAt: Date.now(),
      };
    } else if (token) {
      // --- 旧路径：直接 JWT（Host 桌面端，旧版 web 客户端过渡期）---
      let payload: TokenPayload;
      try {
        payload = verifyToken(token);
        if (payload.type !== type) throw new Error('Token type mismatch');
        if ((payload as any).use === 'refresh') throw new Error('Refresh token not allowed');
      } catch (err) {
        app.log.warn('WebSocket 认证失败:', err as any);
        socket.close(4001, 'Unauthorized');
        return;
      }
      meta = {
        type,
        id: payload.sub,
        lastPong: Date.now(),
      };
      if (type === 'client') {
        meta.sessionId = (payload as any).sessionId;
        meta.hostId = (payload as any).hostId;
        meta.connectedAt = Date.now();
      }
    } else {
      socket.close(4001, 'Missing or invalid parameters');
      return;
    }

    setConnMeta(socket, meta);

    // 注册到房间管理（meta.id = payload.sub 或 ticketData.clientId，两条路径均已填充）
    if (type === 'host') {
      registerHost(meta.id, socket);
      app.log.info(`Host ${meta.id} 已连接`);

      // Host（重）上线：Host 掉线时 close 事件清空了房间映射，
      // 仍在线的 Client 的映射必须在这里重建，否则它们的 CMD_* 永远 PEER_OFFLINE；
      // 同时广播 HOST_ONLINE，让 Web 端解除"主机离线"状态
      forEachClient((clientId, clientWs) => {
        const clientMeta = getConnMeta(clientWs);
        if (clientMeta?.hostId === meta.id) {
          rebindClientToHost(clientId, meta.id);
          sendWSMessage(clientWs, {
            type: WSMessageType.HOST_ONLINE,
            payload: { hostId: meta.id, timestamp: Date.now() },
            timestamp: Date.now(),
          });
        }
      });
    } else {
      // SM6: 在注册消息处理器之前同步检查会话吊销状态（消除 ~10ms 异步窗口）
      if (!meta.sessionId || isSessionRevoked(meta.sessionId)) {
        app.log.warn(`Client ${meta.id} 会话已吊销，拒绝连接`);
        socket.close(4003, 'Session revoked');
        return;
      }
      registerClient(meta.id, socket, meta.hostId);
      app.log.info(`Client ${meta.id} 已连接`);
      // 异步部分：取 clientLabel 并通知 Host
      validateClientSession(socket, meta, app);
    }

    // 消息处理
    socket.on('message', (data, isBinary) => {
      // 二进制帧（P1-12）：文件隧道分块的首选格式，自描述头部见 file-tunnel-codec.ts。
      // 仅服务端代理 ↔ Host 之间使用，永不出现在 Client 连接上。
      if (isBinary) {
        try {
          const decoded = decodeFileChunkFrame(data as Buffer);
          resolveFileTunnelBinaryFrame(decoded);
        } catch (err) {
          app.log.error('解析文件隧道二进制帧失败:', err as any);
        }
        return;
      }

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
      const meta = getConnMeta(socket);
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
    case WSMessageType.PONG: {
      // 更新最后响应时间
      const pongMeta = getConnMeta(socket);
      if (pongMeta) pongMeta.lastPong = Date.now();
      break;
    }

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
        const targetMeta = targetWs ? getConnMeta(targetWs) : undefined;
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
        logger.error({ err }, '持久化消息失败');
      }
      // 继续中继消息给对方
      relayMessage(socket, message, meta);
      break;
    }

    case WSMessageType.HOST_DIRS_UPDATED:
      // Host 目录变更通知：广播给该 Host 的所有在线 Client
      if (meta.hostId) {
        broadcastToHostClients(meta.hostId, {
          type: WSMessageType.HOST_DIRS_UPDATED,
          payload: message.payload,
          timestamp: Date.now(),
        });
      }
      break;

    case WSMessageType.CMD_LIST_DIR:
    case WSMessageType.CMD_LIST_ALLOWED:
    case WSMessageType.CMD_REQUEST_DOWNLOAD:
    case WSMessageType.CMD_REQUEST_PREVIEW:
    case WSMessageType.CMD_UPLOAD_FILE_CHUNK:
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
    case WSMessageType.RESP_UPLOAD_ACK:
    case WSMessageType.RESP_UPLOAD_ERROR:
    case WSMessageType.MSG_NOTIFICATION:
      // 文件上传成功：persist 一条 type:'file' 的消息，否则这次文件发送在
      // messages 表里完全没有痕迹——CMD_UPLOAD_FILE_CHUNK 本身只是分块转发
      // （见上面的 case），从未写库；不补这条的话 Web 端跨 session 拉历史、
      // 桌面端重新打开会话都看不到任何文件发送记录。用 uploadId 做主键（同一次
      // 上传的多个分块共享这个 id，天然防止 RESP_UPLOAD_ACK 重复处理时重复插入）。
      if (message.type === WSMessageType.RESP_UPLOAD_ACK) {
        try {
          const uploadPayload = message.payload as { uploadId?: string; fileName?: string; sessionId?: string };
          const now = Math.floor(Date.now() / 1000);
          const sessionId = message.sessionId || uploadPayload.sessionId || '';
          if (sessionId && uploadPayload.fileName && uploadPayload.uploadId) {
            await db.insert(messages).values({
              id: uploadPayload.uploadId,
              sessionId,
              direction: 'client_to_host',
              content: uploadPayload.fileName,
              type: 'file',
              createdAt: now,
            }).onConflictDoNothing();
          }
        } catch (err) {
          logger.error({ err }, '持久化文件上传消息失败');
        }
      }
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
