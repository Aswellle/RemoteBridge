import { useState, useEffect, useCallback } from 'react';
import {
  Link2,
  FolderOpen,
  Users,
  MessageSquare,
  ShieldCheck,
  Settings,
  Copy,
  Check,
  Unlink,
  Plus,
  Pencil,
  Trash2,
  ArrowRight,
  Monitor,
} from 'lucide-react';
import { ElectronAPI, SettingsData } from '../preload/index';
import { applyTheme } from './theme';
import SecurityLogs from './pages/SecurityLogs';
import MessagesPage from './pages/Messages';
import ClientsPage from './pages/Clients';
import SettingsPage from './pages/Settings';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// ===== Skeleton 组件 =====
function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-secondary rounded ${className}`} />
  );
}

// ===== 侧边栏导航项 =====
function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-current={active ? 'page' : undefined}
      className={`relative flex items-center w-full px-4 py-3 transition-colors ${
        active
          ? 'bg-secondary/80 text-foreground'
          : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground'
      }`}
    >
      {/* 活跃指示条 */}
      {active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-primary rounded-r" />
      )}
      <span className="mr-3 flex-shrink-0">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto bg-destructive text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

// ===== 图标（与 apps/web 的 dashboard 导航共用 lucide-react 图标库） =====
const Icons = {
  link: <Link2 className="w-5 h-5" aria-hidden="true" />,
  folder: <FolderOpen className="w-5 h-5" aria-hidden="true" />,
  users: <Users className="w-5 h-5" aria-hidden="true" />,
  chat: <MessageSquare className="w-5 h-5" aria-hidden="true" />,
  shield: <ShieldCheck className="w-5 h-5" aria-hidden="true" />,
  copy: <Copy className="w-4 h-4" aria-hidden="true" />,
  check: <Check className="w-4 h-4" aria-hidden="true" />,
  disconnect: <Unlink className="w-4 h-4" aria-hidden="true" />,
  plus: <Plus className="w-5 h-5" aria-hidden="true" />,
  edit: <Pencil className="w-4 h-4" aria-hidden="true" />,
  trash: <Trash2 className="w-4 h-4" aria-hidden="true" />,
  settings: <Settings className="w-5 h-5" aria-hidden="true" />,
};

export default function App() {
  const [systemInfo, setSystemInfo] = useState<{
    hostname: string;
    platform: string;
    arch: string;
    release?: string;
    osVersion?: string;
    appVersion?: string;
    electronVersion?: string;
    nodeVersion?: string;
  } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [pin, setPin] = useState('');
  const [generatedPin, setGeneratedPin] = useState('');
  const [directories, setDirectories] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'home' | 'dirs' | 'clients' | 'messages' | 'security' | 'settings'>('home');
  const [isLoading, setIsLoading] = useState(true);
  const [copiedPin, setCopiedPin] = useState(false);
  const [editingAlias, setEditingAlias] = useState<number | null>(null);
  const [aliasValue, setAliasValue] = useState('');
  const [latency, setLatency] = useState(0);

  // 加载系统信息
  useEffect(() => {
    async function load() {
      try {
        const info = await window.electronAPI.getSystemInfo();
        setSystemInfo(info);
      } catch (err) {
        console.error('获取系统信息失败:', err);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  // 应用持久化的主题（设置页保存时也会即时切换）
  useEffect(() => {
    window.electronAPI.getSettings?.()
      .then((s: SettingsData) => applyTheme(s.theme))
      .catch(() => {});
  }, []);

  // 已连接客户端实时列表（relay 实时数据；事件触发 + 10s 轮询双保险）
  const refreshClients = useCallback(async () => {
    try {
      const list = await window.electronAPI.listClients();
      setClients(list);
    } catch {
      // relay 不可达时保留上次数据
    }
  }, []);

  useEffect(() => {
    refreshClients();
    const timer = setInterval(refreshClients, 10000);
    return () => clearInterval(timer);
  }, [refreshClients]);

  // 初始化时查询当前连接状态（主进程启动时会自动连接 Relay）
  useEffect(() => {
    window.electronAPI.getRelayStatus?.()
      .then((status: { connected: boolean }) => {
        if (status?.connected) {
          setConnectionStatus('connected');
        }
      })
      .catch(() => {});
  }, []);

  // 监听连接状态
  useEffect(() => {
    window.electronAPI.onConnectionStatus((data: any) => {
      setConnectionStatus(
        data.status === 'connected' ? 'connected' :
        data.status === 'error' ? 'error' : 'idle'
      );
    });

    window.electronAPI.onClientJoined(() => {
      refreshClients();
    });

    window.electronAPI.onNewMessage((data: any) => {
      setMessages(prev => [...prev, data]);
    });

    return () => {
      window.electronAPI.removeAllListeners('event:connection-status');
      window.electronAPI.removeAllListeners('event:client-joined');
      window.electronAPI.removeAllListeners('event:new-message');
    };
  }, []);

  // 轮询延迟
  useEffect(() => {
    if (connectionStatus !== 'connected') {
      setLatency(0);
      return;
    }
    const interval = setInterval(async () => {
      try {
        const rtt = await window.electronAPI.getRelayLatency();
        setLatency(rtt);
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [connectionStatus]);

  // 注册 Host
  const handleRegister = async () => {
    setConnectionStatus('connecting');
    try {
      const result = await window.electronAPI.registerHost();
      if (result.success) {
        setConnectionStatus('connected');
      } else {
        setConnectionStatus('error');
      }
    } catch (err) {
      setConnectionStatus('error');
    }
  };

  // 断开连接（真正断开 Relay WS，而不只是重置 UI）
  const handleDisconnect = async () => {
    try {
      await window.electronAPI.disconnectRelay?.();
    } catch (err) {
      console.error('断开连接失败:', err);
    }
    setConnectionStatus('idle');
    setGeneratedPin('');
    setClients([]);
    setMessages([]);
  };

  // 生成 PIN
  const handleGeneratePin = async () => {
    try {
      const result = await window.electronAPI.generatePin(300); // 5 分钟
      if (result.success && result.data) {
        setGeneratedPin(result.data.pin);
        setCopiedPin(false);
      }
    } catch (err) {
      console.error('生成 PIN 失败:', err);
    }
  };

  // 复制 PIN
  const handleCopyPin = async () => {
    if (!generatedPin) return;
    try {
      await navigator.clipboard.writeText(generatedPin);
      setCopiedPin(true);
      setTimeout(() => setCopiedPin(false), 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  // 添加目录
  const handleAddDirectory = async () => {
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      await window.electronAPI.addDirectory(path);
      const dirs = await window.electronAPI.listDirectories();
      setDirectories(dirs);
    }
  };

  // 移除目录
  const handleRemoveDirectory = async (id: number) => {
    await window.electronAPI.removeDirectory(id);
    const dirs = await window.electronAPI.listDirectories();
    setDirectories(dirs);
  };

  // 编辑别名（本地状态，待后端支持后可持久化）
  const handleEditAlias = (dir: any) => {
    setEditingAlias(dir.id);
    setAliasValue(dir.label || '');
  };

  const handleSaveAlias = (dirId: number) => {
    setDirectories(prev =>
      prev.map(d => d.id === dirId ? { ...d, label: aliasValue } : d)
    );
    setEditingAlias(null);
  };

  // 加载目录列表
  useEffect(() => {
    async function loadDirs() {
      try {
        const dirs = await window.electronAPI.listDirectories();
        setDirectories(dirs);
      } catch (err) {
        console.error('加载目录失败:', err);
      }
    }
    loadDirs();
  }, []);

  // 格式化平台名
  const getPlatformName = (platform: string) => {
    switch (platform) {
      case 'win32': return 'Windows';
      case 'darwin': return 'macOS';
      case 'linux': return 'Linux';
      default: return platform;
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* 侧边栏 */}
      <aside className="w-64 bg-card border-r border-border flex flex-col flex-shrink-0">
        {/* Logo + 版本号 */}
        <div className="p-4 border-b border-border">
          <h1 className="text-xl font-bold text-primary">RemoteBridge</h1>
          <p className="text-xs text-muted-foreground mt-1">Host 模式 · v1.0.0</p>
        </div>

        {/* 导航 */}
        <nav className="flex-1 mt-2" aria-label="主导航" role="tablist">
          {isLoading ? (
            // 导航骨架屏
            <div className="space-y-2 px-4 py-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <>
              <NavButton
                active={activeTab === 'home'}
                onClick={() => setActiveTab('home')}
                icon={Icons.link}
                label="连接状态"
              />
              <NavButton
                active={activeTab === 'dirs'}
                onClick={() => setActiveTab('dirs')}
                icon={Icons.folder}
                label="共享目录"
              />
              <NavButton
                active={activeTab === 'clients'}
                onClick={() => setActiveTab('clients')}
                icon={Icons.users}
                label="已连接客户端"
                badge={clients.length}
              />
              <NavButton
                active={activeTab === 'messages'}
                onClick={() => setActiveTab('messages')}
                icon={Icons.chat}
                label="消息中心"
                badge={messages.length}
              />
              <NavButton
                active={activeTab === 'security'}
                onClick={() => setActiveTab('security')}
                icon={Icons.shield}
                label="安全审计"
              />
              <NavButton
                active={activeTab === 'settings'}
                onClick={() => setActiveTab('settings')}
                icon={Icons.settings}
                label="设置"
              />
            </>
          )}
        </nav>

        {/* 底部系统信息 */}
        <div className="p-4 border-t border-border">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : (
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="flex items-center gap-1.5">
                <ArrowRight className="w-3 h-3" aria-hidden="true" />
                <span className="font-mono">{systemInfo?.hostname || '-'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Monitor className="w-3 h-3" aria-hidden="true" />
                <span>{systemInfo ? `${getPlatformName(systemInfo.platform)} ${systemInfo.arch}` : '-'}</span>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto">
        {/* === 连接状态页 === */}
        {activeTab === 'home' && (
          <div className="p-8">
            <h2 className="text-2xl font-semibold mb-6">连接状态</h2>

            {isLoading ? (
              // 连接状态骨架屏
              <div className="space-y-6">
                <div className="bg-card rounded-xl p-6">
                  <div className="grid grid-cols-2 gap-4">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="space-y-2">
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-5 w-32" />
                      </div>
                    ))}
                  </div>
                  <Skeleton className="h-10 w-48 mt-6" />
                </div>
              </div>
            ) : (
              <>
                {/* 系统信息卡片 */}
                <div className="bg-card rounded-xl p-6 mb-6 border border-border/50">
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">主机名</span>
                      <p className="mt-1 font-mono text-sm">{systemInfo?.hostname || '-'}</p>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">系统</span>
                      <p className="mt-1 text-sm">
                        {systemInfo
                          ? `${systemInfo.osVersion || getPlatformName(systemInfo.platform)} (${systemInfo.arch})`
                          : '-'}
                      </p>
                      {systemInfo?.release && (
                        <p className="mt-0.5 text-xs text-muted-foreground font-mono">内核 {systemInfo.release}</p>
                      )}
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">Relay 状态</span>
                      <div className="mt-1 flex items-center gap-2">
                        {/* 状态指示灯 */}
                        <div className={`w-2.5 h-2.5 rounded-full ${
                          connectionStatus === 'connected'
                            ? 'bg-green-500 animate-pulse shadow-lg shadow-green-500/50'
                            : connectionStatus === 'connecting'
                            ? 'bg-yellow-500 animate-pulse shadow-lg shadow-yellow-500/50'
                            : connectionStatus === 'error'
                            ? 'bg-red-500'
                            : 'bg-gray-500'
                        }`} />
                        <span className={`text-sm ${
                          connectionStatus === 'connected' ? 'text-success' :
                          connectionStatus === 'connecting' ? 'text-warning' :
                          connectionStatus === 'error' ? 'text-destructive' :
                          'text-muted-foreground'
                        }`}>
                          {connectionStatus === 'connected' ? '已连接' :
                           connectionStatus === 'connecting' ? '连接中...' :
                           connectionStatus === 'error' ? '连接失败' : '未连接'}
                        </span>
                        {connectionStatus === 'connected' && (
                          <span className="text-xs text-muted-foreground font-mono">
                            延迟 {latency > 0 ? `${latency}ms` : '<1ms'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">已连接客户端</span>
                      <p className="mt-1 text-sm">
                        {clients.filter((c: any) => c.online).length} 个在线
                        <span className="text-xs text-muted-foreground"> / 共 {clients.length} 个会话</span>
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">软件版本</span>
                      <p className="mt-1 text-sm">RemoteBridge v{systemInfo?.appVersion || '1.0.0'}</p>
                      {systemInfo?.electronVersion && (
                        <p className="mt-0.5 text-xs text-muted-foreground font-mono">
                          Electron {systemInfo.electronVersion} · Node {systemInfo.nodeVersion}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 连接/断开按钮 */}
                  <div className="mt-6 flex gap-3">
                    {connectionStatus === 'idle' && (
                      <button
                        onClick={handleRegister}
                        className="px-6 py-2.5 bg-primary hover:bg-primary/90 rounded-lg transition-colors text-sm font-medium"
                      >
                        连接到 Relay 服务器
                      </button>
                    )}
                    {connectionStatus === 'connecting' && (
                      <button
                        disabled
                        className="px-6 py-2.5 bg-warning/50 rounded-lg text-sm font-medium cursor-not-allowed"
                      >
                        连接中...
                      </button>
                    )}
                    {connectionStatus === 'error' && (
                      <button
                        onClick={handleRegister}
                        className="px-6 py-2.5 bg-destructive/20 hover:bg-destructive/40 text-destructive rounded-lg transition-colors text-sm font-medium"
                      >
                        重试连接
                      </button>
                    )}
                    {connectionStatus === 'connected' && (
                      <button
                        onClick={handleDisconnect}
                        className="flex items-center gap-2 px-6 py-2.5 bg-destructive/20 hover:bg-destructive/40 text-destructive rounded-lg transition-colors text-sm font-medium"
                      >
                        {Icons.disconnect}
                        断开连接
                      </button>
                    )}
                  </div>
                </div>

                {/* PIN 码生成 */}
                {connectionStatus === 'connected' && (
                  <div className="bg-card rounded-xl p-6 border border-border/50">
                    <h3 className="text-lg font-semibold mb-2">生成连接码</h3>
                    <p className="text-muted-foreground text-sm mb-5">
                      生成一次性 PIN 码，让远程设备通过浏览器连接到此电脑
                    </p>

                    <button
                      onClick={handleGeneratePin}
                      className="px-6 py-2.5 bg-success hover:bg-success/90 rounded-lg transition-colors text-sm font-medium"
                    >
                      生成连接码
                    </button>

                    {generatedPin && (
                      <div className="mt-5 p-6 bg-background rounded-xl text-center border border-border/50">
                        <p className="text-sm text-muted-foreground mb-3">连接码（5 分钟内有效）</p>
                        <p className="text-4xl font-mono tracking-[0.3em] text-success mb-4">
                          {generatedPin.slice(0, 4)}-{generatedPin.slice(4)}
                        </p>
                        <button
                          onClick={handleCopyPin}
                          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                            copiedPin
                              ? 'bg-success/20 text-success'
                              : 'bg-secondary hover:bg-secondary text-foreground'
                          }`}
                        >
                          {copiedPin ? Icons.check : Icons.copy}
                          {copiedPin ? '已复制' : '复制连接码'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* === 共享目录页 === */}
        {activeTab === 'dirs' && (
          <div className="p-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold">共享目录</h2>
              <button
                onClick={handleAddDirectory}
                className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90 rounded-lg transition-colors text-sm font-medium"
              >
                {Icons.plus}
                添加目录
              </button>
            </div>

            {isLoading ? (
              // 目录列表骨架屏
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="bg-card rounded-xl p-5 flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <Skeleton className="w-10 h-10 rounded-lg" />
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/3" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Skeleton className="h-8 w-16" />
                      <Skeleton className="h-8 w-16" />
                    </div>
                  </div>
                ))}
              </div>
            ) : directories.length === 0 ? (
              // 空状态动画
              <div className="text-center py-16">
                <div className="inline-block mb-4">
                  <FolderOpen className="w-16 h-16 text-gray-600 animate-bounce" aria-hidden="true" />
                </div>
                <p className="text-muted-foreground text-lg mb-2">尚未添加共享目录</p>
                <p className="text-muted-foreground text-sm">点击上方按钮添加要远程访问的目录</p>
              </div>
            ) : (
              <div className="space-y-3">
                {directories.map((dir: any) => (
                  <div
                    key={dir.id}
                    className="bg-card rounded-xl p-5 flex items-center justify-between border border-border/50 hover:border-border transition-colors"
                  >
                    <div className="flex items-center gap-4 min-w-0 flex-1">
                      {/* 目录图标 */}
                      <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center flex-shrink-0">
                        <FolderOpen className="w-5 h-5 text-primary" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-sm truncate">{dir.path}</p>
                        {editingAlias === dir.id ? (
                          <div className="flex items-center gap-2 mt-1">
                            <input
                              type="text"
                              value={aliasValue}
                              onChange={(e) => setAliasValue(e.target.value)}
                              placeholder="输入别名..."
                              className="px-2 py-1 bg-secondary border border-border rounded text-xs w-48 focus:outline-none focus:ring-1 focus:ring-primary"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveAlias(dir.id);
                                if (e.key === 'Escape') setEditingAlias(null);
                              }}
                            />
                            <button
                              onClick={() => handleSaveAlias(dir.id)}
                              className="text-success hover:text-success/80 transition-colors"
                            >
                              {Icons.check}
                            </button>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {dir.label || '未设置别名'}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                      <select
                        value={dir.permission}
                        onChange={async (e) => {
                          await window.electronAPI.updatePermission(dir.id, e.target.value);
                          const dirs = await window.electronAPI.listDirectories();
                          setDirectories(dirs);
                        }}
                        className="px-3 py-1.5 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="readonly">只读</option>
                        <option value="download">允许下载</option>
                      </select>
                      <button
                        onClick={() => handleEditAlias(dir)}
                        className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
                        title="编辑别名"
                      >
                        {Icons.edit}
                      </button>
                      <button
                        onClick={() => handleRemoveDirectory(dir.id)}
                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                        title="移除目录"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* === 客户端列表页 === */}
        {activeTab === 'clients' && <ClientsPage />}

        {/* === 消息页 === */}
        {activeTab === 'messages' && <MessagesPage />}

        {/* === 安全审计页 === */}
        {activeTab === 'security' && <SecurityLogs />}

        {/* === 设置页 === */}
        {activeTab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
