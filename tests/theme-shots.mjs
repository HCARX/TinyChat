/* 主题视觉出图工具(不参与 CI,纯人工/审阅用):
 *   node tests/theme-shots.mjs            # 出图到 .tmp/shots/
 *   node tests/theme-shots.mjs --only=block,gpt
 *
 * 为什么要这个工具:主题打磨是「看着调」的活 —— 对齐差 2px、分割线漏了一根、
 * 窄屏下气泡挤成窄柱,这些在 CSS 源码里都读不出来,必须真浏览器渲染出来量/看。
 * 这里复用 theme-packs-gui.mjs 的 demo 注入方式:用应用自己的渲染器造消息,
 * DOM 结构与线上一致(主题只管样式,不伪造 DOM)。
 *
 * 出图矩阵:4 套主题 × 浅/深 × 桌面(1280×900)/ 窄屏(390×844)。
 * 另外单独出一张「侧栏对齐」与一张「空态」,这两处是最容易看出瑕疵的地方。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SHOT_PORT || 8301);
const MOCK_PORT = Number(process.env.SHOT_MOCK_PORT || 8302);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'shots-pass' };
const OUT = join(ROOT, '.tmp', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');
const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;

async function loadPlaywright() {
  const candidates = [];
  try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未安装 */ }
  const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache)) {
      const p = join(cache, d, 'node_modules', 'playwright', 'index.mjs');
      if (existsSync(p)) candidates.push(pathToFileURL(p).href);
    }
  }
  for (const c of candidates) { try { return await import(c); } catch (e) { /* 下一个 */ } }
  return null;
}
const pw = await loadPlaywright();
if (!pw) { console.log('(skip) 未找到 playwright'); process.exit(0); }

mkdirSync(OUT, { recursive: true });
const TMP = join(tmpdir(), 'tc-shots-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
const sp = (a, e) => { const p = spawn('php', a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: 'ignore' }); procs.push(p); return p; };
process.on('exit', () => { procs.forEach((p) => { try { p.kill(); } catch (e) {} }); rmSync(TMP, { recursive: true, force: true }); });

sp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_ALLOW_PRIVATE_UPSTREAM: '1',
});
sp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(BASE + '/api/config'); if (r.status) break; } catch (e) {}
  await sleep(250);
}

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 登录失败'); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'ShotMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-shot',
    apiFormat: 'chat', scope: 'global', costPerCall: 0, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 建供应商失败'); process.exit(1); }

const browser = await pw.chromium.launch();

// 一段足够丰富的回答:标题 / 段落 / 列表 / 引用 / 代码 / 表格 / 链接 / 行内代码 ——
// 主题的排版差异几乎全在这些元素上,只截图一段白开水看不出好坏。
const DEMO = [
  '## 主题排版自检',
  '',
  '这是一段正文,用来观察**行高**、段距与字距。里面带一处 `行内代码` 和一个[链接](#)。',
  '',
  '### 列表与层级',
  '',
  '- 第一项:看项目符号与文字的间距',
  '- 第二项:看多行时的悬挂缩进是否对齐',
  '  - 嵌套一项:看是否会被挤成窄柱',
  '',
  '> 引用块是检验「有没有多余的线」最直接的地方。',
  '',
  '```js',
  'function greet(name) {',
  '  return `hello, ${name}`;',
  '}',
  '```',
  '',
  '| 元素 | 关注点 |',
  '| --- | --- |',
  '| 表格 | 表头是否有分割线 |',
  '| 代码 | 顶栏是否抢戏 |',
  '',
  '---',
  '',
  '最后一段:看整块的留白节奏。',
].join('\n');

async function prepPage(viewport, theme, dark) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(([token, prov, th, dk]) => {
    localStorage.setItem('oc_token', token);
    localStorage.setItem('oc_provider', prov);
    localStorage.setItem('oc_model_' + prov, 'mock-model');
    localStorage.setItem('oc_prefs', JSON.stringify({ theme: dk ? 'dark' : 'light', themePack: th }));
  }, [login.token, PROV, theme, dark]);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 });
  await page.waitForFunction(() => (window.OCApp.state.models || []).length > 0, null, { timeout: 20000 });
  // 主题样式表是异步注入的,等它真的挂上再出图,否则会拍到「半默认」的样子
  if (theme !== 'default') {
    await page.waitForFunction((t) => document.documentElement.getAttribute('data-oc-theme') === t, theme, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => !!document.getElementById('oc-theme-pack-css'), null, { timeout: 15000 }).catch(() => {});
  }
  await sleep(700);
  return { ctx, page };
}

async function injectDemo(p) {
  await p.evaluate((md) => {
    const host = document.querySelector('.messages') || document.querySelector('#messages');
    if (!host) return;
    let box = document.getElementById('zz-demo');
    if (!box) { box = document.createElement('div'); box.id = 'zz-demo'; host.appendChild(box); }
    box.innerHTML = '';
    const mk = (cls) => {
      const el = document.createElement('div');
      el.className = 'msg ' + cls;
      el.innerHTML = '<div class="msg-avatar"></div><div class="msg-content"><div class="md-prose"></div></div>'
        + (cls === 'assistant' ? '<div class="msg-actions"><button class="msg-action">复制</button><button class="msg-action">重答</button></div>' : '');
      return el;
    };
    const u = mk('user'), a = mk('assistant');
    box.appendChild(u); box.appendChild(a);
    window.OCRenderer.renderInto(u.querySelector('.md-prose'), '帮我对比一下这几套主题的排版差异,重点看留白、行高和表格。');
    window.OCRenderer.renderInto(a.querySelector('.md-prose'), md);
    const empty = document.querySelector('.empty-state');
    if (empty) empty.style.display = 'none';
  }, DEMO);
}

const themes = [['default', '默认'], ['chatgpt', 'gpt'], ['block', '方块'], ['claude', 'Claude']];
const jobs = [];
for (const [id, label] of themes) {
  if (only && !only.includes(id) && !only.includes(label)) continue;
  for (const dark of [false, true]) {
    jobs.push({ id, label, dark, kind: 'desktop', viewport: { width: 1280, height: 900 } });
    jobs.push({ id, label, dark, kind: 'mobile', viewport: { width: 390, height: 844 } });
  }
}

for (const j of jobs) {
  const { ctx, page } = await prepPage(j.viewport, j.id, j.dark);
  await injectDemo(page);
  await sleep(300);
  const name = `${j.label}-${j.dark ? 'dark' : 'light'}-${j.kind}.png`;
  await page.screenshot({ path: join(OUT, name) });
  console.log('  ✓ ' + name);
  await ctx.close();
}

// 空态单独一张:GPT / Claude 会把九个预设整块隐藏,这里看的是「藏完之后标题落在哪」
for (const [id, label] of themes) {
  if (only && !only.includes(id) && !only.includes(label)) continue;
  const { ctx, page } = await prepPage({ width: 1280, height: 900 }, id, false);
  const name = `${label}-empty.png`;
  await page.screenshot({ path: join(OUT, name) });
  console.log('  ✓ ' + name);
  await ctx.close();
}

console.log('\n出图目录: ' + OUT);
await browser.close();
process.exit(0);
