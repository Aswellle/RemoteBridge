'use client';

/**
 * P1-09: Transfer Store — manages file transfer state (downloads/uploads)
 */

import { create } from 'zustand';

export interface TransferRecord {
  id: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  progress: number;
  direction: 'download' | 'upload';
  status: 'pending' | 'downloading' | 'uploading' | 'completed' | 'error';
  error?: string;
  downloadUrl?: string;
  speed?: number;
  eta?: number;
  startedAt: number;
}

interface TransferState {
  transfers: TransferRecord[];
  addTransfer: (transfer: TransferRecord) => void;
  updateTransfer: (id: string, updates: Partial<TransferRecord>) => void;
  removeTransfer: (id: string) => void;
  clearCompleted: () => void;
  getActive: () => TransferRecord[];
}

export const useTransferStore = create<TransferState>((set, get) => ({
  transfers: [],

  addTransfer: (transfer) =>
    set((state) => ({
      transfers: [transfer, ...state.transfers],
    })),

  updateTransfer: (id, updates) =>
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),

  removeTransfer: (id) =>
    set((state) => ({
      transfers: state.transfers.filter((t) => t.id !== id),
    })),

  clearCompleted: () =>
    set((state) => ({
      transfers: state.transfers.filter(
        (t) => t.status !== 'completed' && t.status !== 'error'
      ),
    })),

  getActive: () =>
    get().transfers.filter(
      (t) =>
        t.status === 'pending' ||
        t.status === 'downloading' ||
        t.status === 'uploading'
    ),
}));
