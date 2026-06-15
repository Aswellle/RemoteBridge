import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import { getMainWindow, setAppQuitting } from './window';
import { getRelayClient } from './ws-client/client';

let tray: Tray | null = null;
let connectionStatus: 'connected' | 'disconnected' = 'disconnected';

// ===== 创建托盘图标（程序化生成 16x16 彩色圆圈） =====
function createTrayIcon(status: 'connected' | 'disconnected'): Electron.NativeImage {
  const size = 16;
  const canvas = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="8" cy="8" r="7" fill="${status === 'connected' ? '#22c55e' : '#6b7280'}" stroke="#1f2937" stroke-width="1"/>
    </svg>
  `;
  return nativeImage.createFromBuffer(Buffer.from(canvas), { width: size, height: size });
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
  const icon = createTrayIcon('disconnected');
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
  connectionStatus = status;
  if (tray && !tray.isDestroyed()) {
    const icon = createTrayIcon(status);
    tray.setImage(icon);
    tray.setToolTip(`RemoteBridge Desktop - ${status === 'connected' ? '已连接' : '未连接'}`);
  }
}

// ===== 获取托盘实例 =====
export function getTray(): Tray | null {
  return tray;
}
