/* 侧栏开关几何 + 生图/生视频模型下拉自检(真 Chromium + 真服务端 + mock 上游):
 *   node tests/media-toggle-gui.mjs
 *
 * 两件「读代码看不出来、只有界面错」的事:
 *
 *   1) 侧栏「简单对话/多角色」那行的小开关。style.css 为挡住 .field span{display:block}
 *      给 .switch 钉了 min-height:26px,而 groupui.css 的缩小版只覆写了 height:20px ——
 *      min-height 恒压 height,轨道被撑回 26px 高,旋钮仍是 14px,于是轨道里空一大截
 *      (用户截图里的「开关样式乱了」)。这类盒模型被祖先规则压扁的问题只能量几何。
 *
 *   2) 「≡」菜单里的生图/生视频入口:入口在「任意供应商有该类模型」时就出现,而弹窗/
 *      下拉此前只列 **当前供应商** 的模型 —— 当前供应商恰好没有视频模型时,点开下拉
 *      是空的。现在候选跨供应商汇总。接口层面一直是对的,错的是候选来源,必须真浏览器
 *      打开下拉看它列出了哪些模型、选中后落到哪个供应商。
 *
 * 用例:
 *   1) 侧栏开关:轨道高度是缩小版(20px)、旋钮在轨道内且四周留白对称;
 *   2) 生图下拉列出跨供应商的全部生图模型(当前供应商 + 别的供应商);
 *   3) 生视频下拉列出 **别的供应商** 的视频模型(当前供应商没有视频模型,这正是崩溃场景);
 *   4) 在下拉里选中模型后偏好落库,弹窗打开时默认选中同一个模型;
 *   5) 参数一致:弹窗里的模型下拉也列出跨供应商候选;
 *   6) 全程无 JS 异常。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8341);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8342);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'media-gui-pass' };

let pass = 0, fail = 0;
const check = (m, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用，请先结束该进程或用 GUI_PORT 换端口`);
  process.exit(1);
}
await assertPortFree(PORT);
await assertPortFree(MOCK_PORT);

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
if (!pw) { console.log('(skip) 未找到 playwright，跳过媒体模型下拉 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-media-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
const spawnPhp = (args, env) => {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
process.on('exit', () => {
  for (const p of procs) { try { p.kill(); } catch (e) { /* 忽略 */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});
const app = spawnPhp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password, TC_ALLOW_PRIVATE_UPSTREAM: '1',
});
let appErr = '';
app.stderr.on('data', (d) => { appErr += String(d); });
spawnPhp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status) return true; } catch (e) { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}
if (!(await waitFor(BASE + '/api/config'))) {
  console.error('✗ 应用服务未启动\n' + appErr.slice(-1200));
  process.exit(1);
}
await waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/models`);

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

// 三个供应商，故意把能力拆开：
//   A(chat) 有对话 + 生图，没有视频 —— 当前会话就用它；
//   B(video) 只有视频；
//   C(video) 也只有视频(第二个视频候选，用来验“下拉里选一个”确实换供应商)。
const mk = async (body) => (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH, body: JSON.stringify(body),
})).json();
const ra = await mk({
  name: 'AlphaIMG', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-a',
  apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true,
  models: [{ id: 'alpha-chat', name: 'AlphaChat' }, { id: 'alpha-image', name: 'AlphaImage', image: true }],
});
const rb = await mk({
  name: 'BetaVID', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-b',
  apiFormat: 'video', scope: 'global', costPerCall: 0, enabled: true,
  models: [{ id: 'beta-video', name: 'BetaVideo' }],
});
const rc = await mk({
  name: 'GammaVID', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-c',
  apiFormat: 'video', scope: 'global', costPerCall: 0, enabled: true,
  models: [{ id: 'gamma-video', name: 'GammaVideo' }],
});
const PROV_A = ra.provider && ra.provider.id;
const PROV_C = rc.provider && rc.provider.id;
if (!PROV_A || !PROV_C) { console.error('✗ 创建供应商失败: ' + JSON.stringify([ra, rb, rc]).slice(0, 400)); process.exit(1); }

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.addInitScript(([token, prov]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_provider', prov);
  localStorage.setItem('oc_model_' + prov, 'alpha-chat');
}, [login.token, PROV_A]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForFunction(() => (window.OCApp.state.providers || []).length >= 3, null, { timeout: 20000 });
await page.waitForFunction(() => (window.OCApp.state.models || []).length > 0, null, { timeout: 20000 });

console.log('== 1. 侧栏「简单对话/多角色」开关的几何 ==');
const sw = await page.evaluate(() => {
  const span = document.querySelector('#chat-mode-row .switch');
  const sl = span && span.querySelector('.slider');
  if (!sl) return null;
  const g = getComputedStyle(sl, '::before');
  const sr = sl.getBoundingClientRect();
  const kh = parseFloat(g.height), kw = parseFloat(g.width);
  const kt = parseFloat(g.top), kl = parseFloat(g.left);
  const mm = (g.transform || 'none').match(/matrix\(([^)]+)\)/);
  const tx = mm ? parseFloat(mm[1].split(',')[4]) : 0;
  return {
    track: [+sr.width.toFixed(1), +sr.height.toFixed(1)],
    knob: [kw, kh], topGap: kt, leftGap: kl, tx,
    minHeight: getComputedStyle(span).minHeight,
    bottomGap: +(sr.height - (kt + kh)).toFixed(1),
    checkedRightGap: +(sr.width - (kl + tx + kw)).toFixed(1),
  };
});
console.log('   开关度量: ' + JSON.stringify(sw));
check('量到了侧栏开关', !!sw);
check('轨道用缩小版高度 20px(实际 ' + (sw && sw.track && sw.track[1]) + 'px)',
  !!sw && sw.track[1] >= 19 && sw.track[1] <= 21,
  'min-height 没跟着覆写时会被撑回 26px —— 这正是用户看到的「样式乱了」');
check('min-height 也被缩到 20px(实际 ' + (sw && sw.minHeight) + ')', !!sw && sw.minHeight === '20px',
  'style.css 的 min-height:26px 压过 height:20px，尺寸必须成对覆写');
check('旋钮在轨道内、下沿留白对称(下 ' + (sw && sw.bottomGap) + 'px)',
  !!sw && sw.bottomGap >= 1 && sw.topGap >= 1 && sw.bottomGap === sw.topGap);
check('勾选后旋钮仍不溢出轨道(右侧留白 ' + (sw && sw.checkedRightGap) + 'px)',
  !!sw && sw.checkedRightGap >= 1);

console.log('== 2. 「≡」菜单:生图/生视频下拉跨供应商汇总 ==');
// 「≡」面板点选菜单项(菜单挂在 body 上)后会被外部点击逻辑收起,所以每次用前都先确保它是开的。
async function ensureTools() {
  if (!(await page.locator('#composer-tools').isVisible().catch(() => false))) {
    await page.locator('#composer-more').click();
  }
  await page.waitForSelector('#composer-tools:not(.hidden)', { timeout: 8000 });
}
await ensureTools();
check('生图入口可见(某供应商有生图模型)', await page.locator('#composer-tool-image').isVisible());

const imgLabel = (await page.locator('#composer-image-model .sb-label').innerText()).trim();
const vidLabel = (await page.locator('#composer-video-model .sb-label').innerText()).trim();
check('生图下拉自动显示可用生图模型(实际「' + imgLabel + '」)', imgLabel.includes('AlphaImage'), imgLabel);
check('生视频下拉自动显示 **别的供应商** 的视频模型(实际「' + vidLabel + '」)',
  vidLabel.includes('BetaVideo'), '当前供应商没有视频模型，只看当前供应商时这里会是空的');

// 打开生视频下拉，看候选是否跨供应商。条目显示名是「渠道@模型名」。
await page.locator('#composer-video-model').click();
await page.waitForSelector('.oc-menu', { timeout: 8000 });
const vidItems = await page.locator('.oc-menu .oc-menu-item .item-label').allInnerTexts();
console.log('   生视频候选: ' + JSON.stringify(vidItems.map((s) => s.trim())));
check('生视频候选含 BetaVID 的模型', vidItems.some((t) => t.includes('BetaVideo')));
check('生视频候选含 GammaVID 的模型(跨供应商)', vidItems.some((t) => t.includes('GammaVideo')));
check('生视频候选不含对话/生图模型',
  !vidItems.some((t) => t.includes('AlphaChat') || t.includes('AlphaImage')));

// 在下拉里选 GammaVID 的模型
await page.locator('.oc-menu .oc-menu-item', { hasText: 'GammaVideo' }).first().click();
await sleep(300);
const afterPick = await page.evaluate(() => ({
  label: (document.querySelector('#composer-video-model .sb-label') || {}).textContent || '',
  value: document.querySelector('#composer-video-model').getAttribute('data-value') || '',
  pref: (function () { try { return JSON.parse(localStorage.getItem('oc_prefs') || '{}').videoModel || ''; } catch (e) { return ''; } })(),
}));
check('选中后下拉标签更新为所选模型', afterPick.label.includes('GammaVideo'), afterPick.label);
check('选中值带上正确的供应商前缀(实际 ' + JSON.stringify(afterPick.value) + ')',
  afterPick.value.split('\n')[0] === PROV_C && afterPick.value.split('\n')[1] === 'gamma-video');
check('偏好已落库(videoModel)', afterPick.pref.split('\n')[0] === PROV_C, afterPick.pref);

// 生图下拉也应为跨供应商候选
await page.locator('#composer-image-model').click();
await page.waitForSelector('.oc-menu', { timeout: 8000 });
const imgItems = await page.locator('.oc-menu .oc-menu-item .item-label').allInnerTexts();
check('生图候选含 alpha-image', imgItems.some((t) => t.includes('AlphaImage')));
check('生图候选不含视频模型', !imgItems.some((t) => t.includes('BetaVideo') || t.includes('GammaVideo')));
await page.keyboard.press('Escape');
await sleep(200);

console.log('\n== 3. 生视频弹窗默认选中同一个模型(与下拉同一份偏好) ==');
await ensureTools();
await page.locator('#composer-tool-video-go').click();
await page.waitForSelector('.vid-modal', { timeout: 8000 });
const dlgLabel = (await page.locator('.vid-modal #vid-model-box .sb-label').innerText()).trim();
check('弹窗视频模型默认显示下拉里选的 GammaVID 模型(实际「' + dlgLabel + '」)',
  dlgLabel.includes('GammaVideo'), dlgLabel);
await page.locator('.vid-modal #vid-model-box').click();
await page.waitForSelector('.oc-menu', { timeout: 8000 });
const dlgItems = await page.locator('.oc-menu .oc-menu-item .item-label').allInnerTexts();
check('弹窗里的候选同样是跨供应商的', dlgItems.some((t) => t.includes('BetaVideo')) && dlgItems.some((t) => t.includes('GammaVideo')));
await page.keyboard.press('Escape');
await sleep(150);
await page.locator('.vid-modal [data-act="close"]').click();
await sleep(200);

console.log('\n== 4. 生图弹窗:候选跨供应商 ==');
await ensureTools();
await page.locator('#composer-tool-image-go').click();
await page.waitForSelector('.img-modal', { timeout: 8000 });
await page.locator('.img-modal #img-model-box').click();
await page.waitForSelector('.oc-menu', { timeout: 8000 });
const imgDlgItems = await page.locator('.oc-menu .oc-menu-item .item-label').allInnerTexts();
check('生图弹窗候选含当前供应商的生图模型', imgDlgItems.some((t) => t.includes('AlphaImage')));
await page.keyboard.press('Escape');
await sleep(150);
await page.locator('.img-modal [data-act="close"]').click();
await sleep(200);

check('全程无页面级报错', pageErrors.length === 0);
if (pageErrors.length) console.log('    报错: ' + pageErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
