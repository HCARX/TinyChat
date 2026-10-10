/* 笔记 AI 交互自检(真 Chromium + 真服务端):
 *   node tests/notes-ai-interactions-gui.mjs
 *
 * 锁住两处新增的 AI 交互(修复前必失败):
 *   1) 笔记列表右键菜单里的「AI」组:生成标题 / 推荐标签 / 生成摘要,
 *      不必先打开笔记就能跑;生成标题要走确认框,标签要真的落到笔记 tags。
 *   2) AI 改写对照预览:选中文字跑 AI 编辑、以及「写入摘要」这类整篇动作,
 *      结果先弹左右对照(修改前/修改后),点「应用」才写回 —— 而不是直接插入。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8241);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8242);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'notes-ai-pass' };

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
  console.log('(skip) 未找到 playwright,跳过笔记 AI 交互自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-notes-ai-' + Date.now());
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
const userId = login.user && login.user.id;

const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'NotesAiMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-notes-ai',
    apiFormat: 'chat', scope: 'global', costPerCall: 1, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes && provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败'); process.exit(1); }
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ notesEnabled: true, notesAiDailyLimit: 200 }) });
await fetch(BASE + '/api/sync/notes', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    baseRevision: 0,
    doc: {
      folders: [
        { id: 'uncat', parentId: null, name: '默认分类', createdAt: 1, updatedAt: 1, system: true },
        { id: 'ai', parentId: null, name: 'AI 测试夹', createdAt: 2, updatedAt: 2 },
      ],
      notes: [{
        id: 'nai1', folderId: 'ai', title: '未命名草稿',
        content: '第一段：介绍容器查询的基本概念。\n\n第二段：说明它和媒体查询的区别。', tags: [], isPinned: false,
        shareMode: 'private', createdAt: 3, updatedAt: 3,
      }],
      tombs: {},
    },
  }),
});

const browser = await pw.chromium.launch();

async function boot() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.addInitScript(([token, prov, uid]) => {
    localStorage.setItem('oc_token', token);
    localStorage.setItem('oc_provider', prov);
    localStorage.setItem('oc_model_' + prov, 'mock-model');
    localStorage.setItem('oc_notes_guide_seen', '1');
    localStorage.setItem('oc_notes_ui_' + uid, JSON.stringify({ folderId: 'ai', mode: 'edit', expanded: { ai: true } }));
  }, [login.token, PROV, userId]);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
  await page.evaluate(() => { if (window.OCNotes) window.OCNotes.warmUp(); });
  await page.waitForFunction(() => !!(window.OCNotes && window.OCNotes.isReady && window.OCNotes.isReady()), null, { timeout: 30000 });
  await page.evaluate(() => window.OCNotes.open());
  await page.waitForSelector('.notes-fs', { timeout: 20000 });
  await sleep(600);
  return { ctx, page, errs };
}

let pass1 = true;
const { page, errs } = await boot();

// ============ 1. 列表右键菜单的 AI 组 ============
console.log('== 1. 笔记列表右键菜单新增「AI」组 ==');
{
  const row = page.locator('.notes-side .nt-note', { hasText: '未命名草稿' }).first();
  check('列表里能看到目标笔记', await row.count() === 1);
  await row.locator('.notes-row-more').click();
  await sleep(400);
  const menu = page.locator('.oc-menu');
  check('右键菜单打开', await menu.count() >= 1);
  const texts = await menu.first().innerText();
  check('菜单出现「AI」分组标题', /(^|\n)\s*AI\s*(\n|$)/.test(texts));
  check('含「生成标题」项', texts.includes('生成标题'));
  check('含「推荐标签」项', texts.includes('推荐标签'));
  check('含「生成摘要」项', texts.includes('生成摘要'));
  check('原有项未被破坏(仍有「重命名」「导出」)', texts.includes('重命名') && texts.includes('导出'));

  console.log('\n== 2. 列表页「推荐标签」真的落到笔记 ==');
  await menu.locator('.oc-menu-item', { hasText: '推荐标签' }).first().click();
  await sleep(2500);
  const tags = await page.evaluate(() => {
    const n = (window.OCNotes._debug && window.OCNotes._debug.doc.notes || []).find((x) => x.id === 'nai1');
    return (n && n.tags) || [];
  });
  // mock 上游把所有补全都回 MOCK-REPLY,标签解析后应非空
  check('标签已写入笔记(' + JSON.stringify(tags) + ')', Array.isArray(tags) && tags.length > 0);

  console.log('\n== 3. 列表页「生成标题」需确认,确认后标题更新 ==');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
  await page.evaluate(() => window.OCNotes.open());
  await page.waitForSelector('.notes-fs', { timeout: 20000 });
  await sleep(600);
  const row2 = page.locator('.notes-side .nt-note', { hasText: '未命名草稿' }).first();
  await row2.locator('.notes-row-more').click();
  await sleep(400);
  await page.locator('.oc-menu .oc-menu-item', { hasText: '生成标题' }).first().click();
  await sleep(2500);
  const confirm = page.locator('.oc-confirm-mask');
  check('生成标题弹出确认框(不直接改)', await confirm.count() === 1);
  if (await confirm.count() === 1) {
    const cmsg = await confirm.locator('.confirm-message').innerText().catch(() => '');
    check('确认框同时展示原标题与新标题', cmsg.includes('未命名草稿') && cmsg.includes('MOCK-REPLY'));
    await confirm.locator('[data-act="ok"]').click();
    await sleep(1200);
    const title = await page.evaluate(() => {
      const n = (window.OCNotes._debug && window.OCNotes._debug.doc.notes || []).find((x) => x.id === 'nai1');
      return n && n.title;
    });
    check('确认后标题已更新为模型结果(' + title + ')', title !== '未命名草稿' && !!title);
  } else {
    bad('未弹出确认框,跳过后续断言');
  }
}

// ============ 4. 选中文字 AI 编辑 → 对照预览 ============
console.log('\n== 4. 选中文字 AI 编辑先弹对照预览,应用后才写回 ==');
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
  await page.evaluate(() => window.OCNotes.open());
  await page.waitForSelector('.notes-fs', { timeout: 20000 });
  await sleep(600);
  await page.locator('.notes-side .nt-note', { hasText: 'AI 测试夹' }).first().click().catch(() => {});
  await page.locator('.notes-side .nt-note').first().click();
  await sleep(900);
  const ta = page.locator('#ne-ta');
  check('编辑器打开且编辑区可见', await ta.isVisible());
  // 选中第一段文字
  await page.evaluate(() => {
    const t = document.querySelector('#ne-ta');
    t.focus();
    const i = t.value.indexOf('容器查询');
    t.setSelectionRange(i, i + 4);
  });
  const before = await ta.inputValue();
  // 打开 AI 右键菜单:派发 contextmenu 事件(带坐标)
  await page.evaluate(() => {
    const t = document.querySelector('#ne-ta');
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 }));
  });
  await sleep(400);
  const cmenu = page.locator('.notes-ctx-menu');
  check('选中文字右键菜单打开', await cmenu.count() >= 1);
  const cm = await cmenu.first().innerText().catch(() => '');
  check('菜单出现「AI 编辑」区', cm.includes('AI 编辑'));
  const aiBtn = cmenu.locator('[data-ai]').first();
  check('至少有 1 个可用的 AI 动作(默认启用内置动作)', await aiBtn.count() >= 1);
  await aiBtn.click();
  await sleep(2800);
  const diff = page.locator('.notes-tidy-modal');
  check('AI 编辑弹出左右对照预览(此前是直接插入)', await diff.count() === 1);
  if (await diff.count() === 1) {
    const heads = await diff.innerText();
    check('对照两侧标注「修改前」「修改后」', heads.includes('修改前') && heads.includes('修改后'));
    const valBeforeApply = await ta.inputValue();
    check('应用前正文未被改动', valBeforeApply === before);
    await diff.locator('#tidy-apply').click();
    await sleep(900);
    const valAfter = await ta.inputValue();
    check('点「替换选中内容」后正文发生变化', valAfter !== before);
    // 必须真的替换选区,而不是把结果追加到光标处:原选中词只出现一次,替换后应消失,
    // 且模型结果落在原选中位置(在「第二段」之前)。
    check('选中处被替换(原「容器查询」不再出现)', !valAfter.includes('容器查询'));
    check('模型结果落在原选中位置', valAfter.indexOf('MOCK-REPLY') >= 0 && valAfter.indexOf('MOCK-REPLY') < valAfter.indexOf('第二段'));
  } else {
    bad('未弹出对照预览,跳过后续断言');
  }
}

// ============ 5. 整篇动作(写入摘要)也走对照预览 ============
console.log('\n== 5. 「写入摘要」整篇动作也先预览再应用 ==');
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
  await page.evaluate(() => window.OCNotes.open());
  await page.waitForSelector('.notes-fs', { timeout: 20000 });
  await sleep(600);
  await page.locator('.notes-side .nt-note').first().click();
  await sleep(900);
  const contentBefore = await page.locator('#ne-ta').inputValue();
  await page.locator('#ne-ai').click();
  await sleep(400);
  const ai = page.locator('.oc-menu .oc-menu-item', { hasText: '写入摘要' }).first();
  check('全文 AI 菜单含「写入摘要」', await ai.count() === 1);
  await ai.click();
  await sleep(3000);
  const diff = page.locator('.notes-tidy-modal');
  check('写入摘要弹出对照预览', await diff.count() === 1);
  if (await diff.count() === 1) {
    const after = await page.locator('#ne-ta').inputValue();
    check('应用前正文未被改动', after === contentBefore);
    await diff.locator('#tidy-apply').click();
    await sleep(1000);
    const applied = await page.locator('#ne-ta').inputValue();
    check('应用后正文前部出现摘要引用块', applied.includes('**摘要**'));
  } else {
    bad('未弹出摘要预览,跳过后续断言');
  }
}

console.log('\n== 6. 无 JS 异常 ==');
const real = errs.filter((e) => !/favicon|Failed to load resource|net::|ERR_/i.test(e));
check('全程无未捕获异常' + (real.length ? ': ' + real.slice(0, 2).join(' | ') : ''), real.length === 0);

await browser.close();
console.log('\n' + (fail ? `✗ 笔记 AI 交互自检失败: ${fail} 项` : `✓ 笔记 AI 交互自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
