/**
 * 客户端管理页面
 * 客户端列表 + 在线状态 + 信任/吊销操作 + 活动日志
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Users, ClipboardList, RefreshCw, Loader2 } from 'lucide-react';
import {
  PageHeader,
  Button,
  StatusDot,
  Badge,
  EmptyState,
  Divider,
} from '../components/ui';
import { ElectronAPI } from '../../preload/index';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

interface ClientRecord {
  clientId: string;
  /** Relay 不可达（本地回退）时为 null，此时吊销不可用 */
  sessionId: string | null;
  label: string | null;
  lastSeenAt: number;
  online: boolean;
  isTrusted: boolean;
}

interface AccessLogRecord {
  id: number;
  client_id: string;
  action: string;
  path?: string;
  status: string;
  created_at: number;
}

// 视图切换项：图标与标签集中定义，键盘导航（方向键/Home/End）按此顺序循环
const VIEW_TABS = [
  { id: 'clients', label: '客户端列表', icon: <Users className="size-3.5" aria-hidden="true" /> },
  { id: 'logs', label: '活动日志', icon: <ClipboardList className="size-3.5" aria-hidden="true" /> },
] as const;

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [accessLogs, setAccessLogs] = useState<AccessLogRecord[]>([]);
  const [activeSection, setActiveSection] = useState<'clients' | 'logs'>('clients');
  const viewTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  // 加载客户端列表
  const loadClients = useCallback(async () => {
    try {
      setIsLoading(true);
      const list = await window.electronAPI.listClients();
      setClients(list as ClientRecord[]);
    } catch (err) {
      console.error('加载客户端列表失败:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 加载访问日志
  const loadAccessLogs = useCallback(async () => {
    try {
      const logs = await window.electronAPI.getAccessLogs(200);
      setAccessLogs(logs as AccessLogRecord[]);
    } catch (err) {
      console.error('加载访问日志失败:', err);
    }
  }, []);

  // 视图切换：进入日志视图时按需加载访问日志
  const selectView = useCallback((id: 'clients' | 'logs') => {
    setActiveSection(id);
    if (id === 'logs') loadAccessLogs();
  }, [loadAccessLogs]);

  // ARIA APG tabs 键盘语义：左右方向键循环切换，Home/End 跳到首末
  const handleViewTabsKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const last = VIEW_TABS.length - 1;
    const current = VIEW_TABS.findIndex((v) => v.id === activeSection);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = current === last ? 0 : current + 1;
    else if (e.key === 'ArrowLeft') next = current === 0 ? last : current - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    selectView(VIEW_TABS[next].id);
    viewTabRefs.current[next]?.focus();
  }, [activeSection, selectView]);

  // 初始加载 + 10s 轮询（不注册 onClientJoined/onClientLeft 事件，
  // 避免覆盖 App.tsx 已注册的同名监听器导致主页客户端状态丢失）
  useEffect(() => {
    let alive = true;
    loadClients();
    loadAccessLogs();
    const timer = setInterval(() => {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        loadClients();
        loadAccessLogs();
      }
    }, 10000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && alive) {
        loadClients();
        loadAccessLogs();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadClients, loadAccessLogs]);

  // 信任/取消信任
  const handleTrust = async (clientId: string, trusted: boolean) => {
    setActionError('');
    try {
      const result = await window.electronAPI.trustClient(clientId, trusted);
      if (result.success) {
        await loadClients();
      } else {
        setActionError(result.error || '操作失败');
      }
    } catch (err: any) {
      setActionError(err?.message || '操作失败');
    }
  };

  // 吊销会话（必须用 sessionId；吊销后该客户端会被强制断开）
  const handleRevoke = async (client: ClientRecord) => {
    if (!client.sessionId) {
      setActionError('Relay 不可达，暂时无法吊销');
      return;
    }
    const name = client.label || `设备 ${client.clientId.slice(0, 8)}`;
    if (!window.confirm(`确定吊销「${name}」的会话？该设备将被立即断开，需重新输入连接码。`)) {
      return;
    }
    setActionError('');
    try {
      const result = await window.electronAPI.revokeClient(client.sessionId, client.clientId);
      if (result.success) {
        await loadClients();
        await loadAccessLogs();
      } else {
        setActionError(result.error || '吊销失败');
      }
    } catch (err: any) {
      setActionError(err?.message || '吊销失败');
    }
  };

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="p-6">
      <PageHeader
        title="已连接客户端"
        subtitle={activeSection === 'clients' ? '管理已注册的客户端与信任状态' : '查看文件访问操作日志'}
        actions={
          <div className="flex items-center gap-2">
            {/* 视图切换用分段控件：当前视图以 surface + 强调色文字标出，比"文字前加 ● "
                更易辨识，也不与右侧刷新按钮争夺视觉重量。
                无障碍：按 ARIA APG 的 tabs 模式实现 roving tabindex + 左右方向键/Home/End，
                避免 role="tab" 只有外壳而无键盘语义（"坏 ARIA 不如无 ARIA"）。 */}
            <div
              role="tablist"
              aria-label="客户端视图"
              className="flex items-center gap-1 rounded-sm bg-surface-subtle p-1"
              onKeyDown={handleViewTabsKeyDown}
            >
              {VIEW_TABS.map((view, index) => {
                const selected = activeSection === view.id;
                return (
                  <button
                    key={view.id}
                    ref={(el) => { viewTabRefs.current[index] = el; }}
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => selectView(view.id)}
                    className={
                      'inline-flex h-7 items-center gap-1.5 rounded-xs px-3 text-sm font-medium transition-colors duration-120 ' +
                      (selected
                        ? 'bg-surface-raised text-accent-text shadow-sm'
                        : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground')
                    }
                  >
                    {view.icon}
                    {view.label}
                  </button>
                );
              })}
            </div>
            <Button variant="outline" onClick={() => {
              loadClients();
              loadAccessLogs();
            }}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
          </div>
        }
      />
      {/* 操作错误提示 */}
      {actionError && (
        <div className="mb-4 flex items-center justify-between rounded-sm bg-surface-danger/10 px-4 py-2.5 text-sm text-danger-text">
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} className="ml-3 flex-shrink-0 hover:opacity-70">
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* === 客户端列表 === */}
      {activeSection === 'clients' && (
        <div>
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="animate-spin mr-3 size-7 text-accent-solid" />
              <span className="text-muted-foreground">加载中...</span>
            </div>
          ) : clients.length === 0 ? (
            <EmptyState
              icon={<Users className="size-6" />}
              title="暂无已注册客户端"
              description="客户端通过 PIN 码连接后会出现在此列表"
            />
          ) : (
            <div className="space-y-3">
              {clients.map((client) => (
                <div
                  key={client.sessionId || client.clientId}
                  className="flex items-center justify-between rounded-lg bg-surface-raised p-4"
                >
                  <div className="flex min-w-0 flex-1 items-center">
                    <StatusDot
                      status={client.online ? 'online' : 'offline'}
                      label={client.online ? '在线' : '离线'}
                      className="mr-3"
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {client.label || `设备 ${client.clientId.slice(0, 8)}`}
                      </p>
                      <div className="mt-0.5 flex items-center space-x-3 text-xs text-muted-foreground">
                        <span>ID: {client.clientId.slice(0, 12)}…</span>
                        <span>最后活跃: {formatTime(client.lastSeenAt)}</span>
                        {client.isTrusted && <Badge tone="success">已信任</Badge>}
                      </div>
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="ml-4 flex flex-shrink-0 items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => handleTrust(client.clientId, !client.isTrusted)}
                    >
                      {client.isTrusted ? '取消信任' : '信任'}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => handleRevoke(client)}
                      disabled={!client.sessionId}
                      title={
                        client.sessionId
                          ? '吊销该会话并立即断开连接'
                          : 'Relay 不可达，暂时无法吊销'
                      }
                    >
                      吊销
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === 活动日志 === */}
      {activeSection === 'logs' && (
        <div>
          {accessLogs.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="size-6" />}
              title="暂无活动日志"
              description="文件访问操作会自动记录到此处"
            />
          ) : (
            <div className="overflow-hidden rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[color-mix(in_srgb,currentColor_8%,transparent)] text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">时间</th>
                    <th className="px-4 py-3 font-medium">客户端</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                    <th className="px-4 py-3 font-medium">路径</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {accessLogs.map((log) => {
                    const actionTone: 'list' | 'download' | 'upload' | 'delete' | 'neutral' =
                      log.action === 'LIST_DIR'
                        ? 'list'
                        : log.action === 'DOWNLOAD'
                          ? 'download'
                          : log.action === 'UPLOAD'
                            ? 'upload'
                            : log.action === 'DELETE'
                              ? 'delete'
                              : 'neutral';
                    return (
                      <tr
                        key={log.id}
                        className="border-b border-[color-mix(in_srgb,currentColor_8%,transparent)] transition-colors hover:bg-surface-hover"
                      >
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {formatTime(log.created_at)}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs">
                          {log.client_id.slice(0, 12)}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge tone={actionTone}>{log.action}</Badge>
                        </td>
                        <td className="max-w-xs truncate px-4 py-2.5 font-mono text-xs">
                          {log.path || '-'}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge
                            tone={
                              log.status === 'OK'
                                ? 'success'
                                : log.status === 'BLOCKED'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {log.status}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
