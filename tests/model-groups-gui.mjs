/* 模型汇总 GUI 自检(真 Chromium + 真服务端 + mock 上游):
 *   node tests/model-groups-gui.mjs
 *
 * 背景:多个渠道汇总为一个模型,所有汇总模型共用模型选择器的「自动切换」供应商标签。
 * 真浏览器验证后台开关与卡片、Auto@展示名、平台 logo、筛选与真实 agg:<id> 路由,
 * 并保证未汇总的平台渠道和前台自建渠道仍保留「渠道@模型」展示。
 *
 * 用例:
 *   1) 后台「模型汇总」面板:默认关闭、空列表提示、同名可汇总提示;
 *   2) 界面上打开总开关 → 自动生成同名汇总卡片(标签/候选数/成员渠道);
 *   3) 前台同名模型收敛为一条「Auto@agg-model」,当前模型名与列表一致;
 *   4) 弹窗手动新增汇总(填 ID / 显示名 / 选轮询 / 勾成员)→ 卡片出现;
 *   5) 前台只显示自定义 ID(显示名出现在列表里,被收纳的成员模型消失);
 *   6) 停用 / 启用 的按钮接线与卡片状态;
 *   7) 关掉总开关后前台恢复成「渠道@模型」两条;
 *   8) 删除汇总后成员恢复;
 *   9) 多个汇总只有一个自动切换标签且排第一、平台 logo 等大、搜索叠加筛选、选择路由正确;
 *  10) 全程无 JS 异常。
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
if (!pw) { console.error('✗ 未找到 playwright,无法执行模型汇总 GUI 自检'); process.exit(1); }

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
if (!(await waitFor(`http://127.0.0.1:${MOCK_A_PORT}/models`))
    || !(await waitFor(`http://127.0.0.1:${MOCK_B_PORT}/models`))) {
  console.error('✗ mock 上游服务未启动');
  process.exit(1);
}

async function requestJSON(path, options) {
  const response = await fetch(BASE + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const login = await requestJSON('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
});
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

// 两个渠道提供同名模型(同名自动汇总的触发条件)+ 一个只属于 B 的独有模型(验证自定义汇总)
async function newProv(name, port, modelId, scope = 'global', extraModels = []) {
  const r = await requestJSON('/api/providers', {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({
      name, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-agg', apiFormat: 'chat',
      scope, costPerCall: 1, enabled: true, models: [{ id: modelId, name: modelId }, ...extraModels],
    }),
  });
  if (!r.provider || !r.provider.id) throw new Error('创建渠道缺少 ID: ' + JSON.stringify(r));
  return r.provider.id;
}
const PROV_A = await newProv('渠道A', MOCK_A_PORT, 'agg-model');
const PROV_B = await newProv('渠道B', MOCK_B_PORT, 'agg-model');
const PROV_ONLY = await newProv('渠道B-独占', MOCK_B_PORT, 'vendor-only');
if (!PROV_A || !PROV_B || !PROV_ONLY) { console.error('✗ 创建渠道失败'); process.exit(1); }

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const pageErrors = [];
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
  await p.waitForFunction((t) => {
    const host = document.getElementById('oc-toast-host');
    return !!host && host.textContent.indexOf(t) >= 0;
  }, text, { timeout });
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
check('当前模型名是 Auto@汇总展示名', (await front.locator('#model-name').innerText()).trim() === 'Auto@agg-model');
let labels = await pickerLabels(front);
// 两个渠道提供同一个模型名,汇总后必须只剩一条;未进任何汇总的模型(vendor-only)照旧可见
check('同名两条渠道收敛成一条(实际 ' + JSON.stringify(labels) + ')', labels.filter((x) => x.includes('agg-model')).length === 1);
check('那一条是 Auto@模型名', labels.includes('Auto@agg-model'));
check('没有「渠道@agg-model」这种重复项', !labels.some((x) => /^渠道.*@agg-model$/.test(x)));
check('未汇总的模型保持可见(默认不隐藏)', labels.some((x) => x.includes('vendor-only')));

// ---------- 4. 弹窗手动新增汇总 ----------
console.log('== 4. 手动新增汇总(弹窗) ==');
await admin.click('#ma-new');
await admin.waitForSelector('#ma-edit-id', { timeout: 8000 });
// 成员选择器的排版契约:这些 ma-* 类曾经一条 CSS 都没有(JS 生成、样式表里不存在),
// 面板就按浏览器默认渲染 —— 勾选框贴着文字、渠道分组没有层级、行高忽高忽低。
// 这里量真浏览器里的几何:勾选框与文字必须垂直居中对齐、行高一致、分组标题是吸顶的。
const geom = await admin.evaluate(() => {
  const pick = document.querySelector('#ma-edit-pick');
  if (!pick) return null;
  const rows = Array.from(pick.querySelectorAll('.ma-pick-row > label'));
  const first = rows[0];
  const box = first && first.querySelector('input[type="checkbox"]');
  const span = first && first.querySelector('span');
  const rects = rows.map((r) => +r.getBoundingClientRect().height.toFixed(1));
  const prov = pick.querySelector('.ma-pick-prov');
  // 只看本次打开的「新增汇总」弹窗,别抓到页面上其它弹窗(例如存储管理里的删除留档)的开关
  const mask = Array.from(document.querySelectorAll('.modal-mask')).find((m) => m.querySelector('#ma-edit-id'));
  const swSpan = mask && mask.querySelector('span.switch');
  const sl = swSpan && swSpan.querySelector('.slider');
  let switchBox = null;
  if (sl) {
    const g = getComputedStyle(sl, '::before');
    const sr = sl.getBoundingClientRect();
    const kw = parseFloat(g.width), kh = parseFloat(g.height);
    const kl = parseFloat(g.left), kt = parseFloat(g.top);
    const mm = (g.transform || 'none').match(/matrix\(([^)]+)\)/);
    const tx = mm ? parseFloat(mm[1].split(',')[4]) : 0;
    switchBox = {
      track: [+sr.width.toFixed(1), +sr.height.toFixed(1)],
      knob: [kw, kh], tx,
      leftVal: kl, topVal: kt,
      rightGap: +(sr.width - (kl + tx + kw)).toFixed(1),
      bottomGap: +(sr.height - (kt + kh)).toFixed(1),
      parentClass: swSpan.parentElement.className,
      sliderParentClass: sl.parentElement.className,
      computedFont: getComputedStyle(swSpan.parentElement).fontSize,
      emBased: getComputedStyle(document.documentElement).fontSize,
    };
  }
  return {
    rowCount: rows.length,
    rowHeightsUniform: rects.length > 1 && rects.every((h) => Math.abs(h - rects[0]) < 1.5),
    rowHeight: rects[0] || null,
    boxCount: pick.querySelectorAll('.ma-pick-row input[type="checkbox"]').length,
    boxSize: box ? [+box.getBoundingClientRect().width.toFixed(1), +box.getBoundingClientRect().height.toFixed(1)] : null,
    // 勾选框中心与同行文字中心的偏差:超过 2px 就是肉眼可见的「没对齐」
    boxVsTextOffset: (box && span)
      ? +Math.abs((box.getBoundingClientRect().top + box.getBoundingClientRect().height / 2)
        - (span.getBoundingClientRect().top + span.getBoundingClientRect().height / 2)).toFixed(1)
      : null,
    provPosition: prov ? getComputedStyle(prov).position : null,
    provHasBg: prov ? getComputedStyle(prov).backgroundColor !== 'rgba(0, 0, 0, 0)' : false,
    listMaxHeight: getComputedStyle(pick).maxHeight,
    switchBox,
  };
});
check('成员列表按渠道分组并渲染出可勾选行', geom && geom.rowCount > 0 && geom.boxCount > 0);
check('勾选框有明确尺寸(不是浏览器默认的小方块)', geom && geom.boxSize && geom.boxSize[0] >= 14 && geom.boxSize[1] >= 14,
  geom && geom.boxSize ? JSON.stringify(geom.boxSize) : '未量到');
check('勾选框与同行的模型名垂直居中对齐(偏差 ' + (geom && geom.boxVsTextOffset) + 'px ≤ 2px)',
  geom && geom.boxVsTextOffset !== null && geom.boxVsTextOffset <= 2,
  '没有对齐样式时 JS 生成的 class 会全部落到浏览器默认排版');
check('每一行的行高一致(实际 ' + (geom && geom.rowHeight) + 'px)',
  geom && geom.rowHeightsUniform, '行高忽高忽低是这套面板「看起来乱」的主因之一');
check('成员列表限高可滚动(不再随渠道数无限拉长弹窗)',
  geom && geom.listMaxHeight !== 'none' && /px$/.test(geom.listMaxHeight), geom && geom.listMaxHeight);
check('渠道分组标题吸顶且有底色', geom && geom.provPosition === 'sticky' && geom.provHasBg,
  geom ? geom.provPosition + '/' + geom.provHasBg : '未量到');
// 开关:旋钮必须落在轨道内、四周留白对称。曾经有一版把旋钮写成百分比宽 + aspect-ratio,
// 结果在别的样式表覆盖 transform 时垂直居中失效,旋钮溢出轨道下沿。
console.log('   开关原始度量: ' + JSON.stringify(geom && geom.switchBox));
check('弹窗里的开关旋钮在轨道内且留白对称(右 ' + (geom && geom.switchBox && geom.switchBox.rightGap)
  + 'px / 下 ' + (geom && geom.switchBox && geom.switchBox.bottomGap) + 'px)',
  !!(geom && geom.switchBox && geom.switchBox.rightGap >= 1 && geom.switchBox.bottomGap >= 1),
  '旋钮溢出轨道就是用户看到的「白点没对齐」');
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
check('自定义汇总以 Auto@显示名出现在列表里', labels.includes('Auto@我的模型'));
check('被收纳的成员模型不再单独出现', !labels.some((x) => x.includes('vendor-only')));
check('汇总行统一显示 Auto@而不是渠道前缀', labels.length === 2 && labels.every((x) => x.startsWith('Auto@')));

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
check('删除后自定义显示名不再出现', !labels.includes('Auto@我的模型'));

// ---------- 9. 模型选择器:全部之后只有一个共享的自动切换供应商标签 ----------
console.log('== 9. 自动切换供应商标签(共享 + 平台 logo + 筛选 + 路由) ==');
// 前八节的基线不变;此时才补第二个汇总,并跨对话/生图分类验证共享筛选。
const secondGroup = await requestJSON('/api/admin/model-groups', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ id: 'second-model', label: '第二模型', strategy: 'failover', enabled: true,
    image: true, members: [{ providerId: PROV_ONLY, model: 'vendor-only' }] }),
});
check('第二个汇总创建成功且显示名与路由 ID 不同', secondGroup.group.id === 'second-model' && secondGroup.group.label === '第二模型');
const PROV_NORMAL = await newProv('平台 OpenAI', MOCK_A_PORT, 'gpt-normal');
const USER_NAME = '前台自建 OpenAI';
const USER_PROV = await newProv(USER_NAME, MOCK_A_PORT, 'agg-model', 'user',
  Array.from({ length: 6 }, (_, i) => ({ id: 'gpt-extra-' + i, name: 'gpt-extra-' + i })));
await reloadFront(front);
const pickerProviders = await front.evaluate(() => window.OCApp.state.providers.map((p) => ({ id: p.id, agg: !!p.agg, scope: p.scope })));
check('存在两个独立 agg:<id> 路由', pickerProviders.filter((p) => p.agg).length === 2
  && pickerProviders.some((p) => p.id === 'agg:agg-model') && pickerProviders.some((p) => p.id === 'agg:second-model'));
check('前台自建渠道仍是普通个人供应商', pickerProviders.some((p) => p.id === USER_PROV && p.scope === 'user' && !p.agg));
await front.click('#model-picker');
await front.waitForSelector('.oc-model-menu .oc-menu-chip', { timeout: 8000 });
const menu = front.locator('.oc-model-menu');
const chips = menu.locator('.oc-menu-chip');
const chipLabels = await chips.allInnerTexts();
check('全部之后第一项是自动切换且只有一个(实际 ' + JSON.stringify(chipLabels) + ')',
  chipLabels[0] === '全部' && chipLabels[1] === '自动切换' && chipLabels.filter((x) => x === '自动切换').length === 1);
check('汇总 ID/显示名没有各自占一个供应商标签', chipLabels.length === 4
  && chipLabels.includes('平台 OpenAI') && chipLabels.includes(USER_NAME)
  && !chipLabels.some((x) => /agg:|agg-model|第二模型|second-model/.test(x)));
const chipLogos = await menu.evaluate((el) => {
  const auto = Array.from(el.querySelectorAll('.oc-menu-chip')).find((b) => b.textContent.trim() === '自动切换');
  const normal = Array.from(el.querySelectorAll('.oc-menu-chip')).find((b) => b.textContent.trim() === '平台 OpenAI');
  const visible = (node) => node && Array.from(node.querySelectorAll('img')).filter((img) => getComputedStyle(img).display !== 'none');
  const a = visible(auto) || [], b = visible(normal) || [];
  const size = (img) => img ? [img.getBoundingClientRect().width, img.getBoundingClientRect().height] : [];
  return { autoSources: auto ? Array.from(auto.querySelectorAll('img')).map((img) => img.getAttribute('src')) : [],
    autoVisible: a.length, normalVisible: b.length, autoSize: size(a[0]), normalSize: size(b[0]),
    autoClass: a[0] ? a[0].className : '' };
});
check('自动切换使用平台深浅 logo 而非模型品牌图标', chipLogos.autoSources.length === 2
  && chipLogos.autoSources.includes('./logo.svg') && chipLogos.autoSources.includes('./logo-dark.svg')
  && chipLogos.autoVisible === 1 && chipLogos.autoClass.includes('chip-logo'));
check('平台 logo 和普通供应商标签 logo 尺寸一致(实际 ' + JSON.stringify(chipLogos) + ')',
  chipLogos.normalVisible === 1 && chipLogos.autoSize[0] > 0 && chipLogos.autoSize[1] > 0
  && chipLogos.autoSize.every((v, i) => Math.abs(v - chipLogos.normalSize[i]) < 0.5));
const rowLabels = () => menu.locator('.oc-menu-item .item-label').allInnerTexts();
const allLabels = await rowLabels();
check('超过 8 个模型时出现搜索框', allLabels.length === 10 && await menu.locator('.oc-menu-search').isVisible());
check('汇总行使用 Auto@显示名,普通渠道行保持渠道@模型', allLabels.includes('Auto@agg-model')
  && allLabels.includes('Auto@第二模型') && allLabels.includes('平台 OpenAI@gpt-normal') && allLabels.includes(USER_NAME + '@agg-model'));
await chips.filter({ hasText: /^自动切换$/ }).click();
let autoLabels = await rowLabels();
check('自动切换筛选包含全部汇总且排除普通/前台自建渠道(实际 ' + JSON.stringify(autoLabels) + ')',
  autoLabels.length === 2 && autoLabels.includes('Auto@agg-model') && autoLabels.includes('Auto@第二模型'));
if (process.env.GUI_SCREENSHOTS === '1') {
  const shotDir = join(ROOT, '.tmp', 'model-picker-gui');
  mkdirSync(shotDir, { recursive: true });
  await front.screenshot({ path: join(shotDir, 'automatic-switch.png') });
}
const autoCategories = await menu.locator('.oc-menu-title').allInnerTexts();
check('共享标签跨模型分类保留所有汇总', autoCategories.includes('对话模型') && autoCategories.includes('生图模型'));
await menu.locator('.oc-menu-search').fill('第二');
check('搜索显示名与自动切换标签叠加', JSON.stringify(await rowLabels()) === JSON.stringify(['Auto@第二模型']));
await menu.locator('.oc-menu-search').fill('agg-model');
check('自动切换搜索不混入同名个人模型', JSON.stringify(await rowLabels()) === JSON.stringify(['Auto@agg-model']));
await chips.filter({ hasText: new RegExp('^' + USER_NAME + '$') }).click();
check('切到个人供应商时仍保留搜索且只显示个人模型', JSON.stringify(await rowLabels()) === JSON.stringify([USER_NAME + '@agg-model']));
await chips.filter({ hasText: /^全部$/ }).click();
const searchedAll = await rowLabels();
check('全部标签清除供应商筛选但保留搜索', searchedAll.length === 2
  && searchedAll.includes('Auto@agg-model') && searchedAll.includes(USER_NAME + '@agg-model'));
await menu.locator('.oc-menu-search').fill('');
check('清空搜索后全部模型恢复', (await rowLabels()).length === allLabels.length);
await chips.filter({ hasText: /^平台 OpenAI$/ }).click();
check('普通平台供应商筛选仍按真实 ID 工作', JSON.stringify(await rowLabels()) === JSON.stringify(['平台 OpenAI@gpt-normal']));
const normalValue = await menu.locator('.oc-menu-item').getAttribute('data-value');
check('普通平台供应商行保留真实路由', normalValue === PROV_NORMAL + '\n' + 'gpt-normal');
await front.keyboard.press('Escape');

// 选择各汇总行:核对菜单 value、真正的 models 请求、状态与选中后的展示名。
for (const target of [
  { providerId: 'agg:agg-model', modelId: 'agg-model', label: 'Auto@agg-model' },
  { providerId: 'agg:second-model', modelId: 'second-model', label: 'Auto@第二模型' },
]) {
  await front.click('#model-picker');
  await front.locator('.oc-model-menu .oc-menu-chip', { hasText: /^自动切换$/ }).click();
  const row = front.locator('.oc-model-menu .oc-menu-item').filter({ has: front.locator('.item-label', { hasText: new RegExp('^' + target.label + '$') }) });
  check(target.label + ' 的行值保留独立 agg 路由', await row.getAttribute('data-value') === target.providerId + '\n' + target.modelId);
  const responsePromise = front.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/proxy/models' && url.searchParams.get('provider') === target.providerId;
  }, { timeout: 10000 });
  await row.click();
  const response = await responsePromise;
  const data = await response.json();
  check(target.label + ' 实际请求正确 agg:<id> 并返回对应模型', response.ok()
    && Array.isArray(data.models) && data.models.some((m) => m.id === target.modelId));
  await front.waitForFunction((expected) => window.OCApp.state.currentProviderId === expected.providerId
    && window.OCApp.state.currentModel === expected.modelId
    && document.getElementById('model-name').textContent.trim() === expected.label, target, { timeout: 10000 });
  check(target.label + ' 选中后展示名与列表一致', (await front.locator('#model-name').innerText()).trim() === target.label);
}

// ---------- 10. 无 JS 异常 ----------
console.log("== 10. 运行期异常 ==");
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
