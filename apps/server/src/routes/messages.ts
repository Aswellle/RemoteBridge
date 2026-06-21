import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db/client';
import { messages, sessions } from '../db/schema';
import { eq, and, desc, gt, isNull, inArray } from 'drizzle-orm';
import { extractTokenFromRequest, verifyAccessToken } from '../utils/jwt';
import { sendToClient, sendToHost } from '../ws/relay';
import { WSMessageType } from '@remotebridge/shared';
import type { ApiResponse, Message } from '@remotebridge/shared';

// ===== 消息路由 =====
export async function messagesRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET /messages/:sessionId ---
  // 拉取消息历史（分页）
  fastify.get<{
    Params: { sessionId: string };
    Querystring: { page?: string; limit?: string; since?: string };
  }>('/messages/:sessionId', async (request, reply) => {
    // 验证 JWT
    const token = extractTokenFromRequest(request.headers);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
        timestamp: Date.now(),
      });
    }

    let payload: any;
    try {
      payload = verifyAccessToken(token);
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
        timestamp: Date.now(),
      });
    }

    const { sessionId } = request.params;
    const page = parseInt(request.query.page || '1', 10);
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
    const since = request.query.since ? parseInt(request.query.since, 10) : undefined;

    // 验证会话归属
    const session = await db.select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!session.length) {
      return reply.code(404).send({
        success: false,
        data: null,
        error: { code: 'SESSION_NOT_FOUND', message: '会话不存在' },
        timestamp: Date.now(),
      });
    }

    // 验证会话未被吊销
    if (session[0].revokedAt) {
      return reply.code(403).send({
        success: false,
        data: null,
        error: { code: 'SESSION_REVOKED', message: '会话已被吊销' },
        timestamp: Date.now(),
      });
    }

    // 验证权限（只能查看自己的会话）
    const isHost = payload.type === 'host' && payload.sub === session[0].hostId;
    const isClient = payload.type === 'client' && payload.sub === session[0].clientId;

    if (!isHost && !isClient) {
      return reply.code(403).send({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: '无权访问此会话的消息' },
        timestamp: Date.now(),
      });
    }

    // 查询消息
    let query = db.select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    if (since) {
      query = db.select()
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            gt(messages.createdAt, since)
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .offset((page - 1) * limit);
    }

    const result = await query;

    const response: ApiResponse<Message[]> = {
      success: true,
      data: result.map(m => ({
        id: m.id,
        sessionId: m.sessionId,
        direction: m.direction as 'host_to_client' | 'client_to_host',
        content: m.content,
        type: m.type as 'text' | 'system' | 'notification',
        createdAt: m.createdAt,
        readAt: m.readAt || undefined,
      })),
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });

  // --- GET /messages/client/history ---
  // 客户端拉取跨会话完整消息历史（用当前 JWT 中的 clientId + hostId 聚合所有未吊销会话）
  fastify.get<{
    Querystring: { page?: string; limit?: string };
  }>('/messages/client/history', async (request, reply) => {
    const token = extractTokenFromRequest(request.headers);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
        timestamp: Date.now(),
      });
    }

    let payload: any;
    try {
      payload = verifyAccessToken(token);
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
        timestamp: Date.now(),
      });
    }

    if (payload.type !== 'client') {
      return reply.code(403).send({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: '仅客户端令牌可访问此接口' },
        timestamp: Date.now(),
      });
    }

    const clientId: string = payload.sub;
    const hostId: string = payload.hostId;
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);

    // 找出该 client↔host 对的所有未吊销会话
    const clientSessions = await db.select({ id: sessions.id })
      .from(sessions)
      .where(and(
        eq(sessions.clientId, clientId),
        eq(sessions.hostId, hostId),
        isNull(sessions.revokedAt)
      ));

    if (clientSessions.length === 0) {
      return reply.send({
        success: true,
        data: [],
        error: null,
        timestamp: Date.now(),
      });
    }

    const sessionIds = clientSessions.map(s => s.id);

    const result = await db.select()
      .from(messages)
      .where(inArray(messages.sessionId, sessionIds))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const response: ApiResponse<Message[]> = {
      success: true,
      data: result.map(m => ({
        id: m.id,
        sessionId: m.sessionId,
        direction: m.direction as 'host_to_client' | 'client_to_host',
        content: m.content,
        type: m.type as 'text' | 'system' | 'notification',
        createdAt: m.createdAt,
        readAt: m.readAt || undefined,
      })),
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });

  // --- POST /messages/:sessionId ---
  // 通过 REST 发送消息（降级备用，优先走 WebSocket）
  fastify.post<{
    Params: { sessionId: string };
    Body: { content: string; type?: string };
  }>('/messages/:sessionId', async (request, reply) => {
    // 验证 JWT
    const token = extractTokenFromRequest(request.headers);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
        timestamp: Date.now(),
      });
    }

    let payload: any;
    try {
      payload = verifyAccessToken(token);
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
        timestamp: Date.now(),
      });
    }

    const { sessionId } = request.params;
    const { content, type = 'text' } = request.body;

    if (!content || content.trim().length === 0) {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: 'EMPTY_CONTENT', message: '消息内容不能为空' },
        timestamp: Date.now(),
      });
    }

    // 验证会话归属
    const session = await db.select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!session.length) {
      return reply.code(404).send({
        success: false,
        data: null,
        error: { code: 'SESSION_NOT_FOUND', message: '会话不存在' },
        timestamp: Date.now(),
      });
    }

    // 验证会话未被吊销
    if (session[0].revokedAt) {
      return reply.code(403).send({
        success: false,
        data: null,
        error: { code: 'SESSION_REVOKED', message: '会话已被吊销' },
        timestamp: Date.now(),
      });
    }

    // 验证权限
    const isHost = payload.type === 'host' && payload.sub === session[0].hostId;
    const isClient = payload.type === 'client' && payload.sub === session[0].clientId;

    if (!isHost && !isClient) {
      return reply.code(403).send({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: '无权在此会话中发送消息' },
        timestamp: Date.now(),
      });
    }

    // 创建消息记录
    const now = Math.floor(Date.now() / 1000);
    const messageId = nanoid();
    const direction = isHost ? 'host_to_client' : 'client_to_host';

    await db.insert(messages).values({
      id: messageId,
      sessionId,
      direction,
      content: content.trim(),
      type: type as 'text' | 'system' | 'notification',
      createdAt: now,
    });

    // 通过 WebSocket 实时推送
    // id/payload.messageId 必须与上面写入 messages 表的 messageId 一致 ——
    // 两端据此做去重主键（见 RelayRoutingFields 路由字段约定），否则会与正常
    // WS 中继路径产生不同的去重键，导致桌面端/Web 端重复持久化同一条消息。
    const senderType = isHost ? 'host' : 'client';
    if (isHost) {
      sendToClient(session[0].clientId, {
        id: messageId,
        type: WSMessageType.MSG_TEXT,
        payload: {
          content: content.trim(),
          senderId: payload.sub,
          senderType,
          clientId: session[0].clientId,
          sessionId,
          messageId,
        },
        timestamp: Date.now(),
        sessionId,
      });
    } else {
      sendToHost(session[0].hostId, {
        id: messageId,
        type: WSMessageType.MSG_TEXT,
        payload: {
          content: content.trim(),
          senderId: payload.sub,
          senderType,
          clientId: payload.sub,
          sessionId,
          messageId,
        },
        timestamp: Date.now(),
        sessionId,
      });
    }

    const response: ApiResponse<Message> = {
      success: true,
      data: {
        id: messageId,
        sessionId,
        direction,
        content: content.trim(),
        type: type as 'text' | 'system' | 'notification',
        createdAt: now,
      },
      error: null,
      timestamp: Date.now(),
    };

    return reply.code(201).send(response);
  });
}
