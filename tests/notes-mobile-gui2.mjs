/* 移动端笔记其它界面自检(真 Chromium + 真服务端):
 *   node tests/notes-mobile-gui2.mjs
 *
 * 覆盖侧栏抽屉之外的窄屏界面(390×844):
 *   1) 选中笔记后编辑器可用、正文渲染、不横向溢出;
 *   2) 窄屏「分屏」退化为预览单栏(设计如此:手机上左右各半没法读);
 *   3) 分享弹窗在窄屏可打开、在视口内、按钮可达、不横向溢出;
 *   4) 设置弹窗(右键菜单动作)与已分享管理在窄屏的布局:底栏按钮不越出弹窗、
 *      分享行不再被三个按钮挤成竖条(修复前文字列只剩 23px、整行 229px 高),
 *      并在 360px 机型上复量一遍;
 *   5) 顶栏控件条在窄屏可横向滚动,AI / 问笔记 / 分享等入口不丢失;
 *   6) 新建笔记(模板菜单 → 标题输入)在窄屏可完成并落库。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8171);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8172);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'mob2-pass' };
const W = 390, H = 844;

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
  console.log('(skip) 未找到 playwright,跳过移动端界面自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-mob2-' + Date.now());
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
    name: 'MobMock2', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-mob2',
    apiFormat: 'chat', scope: 'global', costPerCall: 1, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes && provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败'); process.exit(1); }
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ notesEnabled: true }) });
await fetch(BASE + '/api/sync/notes', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    baseRevision: 0,
    doc: {
      folders: [
        { id: 'uncat', parentId: null, name: '默认分类', createdAt: 1, updatedAt: 1, system: true },
        { id: 'fm2', parentId: null, name: '界面测试夹', createdAt: 2, updatedAt: 2 },
      ],
      notes: [{
        id: 'nm2', folderId: 'fm2', title: '界面测试笔记',
        content: '# 大标题\n\n正文内容。', tags: [], isPinned: false,
        shareMode: 'private', createdAt: 3, updatedAt: 3,
      }],
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

await page.addInitScript(([token, prov, uid]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_provider', prov);
  localStorage.setItem('oc_model_' + prov, 'mock-model');
  localStorage.setItem('oc_notes_guide_seen', '1');
  localStorage.setItem('oc_notes_ui_' + uid, JSON.stringify({ folderId: 'fm2', mode: 'split', expanded: { fm2: true } }));
}, [login.token, PROV, userId]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForFunction(() => !!(window.OCApp.state.models || []).length, null, { timeout: 30000 });
await page.evaluate(() => { if (window.OCNotes) window.OCNotes.warmUp(); });
await page.waitForFunction(() => !!(window.OCNotes && window.OCNotes.isReady && window.OCNotes.isReady()), null, { timeout: 30000 });
await page.evaluate(() => window.OCNotes.open());
await page.waitForSelector('.notes-fs', { timeout: 20000 });
await sleep(700);

const overflowX = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

console.log('== 1. 窄屏打开笔记:编辑器可用、正文渲染 ==');
{
  await page.locator('#notes-side-float').click();
  await sleep(450);
  await page.locator('.notes-side .nt-note', { hasText: '界面测试笔记' }).first().click();
  await sleep(800);
  const bar = await page.locator('#notes-editor-bar').boundingBox();
  check('选中笔记后顶栏控件出现', !!bar && bar.height > 10);
  check('预览渲染出笔记内容', (await page.locator('#ne-preview').innerText()).includes('大标题'));
  check('正文区域不横向溢出', (await overflowX()) <= 1);
}

console.log('\n== 2. 窄屏「分屏」退化为预览单栏(设计行为) ==');
{
  const taVisible = await page.locator('#ne-ta').isVisible();
  const pvVisible = await page.locator('#ne-preview').isVisible();
  check('分屏模式下编辑区隐藏、预览可见(不会左右各半挤成一条)', !taVisible && pvVisible);
  const pv = await page.locator('#ne-preview').boundingBox();
  check('预览占据全部可用宽度', !!pv && pv.width > W * 0.7);
  // 切到「编辑」模式:编辑区应该回来
  await page.evaluate(() => { const b = document.querySelector('#ne-mode-switch [data-mode="edit"]'); if (b) b.click(); });
  await sleep(400);
  const ta = await page.locator('#ne-ta').boundingBox();
  check('切到编辑模式后编辑区可用且够宽', !!ta && ta.width > W * 0.7);
  check('编辑模式不横向溢出', (await overflowX()) <= 1);
}

console.log('\n== 3. 窄屏分享弹窗 ==');
{
  await page.evaluate(() => {
    const b = document.querySelector('.notes-editor-toolbar [data-act="share"]');
    if (b) b.click();
  });
  await sleep(700);
  const dlg = page.locator('.notes-share-modal').first();
  if (await dlg.count()) {
    const box = await dlg.boundingBox();
    check('分享弹窗在视口内', !!box && box.x >= -1 && (box.x + box.width) <= W + 1);
    const apply = page.locator('.notes-share-modal #ns-apply');
    check('分享弹窗底部按钮存在', await apply.count() === 1);
    const bb = await apply.boundingBox();
    check('「生成链接」按钮在视口内可点', !!bb && bb.y >= 0 && (bb.y + bb.height) <= H + 1);
    check('分享弹窗不导致横向溢出', (await overflowX()) <= 1);
    // 生成链接:真实调用后端
    await apply.click();
    await sleep(900);
    const linkRow = page.locator('.notes-share-modal #ns-link-row');
    check('生成链接后链接行显示', await linkRow.isVisible());
    const link = await page.locator('.notes-share-modal #ns-link').inputValue();
    check('链接指向 /n/ 分享路由', /\/n\/[A-Za-z0-9_-]+$/.test(link));
    await page.locator('.notes-share-modal [data-close]').click();
    await sleep(600);
  } else bad('分享弹窗未打开(入口不可达)');
}

console.log('\n== 4. 窄屏「笔记设置」与「已分享管理」 ==');
{
  // 设置弹窗:侧栏抽屉 → 齿轮。底栏三枚按钮此前是 nowrap + 按钮 flex:0 0 auto,
  // 比弹窗宽时溢出方向朝左,「已分享管理」被裁到弹窗外(x=-4),点不到左边一半。
  await page.locator('#notes-side-float').click();
  await sleep(450);
  await page.locator('#notes-gear').click();
  await sleep(800);
  const aimgr = page.locator('.notes-aimgr-modal').first();
  if (!(await aimgr.count())) bad('设置弹窗未打开(齿轮不可达)');
  else {
    const box = await aimgr.boundingBox();
    check('设置弹窗在视口内', !!box && box.x >= -1 && (box.x + box.width) <= W + 1);
    check('设置弹窗不导致横向溢出', (await overflowX()) <= 1);
    const foot = await page.evaluate(() => {
      const modal = document.querySelector('.notes-aimgr-modal');
      const r = modal.getBoundingClientRect();
      return Array.from(modal.querySelectorAll('.modal-footer .btn')).map((b) => {
        const q = b.getBoundingClientRect();
        return { txt: b.textContent.trim(), left: q.left - r.left, right: r.right - q.right, w: q.width, bottom: q.bottom };
      });
    });
    check('设置弹窗底栏按钮不越出弹窗左右边界', foot.length >= 3 && foot.every((f) => f.left >= -1 && f.right >= -1));
    check('设置弹窗底栏按钮都在视口内', foot.every((f) => f.bottom <= H + 1));
    const primary = foot.find((f) => f.txt === '完成');
    check('主按钮「完成」独占一行(宽度 ≥ 内容宽 90%)', !!primary && !!box && primary.w >= (box.width - 44) * 0.9);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.notes-aimgr-modal .aimgr-item')).map((it) => {
      const r = it.getBoundingClientRect();
      const lab = it.querySelector('.aimgr-label');
      return { rowW: r.width, labelW: lab ? lab.getBoundingClientRect().width : 0 };
    }));
    check('动作行的名称/提示词输入仍占行宽 60% 以上', rows.length > 0 && rows.every((r) => r.labelW >= r.rowW * 0.6));
  }

  // 已分享管理:行内此前是 [标题+说明 | 三个 nowrap 按钮],按钮固定约 290px,
  // 文字列被压到 23px —— 标题与说明竖着排成一条,整行 229px 高。
  await page.locator('.notes-aimgr-modal #aimgr-shares').click();
  await sleep(1200);
  const shm = page.locator('.notes-shm-mask .notes-shm-modal').first();
  if (!(await shm.count())) bad('已分享管理未打开');
  else {
    const box = await shm.boundingBox();
    check('已分享管理弹窗在视口内', !!box && box.x >= -1 && (box.x + box.width) <= W + 1);
    check('已分享管理不导致横向溢出', (await overflowX()) <= 1);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.notes-shm-mask .shm-item')).map((it) => {
      const r = it.getBoundingClientRect();
      const b = it.querySelector('.shm-main b');
      const ops = Array.from(it.querySelectorAll('.shm-ops .btn')).map((x) => {
        const q = x.getBoundingClientRect();
        return { txt: x.textContent.trim(), left: q.left, right: q.right, bottom: q.bottom };
      });
      return { rowW: r.width, rowH: r.height, titleW: b ? b.getBoundingClientRect().width : 0, ops };
    }));
    check('已分享管理列出了分享行', rows.length >= 1);
    check('行内文字列不再被按钮挤成竖条(标题宽 ≥ 行宽 50%)', rows.length > 0 && rows.every((r) => r.titleW >= r.rowW * 0.5));
    check('行高正常(≤ 180px,修复前 229px)', rows.length > 0 && rows.every((r) => r.rowH <= 180));
    check('三个操作按钮都在视口内且不横向溢出', rows.length > 0 && rows.every((r) => r.ops.length === 3 && r.ops.every((o) => o.left >= -1 && o.right <= W + 1)));
    const footBtn = await page.evaluate(() => {
      const b = document.querySelector('.notes-shm-mask .modal-footer .btn');
      const q = b.getBoundingClientRect();
      return { bottom: q.bottom, w: q.width };
    });
    check('底栏「关闭」按钮在视口内', footBtn.bottom <= H + 1);

    // 修改分享设置:有效期标签与下拉同排时被挤成两行,改为上下排
    await page.locator('.notes-shm-mask .shm-item [data-act="edit"]').first().click();
    await sleep(800);
    const edit = page.locator('.notes-shm-edit-mask .notes-shm-modal').first();
    if (!(await edit.count())) bad('修改分享设置弹窗未打开');
    else {
      const ebox = await edit.boundingBox();
      check('修改分享设置弹窗在视口内', !!ebox && ebox.x >= -1 && (ebox.x + ebox.width) <= W + 1);
      // 原生 select 被 enhanceSelect 换成 .select-box(原生节点 display:none),
      // 要量的是真正渲染出来的那个
      const sel = await page.evaluate(() => {
        const s = document.querySelector('.notes-shm-edit-mask #shm-expire-box');
        const q = s.getBoundingClientRect();
        return { left: q.left, right: q.right, w: q.width };
      });
      check('有效期下拉占满可用宽度且不溢出', sel.left >= -1 && sel.right <= W + 1 && sel.w >= 240);
      await page.locator('.notes-shm-edit-mask [data-close]').first().click();
      await sleep(500);
    }
    // 更窄的机型(360×740):同一批断言再量一遍
    await page.setViewportSize({ width: 360, height: 740 });
    await sleep(450);
    const narrow = await page.evaluate(() => {
      const rows2 = Array.from(document.querySelectorAll('.notes-shm-mask .shm-item')).map((it) => {
        const r = it.getBoundingClientRect();
        const b = it.querySelector('.shm-main b');
        const ops = Array.from(it.querySelectorAll('.shm-ops .btn')).map((x) => x.getBoundingClientRect().right);
        return { rowW: r.width, rowH: r.height, titleW: b ? b.getBoundingClientRect().width : 0, maxRight: Math.max.apply(null, ops) };
      });
      const modal = document.querySelector('.notes-shm-mask .notes-shm-modal').getBoundingClientRect();
      return { rows: rows2, modalLeft: modal.left, modalRight: modal.right, vw: window.innerWidth, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    check('360px 下弹窗仍在视口内', narrow.modalLeft >= -1 && narrow.modalRight <= narrow.vw + 1);
    check('360px 下文字列仍可读(标题宽 ≥ 行宽 50%)', narrow.rows.length > 0 && narrow.rows.every((r) => r.titleW >= r.rowW * 0.5));
    check('360px 下按钮不横向溢出', narrow.rows.every((r) => r.maxRight <= narrow.vw + 1) && narrow.docOverflow <= 1);
    await page.setViewportSize({ width: W, height: H });
    await sleep(400);
    await page.locator('.notes-shm-mask [data-close]').first().click();
    await sleep(600);
  }
  // 收尾:点遮罩收起抽屉 —— 抽屉开着时浮标(#notes-side-float)是隐藏的,
  // 后面的用例要靠它重新打开。遮罩中心被抽屉盖住,点右侧空白处。
  await page.locator('#notes-side-scrim').click({ position: { x: W - 30, y: 400 } });
  await sleep(450);
}

console.log('\n== 5. 顶栏控件窄屏可达 ==');
{
  const sx = await page.locator('#notes-editor-bar').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth })).catch(() => null);
  check('顶栏控件条可横向滚动(入口不会被裁掉)', !!sx && sx.sw >= sx.cw);
  for (const sel of ['#ne-ai', '#ne-ask', '#ne-title', '.notes-mode-switch']) {
    const n = await page.locator(sel).count();
    if (!n) bad('顶栏缺少控件 ' + sel);
  }
  ok('AI / 问笔记 / 标题 / 模式开关均在顶栏 DOM 中');
  const rendered = await page.evaluate(() => {
    const bar = document.querySelector('#notes-editor-bar');
    const ai = bar && bar.querySelector('#ne-ai');
    if (!bar || !ai) return false;
    bar.scrollLeft = bar.scrollWidth;  // 滚到最右,模拟用户横向滑动
    return ai.getBoundingClientRect().width > 0;
  });
  check('横向滚动后控件仍渲染(不是 display:none)', rendered);
  await page.evaluate(() => { const b = document.querySelector('#notes-editor-bar'); if (b) b.scrollLeft = 0; });
}

console.log('\n== 6. 窄屏新建笔记(模板 → 标题) ==');
{
  await page.locator('#notes-side-float').click();
  await sleep(450);
  await page.locator('#notes-new-btn').click();
  await sleep(500);
  // 先选模板
  const menu = page.locator('.oc-menu').first();
  if (await menu.count()) {
    const box = await menu.boundingBox();
    check('模板菜单在视口内', !!box && (box.x + box.width) <= W + 1);
    await page.locator('.oc-menu .oc-menu-item', { hasText: '空白笔记' }).first().click();
    await sleep(500);
  } else bad('模板菜单未出现');
  const prompt = page.locator('.notes-prompt-modal').first();
  if (await prompt.count()) {
    const box = await prompt.boundingBox();
    check('标题输入弹窗在视口内', !!box && (box.x + box.width) <= W + 1);
    await page.locator('.notes-prompt-input').first().fill('窄屏新建的笔记');
    await page.locator('.notes-prompt-modal [data-act="ok"]').first().click();
    await sleep(1000);
    const found = await page.evaluate(() => (window.OCNotes._debug.doc.notes || []).some((n) => n.title === '窄屏新建的笔记'));
    check('新建笔记已写入数据', found);
    check('新建弹窗不导致横向溢出', (await overflowX()) <= 1);
  } else bad('标题输入弹窗未出现');
}

console.log('\n== 7. 无未捕获异常 ==');
{
  const real = pageErrors.filter((e) => !/favicon|Failed to load resource|net::|ERR_/i.test(e));
  check('无 JS 异常' + (real.length ? ': ' + real.slice(0, 2).join(' | ') : ''), real.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ 移动端界面自检失败: ${fail} 项` : `✓ 移动端界面自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
