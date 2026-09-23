'use client';

import { useEffect, useCallback, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, RotateCw, Info, Download } from 'lucide-react';

// ===== Keyboard Shortcuts =====

export interface PreviewShortcuts {
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onReset?: () => void;
  onRotate?: () => void;
  onToggleInfo?: () => void;
  onDownload?: () => void;
}

const KEYBINDINGS: { key: string; action: keyof PreviewShortcuts; label: string }[] = [
  { key: 'Escape', action: 'onClose', label: '关闭' },
  { key: 'ArrowLeft', action: 'onPrev', label: '上一个' },
  { key: 'ArrowRight', action: 'onNext', label: '下一个' },
  { key: '+', action: 'onZoomIn', label: '放大' },
  { key: '-', action: 'onZoomOut', label: '缩小' },
  { key: '0', action: 'onReset', label: '重置' },
  { key: 'f', action: 'onReset', label: '适应' },
  { key: 'r', action: 'onRotate', label: '旋转' },
  { key: 'i', action: 'onToggleInfo', label: '信息' },
  { key: 'd', action: 'onDownload', label: '下载' },
];

// ===== Preview Shell Hook =====

export function usePreviewKeyboard(shortcuts: PreviewShortcuts, enabled: boolean = true) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't capture when typing in inputs
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    const binding = KEYBINDINGS.find((b) => b.key === e.key);
    if (!binding) return;

    const action = shortcutsRef.current[binding.action];
    if (action) {
      e.preventDefault();
      action();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleKeyDown]);
}

// ===== Reduced Motion Hook =====

export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return reducedMotion;
}

// Need useState import
import { useState } from 'react';

// ===== Toolbar Button Component =====

interface ToolbarButtonProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

export function ToolbarButton({ icon, label, shortcut, onClick, active, disabled }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`p-2 rounded transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center ${
        active
          ? 'bg-primary text-white'
          : 'hover:bg-secondary text-muted-foreground hover:text-foreground'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {icon}
    </button>
  );
}

// ===== Keyboard Shortcuts Help =====

export function ShortcutsHelp() {
  return (
    <div className="text-xs text-muted-foreground space-y-1">
      <div className="font-medium text-foreground mb-2">键盘快捷键</div>
      {KEYBINDINGS.map((b) => (
        <div key={b.key} className="flex justify-between gap-4">
          <span>{b.label}</span>
          <kbd className="px-1.5 py-0.5 bg-secondary rounded text-[10px] font-mono">{b.key}</kbd>
        </div>
      ))}
    </div>
  );
}
