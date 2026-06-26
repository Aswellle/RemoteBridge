'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutDashboard, FolderOpen, MessageSquare, ShieldCheck, Settings, Menu, X, Unlink } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { initTheme } from '@/lib/theme';

const NAV_ITEMS = [
  { href: '/dashboard', label: '概览', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/files', label: '文件浏览', icon: FolderOpen },
  { href: '/dashboard/messages', label: '消息', icon: MessageSquare },
  { href: '/dashboard/security', label: '安全审计', icon: ShieldCheck },
  { href: '/dashboard/settings', label: '设置', icon: Settings },
];

type ConnectionStatus = ReturnType<typeof useAppStore.getState>['connectionStatus'];

// ===== 侧边栏内容 =====
// 必须是模块级组件：若定义在 DashboardLayout 函数体内，每次渲染都会产生新的
// 组件类型，React 会整棵卸载重建侧边栏 —— framer-motion 的 layoutId 指示条
// 因此丢失上一位置，切换标签时动画总是从顶部飘下来。
// indicatorId 区分桌面/移动两个实例，避免 layoutId 冲突。
function SidebarContent({
  indicatorId,
  pathname,
  connectionStatus,
  unreadCount,
  onNavClick,
  onDisconnect,
  onClose,
}: {
  indicatorId: string;
  pathname: string;
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  onNavClick: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const isActive = (item: (typeof NAV_ITEMS)[0]) => {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  };

  return (
    <>
      {/* Logo */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-primary">RemoteBridge</h1>
          <p className="text-xs text-muted-foreground mt-1">Web Client</p>
        </div>
        {/* Close button - mobile only */}
        <button
          onClick={onClose}
          className="lg:hidden p-1 rounded hover:bg-secondary text-muted-foreground"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* 导航（始终可见 —— 不依赖连接状态，重连期间也能正常切换页面） */}
      <nav className="flex-1 mt-2" role="navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.href}
              whileHover={{ x: 4 }}
              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
            >
              <Link
                href={item.href}
                onClick={onNavClick}
                aria-current={isActive(item) ? 'page' : undefined}
                className={`relative flex items-center px-4 py-3 transition-colors ${
                  isActive(item)
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                {/* 活跃指示条 */}
                {isActive(item) && (
                  <motion.div
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-primary rounded-r"
                    layoutId={indicatorId}
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <Icon className="w-5 h-5 mr-3 flex-shrink-0" />
                <span className="text-sm font-medium">{item.label}</span>

                {/* 消息未读数 */}
                {item.href === '/dashboard/messages' && unreadCount > 0 && (
                  <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </Link>
            </motion.div>
          );
        })}
      </nav>

      {/* 底部: 连接状态 + 断开 */}
      <div className="p-4 border-t border-border">
        <div className="flex items-center mb-3" aria-live="polite">
          <div
            className={`w-2 h-2 rounded-full mr-2 ${
              connectionStatus === 'connected'
                ? 'bg-green-500 animate-pulse'
                : connectionStatus === 'connecting'
                ? 'bg-yellow-500 animate-pulse'
                : connectionStatus === 'error'
                ? 'bg-red-500'
                : 'bg-muted-foreground'
            }`}
          />
          <span className="text-xs text-muted-foreground">
            {connectionStatus === 'connected'
              ? '已连接'
              : connectionStatus === 'connecting'
              ? '连接中...'
              : connectionStatus === 'error'
              ? '连接错误'
              : '未连接'}
          </span>
        </div>

        {connectionStatus === 'connected' && (
          <button
            onClick={onDisconnect}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-destructive/20 hover:bg-destructive/40 text-destructive text-sm rounded-lg transition-colors"
          >
            <Unlink className="w-4 h-4" />
            断开连接
          </button>
        )}

        {connectionStatus !== 'connected' && (
          <Link
            href="/"
            className="block w-full px-3 py-2 bg-primary/20 hover:bg-primary/40 text-primary text-sm rounded-lg transition-colors text-center"
          >
            返回连接页
          </Link>
        )}
      </div>
    </>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { connectionStatus, sessionId, disconnect, unreadCount } = useAppStore();
  const { connect: wsConnect, disconnect: wsDisconnect } = useWebSocket();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 应用持久化主题（设置页切换时即时生效，这里保证刷新/直达不丢）
  useEffect(() => {
    initTheme();
  }, []);

  // 进入 dashboard 时若已有会话（含刷新页面后从 localStorage 恢复的会话）则建立 WS 连接
  // sessionId 存在说明已认证（token 在 httpOnly cookie 中，无需 JS 可读，02a-S11）
  useEffect(() => {
    if (sessionId && connectionStatus !== 'connected') {
      useAppStore.getState().setConnectionStatus('connecting');
      wsConnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const handleDisconnect = () => {
    wsDisconnect();
    disconnect();
    // 断开后留在 dashboard 只剩一屏失效数据 —— 直接回连接页
    router.push('/');
  };

  const handleNavClick = () => {
    // Close sidebar on mobile after nav click
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-64 bg-card border-r border-border flex-col flex-shrink-0">
        <SidebarContent
          indicatorId="sidebar-indicator-desktop"
          pathname={pathname}
          connectionStatus={connectionStatus}
          unreadCount={unreadCount}
          onNavClick={handleNavClick}
          onDisconnect={handleDisconnect}
          onClose={() => setSidebarOpen(false)}
        />
      </aside>

      {/* Mobile hamburger */}
      <div className="lg:hidden fixed top-0 left-0 z-40 p-3">
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Toggle navigation"
          className="p-2 rounded-lg bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* Mobile sidebar overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              className="fixed inset-0 z-40 bg-black/60 lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
            />
            {/* Slide-in sidebar */}
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col lg:hidden"
              role="dialog"
              aria-label="Navigation menu"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 350, damping: 35 }}
            >
              <SidebarContent
                indicatorId="sidebar-indicator-mobile"
                pathname={pathname}
                connectionStatus={connectionStatus}
                unreadCount={unreadCount}
                onNavClick={handleNavClick}
                onDisconnect={handleDisconnect}
                onClose={() => setSidebarOpen(false)}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* 主内容区 */}
      <main className="flex-1 min-w-0 overflow-auto">{children}</main>
    </div>
  );
}
