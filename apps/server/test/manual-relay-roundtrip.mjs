// 临时验证脚本：CMD_LIST_DIR 全链路路由 + PONG id 回显
// 用法: node test-relay-roundtrip.mjs  (需 relay 运行在 localhost:3099)
import WebSocket from 'ws';

const API = 'http://localhost:3099/api/v1';
const WS = 'ws://localhost:3099/ws';

function post(path, body, headers = {}) {
  return fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };
const ok = (msg) => console.log('✅ ' + msg);

// 1. 注册 Host + 生成 PIN + Client 连接
const reg = await post('/auth/register-host', { name: 'rt-test', os: 'win32', version: '1.0.0' });
const { hostId, token: hostToken } = reg.data;

const pinResp = await post('/auth/generate-pin', { expiresIn: 300 }, { Authorization: `Bearer ${hostToken}` });
const pin = pinResp.data.pin;

const clientId = 'rt-client-' + Date.now();
const conn = await post('/auth/connect', { pin, clientId, clientLabel: 'rt' });
const { sessionId, accessToken, refreshToken } = conn.data;
ok(`会话建立 sessionId=${sessionId}`);

// 2. refresh token 不可用于 WS（安全修复验证）
// 注意：WS 协议升级先于服务端应用层校验完成，所以 open 事件必然触发，
// 只需断言服务端随后以 4001 关闭连接
await new Promise((resolve) => {
  const badWs = new WebSocket(`${WS}?token=${refreshToken}&type=client`);
  const t = setTimeout(() => fail('refresh token 连接未被服务端关闭'), 3000);
  badWs.on('close', (code) => {
    clearTimeout(t);
    code === 4001 ? ok('refresh token 被 WS 拒绝 (4001)') : fail(`refresh token 未被拒绝 code=${code}`);
    resolve();
  });
});

// 3. Host + Client WS 连接
const hostWs = new WebSocket(`${WS}?token=${hostToken}&type=host`);
const clientWs = new WebSocket(`${WS}?token=${accessToken}&type=client`);
await Promise.all([
  new Promise(r => hostWs.on('open', r)),
  new Promise(r => clientWs.on('open', r)),
]);

// 4. Host 端模拟桌面端行为：收到 CMD_LIST_DIR 后回显路由字段
let injectedPayload = null;
hostWs.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'CMD_LIST_DIR') {
    injectedPayload = msg.payload;
    // 模拟 dir-handlers 的 withRouting 回显
    hostWs.send(JSON.stringify({
      id: 'resp-1',
      type: 'RESP_DIR_LIST',
      sessionId: msg.payload.sessionId,
      payload: {
        requestId: msg.payload.requestId,
        path: msg.payload.path,
        entries: [{ name: 'demo.txt', path: 'D:\\share\\demo.txt', type: 'file', size: 1, modifiedAt: 0, extension: 'txt', isPreviewable: true }],
        parentPath: null,
        clientId: msg.payload.clientId,
        sessionId: msg.payload.sessionId,
      },
      timestamp: Date.now(),
    }));
  }
});

// 5. Client 发送 CMD_LIST_DIR，等待 RESP_DIR_LIST 路由回来
const respPromise = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('RESP_DIR_LIST 未在 5s 内路由回 Client')), 5000);
  clientWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'RESP_DIR_LIST') { clearTimeout(t); resolve(msg); }
  });
});

clientWs.send(JSON.stringify({
  id: 'cmd-1',
  type: 'CMD_LIST_DIR',
  payload: { path: 'D:\\share', requestId: 'req-1' },
  timestamp: Date.now(),
  sessionId,
}));

try {
  const resp = await respPromise;
  ok(`RESP_DIR_LIST 成功路由回 Client (requestId=${resp.payload.requestId}, entries=${resp.payload.entries.length})`);
} catch (e) {
  fail(e.message);
}

if (injectedPayload?.clientId === clientId && injectedPayload?.sessionId === sessionId) {
  ok(`Relay 已向 Host 注入路由字段 (clientId=${injectedPayload.clientId})`);
} else {
  fail(`Host 收到的 payload 缺少路由字段: ${JSON.stringify(injectedPayload)}`);
}

// 6. PONG 回显 id 验证（RTT 测量依赖）
const pongPromise = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('PONG 未返回')), 3000);
  hostWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'PONG') { clearTimeout(t); resolve(msg); }
  });
});
hostWs.send(JSON.stringify({ id: 'ping-42', type: 'PING', payload: {}, timestamp: Date.now() }));
const pong = await pongPromise;
pong.id === 'ping-42' ? ok('PONG 正确回显 id（RTT 测量可用）') : fail(`PONG id 未回显: ${pong.id}`);

// 7. 吊销即时生效验证：Host 吊销会话 → Client 收到 SESSION_REVOKED 且连接被服务端关闭
const revokeEvents = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('吊销后 5s 内未收到 SESSION_REVOKED 或连接未被关闭')), 5000);
  let gotNotify = false;
  clientWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'SESSION_REVOKED') gotNotify = true;
  });
  clientWs.on('close', (code) => {
    clearTimeout(t);
    if (!gotNotify) reject(new Error('连接被关闭但未收到 SESSION_REVOKED 通知'));
    else if (code !== 4003) reject(new Error(`关闭码应为 4003，实际 ${code}`));
    else resolve();
  });
});

const revokeRes = await fetch(`${API}/auth/revoke/${sessionId}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${hostToken}` },
}).then(r => r.json());
if (!revokeRes.success) fail('吊销请求失败');

try {
  await revokeEvents;
  ok('吊销即时生效：Client 收到 SESSION_REVOKED 并被踢下线 (4003)');
} catch (e) {
  fail(e.message);
}

// 8. 已吊销会话的 access token 无法再建立 WS 连接（握手吊销校验）
await new Promise((resolve) => {
  const deadWs = new WebSocket(`${WS}?token=${accessToken}&type=client`);
  const t = setTimeout(() => fail('已吊销会话的 WS 连接未被服务端关闭'), 5000);
  deadWs.on('close', (code) => {
    clearTimeout(t);
    code === 4003 ? ok('已吊销会话被 WS 握手校验拒绝 (4003)') : fail(`期望 4003，实际 ${code}`);
    resolve();
  });
});

// 9. refresh token 改用独立密钥：access token 不可用于 refresh 端点
const badRefresh = await fetch(`${API}/auth/refresh`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken: accessToken }),
}).then(r => r.json());
badRefresh.success !== true ? ok('access token 被 refresh 端点拒绝') : fail('access token 竟然通过 refresh 端点校验');

console.log('\n🎉 全链路结构改进验证全部通过');
hostWs.close(1000);
process.exit(0);
