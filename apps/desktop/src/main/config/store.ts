import Store from 'electron-store';
import { Rectangle, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ===== 文件上传保存路径 =====
export interface UploadPaths {
  images: string;
  videos: string;
  documents: string;
  archives: string;
  markdown: string;
}

// ===== 配置 schema =====
interface ConfigSchema {
  hostId: string;
  hostSecret: string;
  hostToken: string;
  relayUrl: string;
  relayApiUrl: string;
  windowBounds: Rectangle | null;
  autoStart: boolean;
  minimizeToTray: boolean;
  theme: 'light' | 'dark';
  uploadPaths: UploadPaths | null;
  localRelayPort: number;
  localRelayAutoStart: boolean;
  localRelayJwtSecret: string;
  localRelayJwtRefreshSecret: string;
}

// ===== 默认值 =====
const defaults: ConfigSchema = {
  hostId: '',
  hostSecret: '',
  hostToken: '',
  // 默认用 127.0.0.1 而非 localhost：Node/Electron 把 localhost 解析为 ::1，
  // 而 relay 默认只监听 IPv4，localhost 会导致首次自动连接 EACCES/ECONNREFUSED
  relayUrl: 'ws://127.0.0.1:3002/ws',
  relayApiUrl: 'http://127.0.0.1:3002/api/v1',
  windowBounds: null,
  autoStart: false,
  minimizeToTray: true,
  theme: 'dark',
  uploadPaths: null,
  localRelayPort: 3002,
  localRelayAutoStart: false,
  localRelayJwtSecret: '',
  localRelayJwtRefreshSecret: '',
};

// ===== safeStorage 加密工具 =====
const ENCRYPTED_PREFIX = 'enc:';

function encryptField(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value);
    return ENCRYPTED_PREFIX + encrypted.toString('base64');
  }
  return value;
}

function decryptField(value: string): string {
  if (value.startsWith(ENCRYPTED_PREFIX)) {
    const buf = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  }
  return value; // 兼容旧版明文或加密不可用时的回退
}

// ===== 创建配置存储实例 =====
const configStore = new Store<ConfigSchema>({
  name: 'remotebridge-config',
  defaults,
});

// ===== 导出配置操作 =====
export const config = {
  // Host ID
  getHostId: (): string => configStore.get('hostId', ''),
  setHostId: (value: string): void => { configStore.set('hostId', value); },

  // Host Secret
  getHostSecret: (): string => decryptField(configStore.get('hostSecret', '')),
  setHostSecret: (value: string): void => { configStore.set('hostSecret', encryptField(value)); },

  // Host Token
  getHostToken: (): string => decryptField(configStore.get('hostToken', '')),
  setHostToken: (value: string): void => { configStore.set('hostToken', encryptField(value)); },

  // Relay URL (WebSocket)
  getRelayUrl: (): string => configStore.get('relayUrl', defaults.relayUrl),
  setRelayUrl: (value: string): void => { configStore.set('relayUrl', value); },

  // Relay API URL
  getRelayApiUrl: (): string => configStore.get('relayApiUrl', defaults.relayApiUrl),
  setRelayApiUrl: (value: string): void => { configStore.set('relayApiUrl', value); },

  // Window Bounds
  getWindowBounds: (): Rectangle | null => configStore.get('windowBounds', null),
  setWindowBounds: (bounds: Rectangle): void => { configStore.set('windowBounds', bounds); },

  // Auto Start
  getAutoStart: (): boolean => configStore.get('autoStart', defaults.autoStart),
  setAutoStart: (value: boolean): void => { configStore.set('autoStart', value); },

  // Minimize to Tray
  getMinimizeToTray: (): boolean => configStore.get('minimizeToTray', defaults.minimizeToTray),
  setMinimizeToTray: (value: boolean): void => { configStore.set('minimizeToTray', value); },

  // Theme
  getTheme: (): 'light' | 'dark' => configStore.get('theme', defaults.theme),
  setTheme: (value: 'light' | 'dark'): void => { configStore.set('theme', value); },

  // Upload Paths
  getUploadPaths: (): UploadPaths | null => (configStore.get('uploadPaths', null) as UploadPaths | null),
  setUploadPaths: (value: UploadPaths): void => { configStore.set('uploadPaths', value); },

  // Local Relay
  getLocalRelayPort: (): number => configStore.get('localRelayPort', defaults.localRelayPort),
  setLocalRelayPort: (value: number): void => { configStore.set('localRelayPort', value); },
  getLocalRelayAutoStart: (): boolean => configStore.get('localRelayAutoStart', defaults.localRelayAutoStart),
  setLocalRelayAutoStart: (value: boolean): void => { configStore.set('localRelayAutoStart', value); },
  getLocalRelayJwtSecret: (): string => decryptField(configStore.get('localRelayJwtSecret', '')),
  setLocalRelayJwtSecret: (value: string): void => { configStore.set('localRelayJwtSecret', encryptField(value)); },
  getLocalRelayJwtRefreshSecret: (): string => decryptField(configStore.get('localRelayJwtRefreshSecret', '')),
  setLocalRelayJwtRefreshSecret: (value: string): void => { configStore.set('localRelayJwtRefreshSecret', encryptField(value)); },

  // 批量获取所有配置
  getAll: (): ConfigSchema => configStore.store,

  // 清除所有配置
  clear: (): void => configStore.clear(),
};

// ===== 默认文件保存路径（Windows: 首个非 C 盘; 其他系统: ~/RemoteBridge-Files） =====
export async function getDefaultUploadPaths(): Promise<UploadPaths> {
  let baseDir: string;

  if (process.platform === 'win32') {
    baseDir = 'C:\\RemoteBridge-Files';
    for (const letter of ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']) {
      try {
        await fs.access(`${letter}:\\`);
        baseDir = `${letter}:\\RemoteBridge-Files`;
        break;
      } catch {
        // drive not found, try next
      }
    }
  } else {
    baseDir = path.join(os.homedir(), 'RemoteBridge-Files');
  }

  return {
    images: path.join(baseDir, 'images'),
    videos: path.join(baseDir, 'videos'),
    documents: path.join(baseDir, 'documents'),
    archives: path.join(baseDir, 'archives'),
    markdown: path.join(baseDir, 'markdown'),
  };
}

export default config;
