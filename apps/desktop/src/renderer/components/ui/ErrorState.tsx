/**
 * ErrorState —— 错误状态原语
 *
 * 设计规范 (Spec §36):
 * - 统一的错误展示: icon + title + description + retry action
 * - 轻量错误用 surface + icon，不用厚红框
 */
import type { ReactNode } from 'react';

export interface ErrorStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function ErrorState({ icon, title, description, action }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-surface-danger/10 text-destructive [&>svg]:size-6">
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
