/**
 * 会话内多场景验证 (P1-14)，移植自:
 *  - manual-file-tunnel.mjs        — WS 文件隧道全链路（下载/Range/预览/错误）
 *  - manual-message-history.mjs    — 消息持久化双向语义 + 去重
 *  - manual-rest-fallback-routing.mjs — REST 消息回退的路由字段注入
 *  - manual-host-reconnect.mjs      — Host 断线重连后的路由映射重建
 *
 * 4 个脚本共用同一个会话/WS 连接（register-host 受 5/分钟/IP 限流，
 * 与 relay-roundtrip.test.ts 各占一次配额）。"Host 断线重连" 放在最后，
 * 因为它会关闭并重建 hostWs 连接，其它场景依赖最初建立的 hostWs/clientWs。
 *
 * 前置条件: 服务器已运行（默认 localhost:3099，由 vitest globalSetup 自动拉起）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { encodeFileChunkFrame } from '@remotebridge/shared';
import { API_BASE, openWs, post, postWithCookies, createSession, wait, type TestSession } from './helpers';

function buildTestFile(size: number): Buffer {
  const file = Buffer.alloc(size);
  for (let i = 0; i < size; i++) file[i] = (i * 7 + (i >> 8)) & 0xff;
  return file;
}

describe('会话内多场景验证 (P1-14)', () => {
  let session: TestSession;
  let hostWs: WebSocket;
  let clientWs: WebSocket;

  beforeAll(async () => {
    session = await createSession('flow');
    hostWs = await openWs(session.hostToken, 'host');
    clientWs = await openWs(session.accessToken, 'client');
    await wait(300);
  });

  afterAll(() => {
    hostWs?.close();
    clientWs?.close();
  });

  describe('WS 文件隧道 (移植自 manual-file-tunnel.mjs)', () => {
    const FILE_SIZE = 700 * 1000;
    const CHUNK = 256 * 1024;
    const FILE = buildTestFile(FILE_SIZE);
    let tokenSeq = 0;
    const issuedTokens = new Map<string, string>();

    beforeAll(() => {
      // 模拟桌面端 Host：签发单次令牌 + 响应 CMD_FETCH_FILE 分块
      hostWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'CMD_REQUEST_DOWNLOAD' || msg.type === 'CMD_REQUEST_PREVIEW') {
          const { requestId, filePath } = msg.payload;
          const token = `tk-${++tokenSeq}`;
          issuedTokens.set(token, filePath);
          const isPreview = msg.type === 'CMD_REQUEST_PREVIEW';
          hostWs.send(
            JSON.stringify({
              id: 'resp-' + requestId,
              type: isPreview ? 'RESP_PREVIEW_READY' : 'RESP_DOWNLOAD_READY',
              payload: {
                requestId,
                // 端口 9 (discard) 不可达：若 Relay 仍尝试 HTTP 直连必然失败
                [isPreview ? 'previewUrl' : 'downloadUrl']: `http://127.0.0.1:9/${isPreview ? 'preview' : 'download'}?token=${token}`,
                fileName: 'test.bin',
                fileSize: FILE_SIZE,
                extension: 'bin',
                category: 'text',
                expiresAt: Date.now() + 60000,
              },
              timestamp: Date.now(),
            }),
          );
          return;
        }

        if (msg.type === 'CMD_FETCH_FILE') {
          const { transferId, token, rangeStart, rangeEnd } = msg.payload;
          const filePath = issuedTokens.get(token);
          if (!filePath) return;
          issuedTokens.delete(token); // 单次使用

          if (filePath === '/err') {
            hostWs.send(
              JSON.stringify({
                id: 'err-' + transferId,
                type: 'RESP_FILE_ERROR',
                payload: { transferId, code: 'FS_ERROR', message: '模拟读取失败' },
                timestamp: Date.now(),
              }),
            );
            return;
          }

          const start = rangeStart ?? 0;
          const end = rangeEnd ?? FILE_SIZE - 1;
          const slice = FILE.subarray(start, end + 1);

          // P1-12: 二进制帧路径 —— 用 /data/test-binary.bin 触发，
          // 模拟桌面端 file-tunnel.ts 改用 sendRaw(encodeFileChunkFrame(...)) 发送非空分块
          if (filePath === '/data/test-binary.bin') {
            let seq = 0;
            for (let off = 0; off < slice.length; off += CHUNK) {
              const part = slice.subarray(off, Math.min(off + CHUNK, slice.length));
              const currentSeq = seq++;
              const eof = off + CHUNK >= slice.length;
              const meta = currentSeq === 0
                ? { totalSize: FILE_SIZE, rangeStart: start, rangeEnd: end, contentType: 'application/x-test-binary', fileName: 'test-binary.bin' }
                : {};
              hostWs.send(encodeFileChunkFrame({ transferId, seq: currentSeq, eof, ...meta }, Buffer.from(part)));
            }
            return;
          }

          let seq = 0;
          for (let off = 0; off < slice.length; off += CHUNK) {
            const part = slice.subarray(off, Math.min(off + CHUNK, slice.length));
            hostWs.send(
              JSON.stringify({
                id: `chunk-${transferId}-${seq}`,
                type: 'RESP_FILE_CHUNK',
                payload: {
                  transferId,
                  seq: seq++,
                  data: part.toString('base64'),
                  eof: off + CHUNK >= slice.length,
                  totalSize: FILE_SIZE,
                  rangeStart: start,
                  rangeEnd: end,
                  contentType: 'application/x-test',
                  fileName: 'test.bin',
                },
                timestamp: Date.now(),
              }),
            );
          }
        }
      });
    });

    it('完整下载：200 + Content-Length + 内容一致 + Content-Disposition: attachment', async () => {
      const res = await fetch(
        `${API_BASE}/proxy/download/${session.sessionId}?filePath=${encodeURIComponent('/data/test.bin')}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(FILE)).toBe(true);
      expect(res.headers.get('content-disposition') || '').toContain('attachment');
    });

    it('rb_access cookie 鉴权同样可用，无需 Authorization 头（02a-S11 后 Web 端的实际调用方式）', async () => {
      const res = await fetch(
        `${API_BASE}/proxy/download/${session.sessionId}?filePath=${encodeURIComponent('/data/test.bin')}`,
        { headers: { Cookie: `rb_access=${session.accessToken}` } },
      );
      expect(res.status).toBe(200);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(FILE)).toBe(true);
    });

    it('Range 下载：206 + Content-Range + 字节切片一致', async () => {
      const res = await fetch(
        `${API_BASE}/proxy/download/${session.sessionId}?filePath=${encodeURIComponent('/data/test.bin')}`,
        {
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Range: 'bytes=1000-99999',
          },
        },
      );
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 1000-99999/${FILE_SIZE}`);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBe(99000);
      expect(body.equals(FILE.subarray(1000, 100000))).toBe(true);
    });

    it('预览：200 + Host 报告的 Content-Type 透传', async () => {
      const res = await fetch(
        `${API_BASE}/proxy/preview/${session.sessionId}?filePath=${encodeURIComponent('/data/test.bin')}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-test');
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(FILE)).toBe(true);
    });

    it('Host 读取失败 → 502 TUNNEL_ERROR', async () => {
      const res = await fetch(
        `${API_BASE}/proxy/download/${session.sessionId}?filePath=${encodeURIComponent('/err')}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } },
      );
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error?.code).toBe('TUNNEL_ERROR');
    });

    describe('二进制帧路径 (P1-12)', () => {
      it('完整下载：200 + Content-Length + 内容一致（Host 经二进制 WS 帧回传分块）', async () => {
        const res = await fetch(
          `${API_BASE}/proxy/download/${session.sessionId}?filePath=${encodeURIComponent('/data/test-binary.bin')}`,
          { headers: { Authorization: `Bearer ${session.accessToken}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe(String(FILE_SIZE));
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(FILE)).toBe(true);
        expect(res.headers.get('content-disposition') || '').toContain('attachment');
      });

      it('Range 下载：206 + Content-Range + 字节切片一致（二进制帧）', async () => {
        const res = await fetch(
          `${API_BASE}/proxy/download/${session.sessionId}?filePath=${encodeURIComponent('/data/test-binary.bin')}`,
          {
            headers: {
              Authorization: `Bearer ${session.accessToken}`,
              Range: 'bytes=1000-99999',
            },
          },
        );
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe(`bytes 1000-99999/${FILE_SIZE}`);
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBe(99000);
        expect(body.equals(FILE.subarray(1000, 100000))).toBe(true);
      });

      it('预览：200 + Host 报告的 Content-Type 透传（二进制帧）', async () => {
        const res = await fetch(
          `${API_BASE}/proxy/preview/${session.sessionId}?filePath=${encodeURIComponent('/data/test-binary.bin')}`,
          { headers: { Authorization: `Bearer ${session.accessToken}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/x-test-binary');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(FILE)).toBe(true);
      });
    });
  });

  describe('消息持久化双向语义 (移植自 manual-message-history.mjs)', () => {
    const clientReceived: any[] = [];
    let clientMsgId: string;
    let hostMsgId: string;

    beforeAll(() => {
      clientWs.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'MSG_TEXT') clientReceived.push(m);
      });
    });

    it('Host→Client 在线送达，id 原样保留，Relay 注入 sessionId', async () => {
      clientMsgId = 'cmsg-' + Date.now();
      clientWs.send(
        JSON.stringify({
          id: clientMsgId,
          type: 'MSG_TEXT',
          payload: { content: '来自客户端' },
          timestamp: Date.now(),
          sessionId: session.sessionId,
        }),
      );

      // Host→Client 只带 clientId，不带 sessionId —— 模拟桌面端真实行为
      hostMsgId = 'hmsg-' + Date.now();
      hostWs.send(
        JSON.stringify({
          id: hostMsgId,
          type: 'MSG_TEXT',
          payload: { content: '来自主机', clientId: session.clientId, senderLabel: 'msg-test' },
          timestamp: Date.now(),
        }),
      );

      await wait(500);

      const live = clientReceived.find((m) => m.id === hostMsgId);
      expect(live).toBeTruthy();
      expect(live.sessionId).toBe(session.sessionId);
    });

    it('双向消息均已持久化，主键与线上 id 一致，方向语义正确', async () => {
      const histResp = await fetch(`${API_BASE}/messages/${session.sessionId}?limit=50`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      }).then((r) => r.json());
      const rows = histResp.data || [];

      const clientRow = rows.find((m: any) => m.id === clientMsgId);
      expect(clientRow).toBeTruthy();
      expect(clientRow.direction).toBe('client_to_host');

      const hostRow = rows.find((m: any) => m.id === hostMsgId);
      expect(hostRow).toBeTruthy();
      expect(hostRow.direction).toBe('host_to_client');
    });

    it('同 id 重发不产生重复行', async () => {
      clientWs.send(
        JSON.stringify({
          id: clientMsgId,
          type: 'MSG_TEXT',
          payload: { content: '来自客户端' },
          timestamp: Date.now(),
          sessionId: session.sessionId,
        }),
      );
      await wait(400);
      const histResp2 = await fetch(`${API_BASE}/messages/${session.sessionId}?limit=50`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      }).then((r) => r.json());
      const dupCount = (histResp2.data || []).filter((m: any) => m.id === clientMsgId).length;
      expect(dupCount).toBe(1);
    });
  });

  describe('文件上传消息持久化 (问题 A/B 修复)', () => {
    it('RESP_UPLOAD_ACK 被 Relay 持久化为 type:file 消息，content 为文件名，方向为 client_to_host', async () => {
      const uploadId = 'upload-' + Date.now();
      hostWs.send(
        JSON.stringify({
          id: 'ack-' + Date.now(),
          type: 'RESP_UPLOAD_ACK',
          payload: {
            uploadId,
            fileName: 'report.pdf',
            savedPath: 'C:/fake/report.pdf',
            fileSize: 12345,
            clientId: session.clientId,
            sessionId: session.sessionId,
          },
          timestamp: Date.now(),
        }),
      );
      await wait(400);

      const histResp = await fetch(`${API_BASE}/messages/${session.sessionId}?limit=50`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      }).then((r) => r.json());
      const row = (histResp.data || []).find((m: any) => m.id === uploadId);
      expect(row).toBeTruthy();
      expect(row.type).toBe('file');
      expect(row.content).toBe('report.pdf');
      expect(row.direction).toBe('client_to_host');
    });
  });

  describe('REST 回退路由字段注入 (移植自 manual-rest-fallback-routing.mjs)', () => {
    const hostReceived: any[] = [];
    const clientReceived: any[] = [];
    let restMessageId: string;
    let restMessageId2: string;

    beforeAll(() => {
      hostWs.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'MSG_TEXT') hostReceived.push(m);
      });
      clientWs.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'MSG_TEXT') clientReceived.push(m);
      });
    });

    it('Client→Host REST 回退：id/messageId/senderType/clientId/sessionId 均正确注入', async () => {
      const restResp = await post(
        `/messages/${session.sessionId}`,
        { content: 'rest from client' },
        { Authorization: `Bearer ${session.accessToken}` },
      );
      restMessageId = restResp.data.id;
      await wait(400);

      const onHost = hostReceived.find((m) => m.id === restMessageId);
      expect(onHost).toBeTruthy();
      expect(onHost.payload?.messageId).toBe(restMessageId);
      expect(onHost.payload?.senderType).toBe('client');
      expect(onHost.payload?.clientId).toBe(session.clientId);
      expect(onHost.sessionId).toBe(session.sessionId);
    });

    it('Host→Client REST 回退：id/messageId/senderType/sessionId 均正确注入', async () => {
      const restResp2 = await post(
        `/messages/${session.sessionId}`,
        { content: 'rest from host' },
        { Authorization: `Bearer ${session.hostToken}` },
      );
      restMessageId2 = restResp2.data.id;
      await wait(400);

      const onClient = clientReceived.find((m) => m.id === restMessageId2);
      expect(onClient).toBeTruthy();
      expect(onClient.payload?.messageId).toBe(restMessageId2);
      expect(onClient.payload?.senderType).toBe('host');
      expect(onClient.sessionId).toBe(session.sessionId);
    });

    it('两条 REST 回退消息均出现在历史记录中（去重键统一）', async () => {
      const hist = await fetch(`${API_BASE}/messages/${session.sessionId}?limit=50`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      }).then((r) => r.json());
      const rows = hist.data || [];
      expect(rows.find((m: any) => m.id === restMessageId)).toBeTruthy();
      expect(rows.find((m: any) => m.id === restMessageId2)).toBeTruthy();
    });
  });

  describe('Host 断线重连路由重建 (移植自 manual-host-reconnect.mjs)', () => {
    const clientEvents: string[] = [];
    const hostCmds: any[] = [];

    beforeAll(() => {
      clientWs.on('message', (d) => {
        const m = JSON.parse(d.toString());
        clientEvents.push(m.type);
      });
      hostWs.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'CMD_LIST_DIR') hostCmds.push(m);
      });
    });

    it('Host 掉线后 Client 收到 HOST_OFFLINE', async () => {
      hostWs.close(4000, 'simulate drop');
      await wait(300);
      expect(clientEvents).toContain('HOST_OFFLINE');
    });

    it('Host 重连后 Client 收到 HOST_ONLINE 广播（无需 Client 重连）', async () => {
      hostWs = await openWs(session.hostToken, 'host');
      hostWs.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'CMD_LIST_DIR') hostCmds.push(m);
      });
      await wait(300);
      expect(clientEvents).toContain('HOST_ONLINE');
    });

    it('Host 重连后路由映射已重建：Client 直接发 CMD，Host 收到并被注入 clientId', async () => {
      clientWs.send(
        JSON.stringify({
          id: 'rc-msg-1',
          type: 'CMD_LIST_DIR',
          payload: { path: '/tmp', requestId: 'rc-req-1' },
          timestamp: Date.now(),
        }),
      );
      await wait(300);
      expect(clientEvents).not.toContain('ERROR');
      expect(hostCmds.length).toBeGreaterThan(0);
      expect(hostCmds[0].payload.clientId).toBe(session.clientId);
    });
  });

  describe('GET /messages/client/history 跨会话聚合不应被吊销会话过滤 (问题 B 修复)', () => {
    // 复用本文件已注册的 session.hostToken/hostId——不再额外调用 /auth/register-host，
    // 否则会和 createSession('flow') 以及 relay-roundtrip.test.ts 一起超出 5/分钟/IP 限流
    // （见本文件顶部注释）。用一个全新 clientId 在同一个 host 下走两次 PIN 连接，
    // 不影响本文件其它场景依赖的 session.clientId。
    it('client↔host 之间一个更早会话被吊销后，该会话里的消息仍出现在聚合历史里', async () => {
      const clientId = 'revoke-hist-client-' + Date.now();

      // 1. 生成 PIN1，用固定 clientId 连接同一个 host → session1
      const pin1 = await post('/auth/generate-pin', { expiresIn: 300 }, { Authorization: `Bearer ${session.hostToken}` });
      const { data: conn1, accessToken: accessToken1 } = await postWithCookies('/auth/connect', {
        pin: pin1.data.pin,
        clientId,
        clientLabel: 'revoke-hist',
      });
      const sessionId1 = conn1.data.sessionId;

      // 2. 在 session1 里发一条 client_to_host 消息（走真实 WS，确保走真实持久化路径）
      const clientWs1 = await openWs(accessToken1, 'client');
      await wait(200);
      const msgId = 'old-msg-' + Date.now();
      clientWs1.send(
        JSON.stringify({
          id: msgId,
          type: 'MSG_TEXT',
          payload: { content: '吊销前发的消息' },
          timestamp: Date.now(),
          sessionId: sessionId1,
        }),
      );
      await wait(300);
      clientWs1.close();

      // 3. 吊销 session1
      const revokeRes = await fetch(`${API_BASE}/auth/revoke/${sessionId1}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.hostToken}` },
      }).then((r) => r.json());
      expect(revokeRes.success).toBe(true);

      // 4. 同一个 clientId 用新 PIN 再连一次（同一个 host）→ session2
      const pin2 = await post('/auth/generate-pin', { expiresIn: 300 }, { Authorization: `Bearer ${session.hostToken}` });
      const { accessToken: accessToken2 } = await postWithCookies('/auth/connect', {
        pin: pin2.data.pin,
        clientId,
        clientLabel: 'revoke-hist',
      });

      // 5. 用 session2 的 token 拉跨会话历史——session1 已吊销，但里面的消息应该仍然可见
      const histResp = await fetch(`${API_BASE}/messages/client/history?limit=200`, {
        headers: { Authorization: `Bearer ${accessToken2}` },
      }).then((r) => r.json());
      const row = (histResp.data || []).find((m: any) => m.id === msgId);
      expect(row).toBeTruthy();
      expect(row.direction).toBe('client_to_host');
      expect(row.sessionId).toBe(sessionId1);
    });
  });
});
