'use client';

import Link from 'next/link';
import { WifiOff, type LucideIcon } from 'lucide-react';

interface NotConnectedProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
}

export default function NotConnected({
  icon: Icon = WifiOff,
  title = '未连接到远程主机',
  description = '请先在连接页面输入连接码，建立与远程主机的连接',
}: NotConnectedProps) {
  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center max-w-xs">
        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-5">
          <Icon className="w-8 h-8 text-muted-foreground" />
        </div>
        <p className="text-base font-semibold text-foreground mb-2">{title}</p>
        <p className="text-sm text-muted-foreground mb-6 leading-relaxed">{description}</p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary/90 text-white text-sm font-medium rounded-lg transition-colors"
        >
          前往连接
        </Link>
      </div>
    </div>
  );
}
