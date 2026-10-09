/* 设置云同步 GUI 自检(真 Chromium + 真服务端):
 *   node tests/settings-sync-gui.mjs
 *
 * 这是本功能唯一能证明「换设备不用重新设置」的测试:在一台「设备」上改设置,
 * 再用**全新的浏览器上下文**(空 localStorage,等价于新设备/新浏览器)登录同一账号,
 * 断言主题、字号、自定义字体、群聊配置、侧栏宽度都自动恢复。
 *
 * 同时挡住两类回归:
 *   1) 云端值没被应用(拉了不用,用户仍看到默认界面);
 *   2) 应用后又被当成「本机改动」推回去,造成两端来回顶(修订号持续自增)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8171);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8172);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'sync-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似残留的 php -S),请先结束该进程或用 GUI_PORT 换端口`);
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
  for (const c of candidates) {
    try { return await import(c); } catch (e) { /* 试下一个 */ }
  }
  return null;
}
const pw = await loadPlaywright();
if (!pw) {
  console.log('(skip) 未找到 playwright,跳过设置云同步 GUI 自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-sync-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
function spawnPhp(args, env) {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
}
process.on('exit', () => { for (const p of procs) { try { p.kill(); } catch (e) {} } rmSync(TMP, { recursive: true, force: true }); });

const app = spawnPhp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_ALLOW_PRIVATE_UPSTREAM: '1',
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
  console.error('✗ 应用服务未启动\n' + appErr.slice(-1500));
  process.exit(1);
}
await waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/models`);

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json();
if (!login.token) { console.error('✗ 管理员登录失败'); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'SyncMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-sync',
    apiFormat: 'chat', scope: 'global', costPerCall: 1, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
});

const serverSettings = async () => {
  const r = await fetch(BASE + '/api/sync/settings', { headers: AUTH });
  return r.json();
};

const browser = await pw.chromium.launch();
const pageErrors = [];
function watch(page, tag) {
  page.on('pageerror', (e) => pageErrors.push(tag + ': ' + String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(tag + ' console: ' + m.text()); });
}
async function openDevice(name, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  watch(page, name);
  await page.addInitScript(([token]) => { localStorage.setItem('oc_token', token); }, [login.token]);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
  return { ctx, page };
}

console.log('== 1. 设备 A:通过界面改设置(主题 / 字号 / 字体 / 群聊 / 侧栏宽度)==');
const A = await openDevice('设备A', { width: 1280, height: 900 });
await A.page.evaluate(() => { if (window.openSettings) window.openSettings('look'); });
await A.page.waitForSelector('#pref-theme .seg-btn', { timeout: 10000 });
await A.page.click('#pref-theme .seg-btn[data-theme-val="dark"]');
await A.page.evaluate(() => {
  const s = document.getElementById('pref-fontsize');
  s.value = '18';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await A.page.evaluate(() => window.OCUI.registerCustomFont('云同步测试字体', '@font-face{font-family:"云同步测试字体";src:local("Arial")}'));
await A.page.evaluate(() => window.OCGroup.createGroup('云同步测试群'));
// 先关掉设置弹窗:它带全屏遮罩,会挡住侧栏拖拽把手
await A.page.evaluate(() => { if (window.closeSettings) window.closeSettings(); });
await sleep(500);
// 拖侧栏调宽(真实交互,验证宽度也被记住并同步)
const resizerBox = await A.page.locator('#sidebar-resizer').boundingBox();
if (resizerBox) {
  const cx = resizerBox.x + resizerBox.width / 2;
  const cy = resizerBox.y + resizerBox.height / 2;
  await A.page.mouse.move(cx, cy);
  await A.page.mouse.down();
  await A.page.mouse.move(cx + 70, cy, { steps: 10 });
  await A.page.mouse.up();
}
const localA = await A.page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  fontSize: window.OCUI.getPref('fontSize'),
  width: localStorage.getItem('oc_sidebar_width'),
  font: !!(window.OCUI.getCustomFonts() || {})['云同步测试字体'],
}));
check('设备 A 主题已切为深色', localA.theme === 'dark');
check('设备 A 字号已改为 18', localA.fontSize === 18);
check('设备 A 自定义字体已登记', localA.font);
check('设备 A 侧栏宽度已记录', Number(localA.width) > 0);

// 模型引用型偏好:值形如 "providerId\nmodelId"(换行分段)。服务端清洗曾经把它当普通短文本,
// 换行按控制字符剥掉 → "prov-syncmock-model",新设备既找不到供应商也找不到模型,该偏好静默失效。
// 这里走真实云同步链路(prefs.judgeModel + ui.imageModel)验一遍换行是否活着往返。
const MODEL_REF = 'prov-sync\nmock-model';
await A.page.evaluate((ref) => {
  window.OCUI.setPref('judgeModel', ref);
  window.OCSettingsSync.setUi('imageModel', ref);
}, MODEL_REF);
const localRef = await A.page.evaluate(() => ({
  pref: window.OCUI.getPref('judgeModel'),
  ui: localStorage.getItem('oc_image_model'),
}));
check('设备 A 模型引用本地即带换行', localRef.pref === MODEL_REF && localRef.ui === MODEL_REF);

// 等推送落地(防抖 1.2s);独自等 judgeModel 到位,避免主题那次推送先落地让断言读到旧值
let pushed = null;
for (let i = 0; i < 40; i++) {
  const s = await serverSettings();
  const sp = (s.settings && s.settings.prefs) || {};
  const su = (s.settings && s.settings.ui) || {};
  if (sp.theme === 'dark' && sp.judgeModel && su.imageModel) { pushed = s; break; }
  await sleep(300);
}
check('设置已推送到云端(主题)', !!pushed);
if (pushed) {
  check('云端记录了字号', pushed.settings.prefs.fontSize === 18);
  check('云端记录了自定义字体', !!(pushed.settings.fonts || {})['云同步测试字体']);
  check('云端记录了群聊配置', (pushed.settings.groups.groups || []).some((g) => g.name === '云同步测试群'));
  check('云端记录了侧栏宽度', Number((pushed.settings.ui || {}).sidebarWidth) > 0);
  check('云端记录了逐键时间戳', Number(pushed.settings.at['prefs.theme']) > 0);
  check('云端修订号已递增', Number(pushed.revision) > 0);
  check('云端偏好:模型引用保留换行', pushed.settings.prefs.judgeModel === MODEL_REF);
  check('云端界面:模型引用保留换行', pushed.settings.ui.imageModel === MODEL_REF);
}
const revAfterPush = Number((await serverSettings()).revision) || 0;
await sleep(2500);
check('设备 A 不会反复重推(修订号稳定)', Number((await serverSettings()).revision) === revAfterPush);

console.log('\n== 2. 设备 B(全新浏览器):登录后设置自动恢复 ==');
const B = await openDevice('设备B', { width: 1280, height: 900 });
// init 里已 await 拉取并应用,这里再等一小会儿确保应用回调跑完
await sleep(1200);
const remote = await B.page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  fontSize: window.OCUI.getPref('fontSize'),
  width: localStorage.getItem('oc_sidebar_width'),
  collapsed: localStorage.getItem('oc_sidebar_collapsed'),
  font: !!(window.OCUI.getCustomFonts() || {})['云同步测试字体'],
  group: (window.OCGroup.groups() || []).some((g) => g.name === '云同步测试群'),
  panelFontSize: (document.getElementById('pref-fontsize') || {}).value,
  modelRef: window.OCUI.getPref('judgeModel'),
  imageModelRef: localStorage.getItem('oc_image_model'),
}));
check('新设备主题自动恢复为深色', remote.theme === 'dark');
check('新设备字号自动恢复为 18', remote.fontSize === 18);
check('新设备自定义字体自动恢复', remote.font);
check('新设备群聊配置自动恢复', remote.group);
check('新设备侧栏宽度自动恢复', String(remote.width) === String(localA.width));
check('设置面板回显已同步的字号', String(remote.panelFontSize) === '18');
// 这是本用例的核心:模型引用的换行分隔符必须活着跨设备,否则新设备拿到 "prov-syncmock-model",
// 解析出的供应商/模型都失效,用户会看到「设置明明同步了却用了个不存在的模型」。
check('新设备模型引用(偏好)带换行恢复', remote.modelRef === MODEL_REF);
check('新设备模型引用(界面)带换行恢复', remote.imageModelRef === MODEL_REF);

console.log('\n== 3. 新设备不应把云端值当成自己的改动再推回去 ==');
await sleep(1500); // 首次登录后可能有一次正常推送(如上次使用的模型),先让它落地
const revOnB = Number((await serverSettings()).revision) || 0;
await sleep(3000);
const revLater = Number((await serverSettings()).revision) || 0;
check('设备 B 没有触发反复重推(修订号稳定)', revLater === revOnB);
if (revLater !== revOnB) {
  const diff = await B.page.evaluate(async () => {
    const r = await fetch('/api/sync/settings', { headers: { Authorization: 'Bearer ' + localStorage.getItem('oc_token') } });
    const data = await r.json();
    const S = window.OCSettingsSync._internal;
    const local = S.snapshot();
    const merged = S.mergeDocs(local, data.settings || {});
    const lv = S.valuesOf(local), cv = S.valuesOf(merged);
    const out = [];
    ['prefs', 'ui'].forEach((sec) => {
      const keys = new Set(Object.keys(lv[sec] || {}).concat(Object.keys(cv[sec] || {})));
      keys.forEach((k) => { if (JSON.stringify(lv[sec][k]) !== JSON.stringify(cv[sec][k])) out.push(sec + '.' + k + ': ' + JSON.stringify(lv[sec][k]) + ' → ' + JSON.stringify(cv[sec][k])); });
    });
    if (JSON.stringify(lv.groups) !== JSON.stringify(cv.groups)) out.push('groups');
    if (JSON.stringify(lv.fonts) !== JSON.stringify(cv.fonts)) out.push('fonts');
    return out;
  });
  console.log('    差异键: ' + JSON.stringify(diff));
}

console.log('\n== 4. 设置面板:同步开关与状态可见 ==');
const panel = await B.page.evaluate(() => {
  if (window.openSettings) window.openSettings('data');
  return {
    hasToggle: !!document.getElementById('pref-sync-settings'),
    checked: !!(document.getElementById('pref-sync-settings') || {}).checked,
    status: (document.getElementById('pref-sync-status') || {}).textContent || '',
  };
});
check('设置 → 数据 面板有同步开关', panel.hasToggle);
check('同步开关默认开启', panel.checked);
check('状态文案反映已同步(非空白/非报错)', /已同步|已开启|同步中/.test(panel.status) && !/失败/.test(panel.status));

console.log('\n== 5. 站点关闭设置云同步时不落库 ==');
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ syncSettings: false }) });
const before = Number((await serverSettings()).revision) || 0;
const saveRes = await fetch(BASE + '/api/sync/settings', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ baseRevision: before, settings: { prefs: { fontSize: 22 } } }),
});
const saveData = await saveRes.json().catch(() => ({}));
check('关闭后接口返回 syncSettings:false', saveData.syncSettings === false);
check('关闭后不写库(修订号不变)', Number((await serverSettings()).revision) === before);
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ syncSettings: true }) });

console.log('\n== 6. 云同步应用时,已打开的群聊设置弹窗要跟着重绘 ==');
// 「改本地配置 → 走同步应用链路(OCGroup.reload)」就是云同步落下来的那条路。
// 以前 reload 按 id 找一个并不存在的元素,永远取到 null:开着设置弹窗时同步落下来,
// 面板还停在旧配置上,用户得关掉再打开才看得到同步结果。
// 先把本机修订号追到服务端最新:下面点开关会排一次延迟推送(1200ms),修订号落后的话
// 那次推送会 409,走的是「自动合并后重推」的正常分支,却会在控制台留一行报错 ——
// 那是本条用例自己制造出来的噪音,不该让最后的「页面无 JS 报错」捡走。
await A.page.evaluate(() => window.OCSettingsSync.pull({ force: true })).catch(() => {});
// 开关是「切换」:只有当前是简单模式时点它才会开群聊并弹设置窗,所以先判一下再点。
await A.page.evaluate(() => { if (!window.OCGroup.isGroupMode()) document.querySelector('#chat-mode-row .switch').click(); });
await A.page.waitForSelector('#group-modal.show', { state: 'visible', timeout: 8000 }).catch(() => bad('群聊设置弹窗没打开'));
check('群聊设置弹窗已打开(元素本身可寻址)', await A.page.evaluate(() => {
  const m = document.getElementById('group-modal');
  return !!m && m.classList.contains('show');
}));
const OPEN_RENAMED = '同步重绘后的群名';
const titleAfter = await A.page.evaluate((newName) => {
  const c = JSON.parse(localStorage.getItem('oc_groups') || '{}');
  const g = (c.groups || []).find((x) => x.id === c.activeId) || (c.groups || [])[0];
  if (g) g.name = newName;
  localStorage.setItem('oc_groups', JSON.stringify(c));
  // 云同步应用后的那条链路
  window.OCGroup.reload();
  const t = document.getElementById('group-modal-title');
  return t ? t.textContent : '';
}, OPEN_RENAMED);
check('已打开的弹窗跟着重绘(标题显示新群名,实际「' + titleAfter + '」)', titleAfter.includes(OPEN_RENAMED));

// 点开关排下的那次推送(1200ms 延迟)要等它跑完再看报错,否则它会落在断言之后。
await sleep(2200);
check('页面无 JS 报错', pageErrors.length === 0);
if (pageErrors.length) console.log('    ' + pageErrors.slice(0, 5).join('\n    '));

await browser.close();
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
