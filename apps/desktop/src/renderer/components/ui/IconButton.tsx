/**
 * IconButton —— 纯图标按钮原语
 *
 * 设计规范 (Spec §11):
 * - min-size: 32×32
 * - 图标 14-16px
 * - 必须有 aria-label
 * - hover / focus-visible 状态
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, className = '', ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={
        'inline-flex size-8 items-center justify-center rounded-sm ' +
        'text-muted-foreground transition-colors duration-120 ' +
        'hover:bg-surface-hover hover:text-foreground ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ' +
        'disabled:pointer-events-none disabled:opacity-40 ' +
        className
      }
      {...rest}
    >
      {icon}
    </button>
  ),
);

IconButton.displayName = 'IconButton';
