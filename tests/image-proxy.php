<?php
/**
 * 生图图片代理自检: php tests/image-proxy.php
 * 覆盖: 代理地址生成与验签、SSRF 防护(内网/保留地址拒绝、公网放行、非 http(s) 拒绝)。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-imgpx-' . bin2hex(random_bytes(4)));
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ " . $m . "\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ " . $m . "\n"; };

// 1) 代理地址:data: 原样返回,http(s) 生成带签名的同源路径
$dataUrl = 'data:image/png;base64,AAAA';
if (tc_img_proxy_path($dataUrl) === $dataUrl) $ok('data: 地址无需代理'); else $bad('data: 地址被错误代理');

$src = 'https://platform-outputs.agnes-ai.space/images/t2i/task_x/output_y.png';
$path = tc_img_proxy_path($src);
if (strpos($path, '/api/proxy/image?u=') === 0) $ok('http(s) 生成同源代理路径'); else $bad('代理路径前缀不对: ' . $path);
if (strpos($path, 's=') !== false) $ok('代理路径带签名'); else $bad('代理路径缺少签名');
// 签名可复算且对 URL 敏感
if (strpos($path, tc_img_proxy_token($src)) !== false) $ok('签名可复算'); else $bad('签名不可复算');
if (tc_img_proxy_token($src) !== tc_img_proxy_token($src . 'x')) $ok('签名对不同 URL 不同'); else $bad('签名与 URL 无关(危险)');

// 2) SSRF 防护
$deny = array(
    'http://127.0.0.1/x.png',
    'http://localhost/x.png',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/a.png',
    'http://192.168.1.1/a.png',
    'http://172.16.0.1/a.png',
    'http://[::1]/a.png',
    'file:///etc/passwd',
    'gopher://x/1',
    '',
);
foreach ($deny as $u) {
    if (!tc_url_is_public_http($u)) $ok('拒绝 ' . ($u === '' ? '(空)' : $u));
    else $bad('未拒绝内网/非法地址: ' . $u);
}
$allow = array('https://platform-outputs.agnes-ai.space/a.png', 'http://8.8.8.8/a.png');
foreach ($allow as $u) {
    if (tc_url_is_public_http($u)) $ok('允许 ' . $u);
    else $bad('误拒公网地址: ' . $u);
}
// 非常规端口与网页抓取同一套白名单,即使地址本身是公网也不放行
$ports = array('http://8.8.8.8:22/a.png', 'https://example.com:8444/a.png', 'http://1.1.1.1:8080/a.png');
if (!tc_url_is_public_http($ports[0]) && !tc_url_is_public_http($ports[1])) $ok('拒绝非常规端口');
else $bad('非常规端口被放行');
if (tc_url_is_public_http($ports[2])) $ok('允许 8080'); else $bad('误拒 8080');

$html = '<p>条款</p><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(2)">点</a><img src="http://127.0.0.1/a.png">';
$clean = tc_agreement_html($html);
if (strpos($clean, '条款') !== false && strpos($clean, '<script') === false && stripos($clean, 'onclick') === false && stripos($clean, 'javascript:') === false) {
    $ok('协议页去掉脚本、事件和危险链接');
} else {
    $bad('协议页清洗不完整: ' . $clean);
}
if (trim(tc_agreement_html('   ')) === '') $ok('空协议清洗后为空'); else $bad('空白协议未被视为空');

// 3) 图片结果解析后应带 display(同源代理)字段
$items = tc_image_results_from_payload(array('data' => array(array('url' => $src))), 1);
// 解析函数本身不补 display(由生图流程补),这里只校验 url 解析正确
if (!empty($items[0]['url']) && $items[0]['url'] === $src) $ok('url 结果解析正确'); else $bad('url 结果解析失败');

// 4) 媒体输出类型收紧。上游返回的 Content-Type 若原样透传,image/svg+xml 会在本站源内
//    内联跑脚本,text/html 更直接 —— 等于把存储型 XSS 的入口交给上游配置。
$m = 'tc_proxy_media_ctype';
$cases = array(
    // array(输入, 族, 默认, 期望)
    array('image/png', array('image'), 'image/png', 'image/png'),
    array('IMAGE/PNG', array('image'), 'image/png', 'image/png'),
    array('image/png; charset=binary', array('image'), 'image/png', 'image/png'),
    // SVG 保留(靠 tc_proxy_media_headers 里的 CSP sandbox 断脚本),但必须原样等值,
    // 否则那层判等加不上 sandbox。
    array('image/svg+xml', array('image'), 'image/png', 'image/svg+xml'),
    array('IMAGE/SVG+XML', array('image'), 'image/png', 'image/svg+xml'),
    array('text/html', array('image'), 'image/png', 'image/png'),
    array('application/xhtml+xml', array('image'), 'image/png', 'image/png'),
    array('text/html', array('video', 'audio'), 'video/mp4', 'video/mp4'),
    array('video/webm', array('video', 'audio'), 'video/mp4', 'video/webm'),
    array('audio/mpeg', array('video', 'audio'), 'video/mp4', 'audio/mpeg'),
    array('image/svg+xml', array('video', 'audio'), 'video/mp4', 'video/mp4'),
    array('', array('image'), 'image/png', 'image/png'),
    // 拼接串/换行注入:前缀判断会放过,等值加 sandbox 又会落空,必须一律回落默认类型
    array('image/svg+xml, text/html', array('image'), 'image/png', 'image/png'),
    array("image/svg+xml\r\nX-Injected: 1", array('image'), 'image/png', 'image/png'),
    array('image/svg+xml/x', array('image'), 'image/png', 'image/png'),
);
foreach ($cases as $c) {
    $got = tc_proxy_media_ctype($c[0], $c[1], $c[2]);
    if ($got === $c[3]) $ok('媒体类型 ' . str_replace("\r\n", '\r\n', $c[0] === '' ? '(空)' : $c[0]) . ' → ' . $got);
    else $bad('媒体类型 ' . str_replace("\r\n", '\r\n', $c[0]) . ' 期望 ' . $c[3] . ' 实得 ' . $got);
}

// 5) 协议页链接的协议白名单:浏览器解析 URL 前会剥掉制表符/换行,「jav\tascript:」在
//    DOM 里就还原成 javascript:,只在字符串开头比前缀会被绕过。
$hrefBad = array(
    'javascript:alert(1)',
    "jav\tascript:alert(1)",
    "jav\nascript:alert(1)",
    "jav\rascript:alert(1)",
    '  javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,AAAA',   // data 图只允许出现在 src,不许出现在 href
);
foreach ($hrefBad as $u) {
    if (!tc_agreement_url_ok('href', $u)) $ok('协议页拒绝 href: ' . json_encode($u));
    else $bad('协议页未拒绝 href: ' . json_encode($u));
}
$hrefOk = array('https://example.com/x', 'http://example.com/x', '#anchor', '/local/path', 'mailto:a@b.c');
foreach ($hrefOk as $u) {
    if (tc_agreement_url_ok('href', $u)) $ok('协议页放行 href: ' . $u);
    else $bad('协议页误拦 href: ' . $u);
}
if (tc_agreement_url_ok('src', 'data:image/png;base64,AAAA')) $ok('协议页允许 src 内联图');
else $bad('协议页误拦 src 内联图');
if (!tc_agreement_url_ok('src', 'data:image/svg+xml;base64,AAAA')) $ok('协议页禁止 src 内联 SVG');
else $bad('协议页放行了 src 内联 SVG');
// 端到端:DIV 解析会把 &#x09; 还原成制表符,再交给同一个白名单
$ent = tc_agreement_html('<p>x</p><a href="jav&#x09;ascript:alert(1)">点</a>');
if (stripos($ent, 'javascript') === false && stripos($ent, 'ascript') === false) $ok('协议页拦下实体编码的 javascript:');
else $bad('协议页漏过实体编码链接: ' . $ent);

echo "\n" . ($fail ? '✗ 生图图片代理自检失败: ' . $fail . ' 项' : '✓ 生图图片代理自检通过') . "\n";
exit($fail ? 1 : 0);
