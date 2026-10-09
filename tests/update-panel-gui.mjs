/* 后台「版本更新」面板自检(真 Chromium + 真服务端,不触网):
 *   node tests/update-panel-gui.mjs
 *
 * 两件事:
 *
 *   1) 发布说明渲染成 Markdown 富文本。发布说明是 GitHub Release 的 body,本身就是
 *      Markdown;此前直接塞进 <pre>,用户看到的是满屏的 # / * / 反引号。这里断言它真的
 *      被渲染成标题/列表/加粗/行内码,并且没有把 markdown 记号原样漏出来。
 *      「渲染器在不在、渲染成什么」只有真浏览器量 DOM 才有结论。
 *
 *   2) 「自动更新」开关默认开启,并真的落库。开关默认值、切换后是否写进设置(而不是只改
 *      前端勾选)是两件容易分开写错的事,接口层面各测一遍。
 *
 * 不触网:检查结果读的是 data/update/update-check.json 缓存(30 分钟内有效),
 * 用例预写这份缓存来伪造「发现了新版本」。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8351);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'update-gui-pass' };

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
if (!pw) { console.log('(skip) 未找到 playwright，跳过版本更新面板 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-update-' + Date.now());
const DATA_DIR = join(TMP, 'data');
mkdirSync(DATA_DIR, { recursive: true });
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

// 预写「检查更新」缓存:伪造「发现 9.9.9 新版本」,正文用一段真实形态的 Markdown。
const NOTES_MD = [
  '## 更新内容',
  '',
  '- 修复了 **开关样式** 错乱',
  '- 新增 `自动更新` 开关',
  '',
  '### 使用方法',
  '',
  '点击 [详情](https://example.com/release) 查看。',
].join('\n');
mkdirSync(join(DATA_DIR, 'update'), { recursive: true });
writeFileSync(join(DATA_DIR, 'update', 'update-check.json'), JSON.stringify({
  checkedAt: Date.now(),
  result: {
    current: '2.0.157',
    repo: 'TinyNano/TinyChat',
    hasUpdate: true,
    latest: {
      version: '9.9.9', tagName: 'v9.9.9', name: 'Release 9.9.9',
      notes: NOTES_MD, url: 'https://example.com/release', publishedAt: '2026-10-01T00:00:00Z',
    },
    checkedAt: Date.now(), lastUpdate: null, cached: false,
  },
}, null, 2));

const app = spawnPhp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR, ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
});
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
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

console.log('== 1. 接口:「自动更新」默认开启 ==');
const chk1 = await (await fetch(BASE + '/api/admin/update/check', { headers: AUTH })).json();
check('检查结果读到预置缓存(发现新版本 9.9.9)', chk1.hasUpdate === true && chk1.latest && chk1.latest.version === '9.9.9',
  JSON.stringify(chk1).slice(0, 200));
check('检查结果带回 autoUpdate 且默认是 true(实际 ' + chk1.autoUpdate + ')', chk1.autoUpdate === true);

console.log('\n== 2. 关掉自动更新后真的落库(不是只改前端勾选) ==');
const save = await (await fetch(BASE + '/api/admin/settings', {
  method: 'POST', headers: AUTH, body: JSON.stringify({ autoUpdate: false }),
})).json();
check('保存设置返回成功(带回 settings)', !!(save && save.settings), JSON.stringify(save).slice(0, 200));
check('落库后 settings.autoUpdate=false', save && save.settings && save.settings.autoUpdate === false);
const chk2 = await (await fetch(BASE + '/api/admin/update/check', { headers: AUTH })).json();
check('再次检查仍返回 autoUpdate=false(说明是持久化的)', chk2.autoUpdate === false);

console.log('\n== 3. 面板:发布说明渲染成 Markdown 富文本 ==');
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
await page.addInitScript((t) => { localStorage.setItem('oc_token', t); }, login.token);
await page.goto(BASE + '/admin#platform/update', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#panel-update.active', { timeout: 30000 });
await page.waitForSelector('#upd-result:not(.hidden)', { timeout: 20000 });
await page.waitForTimeout(400);

const notes = await page.evaluate(() => {
  const el = document.getElementById('upd-notes');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    tag: el.tagName,
    h2: Array.from(el.querySelectorAll('h2')).map((x) => x.textContent.trim()),
    li: Array.from(el.querySelectorAll('li')).map((x) => x.textContent.trim()),
    strong: Array.from(el.querySelectorAll('strong')).map((x) => x.textContent.trim()),
    code: Array.from(el.querySelectorAll('code')).map((x) => x.textContent.trim()),
    link: (el.querySelector('a') || {}).href || '',
    text: el.innerText,
    whiteSpace: cs.whiteSpace,
    fontFamily: cs.fontFamily,
  };
});
console.log('   渲染结果: ' + JSON.stringify({ h2: notes && notes.h2, li: notes && notes.li, strong: notes && notes.strong, code: notes && notes.code }));
check('发布说明容器是块级 div(不再是被 <pre> 包住的等宽文本)',
  !!notes && notes.tag === 'DIV' && !/mono/i.test(notes.fontFamily));
check('## 标题渲染成 <h2>(实际 ' + JSON.stringify(notes && notes.h2) + ')',
  !!notes && notes.h2.some((t) => t.includes('更新内容')));
check('### 标题渲染成 <h3>', await page.locator('#upd-notes h3').count() > 0);
check('- 列表渲染成 <li>(实际 ' + JSON.stringify(notes && notes.li) + ')',
  !!notes && notes.li.some((t) => t.includes('开关样式')));
check('**加粗** 渲染成 <strong>', !!notes && notes.strong.some((t) => t.includes('开关样式')));
check('`反引号` 渲染成 <code>', !!notes && notes.code.some((t) => t.includes('自动更新')));
check('Markdown 链接渲染成 <a>', !!notes && notes.link.includes('example.com'));
check('原始 Markdown 记号没有漏出来(正文里不含 "## " 与 "- 修复")',
  !!notes && !notes.text.includes('## ') && !notes.text.includes('- 修复'),
  notes ? JSON.stringify(notes.text.slice(0, 120)) : '');

console.log('\n== 4. 面板:自动更新开关反映已保存的值 ==');
const autoChecked = await page.locator('#upd-auto').isChecked();
check('开关当前是关闭的(与第 2 步保存的值一致)', autoChecked === false);
check('页面没有出现真实的「一键更新」按钮被自动点掉', await page.locator('#upd-apply').isVisible());

console.log('\n== 5. 面板里打开开关后落库 ==');
await page.locator('#upd-auto + .slider').click();
await sleep(500);
const chk3 = await (await fetch(BASE + '/api/admin/update/check', { headers: AUTH })).json();
check('点开关后服务端 autoUpdate 变回 true(实际 ' + chk3.autoUpdate + ')', chk3.autoUpdate === true);

check('全程无页面级报错', pageErrors.length === 0);
if (pageErrors.length) console.log('    报错: ' + pageErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
