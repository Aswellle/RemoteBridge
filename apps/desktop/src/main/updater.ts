import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import log from './logger';

// electron-updater 使用与主进程相同的 logger
autoUpdater.logger = log;
autoUpdater.autoDownload = false;         // 发现更新后由用户决定是否下载
autoUpdater.autoInstallOnAppQuit = true;  // 下载完成后退出时自动安装

// ===== 更新状态 =====
// 只包含"用户可见/可操作"的状态：错误不进全局状态（见 setupAutoUpdater 注释），
// 因此在类型层面就不可能出现"错误横幅"。
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'downloading'; version: string; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { state: 'downloaded'; version: string };

let currentStatus: UpdateStatus = { state: 'idle' };
// 最近一次发现的新版本号：下载失败时用它把横幅退回"可下载"状态
let lastAvailableVersion: string | null = null;

/**
 * 将 electron-updater 的原始错误转成用户可读提示。
 *
 * electron-updater 抛出的 message 常含内部细节（GitHub API URL、HTTP 状态行、
 * 响应体片段、`net::ERR_*` 之类的 Chromium 错误码）。这些既无助于用户排查，
 * 也可能泄露内部地址，因此统一按错误类别映射为固定文案，绝不透传原始行。
 */
function sanitizeUpdaterError(err: Error): string {
  const msg = err?.message ?? '';
  const code = (err as NodeJS.ErrnoException)?.code ?? '';

  // DNS / 网络不可达 / 代理 / 连接中断
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg) ||
    /net::ERR_|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_|ERR_PROXY|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_CERT/i.test(msg) ||
    /socket hang up|getaddrinfo|network error|unable to resolve|timed? ?out/i.test(msg) ||
    ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
  ) {
    return '网络连接失败，无法访问更新服务器，请检查网络后重试';
  }
  // 更新服务器拒绝 / 未发布
  if (/\b401\b|\b403\b/i.test(msg) || /unauthorized|forbidden/i.test(msg)) {
    return '更新服务器拒绝了本次请求，请稍后重试';
  }
  if (/\b404\b/i.test(msg) || /not found|no published versions|no releases/i.test(msg)) {
    return '未找到可用的更新发布，请确认发布配置';
  }
  if (/\b5\d\d\b/i.test(msg) || /server error|bad gateway|service unavailable/i.test(msg)) {
    return '更新服务器暂时不可用，请稍后重试';
  }
  // 本地文件/配置问题（如 dev-app-update.yml 缺失、安装包写入失败）
  if (/ENOENT|EACCES|EPERM|EBUSY/i.test(msg) || ['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(code)) {
    return '更新程序读写本地文件失败，请检查文件权限';
  }
  if (/checksum|sha512|signature/i.test(msg) && /invalid|mismatch|fail/i.test(msg)) {
    return '更新包校验失败，请重新下载';
  }
  if (/\bmissing\b|\brequired\b/i.test(msg) && /provider|publish|config|channel/i.test(msg)) {
    return '更新配置不完整，请检查发布配置';
  }
  return '检查更新失败，请稍后重试';
}

function broadcast(getWin: () => BrowserWindow | null, status: UpdateStatus): void {
  currentStatus = status;
  getWin()?.webContents.send('event:update-status', status);
}

// ===== 初始化自动更新 =====
// 状态广播只承载"用户需要看到的结果"：发现新版本 / 下载进度 / 下载完成 / 已是最新。
// 检查与下载的失败不再进入全局状态：历史上一次网络抖动（net::ERR_CONNECTION_CLOSED）
// 会被广播成 error 并长期驻留在顶部横幅，遮挡正常业务操作。失败改为随 IPC 返回值
// 交给调用方（"关于"页内联展示），顶部横幅只用于可升级的提示。
export function setupAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  autoUpdater.on('checking-for-update', () => {
    log.info('正在检查更新…');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info(`发现新版本: ${info.version}`);
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note ?? '')).join('\n')
      : (info.releaseNotes as string | null) ?? '';
    lastAvailableVersion = info.version;
    broadcast(getMainWindow, { state: 'available', version: info.version, releaseNotes: notes });
  });

  autoUpdater.on('update-not-available', () => {
    broadcast(getMainWindow, { state: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    broadcast(getMainWindow, {
      state: 'downloading',
      version: lastAvailableVersion ?? '',
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
    // 仅记录：错误不进入全局状态，避免横幅长期驻留
    log.error('自动更新错误:', err.message);
    // 下载中途失败时把状态退回"可下载"，否则横幅会停在进度条上无法再操作
    if (currentStatus.state === 'downloading') {
      broadcast(
        getMainWindow,
        lastAvailableVersion
          ? { state: 'available', version: lastAvailableVersion, releaseNotes: '' }
          : { state: 'idle' },
      );
    }
  });

  ipcMain.handle('updater:get-status', () => currentStatus);

  // 手动检查：成功返回最终状态（供"关于"页展示有无新版本），失败返回可读错误，
  // 两者都不改变顶部横幅的显示条件
  ipcMain.handle('updater:check', async (): Promise<{ success: boolean; status?: UpdateStatus; error?: string }> => {
    try {
      await autoUpdater.checkForUpdates();
      return { success: true, status: currentStatus };
    } catch (err: any) {
      log.error('检查更新失败:', err.message);
      return { success: false, error: sanitizeUpdaterError(err) };
    }
  });

  ipcMain.handle('updater:download', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err: any) {
      log.error('下载更新失败:', err.message);
      return { success: false, error: sanitizeUpdaterError(err) };
    }
  });

  ipcMain.handle('updater:install', () => {
    // isSilent=true 静默安装，isForceRunAfter=true 安装后自动重启
    autoUpdater.quitAndInstall(true, true);
  });

  // 开发模式也启用更新检测：forceDevUpdateConfig + 指定 config 路径
  try {
    const path = require('path');
    const fs = require('fs');
    // electron-vite 运行时 cwd 可能是项目根；尝试多个候选路径
    const candidates = [
      path.join(process.cwd(), 'dev-app-update.yml'),
      path.join(__dirname, '..', 'dev-app-update.yml'),
      path.join(__dirname, '..', '..', 'dev-app-update.yml'),
    ];
    for (const cfg of candidates) {
      if (fs.existsSync(cfg)) {
        autoUpdater.forceDevUpdateConfig = true;
        autoUpdater.updateConfigPath = cfg;
        log.info('dev update config:', cfg);
        break;
      }
    }
  } catch {}

  // 启动后延迟 10s 静默检查
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      log.warn('启动时检查更新失败:', err.message);
    });
  }, 10_000);
}
