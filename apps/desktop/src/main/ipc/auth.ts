import { ipcMain, BrowserWindow } from 'electron';
import axios from 'axios';
import os from 'os';
import { createRelayClient, getRelayClient } from '../ws-client/client';
import { setupMessageHandlers } from '../ws-client/handlers';
import { setupDirWsHandlers } from '../ws-client/dir-handlers';
import { setupFileTunnelHandler } from '../ws-client/file-tunnel';
import { config } from '../config/store';
import { updateTrayStatus } from '../tray';

// ===== 认证失效自动恢复 =====
// Host token（365d）过期或主机记录在服务端丢失时，WS 会被 4001 拒绝。
// 拿旧 token 盲目重连只会无限 4001 —— 这里延迟后重走完整的
// "校验身份 → 失效则重新注册 → 连接" 流程。固定间隔重试，防止打爆服务端。
const AUTH_RECOVERY_DELAY_MS = 10000;
let authRecoveryTimer: NodeJS.Timeout | null = null;

// 取消排队中的身份恢复（用户主动断开 / 设置变更触发重连时调用，
// 避免旧恢复流程在 10s 后用旧 URL 抢回连接）
export function cancelAuthRecovery(): void {
  if (authRecoveryTimer) {
    clearTimeout(authRecoveryTimer);
    authRecoveryTimer = null;
  }
}

function scheduleAuthRecovery(
  getMainWindow: () => BrowserWindow | null,
  getRelayApi: () => string,
  getRelayUrl: () => string,
): void {
  if (authRecoveryTimer) return; // 已有恢复在排队
  console.log(`Host 认证失败，${AUTH_RECOVERY_DELAY_MS / 1000}s 后重新校验/注册身份`);
  getMainWindow()?.webContents.send('event:connection-status', { status: 'connecting' });
  updateTrayStatus('disconnected');

  authRecoveryTimer = setTimeout(async () => {
    authRecoveryTimer = null;
    const result = await ensureHostRegisteredAndConnected(getMainWindow, getRelayApi, getRelayUrl);
    if (!result.success) {
      console.error('身份恢复失败，继续重试:', result.error);
      scheduleAuthRecovery(getMainWindow, getRelayApi, getRelayUrl);
    }
  }, AUTH_RECOVERY_DELAY_MS);
  authRecoveryTimer.unref?.();
}

// ===== 创建 Relay 客户端并连接 =====
function connectRelay(
  getMainWindow: () => BrowserWindow | null,
  getRelayApi: () => string,
  getRelayUrl: () => string,
  hostId: string,
  hostToken: string,
): Promise<void> {
  const client = createRelayClient({
    relayUrl: getRelayUrl(),
    hostId,
    hostToken,
    onConnect: () => {
      getMainWindow()?.webContents.send('event:connection-status', { status: 'connected' });
      updateTrayStatus('connected');
    },
    onDisconnect: () => {
      getMainWindow()?.webContents.send('event:connection-status', { status: 'disconnected' });
      updateTrayStatus('disconnected');
    },
    onError: (error) => {
      getMainWindow()?.webContents.send('event:connection-status', { status: 'error', error: error.message });
      updateTrayStatus('disconnected');
    },
    onAuthFailure: () => {
      scheduleAuthRecovery(getMainWindow, getRelayApi, getRelayUrl);
    },
  });

  // 设置消息处理器
  setupMessageHandlers(getMainWindow());

  // 设置目录操作处理器
  setupDirWsHandlers(getMainWindow());

  // 设置文件隧道处理器（Relay 代理经 WS 拉取文件）
  setupFileTunnelHandler();

  return client.connect();
}

// ===== 校验已保存的 Host 身份是否仍被 Relay 认可 =====
async function isStoredIdentityValid(relayApi: string, hostId: string, hostToken: string): Promise<boolean> {
  try {
    await axios.get(`${relayApi}/hosts/${hostId}/clients`, {
      headers: { Authorization: `Bearer ${hostToken}` },
      timeout: 5000,
    });
    return true;
  } catch (error: any) {
    const status = error?.response?.status;
    // 401/403 = token 失效或主机记录丢失，需要重新注册；
    // 网络错误等其他情况视为暂时不可用，不丢弃已有身份
    if (status === 401 || status === 403) {
      return false;
    }
    throw error;
  }
}

// ===== 确保 Host 已注册并连接到 Relay =====
// 核心逻辑：优先复用持久化的 hostId/token（保持主机身份唯一、稳定），
// 仅在首次启动或身份失效时才重新注册。
export async function ensureHostRegisteredAndConnected(
  getMainWindow: () => BrowserWindow | null,
  getRelayApi: () => string,
  getRelayUrl: () => string,
): Promise<{ success: boolean; data?: { hostId: string }; error?: string }> {
  try {
    const relayApi = getRelayApi();
    let hostId = config.getHostId();
    let hostToken = config.getHostToken();

    // 1. 已有持久化身份 → 校验并复用
    if (hostId && hostToken) {
      try {
        const valid = await isStoredIdentityValid(relayApi, hostId, hostToken);
        if (!valid) {
          hostId = '';
          hostToken = '';
        }
      } catch (error: any) {
        return { success: false, error: `无法连接 Relay 服务器: ${error.message}` };
      }
    }

    // 2. 无身份或身份失效 → 注册新身份
    if (!hostId || !hostToken) {
      const response = await axios.post(`${relayApi}/auth/register-host`, {
        name: os.hostname(),
        os: os.platform(),
        version: '1.0.0',
      });

      const data = response.data.data;
      hostId = data.hostId;
      hostToken = data.token;

      // 持久化到 config store
      config.setHostId(hostId);
      config.setHostToken(hostToken);
      if (data.secret) {
        config.setHostSecret(data.secret);
      }
    }

    // 3. 连接 Relay
    await connectRelay(getMainWindow, getRelayApi, getRelayUrl, hostId, hostToken);

    return { success: true, data: { hostId } };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ===== 注册认证相关 IPC =====
export function registerAuthHandlers(
  getMainWindow: () => BrowserWindow | null,
  getRelayApi: () => string,
  getRelayUrl: () => string,
): void {
  ipcMain.handle('auth:register-host', async () => {
    return ensureHostRegisteredAndConnected(getMainWindow, getRelayApi, getRelayUrl);
  });

  ipcMain.handle('auth:disconnect', async () => {
    // 用户主动断开：取消排队中的身份恢复，避免 10s 后违背用户意愿自动重连
    cancelAuthRecovery();
    const client = getRelayClient();
    if (client) {
      client.disconnect();
    }
    getMainWindow()?.webContents.send('event:connection-status', { status: 'disconnected' });
    updateTrayStatus('disconnected');
    return { success: true };
  });

  ipcMain.handle('relay:get-status', () => {
    const client = getRelayClient();
    return { connected: !!client?.isConnected() };
  });

  ipcMain.handle('auth:generate-pin', async (_, expiresIn: number) => {
    try {
      const client = getRelayClient();
      if (!client || !client.isConnected()) {
        return { success: false, error: '未连接到 Relay 服务器' };
      }

      const response = await axios.post(`${getRelayApi()}/auth/generate-pin`, {
        expiresIn,
      }, {
        headers: {
          Authorization: `Bearer ${config.getHostToken()}`,
        },
      });

      return { success: true, data: response.data.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
