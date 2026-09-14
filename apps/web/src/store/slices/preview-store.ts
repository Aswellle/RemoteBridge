'use client';

/**
 * P1-09: Preview Store — manages file preview state
 */

import { create } from 'zustand';
import type { FileCategory } from '@remotebridge/shared';

interface PreviewState {
  previewUrl: string | null;
  rawBytes: Uint8Array | null;
  fileName: string;
  fileSize: number;
  extension: string;
  category: FileCategory;
  expiresAt: number;
  loading: boolean;
  error: string | null;
  isPartial: boolean;

  setPreview: (data: Partial<PreviewState>) => void;
  clearPreview: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

const INITIAL_PREVIEW: Omit<PreviewState, 'setPreview' | 'clearPreview' | 'setLoading' | 'setError'> = {
  previewUrl: null,
  rawBytes: null,
  fileName: '',
  fileSize: 0,
  extension: '',
  category: 'unknown',
  expiresAt: 0,
  loading: false,
  error: null,
  isPartial: false,
};

export const usePreviewStore = create<PreviewState>((set) => ({
  ...INITIAL_PREVIEW,

  setPreview: (data) => set((state) => ({ ...state, ...data })),
  clearPreview: () => set({ ...INITIAL_PREVIEW }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
}));
