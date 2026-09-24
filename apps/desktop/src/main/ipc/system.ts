/**
 * 系统信息 IPC handler
 *
 * 注册 system:info / system:is-first-launch / system:mark-first-launch-done
 * / system:icon（应用图标 base64）/ shell:open-external（外部浏览器打开链接）
 * / shell:open-path（在系统文件管理器中打开目录）
 */
import { ipcMain, app, shell, nativeImage } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
import config from '../config/store';
import log from '../logger';

let cachedIconDataUrl: string | null = null;

// UI 中图标最大显示尺寸为 56px（size-14）；留出高分屏余量即可，
// 避免每次进入"关于"页都把原图（1254×1254）base64 后的 1MB 字符串经 IPC 传输。
const ICON_DISPLAY_SIZE = 96;

function readAppIcon(): string {
  if (cachedIconDataUrl !== null) return cachedIconDataUrl;
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'resources', 'icon.png');
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      cachedIconDataUrl = '';
      return cachedIconDataUrl;
    }
    const resized = image.resize({
      width: ICON_DISPLAY_SIZE,
      height: ICON_DISPLAY_SIZE,
      quality: 'best',
    });
    cachedIconDataUrl = `data:image/png;base64,${resized.toPNG().toString('base64')}`;
  } catch (err: any) {
    log.warn('读取应用图标失败:', err?.message ?? err);
    cachedIconDataUrl = '';
  }
  return cachedIconDataUrl;
}

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

  // 获取应用图标（base64 data URL）：读取一次后缓存，重复调用零成本
  ipcMain.handle('system:icon', () => readAppIcon());

  // 在系统浏览器中打开外部链接
  ipcMain.handle('shell:open-external', (_evt, url: string) => {
    shell.openExternal(url).catch(() => {});
  });

  // 在系统文件管理器中打开目录（接收文件的保存路径）
  // 目录可能尚未创建（用户尚未接收过该类型文件），先确保存在再打开，
  // 否则 shell.openPath 会静默失败。
  ipcMain.handle('shell:open-path', async (_evt, target: string) => {
    if (typeof target !== 'string' || !target.trim()) {
      return { success: false, error: '路径为空' };
    }
    try {
      await fs.promises.mkdir(target, { recursive: true });
    } catch (err: any) {
      log.warn('创建目录失败:', err?.message ?? err);
      return { success: false, error: '无法创建目录，请检查路径是否有效' };
    }
    const result = await shell.openPath(target);
    // openPath 以空字符串表示成功
    return result ? { success: false, error: '无法打开该目录' } : { success: true };
  });
}
