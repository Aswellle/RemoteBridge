import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db/client';
import { hosts, sessions, securityLogs } from '../db/schema';
import { eq, and, gt, isNull, ne, or } from 'drizzle-orm';
import { generatePinWithHash, isValidPinFormat, verifyPin } from '../utils/pin';
import { signHostToken, signClientAccessToken, signClientRefreshToken, verifyHostToken, verifyRefreshToken, extractTokenFromHeader } from '../utils/jwt';
import { notifyAndDisconnectClient } from '../ws/relay';
import { isHostOnline } from '../ws/connection-registry';
import { RATE_LIMIT_CONFIG, JWT_CONFIG, WSMessageType } from '@remotebridge/shared';
import type { ApiResponse, RegisterHostRequest, GeneratePinResponse, ConnectRequest, ConnectResponse } from '@remotebridge/shared';

// ===== PIN 缺省有效期（秒） =====
const PIN_DEFAULT_EXPIRES_IN = 300;

// ===== /auth/generate-pin 限流键：按 Host 而非 IP 计数 =====
// Token 无效/缺失时退回按 IP 计数（请求会在 handler 内被拒绝为 401，不消耗 PIN 生成额度的语义）
function pinGenerateRateLimitKey(req: FastifyRequest): string {
  const token = extractTokenFromHeader(req.headers.authorization);
  if (token) {
    try {
      const payload = verifyHostToken(token);
      return `pin:host:${payload.sub}`;
    } catch {
      // 无效令牌交由 handler 返回 401
    }
  }
  return `pin:ip:${req.ip}`;
}

// ===== 认证路由 =====
export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // --- POST /auth/register-host ---
  // PC 端首次注册，获得 hostId 和 secret
  // 未认证端点：按 IP 限流，避免无限创建主机行造成 DB 增长 DoS（P1-9）
  fastify.post<{ Body: RegisterHostRequest }>('/auth/register-host', {
    config: {
      rateLimit: {
        max: RATE_LIMIT_CONFIG.REGISTER_HOST_MAX,
        timeWindow: RATE_LIMIT_CONFIG.WINDOW_MS,
      },
    },
  }, async (request, reply) => {
    const { name, os, version } = request.body;

    // 参数校验
    if (!name || typeof name !== 'string' || name.length < 1 || name.length > 100) {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: 'INVALID_NAME', message: '主机名长度必须在 1-100 之间' },
        timestamp: Date.now(),
      });
    }

    const hostId = nanoid();
    const secret = nanoid(64);

    // 创建主机记录（pin_hash 暂时为空，后续生成 PIN 时填充）
    await db.insert(hosts).values({
      id: hostId,
      name,
      os: os || null,
      version: version || null,
      pinHash: '',
      createdAt: Math.floor(Date.now() / 1000),
    });

    // 签发 Host JWT
    const hostToken = signHostToken(hostId);

    const response: ApiResponse<{ hostId: string; secret: string; token: string }> = {
      success: true,
      data: { hostId, secret, token: hostToken },
      error: null,
      timestamp: Date.now(),
    };

    return reply.code(201).send(response);
  });

  // --- POST /auth/generate-pin ---
  // Host 请求生成一次性连接 PIN 码
  fastify.post('/auth/generate-pin', {
    config: {
      rateLimit: {
        max: RATE_LIMIT_CONFIG.PIN_GENERATE_MAX,
        timeWindow: RATE_LIMIT_CONFIG.WINDOW_MS,
        keyGenerator: pinGenerateRateLimitKey,
      },
    },
  }, async (request, reply) => {
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

    // 解析过期时间（缺省 5 分钟；PIN 是一次性入口凭证，不允许永不过期）
    const { expiresIn } = (request.body as any) || {};
    const effectiveExpiresIn =
      typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : PIN_DEFAULT_EXPIRES_IN;
    const pinExpiresAt = Math.floor(Date.now() / 1000) + effectiveExpiresIn;

    // 生成 PIN
    const { pin, hash } = await generatePinWithHash(8);

    // 更新主机记录
    await db.update(hosts)
      .set({
        pinHash: hash,
        pinExpiresAt,
      })
      .where(eq(hosts.id, hostId));

    const response: ApiResponse<GeneratePinResponse> = {
      success: true,
      data: {
        pin,
        expiresAt: pinExpiresAt,
      },
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });

  // --- POST /auth/connect ---
  // Web Client 使用 PIN 码连接 Host
  fastify.post<{ Body: ConnectRequest }>('/auth/connect', {
    config: {
      rateLimit: {
        max: RATE_LIMIT_CONFIG.AUTH_MAX,
        timeWindow: RATE_LIMIT_CONFIG.WINDOW_MS,
      },
    },
  }, async (request, reply) => {
    const { pin, clientId, clientLabel } = request.body;
    const ip = request.ip || 'unknown';

    // 参数校验
    if (!pin || !isValidPinFormat(pin)) {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: 'INVALID_PIN_FORMAT', message: 'PIN 码格式无效（需要 8 位字母数字）' },
        timestamp: Date.now(),
      });
    }

    if (!clientId) {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: 'MISSING_CLIENT_ID', message: '缺少客户端 ID' },
        timestamp: Date.now(),
      });
    }

    // 查找所有可能匹配的主机（PIN 未过期且未被封禁）
    // 在 SQL 层过滤掉无 PIN/已过期的主机，避免对全表逐行做 bcrypt 比较
    const now = Math.floor(Date.now() / 1000);
    const potentialHosts = await db.select()
      .from(hosts)
      .where(
        and(
          eq(hosts.isBanned, 0),
          ne(hosts.pinHash, ''),
          or(isNull(hosts.pinExpiresAt), gt(hosts.pinExpiresAt, now)),
        )
      );

    // 逐个验证 PIN 哈希
    let matchedHost: typeof hosts.$inferSelect | null = null;
    for (const host of potentialHosts) {
      if (!host.pinHash) continue;
      if (host.pinExpiresAt && host.pinExpiresAt < now) continue;

      const isValid = await verifyPin(pin, host.pinHash);
      if (isValid) {
        matchedHost = host;
        break;
      }
    }

    if (!matchedHost) {
      // 记录认证失败
      await db.insert(securityLogs).values({
        id: nanoid(),
        clientId,
        eventType: 'AUTH_FAIL',
        detail: JSON.stringify({ pin: pin.slice(0, 4) + '****' }),
        ipAddress: ip,
        createdAt: now,
      });

      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_PIN', message: 'PIN 码无效或已过期' },
        timestamp: Date.now(),
      });
    }

    // PIN 验证成功，创建会话
    const sessionId = nanoid();
    const accessToken = signClientAccessToken(clientId, sessionId, matchedHost.id);
    const refreshToken = signClientRefreshToken(clientId, sessionId, matchedHost.id);
    const expiresAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60; // 2 小时

    await db.insert(sessions).values({
      id: sessionId,
      hostId: matchedHost.id,
      clientId,
      clientLabel: clientLabel || null,
      accessToken,
      refreshToken,
      expiresAt,
      createdAt: now,
    });

    // 清除 PIN（一次性使用）
    await db.update(hosts)
      .set({ pinHash: '', pinExpiresAt: null })
      .where(eq(hosts.id, matchedHost.id));

    // 记录会话创建
    await db.insert(securityLogs).values({
      id: nanoid(),
      hostId: matchedHost.id,
      clientId,
      eventType: 'SESSION_CREATED',
      detail: JSON.stringify({ sessionId }),
      ipAddress: ip,
      createdAt: now,
    });

    const response: ApiResponse<ConnectResponse> = {
      success: true,
      data: {
        sessionId,
        accessToken,
        refreshToken,
        hostInfo: {
          hostId: matchedHost.id,
          name: matchedHost.name,
          os: matchedHost.os || 'unknown',
          online: isHostOnline(matchedHost.id),
        },
      },
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });

  // --- POST /auth/refresh ---
  // 刷新 Access Token
  fastify.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = (request.body as any) || {};

    if (!refreshToken) {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: 'MISSING_REFRESH_TOKEN', message: '缺少刷新令牌' },
        timestamp: Date.now(),
      });
    }

    // 验证 refresh token（独立密钥 + use:'refresh' 标记，access token 不可用于刷新）
    let payload: any;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_REFRESH_TOKEN', message: '刷新令牌无效或已过期' },
        timestamp: Date.now(),
      });
    }

    // 检查会话是否被吊销
    const session = await db.select()
      .from(sessions)
      .where(eq(sessions.id, payload.sessionId))
      .limit(1);

    if (!session.length || session[0].revokedAt) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'SESSION_REVOKED', message: '会话已被吊销' },
        timestamp: Date.now(),
      });
    }

    // 签发新的 access token
    const newAccessToken = signClientAccessToken(
      payload.sub,
      payload.sessionId,
      payload.hostId
    );

    // 更新会话
    const newExpiresAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    await db.update(sessions)
      .set({
        accessToken: newAccessToken,
        expiresAt: newExpiresAt,
        lastActiveAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(sessions.id, payload.sessionId));

    const response: ApiResponse<{ accessToken: string }> = {
      success: true,
      data: { accessToken: newAccessToken },
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });

  // --- DELETE /auth/revoke/:sessionId ---
  // Host 吊销某个 Client 会话
  fastify.delete<{ Params: { sessionId: string } }>('/auth/revoke/:sessionId', async (request, reply) => {
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

    const { sessionId } = request.params;

    // 查找会话
    const session = await db.select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.hostId, hostId),
        )
      )
      .limit(1);

    if (!session.length) {
      return reply.code(404).send({
        success: false,
        data: null,
        error: { code: 'SESSION_NOT_FOUND', message: '会话不存在' },
        timestamp: Date.now(),
      });
    }

    // 吊销会话
    const now = Math.floor(Date.now() / 1000);
    await db.update(sessions)
      .set({ revokedAt: now })
      .where(eq(sessions.id, sessionId));

    // 记录安全日志
    await db.insert(securityLogs).values({
      id: nanoid(),
      hostId,
      clientId: session[0].clientId,
      eventType: 'REVOKE',
      detail: JSON.stringify({ sessionId, revokedBy: 'host' }),
      createdAt: now,
    });

    // 通知 Client 会话已吊销并主动断开其 WS 连接
    // （JWT 在 2h 内仍然有效，必须把已建立的连接立刻踢掉才能让吊销即时生效）
    try {
      const notified = notifyAndDisconnectClient(
        session[0].clientId,
        WSMessageType.SESSION_REVOKED,
        { sessionId, reason: 'revoked_by_host', timestamp: Date.now() },
        4003,
        'Session revoked',
      );
      if (!notified) {
        request.log.warn({ clientId: session[0].clientId, sessionId }, 'revoke: client not connected, WS notify/disconnect skipped');
      }
    } catch {
      // 通知失败不影响吊销本身（数据库状态已更新）
    }

    const response: ApiResponse<null> = {
      success: true,
      data: null,
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });
}
