// 针对"真实桌面 Host"的全链路功能验证脚本（区别于其余 manual-* 脚本的模拟 Host）。
// 前置条件：relay 运行中、桌面端已连接、白名单包含 RB_TEST_DIR。
// 用法:
//   ACCESS_TOKEN=... SESSION_ID=... node test/manual-live-host.mjs
// 可选: API_BASE / WS_BASE / RB_TEST_DIR
//
// P1-14: 依赖真实桌面 Host 提供的 ACCESS_TOKEN/SESSION_ID，无法在 vitest 的自动化
// relay（globalSetup 拉起的模拟环境）中运行，保留为手动脚本，不计入 vitest 套件/CI。
import WebSocket from 'ws';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const WS_URL = process.env.WS_BASE || 'ws://127.0.0.1:3001/ws';
const TEST_DIR = process.env.RB_TEST_DIR || 'D:\\AI\\remotebridge\\.cache\\rb-test-share';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SESSION_ID = process.env.SESSION_ID;

if (!ACCESS_TOKEN || !SESSION_ID) {
  console.error('需要 ACCESS_TOKEN 和 SESSION_ID 环境变量');
  process.exit(1);
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const localHello = readFileSync(join(TEST_DIR, 'hello.txt'));
const localBig = readFileSync(join(TEST_DIR, 'big.bin'));

let passed = 0, failed = 0;
const ok = (msg) => { passed++; console.log('✅ ' + msg); };
const fail = (msg) => { failed++; console.error('❌ ' + msg); };

// ===== WS 客户端连接 =====
const ws = new WebSocket(`${WS_URL}?token=${ACCESS_TOKEN}&type=client`);
const pending = new Map(); // requestId -> {resolve, types}
const onceByType = new Map(); // type -> resolve

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  const rid = msg.payload?.requestId;
  if (rid && pending.has(rid)) {
    pending.get(rid)(msg);
    pending.delete(rid);
    return;
  }
  if (onceByType.has(msg.type)) {
    onceByType.get(msg.type)(msg);
    onceByType.delete(msg.type);
  }
});

function send(type, payload) {
  ws.send(JSON.stringify({ id: randomUUID(), type, payload, timestamp: Date.now(), sessionId: SESSION_ID }));
}

function request(type, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(payload.requestId); reject(new Error(`${type} 等待响应超时`)); }, timeoutMs);
    pending.set(payload.requestId, (msg) => { clearTimeout(t); resolve(msg); });
    send(type, payload);
  });
}

function waitType(type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { onceByType.delete(type); reject(new Error(`等待 ${type} 超时`)); }, timeoutMs);
    onceByType.set(type, (msg) => { clearTimeout(t); resolve(msg); });
  });
}

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
  ws.on('close', (code) => reject(new Error(`WS 提前关闭 code=${code}`)));
});
ok('1. 客户端 WS 连接建立（access token 认证通过）');

// ===== 2. PING/PONG id 回显 =====
try {
  const pingId = 'ping-' + Date.now();
  const pongP = waitType('PONG');
  ws.send(JSON.stringify({ id: pingId, type: 'PING', payload: {}, timestamp: Date.now() }));
  const pong = await pongP;
  pong.id === pingId ? ok('2. PONG 回显请求 id（RTT 测量可用）') : fail(`2. PONG 未回显 id: 期望 ${pingId} 实际 ${pong.id}`);
} catch (e) { fail('2. PING/PONG: ' + e.message); }

// ===== 3. CMD_LIST_ALLOWED 白名单根列表 =====
try {
  const resp = await request('CMD_LIST_ALLOWED', { requestId: randomUUID() });
  if (resp.type !== 'RESP_DIR_LIST') throw new Error(`收到 ${resp.type}: ${JSON.stringify(resp.payload)}`);
  const entries = resp.payload.entries || [];
  const hit = entries.find(e => e.path && e.path.toLowerCase() === TEST_DIR.toLowerCase());
  hit ? ok(`3. CMD_LIST_ALLOWED 返回白名单（${entries.length} 项，含测试目录）`)
      : fail(`3. 白名单缺少测试目录: ${JSON.stringify(entries.map(e => e.path))}`);
} catch (e) { fail('3. CMD_LIST_ALLOWED: ' + e.message); }

// ===== 4. CMD_LIST_DIR 真实目录浏览 =====
try {
  const resp = await request('CMD_LIST_DIR', { path: TEST_DIR, requestId: randomUUID() });
  if (resp.type !== 'RESP_DIR_LIST') throw new Error(`收到 ${resp.type}: ${JSON.stringify(resp.payload)}`);
  const names = (resp.payload.entries || []).map(e => e.name).sort();
  (names.includes('hello.txt') && names.includes('big.bin'))
    ? ok(`4. CMD_LIST_DIR 列出真实文件: ${names.join(', ')}`)
    : fail(`4. 目录列表不完整: ${names.join(', ')}`);
} catch (e) { fail('4. CMD_LIST_DIR: ' + e.message); }

// ===== 5. CMD_REQUEST_DOWNLOAD 下载令牌签发 =====
try {
  const resp = await request('CMD_REQUEST_DOWNLOAD', { filePath: join(TEST_DIR, 'hello.txt'), requestId: randomUUID() });
  if (resp.type !== 'RESP_DOWNLOAD_READY') throw new Error(`收到 ${resp.type}: ${JSON.stringify(resp.payload)}`);
  (resp.payload.downloadUrl && resp.payload.fileName === 'hello.txt' && resp.payload.fileSize === localHello.length)
    ? ok(`5. RESP_DOWNLOAD_READY（${resp.payload.fileName}, ${resp.payload.fileSize}B, url=${resp.payload.downloadUrl.slice(0, 40)}...）`)
    : fail(`5. 下载就绪响应字段异常: ${JSON.stringify(resp.payload)}`);
} catch (e) { fail('5. CMD_REQUEST_DOWNLOAD: ' + e.message); }

// ===== 6. Relay 代理下载（WS 文件隧道）小文件 =====
const authHeaders = { Authorization: `Bearer ${ACCESS_TOKEN}` };
try {
  const r = await fetch(`${API}/proxy/download/${SESSION_ID}?filePath=${encodeURIComponent(join(TEST_DIR, 'hello.txt'))}`, { headers: authHeaders });
  const buf = Buffer.from(await r.arrayBuffer());
  (r.status === 200 && md5(buf) === md5(localHello))
    ? ok(`6. 代理下载 hello.txt 内容一致（${buf.length}B, md5 匹配）`)
    : fail(`6. 代理下载异常: HTTP ${r.status}, ${buf.length}B, md5 ${md5(buf)} vs ${md5(localHello)}`);
} catch (e) { fail('6. 代理下载小文件: ' + e.message); }

// ===== 7. 代理下载 600KB 文件（跨 3 个 256KB 隧道分块） =====
try {
  const r = await fetch(`${API}/proxy/download/${SESSION_ID}?filePath=${encodeURIComponent(join(TEST_DIR, 'big.bin'))}`, { headers: authHeaders });
  const buf = Buffer.from(await r.arrayBuffer());
  (r.status === 200 && buf.length === localBig.length && md5(buf) === md5(localBig))
    ? ok(`7. 代理下载 big.bin（600KB, 3 分块）md5 匹配`)
    : fail(`7. 大文件下载异常: HTTP ${r.status}, ${buf.length}/${localBig.length}B, md5 ${md5(buf)} vs ${md5(localBig)}`);
} catch (e) { fail('7. 代理下载大文件: ' + e.message); }

// ===== 8. HTTP Range 断点续传（206） =====
try {
  const r = await fetch(`${API}/proxy/download/${SESSION_ID}?filePath=${encodeURIComponent(join(TEST_DIR, 'big.bin'))}`, {
    headers: { ...authHeaders, Range: 'bytes=1024-2047' },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const expected = localBig.subarray(1024, 2048);
  (r.status === 206 && buf.length === 1024 && buf.equals(expected))
    ? ok(`8. Range 请求返回 206 且字节区间正确（Content-Range: ${r.headers.get('content-range')}）`)
    : fail(`8. Range 异常: HTTP ${r.status}, ${buf.length}B, equal=${buf.equals(expected)}`);
} catch (e) { fail('8. Range 请求: ' + e.message); }

// ===== 9. 预览链路 =====
try {
  const resp = await request('CMD_REQUEST_PREVIEW', { filePath: join(TEST_DIR, 'hello.txt'), requestId: randomUUID() });
  if (resp.type !== 'RESP_PREVIEW_READY') throw new Error(`收到 ${resp.type}: ${JSON.stringify(resp.payload)}`);
  const r = await fetch(`${API}/proxy/preview/${SESSION_ID}?filePath=${encodeURIComponent(join(TEST_DIR, 'hello.txt'))}`, { headers: authHeaders });
  const buf = Buffer.from(await r.arrayBuffer());
  (resp.payload.category === 'text' && r.status === 200 && md5(buf) === md5(localHello))
    ? ok(`9. 预览链路（category=${resp.payload.category}，代理内容一致）`)
    : fail(`9. 预览异常: category=${resp.payload.category}, HTTP ${r.status}, md5 ${md5(buf)}`);
} catch (e) { fail('9. 预览链路: ' + e.message); }

// ===== 10. 安全：未授权目录被拒绝 =====
try {
  const resp = await request('CMD_LIST_DIR', { path: 'C:\\Users', requestId: randomUUID() });
  resp.type === 'RESP_DIR_ERROR'
    ? ok(`10. 未授权目录被拒绝（${resp.payload.code}）`)
    : fail(`10. 未授权目录未被拒绝! 收到 ${resp.type}`);
} catch (e) { fail('10. 未授权目录测试: ' + e.message); }

// ===== 11. 安全：路径穿越被拒绝 =====
try {
  const resp = await request('CMD_LIST_DIR', { path: TEST_DIR + '\\..\\..', requestId: randomUUID() });
  resp.type === 'RESP_DIR_ERROR'
    ? ok(`11. 路径穿越被拒绝（${resp.payload.code}）`)
    : fail(`11. 路径穿越未被拒绝! 收到 ${resp.type}: ${JSON.stringify(resp.payload)}`);
} catch (e) { fail('11. 路径穿越测试: ' + e.message); }

// ===== 12. 安全：用 refresh token 连 WS 必须被 4001 拒绝 =====
if (process.env.REFRESH_TOKEN) {
  try {
    await new Promise((resolve, reject) => {
      const bad = new WebSocket(`${WS_URL}?token=${process.env.REFRESH_TOKEN}&type=client`);
      const t = setTimeout(() => reject(new Error('未被关闭')), 4000);
      bad.on('close', (code) => { clearTimeout(t); code === 4001 ? resolve() : reject(new Error(`code=${code}`)); });
    });
    ok('12. refresh token 连 WS 被 4001 拒绝');
  } catch (e) { fail('12. refresh token WS 拒绝: ' + e.message); }
}

ws.close();
console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
