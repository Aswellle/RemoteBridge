// 临时验证脚本：REST 消息回退（POST /messages/:sessionId）的路由字段注入 (P1-6)
// 验证 sendToHost/sendToClient 推送的 WS 消息携带 messageId/senderType/clientId/sessionId,
// 且 id === payload.messageId === 已落库的 messages.id（与 relayMessage 的去重键约定一致）
// 用法: node test/manual-rest-fallback-routing.mjs  (需 relay 运行在 localhost:3099)
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

// ===== 建立会话 =====
const reg = await post('/auth/register-host', { name: 'rest-fallback-test', os: 'win32', version: '1.0.0' });
const { token: hostToken } = reg.data;
const pinResp = await post('/auth/generate-pin', { expiresIn: 300 }, { Authorization: `Bearer ${hostToken}` });
const clientId = 'rest-client-' + Date.now();
const conn = await post('/auth/connect', { pin: pinResp.data.pin, clientId, clientLabel: 'rest' });
const { sessionId, accessToken } = conn.data;

const hostWs = await openWs(hostToken, 'host');
const clientWs = await openWs(accessToken, 'client');
const hostReceived = [];
const clientReceived = [];
hostWs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'MSG_TEXT') hostReceived.push(m);
});
clientWs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'MSG_TEXT') clientReceived.push(m);
});
await wait(300);

// ===== 1. Client -> Host via REST fallback =====
const restResp = await post(`/messages/${sessionId}`, { content: 'rest from client' }, {
  Authorization: `Bearer ${accessToken}`,
});
const restMessageId = restResp.data.id;
await wait(400);

const onHost = hostReceived.find(m => m.id === restMessageId);
if (!onHost) fail(`Host 未收到 REST 回退消息或 id 不一致（收到 ${hostReceived.length} 条）`);
if (onHost.payload?.messageId !== restMessageId) fail(`payload.messageId 与顶层 id 不一致: ${onHost.payload?.messageId}`);
if (onHost.payload?.senderType !== 'client') fail(`payload.senderType 错误: ${onHost.payload?.senderType}`);
if (onHost.payload?.clientId !== clientId) fail(`payload.clientId 错误: ${onHost.payload?.clientId}`);
if (onHost.sessionId !== sessionId) fail(`顶层 sessionId 缺失或错误: ${onHost.sessionId}`);
ok('Client->Host REST 回退：id/messageId/senderType/clientId/sessionId 均正确注入');

// ===== 2. Host -> Client via REST fallback =====
const restResp2 = await post(`/messages/${sessionId}`, { content: 'rest from host' }, {
  Authorization: `Bearer ${hostToken}`,
});
const restMessageId2 = restResp2.data.id;
await wait(400);

const onClient = clientReceived.find(m => m.id === restMessageId2);
if (!onClient) fail(`Client 未收到 REST 回退消息或 id 不一致（收到 ${clientReceived.length} 条）`);
if (onClient.payload?.messageId !== restMessageId2) fail(`payload.messageId 与顶层 id 不一致: ${onClient.payload?.messageId}`);
if (onClient.payload?.senderType !== 'host') fail(`payload.senderType 错误: ${onClient.payload?.senderType}`);
if (onClient.sessionId !== sessionId) fail(`顶层 sessionId 缺失或错误: ${onClient.sessionId}`);
ok('Host->Client REST 回退：id/messageId/senderType/sessionId 均正确注入');

// ===== 3. 历史中两条消息 id 与 WS 推送一致（去重键统一）=====
const hist = await fetch(`${API}/messages/${sessionId}?limit=50`, {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json());
const rows = hist.data || [];
if (!rows.find(m => m.id === restMessageId)) fail('历史中找不到 Client REST 消息');
if (!rows.find(m => m.id === restMessageId2)) fail('历史中找不到 Host REST 消息');
ok('历史记录与 WS 推送 id 一致（去重键统一）');

hostWs.close(1000); clientWs.close(1000);
console.log('\n🎉 REST 回退路由字段注入验证全部通过');
process.exit(0);
