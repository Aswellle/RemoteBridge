import { WSMessageType, getFileCategory, isPreviewableFile } from '@remotebridge/shared';
import { BrowserWindow } from 'electron';
import { getRelayClient } from './client';
import db from '../db/client';
import { validatePath } from '../security/path-guard';
import { logAccess } from '../security/audit-logger';
import { createDownloadToken, validateDownloadToken, markTokenUsed } from '../file-server/token-manager';
import { getFileServerPort } from '../file-server/server';
import fs from 'fs/promises';
import path from 'path';
import log from '../logger';

// ===== 白名单目录缓存（CQ-M5/PERF-M4）=====
// 每次 WS 消息都调一次同步 SQLite 查询开销过大；用 10s TTL 缓存，
// dir 变更时由 ipc/dirs.ts 调 invalidateAllowedDirsCache() 主动失效。
let _allowedDirsCache: any[] | null = null;
let _allowedDirsCacheAt = 0;
const ALLOWED_DIRS_TTL_MS = 10_000;

export function invalidateAllowedDirsCache(): void {
  _allowedDirsCache = null;
}

function getCachedAllowedDirs(): any[] {
  if (_allowedDirsCache && Date.now() - _allowedDirsCacheAt < ALLOWED_DIRS_TTL_MS) {
    return _allowedDirsCache;
  }
  _allowedDirsCache = db.getAllowedDirectories() as any[];
  _allowedDirsCacheAt = Date.now();
  return _allowedDirsCache;
}

// ===== 预览配置 =====
const PREVIEW_MAX_SIZE = 10 * 1024 * 1024; // 10MB 以上不预览

// ===== 目录列表 fs.stat 并发上限 =====
// 避免大目录（数千个条目）一次性发出无限制的 fs.stat 并发请求
const STAT_CONCURRENCY = 64;

// ===== 路由回显 =====
// Relay 转发 CMD_* 时会把 clientId/sessionId 注入 payload；
// 所有 RESP_* 必须原样回显这两个字段，Relay 才能把响应路由回发起请求的 Client。
function withRouting(payload: Record<string, unknown>, req: { clientId?: string; sessionId?: string }) {
  return {
    ...payload,
    clientId: req.clientId,
    sessionId: req.sessionId,
  };
}

// ===== 设置目录浏览 WS 处器 =====
export function setupDirWsHandlers(mainWindow: BrowserWindow | null): void {
  const client = getRelayClient();
  if (!client) return;

  // --- CMD_LIST_ALLOWED: 列出共享目录白名单（Client 文件浏览的入口） ---
  client.on(WSMessageType.CMD_LIST_ALLOWED, async (payload: any) => {
    const { requestId, clientId, sessionId } = payload;

    try {
      const allowedDirs = getCachedAllowedDirs() as any[];

      const entries = await Promise.all(
        allowedDirs.map(async (dir) => {
          let modifiedAt = Date.now();
          try {
            const stat = await fs.stat(dir.path);
            modifiedAt = stat.mtimeMs;
          } catch {
            // 目录暂不可访问也照常返回，进入时再报错
          }
          return {
            name: dir.label || path.basename(dir.path) || dir.path,
            path: dir.path,
            type: 'dir' as const,
            size: 0,
            modifiedAt,
            extension: '',
            isPreviewable: false,
            permission: dir.permission as 'readonly' | 'download',
          };
        })
      );

      await logAccess({
        clientId,
        action: 'LIST_ALLOWED',
        path: '',
        status: 'OK',
      });

      client.send({
        type: WSMessageType.RESP_DIR_LIST,
        sessionId,
        payload: withRouting({
          requestId,
          path: null, // null 表示白名单根列表
          entries,
          parentPath: null,
        }, payload),
      });
    } catch (err) {
      log.error('列出白名单目录失败:', err);
      client.send({
        type: WSMessageType.RESP_DIR_ERROR,
        sessionId,
        payload: withRouting({
          requestId,
          code: 'FS_ERROR',
          message: '文件系统访问失败',
        }, payload),
      });
    }
  });

  // --- CMD_LIST_DIR: 列目录 ---
  client.on(WSMessageType.CMD_LIST_DIR, async (payload: any) => {
    const { path: requestedPath, requestId, clientId, sessionId } = payload;

    try {
      // 1. 获取最新白名单
      const allowedDirs = getCachedAllowedDirs();

      // 2. 安全校验
      const validation = validatePath(requestedPath, allowedDirs as any);

      if (!validation.allowed) {
        // 写安全日志
        await logAccess({
          clientId,
          action: 'LIST_DIR',
          path: requestedPath,
          status: 'BLOCKED',
        });

        client.send({
          type: WSMessageType.RESP_DIR_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: validation.reason,
            message: getErrorMessage(validation.reason),
          }, payload),
        });
        return;
      }

      // 3. 检查目录是否存在
      try {
        const stat = await fs.stat(requestedPath);
        if (!stat.isDirectory()) {
          client.send({
            type: WSMessageType.RESP_DIR_ERROR,
            sessionId,
            payload: withRouting({
              requestId,
              code: 'NOT_DIRECTORY',
              message: '路径不是目录',
            }, payload),
          });
          return;
        }
      } catch {
        client.send({
          type: WSMessageType.RESP_DIR_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: 'NOT_FOUND',
            message: '目录不存在',
          }, payload),
        });
        return;
      }

      // 4. 读取目录
      const entries = await fs.readdir(requestedPath, { withFileTypes: true });

      const fileEntries = await mapWithConcurrency(entries, STAT_CONCURRENCY, async (entry) => {
        const fullPath = path.join(requestedPath, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          const ext = entry.isDirectory() ? '' : path.extname(entry.name).slice(1).toLowerCase();

          return {
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            extension: ext,
            // PDF 由浏览器内置 PDF 阅读器流式加载，无需 10MB 内存限制；其他格式需全量读入内存，受限
            isPreviewable: isPreviewableFile(ext) && (ext === 'pdf' || stat.size <= PREVIEW_MAX_SIZE),
          };
        } catch {
          // 无权限等情况，跳过
          return null;
        }
      });

      // 过滤 null（无权限的文件）
      const validEntries = fileEntries.filter(Boolean);

      // 5. 写访问日志
      await logAccess({
        clientId,
        action: 'LIST_DIR',
        path: requestedPath,
        status: 'OK',
      });

      // 6. 返回结果
      const parentPath = path.dirname(requestedPath) !== requestedPath
        ? path.dirname(requestedPath)
        : null;

      client.send({
        type: WSMessageType.RESP_DIR_LIST,
        sessionId,
        payload: withRouting({
          requestId,
          path: requestedPath,
          entries: validEntries,
          parentPath,
        }, payload),
      });
    } catch (err) {
      log.error('列出目录失败:', err);
      client.send({
        type: WSMessageType.RESP_DIR_ERROR,
        sessionId,
        payload: withRouting({
          requestId,
          code: 'FS_ERROR',
          message: '文件系统访问失败',
        }, payload),
      });
    }
  });

  // --- CMD_REQUEST_DOWNLOAD: 下载请求 ---
  client.on(WSMessageType.CMD_REQUEST_DOWNLOAD, async (payload: any) => {
    const { filePath, requestId, clientId, sessionId } = payload;

    try {
      // 1. 安全校验
      const allowedDirs = getCachedAllowedDirs();
      const validation = validatePath(filePath, allowedDirs as any);

      if (!validation.allowed) {
        await logAccess({
          clientId,
          action: 'DOWNLOAD',
          path: filePath,
          status: 'BLOCKED',
        });

        client.send({
          type: WSMessageType.RESP_DOWNLOAD_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: validation.reason,
            message: getErrorMessage(validation.reason),
          }, payload),
        });
        return;
      }

      // 2. 检查权限（使用 resolve + 分隔符匹配，与 path-guard 一致，
      //    防止 C:\Data 误匹配 C:\DataEvil 之类的前缀攻击）
      const resolvedFile = path.resolve(filePath);
      const dir = (allowedDirs as any[]).find((d: any) => {
        if (d.permission !== 'download') return false;
        const resolvedDir = path.resolve(d.path);
        return resolvedFile === resolvedDir || resolvedFile.startsWith(resolvedDir + path.sep);
      });

      if (!dir) {
        client.send({
          type: WSMessageType.RESP_DOWNLOAD_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: 'NO_PERMISSION',
            message: '该目录不允许下载',
          }, payload),
        });
        return;
      }

      // 3. 检查文件是否存在
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        client.send({
          type: WSMessageType.RESP_DOWNLOAD_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: 'NOT_FILE',
            message: '路径不是文件',
          }, payload),
        });
        return;
      }

      // 4. 生成下载 token
      const token = createDownloadToken(filePath, clientId);

      // 5. 构建下载 URL
      const port = getFileServerPort();
      const downloadUrl = `http://127.0.0.1:${port}/download?token=${token.token}`;

      // 6. 写访问日志
      await logAccess({
        clientId,
        action: 'DOWNLOAD',
        path: filePath,
        status: 'OK',
      });

      // 7. 返回下载信息
      client.send({
        type: WSMessageType.RESP_DOWNLOAD_READY,
        sessionId,
        payload: withRouting({
          requestId,
          downloadUrl,
          fileName: path.basename(filePath),
          fileSize: stat.size,
          expiresAt: token.expiresAt,
        }, payload),
      });
    } catch (err) {
      log.error('处理下载请求失败:', err);
      client.send({
        type: WSMessageType.RESP_DOWNLOAD_ERROR,
        sessionId,
        payload: withRouting({
          requestId,
          code: 'INTERNAL_ERROR',
          message: '服务器内部错误',
        }, payload),
      });
    }
  });

  // --- CMD_REQUEST_PREVIEW: 预览请求 ---
  client.on(WSMessageType.CMD_REQUEST_PREVIEW, async (payload: any) => {
    const { filePath, requestId, clientId, sessionId } = payload;

    try {
      // 1. 安全校验
      const allowedDirs = getCachedAllowedDirs();
      const validation = validatePath(filePath, allowedDirs as any);

      if (!validation.allowed) {
        // 写安全日志
        await logAccess({
          clientId,
          action: 'PREVIEW',
          path: filePath,
          status: 'BLOCKED',
        });

        client.send({
          type: WSMessageType.RESP_PREVIEW_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: validation.reason,
            message: getErrorMessage(validation.reason),
          }, payload),
        });
        return;
      }

      // 2. 检查文件类型与大小
      const stat = await fs.stat(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      // PDF 由浏览器内置阅读器流式加载，无需全量内存，豁免 10MB 限制
      if (ext !== 'pdf' && stat.size > PREVIEW_MAX_SIZE) {
        client.send({
          type: WSMessageType.RESP_PREVIEW_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: 'FILE_TOO_LARGE',
            message: `文件过大 (${formatSize(stat.size)})，无法预览`,
          }, payload),
        });
        return;
      }

      // 3. 检查是否可预览
      if (!isPreviewableFile(ext)) {
        client.send({
          type: WSMessageType.RESP_PREVIEW_ERROR,
          sessionId,
          payload: withRouting({
            requestId,
            code: 'UNSUPPORTED_TYPE',
            message: '不支持预览此文件类型',
          }, payload),
        });
        return;
      }

      // 4. 生成预览 token
      const token = createDownloadToken(filePath, clientId);

      // 5. 构建预览 URL
      const port = getFileServerPort();
      const previewUrl = `http://127.0.0.1:${port}/preview?token=${token.token}`;

      // 6. 写访问日志
      await logAccess({
        clientId,
        action: 'PREVIEW',
        path: filePath,
        status: 'OK',
      });

      // 7. 返回预览信息
      client.send({
        type: WSMessageType.RESP_PREVIEW_READY,
        sessionId,
        payload: withRouting({
          requestId,
          previewUrl,
          fileName: path.basename(filePath),
          fileSize: stat.size,
          extension: ext,
          category: getFileCategory(ext),
          expiresAt: token.expiresAt,
        }, payload),
      });
    } catch (err) {
      log.error('处理预览请求失败:', err);
      client.send({
        type: WSMessageType.RESP_PREVIEW_ERROR,
        sessionId,
        payload: withRouting({
          requestId,
          code: 'INTERNAL_ERROR',
          message: '服务器内部错误',
        }, payload),
      });
    }
  });
}

// ===== 辅助函数 =====
// 分批执行异步映射，每批最多 `limit` 个并发，批次之间串行
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

function getErrorMessage(reason?: string): string {
  const messages: Record<string, string> = {
    SYSTEM_PROTECTED: '访问被拒绝：系统保护目录',
    NOT_IN_WHITELIST: '访问被拒绝：目录未授权',
    INVALID_PATH: '路径无效',
  };
  return messages[reason || ''] || '访问被拒绝';
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}
