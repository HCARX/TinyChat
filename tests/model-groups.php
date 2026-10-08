<?php
/**
 * 模型汇总自检: php tests/model-groups.php
 *
 * 锁住这套「多个渠道聚合成一个前台 ID」里最容易静默出错的三段:
 *   1) 同名自动汇总组的生成/清理:多了会凭空造出前台模型,少了则同名模型又变回两条;
 *   2) 候选渠道的过滤:必须以「用户自己的可见性与模型授权」为准 —— 少过滤一步就是越权,
 *      多过滤一步则是用户能用却被告知无渠道,两种都不会报错;
 *   3) 请求解析:整体开关关闭时必须与「没有这个功能」逐字节一致(不能再多做任何事)。
 * 另覆盖轮询游标的推进(跨进程文件计数)与开放 API 白名单判定。
 * 退出码非 0 表示失败,供 CI 使用。
 */
define('TC_ROOT', dirname(__DIR__));
$dataDir = sys_get_temp_dir() . '/tc-mgroups-' . bin2hex(random_bytes(4));
@mkdir($dataDir, 0777, true);
putenv('DATA_DIR=' . $dataDir);
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../lib/core.php';
require __DIR__ . '/../lib/api.php';
require __DIR__ . '/../lib/proxy.php';

$fail = 0;
$ok = function ($m) { echo "  ✓ $m\n"; };
$bad = function ($m) use (&$fail) { $fail++; echo "  ✗ $m\n"; };
$eq = function ($label, $got, $want) use ($ok, $bad) {
    if ($got === $want) $ok($label . ' = ' . var_export($want, true));
    else $bad($label . ': 期望 ' . var_export($want, true) . ', 实际 ' . var_export($got, true));
};
$check = function ($name, $cond, $detail = '') use ($ok, $bad) {
    if ($cond) $ok($name); else $bad($name . ($detail !== '' ? ' —— ' . $detail : ''));
};

// 造一个最小 db:两个全局渠道都有 gpt-4o(用来触发同名汇总)、各有一个独占模型;
// 另有一个停用渠道也带 gpt-4o(不该进入候选)。
// - 默认组 g-default 对两个渠道全放行;
// - VIP 组只能访问渠道一(p1)的全部 + 渠道二(p2)的 only-b(没有 p2 的 gpt-4o),
//   用来验证「候选按模型授权过滤」。
$mkProvider = function ($id, $name, $order, $cost, $models, $enabled = true) {
    return array(
        'id' => $id, 'name' => $name, 'baseUrl' => 'https://' . $id . '.example/v1',
        'apiFormat' => 'chat', 'scope' => 'global', 'ownerId' => null, 'enabled' => $enabled,
        'order' => $order, 'costPerCall' => $cost, 'models' => $models,
    );
};
$db = array(
    'users' => array(
        array('id' => 'u-plain', 'name' => 'Plain', 'admin' => false, 'groupId' => 'g-default'),
        array('id' => 'u-vip', 'name' => 'Vip', 'admin' => false, 'groupId' => 'g-vip'),
        array('id' => 'u-admin', 'name' => 'Admin', 'admin' => true, 'groupId' => 'g-admin'),
    ),
    'userGroups' => array(
        array('id' => 'g-admin', 'name' => '管理员', 'role' => 'admin'),
        array('id' => 'g-default', 'name' => '默认用户组', 'role' => 'user'),
        array('id' => 'g-vip', 'name' => 'VIP', 'role' => 'user'),
    ),
    'providers' => array(
        $mkProvider('p1', '渠道一', 0, 1, array(array('id' => 'gpt-4o'), array('id' => 'only-a'))),
        $mkProvider('p2', '渠道二', 1, 3, array(array('id' => 'gpt-4o'), array('id' => 'only-b'))),
        $mkProvider('p3', '停用渠道', 2, 1, array(array('id' => 'gpt-4o')), false),
    ),
    'accessRules' => array(
        array('groupId' => 'g-default', 'providerId' => 'p1', 'modelIds' => array('*')),
        array('groupId' => 'g-default', 'providerId' => 'p2', 'modelIds' => array('*')),
        array('groupId' => 'g-vip', 'providerId' => 'p1', 'modelIds' => array('*')),
        array('groupId' => 'g-vip', 'providerId' => 'p2', 'modelIds' => array('only-b')),
    ),
    'settings' => array('modelAggEnabled' => false),
    'modelGroups' => array(),
    'modelMeta' => array(),
);
$plain = $db['users'][0];
$vip = $db['users'][1];
$admin = $db['users'][2];

echo "== 1. 汇总 ID 归一化 ==\n";
$g = tc_normalize_model_group(array('id' => '  Fast-Chat  ', 'label' => '极速', 'strategy' => 'roundrobin', 'members' => array(
    array('providerId' => 'p1', 'model' => 'gpt-4o'),
    array('providerId' => 'p1', 'model' => 'gpt-4o'),
    array('providerId' => 'p2', 'model' => ''),
    array('providerId' => '', 'model' => 'x'),
    array('providerId' => 'p2', 'model' => 'gpt-4o-mini'),
)));
$eq('ID 去空白保留原大小写', $g['id'], 'Fast-Chat');
$eq('小写匹配键', tc_model_group_key($g['id']), 'fast-chat');
$eq('成员去重且剔除空项', count($g['members']), 2);
$eq('策略', $g['strategy'], 'roundrobin');
$eq('未知策略回退 failover', tc_normalize_model_group(array('id' => 'x', 'strategy' => 'nope'))['strategy'], 'failover');
$eq('cost 留空为 null', $g['cost'], null);
$eq('cost 数值化', tc_normalize_model_group(array('id' => 'x', 'cost' => '2.5'))['cost'], 2.5);
$eq('空 ID 被丢弃', tc_normalize_model_group(array('id' => '   ')), null);
$eq('整表去重', count(tc_normalize_model_groups(array(
    array('id' => 'a'), array('id' => 'A'), array('id' => 'b'),
))), 2);

echo "== 2. 同名自动汇总:生成 / 清理 / 不动手工组 ==\n";
$work = $db;
$work['settings']['modelAggEnabled'] = true;
$work['modelGroups'] = array(
    tc_normalize_model_group(array('id' => 'my-manual', 'members' => array(array('providerId' => 'p1', 'model' => 'only-a')))),
);
$res = tc_model_groups_sync_auto($work);
$eq('新增同名组数', $res['added'], 1);
$byId = array();
foreach ($work['modelGroups'] as $x) $byId[$x['id']] = $x;
$check('生成了 gpt-4o 汇总组', isset($byId['gpt-4o']));
$check('gpt-4o 组是 auto 且 matchId 指向模型名', !empty($byId['gpt-4o']['auto']) && $byId['gpt-4o']['matchId'] === 'gpt-4o');
$check('only-a 只有一个渠道,不生成汇总组', !isset($byId['only-a']));
$check('手工组保留', isset($byId['my-manual']) && empty($byId['my-manual']['auto']));
$eq('重复调用幂等(不再新增)', tc_model_groups_sync_auto($work)['added'], 0);
// 渠道改名后同名不再成立 -> auto 组应被清掉,手工组不动。
// 注意用副本:后面几节都要用「两个渠道都有 gpt-4o」的原始配置。
$renamed = $work;
$renamed['providers'][1]['models'] = array(array('id' => 'gpt-4o-mini'), array('id' => 'only-b'));
$res2 = tc_model_groups_sync_auto($renamed);
$eq('同名消失后清理 auto 组', $res2['removed'], 1);
$check('手工组仍在', count($renamed['modelGroups']) === 1 && $renamed['modelGroups'][0]['id'] === 'my-manual');
// 停用渠道不算数:只剩一个启用渠道时同样要清理
$onlyDisabled = $work;
$onlyDisabled['providers'][1]['enabled'] = false;
$check('仅剩停用渠道的同名也清理', tc_model_groups_sync_auto($onlyDisabled)['removed'] === 1);

echo "== 3. 候选解析:按可见性与模型授权过滤 ==\n";
$g4o = tc_model_group_find($work, 'gpt-4o', false);
$check('能找到 gpt-4o 组(即使总开关未开)', $g4o !== null);
list($cands, $err) = tc_model_group_candidates($work, $plain, $g4o);
$eq('默认组:无错误', $err, '');
$eq('默认组:候选数(停用渠道已排除)', count($cands), 2);
$eq('默认组:候选顺序=渠道 order', $cands[0]['providerId'], 'p1');
$eq('默认组:候选的上游模型名', $cands[0]['model'], 'gpt-4o');
list($vipCands, $vipErr) = tc_model_group_candidates($work, $vip, $g4o);
$eq('VIP 未授权 p2 的 gpt-4o,候选只剩 p1', count($vipCands), 1);
$eq('VIP 候选渠道', $vipCands[0]['providerId'], 'p1');
// 手工组指向一个渠道里已不存在的模型 -> 没有可用渠道
$manual = tc_model_group_find($work, 'my-manual', false);
$work2 = $work;
$work2['providers'][0]['models'] = array(array('id' => 'gpt-4o'), array('id' => 'gpt-4o-mini'));
list($none, $noneErr) = tc_model_group_candidates($work2, $plain, $manual);
$check('成员模型已从渠道消失时报错而不是给空候选', $none === array() && $noneErr !== '');

echo "== 4. 轮询游标:跨调用推进且不越界 ==\n";
$rr = tc_normalize_model_group(array('id' => 'rr-test', 'strategy' => 'roundrobin'));
$seq = array();
for ($i = 0; $i < 5; $i++) $seq[] = tc_model_group_rr_next($rr['id'], 3);
$eq('起点在 0..2 之间且逐个推进', $seq, array(0, 1, 2, 0, 1));
$eq('只有一个候选时恒为 0', tc_model_group_rr_next('rr-test', 1), 0);
// 轮询组解析出来的候选应随游标轮转(候选顺序跟着转)
$rrGroup = tc_model_group_find($work, 'gpt-4o', false);
$rrGroup['id'] = 'rr-order';
$rrGroup['strategy'] = 'roundrobin';
$firstByRound = array();
for ($i = 0; $i < 4; $i++) {
    list($c, $e) = tc_model_group_candidates($work, $plain, $rrGroup);
    $firstByRound[] = $c[0]['providerId'];
}
$eq('轮询:首选渠道在两个渠道之间轮转', $firstByRound, array('p1', 'p2', 'p1', 'p2'));

echo "== 5. 成员键集合:用于把被汇总的原始模型从列表里摘掉 ==\n";
$keysOn = tc_model_group_member_keys($work, $plain);
$check('p1|gpt-4o 被收录', isset($keysOn['p1|gpt-4o']));
$check('p2|gpt-4o 被收录', isset($keysOn['p2|gpt-4o']));
$check('手工组的成员 only-a 也被收录(它同样不该在前台单独出现)', isset($keysOn['p1|only-a']));
$check('任何汇总都没覆盖的 only-b 不在集合里', !isset($keysOn['p2|only-b']));
$workOff = $work;
$workOff['settings']['modelAggEnabled'] = false;
$eq('总开关关闭时集合为空(前台完全按原样)', tc_model_group_member_keys($workOff, $plain), array());

echo "== 6. 请求解析:命中汇总 ID 时展开成候选渠道 ==\n";
$on = $work;
$on['settings']['modelAggEnabled'] = true;
$r = tc_resolve_provider($on, $plain, array('model' => 'gpt-4o'));
$check('解析成功且带回候选', empty($r['error']) && !empty($r['candidates']));
$eq('候选数量', count($r['candidates']), 2);
$eq('首选渠道', $r['candidates'][0]['providerId'], 'p1');
$eq('组 ID 回传', $r['group']['id'], 'gpt-4o');
// 大小写不敏感:请求写 GPT-4O 也应命中同一个组
$r2 = tc_resolve_provider($on, $plain, array('model' => 'GPT-4O'));
$check('ID 匹配不区分大小写', empty($r2['error']) && $r2['candidates'][0]['providerId'] === 'p1');
// 前台合成供应商的 providerId 形态(agg:<组ID>)
$r3 = tc_resolve_provider($on, $plain, array('providerId' => 'agg:gpt-4o', 'model' => 'gpt-4o'));
$check('agg: 前缀的 providerId 也能展开', empty($r3['error']) && count($r3['candidates']) === 2);
// 总开关关闭:必须与没有这个功能时逐字节一致 —— 仍按真实供应商解析,不带候选
$off = $work;
$off['settings']['modelAggEnabled'] = false;
$r4 = tc_resolve_provider($off, $plain, array('model' => 'gpt-4o'));
$check('总开关关闭时不展开候选', empty($r4['error']) && !isset($r4['candidates']));
$eq('总开关关闭时按原逻辑命中 p1', $r4['provider']['id'], 'p1');
// 汇总组没有任何可用渠道 -> 明确的错误提示,不是静默落到别的渠道
$noChan = $on;
$noChan['providers'] = array($mkProvider('p9', '别家', 0, 1, array(array('id' => 'other'))));
$r5 = tc_resolve_provider($noChan, $plain, array('model' => 'gpt-4o'));
$check('无可用渠道时返回错误', !empty($r5['error']));

echo "== 7. 开放 API 白名单:汇总 ID 的暴露判定 ==\n";
$g4o = tc_model_group_find($on, 'gpt-4o', false);
$check('白名单为空时一律放行', tc_api_group_exposed(array('apiExposedModels' => array()), $on, $g4o) === true);
$check('显式开放 agg|<组ID> 时放行', tc_api_group_exposed(array('apiExposedModels' => array('agg|gpt-4o')), $on, $g4o) === true);
$check('组内任一成员被开放即放行(存量白名单不必重配)', tc_api_group_exposed(array('apiExposedModels' => array('p2|gpt-4o')), $on, $g4o) === true);
$check('只有无关模型被开放时拒绝', tc_api_group_exposed(array('apiExposedModels' => array('p1|only-a')), $on, $g4o) === false);
$manualWork = $on;
$manualWork['providers'][0]['models'] = array(array('id' => 'gpt-4o'), array('id' => 'only-a'));
$manualGroup = tc_normalize_model_group(array('id' => 'combo', 'members' => array(array('providerId' => 'p1', 'model' => 'only-a'))));
$check('手工组:成员被开放即放行', tc_api_group_exposed(array('apiExposedModels' => array('p1|only-a')), $manualWork, $manualGroup) === true);
$check('手工组:成员都未开放时拒绝', tc_api_group_exposed(array('apiExposedModels' => array('p1|gpt-4o')), $manualWork, $manualGroup) === false);

echo "== 8. 前台归类:汇总项不因名字被误分到生图/生视频 ==\n";
$imgProvider = $mkProvider('p4', '图床', 3, 1, array(array('id' => 'gpt-image-1', 'image' => true), array('id' => 'gpt-image-1')));
$imgDb = $db;
$imgDb['providers'][] = $imgProvider;
$ag = tc_normalize_model_group(array('id' => 'gpt-image-1', 'auto' => true, 'matchId' => 'gpt-image-1'));
list($ai, $av) = tc_model_group_media_kind($ag, array());
$check('渠道里标了 image 的同名汇总归到生图', $ai === true && $av === false);
$manualImg = tc_normalize_model_group(array('id' => 'whatever', 'image' => true));
list($mi, $mv) = tc_model_group_media_kind($manualImg, array());
$check('手工显式标 image 时归到生图', $mi === true && $mv === false);
$manualChat = tc_normalize_model_group(array('id' => 'gpt-4o-daily', 'label' => 'gpt-4o-daily'));
list($ci, $cv) = tc_model_group_media_kind($manualChat, array());
$check('普通名字默认归到对话', $ci === false && $cv === false);

echo "\n" . ($fail === 0 ? "全部通过\n" : "$fail 项失败\n");
exit($fail === 0 ? 0 : 1);
