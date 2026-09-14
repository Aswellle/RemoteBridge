'use client';

/**
 * P1-09: Session Store — manages connection and session state
 */

import { create } from 'zustand';
import type { HostInfo } from '@remotebridge/shared';

interface SessionState {
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  hostInfo: HostInfo | null;
  sessionId: string | null;
  wsInstance: WebSocket | null;

  setConnectionStatus: (status: SessionState['connectionStatus']) => void;
  setHostInfo: (info: HostInfo | null) => void;
  setSession: (sessionId: string) => void;
  clearSession: () => void;
  setWsInstance: (ws: WebSocket | null) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  connectionStatus: 'disconnected',
  hostInfo: null,
  sessionId: null,
  wsInstance: null,

  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setHostInfo: (info) => set({ hostInfo: info }),
  setSession: (sessionId) => set({ sessionId }),
  clearSession: () => set({ sessionId: null, hostInfo: null }),
  setWsInstance: (ws) => set({ wsInstance: ws }),
}));
