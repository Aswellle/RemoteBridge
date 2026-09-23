/**
 * 日志 IPC handler
 *
 * 注册 logs:access / logs:security
 * logs:access: 本地 SQLite access_logs 表
 * logs:security: 走 Relay REST API (/api/v1/security-logs)
 */
import { ipcMain } from 'electron';
import axios from 'axios';
import db from '../db/client';
import { config } from '../config/store';

export function registerLogsHandlers(): void {
  ipcMain.handle('logs:access', (_evt, limit?: number) => {
    return db.getAccessLogs(limit ?? 100);
  });

  ipcMain.handle('logs:security', async (_evt, query?: { page?: number; pageSize?: number; eventType?: string; clientId?: string }) => {
    try {
      const relayApi = config.getRelayApiUrl();
      if (!relayApi) {
        // 无 Relay 时返回空数据（本地模式）
        return { success: true, data: { logs: [], total: 0, page: 1, pageSize: 20, totalPages: 0 } };
      }
      const params: Record<string, string | number> = {
        page: query?.page ?? 1,
        pageSize: query?.pageSize ?? 20,
      };
      if (query?.eventType) params.eventType = query.eventType;
      if (query?.clientId) params.clientId = query.clientId;

      const resp = await axios.get(`${relayApi}/hosts/${config.getHostId()}/security-logs`, { params });
      return { success: true, data: resp.data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
