/* 对话重命名 GUI 自检(真 Chromium + 真服务端):
 *   node tests/chat-rename-gui.mjs
 *
 * 锁住一个把「重命名」整个弄坏的缺陷:会话项整行挂了 click → onSelect,而 onSelect 会重渲染
 * 整份侧栏列表。用户在重命名输入框里点一下(想定位光标/选中文字)时,这个点击冒泡到会话项,
 * 立刻选中会话 → 列表重渲染 → 输入框被替换 → 触发 blur → 按原值提交关闭。
 * 用户看到的就是「点一下还没改就保存了,根本点不进去修改」。
 *
 * 断言的是修复后的契约:点进输入框后仍处于编辑态、内容可改、回车才提交。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8181);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'rename-pass' };

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
if (!pw) { console.log('(skip) 未找到 playwright,跳过重命名 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-rename-' + Date.now());
mkdirSync(TMP, { recursive: true });
let app = null;
function cleanup() {
  try { if (app) app.kill(); } catch (e) { /* 忽略 */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.on('exit', cleanup);

app = spawn('php', ['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
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
  console.error('✗ 应用服务未启动\n' + appErr.slice(-1500));
  process.exit(1);
}

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));

// 造两条对话:重命名不依赖模型/供应商,直接写本地会话即可
await page.addInitScript(([token, uid]) => {
  localStorage.setItem('oc_token', token);
  const now = Date.now();
  localStorage.setItem('oc_chats_' + uid, JSON.stringify([
    { id: 'cr1', title: '原始标题一', messages: [{ role: 'user', content: 'hi' }], createdAt: now, updatedAt: now },
    { id: 'cr2', title: '原始标题二', messages: [], createdAt: now - 1000, updatedAt: now - 1000 },
  ]));
}, [login.token, login.user.id]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForSelector('.chat-item-wrap', { timeout: 20000 });

const titles = () => page.evaluate(() => Array.from(document.querySelectorAll('.chat-title')).map((e) => e.textContent));
// 编辑中时被改名的那一项没有 .chat-title(已被输入框替换),所以「有没有误提交」要看
// 真实会话数据,而不是 DOM 上的标题文本。
const chatTitle = (id) => page.evaluate((cid) => {
  const c = ((window.OCApp.state.chats) || []).find((x) => x.id === cid) || {};
  return c.title;
}, id);
check('侧栏显示两条对话', (await titles()).length === 2);

// 打开第一项的「更多」→「重命名」。菜单按钮是 hover 才显示,用真实鼠标移动触发。
async function openRename(index) {
  const wrap = page.locator('.chat-item-wrap').nth(index);
  await wrap.hover();
  await sleep(250);
  await wrap.locator('.more-btn').click();
  await page.waitForSelector('.oc-menu', { timeout: 8000 });
  await page.locator('.oc-menu-item', { hasText: '重命名' }).first().click();
  await page.waitForSelector('.rename-input', { timeout: 8000 });
  await sleep(250);
}

console.log('== 1. 点进重命名输入框后必须仍是编辑态(不能一点就保存) ==');
await openRename(0);
check('重命名输入框出现且获焦', await page.evaluate(() => {
  const i = document.querySelector('.rename-input');
  return !!i && document.activeElement === i;
}));
const beforeValue = await page.evaluate(() => (document.querySelector('.rename-input') || {}).value);
check('输入框带出原标题(实际「' + beforeValue + '」)', beforeValue === '原始标题一');
// 关键动作:在输入框内部点一下(用户想定位光标)
await page.locator('.rename-input').click();
await sleep(500);
check('点进输入框后仍在编辑(输入框没被重渲染掉)', await page.evaluate(() => !!document.querySelector('.rename-input')));
check('点进后焦点仍在输入框', await page.evaluate(() => {
  const i = document.querySelector('.rename-input');
  return !!i && document.activeElement === i;
}));
check('点进输入框没有误提交(标题未变)', (await chatTitle('cr1')) === '原始标题一');

console.log('== 2. 编辑内容后回车才提交 ==');
await page.locator('.rename-input').fill('改过的标题一');
await sleep(200);
check('输入过程中仍是编辑态、内容已改', await page.evaluate(() => {
  const i = document.querySelector('.rename-input');
  return !!i && i.value === '改过的标题一';
}));
await page.locator('.rename-input').press('Enter');
await sleep(800);
check('回车后输入框收起', await page.evaluate(() => !document.querySelector('.rename-input')));
check('回车后标题落库为改过的值(实际 ' + JSON.stringify(await titles()) + ')', (await titles()).includes('改过的标题一'));

console.log('== 3. Esc 取消不写回 ==');
await openRename(1);
await page.locator('.rename-input').fill('不该保存的名字');
await page.locator('.rename-input').press('Escape');
await sleep(700);
check('Esc 后输入框收起', await page.evaluate(() => !document.querySelector('.rename-input')));
check('Esc 后保留原标题、未写回改动', (await titles()).includes('原始标题二'));

console.log('== 4. 重命名不影响点选会话 ==');
// 点会话项空白处仍应切换当前会话
await page.locator('.chat-item-wrap').nth(0).locator('.chat-item').click();
await sleep(700);
check('点整行仍能选中会话', await page.evaluate(() => {
  const s = window.OCApp.state;
  return String(s.currentChatId || '') === 'cr1' || String(s.currentChatId || '') === 'cr2';
}));

check('全程无页面级报错', pageErrors.length === 0);
if (pageErrors.length) console.log('    报错: ' + pageErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
