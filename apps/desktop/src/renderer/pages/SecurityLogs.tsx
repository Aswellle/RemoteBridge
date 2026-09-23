import { useState, useEffect, useCallback } from 'react';
import { Loader2, ClipboardList, AlertCircle, RefreshCw } from 'lucide-react';
import { EVENT_TYPE_LABELS } from '@remotebridge/shared';
import { PageHeader, Input, Button, Badge, EmptyState } from '../components/ui';
import type { BadgeTone } from '../components/ui';

// ===== 事件类型 → Badge tone（Spec §18: 统一 Badge，浅色 capsule）=====
const EVENT_TYPE_TONES: Record<string, BadgeTone> = {
  AUTH_FAIL: 'danger',
  BLOCKED_PATH: 'danger',
  REVOKE: 'warning',
  PIN_EXPIRED: 'neutral',
  SESSION_CREATED: 'success',
  ACCESS_DOWNLOAD: 'info',
  ACCESS_PREVIEW: 'info',
  ACCESS: 'info',
};

const eventTypeTone = (eventType: string): BadgeTone =>
  EVENT_TYPE_TONES[eventType] ?? 'neutral';

// ===== 安全日志条目类型 =====
interface SecurityLogEntry {
  id: string;
  hostId: string | null;
  clientId: string | null;
  eventType: string;
  detail: string | null;
  ipAddress: string | null;
  createdAt: number;
}

// ===== 分页数据 =====
interface PagedResult {
  logs: SecurityLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function SecurityLogs() {
  const [logs, setLogs] = useState<SecurityLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 筛选条件
  const [filterEventType, setFilterEventType] = useState('');
  const [filterClientId, setFilterClientId] = useState('');

  // 获取安全日志
  const fetchLogs = useCallback(async (currentPage: number) => {
    setLoading(true);
    setError(null);

    try {
      // 必须经主进程 IPC 访问 Relay：file:// 页面里相对路径 fetch 解析成
      // file:///api/... 直接 Failed to fetch，绝对地址又会被 CORS 拦截
      const result = await window.electronAPI.getSecurityLogs({
        page: currentPage,
        pageSize,
        eventType: filterEventType || undefined,
        clientId: filterClientId || undefined,
      });

      if (result.success && result.data) {
        const data: PagedResult = result.data as PagedResult;
        setLogs(data.logs);
        setTotal(data.total);
        setTotalPages(data.totalPages);
        setPage(data.page);
      } else {
        throw new Error(result.error || '查询失败');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
      console.error('获取安全日志失败:', err);
    } finally {
      setLoading(false);
    }
  }, [pageSize, filterEventType, filterClientId]);

  // 初始加载和筛选变化时重新获取
  useEffect(() => {
    fetchLogs(1);
  }, [fetchLogs]);

  // 格式化时间戳
  const formatTimestamp = (timestamp: number): string => {
    try {
      const date = new Date(timestamp * 1000);
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return String(timestamp);
    }
  };

  // 解析 detail JSON
  const parseDetail = (detail: string | null): string => {
    if (!detail) return '-';
    try {
      const obj = JSON.parse(detail);
      return Object.entries(obj)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
    } catch {
      return detail;
    }
  };

  return (
    <div className="p-8">
      <PageHeader title="安全审计日志" />

      {/* 筛选栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">事件类型:</label>
          <select
            value={filterEventType}
            onChange={(e) => setFilterEventType(e.target.value)}
            className="h-9 rounded-sm border border-transparent bg-surface-subtle px-3 text-sm focus:border-accent-border/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <option value="">全部</option>
            {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">客户端 ID:</label>
          <Input
            value={filterClientId}
            onChange={(e) => setFilterClientId(e.target.value)}
            placeholder="筛选客户端"
            className="w-48"
          />
        </div>

        <Button variant="secondary" onClick={() => fetchLogs(1)}>
          <RefreshCw className="size-3.5" />
          刷新
        </Button>

        <span className="ml-auto text-sm text-muted-foreground">
          共 {total} 条记录
        </span>
      </div>
      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-sm bg-surface-warning/10 px-3 py-2">
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-sm text-foreground">{error}</p>
              {error.includes('无法连接到 Relay') && (
                <p className="mt-1 text-xs text-muted-foreground">
                  请先启动本地 Relay 服务器，或在设置中配置远程服务器地址
                </p>
              )}
            </div>
          </div>
          <Button variant="secondary" onClick={() => fetchLogs(1)}>
            <RefreshCw className="size-3" />
            重试
          </Button>
        </div>
      )}

      {/* 日志表格 */}
      <div className="bg-surface-raised rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="mr-3 size-6 animate-spin text-accent-solid" />
            <span className="text-muted-foreground">加载中...</span>
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={<ClipboardList />}
            title="暂无安全日志"
            description="安全事件发生后会自动记录到此处"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[color-mix(in_srgb,currentColor_8%,transparent)] text-muted-foreground text-left">
                  <th className="px-4 py-3 font-medium">事件类型</th>
                  <th className="px-4 py-3 font-medium">客户端 ID</th>
                  <th className="px-4 py-3 font-medium">IP 地址</th>
                  <th className="px-4 py-3 font-medium">详情</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-[color-mix(in_srgb,currentColor_8%,transparent)] hover:bg-surface-hover transition-colors">
                    <td className="px-4 py-3 text-foreground whitespace-nowrap">
                      {formatTimestamp(log.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={EVENT_TYPE_TONES[log.eventType] || 'neutral'}>
                        {EVENT_TYPE_LABELS[log.eventType as keyof typeof EVENT_TYPE_LABELS] || log.eventType}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {log.clientId ? (
                        <span title={log.clientId}>{log.clientId.slice(0, 8)}...</span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-4 py-3 text-foreground font-mono text-xs">
                      {log.ipAddress || '-'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs max-w-xs truncate" title={log.detail || ''}>
                      {parseDetail(log.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 分页控件 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => fetchLogs(1)} disabled={page <= 1}>首页</Button>
            <Button variant="secondary" onClick={() => fetchLogs(page - 1)} disabled={page <= 1}>上一页</Button>
            <Button variant="secondary" onClick={() => fetchLogs(page + 1)} disabled={page >= totalPages}>下一页</Button>
            <Button variant="secondary" onClick={() => fetchLogs(totalPages)} disabled={page >= totalPages}>末页</Button>
          </div>
        </div>
      )}
    </div>
  );
}
