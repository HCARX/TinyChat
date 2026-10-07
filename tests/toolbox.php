<?php
/**
 * 在线工具箱自检: php tests/toolbox.php
 * 覆盖: 数据行的读写与修订号、文档清洗(去重/字段白名单/标题回落)、数量与体积上限
 *       (超出必须**明确报错**而不是静默截断)、墓碑语义、注销清理、
 *       页面地址签名、功能开关(总开关 × 访问级别)、以及页面端点的安全响应头。
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
eq('空库读出空文档', tc_toolbox_of($db, 'u1'), array('items' => array(), 'tombs' => array()));
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
eq('未知字段被丢弃(白名单重建)', array_keys($clean['items'][2]), array('id', 'title', 'html', 'createdAt', 'updatedAt'));
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
eq('推回的文档丢掉 pageUrl(不落库)', array_keys($round['items'][0]), array('id', 'title', 'html', 'createdAt', 'updatedAt'));

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
$apiSrc = (string) @file_get_contents($root . '/lib/api.php');
$at = strpos($apiSrc, 'function tc_api_toolbox_page');
$body = $at !== false ? substr($apiSrc, $at, strpos($apiSrc, "\n}", $at) - $at) : '';
if ($body === '') no('找得到 tc_api_toolbox_page');
else {
    has('页面端点覆盖 X-Frame-Options 为 SAMEORIGIN', $body, 'X-Frame-Options: SAMEORIGIN');
    has('页面端点带 CSP sandbox', $body, 'sandbox allow-scripts');
    hasnt('CSP sandbox 不带 allow-same-origin', $body, 'sandbox allow-scripts allow-same-origin');
    has('页面端点带 nosniff', $body, 'X-Content-Type-Options: nosniff');
    has('页面端点 no-store', $body, 'no-store');
    has('按属主判权(不只看签名)', $body, 'tc_toolbox_cookie_uid(');
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

echo "\n" . ($bad ? '✗ 在线工具箱自检失败: ' . $bad . ' 项' : '✓ 在线工具箱自检通过') . "\n";
exit($bad ? 1 : 0);
