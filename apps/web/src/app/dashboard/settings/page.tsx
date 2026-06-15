'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Settings as SettingsIcon, Monitor, Palette, Unlink, Sun, Moon, Save, Info } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/app-store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { applyTheme, getSavedTheme } from '@/lib/theme';

export default function SettingsPage() {
  const router = useRouter();
  const { connectionStatus, hostInfo, sessionId, disconnect } = useAppStore();
  const { disconnect: wsDisconnect } = useWebSocket();

  const [clientLabel, setClientLabel] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Load saved values from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedLabel = localStorage.getItem('clientLabel');
      if (savedLabel) setClientLabel(savedLabel);
      setTheme(getSavedTheme());
    }
  }, []);

  // 注意：不要用 useEffect 对 theme state 自动 applyTheme —— 初始 render 的
  // state 默认值('dark')会在挂载效应里覆写 localStorage（StrictMode 双挂载
  // 下必现），把已保存的主题冲掉。持久化只发生在用户显式切换时（toggleTheme）。

  const handleSaveLabel = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('clientLabel', clientLabel);
      toast.success('设备标签已保存', { description: '下次连接主机时生效（连接页将自动填入）' });
    }
  };

  const handleDisconnect = () => {
    wsDisconnect();
    disconnect();
    toast.success('已断开连接');
    router.push('/');
  };

  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return next;
    });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-foreground mb-6 flex items-center gap-2">
        <SettingsIcon className="w-6 h-6" />
        设置
      </h1>

      <div className="space-y-6">
        {/* Client Label */}
        <section className="bg-card rounded-lg p-5 border border-border">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
            <Monitor className="w-4 h-4" />
            客户端信息
          </h2>
          <label htmlFor="client-label" className="block text-sm text-muted-foreground mb-1.5">设备标签</label>
          <div className="flex gap-2">
            <input
              id="client-label"
              type="text"
              value={clientLabel}
              onChange={(e) => setClientLabel(e.target.value)}
              placeholder="我的设备"
              aria-label="设备标签"
              className="flex-1 px-3 py-2 bg-secondary border border-border rounded-lg text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
            <button
              onClick={handleSaveLabel}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-white text-sm rounded-lg transition-colors"
            >
              <Save className="w-4 h-4" />
              保存
            </button>
          </div>
        </section>

        {/* Connection Info */}
        <section className="bg-card rounded-lg p-5 border border-border">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
            <Info className="w-4 h-4" />
            连接信息
          </h2>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">状态</span>
              <span className={`text-sm flex items-center gap-1.5 ${
                connectionStatus === 'connected' ? 'text-success' :
                connectionStatus === 'connecting' ? 'text-yellow-400' :
                connectionStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'
              }`}>
                <span className={`w-2 h-2 rounded-full ${
                  connectionStatus === 'connected' ? 'bg-green-500' :
                  connectionStatus === 'connecting' ? 'bg-yellow-500' :
                  connectionStatus === 'error' ? 'bg-red-500' : 'bg-muted-foreground'
                }`} />
                {connectionStatus === 'connected' ? '已连接' :
                 connectionStatus === 'connecting' ? '连接中...' :
                 connectionStatus === 'error' ? '连接错误' : '未连接'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">会话 ID</span>
              <span className="text-sm text-foreground font-mono">{sessionId || '-'}</span>
            </div>
            {hostInfo && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">主机名</span>
                  <span className="text-sm text-foreground">{hostInfo.name || '-'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">操作系统</span>
                  <span className="text-sm text-foreground">{hostInfo.os || '-'}</span>
                </div>
                {hostInfo.version && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">版本</span>
                    <span className="text-sm text-foreground">{hostInfo.version}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* Theme */}
        <section className="bg-card rounded-lg p-5 border border-border">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
            <Palette className="w-4 h-4" />
            外观
          </h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">主题</span>
            <button
              onClick={toggleTheme}
              className="flex items-center gap-2 px-3 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-sm text-foreground transition-colors"
            >
              {theme === 'dark' ? (
                <>
                  <Moon className="w-4 h-4" />
                  深色模式
                </>
              ) : (
                <>
                  <Sun className="w-4 h-4" />
                  浅色模式
                </>
              )}
            </button>
          </div>
        </section>

        {/* Disconnect */}
        {connectionStatus === 'connected' && (
          <section className="bg-card rounded-lg p-5 border border-destructive/40">
            <h2 className="text-sm font-semibold text-destructive uppercase tracking-wide mb-3 flex items-center gap-2">
              <Unlink className="w-4 h-4" />
              连接操作
            </h2>
            <button
              onClick={handleDisconnect}
              aria-label="断开连接"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-destructive/20 hover:bg-destructive/40 text-destructive text-sm font-medium rounded-lg transition-colors"
            >
              <Unlink className="w-4 h-4" />
              断开连接
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
