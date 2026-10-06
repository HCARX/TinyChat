/* 笔记分享页排版自检(真 Chromium + 真服务端):
 *   node tests/note-share-gui.mjs
 *
 * 锁住的回归点:markdown.css 里 100+ 条正文排版规则**全部**挂在
 * `.msg.assistant .md-prose` 下(标题阶梯字号、引用块左缘细线、表格网格、
 * 代码块圆角、列表行距……)。分享页此前把 markdown 直接渲染进一个裸
 * md-prose 容器,没有 `.msg.assistant` 这层祖先 —— 于是所有规则一条都不生效,
 * 正文退回浏览器默认样式:标题 28px 粗黑、引用块没有左缘线、表格没有网格,
 * 整页看着「像是没加样式」。
 *
 * 这类「少了一层祖先类导致整层 CSS 静默失效」的问题读代码看不出来(容器上确实
 * 有 md-prose),只能真浏览器量计算样式;断言用「与应用内预览逐条一致」来锁,
 * 而不是写死某个像素值 —— 免得以后调排版还要改测试。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8261);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'note-share-pass' };

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
  console.log('(skip) 未找到 playwright,跳过笔记分享页自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-noteshare-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill(); } catch (e) {} } rmSync(TMP, { recursive: true, force: true }); });

const app = spawn('php', ['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(app);
let appErr = '';
app.stderr.on('data', (d) => { appErr += String(d); });

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

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json();
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
if (!login.token) { console.error('✗ 登录失败: ' + JSON.stringify(login).slice(0, 200)); process.exit(1); }
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ notesEnabled: true }) });

// 覆盖正文里会走不同 CSS 分支的几种块:标题 / 引用 / 表格 / 代码 / 列表
const CONTENT = [
  '# 一级标题',
  '',
  '> 引用块内容',
  '',
  '## 二级标题',
  '',
  '正文段落，含 `行内代码`。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 值 1 | 值 2 |',
  '',
  '```js',
  'const a = 1;',
  '```',
].join('\n');

await fetch(BASE + '/api/sync/notes', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    baseRevision: 0,
    doc: {
      folders: [{ id: 'uncat', parentId: null, name: '默认分类', createdAt: 1, updatedAt: 1, system: true }],
      notes: [{ id: 'nsh1', folderId: 'uncat', title: '分享页排版笔记', content: CONTENT, tags: ['排版'], isPinned: false, shareMode: 'private', createdAt: 3, updatedAt: 3 }],
      tombs: {},
    },
  }),
});
const shareRes = await (await fetch(BASE + '/api/notes/share', {
  method: 'POST', headers: AUTH, body: JSON.stringify({ noteId: 'nsh1', mode: 'edit-link', expireDays: 0 }),
})).json();
const TOKEN = shareRes.share && shareRes.share.token;
if (!TOKEN) { console.error('✗ 生成分享失败: ' + JSON.stringify(shareRes).slice(0, 300)); process.exit(1); }

const browser = await pw.chromium.launch();

// 取一组「正文排版指纹」:几个关键块的 computed style
// 分享页正文是 #note-body(渲染视图)/ #ne-preview-body(编辑态预览);
// 应用内笔记预览的容器 id 是 #ne-preview。
const FINGERPRINT = () => {
  const root = document.getElementById('note-body')
    || document.getElementById('ne-preview-body')
    || document.getElementById('ne-preview');
  if (!root) return null;
  const pick = (sel) => root.querySelector(sel);
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const h1 = cs(pick('h1')), h2 = cs(pick('h2')), bq = cs(pick('blockquote'));
  const tbl = cs(pick('table')), pre = cs(pick('pre'));
  const li = cs(pick('li'));
  return {
    hasMdProse: root.classList.contains('md-prose'),
    inMsgAssistant: !!root.closest('.msg.assistant'),
    h1: h1 ? h1.fontSize + '|' + h1.fontWeight : null,
    h2: h2 ? h2.fontSize + '|' + h2.fontWeight : null,
    bqBorderLeft: bq ? bq.borderLeftWidth : null,
    bqIndent: bq ? bq.paddingLeft : null,
    tableCollapse: tbl ? tbl.borderCollapse : null,
    preRadius: pre ? pre.borderRadius : null,
    liLineHeight: li ? li.lineHeight : null,
  };
};

console.log('== 1. 分享页正文与应用内预览同一套排版 ==');
let shareFp = null;
{
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(BASE + '/n/' + TOKEN, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('#note-body h1'), null, { timeout: 20000 });
  shareFp = await page.evaluate(FINGERPRINT);

  check('正文容器带 md-prose', shareFp && shareFp.hasMdProse);
  // 这一条是核心:.md-prose 必须处在 .msg.assistant 之内,否则整层排版规则失效
  check('正文位于 .msg.assistant 之内(否则排版规则全部不生效)', shareFp && shareFp.inMsgAssistant);
  check('标题拿到排版层字号(而非浏览器默认 28px)',
    !!shareFp && shareFp.h1 && !shareFp.h1.startsWith('28px'), '实际 ' + (shareFp && shareFp.h1));
  check('引用块有左缘细线', !!shareFp && parseFloat(shareFp.bqBorderLeft) > 0, '实际 ' + (shareFp && shareFp.bqBorderLeft));
  check('表格合并边框', !!shareFp && shareFp.tableCollapse === 'collapse', '实际 ' + (shareFp && shareFp.tableCollapse));
  check('代码块有圆角', !!shareFp && parseFloat(shareFp.preRadius) > 0, '实际 ' + (shareFp && shareFp.preRadius));
  check('无 JS 异常' + (errs.length ? ': ' + errs[0].slice(0, 80) : ''), errs.length === 0);

  // 移动端不应横向溢出(表格/代码块是常见撑破源)
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('窄屏无横向溢出(实测 ' + over + 'px)', over <= 1);
  await ctx.close();
}

console.log('\n== 2. 编辑态「预览」同样是这套排版 ==');
{
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/n/' + TOKEN, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('note-edit-btn'), null, { timeout: 20000 });
  await page.locator('#note-edit-btn').click();
  await page.waitForSelector('#ne-preview', { timeout: 10000 });
  await page.locator('#ne-preview').click();
  await page.waitForFunction(() => !!document.querySelector('#ne-preview-body h1'), null, { timeout: 15000 });
  const fp = await page.evaluate(FINGERPRINT);
  check('编辑态预览位于 .msg.assistant 之内', !!fp && fp.inMsgAssistant);
  check('编辑态预览标题字号与分享页一致', !!fp && !!shareFp && fp.h1 === shareFp.h1, (fp && fp.h1) + ' vs ' + (shareFp && shareFp.h1));
  check('编辑态预览引用块同样有左缘线', !!fp && parseFloat(fp.bqBorderLeft) > 0, '实际 ' + (fp && fp.bqBorderLeft));
  await ctx.close();
}

console.log('\n== 3. 与应用内笔记预览逐条一致(默认主题)==');
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await ctx.newPage();
  await page.addInitScript((t) => { localStorage.setItem('oc_token', t); }, login.token);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.OCApp && window.OCApp.state && window.OCApp.state.user), null, { timeout: 30000 });
  await page.evaluate(() => { if (window.OCNotes) window.OCNotes.warmUp(); });
  await page.waitForFunction(() => !!(window.OCNotes && window.OCNotes.isReady && window.OCNotes.isReady()), null, { timeout: 30000 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '开始使用');
    if (b) b.click();
  });
  await page.evaluate(() => window.OCNotes.open());
  await sleep(1000);
  await page.evaluate(() => { const el = document.querySelector('.nt-note[data-note-id="nsh1"]'); if (el) el.click(); });
  await sleep(700);
  await page.evaluate(() => { const b = document.querySelector('#ne-mode-switch [data-mode="preview"]'); if (b) b.click(); });
  await sleep(700);
  const appFp = await page.evaluate(FINGERPRINT);
  const keys = ['h1', 'h2', 'bqBorderLeft', 'bqIndent', 'tableCollapse', 'preRadius', 'liLineHeight'];
  for (const k of keys) {
    check('「' + k + '」分享页与应用内一致(' + (shareFp && shareFp[k]) + ')',
      !!appFp && !!shareFp && appFp[k] === shareFp[k], '应用内 ' + (appFp && appFp[k]));
  }
  await ctx.close();
}

await browser.close();
console.log('\n' + (fail ? `✗ 笔记分享页自检失败: ${fail} 项` : `✓ 笔记分享页自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
