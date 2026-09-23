/**
 * Connection 设置页
 *
 * 设计规范 (Spec §26, §31):
 * - Relay server: Server address + API endpoint
 * - Connection status block (只读)
 * - 显式保存模式: 修改后显示 [Discard] [Save] footer
 */
import { Section, Input, StatusDot, Button } from '../components/ui';
import { Plug, ArrowRight } from 'lucide-react';
import type { LocalRelayState } from './types';

export interface ConnectionSettingsProps {
  relayUrl: string;
  relayApiUrl: string;
  onRelayUrlChange: (val: string) => void;
  onRelayApiUrlChange: (val: string) => void;
  lrStatus: LocalRelayState;
  lrPort: number;
  configUrlPointsToLocal: boolean;
  hasDraft: boolean;
  isSaving: boolean;
  saveStatus: 'idle' | 'success' | 'error';
  statusMessage: string;
  onSave: () => void;
  onDiscard: () => void;
  onFillLocal: () => void;
}

const STATUS_LABEL: Record<LocalRelayState, string> = {
  stopped: '未连接',
  starting: '连接中…',
  running: '已连接',
  error: '错误',
};

export function ConnectionSettings({
  relayUrl,
  relayApiUrl,
  onRelayUrlChange,
  onRelayApiUrlChange,
  lrStatus,
  lrPort,
  configUrlPointsToLocal,
  hasDraft,
  isSaving,
  saveStatus,
  statusMessage,
  onSave,
  onDiscard,
  onFillLocal,
}: ConnectionSettingsProps) {
  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">连接</h2>
        <p className="mt-1 text-sm text-muted-foreground">Relay 服务器地址配置</p>
      </header>

      <Section title="Relay 服务器">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">服务器地址</label>
            <Input
              value={relayUrl}
              onChange={(e) => onRelayUrlChange(e.target.value)}
              placeholder="wss://example.com/ws"
              className="font-mono"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">API 端点</label>
            <Input
              value={relayApiUrl}
              onChange={(e) => onRelayApiUrlChange(e.target.value)}
              placeholder="https://example.com/api/v1"
              className="font-mono"
            />
          </div>
        </div>
      </Section>

      {/* 连接状态 */}
      <Section title="连接状态">
        <div className="flex items-center gap-2">
          <StatusDot status={lrStatus === 'running' ? 'online' : lrStatus === 'error' ? 'error' : 'offline'} />
          <span className="text-sm">{STATUS_LABEL[lrStatus]}</span>
          {lrStatus === 'running' && (
            <span className="font-mono text-xs text-muted-foreground">:{lrPort}</span>
          )}
        </div>
      </Section>

      {/* 本地 Relay 指向提示 */}
      {configUrlPointsToLocal && (
        <div className="mt-3 flex items-start gap-2 rounded-sm bg-surface-warning/10 px-3 py-2 text-xs text-warning">
          <Plug className="mt-0.5 size-3.5 flex-shrink-0" />
          <span>
            上方 Relay 地址指向本机 :{lrPort}，但本地 Relay 尚未启动。
            <button
              onClick={onFillLocal}
              className="ml-1 inline-flex items-center gap-0.5 font-medium text-accent-text underline-offset-2 hover:underline"
            >
              填充本地地址 <ArrowRight className="size-3" />
            </button>
          </span>
        </div>
      )}

      {/* 保存状态反馈 */}
      {saveStatus === 'success' && (
        <p className="mt-3 text-sm text-success">{statusMessage || '已保存'}</p>
      )}
      {saveStatus === 'error' && (
        <p className="mt-3 text-sm text-destructive">{statusMessage || '保存失败'}</p>
      )}

      {/* 操作按钮 */}
      {hasDraft && (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="ghost" onClick={onDiscard}>丢弃</Button>
          <Button variant="primary" onClick={onSave} disabled={isSaving}>
            {isSaving ? '保存中...' : '保存'}
          </Button>
        </div>
      )}
    </div>
  );
}
