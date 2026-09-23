/**
 * Local Relay 设置页
 *
 * 设计规范 (Spec §27, §28):
 * - Status block: ● Running + port + [Stop/Start]
 * - Configuration: Port + Start with app (Switch)
 * - Diagnostics: 默认折叠，点击展开日志
 * - 日志不再永久展示 44px 高
 */
import { useState } from 'react';
import { Section, SettingRow, Switch, StatusDot, Button, Divider } from '../components/ui';
import { Play, Square, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import type { LocalRelayState } from './types';
export interface LocalRelaySettingsProps {
  status: LocalRelayState;
  port: number;
  autoStart: boolean;
  error: string;
  logs: string[];
  logRef: React.Ref<HTMLDivElement>;
  loading: boolean;
  onPortChange: (val: number) => void;
  onPortSave: () => void;
  onAutoStart: (val: boolean) => void;
  onStart: () => void;
  onStop: () => void;
}

const STATUS_LABEL: Record<LocalRelayState, string> = {
  stopped: '未运行',
  starting: '启动中…',
  running: '已运行',
  error: '错误',
};

export function LocalRelaySettings({
  status,
  port,
  autoStart,
  error,
  logs,
  logRef,
  loading,
  onPortChange,
  onPortSave,
  onAutoStart,
  onStart,
  onStop,
}: LocalRelaySettingsProps) {
  const [logsExpanded, setLogsExpanded] = useState(false);

  const dotStatus = status === 'running' ? 'online' : status === 'error' ? 'error' : status === 'starting' ? 'connecting' : 'offline';

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">本地 Relay</h2>
        <p className="mt-1 text-sm text-muted-foreground">在此机器上直接运行内置 Relay，无需另开终端</p>
      </header>

      {/* 状态块 */}
      <div className="mb-4 rounded-sm bg-surface-raised p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusDot status={dotStatus} />
            <span className="text-sm font-medium">{STATUS_LABEL[status]}</span>
            {status === 'running' && (
              <span className="font-mono text-xs text-muted-foreground">:{port}</span>
            )}
          </div>
          {(status === 'stopped' || status === 'error') ? (
            <Button variant="primary" onClick={onStart} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              启动
            </Button>
          ) : (
            <Button variant="secondary" onClick={onStop} disabled={loading || status === 'starting'}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
              停止
            </Button>
          )}
        </div>

        {status === 'error' && error && (
          <div className="mt-3 flex items-start gap-2 rounded-sm bg-surface-danger/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* 配置 */}
      <Section title="配置">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="w-12 flex-shrink-0 text-xs text-muted-foreground">端口</label>
            <input
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(e) => onPortChange(Number(e.target.value))}
              onBlur={onPortSave}
              className="h-9 w-24 rounded-sm border border-transparent bg-surface-subtle px-3 font-mono text-sm focus:border-accent-border/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            />
            <span className="text-xs text-muted-foreground">修改后重启生效</span>
          </div>
          <Divider />
          <SettingRow
            title="随应用启动"
            description="打开应用时自动启动本地 Relay"
            control={<Switch checked={autoStart} onChange={onAutoStart} />}
          />
        </div>
      </Section>

      {/* 诊断日志 —— 折叠 */}
      <Section title="诊断">
        <button
          onClick={() => setLogsExpanded((v) => !v)}
          className="flex w-full items-center justify-between rounded-sm px-1 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={logsExpanded}
        >
          <span>运行日志（最近 {logs.length} 行）</span>
          {logsExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        {logsExpanded && (
          <div
            ref={logRef}
            className="mt-2 h-44 overflow-y-auto rounded-sm bg-surface-subtle p-2 font-mono text-xs text-muted-foreground"
          >
            {logs.length === 0 ? (
              <span className="text-muted-foreground/50">暂无日志</span>
            ) : (
              logs.map((line, i) => <div key={i}>{line}</div>)
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
