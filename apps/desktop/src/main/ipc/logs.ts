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
import { getRelayClient } from '../ws-client/client';
import log from '../logger';

/** 安全日志分页查询参数 */
interface SecurityLogsQuery {
  page?: number;
  pageSize?: number;
  eventType?: string;
  clientId?: string;
}

/**
 * 读取 Host token。
 * config.getHostToken() 内部走 safeStorage 解密，系统密钥链不可用时会抛错；
 * 此处降级到内存中的 Relay 客户端配置，避免整个请求因解密失败而中断。
 */
function readHostToken(): string {
  try {
    const fromStore = config.getHostToken();
    if (fromStore) return fromStore;
  } catch (err: any) {
    log.warn('读取本地 Host token 失败（safeStorage 解密异常）:', err?.message ?? err);
  }
  try {
    return getRelayClient()?.getConfig().hostToken ?? '';
  } catch {
    return '';
  }
}

/** 向 Relay 换取新的 Host token（Host token 剩余有效期不足时使用） */
async function renewHostToken(relayApi: string, currentToken: string): Promise<string> {
  const resp = await axios.post(
    `${relayApi}/auth/host-token-refresh`,
    {},
    { headers: { Authorization: `Bearer ${currentToken}` }, timeout: 10_000 },
  );
  const next: string | undefined = resp.data?.data?.token;
  if (!next) throw new Error('刷新令牌响应缺少 token');
  config.setHostToken(next);
  return next;
}

/** 将 Relay 错误翻译为用户可读提示，不暴露 axios/HTTP 内部细节 */
function toFriendlyError(err: any): string {
  if (err?.code === 'ECONNREFUSED' || err?.message?.includes('ECONNREFUSED')) {
    return '无法连接到中继服务器，请先启动本地中继或检查连接设置';
  }
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
    return '无法解析中继服务器地址，请检查连接设置中的服务器地址';
  }
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNABORTED') {
    return '连接中继服务器超时，请检查网络或服务器状态';
  }
  const status = err?.response?.status;
  if (status === 401) {
    return '主机身份凭证无效或已过期，请重新连接中继服务器';
  }
  if (status === 403) {
    return '当前主机无权访问该中继上的安全日志';
  }
  if (status === 404) {
    return '中继服务器未提供安全日志接口，请确认服务端版本';
  }
  if (typeof status === 'number' && status >= 500) {
    return '中继服务器内部错误，请稍后重试';
  }
  return '获取安全日志失败，请稍后重试';
}

export function registerLogsHandlers(): void {
  ipcMain.handle('logs:access', (_evt, limit?: number) => {
    return db.getAccessLogs(limit ?? 100);
  });

  ipcMain.handle('logs:security', async (_evt, query?: SecurityLogsQuery) => {
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

      const token = readHostToken();
      if (!token) {
        return { success: false, error: '尚未建立主机身份，请先连接中继服务器' };
      }

      const request = (t: string) =>
        axios.get(`${relayApi}/security-logs`, {
          params,
          headers: { Authorization: `Bearer ${t}` },
          timeout: 15_000,
        });

      try {
        const resp = await request(token);
        return { success: true, data: resp.data };
      } catch (err: any) {
        // 401 多为 Host token 过期：轮换后重试一次，避免用户看到无意义的失败
        if (err?.response?.status !== 401) throw err;
        const renewed = await renewHostToken(relayApi, token);
        const resp = await request(renewed);
        return { success: true, data: resp.data };
      }
    } catch (err: any) {
      log.warn('获取安全日志失败:', err?.message ?? err);
      return { success: false, error: toFriendlyError(err) };
    }
  });
}
