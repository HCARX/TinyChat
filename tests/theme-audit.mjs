/* 精确对齐/框线审计:node tests/theme-audit.mjs
 * 量的是"肉眼能看出错位/多余线"的那几条:
 *   · 侧栏各行的**文字**左缘(不是容器左缘 —— 容器满宽,量它没有意义)
 *   · 助手正文 / 用户气泡 左右缘 vs 消息列右缘
 *   · 所有可见的 1px 边框(用户要求"拒绝一切有框线的矩形")
 *   · 表格表头 / 代码顶栏上的水平线、引用块左边线
 *   · 最后一条消息底边 vs 悬浮输入框顶边(输入框压住正文就是硬伤)
 *
 * 注入与测量必须放在**同一次 evaluate** 里:应用会因"云端恢复设置"再渲染一遍
 * .messages,先注入、后测量会量到被清空的 DOM(null)。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.AUDIT_PORT || 8321);
const MOCK_PORT = Number(process.env.AUDIT_MOCK_PORT || 8322);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'audit-pass' };
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
if (!pw) { console.log('(skip)'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-audit-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
const sp = (a, e) => { const p = spawn('php', a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'ignore' }); procs.push(p); return p; };
process.on('exit', () => { procs.forEach((p) => { try { p.kill(); } catch (e) {} }); rmSync(TMP, { recursive: true, force: true }); });
sp(['-S', `127.0.0.1:${PORT}`, 'router.php'], { DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password, TC_ALLOW_PRIVATE_UPSTREAM: '1' });
sp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/config')).status) break; } catch (e) {} await sleep(250); }
const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) })).json();
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const pv = await (await fetch(BASE + '/api/providers', { method: 'POST', headers: AUTH, body: JSON.stringify({ name: 'AuditMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-a', apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true, models: [{ id: 'mock-model', name: 'Mock' }] }) })).json();

const browser = await pw.chromium.launch();
const MD = ['## 标题', '', '正文含 `code` 与[链接](#)。', '', '> 引用一行。', '', '```js', 'const a=1;', '```', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');

const MEASURE = (args) => {
  const [md] = args;
  const host = document.querySelector('.messages') || document.querySelector('#messages');
  if (!host) return { error: 'no .messages' };
  let box = document.getElementById('zz-audit');
  if (!box) { box = document.createElement('div'); box.id = 'zz-audit'; host.appendChild(box); }
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
  window.OCRenderer.renderInto(u.querySelector('.md-prose'), '帮我对比一下这几套主题的排版差异。');
  window.OCRenderer.renderInto(a.querySelector('.md-prose'), md);
  const empty = document.querySelector('.empty-state'); if (empty) empty.style.display = 'none';

  const rect = (n) => { const b = n.getBoundingClientRect(); return { x: Math.round(b.x * 10) / 10, r: Math.round(b.right * 10) / 10, b: Math.round(b.bottom * 10) / 10, t: Math.round(b.top * 10) / 10 }; };
  function textLeft(sel) {
    const n = document.querySelector(sel);
    if (!n) return null;
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) { if (t.textContent.trim()) { const rg = document.createRange(); rg.selectNodeContents(t); const b = rg.getBoundingClientRect(); if (b.width > 0) return Math.round(b.x * 10) / 10; } }
    return null;
  }
  const out = { textEdges: {} };
  ['.sidebar-brand', '.new-chat-btn', '.assistant-lib-btn', '.sidebar-model-wrap .model-picker', '.chat-search', '.chat-item'].forEach((s) => { const v = textLeft(s); if (v != null) out.textEdges[s] = v; });

  const ac = a.querySelector('.msg-content'), uc = u.querySelector('.msg-content');
  out.assistant = rect(ac); out.user = rect(uc);
  out.userProse = rect(u.querySelector('.md-prose'));
  out.assistantProse = rect(a.querySelector('.md-prose'));
  out.msgActions = rect(a.querySelector('.msg-actions'));
  out.messages = rect(host);
  out.lastBottom = rect(box).b;
  const comp = document.querySelector('.composer');
  out.composer = comp ? rect(comp) : null;

  const seen = [];
  document.querySelectorAll('body *').forEach((n) => {
    if (n.closest('.hidden') || n.offsetParent === null) return;
    const c = getComputedStyle(n);
    const parts = [];
    ['Top', 'Right', 'Bottom', 'Left'].forEach((k) => {
      const w = parseFloat(c['border' + k + 'Width']) || 0;
      const st = c['border' + k + 'Style'];
      const col = c['border' + k + 'Color'];
      if (w > 0 && st !== 'none' && !/rgba?\(0, 0, 0, 0\)|transparent/.test(col)) parts.push(k[0].toLowerCase() + ':' + w);
    });
    if (parts.length) {
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).slice(0, 3).join('.') : n.tagName.toLowerCase();
      seen.push((cls || n.tagName.toLowerCase()) + '[' + parts.join(',') + ']');
    }
  });
  out.borders = [...new Set(seen)];
  const cs = (sel, prop) => { const n = document.querySelector(sel); return n ? getComputedStyle(n)[prop] : 'MISSING'; };
  out.tableThBorderBottom = cs('#zz-audit .table-wrap th', 'borderBottomWidth') + ' ' + cs('#zz-audit .table-wrap th', 'borderBottomColor');
  out.thSortable = (() => { const n = document.querySelector('#zz-audit th.sortable'); if (!n) return 'MISSING'; const c = getComputedStyle(n, '::after'); return c.content + ' opacity=' + c.opacity; })();
  out.codeHeaderBorderBottom = cs('#zz-audit .code-header', 'borderBottomWidth') + ' ' + cs('#zz-audit .code-header', 'borderBottomColor');
  out.blockquoteBorderLeft = cs('#zz-audit blockquote', 'borderLeftWidth') + ' ' + cs('#zz-audit blockquote', 'borderLeftColor');
  // 「有框线的矩形」审计:把每个可能长成框的元素的计算样式列出来。
  // 只看 border 不够 —— 一圈浅底 + 内边距同样读作「框」,而这正是用户要去掉的东西。
  out.boxed = {};
  const probe = (name, sel) => {
    const n = document.querySelector(sel);
    if (!n) { out.boxed[name] = 'MISSING'; return; }
    const c = getComputedStyle(n);
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((k) => parseFloat(c['border' + k + 'Width']) || 0);
    out.boxed[name] = 'bg=' + c.backgroundColor + ' pad=' + c.padding + ' bw=' + bw.join('/') + ' r=' + c.borderRadius + ' shadow=' + (c.boxShadow === 'none' ? 'no' : 'yes');
  };
  probe('引用块', '#zz-audit blockquote');
  probe('行内代码', '#zz-audit .md-prose p code');
  probe('代码块', '#zz-audit .code-block');
  probe('代码顶栏', '#zz-audit .code-header');
  probe('表格外框', '#zz-audit .table-wrap');
  probe('表头格', '#zz-audit .table-wrap th');
  probe('正文格', '#zz-audit .table-wrap td');
  probe('输入框', '.composer');
  probe('回到底部', '.scroll-bottom-btn');
  return out;
};

for (const [id, label] of [['default', '默认'], ['chatgpt', 'GPT'], ['block', '方块'], ['claude', 'Claude']]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  await sleep(900);
  const r = await page.evaluate(MEASURE, [MD]);
  await ctx.close();
  console.log('\n===== ' + label + ' =====');
  if (r.error) { console.log('  ERROR ' + r.error); continue; }
  const e = Object.entries(r.textEdges);
  if (e.length) {
    const vals = e.map((x) => x[1]);
    const spread = Math.round((Math.max(...vals) - Math.min(...vals)) * 10) / 10;
    console.log('  侧栏文字左缘 ' + e.map((x) => x[0].replace(/^\./, '').replace('.sidebar-model-wrap ', '') + '=' + x[1]).join(' ') + '   极差 ' + spread + (spread > 1 ? '  <- 不齐' : '  ok'));
  }
  const m = r.messages, u = r.user, a = r.assistant, c = r.composer, p = r.userProse;
  console.log('  消息列 x=' + m.x + ' 右=' + m.r);
  console.log('  用户气泡 x=' + u.x + ' 右=' + u.r + '   (右侧留白 ' + (Math.round((m.r - u.r) * 10) / 10) + 'px, 左 ' + (Math.round((u.x - m.x) * 10) / 10) + 'px)');
  console.log('  助手卡片 x=' + a.x + ' 右=' + a.r + '   (左侧留白 ' + (Math.round((a.x - m.x) * 10) / 10) + 'px)');
  console.log('  用户正文左=' + p.x + '  助手正文左=' + r.assistantProse.x);
  if (c) console.log('  输入框 y=' + c.t + '~' + c.b + '(h=' + (Math.round((c.b - c.t) * 10) / 10) + ')   动作行底=' + r.msgActions.b + '   重叠=' + (Math.round((r.msgActions.b - c.t) * 10) / 10) + 'px' + (r.msgActions.b > c.t ? '  <- 输入框压住动作行' : ''));
  console.log('  表头下边线 ' + r.tableThBorderBottom + ' | 代码顶栏下边线 ' + r.codeHeaderBorderBottom);
  console.log('  引用左边线 ' + r.blockquoteBorderLeft + ' | 表头排序箭头 ' + r.thSortable);
  for (const [k, v] of Object.entries(r.boxed)) console.log('    ' + k + ': ' + v);
  console.log('  可见边框 ' + (r.borders.length ? r.borders.join(' ') : '无'));
}
await browser.close();
process.exit(0);
