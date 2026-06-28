import { ipcMain } from 'electron';
import axios from 'axios';
import db from '../db/client';
import { config } from '../config/store';

// ===== 客户端列表条目（渲染端消费的合并视图） =====
// relay 提供实时数据（sessionId / online / lastSeenAt），本地 DB 提供信任标记与标签。
// 吊销必须用 sessionId（DELETE /auth/revoke/:sessionId），clientId 无法定位会话。
export interface ClientListEntry {
  clientId: string;
  /** 离线回退（本地列表）时为 null —— 此时无法吊销 */
  sessionId: string | null;
  label: string | null;
  lastSeenAt: number;
  online: boolean;
  isTrusted: boolean;
}

// ===== 注册客户端管理 IPC =====
export function registerClientsHandlers(getRelayApi: () => string): void {
  ipcMain.handle('clients:list', async (): Promise<ClientListEntry[]> => {
    const localById = new Map<string, any>(
      (db.getConnectedClients() as any[]).map((c) => [c.id, c]),
    );

    // 优先取 relay 实时列表（含 sessionId / online）
    try {
      const resp = await axios.get(`${getRelayApi()}/hosts/${config.getHostId()}/clients`, {
        headers: { Authorization: `Bearer ${config.getHostToken()}` },
        timeout: 5000,
      });
      const remote: any[] = resp.data?.data || [];
      return remote.map((r) => ({
        clientId: r.clientId,
        sessionId: r.sessionId || null,
        label: localById.get(r.clientId)?.label || (r.label !== '未知设备' ? r.label : null),
        lastSeenAt: r.lastSeenAt,
        online: !!r.online,
        isTrusted: !!localById.get(r.clientId)?.is_trusted,
      }));
    } catch {
      // relay 不可达 → 回退本地表（无 sessionId，吊销不可用）
      return (db.getConnectedClients() as any[]).map((c) => ({
        clientId: c.id,
        sessionId: null,
        label: c.label || null,
        lastSeenAt: c.last_seen_at,
        online: false,
        isTrusted: !!c.is_trusted,
      }));
    }
  });

  ipcMain.handle('clients:revoke', async (_, sessionId: string, clientId?: string) => {
    if (!sessionId) {
      return { success: false, error: '缺少会话 ID（Relay 不可达时无法吊销）' };
    }
    try {
      await axios.delete(`${getRelayApi()}/auth/revoke/${sessionId}`, {
        headers: {
          Authorization: `Bearer ${config.getHostToken()}`,
        },
      });
      // 吊销成功后清理该客户端的本地消息历史
      if (clientId) {
        try { db.deleteMessagesByClient(clientId); } catch {}
      }
      return { success: true };
    } catch (error: any) {
      const code: string = error?.code ?? '';
      let msg: string;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        msg = '无法连接到中继服务器，吊销操作需要服务器在线';
      } else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
        msg = '连接中继服务器超时，请稍后重试';
      } else {
        msg = error?.response?.data?.error?.message ?? error.message;
      }
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('clients:trust', (_, clientId: string, trusted: boolean) => {
    try {
      db.setClientTrust(clientId, trusted);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
