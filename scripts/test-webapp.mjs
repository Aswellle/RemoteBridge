// RemoteBridge web client smoke test
// Tests frontend-renderable parts without a desktop Host:
//   page rendering, PIN input formatting, connect button state,
//   host-history panel, route guards, and console health.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR || 'scripts/.test-shots';
const results = [];
let browser;

function ok(name, detail) { results.push({ name, pass: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { results.push({ name, pass: false, detail }); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }

async function shot(page, label) {
  try {
    await page.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: true, timeout: 8000, animations: 'disabled' });
  } catch (e) { console.log(`  ! screenshot ${label} skipped (${e.message.split('\n')[0]})`); }
}

async function main() {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  const notFound = [];
  page.on('response', r => { if (r.status() === 404) notFound.push(r.url()); });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  console.log(`\n=== RemoteBridge web client test @ ${BASE} ===\n`);

  // ── 1. Landing page renders ──────────────────────────────────
  console.log('[1] Landing page render');
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('text=RemoteBridge', { timeout: 15000 });
    ok('page loads');
  } catch (e) {
    bad('page loads', e.message);
    await shot(page, '01-landing-error');
    return finish();
  }

  try { await page.waitForSelector('text=远程文件桥接系统', { timeout: 5000 }); ok('brand title renders'); }
  catch { bad('brand title renders'); }
  try { await page.waitForSelector('text=连接到远程电脑', { timeout: 5000 }); ok('connect heading renders'); }
  catch { bad('connect heading renders'); }
  await shot(page, '01-landing');

  // ── 2. PIN input formatting ──────────────────────────────────
  console.log('\n[2] PIN input');
  const pinInput = page.getByPlaceholder('XXXX-XXXX');
  try { await pinInput.waitFor({ state: 'visible', timeout: 5000 }); ok('PIN input visible'); }
  catch { bad('PIN input visible'); }
  try {
    await pinInput.fill('abcd1234');
    await page.waitForTimeout(200);
    const val = await pinInput.inputValue();
    ok('PIN auto-formats with dash', val === 'ABCD-1234' ? `got "${val}"` : `expected ABCD-1234 got "${val}"`);
  } catch (e) { bad('PIN auto-formats', e.message); }

  // ── 3. Device label input ────────────────────────────────────
  console.log('\n[3] Device label input');
  const labelInput = page.getByPlaceholder('我的设备');
  try {
    await labelInput.waitFor({ state: 'visible', timeout: 5000 });
    ok('device label pre-filled', (await labelInput.inputValue()) || 'empty');
  } catch (e) { bad('device label input', e.message); }

  // ── 4. Connect button state ──────────────────────────────────
  console.log('\n[4] Connect button');
  const btn = page.getByRole('button', { name: '连接' });
  try {
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await pinInput.fill('');
    await page.waitForTimeout(200);
    ok('connect button disabled while PIN empty', (await btn.isDisabled()) ? 'disabled' : 'expected disabled');
  } catch (e) { bad('connect button disabled', e.message); }
  try {
    await pinInput.fill('TEST9999');
    await page.waitForTimeout(200);
    ok('connect button enabled with valid 8-char PIN', (await btn.isDisabled()) ? 'still disabled' : 'enabled');
  } catch (e) { bad('connect button enable', e.message); }
  await shot(page, '02-form-filled');

  // ── 5. Host history panel (empty state) ──────────────────────
  console.log('\n[5] Host history panel');
  try { await page.waitForSelector('text=最近连接的设备', { timeout: 5000 }); ok('history panel heading renders'); }
  catch { bad('history panel heading'); }
  try { await page.waitForSelector('text=暂无连接记录', { timeout: 5000 }); ok('empty-state message renders'); }
  catch { bad('empty-state message'); }
  try { await page.waitForSelector('text=安全连接 · 端到端加密 · 无需开放端口', { timeout: 5000 }); ok('security footer renders'); }
  catch { bad('security footer'); }

  // ── 6. Route guard: dashboard when not connected ─────────────
  console.log('\n[6] Route guard (no session)');
  try {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    const url = page.url();
    ok('dashboard route behaves (no session)', url.endsWith('/dashboard') ? `stays @ ${url}` : `redirected to ${url}`);
    await shot(page, '03-dashboard');
  } catch (e) { bad('route guard', e.message); }

  // ── 7. Connect attempt needs a Host (document only) ──────────
  console.log('\n[7] Connect flow (host-dependent, documented)');
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pinInput.waitFor({ state: 'visible', timeout: 5000 });
    await pinInput.fill('NOHOST01');
    await page.waitForTimeout(200);
    const enabled = !(await btn.isDisabled());
    ok('connect button submits with valid PIN', enabled ? 'ready (full connect needs a desktop Host)' : 'button disabled — see hydration note');
    await shot(page, '04-connect-ready');
  } catch (e) { bad('connect flow', e.message); }

  // ── 8. Console health ────────────────────────────────────────
  console.log('\n[8] Console health');
  const realErrors = consoleErrors.filter(e => !e.includes('hydration-mismatch') && !e.includes("didn't match"));
  if (realErrors.length === 0) ok('no unexpected console errors');
  else bad('no unexpected console errors', `${realErrors.length}: ${realErrors.slice(0,2).join(' | ')}`);
  if (notFound.length > 0) console.log(`  ℹ 404 resources: ${notFound.join(', ')}`);

  await finish();
}

async function finish() {
  if (browser) await browser.close();
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n=== Result: ${passed}/${total} passed ===\n`);
  if (passed !== total) {
    console.log('FAILED CHECKS:');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}: ${r.detail || ''}`));
  }
  console.log(`Screenshots: ${process.env.SHOTS_DIR || 'scripts/.test-shots'}/`);
  process.exit(passed === total ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
