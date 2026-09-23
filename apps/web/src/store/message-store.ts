'use client';

import { create } from 'zustand';

// ===== Message Types =====

export interface ChatMessage {
  id: string;
  content: string;
  direction: 'host_to_client' | 'client_to_host';
  type: 'text' | 'system' | 'notification' | 'file';
  timestamp: number;
  // File transfer fields (type === 'file')
  uploadId?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  uploadStatus?: 'uploading' | 'completed' | 'error';
  uploadProgress?: number;
  savedPath?: string;
}

// ===== Message Store Interface =====

interface MessageState {
  messages: ChatMessage[];
  unreadCount: number;

  // Actions
  addMessage: (message: ChatMessage) => void;
  markMessagesRead: () => void;
  updateFileMessage: (uploadId: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
}

// ===== Message Store =====

const MAX_MESSAGES = 500;

export const useMessageStore = create<MessageState>((set) => ({
  messages: [],
  unreadCount: 0,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message].slice(-MAX_MESSAGES),
      unreadCount:
        message.direction === 'host_to_client'
          ? state.unreadCount + 1
          : state.unreadCount,
    })),

  markMessagesRead: () => set({ unreadCount: 0 }),

  updateFileMessage: (uploadId, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.uploadId === uploadId ? { ...m, ...updates } : m
      ),
    })),

  clearMessages: () => set({ messages: [], unreadCount: 0 }),
}));
