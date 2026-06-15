import { ipcMain, app, BrowserWindow } from 'electron';
import { config } from '../config/store';
import { getRelayClient } from '../ws-client/client';
import { ensureHostRegisteredAndConnected, cancelAuthRecovery } from './auth';

// ===== 设置接口 =====
interface SettingsData {
  relayUrl: string;
  relayApiUrl: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  theme: 'light' | 'dark';
}

// ===== 注册设置相关 IPC =====
// 保存即生效（热重载）：
// - relayUrl/relayApiUrl 变更 → 断开当前连接，按新地址重走 校验身份→连接 流程；
// - autoStart → 立即写系统登录项；
// - minimizeToTray → window.ts 的 close 处理器每次实时读 config，无需额外动作；
// - theme → 渲染端保存成功后自行切换（见 renderer/theme.ts）。
export function registerSettingsHandlers(
  getMainWindow: () => BrowserWindow | null,
  getRelayApi: () => string,
  getRelayUrl: () => string,
): void {
  ipcMain.handle('settings:get', (): SettingsData => {
    return {
      relayUrl: config.getRelayUrl(),
      relayApiUrl: config.getRelayApiUrl(),
      autoStart: config.getAutoStart(),
      minimizeToTray: config.getMinimizeToTray(),
      theme: config.getTheme(),
    };
  });

  ipcMain.handle('settings:save', async (_, settings: SettingsData) => {
    try {
      const relayUrlChanged =
        settings.relayUrl !== config.getRelayUrl() ||
        settings.relayApiUrl !== config.getRelayApiUrl();

      config.setRelayUrl(settings.relayUrl);
      config.setRelayApiUrl(settings.relayApiUrl);
      config.setAutoStart(settings.autoStart);
      config.setMinimizeToTray(settings.minimizeToTray);
      config.setTheme(settings.theme);

      // 设置开机自启。开发模式下 exe 是 electron.exe，必须带上应用路径参数，
      // 否则登录项只会启动一个空的 Electron
      app.setLoginItemSettings({
        openAtLogin: settings.autoStart,
        path: process.execPath,
        args: app.isPackaged ? [] : [app.getAppPath()],
      });

      // Relay 地址变更 → 热重连
      if (relayUrlChanged) {
        cancelAuthRecovery();
        getRelayClient()?.disconnect();
        const result = await ensureHostRegisteredAndConnected(
          getMainWindow,
          getRelayApi,
          getRelayUrl,
        );
        if (!result.success) {
          return {
            success: true,
            reconnected: false,
            reconnectError: result.error || '无法连接到新的 Relay 服务器',
          };
        }
        return { success: true, reconnected: true };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
