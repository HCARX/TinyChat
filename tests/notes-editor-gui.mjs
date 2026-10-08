/* 笔记编辑器与弹窗导航自检(真 Chromium + 真服务端):
 *   node tests/notes-editor-gui.mjs
 *
 * 锁住三处已修回归点(都在修复前必失败):
 *   1) 「已分享管理」点不开:UI.closeModal 会回调 _onClose,而弹窗把 _onClose 设成
 *      自己再调 closeModal 的 done() → 互相递归爆栈;栈溢出抛在点击处理器里,
 *      紧随其后的「打开已分享管理」整段不执行,按钮看起来是死的。
 *   2) 窄屏改不了笔记:模式切换(编辑/分屏/预览)排在横向可滚控件条的最右,
 *      390px 下 x≈576 完全在屏外;分屏在窄屏又只渲染预览(只读),
 *      于是「笔记只能看、不能编辑」。
 *   3) 顶栏不齐:控件条只有 padding-bottom,条内文字比左侧「返回」高 1px。
 * 另附带:侧栏收起时拖拽调宽条仍压在正文上抢点击。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8231);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8232);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'editor-pass' };

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
  console.log('(skip) 未找到 playwright,跳过编辑器自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-editor-' + Date.now());
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
    name: 'EditorMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-editor',
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
        { id: 'fe', parentId: null, name: '编辑器测试夹', createdAt: 2, updatedAt: 2 },
      ],
      notes: [{
        id: 'ne1', folderId: 'fe', title: '编辑器测试笔记',
        content: '# 大标题\n\n正文内容。', tags: [], isPinned: false,
        shareMode: 'private', createdAt: 3, updatedAt: 3,
      }],
      tombs: {},
    },
  }),
});
// 造一条已分享记录,供「已分享管理」列表断言
const shareRes = await (await fetch(BASE + '/api/notes/share', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ noteId: 'ne1', mode: 'view-link', expireDays: 0 }),
})).json();
const shareToken = shareRes && shareRes.share && shareRes.share.token;

const browser = await pw.chromium.launch();

async function boot(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 800, isMobile: width <= 800 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.addInitScript(([token, prov, uid]) => {
    localStorage.setItem('oc_token', token);
    localStorage.setItem('oc_provider', prov);
    localStorage.setItem('oc_model_' + prov, 'mock-model');
    localStorage.setItem('oc_notes_guide_seen', '1');
    localStorage.setItem('oc_notes_ui_' + uid, JSON.stringify({ folderId: 'fe', mode: 'split', expanded: { fe: true } }));
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
const selectNote = async (page, narrow) => {
  if (narrow) { await page.locator('#notes-side-float').click(); await sleep(450); }
  await page.locator('.notes-side .nt-note', { hasText: '编辑器测试笔记' }).first().click();
  await sleep(800);
};
// 文字(非容器)中心线:容器含内边距会把误差藏住,必须量到字形
const textCenterY = (page, sel, needle) => page.evaluate(([s, nd]) => {
  const root = document.querySelector(s);
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.indexOf(nd) >= 0) {
      const r = document.createRange();
      r.selectNodeContents(node);
      const b = r.getBoundingClientRect();
      return +((b.top + b.bottom) / 2).toFixed(2);
    }
  }
  return null;
}, [sel, needle]);

// ============ 1. 宽屏:已分享管理 + 顶栏对齐 ============
const wide = await boot(1280, 900);
{
  console.log('== 1. 宽屏:齿轮 →「已分享管理」必须能打开 ==');
  const { page, errs } = wide;
  await selectNote(page, false);
  await page.locator('#notes-gear').click();
  await sleep(500);
  check('齿轮弹窗打开', await page.locator('.notes-aimgr-modal').count() === 1);
  await page.locator('#aimgr-shares').click();
  await sleep(1100);
  const shm = page.locator('.notes-shm-modal');
  check('「已分享管理」弹窗真的打开(此前爆栈,点了没反应)', await shm.count() === 1);
  check('已分享管理弹窗可见', await shm.isVisible().catch(() => false));
  const body = await page.locator('#shm-body').innerText().catch(() => '');
  check('列表里能看到已分享的笔记', body.includes('编辑器测试笔记'));
  // 点「取消分享」弹出的确认框必须压在最上层。此前 chrome.css 的 .modal-mask{1600}
  // 覆盖了 polish.css 的 .oc-confirm-mask{3100}(同权重、后者先加载),确认框实测
  // 只有 1600,被 1670 的「已分享管理」整个盖住 —— 用户看不到也点不到。
  const zLayers = await page.evaluate(() => {
    const shmMask = document.querySelector('.notes-shm-mask');
    const conf = document.createElement('div');
    conf.className = 'modal-mask oc-confirm-mask';
    document.body.appendChild(conf);
    const zc = getComputedStyle(conf).zIndex;
    conf.remove();
    return { shm: shmMask ? getComputedStyle(shmMask).zIndex : null, confirm: zc };
  });
  check('确认框层级高于「已分享管理」(' + zLayers.confirm + ' > ' + zLayers.shm + ')',
    Number(zLayers.confirm) > Number(zLayers.shm));
  const recursive = errs.filter((e) => /Maximum call stack|call stack size/i.test(e));
  check('无「Maximum call stack size exceeded」' + (recursive.length ? ': ' + recursive[0].slice(0, 60) : ''), recursive.length === 0);
  // 关闭再打开一次:关闭回调必须幂等,不能递归也不能把下一个弹窗带走。
  // 修复前这里根本没弹窗(上面已记失败),所以每一步都要容错,否则整套用例会中断、
  // 后面的对齐与窄屏断言全都跑不到,拿不到完整基线。
  const closeShm = async () => {
    const b = page.locator('.notes-shm-modal [data-close]').first();
    if (await b.count()) { await b.click({ timeout: 5000 }).catch(() => {}); await sleep(900); }
  };
  await closeShm();
  check('关闭已分享管理后弹窗移除', await page.locator('.notes-shm-modal').count() === 0);
  await page.locator('#notes-gear').click({ timeout: 8000 }).catch(() => {});
  await sleep(500);
  const reShares = page.locator('#aimgr-shares');
  if (await reShares.count()) { await reShares.click({ timeout: 5000 }).catch(() => {}); await sleep(1100); }
  check('二次打开仍正常(关闭回调没有再爆栈)', await page.locator('.notes-shm-modal').isVisible().catch(() => false));
  await closeShm();

  console.log('\n== 2. 宽屏:顶栏「返回」与「编辑/分屏」同一水平线 ==');
  const backY = await textCenterY(page, '.notes-back-btn', '返回');
  const editY = await textCenterY(page, '#ne-mode-switch [data-mode="edit"]', '编辑');
  const splitY = await textCenterY(page, '#ne-mode-switch [data-mode="split"]', '分屏');
  check('能量到「返回」「编辑」「分屏」三处文字', backY !== null && editY !== null && splitY !== null);
  const dEdit = Math.abs(backY - editY), dSplit = Math.abs(backY - splitY);
  check(`返回 vs 编辑 中心差 ≤0.5px(实测 ${dEdit}px;修复前 1px)`, dEdit <= 0.5);
  check(`返回 vs 分屏 中心差 ≤0.5px(实测 ${dSplit}px)`, dSplit <= 0.5);

  console.log('\n== 3. 宽屏:侧栏收起后拖拽条不得压在正文上 ==');
  await page.locator('#notes-side-collapse').click();
  await sleep(600);
  const rz = await page.evaluate(() => {
    const el = document.getElementById('notes-side-resizer');
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    const side = document.querySelector('.notes-side');
    return { display: cs.display, sideHidden: getComputedStyle(side).display === 'none' };
  });
  check('侧栏收起时拖拽条一并隐藏(不再横在正文上抢点击)', rz.missing || rz.display === 'none');
  await page.locator('#notes-side-float').click();
  await sleep(500);
  const rzBack = await page.evaluate(() => {
    const el = document.getElementById('notes-side-resizer');
    return el ? getComputedStyle(el).display : 'missing';
  });
  check('侧栏恢复后拖拽条回来(宽屏仍可调宽)', rzBack !== 'none' && rzBack !== 'missing');
}
await wide.ctx.close();

// ============ 4. 窄屏:模式切换可见可点,笔记真的能编辑 ============
const narrow = await boot(390, 844);
{
  console.log('\n== 4. 窄屏:模式切换必须在屏内且能切到「编辑」 ==');
  const { page, errs } = narrow;
  await selectNote(page, true);
  const geo = await page.evaluate(() => {
    const sw = document.querySelector('#ne-mode-switch');
    const edit = document.querySelector('#ne-mode-switch [data-mode="edit"]');
    const r = edit.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return {
      swLeft: +sw.getBoundingClientRect().left.toFixed(1),
      swRight: +sw.getBoundingClientRect().right.toFixed(1),
      editLeft: +r.left.toFixed(1), editRight: +r.right.toFixed(1),
      inViewport: r.left >= 0 && r.right <= window.innerWidth,
      hitIsEdit: !!hit && (hit === edit || edit.contains(hit)),
      hitDesc: hit ? (hit.tagName + '#' + (hit.id || '')) : null,
      vw: window.innerWidth,
    };
  });
  check(`模式切换在视口内(左 ${geo.editLeft},右 ${geo.editRight},屏宽 ${geo.vw};修复前左≈576 在屏外)`, geo.inViewport);
  check('模式切换中心点命中它自己(没有被别的控件盖住)', geo.hitIsEdit);

  const activeBefore = await page.evaluate(() => document.querySelector('#ne-mode-switch .active').dataset.mode);
  check('默认分屏在窄屏只渲染预览(只读,所以要能切走)', !(await page.locator('#ne-ta').isVisible()));
  await page.locator('#ne-mode-switch [data-mode="edit"]').click({ timeout: 6000 });
  await sleep(500);
  const activeAfter = await page.evaluate(() => document.querySelector('#ne-mode-switch .active').dataset.mode);
  check(`点「编辑」后模式切到 edit(此前 ${activeBefore} → ${activeAfter})`, activeAfter === 'edit');
  const taVisible = await page.locator('#ne-ta').isVisible();
  check('编辑区出现', taVisible);
  if (taVisible) {
    await page.locator('#ne-ta').click();
    await page.keyboard.type('窄屏追加');
    await sleep(400);
    const val = await page.locator('#ne-ta').inputValue();
    check('真的能输入文字(笔记可编辑)', val.includes('窄屏追加'));
    await sleep(1100);
    const saved = await page.evaluate(() => (window.OCNotes._debug.doc.notes.find((n) => n.id === 'ne1') || {}).content || '');
    check('输入内容已写入本地笔记', saved.includes('窄屏追加'));
  } else {
    bad('编辑区不可见,无法继续验证输入');
  }

  console.log('\n== 5. 窄屏:顶栏同样对齐 ==');
  const backY = await textCenterY(page, '.notes-back-btn', '返回');
  const editY = await textCenterY(page, '#ne-mode-switch [data-mode="edit"]', '编辑');
  check('返回与编辑同一水平线(窄屏)' + (backY !== null && editY !== null ? `,差 ${Math.abs(backY - editY)}px` : ''),
    backY !== null && editY !== null && Math.abs(backY - editY) <= 0.5);

  console.log('\n== 6. 无 JS 异常 ==');
  const real = errs.filter((e) => !/favicon|Failed to load resource|net::|ERR_/i.test(e));
  check('全程无未捕获异常' + (real.length ? ': ' + real.slice(0, 2).join(' | ') : ''), real.length === 0);
}
await narrow.ctx.close();

await browser.close();
console.log('\n' + (fail ? `✗ 编辑器自检失败: ${fail} 项` : `✓ 编辑器自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
