'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Wifi, Monitor, MessageSquare, Download, FolderOpen, ShieldCheck, ArrowUp, ArrowDown, Info, LinkIcon, FileText } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAppStore } from '@/store/app-store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { formatRelativeTime } from '@remotebridge/shared';

const statCardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      delay: i * 0.1,
      duration: 0.4,
      ease: [0.25, 0.46, 0.45, 0.94],
    },
  }),
};

const quickActionVariants = {
  hidden: { opacity: 0, y: 15 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.4 + i * 0.1, duration: 0.35 },
  }),
};

export default function DashboardPage() {
  const {
    connectionStatus,
    hostInfo,
    messages,
    activeDownloads,
    unreadCount,
    sessionId,
  } = useAppStore();
  const { connect } = useWebSocket();

  // 建立 WebSocket 连接
  useEffect(() => {
    if (connectionStatus === 'connected' && sessionId) {
      connect();
    }
  }, [connectionStatus, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 最近 5 条消息
  const recentMessages = messages.slice(-5);

  // 未连接时显示提示
  if (connectionStatus !== 'connected') {
    return (
      <div className="p-8">
        <Skeleton className="h-8 w-40 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-card rounded-xl p-5 border border-border/50">
              <div className="flex items-center justify-between mb-3">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-8 w-8 rounded-lg" />
              </div>
              <Skeleton className="h-6 w-24 mb-2" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="h-6 w-24 mb-4" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-card rounded-xl p-5 border border-border/50">
              <Skeleton className="h-10 w-10 rounded-lg mb-3" />
              <Skeleton className="h-5 w-20 mb-2" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h2 className="text-2xl font-semibold mb-6">连接概览</h2>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {/* 连接状态 */}
        <motion.div
          className="bg-card rounded-xl p-5 border border-border/50"
          aria-label="连接状态: 已连接"
          custom={0}
          variants={statCardVariants}
          initial="hidden"
          animate="visible"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">连接状态</span>
            <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
              <Wifi className="w-4 h-4 text-success" />
            </div>
          </div>
          <p className="text-lg font-semibold text-success">已连接</p>
          <p className="text-xs text-muted-foreground mt-1">WebSocket 活跃</p>
        </motion.div>

        {/* 远程主机 */}
        <motion.div
          className="bg-card rounded-xl p-5 border border-border/50"
          aria-label={`远程主机: ${hostInfo?.name || '未知主机'}`}
          custom={1}
          variants={statCardVariants}
          initial="hidden"
          animate="visible"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">远程主机</span>
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Monitor className="w-4 h-4 text-primary" />
            </div>
          </div>
          <p className="text-lg font-semibold text-foreground truncate">
            {hostInfo?.name || '未知主机'}
          </p>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            {hostInfo?.os || '-'}
          </p>
        </motion.div>

        {/* 消息数 */}
        <motion.div
          className="bg-card rounded-xl p-5 border border-border/50"
          aria-label={`消息数: ${messages.length}`}
          custom={2}
          variants={statCardVariants}
          initial="hidden"
          animate="visible"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">消息数</span>
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <MessageSquare className="w-4 h-4 text-purple-400" />
            </div>
          </div>
          <p className="text-lg font-semibold text-foreground">{messages.length}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {unreadCount > 0 ? `${unreadCount} 条未读` : '全部已读'}
          </p>
        </motion.div>

        {/* 下载数 */}
        <motion.div
          className="bg-card rounded-xl p-5 border border-border/50"
          aria-label={`活跃下载: ${activeDownloads.length}`}
          custom={3}
          variants={statCardVariants}
          initial="hidden"
          animate="visible"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">活跃下载</span>
            <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
              <Download className="w-4 h-4 text-orange-400" />
            </div>
          </div>
          <p className="text-lg font-semibold text-foreground">{activeDownloads.length}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {activeDownloads.filter(d => d.status === 'downloading').length} 个进行中
          </p>
        </motion.div>
      </div>

      {/* 快速操作区 */}
      <div className="mb-8">
        <h3 className="text-lg font-medium text-foreground mb-4">快速操作</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <motion.div custom={0} variants={quickActionVariants} initial="hidden" animate="visible">
            <Link
              href="/dashboard/files"
              aria-label="浏览文件"
              className="group block bg-card rounded-xl p-5 border border-border/50 hover:border-primary/50 transition-all"
            >
              <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center mb-3 group-hover:bg-primary/30 transition-colors">
                <FolderOpen className="w-5 h-5 text-primary" />
              </div>
              <p className="font-medium text-foreground">浏览文件</p>
              <p className="text-sm text-muted-foreground mt-1">查看和下载远程文件</p>
            </Link>
          </motion.div>

          <motion.div custom={1} variants={quickActionVariants} initial="hidden" animate="visible">
            <Link
              href="/dashboard/messages"
              aria-label="发送消息"
              className="group block bg-card rounded-xl p-5 border border-border/50 hover:border-purple-500/50 transition-all"
            >
              <div className="w-10 h-10 rounded-lg bg-purple-600/20 flex items-center justify-center mb-3 group-hover:bg-purple-600/30 transition-colors">
                <MessageSquare className="w-5 h-5 text-purple-400" />
              </div>
              <p className="font-medium text-foreground">发送消息</p>
              <p className="text-sm text-muted-foreground mt-1">与远程主机实时通信</p>
            </Link>
          </motion.div>

          <motion.div custom={2} variants={quickActionVariants} initial="hidden" animate="visible">
            <Link
              href="/dashboard/security"
              aria-label="安全审计"
              className="group block bg-card rounded-xl p-5 border border-border/50 hover:border-indigo-500/50 transition-all"
            >
              <div className="w-10 h-10 rounded-lg bg-indigo-600/20 flex items-center justify-center mb-3 group-hover:bg-indigo-600/30 transition-colors">
                <ShieldCheck className="w-5 h-5 text-indigo-400" />
              </div>
              <p className="font-medium text-foreground">安全审计</p>
              <p className="text-sm text-muted-foreground mt-1">查看安全事件日志</p>
            </Link>
          </motion.div>
        </div>
      </div>

      {/* 最近活动 */}
      <div>
        <h3 className="text-lg font-medium text-foreground mb-4">最近活动</h3>
        <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
          {recentMessages.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <motion.div
                animate={{ y: [0, -6, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                className="inline-block"
              >
                <MessageSquare className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
              </motion.div>
              <p>暂无消息记录</p>
              <p className="text-sm mt-1">消息交互将在这里显示</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/50" role="list">
              {recentMessages.map((msg) => (
                <li key={msg.id} className="px-5 py-3.5 flex items-center gap-4 hover:bg-secondary/30 transition-colors">
                  {/* 方向指示 */}
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    msg.direction === 'client_to_host'
                      ? 'bg-primary/20 text-primary'
                      : msg.type === 'system'
                      ? 'bg-yellow-600/20 text-yellow-400'
                      : 'bg-success/20 text-success'
                  }`}>
                    {msg.direction === 'client_to_host' ? (
                      <ArrowUp className="w-4 h-4" />
                    ) : msg.type === 'system' ? (
                      <Info className="w-4 h-4" />
                    ) : (
                      <ArrowDown className="w-4 h-4" />
                    )}
                  </div>

                  {/* 消息内容 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{msg.content}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {msg.direction === 'client_to_host' ? '已发送' : msg.type === 'system' ? '系统' : '收到'}
                    </p>
                  </div>

                  {/* 时间 */}
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {formatRelativeTime(msg.timestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
