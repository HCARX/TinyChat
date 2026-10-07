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
 * 只有真跑起来才知道它到底被关在什么里。顺带守住落库、乐观并发、删除、窄屏与开关隐藏。
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
  await page.waitForSelector('.tb-card-name', { timeout: 10000 });
  check('保存后回到列表并出现卡片', (await page.locator('.tb-grid').innerText()).includes(TOOL_TITLE));

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
  await page.click('.tb-card-main');
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

  await page.click('#tb-preview-back');
  await page.waitForSelector('#tb-view-editor:not(.hidden)', { timeout: 10000 });
  check('可返回编辑(源码还在)', (await page.locator('#tb-code').inputValue()) === TOOL_HTML);
  await page.click('#tb-preview-run');
  await page.waitForSelector('#tb-view-preview:not(.hidden)', { timeout: 10000 });
  check('编辑器里的内容也能直接跑预览', await page.locator('.tb-frame').count() === 1);
  await page.click('#tb-preview-close');
  await page.waitForSelector('#tb-view-list:not(.hidden)', { timeout: 10000 });
}

console.log('\n== 4. 新标签页:服务端端点(响应头里再上一道沙箱)==');
{
  await page.evaluate(() => {
    window.__tbMsgs = [];
    window.addEventListener('message', (e) => window.__tbMsgs.push({ origin: String(e.origin), data: String(e.data) }));
  });
  await page.click('.tb-card-main');
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
  await page.waitForSelector('.tb-card-name', { timeout: 10000 });
  check('重新加载后卡片还在', (await page.locator('.tb-grid').innerText()).includes(TOOL_TITLE));
  const sub = await page.locator('#tb-sub').innerText();
  check('标题栏统计了条数与体积', /1 个工具/.test(sub) && /KB/.test(sub), sub);
}

console.log('\n== 6. 删除后各设备都会同步移除 ==');
{
  // 先记下这条工具的签名地址:删掉之后它必须变成 404,而不是继续能读
  const before = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
  const removedUrl = before.doc.items[0].pageUrl;
  await page.click('.tb-icon-btn[data-del]');
  await page.waitForSelector('.oc-confirm-mask [data-act="ok"]', { timeout: 10000 });
  await page.click('.oc-confirm-mask [data-act="ok"]');
  await page.waitForFunction(() => !document.querySelector('.tb-card-name'), null, { timeout: 15000 }).catch(() => {});
  check('列表里已移除', (await page.locator('.tb-card-name').count()) === 0);
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
  check('刷新后依然是删掉的状态', (await page.locator('.tb-card-name').count()) === 0);
  check('空箱子给出引导文案', (await page.locator('.tb-grid').innerText()).includes('工具箱还是空的'));
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

console.log('\n== 9. 无 JS 异常 ==');
{
  const relevant = pageErrors.filter((e) => /toolbox|tb-|tbox/i.test(e));
  check('工具箱模块无 JS 异常' + (relevant.length ? ': ' + relevant.slice(0, 2).join(' | ') : ''), relevant.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ 在线工具箱 GUI 自检失败: ${fail} 项` : `✓ 在线工具箱 GUI 自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
