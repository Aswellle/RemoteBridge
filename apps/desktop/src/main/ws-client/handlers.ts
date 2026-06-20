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
  clientId?: string;
  sessionId?: string;
  timer: NodeJS.Timeout;
}
const uploadBuffer = new Map<string, UploadTransfer>();

// 上传目录路径不存在时自动创建，并将重名文件改名（追加序号）
async function getUniqueSavePath(dir: string, fileName: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i++;
    } catch {
      return candidate;
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
      const { nanoid } = require('nanoid');
      db.insertMessage({
        id: payload.messageId || nanoid(),
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

    // 初始化缓冲区（首个分块到达时）
    if (!uploadBuffer.has(uploadId)) {
      // 5 分钟超时自动清理未完成的传输
      const timer = setTimeout(() => {
        if (uploadBuffer.has(uploadId)) {
          log.warn('文件上传超时，丢弃 uploadId:', uploadId);
          uploadBuffer.delete(uploadId);
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
        clientId,
        sessionId,
        timer,
      });
    }

    const transfer = uploadBuffer.get(uploadId)!;
    if (!transfer.chunks[chunkIndex]) {
      transfer.chunks[chunkIndex] = Buffer.from(data, 'base64');
      transfer.received++;
    }

    // 所有分块已到齐 → 组装并写盘
    if (transfer.received === totalChunks) {
      clearTimeout(transfer.timer);
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
