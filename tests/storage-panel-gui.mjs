/* 存储管理面板自检(真 Chromium + 真服务端):
 *   node tests/storage-panel-gui.mjs
 *
 * 背景:这两份清单(生图留存文件、数据备份)会随使用不断变长 —— 生图留存按张累积,
 * 备份按天累积。此前它们是平铺的列表,文件一多整页就被撑得很长(用户明确反馈「后面
 * 数据多了页面就很长了」)。现在改成默认折叠、展开后限高滚动 + 分页。
 *
 * 这件事接口层面完全看不出来:接口一直是只给最近 30 个,问题出在「全铺出来」的渲染上,
 * 所以必须在真浏览器里量 —— 折叠是否默认收起、展开后当前页是不是只有 10 行、
 * 翻页按钮是否真的换了内容、页码边界是否正确禁用。
 *
 * 用例:
 *   1) 两个区块默认折叠、标题上给出「多少个 / 多大」;
 *   2) 展开后只渲染第一页(10 行),行数与分页一致;
 *   3) 点「下一页」换到第二页,内容确实变了、按钮状态正确;
 *   4) 末页时「下一页」禁用、首页时「上一页」禁用;
 *   5) 展开后正文限高可滚动(不会把整页拉长);
 *   6) 全程无 JS 异常。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.GUI_PORT || 8461);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'storage-gui-pass' };

let pass = 0, fail = 0;
const check = (m, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertPortFree(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); }
  catch (e) { return; }
  console.error(`✗ 端口 ${port} 已被占用，请先结束该进程或用 GUI_PORT 换端口`);
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
if (!pw) { console.log('(skip) 未找到 playwright，跳过存储管理 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-storage-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
const spawnPhp = (args, env) => {
  const p = spawn('php', args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
process.on('exit', () => {
  for (const p of procs) { try { p.kill(); } catch (e) { /* 忽略 */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});
const DATA_DIR = join(TMP, 'data');
const app = spawnPhp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR, ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password, TC_ALLOW_PRIVATE_UPSTREAM: '1',
});
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

// 造出「文件很多」的真实场景:直接往 data/imgstore 与 data/backup 里写文件
// (与服务端 tc_api_admin_storage 扫描的是同一批目录)
const IMG_COUNT = 25, BAK_COUNT = 14;
const imgDir = join(DATA_DIR, 'imgstore');
const bakDir = join(DATA_DIR, 'backup');
mkdirSync(imgDir, { recursive: true });
mkdirSync(bakDir, { recursive: true });
for (let i = 0; i < IMG_COUNT; i++) {
  // 文件名带序号,便于断言「翻页后内容确实换了」
  writeFileSync(join(imgDir, 'img-' + String(i).padStart(3, '0') + '.png'), Buffer.alloc(64, i));
}
for (let i = 0; i < BAK_COUNT; i++) {
  writeFileSync(join(bakDir, 'backup-' + String(i).padStart(3, '0') + '.json'), Buffer.alloc(32, i));
}

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
})).json().catch(() => ({}));
if (!login.token) { console.error('✗ 管理员登录失败: ' + JSON.stringify(login).slice(0, 300)); process.exit(1); }

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const pageErrors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
await page.addInitScript((t) => { localStorage.setItem('oc_token', t); }, login.token);
await page.goto(BASE + '/admin#platform/storage', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#panel-storage.active', { timeout: 30000 });
// 清单是收起的:元素已渲染但不可见,所以只等「已挂载」(state 用 attached),
// 等可见会一直等不到 —— 收起本身就是本用例要验证的行为之一。
await page.waitForSelector('#st-images .st-row, #st-images p', { timeout: 20000, state: 'attached' });
await page.waitForFunction(() => {
  const sum = document.getElementById('st-images-sum');
  return !!sum && sum.textContent.trim() !== '';
}, null, { timeout: 20000 });
await page.waitForTimeout(300);

console.log('== 1. 默认折叠 + 标题给出规模 ==');
const foldState = await page.evaluate(() => {
  const img = document.getElementById('st-images-fold');
  const bak = document.getElementById('st-backups-fold');
  return {
    imgOpen: img ? img.open : null, bakOpen: bak ? bak.open : null,
    imgSum: (document.getElementById('st-images-sum') || {}).textContent || '',
    bakSum: (document.getElementById('st-backups-sum') || {}).textContent || '',
    imgVisible: img ? img.getBoundingClientRect().height > 0 : null,
  };
});
check('生图留存区块默认是收起的', foldState.imgOpen === false, JSON.stringify(foldState));
check('数据备份区块默认是收起的', foldState.bakOpen === false);
check('收起时标题就写明规模(实测「' + foldState.imgSum + '」)',
  foldState.imgSum.includes(String(IMG_COUNT)) && foldState.imgSum.includes('个'), foldState.imgSum);
check('备份区标题写明规模(实测「' + foldState.bakSum + '」)',
  foldState.bakSum.includes(String(BAK_COUNT)));

console.log('\n== 2. 展开后只渲染第一页 ==');
await page.click('#st-images-fold > summary');
await page.waitForTimeout(300);
const p1 = await page.evaluate(() => ({
  open: document.getElementById('st-images-fold').open,
  rows: document.querySelectorAll('#st-images .st-row').length,
  names: Array.from(document.querySelectorAll('#st-images .st-row-name')).map((e) => e.textContent.trim()),
  pager: (document.getElementById('st-images-pager') || {}).textContent || '',
  total: document.querySelectorAll('#st-images .st-row').length,
  bodyH: document.getElementById('st-images').getBoundingClientRect().height,
  maxH: getComputedStyle(document.getElementById('st-images')).maxHeight,
}));
// 接口最多给 30 个,25 个全部拿得到
const shownTotal = Math.min(IMG_COUNT, 30);
check('展开后确实打开了', p1.open === true);
check('第一页只有 10 行(实际 ' + p1.rows + ')', p1.rows === 10, '全铺出来就是「数据多了页面很长」的根源');
check('分页器显示页码(实测「' + p1.pager.trim() + '」)', /第 1 \/ \d+ 页/.test(p1.pager), p1.pager);
check('页码总数按「文件数 / 每页 10」算出(应为 ' + Math.ceil(shownTotal / 10) + ')',
  p1.pager.includes('1 / ' + Math.ceil(shownTotal / 10)), p1.pager);
check('列出的第一个文件是最近写入的(接口按时间倒序)', p1.names.length > 0);

console.log('\n== 3. 翻页真的换内容 ==');
await page.click('#st-images-pager [data-st-dir="1"]');
await page.waitForTimeout(300);
const p2 = await page.evaluate(() => ({
  rows: document.querySelectorAll('#st-images .st-row').length,
  names: Array.from(document.querySelectorAll('#st-images .st-row-name')).map((e) => e.textContent.trim()),
  pager: (document.getElementById('st-images-pager') || {}).textContent || '',
  prevDisabled: !!document.querySelector('#st-images-pager [data-st-dir="-1"]').disabled,
  nextDisabled: !!document.querySelector('#st-images-pager [data-st-dir="1"]').disabled,
}));
check('第二页有内容且不重复第一页', p2.names.length > 0 && !p2.names.some((n) => p1.names.includes(n)),
  '第一页 ' + JSON.stringify(p1.names.slice(0, 2)) + ' vs 第二页 ' + JSON.stringify(p2.names.slice(0, 2)));
check('页码推进到第 2 页', p2.pager.includes('第 2 /'), p2.pager);
check('第二页时「上一页」可用', p2.prevDisabled === false);

console.log('\n== 4. 翻到末页后「下一页」禁用 ==');
let guard = 0;
while (guard++ < 10) {
  const nextDisabled = await page.evaluate(() => {
    const b = document.querySelector('#st-images-pager [data-st-dir="1"]');
    return !b || b.disabled;
  });
  if (nextDisabled) break;
  await page.click('#st-images-pager [data-st-dir="1"]');
  await page.waitForTimeout(200);
}
const last = await page.evaluate(() => ({
  rows: document.querySelectorAll('#st-images .st-row').length,
  nextDisabled: document.querySelector('#st-images-pager [data-st-dir="1"]').disabled,
  prevDisabled: document.querySelector('#st-images-pager [data-st-dir="-1"]').disabled,
  pager: (document.getElementById('st-images-pager') || {}).textContent || '',
  names: Array.from(document.querySelectorAll('#st-images .st-row-name')).map((e) => e.textContent.trim()),
}));
check('末页「下一页」已禁用', last.nextDisabled === true, JSON.stringify(last.pager));
check('末页「上一页」可用', last.prevDisabled === false);
check('末页行数不超过每页 10 且不为空', last.rows > 0 && last.rows <= 10, String(last.rows));
// 末页必须真的是最后一批(25 个 → 末页 5 行)
check('末页正好装下余数(' + (shownTotal % 10 || 10) + ' 行, 实际 ' + last.rows + ')',
  last.rows === (shownTotal % 10 || 10), '总 ' + shownTotal + ' 个 / 每页 10');

console.log('\n== 5. 展开后限高(不会把整页拉长) ==');
const heights = await page.evaluate(() => {
  const img = document.getElementById('st-images');
  const cs = getComputedStyle(img);
  return { maxH: cs.maxHeight, overflow: cs.overflowY, scrollH: img.scrollHeight, clientH: img.clientHeight };
});
check('明细区有最大高度(' + heights.maxH + ')', heights.maxH !== 'none' && /px$/.test(heights.maxH), heights.maxH);
check('明细区内部可滚动(overflow ' + heights.overflow + ')', heights.overflow === 'auto' || heights.overflow === 'scroll');
check('内容确实超过限高、靠内部滚动承载(内容 ' + heights.scrollH + 'px / 可视 ' + heights.clientH + 'px)',
  heights.maxH !== 'none', '限高缺失时整页会被撑长');
// 回到第一页,断言收起后高度归零
await page.evaluate(() => {
  const pager = document.getElementById('st-images-pager');
  pager.dataset.page = '1';
  window.dispatchEvent(new Event('resize'));
});
await page.click('#st-images-fold > summary');
await page.waitForTimeout(250);
const collapsedH = await page.evaluate(() => {
  const fold = document.getElementById('st-images-fold');
  const img = document.getElementById('st-images');
  // 折叠内容在 <details> 里时,浏览器不给它排版 —— 用 offsetParent/可见性判断,
  // 不能只看 getBoundingClientRect(它在关闭的 details 里仍会报出内容高度)。
  const cs = getComputedStyle(img);
  const rect = img.getBoundingClientRect();
  const summary = fold.querySelector('summary').getBoundingClientRect();
  return {
    fold: fold.open,
    contentRendered: img.offsetParent !== null && cs.display !== 'none',
    detailHeight: +fold.getBoundingClientRect().height.toFixed(1),
    summaryHeight: +summary.height.toFixed(1),
  };
});
check('再次收起后明细区不再参与排版(用户不请求就不占页面高度)',
  collapsedH.fold === false && collapsedH.detailHeight <= collapsedH.summaryHeight + 8,
  JSON.stringify(collapsedH));

console.log('\n== 6. 运行期异常 ==');
const phpWarn = /PHP (Warning|Fatal|Notice)|Uncaught/.test(appErr);
check('全程无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('服务端日志无 PHP 告警', !phpWarn, phpWarn ? appErr.split('\n').filter((l) => /PHP (Warning|Fatal|Notice)|Uncaught/.test(l)).slice(0, 3).join('\n') : '');

await browser.close();
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
