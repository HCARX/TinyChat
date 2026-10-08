/* 移动端笔记侧边栏自检(真 Chromium + 真服务端):
 *   node tests/notes-mobile-gui.mjs
 *
 * 背景:笔记模块的文件夹/笔记树在窄屏是「抽屉」设计,但 CSS 只写了
 * .notes-side { transform: translateX(-100%) }(藏起来),
 * 全站没有任何一条规则把关掉的侧栏拉回屏内,也没有 .side-open 之类的开启态;
 * 侧栏浮标调用的 toggleSide() 只切 .side-collapsed,在窄屏同样落在
 * 「永远 -100%」上。结果是手机上文件夹/笔记树根本无法加载/打开,
 * 用户点浮标没有任何反应。
 *
 * 用例:窄屏(390×844)下打开笔记 → 点浮标 → 侧栏必须真的进入视口;
 *       点笔记后抽屉收起、笔记可编辑;宽屏行为不受影响。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8161);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8162);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'mob-pass' };
const W = 390, H = 844;

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
  console.log('(skip) 未找到 playwright,跳过移动端侧栏自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-mob-' + Date.now());
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

const loginRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
});
const loginText = await loginRes.text();
let login = {};
try { login = JSON.parse(loginText); } catch (e) { console.error('✗ 登录响应非 JSON: ' + loginText.slice(0, 300)); process.exit(1); }
if (!login.token) { console.error('✗ 管理员登录失败'); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'MobMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-mob',
    apiFormat: 'chat', scope: 'global', costPerCall: 1, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes && provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ notesEnabled: true }) });

// 预置一个文件夹 + 若干笔记,确保树上真的有东西可加载
await fetch(BASE + '/api/sync/notes', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    baseRevision: 0,
    doc: {
      folders: [
        { id: 'uncat', parentId: null, name: '默认分类', createdAt: 1, updatedAt: 1, system: true },
        { id: 'fmob', parentId: null, name: '移动端测试夹', createdAt: 2, updatedAt: 2 },
      ],
      notes: [
        { id: 'nmob1', folderId: 'fmob', title: '移动端笔记一', content: '# 标题\n\n正文内容一', tags: ['移动'], isPinned: false, shareMode: 'private', createdAt: 3, updatedAt: 3 },
        { id: 'nmob2', folderId: 'uncat', title: '移动端笔记二', content: '正文内容二', tags: [], isPinned: false, shareMode: 'private', createdAt: 4, updatedAt: 4 },
      ],
      tombs: {},
    },
  }),
});

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.addInitScript(([token, prov]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_provider', prov);
  localStorage.setItem('oc_model_' + prov, 'mock-model');
  // 跳过首次进入的「欢迎使用 AI 笔记」引导弹窗,否则它会盖住侧栏浮标
  localStorage.setItem('oc_notes_guide_seen', '1');
}, [login.token, PROV]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForFunction(() => !!(window.OCApp.state.models || []).length, null, { timeout: 30000 });
await page.evaluate(() => { if (window.OCNotes) window.OCNotes.warmUp(); });
await page.waitForFunction(() => !!(window.OCNotes && window.OCNotes.isReady && window.OCNotes.isReady()), null, { timeout: 30000 });
await page.evaluate(() => window.OCNotes.open());
await page.waitForSelector('.notes-fs', { timeout: 20000 });
await sleep(600);

const sideBox = () => page.locator('.notes-side').boundingBox();
const inViewport = (b) => !!b && b.x + b.width > 2 && b.x < W - 2;

console.log('== 1. 窄屏:侧栏(文件夹/笔记树)能否打开 ==');
{
  const before = await sideBox();
  check('初始状态下侧栏藏在屏外(抽屉关闭)', !inViewport(before));

  const floatBtn = page.locator('#notes-side-float');
  check('窄屏下侧栏浮标可见(用户能找到入口)', await floatBtn.isVisible());
  await floatBtn.click();
  await sleep(500);
  const after = await sideBox();
  check('点浮标后侧栏进入视口(此前恒为 -100%,点了没反应)', inViewport(after));
  check('侧栏在屏内且宽度可用', !!after && after.width >= 200);

  // 树里必须真的有内容
  const rows = await page.locator('.notes-side .notes-folder-row').count();
  check('侧栏加载出文件夹行', rows >= 2);
  const noteRows = await page.locator('.notes-side .nt-note').count();
  check('侧栏加载出笔记行', noteRows >= 1);
  check('侧栏文字可见(不是空白)', (await page.locator('.notes-side').innerText()).includes('移动端测试夹'));
}

console.log('\n== 2. 窄屏:点笔记后抽屉收起且能编辑 ==');
{
  await page.locator('.notes-side .nt-note', { hasText: '移动端笔记一' }).first().click();
  await sleep(600);
  const after = await sideBox();
  check('选中笔记后抽屉自动收起(不挡正文)', !inViewport(after));
  const ta = page.locator('#ne-ta');
  check('编辑器已载入该笔记正文', (await ta.inputValue()).includes('正文内容一'));

  // 回到侧栏切换另一篇
  await page.locator('#notes-side-float').click();
  await sleep(500);
  check('再次打开抽屉可用', inViewport(await sideBox()));
  await page.locator('.notes-side .nt-note', { hasText: '移动端笔记二' }).first().click();
  await sleep(600);
  check('切换到第二篇笔记', (await page.locator('#ne-ta').inputValue()).includes('正文内容二'));
}

console.log('\n== 3. 窄屏:抽屉不应盖住整屏 / 无横向溢出 ==');
{
  await page.locator('#notes-side-float').click();
  await sleep(500);
  const b = await sideBox();
  check('抽屉宽度小于屏宽(留出正文可见区域)', !!b && b.width < W - 40);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('页面无横向溢出', overflowX <= 1);
  // 有遮罩时点遮罩应关闭
  const scrim = page.locator('.notes-side-scrim');
  if (await scrim.count()) {
    await scrim.click({ position: { x: W - 30, y: 400 } });
    await sleep(500);
    check('点遮罩收起抽屉', !inViewport(await sideBox()));
  } else {
    bad('缺少抽屉遮罩(.notes-side-scrim):点空白无法收起');
  }
}

console.log('\n== 4. 窄屏:侧栏拖拽调宽条不得压在正文上 ==');
{
  // 拖拽条绝对定位(left: var(--notes-side-w, 280px); z-index 26),靠它拖动改侧栏宽度。
  // 窄屏抽屉宽度固定、不需要调宽,但这条 7px 竖带仍然存在:正文占满整宽时它正好
  // 横穿正文,手指点到这一带命中拖拽条而不是文字,光标放不下去。
  const hits = await page.evaluate(() => {
    const rz = document.getElementById('notes-side-resizer');
    if (!rz) return null;
    const r = rz.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const at = [160, 300, 460].map((y) => {
      const el = document.elementFromPoint(x, y);
      return el ? (el.id || el.className || el.tagName) : null;
    });
    return { display: getComputedStyle(rz).display, x: x, at: at };
  });
  check('窄屏下拖拽条不参与指针命中(不横穿正文抢触摸)', !!hits && hits.display === 'none'
    && hits.at.every((h) => h !== 'notes-side-resizer'));
}

console.log('\n== 5. 宽屏行为不受影响 ==');
{
  await page.setViewportSize({ width: 1280, height: 900 });
  await sleep(700);
  const b = await sideBox();
  check('宽屏下侧栏常驻可见', !!b && b.x >= -1 && b.width >= 200);
  check('宽屏下不显示抽屉遮罩', !(await page.locator('.notes-side-scrim').isVisible().catch(() => false)));
  // 窄屏隐藏拖拽条是为了不抢正文触摸;宽屏的拖拽调宽必须还在
  const rz = await page.locator('#notes-side-resizer').isVisible().catch(() => false);
  check('宽屏下拖拽调宽条仍然可用', rz);
}

console.log('\n== 6. 无 JS 异常 ==');
{
  const relevant = pageErrors.filter((e) => /notes|sidebar|side/i.test(e));
  check('笔记模块无 JS 异常' + (relevant.length ? ': ' + relevant.slice(0, 2).join(' | ') : ''), relevant.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ 移动端侧栏自检失败: ${fail} 项` : `✓ 移动端侧栏自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
