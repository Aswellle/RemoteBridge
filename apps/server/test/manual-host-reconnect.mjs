// 临时验证脚本：Host 断线重连后，已在线 Client 的路由映射重建 + HOST_ONLINE 广播
// 用法: node test/manual-host-reconnect.mjs  (需 relay 运行在 localhost:3099)
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
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function openWs(token, type) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${token}&type=${type}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// 1. 建立会话
const reg = await post('/auth/register-host', { name: 'rc-test', os: 'win32', version: '1.0.0' });
const { token: hostToken } = reg.data;
const pinResp = await post('/auth/generate-pin', { expiresIn: 300 }, { Authorization: `Bearer ${hostToken}` });
const conn = await post('/auth/connect', { pin: pinResp.data.pin, clientId: 'rc-client-' + Date.now(), clientLabel: 'rc' });
const { accessToken } = conn.data;

// 2. Host 与 Client 都上线
let hostWs = await openWs(hostToken, 'host');
const clientWs = await openWs(accessToken, 'client');
const clientEvents = [];
clientWs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  clientEvents.push(m.type);
});
const hostCmds = [];
hostWs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'CMD_LIST_DIR') hostCmds.push(m);
});
await wait(300);

// 3. Host 掉线 → Client 应收到 HOST_OFFLINE
hostWs.close(4000, 'simulate drop');
await wait(300);
if (!clientEvents.includes('HOST_OFFLINE')) fail('Client 未收到 HOST_OFFLINE');
ok('Host 掉线后 Client 收到 HOST_OFFLINE');

// 4. Host 重连 → Client 应收到 HOST_ONLINE（无需 Client 重连）
hostWs = await openWs(hostToken, 'host');
hostWs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'CMD_LIST_DIR') hostCmds.push(m);
});
await wait(300);
if (!clientEvents.includes('HOST_ONLINE')) fail('Client 未收到 HOST_ONLINE');
ok('Host 重连后 Client 收到 HOST_ONLINE 广播');

// 5. Client 直接发 CMD —— 路由映射必须已被重建（之前这里会 PEER_OFFLINE）
clientWs.send(JSON.stringify({
  id: 'rc-msg-1',
  type: 'CMD_LIST_DIR',
  payload: { path: '/tmp', requestId: 'rc-req-1' },
  timestamp: Date.now(),
}));
await wait(300);
if (clientEvents.includes('ERROR')) fail('Client 收到 ERROR（PEER_OFFLINE）—— 路由映射未重建');
if (hostCmds.length === 0) fail('Host 未收到 CMD_LIST_DIR —— 路由映射未重建');
ok(`Host 重连后无需 Client 重连即可路由 CMD（Host 收到 ${hostCmds.length} 条，注入 clientId=${hostCmds[0].payload.clientId}）`);

hostWs.close(1000); clientWs.close(1000);
console.log('\n🎉 Host 重连路由重建验证全部通过');
process.exit(0);
