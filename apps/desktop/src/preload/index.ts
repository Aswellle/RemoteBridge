import { contextBridge, ipcRenderer } from 'electron';

// ===== 暴露给渲染进程的 API =====
contextBridge.exposeInMainWorld('electronAPI', {
  // === 系统信息 ===
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getAppIcon: () => ipcRenderer.invoke('system:icon'),

  // === 目录管理 ===
  selectDirectory: () => ipcRenderer.invoke('dirs:select-dialog'),
  addDirectory: (path: string) => ipcRenderer.invoke('dirs:add', path),
  removeDirectory: (id: number) => ipcRenderer.invoke('dirs:remove', id),
  listDirectories: () => ipcRenderer.invoke('dirs:list'),
  updatePermission: (id: number, perm: string) =>
    ipcRenderer.invoke('dirs:update-permission', id, perm),
  saveAlias: (id: number, alias: string) =>
    ipcRenderer.invoke('dirs:save-alias', id, alias),
  clearAllDirectories: () => ipcRenderer.invoke('dirs:clear-all'),

  // === 首次启动 ===
  isFirstLaunch: () => ipcRenderer.invoke('system:is-first-launch'),
  markFirstLaunchDone: () => ipcRenderer.invoke('system:mark-first-launch-done'),

  // === 认证 ===
  registerHost: () => ipcRenderer.invoke('auth:register-host'),
  disconnectRelay: () => ipcRenderer.invoke('auth:disconnect'),
  getRelayStatus: () => ipcRenderer.invoke('relay:get-status'),
  generatePin: (expiresIn: number) => ipcRenderer.invoke('auth:generate-pin', expiresIn),

  // === 客户端 ===
  listClients: () => ipcRenderer.invoke('clients:list'),
  revokeClient: (sessionId: string, clientId?: string) =>
    ipcRenderer.invoke('clients:revoke', sessionId, clientId),
  trustClient: (clientId: string, trusted: boolean) =>
    ipcRenderer.invoke('clients:trust', clientId, trusted),

  // === 日志 ===
  getAccessLogs: (limit?: number) => ipcRenderer.invoke('logs:access', limit),
  getSecurityLogs: (query?: { page?: number; pageSize?: number; eventType?: string; clientId?: string }) =>
    ipcRenderer.invoke('logs:security', query),

  // === 消息 ===
  getMessageHistory: (limit?: number) => ipcRenderer.invoke('messages:get-history', limit),
  sendMessage: (sessionId: string, content: string) =>
    ipcRenderer.invoke('messages:send', sessionId, content),

  // === 设置 ===
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  getRelayLatency: () => ipcRenderer.invoke("settings:get-relay-latency"),
  // 通道名与主进程 messages.ts 中的 upload:* 处理器一致（未配置时返回平台默认路径）
  getUploadPaths: () => ipcRenderer.invoke('upload:get-paths'),
  setUploadPaths: (paths: unknown) => ipcRenderer.invoke('upload:set-paths', paths),

  // === 本地中继 ===
  localRelayStart: (port?: number) => ipcRenderer.invoke('relay-local:start', port),
  localRelayStop: () => ipcRenderer.invoke('relay-local:stop'),
  localRelayGetState: () => ipcRenderer.invoke('relay-local:get-state'),
  localRelayGetConfig: () => ipcRenderer.invoke('relay-local:get-config'),
  localRelaySetConfig: (cfg: { port?: number; autoStart?: boolean }) =>
    ipcRenderer.invoke('relay-local:set-config', cfg),

  // === 自动更新 ===
  getUpdateStatus: () => ipcRenderer.invoke('updater:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:update-status');
    ipcRenderer.on('event:update-status', (_, status) => callback(status));
  },

  // === 外部链接（系统浏览器打开） ===
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  // === 在系统文件管理器中打开目录 ===
  openPath: (target: string) => ipcRenderer.invoke('shell:open-path', target),

  // === 事件监听（push 通道） ===
  onConnectionStatus: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:connection-status');
    ipcRenderer.on('event:connection-status', (_, data) => callback(data));
  },
  onClientJoined: (callback: () => void) => {
    ipcRenderer.removeAllListeners('event:client-joined');
    ipcRenderer.on('event:client-joined', () => callback());
  },
  onClientLeft: (callback: () => void) => {
    ipcRenderer.removeAllListeners('event:client-left');
    ipcRenderer.on('event:client-left', () => callback());
  },
  onNewMessage: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:new-message');
    ipcRenderer.on('event:new-message', (_, data) => callback(data));
  },
  onSessionRevoked: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:session-revoked');
    ipcRenderer.on('event:session-revoked', (_, data) => callback(data));
  },
  onFileReceived: (callback: (data: { fileName: string; savedPath: string }) => void) => {
    ipcRenderer.removeAllListeners('event:file-received');
    ipcRenderer.on('event:file-received', (_, data) => callback(data));
  },
  onLocalRelayStatus: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:local-relay-status');
    ipcRenderer.on('event:local-relay-status', (_, data) => callback(data));
  },
  onLocalRelayLog: (callback: (line: string) => void) => {
    ipcRenderer.removeAllListeners('event:local-relay-log');
    ipcRenderer.on('event:local-relay-log', (_, line) => callback(line));
  },

  // === 清理事件监听器（SL3：限白名单频道，防止渲染层静默安全通知频道） ===
  removeAllListeners: (channel: string) => {
    const SAFE_CHANNELS = [
      'event:connection-status', 'event:client-joined', 'event:client-left',
      'event:new-message', 'event:session-revoked', 'event:file-received',
      'event:update-status', 'event:local-relay-status', 'event:local-relay-log',
    ];
    if (SAFE_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});

// ===== 类型导出 =====

export interface UploadPaths {
  images: string;
  videos: string;
  documents: string;
  archives: string;
  markdown: string;
}

export interface SettingsData {
  relayUrl: string;
  relayApiUrl: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  theme: 'light' | 'dark';
}

export interface ElectronAPI {
  getSystemInfo: () => Promise<{
    hostname: string;
    platform: string;
    arch: string;
    release: string;
    osVersion: string;
    uptime: number;
    userInfo: string;
    appVersion: string;
    electronVersion: string;
    nodeVersion: string;
    chromeVersion: string;
  }>;
  getAppIcon: () => Promise<string>;
  selectDirectory: () => Promise<string | null>;
  addDirectory: (path: string) => Promise<{ success: boolean; error?: string }>;
  removeDirectory: (id: number) => Promise<{ success: boolean }>;
  listDirectories: () => Promise<Array<{
    id: number;
    path: string;
    label?: string;
    permission: string;
    recursive: boolean;
    is_active: boolean;
  }>>;
  updatePermission: (id: number, perm: string) => Promise<{ success: boolean }>;
  saveAlias: (id: number, alias: string) => Promise<{ success: boolean; error?: string }>;
  clearAllDirectories: () => Promise<{ success: boolean }>;
  isFirstLaunch: () => Promise<boolean>;
  markFirstLaunchDone: () => Promise<void>;
  registerHost: () => Promise<{ success: boolean; data?: { hostId: string }; error?: string }>;
  disconnectRelay: () => Promise<{ success: boolean }>;
  getRelayStatus: () => Promise<{ connected: boolean }>;
  generatePin: (expiresIn: number) => Promise<{ success: boolean; data?: { pin: string; expiresAt: number }; error?: string }>;
  listClients: () => Promise<Array<{
    clientId: string;
    sessionId: string | null;
    label: string | null;
    lastSeenAt: number;
    online: boolean;
    isTrusted: boolean;
  }>>;
  revokeClient: (sessionId: string, clientId?: string) => Promise<{ success: boolean; error?: string }>;
  trustClient: (clientId: string, trusted: boolean) => Promise<{ success: boolean; error?: string }>;
  getAccessLogs: (limit?: number) => Promise<Array<{
    id: number;
    client_id: string;
    action: string;
    path?: string;
    status: string;
    created_at: number;
  }>>;
  getSecurityLogs: (query?: { page?: number; pageSize?: number; eventType?: string; clientId?: string }) => Promise<{
    success: boolean;
    error?: string;
    data?: {
      logs: Array<{
        id: string;
        hostId: string | null;
        clientId: string | null;
        eventType: string;
        detail: string | null;
        ipAddress: string | null;
        createdAt: number;
      }>;
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    };
  }>;
  getMessageHistory: (limit?: number) => Promise<any[]>;
  sendMessage: (sessionId: string, content: string) => Promise<{ success: boolean; error?: string }>;
  getSettings: () => Promise<SettingsData>;
  saveSettings: (settings: SettingsData) => Promise<{
    success: boolean;
    error?: string;
    reconnected?: boolean;
    reconnectError?: string;
  }>;
  getRelayLatency: () => Promise<number>;
  getUploadPaths: () => Promise<{
    success: boolean;
    error?: string;
    data?: { paths: UploadPaths; defaults: UploadPaths };
  }>;
  setUploadPaths: (paths: UploadPaths) => Promise<{ success: boolean; error?: string }>;
  localRelayStart: (port?: number) => Promise<{ success: boolean; error?: string }>;
  localRelayStop: () => Promise<void>;
  localRelayGetState: () => Promise<{ status: string; port: number; pid: number | null; error: string; logs: string[] }>;
  localRelayGetConfig: () => Promise<{ port: number; autoStart: boolean }>;
  localRelaySetConfig: (cfg: { port?: number; autoStart?: boolean }) => Promise<void>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  // 检查/下载失败通过返回值告知调用方（在"关于"页内联展示），不再走全局状态广播
  checkForUpdates: () => Promise<{ success: boolean; status?: UpdateStatus; error?: string }>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => void;
  openExternal: (url: string) => Promise<void>;
  openPath: (target: string) => Promise<{ success: boolean; error?: string }>;
  onConnectionStatus: (callback: (data: { status: string; error?: string }) => void) => void;
  onClientJoined: (callback: (data: any) => void) => void;
  onClientLeft: (callback: (data: any) => void) => void;
  onNewMessage: (callback: (data: any) => void) => void;
  onSessionRevoked: (callback: (data: any) => void) => void;
  onFileReceived: (callback: (data: { fileName: string; savedPath: string }) => void) => void;
  onLocalRelayStatus: (callback: (data: { status: string; error: string }) => void) => void;
  onLocalRelayLog: (callback: (line: string) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'downloading'; version: string; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { state: 'downloaded'; version: string };
