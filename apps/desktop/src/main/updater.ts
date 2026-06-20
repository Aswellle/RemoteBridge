import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import log from './logger';

// electron-updater 使用与主进程相同的 logger
autoUpdater.logger = log;
autoUpdater.autoDownload = false;         // 发现更新后由用户决定是否下载
autoUpdater.autoInstallOnAppQuit = true;  // 下载完成后退出时自动安装

// ===== 更新状态 =====
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

let currentStatus: UpdateStatus = { state: 'idle' };

function sanitizeUpdaterError(err: Error): string {
  const msg = err.message ?? '';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network/i.test(msg)) return '网络连接失败，请检查网络后重试';
  if (/404/.test(msg)) return '未找到更新资源，请检查发布配置';
  if (/403|401/.test(msg)) return '访问更新服务器被拒绝';
  // 取第一行，最多 80 字符，避免 HTTP 响应体泄露
  const firstLine = msg.split('\n')[0].trim().slice(0, 80);
  return firstLine || '检查更新失败';
}

function broadcast(getWin: () => BrowserWindow | null, status: UpdateStatus): void {
  currentStatus = status;
  getWin()?.webContents.send('event:update-status', status);
}

// ===== 初始化自动更新 =====
export function setupAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  autoUpdater.on('checking-for-update', () => {
    broadcast(getMainWindow, { state: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info(`发现新版本: ${info.version}`);
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note ?? '')).join('\n')
      : (info.releaseNotes as string | null) ?? '';
    broadcast(getMainWindow, { state: 'available', version: info.version, releaseNotes: notes });
  });

  autoUpdater.on('update-not-available', () => {
    broadcast(getMainWindow, { state: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    broadcast(getMainWindow, {
      state: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: Math.round(progress.bytesPerSecond),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info(`更新已下载完成: ${info.version}`);
    broadcast(getMainWindow, { state: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err: Error) => {
    log.error('自动更新错误:', err.message);
    broadcast(getMainWindow, { state: 'error', message: sanitizeUpdaterError(err) });
  });

  // ===== IPC 处理器 =====
  ipcMain.handle('updater:get-status', () => currentStatus);

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err: any) {
      log.error('检查更新失败:', err.message);
      broadcast(getMainWindow, { state: 'error', message: sanitizeUpdaterError(err) });
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err: any) {
      log.error('下载更新失败:', err.message);
      broadcast(getMainWindow, { state: 'error', message: sanitizeUpdaterError(err) });
    }
  });

  ipcMain.handle('updater:install', () => {
    // isSilent=true 静默安装，isForceRunAfter=true 安装后自动重启
    autoUpdater.quitAndInstall(true, true);
  });

  // 启动后延迟 10s 静默检查（仅打包后运行；开发模式跳过以免噪音）
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err: Error) => {
        log.warn('启动时检查更新失败:', err.message);
      });
    }, 10_000);
  }
}
