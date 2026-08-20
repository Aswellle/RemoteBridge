import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useAppStore } from '@/store/app-store';

// api mock：default export 提供 .get() 换票接口；refreshAccessToken 是具名导出
vi.mock('@/lib/api', () => ({
  default: { get: vi.fn() },
  refreshAccessToken: vi.fn(),
}));
vi.mock('@/store/app-store', () => ({ useAppStore: {} }));
vi.mock('@/lib/download-manager', () => ({
  handleDownloadReady: vi.fn(),
  handleDownloadError: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { WebSocketManager } from '@/hooks/useWebSocket';
import api, { refreshAccessToken } from '@/lib/api';
import { toast } from 'sonner';

// ===== MockWebSocket =====
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
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

// 向已打开的 WS 注入一条服务端消息，驱动 handleMessage
function dispatchMessage(ws: MockWebSocket, message: object): void {
  ws.onmessage?.({ data: JSON.stringify(message) } as unknown as MessageEvent);
}

// ===== Mock store =====
interface MockState {
  sessionId: string | null;
  hostInfo: { hostId: string; name: string; os: string; online: boolean } | null;
  currentPath: string | null;
  connectionStatus: string;
  setConnectionStatus: ReturnType<typeof vi.fn>;
  setWsInstance: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  addMessage: ReturnType<typeof vi.fn>;
  updateFileMessage: ReturnType<typeof vi.fn>;
  setIsLoadingDir: ReturnType<typeof vi.fn>;
  setHostInfo: ReturnType<typeof vi.fn>;
  setDirEntries: ReturnType<typeof vi.fn>;
  setCurrentPath: ReturnType<typeof vi.fn>;
  listAllowed: ReturnType<typeof vi.fn>;
}

function createMockStore(sessionId: string | null = 'test-session') {
  const state: MockState = {
    sessionId,
    hostInfo: { hostId: 'h1', name: 'Test Host', os: 'Windows', online: true },
    currentPath: '/share',
    connectionStatus: 'disconnected',
    setConnectionStatus: vi.fn(),
    setWsInstance: vi.fn(),
    disconnect: vi.fn(),
    addMessage: vi.fn(),
    updateFileMessage: vi.fn(),
    setIsLoadingDir: vi.fn(),
    setHostInfo: vi.fn(),
    setDirEntries: vi.fn(),
    setCurrentPath: vi.fn(),
    listAllowed: vi.fn(),
  };
  return { getState: () => state, state };
}

function createManager(sessionId: string | null = 'test-session') {
  const store = createMockStore(sessionId);
  const manager = new WebSocketManager('ws://localhost:3001/ws', store as unknown as typeof useAppStore);
  return { manager, store };
}

// Helper: mock a successful ticket fetch
function mockTicketSuccess(ticket = 'mock-ticket'): void {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { data: { ticket } } } as any);
}

// Helper: mock a ticket fetch that fails with 401
function mockTicket401(): void {
  const err: any = new Error('Unauthorized');
  err.response = { status: 401 };
  vi.mocked(api.get).mockRejectedValueOnce(err);
}

// Helper: mock a ticket fetch that fails with a network error
function mockTicketNetworkError(): void {
  vi.mocked(api.get).mockRejectedValueOnce(new Error('Network Error'));
}

describe('WebSocketManager', () => {
  beforeEach(() => {
    // 彻底清理上一次测试遗留的 mockResolvedValueOnce / mockRejectedValueOnce 队列，
    // 避免「前一个测试未消费的票据 stub 泄漏到下一个测试」造成断言漂移
    vi.resetAllMocks();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    // 默认提供 sessionId — connect() 用 localStorage 检查是否已认证
    localStorage.setItem('sessionId', 'test-session');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('does not open a socket when there is no sessionId in localStorage', async () => {
    localStorage.removeItem('sessionId');
    const { manager, store } = createManager(null);

    await manager.connect();

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(store.state.setConnectionStatus).toHaveBeenCalledWith('disconnected');
  });

  it('opens a socket with a ticket and reports connected on open', async () => {
    mockTicketSuccess('abc123');
    const { manager, store } = createManager();

    await manager.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain('ticket=abc123');
    expect(ws.url).toContain('type=client');

    ws.onopen?.();
    expect(store.state.setConnectionStatus).toHaveBeenCalledWith('connected');
    expect(store.state.setWsInstance).toHaveBeenCalledWith(ws);
  });

  it('is idempotent while a connection is open or connecting', async () => {
    mockTicketSuccess();
    const { manager } = createManager();
    await manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    // still CONNECTING -- no second socket
    await manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].readyState = MockWebSocket.OPEN;
    await manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].readyState = MockWebSocket.CLOSED;
    mockTicketSuccess();
    await manager.connect();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('collapses concurrent connect() calls into a single socket (StrictMode double-effect / layout+page both calling connect)', async () => {
    // 不能用 mockTicketSuccess() 两次——两次并发调用如果各自换票，会各产生
    // 一个 pending promise，必须用同一个 deferred 来模拟"票据请求还在飞"的窗口
    let resolveTicket: (value: any) => void;
    vi.mocked(api.get).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTicket = resolve;
      }),
    );
    const { manager } = createManager();

    // 两次调用都不 await 第一个——模拟 this.ws 赋值前的并发窗口
    const p1 = manager.connect();
    const p2 = manager.connect();

    expect(api.get).toHaveBeenCalledTimes(1); // 第二次调用必须复用同一个 in-flight 票据请求，不能再换一张票
    resolveTicket!({ data: { data: { ticket: 'shared-ticket' } } });
    await Promise.all([p1, p2]);

    expect(MockWebSocket.instances).toHaveLength(1); // 两次 connect() 只能建一条连接
    expect(MockWebSocket.instances[0].url).toContain('ticket=shared-ticket');
  });

  it('does not reconnect on a normal close (code 1000)', async () => {
    vi.useFakeTimers();
    mockTicketSuccess();
    const { manager, store } = createManager();
    await manager.connect();
    const ws = MockWebSocket.instances[0];

    abnormalClose(ws, 1000, 'normal');
    expect(store.state.setConnectionStatus).toHaveBeenCalledWith('disconnected');
    expect(store.state.setWsInstance).toHaveBeenCalledWith(null);

    await vi.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('terminates the session on a revoked close (code 4003)', async () => {
    vi.useFakeTimers();
    mockTicketSuccess();
    const { manager, store } = createManager();
    await manager.connect();
    const ws = MockWebSocket.instances[0];

    abnormalClose(ws, 4003, 'revoked');

    expect(toast.error).toHaveBeenCalledWith('连接已断开', { description: '会话已被主机吊销', id: 'session-terminated' });
    expect(store.state.disconnect).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('retries connect directly on an auth-expired close (code 4001) when ticket succeeds', async () => {
    mockTicketSuccess('ticket-1'); // initial connect
    const { manager, store } = createManager();
    await manager.connect();
    const ws = MockWebSocket.instances[0];

    mockTicketSuccess('ticket-2'); // retry after 4001
    abnormalClose(ws, 4001, 'unauthorized');

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(store.state.disconnect).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes the cookie and reconnects when ticket returns 401 after a 4001 close', async () => {
    mockTicketSuccess('ticket-1'); // initial connect
    const { manager, store } = createManager();
    await manager.connect();
    const ws = MockWebSocket.instances[0];

    // ticket fetch returns 401 → refresh → retry ticket succeeds
    mockTicket401();
    vi.mocked(refreshAccessToken).mockResolvedValueOnce(undefined);
    mockTicketSuccess('ticket-2');

    abnormalClose(ws, 4001, 'unauthorized');

    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(store.state.disconnect).not.toHaveBeenCalled();
  });

  it('terminates the session if token refresh fails after a 4001 close', async () => {
    mockTicketSuccess('ticket-1');
    const { manager, store } = createManager();
    await manager.connect();
    const ws = MockWebSocket.instances[0];

    // ticket fetch returns 401 → refresh fails
    mockTicket401();
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error('refresh failed'));

    abnormalClose(ws, 4001, 'unauthorized');

    await vi.waitFor(() => expect(store.state.disconnect).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('连接已断开', { description: '会话已过期，请重新连接', id: 'session-terminated' });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('schedules reconnect with exponential backoff on abnormal socket closes', async () => {
    vi.useFakeTimers();
    // PM4: mock Math.random to 0 so jitter = 0 and delays stay deterministic
    const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    mockTicketSuccess(); // initial connect
    const { manager } = createManager();
    await manager.connect();

    // reconnectDelay starts at 1000 and doubles each time (min(delay*2, 30000))
    const expectedDelays = [2000, 4000, 8000, 16000, 30000, 30000];

    for (let index = 0; index < expectedDelays.length; index++) {
      const ws = MockWebSocket.instances[index];
      abnormalClose(ws, 1006, 'abnormal'); // triggers scheduleReconnect

      await vi.advanceTimersByTimeAsync(expectedDelays[index] - 1);
      expect(MockWebSocket.instances).toHaveLength(index + 1); // not yet

      mockTicketSuccess(); // ticket for reconnect attempt
      await vi.advanceTimersByTimeAsync(1); // timer fires → connect() → new socket
      // advanceTimersByTimeAsync internally flushes microtasks, so connect() chain completes
      expect(MockWebSocket.instances).toHaveLength(index + 2);
    }

    mathRandomSpy.mockRestore();
  });

  it('stops reconnecting after disconnect()', async () => {
    vi.useFakeTimers();
    mockTicketSuccess();
    const { manager } = createManager();
    await manager.connect();
    const ws = MockWebSocket.instances[0];

    manager.disconnect();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(ws.closeArgs).toEqual({ code: 1000, reason: 'User disconnected' });

    await vi.advanceTimersByTimeAsync(60000);
    expect(MockWebSocket.instances).toHaveLength(1);

  }); // closes 'stops reconnecting after disconnect()'
  // ===== handleMessage 分支覆盖 =====
  describe('handleMessage', () => {
    async function openConnectedSocket() {
      mockTicketSuccess('msg-ticket');
      const { manager, store } = createManager();
      await manager.connect();
      const ws = MockWebSocket.instances[0];
      ws.onopen?.();
      return { manager, store, ws };
    }

    it('routes an inbound host text message to addMessage with host_to_client direction', async () => {
      const { store, ws } = await openConnectedSocket();

      dispatchMessage(ws, {
        id: 'm1',
        type: 'MSG_TEXT',
        senderType: 'host',
        payload: { content: 'hello from host' },
        timestamp: 1700000000000,
        sessionId: 'test-session',
      });

      expect(store.state.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm1', content: 'hello from host', direction: 'host_to_client', type: 'text' })
      );
    });

    it('updates the file message to completed on RESP_UPLOAD_ACK', async () => {
      const { store, ws } = await openConnectedSocket();

      dispatchMessage(ws, {
        id: 'ack1',
        type: 'RESP_UPLOAD_ACK',
        payload: { uploadId: 'up1', fileName: 'a.txt', savedPath: '/tmp/a.txt' },
        timestamp: 1700000000000,
        sessionId: 'test-session',
      });

      expect(store.state.updateFileMessage).toHaveBeenCalledWith('up1', {
        uploadStatus: 'completed',
        savedPath: '/tmp/a.txt',
        uploadProgress: 100,
      });
      expect(toast.success).toHaveBeenCalledWith('文件已接收', expect.any(Object));
    });

    it('marks the host offline and pushes a system message on HOST_OFFLINE', async () => {
      const { store, ws } = await openConnectedSocket();

      dispatchMessage(ws, {
        id: 'off1',
        type: 'HOST_OFFLINE',
        payload: {},
        timestamp: 1700000000000,
        sessionId: 'test-session',
      });

      expect(store.state.setHostInfo).toHaveBeenCalledWith({ hostId: 'h1', name: 'Test Host', os: 'Windows', online: false });
      expect(store.state.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'host_to_client', type: 'system' })
      );
    });

    it('refreshes the allowed-dirs list on HOST_DIRS_UPDATED when at root view', async () => {
      const { store, ws } = await openConnectedSocket();
      store.state.currentPath = null;

      dispatchMessage(ws, {
        id: 'dir1',
        type: 'HOST_DIRS_UPDATED',
        payload: {},
        timestamp: 1700000000000,
        sessionId: 'test-session',
      });

      expect(store.state.listAllowed).toHaveBeenCalled();
    });
  });

  // ===== 换票失败 → 退避重连 =====
  it('schedules a reconnect when the ticket fetch fails with a network error', async () => {
    vi.useFakeTimers();
    mockTicketNetworkError();
    const { manager } = createManager();

    await manager.connect();
    expect(MockWebSocket.instances).toHaveLength(0);

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    mockTicketSuccess();
    // 首次重连延迟 = 初始 1000ms × 2 = 2000ms（退避第一次翻倍）；
    // runAllTimersAsync 会完整刷新 doConnect 内的 await 链（换票→建连）
    await vi.runAllTimersAsync();

    expect(MockWebSocket.instances).toHaveLength(1);
    randomSpy.mockRestore();
  });
});
