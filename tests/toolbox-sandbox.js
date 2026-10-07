/* 在线工具箱沙箱契约自检:
 *   node tests/toolbox-sandbox.js
 *
 * 背景:工具箱里存的是用户自己写的 HTML —— 用户自存的那份与后台维护的系统工具都是。
 * 服务端**不做任何清洗**(脚本、表单、内联样式正是这类小工具的正当用法)。于是整个安全
 * 模型只剩一条:这份文档必须运行在**不透明源**里。全项目一共两处把用户 HTML 当可执行
 * 文档打开,任何一处漏掉隔离,都等于把 localStorage 里的 oc_token 交给任意一份从别处
 * 粘贴进来的 HTML:
 *   1) static/js/toolbox.js 的面板内预览:iframe 走 srcdoc + sandbox 属性;
 *   2) lib/api.php 的 tc_toolbox_serve_html():响应头 CSP `sandbox`(两条路共用它)。
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

// 工具 HTML 绝不能进 innerHTML:列表里只允许出现转义后的标题/时间。
// 系统工具与用户工具共用同一个 cardHtml(),所以这一条同时覆盖两类卡片。
const listSection = js.slice(js.indexOf('function cardHtml'), js.indexOf('function onGridClick'));
check('找到列表渲染区', listSection.length > 0, 'cardHtml() 之后的结构变了,请更新本自检');
check('列表渲染不把工具 HTML 拼进 innerHTML',
  !/it\.html/.test(listSection.replace(/String\(it\.html \|\| ''\)/g, '')),
  '列表里出现了未转义的 HTML 数据(内容只能用于算体积,不能拼进 DOM)');
check('列表里的标题经 esc() 转义', /esc\(it\.title/.test(listSection), '标题未转义');
check('系统工具卡片与用户卡片同源渲染(esc 一视同仁)', /cardHtml\(it, 'sys'\)/.test(js), '两类卡片走了不同渲染路径');

// ---------- 2) 后端:页面端点的响应头 ----------
// 隔离头集中在 tc_toolbox_serve_html() 一处,用户自存与系统工具两条路都调它。
// 判据取函数体:注释里也提到 sandbox / allow-same-origin,只对 CSP 头的**值**拆词。
const api = fs.readFileSync(path.join(root, 'lib/api.php'), 'utf8');
const fnBody = (name) => {
  const at = api.indexOf('function ' + name);
  if (at <= 0) return '';
  const end = api.indexOf('\n}', at);
  return end > 0 ? api.slice(at, end) : '';
};
const serve = fnBody('tc_toolbox_serve_html');
check('能找到 tc_toolbox_serve_html(隔离头的唯一来源)', !!serve);
check('页面响应带 CSP sandbox(不透明源)', /Content-Security-Policy:/.test(serve) && /;\s*sandbox\s/.test(serve),
  '缺少 CSP sandbox,直接打开该地址就是本站源里的可执行网页');
const cspM = serve.match(/header\("(Content-Security-Policy:[^"]*)"\)/);
const csp = cspM ? cspM[1] : '';
const sbM = csp.match(/\bsandbox\b([^;]*)$/);
const sbTokens = sbM ? sbM[1].split(/\s+/).filter(Boolean) : [];
console.log('    CSP sandbox = "' + sbTokens.join(' ') + '"');
check('CSP sandbox 里不带 allow-same-origin', !!sbM && !sbTokens.includes('allow-same-origin'),
  '带了 allow-same-origin,工具就能读 localStorage.oc_token');
check('CSP sandbox 里不带 allow-popups-to-escape-sandbox',
  !!sbM && !sbTokens.includes('allow-popups-to-escape-sandbox'), '弹窗会挣脱沙箱');
check('CSP sandbox 里不带 allow-top-navigation', !!sbM && !sbTokens.includes('allow-top-navigation'),
  '可把整个本站导航走(钓鱼)');
check('CSP sandbox 保留 allow-scripts / allow-forms',
  sbTokens.includes('allow-scripts') && sbTokens.includes('allow-forms'),
  '缺失会让工具里的交互失效');
check('页面响应带 X-Frame-Options(覆盖全局 DENY,否则本站 iframe 嵌不了)',
  /X-Frame-Options:\s*SAMEORIGIN/.test(serve), '缺少覆盖,tc_send_cors 的全局 DENY 会拦住自己');
check('frame-ancestors 收在 self', /frame-ancestors 'self'/.test(serve), '未限制嵌入方');
check('页面响应带 nosniff', /X-Content-Type-Options:\s*nosniff/.test(serve), '缺少 nosniff');
check('页面响应 no-store(用户内容不进共享缓存)',
  /Cache-Control:\s*no-store/.test(serve), '缺少 no-store');

const page = fnBody('tc_api_toolbox_page');
check('页面端点走共用的隔离头函数(不许自己再拼一套响应头)',
  /tc_toolbox_serve_html\(\$html\)/.test(page), '页面端点没有走 tc_toolbox_serve_html');
check('页面响应头只在共用函数里出现一次',
  (api.match(/sandbox allow-scripts/g) || []).length === 1,
  'CSP sandbox 文案重复出现,两条路会各自漂移');
check('页面按属主判权(签名不等于有权访问)',
  /tc_toolbox_cookie_uid\(/.test(page) && /tc_auth_user\(/.test(page),
  '只验签不判属主,拿到链接的人就能看别人的工具');
check('用户工具的归属判定是自己的 id', /tc_toolbox_of\(\$db, \(string\) \$me\['id'\]\)/.test(page), '未按属主取工具');
check('系统工具分支也要过功能开关',
  /tc_feature_allowed\(\$db, \$me, 'toolbox'\)/.test(page), '关掉工具箱后签名地址仍能跑系统工具');
check('无权访问时返回 404 而不是 403(不暴露存在性)',
  /http_response_code\(404\)/.test(page), '未用 404');
check('系统工具用独立签名命名空间(不能与用户工具互相顶替)',
  /'toolbox:sys:'/.test(api), '两套工具共用一个命名空间');

// 内置工具与用户工具一样跑在沙箱里,所以模板本身不能依赖沙箱里拿不到的东西。
// 先剥掉注释行:文件顶部那段说明正是在讲「不得依赖 localStorage」,拿全文判会被自己绊倒。
const defs = fs.readFileSync(path.join(root, 'lib/toolbox-default.php'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
check('内置工具不碰 localStorage(沙箱里会直接抛错)',
  !/localStorage|document\.cookie/.test(defs), '内置工具依赖了沙箱里不可用的存储');
check('内置工具不引外部资源(断网/内网也要能打开)',
  !/(src|href)\s*=\s*["']https?:\/\//i.test(defs), '内置工具引了外部资源');

// ---------- 3) 路由与入口就位 ----------
const index = fs.readFileSync(path.join(root, 'index.php'), 'utf8');
check('注册了 GET /api/sync/toolbox', /#\^\/api\/sync\/toolbox\$#',\s*'tc_api_toolbox_get'/.test(index));
check('注册了 POST /api/sync/toolbox', /'tc_api_toolbox_save'/.test(index));
check('注册了 GET /api/toolbox/page', /'tc_api_toolbox_page'/.test(index));
check('注册了后台系统工具箱读接口', /'tc_api_admin_toolbox_get'/.test(index));
check('注册了后台系统工具箱写接口', /'tc_api_admin_toolbox_save'/.test(index));
check('工具箱有自己的地址 /toolbox', /'\/toolbox' => 'index\.html'/.test(index), '未给 /toolbox 独立地址');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
check('侧栏入口在「在线浏览器」下方',
  html.indexOf('id="web-entry-btn"') > 0 && html.indexOf('id="toolbox-entry-btn"') > html.indexOf('id="web-entry-btn"'),
  '入口位置不对或缺失');
check('引入了工具箱样式与脚本',
  /toolbox\.min\.css/.test(html) && /toolbox\.min\.js/.test(html), '资源未引入');

// 自有地址 / 刷新后仍停在这一页:与笔记 / 在线聊天同一套约定
check('前端认领 /toolbox 路径', /location\.pathname\.replace\(\/\\\/\+\$\/, ''\) === '\/toolbox'/.test(js),
  '缺少 isToolboxPath(),刷新后会掉回对话页');
check('进入时 pushState 到 /toolbox', /pushState\(\{\s*toolbox: true\s*\},\s*'',\s*'\/toolbox'\)/.test(js));
check('关闭时地址回根路径', /pushState\(null,\s*'',\s*'\/'\)/.test(js));
check('监听 popstate 保持地址与界面一致', /addEventListener\('popstate'/.test(js));
check('左上角有品牌 logo 与返回按钮', /id="tb-brand"/.test(js) && /tb-back-btn/.test(js),
  '自有地址下用户找不到回对话页的出口');
check('品牌用站内深浅两套 logo', /brand-logo-light/.test(js) && /brand-logo-dark/.test(js));
check('返回按钮与品牌都接 close',
  /querySelector\('#tb-brand'\)\.addEventListener\('click', close\)/.test(js)
  && /querySelector\('\[data-act="close"\]'\)\.addEventListener\('click', close\)/.test(js),
  '左上角的两个出口没接到 close()');

// Esc 有三层归属:面板挂在 OCUI 的 modal 栈上,而「关掉栈顶」的监听注册得比本模块早。
// 少了捕获阶段这一步,内层视图的 Esc 会被栈顶先关掉整个面板,模块自己还以为开着 ——
// 表现为「Esc 之后再也打不开,只能刷新」。这几条把这个契约钉住。
check('Esc 在捕获阶段接管(否则抢不过 OCUI 的「关栈顶」)', /addEventListener\('keydown', onKeydown, true\)/.test(js),
  'Esc 没在捕获阶段注册,内层视图会被整屏关掉');
check('工具箱自己的确认/输入框打开时不抢 Esc(让 OCUI 关它自己)',
  /oc-confirm-mask:not\(\\?\.hidden\)/.test(js), '没排除自己弹的对话框');
check('列表视图不抢 Esc(交给 modal 栈关整个面板)', /if \(S\.view === 'list'\) return;/.test(js));
check('modal 栈关掉面板后同步模块状态(_onClose)', /mask\._onClose = \(\) => \{\s*if \(S\.open\) doClose\(\);/.test(js),
  '没有 _onClose 同步,面板被栈关掉后模块会卡在 open 状态');
check('预览的「返回」回它进来时的地方(previewFrom)',
  /S\.previewFrom = id \? 'list' : 'editor'/.test(js) && /S\.previewFrom === 'editor' \? 'editor' : 'list'/.test(js),
  '预览返回的位置写死了一边');

console.log(fail === 0 ? '\n工具箱沙箱契约自检通过\n' : '\n失败 ' + fail + ' 项\n');
process.exit(fail === 0 ? 0 : 1);
