/* AI 整理弹窗浏览器自检(真 Chromium,真服务端 + mock 上游):
 *   node tests/notes-archive-gui.mjs
 *
 * 背景:「保存到 AI 笔记」的预览弹窗曾经必现崩溃——showArchivePlan 里
 * fillFolderOptions 先用后声明 syncFolderBox(const 暂时性死区 ReferenceError),
 * 于是弹窗只画出文件夹/标题/标签三个框,内容区空白、底部按钮根本没生成,
 * 用户既看不到笔记内容也无法保存(移动端与桌面表现一致)。
 * 单元测试碰不到这类 DOM 接线错误,必须用真浏览器按用户路径点一遍。
 *
 * 用例覆盖:
 *   1) 正常 JSON 计划 → 内容可见 + 保存按钮可用 + 落库成功(桌面);
 *   2) 移动视口(390×844)→ 内容可见、底部按钮在视口内可点、可保存;
 *   3) 弱模型畸形输出(裸换行 + 截断)→ 自动修复/降级,仍能进预览并保存。
 *
 * 需要 playwright 与 chromium;缺失时自动跳过并返回 0(不阻塞 CI)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8151);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8152);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'gui-pass' };
const ANSWER = '呷哺呷哺旗下的凑凑火锅主打火锅+茶饮双业态,客单价约 150 元,门店集中在一二线城市。';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 端口被残留的开发服务器占用时,请求会打到别的进程上(实测会拿到
// 另一个目录的 PHP 报错页,表现为「登录返回 HTML」),排查成本极高,直接提前报错。
async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似上一次测试残留的 php -S),请先结束该进程或用 GUI_PORT 换端口`);
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
  console.log('(skip) 未找到 playwright,跳过弹窗浏览器自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-gui-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
function spawnPhp(args, env) {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
}
function cleanup() {
  for (const p of procs) { try { p.kill(); } catch (e) {} }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', cleanup);

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
try { login = JSON.parse(loginText); } catch (e) {
  console.error(`✗ 登录响应不是 JSON(HTTP ${loginRes.status}): ` + loginText.slice(0, 300));
  process.exit(1);
}
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

// 归档走的是「辅助模型(notesModel)」优先:显式指定成 mock-archive,才能拿到归档用 JSON
const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'GUIMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-gui',
    apiFormat: 'chat', scope: 'global', costPerCall: 1, enabled: true,
    models: [{ id: 'mock-archive', name: 'Mock Archive' }],
  }),
})).json();
const PROV = provRes && provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }
// 归档要扣「笔记 AI」配额,放开到足够次数
await fetch(BASE + '/api/admin/settings', {
  method: 'POST', headers: AUTH, body: JSON.stringify({ notesAiDailyLimit: 999, notesEnabled: true }),
});

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.addInitScript(([token, prov]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_provider', prov);
  localStorage.setItem('oc_model_' + prov, 'mock-archive');
  // 归档的辅助模型偏好:providerId \n modelId(见 resolveAuxModel)
  localStorage.setItem('oc_pref_notesModel', prov + '\n' + 'mock-archive');
}, [login.token, PROV]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.OCApp && window.OCApp.state && window.OCApp.state.user), null, { timeout: 30000 });
await page.waitForFunction(() => !!(window.OCApp.state.models || []).length, null, { timeout: 30000 });
await page.evaluate(() => { if (window.OCNotes) window.OCNotes.warmUp(); });
await page.waitForFunction(() => !!(window.OCNotes && window.OCNotes.isReady && window.OCNotes.isReady()), null, { timeout: 30000 });

// 等价于点消息操作栏的「保存到 AI 笔记」
async function openArchive(answer) {
  await page.evaluate((ans) => {
    window.OCNotes.archiveFromMessage(
      { id: 'gui-chat', title: '火锅品牌调研' },
      { role: 'assistant', content: ans }
    );
  }, answer);
  await page.waitForSelector('#notes-ai-mask .modal', { timeout: 15000 });
}
async function resetNotes() {
  await page.evaluate(() => {
    const d = window.OCNotes._debug;
    d.doc.notes = [];
    d.doc.folders = d.doc.folders.filter((f) => f.id === 'uncat');
  });
}

console.log('== 1. 桌面:正常 JSON 计划 → 预览可见 + 可保存 ==');
{
  await openArchive(ANSWER);
  await page.waitForSelector('#nai-save', { timeout: 30000 });
  const txt = await page.locator('#nai-preview').innerText().catch(() => '');
  check('预览区显示笔记内容', txt.includes('凑凑火锅'));
  check('底部「保存」按钮已生成', await page.locator('#nai-save').count() === 1);
  // 曾经有两个保存按钮(直接保存=AI 推荐 / 确认保存=表单值),后者语义上会被前者覆盖,
  // 用户改完标题再点「直接保存」就把改动冲掉了。现在只保留一个。
  check('不再有第二个保存按钮(直接保存已合并)', await page.locator('#nai-quick').count() === 0);
  check('文件夹下拉已换成站内控件', await page.locator('.nai-folder-box').count() === 1);
  check('显示了 AI 归档理由', (await page.locator('.nai-reason').innerText()).length > 4);
  check('新建文件夹名已回填', (await page.locator('#nai-newfolder').inputValue()).includes('餐饮'));

  // 「查看 Markdown 源码」:必须真的显示源码(预览隐藏)且可直接编辑
  check('初始状态:预览可见、源码框隐藏',
    await page.locator('#nai-preview').isVisible() && !(await page.locator('#nai-ta').isVisible()));
  await page.locator('#nai-toggle').click();
  check('切到源码:预览隐藏、源码框可见',
    !(await page.locator('#nai-preview').isVisible()) && (await page.locator('#nai-ta').isVisible()));
  const srcVisible = await page.evaluate(() => {
    const ta = document.getElementById('nai-ta');
    const r = ta.getBoundingClientRect();
    return { h: r.height, w: r.width, top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  check('源码框在视口内可见(没有被预览挤到屏幕外)',
    srcVisible.h > 40 && srcVisible.w > 40 && srcVisible.bottom > 0 && srcVisible.top < srcVisible.vh);
  check('源码框不是只读', await page.locator('#nai-ta').evaluate((el) => !el.readOnly));
  // 真的敲进去:编辑后的正文要在保存时生效
  await page.locator('#nai-ta').click();
  await page.locator('#nai-ta').press('End');
  await page.locator('#nai-ta').type('\n\n用户追加的关键结论：门店扩张速度快。');
  await page.locator('#nai-toggle').click();
  check('切回渲染:源码框隐藏、预览恢复',
    await page.locator('#nai-preview').isVisible() && !(await page.locator('#nai-ta').isVisible()));

  // 改过的标题 + 改过的正文都要落库(单按钮 = 以表单当前值为准)
  await page.locator('#nai-title').fill('我改过的标题');
  const box = await page.locator('#nai-save').boundingBox();
  check('保存按钮可见可点', !!box && box.width > 0 && box.height > 0);
  await page.locator('#nai-save').click();
  await page.waitForFunction(() => (window.OCNotes._debug.doc.notes || []).length > 0, null, { timeout: 20000 });
  const saved = await page.evaluate(() => {
    const n = window.OCNotes._debug.doc.notes[0];
    return { title: n.title, content: n.content, folderId: n.folderId, folder: window.OCNotes._debug.doc.folders.find((f) => f.id === n.folderId) };
  });
  check('笔记已落库', !!saved && saved.content.includes('凑凑火锅'));
  check('归档到新建的「餐饮品牌」文件夹', !!saved.folder && saved.folder.name.indexOf('餐饮') >= 0);
  check('保存的是用户改过的标题(不是 AI 推荐值)', saved.title === '我改过的标题');
  check('保存的是用户改过的源码正文', saved.content.includes('门店扩张速度快'));
  check('正文带「来源」区块', saved.content.includes('## 来源'));
  // 关闭有 ~340ms 退场动画,等它真的从 DOM 移除
  const closed = await page.waitForFunction(() => !document.getElementById('notes-ai-mask'), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('弹窗已关闭', closed);
}
await resetNotes();

console.log('\n== 2. 移动视口(390×844):内容可见 + 按钮在视口内 ==');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await openArchive(ANSWER);
  await page.waitForSelector('#nai-save', { timeout: 30000 });
  const txt = await page.locator('#nai-preview').innerText().catch(() => '');
  check('移动端预览区有内容', txt.includes('凑凑火锅'));
  const box = await page.locator('#nai-save').boundingBox();
  check('保存按钮在视口内(未被挤出屏幕)', !!box && box.y >= 0 && (box.y + box.height) <= 844);
  const modal = await page.locator('.notes-ai-modal').boundingBox();
  check('弹窗不超出视口宽度', !!modal && modal.x >= -0.5 && (modal.x + modal.width) <= 390.5);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('页面无横向溢出', overflowX <= 1);
  // 真实点击(不是 evaluate 调用),验证按钮真的可达
  await page.locator('#nai-save').click();
  await page.waitForFunction(() => (window.OCNotes._debug.doc.notes || []).length > 0, null, { timeout: 20000 });
  ok('移动端点击保存成功落库');
  await page.setViewportSize({ width: 1280, height: 900 });
}
await resetNotes();

console.log('\n== 3. 弱模型畸形输出(裸换行 + 截断)→ 修复后仍可预览与保存 ==');
{
  // 提示词里带上暗号,让 mock 上游返回坏 JSON(字符串内裸换行 + 括号未闭合);
  // 期望:客户端修复解析后**直接进入预览**,而不是掉进兜底。
  await openArchive('弱模型复现:' + ANSWER);
  const gotPlan = await page.waitForSelector('#nai-save', { timeout: 60000 }).then(() => true).catch(() => false);
  if (!gotPlan) {
    // 两轮都失败时会给出「重试 / 直接保存原文」的兜底界面,这也是可用状态
    const errVisible = await page.locator('#nai-raw').count() === 1;
    check('坏输出时给出「直接保存原文」兜底(未死锁)', errVisible);
  } else {
    ok('坏输出被修复,直接进入预览');
    const ta = await page.locator('#nai-ta').inputValue();
    check('修复后正文完整可用', ta.includes('凑凑火锅') && ta.includes('客单价'));
    check('修复后标题取自返回内容', (await page.locator('#nai-title').inputValue()).includes('弱模型'));
    await page.locator('#nai-save').click();
    await page.waitForFunction(() => (window.OCNotes._debug.doc.notes || []).length > 0, null, { timeout: 20000 });
    ok('坏输出场景仍可保存');
  }
}
await resetNotes();

console.log('\n== 4. 关闭弹窗后迟到的响应不再写回(放弃整理)==');
{
  await openArchive(ANSWER);
  // 立刻按 Esc 关掉(请求可能还在路上),再等一会儿看迟到的响应会不会把它顶回来
  await page.keyboard.press('Escape');
  await sleep(4500);
  const visible = await page.locator('#notes-ai-mask').isVisible().catch(() => false);
  check('按 Esc 关闭后弹窗保持关闭(迟到的响应没有把它复活)', !visible);
  // 关掉这一轮,避免影响后续用例
  await page.evaluate(() => { const m = document.getElementById('notes-ai-mask'); if (m) m.remove(); });
}

console.log('\n== 5. 弹窗无 JS 异常(含 TDZ 崩溃回归点)==');
{
  const relevant = pageErrors.filter((e) => /syncFolderBox|Cannot access|nai|archive/i.test(e));
  check('无「Cannot access ... before initialization」等异常'
    + (relevant.length ? ': ' + relevant.slice(0, 2).join(' | ') : ''), relevant.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ AI 整理弹窗自检失败: ${fail} 项` : `✓ AI 整理弹窗自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
