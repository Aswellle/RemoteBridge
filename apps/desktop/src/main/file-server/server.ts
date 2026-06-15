import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream, statSync } from 'fs';
import path from 'path';
import { validateDownloadToken, markTokenUsed } from './token-manager';
import { validatePath } from '../security/path-guard';
import { db } from '../db/client';

// ===== 本地文件服务器 =====
let fileServer: ReturnType<typeof Fastify> | null = null;
let fileServerPort = 0;

// ===== 扩展名 → MIME（HTTP 预览端点与 WS 文件隧道共用） =====
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  ts: 'application/javascript; charset=utf-8',
  tsx: 'application/javascript; charset=utf-8',
  jsx: 'application/javascript; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  rb: 'text/x-ruby; charset=utf-8',
  go: 'text/x-go; charset=utf-8',
  rs: 'text/x-rust; charset=utf-8',
  java: 'text/x-java; charset=utf-8',
  c: 'text/x-c; charset=utf-8',
  cpp: 'text/x-c++src; charset=utf-8',
  h: 'text/x-c; charset=utf-8',
  sql: 'application/sql; charset=utf-8',
  sh: 'application/x-sh; charset=utf-8',
};

export function getContentTypeForExt(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

// ===== 启动文件服务器 =====
export async function startFileServer(): Promise<number> {
  if (fileServer) {
    return fileServerPort;
  }

  fileServer = Fastify({
    logger: false, // 安静模式
  });

  // --- GET /download ---
  // 文件下载端点
  fileServer.get('/download', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.query as { token: string };

    if (!token) {
      return reply.code(400).send({ error: 'Missing token' });
    }

    // 1. 验证 token
    const validation = validateDownloadToken(token);
    if (!validation.valid || !validation.token) {
      return reply.code(401).send({ error: validation.reason });
    }

    const { filePath, clientId } = validation.token;

    // 2. 二次安全校验（防止 token 被伪造）
    const allowedDirs = db.getAllowedDirectories();
    const pathValidation = validatePath(filePath, allowedDirs as any);

    if (!pathValidation.allowed) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    // 3. 标记 token 为已使用
    markTokenUsed(token);

    // 4. 写访问日志
    db.insertAccessLog({
      clientId,
      action: 'DOWNLOAD',
      path: filePath,
      status: 'OK',
    });

    try {
      // 5. 获取文件信息
      const stat = statSync(filePath);
      const fileName = path.basename(filePath);
      const rangeHeader = request.headers.range;

      // 6. 设置响应头
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      reply.header('Accept-Ranges', 'bytes');

      if (rangeHeader) {
        // Range 请求（断点续传）
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        reply.header('Content-Length', chunkSize);

        return reply.send(createReadStream(filePath, { start, end }));
      } else {
        // 完整文件
        reply.header('Content-Length', stat.size);
        return reply.send(createReadStream(filePath));
      }
    } catch (err) {
      return reply.code(404).send({ error: 'File not found' });
    }
  });

  // --- GET /preview ---
  // 文件预览端点
  fileServer.get('/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.query as { token: string };

    if (!token) {
      return reply.code(400).send({ error: 'Missing token' });
    }

    // 1. 验证 token
    const validation = validateDownloadToken(token);
    if (!validation.valid || !validation.token) {
      return reply.code(401).send({ error: validation.reason });
    }

    const { filePath, clientId } = validation.token;

    // 2. 安全校验
    const allowedDirs = db.getAllowedDirectories();
    const pathValidation = validatePath(filePath, allowedDirs as any);

    if (!pathValidation.allowed) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    // 3. 标记 token 为已使用
    markTokenUsed(token);

    // 4. 写访问日志
    db.insertAccessLog({
      clientId,
      action: 'PREVIEW',
      path: filePath,
      status: 'OK',
    });

    try {
      // 5. 获取文件信息
      const stat = statSync(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).slice(1).toLowerCase();

      // 6. 设置 Content-Type
      reply.header('Content-Type', getContentTypeForExt(ext));
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'no-store'); // 预览内容不缓存

      // 7. 支持 Range 请求（用于大文本文件分段加载）
      const rangeHeader = request.headers.range;
      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        reply.header('Content-Length', chunkSize);

        return reply.send(createReadStream(filePath, { start, end }));
      }

      reply.header('Content-Length', stat.size);
      return reply.send(createReadStream(filePath));
    } catch (err) {
      return reply.code(404).send({ error: 'File not found' });
    }
  });

  // 启动服务器（仅监听本地）
  await fileServer.listen({ host: '127.0.0.1', port: 0 });
  const address = fileServer.server.address();
  fileServerPort = typeof address === 'object' && address ? address.port : 0;

  console.log(`📁 本地文件服务器启动于 http://127.0.0.1:${fileServerPort}`);
  return fileServerPort;
}

// ===== 停止文件服务器 =====
export async function stopFileServer(): Promise<void> {
  if (fileServer) {
    await fileServer.close();
    fileServer = null;
    fileServerPort = 0;
  }
}

// ===== 获取文件服务器端口 =====
export function getFileServerPort(): number {
  return fileServerPort;
}
