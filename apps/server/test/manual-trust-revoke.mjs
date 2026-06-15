// 桌面端「信任 / 吊销」功能实测（CDP 驱动真实渲染端 UI）。
// 前置：electron 以 --remote-debugging-port=9222 启动并已连接 relay；
//       有一个在线的 web 客户端会话（用于被信任/吊销）。
// 验证：clients:list 含 sessionId/online；信任↔取消信任往返；吊销按 sessionId 真正生效。
//
// P1-14: 需要通过 CDP 驱动一个真实运行中的 Electron 渲染进程及在线 web 客户端会话，
// 无法在 vitest 中无头运行，保留为手动脚本，不计入 vitest 套件/CI。
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log('✅ ' + m); };
const fail = (m) => { failed++; console.error('❌ ' + m); };

// ===== CDP 连接 =====
let page;
for (let i = 0; i < 15 && !page; i++) {
  try {
    const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
    page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
  } catch {}
  if (!page) await sleep(1000);
}
if (!page) { fail('找不到桌面端 CDP target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let msgId = 0;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
function evaluate(expression, awaitPromise = false) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP 超时: ' + expression.slice(0, 60))), 30000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
      else resolve(msg.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
  });
}

// ===== 1. clients:list 数据形状 =====
const list = await evaluate('window.electronAPI.listClients()', true);
if (!Array.isArray(list) || list.length === 0) {
  fail(`列表为空: ${JSON.stringify(list)}`);
  process.exit(1);
}
const target = list.find((c) => c.online) || list[0];
ok(`1. listClients 返回 ${list.length} 项`);
(target.sessionId && typeof target.sessionId === 'string')
  ? ok(`2. 条目含 sessionId（吊销前提）: ${target.sessionId.slice(0, 10)}...`)
  : fail(`2. 条目缺 sessionId: ${JSON.stringify(target)}`);
target.online === true
  ? ok(`3. online 实时状态正确（${target.label || target.clientId.slice(0, 8)} 在线）`)
  : fail(`3. 目标客户端不在线: ${JSON.stringify(target)}`);

// ===== 2. 信任 ↔ 取消信任 往返 =====
let r = await evaluate(`window.electronAPI.trustClient(${JSON.stringify(target.clientId)}, true)`, true);
r?.success ? ok('4. 信任操作成功') : fail(`4. 信任失败: ${JSON.stringify(r)}`);
let after = await evaluate('window.electronAPI.listClients()', true);
after.find((c) => c.clientId === target.clientId)?.isTrusted === true
  ? ok('5. 信任标记已持久化并出现在列表中')
  : fail('5. 信任标记未生效');

r = await evaluate(`window.electronAPI.trustClient(${JSON.stringify(target.clientId)}, false)`, true);
after = await evaluate('window.electronAPI.listClients()', true);
(r?.success && after.find((c) => c.clientId === target.clientId)?.isTrusted === false)
  ? ok('6. 取消信任往返成功')
  : fail('6. 取消信任失败');

// ===== 3. UI 层验证：客户端页渲染 + 按钮可用 =====
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('客户端'))?.click(); 'nav'`);
await sleep(1200);
const uiState = await evaluate(`(() => {
  const text = document.body.textContent;
  const revokeBtns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '吊销');
  return {
    hasLabel: text.includes(${JSON.stringify(target.label || target.clientId.slice(0, 8))}),
    revokeCount: revokeBtns.length,
    revokeEnabled: revokeBtns.some(b => !b.disabled),
    hasTrustBtn: [...document.querySelectorAll('button')].some(b => ['信任','取消信任'].includes(b.textContent.trim())),
  };
})()`);
(uiState.hasLabel && uiState.revokeEnabled && uiState.hasTrustBtn)
  ? ok(`7. 客户端页 UI 完整（标签可见 / 吊销可用 / 信任按钮存在）`)
  : fail(`7. UI 异常: ${JSON.stringify(uiState)}`);

// ===== 4. 吊销（驱动真实 UI 按钮，自动确认对话框） =====
await evaluate(`window.confirm = () => true; 'confirm overridden'`);
await evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '吊销').find(b => !b.disabled)?.click(); 'revoke clicked'`);
await sleep(2500);
const afterRevoke = await evaluate('window.electronAPI.listClients()', true);
const stillThere = afterRevoke.find((c) => c.sessionId === target.sessionId);
!stillThere
  ? ok('8. 吊销后该会话从列表消失（relay 端已标记 revoked）')
  : fail(`8. 会话仍在列表: ${JSON.stringify(stillThere)}`);

ws.close();
console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
