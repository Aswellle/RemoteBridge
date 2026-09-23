/**
 * Toast —— 轻量消息通知原语
 *
 * 设计规范 (Spec §34):
 * - 成功保存 → subtle toast
 * - 连接失败 → 引导用户下一步操作（非仅显示"失败"）
 * - 不使用重型 toast 库，内联实现
 */
import { useEffect, useState } from 'react';
import { X, Info, AlertTriangle, CheckCircle2 } from 'lucide-react';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastMessage {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

let toastId = 0;
const listeners: Array<(t: ToastMessage) => void> = [];

export function showToast(
  variant: ToastVariant,
  title: string,
  description?: string,
  action?: ToastMessage['action'],
): void {
  const msg: ToastMessage = { id: ++toastId, variant, title, description, action };
  listeners.forEach((fn) => fn(msg));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handler = (t: ToastMessage) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 8000);
    };
    listeners.push(handler);
    return () => {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2" role="region" aria-label="通知">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onClose={() => setToasts((p) => p.filter((x) => x.id !== t.id))} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const variantStyles: Record<ToastVariant, { box: string; icon: React.ReactNode }> = {
    info: { box: 'bg-surface-raised border-accent-border/20', icon: <Info className="size-4 text-accent-text" /> },
    success: { box: 'bg-surface-raised border-success/20', icon: <CheckCircle2 className="size-4 text-success" /> },
    warning: { box: 'bg-surface-raised border-warning/20', icon: <AlertTriangle className="size-4 text-warning" /> },
    error: { box: 'bg-surface-raised border-danger/20', icon: <AlertTriangle className="size-4 text-destructive" /> },
  };
  const v = variantStyles[toast.variant];

  return (
    <div
      className={`flex w-80 items-start gap-3 rounded-lg border p-3 shadow-lg ${v.box}`}
      role="alert"
    >
      <span className="mt-0.5 flex-shrink-0">{v.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{toast.title}</p>
        {toast.description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{toast.description}</p>
        )}
        {toast.action && (
          <button
            onClick={() => { toast.action!.onClick(); onClose(); }}
            className="mt-2 text-xs font-medium text-accent-text underline-offset-2 hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button onClick={onClose} className="flex-shrink-0 text-muted-foreground hover:text-foreground">
        <X className="size-4" />
      </button>
    </div>
  );
}
