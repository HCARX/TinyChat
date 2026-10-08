<?php
require_once __DIR__ . '/core.php';

function tc_provider_enabled($p) {
    return !isset($p['enabled']) || !empty($p['enabled']);
}

// 供应商排序:显式 order 优先,缺失/相同时按数组原始顺序稳定排列。
// 前台模型选择器、供应商列表都按这个顺序展示。
function tc_provider_order($p) {
    return (isset($p['order']) && is_numeric($p['order'])) ? (int) $p['order'] : PHP_INT_MAX;
}
function tc_sort_providers($list) {
    // 用带原始下标的稳定排序:order 相同时保持原顺序
    $pairs = array();
    foreach (array_values($list) as $i => $p) $pairs[] = array($i, $p);
    usort($pairs, function ($a, $b) {
        $oa = tc_provider_order($a[1]);
        $ob = tc_provider_order($b[1]);
        if ($oa === $ob) return $a[0] - $b[0];
        return $oa < $ob ? -1 : 1;
    });
    $out = array();
    foreach ($pairs as $pr) $out[] = $pr[1];
    return $out;
}
// 下一个可用排序值(新增供应商时排到末尾)
function tc_next_provider_order($db) {
    $max = -1;
    foreach ((isset($db['providers']) ? $db['providers'] : array()) as $p) {
        $o = tc_provider_order($p);
        if ($o !== PHP_INT_MAX && $o > $max) $max = $o;
    }
    return $max + 1;
}

function tc_visible_providers_of($db, $user) {
    $out = array();
    foreach ($db['providers'] as $p) {
        // 被管理员停用的供应商对所有用户不可见(后台管理列表除外)
        if (!tc_provider_enabled($p)) continue;
        if ((isset($p['scope']) && $p['scope'] === 'global') || (isset($p['ownerId']) && $p['ownerId'] === $user['id'])) {
            $out[] = $p;
        }
    }
    return tc_sort_providers($out);
}

function tc_effective_group_id($db, $user) {
    if (!empty($user['admin'])) {
        $admin = tc_find_builtin_group($db, 'admin');
        if ($admin && !empty($admin['id'])) return (string) $admin['id'];
    }
    $gid = isset($user['groupId']) ? (string) $user['groupId'] : '';
    if ($gid !== '' && tc_group_by_id($db, $gid)) return $gid;
    return tc_default_register_group($db);
}

function tc_user_access($db, $user) {
    $allowed = array();
    foreach ($db['providers'] as $p) {
        if (isset($p['ownerId']) && $p['ownerId'] === $user['id']) $allowed[$p['id']] = null;
    }
    // 管理员固定走管理员组；普通用户走自己的组，没有组时用注册默认组。
    $groupId = tc_effective_group_id($db, $user);
    if ($groupId) {
        foreach ($db['accessRules'] as $r) {
            if ($r['groupId'] !== $groupId) continue;
            $exists = false;
            foreach ($db['providers'] as $x) if ($x['id'] === $r['providerId']) { $exists = true; break; }
            if (!$exists) continue;
            $ids = isset($r['modelIds']) && is_array($r['modelIds']) ? $r['modelIds'] : array();
            if (!$ids || in_array('*', $ids, true)) {
                if (!array_key_exists($r['providerId'], $allowed)) $allowed[$r['providerId']] = null;
                continue;
            }
            $set = (isset($allowed[$r['providerId']]) && is_array($allowed[$r['providerId']]))
                ? $allowed[$r['providerId']] : array();
            foreach ($ids as $m) $set[$m] = true;
            $allowed[$r['providerId']] = $set;
        }
    }
    return $allowed;
}

function tc_visible_provider($user, $provider, $allowed) {
    if (!array_key_exists($provider['id'], $allowed)) return null;
    $set = $allowed[$provider['id']];
    if ($set === null) return $provider;
    $models = array();
    foreach ((isset($provider['models']) ? $provider['models'] : array()) as $m) {
        if (isset($set[$m['id']])) $models[] = $m;
    }
    if (!$models) return null;
    $copy = $provider;
    $copy['models'] = $models;
    return $copy;
}

// 汇总组的「成员键」集合:providerId|modelId。用于把已被汇总的原始模型从
// 供应商列表里摘掉(前台只显示汇总 ID),以及判断某个渠道的某条模型是否已被收纳。
// 复用的是同一套可见性判定,因此集合天然只含该用户有权访问的渠道/模型。
function tc_model_group_member_keys($db, $user, $groups = null) {
    $keys = array();
    if (!tc_model_groups_on($db)) return $keys;
    if ($groups === null) $groups = tc_model_groups_ordered($db);
    $allowed = tc_user_access($db, $user);
    $visible = array();
    foreach (tc_visible_providers_of($db, $user) as $p) $visible[(string) $p['id']] = $p;
    foreach ($groups as $g) {
        if (!is_array($g)) continue;
        if (!empty($g['auto'])) {
            // 自动组:所有可见渠道里同名的那一条
            $match = (string) (isset($g['matchId']) && $g['matchId'] !== '' ? $g['matchId'] : $g['id']);
            if ($match === '') continue;
            foreach ($visible as $pid => $p) {
                foreach ((isset($p['models']) ? $p['models'] : array()) as $m) {
                    if (is_array($m) && isset($m['id']) && (string) $m['id'] === $match) $keys[$pid . '|' . $match] = true;
                }
            }
            continue;
        }
        foreach ((isset($g['members']) && is_array($g['members']) ? $g['members'] : array()) as $m) {
            $pid = (string) (isset($m['providerId']) ? $m['providerId'] : '');
            $mid = (string) (isset($m['model']) ? $m['model'] : '');
            if ($pid !== '' && $mid !== '') $keys[$pid . '|' . $mid] = true;
        }
    }
    return $keys;
}

// 汇总组 -> 候选渠道列表。返回 array(候选, 错误信息)。
// 候选元素:{provider(可见副本,含加密密钥,供 tc_provider_key_chain 取密钥链),
//            providerId, providerName, model(上游模型名)}
// 成员必须同时满足「渠道对该用户可见」与「渠道里确实还有该模型」,否则跳过 ——
// 于是停用的渠道、用户组未被授权的模型都不会进入候选,故障转移只在有权渠道间发生。
function tc_model_group_candidates($db, $user, $group) {
    if (!is_array($group)) return array(array(), '汇总模型不存在');
    $allowed = tc_user_access($db, $user);
    $visible = array();
    foreach (tc_visible_providers_of($db, $user) as $p) $visible[(string) $p['id']] = $p;
    $pairs = array();
    if (!empty($group['auto'])) {
        $match = (string) (isset($group['matchId']) && $group['matchId'] !== '' ? $group['matchId'] : $group['id']);
        foreach ($visible as $pid => $p) {
            foreach ((isset($p['models']) ? $p['models'] : array()) as $m) {
                if (is_array($m) && isset($m['id']) && (string) $m['id'] === $match) $pairs[] = array($pid, $match);
            }
        }
    } else {
        foreach ((isset($group['members']) && is_array($group['members']) ? $group['members'] : array()) as $m) {
            $pairs[] = array((string) (isset($m['providerId']) ? $m['providerId'] : ''), (string) (isset($m['model']) ? $m['model'] : ''));
        }
    }
    $out = array();
    foreach ($pairs as $pair) {
        list($pid, $mid) = $pair;
        if ($pid === '' || $mid === '' || !isset($visible[$pid])) continue;
        $vis = tc_visible_provider($user, $visible[$pid], $allowed);
        if (!$vis) continue;
        $found = false;
        foreach ((isset($vis['models']) ? $vis['models'] : array()) as $vm) {
            if (is_array($vm) && isset($vm['id']) && (string) $vm['id'] === $mid) { $found = true; break; }
        }
        if (!$found) continue;
        $out[] = array(
            'provider' => $vis,
            'providerId' => $pid,
            'providerName' => (string) (isset($visible[$pid]['name']) ? $visible[$pid]['name'] : ''),
            'model' => $mid,
        );
        if (count($out) >= TC_MODEL_GROUP_MEMBERS_MAX) break;
    }
    if (!$out) return array(array(), '汇总模型「' . (string) $group['id'] . '」当前没有可用渠道');
    // 轮询:让起点在候选间轮转(游标是跨进程的文件计数,见 tc_model_group_rr_next)
    if ((isset($group['strategy']) ? $group['strategy'] : 'failover') === 'roundrobin') {
        $start = tc_model_group_rr_next($group['id'], count($out));
        if ($start > 0) $out = array_merge(array_slice($out, $start), array_slice($out, 0, $start));
    }
    return array($out, '');
}

// $demo=true 用于演示管理员:供应商密钥连掩码都不下发(掩码仍会泄露密钥长度与首尾字符),
// 前端拿到空的 apiKey/keys 即按「沿用原有密钥」处理,不影响演示里改配置的体验。
function tc_client_provider($p, $owner = false, $admin = false, $demo = false) {
    $key = tc_provider_key($p);
    $showKey = ($owner || $admin) && !$demo;
    return array(
        'id' => $p['id'],
        'name' => $p['name'],
        'baseUrl' => $p['baseUrl'],
        'apiFormat' => isset($p['apiFormat']) ? $p['apiFormat'] : 'chat',
        'models' => isset($p['models']) ? $p['models'] : array(),
        'costPerCall' => tc_provider_cost($p),
        'billingMode' => isset($p['billingMode']) && $p['billingMode'] === 'token' ? 'token' : 'call',
        'pricePer1k' => isset($p['pricePer1k']) && is_numeric($p['pricePer1k']) ? (float) $p['pricePer1k'] : 0,
        'scope' => isset($p['scope']) ? $p['scope'] : 'user',
        'enabled' => tc_provider_enabled($p),
        'ownerId' => isset($p['ownerId']) ? $p['ownerId'] : null,
        'mine' => $owner,
        'order' => isset($p['order']) && is_numeric($p['order']) ? (int) $p['order'] : 0,
        // 密钥只以掩码形式下发给属主或管理员;其他用户(含演示管理员)不回传任何密钥信息
        'apiKey' => $showKey && $key ? tc_mask_key($key) : '',
        'hasKey' => !!$key,
        // 多密钥:仅属主/管理员可见(含掩码),供前端渲染密钥编辑器与模型绑定列
        'keys' => $showKey ? array_map(function ($k) use ($p) {
            $plain = tc_provider_key_by_id($p, (string) $k['id']);
            return array(
                'id' => (string) $k['id'],
                'name' => (string) $k['name'],
                'apiKey' => $plain !== '' ? tc_mask_key($plain) : '',
                'hasKey' => $plain !== '',
            );
        }, tc_provider_keys($p)) : array(),
        'keyRevealable' => $showKey ? !empty($p['keyRevealable']) : false,
        'createdAt' => isset($p['createdAt']) ? $p['createdAt'] : null,
        'updatedAt' => isset($p['updatedAt']) ? $p['updatedAt'] : (isset($p['createdAt']) ? $p['createdAt'] : null),
    );
}

function tc_get_default_provider($db, $user, $list) {
    if (!empty($db['defaultProviderId'])) {
        foreach ($list as $p) if ($p['id'] === $db['defaultProviderId']) return $p;
    }
    foreach ($list as $p) if (isset($p['scope']) && $p['scope'] === 'global') return $p;
    foreach ($list as $p) if (isset($p['ownerId']) && $p['ownerId'] === $user['id']) return $p;
    return $list ? $list[0] : null;
}

function tc_resolve_provider($db, $user, $body) {
    $providerId = isset($body['providerId']) ? $body['providerId'] : null;
    $wantModel = trim((string) (isset($body['model']) ? $body['model'] : ''));
    $list = tc_visible_providers_of($db, $user);
    $allowed = tc_user_access($db, $user);
    // 模型汇总:请求命中某个启用中的汇总组时,先展开成候选渠道列表再返回。
    // 判定优先级高于「按真实模型名找供应商」—— 同名自动汇总正是靠这一步把多个渠道的
    // 同名模型收敛到同一个 ID 上。前台合成供应商的 providerId 形如 agg:<组ID>,一并接受。
    if (tc_model_groups_on($db)) {
        $group = $wantModel !== '' ? tc_model_group_find($db, $wantModel) : null;
        if (!$group && is_string($providerId) && strncmp($providerId, 'agg:', 4) === 0) {
            $group = tc_model_group_find($db, substr($providerId, 4));
        }
        if ($group) {
            list($candidates, $groupErr) = tc_model_group_candidates($db, $user, $group);
            if ($groupErr !== '') return array('error' => $groupErr);
            $out = array();
            foreach ($candidates as $c) {
                $cp = $c['provider'];
                if (isset($cp['apiKey'])) $cp['apiKey'] = tc_provider_key_for_model($c['provider'], $c['model']);
                $out[] = array(
                    'provider' => $cp,
                    'providerId' => $c['providerId'],
                    'providerName' => $c['providerName'],
                    'model' => $c['model'],
                );
            }
            return array(
                'provider' => $out[0]['provider'],
                'providerFull' => $candidates[0]['provider'],
                'group' => $group,
                'candidates' => $out,
            );
        }
    }
    $target = null;
    if ($providerId) {
        foreach ($list as $x) if ($x['id'] === $providerId) { $target = $x; break; }
        if (!$target) {
            foreach ($db['providers'] as $x) if ($x['id'] === $providerId) { if (!tc_provider_enabled($x)) return array('error' => '该供应商已被管理员停用'); break; }
            return array('error' => '指定的供应商不存在或无权访问');
        }
    } elseif ($wantModel !== '') {
        // 未指定供应商但给了模型:优先挑出确实拥有该模型的可见供应商。
        // 生图/开放接口调用常只带 model,靠这一步才能命中正确的供应商而不是默认那一个。
        foreach ($list as $x) {
            foreach ((isset($x['models']) ? $x['models'] : array()) as $m) {
                if (is_array($m) && isset($m['id']) && (string) $m['id'] === $wantModel) { $target = $x; break 2; }
            }
        }
        if (!$target) $target = tc_get_default_provider($db, $user, $list);
    } else {
        $target = tc_get_default_provider($db, $user, $list);
    }
    if (!$target) return array('error' => '没有可用供应商，请联系管理员配置，或在「设置 → 供应商」中添加自己的 API');
    $vis = tc_visible_provider($user, $target, $allowed);
    if (!$vis) return array('error' => '当前用户组无权访问该供应商或模型');
    if (isset($allowed[$target['id']]) && is_array($allowed[$target['id']])) {
        $reqModel = isset($body['model']) ? $body['model'] : (isset($vis['models'][0]['id']) ? $vis['models'][0]['id'] : null);
        if ($reqModel) {
            $ok = false;
            foreach ($vis['models'] as $m) if ($m['id'] === $reqModel) { $ok = true; break; }
            if (!$ok) return array('error' => '当前用户组无权使用模型 ' . $reqModel);
        }
    }
    // 代理请求需要明文 Key 访问上游;按「本次请求的模型」选用对应密钥
    // (多 Key 供应商下,模型可能绑定到不同的 Key),解密仅存于服务端内存。
    if (isset($vis['apiKey'])) {
        $keyModel = isset($body['model']) ? (string) $body['model'] : '';
        if ($keyModel === '' && isset($vis['models'][0]['id'])) $keyModel = (string) $vis['models'][0]['id'];
        $vis['apiKey'] = tc_provider_key_for_model($target, $keyModel);
    }
    return array('provider' => $vis, 'providerFull' => $target);
}

function tc_normalize_models($models) {
    if (!is_array($models)) return array();
    $out = array();
    $seen = array();
    foreach ($models as $m) {
        $id = '';
        if (is_array($m)) $id = trim((string) (isset($m['id']) ? $m['id'] : (isset($m['name']) ? $m['name'] : '')));
        if ($id === '' || isset($seen[$id])) continue;
        $seen[$id] = true;
        $name = is_array($m) && !empty($m['name']) ? trim((string) $m['name']) : $id;
        $row = array('id' => $id, 'name' => $name ?: $id);
        // 输出上限与上下文窗口不在此配置:统一由「模型元数据」表按模型名提供
        // (模型清单接口会带上表里的值;未匹配时由该接口用兜底常量补,并标记待复核)。
        // 生图模型标记(可选):true/false 显式声明;缺省时由模型名启发式判断(tc_model_is_image)
        if (is_array($m) && array_key_exists('image', $m)) {
            $row['image'] = !empty($m['image']);
        }
        // 视频模型标记(可选):true/false 显式声明;缺省时由模型名启发式判断(tc_model_is_video)
        if (is_array($m) && array_key_exists('video', $m)) {
            $row['video'] = !empty($m['video']);
        }
        // 单次调用扣减次数(可选):留空表示跟随供应商的「每次调用扣费次数」
        if (is_array($m) && isset($m['cost']) && $m['cost'] !== '' && is_numeric($m['cost'])) {
            $row['cost'] = max(0, min(1000, (float) $m['cost']));
        }
        // 绑定的密钥链(可选):多 Key 供应商下,该模型按优先级依次尝试这些 Key
        if (is_array($m) && isset($m['keyIds']) && is_array($m['keyIds'])) {
            $chain = array();
            foreach ($m['keyIds'] as $kid) {
                $kid = substr(trim((string) $kid), 0, 40);
                if ($kid !== '' && !in_array($kid, $chain, true)) $chain[] = $kid;
            }
            if ($chain) $row['keyIds'] = $chain;
        }
        // 兼容单个 keyId:并入链
        if (is_array($m) && isset($m['keyId']) && trim((string) $m['keyId']) !== '') {
            $kid = substr(trim((string) $m['keyId']), 0, 40);
            if (empty($row['keyIds']) || !in_array($kid, $row['keyIds'], true)) {
                $row['keyIds'] = array_merge(isset($row['keyIds']) ? $row['keyIds'] : array(), array($kid));
            }
        }
        if (!empty($row['keyIds'])) $row['keyId'] = $row['keyIds'][0];   // 主密钥=优先级最高的一把
        $out[] = $row;
        if (count($out) >= 500) break;
    }
    return $out;
}

function tc_normalize_provider_input($b, $base = array(), $demo = false) {
    $p = $base;
    if (array_key_exists('name', $b)) $p['name'] = substr(trim((string) $b['name']), 0, 60);
    if (array_key_exists('baseUrl', $b)) $p['baseUrl'] = rtrim(trim((string) $b['baseUrl']), '/');
    // 密钥字段的取舍:留空或仍是掩码一律表示「不修改」,保留原值(可能是密文)。
    // 演示管理员的接口本就不下发密钥,前端编辑后提交的是空 keys —— 空提交会清掉已有密钥,
    // 所以这整段要跳过。但「跳过」得看他这次到底有没有带来新明文:演示管理员新增供应商时
    // 是手打了一把 Key 的,连它一起跳过就会以「API Key 不能为空」告终(用户明明填了)。
    // 因此只有「演示身份 + 本次没带任何新明文」才跳过;带了新明文就照常收下。
    $hasNewPlain = false;
    if (array_key_exists('apiKey', $b)) {
        $k = trim((string) $b['apiKey']);
        if ($k !== '' && strpos($k, '••') === false) $hasNewPlain = true;
    }
    if (array_key_exists('keys', $b) && is_array($b['keys'])) {
        foreach ($b['keys'] as $k) {
            if (!is_array($k)) continue;
            $plain = isset($k['apiKey']) ? trim((string) $k['apiKey']) : '';
            if ($plain !== '' && strpos($plain, '••') === false) { $hasNewPlain = true; break; }
        }
    }
    $skipKeys = $demo && !$hasNewPlain;
    if (!$skipKeys && array_key_exists('apiKey', $b)) {
        $key = trim((string) $b['apiKey']);
        // 留空或仍是掩码表示「不修改密钥」,保留原值(可能是密文)
        if ($key !== '' && strpos($key, '••') === false) $p['apiKey'] = $key;
    }
    // 多密钥:keys = [{id,name,apiKey}],apiKey 留空/掩码表示沿用原有密文
    if (!$skipKeys && array_key_exists('keys', $b) && is_array($b['keys'])) {
        $prevKeys = array();
        foreach (tc_provider_keys($p) as $k) $prevKeys[(string) $k['id']] = $k;
        $next = array();
        $usedIds = array();
        foreach ($b['keys'] as $i => $k) {
            if (!is_array($k)) continue;
            $id = substr(trim((string) (isset($k['id']) ? $k['id'] : '')), 0, 40);
            if ($id === '' || isset($usedIds[$id])) $id = 'k' . substr(hash('sha256', $id . '#' . $i . '#' . microtime(true)), 0, 8);
            $usedIds[$id] = true;
            $name = substr(trim((string) (isset($k['name']) ? $k['name'] : '')), 0, 40);
            $plain = isset($k['apiKey']) ? trim((string) $k['apiKey']) : '';
            $enc = '';
            if ($plain !== '' && strpos($plain, '••') === false) {
                $tmp = array('id' => isset($p['id']) ? $p['id'] : '', 'ownerId' => isset($p['ownerId']) ? $p['ownerId'] : '');
                $enc = tc_encrypt_secret($plain, tc_provider_key_aad($tmp));
                if ($enc === false) $enc = '';
            } elseif (isset($prevKeys[$id])) {
                $enc = (string) $prevKeys[$id]['apiKey'];   // 沿用旧密文
            }
            if ($enc === '') continue;                        // 既无新明文也无旧密文:丢弃空 Key
            $next[] = array('id' => $id, 'name' => $name, 'apiKey' => $enc);
        }
        $err = tc_provider_keys_error($next);
        if ($err !== '') tc_fail(400, $err);
        $p['keys'] = $next;
        // 保留一把主 Key(兼容旧字段与「未绑定模型」的默认回退)
        $p['apiKey'] = $next ? (string) $next[0]['apiKey'] : '';
    }
    if (array_key_exists('keyRevealable', $b)) $p['keyRevealable'] = !empty($b['keyRevealable']);
    if (array_key_exists('enabled', $b)) $p['enabled'] = !empty($b['enabled']);
    if (array_key_exists('apiFormat', $b) && in_array($b['apiFormat'], array('chat', 'responses', 'completions', 'anthropic', 'video'), true)) {
        $p['apiFormat'] = $b['apiFormat'];
    }
    if (array_key_exists('costPerCall', $b)) $p['costPerCall'] = max(0, min(1000, (float) $b['costPerCall']));
    // 计费模式:call=按次(默认,costPerCall);token=按千 token(pricePer1k,用量缺失时回退按次)
    if (array_key_exists('billingMode', $b) && in_array($b['billingMode'], array('call', 'token'), true)) {
        $p['billingMode'] = $b['billingMode'];
    }
    if (array_key_exists('pricePer1k', $b)) $p['pricePer1k'] = max(0, min(1000, (float) $b['pricePer1k']));
    // 排序值:前台供应商/模型列表按此升序展示;不传则保持原值(新增时由调用方补末尾值)
    if (array_key_exists('order', $b) && is_numeric($b['order'])) $p['order'] = (int) $b['order'];
    if (array_key_exists('models', $b)) {
        $p['models'] = tc_normalize_models($b['models']);
        // 模型绑定的密钥必须在供应商的密钥列表里,否则清掉(回退默认密钥)
        $validIds = array();
        foreach (tc_provider_keys($p) as $k) $validIds[(string) $k['id']] = true;
        foreach ($p['models'] as &$mm) {
            if (isset($mm['keyIds']) && is_array($mm['keyIds'])) {
                $keep = array();
                foreach ($mm['keyIds'] as $kid) if (isset($validIds[(string) $kid])) $keep[] = (string) $kid;
                if ($keep) { $mm['keyIds'] = $keep; $mm['keyId'] = $keep[0]; }
                else { unset($mm['keyIds']); unset($mm['keyId']); }
            } elseif (isset($mm['keyId'])) {
                if (!isset($validIds[(string) $mm['keyId']])) unset($mm['keyId']);
            }
        }
        unset($mm);
    }
    if (empty($p['apiFormat'])) $p['apiFormat'] = 'chat';
    if (!isset($p['costPerCall']) || !is_numeric($p['costPerCall'])) $p['costPerCall'] = 1;
    if (!isset($p['billingMode']) || !in_array($p['billingMode'], array('call', 'token'), true)) $p['billingMode'] = 'call';
    if (!isset($p['pricePer1k']) || !is_numeric($p['pricePer1k'])) $p['pricePer1k'] = 0;
    if (empty($p['name'])) $p['name'] = !empty($p['baseUrl']) ? $p['baseUrl'] : '未命名供应商';
    return $p;
}

function tc_validate_provider($p) {
    if (empty($p['baseUrl'])) return 'Base URL 不能为空';
    if (!preg_match('/^https?:\/\//i', $p['baseUrl'])) return 'Base URL 需以 http:// 或 https:// 开头';
    // 服务端会带着自己的身份去请求这个地址:内网/保留目标必须在这里就挡住,
    // 否则填个 http://127.0.0.1:6379 就能借服务端探内网(SSRF)。
    if (!tc_upstream_url_is_safe($p['baseUrl'])) {
        return 'Base URL 指向内网或保留地址,或端口不被允许(仅支持 80/443/8080/8443 的公网地址)';
    }
    if (empty($p['apiKey'])) return 'API Key 不能为空';
    if (empty($p['models'])) return '请至少提供一个模型';
    return null;
}

function tc_find_editable_provider($db, $user, $id) {
    foreach ($db['providers'] as $p) {
        if ($p['id'] === $id) {
            if ((isset($p['ownerId']) && $p['ownerId'] === $user['id']) || !empty($user['admin'])) return $p;
            tc_fail(403, '只能修改自己添加的供应商');
        }
    }
    tc_fail(404, '供应商不存在');
}

function tc_remove_provider(&$db, $id) {
    $idx = -1;
    foreach ($db['providers'] as $i => $p) if ($p['id'] === $id) { $idx = $i; break; }
    if ($idx < 0) return false;
    array_splice($db['providers'], $idx, 1);
    if (isset($db['defaultProviderId']) && $db['defaultProviderId'] === $id) {
        $next = null;
        foreach ($db['providers'] as $p) if (isset($p['scope']) && $p['scope'] === 'global') { $next = $p['id']; break; }
        if (!$next && $db['providers']) $next = $db['providers'][0]['id'];
        $db['defaultProviderId'] = $next;
    }
    $rules = array();
    foreach ($db['accessRules'] as $r) if ($r['providerId'] !== $id) $rules[] = $r;
    $db['accessRules'] = $rules;
    return true;
}

// 按字符上限截断文本,但不留半截 Markdown 图片。
// 用户消息的 content 里内联着 ![名](data:image/png;base64,...),单张图编码后可达数十万字符,
// 直接 substr 会把它拦腰截断:剩下的半截 base64 既不是图片也不是链接,渲染端只能整段当
// 普通文字画出来 —— 换设备同步后看到的就是「一堵乱码」(本机有完整 attachments,不走这条路)。
// 图片本体在 attachments[].dataUrl 里另有 8MB 上限、完整随同步保留,渲染端据此重建。
function tc_md_safe_cut($s, $n) {
    $s = (string) $s;
    if (strlen($s) <= $n) return $s;
    $cut = substr($s, 0, $n);
    $open = strrpos($cut, '![');
    if ($open === false) return $cut;
    $tail = substr($cut, $open);
    // 结构内还有闭合括号:说明最后一个 [! 是完整的,截断点在它之后,不必回退
    if (strpos($tail, ')') !== false) return $cut;
    // 只在确实是图片/链接结构时回退,普通文本里出现的 "![" 不动
    if (!preg_match('/^!\[[^\]]*\]\(\s*(?:data:|https?:|\/)/', $tail)) return $cut;
    return rtrim(substr($cut, 0, $open));
}

function tc_sanitize_chats($chats) {
    if (!is_array($chats)) return array();
    $out = array();
    foreach (array_slice($chats, 0, 300) as $c) {
        if (!is_array($c)) continue;
        $id = substr((string) (isset($c['id']) ? $c['id'] : ''), 0, 64);
        if ($id === '') continue;
        $messages = array();
        if (isset($c['messages']) && is_array($c['messages'])) {
            foreach (array_slice($c['messages'], -800) as $m) {
                if (!is_array($m)) continue;
                $role = isset($m['role']) && in_array($m['role'], array('user', 'assistant', 'system'), true) ? $m['role'] : 'assistant';
                $msg = array(
                    'role' => $role,
                    'content' => tc_md_safe_cut(array_key_exists('content', $m) && $m['content'] !== null ? $m['content'] : '', 200000),
                );
                // 原始输入文本与附件(图片 dataUrl / 解析正文)必须随同步保留,
                // 否则多端合并(云端按 updatedAt 覆盖)会凭空丢附件、编辑/重发失效
                if (array_key_exists('text', $m) && $m['text'] !== null && $m['text'] !== '') {
                    $msg['text'] = substr((string) $m['text'], 0, 200000);
                }
                if (isset($m['attachments']) && is_array($m['attachments'])) {
                    $atts = array();
                    foreach (array_slice($m['attachments'], 0, 8) as $a) {
                        if (!is_array($a)) continue;
                        $att = array(
                            'type' => (isset($a['type']) && $a['type'] === 'image') ? 'image' : 'file',
                            'name' => substr((string) (isset($a['name']) ? $a['name'] : ''), 0, 200),
                            'size' => isset($a['size']) && is_numeric($a['size']) ? (int) $a['size'] : 0,
                        );
                        if (!empty($a['mediaType'])) $att['mediaType'] = substr((string) $a['mediaType'], 0, 120);
                        // dataUrl 是 base64 图片本体,放行但设上限(约 8MB 编码后)
                        if (!empty($a['dataUrl']) && is_string($a['dataUrl'])) {
                            $att['dataUrl'] = strlen($a['dataUrl']) > 8 * 1024 * 1024 ? '' : $a['dataUrl'];
                        }
                        if (!empty($a['content']) && is_string($a['content'])) $att['content'] = substr($a['content'], 0, 200000);
                        if (!empty($a['imageAsText'])) $att['imageAsText'] = true;
                        if (isset($a['meta']) && is_array($a['meta'])) $att['meta'] = $a['meta'];
                        $atts[] = $att;
                    }
                    if ($atts) $msg['attachments'] = $atts;
                }
                foreach (array('vote', 'followUps', 'citations', 'model', 'reasoning', 'error', 'interrupted', 'failNote', 'elapsedMs', 'createdAt', 'usage', 'contextCount', 'contextLimit', 'taskId', 'taskSeq', 'taskStatus', 'taskFormat') as $k) {
                    if (array_key_exists($k, $m) && $m[$k] !== null) $msg[$k] = $m[$k];
                }
                if (isset($msg['usage']) && is_array($msg['usage'])) {
                    $usage = array();
                    foreach (array('prompt', 'completion', 'total') as $uk) {
                        if (isset($msg['usage'][$uk]) && is_numeric($msg['usage'][$uk])) $usage[$uk] = max(0, (int) $msg['usage'][$uk]);
                    }
                    $msg['usage'] = $usage ? $usage : null;
                    if ($msg['usage'] === null) unset($msg['usage']);
                } elseif (isset($msg['usage'])) {
                    unset($msg['usage']);
                }
                if (isset($msg['contextCount'])) $msg['contextCount'] = max(0, (int) $msg['contextCount']);
                if (isset($msg['contextLimit'])) $msg['contextLimit'] = max(0, (int) $msg['contextLimit']);
                // @助手/@笔记 引用快照:气泡里的 @ 回显据此渲染。不放行会被同步丢字段,
                // 表现为「刷新/换设备后引用消失」(内容本身不受影响)。
                if (isset($m['mentions']) && is_array($m['mentions'])) {
                    $mts = array();
                    foreach (array_slice($m['mentions'], 0, 30) as $mt) {
                        if (!is_array($mt)) continue;
                        $kind = isset($mt['kind']) && in_array($mt['kind'], array('assistant', 'folder', 'note'), true) ? $mt['kind'] : '';
                        if ($kind === '') continue;
                        $one = array(
                            'kind' => $kind,
                            'name' => substr((string) (isset($mt['name']) ? $mt['name'] : ''), 0, 200),
                            'id' => substr((string) (isset($mt['id']) ? $mt['id'] : ''), 0, 64),
                        );
                        if ($one['name'] === '' && $one['id'] === '') continue;
                        $mts[] = $one;
                    }
                    if ($mts) $msg['mentions'] = $mts;
                }
                // 回答末尾「参考笔记」来源行:记录这轮真正喂给模型的笔记。
                // 与 mentions 同理,不放行会被同步丢字段,表现为刷新/换设备后来源行消失。
                if (isset($m['noteRefs']) && is_array($m['noteRefs'])) {
                    $nrs = array();
                    foreach (array_slice($m['noteRefs'], 0, 30) as $nr) {
                        if (!is_array($nr)) continue;
                        $one = array(
                            'id' => substr((string) (isset($nr['id']) ? $nr['id'] : ''), 0, 64),
                            'title' => substr((string) (isset($nr['title']) ? $nr['title'] : ''), 0, 200),
                        );
                        if ($one['id'] === '' && $one['title'] === '') continue;
                        $nrs[] = $one;
                    }
                    if ($nrs) $msg['noteRefs'] = $nrs;
                }
                if (isset($m['versions']) && is_array($m['versions'])) {
                    $vers = array();
                    foreach (array_slice($m['versions'], -12) as $v) {
                        if (!is_array($v)) continue;
                        $vers[] = array(
                            'content' => tc_md_safe_cut(isset($v['content']) ? $v['content'] : '', 200000),
                            'reasoning' => substr((string) (isset($v['reasoning']) ? $v['reasoning'] : ''), 0, 200000),
                            'followUps' => isset($v['followUps']) && is_array($v['followUps']) ? array_slice($v['followUps'], 0, 8) : array(),
                            'citations' => isset($v['citations']) && is_array($v['citations']) ? array_slice($v['citations'], 0, 20) : array(),
                            'vote' => isset($v['vote']) ? $v['vote'] : null,
                            'model' => substr((string) (isset($v['model']) ? $v['model'] : ''), 0, 80),
                            'providerId' => substr((string) (isset($v['providerId']) ? $v['providerId'] : ''), 0, 64),
                            'providerName' => substr((string) (isset($v['providerName']) ? $v['providerName'] : ''), 0, 80),
                            'error' => !empty($v['error']),
                            'interrupted' => !empty($v['interrupted']),
                            'failNote' => substr((string) (isset($v['failNote']) ? $v['failNote'] : ''), 0, 300),
                            'elapsedMs' => isset($v['elapsedMs']) && is_numeric($v['elapsedMs']) ? (int) $v['elapsedMs'] : null,
                            'createdAt' => isset($v['createdAt']) ? (float) $v['createdAt'] : tc_now(),
                            'usage' => (isset($v['usage']) && is_array($v['usage'])) ? array(
                                'prompt' => isset($v['usage']['prompt']) ? max(0, (int) $v['usage']['prompt']) : 0,
                                'completion' => isset($v['usage']['completion']) ? max(0, (int) $v['usage']['completion']) : 0,
                                'total' => isset($v['usage']['total']) ? max(0, (int) $v['usage']['total']) : 0,
                            ) : null,
                            'contextCount' => isset($v['contextCount']) && is_numeric($v['contextCount']) ? max(0, (int) $v['contextCount']) : null,
                            'contextLimit' => isset($v['contextLimit']) && is_numeric($v['contextLimit']) ? max(0, (int) $v['contextLimit']) : null,
                        );
                    }
                    if ($vers) {
                        $msg['versions'] = $vers;
                        $vi = isset($m['versionIndex']) ? (int) $m['versionIndex'] : (count($vers) - 1);
                        if ($vi < 0) $vi = 0;
                        if ($vi >= count($vers)) $vi = count($vers) - 1;
                        $msg['versionIndex'] = $vi;
                    }
                }
                // 群聊消息:发言成员的名牌(emoji + 名字),服务端只留显示所需的最小字段
                if (isset($m['participant']) && is_array($m['participant'])) {
                    $stage = isset($m['participant']['stage']) ? (string) $m['participant']['stage'] : '';
                    if (!in_array($stage, array('clarify', 'offer', 'plan', 'talk', 'summary'), true)) $stage = '';
                    $msg['participant'] = array(
                        'name' => substr((string) (isset($m['participant']['name']) ? $m['participant']['name'] : ''), 0, 60),
                        'emoji' => substr((string) (isset($m['participant']['emoji']) ? $m['participant']['emoji'] : ''), 0, 16),
                        // 内置头像序号(static/role/N.png);0 表示旧消息,客户端退回 emoji
                        'avatar' => isset($m['participant']['avatar']) ? max(0, min(99, (int) $m['participant']['avatar'])) : 0,
                        'stage' => $stage,
                        'stageLabel' => substr((string) (isset($m['participant']['stageLabel']) ? $m['participant']['stageLabel'] : ''), 0, 40),
                        'admin' => !empty($m['participant']['admin']),
                    );
                    if (!empty($m['contextBaseline'])) $msg['contextBaseline'] = true;
                }
                $messages[] = $msg;
            }
        }
        $out[] = array(
            'id' => $id,
            'title' => substr((string) (isset($c['title']) ? $c['title'] : '新对话'), 0, 120),
            'messages' => $messages,
            'pinned' => !empty($c['pinned']),
            'branchOf' => !empty($c['branchOf']) ? substr((string) $c['branchOf'], 0, 64) : null,
            'assistantId' => !empty($c['assistantId']) ? substr((string) $c['assistantId'], 0, 64) : null,
            'assistantName' => !empty($c['assistantName']) ? substr((string) $c['assistantName'], 0, 80) : '',
            'systemPrompt' => !empty($c['systemPrompt']) ? substr((string) $c['systemPrompt'], 0, 20000) : '',
            // 群聊会话:记录所属群聊 id(群配置本体在用户浏览器本地,不进服务端)
            'groupId' => !empty($c['groupId']) ? substr((string) $c['groupId'], 0, 64) : null,
            'createdAt' => isset($c['createdAt']) ? (float) $c['createdAt'] : tc_now(),
            'updatedAt' => isset($c['updatedAt']) ? (float) $c['updatedAt'] : tc_now(),
            // 开放 API 记下来的会话标记(tc_api_append_chat 写入:接口调用按它归并同一段
            // 上下文)。前台据此把接口调用与手动对话分开(「今天 API」单独成组、可一键隐藏),
            // 所以必须原样放过同步:白名单里漏掉它,客户端把列表推回云端一次,标记就永久丢了 ——
            // 换设备拉取后这些会话全变成普通对话,而本机看不出任何异常(本地副本自己还带着)。
            'apiKey' => !empty($c['apiKey']) ? substr((string) $c['apiKey'], 0, 64) : null,
        );
    }
    return $out;
}

function tc_sanitize_share_messages($messages) {
    if (!is_array($messages)) return array();
    $out = array();
    foreach (array_slice($messages, -200) as $m) {
        if (!is_array($m)) continue;
        $content = tc_md_safe_cut(isset($m['content']) && $m['content'] !== null ? $m['content'] : '', 200000);
        if ($content === '') continue;
        $out[] = array(
            'role' => (isset($m['role']) && in_array($m['role'], array('user', 'assistant'), true)) ? $m['role'] : 'assistant',
            'content' => $content,
        );
    }
    return $out;
}

function tc_public_share($share) {
    return array(
        'id' => $share['id'],
        'title' => $share['title'],
        'messages' => $share['messages'],
        'createdAt' => $share['createdAt'],
        'updatedAt' => $share['updatedAt'],
    );
}

function tc_last_n_days($n) {
    $out = array();
    for ($i = $n - 1; $i >= 0; $i--) $out[] = date('Y-m-d', time() - $i * 86400);
    return $out;
}

function tc_chats_of($db, $userId) {
    $map = tc_assoc($db['userChats']);
    return isset($map[$userId]) && is_array($map[$userId]) ? $map[$userId] : array();
}

function tc_chat_revision_of($db, $userId) {
    $map = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
    return isset($map[$userId]) ? (int) $map[$userId] : 0;
}

function tc_set_chats(&$db, $userId, $chats) {
    $map = tc_assoc($db['userChats']);
    $map[$userId] = $chats;
    $db['userChats'] = tc_object_map($map);
    $revisions = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
    $revisions[$userId] = tc_chat_revision_of($db, $userId) + 1;
    $db['userChatRevisions'] = tc_object_map($revisions);
}

// ============ 已删除对话留档(软删除) ============
// 用户删除对话时云端不抹掉内容,而是移到 userDeletedChats:{chats:留档, tombs:{id:删除时间}}。
// tombs 同时是跨设备删除的同步源:别的设备拉取时据此把本地副本一并删掉,
// 旧设备用过期列表回推时也会被墓碑挡住,不会把对话"复活"。
function tc_deleted_of($db, $userId) {
    $map = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
    $uid = (string) $userId;
    $row = isset($map[$uid]) ? tc_assoc($map[$uid]) : array();
    return array(
        'chats' => isset($row['chats']) && is_array($row['chats']) ? array_values($row['chats']) : array(),
        'tombs' => tc_assoc(isset($row['tombs']) ? $row['tombs'] : array()),
    );
}

function tc_set_deleted_of(&$db, $userId, $row) {
    $map = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
    $uid = (string) $userId;
    $clean = array(
        'chats' => isset($row['chats']) && is_array($row['chats']) ? array_values($row['chats']) : array(),
        'tombs' => tc_assoc(isset($row['tombs']) ? $row['tombs'] : array()),
    );
    if (!$clean['chats'] && !$clean['tombs']) unset($map[$uid]);
    else $map[$uid] = $clean;
    $db['userDeletedChats'] = tc_object_map($map);
}

// 墓碑上限:只保留最近 2000 条,防止极端账号把 id 清单撑爆
function tc_deleted_cap_tombs($tombs, $limit = 2000) {
    if (count($tombs) <= $limit) return $tombs;
    arsort($tombs);
    return array_slice($tombs, 0, $limit, true);
}

// 留档上限:保留最近 300 条已删除对话(与在线对话同量级),更早的整段丢弃
function tc_deleted_cap_chats($chats, $limit = 300) {
    if (count($chats) <= $limit) return $chats;
    usort($chats, function ($a, $b) {
        return (isset($b['updatedAt']) ? $b['updatedAt'] : 0) <=> (isset($a['updatedAt']) ? $a['updatedAt'] : 0);
    });
    return array_slice($chats, 0, $limit);
}

// 把一条对话放进留档:同 id 覆盖时保留内容较新的那份
function tc_deleted_archive_put(&$archived, $chat) {
    if (!is_array($chat) || empty($chat['id'])) return;
    $id = (string) $chat['id'];
    foreach ($archived as $i => $old) {
        if (isset($old['id']) && (string) $old['id'] === $id) {
            if ((isset($chat['updatedAt']) ? (float) $chat['updatedAt'] : 0) >= (isset($old['updatedAt']) ? (float) $old['updatedAt'] : 0)) {
                $archived[$i] = $chat;
            }
            return;
        }
    }
    $archived[] = $chat;
}

// 开放 API 的对话落库:把一次 /v1/chat/completions 调用记入该用户的对话列表。
// 约定:同一段上下文归入同一对话——按「首条用户消息」生成稳定指纹,若这次请求带的
// 历史里首条用户消息与某条已存 API 对话一致,说明客户端在续接同一段上下文,追加即可;
// 否则(新话题、或本机从没见过这段上下文)新建一个对话。这样 API 客户端的多轮对话
// 不会各开一屏,不同话题也不会挤在一条里。
function tc_api_chat_title($text) {
    $t = trim(preg_replace('/\s+/u', ' ', (string) $text));
    if ($t === '') return 'API 对话';
    $t = function_exists('mb_substr') ? mb_substr($t, 0, 24, 'UTF-8') : substr($t, 0, 24);
    return 'API · ' . $t;
}

function tc_api_append_chat(&$db, $userId, $messages, $meta = array()) {
    if (!is_array($messages) || !$messages) return '';
    $first = '';
    foreach ($messages as $m) {
        if (is_array($m) && isset($m['role']) && $m['role'] === 'user') { $first = (string) (isset($m['content']) ? $m['content'] : ''); break; }
    }
    if ($first === '') {
        foreach ($messages as $m) if (is_array($m)) { $first = (string) (isset($m['content']) ? $m['content'] : ''); break; }
    }
    $key = substr(hash('sha256', $first), 0, 16);
    $now = tc_now();
    $chats = tc_chats_of($db, $userId);
    $idx = -1;
    foreach ($chats as $i => $c) {
        if (isset($c['apiKey']) && $c['apiKey'] === $key) { $idx = $i; break; }
    }
    $model = isset($meta['model']) ? (string) $meta['model'] : '';
    $clean = array();
    foreach ($messages as $m) {
        if (!is_array($m)) continue;
        $role = isset($m['role']) && in_array($m['role'], array('user', 'assistant'), true) ? $m['role'] : 'assistant';
        $row = array('role' => $role, 'content' => (string) (isset($m['content']) ? $m['content'] : ''), 'createdAt' => $now);
        if ($role === 'assistant' && $model !== '') $row['model'] = $model;
        if ($role === 'assistant' && isset($meta['usage']) && is_array($meta['usage'])) {
            $row['usage'] = array(
                'prompt' => (int) (isset($meta['usage']['prompt']) ? $meta['usage']['prompt'] : 0),
                'completion' => (int) (isset($meta['usage']['completion']) ? $meta['usage']['completion'] : 0),
            );
        }
        $clean[] = $row;
    }
    if (!$clean) return '';
    if ($idx >= 0) {
        $chat = $chats[$idx];
        $existing = isset($chat['messages']) && is_array($chat['messages']) ? $chat['messages'] : array();
        // 客户端续接同一段上下文时会把历史整段带上;已存在的部分不再重复追加,
        // 只把新增的消息接上(按 role+content 逐条对齐,从首个不匹配处截取)。
        $cursor = 0;
        foreach ($clean as $row) {
            if ($cursor < count($existing) && $existing[$cursor]['role'] === $row['role'] && (string) $existing[$cursor]['content'] === (string) $row['content']) {
                $cursor++;
                continue;
            }
            break;
        }
        $chat['messages'] = array_merge($existing, array_slice($clean, $cursor));
        if (count($chat['messages']) > 800) $chat['messages'] = array_slice($chat['messages'], -800);
        if ($model !== '') $chat['model'] = $model;
        $chat['updatedAt'] = $now;
        $chats[$idx] = $chat;
        $chatId = isset($chat['id']) ? $chat['id'] : '';
    } else {
        $chatId = 'api' . substr(hash('sha256', $userId . $key . $now), 0, 14);
        $chats[] = array(
            'id' => $chatId,
            'title' => tc_api_chat_title($first),
            'messages' => $clean,
            'model' => $model,
            'apiKey' => $key,
            'pinned' => false,
            'createdAt' => $now,
            'updatedAt' => $now,
        );
    }
    if (count($chats) > 300) {
        usort($chats, function ($a, $b) { return (isset($b['updatedAt']) ? $b['updatedAt'] : 0) - (isset($a['updatedAt']) ? $a['updatedAt'] : 0); });
        $chats = array_slice($chats, 0, 300);
    }
    tc_set_chats($db, $userId, $chats);
    return $chatId;
}

function tc_assistant_icons() {
    return array('bot', 'spark', 'layers', 'paper', 'code', 'table', 'nodes', 'think', 'user', 'wrench', 'edit', 'calendar');
}

function tc_is_allowed_assistant_icon($icon) {
    $s = trim((string) $icon);
    if ($s === '' || strlen($s) > 16) return false;
    if (in_array($s, tc_assistant_icons(), true)) return true;
    return (bool) preg_match('/[^\x00-\x7F]/u', $s);
}

function tc_seed_default_assistants(&$db) {
    $cat = tc_catalog();
    $now = tc_now();
    if (!is_array($db['assistantCategories'])) $db['assistantCategories'] = array();
    if (!is_array($db['assistants'])) $db['assistants'] = array();
    $changed = false;
    foreach ((isset($cat['categories']) ? $cat['categories'] : array()) as $c) {
        $existing = null;
        foreach ($db['assistantCategories'] as $i => $x) if ($x['id'] === $c['id']) { $existing = &$db['assistantCategories'][$i]; break; }
        if (!$existing) {
            $db['assistantCategories'][] = array(
                'id' => $c['id'], 'name' => $c['name'], 'sort' => $c['sort'],
                'icon' => isset($c['icon']) ? $c['icon'] : '',
                'scope' => 'global', 'ownerId' => null, 'createdAt' => $now,
            );
            $changed = true;
        } elseif (isset($existing['scope']) && $existing['scope'] === 'global') {
            $icon = isset($c['icon']) ? $c['icon'] : '';
            if ($existing['name'] !== $c['name'] || $existing['sort'] !== $c['sort'] || (isset($existing['icon']) ? $existing['icon'] : '') !== $icon) {
                $existing['name'] = $c['name'];
                $existing['sort'] = $c['sort'];
                $existing['icon'] = $icon;
                $changed = true;
            }
        }
        unset($existing);
    }
    $keepIds = array();
    foreach ((isset($cat['categories']) ? $cat['categories'] : array()) as $c) $keepIds[$c['id']] = true;
    $kept = array();
    foreach ($db['assistantCategories'] as $c) {
        if (isset($c['scope']) && $c['scope'] === 'global' && empty($keepIds[$c['id']])) {
            $changed = true;
            continue;
        }
        $kept[] = $c;
    }
    $db['assistantCategories'] = $kept;
    $i = 0;
    foreach ((isset($cat['assistants']) ? $cat['assistants'] : array()) as $a) {
        $i++;
        $sort = $i * 10;
        $existing = null;
        foreach ($db['assistants'] as $j => $x) if ($x['id'] === $a['id']) { $existing = &$db['assistants'][$j]; break; }
        if (!$existing) {
            $db['assistants'][] = array(
                'id' => $a['id'], 'categoryId' => $a['categoryId'], 'name' => $a['name'],
                'desc' => $a['desc'], 'prompt' => $a['prompt'], 'icon' => $a['icon'],
                'sort' => $sort, 'scope' => 'global', 'ownerId' => null, 'sourceId' => null,
                'createdAt' => $now, 'updatedAt' => $now,
            );
            $changed = true;
        } elseif (isset($existing['scope']) && $existing['scope'] === 'global') {
            if (
                $existing['categoryId'] !== $a['categoryId'] || $existing['name'] !== $a['name']
                || $existing['desc'] !== $a['desc'] || $existing['prompt'] !== $a['prompt']
                || $existing['icon'] !== $a['icon'] || (isset($existing['sort']) ? $existing['sort'] : 0) !== $sort
            ) {
                $existing['categoryId'] = $a['categoryId'];
                $existing['name'] = $a['name'];
                $existing['desc'] = $a['desc'];
                $existing['prompt'] = $a['prompt'];
                $existing['icon'] = $a['icon'];
                $existing['sort'] = $sort;
                $existing['updatedAt'] = $now;
                $changed = true;
            }
        }
        unset($existing);
    }
    return $changed;
}

function tc_visible_assistant_categories($db, $user) {
    $out = array();
    foreach ($db['assistantCategories'] as $c) {
        if ((isset($c['scope']) && $c['scope'] === 'global') || (isset($c['scope']) && $c['scope'] === 'user' && isset($c['ownerId']) && $c['ownerId'] === $user['id'])) {
            $out[] = $c;
        }
    }
    return $out;
}

function tc_visible_assistants($db, $user) {
    $out = array();
    foreach ($db['assistants'] as $a) {
        if ((isset($a['scope']) && $a['scope'] === 'global') || (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'])) {
            $out[] = $a;
        }
    }
    return $out;
}

function tc_public_category($c, $extras = array()) {
    return array_merge(array(
        'id' => $c['id'],
        'name' => $c['name'],
        'sort' => isset($c['sort']) ? (int) $c['sort'] : 0,
        'icon' => isset($c['icon']) ? $c['icon'] : '',
        'scope' => (isset($c['scope']) && $c['scope'] === 'user') ? 'user' : 'global',
        'mine' => isset($c['scope']) && $c['scope'] === 'user',
        'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : 0,
    ), $extras);
}

function tc_public_assistant($a, $extras = array()) {
    return array_merge(array(
        'id' => $a['id'],
        'categoryId' => $a['categoryId'],
        'name' => $a['name'],
        'desc' => isset($a['desc']) ? $a['desc'] : '',
        'prompt' => isset($a['prompt']) ? $a['prompt'] : '',
        'icon' => isset($a['icon']) ? $a['icon'] : '✨',
        'sort' => isset($a['sort']) ? (int) $a['sort'] : 0,
        'scope' => (isset($a['scope']) && $a['scope'] === 'user') ? 'user' : 'global',
        'mine' => isset($a['scope']) && $a['scope'] === 'user',
        'sourceId' => isset($a['sourceId']) ? $a['sourceId'] : null,
        'createdAt' => isset($a['createdAt']) ? $a['createdAt'] : 0,
        'updatedAt' => isset($a['updatedAt']) ? $a['updatedAt'] : 0,
    ), $extras);
}

function tc_find_owned_category($db, $user, $id, $adminOk = false) {
    foreach ($db['assistantCategories'] as $c) {
        if ($c['id'] !== $id) continue;
        if (isset($c['scope']) && $c['scope'] === 'user' && isset($c['ownerId']) && $c['ownerId'] === $user['id']) return $c;
        if ($adminOk && !empty($user['admin']) && isset($c['scope']) && $c['scope'] === 'global') return $c;
        return null;
    }
    return null;
}

function tc_find_owned_assistant($db, $user, $id, $adminOk = false) {
    foreach ($db['assistants'] as $a) {
        if ($a['id'] !== $id) continue;
        if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id']) return $a;
        if ($adminOk && !empty($user['admin']) && isset($a['scope']) && $a['scope'] === 'global') return $a;
        return null;
    }
    return null;
}

function tc_resolve_category_for_write($db, $user, $categoryId) {
    $id = trim((string) $categoryId);
    if ($id === '') return array('error' => '请选择分类');
    foreach ($db['assistantCategories'] as $c) {
        if ($c['id'] !== $id) continue;
        if (isset($c['scope']) && $c['scope'] === 'global') return array('category' => $c);
        if (isset($c['ownerId']) && $c['ownerId'] === $user['id']) return array('category' => $c);
        return array('error' => '无权使用该分类');
    }
    return array('error' => '分类不存在');
}

function tc_parse_assistant_input($b, $existing = null) {
    $name = substr(trim((string) (isset($b['name']) ? $b['name'] : ($existing ? $existing['name'] : ''))), 0, 40);
    $desc = substr(trim((string) (isset($b['desc']) ? $b['desc'] : ($existing && isset($existing['desc']) ? $existing['desc'] : ''))), 0, 160);
    $prompt = substr(trim((string) (isset($b['prompt']) ? $b['prompt'] : ($existing && isset($existing['prompt']) ? $existing['prompt'] : ''))), 0, 20000);
    $icon = substr(trim((string) (isset($b['icon']) ? $b['icon'] : ($existing && isset($existing['icon']) ? $existing['icon'] : '✨'))), 0, 16);
    if (!tc_is_allowed_assistant_icon($icon)) $icon = '✨';
    $sort = isset($b['sort']) && is_numeric($b['sort']) ? (float) $b['sort'] : ($existing && isset($existing['sort']) ? $existing['sort'] : tc_now());
    if ($name === '') return array('error' => '助手名称不能为空');
    if ($prompt === '') return array('error' => '系统提示词不能为空');
    return array('name' => $name, 'desc' => $desc, 'prompt' => $prompt, 'icon' => $icon, 'sort' => $sort);
}

function tc_parse_category_input($b, $existing = null) {
    $name = substr(trim((string) (isset($b['name']) ? $b['name'] : ($existing ? $existing['name'] : ''))), 0, 40);
    $sort = isset($b['sort']) && is_numeric($b['sort']) ? (float) $b['sort'] : ($existing && isset($existing['sort']) ? $existing['sort'] : tc_now());
    if ($name === '') return array('error' => '分类名称不能为空');
    return array('name' => $name, 'sort' => $sort);
}

function tc_sort_zh($a, $b, $ka, $kb) {
    $sa = isset($a['sort']) ? (float) $a['sort'] : 0;
    $sb = isset($b['sort']) ? (float) $b['sort'] : 0;
    if ($sa !== $sb) return $sa < $sb ? -1 : 1;
    return strcmp((string) (isset($a[$ka]) ? $a[$ka] : ''), (string) (isset($b[$kb]) ? $b[$kb] : ''));
}

function tc_default_assistant_record($db, $user) {
    $cat = tc_catalog();
    $id = isset($cat['DEFAULT_ASSISTANT_ID']) ? $cat['DEFAULT_ASSISTANT_ID'] : null;
    if (!$id) return null;
    $list = tc_visible_assistants($db, $user);
    $override = null;
    $item = null;
    foreach ($list as $a) {
        if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && isset($a['sourceId']) && $a['sourceId'] === $id) $override = $a;
        if ($a['id'] === $id) $item = $a;
    }
    $pick = $override ?: $item;
    return $pick ? tc_public_assistant($pick) : null;
}

function tc_merge_assistant_catalog($db, $user) {
    $cats = tc_visible_assistant_categories($db, $user);
    usort($cats, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
    $items = tc_visible_assistants($db, $user);
    $hidden = array();
    foreach ($items as $a) {
        if (isset($a['scope']) && $a['scope'] === 'user' && !empty($a['sourceId'])) $hidden[$a['sourceId']] = true;
    }
    $shown = array();
    foreach ($items as $a) {
        if (isset($a['scope']) && $a['scope'] === 'global' && isset($hidden[$a['id']])) continue;
        $shown[] = $a;
    }
    usort($shown, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
    $categories = array();
    foreach ($cats as $c) {
        $count = 0;
        foreach ($shown as $a) if ($a['categoryId'] === $c['id']) $count++;
        $categories[] = tc_public_category($c, array('count' => $count));
    }
    $assistants = array();
    foreach ($shown as $a) $assistants[] = tc_public_assistant($a);
    return array(
        'categories' => $categories,
        'assistants' => $assistants,
        'defaultAssistant' => tc_default_assistant_record($db, $user),
    );
}

function tc_replace_by_id(&$list, $id, $item) {
    foreach ($list as $i => $x) if ($x['id'] === $id) { $list[$i] = $item; return true; }
    return false;
}

function tc_has_admin($db) {
    foreach ($db['users'] as $u) if (!empty($u['admin'])) return true;
    return false;
}

// 首次运行环境自检:不依赖数据库,逐项检查扩展与目录权限,登录页据阻塞项引导。
// 该接口会暴露服务器路径等部署细节,安装完成后不再对外提供;
// 数据库不可用时仍然放行——登录页要靠它排障(data/ 权限类故障)。
function tc_api_env_check() {
    $installed = false;
    try {
        tc_with_db(false, function ($db) use (&$installed) { $installed = tc_has_admin($db); });
    } catch (Throwable $e) {
        $installed = false;
    }
    if ($installed) tc_fail(403, '站点已完成安装，环境自检接口已关闭');
    $dir = tc_data_dir();
    $checks = array();
    $add = function ($name, $ok, $detail = '', $critical = true) use (&$checks) {
        $checks[] = array('name' => $name, 'ok' => (bool) $ok, 'detail' => (string) $detail, 'critical' => (bool) $critical);
    };
    $add('PHP 版本 ≥ 7.4', version_compare(PHP_VERSION, '7.4.0', '>='), '当前 ' . PHP_VERSION);
    $add('pdo_sqlite 扩展', extension_loaded('pdo_sqlite'), 'SQLite 数据存储依赖');
    $add('curl 扩展', extension_loaded('curl'), '调用上游 AI 接口依赖');
    $add('openssl 扩展', extension_loaded('openssl'), '供应商 Key 加密 / 随机数依赖');
    $add('json 支持', function_exists('json_encode'), '数据序列化依赖');
    $add('mbstring 扩展', extension_loaded('mbstring'), '中文用量估算与审核匹配（建议）', false);
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $writable = is_dir($dir) && is_writable($dir);
    $probeFile = $dir . '/.probe-' . bin2hex(random_bytes(4));
    $probe = @file_put_contents($probeFile, 'ok') !== false;
    if ($probe) @unlink($probeFile);
    $add('data/ 目录可写', $probe, $dir);
    $free = function_exists('disk_free_space') ? @disk_free_space($dir) : null;
    $add('磁盘剩余空间 ≥ 20MB', $free === null || $free > 20 * 1024 * 1024, $dir, false);
    $allOk = true;
    foreach ($checks as $c) if ($c['critical'] && !$c['ok']) $allOk = false;
    tc_json(200, array('checks' => $checks, 'allOk' => $allOk, 'dataDir' => $dir));
}

function tc_api_public_config($db) {
    $s = $db['settings'];
    tc_json(200, array(
        'siteName' => $s['siteName'],
        'allowRegister' => $s['allowRegister'],
        'freeQuota' => $s['freeQuota'],
        'version' => TC_VERSION,
        'hasProvider' => count($db['providers']) > 0,
        'needsSetup' => !tc_has_admin($db),
        // 前台据此决定是否展示"忘记密码"入口:功能关闭或未配置邮件时都不展示
        'emailVerificationEnabled' => !empty($s['emailVerificationEnabled']),
        'passwordResetEnabled' => !empty($s['passwordResetEnabled']),
        'mailReady' => !empty($s['smtp']['host']),
        'webSearch' => tc_web_search_public($s),
        'mineru' => tc_mineru_public($s),
        // 第三方一键登录:登录页据此渲染对应小图标(仅已启用且配置完整的)
        'oauth' => array(
            'providers' => tc_oauth_enabled_providers($s),
            'autoRegister' => !empty($s['oauthAutoRegister']),
            'requireProfile' => !empty($s['oauthRequireProfile']),
        ),
        // 全站公告:enabled 且 text 非空时前台展示;updatedAt 变化视为新公告(重新弹出)
        'announcement' => array(
            'enabled' => !empty($s['announcement']['enabled']),
            'text' => isset($s['announcement']['text']) ? (string) $s['announcement']['text'] : '',
            'updatedAt' => (int) (isset($s['announcement']['updatedAt']) ? $s['announcement']['updatedAt'] : 0),
        ),
        'registerInviteRequired' => !empty($s['registerInviteRequired']),
        // 用户协议:启用时注册表单要展示勾选项。缺了它前台就不知道要不要露这个勾选框,
        // 而注册接口在协议启用时会拒掉「没带 agreementAccepted」的请求 —— 表现为用户
        // 填完注册表单却永远失败。登录页与主站登录弹窗都靠这个字段。
        'agreementEnabled' => !empty($s['agreementEnabled']),
        // 账号注销模式:off=不开放, soft=软注销(改名+标记,原用户名/邮箱可重新注册), hard=删除全部数据
        'accountDeletionMode' => isset($s['accountDeletionMode']) ? (string) $s['accountDeletionMode'] : 'soft',
        // 演示模式:管理员的改动会在有效期后自动还原,前台据此提示
        'demoMode' => !empty($s['demoMode']),
        'demoExpireMinutes' => isset($s['demoExpireMinutes']) ? (int) $s['demoExpireMinutes'] : 10,
        // 游客模式:允许未登录访客直接体验对话
        'guestEnabled' => !empty($s['guestEnabled']),
        'guestRounds' => isset($s['guestRounds']) ? (int) $s['guestRounds'] : 3,
        // AI 笔记:前台据此决定入口是否显示(关闭时隐藏)
        'notesEnabled' => !empty($s['notesEnabled']),
        'notesAllowFiles' => !isset($s['notesAllowFiles']) || !empty($s['notesAllowFiles']),
        'notesShareBodyOnly' => !array_key_exists('notesShareBodyOnly', $s) || !empty($s['notesShareBodyOnly']),
        'notesAiCustomizable' => !array_key_exists('notesAiCustomizable', $s) || !empty($s['notesAiCustomizable']),
        // 在线聊天(IM):前台据此决定入口是否显示与上传前置校验
        'imEnabled' => !isset($s['imEnabled']) || !empty($s['imEnabled']),
        'imAllowFiles' => !isset($s['imAllowFiles']) || !empty($s['imAllowFiles']),
        'imMaxImageMb' => (int) (isset($s['imMaxImageMb']) ? $s['imMaxImageMb'] : 10),
        'imMaxFileMb' => (int) (isset($s['imMaxFileMb']) ? $s['imMaxFileMb'] : 20),
        // 在线浏览器:前台据此决定入口是否显示(关闭时隐藏)
        'browserEnabled' => !isset($s['browserEnabled']) || !empty($s['browserEnabled']),
        // 在线工具箱:前台据此决定入口是否显示(关闭时隐藏)。按人判定走 /api/me 的 features
        'toolboxEnabled' => !isset($s['toolboxEnabled']) || !empty($s['toolboxEnabled']),
        // 仅限中国 IP 网站:前台在浏览器里提前提示,避免用户对着境外地址反复试
        'webCnOnly' => !array_key_exists('webCnOnly', $s) || !empty($s['webCnOnly']),
        // 国内站引用海外 CDN 的静态资源时是否放行(默认放行;关掉后子资源也必须解析在境内)
        'webCnAllowAssets' => !array_key_exists('webCnAllowAssets', $s) || !empty($s['webCnAllowAssets']),
        // 域名白名单是否启用。启用的话,白名单内的域名不看 IP 直接放行;前台据此把
        // 「服务器缺境内 IP 数据」的提示说准确(此时名单内的站仍可访问,不是「任何站点都不行」)。
        'webCnWhitelistEnabled' => !array_key_exists('webCnWhitelistEnabled', $s) || !empty($s['webCnWhitelistEnabled']),
        // 每用户每日出网流量上限(MB,0 = 不限),前台据此展示今日剩余流量
        'webDailyTrafficMb' => (int) (isset($s['webDailyTrafficMb']) ? $s['webDailyTrafficMb'] : 500),
        // 境内 IP 段数据是否可用。开关默认开着,而数据缺失会让所有站点一起被拒;
        // 前台据此报「服务器缺少数据」而不是「该站点不在允许范围内」,省得用户白试半天。
        'webCnDataReady' => function_exists('tc_web_cn_data_ready') ? tc_web_cn_data_ready() : false,
        // 性能优化:前台据此决定是否加载内置字体 / KaTeX / 代码高亮 / Mermaid
        'perf' => array(
            'noWebfonts' => !empty($s['perfNoWebfonts']),
            'noKatex' => !empty($s['perfNoKatex']),
            'noHighlight' => !empty($s['perfNoHighlight']),
            'noMermaid' => !empty($s['perfNoMermaid']),
        ),
    ));
}

function tc_api_setup() {
    tc_with_db(true, function (&$db) {
        if (tc_has_admin($db)) tc_fail(409, '管理员已创建，请直接登录');
        $b = tc_read_json_body();
        $name = trim((string) (isset($b['name']) ? $b['name'] : 'admin'));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        if (!tc_valid_name($name)) tc_fail(400, '用户名需 2-32 位（字母/数字/中文/._@-）');
        if (strlen($password) < 4 || strlen($password) > 128) tc_fail(400, '密码长度需为 4-128 个字符');
        if (strlen($password) > 128) tc_fail(400, '密码过长');
        foreach ($db['users'] as $u) {
            if (strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
        }
        $user = array(
            'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
            'quota' => -1, 'createdAt' => tc_now(), 'admin' => true,
            'groupId' => ($ag = tc_find_builtin_group($db, 'admin')) ? $ag['id'] : tc_default_register_group($db),
            'tv' => 0,
        );
        tc_set_password($user, $password);
        $db['users'][] = $user;
        tc_json(200, array('token' => tc_issue_token($user, $db['settings']), 'user' => tc_sanitize_user($user)));
    });
}

function tc_render_mail_template($settings, $kind, $name, $link, $expiresText = '24 小时') {
    $tpl = $settings['mailTemplates'] ?? array(); $subject = $kind === 'reset' ? ($tpl['resetSubject'] ?? '重置密码') : ($tpl['verifySubject'] ?? '验证邮箱'); $html = $kind === 'reset' ? ($tpl['resetHtml'] ?? '') : ($tpl['verifyHtml'] ?? ''); $vars = array('{siteName}' => $settings['siteName'] ?? 'TinyChat', '{name}' => $name, '{link}' => $link, '{expires}' => $expiresText); return array(strtr($subject, $vars), strtr($html, $vars));
}

function tc_api_register() {
    tc_with_db(true, function (&$db) {
        $b = tc_read_json_body();
        // 注册限流:每 IP 每小时 N 次(可配),防批量注册薅免费额度
        $regLimit = isset($db['settings']['registerLimitPerHour']) ? (int) $db['settings']['registerLimitPerHour'] : 5;
        if (!tc_rate_limit_check('reg:' . tc_client_ip(), $regLimit, 3600000)) {
            tc_fail(429, '注册过于频繁，请稍后再试');
        }
        if (empty($db['settings']['allowRegister'])) tc_fail(403, '站点已关闭注册，请联系管理员开通账号');
        if (!empty($db['settings']['agreementEnabled']) && empty($b['agreementAccepted'])) tc_fail(400, '请先阅读并同意用户协议');
        $invite = strtoupper(trim((string) ($b['invite'] ?? '')));
        $inviteIndex = -1;
        if (!empty($db['settings']['registerInviteRequired'])) {
            if ($invite === '') tc_fail(400, '注册需要邀请码，请向管理员索取');
            foreach ($db['inviteCodes'] as $i => $c) {
                if (isset($c['code']) && strtoupper((string) $c['code']) === $invite && tc_invite_is_usable($c)) { $inviteIndex = $i; break; }
            }
            if ($inviteIndex < 0) tc_fail(400, '邀请码无效或已被使用');
        }
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        $email = strtolower(trim((string) ($b['email'] ?? '')));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) tc_fail(400, '邮箱格式不正确');
        if (!tc_valid_name($name)) tc_fail(400, '用户名需 2-32 位（字母/数字/中文/._@-）');
        if (strlen($password) < 4 || strlen($password) > 128) tc_fail(400, '密码长度需为 4-128 个字符');
        if (strlen($password) > 128) tc_fail(400, '密码过长');
        foreach ($db['users'] as $u) {
            if (strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
        }
        $user = array(
            'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
            'quota' => 0, 'email' => $email, 'createdAt' => tc_now(), 'admin' => false, 'groupId' => tc_default_register_group($db), 'tv' => 0, 'emailVerifiedAt' => '' ,
        );
        tc_set_password($user, $password);
        if (!empty($db['settings']['emailVerificationEnabled'])) {
            if ($email === '') tc_fail(400, '开启邮箱验证后必须填写邮箱');
            $token = bin2hex(random_bytes(24)); $user['emailTokenHash'] = hash('sha256', $token); $user['emailTokenExpires'] = tc_now() + 86400000;
        }
        $db['users'][] = $user;
        tc_log_auth_event('auth', $name, '注册账号', $user['id']);
        // 核销邀请码:累加使用次数,记录最后使用者;次数用尽后不再可用
        if ($inviteIndex >= 0) {
            $db['inviteCodes'][$inviteIndex]['usedCount'] = tc_invite_used_count($db['inviteCodes'][$inviteIndex]) + 1;
            $db['inviteCodes'][$inviteIndex]['usedBy'] = $user['id'];
            $db['inviteCodes'][$inviteIndex]['usedByName'] = $name;
            $db['inviteCodes'][$inviteIndex]['usedAt'] = tc_now();
        }
        tc_add_quota($db, $user, !empty($db['settings']['freeQuotaUnlimited']) ? -1 : $db['settings']['freeQuota']);
        if (!empty($db['settings']['emailVerificationEnabled'])) { $link = tc_public_base_url() . '/login?verify=' . rawurlencode($token); [$subject,$html] = tc_render_mail_template($db['settings'], 'verify', $name, $link, '24 小时'); if (!tc_mail_send($db['settings'], $email, $subject, $html, '', $regMailErr)) tc_fail(400, $regMailErr !== '' ? ('验证邮件发送失败：' . $regMailErr) : '验证邮件发送失败，请联系管理员'); tc_json(200, array('ok'=>true,'pendingVerification'=>true,'user'=>tc_sanitize_user($user))); }
        tc_json(200, array('token' => tc_issue_token($user, $db['settings']), 'user' => tc_sanitize_user($user)));
    });
}

function tc_api_login() {
    $user = null;
    $settings = null;
    tc_with_db(false, function ($db) use (&$user, &$settings) {
        $b = tc_read_json_body();
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        if ($name === '' || $password === '') tc_fail(400, '请输入用户名和密码');
        $locked = tc_check_login_lock($db['settings'], $name);
        if ($locked) tc_fail(429, '登录失败次数过多，请 ' . $locked . ' 秒后重试');
        $found = null;
        foreach ($db['users'] as $u) {
            if (strtolower($u['name']) === strtolower($name)) { $found = $u; break; }
        }
        if (!$found) {
            // 用户不存在时也执行一次同代价的口令推导,避免「用户名是否存在」被
            // 网络耗时区分出来(120000 轮 PBKDF2 与直接短路差几十毫秒)。
            tc_verify_password($password, array('salt' => 'tc-enumeration-pad', 'passwordHash' => str_repeat('0', 128)));
            tc_note_login_fail($db['settings'], $name);
            tc_fail(401, '用户名或密码错误');
        }
        if (!tc_verify_password($password, $found)) {
            tc_note_login_fail($db['settings'], $name);
            tc_fail(401, '用户名或密码错误');
        }
        tc_clear_login_fail($name);
        // 邮箱验证只约束「有邮箱且未验证」的用户;管理员代建的无邮箱账号不存在可验证的邮箱,
        // 若被此检查拦截将永远无法登录(历史版本创建的账号没有 emailVerifiedAt 字段)
        if (!empty($db['settings']['emailVerificationEnabled']) && empty($found['emailVerifiedAt']) && !empty($found['email'])) tc_fail(403, '请先验证邮箱后再登录');
        $user = $found;
        $settings = $db['settings'];
    });
    if (!$user || empty($user['id'])) tc_fail(401, '用户名或密码错误');
    $seenId = $user['id'];
    tc_with_db(true, function (&$db) use ($seenId, &$user, &$settings) {
        tc_touch_user($db, $seenId);
        foreach ($db['users'] as $u) {
            if ($u['id'] === $seenId) { $user = $u; break; }
        }
        $settings = $db['settings'];
    });
    tc_log_auth_event('auth', isset($user['name']) ? $user['name'] : '', '登录成功', $seenId);
    tc_json(200, array('token' => tc_issue_token($user, $settings), 'user' => tc_sanitize_user($user)));
}

// 登录/注册/游客等认证事件的日志(便于后台审计来源 IP)
function tc_log_auth_event($kind, $userName, $action, $userId = '') {
    $entry = array('kind' => $kind, 'userName' => (string) $userName, 'action' => (string) $action, 'ip' => tc_client_ip());
    if ($userId !== '') $entry['userId'] = (string) $userId;
    tc_push_log($entry);
}

// 游客登录:为每位访客自动创建一个独立账号(归入游客组、按 guestRounds 发放额度),
// 便于后台按用户维度管理、限轮与统计,而不是所有人共用一个匿名身份。
function tc_api_guest_login() {
    $GLOBALS['_tc_guest_new'] = false;
    $ctx = tc_with_db(true, function (&$db) {
        if (empty($db['settings']['guestEnabled'])) tc_fail(403, '游客体验已关闭，请注册或登录后使用');
        // 每 IP 每小时最多创建 20 个游客账号,防止被用来刷额度
        if (!tc_rate_limit_check('guest:' . tc_client_ip(), 20, 3600000)) {
            tc_fail(429, '游客账号创建过于频繁，请稍后再试');
        }
        $rounds = isset($db['settings']['guestRounds']) ? (int) $db['settings']['guestRounds'] : 3;
        $name = '';
        for ($try = 0; $try < 12; $try++) {
            $cand = '游客' . strtoupper(substr(bin2hex(random_bytes(6)), 0, 5));
            $taken = false;
            foreach ($db['users'] as $u) {
                if (isset($u['name']) && strtolower($u['name']) === strtolower($cand)) { $taken = true; break; }
            }
            if (!$taken) { $name = $cand; break; }
        }
        if ($name === '') tc_fail(500, '游客账号创建失败，请稍后重试');
        $guestGroup = tc_find_builtin_group($db, 'guest');
        $user = array(
            'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
            'quota' => 0, 'createdAt' => tc_now(), 'admin' => false, 'guest' => true,
            'groupId' => $guestGroup ? $guestGroup['id'] : tc_default_register_group($db),
            'tv' => 0, 'email' => '', 'emailVerifiedAt' => 1,
            'lastIp' => tc_client_ip(),
        );
        // 游客账号不设密码:仅凭令牌使用,防止被当作可登录账号
        tc_set_password($user, bin2hex(random_bytes(16)));
        $db['users'][] = $user;
        if ($rounds > 0) tc_add_quota($db, $user, $rounds);
        $GLOBALS['_tc_guest_new'] = true;
        return array('user' => $user, 'settings' => $db['settings']);
    });
    $user = $ctx['user'];
    tc_json(200, array(
        'token' => tc_issue_token($user, $ctx['settings']),
        'user' => tc_sanitize_user($user),
        'guest' => true,
        'rounds' => isset($ctx['settings']['guestRounds']) ? (int) $ctx['settings']['guestRounds'] : 3,
    ));
}

function tc_api_verify_email() {
    tc_with_db(true, function (&$db) {
        $b = tc_read_json_body(); $token = (string) ($b['token'] ?? ''); $hash = hash('sha256', $token); $now = tc_now();
        foreach ($db['users'] as &$u) if (!empty($u['emailTokenHash']) && hash_equals($u['emailTokenHash'], $hash) && (int) ($u['emailTokenExpires'] ?? 0) > $now) { $u['emailVerifiedAt'] = $now; $u['emailTokenHash'] = ''; $u['emailTokenExpires'] = 0; tc_json(200, array('ok' => true)); }
        unset($u); tc_fail(400, '验证链接无效或已过期');
    });
}

function tc_api_resend_verification() {
    tc_with_db(true, function (&$db) {
        // 每 IP 每小时 10 次,防邮件轰炸(邮件本身另有 60s/次的频控)
        if (!tc_rate_limit_check('resend-verify:' . tc_client_ip(), 10, 3600000)) {
            tc_fail(429, '请求过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(); $email = strtolower(trim((string) ($b['email'] ?? ''))); if (!filter_var($email, FILTER_VALIDATE_EMAIL)) tc_fail(400, '邮箱格式不正确');
        foreach ($db['users'] as &$u) if (strtolower((string) ($u['email'] ?? '')) === $email) { if (!empty($u['emailLastSentAt']) && tc_now() - (int) $u['emailLastSentAt'] < 60000) tc_fail(429, '邮件发送过于频繁，请稍后再试'); $token = bin2hex(random_bytes(24)); $u['emailLastSentAt'] = tc_now(); $u['emailTokenHash'] = hash('sha256', $token); $u['emailTokenExpires'] = tc_now() + 86400000; $link = tc_public_base_url() . '/login?verify=' . rawurlencode($token); [$subject, $html] = tc_render_mail_template($db['settings'], 'verify', isset($u['name']) ? $u['name'] : '', $link, '24 小时'); if (!tc_mail_send($db['settings'], $email, $subject, $html, '', $reMailErr)) tc_fail(400, $reMailErr !== '' ? ('验证邮件发送失败：' . $reMailErr) : '验证邮件发送失败'); break; }
        unset($u); tc_json(200, array('ok' => true));
    });
}

function tc_api_forgot_password() {
    tc_with_db(true, function (&$db) {
        if (empty($db['settings']['passwordResetEnabled'])) tc_fail(403, '找回密码功能未开启');
        // 每 IP 每小时 10 次,防邮件轰炸
        if (!tc_rate_limit_check('forgot:' . tc_client_ip(), 10, 3600000)) {
            tc_fail(429, '请求过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(); $email = strtolower(trim((string) ($b['email'] ?? ''))); if (!filter_var($email, FILTER_VALIDATE_EMAIL)) tc_fail(400, '邮箱格式不正确');
        // 管理员账号不走邮箱自助改密:邮箱一旦被接管(或本就是他人代管),等于把后台交出去。
        // 邮箱与账号是否存在不在此处区分,统一给出同一句提示,避免被用来探测账号。
        foreach ($db['users'] as &$u) if (strtolower((string) ($u['email'] ?? '')) === $email) {
            if (!empty($u['admin'])) { unset($u); tc_fail(403, '管理员账号不支持通过邮箱重置密码，请由其他管理员在后台重置或联系站点维护者'); }
            if (!empty($u['resetLastSentAt']) && tc_now() - (int) $u['resetLastSentAt'] < 60000) tc_fail(429, '邮件发送过于频繁，请稍后再试'); $token = bin2hex(random_bytes(24)); $u['resetLastSentAt'] = tc_now(); $u['resetTokenHash'] = hash('sha256', $token); $u['resetTokenExpires'] = tc_now() + 3600000; $link = tc_public_base_url() . '/login?reset=' . rawurlencode($token); [$subject, $html] = tc_render_mail_template($db['settings'], 'reset', isset($u['name']) ? $u['name'] : '', $link, '1 小时'); if (!tc_mail_send($db['settings'], $email, $subject, $html, '', $mailErr)) tc_fail(400, $mailErr !== '' ? ('重置邮件发送失败：' . $mailErr) : '重置邮件发送失败'); break; }
        unset($u); tc_json(200, array('ok' => true));
    });
}

function tc_api_reset_password() {
    tc_with_db(true, function (&$db) {
        if (empty($db['settings']['passwordResetEnabled'])) tc_fail(403, '找回密码功能未开启');
        $b = tc_read_json_body(); $token = (string) ($b['token'] ?? ''); $pwd = (string) ($b['password'] ?? ''); if (strlen($pwd) < 4 || strlen($pwd) > 128) tc_fail(400, '密码长度需为 4-128 个字符'); $hash = hash('sha256', $token); $now = tc_now();
        foreach ($db['users'] as &$u) if (!empty($u['resetTokenHash']) && hash_equals($u['resetTokenHash'], $hash) && (int) ($u['resetTokenExpires'] ?? 0) > $now) {
            // 管理员账号不发重置邮件(见 tc_api_forgot_password),这里再兜一层:
            // 历史遗留的重置 token 也不允许用来改管理员密码
            if (!empty($u['admin'])) { unset($u); tc_fail(403, '管理员账号不支持通过邮箱重置密码，请由其他管理员在后台重置'); }
            tc_set_password($u, $pwd); $u['resetTokenHash'] = ''; $u['resetTokenExpires'] = 0; tc_json(200, array('ok' => true));
        }
        unset($u); tc_fail(400, '重置链接无效或已过期');
    });
}

function tc_api_logout() {
    tc_with_db(false, function ($db) {
        $user = tc_auth_user($db);
        if ($user) tc_log_auth_event('auth', $user['name'], '退出登录', $user['id']);
        // 退出同时作废附件 Cookie:共享设备上换人使用时,不能靠旧 Cookie 继续读附件
        tc_note_attach_cookie_clear();
        // 工具箱页面 Cookie 同理:否则换人使用后旧 Cookie 还能打开上一位的工具
        tc_toolbox_cookie_clear();
        tc_json(200, array('ok' => true));
    });
}

// 换取一次性「第三方绑定票据」:绑定入口是导航跳转(无 Authorization 头),
// 前端先带登录态调这里拿票据,再跳 /auth/<provider>?bind=<uid>&t=<票据>
function tc_api_oauth_bind_ticket() {
    $b = tc_read_json_body(4 * 1024);
    $provider = strtolower(trim((string) (isset($b['provider']) ? $b['provider'] : '')));
    if ($provider === '') tc_fail(400, '缺少 provider');
    tc_with_db(false, function ($db) use ($provider) {
        $user = tc_require_auth($db);
        $cfg = isset($db['settings']['oauthProviders'][$provider]) && is_array($db['settings']['oauthProviders'][$provider])
            ? $db['settings']['oauthProviders'][$provider] : array();
        if (empty($cfg['enabled'])) tc_fail(400, '该登录方式未启用');
        tc_json(200, array('ok' => true, 'ticket' => tc_oauth_make_bind_ticket($user['id'], $provider)));
    });
}

function tc_api_me() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_json(200, array(
            'user' => tc_sanitize_user($user),
            // 本账号实际可用的拓展功能(总开关 × 「仅管理员 / 仅名单」访问级别)。
            // /api/config 是匿名的、发不出按人判定的结果,所以按人的那一层放在这里。
            'features' => tc_features_public($db, $user),
            'tools' => tc_user_tools_public($user, $db['settings']),
            'usage' => tc_usage_rows($db, $user['id'], tc_last_n_days(14)),
        ));
    });
}

function tc_api_save_tools() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $cur = tc_user_tools($user);
        $next = $cur;
        if (isset($b['webSearchSource'])) $next['webSearchSource'] = $b['webSearchSource'] === 'own' ? 'own' : 'platform';
        $prov = strtolower(trim((string) (isset($b['webSearchProvider']) ? $b['webSearchProvider'] : '')));
        if ($prov !== '') $next['webSearchProvider'] = in_array($prov, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true) ? $prov : 'ddg';
        if (isset($b['webSearchTavilyKey'])) {
            $key = trim((string) $b['webSearchTavilyKey']);
            if ($key !== '' && strpos($key, '••') === false) $next['webSearchTavilyKey'] = substr($key, 0, 200);
            if ($key === '') $next['webSearchTavilyKey'] = '';
        }
        if (isset($b['webSearchBraveKey'])) {
            $key = trim((string) $b['webSearchBraveKey']);
            if ($key !== '' && strpos($key, '••') === false) $next['webSearchBraveKey'] = substr($key, 0, 200);
            if ($key === '') $next['webSearchBraveKey'] = '';
        }
        if (isset($b['webSearchJinaKey'])) {
            $key = trim((string) $b['webSearchJinaKey']);
            if ($key !== '' && strpos($key, '••') === false) $next['webSearchJinaKey'] = substr($key, 0, 200);
            if ($key === '') $next['webSearchJinaKey'] = '';
        }
        if (isset($b['webSearchSearxUrl'])) $next['webSearchSearxUrl'] = tc_searx_urls_text($b['webSearchSearxUrl']);
        if (isset($b['webSearchMaxResults'])) $next['webSearchMaxResults'] = (int) $b['webSearchMaxResults'];
        if (isset($b['parseSource'])) $next['parseSource'] = $b['parseSource'] === 'own' ? 'own' : 'platform';
        if (isset($b['mineruToken'])) {
            $token = trim((string) $b['mineruToken']);
            if ($token !== '' && strpos($token, '••') === false) $next['mineruToken'] = substr($token, 0, 300);
            if ($token === '') $next['mineruToken'] = '';
        }
        $user['tools'] = tc_user_tools(array('tools' => $next));
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true, 'tools' => tc_user_tools_public($user, $db['settings'])));
    });
}

function tc_api_change_password() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        if (tc_is_demo_user($user)) tc_fail(403, '演示账号不允许修改密码');
        $oldPwd = (string) (isset($b['oldPassword']) ? $b['oldPassword'] : '');
        $newPwd = (string) (isset($b['newPassword']) ? $b['newPassword'] : '');
        // 第三方登录自动建号的用户从未设置过密码:允许直接设置,不要求「原密码」
        $hasPassword = isset($user['passwordHash']) && (string) $user['passwordHash'] !== '';
        if ($hasPassword && !tc_verify_password($oldPwd, $user)) tc_fail(400, '原密码不正确');
        if (strlen($newPwd) < 4) tc_fail(400, '新密码至少 4 个字符');
        if (strlen($newPwd) > 128) tc_fail(400, '新密码过长');
        if ($hasPassword && $newPwd === $oldPwd) tc_fail(400, '新密码不能与原密码相同');
        tc_set_password($user, $newPwd);
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true, 'token' => tc_issue_token($user, $db['settings'])));
    });
}

// 用户自助注销账号。后台可配置为「不允许 / 软注销 / 硬注销」。
// 安全性:有密码的账号必须验证密码;无密码(纯第三方)账号要求输入自己的用户名确认。
function tc_api_delete_own_account() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $mode = isset($db['settings']['accountDeletionMode']) ? (string) $db['settings']['accountDeletionMode'] : 'soft';
        if ($mode === 'off') tc_fail(403, '本站未开放账号注销');
        if (tc_is_demo_user($user)) tc_fail(403, '演示账号不允许注销');
        if (!empty($user['admin']) && !tc_is_demo_user($user)) {
            // 管理员销号会让站点失去管理入口,要求先取消管理员身份
            $others = 0;
            foreach ($db['users'] as $u) {
                if ($u['id'] === $user['id']) continue;
                if (!empty($u['admin']) && empty($u['demo'])) $others++;
            }
            if ($others === 0) tc_fail(400, '你是唯一的管理员，请先指定另一位管理员再注销');
        }
        // 身份确认:有密码走密码,无密码走「输入用户名」
        $hasPassword = isset($user['passwordHash']) && (string) $user['passwordHash'] !== '';
        if ($hasPassword) {
            $pwd = (string) (isset($b['password']) ? $b['password'] : '');
            if (!tc_verify_password($pwd, $user)) tc_fail(400, '密码不正确');
        } else {
            $confirm = trim((string) (isset($b['confirmName']) ? $b['confirmName'] : ''));
            if ($confirm === '' || $confirm !== (string) $user['name']) tc_fail(400, '请输入当前用户名以确认注销');
        }
        if ($mode === 'hard') {
            $res = tc_purge_user($db, $user['id']);
            tc_log_auth_event('auth', (string) $user['name'], '注销账号(删除全部数据)', $user['id']);
            tc_json(200, array('ok' => true, 'mode' => 'hard', 'removedProviders' => $res['removedProviders']));
        }
        $res = tc_soft_delete_user($db, $user['id']);
        if (empty($res['ok'])) tc_fail(500, '注销失败，请稍后重试');
        tc_log_auth_event('auth', (string) $user['name'], '注销账号(资料已清除，用户名与邮箱可重新注册)', $user['id']);
        tc_json(200, array('ok' => true, 'mode' => 'soft', 'newName' => $res['name']));
    });
}

// 修改用户名(第三方登录建号后常需改成自己习惯的名字)
function tc_api_change_name() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        if (tc_is_demo_user($user)) tc_fail(403, '演示账号不允许修改用户名');
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        if ($name === (string) $user['name']) tc_fail(400, '新用户名与当前相同');
        if (!tc_valid_name($name)) tc_fail(400, '用户名需 2-32 位（字母/数字/中文/._@-）');
        // 重名检查需要密码校验:避免被用于探测已有用户名
        $hasPassword = isset($user['passwordHash']) && (string) $user['passwordHash'] !== '';
        if ($hasPassword) {
            $pwd = (string) (isset($b['password']) ? $b['password'] : '');
            if (!tc_verify_password($pwd, $user)) tc_fail(400, '请输入当前密码以确认修改');
        }
        foreach ($db['users'] as $u) {
            if ((string) $u['id'] === (string) $user['id']) continue;
            if (strtolower((string) $u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
        }
        foreach ($db['users'] as $i => $u) {
            if ((string) $u['id'] !== (string) $user['id']) continue;
            $db['users'][$i]['name'] = $name;
            // 改名后让旧会话失效,重新签发
            $db['users'][$i]['tv'] = (isset($u['tv']) ? (int) $u['tv'] : 0) + 1;
            $user = $db['users'][$i];
            break;
        }
        tc_log_auth_event('auth', $name, '修改用户名', $user['id']);
        tc_json(200, array('ok' => true, 'user' => tc_sanitize_user($user), 'token' => tc_issue_token($user, $db['settings'])));
    });
}

function tc_api_list_providers() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $allowed = tc_user_access($db, $user);
        $list = array();
        $enabledIds = array();
        $seen = array();
        // 模型汇总:被汇总组覆盖的「渠道|模型」从各供应商里摘掉,前台就只剩汇总 ID 一条,
        // 看上去和「只加了一个供应商的一个模型」完全一样(这是本功能的核心诉求)。
        $aggOn = tc_model_groups_on($db);
        $memberKeys = $aggOn ? tc_model_group_member_keys($db, $user) : array();
        foreach (tc_visible_providers_of($db, $user) as $p) {
            $vis = tc_visible_provider($user, $p, $allowed);
            if (!$vis) continue;
            if ($memberKeys) {
                $pid = (string) $p['id'];
                $models = array();
                foreach ((isset($vis['models']) ? $vis['models'] : array()) as $m) {
                    if (!is_array($m) || !isset($m['id'])) continue;
                    if (isset($memberKeys[$pid . '|' . (string) $m['id']])) continue;
                    $models[] = $m;
                }
                if (!$models) continue;   // 模型已全部被汇总收纳,这条渠道不再单独出现
                $vis['models'] = $models;
            }
            $list[] = tc_client_provider($vis, isset($p['ownerId']) && $p['ownerId'] === $user['id'], !empty($user['admin']), !empty($user['demo']));
            $enabledIds[$p['id']] = true;
            $seen[$p['id']] = true;
        }
        // 汇总 ID 以「合成供应商」的形式注入(前端模型选择器遍历的就是供应商列表),
        // 每条只含一个模型条目,渲染出来就是一个普通模型项。管理员仍然看得见原始供应商
        // (仅限下方被停用的那些),便于回到后台管理。
        $aggOrder = array();
        if ($aggOn) {
            $aggOrder = tc_model_group_front_items($db, $user);
            foreach ($aggOrder as $it) $list[] = $it['payload'];
        }
        // 已停用的全局供应商仅下发给管理员,后台才能重新启用;普通用户完全不可见
        if (!empty($user['admin'])) {
            foreach ($db['providers'] as $p) {
                if (isset($seen[$p['id']])) continue;
                if (!(isset($p['scope']) && $p['scope'] === 'global')) continue;
                // 只在「停用」这一种漏网情形补发。启用中的渠道没进列表必有更具体的原因:
                // 要么该用户无权访问(补发会连授权一起绕过),要么它的模型已被汇总收纳 ——
                // 后者补回来就等于把原始条目又摆回前台,「只剩汇总 ID」当场失效。
                if (tc_provider_enabled($p)) continue;
                $list[] = tc_client_provider($p, false, true, false);
                $seen[$p['id']] = true;
            }
        }
        // 「只显示汇总 ID」:未进任何汇总组的模型一并隐藏(默认关闭,避免误伤未汇总的模型)
        if ($aggOn && !empty($db['settings']['modelAggHideUnmerged'])) {
            $aggIds = array();
            foreach ($aggOrder as $it) $aggIds[$it['payload']['id']] = true;
            $list = array_values(array_filter($list, function ($x) use ($aggIds) {
                return !empty($x['agg']) || isset($aggIds[$x['id']]);
            }));
        }
        // 汇总 ID 与供应商混排:同一套 order 序列决定前台先后,admin 追加的停用供应商除外
        if ($aggOn && $aggOrder) {
            $keep = array();
            foreach ($list as $i => $x) $keep[] = array('i' => $i, 'x' => $x);
            usort($keep, function ($a, $b) {
                $oa = isset($a['x']['order']) && is_numeric($a['x']['order']) ? (int) $a['x']['order'] : PHP_INT_MAX;
                $ob = isset($b['x']['order']) && is_numeric($b['x']['order']) ? (int) $b['x']['order'] : PHP_INT_MAX;
                if ($oa === $ob) return $a['i'] - $b['i'];
                return $oa < $ob ? -1 : 1;
            });
            $list = array();
            foreach ($keep as $k) $list[] = $k['x'];
        }
        // 默认供应商必须处于启用状态;被停用时对客户端视为无默认
        $defaultProviderId = $db['defaultProviderId'];
        if ($defaultProviderId && !isset($enabledIds[$defaultProviderId])) $defaultProviderId = null;
        // 汇总默认项:有汇总 ID 时用它作为默认选中(否则前台默认落在一条被摘空的原始渠道上)
        if ($aggOn && $aggOrder && !$defaultProviderId) $defaultProviderId = $aggOrder[0]['payload']['id'];
        tc_json(200, array(
            'providers' => $list,
            'defaultProviderId' => $defaultProviderId,
            'currentUserId' => $user['id'],
            'allowUserProviders' => !empty($db['settings']['allowUserProviders']),
            'isAdmin' => !empty($user['admin']),
            'modelAgg' => array('enabled' => $aggOn),
            'webSearch' => tc_web_search_public($db['settings']),
            'mineru' => tc_mineru_public($db['settings']),
            'chatLimits' => array(
                'contextMessages' => isset($db['settings']['contextMessages']) ? (int) $db['settings']['contextMessages'] : 40,
                'maxContextMessages' => isset($db['settings']['maxContextMessages']) ? (int) $db['settings']['maxContextMessages'] : 200,
            ),
        ));
    });
}

// 把启用中的汇总组包成「合成供应商」结构(每条只含一个模型条目),按前台顺序返回。
// 结构字段与 tc_client_provider 对齐,前端无需区分真假供应商即可渲染与选中。
// 候选为空的组(渠道都停了/都无权访问)直接跳过,不留一个选了就报错的空壳。
function tc_model_group_front_items($db, $user) {
    $out = array();
    foreach (tc_model_groups_ordered($db) as $g) {
        list($candidates, $err) = tc_model_group_candidates($db, $user, $g);
        if ($err !== '' || !$candidates) continue;
        $label = (string) (isset($g['label']) && $g['label'] !== '' ? $g['label'] : $g['id']);
        $cost = 0;
        foreach ($candidates as $c) {
            $cc = tc_model_cost($c['provider'], $c['model']);
            if ($cc > $cost) $cost = $cc;
        }
        if ($g['cost'] !== null) $cost = (float) $g['cost'];
        list($isImage, $isVideo) = tc_model_group_media_kind($g, $candidates);
        $model = array(
            'id' => (string) $g['id'],
            'name' => $label,
            'cost' => $cost,
            // 显式给出归类标记(即使为 false):避免前端再按名字猜一次而把汇总项分错组
            'image' => $isImage,
            'video' => $isVideo,
        );
        $out[] = array(
            'group' => $g,
            'payload' => array(
                'id' => 'agg:' . (string) $g['id'],
                'name' => $label,
                'baseUrl' => '',
                'apiFormat' => 'chat',
                'models' => array($model),
                'costPerCall' => $cost,
                'billingMode' => 'call',
                'pricePer1k' => 0,
                'scope' => 'global',
                'enabled' => true,
                'ownerId' => null,
                'mine' => false,
                'order' => (int) $g['order'],
                'apiKey' => '',
                'hasKey' => true,
                'keys' => array(),
                'keyRevealable' => false,
                'createdAt' => isset($g['updatedAt']) ? (int) $g['updatedAt'] : null,
                'updatedAt' => isset($g['updatedAt']) ? (int) $g['updatedAt'] : null,
                // 前端的标记位:agg=true 时标签直接显示模型名,不再拼「供应商@模型」
                'agg' => true,
                'aggStrategy' => (string) $g['strategy'],
                'aggCount' => count($candidates),
            ),
        );
    }
    return $out;
}

function tc_api_create_provider() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $wantGlobal = isset($b['scope']) && $b['scope'] === 'global' && !empty($user['admin']);
        if (!$wantGlobal && empty($db['settings']['allowUserProviders']) && empty($user['admin'])) {
            tc_fail(403, '管理员已关闭「用户自建供应商」功能');
        }
        $p = tc_normalize_provider_input($b, array('id' => tc_uid(), 'createdAt' => tc_now()), !empty($user['demo']));
        $err = tc_validate_provider($p);
        if ($err) tc_fail(400, $err);
        // 新增供应商默认排到末尾,可在后台用上下移动调整顺序
        if (!array_key_exists('order', $b) || !is_numeric($b['order'])) $p['order'] = tc_next_provider_order($db);
        $p['updatedAt'] = tc_now();
        if ($wantGlobal) {
            $p['ownerId'] = null;
            $p['scope'] = 'global';
            if (!empty($b['default']) || empty($db['defaultProviderId'])) $db['defaultProviderId'] = $p['id'];
        } else {
            $p['ownerId'] = $user['id'];
            $p['scope'] = 'user';
        }
        if (!array_key_exists('keyRevealable', $p)) $p['keyRevealable'] = true;
        // Key 以 AES-256-GCM 加密落库,密文与供应商 id/属主绑定
        if (!tc_is_encrypted_secret($p['apiKey']) && !tc_provider_set_key($p, $p['apiKey'])) {
            tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        }
        $db['providers'][] = $p;
        if ($wantGlobal) tc_grant_all_groups_provider($db, $p['id']);
        // 新加的模型若不在模型元数据表里,自动补一条兜底值并标记「待人工复核」
        tc_model_meta_ensure_auto($db, $p['models']);
        tc_json(200, array('provider' => tc_client_provider($p, true, !empty($user['admin']), !empty($user['demo']))));
    });
}

function tc_api_update_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $p = tc_find_editable_provider($db, $user, $id);
        $next = tc_normalize_provider_input($b, $p, !empty($user['demo']));
        $err = tc_validate_provider($next);
        if ($err) tc_fail(400, $err);
        $next['updatedAt'] = tc_now();
        if (!tc_is_encrypted_secret($next['apiKey']) && !tc_provider_set_key($next, $next['apiKey'])) {
            tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        }
        tc_replace_by_id($db['providers'], $id, $next);
        // 本次新增的模型同样补进模型元数据表(待人工复核),已有条目不覆盖
        tc_model_meta_ensure_auto($db, $next['models']);
        tc_json(200, array('provider' => tc_client_provider($next, true, !empty($user['admin']), !empty($user['demo']))));
    });
}

function tc_api_delete_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        tc_find_editable_provider($db, $user, $id);
        tc_remove_provider($db, $id);
        tc_json(200, array('ok' => true));
    });
}

// 点击小眼睛查看 Key:仅属主(个人供应商)或管理员(全局供应商),且保存时勾选了「保存后保持显示」
function tc_api_reveal_provider_key($id) {
    tc_with_db(false, function ($db) use ($id) {
        $user = tc_require_auth($db);
        $p = null;
        foreach ($db['providers'] as $x) if ($x['id'] === $id) { $p = $x; break; }
        if (!$p) tc_fail(404, '供应商不存在');
        // 演示管理员一律不可查看明文密钥:本站密钥是运营方的凭据,演示身份不应接触
        if (!empty($user['demo'])) tc_fail(403, '演示管理员不可查看供应商密钥');
        $isOwner = isset($p['ownerId']) && $p['ownerId'] === $user['id'];
        $isAdminGlobal = !empty($user['admin']) && (isset($p['scope']) && $p['scope'] === 'global');
        if (!$isOwner && !$isAdminGlobal) tc_fail(403, '只能查看自己添加的供应商密钥');
        if (empty($p['keyRevealable'])) tc_fail(403, '保存时未勾选「保存后保持显示」，Key 不可查看');
        // 多密钥:可按 keyId 精确取回某一把;不传则取默认(第一把)
        $keyId = isset($_GET['keyId']) ? trim((string) $_GET['keyId']) : '';
        $plain = $keyId !== '' ? tc_provider_key_by_id($p, $keyId) : tc_provider_key($p);
        if ($plain === '') tc_fail(404, 'Key 缺失或解密失败');
        tc_json(200, array('key' => $plain));
    });
}

function tc_api_get_global_provider() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $g = null;
        foreach ($db['providers'] as $p) {
            if (isset($p['scope']) && $p['scope'] === 'global' && tc_provider_enabled($p)) { $g = $p; break; }
        }
        if (!$g) tc_json(200, array('provider' => null));
        tc_json(200, array('provider' => tc_client_provider($g, false, !empty($user['admin']), !empty($user['demo']))));
    });
}

function tc_api_sync_get_chats() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $deleted = tc_deleted_of($db, $user['id']);
        tc_json(200, array(
            'chats' => tc_chats_of($db, $user['id']),
            'revision' => tc_chat_revision_of($db, $user['id']),
            'demoRevertedAt' => tc_demo_reverted_at($db, $user['id']),
            // 已删除对话 id(墓碑):别的设备据此删除本地副本,A 删 B 也删
            'deletedIds' => (object) tc_deleted_cap_tombs($deleted['tombs']),
        ));
    });
}

// 该用户最近一次演示还原的时间戳(0=从未还原);客户端据此丢弃本地旧副本
function tc_demo_reverted_at($db, $userId) {
    $map = tc_assoc(isset($db['demoReverted']) ? $db['demoReverted'] : array());
    $uid = (string) $userId;
    return isset($map[$uid]) ? (int) $map[$uid] : 0;
}

function tc_api_sync_save_chats() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        // 同步限流:每用户每分钟 60 次,防大包体刷写
        if (!tc_rate_limit_check('sync:' . $user['id'], 60)) {
            tc_fail(429, '同步过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(16 * 1024 * 1024); // 16MB 上限:含图片附件的对话同步足够用,防止超大包体长时间占用写锁
        // 隐私模式:服务器不保存对话记录,客户端仅本地留存
        if (isset($db['settings']['persistChats']) && !$db['settings']['persistChats']) {
            tc_db_skip_write();
            tc_json(200, array('ok' => true, 'count' => 0, 'revision' => tc_chat_revision_of($db, $user['id']), 'persistChats' => false));
        }
        $current = tc_chat_revision_of($db, $user['id']);
        $base = isset($b['baseRevision']) ? (int) $b['baseRevision'] : $current;
        if ($base !== $current) {
            $deleted = tc_deleted_of($db, $user['id']);
            tc_json(409, array(
                'error' => array('message' => '聊天记录已在其他页面更新'),
                'chats' => tc_chats_of($db, $user['id']),
                'revision' => $current,
                'demoRevertedAt' => tc_demo_reverted_at($db, $user['id']),
                'deletedIds' => (object) tc_deleted_cap_tombs($deleted['tombs']),
            ));
        }
        $chats = tc_sanitize_chats(isset($b['chats']) ? $b['chats'] : array());
        // 本端主动删除 id(墓碑):显式带上,保证「删除后本端列表已空」时服务端也能归档
        $explicit = array();
        if (isset($b['deletedIds']) && is_array($b['deletedIds'])) {
            foreach (array_slice($b['deletedIds'], 0, 500) as $id) {
                $id = substr((string) $id, 0, 64);
                if ($id !== '') $explicit[$id] = true;
            }
        }
        // 删除时客户端可把被删对话的完整副本带上来留档(本端副本通常比云端最后一次推送更新)
        $provided = array();
        if (isset($b['deletedChats']) && is_array($b['deletedChats'])) {
            foreach (tc_sanitize_chats(array_slice($b['deletedChats'], 0, 20)) as $dc) $provided[$dc['id']] = $dc;
        }
        $deleted = tc_deleted_of($db, $user['id']);
        $tombs = $deleted['tombs'];
        $archived = $deleted['chats'];
        $beforeChats = tc_chats_of($db, $user['id']);
        $incomingIds = array();
        foreach ($chats as $c) $incomingIds[$c['id']] = true;
        $now = tc_now();
        // 「新列表里没有」只能当作删除信号的前提是本包覆盖了完整列表。超过 300 条时
        // tc_sanitize_chats 会截断,被截掉的对话并非用户删除——这类照旧只轮出活跃列表
        // 并静默留档(不立墓碑),否则一次超量同步会把还能用的对话误删到所有设备上。
        $rawIncoming = isset($b['chats']) && is_array($b['chats']) ? count($b['chats']) : 0;
        $payloadComplete = $rawIncoming <= 300;
        foreach ($beforeChats as $old) {
            if (!is_array($old) || empty($old['id'])) continue;
            $id = (string) $old['id'];
            if (isset($incomingIds[$id]) && !isset($explicit[$id])) continue;
            tc_deleted_archive_put($archived, $old);
            // 显式声明的删除一定有墓碑;缺包(超量截断)时只留档,不向其它设备传播删除
            if ($payloadComplete || isset($explicit[$id])) $tombs[$id] = $now;
        }
        // 客户端带来的被删副本:内容更新时覆盖留档
        foreach ($provided as $id => $dc) {
            tc_deleted_archive_put($archived, $dc);
            $tombs[$id] = $now;
        }
        foreach ($explicit as $id => $_) {
            if (!isset($tombs[$id])) $tombs[$id] = $now;
        }
        // 墓碑挡住复活:已删除的对话即使被旧设备回推,也不再进入在线列表。
        // 被挡下的副本先进留档,保证「只要对话存在过,云端就有记录」。
        $kept = array();
        foreach ($chats as $c) {
            if (isset($tombs[$c['id']])) { tc_deleted_archive_put($archived, $c); continue; }
            $kept[] = $c;
        }
        $chats = $kept;
        tc_set_chats($db, $user['id'], $chats);
        tc_set_deleted_of($db, $user['id'], array(
            'chats' => tc_deleted_cap_chats($archived),
            'tombs' => tc_deleted_cap_tombs($tombs),
        ));
        $deleted = tc_deleted_of($db, $user['id']);
        tc_json(200, array(
            'ok' => true,
            'count' => count($chats),
            'revision' => tc_chat_revision_of($db, $user['id']),
            'deletedIds' => (object) tc_deleted_cap_tombs($deleted['tombs']),
        ));
    });
}

function tc_api_sync_clear_chats() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        // 「清空全部」同样按软删除处理:内容进留档、id 立墓碑,管理员仍可查看/清理
        $deleted = tc_deleted_of($db, $user['id']);
        $tombs = $deleted['tombs'];
        $archived = $deleted['chats'];
        $now = tc_now();
        foreach (tc_chats_of($db, $user['id']) as $old) {
            if (!is_array($old) || empty($old['id'])) continue;
            tc_deleted_archive_put($archived, $old);
            $tombs[(string) $old['id']] = $now;
        }
        tc_set_deleted_of($db, $user['id'], array(
            'chats' => tc_deleted_cap_chats($archived),
            'tombs' => tc_deleted_cap_tombs($tombs),
        ));
        tc_set_chats($db, $user['id'], array());
        tc_json(200, array('ok' => true, 'revision' => tc_chat_revision_of($db, $user['id'])));
    });
}

function tc_api_create_share() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        // 限流与总量保护:分享是 8MB 级的永久数据,不设防会被恶意撑大数据库
        if (!tc_rate_limit_check('share:' . $user['id'], 20, 3600000)) {
            tc_fail(429, '创建分享过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(8 * 1024 * 1024);
        $title = substr(trim((string) (isset($b['title']) ? $b['title'] : '未命名对话')), 0, 120) ?: '未命名对话';
        $messages = tc_sanitize_share_messages(isset($b['messages']) ? $b['messages'] : array());
        if (!$messages) tc_fail(400, '对话为空，无法分享');
        // 每用户最多保留 200 条分享:超出时删除该用户最早的一条(分享链接随之失效)
        $mine = array();
        foreach ($db['shares'] as $sid => $s) if ((string) ($s['ownerId'] ?? '') === (string) $user['id']) $mine[$sid] = $s;
        if (count($mine) >= 200) {
            uasort($mine, function ($x, $y) { return ((int) ($x['createdAt'] ?? 0)) <=> ((int) ($y['createdAt'] ?? 0)); });
            $drop = array_key_first($mine);
            unset($db['shares'][$drop]);
        }
        $share = array(
            'id' => tc_uid(12),
            'ownerId' => $user['id'],
            'title' => $title,
            'messages' => $messages,
            'createdAt' => tc_now(),
            'updatedAt' => tc_now(),
        );
        $map = tc_assoc($db['shares']);
        $map[$share['id']] = $share;
        $db['shares'] = tc_object_map($map);
        tc_json(200, array('share' => tc_public_share($share), 'url' => '/s/' . $share['id']));
    });
}

function tc_api_get_share($id) {
    tc_with_db(false, function ($db) use ($id) {
        $map = tc_assoc($db['shares']);
        if (empty($map[$id])) tc_fail(404, '分享不存在或已失效');
        tc_json(200, array('share' => tc_public_share($map[$id])));
    });
}

// ============ 服务器实时指标(后台概览顶部看板) ============
// 采集 CPU / 内存 / 磁盘 / 负载 / 在线人数 / 站点统计等。
// 所有取值都做了「函数不可用/无权限」的兜底,取不到就返回 null,前端隐藏该项而不是显示 0(避免误导)。

// 读取 Linux 的 /proc 数据(Windows 上不存在,会返回 null 由上层兜底)
function tc_sys_meminfo() {
    static $cache = null;
    if ($cache !== null) return $cache;
    $cache = array();
    if (is_readable('/proc/meminfo')) {
        $txt = (string) @file_get_contents('/proc/meminfo');
        foreach (explode("\n", $txt) as $line) {
            if (preg_match('/^(\w+):\s+(\d+)\s*kB/i', trim($line), $m)) {
                $cache[$m[1]] = (int) $m[2] * 1024;
            }
        }
    }
    return $cache;
}

// 解析 /proc/stat 首行累计值,返回 array(total, idle)
function tc_sys_cpu_parse_stat($text) {
    if ($text === null || !preg_match('/^cpu\s+(.+)$/m', (string) $text, $m)) return null;
    $vals = array_map('intval', array_slice(preg_split('/\s+/', trim($m[1])), 0, 8));
    return array('total' => array_sum($vals), 'idle' => ($vals[3] ?? 0) + ($vals[4] ?? 0));
}

// 两次 /proc/stat 采样之间的使用率
function tc_sys_cpu_delta_percent($a, $b) {
    if (!is_array($a) || !is_array($b)) return null;
    $dt = $b['total'] - $a['total'];
    if ($dt <= 0) return null;
    return max(0, min(100, (int) round(($dt - ($b['idle'] - $a['idle'])) * 100 / $dt)));
}

// 解析 /proc/net/dev 文本:汇总非回环网卡的累计收(RX)发(TX)字节
function tc_sys_net_parse_dev($text) {
    $rx = 0; $tx = 0;
    foreach (explode("\n", (string) $text) as $line) {
        if (strpos($line, ':') === false) continue;   // 前两行是表头
        $p = explode(':', $line, 2);
        $if = trim($p[0]);
        if ($if === '' || $if === 'lo') continue;     // 回环不计入,否则本机进程互访会算成站外流量
        $f = preg_split('/\s+/', trim($p[1]));
        if (!is_array($f) || count($f) < 9) continue;
        $rx += (int) $f[0]; $tx += (int) $f[8];
    }
    return array($rx, $tx);
}

// 网卡累计字节数:优先 /proc/net/dev;部分 jail 只放行 sysfs,就逐个网卡读统计文件
function tc_sys_net_totals() {
    $dev = tc_sys_read_text('/proc/net/dev');
    if ($dev !== null) return tc_sys_net_parse_dev($dev);
    $rx = 0; $tx = 0; $any = false;
    foreach ((array) @scandir('/sys/class/net') as $if) {
        if ($if === '.' || $if === '..' || $if === 'lo') continue;
        $r = tc_sys_read_text('/sys/class/net/' . $if . '/statistics/rx_bytes');
        $t = tc_sys_read_text('/sys/class/net/' . $if . '/statistics/tx_bytes');
        if ($r === null || $t === null) continue;
        $rx += (int) $r; $tx += (int) $t; $any = true;
    }
    return $any ? array($rx, $tx) : null;
}

// 实时指标:CPU 使用率与上下行网速都靠两次采样求增量,合在一次采样里做完,只睡一次 120ms。
// 结果缓存 5 秒,避免每次打开后台看板都阻塞一个 PHP 进程;全读不到时不睡,直接返回空值。
function tc_sys_realtime() {
    $cached = tc_sys_cache('rt');
    if ($cached !== null && tc_now() - $cached['t'] < 5000) return $cached['v'];
    $out = array('cpuPercent' => null, 'netRxBps' => null, 'netTxBps' => null, 'netRxBytes' => null, 'netTxBytes' => null);
    $hasCpu = tc_sys_read_text('/proc/stat') !== null;
    $hasNet = tc_sys_read_text('/proc/net/dev') !== null || is_dir('/sys/class/net');
    if ($hasCpu || $hasNet) {
        $t0 = microtime(true);
        $cpuA = $hasCpu ? tc_sys_cpu_parse_stat(tc_sys_read_text('/proc/stat')) : null;
        $netA = $hasNet ? tc_sys_net_totals() : null;
        usleep(120000);
        $elapsed = microtime(true) - $t0;
        if ($hasCpu) $out['cpuPercent'] = tc_sys_cpu_delta_percent($cpuA, tc_sys_cpu_parse_stat(tc_sys_read_text('/proc/stat')));
        if ($netA !== null) {
            $netB = tc_sys_net_totals();
            if (is_array($netB) && $elapsed > 0) {
                $out['netRxBps'] = max(0, (int) round(($netB[0] - $netA[0]) / $elapsed));
                $out['netTxBps'] = max(0, (int) round(($netB[1] - $netA[1]) / $elapsed));
                $out['netRxBytes'] = (int) $netB[0];
                $out['netTxBytes'] = (int) $netB[1];
            }
        }
    }
    return tc_sys_cache('rt', array('t' => tc_now(), 'v' => $out))['v'];
}

// 系统运行时长:/proc/uptime 第一列(秒);容器里读到的是宿主机时长,虚拟主机屏蔽 /proc 时为空
function tc_sys_uptime_sec() {
    $txt = tc_sys_read_text('/proc/uptime');
    if ($txt === null) return null;
    $parts = preg_split('/\s+/', trim($txt));
    $sec = isset($parts[0]) ? (float) $parts[0] : 0;
    return $sec > 0 ? (int) round($sec) : null;
}

// 数据库占用:SQLite 主文件 + WAL/SHM(WAL 未合并时可能比主文件还大)
function tc_sys_db_bytes() {
    $base = tc_data_dir() . '/tinychat.sqlite';
    $bytes = 0; $any = false;
    foreach (array('', '-wal', '-shm') as $suffix) {
        if (!is_file($base . $suffix)) continue;
        $sz = @filesize($base . $suffix);
        if ($sz === false) continue;
        $bytes += (int) $sz; $any = true;
    }
    return $any ? $bytes : null;
}

function tc_sys_loadavg() {
    if (!function_exists('sys_getloadavg')) return null;
    $la = @sys_getloadavg();
    if (!is_array($la) || count($la) < 3) return null;
    return array(round($la[0], 2), round($la[1], 2), round($la[2], 2));
}

function tc_sys_cpu_cores() {
    if (is_readable('/proc/cpuinfo')) {
        $n = substr_count((string) @file_get_contents('/proc/cpuinfo'), 'processor');
        if ($n > 0) return $n;
    }
    // Windows 没有 /proc,系统环境变量里有核心数
    $env = getenv('NUMBER_OF_PROCESSORS');
    if ($env !== false && (int) $env > 0) return (int) $env;
    return null;
}

// ---- 虚拟主机/容器配额(cgroup v1 / v2) ----
// 共享主机与容器常把 /proc/meminfo、/proc/stat 连同 open_basedir 一起屏蔽掉,但 cgroup 的
// memory.current/max 与 cpu.stat 一般仍可读,给出的正是「本账户套餐」的用量与上限。
// 只认「有明确上限、且小于整机」的配额:不限量(v1 哨兵值 / v2 的 "max")或与整机同级的读数
// 一律当作没有配额,否则会把宿主机数字冒充成套餐值,比不显示更误导。

// cgroup 读取根:生产环境始终为空(即文件系统根);单元测试传参换成一个假根
// (内含 sys/fs/cgroup 与 proc/self/cgroup),用来在无 cgroup 的机器上验证路径选择与配额解析
function tc_sys_cgroup_fsroot($set = null) {
    static $root = '';
    if ($set !== null) $root = (string) $set;
    return $root;
}

// 指标采集结果的进程内缓存:$key 传 null 清空(切换假根的测试用),传值写入,不传读取
function tc_sys_cache($key, $val = null) {
    static $c = array();
    if ($key === null) { $c = array(); return null; }
    if ($val !== null) { $c[$key] = $val; return $val; }
    return isset($c[$key]) ? $c[$key] : null;
}

// 清空采集缓存(切换假根/多次取数时用);假根本身由 tc_sys_cgroup_fsroot() 单独设置
function tc_sys_reset_cache() {
    tc_sys_cache(null);
}

// 当前进程在各控制器下的 cgroup 相对路径;$controller 传 '' 取 v2 统一层级
function tc_sys_cgroup_rel($controller = '') {
    $map = tc_sys_cache('rel');
    if ($map === null) {
        $map = array();
        $selfCgroup = tc_sys_cgroup_fsroot() . '/proc/self/cgroup';
        if (@is_readable($selfCgroup)) {
            foreach (explode("\n", (string) @file_get_contents($selfCgroup)) as $line) {
                // v1 形如 "5:cpu,cpuacct:/user.slice/x",v2 为 "0::/x"(控制器名为空)
                if (preg_match('#^\d+:([^:]*):(\S*)$#', trim($line), $m)) {
                    foreach (explode(',', $m[1]) as $c) $map[$c] = rtrim($m[2], '/');
                }
            }
        }
        tc_sys_cache('rel', $map);
    }
    return isset($map[$controller]) ? $map[$controller] : '';
}

function tc_sys_read_text($file) {
    if (!@is_readable($file)) return null;
    $v = @file_get_contents($file);
    return $v === false ? null : trim((string) $v);
}

// 解析 cgroup 内存上限:返回字节数;不限量、读不到、与整机同级都返回 null
function tc_sys_cgroup_mem_limit($limitRaw, $machineTotal = 0) {
    if ($limitRaw === null || !ctype_digit($limitRaw)) return null;  // "max" 或文件不可读
    $limit = (float) $limitRaw;
    if ($limit <= 0 || $limit > 1e15) return null;                    // v1 用近 2^63 哨兵表示不限量
    if ($machineTotal > 0 && $limit >= $machineTotal) return null;    // 与整机同级=宿主机上限,不是套餐
    return (int) $limit;
}

// 解析 v2 的 cpu.max("quota period",quota 为 max 表示不限量)为核数
function tc_sys_cgroup_cpu_max_cores($raw) {
    if ($raw === null || !preg_match('#^(\d+)\s+(\d+)$#', trim($raw), $m)) return null;
    $period = (int) $m[2];
    if ($period <= 0) return null;
    return ((int) $m[1]) / $period;
}

// 解析 v1 的 cfs 配额(cpu.cfs_quota_us / cpu.cfs_period_us,-1 表示不限量)为核数
function tc_sys_cgroup_cfs_cores($quotaRaw, $periodRaw) {
    if ($quotaRaw === null || $periodRaw === null) return null;
    $q = (int) trim($quotaRaw); $p = (int) trim($periodRaw);
    if ($q <= 0 || $p <= 0) return null;
    return $q / $p;
}

// 从 v2 的 cpu.stat 文本取累计 CPU 时间(纳秒)
function tc_sys_cgroup_usage_ns($statRaw) {
    if ($statRaw === null || !preg_match('/^usage_usec\s+(\d+)$/m', $statRaw, $m)) return null;
    return (float) $m[1] * 1000;
}

// 两次累计用量(纳秒)在 elapsed 秒内折算出的实际核数
function tc_sys_cgroup_cores_used($aNs, $bNs, $elapsedSec) {
    if ($aNs === null || $bNs === null || $bNs <= $aNs || $elapsedSec <= 0) return null;
    return ($bNs - $aNs) / 1e9 / $elapsedSec;
}

// 本账户 cgroup 内存配额:array(version, usedBytes, limitBytes),没有配额返回空数组
function tc_sys_cgroup_mem() {
    $out = tc_sys_cache('mem');
    if ($out !== null) return $out;
    $out = array();
    $meminfo = tc_sys_meminfo();
    $machineTotal = isset($meminfo['MemTotal']) ? (int) $meminfo['MemTotal'] : 0;
    $cands = array(
        array('v2', tc_sys_cgroup_fsroot() . '/sys/fs/cgroup' . tc_sys_cgroup_rel(''), 'memory.current', 'memory.max'),
        array('v1', tc_sys_cgroup_fsroot() . '/sys/fs/cgroup/memory' . tc_sys_cgroup_rel('memory'), 'memory.usage_in_bytes', 'memory.limit_in_bytes'),
    );
    foreach ($cands as $c) {
        $used = tc_sys_read_text($c[1] . '/' . $c[2]);
        if ($used === null || !ctype_digit($used)) continue;
        $limit = tc_sys_cgroup_mem_limit(tc_sys_read_text($c[1] . '/' . $c[3]), $machineTotal);
        if ($limit === null) continue;
        $out = array('version' => $c[0], 'usedBytes' => (int) $used, 'limitBytes' => $limit);
        break;
    }
    return tc_sys_cache('mem', $out);
}

// 由两次累计用量(纳秒)与配额折算看板数据:实际核数 + 相对配额的百分比。
// 有配额按配额折算;配额不限量但知道整机核数时按整机折算(此时不回报 coreLimit,避免被当成套餐值)。
function tc_sys_cgroup_cpu_result($version, $aNs, $bNs, $elapsedSec, $quotaCores, $machineCores) {
    $cores = tc_sys_cgroup_cores_used($aNs, $bNs, $elapsedSec);
    if ($cores === null) return array();
    $out = array('version' => $version, 'coreUsage' => round($cores, 2));
    if ($quotaCores !== null && $quotaCores > 0) {
        $out['coreLimit'] = round($quotaCores, 2);
        $out['percent'] = max(0, min(100, (int) round($cores * 100 / $quotaCores)));
    } elseif ($machineCores !== null && $machineCores > 0) {
        $out['percent'] = max(0, min(100, (int) round($cores * 100 / $machineCores)));
    }
    return $out;
}

// 本账户 cgroup CPU:两次采样得知实际核数,再对照配额给百分比。
// 采样要睡 120ms(与 /proc/stat 同代价),结果缓存 5 秒,避免每次打开后台都阻塞一个 PHP 进程。
function tc_sys_cgroup_cpu() {
    $cached = tc_sys_cache('cpu');
    if ($cached !== null && tc_now() - $cached['t'] < 5000) return $cached['v'];
    $out = array();
    $readUsage = null; $quotaCores = null; $version = '';
    $cg = tc_sys_cgroup_fsroot() . '/sys/fs/cgroup';
    $rel = tc_sys_cgroup_rel('');
    $stat = tc_sys_read_text($cg . $rel . '/cpu.stat');
    if ($stat !== null && tc_sys_cgroup_usage_ns($stat) !== null) {
        $version = 'v2';
        $readUsage = function () use ($cg, $rel) {
            return tc_sys_cgroup_usage_ns(tc_sys_read_text($cg . $rel . '/cpu.stat'));
        };
        $quotaCores = tc_sys_cgroup_cpu_max_cores(tc_sys_read_text($cg . $rel . '/cpu.max'));
    } else {
        $relAcct = tc_sys_cgroup_rel('cpuacct');
        $u = tc_sys_read_text($cg . '/cpuacct' . $relAcct . '/cpuacct.usage');
        if ($u !== null && ctype_digit($u)) {
            $version = 'v1';
            $readUsage = function () use ($cg, $relAcct) {
                $u = tc_sys_read_text($cg . '/cpuacct' . $relAcct . '/cpuacct.usage');
                return ($u !== null && ctype_digit($u)) ? (float) $u : null;
            };
            $relCpu = tc_sys_cgroup_rel('cpu');
            $quotaCores = tc_sys_cgroup_cfs_cores(
                tc_sys_read_text($cg . '/cpu' . $relCpu . '/cpu.cfs_quota_us'),
                tc_sys_read_text($cg . '/cpu' . $relCpu . '/cpu.cfs_period_us'));
        }
    }
    if ($readUsage !== null) {
        $t0 = microtime(true);
        $a = $readUsage();
        usleep(120000);
        $b = $readUsage();
        $out = tc_sys_cgroup_cpu_result($version, $a, $b, microtime(true) - $t0, $quotaCores, tc_sys_cpu_cores());
    }
    return tc_sys_cache('cpu', array('t' => tc_now(), 'v' => $out))['v'];
}

// 递归统计目录占用(带深度与文件数保护,避免超大目录拖慢后台)
function tc_dir_usage($dir, $maxFiles = 20000) {
    $out = array('bytes' => 0, 'files' => 0, 'truncated' => false);
    $dir = rtrim((string) $dir, '/\\');
    if ($dir === '' || !is_dir($dir)) return $out;
    $stack = array($dir);
    $seen = 0;
    while ($stack) {
        $cur = array_pop($stack);
        $items = @scandir($cur);
        if (!is_array($items)) continue;
        foreach ($items as $it) {
            if ($it === '.' || $it === '..') continue;
            $path = $cur . DIRECTORY_SEPARATOR . $it;
            if (@is_dir($path)) { $stack[] = $path; continue; }
            $sz = @filesize($path);
            if ($sz !== false) $out['bytes'] += (int) $sz;
            $out['files']++;
            if (++$seen >= $maxFiles) { $out['truncated'] = true; return $out; }
        }
    }
    return $out;
}

function tc_sys_disk() {
    $dir = tc_data_dir();
    $out = array('path' => $dir);
    $out['totalBytes'] = function_exists('disk_total_space') ? (@disk_total_space($dir) ?: null) : null;
    $out['freeBytes'] = function_exists('disk_free_space') ? (@disk_free_space($dir) ?: null) : null;
    return $out;
}

// 存储分类:每项给出路径、是否存在、文件数与占用
function tc_storage_categories() {
    $data = tc_data_dir();
    $dirs = array(
        array('key' => 'database', 'name' => '数据库', 'path' => $data . '/tinychat.sqlite', 'file' => true,
              'desc' => '站点全部数据（用户、对话、配置，SQLite 单文件）'),
        array('key' => 'imgstore', 'name' => '生图留存', 'path' => $data . '/imgstore',
              'desc' => '生图结果本地留存（防止上游链接过期）'),
        array('key' => 'imgcache', 'name' => '图片代理缓存', 'path' => $data . '/imgcache',
              'desc' => '同源代理抓取的图片缓存'),
        array('key' => 'notefiles', 'name' => '笔记附件', 'path' => $data . '/notes',
              'desc' => 'AI 笔记上传的图片与附件（按用户 ID 分目录，仅属主可读）'),
        array('key' => 'backup', 'name' => '数据备份', 'path' => $data . '/backup',
              'desc' => '后台备份产生的数据快照'),
        array('key' => 'tasks', 'name' => '任务记录', 'path' => $data . '/tasks',
              'desc' => '生视频/异步任务的状态文件'),
        array('key' => 'logs', 'name' => '运行日志', 'path' => $data . '/logs.ndjson', 'file' => true,
              'desc' => '后台「运行日志」页展示的记录'),
        array('key' => 'update', 'name' => '更新残留', 'path' => $data . '/update',
              'desc' => '在线更新下载的包与旧版本备份'),
        array('key' => 'other', 'name' => '其它数据目录文件', 'path' => $data, 'shallowFilesOnly' => true,
              'desc' => 'data/ 根目录下的零散文件（密钥、限流计数等）'),
    );
    $out = array();
    foreach ($dirs as $d) {
        $row = array('key' => $d['key'], 'name' => $d['name'], 'desc' => $d['desc'], 'exists' => file_exists($d['path']));
        if (!empty($d['file'])) {
            $sz = $row['exists'] ? @filesize($d['path']) : 0;
            $row['bytes'] = (int) ($sz ?: 0);
            $row['files'] = $row['exists'] ? 1 : 0;
        } elseif ($row['exists'] && is_dir($d['path'])) {
            if (!empty($d['shallowFilesOnly'])) {
                $bytes = 0; $files = 0;
                foreach ((array) @scandir($d['path']) as $it) {
                    if ($it === '.' || $it === '..') continue;
                    $p = $d['path'] . '/' . $it;
                    if (is_dir($p)) continue; // 子目录单独归类
                    $sz = @filesize($p);
                    if ($sz !== false) $bytes += (int) $sz;
                    $files++;
                }
                $row['bytes'] = $bytes; $row['files'] = $files;
            } else {
                $u = tc_dir_usage($d['path']);
                $row['bytes'] = $u['bytes']; $row['files'] = $u['files']; $row['truncated'] = $u['truncated'];
            }
        } else {
            $row['bytes'] = 0; $row['files'] = 0;
        }
        $out[] = $row;
    }
    return $out;
}

// 在线用户:lastSeen 在 N 分钟内的算在线(默认 5 分钟)
function tc_online_users($db, $minutes = 5) {
    $cut = tc_now() - $minutes * 60000;
    $online = 0; $recent = 0;
    $now = tc_now();
    foreach ($db['users'] as $u) {
        $seen = isset($u['lastSeen']) ? (float) $u['lastSeen'] : 0;
        if ($seen <= 0) continue;
        if ($seen >= $cut) $online++;
        if ($seen >= $now - 24 * 3600000) $recent++;
    }
    return array('online' => $online, 'active24h' => $recent);
}

function tc_api_admin_system() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $mem = tc_sys_meminfo();
        $totalMem = isset($mem['MemTotal']) ? (int) $mem['MemTotal'] : null;
        $availMem = isset($mem['MemAvailable']) ? (int) $mem['MemAvailable']
            : (isset($mem['MemFree']) ? (int) $mem['MemFree'] : null);
        $usedMem = ($totalMem !== null && $availMem !== null) ? max(0, $totalMem - $availMem) : null;
        $disk = tc_sys_disk();
        // PHP 进程自身内存(所有环境都有)
        $procMem = function_exists('memory_get_usage') ? (int) memory_get_usage(true) : null;
        // 实时指标(CPU + 网速)一次采完;虚拟主机取不到整机 CPU 时才退到 cgroup 配额
        $rt = tc_sys_realtime();
        $cpuPercent = $rt['cpuPercent'];
        $cgMem = tc_sys_cgroup_mem();
        $cgCpu = $cpuPercent === null ? tc_sys_cgroup_cpu() : array();
        $online = tc_online_users($db);
        // 今日调用与近 7 天
        $byDay = tc_assoc($db['stats']['callsByDay']);
        $sum7 = 0;
        foreach (tc_last_n_days(7) as $d) $sum7 += isset($byDay[$d]) ? (int) $byDay[$d] : 0;
        $pdo = null; // 数据库版本单独取,避免污染主连接
        $sqliteVer = '';
        try {
            $sqliteVer = (string) (new PDO('sqlite::memory:'))->query('select sqlite_version()')->fetchColumn();
        } catch (Throwable $e) { $sqliteVer = ''; }
        tc_json(200, array(
            'server' => array(
                'os' => php_uname('s') . ' ' . php_uname('r'),
                'host' => function_exists('gethostname') ? (string) @gethostname() : '',
                'phpVersion' => PHP_VERSION,
                'sqliteVersion' => $sqliteVer,
                'sapi' => PHP_SAPI,
                'arch' => php_uname('m'),
                'serverTime' => tc_now(),
                'timezone' => date_default_timezone_get(),
            ),
            'cpu' => array(
                'cores' => tc_sys_cpu_cores(),
                'percent' => $cpuPercent,
                'loadavg' => tc_sys_loadavg(),
            ),
            'memory' => array(
                'totalBytes' => $totalMem,
                'usedBytes' => $usedMem,
                'phpBytes' => $procMem,
                'phpLimitBytes' => (function () {
                    $v = ini_get('memory_limit');
                    if ($v === false || $v === '' || $v === '-1') return null;
                    $unit = strtolower(substr($v, -1));
                    $num = (int) $v;
                    if ($unit === 'g') return $num * 1073741824;
                    if ($unit === 'm') return $num * 1048576;
                    if ($unit === 'k') return $num * 1024;
                    return $num;
                })(),
            ),
            'disk' => $disk,
            // 账户配额(虚拟主机/容器):整机指标被屏蔽时前端用这一层兜底;source 为空表示两处都没读到
            'quota' => array(
                'source' => ($cgMem || $cgCpu)
                    ? 'cgroup ' . (isset($cgMem['version']) ? $cgMem['version'] : $cgCpu['version']) : '',
                'memUsedBytes' => isset($cgMem['usedBytes']) ? $cgMem['usedBytes'] : null,
                'memLimitBytes' => isset($cgMem['limitBytes']) ? $cgMem['limitBytes'] : null,
                'cpuPercent' => isset($cgCpu['percent']) ? $cgCpu['percent'] : null,
                'cpuCores' => isset($cgCpu['coreLimit']) ? $cgCpu['coreLimit'] : null,
                'cpuCoreUsage' => isset($cgCpu['coreUsage']) ? $cgCpu['coreUsage'] : null,
            ),
            'storage' => tc_storage_categories(),
            // 网速:下行=入站(rx,用户请求进来),上行=出站(tx,回复/图片发给用户)
            'net' => array(
                'rxBps' => $rt['netRxBps'],
                'txBps' => $rt['netTxBps'],
                'rxBytes' => $rt['netRxBytes'],
                'txBytes' => $rt['netTxBytes'],
            ),
            'uptime' => array(
                'systemSec' => tc_sys_uptime_sec(),
                'appSec' => tc_uptime_sec(),
            ),
            'db' => array('bytes' => tc_sys_db_bytes()),
            'users' => array(
                'total' => count($db['users']),
                'online' => $online['online'],
                'active24h' => $online['active24h'],
                'onlineWindowMin' => 5,
            ),
            'calls' => array(
                'total' => isset($db['stats']['totalCalls']) ? (int) $db['stats']['totalCalls'] : 0,
                'today' => isset($byDay[tc_today_key()]) ? (int) $byDay[tc_today_key()] : 0,
                'last7d' => $sum7,
            ),
            'content' => array(
                'chats' => tc_count_all_chats($db),
                'deletedChats' => tc_count_deleted_chats($db),
                'providers' => count($db['providers']),
                'groups' => count($db['userGroups']),
                'assistants' => count($db['assistants']),
            ),
            'version' => TC_VERSION,
        ));
    });
}

// 统计全部对话数(userChats 按用户分片)
function tc_count_all_chats($db) {
    $n = 0;
    foreach (tc_assoc(isset($db['userChats']) ? $db['userChats'] : array()) as $rows) {
        if (is_array($rows)) $n += count($rows);
    }
    return $n;
}

// 统计已删除对话留档条数(userDeletedChats 按用户分片)
function tc_count_deleted_chats($db) {
    $n = 0;
    foreach (tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array()) as $row) {
        $row = tc_assoc($row);
        if (isset($row['chats']) && is_array($row['chats'])) $n += count($row['chats']);
    }
    return $n;
}

// ============ 存储管理 ============
// action=list(默认) 分类占用 + 可清理项预览;action=clean 执行清理
function tc_api_admin_storage() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        $data = tc_data_dir();
        $cats = tc_storage_categories();
        $total = 0;
        foreach ($cats as $c) $total += (int) $c['bytes'];
        $disk = tc_sys_disk();
        // 备份与更新残留的详细信息(可单独清理)
        $backups = array();
        $bdir = $data . '/backup';
        if (is_dir($bdir)) {
            foreach ((array) @scandir($bdir) as $f) {
                if ($f === '.' || $f === '..') continue;
                $p = $bdir . '/' . $f;
                if (!is_file($p)) continue;
                $backups[] = array('name' => $f, 'bytes' => (int) @filesize($p), 'mtime' => (int) @filemtime($p) * 1000);
            }
            usort($backups, function ($a, $b) { return $b['mtime'] - $a['mtime']; });
        }
        // 生图留存:文件数 + 最近若干条(便于人工辨认)
        $imgFiles = array();
        $idir = $data . '/imgstore';
        if (is_dir($idir)) {
            foreach ((array) @scandir($idir) as $f) {
                if ($f === '.' || $f === '..') continue;
                $p = $idir . '/' . $f;
                if (!is_file($p)) continue;
                $imgFiles[] = array('name' => $f, 'bytes' => (int) @filesize($p), 'mtime' => (int) @filemtime($p) * 1000);
            }
            usort($imgFiles, function ($a, $b) { return $b['mtime'] - $a['mtime']; });
        }
        $logCount = 0;
        foreach ((array) tc_list_logs(TC_LOG_LIMIT) as $l) $logCount++;
        // 已删除对话留档:用户在会话里删除的对话仍保留在云端(软删除),这里给出汇总。
        // 演示管理员只拿匿名汇总(不暴露「哪个用户删了什么」)。
        $isDemo = tc_is_demo_user($admin);
        $deletedSummary = tc_admin_deleted_summary($db, $isDemo);
        tc_json(200, array(
            'categories' => $cats,
            'deleted' => $deletedSummary,
            'totalBytes' => $total,
            'disk' => $disk,
            // 演示管理员不下发服务器绝对路径,备份/留存明细也只留计数(文件名无授权含义)
            'dataDir' => $isDemo ? '' : $data,
            'backups' => array('items' => $isDemo ? array() : array_slice($backups, 0, 30), 'count' => count($backups),
                               'bytes' => array_sum(array_column($backups, 'bytes'))),
            'images' => array('items' => $isDemo ? array() : array_slice($imgFiles, 0, 30), 'count' => count($imgFiles),
                              'bytes' => array_sum(array_column($imgFiles, 'bytes'))),
            'logs' => array('count' => $logCount, 'bytes' => (int) (@filesize(tc_logs_file()) ?: 0), 'limit' => TC_LOG_LIMIT),
            'quotaMb' => isset($db['settings']['imageArchiveQuotaMb']) ? (int) $db['settings']['imageArchiveQuotaMb'] : 500,
            'archiveEnabled' => !empty($db['settings']['imageArchiveEnabled']),
        ));
    });
}

// 清理:imageCache(图片代理缓存) / images(生图留存) / backups(全部备份) / logs(运行日志)
function tc_api_admin_storage_clean() {
    tc_with_db(false, function ($db) {
        // 清理会删掉 data/backup(全部备份)、data/notes(笔记附件)等不可恢复的数据,
        // 演示管理员不得执行:演示身份的定位是可随意改设置,而不是能毁掉站点数据。
        $admin = tc_demo_guard(tc_require_admin($db), '演示管理员不可清理存储');
        $b = tc_read_json_body();
        $target = strtolower(trim((string) (isset($b['target']) ? $b['target'] : '')));
        $data = tc_data_dir();
        $removed = 0; $freed = 0; $label = '';
        // 注意:闭包必须把自己也 use 进来才能递归。PHP 匿名函数不继承外层作用域,
        // 之前漏了 &$rmDir,遇到子目录(如 data/update/backup/)会以「null 不可调用」致命失败,
        // 表现为「更新残留清理不了」。
        $rmDir = function ($dir) use (&$removed, &$freed, &$rmDir) {
            foreach ((array) @scandir($dir) as $f) {
                if ($f === '.' || $f === '..') continue;
                $p = $dir . '/' . $f;
                if (is_dir($p) && !is_link($p)) { $rmDir($p); @rmdir($p); continue; }
                $sz = @filesize($p);
                if (@unlink($p)) { $removed++; if ($sz !== false) $freed += (int) $sz; }
            }
        };
        if ($target === 'imagecache') {
            $label = '图片代理缓存';
            $rmDir($data . '/imgcache');
        } elseif ($target === 'images') {
            $label = '生图留存';
            $rmDir($data . '/imgstore');
        } elseif ($target === 'notefiles') {
            $label = '笔记附件';
            $rmDir($data . '/notes');
        } elseif ($target === 'backups') {
            $label = '数据备份';
            $rmDir($data . '/backup');
        } elseif ($target === 'logs') {
            $label = '运行日志';
            // 日志已迁移为 NDJSON 追加写;仍按 tc_logs_file() 定位,
            // 别写死旧文件名(logs.json),否则清理按钮看着成功、实际什么都没删。
            $p = tc_logs_file();
            if (is_file($p)) { $sz = (int) @filesize($p); if (@unlink($p)) { $removed = 1; $freed = $sz; } }
            // 迁移留档的旧文件一并清掉,避免它继续占 data/ 空间
            foreach ((array) @glob($data . '/logs.json.migrated*') as $legacy) {
                $sz = (int) @filesize($legacy);
                if (@unlink($legacy)) { $removed++; $freed += $sz; }
            }
        } elseif ($target === 'updates') {
            $label = '更新残留';
            $rmDir($data . '/update');
        } else {
            tc_fail(400, '未知的清理目标');
        }
        tc_log_auth_event('admin', isset($admin['name']) ? $admin['name'] : '', '清理' . $label . '（' . $removed . ' 个文件 / ' . round($freed / 1048576, 2) . 'MB）', isset($admin['id']) ? $admin['id'] : '');
        tc_json(200, array('ok' => true, 'removed' => $removed, 'freedBytes' => $freed, 'label' => $label));
    });
}

function tc_api_admin_stats() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        $isDemo = tc_is_demo_user($admin);
        tc_backup_maybe($db);
        $days = tc_last_n_days(14);
        $byDay = tc_assoc($db['stats']['callsByDay']);
        $trend = array();
        foreach ($days as $d) $trend[] = array('day' => $d, 'calls' => isset($byDay[$d]) ? (int) $byDay[$d] : 0);
        $top = array();
        foreach ($db['users'] as $u) {
            $top[] = array(
                'id' => $u['id'], 'name' => $u['name'], 'quota' => isset($u['quota']) ? $u['quota'] : 0,
                'admin' => !empty($u['admin']), 'groupId' => isset($u['groupId']) ? $u['groupId'] : null,
            );
        }
        usort($top, function ($a, $b) {
            if ($a['quota'] == $b['quota']) return 0;
            return ($a['quota'] < $b['quota']) ? 1 : -1;
        });
        $top = array_slice($top, 0, 5);
        // 演示管理员不应看到「谁额度最高」这类用户维度排行:匿名化并去掉可定位的 id
        if ($isDemo) {
            $top = array_map(function ($row, $i) {
                return array(
                    'id' => 'demo-' . ($i + 1), 'name' => '用户 ' . ($i + 1),
                    'quota' => $row['quota'], 'admin' => false, 'groupId' => null,
                );
            }, $top, array_keys($top));
        }
        $adminCount = 0; $globalCount = 0; $globalDisabled = 0;
        foreach ($db['users'] as $u) if (!empty($u['admin'])) $adminCount++;
        foreach ($db['providers'] as $p) {
            if (!(isset($p['scope']) && $p['scope'] === 'global')) continue;
            if (tc_provider_enabled($p)) $globalCount++; else $globalDisabled++;
        }
        $daysWindow = tc_last_n_days(14);
        $usageRows = tc_admin_usage_rows($db, $daysWindow);
        $mem = function_exists('memory_get_usage') ? (int) round(memory_get_usage(true) / 1048576) : 0;
        tc_json(200, array(
            'stats' => array(
                'totalCalls' => isset($db['stats']['totalCalls']) ? $db['stats']['totalCalls'] : 0,
                'totalQuotaGiven' => isset($db['stats']['totalQuotaGiven']) ? $db['stats']['totalQuotaGiven'] : 0,
                'userCount' => count($db['users']),
                'adminCount' => $adminCount,
                'providerCount' => count($db['providers']),
                'globalProviderCount' => $globalCount,
                'globalProviderDisabledCount' => $globalDisabled,
                'groupCount' => count($db['userGroups']),
                'defaultProviderId' => $db['defaultProviderId'],
                'todayCalls' => isset($byDay[tc_today_key()]) ? (int) $byDay[tc_today_key()] : 0,
                'trend' => $trend,
                'topUsers' => $top,
                'modelVotes' => tc_model_vote_rows($db),
                'usage' => $isDemo ? tc_demo_anonymize_usage($usageRows) : $usageRows,
                'uptimeSec' => tc_uptime_sec(),
                'version' => TC_VERSION,
                'memoryMB' => $mem,
            ),
            'freeQuota' => $db['settings']['freeQuota'],
            'freeQuotaUnlimited' => !empty($db['settings']['freeQuotaUnlimited']),
            'settings' => tc_admin_settings_public($db['settings'], $isDemo),
        ));
    });
}

// 演示管理员看用量明细时把「谁用了多少」匿名化,只保留汇总口径
function tc_demo_anonymize_usage($rows) {
    $out = array();
    foreach ((array) $rows as $i => $row) {
        if (!is_array($row)) continue;
        $row['userId'] = 'demo-' . ($i + 1);
        $row['name'] = '用户 ' . ($i + 1);
        $out[] = $row;
    }
    return $out;
}

function tc_api_vote() {
    tc_with_db(true, function (&$db) {
        tc_require_auth($db);
        $b = tc_read_json_body();
        $model = substr(trim((string) (isset($b['model']) ? $b['model'] : '')), 0, 80);
        if ($model === '') tc_fail(400, '缺少模型');
        $from = isset($b['from']) ? (string) $b['from'] : '';
        $to = isset($b['to']) ? (string) $b['to'] : '';
        if ($from !== '' && $from !== 'up' && $from !== 'down') tc_fail(400, '投票无效');
        if ($to !== '' && $to !== 'up' && $to !== 'down') tc_fail(400, '投票无效');
        tc_apply_model_vote($db, $model, $from, $to);
        $votes = tc_assoc(isset($db['stats']['modelVotes']) ? $db['stats']['modelVotes'] : array());
        $row = tc_assoc(isset($votes[$model]) ? $votes[$model] : array());
        tc_json(200, array(
            'ok' => true,
            'model' => $model,
            'up' => isset($row['up']) ? (int) $row['up'] : 0,
            'down' => isset($row['down']) ? (int) $row['down'] : 0,
        ));
    });
}

function tc_package_public($p) {
    return array('id' => $p['id'], 'name' => $p['name'], 'quota' => $p['quota'], 'priceLabel' => $p['priceLabel'], 'price' => isset($p['price']) ? $p['price'] : null, 'validityDays' => isset($p['validityDays']) ? (int) $p['validityDays'] : 0, 'limitPerUser' => isset($p['limitPerUser']) ? (int) $p['limitPerUser'] : 1, 'description' => $p['description'], 'purchaseUrl' => $p['purchaseUrl'], 'enabled' => !empty($p['enabled']));
}

function tc_api_list_packages() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $out = array();
        foreach ((array) $db['packages'] as $p) if (!empty($p['enabled'])) {
            $pub = tc_package_public($p);
            $pub['free'] = (isset($p['price']) && $p['price'] !== null && (float) $p['price'] == 0);
            if (!empty($pub['free'])) {
                $limit = isset($p['limitPerUser']) ? (int) $p['limitPerUser'] : 1;
                $claimed = 0;
                foreach ($db['quotaLedger'] as $e) {
                    if ((isset($e['userId']) && $e['userId'] === $user['id']) && (isset($e['source']) && $e['source'] === 'package_claim') && (isset($e['packageId']) && $e['packageId'] === $p['id'])) $claimed++;
                }
                $pub['claimedCount'] = $claimed;
                $pub['claimed'] = ($limit !== -1 && $claimed >= $limit);
            }
            $out[] = $pub;
        }
        tc_json(200, array('packages' => $out));
    });
}

function tc_api_admin_list_packages() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $pkgs = array(); foreach ((array) $db['packages'] as $p) $pkgs[$p['id']] = $p;
        $users = array(); foreach ((array) $db['users'] as $u) $users[$u['id']] = $u;
        $codes = array();
        foreach ((array) $db['redemptionCodes'] as $c) {
            $isFixed = (isset($c['type']) && $c['type'] === 'fixed');
            $pkg = (!$isFixed && isset($pkgs[$c['packageId']])) ? $pkgs[$c['packageId']] : null;
            $codes[] = array(
                'id' => $c['id'],
                'type' => $isFixed ? 'fixed' : 'random',
                // 固定码明文直接展示;随机码仍只给掩码,明文走导出接口
                'codeMask' => $isFixed ? (isset($c['code']) ? $c['code'] : '') : substr($c['codeHash'], 0, 10) . '…',
                'packageId' => $isFixed ? '' : $c['packageId'],
                'packageName' => $isFixed ? '固定兑换码' : ($pkg ? $pkg['name'] : '已删除套餐'),
                'status' => $c['status'],
                'quota' => $isFixed ? (isset($c['quota']) ? $c['quota'] : 0) : null,
                'maxRedemptions' => $isFixed ? (isset($c['maxRedemptions']) ? (int) $c['maxRedemptions'] : 1) : null,
                'usedCount' => $isFixed ? (isset($c['usedCount']) ? (int) $c['usedCount'] : 0) : null,
                'expiresAt' => $isFixed ? (isset($c['expiresAt']) ? (int) $c['expiresAt'] : 0) : null,
                'perUserLimit' => $isFixed ? !empty($c['perUserLimit']) : null,
                'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : '',
                'usedAt' => isset($c['usedAt']) ? $c['usedAt'] : '',
                'usedByName' => (isset($c['usedBy']) && isset($users[$c['usedBy']])) ? $users[$c['usedBy']]['name'] : '',
            );
        }
        tc_json(200, array('packages' => array_values($db['packages']), 'codes' => $codes));
    });
}

function tc_api_admin_delete_code($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $before = count($db['redemptionCodes']);
        $db['redemptionCodes'] = array_values(array_filter($db['redemptionCodes'], function ($c) use ($id) { return $c['id'] !== $id; }));
        if (count($db['redemptionCodes']) === $before) tc_fail(404, '兑换码不存在');
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_prune_codes() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $status = ($b['status'] ?? '') === 'unused' ? 'unused' : 'used';
        $packageId = trim((string) (isset($b['packageId']) ? $b['packageId'] : ''));
        $before = count($db['redemptionCodes']);
        $db['redemptionCodes'] = array_values(array_filter($db['redemptionCodes'], function ($c) use ($status, $packageId) {
            if ((isset($c['status']) ? $c['status'] : 'unused') !== $status) return true;
            if ($packageId !== '' && (isset($c['packageId']) ? $c['packageId'] : '') !== $packageId) return true;
            return false;
        }));
        tc_json(200, array('ok' => true, 'removed' => $before - count($db['redemptionCodes'])));
    });
}

// 按套餐导出未使用兑换码的明文(旧版码只存哈希,无法导出)
function tc_api_admin_export_codes($id) {
    tc_with_db(false, function ($db) use ($id) {
        tc_require_admin($db);
        $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $id) $pkg = $p;
        if (!$pkg) tc_fail(404, '套餐不存在');
        $codes = array(); $missing = 0;
        foreach ((array) $db['redemptionCodes'] as $c) {
            if ((isset($c['packageId']) ? $c['packageId'] : '') !== $id) continue;
            if ((isset($c['status']) ? $c['status'] : 'unused') !== 'unused') continue;
            if (!empty($c['code'])) $codes[] = array('code' => $c['code'], 'createdAt' => isset($c['createdAt']) ? $c['createdAt'] : 0);
            else $missing++;
        }
        tc_json(200, array('packageName' => $pkg['name'], 'codes' => $codes, 'count' => count($codes), 'missing' => $missing));
    });
}

function tc_api_admin_save_package() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db); $b = tc_read_json_body();
        $id = trim((string) (isset($b['id']) ? $b['id'] : ''));
        $price = (isset($b['price']) && (string) $b['price'] !== '') ? round((float) $b['price'], 2) : null;
        if ($price !== null && $price < 0) $price = 0;
        $validityDays = (isset($b['validityDays']) && (string) $b['validityDays'] !== '') ? max(0, (int) $b['validityDays']) : 0;
        $limitPerUser = (int) (isset($b['limitPerUser']) ? $b['limitPerUser'] : 1);
        $limitPerUser = max(-1, min(999, $limitPerUser));
        $p = array('id' => $id ?: tc_uid(8), 'name' => substr(trim((string) ($b['name'] ?? '')), 0, 80), 'quota' => ((string) ($b['quota'] ?? '') === '-1' ? -1 : max(0, (int) ($b['quota'] ?? 0))), 'priceLabel' => substr(trim((string) ($b['priceLabel'] ?? '')), 0, 60), 'price' => $price, 'validityDays' => $validityDays, 'limitPerUser' => $limitPerUser, 'description' => substr(trim((string) ($b['description'] ?? '')), 0, 500), 'purchaseUrl' => preg_match('/^https?:\/\//i', trim((string) ($b['purchaseUrl'] ?? ''))) ? substr(trim((string) ($b['purchaseUrl'] ?? '')), 0, 500) : '', 'enabled' => !empty($b['enabled']), 'createdAt' => tc_now());
        if ($p['name'] === '' || $p['quota'] === 0) tc_fail(400, '套餐名称和额度不能为空');
        if ($id === '') { foreach ($db['packages'] as $old) if ($old['id'] === $p['id']) tc_fail(409, '套餐 ID 冲突'); }
        $found = false; foreach ($db['packages'] as $i => $old) if ($old['id'] === $p['id']) { $p['createdAt'] = $old['createdAt'] ?? $p['createdAt']; $db['packages'][$i] = $p; $found = true; }
        if (!$found) $db['packages'][] = $p;
        tc_json(200, array('package' => $p));
    });
}

// 0 元套餐直接领取:每个用户每套餐限领一次
function tc_api_claim_package() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db); $b = tc_read_json_body();
        // 游客仅享有体验轮数,不得领取套餐额度(否则可反复领免费套餐绕过体验限制)
        if (!empty($user['guest'])) tc_fail(403, '游客不能领取套餐，请先注册账号');
        $pid = trim((string) (isset($b['packageId']) ? $b['packageId'] : ''));
        $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $pid) $pkg = $p;
        if (!$pkg) tc_fail(404, '套餐不存在');
        if (empty($pkg['enabled'])) tc_fail(410, '套餐已停用');
        if (!isset($pkg['price']) || $pkg['price'] === null || (float) $pkg['price'] > 0) tc_fail(400, '该套餐不是免费套餐，请通过购买链接或兑换码开通');
        // 每人可领取次数:-1 不限,0 不可领取,>=1 每人限 N 次
        $limit = isset($pkg['limitPerUser']) ? (int) $pkg['limitPerUser'] : 1;
        $claimed = 0;
        foreach ($db['quotaLedger'] as $e) {
            if ((isset($e['userId']) && $e['userId'] === $user['id']) && (isset($e['source']) && $e['source'] === 'package_claim') && (isset($e['packageId']) && $e['packageId'] === $pid)) $claimed++;
        }
        if ($limit === 0) tc_fail(400, '该套餐未开放领取');
        if ($limit !== -1 && $claimed >= $limit) tc_fail(409, '该套餐每人限领 ' . $limit . ' 次，你已领取 ' . $claimed . ' 次');
        tc_enforce_quota_expiry($db, $user);
        $exp = (!empty($pkg['validityDays']) && $pkg['quota'] !== -1) ? tc_now() + ((int) $pkg['validityDays']) * 86400000 : 0;
        tc_add_quota($db, $user, $pkg['quota'], $exp);
        $entry = array('id' => tc_uid(8), 'userId' => $user['id'], 'amount' => $pkg['quota'], 'source' => 'package_claim', 'packageId' => $pkg['id'], 'packageName' => $pkg['name'], 'createdAt' => tc_now());
        if ($exp > 0) $entry['expiresAt'] = $exp;
        $db['quotaLedger'][] = $entry;
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true, 'user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_get_thinking() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_json(200, array('thinking' => tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null)));
    });
}

function tc_api_admin_save_thinking() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $t = is_array(isset($b['thinking']) ? $b['thinking'] : null) ? $b['thinking'] : array();
        $cur = tc_normalize_thinking(isset($db['settings']['thinking']) ? $db['settings']['thinking'] : null);
        $submitted = tc_normalize_thinking(array(
            'defaultEffort' => isset($t['defaultEffort']) ? $t['defaultEffort'] : 'medium',
            'allowUserOverride' => isset($t['allowUserOverride']) ? $t['allowUserOverride'] : true,
            'autoLearn' => isset($t['autoLearn']) ? $t['autoLearn'] : true,
            'rules' => isset($t['rules']) ? $t['rules'] : array(),
        ));
        // 页面打开期间可能有新的自动学习结果:提交里没有、且未被显式删除的自动规则保留
        $deletedAuto = array();
        foreach ((array) (isset($b['deletedAutoIds']) ? $b['deletedAutoIds'] : array()) as $id) $deletedAuto[] = (string) $id;
        $submittedAutoIds = array();
        foreach ($submitted['rules'] as $r) if (($r['source'] ?? '') === 'auto') $submittedAutoIds[] = $r['id'];
        $keptAuto = array();
        foreach ($cur['rules'] as $r) {
            if (($r['source'] ?? '') !== 'auto') continue;
            if (in_array((string) $r['id'], $deletedAuto, true)) continue;
            if (in_array((string) $r['id'], $submittedAutoIds, true)) continue;
            $keptAuto[] = $r;
        }
        $final = $submitted;
        $final['rules'] = array_merge($keptAuto, $submitted['rules']);
        $db['settings']['thinking'] = tc_normalize_thinking($final);
        tc_json(200, array('thinking' => $db['settings']['thinking']));
    });
}

function tc_api_admin_delete_package($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $before = count($db['packages']);
        $db['packages'] = array_values(array_filter($db['packages'], function ($p) use ($id) { return $p['id'] !== $id; }));
        if (count($db['packages']) === $before) tc_fail(404, '套餐不存在');
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_generate_codes($id) {
    tc_with_db(true, function (&$db) use ($id) {
        // 兑换码能直接换到额度,而 redemptionCodes 不在演示快照内 —— 演示管理员造的码
        // 在演示到期还原后依然有效,等于绕过「改动会自动还原」的承诺(与邀请码同口径拒绝)。
        tc_demo_guard(tc_require_admin($db), '演示管理员不能生成兑换码');
        $b = tc_read_json_body(); $n = min(500, max(1, (int) ($b['count'] ?? 1))); $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $id) $pkg = $p; if (!$pkg) tc_fail(404, '套餐不存在');
        // 明文与哈希同时保存,供之后按套餐导出未使用兑换码
        $plain = array(); for ($i=0; $i<$n; $i++) { $code = strtoupper(bin2hex(random_bytes(8))); $db['redemptionCodes'][] = array('id'=>tc_uid(8),'packageId'=>$id,'type'=>'random','code'=>$code,'codeHash'=>hash('sha256', $code),'status'=>'unused','createdAt'=>tc_now()); $plain[] = $code; }
        tc_json(200, array('codes' => $plain, 'count' => count($plain)));
    });
}

// 添加固定兑换码:自定义码面,可设置总可兑换次数、每次兑换所得可用次数与有效期
function tc_api_admin_create_fixed_code() {
    tc_with_db(true, function (&$db) {
        // 与生成随机兑换码同一口径:演示身份造的码不在快照还原范围内,一律拒绝
        tc_demo_guard(tc_require_admin($db), '演示管理员不能创建兑换码');
        $b = tc_read_json_body();
        $code = preg_replace('/[^A-Z0-9]/', '', strtoupper((string) ($b['code'] ?? '')));
        if (strlen($code) < 4 || strlen($code) > 64) tc_fail(400, '兑换码需为 4-64 位字母或数字');
        $hash = hash('sha256', $code);
        foreach ($db['redemptionCodes'] as $c) if ($c['codeHash'] === $hash) tc_fail(409, '该兑换码已存在');
        $quotaRaw = (string) (isset($b['quota']) ? $b['quota'] : '');
        if ($quotaRaw === '-1') $quota = -1; else { $quota = (int) $quotaRaw; if ($quota < 1) tc_fail(400, '可用次数需大于 0,或填 -1 表示无限'); }
        $maxRedemptions = min(1000000, max(1, (int) ($b['maxRedemptions'] ?? 1)));
        $expiresAt = 0;
        if (isset($b['expiresAt']) && (string) $b['expiresAt'] !== '') {
            $expiresAt = (int) $b['expiresAt'];
            if ($expiresAt <= tc_now()) tc_fail(400, '有效期必须晚于当前时间');
        }
        $row = array('id' => tc_uid(8), 'type' => 'fixed', 'code' => $code, 'codeHash' => $hash, 'status' => 'unused', 'quota' => $quota, 'maxRedemptions' => $maxRedemptions, 'usedCount' => 0, 'perUserLimit' => !empty($b['perUserLimit']), 'expiresAt' => $expiresAt, 'createdAt' => tc_now());
        $db['redemptionCodes'][] = $row;
        tc_json(200, array('ok' => true, 'code' => $row));
    });
}

function tc_api_redeem_package() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db); $b = tc_read_json_body();
        // 游客不能兑换额度(与领取套餐同理,避免绕过体验轮数)
        if (!empty($user['guest'])) tc_fail(403, '游客不能兑换额度，请先注册账号');
        $code = preg_replace('/[^A-Z0-9]/', '', strtoupper((string) ($b['code'] ?? ''))); if ($code === '') tc_fail(400, '请输入兑换码');
        $hash = hash('sha256', $code); $idx = -1; foreach ($db['redemptionCodes'] as $i => $row) if ($row['codeHash'] === $hash) { $idx = $i; break; }
        if ($idx < 0) tc_fail(404, '兑换码无效'); $row = $db['redemptionCodes'][$idx];
        // 固定兑换码:不挂套餐,按码上设置的总次数/可用次数/有效期兑换
        if (isset($row['type']) && $row['type'] === 'fixed') {
            if ($row['status'] === 'used') tc_fail(409, '兑换码已达兑换次数上限');
            if (!empty($row['expiresAt']) && tc_now() > (int) $row['expiresAt']) tc_fail(410, '兑换码已过期');
            if (!empty($row['perUserLimit'])) {
                foreach ($db['quotaLedger'] as $e) {
                    if ((isset($e['userId']) && $e['userId'] === $user['id']) && (isset($e['source']) && $e['source'] === 'fixed_code') && (isset($e['codeId']) && $e['codeId'] === $row['id'])) tc_fail(409, '你已经兑换过该兑换码');
                }
            }
            $quota = isset($row['quota']) ? (int) $row['quota'] : 0;
            tc_add_quota($db, $user, $quota);
            $row['usedCount'] = (isset($row['usedCount']) ? (int) $row['usedCount'] : 0) + 1;
            $row['usedAt'] = tc_now(); $row['usedBy'] = $user['id'];
            if ($row['usedCount'] >= (isset($row['maxRedemptions']) ? (int) $row['maxRedemptions'] : 1)) $row['status'] = 'used';
            $db['redemptionCodes'][$idx] = $row;
            $db['quotaLedger'][] = array('id' => tc_uid(8), 'userId' => $user['id'], 'amount' => $quota, 'source' => 'fixed_code', 'codeId' => $row['id'], 'packageName' => '固定兑换码 ' . $code, 'createdAt' => tc_now());
            tc_replace_user($db, $user); tc_json(200, array('ok' => true, 'user' => tc_sanitize_user($user)));
        }
        if ($row['status'] !== 'unused') tc_fail(409, '兑换码已使用'); $pkg = null; foreach ($db['packages'] as $p) if ($p['id'] === $row['packageId']) $pkg = $p; if (!$pkg) tc_fail(410, '套餐已不存在');
        if (empty($pkg['enabled'])) tc_fail(410, '套餐已停用');
        tc_enforce_quota_expiry($db, $user);
        $exp = (!empty($pkg['validityDays']) && $pkg['quota'] !== -1) ? tc_now() + ((int) $pkg['validityDays']) * 86400000 : 0;
        tc_add_quota($db, $user, $pkg['quota'], $exp); $db['redemptionCodes'][$idx]['status'] = 'used'; $db['redemptionCodes'][$idx]['usedAt'] = tc_now(); $db['redemptionCodes'][$idx]['usedBy'] = $user['id']; $ledgerEntry = array('id'=>tc_uid(8),'userId'=>$user['id'],'amount'=>$pkg['quota'],'source'=>'package','packageId'=>$pkg['id'],'packageName'=>$pkg['name'],'createdAt'=>tc_now());
        if ($exp > 0) $ledgerEntry['expiresAt'] = $exp;
        $db['quotaLedger'][] = $ledgerEntry; tc_replace_user($db, $user); tc_json(200, array('ok'=>true,'user'=>tc_sanitize_user($user)));
    });
}

function tc_api_admin_get_settings() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        tc_backup_maybe($db);
        tc_json(200, array('settings' => tc_admin_settings_public($db['settings'], tc_is_demo_user($admin))));
    });
}

// 列表:支持关键词搜索,并标注哪些被本地渠道实际使用。
// 不提供「按公司筛选」:上游价格表的 litellm_provider 是托管平台(bedrock/azure/openrouter…),
// 同一模型常同时挂在多个平台下,拿它当厂商会让用户误判,故不进列表也不做筛选维度。
function tc_api_admin_model_meta_list() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $q = isset($_GET['q']) ? tc_model_meta_key($_GET['q']) : '';
        $page = isset($_GET['page']) ? max(1, (int) $_GET['page']) : 1;
        $perPage = isset($_GET['perPage']) ? min(200, max(10, (int) $_GET['perPage'])) : 50;

        $meta = isset($db['modelMeta']) && is_array($db['modelMeta']) ? $db['modelMeta'] : array();
        // 本地供应商实际用到的模型名:用于「在用」标记,同时让这些模型在默认排序里靠前。
        // 渠道给模型加前缀/后缀时(XXX/deepseek-flash)归到包含匹配到的那个条目上,
        // 否则表里那条被复用的元数据不会显示「在用」。
        $inUse = array();
        foreach ($db['providers'] as $p) {
            foreach ((isset($p['models']) ? $p['models'] : array()) as $m) {
                if (!is_array($m) || empty($m['id'])) continue;
                $rk = tc_model_meta_resolve($db, $m['id']);
                $inUse[$rk !== null ? $rk : tc_model_meta_key($m['id'])] = true;
            }
        }
        $rows = array();
        // 待复核数量按整表统计,不受搜索/分页影响——管理员常按名字逐个复核,
        // 若跟着搜索结果变,输入关键词的那一刻提示条就会缩水或整个消失。
        $reviewCount = 0;
        foreach ($meta as $item) {
            if (!empty($item['needsReview'])) $reviewCount++;
        }
        foreach ($meta as $key => $item) {
            if ($q !== '' && strpos($key, $q) === false) continue;
            $row = $item;
            $row['model'] = $key;
            $row['inUse'] = !empty($inUse[$key]);
            // provider 是上游托管平台标识,不作为「公司」对外暴露
            unset($row['provider']);
            $rows[] = $row;
        }
        // 在用的排前面,其余按模型名;便于管理员先处理真实配置过的模型
        usort($rows, function ($a, $b) {
            if ($a['inUse'] !== $b['inUse']) return $a['inUse'] ? -1 : 1;
            return strcmp($a['model'], $b['model']);
        });
        $total = count($rows);
        $slice = array_slice($rows, ($page - 1) * $perPage, $perPage);
        tc_json(200, array(
            'items' => array_values($slice),
            'total' => $total,
            'page' => $page,
            'perPage' => $perPage,
            'syncedAt' => isset($db['modelMetaSyncedAt']) ? (int) $db['modelMetaSyncedAt'] : 0,
            'sourceCount' => isset($db['modelMetaSourceCount']) ? (int) $db['modelMetaSourceCount'] : 0,
            'storedCount' => count($meta),
            // 待人工复核的条目数(自动补的兜底值):前台据此提示管理员核对
            'reviewCount' => $reviewCount,
        ));
    });
}

// 手工新增/修改单条。改写后标记为 manual,后续 litellm 同步不再覆盖它。
function tc_api_admin_model_meta_save() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能修改模型元数据');
        $b = tc_read_json_body();
        $model = tc_model_meta_key(isset($b['model']) ? $b['model'] : '');
        if ($model === '' || strlen($model) > 200) tc_fail(400, '请填写模型名');
        if (!isset($db['modelMeta']) || !is_array($db['modelMeta'])) $db['modelMeta'] = array();
        // 复核确认:保留现有数值,只清「待复核」标记(自动兜底值被管理员认可)
        if (!empty($b['confirm'])) {
            if (!isset($db['modelMeta'][$model])) tc_fail(404, '该模型没有元数据');
            $db['modelMeta'][$model]['needsReview'] = false;
            $db['modelMeta'][$model]['source'] = 'manual';
            $db['modelMeta'][$model]['updatedAt'] = tc_now();
            tc_json(200, array('ok' => true, 'model' => $model, 'item' => $db['modelMeta'][$model]));
        }
        // 手工条目没有上游来源:清掉 provider/mode,避免沿用旧值或接受客户端传入的任意串
        $b['provider'] = '';
        $b['mode'] = '';
        $item = tc_normalize_model_meta_item(array_merge($b, array('source' => 'manual', 'updatedAt' => tc_now())));
        if ($item === null) tc_fail(400, '请至少填写一项有效的窗口或价格');
        $item['source'] = 'manual';
        $item['needsReview'] = false; // 管理员手工填写即视为已复核
        $db['modelMeta'][$model] = $item;
        tc_json(200, array('ok' => true, 'model' => $model, 'item' => $item));
    });
}

function tc_api_admin_model_meta_delete() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能删除模型元数据');
        $b = tc_read_json_body();
        $model = tc_model_meta_key(isset($b['model']) ? $b['model'] : '');
        if ($model === '') tc_fail(400, '缺少模型名');
        if (!isset($db['modelMeta'][$model])) tc_fail(404, '该模型没有元数据');
        unset($db['modelMeta'][$model]);
        tc_json(200, array('ok' => true));
    });
}

// 清空整表(仅 litellm 来源;手工与内置条目保留)
function tc_api_admin_model_meta_clear() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能清空模型元数据');
        $kept = array();
        foreach ((isset($db['modelMeta']) && is_array($db['modelMeta']) ? $db['modelMeta'] : array()) as $k => $v) {
            $src = isset($v['source']) ? (string) $v['source'] : '';
            if ($src === 'manual' || $src === 'builtin') $kept[$k] = $v;
        }
        $db['modelMeta'] = $kept;
        unset($db['modelMetaSyncedAt']);
        tc_json(200, array('ok' => true, 'kept' => count($kept)));
    });
}

function tc_api_admin_model_meta_sync() {
    $b = tc_read_json_body();
    $dryRun = !empty($b['dryRun']);
    // 先鉴权(读事务),再拉网络,最后写库 —— 外部请求可能耗时数十秒,
    // 不该占着数据库写锁;同时确保未授权用户不能借这个端点发外网请求。
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能同步模型元数据');
    });
    $res = tc_http_request(TC_LITELLM_PRICES_URL, 'GET', array(
        'Accept' => 'application/json',
        'User-Agent' => 'TinyChat/' . (defined('TC_VERSION') ? TC_VERSION : 'dev'),
    ), null, 60000, false);
    if (!$res['ok']) tc_fail($res['code'] === 504 ? 504 : 502, tc_upstream_fail_message($res));
    if ($res['status'] >= 400) tc_fail(502, '拉取 litellm 价格表失败(HTTP ' . $res['status'] . ')');
    $raw = json_decode($res['body'], true);
    if (!is_array($raw)) tc_fail(502, 'litellm 价格表解析失败');
    if ($dryRun) {
        $index = tc_litellm_index($raw);
        tc_json(200, array('ok' => true, 'dryRun' => true, 'source' => count($raw), 'usable' => count($index)));
    }
    $result = null;
    tc_with_db(true, function (&$db) use ($raw, &$result) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能同步模型元数据');
        $result = tc_model_meta_sync_indexed($db, $raw);
    });
    tc_json(200, array('ok' => true) + $result);
}

// 把已抓取的原始表合并进库(与网络请求分离,便于复用与测试)
function tc_model_meta_sync_indexed(&$db, $raw) {
    $index = tc_litellm_index($raw);
    if (!$index) tc_fail(502, 'litellm 价格表里没有可用的模型条目');
    $meta = isset($db['modelMeta']) && is_array($db['modelMeta']) ? $db['modelMeta'] : array();
    $added = 0; $updated = 0; $skipped = 0; $reviewCleared = 0;
    foreach ($index as $key => $item) {
        // 手工与内置条目都不被同步覆盖:前者是管理员定的,后者是随发布包分发的基准值
        $src = isset($meta[$key]['source']) ? (string) $meta[$key]['source'] : '';
        if ($src === 'manual' || $src === 'builtin') { $skipped++; continue; }
        // 已有条目上管理员手动停用过的,同步回来后保持停用(不能因为上游有数据就擅自重新启用)
        if (isset($meta[$key])) {
            $updated++;
            if (array_key_exists('enabled', $meta[$key])) $item['enabled'] = !empty($meta[$key]['enabled']);
            if (!empty($meta[$key]['needsReview'])) $reviewCleared++;
        } else {
            $added++;
        }
        // 同步取到的是上游真实值,不再是自动兜底值,「待复核」标记随之清除
        $item['needsReview'] = false;
        $meta[$key] = $item;
    }
    $db['modelMeta'] = tc_normalize_model_meta($meta);
    $db['modelMetaSyncedAt'] = tc_now();
    $db['modelMetaSourceCount'] = count($raw);
    return array(
        'added' => $added, 'updated' => $updated, 'skipped' => $skipped,
        'reviewCleared' => $reviewCleared,
        'total' => count($db['modelMeta']),
    );
}

// ---- 模型汇总(自定义 ID 聚合多模型)后台接口 ----
// 列表:返回汇总组(含动态解析出来的成员)、可用于成员选择的渠道目录、可一键汇总的同名模型。
// 用写事务而不是读事务:开启「同名自动汇总」时顺带把缺失的 auto 组补上,管理员一进页面
// 看到的就是与当前渠道配置一致的真实结果。tc_db_commit 逐键比对,没变化时不会真的写库。
function tc_api_admin_model_groups_list() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $synced = null;
        if (!empty($db['settings']['modelAggEnabled']) && !empty($db['settings']['modelAggAutoMerge'])) {
            $synced = tc_model_groups_sync_auto($db);
        }
        $catalog = array();
        $byId = array();
        foreach ($db['providers'] as $p) {
            if (!is_array($p) || !isset($p['id'])) continue;
            $models = array();
            foreach ((isset($p['models']) ? $p['models'] : array()) as $m) {
                if (!is_array($m) || !isset($m['id']) || $m['id'] === '') continue;
                $models[] = array(
                    'id' => (string) $m['id'],
                    'name' => (string) (isset($m['name']) && $m['name'] !== '' ? $m['name'] : $m['id']),
                    'image' => !empty($m['image']),
                    'video' => !empty($m['video']),
                );
            }
            $row = array(
                'id' => (string) $p['id'],
                'name' => (string) (isset($p['name']) && $p['name'] !== '' ? $p['name'] : $p['id']),
                'enabled' => tc_provider_enabled($p),
                'scope' => isset($p['scope']) ? (string) $p['scope'] : 'user',
                'models' => $models,
            );
            $catalog[] = $row;
            $byId[$row['id']] = $row;
        }
        // 同名统计:同一个模型名出现在 ≥2 个「启用中」的渠道时可一键汇总
        // (与 tc_model_groups_sync_auto 同一口径 —— 两处口径不一致会让「提示可汇总」
        //  与「点下去什么也没生成」同时出现)
        $count = array();
        $nameOf = array();
        foreach ($catalog as $c) {
            if (!$c['enabled']) continue;
            foreach ($c['models'] as $m) {
                $k = tc_model_group_key($m['id']);
                if ($k === '') continue;
                if (!isset($count[$k])) { $count[$k] = 0; $nameOf[$k] = $m['id']; }
                $count[$k]++;
            }
        }
        $dupes = array();
        foreach ($count as $k => $n) if ($n >= 2) $dupes[] = array('name' => $nameOf[$k], 'count' => $n);
        usort($dupes, function ($a, $b) {
            if ($a['count'] === $b['count']) return strcmp($a['name'], $b['name']);
            return $b['count'] - $a['count'];
        });
        $groups = array();
        foreach (tc_normalize_model_groups(isset($db['modelGroups']) ? $db['modelGroups'] : array()) as $g) {
            $resolved = array();
            if (!empty($g['auto'])) {
                $match = (string) ($g['matchId'] !== '' ? $g['matchId'] : $g['id']);
                foreach ($catalog as $c) {
                    foreach ($c['models'] as $m) {
                        if ((string) $m['id'] !== $match) continue;
                        $resolved[] = array(
                            'providerId' => $c['id'], 'providerName' => $c['name'],
                            'model' => $match, 'enabled' => $c['enabled'], 'exists' => true,
                        );
                    }
                }
            } else {
                foreach ($g['members'] as $m) {
                    $c = isset($byId[(string) $m['providerId']]) ? $byId[(string) $m['providerId']] : null;
                    $exists = false;
                    if ($c) {
                        foreach ($c['models'] as $cm) if ((string) $cm['id'] === (string) $m['model']) { $exists = true; break; }
                    }
                    $resolved[] = array(
                        'providerId' => (string) $m['providerId'],
                        'providerName' => $c ? $c['name'] : '',
                        'model' => (string) $m['model'],
                        'enabled' => $c ? $c['enabled'] : false,
                        'exists' => $exists,
                    );
                }
            }
            $g['resolved'] = $resolved;
            $g['candidateCount'] = count(array_filter($resolved, function ($r) { return !empty($r['exists']); }));
            $groups[] = $g;
        }
        tc_json(200, array(
            'groups' => $groups,
            'providers' => $catalog,
            'dupes' => $dupes,
            'nextOrder' => tc_next_model_group_order($db),
            'synced' => $synced,
            'settings' => array(
                'modelAggEnabled' => !empty($db['settings']['modelAggEnabled']),
                'modelAggAutoMerge' => !empty($db['settings']['modelAggAutoMerge']),
                'modelAggHideUnmerged' => !empty($db['settings']['modelAggHideUnmerged']),
            ),
        ));
    });
}

// 新增/修改一个汇总组。ID 不可与既有组重复(改名时允许沿用自身)。
function tc_api_admin_model_groups_save() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能修改模型汇总');
        $b = tc_read_json_body();
        // 排序:body.order 为「汇总 ID 顺序数组」。只在这些汇总之间重排它们的 order 值,
        // 不动供应商的 order —— 否则一次拖动就会把「汇总排在供应商之后」的既有格局打乱。
        if (isset($b['action']) && $b['action'] === 'reorder' && isset($b['order']) && is_array($b['order'])) {
            $seq = array();
            foreach ($b['order'] as $gid) {
                $k = tc_model_group_key($gid);
                if ($k !== '' && !isset($seq[$k])) $seq[$k] = true;
            }
            $orders = array();
            foreach ((isset($db['modelGroups']) && is_array($db['modelGroups']) ? $db['modelGroups'] : array()) as $g) {
                if (is_array($g) && isset($g['id'])) $orders[] = (int) (isset($g['order']) ? $g['order'] : 0);
            }
            sort($orders, SORT_NUMERIC);
            $i = 0;
            $slot = array();
            foreach (array_keys($seq) as $k) {
                if (isset($orders[$i])) $slot[$k] = $orders[$i];
                $i++;
            }
            foreach ($db['modelGroups'] as $idx => $g) {
                if (!is_array($g) || !isset($g['id'])) continue;
                $k = tc_model_group_key($g['id']);
                if (isset($slot[$k])) $db['modelGroups'][$idx]['order'] = $slot[$k];
            }
            $db['modelGroups'] = tc_normalize_model_groups($db['modelGroups']);
            tc_json(200, array('ok' => true));
        }
        $src = isset($b['group']) && is_array($b['group']) ? $b['group'] : $b;
        $origId = $src['__origId'] ?? null;
        unset($src['__origId']);
        if (isset($src['id'])) $src['id'] = tc_model_group_clean_id($src['id']);
        if ($src['id'] === '' || $src['id'] === null) tc_fail(400, '请填写汇总 ID');
        if (strncmp((string) $src['id'], 'agg:', 4) === 0) tc_fail(400, '汇总 ID 不能以 agg: 开头（该前缀为本站保留）');
        $item = tc_normalize_model_group($src);
        if ($item === null) tc_fail(400, '汇总 ID 无效');
        if (empty($item['auto']) && !$item['members']) tc_fail(400, '请至少选择一个成员模型');
        $key = tc_model_group_key($item['id']);
        if (!isset($db['modelGroups']) || !is_array($db['modelGroups'])) $db['modelGroups'] = array();
        // 同 ID 冲突:只有当这个 ID 属于本次要保存的那一条(即 __origId 与之一致)才算编辑自身
        foreach ($db['modelGroups'] as $g) {
            if (!is_array($g) || !isset($g['id']) || tc_model_group_key($g['id']) !== $key) continue;
            if ($origId !== null && tc_model_group_key($origId) === $key) break;   // 改自身的其它字段
            tc_fail(409, '汇总 ID「' . $item['id'] . '」已被占用');
        }
        $item['updatedAt'] = tc_now();
        // 原地替换(保持前台显示顺序的关键:顺序由数组位置 + order 共同决定)
        $replaced = false;
        if ($origId !== null) {
            $origKey = tc_model_group_key($origId);
            foreach ($db['modelGroups'] as $i => $g) {
                if (!is_array($g) || !isset($g['id']) || tc_model_group_key($g['id']) !== $origKey) continue;
                $db['modelGroups'][$i] = $item;
                $replaced = true;
                break;
            }
        }
        if (!$replaced) {
            foreach ($db['modelGroups'] as $i => $g) {
                if (is_array($g) && isset($g['id']) && tc_model_group_key($g['id']) === $key) {
                    $db['modelGroups'][$i] = $item;
                    $replaced = true;
                    break;
                }
            }
        }
        if (!$replaced) $db['modelGroups'][] = $item;
        $db['modelGroups'] = tc_normalize_model_groups($db['modelGroups']);
        tc_json(200, array('ok' => true, 'group' => $item));
    });
}

function tc_api_admin_model_groups_delete() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能删除模型汇总');
        $b = tc_read_json_body();
        $key = tc_model_group_key(isset($b['id']) ? $b['id'] : '');
        if ($key === '') tc_fail(400, '缺少汇总 ID');
        $kept = array();
        $removed = 0;
        foreach ((isset($db['modelGroups']) && is_array($db['modelGroups']) ? $db['modelGroups'] : array()) as $g) {
            if (is_array($g) && isset($g['id']) && tc_model_group_key($g['id']) === $key) { $removed++; continue; }
            $kept[] = $g;
        }
        if (!$removed) tc_fail(404, '汇总不存在');
        $db['modelGroups'] = $kept;
        tc_json(200, array('ok' => true));
    });
}

// 按当前渠道配置重新生成/清理「同名自动汇总组」(手工组不动)。
function tc_api_admin_model_groups_automerge() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能生成同名汇总');
        $b = tc_read_json_body();
        $min = isset($b['minProviders']) ? (int) $b['minProviders'] : 2;
        $res = tc_model_groups_sync_auto($db, min(10, max(1, $min)));
        tc_json(200, array('ok' => true) + $res);
    });
}

// 强制全站下线:会话纪元 +1,所有已签发的令牌立即失效
function tc_api_admin_invalidate_sessions() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能强制全站下线');
        $db['settings']['authEpoch'] = (int) (isset($db['settings']['authEpoch']) ? $db['settings']['authEpoch'] : 1) + 1;
        tc_json(200, array('ok' => true, 'authEpoch' => (int) $db['settings']['authEpoch']));
    });
}

// ---- 用户 API 密钥(OpenAI 兼容出口用) ----
function tc_api_key_public($k) {
    return array(
        'id' => $k['id'],
        'name' => isset($k['name']) ? $k['name'] : '',
        'prefix' => isset($k['prefix']) ? $k['prefix'] : '',
        'createdAt' => isset($k['createdAt']) ? (int) $k['createdAt'] : 0,
        'lastUsed' => isset($k['lastUsed']) ? (int) $k['lastUsed'] : 0,
    );
}

// 当前用户的余量明细(额度增减流水),供「设置 → 账户」追溯每一笔变化
function tc_api_me_quota_ledger() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $q = tc_query();
        $limit = isset($q['limit']) ? (int) $q['limit'] : 50;
        $limit = min(200, max(1, $limit ?: 50));
        $offset = isset($q['offset']) ? max(0, (int) $q['offset']) : 0;
        $rows = array();
        foreach ($db['quotaLedger'] as $e) {
            if (!is_array($e)) continue;
            if (!isset($e['userId']) || (string) $e['userId'] !== (string) $user['id']) continue;
            $rows[] = $e;
        }
        usort($rows, function ($a, $b) {
            $ta = isset($a['createdAt']) ? (int) $a['createdAt'] : 0;
            $tb = isset($b['createdAt']) ? (int) $b['createdAt'] : 0;
            if ($ta === $tb) return 0;
            return $ta > $tb ? -1 : 1;
        });
        $total = count($rows);
        $out = array();
        foreach (array_slice($rows, $offset, $limit) as $e) {
            $amount = isset($e['amount']) ? (float) $e['amount'] : 0;
            $src = isset($e['source']) ? (string) $e['source'] : '';
            if ($src === 'usage') {
                $title = (string) (isset($e['purpose']) ? $e['purpose'] : '对话');
                $extra = trim((string) (isset($e['model']) ? $e['model'] : ''));
                if ($extra !== '' && strpos($title, $extra) === false) $title .= ' · ' . $extra;
            } elseif ($src === 'fixed_code') {
                // 固定码落库存的是 packageName='固定兑换码 <码面>'(老数据没有 code 字段)
                $codeFace = isset($e['code']) && $e['code'] !== '' ? (string) $e['code']
                    : trim(preg_replace('/^固定兑换码\s*/', '', (string) (isset($e['packageName']) ? $e['packageName'] : '')));
                $title = '固定兑换码' . ($codeFace !== '' ? ' ' . $codeFace : '');
            } elseif ($src === 'package_redeem' || $src === 'package') {
                // 'package' 是兑换码核销落库时使用的历史值
                $title = '兑换码 · ' . (string) (isset($e['packageName']) ? $e['packageName'] : '套餐');
            } elseif ($src === 'package_claim') {
                $title = '领取套餐 · ' . (string) (isset($e['packageName']) ? $e['packageName'] : '');
            } elseif ($src === 'admin') {
                $title = '管理员调整' . (isset($e['note']) && $e['note'] !== '' ? ' · ' . $e['note'] : '');
            } elseif ($src === 'register') {
                $title = '注册赠送';
            } else {
                $title = $src !== '' ? $src : '额度变化';
            }
            $row = array(
                'id' => isset($e['id']) ? (string) $e['id'] : '',
                'amount' => $amount,
                'title' => $title,
                'source' => $src,
                'createdAt' => isset($e['createdAt']) ? (int) $e['createdAt'] : 0,
            );
            if (isset($e['before'])) $row['before'] = (float) $e['before'];
            if (isset($e['after'])) $row['after'] = (float) $e['after'];
            if (!empty($e['expiresAt'])) $row['expiresAt'] = (int) $e['expiresAt'];
            $out[] = $row;
        }
        $gained = 0.0;
        $spent = 0.0;
        foreach ($rows as $e) {
            $a = isset($e['amount']) ? (float) $e['amount'] : 0;
            if ($a >= 0) $gained += $a; else $spent += -$a;
        }
        $pub = tc_sanitize_user($user);
        tc_json(200, array(
            'entries' => $out,
            'total' => $total,
            'gained' => round($gained, 4),
            'spent' => round($spent, 4),
            'quota' => $pub['quota'],
        ));
    });
}

function tc_api_me_apikeys_list() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $keys = array();
        foreach ((isset($user['apiKeys']) && is_array($user['apiKeys']) ? $user['apiKeys'] : array()) as $k) {
            if (is_array($k)) $keys[] = tc_api_key_public($k);
        }
        // 站点当前的开放接口限制,供账户面板展示,避免用户误以为可无限调用
        $s = $db['settings'];
        tc_json(200, array(
            'keys' => $keys,
            'enabled' => !empty($s['apiKeysEnabled']),
            'maxKeys' => 5,
            'keyRateLimitPerMin' => isset($s['apiKeyRateLimitPerMin']) ? (int) $s['apiKeyRateLimitPerMin'] : 60,
            'userRateLimitPerMin' => isset($s['rateLimitPerMin']) ? (int) $s['rateLimitPerMin'] : 30,
            'exposeRestricted' => !empty($s['apiExposedModels']),
        ));
    });
}

function tc_api_me_apikeys_create() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        if (empty($db['settings']['apiKeysEnabled'])) tc_fail(403, '管理员已关闭 API 密钥功能');
        $b = tc_read_json_body();
        $name = substr(trim((string) (isset($b['name']) ? $b['name'] : '')), 0, 40);
        $existing = isset($user['apiKeys']) && is_array($user['apiKeys']) ? $user['apiKeys'] : array();
        if (count($existing) >= 5) tc_fail(400, '最多保留 5 个 API 密钥，请先删除不再使用的');
        $key = tc_api_key_generate();
        $record = array('id' => tc_uid(8), 'name' => $name !== '' ? $name : 'API Key', 'hash' => tc_api_key_hash($key), 'prefix' => tc_api_key_prefix($key), 'createdAt' => tc_now(), 'lastUsed' => 0);
        $existing[] = $record;
        $user['apiKeys'] = $existing;
        tc_replace_user($db, $user);
        tc_json(200, array('key' => tc_api_key_public($record), 'secret' => $key));
    });
}

function tc_api_me_apikeys_delete($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $list = isset($user['apiKeys']) && is_array($user['apiKeys']) ? $user['apiKeys'] : array();
        $kept = array_values(array_filter($list, function ($k) use ($id) { return is_array($k) && isset($k['id']) && $k['id'] !== $id; }));
        if (count($kept) === count($list)) tc_fail(404, '密钥不存在');
        $user['apiKeys'] = $kept;
        tc_replace_user($db, $user);
        tc_json(200, array('ok' => true));
    });
}

// ---- 注册邀请码 ----
function tc_api_admin_usage_export() {
    tc_with_db(false, function ($db) {
        // 按用户姓名导出全站用量属用户行为隐私,演示管理员不可导出
        tc_demo_guard(tc_require_admin($db), '演示管理员不可导出用户用量明细');
        $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
        $names = array();
        foreach ($db['users'] as $u) $names[(string) $u['id']] = (string) (isset($u['name']) ? $u['name'] : '');
        // CSV 注入防护:用户名是用户可控的,`=1+1`、`@SUM(...)`、`+cmd|...` 这类值
        // 即使被引号包住,Excel / LibreOffice 仍会当公式求值(或被 DDE 拿去执行命令)。
        // 前导单引号是最通用、各表格软件都认的中和方式。
        $esc = function ($v) {
            $s = (string) $v;
            if ($s !== '' && strpos("=+-@\t\r", $s[0]) !== false) $s = "'" . $s;
            return '"' . str_replace('"', '""', $s) . '"';
        };
        $out = "用户,日期,模型,调用次数,扣费,输入tokens,输出tokens\n";
        foreach ($ledger as $uid => $daysMap) {
            $uname = isset($names[(string) $uid]) && $names[(string) $uid] !== '' ? $names[(string) $uid] : $uid;
            foreach (tc_assoc($daysMap) as $day => $models) {
                foreach (tc_assoc($models) as $model => $cell) {
                    $cell = tc_assoc($cell);
                    $out .= implode(',', array(
                        $esc($uname), $esc($day), $esc($model),
                        (int) (isset($cell['calls']) ? $cell['calls'] : 0),
                        round((float) (isset($cell['cost']) ? $cell['cost'] : 0), 4),
                        (int) (isset($cell['prompt']) ? $cell['prompt'] : 0),
                        (int) (isset($cell['completion']) ? $cell['completion'] : 0),
                    )) . "\n";
                }
            }
        }
        tc_db_commit();
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="tinychat-usage-' . date('Ymd-His') . '.csv"');
        header('Cache-Control: no-store');
        echo "\xEF\xBB\xBF" . $out;
        exit;
    });
}

function tc_api_admin_invites_list() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $codes = array();
        foreach ((isset($db['inviteCodes']) && is_array($db['inviteCodes']) ? $db['inviteCodes'] : array()) as $c) {
            if (!is_array($c)) continue;
            $c['maxUses'] = tc_invite_max_uses($c);
            $c['usedCount'] = tc_invite_used_count($c);
            $c['usable'] = tc_invite_is_usable($c);
            $codes[] = $c;
        }
        usort($codes, function ($a, $b) { return ((int) ($b['createdAt'] ?? 0)) - ((int) ($a['createdAt'] ?? 0)); });
        tc_json(200, array(
            'codes' => $codes,
            'required' => !empty($db['settings']['registerInviteRequired']),
        ));
    });
}

function tc_api_admin_invites_create() {
    tc_with_db(true, function (&$db) {
        $demoAdmin = tc_require_admin($db);
        tc_demo_guard($demoAdmin, '演示管理员不能管理邀请码');
        $b = tc_read_json_body();
        $count = min(50, max(1, (int) (isset($b['count']) ? $b['count'] : 5) ?: 5));
        // maxUses:每个邀请码可用次数,<0 表示不限次数
        $maxUsesRaw = isset($b['maxUses']) ? (int) $b['maxUses'] : 1;
        $maxUses = $maxUsesRaw < 0 ? -1 : min(10000, max(1, $maxUsesRaw ?: 1));
        $prefix = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string) (isset($b['prefix']) ? $b['prefix'] : '')));
        $prefix = substr($prefix, 0, 8);
        $created = array();
        for ($i = 0; $i < $count; $i++) {
            $code = $prefix !== '' ? $prefix . '-' . strtoupper(tc_uid(4)) : strtoupper(tc_uid(4));
            $db['inviteCodes'][] = array(
                'code' => $code, 'createdAt' => tc_now(),
                'usedBy' => null, 'usedAt' => 0, 'usedCount' => 0, 'maxUses' => $maxUses,
            );
            $created[] = $code;
        }
        tc_json(200, array('created' => $created, 'maxUses' => $maxUses));
    });
}

function tc_api_admin_invites_delete($code) {
    tc_with_db(true, function (&$db) use ($code) {
        $demoAdmin = tc_require_admin($db);
        tc_demo_guard($demoAdmin, '演示管理员不能管理邀请码');
        $code = strtoupper(trim((string) $code));
        $kept = array_values(array_filter((isset($db['inviteCodes']) && is_array($db['inviteCodes']) ? $db['inviteCodes'] : array()), function ($c) use ($code) {
            return !is_array($c) || !isset($c['code']) || strtoupper((string) $c['code']) !== $code;
        }));
        if (count($kept) === count($db['inviteCodes'])) tc_fail(404, '邀请码不存在');
        $db['inviteCodes'] = $kept;
        tc_json(200, array('ok' => true));
    });
}

// 用户协议页(/agreement):展示后台保存的 HTML 正文,未启用时 404
function tc_api_agreement_page() {
    $settings = tc_with_db(false, function ($db) {
        return $db['settings'];
    });
    $agreementHtml = tc_agreement_html(isset($settings['agreementHtml']) ? $settings['agreementHtml'] : '');
    if (empty($settings['agreementEnabled']) || $agreementHtml === '') {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '站点未启用用户协议';
        exit;
    }
    $site = htmlspecialchars((string) (isset($settings['siteName']) ? $settings['siteName'] : 'TinyChat'), ENT_QUOTES, 'UTF-8');
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    echo '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>用户协议 · ' . $site . '</title><meta name="robots" content="noindex,nofollow"></head>'
        . '<body style="margin:0;background:#eef1f6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">'
        . '<div style="max-width:720px;margin:0 auto;padding:36px 16px;">'
        . '<div style="background:#fff;border-radius:16px;padding:32px 28px;box-shadow:0 1px 3px rgba(15,23,42,.06);">'
        . '<h1 style="margin:0 0 20px;font-size:22px;color:#0f172a;">' . $site . ' 用户协议</h1>'
        . '<div style="font-size:14px;line-height:1.9;color:#334155;word-break:break-word;">' . $agreementHtml . '</div>'
        . '<p style="margin:28px 0 0;font-size:12px;color:#94a3b8;text-align:center;">以上内容由 ' . $site . ' 管理员配置</p>'
        . '</div></div></body></html>';
    exit;
}

// 开放 API 对外模型白名单归一化。条目两种写法:
//   「providerId|modelId」——管理后台的标准格式,原样保留;
//   裸「modelId」——按当前供应商清单解析,唯一命中才转成标准格式。
// 解析不了(不存在,或多个供应商有同名模型)时整体报 400,
// 绝不静默丢弃——否则白名单悄悄失效,管理员还以为已经放开/收紧了模型。
function tc_normalize_exposed_models($list, $providers) {
    $out = array();
    $bad = array();
    foreach ((array) $list as $item) {
        $item = trim((string) $item);
        if ($item === '') continue;
        if (strpos($item, '|') !== false) { $out[$item] = true; continue; }
        $hits = array();
        foreach ((array) $providers as $p) {
            $models = isset($p['models']) && is_array($p['models']) ? $p['models'] : array();
            foreach ($models as $m) {
                $mid = is_array($m)
                    ? (string) (isset($m['id']) && $m['id'] !== '' ? $m['id'] : (isset($m['name']) ? $m['name'] : ''))
                    : (string) $m;
                if ($mid === $item) { $hits[] = (string) $p['id'] . '|' . $item; break; }
            }
        }
        if (count($hits) === 1) { $out[$hits[0]] = true; continue; }
        $bad[] = $item;
    }
    if ($bad) {
        tc_fail(400, '以下模型无法唯一匹配到供应商（同名模型请用「供应商ID|模型ID」格式）: '
            . implode('、', array_slice($bad, 0, 10))
            . (count($bad) > 10 ? ' 等 ' . count($bad) . ' 项' : ''));
    }
    return array_keys($out);
}

function tc_api_admin_save_settings() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        // 敏感词库上限 5 万条,词表随 settings 一起提交,2MB 默认上限装不下大词库,
        // 这里放宽到与对话同步同一量级(16MB)。本接口仅管理员可达,不构成放大面。
        $b = tc_read_json_body(16 * 1024 * 1024);
        $src = isset($b['settings']) && is_array($b['settings']) ? $b['settings'] : $b;
        // 公告是面向全站的门面信息,演示管理员不可改动
        if (tc_is_demo_user($admin) && array_key_exists('announcement', $src)) {
            tc_fail(403, '演示管理员不能修改公告');
        }
        // SMTP 凭据可用于冒用站点域名发信(钓鱼/垃圾邮件),演示管理员一律不可写入;
        // 即使提交里带的是掩码或空值也要拦,避免「顺带清空既有配置」
        if (tc_is_demo_user($admin) && array_key_exists('smtp', $src)) {
            tc_fail(403, '演示管理员不能修改邮件(SMTP)配置');
        }
        // 协议正文会进公开页面。演示改动虽会回滚,回滚前所有访客都会看到,因此一并拦住。
        if (tc_is_demo_user($admin) && (array_key_exists('agreementHtml', $src) || array_key_exists('agreementEnabled', $src))) {
            tc_fail(403, '演示管理员不能修改用户协议');
        }
        // 敏感词库对演示身份不可见(见 tc_admin_settings_public):前端拿不到词表,提交里
        // 只能是空值,一旦放行就会把运营方词库清空;而 enabled 开关又直接影响全站过滤是否生效。
        // 两项都不该由演示身份改动,与公告/协议同一口径直接拒绝。
        if (tc_is_demo_user($admin) && array_key_exists('moderation', $src)) {
            tc_fail(403, '演示管理员不能修改内容安全设置');
        }
        if (array_key_exists('announcement', $src)) {
            if (!is_array($src['announcement'])) tc_fail(400, '公告设置格式不正确');
            $announcementText = trim((string) (isset($src['announcement']['text']) ? $src['announcement']['text'] : ''));
            $announcementLength = function_exists('mb_strlen')
                ? mb_strlen($announcementText, 'UTF-8')
                : preg_match_all('/./us', $announcementText, $announcementChars);
            if ($announcementLength === false) $announcementLength = strlen($announcementText);
            if (!empty($src['announcement']['enabled']) && $announcementText === '') {
                tc_fail(400, '启用公告时请填写公告内容');
            }
            if ($announcementLength > 2000) tc_fail(400, '公告内容不能超过 2000 字');
            $src['announcement']['text'] = $announcementText;
            $src['announcement']['updatedAt'] = tc_now();
        }
        if (isset($src['webSearchTavilyKey']) && strpos((string) $src['webSearchTavilyKey'], '••') !== false) {
            unset($src['webSearchTavilyKey']);
        }
        if (isset($src['paddleOcrKey']) && strpos((string) $src['paddleOcrKey'], '••') !== false) {
            unset($src['paddleOcrKey']);
        }
        if (isset($src['mistralOcrKey']) && strpos((string) $src['mistralOcrKey'], '••') !== false) {
            unset($src['mistralOcrKey']);
        }
        // 解析通道路由按类别合并:只传部分类别时,未提及的类别保持原值,
        // 不能整表替换——否则「只改 office」会静默把 pdf/image 重置回 MinerU。
        if (array_key_exists('parseChannels', $src)) {
            if (!is_array($src['parseChannels'])) tc_fail(400, '解析通道路由格式不正确');
            $curChannels = isset($db['settings']['parseChannels']) && is_array($db['settings']['parseChannels']) ? $db['settings']['parseChannels'] : array();
            $src['parseChannels'] = array_merge($curChannels, $src['parseChannels']);
        }
        if (isset($src['webSearchBraveKey']) && strpos((string) $src['webSearchBraveKey'], '••') !== false) {
            unset($src['webSearchBraveKey']);
        }
        if (isset($src['webSearchJinaKey']) && strpos((string) $src['webSearchJinaKey'], '••') !== false) {
            unset($src['webSearchJinaKey']);
        }
        if (isset($src['mineruToken']) && strpos((string) $src['mineruToken'], '••') !== false) {
            unset($src['mineruToken']);
        }
        // SMTP 整段按字段合并:提交里没带的键沿用已存值。
        // 必须显式合并——后面的 array_merge 是浅合并,$src['smtp'] 会整体替换旧数组,
        // 于是「只改端口」这类保存会把密码/用户名等未提交的字段一并抹掉。
        if (isset($src['smtp']) && is_array($src['smtp'])) {
            $prevSmtp = (isset($db['settings']['smtp']) && is_array($db['settings']['smtp'])) ? $db['settings']['smtp'] : array();
            $mergedSmtp = array_merge($prevSmtp, $src['smtp']);
            // 密码为掩码(••)或空串时保留原值:取消勾选「保存后保持显示」只是不再显示明文,
            // 并不代表要删除密码(真要清空可同时清空用户名,无用户名时不发 AUTH)。
            $pw = isset($mergedSmtp['password']) ? (string) $mergedSmtp['password'] : '';
            if ($pw === '' || strpos($pw, '••') !== false) {
                $mergedSmtp['password'] = isset($prevSmtp['password']) ? (string) $prevSmtp['password'] : '';
            }
            $src['smtp'] = $mergedSmtp;
        }
        unset($src['defaultGroupId']);
        // 演示开关由"创建演示管理员"驱动,不允许通过普通设置保存直接改写
        unset($src['demoMode']);
        if (array_key_exists('apiExposedModels', $src)) {
            if (!is_array($src['apiExposedModels'])) tc_fail(400, '对外模型设置格式不正确');
            $src['apiExposedModels'] = tc_normalize_exposed_models($src['apiExposedModels'], $db['providers']);
        }
        // 第三方登录:按提供商逐字段深合并。整键覆盖会丢掉本次未提交的字段
        // (前端对留空/掩码的密钥不提交,期望"保持原值"),因此这里显式保留旧值。
        if (array_key_exists('oauthProviders', $src)) {
            if (!is_array($src['oauthProviders'])) tc_fail(400, '第三方登录设置格式不正确');
            $prevOauth = isset($db['settings']['oauthProviders']) && is_array($db['settings']['oauthProviders']) ? $db['settings']['oauthProviders'] : array();
            $merged = $prevOauth;
            foreach ($src['oauthProviders'] as $pid => $row) {
                if (!is_array($row)) continue;
                $base = isset($prevOauth[$pid]) && is_array($prevOauth[$pid]) ? $prevOauth[$pid] : array();
                if (array_key_exists('enabled', $row)) $base['enabled'] = !empty($row['enabled']);
                foreach ($row as $k => $v) {
                    if ($k === 'enabled') continue;
                    $v = trim((string) $v);
                    // 空串或掩码(••)= 不修改,保留已存值
                    if ($v === '' || strpos($v, '••') !== false) continue;
                    $base[$k] = $v;
                }
                $merged[$pid] = $base;
            }
            $src['oauthProviders'] = $merged;
        }
        $db['settings'] = tc_normalize_settings(array_merge($db['settings'], $src));
        // 模型汇总:开启「同名自动汇总」后立刻按当前渠道配置补齐 auto 组,
        // 否则管理员打开开关却看不到任何汇总效果(要再手动点一次「重新生成」)。
        if (!empty($db['settings']['modelAggEnabled']) && !empty($db['settings']['modelAggAutoMerge'])) {
            tc_model_groups_sync_auto($db);
        }
        tc_json(200, array('settings' => tc_admin_settings_public($db['settings'], tc_is_demo_user($admin))));
    });
}

// ---- 在线更新(逻辑在 lib/updater.php)----
function tc_api_admin_update_check() {
    $q = tc_query();
    tc_with_db(false, function ($db) { tc_require_admin($db); });
    try {
        $result = tc_update_check(!empty($q['force']));
    } catch (Exception $e) {
        tc_fail(400, '检查更新时出错：' . $e->getMessage());
    }
    tc_json(200, $result);
}

function tc_api_admin_update_perform() {
    // 演示管理员不得替换程序文件:演示快照只覆盖设置/供应商等数据,不覆盖代码本身,
    // 一次「在线更新」会把站点永久改成另一个版本,超出「改动 10 分钟后自动还原」的承诺。
    tc_with_db(false, function ($db) { tc_demo_guard(tc_require_admin($db), '演示管理员不可执行程序更新'); });
    tc_update_perform();
}

// 发送测试邮件:用当前"注册验证邮件"模板渲染样例内容,真实走一遍 SMTP 流程
function tc_api_admin_test_email() {
    tc_with_db(true, function (&$db) {
        // 测试邮件走站点 SMTP 凭据真实外发,演示管理员不得使用:
        // 否则任何拿到演示账号的人都能借站点的发信身份投递任意内容。
        $user = tc_demo_guard(tc_require_admin($db), '演示管理员不可发送测试邮件');
        $b = tc_read_json_body();
        $to = strtolower(trim((string) ($b['to'] ?? '')));
        if ($to === '') $to = strtolower(trim((string) ($user['email'] ?? '')));
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) tc_fail(400, '请填写有效的测试收件邮箱');
        $s = $db['settings'];
        if (empty($s['smtp']['host'])) tc_fail(400, '请先保存 SMTP 服务器配置');
        $link = tc_public_base_url() . '/login';
        [$subject, $html] = tc_render_mail_template($s, 'verify', $user['name'], $link, '30 分钟');
        $ok = tc_mail_send($s, $to, $subject, $html, '', $err);
        tc_push_log(array('kind' => 'mail', 'userName' => $user['name'], 'action' => $ok ? ('发送测试邮件到 ' . $to) : ('测试邮件发送失败: ' . $err)));
        if (!$ok) tc_fail(400, $err !== '' ? $err : '测试邮件发送失败，请检查 SMTP 配置');
        tc_json(200, array('ok' => true, 'to' => $to));
    });
}

// 下发内置默认邮件模板,供后台"恢复默认模板"使用
// 取回 SMTP 密码明文(仅当保存时勾选了「保存后保持显示」)。
// 管理员凭据属运营方信息,演示管理员一律不可见(与供应商密钥同一策略)。
function tc_api_admin_smtp_reveal() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示管理员不可查看邮件(SMTP)密码');
        if (empty($db['settings']['smtpKeyRevealable'])) tc_fail(403, '保存时未勾选「保存后保持显示」，密码不可查看');
        $pw = (string) (isset($db['settings']['smtp']['password']) ? $db['settings']['smtp']['password'] : '');
        if ($pw === '') tc_fail(404, '尚未保存 SMTP 密码');
        tc_log_auth_event('admin', isset($admin['name']) ? $admin['name'] : '', '查看 SMTP 密码', isset($admin['id']) ? $admin['id'] : '');
        tc_json(200, array('password' => $pw));
    });
}

function tc_api_admin_mail_template_defaults() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_json(200, array('templates' => tc_mail_default_templates()));
    });
}

function tc_api_admin_logs() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        $q = tc_query();
        $logs = tc_list_logs(isset($q['limit']) ? $q['limit'] : 100);
        // 演示管理员看日志时剔除与用户隐私相关的字段:
        //  - ip / userName / userId:来源地址与身份
        //  - prompt / reply:这两项就是用户对话内容,而演示身份本就被禁止查看用户对话,
        //    若不剔除等于绕过了该限制(日志详情里能直接读到提示词与模型回复)。
        if (tc_is_demo_user($admin)) {
            foreach ($logs as &$row) {
                if (!is_array($row)) continue;
                foreach (array('ip', 'userName', 'userId', 'prompt', 'reply') as $k) unset($row[$k]);
            }
            unset($row);
        }
        tc_json(200, array('logs' => $logs, 'limit' => TC_LOG_LIMIT));
    });
}

function tc_api_admin_delete_logs() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_clear_logs();
        tc_json(200, array('ok' => true));
    });
}

// ---- 数据备份 ----
function tc_api_admin_backup_list() {
    tc_with_db(false, function ($db) {
        // 备份文件是整库快照(含密码哈希/对话/密钥),演示管理员一律不可接触
        tc_demo_guard(tc_require_admin($db), '演示管理员不可下载或管理数据备份');
        tc_backup_maybe($db);
        tc_json(200, array(
            'backups' => tc_backup_list(),
            'backupEnabled' => !empty($db['settings']['backupEnabled']),
            'backupKeep' => (int) $db['settings']['backupKeep'],
        ));
    });
}

function tc_api_admin_backup_create() {
    tc_with_db(true, function (&$db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不可下载或管理数据备份');
        $name = tc_backup_create();
        if ($name === null) tc_fail(500, '备份创建失败，请检查 data/backup 目录写权限');
        tc_backup_prune($db['settings']);
        tc_db_skip_write();
        tc_json(200, array('ok' => true, 'created' => $name, 'backups' => tc_backup_list()));
    });
}

function tc_api_admin_backup_download() {
    tc_with_db(false, function ($db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不可下载或管理数据备份');
        $q = tc_query();
        $full = tc_backup_path(isset($q['id']) ? $q['id'] : '');
        if ($full === '') tc_fail(404, '备份不存在');
        tc_db_commit();
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . basename($full) . '"');
        header('Content-Length: ' . (string) filesize($full));
        header('Cache-Control: no-store');
        readfile($full);
        exit;
    });
}

function tc_api_admin_backup_restore() {
    tc_with_db(true, function (&$db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不可下载或管理数据备份');
        $b = tc_read_json_body();
        $full = tc_backup_path(isset($b['id']) ? $b['id'] : '');
        if ($full === '') tc_fail(404, '备份不存在');
        $raw = @file_get_contents($full);
        $data = json_decode((string) $raw, true);
        if (!is_array($data) || empty($data['users'])) tc_fail(400, '备份文件损坏或不是有效的数据库备份');
        // 用备份内容整体替换当前数据库,走统一的迁移与提交流程
        $db = tc_migrate_db($data);
        tc_json(200, array('ok' => true, 'restoredAt' => tc_now(), 'users' => count($db['users'])));
    });
}

function tc_api_admin_user_chats() {
    tc_with_db(false, function ($db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不能查看用户对话');
        $q = tc_query();
        $userId = isset($q['userId']) ? $q['userId'] : '';
        if ($userId) {
            $found = false;
            foreach ($db['users'] as $u) if ($u['id'] === $userId) { $found = true; break; }
            if (!$found) tc_fail(404, '用户不存在');
        }
        $out = array();
        // 「全部用户」模式兜底:最多处理 100 个用户,防止大站点一次响应数十 MB、长占读事务
        $usersCap = $userId ? PHP_INT_MAX : 100;
        $seen = 0;
        foreach ($db['users'] as $u) {
            if ($userId && $u['id'] !== $userId) continue;
            if (++$seen > $usersCap) break;
            $chats = tc_chats_of($db, $u['id']);
            if (!$userId) {
                // 「全部用户」模式:先在清洗前预裁剪(最近 20 个对话、每个最多 200 条),
                // 再走统一清洗,避免先清洗全部再丢弃的开销
                usort($chats, function ($a, $b) {
                    return (isset($b['updatedAt']) ? $b['updatedAt'] : 0) <=> (isset($a['updatedAt']) ? $a['updatedAt'] : 0);
                });
                $chats = array_slice($chats, 0, 20);
                foreach ($chats as &$c) {
                    if (isset($c['messages']) && count($c['messages']) > 200) $c['messages'] = array_slice($c['messages'], -200);
                }
                unset($c);
            }
            // 指定用户:完整下发(不截断条数/正文字符,带推理/引用/版本),
            // 后台可像前台一样完整还原对话(复用与云同步相同的清洗规则)。
            $chats = tc_sanitize_chats($chats);
            if ($chats || $userId) $out[] = array('user' => tc_sanitize_user($u), 'chats' => $chats);
        }
        tc_json(200, array('total' => count($out), 'usersChats' => $out, 'single' => !!$userId));
    });
}

// ============ 已删除对话留档(后台查看/批量清理) ============
// 用户删除的对话不抹除,集中在这里供管理员查看内容并批量清理。
// 列表只回元信息(缩略),完整内容走 view 端点单条拉取,避免一次响应几十 MB。

// 汇总:留档条数 / 估算占用 / 每用户计数(存储管理页用)
// $anonymize=true 时不带用户名(演示管理员只看汇总,不看具体是谁)
function tc_admin_deleted_summary($db, $anonymize = false) {
    $names = array();
    foreach ($db['users'] as $u) $names[(string) $u['id']] = isset($u['name']) ? (string) $u['name'] : '';
    $users = array();
    $count = 0; $bytes = 0;
    foreach (tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array()) as $uid => $row) {
        $row = tc_assoc($row);
        $chats = isset($row['chats']) && is_array($row['chats']) ? $row['chats'] : array();
        $tombs = tc_assoc(isset($row['tombs']) ? $row['tombs'] : array());
        $ubytes = strlen(tc_json_encode(array('chats' => $chats, 'tombs' => $tombs)));
        $count += count($chats);
        $bytes += $ubytes;
        $users[] = array(
            'userId' => $anonymize ? 'demo-' . (count($users) + 1) : (string) $uid,
            'name' => $anonymize
                ? ('用户 ' . (count($users) + 1))
                : (isset($names[(string) $uid]) ? $names[(string) $uid] : ('用户 ' . $uid)),
            'count' => count($chats),
            'tombstones' => count($tombs),
            'bytes' => $ubytes,
        );
    }
    usort($users, function ($a, $b) { return $b['count'] - $a['count']; });
    return array('count' => $count, 'bytes' => $bytes, 'users' => $users);
}

function tc_api_admin_deleted_chats() {
    tc_with_db(false, function ($db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不能查看用户对话');
        $q = tc_query();
        $kw = strtolower(trim(isset($q['q']) ? (string) $q['q'] : ''));
        $onlyUser = trim(isset($q['userId']) ? (string) $q['userId'] : '');
        $page = max(1, (int) (isset($q['page']) ? $q['page'] : 1));
        $pageSize = (int) (isset($q['pageSize']) ? $q['pageSize'] : 50);
        if ($pageSize < 1) $pageSize = 50;
        if ($pageSize > 200) $pageSize = 200;
        $names = array();
        foreach ($db['users'] as $u) $names[(string) $u['id']] = isset($u['name']) ? (string) $u['name'] : '';
        $all = array();
        foreach (tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array()) as $uid => $row) {
            $uid = (string) $uid;
            if ($onlyUser !== '' && $uid !== $onlyUser) continue;
            $name = isset($names[$uid]) ? $names[$uid] : ('用户 ' . $uid);
            $row = tc_assoc($row);
            $chats = isset($row['chats']) && is_array($row['chats']) ? $row['chats'] : array();
            $tombs = tc_assoc(isset($row['tombs']) ? $row['tombs'] : array());
            foreach ($chats as $c) {
                if (!is_array($c) || empty($c['id'])) continue;
                $title = isset($c['title']) ? (string) $c['title'] : '新对话';
                if ($kw !== '' && strpos(strtolower($title), $kw) === false && strpos(strtolower($name), $kw) === false) continue;
                $msgs = isset($c['messages']) && is_array($c['messages']) ? $c['messages'] : array();
                $preview = '';
                foreach ($msgs as $m) {
                    if (is_array($m) && isset($m['role']) && $m['role'] === 'user' && trim((string) (isset($m['content']) ? $m['content'] : '')) !== '') {
                        $preview = trim(preg_replace('/\s+/u', ' ', (string) $m['content']));
                        break;
                    }
                }
                if (function_exists('mb_substr')) $preview = mb_substr($preview, 0, 80, 'UTF-8');
                else $preview = substr($preview, 0, 80);
                $id = (string) $c['id'];
                $all[] = array(
                    'userId' => $uid,
                    'userName' => $name,
                    'chatId' => $id,
                    'title' => $title,
                    'messageCount' => count($msgs),
                    'updatedAt' => isset($c['updatedAt']) ? (float) $c['updatedAt'] : 0,
                    'deletedAt' => isset($tombs[$id]) ? (float) $tombs[$id] : 0,
                    'pinned' => !empty($c['pinned']),
                    'preview' => $preview,
                );
            }
        }
        usort($all, function ($a, $b) {
            return ($b['deletedAt'] ?: $b['updatedAt']) <=> ($a['deletedAt'] ?: $a['updatedAt']);
        });
        $total = count($all);
        $items = array_slice($all, ($page - 1) * $pageSize, $pageSize);
        tc_json(200, array(
            'items' => $items,
            'total' => $total,
            'page' => $page,
            'pageSize' => $pageSize,
            'summary' => tc_admin_deleted_summary($db),
        ));
    });
}

// 单条查看:返回完整清洗后的对话(含版本/思维链,与前台一致)
function tc_api_admin_deleted_chat_view() {
    tc_with_db(false, function ($db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不能查看用户对话');
        $q = tc_query();
        $uid = trim(isset($q['userId']) ? (string) $q['userId'] : '');
        $chatId = trim(isset($q['chatId']) ? (string) $q['chatId'] : '');
        if ($uid === '' || $chatId === '') tc_fail(400, '缺少参数');
        $deleted = tc_deleted_of($db, $uid);
        $found = null;
        foreach ($deleted['chats'] as $c) {
            if (is_array($c) && isset($c['id']) && (string) $c['id'] === $chatId) { $found = $c; break; }
        }
        if ($found === null) tc_fail(404, '该留档不存在或已被清理');
        $clean = tc_sanitize_chats(array($found));
        $userName = '';
        foreach ($db['users'] as $u) if ((string) $u['id'] === $uid) { $userName = isset($u['name']) ? (string) $u['name'] : ''; break; }
        tc_json(200, array(
            'chat' => $clean ? $clean[0] : null,
            'user' => array('id' => $uid, 'name' => $userName !== '' ? $userName : ('用户 ' . $uid)),
            'deletedAt' => isset($deleted['tombs'][$chatId]) ? (float) $deleted['tombs'][$chatId] : 0,
        ));
    });
}

// 批量清理留档。两种用法:
//   { items:[{userId, chatId}...] }  指定条目
//   { all:true }                     清空全部留档
// withTombstones=true 时连墓碑一起删(彻底清除);默认保留墓碑,防止旧设备把已删对话复活。
function tc_api_admin_deleted_chats_purge() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        tc_demo_guard($admin, '演示管理员不能清理用户对话');
        $b = tc_read_json_body();
        $withTombs = !empty($b['withTombstones']);
        $all = !empty($b['all']);
        $items = array();
        if (!$all && isset($b['items']) && is_array($b['items'])) {
            foreach (array_slice($b['items'], 0, 500) as $it) {
                if (!is_array($it)) continue;
                $uid = trim((string) (isset($it['userId']) ? $it['userId'] : ''));
                $cid = trim((string) (isset($it['chatId']) ? $it['chatId'] : ''));
                if ($uid === '' || $cid === '') continue;
                $items[$uid][$cid] = true;
            }
        }
        if (!$all && !$items) tc_fail(400, '请先选择要清理的记录');
        $removed = 0; $freed = 0;
        $map = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
        foreach ($map as $uid => $row) {
            $uid = (string) $uid;
            if (!$all && !isset($items[$uid])) continue;
            $row = tc_assoc($row);
            $chats = isset($row['chats']) && is_array($row['chats']) ? $row['chats'] : array();
            $tombs = tc_assoc(isset($row['tombs']) ? $row['tombs'] : array());
            $keep = array();
            foreach ($chats as $c) {
                if (!is_array($c) || empty($c['id'])) continue;
                $cid = (string) $c['id'];
                $hit = $all || isset($items[$uid][$cid]);
                if (!$hit) { $keep[] = $c; continue; }
                $removed++;
                $freed += strlen(tc_json_encode($c));
                if ($withTombs) unset($tombs[$cid]);
            }
            $row['chats'] = $keep;
            $row['tombs'] = $tombs;
            if (!$keep && !$tombs) unset($map[$uid]);
            else $map[$uid] = $row;
        }
        $db['userDeletedChats'] = tc_object_map($map);
        tc_log_auth_event('admin', isset($admin['name']) ? $admin['name'] : '', '清理已删除对话留档（' . $removed . ' 条 / ' . round($freed / 1048576, 2) . 'MB）', isset($admin['id']) ? $admin['id'] : '');
        tc_json(200, array('ok' => true, 'removed' => $removed, 'freedBytes' => $freed, 'withTombstones' => $withTombs));
    });
}

function tc_api_admin_users() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        $q = tc_query();
        $kw = strtolower(trim(isset($q['q']) ? $q['q'] : ''));
        $users = array();
        foreach ($db['users'] as $u) {
            $pc = 0;
            foreach ($db['providers'] as $p) if (isset($p['ownerId']) && $p['ownerId'] === $u['id']) $pc++;
            // 演示管理员不展示登录 IP 与邮箱(用户隐私),其余字段照常
            $row = tc_sanitize_user_for($admin, $u);
            $row['chatCount'] = count(tc_chats_of($db, $u['id']));
            $row['providerCount'] = $pc;
            if ($kw !== '' && strpos(strtolower($u['name']), $kw) === false) continue;
            $users[] = $row;
        }
        usort($users, function ($a, $b) { return ($b['createdAt'] ?: 0) - ($a['createdAt'] ?: 0); });
        tc_json(200, array('users' => $users, 'total' => count($users)));
    });
}

function tc_api_admin_create_user() {
    tc_with_db(true, function (&$db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不能管理用户账号');
        $b = tc_read_json_body();
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        $password = (string) (isset($b['password']) ? $b['password'] : '');
        if (!tc_valid_name($name)) tc_fail(400, '用户名需 2-32 位（字母/数字/中文/._@-）');
        if (strlen($password) < 4 || strlen($password) > 128) tc_fail(400, '密码长度需为 4-128 个字符');
        foreach ($db['users'] as $u) if (strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
        $isDemo = !empty($b['demo']);
        $isAdmin = !empty($b['admin']) || $isDemo;
        $user = array(
            'id' => tc_uid(), 'name' => $name, 'salt' => '', 'passwordHash' => '',
            'quota' => 0, 'createdAt' => tc_now(), 'admin' => $isAdmin,
            'groupId' => $isAdmin
                ? (($ag = tc_find_builtin_group($db, 'admin')) ? $ag['id'] : tc_default_register_group($db))
                : tc_default_register_group($db),
            'tv' => 0,
            // 管理员代建账号视为已验证:大多没有邮箱,一旦开启邮箱验证
            // 这批用户会被「请先验证邮箱后再登录」永久挡在门外且无法自助验证
            'emailVerifiedAt' => 1,
        );
        // 演示管理员默认额度:未显式填写时给一个很大的值,方便演示;填了就以填写值为准
        $quota = array_key_exists('quota', $b)
            ? max(0, (float) $b['quota'])
            : ($isDemo ? 1e15 : $db['settings']['freeQuota']);
        if ($isDemo) {
            // 演示管理员:可改设置/授权,有效期后自动还原,且不可修改密码、管理其它账号或查看用户对话。
            // 有效期以本次创建时指定(或默认)的值为准,再拍下改动前状态作为还原快照。
            $minutes = isset($b['demoMinutes']) ? (int) $b['demoMinutes'] : (int) (isset($db['settings']['demoExpireMinutes']) ? $db['settings']['demoExpireMinutes'] : 10);
            $minutes = min(1440, max(1, $minutes ?: 10));
            $user['demo'] = true;
            $db['settings']['demoExpireMinutes'] = $minutes;
            // 拍下改动前状态作为还原快照;若已有生效中的快照则保留最早那份作为基准
            tc_demo_arm($db, $user);
            $user['demoExpireAt'] = (is_array($db['demoSnapshot']) && !empty($db['demoSnapshot']['expireAt']))
                ? (int) $db['demoSnapshot']['expireAt'] : 0;
        }
        tc_set_password($user, $password);
        $db['users'][] = $user;
        if ($quota > 0) tc_add_quota($db, $user, $quota);
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_update_user() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        tc_demo_guard($admin, '演示管理员不能管理用户账号');
        $b = tc_read_json_body();
        $user = null;
        foreach ($db['users'] as $u) if ($u['id'] === (string) (isset($b['userId']) ? $b['userId'] : '')) { $user = $u; break; }
        if (!$user) tc_fail(404, '用户不存在');
        if (tc_is_demo_user($user) && array_key_exists('password', $b) && (string) $b['password'] !== '') {
            tc_fail(403, '演示账号不允许修改密码');
        }
        if (array_key_exists('password', $b) && (string) $b['password'] !== '') {
            $pwd = (string) $b['password'];
            if (strlen($pwd) < 4) tc_fail(400, '密码至少 4 个字符');
            tc_set_password($user, $pwd);
        }
        if (array_key_exists('admin', $b)) {
            $nextAdmin = !empty($b['admin']);
            if ($user['id'] === $admin['id'] && !$nextAdmin) tc_fail(400, '不能取消自己的管理员权限');
            if (!empty($user['admin']) && !$nextAdmin) {
                $n = 0; foreach ($db['users'] as $u) if (!empty($u['admin'])) $n++;
                if ($n <= 1) tc_fail(400, '至少需要保留一个管理员');
            }
            $user['admin'] = $nextAdmin;
            if ($nextAdmin) {
                $ag = tc_find_builtin_group($db, 'admin');
                if ($ag && !empty($ag['id'])) $user['groupId'] = $ag['id'];
            } else {
                $ag = tc_find_builtin_group($db, 'admin');
                $gid = isset($user['groupId']) ? (string) $user['groupId'] : '';
                if ($ag && $gid === (string) $ag['id']) $user['groupId'] = tc_default_register_group($db);
            }
        }
        if (array_key_exists('name', $b)) {
            $name = trim((string) $b['name']);
            if ($name === '') tc_fail(400, '用户名不能为空');
            foreach ($db['users'] as $u) {
                if ($u['id'] !== $user['id'] && strtolower($u['name']) === strtolower($name)) tc_fail(409, '用户名已存在');
            }
            $user['name'] = $name;
        }
        // 演示管理员身份可随时设置/取消(不限于创建时)
        if (array_key_exists('demo', $b)) {
            $wantDemo = !empty($b['demo']);
            $wasDemo = !empty($user['demo']);
            if ($wantDemo) {
                // 演示管理员必须是管理员,并归入管理员组
                $user['admin'] = true;
                $ag = tc_find_builtin_group($db, 'admin');
                if ($ag && !empty($ag['id'])) $user['groupId'] = $ag['id'];
                // 不允许把自己变成演示管理员而全站再无普通管理员(那样会失去账号管理能力)
                if ($user['id'] === $admin['id']) {
                    $others = 0;
                    foreach ($db['users'] as $u) {
                        if ($u['id'] !== $user['id'] && !empty($u['admin']) && empty($u['demo'])) $others++;
                    }
                    if ($others === 0) tc_fail(400, '至少要保留一个非演示的管理员，请先另设一位管理员');
                }
                if (isset($b['demoMinutes'])) {
                    $db['settings']['demoExpireMinutes'] = min(1440, max(1, (int) $b['demoMinutes'] ?: 10));
                }
                $user['demo'] = true;
                // 转为演示的那一刻即还原原点:强制重拍快照并重新计时
                if (!$wasDemo) tc_demo_arm($db, $user, true);
                $user['demoExpireAt'] = (is_array($db['demoSnapshot']) && !empty($db['demoSnapshot']['expireAt']))
                    ? (int) $db['demoSnapshot']['expireAt'] : 0;
            } elseif ($wasDemo) {
                // 取消演示身份:若已无演示账号,快照与演示模式一并清除,避免日后误还原
                unset($user['demo']);
                unset($user['demoExpireAt']);
                $stillDemo = false;
                foreach ($db['users'] as $u) {
                    if ($u['id'] !== $user['id'] && !empty($u['demo'])) { $stillDemo = true; break; }
                }
                if (!$stillDemo) {
                    $db['demoSnapshot'] = null;
                    $db['settings']['demoMode'] = false;
                }
            }
        }
        tc_replace_user($db, $user);
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_set_quota() {
    tc_with_db(true, function (&$db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不能调整用户额度');
        $b = tc_read_json_body();
        $user = null;
        foreach ($db['users'] as $u) if ($u['id'] === (string) (isset($b['userId']) ? $b['userId'] : '')) { $user = $u; break; }
        if (!$user) tc_fail(404, '用户不存在');
        tc_enforce_quota_expiry($db, $user);
        if (array_key_exists('delta', $b)) {
            $d = (float) $b['delta'];
            if ($d == 0) tc_fail(400, '增量无效');
            if ($d > 0) tc_add_quota($db, $user, $d);
            else {
                tc_enforce_quota_expiry($db, $user);
                $user['quota'] = max(0, (isset($user['quota']) ? (float) $user['quota'] : 0) + $d);
                // 管理员手动扣减同样核销分账,保持"账面 = 无期限额度 + Σ分账剩余"的等式
                tc_consume_quota_grants($user, -$d);
                tc_replace_user($db, $user);
            }
        } else {
            $q = (float) $b['quota'];
            if ($q < 0) tc_fail(400, '额度必须是 >= 0 的数字');
            tc_enforce_quota_expiry($db, $user);
            $cur = isset($user['quota']) ? (float) $user['quota'] : 0;
            if ($q > $cur) $db['stats']['totalQuotaGiven'] = (isset($db['stats']['totalQuotaGiven']) ? (float) $db['stats']['totalQuotaGiven'] : 0) + ($q - $cur);
            $user['quota'] = $q;
            // 绝对值设置视为管理员全权重覆盖:清空分账,余额不再受有效期约束
            $user['quotaGrants'] = array();
            tc_replace_user($db, $user);
        }
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

// 彻底删除一个用户及其对话、自建供应商(硬注销与后台删用户共用)
function tc_purge_user(&$db, $id) {
    $idx = -1;
    foreach ($db['users'] as $i => $u) if ($u['id'] === $id) { $idx = $i; break; }
    if ($idx < 0) return array('removed' => false, 'removedProviders' => 0);
    array_splice($db['users'], $idx, 1);
    $map = tc_assoc($db['userChats']);
    unset($map[$id]);
    $db['userChats'] = tc_object_map($map);
    // 该用户的已删除对话留档一并清除(账号都没了,留档没有归属)
    $delMap = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
    unset($delMap[$id]);
    $db['userDeletedChats'] = tc_object_map($delMap);
    // 笔记文档、修订号与分享链接一并清除
    tc_drop_user_notes($db, $id);
    // 工具箱里的 HTML 一并清除(内容就在库里,没有旁挂文件)
    tc_drop_user_toolbox($db, $id);
    // 用户设置(偏好/外观/群聊配置)同样不再保留
    tc_drop_user_settings($db, $id);
    $ownIds = array();
    foreach ($db['providers'] as $p) if (isset($p['ownerId']) && $p['ownerId'] === $id) $ownIds[] = $p['id'];
    foreach ($ownIds as $pid) tc_remove_provider($db, $pid);
    return array('removed' => true, 'removedProviders' => count($ownIds));
}

// 软注销:清空隐私资料并给用户名/邮箱加「已注销」标记,让原用户名与原邮箱都可被重新注册。
// 账号本体保留(用户外键、用量台账不至于悬空),但已无法登录。
function tc_soft_delete_user(&$db, $id) {
    $stamp = substr(bin2hex(random_bytes(3)), 0, 6);
    foreach ($db['users'] as &$u) {
        if (!isset($u['id']) || $u['id'] !== $id) continue;
        $origName = (string) (isset($u['name']) ? $u['name'] : 'user');
        // 用户名加后缀:改名后原名字可被重新注册(用户名唯一性校验看的是当前值)
        $newName = tc_tombstone_name($db, $origName, $stamp);
        $u['name'] = $newName;
        // 邮箱同样加标记,使原邮箱不再占用(找回密码/邮箱验证因此不会冲突)
        if (!empty($u['email'])) $u['email'] = 'deleted+' . $stamp . '+' . $u['email'];
        $u['emailVerifiedAt'] = 0;
        // 清空一切可识别与可用凭据
        $u['passwordHash'] = '';
        $u['salt'] = '';
        $u['tools'] = array();
        $u['oauth'] = array();
        $u['oauthName'] = '';
        $u['apiKeys'] = array();
        $u['lastIp'] = '';
        $u['deleted'] = true;
        $u['deletedAt'] = tc_now();
        $u['tv'] = (int) (isset($u['tv']) ? $u['tv'] : 0) + 1;   // 立即失效所有已签发令牌
        $u['quota'] = 0;
        unset($u);
        // 对话与自建供应商一并清除(用户要求「清除全部数据」)
        $map = tc_assoc($db['userChats']);
        unset($map[$id]);
        $db['userChats'] = tc_object_map($map);
        $delMap = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
        unset($delMap[$id]);
        $db['userDeletedChats'] = tc_object_map($delMap);
        tc_drop_user_notes($db, $id);
        tc_drop_user_toolbox($db, $id);
        tc_drop_user_settings($db, $id);
        $ownIds = array();
        foreach ($db['providers'] as $p) if (isset($p['ownerId']) && $p['ownerId'] === $id) $ownIds[] = $p['id'];
        foreach ($ownIds as $pid) tc_remove_provider($db, $pid);
        return array('ok' => true, 'name' => $newName, 'removedProviders' => count($ownIds));
    }
    unset($u);
    return array('ok' => false);
}

// 生成不与现有用户重名的注销占位名(如「张三-已注销-a1b2c3」)
function tc_tombstone_name($db, $orig, $stamp) {
    $base = tc_utf_cut((string) $orig, 18);
    $cand = $base . '-已注销-' . $stamp;
    $taken = array();
    foreach ($db['users'] as $u) $taken[strtolower((string) (isset($u['name']) ? $u['name'] : ''))] = true;
    if (!isset($taken[strtolower($cand)])) return $cand;
    // 极端情况:再补一轮随机
    do { $cand = $base . '-已注销-' . substr(bin2hex(random_bytes(4)), 0, 8); }
    while (isset($taken[strtolower($cand)]));
    return $cand;
}

function tc_api_admin_delete_user($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能删除用户');
        $idx = -1;
        foreach ($db['users'] as $i => $u) if ($u['id'] === $id) { $idx = $i; break; }
        if ($idx < 0) tc_fail(404, '用户不存在');
        if ($db['users'][$idx]['id'] === $admin['id']) tc_fail(400, '不能删除当前登录的管理员账号');
        $res = tc_purge_user($db, $id);
        tc_json(200, array('ok' => true, 'removedProviders' => $res['removedProviders']));
    });
}

// 一键清除全部游客账号:游客是按 IP 自动创建的一次性账号,提供了后台整体清理。
// 会一并移除其对话与自建供应商;管理员与普通成员不受影响。
function tc_api_admin_purge_guests() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能清除游客');
        $keep = array();
        $removed = 0;
        $removedIds = array();
        foreach ($db['users'] as $u) {
            if (!empty($u['guest'])) { $removed++; $removedIds[] = $u['id']; continue; }
            $keep[] = $u;
        }
        $db['users'] = $keep;
        // 清理游客的对话、删除留档与自建供应商
        $map = tc_assoc($db['userChats']);
        foreach ($removedIds as $id) unset($map[$id]);
        $db['userChats'] = tc_object_map($map);
        $revs = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
        foreach ($removedIds as $id) unset($revs[$id]);
        $db['userChatRevisions'] = tc_object_map($revs);
        $delMap = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
        foreach ($removedIds as $id) unset($delMap[$id]);
        $db['userDeletedChats'] = tc_object_map($delMap);
        $ownIds = array();
        foreach ($db['providers'] as $p) {
            if (isset($p['ownerId']) && in_array($p['ownerId'], $removedIds, true)) $ownIds[] = $p['id'];
        }
        foreach ($ownIds as $pid) tc_remove_provider($db, $pid);
        tc_json(200, array('ok' => true, 'removed' => $removed, 'removedProviders' => count($ownIds)));
    });
}

// 用户批量删除:一次多个 id,逐个等价于单个删除(含对话与自建供应商清理)。
// 跳过当前登录管理员与不存在的 id,并在结果里回报,便于前端提示。
function tc_api_admin_bulk_delete_users() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示账号不能删除用户');
        $b = tc_read_json_body();
        $ids = isset($b['ids']) && is_array($b['ids']) ? $b['ids'] : array();
        $ids = array_values(array_unique(array_filter(array_map(function ($v) { return substr(trim((string) $v), 0, 80); }, $ids))));
        if (!$ids) tc_fail(400, '请先选择要删除的用户');
        if (count($ids) > 500) tc_fail(400, '一次最多删除 500 个用户');
        $deleted = 0; $skipped = array();
        foreach ($ids as $id) {
            if ($id === $admin['id']) { $skipped[] = $id; continue; }
            $idx = -1;
            foreach ($db['users'] as $i => $u) if ($u['id'] === $id) { $idx = $i; break; }
            if ($idx < 0) { $skipped[] = $id; continue; }
            array_splice($db['users'], $idx, 1);
            $map = tc_assoc($db['userChats']);
            unset($map[$id]);
            $db['userChats'] = tc_object_map($map);
            $revs = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
            unset($revs[$id]);
            $db['userChatRevisions'] = tc_object_map($revs);
            $delMap = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
            unset($delMap[$id]);
            $db['userDeletedChats'] = tc_object_map($delMap);
            $ownIds = array();
            foreach ($db['providers'] as $p) if (isset($p['ownerId']) && $p['ownerId'] === $id) $ownIds[] = $p['id'];
            foreach ($ownIds as $pid) tc_remove_provider($db, $pid);
            $deleted++;
        }
        tc_json(200, array('ok' => true, 'deleted' => $deleted, 'skipped' => count($skipped)));
    });
}

function tc_api_admin_groups() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        $groups = array();
        foreach ($db['userGroups'] as $g) {
            $mc = 0; $rc = 0;
            foreach ($db['users'] as $u) if (isset($u['groupId']) && $u['groupId'] === $g['id']) $mc++;
            foreach ($db['accessRules'] as $r) if ($r['groupId'] === $g['id']) $rc++;
            $groups[] = array(
                'id' => $g['id'],
                'name' => $g['name'],
                'createdAt' => $g['createdAt'],
                'builtin' => !empty($g['builtin']),
                'role' => isset($g['role']) ? (string) $g['role'] : '',
                'memberCount' => $mc,
                'ruleCount' => $rc,
            );
        }
        tc_json(200, array('groups' => $groups, 'defaultGroupId' => tc_default_register_group($db)));
    });
}

function tc_api_admin_create_group() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $name = substr(trim((string) (isset($b['name']) ? $b['name'] : '')), 0, 40);
        if ($name === '') tc_fail(400, '组名不能为空');
        foreach ($db['userGroups'] as $g) if ($g['name'] === $name) tc_fail(409, '组名已存在');
        $group = array('id' => tc_uid(), 'name' => $name, 'createdAt' => tc_now());
        $db['userGroups'][] = $group;
        tc_json(200, array('group' => array_merge($group, array('memberCount' => 0, 'ruleCount' => 0))));
    });
}

function tc_api_admin_update_group($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $g = null;
        foreach ($db['userGroups'] as $x) if ($x['id'] === $id) { $g = $x; break; }
        if (!$g) tc_fail(404, '组不存在');
        if (!empty($g['builtin'])) tc_fail(400, '系统用户组不能改名');
        $name = substr(trim((string) (isset($b['name']) ? $b['name'] : '')), 0, 40);
        if ($name === '') tc_fail(400, '组名不能为空');
        foreach ($db['userGroups'] as $x) if ($x['id'] !== $id && $x['name'] === $name) tc_fail(409, '组名已存在');
        $g['name'] = $name;
        tc_replace_by_id($db['userGroups'], $id, $g);
        tc_json(200, array('group' => $g));
    });
}

function tc_api_admin_delete_group($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $idx = -1;
        foreach ($db['userGroups'] as $i => $g) if ($g['id'] === $id) { $idx = $i; break; }
        if ($idx < 0) tc_fail(404, '组不存在');
        if (!empty($db['userGroups'][$idx]['builtin'])) tc_fail(400, '系统用户组不能删除');
        array_splice($db['userGroups'], $idx, 1);
        foreach ($db['users'] as &$u) if (isset($u['groupId']) && $u['groupId'] === $id) $u['groupId'] = null;
        unset($u);
        $rules = array();
        foreach ($db['accessRules'] as $r) if ($r['groupId'] !== $id) $rules[] = $r;
        $db['accessRules'] = $rules;
        if (isset($db['settings']['defaultGroupId']) && (string) $db['settings']['defaultGroupId'] === (string) $id) {
            $db['settings']['defaultGroupId'] = '';
            tc_ensure_default_group($db);
        }
        tc_json(200, array('ok' => true, 'defaultGroupId' => tc_default_register_group($db)));
    });
}

// (旧)仅授权给默认/管理员组;现统一由 tc_grant_all_groups_provider 覆盖所有用户组

function tc_api_admin_set_default_group() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $groupId = isset($b['groupId']) ? trim((string) $b['groupId']) : '';
        $group = $groupId !== '' ? tc_group_by_id($db, $groupId) : null;
        if (!$group) tc_fail(400, '请选择一个用户组');
        if (isset($group['role']) && $group['role'] === 'admin') tc_fail(400, '管理员组不能作为注册默认组');
        $db['settings']['defaultGroupId'] = $groupId;
        tc_json(200, array('defaultGroupId' => $groupId));
    });
}

function tc_api_admin_set_user_group() {
    tc_with_db(true, function (&$db) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不能修改用户组');
        $b = tc_read_json_body();
        $user = null;
        foreach ($db['users'] as $u) if ($u['id'] === (string) (isset($b['userId']) ? $b['userId'] : '')) { $user = $u; break; }
        if (!$user) tc_fail(404, '用户不存在');
        $groupId = !empty($b['groupId']) ? (string) $b['groupId'] : null;
        if ($groupId) {
            $ok = false;
            foreach ($db['userGroups'] as $g) if ($g['id'] === $groupId) { $ok = true; break; }
            if (!$ok) tc_fail(404, '组不存在');
        }
        if (!empty($user['admin'])) {
            $ag = tc_find_builtin_group($db, 'admin');
            if (!$ag || (string) $ag['id'] !== (string) $groupId) tc_fail(400, '管理员只能属于管理员组');
        } elseif ($groupId) {
            $picked = tc_group_by_id($db, $groupId);
            if ($picked && isset($picked['role']) && $picked['role'] === 'admin') tc_fail(400, '普通用户不能加入管理员组');
        }
        $user['groupId'] = $groupId;
        tc_replace_user($db, $user);
        tc_json(200, array('user' => tc_sanitize_user($user)));
    });
}

function tc_api_admin_get_access() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_json(200, array('rules' => $db['accessRules']));
    });
}

// 保存用户组模型授权,两种互斥写法:
//   ① 带 rules 数组 —— 全量替换整个 accessRules 表(批量导入用);
//      未出现在数组里的组/供应商规则会被删除,不要用它做单条修改。
//   ② 带 groupId+providerId(+modelIds) —— 只更新这一组这一供应商的规则,
//      其他规则原样保留;管理后台的授权勾选走的就是这个分支。
function tc_api_admin_set_access() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        if (isset($b['rules']) && is_array($b['rules'])) {
            $rules = array();
            foreach ($b['rules'] as $r) {
                if (!$r || empty($r['groupId']) || empty($r['providerId'])) continue;
                $rules[] = array(
                    'id' => !empty($r['id']) ? $r['id'] : tc_uid(),
                    'groupId' => (string) $r['groupId'],
                    'providerId' => (string) $r['providerId'],
                    'modelIds' => isset($r['modelIds']) && is_array($r['modelIds']) ? array_map('strval', $r['modelIds']) : array(),
                );
            }
            $db['accessRules'] = $rules;
            tc_json(200, array('rules' => $db['accessRules']));
        }
        $groupId = (string) (isset($b['groupId']) ? $b['groupId'] : '');
        $providerId = (string) (isset($b['providerId']) ? $b['providerId'] : '');
        if ($groupId === '' || $providerId === '') tc_fail(400, '请选择用户组和供应商');
        $okG = false; $okP = false;
        foreach ($db['userGroups'] as $g) if ($g['id'] === $groupId) $okG = true;
        foreach ($db['providers'] as $p) if ($p['id'] === $providerId) $okP = true;
        if (!$okG) tc_fail(404, '组不存在');
        if (!$okP) tc_fail(404, '供应商不存在');
        $targetGroup = tc_group_by_id($db, $groupId);
        if ($targetGroup && isset($targetGroup['role']) && $targetGroup['role'] === 'admin') {
            tc_fail(400, '管理员组始终拥有全部模型，不能修改授权');
        }
        $modelIds = isset($b['modelIds']) && is_array($b['modelIds']) ? array_map('strval', $b['modelIds']) : array();
        $idx = -1;
        foreach ($db['accessRules'] as $i => $r) {
            if ($r['groupId'] === $groupId && $r['providerId'] === $providerId) { $idx = $i; break; }
        }
        if (!$modelIds) {
            if ($idx >= 0) array_splice($db['accessRules'], $idx, 1);
        } else {
            $rule = array('id' => $idx >= 0 ? $db['accessRules'][$idx]['id'] : tc_uid(), 'groupId' => $groupId, 'providerId' => $providerId, 'modelIds' => $modelIds);
            if ($idx >= 0) $db['accessRules'][$idx] = $rule; else $db['accessRules'][] = $rule;
        }
        tc_json(200, array('rules' => $db['accessRules']));
    });
}

function tc_api_list_assistants() {
    // 内置助手已在每次请求的启动阶段播种(index.php),这里只读即可:
    // 之前每次打开助手面板都抢一次全局写锁(BEGIN IMMEDIATE)
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_json(200, tc_merge_assistant_catalog($db, $user));
    });
}

function tc_api_create_assistant_category() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_category_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        foreach (tc_visible_assistant_categories($db, $user) as $c) {
            if ($c['name'] === $parsed['name']) tc_fail(409, '分类名称已存在');
        }
        $category = array(
            'id' => tc_uid(), 'name' => $parsed['name'], 'sort' => $parsed['sort'],
            'scope' => 'user', 'ownerId' => $user['id'], 'createdAt' => tc_now(),
        );
        $db['assistantCategories'][] = $category;
        tc_json(200, array('category' => tc_public_category($category, array('count' => 0))));
    });
}

function tc_api_update_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $existing = tc_find_owned_category($db, $user, $id);
        if (!$existing) tc_fail(404, '分类不存在或无权修改');
        $parsed = tc_parse_category_input($b, $existing);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $existing['name'] = $parsed['name'];
        $existing['sort'] = $parsed['sort'];
        tc_replace_by_id($db['assistantCategories'], $id, $existing);
        tc_json(200, array('category' => tc_public_category($existing)));
    });
}

function tc_api_delete_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $existing = tc_find_owned_category($db, $user, $id);
        if (!$existing) tc_fail(404, '分类不存在或无权删除');
        foreach ($db['assistants'] as $a) {
            if ($a['categoryId'] !== $id) continue;
            $mine = isset($a['scope']) && $a['scope'] === 'user' ? (isset($a['ownerId']) && $a['ownerId'] === $user['id']) : (isset($a['scope']) && $a['scope'] === 'global');
            if ($mine) tc_fail(400, '请先移走或删除该分类下的助手');
        }
        $keep = array();
        foreach ($db['assistantCategories'] as $c) if ($c['id'] !== $id) $keep[] = $c;
        $db['assistantCategories'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_create_assistant() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_assistant_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $cat = tc_resolve_category_for_write($db, $user, isset($b['categoryId']) ? $b['categoryId'] : '');
        if (!empty($cat['error'])) tc_fail(400, $cat['error']);
        $item = array(
            'id' => tc_uid(), 'categoryId' => $cat['category']['id'],
            'name' => $parsed['name'], 'desc' => $parsed['desc'], 'prompt' => $parsed['prompt'],
            'icon' => $parsed['icon'], 'sort' => $parsed['sort'],
            'scope' => 'user', 'ownerId' => $user['id'], 'sourceId' => null,
            'createdAt' => tc_now(), 'updatedAt' => tc_now(),
        );
        $db['assistants'][] = $item;
        tc_json(200, array('assistant' => tc_public_assistant($item)));
    });
}

function tc_api_update_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $existing = tc_find_owned_assistant($db, $user, $id);
        if ($existing) {
            $parsed = tc_parse_assistant_input($b, $existing);
            if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
            if (!empty($b['categoryId'])) {
                $cat = tc_resolve_category_for_write($db, $user, $b['categoryId']);
                if (!empty($cat['error'])) tc_fail(400, $cat['error']);
                $existing['categoryId'] = $cat['category']['id'];
            }
            $existing = array_merge($existing, $parsed);
            $existing['updatedAt'] = tc_now();
            tc_replace_by_id($db['assistants'], $id, $existing);
            tc_json(200, array('assistant' => tc_public_assistant($existing)));
        }
        $global = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $global = $a; break; }
        if (!$global) tc_fail(404, '助手不存在');
        $parsed = tc_parse_assistant_input($b, $global);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $categoryId = $global['categoryId'];
        if (!empty($b['categoryId'])) {
            $cat = tc_resolve_category_for_write($db, $user, $b['categoryId']);
            if (!empty($cat['error'])) tc_fail(400, $cat['error']);
            $categoryId = $cat['category']['id'];
        }
        $prev = null;
        foreach ($db['assistants'] as $a) {
            if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && isset($a['sourceId']) && $a['sourceId'] === $global['id']) {
                $prev = $a; break;
            }
        }
        if ($prev) {
            $prev = array_merge($prev, $parsed);
            $prev['categoryId'] = $categoryId;
            $prev['updatedAt'] = tc_now();
            tc_replace_by_id($db['assistants'], $prev['id'], $prev);
            tc_json(200, array('assistant' => tc_public_assistant($prev)));
        }
        $copy = array(
            'id' => tc_uid(), 'categoryId' => $categoryId,
            'name' => $parsed['name'], 'desc' => $parsed['desc'], 'prompt' => $parsed['prompt'],
            'icon' => $parsed['icon'], 'sort' => $parsed['sort'],
            'scope' => 'user', 'ownerId' => $user['id'], 'sourceId' => $global['id'],
            'createdAt' => tc_now(), 'updatedAt' => tc_now(),
        );
        $db['assistants'][] = $copy;
        tc_json(200, array('assistant' => tc_public_assistant($copy)));
    });
}

function tc_api_delete_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $existing = tc_find_owned_assistant($db, $user, $id);
        if ($existing) {
            $keep = array();
            foreach ($db['assistants'] as $a) if ($a['id'] !== $id) $keep[] = $a;
            $db['assistants'] = $keep;
            tc_json(200, array('ok' => true));
        }
        $global = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $global = $a; break; }
        if (!$global) tc_fail(404, '助手不存在或无权删除');
        $prev = null;
        foreach ($db['assistants'] as $a) {
            if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && isset($a['sourceId']) && $a['sourceId'] === $global['id']) {
                $prev = $a; break;
            }
        }
        if (!$prev) tc_fail(403, '公共助手不能删除，可自行复制后再改');
        $keep = array();
        foreach ($db['assistants'] as $a) if ($a['id'] !== $prev['id']) $keep[] = $a;
        $db['assistants'] = $keep;
        tc_json(200, array('ok' => true, 'restored' => true));
    });
}

function tc_api_reset_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db);
        $bySource = null;
        foreach ($db['assistants'] as $a) {
            if (isset($a['scope']) && $a['scope'] === 'user' && isset($a['ownerId']) && $a['ownerId'] === $user['id'] && !empty($a['sourceId'])) {
                if ($a['id'] === $id || $a['sourceId'] === $id) { $bySource = $a; break; }
            }
        }
        if (!$bySource) tc_fail(404, '没有可还原的个人修改');
        $keep = array();
        foreach ($db['assistants'] as $a) if ($a['id'] !== $bySource['id']) $keep[] = $a;
        $db['assistants'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_list_assistants() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        tc_seed_default_assistants($db);
        $cats = array(); $items = array();
        foreach ($db['assistantCategories'] as $c) if (isset($c['scope']) && $c['scope'] === 'global') $cats[] = $c;
        foreach ($db['assistants'] as $a) if (isset($a['scope']) && $a['scope'] === 'global') $items[] = $a;
        usort($cats, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
        usort($items, function ($a, $b) { return tc_sort_zh($a, $b, 'name', 'name'); });
        $categories = array();
        foreach ($cats as $c) {
            $count = 0;
            foreach ($items as $a) if ($a['categoryId'] === $c['id']) $count++;
            $categories[] = tc_public_category($c, array('count' => $count));
        }
        $assistants = array();
        foreach ($items as $a) $assistants[] = tc_public_assistant($a);
        tc_json(200, array('categories' => $categories, 'assistants' => $assistants));
    });
}

function tc_api_admin_create_assistant_category() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_category_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        foreach ($db['assistantCategories'] as $c) {
            if (isset($c['scope']) && $c['scope'] === 'global' && $c['name'] === $parsed['name']) tc_fail(409, '分类名称已存在');
        }
        $category = array(
            'id' => tc_uid(), 'name' => $parsed['name'], 'sort' => $parsed['sort'],
            'scope' => 'global', 'ownerId' => null, 'createdAt' => tc_now(),
        );
        $db['assistantCategories'][] = $category;
        tc_json(200, array('category' => tc_public_category($category, array('count' => 0))));
    });
}

function tc_api_admin_update_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $existing = null;
        foreach ($db['assistantCategories'] as $c) if ($c['id'] === $id && isset($c['scope']) && $c['scope'] === 'global') { $existing = $c; break; }
        if (!$existing) tc_fail(404, '分类不存在');
        $parsed = tc_parse_category_input($b, $existing);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        foreach ($db['assistantCategories'] as $c) {
            if (isset($c['scope']) && $c['scope'] === 'global' && $c['id'] !== $id && $c['name'] === $parsed['name']) tc_fail(409, '分类名称已存在');
        }
        $existing['name'] = $parsed['name'];
        $existing['sort'] = $parsed['sort'];
        tc_replace_by_id($db['assistantCategories'], $id, $existing);
        tc_json(200, array('category' => tc_public_category($existing)));
    });
}

function tc_api_admin_delete_assistant_category($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $existing = null;
        foreach ($db['assistantCategories'] as $c) if ($c['id'] === $id && isset($c['scope']) && $c['scope'] === 'global') { $existing = $c; break; }
        if (!$existing) tc_fail(404, '分类不存在');
        foreach ($db['assistants'] as $a) {
            if ($a['categoryId'] === $id && isset($a['scope']) && $a['scope'] === 'global') tc_fail(400, '请先移走或删除该分类下的助手');
        }
        $keep = array();
        foreach ($db['assistantCategories'] as $c) if ($c['id'] !== $id) $keep[] = $c;
        $db['assistantCategories'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_create_assistant() {
    tc_with_db(true, function (&$db) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $parsed = tc_parse_assistant_input($b);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        $category = null;
        foreach ($db['assistantCategories'] as $c) {
            if ($c['id'] === (string) (isset($b['categoryId']) ? $b['categoryId'] : '') && isset($c['scope']) && $c['scope'] === 'global') {
                $category = $c; break;
            }
        }
        if (!$category) tc_fail(400, '请选择公共分类');
        $item = array(
            'id' => tc_uid(), 'categoryId' => $category['id'],
            'name' => $parsed['name'], 'desc' => $parsed['desc'], 'prompt' => $parsed['prompt'],
            'icon' => $parsed['icon'], 'sort' => $parsed['sort'],
            'scope' => 'global', 'ownerId' => null, 'sourceId' => null,
            'createdAt' => tc_now(), 'updatedAt' => tc_now(),
        );
        $db['assistants'][] = $item;
        tc_json(200, array('assistant' => tc_public_assistant($item)));
    });
}

function tc_api_admin_update_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $b = tc_read_json_body();
        $existing = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $existing = $a; break; }
        if (!$existing) tc_fail(404, '助手不存在');
        $parsed = tc_parse_assistant_input($b, $existing);
        if (!empty($parsed['error'])) tc_fail(400, $parsed['error']);
        if (!empty($b['categoryId'])) {
            $category = null;
            foreach ($db['assistantCategories'] as $c) {
                if ($c['id'] === (string) $b['categoryId'] && isset($c['scope']) && $c['scope'] === 'global') { $category = $c; break; }
            }
            if (!$category) tc_fail(400, '请选择公共分类');
            $existing['categoryId'] = $category['id'];
        }
        $existing = array_merge($existing, $parsed);
        $existing['updatedAt'] = tc_now();
        tc_replace_by_id($db['assistants'], $id, $existing);
        tc_json(200, array('assistant' => tc_public_assistant($existing)));
    });
}

function tc_api_admin_delete_assistant($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_require_admin($db);
        $existing = null;
        foreach ($db['assistants'] as $a) if ($a['id'] === $id && isset($a['scope']) && $a['scope'] === 'global') { $existing = $a; break; }
        if (!$existing) tc_fail(404, '助手不存在');
        $keep = array();
        foreach ($db['assistants'] as $a) if ($a['id'] !== $id) $keep[] = $a;
        $db['assistants'] = $keep;
        tc_json(200, array('ok' => true));
    });
}

function tc_api_admin_update_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $admin = tc_require_admin($db);
        $b = tc_read_json_body();
        $existing = null;
        foreach ($db['providers'] as $p) if ($p['id'] === $id) { $existing = $p; break; }
        if (!$existing) tc_fail(404, '供应商不存在');
        if (isset($b['action']) && $b['action'] === 'set-default') {
            if (!tc_provider_enabled($existing)) tc_fail(400, '供应商已停用，请先启用再设为默认');
            $db['defaultProviderId'] = $id;
            tc_json(200, array('ok' => true, 'defaultProviderId' => $id));
        }
        // 重新排序:body.order 为「供应商 id 顺序数组」,按数组下标写回 order
        if (isset($b['action']) && $b['action'] === 'reorder' && isset($b['order']) && is_array($b['order'])) {
            $pos = array();
            foreach (array_values($b['order']) as $i => $pid) $pos[(string) $pid] = (int) $i;
            foreach ($db['providers'] as &$pp) {
                if (isset($pos[(string) $pp['id']])) $pp['order'] = $pos[(string) $pp['id']];
            }
            unset($pp);
            tc_json(200, array('ok' => true));
        }
        $next = tc_normalize_provider_input($b, $existing, !empty($admin['demo']));
        $err = tc_validate_provider($next);
        if ($err) tc_fail(400, $err);
        $next['updatedAt'] = tc_now();
        if (isset($b['scope']) && ($b['scope'] === 'global' || $b['scope'] === 'user')) {
            $next['scope'] = $b['scope'];
            $next['ownerId'] = $b['scope'] === 'global' ? null : $admin['id'];
        }
        $ownerChanged = (string) (isset($next['ownerId']) ? $next['ownerId'] : '') !== (string) (isset($existing['ownerId']) ? $existing['ownerId'] : '');
        if (!tc_is_encrypted_secret($next['apiKey'])) {
            if (!tc_provider_set_key($next, $next['apiKey'])) tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        } elseif ($ownerChanged) {
            // 密文与属主绑定,属主变更时按旧绑定解密、再按新绑定重新加密
            $plain = tc_decrypt_secret($existing['apiKey'], tc_provider_key_aad($existing));
            if ($plain !== '' && !tc_provider_set_key($next, $plain)) tc_fail(500, '密钥加密失败，请检查服务器 openssl 环境');
        }
        tc_replace_by_id($db['providers'], $id, $next);
        // 本次新增的模型补进模型元数据表(待人工复核);已有条目不覆盖
        tc_model_meta_ensure_auto($db, $next['models']);
        // 全局供应商新增模型时,仅把"新出现的模型"补进已有授权清单;
        // 管理员此前刻意取消勾选的模型不会被重新授权,未授权该供应商的分组也不受影响
        if ((isset($next['scope']) ? $next['scope'] : '') === 'global') {
            $oldIds = array();
            foreach ((isset($existing['models']) ? $existing['models'] : array()) as $m) {
                if (isset($m['id']) && $m['id'] !== '') $oldIds[(string) $m['id']] = true;
            }
            $newIds = array();
            foreach ((isset($next['models']) ? $next['models'] : array()) as $m) {
                if (isset($m['id']) && $m['id'] !== '' && !isset($oldIds[(string) $m['id']])) $newIds[] = (string) $m['id'];
            }
            if ($newIds) tc_sync_new_models_access($db, $id, $newIds);
        }
        tc_json(200, array('provider' => tc_client_provider($next, false, true, false)));
    });
}

function tc_api_admin_delete_provider($id) {
    tc_with_db(true, function (&$db) use ($id) {
        tc_demo_guard(tc_require_admin($db), '演示管理员不能删除供应商');
        if (!tc_remove_provider($db, $id)) tc_fail(404, '供应商不存在');
        tc_json(200, array('ok' => true));
    });
}

function tc_api_list_models() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $q = tc_query();
        $providerId = isset($q['provider']) ? $q['provider'] : null;
        $list = tc_visible_providers_of($db, $user);
        $allowed = tc_user_access($db, $user);
        // 汇总 ID 的模型详情:合成供应商在 /api/providers 里是 agg:<组ID>,
        // 这里要按同一个 id 回一份,否则前台切到汇总 ID 后价格/窗口/可用性全取不到。
        if (tc_model_groups_on($db) && is_string($providerId) && strncmp($providerId, 'agg:', 4) === 0) {
            $group = tc_model_group_find($db, substr($providerId, 4));
            if (!$group) tc_fail(404, '汇总模型不存在或已停用');
            list($candidates, $err) = tc_model_group_candidates($db, $user, $group);
            if ($err !== '') tc_fail(400, $err);
            $label = (string) (isset($group['label']) && $group['label'] !== '' ? $group['label'] : $group['id']);
            $cost = 0;
            $minOut = null;
            $minCtx = null;
            $health = array('state' => 'idle', 'calls' => 0, 'ok' => 0, 'rate' => 0);
            $anyHealth = false;
            foreach ($candidates as $c) {
                $cc = tc_model_cost($c['provider'], $c['model']);
                if ($cc > $cost) $cost = $cc;
                list($co, $ccx) = tc_model_meta_caps(tc_model_meta_get($db, $c['model']));
                $minOut = $minOut === null ? $co : min($minOut, $co);
                $minCtx = $minCtx === null ? $ccx : min($minCtx, $ccx);
                $sum = tc_model_health_summary($db, $c['providerId']);
                $row = isset($sum[$c['model']]) ? $sum[$c['model']] : null;
                if ($row) {
                    $anyHealth = true;
                    $health['calls'] += (int) $row['calls'];
                    $health['ok'] += (int) $row['ok'];
                }
            }
            if ($group['cost'] !== null) $cost = (float) $group['cost'];
            // 汇总可用性 = 各候选合并后的成功率(前台只看一条,合并统计比单看首选更贴近实际体验)
            if ($anyHealth && $health['calls'] > 0) {
                $rate = $health['ok'] / $health['calls'];
                $okMin = min(100, max(1, (int) (isset($db['settings']['healthOkMin']) ? $db['settings']['healthOkMin'] : 75) ?: 75)) / 100;
                $warnMin = min(99, max(0, (int) (isset($db['settings']['healthWarnMin']) ? $db['settings']['healthWarnMin'] : 40))) / 100;
                if ($warnMin >= $okMin) $warnMin = max(0, $okMin - 0.01);
                $health['rate'] = round($rate, 4);
                $health['state'] = $rate >= $okMin ? 'ok' : ($rate >= $warnMin ? 'warn' : 'bad');
            }
            list($isImage, $isVideo) = tc_model_group_media_kind($group, $candidates);
            $item = array(
                'id' => (string) $group['id'],
                'name' => $label,
                'cost' => $cost,
                'maxTokens' => $minOut,
                'maxContext' => $minCtx,
                // 显式给出归类标记(即使为 false):避免前端按名字再猜一次把汇总项分错组
                'image' => $isImage,
                'video' => $isVideo,
                'agg' => true,
                'aggStrategy' => (string) $group['strategy'],
                'aggCount' => count($candidates),
            );
            tc_json(200, array(
                'models' => array($item),
                'providerId' => 'agg:' . (string) $group['id'],
                'providerName' => $label,
                'apiFormat' => 'chat',
                'costPerCall' => $cost,
                'costs' => array((string) $group['id'] => $cost),
                'scope' => 'global',
                'agg' => true,
                'aggStrategy' => (string) $group['strategy'],
                'aggCount' => count($candidates),
                'health' => array((string) $group['id'] => $health),
                'healthOkMin' => isset($db['settings']['healthOkMin']) ? (int) $db['settings']['healthOkMin'] : 75,
                'healthWarnMin' => isset($db['settings']['healthWarnMin']) ? (int) $db['settings']['healthWarnMin'] : 40,
            ));
        }
        $provider = null;
        if ($providerId) {
            foreach ($list as $p) if ($p['id'] === $providerId) { $provider = $p; break; }
            if (!$provider) tc_fail(404, '供应商不存在或无权访问');
        }
        $target = $provider ?: tc_get_default_provider($db, $user, $list);
        if (!$target) tc_json(200, array('models' => array(), 'providerId' => null));
        $vis = tc_visible_provider($user, $target, $allowed);
        if (!$vis) tc_json(200, array('models' => array(), 'providerId' => null));
        // 每模型单次扣费:模型级 cost 优先,未设置的回退供应商价格(前端提示里显示)
        $costs = array();
        foreach ((isset($target['models']) ? $target['models'] : array()) as $m) {
            if (!is_array($m)) continue;
            $mid = isset($m['id']) ? (string) $m['id'] : '';
            if ($mid === '') continue;
            $costs[$mid] = tc_model_cost($target, $mid);
        }
        // 输出上限/上下文窗口来自「模型元数据」表(按模型名匹配,全站渠道共用一份)。
        // 表里没有的模型用兜底常量补上,前台因此始终拿到确定值,不必再回退全局设置。
        $models = array();
        foreach ((isset($vis['models']) ? $vis['models'] : array()) as $m) {
            if (!is_array($m)) continue;
            list($capOut, $capCtx) = tc_model_meta_caps(tc_model_meta_get($db, isset($m['id']) ? (string) $m['id'] : ''));
            $m['maxTokens'] = $capOut;
            $m['maxContext'] = $capCtx;
            $models[] = $m;
        }
        tc_json(200, array(
            'models' => $models,
            'providerId' => $target['id'],
            'providerName' => $target['name'],
            'apiFormat' => isset($target['apiFormat']) ? $target['apiFormat'] : 'chat',
            'costPerCall' => tc_provider_cost($target),
            'costs' => $costs,
            'scope' => isset($target['scope']) ? $target['scope'] : 'user',
            'health' => tc_model_health_summary($db, $target['id']),
            // 可用性分级阈值(百分比),供前台把状态图标翻译成人话
            'healthOkMin' => isset($db['settings']['healthOkMin']) ? (int) $db['settings']['healthOkMin'] : 75,
            'healthWarnMin' => isset($db['settings']['healthWarnMin']) ? (int) $db['settings']['healthWarnMin'] : 40,
        ));
    });
}

function tc_api_parse_document() {
    @set_time_limit(150);
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        if (empty($_FILES['file']) || !is_array($_FILES['file'])) tc_fail(400, '请选择要解析的文件');
        $file = $_FILES['file'];
        $err = isset($file['error']) ? (int) $file['error'] : UPLOAD_ERR_NO_FILE;
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) tc_fail(400, '文件超过服务器上传限制');
        if ($err !== UPLOAD_ERR_OK) tc_fail(400, '文件上传失败');
        $tmp = isset($file['tmp_name']) ? (string) $file['tmp_name'] : '';
        if ($tmp === '' || !is_uploaded_file($tmp)) tc_fail(400, '文件上传无效');
        $name = tc_mineru_safe_name(isset($file['name']) ? $file['name'] : '');
        if (!tc_mineru_parseable($name)) tc_fail(400, '不支持这个格式');
        $size = isset($file['size']) ? (int) $file['size'] : 0;
        if ($size <= 0) tc_fail(400, '文件是空的');
        $bytes = file_get_contents($tmp);
        if ($bytes === false || $bytes === '') tc_fail(400, '文件读取失败');
        // 按文件类别路由解析通道:pdf/image/office 可在后台分别指定;html 只有 MinerU 支持
        $s = $db['settings'];
        $cat = tc_parse_category($name);
        $channels = isset($s['parseChannels']) && is_array($s['parseChannels']) ? $s['parseChannels'] : array();
        $channel = isset($channels[$cat]) ? (string) $channels[$cat] : 'mineru';
        if (!in_array($channel, array('mineru', 'paddle', 'mistral'), true)) $channel = 'mineru';
        if ($cat === 'html') $channel = 'mineru';
        $provider = 'MinerU';
        $mode = tc_mineru_token($s) !== '' ? 'precise' : 'lite';
        $limits = $mode === 'precise'
            ? array('maxBytes' => 200 * 1024 * 1024, 'maxPages' => 200)
            : array('maxBytes' => 10 * 1024 * 1024, 'maxPages' => 20);
        if ($channel === 'paddle') {
            $provider = 'PaddleOCR';
            $mode = 'paddle';
            $limits = array('maxBytes' => 100 * 1024 * 1024, 'maxPages' => 0);
            if (trim((string) (isset($s['paddleOcrUrl']) ? $s['paddleOcrUrl'] : '')) === '') {
                tc_fail(400, '后台已将 ' . strtoupper($cat) . ' 类文件指定为 PaddleOCR 通道，但还没有填写服务地址');
            }
            if (!tc_paddle_parseable($name)) {
                tc_fail(400, 'PaddleOCR 仅支持 PDF 与图片，' . $name . ' 请由管理员改用 MinerU 或 Mistral 通道');
            }
        } elseif ($channel === 'mistral') {
            $provider = 'Mistral OCR';
            $mode = 'mistral';
            $limits = array('maxBytes' => 50 * 1024 * 1024, 'maxPages' => 1000);
            if (trim((string) (isset($s['mistralOcrKey']) ? $s['mistralOcrKey'] : '')) === '') {
                tc_fail(400, '后台已将 ' . strtoupper($cat) . ' 类文件指定为 Mistral OCR 通道，但还没有填写 API Key');
            }
            if (!tc_mistral_parseable($name)) {
                tc_fail(400, 'Mistral OCR 不支持 ' . $name . '（仅 PDF/图片/DOCX/PPTX），请改用 MinerU 通道');
            }
        } else {
            // MinerU 通道:用户自备 Token 仅在该通道生效
            $token = tc_user_mineru_token($user, $s);
            $mode = $token !== '' ? 'precise' : 'lite';
            $limits = $mode === 'precise'
                ? array('maxBytes' => 200 * 1024 * 1024, 'maxPages' => 200)
                : array('maxBytes' => 10 * 1024 * 1024, 'maxPages' => 20);
        }
        if ($size > (int) $limits['maxBytes']) {
            tc_fail(400, '文件超过 ' . ($provider === 'MinerU' && $mode === 'lite' ? '轻量解析 10MB、20 页上限' : $provider . ' 的 ' . round($limits['maxBytes'] / 1048576) . 'MB 上限'));
        }
        $started = tc_now();
        if ($channel === 'paddle') {
            $parsed = tc_paddle_parse($s['paddleOcrUrl'], isset($s['paddleOcrKey']) ? $s['paddleOcrKey'] : '', $name, $bytes);
        } elseif ($channel === 'mistral') {
            $parsed = tc_mistral_parse($name, $bytes, $s['mistralOcrKey']);
        } else {
            $parsed = tc_mineru_parse($name, $bytes, tc_user_mineru_token($user, $s), 110);
        }
        $ms = tc_now() - $started;
        if (empty($parsed['ok'])) {
            $msg = isset($parsed['error']) ? (string) $parsed['error'] : '文档解析失败';
            tc_push_log(array(
                'kind' => 'parse', 'userName' => $user['name'], 'userId' => $user['id'],
                'provider' => $provider, 'model' => $mode, 'status' => isset($parsed['code']) ? (int) $parsed['code'] : 502,
                'ms' => $ms, 'cost' => 0, 'error' => substr($name . ' · ' . $msg, 0, 240),
            ));
            tc_fail(isset($parsed['code']) && (int) $parsed['code'] >= 400 && (int) $parsed['code'] < 600 ? (int) $parsed['code'] : 502, $msg);
        }
        $chars = function_exists('mb_strlen') ? mb_strlen($parsed['markdown'], 'UTF-8') : strlen($parsed['markdown']);
        tc_push_log(array(
            'kind' => 'parse', 'userName' => $user['name'], 'userId' => $user['id'],
            'provider' => $provider, 'model' => $mode, 'status' => 200,
            'ms' => $ms, 'cost' => 0, 'ip' => tc_client_ip(),
            'note' => $name . ' · ' . $chars . ' 字',
        ));
        tc_json(200, array(
            'name' => $name,
            'mode' => $mode,
            'channel' => $channel,
            'markdown' => $parsed['markdown'],
            'chars' => $chars,
            'limits' => $limits,
        ));
    });
}

// ============ AI 笔记 ============
// 数据流与对话同步同构:客户端持有完整文档(folders/notes/tombs),通过 /api/sync/notes
// 带 baseRevision 乐观并发推送;服务器按用户拆行存储(note:{uid}),不做逐字段合并。
// 附件落盘 data/notes/{用户ID}/(整目录禁网),通过带 HMAC 签名的 URL 由 /api/notes/file 输出,
// 非图片一律强制下载、不作为网页外链托管。

function tc_utf_cut($s, $n) {
    $s = (string) $s;
    return function_exists('mb_substr') ? mb_substr($s, 0, $n) : substr($s, 0, $n);
}

// 笔记功能可用性:总开关 × 访问级别(全站 / 仅管理员 / 仅名单),见 lib/features.php。
// 关闭时前台入口隐藏,接口一律拒绝(避免旧标签页继续写入)。
function tc_note_feature_guard($db, $user = null) {
    if ($user === null) $user = tc_require_auth($db);
    if (!tc_feature_allowed($db, $user, 'notes')) tc_fail(403, '本站未开放 AI 笔记功能，或你的账号没有使用权限');
    return $user;
}
// 图片魔数校验:扩展名可伪造,这里按文件头判断真实类型。
// 返回检测到的 MIME,或 ''(不是受支持的图片)。
// 只对声明为图片的扩展名做校验——避免把 .html 改名成 .png 就当成图片内联输出。
function tc_note_sniff_image_mime($bytes) {
    $b = (string) $bytes;
    if (strlen($b) < 12) return '';
    if (substr($b, 0, 8) === "\x89PNG\r\n\x1a\n") return 'image/png';
    if (substr($b, 0, 3) === "\xff\xd8\xff") return 'image/jpeg';
    if (substr($b, 0, 6) === 'GIF87a' || substr($b, 0, 6) === 'GIF89a') return 'image/gif';
    if (substr($b, 0, 4) === 'RIFF' && substr($b, 8, 4) === 'WEBP') return 'image/webp';
    if (substr($b, 0, 2) === 'BM') return 'image/bmp';
    if (substr($b, 0, 4) === "\x00\x00\x01\x00") return 'image/x-icon';
    if (substr($b, 4, 4) === 'ftyp') {
        $brand = substr($b, 8, 4);
        if (strpos($brand, 'avif') !== false || strpos($brand, 'avis') !== false) return 'image/avif';
        if (strpos($brand, 'heic') !== false || strpos($brand, 'heix') !== false) return 'image/heic';
    }
    // SVG 是文本格式:必须是 XML/SVG 开头且不含 <script>(脚本由输出侧 CSP sandbox 再兜一层)
    $head = ltrim(substr($b, 0, 4096));
    if (stripos($head, '<svg') !== false || stripos($head, '<?xml') === 0) {
        if (stripos($head, '<script') === false) return 'image/svg+xml';
    }
    return '';
}

// 笔记附件根目录:data/notes/ (整体禁网,只能经签名路由输出)
function tc_note_root_dir() {
    $dir = tc_data_dir() . '/notes';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}
// 用户附件目录:data/notes/{userId}/ —— 用不可变的用户 ID 而非用户名,
// 改名后路径不变,避免附件失联与越权落到他人目录。
function tc_note_user_dir($userId, $create = true) {
    $uid = preg_replace('/[^A-Za-z0-9_-]/', '', (string) $userId);
    if ($uid === '') return '';
    $dir = tc_note_root_dir() . '/' . $uid;
    if ($create && !is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}
// 附件 id 编码归属:uidHexLen 前缀固定长度十六进制用户指纹,其余为随机段。
// serve 时无需查库即可定位目录,同时保证不同用户 id 空间不重叠。
function tc_note_file_owner_tag($userId) {
    return substr(hash_hmac('sha256', 'noteowner:' . (string) $userId, tc_secret()), 0, 13);
}
function tc_note_file_dir_for($id) {
    $id = (string) $id;
    if (strlen($id) < 14 || !preg_match('/^[a-f0-9]+$/', $id)) return '';
    $ownerTag = substr($id, 0, 13);
    $users = tc_notes_owner_index();
    $uid = isset($users[$ownerTag]) ? (string) $users[$ownerTag] : '';
    if ($uid === '') return '';
    return tc_note_user_dir($uid, false);
}
// 附件索引(data/notes/index.json):owners 为归属指纹→用户 ID,files 为附件 id→笔记 id。
// files 用于附件鉴权:读取时判定「该附件属于哪篇笔记」,据此决定谁能下载。
// 缓存放在可重置的静态引用里:写入后必须让本请求的后续读取看到新值,
// 否则同一请求里「先建附件、再查归属」会拿到过期结果。
function &tc_notes_index_cache_ref() {
    static $cache = null;
    return $cache;
}
function tc_notes_index_normalize($idx) {
    return array(
        'owners' => (isset($idx['owners']) && is_array($idx['owners'])) ? $idx['owners'] : array(),
        'files' => (isset($idx['files']) && is_array($idx['files'])) ? $idx['files'] : array(),
    );
}
function tc_notes_index_read() {
    $cache = &tc_notes_index_cache_ref();
    if ($cache !== null) return $cache;
    $j = json_decode((string) @file_get_contents(tc_note_root_dir() . '/index.json'), true);
    $cache = tc_notes_index_normalize(is_array($j) ? $j : array());
    return $cache;
}
function tc_notes_owner_index() { $i = tc_notes_index_read(); return $i['owners']; }
function tc_notes_index_write($idx) {
    $cache = &tc_notes_index_cache_ref();
    $cache = null;
    tc_json_mutate(tc_note_root_dir() . '/index.json', function ($cur) use ($idx) {
        // 合并而不是整体覆盖:并发的另一个请求刚加进去的附件映射不能被抹掉
        $next = tc_notes_index_normalize($idx);
        foreach (array('owners', 'files') as $k) {
            foreach ($next[$k] as $key => $v) $cur[$k][$key] = $v;
        }
        return $cur;
    }, array('owners' => array(), 'files' => array()));
}
// 记录归属(用户指纹)与附件→笔记映射
function tc_notes_index_add($userId, $fileId, $noteId) {
    $tag = tc_note_file_owner_tag($userId);
    $cache = &tc_notes_index_cache_ref();
    $cache = null;
    tc_json_mutate(tc_note_root_dir() . '/index.json', function ($cur) use ($userId, $tag, $fileId, $noteId) {
        $cur = tc_notes_index_normalize($cur);
        $cur['owners'][$tag] = (string) $userId;
        if ($fileId !== '' && $noteId !== '') $cur['files'][$fileId] = (string) $noteId;
        return $cur;
    }, array('owners' => array(), 'files' => array()));
}
function tc_notes_index_remove_file($fileId) {
    $cache = &tc_notes_index_cache_ref();
    $cache = null;
    tc_json_mutate(tc_note_root_dir() . '/index.json', function ($cur) use ($fileId) {
        $cur = tc_notes_index_normalize($cur);
        unset($cur['files'][$fileId]);
        return $cur;
    }, array('owners' => array(), 'files' => array()));
}
function tc_note_file_owner($fileId) {
    $idx = tc_notes_index_read();
    $tag = substr((string) $fileId, 0, 13);
    return isset($idx['owners'][$tag]) ? (string) $idx['owners'][$tag] : '';
}
function tc_note_file_bound_note($fileId) {
    $idx = tc_notes_index_read();
    return isset($idx['files'][$fileId]) ? (string) $idx['files'][$fileId] : '';
}
function tc_note_file_token($id) {
    return substr(hash_hmac('sha256', 'noteattach:' . (string) $id, tc_secret()), 0, 24);
}
function tc_note_file_path($id, $name = '') {
    $url = '/api/notes/file?id=' . rawurlencode((string) $id) . '&s=' . tc_note_file_token($id);
    if ($name !== '') $url .= '&name=' . rawurlencode((string) $name);
    return $url;
}

// ---- 附件的「浏览器直取」凭据 ----
// 正文里的图片是 <img src="/api/notes/file?...">、其它附件是普通 <a> 链接,而浏览器
// 加载这类资源**不会带 Authorization 头**(登录态是 localStorage 里的 Bearer 令牌,
// 不是 Cookie)。附件接口要判「是不是本人」,只认请求头的话预览区永远只显示裂图。
// 因此在每次 Bearer 鉴权成功时补发一枚 Cookie,专供浏览器自发请求附件时携带。
// 它不等于会话令牌:带 scope 声明,除附件读取路由外没有任何接口认它,也不能做写操作
// (删除附件仍只认 Authorization 头);作用路径也收窄到附件路由本身。
if (!defined('TC_NOTE_ATTACH_COOKIE')) define('TC_NOTE_ATTACH_COOKIE', 'tc_note_attach');

// Cookie 作用路径:子目录部署要带上目录前缀,否则浏览器不会在
// /subdir/api/notes/file 这样的请求上带它。
function tc_note_attach_cookie_path() {
    $script = str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '/'));
    $script = rtrim($script, '/');
    if ($script === '' || $script === '.' || $script === '/') return '/api/notes/file';
    return $script . '/api/notes/file';
}

function tc_note_attach_cookie_issue($db, $user) {
    $days = isset($db['settings']['sessionDays']) ? max(1, (int) $db['settings']['sessionDays']) : 7;
    $token = tc_jwt_sign(array(
        'scope' => 'noteattach',
        'sub' => (string) $user['id'],
        'tv' => isset($user['tv']) ? (int) $user['tv'] : 0,
        'ep' => isset($db['settings']['authEpoch']) ? max(1, (int) $db['settings']['authEpoch']) : 1,
        'exp' => tc_now() + $days * 24 * 3600 * 1000,
    ));
    $opts = array(
        'expires' => time() + $days * 24 * 3600,
        'path' => tc_note_attach_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
    );
    // Secure 只在 HTTPS 下加:免费主机常见 http 直连,写死 Secure 会让 Cookie 根本存不下来
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') $opts['secure'] = true;
    @setcookie(TC_NOTE_ATTACH_COOKIE, $token, $opts);
}

// 校验附件 Cookie,返回用户 ID(无效返回 '')
function tc_note_attach_cookie_uid($db) {
    $raw = isset($_COOKIE[TC_NOTE_ATTACH_COOKIE]) ? (string) $_COOKIE[TC_NOTE_ATTACH_COOKIE] : '';
    if ($raw === '') return '';
    $payload = tc_jwt_verify($raw);
    if (!$payload || !isset($payload['scope']) || (string) $payload['scope'] !== 'noteattach') return '';
    if (empty($payload['sub']) || empty($payload['exp']) || $payload['exp'] < tc_now()) return '';
    // 失效规则与会话令牌一致:改密码/重置会话(tv)、全站会话纪元(authEpoch)都会让它作废
    $epoch = isset($db['settings']['authEpoch']) ? (int) $db['settings']['authEpoch'] : 1;
    $payloadEpoch = isset($payload['ep']) ? (int) $payload['ep'] : 1;
    if ($payloadEpoch !== $epoch) return '';
    foreach ($db['users'] as $u) {
        if ((string) $u['id'] !== (string) $payload['sub']) continue;
        $tv = isset($u['tv']) ? (int) $u['tv'] : 0;
        $ptv = isset($payload['tv']) ? (int) $payload['tv'] : 0;
        return $ptv === $tv ? (string) $u['id'] : '';
    }
    return '';
}

// 已有同用户的有效 Cookie 就不重复下发,免得每个接口响应都挂一条 Set-Cookie
function tc_note_attach_cookie_sync($db, $user) {
    if (headers_sent()) return;
    if (tc_note_attach_cookie_uid($db) === (string) $user['id']) return;
    tc_note_attach_cookie_issue($db, $user);
}

function tc_note_attach_cookie_clear() {
    if (headers_sent()) return;
    @setcookie(TC_NOTE_ATTACH_COOKIE, '', array(
        'expires' => time() - 3600,
        'path' => tc_note_attach_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}

// ---- 工具箱页面的取用凭据 ----
// 「在新标签页打开工具」是一次**浏览器直接导航**,带不了 Authorization 头,所以和笔记附件
// 一样只能认 Cookie。作用路径收窄到页面端点本身,别的请求都收不到它。
function tc_toolbox_cookie_path() {
    $script = str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '/'));
    $script = rtrim($script, '/');
    if ($script === '' || $script === '.' || $script === '/') return '/api/toolbox/page';
    return $script . '/api/toolbox/page';
}

function tc_toolbox_cookie_issue($db, $user) {
    $days = isset($db['settings']['sessionDays']) ? max(1, (int) $db['settings']['sessionDays']) : 7;
    $token = tc_jwt_sign(array(
        'scope' => 'toolboxpage',
        'sub' => (string) $user['id'],
        'tv' => isset($user['tv']) ? (int) $user['tv'] : 0,
        'ep' => isset($db['settings']['authEpoch']) ? max(1, (int) $db['settings']['authEpoch']) : 1,
        'exp' => tc_now() + $days * 24 * 3600 * 1000,
    ));
    $opts = array(
        'expires' => time() + $days * 24 * 3600,
        'path' => tc_toolbox_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
    );
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') $opts['secure'] = true;
    @setcookie(TC_TOOLBOX_COOKIE, $token, $opts);
}

// 校验工具箱页面 Cookie,返回用户 ID(无效返回 '')
function tc_toolbox_cookie_uid($db) {
    $raw = isset($_COOKIE[TC_TOOLBOX_COOKIE]) ? (string) $_COOKIE[TC_TOOLBOX_COOKIE] : '';
    if ($raw === '') return '';
    $payload = tc_jwt_verify($raw);
    if (!$payload || !isset($payload['scope']) || (string) $payload['scope'] !== 'toolboxpage') return '';
    if (empty($payload['sub']) || empty($payload['exp']) || $payload['exp'] < tc_now()) return '';
    // 失效规则与会话令牌一致:改密码/重置会话(tv)、全站会话纪元(authEpoch)都会让它作废
    $epoch = isset($db['settings']['authEpoch']) ? (int) $db['settings']['authEpoch'] : 1;
    $payloadEpoch = isset($payload['ep']) ? (int) $payload['ep'] : 1;
    if ($payloadEpoch !== $epoch) return '';
    foreach ($db['users'] as $u) {
        if ((string) $u['id'] !== (string) $payload['sub']) continue;
        $tv = isset($u['tv']) ? (int) $u['tv'] : 0;
        $ptv = isset($payload['tv']) ? (int) $payload['tv'] : 0;
        return $ptv === $tv ? (string) $u['id'] : '';
    }
    return '';
}

function tc_toolbox_cookie_sync($db, $user) {
    if (headers_sent()) return;
    if (tc_toolbox_cookie_uid($db) === (string) $user['id']) return;
    tc_toolbox_cookie_issue($db, $user);
}

function tc_toolbox_cookie_clear() {
    if (headers_sent()) return;
    @setcookie(TC_TOOLBOX_COOKIE, '', array(
        'expires' => time() - 3600,
        'path' => tc_toolbox_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}
// 该用户已用附件字节数(含 .bin 数据文件)
function tc_note_user_usage($userId) {
    $dir = tc_note_user_dir($userId, false);
    if ($dir === '' || !is_dir($dir)) return 0;
    $total = 0;
    foreach ((array) @glob($dir . '/*.bin') as $f) {
        $sz = @filesize($f);
        if ($sz !== false) $total += (int) $sz;
    }
    return $total;
}
// 空间上限(字节):站点设置 notesQuotaMb,0 = 不限
function tc_note_quota_bytes($db) {
    $mb = isset($db['settings']['notesQuotaMb']) ? (int) $db['settings']['notesQuotaMb'] : 0;
    return $mb > 0 ? $mb * 1048576 : 0;
}

function tc_notes_of($db, $userId) {
    $map = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
    $doc = isset($map[$userId]) && is_array($map[$userId]) ? $map[$userId] : array();
    return array(
        'folders' => isset($doc['folders']) && is_array($doc['folders']) ? $doc['folders'] : array(),
        'notes' => isset($doc['notes']) && is_array($doc['notes']) ? $doc['notes'] : array(),
        'tombs' => tc_assoc(isset($doc['tombs']) ? $doc['tombs'] : array()),
    );
}
function tc_notes_revision_of($db, $userId) {
    $map = tc_assoc(isset($db['userNoteRevisions']) ? $db['userNoteRevisions'] : array());
    return isset($map[$userId]) ? (int) $map[$userId] : 0;
}
function tc_bump_notes_revision(&$db, $userId) {
    $revs = tc_assoc(isset($db['userNoteRevisions']) ? $db['userNoteRevisions'] : array());
    $revs[$userId] = tc_notes_revision_of($db, $userId) + 1;
    $db['userNoteRevisions'] = tc_object_map($revs);
}
function tc_set_notes(&$db, $userId, $doc) {
    $map = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
    $map[$userId] = $doc;
    $db['userNotes'] = tc_object_map($map);
    tc_bump_notes_revision($db, $userId);
}
// 注销/删除用户时清理笔记数据(硬删与软删共用)
function tc_drop_user_notes(&$db, $id) {
    $noteMap = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
    unset($noteMap[$id]);
    $db['userNotes'] = tc_object_map($noteMap);
    $revs = tc_assoc(isset($db['userNoteRevisions']) ? $db['userNoteRevisions'] : array());
    unset($revs[$id]);
    $db['userNoteRevisions'] = tc_object_map($revs);
    $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
    foreach ($shares as $t => $s) {
        if ((string) ($s['ownerId'] ?? '') === (string) $id) unset($shares[$t]);
    }
    $db['noteShares'] = tc_object_map($shares);
}

function tc_sanitize_note_tags($tags) {
    $out = array();
    foreach ((array) $tags as $t) {
        $t = trim((string) $t);
        if ($t === '') continue;
        $out[] = tc_utf_cut($t, 24);
        if (count($out) >= 20) break;
    }
    return array_values(array_unique($out));
}

function tc_sanitize_note_folder($f) {
    if (!is_array($f)) return null;
    $id = substr(trim((string) (isset($f['id']) ? $f['id'] : '')), 0, 64);
    if ($id === '') return null;
    $name = trim((string) (isset($f['name']) ? $f['name'] : ''));
    if ($name === '') return null;
    $parentId = substr(trim((string) (isset($f['parentId']) ? $f['parentId'] : '')), 0, 64);
    return array(
        'id' => $id,
        'parentId' => $parentId !== '' ? $parentId : null,
        'name' => tc_utf_cut($name, 80),
        'description' => tc_utf_cut(trim((string) (isset($f['description']) ? $f['description'] : '')), 200),
        'createdAt' => (float) (isset($f['createdAt']) ? $f['createdAt'] : tc_now()),
        'updatedAt' => (float) (isset($f['updatedAt']) ? $f['updatedAt'] : tc_now()),
    );
}

function tc_sanitize_note_row($n) {
    if (!is_array($n)) return null;
    $id = substr(trim((string) (isset($n['id']) ? $n['id'] : '')), 0, 64);
    if ($id === '') return null;
    $title = trim((string) (isset($n['title']) ? $n['title'] : ''));
    $atts = array();
    $rawAtts = isset($n['attachments']) && is_array($n['attachments']) ? $n['attachments'] : array();
    foreach (array_slice($rawAtts, 0, 50) as $a) {
        if (!is_array($a)) continue;
        $url = (string) (isset($a['url']) ? $a['url'] : '');
        if ($url === '' || strlen($url) > 600) continue;
        $atts[] = array(
            'id' => substr(trim((string) (isset($a['id']) ? $a['id'] : '')), 0, 64),
            'name' => tc_utf_cut((string) (isset($a['name']) ? $a['name'] : 'file'), 200),
            'url' => $url,
            'mimeType' => substr((string) (isset($a['mimeType']) ? $a['mimeType'] : ''), 0, 100),
            'size' => (int) (isset($a['size']) ? $a['size'] : 0),
            'createdAt' => (float) (isset($a['createdAt']) ? $a['createdAt'] : tc_now()),
        );
    }
    $src = isset($n['source']) && is_array($n['source']) ? $n['source'] : null;
    $shareMode = (string) (isset($n['shareMode']) ? $n['shareMode'] : 'private');
    if (!in_array($shareMode, array('private', 'view-link', 'edit-link'), true)) $shareMode = 'private';
    $note = array(
        'id' => $id,
        'folderId' => substr(trim((string) (isset($n['folderId']) ? $n['folderId'] : '')), 0, 64),
        'title' => tc_utf_cut($title !== '' ? $title : '无标题', 200),
        'content' => (string) (isset($n['content']) ? $n['content'] : ''),
        'tags' => tc_sanitize_note_tags(isset($n['tags']) ? $n['tags'] : array()),
        'attachments' => $atts,
        'isPinned' => !empty($n['isPinned']),
        'shareMode' => $shareMode,
        'shareToken' => substr(trim((string) (isset($n['shareToken']) ? $n['shareToken'] : '')), 0, 64),
        'createdAt' => (float) (isset($n['createdAt']) ? $n['createdAt'] : tc_now()),
        'updatedAt' => (float) (isset($n['updatedAt']) ? $n['updatedAt'] : tc_now()),
    );
    if ($note['folderId'] === '') $note['folderId'] = 'uncat';
    // 超长笔记给出明确错误,不再静默截断(截断会让用户以为保存成功、重开后尾部消失)
    if (strlen($note['content']) > TC_NOTE_MAX_CHARS) {
        tc_fail(413, '单篇笔记内容超过 ' . number_format(TC_NOTE_MAX_CHARS) . ' 字符上限，请拆分到多篇笔记');
    }
    if (is_array($src)) {
        $note['source'] = array(
            'conversationId' => substr(trim((string) (isset($src['conversationId']) ? $src['conversationId'] : '')), 0, 64),
            'messageId' => substr(trim((string) (isset($src['messageId']) ? $src['messageId'] : '')), 0, 64),
            'userQuestion' => substr((string) (isset($src['userQuestion']) ? $src['userQuestion'] : ''), 0, 2000),
            'generatedByAI' => !empty($src['generatedByAI']),
        );
    }
    return $note;
}

function tc_sanitize_notes_doc($doc) {
    if (!is_array($doc)) $doc = array();
    $folders = array();
    $seen = array();
    $rawFolders = isset($doc['folders']) && is_array($doc['folders']) ? $doc['folders'] : array();
    foreach (array_slice($rawFolders, 0, 300) as $f) {
        $row = tc_sanitize_note_folder($f);
        if ($row === null || isset($seen[$row['id']])) continue;
        $seen[$row['id']] = true;
        $folders[] = $row;
    }
    $notes = array();
    $rawNotes = isset($doc['notes']) && is_array($doc['notes']) ? $doc['notes'] : array();
    foreach (array_slice($rawNotes, 0, 2000) as $n) {
        $row = tc_sanitize_note_row($n);
        if ($row === null) continue;
        $notes[] = $row;
    }
    $tombs = array();
    $rawTombs = isset($doc['tombs']) && is_array($doc['tombs']) ? $doc['tombs'] : array();
    foreach (array_slice($rawTombs, 0, 500, true) as $tid => $ts) {
        $tid = substr(trim((string) $tid), 0, 64);
        if ($tid === '') continue;
        $tombs[$tid] = (int) $ts;
    }
    return array('folders' => $folders, 'notes' => $notes, 'tombs' => tc_object_map($tombs));
}

function tc_note_shares_of($db, $userId) {
    $out = array();
    foreach (tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array()) as $s) {
        if (!is_array($s) || (string) ($s['ownerId'] ?? '') !== (string) $userId) continue;
        $out[] = array(
            'noteId' => (string) ($s['noteId'] ?? ''),
            'token' => (string) ($s['token'] ?? ''),
            'mode' => (string) ($s['mode'] ?? 'view-link'),
            'createdAt' => (float) ($s['createdAt'] ?? 0),
            'expireAt' => (float) ($s['expireAt'] ?? 0),
        );
    }
    usort($out, function ($a, $b) { return ((int) $a['createdAt']) <=> ((int) $b['createdAt']); });
    return $out;
}

function tc_note_share_find($db, $token) {
    $map = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
    $s = isset($map[(string) $token]) ? $map[(string) $token] : null;
    if (!is_array($s) || (string) ($s['token'] ?? '') !== (string) $token) return null;
    // 有效期:到期即视为不存在(链接自动失效,无需手动关闭)
    $exp = isset($s['expireAt']) ? (int) $s['expireAt'] : 0;
    if ($exp > 0 && tc_now() >= $exp) return null;
    return $s;
}

function tc_note_find_in_doc($doc, $noteId) {
    foreach ((array) ($doc['notes'] ?? array()) as $i => $n) {
        if (is_array($n) && (string) ($n['id'] ?? '') === (string) $noteId) return array($i, $n);
    }
    return array(-1, null);
}

// GET /api/sync/notes:拉取当前用户笔记文档 + 修订号 + 分享状态(分享状态以服务端为准)
function tc_api_notes_get() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        tc_json(200, array(
            'doc' => tc_sanitize_notes_doc(tc_notes_of($db, $user['id'])),
            'revision' => tc_notes_revision_of($db, $user['id']),
            'shares' => tc_note_shares_of($db, $user['id']),
        ));
    });
}

// POST /api/sync/notes:整文档推送(baseRevision 乐观并发;冲突时 409 带回云端文档)
function tc_api_notes_save() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('notesync:' . $user['id'], 60)) {
            tc_fail(429, '同步过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(8 * 1024 * 1024);
        $current = tc_notes_revision_of($db, $user['id']);
        $base = isset($b['baseRevision']) ? (int) $b['baseRevision'] : $current;
        if ($base !== $current) {
            tc_json(409, array(
                'error' => array('message' => '笔记已在其他页面更新'),
                'doc' => tc_sanitize_notes_doc(tc_notes_of($db, $user['id'])),
                'revision' => $current,
                'shares' => tc_note_shares_of($db, $user['id']),
            ));
        }
        $doc = tc_sanitize_notes_doc(isset($b['doc']) ? $b['doc'] : array());
        tc_set_notes($db, $user['id'], $doc);
        tc_json(200, array('ok' => true, 'revision' => tc_notes_revision_of($db, $user['id'])));
    });
}

// ============ 在线工具箱(/api/sync/toolbox + /api/toolbox/page) ============
// 用户把自写的 HTML 单页存进自己的工具箱,随时打开运行。同步模型与笔记完全同构:
// 整份文档 + 乐观并发修订号(baseRevision),冲突时 409 带回云端文档。
//
// 安全模型(改动本段前必读)——
// 存进来的 HTML **服务端一个字节都不清洗**:脚本、表单、内联样式正是这类小工具的正当
// 用法,清洗会把工具箱变成只能摆样子的残废。所以隔离不能靠改写内容,只能靠「文档必须
// 落在不透明源里」这一条,前端两处入口都是这么做的:
//   · 面板内预览/试跑:iframe 用 srcdoc 注入 + sandbox(不带 allow-same-origin);
//   · 「在新标签页打开」:走本节的 tc_api_toolbox_page(),响应头带 CSP `sandbox`。
// 两条路都不给 allow-same-origin,也不给 allow-popups-to-escape-sandbox —— 工具因此既
// 读不到 localStorage 里的 oc_token,也无法通过弹窗挣脱沙箱拿到本站登录态。
// 谁要是给这里加一条「同源直出 HTML」的便捷分支、或去掉任一处的 sandbox,就等于把本站
// 的账户令牌交给任意一份从别处粘贴进来的 HTML,与在线浏览器 iframe 同一条红线。

// 工具箱功能可用性:总开关 × 访问级别(见 lib/features.php)。
function tc_toolbox_feature_guard($db, $user = null) {
    if ($user === null) $user = tc_require_auth($db);
    if (!tc_feature_allowed($db, $user, 'toolbox')) tc_fail(403, '本站未开放在线工具箱功能，或你的账号没有使用权限');
    return $user;
}

function tc_toolbox_of($db, $userId) {
    $map = tc_assoc(isset($db['userToolbox']) ? $db['userToolbox'] : array());
    $doc = isset($map[$userId]) && is_array($map[$userId]) ? $map[$userId] : array();
    return array(
        'cats' => isset($doc['cats']) && is_array($doc['cats']) ? $doc['cats'] : array(),
        'items' => isset($doc['items']) && is_array($doc['items']) ? $doc['items'] : array(),
        // 墓碑:防止别的设备用旧副本把已删除的工具合并回来(与笔记同机制)
        'tombs' => tc_assoc(isset($doc['tombs']) ? $doc['tombs'] : array()),
    );
}

// 系统工具箱(后台维护、全员共用)。库里还没有这一行时用内置默认值兜底:
// 引导流程只保证「尽快落库」,不保证「这个请求之前已经落库」,少了这层兜底就会出现
// 「刚装好,第一屏打开工具箱是空的」。注意判据是「不是数组」而不是「为空」——
// 管理员把内置工具全删了会存成 {cats:[],items:[]},那是合法状态,不能被默认值盖回去。
function tc_sys_toolbox_of($db) {
    $doc = isset($db['sysToolbox']) ? $db['sysToolbox'] : null;
    if (!is_array($doc)) {
        require_once __DIR__ . '/toolbox-default.php';
        $doc = tc_toolbox_default_system();
    }
    return array(
        'cats' => isset($doc['cats']) && is_array($doc['cats']) ? $doc['cats'] : array(),
        'items' => isset($doc['items']) && is_array($doc['items']) ? $doc['items'] : array(),
    );
}
function tc_toolbox_revision_of($db, $userId) {
    $map = tc_assoc(isset($db['userToolboxRevisions']) ? $db['userToolboxRevisions'] : array());
    return isset($map[$userId]) ? (int) $map[$userId] : 0;
}
function tc_bump_toolbox_revision(&$db, $userId) {
    $revs = tc_assoc(isset($db['userToolboxRevisions']) ? $db['userToolboxRevisions'] : array());
    $revs[$userId] = tc_toolbox_revision_of($db, $userId) + 1;
    $db['userToolboxRevisions'] = tc_object_map($revs);
}
function tc_set_toolbox(&$db, $userId, $doc) {
    $map = tc_assoc(isset($db['userToolbox']) ? $db['userToolbox'] : array());
    $map[$userId] = $doc;
    $db['userToolbox'] = tc_object_map($map);
    tc_bump_toolbox_revision($db, $userId);
}
// 注销/删除用户时清理工具箱(硬删与软删共用)
function tc_drop_user_toolbox(&$db, $id) {
    $map = tc_assoc(isset($db['userToolbox']) ? $db['userToolbox'] : array());
    unset($map[$id]);
    $db['userToolbox'] = tc_object_map($map);
    $revs = tc_assoc(isset($db['userToolboxRevisions']) ? $db['userToolboxRevisions'] : array());
    unset($revs[$id]);
    $db['userToolboxRevisions'] = tc_object_map($revs);
}

// 工具 id 来自客户端,只留安全字符(它会进 URL 与签名)
function tc_toolbox_item_id($raw) {
    return substr(preg_replace('/[^A-Za-z0-9_-]/', '', (string) $raw), 0, 64);
}

// 分类:[{id, name}]。id 与工具 id 同规则(要进 URL 与签名);没有名字的分类在界面上
// 是个点不动的空壳,直接丢弃。超上限按截断处理而不是报错 —— 分类只是归类手段,
// 为此让整次保存失败不划算(工具与总量的超限仍按报错处理,见 tc_sanitize_toolbox_doc)。
function tc_sanitize_toolbox_cats($raw, $max = TC_TOOLBOX_MAX_CATS) {
    $out = array();
    $seen = array();
    if (!is_array($raw)) $raw = array();
    foreach ($raw as $c) {
        if (!is_array($c)) continue;
        $id = tc_toolbox_item_id(isset($c['id']) ? $c['id'] : '');
        if ($id === '' || isset($seen[$id])) continue;
        $name = trim((string) (isset($c['name']) ? $c['name'] : ''));
        if ($name === '') continue;
        $seen[$id] = true;
        $out[] = array('id' => $id, 'name' => tc_utf_cut($name, TC_TOOLBOX_CAT_NAME_MAX));
        if (count($out) >= $max) break;
    }
    return $out;
}

function tc_sanitize_toolbox_row($it) {
    if (!is_array($it)) return null;
    $id = tc_toolbox_item_id(isset($it['id']) ? $it['id'] : '');
    if ($id === '') return null;
    $title = trim((string) (isset($it['title']) ? $it['title'] : ''));
    if ($title === '') $title = '未命名工具';
    // HTML 原样保存,只做两件事:①修正非法 UTF-8(否则 tc_json_encode 会整体失败,
    // 用户存进去的东西全丢);②按单条上限报错而不是截断(截断会默默毁掉页面)。
    $html = tc_utf8_clean((string) (isset($it['html']) ? $it['html'] : ''));
    if (strlen($html) > TC_TOOLBOX_MAX_HTML) {
        tc_fail(413, '单个工具的 HTML 超过 ' . TC_TOOLBOX_MAX_HTML . ' 字符上限，请拆小或压缩后再保存');
    }
    // 所属分类只清洗成合法 id,**不校验它在 cats 里是否存在**:分类被删掉后,
    // 指向它的工具应当原样留着(前台显示为「未分类」),而不是顺手把归属抹掉。
    return array(
        'id' => $id,
        'cat' => tc_toolbox_item_id(isset($it['cat']) ? $it['cat'] : ''),
        'title' => tc_utf_cut($title, 60),
        'html' => $html,
        'createdAt' => (float) (isset($it['createdAt']) ? $it['createdAt'] : tc_now()),
        'updatedAt' => (float) (isset($it['updatedAt']) ? $it['updatedAt'] : tc_now()),
    );
}

// $maxItems / $maxTotal 由调用方给:用户自己的工具箱与后台维护的系统工具箱是两套额度。
function tc_sanitize_toolbox_doc($raw, $maxItems = TC_TOOLBOX_MAX_ITEMS, $maxTotal = TC_TOOLBOX_MAX_TOTAL) {
    if (!is_array($raw)) $raw = array();
    $items = array();
    $seen = array();
    $total = 0;
    $list = isset($raw['items']) && is_array($raw['items']) ? $raw['items'] : array();
    foreach ($list as $it) {
        $row = tc_sanitize_toolbox_row($it);
        if ($row === null || isset($seen[$row['id']])) continue;
        $seen[$row['id']] = true;
        $total += strlen($row['html']);
        $items[] = $row;
        // 条数与总量都按上限**报错**,不静默丢弃:工具箱是用户自己点名要留的东西,
        // 悄悄少一个比明确拒绝更让人摸不着头脑。先判再入列,保证不会「加了一半」。
        if (count($items) > $maxItems) {
            tc_fail(413, '工具数量超过 ' . $maxItems . ' 个上限，请先删除一些');
        }
        if ($total > $maxTotal) {
            tc_fail(413, '工具箱总大小超过上限，请删除或精简部分工具');
        }
    }
    // 墓碑只保留「确实不在列表里」的 id,并限量。
    // 这里认 stdClass 也认数组:整份文档在「下发 → 客户端 → 推回」之间会各过一次
    // JSON 编解码,而 json_decode 不带 assoc 时 map 是对象。多认一种形态,免得某个
    // 调用点忘了 assoc 就把整份墓碑静默丢掉(丢墓碑 = 删除会被别的设备撤销)。
    $tombs = array();
    $rawTombs = isset($raw['tombs']) ? $raw['tombs'] : array();
    if ($rawTombs instanceof stdClass) $rawTombs = (array) $rawTombs;
    if (!is_array($rawTombs)) $rawTombs = array();
    foreach (array_slice($rawTombs, 0, 500, true) as $tid => $ts) {
        $tid = tc_toolbox_item_id($tid);
        if ($tid === '' || isset($seen[$tid])) continue;
        $tombs[$tid] = (float) $ts;
    }
    return array(
        'cats' => tc_sanitize_toolbox_cats(isset($raw['cats']) ? $raw['cats'] : array()),
        'items' => $items,
        'tombs' => $tombs,
    );
}

// 各类上限下发一份给前端:计数器、新建分类时的名字长度都按它来,免得前后端各写一套数字。
function tc_toolbox_limits() {
    return array(
        'maxItems' => TC_TOOLBOX_MAX_ITEMS,
        'maxHtml' => TC_TOOLBOX_MAX_HTML,
        'maxTotal' => TC_TOOLBOX_MAX_TOTAL,
        'maxCats' => TC_TOOLBOX_MAX_CATS,
        'catNameMax' => TC_TOOLBOX_CAT_NAME_MAX,
        'maxSysItems' => TC_TOOLBOX_MAX_SYS_ITEMS,
        'maxSysTotal' => TC_TOOLBOX_MAX_SYS_TOTAL,
    );
}

// 工具页面地址的签名,只证明「链接是我们发的」,不代表有权访问 ——
// 真正的鉴权在 tc_api_toolbox_page() 里按功能开关 + 归属判。
// $sys 走独立命名空间:系统工具与用户工具的 id 各自独立(用户可以给自己那份命名 base64),
// 不分开签名的话,一张用户工具页的合法链接就能拿去读同名的系统工具,反之亦然。
function tc_toolbox_page_token($id, $sys = false) {
    return substr(hash_hmac('sha256', ($sys ? 'toolbox:sys:' : 'toolbox:') . (string) $id, tc_secret()), 0, 24);
}
function tc_toolbox_page_url($id, $sys = false) {
    return '/api/toolbox/page?id=' . rawurlencode((string) $id)
        . '&s=' . tc_toolbox_page_token($id, $sys)
        . ($sys ? '&sys=1' : '');
}
// 下发用投影:给每个工具带上签名后的页面地址(签名在服务端算,不交给客户端拼)。
// 客户端推回文档时多带的 pageUrl 会被 tc_sanitize_toolbox_row 丢掉 —— 它按字段白名单重建。
function tc_toolbox_public_doc($db, $userId) {
    $doc = tc_toolbox_of($db, $userId);
    foreach ($doc['items'] as &$it) $it['pageUrl'] = tc_toolbox_page_url($it['id']);
    unset($it);
    // 墓碑必须编码成 JSON 对象:空的 PHP map 用数组发出去会变成 `[]`,而前端把它当
    // 普通对象用看不出区别(Array 也是 object),但 JSON.stringify 会丢掉数组上的
    // 非下标属性 —— 于是「删除」在这一端被静默吞掉,工具下次又被别处的旧副本合并回来。
    // 与笔记/设置的 map 字段同一个坑,所以这里显式转对象。
    $doc['tombs'] = tc_object_map($doc['tombs']);
    return $doc;
}

// 系统工具箱的下发投影。没有 tombs:它是单份文档,不存在「多设备各拿旧副本合并」的问题。
// 默认**不下发正文**:这批内置工具是整页,重写版 12 套合计约 860KB(gzip 也有 230KB),而列表
// 只需要标题 / 分类 / 体积这几个字段。正文只在「预览、查看源码、加入我的工具箱」这三处用得上,
// 那时前端按 pageUrl 去取 —— 取到的就是这里没发的同一份 stored HTML(见 tc_api_toolbox_page)。
// 后台要编辑正文,传 $withHtml = true。
function tc_sys_toolbox_public_doc($db, $withHtml = false) {
    $doc = tc_sys_toolbox_of($db);
    foreach ($doc['items'] as &$it) {
        $it['pageUrl'] = tc_toolbox_page_url($it['id'], true);
        $n = strlen((string) (isset($it['html']) ? $it['html'] : ''));
        if (!$withHtml) unset($it['html']);
        // 体积单独给一个字段:卡片上要显示「多少 KB」,而正文已经不在下发里了,不能靠它算
        $it['size'] = $n;
    }
    unset($it);
    return $doc;
}

// GET /api/sync/toolbox:自己的整份文档 + 系统工具(前台只读,改它走 /api/admin/toolbox)
function tc_api_toolbox_get() {
    tc_with_db(false, function ($db) {
        $user = tc_toolbox_feature_guard($db);
        tc_json(200, array(
            'doc' => tc_toolbox_public_doc($db, $user['id']),
            'revision' => tc_toolbox_revision_of($db, $user['id']),
            'sys' => tc_sys_toolbox_public_doc($db),
            'limits' => tc_toolbox_limits(),
        ));
    });
}

// POST /api/sync/toolbox:整文档推送(baseRevision 乐观并发;冲突时 409 带回云端文档)
function tc_api_toolbox_save() {
    tc_with_db(true, function (&$db) {
        $user = tc_toolbox_feature_guard($db);
        if (!tc_rate_limit_check('tboxsync:' . $user['id'], 60)) {
            tc_fail(429, '同步过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(8 * 1024 * 1024);
        $current = tc_toolbox_revision_of($db, $user['id']);
        $base = isset($b['baseRevision']) ? (int) $b['baseRevision'] : $current;
        if ($base !== $current) {
            tc_json(409, array(
                'error' => array('message' => '工具箱已在其他页面更新'),
                'doc' => tc_toolbox_public_doc($db, $user['id']),
                'revision' => $current,
            ));
        }
        $doc = tc_sanitize_toolbox_doc(isset($b['doc']) ? $b['doc'] : array());
        tc_set_toolbox($db, $user['id'], $doc);
        // 回带落库后的文档:客户端本地拼出来的那几条没有 pageUrl(那是服务端算的签名地址),
        // 不回带的话「刚存完就点在新标签页打开」会因为拿不到地址而静默失败,非得刷新一次
        // 面板才行。顺带回传服务端清洗/截断后的真身,列表显示的就是真正存下来的东西。
        tc_json(200, array(
            'ok' => true,
            'revision' => tc_toolbox_revision_of($db, $user['id']),
            'doc' => tc_toolbox_public_doc($db, $user['id']),
        ));
    });
}

// ============ 系统工具箱(后台维护,见 admin.html 的「在线工具箱」面板) ============
// 这份文档全员共用:前台每个人都能打开运行,但只有管理员能增删改。刻意**不放进演示快照**
// 的还原范围:它是全站内容而不是演示者的私人数据,放行等于让演示账号永久删掉全站内置工具,
// 所以演示管理员一律拒绝写入(与敏感词库同一处理)。
// GET /api/admin/toolbox
function tc_api_admin_toolbox_get() {
    tc_with_db(false, function ($db) {
        tc_require_admin($db);
        tc_json(200, array(
            'doc' => tc_sys_toolbox_public_doc($db, true),
            'limits' => tc_toolbox_limits(),
        ));
    });
}

// POST /api/admin/toolbox:整份文档替换(与前台同步同一套清洗与上限,只是额度更大)
function tc_api_admin_toolbox_save() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_admin($db);
        if (tc_is_demo_user($user)) tc_fail(403, '演示账号不能修改系统工具箱');
        $b = tc_read_json_body(16 * 1024 * 1024);
        $doc = tc_sanitize_toolbox_doc(
            isset($b['doc']) ? $b['doc'] : array(),
            TC_TOOLBOX_MAX_SYS_ITEMS,
            TC_TOOLBOX_MAX_SYS_TOTAL
        );
        unset($doc['tombs']);   // 系统工具箱不需要墓碑(见 tc_sys_toolbox_public_doc)
        $db['sysToolbox'] = $doc;
        $db['toolboxSysSeeded'] = true;   // 后台一存过,就再也不用种子兜底了
        tc_json(200, array('ok' => true, 'doc' => tc_sys_toolbox_public_doc($db, true)));
    });
}

// 工具页面的响应头。**两条路(用户自存 / 系统工具)必须共用这一处**:
// 隔离就是这几行,分头写迟早会各自漂移,而漂移的那一次就是把本站登录态交给页面里的脚本。
function tc_toolbox_serve_html($html) {
    header('Content-Type: text/html; charset=utf-8');
    header('X-Frame-Options: SAMEORIGIN');
    // 隔离本体:CSP `sandbox` 让这份文档成为**不透明源**(即使被直接打开也一样),
    // 没有 allow-same-origin 就读不到本站存储与 Cookie,没有 allow-popups-to-escape-sandbox
    // 就无法靠弹窗挣脱。放行 scripts/forms/modals/popups 让工具能跑自己的交互。
    // 其余来源放开(与在线浏览器同一口径):里面的网络请求由用户自己承担,拿不到本站身份。
    header("Content-Security-Policy: default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-modals allow-popups");
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    // 用户内容不进共享缓存:同一台机器上换个人登录不该看到上一位的工具
    header('Cache-Control: no-store, must-revalidate');
    header('Content-Length: ' . strlen($html));
    echo $html;
    exit;
}

// GET /api/toolbox/page?id=<id>&s=<签名>[&sys=1]
// 把存的 HTML 原样吐出,但**响应头必须先把文档变成不透明源**,否则它就是本站源内
// 一个可执行的网页:能读 localStorage.oc_token、能带着登录态调本站任意接口。
// 注意 index.php 开头的 tc_send_cors() 发的是全局 `X-Frame-Options: DENY` +
// CSP `frame-ancestors 'none'`,下面要走 tc_toolbox_serve_html() 覆盖(与 lib/web.php 的
// tc_web_serve 同一处理)。
function tc_api_toolbox_page() {
    $q = tc_query();
    $id = tc_toolbox_item_id(isset($q['id']) ? $q['id'] : '');
    $sig = (string) (isset($q['s']) ? $q['s'] : '');
    $isSys = isset($q['sys']) && (string) $q['sys'] === '1';
    if ($id === '' || $sig === '' || !hash_equals(tc_toolbox_page_token($id, $isSys), $sig)) {
        http_response_code(403);
        header('Content-Type: text/plain; charset=utf-8');
        echo '签名无效';
        exit;
    }
    // 签名只说明「链接是本站发的」,不代表「你有权看」:这里再判一次功能开关与归属。
    // 页面是在 iframe / 新标签页里被浏览器**直接导航**的,带不了 Authorization 头,
    // 所以认人要用 Cookie 兜底(与笔记附件同一机制)。任何一步不满足一律 404,
    // 不额外暴露「这个 id 存在」。
    $html = null;
    tc_with_db(false, function ($db) use (&$html, $id, $isSys) {
        $me = tc_auth_user($db);
        if (!$me) {
            $uid = tc_toolbox_cookie_uid($db);
            if ($uid !== '') {
                foreach ($db['users'] as $u) {
                    if ((string) $u['id'] === $uid && empty($u['deletedAt'])) { $me = $u; break; }
                }
            }
        }
        if (!$me || !tc_feature_allowed($db, $me, 'toolbox')) return;
        if ($isSys) {
            $doc = tc_sys_toolbox_of($db);
        } else {
            // 用户工具必须是**自己名下**的:别人的工具即使链接泄漏也打不开
            $doc = tc_toolbox_of($db, (string) $me['id']);
        }
        foreach ($doc['items'] as $it) {
            if ((string) $it['id'] === $id) { $html = (string) $it['html']; break; }
        }
    });
    if ($html === null) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '工具不存在';
        exit;
    }
    tc_toolbox_serve_html($html);
}

// ============ 用户设置云同步(/api/sync/settings) ============
// 与对话/笔记同构:整份文档 + 乐观并发修订号(baseRevision);冲突时 409 带回云端文档,
// 客户端按「逐键更新时间戳」合并后重推。文档只含用户自己的界面偏好(主题/字体/模型选择/
// 群聊配置/生成参数等),不含任何凭据 —— 供应商密钥在服务端单独加密存储,不随设置同步。
function tc_user_settings_of($db, $userId) {
    $map = tc_assoc(isset($db['userSettings']) ? $db['userSettings'] : array());
    return (isset($map[$userId]) && is_array($map[$userId])) ? $map[$userId] : array();
}
function tc_user_settings_revision_of($db, $userId) {
    $map = tc_assoc(isset($db['userSettingsRevisions']) ? $db['userSettingsRevisions'] : array());
    return isset($map[$userId]) ? (int) $map[$userId] : 0;
}
function tc_bump_user_settings_revision(&$db, $userId) {
    $revs = tc_assoc(isset($db['userSettingsRevisions']) ? $db['userSettingsRevisions'] : array());
    $revs[$userId] = tc_user_settings_revision_of($db, $userId) + 1;
    $db['userSettingsRevisions'] = tc_object_map($revs);
}
function tc_set_user_settings(&$db, $userId, $doc) {
    $map = tc_assoc(isset($db['userSettings']) ? $db['userSettings'] : array());
    $map[$userId] = $doc;
    $db['userSettings'] = tc_object_map($map);
    tc_bump_user_settings_revision($db, $userId);
}
// 注销/删除用户时清理设置数据(硬删与软删共用)
function tc_drop_user_settings(&$db, $id) {
    $map = tc_assoc(isset($db['userSettings']) ? $db['userSettings'] : array());
    unset($map[$id]);
    $db['userSettings'] = tc_object_map($map);
    $revs = tc_assoc(isset($db['userSettingsRevisions']) ? $db['userSettingsRevisions'] : array());
    unset($revs[$id]);
    $db['userSettingsRevisions'] = tc_object_map($revs);
}

// 单键时间戳表:{路径: 毫秒}。路径形如 prefs.theme / ui.sidebarWidth / groups.<id> / fonts.<name>。
// 只用于客户端合并时的「谁更新」判定,因此限长限幅(时钟跑飞的设备不能永久胜出)。
function tc_settings_timestamps($raw) {
    $out = array();
    if (!is_array($raw)) return tc_object_map($out);
    $cap = tc_now() + 7 * 86400000;
    $i = 0;
    foreach ($raw as $k => $v) {
        if (++$i > 600) break;
        $k = substr(preg_replace('/[\x00-\x1f\x7f]/', '', (string) $k), 0, 120);
        if ($k === '') continue;
        if (!is_numeric($v)) continue;
        $t = (float) $v;
        if ($t < 0) $t = 0;
        if ($t > $cap) $t = $cap;
        $out[$k] = (int) $t;
    }
    return tc_object_map($out);
}

// 短文本:剔除控制字符并截断
function tc_settings_text($v, $max) {
    $s = preg_replace('/[\x00-\x1f\x7f]/', '', (string) $v);
    return tc_utf_cut((string) $s, $max);
}

// 偏好表:已知键按类型/范围收敛,未知键只接受标量(短字符串/有限数字/布尔),其余丢弃
function tc_settings_prefs($raw) {
    $out = array();
    if (!is_array($raw)) return $out;
    $boolKeys = array('stream', 'followups', 'autotitle', 'aiJudge', 'elapsed', 'reasoning', 'showApiChats', 'sidebarCollapsed');
    $enums = array(
        'theme' => array('system', 'light', 'dark'),
        'reasoningEffort' => array('off', 'low', 'medium', 'high'),
        'webSearchMode' => array('auto', 'on', 'off'),
        'autoImageMode' => array('off', 'rough', 'auto'),
    );
    $ints = array('contextMessages' => array(2, 500), 'fontSize' => array(11, 22));
    $strs = array(
        'lastProviderId' => 64, 'lastModel' => 200, 'pinnedProviderId' => 64, 'pinnedModel' => 200,
        'followupsModel' => 200, 'judgeModel' => 200, 'imageModel' => 200, 'notesModel' => 200,
        'fontFamily' => 80, 'fontCjk' => 80, 'fontLatin' => 80, 'accent' => 16,
        // 主题市场的主题包 id(见 static/js/theme-boot.js 的 OC_THEME_PACKS)。
        // 只存 id 不存样式:样式表随发布包分发,存 id 才能让主题更新跟着版本走。
        'themePack' => 32,
    );
    $i = 0;
    foreach ($raw as $k => $v) {
        if (++$i > 120) break;
        // 键名同样要收口:未知键是给后续版本留的,但 1MB 请求体里的超长键名会原样落库
        $k = substr((string) $k, 0, 120);
        if (in_array($k, $boolKeys, true)) { $out[$k] = !empty($v); continue; }
        if (isset($enums[$k])) {
            $v = (string) $v;
            if (in_array($v, $enums[$k], true)) $out[$k] = $v;
            continue;
        }
        if (isset($ints[$k])) {
            if (!is_numeric($v)) continue;
            $n = (int) $v;
            $out[$k] = min($ints[$k][1], max($ints[$k][0], $n));
            continue;
        }
        if (isset($strs[$k])) {
            if (!is_scalar($v)) continue;
            $out[$k] = tc_settings_text($v, $strs[$k]);
            continue;
        }
        // 未知键(后续版本新增的偏好):只收标量,避免任意结构落库
        if (is_bool($v) || $v === null) { $out[$k] = $v; continue; }
        if (is_int($v) || is_float($v)) { if (is_finite((float) $v)) $out[$k] = $v; continue; }
        if (is_string($v)) $out[$k] = tc_settings_text($v, 120);
    }
    return $out;
}

// 界面/布局/生成参数:同样白名单收敛
function tc_settings_ui($raw) {
    $out = array();
    if (!is_array($raw)) return $out;
    $bools = array('sidebarCollapsed', 'notesGuideSeen');
    $ints = array(
        'sidebarWidth' => array(120, 1200),
        'notesSideW' => array(120, 1200), 'announcementSeen' => array(0, 4102444800000),
        'videoSeconds' => array(1, 600),
    );
    // 对话列宽度:客户端已改成百分比(50~100,可带一位小数)。
    // 不能再用旧的 px 区间 400~2400 —— 客户端推 100(%)会被夹到 400,
    // 下次拉取就写回 400%,宽度设置直接失效(实测推 100 回来变 400)。
    // 上界仍留到 2400:升级前存的是 px,客户端会按当前主区宽度自己换算成百分比。
    // 用 float 而不是 int:61.8 不能被截成 61。
    $floats = array('contentWidth' => array(50, 2400));
    $enums = array('composerMode' => array('simple', 'group'));
    $strs = array('imageModel' => 200, 'imageSize' => 64, 'videoModel' => 200, 'videoRatio' => 32);
    foreach ($raw as $k => $v) {
        $k = (string) $k;
        if (in_array($k, $bools, true)) { $out[$k] = !empty($v); continue; }
        if (isset($enums[$k])) {
            $v = (string) $v;
            if (in_array($v, $enums[$k], true)) $out[$k] = $v;
            continue;
        }
        if (isset($floats[$k])) {
            if (!is_numeric($v)) continue;
            $val = round(min($floats[$k][1], max($floats[$k][0], (float) $v)), 1);
            // 整数就按整数存(JSON 里是 100 而不是 100.0),小数保留一位(61.8)
            $out[$k] = ($val == (int) $val) ? (int) $val : $val;
            continue;
        }
        if (isset($ints[$k])) {
            if (!is_numeric($v)) continue;
            $out[$k] = min($ints[$k][1], max($ints[$k][0], (int) $v));
            continue;
        }
        if (isset($strs[$k])) {
            if (is_scalar($v)) $out[$k] = tc_settings_text($v, $strs[$k]);
            continue;
        }
        if ($k === 'chatGroupCollapsed') {
            $map = array();
            $n = 0;
            foreach ((array) $v as $gk => $gv) {
                if (++$n > 12) break;
                $gk = substr((string) $gk, 0, 16);
                if ($gk === '') continue;
                $map[$gk] = !empty($gv);
            }
            $out[$k] = tc_object_map($map);
            continue;
        }
        if ($k === 'notesMdbarPos') {
            if (is_array($v) && isset($v['x']) && isset($v['y']) && is_numeric($v['x']) && is_numeric($v['y'])) {
                $out[$k] = array('x' => (int) $v['x'], 'y' => (int) $v['y']);
            }
            continue;
        }
        if ($k === 'notesUi') {
            $ui = array();
            foreach ((array) $v as $uk => $uv) {
                if (in_array($uk, array('folderId', 'selNoteId'), true)) $ui[$uk] = tc_settings_text($uv, 64);
                elseif ($uk === 'search') $ui[$uk] = tc_settings_text($uv, 100);
                elseif ($uk === 'sort') { $uv = (string) $uv; if (in_array($uv, array('updated', 'created', 'title'), true)) $ui[$uk] = $uv; }
                elseif ($uk === 'mode') { $uv = (string) $uv; if (in_array($uv, array('edit', 'split', 'preview'), true)) $ui[$uk] = $uv; }
                elseif ($uk === 'expanded') {
                    $ex = array();
                    $n = 0;
                    foreach ((array) $uv as $ek => $ev) { if (++$n > 200) break; $ex[substr((string) $ek, 0, 64)] = !empty($ev); }
                    $ui[$uk] = tc_object_map($ex);
                }
            }
            $out[$k] = $ui;
            continue;
        }
        if ($k === 'notesAiCfg') {
            $out[$k] = tc_settings_notes_ai_cfg($v);
            continue;
        }
    }
    return $out;
}

// 笔记 AI 动作配置:{disabled:[key], custom:[{key,label,desc,prompt}], overrides:{key:{label,desc,prompt}}}
function tc_settings_notes_ai_cfg($raw) {
    $out = array('disabled' => array(), 'custom' => array(), 'overrides' => array());
    if (!is_array($raw)) return $out;
    $rawDisabled = isset($raw['disabled']) && is_array($raw['disabled']) ? $raw['disabled'] : array();
    foreach (array_slice($rawDisabled, 0, 60) as $k) {
        $k = tc_settings_text($k, 64);
        if ($k !== '') $out['disabled'][] = $k;
    }
    $action = function ($row) {
        if (!is_array($row)) return null;
        $key = tc_settings_text(isset($row['key']) ? $row['key'] : '', 64);
        if ($key === '') return null;
        return array(
            'key' => $key,
            'label' => tc_settings_text(isset($row['label']) ? $row['label'] : '', 40),
            'desc' => tc_settings_text(isset($row['desc']) ? $row['desc'] : '', 120),
            'prompt' => tc_settings_text(isset($row['prompt']) ? $row['prompt'] : '', 8000),
        );
    };
    $rawCustom = isset($raw['custom']) && is_array($raw['custom']) ? $raw['custom'] : array();
    foreach (array_slice($rawCustom, 0, 40) as $row) {
        $a = $action($row);
        if ($a !== null) $out['custom'][] = $a;
    }
    $rawOv = isset($raw['overrides']) && is_array($raw['overrides']) ? $raw['overrides'] : array();
    $n = 0;
    foreach ($rawOv as $key => $row) {
        if (++$n > 60) break;
        $key = tc_settings_text($key, 64);
        if ($key === '' || !is_array($row)) continue;
        $out['overrides'][$key] = array(
            'label' => tc_settings_text(isset($row['label']) ? $row['label'] : '', 40),
            'desc' => tc_settings_text(isset($row['desc']) ? $row['desc'] : '', 120),
            'prompt' => tc_settings_text(isset($row['prompt']) ? $row['prompt'] : '', 8000),
        );
    }
    return $out;
}

// 群聊配置:整组白名单,逐字段截断(成员提示词是用户手写内容,单独放宽到 8000 字)
function tc_settings_groups($raw) {
    $out = array('groups' => array(), 'activeId' => '');
    if (!is_array($raw)) return $out;
    $rawGroups = isset($raw['groups']) && is_array($raw['groups']) ? $raw['groups'] : array();
    $seen = array();
    foreach (array_slice($rawGroups, 0, 50) as $g) {
        if (!is_array($g)) continue;
        $id = tc_settings_text(isset($g['id']) ? $g['id'] : '', 64);
        if ($id === '' || isset($seen[$id])) continue;
        $seen[$id] = true;
        $mode = (string) (isset($g['mode']) ? $g['mode'] : 'owner');
        if (!in_array($mode, array('owner', 'free', 'round', 'expert'), true)) $mode = 'owner';
        $gs = isset($g['settings']) && is_array($g['settings']) ? $g['settings'] : array();
        $parts = array();
        $rawParts = isset($g['participants']) && is_array($g['participants']) ? $g['participants'] : array();
        foreach (array_slice($rawParts, 0, 12) as $p) {
            if (!is_array($p)) continue;
            $style = (string) (isset($p['style']) ? $p['style'] : '');
            if (!in_array($style, array('', 'rational', 'humor', 'brief', 'pro'), true)) $style = '';
            $parts[] = array(
                'id' => tc_settings_text(isset($p['id']) ? $p['id'] : '', 64),
                'name' => tc_settings_text(isset($p['name']) ? $p['name'] : '', 24),
                'emoji' => tc_settings_text(isset($p['emoji']) ? $p['emoji'] : '', 8),
                'avatar' => min(20, max(1, (int) (isset($p['avatar']) ? $p['avatar'] : 1))),
                'bio' => tc_settings_text(isset($p['bio']) ? $p['bio'] : '', 200),
                'prompt' => tc_settings_text(isset($p['prompt']) ? $p['prompt'] : '', 8000),
                'preset' => tc_settings_text(isset($p['preset']) ? $p['preset'] : '', 32),
                'style' => $style,
                'enabled' => !empty($p['enabled']),
                'admin' => !empty($p['admin']),
                'providerId' => tc_settings_text(isset($p['providerId']) ? $p['providerId'] : '', 64),
                'model' => tc_settings_text(isset($p['model']) ? $p['model'] : '', 200),
                'avatarPinned' => !empty($p['avatarPinned']),
            );
        }
        $out['groups'][] = array(
            'id' => $id,
            'name' => tc_settings_text(isset($g['name']) ? $g['name'] : '', 40),
            'intro' => tc_settings_text(isset($g['intro']) ? $g['intro'] : '', 400),
            'mode' => $mode,
            'rosterVersion' => (int) (isset($g['rosterVersion']) ? $g['rosterVersion'] : 2),
            'createdAt' => (float) (isset($g['createdAt']) ? $g['createdAt'] : tc_now()),
            'updatedAt' => (float) (isset($g['updatedAt']) ? $g['updatedAt'] : tc_now()),
            'settings' => array(
                'maxMembers' => min(12, max(2, (int) (isset($gs['maxMembers']) ? $gs['maxMembers'] : 8))),
                'maxRounds' => min(4, max(1, (int) (isset($gs['maxRounds']) ? $gs['maxRounds'] : 2))),
                'allowQuote' => !array_key_exists('allowQuote', $gs) || !empty($gs['allowQuote']),
                'autoSummary' => !array_key_exists('autoSummary', $gs) || !empty($gs['autoSummary']),
                'saveFullHistory' => !array_key_exists('saveFullHistory', $gs) || !empty($gs['saveFullHistory']),
            ),
            'participants' => $parts,
        );
    }
    $activeId = tc_settings_text(isset($raw['activeId']) ? $raw['activeId'] : '', 64);
    $out['activeId'] = isset($seen[$activeId]) ? $activeId : '';
    return $out;
}

// 自定义字体:{名称: @font-face CSS};单个 64KB、最多 20 个(用户手写 CSS,限长防滥用)
function tc_settings_fonts($raw) {
    $out = array();
    if (!is_array($raw)) return $out;
    $n = 0;
    foreach ($raw as $name => $css) {
        if (++$n > 20) break;
        $name = tc_settings_text($name, 80);
        if ($name === '' || !is_string($css)) continue;
        $css = (string) preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', '', $css);
        if (strlen($css) > 65536) $css = substr($css, 0, 65536);
        $out[$name] = $css;
    }
    return $out;
}

function tc_sanitize_user_settings($doc) {
    // 空值一律给对象形状({} 而不是 []):客户端按「键 → 值」读取,形状稳定便于合并
    $out = array(
        'v' => 1, 'updatedAt' => 0,
        'prefs' => new stdClass(), 'ui' => new stdClass(),
        'groups' => array('groups' => array(), 'activeId' => ''),
        'fonts' => new stdClass(), 'tombs' => new stdClass(), 'at' => new stdClass(),
    );
    if (!is_array($doc)) return $out;
    $out['updatedAt'] = (float) (isset($doc['updatedAt']) ? $doc['updatedAt'] : 0);
    $out['prefs'] = tc_object_map(tc_settings_prefs(isset($doc['prefs']) ? $doc['prefs'] : array()));
    $out['ui'] = tc_object_map(tc_settings_ui(isset($doc['ui']) ? $doc['ui'] : array()));
    $out['groups'] = tc_settings_groups(isset($doc['groups']) ? $doc['groups'] : array());
    $out['fonts'] = tc_object_map(tc_settings_fonts(isset($doc['fonts']) ? $doc['fonts'] : array()));
    // 墓碑(groups.<id> / fonts.<名称>)与逐键时间戳共用同一套路径表
    $out['tombs'] = tc_settings_timestamps(isset($doc['tombs']) ? $doc['tombs'] : array());
    $out['at'] = tc_settings_timestamps(isset($doc['at']) ? $doc['at'] : array());
    return $out;
}

// GET /api/sync/settings:拉取当前用户的设置文档 + 修订号
function tc_api_sync_get_settings() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_json(200, array(
            'settings' => tc_sanitize_user_settings(tc_user_settings_of($db, $user['id'])),
            'revision' => tc_user_settings_revision_of($db, $user['id']),
            'syncSettings' => !isset($db['settings']['syncSettings']) || !empty($db['settings']['syncSettings']),
        ));
    });
}

// POST /api/sync/settings:整文档推送(baseRevision 乐观并发;冲突 409 带回云端文档)
function tc_api_sync_save_settings() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        // 站点关闭设置云同步:接受请求但不落库(与 persistChats 同一套隐私语义,客户端据此停止推送)
        if (isset($db['settings']['syncSettings']) && !$db['settings']['syncSettings']) {
            tc_json(200, array('ok' => true, 'revision' => tc_user_settings_revision_of($db, $user['id']), 'syncSettings' => false));
        }
        if (!tc_rate_limit_check('settingssync:' . $user['id'], 60)) {
            tc_fail(429, '同步过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(1024 * 1024);
        $current = tc_user_settings_revision_of($db, $user['id']);
        $base = isset($b['baseRevision']) ? (int) $b['baseRevision'] : $current;
        if ($base !== $current) {
            tc_json(409, array(
                'error' => array('message' => '设置已在其他设备更新'),
                'settings' => tc_sanitize_user_settings(tc_user_settings_of($db, $user['id'])),
                'revision' => $current,
            ));
        }
        $doc = tc_sanitize_user_settings(isset($b['settings']) ? $b['settings'] : array());
        tc_set_user_settings($db, $user['id'], $doc);
        tc_json(200, array('ok' => true, 'revision' => tc_user_settings_revision_of($db, $user['id'])));
    });
}

// POST /api/notes/upload:multipart 附件上传(图片 + 常见文档),返回签名 URL
function tc_api_note_attachment_upload() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('noteupload:' . $user['id'], 60, 3600000)) {
            tc_fail(429, '上传过于频繁，请稍后再试');
        }
        if (empty($_FILES['file']) || !is_array($_FILES['file'])) tc_fail(400, '缺少上传文件');
        $f = $_FILES['file'];
        $err = (int) (isset($f['error']) ? $f['error'] : 0);
        if ($err !== UPLOAD_ERR_OK || empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) {
            tc_fail(400, $err === UPLOAD_ERR_INI_SIZE ? '文件超过服务器上传上限' : '上传失败（错误码 ' . $err . '）');
        }
        $name = trim((string) (isset($f['name']) ? $f['name'] : ''));
        $name = str_replace(array("\r", "\n", '/', '\\'), '', $name !== '' ? $name : 'file');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        // 通用文件上传:图片与常见文档用白名单给准确 MIME,其余一律放行(download),
        // 但强制经签名路由 + Content-Disposition: attachment 输出,浏览器不内联执行,
        // 因此不会把本站变成可托管恶意 HTML/脚本的图床。
        $images = array(
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif', 'webp' => 'image/webp', 'svg' => 'image/svg+xml',
            'bmp' => 'image/bmp', 'ico' => 'image/x-icon', 'avif' => 'image/avif',
        );
        $docs = array(
            'pdf' => 'application/pdf', 'txt' => 'text/plain', 'md' => 'text/markdown',
            'csv' => 'text/csv', 'json' => 'application/json', 'zip' => 'application/zip',
            'gz' => 'application/gzip', '7z' => 'application/x-7z-compressed',
            'rar' => 'application/vnd.rar', 'tar' => 'application/x-tar',
            'doc' => 'application/msword',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xls' => 'application/vnd.ms-excel',
            'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'ppt' => 'application/vnd.ms-powerpoint',
            'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'm4a' => 'audio/mp4',
            'mp4' => 'video/mp4', 'webm' => 'video/webm',
        );
        if ($ext === '') tc_fail(400, '文件缺少扩展名，无法识别类型');
        if (!isset($images[$ext]) && isset($db['settings']['notesAllowFiles']) && !$db['settings']['notesAllowFiles']) {
            tc_fail(403, '本站仅允许上传图片附件');
        }
        $isImage = isset($images[$ext]);
        $mime = $isImage ? $images[$ext] : (isset($docs[$ext]) ? $docs[$ext] : 'application/octet-stream');
        $sniffed = '';
        // 单文件上限:图片按后台 notesMaxImageMb(默认 10MB);其余按 notesMaxFileMb
        $fileMb = isset($db['settings']['notesMaxFileMb']) ? (int) $db['settings']['notesMaxFileMb'] : 50;
        if ($fileMb <= 0) $fileMb = 50;
        $imgMb = isset($db['settings']['notesMaxImageMb']) ? (int) $db['settings']['notesMaxImageMb'] : 10;
        if ($imgMb <= 0) $imgMb = 10;
        $max = ($isImage ? $imgMb : $fileMb) * 1048576;
        $size = (int) (isset($f['size']) ? $f['size'] : 0);
        if ($size <= 0 || $size > $max) tc_fail(400, '文件大小超出限制（' . round($max / 1048576) . 'MB）');
        // 用户空间配额(0=不限):先按已用量 + 本次大小判断,避免超限写入
        $quota = tc_note_quota_bytes($db);
        if ($quota > 0 && tc_note_user_usage($user['id']) + $size > $quota) {
            tc_fail(413, '笔记空间不足，请清理附件或联系管理员调整上限');
        }
        // 只读前 64KB 做魔数校验:校验器最多看 4096 字节,没必要把整个附件读进内存
        $fh = @fopen($f['tmp_name'], 'rb');
        if (!$fh) tc_fail(400, '文件读取失败');
        $probe = (string) fread($fh, 65536);
        if (strlen($probe) === 0) { fclose($fh); tc_fail(400, '文件读取不完整'); }
        // 图片必须通过魔数校验:防止把 HTML/脚本改名成 .png 当成图片内联输出
        if ($isImage) {
            $sniffed = tc_note_sniff_image_mime($probe);
            if ($sniffed === '') {
                fclose($fh);
                tc_fail(400, '文件内容与图片格式不符（伪造扩展名？），请上传真实的图片文件');
            }
            $mime = $sniffed;
            // 扩展名声明为 svg 时必须真是 svg,反之亦然(避免 png 头配 .svg 扩展名)
            if (($ext === 'svg') !== ($sniffed === 'image/svg+xml')) {
                fclose($fh);
                tc_fail(400, '文件内容与扩展名不一致，请检查文件');
            }
        }
        unset($probe);
        $dir = tc_note_user_dir($user['id']);
        if ($dir === '' || !is_dir($dir) || !is_writable($dir)) { fclose($fh); tc_fail(500, '附件目录不可写，请检查 data/ 目录权限'); }
        // 归属声明:前端上传时带上目标笔记 id(未带则视为未绑定,只能属主本人访问)
        $boundNoteId = substr(trim((string) (isset($_POST['noteId']) ? $_POST['noteId'] : '')), 0, 64);
        tc_notes_index_add($user['id'], '', '');
        // id = 用户指纹(13) + 随机段:serve 时据指纹定位目录,实现归属隔离
        $id = tc_note_file_owner_tag($user['id']) . tc_uid(11);
        tc_notes_index_add($user['id'], $id, $boundNoteId);
        // 流式写入:先写头部(长度 + MIME),再把临时文件原样拷过去。
        // 旧实现是 $head . $body,意味着正文在内存里被复制一份(50MB 附件 = 100MB 峰值),
        // 大附件在 memory_limit 较低的主机上直接 500。
        $outPath = $dir . '/' . $id . '.bin';
        $tmpOut = $dir . '/' . $id . '.part';
        $w = @fopen($tmpOut, 'wb');
        if (!$w) { fclose($fh); tc_fail(500, '附件保存失败'); }
        $ct = $mime;
        $head = chr(strlen($ct)) . $ct;
        $ok = (fwrite($w, $head) === strlen($head));
        if ($ok) {
            fseek($fh, 0);
            while (!feof($fh)) {
                $buf = fread($fh, 262144);
                if ($buf === false || $buf === '') break;
                if (fwrite($w, $buf) === false) { $ok = false; break; }
            }
        }
        fclose($fh);
        fflush($w);
        fclose($w);
        if (!$ok || (int) @filesize($tmpOut) !== strlen($head) + $size) {
            @unlink($tmpOut);
            tc_fail(500, '附件保存失败');
        }
        // 先写 .part 再改名:避免并发读取到只写了一半的文件
        if (!@rename($tmpOut, $outPath)) {
            @unlink($tmpOut);
            tc_fail(500, '附件保存失败');
        }
        tc_json(200, array(
            'id' => $id,
            'name' => $name,
            'mimeType' => $mime,
            'size' => $size,
            'url' => tc_note_file_path($id, $name),
            'createdAt' => tc_now(),
            'used' => tc_note_user_usage($user['id']),
            'quota' => $quota,
        ));
    });
}

// DELETE /api/notes/file?id=:删除自己的附件(随笔记删除一起调用),释放配额并清理索引
function tc_api_note_attachment_delete() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $q = tc_query();
        $id = preg_replace('/[^a-f0-9]/', '', (string) (isset($q['id']) ? $q['id'] : ''));
        if ($id === '') tc_fail(400, '缺少附件 ID');
        // 只能删自己的:按 id 归属指纹判定
        $owner = tc_note_file_owner($id);
        if ($owner === '') {
            // 索引里没有(可能是历史遗留):按目录归属兜底
            $dir = tc_note_file_dir_for($id);
            $owner = $dir === '' ? '' : basename($dir);
        }
        if ($owner === '' || (string) $owner !== (string) $user['id']) {
            tc_fail(404, '附件不存在');
        }
        $dir = tc_note_user_dir($user['id'], false);
        $f = $dir !== '' ? $dir . '/' . $id . '.bin' : '';
        $removed = false;
        if ($f !== '' && is_file($f)) $removed = @unlink($f);
        tc_notes_index_remove_file($id);
        tc_json(200, array('ok' => true, 'removed' => $removed, 'used' => tc_note_user_usage($user['id'])));
    });
}

// POST /api/notes/files/gc:回收孤儿附件(不再被任何笔记引用的文件),释放配额。
// 客户端在同步完成后调用:服务端以「现存笔记的 attachments」为准做对账。
function tc_api_note_attachments_gc() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('notegc:' . $user['id'], 12, 3600000)) {
            tc_fail(429, '回收操作过于频繁，请稍后再试');
        }
        $doc = tc_notes_of($db, $user['id']);
        $alive = array();
        foreach ((array) ($doc['notes'] ?? array()) as $n) {
            if (!is_array($n)) continue;
            foreach ((array) ($n['attachments'] ?? array()) as $a) {
                if (is_array($a) && !empty($a['id'])) $alive[(string) $a['id']] = true;
            }
        }
        $dir = tc_note_user_dir($user['id'], false);
        $removed = 0;
        $freed = 0;
        if ($dir !== '' && is_dir($dir)) {
            foreach ((array) @glob($dir . '/*.bin') as $f) {
                $fid = basename($f, '.bin');
                if (isset($alive[$fid])) continue;
                $sz = (int) @filesize($f);
                if (@unlink($f)) { $removed++; $freed += $sz; tc_notes_index_remove_file($fid); }
            }
            // 上传中断会留下 .part 半成品(不是合法附件,也不会被上面扫到),顺手清掉旧的
            foreach ((array) @glob($dir . '/*.part') as $f) {
                if (@filemtime($f) > time() - 3600) continue;   // 可能还有正在进行的上传
                if (@unlink($f)) $removed++;
            }
        }
        tc_json(200, array('ok' => true, 'removed' => $removed, 'freed' => $freed, 'used' => tc_note_user_usage($user['id'])));
    });
}

// GET /api/notes/file?id=&s=:签名鉴权输出附件。
// data/ 整目录禁网,必须经此路由;附件归属由 id 前缀指纹定位到 data/notes/{uid}/,
// 即「仅笔记所属人能读到自己的文件」;非图片一律 Content-Disposition: attachment
// 强制下载(避免被当作 HTML/脚本外链托管),SVG 另加 CSP sandbox。
// 「本人」的判定同时认两种凭据:Bearer 请求头(前端接口调用)与附件 Cookie
// (浏览器加载正文里的 <img>/<a> 时带不了请求头,见 tc_note_attach_cookie_uid)。
function tc_api_note_attachment_serve() {
    $q = tc_query();
    $id = preg_replace('/[^a-f0-9]/', '', (string) (isset($q['id']) ? $q['id'] : ''));
    $sig = (string) (isset($q['s']) ? $q['s'] : '');
    if ($id === '' || $sig === '' || !hash_equals(tc_note_file_token($id), $sig)) {
        http_response_code(403);
        header('Content-Type: text/plain; charset=utf-8');
        echo '签名无效';
        exit;
    }
    // ---- 身份鉴权:签名只证明「链接格式正确」,不代表「有权访问」----
    // 默认只有附件所属人本人可下载(复制链接给他人、未登录访问一律 404,不暴露存在性)。
    // 唯一例外:该附件所属笔记已开启分享,且管理员关闭了「分享仅包含正文」时,
    // 持该笔记分享令牌(share 参数)者可下载——即「通过分享的笔记下载」。
    $ownerId = tc_note_file_owner($id);
    $boundNote = tc_note_file_bound_note($id);
    $shareToken = (string) (isset($q['share']) ? $q['share'] : '');
    $allowed = false;
    if ($ownerId !== '') {
        tc_with_db(false, function ($db) use (&$allowed, $ownerId, $boundNote, $shareToken) {
            $me = tc_auth_user($db);
            if ($me && (string) $me['id'] === $ownerId) { $allowed = true; return; }
            // 正文里的 <img>/<a> 是浏览器自发请求,带不了 Authorization 头,认附件 Cookie
            if (tc_note_attach_cookie_uid($db) === $ownerId) { $allowed = true; return; }
            if ($shareToken === '' || $boundNote === '') return;
            $share = tc_note_share_find($db, $shareToken);
            if (!$share || (string) $share['ownerId'] !== $ownerId) return;
            if ((string) $share['noteId'] !== $boundNote) return;
            $bodyOnly = !array_key_exists('notesShareBodyOnly', $db['settings']) || !empty($db['settings']['notesShareBodyOnly']);
            if (!$bodyOnly) $allowed = true;
        });
    }
    if (!$allowed) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '附件不存在';
        exit;
    }
    $dir = tc_note_file_dir_for($id);
    $f = $dir !== '' ? $dir . '/' . $id . '.bin' : '';
    if ($f === '' || !is_file($f)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '附件不存在';
        exit;
    }
    $raw = (string) @file_get_contents($f);
    if (strlen($raw) < 2) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '附件不存在';
        exit;
    }
    $len = ord($raw[0]);
    $ctype = substr($raw, 1, $len);
    $bodyLen = strlen($raw) - 1 - $len;
    unset($raw);   // 下面改为分块转发,不要同时在内存里留一份完整副本
    if ($ctype === '' || strpos($ctype, '/') === false) $ctype = 'application/octet-stream';
    $isImage = strpos($ctype, 'image/') === 0;
    header('Content-Type: ' . $ctype);
    header('Content-Length: ' . $bodyLen);
    header('X-Content-Type-Options: nosniff');
    if ($isImage) {
        // 图片:允许内联(笔记预览与分享页都要看图);SVG 用 CSP sandbox 阻断脚本
        if ($ctype === 'image/svg+xml') {
            header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
        }
    } else {
        // 其它一切类型:强制下载,不内联渲染,避免变成可托管网页/脚本的外链
        // (不用正则清洗:字符类里的转义容易写坏,直接按字符过滤更稳)
        $name = isset($q['name']) ? str_replace(array("\r", "\n", '"', '\\', '/'), '', (string) $q['name']) : '';
        $name = trim(substr($name, 0, 160));
        if ($name === '') $name = 'download';
        header("Content-Disposition: attachment; filename=\"" . rawurlencode($name) . "\"; filename*=UTF-8''" . rawurlencode($name));
        header("Content-Security-Policy: default-src 'none'; sandbox");
    }
    header('Cache-Control: private, max-age=31536000, immutable');
    // 分块转发正文:200MB 上限的附件整份读进内存会撞 PHP memory_limit,
    // 而这里只需要把「文件第 1+len 字节之后的部分」原样送出。
    $fp = @fopen($f, 'rb');
    if (!$fp) { echo ''; exit; }
    fseek($fp, 1 + $len);
    while (!feof($fp)) {
        $chunk = fread($fp, 262144);
        if ($chunk === false || $chunk === '') break;
        echo $chunk;
        if (function_exists('ob_flush')) @ob_flush();
        flush();
    }
    fclose($fp);
    exit;
}

// POST /api/notes/share:为笔记生成分享链接(同一笔记重复调用即重新生成,旧链接失效)
function tc_api_note_share_create() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('noteshare:' . $user['id'], 30, 3600000)) {
            tc_fail(429, '创建分享过于频繁，请稍后再试');
        }
        $b = tc_read_json_body();
        $noteId = substr(trim((string) (isset($b['noteId']) ? $b['noteId'] : '')), 0, 64);
        $mode = (string) (isset($b['mode']) ? $b['mode'] : 'view-link');
        if (!in_array($mode, array('view-link', 'edit-link'), true)) $mode = 'view-link';
        // 有效期:0=永久,其余为天数(1/7/30 等);过期后链接自动失效
        $expireDays = isset($b['expireDays']) ? (int) $b['expireDays'] : 0;
        if ($expireDays < 0) $expireDays = 0;
        if ($expireDays > 3650) $expireDays = 3650;
        $expireAt = $expireDays > 0 ? tc_now() + $expireDays * 86400000 : 0;
        if ($noteId === '') tc_fail(400, '缺少笔记 ID');
        $doc = tc_notes_of($db, $user['id']);
        list($idx, $note) = tc_note_find_in_doc($doc, $noteId);
        if ($idx < 0) tc_fail(404, '笔记不存在或已被删除');
        // 每用户最多 200 条分享:超出时轮出最早的一条(FIFO,同对话分享)
        $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
        $mine = array();
        foreach ($shares as $t => $s) {
            if ((string) ($s['ownerId'] ?? '') === (string) $user['id']) $mine[$t] = $s;
        }
        if (count($mine) >= 200) {
            uasort($mine, function ($x, $y) { return ((int) ($x['createdAt'] ?? 0)) <=> ((int) ($y['createdAt'] ?? 0)); });
            unset($shares[array_key_first($mine)]);
        }
        // 已有同笔记分享时:默认作废旧令牌(重新生成);
        // 前端传 keepToken=1 时保留令牌只更新权限与有效期(「已分享管理」里改设置用)
        $keepToken = !empty($b['keepToken']);
        $existToken = '';
        foreach ($mine as $t => $s) {
            if ((string) ($s['noteId'] ?? '') !== $noteId) continue;
            if ($keepToken) { $existToken = (string) $t; continue; }
            unset($shares[$t]);
        }
        $token = $existToken !== '' ? $existToken : tc_uid(9);
        $share = array(
            'token' => $token,
            'ownerId' => $user['id'],
            'noteId' => $noteId,
            'mode' => $mode,
            'createdAt' => tc_now(),
            'expireAt' => $expireAt,
        );
        $shares[$token] = $share;
        $db['noteShares'] = tc_object_map($shares);
        // 笔记本体同步分享状态(客户端展示用;权威状态始终以 noteShares 为准)
        $doc['notes'][$idx]['shareMode'] = $mode;
        $doc['notes'][$idx]['shareToken'] = $token;
        $doc['notes'][$idx]['updatedAt'] = (float) ($doc['notes'][$idx]['updatedAt'] ?? tc_now());
        $noteMap = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
        $noteMap[$user['id']] = $doc;
        $db['userNotes'] = tc_object_map($noteMap);
        tc_json(200, array(
            'share' => array(
                'noteId' => $noteId, 'token' => $token, 'mode' => $mode,
                'createdAt' => (float) (isset($shares[$token]['createdAt']) ? $shares[$token]['createdAt'] : $share['createdAt']),
                'expireAt' => $expireAt, 'kept' => $existToken !== '',
            ),
            'url' => '/n/' . $token,
        ));
    });
}

// DELETE /api/notes/share:关闭分享(带 noteId),对应笔记的分享链接全部失效
function tc_api_note_share_close() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $noteId = substr(trim((string) (isset($b['noteId']) ? $b['noteId'] : '')), 0, 64);
        if ($noteId === '') tc_fail(400, '缺少笔记 ID');
        $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
        foreach ($shares as $t => $s) {
            if ((string) ($s['ownerId'] ?? '') === (string) $user['id'] && (string) ($s['noteId'] ?? '') === $noteId) {
                unset($shares[$t]);
            }
        }
        $db['noteShares'] = tc_object_map($shares);
        $doc = tc_notes_of($db, $user['id']);
        list($idx, $note) = tc_note_find_in_doc($doc, $noteId);
        if ($idx >= 0) {
            $doc['notes'][$idx]['shareMode'] = 'private';
            $doc['notes'][$idx]['shareToken'] = '';
            $noteMap = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
            $noteMap[$user['id']] = $doc;
            $db['userNotes'] = tc_object_map($noteMap);
        }
        tc_json(200, array('ok' => true));
    });
}

// 笔记的公开投影:不泄露属主与分享令牌以外的内部字段
// 把正文里的本站附件引用(图片/文件链接)替换为提示文字。
// 用于「分享仅包含正文」:分享出去的只是文字,不连带把附件文件也公开。
function tc_note_strip_file_links($md) {
    $md = (string) $md;
    // ![alt](/api/notes/file?...)
    $md = preg_replace('/!\[[^\]]*\]\(\/api\/notes\/file\?[^)\s]*\)/', '（图片未在分享中显示）', $md);
    // [text](/api/notes/file?...)
    $md = preg_replace('/\[([^\]]*)\]\(\/api\/notes\/file\?[^)\s]*\)/', '（附件《$1》未在分享中显示）', $md);
    return $md;
}

function tc_public_shared_note($note, $mode, $bodyOnly = true, $shareToken = '') {
    $content = (string) ($note['content'] ?? '');
    $out = array(
        'id' => (string) ($note['id'] ?? ''),
        'title' => (string) ($note['title'] ?? ''),
        'content' => $bodyOnly ? tc_note_strip_file_links($content) : $content,
        'tags' => array_values((array) ($note['tags'] ?? array())),
        'createdAt' => (float) ($note['createdAt'] ?? 0),
        'updatedAt' => (float) ($note['updatedAt'] ?? 0),
        'mode' => (string) $mode,
        'editable' => $mode === 'edit-link',
        'bodyOnly' => (bool) $bodyOnly,
    );
    if (!$bodyOnly) {
        // 关闭「仅正文」时,让分享页能取到正文里引用的附件:
        // 给本站附件链接补上 share 令牌(服务端校验该令牌确属本篇笔记)
        $content = (string) ($note['content'] ?? '');
        if ($shareToken !== '' && strpos($content, '/api/notes/file') !== false) {
            $content = preg_replace_callback('/\/api\/notes\/file\?([^)\s]*)/', function ($m) use ($shareToken) {
                return '/api/notes/file?' . $m[1] . '&share=' . rawurlencode($shareToken);
            }, $content);
        }
        $out['content'] = $content;
        $atts = array();
        foreach ((array) ($note['attachments'] ?? array()) as $at) {
            if (!is_array($at) || empty($at['url'])) continue;
            $atts[] = array(
                'name' => (string) ($at['name'] ?? 'file'),
                'url' => (string) $at['url'],
                'mimeType' => (string) ($at['mimeType'] ?? ''),
                'size' => (int) ($at['size'] ?? 0),
            );
        }
        $out['attachments'] = $atts;
    }
    return $out;
}

// GET /api/notes/shared/{token}:公开读取(实时取属主笔记,关闭分享即失效)
function tc_api_note_shared_get($token) {
    tc_with_db(false, function ($db) use ($token) {
        $share = tc_note_share_find($db, $token);
        if (!$share) tc_fail(404, '分享不存在或已失效');
        $doc = tc_notes_of($db, $share['ownerId']);
        list($idx, $note) = tc_note_find_in_doc($doc, $share['noteId']);
        if ($idx < 0) tc_fail(404, '笔记不存在或已被删除');
        $bodyOnly = !array_key_exists('notesShareBodyOnly', $db['settings']) || !empty($db['settings']['notesShareBodyOnly']);
        tc_json(200, array('note' => tc_public_shared_note($note, (string) $share['mode'], $bodyOnly, (string) $token)));
    });
}

// ---- 管理端:笔记管理 ----
// GET /api/admin/notes:正在使用笔记的用户列表(笔记数/附件用量/最近更新),支持搜索
function tc_api_admin_notes_users() {
    tc_with_db(false, function ($db) {
        // 用户笔记属于个人内容,演示管理员不可查看(与「不可查看用户对话」一致)
        tc_demo_guard(tc_require_admin($db), '演示管理员不可查看用户笔记');
        $q = tc_query();
        $kw = strtolower(trim((string) (isset($q['q']) ? $q['q'] : '')));
        $quota = tc_note_quota_bytes($db);
        $map = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
        $nameOf = array();
        foreach ($db['users'] as $u) {
            if (isset($u['id'])) $nameOf[(string) $u['id']] = (string) (isset($u['name']) ? $u['name'] : '');
        }
        $rows = array();
        foreach ($map as $uid => $doc) {
            $uid = (string) $uid;
            $notes = (isset($doc['notes']) && is_array($doc['notes'])) ? $doc['notes'] : array();
            if (!$notes && empty($doc['folders'])) continue;
            $name = isset($nameOf[$uid]) ? $nameOf[$uid] : ('#' . $uid);
            if ($kw !== '' && strpos(strtolower($name), $kw) === false && strpos(strtolower($uid), $kw) === false) continue;
            $latest = 0;
            $chars = 0;
            foreach ($notes as $n) {
                if (!is_array($n)) continue;
                $latest = max($latest, (int) (isset($n['updatedAt']) ? $n['updatedAt'] : 0));
                $chars += strlen((string) (isset($n['content']) ? $n['content'] : ''));
            }
            $folders = (isset($doc['folders']) && is_array($doc['folders'])) ? count($doc['folders']) : 0;
            $rows[] = array(
                'userId' => $uid,
                'name' => $name,
                'folders' => $folders,
                'notes' => count($notes),
                'chars' => $chars,
                'used' => tc_note_user_usage($uid),
                'latestAt' => $latest,
            );
        }
        usort($rows, function ($a, $b) { return ((int) $b['latestAt']) <=> ((int) $a['latestAt']); });
        tc_json(200, array(
            'users' => $rows,
            'quota' => $quota,
            'totalUsed' => array_sum(array_column($rows, 'used')),
            'notesTotal' => array_sum(array_column($rows, 'notes')),
        ));
    });
}

// GET /api/admin/notes/view?userId=:审阅某个用户的笔记(仅元数据 + 正文,不含附件二进制)
function tc_api_admin_notes_view() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        tc_demo_guard($admin, '演示管理员不可查看用户笔记');
        $q = tc_query();
        $uid = substr(trim((string) (isset($q['userId']) ? $q['userId'] : '')), 0, 64);
        if ($uid === '') tc_fail(400, '缺少用户 ID');
        $doc = tc_notes_of($db, $uid);
        $name = '';
        foreach ($db['users'] as $u) { if ((string) $u['id'] === $uid) { $name = (string) $u['name']; break; } }
        tc_log_auth_event('admin', isset($admin['name']) ? $admin['name'] : '', '查看用户笔记:' . ($name !== '' ? $name : $uid), isset($admin['id']) ? $admin['id'] : '');
        tc_json(200, array(
            'userId' => $uid,
            'name' => $name !== '' ? $name : ('#' . $uid),
            'folders' => (isset($doc['folders']) && is_array($doc['folders'])) ? $doc['folders'] : array(),
            'notes' => (isset($doc['notes']) && is_array($doc['notes'])) ? $doc['notes'] : array(),
            'used' => tc_note_user_usage($uid),
        ));
    });
}

// POST /api/admin/notes/purge:清空某用户的全部笔记数据(文档 + 附件文件)
function tc_api_admin_notes_purge() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示管理员不能清理用户笔记');
        $b = tc_read_json_body();
        $uid = substr(trim((string) (isset($b['userId']) ? $b['userId'] : '')), 0, 64);
        if ($uid === '') tc_fail(400, '缺少用户 ID');
        tc_drop_user_notes($db, $uid);
        $dir = tc_note_user_dir($uid, false);
        $removed = 0;
        if ($dir !== '' && is_dir($dir)) {
            foreach ((array) @glob($dir . '/*.bin') as $f) { if (@unlink($f)) $removed++; }
            foreach ((array) @glob($dir . '/*.part') as $f) { if (@unlink($f)) $removed++; }
            @rmdir($dir);
        }
        tc_log_auth_event('admin', isset($admin['name']) ? $admin['name'] : '', '清理用户笔记:' . $uid . '（' . $removed . ' 个附件）', isset($admin['id']) ? $admin['id'] : '');
        tc_json(200, array('ok' => true, 'removedFiles' => $removed));
    });
}

// 笔记 AI 每日计数:{userId: {date: n}} 存 data/notes/ai-usage.json(不占数据库)
function tc_note_ai_usage_path() { return tc_note_root_dir() . '/ai-usage.json'; }
// 用可重置的静态引用:扣配额后同一请求里要立刻读到新计数(回包里的 used 字段)
function &tc_note_ai_usage_cache_ref() {
    static $cache = null;
    return $cache;
}
function tc_note_ai_usage_read() {
    $cache = &tc_note_ai_usage_cache_ref();
    if ($cache !== null) return $cache;
    $j = json_decode((string) @file_get_contents(tc_note_ai_usage_path()), true);
    $cache = is_array($j) ? $j : array();
    return $cache;
}
function tc_note_ai_used_today($db, $userId) {
    $all = tc_note_ai_usage_read();
    $day = date('Y-m-d');
    $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
    return (string) ($row['date'] ?? '') === $day ? (int) ($row['n'] ?? 0) : 0;
}
// 扣配额与判上限必须在同一把锁里完成:否则并发请求会同时通过上限检查,
// 各自读到同一个计数再加一,实际放行次数超过上限。
function tc_note_ai_consume($db, $userId) {
    $limit = (int) ($db['settings']['notesAiDailyLimit'] ?? 50);
    $day = date('Y-m-d');
    $over = false;
    $cache = &tc_note_ai_usage_cache_ref();
    $cache = null;   // 本请求后续读取必须拿到锁内写入的结果
    tc_json_mutate(tc_note_ai_usage_path(), function ($all) use ($userId, $day, $limit, &$over) {
        $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
        $n = ((string) ($row['date'] ?? '') === $day) ? (int) ($row['n'] ?? 0) : 0;
        if ($limit > 0 && $n >= $limit) { $over = true; return null; }   // 超限:不改也不写
        // 顺手清掉非今日的旧记录,避免文件无界增长
        foreach ($all as $k => $v) {
            if (!is_array($v) || (string) ($v['date'] ?? '') !== $day) unset($all[$k]);
        }
        $all[$userId] = array('date' => $day, 'n' => $n + 1);
        return $all;
    }, array());
    if ($over) tc_fail(429, '今日笔记 AI 次数已用完（' . $limit . ' 次），可在后台调整上限');
}

// POST /api/notes/ai/consume:笔记 AI 编辑前扣一次每日配额(单次调用仍走标准计费)
function tc_api_notes_ai_consume() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('noteai:' . $user['id'], 30)) tc_fail(429, '操作过于频繁，请稍后再试');
        tc_note_ai_consume($db, $user['id']);
        $limit = (int) ($db['settings']['notesAiDailyLimit'] ?? 50);
        tc_json(200, array('ok' => true, 'used' => tc_note_ai_used_today($db, $user['id']), 'limit' => $limit));
    });
}

// GET /api/notes/usage:当前用户的笔记附件用量与配额(侧边栏左下角显示剩余空间)
function tc_api_notes_usage() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        if (empty($db['settings']['notesEnabled'])) tc_json(200, array('enabled' => false));
        $quota = tc_note_quota_bytes($db);
        tc_json(200, array(
            'enabled' => true,
            'used' => tc_note_user_usage($user['id']),
            'quota' => $quota,
            'maxFileMb' => (int) ($db['settings']['notesMaxFileMb'] ?? 50),
            'allowFiles' => !isset($db['settings']['notesAllowFiles']) || !empty($db['settings']['notesAllowFiles']),
            'aiDailyLimit' => (int) ($db['settings']['notesAiDailyLimit'] ?? 50),
            'aiUsedToday' => tc_note_ai_used_today($db, $user['id']),
            'aiCustomizable' => !array_key_exists('notesAiCustomizable', $db['settings']) || !empty($db['settings']['notesAiCustomizable']),
        ));
    });
}

// POST /api/notes/shared/{token}:edit-link 模式下经链接修改属主笔记(最后写入胜出)
function tc_api_note_shared_edit($token) {
    tc_with_db(true, function (&$db) use ($token) {
        if (!tc_rate_limit_check('noteshared:' . (string) $token, 30)) {
            tc_fail(429, '保存过于频繁，请稍后再试');
        }
        $share = tc_note_share_find($db, $token);
        if (!$share) tc_fail(404, '分享不存在或已失效');
        if ((string) $share['mode'] !== 'edit-link') tc_fail(403, '该链接只允许查看');
        $b = tc_read_json_body(2 * 1024 * 1024);
        $doc = tc_notes_of($db, $share['ownerId']);
        list($idx, $note) = tc_note_find_in_doc($doc, $share['noteId']);
        if ($idx < 0) tc_fail(404, '笔记不存在或已被删除');
        $title = tc_utf_cut(trim((string) (isset($b['title']) ? $b['title'] : '')), 200);
        if ($title !== '') $doc['notes'][$idx]['title'] = $title;
        if (isset($b['content']) && is_string($b['content'])) {
            $doc['notes'][$idx]['content'] = substr($b['content'], 0, 200000);
        }
        if (isset($b['tags'])) $doc['notes'][$idx]['tags'] = tc_sanitize_note_tags($b['tags']);
        $doc['notes'][$idx]['updatedAt'] = tc_now();
        $noteMap = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
        $noteMap[$share['ownerId']] = $doc;
        $db['userNotes'] = tc_object_map($noteMap);
        tc_bump_notes_revision($db, $share['ownerId']);
        $bodyOnly2 = !array_key_exists('notesShareBodyOnly', $db['settings']) || !empty($db['settings']['notesShareBodyOnly']);
        tc_json(200, array('note' => tc_public_shared_note($doc['notes'][$idx], 'edit-link', $bodyOnly2, (string) $token)));
    });
}
