/* 对话页 @引用 浏览器自检(真 Chromium,真服务端 + mock 上游):
 *   node tests/chat-mentions-gui.mjs
 *
 * 背景:这一组问题都能过类型/单元检查,却都只能在真实 DOM 里暴露——
 *   1) 「@ 面板 → 整个文件夹」这条路径没有把输入框里正在输入的 @ 片段删掉,
 *      选完会残留一个孤零零的 @;紧接着按 Enter 还会被候选面板吃掉
 *      (第一次 Enter 只收面板、不发送),用户以为消息发出去了;
 *   2) 发出的提问只在气泡里显示正文,@助手/@笔记 引用完全丢失,
 *      看不出这轮提问引用了什么;
 *   3) 回答侧的「📒 基于 N 篇笔记回答」提示条挂在 .msg(flex 行)里、
 *      成了正文的兄弟节点,把解答区挤窄约 1/4;
 *   4) 该提示条与「参考笔记」来源行在流式结束的精准重绘时没被清掉,
 *      于是同一处渲染两份,重复且占高。
 *
 * 用例覆盖(桌面 1280×900 + 窄屏 390×844):
 *   1) 选「整个文件夹」/「单篇笔记」后输入框都不留 @;
 *   2) 用户气泡按输入框的样子回显 @引用:@助手 蓝、@文件夹/@笔记 红,可点击;
 *   3) 回答末尾「参考笔记」来源行只有一处(挂在 .msg-content 内,不挤正文、重绘不叠加),
 *      且没有「📒 基于 N 篇笔记回答」提示条;
 *   4) 刷新后引用回显与来源行都在(本地存储往返),窄屏不撑破气泡、无横向溢出;
 *   5) 旧版本存下来的历史消息不再显示残留的孤立 @,用户自己写的 @ 不受影响;
 *   6) 全流程无 JS 异常。
 *
 * 需要 playwright 与 chromium;缺失时自动跳过并返回 0(不阻塞 CI)。
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
const ADMIN = { name: 'admin', password: 'gui-pass' };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c) => { if (c) ok(m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 端口被残留的开发服务器占用时,请求会打到别的进程上(实测会拿到另一个目录的
// PHP 报错页,表现为「登录返回 HTML」),排查成本极高,直接提前报错。
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
  for (const c of candidates) { try { return await import(c); } catch (e) { /* 试下一个 */ } }
  return null;
}
const pw = await loadPlaywright();
if (!pw) { console.log('(skip) 未找到 playwright,跳过 @引用 浏览器自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-mentions-' + Date.now());
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
const login = await loginRes.json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'MentionMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-mention',
    apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }

// 笔记目录:外层「图表呈现」+ 内层「未分类」(3 篇,含一篇长标题)
const now = Date.now();
const doc = {
  folders: [
    { id: 'f-charts', parentId: null, name: '图表呈现', description: '', createdAt: now, updatedAt: now },
    { id: 'f-uncat', parentId: 'f-charts', name: '未分类', description: '', createdAt: now, updatedAt: now },
  ],
  notes: [
    { id: 'n1', folderId: 'f-uncat', title: '测试', content: '', tags: [], createdAt: now, updatedAt: now },
    { id: 'n2', folderId: 'f-uncat', title: 'openai等供应商有什么常见的RAG模型', content: 'RAG 不是模型类别，而是一种架构。', tags: [], createdAt: now, updatedAt: now },
    { id: 'n3', folderId: 'f-uncat', title: '111', content: '', tags: [], createdAt: now, updatedAt: now },
  ],
  tombs: {},
};
await fetch(BASE + '/api/sync/notes', { method: 'POST', headers: AUTH, body: JSON.stringify({ doc, baseRevision: 0 }) });

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

await page.addInitScript(([token, prov]) => {
  localStorage.setItem('oc_token', token);
  localStorage.setItem('oc_provider', prov);
  localStorage.setItem('oc_model_' + prov, 'mock-model');
}, [login.token, PROV]);

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.evaluate(() => { if (window.OCNotes) window.OCNotes.warmUp(); });
await page.waitForFunction(() => !!(window.OCNotes && window.OCNotes.isReady && window.OCNotes.isReady()), null, { timeout: 30000 });
await page.waitForFunction(() => (window.OCApp.state.models || []).length > 0, null, { timeout: 20000 });

console.log('== 1. 选「整个文件夹」/「单篇笔记」后输入框不留 @ ==');
// 先选中助手(已选助手时 @ 面板默认停在「笔记」页签,与用户常见路径一致)
await page.evaluate(() => window.startAssistantChat({ id: 'as-present', name: '图表呈现', prompt: '你是图表呈现助手。' }));
await page.waitForTimeout(300);
check('已选中助手「图表呈现」', (await page.evaluate(() => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId) || {};
  return c.assistantName;
})) === '图表呈现');

const input = page.locator('#input');
await input.click();
await input.type('@');
await page.waitForSelector('#mention-pop:not(.hidden)', { timeout: 8000 });
await page.waitForTimeout(400);
check('已选助手时默认停在「笔记」页签(实际 ' + (await page.locator('.mention-tab.active').innerText()) + ')',
  (await page.locator('.mention-tab.active').innerText()) === '笔记');
await page.locator('.mention-folder-row', { hasText: '未分类' }).first().locator('[data-folder-pick]').click();
await page.waitForTimeout(250);
const v1 = await input.inputValue();
check('选「整个文件夹」后输入框无残留 @(实际 ' + JSON.stringify(v1) + ')', !v1.includes('@'));
check('输入区显示了文件夹 chip', (await page.locator('#note-mention-row .note-mention-chip').allInnerTexts()).join('').includes('未分类'));

await input.type('@');
await page.waitForTimeout(500);
await page.locator('.mention-folder-row', { hasText: '未分类' }).first().locator('.mention-folder').click();
await page.waitForTimeout(300);
check('展开文件夹后能看到笔记项', (await page.locator('.mention-item.mention-note').count()) > 0);
await page.locator('.mention-item.mention-note', { hasText: 'RAG' }).first().click();
await page.waitForTimeout(250);
const v2 = await input.inputValue();
check('选「单篇笔记」后输入框也无残留 @(实际 ' + JSON.stringify(v2) + ')', !v2.includes('@'));

console.log('\n== 2. 用户气泡回显 @引用(助手蓝 / 笔记·文件夹红) ==');
await input.type('总结');
await page.keyboard.press('Enter');
await page.waitForFunction(() => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId);
  return c && (c.messages || []).some((m) => m.role === 'assistant' && String(m.content || '').includes('MOCK-REPLY'));
}, null, { timeout: 40000 }).catch(() => bad('等待回答超时'));
await page.waitForTimeout(1200);

// 发送后输入框:笔记引用 chip 应清空,且高度必须跟着内容重算
// (曾出现「发出去后输入框莫名变高」:高度按清空前的宽缩进算好就没人再算)
const composer = await page.evaluate(() => {
  const inp = document.querySelector('#input');
  const box = document.querySelector('#note-mention-row');
  const h = inp.clientHeight;
  const prev = inp.style.height;
  // 内容真正需要的高度:先归零再量(scrollHeight 不会小于 clientHeight,带着旧高度量会自我印证)
  inp.style.height = 'auto';
  const want = Math.min(inp.scrollHeight, 180);
  inp.style.height = prev;
  return {
    h,
    want,
    notesHidden: box ? box.classList.contains('hidden') : null,
  };
});

const snap = await page.evaluate(() => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId) || {};
  const um = (c.messages || []).find((m) => m.role === 'user') || {};
  const bubble = document.querySelector('#messages .msg.user .msg-content');
  const chipEls = bubble ? Array.from(bubble.querySelectorAll('.msg-mentions .note-mention-chip')) : [];
  const asst = document.querySelectorAll('#messages .msg.assistant');
  const last = asst[asst.length - 1];
  const content = last ? last.querySelector('.msg-content') : null;
  const prose = last ? last.querySelector('.md-prose') : null;
  return {
    mentions: um.mentions,
    bubbleText: bubble ? bubble.innerText : '',
    chipColors: chipEls.map((el) => ({ text: el.innerText, color: getComputedStyle(el).color, cls: el.className })),
    chipCount: chipEls.length,
    hintCount: document.querySelectorAll('.note-answer-hint').length,
    refRowCount: document.querySelectorAll('.note-ref-row').length,
    refRowInContent: document.querySelectorAll('.msg.assistant .msg-content > .note-ref-row').length,
    refRowText: (() => {
      const r = document.querySelector('#messages .msg.assistant .msg-content > .note-ref-row');
      return r ? r.innerText : '';
    })(),
    refTextHit: document.querySelector('#messages') ? document.querySelector('#messages').innerText.includes('参考笔记') : false,
    contentW: content ? Math.round(content.getBoundingClientRect().width) : 0,
    proseW: prose ? Math.round(prose.getBoundingClientRect().width) : 0,
    // 消息行、头像与正文左边缘:用来把「正文有没有被挤窄」写成与列宽无关的相对判据。
    // 直接减 avatarW 不成立 —— 头像与正文之间还有行内 gap,且正文自身可能有内边距,
    // 所以按「正文左边缘到行右边缘」来算可用宽度,这才是它该占满的区域。
    msgRowW: (() => { const a = document.querySelectorAll('#messages .msg.assistant'); const l = a[a.length - 1]; return l ? Math.round(l.getBoundingClientRect().width) : 0; })(),
    msgRowRight: (() => { const a = document.querySelectorAll('#messages .msg.assistant'); const l = a[a.length - 1]; return l ? Math.round(l.getBoundingClientRect().right) : 0; })(),
    msgRowPadRight: (() => { const a = document.querySelectorAll('#messages .msg.assistant'); const l = a[a.length - 1]; return l ? parseFloat(getComputedStyle(l).paddingRight) || 0 : 0; })(),
    avatarW: (() => { const a = document.querySelectorAll('#messages .msg.assistant'); const l = a[a.length - 1]; const av = l ? l.querySelector('.msg-avatar') : null; return av ? Math.round(av.getBoundingClientRect().width) : 0; })(),
    contentLeft: content ? Math.round(content.getBoundingClientRect().left) : 0,
    msgChildren: last ? Array.from(last.children).map((el) => el.className) : [],
    // 引用 chip 与紧随其后的正文必须同高:overflow:hidden 的 inline-block 以底边当基线,
    // 若按 baseline 对齐会把 chip 抬高一整个行高(实测段落 30.6px vs 行高 23.8px)。
    //
    // 注意不能拿「整个段落高度」当判据:对话列宽度是可调的(默认 61.8%),窄列下
    // 三个 chip 加正文本来就会折成两行,段落高 47.6 = 2×23.8 完全正常 —— 那样断言
    // 会变成「只在宽列下成立」的假保证。真正的不变量是 chip 的**底边落在自己的行盒里**:
    // 首行顶部 = pTop,首行底边 = pTop + 行高,chip 底边必须与之齐平(±2 容纳亚像素)。
    firstLine: (() => {
      const p = bubble ? bubble.querySelector('p') : null;
      if (!p) return null;
      const chip = p.querySelector('.msg-mentions .note-mention-chip');
      const lh = parseFloat(getComputedStyle(p).lineHeight) || 0;
      let textBottom = null;
      p.childNodes.forEach((n) => {
        if (textBottom != null || n.nodeType !== 3 || !n.nodeValue.trim()) return;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        textBottom = rg.getBoundingClientRect().bottom;
      });
      const pRect = p.getBoundingClientRect();
      const chipRect = chip ? chip.getBoundingClientRect() : null;
      return {
        lineHeight: lh,
        paragraphHeight: Math.round(pRect.height * 100) / 100,
        pTop: Math.round(pRect.top * 100) / 100,
        lineCount: lh > 0 ? Math.round(pRect.height / lh) : 0,
        // 该 chip 自己所在行的底边(按它顶部落在第几行算,不假设只有一行)
        ownLineBottom: (chipRect && lh > 0)
          ? Math.round((pRect.top + (Math.floor((chipRect.top - pRect.top) / lh) + 1) * lh) * 100) / 100
          : null,
        chipBottom: chipRect ? Math.round(chipRect.bottom * 100) / 100 : null,
        textBottom: textBottom == null ? null : Math.round(textBottom * 100) / 100,
      };
    })(),
  };
});
console.log('  引用快照 =', JSON.stringify(snap.mentions));
console.log('  气泡显示 =', JSON.stringify(snap.bubbleText));
check('用户消息上记录了引用快照(助手+文件夹+笔记)', Array.isArray(snap.mentions) && snap.mentions.length === 3);
check('气泡里回显 @助手', snap.bubbleText.includes('图表呈现'));
check('气泡里回显 @文件夹 与 @笔记', snap.bubbleText.includes('未分类') && snap.bubbleText.includes('RAG'));
check('气泡正文保留了「总结」', snap.bubbleText.includes('总结'));
check('回显 chip 数量 = 3(实际 ' + snap.chipCount + ')', snap.chipCount === 3);

const isBlue = (c) => {
  const m = /rgb\((\d+), ?(\d+), ?(\d+)\)/.exec(c || '');
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return b > r + 40 && b > g + 40;   // 蓝分量明显占优
};
const isRed = (c) => {
  const m = /rgb\((\d+), ?(\d+), ?(\d+)\)/.exec(c || '');
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return r > g + 60 && r > b + 60;   // 红分量明显占优
};
const asstChip = snap.chipColors.find((x) => x.text.includes('图表呈现'));
const folderChip = snap.chipColors.find((x) => x.text.includes('未分类'));
const noteChip = snap.chipColors.find((x) => x.text.includes('RAG'));
check('@助手 用品牌蓝(实际 ' + (asstChip && asstChip.color) + ')', !!asstChip && isBlue(asstChip.color));
check('@文件夹 用红色(实际 ' + (folderChip && folderChip.color) + ')', !!folderChip && isRed(folderChip.color));
check('@笔记 用红色(实际 ' + (noteChip && noteChip.color) + ')', !!noteChip && isRed(noteChip.color));
const fl = snap.firstLine;
// 不变量:chip 底边与自己所在的行盒底边齐平(与列宽无关)。
// 判据写成「chip 底边 == pTop + 整数倍行高」而不是「段落只有一行」:列宽可变、
// 窄列下三个 chip 会折行,后者会变成只在宽列成立的假保证。
check('引用 chip 与正文在同一行高上(行高 ' + (fl && fl.lineHeight) + ', 行数 ' + (fl && fl.lineCount) + ')',
  !!fl && fl.lineHeight > 0 && fl.lineCount >= 1 && Math.abs(fl.paragraphHeight - fl.lineCount * fl.lineHeight) <= 1.5);
check('引用 chip 底边与所在行底边齐平(chip ' + (fl && fl.chipBottom) + ' / 行底 ' + (fl && fl.ownLineBottom) + ')',
  !!fl && fl.chipBottom != null && fl.ownLineBottom != null && Math.abs(fl.chipBottom - fl.ownLineBottom) <= 2);
check('发送后输入区的笔记引用 chip 已清空', composer.notesHidden === true);
check('发送后输入框高度跟随内容重算(不再停在旧缩进的高度上): 实际 ' + composer.h + ' / 需要 ' + composer.want,
  Math.abs(composer.h - composer.want) <= 1);
// 空输入框必须只有一行:选中助手后正文有悬挂缩进(首行让出 @ 行宽度),列宽变窄时
// 原来那句 35 字的长占位符会折成两行、把空输入框撑到 62px —— 观感就是「输入框莫名变高」。
// 现在缩进激活时自动换短占位符(见 index.html 的 data-placeholder-compact)。
check('发送后输入框回到单行高度(实际 ' + composer.h + 'px)', composer.h <= 48);

console.log('\n== 3. 回答末尾只有一处「参考笔记」、正文不被挤窄 ==');
check('没有「基于 N 篇笔记回答」提示条(此前它把正文挤窄)', snap.hintCount === 0);
check('回答末尾有且仅有一处「参考笔记」来源行(实际 ' + snap.refRowCount + ')', snap.refRowCount === 1);
check('来源行列出了这轮真正用到的笔记(实际 ' + JSON.stringify(snap.refRowText) + ')', snap.refRowText.includes('RAG'));
check('来源行挂在 .msg-content 内(随内容一起重绘,不会叠加)', snap.refRowInContent === 1);
check('正文宽度 = 内容区宽度(未被来源行挤压): prose ' + snap.proseW + ' / content ' + snap.contentW,
  snap.proseW > 0 && Math.abs(snap.proseW - snap.contentW) <= 2);
// 这里问的是「正文有没有被别的东西挤窄」,不是「绝对值够不够大」——原来写死 600px
// 只在旧的固定 820px 列宽下成立,列宽改成可调百分比(默认 61.8%)后就是一条假断言。
// 真正的判据:正文从自己的左边缘一直铺到消息行的右侧内边缘(行内 gap 与头像都算进去)。
check('正文占满消息行可用宽度(正文 ' + snap.contentW + ' / 可用 ' + (snap.msgRowRight - snap.msgRowPadRight - snap.contentLeft) + ')',
  snap.contentW > 0 && snap.msgRowRight > 0 &&
  Math.abs(snap.contentW - (snap.msgRowRight - snap.msgRowPadRight - snap.contentLeft)) <= 2);
check('.msg 下没有挂在正文之外的提示条/来源行: ' + JSON.stringify(snap.msgChildren),
  !snap.msgChildren.includes('note-answer-hint') && !snap.msgChildren.includes('note-ref-row'));

console.log('\n== 4. 刷新后回显仍在(本地存储往返) ==');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
await page.waitForFunction(() => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId);
  return !!(c && (c.messages || []).some((m) => m.role === 'user' && Array.isArray(m.mentions) && m.mentions.length));
}, null, { timeout: 30000 }).catch(() => bad('刷新后未恢复到含引用的对话'));
const afterReload = await page.evaluate(() => {
  const bubble = document.querySelector('#messages .msg.user .msg-content');
  return {
    chipCount: bubble ? bubble.querySelectorAll('.msg-mentions .note-mention-chip').length : 0,
  };
});
check('刷新后气泡仍回显 3 个 chip(实际 ' + afterReload.chipCount + ')', afterReload.chipCount === 3);
check('刷新后「参考笔记」来源行仍在、只有一份、没有重复提示条(实际 ' + (await page.locator('.note-ref-row').count()) + ')',
  (await page.locator('.note-answer-hint').count()) === 0 && (await page.locator('.note-ref-row').count()) === 1);

console.log('\n== 5. 历史消息(旧版本残留 @)不再显示多余 @ ==');
// 追加两条「旧版本存下来的」消息,再用侧边栏点击触发一次真实的全量重绘:
//   1) 旧版点「整个文件夹」漏删输入框里的 @,消息正文会以「@ 总结」开头;
//   2) 用户自己写的「@未分类」是正文的一部分,不能被误删。
const legacyBubbleTexts = () => page.evaluate(() => {
  const bubbles = Array.from(document.querySelectorAll('#messages .msg.user .msg-content'));
  return bubbles.map((el) => el.innerText).filter((t) => t.includes('旧版'));
});
await page.evaluate(() => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId);
  // 起一个唯一标题:重绘后按标题点回这条对话,不依赖列表排序
  c.title = '旧版消息用例';
  const SEP = String.fromCharCode(10, 10, 45, 45, 45, 10);
  const INSTR = '用户 @ 了 3 篇笔记，请只根据下面提供的笔记内容回答；笔记里没有的信息要明确说明。';
  // 旧版形态 A:残留 @ + 注入的笔记上下文,且消息上没有 mentions 快照
  c.messages.push({
    role: 'user',
    content: '@ 旧版A 总结' + SEP + INSTR + SEP + '【笔记1】测试',
    createdAt: Date.now(),
  });
  c.messages.push({ role: 'assistant', content: 'MOCK-REPLY', createdAt: Date.now() });
  // 旧版形态 B:用户自己写的 @未分类 属于正文,不能被当成残留 @ 删掉
  c.messages.push({
    role: 'user',
    content: '@未分类 旧版B 总结' + SEP + INSTR,
    createdAt: Date.now(),
  });
  c.messages.push({ role: 'assistant', content: 'MOCK-REPLY', createdAt: Date.now() });
});
// 点侧边栏「新建对话」离开这条会话,再按标题点回来:
// 走的是用户在会话之间点来点去的同一条路径(renderChatList → onSelect → renderMessages)
await page.locator('#new-chat-btn').click();
await page.waitForTimeout(500);
await page.locator('#chat-list .chat-item', { hasText: '旧版消息用例' }).first().click();
await page.waitForTimeout(600);
const legacyText = await legacyBubbleTexts();
console.log('  历史消息气泡(重绘后)=', JSON.stringify(legacyText));
check('历史消息确实重绘出来了(实际 ' + legacyText.length + ' 条)', legacyText.length === 2);
const legacyA = legacyText.find((t) => t.includes('旧版A')) || '';
const legacyB = legacyText.find((t) => t.includes('旧版B')) || '';
check('旧版残留的孤立 @ 不再显示(实际 ' + JSON.stringify(legacyA.trim()) + ')', legacyA.trim() === '旧版A 总结');
check('用户自己写的 @未分类 原样保留(实际 ' + JSON.stringify(legacyB.trim()) + ')',
  legacyB.includes('@未分类') && legacyB.includes('旧版B 总结'));
check('历史消息里的笔记上下文没有漏进气泡', legacyText.every((t) => !t.includes('请只根据下面提供的笔记内容回答')));
check('历史消息不显示注入的笔记原文', legacyText.every((t) => !t.includes('【笔记1】')));

console.log('\n== 6. 窄屏(390×844)不撑破气泡 ==');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
const narrow = await page.evaluate(() => {
  const bubble = document.querySelector('#messages .msg.user .msg-content');
  const chip = bubble && bubble.querySelector('.msg-mentions .note-mention-chip:not(.note-mention-assistant)');
  return {
    bubbleW: bubble ? Math.round(bubble.getBoundingClientRect().width) : 0,
    chipW: chip ? Math.round(chip.getBoundingClientRect().width) : 0,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check('窄屏无横向溢出(实际 ' + narrow.overflowX + 'px)', narrow.overflowX <= 1);
check('长标题 chip 不超出气泡(' + narrow.chipW + ' <= ' + narrow.bubbleW + ')', narrow.chipW <= narrow.bubbleW + 1);
await page.setViewportSize({ width: 1280, height: 900 });

console.log('\n== 7. 无 JS 异常 ==');
const relevant = pageErrors.filter((e) => !/favicon/i.test(e));
check('无页面异常' + (relevant.length ? ': ' + relevant.slice(0, 3).join(' | ') : ''), relevant.length === 0);

await ctx.close();
await browser.close();
console.log('\n' + (fail ? `✗ @引用 浏览器自检失败: ${fail} 项(通过 ${pass})` : `✓ @引用 浏览器自检通过(${pass} 项)`));
process.exit(fail ? 1 : 0);
