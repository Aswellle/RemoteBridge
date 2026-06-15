// 临时验证脚本：消息持久化双向语义
// 1) Client→Host 与 Host→Client 的消息都按线上原始 id 持久化（messageId 去重键三方一致）
// 2) Host 发消息时 Relay 反查目标 Client 的 sessionId（此前 Host→Client 消息从不落库）
// 3) 同 id 重发不产生重复行
// 用法: node test/manual-message-history.mjs  (需 relay 运行在 localhost:3099)
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

// ===== 1. 建立会话 =====
const reg = await post('/auth/register-host', { name: 'msg-test', os: 'win32', version: '1.0.0' });
const { token: hostToken } = reg.data;
const pinResp = await post('/auth/generate-pin', { expiresIn: 300 }, { Authorization: `Bearer ${hostToken}` });
const clientId = 'msg-client-' + Date.now();
const conn = await post('/auth/connect', { pin: pinResp.data.pin, clientId, clientLabel: 'msg' });
const { sessionId, accessToken } = conn.data;

const hostWs = await openWs(hostToken, 'host');
const clientWs = await openWs(accessToken, 'client');
const clientReceived = [];
clientWs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'MSG_TEXT') clientReceived.push(m);
});
await wait(300);

// ===== 2. Client → Host =====
const clientMsgId = 'cmsg-' + Date.now();
clientWs.send(JSON.stringify({
  id: clientMsgId,
  type: 'MSG_TEXT',
  payload: { content: '来自客户端' },
  timestamp: Date.now(),
  sessionId,
}));

// ===== 3. Host → Client（只带 clientId，不带 sessionId —— 模拟桌面端真实行为） =====
const hostMsgId = 'hmsg-' + Date.now();
hostWs.send(JSON.stringify({
  id: hostMsgId,
  type: 'MSG_TEXT',
  payload: { content: '来自主机', clientId, senderLabel: 'msg-test' },
  timestamp: Date.now(),
}));

await wait(500);

// ===== 4. 校验 Client 在线收到且 id 保持原样 =====
const live = clientReceived.find(m => m.id === hostMsgId);
if (!live) fail(`Client 未收到 Host 消息或 id 被改写（收到 ${clientReceived.length} 条）`);
if (live.sessionId !== sessionId) fail(`中继消息缺少反查的 sessionId（实际 ${live.sessionId}）`);
ok('Host→Client 在线送达，id 原样保留，Relay 已反查注入 sessionId');

// ===== 5. 拉取历史：双向消息都已持久化、id 与线上一致 =====
const histResp = await fetch(`${API}/messages/${sessionId}?limit=50`, {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json());
const rows = histResp.data || [];

const clientRow = rows.find(m => m.id === clientMsgId);
if (!clientRow) fail('历史中找不到 Client→Host 消息（按线上 id 检索）');
if (clientRow.direction !== 'client_to_host') fail(`Client 消息方向错误: ${clientRow.direction}`);

const hostRow = rows.find(m => m.id === hostMsgId);
if (!hostRow) fail('历史中找不到 Host→Client 消息 —— sessionId 反查未生效');
if (hostRow.direction !== 'host_to_client') fail(`Host 消息方向错误: ${hostRow.direction}`);
ok('双向消息均已持久化，主键与线上 id 一致，方向语义正确');

// ===== 6. 同 id 重发不产生重复 =====
clientWs.send(JSON.stringify({
  id: clientMsgId,
  type: 'MSG_TEXT',
  payload: { content: '来自客户端' },
  timestamp: Date.now(),
  sessionId,
}));
await wait(400);
const histResp2 = await fetch(`${API}/messages/${sessionId}?limit=50`, {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json());
const dupCount = (histResp2.data || []).filter(m => m.id === clientMsgId).length;
if (dupCount !== 1) fail(`同 id 重发后出现 ${dupCount} 行（预期 1）`);
ok('同 id 重发被 onConflictDoNothing 去重');

hostWs.close(1000); clientWs.close(1000);
console.log('\n🎉 消息双轨语义验证全部通过');
process.exit(0);
