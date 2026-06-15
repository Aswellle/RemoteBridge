import { WSMessage, WSMessageType } from '@remotebridge/shared';
import { BrowserWindow, Notification } from 'electron';
import { getRelayClient } from './client';
import { db } from '../db/client';

// ===== 设置消息处理器 =====
export function setupMessageHandlers(mainWindow: BrowserWindow | null): void {
  const client = getRelayClient();
  if (!client) return;

  // --- CLIENT_JOINED: 新客户端加入 ---
  client.on(WSMessageType.CLIENT_JOINED, (payload: any) => {
    console.log('新客户端加入:', payload);

    // 登记到本地 connected_clients 表（"已连接客户端"列表与信任功能的数据源）
    try {
      if (payload.clientId) {
        db.upsertConnectedClient(payload.clientId, payload.clientLabel);
      }
    } catch (err) {
      console.error('登记客户端失败:', err);
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
    console.log('客户端离开:', payload);
    mainWindow?.webContents.send('event:client-left', payload);
  });

  // --- MSG_TEXT: 文本消息 ---
  client.on(WSMessageType.MSG_TEXT, (payload: any) => {
    console.log('收到消息:', payload);

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
      console.error('持久化收到的消息失败:', err);
    }

    // 通知渲染进程
    mainWindow?.webContents.send('event:new-message', payload);
  });

  // --- MSG_SYSTEM: 系统消息 ---
  client.on(WSMessageType.MSG_SYSTEM, (payload: any) => {
    console.log('系统消息:', payload);
    mainWindow?.webContents.send('event:new-message', {
      ...payload,
      type: 'system',
    });
  });

  // --- SESSION_REVOKED: 会话被吊销 ---
  client.on(WSMessageType.SESSION_REVOKED, (payload: any) => {
    console.log('会话被吊销:', payload);
    mainWindow?.webContents.send('event:session-revoked', payload);
  });
}

// ===== 辅助函数 =====
