/* 本地大块数据存储(IndexedDB)GUI 自检 —— 真 Chromium + 真服务端:
 *   node tests/local-store-gui.mjs
 *
 * 背景:会话列表与「删除副本」里带着图片本体 —— 消息 content 里内联一份
 * ![](data:image/png;base64,...),attachments[].dataUrl 又完整存一份,一张 3MB 的图
 * 编码后在本地就是 800 万字符。这些原本写在 localStorage 里,而它每源只有约 5MB:
 * 写不下时旧实现只 console.warn,用户看到的是「这次对话没存住、刷新后回到上一版」。
 * 笔记正文同理(单篇上限 50 万字符,十篇就压满了)。
 * 现在这几处走 OCStore(IndexedDB 优先,localStorage 兜底)。
 *
 * 用例(每条都量外部可核对的事实,不拿「实现说什么就是什么」充数):
 *   1) 先量证据:真浏览器里 localStorage 一个键到底能写多少字符 —— 并算出「一张 3MB 的图,
 *      按应用的存法(content + attachments 各一份)要多少字符」,证明它确实超过上限;
 *   2) 超过该上限的会话写进本地后,断网(拦截 /api/sync/chats)重载仍完整读回:
 *      侧边栏画得出、正文长度一字不少 —— 这只能来自 IndexedDB;
 *   3) 应用自己那条写路径(点「新对话」→ saveChats)也不再落 localStorage:
 *      同一时刻 localStorage 里没有这个键,而断网重载后新对话还在;
 *   4) 旧键迁移:预置上个版本留在 localStorage 的会话副本 → 打开页面能读到,
 *      且旧键被搬走后从 localStorage 删除(把 5MB 让回去),断网重载仍在;
 *   5) 浏览器不给用 IndexedDB(隐私模式/策略禁用)时整层退回 localStorage:
 *      应用照常起来、本地已有的会话照常读到,不能因为换存储把页面弄坏;
 *   6) 笔记正文走同一层(单篇上限 50 万**字节**,十来篇就压满旧的 5MB):长笔记落本地后
 *      localStorage 里没有该键,断网重载仍在;
 *      并直接往笔记键写 600 万字符,重载后仍完整读回(这个键同样不再受 5MB 限制);
 *   7) 全程无 JS 异常、服务端无 PHP 告警。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.LSTORE_GUI_PORT || 8581);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'lstore-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c, extra) => { if (c) ok(m); else bad(m + (extra === undefined ? '' : ' —— 实得 ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似上一次测试残留的 php -S),请先结束该进程或用 LSTORE_GUI_PORT 换端口`);
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
if (!pw) { console.log('(skip) 未找到 playwright,跳过本地存储 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-lstore-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
let appErr = '';
function spawnPhp(args, env) {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => { appErr += String(d); });
  procs.push(p);
  return p;
}
function cleanup() {
  for (const p of procs) { try { p.kill(); } catch (e) { /* 忽略 */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.on('exit', cleanup);

spawnPhp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_ALLOW_PRIVATE_UPSTREAM: '1', TC_WEB_CN_ONLY: '0',
});

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
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const UID = login.user.id;

const browser = await pw.chromium.launch();
const pageErrors = [];

// ============ 1. 先量证据:localStorage 到底能装多少 ============
console.log('\n== 1. 证据:真浏览器里 localStorage 一个键能写多少字符 ==');
let LS_MAX = 0;
{
  // 单独一个浏览器上下文:配额按「源 + 用户资料」算,在这里把库塞到临界不会影响主用例那个标签页
  const probeCtx = await browser.newContext();
  const probe = await probeCtx.newPage();
  await probe.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  LS_MAX = await probe.evaluate(() => {
    let lo = 0, hi = 16 * 1024 * 1024, best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      try { localStorage.setItem('capacity-probe', 'x'.repeat(mid)); localStorage.removeItem('capacity-probe'); best = mid; lo = mid + 1; }
      catch (e) { hi = mid - 1; }
      try { localStorage.removeItem('capacity-probe'); } catch (e) { /* 忽略 */ }
    }
    return best;
  });
  await probeCtx.close();
  // 一个数量级就够说明问题:5MB 上下量级 = 很小;真到几十 MB 反而说明浏览器给了例外
  check('量到单键上限 ' + LS_MAX + ' 字符(约 ' + (LS_MAX / 1024 / 1024).toFixed(1) + 'MB 量级)', LS_MAX > 0 && LS_MAX < 8 * 1024 * 1024, LS_MAX);
  // 应用里一张 3MB 的图:content 里内联一份 + attachments[].dataUrl 一份,编码后各约 419 万字符
  const b64 = Math.ceil((3 * 1024 * 1024) / 3) * 4;
  const appPayload = b64 * 2 + 2000;
  check('一张 3MB 的图按应用的存法是 ' + appPayload + ' 字符,已超过上限', appPayload > LS_MAX, { appPayload, LS_MAX });
}

// ============ 主用例上下文 ============
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// 断掉云同步:下面量的是「本地那一份」,不能让云端拉取把结论掺进来
await ctx.route('**/api/sync/chats', (r) => r.abort());

async function openApp(url = '/') {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
  p.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  await p.addInitScript((t) => { localStorage.setItem('oc_token', t); }, login.token);
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  return p;
}

// 等启动流程真的走完再量。
// 只等 state.user 会在半路上就开始量 —— 它由 /api/me 一回来就赋值,而后面还有
// 「拉云端设置」「打开本地库」两步 await。抢跑量到的 mode 还是 ls、列表还是空的,
// 报出来的「失败」其实是测自己太早。
async function waitStoreReady(p, timeout = 30000) {
  await p.waitForFunction(() => !!(window.OCStore && window.OCStore.mode() === 'idb'), null, { timeout }).catch(() => {});
}
async function waitListed(p, title, timeout = 30000) {
  await p.waitForFunction(
    (t) => [...document.querySelectorAll('#chat-list .chat-title')].some((e) => e.textContent.trim() === t),
    title, { timeout },
  ).catch(() => {});
}

// 构造一条「本地才有」的会话:正文里内联一张 3MB 的图,再按应用的方式在 attachments 里存一份。
// 小对话排在数组前面,让它成为打开时渲染的那条 —— 8MB 的假图没必要真画一遍(拖慢用例还多噪音)。
const BIG_IMG = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((3 * 1024 * 1024) / 3) * 4);
const bigChat = {
  id: 'c-big', title: '大图对话', pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
  messages: [{
    role: 'user', content: '看看这张图\n\n![大图.png](' + BIG_IMG + ')',
    attachments: [{ type: 'image', name: '大图.png', mediaType: 'image/png', dataUrl: BIG_IMG }],
    createdAt: Date.now(),
  }],
};
const smallChat = {
  id: 'c-small', title: '小对话', pinned: false,
  createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000,
  messages: [{ role: 'user', content: '小对话', createdAt: Date.now() - 60000 }],
};
const bigJson = JSON.stringify([smallChat, bigChat]);

console.log('\n== 2. 超过 localStorage 上限的会话:本地存得住、断网重载读得回 ==');
let page = await openApp();
await waitStoreReady(page);
{
  const mode = await page.evaluate(() => (window.OCStore ? window.OCStore.mode() : 'missing'));
  check('页面用的是 IndexedDB 后端(OCStore.mode() = idb)', mode === 'idb', mode);
  if (mode !== 'idb') {
    // 退到 localStorage 说明库没打开成功;把失败原因打出来,否则只能看到一个 "ls" 干瞪眼
    const why = await page.evaluate(() => (window.OCStore ? window.OCStore.info() : null));
    console.log('    OCStore.info() = ' + JSON.stringify(why));
  }
  // 直接用应用自己那个键名写进去,再等异步落盘
  await page.evaluate(async (args) => {
    window.OCStore.set('oc_chats_' + args.uid, args.json);
    await new Promise((r) => setTimeout(r, 1200));
  }, { uid: UID, json: bigJson });
  const wrote = await page.evaluate((args) => ({
    ls: localStorage.getItem('oc_chats_' + args.uid),
    idb: (window.OCStore.get('oc_chats_' + args.uid) || '').length,
    want: args.json.length,
  }), { uid: UID, json: bigJson });
  check('写进去的 ' + wrote.want + ' 字符在镜像里(远大于 localStorage 上限)', wrote.idb === wrote.want, wrote.idb);
  check('这份数据没有被写进 localStorage', wrote.ls === null, wrote.ls === null ? '' : String(wrote.ls).slice(0, 40));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitListed(page, '小对话');
  const after = await page.evaluate(() => {
    const chats = (window.OCApp.state.chats || []);
    const c = chats.find((x) => x.id === 'c-big');
    return {
      titles: [...document.querySelectorAll('#chat-list .chat-title')].map((e) => e.textContent.trim()),
      found: !!c,
      contentLen: c ? String((c.messages[0] || {}).content || '').length : 0,
      attLen: c ? String(((c.messages[0] || {}).attachments || [{}])[0].dataUrl || '').length : 0,
    };
  });
  check('重载后侧边栏画出了这条会话(不是空列表)', after.titles.includes('大图对话'), after.titles);
  check('正文一字不少地读回来了(' + after.contentLen + ' 字符)', after.contentLen === bigChat.messages[0].content.length, after.contentLen);
  check('附件里的图片本体也在(' + after.attLen + ' 字符)', after.attLen === BIG_IMG.length, after.attLen);
}

console.log('\n== 3. 应用自己那条写路径(点「新对话」)也不落 localStorage ==');
{
  const before = await page.evaluate(() => (window.OCApp.state.chats || []).length);
  await page.click('#new-chat-btn');
  await sleep(900);   // 等异步落盘
  const after = await page.evaluate((args) => ({
    count: (window.OCApp.state.chats || []).length,
    ls: localStorage.getItem('oc_chats_' + args.uid),
    idbLen: (window.OCStore.get('oc_chats_' + args.uid) || '').length,
  }), { uid: UID });
  check('新对话进了列表(' + before + ' → ' + after.count + ')', after.count === before + 1, after);
  check('应用保存后 localStorage 里仍没有会话键', after.ls === null, after.ls === null ? '' : String(after.ls).slice(0, 40));
  check('保存的内容在 IndexedDB 里(含刚才那条大图对话)', after.idbLen > BIG_IMG.length, after.idbLen);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitListed(page, '大图对话');
  const titles = await page.evaluate(() => [...document.querySelectorAll('#chat-list .chat-title')].map((e) => e.textContent.trim()));
  check('断网重载后新对话还在(由本地库供数,不是云端)', titles.filter((t) => t === '新对话' || t === '大图对话').length >= 2, titles);
  await page.close();
}

console.log('\n== 4. 旧键迁移:上个版本留在 localStorage 的副本搬进新库 ==');
{
  // 真实场景就是「老用户的浏览器」:localStorage 里有数据、IndexedDB 还是空的。
  // 所以这里单开一个上下文(全新的用户资料 = 空库),先把旧键放进去再进应用。
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx4.route('**/api/sync/chats', (r) => r.abort());
  const legacy = JSON.stringify([{
    id: 'c-legacy', title: '旧副本迁移标记', pinned: false, createdAt: Date.now(), updatedAt: Date.now(),
    messages: [{ role: 'user', content: '从 localStorage 搬过来的', createdAt: Date.now() }],
  }]);
  const p2 = await ctx4.newPage();
  p2.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
  p2.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  // 先不带令牌进首页(只读首页不会跳走),在这里把「旧数据 + 令牌」一起放好,再刷新。
  // 不用 /login 当暂存页:登录页发现 localStorage 里有令牌会自己 location.href 回首页,
  // 紧接着的 goto 会被那次跳转打断(ERR_ABORTED)。
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const fresh = await p2.evaluate(async () => (
    window.indexedDB && window.indexedDB.databases ? (await window.indexedDB.databases()).map((d) => d.name) : ['unknown']
  ));
  check('进应用前是全新用户资料:本地库还是空的', fresh.length === 0, fresh);
  await p2.evaluate((args) => {
    localStorage.setItem('oc_chats_' + args.uid, args.json);
    localStorage.setItem('oc_token', args.token);
  }, { uid: UID, json: legacy, token: login.token });
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await waitListed(p2, '旧副本迁移标记');
  const migrated = await p2.evaluate((args) => ({
    has: (window.OCApp.state.chats || []).some((c) => c.id === 'c-legacy'),
    ls: localStorage.getItem('oc_chats_' + args.uid),
    idbLen: (window.OCStore.get('oc_chats_' + args.uid) || '').length,
    mode: window.OCStore.mode(),
  }), { uid: UID });
  check('升级后第一次打开就读到了旧副本', migrated.has, migrated);
  check('旧键已从 localStorage 搬走(不是复制一份继续占着那 5MB)', migrated.ls === null, migrated.ls === null ? '' : String(migrated.ls).slice(0, 40));
  check('搬到了新库并切到 idb 后端(' + migrated.idbLen + ' 字符, mode=' + migrated.mode + ')', migrated.idbLen > 0 && migrated.mode === 'idb', migrated);

  await p2.reload({ waitUntil: 'domcontentloaded' });
  await waitListed(p2, '旧副本迁移标记');
  const titles = await p2.evaluate(() => [...document.querySelectorAll('#chat-list .chat-title')].map((e) => e.textContent.trim()));
  check('断网重载后仍读得到(已是本地库里的数据)', titles.includes('旧副本迁移标记'), titles);
  await ctx4.close();
}

console.log('\n== 5. 浏览器不给用 IndexedDB 时退回 localStorage(不能把页面弄坏) ==');
{
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.route('**/api/sync/chats', (r) => r.abort());
  const p3 = await ctx2.newPage();
  p3.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
  p3.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  // 隐私模式 / 被策略禁用时的样子:根本没有 indexedDB
  await p3.addInitScript(() => {
    try { Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: true }); } catch (e) { /* 忽略 */ }
  });
  await p3.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p3.evaluate((args) => {
    localStorage.setItem('oc_token', args.token);
    localStorage.setItem('oc_chats_' + args.uid, JSON.stringify([{
      id: 'c-ls', title: '兜底存储里的对话', messages: [{ role: 'user', content: 'hi' }],
      createdAt: Date.now(), updatedAt: Date.now(),
    }]));
  }, { uid: UID, token: login.token });
  await p3.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await waitListed(p3, '兜底存储里的对话');   // ls 模式下没有 idb 可等,等列表真画出来
  const fallback = await p3.evaluate(() => ({
    mode: window.OCStore ? window.OCStore.mode() : 'missing',
    has: (window.OCApp.state.chats || []).some((c) => c.id === 'c-ls'),
    titles: [...document.querySelectorAll('#chat-list .chat-title')].map((e) => e.textContent.trim()),
  }));
  check('后端如实报成 ls(不是假装成功)', fallback.mode === 'ls', fallback.mode);
  check('localStorage 里已有的会话照常读得到', fallback.has && fallback.titles.includes('兜底存储里的对话'), fallback.titles);
  // 应用照常可用:点新对话仍能写出 localStorage
  await p3.click('#new-chat-btn');
  await sleep(400);
  const wrote = await p3.evaluate((args) => (localStorage.getItem('oc_chats_' + args.uid) || '').length, { uid: UID });
  check('兜底模式下应用照常保存(' + wrote + ' 字符在 localStorage)', wrote > 20, wrote);
  await ctx2.close();
}

console.log('\n== 6. 笔记正文走同一层(单篇上限 50 万字节,十来篇就压满旧的 5MB) ==');
{
  // 先经云端放一篇长笔记,让笔记模块自己拉到本地。
  // 前面的用例里对话页会静默预热笔记(warmUp),这块的 revision 可能已经不是 0 —— 先读再写,
  // 撞上 409 就用服务端回的新 revision 重试一次(与客户端那套乐观并发同构)。
  // 服务端按**字节**算上限(TC_NOTE_MAX_CHARS = 500000,strlen 数的是字节):
  // 这串每份 13 字节,3 万份 = 39 万字节(18 万字符),在限额内且够长
  const longBody = '长笔记正文 '.repeat(30000);
  const noteBody = () => JSON.stringify({
    doc: {
      folders: [], tombs: {},
      notes: [{ id: 'n-long', folderId: 'uncat', title: '长笔记', content: longBody, createdAt: Date.now(), updatedAt: Date.now() }],
    },
  });
  let push = { ok: false, status: 0, body: {} };
  for (let i = 0; i < 3; i++) {
    const cur = await (await fetch(BASE + '/api/sync/notes', { headers: AUTH })).json().catch(() => ({}));
    const baseRevision = Number(cur.revision) || 0;
    const payload = JSON.parse(noteBody());
    payload.baseRevision = baseRevision;
    const r = await fetch(BASE + '/api/sync/notes', { method: 'POST', headers: AUTH, body: JSON.stringify(payload) });
    push = { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
    if (r.ok) break;
  }
  check('长笔记推上云端(' + push.status + ')', push.ok, push.status);

  const p4 = await openApp('/ainotes');
  await p4.waitForSelector('.notes-side .nt-note', { timeout: 30000 });
  await p4.waitForFunction(() => (window.OCStore.get('oc_notes_' + window.OCApp.state.user.id) || '').length > 170000, null, { timeout: 30000 }).catch(() => {});
  const local = await p4.evaluate((args) => ({
    ls: localStorage.getItem('oc_notes_' + args.uid),
    idbLen: (window.OCStore.get('oc_notes_' + args.uid) || '').length,
  }), { uid: UID });
  check('笔记本地副本在 IndexedDB 里(' + local.idbLen + ' 字符)', local.idbLen > 170000, local.idbLen);
  check('笔记正文没有落在 localStorage', local.ls === null, local.ls === null ? '' : String(local.ls).slice(0, 40));

  // 断网重载:只剩本地那一份供数
  await p4.route('**/api/sync/notes', (r) => r.abort());
  await p4.reload({ waitUntil: 'domcontentloaded' });
  await p4.waitForSelector('.notes-side .nt-note', { timeout: 30000 }).catch(() => {});
  const offline = await p4.evaluate(() => [...document.querySelectorAll('.notes-side .nt-note')].map((e) => e.textContent.trim()));
  check('断网重载后长笔记还在列表里(本地库供数)', offline.some((t) => t.includes('长笔记')), offline.slice(0, 5));

  // 这个键同样不再受 5MB 限制:直接写 600 万字符,重载后完整读回
  const padJson = JSON.stringify({ doc: { folders: [], notes: [], tombs: {} }, revision: 1, shares: [], pad: 'x'.repeat(6000000) });
  await p4.evaluate(async (args) => {
    window.OCStore.set('oc_notes_' + args.uid, args.json);
    await new Promise((r) => setTimeout(r, 1500));
  }, { uid: UID, json: padJson });
  await p4.reload({ waitUntil: 'domcontentloaded' });
  await p4.waitForFunction(() => !!(window.OCApp && window.OCApp.state && window.OCApp.state.user), null, { timeout: 30000 });
  await sleep(600);
  const big = await p4.evaluate((args) => ({
    len: (window.OCStore.get('oc_notes_' + args.uid) || '').length,
    want: args.n,
  }), { uid: UID, n: padJson.length });
  check('600 万字符的笔记副本完整读回(' + big.len + '/' + big.want + ')', big.len === big.want, big);
  await p4.close();
}

console.log('\n== 7. 无 JS 异常 ==');
{
  // 拦截云同步会让浏览器把被中断的请求记成 net::ERR_FAILED —— 这是本用例自己造成的,
  // 与被测代码无关,排除掉;其余任何页面异常都要现形。
  const noisy = (e) => /ERR_FAILED|Failed to fetch|net::|the server responded with a status of 4\d\d/.test(e);
  const relevant = pageErrors.filter((e) => !noisy(e));
  check('本地存储改动没有引入 JS 异常' + (relevant.length ? ': ' + relevant.slice(0, 3).join(' | ') : ''), relevant.length === 0);
}

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ 本地存储 GUI 自检失败: ${fail} 项` : `✓ 本地存储 GUI 自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
