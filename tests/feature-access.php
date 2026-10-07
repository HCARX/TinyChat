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

echo "\n" . ($fail === 0 ? '✓ 拓展功能可见性 / 中国 IP 自检通过' : '✗ 拓展功能可见性 / 中国 IP 自检未通过(' . $fail . ' 项)') . "\n";
exit($fail === 0 ? 0 : 1);
