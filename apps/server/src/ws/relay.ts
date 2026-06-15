import { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import { WSMessage, WSMessageType } from '@remotebridge/shared';
import {
  ConnectionMeta,
  getHostSocket,
  getClientSocket,
  getClientHost,
  getHostClients,
  forEachClient,
} from './connection-registry';
import { logger } from '../utils/logger';

// ===== 发送 WS 消息（统一序列化） =====
export function sendWSMessage(ws: WebSocket, message: Partial<WSMessage>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      id: (message as any).id || nanoid(),
      type: message.type,
      payload: message.payload || {},
      timestamp: message.timestamp || Date.now(),
      sessionId: message.sessionId,
    }));
  }
}

// ===== 中继消息到 Host =====
export function relayToHost(msg: WSMessage, hostId: string, _sessionId?: string): boolean {
  const hostWs = getHostSocket(hostId);
  if (hostWs) {
    sendWSMessage(hostWs, msg);
    return true;
  }
  return false;
}

// ===== 中继消息到 Client =====
export function relayToClient(msg: WSMessage, clientId: string, sessionId?: string): boolean {
  // 优先按 clientId 精确投递
  if (clientId) {
    const clientWs = getClientSocket(clientId);
    if (clientWs) {
      sendWSMessage(clientWs, msg);
      return true;
    }
  }

  // 回退：按 sessionId 查找对应 Client
  if (sessionId) {
    let found = false;
    forEachClient((_id, ws) => {
      const clientMeta = (ws as any).__meta as ConnectionMeta | undefined;
      if (clientMeta?.sessionId === sessionId) {
        sendWSMessage(ws, msg);
        found = true;
      }
    });
    return found;
  }

  return false;
}

// ===== 通用中继：根据发送者类型自动路由 =====
export function relayMessage(
  senderSocket: WebSocket,
  message: WSMessage,
  meta: { type: 'host' | 'client'; id: string; sessionId?: string; hostId?: string }
): void {
  if (meta.type === 'client') {
    // Client -> Host
    // 把路由信息注入 payload：Host 端 handler 只能拿到 payload（拿不到顶层字段），
    // 且必须在 RESP_* 中回显 clientId/sessionId，Relay 才能把响应路由回 Client。
    const hostId = getClientHost(meta.id);
    if (hostId) {
      const enrichedMessage = {
        ...message,
        payload: {
          ...(message.payload as object),
          clientId: meta.id,
          sessionId: meta.sessionId || message.sessionId,
          senderId: meta.id,
          senderType: meta.type,
          // 原始消息 id：两端各自持久化消息时以此做去重键
          messageId: message.id,
        },
        sessionId: meta.sessionId || message.sessionId,
        senderId: meta.id,
        senderType: meta.type,
      };
      if (relayToHost(enrichedMessage as WSMessage, hostId)) return;
    }
  } else {
    // Host -> Client
    const clientId = (message.payload as any)?.clientId;
    if (clientId) {
      const enrichedMessage = {
        ...message,
        payload: {
          ...(message.payload as object),
          senderId: meta.id,
          senderType: meta.type,
          messageId: message.id,
        },
        senderId: meta.id,
        senderType: meta.type,
      };
      if (relayToClient(enrichedMessage as WSMessage, clientId)) return;
    }
  }

  // 对方不在线
  sendWSMessage(senderSocket, {
    type: WSMessageType.ERROR,
    payload: { code: 'PEER_OFFLINE', message: '对方不在线' },
    timestamp: Date.now(),
  });
}

// ===== 通知 Host =====
export function notifyHost(hostId: string, type: WSMessageType, payload: unknown): void {
  const hostWs = getHostSocket(hostId);
  if (hostWs) {
    sendWSMessage(hostWs, {
      type,
      payload,
      timestamp: Date.now(),
    });
  }
}

// ===== 通知 Client 并断开连接（顺序保证：通知先送达，close 后发送） =====
// 先通过 sendWSMessage（同步发送，不等待 flush）发送通知，
// 再通过 setImmediate 关闭连接 —— 两个帧在同一个事件循环 tick 进入底层 TCP 缓冲，
// 内核保证顺序到达。
export function notifyAndDisconnectClient(
  clientId: string,
  type: WSMessageType,
  payload: unknown,
  code: number = 4003,
  reason: string = 'Session revoked',
): boolean {
  const clientWs = getClientSocket(clientId);
  if (!clientWs) { logger.error({ clientId }, 'notifyAndDisconnectClient: client not in rooms'); return false; }
  if (clientWs.readyState !== WebSocket.OPEN) { logger.error({ clientId, readyState: clientWs.readyState }, 'notifyAndDisconnectClient: client socket not open'); return false; }

  sendWSMessage(clientWs, { type, payload, timestamp: Date.now() });
  logger.debug({ clientId, type }, 'notifyAndDisconnectClient: sent message to client, scheduling close');

  setImmediate(() => {
    try {
      clientWs.close(code, reason);
      logger.debug({ clientId, code }, 'notifyAndDisconnectClient: close sent to client');
    } catch (err) {
      logger.error({ err, clientId }, 'notifyAndDisconnectClient: close failed');
    }
  });

  return true;
}

// ===== 广播消息给 Host 的所有 Client =====
export function broadcastToHostClients(hostId: string, message: Partial<WSMessage>): void {
  getHostClients(hostId).forEach((clientId) => {
    const clientWs = getClientSocket(clientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      sendWSMessage(clientWs, message);
    }
  });
}

// ===== 发送消息给特定 Client =====
export function sendToClient(clientId: string, message: Partial<WSMessage>): boolean {
  const clientWs = getClientSocket(clientId);
  if (clientWs && clientWs.readyState === WebSocket.OPEN) {
    sendWSMessage(clientWs, message);
    return true;
  }
  return false;
}

// ===== 发送消息给特定 Host =====
export function sendToHost(hostId: string, message: Partial<WSMessage>): boolean {
  const hostWs = getHostSocket(hostId);
  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    sendWSMessage(hostWs, message);
    return true;
  }
  return false;
}
