<?php
/**
 * 内网上游开关自检: php tests/private-upstream.php
 * 覆盖: 默认关闭时本地/内网地址被 SSRF 防线拒绝、端口白名单生效;
 *       开启后台开关(全局变量注入)后放行本地地址与任意端口,但仍拒绝带凭据的 URL;
 *       环境变量 TC_ALLOW_PRIVATE_UPSTREAM=1 也能放行(在子进程里验,避开 static 缓存)。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-priv-' . bin2hex(random_bytes(4)));
require __DIR__ . '/../lib/core.php';

// 子进程模式:验环境变量这条来源(env 只读一次并被 static 缓存,故单独进程)。
if (isset($argv[1]) && $argv[1] === 'env') {
    putenv('TC_ALLOW_PRIVATE_UPSTREAM=1');
    echo tc_upstream_url_is_safe('http://127.0.0.1:11434/v1') ? 'YES' : 'NO';
    exit(0);
}

$fail = 0;
$ok = function ($m) { echo "  ✓ " . $m . "\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ " . $m . "\n"; };

$LOCAL = array(
    'http://127.0.0.1:11434/v1',
    'http://localhost:11434/v1',
    'http://192.168.1.50:11434/v1',
    'http://10.0.0.5/v1',
    'http://example.com:11434/v1',   // 公网主机但端口不在白名单
);

// ---- 1) 默认关闭:全部拒绝 ----
$GLOBALS['_tc_allow_private_upstream'] = false;
foreach ($LOCAL as $u) {
    if (tc_upstream_url_is_safe($u) === false) $ok('默认关闭时被拒: ' . $u);
    else $bad('默认关闭时竟放行: ' . $u);
}
// 公网 + 白名单端口仍应放行(开关关闭不影响正常上游)
if (tc_upstream_url_is_safe('https://api.openai.com/v1') === true) $ok('默认关闭时公网地址照常放行');
else $bad('默认关闭时公网地址被误拒');

// ---- 2) 开启后台开关:放行本地与任意端口 ----
$GLOBALS['_tc_allow_private_upstream'] = true;
foreach (array('http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://192.168.1.50:11434/v1', 'http://example.com:11434/v1') as $u) {
    if (tc_upstream_url_is_safe($u) === true) $ok('开启后放行: ' . $u);
    else $bad('开启后仍被拒: ' . $u);
}
// 安全底线不因开关而失守:带 user:pass 的 URL 仍拒绝
if (tc_upstream_url_is_safe('http://user:pass@127.0.0.1:11434/v1') === false) $ok('开启后仍拒绝带凭据的 URL');
else $bad('开启后带凭据的 URL 被放行');
// 非 http(s) 协议仍拒绝
if (tc_upstream_url_is_safe('file:///etc/passwd') === false) $ok('开启后仍拒绝非 http(s) 协议');
else $bad('开启后 file:// 被放行');
// 空主机仍拒绝
if (tc_upstream_url_is_safe('http:///v1') === false) $ok('开启后仍拒绝空主机');
else $bad('开启后空主机被放行');
$GLOBALS['_tc_allow_private_upstream'] = false;

// ---- 3) 环境变量这条来源(子进程,避开 static 缓存) ----
$out = shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__FILE__) . ' env');
if (trim((string) $out) === 'YES') $ok('环境变量 TC_ALLOW_PRIVATE_UPSTREAM=1 可放行本地地址');
else $bad('环境变量未生效,得到: ' . trim((string) $out));

// ---- 4) 设置归一化:只认布尔真值,不接受任意真值字符串 ----
$n1 = tc_normalize_settings(array('allowPrivateUpstream' => true));
if ($n1['allowPrivateUpstream'] === true) $ok('归一化:true 保持为真');
else $bad('归一化:true 未保持');
$n2 = tc_normalize_settings(array());
if ($n2['allowPrivateUpstream'] === false) $ok('归一化:缺省为假(默认关闭)');
else $bad('归一化:缺省不是假');
$n3 = tc_normalize_settings(array('allowPrivateUpstream' => ''));
if ($n3['allowPrivateUpstream'] === false) $ok('归一化:空串为假');
else $bad('归一化:空串不是假');

echo $fail === 0 ? "\n全部通过\n" : "\n失败 {$fail} 项\n";
exit($fail === 0 ? 0 : 1);
