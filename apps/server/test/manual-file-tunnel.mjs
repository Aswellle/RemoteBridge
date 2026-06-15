// 临时验证脚本：WS 文件隧道全链路
// proxy GET → CMD_REQUEST_DOWNLOAD → 令牌 → CMD_FETCH_FILE → RESP_FILE_CHUNK 分块 → HTTP 流式响应
// 下载地址故意指向不可达端口（:9），证明 Relay 不再做任何 HTTP 直连。
// 用法: node test/manual-file-tunnel.mjs  (需 relay 运行在 localhost:3099)
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

// ===== 测试文件内容：700KB 确定性字节序列（跨越多个 256KB 分块） =====
const FILE_SIZE = 700 * 1000;
const FILE = Buffer.alloc(FILE_SIZE);
for (let i = 0; i < FILE_SIZE; i++) FILE[i] = (i * 7 + (i >> 8)) & 0xff;
const CHUNK = 256 * 1024;

// ===== 1. 建立会话 =====
const reg = await post('/auth/register-host', { name: 'tunnel-test', os: 'win32', version: '1.0.0' });
const { token: hostToken } = reg.data;
const pinResp = await post('/auth/generate-pin', { expiresIn: 300 }, { Authorization: `Bearer ${hostToken}` });
const conn = await post('/auth/connect', { pin: pinResp.data.pin, clientId: 'tunnel-client-' + Date.now(), clientLabel: 'tunnel' });
const { sessionId, accessToken } = conn.data;

// ===== 2. 模拟 Host：签发令牌 + 处理 CMD_FETCH_FILE =====
const hostWs = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${WS}?token=${hostToken}&type=host`);
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});

let tokenSeq = 0;
const issuedTokens = new Map(); // token -> filePath

hostWs.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'CMD_REQUEST_DOWNLOAD' || msg.type === 'CMD_REQUEST_PREVIEW') {
    const { requestId, filePath } = msg.payload;
    const token = `tk-${++tokenSeq}`;
    issuedTokens.set(token, filePath);
    const isPreview = msg.type === 'CMD_REQUEST_PREVIEW';
    hostWs.send(JSON.stringify({
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
    }));
    return;
  }

  if (msg.type === 'CMD_FETCH_FILE') {
    const { transferId, token, rangeStart, rangeEnd } = msg.payload;
    const filePath = issuedTokens.get(token);
    if (!filePath) fail(`Host 收到未知令牌: ${token}`);
    issuedTokens.delete(token); // 单次使用

    if (filePath === '/err') {
      hostWs.send(JSON.stringify({
        id: 'err-' + transferId,
        type: 'RESP_FILE_ERROR',
        payload: { transferId, code: 'FS_ERROR', message: '模拟读取失败' },
        timestamp: Date.now(),
      }));
      return;
    }

    const start = rangeStart ?? 0;
    const end = rangeEnd ?? FILE_SIZE - 1;
    const slice = FILE.subarray(start, end + 1);
    let seq = 0;
    for (let off = 0; off < slice.length; off += CHUNK) {
      const part = slice.subarray(off, Math.min(off + CHUNK, slice.length));
      hostWs.send(JSON.stringify({
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
      }));
    }
  }
});

await new Promise(r => setTimeout(r, 200));

// ===== 3. 完整下载 =====
{
  const res = await fetch(`${API}/proxy/download/${sessionId}?filePath=${encodeURIComponent('/data/test.bin')}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 200) fail(`完整下载状态码 ${res.status}（预期 200）`);
  if (res.headers.get('content-length') !== String(FILE_SIZE)) fail(`Content-Length=${res.headers.get('content-length')}（预期 ${FILE_SIZE}）`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.equals(FILE)) fail(`完整下载内容不一致（收到 ${body.length} 字节）`);
  const cd = res.headers.get('content-disposition') || '';
  if (!cd.includes('attachment')) fail(`缺少 Content-Disposition: ${cd}`);
  ok(`完整下载 ${FILE_SIZE} 字节内容一致（3 个分块经 WS 隧道回传，未发生 HTTP 直连）`);
}

// ===== 4. Range 下载（断点续传语义） =====
{
  const res = await fetch(`${API}/proxy/download/${sessionId}?filePath=${encodeURIComponent('/data/test.bin')}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Range: 'bytes=1000-99999' },
  });
  if (res.status !== 206) fail(`Range 下载状态码 ${res.status}（预期 206）`);
  if (res.headers.get('content-range') !== `bytes 1000-99999/${FILE_SIZE}`) fail(`Content-Range=${res.headers.get('content-range')}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length !== 99000) fail(`Range 长度 ${body.length}（预期 99000）`);
  if (!body.equals(FILE.subarray(1000, 100000))) fail('Range 内容不一致');
  ok('Range 请求返回 206 + 正确 Content-Range + 字节切片一致');
}

// ===== 5. 预览（Content-Type 透传） =====
{
  const res = await fetch(`${API}/proxy/preview/${sessionId}?filePath=${encodeURIComponent('/data/test.bin')}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 200) fail(`预览状态码 ${res.status}`);
  if (res.headers.get('content-type') !== 'application/x-test') fail(`预览 Content-Type=${res.headers.get('content-type')}（预期透传 application/x-test）`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.equals(FILE)) fail('预览内容不一致');
  ok('预览经隧道回传，Host 报告的 Content-Type 正确透传');
}

// ===== 6. Host 读取失败 → 502 =====
{
  const res = await fetch(`${API}/proxy/download/${sessionId}?filePath=${encodeURIComponent('/err')}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 502) fail(`错误路径状态码 ${res.status}（预期 502）`);
  const json = await res.json();
  if (json.error?.code !== 'TUNNEL_ERROR') fail(`错误码 ${json.error?.code}（预期 TUNNEL_ERROR）`);
  ok('Host 读取失败时返回 502 TUNNEL_ERROR');
}

hostWs.close(1000);
console.log('\n🎉 WS 文件隧道全链路验证全部通过');
process.exit(0);
