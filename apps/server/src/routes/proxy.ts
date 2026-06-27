import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';
import { verifyAccessToken, extractTokenFromRequest, ClientTokenPayload } from '../utils/jwt';
import { db } from '../db/client';
import { sessions, securityLogs } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { sendWSMessage } from '../ws/relay';
import { getHostSocket } from '../ws/connection-registry';
import { waitForHostResponse } from '../ws/pending-requests';
import { beginFileTransfer, endFileTransfer } from '../ws/file-tunnel';
import type { NormalizedFileChunk } from '../ws/file-tunnel';
import { WSMessageType } from '@remotebridge/shared';
import { randomUUID } from 'node:crypto';
// reply.hijack() 之后 @fastify/cors 的钩子不再执行，流式响应必须手动补 CORS 头，
// 否则浏览器拦截代理下载/预览（curl/Node 不校验 CORS，API 级测试无感）
import { corsHeadersFor } from '../utils/cors';

type ProxyRequest = FastifyRequest<{ Params: { sessionId: string }; Querystring: { filePath: string } }>;

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
  clientId?: string,
): Promise<void> {
  const token = new URL(hostUrl).searchParams.get('token');
  if (!token) {
    throw new Error('Host 返回的下载地址缺少令牌');
  }

  const range = parseRange(rangeHeader);
  const corsHdrs = corsHeadersFor(origin);
  const transferId = randomUUID();

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
      onChunk: (chunk: NormalizedFileChunk) => {
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

        if (chunk.data.length > 0) {
          // 浏览器侧背压无法回传给 Host（帧已在途），Node 会缓冲未写出的数据；
          // Host 端 4MB 发送水位间接限制了在途数据量
          raw.write(chunk.data);
        }
        if (chunk.eof) {
          raw.end();
          finish();
        }
      },
      onError: (err: Error) => {
        if (finished) return;
        if (!headersSent) {
          reply.log.error({ err }, '文件隧道传输失败');
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
        clientId,
      },
      timestamp: Date.now(),
    });
  });
}

// ===== 验证 Client JWT =====
// 02a-S11 之后 Web 端走 rb_access cookie，不再有可读的 Authorization 头 —— 必须支持两条路径，
// 否则任何非本机部署（Web 必经此代理）的下载/预览都会 401。
function authenticateClient(request: FastifyRequest, reply: FastifyReply): ClientTokenPayload | null {
  const token = extractTokenFromRequest(request.headers);
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

// ===== 验证会话（返回行以避免二次查询，PM2） =====
async function validateSession(
  sessionId: string,
  reply: FastifyReply,
): Promise<{ hostId: string } | null> {
  const rows = await db.select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .limit(1);

  if (!rows.length) {
    reply.code(404).send({
      success: false,
      data: null,
      error: { code: 'SESSION_NOT_FOUND', message: '会话不存在或已被吊销' },
      timestamp: Date.now(),
    });
    return null;
  }

  return { hostId: rows[0].hostId };
}

// ===== CQ-H1: 提取公共代理逻辑，消除 download/preview 路由的 ~85% 重复代码 =====
async function proxyFileRequest(
  request: ProxyRequest,
  reply: FastifyReply,
  mode: 'download' | 'preview',
): Promise<void> {
  const { sessionId } = request.params;
  const { filePath } = request.query;

  // 1. 验证 Client JWT
  const payload = authenticateClient(request, reply);
  if (!payload) return;

  // 2. SH4: 确保 JWT 中的 sessionId 与 URL 参数一致，防止持有已吊销会话 token 的
  //    Client 借用其他活跃会话绕过吊销检查
  if (payload.sessionId !== sessionId) {
    return reply.code(403).send({
      success: false,
      data: null,
      error: { code: 'SESSION_MISMATCH', message: '令牌会话与请求会话不匹配' },
      timestamp: Date.now(),
    });
  }

  // 3. 验证 filePath
  if (!filePath) {
    return reply.code(400).send({
      success: false,
      data: null,
      error: { code: 'MISSING_FILE_PATH', message: '缺少 filePath 参数' },
      timestamp: Date.now(),
    });
  }

  // 4. 验证会话（同时取 hostId，避免二次查询）
  const sessionRow = await validateSession(sessionId, reply);
  if (!sessionRow) return;

  // 5. 查找 Host WebSocket
  const { hostId } = sessionRow;
  const hostWs = getHostSocket(hostId);
  if (!hostWs) {
    return reply.code(502).send({
      success: false,
      data: null,
      error: { code: 'HOST_OFFLINE', message: '目标主机不在线' },
      timestamp: Date.now(),
    });
  }

  // 6. 注册等待（必须先于发送，避免响应先到）→ 向 Host 发送 CMD_REQUEST_*
  const isDownload = mode === 'download';
  const requestId = randomUUID();
  const respPromise = waitForHostResponse(
    requestId,
    isDownload ? WSMessageType.RESP_DOWNLOAD_READY : WSMessageType.RESP_PREVIEW_READY,
    isDownload ? [WSMessageType.RESP_DOWNLOAD_ERROR] : [WSMessageType.RESP_PREVIEW_ERROR],
    10000,
  );
  sendWSMessage(hostWs, {
    type: isDownload ? WSMessageType.CMD_REQUEST_DOWNLOAD : WSMessageType.CMD_REQUEST_PREVIEW,
    payload: { filePath, requestId, clientId: payload.sub, sessionId },
    timestamp: Date.now(),
    sessionId,
  });

  // 7. 等待 Host 签发令牌，写访问日志，经 WS 隧道流式传输
  try {
    const resp = (await respPromise) as any;

    try {
      await db.insert(securityLogs).values({
        id: randomUUID(),
        hostId,
        clientId: payload.sub,
        eventType: isDownload ? 'ACCESS_DOWNLOAD' : 'ACCESS_PREVIEW',
        detail: JSON.stringify({ action: isDownload ? 'proxy_download' : 'proxy_preview', filePath, sessionId }),
        ipAddress: request.ip || 'unknown',
        createdAt: Math.floor(Date.now() / 1000),
      });
    } catch {
      // 日志写入失败不影响主流程
    }

    const fileUrl = isDownload ? resp.downloadUrl : resp.previewUrl;
    const fileName = resp.fileName || filePath.split('/').pop() || 'download';
    const extraHeaders: Record<string, string> = isDownload
      ? {
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Content-Type': 'application/octet-stream',
        }
      : { 'Cache-Control': 'no-store' };

    await tunnelFromHost(hostWs, fileUrl, request.headers.range, request.headers.origin, reply, extraHeaders, payload.sub);
  } catch (err: any) {
    request.log.error({ err }, isDownload ? '代理下载失败' : '代理预览失败');
    return reply.code(502).send({
      success: false,
      data: null,
      error: { code: 'PROXY_ERROR', message: isDownload ? '代理下载失败' : '代理预览失败' },
      timestamp: Date.now(),
    });
  }
}

// ===== 代理路由 =====
export async function proxyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { sessionId: string }; Querystring: { filePath: string } }>(
    '/proxy/download/:sessionId',
    (request, reply) => proxyFileRequest(request, reply, 'download'),
  );

  fastify.get<{ Params: { sessionId: string }; Querystring: { filePath: string } }>(
    '/proxy/preview/:sessionId',
    (request, reply) => proxyFileRequest(request, reply, 'preview'),
  );
}
