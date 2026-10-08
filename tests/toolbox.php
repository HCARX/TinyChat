<?php
/**
 * 在线工具箱自检: php tests/toolbox.php
 * 覆盖: 数据行的读写与修订号、文档清洗(去重/字段白名单/标题回落/分类)、数量与体积上限
 *       (超出必须**明确报错**而不是静默截断)、墓碑语义、注销清理、
 *       页面地址签名(用户与系统两套命名空间)、功能开关(总开关 × 访问级别)、
 *       页面端点的安全响应头、系统工具箱(种子一次、后台增删改、内置工具契约)。
 * 退出码非 0 表示失败,供 CI 使用。
 */
$root = dirname(__DIR__);
$tmp = sys_get_temp_dir() . '/tc-tbox-' . bin2hex(random_bytes(4));
@mkdir($tmp, 0755, true);
define('TC_ROOT', $root);
putenv('DATA_DIR=' . $tmp);
$_SERVER['REQUEST_METHOD'] = 'GET';
require $root . '/lib/core.php';
require $root . '/lib/api.php';

$bad = 0;
function ok($m) { echo "  ✓ " . $m . "\n"; }
function no($m) { global $bad; $bad++; echo "  ✗ " . $m . "\n"; }
function eq($m, $got, $want) {
    if ($got === $want) ok($m); else no($m . " —— 期望 " . var_export($want, true) . ",实得 " . var_export($got, true));
}
function has($m, $hay, $needle) {
    if (is_string($hay) && strpos($hay, $needle) !== false) ok($m); else no($m . " —— 未找到 " . $needle);
}
function hasnt($m, $hay, $needle) {
    if (!is_string($hay) || strpos($hay, $needle) === false) ok($m); else no($m . " —— 不该出现 " . $needle);
}

// ---------- 1) 数据行读写与修订号 ----------
$db = array('userToolbox' => new stdClass(), 'userToolboxRevisions' => new stdClass());
eq('空库读出空文档', tc_toolbox_of($db, 'u1'), array('cats' => array(), 'items' => array(), 'tombs' => array()));
eq('初始修订号为 0', tc_toolbox_revision_of($db, 'u1'), 0);

$doc = array('items' => array(array('id' => 'a1', 'title' => '计算器', 'html' => '<h1>x</h1>')), 'tombs' => array());
tc_set_toolbox($db, 'u1', $doc);
eq('写入后修订号 +1', tc_toolbox_revision_of($db, 'u1'), 1);
eq('读回内容', tc_toolbox_of($db, 'u1')['items'][0]['title'], '计算器');
eq('按用户隔离:别人的箱子是空的', tc_toolbox_of($db, 'u2')['items'], array());
tc_set_toolbox($db, 'u1', $doc);
eq('再写一次修订号 +1(乐观并发靠它)', tc_toolbox_revision_of($db, 'u1'), 2);

tc_drop_user_toolbox($db, 'u1');
eq('注销后内容清空', tc_toolbox_of($db, 'u1')['items'], array());
eq('注销后修订号也清掉', tc_toolbox_revision_of($db, 'u1'), 0);

// ---------- 2) 文档清洗 ----------
$clean = tc_sanitize_toolbox_doc(array(
    'items' => array(
        array('id' => 'a1', 'title' => '   ', 'html' => '<b>hi</b>'),          // 空标题 -> 回落
        array('id' => 'a1', 'title' => '重复 id', 'html' => 'x'),               // 同 id 只留第一条
        array('id' => '../etc/passwd', 'title' => 't', 'html' => 'y'),          // id 里的路径字符被剔掉
        array('id' => 'a3', 'title' => '带额外字段', 'html' => 'z', 'pageUrl' => '/api/x', 'admin' => true),
        'not-an-array',
    ),
    'tombs' => array('a1' => 111, 'gone' => 222, 'bad id!' => 333),
));
eq('空标题回落为「未命名工具」', $clean['items'][0]['title'], '未命名工具');
eq('重复 id 只保留第一条', count($clean['items']), 3);
eq('id 只留安全字符(路径字符被剔)', $clean['items'][1]['id'], 'etcpasswd');
eq('未知字段被丢弃(白名单重建)', array_keys($clean['items'][2]), array('id', 'cat', 'title', 'html', 'createdAt', 'updatedAt'));
eq('畸形条目被跳过', in_array('not-an-array', array_column($clean['items'], 'html'), true), false);
eq('已存在的 id 不进墓碑', isset($clean['tombs']['a1']), false);
eq('墓碑保留真正删除的 id', isset($clean['tombs']['gone']), true);
eq('墓碑 id 同样只留安全字符', isset($clean['tombs']['badid']), true);
// 标题超长按 60 截断(不报错)
$long = tc_sanitize_toolbox_doc(array('items' => array(array('id' => 't', 'title' => str_repeat('标', 200), 'html' => 'x'))));
eq('超长标题截到 60 字', mb_strlen($long['items'][0]['title']), 60);
// HTML 原样保留:脚本、事件、内联样式都不动(隔离靠沙箱,不靠清洗)
$rawHtml = '<script>alert(1)</script><img src=x onerror=alert(2)><style>body{}</style>';
$keep = tc_sanitize_toolbox_doc(array('items' => array(array('id' => 's', 'title' => 't', 'html' => $rawHtml))));
eq('HTML 原样保存,不做清洗', $keep['items'][0]['html'], $rawHtml);

// ---------- 3) 上限:必须明确报错 ----------
// tc_fail() 会直接 exit,所以这些路径只能在子进程里验(与 sys-quota / json-sidecars 同一手法)。
$probe = $tmp . '/probe.php';
file_put_contents($probe, '<?php
$root = ' . var_export($root, true) . ';
define("TC_ROOT", $root);
putenv("DATA_DIR=" . ' . var_export($tmp, true) . ');
$_SERVER["REQUEST_METHOD"] = "GET";
require $root . "/lib/core.php";
require $root . "/lib/api.php";
require $root . "/lib/oauth.php";   // tc_api_public_config() 会问一键登录有没有配好
$case = $argv[1];
if ($case === "items") {
    $items = array();
    for ($i = 0; $i <= TC_TOOLBOX_MAX_ITEMS; $i++) $items[] = array("id" => "t" . $i, "title" => "n", "html" => "x");
    tc_sanitize_toolbox_doc(array("items" => $items));
} elseif ($case === "html") {
    tc_sanitize_toolbox_doc(array("items" => array(array("id" => "a", "title" => "n", "html" => str_repeat("a", TC_TOOLBOX_MAX_HTML + 1)))));
} elseif ($case === "total") {
    // 每条都在单条上限内,但合计越界
    $per = (int) floor(TC_TOOLBOX_MAX_HTML * 0.9);
    $items = array();
    for ($i = 0; $i < 100; $i++) $items[] = array("id" => "t" . $i, "title" => "n", "html" => str_repeat("a", $per));
    tc_sanitize_toolbox_doc(array("items" => $items));
} elseif ($case === "sysitems") {
    // 系统工具箱用另一套额度(第 2/3 个参数),越界同样必须明确报错
    $items = array();
    for ($i = 0; $i <= 3; $i++) $items[] = array("id" => "t" . $i, "title" => "n", "html" => "x");
    tc_sanitize_toolbox_doc(array("items" => $items), 3, TC_TOOLBOX_MAX_SYS_TOTAL);
} elseif ($case === "cfg") {
    // tc_api_public_config() 走 tc_json() 直接 exit,只能在子进程里读它吐出来的 JSON
    tc_api_public_config(array(
        "settings" => tc_normalize_settings(array("toolboxEnabled" => true)),
        "providers" => array(),
        "users" => array(),
    ));
} elseif ($case === "ok") {
    $items = array();
    for ($i = 0; $i < TC_TOOLBOX_MAX_ITEMS; $i++) $items[] = array("id" => "t" . $i, "title" => "n", "html" => "x");
    $d = tc_sanitize_toolbox_doc(array("items" => $items));
    echo "OK:" . count($d["items"]);
}
');
function probe($case) {
    global $probe;
    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($probe) . ' ' . escapeshellarg($case) . ' 2>&1';
    $out = (string) @shell_exec($cmd);
    return trim($out);
}
eq('数量正好到上限:放行', probe('ok'), 'OK:' . TC_TOOLBOX_MAX_ITEMS);
has('数量超限:报错而不是静默丢弃', probe('items'), '上限');
hasnt('数量超限的响应里不夹带部分结果', probe('items'), '"items"');
has('单条 HTML 超限:报错提示字符数', probe('html'), (string) TC_TOOLBOX_MAX_HTML);
has('总量超限:报错', probe('total'), '总大小');

// ---------- 4) 页面地址签名 ----------
$t1 = tc_toolbox_page_token('abc');
eq('签名可复算', tc_toolbox_page_token('abc'), $t1);
if (tc_toolbox_page_token('abc') !== tc_toolbox_page_token('abd')) ok('签名对 id 敏感'); else no('签名与 id 无关(危险)');
$url = tc_toolbox_page_url('abc/../x');
has('页面地址带 id 与签名', $url, '/api/toolbox/page?id=');
has('id 做了 URL 编码(斜杠被转义)', $url, 'id=abc%2F..%2Fx');
hasnt('页面地址里不出现裸斜杠注入', $url, 'id=abc/');

// 下发投影带 pageUrl,且推回时会被丢掉(不落库)
$db2 = array('userToolbox' => new stdClass(), 'userToolboxRevisions' => new stdClass());
tc_set_toolbox($db2, 'u1', array('items' => array(array('id' => 'zz', 'title' => 't', 'html' => 'h', 'createdAt' => 1.0, 'updatedAt' => 2.0)), 'tombs' => array()));
$pub = tc_toolbox_public_doc($db2, 'u1');
has('下发投影带签名后的 pageUrl', $pub['items'][0]['pageUrl'], '&s=');
// 真的走一遍「下发 → 客户端 → 推回」中间那两次 JSON 编解码,而不是直接把 PHP 数组喂回去
$wire = tc_json_encode($pub);
has('墓碑在下发 JSON 里是对象而不是数组(空的也得是 {})', $wire, '"tombs":{}');
$round = tc_sanitize_toolbox_doc(json_decode($wire, true));
eq('推回的文档丢掉 pageUrl(不落库)', array_keys($round['items'][0]), array('id', 'cat', 'title', 'html', 'createdAt', 'updatedAt'));

// 墓碑往返:这是「删掉的工具过一会儿又回来了」那个 bug 的根源 —— 空 map 被发成 [] 后,
// 前端挂上去的属性会被 JSON.stringify 丢掉,删除动作实际没推上去。
$dbT = array('userToolbox' => new stdClass(), 'userToolboxRevisions' => new stdClass());
$got = tc_sanitize_toolbox_doc(json_decode(tc_json_encode(tc_toolbox_public_doc($dbT, 'u1')), true));
eq('空库下发的墓碑是空对象(不是空数组)', is_array($got['tombs']) ? count($got['tombs']) : -1, 0);
tc_set_toolbox($dbT, 'u1', tc_sanitize_toolbox_doc(array('items' => array(), 'tombs' => array('gone1' => 111))));
$wire2 = json_decode(tc_json_encode(tc_toolbox_public_doc($dbT, 'u1')), true);
eq('墓碑能穿过 JSON 往返(删除不会被撤销)', isset($wire2['tombs']['gone1']), true);
// 不带 assoc 解出来的 stdClass 形态也必须认(某个调用点忘了 assoc 时不能静默丢墓碑)
$mixed = array('items' => array(), 'tombs' => json_decode('{"gone2":2}'));
eq('stdClass 形态的墓碑同样保留', isset(tc_sanitize_toolbox_doc($mixed)['tombs']['gone2']), true);

// ---------- 5) 功能开关 ----------
$on = array('settings' => array('toolboxEnabled' => true));
$off = array('settings' => array('toolboxEnabled' => false));
$adminOnly = array('settings' => array('toolboxEnabled' => true, 'toolboxAccess' => 'admin'));
$listed = array('settings' => array('toolboxEnabled' => true, 'toolboxAccess' => 'list', 'toolboxAccessUsers' => array('alice')));
$user = array('id' => 'u1', 'name' => 'bob');
$admin = array('id' => 'u2', 'name' => 'root', 'admin' => true);
eq('默认开启时普通用户可用', tc_feature_allowed($on, $user, 'toolbox'), true);
eq('默认开启时管理员可用', tc_feature_allowed($on, $admin, 'toolbox'), true);
eq('总开关关掉即拒绝普通用户', tc_feature_allowed($off, $user, 'toolbox'), false);
eq('总开关关掉时管理员也拒绝', tc_feature_allowed($off, $admin, 'toolbox'), false);
eq('仅管理员模式拒绝普通用户', tc_feature_allowed($adminOnly, $user, 'toolbox'), false);
eq('仅管理员模式放行管理员', tc_feature_allowed($adminOnly, $admin, 'toolbox'), true);
eq('名单模式拒绝名单外用户', tc_feature_allowed($listed, $user, 'toolbox'), false);
eq('名单模式放行名单内用户', tc_feature_allowed($listed, array('id' => 'u3', 'name' => 'Alice'), 'toolbox'), true);
$pubFeat = tc_features_public($on, $user);
eq('/api/me 的 features 含 toolbox', isset($pubFeat['toolbox']) && $pubFeat['toolbox'] === true, true);
eq('旧库缺字段视为开启', tc_feature_allowed(array('settings' => array()), $user, 'toolbox'), true);

// ---------- 6) 公共配置下发 ----------
// 匿名访客(未登录)也要知道入口开不开,所以这个字段走 /api/config 而不是 /api/me。
$rawCfg = probe('cfg');
$cfg = json_decode($rawCfg, true);
eq('公共配置里能解析出 JSON', is_array($cfg), true);
eq('公共配置下发 toolboxEnabled', isset($cfg['toolboxEnabled']) && $cfg['toolboxEnabled'] === true, true);

// ---------- 7) 页面端点的安全响应头(源码级契约,与 tests/toolbox-sandbox.js 呼应)----------
// 响应头集中在一个共用函数里:用户自存与系统工具两条路都走它。分头写迟早会各自漂移,
// 而漂移的那一次就是把本站登录态交给页面里的脚本 —— 所以这里钉住「页面函数必须调用它」
// 并且「它带着全套隔离头」两件事。
$apiSrc = (string) @file_get_contents($root . '/lib/api.php');
$fnBody = function ($src, $name) {
    $at = strpos($src, 'function ' . $name);
    if ($at === false) return '';
    $end = strpos($src, "\n}", $at);
    return $end === false ? '' : substr($src, $at, $end - $at);
};
$serve = $fnBody($apiSrc, 'tc_toolbox_serve_html');
$body = $fnBody($apiSrc, 'tc_api_toolbox_page');
if ($serve === '') no('找得到 tc_toolbox_serve_html');
else {
    has('隔离响应头覆盖 X-Frame-Options 为 SAMEORIGIN', $serve, 'X-Frame-Options: SAMEORIGIN');
    has('隔离响应头带 CSP sandbox', $serve, 'sandbox allow-scripts');
    // 只在 CSP 那一行里判「不许有」:函数里还有解释这些限制的注释,拿整个函数体做判据
    // 会被自己写的说明文字绊倒(注释里提到 allow-same-origin 不等于真的放行了它)。
    $cspLine = '';
    if (preg_match('/Content-Security-Policy:[^\n]*/', $serve, $m)) $cspLine = $m[0];
    has('取到了 CSP 头那一行', $cspLine, 'sandbox allow-scripts');
    hasnt('CSP 不带 allow-same-origin', $cspLine, 'allow-same-origin');
    hasnt('CSP 不带 allow-popups-to-escape-sandbox', $cspLine, 'allow-popups-to-escape-sandbox');
    hasnt('CSP 不带 allow-top-navigation', $cspLine, 'allow-top-navigation');
    has('CSP 仍限定 frame-ancestors 为 self', $cspLine, "frame-ancestors 'self'");
    has('隔离响应头带 nosniff', $serve, 'X-Content-Type-Options: nosniff');
    has('隔离响应头 no-store', $serve, 'no-store');
}
if ($body === '') no('找得到 tc_api_toolbox_page');
else {
    has('页面端点走共用的隔离响应头函数', $body, 'tc_toolbox_serve_html(');
    has('按属主判权(不只看签名)', $body, 'tc_toolbox_cookie_uid(');
    has('功能开关也拦一次(关掉后签名地址不能再跑)', $body, "tc_feature_allowed(\$db, \$me, 'toolbox')");
    has('系统工具分支走独立签名命名空间', $body, "\$isSys");
}
// 注销/软删两条路径都要清掉箱子,否则同名重注册会捡到上一个人的工具
has('注销清理接进硬删路径', $apiSrc, 'tc_drop_user_toolbox($db, $id)');
$coreSrc = (string) @file_get_contents($root . '/lib/core.php');
has('演示快照纳入工具箱(到期还原)', $coreSrc, 'demoToolbox');

// ---------- 8) 后台面板接线(改个字段名就会静默失效,钉住) ----------
$adminHtml = (string) @file_get_contents($root . '/admin.html');
$adminJs = (string) @file_get_contents($root . '/static/js/admin.js');
has('后台有工具箱设置面板', $adminHtml, 'id="panel-toolbox"');
has('面板里有总开关', $adminHtml, 'id="toolbox-enabled"');
has('面板里有可见范围容器', $adminHtml, 'id="toolbox-access-block"');
has('面板里有保存按钮', $adminHtml, 'id="toolbox-settings-save"');
has('后台 JS 注册了设置加载器', $adminJs, 'toolbox: loadToolboxSettings');
has('加载器回填总开关', $adminJs, "s.toolboxEnabled !== false");
has('保存分支提交 toolboxEnabled', $adminJs, 'toolboxEnabled:');
has('保存分支带上可见范围', $adminJs, "readFeatureAccess('toolbox')");
has('总览把工具箱算进去', $adminJs, 'toolbox: s.toolboxEnabled !== false');

// ---------- 9) 系统工具箱(全员共用,后台维护) ----------
// 分类清洗:去重 / 去空名 / 截断到上限,id 与工具 id 同规则
$cats = tc_sanitize_toolbox_cats(array(
    array('id' => 'enc', 'name' => '编码转换'),
    array('id' => 'enc', 'name' => '重复 id 只留第一条'),
    array('id' => 'bad id!', 'name' => 'id 里的非法字符被剔'),
    array('id' => 'noname', 'name' => '   '),
    array('name' => '没有 id'),
    'not-an-array',
));
eq('分类去重', count($cats), 2);
eq('分类 id 只留安全字符', $cats[1]['id'], 'badid');
eq('没有名字的分类被丢弃', in_array('noname', array_column($cats, 'id'), true), false);
eq('分类名截到上限长度', mb_strlen(tc_sanitize_toolbox_cats(array(array('id' => 'x', 'name' => str_repeat('名', 200))))[0]['name']), TC_TOOLBOX_CAT_NAME_MAX);
$manyCats = array();
for ($i = 0; $i <= TC_TOOLBOX_MAX_CATS; $i++) $manyCats[] = array('id' => 'c' . $i, 'name' => 'n' . $i);
eq('分类超上限按截断处理(不让整次保存失败)', count(tc_sanitize_toolbox_cats($manyCats)), TC_TOOLBOX_MAX_CATS);

// 内置系统工具箱:12 套工具 / 6 个分类,且每一套都是完整可跑的整页
// v3 起每套工具是一个独立文件(lib/toolbox-tools/*.php),由 toolbox-v3.php 扫描汇总
// (平时由 tc_seed_system_toolbox 惰性 require,这里直接引进来单测这批模板)
require_once $root . '/lib/toolbox-default.php';
$sys = tc_toolbox_default_system();
eq('内置工具 12 套', count($sys['items']), 12);
eq('内置分类 6 个', count($sys['cats']), 6);
$badTool = '';
foreach ($sys['items'] as $it) {
    $h = (string) $it['html'];
    if (stripos($h, '<!doctype html>') !== 0) { $badTool = $it['id'] . ' 不是完整整页'; break; }
    if (strpos($h, '<script>') === false) { $badTool = $it['id'] . ' 没有脚本(工具会是死的)'; break; }
    if (strlen($h) > TC_TOOLBOX_MAX_HTML) { $badTool = $it['id'] . ' 超过单条上限'; break; }
    // 沙箱里没有同源身份:碰 localStorage / document.cookie 会在用户面前直接抛错
    if (preg_match('/localStorage|document\.cookie|sessionStorage/', $h)) { $badTool = $it['id'] . ' 依赖沙箱里不可用的存储'; break; }
    // 内联外链会在断网/内网环境卡住首屏,内置工具一律自带样式与脚本
    if (preg_match('#(src|href)\s*=\s*["\']https?://#i', $h)) { $badTool = $it['id'] . ' 引用了外部资源'; break; }
}
eq('每套内置工具都是自洽的整页(完整 doctype/有脚本/不超限/不依赖存储/不引外链)', $badTool, '');
$sysTitles = array_column($sys['items'], 'title');
eq('内置工具包含 Base64 编解码', in_array('Base64 编解码', $sysTitles, true), true);
eq('内置工具包含批量二维码生成与识别', in_array('批量二维码生成与识别', $sysTitles, true), true);
// id 是升级迁移的锚点:存量库靠 id 认「这套还是出厂原文吗」,改 id 等于让老库永远收不到新版
$sysIds = array_column($sys['items'], 'id');
$wantIds = array('base64', 'urlcode', 'jsonfmt', 'timestamp', 'hash', 'regex', 'jwt', 'password', 'uuid', 'color', 'texttool', 'qrcode');
sort($sysIds); sort($wantIds);
eq('内置工具的 id 集合就是约定的那 12 个', $sysIds, $wantIds);
eq('没有重名工具(下拉里不会出现两个一样的条目)', count($sysTitles), count(array_unique($sysTitles)));
$sysCats = array_column($sys['cats'], 'id');
$dangling = array();
foreach ($sys['items'] as $it) if (!in_array($it['cat'], $sysCats, true)) $dangling[] = $it['id'];
eq('内置工具的归属都能落在内置分类里', $dangling, array());

// ---------- 6b) 下拉控件:v2 起内置工具不再露出系统原生菜单 ----------
// 原生 <select> 点开是操作系统的菜单,和整页样式是两套东西(时间戳那个还被 width:100% 撑满整行)。
// 改法是:包装里注入一段下拉运行时,把页面里的原生 select 就地换成自绘控件并隐藏原生控件 ——
// 原生控件留着当取值载体,所以工具脚本里的 $('#unit').value 一个字都不用改。
$once = array();
foreach ($sys['items'] as $it) {
    $h = (string) $it['html'];
    if (substr_count($h, '<script>') !== 2) $once[$it['id']] = '下拉运行时没注入(或注入多次)';
    // 认运行时用只存在于它脚本里的函数名:样式与脚本里都有 .oc-sel-* 类名,数类名会数错
    elseif (substr_count($h, 'function closeMenu()') !== 1) $once[$it['id']] = '运行时只该有一份,实得 ' . substr_count($h, 'function closeMenu()');
    elseif (strpos($h, 'sel.style.display = \'none\'') === false) $once[$it['id']] = '没把原生 select 藏起来';
    elseif (strpos($h, "sel.dispatchEvent(new Event('change', { bubbles: true }))") === false) $once[$it['id']] = '选中后没派发 change(页内监听会漏掉)';
}
eq('每套工具都注入了且只注入一份下拉运行时', $once, array());
// 运行时只该住在共用包装里,不能渗进各工具的正文/脚本(否则 10 份各写一遍,下一个人改不齐)
$leak = '';
foreach (array('TC_TOOLBOX_HTML_TIME', 'TC_TOOLBOX_JS_TIME', 'TC_TOOLBOX_HTML_HASH', 'TC_TOOLBOX_JS_HASH') as $cn) {
    if (strpos(constant($cn), 'oc-sel') !== false) { $leak = $cn; break; }
}
eq('下拉运行时只在共用包装里(不渗进工具正文与脚本)', $leak, '');
// 自带样式与运行时之间也要分块:出厂原文那一段必须逐字节可认,升级迁移靠它认人
eq('当前样式 = 出厂原文 + 追加块', TC_TOOLBOX_DEFAULT_CSS, TC_TOOLBOX_DEFAULT_CSS_V1 . TC_TOOLBOX_DEFAULT_CSS_ADD);
has('追加块里有下拉控件样式', TC_TOOLBOX_DEFAULT_CSS_ADD, '.oc-sel-menu');
hasnt('出厂原文那一段没有被新样式污染', TC_TOOLBOX_DEFAULT_CSS_V1, 'oc-sel');

// 冻结包装:2.0.145 出厂的那 10 套 HTML 必须能按字节重算出来 —— 升级迁移就是拿它比对
// 「这套工具还是原文吗」。这里用固定哈希钉死,改动了冻结块会立刻红。
$v1Hashes = array(
    'base64' => 'ed61f43aaa0a35acddc3e692946e193c1b5807e7',
    'urlcode' => '16524481b9ef639281b824aa42b266090e728a03',
    'jsonfmt' => '00c73b8001c87ed965569621025c0885f46c532c',
    'timestamp' => '390559de38abfea8830aa95480db0f51bd622b24',
    'hash' => 'a7988d98afed57c688f5986527dd46e8171786fb',
    'regex' => '044553077bb4b24e1200b37d8c1e1ffc0421a32d',
    'password' => '24a4dfbc18151d56b13153cad8bfa15cc9fdf198',
    'uuid' => '5e911e75d49f3946ee864d56bf650b6d89698984',
    'color' => '486984e78208797759fc07592a1eea62a6a40926',
    'texttool' => '679b0b315ef997c2a2987da132eeb08c6d15814e',
);
$v1Sys = tc_toolbox_default_system_v1();
$drift = array();
foreach ($v1Sys['items'] as $it) {
    if (!isset($v1Hashes[$it['id']]) || sha1($it['html']) !== $v1Hashes[$it['id']]) $drift[] = $it['id'];
}
eq('冻结的 2.0.145 出厂包装仍能按字节重算(迁移判据的前提)', $drift, array());
// 2.0.147-2.0.151 出厂的那份同样要冻结:老库升上来时认的就是这两份原文
$v2Sys = tc_toolbox_default_system_v2();
eq('冻结的 2.0.151 出厂内容仍是 10 套(v3 就是拿它认人的)', count($v2Sys['items']), 10);
$v2Same = array();
foreach ($v2Sys['items'] as $it) {
    foreach ($v1Sys['items'] as $old) if ($old['id'] === $it['id'] && $old['html'] === $it['html']) $v2Same[] = $it['id'];
}
eq('2.0.151 的正文确实整体换过(和 2.0.145 逐字节不同,两份冻结块没写重)', $v2Same, array());
// 同名 id 的新旧正文必须真的不同,否则迁移「替换原文」是空动作,断言会假绿
$common = 0; $diffCount = 0;
foreach ($sys['items'] as $it) {
    foreach ($v1Sys['items'] as $old) {
        if ($old['id'] !== $it['id']) continue;
        $common++;
        if ($old['html'] !== $it['html']) $diffCount++;
    }
}
eq('新旧同名工具的套数与迁移预期一致', $common, 10);
eq('新版与出厂原文确实不同(否则迁移无事可做)', $diffCount, $common);
hasnt('新版包装里没有留空脚本标签', $sys['items'][0]['html'], '<script></script>');

// 迁移(v2 顺移):存量库里那 10 套还是 2.0.145 的原文,种子标记已置位不会重种,得单独顺移一次。
// 这一层的产出是 2.0.151 那版内容 —— 后面 v3 顺移再把它们换成重写版。
$v2ById = array();
foreach (tc_toolbox_default_system_v2()['items'] as $it) $v2ById[$it['id']] = $it['html'];
$legacy = tc_toolbox_default_system_v1();
$legacy['items'][0]['html'] = str_replace('</body>', '<!-- 管理员加的一行 --></body>', $legacy['items'][0]['html']);
$migDb = tc_migrate_db(array('sysToolbox' => $legacy, 'toolboxSysSeeded' => true, 'toolboxDefaultsV3Merged' => true));
$migById = array();
foreach ($migDb['sysToolbox']['items'] as $it) $migById[$it['id']] = $it['html'];
$stale = array();
foreach ($v2ById as $id => $html) {
    if ($id === 'base64') continue;   // 这套是管理员改过的,本来就不该被换掉
    if (!isset($migById[$id]) || $migById[$id] !== $html) $stale[] = $id;
}
eq('存量库里的出厂原文都换成了 2.0.151 版', $stale, array());
has('管理员改过的那套原样保留(判据是逐字节比对)', $migById['base64'], '管理员加的一行');
eq('登记了迁移标记(只跑一次)', !empty($migDb['toolboxDefaultsV2Merged']), true);
$migAgain = tc_migrate_db($migDb);
eq('再跑一次不再改动任何内容', $migAgain['sysToolbox'], $migDb['sysToolbox']);
$migEmpty = tc_migrate_db(array('sysToolbox' => array('cats' => array(), 'items' => array()), 'toolboxSysSeeded' => true));
eq('管理员删光系统工具后迁移不会塞回来', $migEmpty['sysToolbox']['items'], array());
has('迁移里调了顺移函数', $coreSrc, 'tc_migrate_toolbox_defaults($db)');
has('顺移会把改动落库(读请求不落库)', $fnBody($coreSrc, 'tc_migrate_toolbox_defaults'), '_tc_db_seed_dirty');
has('顺移的判据是「与出厂原文逐字节相同」', $fnBody($coreSrc, 'tc_migrate_toolbox_defaults'), 'tc_toolbox_default_system_v1()');
// 目标必须是这一代的冻结工厂:写成活的 tc_toolbox_default_system() 会让老库一步填成最新版,
// 下一层 v3 顺移就认不出出厂原文,新版独有的工具补不进来(升级后少二维码/JWT)
has('顺移的目标是这一代的冻结工厂(不是活的当前版本)', $fnBody($coreSrc, 'tc_migrate_toolbox_defaults'), 'tc_toolbox_default_system_v2()');

// ---------- 6c) v3 顺移:把 2.0.145 / 2.0.151 的出厂原文换成重写版 ----------
// 判据同样是逐字节比对,只是要认两份原文;管理员改过的一律不碰。
has('迁移里调了 v3 顺移', $coreSrc, 'tc_migrate_toolbox_defaults_v3($db)');
has('v3 顺移只跑一次(靠标记位)', $fnBody($coreSrc, 'tc_migrate_toolbox_defaults_v3'), 'toolboxDefaultsV3Merged');
has('v3 顺移会把改动落库(读请求不落库)', $fnBody($coreSrc, 'tc_migrate_toolbox_defaults_v3'), '_tc_db_seed_dirty');
$migV3 = tc_migrate_db(array('sysToolbox' => tc_toolbox_default_system_v2(), 'toolboxSysSeeded' => true, 'toolboxDefaultsV2Merged' => true));
$v3ById = array();
foreach ($migV3['sysToolbox']['items'] as $it) $v3ById[$it['id']] = $it['html'];
$v3Miss = array();
foreach ($sys['items'] as $it) if (!isset($v3ById[$it['id']]) || $v3ById[$it['id']] !== $it['html']) $v3Miss[] = $it['id'];
eq('2.0.151 的原文全部换成重写版(10 套换 + 新版独有的补进来)', $v3Miss, array());
eq('重写版工具数量翻新到库里', count($migV3['sysToolbox']['items']), count($sys['items']));
$v3Cats = array_column($migV3['sysToolbox']['cats'], 'id');
eq('新版独有的分类也补进来了', count(array_diff(array_column($sys['cats'], 'id'), $v3Cats)), 0);
// v1 -> v3 一步到位(老库可能直接跨过来)
$migV3b = tc_migrate_db(array('sysToolbox' => tc_toolbox_default_system_v1(), 'toolboxSysSeeded' => true, 'toolboxDefaultsV2Merged' => true));
eq('2.0.145 也能一步换到重写版', count($migV3b['sysToolbox']['items']), count($sys['items']));
// 管理员留下的痕迹必须原样
$legacyV3 = tc_toolbox_default_system_v2();
$legacyV3['items'][0]['html'] = str_replace('</body>', '<!-- 管理员加的一行 --></body>', $legacyV3['items'][0]['html']);
$custom = array('id' => 'mine', 'cat' => 'enc', 'title' => '我自己写的', 'html' => '<!doctype html><html><body>我的</body></html>');
$legacyV3['items'][] = $custom;
$migV3c = tc_migrate_db(array('sysToolbox' => $legacyV3, 'toolboxSysSeeded' => true, 'toolboxDefaultsV2Merged' => true));
$v3cById = array();
foreach ($migV3c['sysToolbox']['items'] as $it) $v3cById[$it['id']] = $it['html'];
has('v3 顺移不动管理员改过的那套', $v3cById['base64'], '管理员加的一行');
eq('v3 顺移不动管理员自建的工具', $v3cById['mine'], $custom['html']);
eq('v3 顺移不重复迁移(标记置位后第二次无变化)', tc_migrate_db($migV3c)['sysToolbox'], $migV3c['sysToolbox']);
// 删干净了就是删干净了:不能因为库里没东西就判定「这还是出厂内容」再塞回来
eq('v3 顺移不会把清空的工具箱塞回来', tc_migrate_db(array('sysToolbox' => array('cats' => array(), 'items' => array()), 'toolboxSysSeeded' => true, 'toolboxDefaultsV2Merged' => true))['sysToolbox']['items'], array());

// 一次完整的升级链:2.0.145 的老库直接升到当前版本,必须拿到全部重写版工具(含新版独有的)
$chain = tc_migrate_db(array('sysToolbox' => tc_toolbox_default_system_v1(), 'toolboxSysSeeded' => true, 'toolboxDefaultsV2Merged' => true));
$chainIds = array_column($chain['sysToolbox']['items'], 'id');
eq('2.0.145 一步升上来就拿到全部重写版工具(两层顺移接力,不吞新版工具)', count($chain['sysToolbox']['items']), count($sys['items']));
eq('2.0.145 一步升上来后新版独有的工具也在', count(array_diff(array_column($sys['items'], 'id'), $chainIds)), 0);
eq('2.0.145 一步升上来后新版分类也在', count(array_diff(array_column($sys['cats'], 'id'), array_column($chain['sysToolbox']['cats'], 'id'))), 0);

// 种子:只跑一次;管理员删光之后不会再塞回来
$dbSeed = array('sysToolbox' => null);
eq('首次运行会装入内置工具', tc_seed_system_toolbox($dbSeed), true);
eq('装进来的是 12 套', count($dbSeed['sysToolbox']['items']), 12);
eq('第二次运行不再改动', tc_seed_system_toolbox($dbSeed), false);
$dbEmpty = array('sysToolbox' => array('cats' => array(), 'items' => array()), 'toolboxSysSeeded' => true);
eq('管理员把系统工具删光后不会被重新塞回', tc_seed_system_toolbox($dbEmpty), false);
eq('删光后的空文档原样保持', $dbEmpty['sysToolbox']['items'], array());
$dbEmpty2 = array('sysToolbox' => array('cats' => array(), 'items' => array()));
tc_seed_system_toolbox($dbEmpty2);
eq('已有空文档时只补标记、不填内容', $dbEmpty2['sysToolbox']['items'], array());
has('迁移里调的种子函数', $coreSrc, 'tc_seed_system_toolbox($db)');
has('引导流程把种子落库(读请求不落库,不写下去就每请求重装一遍)', (string) @file_get_contents($root . '/index.php'), '_tc_db_seed_dirty');

// 库里有 sysToolbox 时用它;为 null(还没种)时用内置默认值兜底
$dbSys = array('sysToolbox' => array('cats' => array(array('id' => 'c1', 'name' => '我的分类')), 'items' => array(array('id' => 'only', 'cat' => 'c1', 'title' => '只有这一个', 'html' => '<p>x</p>'))));
eq('库里有系统工具就用库里的', count(tc_sys_toolbox_of($dbSys)['items']), 1);
eq('库里为 null 时用内置默认值兜底(装好第一屏不会是空的)', count(tc_sys_toolbox_of(array('sysToolbox' => null))['items']), 12);

// 页面地址:两套命名空间必须互不通用,否则用户工具页的合法链接能拿去读同名系统工具
if (tc_toolbox_page_token('base64', true) !== tc_toolbox_page_token('base64', false)) ok('系统工具与用户工具签名命名空间分开'); else no('两种工具的签名相同(可互相顶替)');
eq('用户工具的签名不受新命名空间影响(旧链接仍有效)', tc_toolbox_page_token('abc'), $t1);
has('系统工具地址带 sys=1', tc_toolbox_page_url('base64', true), 'sys=1');
hasnt('用户工具地址不带 sys', tc_toolbox_page_url('abc'), 'sys=1');
$sysPub = tc_sys_toolbox_public_doc($dbSys);
has('系统工具的下发投影带 pageUrl(新标签页打开靠它)', $sysPub['items'][0]['pageUrl'], 'sys=1');
eq('系统工具文档不带墓碑(单份文档不需要)', isset($sysPub['tombs']), false);

// 系统工具的正文不随列表下发:重写版 12 套整页合计约 860KB(gzip 也有 230KB),而列表只要
// 标题/分类/体积。正文按 pageUrl 现取(取到的就是服务端存的同一份 HTML),后台要编辑才带正文。
eq('前台拿到的系统工具不带正文(否则每开一次面板就要下几百 KB)', isset($sysPub['items'][0]['html']), false);
eq('前台拿到的是体积字段(卡片上的 KB 靠它,不能靠正文长度算)', is_int($sysPub['items'][0]['size']) && $sysPub['items'][0]['size'] > 0, true);
$sysPubFull = tc_sys_toolbox_public_doc($dbSys, true);
has('后台拿到的投影带正文(要编辑)', $sysPubFull['items'][0]['html'], '<p>x</p>');
$weigh = array('sysToolbox' => array('cats' => array(), 'items' => array(array('id' => 'a', 'cat' => '', 'title' => 't', 'html' => str_repeat('x', 4321)))));
eq('体积字段就是正文的字节数(不能糊一个常数)', tc_sys_toolbox_public_doc($weigh)['items'][0]['size'], 4321);
// 出厂内容整份下发也要是常数级的小:这条挡的是「哪天有人又顺手把正文塞回列表里」
$realPub = tc_sys_toolbox_public_doc(array('sysToolbox' => tc_toolbox_default_system()));
eq('12 套工具的列表下发不到 40KB(正文改成按需取)', strlen(json_encode($realPub)) < 40000, true);
eq('列表下发里 12 套都在(瘦身不能把条目也削掉)', count($realPub['items']), 12);

// 系统工具的额度是另一套:上限参数化后可验,越界仍要明确报错
$three = array();
for ($i = 0; $i < 3; $i++) $three[] = array('id' => 't' . $i, 'title' => 'n', 'html' => 'x');
eq('系统工具的数量上限可单独设定', count(tc_sanitize_toolbox_doc(array('items' => $three), 3, TC_TOOLBOX_MAX_SYS_TOTAL)['items']), 3);
has('系统工具数量超限也明确报错', probe('sysitems'), '上限');
eq('系统工具总量额度大于用户总额度(它要装下内置那批)', TC_TOOLBOX_MAX_SYS_TOTAL > TC_TOOLBOX_MAX_TOTAL, true);

// 后台接口:路由、鉴权与演示账号的限制(源码级契约)
$routesSrc = (string) @file_get_contents($root . '/index.php');
has('注册了后台系统工具箱读接口', $routesSrc, "'#^/api/admin/toolbox\$#', 'tc_api_admin_toolbox_get'");
has('注册了后台系统工具箱写接口', $routesSrc, "'#^/api/admin/toolbox\$#', 'tc_api_admin_toolbox_save'");
$getFn = $fnBody($apiSrc, 'tc_api_admin_toolbox_get');
$saveFn = $fnBody($apiSrc, 'tc_api_admin_toolbox_save');
has('系统工具箱读接口要管理员', $getFn, 'tc_require_admin($db)');
has('系统工具箱写接口要管理员', $saveFn, 'tc_require_admin($db)');
has('系统工具箱写接口拒绝演示账号', $saveFn, "tc_is_demo_user(\$user)");
has('系统工具箱写接口用更大的额度', $saveFn, 'TC_TOOLBOX_MAX_SYS_ITEMS');
has('系统工具箱写接口剥掉墓碑', $saveFn, "unset(\$doc['tombs'])");
has('系统工具箱写接口落库时打上种子标记', $saveFn, "toolboxSysSeeded");
// 前台同步接口要把系统工具一起下发,否则面板里那一区永远是空的
has('前台同步接口下发系统工具', $fnBody($apiSrc, 'tc_api_toolbox_get'), 'tc_sys_toolbox_public_doc($db)');

// ---------- 10) 后台系统工具面板接线 ----------
has('面板里有系统工具容器', $adminHtml, 'id="toolbox-sys-body"');
has('面板里有保存按钮', $adminHtml, 'id="toolbox-sys-save"');
has('面板里有重新载入按钮', $adminHtml, 'id="toolbox-sys-reload"');
has('后台 JS 有系统工具加载器', $adminJs, 'async function loadToolboxSystem');
has('设置加载器会带上系统工具', $adminJs, 'await loadToolboxSystem()');
has('后台 JS 提交到后台工具箱接口', $adminJs, "'/api/admin/toolbox'");
has('保存前从界面读回整份文档', $adminJs, 'readToolboxSystemDoc()');
has('结构性操作前先收回界面上的编辑', $adminJs, 'syncToolboxSystemFromDom()');
has('工具 HTML 进 textarea 前做转义(否则会破框)', $adminJs, "escapeHtml(it.html || '')");
has('分类可新建', $adminJs, 'tboxSysAddCategory');
has('分类可删除', $adminJs, 'tboxSysDeleteCategory');
has('工具可新增/删除', $adminJs, 'tboxSysAddItem');
has('工具有删除按钮', $adminJs, 'tboxSysDeleteItem');
has('有未保存改动的提示', $adminJs, '有未保存的改动');

// ---------- 11) 前台:自有地址、左上角品牌与返回、分类与系统工具 ----------
$tboxJs = (string) @file_get_contents($root . '/static/js/toolbox.js');
has('前台认领 /toolbox 独立地址', $tboxJs, "'/toolbox'");
has('进入时压入历史(刷新后仍停在这一页)', $tboxJs, "history.pushState({ toolbox: true }, '', '/toolbox')");
has('关闭时地址回到根路径', $tboxJs, "history.pushState(null, '', '/')");
has('监听前进后退', $tboxJs, "addEventListener('popstate'");
has('左上角有品牌 logo(点回对话首页)', $tboxJs, 'id="tb-brand"');
has('品牌图分深浅两套', $tboxJs, 'brand-logo-dark');
has('左上角有返回按钮', $tboxJs, 'tb-back-btn');
has('返回按钮接的是关闭', $tboxJs, "querySelector('[data-act=\"close\"]').addEventListener('click', close)");
has('列表分了「我的工具」与「系统工具」两区', $tboxJs, '系统工具');
has('有分类筛选芯片', $tboxJs, 'tb-chip');
has('有分类管理视图', $tboxJs, 'renderCats');
has('可以把系统工具加入自己的工具箱', $tboxJs, 'adoptSys');
has('系统工具只读(不直接改管理员那份)', $tboxJs, 'viewSource');
$tboxCss = (string) @file_get_contents($root . '/static/css/toolbox.css');
has('样式里有品牌区', $tboxCss, '.tb-brand');
has('样式里有分类芯片', $tboxCss, '.tb-chip');
has('样式里有系统工具卡片区分', $tboxCss, '.tb-card-builtin');
has('后台系统工具样式挂在 chrome.css(后台专用)', (string) @file_get_contents($root . '/static/css/chrome.css'), '.tbox-sys-item');
// 预览沙箱:红线仍然只有那一条。判据取 setAttribute 那一行本身 —— 文件里还有解释
// 这条红线的注释,拿全文判「不许出现 allow-same-origin」会被自己的说明文字绊倒。
$sbLine = '';
if (preg_match("/setAttribute\\('sandbox',[^\\n]*/", $tboxJs, $m)) $sbLine = $m[0];
eq('预览 iframe 的 sandbox 权限集固定(没加任何逃逸项)', $sbLine, "setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');");
has('工具 HTML 只经 srcdoc 属性赋值', $tboxJs, 'frame.srcdoc = S.previewHtml');
has('系统工具与用户工具走同一个预览函数', $tboxJs, 'function runPreview(kind, id)');
// Esc 归属:面板挂在 OCUI 的 modal 栈上,而「关栈顶」的监听注册得比本模块早 —— 内层视图
// 想在 Esc 上退一步就必须在捕获阶段接管,同时放行自己弹的确认框;列表视图放给栈去关。
has('Esc 在捕获阶段接管(抢在 modal 栈的「关栈顶」之前)', $tboxJs, "document.addEventListener('keydown', onKeydown, true)");
has('自己弹的确认/输入框打开时不抢 Esc', $tboxJs, '.oc-confirm-mask:not(.hidden)');
has('列表视图的 Esc 交给 modal 栈', $tboxJs, "if (S.view === 'list') return;");
has('modal 栈关掉面板后同步模块状态(否则卡在 open,再也打不开)', $tboxJs, 'mask._onClose = () => { if (S.open) doClose(); };');
has('预览的「返回」回它进来时的地方', $tboxJs, "S.previewFrom = id ? 'list' : 'editor'");

echo "\n" . ($bad ? '✗ 在线工具箱自检失败: ' . $bad . ' 项' : '✓ 在线工具箱自检通过') . "\n";
exit($bad ? 1 : 0);
