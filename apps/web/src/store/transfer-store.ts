'use client';

import { create } from 'zustand';

// ===== Transfer Types =====

export interface Transfer {
  id: string;
  kind: 'download' | 'upload' | 'preview';
  fileName: string;
  filePath: string;
  fileSize: number;
  transferredBytes: number;
  status: 'pending' | 'streaming' | 'completed' | 'error' | 'cancelled';
  progress: number; // 0-100
  speed: number; // bytes/s
  eta: number; // seconds
  error?: string;
  startedAt: number;
  downloadUrl?: string;
}

export interface TransferStats {
  totalTransfers: number;
  activeTransfers: number;
  completedTransfers: number;
  failedTransfers: number;
  totalBytesTransferred: number;
  averageSpeed: number;
}

// ===== Transfer Store Interface =====

interface TransferState {
  transfers: Record<string, Transfer>;
  stats: TransferStats;

  // Actions
  addTransfer: (transfer: Transfer) => void;
  updateTransfer: (id: string, updates: Partial<Transfer>) => void;
  removeTransfer: (id: string) => void;
  cancelTransfer: (id: string) => void;
  clearCompleted: () => void;
  clearAll: () => void;

  // Selectors (computed)
  getActiveTransfers: () => Transfer[];
  getTransfersBySession: (sessionId: string) => Transfer[];
}

// ===== Helper: Calculate progress from bytes =====
function calcProgress(transferred: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((transferred / total) * 100));
}

// ===== Transfer Store =====

export const useTransferStore = create<TransferState>((set, get) => ({
  transfers: {},
  stats: {
    totalTransfers: 0,
    activeTransfers: 0,
    completedTransfers: 0,
    failedTransfers: 0,
    totalBytesTransferred: 0,
    averageSpeed: 0,
  },

  addTransfer: (transfer) =>
    set((state) => {
      const newTransfers = { ...state.transfers, [transfer.id]: transfer };
      const stats = computeStats(newTransfers);
      return { transfers: newTransfers, stats };
    }),

  updateTransfer: (id, updates) =>
    set((state) => {
      const existing = state.transfers[id];
      if (!existing) return state;

      const updated: Transfer = {
        ...existing,
        ...updates,
      };

      // Auto-calculate progress if bytes changed
      if (updates.transferredBytes !== undefined || updates.fileSize !== undefined) {
        updated.progress = calcProgress(updated.transferredBytes, updated.fileSize);
      }

      // Auto-update status based on progress
      if (updated.progress >= 100 && updated.status === 'streaming') {
        updated.status = 'completed';
      }

      const newTransfers = { ...state.transfers, [id]: updated };
      const stats = computeStats(newTransfers);
      return { transfers: newTransfers, stats };
    }),

  removeTransfer: (id) =>
    set((state) => {
      const newTransfers = { ...state.transfers };
      delete newTransfers[id];
      const stats = computeStats(newTransfers);
      return { transfers: newTransfers, stats };
    }),

  cancelTransfer: (id) =>
    set((state) => {
      const existing = state.transfers[id];
      if (!existing || existing.status === 'completed') return state;

      const updated: Transfer = {
        ...existing,
        status: 'cancelled',
        speed: 0,
        eta: 0,
      };

      const newTransfers = { ...state.transfers, [id]: updated };
      const stats = computeStats(newTransfers);
      return { transfers: newTransfers, stats };
    }),

  clearCompleted: () =>
    set((state) => {
      const newTransfers: Record<string, Transfer> = {};
      for (const [id, t] of Object.entries(state.transfers)) {
        if (t.status !== 'completed' && t.status !== 'cancelled') {
          newTransfers[id] = t;
        }
      }
      const stats = computeStats(newTransfers);
      return { transfers: newTransfers, stats };
    }),

  clearAll: () =>
    set({
      transfers: {},
      stats: {
        totalTransfers: 0,
        activeTransfers: 0,
        completedTransfers: 0,
        failedTransfers: 0,
        totalBytesTransferred: 0,
        averageSpeed: 0,
      },
    }),

  getActiveTransfers: () => {
    return Object.values(get().transfers).filter(
      (t) => t.status === 'pending' || t.status === 'streaming'
    );
  },

  getTransfersBySession: (sessionId) => {
    return Object.values(get().transfers).filter(
      (t) => (t as Transfer & { sessionId?: string }).sessionId === sessionId
    );
  },
}));

// ===== Stats Computation =====

function computeStats(transfers: Record<string, Transfer>): TransferStats {
  const all = Object.values(transfers);
  const active = all.filter((t) => t.status === 'pending' || t.status === 'streaming');
  const completed = all.filter((t) => t.status === 'completed');
  const failed = all.filter((t) => t.status === 'error');

  let totalBytes = 0;
  let totalSpeed = 0;

  for (const t of completed) {
    totalBytes += t.fileSize;
  }
  for (const t of active) {
    totalBytes += t.transferredBytes;
    totalSpeed += t.speed;
  }

  return {
    totalTransfers: all.length,
    activeTransfers: active.length,
    completedTransfers: completed.length,
    failedTransfers: failed.length,
    totalBytesTransferred: totalBytes,
    averageSpeed: active.length > 0 ? totalSpeed / active.length : 0,
  };
}
