import axios from 'axios';
import { ipcMain } from 'electron';
import { JWT_CONFIG } from '@remotebridge/shared';
import { config } from './config/store';
import log from './logger';

const THRESHOLD_DAYS = JWT_CONFIG.HOST_TOKEN_ROTATION_THRESHOLD_DAYS;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每日检查一次

let rotationInterval: NodeJS.Timeout | null = null;

// ===== JWT exp 解码（不验签；只读到期时间，无安全敏感操作） =====
function getExpirySeconds(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export function daysUntilHostTokenExpiry(): number | null {
  const token = config.getHostToken();
  if (!token) return null;
  const exp = getExpirySeconds(token);
  if (exp == null) return null;
  return (exp - Math.floor(Date.now() / 1000)) / 86400;
}

// ===== 向 Relay 请求新 token =====
async function rotateToken(relayApi: string): Promise<boolean> {
  const currentToken = config.getHostToken();
  if (!currentToken) return false;
  try {
    const res = await axios.post(
      `${relayApi}/auth/host-token-refresh`,
      {},
      { headers: { Authorization: `Bearer ${currentToken}` }, timeout: 10_000 },
    );
    const newToken: string | undefined = res.data?.data?.token;
    if (!newToken) {
      log.warn('host-token-refresh: 响应缺少 token 字段');
      return false;
    }
    config.setHostToken(newToken);
    log.info('Host JWT 轮换成功，新 token 已持久化');
    return true;
  } catch (err: any) {
    log.warn('Host JWT 轮换失败:', err.message);
    return false;
  }
}

// ===== 检查并按需轮换 =====
async function checkAndRotate(getRelayApi: () => string): Promise<void> {
  const days = daysUntilHostTokenExpiry();
  if (days == null) return;
  if (days <= THRESHOLD_DAYS) {
    log.info(`Host JWT 剩余 ${days.toFixed(1)} 天，开始主动轮换（阈值 ${THRESHOLD_DAYS} 天）`);
    await rotateToken(getRelayApi());
  }
}

// ===== 初始化轮换调度 =====
export function setupTokenRotator(getRelayApi: () => string): void {
  // IPC：渲染层查询 token 剩余天数（设置页展示用）
  ipcMain.handle('host:get-token-expiry-days', () => daysUntilHostTokenExpiry());

  // 启动 30s 后首次检查（等连接稳定）
  setTimeout(() => {
    checkAndRotate(getRelayApi).catch((err) => log.warn('首次 token 轮换检查失败:', err.message));
  }, 30_000);

  // 每日定时检查
  rotationInterval = setInterval(() => {
    checkAndRotate(getRelayApi).catch((err) => log.warn('定期 token 轮换检查失败:', err.message));
  }, CHECK_INTERVAL_MS);
  rotationInterval.unref?.();
}

export function stopTokenRotator(): void {
  if (rotationInterval) {
    clearInterval(rotationInterval);
    rotationInterval = null;
  }
}
