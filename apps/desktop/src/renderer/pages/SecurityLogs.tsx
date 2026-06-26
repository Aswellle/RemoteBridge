import { useState, useEffect, useCallback } from 'react';
import { Loader2, ClipboardList } from 'lucide-react';
import { EVENT_TYPE_LABELS, EVENT_TYPE_COLORS } from '@remotebridge/shared';

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
      <h2 className="text-2xl font-semibold mb-6">安全审计日志</h2>

      {/* 筛选栏 */}
      <div className="bg-card rounded-lg p-4 mb-6 flex flex-wrap gap-4 items-center">
        <div>
          <label className="text-sm text-muted-foreground mr-2">事件类型:</label>
          <select
            value={filterEventType}
            onChange={(e) => setFilterEventType(e.target.value)}
            className="px-3 py-1.5 bg-secondary border border-border rounded-lg text-sm"
          >
            <option value="">全部</option>
            {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-sm text-muted-foreground mr-2">客户端 ID:</label>
          <input
            type="text"
            value={filterClientId}
            onChange={(e) => setFilterClientId(e.target.value)}
            placeholder="筛选客户端"
            className="px-3 py-1.5 bg-secondary border border-border rounded text-sm w-48"
          />
        </div>

        <button
          onClick={() => fetchLogs(1)}
          className="px-4 py-1.5 bg-primary hover:bg-primary/90 text-white text-sm rounded-lg transition-colors"
        >
          刷新
        </button>

        <span className="text-sm text-muted-foreground ml-auto">
          共 {total} 条记录
        </span>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="bg-destructive/10 border border-destructive rounded-lg p-4 mb-6 text-destructive">
          ⚠️ {error}
        </div>
      )}

      {/* 日志表格 */}
      <div className="bg-card rounded-lg shadow-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin h-8 w-8 text-primary mr-3" />
            <span className="text-muted-foreground">加载中...</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
              <ClipboardList className="w-8 h-8 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold text-foreground mb-1">暂无安全日志</p>
            <p className="text-sm text-muted-foreground">安全事件发生后会自动记录到此处</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-left">
                  <th className="px-4 py-3 font-medium">时间</th>
                  <th className="px-4 py-3 font-medium">事件类型</th>
                  <th className="px-4 py-3 font-medium">客户端 ID</th>
                  <th className="px-4 py-3 font-medium">IP 地址</th>
                  <th className="px-4 py-3 font-medium">详情</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-3 text-foreground whitespace-nowrap">
                      {formatTimestamp(log.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${EVENT_TYPE_COLORS[log.eventType as keyof typeof EVENT_TYPE_COLORS] || 'text-muted-foreground bg-gray-400/10'}`}>
                        {EVENT_TYPE_LABELS[log.eventType as keyof typeof EVENT_TYPE_LABELS] || log.eventType}
                      </span>
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
          <div className="flex items-center space-x-2">
            <button
              onClick={() => fetchLogs(1)}
              disabled={page <= 1}
              className="px-3 py-1.5 bg-secondary hover:bg-secondary text-secondary-foreground text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              首页
            </button>
            <button
              onClick={() => fetchLogs(page - 1)}
              disabled={page <= 1}
              className="px-3 py-1.5 bg-secondary hover:bg-secondary text-secondary-foreground text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              上一页
            </button>
            <button
              onClick={() => fetchLogs(page + 1)}
              disabled={page >= totalPages}
              className="px-3 py-1.5 bg-secondary hover:bg-secondary text-secondary-foreground text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              下一页
            </button>
            <button
              onClick={() => fetchLogs(totalPages)}
              disabled={page >= totalPages}
              className="px-3 py-1.5 bg-secondary hover:bg-secondary text-secondary-foreground text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              末页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
