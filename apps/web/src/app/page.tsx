'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Monitor, Loader2, Clock, ChevronRight } from 'lucide-react';
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

  // Load host history + saved client label from localStorage; apply persisted theme
  useEffect(() => {
    if (typeof window !== 'undefined') {
      initTheme();
      try {
        const stored = localStorage.getItem('host-history');
        if (stored) {
          const history = JSON.parse(stored) as HostHistoryEntry[];
          setHostHistory(history.slice(0, 5));
        }
      } catch {}
      // 设置页保存的设备标签 → 连接时自动使用
      const savedLabel = localStorage.getItem('clientLabel');
      if (savedLabel) setClientLabel(savedLabel);
    }
  }, []);

  // 被动回到连接页时说明原因（会话被吊销/过期），否则用户只看到莫名被踢回首页
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'revoked') {
      toast.error('会话已被主机吊销', { description: '请在主机端重新生成连接码' });
    } else if (reason === 'expired') {
      toast.error('会话已过期', { description: '请重新输入连接码' });
    }
    if (reason) {
      // 清掉 query，避免刷新重复提示
      window.history.replaceState(null, '', '/');
    }
  }, []);

  // 已有 session 时自动跳转
  useEffect(() => {
    if (sessionId) {
      router.push('/dashboard');
    }
  }, [sessionId, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (pin.length !== 8) {
      toast.error('请输入 8 位连接码');
      return;
    }

    try {
      // 记住本次输入的设备标签，下次连接与设置页共用
      if (typeof window !== 'undefined' && clientLabel.trim()) {
        localStorage.setItem('clientLabel', clientLabel.trim());
      }
      await connect(pin, clientLabel);
    } catch {
      // error toast is already handled by the store
    }
  };

  // 连接状态变化时跳转
  // （连接失败的 toast 由 store.connect 统一弹出，带服务端返回的具体原因，
  // 这里不再重复弹一个泛化提示）
  useEffect(() => {
    if (connectionStatus === 'connected') {
      router.push('/dashboard');
    }
  }, [connectionStatus, router]);

  // 格式化 PIN 显示 (XXXX-XXXX)
  const formatPin = (value: string) => {
    const clean = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (clean.length <= 4) return clean;
    return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
  };

  const handlePinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/-/g, '');
    if (raw.length <= 8) {
      setPin(raw);
    }
  };

  // 历史记录只是提示用户之前连过哪台主机；PIN 是一次性的，
  // 必须在主机端重新生成（hostId 不是连接码，不能填进 PIN 输入框）
  const handleQuickConnect = (entry: HostHistoryEntry) => {
    toast.info(`请在「${entry.name}」的 RemoteBridge 应用中生成新连接码`, {
      description: '连接码为一次性使用，每次连接需重新生成',
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-secondary/40">
      <div className="w-full max-w-md p-8">
        {/* Logo 和标题 */}
        <motion.div
          className="text-center mb-8"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-4xl font-bold text-primary mb-2">RemoteBridge</h1>
          <p className="text-muted-foreground">远程文件桥接系统</p>
        </motion.div>

        {/* 连接表单 */}
        <motion.div
          className="bg-card rounded-2xl shadow-xl p-8"
          initial={{ opacity: 0, y: 30, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.15 }}
        >
          <h2 className="text-xl font-semibold text-foreground mb-6 text-center">
            连接到远程电脑
          </h2>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* PIN 输入框 */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                连接码
              </label>
              <input
                type="text"
                value={formatPin(pin)}
                onChange={handlePinChange}
                placeholder="XXXX-XXXX"
                className="w-full px-4 py-3 bg-secondary border border-border rounded-lg text-foreground text-center text-2xl font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                maxLength={9}
                autoComplete="off"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                在电脑端 RemoteBridge 应用中获取 8 位连接码
              </p>
            </div>

            {/* 设备标签 */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                设备名称
              </label>
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
              className="w-full py-3 bg-primary hover:bg-primary/90 disabled:bg-secondary disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors flex items-center justify-center"
            >
              {connectionStatus === 'connecting' ? (
                <>
                  <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" />
                  连接中...
                </>
              ) : (
                '连接'
              )}
            </button>
          </form>
        </motion.div>

        {/* 最近连接 */}
        {hostHistory.length > 0 && (
          <motion.div
            className="mt-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
          >
            <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              最近连接
            </h3>
            <div className="space-y-2">
              {hostHistory.map((entry) => (
                <button
                  key={entry.hostId}
                  onClick={() => handleQuickConnect(entry)}
                  className="w-full flex items-center gap-3 p-3 bg-card/60 hover:bg-card border border-border/50 hover:border-primary/40 rounded-lg transition-all group"
                >
                  <Monitor className="w-5 h-5 text-muted-foreground group-hover:text-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm text-foreground truncate">{entry.name}</p>
                    <p className="text-xs text-muted-foreground">{entry.os}</p>
                  </div>
                  <div className="text-xs text-muted-foreground flex-shrink-0">
                    {new Date(entry.lastConnected).toLocaleDateString('zh-CN')}
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary flex-shrink-0" />
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {/* 底部说明 */}
        <motion.p
          className="mt-6 text-center text-muted-foreground text-sm flex items-center justify-center gap-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          <Shield className="w-4 h-4" />
          安全连接 · 端到端加密 · 无需安装客户端
        </motion.p>
      </div>
    </div>
  );
}
