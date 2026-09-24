/**
 * 客户端版本上报回归测试
 *
 * 背景：Host 端"连接状态"面板需要展示 Web 端版本，但版本只存在于客户端进程中。
 * Web 端在 WS 握手时通过 `&ver=` 上报，Relay 记录在内存注册表并在
 * GET /hosts/:hostId/clients 中原样返回给 Host（不落库，避免为此加一次迁移）。
 *
 * 覆盖：
 *  - 上报版本 → 列表返回该版本
 *  - 未上报 / 非法版本 → 不返回版本字段（不接受任意字符串进入 Host 界面）
 *  - 重连未上报版本 → 清掉上一次的残留值
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { API_BASE, WS_BASE, createSession, wait, type TestSession } from './helpers';

let session: TestSession;
const openSockets: WebSocket[] = [];

function connectClient(ver?: string): Promise<WebSocket> {
  const suffix = ver === undefined ? '' : `&ver=${encodeURIComponent(ver)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}?token=${session.accessToken}&type=client${suffix}`);
    openSockets.push(ws);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function fetchClients(): Promise<any[]> {
  const res = await fetch(`${API_BASE}/hosts/${session.hostId}/clients`, {
    headers: { Authorization: `Bearer ${session.hostToken}` },
  });
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.data;
}

describe('client version reporting', () => {
  beforeAll(async () => {
    session = await createSession('client-ver');
  });

  afterAll(() => {
    openSockets.forEach((ws) => ws.close());
  });

  it('returns the version reported during the WS handshake', async () => {
    await connectClient('9.9.9');
    await wait(300);

    const clients = await fetchClients();
    const entry = clients.find((c) => c.clientId === session.clientId);

    expect(entry).toBeTruthy();
    expect(entry.online).toBe(true);
    expect(entry.version).toBe('9.9.9');
  });

  it('omits the version when a client reports an invalid value', async () => {
    // 非法版本号（含脚本片段与空格）不得进入 Host 端界面
    await connectClient('<script>alert(1)</script>');
    await wait(300);

    const clients = await fetchClients();
    const entry = clients.find((c) => c.clientId === session.clientId);

    expect(entry.online).toBe(true);
    expect(entry.version).toBeUndefined();
  });

  it('clears a stale version when the same client reconnects without reporting', async () => {
    await connectClient('7.7.7');
    await wait(300);
    let entry = (await fetchClients()).find((c) => c.clientId === session.clientId);
    expect(entry.version).toBe('7.7.7');

    // 重连且不再上报版本（例如旧版客户端）→ 不允许残留旧值
    await connectClient();
    await wait(300);
    entry = (await fetchClients()).find((c) => c.clientId === session.clientId);
    expect(entry.online).toBe(true);
    expect(entry.version).toBeUndefined();
  });
});
