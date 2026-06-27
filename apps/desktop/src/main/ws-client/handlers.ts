import { randomUUID } from 'node:crypto';
import { WSMessageType, FileCategory } from '@remotebridge/shared';
import { BrowserWindow, Notification } from 'electron';
import { getRelayClient } from './client';
import { db } from '../db/client';
import { config, getDefaultUploadPaths } from '../config/store';
import fs from 'fs/promises';
import path from 'path';
import log from '../logger';

// ===== 文件上传分块缓冲区 =====
interface UploadTransfer {
  chunks: (Buffer | undefined)[];
  received: number;
  fileName: string;
  mimeType: string;
  category: FileCategory;
  totalChunks: number;
  totalSize: number;
  actualBytes: number; // SEC-H1: 实际已接收字节数，不信任客户端声明的 totalSize
  clientId?: string;
  sessionId?: string;
  timer: NodeJS.Timeout;
}
const uploadBuffer = new Map<string, UploadTransfer>();

// PH1: 并发上传上限与内存配额
const MAX_CONCURRENT_UPLOADS = 5;
const MAX_TOTAL_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
let totalBufferedBytes = 0;

// SL4: 合法分类枚举
const VALID_CATEGORIES: FileCategory[] = ['images', 'videos', 'documents', 'archives', 'markdown'];

// 上传目录路径不存在时自动创建，并将重名文件改名（追加序号）
// P0-1: 内部强制取 basename，防止 fileName 含 ../ 导致路径穿越
async function getUniqueSavePath(dir: string, fileName: string): Promise<string> {
  const safeName = path.basename(fileName); // strip any directory components
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let candidate = path.join(dir, safeName);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i++;
    } catch {
      // 兜底：确保结果路径在 dir 范围内（双重防御）
      const resolved = path.resolve(candidate);
      const resolvedDir = path.resolve(dir);
      if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
        throw new Error(`路径穿越检测: ${resolved}`);
      }
      return resolved;
    }
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

  // --- CMD_UPLOAD_FILE_CHUNK: Web 端发送文件分块 ---
  client.on(WSMessageType.CMD_UPLOAD_FILE_CHUNK, async (payload: any) => {
    const { uploadId, fileName, mimeType, category, chunkIndex, totalChunks, totalSize, data, clientId, sessionId } = payload;

    if (!uploadId || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number') {
      log.warn('收到无效的文件上传分块消息');
      return;
    }

    // SL4: 校验 category 合法性（拒绝未知分类，防止绕过路径选择逻辑）
    if (!VALID_CATEGORIES.includes(category)) {
      log.warn('文件上传：非法分类:', category);
      client.send({
        type: WSMessageType.RESP_UPLOAD_ERROR,
        payload: { uploadId, code: 'INVALID_CATEGORY', message: `无效的文件分类: ${category}`, clientId, sessionId },
      });
      return;
    }

    // 初始化缓冲区（首个分块到达时）
    if (!uploadBuffer.has(uploadId)) {
      // PH1: 并发上传数量与总内存配额检查
      if (uploadBuffer.size >= MAX_CONCURRENT_UPLOADS || totalBufferedBytes + totalSize > MAX_TOTAL_UPLOAD_BYTES) {
        log.warn('文件上传：配额已满，拒绝 uploadId:', uploadId);
        client.send({
          type: WSMessageType.RESP_UPLOAD_ERROR,
          payload: { uploadId, code: 'QUOTA_EXCEEDED', message: '上传配额已满，请稍后重试', clientId, sessionId },
        });
        return;
      }

      // SEC-H1: 不预先计入 totalSize（攻击者可声明 499MB 但只发 1KB 撑满配额）。
      // 实际字节在每个分块到达时累加到 actualBytes / totalBufferedBytes。

      // PM5: 超时计时器在每个分块到达时重置，支持大文件慢速上传
      const timer = setTimeout(() => {
        const t = uploadBuffer.get(uploadId);
        if (t) {
          log.warn('文件上传超时，丢弃 uploadId:', uploadId);
          totalBufferedBytes -= t.actualBytes;
          uploadBuffer.delete(uploadId);
          client.send({
            type: WSMessageType.RESP_UPLOAD_ERROR,
            payload: { uploadId, code: 'TIMEOUT', message: '上传超时', clientId: t.clientId, sessionId: t.sessionId },
          });
        }
      }, 5 * 60 * 1000);

      uploadBuffer.set(uploadId, {
        chunks: new Array(totalChunks).fill(undefined),
        received: 0,
        fileName,
        mimeType,
        category,
        totalChunks,
        totalSize,
        actualBytes: 0,
        clientId,
        sessionId,
        timer,
      });
    }

    const transfer = uploadBuffer.get(uploadId)!;
    if (!transfer.chunks[chunkIndex]) {
      const chunkBuf = Buffer.from(data, 'base64');
      transfer.chunks[chunkIndex] = chunkBuf;
      transfer.actualBytes += chunkBuf.length; // SEC-H1: 累加实际字节
      totalBufferedBytes += chunkBuf.length;
      transfer.received++;
    }

    // PM5: 每个分块到达后重置超时（已在缓冲区内）
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => {
      const t = uploadBuffer.get(uploadId);
      if (t) {
        log.warn('文件上传超时，丢弃 uploadId:', uploadId);
        totalBufferedBytes -= t.actualBytes;
        uploadBuffer.delete(uploadId);
        client.send({
          type: WSMessageType.RESP_UPLOAD_ERROR,
          payload: { uploadId, code: 'TIMEOUT', message: '上传超时', clientId: t.clientId, sessionId: t.sessionId },
        });
      }
    }, 5 * 60 * 1000);

    // 所有分块已到齐 → 组装并写盘
    if (transfer.received === totalChunks) {
      clearTimeout(transfer.timer);
      totalBufferedBytes -= transfer.actualBytes;
      uploadBuffer.delete(uploadId);

      try {
        const fileBuffer = Buffer.concat(transfer.chunks as Buffer[]);

        // 确定保存目录
        const stored = config.getUploadPaths();
        const paths = stored ?? await getDefaultUploadPaths();
        const saveDir = paths[transfer.category as FileCategory] ?? paths.documents;

        const savePath = await getUniqueSavePath(saveDir, transfer.fileName);
        await fs.writeFile(savePath, fileBuffer);

        log.info(`文件已保存: ${savePath}`);

        // 落本地库：文件接收也要记一条消息，否则重新打开这个会话时文件发送
        // 记录完全消失——此前只有 messages:send / MSG_TEXT 收发会落 local_messages，
        // 文件上传分块只转发、组装、写盘，从未落库。用 uploadId 做主键（同一次
        // 上传的多个分块共享这个 id，INSERT OR IGNORE 天然防重复）。
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

        // 通知 Relay 路由回 Client
        client.send({
          type: WSMessageType.RESP_UPLOAD_ACK,
          payload: {
            uploadId,
            fileName: transfer.fileName,
            savedPath: savePath,
            fileSize: fileBuffer.length,
            clientId: transfer.clientId,
            sessionId: transfer.sessionId,
          },
        });

        // 桌面通知
        if (Notification.isSupported()) {
          new Notification({
            title: 'RemoteBridge - 文件已接收',
            body: `${transfer.fileName} 已保存至 ${savePath}`,
          }).show();
        }

        mainWindow?.webContents.send('event:file-received', {
          fileName: transfer.fileName,
          savedPath: savePath,
        });
      } catch (err: any) {
        log.error('保存上传文件失败:', err);
        const transfer2 = { clientId, sessionId };
        client.send({
          type: WSMessageType.RESP_UPLOAD_ERROR,
          payload: {
            uploadId,
            code: 'SAVE_ERROR',
            message: err.message || '文件保存失败',
            clientId: transfer2.clientId,
            sessionId: transfer2.sessionId,
          },
        });
      }
    }
  });
}

// ===== 辅助函数 =====
