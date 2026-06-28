/**
 * 客户端管理页面
 * 客户端列表 + 在线状态 + 信任/吊销操作 + 活动日志
 */

import { useState, useEffect, useCallback } from 'react';
import { X, Users, ClipboardList, CheckCircle2, RefreshCw, Loader2 } from 'lucide-react';
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

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [accessLogs, setAccessLogs] = useState<AccessLogRecord[]>([]);
  const [activeSection, setActiveSection] = useState<'clients' | 'logs'>('clients');
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
      {/* 页面标题 + 切换 */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">客户端管理</h2>
        <div className="flex space-x-2">
          <button
            onClick={() => setActiveSection('clients')}
            className={`px-4 py-2 rounded-lg text-sm transition-colors ${
              activeSection === 'clients'
                ? 'bg-primary text-white'
                : 'bg-secondary text-foreground hover:bg-muted'
            }`}
          >
            客户端列表
          </button>
          <button
            onClick={() => {
              setActiveSection('logs');
              loadAccessLogs();
            }}
            className={`px-4 py-2 rounded-lg text-sm transition-colors ${
              activeSection === 'logs'
                ? 'bg-primary text-white'
                : 'bg-secondary text-foreground hover:bg-muted'
            }`}
          >
            活动日志
          </button>
          <button
            onClick={() => {
              loadClients();
              loadAccessLogs();
            }}
            className="flex items-center gap-1.5 px-4 py-2 bg-secondary text-foreground hover:bg-muted rounded-lg text-sm transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </button>
        </div>
      </div>

      {/* 操作错误提示 */}
      {actionError && (
        <div className="mb-4 px-4 py-2.5 bg-destructive/15 border border-destructive/40 text-destructive text-sm rounded-lg flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} className="ml-3 hover:opacity-70 flex-shrink-0"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* === 客户端列表 === */}
      {activeSection === 'clients' && (
        <div>
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="animate-spin h-7 w-7 text-primary mr-3" />
              <span className="text-muted-foreground">加载中...</span>
            </div>
          ) : clients.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                <Users className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-base font-semibold text-foreground mb-1">暂无已注册客户端</p>
              <p className="text-sm text-muted-foreground">客户端通过 PIN 码连接后会出现在此列表</p>
            </div>
          ) : (
            <div className="space-y-3">
              {clients.map((client) => (
                <div
                  key={client.sessionId || client.clientId}
                  className="bg-card rounded-lg p-4 flex items-center justify-between"
                >
                  <div className="flex items-center min-w-0 flex-1">
                    {/* 在线状态指示灯（来自 relay 实时数据） */}
                    <span
                      className={`w-2.5 h-2.5 rounded-full mr-3 flex-shrink-0 ${
                        client.online ? 'bg-green-400' : 'bg-gray-500'
                      }`}
                      title={client.online ? '在线' : '离线'}
                    />
                    <div className="min-w-0">
                      <p className="font-medium truncate">
                        {client.label || `设备 ${client.clientId.slice(0, 8)}`}
                      </p>
                      <div className="flex items-center space-x-3 text-xs text-muted-foreground mt-0.5">
                        <span>ID: {client.clientId.slice(0, 12)}...</span>
                        <span>最后活跃: {formatTime(client.lastSeenAt)}</span>
                        {client.isTrusted && (
                          <span className="flex items-center gap-1 text-success"><CheckCircle2 className="w-3 h-3" />已信任</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex items-center space-x-2 flex-shrink-0 ml-4">
                    <button
                      onClick={() => handleTrust(client.clientId, !client.isTrusted)}
                      className={`px-3 py-1.5 rounded-lg transition-colors text-sm ${
                        client.isTrusted
                          ? 'bg-secondary text-muted-foreground hover:bg-muted'
                          : 'bg-success text-white hover:bg-success/90'
                      }`}
                    >
                      {client.isTrusted ? '取消信任' : '信任'}
                    </button>
                    <button
                      onClick={() => handleRevoke(client)}
                      disabled={!client.sessionId}
                      title={client.sessionId ? '吊销该会话并立即断开连接' : 'Relay 不可达，暂时无法吊销'}
                      className="px-3 py-1.5 bg-destructive text-white hover:bg-destructive/90 rounded-lg transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      吊销
                    </button>
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
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                <ClipboardList className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-base font-semibold text-foreground mb-1">暂无活动日志</p>
              <p className="text-sm text-muted-foreground">文件访问操作会自动记录到此处</p>
            </div>
          ) : (
            <div className="bg-card rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-left border-b border-border">
                    <th className="px-4 py-3 font-medium">时间</th>
                    <th className="px-4 py-3 font-medium">客户端</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                    <th className="px-4 py-3 font-medium">路径</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {accessLogs.map((log) => (
                    <tr
                      key={log.id}
                      className="border-b border-border/50 hover:bg-secondary/30 transition-colors"
                    >
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {formatTime(log.created_at)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {log.client_id.slice(0, 12)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded-lg text-xs ${
                            log.action === 'LIST_DIR'
                              ? 'bg-primary/20 text-primary'
                              : log.action === 'DOWNLOAD'
                              ? 'bg-purple-600/20 text-purple-400'
                              : 'bg-secondary/20 text-muted-foreground'
                          }`}
                        >
                          {log.action}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs truncate max-w-xs">
                        {log.path || '-'}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`text-xs ${
                            log.status === 'OK'
                              ? 'text-success'
                              : log.status === 'BLOCKED'
                              ? 'text-destructive'
                              : 'text-warning'
                          }`}
                        >
                          {log.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
