/* 笔记内嵌附件自检(真 Chromium + 真服务端):
 *   node tests/notes-image-gui.mjs
 *
 * 锁住的回归点:正文里的图片是 <img src="/api/notes/file?...">、其它附件是普通
 * <a href> 链接,而浏览器加载这类资源**不会带 Authorization 头**(登录态是
 * localStorage 里的 Bearer 令牌,不是 Cookie)。附件接口要求「只有本人可读」,
 * 若只认请求头,预览区就永远是裂图、附件也点不开——而且这问题在 curl 用例里
 * 复现不了:e2e 手动加 -H "$AUTH" 反而是「浏览器做不到的请求」。修复前本脚本必失败。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8241);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'note-img-pass' };

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
  console.log('(skip) 未找到 playwright,跳过笔记附件自检');
  process.exit(0);
}

const TMP = join(tmpdir(), 'tc-noteimg-' + Date.now());
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
const userId = login.user && login.user.id;
if (!userId) { console.error('✗ 登录失败: ' + JSON.stringify(login).slice(0, 200)); process.exit(1); }
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ notesEnabled: true }) });

// 1x1 PNG 与一个通用附件(zip 头),分别覆盖「内嵌图片」与「下载链接」两条路径
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(TMP, 'pixel.png'), png);

async function upload(bytes, name, type) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  fd.append('noteId', 'ni1');
  const res = await fetch(BASE + '/api/notes/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token }, body: fd });
  const data = await res.json();
  if (!data.url) { console.error('✗ 上传失败: ' + JSON.stringify(data).slice(0, 200)); process.exit(1); }
  return data;
}
const img = await upload(png, 'pixel.png', 'image/png');
const zip = await upload(Buffer.from('PK\x03\x04fake-zip', 'binary'), 'archive.zip', 'application/zip');

// 正文按编辑器插入的原始 Markdown 形态存放(与 insertAttachment 一致)
const content = '# 带图笔记\n\n![pixel.png](' + img.url + ')\n\n[📎 archive.zip](' + zip.url + ')\n';
await fetch(BASE + '/api/sync/notes', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    baseRevision: 0,
    doc: {
      folders: [{ id: 'uncat', parentId: null, name: '默认分类', createdAt: 1, updatedAt: 1, system: true }],
      notes: [{
        id: 'ni1', folderId: 'uncat', title: '带图笔记', content,
        tags: [], isPinned: false, shareMode: 'private', createdAt: 3, updatedAt: 3,
        attachments: [
          { id: img.id, name: 'pixel.png', url: img.url, mimeType: 'image/png', size: img.size, createdAt: Date.now() },
          { id: zip.id, name: 'archive.zip', url: zip.url, mimeType: 'application/zip', size: zip.size, createdAt: Date.now() },
        ],
      }],
      tombs: {},
    },
  }),
});

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
const hits = [];
page.on('response', (r) => { if (r.url().includes('/api/notes/file')) hits.push(r.status()); });
await page.addInitScript(([token, uid]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_notes_guide_seen', '1');
  localStorage.setItem('oc_notes_ui_' + uid, JSON.stringify({ folderId: 'uncat', mode: 'split', expanded: { uncat: true } }));
}, [login.token, userId]);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.evaluate(() => { if (window.OCNotes) window.OCNotes.warmUp(); });
await page.waitForFunction(() => !!(window.OCNotes && window.OCNotes.isReady && window.OCNotes.isReady()), null, { timeout: 30000 });
await page.evaluate(() => window.OCNotes.open());
await page.waitForSelector('.notes-fs', { timeout: 20000 });
await sleep(600);
await page.locator('.notes-side .nt-note', { hasText: '带图笔记' }).first().click();
await sleep(1500);

console.log('== 笔记预览:内嵌图片必须真的显示出来 ==');
check('预览区渲染出 <img> 元素', await page.locator('.notes-editor-panes img').count() > 0);
const loaded = await page.evaluate(() => {
  const el = document.querySelector('.notes-editor-panes img');
  return el ? { src: el.getAttribute('src') || '', w: el.naturalWidth } : null;
});
check('图片真的解码成功(naturalWidth > 0)' + (loaded ? ` [w=${loaded.w}]` : ''), !!(loaded && loaded.w > 0));
check('附件请求返回 200(实际: ' + JSON.stringify(hits) + ')', hits.length > 0 && hits.every((s) => s === 200));

console.log('== 附件下载链接:浏览器直取也要能打开 ==');
const href = await page.evaluate(() => {
  const a = Array.from(document.querySelectorAll('.notes-editor-panes a')).find((x) => (x.getAttribute('href') || '').indexOf('/api/notes/file') >= 0);
  return a ? a.getAttribute('href') : '';
});
check('预览区渲染出附件下载链接', !!href);
// ctx.request 与页面共用 Cookie 罐、同样不带 Authorization 头,等价于浏览器自己发起的下载
const dl = href ? await ctx.request.get(BASE + href) : null;
check('下载链接返回 200(实际: ' + (dl ? dl.status() : 'n/a') + ')', !!dl && dl.status() === 200);
check('非图片仍强制下载', !!dl && /attachment/i.test(dl.headers()['content-disposition'] || ''));

await ctx.close();
await browser.close();
console.log(`\n${fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'}(${pass} 通过 / ${fail} 失败)`);
process.exit(fail === 0 ? 0 : 1);
