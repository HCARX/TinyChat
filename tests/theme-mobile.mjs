/* 窄屏「输入框压住正文」专项检测:node tests/theme-mobile.mjs
 *
 * 为什么单独一个文件、而且必须真浏览器:
 *   输入框是**绝对定位悬浮**在消息区之上的(composer-area position:absolute),
 *   最后一条消息会不会被它盖住,取决于「.chat-area 的 padding-bottom」与
 *   「输入框实际高度 + 区域内边距」的差值 —— 这个差值只在滚动到底的那一刻才暴露,
 *   静态读 CSS 完全看不出来(CSS 里两处数字都写得好好的,只是加起来不够)。
 *
 * 判据:滚动到底后,最后一条消息(含它的「复制/重答」动作行)的底边,
 *       必须落在输入框顶边**之上**。压住即为不合格。
 * 覆盖:4 套主题 × 3 档宽度(1280 桌面 / 390 常见手机 / 360 老机型)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.MOB_PORT || 8341);
const MOCK_PORT = Number(process.env.MOB_MOCK_PORT || 8342);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'mobile-pass' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPW() {
  const c = [];
  try { c.push(import.meta.resolve('playwright')); } catch (e) {}
  const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  if (existsSync(cache)) for (const d of readdirSync(cache)) { const p = join(cache, d, 'node_modules', 'playwright', 'index.mjs'); if (existsSync(p)) c.push(pathToFileURL(p).href); }
  for (const x of c) { try { return await import(x); } catch (e) {} }
  return null;
}
const pw = await loadPW();
if (!pw) { console.log('(skip) 未找到 playwright'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-mobile-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
const sp = (a, e) => { const p = spawn('php', a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'ignore' }); procs.push(p); return p; };
process.on('exit', () => { procs.forEach((p) => { try { p.kill(); } catch (e) {} }); rmSync(TMP, { recursive: true, force: true }); });
sp(['-S', `127.0.0.1:${PORT}`, 'router.php'], { DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password, TC_ALLOW_PRIVATE_UPSTREAM: '1' });
sp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/config')).status) break; } catch (e) {} await sleep(250); }
const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) })).json();
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const pv = await (await fetch(BASE + '/api/providers', { method: 'POST', headers: AUTH, body: JSON.stringify({ name: 'MobMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-m', apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true, models: [{ id: 'mock-model', name: 'Mock' }] }) })).json();

const browser = await pw.chromium.launch();
// 长回答:撑满一屏以上,保证一定能滚到底、也保证末尾确实有内容会被压。
const LONG = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行:这是用来把消息撑长的正文,滚动到底后检查它有没有被输入框盖住。`).join('\n\n');

const INJECT_AND_SCROLL = (args) => {
  const [md] = args;
  const host = document.querySelector('.messages') || document.querySelector('#messages');
  if (!host) return { error: 'no .messages' };
  let box = document.getElementById('zz-mob');
  if (!box) { box = document.createElement('div'); box.id = 'zz-mob'; host.appendChild(box); }
  box.innerHTML = '';
  const mk = (cls) => {
    const e = document.createElement('div');
    e.className = 'msg ' + cls;
    e.innerHTML = '<div class="msg-avatar"></div><div class="msg-content"><div class="md-prose"></div></div>'
      + (cls === 'assistant' ? '<div class="msg-actions"><button class="msg-action">复制</button><button class="msg-action">重答</button></div>' : '');
    return e;
  };
  const u = mk('user'), a = mk('assistant');
  box.appendChild(u); box.appendChild(a);
  window.OCRenderer.renderInto(u.querySelector('.md-prose'), '把这段长回答滚动到底,看最后一行会不会被输入框挡住。');
  window.OCRenderer.renderInto(a.querySelector('.md-prose'), md);
  const empty = document.querySelector('.empty-state'); if (empty) empty.style.display = 'none';

  // 滚到底:消息列的滚动容器可能是 .chat-area 本身,也可能是 .messages,
  // 逐层把 scrollTop 推到最大,确保真的到底。
  [document.querySelector('.chat-area'), host, document.scrollingElement].forEach((n) => {
    if (n && n.scrollHeight > n.clientHeight) n.scrollTop = n.scrollHeight;
  });

  const rect = (n) => { const b = n.getBoundingClientRect(); return { t: Math.round(b.top * 10) / 10, b: Math.round(b.bottom * 10) / 10 }; };
  const last = box.lastElementChild;           // 助手消息(含动作行)
  const actions = a.querySelector('.msg-actions');
  const comp = document.querySelector('.composer');
  if (!comp) return { error: 'no .composer' };
  const cr = rect(comp), lr = rect(last), ar = actions ? rect(actions) : null;
  return {
    composerTop: cr.t,
    lastBottom: lr.b,
    actionsBottom: ar ? ar.b : null,
    lastOverlap: Math.round((lr.b - cr.t) * 10) / 10,        // >0 表示被压住
    actionsOverlap: ar ? Math.round((ar.b - cr.t) * 10) / 10 : null,
    composerH: Math.round((cr.b - cr.t) * 10) / 10,
  };
};

let fail = 0;
const VP = [['桌面', { width: 1280, height: 900 }], ['手机390', { width: 390, height: 844 }], ['老机360', { width: 360, height: 740 }]];
for (const [id, label] of [['default', '默认'], ['chatgpt', 'GPT'], ['block', '方块'], ['claude', 'Claude']]) {
  console.log('\n===== ' + label + ' =====');
  for (const [vname, viewport] of VP) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.addInitScript(([t, p, th]) => {
      localStorage.setItem('oc_token', t); localStorage.setItem('oc_provider', p);
      localStorage.setItem('oc_model_' + p, 'mock-model');
      localStorage.setItem('oc_prefs', JSON.stringify({ theme: 'light', themePack: th }));
    }, [login.token, pv.provider.id, id]);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
    await page.waitForFunction(() => (window.OCApp.state.models || []).length > 0, null, { timeout: 20000 });
    if (id !== 'default') await page.waitForFunction((t) => document.documentElement.getAttribute('data-oc-theme') === t, id, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    await page.evaluate(INJECT_AND_SCROLL, [LONG]);
    await sleep(250);
    const r = await page.evaluate(INJECT_AND_SCROLL, [LONG]);   // 再滚一次(第一次注入后高度才确定)
    await sleep(150);
    const r2 = await page.evaluate(() => {
      const box = document.getElementById('zz-mob');
      const comp = document.querySelector('.composer');
      const a = box && box.lastElementChild;
      const actions = a && a.querySelector('.msg-actions');
      if (!box || !comp || !a) return { error: 'MISSING' };
      const b = (n) => { const x = n.getBoundingClientRect(); return { t: x.top, b: x.bottom }; };
      const comp2 = b(comp), msg2 = b(a), act = actions ? b(actions) : null;
      return {
        composerTop: Math.round(comp2.t * 10) / 10,
        lastBottom: Math.round(msg2.b * 10) / 10,
        actionsBottom: act ? Math.round(act.b * 10) / 10 : null,
        lastOverlap: Math.round((msg2.b - comp2.t) * 10) / 10,
        actionsOverlap: act ? Math.round((act.b - comp2.t) * 10) / 10 : null,
        composerH: Math.round((comp2.b - comp2.t) * 10) / 10,
      };
    });
    await ctx.close();
    if (r2.error) { console.log('  ' + vname + ': ERROR ' + r2.error); fail++; continue; }
    const bad = r2.lastOverlap > 0 || (r2.actionsOverlap != null && r2.actionsOverlap > 0);
    const worst = Math.max(r2.lastOverlap, r2.actionsOverlap == null ? -999 : r2.actionsOverlap);
    console.log('  ' + (bad ? '✗' : '✓') + ' ' + vname + ': 输入框顶=' + r2.composerTop + ' 末行底=' + r2.lastBottom
      + ' 动作行底=' + r2.actionsBottom + ' | 重叠 ' + worst + 'px' + (bad ? '  ← 被压住' : '  留白 ' + (-worst) + 'px'));
    if (bad) fail++;
  }
}
await browser.close();
console.log(fail ? '\n共 ' + fail + ' 处被输入框压住' : '\n全部通过:任何宽度下正文都没有被输入框压住');
process.exit(0);
