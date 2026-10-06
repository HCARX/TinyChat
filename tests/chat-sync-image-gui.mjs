/* 换设备后对话图片渲染 GUI 自检(真 Chromium + 真服务端):
 *   node tests/chat-sync-image-gui.mjs
 *
 * 锁住一个只在「新设备登录」时才暴露的缺陷:用户消息的 content 里内联着
 * ![名](data:image/png;base64,...),一张四百来像素的图编码后就有六十多万字符,远超
 * tc_sanitize_chats 对 content 的 200000 上限。旧实现直接 substr 把 base64 拦腰截断,
 * 剩下的半截既不是图片也不是链接,Markdown 只能整段当普通文字画出来 —— 新设备拉取云端后
 * 看到的就是「一堵乱码」。原设备因为手里有完整 attachments,渲染时不走这条路,所以不复现。
 *
 * 用例覆盖(全新浏览器上下文 = 空 localStorage = 新设备):
 *   1) 大图同步后云端 content 被截断、attachments[].dataUrl 完整(证明确实走了这条路);
 *   2) 新设备气泡里图片仍然渲染成 <img> 且解码成功,不是一屏 base64 文字;
 *   3) 图片位置/正文顺序不变(图片换回原位,不是被丢到末尾);
 *   4) 历史遗留的「半截 data 图片」不再画成乱码,而是收成一句可读说明;
 *   5) 全流程无 JS 异常。
 *
 * 需要 playwright 与 chromium;缺失时自动跳过并返回 0(不阻塞 CI)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8191);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'imgsync-pass' };

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
if (!pw) { console.log('(skip) 未找到 playwright,跳过换设备图片渲染 GUI 自检'); process.exit(0); }

// ---- 造一张真实可解码的大 PNG ----
// 随机像素无法压缩,deflate 出来的体积≈原始数据,编码后自然超过 content 的 200000 上限,
// 同时是 Chromium 真能解码的合法 PNG(用来断言 naturalWidth)。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w * 3; x++) raw[off + 1 + x] = Math.floor(Math.random() * 256);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TMP = join(tmpdir(), 'tc-imgsync-' + Date.now());
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

for (let i = 0; i < 80; i++) {
  try { const r = await fetch(BASE + '/api/config'); if (r.status) break; } catch (e) { /* 未就绪 */ }
  await sleep(250);
}
const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json();
if (!login.token) { console.error('✗ 管理员登录失败\n' + appErr.slice(-1200)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

console.log('== 0. 造一张真·大图并像原设备那样推送到云端 ==');
const png = makePng(400, 400);
const dataUrl = 'data:image/png;base64,' + png.toString('base64');
const content = '帮我看看这张图\n\n![门店照片.png](' + dataUrl + ')';
console.log('   图片 ' + Math.round(png.length / 1024) + 'KB,data URL ' + dataUrl.length + ' 字符,content ' + content.length + ' 字符');
check('构造的 content 确实超过云同步 200000 上限', content.length > 200000);

const seeded = {
  chats: [{
    id: 'chat-img-1', title: '门店图片', createdAt: Date.now(), updatedAt: Date.now(),
    messages: [{
      role: 'user', content, text: '帮我看看这张图', createdAt: Date.now(),
      attachments: [{ type: 'image', name: '门店照片.png', size: png.length, mediaType: 'image/png', dataUrl }],
    }],
  }],
  baseRevision: 0, deletedIds: [], deletedChats: [],
};
const pushRes = await fetch(BASE + '/api/sync/chats', { method: 'POST', headers: AUTH, body: JSON.stringify(seeded) });
check('推送云端返回 200(实际 ' + pushRes.status + ')', pushRes.status === 200);

const pulled = await (await fetch(BASE + '/api/sync/chats', { headers: AUTH })).json();
const cm = ((pulled.chats || [])[0] || {}).messages || [];
const cmsg = cm[0] || {};
console.log('   云端 content ' + String(cmsg.content || '').length + ' 字符,attachment.dataUrl ' + String(((cmsg.attachments || [])[0] || {}).dataUrl || '').length + ' 字符');
check('云端 content 已被截断(不是原文)', String(cmsg.content || '').length < content.length);
// 截断后的 content 不能再有「没闭合的 data 图片」结构
const closed = String(cmsg.content || '').replace(/!\[[^\]]*\]\(\s*[^)\s][^)]*\)/g, '');
check('截断后没有残留半截图片结构', !/!\[[^\]]*\]\(\s*data:/.test(closed));
check('attachments[].dataUrl 完整保留(渲染端据此重建)', String(((cmsg.attachments || [])[0] || {}).dataUrl || '').length === dataUrl.length);

console.log('\n== 1. 新设备(全新浏览器上下文)登录同一账号:图片必须真的显示 ==');
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
// 只写令牌:不预置任何对话缓存,等价于新设备首次登录
await page.addInitScript(([token]) => { localStorage.setItem('oc_token', token); }, [login.token]);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.OCApp && window.OCApp.state && window.OCApp.state.user), null, { timeout: 30000 });
await page.waitForSelector('#messages .msg.user', { timeout: 20000 });
await sleep(1500);

const shot = await page.evaluate(() => {
  const bubble = document.querySelector('#messages .msg.user .msg-content');
  const imgs = bubble ? Array.from(bubble.querySelectorAll('img')) : [];
  const text = bubble ? bubble.innerText : '';
  return {
    imgCount: imgs.length,
    widths: imgs.map((i) => i.naturalWidth),
    srcs: imgs.map((i) => (i.getAttribute('src') || '').slice(0, 24)),
    textLen: text.length,
    textHead: text.slice(0, 60),
    // 一屏 base64 的特征:连续 100 个以上 base64 字符且没有空白
    hasBase64Wall: /[A-Za-z0-9+/]{100,}/.test(text),
    lightboxCount: bubble ? bubble.querySelectorAll('[data-lightbox]').length : 0,
  };
});
console.log('   气泡:图片 ' + shot.imgCount + ' 张,解码宽度 [' + shot.widths.join(',') + '],文字 ' + shot.textLen + ' 字符');
check('气泡里渲染出 <img>', shot.imgCount === 1);
check('图片真的解码成功(naturalWidth = 400)', shot.widths[0] === 400);
check('图片走 data: 内联(由附件重建)', /^data:image\/png/.test(shot.srcs[0] || ''));
check('气泡文字不是一屏 base64', !shot.hasBase64Wall);
check('正文提示词仍在(图片是插回原位,不是替换掉文字)', shot.textHead.includes('帮我看看这张图'));
check('图片挂了灯箱(与在线对话同一渲染管线)', shot.lightboxCount === 1);

console.log('\n== 2. 遗留数据:历史里已存的「半截 data 图片」不再画成乱码 ==');
// 修复前同步过的记录,云端 content 里可能留着没闭合的图片残片。GET 不做清洗,
// 这类数据会原样下发,渲染端必须自己兜住(助手消息没有附件可重建,只能收成说明)。
const legacy = {
  chats: [{
    id: 'chat-imgl-1', title: '历史截断', createdAt: Date.now(), updatedAt: Date.now(),
    messages: [
      { role: 'user', content: '看看这个\n\n![旧图.png](data:image/png;base64,AAAA', text: '看看这个', createdAt: Date.now() },
      { role: 'assistant', content: '生成结果:\n\n![生成图.png](data:image/png;base64,BBBB', createdAt: Date.now() },
    ],
  }],
  baseRevision: Number(pulled.revision) || 0, deletedIds: [], deletedChats: [],
};
const legacyRes = await fetch(BASE + '/api/sync/chats', { method: 'POST', headers: AUTH, body: JSON.stringify(legacy) });
check('遗留数据推送返回 200(实际 ' + legacyRes.status + ')', legacyRes.status === 200);

// 换一个全新上下文拉取(等价于另一台新设备)
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page2 = await ctx2.newPage();
page2.on('pageerror', (e) => pageErrors.push('legacy: ' + String((e && e.message) || e)));
page2.on('console', (m) => { if (m.type() === 'error') pageErrors.push('legacy console: ' + m.text()); });
await page2.addInitScript(([token, cid]) => {
  localStorage.setItem('oc_token', token);
}, [login.token]);
await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page2.waitForFunction(() => !!(window.OCApp && window.OCApp.state && window.OCApp.state.user), null, { timeout: 30000 });
await page2.waitForSelector('#messages .msg', { timeout: 20000 });
// 切到「历史截断」这个会话
await page2.evaluate(() => {
  const s = window.OCApp.state;
  s.currentChatId = 'chat-imgl-1';
  if (window.OCApp.renderMessages) window.OCApp.renderMessages();
});
await page2.waitForSelector('#messages .msg.assistant', { timeout: 10000 });
await sleep(800);
const legacyShot = await page2.evaluate(() => {
  const asst = document.querySelector('#messages .msg.assistant .msg-content');
  const user = document.querySelector('#messages .msg.user .msg-content');
  const at = asst ? asst.innerText : '';
  return {
    asstText: at,
    asstBase64Wall: /[A-Za-z0-9+/]{100,}/.test(at),
    asstHasPlaceholder: /截断|无法显示/.test(at),
    userBase64Wall: user ? /[A-Za-z0-9+/]{100,}/.test(user.innerText) : false,
  };
});
check('助手气泡不再是 base64 墙', !legacyShot.asstBase64Wall);
check('助手气泡给出可读说明(实际: ' + JSON.stringify(legacyShot.asstText.slice(0, 50)) + ')', legacyShot.asstHasPlaceholder);
check('用户气泡也不再是 base64 墙', !legacyShot.userBase64Wall);

check('全流程无 JS 报错', pageErrors.length === 0);
if (pageErrors.length) console.log('    ' + pageErrors.slice(0, 5).join('\n    '));

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
