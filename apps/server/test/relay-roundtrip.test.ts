/**
 * Relay 全链路路由验证 (P1-14，移植自 manual-relay-roundtrip.mjs)
 * 覆盖 e2e.test.ts 未覆盖的结构性修复点：
 *  - refresh token 在 WS 握手层被拒绝 (4001)
 *  - CMD_LIST_DIR 的 RelayRoutingFields 注入 + RESP_DIR_LIST 路由回 Client
 *  - PONG 回显 PING 的 id（RTT 测量依赖）
 *  - 会话吊销即时生效：SESSION_REVOKED + WS 强制关闭 (4003)
 *  - 已吊销会话的 access token 在 WS 握手/refresh 端点均被拒绝
 *
 * 前置条件: 服务器已运行（默认 localhost:3099，由 vitest globalSetup 自动拉起）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import {
  API_BASE,
  WS_BASE,
  post,
  openWs,
  createSession,
  waitForMessage,
  waitForClose,
  type TestSession,
} from './helpers';

describe('Relay 全链路路由 (P1-14)', () => {
  let session: TestSession;
  let hostWs: WebSocket;
  let clientWs: WebSocket;

  beforeAll(async () => {
    session = await createSession('rt');
  });

  afterAll(() => {
    hostWs?.close();
    clientWs?.close();
  });

  it('refresh token 被 WS 握手拒绝 (4001)', async () => {
    const badWs = new WebSocket(`${WS_BASE}?token=${session.refreshToken}&type=client`);
    const code = await waitForClose(badWs, 3000);
    expect(code).toBe(4001);
  });

  it('CMD_LIST_DIR 注入 clientId/sessionId，RESP_DIR_LIST 路由回 Client', async () => {
    hostWs = await openWs(session.hostToken, 'host');
    clientWs = await openWs(session.accessToken, 'client');

    let injectedPayload: any = null;
    hostWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'CMD_LIST_DIR') {
        injectedPayload = msg.payload;
        // 模拟 dir-handlers 的 withRouting 回显
        hostWs.send(
          JSON.stringify({
            id: 'resp-1',
            type: 'RESP_DIR_LIST',
            sessionId: msg.payload.sessionId,
            payload: {
              requestId: msg.payload.requestId,
              path: msg.payload.path,
              entries: [
                {
                  name: 'demo.txt',
                  path: 'D:\\share\\demo.txt',
                  type: 'file',
                  size: 1,
                  modifiedAt: 0,
                  extension: 'txt',
                  isPreviewable: true,
                },
              ],
              parentPath: null,
              clientId: msg.payload.clientId,
              sessionId: msg.payload.sessionId,
            },
            timestamp: Date.now(),
          }),
        );
      }
    });

    const respPromise = waitForMessage(
      clientWs,
      (m) => m.type === 'RESP_DIR_LIST',
      5000,
      'RESP_DIR_LIST 未在 5s 内路由回 Client',
    );

    clientWs.send(
      JSON.stringify({
        id: 'cmd-1',
        type: 'CMD_LIST_DIR',
        payload: { path: 'D:\\share', requestId: 'req-1' },
        timestamp: Date.now(),
        sessionId: session.sessionId,
      }),
    );

    const resp = await respPromise;
    expect(resp.payload.requestId).toBe('req-1');
    expect(resp.payload.entries).toHaveLength(1);
    expect(injectedPayload?.clientId).toBe(session.clientId);
    expect(injectedPayload?.sessionId).toBe(session.sessionId);
  });

  it('PONG 回显 PING 的 id（RTT 测量依赖）', async () => {
    const pongPromise = waitForMessage(hostWs, (m) => m.type === 'PONG', 3000, 'PONG 未返回');
    hostWs.send(JSON.stringify({ id: 'ping-42', type: 'PING', payload: {}, timestamp: Date.now() }));
    const pong = await pongPromise;
    expect(pong.id).toBe('ping-42');
  });

  it('会话吊销即时生效：Client 收到 SESSION_REVOKED 并被关闭 (4003)', async () => {
    let gotNotify = false;
    clientWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SESSION_REVOKED') gotNotify = true;
    });
    const closePromise = waitForClose(clientWs, 5000);

    const revokeRes = await fetch(`${API_BASE}/auth/revoke/${session.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.hostToken}` },
    }).then((r) => r.json());
    expect(revokeRes.success).toBe(true);

    const code = await closePromise;
    expect(gotNotify).toBe(true);
    expect(code).toBe(4003);
  });

  it('已吊销会话的 access token 在 WS 握手时被拒绝 (4003)', async () => {
    const deadWs = new WebSocket(`${WS_BASE}?token=${session.accessToken}&type=client`);
    const code = await waitForClose(deadWs, 5000);
    expect(code).toBe(4003);
  });

  it('access token 不能用作 refresh token', async () => {
    const res = await post('/auth/refresh', { refreshToken: session.accessToken });
    expect(res.success).not.toBe(true);
  });
});
