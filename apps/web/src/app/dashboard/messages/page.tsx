'use client';

import { useState, useRef, useEffect } from 'react';
import { MessageSquare, ArrowUp, Paperclip, File, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import NotConnected from '@/components/ui/NotConnected';
import { useAppStore } from '@/store/app-store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { formatRelativeTime } from '@remotebridge/shared';
import { Skeleton } from '@/components/ui/Skeleton';
import { logger } from '@/lib/logger';

const ACCEPTED_FILE_TYPES = [
  'image/*',
  'video/*',
  '.doc', '.docx',
  '.xls', '.xlsx',
  '.ppt', '.pptx',
  '.pdf',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
  '.md', '.markdown',
].join(',');

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MessagesPage() {
  const { connectionStatus, messages, sendMessage, sendFile, markMessagesRead, sessionId, loadMessageHistory } = useAppStore();
  const { connect } = useWebSocket();
  const [inputValue, setInputValue] = useState('');
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        await sendFile(file);
      } catch (err) {
        logger.error('发送文件失败:', err);
      }
    }
    // 清空 input，允许重复选同一文件
    e.target.value = '';
  };

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
    return <NotConnected icon={MessageSquare} description="连接后可与远程主机实时发送消息和传输文件" />;
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
      <div className="px-6 py-4">
        {/* 隐藏文件 input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          onChange={handleFileSelect}
          aria-label="选择要发送的文件"
        />
        <form onSubmit={handleSend} className="flex space-x-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="发送文件"
            className="flex-shrink-0 flex items-center justify-center w-12 h-12 bg-card border border-border rounded-lg text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="输入消息…"
            aria-label="消息输入"
            className="flex-1 px-4 py-3 bg-card border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="flex-shrink-0 flex items-center gap-1.5 px-6 py-3 bg-primary hover:bg-primary/90 disabled:bg-secondary disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
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
    type: 'text' | 'system' | 'notification' | 'file';
    timestamp: number;
    uploadId?: string;
    fileName?: string;
    fileSize?: number;
    uploadStatus?: 'uploading' | 'completed' | 'error';
    uploadProgress?: number;
    savedPath?: string;
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

  if (message.type === 'file') {
    const { fileName, fileSize, uploadStatus, uploadProgress, savedPath } = message;
    return (
      <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
        <div
          className={`max-w-[75%] px-4 py-3 rounded-2xl ${
            isMe
              ? 'bg-primary/10 border border-primary/30 rounded-br-md'
              : 'bg-secondary rounded-bl-md'
          }`}
        >
          <div className="flex items-start gap-3">
            <File className="w-8 h-8 flex-shrink-0 text-primary mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{fileName}</p>
              {fileSize !== undefined && (
                <p className="text-xs text-muted-foreground">{formatFileSize(fileSize)}</p>
              )}
              {uploadStatus === 'uploading' && (
                <div className="mt-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    发送中 {uploadProgress ?? 0}%
                  </div>
                  <div className="h-1 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all"
                      style={{ width: `${uploadProgress ?? 0}%` }}
                    />
                  </div>
                </div>
              )}
              {uploadStatus === 'completed' && (
                <div className="flex items-center gap-1 mt-1 text-xs text-green-500">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>已送达桌面端</span>
                  {savedPath && (
                    <span className="text-muted-foreground truncate max-w-[160px]" title={savedPath}>
                      · {savedPath.split(/[/\\]/).pop()}
                    </span>
                  )}
                </div>
              )}
              {uploadStatus === 'error' && (
                <div className="flex items-center gap-1 mt-1 text-xs text-destructive">
                  <XCircle className="w-3.5 h-3.5" />
                  发送失败
                </div>
              )}
            </div>
          </div>
          <p className={`text-xs mt-2 ${isMe ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
            {formatRelativeTime(message.timestamp)}
          </p>
        </div>
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
        {/* isMe 气泡背景是纯色 bg-primary，正文靠外层 text-white 撑出对比度——
            时间戳之前用 text-primary/70（primary 色叠加透明度）盖在同色背景上，
            几乎不可读；改成 text-white/70，和正文同一套白字配色，仅降低透明度
            做层级区分 */}
        <p className={`text-xs mt-1 ${isMe ? 'text-white/70' : 'text-muted-foreground'}`}>
          {formatRelativeTime(message.timestamp)}
        </p>
      </div>
    </div>
  );
}
