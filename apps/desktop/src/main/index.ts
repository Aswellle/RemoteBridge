// 必须最先加载 — 为 Electron 拦截 better-sqlite3 的 native 模块路径
import './electron-binding';

import { app, BrowserWindow, ipcMain, Notification, Menu } from 'electron';
import * as nodeOs from 'os';
import { createWindow, getMainWindow, setAppQuitting } from './window';
import { initTray, updateTrayStatus } from './tray';
import { getRelayClient } from './ws-client/client';
import { startFileServer, stopFileServer, isFileServerRunning } from './file-server/server';
import { cleanExpiredTokens } from './file-server/token-manager';
import { config } from './config/store';
import db, { initDatabase } from './db/client';
import axios from 'axios';
import log from './logger';

// IPC 模块
import { setupAutoUpdater } from './updater';
import { setupTokenRotator, stopTokenRotator } from './token-rotator';
import { registerAuthHandlers, ensureHostRegisteredAndConnected } from './ipc/auth';
import { registerDirsHandlers } from './ipc/dirs';
import { registerClientsHandlers } from './ipc/clients';
import { registerMessagesHandlers } from './ipc/messages';
import { registerSettingsHandlers } from './ipc/settings';
import { registerLocalRelayHandlers, stopLocalRelay, startLocalRelay, onRelayReady } from './local-relay';

// ===== Relay 配置（从 config store 加载） =====
function getRelayUrl(): string {
  return config.getRelayUrl() || process.env.RELAY_URL || 'ws://127.0.0.1:3002/ws';
}

function getRelayApi(): string {
  return config.getRelayApiUrl() || process.env.RELAY_API || 'http://127.0.0.1:3002/api/v1';
}

// ===== 应用生命周期 =====
app.whenReady().then(async () => {
  // 移除 Electron 默认菜单栏（File/Edit/View/Window/Help），由应用内设置页替代
  Menu.setApplicationMenu(null);

  // 初始化本地数据库表结构（显式调用，而非随 db/client 模块加载自动执行）
  initDatabase();

  createWindow();

  // 初始化系统托盘
  initTray();

  // 启动本地文件服务器
  const filePort = await startFileServer();
  log.info(`文件服务器端口: ${filePort}`);

  // 定期清理过期下载令牌，防止 download_tokens 表无限增长
  const tokenCleaner = setInterval(() => {
    cleanExpiredTokens();
  }, 60 * 60 * 1000);
  tokenCleaner.unref?.();

  // 初始化自动更新（注册 updater IPC + 延迟静默检查）
  setupAutoUpdater(getMainWindow);

  // 初始化 Host JWT 定期轮换（注册 IPC + 启动后 30s 首次检查 + 每日检查）
  setupTokenRotator(() => getRelayApi());

  // 本地 Relay 就绪后自动重连（解决 autoStart / 首次启动时 Relay 尚未就绪的竞态）
  onRelayReady(() => {
    ensureHostRegisteredAndConnected(() => getMainWindow(), () => getRelayApi(), () => getRelayUrl())
      .catch((err) => log.error('autoConnect after relayReady failed:', err));
  });

  // 注册所有 IPC 处理器
  registerIpcHandlers();

  // 首次启动或版本升级（且 autoStart 未开）：自动运行本地中继，确保用户能看到引导流程
  const _currentVer = app.getVersion();
  if (!config.getFirstLaunchDone() ||
      (!config.getLocalRelayAutoStart() && config.getLastLaunchVersion() !== _currentVer)) {
    startLocalRelay(config.getLocalRelayPort());
  }

  // 启动时自动注册/连接 Relay（复用持久化身份；失败不阻塞启动，UI 可手动重试）
  ensureHostRegisteredAndConnected(() => getMainWindow(), () => getRelayApi(), () => getRelayUrl())
    .then((result) => {
      if (result?.success) {
        log.info('已连接到 Relay:', result.data?.hostId);
      }
    })
    .catch((err) => log.error('自动连接 Relay 异常:', err));

  app.on('activate', async () => {
    // macOS: 重启文件服务器（如果已停止）
    if (!isFileServerRunning()) {
      const filePort = await startFileServer();
      log.info(`文件服务器已重启，端口: ${filePort}`);
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  setAppQuitting(true);
});

app.on('window-all-closed', async () => {
  stopTokenRotator();
  stopLocalRelay();
  await stopFileServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ===== IPC 处理器注册 =====
function registerIpcHandlers(): void {
  registerAuthHandlers(getMainWindow, getRelayApi, getRelayUrl);
  registerDirsHandlers(getMainWindow);
  registerClientsHandlers(getRelayApi);
  registerMessagesHandlers();
  registerSettingsHandlers(getMainWindow, getRelayApi, getRelayUrl);
  registerLocalRelayHandlers(getMainWindow);
}
