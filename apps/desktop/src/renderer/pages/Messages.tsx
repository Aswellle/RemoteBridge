/**
 * 消息中心页面
 * 完整聊天 UI：消息列表 + 输入框 + 通知徽标 + 消息历史加载
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ElectronAPI } from '../../preload/index';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

interface MessageRecord {
  id: string;
  sessionId: string;
  direction: 'host_to_client' | 'client_to_host';
  content: string;
  type: 'text' | 'system' | 'notification';
  createdAt: number;
  readAt?: number;
  senderId?: string;
  senderLabel?: string;
}

interface ClientInfo {
  clientId: string;
  sessionId: string | null;
  label: string | null;
  lastSeenAt: number;
  online: boolean;
  isTrusted: boolean;
}

export default function MessagesPage() {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>('');
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 加载客户端列表（挂载时 + 10s 轮询，新连接的客户端才会出现在会话列表里）
  // 窗口隐藏（最小化到托盘）时暂停轮询，重新可见时立即刷新一次
  useEffect(() => {
    let alive = true;
    async function loadClients() {
      try {
        const list = await window.electronAPI.listClients();
        if (!alive) return;
        setClients(list);
        setSelectedClient((prev) => prev || (list.length > 0 ? list[0].clientId : ''));
      } catch (err) {
        console.error('加载客户端列表失败:', err);
      }
    }
    loadClients();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadClients();
      }
    }, 10000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadClients();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 加载消息历史
  useEffect(() => {
    async function loadHistory() {
      try {
        const history = await window.electronAPI.getMessageHistory(200);
        if (Array.isArray(history) && history.length > 0) {
          const mapped: MessageRecord[] = history.map((row: any) => ({
            id: row.id,
            sessionId: row.session_id || '',
            direction: row.direction,
            content: row.content,
            type: row.type || 'text',
            createdAt: row.created_at,
            senderId: row.sender_id,
            senderLabel: row.sender_label,
          }));
          // DB 返回 DESC（最新在前），反转为 ASC 供聊天界面从旧到新显示
          mapped.reverse();
          setMessages(mapped);
        }
      } catch (err) {
        console.error('加载消息历史失败:', err);
      }
    }
    loadHistory();
  }, []);

  // 监听新消息
  useEffect(() => {
    const handler = (data: any) => {
      const newMsg: MessageRecord = {
        id: data.id || `msg-${Date.now()}`,
        sessionId: data.sessionId || '',
        direction: 'client_to_host',
        content: data.content || '',
        type: data.type || 'text',
        createdAt: data.timestamp || Date.now(),
        senderId: data.senderId,
        senderLabel: data.senderLabel,
      };
      setMessages((prev) => [...prev, newMsg]);

      // 更新未读计数
      if (data.senderId && data.senderId !== selectedClient) {
        setUnreadMap((prev) => ({
          ...prev,
          [data.senderId]: (prev[data.senderId] || 0) + 1,
        }));
      }
    };

    window.electronAPI.onNewMessage(handler);
    return () => {
      window.electronAPI.removeAllListeners('event:new-message');
    };
  }, [selectedClient]);

  // 按 selectedClient 过滤消息，并按时间升序排列
  const filteredMessages = useMemo(() => {
    if (!selectedClient) return messages;
    return messages.filter((msg) => {
      // 显示与当前客户端相关的消息：
      // - 发送给当前客户端的消息 (host_to_client, clientId 匹配)
      // - 来自当前客户端的消息 (client_to_host, senderId 匹配)
      // - 系统消息始终显示
      if (msg.type === 'system') return true;
      if (msg.direction === 'client_to_host') {
        return msg.senderId === selectedClient;
      }
      if (msg.direction === 'host_to_client') {
        return msg.sessionId === selectedClient || msg.senderId === selectedClient;
      }
      return true;
    }).sort((a, b) => a.createdAt - b.createdAt);
  }, [messages, selectedClient]);

  // 发送消息
  const handleSend = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const content = inputValue.trim();
    if (!content || !selectedClient) return;

    try {
      const result = await window.electronAPI.sendMessage(selectedClient, content);
      if (result.success) {
        // 添加到本地消息列表
        const newMsg: MessageRecord = {
          id: `local-${Date.now()}`,
          sessionId: selectedClient,
          direction: 'host_to_client',
          content,
          type: 'text',
          createdAt: Math.floor(Date.now() / 1000),
          senderId: selectedClient,
        };
        setMessages((prev) => [...prev, newMsg]);
        setInputValue('');
      }
    } catch (err) {
      console.error('发送消息失败:', err);
    }
  }, [inputValue, selectedClient]);

  // 切换选中客户端时清除未读
  const handleSelectClient = (clientId: string) => {
    setSelectedClient(clientId);
    setUnreadMap((prev) => ({ ...prev, [clientId]: 0 }));
  };

  // 格式化时间：今天只显示时分，跨天补日期，跨年补年份
  const formatTime = (timestamp: number): string => {
    const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const date = new Date(ts);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const sameYear = date.getFullYear() === now.getFullYear();
    const hm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return hm;
    const md = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    if (sameYear) return `${md} ${hm}`;
    return `${date.getFullYear()}/${md} ${hm}`;
  };

  return (
    <div className="flex h-full">
      {/* 客户端列表侧边栏 */}
      <aside className="w-56 bg-card/80 border-r border-border flex-shrink-0 overflow-y-auto">
        <div className="p-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">会话列表</h3>
        </div>
        {clients.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            <p>暂无已连接客户端</p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {clients.map((client) => (
              <button
                key={client.clientId}
                onClick={() => handleSelectClient(client.clientId)}
                className={`flex items-center justify-between w-full px-3 py-2 rounded-lg transition-colors ${
                  selectedClient === client.clientId
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'text-foreground hover:bg-secondary'
                }`}
              >
                <div className="flex items-center min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full mr-2 flex-shrink-0 ${
                      client.online ? 'bg-green-400' : 'bg-gray-500'
                    }`}
                    title={client.online ? '在线' : '离线'}
                  />
                  <span className="truncate text-sm">{client.label || client.clientId.slice(0, 8)}</span>
                </div>
                {(unreadMap[client.clientId] || 0) > 0 && (
                  <span className="ml-2 px-1.5 py-0.5 bg-destructive text-white text-xs rounded-full min-w-[18px] text-center">
                    {unreadMap[client.clientId]}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* 聊天区 */}
      <main className="flex-1 flex flex-col">
        {/* 聊天标题 */}
        <div className="px-6 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {selectedClient
                ? clients.find((c) => c.clientId === selectedClient)?.label || selectedClient.slice(0, 8)
                : '消息中心'}
            </h2>
            <p className="text-xs text-muted-foreground">与远程客户端实时通信</p>
          </div>
          {/* 未读总数徽标 */}
          {Object.values(unreadMap).reduce((a, b) => a + b, 0) > 0 && (
            <span className="px-2 py-1 bg-destructive text-white text-xs rounded-full">
              {Object.values(unreadMap).reduce((a, b) => a + b, 0)} 条未读
            </span>
          )}
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {filteredMessages.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">
              <p className="text-lg mb-2">💬</p>
              <p>暂无消息</p>
              <p className="text-sm mt-1">选择客户端后发送消息开始通信</p>
            </div>
          ) : (
            filteredMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} formatTime={formatTime} />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 输入框 */}
        <div className="px-6 py-3 border-t border-border">
          <form onSubmit={handleSend} className="flex space-x-3">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={selectedClient ? '输入消息...' : '请先选择一个客户端'}
              disabled={!selectedClient}
              className="flex-1 px-4 py-2 bg-card border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!inputValue.trim() || !selectedClient}
              className="px-5 py-2 bg-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              发送
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

// ===== 消息气泡组件 =====
function MessageBubble({
  message,
  formatTime,
}: {
  message: MessageRecord;
  formatTime: (ts: number) => string;
}) {
  const isMe = message.direction === 'host_to_client';
  const isSystem = message.type === 'system';

  if (isSystem) {
    return (
      <div className="text-center">
        <span className="inline-block px-3 py-1 bg-secondary text-muted-foreground text-xs rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] px-4 py-2.5 rounded-2xl ${
          isMe
            ? 'bg-primary text-white rounded-br-md'
            : 'bg-secondary border border-border text-foreground rounded-bl-md'
        }`}
      >
        {!isMe && message.senderLabel && (
          <p className="text-xs text-muted-foreground mb-1">{message.senderLabel}</p>
        )}
        <p className="text-sm">{message.content}</p>
        <p className={`text-xs mt-1 ${isMe ? 'text-primary/70' : 'text-muted-foreground'}`}>
          {formatTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
