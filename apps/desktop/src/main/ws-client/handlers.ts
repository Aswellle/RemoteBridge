import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { open as fsOpen, copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { WSMessageType, UploadCategory, FileCategory, decodeUploadChunkFrame } from '@remotebridge/shared';
import { BrowserWindow, Notification } from 'electron';
import { getRelayClient } from './client';
import { db } from '../db/client';
import { config, getDefaultUploadPaths } from '../config/store';
import path from 'path';
import os from 'node:os';
import log from '../logger';

// ===== V2 Upload Streaming (P1-01) =====
// Streams upload chunks directly to a temp file instead of buffering in memory.
interface UploadTransferV2 {
  tempPath: string;
  writeStream: WriteStream | null;
  fileName: string;
  mimeType: string;
  category: FileCategory;
  totalSize: number;
  actualBytes: number;
  seq: number;
  clientId?: string;
  sessionId?: string;
  timer: NodeJS.Timeout;
  completed: boolean;
}
const uploadTransfers = new Map<string, UploadTransferV2>();

// Temp directory for streaming uploads
async function getUploadTempDir(): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'remotebridge', 'uploads');
  await mkdir(tmpDir, { recursive: true });
  return tmpDir;
}

// P1-03: Race-safe unique filename allocation using O_EXCL
async function getUniqueSavePathV2(dir: string, fileName: string): Promise<string> {
  const safeName = path.basename(fileName);
  await mkdir(dir, { recursive: true });
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);

  // Try the original name first with O_EXCL via a unique temp name
  const candidate = path.join(dir, safeName);
  try {
    // Use a file handle with O_EXCL to atomically check-and-create
    const handle = await fsOpen(candidate, 'wx');
    await handle.close();
    return candidate;
  } catch {
    // File exists, try with incrementing suffix
    let i = 1;
    while (i < 10000) {
      const name = `${base} (${i})${ext}`;
      const path2 = path.join(dir, name);
      try {
        const handle = await fsOpen(path2, 'wx');
        await handle.close();
        return path2;
      } catch {
        i++;
      }
    }
    throw new Error(`无法为 ${fileName} 分配唯一文件名`);
  }
}

// P1-01: Write chunk with backpressure — waits for 'drain' if kernel buffer is full
async function writeUploadChunk(
  transfer: UploadTransferV2,
  chunk: Buffer,
): Promise<void> {
  const ws = transfer.writeStream;
  if (!ws || ws.destroyed) {
    throw new Error('上传写入流不可用');
  }
  if (!ws.write(chunk)) {
    // Backpressure: wait for drain, but don't let it block forever
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(); // proceed even if drain times out
        }
      }, 5000);

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeListener('drain', onDrain);
        ws.removeListener('error', onError);
        ws.removeListener('close', onClose);
      };

      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(); // stream closed, proceed
      };

      ws.once('drain', onDrain);
      ws.once('error', onError);
      ws.once('close', onClose);
    });
  }
}

// P1-03: Close write stream and wait for OS handle release before rename
async function closeUploadWriteStream(
  transfer: UploadTransferV2,
): Promise<void> {
  const ws = transfer.writeStream;
  if (!ws || ws.destroyed) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('关闭上传写入流超时'));
      }
    }, 30000);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    ws.once('error', onError);
    ws.once('close', onClose);

    ws.end();
  });

  transfer.writeStream = null;
}

// Unified abort: destroy stream, cleanup temp, remove from map, notify peer
async function abortUploadTransfer(
  uploadId: string,
  code: string,
  message: string,
): Promise<void> {
  const transfer = uploadTransfers.get(uploadId);
  if (!transfer) return;

  transfer.completed = true;
  clearTimeout(transfer.timer);

  try {
    transfer.writeStream?.destroy();
  } catch {
    // ignore cleanup errors
  }
  transfer.writeStream = null;

  uploadTransfers.delete(uploadId);

  try {
    await unlink(transfer.tempPath);
  } catch {
    // temp file may already have been renamed/removed
  }

  const client = getRelayClient();
  client?.send({
    type: WSMessageType.RESP_UPLOAD_ERROR,
    payload: {
      uploadId,
      code,
      message,
      clientId: transfer.clientId,
      sessionId: transfer.sessionId,
    },
  });
}

// PH1: 并发上传上限与内存配额
const MAX_CONCURRENT_UPLOADS = 5;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per file cap

// V2: Finalize streaming upload — close stream, atomic rename, notify
async function uploadFinalize(uploadId: string): Promise<void> {
  const transfer = uploadTransfers.get(uploadId);
  if (!transfer || transfer.completed) {
    return;
  }

  // Integrity check: declared size must match actual bytes written
  if (transfer.actualBytes !== transfer.totalSize) {
    await abortUploadTransfer(
      uploadId,
      'SIZE_MISMATCH',
      `上传大小不一致: expected=${transfer.totalSize}, actual=${transfer.actualBytes}`,
    );
    return;
  }

  transfer.completed = true;
  clearTimeout(transfer.timer);

  const client = getRelayClient();

  try {
    // P1-03: Close stream and wait for OS handle release before rename
    await closeUploadWriteStream(transfer);

    // SEC-H1: actual byte count check (final guard)
    if (transfer.actualBytes > MAX_FILE_BYTES) {
      throw new Error(`文件过大: ${transfer.actualBytes} > ${MAX_FILE_BYTES}`);
    }

    // Determine save directory
    const stored = config.getUploadPaths();
    const paths = stored ?? await getDefaultUploadPaths();
    const saveDir = paths[transfer.category as UploadCategory] ?? paths.documents;

    // P1-03: Race-safe unique filename
    const savePath = await getUniqueSavePathV2(saveDir, transfer.fileName);

    // Atomic rename: temp → final (with cross-filesystem fallback)
    try {
      await rename(transfer.tempPath, savePath);
    } catch (renameErr: any) {
      // EXDEV: temp and saveDir on different filesystems (e.g. /tmp vs home) — fall back to copy+unlink
      if (renameErr?.code === 'EXDEV') {
        log.warn(`rename 跨文件系统，改用 copy+unlink: ${transfer.tempPath} -> ${savePath}`);
        await copyFile(transfer.tempPath, savePath);
        await unlink(transfer.tempPath);
      } else {
        throw renameErr;
      }
    }

    // Remove from map only AFTER successful rename (file is committed)
    uploadTransfers.delete(uploadId);

    log.info(`文件已保存: ${savePath}`);

    // Persist message to local DB
    try {
      db.insertMessage({
        id: uploadId,
        sessionId: transfer.sessionId,
        direction: 'client_to_host',
        content: transfer.fileName,
        type: 'file',
        senderId: transfer.clientId,
      });
    } catch (err) {
      log.error('持久化文件接收消息失败:', err);
    }

    client?.send({
      type: WSMessageType.RESP_UPLOAD_ACK,
      payload: {
        uploadId,
        fileName: transfer.fileName,
        savedPath: savePath,
        fileSize: transfer.actualBytes,
        clientId: transfer.clientId,
        sessionId: transfer.sessionId,
      },
    });

    // Desktop notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'RemoteBridge - 文件已接收',
        body: `${transfer.fileName} 已保存至 ${savePath}`,
      }).show();
    }

    const mainWindow = BrowserWindow.getAllWindows()[0];
    mainWindow?.webContents.send('event:file-received', {
      fileName: transfer.fileName,
      savedPath: savePath,
    });

  } catch (err: any) {
    log.error('保存上传文件失败:', err);

    // Ensure map entry is removed and temp file cleaned up on failure
    uploadTransfers.delete(uploadId);
    try {
      await unlink(transfer.tempPath);
    } catch {
      // already moved/deleted
    }
    client?.send({
      type: WSMessageType.RESP_UPLOAD_ERROR,
      payload: {
        uploadId,
        code: 'SAVE_ERROR',
        message: err?.message || '文件保存失败',
        clientId: transfer.clientId,
        sessionId: transfer.sessionId,
      },
    });
  }
}

// ===== 设置消息处理器 =====
export function setupMessageHandlers(mainWindow: BrowserWindow | null): void {
  const client = getRelayClient();
  if (!client) return;

  // --- CLIENT_JOINED: 新客户端加入 ---
  client.on(WSMessageType.CLIENT_JOINED, (payload: any) => {
    log.debug('新客户端加入:', payload);

    // 登记到本地 connected_clients 表（"已连接客户端"列表与信任功能的数据源）
    try {
      if (payload.clientId) {
        db.upsertConnectedClient(payload.clientId, payload.clientLabel);
      }
    } catch (err) {
      log.error('登记客户端失败:', err);
    }

    // 发送桌面通知
    if (Notification.isSupported()) {
      new Notification({
        title: 'RemoteBridge',
        body: `新客户端已连接: ${payload.clientLabel || payload.clientId}`,
      }).show();
    }

    // 通知渲染进程
    mainWindow?.webContents.send('event:client-joined', payload);
  });

  // --- CLIENT_LEFT: 客户端离开 ---
  client.on(WSMessageType.CLIENT_LEFT, (payload: any) => {
    log.debug('客户端离开:', payload);
    mainWindow?.webContents.send('event:client-left', payload);
  });

  // --- MSG_TEXT: 文本消息 ---
  client.on(WSMessageType.MSG_TEXT, (payload: any) => {
    log.debug('收到消息:', payload);

    // 消息持久化：以 Relay 注入的原始消息 id 为主键（INSERT OR IGNORE 去重）
    try {
      db.insertMessage({
        id: payload.messageId || randomUUID(),
        sessionId: payload.sessionId,
        direction: 'client_to_host',
        content: payload.content || '',
        type: 'text',
        senderId: payload.senderId,
        senderLabel: payload.senderLabel,
      });
    } catch (err) {
      log.error('持久化收到的消息失败:', err);
    }

    // 通知渲染进程
    mainWindow?.webContents.send('event:new-message', payload);
  });

  // --- V2 UPLOAD_START: begin streaming upload (P1-01) ---
  client.on(WSMessageType.UPLOAD_START, async (rawPayload: any) => {
    const { uploadId, fileName, mimeType, category, totalSize, clientId, sessionId } = rawPayload || {};

    // Strict validation: totalSize must be a safe integer within allowed range
    if (
      !uploadId ||
      typeof uploadId !== 'string' ||
      !fileName ||
      typeof fileName !== 'string' ||
      !Number.isSafeInteger(totalSize) ||
      totalSize < 0 ||
      totalSize > MAX_FILE_BYTES
    ) {
      client?.send({
        type: WSMessageType.RESP_UPLOAD_ERROR,
        payload: { uploadId, code: 'INVALID_UPLOAD_SIZE', message: '上传文件大小无效或超过允许上限', clientId, sessionId },
      });
      return;
    }

    // SL4: 校验 category 合法性
    const VALID_CATEGORIES: UploadCategory[] = ['images', 'videos', 'documents', 'archives', 'markdown'];
    if (!VALID_CATEGORIES.includes(category)) {
      log.warn('上传：非法分类:', category);
      client?.send({
        type: WSMessageType.RESP_UPLOAD_ERROR,
        payload: { uploadId, code: 'INVALID_CATEGORY', message: `无效的文件分类: ${category}`, clientId, sessionId },
      });
      return;
    }

    // PH1: 并发上传数量检查
    if (uploadTransfers.size >= MAX_CONCURRENT_UPLOADS) {
      log.warn('上传配额已满，拒绝 uploadId:', uploadId);
      client?.send({
        type: WSMessageType.RESP_UPLOAD_ERROR,
        payload: { uploadId, code: 'QUOTA_EXCEEDED', message: '上传配额已满，请稍后重试', clientId, sessionId },
      });
      return;
    }

    // Guard: reject duplicate uploadId
    if (uploadTransfers.has(uploadId)) {
      client?.send({
        type: WSMessageType.RESP_UPLOAD_ERROR,
        payload: { uploadId, code: 'DUPLICATE_UPLOAD_ID', message: '上传任务 ID 已存在', clientId, sessionId },
      });
      return;
    }

    try {
      const tmpDir = await getUploadTempDir();
      const tempPath = path.join(tmpDir, `${uploadId}.part`);

      // Create write stream to temp file
      const writeStream = createWriteStream(tempPath);

      const timer = setTimeout(() => {
        const t = uploadTransfers.get(uploadId);
        if (t && !t.completed) {
          log.warn('文件上传超时，丢弃 uploadId:', uploadId);
          abortUploadTransfer(uploadId, 'TIMEOUT', '上传超时').catch(() => {});
        }
      }, 5 * 60 * 1000);

      uploadTransfers.set(uploadId, {
        tempPath,
        writeStream,
        fileName,
        mimeType,
        category,
        totalSize,
        actualBytes: 0,
        seq: 0,
        clientId,
        sessionId,
        timer,
        completed: false,
      });
    } catch (err: any) {
      log.error('初始化上传失败:', err);
      client?.send({
        type: WSMessageType.RESP_UPLOAD_ERROR,
        payload: { uploadId, code: 'INIT_ERROR', message: err.message || '初始化上传失败', clientId, sessionId },
      });
    }
  });

  // --- V2 UPLOAD_CHUNK (binary frame): write chunk to temp file ---
  client.onBinary(async (data: Buffer) => {
    try {
      const frame = decodeUploadChunkFrame(data);
      const { transferId, seq, eof, data: chunkData } = frame;

      const transfer = uploadTransfers.get(transferId);
      if (!transfer || transfer.completed) {
        // Unknown or completed transfer — discard
        return;
      }

      // SEC: sequence validation — reject out-of-order chunks
      if (seq !== transfer.seq) {
        log.warn(`上传分块乱序: expected ${transfer.seq}, got ${seq},丢弃 uploadId: ${transferId}`);
        return;
      }

      // SEC: per-chunk cap
      if (transfer.actualBytes + chunkData.length > MAX_FILE_BYTES) {
        log.warn(`文件上传超出上限，丢弃 uploadId: ${transferId}`);
        await abortUploadTransfer(transferId, 'QUOTA_EXCEEDED', '文件过大');
        return;
      }

      // Write chunk to temp file with backpressure handling
      await writeUploadChunk(transfer, chunkData);
      transfer.actualBytes += chunkData.length;
      transfer.seq++;

      // PM5: reset timeout on each chunk
      clearTimeout(transfer.timer);
      transfer.timer = setTimeout(() => {
        const t = uploadTransfers.get(transferId);
        if (t && !t.completed) {
          log.warn('文件上传超时，丢弃 uploadId:', transferId);
          abortUploadTransfer(transferId, 'TIMEOUT', '上传超时').catch(() => {});
        }
      }, 5 * 60 * 1000);

      // EOF received — validate size consistency then finalize
      if (eof) {
        if (transfer.actualBytes !== transfer.totalSize) {
          log.warn(`上传大小不匹配: ${transferId}, expected=${transfer.totalSize}, actual=${transfer.actualBytes}`);
          await abortUploadTransfer(transferId, 'SIZE_MISMATCH', '上传文件大小与声明大小不一致');
          return;
        }
        await uploadFinalize(transferId);
      }
    } catch (err: any) {
      log.error('处理上传二进制帧失败:', err);
    }
  });

  // --- V2 UPLOAD_END: finalize streaming upload ---
  client.on(WSMessageType.UPLOAD_END, async (rawPayload: any) => {
    const { uploadId } = rawPayload || {};
    if (!uploadId) return;
    await uploadFinalize(uploadId);
  });

  // --- V2 UPLOAD_CANCEL: cancel streaming upload ---
  client.on(WSMessageType.UPLOAD_CANCEL, async (rawPayload: any) => {
    const { uploadId, reason } = rawPayload || {};
    if (!uploadId) return;
    const transfer = uploadTransfers.get(uploadId);
    if (transfer && !transfer.completed) {
      log.info(`上传已取消: ${uploadId}, reason: ${reason || 'unknown'}`);
      await abortUploadTransfer(uploadId, 'CANCELLED', '上传已取消');
    }
  });

  // --- MSG_SYSTEM: 系统消息 ---
  client.on(WSMessageType.MSG_SYSTEM, (payload: any) => {
    log.debug('系统消息:', payload);
    mainWindow?.webContents.send('event:new-message', {
      ...payload,
      type: 'system',
    });
  });

  // --- SESSION_REVOKED: 会话被吊销 ---
  client.on(WSMessageType.SESSION_REVOKED, (payload: any) => {
    log.debug('会话被吊销:', payload);
    mainWindow?.webContents.send('event:session-revoked', payload);
  });
}

// Test-only: clear all transfer state between tests to prevent cross-test pollution
export function resetUploadTransfersForTests(): void {
  for (const transfer of uploadTransfers.values()) {
    clearTimeout(transfer.timer);
    transfer.writeStream?.destroy();
  }
  uploadTransfers.clear();
}
