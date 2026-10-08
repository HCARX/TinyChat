/* 输入框聚焦环 / 主题色恢复默认 / 窄屏账户面板自检(真 Chromium + 真服务端):
 *   node tests/focus-ring-gui.mjs
 *
 * 覆盖三类只有真浏览器才量得出来的问题:
 *   1) 聚焦环只能有一圈:输入框聚焦后自身是一圈 2px 主色描边,不能再叠一层旧版
 *      光环(box-shadow 环),祖先也不许多画一圈 —— 这类「同一个框上两圈」的问题
 *      是 CSS 里两个不同层的规则叠加出来的,看代码看不出来,必须量计算样式;
 *   2) 复合控件的环要圈住整个框:主题色 HEX 输入框、上下文步进器、侧栏搜索、
 *      助手库搜索、后台用户搜索的可见框都是外层容器,环必须画在容器上,
 *      内部 input 不再单独描边(修复前环只圈住框内部的一小块);
 *   3) 主题色「恢复默认」:改色后点一下,偏好、CSS 变量、入口色值都回到内置默认,
 *      刷新后仍是默认(说明确实写进了本地偏好,而不是只改了当前这一帧);
 *   4) 窄屏账户页签:次数徽章独占一行,名字与「注册于 …」不再被挤成一条竖线
 *      (修复前 390px 下文字列只剩 25px、360px 下 0px,整块高 218px)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8251);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8252);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'focus-ring-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  console.log('(skip) 未找到 playwright,跳过聚焦环自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-focus-gui-' + Date.now());
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

const loginText = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).text();
let login = {};
try { login = JSON.parse(loginText); } catch (e) { console.error('✗ 登录响应非 JSON: ' + loginText.slice(0, 200)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ notesEnabled: true }) });
// 开启用户协议:注册勾选行只有开启后才可见(默认关闭),第 7 节要在真页面上量它
const agreeSave = await fetch(BASE + '/api/admin/settings', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ agreementEnabled: true, agreementHtml: '<p>自检用协议正文。</p>' }),
});
const agreeCfg = await (await fetch(BASE + '/api/config')).json();
if (!agreeCfg.agreementEnabled) {
  console.error('✗ 开启用户协议未生效:保存 HTTP ' + agreeSave.status
    + ' /api/config.agreementEnabled=' + agreeCfg.agreementEnabled
    + '\n  ' + (await agreeSave.text()).slice(0, 300));
  process.exit(1);
}

const browser = await pw.chromium.launch();
const pageErrors = [];

// 页面内:先清焦点再聚焦目标,等过渡结束后量「自身描边 / 自身环影 / 祖先环」
const PROBE = async (arg) => {
  const sleepIn = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = document.querySelector(arg.sel);
  if (!el) return { missing: true, why: '不存在' };
  const isRing = (sh) => !!sh && /0px 0px 0px [0-9.]+px/.test(sh);
  const info = (n) => {
    const cs = getComputedStyle(n);
    const ow = parseFloat(cs.outlineWidth) || 0;
    return {
      outline: cs.outlineStyle !== 'none' && ow > 0, ow,
      shadow: (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '',
      ring: isRing(cs.boxShadow),
    };
  };
  const snap = () => { const out = []; let n = el; for (let i = 0; i < 4 && n; i++) { out.push(info(n)); n = n.parentElement; } return out; };
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  await sleepIn(140);
  const before = snap();
  const target = arg.focusSel ? document.querySelector(arg.focusSel) : el;
  if (!target) return { missing: true, why: '焦点目标不存在' };
  try { target.focus({ focusVisible: true }); } catch (e) { /* 见下 */ }
  if (document.activeElement !== target) return { missing: true, why: '无法聚焦(面板未激活?)' };
  await sleepIn(360);
  const after = snap();
  let anc = false;
  for (let i = 1; i < after.length; i++) {
    if ((after[i].ring && !before[i].ring) || (after[i].outline && !before[i].outline)) anc = true;
  }
  const r = target.getBoundingClientRect();
  const wrap = arg.wrap ? document.querySelector(arg.wrap) : null;
  const wr = wrap ? wrap.getBoundingClientRect() : null;
  return {
    selfOutline: after[0].outline, selfRing: after[0].ring, selfOw: after[0].ow, anc,
    shadow: after[0].shadow.slice(0, 60),
    box: Math.round(r.width) + 'x' + Math.round(r.height),
    wrapBox: wr ? Math.round(wr.width) + 'x' + Math.round(wr.height) : '',
  };
};

const single = (r) => r && !r.missing && r.selfOutline === true && r.selfOw === 2 && r.selfRing === false && r.anc === false;
const onWrap = (r) => r && !r.missing && r.selfOutline === false && r.selfRing === false && r.anc === true;

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
await page.addInitScript((t) => { try { localStorage.setItem('oc_token', t); } catch (e) {} }, login.token);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await sleep(1500);

async function openSettings(p) {
  await p.evaluate(() => { const c = document.querySelector('#account-chip'); if (c) c.click(); });
  await sleep(350);
  await p.evaluate(() => { const b = document.querySelector('#user-menu-settings'); if (b) b.click(); });
  await sleep(800);
  return p.evaluate(() => !!document.querySelector('#settings-modal:not(.hidden)'));
}
async function tab(p, name) {
  await p.evaluate((t) => { const b = document.querySelector('.settings-tab[data-tab="' + t + '"]'); if (b) b.click(); }, name);
  await sleep(450);
}
async function closeTop(p) { await p.keyboard.press('Escape'); await sleep(500); }
async function openAssistantForm(p) {
  await p.evaluate(() => { const b = document.querySelector('#assistant-lib-btn'); if (b) b.click(); });
  await sleep(800);
  await p.evaluate(() => { const b = document.querySelector('#al-add-asst'); if (b) b.click(); });
  await sleep(800);
}

check('设置弹窗已打开', await openSettings(page));

console.log('\n== 1. 单行/多行输入框:聚焦只有一圈 2px 主色描边 ==');
{
  const cases = [
    { label: '设置·API Key 备注', sel: '#apikey-name', setup: async () => { await tab(page, 'apikeys'); } },
    { label: '设置·兑换码', sel: '#plan-redeem-code', setup: async () => { await tab(page, 'plan'); } },
    { label: '设置·字体选择', sel: '#pref-font-cjk', setup: async () => { await tab(page, 'look'); } },
    {
      label: '助手表单·系统提示词(多行)',
      sel: '#af-prompt',
      setup: async () => { await closeTop(page); await openAssistantForm(page); },
    },
  ];
  for (const c of cases) {
    await c.setup();
    const r = await page.evaluate(PROBE, { sel: c.sel });
    check(`${c.label}:聚焦后只有一圈 2px 描边(无第二圈环影)`, single(r));
    if (!single(r)) console.log(`      (${r.why || ''} 描边=${r.selfOutline}/${r.selfOw}px 环影=${r.selfRing} 祖先环=${r.anc} 阴影=${r.shadow || ''})`);
  }
}

console.log('\n== 2. 复合控件:环圈住整个框,内部输入框不单独描边 ==');
{
  const cases = [
    {
      label: '设置·上下文步进器',
      sel: '#pref-context', wrap: '#pref-context-step',
      setup: async () => { await closeTop(page); await openSettings(page); await tab(page, 'chat'); },
    },
    {
      label: '主题色·HEX 输入框',
      sel: '#pref-accent-hex', wrap: '.accent-hex-field',
      setup: async () => {
        await tab(page, 'look');
        await page.evaluate(() => { const b = document.querySelector('#accent-open'); if (b) b.click(); });
        await sleep(700);
      },
    },
    {
      label: '侧栏·搜索对话',
      sel: '#chat-search-input', wrap: '.chat-search',
      setup: async () => { await closeTop(page); await sleep(400); },
    },
    {
      label: '助手库·搜索',
      sel: '#al-search', wrap: '.al-search',
      setup: async () => {
        await page.evaluate(() => { const b = document.querySelector('#assistant-lib-btn'); if (b) b.click(); });
        await sleep(800);
      },
    },
  ];
  for (const c of cases) {
    await c.setup();
    const r = await page.evaluate(PROBE, { sel: c.sel, wrap: c.wrap });
    check(`${c.label}:环画在整框上,内部输入框不描边`, onWrap(r));
    if (!onWrap(r)) console.log(`      (${r.why || ''} 内部描边=${r.selfOutline} 内部环影=${r.selfRing} 整框环=${r.anc} 整框=${r.wrapBox || ''})`);
  }
}

console.log('\n== 3. 主题色「恢复默认」 ==');
{
  await closeTop(page);
  check('设置弹窗再次打开', await openSettings(page));
  await tab(page, 'look');
  // 颜色统一规范化成 rgb() 再比:空偏好时 --accent 来自样式表(十六进制写法),
  // 显式写入默认色后是 rgb() 写法 —— 两者是同一个颜色,字符串却不同。
  const READ = () => {
    const norm = (v) => { const d = document.createElement('div'); d.style.color = v || 'rgb(0, 0, 0)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    return {
      pref: JSON.parse(localStorage.getItem('oc_prefs') || '{}').accent || '',
      accent: norm(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()),
      entry: ((document.querySelector('#accent-entry-hex') || {}).textContent || '').trim(),
      defaultAccent: (window.OCUI && window.OCUI.defaultAccent) || '',
    };
  };
  const before = await page.evaluate(READ);
  await page.evaluate(() => { const b = document.querySelector('#accent-open'); if (b) b.click(); });
  await sleep(700);
  check('主题色弹窗可打开', await page.evaluate(() => !!document.querySelector('#accent-modal:not(.hidden)')));
  check('弹窗里有「恢复默认」按钮', await page.evaluate(() => !!document.querySelector('#accent-modal-reset')));
  await page.evaluate(() => {
    const i = document.querySelector('#pref-accent-hex');
    i.value = '#ff0000';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(450);
  const set = await page.evaluate(READ);
  check('改成 #FF0000 后写进本地偏好', String(set.pref).toUpperCase() === '#FF0000');
  check('主色变量随之改变', set.accent !== before.accent);
  await page.evaluate(() => { const b = document.querySelector('#accent-modal-reset'); if (b) b.click(); });
  await sleep(500);
  const after = await page.evaluate(READ);
  check('恢复默认后本地偏好回到内置默认色', String(after.pref).toUpperCase() === String(after.defaultAccent).toUpperCase());
  check('恢复默认后主色变量回到默认值', after.accent === before.accent);
  check('恢复默认后设置入口显示默认色值', after.entry.toUpperCase() === String(after.defaultAccent).toUpperCase());
  check('点恢复默认不会把弹窗关掉(还能接着调)', await page.evaluate(() => !!document.querySelector('#accent-modal:not(.hidden)')));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const reloaded = await page.evaluate(READ);
  check('刷新后仍是默认色(偏好已持久化)',
    String(reloaded.pref).toUpperCase() === String(after.defaultAccent).toUpperCase() && reloaded.accent === before.accent);
}

console.log('\n== 4. 后台用户搜索:环画在整框上 ==');
{
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  await p2.addInitScript((t) => { try { localStorage.setItem('oc_token', t); } catch (e) {} }, login.token);
  await p2.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await sleep(1600);
  const onUsers = await p2.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.admin-tabs button, .admin-tab')).find((x) => /用户/.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  await sleep(700);
  if (!onUsers) bad('未找到后台「用户」页签');
  else {
    const r = await p2.evaluate(PROBE, { sel: '#user-search', wrap: '.users-search' });
    check('后台用户搜索:环画在整框上,内部 input 不描边', onWrap(r));
    if (!onWrap(r)) console.log(`      (${r.why || ''} 内部描边=${r.selfOutline} 内部环影=${r.selfRing} 整框环=${r.anc})`);
  }
  await p2.close();
}

console.log('\n== 5. 窄屏账户页签:名字/注册时间不被挤成竖条 ==');
{
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pm = await ctxM.newPage();
  pm.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  await pm.addInitScript((t) => { try { localStorage.setItem('oc_token', t); } catch (e) {} }, login.token);
  await pm.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  check('窄屏下设置弹窗已打开', await openSettings(pm));
  await tab(pm, 'account');
  const MEASURE = () => {
    const g = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
    return {
      head: g('.acc-head'), name: g('#acc-name'), extra: g('#acc-extra'), quota: g('#acc-quota'),
      vw: window.innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  };
  for (const [w, h, minExtra] of [[390, 844, 120], [360, 740, 100]]) {
    await pm.setViewportSize({ width: w, height: h });
    await sleep(500);
    const m = await pm.evaluate(MEASURE);
    if (!m.extra || !m.name || !m.head) { bad(`${w}px 下账户面板元素缺失`); continue; }
    check(`${w}px:名字一行放得下(宽 ${m.name.w}px)`, m.name.w >= 100);
    check(`${w}px:「注册于 …」单行可读(宽 ${m.extra.w}px 高 ${m.extra.h}px)`, m.extra.w >= minExtra && m.extra.h <= 30);
    check(`${w}px:账户块不再被撑高(高 ${m.head.h}px)`, m.head.h <= 170);
    check(`${w}px:次数徽章在视口内且不横向溢出`, !!m.quota && m.quota.right <= m.vw + 1 && m.overflow <= 1);
  }
  await tab(pm, 'apikeys');
  const r = await pm.evaluate(PROBE, { sel: '#apikey-name' });
  check('窄屏输入框聚焦同样只有一圈 2px 描边', single(r));
  await ctxM.close();
}

console.log('\n== 6. 字体切换往返:实际中文字形与切片样式表 ==');
{
  await closeTop(page);
  check('设置弹窗已打开(字体往返)', await openSettings(page));
  await tab(page, 'look');

  const probeText = '思源宋体中文字体切换测试';
  const sliced = {
    'source-han-serif': { file: 'SourceHanSerifCN.css', name: /SourceHanSerifCN/i },
    'alibaba-puhuiti': { file: 'AlibabaPuHuiTi.css', name: /AlibabaPuHuiTi/i },
  };
  const FONT = () => {
    const rules = document.getElementById('oc-font-rules');
    const isSliced = (href) => /\/(SourceHanSerifCN|AlibabaPuHuiTi)\.css(?:\?|$)/.test(href || '');
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .filter((l) => isSliced(l.href))
      .map((l) => ({
        id: l.id, file: new URL(l.href).pathname.split('/').pop(),
        beforeRules: !!rules && !!(l.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING),
      }));
    const prefs = JSON.parse(localStorage.getItem('oc_prefs') || '{}');
    const inlineRules = rules && rules.sheet ? Array.from(rules.sheet.cssRules) : [];
    return {
      prefCjk: prefs.fontCjk || '',
      links,
      activeLinks: document.querySelectorAll('#oc-cjk-font-css').length,
      sheets: Array.from(document.styleSheets).filter((s) => isSliced(s.href))
        .map((s) => new URL(s.href).pathname.split('/').pop()),
      cleanInline: !!rules && !rules.children.length && !document.getElementById('oc-font-alias')
        && !Array.from(document.querySelectorAll('style')).some((s) =>
          /TinyChat Text:|(?:SourceHanSerifCN|AlibabaPuHuiTi)-\d+\.woff2/.test(s.textContent)),
      latinRules: inlineRules.filter((r) => /fonts\/(?:AlibabaSans|TimesNewRoman|Helvetica)\.woff2/.test(r.cssText))
        .map((r) => r.cssText).join('\n'),
    };
  };
  const initial = await page.evaluate(FONT);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const addProbe = () => page.evaluate((text) => {
    const probe = document.createElement('div');
    probe.id = 'oc-cjk-font-probe';
    probe.textContent = text;
    probe.style.cssText = 'position:fixed;top:8px;left:8px;z-index:100000;pointer-events:none;font-family:var(--oc-font-family);font-size:24px;font-weight:400;font-style:normal;';
    document.body.appendChild(probe);
  }, probeText);
  const renderedFonts = async () => {
    await page.waitForFunction(() => {
      const link = document.getElementById('oc-cjk-font-css');
      return !link || !!link.sheet;
    }, null, { timeout: 10000 });
    await page.evaluate(async (text) => {
      let timer;
      try {
        await Promise.race([
          (async () => {
            await document.fonts.load('400 24px "TinyChat Text"', text);
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CJK font load timeout')), 15000); }),
        ]);
      } finally { clearTimeout(timer); }
    }, probeText);
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#oc-cjk-font-probe' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.filter((f) => f.glyphCount > 0);
  };
  const verify = async (value, label, customFamily = '') => {
    try {
      await page.waitForFunction((v) => JSON.parse(localStorage.getItem('oc_prefs') || '{}').fontCjk === v,
        value, { timeout: 5000 });
      const fonts = await renderedFonts();
      const state = await page.evaluate(FONT);
      const def = sliced[value];
      check(`${label}:偏好已写入`, state.prefCjk === value);
      check(`${label}:只保留当前切片样式表(本机字体为零)`, def
        ? state.activeLinks === 1 && state.links.length === 1 && state.links[0].id === 'oc-cjk-font-css'
          && state.links[0].file === def.file && state.links[0].beforeRules
          && state.sheets.length === 1 && state.sheets[0] === def.file
        : state.activeLinks === 0 && state.links.length === 0 && state.sheets.length === 0);
      check(`${label}:无别名或嵌套 style 残留`, state.cleanInline);
      check(`${label}:拉丁字体规则保持不变`, state.latinRules === initial.latinRules);
      const detail = fonts.map((f) => `${f.postScriptName || f.familyName}:${f.glyphCount}:${f.isCustomFont ? 'web' : 'local'}`).join(', ');
      check(`${label}:Chromium 实际中文字形(${detail || '无字体'})`, fonts.length > 0
        && fonts.reduce((n, f) => n + f.glyphCount, 0) >= Array.from(probeText).length
        && fonts.every((f) => def
          ? f.isCustomFont && def.name.test(f.postScriptName || f.familyName.replace(/\s+/g, ''))
          : !f.isCustomFont && !/SourceHanSerifCN|AlibabaPuHuiTi/i.test(f.postScriptName || '')
            && (!customFamily || f.familyName === customFamily)));
      return fonts;
    } catch (e) {
      bad(`${label}:字体检测失败 ${e.message}`);
      return [];
    }
  };
  const setCjk = async (value, label, customFamily = '') => {
    if (sliced[value] || value === 'system') {
      await page.locator('#pref-font-cjk-select').click();
      await page.locator(`.oc-menu-item[data-value="${value}"]`).click();
    } else {
      await page.locator('#pref-font-cjk').fill(value);
      await page.locator('#pref-font-cjk').press('Enter');
      await sleep(400);
    }
    return verify(value, label, customFamily);
  };

  try {
    await addProbe();
    await setCjk('source-han-serif', '选思源宋体');
    await setCjk('alibaba-puhuiti', '切到普惠体');
    await setCjk('source-han-serif', '切回思源宋体');
    await setCjk('alibaba-puhuiti', '再次切到普惠体');
    const systemFonts = await setCjk('system', '切到系统字体');
    const customFamily = (systemFonts.find((f) => !f.isCustomFont) || {}).familyName;
    if (customFamily) {
      await setCjk('source-han-serif', '自定义前重新加载思源宋体');
      await setCjk(customFamily, '输入自定义本机字体', customFamily);
      await setCjk('alibaba-puhuiti', '自定义后重新加载普惠体');
      await setCjk(customFamily, '再次输入自定义本机字体', customFamily);
    } else { bad('未找到可用于自定义输入测试的本机中文字体'); }
    await setCjk('source-han-serif', '刷新前选思源宋体');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await addProbe();
    await verify('source-han-serif', '刷新后思源宋体');
  } finally {
    await page.evaluate(() => { const probe = document.getElementById('oc-cjk-font-probe'); if (probe) probe.remove(); });
    await cdp.detach();
  }
}

console.log('\n== 7. 注册勾选行:勾选框与「我已阅读并同意…」同一行,不被挤成竖排 ==');
{
  // .field 是块布局;只有 flex-direction 不会启用 flex,复选框还需覆盖 input 的整行宽度。
  const MEASURE = () => {
    const row = document.querySelector('#auth-modal-register #am-reg-agree-row, #reg-agree-row');
    if (!row) return { missing: true };
    const cb = row.querySelector('input[type="checkbox"]');
    const tx = row.querySelector('.agree-text');
    if (!cb) return { missing: true, why: '找不到勾选框' };
    const r = row.getBoundingClientRect(), c = cb.getBoundingClientRect();
    const t = tx ? tx.getBoundingClientRect() : null;
    const cs = getComputedStyle(cb);
    const firstText = tx && Array.from(tx.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    let first = null;
    if (firstText) {
      const range = document.createRange();
      const start = firstText.textContent.search(/\S/);
      range.setStart(firstText, start);
      range.setEnd(firstText, start + 1);
      first = range.getClientRects()[0] || null;
    }
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    return {
      zoom, cbWidth: c.width, cbHeight: c.height,
      alignment: { checkboxTop: c.top, checkboxBottom: c.bottom, firstTop: first && first.top, firstBottom: first && first.bottom, textFont: tx && getComputedStyle(tx).fontSize, textLineHeight: tx && getComputedStyle(tx).lineHeight },
      firstLineAligned: !!first && first.top < c.bottom && first.bottom > c.top
        && Math.abs((first.top + first.bottom - c.top - c.bottom) / 2) <= 4 * zoom,
      firstGlyph: first ? { x: first.left + first.width / 2, y: first.top + first.height / 2 } : null,
      rowDisplay: getComputedStyle(row).display,
      hidden: row.classList.contains('hidden') || r.width === 0,
      rowBox: Math.round(r.width) + 'x' + Math.round(r.height),
      cbBox: Math.round(c.width) + 'x' + Math.round(c.height),
      cbWidthStyle: cs.width,
      textBox: t ? Math.round(t.width) + 'x' + Math.round(t.height) : '',
      // 勾选框不该占满整行:超过行宽一半就算被 .field input{width:100%} 拉宽了
      cbFillsRow: r.width > 0 && c.width > r.width * 0.5,
      // 文字必须与勾选框垂直重叠(同一行);被挤到下一行时文字顶边会在勾选框底边之下
      sameLine: !!(t && t.top < c.bottom - 2),
      textLeftOfCb: !!(t && t.left >= c.right - 1),
      rowOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  };

  // /login 只服务未登录访客:带有效 token 访问会被 login.js 直接跳回主站
  // (login.js 的 !verifyToken && !resetToken && localStorage 有 token 分支)。
  // 所以量注册页必须用一个干净的浏览器上下文,否则 page.goto('/login') 会落到 '/' 上。
  const ctxGuest = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const gp = await ctxGuest.newPage();
  gp.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  try {
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await gp.setViewportSize({ width: w, height: h });
    await sleep(300);
    await gp.goto(BASE + '/login', { waitUntil: 'load' });
    // 注册行的显隐由 /api/config 的 agreementEnabled 决定,而这个 fetch 是异步的:
    // 先等它落地(命中预期 class),否则会在「配置还没回来」时误判成不可见。
    await gp.waitForFunction(() => {
      const row = document.querySelector('#reg-agree-row');
      return !!row && !row.classList.contains('hidden');
    }, null, { timeout: 8000 });
    // 注册表单默认也是隐藏的:先点「立即注册」切过去(真实路径,不做 DOM 手工开合)。
    await gp.click('#show-register');
    await sleep(600);
    const opened = await gp.evaluate(() => {
      const row = document.querySelector('#reg-agree-row');
      if (!row) return 'missing@' + location.pathname;
      if (!row.classList.contains('hidden')) return 'ok';
      return 'hidden';
    });
    if (opened !== 'ok') {
      bad(`${w}px 下 /login 的注册协议勾选行不可见(${opened})——协议开启未生效?`);
      continue;
    }
    await sleep(300);
    const m = await gp.evaluate(MEASURE);
    if (m.missing) { bad(`${w}px 下勾选行缺失${m.why ? ': ' + m.why : ''}`); continue; }
    check(`${w}px:勾选行是 flex 行布局(display=${m.rowDisplay})`, m.rowDisplay === 'flex');
    check(`${w}px:复选框没有被拉成整行宽(${m.cbBox} vs 行宽 ${m.rowBox})`, !m.cbFillsRow);
    check(`${w}px:复选框是固有尺寸 16px(实际 ${m.cbBox} / 声明 ${m.cbWidthStyle})`, m.cbBox === '16x16');
    check(`${w}px:文字与勾选框在同一行(文字 ${m.textBox})`, m.sameLine);
    check(`${w}px:文字排在勾选框右侧`, m.textLeftOfCb);
    check(`${w}px:页面不横向溢出`, m.rowOverflow <= 1);
  }
  } finally { await ctxGuest.close(); }

  const savedCfg = await (await fetch(BASE + '/api/config')).json();
  const configureGuestModal = async (settings) => {
    const r = await fetch(BASE + '/api/admin/settings', {
      method: 'POST', headers: AUTH, body: JSON.stringify(settings),
    });
    if (!r.ok) throw new Error(`保存游客注册配置失败: HTTP ${r.status}`);
    const cfg = await (await fetch(BASE + '/api/config')).json();
    if (Object.entries(settings).some(([key, value]) => cfg[key] !== value)) {
      throw new Error('游客注册配置未生效');
    }
  };
  const screenshotDir = process.env.GUI_SCREENSHOTS === '1' ? join(ROOT, '.tmp', 'agreement-gui') : '';
  if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
  try {
    // 禁用自动游客令牌,从真实未登录首页打开注册弹窗。
    for (const enabled of [true, false]) {
      await configureGuestModal({ guestEnabled: false, allowRegister: true, agreementEnabled: enabled });
      for (const [w, h] of [[1280, 900], [390, 844]]) {
        for (const fontSize of [14, 22]) {
          const label = `主站弹窗 ${w}px / 字号 ${fontSize}px / 协议${enabled ? '开' : '关'}`;
          const mc = await browser.newContext({ viewport: { width: w, height: h } });
          const mp = await mc.newPage();
          mp.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
          await mp.addInitScript((size) => {
            localStorage.setItem('oc_prefs', JSON.stringify({ fontSize: size, fontCjk: 'system', fontLatin: 'system' }));
          }, fontSize);
          try {
            await mp.goto(BASE + '/', { waitUntil: 'load' });
            await mp.waitForFunction(() => document.body.classList.contains('readonly-guest'),
              null, { timeout: 10000 });
            check(`${label}:真实未登录首页(无 oc_token)`,
              new URL(mp.url()).pathname === '/' && await mp.evaluate(() => !localStorage.getItem('oc_token')));
            const mobileMenu = mp.locator('#mobile-menu-btn');
            if (await mobileMenu.isVisible()) await mobileMenu.click();
            await mp.locator('#account-chip').click();
            await mp.locator('#auth-modal:not(.hidden)').waitFor({ state: 'visible' });
            await mp.locator('#am-go-register').click();
            await mp.locator('#auth-modal-register:not(.hidden)').waitFor({ state: 'visible' });
            const row = mp.locator('#am-reg-agree-row');
            if (enabled) {
              await row.waitFor({ state: 'visible' });
              await row.scrollIntoViewIfNeeded();
            } else await row.waitFor({ state: 'hidden' });
            await mp.evaluate(() => document.fonts.ready);
            const m = await mp.evaluate(MEASURE);
            if (m.missing) { bad(`${label}:勾选行缺失`); continue; }
            check(`${label}:实际字号缩放生效(zoom=${m.zoom})`, Math.abs(m.zoom - fontSize / 14) < 0.002);
            if (enabled) {
              check(`${label}:勾选行可见且为 flex`, !m.hidden && m.rowDisplay === 'flex');
              check(`${label}:复选框保持 16px 固有尺寸(含 zoom)`, !m.cbFillsRow
                && Math.abs(m.cbWidth - 16 * m.zoom) < 1 && Math.abs(m.cbHeight - 16 * m.zoom) < 1);
              check(`${label}:复选框与文字首行对齐`, m.firstLineAligned && m.textLeftOfCb);
              if (!m.firstLineAligned) console.log('    对齐度量: ' + JSON.stringify(m.alignment));
              check(`${label}:页面不横向溢出`, m.rowOverflow <= 1);
              const cb = mp.locator('#am-reg-agree');
              const before = await cb.isChecked();
              if (!m.firstGlyph) throw new Error('无法定位协议标签首字');
              // 点击非链接文字,验证原生 label 行为,不直接改 checked。
              await mp.mouse.click(m.firstGlyph.x, m.firstGlyph.y);
              check(`${label}:点击标签文字切换勾选`, await cb.isChecked() === !before);
              await mp.mouse.click(m.firstGlyph.x, m.firstGlyph.y);
              check(`${label}:再次点击标签取消勾选`, await cb.isChecked() === before);
              check(`${label}:标签点击未跳转或提交`, new URL(mp.url()).pathname === '/'
                && await mp.locator('#auth-modal-register').isVisible()
                && await mp.evaluate(() => !localStorage.getItem('oc_token')));
            } else {
              check(`${label}:协议关闭时不占布局`, m.hidden && m.rowDisplay === 'none');
              check(`${label}:复选框与协议链接均不可见`, !(await mp.locator('#am-reg-agree').isVisible())
                && !(await row.locator('a').isVisible()));
            }
            if (screenshotDir) {
              await mp.screenshot({ path: join(screenshotDir, `main-register-${w}-${fontSize}-${enabled ? 'on' : 'off'}.png`) });
            }
          } catch (e) { bad(`${label}:检测失败 ${e.message}`); }
          finally { await mc.close(); }
        }
      }
    }
  } finally {
    await configureGuestModal({
      guestEnabled: !!savedCfg.guestEnabled,
      allowRegister: savedCfg.allowRegister !== false,
      agreementEnabled: !!savedCfg.agreementEnabled,
    });
  }
  if (screenshotDir) console.log('  协议截图: ' + screenshotDir);
  await page.setViewportSize({ width: 1280, height: 900 });
  await sleep(300);
}

console.log('\n== 8. 无未捕获异常 ==');
{
  const real = pageErrors.filter((e) => !/favicon|Failed to load resource|net::|ERR_/i.test(e));
  check('无 JS 异常' + (real.length ? ': ' + real.slice(0, 2).join(' | ') : ''), real.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ 聚焦环/主题色自检失败: ${fail} 项` : `✓ 聚焦环/主题色自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
