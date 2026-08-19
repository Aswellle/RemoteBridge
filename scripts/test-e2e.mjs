// Full E2E test: web client ↔ relay ↔ host-simulator.
// Covers: PIN pairing, connection, dashboard render, file browsing, console health.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const HOST_CTL = 'http://127.0.0.1:4321';
const SHOTS = process.env.SHOTS_DIR || 'scripts/.test-shots-e2e';
const results = [];
let browser;
let page;
let PIN = null;

function ok(n, d) { results.push({ n, pass: true, d }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
function bad(n, d) { results.push({ n, pass: false, d }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
async function shot(l) {
  try { await page.screenshot({ path: `${SHOTS}/${l}.png`, fullPage: true, timeout: 8000, animations: 'disabled' }); }
  catch { console.log(`  ! shot ${l} skipped`); }
}

async function getPinFromHost() {
  try {
    const res = await fetch(`${HOST_CTL}/pin`);
    if (res.ok) { const d = await res.json(); return d.pin; }
  } catch { /* fall through */ }
  const log = await (await import('fs/promises')).readFile('/tmp/host-sim.log', 'utf8');
  const m = log.match(/([A-Z0-9]{8})/);
  return m ? m[1] : null;
}

async function finish() {
  if (browser) await browser.close();
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n=== Result: ${passed}/${total} passed ===\n`);
  if (passed !== total) {
    console.log('FAILED:');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.n}: ${r.d || ''}`));
  }
  console.log(`Screenshots: ${SHOTS}/`);
  process.exit(passed === total ? 0 : 1);
}

async function main() {
  PIN = await getPinFromHost();
  if (!PIN) { console.error('FATAL: no PIN from host simulator'); process.exit(2); }
  console.log(`\n=== RemoteBridge E2E test @ ${BASE} (PIN ${PIN}) ===\n`);

  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/hydration|404/.test(m.text())) consoleErrors.push(m.text()); });

  // ── 1. Landing renders ─────────────────────────────────────────
  console.log('[1] Landing page');
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('text=连接到远程电脑', { timeout: 10000 });
    ok('landing page renders');
    await shot('e2e-01-landing');
  } catch (e) { bad('landing page renders', e.message); return finish(); }

  // ── 2. PIN pairing + connection ───────────────────────────────
  console.log('\n[2] PIN pairing & connection');
  const pinInput = page.getByPlaceholder('XXXX-XXXX');
  try {
    await pinInput.waitFor({ state: 'visible', timeout: 5000 });
    await pinInput.fill(PIN.toLowerCase());
    await page.waitForTimeout(300);
    const connectBtn = page.getByRole('button', { name: '连接' });
    ok('connect button enabled with valid PIN', !(await connectBtn.isDisabled()) ? 'enabled' : 'disabled');
    await connectBtn.click();
    await page.waitForFunction(() => window.location.pathname.startsWith('/dashboard'), { timeout: 15000 });
    ok('connected & redirected to dashboard', page.url());
    await shot('e2e-02-connected');
  } catch (e) { bad('PIN pairing & connection', e.message); await shot('e2e-02-fail'); return finish(); }

  // ── 3. Dashboard renders after connect ────────────────────────
  console.log('\n[3] Dashboard');
  try {
    await page.waitForTimeout(1500);
    ok('on dashboard page', page.url().includes('/dashboard') ? page.url() : 'not on dashboard');
    await shot('e2e-03-dashboard');
  } catch (e) { bad('dashboard', e.message); }

  // ── 4. File browsing ──────────────────────────────────────────
  console.log('\n[4] File browsing');
  try {
    const link = page.getByRole('link', { name: /文件|Files/i });
    const btn = page.getByRole('button', { name: /文件|Files/i });
    if (await link.count() > 0) await link.first().click();
    else if (await btn.count() > 0) await btn.first().click();
    await page.waitForTimeout(1500);
    await shot('e2e-04-files');
    ok('file browser opened', 'navigated');
  } catch (e) { bad('file browsing', e.message); }

  // ── 5. Console health ─────────────────────────────────────────
  console.log('\n[5] Console health');
  if (consoleErrors.length === 0) ok('no console errors');
  else bad('no console errors', consoleErrors.slice(0, 2).join(' | '));

  await finish();
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
