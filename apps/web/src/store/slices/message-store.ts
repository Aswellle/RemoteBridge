'use client';

/**
 * P1-09: Message Store — manages chat messages and history
 */

import { create } from 'zustand';

export interface MessageEntry {
  id: string;
  content: string;
  direction: 'host_to_client' | 'client_to_host';
  type: 'text' | 'system' | 'notification' | 'file';
  timestamp: number;
  messageId?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  uploadStatus?: 'uploading' | 'completed' | 'error';
  uploadProgress?: number;
  savedPath?: string;
}

interface MessageState {
  messages: MessageEntry[];
  unreadCount: number;

  addMessage: (message: MessageEntry) => void;
  markMessagesRead: () => void;
  setMessages: (messages: MessageEntry[]) => void;
  updateMessage: (id: string, updates: Partial<MessageEntry>) => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messages: [],
  unreadCount: 0,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
      unreadCount: state.unreadCount + 1,
    })),

  markMessagesRead: () => set({ unreadCount: 0 }),

  setMessages: (messages) => set({ messages, unreadCount: 0 }),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    })),
}));
