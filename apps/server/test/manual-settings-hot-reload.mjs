// 设置热重载功能测试（CDP 驱动真实渲染端）：
// 阶段 A — 直接调 electronAPI.saveSettings，验证 Relay 地址变更触发主进程热重连；
// 阶段 B — 模拟用户点击设置页 UI（切主题→保存），验证渲染端 applyTheme 真实链路。
// 前置：electron 以 --remote-debugging-port=9222 启动；3001 与 3002 relay 均运行中。
//
// P1-14: 需要通过 CDP 驱动一个真实运行中的 Electron 渲染进程，无法在 vitest 中
// 无头运行，保留为手动脚本，不计入 vitest 套件/CI。
//
// ## Candidates for vitest migration (test-and-doc-gaps-plan.md #3)
// 阶段 A（断言 A1-A4）实质测试的是主进程 IPC handler，不依赖渲染 DOM，
// 可迁移到 apps/desktop/test/*（mock ws-client/client 的 getRelayClient + ensureHostRegisteredAndConnected，
// 直接调用 ipcMain handler）：
// - A1/A4（saveSettings({relayUrl 变更}) → reconnected === true，往返切换 3002↔3001）→
//   apps/desktop/src/main/ipc/settings.ts 的 `settings:save` handler 中
//   relayUrlChanged 分支（断开旧连接 → ensureHostRegisteredAndConnected）。
// - A2（重连后 getRelayStatus().connected === true）→
//   apps/desktop/src/main/ipc/auth.ts 的 `relay:get-status` handler，
//   反映 getRelayClient() 连接状态，可在 settings:save 之后直接断言。
// - A3（getRelayUrl() 反映新地址）→ `host:get-relay-url` handler，
//   读取 config.getRelayUrl()，纯 config getter/setter 往返。
// - B6（getSettings().theme === 'light' 持久化）→ `settings:get`/`settings:save`
//   handler 的 config.getTheme()/setTheme() 往返，与 UI 点击路径无关。
// 上述均可新增 apps/desktop/test/ipc-settings.test.ts，仿照
// apps/desktop/test/token-manager.test.ts 等现有 mock 风格。
//
// B4/B7 中 applyTheme() 本身（apps/desktop/src/renderer/theme.ts：对
// document.documentElement.classList 做 toggle('light', ...)）是一个纯 DOM
// 操作，理论上可在 jsdom 环境下单测；但 apps/desktop/test/* 目前只有主进程测试，
// 无渲染端/jsdom 测试基建，迁移性价比低，暂不列为候选。
//
// 仍需保留为 CDP 脚本（真正需要渲染 DOM）：
// - B1-B3（设置页导航/按钮点击的真实交互路径）。
// - B4/B7 中 <html>.light 类的最终断言（依赖 B1-B3 这条真实点击链路触发）。
// - B5（getComputedStyle 计算后的背景色，需要真实 CSS 渲染，无法用 jsdom 替代）。
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log('✅ ' + m); };
const fail = (m) => { failed++; console.error('❌ ' + m); };

// 1. 找到渲染端页面 target
let page;
for (let i = 0; i < 15 && !page; i++) {
  try {
    const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
    page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
  } catch { /* electron 还在启动 */ }
  if (!page) await sleep(1000);
}
if (!page) { fail('找不到渲染端 CDP target'); process.exit(1); }
ok(`CDP 已连接渲染端: ${page.url.slice(0, 60)}`);

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
    const t = setTimeout(() => reject(new Error('CDP evaluate 超时: ' + expression.slice(0, 50))), 30000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
      else resolve(msg.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
  });
}

// 2. 等待初始连接（3001）就绪
let initiallyConnected = false;
for (let i = 0; i < 10; i++) {
  const st = await evaluate('window.electronAPI.getRelayStatus()', true);
  if (st?.connected) { initiallyConnected = true; break; }
  await sleep(1000);
}
initiallyConnected ? ok('初始状态：已连接 3001') : fail('初始未连接 3001');

// ===== 阶段 A：Relay 地址热重连（直连 electronAPI） =====
const saveResult = await evaluate(`window.electronAPI.saveSettings({
  relayUrl: 'ws://127.0.0.1:3002/ws',
  relayApiUrl: 'http://127.0.0.1:3002/api/v1',
  autoStart: false, minimizeToTray: true, theme: 'dark',
})`, true);
saveResult?.success && saveResult?.reconnected === true
  ? ok('A1. 切到 3002：saveSettings 触发热重连成功')
  : fail(`A1. 热重连失败: ${JSON.stringify(saveResult)}`);

await sleep(500);
const st2 = await evaluate('window.electronAPI.getRelayStatus()', true);
st2?.connected ? ok('A2. 重连后 WS 已连接') : fail('A2. 重连后未连接');
const url2 = await evaluate('window.electronAPI.getRelayUrl()', true);
url2 === 'ws://127.0.0.1:3002/ws' ? ok(`A3. 主进程 Relay URL 已生效: ${url2}`) : fail(`A3. URL 不对: ${url2}`);

// 切回 3001（双向验证热重连）
const back = await evaluate(`window.electronAPI.saveSettings({
  relayUrl: 'ws://127.0.0.1:3001/ws',
  relayApiUrl: 'http://127.0.0.1:3001/api/v1',
  autoStart: false, minimizeToTray: true, theme: 'dark',
})`, true);
back?.success && back?.reconnected === true
  ? ok('A4. 切回 3001 同样热重连成功')
  : fail(`A4. 切回失败: ${JSON.stringify(back)}`);

// ===== 阶段 B：真实 UI 链路（设置页点击 → applyTheme） =====
const clickByText = (text) => `(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
  if (!btn) return 'NOT_FOUND';
  btn.click(); return 'CLICKED';
})()`;

// 进设置页
let r = await evaluate(clickByText('设置'));
r === 'CLICKED' ? ok('B1. 打开设置页') : fail('B1. 找不到设置导航按钮');
await sleep(800);

// 点亮色 → 保存
r = await evaluate(clickByText('☀️ 亮色'));
r === 'CLICKED' ? ok('B2. 选择亮色主题') : fail('B2. 找不到亮色按钮: ' + r);
await sleep(200);
r = await evaluate(clickByText('保存设置'));
r === 'CLICKED' ? ok('B3. 点击保存') : fail('B3. 找不到保存按钮');
await sleep(1500);

const isLight = await evaluate(`document.documentElement.classList.contains('light')`);
isLight ? ok('B4. 保存后 <html> 带 .light 类（applyTheme 生效）') : fail('B4. .light 类未应用');
const bg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
bg && bg.startsWith('rgb(2') ? ok(`B5. body 背景已切亮色: ${bg}`) : fail(`B5. 背景未变: ${bg}`);
const persisted = await evaluate('window.electronAPI.getSettings()', true);
persisted?.theme === 'light' ? ok('B6. 主题已持久化到 config') : fail(`B6. 持久化失败: ${persisted?.theme}`);

// 切回暗色（恢复现场 + 二次验证）
await evaluate(clickByText('🌙 暗色'));
await sleep(200);
await evaluate(clickByText('保存设置'));
await sleep(1500);
const bgBack = await evaluate(`getComputedStyle(document.body).backgroundColor`);
const isDarkAgain = await evaluate(`!document.documentElement.classList.contains('light')`);
isDarkAgain && bgBack && !bgBack.startsWith('rgb(2')
  ? ok(`B7. 切回暗色立即生效: ${bgBack}`)
  : fail(`B7. 暗色未恢复: light=${!isDarkAgain}, bg=${bgBack}`);

ws.close();
console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
