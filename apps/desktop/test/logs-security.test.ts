/**
 * logs:security IPC handler 回归测试
 *
 * 覆盖用户可见的失败路径：安全审计页此前会显示
 * "Request failed with status code 401"（axios 原始错误直接透出）。
 * 关键行为：
 *  - Host token 有效 → 返回日志数据
 *  - 401（token 过期）→ 轮换 token 后重试一次，成功则返回数据
 *  - 401 且轮换失败 → 返回中文可读提示，不透出 axios/HTTP 内部细节
 *  - 无 token / 网络不可达 / 服务端 5xx → 各自的友好提示
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

var handlers = new Map<string, (...args: any[]) => any>();
var hostToken = 'token-1';
var renewResult = 'token-2';
var renewRejects = false;
var relayApiUrl = 'http://127.0.0.1:3002/api/v1';

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn),
  },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/db/client', () => ({
  default: { getAccessLogs: vi.fn(() => []) },
}));

vi.mock('../src/main/config/store', () => ({
  config: {
    getHostToken: () => hostToken,
    setHostToken: (v: string) => { hostToken = v; },
    getRelayApiUrl: () => relayApiUrl,
  },
}));

vi.mock('../src/main/ws-client/client', () => ({
  getRelayClient: () => null,
}));

const get = vi.fn();
const post = vi.fn();
vi.mock('axios', () => ({
  default: {
    get: (...args: any[]) => get(...args),
    post: (...args: any[]) => post(...args),
  },
}));

import { registerLogsHandlers } from '../src/main/ipc/logs';

function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

function netError(code: string) {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:3002`), { code });
}

function invokeSecurity(query?: Record<string, unknown>) {
  return handlers.get('logs:security')!(null, query);
}

describe('logs:security IPC', () => {
  beforeEach(() => {
    handlers.clear();
    get.mockReset();
    post.mockReset();
    hostToken = 'token-1';
    renewResult = 'token-2';
    renewRejects = false;
    relayApiUrl = 'http://127.0.0.1:3002/api/v1';
    registerLogsHandlers();
  });

  it('returns logs when the Host token is accepted', async () => {
    get.mockResolvedValueOnce({ data: { logs: [{ id: 'l1' }], total: 1, page: 1, pageSize: 20, totalPages: 1 } });

    const res = await invokeSecurity({ page: 1, pageSize: 20 });

    expect(res.success).toBe(true);
    expect(res.data.total).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
    const [url, opts] = get.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3002/api/v1/security-logs');
    expect(opts.headers.Authorization).toBe('Bearer token-1');
  });

  it('renews the Host token and retries once on 401', async () => {
    get.mockRejectedValueOnce(httpError(401)).mockResolvedValueOnce({ data: { logs: [], total: 0, page: 1, pageSize: 20, totalPages: 0 } });
    post.mockResolvedValueOnce({ data: { data: { token: 'token-2' } } });

    const res = await invokeSecurity();

    expect(res.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://127.0.0.1:3002/api/v1/auth/host-token-refresh');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][1].headers.Authorization).toBe('Bearer token-2');
    expect(hostToken).toBe('token-2');
  });

  it('returns a friendly message when the token cannot be renewed', async () => {
    get.mockRejectedValue(httpError(401));
    post.mockRejectedValue(httpError(401));

    const res = await invokeSecurity();

    expect(res.success).toBe(false);
    // 绝不透出 axios 文案
    expect(res.error).not.toContain('status code');
    expect(res.error).toContain('主机身份凭证');
  });

  it('does not retry on non-401 failures and hides axios details', async () => {
    get.mockRejectedValueOnce(httpError(500));

    const res = await invokeSecurity();

    expect(res.success).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    expect(res.error).not.toContain('status code');
    expect(res.error).toContain('服务器内部错误');
  });

  it('maps connection failures to an actionable message', async () => {
    get.mockRejectedValueOnce(netError('ECONNREFUSED'));

    const res = await invokeSecurity();

    expect(res.success).toBe(false);
    expect(res.error).toContain('无法连接到中继服务器');
  });

  it('reports a missing Host identity without issuing a request', async () => {
    hostToken = '';

    const res = await invokeSecurity();

    expect(res.success).toBe(false);
    expect(res.error).toContain('尚未建立主机身份');
    expect(get).not.toHaveBeenCalled();
  });

  it('returns an empty page instead of erroring when no relay is configured', async () => {
    relayApiUrl = '';

    const res = await invokeSecurity();

    expect(res.success).toBe(true);
    expect(res.data.logs).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
