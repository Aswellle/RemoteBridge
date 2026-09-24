import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import path from 'path';
import { getMainWindow, setAppQuitting } from './window';
import { getRelayClient } from './ws-client/client';

let tray: Tray | null = null;

// ===== 创建托盘图标 =====
// 使用 resources/icon.png 作为托盘图标（比 SVG buffer 更可靠）
function createTrayIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'resources', 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  // 缩放到系统托盘标准尺寸（Windows 16x16，macOS 18x18）
  return image.resize({ width: 16, height: 16 });
}

// ===== 构建右键菜单 =====
function buildContextMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '生成PIN',
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
          win.webContents.send('tray:generate-pin');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 必须传 true：无参调用会把 isQuitting 置为 undefined（falsy），
        // "最小化到托盘"开启时 close 事件会拦截窗口关闭，应用永远退不掉
        setAppQuitting(true);
        app.quit();
      },
    },
  ]);
}

// ===== 初始化托盘 =====
export function initTray(): Tray {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('RemoteBridge Desktop');
  tray.setContextMenu(buildContextMenu());

  // 点击托盘图标显示窗口
  tray.on('click', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isVisible()) {
        win.focus();
      } else {
        win.show();
      }
    }
  });

  return tray;
}

// ===== 更新托盘连接状态 =====
export function updateTrayStatus(status: 'connected' | 'disconnected'): void {
  if (tray && !tray.isDestroyed()) {
    // 仅更新 tooltip，图标保持不变（避免频繁重建图标）
    tray.setToolTip(`RemoteBridge Desktop - ${status === 'connected' ? '已连接' : '未连接'}`);
  }
}

// ===== 获取托盘实例 =====
export function getTray(): Tray | null {
  return tray;
}
