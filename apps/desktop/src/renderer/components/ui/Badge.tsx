/**
 * Badge —— 统一状态标签原语
 *
 * 设计规范 (Spec §14):
 * - semantic color 仅表示状态，不作装饰
 * - Success=green / Warning=amber / Danger=red / Info=brand blue / Neutral=gray
 * - 浅色 capsule 风格
 */

import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-surface-subtle text-muted-foreground',
  info: 'bg-accent-surface/10 text-accent-text',
  success: 'bg-surface-success/10 text-success',
  warning: 'bg-surface-warning/10 text-warning',
  danger: 'bg-surface-danger/10 text-destructive',
};

export function Badge({ tone = 'neutral', children, className = '' }: BadgeProps) {
  return (
    <span
      className={
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ' +
        toneClasses[tone] +
        (className ? ' ' + className : '')
      }
    >
      {children}
    </span>
  );
}
