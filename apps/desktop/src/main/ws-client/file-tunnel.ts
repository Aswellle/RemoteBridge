import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { WSMessageType, encodeFileChunkFrame } from '@remotebridge/shared';
import type { CmdFetchFilePayload, CmdCancelTransferPayload } from '@remotebridge/shared';
import { getRelayClient } from './client';
import db from '../db/client';
import { validatePath } from '../security/path-guard';
import { logAccess } from '../security/audit-logger';
import { validateDownloadToken, markTokenUsed } from '../file-server/token-manager';
import { getContentTypeForExt } from '../file-server/server';
import log from '../logger';

// ===== 分块/背压配置 =====
// 256KB 原始数据，二进制帧（P1-12）下加上固定头部直接发送，无 base64 膨胀
const CHUNK_SIZE = 256 * 1024;
// WS 发送缓冲超过 4MB 时暂停读盘，等 Relay 消化
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== P0-02: Per-transfer AbortController registry =====
// Maps transferId -> AbortController so CMD_CANCEL_TRANSFER can stop the disk read.
const transferControllers = new Map<string, AbortController>();

function registerTransferController(transferId: string, controller: AbortController): void {
  transferControllers.set(transferId, controller);
}

function unregisterTransferController(transferId: string): void {
  transferControllers.delete(transferId);
}

function abortTransfer(transferId: string): boolean {
  const controller = transferControllers.get(transferId);
  if (!controller) return false;
  controller.abort();
  transferControllers.delete(transferId);
  return true;
}

// ===== CMD_FETCH_FILE: Relay 代理请求经 WS 隧道拉取文件 =====
// Host 的文件服务器只监听 127.0.0.1，Relay（跨 NAT）无法 HTTP 直连，
// 文件内容必须借道这条出站 WS 连接分块回传。
// 令牌沿用下载/预览令牌：单次使用语义由这里的 markTokenUsed 保证。
export function setupFileTunnelHandler(): void {
  const client = getRelayClient();
  if (!client) return;

  client.on(WSMessageType.CMD_FETCH_FILE, async (rawPayload: unknown) => {
    const payload = rawPayload as CmdFetchFilePayload;
    const { transferId, token, rangeStart, rangeEnd } = payload;

    const sendError = (code: string, message: string) => {
      client.send({
        type: WSMessageType.RESP_FILE_ERROR,
        payload: { transferId, code, message },
        timestamp: Date.now(),
      });
    };

    // P0-02: Create AbortController for this transfer
    const abortController = new AbortController();
    registerTransferController(transferId, abortController);

    const cleanup = () => {
      unregisterTransferController(transferId);
    };

    try {
      // 1. 验证令牌（单次使用、30 分钟过期；clientId 由 Relay 注入，校验令牌绑定）
      const validation = validateDownloadToken(token, payload.clientId);
      if (!validation.valid || !validation.token) {
        sendError('INVALID_TOKEN', validation.reason || '令牌无效或已过期');
        cleanup();
        return;
      }
      const { filePath, clientId } = validation.token;

      // 2. 二次安全校验（与 HTTP 文件服务器相同：防伪造令牌指向白名单外路径）
      const allowedDirs = db.getAllowedDirectories();
      const pathValidation = validatePath(filePath, allowedDirs as any);
      if (!pathValidation.allowed) {
        sendError('PATH_FORBIDDEN', '路径不在白名单中');
        cleanup();
        return;
      }

      // 3. 消费令牌
      markTokenUsed(token);

      // 4. 计算字节范围（含端点）
      const stat = await fs.stat(filePath);
      const totalSize = stat.size;

      // PR-04: Strict range validation — reject unsatisfiable ranges instead of clamping
      // end < start → 416 (PR-04 RB-P0-04)
      if (rangeStart != null && rangeEnd != null && rangeEnd < rangeStart) {
        sendError('INVALID_RANGE', 'Range end < start');
        cleanup();
        return;
      }
      if (rangeStart != null && rangeStart >= 0 && rangeStart < totalSize) {
        // valid start
      } else if (rangeStart != null) {
        sendError('INVALID_RANGE', 'Range start >= fileSize');
        cleanup();
        return;
      }
      if (rangeEnd != null && rangeEnd >= (rangeStart ?? 0) && rangeEnd < totalSize) {
        // valid end
      } else if (rangeEnd != null && rangeEnd >= totalSize) {
        sendError('INVALID_RANGE', 'Range end >= fileSize');
        cleanup();
        return;
      }

      const start = rangeStart != null ? rangeStart : 0;
      const end = rangeEnd != null ? rangeEnd : totalSize - 1;

      const ext = path.extname(filePath).slice(1).toLowerCase();
      const contentType = getContentTypeForExt(ext);
      const fileName = path.basename(filePath);

      await logAccess({ clientId, action: 'TUNNEL_FETCH', path: filePath, status: 'OK' });

      // 5. 空文件：单帧 eof
      if (totalSize === 0) {
        const frame = encodeFileChunkFrame(
          { transferId, seq: 0, eof: true, totalSize: 0, rangeStart: 0, rangeEnd: 0, contentType, fileName },
          Buffer.alloc(0),
        );
        client.sendRaw(frame);
        cleanup();
        return;
      }

      // 6. 流式读取并分块回传
      const stream = createReadStream(filePath, { start, end, highWaterMark: CHUNK_SIZE });
      let seq = 0;
      let sentBytes = 0;
      const rangeLength = end - start + 1;

      // P0-02: Listen for abort signal
      const onAbort = () => {
        stream.destroy();
      };
      abortController.signal.addEventListener('abort', onAbort);

      for await (const chunk of stream) {
        // P0-02: Check abort signal
        if (abortController.signal.aborted) {
          break;
        }

        // 背压：等待 WS 缓冲降到水位线下，避免大文件全堆在内存里
        while (client.getBufferedAmount() > BACKPRESSURE_HIGH_WATER) {
          if (!client.isConnected()) {
            stream.destroy();
            cleanup();
            return;
          }
          // P0-02: Check abort during backpressure wait
          if (abortController.signal.aborted) {
            break;
          }
          await sleep(BACKPRESSURE_POLL_MS);
        }

        if (abortController.signal.aborted) {
          break;
        }

        sentBytes += (chunk as Buffer).length;
        const currentSeq = seq++;
        const isEof = sentBytes >= rangeLength;
        const meta = currentSeq === 0
          ? { totalSize, rangeStart: start, rangeEnd: end, contentType, fileName }
          : {};
        const frame = encodeFileChunkFrame(
          { transferId, seq: currentSeq, eof: isEof, ...meta },
          chunk as Buffer,
        );
        const sent = client.sendRaw(frame);
        if (!sent) {
          stream.destroy();
          cleanup();
          return;
        }
        if (isEof) break;
      }

      // Cleanup abort listener and controller
      abortController.signal.removeEventListener('abort', onAbort);
      cleanup();
    } catch (err) {
      // P0-02: Don't log as error if this was an intentional cancel
      if (abortController.signal.aborted) {
        log.info('文件隧道传输已取消:', transferId);
      } else {
        log.error('文件隧道读取失败:', err);
        sendError('FS_ERROR', '文件系统访问失败');
      }
      cleanup();
    }
  });

  // P0-02: CMD_CANCEL_TRANSFER handler
  client.on(WSMessageType.CMD_CANCEL_TRANSFER, (rawPayload: unknown) => {
    const payload = rawPayload as CmdCancelTransferPayload;
    if (!payload.transferId) return;
    const aborted = abortTransfer(payload.transferId);
    if (aborted) {
      log.info('传输已取消:', payload.transferId, payload.reason || '');
    }
  });
}

// For tests / observability
export function activeTransferControllerCount(): number {
  return transferControllers.size;
}
