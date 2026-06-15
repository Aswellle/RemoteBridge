import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useAppStore } from '@/store/app-store';

vi.mock('@/store/app-store', () => ({ useAppStore: {} }));
vi.mock('@/lib/api', () => ({ refreshAccessToken: vi.fn() }));
vi.mock('@/lib/download-manager', () => ({
  handleDownloadReady: vi.fn(),
  handleDownloadError: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { WebSocketManager } from '@/hooks/useWebSocket';
import { refreshAccessToken } from '@/lib/api';
import { toast } from 'sonner';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  closeArgs: { code?: number; reason?: string } | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closeArgs = { code, reason };
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }
}

function abnormalClose(ws: MockWebSocket, code: number, reason = ''): void {
  ws.readyState = MockWebSocket.CLOSED;
  ws.onclose?.({ code, reason });
}

interface MockState {
  accessToken: string | null;
  setConnectionStatus: ReturnType<typeof vi.fn>;
  setWsInstance: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function createMockStore(accessToken: string | null = 'test-token') {
  const state: MockState = {
    accessToken,
    setConnectionStatus: vi.fn(),
    setWsInstance: vi.fn(),
    disconnect: vi.fn(),
  };
  return { getState: () => state, state };
}

function createManager(accessToken: string | null = 'test-token') {
  const store = createMockStore(accessToken);
  const manager = new WebSocketManager('ws://localhost:3001/ws', store as unknown as typeof useAppStore);
  return { manager, store };
}

describe('WebSocketManager', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not open a socket when there is no access token', () => {
    const { manager, store } = createManager(null);
    manager.connect();

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(store.state.setConnectionStatus).toHaveBeenCalledWith('disconnected');
  });

  it('opens a socket with the token and reports connected on open', () => {
    const { manager, store } = createManager('abc123');
    manager.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('ws://localhost:3001/ws?token=abc123&type=client');

    ws.onopen?.();
    expect(store.state.setConnectionStatus).toHaveBeenCalledWith('connected');
    expect(store.state.setWsInstance).toHaveBeenCalledWith(ws);
  });

  it('is idempotent while a connection is open or connecting', () => {
    const { manager } = createManager();
    manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    // still CONNECTING -- no second socket
    manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].readyState = MockWebSocket.OPEN;
    manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].readyState = MockWebSocket.CLOSED;
    manager.connect();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does not reconnect on a normal close (code 1000)', () => {
    vi.useFakeTimers();
    const { manager, store } = createManager();
    manager.connect();
    const ws = MockWebSocket.instances[0];

    abnormalClose(ws, 1000, 'normal');
    expect(store.state.setConnectionStatus).toHaveBeenCalledWith('disconnected');
    expect(store.state.setWsInstance).toHaveBeenCalledWith(null);

    vi.advanceTimersByTime(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('terminates the session on a revoked close (code 4003)', () => {
    vi.useFakeTimers();
    const { manager, store } = createManager();
    manager.connect();
    const ws = MockWebSocket.instances[0];

    abnormalClose(ws, 4003, 'revoked');

    expect(toast.error).toHaveBeenCalledWith('连接已断开', { description: '会话已被主机吊销' });
    expect(store.state.disconnect).toHaveBeenCalled();

    vi.advanceTimersByTime(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('refreshes the token and reconnects on an auth-expired close (code 4001)', async () => {
    vi.mocked(refreshAccessToken).mockResolvedValueOnce('new-token');
    const { manager, store } = createManager();
    manager.connect();
    const ws = MockWebSocket.instances[0];

    abnormalClose(ws, 4001, 'unauthorized');

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(store.state.disconnect).not.toHaveBeenCalled();
  });

  it('terminates the session if token refresh fails after an auth-expired close', async () => {
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error('refresh failed'));
    const { manager, store } = createManager();
    manager.connect();
    const ws = MockWebSocket.instances[0];

    abnormalClose(ws, 4001, 'unauthorized');

    await vi.waitFor(() => expect(store.state.disconnect).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('连接已断开', { description: '会话已过期，请重新连接' });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('reconnects with exponential backoff capped at 30s on abnormal closes', () => {
    vi.useFakeTimers();
    const { manager } = createManager();
    manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    const expectedDelays = [2000, 4000, 8000, 16000, 30000, 30000];

    expectedDelays.forEach((delay, index) => {
      const ws = MockWebSocket.instances[index];
      abnormalClose(ws, 1006, 'abnormal');

      vi.advanceTimersByTime(delay - 1);
      expect(MockWebSocket.instances).toHaveLength(index + 1);

      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(index + 2);
    });
  });

  it('stops reconnecting after disconnect()', () => {
    vi.useFakeTimers();
    const { manager } = createManager();
    manager.connect();
    const ws = MockWebSocket.instances[0];

    manager.disconnect();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(ws.closeArgs).toEqual({ code: 1000, reason: 'User disconnected' });

    vi.advanceTimersByTime(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
