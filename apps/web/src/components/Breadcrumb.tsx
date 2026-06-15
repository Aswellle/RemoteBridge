'use client';

import { Folder } from 'lucide-react';

interface BreadcrumbItem {
  name: string;
  path: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  onNavigate: (path: string) => void;
}

export default function Breadcrumb({ items, onNavigate }: BreadcrumbProps) {
  if (items.length === 0) {
    return (
      <div className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Folder className="w-4 h-4" />
        <span>/</span>
      </div>
    );
  }

  return (
    <nav className="flex items-center space-x-1 text-sm overflow-x-auto">
      <Folder className="w-4 h-4 text-muted-foreground mr-1" />

      {items.map((item, index) => (
        <span key={item.path} className="flex items-center">
          {index > 0 && <span className="text-muted-foreground mx-1">/</span>}

          {index === items.length - 1 ? (
            // 当前目录（不可点击）
            <span className="text-foreground font-medium">{item.name}</span>
          ) : (
            // 可点击的上级目录
            <button
              onClick={() => onNavigate(item.path)}
              className="text-primary hover:text-primary/80 hover:underline transition-colors"
            >
              {item.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
