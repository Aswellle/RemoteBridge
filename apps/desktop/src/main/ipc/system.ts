/**
 * 系统信息 IPC handler
 *
 * 注册 system:info / system:is-first-launch / system:mark-first-launch-done
 * 新增 system:icon（应用图标 base64）/ shell:open-external（外部浏览器打开链接）
 */
import { ipcMain, app, shell } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
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

  // 获取应用图标（base64 data URL）
  ipcMain.handle('system:icon', () => {
    try {
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(app.getAppPath(), 'resources', 'icon.png');
      const buffer = fs.readFileSync(iconPath);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
      return '';
    }
  });

  // 在系统浏览器中打开外部链接
  ipcMain.handle('shell:open-external', (_evt, url: string) => {
    shell.openExternal(url).catch(() => {});
  });
}
