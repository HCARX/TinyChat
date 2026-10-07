/* 输入框草稿保护 GUI 自检(真 Chromium + 真服务端 + mock 上游):
 *   node tests/composer-draft-gui.mjs
 *
 * 背景:发送前的某个校验没过时,输入框却已经被清空了 —— 用户辛苦打的字、选好的附件
 * 就这么没了,屏幕上只剩一句「请先在『参与人数』里启用成员并分配模型」之类的提示。
 * 最典型的一条:开着群聊(多角色)但还没给角色分配模型,发一句话就被清空。
 *
 * 这类缺陷的共同点是「点发送」到「真的落消息」之间有一段提前清空,单测覆盖不到
 * (要的是真 DOM 里 input 的值与真实的事件时序),只有真浏览器按用户路径按一遍 Enter
 * 才看得出来。用例:
 *   1) 群聊模式 + 默认班底还没分配模型:提示 + 输入框里的字与挂着的附件都还在,没落任何消息;
 *   2) 群聊模式 + 角色已分配模型:照常发出、输入框清空(修复不能误伤正常发送);
 *   3) 生图模型 + 只挂了一份文档、没有画面描述:提示 + 附件草稿还在,没落消息;
 *   4) 视频模型同理;
 *   5) 对话模型 + 有文字的正常一轮不受影响;
 *   6) 全程无 JS 异常。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8311);
const MOCK_PORT = Number(process.env.GUI_MOCK_PORT || 8312);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'draft-pass' };

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
if (!pw) { console.log('(skip) 未找到 playwright,跳过输入框草稿 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-draft-' + Date.now());
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

const loginRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
});
const login = await loginRes.json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

// 一把 Key 下三个模型:对话 / 生图 / 视频。后两个靠显式标记(normalize 会原样保留),
// 否则「空内容时先拦一道」的分支根本走不到。
const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'DraftMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-draft',
    apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true,
    models: [
      { id: 'mock-model', name: 'Mock' },
      { id: 'mock-image', name: 'MockImage', image: true },
      { id: 'mock-video', name: 'MockVideo', video: true },
    ],
  }),
})).json();
const PROV = provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }

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
await page.waitForFunction(() => !!(window.OCApp && window.OCApp.state && window.OCApp.state.user), null, { timeout: 30000 });
await page.waitForFunction(() => (window.OCApp.state.models || []).length > 0, null, { timeout: 20000 });

const input = page.locator('#input');

// 当前会话的消息(用于断言「这条到底发出去没有」)
const msgs = () => page.evaluate(() => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId);
  return (c && c.messages) || [];
});
// 提示条文本(用完即走,同一个用例里只断言一次)
const toastText = async () => (await page.locator('#oc-toast-host .toast').allInnerTexts()).join(' | ');

// 群聊设置弹窗是运行时建的,而且没有 id(只有 #group-modal-title 这个标题),
// 这里按内容定位,免得以后加/改 id 又把断言打偏
const GROUP_MODAL = '.modal-mask:has(#group-modal-title)';

// 挂一份文档(不是图片):走用户真实路径 —— 「≡」菜单里的「上传文件」→ 文件选择器。
// 不能拿 #attach-btn 当入口:桌面上它被 CSS 隐藏(附件并进了 ≡ 菜单),而且它内部还挂着
// 一份由 innerHTML 序列化出来的空 input(没接线),按 input[type=file] 取会拿到那个副本。
async function attachDoc(name) {
  await page.locator('#composer-more').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 8000 }),
    page.locator('#composer-tool-file').click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('这是一份需要保留的文档') });
  await page.waitForFunction(() => (window.OCApp.state.pendingAttachments || []).length >= 1, null, { timeout: 8000 })
    .catch(() => bad('附件没挂上'));
}

// 清掉输入区里挂着的附件:走真实的「移除」按钮,别直接改 state(那样断言就没意义了)
async function clearAttachments() {
  for (let i = 0; i < 8; i++) {
    const btn = page.locator('#attach-previews .fc-remove').first();
    if (!(await btn.count())) break;
    await btn.click();
    await sleep(150);
  }
  await page.waitForFunction(() => (window.OCApp.state.pendingAttachments || []).length === 0, null, { timeout: 5000 })
    .catch(() => bad('附件没能清掉(清理阶段)'));
}

console.log('== 1. 群聊模式 + 默认班底没分配模型:不能清空草稿 ==');
// 走用户的真实入口:点侧栏「简单对话/多角色」那行里的开关
await page.locator('#chat-mode-row .switch').click();await page.waitForFunction(() => window.OCGroup && window.OCGroup.isGroupMode(), null, { timeout: 8000 }).catch(() => bad('群聊模式未打开'));
check('已切到群聊模式', await page.evaluate(() => window.OCGroup.isGroupMode()));
check('默认班底确实还没有成员绑定模型(这正是要复现的场景)', await page.evaluate(() => {
  const g = window.OCGroup.activeGroup();
  return !!g && (g.participants || []).length > 0
    && !(g.participants || []).some((p) => p.enabled !== false && p.providerId && p.model);
}));
// 关掉群聊设置弹窗,回到输入框
await page.waitForSelector(GROUP_MODAL, { state: 'visible', timeout: 8000 }).catch(() => bad('群聊设置弹窗没打开'));
await page.locator(GROUP_MODAL + ' [data-act="close"]').click();
await sleep(400);
check('群聊设置弹窗已关闭', !(await page.locator(GROUP_MODAL).isVisible().catch(() => false)));

const DRAFT = '这段话是用户辛苦打的草稿，不能被清空';
// 附件也是「草稿」的一部分:被拒时同样不能消失
await attachDoc('草稿附件.txt');
await input.click();
await input.fill(DRAFT);
const beforeMsgCount = (await msgs()).length;
await input.press('Enter');
await sleep(1200);
check('被拒时提示写清了原因(实际「' + (await toastText()) + '」)',
  (await toastText()).includes('请先在「参与人数」里启用成员并分配模型'));
check('输入框里的草稿还在(实际 ' + JSON.stringify(await input.inputValue()) + ')',
  (await input.inputValue()) === DRAFT);
check('挂着的附件也还在', await page.evaluate(() => (window.OCApp.state.pendingAttachments || []).length >= 1));
check('附件卡片也还画在输入区', (await page.locator('#attach-previews .file-card').count()) >= 1);
check('没有偷偷落一条消息', (await msgs()).length === beforeMsgCount);

console.log('\n== 2. 群聊模式 + 角色已分配模型:照常发出并清空(别误伤正常发送) ==');
await page.evaluate((prov) => {
  const now = Date.now();
  localStorage.setItem('oc_groups', JSON.stringify({
    groups: [{
      id: 'g-draft', name: '草稿测试群', intro: '', mode: 'owner', rosterVersion: 2, createdAt: now,
      // 一收口就短:测试只关心「发得出去、发出去之后才清空」
      settings: { maxMembers: 2, maxRounds: 1, allowQuote: false, autoSummary: false, saveFullHistory: false },
      participants: [
        { id: 'p-admin', name: '群主', emoji: '👑', avatar: 1, bio: '', prompt: '', preset: 'owner', style: '', enabled: true, admin: true, providerId: prov, model: 'mock-model' },
        { id: 'p-one', name: '成员甲', emoji: '🦊', avatar: 2, bio: '', prompt: '', preset: '', style: '', enabled: true, admin: false, providerId: prov, model: 'mock-model' },
      ],
    }],
    activeId: 'g-draft',
  }));
  window.OCGroup.reload();
}, PROV);
await sleep(300);
check('已换成绑定好模型的群', await page.evaluate(() => {
  const g = window.OCGroup.activeGroup();
  return !!g && g.id === 'g-draft'
    && (g.participants || []).filter((p) => p.enabled !== false && p.providerId && p.model).length === 2;
}));

const GROUP_DRAFT = '群聊这条要能发出去';
await input.click();
await input.fill(GROUP_DRAFT);
await input.press('Enter');
// 用户消息由群聊管线自己落库:等它出现在对话里,就说明这一轮真的开跑了
const posted = await page.waitForFunction((t) => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId);
  return !!(c && (c.messages || []).some((m) => m.role === 'user' && String(m.content || '').includes(t)));
}, GROUP_DRAFT, { timeout: 30000 }).then(() => true).catch(() => false);
check('群聊这轮真的开跑了(用户消息已进对话)', posted);
// 收掉这一轮,别让后面的用例撞上「正在生成中」
await page.evaluate(() => { const b = document.getElementById('stop-btn'); if (b && !b.classList.contains('hidden')) b.click(); });
await page.waitForFunction(() => {
  const s = window.OCApp.state;
  return !s.streaming && !s._groupTurnActive;
}, null, { timeout: 30000 }).catch(() => bad('群聊回合没能收住'));
check('回合结束后输入框才被清空(实际 ' + JSON.stringify(await input.inputValue()) + ')',
  (await input.inputValue()) === '');

console.log('\n== 3. 生图模型 + 只挂文档:提示并保住附件草稿 ==');
await page.evaluate(() => { window.OCGroup.setMode('simple'); });
await page.evaluate(() => { window.OCApp.state.currentModel = 'mock-image'; });
await sleep(200);
check('当前模型已切到生图模型', await page.evaluate(() => window.OCApp.state.currentModel === 'mock-image'));
await input.fill('');
await clearAttachments();
await attachDoc('资料.txt');
const imgBefore = (await msgs()).length;
await input.press('Enter');
await sleep(1000);
check('提示说明是生图模型(实际「' + (await toastText()) + '」)', (await toastText()).includes('生图模型'));
check('附件草稿还在,没被清掉', await page.evaluate(() => (window.OCApp.state.pendingAttachments || []).length >= 1));
check('附件卡片也还画在输入区', (await page.locator('#attach-previews .file-card').count()) >= 1);
check('没有偷偷落一条消息', (await msgs()).length === imgBefore);

console.log('\n== 4. 视频模型 + 只挂文档:同样保住草稿 ==');
await page.evaluate(() => { window.OCApp.state.currentModel = 'mock-video'; });
await sleep(200);
check('当前模型已切到视频模型', await page.evaluate(() => window.OCApp.state.currentModel === 'mock-video'));
if (await page.evaluate(() => (window.OCApp.state.pendingAttachments || []).length === 0)) await attachDoc('资料.txt');
await input.fill('');
await page.evaluate(() => { document.querySelectorAll('#oc-toast-host .toast').forEach((t) => t.remove()); });
const vidBefore = (await msgs()).length;
await input.press('Enter');
await sleep(1000);
check('提示说明是视频模型(实际「' + (await toastText()) + '」)', (await toastText()).includes('视频模型'));
check('附件草稿还在,没被清掉', await page.evaluate(() => (window.OCApp.state.pendingAttachments || []).length >= 1));
check('没有偷偷落一条消息', (await msgs()).length === vidBefore);

console.log('\n== 5. 正常路径不受影响:对话模型 + 有文字,照常发出并清空 ==');
await page.evaluate(() => { window.OCApp.state.currentModel = 'mock-model'; });
await page.evaluate(() => { window.OCApp.state.pendingAttachments = []; });
// 用干净的会话,免得和上面几条混在一起(新建会话本身也会清空输入区)
await page.locator('#new-chat-btn').click();
await sleep(500);
await input.click();
await input.fill('正常的一轮对话');
await input.press('Enter');
const replied = await page.waitForFunction(() => {
  const s = window.OCApp.state;
  const c = (s.chats || []).find((x) => x.id === s.currentChatId);
  return !!(c && (c.messages || []).some((m) => m.role === 'user' && String(m.content || '').includes('正常的一轮对话')));
}, null, { timeout: 30000 }).then(() => true).catch(() => false);
check('正常一轮已发出', replied);
check('正常一轮发出后输入框被清空(实际 ' + JSON.stringify(await input.inputValue()) + ')',
  (await input.inputValue()) === '');
await page.waitForFunction(() => !window.OCApp.state.streaming, null, { timeout: 30000 }).catch(() => {});

console.log('\n== 6. 附件按钮里只有一个文件输入框(不是 innerHTML 序列化出的空副本) ==');
// 复现过的问题:app.js 用 attachBtn.innerHTML = btn.innerHTML 拷贝按钮,而 btn 里已经挂着
// 真正接好事件的 <input type=file> —— innerHTML 会把它一起序列化成一份没有监听器的副本,
// 再 appendChild(input) 就成了按钮里两个文件框。桌面端这个按钮被 CSS 隐藏,所以只有代码
// 能看出问题;直接选文件到那个副本上不会有任何反应。
const fileInputs = await page.evaluate(() => {
  const box = document.getElementById('attach-btn');
  if (!box) return null;
  const list = Array.from(box.querySelectorAll('input[type=file]'));
  return {
    total: list.length,
    // 真正接线的那份有 change 监听:选完文件后附件会进输入区。用「原件里带不带监听」判断不了,
    // 改成实际投递一次文件看结果(见下)。
    hasIcon: !!box.querySelector('svg'),
    inDoc: box.isConnected,
  };
});
check('能取到附件按钮', !!fileInputs && fileInputs.inDoc);
check('按钮里只有一个文件输入框(实际 ' + (fileInputs && fileInputs.total) + ' 个)',
  !!fileInputs && fileInputs.total === 1);
check('按钮里仍有回形针图标(搬节点时没把图标丢掉)', !!fileInputs && fileInputs.hasIcon);

// 真正接线的那份:选中文件后附件必须进输入区。旧写法下第 1 个 input 是空副本,
// 选它不会有任何反应 —— 这条断言正好把它挡住。
await page.evaluate(() => { window.OCApp.state.pendingAttachments = []; });
if (await page.locator('#attach-previews .fc-remove').count()) await clearAttachments();
await page.setInputFiles('#attach-btn input[type=file]', {
  name: '按钮直选.txt', mimeType: 'text/plain', buffer: Buffer.from('通过附件按钮选的文件'),
});
const btnPicked = await page.waitForFunction(() => (window.OCApp.state.pendingAttachments || []).length === 1, null, { timeout: 8000 })
  .then(() => true).catch(() => false);
check('文件输入框是接线的那一份(选完文件确实进了输入区)', btnPicked);
await clearAttachments();

check('全程无页面级报错', pageErrors.length === 0);
if (pageErrors.length) console.log('    报错: ' + pageErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
