import { create } from 'zustand';
import { WSMessage, WSMessageType, FileEntry, HostInfo, AllowedDirectory } from '@remotebridge/shared';
import api from '@/lib/api';
import { logger } from '@/lib/logger';

// ===== Host history entry =====
interface HostHistoryEntry {
  hostId: string;
  name: string;
  os: string;
  lastConnected: number;
}

// ===== Host history helpers =====
function getHostHistory(): HostHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem('host-history');
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveHostHistory(entry: HostHistoryEntry): void {
  if (typeof window === 'undefined') return;
  try {
    const history = getHostHistory();
    // Deduplicate by hostId
    const filtered = history.filter(h => h.hostId !== entry.hostId);
    const updated = [entry, ...filtered].slice(0, 10);
    localStorage.setItem('host-history', JSON.stringify(updated));
  } catch {}
}

// ===== Toast helper (lazy import to avoid SSR issues) =====
let toastRef: { error: (msg: string, opts?: { description?: string }) => void } | null = null;

function showErrorToast(message: string, description?: string) {
  if (typeof window === 'undefined') return;
  if (!toastRef) {
    import('sonner').then((mod) => {
      toastRef = mod.toast;
      mod.toast.error(message, description ? { description } : undefined);
    }).catch(() => {});
  } else {
    toastRef.error(message, description ? { description } : undefined);
  }
}

// ===== 设备级持久 clientId =====
// clientId 标识"这台设备"，必须跨会话稳定 —— 每次连接随机生成会导致
// Host 端的"信任客户端"永远无法命中同一设备
function getOrCreateClientId(): string {
  if (typeof window === 'undefined') return crypto.randomUUID();
  try {
    let id = localStorage.getItem('clientId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('clientId', id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// ===== 从 localStorage 恢复会话（刷新页面后会话不丢失） =====
function loadPersistedSession(): {
  sessionId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  hostInfo: HostInfo | null;
} {
  if (typeof window === 'undefined') {
    return { sessionId: null, accessToken: null, refreshToken: null, hostInfo: null };
  }
  try {
    return {
      sessionId: localStorage.getItem('sessionId'),
      accessToken: localStorage.getItem('accessToken'),
      refreshToken: localStorage.getItem('refreshToken'),
      hostInfo: JSON.parse(localStorage.getItem('hostInfo') || 'null'),
    };
  } catch {
    return { sessionId: null, accessToken: null, refreshToken: null, hostInfo: null };
  }
}

// ===== 应用状态接口 =====
interface AppState {
  // 连接状态
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  hostInfo: HostInfo | null;
  sessionId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  wsInstance: WebSocket | null;

  // 文件系统
  currentPath: string | null;
  dirEntries: FileEntry[];
  allowedDirs: AllowedDirectory[];
  isLoadingDir: boolean;

  // 消息
  messages: Array<{
    id: string;
    content: string;
    direction: 'host_to_client' | 'client_to_host';
    type: 'text' | 'system' | 'notification';
    timestamp: number;
  }>;
  unreadCount: number;

  // 下载
  activeDownloads: Array<{
    id: string;            // requestId，下载响应按它路由回来
    fileName: string;
    filePath: string;      // Host 上的原始路径（代理 URL 构造 / 重新预览都要用）
    fileSize: number;
    progress: number;
    status: 'pending' | 'downloading' | 'completed' | 'error';
    error?: string;
    downloadUrl?: string;
    speed?: number;        // bytes/s，由 download-manager 流式下载时实测
    eta?: number;          // 剩余秒数
    startedAt: number;
  }>;

  // Actions
  setConnectionStatus: (status: AppState['connectionStatus']) => void;
  setHostInfo: (info: HostInfo | null) => void;
  setSession: (sessionId: string, accessToken: string, refreshToken: string) => void;
  clearSession: () => void;
  setWsInstance: (ws: WebSocket | null) => void;
  setCurrentPath: (path: string | null) => void;
  setDirEntries: (entries: FileEntry[]) => void;
  setAllowedDirs: (dirs: AllowedDirectory[]) => void;
  setIsLoadingDir: (loading: boolean) => void;
  addMessage: (message: AppState['messages'][0]) => void;
  markMessagesRead: () => void;
  addDownload: (download: AppState['activeDownloads'][0]) => void;
  updateDownload: (id: string, updates: Partial<AppState['activeDownloads'][0]>) => void;
  clearCompletedDownloads: () => void;
  sendMessage: (content: string) => void;
  connect: (pin: string, clientLabel: string) => Promise<void>;
  disconnect: () => void;
  listAllowed: () => void;
  listDir: (path: string) => void;
  requestDownload: (filePath: string) => void;
  requestPreview: (filePath: string) => void;
  loadMessageHistory: (sessionId: string, page?: number) => Promise<void>;
}

// ===== 创建 Store =====
export const useAppStore = create<AppState>((set, get) => ({
  // 初始状态（会话信息从 localStorage 恢复，刷新后无需重新输 PIN）
  connectionStatus: 'disconnected',
  ...loadPersistedSession(),
  wsInstance: null,
  currentPath: null,
  dirEntries: [],
  allowedDirs: [],
  isLoadingDir: false,
  messages: [],
  unreadCount: 0,
  activeDownloads: [],

  // 设置连接状态
  setConnectionStatus: (status) => set({ connectionStatus: status }),

  // 设置主机信息
  setHostInfo: (info) => set({ hostInfo: info }),

  // 设置会话
  setSession: (sessionId, accessToken, refreshToken) => {
    // 保存到 localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem('sessionId', sessionId);
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
    }
    set({ sessionId, accessToken, refreshToken });
  },

  // 清除会话
  clearSession: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('sessionId');
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('hostInfo');
    }
    set({
      sessionId: null,
      accessToken: null,
      refreshToken: null,
      hostInfo: null,
      connectionStatus: 'disconnected',
    });
  },

  // 设置 WebSocket 实例
  setWsInstance: (ws) => set({ wsInstance: ws }),

  // 设置当前路径
  setCurrentPath: (path) => set({ currentPath: path }),

  // 设置目录条目
  setDirEntries: (entries) => set({ dirEntries: entries }),

  // 设置允许目录
  setAllowedDirs: (dirs) => set({ allowedDirs: dirs }),

  // 设置加载状态
  setIsLoadingDir: (loading) => set({ isLoadingDir: loading }),

  // 添加消息（未读数只统计主机来向的消息——自己发的不算"未读"）
  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message].slice(-500), // keep most recent 500
      unreadCount: message.direction === 'host_to_client'
        ? state.unreadCount + 1
        : state.unreadCount,
    })),

  // 标记消息已读
  markMessagesRead: () => set({ unreadCount: 0 }),

  // 添加下载
  addDownload: (download) =>
    set((state) => ({
      activeDownloads: [...state.activeDownloads, download],
    })),

  // 更新下载状态
  updateDownload: (id, updates) =>
    set((state) => ({
      activeDownloads: state.activeDownloads.map((d) =>
        d.id === id ? { ...d, ...updates } : d
      ),
    })),

  // 清空已完成的下载
  clearCompletedDownloads: () =>
    set((state) => ({
      activeDownloads: state.activeDownloads.filter((d) => d.status !== 'completed'),
    })),

  // 发送消息
  sendMessage: (content) => {
    const { wsInstance, sessionId } = get();
    if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;

    const message: WSMessage = {
      id: crypto.randomUUID(),
      type: WSMessageType.MSG_TEXT,
      payload: { content },
      timestamp: Date.now(),
      sessionId: sessionId || undefined,
    };

    wsInstance.send(JSON.stringify(message));

    // 添加到本地消息列表
    get().addMessage({
      id: message.id,
      content,
      direction: 'client_to_host',
      type: 'text',
      timestamp: message.timestamp,
    });
  },

  // 连接到远程主机
  connect: async (pin, clientLabel) => {
    set({ connectionStatus: 'connecting' });

    try {
      // 1. 调用 REST API 连接（clientId 设备级持久，跨会话稳定）
      const response = await api.post('/auth/connect', {
        pin: pin.replace(/-/g, '').toUpperCase(),
        clientId: getOrCreateClientId(),
        clientLabel,
      });

      const { sessionId, accessToken, refreshToken, hostInfo } = response.data.data;

      // 2. 保存会话信息。
      // 状态保持 connecting：REST 认证成功只代表拿到了会话，
      // 'connected' 由 WS 真正建立时（useWebSocket onopen）置位——
      // 否则文件/消息页会在 WS 就绪前误判为可操作
      get().setSession(sessionId, accessToken, refreshToken);
      set({ hostInfo });

      // 3. 保存 hostInfo
      // 已知限制（01a-L9）：localStorage 在同源所有标签页间共享且无 cross-tab 同步——
      // 若用户同时在多个标签页连接到不同 Host，最后一次 connect 会覆盖这里的快照，
      // 但各标签页自身的 Zustand 内存状态不受影响，仍指向各自连接的 Host。
      // 单实例 Relay 场景下极少出现，severity 已评估为低，此处仅作说明。
      if (typeof window !== 'undefined') {
        localStorage.setItem('hostInfo', JSON.stringify(hostInfo));
      }

      // 4. Save to host connection history
      if (hostInfo) {
        saveHostHistory({
          hostId: hostInfo.hostId,
          name: hostInfo.name || clientLabel,
          os: hostInfo.os || '',
          lastConnected: Date.now(),
        });
      }
    } catch (err: any) {
      logger.error('连接失败:', err);
      set({ connectionStatus: 'error' });
      showErrorToast('连接失败', err?.response?.data?.error?.message || err?.message || '请检查连接码是否正确');
      throw err;
    }
  },

  // 断开连接
  disconnect: () => {
    const { wsInstance } = get();
    if (wsInstance) {
      wsInstance.close();
    }
    get().clearSession();
    set({
      dirEntries: [],
      messages: [],
      activeDownloads: [],
    });
  },

  // 列出共享目录白名单（文件浏览入口 —— Client 不知道 Host 上哪些目录被共享）
  listAllowed: () => {
    const { wsInstance, sessionId } = get();
    if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;

    set({ isLoadingDir: true, currentPath: null });

    const message: WSMessage = {
      id: crypto.randomUUID(),
      type: WSMessageType.CMD_LIST_ALLOWED,
      payload: {
        requestId: crypto.randomUUID(),
      },
      timestamp: Date.now(),
      sessionId: sessionId || undefined,
    };

    wsInstance.send(JSON.stringify(message));
  },

  // 列出目录
  listDir: (path) => {
    const { wsInstance, sessionId } = get();
    if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;

    set({ isLoadingDir: true, currentPath: path });

    const message: WSMessage = {
      id: crypto.randomUUID(),
      type: WSMessageType.CMD_LIST_DIR,
      payload: {
        path,
        requestId: crypto.randomUUID(),
      },
      timestamp: Date.now(),
      sessionId: sessionId || undefined,
    };

    wsInstance.send(JSON.stringify(message));
  },

  // 请求下载
  requestDownload: (filePath) => {
    const { wsInstance, sessionId } = get();
    if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
      showErrorToast('下载失败', '未连接到远程主机');
      return;
    }

    const downloadId = crypto.randomUUID();

    get().addDownload({
      id: downloadId,
      fileName: filePath.split('/').pop() || filePath.split('\\').pop() || 'unknown',
      filePath,
      fileSize: 0,
      progress: 0,
      status: 'pending',
      startedAt: Date.now(),
    });

    const message: WSMessage = {
      id: crypto.randomUUID(),
      type: WSMessageType.CMD_REQUEST_DOWNLOAD,
      payload: {
        filePath,
        requestId: downloadId,
      },
      timestamp: Date.now(),
      sessionId: sessionId || undefined,
    };

    wsInstance.send(JSON.stringify(message));
  },

  // 请求文件预览
  requestPreview: (filePath) => {
    const { wsInstance, sessionId } = get();
    if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;

    const requestId = crypto.randomUUID();

    const message: WSMessage = {
      id: crypto.randomUUID(),
      type: WSMessageType.CMD_REQUEST_PREVIEW,
      payload: {
        filePath,
        requestId,
      },
      timestamp: Date.now(),
      sessionId: sessionId || undefined,
    };

    wsInstance.send(JSON.stringify(message));
  },

  // 加载消息历史
  loadMessageHistory: async (sessionId, page = 1) => {
    try {
      const { accessToken } = get();
      if (!accessToken || !sessionId) return;

      const response = await api.get(`/messages/${sessionId}`, {
        params: { page, limit: 50 },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const historyMessages = response.data.data as Array<{
        id: string;
        content: string;
        direction: 'host_to_client' | 'client_to_host';
        type: 'text' | 'system' | 'notification';
        createdAt: number;
      }>;

      if (historyMessages && historyMessages.length > 0) {
        // 转换格式并追加到消息列表（避免重复）
        set((state) => {
          const existingIds = new Set(state.messages.map((m) => m.id));
          const newMessages = historyMessages
            .filter((m) => !existingIds.has(m.id))
            .map((m) => ({
              id: m.id,
              content: m.content,
              direction: m.direction,
              type: m.type,
              // 服务端 createdAt 是 Unix 秒，统一归一为毫秒
              //（实时消息走 WS 顶层 timestamp，本就是毫秒）
              timestamp: m.createdAt < 1e12 ? m.createdAt * 1000 : m.createdAt,
            }))
            .sort((a, b) => a.timestamp - b.timestamp);

          const merged = [...newMessages, ...state.messages];
          const capped = merged.slice(-500); // keep most recent 500
          return { messages: capped };
        });
      }
    } catch (err) {
      logger.error('加载消息历史失败:', err);
      showErrorToast('加载消息历史失败');
    }
  },
}));
