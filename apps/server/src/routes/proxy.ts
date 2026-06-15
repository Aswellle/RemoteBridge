import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';
import { verifyAccessToken, extractTokenFromHeader, ClientTokenPayload } from '../utils/jwt';
import { db } from '../db/client';
import { sessions, securityLogs } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { sendWSMessage } from '../ws/relay';
import { getHostSocket } from '../ws/connection-registry';
import { waitForHostResponse } from '../ws/pending-requests';
import { beginFileTransfer, endFileTransfer } from '../ws/file-tunnel';
import { WSMessageType } from '@remotebridge/shared';
import type { RespFileChunkPayload } from '@remotebridge/shared';
import { nanoid } from 'nanoid';
// reply.hijack() 之后 @fastify/cors 的钩子不再执行，流式响应必须手动补 CORS 头，
// 否则浏览器拦截代理下载/预览（curl/Node 不校验 CORS，API 级测试无感）
import { corsHeadersFor } from '../utils/cors';

// ===== Range 头解析（仅支持 bytes=start-end? 形式，与 Host 文件服务器一致） =====
function parseRange(rangeHeader: string | undefined): { start: number; end?: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : undefined;
  if (end != null && end < start) return null;
  return { start, end };
}

// ===== 经 WS 隧道从 Host 拉取文件并流式写入 HTTP 响应 =====
// Host 的文件服务器只监听 127.0.0.1，Relay 跨 NAT 无法 HTTP 直连——
// 文件内容借道 Host 的出站 WS 连接以 RESP_FILE_CHUNK 分块回传。
// hostUrl 是 RESP_*_READY 返回的令牌 URL，这里只取其中的单次令牌。
//
// 调用本函数后响应即被接管（hijack）：成功、失败都由这里收尾，
// 调用方不得再操作 reply。仅在发送 CMD 之前的参数错误会以异常抛回。
function tunnelFromHost(
  hostWs: WebSocket,
  hostUrl: string,
  rangeHeader: string | undefined,
  origin: string | undefined,
  reply: FastifyReply,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const token = new URL(hostUrl).searchParams.get('token');
  if (!token) {
    throw new Error('Host 返回的下载地址缺少令牌');
  }

  const range = parseRange(rangeHeader);
  const corsHdrs = corsHeadersFor(origin);
  const transferId = nanoid();

  reply.hijack();
  const raw = reply.raw;

  return new Promise((resolve) => {
    let headersSent = false;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      endFileTransfer(transferId);
      resolve();
    };

    // 浏览器中断下载时停止接收（残余分块由注册表静默丢弃；
    // Host 侧最多多读若干分块后因 WS 缓冲水位自然停止）
    raw.on('close', finish);

    beginFileTransfer(transferId, {
      onChunk: (chunk: RespFileChunkPayload) => {
        if (finished) return;

        if (!headersSent) {
          headersSent = true;
          const isPartial = range != null;
          // 文件元信息按协议约定只在首帧（seq === 0）携带
          const totalSize = chunk.totalSize ?? 0;
          const rangeStart = chunk.rangeStart ?? 0;
          const rangeEnd = chunk.rangeEnd ?? 0;
          const contentLength = rangeEnd - rangeStart + 1;
          const headers: Record<string, string | number> = {
            'Content-Type': extraHeaders['Content-Type'] || chunk.contentType || 'application/octet-stream',
            'Content-Length': totalSize === 0 ? 0 : contentLength,
            'Accept-Ranges': 'bytes',
            ...corsHdrs,
            ...extraHeaders,
          };
          if (isPartial) {
            headers['Content-Range'] = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
          }
          raw.writeHead(isPartial ? 206 : 200, headers);
        }

        if (chunk.data) {
          // 浏览器侧背压无法回传给 Host（帧已在途），Node 会缓冲未写出的数据；
          // Host 端 4MB 发送水位间接限制了在途数据量
          raw.write(Buffer.from(chunk.data, 'base64'));
        }
        if (chunk.eof) {
          raw.end();
          finish();
        }
      },
      onError: (err: Error) => {
        if (finished) return;
        if (!headersSent) {
          console.error(`文件隧道传输失败: ${err.message}`);
          raw.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', ...corsHdrs });
          raw.end(JSON.stringify({
            success: false,
            data: null,
            error: { code: 'TUNNEL_ERROR', message: '文件隧道传输失败' },
            timestamp: Date.now(),
          }));
        } else {
          // 响应头已发出，只能掐断连接让客户端感知失败
          raw.destroy(err);
        }
        finish();
      },
    });

    sendWSMessage(hostWs, {
      type: WSMessageType.CMD_FETCH_FILE,
      payload: {
        transferId,
        token,
        rangeStart: range?.start,
        rangeEnd: range?.end,
      },
      timestamp: Date.now(),
    });
  });
}

// ===== 验证 Client JWT =====
function authenticateClient(request: FastifyRequest, reply: FastifyReply): ClientTokenPayload | null {
  const token = extractTokenFromHeader(request.headers.authorization);
  if (!token) {
    reply.code(401).send({
      success: false,
      data: null,
      error: { code: 'UNAUTHORIZED', message: '缺少认证令牌' },
      timestamp: Date.now(),
    });
    return null;
  }

  try {
    const payload = verifyAccessToken(token);
    if (payload.type !== 'client') {
      throw new Error('Invalid token type');
    }
    return payload as ClientTokenPayload;
  } catch {
    reply.code(401).send({
      success: false,
      data: null,
      error: { code: 'INVALID_TOKEN', message: '认证令牌无效或已过期' },
      timestamp: Date.now(),
    });
    return null;
  }
}

// ===== 验证会话 =====
async function validateSession(sessionId: string, reply: FastifyReply): Promise<boolean> {
  const session = await db.select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .limit(1);

  if (!session.length) {
    reply.code(404).send({
      success: false,
      data: null,
      error: { code: 'SESSION_NOT_FOUND', message: '会话不存在或已被吊销' },
      timestamp: Date.now(),
    });
    return false;
  }

  return true;
}

// ===== 代理路由 =====
export async function proxyRoutes(fastify: FastifyInstance): Promise<void> {

  // --- GET /proxy/download/:sessionId ---
  fastify.get<{ Params: { sessionId: string }; Querystring: { filePath: string } }>(
    '/proxy/download/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const { filePath } = request.query;

      // 1. 验证 Client JWT
      const payload = authenticateClient(request, reply);
      if (!payload) return;

      // 2. 验证 filePath
      if (!filePath) {
        return reply.code(400).send({
          success: false,
          data: null,
          error: { code: 'MISSING_FILE_PATH', message: '缺少 filePath 参数' },
          timestamp: Date.now(),
        });
      }

      // 3. 验证会话
      if (!(await validateSession(sessionId, reply))) return;

      // 4. 查找 Host WebSocket
      const session = await db.select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      const hostId = session[0].hostId;
      const hostWs = getHostSocket(hostId);

      if (!hostWs) {
        return reply.code(502).send({
          success: false,
          data: null,
          error: { code: 'HOST_OFFLINE', message: '目标主机不在线' },
          timestamp: Date.now(),
        });
      }

      // 5. 注册等待（必须先于发送，避免响应先到）→ 向 Host 发送 CMD_REQUEST_DOWNLOAD
      const requestId = nanoid();
      const respPromise = waitForHostResponse(
        requestId,
        WSMessageType.RESP_DOWNLOAD_READY,
        [WSMessageType.RESP_DOWNLOAD_ERROR],
        10000,
      );
      sendWSMessage(hostWs, {
        type: WSMessageType.CMD_REQUEST_DOWNLOAD,
        payload: {
          filePath,
          requestId,
          clientId: payload.sub,
          sessionId,
        },
        timestamp: Date.now(),
        sessionId,
      });

      // 6. 等待 Host 签发令牌，然后经 WS 隧道流式传输
      try {
        const resp = (await respPromise) as any;

        const fileName = resp.fileName || filePath.split('/').pop() || 'download';

        // 7. 写访问日志（隧道接管响应前落库，传输结果不影响审计记录的存在）
        try {
          await db.insert(securityLogs).values({
            id: nanoid(),
            hostId,
            clientId: payload.sub,
            eventType: 'ACCESS_DOWNLOAD',
            detail: JSON.stringify({ action: 'proxy_download', filePath, sessionId }),
            ipAddress: request.ip || 'unknown',
            createdAt: Math.floor(Date.now() / 1000),
          });
        } catch {
          // 日志写入失败不影响主流程
        }

        // 8. 经 Host 的 WS 连接分块拉取文件（接管响应，之后不得再操作 reply）
        await tunnelFromHost(hostWs, resp.downloadUrl, request.headers.range, request.headers.origin, reply, {
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Content-Type': 'application/octet-stream',
        });
      } catch (err: any) {
        console.error(`代理下载失败: ${err.message}`);
        return reply.code(502).send({
          success: false,
          data: null,
          error: { code: 'PROXY_ERROR', message: '代理下载失败' },
          timestamp: Date.now(),
        });
      }
    },
  );

  // --- GET /proxy/preview/:sessionId ---
  fastify.get<{ Params: { sessionId: string }; Querystring: { filePath: string } }>(
    '/proxy/preview/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const { filePath } = request.query;

      // 1. 验证 Client JWT
      const payload = authenticateClient(request, reply);
      if (!payload) return;

      // 2. 验证 filePath
      if (!filePath) {
        return reply.code(400).send({
          success: false,
          data: null,
          error: { code: 'MISSING_FILE_PATH', message: '缺少 filePath 参数' },
          timestamp: Date.now(),
        });
      }

      // 3. 验证会话
      if (!(await validateSession(sessionId, reply))) return;

      // 4. 查找 Host WebSocket
      const session = await db.select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      const hostId = session[0].hostId;
      const hostWs = getHostSocket(hostId);

      if (!hostWs) {
        return reply.code(502).send({
          success: false,
          data: null,
          error: { code: 'HOST_OFFLINE', message: '目标主机不在线' },
          timestamp: Date.now(),
        });
      }

      // 5. 注册等待（必须先于发送，避免响应先到）→ 向 Host 发送 CMD_REQUEST_PREVIEW
      const requestId = nanoid();
      const respPromise = waitForHostResponse(
        requestId,
        WSMessageType.RESP_PREVIEW_READY,
        [WSMessageType.RESP_PREVIEW_ERROR],
        10000,
      );
      sendWSMessage(hostWs, {
        type: WSMessageType.CMD_REQUEST_PREVIEW,
        payload: {
          filePath,
          requestId,
          clientId: payload.sub,
          sessionId,
        },
        timestamp: Date.now(),
        sessionId,
      });

      // 6. 等待 Host 签发令牌，然后经 WS 隧道流式传输
      try {
        const resp = (await respPromise) as any;

        // 7. 写访问日志
        try {
          await db.insert(securityLogs).values({
            id: nanoid(),
            hostId,
            clientId: payload.sub,
            eventType: 'ACCESS_PREVIEW',
            detail: JSON.stringify({ action: 'proxy_preview', filePath, sessionId }),
            ipAddress: request.ip || 'unknown',
            createdAt: Math.floor(Date.now() / 1000),
          });
        } catch {
          // 日志写入失败不影响主流程
        }

        // 8. 经 Host 的 WS 连接分块拉取文件
        // （预览不强制下载、Content-Type 用 Host 报告的真实 MIME，Cache-Control 防缓存）
        await tunnelFromHost(hostWs, resp.previewUrl, request.headers.range, request.headers.origin, reply, {
          'Cache-Control': 'no-store',
        });
      } catch (err: any) {
        console.error(`代理预览失败: ${err.message}`);
        return reply.code(502).send({
          success: false,
          data: null,
          error: { code: 'PROXY_ERROR', message: '代理预览失败' },
          timestamp: Date.now(),
        });
      }
    },
  );
}
