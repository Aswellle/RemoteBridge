import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/client';
import { hosts, sessions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { extractTokenFromHeader, verifyAccessToken, verifyHostToken } from '../utils/jwt';
import { isHostOnline, isClientOnline } from '../ws/connection-registry';
import type { ApiResponse, HostInfo, ClientInfo, SessionInfo } from '@remotebridge/shared';

// ===== Host 信息路由 =====
export async function hostsRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET /hosts/:hostId/status ---
  // 查询 Host 在线状态。Client 与 Host JWT 均可，但都只能查询自己关联的主机：
  // Client 凭 token 中的 hostId 声明，Host 只能查自己（sub）。
  fastify.get<{ Params: { hostId: string } }>('/hosts/:hostId/status', async (request, reply) => {
    const token = extractTokenFromHeader(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
        timestamp: Date.now(),
      });
    }

    let scopedHostId: string;
    try {
      const payload = verifyAccessToken(token);
      if (payload.type === 'client') {
        scopedHostId = payload.hostId;
      } else if (payload.type === 'host') {
        scopedHostId = payload.sub;
      } else {
        throw new Error('Invalid token type');
      }
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
        timestamp: Date.now(),
      });
    }

    const { hostId } = request.params;

    if (hostId !== scopedHostId) {
      return reply.code(403).send({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: '无权查询其他主机的状态' },
        timestamp: Date.now(),
      });
    }

    // 查询主机信息
    const host = await db.select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host.length) {
      return reply.code(404).send({
        success: false,
        data: null,
        error: { code: 'HOST_NOT_FOUND', message: '主机不存在' },
        timestamp: Date.now(),
      });
    }

    // 检查是否在线（通过 WebSocket 房间管理）
    const online = isHostOnline(hostId);

    const response: ApiResponse<HostInfo> = {
      success: true,
      data: {
        hostId: host[0].id,
        name: host[0].name,
        os: host[0].os || 'unknown',
        online,
        lastSeen: host[0].lastSeenAt || undefined,
        version: host[0].version || undefined,
      },
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });

  // --- GET /hosts/:hostId/clients ---
  // Host 查询已连接的 Client 列表（需 Host JWT）
  fastify.get<{ Params: { hostId: string } }>('/hosts/:hostId/clients', async (request, reply) => {
    // 验证 Host JWT
    const token = extractTokenFromHeader(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
        timestamp: Date.now(),
      });
    }

    let hostId: string;
    try {
      const payload = verifyHostToken(token);
      hostId = payload.sub;
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
        timestamp: Date.now(),
      });
    }

    // 验证路径参数与 token 中的 hostId 一致
    if (hostId !== request.params.hostId) {
      return reply.code(403).send({
        success: false,
        data: null,
        error: { code: 'FORBIDDEN', message: '无权访问其他主机的客户端列表' },
        timestamp: Date.now(),
      });
    }

    // 查询所有未吊销的会话
    const activeSessions = await db.select()
      .from(sessions)
      .where(
        and(
          eq(sessions.hostId, hostId),
          // revokedAt IS NULL
        )
      );

    // 获取在线状态
    const clients: ClientInfo[] = activeSessions
      .filter(s => !s.revokedAt) // 过滤已吊销的
      .map(s => ({
        clientId: s.clientId,
        sessionId: s.id, // 吊销操作需要会话 id（clientId 无法定位会话）
        label: s.clientLabel || '未知设备',
        lastSeenAt: s.lastActiveAt || s.createdAt,
        isTrusted: false, // 信任标记由桌面端本地 DB 维护，列表合并在桌面端完成
        online: isClientOnline(s.clientId),
      }));

    const response: ApiResponse<ClientInfo[]> = {
      success: true,
      data: clients,
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });
}
