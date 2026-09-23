/**
 * EmptyState —— 空状态原语
 *
 * 设计规范 (Spec §33):
 * - 统一 icon container 尺寸、文字间距、颜色
 * - icon + title + description + action
 */
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-surface-subtle text-muted-foreground [&>svg]:size-6">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
