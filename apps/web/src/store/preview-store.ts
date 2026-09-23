'use client';

import { create } from 'zustand';
import type { FileCategory } from '@remotebridge/shared';

// ===== Preview Types =====

export interface PreviewState {
  previewUrl: string | null;
  rawBytes: Uint8Array | null;
  isPartial: boolean;
  fileName: string;
  fileSize: number;
  extension: string;
  category: FileCategory;
  expiresAt: number;
  loading: boolean;
  error: string | null;

  // Actions
  setPreview: (data: Partial<Omit<PreviewState, 'setPreview' | 'clearPreview' | 'setLoading' | 'setError'>>) => void;
  clearPreview: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

// ===== Thresholds (exported for use in components) =====

export const PREVIEW_SIZE_THRESHOLD = 50 * 1024 * 1024; // 50 MB
export const PREVIEW_PARTIAL_BYTES = 1024 * 1024; // 1 MB

// ===== Preview Store =====

export const usePreviewStore = create<PreviewState>((set) => ({
  previewUrl: null,
  rawBytes: null,
  isPartial: false,
  fileName: '',
  fileSize: 0,
  extension: '',
  category: 'unknown',
  expiresAt: 0,
  loading: false,
  error: null,

  setPreview: (data) => set(data),
  clearPreview: () =>
    set({
      previewUrl: null,
      rawBytes: null,
      isPartial: false,
      fileName: '',
      fileSize: 0,
      extension: '',
      category: 'unknown',
      expiresAt: 0,
      loading: false,
      error: null,
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
}));
