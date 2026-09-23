/**
 * Input —— 统一输入框原语
 *
 * 设计规范 (Spec §12):
 * - height: 36px, radius: 8px (radius-sm)
 * - padding: 10px 12px
 * - surface: subtle
 * - border: transparent（默认无边框）
 * - focus: accent ring + subtle accent border
 *
 * 原则: 默认不要边框，靠 focus ring 表达状态
 */
import { forwardRef, type InputHTMLAttributes } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => (
    <input
      ref={ref}
      className={
        'h-9 w-full rounded-sm bg-surface-subtle px-3 py-2 text-sm text-foreground ' +
        'placeholder:text-muted-foreground/60 border border-transparent ' +
        'transition-colors duration-120 ' +
        'focus:border-accent-border/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        className
      }
      {...rest}
    />
  ),
);

Input.displayName = 'Input';
