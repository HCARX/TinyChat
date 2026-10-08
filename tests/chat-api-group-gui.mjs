/* 侧边栏「API 对话」分组 GUI 自检(真 Chromium + 真服务端 + mock 上游):
 *   node tests/chat-api-group-gui.mjs
 *
 * 背景:开放接口调用(/v1)会在服务端顺手记一份会话,默认落进「今天」「昨天」这些时间块里,
 * 和用户手动聊的会话混在一起。一个渠道一天可能攒几十条接口调用,手动对话直接被挤到看不见。
 * 要求是「API 的消息单独一个折叠,今天 API / 昨天 API,不和今天混在一起,今天 API 放在今天后面」。
 * 这是纯渲染结果:接口字段全对,顺序或归属照样可能画错,只有真浏览器量 DOM 才看得出来。
 *
 * 用例:
 *   1) 造数据:两个手动对话(今天/昨天)+ 一次真实 /v1/chat/completions 生成的接口会话;
 *   2) 分组顺序 = 今天 → 今天 API → 昨天 → 昨天 API(用户原话里的「今天 API 放在今天后面」);
 *   3) 归属:接口会话不在「今天」里,手动对话不在「今天 API」里;数量徽标与条目数一致;
 *   4) 两个分组各自折叠(收起「今天 API」不影响「今天」),状态分别记忆在 localStorage;
 *   5) 同步往返(客户端把列表推回云端)之后标记仍在 —— 锁住 tc_sanitize_chats 漏字段那个
 *      「本机永远复现、换设备才炸」的缺陷(它会让所有 API 会话集体退化成普通对话);
 *   6) 全程无 JS 异常、服务端无 PHP 告警。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8331);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8332);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'apigroup-pass' };
// 接口调用的首条用户消息:会话标题就是它(服务端取前 24 字加「API · 」前缀)
const API_PROMPT = '接口调用一';
const API_TITLE = 'API · ' + API_PROMPT;

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
if (!pw) { console.log('(skip) 未找到 playwright,跳过 API 分组 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-apigroup-' + Date.now());
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
spawnPhp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-agg-upstream.php'], { TC_MOCK_TAG: 'A' });

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
if (!(await waitFor(`http://127.0.0.1:${MOCK_PORT}/models`))) {
  console.error('✗ mock 上游未启动');
  process.exit(1);
}

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

// 一个渠道,提供一个模型供接口调用
const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: '接口渠道', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-apigroup', apiFormat: 'chat',
    scope: 'global', costPerCall: 1, enabled: true, models: [{ id: 'api-group-model', name: 'api-group-model' }],
  }),
})).json();
if (!provRes.provider || !provRes.provider.id) { console.error('✗ 创建渠道失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }

const keyRes = await (await fetch(BASE + '/api/me/apikeys', {
  method: 'POST', headers: AUTH, body: JSON.stringify({ name: '分组自检' }),
})).json();
if (!keyRes.secret) { console.error('✗ 创建 API 密钥失败: ' + JSON.stringify(keyRes).slice(0, 300)); process.exit(1); }

// 会话读写都走同步接口 —— 这正是客户端的路径,顺带能验证服务端到底存了什么
async function getChats() {
  const r = await fetch(BASE + '/api/sync/chats', { headers: AUTH });
  const j = await r.json().catch(() => ({}));
  return j;
}
async function pushChats(chats, baseRevision) {
  const r = await fetch(BASE + '/api/sync/chats', {
    method: 'POST', headers: AUTH, body: JSON.stringify({ baseRevision, chats }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// 昨天中午:用本地时间算,避免「现在减 24 小时」在凌晨会掉进前天
const yStart = new Date();
yStart.setDate(yStart.getDate() - 1);
yStart.setHours(12, 0, 0, 0);
const now = Date.now();
const mkChat = (id, title, ts) => ({
  id, title, createdAt: ts, updatedAt: ts, pinned: false,
  messages: [{ role: 'user', content: title, createdAt: ts }, { role: 'assistant', content: '好的', createdAt: ts }],
});

console.log('== 1. 造数据(两个手动对话 + 一次真实接口调用) ==');
const rev0 = await getChats();
const push = await pushChats([
  mkChat('c-ui-today', '手动对话(今天)', now),
  mkChat('c-ui-yest', '手动对话(昨天)', yStart.getTime()),
], Number(rev0.revision) || 0);
check('手动对话推送成功', push.status === 200);
const stored1 = await getChats();
check('服务端存下两条手动对话', (stored1.chats || []).filter((c) => c.id.startsWith('c-ui-')).length === 2);

const apiRes = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + keyRes.secret },
  body: JSON.stringify({ model: 'api-group-model', messages: [{ role: 'user', content: API_PROMPT }] }),
});
const apiBody = await apiRes.json().catch(() => ({}));
check('接口调用返回 200', apiRes.status === 200);
check('应答来自 mock 渠道(' + JSON.stringify((apiBody.choices || [{}])[0].message || {}).slice(0, 60) + ')',
  !!apiBody.choices && apiBody.choices[0].message.content === 'AGG-A');
const stored2 = await getChats();
const apiChat = (stored2.chats || []).find((c) => (c.title || '').startsWith('API · '));
check('服务端顺手记下了这次接口调用(' + (apiChat ? apiChat.title : '无') + ')', !!apiChat);
check('这条会话带着 apiKey 标记', !!(apiChat && apiChat.apiKey));

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const pageErrors = [];
async function openFront(opts = {}) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
  p.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  await p.addInitScript((t) => { localStorage.setItem('oc_token', t); }, login.token);
  if (opts.prefs) await p.addInitScript((prefs) => { localStorage.setItem('oc_prefs', JSON.stringify(prefs)); }, opts.prefs);
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#chat-list .chat-group-section', { timeout: 30000 });
  // 等列表真的画出来再量:关掉「显示 API 对话」的用例里那条接口会话本就不该出现,
  // 所以等谁出现由调用方决定(默认等接口会话)。
  await p.waitForFunction((t) => !!document.body.innerText.includes(t), opts.expect || API_PROMPT, { timeout: 30000 });
  return p;
}
// 读回侧边栏真实结构:分组顺序、每组的条目标题、折叠状态、标题上的分类标记
const readGroups = (p) => p.evaluate(() => [...document.querySelectorAll('#chat-list .chat-group-section')].map((s) => {
  const head = s.querySelector('.chat-group');
  const txt = (el) => (el && el.textContent ? el.textContent.trim() : '');
  return {
    label: txt(s.querySelector('.chat-group-label')),
    count: Number(txt(s.querySelector('.chat-group-count')) || 0),
    collapsed: s.classList.contains('collapsed'),
    isApi: !!head && head.classList.contains('is-api'),
    isToday: !!head && head.classList.contains('is-today'),
    tip: head ? head.getAttribute('data-tip') : '',
    titles: [...s.querySelectorAll('.chat-title')].map((x) => x.textContent.trim()),
    visible: [...s.querySelectorAll('.chat-item-wrap')].every((x) => x.offsetParent !== null),
  };
}));
const col = (groups, label) => {
  const i = groups.findIndex((g) => g.label === label);
  return i < 0 ? { label, count: 0, collapsed: false, isApi: false, isToday: false, tip: '', titles: [], visible: false, _idx: -1 } : groups[i];
};
const sectionEl = (p, label) => p.locator('#chat-list .chat-group-section', { has: p.locator('.chat-group-label', { hasText: label }) });
// 「今天」的 label 是「今天 API」的子串,hasText 会同时命中两个,所以按精确标签取索引
async function waitGroup(p, label, timeout = 30000) {
  try {
    await p.waitForFunction((t) => [...document.querySelectorAll('#chat-list .chat-group-label')]
      .some((e) => e.textContent.trim() === t), label, { timeout });
    return true;
  } catch (e) { return false; }
}
async function clickGroup(p, label) {
  const groups = await readGroups(p);
  const i = groups.findIndex((g) => g.label === label);
  if (i < 0) { bad('找不到分组「' + label + '」,无法点击'); return false; }
  await p.locator('#chat-list .chat-group-section').nth(i).locator('.chat-group').click();
  await p.waitForTimeout(200);
  return true;
}

console.log('== 2. 分组顺序(今天 API 紧跟在今天后面) ==');
const page = await openFront();
let groups = await readGroups(page);
console.log('    实际分组: ' + groups.map((g) => g.label + '(' + g.count + ')').join(' / '));
const labels = groups.map((g) => g.label);
check('有「今天 API」分组', labels.includes('今天 API'));
check('有「昨天」分组', labels.includes('昨天'));
check('顺序是 今天 → 今天 API → 昨天', (() => {
  const iT = labels.indexOf('今天'), iA = labels.indexOf('今天 API'), iYb = labels.indexOf('昨天');
  return iT >= 0 && iA === iT + 1 && iYb > iA;
})());
check('「今天 API」是「今天」后面紧挨着的那一个', labels[labels.indexOf('今天') + 1] === '今天 API');
check('「今天 API」带 is-api 标记(视觉区分)', col(groups, '今天 API').isApi);
check('「今天」不带 is-api 标记', !col(groups, '今天').isApi);
check('「今天 API」沿用「今天」的强调样式(两者相邻不突兀)', col(groups, '今天 API').isToday);
check('提示语读作「收起今天 API 对话」', col(groups, '今天 API').tip === '收起今天 API 对话');

console.log('== 3. 归属:接口调用不和手动对话混在一起 ==');
const today = col(groups, '今天'), apiToday = col(groups, '今天 API'), yest = col(groups, '昨天');
check('「今天」里有手动对话', today.titles.includes('手动对话(今天)'));
check('「今天」里没有 API 会话', !today.titles.some((t) => t.startsWith('API · ')));
check('「今天 API」里只有那条接口会话', apiToday.titles.length === 1 && apiToday.titles[0] === API_TITLE);
check('手动对话没被算进「今天 API」', !apiToday.titles.includes('手动对话(今天)'));
check('「昨天」里有昨天的对话', yest.titles.includes('手动对话(昨天)'));
check('「昨天」里没有 API 会话', !yest.titles.some((t) => t.startsWith('API · ')));
check('「今天」徽标数 = 实际条目数(' + today.count + '/' + today.titles.length + ')', today.count === today.titles.length);
check('「今天 API」徽标数 = 实际条目数(' + apiToday.count + '/' + apiToday.titles.length + ')', apiToday.count === apiToday.titles.length);

console.log('== 4. 折叠各自独立 ==');
check('默认:今天展开(条目可见)', !today.collapsed && today.visible);
check('默认:今天 API 按今天的默认展开', !apiToday.collapsed && apiToday.visible);
check('收起「今天 API」', await clickGroup(page, '今天 API'));
groups = await readGroups(page);
check('「今天 API」已收起', col(groups, '今天 API').collapsed);
check('收起「今天 API」不影响「今天」', !col(groups, '今天').collapsed && col(groups, '今天').visible);
check('提示语翻成「展开今天 API 对话」', col(groups, '今天 API').tip === '展开今天 API 对话');
const savedCollapse = await page.evaluate(() => JSON.parse(localStorage.getItem('oc_chat_group_collapsed') || '{}'));
check('折叠状态按分组名分别记忆', savedCollapse['今天 API'] === true && savedCollapse['今天'] === undefined);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#chat-list .chat-group-section', { timeout: 30000 });
groups = await readGroups(page);
check('刷新后「今天 API」仍是收起的(记忆生效)', col(groups, '今天 API').collapsed);
check('刷新后「今天」仍是展开的', !col(groups, '今天').collapsed);

console.log('== 5. 同步往返后标记不丢(换设备才暴露的那类缺陷) ==');
// 客户端每次改动都会把整份列表推回云端。标记一旦过不了 tc_sanitize_chats 的白名单,
// 本机看不出任何异常(本地副本自己还带着),换设备拉取后这些会话会集体变成普通对话。
const before = await getChats();
const roundTrip = await pushChats(before.chats || [], Number(before.revision) || 0);
check('把云端列表原样推回成功', roundTrip.status === 200);
const after = await getChats();
const apiAfter = (after.chats || []).find((c) => c.id === (apiChat && apiChat.id));
check('推回后那条会话还在', !!apiAfter);
check('推回后 apiKey 标记仍在', !!(apiAfter && apiAfter.apiKey));
check('标记内容未被改写', !!apiAfter && apiAfter.apiKey === apiChat.apiKey);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#chat-list .chat-group-section', { timeout: 30000 });
await page.waitForFunction((t) => !!document.body.innerText.includes(t), API_PROMPT, { timeout: 30000 });
groups = await readGroups(page);
check('同步往返后 API 会话仍在「今天 API」里(没有退回「今天」)',
  col(groups, '今天 API').titles.includes(API_TITLE) && !col(groups, '今天').titles.some((t) => t.startsWith('API · ')));
check('同步往返后分组顺序不变', (() => {
  const l = groups.map((g) => g.label);
  const iT = l.indexOf('今天'), iA = l.indexOf('今天 API');
  return iT >= 0 && iA === iT + 1;
})());

console.log('== 6. 与「显示 API 对话」开关同一口径 ==');
// 分组判定与那个开关共用 isApiChat:开关关掉时这些会话整块消失,不能留下一个
// 「今天 API (0)」的空壳分组,也不能因为分了组就绕过开关把接口会话漏出来。
// 走真实路径:设置 → 数据 → 「在对话列表显示 API 对话」,点开关本体旁边的 .slider
// (input 是视觉隐藏的,观感由 .slider 画)。
async function setApiSwitch(p, on) {
  await p.evaluate(() => { if (window.openSettings) window.openSettings('data'); });
  await p.waitForSelector('#pref-show-api-chats', { state: 'attached', timeout: 15000 });
  const box = p.locator('#pref-show-api-chats');
  if ((await box.isChecked()) !== on) await p.locator('#pref-show-api-chats + .slider').click();
  await p.waitForTimeout(150);
  const state = await box.isChecked();
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  return state;
}
const offPage = await openFront();
check('先确认开关默认是打开的', await setApiSwitch(offPage, true) === true);
await offPage.reload({ waitUntil: 'domcontentloaded' });
await offPage.waitForSelector('#chat-list .chat-group-section', { timeout: 30000 });
check('关掉开关', await setApiSwitch(offPage, false) === false);
// 当场生效:开关只改偏好,若不在这里重绘侧栏,用户会看到「开关关了、列表原样不动」,
// 直到某次刷新才生效(实测过)。先不 reload 量一遍。
let offGroups = await readGroups(offPage);
check('关掉开关后侧栏当场刷新(不需要手动重新加载)',
  !offGroups.some((g) => g.label.indexOf('API') >= 0) && !offGroups.some((g) => g.titles.some((t) => t.startsWith('API · '))));
await offPage.reload({ waitUntil: 'domcontentloaded' });
await offPage.waitForSelector('#chat-list .chat-group-section', { timeout: 30000 });
await offPage.waitForFunction((t) => !!document.body.innerText.includes(t), '手动对话(今天)', { timeout: 30000 });
offGroups = await readGroups(offPage);
console.log('    关掉开关后: ' + offGroups.map((g) => g.label + '(' + g.count + ')').join(' / '));
check('关掉开关后不出现「今天 API」分组', !offGroups.some((g) => g.label.indexOf('API') >= 0));
check('关掉开关后列表里没有任何接口会话', !offGroups.some((g) => g.titles.some((t) => t.startsWith('API · '))));
check('关掉开关后不残留空的 API 分组(幽灵组)', offGroups.every((g) => g.count > 0 && g.titles.length > 0));
check('关掉开关后手动对话照旧显示', col(offGroups, '今天').titles.includes('手动对话(今天)'));
check('重新打开开关', await setApiSwitch(offPage, true) === true);
check('重新打开开关后分组也当场回来', await waitGroup(offPage, '今天 API', 5000));
await offPage.reload({ waitUntil: 'domcontentloaded' });
await offPage.waitForSelector('#chat-list .chat-group-section', { timeout: 30000 });
// 等侧栏里真的出现这个分组再断言(不能等页面文本:「接口调用一」在对话正文里也有,
// 会话列表还没拉回来时就会提前满足 → 量到一份还没有接口会话的列表)
check('重新打开开关后分组回来(确认差异来自开关而不是别处)', await waitGroup(offPage, '今天 API'));
offGroups = await readGroups(offPage);
check('分组回来且归属不变', col(offGroups, '今天 API').titles.includes(API_TITLE)
  && !col(offGroups, '今天').titles.some((t) => t.startsWith('API · ')));
await offPage.close();

console.log('== 7. 运行期异常 ==');
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
