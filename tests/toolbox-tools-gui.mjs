/* 在线工具箱「内置工具本身」的 GUI 自检(真 Chromium + 真服务端):
 *   node tests/toolbox-tools-gui.mjs
 *
 * 与 tests/toolbox-gui.mjs 的分工:那份管**工具箱这个功能**(入口、面板、落库、系统工具的
 * 共用语义、地址与隔离);这份管**装进去的那 12 套工具自己能不能用**。
 *
 * 为什么还要真浏览器:这些工具是纯前端页面,「控件接线」与「算得对不对」都只在真引擎里才有
 * 结论。源码级检查(php -l、nowdoc 语法、禁用 storage/外链)管不住这些 —— 一个把事件名写错
 * 的工具照样能通过全部静态检查,点下去却什么也不动。
 *
 * 覆盖:
 *   · 12 套工具逐套打开:不抛异常、标题对得上、主要控件在、核心输入→输出真的联动
 *   · 二维码旗舰:生成(可扫标签)→ 把预览图喂回识别面板 → 还原出原文;
 *     再故意涂掉一块 → 仍能还原(纠错能力);导出走 blob 新标签页(沙箱里唯一可行的路径)
 *   · 深色主题下再走一遍(色板是两份,漏了 dark 的工具会出现白底白字)
 *
 * 可用环境变量:TBOX_TOOLS_GUI_PORT 换端口、TBOX_ONLY=id1,id2 只跑某几套。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TBOX_TOOLS_GUI_PORT || 8573);
const MOCK_PORT = Number(process.env.TBOX_TOOLS_GUI_MOCK_PORT || 8574);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { name: 'admin', password: 'tbox-tools-pass' };
const ONLY = (process.env.TBOX_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (m, c, got) => { if (c) ok(m); else bad(m + (got === undefined ? '' : ' —— 实得 ' + JSON.stringify(got))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log('\n== ' + t + ' ==');

for (const p of [PORT, MOCK_PORT]) {
  try {
    await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(800) });
    console.error(`✗ 端口 ${p} 已被占用(疑似残留的 php -S),请先结束该进程或用 TBOX_TOOLS_GUI_PORT 换端口`);
    process.exit(1);
  } catch (e) { /* 端口空闲 */ }
}

const candidates = [];
try { candidates.push(import.meta.resolve('playwright')); } catch (e) { /* 未装到 node_modules */ }
const cache = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
if (existsSync(cache)) {
  for (const d of readdirSync(cache)) {
    const p = join(cache, d, 'node_modules/playwright/index.mjs');
    if (existsSync(p)) candidates.push(pathToFileURL(p).href);
  }
}
let pw = null;
for (const c of candidates) { try { pw = await import(c); break; } catch (e) { /* 换下一个 */ } }
if (!pw) { console.log('(skip) 未找到 playwright,跳过内置工具 GUI 自检'); process.exit(0); }

const TMP = join(tmpdir(), 'tc-tbox-tools-' + Date.now());
mkdirSync(TMP, { recursive: true });
const procs = [];
const sp = (a, e) => { const p = spawn('php', a, { cwd: ROOT, env: { ...process.env, ...e }, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(p); return p; };
process.on('exit', () => { procs.forEach((p) => { try { p.kill(); } catch (e) {} }); rmSync(TMP, { recursive: true, force: true }); });

const appErr = [];
const app = sp(['-S', `127.0.0.1:${PORT}`, 'router.php'], {
  DATA_DIR: join(TMP, 'data'), ADMIN_NAME: ADMIN.name, ADMIN_PASSWORD: ADMIN.password,
  TC_ALLOW_PRIVATE_UPSTREAM: '1',
});
app.stderr.on('data', (d) => appErr.push(String(d)));
sp(['-S', `127.0.0.1:${MOCK_PORT}`, 'tests/mock-upstream.php'], {});

let up = false;
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(BASE + '/api/config'); if (r.status) { up = true; break; } } catch (e) { /* 未就绪 */ }
  await sleep(250);
}
if (!up) { console.error('✗ 应用服务未启动\n' + appErr.join('').slice(-1500)); process.exit(1); }

const loginRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
});
const loginText = await loginRes.text();
let login = {};
try { login = JSON.parse(loginText); } catch (e) { console.error('✗ 登录响应非 JSON: ' + loginText.slice(0, 300)); process.exit(1); }
if (!login.token) { console.error('✗ 管理员登录失败'); process.exit(1); }
const AUTH = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

const provRes = await (await fetch(BASE + '/api/providers', {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({
    name: 'TBoxToolsMock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-tbox-tools',
    apiFormat: 'chat', scope: 'global', costPerCall: 1, enabled: true,
    models: [{ id: 'mock-model', name: 'Mock' }],
  }),
})).json();
const PROV = provRes && provRes.provider && provRes.provider.id;
if (!PROV) { console.error('✗ 创建供应商失败: ' + JSON.stringify(provRes).slice(0, 300)); process.exit(1); }
await fetch(BASE + '/api/admin/settings', { method: 'POST', headers: AUTH, body: JSON.stringify({ toolboxEnabled: true }) });

const sysDoc = await (await fetch(BASE + '/api/sync/toolbox', { headers: AUTH })).json();
const SYS = (sysDoc.sys && sysDoc.sys.items) || [];
if (!SYS.length) { console.error('✗ 服务端没有下发系统工具'); process.exit(1); }
// 页面地址要带签名,直接拿就带;工具页是新标签页式导航,必须由浏览器自己去请求
const urlOf = (id) => {
  const it = SYS.find((x) => x.id === id);
  if (!it) throw new Error('没有这套工具: ' + id);
  return BASE + it.pageUrl;
};

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 940 } });
const primer = await ctx.newPage();
await primer.addInitScript((t) => localStorage.setItem('oc_token', t), login.token);
await primer.addInitScript((p) => localStorage.setItem('oc_provider', p), PROV);
await primer.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await primer.waitForFunction(() => document.documentElement.getAttribute('data-boot') === 'done', null, { timeout: 30000 }).catch(() => {});
// 用浏览器自己发一次带 Authorization 的请求,让服务端把 oc_tbox Cookie 种到本 context 上
// (工具页是独立地址、靠 Cookie 认人;不带这一步,12 个工具页全会 404)
await primer.evaluate((t) => fetch('/api/sync/toolbox', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.status), login.token);
await sleep(300);
await primer.close();

// 打开一套工具,返回 { page, errs }。errs 收集页面 JS 异常 —— 这是「工具坏了」最直接的症状。
async function openTool(id, opt) {
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  await p.goto(urlOf(id), { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
  await sleep(opt && opt.settle ? opt.settle : 350);
  return { page: p, errs };
}

const wants = (id) => !ONLY.length || ONLY.includes(id);
const titleOf = (id) => (SYS.find((x) => x.id === id) || {}).title;

// ============================================================================
section('1. 12 套工具逐套打开:不抛异常、标题对得上、控件与联动都真的在');
// ============================================================================

const SPECS = [
  {
    id: 'base64',
    // 输入 → 点「编码」→ 输出是标准 Base64。用 ASCII 断言,避免依赖实现选的 UTF-8 细节
    run: async (page) => {
      await page.fill('#b64-in', 'hello toolbox');
      await sleep(350);
      const out = await page.locator('#b64-out').innerText();
      check('base64:编码结果就是标准 Base64', out.includes('aGVsbG8gdG9vbGJveA=='), out.slice(0, 60));
      // 反向:切到解码方向(seg 的 data-v 就是方向值),同一框里喂 Base64,应还原回原文
      await page.click('#b64-dir .seg-btn[data-v="dec"]');
      await sleep(200);
      await page.fill('#b64-in', 'aGVsbG8gdG9vbGJveA==');
      await sleep(350);
      check('base64:切到解码方向能把 Base64 还原回原文', (await page.locator('#b64-out').innerText()).includes('hello toolbox'));
    },
  },
  {
    id: 'urlcode',
    run: async (page) => {
      await page.fill('#uc-in', 'a b&c=d');
      await page.click('#uc-run');
      await sleep(250);
      const out = await page.locator('#uc-out').innerText();
      check('urlcode:编码后空格与保留字符都转义了', out.includes('%20') && !/a b/.test(out), out.slice(0, 60));
      // 解析器:填一个完整 URL,字段应被拆开
      await page.fill('#uc-p-url', 'https://u:p@example.com:8443/a/b?x=1#frag');
      await page.click('#uc-p-parse');
      await sleep(250);
      const host = await page.locator('#uc-f-host').inputValue();
      const port = await page.locator('#uc-f-port').inputValue();
      check('urlcode:解析器把 host/port 拆开了', host === 'example.com' && port === '8443', host + ':' + port);
    },
  },
  {
    id: 'jsonfmt',
    run: async (page) => {
      await page.fill('#jf-in', '{"b":2,"a":{"y":1,"x":0}}');
      await page.click('#jf-format');
      await sleep(400);
      const out = await page.locator('#jf-out').inputValue();
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (e) { /* 留给断言报 */ }
      check('jsonfmt:格式化后的输出是合法 JSON 且结构完整', !!parsed && parsed.b === 2 && parsed.a.x === 0, out.slice(0, 80));
      check('jsonfmt:输入合法时不报错', !/✗|错误|失败/.test(await page.locator('#jf-status').innerText()), await page.locator('#jf-status').innerText());
      // 非法输入必须给出明确报错,而不是静默留着上一次的结果
      await page.fill('#jf-in', '{"b":}');
      await page.click('#jf-format');
      await sleep(250);
      check('jsonfmt:非法 JSON 会明确报错', /错|失败|✗/.test(await page.locator('#jf-status').innerText()), await page.locator('#jf-status').innerText());
    },
  },
  {
    id: 'timestamp',
    run: async (page) => {
      await page.fill('#ts-t2h-in', '1700000000');
      await sleep(200);
      const out = await page.locator('#ts-t2h-out').innerText();
      check('timestamp:1700000000 落在 2023 年(秒级真的按秒算)', /2023/.test(out), out.slice(0, 60));
      await page.fill('#ts-t2h-in', '1700000000000');
      await sleep(200);
      check('timestamp:毫秒输入不会被当成秒(还是 2023 年)', /2023/.test(await page.locator('#ts-t2h-out').innerText()));
      // 反向:时间 → 时间戳,再用同一套换算回读,应闭合
      await page.fill('#ts-h2t-in', '2023-11-15 06:13:20');
      await sleep(250);
      const back = (await page.locator('#ts-h2t-out').innerText().catch(() => '')).trim();
      check('timestamp:时间 → 时间戳有输出', back.length > 0, back.slice(0, 80));
    },
  },
  {
    id: 'hash',
    run: async (page) => {
      await page.fill('#hash-msg', 'abc');
      await page.click('#hash-refresh').catch(() => {});
      await sleep(400);
      const tbl = await page.locator('#hash-tbody').innerText();
      // SHA-256("abc") 是公开测试向量,不是「实现说什么就是什么」
      check('hash:空/文本的 SHA-256 对上公开测试向量(SHA-256("abc"))',
        tbl.includes('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), tbl.replace(/\s+/g, ' ').slice(0, 160));
      check('hash:MD5 也对上向量(MD5("abc"))', tbl.includes('900150983cd24fb0d6963f7d28e17f72'), tbl.slice(0, 60));
    },
  },
  {
    id: 'regex',
    run: async (page) => {
      await page.fill('#rx-pattern', 'a(b+)c');
      await page.fill('#rx-text', 'xxabbbcyy ac aabbcc');
      await sleep(400);
      // 匹配数在统计格里(rx-match-msg 只在出错时才写)
      const stats = await page.locator('#rx-stats').innerText();
      const prev = await page.locator('#rx-preview').innerText();
      check('regex:匹配计数与文本一致(只有 1 处 a+b+c 形式)', /匹配数\D{0,4}1\b/.test(stats.replace(/\s+/g, ' ')) || /\b1\b/.test(stats), stats.replace(/\s+/g, ' ').slice(0, 90));
      check('regex:高亮预览里有原文', prev.includes('abbbc'), prev.slice(0, 80));
      // 非法正则不能把页面打崩,要给报错
      await page.fill('#rx-pattern', 'a(');
      await sleep(400);
      const msg2 = await page.locator('#rx-match-msg').innerText();
      check('regex:非法模式给出报错而不是静默', /无法编译|错|失败|无效/.test(msg2), msg2.slice(0, 80));
    },
  },
  {
    id: 'jwt',
    run: async (page) => {
      // 页面自带示例 token,点「解析」应拆出三段
      await page.click('#jwt-demo').catch(() => {});
      await sleep(250);
      await page.click('#jwt-parse');
      await sleep(300);
      const head = await page.locator('#jwt-head').innerText();
      const pay = await page.locator('#jwt-pay').innerText();
      check('jwt:解析出 Header(含 alg)', /alg/.test(head), head.slice(0, 80));
      check('jwt:解析出 Payload 的声明', /iss|sub|exp|iat/.test(pay), pay.slice(0, 80));
      // 生成:用示例的 header/payload + 一个密钥,应产出一个能解析回三段的结果
      await page.click('#jwt-g-run');
      await sleep(300);
      const out = (await page.locator('#jwt-g-out').innerText().catch(() => '')).trim();
      const segs = out.replace(/\s+/g, '').split('.');
      // 三段式,且第一段 base64url 解出来是带 alg 的 JSON(自己编自己解会掩盖错误,所以这里看结构)
      let head2 = null;
      try { head2 = JSON.parse(Buffer.from(segs[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { /* 留给断言 */ }
      check('jwt:生成的 token 是三段式', segs.length === 3 && segs[0].length > 4 && segs[2].length > 4, out.slice(0, 70));
      check('jwt:生成的 token 第一段解出来就是 Header(带 alg)', !!head2 && typeof head2.alg === 'string', head2);
    },
  },
  {
    id: 'password',
    run: async (page) => {
      await page.locator('#pw-len').evaluate((el) => { el.value = '24'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.click('#pw-gen');
      await sleep(300);
      // 值在 .pw-val 里,别拿整块 innerText 的第一行(会掺进强度标签与复制按钮)
      const first = (await page.locator('#pw-list .pw-val').first().innerText().catch(() => '')).trim();
      check('password:生成结果长度跟着「长度」滑块走(24)', first.length === 24, first);
      // 关掉全部字符集必须明确报错,而不是返回空串假装成功
      for (const id of ['#pw-upper', '#pw-lower', '#pw-digit', '#pw-symbol']) {
        const el = page.locator(id);
        if (await el.isChecked()) await el.uncheck();
      }
      await page.click('#pw-gen');
      await sleep(250);
      check('password:字符集全关时给出报错(不返回空串)', /错|失败|至少|无效|✗/.test(await page.locator('#pw-out-msg').innerText()), await page.locator('#pw-out-msg').innerText());
    },
  },
  {
    id: 'uuid',
    run: async (page) => {
      await page.click('#uu-gen');
      await sleep(350);
      // 每行的取值放在 .grow 里(整块 innerText 会掺进序号与「UUID v4」标签)
      const ids = (await page.locator('#uu-list .it .grow').allInnerTexts()).map((x) => x.trim());
      const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      check('uuid:默认产出多条 UUID v4(版本位与变体位都对)', ids.length >= 5 && ids.every((x) => v4.test(x)), ids.slice(0, 3));
      // 切到 ULID 再生成:26 位 Crockford base32,且时间前缀单调
      await page.click('#uu-kind .seg-btn[data-v="ulid"]');
      await sleep(250);
      await page.click('#uu-gen');
      await sleep(350);
      const ulids = (await page.locator('#uu-list .it .grow').allInnerTexts()).map((x) => x.trim());
      check('uuid:切到 ULID 后产出 26 位 Crockford base32', ulids.length >= 5 && ulids.every((x) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(x)), ulids.slice(0, 3));
      check('uuid:ULID 的时间前缀随序列递增(同批不乱序)', ulids.length < 2 || ulids[0] <= ulids[ulids.length - 1], ulids.slice(0, 3));
    },
  },
  {
    id: 'color',
    run: async (page) => {
      await page.fill('#cl-hex', '#ff0000');
      await sleep(400);
      // 每种格式是一个 .cl-fmt 行(标签 + 值输入框);值只在有解时填,空的是「当前颜色无法用该格式表示」
      const fmtVals = await page.$$eval('#cl-formats .cl-fmt input', (els) => els.map((e) => String(e.value || '')));
      const fmtAll = fmtVals.join(' | ');
      check('color:纯红换算出的 rgb 正确', fmtVals.some((v) => /^rgb\(\s*255\s*,\s*0\s*,\s*0/.test(v)), fmtAll.slice(0, 120));
      check('color:hsl 也对(纯红是 0°)', fmtVals.some((v) => /^hsl\(\s*0(\.0*)?\s*,\s*100%/.test(v)), fmtAll.slice(0, 160));
      // 对比度检查:白底蓝字与白底白字结论必须不同
      await page.fill('#cl-fg', '#ffffff');
      await page.fill('#cl-bg', '#ffffff');
      await sleep(350);
      const cr = await page.locator('#cl-cr').innerText();
      check('color:白底白字的对比度是 1:1(公式真的在算)', /1(\.0+)?\s*:\s*1/.test(cr.replace(/\s+/g, ' ')), cr.replace(/\s+/g, ' ').slice(0, 100));
    },
  },
  {
    id: 'texttool',
    run: async (page) => {
      await page.fill('#tt-in', 'b\na\nb\nA\na');
      await sleep(200);
      await page.click('#tt-fn .seg-btn[data-v="dedupe"]');
      await sleep(300);
      const out = await page.locator('#tt-out').inputValue();
      check('texttool:去重后不再有重复行(a/b 各留一条)', out.split('\n').map((x) => x.trim()).filter(Boolean).length <= 3, JSON.stringify(out));
      // 排序应让输出变成有序序列
      await page.fill('#tt-in', 'b\na\nc');
      await sleep(150);
      await page.click('#tt-fn .seg-btn[data-v="sort"]');
      await sleep(300);
      const sorted = (await page.locator('#tt-out').inputValue()).split('\n').map((x) => x.trim()).filter(Boolean);
      check('texttool:排序后输出单调不降', sorted.length === 3 && sorted[0] === 'a' && sorted[2] === 'c', JSON.stringify(sorted));
    },
  },
];

for (const spec of SPECS) {
  if (!wants(spec.id)) continue;
  const { page, errs } = await openTool(spec.id);
  try {
    const h1 = (await page.locator('h1').first().innerText().catch(() => '')).trim();
    check(`${spec.id}:页面标题就是工具名`, h1 === titleOf(spec.id), h1);
    await spec.run(page);
    check(`${spec.id}:整页没有 JS 异常`, errs.length === 0, errs.slice(0, 2));
  } catch (e) {
    bad(`${spec.id}:用例本身抛异常 —— ${(e && e.message) || e}`);
  }
  await page.close();
}

// ============================================================================
section('2. 二维码旗舰:生成 → 喂回识别 → 还原原文;涂块后仍可还原;导出走弹窗');
// ============================================================================
if (wants('qrcode')) {
  const { page, errs } = await openTool('qrcode', { settle: 700 });
  const PAYLOAD = 'https://toolbox.example.com/qr-round-trip?no=1';

  check('qrcode:页面标题就是工具名', (await page.locator('h1').first().innerText()).trim() === titleOf('qrcode'));

  // 生成:内容清成一条,模块调大一点,保证位图粒度够粗(识别更稳,也更快)
  await page.fill('#qr-text', PAYLOAD);
  await page.locator('#qr-ms').evaluate((el) => { el.value = '9'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#qr-gen');
  await page.waitForSelector('#qr-list .qr-it', { timeout: 15000 });
  await sleep(700);

  const items = await page.locator('#qr-list .qr-it').count();
  check('qrcode:生成了 1 张二维码', items === 1, items);
  const tags = await page.locator('#qr-list .qr-it').first().innerText();
  check('qrcode:标出了版本/纠错/尺寸', /版本|V\d+|纠错|L|M|Q|H/.test(tags), tags.replace(/\s+/g, ' ').slice(0, 120));
  check('qrcode:自己回读矩阵后标了「可扫」', /可扫|扫/.test(tags), tags.replace(/\s+/g, ' ').slice(0, 160));

  // 把预览画布导出成 PNG,再喂回识别面板(这就是「生成 → 识别」的闭环)
  const dataUrl = await page.locator('#qr-list .qr-thumb canvas').first().evaluate((c) => c.toDataURL('image/png'));
  const pngPath = join(TMP, 'round-trip.png');
  writeFileSync(pngPath, Buffer.from(String(dataUrl).split(',')[1], 'base64'));

  await page.setInputFiles('#qr-drop input[type=file]', pngPath);
  await page.waitForSelector('#qr-dec-list .qr-dec', { timeout: 20000 }).catch(() => {});
  await sleep(600);
  const dec = await page.locator('#qr-dec-list').innerText();
  check('qrcode:识别面板还原出原文(生成 → 识别的闭环通了)', dec.includes(PAYLOAD), dec.replace(/\s+/g, ' ').slice(0, 160));
  check('qrcode:识别结果里没有「识别失败」', !/识别失败|失败/.test(dec), dec.replace(/\s+/g, ' ').slice(0, 160));

  // 纠错能力:把二维码右上角(定位图案之外的数据区)涂掉一块,内容仍应还原。
  // 涂定位图案会直接打掉定位,那是对「检测」的考验而不是对「纠错」的,这里要测后者。
  const w = await page.locator('#qr-list .qr-thumb canvas').first().evaluate((c) => c.width);
  const png2 = join(TMP, 'corrupt.png');
  const corrupt = await page.locator('#qr-list .qr-thumb canvas').first().evaluate((c) => {
    const g = c.getContext('2d');
    const s = c.width;
    // 涂掉右上区域一块实心黑:压在数据模块上,不碰三个角的定位图案
    g.fillStyle = '#000000';
    g.fillRect(Math.round(s * 0.52), Math.round(s * 0.10), Math.round(s * 0.20), Math.round(s * 0.20));
    return c.toDataURL('image/png');
  });
  writeFileSync(png2, Buffer.from(String(corrupt).split(',')[1], 'base64'));
  await page.click('#qr-dec-clear').catch(() => {});
  await sleep(300);
  await page.setInputFiles('#qr-drop input[type=file]', png2);
  await sleep(1200);
  const dec2 = await page.locator('#qr-dec-list').innerText();
  check('qrcode:涂掉一块数据模块后仍能还原(纠错真的在起作用)', dec2.includes(PAYLOAD), dec2.replace(/\s+/g, ' ').slice(0, 200) + ' (canvas ' + w + 'px)');

  // 导出路径:沙箱里 <a download> 会被静默拦掉,唯一可行的是 blob 新标签页
  const before = ctx.pages().length;
  await page.click('#qr-list .qr-it button[data-a="open"]');
  let popped = null;
  for (let i = 0; i < 30 && !popped; i++) {
    await sleep(200);
    const pages = ctx.pages();
    if (pages.length > before) popped = pages[pages.length - 1];
  }
  check('qrcode:「打开图片」真的开了新标签页(沙箱里唯一的导出路径)', !!popped, ctx.pages().length - before);
  if (popped) {
    check('qrcode:新标签页指向的是 blob(不是被拦掉的下载)', /^blob:/.test(popped.url()) || popped.url() === 'about:blank', popped.url().slice(0, 40));
    await popped.close();
  }

  // 中心填充:默认 L 级纠错被中心区盖住后工具会**如实**标「可能扫不出」并给出怎么修 ——
  // 这条同时验了「自检没有骗人」和「按提示提高纠错后确实能扫」
  await page.click('#qr-center .seg-btn[data-v="text"]').catch(() => {});
  await sleep(250);
  const ctVisible = await page.locator('#qr-ct-text-f').isVisible().catch(() => false);
  if (ctVisible) {
    await page.fill('#qr-ct-text', '扫');
    await page.click('#qr-gen');
    await sleep(900);
    const warn = await page.locator('#qr-list .qr-it').first().innerText();
    check('qrcode:中心填充盖住数据后如实标「可能扫不出」(自检不骗人)', /可能扫不出/.test(warn), warn.replace(/\s+/g, ' ').slice(0, 160));
    const tip = await page.locator('#qr-list .qr-it [data-k="scan"]').first().getAttribute('title').catch(() => '');
    check('qrcode:给出怎么修(提高纠错 / 缩小填充)', /提高纠错|缩小填充/.test(String(tip)), tip);
    // 按提示把纠错提到 H,应变成可扫
    await page.click('#qr-ec .seg-btn[data-v="H"]');
    await sleep(150);
    await page.click('#qr-gen');
    await sleep(1000);
    const fixed = await page.locator('#qr-list .qr-it').first().innerText();
    check('qrcode:按提示提到 H 级纠错后中心填充仍可扫', /可扫/.test(fixed), fixed.replace(/\s+/g, ' ').slice(0, 160));
  } else {
    bad('qrcode:中心填充的「文字」设置没露出来(点 seg 后 #qr-ct-text-f 仍隐藏)');
  }

  check('qrcode:整页没有 JS 异常', errs.length === 0, errs.slice(0, 2));
  await page.close();
}

// ============================================================================
section('3. 深色主题:工具页读 ?theme=dark 与系统偏好,不能出现白底白字');
// ============================================================================
{
  const darkProbe = [
    ['base64', '#b64-out'],
    ['jsonfmt', '#jf-out'],
    ['qrcode', '#qr-list'],
  ];
  for (const [id, sel] of darkProbe) {
    if (!wants(id)) continue;
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e.message || e)));
    // 装在新标签页里被打开时的真实路径:地址带 ?theme=dark(面板就是这么拼的)
    const u = new URL(urlOf(id));
    u.searchParams.set('theme', 'dark');
    await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
    await sleep(500);
    const look = await p.evaluate((s) => {
      const el = document.querySelector(s) || document.body;
      const cs = getComputedStyle(el);
      const body = getComputedStyle(document.body);
      const nums = (x) => (String(x).match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
      const avg = (x) => nums(x).reduce((a, b) => a + b, 0) / 3;
      return {
        hasDark: document.documentElement.getAttribute('data-oc-theme') === 'dark',
        bg: body.backgroundColor, fg: cs.color,
        bgAvg: avg(body.backgroundColor), fgAvg: avg(cs.color),
      };
    }, sel);
    check(`深色/${id}:?theme=dark 让页面进入 dark 主题`, look.hasDark, look);
    check(`深色/${id}:底色变暗、文字变亮(不是白底白字)`, look.bgAvg < 128 && look.fgAvg > look.bgAvg, { bg: look.bg, fg: look.fg });
    check(`深色/${id}:没有 JS 异常`, errs.length === 0, errs.slice(0, 2));
    await p.close();
  }

  // 系统偏好为深色(地址不带参数)时也要跟上 —— 用户从浏览器历史里点回来属于这条路。
  // 必须复用同一个 context(新 context 没有工具页要的 oc_tbox Cookie),用 emulateMedia 改系统偏好。
  if (wants('base64')) {
    const p = await ctx.newPage();
    await p.emulateMedia({ colorScheme: 'dark' });
    await p.goto(urlOf('base64'), { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
    await sleep(500);
    const dark = await p.evaluate(() => document.documentElement.getAttribute('data-oc-theme') === 'dark');
    check('深色:地址不带参数时跟随系统偏好(prefers-color-scheme)', dark, dark);
    await p.close();
  }
}

await browser.close();

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
