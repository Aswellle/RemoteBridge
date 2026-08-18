// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

// ===== 共享的 mock 状态（vi.hoisted 保证在 vi.mock 工厂与测试用例间共享）=====
const { mockState } = vi.hoisted(() => {
  const state = {
    connectionStatus: 'connected' as 'disconnected' | 'connecting' | 'connected' | 'error',
    messages: [] as Array<{
      id: string;
      content: string;
      direction: 'host_to_client' | 'client_to_host';
      type: string;
      timestamp: number;
    }>,
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    markMessagesRead: vi.fn(),
    sessionId: 's1',
    loadMessageHistory: vi.fn().mockResolvedValue(undefined),
  };
  return { mockState: state };
});

// ===== 模块 mock =====
const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/dashboard/messages',
}));

vi.mock('@/store/app-store', () => {
  const useAppStore = (selector?: (s: typeof mockState) => unknown) =>
    selector ? selector(mockState) : mockState;
  useAppStore.getState = () => mockState;
  return { useAppStore };
});

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() }),
}));

vi.mock('@/components/ui/NotConnected', () => ({
  default: () => null,
}));

import MessagesPage from '@/app/dashboard/messages/page';

// ===== 渲染辅助（flushSync 同步冲洗 effect，无需 act 全局）=====
function render(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(ui);
  });
  return container;
}

function rerender(root: ReturnType<typeof createRoot>, ui: React.ReactElement): void {
  flushSync(() => {
    root.render(ui);
  });
}

describe('MessagesPage (component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.connectionStatus = 'connected';
    mockState.messages = [];
    mockState.sessionId = 's1';
    push.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the empty-state prompt when there are no messages', () => {
    const container = render(<MessagesPage />);
    expect(container.textContent).toContain('暂无消息');
  });

  it('renders one bubble per message and shows the input form', () => {
    mockState.messages = [
      { id: 'a', content: 'hi from host', direction: 'host_to_client', type: 'text', timestamp: 1000 },
      { id: 'b', content: 'hi back', direction: 'client_to_host', type: 'text', timestamp: 2000 },
    ];

    const container = render(<MessagesPage />);

    expect(container.textContent).toContain('hi from host');
    expect(container.textContent).toContain('hi back');
    // 输入框 + 发送按钮都在
    expect(container.querySelector('input[aria-label="消息输入"]')).not.toBeNull();
    expect(container.textContent).toContain('发送');
  });

  it('marks messages read only when a host message arrives (not on empty mount)', () => {
    // 空状态挂载：无最新消息，不应调用清零
    render(<MessagesPage />);
    expect(mockState.markMessagesRead).not.toHaveBeenCalled();

    // 收到一条来自主机的消息 → 应触发清零
    mockState.messages = [
      { id: 'h1', content: 'from host', direction: 'host_to_client', type: 'text', timestamp: 4000 },
    ];
    // 重新渲染以触发 effect（messages 引用变化）
    const container = render(<MessagesPage />);
    expect(mockState.markMessagesRead).toHaveBeenCalled();
    expect(container.textContent).toContain('from host');
  });
  it('does not throw when messages change repeatedly (regression: effect must not loop)', () => {
    // 模拟 effect 依赖 messages 变化时的重渲染 —— 如果 effect 错误地 setState 触发
    // 无限循环，flushSync 内的渲染会抛出 "Maximum update depth exceeded"
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rerender(root, <MessagesPage />);

    mockState.messages = [
      { id: 'x', content: 'new', direction: 'host_to_client', type: 'text', timestamp: 3000 },
    ];
    expect(() => rerender(root, <MessagesPage />)).not.toThrow();
    expect(container.textContent).toContain('new');
  });
});
