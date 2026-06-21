import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { db } from '../db/client';
import { hosts, sessions, securityLogs } from '../db/schema';
import { eq, and, gt, isNull, ne, or } from 'drizzle-orm';
import { generatePinWithHash, isValidPinFormat, verifyPin } from '../utils/pin';
import { signHostToken, signClientAccessToken, signClientRefreshToken, verifyHostToken, verifyRefreshToken, verifyAccessToken, extractTokenFromHeader, extractTokenFromRequest } from '../utils/jwt';
import { notifyAndDisconnectClient } from '../ws/relay';
import { isHostOnline } from '../ws/connection-registry';
import { issueTicket } from '../ws/tickets';
import { RATE_LIMIT_CONFIG, JWT_CONFIG, WSMessageType } from '@remotebridge/shared';
import type { ApiResponse, RegisterHostRequest, GeneratePinResponse, ConnectRequest, ConnectResponse } from '@remotebridge/shared';

// ===== Cookie 工具（02a-S11）=====
const isProd = process.env.NODE_ENV === 'production';

function setCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
  const secure = isProd ? '; Secure' : '';
  reply.raw.setHeader('Set-Cookie', [
    `rb_access=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200${secure}`,
    `rb_refresh=${encodeURIComponent(refreshToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
  ]);
}

function clearCookies(reply: FastifyReply): void {
  const secure = isProd ? '; Secure' : '';
  reply.raw.setHeader('Set-Cookie', [
    `rb_access=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
    `rb_refresh=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
  ]);
}

function parseCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

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

    // 将 token 写入 httpOnly cookie（02a-S11）；body 里保留以兼容过渡期旧客户端
    setCookies(reply, accessToken, refreshToken);

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
  // 刷新 Access Token；优先从 rb_refresh cookie 读（02a-S11），兼容 body 传参（旧客户端/测试）
  fastify.post('/auth/refresh', async (request, reply) => {
    const cookieRefresh = parseCookieValue(request.headers.cookie, 'rb_refresh');
    const { refreshToken: bodyRefreshToken } = (request.body as any) || {};
    const refreshToken = cookieRefresh || bodyRefreshToken;

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

    // 签发新的 access token（并轮换 refresh token）
    const newAccessToken = signClientAccessToken(
      payload.sub,
      payload.sessionId,
      payload.hostId
    );
    const newRefreshToken = signClientRefreshToken(
      payload.sub,
      payload.sessionId,
      payload.hostId
    );

    // 更新会话
    const newExpiresAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    await db.update(sessions)
      .set({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresAt: newExpiresAt,
        lastActiveAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(sessions.id, payload.sessionId));

    // 如果请求来自 cookie 路径，更新 cookie；否则仅回 body（旧客户端兼容）
    if (cookieRefresh) {
      setCookies(reply, newAccessToken, newRefreshToken);
    }

    const response: ApiResponse<{ accessToken: string }> = {
      success: true,
      data: { accessToken: newAccessToken },
      error: null,
      timestamp: Date.now(),
    };

    return reply.send(response);
  });

  // --- GET /auth/ws-ticket ---
  // Web 客户端在建立 WebSocket 前调用，用 httpOnly cookie 换取 30 秒一次性票据（02a-S11）
  fastify.get('/auth/ws-ticket', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: RATE_LIMIT_CONFIG.WINDOW_MS,
      },
    },
  }, async (request, reply) => {
    // 接受 cookie（web 客户端）或 Authorization 头（降级 / 测试）
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
        error: { code: 'FORBIDDEN', message: '仅客户端令牌可申请 WS 票据' },
        timestamp: Date.now(),
      });
    }

    // 确认会话仍然有效
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

    const ticket = issueTicket(payload.sub, payload.sessionId, payload.hostId);

    return reply.send({
      success: true,
      data: { ticket },
      error: null,
      timestamp: Date.now(),
    });
  });

  // --- POST /auth/logout ---
  // Web 客户端主动登出时清除 httpOnly cookie（02a-S11）
  fastify.post('/auth/logout', async (_request, reply) => {
    clearCookies(reply);
    return reply.send({
      success: true,
      data: null,
      error: null,
      timestamp: Date.now(),
    });
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

  // --- POST /auth/host-token-refresh ---
  // Host 主动轮换自己的 JWT（02a-S13）。
  // 适用场景：桌面端 token-rotator.ts 检测到 token 剩余有效期 ≤ 30d 时调用。
  // 不验证主机记录是否存在（verifyHostToken 已签名校验），直接签发新 token。
  fastify.post('/auth/host-token-refresh', {
    config: {
      rateLimit: {
        max: RATE_LIMIT_CONFIG.PIN_GENERATE_MAX, // 5 次/分钟/host，复用同档限制
        timeWindow: RATE_LIMIT_CONFIG.WINDOW_MS,
        keyGenerator: (req) => {
          const tok = extractTokenFromHeader(req.headers.authorization);
          try {
            const p = verifyHostToken(tok!);
            return `host-token-refresh:${p.sub}`;
          } catch {
            return `host-token-refresh:${req.ip}`;
          }
        },
      },
    },
  }, async (request, reply) => {
    const token = extractTokenFromHeader(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'MISSING_TOKEN', message: '缺少认证令牌' },
        timestamp: Date.now(),
      });
    }

    let payload: any;
    try {
      payload = verifyHostToken(token);
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_TOKEN', message: 'Host token 无效或已过期' },
        timestamp: Date.now(),
      });
    }

    const newToken = signHostToken(payload.sub);
    // 从新 token 中读取 exp（避免重复计算 90d 偏移量）
    const decoded = jwt.decode(newToken) as { exp: number };

    return reply.send({
      success: true,
      data: { token: newToken, expiresAt: decoded.exp },
      error: null,
      timestamp: Date.now(),
    });
  });
}
