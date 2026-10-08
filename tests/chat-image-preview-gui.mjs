/* 正文内联图片(缩略图化)GUI 自检(真 Chromium + 真服务端):
 *   node tests/chat-image-preview-gui.mjs
 *
 * 背景:一张图以前在消息里存了两份完整 base64 —— content 里内联一份、attachments[].dataUrl
 * 一份。3MB 的图就是 800 万字符:云同步每次推上去 800 万字符(服务端随后按 200000 上限切掉),
 * 本地副本也要多占一倍;更糟的是**分享页**(服务端只带走 role+content)因为整段被切掉而完全没图。
 * 现在 content 里只内联长边 ≤1280 的缩略图,原图留在 attachments。
 *
 * 用例覆盖:
 *   1) 缩略图策略(直接调真函数):单图 ≤ 上限、可解码、不超预算、原图不被内联;
 *      小图原样内联(不做无谓重编码);正文很长时不再内联图片(给服务端上限留余量);
 *   2) 端到端:输入框真上传一张 900×900 的图 → 发出去,落库的 content 里没有原图、
 *      attachments 里原图完好、本地副本不再翻倍、气泡与灯箱(点开图片)仍按原图渲染;
 *   3) 点开图片(灯箱)看到的是原图 PNG,不是正文里那张 WebP 缩略图;
 *   4) 分享这条对话:分享页仍然有图(修复前是「图没了」),且存下来没被截断;
 *      对照组:历史那种「原图内联」的分享会被截断且分享页没图 —— 证明这条用例不是空转;
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
const PORT = Number(process.env.IMGINLINE_GUI_PORT || 8351);
const MOCK_PORT = Number(process.env.IMGINLINE_GUI_MOCK_PORT || 8352);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'imginline-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用(疑似残留的 php -S),请先结束该进程或用环境变量换端口`);
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
  for (const c of candidates) { try { return await import(c); } catch (e) { /* 试下一个 */ } }
  return null;
}
const pw = await loadPlaywright();
if (!pw) { console.log('(skip) 未找到 playwright,跳过正文内联图片 GUI 自检'); process.exit(0); }

// ---- 造真实可解码的大 PNG(随机像素,deflate 压不动,编码后自然很大)D----
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
function makePng(w, h, solid) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w * 3; x++) raw[off + 1 + x] = solid ? 128 : Math.floor(Math.random() * 256);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: solid ? 9 : 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TMP = join(tmpdir(), 'tc-imginline-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
function spawnPhp(args, env) {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
}
function cleanup() {
  for (const p of procs) { try { p.kill(); } catch (e) { /* 忽略 */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
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

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const UID = login.user.id;

const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'InlineMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-inline',
    apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true,
    models: [{ id: 'mock-model-vl', name: 'Mock VL' }],
  }),
})).json();
if (!provRes.provider || !provRes.provider.id) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }
const PROV = provRes.provider.id;

const BIG = makePng(900, 900, false);
const BIG_B64 = BIG.toString('base64');
const BIG_DATA_URL = 'data:image/png;base64,' + BIG_B64;
const SMALL = makePng(16, 16, true);
console.log('   大图 ' + Math.round(BIG.length / 1024) + 'KB → data URL ' + BIG_DATA_URL.length + ' 字符(旧实现正文里也内联这一份)');

const browser = await pw.chromium.launch();
const pageErrors = [];

console.log('\n== 1. 缩略图策略(直接调真函数)==');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
// 同步推送的观测点。单设备下不该出现 409 自相冲突:两次推送重叠时,后一个会带着
// 还没被响应更新的 baseRevision 出去,服务端只能回整表要求合并 —— 纯自找的一次往返。
const syncStates = [];
const syncConflicts = [];
page.on('response', (r) => {
  if (r.url().includes('/api/sync/chats')) {
    if (r.request().method() === 'POST') {
      syncStates.push(r.status());
      if (r.status() === 409) syncConflicts.push(r.url().replace(BASE, ''));
    }
    return;
  }
  // 其它 4xx/5xx 一并记下来(例如图片被送去 MinerU 解析会 502 —— 本用例用的模型按视觉走,不该出现)
  if (r.status() >= 400) console.log('   [http] ' + r.status() + ' ' + r.request().method() + ' ' + r.url().replace(BASE, ''));
});
await page.addInitScript(([token, pid]) => {
  localStorage.setItem('oc_token', token);
  // 打开页面就把模型定到 mock 上(供应商 + 模型走 ui.js 的偏好键),省去点选择器
  localStorage.setItem('oc_prefs', JSON.stringify({
    providerId: pid, model: 'mock-model-vl',
    lastProviderId: pid, lastModel: 'mock-model-vl',
    pinnedProviderId: pid, pinnedModel: 'mock-model-vl',
    followups: false, aiJudge: false, autoImageMode: 'off',
  }));
}, [login.token, PROV]);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });

const probe = await page.evaluate(async (args) => {
  const MM = window.OCMultimodal;
  const toFile = (b64, name) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: 'image/png' });
  };
  const decode = (src) => new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight, ok: true });
    img.onerror = () => res({ w: 0, h: 0, ok: false });
    img.src = src;
  });
  const big = await MM.readFile(toFile(args.bigB64, '门店照片.png'));
  const small = await MM.readFile(toFile(args.smallB64, '小图标.png'));
  const content = MM.buildMessageContent('帮我看看这张图', [big]);
  const longText = '这是一段很长的正文'.repeat(12000); // 18 万字符:留给图片的预算已经不够
  const longContent = MM.buildMessageContent(longText, [big]);
  const previewDecoded = await decode(big.previewUrl || '');
  const smallDecoded = await decode(small.previewUrl || '');
  return {
    limit: MM.PREVIEW_MAX_CHARS,
    budget: MM.CONTENT_IMAGE_BUDGET,
    bigDataLen: big.dataUrl.length,
    previewLen: (big.previewUrl || '').length,
    previewKind: String(big.previewUrl || '').slice(0, 16),
    previewMaxEdge: Math.max(previewDecoded.w, previewDecoded.h),
    previewOk: previewDecoded.ok,
    contentLen: content.length,
    contentHasImage: /!\[门店照片\.png\]\(data:image\//.test(content),
    contentHasOriginal: content.indexOf(big.dataUrl) >= 0,
    contentKeepsText: content.indexOf('帮我看看这张图') === 0,
    smallVerbatim: small.previewUrl === small.dataUrl,
    smallPreviewOk: smallDecoded.ok,
    smallEdge: Math.max(smallDecoded.w, smallDecoded.h),
    longLen: longContent.length,
    longHasImage: /!\[门店照片\.png\]\(data:image\//.test(longContent),
    longKeepsText: longContent.length >= longText.length,
  };
}, { bigB64: BIG_B64, smallB64: SMALL.toString('base64') });

console.log('   原图 ' + probe.bigDataLen + ' 字符 → 正文内联 ' + probe.previewLen + ' 字符(' + probe.previewKind + '…,长边 ' + probe.previewMaxEdge + ')');
check('原图仍在附件里(长度不变)', probe.bigDataLen === BIG_DATA_URL.length);
check('生成了缩略图且能解码(长边 ' + probe.previewMaxEdge + ')', probe.previewOk && probe.previewMaxEdge > 0);
check('缩略图长边不超过 1280', probe.previewMaxEdge <= 1280);
check('单张缩略图不超过上限 ' + probe.limit, probe.previewLen > 0 && probe.previewLen <= probe.limit);
check('正文里内联的是缩略图(不是原图):' + probe.contentLen + ' 字符', !probe.contentHasOriginal && probe.contentHasImage);
check('正文长度落在服务端截断线以内(200000)', probe.contentLen < 200000);
check('正文文字没被动过', probe.contentKeepsText);
check('小图原样内联(不做无谓重编码)', probe.smallVerbatim && probe.smallPreviewOk && probe.smallEdge === 16);
check('正文太长时不再内联图片(把预算留给正文)', !probe.longHasImage && probe.longKeepsText && probe.longLen < 200000);

console.log('\n== 2. 端到端:输入框真上传大图 → 发送 → 落库 ==');
await page.setInputFiles('#attach-btn input[type=file]', {
  name: '门店照片.png', mimeType: 'image/png', buffer: BIG,
});
await page.waitForSelector('#attach-previews .attach-img-preview', { timeout: 20000 });
await page.fill('#input', '帮我看看这张图');
await page.click('#send-btn');
await page.waitForFunction(() => {
  const s = window.OCApp.state;
  const c = (s.chats || [])[0];
  const m = c && c.messages[c.messages.length - 1];
  return !!(m && m.role === 'assistant' && m.content && !m._streaming);
}, null, { timeout: 60000 }).catch(() => {});
await page.evaluate(() => window.OCStore && window.OCStore.flush && window.OCStore.flush());

const saved = await page.evaluate((args) => {
  const c = (window.OCApp.state.chats || [])[0] || {};
  const um = (c.messages || []).find((m) => m.role === 'user') || {};
  const att = (um.attachments || [])[0] || {};
  const store = window.OCStore.get('oc_chats_' + args.uid) || '';
  const bubble = document.querySelector('#messages .msg.user .msg-content');
  const img = bubble ? bubble.querySelector('img') : null;
  return {
    msgCount: (c.messages || []).length,
    contentLen: String(um.content || '').length,
    contentHasOriginal: String(um.content || '').indexOf(String(att.dataUrl || 'x')) >= 0,
    contentHasImage: /!\[门店照片\.png\]\(data:image\//.test(String(um.content || '')),
    attDataLen: String(att.dataUrl || '').length,
    attPreviewLen: String(att.previewUrl || '').length,
    storeLen: store.length,
    bubbleWidth: img ? img.naturalWidth : 0,
    bubbleSrc: img ? String(img.getAttribute('src') || '').slice(0, 16) : '',
  };
}, { uid: UID });

console.log('   落库:content ' + saved.contentLen + ' 字符,附件原图 ' + saved.attDataLen + ' 字符,本地副本 ' + saved.storeLen + ' 字符');
check('一轮对话真的完成了(用户 + 助手)', saved.msgCount === 2);
check('落库的 content 里没有原图(不再是两份完整 base64)', !saved.contentHasOriginal && saved.contentHasImage);
check('附件里的原图完好(发给上游/渲染都靠它)', saved.attDataLen === BIG_DATA_URL.length);
check('本地副本不再翻倍(小于原图的 1.5 倍:' + saved.storeLen + ' vs ' + saved.attDataLen + ')', saved.storeLen < saved.attDataLen * 1.5);
check('气泡仍按原图渲染(解码宽度 900,src ' + saved.bubbleSrc + '…)', saved.bubbleWidth === 900);

console.log('\n== 3. 点开图片(灯箱)看到的必须是原图,不能是正文那张缩略图 ==');
await page.click('#messages .msg.user .msg-content img');
await page.waitForSelector('.lightbox.show img', { timeout: 8000 }).catch(() => {});
await sleep(400);
const lightbox = await page.evaluate(async () => {
  const lbImg = document.querySelector('.lightbox.show img');
  const bubbleImg = document.querySelector('#messages .msg.user .msg-content img');
  const src = lbImg ? String(lbImg.getAttribute('src') || '') : '';
  const decoded = await new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => res({ w: 0, h: 0 });
    i.src = src || 'data:,';
  });
  return {
    shown: !!(lbImg && document.querySelector('.lightbox').classList.contains('show')),
    kind: src.slice(0, 22),
    len: src.length,
    width: decoded.w,
    bubbleDataLightbox: bubbleImg ? String(bubbleImg.getAttribute('data-lightbox') || '').length : 0,
  };
});
console.log('   灯箱:' + lightbox.kind + '… ' + lightbox.len + ' 字符,解码 ' + lightbox.width + 'px');
check('点图片确实弹出灯箱', lightbox.shown);
check('灯箱里是**原图**(PNG,' + lightbox.len + ' 字符 = 附件原图长度),不是正文那张 WebP 缩略图',
  lightbox.len === BIG_DATA_URL.length && /^data:image\/png/.test(lightbox.kind));
check('灯箱内容与气泡一致(都是 attachments 里的原图)', lightbox.bubbleDataLightbox === BIG_DATA_URL.length);
check('灯箱按原图分辨率解码(900,不是缩略图的 512)', lightbox.width === 900);
await page.evaluate(() => {
  const lb = document.querySelector('.lightbox');
  if (lb) lb.classList.remove('show');
});

console.log('\n== 4. 分享这条对话:分享页仍然有图 ==');
// 按客户端 shareableMessages 的口径,从本机会话取消息(与 UI 点「分享」完全一致)
const shareMsgs = await page.evaluate(() => {
  const c = (window.OCApp.state.chats || [])[0] || {};
  return { title: c.title || '图片对话', messages: (c.messages || [])
    .filter((m) => m && m.role !== 'system' && !m.error && String(m.content || '').trim())
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content) })) };
});
const shareRes = await (await fetch(BASE + '/api/shares', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ title: shareMsgs.title, messages: shareMsgs.messages }),
})).json();
const shareId = shareRes.share && shareRes.share.id;
check('创建分享成功(' + (shareId || JSON.stringify(shareRes).slice(0, 80)) + ')', !!shareId);

if (shareId) {
  const got = await (await fetch(BASE + '/api/shares/' + shareId)).json();
  const userMsg = ((got.share || {}).messages || []).find((m) => m.role === 'user') || {};
  const postUser = shareMsgs.messages.find((m) => m.role === 'user') || {};
  check('分享里存下的正文没被截断(' + String(userMsg.content || '').length + ' vs ' + String(postUser.content || '').length + ')',
    String(userMsg.content || '').length === String(postUser.content || '').length);
  check('分享正文里带着图(缩略图)', /!\[门店照片\.png\]\(data:image\//.test(String(userMsg.content || '')));

  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => pageErrors.push('share: ' + String((e && e.message) || e)));
  p3.on('console', (m) => { if (m.type() === 'error') pageErrors.push('share console: ' + m.text()); });
  await p3.goto(BASE + '/s/' + shareId, { waitUntil: 'domcontentloaded' });
  await p3.waitForSelector('#share-msgs .msg', { timeout: 20000 });
  await sleep(800);
  const shareShot = await p3.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#share-msgs .msg-content img'));
    const txt = document.querySelector('#share-msgs') ? document.querySelector('#share-msgs').innerText : '';
    return {
      count: imgs.length,
      widths: imgs.map((i) => i.naturalWidth),
      srcs: imgs.map((i) => String(i.getAttribute('src') || '').slice(0, 16)),
      base64Wall: /[A-Za-z0-9+/]{100,}/.test(txt),
      hasText: txt.indexOf('帮我看看这张图') >= 0,
    };
  });
  console.log('   分享页:图片 ' + shareShot.count + ' 张,解码宽度 [' + shareShot.widths.join(',') + ']');
  check('分享页渲染出图片(修复前这里是没有图的)', shareShot.count === 1 && shareShot.widths[0] > 0);
  check('分享页用的是缩略图(内联 data URL)', /^data:image\//.test(shareShot.srcs[0] || ''));
  check('分享页没有 base64 墙,且正文文字在', !shareShot.base64Wall && shareShot.hasText);
  await ctx3.close();

  // 对照组:老数据那种「原图内联」的分享会被 200000 上限截断,分享页就没有图了
  const legacyRes = await (await fetch(BASE + '/api/shares', {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ title: '老式分享', messages: [{ role: 'user', content: '看看\n\n![门店照片.png](' + BIG_DATA_URL + ')' }] }),
  })).json();
  const legacyId = legacyRes.share && legacyRes.share.id;
  if (legacyId) {
    const lg = await (await fetch(BASE + '/api/shares/' + legacyId)).json();
    const stored = String((((lg.share || {}).messages || [])[0] || {}).content || '');
    check('对照组:老式分享的正文确实被截断了(' + stored.length + ' < ' + (BIG_DATA_URL.length + 8) + ')', stored.length < BIG_DATA_URL.length);
    const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p4 = await ctx4.newPage();
    p4.on('pageerror', (e) => pageErrors.push('legacy share: ' + String((e && e.message) || e)));
    await p4.goto(BASE + '/s/' + legacyId, { waitUntil: 'domcontentloaded' });
    await p4.waitForSelector('#share-msgs .msg', { timeout: 20000 });
    await sleep(600);
    const legacyImgs = await p4.evaluate(() => document.querySelectorAll('#share-msgs .msg-content img').length);
    check('对照组:老式分享页没有图(说明本用例不是在空转)', legacyImgs === 0);
    await ctx4.close();
  }
}

console.log('\n== 5. 同步没有自相冲突(单设备下不该出现 409)==');
console.log('   本轮推送 ' + syncStates.length + ' 次,状态 [' + syncStates.join(',') + ']');
// 推送重叠时,后一个会带着还没被响应更新的 baseRevision 出去,服务端只能回整表要求合并。
// 冲突路径本身安全(合并后重推),但那是纯自找的一次整表往返 —— 这里钉住「不再发生」。
check('推送都是 200(没有 409 自相冲突):[' + syncStates.join(',') + ']',
  syncStates.length > 0 && syncStates.every((c) => c === 200), syncConflicts.join(' '));

console.log('\n== 6. 无 JS 异常 ==');
check('全流程无 JS 报错', pageErrors.length === 0);
if (pageErrors.length) console.log('    ' + pageErrors.slice(0, 5).join('\n    '));

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
