'use client';

import { create } from 'zustand';
import { FileEntry, AllowedDirectory } from '@remotebridge/shared';

// ===== File Store Interface =====

interface FileState {
  currentPath: string | null;
  dirEntries: FileEntry[];
  allowedDirs: AllowedDirectory[];
  isLoadingDir: boolean;

  // Actions
  setCurrentPath: (path: string | null) => void;
  setDirEntries: (entries: FileEntry[]) => void;
  setAllowedDirs: (dirs: AllowedDirectory[]) => void;
  setIsLoadingDir: (loading: boolean) => void;
  navigateUp: () => void;
  resetFiles: () => void;
}

// ===== File Store =====

export const useFileStore = create<FileState>((set, get) => ({
  currentPath: null,
  dirEntries: [],
  allowedDirs: [],
  isLoadingDir: false,

  setCurrentPath: (path) => set({ currentPath: path }),

  setDirEntries: (entries) => set({ dirEntries: entries }),

  setAllowedDirs: (dirs) => set({ allowedDirs: dirs }),

  setIsLoadingDir: (loading) => set({ isLoadingDir: loading }),

  navigateUp: () => {
    const { currentPath } = get();
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const parent = parts.length > 0 ? '/' + parts.join('/') : null;
    set({ currentPath: parent });
    // Note: caller should trigger listDir after navigating
  },

  resetFiles: () =>
    set({
      currentPath: null,
      dirEntries: [],
      allowedDirs: [],
      isLoadingDir: false,
    }),
}));
