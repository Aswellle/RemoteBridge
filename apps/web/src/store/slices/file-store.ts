'use client';

/**
 * P1-09: File Store — manages file browser state (directories, entries)
 */

import { create } from 'zustand';
import type { FileEntry, AllowedDirectory } from '@remotebridge/shared';

interface FileState {
  currentPath: string | null;
  dirEntries: FileEntry[];
  allowedDirs: AllowedDirectory[];
  isLoadingDir: boolean;

  setCurrentPath: (path: string | null) => void;
  setDirEntries: (entries: FileEntry[]) => void;
  setAllowedDirs: (dirs: AllowedDirectory[]) => void;
  setIsLoadingDir: (loading: boolean) => void;
}

export const useFileStore = create<FileState>((set) => ({
  currentPath: null,
  dirEntries: [],
  allowedDirs: [],
  isLoadingDir: false,

  setCurrentPath: (path) => set({ currentPath: path }),
  setDirEntries: (entries) => set({ dirEntries: entries }),
  setAllowedDirs: (dirs) => set({ allowedDirs: dirs }),
  setIsLoadingDir: (loading) => set({ isLoadingDir: loading }),
}));
