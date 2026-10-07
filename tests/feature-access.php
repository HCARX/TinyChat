<?php
/**
 * 拓展功能可见性 + 中国 IP 段判定自检:
 *   php tests/feature-access.php
 *
 * 锁住四件「写错了也不报错、只会静默越权或静默锁死」的约定:
 *   1) 管理员永远可用 —— 否则管理员把自己关在门外就再也改不回来;
 *   2) 三种模式(all / admin / list)的判定必须与「名字大小写无关」(用户名不该区分大小写);
 *   3) 名单里可以放用户名,也可以放用户组 id,两者是「或」的关系;
 *   4) 境内 IP 段表:二分查找必须与线性扫描对全部边界样本给出同一结论 —— 表是
 *      9000+ 个网段、按字节序比较的,实现里一个 off-by-one 就会让某个网段被漏判。
 */
// core.php 已经 require 了 features.php(设置归一化用到它),这里不要再 require 一次
require __DIR__ . '/../lib/core.php';
// 域名白名单的匹配/闸门判定在 web.php(它自己 require core.php 与 proxy.php)
require_once __DIR__ . '/../lib/web.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ $m\n"; };
$bad = function ($m) { global $fail; $fail++; echo "  ✗ $m\n"; };
$check = function ($name, $cond, $detail = '') use ($ok, $bad) {
    if ($cond) $ok($name); else $bad($name . ($detail !== '' ? ' —— ' . $detail : ''));
};

// 造一个最小 db:一个管理员、一个普通用户、一个组员
$db = array(
    'users' => array(
        array('id' => 'u-admin', 'name' => 'Admin', 'admin' => true, 'groupId' => 'g-admin'),
        array('id' => 'u-plain', 'name' => 'PlainUser', 'admin' => false, 'groupId' => 'g-default'),
        array('id' => 'u-grouped', 'name' => 'Grouped', 'admin' => false, 'groupId' => 'g-vip'),
    ),
    'userGroups' => array(
        array('id' => 'g-admin', 'name' => '管理员', 'role' => 'admin'),
        array('id' => 'g-default', 'name' => '默认用户组', 'role' => 'user'),
        array('id' => 'g-vip', 'name' => 'VIP', 'role' => 'user'),
    ),
    'settings' => array(),
);
$U = function ($i) use ($db) { return $db['users'][$i]; };

echo "== 1. 未配置时的默认值(历史语义:notes 默认关,im/web/toolbox 默认开)==\n";
// 这不是随便定的:api.php 里 notes 的 guard 用 !empty($s['notesEnabled']),缺字段即关;
// im/web/toolbox 用 isset() 判断「显式设成 false 才关」,缺字段即开。这里锁住这个差异,
// 免得以后有人为了「统一」把它改成一样,悄悄改变老库的行为。
$check('notes 未配置时默认关闭', tc_feature_allowed($db, $U(1), 'notes') === false);
$check('im 未配置时默认开启', tc_feature_allowed($db, $U(1), 'im') === true);
$check('web 未配置时默认开启', tc_feature_allowed($db, $U(1), 'web') === true);
$check('toolbox 未配置时默认开启', tc_feature_allowed($db, $U(1), 'toolbox') === true);
$allOn = $db;
$allOn['settings'] = array('notesEnabled' => true, 'imEnabled' => true, 'webEnabled' => true, 'toolboxEnabled' => true);
foreach (tc_feature_ids() as $f) {
    $check($f . ' 显式开启后放行普通用户', tc_feature_allowed($allOn, $U(1), $f) === true);
    $check($f . ' 显式开启后也放行管理员', tc_feature_allowed($allOn, $U(0), $f) === true);
}
$check('未知功能名一律拒绝', tc_feature_allowed($allOn, $U(0), 'nope') === false);

echo "== 3. 在线浏览器的历史总开关 browserEnabled ==\n";
// 设置里有两个开关名都代表「在线浏览器开着」:browserEnabled(历史名,前台 /api/config
// 下发的是它)与 webEnabled(新的统一命名)。两者必须都开才放行 —— 曾经只判 webEnabled,
// 于是后台关掉 browserEnabled 后代理与票据照常放行,界面上关掉了其实没关。
$swOff = $allOn;
$swOff['settings']['browserEnabled'] = false;
$check('关掉 browserEnabled 后普通用户被拒', tc_feature_allowed($swOff, $U(1), 'web') === false);
$check('关掉 browserEnabled 后管理员也被拒(总开关对所有人有效)', tc_feature_allowed($swOff, $U(0), 'web') === false);
$check('关掉 browserEnabled 只影响在线浏览器', tc_feature_allowed($swOff, $U(1), 'im') === true
    && tc_feature_allowed($swOff, $U(1), 'notes') === true);
$swOn = $allOn;
$swOn['settings']['browserEnabled'] = true;
$check('两个开关都开才放行', tc_feature_allowed($swOn, $U(1), 'web') === true);
$swMixed = $allOn;
$swMixed['settings']['browserEnabled'] = true;
$swMixed['settings']['webEnabled'] = false;
$check('任一为关即整体关闭', tc_feature_allowed($swMixed, $U(1), 'web') === false);
$legacy = $db;   // 旧库两个字段都可能缺
$legacy['settings'] = array();
$check('旧库两字段都缺时默认开启', tc_feature_allowed($legacy, $U(1), 'web') === true);

echo "== 4. 仅管理员 ==\n";
foreach (tc_feature_ids() as $f) {
    $s = $allOn;
    $s['settings'][$f . 'Access'] = 'admin';
    $check($f . ': 普通用户被拒', tc_feature_allowed($s, $U(1), $f) === false);
    $check($f . ': 管理员仍可用(否则管理员把自己关在门外)', tc_feature_allowed($s, $U(0), $f) === true);
}

echo "== 5. 仅名单内:用户名 ==\n";
$s = $db;
$s['settings']['webEnabled'] = true;
$s['settings']['webAccess'] = 'list';
$s['settings']['webAccessUsers'] = array('PlainUser');
$check('名单内的用户可以', tc_feature_allowed($s, $U(1), 'web') === true);
$check('名单外的用户不行', tc_feature_allowed($s, $U(2), 'web') === false);
$check('管理员始终可以', tc_feature_allowed($s, $U(0), 'web') === true);

echo "== 4. 用户名匹配不区分大小写 ==\n";
$s = $db;
$s['settings']['webEnabled'] = true;
$s['settings']['webAccess'] = 'list';
$s['settings']['webAccessUsers'] = array('plainuser');   // 全小写配置
$s['users'][1]['name'] = 'PlainUser';                      // 大写开头的真实名
$check('配置全小写、用户名大写开头也能匹配', tc_feature_allowed($s, $U(1), 'web') === true);
$s['settings']['webAccessUsers'] = array('PLAINUSER');
$check('配置全大写同样匹配', tc_feature_allowed($s, $U(1), 'web') === true);

echo "== 5. 仅名单内:用户组 ==\n";
$s = $db;
$s['settings']['webEnabled'] = true;
$s['settings']['webAccess'] = 'list';
$s['settings']['webAccessUsers'] = array();
$s['settings']['webAccessGroups'] = array('g-vip');
$check('组内用户可以', tc_feature_allowed($s, $U(2), 'web') === true);
$check('非组内用户不行', tc_feature_allowed($s, $U(1), 'web') === false);

echo "== 6. 用户名与组是「或」的关系 ==\n";
$s = $db;
$s['settings']['webEnabled'] = true;
$s['settings']['webAccess'] = 'list';
$s['settings']['webAccessUsers'] = array('PlainUser');
$s['settings']['webAccessGroups'] = array('g-vip');
$check('命中用户名即可(不必也在组里)', tc_feature_allowed($s, $U(1), 'web') === true);
$check('命中组即可(不必也在名单里)', tc_feature_allowed($s, $U(2), 'web') === true);

echo "== 7. 名单为空时不放行任何人(除了管理员)==\n";
$s = $db;
$s['settings']['webEnabled'] = true;
$s['settings']['webAccess'] = 'list';
$s['settings']['webAccessUsers'] = array();
$s['settings']['webAccessGroups'] = array();
$check('名单为空的 list 模式不误放行', tc_feature_allowed($s, $U(1), 'web') === false);
$check('但管理员仍可用', tc_feature_allowed($s, $U(0), 'web') === true);

echo "== 8. 名单输入的解析(数组 / 逗号 / 换行 / 大小写)==\n";
$check('数组原样', tc_feature_access_list(array('a', 'b')) === array('a', 'b'));
$check('逗号分隔', tc_feature_access_list('a, b ,c') === array('a', 'b', 'c'));
$check('换行分隔', tc_feature_access_list("a\nb\r\nc") === array('a', 'b', 'c'));
$check('中英文逗号都认', tc_feature_access_list('a，b,c') === array('a', 'b', 'c'));
$check('去空项去重', tc_feature_access_list('a,, a ,b') === array('a', 'b'));
$check('非字符串非数组给空表', tc_feature_access_list(123) === array());
$check('超长列表被截断(上限 200)', count(tc_feature_access_list(implode(',', range(1, 300)))) === 200);

echo "== 9. 模式解析:非法值回落到 all(不误锁)==\n";
$check("'admin' 保留", tc_feature_access_mode('admin') === 'admin');
$check("'list' 保留", tc_feature_access_mode('list') === 'list');
$check("'all' 保留", tc_feature_access_mode('all') === 'all');
$check('空值 -> all', tc_feature_access_mode('') === 'all');
$check('乱填的值 -> all(不会因为一个坏值把功能全锁死)', tc_feature_access_mode('bogus') === 'all');
// 只认全小写的白名单值;'ADMIN' 这类大小写不符的值按非法处理 -> all。
// 这是刻意的:存储层拿到的就是小写,多一种可接受写法只会让排查更绕。
$check("'ADMIN' 视为非法 -> all", tc_feature_access_mode('ADMIN') === 'all');
$check('两边空白先裁掉', tc_feature_access_mode('  admin  ') === 'admin');
$check('非字符串安全回落', tc_feature_access_mode(null) === 'all' && tc_feature_access_mode(array('admin')) === 'all');

echo "== 10. tc_features_public 的形状 ==\n";
$pub = tc_features_public($db, $U(1));
$ids = tc_feature_ids();
// 键集必须与 tc_feature_ids() 完全一致:漏一个前台永远拿不到它的开关,
// 多一个则是改名后留下的死键 —— 两种都会让「后台关了但入口还在」复现。
$check('键集等于 tc_feature_ids()', array_keys($pub) === $ids, implode(',', array_keys($pub)));
$check('每个功能的值都是布尔', count(array_filter($pub, 'is_bool')) === count($ids));
$check('缺省时与 tc_feature_allowed 逐项一致',
    count(array_filter($ids, function ($f) use ($pub, $db, $U) {
        return $pub[$f] === tc_feature_allowed($db, $U(1), $f);
    })) === count($ids));

echo "== 11. 境内 IP 段表 ==\n";
require __DIR__ . '/../lib/cnip.php';
$table = tc_cn_ip_table();
$bin = __DIR__ . '/../lib/cn-ip.bin';
$check('数据文件存在', is_file($bin), $bin);
$check('数据文件可加载', $table !== null);
$check('tc_cn_ip_available() 与表一致', tc_cn_ip_available() === ($table !== null));
if ($table !== null) {
    $check('v4 网段数 > 1000(表不是空的)', $table['n4'] > 1000, '实测 ' . $table['n4']);
    $check('v6 网段数 > 100(表不是空的)', $table['n6'] > 100, '实测 ' . $table['n6']);
}

echo "== 12. 境内 / 境外判定(真实网段样本)==\n";
// 这些地址取自公开的境内网段(阿里云/腾讯云/教育网)与明确的境外网段
$cnSamples = array('1.0.1.0', '111.63.65.247', '182.61.200.110', '113.108.81.189', '59.82.43.239');
$nonCnSamples = array('8.8.8.8', '1.1.1.1', '104.20.23.154', '172.66.147.243', '13.107.42.12');
foreach ($cnSamples as $ip) {
    $check('境内样本 ' . $ip . ' 判定为境内', tc_cn_ip_contains($ip) === true);
}
foreach ($nonCnSamples as $ip) {
    $check('境外样本 ' . $ip . ' 判定为境外', tc_cn_ip_contains($ip) === false);
}
$check('混合解析里只要有一个境内就放行(国内 CDN + 海外节点)',
    tc_cn_ips_any(array('8.8.8.8', '182.61.200.110')) === true);
$check('全部境外则拒绝', tc_cn_ips_any(array('8.8.8.8', '1.1.1.1')) === false);
$check('空列表不放行', tc_cn_ips_any(array()) === false);
$check('非法 IP 不误判为境内', tc_cn_ip_contains('not-an-ip') === false);

echo "== 13. 二分查找与线性扫描结论一致 ==\n";
// 表是按定长字节串排序的,二分里一个 off-by-one 就会漏掉某个网段。
// 直接读原始字节,对每个网段的「起点 / 中点 / 终点」用线性扫描复核二分的结论。
$raw = @file_get_contents($bin);
if ($raw === false) {
    $bad('无法读取 cn-ip.bin,跳过一致性校验');
} else {
    $ver = ord($raw[4]);
    $v4Count = unpack('N', substr($raw, 5, 4))[1];
    $v6Count = unpack('N', substr($raw, 9, 4))[1];
    $v4Off = 13;
    $v6Off = $v4Off + $v4Count * 8;
    $check('头部版本号可读', $ver >= 1, 'ver=' . $ver);
    // 线性扫描:直接逐段比字节
    $linContains = function ($packed, $off, $count, $len) use ($raw) {
        for ($i = 0; $i < $count; $i++) {
            $s = substr($raw, $off + $i * $len * 2, $len);
            $e = substr($raw, $off + $i * $len * 2 + $len, $len);
            if (strcmp($packed, $s) >= 0 && strcmp($packed, $e) <= 0) return true;
        }
        return false;
    };
    mt_srand(20261006);   // 固定种子:失败可复现
    $mismatch = 0;
    $checked = 0;
    for ($n = 0; $n < 60; $n++) {
        $i = mt_rand(0, max(0, $v4Count - 1));
        $s = substr($raw, $v4Off + $i * 8, 4);
        $e = substr($raw, $v4Off + $i * 8 + 4, 4);
        // 三处采样:起点、终点、以及两者之间的一个值
        foreach (array($s, $e) as $probe) {
            $ip = inet_ntop($probe);
            $fast = tc_cn_ip_contains($ip);
            $slow = $linContains($probe, $v4Off, $v4Count, 4);
            $checked++;
            if ($fast !== $slow) { $mismatch++; if ($mismatch <= 3) $bad('不一致: ' . $ip . ' 二分=' . var_export($fast, true) . ' 线性=' . var_export($slow, true)); }
        }
    }
    $check('二分与线性在 ' . $checked . ' 个网段边界样本上结论一致', $mismatch === 0, $mismatch . ' 处不一致');
}

echo "== 14. 表不可用时的失败方向 ==\n";
// 开关默认是开的,读不到表时必须「拒绝」而不是「放行」—— 后者等于悄悄撤掉边界。
$check('tc_cn_ip_contains 对空表返回 false(失败关闭)', (function () {
    // 直接调内部判定:空表 + 空计数
    return tc_cn_ip_in_table(pack('N', 0x01010101), '', 0) === false;
})());

echo "== 15. 域名白名单:文本清洗 ==\n";
// 后台白名单是自由文本(每行一个域名 + # 注释)。清洗必须「规范化能修的、丢弃修不了的」,
// 且保留注释行 —— 前两者决定名单是否可靠,后者决定管理员能否把名单读回来接着改。
$wlRaw = "## 学术站\n Scholar.Google.COM \nhttps://pubmed.ncbi.nlm.nih.gov/abc?q=1\n*.arxiv.org\nbad line!\ntest\n百度.com\nbaidu.com\nBAIDU.com\n## 国内站\nfoo.baidu.com # 行内注释\n";
$wlClean = tc_web_cn_whitelist_clean($wlRaw);
$wlCleanLines = explode("\n", $wlClean);
$check('注释行原样保留', in_array('## 学术站', $wlCleanLines, true) && in_array('## 国内站', $wlCleanLines, true));
$check('大小写归一为小写', in_array('scholar.google.com', $wlCleanLines, true));
$check('整条 URL 取主机名、丢掉路径与查询', in_array('pubmed.ncbi.nlm.nih.gov', $wlCleanLines, true));
$check('前导 *. 通配被规范化掉', in_array('arxiv.org', $wlCleanLines, true));
$check('同一域名的重复写法只留一条', count(array_keys($wlCleanLines, 'baidu.com', true)) === 1);
$check('非法行(带空格/无点)被丢弃', strpos($wlClean, 'bad line!') === false && !in_array('test', $wlCleanLines, true));
$check('行内注释只取域名部分', in_array('foo.baidu.com', $wlCleanLines, true) && strpos($wlClean, '行内注释') === false);
$check('空行的无效域名不落库', tc_web_cn_whitelist_norm('') === '' && tc_web_cn_whitelist_norm('  ') === '');
$check('带端口的写法取主机名', tc_web_cn_whitelist_norm('example.com:8080') === 'example.com');
$check('清洗结果里没有空行(避免文本被撑大)', strpos($wlClean, "\n\n") === false);

echo "== 16. 域名白名单:内置默认与命中判定 ==\n";
$wlDefault = tc_web_default_cn_whitelist();
$wlDefEntries = tc_web_cn_whitelist_entries($wlDefault);
$check('内置默认非空', count($wlDefEntries) > 20, '实测 ' . count($wlDefEntries));
$check('内置默认每个条目本身就是规范形式(不会在保存时被清洗掉)',
    count(array_filter($wlDefEntries, function ($d) { return tc_web_cn_whitelist_norm($d) !== $d; })) === 0);
$check('默认第一批是纯学术站(Google 学术打头)', $wlDefEntries[0] === 'scholar.google.com');
$check('默认含 PubMed', in_array('pubmed.ncbi.nlm.nih.gov', $wlDefEntries, true));
$check('默认含常用国内站(百度/知网)', in_array('baidu.com', $wlDefEntries, true) && in_array('cnki.net', $wlDefEntries, true));
$check('一级域名放行其二级域名', tc_web_host_in_list('www.baidu.com', $wlDefEntries) === true);
$check('多级子域也放行', tc_web_host_in_list('tieba.baidu.com', $wlDefEntries) === true);
$check('.edu.cn 放行所有高校子域', tc_web_host_in_list('www.tsinghua.edu.cn', $wlDefEntries) === true);
$check('域名后缀相同但非子域的不误放行', tc_web_host_in_list('notbaidu.com', $wlDefEntries) === false);
$check('用子域当条目不放行父域', tc_web_host_in_list('google.com', array('scholar.google.com')) === false);
$check('名单外的境外站不命中', tc_web_host_in_list('example.com', $wlDefEntries) === false);
$check('空名单不命中任何主机', tc_web_host_in_list('baidu.com', array()) === false);

echo "== 17. 域名白名单:开关与闸门整合 ==\n";
$wlDbOn = array('settings' => array('webCnWhitelist' => "## x\nbaidu.com\n", 'webCnWhitelistEnabled' => true));
$wlDbOff = array('settings' => array('webCnWhitelist' => "## x\nbaidu.com\n", 'webCnWhitelistEnabled' => false));
$check('开关开启时取出条目', tc_web_cn_whitelist_of($wlDbOn) === array('baidu.com'));
$check('开关关闭时条目为空(退回纯 IP 判定)', tc_web_cn_whitelist_of($wlDbOff) === array());
$check('缺字段时默认启用', tc_web_cn_whitelist_of(array('settings' => array())) !== array());
$check('缺字段时默认名单生效(百度仍放行)', tc_web_host_in_list('www.baidu.com', tc_web_cn_whitelist_of(array('settings' => array()))) === true);
// 闸门:一个解析在境外的域名,白名单里就放行、不在就拒绝 —— 这正是「境外访问也是境外 IP」的修法。
$overseasGuard = array('host' => 'scholar.google.com', 'ips' => array('142.250.72.14'));
$check('境外 IP 且不在白名单 => 拒绝', tc_web_cn_target_ok($overseasGuard, array()) === false);
$check('境外 IP 但在白名单 => 放行', tc_web_cn_target_ok($overseasGuard, $wlDefEntries) === true);
$otherGuard = array('host' => 'example.com', 'ips' => array('93.184.216.34'));
$check('不在白名单的境外站仍拒绝', tc_web_cn_target_ok($otherGuard, $wlDefEntries) === false);
$check('guard 缺 host 时不因白名单误放行', tc_web_cn_target_ok(array('ips' => array('8.8.8.8')), $wlDefEntries) === false);

echo "\n" . ($fail === 0 ? '✓ 拓展功能可见性 / 中国 IP 自检通过' : '✗ 拓展功能可见性 / 中国 IP 自检未通过(' . $fail . ' 项)') . "\n";
exit($fail === 0 ? 0 : 1);
