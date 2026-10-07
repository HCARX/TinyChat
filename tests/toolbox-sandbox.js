/* 在线工具箱沙箱契约自检:
 *   node tests/toolbox-sandbox.js
 *
 * 背景:工具箱里存的是用户自己写的 HTML,服务端**不做任何清洗**(脚本、表单、内联样式
 * 正是这类小工具的正当用法)。于是整个安全模型只剩一条:这份文档必须运行在**不透明源**里。
 * 全项目一共两处把用户 HTML 当可执行文档打开,任何一处漏掉隔离,都等于把 localStorage
 * 里的 oc_token 交给任意一份从别处粘贴进来的 HTML:
 *   1) static/js/toolbox.js 的面板内预览:iframe 走 srcdoc + sandbox 属性;
 *   2) lib/api.php 的 tc_api_toolbox_page():响应头 CSP `sandbox`。
 *
 * 这类「属性里少写一个词、功能照常、只是不再安全」的差异读 diff 极易看漏(那一行还很长),
 * 所以在 CI 里钉成契约。检查的是源码:*.min.js / 响应头文案都由它们生成。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let fail = 0;
const check = (m, c, d) => {
  if (c) console.log('  ✓ ' + m);
  else { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); }
};

// ---------- 1) 前端:预览用的 srcdoc iframe ----------
const js = fs.readFileSync(path.join(root, 'static/js/toolbox.js'), 'utf8');

const m = js.match(/setAttribute\('sandbox',\s*'([^']*)'\)/);
check('能找到预览 iframe 的 sandbox 属性', !!m, '未找到 setAttribute(\'sandbox\', …)');
const raw = m ? m[1] : '';
const tokens = raw.split(/\s+/).filter(Boolean);
console.log('    当前 sandbox = "' + raw + '"');

// 必须不带:这些标志会把不透明源变回同源,或让弹窗/下载逃出沙箱
const forbidden = {
  'allow-same-origin': '会让工具页变回本站同源,直读 localStorage.oc_token',
  'allow-popups-to-escape-sandbox': '弹窗完全脱离沙箱,等于隔离作废',
  'allow-top-navigation': '可把整个本站导航去任意地址(钓鱼)',
  'allow-top-navigation-by-user-activation': '同上,只是需要一次点击',
  'allow-downloads': '与 allow-popups 组合是已知的偷跑下载手法',
  'allow-same-origin-as-credentialed': '非标准,出现即为误写',
};
for (const [flag, why] of Object.entries(forbidden)) {
  check('预览不带 ' + flag + '（' + why + '）', !tokens.includes(flag), '实际带了');
}
for (const flag of ['allow-scripts', 'allow-forms']) {
  check('预览保留 ' + flag, tokens.includes(flag), '缺失会让工具里的交互失效');
}

check('工具 HTML 用 srcdoc **属性赋值**(不拼进 innerHTML)',
  /\.srcdoc\s*=\s*S\.previewHtml/.test(js), '改成 innerHTML 拼接就等于在本站页面里执行用户 HTML');
check('预览 iframe 带 referrerpolicy="no-referrer"',
  /referrerpolicy',\s*'no-referrer'/.test(js), '缺少会让工具页拿到本站地址作为 Referer');

// 工具 HTML 绝不能进 innerHTML:列表里只允许出现转义后的标题/时间
const gridSection = js.slice(js.indexOf('function renderListHtml'), js.indexOf('function onGridClick'));
check('列表渲染不把工具 HTML 拼进 innerHTML',
  gridSection.length > 0 && !/\.html\b/.test(gridSection.replace(/it\.html/g, '')) && !/\bhtml\s*\)/.test(gridSection),
  '列表里出现了未转义的 HTML 数据');
check('列表里的标题经 esc() 转义', /esc\(it\.title/.test(gridSection), '标题未转义');

// ---------- 2) 后端:页面端点的响应头 ----------
const api = fs.readFileSync(path.join(root, 'lib/api.php'), 'utf8');
const at = api.indexOf('function tc_api_toolbox_page');
check('能找到 tc_api_toolbox_page', at > 0);
const body = at > 0 ? api.slice(at, api.indexOf('\n}', at)) : '';

check('页面响应带 CSP sandbox(不透明源)', /Content-Security-Policy:/.test(body) && /;\s*sandbox\s/.test(body),
  '缺少 CSP sandbox,直接打开该地址就是本站源里的可执行网页');
// 只取 CSP 头的**值**再拆词:函数体里那段解释性注释本身也提到 sandbox / allow-same-origin,
// 直接对整个函数做正则会把注释当成配置读(第一版就是这么误报的)。
const cspM = body.match(/header\("(Content-Security-Policy:[^"]*)"\)/);
const csp = cspM ? cspM[1] : '';
const sbM = csp.match(/\bsandbox\b([^;]*)$/);
const sbTokens = sbM ? sbM[1].split(/\s+/).filter(Boolean) : [];
console.log('    CSP sandbox = "' + sbTokens.join(' ') + '"');
check('CSP sandbox 里不带 allow-same-origin', !!sbM && !sbTokens.includes('allow-same-origin'),
  '带了 allow-same-origin,工具就能读 localStorage.oc_token');
check('CSP sandbox 里不带 allow-popups-to-escape-sandbox',
  !!sbM && !sbTokens.includes('allow-popups-to-escape-sandbox'), '弹窗会挣脱沙箱');
check('CSP sandbox 保留 allow-scripts / allow-forms',
  sbTokens.includes('allow-scripts') && sbTokens.includes('allow-forms'),
  '缺失会让工具里的交互失效');
check('页面响应带 X-Frame-Options(覆盖全局 DENY,否则本站 iframe 嵌不了)',
  /X-Frame-Options:\s*SAMEORIGIN/.test(body), '缺少覆盖,tc_send_cors 的全局 DENY 会拦住自己');
check('frame-ancestors 收在 self', /frame-ancestors 'self'/.test(body), '未限制嵌入方');
check('页面响应带 nosniff', /X-Content-Type-Options:\s*nosniff/.test(body), '缺少 nosniff');
check('页面响应 no-store(用户内容不进共享缓存)',
  /Cache-Control:\s*no-store/.test(body), '缺少 no-store');
check('页面按属主判权(签名不等于有权访问)',
  /tc_toolbox_cookie_uid\(/.test(body) && /tc_auth_user\(/.test(body),
  '只验签不判属主,拿到链接的人就能看别人的工具');
check('无权访问时返回 404 而不是 403(不暴露存在性)',
  /http_response_code\(404\)/.test(body), '未用 404');

// ---------- 3) 路由与入口就位 ----------
const index = fs.readFileSync(path.join(root, 'index.php'), 'utf8');
check('注册了 GET /api/sync/toolbox', /#\^\/api\/sync\/toolbox\$#',\s*'tc_api_toolbox_get'/.test(index));
check('注册了 POST /api/sync/toolbox', /'tc_api_toolbox_save'/.test(index));
check('注册了 GET /api/toolbox/page', /'tc_api_toolbox_page'/.test(index));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
check('侧栏入口在「在线浏览器」下方',
  html.indexOf('id="web-entry-btn"') > 0 && html.indexOf('id="toolbox-entry-btn"') > html.indexOf('id="web-entry-btn"'),
  '入口位置不对或缺失');
check('引入了工具箱样式与脚本',
  /toolbox\.min\.css/.test(html) && /toolbox\.min\.js/.test(html), '资源未引入');

console.log(fail === 0 ? '\n工具箱沙箱契约自检通过\n' : '\n失败 ' + fail + ' 项\n');
process.exit(fail === 0 ? 0 : 1);
