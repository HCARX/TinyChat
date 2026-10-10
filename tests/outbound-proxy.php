<?php
/**
 * 出站代理自检: php tests/outbound-proxy.php
 * 覆盖: scheme -> curl 代理类型的映射(http/https/socks4/socks4a/socks5/socks5h)、
 *       非法 scheme 被拒、tc_curl_apply_proxy 实际写入的 CURLOPT_PROXY / CURLOPT_PROXYTYPE。
 * 由于 tc_outbound_proxy 内部有 static 缓存,每个 scheme 都在独立子进程里验(改 env 再跑本文件)。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-proxy-' . bin2hex(random_bytes(4)));
require __DIR__ . '/../lib/core.php';

// 子进程模式:父进程把代理串作为 argv[2] 传进来,这里 putenv 后再取,
// 借此拿到「本进程内首次解析」的结果(tc_outbound_proxy 有 static 缓存)。
// 只把「实际生效的代理与类型」打成一行 JSON 交给父进程断言。
if (isset($argv[1]) && $argv[1] === 'apply') {
    putenv('TC_OUTBOUND_PROXY=' . (isset($argv[2]) ? (string) $argv[2] : ''));
    $opts = array();
    $on = tc_curl_apply_proxy($opts);
    echo json_encode(array(
        'on' => $on,
        'proxy' => isset($opts[CURLOPT_PROXY]) ? $opts[CURLOPT_PROXY] : null,
        'type' => isset($opts[CURLOPT_PROXYTYPE]) ? $opts[CURLOPT_PROXYTYPE] : null,
        'resolved' => tc_outbound_proxy(),
    ));
    exit(0);
}

$fail = 0;
$ok = function ($m) { echo "  ✓ " . $m . "\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ " . $m . "\n"; };

// ---- 1) scheme -> 类型映射(纯函数,可进程内直接验) ----
$expect = array(
    'http'     => defined('CURLPROXY_HTTP') ? CURLPROXY_HTTP : 0,
    'https'    => defined('CURLPROXY_HTTPS') ? CURLPROXY_HTTPS : (defined('CURLPROXY_HTTP') ? CURLPROXY_HTTP : 0),
    'socks4'   => defined('CURLPROXY_SOCKS4') ? CURLPROXY_SOCKS4 : 4,
    'socks4a'  => defined('CURLPROXY_SOCKS4A') ? CURLPROXY_SOCKS4A : 6,
    'socks5'   => defined('CURLPROXY_SOCKS5') ? CURLPROXY_SOCKS5 : 5,
    'socks5h'  => defined('CURLPROXY_SOCKS5_HOSTNAME') ? CURLPROXY_SOCKS5_HOSTNAME : 7,
);
foreach ($expect as $scheme => $type) {
    $t = tc_proxy_scheme_type($scheme);
    if ($t && $t['type'] === $type) $ok("scheme {$scheme} -> 类型 {$type}");
    else $bad("scheme {$scheme} 类型不对: " . json_encode($t));
}
// 大小写不敏感
$t = tc_proxy_scheme_type('SOCKS5H');
if ($t && $t['type'] === $expect['socks5h']) $ok('scheme 解析大小写不敏感');
else $bad('SOCK5H 未按 socks5h 处理');
// 未知 scheme 返回 null(调用方据此不设 PROXYTYPE)
if (tc_proxy_scheme_type('ftp') === null) $ok('未知 scheme 返回 null');
else $bad('未知 scheme 未返回 null');

// 远端解析标记:仅 socks4a / socks5h 为真(这两个由代理解析域名)
$remoteOk = true;
foreach (array('http' => false, 'https' => false, 'socks4' => false, 'socks4a' => true, 'socks5' => false, 'socks5h' => true) as $s => $want) {
    $t = tc_proxy_scheme_type($s);
    if (!$t || $t['remoteDns'] !== $want) { $remoteOk = false; $bad("remoteDns 标记不对: {$s}"); }
}
if ($remoteOk) $ok('remoteDns 标记仅 socks4a/socks5h 为真');

// ---- 2) 端到端:每个 scheme 走子进程,断言实际写入的 curl 选项 ----
// 子进程复用本文件(apply 模式),其内核里 tc_outbound_proxy 的 static 缓存是干净的。
$php = escapeshellarg(PHP_BINARY);
$self = escapeshellarg(__FILE__);
foreach ($expect as $scheme => $type) {
    $url = $scheme . '://user:pass@127.0.0.1:1080';
    $cmd = "{$php} {$self} apply " . escapeshellarg($url);
    $out = shell_exec($cmd);
    $j = json_decode((string) $out, true);
    if (!is_array($j)) { $bad("{$scheme}: 子进程未返回 JSON (" . trim((string) $out) . ")"); continue; }
    if ($j['on'] === true && $j['proxy'] === $url && $j['type'] === $type) {
        $ok("{$scheme}: 代理与类型均已写入 curl 选项");
    } else {
        $bad("{$scheme}: " . json_encode($j));
    }
}

// ---- 3) 非法 scheme 必须不被采纳(不能把任意串塞进代理) ----
foreach (array('ftp://127.0.0.1:21', 'file:///etc/passwd', 'javascript:alert(1)', 'socks6://127.0.0.1:1080') as $badUrl) {
    $cmd = "{$php} {$self} apply " . escapeshellarg($badUrl);
    $j = json_decode((string) shell_exec($cmd), true);
    if (is_array($j) && $j['on'] === false && $j['proxy'] === null && $j['resolved'] === '') {
        $ok('非法代理被拒: ' . $badUrl);
    } else {
        $bad('非法代理未被拒: ' . $badUrl . ' -> ' . json_encode($j));
    }
}

// ---- 4) 未配置代理时不写任何代理选项(直连) ----
$cmd = $php . ' ' . $self . ' apply';
$j = json_decode((string) shell_exec($cmd), true);
if (is_array($j) && $j['on'] === false && $j['proxy'] === null) $ok('未配置时代理选项为空(直连)');
else $bad('未配置时仍写了代理选项: ' . json_encode($j));

echo $fail === 0 ? "\n全部通过\n" : "\n失败 {$fail} 项\n";
exit($fail === 0 ? 0 : 1);
