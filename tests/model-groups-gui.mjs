/* 模型汇总 GUI 自检(真 Chromium + 真服务端 + mock 上游):
 *   node tests/model-groups-gui.mjs
 *
 * 背景:这个功能的承诺是「汇总之后,前台看上去就和只添加了一个供应商、一个模型完全一样」。
 * 这句话不是接口字段能保证的,而是三个渲染环节的结果:后台面板有没有把汇总组画出来、
 * 总开关能否从界面上打开、前台模型选择器最终把那一条显示成什么样子。任何一环接错线,
 * 接口返回的数据都是对的,用户看到的却是两条重复的模型 —— 只有真浏览器量 DOM 才看得出来。
 *
 * 用例:
 *   1) 后台「模型汇总」面板:默认关闭、空列表提示、同名可汇总提示;
 *   2) 界面上打开总开关 → 自动生成同名汇总卡片(标签/候选数/成员渠道);
 *   3) 前台模型选择器只有一条「agg-model」,标签里没有「渠道@模型」那种拼接,当前模型名就是它;
 *   4) 弹窗手动新增汇总(填 ID / 显示名 / 选轮询 / 勾成员)→ 卡片出现;
 *   5) 前台只显示自定义 ID(显示名出现在列表里,被收纳的成员模型消失);
 *   6) 停用 / 启用 的按钮接线与卡片状态;
 *   7) 关掉总开关后前台恢复成「渠道@模型」两条;
 *   8) 全程无 JS 异常。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8321);
const MOCK_A_PORT = Number(process.env.GUI_MOCK_A_PORT || 8322);
const MOCK_B_PORT = Number(process.env.GUI_MOCK_B_PORT || 8323);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'agggui-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似上一次测试残留的 php -S),请先结束该进程或用 GUI_PORT 换端口`);
  process.exit(1);
}
await assertPortFree(PORT);
await assertPortFree(MOCK_A_PORT);
await assertPortFree(MOCK_B_PORT);

async function loadPlaywright() {
  const candidates = [];
  try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未本地安装 */ }
  const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      const p = join(cache, dir, 'node_modules', 'playwright', 'index.mjs');
      if (existsSync(p)) candidates.push(pathToFileURL(p).href);
    }
  }
  for (const c of candidates) { try { return await import(c); } catch (e) { /* 试下一个 */ } }
  return null;
}
const pw = await loadPlaywright();
if (!pw) { console.log('(skip) 未找到 playwright,跳过模型汇总 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-modelagg-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
function spawnPhp(args, env) {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
}
function cleanup() {
  for (const p of procs) { try { p.kill(); } catch (e) { /* 忽略 */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.on('exit', cleanup);

const app = spawnPhp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_ALLOW_PRIVATE_UPSTREAM: '1', TC_WEB_CN_ONLY: '0',
});
let appErr = '';
app.stderr.on('data', (d) => { appErr += String(d); });
// 两个 mock 上游用 TAG 区分应答,主要给「前台请求真的打到某个渠道」留证据(这里只用到 /models)
spawnPhp(['-S', `127.0.0.1:${MOCK_A_PORT}`, 'tests/mock-agg-upstream.php'], { TC_MOCK_TAG: 'A' });
spawnPhp(['-S', `127.0.0.1:${MOCK_B_PORT}`, 'tests/mock-agg-upstream.php'], { TC_MOCK_TAG: 'B' });

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status) return true; } catch (e) { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}
if (!(await waitFor(BASE + '/api/config'))) {
  console.error('✗ 应用服务未启动\n' + appErr.slice(-1500));
  process.exit(1);
}
await waitFor(`http://127.0.0.1:${MOCK_A_PORT}/models`);
await waitFor(`http://127.0.0.1:${MOCK_B_PORT}/models`);

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

// 两个渠道提供同名模型(同名自动汇总的触发条件)+ 一个只属于 B 的独有模型(验证自定义汇总)
async function newProv(name, port, modelId) {
  const r = await (await fetch(BASE + '/api/providers', {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({
      name, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-agg', apiFormat: 'chat',
      scope: 'global', costPerCall: 1, enabled: true, models: [{ id: modelId, name: modelId }],
    }),
  })).json();
  return r.provider && r.provider.id;
}
const PROV_A = await newProv('渠道A', MOCK_A_PORT, 'agg-model');
const PROV_B = await newProv('渠道B', MOCK_B_PORT, 'agg-model');
const PROV_ONLY = await newProv('渠道B-独占', MOCK_B_PORT, 'vendor-only');
if (!PROV_A || !PROV_B || !PROV_ONLY) { console.error('✗ 创建渠道失败'); process.exit(1); }

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const pageErrors = [];
function newPage() {
  const p = ctx.newPage ? null : null;
  return p;
}
async function openPage(url) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
  p.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  await p.addInitScript((t) => { localStorage.setItem('oc_token', t); }, login.token);
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  return p;
}

const toastText = async (p) => (await p.locator('#oc-toast-host .toast').allInnerTexts()).join(' | ');
// 提示条用完即走,断言前先等它出现(纯定时等待在 CI 上会偶发取到空串)
async function waitToast(p, text, timeout = 8000) {
  try {
    await p.waitForFunction((t) => {
      const host = document.getElementById('oc-toast-host');
      return !!host && host.textContent.indexOf(t) >= 0;
    }, text, { timeout });
    return true;
  } catch (e) { return false; }
}
// 前台模型选择器里的条目文字(打开 → 读 → 关掉)
async function pickerLabels(p) {
  await p.click('#model-picker');
  await p.waitForSelector('.oc-menu .oc-menu-item .item-label', { timeout: 8000 });
  const labels = await p.$$eval('.oc-menu .oc-menu-item .item-label', (els) => els.map((e) => e.textContent.trim()));
  await p.keyboard.press('Escape');
  await p.mouse.click(4, 4);
  await p.waitForTimeout(150);
  return labels;
}
// 前台就绪 = 登录态 + 模型列表已拉回来 + 模型名已渲染。
// 只等 state.user 会在「模型还没到」时就去点选择器,那时点开只会得到一句「暂无可用模型」。
async function waitFrontReady(p) {
  await p.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
  await p.waitForFunction(() => (window.OCApp.state.models || []).length > 0, null, { timeout: 20000 });
  await p.waitForFunction(() => {
    const e = document.getElementById('model-name');
    return !!e && e.textContent.trim() !== '';
  }, null, { timeout: 20000 });
}
async function openFront() {
  const p = await openPage(BASE + '/');
  await p.waitForSelector('#model-picker', { timeout: 20000 });
  await waitFrontReady(p);
  return p;
}
async function reloadFront(p) {
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#model-picker', { timeout: 20000 });
  await waitFrontReady(p);
}
async function openAdmin() {
  const p = await openPage(BASE + '/admin#platform/modelagg');
  await p.waitForSelector('#panel-modelagg.active', { timeout: 30000 });
  await p.waitForSelector('#ma-list .ma-card, #ma-list p', { timeout: 20000 });
  return p;
}
const card = (p, text) => p.locator('.ma-card', { hasText: text });

// ---------- 1. 后台面板初始状态 ----------
console.log('== 1. 后台面板(默认关闭) ==');
let admin = await openAdmin();
check('模型汇总页签能打开并激活面板', await admin.locator('#panel-modelagg.active').count() === 1);
check('总开关默认关闭', !(await admin.locator('#ma-enabled').isChecked()));
check('列表给出空状态引导', (await admin.locator('#ma-list').innerText()).includes('还没有汇总 ID'));
const dupesText = await admin.locator('#ma-dupes-note').innerText();
check('同名可汇总提示列出 agg-model（2 个渠道）', dupesText.includes('agg-model') && dupesText.includes('2 个渠道'));
check('同名提示默认可见', await admin.locator('#ma-dupes-note').isVisible());

// 开关本体是视觉隐藏的(观感由旁边的 .slider 画),点 .slider 才等价于用户的操作
async function setSwitch(p, sel, on) {
  const box = p.locator(sel);
  if ((await box.isChecked()) !== on) await p.locator(sel + ' + .slider').click();
  await p.waitForTimeout(120);
  return box.isChecked();
}

// ---------- 2. 界面上打开总开关 ----------
console.log('== 2. 打开总开关(同名自动生成) ==');
check('点开关后处于打开状态', await setSwitch(admin, '#ma-enabled', true));
await admin.click('#ma-settings-save');
await admin.waitForSelector('.ma-card', { timeout: 10000 });
check('保存后给出提示', (await toastText(admin)).includes('已启用模型汇总'));
check('汇总卡片标题是模型名本身', await admin.locator('.ma-card .ma-id').first().innerText() === 'agg-model');
const cardText = await card(admin, 'agg-model').innerText();
check('卡片标出「同名自动」', cardText.includes('同名自动'));
check('卡片标出故障自动转移', cardText.includes('故障自动转移'));
check('卡片标出候选渠道数 2', cardText.includes('2 个可用渠道'));
check('卡片列出成员渠道名', cardText.includes('渠道A') && cardText.includes('渠道B'));
check('状态行给出汇总总数', (await admin.locator('#ma-status').innerText()).includes('共 1 个汇总 ID'));

// ---------- 3. 前台:看起来就是一个普通模型 ----------
console.log('== 3. 前台显示(核心诉求) ==');
let front = await openFront();
check('当前模型名就是汇总 ID', (await front.locator('#model-name').innerText()).trim() === 'agg-model');
let labels = await pickerLabels(front);
// 两个渠道提供同一个模型名,汇总后必须只剩一条;未进任何汇总的模型(vendor-only)照旧可见
check('同名两条渠道收敛成一条(实际 ' + JSON.stringify(labels) + ')', labels.filter((x) => x.includes('agg-model')).length === 1);
check('那一条就是模型名本身', labels.includes('agg-model'));
check('没有「渠道@agg-model」这种重复项', !labels.some((x) => x.includes('@agg-model')));
check('未汇总的模型保持可见(默认不隐藏)', labels.some((x) => x.includes('vendor-only')));

// ---------- 4. 弹窗手动新增汇总 ----------
console.log('== 4. 手动新增汇总(弹窗) ==');
await admin.click('#ma-new');
await admin.waitForSelector('#ma-edit-id', { timeout: 8000 });
await admin.fill('#ma-edit-id', 'my-model');
await admin.fill('#ma-edit-label', '我的模型');
await admin.click('#ma-edit-strategy');
await admin.click('.oc-menu .oc-menu-item[data-value="roundrobin"]');
await admin.waitForTimeout(120);
check('下拉能切到轮询', (await admin.locator('#ma-edit-strategy .sb-label').innerText()).trim() === '轮询');
await admin.check(`#ma-edit-pick input[data-ma-pick="${PROV_ONLY}|vendor-only"]`);
await admin.click('#ma-edit-save');
await admin.waitForSelector('.ma-card:has-text("my-model")', { timeout: 10000 });
check('保存后给出提示', (await toastText(admin)).includes('已保存 my-model'));
const myCard = await card(admin, 'my-model').innerText();
check('卡片标出「手动」与「轮询」', myCard.includes('手动') && myCard.includes('轮询'));
check('卡片显示显示名', myCard.includes('我的模型'));

// ---------- 5. 前台只显示自定义 ID ----------
console.log('== 5. 前台只显示自定义 ID ==');
await reloadFront(front);
labels = await pickerLabels(front);
check('自定义汇总的显示名出现在列表里', labels.includes('我的模型'));
check('被收纳的成员模型不再单独出现', !labels.some((x) => x.includes('vendor-only')));
check('列表里仍然没有「渠道@模型」拼接', !labels.some((x) => x.includes('@')));

// ---------- 6. 停用 / 启用 ----------
console.log('== 6. 停用与启用 ==');
await card(admin, 'my-model').locator('[data-ma-toggle]').click();
await admin.waitForTimeout(600);
check('停用后给出提示', (await toastText(admin)).includes('已停用 my-model'));
check('卡片标记为已停用', (await card(admin, 'my-model').innerText()).includes('已停用'));
await card(admin, 'my-model').locator('[data-ma-toggle]').click();
await admin.waitForTimeout(600);
check('再次点击可重新启用', !(await card(admin, 'my-model').innerText()).includes('已停用'));

// ---------- 7. 关掉总开关,前台恢复原样 ----------
console.log('== 7. 关闭总开关后恢复原状 ==');
check('点开关后处于关闭状态', await setSwitch(admin, '#ma-enabled', false) === false);
await admin.click('#ma-settings-save');
await admin.waitForTimeout(600);
check('关闭后给出提示', (await toastText(admin)).includes('已关闭模型汇总'));
await reloadFront(front);
labels = await pickerLabels(front);
check('关闭后恢复成「渠道@模型」两条', labels.filter((x) => x.includes('@agg-model')).length === 2);
check('关闭后 vendor-only 也回来了', labels.some((x) => x.includes('vendor-only')));

// ---------- 8. 删除汇总:成员重新回到前台 ----------
console.log('== 8. 删除汇总 ==');
// 先把总开关打开,让 my-model 重新生效,再从卡片上删掉它
check('重新打开总开关', await setSwitch(admin, '#ma-enabled', true));
await admin.click('#ma-settings-save');
await waitToast(admin, '已启用模型汇总');
await admin.waitForSelector('.ma-card', { timeout: 10000 });
await card(admin, 'my-model').locator('[data-ma-del]').click();
await admin.waitForSelector('.oc-confirm-mask button[data-act="ok"]', { timeout: 8000 });
await admin.click('.oc-confirm-mask button[data-act="ok"]');
await admin.waitForTimeout(800);
check('删除后给出提示', (await toastText(admin)).includes('已删除 my-model'));
check('卡片已消失', await card(admin, 'my-model').count() === 0);
await reloadFront(front);
labels = await pickerLabels(front);
check('被收纳的成员模型重新出现在前台', labels.some((x) => x.includes('vendor-only')));
check('删除后自定义 ID 不再出现', !labels.includes('我的模型'));

// ---------- 9. 无 JS 异常 ----------
console.log('== 9. 运行期异常 ==');
// 与其它 GUI 用例同一口径:资源加载类噪音(reload 打断在途请求 → net::ERR_ABORTED、
// favicon 404)不算报错,只看真正的 JS 异常与脚本报错。
const realErrors = pageErrors.filter((e) => !/favicon|Failed to load resource|net::|ERR_/i.test(e));
check('全程无 JS 异常', realErrors.length === 0);
if (realErrors.length) console.log('    ' + realErrors.slice(0, 5).join('\n    '));
if (/PHP (Warning|Fatal|Notice)|Uncaught/.test(appErr)) {
  bad('服务端日志不应有 PHP 告警/致命错误');
  console.log('    ' + appErr.split('\n').filter((l) => /PHP (Warning|Fatal|Notice)|Uncaught/.test(l)).slice(0, 5).join('\n    '));
} else {
  ok('服务端日志无 PHP 告警');
}

await browser.close();
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
