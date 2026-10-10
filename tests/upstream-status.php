<?php
/**
 * 上游状态码回传自检: php tests/upstream-status.php
 *
 * 本站自己也用 401/402/403 表达「登录态失效 / 本站额度不足 / 本站权限不足」,
 * 前端据此登出并跳登录页。因此把上游的同类状态原样透传,会让「供应商 Key 填错」
 * 被误判成「你的登录过期了」——用户在前台一发消息就被踢出登录。
 * tc_upstream_relay_status() 必须把上游的 401/402/403 归一到 502,其余状态保持原样
 * (429/5xx 语义中立,前端不会误读成登录态)。退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
putenv('DATA_DIR=' . sys_get_temp_dir() . '/tc-ust-' . bin2hex(random_bytes(4)));
require __DIR__ . '/../lib/core.php';

$fail = 0;
$check = function ($in, $want) use (&$fail) {
    $got = tc_upstream_relay_status($in);
    if ($got === $want) {
        echo "  ✓ 上游 " . $in . " => " . $got . "\n";
    } else {
        $fail++;
        echo "  ✗ 上游 " . $in . " 期望 " . $want . "，实际 " . $got . "\n";
    }
};

// 认证 / 权限 / 配额类:必须归一为 502,绝不能透传成 401/402/403
$check(401, 502);
$check(402, 502);
$check(403, 502);
// 语义中立或被本站复用的其它状态:保持原样
$check(429, 429);   // 限流:前端自己提示「请求太频繁」,不涉及登录态
$check(400, 400);
$check(404, 404);
$check(422, 422);
$check(500, 500);
$check(502, 502);
$check(503, 503);
$check(504, 504);
$check(200, 200);
$check(0, 0);

// 字符串输入(上游状态来自 curl 的 HTTP_CODE,可能以字符串形态流转)同样按整数判定
$check('401', 502);
$check('403', 502);
$check('429', 429);

exit($fail === 0 ? 0 : 1);
