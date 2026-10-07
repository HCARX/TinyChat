<?php
/**
 * 拓展功能(在线浏览器 / AI 笔记 / 在线聊天)的统一可见性判定。
 *
 * 每个功能一组开关,语义固定为:
 *   <feat>Enabled   —— 全站总开关,关闭后对所有人(含管理员)不可见
 *   <feat>Access    —— 'all'(默认,所有人) | 'admin'(仅管理员) | 'list'(仅名单内)
 *   <feat>AccessUsers  —— 用户名名单,仅 access=list 时生效(管理员始终可用)
 *   <feat>AccessGroups —— 分组 id 名单,仅 access=list 时生效
 *
 * 三者关系是「且」:总开关开着 + 访问级别放行,功能才可见/可用。
 * 管理员不受 Access 名单限制 —— 否则管理员把自己关在门外就再也改不回来了。
 *
 * 服务端是真权威(每个功能的 guard 都调这里),前端只是照着隐藏入口;
 * 两侧读同一份判定结果,避免出现「入口看得见、点进去 403」。
 */

$TC_FEATURES = array('notes', 'im', 'web', 'toolbox');

function tc_feature_ids()
{
    return array('notes', 'im', 'web', 'toolbox');
}

// 一组默认值,供 $TC_SETTINGS_DEFAULTS 与 tc_normalize_settings 共用
function tc_feature_access_defaults()
{
    $out = array();
    foreach (tc_feature_ids() as $f) {
        $out[$f . 'Access'] = 'all';
        $out[$f . 'AccessUsers'] = array();
        $out[$f . 'AccessGroups'] = array();
    }
    return $out;
}

// 名单归一化:接受数组或「逗号/换行/顿号分隔」的字符串;去重、限量、去空白
function tc_feature_access_list($raw, $max = 200)
{
    if (is_string($raw)) {
        $raw = preg_split('/[\s,，、;；]+/u', $raw);
    } elseif (!is_array($raw)) {
        // 数字/布尔/null 之类不是名单,直接给空表。别依赖 (array) 的强制转换 ——
        // 那会把 123 变成 array(123),静默造出一个名叫 "123" 的名单项。
        return array();
    }
    $seen = array();
    $out = array();
    foreach ((array) $raw as $v) {
        $v = trim((string) $v);
        // tc_utf_cut 在 lib/api.php;core 早于 api 载入(本文件的调用点也覆盖启动期),
        // 所以这里做存在性保护,拿不到就退回 mb_substr/普通截断。
        if (strlen($v) > 64) {
            $v = function_exists('tc_utf_cut') ? tc_utf_cut($v, 64)
                : (function_exists('mb_substr') ? mb_substr($v, 0, 64, 'UTF-8') : substr($v, 0, 64));
        }
        if ($v === '' || isset($seen[$v])) continue;
        $seen[$v] = true;
        $out[] = $v;
        if (count($out) >= $max) break;
    }
    return $out;
}

// 访问级别归一化
function tc_feature_access_mode($raw)
{
    // 表单里手填的值常带前后空白("admin " 这种),不裁掉就会按非法值悄悄回落成 all ——
    // 管理员以为自己设了「仅管理员」,实际对所有人开放。只认小写白名单值,'ADMIN' 仍按非法处理。
    $raw = is_scalar($raw) ? trim((string) $raw) : '';
    return in_array($raw, array('all', 'admin', 'list'), true) ? $raw : 'all';
}

// 当前用户是否被允许使用某功能($db['settings'] 已归一化)
function tc_feature_allowed($db, $user, $feat)
{
    $ids = tc_feature_ids();
    if (!in_array((string) $feat, $ids, true)) return false;
    $s = isset($db['settings']) && is_array($db['settings']) ? $db['settings'] : array();
    $enabledKey = $feat . 'Enabled';
    // 与各功能 guard 保持一致的「默认开启」语义(旧库缺字段视为开启)
    if ($feat === 'notes') {
        if (empty($s[$enabledKey])) return false;
    } else {
        if (isset($s[$enabledKey]) && empty($s[$enabledKey])) return false;
    }
    // 在线浏览器多一个历史开关名:browserEnabled(设置里早已存在,前台 /api/config 下发的
    // 也是它)。两个开关必须都是「开」才放行 —— 否则后台关掉 browserEnabled、代理与票据却
    // 因为 webEnabled 仍是 true 而照常放行,界面上看起来关掉了其实没关。
    if ($feat === 'web' && array_key_exists('browserEnabled', $s) && empty($s['browserEnabled'])) return false;
    if (!empty($user['admin'])) return true;
    $mode = isset($s[$feat . 'Access']) ? tc_feature_access_mode($s[$feat . 'Access']) : 'all';
    if ($mode === 'admin') return false;
    if ($mode === 'all') return true;
    // list:用户名(大小写不敏感)或用户所属分组任一命中即放行
    $name = (string) (isset($user['name']) ? $user['name'] : '');
    $nl = function_exists('mb_strtolower') ? mb_strtolower($name, 'UTF-8') : strtolower($name);
    foreach ((array) (isset($s[$feat . 'AccessUsers']) ? $s[$feat . 'AccessUsers'] : array()) as $u) {
        $ul = function_exists('mb_strtolower') ? mb_strtolower((string) $u, 'UTF-8') : strtolower((string) $u);
        if ($ul !== '' && $ul === $nl) return true;
    }
    $groups = (array) (isset($s[$feat . 'AccessGroups']) ? $s[$feat . 'AccessGroups'] : array());
    if ($groups) {
        // tc_effective_group_id 在 lib/api.php;core 早于 api 载入,这里做存在性保护
        $gid = function_exists('tc_effective_group_id')
            ? (string) tc_effective_group_id($db, $user)
            : (string) (isset($user['groupId']) ? $user['groupId'] : '');
        if ($gid !== '' && in_array($gid, array_map('strval', $groups), true)) return true;
    }
    return false;
}

// 给前端的一份「本用户可用哪些功能」快照(供 /api/config 与 /api/me 下发)
function tc_features_public($db, $user)
{
    $out = array();
    foreach (tc_feature_ids() as $f) {
        $out[$f] = tc_feature_allowed($db, $user, $f);
    }
    return $out;
}
