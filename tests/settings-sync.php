<?php
/**
 * 用户设置云同步自检: php tests/settings-sync.php
 * 覆盖:空库/迁移形状 / 按用户分片的 uset: 行读写 / sanitize 白名单与取值收敛 /
 *       修订号乐观并发 / 注销与硬删清理设置。退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-settings-test-' . bin2hex(random_bytes(4));
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

// 1) 空库与迁移
$db = tc_empty_db();
$eq('空库带 userSettings', isset($db['userSettings']), true);
$eq('空库带 userSettingsRevisions', isset($db['userSettingsRevisions']), true);
$migrated = tc_migrate_db(array(
    'users' => array(),
    'userSettings' => array('u1' => array('prefs' => array('theme' => 'dark'))),
    'userSettingsRevisions' => array('u1' => 3),
));
$eq('迁移保留设置文档', $migrated['userSettings']->u1['prefs']['theme'], 'dark');
$eq('迁移保留修订号', (int) $migrated['userSettingsRevisions']->u1, 3);

// 2) 分片读写 + 修订号
$db2 = tc_empty_db();
$eq('未写入时读到空文档', tc_user_settings_of($db2, 'u1'), array());
$eq('未写入时修订号为 0', tc_user_settings_revision_of($db2, 'u1'), 0);
tc_set_user_settings($db2, 'u1', array('prefs' => array('theme' => 'dark')));
$eq('写入后可读回', tc_user_settings_of($db2, 'u1')['prefs']['theme'], 'dark');
$eq('写入后修订号 +1', tc_user_settings_revision_of($db2, 'u1'), 1);
tc_set_user_settings($db2, 'u1', array('prefs' => array('theme' => 'light')));
$eq('再次写入修订号再 +1', tc_user_settings_revision_of($db2, 'u1'), 2);
$eq('用户之间互不影响', tc_user_settings_revision_of($db2, 'u2'), 0);

// 3) sanitize:偏好白名单与取值收敛
$doc = tc_sanitize_user_settings(array(
    'v' => 1,
    'prefs' => array(
        'theme' => 'dark',
        'stream' => 0,
        'reasoningEffort' => 'ultra',       // 非法枚举 → 丢弃
        'contextMessages' => 9999,          // 超上限 → 收敛到 500
        'fontSize' => 3,                    // 低于下限 → 收敛到 11
        'lastModel' => str_repeat('m', 300), // 超长 → 截断到 200
        'accent' => "#2563eb\x00\x07",       // 控制字符剔除
        'evil' => array('nested' => 1),      // 未知键且非标量 → 丢弃
        'futureFlag' => true,                // 未知标量 → 保留(向前兼容新偏好)
        'futureText' => 'ok',
        // 模型引用型偏好:值形如 "providerId\nmodelId"。曾经落进普通短文本清洗,
        // 换行被当控制字符剥掉 → "prov1m1",跨设备同步后既找不到供应商也找不到模型。
        'judgeModel' => "prov1\nm1",
        'followupsModel' => "  prov2 \n m2  ", // 顺带归一化:去空段/首尾空白,保留换行
        'notesModel' => "prov3\x0bm3\n",       // \x0b 是控制字符(剔除),末尾空段丢弃
    ),
    'ui' => array(
        'sidebarWidth' => 5000,             // 收敛到 1200
        'contentWidth' => 61.8,             // 百分比,必须原样保留(不能被旧的 px 区间夹成 400)
        'composerMode' => 'group',
        'imageModel' => "provA\nmodel-a",   // 模型引用型:同样必须保住换行分隔符
        'videoModel' => "provB\nmodel-b",
        'composerModeBad' => 'x',
        'notesAiCfg' => array(
            'disabled' => array('translate'),
            'custom' => array(array('key' => 'k1', 'label' => '摘要', 'prompt' => 'p')),
            'overrides' => array('summarize' => array('label' => '概览')),
        ),
        'chatGroupCollapsed' => array('今天' => false),
        'notesMdbarPos' => array('x' => '10', 'y' => 20),
    ),
    'groups' => array(
        'activeId' => 'g1',
        'groups' => array(array(
            'id' => 'g1',
            'name' => '问题研讨',
            'mode' => 'round',
            'settings' => array('maxMembers' => 99, 'maxRounds' => 0),
            'participants' => array(array(
                'id' => 'p1', 'name' => '群主', 'emoji' => '👑', 'avatar' => 99,
                'prompt' => '你是群主', 'admin' => true, 'avatarPinned' => true,
                'providerId' => 'prov1', 'model' => 'm1', 'style' => 'rational', 'enabled' => true,
            )),
            'unknownField' => 'drop-me',
        )),
    ),
    'fonts' => array('我的字体' => '@font-face{font-family:"X";src:url(x.woff2)}'),
    'tombs' => array('groups.gone' => 1700000000000, 'fonts.旧字体' => 1700000000001),
    'at' => array('prefs.theme' => 1700000000000, 'ui.sidebarWidth' => 1700000000001),
    'updatedAt' => 1700000000001,
));
// 断言按「客户端看到的线上形状」做:JSON 往返成纯数组,顺带验证空值是 {} 而非 []
$docObj = $doc;
$doc = json_decode(json_encode($docObj), true);
$eq('theme 保留', $doc['prefs']['theme'], 'dark');
$eq('布尔键按真假收敛', $doc['prefs']['stream'], false);
$eq('非法枚举被丢弃', array_key_exists('reasoningEffort', $doc['prefs']), false);
$eq('数值上限收敛', $doc['prefs']['contextMessages'], 500);
$eq('数值下限收敛', $doc['prefs']['fontSize'], 11);
$eq('超长字符串截断', strlen($doc['prefs']['lastModel']), 200);
$eq('控制字符剔除', $doc['prefs']['accent'], '#2563eb');
$eq('未知非标量键丢弃', array_key_exists('evil', $doc['prefs']), false);
$eq('未知标量键保留(向前兼容)', $doc['prefs']['futureFlag'], true);
$eq('UI 数值收敛', $doc['ui']['sidebarWidth'], 1200);
// 对话列宽度:客户端推的是百分比(50~100,可带一位小数)。
// 这里曾经沿用旧的 px 区间 400~2400,把 61.8 夹成 400 —— 云端同步一开,
// 用户拖好的宽度下次拉取就变成 400%,等于设置失效。
$eq('对话列宽度百分比原样保留', $doc['ui']['contentWidth'], 61.8);
$eq('对话列宽度不被旧的 px 下限夹到 400', tc_settings_ui(array('contentWidth' => 100))['contentWidth'], 100);
$eq('对话列宽度保留 upgrade 前的 px 旧值', tc_settings_ui(array('contentWidth' => 820))['contentWidth'], 820);
$eq('对话列宽度超上限收敛', tc_settings_ui(array('contentWidth' => 99999))['contentWidth'], 2400);
$eq('对话列宽度低于下限收敛', tc_settings_ui(array('contentWidth' => 10))['contentWidth'], 50);
$eq('枚举值保留', $doc['ui']['composerMode'], 'group');
// 模型引用型偏好:换行分隔符必须活着穿过服务端清洗(否则跨设备同步后 silently 失效)
$eq('偏好:模型引用保留换行', $doc['prefs']['judgeModel'], "prov1\nm1");
$eq('偏好:模型引用去空白/空段后仍为两段', $doc['prefs']['followupsModel'], "prov2\nm2");
$eq('偏好:模型引用剔除控制字符但保住换行', $doc['prefs']['notesModel'], "prov3m3");
$eq('界面:生图模型引用保留换行', $doc['ui']['imageModel'], "provA\nmodel-a");
$eq('界面:生视频模型引用保留换行', $doc['ui']['videoModel'], "provB\nmodel-b");
// 直接对清洗函数下探:普通短文本仍必须剔除换行(别为了模型引用把全局行为放松了)
$eq('普通短文本仍剔除换行(未被模型引用规则波及)', tc_settings_text("a\nb", 200), 'ab');
$eq('模型引用清洗保留换行', tc_settings_model_ref("a\nb", 200), "a\nb");
$eq('模型引用清洗去首尾空白', tc_settings_model_ref("  a \n b  ", 200), "a\nb");
$eq('模型引用清洗丢空段', tc_settings_model_ref("a\n\n\nb", 200), "a\nb");
$eq('模型引用清洗空值仍为空', tc_settings_model_ref("  \n  ", 200), '');
$eq('未在白名单的 UI 键丢弃', array_key_exists('composerModeBad', $doc['ui']), false);
$eq('笔记动作配置保留', $doc['ui']['notesAiCfg']['custom'][0]['key'], 'k1');
$eq('折叠状态保留', $doc['ui']['chatGroupCollapsed']['今天'], false);
$eq('工具条坐标转整数', $doc['ui']['notesMdbarPos']['x'], 10);
$eq('群聊:非法成员数收敛', $doc['groups']['groups'][0]['settings']['maxMembers'], 12);
$eq('群聊:轮次下限收敛', $doc['groups']['groups'][0]['settings']['maxRounds'], 1);
$eq('群聊:头像序号收敛', $doc['groups']['groups'][0]['participants'][0]['avatar'], 20);
$eq('群聊:未白名单字段丢弃', array_key_exists('unknownField', $doc['groups']['groups'][0]), false);
$eq('群聊:activeId 指向不存在的群时置空', tc_settings_groups(array('activeId' => 'nope'))['activeId'], '');
$eq('自定义字体保留', isset($doc['fonts']['我的字体']), true);
$eq('墓碑保留', (int) $doc['tombs']['groups.gone'], 1700000000000);
$eq('时间戳保留', (int) $doc['at']['prefs.theme'], 1700000000000);
// 线上形状(客户端看到的 JSON):空表必须是 {} 而不是 [],否则前端要兼容两种空值
$empty = json_decode(json_encode(tc_sanitize_user_settings(null)), true);
$eq('空文档键集合稳定', array_keys($empty), array('v', 'updatedAt', 'prefs', 'ui', 'groups', 'fonts', 'tombs', 'at'));
$eq('空偏好序列化为对象', json_encode(tc_sanitize_user_settings(null)['prefs']), '{}');
$eq('空字体表序列化为对象', json_encode(tc_sanitize_user_settings(null)['fonts']), '{}');
$eq('空群聊为 {groups:[],activeId:""}', json_encode(tc_sanitize_user_settings(null)['groups']), '{"groups":[],"activeId":""}');
$eq('偏好线上形状为对象', substr(json_encode($docObj['prefs']), 0, 1), '{');

// 4) 时间戳限幅:时钟跑飞的设备不能永久胜出
$far = tc_now() + 365 * 86400000;
$clamped = tc_settings_timestamps(array('prefs.theme' => $far, 'prefs.x' => -5, 'prefs.y' => 'abc'));
$eq('未来时间戳被限幅', (int) $clamped->{'prefs.theme'} <= tc_now() + 7 * 86400000 + 1000, true);
$eq('负数时间戳归零', (int) $clamped->{'prefs.x'}, 0);
$eq('非数字时间戳丢弃', isset($clamped->{'prefs.y'}), false);

// 5) 分片落库:userSettings → uset:{uid} 行,且不会被当成顶层键
if (extension_loaded('pdo_sqlite')) {
    $pdo = new PDO('sqlite::memory:');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('CREATE TABLE store (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    tc_db_write_snapshot($pdo, array(
        'users' => array(),
        'userSettings' => array('u1' => array('prefs' => array('theme' => 'dark'))),
        'userSettingsRevisions' => array('u1' => 7),
    ));
    $row = $pdo->query("SELECT v FROM store WHERE k = 'uset:u1'")->fetchColumn();
    $eq('落库为 uset: 行', $row !== false, true);
    $top = $pdo->query("SELECT COUNT(*) FROM store WHERE k = 'userSettings'")->fetchColumn();
    $eq('不写顶层 userSettings 行', (int) $top, 0);
    $loaded = tc_db_load_with_baseline($pdo);
    $eq('装配回 userSettings', $loaded[0]['userSettings']->u1['prefs']['theme'], 'dark');
    $eq('装配回修订号', (int) $loaded[0]['userSettingsRevisions']->u1, 7);
    $eq('基线携带 uset 原始行', isset($loaded[5]['u1']), true);
} else {
    echo "  (skip) 未加载 pdo_sqlite,跳过落库分片自检\n";
}

// 6) 注销 / 删除用户时清理设置
$mk = function () {
    return array(
        'users' => array(array('id' => 'u9', 'name' => 'tester', 'quota' => 1, 'createdAt' => 1, 'tv' => 1)),
        'userSettings' => array('u9' => array('prefs' => array('theme' => 'dark'))),
        'userSettingsRevisions' => array('u9' => 4),
    );
};
$softDb = tc_migrate_db($mk());
$res = tc_soft_delete_user($softDb, 'u9');
$eq('软注销成功', !empty($res['ok']), true);
$eq('软注销清空设置文档', tc_user_settings_of($softDb, 'u9'), array());
$eq('软注销清空修订号', tc_user_settings_revision_of($softDb, 'u9'), 0);
$hardDb = tc_migrate_db($mk());
tc_purge_user($hardDb, 'u9');
$eq('硬删除清空设置文档', tc_user_settings_of($hardDb, 'u9'), array());
$eq('硬删除清空修订号', tc_user_settings_revision_of($hardDb, 'u9'), 0);
$db3 = tc_migrate_db(array('users' => array(), 'userSettings' => array('u1' => array()), 'userSettingsRevisions' => array('u1' => 1)));
tc_drop_user_settings($db3, 'u1');
$eq('清理后不再保留该用户分片', isset(tc_assoc($db3['userSettings'])['u1']), false);
$eq('清理后不再保留该用户修订号', isset(tc_assoc($db3['userSettingsRevisions'])['u1']), false);

echo "\n" . ($fail === 0 ? "全部通过\n" : "失败 $fail 项\n");
exit($fail === 0 ? 0 : 1);
