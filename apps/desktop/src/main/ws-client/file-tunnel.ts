import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { WSMessageType } from '@remotebridge/shared';
import type { CmdFetchFilePayload } from '@remotebridge/shared';
import { getRelayClient } from './client';
import db from '../db/client';
import { validatePath } from '../security/path-guard';
import { logAccess } from '../security/audit-logger';
import { validateDownloadToken, markTokenUsed } from '../file-server/token-manager';
import { getContentTypeForExt } from '../file-server/server';

// ===== 分块/背压配置 =====
// 256KB 原始数据 → base64 后约 341KB/帧
const CHUNK_SIZE = 256 * 1024;
// WS 发送缓冲超过 4MB 时暂停读盘，等 Relay 消化
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      });
    };

    try {
      // 1. 验证令牌（单次使用、30 分钟过期）
      const validation = validateDownloadToken(token);
      if (!validation.valid || !validation.token) {
        sendError('INVALID_TOKEN', `令牌无效: ${validation.reason}`);
        return;
      }

      const { filePath, clientId } = validation.token;

      // 2. 二次安全校验（与 HTTP 文件服务器相同：防伪造令牌指向白名单外路径）
      const allowedDirs = db.getAllowedDirectories();
      const pathValidation = validatePath(filePath, allowedDirs as any);
      if (!pathValidation.allowed) {
        await logAccess({ clientId, action: 'TUNNEL_FETCH', path: filePath, status: 'BLOCKED' });
        sendError('ACCESS_DENIED', '访问被拒绝');
        return;
      }

      // 3. 消费令牌
      markTokenUsed(token);

      // 4. 计算字节范围（含端点）
      const stat = await fs.stat(filePath);
      const totalSize = stat.size;
      const start = rangeStart != null && rangeStart >= 0 ? Math.min(rangeStart, Math.max(totalSize - 1, 0)) : 0;
      const end = rangeEnd != null && rangeEnd >= start ? Math.min(rangeEnd, totalSize - 1) : totalSize - 1;

      const ext = path.extname(filePath).slice(1).toLowerCase();
      const contentType = getContentTypeForExt(ext);
      const fileName = path.basename(filePath);

      await logAccess({ clientId, action: 'TUNNEL_FETCH', path: filePath, status: 'OK' });

      // 5. 空文件：单帧 eof
      if (totalSize === 0) {
        client.send({
          type: WSMessageType.RESP_FILE_CHUNK,
          payload: {
            transferId, seq: 0, data: '', eof: true,
            totalSize, rangeStart: 0, rangeEnd: 0, contentType, fileName,
          },
        });
        return;
      }

      // 6. 流式读取并分块回传
      const stream = createReadStream(filePath, { start, end, highWaterMark: CHUNK_SIZE });
      let seq = 0;
      let sentBytes = 0;
      const rangeLength = end - start + 1;

      for await (const chunk of stream) {
        // 背压：等待 WS 缓冲降到水位线下，避免大文件全堆在内存里
        while (client.getBufferedAmount() > BACKPRESSURE_HIGH_WATER) {
          if (!client.isConnected()) {
            stream.destroy();
            return; // 连接已断，放弃传输（Relay 侧靠空闲超时清理）
          }
          await sleep(BACKPRESSURE_POLL_MS);
        }

        sentBytes += (chunk as Buffer).length;
        const currentSeq = seq++;
        // 文件元信息只在首帧携带，后续分块帧省略（避免对大文件的每个分块重复发送相同元数据）
        const meta = currentSeq === 0
          ? { totalSize, rangeStart: start, rangeEnd: end, contentType, fileName }
          : {};
        const sent = client.send({
          type: WSMessageType.RESP_FILE_CHUNK,
          payload: {
            transferId,
            seq: currentSeq,
            data: (chunk as Buffer).toString('base64'),
            eof: sentBytes >= rangeLength,
            ...meta,
          },
        });
        if (!sent) {
          stream.destroy();
          return; // 连接在发送时断开，放弃传输（Relay 侧靠空闲超时清理）
        }
      }
    } catch (err) {
      console.error('文件隧道读取失败:', err);
      sendError('FS_ERROR', '文件系统访问失败');
    }
  });
}
