import Store from 'electron-store';
import { Rectangle } from 'electron';

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
}

// ===== 默认值 =====
const defaults: ConfigSchema = {
  hostId: '',
  hostSecret: '',
  hostToken: '',
  // 默认用 127.0.0.1 而非 localhost：Node/Electron 把 localhost 解析为 ::1，
  // 而 relay 默认只监听 IPv4，localhost 会导致首次自动连接 EACCES/ECONNREFUSED
  relayUrl: 'ws://127.0.0.1:3001/ws',
  relayApiUrl: 'http://127.0.0.1:3001/api/v1',
  windowBounds: null,
  autoStart: false,
  minimizeToTray: true,
  theme: 'dark',
};

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
  getHostSecret: (): string => configStore.get('hostSecret', ''),
  setHostSecret: (value: string): void => { configStore.set('hostSecret', value); },

  // Host Token
  getHostToken: (): string => configStore.get('hostToken', ''),
  setHostToken: (value: string): void => { configStore.set('hostToken', value); },

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

  // 批量获取所有配置
  getAll: (): ConfigSchema => configStore.store,

  // 清除所有配置
  clear: (): void => configStore.clear(),
};

export default config;
