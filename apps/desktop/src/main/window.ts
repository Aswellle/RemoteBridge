import { app, BrowserWindow, Tray } from 'electron';
import path from 'path';
import { config } from './config/store';

// ===== 导出的窗口实例 =====
let mainWindow: BrowserWindow | null = null;
let trayRef: Tray | null = null;

// 用于最小化到托盘的状态标记
let isQuitting = false;
export function setAppQuitting(val: boolean) { isQuitting = val; }
export function getAppQuitting() { return isQuitting; }

// ===== 安全响应头 (P1-11) =====
// 渲染端是本地打包的 React 应用,不需要加载第三方脚本/样式/iframe;
// connect-src 'self' 足够,因为渲染端只通过 IPC 与主进程通信,不直接发起网络请求。
const RENDERER_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
  "frame-src 'none'; base-uri 'none'; form-action 'none'";

// ===== 创建窗口 =====
export function createWindow(): BrowserWindow {
  // 从 config store 恢复窗口位置和大小
  const savedBounds = config.getWindowBounds();

  mainWindow = new BrowserWindow({
    width: savedBounds?.width || 1100,
    height: savedBounds?.height || 750,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 600,
    title: 'RemoteBridge Desktop',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // P1-11: 沙箱化渲染进程。preload 仅使用 contextBridge/ipcRenderer,
      // 在 sandbox 下仍可用。
      sandbox: true,
    },
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;

  // CSP via onHeadersReceived (P1-11): 开发模式下 Vite dev server 需要
  // 'unsafe-eval'(HMR)并放行其自身 origin,生产模式使用更严格的 RENDERER_CSP。
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const csp = devServerUrl
      ? `default-src 'self' 'unsafe-inline' 'unsafe-eval' ${devServerUrl}; ` +
        `connect-src 'self' ${devServerUrl} ws://localhost:* ws://127.0.0.1:*; ` +
        "img-src 'self' data:; object-src 'none'; frame-src 'none'"
      : RENDERER_CSP;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // P1-11: 渲染端不依赖弹出窗口,统一拒绝 window.open()/target=_blank,
  // 避免渗透进来的内容打开任意新窗口。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // P1-11: 导航防护 —— 仅允许跳转到本应用自身的页面(生产为打包的 file://
  // renderer/index.html,开发为 electron-vite 的 dev server),阻止渗透进来的
  // 内容把整个窗口导航到外部地址。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedPrefix = devServerUrl || `file://${path.join(__dirname, '../renderer/index.html')}`;
    if (!url.startsWith(allowedPrefix)) {
      event.preventDefault();
    }
  });

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // 保存窗口位置和大小
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);

  // 最小化时隐藏到托盘（由设置控制）
  mainWindow.on('close', (event) => {
    if (config.getMinimizeToTray() && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ===== 保存窗口边界 =====
function saveWindowBounds(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    config.setWindowBounds(bounds);
  }
}

// ===== 获取窗口实例 =====
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// ===== 设置托盘引用（供窗口管理使用） =====
export function setTrayRef(tray: Tray): void {
  trayRef = tray;
}
