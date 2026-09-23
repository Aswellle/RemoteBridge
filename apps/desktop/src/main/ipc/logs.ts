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
        // 无 Relay 配置时返回空数据（本地模式）
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
    } catch (err: any) {
      // 区分连接被拒绝 vs 其他错误，给出友好提示
      if (err?.code === 'ECONNREFUSED' || err?.message?.includes('ECONNREFUSED')) {
        return { success: false, error: '无法连接到 Relay 服务器，请先启动本地 Relay 或配置远程服务器' };
      }
      return { success: false, error: err?.message || '获取安全日志失败' };
    }
  });
}
