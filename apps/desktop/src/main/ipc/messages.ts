import { ipcMain } from 'electron';
import os from 'os';
import { nanoid } from 'nanoid';
import { getRelayClient } from '../ws-client/client';
import db from '../db/client';
import log from '../logger';

// ===== 注册消息相关 IPC =====
export function registerMessagesHandlers(): void {
  ipcMain.handle('messages:send', async (_, clientId: string, content: string) => {
    try {
      const client = getRelayClient();
      if (!client || !client.isConnected()) {
        return { success: false, error: '未连接到 Relay 服务器' };
      }

      const { WSMessageType } = require('@remotebridge/shared');

      // id 在这里显式生成：线上消息、本地持久化、对端持久化共用同一个 id，
      // 三方才能按 id 去重（Relay 会把它作为 messageId 注入 payload）
      const messageId = nanoid();

      client.send({
        id: messageId,
        type: WSMessageType.MSG_TEXT,
        payload: {
          content,
          clientId,
          senderLabel: os.hostname(),
        },
      });

      // 发出的消息同样落本地库——此前只发不存，
      // 重启后历史里只剩收到的消息，自己说过什么全丢了
      try {
        db.insertMessage({
          id: messageId,
          direction: 'host_to_client',
          content,
          type: 'text',
          // 落库时记录目标客户端 id，消息中心才能按会话过滤出"自己发过的消息"
          senderId: clientId,
          senderLabel: os.hostname(),
        });
      } catch (err) {
        log.error('持久化发出的消息失败:', err);
      }

      return { success: true, data: { messageId } };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('messages:get-history', (_, limit?: number) => {
    try {
      return db.getMessages(limit || 200);
    } catch (error: any) {
      log.error('获取消息历史失败:', error);
      return [];
    }
  });
}
