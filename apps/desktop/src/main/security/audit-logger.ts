import axios from 'axios';
import db from '../db/client';
import { config } from '../config/store';
import log from '../logger';

// ===== 获取 Relay API 配置 =====
function getRelayApi(): string {
  return config.getRelayApiUrl() || 'http://127.0.0.1:3002/api/v1';
}

function getHostToken(): string {
  return config.getHostToken();
}

// ===== 访问日志（本地 + Relay） =====
export async function logAccess(event: {
  clientId: string;
  action: string;
  path?: string;
  status: string;
}): Promise<void> {
  // 1. 写入本地数据库
  try {
    db.insertAccessLog(event);
  } catch (err) {
    log.error('[AuditLogger] 写入本地访问日志失败:', err);
  }

  // 2. 发送到 Relay 服务器
  try {
    const token = getHostToken();
    if (token) {
      await axios.post(`${getRelayApi()}/security-logs`, {
        eventType: 'ACCESS',
        clientId: event.clientId,
        action: event.action,
        path: event.path,
        status: event.status,
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
    }
  } catch (err) {
    // 静默失败 — 不影响主流程
    log.warn('[AuditLogger] 发送访问日志到 Relay 失败:', (err as Error).message);
  }
}

// ===== 安全日志（仅发送到 Relay） =====
export async function logSecurity(event: {
  eventType: string;
  clientId?: string;
  detail?: string;
  ipAddress?: string;
}): Promise<void> {
  try {
    const token = getHostToken();
    if (token) {
      await axios.post(`${getRelayApi()}/security-logs`, {
        eventType: event.eventType,
        clientId: event.clientId,
        detail: event.detail,
        ipAddress: event.ipAddress,
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
    }
  } catch (err) {
    log.warn('[AuditLogger] 发送安全日志到 Relay 失败:', (err as Error).message);
  }
}
