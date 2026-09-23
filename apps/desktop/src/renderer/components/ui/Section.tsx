/**
 * Section —— 设置页 / 内容区块原语
 *
 * 设计规范 (Spec §22):
 * - Section title + small description
 * - 不再默认 Card
 * - 需要时才用极淡 separator
 */
import type { ReactNode } from 'react';

export interface SectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function Section({ title, description, children, className = '' }: SectionProps) {
  return (
    <section className={'mb-6 ' + className}>
      <header className="mb-3">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      <div className="space-y-1">{children}</div>
    </section>
  );
}
