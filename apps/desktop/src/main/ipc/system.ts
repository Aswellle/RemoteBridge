/**
 * 系统信息 IPC handler
 *
 * 注册 system:info / system:is-first-launch / system:mark-first-launch-done
 */
import { ipcMain, app } from 'electron';
import os from 'os';
import config from '../config/store';

export function registerSystemHandlers(): void {
  ipcMain.handle('system:info', () => {
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      osVersion: os.version?.() || os.release(),
      uptime: os.uptime(),
      userInfo: os.userInfo?.()?.username || '',
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron || '',
      nodeVersion: process.versions.node || '',
      chromeVersion: process.versions.chrome || '',
    };
  });

  ipcMain.handle('system:is-first-launch', () => {
    return !config.getFirstLaunchDone();
  });

  ipcMain.handle('system:mark-first-launch-done', () => {
    config.setFirstLaunchDone(true);
  });
}
