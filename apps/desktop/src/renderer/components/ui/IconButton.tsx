/**
 * IconButton —— 纯图标按钮原语
 *
 * 设计规范 (Spec §11):
 * - min-size: 32×32
 * - 图标 14-16px
 * - 必须有 aria-label
 * - hover / focus-visible 状态
 *
 * 可见性：静息态必须有可见的 surface，否则图标与背景融为一体，
 * 用户看不出这里可以操作（此前为透明静息态，行内"编辑/移除"按钮在未悬浮时不可辨识）。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonTone = 'neutral' | 'danger';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  /** 语义色：danger 用于移除/吊销等破坏性操作 */
  tone?: IconButtonTone;
}

const tones: Record<IconButtonTone, string> = {
  // 静息：surface-subtle + secondary 文字（实测亮色 12.5:1 / 暗色 9.7:1）
  neutral:
    'bg-surface-subtle text-secondary-foreground ' +
    'hover:bg-surface-hover hover:text-foreground',
  danger:
    'bg-surface-subtle text-secondary-foreground ' +
    'hover:bg-surface-danger/15 hover:text-destructive',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, tone = 'neutral', className = '', ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={
        'inline-flex size-8 flex-shrink-0 items-center justify-center rounded-sm ' +
        'transition-colors duration-120 ' +
        `${tones[tone]} ` +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ' +
        'disabled:bg-surface-subtle disabled:text-muted-foreground/50 disabled:pointer-events-none ' +
        className
      }
      {...rest}
    >
      {icon}
    </button>
  ),
);

IconButton.displayName = 'IconButton';
