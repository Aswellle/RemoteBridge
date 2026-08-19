// Lightweight RemoteBridge Host simulator (Node 22, no Electron).
// Replaces the desktop host for E2E web-client testing:
//   1. register-host  → hostId + JWT
//   2. WS connect as host (?token=)
//   3. handle PING, CMD_LIST_DIR, CMD_LIST_ALLOWED, CMD_REQUEST_DOWNLOAD,
//      CMD_FETCH_FILE (binary tunnel), CMD_REQUEST_PREVIEW, CMD_UPLOAD_FILE_CHUNK
//   4. generate-pin via REST so a web client can pair
import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'node:crypto';
import http from 'node:http';

const RELAY = process.env.RELAY_URL || 'http://localhost:3002';
const RELAY_WS = process.env.RELAY_WS_URL || 'ws://localhost:3002';
const ROOT = process.env.HOST_ROOT
  ? path.resolve(process.env.HOST_ROOT)
  : path.resolve('scripts/.e2e-fixtures');

const log = (...a) => console.log('[host]', ...a);
const warn = (...a) => console.warn('[host]', ...a);

let hostId = null;
let hostToken = null;
let pin = null;
let ws = null;

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------
async function registerHost() {
  const res = await fetch(`${RELAY}/api/v1/auth/register-host`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'E2E-Sim-Host', os: 'win32', version: '1.0.0' }),
  });
  const body = await res.json();
  if (!body.success) throw new Error('register-host failed: ' + JSON.stringify(body.error));
  hostId = body.data.hostId;
  hostToken = body.data.token;
  log('registered hostId=%s', hostId);
  return body.data;
}

async function generatePin() {
  const res = await fetch(`${RELAY}/api/v1/auth/generate-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  if (!body.success) throw new Error('generate-pin failed: ' + JSON.stringify(body.error));
  pin = body.data.pin;
  log('generated PIN=%s expiresIn=%ss', pin, body.data.expiresIn);
  return body.data;
}

// ---------------------------------------------------------------------------
// Path safety — keep all access inside ROOT
// ---------------------------------------------------------------------------
function safePath(requested) {
  const normalized = path.normalize(requested);
  const full = path.isAbsolute(normalized) ? normalized : path.join(ROOT, normalized);
  const rel = path.relative(ROOT, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

function isPreviewable(ext) {
  return ['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'].includes(ext);
}

// ---------------------------------------------------------------------------
// WS message handlers
// ---------------------------------------------------------------------------
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleListDir(payload) {
  const { path: requestedPath, requestId, clientId, sessionId } = payload;
  const dir = requestedPath ? safePath(requestedPath) : ROOT;
  if (!dir) {
    send({ type: 'RESP_DIR_ERROR', sessionId, payload: { requestId, code: 'PATH_BLOCKED', message: '路径超出允许范围', clientId, sessionId } });
    return;
  }
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      send({ type: 'RESP_DIR_ERROR', sessionId, payload: { requestId, code: 'NOT_DIRECTORY', message: '路径不是目录', clientId, sessionId } });
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const fileEntries = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      try {
        const st = await fs.stat(fullPath);
        const ext = entry.isDirectory() ? '' : path.extname(entry.name).slice(1).toLowerCase();
        return {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? 'dir' : 'file',
          size: st.size,
          modifiedAt: Math.floor(st.mtimeMs / 1000),
          extension: ext,
          isPreviewable: !entry.isDirectory() && isPreviewable(ext),
        };
      } catch { return null; }
    }));
    send({
      type: 'RESP_DIR_LIST',
      sessionId,
      payload: { requestId, path: dir, entries: fileEntries.filter(Boolean), parentPath: path.dirname(dir), clientId, sessionId },
    });
  } catch {
    send({ type: 'RESP_DIR_ERROR', sessionId, payload: { requestId, code: 'NOT_FOUND', message: '目录不存在', clientId, sessionId } });
  }
}

async function handleListAllowed(payload) {
  const { requestId, clientId, sessionId } = payload;
  send({
    type: 'RESP_DIR_LIST',
    sessionId,
    payload: {
      requestId, path: null, parentPath: null, clientId, sessionId,
      entries: [{ name: 'e2e-fixtures', path: ROOT, type: 'dir', size: 0, modifiedAt: 0, extension: '', isPreviewable: false, permission: 'readonly' }],
    },
  });
}

async function handleRequestDownload(payload) {
  const { path: requestedPath, requestId, clientId, sessionId } = payload;
  const file = safePath(requestedPath);
  if (!file) {
    send({ type: 'RESP_DOWNLOAD_ERROR', sessionId, payload: { requestId, code: 'PATH_BLOCKED', message: '路径超出允许范围', clientId, sessionId } });
    return;
  }
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) {
      send({ type: 'RESP_DOWNLOAD_ERROR', sessionId, payload: { requestId, code: 'NOT_FILE', message: '路径不是文件', clientId, sessionId } });
      return;
    }
    const transferId = crypto.randomUUID();
    send({
      type: 'RESP_DOWNLOAD_READY',
      sessionId,
      payload: { requestId, transferId, fileName: path.basename(file), fileSize: st.size, contentType: 'application/octet-stream', clientId, sessionId },
    });
  } catch {
    send({ type: 'RESP_DOWNLOAD_ERROR', sessionId, payload: { requestId, code: 'NOT_FOUND', message: '文件不存在', clientId, sessionId } });
  }
}

// CMD_FETCH_FILE → stream binary frames over WS
async function handleFetchFile(payload) {
  const { transferId, path: requestedPath, seq } = payload;
  const file = safePath(requestedPath);
  if (seq === undefined || seq > 0) return; // only respond to initial request (seq 0 / undefined)
  if (!file) {
    send({ type: 'RESP_FILE_ERROR', payload: { transferId, code: 'PATH_BLOCKED', message: '路径超出允许范围' } });
    return;
  }
  try {
    const data = await fs.readFile(file);
    const CHUNK = 64 * 1024;
    let offset = 0;
    let seqNum = 0;
    while (offset < data.length) {
      const end = Math.min(offset + CHUNK, data.length);
      const slice = data.subarray(offset, end);
      const eof = end >= data.length;
      const frame = encodeFrame(transferId, seqNum, eof, slice, path.basename(file), data.length);
      ws.send(frame);
      offset = end;
      seqNum++;
    }
  } catch {
    send({ type: 'RESP_FILE_ERROR', payload: { transferId, code: 'READ_ERROR', message: '读取失败' } });
  }
}

// minimal binary frame encoder matching file-tunnel-codec layout
function encodeFrame(transferId, seq, eof, chunk, fileName, totalSize) {
  const transferIdBuf = Buffer.from(transferId, 'ascii');
  const fileNameBuf = Buffer.from(fileName, 'utf-8');
  const flags = (eof ? 0b01 : 0b00) | (seq === 0 ? 0b10 : 0b00);
  const headerLen = 2 + 2 + transferIdBuf.length + 4;
  const metaLen = seq === 0 ? (8 + 8 + 8 + 2 + fileNameBuf.length) : 0;
  const buf = Buffer.allocUnsafe(headerLen + metaLen + chunk.length);
  let o = 0;
  buf.writeUInt8(1, o); o++;            // version
  buf.writeUInt8(flags, o); o++;        // flags
  buf.writeUInt16BE(transferIdBuf.length, o); o += 2;
  transferIdBuf.copy(buf, o); o += transferIdBuf.length;
  buf.writeUInt32BE(seq, o); o += 4;
  if (seq === 0) {
    buf.writeUInt32BE(Math.floor(totalSize / 0x100000000), o); o += 4;
    buf.writeUInt32BE(totalSize >>> 0, o); o += 4;
    buf.writeUInt32BE(0, o); o += 4; buf.writeUInt32BE(0, o); o += 4;       // rangeStart
    buf.writeUInt32BE(0, o); o += 4; buf.writeUInt32BE(totalSize, o); o += 4; // rangeEnd
    buf.writeUInt16BE(0, o); o += 2; // contentTypeLen = 0
    buf.writeUInt16BE(fileNameBuf.length, o); o += 2;
    fileNameBuf.copy(buf, o); o += fileNameBuf.length;
  }
  chunk.copy(buf, o);
  return buf;
}

// ---------------------------------------------------------------------------
// WS connect & event loop
// ---------------------------------------------------------------------------
function connectWs() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${RELAY_WS}/ws?type=host&token=${hostToken}`);
    ws.on('open', () => {
      log('WS connected as host');
      resolve();
    });
    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return; // host doesn't expect binary frames from relay
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.type) {
        case 'PING': send({ type: 'PONG', timestamp: msg.timestamp }); break;
        case 'CMD_LIST_DIR': await handleListDir(msg.payload); break;
        case 'CMD_LIST_ALLOWED': await handleListAllowed(msg.payload); break;
        case 'CMD_REQUEST_DOWNLOAD': await handleRequestDownload(msg.payload); break;
        case 'CMD_FETCH_FILE': await handleFetchFile(msg.payload); break;
        case 'CMD_REQUEST_PREVIEW': {
          // reuse download path: signal ready, then relay will issue CMD_FETCH_FILE
          const p = msg.payload;
          const file = safePath(p.path);
          if (!file) { send({ type: 'RESP_PREVIEW_ERROR', sessionId: p.sessionId, payload: { requestId: p.requestId, code: 'PATH_BLOCKED', message: '路径超出允许范围', clientId: p.clientId, sessionId: p.sessionId } }); break; }
          try {
            const st = await fs.stat(file);
            send({ type: 'RESP_PREVIEW_READY', sessionId: p.sessionId, payload: { requestId: p.requestId, transferId: crypto.randomUUID(), fileName: path.basename(file), fileSize: st.size, contentType: 'application/octet-stream', clientId: p.clientId, sessionId: p.sessionId } });
          } catch {
            send({ type: 'RESP_PREVIEW_ERROR', sessionId: p.sessionId, payload: { requestId: p.requestId, code: 'NOT_FOUND', message: '文件不存在', clientId: p.clientId, sessionId: p.sessionId } });
          }
          break;
        }
        case 'CMD_UPLOAD_FILE_CHUNK': {
          const p = msg.payload;
          send({ type: 'RESP_UPLOAD_ACK', sessionId: p.sessionId, payload: { uploadId: p.uploadId, chunkIndex: p.chunkIndex, received: true, clientId: p.clientId, sessionId: p.sessionId } });
          break;
        }
        default: break;
      }
    });
    ws.on('error', (e) => warn('WS error:', e.message));
    ws.on('close', () => { log('WS closed'); ws = null; });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await registerHost();
  await connectWs();
  await generatePin();
  log('=== HOST READY ===');
  log('PIN=%s  root=%s', pin, ROOT);

  // control server: GET /pin → regenerate + return new PIN
  const ctl = http.createServer(async (req, res) => {
    if (req.url === '/pin' && req.method === 'GET') {
      const g = await generatePin();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pin, hostId, root: ROOT }));
    } else if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  ctl.listen(4321, '127.0.0.1', () => log('control server on http://127.0.0.1:4321'));

  // keep alive
  setInterval(() => { if (!ws) process.exit(0); }, 1000);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
