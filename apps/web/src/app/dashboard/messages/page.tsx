'use client';

import { useState, useRef, useEffect } from 'react';
import { MessageSquare, ArrowUp } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { formatRelativeTime } from '@remotebridge/shared';
import { Skeleton } from '@/components/ui/Skeleton';
import { logger } from '@/lib/logger';

export default function MessagesPage() {
  const { connectionStatus, messages, sendMessage, markMessagesRead, sessionId, loadMessageHistory } = useAppStore();
  const { connect } = useWebSocket();
  const [inputValue, setInputValue] = useState('');
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 用户正在浏览本页：进入时和每次新消息到达时都清零未读
  // （只在进入时清一次的话，停留期间收到的消息会让侧边栏角标越挂越多）
  useEffect(() => {
    markMessagesRead();
  }, [markMessagesRead, messages]);

  // 加载历史消息
  useEffect(() => {
    async function loadHistory() {
      if (!sessionId || connectionStatus !== 'connected') return;
      try {
        setIsLoadingHistory(true);
        await loadMessageHistory(sessionId);
      } catch (err) {
        logger.error('加载消息历史失败:', err);
      } finally {
        setIsLoadingHistory(false);
      }
    }
    loadHistory();
  }, [sessionId, connectionStatus, loadMessageHistory]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const content = inputValue.trim();
    if (!content) return;

    sendMessage(content);
    setInputValue('');
  };

  if (connectionStatus !== 'connected') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-xl text-muted-foreground mb-4">未连接到远程主机</p>
          <a href="/" className="text-primary hover:underline">返回连接页面</a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 聊天标题 */}
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-lg font-semibold">消息中心</h2>
        <p className="text-sm text-muted-foreground">与远程主机实时通信</p>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4" role="log" aria-live="polite" aria-label="消息列表">
        {isLoadingHistory && (
          <div className="space-y-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[70%] px-4 py-3 rounded-2xl ${i % 2 === 0 ? 'rounded-bl-md' : 'rounded-br-md'}`}>
                  <Skeleton className="h-4 w-32 mb-2" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            ))}
          </div>
        )}
        {messages.length === 0 && !isLoadingHistory ? (
          <div className="text-center text-muted-foreground py-12">
            <MessageSquare className="w-10 h-10 mx-auto mb-2 text-muted-foreground" />
            <p>暂无消息</p>
            <p className="text-sm mt-1">发送消息与主机通信</p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入框 */}
      <div className="px-6 py-4 border-t border-border">
        <form onSubmit={handleSend} className="flex space-x-3">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="输入消息..."
            aria-label="消息输入"
            className="flex-1 px-4 py-3 bg-card border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="flex items-center gap-1.5 px-6 py-3 bg-primary hover:bg-primary/90 disabled:bg-secondary disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            <ArrowUp className="w-4 h-4" />
            发送
          </button>
        </form>
      </div>
    </div>
  );
}

// ===== 消息气泡组件 =====
interface MessageBubbleProps {
  message: {
    id: string;
    content: string;
    direction: 'host_to_client' | 'client_to_host';
    type: 'text' | 'system' | 'notification';
    timestamp: number;
  };
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isMe = message.direction === 'client_to_host';
  const isSystem = message.type === 'system';

  if (isSystem) {
    return (
      <div className="text-center">
        <span className="inline-block px-3 py-1 bg-secondary text-muted-foreground text-sm rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] px-4 py-3 rounded-2xl ${
          isMe
            ? 'bg-primary text-white rounded-br-md'
            : 'bg-secondary text-foreground rounded-bl-md'
        }`}
      >
        <p className="text-sm">{message.content}</p>
        <p className={`text-xs mt-1 ${isMe ? 'text-primary/70' : 'text-muted-foreground'}`}>
          {formatRelativeTime(message.timestamp)}
        </p>
      </div>
    </div>
  );
}
