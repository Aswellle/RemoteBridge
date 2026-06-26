import { contextBridge, ipcRenderer } from 'electron';

// ===== 暴露给渲染进程的 API =====
contextBridge.exposeInMainWorld('electronAPI', {
  // === 系统信息 ===
  getSystemInfo: () => ipcRenderer.invoke('system:info'),

  // === 目录管理 ===
  selectDirectory: () => ipcRenderer.invoke('dirs:select-dialog'),
  addDirectory: (path: string) => ipcRenderer.invoke('dirs:add', path),
  removeDirectory: (id: number) => ipcRenderer.invoke('dirs:remove', id),
  listDirectories: () => ipcRenderer.invoke('dirs:list'),
  updatePermission: (id: number, perm: string) =>
    ipcRenderer.invoke('dirs:update-permission', id, perm),
  saveAlias: (id: number, alias: string) =>
    ipcRenderer.invoke('dirs:save-alias', id, alias),

  // === 认证 ===
  registerHost: () => ipcRenderer.invoke('auth:register-host'),
  disconnectRelay: () => ipcRenderer.invoke('auth:disconnect'),
  getRelayStatus: () => ipcRenderer.invoke('relay:get-status'),
  generatePin: (expiresIn: number) =>
    ipcRenderer.invoke('auth:generate-pin', expiresIn),

  // === Host 信息 ===
  getRelayUrl: () => ipcRenderer.invoke('host:get-relay-url'),

  // === 客户端管理 ===
  listClients: () => ipcRenderer.invoke('clients:list'),
  revokeClient: (sessionId: string) =>
    ipcRenderer.invoke('clients:revoke', sessionId),

  // === 消息发送 ===
  sendMessage: (clientId: string, content: string) =>
    ipcRenderer.invoke('messages:send', clientId, content),

  // === 消息历史 ===
  getMessageHistory: (limit?: number) =>
    ipcRenderer.invoke('messages:get-history', limit),

  // === 访问日志 ===
  getAccessLogs: (limit?: number) =>
    ipcRenderer.invoke('logs:access', limit),

  // === 安全日志（经主进程访问 Relay，支持分页/筛选） ===
  getSecurityLogs: (query?: { page?: number; pageSize?: number; eventType?: string; clientId?: string }) =>
    ipcRenderer.invoke('logs:security', query),

  // === 信任客户端（trusted=false 为取消信任） ===
  trustClient: (clientId: string, trusted: boolean) =>
    ipcRenderer.invoke('clients:trust', clientId, trusted),

  // === 通知 ===
  sendNotification: (title: string, body: string) =>
    ipcRenderer.invoke('notification:send', title, body),

  // === 设置 ===
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: any) => ipcRenderer.invoke('settings:save', settings),

  // === 文件接收路径 ===
  getUploadPaths: () => ipcRenderer.invoke('upload:get-paths'),
  setUploadPaths: (paths: any) => ipcRenderer.invoke('upload:set-paths', paths),

  // === 延迟 ===
  getRelayLatency: () => ipcRenderer.invoke('relay:get-latency'),

  // === 事件订阅 (Main → Renderer) ===
  // 每次订阅前先清除旧监听器，防止 React effect 重跑时监听器堆叠
  onClientJoined: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:client-joined');
    ipcRenderer.on('event:client-joined', (_, data) => callback(data));
  },
  onClientLeft: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:client-left');
    ipcRenderer.on('event:client-left', (_, data) => callback(data));
  },
  onConnectionStatus: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:connection-status');
    ipcRenderer.on('event:connection-status', (_, data) => callback(data));
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

  // === Host token 轮换 ===
  getHostTokenExpiryDays: () => ipcRenderer.invoke('host:get-token-expiry-days'),

  // === 自动更新 ===
  getUpdateStatus: () => ipcRenderer.invoke('updater:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    ipcRenderer.removeAllListeners('event:update-status');
    ipcRenderer.on('event:update-status', (_, status) => callback(status));
  },

  // === 清理事件监听器（SL3：限白名单频道，防止渲染层静默安全通知频道） ===
  removeAllListeners: (channel: string) => {
    const SAFE_CHANNELS = [
      'event:client-joined', 'event:client-left', 'event:connection-status',
      'event:new-message', 'event:session-revoked', 'event:file-received',
      'event:update-status',
    ];
    if (SAFE_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});

// ===== TypeScript 类型声明 =====
export interface SettingsData {
  relayUrl: string;
  relayApiUrl: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  theme: 'light' | 'dark';
}

export interface UploadPaths {
  images: string;
  videos: string;
  documents: string;
  archives: string;
  markdown: string;
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
  registerHost: () => Promise<{ success: boolean; data?: { hostId: string }; error?: string }>;
  disconnectRelay: () => Promise<{ success: boolean }>;
  getRelayStatus: () => Promise<{ connected: boolean }>;
  generatePin: (expiresIn: number) => Promise<{ success: boolean; data?: { pin: string; expiresAt: number }; error?: string }>;
  getRelayUrl: () => Promise<string>;
  listClients: () => Promise<Array<{
    clientId: string;
    /** Relay 不可达（本地回退）时为 null，此时吊销不可用 */
    sessionId: string | null;
    label: string | null;
    lastSeenAt: number;
    online: boolean;
    isTrusted: boolean;
  }>>;
  revokeClient: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  sendMessage: (clientId: string, content: string) => Promise<{ success: boolean; error?: string }>;
  getMessageHistory: (limit?: number) => Promise<any[]>;
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
  trustClient: (clientId: string, trusted: boolean) => Promise<{ success: boolean; error?: string }>;
  sendNotification: (title: string, body: string) => Promise<void>;
  getSettings: () => Promise<SettingsData>;
  saveSettings: (settings: SettingsData) => Promise<{
    success: boolean;
    error?: string;
    /** Relay 地址变更时返回：是否已按新地址重连成功 */
    reconnected?: boolean;
    reconnectError?: string;
  }>;
  getRelayLatency: () => Promise<number>;
  onClientJoined: (callback: (data: any) => void) => void;
  onClientLeft: (callback: (data: any) => void) => void;
  onConnectionStatus: (callback: (data: { status: string; error?: string }) => void) => void;
  onNewMessage: (callback: (data: any) => void) => void;
  onSessionRevoked: (callback: (data: any) => void) => void;
  onFileReceived: (callback: (data: { fileName: string; savedPath: string }) => void) => void;
  getUploadPaths: () => Promise<{ success: boolean; data?: UploadPaths; error?: string }>;
  setUploadPaths: (paths: UploadPaths) => Promise<{ success: boolean; error?: string }>;
  getHostTokenExpiryDays: () => Promise<number | null>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };
