/* 新主题包(方块 / Claude 风格)自检 —— 真 Chromium + 真服务端:
 *   node tests/theme-packs-gui.mjs
 *
 * 为什么必须量计算样式,而不是读 CSS 源码:
 *   主题包用 html[data-oc-theme=...] 前缀提特异性,绝大多数规则能直接压过默认外观;
 *   但 chrome.css 的「字号总表」把正文/输入框/标题钉在 var(--fs) 上,markdown.css
 *   把表格底色、代码块顶栏写成 !important —— 这几处普通声明再高优先级也无效,而失效
 *   的表现只是「看起来没变化」,读代码完全看不出来。所以这里对每一处覆盖都断言最终计算值。
 *
 * 另外两件只有真浏览器才验得了的事:
 *   · 两个主题各自的设计承诺(方块主题「一条分割线都不画」;Claude 主题的暖色纸感);
 *   · 窄屏下的适配 —— 消息内边距、输入框宽度、底部留白都必须跟着变,而这些只在
 *     真实布局里才算得出来。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8291);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8292);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'theme-packs-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? ' —— 实测 ' + d : '')); };
const check = (m, c, detail) => { if (c) ok(m); else bad(m, detail); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 字号一律由 rem/em 换算而来(1.143rem × 14px = 16.002px),不能拿字符串比
const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const near = (a, b, tol = 0.12) => Number.isFinite(num(a)) && Number.isFinite(num(b)) && Math.abs(num(a) - num(b)) <= tol;

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似残留 php -S),请先结束该进程或用 GUI_PORT 换端口`);
  process.exit(1);
}
await assertPortFree(PORT);
await assertPortFree(MOCK_PORT);

async function loadPlaywright() {
  const candidates = [];
  try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未安装 */ }
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
  console.log('(skip) 未找到 playwright,跳过主题包自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-theme-packs-gui-' + Date.now());
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
  console.error('✗ 应用服务未启动\n' + appErr.slice(-1200));
  process.exit(1);
}
await waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/models`);

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'ThemeMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-theme',
    apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));

await page.addInitScript(([token, prov]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_provider', prov);
  localStorage.setItem('oc_model_' + prov, 'mock-model');
}, [login.token, PROV]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForFunction(() => (window.OCApp.state.models || []).length > 0, null, { timeout: 20000 });
await sleep(600);

async function freezeAnimations(p) {
  await p.evaluate(() => {
    if (document.getElementById('zz-noanim')) return;
    const st = document.createElement('style');
    st.id = 'zz-noanim';
    st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(st);
  });
}

// 用应用自己的渲染器造消息:主题只负责样式,DOM 必须是真实结构
async function injectDemo(p) {
  await p.evaluate((md) => {
    const host = document.querySelector('.messages') || document.querySelector('#messages');
    if (!host) return;
    let box = document.getElementById('zz-demo');
    if (!box) { box = document.createElement('div'); box.id = 'zz-demo'; host.appendChild(box); }
    box.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="msg-avatar"></div><div class="msg-content"><div class="md-prose"></div></div>'
      + '<div class="msg-actions"><button class="msg-action">复制</button></div>';
    box.appendChild(el);
    const probe = document.createElement('div');
    probe.className = 'msg user';
    probe.innerHTML = '<div class="msg-avatar"></div><div class="msg-content"><div class="md-prose"></div></div>';
    box.insertBefore(probe, el);
    window.OCRenderer.renderInto(probe.querySelector('.md-prose'), '用户气泡');
    window.OCRenderer.renderInto(el.querySelector('.md-prose'), md);
  }, ['## 二级标题', '', '正文一段,含 `inline` 与 [链接](#)。', '', '> 引用一行。', '',
    '```js', 'const a = 1;', '```', '',
    '| 变量 | 作用 |', '| --- | --- |', '| A | B |', '| C | D |',
    '', '---', ''].join('\n'));
}

const css = (sel, prop) => page.evaluate(([s, p]) => {
  const n = document.querySelector(s);
  return n ? getComputedStyle(n).getPropertyValue(p).trim() : 'MISSING';
}, [sel, prop]);
const box = (sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return null;
  const b = n.getBoundingClientRect();
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) };
}, sel);
// 检测「可见的线」:元素自身任一方向有非零宽度的边框,或 ::after/::before 画出的线。
// 方块主题的全部立论就是「不画分割线」,所以这条要真的去量。
const borderWidths = (sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return 'MISSING';
  const c = getComputedStyle(n);
  const out = {};
  for (const [k, v] of Object.entries({ top: 'borderTopWidth', right: 'borderRightWidth', bottom: 'borderBottomWidth', left: 'borderLeftWidth' })) {
    out[k] = parseFloat(c[v]) || 0;
  }
  return out;
}, sel);

// 发送键在没输入内容时是 disabled + .muted,走的是 --bg-active 而不是主色。
// 要验「主操作色」就必须先把它变成可用态 —— 直接删掉 muted/disabled 再量。
async function primedSendBg(p) {
  return p.evaluate(() => {
    const b = document.getElementById('send-btn');
    if (!b) return 'MISSING';
    b.classList.remove('muted');
    b.disabled = false;
    return getComputedStyle(b).backgroundColor;
  });
}

async function pickTheme(p, id) {
  await p.evaluate(() => { const c = document.querySelector('#account-chip'); if (c) c.click(); });
  await sleep(300);
  await p.evaluate(() => { const b = document.querySelector('#user-menu-theme'); if (b) b.click(); });
  await sleep(500);
  const clicked = await p.evaluate((tid) => {
    const card = document.querySelector('.theme-card[data-theme-id="' + tid + '"]');
    if (!card) return false;
    card.click();
    return true;
  }, id);
  await sleep(400);
  await p.keyboard.press('Escape');
  await sleep(400);
  return clicked;
}

/* ================= 方块主题 ================= */
console.log('== 1. 方块主题:结构与配色 ==');
check('主题市场里能点到 block 卡片', await pickTheme(page, 'block'));
check('html 上写入了 data-oc-theme=block', (await page.evaluate(() => document.documentElement.getAttribute('data-oc-theme'))) === 'block');
const blockHref = await page.evaluate(() => { const l = document.getElementById('oc-theme-pack-css'); return l ? l.getAttribute('href') : ''; });
check('注入了主题样式表', /theme-block\.min\.css/.test(blockHref), blockHref);
check('样式表 URL 带版本号', /\?v=\d/.test(blockHref), blockHref);
check('样式表文件名不含 WAF 关键词', !/chat|paypal|bank|signin|secure/i.test(blockHref), blockHref);

await freezeAnimations(page);
await injectDemo(page);

// 调色板:苹果的 #f5f5f7 画布 / #ffffff 卡片 / #0071e3 蓝
check('画布是浅灰 #f5f5f7(卡片靠色阶差浮起)', (await css('body', 'background-color')) === 'rgb(245, 245, 247)',
  await css('body', 'background-color'));
check('助手卡片是纯白', (await css('.msg.assistant .msg-content', 'background-color')) === 'rgb(255, 255, 255)',
  await css('.msg.assistant .msg-content', 'background-color'));
check('用户气泡是 #e8e8ed', (await css('.msg.user .msg-content', 'background-color')) === 'rgb(232, 232, 237)',
  await css('.msg.user .msg-content', 'background-color'));
const blockBodyFs = await css('.msg.assistant .msg-content', 'font-size');
// 正文字号 = 用户设的 --fs × 本主题的 --msg-scale(方块主题 0.96)。
// 以前这里断言「15px」,那是把主题里写死的 1.071rem 当成期望值 ——
// 结果就是「外观→字号」选 14px,正文却是 15px。字号必须以设置为准。
check('正文按「字号」设置缩放(14px × 0.96 ≈ 13.4px,不再写死 15px)', near(blockBodyFs, 14 * 0.96, 0.4), blockBodyFs);

console.log('== 2. 方块主题:一条分割线都不画 ==');
// 这是本主题的核心承诺。逐条量可能被上游规则画线的地方。
check('侧栏竖线已去掉(sidebar::after)', (await page.evaluate(() => {
  const n = document.querySelector('.sidebar');
  if (!n) return 'MISSING';
  const a = getComputedStyle(n, '::after');
  return a.display === 'none' || a.width === '0px' || a.content === 'none';
})) === true);
check('消息区水平分割线已去掉(hr 隐藏)', (await css('.msg.assistant .md-prose hr', 'display')) === 'none',
  await css('.msg.assistant .md-prose hr', 'display'));
check('表格没有行线', ((await borderWidths('.msg.assistant .md-prose .table-wrap table td')).top || 0) === 0,
  JSON.stringify(await borderWidths('.msg.assistant .md-prose .table-wrap table td')));
check('代码块顶栏没有底边线', (await css('.msg.assistant .md-prose .code-block .code-header', 'border-bottom-width')) === '0px',
  await css('.msg.assistant .md-prose .code-block .code-header', 'border-bottom-width'));
check('助手卡片没有描边', ((await borderWidths('.msg.assistant .msg-content')).left || 0) === 0,
  JSON.stringify(await borderWidths('.msg.assistant .msg-content')));
check('输入框没有描边', ((await borderWidths('.composer')).left || 0) === 0,
  JSON.stringify(await borderWidths('.composer')));
check('表格表头是填充色块(不是靠线分区)', (await css('.msg.assistant .md-prose .table-wrap table th', 'background-color')) !== 'rgba(0, 0, 0, 0)',
  await css('.msg.assistant .md-prose .table-wrap table th', 'background-color'));
check('引用块是内嵌色块而非左侧竖线', (await css('.msg.assistant .md-prose blockquote', 'border-left-width')) === '0px'
  && (await css('.msg.assistant .md-prose blockquote', 'background-color')) !== 'rgba(0, 0, 0, 0)',
  'border-left=' + (await css('.msg.assistant .md-prose blockquote', 'border-left-width'))
  + ' bg=' + (await css('.msg.assistant .md-prose blockquote', 'background-color')));

console.log('== 3. 方块主题:圆角与投影 ==');
const blockRadius = await css('.msg.assistant .msg-content', 'border-radius');
check('助手卡片是大圆角(20px)', blockRadius === '20px', blockRadius);
const blockShadow = await css('.msg.assistant .msg-content', 'box-shadow');
check('助手卡片有浅投影(浮起感靠它而不是描边)', blockShadow !== 'none' && blockShadow !== '', blockShadow);
check('助手不带头像(整块矩形轮廓)', (await css('.msg.assistant .msg-avatar', 'display')) === 'none');
// 助手正文必须顶到卡片内缘,不能有头像留下的缩进
const cardBox = await box('.msg.assistant .msg-content');
const proseBox = await box('.msg.assistant .md-prose');
check('助手正文顶到卡片内缘(无头像缩进)',
  Math.abs(proseBox.x - (cardBox.x + num(await css('.msg.assistant .msg-content', 'padding-left')))) <= 1,
  proseBox.x + ' vs ' + (cardBox.x + num(await css('.msg.assistant .msg-content', 'padding-left'))));
check('用户气泡右对齐', (await box('.msg.user .msg-content')).right >= 0);

console.log('== 4. 方块主题:深色调色板 ==');
await injectDemo(page);
await page.evaluate(() => window.OCUI.applyTheme('dark'));
await sleep(500);
check('深色画布是纯黑', (await css('body', 'background-color')) === 'rgb(0, 0, 0)',
  await css('body', 'background-color'));
check('深色助手卡片 #1c1c1e', (await css('.msg.assistant .msg-content', 'background-color')) === 'rgb(28, 28, 30)',
  await css('.msg.assistant .msg-content', 'background-color'));
check('深色卡片仍有可见投影', (await css('.msg.assistant .msg-content', 'box-shadow')) !== 'none');
check('深色下表格表头仍是填充色块', (await css('.msg.assistant .md-prose .table-wrap table th', 'background-color')) !== 'rgba(0, 0, 0, 0)');
await page.evaluate(() => window.OCUI.applyTheme('light'));
await sleep(400);

console.log('== 5. 方块主题:窄屏适配 ==');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(600);
const bComposer = await box('.composer');
check('窄屏输入框不溢出', bComposer.w <= 390, JSON.stringify(bComposer));
const bCard = await box('.msg.assistant .msg-content');
check('窄屏助手卡片不溢出', bCard.w <= 390 && bCard.x >= 0, JSON.stringify(bCard));
// 390px 同时命中主题的 768px 与 560px 两档,后写的 560px 档生效(10px)。
// 这条要防的是「窄屏还用桌面端 26px 内边距、正文被挤成窄柱」,所以断言落在窄值上。
const bPadL = num(await css('.messages', 'padding-left'));
check('窄屏消息内边距收窄到窄屏档(10px,不是桌面端 26px)', bPadL === 10, String(bPadL));
check('窄屏助手卡片圆角降到 18px', (await css('.msg.assistant .msg-content', 'border-radius')) === '18px',
  await css('.msg.assistant .msg-content', 'border-radius'));
// 窄屏输入框更高,按钮若不跟着上移就会糊在圆角上
const bBtnGapM = await page.evaluate(() => {
  const b = document.querySelector('#scroll-bottom-btn'), c = document.querySelector('.composer');
  if (!b || !c) return null;
  return Math.round(c.getBoundingClientRect().top - b.getBoundingClientRect().bottom);
});
check('窄屏回到底部按钮仍在输入框上方且有余量', bBtnGapM !== null && bBtnGapM >= 6, 'btnGap=' + bBtnGapM);
check('窄屏下仍无分割线(表格行线)', ((await borderWidths('.msg.assistant .md-prose .table-wrap table td')).top || 0) === 0);
await page.setViewportSize({ width: 1280, height: 900 });
await sleep(500);

/* ================= Claude 主题 ================= */
console.log('== 6. Claude 主题:暖色纸感配色 ==');
check('主题市场里能点到 claude 卡片', await pickTheme(page, 'claude'));
check('html 上写入了 data-oc-theme=claude', (await page.evaluate(() => document.documentElement.getAttribute('data-oc-theme'))) === 'claude');
const claudeHref = await page.evaluate(() => { const l = document.getElementById('oc-theme-pack-css'); return l ? l.getAttribute('href') : ''; });
check('注入了主题样式表', /theme-claude\.min\.css/.test(claudeHref), claudeHref);
check('样式表文件名不含 WAF 关键词', !/chat|paypal|bank|signin|secure/i.test(claudeHref), claudeHref);

await freezeAnimations(page);
await injectDemo(page);

check('画布是暖米白 #faf9f5', (await css('body', 'background-color')) === 'rgb(250, 249, 245)',
  await css('body', 'background-color'));
check('侧栏是暖灰 #f0eee6', (await css('.sidebar', 'background-color')) === 'rgb(240, 238, 230)',
  await css('.sidebar', 'background-color'));
check('用户气泡是 #f0eee6', (await css('.msg.user .msg-content', 'background-color')) === 'rgb(240, 238, 230)',
  await css('.msg.user .msg-content', 'background-color'));
check('正文是暖黑 #1f1e1d', (await css('.msg.assistant .msg-content', 'color')) === 'rgb(31, 30, 29)',
  await css('.msg.assistant .msg-content', 'color'));
const claudeBodyFs = await css('.msg.assistant .msg-content', 'font-size');
// 同方块主题:字号跟着「外观→字号」走,主题只给一个相对倍数(0.98)。
// 以前写死 1.143rem,用户选 14px 实际渲染 16px,设置和看到的不一致。
check('正文按「字号」设置缩放(14px × 0.98 ≈ 13.7px,不再写死 16px)', near(claudeBodyFs, 14 * 0.98, 0.4), claudeBodyFs);

console.log('== 7. Claude 主题:助手整栏通排 + 陶土橙主操作 ==');
check('助手不带头像', (await css('.msg.assistant .msg-avatar', 'display')) === 'none');
check('助手正文没有气泡底色(直接落在画布上)',
  (await css('.msg.assistant .msg-content', 'background-color')) === 'rgba(0, 0, 0, 0)',
  await css('.msg.assistant .msg-content', 'background-color'));
// 主操作色:浅色是 #c96442
const cSendBg = await primedSendBg(page);
check('发送键是陶土橙 #c96442', cSendBg === 'rgb(201, 100, 66)', cSendBg);
// 链接用 Claude 的强调蓝 #6a9bcc
const linkColor = await page.evaluate(() => {
  const p = document.querySelector('.msg.assistant .md-prose');
  if (!p) return 'MISSING';
  let a = p.querySelector('a.zz-link');
  if (!a) { a = document.createElement('a'); a.className = 'zz-link'; a.href = '#'; a.textContent = 'x'; p.appendChild(a); }
  return getComputedStyle(a).color;
});
check('链接用强调蓝 #6a9bcc', linkColor === 'rgb(106, 155, 204)', linkColor);
check('侧栏竖线已去掉', (await page.evaluate(() => {
  const n = document.querySelector('.sidebar');
  if (!n) return 'MISSING';
  const a = getComputedStyle(n, '::after');
  return a.display === 'none' || a.width === '0px' || a.content === 'none';
})) === true);

console.log('== 8. Claude 主题:宽扁两行式输入框 ==');
await page.evaluate(() => window.startAssistantChat({ id: 'as-theme', name: '主题自检', prompt: '你是主题自检助手。' }));
await sleep(800);
check('已选中助手,@ 行出现', !!(await box('.composer-at-row')), JSON.stringify(await box('.composer-at-row')));
const cFlow = await box('.composer-flow');
const cLeft = await box('.composer-left');
const cRight = await box('.composer-right');
const cWrap = await box('.composer-wrap');
const cCard = await box('.composer');
check('输入行在上、工具行在下(两行式)', cLeft.y >= cFlow.bottom - 2, cLeft.y + ' vs ' + cFlow.bottom);
// 发送键贴着的是「输入框卡片」的右下角,所以基准取 .composer。
// (.composer-wrap 还含 12px 的左右留白,拿它当基准会把这 12px 算成偏差)
check('发送键在输入框右下角', cRight.y >= cFlow.bottom - 2 && Math.abs(cRight.right - (cCard.x + cCard.w)) <= 20,
  JSON.stringify(cRight) + ' vs composer.right=' + (cCard.x + cCard.w));
check('输入框与消息列同宽', cWrap.w && (await box('.messages')).w && Math.abs(cWrap.w - (await box('.messages')).w) <= 1,
  cWrap.w + ' vs ' + (await box('.messages')).w);
check('输入框是中等圆角 16px(不是胶囊)', (await css('.composer', 'border-radius')) === '16px',
  await css('.composer', 'border-radius'));
// 输入框不描边:它是一块比暖米白画布更亮的白纸,边界靠柔和投影读出来。
// 之前断言的是「有一条 1px 描边」——本轮把描边去掉,改用投影,断言随之反转。
check('输入框没有描边(靠暖调柔和投影浮起)',
  ((await borderWidths('.composer')).left || 0) === 0 && ((await borderWidths('.composer')).top || 0) === 0,
  JSON.stringify(await borderWidths('.composer')));
check('输入框有投影(无描边时靠它定义边界)', (await css('.composer', 'box-shadow')) !== 'none',
  await css('.composer', 'box-shadow'));
check('消息区底部留白已让开变高的输入框', (await css('.chat-area', 'padding-bottom')) === '186px',
  await css('.chat-area', 'padding-bottom'));
check('回到底部按钮在输入框上方(留有余量,不是贴着)', (await css('.scroll-bottom-btn', 'bottom')) === '182px',
  await css('.scroll-bottom-btn', 'bottom'));
const cTaFs = await css('.composer textarea', 'font-size');
check('输入字号与正文一致', near(cTaFs, num(claudeBodyFs)), cTaFs);
check('@ 行高度与输入框首行行高一致',
  near(await css('.composer-at-row', 'height'), await css('.composer textarea', 'line-height')),
  (await css('.composer-at-row', 'height')) + ' vs ' + (await css('.composer textarea', 'line-height')));
check('输入行高度 = textarea 高度(多出来的空白会把文字顶偏)',
  Math.abs((await box('.composer-flow')).h - (await box('.composer textarea')).h) <= 0.5,
  (await box('.composer-flow')).h + ' vs ' + (await box('.composer textarea')).h);

console.log('== 9. Claude 主题:深色调色板 ==');
await injectDemo(page);
await page.evaluate(() => window.OCUI.applyTheme('dark'));
await sleep(500);
check('深色画布是暖黑 #262624', (await css('body', 'background-color')) === 'rgb(38, 38, 36)',
  await css('body', 'background-color'));
check('深色侧栏 #1f1e1d', (await css('.sidebar', 'background-color')) === 'rgb(31, 30, 29)',
  await css('.sidebar', 'background-color'));
check('深色正文是暖白 #f5f4ef', (await css('.msg.assistant .msg-content', 'color')) === 'rgb(245, 244, 239)',
  await css('.msg.assistant .msg-content', 'color'));
const cDarkSendBg = await primedSendBg(page);
check('深色主操作橙 #d97757', cDarkSendBg === 'rgb(217, 119, 87)', cDarkSendBg);
await page.evaluate(() => window.OCUI.applyTheme('light'));
await sleep(400);

console.log('== 10. Claude 主题:窄屏适配 ==');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(600);
check('窄屏仍是两行式', (await box('.composer-left')).y >= (await box('.composer-flow')).bottom - 2,
  (await box('.composer-left')).y + ' vs ' + (await box('.composer-flow')).bottom);
// 同方块主题:390px 命中 560px 档(190/172),不是 768px 档(196/178)
check('窄屏底部留白 190px(560px 档)', (await css('.chat-area', 'padding-bottom')) === '190px', await css('.chat-area', 'padding-bottom'));
check('窄屏回到底部按钮 172px(560px 档)', (await css('.scroll-bottom-btn', 'bottom')) === '172px',
  await css('.scroll-bottom-btn', 'bottom'));
// 留白必须真的让开了输入框:最后一条消息的底边不能被输入框盖住
const cMsg = await box('.messages');
const cComp = await box('.composer-area');
check('底部留白大于输入区高度(最后一条消息不被压住)',
  num(await css('.chat-area', 'padding-bottom')) >= cComp.h - 10,
  (await css('.chat-area', 'padding-bottom')) + ' vs 输入区高 ' + cComp.h);
check('窄屏输入框不溢出', (await box('.composer')).w <= 390, JSON.stringify(await box('.composer')));
check('窄屏用户气泡不溢出', (await box('.msg.user .msg-content')).w <= 390);
const cBtnGapM = await page.evaluate(() => {
  const b = document.querySelector('#scroll-bottom-btn'), c = document.querySelector('.composer');
  if (!b || !c) return null;
  return Math.round(c.getBoundingClientRect().top - b.getBoundingClientRect().bottom);
});
check('窄屏回到底部按钮仍在输入框上方且有余量(不是贴着圆角)', cBtnGapM !== null && cBtnGapM >= 6, 'btnGap=' + cBtnGapM);
await page.setViewportSize({ width: 1280, height: 900 });
await sleep(500);

/* ================= 细节回归:这几条都是实测踩过的坑 ================= */
// 每一条都对应一个真实发生过的缺陷,断言里带上「量出来的数」,不是照着 CSS 抄的期望值。
// 上一节停在 Claude 主题,这里必须显式切回方块,否则下面的「方块主题」断言其实在量 Claude。
console.log('== 11. 方块主题:细节回归(踩过的坑) ==');
check('切回方块主题', await pickTheme(page, 'block'));
check('data-oc-theme 回到 block', (await page.evaluate(() => document.documentElement.getAttribute('data-oc-theme'))) === 'block');
await injectDemo(page);
await sleep(300);

// --- 11.1 引用块里那根 ::before 装饰竖条 ---
// 默认外观的引用块靠 markdown.css 的 ::before 画一根 3px 竖条。三个主题都不用「线」:
// 方块与 Claude 做成内嵌/底衬色块,GPT 改成只靠缩进与颜色。只把 border-left 归零是压不住
// 伪元素的 —— 它是独立一层,会变成浮在色块里的浅蓝竖线,或与主题自己的线并排成两条。
const bqBefore = (p) => p.evaluate(() => {
  const n = document.querySelector('.msg.assistant .md-prose blockquote');
  if (!n) return 'MISSING';
  const c = getComputedStyle(n, '::before');
  return { content: c.content, width: c.width, display: c.display, bg: c.backgroundColor };
});
const bqLine = (sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return 'MISSING';
  const c = getComputedStyle(n);
  return { left: parseFloat(c.borderLeftWidth) || 0, bg: c.backgroundColor, radius: c.borderRadius };
}, sel);

check('方块主题:引用块 ::before 装饰条已撤掉(不是留着一条浅蓝竖线)',
  (await bqBefore(page)).content === 'none' || parseFloat((await bqBefore(page)).width) === 0,
  JSON.stringify(await bqBefore(page)));
const bqBlock = await bqLine('.msg.assistant .md-prose blockquote');
check('方块主题:引用块是圆角色块、没有左边线(不会出现两条线并排)',
  bqBlock.left === 0 && bqBlock.bg !== 'rgba(0, 0, 0, 0)' && num(bqBlock.radius) > 0,
  JSON.stringify(bqBlock));

// --- 11.2 消息区底部留白 / 回到底部按钮 ---
// .composer-area 是 position:absolute;bottom:0,靠 .chat-area 的 padding-bottom 让它「悬浮在
// 留白里」。这里曾被写成 padding 简写(把 padding-bottom 一起归零),最后一条消息直接被输入框压住。
// 「按钮压住输入框」要拿 **.composer**(真正的输入框圆角块)比,不能拿 .composer-area ——
// 后者是整个底部区域的容器,padding-top 有 24px,拿它比永远算出负数。
const composerClear = async () => {
  const ca = await box('.chat-area');
  const cp = await box('.composer-area');
  const com = await box('.composer');
  const btn = await box('.scroll-bottom-btn');
  return {
    pad: num(await css('.chat-area', 'padding-bottom')),
    // 留白至少要让开输入区高度,否则最后一条消息压在输入框下面
    slack: Math.round(ca.bottom - cp.y),
    btnGap: btn && com ? Math.round(com.y - btn.bottom) : null,
  };
};
const bClear = await composerClear();
check('方块主题:消息区底部留白不为 0(padding 简写踩过的坑)', bClear.pad > 100, String(bClear.pad));
check('方块主题:留白让开了输入区(最后一条消息不被压住)', bClear.slack >= 0,
  'slack=' + bClear.slack + ' pad=' + bClear.pad);
check('方块主题:回到底部按钮停在输入框上方且有余量(不是贴着圆角)', bClear.btnGap !== null && bClear.btnGap >= 6,
  'btnGap=' + bClear.btnGap);

// --- 11.3 blockquote 之外的「不画线」承诺在窄屏也成立 ---
// --- 11.4 后台输入框在方块主题下不能白底白字 ---
// 方块主题把 .field input 的背景设成卡片白、边框设成透明。后台的输入框原本靠一条浅描边
// 跟白卡片区分,边框一透明 + 背景同白,整个字段就「消失」了 —— 只剩标签浮在上面。
const beforeStyle = await page.evaluate(() => {
  const i = document.querySelector('.admin-card input:not([type=checkbox]):not([type=radio]), .field input:not([type=checkbox]):not([type=radio])');
  if (!i) return null;
  const c = getComputedStyle(i);
  const card = i.closest('.admin-card, .field, .card');
  return {
    bg: c.backgroundColor, border: c.borderTopColor, bw: parseFloat(c.borderTopWidth) || 0,
    cardBg: card ? getComputedStyle(card).backgroundColor : null,
  };
});
if (beforeStyle && beforeStyle.cardBg) {
  check('方块主题:表单输入框与所在卡片有明显区分(不会白底白字看不见)',
    beforeStyle.bg !== beforeStyle.cardBg || beforeStyle.bw > 0,
    JSON.stringify(beforeStyle));
}

console.log('== 12. Claude 主题:细节回归 ==');
check('切到 Claude 主题', await pickTheme(page, 'claude'));
await injectDemo(page);
await sleep(300);
const bqBeforeC = await bqBefore(page);
check('Claude 主题:引用块 ::before 装饰条已撤掉(不是留着一条线)',
  bqBeforeC.content === 'none' || parseFloat(bqBeforeC.width) === 0, JSON.stringify(bqBeforeC));
// Claude 的引用块本轮从「左侧竖线 + 无底色」改成「暖色圆角底衬」——
// 竖线属于「有框线的矩形」,改用底色后与整体语言一致,断言随之更新。
const bqC = await bqLine('.msg.assistant .md-prose blockquote');
check('Claude 主题:引用块是暖色圆角底衬、没有左侧竖线',
  bqC.left === 0 && bqC.bg !== 'rgba(0, 0, 0, 0)' && num(bqC.radius) > 0, JSON.stringify(bqC));
check('Claude 主题:输入框没有描边(改用投影)',
  ((await borderWidths('.composer')).left || 0) === 0, JSON.stringify(await borderWidths('.composer')));
check('Claude 主题:侧栏没有右边线',
  ((await borderWidths('.sidebar')).right || 0) === 0, JSON.stringify(await borderWidths('.sidebar')));
check('Claude 主题:表格没有外框',
  ((await borderWidths('.msg.assistant .md-prose .table-wrap')).left || 0) === 0,
  JSON.stringify(await borderWidths('.msg.assistant .md-prose .table-wrap')));
const cClear = await composerClear();
check('Claude 主题:消息区底部留白让开了变高的输入区', cClear.pad >= (await box('.composer-area')).h - 10,
  cClear.pad + ' vs 输入区高 ' + (await box('.composer-area')).h);
check('Claude 主题:回到底部按钮停在输入框上方且有余量', cClear.btnGap !== null && cClear.btnGap >= 6,
  'btnGap=' + cClear.btnGap);
// 表头 padding-top 置 0 时,表头文字顶到表格上边缘,与表体每格 10px 的竖向节奏对不上
const thPad = num(await css('.msg.assistant .md-prose .table-wrap table th', 'padding-top'));
check('Claude 主题:表头有上边距(与表体的竖向节奏对齐)', thPad > 0, String(thPad));

/* ================= 侧栏「左方间距」与对话列宽度 =================
 * 这两条都是用户实测报上来的:
 *   1) 侧栏每行各自写 padding,同一列里排出好几种文字左边缘,看着就是没对齐;
 *      而且四个主题都各写各的 —— 主题越多越乱。
 *   2) 「调整对话页宽度」对默认之外的主题不生效:它们把 max-width 写死成 px,
 *      拖拽改的 --content-w 没人读。
 * 这里按「同一主题内所有行只能有一个文字左边缘」和「--content-w 改了宽度就得跟着变」
 * 两条不变量来断言,而不是照抄某几个 padding 数值 —— 以后调数值不会误报。 */
console.log('== 13. 侧栏左边缘统一 + 对话列宽度对四套主题都生效 ==');

const SIDEBAR_ROWS = [
  '.new-chat-btn', '.sidebar-model-wrap .assistant-lib-btn', '.sidebar-model-wrap .model-picker',
  '.chat-search', '.chat-group', '.chat-item', '.account-chip',
];
// 取每行「第一个有文字的节点」的真实左边缘(盒子的左边缘不含内边距,量不出错位)
const textLefts = () => page.evaluate((sels) => {
  const out = [];
  for (const s of sels) {
    const n = document.querySelector(s);
    if (!n || n.offsetParent === null) continue;
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    let left = null;
    while (w.nextNode()) {
      const t = w.currentNode;
      if (!t.nodeValue || !t.nodeValue.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(t);
      const rects = r.getClientRects();
      if (rects.length) { left = Math.round(rects[0].left * 10) / 10; break; }
    }
    if (left !== null) out.push({ sel: s, left });
  }
  return out;
}, SIDEBAR_ROWS);

async function measureWidths() {
  return page.evaluate(() => {
    const msgs = document.querySelector('.messages');
    const wrap = document.querySelector('.composer-wrap');
    const area = document.querySelector('.chat-area');
    const r = (el) => (el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : NaN);
    return {
      cw: getComputedStyle(document.documentElement).getPropertyValue('--content-w').trim(),
      mainW: r(area), msgW: r(msgs), wrapW: r(wrap),
      msgPct: area ? Math.round((msgs.getBoundingClientRect().width / area.getBoundingClientRect().width) * 1000) / 10 : NaN,
    };
  });
}

for (const theme of ['default', 'chatgpt', 'block', 'claude']) {
  if (theme !== 'default') check('切到 ' + theme, await pickTheme(page, theme));
  await injectDemo(page);
  // 侧栏要有会话项/分组标题才量得到那两行
  const rows = await textLefts();
  check(theme + ': 侧栏各行都量到了文字', rows.length >= 5, '量到 ' + rows.length + ' 行');
  const uniq = [...new Set(rows.map((r) => r.left))];
  check(theme + ': 侧栏只有一条文字左边缘',
    uniq.length === 1, JSON.stringify(rows));

  // 对话列宽度:默认 61.8%,且消息列与输入栏同宽(两者容器基准必须一致)
  const a = await measureWidths();
  check(theme + ': 对话列默认 61.8%', a.msgPct > 58 && a.msgPct < 66, 'msgPct=' + a.msgPct);
  check(theme + ': 输入栏与消息列同宽', Math.abs(a.msgW - a.wrapW) < 1.5, a.msgW + ' vs ' + a.wrapW);

  // 改 --content-w 宽度必须跟着变(写死 px 的主题在这里会露馅)
  const narrowed = await page.evaluate(async () => {
    document.documentElement.style.setProperty('--content-w', '50%');
    await new Promise((r) => requestAnimationFrame(r));
    const msgs = document.querySelector('.messages');
    const area = document.querySelector('.chat-area');
    return Math.round((msgs.getBoundingClientRect().width / area.getBoundingClientRect().width) * 1000) / 10;
  });
  check(theme + ': 改 --content-w 宽度真的跟着变', narrowed > 48 && narrowed < 53, '50% -> ' + narrowed + '%');
  await page.evaluate(() => document.documentElement.style.removeProperty('--content-w'));

  // 「外观→字号」必须是正文的唯一基准:改成 22px 正文就得跟着变,
  // 主题只允许用一个固定倍数微调。此前主题写死 font-size:1.143rem,
  // 用户选 14px 实际渲染 16px —— 设置和看到的不一致(用户报过)。
  const fsProbe = await page.evaluate(async () => {
    const before = parseFloat(getComputedStyle(document.querySelector('.msg.assistant .msg-content')).fontSize);
    document.documentElement.style.setProperty('--fs', '22px');
    await new Promise((r) => requestAnimationFrame(r));
    const after = parseFloat(getComputedStyle(document.querySelector('.msg.assistant .msg-content')).fontSize);
    document.documentElement.style.removeProperty('--fs');
    return { before, after };
  });
  check(theme + ': 正文随「字号」设置变化', fsProbe.after > fsProbe.before * 1.3,
    fsProbe.before + 'px -> ' + fsProbe.after + 'px');
  // 默认 14px 下,正文不应偏离 14px 太多(主题只做小幅相对调整,而不是换一个绝对字号)
  const fsBase = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.msg.assistant .msg-content')).fontSize));
  check(theme + ': 字号设置 14px 时正文接近 14px(不是写死的 16px)', fsBase > 12.5 && fsBase < 15.5, fsBase + 'px');

  // 操作条必须常驻:默认外观是常驻的,主题不能把它改成悬停才出现(用户报过方块主题"按钮没了")
  await page.mouse.move(1100, 40);   // 先把鼠标移开,排除 hover 影响
  await sleep(350);
  const actOpacity = await page.evaluate(() => {
    const n = document.querySelector('.msg.assistant .msg-actions');
    return n ? getComputedStyle(n).opacity : 'MISSING';
  });
  check(theme + ': 消息操作条常驻(不悬停也可见)', actOpacity === '1', 'opacity=' + actOpacity);
}

check('切回默认主题', await pickTheme(page, 'default'));

/* ================= 收尾 ================= */
console.log('== 14. 切回默认主题:一切原样还原 ==');
check('能切回默认主题', await pickTheme(page, 'default'));
check('data-oc-theme 回到 default', (await page.evaluate(() => document.documentElement.getAttribute('data-oc-theme'))) === 'default');
check('主题样式表已移除', !(await page.evaluate(() => !!document.getElementById('oc-theme-pack-css'))));
await injectDemo(page);
check('头像恢复显示', (await css('.msg.assistant .msg-avatar', 'display')) === 'flex', await css('.msg.assistant .msg-avatar', 'display'));
check('正文字号回到 14px', (await css('.msg.assistant .msg-content', 'font-size')) === '14px', await css('.msg.assistant .msg-content', 'font-size'));
check('输入框回到单行', (await css('.composer', 'flex-wrap')) === 'nowrap', await css('.composer', 'flex-wrap'));
check('侧栏恢复冷灰(不再是暖米白)', (await css('.sidebar', 'background-color')) !== 'rgb(240, 238, 230)',
  await css('.sidebar', 'background-color'));
// 两个主题都把「助手气泡」改成了自己的形态(方块=白卡片、Claude=透明通排),
// 切回默认后必须回到默认外观的「透明气泡 + 头像缩进」组合
check('助手气泡恢复默认(透明底)', (await css('.msg.assistant .msg-content', 'background-color')) === 'rgba(0, 0, 0, 0)',
  await css('.msg.assistant .msg-content', 'background-color'));
check('助手卡片投影已撤掉', (await css('.msg.assistant .msg-content', 'box-shadow')) === 'none',
  await css('.msg.assistant .msg-content', 'box-shadow'));
check('消息区留白回到 132px', (await css('.chat-area', 'padding-bottom')) === '132px',
  await css('.chat-area', 'padding-bottom'));
check('操作条恢复常驻', (await css('.msg.assistant .msg-actions', 'opacity')) === '1');
// 反向保护:两个主题把引用块的 ::before 装饰条撤掉了,默认外观必须还在 ——
// 若哪天有人把这条规则写到了公共选择器上,默认外观会静默丢掉自己的设计。
const bqDef = await bqBefore(page);
check('默认外观的引用块 ::before 装饰条仍在(主题的覆盖没有外泄)',
  bqDef.content !== 'none' && parseFloat(bqDef.width) > 0, JSON.stringify(bqDef));

check('无页面 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + (fail === 0 ? '✓ 新主题包自检通过' : '✗ 新主题包自检未通过') + `(通过 ${pass},失败 ${fail})`);
process.exit(fail === 0 ? 0 : 1);
