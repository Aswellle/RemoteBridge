/**
 * StatusDot —— 统一状态指示灯原语
 *
 * 设计规范 (Spec §16):
 * - 在线圆点约 6px（克制）
 * - 5 种状态: online / offline / connecting / warning / error
 */

export type Status = 'online' | 'offline' | 'connecting' | 'warning' | 'error';

export interface StatusDotProps {
  status: Status;
  label?: string;
  className?: string;
}

const statusClasses: Record<Status, string> = {
  online: 'bg-success',
  offline: 'bg-muted-foreground/40',
  connecting: 'bg-warning animate-pulse',
  warning: 'bg-warning',
  error: 'bg-destructive',
};

export function StatusDot({ status, label, className = '' }: StatusDotProps) {
  return (
    <span
      className={'inline-flex items-center gap-1.5 ' + (className || '')}
      role="status"
      aria-label={label || status}
    >
      <span
        className={
          'inline-block size-1.5 flex-shrink-0 rounded-full ' + statusClasses[status]
        }
      />
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
    </span>
  );
}
