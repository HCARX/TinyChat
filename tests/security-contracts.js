/* 安全修复的源码契约自检:
 *   node tests/security-contracts.js
 *
 * 背景:这一轮安全审计修掉的问题,几乎都属于「少写一个词、功能照常、只是不再安全」的类型 ——
 * 少一次协议白名单判断,javascript: 就能执行;postMessage 少一次来源判断,
 * 任意站点就能驱动被代理页面;少一个 nosniff / CSP sandbox,
 * 上游给的 image/svg+xml 就能在本站源内联跑脚本、读走 localStorage 里的令牌。
 * 这些差异读 diff 极容易看漏,所以在 CI 里钉成契约:任何一项不合规即失败。
 *
 * 覆盖(源码级,不看运行时):
 *   1) 前端四处 safeUrl 的行为(把函数抽出来真跑一遍),以及调用点确实用了它;
 *   2) web-shim 收消息先校验来源是 parent;
 *   3) 代理媒体输出策略:type 收紧 + nosniff + SVG CSP sandbox,且**所有**出图/出视频
 *      响应路径都走同一个函数(漏改一条路就等于没改);
 *   4) 反 DNS rebinding 的 CURLOPT_RESOLVE 覆盖到各条抓取路径;
 *   5) 演示管理员不得触碰快照之外的字段(兑换码);
 *   6) 登录失败路径对「用户不存在」也要走一次口令校验(消除用户名枚举的时序差);
 *   7) localStorage 反序列化的原型污染防护;
 *   8) 自定义字体的 CSS 注入清洗。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); };
const check = (m, c, d) => { if (c) ok(m); else bad(m, d); };
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 从源码里按大括号配对抽出一个具名函数,便于直接执行验证行为
function grabFn(src, name) {
  const head = 'function ' + name + '(';
  const at = src.indexOf(head);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}
const evalFn = (text) => eval('(' + text + ')');

// ---------------------------------------------------------------- 1) safeUrl
console.log('\n[1] href/src 协议白名单 safeUrl');
const BAD_URLS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  '  javascript:alert(1)  ',
  'vbscript:msgbox(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml;base64,AAA',
  '#fragment',
  'mailto:a@b.c',
  'ftp://x/y',
  '',
];
const GOOD_URLS = ['https://example.com/a.png', 'http://127.0.0.1:8080/a', '/api/proxy/image?u=x'];
['static/js/app.js', 'static/js/notes.js', 'static/js/citations.js', 'static/js/im.js'].forEach((p) => {
  const src = read(p);
  const text = grabFn(src, 'safeUrl');
  if (!text) { bad(p + ' 里找得到 safeUrl'); return; }
  let fn;
  try { fn = evalFn(text); } catch (e) { bad(p + ' 的 safeUrl 可执行', String(e)); return; }
  let bad1 = null;
  BAD_URLS.forEach((u) => { if (fn(u) !== '') bad1 = u; });
  let bad2 = null;
  GOOD_URLS.forEach((u) => { if (fn(u) !== u.trim()) bad2 = u; });
  if (bad1 === null && bad2 === null) ok(p.split('/').pop() + ': 拦危险协议、放行 http(s) 与站内相对路径');
  else if (bad1 !== null) bad(p.split('/').pop() + ': 未拦截 ' + JSON.stringify(bad1));
  else bad(p.split('/').pop() + ': 误拦 ' + JSON.stringify(bad2));
});

// 调用点:抽出来却没用等于没修
const appSrc = read('static/js/app.js');
check('app.js:购买链接经 safeUrl 过滤', /const\s+buy\s*=\s*safeUrl\(/.test(appSrc));
check('app.js:外链带 rel=noopener', /noopener/.test(appSrc));
const notesSrc = read('static/js/notes.js');
check('notes.js:附件链接经 safeUrl 过滤', /safeUrl\(/.test(notesSrc) && /renderAttachment|attachment/i.test(notesSrc));
const imSrc = read('static/js/im.js');
check('im.js:文件卡片链接经 safeUrl 过滤', /function renderFilePart/.test(imSrc) && /safeUrl\(/.test(imSrc));
const citSrc = read('static/js/citations.js');
check('citations.js:非 http(s) 来源降级为静态行', /cite-source-static/.test(citSrc) && /safeUrl\(/.test(citSrc));

// ------------------------------------------------------- 2) postMessage 来源
console.log('\n[2] 被代理页面 postMessage 来源校验');
const shim = read('static/js/web-shim.js');
{
  // 取出 message 事件处理体,要求第一句就是来源判断
  const at = shim.indexOf("addEventListener('message'");
  const body = at < 0 ? '' : shim.slice(at, at + 400);
  check('web-shim.js:只接受来自 parent 的消息',
    /addEventListener\('message'[\s\S]{0,200}?ev\.source\s*!==\s*window\.parent/.test(shim),
    at < 0 ? '找不到 message 监听' : body.split('\n')[1]);
}

// ------------------------------------------- 3) 代理媒体输出策略(单一实现)
console.log('\n[3] 代理图片/视频的响应头策略');
const proxy = read('lib/proxy.php');
check('存在统一的 tc_proxy_media_headers', /function tc_proxy_media_headers\(/.test(proxy));
check('tc_proxy_media_ctype 收紧到给定族并回落默认类型', /function tc_proxy_media_ctype\(\$ctype, \$families, \$fallback\)/.test(proxy));
{
  const text = grabFn(proxy, 'tc_proxy_media_headers') || '';
  check('统一加 X-Content-Type-Options: nosniff', /X-Content-Type-Options: nosniff/.test(text));
  check('SVG 套 CSP sandbox 断脚本', /image\/svg\+xml/.test(text) && /Content-Security-Policy/.test(text) && /sandbox/.test(text));
  check('CSP 只对 SVG 生效(不误伤普通图片)', /if\s*\(\s*\$ctype\s*===\s*'image\/svg\+xml'\s*\)/.test(text));
}
// 关键:不允许再有绕过统一函数的媒体响应头(统一函数自身那一处除外)
const helperText = grabFn(proxy, 'tc_proxy_media_headers') || '';
const proxyOutside = proxy.split(helperText).join('');
const rawMediaCtype = proxyOutside.match(/header\('Content-Type: ' \. \$ctype\)/g) || [];
check('没有绕过统一函数的媒体 Content-Type 输出', rawMediaCtype.length === 0,
  '仍有 ' + rawMediaCtype.length + " 处 header('Content-Type: ' . \$ctype)");
// 三条出图路径(本地留存 / 按需缓存 / 首次拉取)与视频路径都必须走统一函数
// (在去掉函数定义自身的文本上计数,避免把「定义」当成一次调用)
const helperCalls = (proxyOutside.match(/tc_proxy_media_headers\(/g) || []).length;
check('四条媒体响应路径都走统一函数(含首次拉取)', helperCalls >= 4, '实际 ' + helperCalls + ' 处');
check('图片代理首次拉取也走统一函数',
  /tc_proxy_media_ctype\(\$ctype, array\('image'\), 'image\/png'\)[\s\S]{0,200}?tc_proxy_media_headers\(/.test(proxy));
check('视频代理按 video/audio 白名单收紧类型',
  /tc_proxy_media_ctype\([\s\S]{0,120}?array\('video', 'audio'\), 'video\/mp4'\)/.test(proxy));

// --------------------------------------- 4) 反 DNS rebinding 的解析固定
console.log('\n[4] 反 DNS rebinding:string pin 覆盖各抓取路径');
const pins = (proxy.match(/CURLOPT_RESOLVE/g) || []).length;
check('CURLOPT_RESOLVE 至少覆盖三条抓取路径', pins >= 3, '实际 ' + pins + ' 处');
check('图片代理做了解析固定', /tc_public_resolve_pin\(\$url\)[\s\S]{0,200}?CURLOPT_RESOLVE/.test(proxy));

// ------------------------------------------- 5) 演示管理员字段白名单
console.log('\n[5] 演示号不得创建兑换码');
const api = read('lib/api.php');
const fnBody = (name) => { const t = grabFn(api, name); return t || ''; };
{
  const a = fnBody('tc_api_admin_generate_codes');
  const b = fnBody('tc_api_admin_create_fixed_code');
  check('批量生成兑换码前有 demo 拦截', /tc_demo_guard\(/.test(a));
  check('创建固定兑换码前有 demo 拦截', /tc_demo_guard\(/.test(b));
}

// --------------------------------------- 6) 登录失败时序(用户名枚举)
console.log('\n[6] 登录失败不泄露用户名是否存在');
{
  const text = grabFn(api, 'tc_api_login') || '';
  const at = text.indexOf('tc-enumeration-pad');
  check('用户不存在时也做一次口令校验(时序对齐)', at >= 0);
  check('用户不存在与密码错返回同一提示', /用户名或密码错误/.test(text));
}

// ------------------------------------------- 7) 反原型污染
console.log('\n[7] localStorage 反序列化的原型污染防护');
[['static/js/ui.js', 'loadPrefs'], ['static/js/groupui.js', 'hydrateGroup'], ['static/js/notes.js', 'loadUi']].forEach(([p, fn]) => {
  const src = read(p);
  const text = grabFn(src, fn) || '';
  check(p.split('/').pop() + ':' + fn + ' 跳过 __proto__',
    /__proto__/.test(text) && /constructor/.test(text));
});

// ------------------------------------------- 8) 自定义字体 CSS 清洗
console.log('\n[8] 自定义字体不引入可执行 CSS');
{
  const text = grabFn(read('static/js/ui.js'), 'applyCustomFonts') || '';
  check('剥掉 @import', /@import/.test(text));
  check('剥掉 url() / expression()', /url\\s\*\\\(|expression/.test(text));
}

console.log('\n' + (fail ? '✗ 安全契约自检失败: ' + fail + ' 项' : '✓ 安全契约自检通过') + '\n');
process.exit(fail ? 1 : 0);
