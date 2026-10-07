/* 在线工具箱 GUI 自检(真 Chromium + 真服务端):
 *   node tests/toolbox-gui.mjs
 *
 * 为什么必须用真浏览器:这个功能的安全边界是「不透明源」,而它**在源码里看不出来**。
 *   · 预览:iframe 的 sandbox 属性少一个 allow-same-origin 就是隔离,多一个就是把
 *     账号(oc_token 在 localStorage)交出去 —— 两种写法的代码长得几乎一样,
 *     而且功能照常、界面上毫无区别。
 *   · 新标签页:CSP 的 sandbox 指令让文档变成不透明源,响应头列表里那一行写成什么样
 *     和「浏览器肯不肯把它当成不透明源」是两回事,curl 里也量不出来。
 * 这里让工具自己 parent.postMessage 报出 location.origin 与 localStorage 可达性 ——
 * 只有真跑起来才知道它到底被关在什么里。顺带守住落库、乐观并发、删除、窄屏、开关隐藏、
 * 自有地址 /toolbox(刷新停在原页 + 左上角 logo/返回)、系统工具(平台共用、可复制)、
 * 以及分类的增删改与筛选。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TBOX_GUI_PORT || 8571);
const MOCK_PORT = Number(process.env.TBOX_GUI_MOCK_PORT || 8572);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'tbox-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c, got) => { if (c) ok(m); else bad(m + (got === undefined ? '' : ' —— 实得 ' + JSON.stringify(got))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const p of [PORT, MOCK_PORT]) {
  try {
    await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(800) });
    console.error(`✗ 端口 ${p} 已被占用(疑似残留的 php -S),请先结束该进程或用 TBOX_GUI_PORT 换端口`);
    process.exit(1);
  } catch (e) { /* 端口空闲 */ }
}

// playwright 定位:CI 走 node_modules,本机通常只有 npx 缓存。LOCALAPPDATA 未设置时
// join('', ...) 会退化成相对路径让 readdirSync 抛错(Linux CI 上踩过),所以先判断存在。
const candidates = [];
try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未装到 node_modules */ }
const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
if (existsSync(cache)) {
  for (const d of readdirSync(cache)) {
    const p = join(cache, d, 'node_modules/playwright/index.mjs');
    if (existsSync(p)) candidates.push(pathToFileURL(p).href);
  }
}
let pw = null;
for (const c of candidates) { try { pw = await import(c); break; } catch (e) { /* 换下一个 */ } }
if (!pw) { console.log('(skip) 未找到 playwright,跳过在线工具箱 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-tbox-gui-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
const sp = (a, e) => { const p = spawn('php', a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(p); return p; };
process.on('exit', () => { procs.forEach((p) => { try { p.kill(); } catch (e) {} }); rmSync(TMP, { recursive: true, force: true }); });

const appErr = [];
const app = sp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_ALLOW_PRIVATE_UPSTREAM: '1',
});
app.stderr.on('data', (d) => appErr.push(String(d)));
sp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});

let up = false;
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(BASE + '/api/config'); if (r.status) { up = true; break; } } catch (e) { /* 未就绪 */ }
  await sleep(250);
}
if (!up) { console.error('✗ 应用服务未启动\n' + appErr.join('').slice(-1500)); process.exit(1); }

const loginRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
});
const loginText = await loginRes.text();
let login = {};
try { login = JSON.parse(loginText); } catch (e) { console.error('✗ 登录响应非 JSON: ' + loginText.slice(0, 300)); process.exit(1); }
if (!login.token) { console.error('✗ 管理员登录失败'); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

// 没有供应商时前台会停在初始化引导,侧栏入口点不到,所以照其它 GUI 用例一样先建一个。
const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'TBoxMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-tbox',
    apiFormat: 'chat', scope: 'global', costPerCall: 1, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes && provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }
const setSettings = (patch) => fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify(patch) });
await setSettings({ toolboxEnabled: true });

// 工具源码:自己报出「我是什么来源」「能不能碰 localStorage」。
// 这段脚本同时也是「沙箱里 allow-scripts 生效」的证据 —— 收不到这条消息,要么脚本没跑,
// 要么隔离把它关死了。
const TOOL_TITLE = '计算器小工具';
const TOOL_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>TB-POPUP-OK</title></head>',
  '<body><div id="m">TB-RUN-MARK</div>',
  '<script>',
  '  var ls = false, ck = "none";',
  '  try { localStorage.getItem("oc_token"); ls = true; } catch (e) { ls = false; }',
  '  try { ck = document.cookie || "empty"; } catch (e) { ck = "blocked"; }',
  '  try {',
  '    parent.postMessage(JSON.stringify({ tag: "tb-probe", origin: String(window.origin), ls: ls, cookie: ck }), "*");',
  '  } catch (e) {}',
  '<\/script></body></html>',
].join('\n');

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const pageErrors = [];
// 从建 context 起就收集新页:等点击那一刻再 waitForEvent,会和 window.open 抢时序
const openedPages = [];
ctx.on('page', (p) => openedPages.push(p));
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.addInitScript(([token, prov]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_provider', prov);
  localStorage.setItem('oc_model_' + prov, 'mock-model');
}, [login.token, PROV]);

// 后台面板单独开一页(同一个 context,所以登录态也是同一份)。
// 不用 ctx.addInitScript:那段脚本会被注进工具箱 iframe 里,而「工具读不到 localStorage」
// 正是要量的结论,不该由测试自己去碰它。
// 后台保存是「整份下发」,没有幂等的进度可等;直接轮询接口到落库为止最稳,
// 也顺带证明「界面上点了保存」与「服务端真的存下了」是同一件事。
async function waitSysDoc(pred, timeout = 15000) {
  const t0 = Date.now();
  let last = {};
  while (Date.now() - t0 < timeout) {
    try { last = await (await fetch(BASE + '/api/admin/toolbox', { headers: AUTH })).json(); } catch (e) { last = {}; }
    if (pred(last)) return last;
    await sleep(250);
  }
  return last;
}

async function openAdminPage() {
  const p = await ctx.newPage();
  // 只收 JS 异常:后台页面的控制台错误里混着与本功能无关的资源告警,收进来会误报
  p.on('pageerror', (e) => pageErrors.push('admin: ' + String((e && e.message) || e)));
  await p.addInitScript(([token, prov]) => {
    localStorage.setItem('oc_token', token);
    localStorage.setItem('oc_provider', prov);
  }, [login.token, PROV]);
  return p;
}

async function boot() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.OCApp && window.OCApp.state && window.OCApp.state.user), null, { timeout: 30000 });
  await page.waitForFunction(() => !!(window.OCApp.state.models || []).length, null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.OCToolbox, null, { timeout: 30000 });
  await sleep(250);
}
const openPanel = async () => {
  await page.click('#toolbox-entry-btn');
  await page.waitForSelector('.tb-mask.show', { timeout: 15000 });
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 15000 });
};

console.log('== 1. 入口:位置在「在线浏览器」下方,且有图标 ==');
await boot();
{
  check('工具箱入口可见', await page.locator('#toolbox-entry-btn').isVisible());
  const box = await page.evaluate(() => {
    const w = document.getElementById('web-entry-btn').getBoundingClientRect();
    const t = document.getElementById('toolbox-entry-btn').getBoundingClientRect();
    const ico = document.getElementById('toolbox-entry-icon');
    return { wy: w.top, ty: t.top, wbottom: w.bottom, label: document.querySelector('#toolbox-entry-btn .model-name').textContent.trim(), ico: ico ? ico.innerHTML.length : 0 };
  });
  check('入口排在在线浏览器下方(同一竖列)', box.ty >= box.wbottom - 1 && box.ty > box.wy, box);
  check('入口文案是「在线工具箱」', box.label === '在线工具箱', box.label);
  check('入口图标已渲染(不是空白方块)', box.ico > 20, box.ico);
}

console.log('\n== 2. 新建 → 保存 → 落库(真服务端往返)==');
{
  await openPanel();
  check('新建按钮可见', await page.locator('#tb-new').isVisible());
  await page.click('#tb-new');
  await page.waitForSelector('#tb-view-editor:not(.hidden)', { timeout: 10000 });
  const tpl = await page.locator('#tb-code').inputValue();
  check('新建时预置了可运行的骨架', tpl.includes('<!doctype html>') && tpl.includes('<h1>'), tpl.slice(0, 40));
  const countText = await page.locator('#tb-count').innerText();
  check('字符计数已显示', /字符/.test(countText) && /\d/.test(countText), countText);

  await page.fill('#tb-name', TOOL_TITLE);
  await page.fill('#tb-code', TOOL_HTML);
  await page.click('#tb-save');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#tb-grid-mine .tb-card-name', { timeout: 10000 });
  check('保存后回到列表并出现卡片', (await page.locator('#tb-grid-mine').innerText()).includes(TOOL_TITLE));

  const doc = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  const items = (doc.doc && doc.doc.items) || [];
  check('服务端真收到 1 条', items.length === 1, items.length);
  check('HTML 原样落库(服务端不清洗)', items[0] && items[0].html === TOOL_HTML);
  check('修订号已推进', Number(doc.revision) >= 1, doc.revision);
  check('下发投影带签名后的 pageUrl', !!(items[0] && items[0].pageUrl && items[0].pageUrl.includes('&s=')), items[0] && items[0].pageUrl);
}

console.log('\n== 3. 预览必须是不透明源(本功能的唯一安全边界)==');
{
  // 父页面收工具发来的自报:只有真跑在沙箱里才收得到这段 origin。
  await page.evaluate(() => {
    window.__tbMsgs = [];
    window.addEventListener('message', (e) => window.__tbMsgs.push({ origin: String(e.origin), data: String(e.data) }));
  });
  await page.click('#tb-grid-mine .tb-card-main');
  await page.waitForSelector('#tb-view-preview:not(.hidden)', { timeout: 10000 });
  await page.waitForSelector('.tb-frame', { timeout: 10000 });

  const frame = await page.evaluate(() => {
    const f = document.querySelector('.tb-frame');
    if (!f) return null;
    let readable = 'blocked';
    try { void f.contentWindow.document; readable = 'readable'; } catch (e) { readable = 'blocked'; }
    return {
      sandbox: f.getAttribute('sandbox') || '',
      ss: getComputedStyle(f).display,
      cd: f.contentDocument === null ? 'null' : 'reachable',
      readable: readable,
      ref: f.getAttribute('referrerpolicy') || '',
    };
  });
  check('预览用的是 iframe', !!frame && frame.ss !== 'none', frame && frame.ss);
  const toks = (frame ? frame.sandbox : '').split(/\s+/).filter(Boolean);
  check('sandbox 带 allow-scripts(工具脚本要能跑)', toks.includes('allow-scripts'), toks);
  check('sandbox 不带 allow-same-origin', !toks.includes('allow-same-origin'), toks);
  check('sandbox 不带 allow-popups-to-escape-sandbox', !toks.includes('allow-popups-to-escape-sandbox'), toks);
  check('父页面读不到 iframe 文档(跨源,contentDocument 为 null)', frame && frame.cd === 'null', frame && frame.cd);
  check('访问 iframe.contentWindow.document 被拒', frame && frame.readable === 'blocked', frame && frame.readable);
  check('预览带 no-referrer(不把本站地址泄给工具外链)', frame && frame.ref === 'no-referrer', frame && frame.ref);

  await page.waitForFunction(() => (window.__tbMsgs || []).length > 0, null, { timeout: 10000 }).catch(() => {});
  const msgs = await page.evaluate(() => window.__tbMsgs || []);
  const probe = msgs.map((m) => { try { return JSON.parse(m.data); } catch (e) { return null; } }).find((x) => x && x.tag === 'tb-probe');
  check('工具脚本真的执行了(收到自报)', !!probe, msgs.slice(0, 3));
  check('工具运行在不透明源(window.origin 为 "null")', probe && probe.origin === 'null', probe && probe.origin);
  check('消息来源同样是 "null"(父页面据此认得出沙箱)', msgs[0] && msgs[0].origin === 'null', msgs[0] && msgs[0].origin);
  check('工具读不到 localStorage 里的登录令牌', probe && probe.ls === false, probe && probe.ls);
  check('工具读不到本站 Cookie(空串或直接抛 SecurityError)', probe && (probe.cookie === 'empty' || probe.cookie === 'blocked'), probe && probe.cookie);

  // 预览的「返回」是「从哪来回哪去」:卡片点开的回列表,编辑器里「运行预览」的回编辑器。
  // 写死一边就会让另一边从预览里掉到错误的页面 —— 所以两边都走一遍。
  await page.click('#tb-preview-back');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 10000 });
  check('从卡片点开的预览,「返回」回到列表', (await page.locator('#tb-grid-mine .tb-card:not(.tb-card-new)').count()) > 0);

  await page.click('#tb-grid-mine .tb-icon-btn[data-edit]');
  await page.waitForSelector('#tb-view-editor:not(.hidden)', { timeout: 10000 });
  check('可回到编辑(源码还在)', (await page.locator('#tb-code').inputValue()) === TOOL_HTML);
  await page.click('#tb-preview-run');
  await page.waitForSelector('#tb-view-preview:not(.hidden)', { timeout: 10000 });
  check('编辑器里的内容也能直接跑预览', await page.locator('.tb-frame').count() === 1);
  await page.click('#tb-preview-back');
  await page.waitForSelector('#tb-view-editor:not(.hidden)', { timeout: 10000 });
  check('从编辑器跑起来的预览,「返回」回到编辑器(不是掉回列表)', (await page.locator('#tb-code').inputValue()) === TOOL_HTML);
  await page.click('#tb-cancel');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 10000 });
}

console.log('\n== 4. 新标签页:服务端端点(响应头里再上一道沙箱)==');
{
  await page.evaluate(() => {
    window.__tbMsgs = [];
    window.addEventListener('message', (e) => window.__tbMsgs.push({ origin: String(e.origin), data: String(e.data) }));
  });
  await page.click('#tb-grid-mine .tb-card-main');
  await page.waitForSelector('#tb-view-preview:not(.hidden)', { timeout: 10000 });

  const doc = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  const pageUrl = doc.doc.items[0].pageUrl;

  const info = await page.evaluate(async (u) => {
    const url = window.apiUrl ? window.apiUrl(u) : u;
    const r = await fetch(url, { credentials: 'include' });
    const h = {};
    ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'cache-control', 'referrer-policy'].forEach((k) => { h[k] = r.headers.get(k); });
    return { status: r.status, h: h, text: await r.text() };
  }, pageUrl);
  check('工具页端点返回 200', info.status === 200, info.status);
  const csp = info.h['content-security-policy'] || '';
  check('工具页响应带 CSP', csp.length > 0, csp);
  const sandboxDir = csp.slice(csp.indexOf('sandbox'));
  const cspToks = sandboxDir.split(';')[0].split(/\s+/).filter(Boolean);
  check('CSP 里带 sandbox 指令', sandboxDir.startsWith('sandbox'), sandboxDir.slice(0, 60));
  check('CSP sandbox 带 allow-scripts', cspToks.includes('allow-scripts'), cspToks);
  check('CSP sandbox 不带 allow-same-origin', !cspToks.includes('allow-same-origin'), cspToks);
  check('CSP 的 frame-ancestors 收在 self', /frame-ancestors 'self'/.test(csp), csp);
  check('X-Frame-Options 被覆盖为 SAMEORIGIN(默认是 DENY)', info.h['x-frame-options'] === 'SAMEORIGIN', info.h['x-frame-options']);
  check('工具页带 nosniff', info.h['x-content-type-options'] === 'nosniff', info.h['x-content-type-options']);
  check('工具页不缓存(改了立刻生效)', /no-store/.test(info.h['cache-control'] || ''), info.h['cache-control']);
  check('工具页正文原样输出(未被清洗成实体)', info.text.includes('TB-RUN-MARK') && info.text.includes('localStorage'), info.text.slice(0, 60));

  const bad = await page.evaluate(async (u) => {
    const url = (window.apiUrl ? window.apiUrl(u) : u).replace(/&s=[^&]*$/, '&s=deadbeefdeadbeefdeadbeef');
    const r = await fetch(url, { credentials: 'include' });
    return r.status;
  }, pageUrl);
  check('签名被篡改直接 403(签不出来就读不到)', bad === 403, bad);
  const noSig = await page.evaluate(async (u) => {
    const url = (window.apiUrl ? window.apiUrl(u) : u).replace(/&s=[^&]*$/, '');
    const r = await fetch(url, { credentials: 'include' });
    return r.status;
  }, pageUrl);
  check('不带签名同样 403', noSig === 403, noSig);

  // 真导航一次:只有浏览器知道这份文档到底是不是不透明源
  const pop = await ctx.newPage();
  await pop.goto(BASE + pageUrl.replace(/^\/+/, '/'), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pop.waitForFunction(() => document.readyState === 'complete', null, { timeout: 10000 }).catch(() => {});
  const popInfo = await pop.evaluate(() => {
    let ls = 'reachable', ck = 'reachable';
    try { localStorage.getItem('oc_token'); } catch (e) { ls = 'blocked'; }
    try { void document.cookie; } catch (e) { ck = 'blocked'; }
    // 判据必须用 window.origin / self.origin:location.origin 反映的是 URL 里的来源,
    // 文档已经被关进不透明源时它照样报本站地址(实测),拿它当凭据会得出错误结论。
    return {
      winOrigin: String(window.origin), selfOrigin: String(self.origin),
      ls: ls, ck: ck, body: document.body ? document.body.innerText : '', title: document.title,
    };
  });
  check('新标签页能打开(签名 + Cookie 认人)', popInfo.body.includes('TB-RUN-MARK'), popInfo.body.slice(0, 40));
  check('新标签页里是不透明源(window.origin 为 "null")', popInfo.winOrigin === 'null' && popInfo.selfOrigin === 'null', popInfo);
  check('新标签页里读不到 localStorage', popInfo.ls === 'blocked', popInfo.ls);
  check('新标签页里读不到本站 Cookie', popInfo.ck === 'blocked', popInfo.ck);
  check('新标签页里的脚本照常执行(allow-scripts)', popInfo.title === 'TB-POPUP-OK', popInfo.title);
  await pop.close();

  // 面板上的按钮也要真的开出这个地址(noopener)
  const seenBefore = openedPages.length;
  await page.click('#tb-preview-newtab');
  await sleep(1500);
  const newTab = openedPages.slice(seenBefore).find((p) => p.url().includes('/api/toolbox/page'));
  check('「在新标签页打开」真的弹出新页', !!newTab, ctx.pages().map((p) => p.url()));
  if (newTab) {
    check('弹窗地址就是签名工具页', newTab.url().includes('/api/toolbox/page?id='), newTab.url());
    await newTab.close();
  }
  await page.click('#tb-preview-close');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 10000 });
}

console.log('\n== 5. 刷新后仍在(不是只存在内存里)==');
{
  await boot();
  await openPanel();
  await page.waitForSelector('#tb-grid-mine .tb-card-name', { timeout: 10000 });
  check('重新加载后卡片还在', (await page.locator('#tb-grid-mine').innerText()).includes(TOOL_TITLE));
  const sub = await page.locator('#tb-sub').innerText();
  check('标题栏统计了条数与体积', /1 个我的工具/.test(sub) && /KB/.test(sub), sub);
  check('标题栏也报出系统工具条数', /10 个系统工具/.test(sub), sub);
}

console.log('\n== 6. 删除后各设备都会同步移除 ==');
{
  // 先记下这条工具的签名地址:删掉之后它必须变成 404,而不是继续能读
  const before = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  const removedUrl = before.doc.items[0].pageUrl;
  await page.click('.tb-icon-btn[data-del]');
  await page.waitForSelector('.oc-confirm-mask [data-act="ok"]', { timeout: 10000 });
  await page.click('.oc-confirm-mask [data-act="ok"]');
  await page.waitForFunction(() => !document.querySelector('#tb-grid-mine .tb-card-name'), null, { timeout: 15000 }).catch(() => {});
  check('列表里已移除', (await page.locator('#tb-grid-mine .tb-card-name').count()) === 0);
  const doc = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  check('服务端条目已删', ((doc.doc && doc.doc.items) || []).length === 0);
  const tombKeys = Object.keys((doc.doc && doc.doc.tombs) || {});
  check('留下墓碑(别的设备不会把它合并回来)', tombKeys.length === 1 && /^[A-Za-z0-9_-]+$/.test(tombKeys[0]), doc.doc && doc.doc.tombs);
  check('墓碑必须是对象形态(空 map 被发成 [] 时删除会被静默吞掉)', !Array.isArray(doc.doc && doc.doc.tombs), doc.doc && doc.doc.tombs);

  // 签名还在、但条目已经不属于我 —— 必须 404,不把「存在过」暴露出来
  const live = await page.evaluate(async (u) => {
    const r = await fetch(window.apiUrl ? window.apiUrl(u) : u, { credentials: 'include' });
    return r.status;
  }, removedUrl);
  check('签名有效但条目已删除 -> 404(不泄露是否存在)', live === 404, live);
  await page.click('#tb-close');
  await sleep(300);
  await boot();
  await openPanel();
  await page.waitForSelector('.tb-empty', { timeout: 10000 }).catch(() => {});
  check('刷新后依然是删掉的状态', (await page.locator('#tb-grid-mine .tb-card-name').count()) === 0);
  check('空箱子给出引导文案', (await page.locator('#tb-grid-mine').innerText()).includes('工具箱还是空的'));
}

console.log('\n== 7. 后台关闭后入口必须消失(刷新一次就生效)==');
{
  await page.click('#tb-close');
  const entryHidden = async (want) => {
    await boot();
    // 入口是在 defer 阶段按**缓存**的 oc_cfg 渲染的,配置随后才到货;刷新一次就该重判,
    // 不该出现「后台关了但入口还在,要再刷一次」。
    try {
      await page.waitForFunction((w) => {
        const b = document.getElementById('toolbox-entry-btn');
        return b ? b.classList.contains('hidden') === w : false;
      }, want, { timeout: 6000 });
    } catch (e) { /* 交给下面的断言报出来 */ }
    return !(await page.locator('#toolbox-entry-btn').isVisible());
  };
  await setSettings({ toolboxEnabled: false });
  check('关掉总开关后入口隐藏', await entryHidden(true));
  await setSettings({ toolboxEnabled: true });
  check('重新打开后入口恢复', !(await entryHidden(false)));
}

console.log('\n== 8. 窄屏可用 ==');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  // 窄屏侧栏是抽屉,入口被挪到屏外:照真实用户的路径先拉开抽屉再点入口,
  // 直接点会报「元素在视口外」,而那不代表功能有问题。
  // 别用 isVisible() 判断抽屉收没收起:它只是被 transform 移出视口,仍算「可见」
  const offscreen = await page.evaluate(() => document.getElementById('toolbox-entry-btn').getBoundingClientRect().right <= 1);
  check('窄屏下入口收在抽屉里(不在屏内)', offscreen);
  await page.click('#mobile-menu-btn');
  await sleep(500);
  check('拉开抽屉后入口可点', await page.locator('#toolbox-entry-btn').isVisible());
  await page.click('#toolbox-entry-btn');
  await page.waitForSelector('.tb-mask.show', { timeout: 15000 });
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 15000 });
  const box = await page.locator('.tb-fs').boundingBox();
  check('面板在屏内且铺满可用宽度', !!box && box.width >= 300 && box.x >= -1, box);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('页面无横向溢出', overflowX <= 1, overflowX);
  const closeVisible = await page.locator('#tb-close').isVisible();
  check('关闭按钮在窄屏仍可见可达', closeVisible);
  await page.click('#tb-close');
  await sleep(400);
  check('窄屏下能关掉面板', !(await page.locator('.tb-mask.show').count()));
  await page.setViewportSize({ width: 1280, height: 860 });
}

console.log('\n== 9. 系统工具:内置 10 套、平台共用、可加入自己的工具箱 ==');
{
  await boot();
  await openPanel();
  await page.waitForSelector('#tb-grid-sys .tb-card-name', { timeout: 15000 });
  check('我的工具与系统工具分成两区', (await page.locator('#tb-sec-mine .tb-sec-title').innerText()).includes('我的工具')
    && (await page.locator('#tb-sec-sys .tb-sec-title').innerText()).includes('系统工具'));
  check('系统区说明「由管理员维护、所有人可用」', (await page.locator('#tb-sec-sys').innerText()).includes('管理员'));
  const sysCount = await page.locator('#tb-grid-sys .tb-card:not(.tb-card-new)').count();
  check('系统区有 10 套内置工具', sysCount === 10, sysCount);
  check('系统卡片带「系统」角标(与自己的工具分得开)', (await page.locator('#tb-grid-sys .tb-card-badge').count()) === 10);
  check('系统卡片有「加入我的工具箱」按钮', (await page.locator('#tb-grid-sys .tb-icon-btn[data-adopt]').count()) === 10);
  check('系统工具内置了 Base64 编解码', (await page.locator('#tb-grid-sys').innerText()).includes('Base64 编解码'));
  check('分类芯片来自系统分类', (await page.locator('#tb-chips').innerText()).includes('随机生成'));

  // 加入我的工具箱:源码、标题、分类一起带过来,存下去就是我自己的那一份
  await page.click('#tb-grid-sys .tb-card[data-id="uuid"] .tb-icon-btn[data-adopt]');
  await page.waitForSelector('#tb-view-editor:not(.hidden)', { timeout: 10000 });
  check('「加入我的工具箱」把源码带进编辑器', (await page.locator('#tb-name').inputValue()) === 'UUID 生成');
  check('带过来的是完整整页', (await page.locator('#tb-code').inputValue()).includes('<!doctype html>'));
  check('分类一并带了过来', (await page.locator('#tb-cat').inputValue()) === 'gen', await page.locator('#tb-cat').inputValue());
  await page.fill('#tb-name', '我的 UUID');
  await page.click('#tb-save');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 15000 });
  check('保存后出现在「我的工具」区', (await page.locator('#tb-grid-mine').innerText()).includes('我的 UUID'));
  check('系统区那份原样保留(复制不是移动)', (await page.locator('#tb-grid-sys').innerText()).includes('UUID 生成'));
  const mineDoc = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  check('落库的是我自己的一份,分类也存下了', mineDoc.doc.items.length === 1 && mineDoc.doc.items[0].cat === 'gen', mineDoc.doc.items);

  // 分类管理:新建 → 筛选 → 重命名 → 删除
  await page.click('#tb-cats');
  await page.waitForSelector('#tb-view-cats:not(.hidden)', { timeout: 10000 });
  await page.fill('#tb-cat-new', '我的实验');
  await page.click('#tb-cat-add');
  await page.waitForFunction(() => document.querySelectorAll('#tb-cats-list [data-cat-row]').length === 2, null, { timeout: 10000 }).catch(() => {});
  check('新建的分类出现在分类管理里', (await page.locator('#tb-cats-list').innerText()).includes('我的实验'));
  check('分类行显示归入的工具数', (await page.locator('#tb-cats-list').innerText()).includes('1 个工具'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 10000 });
  check('Esc 从分类管理返回列表', true);
  check('新分类出现在筛选芯片里', (await page.locator('#tb-chips').innerText()).includes('我的实验'));

  await page.click('#tb-chips [data-cat="gen"]');
  await sleep(250);
  check('按分类筛选:我的工具只剩这一条', (await page.locator('#tb-grid-mine .tb-card:not(.tb-card-new)').count()) === 1, await page.locator('#tb-grid-mine .tb-card:not(.tb-card-new)').count());
  // 内置的「随机生成」下正好两套(随机密码 / UUID),两侧 id 都叫 gen,筛的是同一组
  check('同名分类两边一起筛(系统区 id 也是 gen)', (await page.locator('#tb-grid-sys .tb-card:not(.tb-card-new)').count()) === 2, await page.locator('#tb-grid-sys .tb-card:not(.tb-card-new)').count());
  check('分区标题报出「筛后 / 总数」', /\d+ \/ \d+/.test(await page.locator('#tb-count-mine').innerText()), await page.locator('#tb-count-mine').innerText());
  await page.locator('.tb-chip', { hasText: '我的实验' }).click();
  await page.waitForSelector('#tb-grid-mine .tb-empty', { timeout: 10000 }).catch(() => {});
  check('筛到空分类时给出引导文案', (await page.locator('#tb-grid-mine').innerText()).includes('这个分类下还没有工具'));
  await page.click('#tb-chips [data-cat=""]');
  await sleep(250);
  check('点「全部」回到不筛选', (await page.locator('#tb-grid-mine .tb-card:not(.tb-card-new)').count()) === 1);

  // 重命名走站内输入弹窗,改完分类管理与芯片都要跟着变
  await page.click('#tb-cats');
  await page.waitForSelector('#tb-cats-list [data-cat-row]', { timeout: 10000 });
  const genCatId = await page.locator('#tb-cats-list [data-cat-row]', { hasText: '随机生成' }).first().getAttribute('data-cat-row');
  await page.click('#tb-cats-list [data-cat-ren="' + genCatId + '"]');
  await page.waitForSelector('.oc-prompt-input', { timeout: 10000 });
  await page.fill('.oc-prompt-input', '生成类');
  await page.click('.oc-confirm-mask [data-act="ok"]');
  await sleep(500);
  check('重命名后分类管理里是新名字', (await page.locator('#tb-cats-list').innerText()).includes('生成类'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 10000 });
  check('重命名后筛选芯片也跟着变', (await page.locator('#tb-chips').innerText()).includes('生成类'));

  // 删除分类:工具不会被删,归属回到「未分类」。删的是有工具的那条(生成类),
  // 空分类留着不动 —— 顺带确认删分类不会连带删掉别的分类。
  await page.click('#tb-cats');
  await page.waitForSelector('#tb-cats-list [data-cat-row]', { timeout: 10000 });
  const expId = await page.evaluate(() => {
    const rows = document.querySelectorAll('#tb-cats-list [data-cat-row]');
    for (const r of rows) if (r.innerText.includes('生成类')) return r.getAttribute('data-cat-row');
    return '';
  });
  await page.click('#tb-cats-list [data-cat-del="' + expId + '"]');
  await page.waitForSelector('.oc-confirm-mask [data-act="ok"]', { timeout: 10000 });
  await page.click('.oc-confirm-mask [data-act="ok"]');
  await sleep(600);
  check('分类已删除', !(await page.locator('#tb-cats-list').innerText()).includes('生成类'));
  check('另一个空分类还在(删的是指定那一条)', (await page.locator('#tb-cats-list').innerText()).includes('我的实验'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 10000 });
  check('删分类不会删掉工具', (await page.locator('#tb-grid-mine .tb-card:not(.tb-card-new)').count()) === 1);
  const afterDel = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  check('被删分类下的工具回到「未分类」', (afterDel.doc.items[0].cat || '') === '', afterDel.doc.items[0].cat);
  check('未分类芯片随之出现', (await page.locator('#tb-chips').innerText()).includes('未分类'));
  check('已删分类的芯片随之消失', !(await page.locator('#tb-chips').innerText()).includes('生成类'));
  await page.click('#tb-close');
  await sleep(400);
}

console.log('\n== 10. 系统工具也是不透明源,签名与用户工具互不通用 ==');
{
  const doc = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  const sysItem = (doc.sys.items || []).find((x) => x.id === 'base64');
  check('同步接口把系统工具一起下发(前台不用再请求一次)', !!sysItem);
  check('系统工具的地址带 sys=1', /[?&]sys=1/.test(sysItem.pageUrl), sysItem.pageUrl);

  const info = await page.evaluate(async (u) => {
    const r = await fetch(window.apiUrl ? window.apiUrl(u) : u, { credentials: 'include' });
    return {
      status: r.status,
      csp: r.headers.get('content-security-policy') || '',
      xfo: r.headers.get('x-frame-options'),
      text: await r.text(),
    };
  }, sysItem.pageUrl);
  check('系统工具页返回 200', info.status === 200, info.status);
  check('系统工具页同样带 CSP sandbox(与用户工具共用那几行响应头)', /sandbox allow-scripts/.test(info.csp), info.csp);
  const sysCspToks = info.csp.slice(info.csp.indexOf('sandbox')).split(';')[0].split(/\s+/).filter(Boolean);
  check('系统工具页的 sandbox 不带 allow-same-origin', !sysCspToks.includes('allow-same-origin'), sysCspToks);
  check('系统工具页的 X-Frame-Options 也是 SAMEORIGIN', info.xfo === 'SAMEORIGIN', info.xfo);
  check('系统工具页正文就是那套工具(不是空壳)', info.text.includes('Base64') && info.text.includes('<script>'), info.text.slice(0, 60));

  const status = async (u) => page.evaluate(async (x) => {
    const r = await fetch(window.apiUrl ? window.apiUrl(x) : x, { credentials: 'include' });
    return r.status;
  }, u);
  check('伪造签名读系统工具 -> 403', (await status('/api/toolbox/page?id=base64&s=' + 'x'.repeat(24) + '&sys=1')) === 403);
  // 命名空间是分开的:系统工具那张签名摘掉 sys=1 就落到用户工具的空间里,不该通过
  check('系统工具签名摘掉 sys=1 就不通过(两套空间分开)', (await status(sysItem.pageUrl.replace('&sys=1', ''))) === 403);

  const p2 = await ctx.newPage();
  await p2.goto(BASE + sysItem.pageUrl.replace(/^\/+/, '/'), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p2.waitForFunction(() => document.readyState === 'complete', null, { timeout: 10000 }).catch(() => {});
  const popInfo = await p2.evaluate(() => {
    let ls = 'reachable';
    try { localStorage.getItem('oc_token'); } catch (e) { ls = 'blocked'; }
    return { w: String(window.origin), ls: ls, body: document.body ? document.body.innerText : '' };
  });
  check('系统工具在新标签页里能打开', popInfo.body.includes('Base64'), popInfo.body.slice(0, 40));
  check('系统工具在新标签页里同样是不透明源', popInfo.w === 'null', popInfo.w);
  check('系统工具页也读不到 localStorage', popInfo.ls === 'blocked', popInfo.ls);
  await p2.close();

  // 平台共用:另一个普通用户看得到同一批系统工具,却打不开别人的私人工具
  const created = await (await fetch(BASE + '/api/admin/users', {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ name: 'tboxbob', password: 'tbox-bob-1', quota: 100 }),
  })).json();
  check('建了第二个用户(用来验证「共用」与「私有」的分界)', !!(created && (created.user || created.ok)), created);
  const login2 = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'tboxbob', password: 'tbox-bob-1' }),
  })).json();
  check('第二个用户能登录', !!login2.token);
  const AUTH2 = { Authorization: 'Bearer ' + login2.token, 'Content-Type': 'application/json' };
  const doc2 = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH2 })).json();
  check('别人的私人工具箱是空的', ((doc2.doc && doc2.doc.items) || []).length === 0, doc2.doc && doc2.doc.items);
  check('系统工具对每个人都是同一份(10 套)', ((doc2.sys && doc2.sys.items) || []).length === 10, doc2.sys && doc2.sys.items.length);
  check('系统工具的地址也是同一个签名(服务端算,不按人区分)', doc2.sys.items[0].pageUrl === doc.sys.items[0].pageUrl);
  const mineUrl = doc.doc.items[0].pageUrl;
  check('别人拿着我的工具链接也是 404(签名不等于有权)', (await (await fetch(BASE + mineUrl, { headers: AUTH2 })).status) === 404);
  check('系统工具页谁都能开(只要工具箱开着)', (await (await fetch(BASE + sysItem.pageUrl, { headers: AUTH2 })).status) === 200);
}

console.log('\n== 11. 自有地址 /toolbox:刷新停在这一页,左上角有 logo 与返回 ==');
{
  await page.goto(BASE + '/toolbox', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tb-mask.show', { timeout: 20000 });
  check('直接访问 /toolbox 会自动打开工具箱(刷新不会掉回对话页)', true);
  check('地址仍是 /toolbox', new URL(page.url()).pathname === '/toolbox', page.url());
  await page.waitForSelector('#tb-brand', { timeout: 10000 });
  check('左上角有品牌 logo', (await page.locator('#tb-brand img').count()) >= 1);
  check('品牌 logo 真的显示出来了(不是被主题规则藏起来)', await page.locator('#tb-brand').isVisible());
  check('品牌图分深浅两套(跟随主题切换)', (await page.locator('#tb-brand .brand-logo-light').count()) === 1
    && (await page.locator('#tb-brand .brand-logo-dark').count()) === 1);
  check('左上角有「返回」按钮', (await page.locator('.tb-back-btn').innerText()).includes('返回'));
  const headOrder = await page.evaluate(() => {
    const b = document.getElementById('tb-brand').getBoundingClientRect();
    const back = document.querySelector('.tb-back-btn').getBoundingClientRect();
    return { brand: Math.round(b.left), back: Math.round(back.left), brandTop: Math.round(b.top) };
  });
  check('logo 在返回按钮左边(排在顶栏最左)', headOrder.brand < headOrder.back, headOrder);
  check('logo 在顶栏里(没有掉到内容区)', headOrder.brandTop < 60, headOrder);

  await page.click('.tb-back-btn');
  await sleep(500);
  check('点「返回」关掉工具箱', (await page.locator('.tb-mask.show').count()) === 0);
  check('地址回到根路径', new URL(page.url()).pathname === '/', page.url());
  await page.click('#toolbox-entry-btn');
  await page.waitForSelector('.tb-mask.show', { timeout: 15000 });
  check('从对话页再打开时地址又变成 /toolbox', new URL(page.url()).pathname === '/toolbox', page.url());
  // 浏览器后退:地址与界面必须一起退,不能出现「地址回到对话页、面板还开着」
  await page.goBack().catch(() => {});
  await sleep(700);
  check('浏览器后退会关掉工具箱', (await page.locator('.tb-mask.show').count()) === 0, page.url());
  check('后退后地址在对话页', new URL(page.url()).pathname === '/', page.url());
}

console.log('\n== 12. Esc 关面板后还能再打开(别只藏了遮罩、模块自己以为还开着)==');
{
  // 面板是挂在 OCUI 的 modal 栈上的,Esc 由栈顶关闭 —— 若模块不跟着清自己的 open 标志,
  // 再点入口会被 open() 的守卫挡回去,表现是「Esc 关掉之后再也打不开,只能刷新」。
  await boot();
  await openPanel();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.tb-mask.show'), null, { timeout: 10000 }).catch(() => {});
  check('列表页按 Esc 关掉面板', (await page.locator('.tb-mask.show').count()) === 0);
  check('Esc 关掉后地址回到根路径', new URL(page.url()).pathname === '/', page.url());
  await page.click('#toolbox-entry-btn');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 15000 }).catch(() => {});
  check('Esc 关掉之后还能再打开(状态没卡住)', await page.locator('.tb-mask.show').isVisible());
  await page.click('#tb-close');
  await sleep(400);

  // 入场那一帧迟到时不许把 show 加回来。openModal 靠「下一帧加 show」启动入场过渡,而 rAF
  // 在标签页被挂起时会迟到很久(后台标签页 / 卡顿的渲染进程;Linux CI 的 headless 上实测
  // 能晚几秒)。迟到的那一帧若照加不管,就会把 show 加回一个已经关掉的面板 —— 停在
  // hidden + show 的幽灵态:看不见(display:none 优先级更高),却让 `.tb-mask.show`
  // 与「面板还开着吗」的判断全部认错。这里把 rAF 人为推迟 600ms 复现这个时序。
  await page.evaluate(() => {
    window.__origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) { return setTimeout(() => window.__origRaf(cb), 600); };
  });
  await page.click('#toolbox-entry-btn');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 15000 });
  await page.keyboard.press('Escape');
  await sleep(1500);   // 等那一帧(600ms)真的跑过
  const ghost = await page.evaluate(() => {
    const m = document.querySelector('.tb-mask');
    return { cls: m.className, display: getComputedStyle(m).display };
  });
  check('入场帧迟到时,关掉后不会留下 hidden + show 的幽灵', !/(^|\s)show(\s|$)/.test(ghost.cls), ghost.cls);
  check('关掉后确实不可见(不是只关了一半)', ghost.display === 'none', ghost.cls);
  await page.evaluate(() => { window.requestAnimationFrame = window.__origRaf; });
}

console.log('\n== 13. 后台面板:增删分类与工具(接口与界面两处都要对得上)==');
{
  const admin = await openAdminPage();
  await admin.goto(BASE + '/admin#extensions/toolbox', { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('#toolbox-sys-body [data-tsys-item]', { timeout: 30000 });
  check('后台「在线工具箱」面板列出了 10 套内置工具',
    (await admin.locator('#toolbox-sys-body [data-tsys-item]').count()) === 10,
    await admin.locator('#toolbox-sys-body [data-tsys-item]').count());
  check('后台把内置分类也读出来了', (await admin.locator('#toolbox-sys-body .tbox-sys-chip').count()) === 5,
    await admin.locator('#toolbox-sys-body .tbox-sys-chip').count());

  // 新增分类 → 新增工具并归到它下面 → 保存(整份下发,服务端只管清洗与上限)
  await admin.fill('#tsys-cat-new', '内部工具');
  await admin.click('#tsys-cat-add');
  await admin.waitForFunction(() => document.querySelectorAll('#toolbox-sys-body .tbox-sys-chip').length === 6, null, { timeout: 10000 }).catch(() => {});
  check('后台能新建分类', (await admin.locator('#toolbox-sys-body').innerText()).includes('内部工具'));
  await admin.click('#tsys-item-add');
  await admin.waitForFunction(() => document.querySelectorAll('#toolbox-sys-body [data-tsys-item]').length === 11, null, { timeout: 10000 }).catch(() => {});
  const newRow = admin.locator('#toolbox-sys-body [data-tsys-item]').last();
  const newId = await newRow.getAttribute('data-tsys-item');
  check('新增行的源码框是打开状态(直接就能粘 HTML)', await newRow.locator('.tbox-sys-html').isVisible());
  await newRow.locator('[data-tsys-field="title"]').fill('内部小工具');
  // 下拉被 enhanceSelects 换成了 .select-box(原生 select 被 display:none 藏起来),
  // 所以不能直接 selectOption;赋值走它自己的 patch(设 value 会同步可见文字),
  // 与后台代码里的用法一致,顺带把「换控件之后 value 语义没变」这条也量一遍。
  const catSel = newRow.locator('[data-tsys-field="cat"]');
  const catId = await catSel.locator('option', { hasText: '内部工具' }).getAttribute('value');
  await catSel.evaluate((el, v) => { el.value = v; }, catId);
  const catLabel = (await newRow.locator('.select-box .sb-label').innerText()).trim();
  check('分类下拉的显示文字跟着变(换控件后 value 语义不变)', catLabel === '内部工具', catLabel);
  await newRow.locator('[data-tsys-field="html"]').fill('<!doctype html><html><body><p>ADMIN-SYS-MARK</p></body></html>');
  await admin.click('#toolbox-sys-save');

  const afterAdd = await waitSysDoc((d) => ((d.doc && d.doc.items) || []).length === 11);
  const sysItems = (afterAdd.doc && afterAdd.doc.items) || [];
  const added = sysItems.find((x) => x.id === newId);
  check('后台保存真的落到系统工具箱里', !!added, sysItems.length);
  check('落库的标题 / 分类 / 源码都是界面里填的那份',
    !!added && added.title === '内部小工具' && added.html.includes('ADMIN-SYS-MARK'), added);
  const newCat = ((afterAdd.doc && afterAdd.doc.cats) || []).find((c) => c.name === '内部工具');
  check('新分类也落库了', !!newCat, afterAdd.doc && afterAdd.doc.cats);
  check('新增的工具归到了新分类下', !!added && !!newCat && added.cat === newCat.id, added && added.cat);

  // 前台刷新后能看到它 —— 后台改完前台就生效,不需要重启
  await boot();
  await openPanel();
  await page.waitForSelector('#tb-grid-sys .tb-card-name', { timeout: 15000 });
  check('前台「系统工具」区立刻多出这一套',
    (await page.locator('#tb-grid-sys .tb-card:not(.tb-card-new)').count()) === 11
    && (await page.locator('#tb-grid-sys').innerText()).includes('内部小工具'),
    await page.locator('#tb-grid-sys .tb-card:not(.tb-card-new)').count());
  await page.click('#tb-close');
  await sleep(400);

  // 删除:后台删掉刚加的那套再保存,前台跟着消失(删除也要走同一份下发)
  await admin.bringToFront();
  await admin.locator('#toolbox-sys-body [data-tsys-item="' + newId + '"] [data-tsys-del]').click();
  // 删系统工具是危险操作,走站内确认框(删分类不删工具,所以那条不弹)
  await admin.waitForSelector('.oc-confirm-mask [data-act="ok"]', { timeout: 10000 });
  await admin.click('.oc-confirm-mask [data-act="ok"]');
  await admin.waitForFunction((id) => !document.querySelector('#toolbox-sys-body [data-tsys-item="' + id + '"]'), newId, { timeout: 10000 }).catch(() => {});
  check('后台能删掉一套系统工具', (await admin.locator('#toolbox-sys-body [data-tsys-item]').count()) === 10);
  await admin.click('#toolbox-sys-save');
  const afterDel = await waitSysDoc((d) => ((d.doc && d.doc.items) || []).length === 10);
  check('删除也已落库', ((afterDel.doc && afterDel.doc.items) || []).length === 10,
    ((afterDel.doc && afterDel.doc.items) || []).length);

  // 删分类:里面的工具不被删,归属被明确清掉(而不是留一个指向不存在分类的 id)
  await admin.locator('.tbox-sys-chip', { hasText: '内部工具' }).locator('[data-tsys-cat-del]').click();
  await sleep(300);
  await admin.click('#toolbox-sys-save');
  const afterCatDel = await waitSysDoc((d) => !((d.doc && d.doc.cats) || []).some((c) => c.name === '内部工具'));
  check('删分类后系统工具数量不变', ((afterCatDel.doc && afterCatDel.doc.items) || []).length === 10);
  check('已删分类不再下发', !((afterCatDel.doc && afterCatDel.doc.cats) || []).some((c) => c.name === '内部工具'));

  await admin.close();
}

console.log('\n== 14. 后台系统工具在真浏览器里同样是不透明源 ==');
{
  // 管理员那一份存在同一张表里,打开方式与用户工具完全一样 —— 隔离也得是一样的。
  const doc = await (await fetch(BASE + '/api/admin/toolbox', { headers: AUTH })).json();
  const b64 = ((doc.doc && doc.doc.items) || []).find((x) => x.id === 'base64');
  check('后台接口下发的系统工具带签名地址', !!(b64 && b64.pageUrl && /[?&]sys=1/.test(b64.pageUrl)), b64 && b64.pageUrl);
  const pop = await ctx.newPage();
  await pop.goto(BASE + b64.pageUrl.replace(/^\/+/, '/'), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pop.waitForFunction(() => document.readyState === 'complete', null, { timeout: 10000 }).catch(() => {});
  const info = await pop.evaluate(() => ({
    winOrigin: String(window.origin),
    ls: (() => { try { localStorage.getItem('oc_token'); return 'reachable'; } catch (e) { return 'blocked'; } })(),
    title: document.title,
  }));
  check('内置工具页也是不透明源(window.origin 为 "null")', info.winOrigin === 'null', info.winOrigin);
  check('内置工具页里读不到 localStorage', info.ls === 'blocked', info.ls);
  check('内置工具的脚本照常执行', info.title.length > 0, info.title);
  await pop.close();
}

console.log('\n== 15. 无 JS 异常 ==');
{
  const relevant = pageErrors.filter((e) => /toolbox|tb-|tbox|admin:/i.test(e));
  check('工具箱模块无 JS 异常' + (relevant.length ? ': ' + relevant.slice(0, 2).join(' | ') : ''), relevant.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ 在线工具箱 GUI 自检失败: ${fail} 项` : `✓ 在线工具箱 GUI 自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
