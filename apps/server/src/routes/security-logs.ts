/**
 * 安全审计日志 API 路由
 * 提供安全事件日志的查询和筛选接口
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db/client';
import { securityLogs } from '../db/schema';
import { eq, and, or, desc, like, gte, lte, count, sql } from 'drizzle-orm';
import { verifyAccessToken, verifyHostToken, extractTokenFromHeader } from '../utils/jwt';
import type { ApiResponse, SecurityLog, AccessLog } from '@remotebridge/shared';

// ===== POST /security-logs 合法事件类型 =====
// 与 packages/shared 的 SecurityLog.eventType 联合类型保持一致；
// 严格校验可防止伪造 Host token 注入任意 eventType 绕过安全日志筛选 (P1-8)。
const VALID_EVENT_TYPES: ReadonlyArray<SecurityLog['eventType']> = [
  'AUTH_FAIL',
  'BLOCKED_PATH',
  'REVOKE',
  'PIN_EXPIRED',
  'SESSION_CREATED',
  'ACCESS_DOWNLOAD',
  'ACCESS_PREVIEW',
  'ACCESS',
];

// ===== POST /security-logs 请求体 =====
// audit-logger.ts 的 logAccess()（{eventType:'ACCESS', clientId, action, path, status}）
// 和 logSecurity()（{eventType, clientId, detail, ipAddress}）两种形态都需兼容。
interface CreateSecurityLogBody {
  eventType?: string;
  clientId?: string;
  detail?: string;
  ipAddress?: string;
  action?: string;
  path?: string;
  status?: string;
}

// ===== 鉴权：解析查询作用域 =====
// Host 与 Client token 均可查询安全日志，但都只能看自己关联主机的数据：
// host → 自己（sub）；client → token 中绑定的 hostId。
// 用 verifyAccessToken（拒绝 refresh token），与其他路由一致。
function resolveScopedHostId(token: string): string {
  const payload = verifyAccessToken(token);
  if (payload.type === 'host') return payload.sub;
  if (payload.type === 'client' && payload.hostId) return payload.hostId;
  throw new Error('Invalid token type');
}

// ===== 查询参数接口 =====
interface SecurityLogsQuery {
  page?: number;
  pageSize?: number;
  eventType?: string;
  clientId?: string;
  startDate?: number;
  endDate?: number;
}

// ===== 安全日志条目接口 =====
interface SecurityLogEntry {
  id: string;
  hostId: string | null;
  clientId: string | null;
  eventType: string;
  detail: string | null;
  ipAddress: string | null;
  createdAt: number;
}

// ===== 安全审计日志路由 =====
export async function securityLogsRoutes(fastify: FastifyInstance): Promise<void> {
  // --- GET /security-logs ---
  // 查询安全审计日志（需要 Host JWT 认证）
  fastify.get<{ Querystring: SecurityLogsQuery }>(
    '/security-logs',
    async (request: FastifyRequest<{ Querystring: SecurityLogsQuery }>, reply: FastifyReply) => {
      try {
        // 1. 验证 Host JWT
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.code(401).send({
            success: false,
            data: null,
            error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
            timestamp: Date.now(),
          } as ApiResponse<null>);
        }

        let hostId: string;
        try {
          hostId = resolveScopedHostId(token);
        } catch {
          return reply.code(401).send({
            success: false,
            data: null,
            error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
            timestamp: Date.now(),
          } as ApiResponse<null>);
        }

        // 2. 解析分页参数（默认每页 20 条）
        const { page = 1, pageSize = 20, eventType, clientId, startDate, endDate } = request.query;
        const safePage = Math.max(1, page);
        const safePageSize = Math.min(Math.max(1, pageSize), 100);
        const offset = (safePage - 1) * safePageSize;

        // 3. 构建查询条件
        const conditions = [eq(securityLogs.hostId, hostId)];

        if (eventType) {
          conditions.push(eq(securityLogs.eventType, eventType as any));
        }
        if (clientId) {
          conditions.push(eq(securityLogs.clientId, clientId));
        }
        if (startDate) {
          conditions.push(gte(securityLogs.createdAt, startDate));
        }
        if (endDate) {
          conditions.push(lte(securityLogs.createdAt, endDate));
        }

        const whereClause = and(...conditions);

        // 4. 查询总数
        const totalResult = await db
          .select({ total: count() })
          .from(securityLogs)
          .where(whereClause);

        const total = totalResult[0]?.total ?? 0;

        // 5. 查询分页数据
        const logs = await db
          .select()
          .from(securityLogs)
          .where(whereClause)
          .orderBy(desc(securityLogs.createdAt))
          .limit(safePageSize)
          .offset(offset);

        // 6. 返回结果
        const response: ApiResponse<{
          logs: SecurityLogEntry[];
          total: number;
          page: number;
          pageSize: number;
          totalPages: number;
        }> = {
          success: true,
          data: {
            logs: logs.map(log => ({
              id: log.id,
              hostId: log.hostId,
              clientId: log.clientId,
              eventType: log.eventType,
              detail: log.detail,
              ipAddress: log.ipAddress,
              createdAt: log.createdAt,
            })),
            total,
            page: safePage,
            pageSize: safePageSize,
            totalPages: Math.ceil(total / safePageSize),
          },
          error: null,
          timestamp: Date.now(),
        };

        return reply.send(response);
      } catch (err) {
        fastify.log.error('查询安全日志失败:', err as any);
        return reply.code(500).send({
          success: false,
          data: null,
          error: { code: 'INTERNAL_ERROR', message: '查询安全日志失败' },
          timestamp: Date.now(),
        } as ApiResponse<null>);
      }
    },
  );

  // --- POST /security-logs ---
  // Host 上报安全/访问事件（仅限 Host JWT）。
  // apps/desktop 的 audit-logger.ts 在每次文件访问和安全事件后调用此接口。
  fastify.post<{ Body: CreateSecurityLogBody }>('/security-logs', async (request, reply) => {
    const token = extractTokenFromHeader(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
        timestamp: Date.now(),
      } as ApiResponse<null>);
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
      } as ApiResponse<null>);
    }

    const { eventType, clientId, detail, ipAddress, action, path, status } = request.body || {};

    if (!eventType || !VALID_EVENT_TYPES.includes(eventType as SecurityLog['eventType'])) {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: 'INVALID_EVENT_TYPE', message: '无效的事件类型' },
        timestamp: Date.now(),
      } as ApiResponse<null>);
    }

    // logAccess() 发送 action/path/status，而 security_logs 表只有 detail 列，统一编码为 JSON
    const finalDetail = detail ?? (action || path || status ? JSON.stringify({ action, path, status }) : null);

    try {
      await db.insert(securityLogs).values({
        id: nanoid(),
        hostId,
        clientId: clientId || null,
        eventType: eventType as SecurityLog['eventType'],
        detail: finalDetail,
        ipAddress: ipAddress || null,
        createdAt: Math.floor(Date.now() / 1000),
      });

      return reply.code(201).send({
        success: true,
        data: null,
        error: null,
        timestamp: Date.now(),
      } as ApiResponse<null>);
    } catch (err) {
      fastify.log.error('写入安全日志失败:', err as any);
      return reply.code(500).send({
        success: false,
        data: null,
        error: { code: 'INTERNAL_ERROR', message: '写入安全日志失败' },
        timestamp: Date.now(),
      } as ApiResponse<null>);
    }
  });

  // --- GET /security-logs/events ---
  // 获取所有事件类型列表（用于筛选下拉）
  fastify.get('/security-logs/events', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // 验证 Host JWT
      const token = extractTokenFromHeader(request.headers.authorization);
      if (!token) {
        return reply.code(401).send({
          success: false,
          data: null,
          error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
          timestamp: Date.now(),
        } as ApiResponse<null>);
      }

      let hostId: string;
      try {
        hostId = resolveScopedHostId(token);
      } catch {
        return reply.code(401).send({
          success: false,
          data: null,
          error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
          timestamp: Date.now(),
        } as ApiResponse<null>);
      }

      // 查询该 host 下所有事件类型
      const result = await db
        .selectDistinct({ eventType: securityLogs.eventType })
        .from(securityLogs)
        .where(eq(securityLogs.hostId, hostId));

      return reply.send({
        success: true,
        data: result.map(r => r.eventType),
        error: null,
        timestamp: Date.now(),
      } as ApiResponse<string[]>);
    } catch (err) {
      fastify.log.error('查询事件类型失败:', err as any);
      return reply.code(500).send({
        success: false,
        data: null,
        error: { code: 'INTERNAL_ERROR', message: '查询事件类型失败' },
        timestamp: Date.now(),
      } as ApiResponse<null>);
    }
  });

  // --- GET /access-logs ---
  // 查询访问日志（从 BLOCKED_PATH 安全事件中提取），仅限 Host JWT
  fastify.get<{
    Querystring: { page?: string; limit?: string };
  }>('/access-logs', async (request, reply) => {
    const token = extractTokenFromHeader(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
        timestamp: Date.now(),
      } as ApiResponse<null>);
    }

    let hostId: string;
    try {
      hostId = resolveScopedHostId(token);
    } catch {
      return reply.code(401).send({
        success: false,
        data: null,
        error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
        timestamp: Date.now(),
      } as ApiResponse<null>);
    }

    const page = parseInt(request.query.page || '1', 10);
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);

    try {
      // 查询 ACCESS（Host 上报的访问事件）及历史遗留 BLOCKED_PATH 类型的安全日志作为访问日志
      const result = await db
        .select()
        .from(securityLogs)
        .where(
          and(
            eq(securityLogs.hostId, hostId),
            or(eq(securityLogs.eventType, 'ACCESS'), eq(securityLogs.eventType, 'BLOCKED_PATH'))
          )
        )
        .orderBy(desc(securityLogs.createdAt))
        .limit(limit)
        .offset((page - 1) * limit);

      const logs = result.map((r) => {
        let action: AccessLog['action'] = 'LIST_DIR';
        let status: AccessLog['status'] = 'BLOCKED';
        let filePath: string | undefined = r.detail || undefined;

        if (r.eventType === 'ACCESS' && r.detail) {
          try {
            const parsed = JSON.parse(r.detail);
            if (parsed.action) action = parsed.action;
            if (parsed.status) status = parsed.status;
            filePath = parsed.path;
          } catch {
            // detail 非 JSON，保留默认值
          }
        }

        return {
          id: r.id,
          clientId: r.clientId || '',
          action,
          path: filePath,
          status,
          createdAt: r.createdAt,
        };
      });

      return reply.send({
        success: true,
        data: logs,
        error: null,
        timestamp: Date.now(),
      } as ApiResponse<typeof logs>);
    } catch (err) {
      fastify.log.error('查询访问日志失败:', err as any);
      return reply.code(500).send({
        success: false,
        data: null,
        error: { code: 'INTERNAL_ERROR', message: '查询访问日志失败' },
        timestamp: Date.now(),
      } as ApiResponse<null>);
    }
  });
}
