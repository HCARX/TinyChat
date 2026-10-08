<?php
/**
 * 云同步内容截断自检: php tests/chat-sync-trunc.php
 *
 * 锁住一个只在「换设备」时才暴露的缺陷:用户消息的 content 里内联着
 * ![名](data:image/png;base64,...),单张图编码后轻易超过 tc_sanitize_chats 对 content 的
 * 200000 字符上限。旧实现直接 substr,把 base64 拦腰截断,剩下的半截既不是图片也不是链接,
 * 渲染端只能整段当普通文字画出来 —— 新设备拉取云端后看到的就是「一堵乱码」。
 * 本机因为手里有完整 attachments 不走这条路,所以问题只在同步后出现。
 *
 * 断言的是修复后的契约:截断点必须落在 Markdown 结构之外,图片本体由 attachments[].dataUrl
 * (8MB 上限)完整承载,渲染端据此重建。
 *
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-synctrunc-' . bin2hex(random_bytes(4));
@mkdir($dataDir, 0777, true);
putenv('DATA_DIR=' . $dataDir);
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/api.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ $m\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ $m\n"; };
$eq = function ($label, $got, $want) use ($ok, $bad) {
    if ($got === $want) $ok($label . ' = ' . var_export($want, true));
    else $bad($label . ': 期望 ' . var_export($want, true) . ', 实际 ' . var_export($got, true));
};

// 造一张 kb 千字节的图,返回其 data URL(编码后约 1.37 倍字符)
$mkDataUrl = function ($kb) {
    return 'data:image/png;base64,' . base64_encode(random_bytes($kb * 1024));
};
$pic = function ($name, $url) { return '![' . $name . '](' . $url . ')'; };
// content 里是否残留「没闭合的 data 图片」——这正是渲染成乱码的形态。
// 先把完整的 ![alt](src) 去掉,剩下的若还有 ![alt](data: 开头就是被截断的残片
// (完整的 data 图片有右括号,会被上面的正则整段移除,不会误报)。
$hasBrokenImage = function ($s) {
    $left = preg_replace('/!\[[^\]]*\]\(\s*[^)\s][^)]*\)/', '', (string) $s);
    return (bool) preg_match('/!\[[^\]]*\]\(\s*data:/', $left);
};
$oneChat = function ($messages) { return array(array('id' => 'c1', 'messages' => $messages)); };
$msgsOf = function ($clean) { return $clean[0]['messages']; };

echo "== 1. 单张大图超过 content 上限:截断点必须落在 Markdown 之外 ==\n";
$big = $mkDataUrl(300);
$content = "帮我看看这张图\n\n" . $pic('门店照片.png', $big);
$att = array('type' => 'image', 'name' => '门店照片.png', 'size' => 307200, 'mediaType' => 'image/png', 'dataUrl' => $big);
$clean = tc_sanitize_chats($oneChat(array(array('role' => 'user', 'content' => $content, 'text' => '帮我看看这张图', 'attachments' => array($att)))));
$m = $msgsOf($clean)[0];
if (strlen($content) > 200000) $ok('原 content 确实超过上限(' . strlen($content) . ' 字符)'); else $bad('测试数据没超过上限,断言无意义');
if (!$hasBrokenImage($m['content'])) $ok('截断后没有半截图片结构(不再渲染成乱码)');
else $bad('截断后残留半截图片结构: ' . substr($m['content'], 0, 80));
if (trim($m['content']) === '帮我看看这张图') $ok('截掉图片后正文干净收尾');
else $bad('正文未干净收尾: ' . var_export(substr($m['content'], -60), true));
$eq('attachments[0].dataUrl 完整保留(渲染端据此重建)', strlen($m['attachments'][0]['dataUrl']), strlen($big));

echo "\n== 2. 多图:截断点落在第二张时,第一张必须完整保留 ==\n";
$u1 = $mkDataUrl(20);
$u2 = $mkDataUrl(300);
$content2 = "对比这两张\n\n" . $pic('图一.png', $u1) . "\n\n" . $pic('图二.png', $u2);
$clean2 = tc_sanitize_chats($oneChat(array(array('role' => 'user', 'content' => $content2, 'text' => '对比这两张', 'attachments' => array(
    array('type' => 'image', 'name' => '图一.png', 'size' => 20480, 'dataUrl' => $u1),
    array('type' => 'image', 'name' => '图二.png', 'size' => 307200, 'dataUrl' => $u2),
)))));
$c2 = $msgsOf($clean2)[0]['content'];
if (strpos($c2, $u1) !== false) $ok('第一张图片的完整 data URL 仍在正文里');
else $bad('第一张图片被连带破坏');
if (strpos($c2, substr($u2, 0, 200)) === false) $ok('第二张没有留下半截 base64');
else $bad('第二张留下半截 base64');
if (!$hasBrokenImage($c2)) $ok('整体没有未闭合的图片结构');
else $bad('整体仍有未闭合的图片结构');

echo "\n== 3. 边界:短内容与完整图片不受影响(幂等) ==\n";
$short = "你好\n\n" . $pic('小图.png', $u1);
$eq('未超限时原样返回', tc_sanitize_chats($oneChat(array(array('role' => 'user', 'content' => $short))))[0]['messages'][0]['content'], $short);
// 图片完整落在前 200000 字节内、后面才是被截掉的正文:整张图必须保住
// (截断按字节算,填充用单字节字符,避免中文 3 字节/字把算盘打乱)
$head = str_repeat('a', 100000) . "\n" . $pic('边缘图.png', $u1) . "\n";
$edge = $head . str_repeat('b', 200000);
$edgeClean = tc_md_safe_cut($edge, 200000);
if (strpos($edgeClean, $u1) !== false) $ok('截断点在图片之后时,整张图被保留');
else $bad('截断点在图片之后,却把整张图误删');
if (strlen($edgeClean) === 200000) $ok('该情形仍按上限原样截断');
else $bad('截断长度异常: ' . strlen($edgeClean));

echo "\n== 4. 普通文本里出现 \"![\" 不属于图片结构,不得回退删字 ==\n";
$plain = str_repeat('文本![不是图片', 50000);
$plainClean = tc_md_safe_cut($plain, 200000);
$eq('纯文本按原上限截断', strlen($plainClean), 200000);

echo "\n== 5. 分享快照同样不留半截图片 ==\n";
$sh = tc_sanitize_share_messages(array(array('role' => 'user', 'content' => $content)));
if ($sh && !$hasBrokenImage($sh[0]['content'])) $ok('分享消息无半截图片');
else $bad('分享消息残留半截图片');

echo "\n== 6. 助手消息(无附件可依)超长也不留半截图片 ==\n";
$asst = "生成结果:\n\n" . $pic('生成图.png', $mkDataUrl(300));
$ac = tc_sanitize_chats($oneChat(array(array('role' => 'assistant', 'content' => $asst))))[0]['messages'][0]['content'];
if (!$hasBrokenImage($ac)) $ok('助手消息无半截图片');
else $bad('助手消息残留半截图片');

echo "\n== 7. 同步往返不丢「开放 API 会话」标记 ==\n";
// 同一个坑的另一面:apiKey 是服务端在开放 API 调用(tc_api_append_chat)时写下的标记,
// 前台据此把接口调用与手动对话分开显示(「今天 API」单独成组、可一键隐藏)。
// tc_sanitize_chats 是白名单,漏掉它就等于客户端把列表推回云端一次、标记永久消失 ——
// 本机照样正常(本地副本自己还带着),只有换设备拉取后才集体退化,和上面那个截断缺陷一样
// 属于「本机永远复现不出来」的类型,所以在这里一起锁住。
$apiChat = tc_sanitize_chats(array(array(
    'id' => 'api0a1b2c3d4e5f',
    'title' => 'API · 你好',
    'apiKey' => 'a1b2c3d4e5f60718',
    'messages' => array(array('role' => 'user', 'content' => '你好')),
)));
$eq('apiKey 原样保留', isset($apiChat[0]['apiKey']) ? $apiChat[0]['apiKey'] : null, 'a1b2c3d4e5f60718');
// 普通对话不能凭空多出标记:多了的话前台会把手动聊天也塞进「今天 API」里
$plainChat = tc_sanitize_chats($oneChat(array(array('role' => 'user', 'content' => 'hi'))));
$eq('普通会话不会凭空多出标记', isset($plainChat[0]['apiKey']) ? $plainChat[0]['apiKey'] : null, null);
$longKey = tc_sanitize_chats(array(array(
    'id' => 'api9', 'apiKey' => str_repeat('k', 200),
    'messages' => array(array('role' => 'user', 'content' => 'hi')),
)));
$eq('超长标记按 64 字符截断', strlen((string) $longKey[0]['apiKey']), 64);

echo "\n结果: " . ($fail === 0 ? '全部通过' : ($fail . ' 项失败')) . "\n";
exit($fail === 0 ? 0 : 1);
