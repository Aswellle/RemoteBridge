'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Shield, Monitor, Loader2, Clock, ChevronRight, History } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/app-store';
import { initTheme } from '@/lib/theme';

interface HostHistoryEntry {
  hostId: string;
  name: string;
  os: string;
  lastConnected: number;
}

export default function HomePage() {
  const router = useRouter();
  const { connect, connectionStatus, sessionId } = useAppStore();
  const [pin, setPin] = useState('');
  const [clientLabel, setClientLabel] = useState('我的设备');
  const [hostHistory, setHostHistory] = useState<HostHistoryEntry[]>([]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      initTheme();
      try {
        const stored = localStorage.getItem('host-history');
        if (stored) setHostHistory((JSON.parse(stored) as HostHistoryEntry[]).slice(0, 8));
      } catch {}
      const savedLabel = localStorage.getItem('clientLabel');
      if (savedLabel) setClientLabel(savedLabel);
    }
  }, []);

  // 被动回到连接页时说明原因
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'revoked') toast.error('会话已被主机吊销', { description: '请在主机端重新生成连接码' });
    else if (reason === 'expired') toast.error('会话已过期', { description: '请重新输入连接码' });
    if (reason) window.history.replaceState(null, '', '/');
  }, []);

  // 已有 session → 直接跳转
  useEffect(() => {
    if (sessionId) router.push('/dashboard');
  }, [sessionId, router]);

  useEffect(() => {
    if (connectionStatus === 'connected') router.push('/dashboard');
  }, [connectionStatus, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pin.length !== 8) { toast.error('请输入 8 位连接码'); return; }
    try {
      if (typeof window !== 'undefined' && clientLabel.trim())
        localStorage.setItem('clientLabel', clientLabel.trim());
      await connect(pin, clientLabel);
    } catch {}
  };

  const formatPin = (value: string) => {
    const clean = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return clean.length <= 4 ? clean : `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
  };

  const handlePinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/-/g, '').toUpperCase();
    if (raw.length <= 8) setPin(raw);
  };

  const handleQuickConnect = (entry: HostHistoryEntry) => {
    toast.info(`请在「${entry.name}」的 RemoteBridge 应用中生成新连接码`, {
      description: '连接码为一次性使用，每次连接需重新生成',
    });
  };

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-background to-secondary/40">

      {/* ===== 左侧：设备历史面板 ===== */}
      <div className="hidden lg:flex w-72 xl:w-80 flex-shrink-0 border-r border-border/50 bg-card/60 flex-col p-6">
        {/* 品牌标识 */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-primary">RemoteBridge</h1>
          <p className="text-xs text-muted-foreground mt-1">远程文件桥接系统</p>
        </div>

        {/* 设备列表标题 */}
        <div className="flex items-center gap-2 mb-4">
          <History className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">最近连接的设备</span>
        </div>

        {/* 设备卡片列表 */}
        {hostHistory.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
            <Monitor className="w-10 h-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">暂无连接记录</p>
            <p className="text-xs text-muted-foreground/70 mt-1">首次连接后记录将显示在此处</p>
          </div>
        ) : (
          <div className="space-y-2 flex-1 overflow-y-auto">
            {hostHistory.map((entry) => (
              <motion.button
                key={entry.hostId}
                onClick={() => handleQuickConnect(entry)}
                className="w-full flex items-center gap-3 p-3 bg-background/60 hover:bg-secondary/80 border border-border/50 hover:border-primary/40 rounded-xl transition-all group text-left"
                whileHover={{ x: 2 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              >
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Monitor className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{entry.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{entry.os || '未知系统'}</p>
                  <p className="text-xs text-muted-foreground/60 mt-0.5 flex items-center gap-1">
                    <Clock className="w-2.5 h-2.5" />
                    {formatDate(entry.lastConnected)}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary flex-shrink-0 transition-colors" />
              </motion.button>
            ))}
          </div>
        )}

        {/* 底部安全说明 */}
        <div className="mt-6 pt-4 border-t border-border/40">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 flex-shrink-0" />
            安全连接 · 端到端加密 · 无需开放端口
          </p>
        </div>
      </div>

      {/* ===== 右侧：连接表单 ===== */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <motion.div
            className="text-center mb-8"
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <h2 className="text-2xl font-bold text-foreground">连接到远程电脑</h2>
            <p className="text-sm text-muted-foreground mt-2">在桌面端 RemoteBridge 生成连接码后输入</p>
          </motion.div>

          <motion.div
            className="bg-card rounded-2xl shadow-xl p-8"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* PIN 输入框 */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">连接码</label>
                <input
                  type="text"
                  value={formatPin(pin)}
                  onChange={handlePinChange}
                  placeholder="XXXX-XXXX"
                  className="w-full px-4 py-3 bg-secondary border border-border rounded-lg text-foreground text-center text-2xl font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  maxLength={9}
                  autoComplete="off"
                  autoFocus
                />
                <p className="mt-1.5 text-xs text-muted-foreground">8 位字母+数字，在桌面应用中获取</p>
              </div>

              {/* 设备标签 */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">本设备名称</label>
                <input
                  type="text"
                  value={clientLabel}
                  onChange={(e) => setClientLabel(e.target.value)}
                  placeholder="我的设备"
                  className="w-full px-4 py-3 bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                />
              </div>

              {/* 连接按钮 */}
              <button
                type="submit"
                disabled={connectionStatus === 'connecting' || pin.length !== 8}
                className="w-full py-3 bg-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors flex items-center justify-center"
              >
                {connectionStatus === 'connecting' ? (
                  <><Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" />连接中...</>
                ) : '连接'}
              </button>
            </form>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
