/* ChatGPT 主题包(theme-gpt.css)自检 —— 真 Chromium + 真服务端:
 *   node tests/theme-gpt-gui.mjs
 *
 * 为什么必须量计算样式,而不是读 CSS 源码:
 *   主题包用 html[data-oc-theme="chatgpt"] 前缀提特异性,绝大多数规则能直接压过默认
 *   外观;但 chrome.css 的「字号总表」把正文/输入框/标题钉在 var(--fs) 上,markdown.css
 *   把表格底色、代码块顶栏写成 !important —— 这几处普通声明再高优先级也无效,而失效
 *   的表现只是「看起来没变化」,读代码完全看不出来(本主题初版有 5 处这样静默失效)。
 *   所以这里对每一处覆盖都断言最终计算值。
 *
 * 另外两件只有真浏览器才验得了的事:
 *   · 切回默认主题后所有取值必须原样还原 —— 主题包只能在自己被选中时生效;
 *   · 输入框改成两行式后,消息列与输入框必须同宽、底部留白与「回到底部」按钮同步
 *     上移(输入框是绝对定位悬浮在消息区之上的,不同步会压住最后一条消息)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8271);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8272);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'theme-gpt-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? ' —— 实测 ' + d : '')); };
const check = (m, c, detail) => { if (c) ok(m); else bad(m, detail); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 字号一律由 rem/em 换算而来(1.143rem × 14px = 16.002px),不能拿字符串比
const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const near = (a, b, tol = 0.06) => Number.isFinite(num(a)) && Number.isFinite(num(b)) && Math.abs(num(a) - num(b)) <= tol;

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

const TMP = join(tmpdir(), 'tc-theme-gpt-gui-' + Date.now());
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

// 过渡会在面板被节流时卡在起始值上,量之前先关掉动画,量到的才是稳定态
async function freezeAnimations(p) {
  await p.evaluate(() => {
    if (document.getElementById('zz-noanim')) return;
    const st = document.createElement('style');
    st.id = 'zz-noanim';
    st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(st);
  });
}

// 用应用自己的渲染器造一条助手消息:主题只负责样式,DOM 必须是真实结构
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
    '| 变量 | 作用 |', '| --- | --- |', '| A | B |', '| C | D |'].join('\n'));
}

const css = (sel, prop) => page.evaluate(([s, p]) => {
  const n = document.querySelector(s);
  return n ? getComputedStyle(n).getPropertyValue(p).trim() : 'MISSING';
}, [sel, prop]);
const box = (sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return null;
  const b = n.getBoundingClientRect();
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) };
}, sel);
// 元素四边各自的实际边框宽度。本轮打磨的核心是「拒绝一切有框线的矩形」,
// 所以不能只看 border-radius / 颜色 —— 要逐边量出边框是否真的为 0。
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

// 走真实入口切主题:用户菜单 → 主题市场 → 点卡片
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

console.log('== 1. 从主题市场切到 chatgpt ==');
check('主题市场里能点到 chatgpt 卡片', await pickTheme(page, 'chatgpt'));
check('html 上写入了 data-oc-theme=chatgpt', (await page.evaluate(() => document.documentElement.getAttribute('data-oc-theme'))) === 'chatgpt');
const href = await page.evaluate(() => { const l = document.getElementById('oc-theme-pack-css'); return l ? l.getAttribute('href') : ''; });
check('注入了主题样式表', /theme-gpt\.min\.css/.test(href), href);
check('样式表 URL 带版本号', /\?v=\d/.test(href), href);
// 免费虚拟主机的边缘 WAF 会拦 URL 含 chat 的静态资源,文件名必须绕开
check('样式表文件名不含 WAF 关键词', !/chat|paypal|bank|signin|secure/i.test(href), href);

await freezeAnimations(page);
await injectDemo(page);

console.log('== 2. 正文排版:覆盖必须真的生效(被上游 !important 钉住的几处)==');
const bodyFs = await css('.msg.assistant .msg-content', 'font-size');
// 正文不再写死 16px:主题只给相对倍数(--msg-scale = 0.98),
// 基准始终是用户在「外观→字号」里的选择(这里注入的默认是 14px)。
// 写死绝对值会让设置里的 14px 实际渲染成 16px,用户看到的和设置对不上。
check('正文按「字号」设置缩放(14px × 0.98 ≈ 13.7px,不写死 16px)', near(bodyFs, 14 * 0.98, 0.4), bodyFs);
const h2Fs = await css('.msg.assistant .md-prose h2', 'font-size');
check('二级标题 20px', near(h2Fs, 20), h2Fs);
const bodyLh = await css('.msg.assistant .msg-content', 'line-height');
check('行高 1.75', near(bodyLh, num(bodyFs) * 1.75), bodyLh);
check('助手不带头像(整栏通排)', (await css('.msg.assistant .msg-avatar', 'display')) === 'none');
const flow = await box('.msg.assistant .msg-content');
const messagesBox = await box('.messages');
const messagesPadL = await css('.messages', 'padding-left');
check('助手正文顶到内容栏左缘(无头像缩进)',
  near(flow.x, messagesBox.x + num(messagesPadL), 1), flow.x + ' vs ' + (messagesBox.x + num(messagesPadL)));
check('用户气泡是大圆角气泡', (await css('.msg.user .msg-content', 'border-radius')) === '22px',
  await css('.msg.user .msg-content', 'border-radius'));

console.log('== 3. 表格 / 代码块 / 引用:编辑风,不是卡片风 ==');
check('表头底色透明(markdown.css 是 !important)', (await css('.msg.assistant .md-prose .table-wrap table th', 'background-color')) === 'rgba(0, 0, 0, 0)',
  await css('.msg.assistant .md-prose .table-wrap table th', 'background-color'));
check('偶数行无斑马纹', (await css('.msg.assistant .md-prose .table-wrap table tbody tr:nth-child(even) td', 'background-color')) === 'rgba(0, 0, 0, 0)');
check('表格首列贴齐正文左缘', (await css('.msg.assistant .md-prose .table-wrap table td:first-child', 'padding-left')) === '0px');
const tableFs = await css('.msg.assistant .md-prose .table-wrap table', 'font-size');
check('表格字号跟随正文', near(tableFs, num(bodyFs)), tableFs);
check('代码块顶栏不是深灰药丸', (await css('.msg.assistant .md-prose .code-block .code-header', 'background-color')) !== 'rgba(0, 0, 0, 0)');
// 顶栏与代码之间不画横线:两者底色差一档(tint 4%),靠色阶就能分开。
// 之前断言的是「有一条 1px 底线」——那正是「有框线的矩形」,与本次打磨的方向相反。
check('代码块顶栏没有底边线(靠色阶分区,不画线)',
  (await css('.msg.assistant .md-prose .code-block .code-header', 'border-bottom-width')) === '0px',
  await css('.msg.assistant .md-prose .code-block .code-header', 'border-bottom-width'));
check('代码块左右内边距 16px', (await css('.msg.assistant .md-prose .code-block pre', 'padding-left')) === '16px',
  await css('.msg.assistant .md-prose .code-block pre', 'padding'));
check('复制键是幽灵按钮(透明底)', (await css('.msg.assistant .md-prose .code-block .code-copy', 'background-color')) === 'rgba(0, 0, 0, 0)');
// 引用块:GPT 是「缩进的浅灰文字」,既不画左侧竖线也不垫底色。
// 之前断言的是「只有左侧细线」——本轮把线去掉,连同默认外观的 ::before 装饰条一起撤掉。
check('引用块没有左侧竖线、也没有底色(只靠缩进与颜色)',
  (await css('.msg.assistant .md-prose blockquote', 'border-left-width')) === '0px'
  && (await css('.msg.assistant .md-prose blockquote', 'background-color')) === 'rgba(0, 0, 0, 0)',
  'border-left=' + (await css('.msg.assistant .md-prose blockquote', 'border-left-width'))
  + ' bg=' + (await css('.msg.assistant .md-prose blockquote', 'background-color')));
check('引用块的 ::before 装饰竖条已撤掉(否则会在透明底上浮出一根线)',
  await page.evaluate(() => {
    const n = document.querySelector('.msg.assistant .md-prose blockquote');
    if (!n) return 'MISSING';
    const c = getComputedStyle(n, '::before');
    return c.content === 'none' || parseFloat(c.width) === 0;
  }) === true);

// 「拒绝一切有框线的矩形」的正面断言:凡是被当作「块」用的容器都不能有边框。
// 这些容器全部靠底色差 / 投影分层,边框一律为 0。
console.log('== 3.5 无框线:靠色阶与投影分层,不画边框 ==');
check('侧栏没有右边线(伪元素已关,自身 border-right 也已清零)',
  ((await borderWidths('.sidebar')).right || 0) === 0, JSON.stringify(await borderWidths('.sidebar')));
const gptComposerBw = await borderWidths('.composer');
check('输入框没有描边(靠柔和投影浮起)', (gptComposerBw.left || 0) === 0 && (gptComposerBw.top || 0) === 0,
  JSON.stringify(gptComposerBw));
check('输入框有投影(无描边时靠它定义边界)', (await css('.composer', 'box-shadow')) !== 'none',
  await css('.composer', 'box-shadow'));
check('弹窗没有描边', ((await borderWidths('.modal')).left || 0) === 0, JSON.stringify(await borderWidths('.modal')));
check('表格没有外框', ((await borderWidths('.msg.assistant .md-prose .table-wrap')).left || 0) === 0
  && ((await borderWidths('.msg.assistant .md-prose .table-wrap')).top || 0) === 0,
  JSON.stringify(await borderWidths('.msg.assistant .md-prose .table-wrap')));
// 表头底线是表头/表体的**功能**分隔,不是装饰框,保留但降到最浅一档(hairline 0.08)
check('表头底线降到最浅一档(功能线,不是装饰框)',
  (await css('.msg.assistant .md-prose .table-wrap table th', 'border-bottom-width')) === '1px'
  && (await css('.msg.assistant .md-prose .table-wrap table th', 'border-bottom-color')) === 'rgba(13, 13, 13, 0.08)',
  await css('.msg.assistant .md-prose .table-wrap table th', 'border-bottom-color'));
// 表头排序箭头是功能(表头可点击排序),但静止时不画 —— 每个表头挂一个半透明小勾像渲染残留
check('表头排序箭头静止时不显示(悬停/已排序才出现)',
  (await page.evaluate(() => {
    const n = document.querySelector('.msg.assistant .md-prose .table-wrap th.sortable');
    if (!n) return 'MISSING';
    return getComputedStyle(n, '::after').opacity;
  })) === '0');
check('已排序的表头箭头仍可见(功能没被删掉)',
  (await page.evaluate(() => {
    const th = document.querySelector('.msg.assistant .md-prose .table-wrap th.sortable');
    if (!th) return 'MISSING';
    th.classList.add('sort-asc');
    const v = getComputedStyle(th, '::after').opacity;
    th.classList.remove('sort-asc');
    return v;
  })) === '1');

// 操作条现在四套主题一致:常驻可见,靠颜色深浅表达状态,悬停/聚焦再提亮。
// 曾经这里断言的是「静止 opacity: 0、悬停才浮现」,但同一排按钮在默认外观看得见、
// 切到主题就「消失」,用户报的就是这个 —— 与默认外观对齐才是对的。
console.log('== 4. 消息操作常驻(不悬停也看得见,悬停只提亮)==');
check('静止时操作条可见', (await css('.msg.assistant .msg-actions', 'opacity')) === '1',
  await css('.msg.assistant .msg-actions', 'opacity'));
await page.hover('#zz-demo .msg.assistant .msg-content');
await sleep(300);
check('悬停后操作条仍然可见(不变暗也不消失)', (await css('.msg.assistant .msg-actions', 'opacity')) === '1',
  await css('.msg.assistant .msg-actions', 'opacity'));
await page.mouse.move(5, 5);
await sleep(300);

console.log('== 5. 空态:只剩标题,九个预设整块隐藏 ==');
const titleFs = await css('#empty-title', 'font-size');
check('空态标题 24px(--fs-display 是 !important,ID 选择器才压得住)', near(titleFs, 24), titleFs);
check('九个预设整块隐藏', (await css('.empty-suggests', 'display')) === 'none', await css('.empty-suggests', 'display'));
check('隐藏的是容器,九个按钮确实都不在', (await page.evaluate(() => {
  const box = document.querySelector('#empty-suggests');
  if (!box) return 'MISSING';
  return box.getBoundingClientRect().height === 0 && box.querySelectorAll('.empty-suggest').length > 0;
})) === true);
check('空态标题还在', (await box('#empty-title')) !== null);
// 「选择模型后输入问题,或点下面一个任务直接开始」后半句指的就是刚被藏掉的九个预设,
// 留着等于让用户去点已经不在的东西,所以在这个主题下整行隐藏
check('空态提示行「…或点下面一个任务直接开始」已隐藏', (await css('.empty-lead', 'display')) === 'none',
  await css('.empty-lead', 'display'));
check('藏的是那一行,不是整块空态', (await page.evaluate(() => {
  const lead = document.querySelector('.empty-lead');
  const title = document.querySelector('#empty-title');
  if (!lead || !title) return 'MISSING';
  return lead.getBoundingClientRect().height === 0 && title.getBoundingClientRect().height > 0;
})) === true);

console.log('== 5b. 品牌 logo:精致灰 ==');
// 把「精致灰」变成可测的定义:去色必须彻底(饱和度 0),明度要收在一条窄带里。
// 单纯 grayscale(1) 是按亮度加权去色,渐变那头(#2EC5FF 亮度 0.66)比字身
// (#232936 亮度 0.16)亮太多,跨度约 0.5,看起来是「褪了色的彩色」而不是灰。
// 取样走画布:ctx.filter 与 CSS filter 同一套语法,量到的是最终落地的像素。
async function logoBand(sel) {
  return page.evaluate(async (s) => {
    const img = document.querySelector(s);
    if (!img) return 'MISSING';
    try { await img.decode(); } catch (e) { /* 已解码 */ }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.filter = getComputedStyle(img).filter;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let min = 1, max = 0, sat = 0, px = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;   // 跳过透明与抗锯齿边缘
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      min = Math.min(min, lum); max = Math.max(max, lum);
      sat = Math.max(sat, Math.max(r, g, b) - Math.min(r, g, b));
      px++;
    }
    return { filter: getComputedStyle(img).filter, min, max, spread: max - min, sat, px };
  }, sel);
}
const lightBand = await logoBand('.sidebar-brand .brand-logo-light');
check('浅色 logo 是中性灰(饱和度 0)', lightBand.sat < 0.02, JSON.stringify(lightBand));
check('浅色 logo 灰带够窄(不发虚)', lightBand.spread < 0.35, '跨度 ' + lightBand.spread.toFixed(3));
check('浅色 logo 整体偏深(不是浅灰字)', lightBand.min < 0.35 && lightBand.max < 0.62,
  lightBand.min.toFixed(2) + '~' + lightBand.max.toFixed(2));
const emptyBand = await logoBand('.empty-logo-img');
check('空态 logo 与侧栏同一套灰', Math.abs(emptyBand.min - lightBand.min) < 0.02 && Math.abs(emptyBand.max - lightBand.max) < 0.02,
  emptyBand.min.toFixed(2) + '~' + emptyBand.max.toFixed(2));
// 灰度只该落在站点 logo 上:正文里的图片必须保持原色(选择器写宽了就会全灰)
const imgFilter = await page.evaluate(() => {
  const p = document.querySelector('.msg.assistant .md-prose');
  if (!p) return 'MISSING';
  let img = p.querySelector('img.zz-probe');
  if (!img) {
    img = document.createElement('img');
    img.className = 'zz-probe';
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    p.appendChild(img);
  }
  return getComputedStyle(img).filter;
});
check('正文图片不受灰度影响', imgFilter === 'none', imgFilter);

console.log('== 6. 输入区:两行式,且与消息列同宽 ==');
// @ 行只在选中助手时存在,而它与 textarea 首行是「同一行盒」的约定 ——
// 主题把输入字号抬到 16px,两边必须一起抬,否则 @ 标记会与首行错位
await page.evaluate(() => window.startAssistantChat({ id: 'as-theme', name: '主题自检', prompt: '你是主题自检助手。' }));
await sleep(800);
check('已选中助手,@ 行出现', !!(await box('.composer-at-row')), JSON.stringify(await box('.composer-at-row')));
const wrap = await box('.composer-wrap');
const messages = await box('.messages');
check('输入框与消息列同宽', wrap.w && messages.w && Math.abs(wrap.w - messages.w) <= 1, wrap.w + ' vs ' + messages.w);
check('输入框与消息列左界对齐', Math.abs(wrap.x - messages.x) <= 1, wrap.x + ' vs ' + messages.x);
const flowBox = await box('.composer-flow');
const leftBox = await box('.composer-left');
const rightBox = await box('.composer-right');
check('输入行在上、工具行在下', leftBox.y >= flowBox.bottom - 2, leftBox.y + ' vs flow.bottom ' + flowBox.bottom);
// 基准用 .composer(输入框卡片本身)而不是 .composer-wrap:wrap 现在带 12px 左右内缩
// (给窄屏留边距),拿它当右界会多算 12px,把「贴住输入框右下角」误判成偏了 25px。
const composerCard = await box('.composer');
check('发送键仍在输入框右下角',
  rightBox.y >= flowBox.bottom - 2 && Math.abs((rightBox.x + rightBox.w) - (composerCard.x + composerCard.w)) <= 20,
  JSON.stringify(rightBox) + ' vs card right ' + (composerCard.x + composerCard.w));
// 输入框两端的两个圆按钮要「看上去」一样大:发送钮是实心圆底,菜单钮是透明的,
// 所以菜单钮刻意做大一档(46 vs 42),靠外径补上那圈柔和边缘的视觉差;
// 但不许给它加投影 —— 透明按钮上多一圈灰会更显脏。
const moreBox = await box('.composer-more');
const sendBox = await box('#send-btn');
check('折叠菜单钮比发送钮大一档(46 vs 42,补上实心圆底的视觉差)', moreBox.w === 46 && moreBox.h === 46 && sendBox.w === 42 && sendBox.h === 42,
  moreBox.w + 'x' + moreBox.h + ' vs ' + sendBox.w + 'x' + sendBox.h);
check('折叠菜单钮没有投影', (await css('.composer-more', 'box-shadow')) === 'none', await css('.composer-more', 'box-shadow'));
check('两个钮垂直居中对齐', Math.abs((moreBox.y + moreBox.h / 2) - (sendBox.y + sendBox.h / 2)) <= 1,
  JSON.stringify({ moreCenter: moreBox.y + moreBox.h / 2, sendCenter: sendBox.y + sendBox.h / 2 }));
check('菜单钮图标 26px(发送钮 20px)', Math.abs((await box('.composer-more .oc-icon')).w - 26) <= 0.5,
  String((await box('.composer-more .oc-icon')).w));
check('消息区底部留白已让开变高的输入框', (await css('.chat-area', 'padding-bottom')) === '190px',
  await css('.chat-area', 'padding-bottom'));
check('回到底部按钮同步上移', (await css('.scroll-bottom-btn', 'bottom')) === '176px',
  await css('.scroll-bottom-btn', 'bottom'));
const taFs = await css('.composer textarea', 'font-size');
check('输入字号与正文一致', near(taFs, num(bodyFs)), taFs);
const atH = await css('.composer-at-row', 'height');
const taLh = await css('.composer textarea', 'line-height');
check('@ 行高度与输入框首行行高一致', near(atH, taLh), atH + ' vs ' + taLh);
// 输入行的高度必须严格等于 textarea:多出来的任何一截都会把文字顶偏
const flowH = (await box('.composer-flow')).h;
const taH = (await box('.composer textarea')).h;
check('输入行高度 = textarea 高度(多出来的空白会把文字顶偏)', Math.abs(flowH - taH) <= 0.5, flowH + ' vs ' + taH);

console.log('== 7. 深色:调色板与浅色互不影响 ==');
await injectDemo(page);   // 换助手/新建会话会重渲染消息区,量之前重新注入
await page.evaluate(() => window.OCUI.applyTheme('dark'));
await sleep(500);
check('深色侧栏 #171717', (await css('.sidebar', 'background-color')) === 'rgb(23, 23, 23)', await css('.sidebar', 'background-color'));
check('深色正文 #ececec', (await css('.msg.assistant .msg-content', 'color')) === 'rgb(236, 236, 236)');
check('深色用户气泡 #303030', (await css('.msg.user .msg-content', 'background-color')) === 'rgb(48, 48, 48)');
check('深色下表头同样透明', (await css('.msg.assistant .md-prose .table-wrap table th', 'background-color')) === 'rgba(0, 0, 0, 0)',
  await css('.msg.assistant .md-prose .table-wrap table th', 'background-color'));
// 深色用的是另一套 logo(字身近白),同一组滤镜参数必然不对,必须单独验
const darkBand = await logoBand('.sidebar-brand .brand-logo-dark');
check('深色 logo 是中性灰', darkBand.sat < 0.02, JSON.stringify(darkBand));
check('深色 logo 灰带够窄', darkBand.spread < 0.4, '跨度 ' + darkBand.spread.toFixed(3));
check('深色 logo 整体偏亮(深底上读得出来)', darkBand.min > 0.45 && darkBand.max > 0.75,
  darkBand.min.toFixed(2) + '~' + darkBand.max.toFixed(2));
await page.evaluate(() => window.OCUI.applyTheme('light'));
await sleep(400);

console.log('== 8. 窄屏:两行式仍成立,留白同步 ==');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(600);
const mFlow = await box('.composer-flow');
const mLeft = await box('.composer-left');
check('窄屏仍是两行式', mLeft.y >= mFlow.bottom - 2, mLeft.y + ' vs ' + mFlow.bottom);
check('窄屏底部留白 168px', (await css('.chat-area', 'padding-bottom')) === '168px', await css('.chat-area', 'padding-bottom'));
check('窄屏回到底部按钮 166px', (await css('.scroll-bottom-btn', 'bottom')) === '166px');
check('窄屏输入框不溢出', (await box('.composer')).w <= 390, JSON.stringify(await box('.composer')));
await page.setViewportSize({ width: 1280, height: 900 });
await sleep(500);

console.log('== 9. 切回默认主题:一切原样还原 ==');
check('能切回默认主题', await pickTheme(page, 'default'));
check('data-oc-theme 回到 default', (await page.evaluate(() => document.documentElement.getAttribute('data-oc-theme'))) === 'default');
check('主题样式表已移除', !(await page.evaluate(() => !!document.getElementById('oc-theme-pack-css'))));
await injectDemo(page);
check('头像恢复显示', (await css('.msg.assistant .msg-avatar', 'display')) === 'flex', await css('.msg.assistant .msg-avatar', 'display'));
check('正文字号回到 14px', (await css('.msg.assistant .msg-content', 'font-size')) === '14px', await css('.msg.assistant .msg-content', 'font-size'));
check('输入框回到单行', (await css('.composer', 'flex-wrap')) === 'nowrap', await css('.composer', 'flex-wrap'));
// 切回默认外观后输入框宽度必须与消息列一致(两者都吃 --content-w),而不是某个写死的像素值:
// 对话列宽度现在由用户在「外观」里调(默认 61.8%),写死 820px 只在旧默认下成立。
const backWrap = await box('.composer-wrap');
const backMsgs = await box('.messages');
check('输入框宽度回到默认(与消息列同宽,由 --content-w 决定)',
  backWrap.w > 0 && backMsgs.w > 0 && Math.abs(backWrap.w - backMsgs.w) <= 1, backWrap.w + ' vs ' + backMsgs.w);
// 默认外观自身的不变量,和主题无关,放在这里是因为这节正好是默认外观的现场:
// textarea 默认是 inline-block,坐在文字基线上,行盒还要给下方 descender 留位置,
// 于是 .composer-flow 比 textarea 高出一截且空白全在下方,输入框里那行字看着偏上。
const dComposer = await box('.composer');
const dTa = await box('.composer textarea');
const dLineTop = dTa.y + num(await css('.composer textarea', 'padding-top'));
const dAbove = dLineTop - dComposer.y;
const dBelow = dComposer.bottom - (dLineTop + num(await css('.composer textarea', 'line-height')));
// 容差 1.5px:上下留白的理论差值是 0(各 19.5),落到整数像素上会有 1px 的取整抖动,
// 而这条要防的是 inline-block 支撑空白那种 5.4px 级别的偏移,两者差得足够远。
check('默认外观:输入框内文字垂直居中(上 ' + dAbove.toFixed(1) + ' / 下 ' + dBelow.toFixed(1) + ')',
  Math.abs(dAbove - dBelow) <= 1.5);
check('默认外观:输入行高度 = textarea 高度', Math.abs((await box('.composer-flow')).h - dTa.h) <= 0.5,
  (await box('.composer-flow')).h + ' vs ' + dTa.h);
check('消息区留白回到 132px', (await css('.chat-area', 'padding-bottom')) === '132px');
check('操作条恢复常驻', (await css('.msg.assistant .msg-actions', 'opacity')) === '1');
check('表头恢复默认底色', (await css('.msg.assistant .md-prose .table-wrap table th', 'background-color')) !== 'rgba(0, 0, 0, 0)',
  await css('.msg.assistant .md-prose .table-wrap table th', 'background-color'));
check('九个预设恢复显示', (await css('.empty-suggests', 'display')) !== 'none', await css('.empty-suggests', 'display'));
check('空态提示行恢复显示', (await css('.empty-lead', 'display')) !== 'none', await css('.empty-lead', 'display'));
// 这一对按钮的尺寸与对齐是默认外观自己的规则,主题不该改变它,也不该只在主题里成立
const dMore = await box('.composer-more');
const dSend = await box('#send-btn');
check('默认外观:折叠菜单钮 46px、发送钮 42px', dMore.w === 46 && dMore.h === 46 && dSend.w === 42 && dSend.h === 42,
  JSON.stringify({ more: dMore.w + 'x' + dMore.h, send: dSend.w + 'x' + dSend.h }));
check('默认外观:两个钮垂直居中对齐',
  Math.abs((dMore.y + dMore.h / 2) - (dSend.y + dSend.h / 2)) <= 1,
  JSON.stringify({ moreCenter: dMore.y + dMore.h / 2, sendCenter: dSend.y + dSend.h / 2 }));
check('logo 灰度滤镜已撤掉', (await css('.sidebar-brand .brand-logo-light', 'filter')) === 'none', await css('.sidebar-brand .brand-logo-light', 'filter'));

check('无页面 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log('\n' + (fail === 0 ? '✓ 主题包自检通过' : '✗ 主题包自检未通过') + `(通过 ${pass},失败 ${fail})`);
process.exit(fail === 0 ? 0 : 1);
