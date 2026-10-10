<?php
/**
 * im.php — 在线聊天(好友 / 单聊 / 群聊)与 AI 召唤
 *
 * 数据全部落在 store 单表 JSON 行里,沿用现有分片惯例:
 *   imThreads           整键,会话元数据(量小)
 *   friend:{uid}        好友关系与收到的好友请求 {friends:[], reqs:[]}
 *   imst:{uid}          已读游标 {lastRead:{threadId: msgId}}
 *   immsg:{threadId}    会话消息 {msgs:[...]},每会话只留最近 TC_IM_THREAD_MSG_CAP 条
 *   imdel:{threadId}    删除留档(墓碑):双向删除的消息原文 / 整会话快照,管理员可见可清理
 *
 * AI 召唤:消息以「AI」开头(或会话开启 AI 模式)时,服务端在消息落库后按标准
 * 计费通道(预扣 → 上游 → 结算)调用当前可用模型,把回复作为一条 kind=ai 的消息
 * 写回会话;响应先行返回(fastcgi 下真正断开),前端靠轮询收取回复。
 *
 * 附件:独立存放 data/im/{uid}/,与笔记附件(data/notes/)完全平行,互不占配额;
 * 经 /api/im/upload 上传(魔数校验 / 大小与空间上限)、/api/im/file 签名下发,
 * 可见范围 = 上传者本人 + 会话成员 + 管理员。
 *
 * 注意:文件与路由命名避开 "chat" 关键字(免费主机 WAF 惯例,见 .htaccess)。
 */

define('TC_IM_THREAD_MSG_CAP', 800);   // 每会话保留最近消息条数(超出丢弃最旧)
define('TC_IM_TEXT_MAX', 4000);        // 消息文本上限(字符)
define('TC_IM_AI_CTX_MSGS', 20);       // 召唤 AI 时携带的最近上下文条数
define('TC_IM_AI_TEXT_MAX', 8000);     // AI 回复文本截断(字符)
define('TC_IM_FRIENDS_CAP', 200);      // 每人好友上限
define('TC_IM_GROUP_CAP', 50);         // 群成员上限
define('TC_IM_REQS_CAP', 50);          // 每人待处理好友请求上限
define('TC_IM_REQ_MSG_MAX', 60);       // 好友请求附加验证消息上限(字符)
define('TC_IM_PREVIEW_MAX', 80);       // 会话列表最后一条预览截断(字符)
if (!defined('TC_IM_ATTACH_COOKIE')) define('TC_IM_ATTACH_COOKIE', 'tc_im_attach');

// ============ 总开关与通用小工具 ============

// 功能可用性判定统一走 tc_feature_allowed(见 lib/features.php):
// 总开关 × 访问级别(全站 / 仅管理员 / 仅名单)同时成立才放行。
function tc_im_feature_guard($db, $user = null) {
    if ($user === null) $user = tc_require_auth($db);
    if (!tc_feature_allowed($db, $user, 'im')) tc_fail(403, '本站未开放在线聊天功能，或你的账号没有使用权限');
    return $user;
}

// 会话 id / 消息 id 的合法性校验(threadId 是 tc_uid 随机串,不接收用户自造格式)
function tc_im_tid_ok($tid) {
    return is_string($tid) && preg_match('/^[A-Za-z0-9_-]{6,64}$/', $tid) === 1;
}

// 用户公开资料:好友/群成员/搜索结果统一只暴露这四项(不漏邮箱 / IP / 额度)
function tc_im_pub_user($u) {
    if (!is_array($u)) return array('id' => '', 'name' => '已注销用户', 'lastSeen' => 0, 'guest' => false);
    return array(
        'id' => (string) $u['id'],
        'name' => (string) (isset($u['name']) ? $u['name'] : ''),
        // 70 秒内有活动视为在线(轮询/发消息都会 touch lastSeen)
        'lastSeen' => isset($u['lastSeen']) ? (float) $u['lastSeen'] : 0,
        'guest' => !empty($u['guest']),
    );
}

function tc_im_users_index($db) {
    $out = array();
    foreach ($db['users'] as $u) {
        if (!is_array($u) || !isset($u['id'])) continue;
        $out[(string) $u['id']] = $u;
    }
    return $out;
}

// ============ store 文档访问(取出即初始化,改动后统一写回) ============

function tc_im_friends_all(&$db) {
    $map = tc_assoc(isset($db['userFriends']) ? $db['userFriends'] : null);
    $db['userFriends'] = tc_object_map($map);
    return $map;
}

function tc_im_friends_doc(&$db, $uid) {
    $map = tc_im_friends_all($db);
    $doc = isset($map[$uid]) && is_array($map[$uid]) ? $map[$uid] : array();
    if (!isset($doc['friends']) || !is_array($doc['friends'])) $doc['friends'] = array();
    if (!isset($doc['reqs']) || !is_array($doc['reqs'])) $doc['reqs'] = array();
    return $doc;
}

function tc_im_put_friends_doc(&$db, $uid, $doc) {
    $map = tc_im_friends_all($db);
    $map[$uid] = $doc;
    $db['userFriends'] = tc_object_map($map);
}

function tc_im_state_all(&$db) {
    $map = tc_assoc(isset($db['userImState']) ? $db['userImState'] : null);
    $db['userImState'] = tc_object_map($map);
    return $map;
}

function tc_im_state_doc(&$db, $uid) {
    $map = tc_im_state_all($db);
    $doc = isset($map[$uid]) && is_array($map[$uid]) ? $map[$uid] : array();
    if (!isset($doc['lastRead']) || !is_array($doc['lastRead'])) $doc['lastRead'] = array();
    return $doc;
}

function tc_im_put_state_doc(&$db, $uid, $doc) {
    $map = tc_im_state_all($db);
    $map[$uid] = $doc;
    $db['userImState'] = tc_object_map($map);
}

function tc_im_threads_all(&$db) {
    $map = tc_assoc(isset($db['imThreads']) ? $db['imThreads'] : null);
    $db['imThreads'] = tc_object_map($map);
    return $map;
}

function tc_im_msgs_all(&$db) {
    $map = tc_assoc(isset($db['imMessages']) ? $db['imMessages'] : null);
    $db['imMessages'] = tc_object_map($map);
    return $map;
}

function tc_im_msgs_doc(&$db, $tid) {
    $map = tc_im_msgs_all($db);
    $doc = isset($map[$tid]) && is_array($map[$tid]) ? $map[$tid] : array();
    if (!isset($doc['msgs']) || !is_array($doc['msgs'])) $doc['msgs'] = array();
    return $doc;
}

function tc_im_put_msgs_doc(&$db, $tid, $doc) {
    $map = tc_im_msgs_all($db);
    $map[$tid] = $doc;
    $db['imMessages'] = tc_object_map($map);
}

// 删除留档:只在已有内容时读取,不自动创建(留档行由删除操作负责落库)
function tc_im_arch_doc($db, $tid) {
    $map = tc_assoc(isset($db['imDeleted']) ? $db['imDeleted'] : null);
    $doc = isset($map[$tid]) && is_array($map[$tid]) ? $map[$tid] : array();
    if (!isset($doc['events']) || !is_array($doc['events'])) $doc['events'] = array();
    if (!isset($doc['msgs']) || !is_array($doc['msgs'])) $doc['msgs'] = array();
    return $doc;
}

function tc_im_put_arch_doc(&$db, $tid, $doc) {
    $map = tc_assoc(isset($db['imDeleted']) ? $db['imDeleted'] : null);
    $map[$tid] = $doc;
    $db['imDeleted'] = tc_object_map($map);
}

function tc_im_thread_member($thread, $uid) {
    return is_array($thread) && in_array((string) $uid, array_map('strval', (array) (isset($thread['members']) ? $thread['members'] : array())), true);
}

// 单聊复用:同一对好友永远命中同一个会话(members 集合相等即视为同一会话)
function tc_im_find_dm(&$db, $a, $b) {
    foreach (tc_im_threads_all($db) as $tid => $t) {
        if (!is_array($t) || (isset($t['type']) && $t['type'] !== 'dm')) continue;
        $m = array_map('strval', (array) (isset($t['members']) ? $t['members'] : array()));
        sort($m);
        $want = array((string) $a, (string) $b);
        sort($want);
        if ($m === $want) return $t;
    }
    return null;
}

// 会话对外结构(列表与消息接口共用;lastRead 由调用方决定是否并入 unread)
function tc_im_pub_thread($t, $usersIdx, $unread = null) {
    $members = array();
    foreach (array_slice((array) (isset($t['members']) ? $t['members'] : array()), 0, TC_IM_GROUP_CAP + 1) as $mid) {
        $u = isset($usersIdx[(string) $mid]) ? $usersIdx[(string) $mid] : null;
        $pub = tc_im_pub_user($u);
        if ($u === null) $pub['id'] = (string) $mid;
        $members[] = $pub;
    }
    $lastFrom = (string) (isset($t['lastMsgFrom']) ? $t['lastMsgFrom'] : '');
    $last = array('id' => (string) (isset($t['id']) ? $t['id'] : ''), 'type' => 'dm');
    if (isset($t['type']) && $t['type'] === 'group') {
        $last['type'] = 'group';
        $last['title'] = tc_utf_cut((string) (isset($t['title']) ? $t['title'] : ''), 40);
        $last['ownerId'] = (string) (isset($t['ownerId']) ? $t['ownerId'] : '');
    }
    $last['members'] = $members;
    $last['aiEnabled'] = !empty($t['aiEnabled']);
    // 默认读取上下文(旧数据缺字段即视为开启)
    $last['aiContext'] = !isset($t['aiContext']) || !empty($t['aiContext']);
    $last['createdAt'] = (float) (isset($t['createdAt']) ? $t['createdAt'] : 0);
    $last['lastMsgId'] = (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0);
    $last['lastMsgAt'] = (float) (isset($t['lastMsgAt']) ? $t['lastMsgAt'] : 0);
    $last['lastMsgFrom'] = $lastFrom;
    if ($lastFrom !== '' && $lastFrom !== 'ai') {
        $last['lastMsgName'] = isset($usersIdx[$lastFrom]) ? (string) $usersIdx[$lastFrom]['name'] : '';
    } elseif ($lastFrom === 'ai') {
        $last['lastMsgName'] = 'AI';
    } else {
        $last['lastMsgName'] = '';
    }
    $last['lastMsgText'] = (string) (isset($t['lastMsgText']) ? $t['lastMsgText'] : '');
    // 会话修订号:任何消息变更(含双向删除)都会推进;客户端据此感知「另一侧删了消息」
    // 并整窗重拉(删除不推进 lastMsgId,光靠游标增量拉取永远看不到别人的删除)
    $last['msgRev'] = (int) (isset($t['msgRev']) ? $t['msgRev'] : 0);
    if ($unread !== null) $last['unread'] = max(0, (int) $unread);
    return $last;
}

// 消息对外结构:已删除的只留占位,正文不外发
function tc_im_pub_msg($m, $selfId) {
    if (!is_array($m)) return null;
    $out = array(
        'id' => (int) (isset($m['id']) ? $m['id'] : 0),
        'from' => (string) (isset($m['from']) ? $m['from'] : ''),
        'name' => (string) (isset($m['name']) ? $m['name'] : ''),
        'at' => (float) (isset($m['at']) ? $m['at'] : 0),
        'kind' => (isset($m['kind']) && $m['kind'] === 'ai') ? 'ai' : 'user',
        'self' => isset($m['from']) && (string) $m['from'] === (string) $selfId,
    );
    if (!empty($m['deleted'])) {
        $out['deleted'] = true;
        $out['deletedBy'] = (string) (isset($m['deletedBy']) ? $m['deletedBy'] : '');
        return $out;
    }
    $out['text'] = (string) (isset($m['text']) ? $m['text'] : '');
    if (isset($m['model'])) $out['model'] = (string) $m['model'];
    if (isset($m['aiError'])) $out['aiError'] = true;
    if (isset($m['file']) && is_array($m['file'])) {
        $f = $m['file'];
        $out['file'] = array(
            'id' => (string) (isset($f['id']) ? $f['id'] : ''),
            'name' => tc_utf_cut((string) (isset($f['name']) ? $f['name'] : 'file'), 200),
            'size' => (int) (isset($f['size']) ? $f['size'] : 0),
            'mime' => (string) (isset($f['mime']) ? $f['mime'] : 'application/octet-stream'),
            'image' => !empty($f['image']),
            'url' => isset($f['id']) ? tc_im_file_path((string) $f['id'], (string) (isset($f['name']) ? $f['name'] : '')) : '',
        );
    }
    return $out;
}

// ============ AI 召唤触发判定(纯函数,tests/im-social.php 直接回归) ============
// 触发:文本里出现「@AI」提及词(半角/全角 @、大小写不敏感)。要求 @ 位于行首/空白之后
// 且 AI 后面不接 ASCII 字母数字 —— 挡掉 me@aitech.com 这类邮箱误触,也无需旧的「AI 开头」边界规则。
// 返回 [是否召唤, 去掉提及词与分隔标点后的问题]。
function tc_im_ai_trigger($text) {
    $t = trim((string) $text);
    if ($t === '') return array(false, '');
    if (preg_match('/(?:^|\s)[@＠][AaＡａ][IiＩｉ](?![A-Za-z0-9])/u', $t) !== 1) return array(false, '');
    $q = preg_replace('/(?:^|\s)[@＠][AaＡａ][IiＩｉ](?![A-Za-z0-9])/u', '', $t, 1);
    $q = trim((string) preg_replace('/^[\s：:，,。.？?！!、;；~\-—]+/u', '', (string) $q));
    return array(true, tc_utf_cut($q, TC_IM_TEXT_MAX));
}

// ============ AI 召唤每日配额(独立 JSON 边车,锁内检查+计数,与笔记 AI 同构) ============

function tc_im_ai_usage_path() {
    return tc_data_dir() . '/im-ai-usage.json';
}

function tc_im_ai_limit($db) {
    return (int) (isset($db['settings']['imAiDailyLimit']) ? $db['settings']['imAiDailyLimit'] : 50);
}

function tc_im_ai_used_today($userId) {
    $j = json_decode((string) @file_get_contents(tc_im_ai_usage_path()), true);
    $all = is_array($j) ? $j : array();
    $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
    return (string) ($row['date'] ?? '') === date('Y-m-d') ? (int) ($row['n'] ?? 0) : 0;
}

// 扣次数与判上限必须在同一把文件锁里完成(与 tc_note_ai_consume 同一理由):
// 否则并发请求各自读到同一计数再 +1,实际放行次数超过上限。超限返回 false。
function tc_im_ai_consume($db, $userId) {
    $limit = tc_im_ai_limit($db);
    $day = date('Y-m-d');
    $over = false;
    tc_json_mutate(tc_im_ai_usage_path(), function ($all) use ($userId, $day, $limit, &$over) {
        $all = is_array($all) ? $all : array();
        $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
        $n = ((string) ($row['date'] ?? '') === $day) ? (int) ($row['n'] ?? 0) : 0;
        if ($limit > 0 && $n >= $limit) { $over = true; return null; }
        // 顺手清掉非今日的旧记录,避免文件无界增长
        foreach ($all as $k => $v) {
            if (!is_array($v) || (string) ($v['date'] ?? '') !== $day) unset($all[$k]);
        }
        $all[$userId] = array('date' => $day, 'n' => $n + 1);
        return $all;
    }, array());
    return !$over;
}

// 预扣额度失败时把已扣的每日次数退回(每日次数与额度分属两把锁,只能补偿)
function tc_im_ai_refund($userId) {
    $day = date('Y-m-d');
    tc_json_mutate(tc_im_ai_usage_path(), function ($all) use ($userId, $day) {
        $all = is_array($all) ? $all : array();
        $row = isset($all[$userId]) && is_array($all[$userId]) ? $all[$userId] : array();
        if ((string) ($row['date'] ?? '') !== $day) return null;
        $row['n'] = max(0, (int) ($row['n'] ?? 0) - 1);
        $all[$userId] = $row;
        return $all;
    }, array());
}

// ============ 附件:data/im/{uid}/,与笔记附件同一套安全模式 ============

function tc_im_root_dir() {
    $dir = tc_data_dir() . '/im';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

function tc_im_user_dir($userId, $create = true) {
    $uid = preg_replace('/[^a-f0-9]/', '', (string) $userId);
    if ($uid === '') return '';
    $dir = tc_im_root_dir() . '/' . $uid;
    if ($create && !is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

// 该用户已用附件字节数
function tc_im_user_usage($userId) {
    $dir = tc_im_user_dir($userId, false);
    if ($dir === '' || !is_dir($dir)) return 0;
    $total = 0;
    foreach ((array) @glob($dir . '/*.bin') as $f) {
        $sz = @filesize($f);
        if ($sz !== false) $total += (int) $sz;
    }
    return $total;
}

function tc_im_quota_bytes($db) {
    $mb = isset($db['settings']['imQuotaMb']) ? (int) $db['settings']['imQuotaMb'] : 0;
    return $mb > 0 ? $mb * 1048576 : 0;
}

// 附件 id = 上传者 uid(本身就是 hex) + '-' + 随机段:无需索引即可定位归属目录
function tc_im_file_owner($id) {
    $id = (string) $id;
    $pos = strpos($id, '-');
    if ($pos === false) return '';
    $uid = substr($id, 0, $pos);
    return preg_match('/^[a-f0-9]{6,32}$/', $uid) === 1 ? $uid : '';
}

function tc_im_file_token($id) {
    return substr(hash_hmac('sha256', 'imattach:' . (string) $id, tc_secret()), 0, 24);
}

function tc_im_file_path($id, $name = '') {
    $url = '/api/im/file?id=' . rawurlencode((string) $id) . '&s=' . tc_im_file_token($id);
    if ($name !== '') $url .= '&name=' . rawurlencode((string) $name);
    return $url;
}

// 读取 .bin 头部声明:返回 [mime, bodySize](文件不存在返回 [null, 0])
function tc_im_file_meta($id) {
    $owner = tc_im_file_owner($id);
    if ($owner === '') return array(null, 0);
    $f = tc_im_user_dir($owner, false) . '/' . $id . '.bin';
    if ($f === '' || !is_file($f)) return array(null, 0);
    $fh = @fopen($f, 'rb');
    if (!$fh) return array(null, 0);
    $head = (string) fread($fh, 200);
    fclose($fh);
    if ($head === '') return array(null, 0);
    $len = ord($head[0]);
    if ($len === 0 || strlen($head) < 1 + $len) return array(null, 0);
    return array(substr($head, 1, $len), max(0, (int) @filesize($f) - 1 - $len));
}

// ---- 浏览器直取凭据:<img>/<a> 不会带 Authorization 头,补发一枚短用途 Cookie ----

function tc_im_attach_cookie_path() {
    return '/api/im/file';
}

function tc_im_attach_cookie_issue($db, $user) {
    $days = 7;
    $token = tc_jwt_sign(array(
        'scope' => 'imattach',
        'sub' => (string) $user['id'],
        'tv' => (int) (isset($user['tv']) ? $user['tv'] : 0),
        'ep' => (int) (isset($db['settings']['authEpoch']) ? $db['settings']['authEpoch'] : 1),
        'exp' => tc_now() + $days * 24 * 3600 * 1000,
    ));
    $opts = array(
        'expires' => time() + $days * 24 * 3600,
        'path' => tc_im_attach_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
    );
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') $opts['secure'] = true;
    @setcookie(TC_IM_ATTACH_COOKIE, $token, $opts);
}

function tc_im_attach_cookie_uid($db) {
    $raw = isset($_COOKIE[TC_IM_ATTACH_COOKIE]) ? (string) $_COOKIE[TC_IM_ATTACH_COOKIE] : '';
    if ($raw === '') return '';
    $payload = tc_jwt_verify($raw);
    if (!$payload || !isset($payload['scope']) || (string) $payload['scope'] !== 'imattach') return '';
    if (empty($payload['sub']) || empty($payload['exp']) || $payload['exp'] < tc_now()) return '';
    $epoch = isset($db['settings']['authEpoch']) ? (int) $db['settings']['authEpoch'] : 1;
    if ((int) (isset($payload['ep']) ? $payload['ep'] : 1) !== $epoch) return '';
    foreach ($db['users'] as $u) {
        if ((string) $u['id'] !== (string) $payload['sub']) continue;
        return (int) (isset($payload['tv']) ? $payload['tv'] : 0) === (int) (isset($u['tv']) ? $u['tv'] : 0) ? (string) $u['id'] : '';
    }
    return '';
}

function tc_im_attach_cookie_sync($db, $user) {
    if (headers_sent()) return;
    if (tc_im_attach_cookie_uid($db) === (string) $user['id']) return;
    tc_im_attach_cookie_issue($db, $user);
}

// 消息里引用的附件对「会话成员」可见:全库扫一遍消息的 file.id(整库本就随事务载入,开销可忽略)
function tc_im_file_thread_ids($db, $fileId) {
    $out = array();
    foreach (tc_im_msgs_all($db) as $tid => $doc) {
        $msgs = isset($doc['msgs']) && is_array($doc['msgs']) ? $doc['msgs'] : array();
        foreach ($msgs as $m) {
            if (is_array($m) && isset($m['file']['id']) && (string) $m['file']['id'] === (string) $fileId) {
                $out[] = (string) $tid;
                break;
            }
        }
    }
    return $out;
}

// ============ 管理员虚拟好友 ============

// 管理员与所有用户互为好友(虚拟关系,不落库):普通用户的好友列表始终包含全部
// 管理员,管理员的好友列表包含全部用户;新注册/新提权即时生效,存量数据零迁移。
function tc_im_is_admin_uid($db, $uid) {
    foreach ($db['users'] as $u) {
        if (is_array($u) && isset($u['id']) && (string) $u['id'] === (string) $uid) return !empty($u['admin']);
    }
    return false;
}

function tc_im_are_friends($db, $a, $b) {
    if ((string) $a === (string) $b) return false;
    $doc = tc_im_friends_doc($db, (string) $a);
    foreach ($doc['friends'] as $f) {
        if ((string) (isset($f['uid']) ? $f['uid'] : '') === (string) $b) return true;
    }
    // 「所有人默认互为好友」开关:注册用户之间全部视为好友
    return !empty($db['settings']['imMutualFriends'])
        || tc_im_is_admin_uid($db, $a)
        || tc_im_is_admin_uid($db, $b);
}

// ============ 好友 ============

// GET /api/im/users/search?q=
// 可见性:管理员视图全可见;普通用户 = 「所有人默认互为好友」开关(全部注册成员)
//       或「对所有人可见」名单(imVisibleUsers)或目标本身是管理员(默认可见)。
function tc_api_im_user_search() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imsearch:' . $user['id'], 30)) tc_fail(429, '搜索过于频繁，请稍后再试');
        $q = tc_utf_cut(trim((string) (isset($_GET['q']) ? $_GET['q'] : '')), 64);
        if ($q === '') tc_json(200, array('users' => array()));
        $showAll = !empty($db['settings']['imMutualFriends']);
        $visibleNames = array();
        foreach ((isset($db['settings']['imVisibleUsers']) && is_array($db['settings']['imVisibleUsers']) ? $db['settings']['imVisibleUsers'] : array()) as $vn) {
            $vn = function_exists('mb_strtolower') ? mb_strtolower((string) $vn, 'UTF-8') : strtolower((string) $vn);
            if ($vn !== '') $visibleNames[$vn] = true;
        }
        $doc = tc_im_friends_doc($db, $user['id']);
        $friendIds = array();
        foreach ($doc['friends'] as $f) $friendIds[(string) (isset($f['uid']) ? $f['uid'] : '')] = true;
        // 我收到的请求(我的文档)→ rel=in(对方等待我处理);我发出的(躺在对方文档里)→ rel=out
        $inIds = array();
        foreach ($doc['reqs'] as $r) $inIds[(string) (isset($r['from']) ? $r['from'] : '')] = true;
        $outIds = array();
        foreach (tc_im_friends_all($db) as $ouid => $odoc) {
            if (!is_array($odoc)) continue;
            foreach ((array) (isset($odoc['reqs']) ? $odoc['reqs'] : array()) as $r) {
                if ((string) (isset($r['from']) ? $r['from'] : '') === (string) $user['id']) $outIds[$ouid] = true;
            }
        }
        $hits = array();
        $qLower = function_exists('mb_strtolower') ? mb_strtolower($q, 'UTF-8') : strtolower($q);
        foreach ($db['users'] as $u) {
            if (!is_array($u) || !isset($u['id']) || (string) $u['id'] === (string) $user['id']) continue;
            $name = (string) (isset($u['name']) ? $u['name'] : '');
            $nLower = function_exists('mb_strtolower') ? mb_strtolower($name, 'UTF-8') : strtolower($name);
            $exact = $nLower === $qLower;
            if (!$exact && ($qLower === '' || $nLower === '' || strpos($nLower, $qLower) === false)) continue;
            // 可见性闸门(在匹配之后,白名单匹配走同一个大小写折叠)。
            // 精确命中(大小写不敏感)始终可见 —— 「输入用户名添加好友」的核心路径不能被可见性开关挡住;
            // 只有模糊/子串命中才按可见性规则过滤。
            if (!$exact && empty($user['admin']) && !$showAll && !isset($visibleNames[$nLower]) && empty($u['admin'])) continue;
            $rel = 'none';
            if (isset($friendIds[(string) $u['id']])) $rel = 'yes';
            elseif (isset($inIds[(string) $u['id']])) $rel = 'in';    // 对方请求了我 → 可同意
            elseif (isset($outIds[(string) $u['id']])) $rel = 'out';  // 我已请求对方 → 等待同意
            // 虚拟好友(管理员默认对所有人可见/「所有人默认互为好友」)在搜索里也应显示为已是好友,
            // 否则搜到管理员会出现「添加好友」按钮,与好友列表的展示自相矛盾。
            elseif (tc_im_are_friends($db, $user['id'], $u['id'])) $rel = 'yes';
            $hits[] = array('exact' => $exact, 'u' => tc_im_pub_user($u) + array('rel' => $rel, 'admin' => !empty($u['admin'])));
            if (count($hits) >= 21) break;
        }
        usort($hits, function ($a, $b) {
            if ($a['exact'] !== $b['exact']) return $a['exact'] ? -1 : 1;
            return $b['u']['lastSeen'] <=> $a['u']['lastSeen'];
        });
        tc_json(200, array('users' => array_slice(array_map(function ($h) { return $h['u']; }, $hits), 0, 20)));
    });
}

// GET /api/friends
function tc_api_friends_list() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        $idx = tc_im_users_index($db);
        $doc = tc_im_friends_doc($db, $user['id']);
        $friendIds = array();
        $friends = array();
        foreach ($doc['friends'] as $f) {
            $uid = (string) (isset($f['uid']) ? $f['uid'] : '');
            if ($uid === '') continue;
            $friendIds[$uid] = true;
            $pub = tc_im_pub_user(isset($idx[$uid]) ? $idx[$uid] : null);
            $pub['id'] = $pub['id'] !== '' ? $pub['id'] : $uid;
            $pub['since'] = (float) (isset($f['since']) ? $f['since'] : 0);
            $pub['online'] = $pub['lastSeen'] > 0 && (tc_now() - $pub['lastSeen']) < 70000;
            $pub['isAdmin'] = !empty($idx[$uid]['admin']);
            $friends[] = $pub;
        }
        usort($friends, function ($a, $b) { return $b['online'] <=> $a['online'] ?: $b['lastSeen'] <=> $a['lastSeen']; });
        // 管理员虚拟好友:普通用户的好友列表永远包含全部管理员;管理员看到全部用户
        $viewerIsAdmin = !empty($user['admin']);
        $have = array();
        foreach ($friends as $f) $have[(string) $f['id']] = true;
        $virtual = array();
        foreach ($db['users'] as $u) {
            if (!is_array($u) || !isset($u['id'])) continue;
            $uid = (string) $u['id'];
            if ($uid === (string) $user['id'] || isset($have[$uid])) continue;
            $isAdmin = !empty($u['admin']);
            if ($viewerIsAdmin !== true && !$isAdmin && empty($db['settings']['imMutualFriends'])) continue;
            $pub = tc_im_pub_user($u);
            $pub['id'] = $uid;
            $pub['since'] = (float) (isset($u['createdAt']) ? $u['createdAt'] : 0);
            $pub['online'] = $pub['lastSeen'] > 0 && (tc_now() - $pub['lastSeen']) < 70000;
            $pub['isAdmin'] = $isAdmin;
            $virtual[] = $pub;
        }
        // 管理员排最前,其余按在线/最近活跃
        usort($virtual, function ($a, $b) {
            if ($a['isAdmin'] !== $b['isAdmin']) return $a['isAdmin'] ? -1 : 1;
            return $b['online'] <=> $a['online'] ?: $b['lastSeen'] <=> $a['lastSeen'];
        });
        $friends = array_merge($friends, $virtual);
        // 管理员置顶(真实好友里也可能有管理员,故合并后再统一排一次)
        usort($friends, function ($a, $b) {
            $aa = !empty($a['isAdmin']); $bb = !empty($b['isAdmin']);
            if ($aa !== $bb) return $aa ? -1 : 1;
            return $b['online'] <=> $a['online'] ?: $b['lastSeen'] <=> $a['lastSeen'];
        });
        $requests = array();
        foreach ($doc['reqs'] as $r) {
            $from = (string) (isset($r['from']) ? $r['from'] : '');
            $pub = tc_im_pub_user(isset($idx[$from]) ? $idx[$from] : null);
            $pub['id'] = $pub['id'] !== '' ? $pub['id'] : $from;
            $pub['reqId'] = (string) (isset($r['id']) ? $r['id'] : '');
            $pub['at'] = (float) (isset($r['at']) ? $r['at'] : 0);
            $pub['msg'] = (string) (isset($r['msg']) ? $r['msg'] : '');
            $requests[] = $pub;
        }
        // 我发出的请求(见 tc_im_requests_out)
        $sent = array();
        foreach (tc_im_requests_out($db, $user['id']) as $row) {
            $ouid = $row['uid'];
            $r = $row['req'];
            $pub = tc_im_pub_user(isset($idx[$ouid]) ? $idx[$ouid] : null);
            $pub['id'] = $pub['id'] !== '' ? $pub['id'] : $ouid;
            $pub['at'] = (float) (isset($r['at']) ? $r['at'] : 0);
            $pub['msg'] = (string) (isset($r['msg']) ? $r['msg'] : '');
            $sent[] = $pub;
        }
        // 成员的发现只走「输入用户名搜索」:好友页不再直接展示任何用户
        tc_json(200, array('friends' => $friends, 'requests' => $requests, 'sent' => $sent));
    });
}

// POST /api/friends/request {name}
function tc_api_friend_request() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imfr:' . $user['id'], 10)) tc_fail(429, '操作过于频繁，请稍后再试');
        $b = tc_read_json_body(65536);
        $name = tc_utf_cut(trim((string) (isset($b['name']) ? $b['name'] : '')), 32);
        if ($name === '') tc_fail(400, '请输入要添加的用户名');
        $target = null;
        foreach ($db['users'] as $u) {
            if (is_array($u) && isset($u['name']) && (string) $u['name'] === $name) { $target = $u; break; }
        }
        if (!$target) {
            // 精确匹配失败再退回大小写不敏感匹配一次
            $nLower = function_exists('mb_strtolower') ? mb_strtolower($name, 'UTF-8') : strtolower($name);
            foreach ($db['users'] as $u) {
                if (!is_array($u) || !isset($u['name'])) continue;
                $t = function_exists('mb_strtolower') ? mb_strtolower((string) $u['name'], 'UTF-8') : strtolower((string) $u['name']);
                if ($t === $nLower) { $target = $u; break; }
            }
        }
        if (!$target) tc_fail(404, '用户「' . $name . '」不存在');
        if ((string) $target['id'] === (string) $user['id']) tc_fail(400, '不能添加自己为好友');
        // 管理员虚拟好友 / 「所有人默认互为好友」开关:虚拟关系已覆盖,发请求按「已是好友」处理
        if (tc_im_are_friends($db, (string) $user['id'], (string) $target['id'])) {
            tc_fail(409, '你们已经是好友了');
        }
        $msg = tc_utf_cut(trim((string) (isset($b['message']) ? $b['message'] : '')), TC_IM_REQ_MSG_MAX);
        list($status, $err) = tc_im_friend_request_apply($db, $user, $target, $msg);
        if ($err === 'already') tc_fail(409, '你们已经是好友了');
        if ($err === 'cap') tc_fail(409, '好友数量已达上限(' . TC_IM_FRIENDS_CAP . ')');
        if ($err === 'reqcap') tc_fail(409, '对方的好友请求过多，暂时无法添加');
        tc_json(200, array('ok' => true, 'status' => $status, 'user' => tc_im_pub_user($target)));
    });
}

// 好友请求落库(纯逻辑,tests/im-social.php 直接回归):
//   请求的权威存储在「收件方」文档;对方先请求过我 → 直接同意(matched);
//   我已请求过对方(幂等) → dup;已是好友 → already;超上限 → cap/reqcap。
//   $msg 为可选附加验证消息,原样存进请求记录,供收件方在「验证消息」里看到。
function tc_im_friend_request_apply(&$db, $from, $to, $msg = '') {
    $mine = tc_im_friends_doc($db, (string) $from['id']);
    $theirs = tc_im_friends_doc($db, (string) $to['id']);
    foreach ($mine['friends'] as $f) {
        if ((string) (isset($f['uid']) ? $f['uid'] : '') === (string) $to['id']) return array('', 'already');
    }
    // 虚拟好友(管理员虚拟关系/「所有人默认互为好友」)不必再发请求
    if (tc_im_are_friends($db, $from['id'], $to['id'])) return array('', 'already');
    foreach ($mine['reqs'] as $i => $r) {
        if ((string) (isset($r['from']) ? $r['from'] : '') !== (string) $to['id']) continue;
        array_splice($mine['reqs'], $i, 1);
        $mine['friends'][] = array('uid' => (string) $to['id'], 'since' => tc_now());
        $theirs['friends'][] = array('uid' => (string) $from['id'], 'since' => tc_now());
        tc_im_put_friends_doc($db, (string) $from['id'], $mine);
        tc_im_put_friends_doc($db, (string) $to['id'], $theirs);
        return array('matched', '');
    }
    foreach ($theirs['reqs'] as $r) {
        if ((string) (isset($r['from']) ? $r['from'] : '') === (string) $from['id']) return array('sent', 'dup');
    }
    if (count($mine['friends']) >= TC_IM_FRIENDS_CAP) return array('', 'cap');
    if (count($theirs['reqs']) >= TC_IM_REQS_CAP) return array('', 'reqcap');
    $req = array('id' => tc_uid(8), 'from' => (string) $from['id'], 'to' => (string) $to['id'], 'at' => tc_now());
    if ($msg !== '') $req['msg'] = $msg;
    $theirs['reqs'][] = $req;
    tc_im_put_friends_doc($db, (string) $to['id'], $theirs);
    return array('sent', '');
}

// 我发出的好友请求(纯逻辑,tests/im-social.php 直接回归)。
// 请求的权威存储在「收件方」文档里,记录中 to 是收件人。因此匹配我发出的请求必须看
// from==我 且 to==该文档所有者;若按 to==我 匹配会永远为空,「已发送未通过」就看不到了。
// 返回 array( array('uid' => 对方 id, 'req' => 请求记录), ... )
function tc_im_requests_out(&$db, $uid) {
    $uid = (string) $uid;
    $out = array();
    foreach (tc_im_friends_all($db) as $ouid => $odoc) {
        if (!is_array($odoc) || (string) $ouid === $uid) continue;
        foreach ((array) (isset($odoc['reqs']) ? $odoc['reqs'] : array()) as $r) {
            if (!is_array($r)) continue;
            if ((string) (isset($r['from']) ? $r['from'] : '') !== $uid) continue;
            if ((string) (isset($r['to']) ? $r['to'] : '') !== (string) $ouid) continue;
            $out[] = array('uid' => (string) $ouid, 'req' => $r);
        }
    }
    return $out;
}

// POST /api/friends/respond {id, accept}
function tc_api_friend_respond() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imfr:' . $user['id'], 10)) tc_fail(429, '操作过于频繁，请稍后再试');
        $b = tc_read_json_body(65536);
        $reqId = substr(trim((string) (isset($b['id']) ? $b['id'] : '')), 0, 64);
        $accept = !empty($b['accept']);
        if ($reqId === '') tc_fail(400, '缺少请求 ID');
        $mine = tc_im_friends_doc($db, $user['id']);
        $found = -1;
        $req = null;
        foreach ($mine['reqs'] as $i => $r) {
            if ((string) (isset($r['id']) ? $r['id'] : '') === $reqId) { $found = $i; $req = $r; break; }
        }
        if ($found < 0) tc_fail(404, '好友请求不存在或已处理');
        $from = (string) (isset($req['from']) ? $req['from'] : '');
        array_splice($mine['reqs'], $found, 1);
        if ($accept) {
            $target = null;
            foreach ($db['users'] as $u) {
                if (is_array($u) && isset($u['id']) && (string) $u['id'] === $from) { $target = $u; break; }
            }
            if (!$target) tc_fail(404, '对方账号已注销');
            $theirs = tc_im_friends_doc($db, $from);
            $already = false;
            foreach ($theirs['friends'] as $f) {
                if ((string) (isset($f['uid']) ? $f['uid'] : '') === (string) $user['id']) { $already = true; break; }
            }
            if (!$already) $theirs['friends'][] = array('uid' => (string) $user['id'], 'since' => tc_now());
            $mineHave = false;
            foreach ($mine['friends'] as $f) {
                if ((string) (isset($f['uid']) ? $f['uid'] : '') === $from) { $mineHave = true; break; }
            }
            if (!$mineHave) $mine['friends'][] = array('uid' => $from, 'since' => tc_now());
            tc_im_put_friends_doc($db, $from, $theirs);
        }
        tc_im_put_friends_doc($db, $user['id'], $mine);
        tc_json(200, array('ok' => true, 'status' => $accept ? 'accepted' : 'declined'));
    });
}

// DELETE /api/friends/{uid}
function tc_api_friend_remove($uid) {
    tc_with_db(true, function (&$db) use ($uid) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        $uid = preg_replace('/[^a-f0-9]/', '', (string) $uid);
        if ($uid === '') tc_fail(400, '无效的用户');
        // 管理员虚拟好友 / 「所有人默认互为好友」模式下的关系不可解除
        if (tc_im_are_friends($db, (string) $user['id'], $uid)) {
            tc_fail(400, tc_im_is_admin_uid($db, $uid) || tc_im_is_admin_uid($db, (string) $user['id'])
                ? '与管理员的好友关系无法解除'
                : '本站所有人默认互为好友，好友关系无法解除');
        }
        $mine = tc_im_friends_doc($db, $user['id']);
        $kept = array();
        foreach ($mine['friends'] as $f) {
            if ((string) (isset($f['uid']) ? $f['uid'] : '') === $uid) continue;
            $kept[] = $f;
        }
        if (count($kept) === count($mine['friends'])) tc_fail(404, '对方不在你的好友列表中');
        $mine['friends'] = $kept;
        tc_im_put_friends_doc($db, $user['id'], $mine);
        $theirs = tc_im_friends_doc($db, $uid);
        $theirs['friends'] = array_values(array_filter($theirs['friends'], function ($f) use ($user) {
            return (string) (isset($f['uid']) ? $f['uid'] : '') !== (string) $user['id'];
        }));
        tc_im_put_friends_doc($db, $uid, $theirs);
        // 好友关系解除,历史会话保留(加回好友可继续聊);列表接口按好友关系过滤入口
        tc_json(200, array('ok' => true));
    });
}

// ============ 会话 ============

// GET /api/im/threads
function tc_api_im_threads() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        $idx = tc_im_users_index($db);
        $state = tc_im_state_doc($db, $user['id']);
        $out = array();
        foreach (tc_im_threads_all($db) as $t) {
            if (!is_array($t) || !tc_im_thread_member($t, $user['id'])) continue;
            $tid = (string) (isset($t['id']) ? $t['id'] : '');
            $unread = (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0) - (int) (isset($state['lastRead'][$tid]) ? $state['lastRead'][$tid] : 0);
            $out[] = tc_im_pub_thread($t, $idx, $unread);
        }
        usort($out, function ($a, $b) { return $b['lastMsgAt'] <=> $a['lastMsgAt']; });
        tc_json(200, array('threads' => $out));
    });
}

// POST /api/im/threads {type:'dm',uid} 或 {type:'group',title,members}
function tc_api_im_thread_create() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imthread:' . $user['id'], 10)) tc_fail(429, '操作过于频繁，请稍后再试');
        $b = tc_read_json_body(131072);
        $type = (string) (isset($b['type']) ? $b['type'] : 'dm');
        $mine = tc_im_friends_doc($db, $user['id']);
        $friendIds = array();
        foreach ($mine['friends'] as $f) $friendIds[(string) (isset($f['uid']) ? $f['uid'] : '')] = true;
        if ($type === 'dm') {
            $uid = preg_replace('/[^a-f0-9]/', '', (string) (isset($b['uid']) ? $b['uid'] : ''));
            if ($uid === '' || $uid === (string) $user['id']) tc_fail(400, '请选择要聊天的好友');
            if (!isset($friendIds[$uid]) && !tc_im_are_friends($db, $user['id'], $uid)) tc_fail(403, '只能和好友开始聊天，请先添加好友');
            $existing = tc_im_find_dm($db, $user['id'], $uid);
            if ($existing) {
                $idx = tc_im_users_index($db);
                tc_json(200, array('thread' => tc_im_pub_thread($existing, $idx), 'existing' => true));
            }
            $t = array(
                'id' => tc_uid(12), 'type' => 'dm', 'members' => array((string) $user['id'], $uid),
                'ownerId' => (string) $user['id'], 'aiEnabled' => false,
                'createdAt' => tc_now(), 'lastMsgId' => 0, 'lastMsgAt' => 0, 'lastMsgFrom' => '', 'lastMsgText' => '',
            );
            $map = tc_im_threads_all($db);
            $map[(string) $t['id']] = $t;
            $db['imThreads'] = tc_object_map($map);
            $idx = tc_im_users_index($db);
            tc_json(200, array('thread' => tc_im_pub_thread($t, $idx), 'existing' => false));
        }
        if ($type !== 'group') tc_fail(400, '会话类型无效');
        $title = tc_utf_cut(trim((string) (isset($b['title']) ? $b['title'] : '')), 40);
        if ($title === '') tc_fail(400, '请填写群名称');
        $members = array((string) $user['id']);
        $seen = array((string) $user['id'] => true);
        foreach ((array) (isset($b['members']) ? $b['members'] : array()) as $m) {
            $uid = preg_replace('/[^a-f0-9]/', '', (string) $m);
            if ($uid === '' || isset($seen[$uid]) || (!isset($friendIds[$uid]) && !tc_im_are_friends($db, $user['id'], $uid))) continue;
            $seen[$uid] = true;
            $members[] = $uid;
            if (count($members) >= TC_IM_GROUP_CAP) break;
        }
        if (count($members) < 2) tc_fail(400, '请至少选择一位好友加入群聊');
        $t = array(
            'id' => tc_uid(12), 'type' => 'group', 'title' => $title, 'members' => $members,
            'ownerId' => (string) $user['id'], 'aiEnabled' => false,
            'createdAt' => tc_now(), 'lastMsgId' => 0, 'lastMsgAt' => 0, 'lastMsgFrom' => '', 'lastMsgText' => '',
        );
        $map = tc_im_threads_all($db);
        $map[(string) $t['id']] = $t;
        $db['imThreads'] = tc_object_map($map);
        $idx = tc_im_users_index($db);
        tc_json(200, array('thread' => tc_im_pub_thread($t, $idx), 'existing' => false));
    });
}

// POST /api/im/threads/{tid}/members {uids:[...]}:群聊加人(只能加自己的好友)
function tc_api_im_thread_add_members($tid) {
    tc_with_db(true, function (&$db) use ($tid) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imthread:' . $user['id'], 10)) tc_fail(429, '操作过于频繁，请稍后再试');
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        if (!isset($threads[$tid]) || !tc_im_thread_member($threads[$tid], $user['id'])) tc_fail(404, '会话不存在');
        $t = $threads[$tid];
        if (!isset($t['type']) || $t['type'] !== 'group') tc_fail(400, '单聊无需添加成员');
        $mine = tc_im_friends_doc($db, $user['id']);
        $friendIds = array();
        foreach ($mine['friends'] as $f) $friendIds[(string) (isset($f['uid']) ? $f['uid'] : '')] = true;
        $b = tc_read_json_body(131072);
        $added = array();
        foreach ((array) (isset($b['uids']) ? $b['uids'] : array()) as $m) {
            if (count($t['members']) >= TC_IM_GROUP_CAP) tc_fail(409, '群成员已达上限(' . TC_IM_GROUP_CAP . ')');
            $uid = preg_replace('/[^a-f0-9]/', '', (string) $m);
            if ($uid === '' || in_array($uid, array_map('strval', $t['members']), true) || (!isset($friendIds[$uid]) && !tc_im_are_friends($db, $user['id'], $uid))) continue;
            $t['members'][] = $uid;
            $added[] = $uid;
        }
        if (!$added) tc_fail(400, '没有可添加的成员（只能添加你自己的好友）');
        $threads[$tid] = $t;
        $db['imThreads'] = tc_object_map($threads);
        $idx = tc_im_users_index($db);
        tc_json(200, array('ok' => true, 'added' => count($added), 'thread' => tc_im_pub_thread($t, $idx)));
    });
}

// POST /api/im/threads/{tid}/ai {enabled?, context?}:会话级 AI 设置
//   enabled = 整会话开关(开启后每条消息都会召唤 AI)
//   context = 是否把本会话聊天记录作为上下文喂给 AI(默认开启)
function tc_api_im_thread_ai_toggle($tid) {
    tc_with_db(true, function (&$db) use ($tid) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        if (!isset($threads[$tid]) || !tc_im_thread_member($threads[$tid], $user['id'])) tc_fail(404, '会话不存在');
        $b = tc_read_json_body(65536);
        $t = $threads[$tid];
        // 同时承载两个 AI 偏好:整会话 AI 开关(enabled)与是否读取聊天上下文(context)。
        // 只更新请求里出现的字段,避免单发一个开关把另一个重置。
        $changed = false;
        if (array_key_exists('enabled', $b)) { $t['aiEnabled'] = !empty($b['enabled']); $changed = true; }
        if (array_key_exists('context', $b)) { $t['aiContext'] = !empty($b['context']); $changed = true; }
        if (!$changed) tc_fail(400, '没有需要更新的设置');
        $threads[$tid] = $t;
        $db['imThreads'] = tc_object_map($threads);
        tc_json(200, array(
            'ok' => true,
            'aiEnabled' => !empty($t['aiEnabled']),
            'aiContext' => !isset($t['aiContext']) || !empty($t['aiContext']),
        ));
    });
}

// POST /api/im/threads/{tid}/rename {title}:群主修改群名称
function tc_api_im_thread_rename($tid) {
    tc_with_db(true, function (&$db) use ($tid) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imthread:' . $user['id'], 10)) tc_fail(429, '操作过于频繁，请稍后再试');
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        if (!isset($threads[$tid]) || !tc_im_thread_member($threads[$tid], $user['id'])) tc_fail(404, '会话不存在');
        $t = $threads[$tid];
        if (!isset($t['type']) || $t['type'] !== 'group') tc_fail(400, '单聊无法重命名');
        if ((string) (isset($t['ownerId']) ? $t['ownerId'] : '') !== (string) $user['id']) tc_fail(403, '只有群主可以修改群名称');
        $b = tc_read_json_body(65536);
        $title = tc_utf_cut(trim((string) (isset($b['title']) ? $b['title'] : '')), 40);
        if ($title === '') tc_fail(400, '请填写群名称');
        $t['title'] = $title;
        $threads[$tid] = $t;
        $db['imThreads'] = tc_object_map($threads);
        $idx = tc_im_users_index($db);
        tc_json(200, array('ok' => true, 'thread' => tc_im_pub_thread($t, $idx)));
    });
}

// DELETE /api/im/threads/{tid}:
//   单聊 = 双向删除会话(双方列表移除、记录进留档,管理员可见)
//   群聊 = 群主解散(全员移除并留档);非群主请用退群语义? —— 这里统一为:
//   群主删除即解散;非群主删除 = 退群(仅自己退出,记录对其他人保留)
function tc_api_im_thread_delete($tid) {
    tc_with_db(true, function (&$db) use ($tid) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        if (!isset($threads[$tid]) || !tc_im_thread_member($threads[$tid], $user['id'])) tc_fail(404, '会话不存在');
        $t = $threads[$tid];
        $isGroup = isset($t['type']) && $t['type'] === 'group';
        $isOwner = (string) (isset($t['ownerId']) ? $t['ownerId'] : '') === (string) $user['id'];
        if ($isGroup && !$isOwner) {
            // 退群:仅移除自己,记录对其他成员保留;最后一人离开时整群留档后删除
            $t['members'] = array_values(array_filter(array_map('strval', $t['members']), function ($m) use ($user) {
                return $m !== (string) $user['id'];
            }));
            if (!$t['members']) {
                tc_im_archive_thread($db, $t, 'disband-empty', $user);
                unset($threads[$tid]);
                $db['imThreads'] = tc_object_map($threads);
                tc_json(200, array('ok' => true, 'action' => 'disbanded'));
            }
            $threads[$tid] = $t;
            $db['imThreads'] = tc_object_map($threads);
            tc_json(200, array('ok' => true, 'action' => 'left'));
        }
        // 单聊删除 / 群主解散:整会话进留档,双向移除
        tc_im_archive_thread($db, $t, $isGroup ? 'disband' : 'delete', $user);
        unset($threads[$tid]);
        $db['imThreads'] = tc_object_map($threads);
        $msgs = tc_im_msgs_all($db);
        unset($msgs[$tid]);
        $db['imMessages'] = tc_object_map($msgs);
        // 各成员的已读游标一并清掉
        foreach (tc_im_state_all($db) as $suid => $sdoc) {
            if (!is_array($sdoc) || !isset($sdoc['lastRead']) || !is_array($sdoc['lastRead'])) continue;
            if (!array_key_exists($tid, $sdoc['lastRead'])) continue;
            unset($sdoc['lastRead'][$tid]);
            tc_im_put_state_doc($db, (string) $suid, $sdoc);
        }
        tc_json(200, array('ok' => true, 'action' => 'deleted'));
    });
}

// 整会话留档:thread 快照 + 全部消息原文 + 事件,供管理员查看;物理清理走 admin purge
function tc_im_archive_thread(&$db, $t, $eventType, $byUser) {
    $tid = (string) (isset($t['id']) ? $t['id'] : '');
    $doc = tc_im_msgs_doc($db, $tid);
    $arch = tc_im_arch_doc($db, $tid);
    $arch['events'][] = array('type' => $eventType, 'by' => (string) $byUser['id'], 'byName' => (string) $byUser['name'], 'at' => tc_now());
    foreach ($doc['msgs'] as $m) {
        if (is_array($m) && !empty($m['deleted'])) continue;   // 已脱敏的占位没有正文,不留副本
        $arch['msgs'][] = $m;
    }
    $arch['thread'] = $t;
    tc_im_put_arch_doc($db, $tid, $arch);
}

// ============ 消息 ============

// GET /api/im/messages?thread=&after=&limit=(顺带标已读)
function tc_api_im_messages() {
    // 写事务:拉取即已读,已读游标要落盘(空闲轮询不推进游标、不产生写放大)
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('immsg:' . $user['id'], 120)) tc_fail(429, '拉取过于频繁，请稍后再试');
        $q = tc_query();
        $tid = (string) (isset($q['thread']) ? $q['thread'] : '');
        $after = max(0, (int) (isset($q['after']) ? $q['after'] : 0));
        $limit = min(500, max(1, (int) (isset($q['limit']) ? $q['limit'] : 200) ?: 200));
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        if (!isset($threads[$tid]) || !tc_im_thread_member($threads[$tid], $user['id'])) tc_fail(404, '会话不存在');
        $t = $threads[$tid];
        $doc = tc_im_msgs_doc($db, $tid);
        $matched = array();
        foreach ($doc['msgs'] as $m) {
            if (is_array($m) && (int) (isset($m['id']) ? $m['id'] : 0) > $after) $matched[] = $m;
        }
        if (count($matched) > $limit) $matched = array_slice($matched, -$limit);   // 取最新的 limit 条,升序返回
        $idx = tc_im_users_index($db);
        $out = array();
        foreach ($matched as $m) {
            $pub = tc_im_pub_msg($m, $user['id']);
            if ($pub) $out[] = $pub;
        }
        // 打开即已读:游标推进到会话最新一条(仅在有未读时写)
        $lastMsgId = (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0);
        $state = tc_im_state_doc($db, $user['id']);
        if ((int) (isset($state['lastRead'][$tid]) ? $state['lastRead'][$tid] : 0) < $lastMsgId) {
            $state['lastRead'][$tid] = $lastMsgId;
            tc_im_put_state_doc($db, $user['id'], $state);
        }
        tc_im_attach_cookie_sync($db, $user);
        tc_json(200, array('messages' => $out, 'thread' => tc_im_pub_thread($t, $idx)));
    });
}

// POST /api/im/messages {thread, text, file?, providerId?, model?}
function tc_api_im_send() {
    $ctx = array('aiPlan' => null);
    $payload = array();
    tc_with_db(true, function (&$db) use (&$ctx, &$payload) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imsend:' . $user['id'], 30)) tc_fail(429, '发送过于频繁，请稍后再试');
        $b = tc_read_json_body(131072);
        $tid = (string) (isset($b['thread']) ? $b['thread'] : '');
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        if (!isset($threads[$tid]) || !tc_im_thread_member($threads[$tid], $user['id'])) tc_fail(404, '会话不存在');
        $t = $threads[$tid];
        $text = tc_utf_cut(trim((string) (isset($b['text']) ? $b['text'] : '')), TC_IM_TEXT_MAX);

        // 附件:校验归属(必须是发送者自己上传的)与真实大小/类型,元数据以服务端磁盘为准
        $fileMeta = null;
        if (isset($b['file']) && is_array($b['file'])) {
            $fid = preg_replace('/[^a-f0-9-]/', '', (string) (isset($b['file']['id']) ? $b['file']['id'] : ''));
            $owner = tc_im_file_owner($fid);
            if ($owner === '' || (string) $owner !== (string) $user['id']) tc_fail(403, '附件不存在或无权使用');
            list($mime, $fsize) = tc_im_file_meta($fid);
            if ($mime === null) tc_fail(404, '附件不存在，请重新上传');
            $fileMeta = array(
                'id' => $fid,
                'name' => tc_utf_cut(trim((string) (isset($b['file']['name']) ? $b['file']['name'] : 'file')), 200),
                'size' => $fsize,
                'mime' => $mime,
                'image' => strpos($mime, 'image/') === 0,
            );
        }
        if ($text === '' && !$fileMeta) tc_fail(400, '消息不能为空');

        // 会话消息分片先读出来:AI 上下文快照要用到它(下面落库时再整体写回)。
        // 注意必须在召唤分支之前读 —— 放在后面会让上下文快照读到未定义的 $doc。
        $doc = tc_im_msgs_doc($db, $tid);

        // AI 召唤判定:显式前缀优先;会话开了 AI 模式时,所有文本消息都召唤
        list($summon, $question) = tc_im_ai_trigger($text);
        if (!$summon && !empty($t['aiEnabled']) && $text !== '') {
            $summon = true;
            $question = $text;
        }
        $aiErr = '';
        $aiPlan = null;
        if ($summon) {
            if (!tc_im_ai_consume($db, $user['id'])) {
                $summon = false;
                $aiErr = '今日 AI 召唤次数已用完（上限 ' . tc_im_ai_limit($db) . ' 次），管理员可在后台调整';
            } else {
                $resolved = tc_resolve_provider($db, $user, array(
                    'providerId' => isset($b['providerId']) ? (string) $b['providerId'] : '',
                    'model' => isset($b['model']) ? (string) $b['model'] : '',
                ));
                if (!empty($resolved['error'])) {
                    tc_im_ai_refund($user['id']);
                    $summon = false;
                    $aiErr = $resolved['error'];
                } else {
                    $provider = $resolved['provider'];
                    $model = tc_utf_cut(trim((string) (isset($b['model']) ? $b['model'] : '')), 120);
                    if ($model === '') $model = (string) (isset($provider['models'][0]['id']) ? $provider['models'][0]['id'] : '');
                    if ($model === '') {
                        tc_im_ai_refund($user['id']);
                        $summon = false;
                        $aiErr = '该供应商没有可用模型';
                    } else {
                        $baseCost = tc_model_cost($provider, $model);
                        $free = isset($provider['ownerId']) && (string) $provider['ownerId'] === (string) $user['id'];
                        if ($free) $baseCost = 0;
                        $reserveOk = tc_quota_reserve($db, $user['id'], $baseCost);
                        if (!$reserveOk) {
                            tc_im_ai_refund($user['id']);
                            $summon = false;
                            $aiErr = '剩余额度不足，无法召唤 AI';
                        } else {
                            $reserved = 0.0;
                            foreach ($db['users'] as $u) {
                                if ((string) $u['id'] === (string) $user['id']) {
                                    $reserved = isset($u['_quotaReserved']) ? (float) $u['_quotaReserved'] : 0.0;
                                    break;
                                }
                            }
                            // 上下文快照:本会话最近若干条消息。不含本次这条 —— 它下面才落库,
                            // 会作为最后一条 user 消息单独追加。事务结束后 $db 即释放,必须在事务内把文本带出来。
                            // 会话关闭「读取上下文」时留空,AI 只依据当前这条消息回答。
                            $ctxMsgs = array();
                            if (!isset($t['aiContext']) || !empty($t['aiContext'])) {
                                foreach (array_slice($doc['msgs'], -TC_IM_AI_CTX_MSGS) as $m) {
                                    if (!is_array($m) || trim((string) (isset($m['text']) ? $m['text'] : '')) === '') continue;
                                    $ctxMsgs[] = array(
                                        'name' => (string) (isset($m['name']) ? $m['name'] : ''),
                                        'kind' => (isset($m['kind']) && $m['kind'] === 'ai') ? 'ai' : 'user',
                                        'text' => tc_utf_cut((string) $m['text'], 2000),
                                    );
                                }
                            }
                            $aiPlan = array(
                                'threadId' => $tid, 'uid' => (string) $user['id'],
                                'senderName' => (string) $user['name'],
                                'question' => $question, 'context' => $ctxMsgs,
                                'provider' => $provider, 'providerFull' => $resolved['providerFull'], 'model' => $model,
                                'baseCost' => $baseCost, 'free' => $free, 'reserved' => $reserved,
                                'timeout' => (int) (isset($db['settings']['proxyTimeoutMs']) ? $db['settings']['proxyTimeoutMs'] : 30000),
                            );
                        }
                    }
                }
            }
        }

        // 落库用户消息(预览同步进会话元数据)
        $mid = (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0) + 1;
        $msg = array(
            'id' => $mid, 'from' => (string) $user['id'], 'name' => (string) $user['name'],
            'text' => $text, 'at' => tc_now(), 'kind' => 'user',
        );
        if ($fileMeta) $msg['file'] = $fileMeta;
        tc_im_store_msg($db, $t, $msg);
        $threads[$tid] = $t;
        $db['imThreads'] = tc_object_map($threads);
        // 自己发送即已读
        $state = tc_im_state_doc($db, $user['id']);
        $state['lastRead'][$tid] = max((int) (isset($state['lastRead'][$tid]) ? $state['lastRead'][$tid] : 0), $mid);
        tc_im_put_state_doc($db, $user['id'], $state);
        tc_im_attach_cookie_sync($db, $user);

        $idx = tc_im_users_index($db);
        $payload = array(
            'ok' => true,
            'message' => tc_im_pub_msg($msg, $user['id']),
            'thread' => tc_im_pub_thread($t, $idx),
            'ai' => $summon ? array('pending' => true, 'error' => '') : array('pending' => false, 'error' => $aiErr),
        );
        $ctx['aiPlan'] = $aiPlan;
    });

    // 事务已提交:先把响应交出去(fastcgi 下客户端不再等待),AI 回复在本进程内继续生成
    tc_im_emit($payload);
    if (!empty($ctx['aiPlan'])) tc_im_ai_reply($ctx['aiPlan']);
}

function tc_im_preview_of($text, $fileMeta) {
    $p = '';
    if ($fileMeta !== null) $p = ($fileMeta['image'] ? '[图片] ' : '[文件] ') . $fileMeta['name'];
    if ($text !== '') $p = $text . ($p !== '' ? ' ' . $p : '');
    if ($p === '') $p = '[消息]';
    return tc_utf_cut($p, TC_IM_PREVIEW_MAX);
}

// 消息落库并同步会话元数据(必须在写事务内调用):追加进 immsg 行(超上限丢最旧),
// 推进 lastMsgId/时间/预览;调用方负责把 $t 写回 imThreads。
function tc_im_store_msg(&$db, &$t, $msg) {
    $tid = (string) $t['id'];
    $doc = tc_im_msgs_doc($db, $tid);
    $doc['msgs'][] = $msg;
    if (count($doc['msgs']) > TC_IM_THREAD_MSG_CAP) $doc['msgs'] = array_slice($doc['msgs'], -TC_IM_THREAD_MSG_CAP);
    tc_im_put_msgs_doc($db, $tid, $doc);
    $t['lastMsgId'] = (int) (isset($msg['id']) ? $msg['id'] : 0);
    $t['lastMsgAt'] = (float) (isset($msg['at']) ? $msg['at'] : tc_now());
    $t['lastMsgFrom'] = (string) (isset($msg['from']) ? $msg['from'] : '');
    $t['lastMsgText'] = tc_im_preview_of(
        (string) (isset($msg['text']) ? $msg['text'] : ''),
        isset($msg['file']) && is_array($msg['file']) ? $msg['file'] : null
    );
}

// 响应先行:tc_json 会 exit,这里需要「输出后继续干活」的变体。
// 调用时机在 tc_with_db 返回之后(事务已提交),fastcgi 环境真正断开连接;
// 内置服务器等环境响应延后到脚本结束,发送方已本地回显自己的消息,不影响使用。
function tc_im_emit($payload) {
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo tc_json_encode($payload);
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
}

// AI 回复生成:调用上游(标准计费:预扣已在发送事务里完成,这里结算),
// 回复写回会话;任何失败都会退回预扣额度并落一条 aiError 占位,让会话里的人知道。
function tc_im_ai_reply($plan) {
    $uid = (string) $plan['uid'];
    $tid = (string) $plan['threadId'];
    $started = tc_now();
    tc_quota_mark_pending($uid, (float) $plan['reserved']);
    $provider = $plan['provider'];
    $format = isset($provider['apiFormat']) && in_array($provider['apiFormat'], array('chat', 'responses', 'completions', 'anthropic'), true) ? $provider['apiFormat'] : 'chat';
    // 按「本次模型」取对应密钥(多 Key 供应商下模型可能绑定不同 Key)
    $apiKey = trim((string) tc_provider_key_for_model($plan['providerFull'], (string) $plan['model']));
    $baseUrl = rtrim(trim((string) (isset($provider['baseUrl']) ? $provider['baseUrl'] : '')), '/');
    $fail = function ($msg) use ($plan, $uid) {
        tc_quota_refund_pending();
        tc_im_ai_error_msg($plan, $msg);
    };
    // 地址必需;Key 可留空(本地无鉴权上游),留空时不发认证头。
    if (!preg_match('/^https?:\/\//i', $baseUrl)) {
        $fail('供应商配置不完整（缺地址）');
        return;
    }
    $body = tc_im_ai_build_body($plan, $format);
    $url = tc_upstream_path($baseUrl, $format);
    if (!tc_upstream_url_is_safe($url)) {
        $fail('供应商地址不可用');
        return;
    }
    $headers = tc_upstream_auth_headers($format, $apiKey, false);
    $timeout = min(120000, max(5000, (int) (isset($plan['timeout']) ? $plan['timeout'] : 30000)));
    $res = tc_http_request($url, 'POST', $headers, tc_json_encode($body), $timeout, false);
    if (!$res['ok']) {
        $fail(tc_model_test_safe_error(tc_upstream_fail_message($res, (string) (isset($provider['name']) ? $provider['name'] : '')), $apiKey));
        return;
    }
    if ((int) $res['status'] >= 400) {
        $fail(tc_model_test_safe_error(tc_upstream_error_message($res['body'], (int) $res['status']), $apiKey));
        return;
    }
    $j = json_decode($res['body'], true);
    $text = tc_utf_cut(trim(tc_model_reply_full($j, $format)), TC_IM_AI_TEXT_MAX);
    if ($text === '') {
        $fail('上游已响应，但没有返回文本');
        return;
    }
    $usage = tc_im_usage_of($j, $format);
    $cost = tc_final_cost($provider, (float) $plan['baseCost'], $usage, !empty($plan['free']));
    $tid = (string) $plan['threadId'];
    $ok = false;
    tc_with_db(true, function (&$db) use (&$ok, $plan, $tid, $uid, $text, $cost, $usage) {
        $threads = tc_im_threads_all($db);
        // 会话可能在等待期间被删除:此时调用已发生,费用照常结算,只是无处落消息
        if (isset($threads[$tid]) && is_array($threads[$tid])) {
            $t = $threads[$tid];
            $mid = (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0) + 1;
            $msg = array(
                'id' => $mid, 'from' => 'ai', 'name' => 'AI', 'text' => $text,
                'at' => tc_now(), 'kind' => 'ai', 'model' => (string) $plan['model'],
            );
            tc_im_store_msg($db, $t, $msg);
            $threads[$tid] = $t;
            $db['imThreads'] = tc_object_map($threads);
            $ok = true;
        }
        // 结算:按实际用量多退少补 + 用量台账 + 调用统计(与主对话同一口径)
        $charged = tc_quota_settle($db, $uid, $cost, (string) $plan['model'], 'im');
        tc_record_usage_entry($db, $uid, (string) $plan['model'], $charged, (int) $usage['prompt'], (int) $usage['completion']);
        foreach ($db['users'] as $i => $u) {
            if ((string) $u['id'] !== $uid) continue;
            $row = $db['users'][$i];
            tc_charge_user_stats($db, $row, (string) $plan['model'], 'im');
            $db['users'][$i] = $row;
            break;
        }
    });
    tc_quota_clear_pending();
    if (!$ok) return;   // 会话已删,消息无处可落(费用已结算,与「发出去才发现对方删了会话」同一语义)
    tc_push_log(array(
        'kind' => 'im-ai', 'userId' => $uid, 'threadId' => $tid,
        'model' => (string) $plan['model'], 'cost' => $cost,
        'ms' => tc_now() - $started, 'ok' => true,
    ));
}

// 失败占位:在会话里落一条可见的 aiError 消息(不占 lastMsgId 之外的配额,照常推进)
function tc_im_ai_error_msg($plan, $msg) {
    $msg = tc_utf_cut(trim((string) $msg), 200);
    if ($msg === '') $msg = 'AI 暂时无法回复';
    try {
        tc_with_db(true, function (&$db) use ($plan, $msg) {
            $tid = (string) $plan['threadId'];
            $threads = tc_im_threads_all($db);
            if (!isset($threads[$tid]) || !is_array($threads[$tid])) return;
            $t = $threads[$tid];
            $mid = (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0) + 1;
            $m = array('id' => $mid, 'from' => 'ai', 'name' => 'AI', 'text' => 'AI 暂时无法回复：' . $msg, 'at' => tc_now(), 'kind' => 'ai', 'aiError' => true);
            tc_im_store_msg($db, $t, $m);
            $threads[$tid] = $t;
            $db['imThreads'] = tc_object_map($threads);
        });
    } catch (Throwable $e) { /* 留档失败不遮蔽原始错误 */ }
}

// 按供应商格式组装上游请求体:system 提示 + 最近上下文 + 本次问题
function tc_im_ai_build_body($plan, $format) {
    $hasCtx = !empty($plan['context']);
    $sys = '你是聊天应用里的 AI 助手。用户在单聊或群聊里通过「@AI」提及你来提问。'
        . '请用与提问相同的语言回答，简洁准确；'
        . ($hasCtx ? '群聊场景注意结合聊天上下文。' : '只根据当前这条消息作答，不要臆造历史对话。');
    $history = array();
    foreach ((array) (isset($plan['context']) ? $plan['context'] : array()) as $m) {
        $text = (string) (isset($m['text']) ? $m['text'] : '');
        if ($text === '') continue;
        if ((isset($m['kind']) && $m['kind'] === 'ai') || (string) (isset($m['from']) ? $m['from'] : '') === 'ai') {
            $history[] = array('role' => 'assistant', 'content' => $text);
        } else {
            $history[] = array('role' => 'user', 'content' => (string) (isset($m['name']) ? $m['name'] : '用户') . ': ' . $text);
        }
    }
    $q = (string) (isset($plan['question']) ? $plan['question'] : '');
    if ($q !== '') {
        $final = (string) $plan['senderName'] . ' 提问：' . $q;
    } elseif ($hasCtx) {
        $final = (string) $plan['senderName'] . ' 召唤了你。请结合以上聊天内容，继续参与讨论或回答未尽的问题。';
    } else {
        $final = (string) $plan['senderName'] . ' 召唤了你，请开始回答。';
    }
    $body = array('model' => (string) $plan['model'], 'stream' => false);
    if ($format === 'anthropic') {
        $body['system'] = $sys;
        $body['max_tokens'] = 2048;
        $body['messages'] = array_merge($history, array(array('role' => 'user', 'content' => $final)));
    } elseif ($format === 'responses') {
        $body['max_output_tokens'] = 2048;
        $body['input'] = $sys . "\n\n" . implode("\n", array_map(function ($m) {
            return ($m['role'] === 'user' ? '' : 'AI: ') . $m['content'];
        }, array_merge($history, array(array('role' => 'user', 'content' => $final)))));
    } elseif ($format === 'completions') {
        $body['max_tokens'] = 2048;
        $body['prompt'] = $sys . "\n\n" . implode("\n", array_map(function ($m) {
            return ($m['role'] === 'user' ? '' : 'AI: ') . $m['content'];
        }, array_merge($history, array(array('role' => 'user', 'content' => $final)))));
    } else {
        $body['max_tokens'] = 2048;
        $body['messages'] = array_merge(array(array('role' => 'system', 'content' => $sys)), $history, array(array('role' => 'user', 'content' => $final)));
    }
    return $body;
}

// 从上游非流式响应里取 token 用量(按 token 计费时 tc_final_cost 需要)
function tc_im_usage_of($data, $format) {
    $u = array();
    if (is_array($data) && isset($data['usage']) && is_array($data['usage'])) $u = $data['usage'];
    if ($format === 'anthropic' && is_array($data) && isset($data['message']['usage']) && is_array($data['message']['usage'])) {
        $u = $data['message']['usage'];
    }
    $p = 0;
    $c = 0;
    foreach (array('prompt_tokens', 'input_tokens', 'prompt') as $k) {
        if (isset($u[$k])) { $p = (int) $u[$k]; break; }
    }
    foreach (array('completion_tokens', 'output_tokens', 'completion') as $k) {
        if (isset($u[$k])) { $c = (int) $u[$k]; break; }
    }
    return array('prompt' => $p, 'completion' => $c);
}

// POST /api/im/messages/delete {thread, ids:[...]}:双向删除消息(内容进留档,双方脱敏)
function tc_api_im_msg_delete() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imsend:' . $user['id'], 30)) tc_fail(429, '操作过于频繁，请稍后再试');
        $b = tc_read_json_body(65536);
        $tid = (string) (isset($b['thread']) ? $b['thread'] : '');
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        if (!isset($threads[$tid]) || !tc_im_thread_member($threads[$tid], $user['id'])) tc_fail(404, '会话不存在');
        $t = $threads[$tid];
        $isGroup = isset($t['type']) && $t['type'] === 'group';
        $isOwner = (string) (isset($t['ownerId']) ? $t['ownerId'] : '') === (string) $user['id'];
        $ids = array();
        foreach ((array) (isset($b['ids']) ? $b['ids'] : array()) as $v) {
            $ids[(int) $v] = true;
            if (count($ids) >= 200) break;
        }
        if (!$ids) tc_fail(400, '请选择要删除的消息');
        $doc = tc_im_msgs_doc($db, $tid);
        $touched = 0;
        $arch = tc_im_arch_doc($db, $tid);
        $removedLast = false;
        $lastId = (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0);
        foreach ($doc['msgs'] as $i => $m) {
            if (!is_array($m) || empty($ids[(int) (isset($m['id']) ? $m['id'] : 0)])) continue;
            if (!empty($m['deleted'])) continue;
            // 权限:单聊双方都可删任意消息(Telegram 语义);群聊 = 本人删自己的 / 群主删任何人的
            $mine = (string) (isset($m['from']) ? $m['from'] : '') === (string) $user['id'];
            if ($isGroup && !$mine && !$isOwner) tc_fail(403, '只能删除自己的消息（群主可删除任何消息）');
            // 原文进留档(管理员可见),用户侧原地脱敏
            $arch['msgs'][] = $m;
            $doc['msgs'][$i] = array(
                'id' => (int) $m['id'], 'from' => (string) (isset($m['from']) ? $m['from'] : ''),
                'name' => (string) (isset($m['name']) ? $m['name'] : ''), 'at' => (float) (isset($m['at']) ? $m['at'] : 0),
                'kind' => (isset($m['kind']) && $m['kind'] === 'ai') ? 'ai' : 'user',
                'deleted' => true, 'deletedBy' => (string) $user['id'], 'deletedAt' => tc_now(),
            );
            if ((int) $m['id'] === $lastId) $removedLast = true;
            $touched++;
        }
        if (!$touched) tc_fail(404, '没有可删除的消息');
        $arch['events'][] = array('type' => 'msgs', 'ids' => array_keys($ids), 'by' => (string) $user['id'], 'byName' => (string) $user['name'], 'at' => tc_now());
        tc_im_put_arch_doc($db, $tid, $arch);
        tc_im_put_msgs_doc($db, $tid, $doc);
        // 推进会话修订号:另一侧靠 updates 里的 msgRev 感知「有人删了消息」并整窗重拉
        $t = $threads[$tid];
        $t['msgRev'] = (int) (isset($t['msgRev']) ? $t['msgRev'] : 0) + 1;
        if ($removedLast) $t['lastMsgText'] = '消息已删除';
        $threads[$tid] = $t;
        $db['imThreads'] = tc_object_map($threads);
        tc_json(200, array('ok' => true, 'removed' => $touched));
    });
}

// ============ 轮询聚合(打开 4s / 关闭 20s 各拉一次) ============

// GET /api/im/updates
function tc_api_im_updates() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('impoll:' . $user['id'], 120)) tc_fail(429, '轮询过于频繁，请稍后再试');
        $idx = tc_im_users_index($db);
        $doc = tc_im_friends_doc($db, $user['id']);
        $reqs = array();
        foreach ($doc['reqs'] as $r) {
            $from = (string) (isset($r['from']) ? $r['from'] : '');
            $pub = tc_im_pub_user(isset($idx[$from]) ? $idx[$from] : null);
            $pub['id'] = $pub['id'] !== '' ? $pub['id'] : $from;
            $pub['reqId'] = (string) (isset($r['id']) ? $r['id'] : '');
            $pub['at'] = (float) (isset($r['at']) ? $r['at'] : 0);
            $pub['msg'] = (string) (isset($r['msg']) ? $r['msg'] : '');   // 轮询会整组覆盖前端 requests,验证消息必须一并带上
            $reqs[] = $pub;
        }
        $state = tc_im_state_doc($db, $user['id']);
        $threads = array();
        $totalUnread = 0;
        foreach (tc_im_threads_all($db) as $t) {
            if (!is_array($t) || !tc_im_thread_member($t, $user['id'])) continue;
            $tid = (string) (isset($t['id']) ? $t['id'] : '');
            $unread = max(0, (int) (isset($t['lastMsgId']) ? $t['lastMsgId'] : 0) - (int) (isset($state['lastRead'][$tid]) ? $state['lastRead'][$tid] : 0));
            $totalUnread += $unread;
            $pub = tc_im_pub_thread($t, $idx, $unread);
            unset($pub['members']);
            $threads[] = $pub;
        }
        usort($threads, function ($a, $b) { return $b['lastMsgAt'] <=> $a['lastMsgAt']; });
        tc_json(200, array(
            't' => tc_now(),
            'threads' => $threads,
            'unread' => $totalUnread,
            'requests' => $reqs,
            'aiUsed' => tc_im_ai_used_today($user['id']),
            'aiLimit' => tc_im_ai_limit($db),
        ));
    });
}

// ============ 附件接口 ============

// POST /api/im/upload(multipart:file + threadId)
function tc_api_im_upload() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imupload:' . $user['id'], 60, 3600000)) tc_fail(429, '上传过于频繁，请稍后再试');
        if (empty($_FILES['file']) || !is_array($_FILES['file'])) tc_fail(400, '缺少上传文件');
        $f = $_FILES['file'];
        $err = (int) (isset($f['error']) ? $f['error'] : 0);
        if ($err !== UPLOAD_ERR_OK || empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) {
            tc_fail(400, $err === UPLOAD_ERR_INI_SIZE ? '文件超过服务器上传上限' : '上传失败（错误码 ' . $err . '）');
        }
        // 归属会话可选(发消息时才是强校验);给出时提前校验成员身份,避免传完才发现发不出去
        $threadId = preg_replace('/[^A-Za-z0-9_-]/', '', (string) (isset($_POST['threadId']) ? $_POST['threadId'] : ''));
        if ($threadId !== '') {
            $threads = tc_im_threads_all($db);
            if (!isset($threads[$threadId]) || !tc_im_thread_member($threads[$threadId], $user['id'])) tc_fail(404, '会话不存在');
        }
        $name = trim((string) (isset($f['name']) ? $f['name'] : ''));
        $name = str_replace(array("\r", "\n", '/', '\\'), '', $name !== '' ? $name : 'file');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        // 与笔记附件同一份白名单:图片给准确 MIME(可内联),其余强制下载输出
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
        if (!isset($images[$ext]) && isset($db['settings']['imAllowFiles']) && !$db['settings']['imAllowFiles']) {
            tc_fail(403, '本站聊天仅允许发送图片');
        }
        $isImage = isset($images[$ext]);
        $mime = $isImage ? $images[$ext] : (isset($docs[$ext]) ? $docs[$ext] : 'application/octet-stream');
        $sniffed = '';
        // 大小上限:图片 imMaxImageMb,其余 imMaxFileMb(均后台可配)
        $imgMb = (int) (isset($db['settings']['imMaxImageMb']) ? $db['settings']['imMaxImageMb'] : 10);
        $fileMb = (int) (isset($db['settings']['imMaxFileMb']) ? $db['settings']['imMaxFileMb'] : 20);
        if ($imgMb <= 0) $imgMb = 10;
        if ($fileMb <= 0) $fileMb = 20;
        $max = ($isImage ? $imgMb : $fileMb) * 1048576;
        $size = (int) (isset($f['size']) ? $f['size'] : 0);
        if ($size <= 0 || $size > $max) tc_fail(400, '文件大小超出限制（' . round($max / 1048576) . 'MB）');
        // 每用户空间配额(独立于笔记,0=不限)
        $quota = tc_im_quota_bytes($db);
        if ($quota > 0 && tc_im_user_usage($user['id']) + $size > $quota) {
            tc_fail(413, '聊天空间不足，请清理附件或联系管理员调整上限');
        }
        // 图片必须通过魔数校验:防止把 HTML/脚本改名成 .png 当成图片内联输出
        $fh = @fopen($f['tmp_name'], 'rb');
        if (!$fh) tc_fail(400, '文件读取失败');
        $probe = (string) fread($fh, 65536);
        if (strlen($probe) === 0) { fclose($fh); tc_fail(400, '文件读取不完整'); }
        if ($isImage) {
            $sniffed = tc_note_sniff_image_mime($probe);
            if ($sniffed === '') {
                fclose($fh);
                tc_fail(400, '文件内容与图片格式不符（伪造扩展名？），请上传真实的图片文件');
            }
            $mime = $sniffed;
            if (($ext === 'svg') !== ($sniffed === 'image/svg+xml')) {
                fclose($fh);
                tc_fail(400, '文件内容与扩展名不一致，请检查文件');
            }
        }
        unset($probe);
        $dir = tc_im_user_dir($user['id']);
        if ($dir === '' || !is_dir($dir) || !is_writable($dir)) { fclose($fh); tc_fail(500, '附件目录不可写，请检查 data/ 目录权限'); }
        $id = (string) $user['id'] . '-' . tc_uid(11);
        // 流式写入(与笔记附件同构):头部 = 1 字节 MIME 长度 + MIME,后接原文件
        $outPath = $dir . '/' . $id . '.bin';
        $tmpOut = $dir . '/' . $id . '.part';
        $w = @fopen($tmpOut, 'wb');
        if (!$w) { fclose($fh); tc_fail(500, '附件保存失败'); }
        $head = chr(strlen($mime)) . $mime;
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
        if (!@rename($tmpOut, $outPath)) {
            @unlink($tmpOut);
            tc_fail(500, '附件保存失败');
        }
        tc_im_attach_cookie_sync($db, $user);
        tc_json(200, array(
            'id' => $id,
            'name' => $name,
            'mimeType' => $mime,
            'size' => $size,
            'image' => strpos($mime, 'image/') === 0,
            'url' => tc_im_file_path($id, $name),
            'used' => tc_im_user_usage($user['id']),
            'quota' => $quota,
        ));
    });
}

// GET /api/im/file?id=&s=:签名下发附件。
// 可见范围:上传者本人 / 消息所在会话的成员 / 管理员(含留档审阅)。
function tc_api_im_file() {
    $q = tc_query();
    $id = preg_replace('/[^a-f0-9-]/', '', (string) (isset($q['id']) ? $q['id'] : ''));
    $sig = (string) (isset($q['s']) ? $q['s'] : '');
    if ($id === '' || $sig === '' || !hash_equals(tc_im_file_token($id), $sig)) {
        http_response_code(403);
        header('Content-Type: text/plain; charset=utf-8');
        echo '签名无效';
        exit;
    }
    $allowed = false;
    tc_with_db(false, function ($db) use (&$allowed, $id) {
        // 两种凭据都认:Bearer(前端接口调用)与附件 Cookie(浏览器自发加载 <img>/<a> 时带不了请求头)
        $me = tc_auth_user($db);
        $meId = $me ? (string) $me['id'] : tc_im_attach_cookie_uid($db);
        $owner = tc_im_file_owner($id);
        if ($meId !== '') {
            if ($owner === $meId) { $allowed = true; return; }
            if ($me && !empty($me['admin'])) { $allowed = true; return; }
        }
        // 会话成员:该附件出现在任一「我是成员的会话」的消息里(在线消息或留档原文)
        $memberTids = array();
        if ($meId !== '') {
            foreach (tc_im_threads_all($db) as $tid => $t) {
                if (is_array($t) && tc_im_thread_member($t, $meId)) $memberTids[(string) $tid] = true;
            }
        }
        foreach (tc_im_file_thread_ids($db, $id) as $ftid) {
            if (isset($memberTids[$ftid])) { $allowed = true; return; }
        }
    });
    if (!$allowed) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '附件不存在';
        exit;
    }
    $owner = tc_im_file_owner($id);
    $f = $owner !== '' ? tc_im_user_dir($owner, false) . '/' . $id . '.bin' : '';
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
    unset($raw);
    if ($ctype === '' || strpos($ctype, '/') === false) $ctype = 'application/octet-stream';
    $isImage = strpos($ctype, 'image/') === 0;
    header('Content-Type: ' . $ctype);
    header('Content-Length: ' . $bodyLen);
    header('X-Content-Type-Options: nosniff');
    if ($isImage) {
        if ($ctype === 'image/svg+xml') {
            header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
        }
    } else {
        $name = isset($q['name']) ? str_replace(array("\r", "\n", '"', '\\', '/'), '', (string) $q['name']) : '';
        $name = trim(substr($name, 0, 160));
        if ($name === '') $name = 'download';
        header("Content-Disposition: attachment; filename=\"" . rawurlencode($name) . "\"; filename*=UTF-8''" . rawurlencode($name));
        header("Content-Security-Policy: default-src 'none'; sandbox");
    }
    header('Cache-Control: private, max-age=31536000, immutable');
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

// POST /api/im/files/gc:回收自己目录里不再被任何消息/留档引用的附件
function tc_api_im_files_gc() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_im_feature_guard($db, $user);
        if (!tc_rate_limit_check('imgc:' . $user['id'], 12, 3600000)) tc_fail(429, '回收操作过于频繁，请稍后再试');
        $alive = array();
        foreach (tc_im_msgs_all($db) as $doc) {
            $msgs = isset($doc['msgs']) && is_array($doc['msgs']) ? $doc['msgs'] : array();
            foreach ($msgs as $m) {
                if (is_array($m) && isset($m['file']['id'])) $alive[(string) $m['file']['id']] = true;
            }
        }
        foreach (tc_im_arch_all_ids($db) as $fid => $_) $alive[(string) $fid] = true;
        $dir = tc_im_user_dir($user['id'], false);
        $removed = 0;
        $freed = 0;
        if ($dir !== '' && is_dir($dir)) {
            foreach ((array) @glob($dir . '/*.bin') as $f) {
                $fid = basename($f, '.bin');
                if (isset($alive[$fid])) continue;
                $sz = (int) @filesize($f);
                if (@unlink($f)) { $removed++; $freed += $sz; }
            }
            foreach ((array) @glob($dir . '/*.part') as $f) {
                if (@filemtime($f) > time() - 3600) continue;
                if (@unlink($f)) $removed++;
            }
        }
        tc_json(200, array('ok' => true, 'removed' => $removed, 'freed' => $freed, 'used' => tc_im_user_usage($user['id'])));
    });
}

// 留档里引用的附件 id 集合(留档未清理 = 文件仍被引用,不能回收)
function tc_im_arch_all_ids($db) {
    $out = array();
    foreach (tc_assoc(isset($db['imDeleted']) ? $db['imDeleted'] : null) as $doc) {
        if (!is_array($doc)) continue;
        foreach ((array) (isset($doc['msgs']) ? $doc['msgs'] : array()) as $m) {
            if (is_array($m) && isset($m['file']['id'])) $out[(string) $m['file']['id']] = true;
        }
    }
    return $out;
}

// ============ 管理端:会话列表 / 查看消息与留档 / 清理 ============

// GET /api/admin/im/threads
function tc_api_admin_im_threads() {
    tc_with_db(false, function ($db) {
        // 会话成员/消息属个人通信内容,与「不可查看用户对话」同一口径
        tc_demo_guard(tc_require_admin($db), '演示管理员不可查看用户聊天');
        $idx = tc_im_users_index($db);
        $out = array();
        $liveIds = array();
        foreach (tc_im_threads_all($db) as $tid => $t) {
            if (!is_array($t)) continue;
            $pub = tc_im_pub_thread($t, $idx);
            $doc = tc_im_msgs_doc($db, (string) $tid);
            $arch = tc_im_arch_doc($db, (string) $tid);
            $pub['msgCount'] = count($doc['msgs']);
            $pub['tombCount'] = count($arch['msgs']);
            $pub['archived'] = false;
            $out[] = $pub;
            $liveIds[(string) $tid] = true;
        }
        foreach (tc_assoc(isset($db['imDeleted']) ? $db['imDeleted'] : null) as $tid => $arch) {
            if (!is_array($arch) || isset($liveIds[(string) $tid]) || empty($arch['thread'])) continue;
            $pub = tc_im_pub_thread((array) $arch['thread'], $idx);
            $pub['msgCount'] = count((array) (isset($arch['msgs']) ? $arch['msgs'] : array()));
            $pub['tombCount'] = count((array) (isset($arch['events']) ? $arch['events'] : array()));
            $pub['archived'] = true;
            $out[] = $pub;
        }
        usort($out, function ($a, $b) { return $b['lastMsgAt'] <=> $a['lastMsgAt']; });
        tc_json(200, array('threads' => $out));
    });
}

// GET /api/admin/im/view?thread=(在线消息)|archive=(留档)
function tc_api_admin_im_view() {
    tc_with_db(false, function ($db) {
        // 这里直接返回消息原文(含留档),演示身份不得读取
        tc_demo_guard(tc_require_admin($db), '演示管理员不可查看用户聊天');
        $q = tc_query();
        $tid = (string) (isset($q['thread']) ? $q['thread'] : (isset($q['archive']) ? $q['archive'] : ''));
        if (!tc_im_tid_ok($tid)) tc_fail(400, '会话不存在');
        $threads = tc_im_threads_all($db);
        $arch = tc_im_arch_doc($db, $tid);
        $live = isset($threads[$tid]) && is_array($threads[$tid]);
        if (!$live && empty($arch['thread']) && empty($arch['msgs']) && empty($arch['events'])) tc_fail(404, '会话不存在');
        $idx = tc_im_users_index($db);
        $meta = $live ? tc_im_pub_thread($threads[$tid], $idx) : tc_im_pub_thread((array) $arch['thread'], $idx);
        if (!$live) $meta['archived'] = true;
        $msgs = array();
        if ($live) {
            $doc = tc_im_msgs_doc($db, $tid);
            foreach ($doc['msgs'] as $m) {
                $p = tc_im_pub_msg($m, '');
                if ($p) $msgs[] = $p;
            }
        }
        // 留档:消息原文 + 事件(谁在何时删了什么)
        $orig = array();
        foreach ($arch['msgs'] as $m) {
            if (!is_array($m)) continue;
            $orig[] = array(
                'id' => (int) (isset($m['id']) ? $m['id'] : 0),
                'from' => (string) (isset($m['from']) ? $m['from'] : ''),
                'name' => (string) (isset($m['name']) ? $m['name'] : ''),
                'text' => (string) (isset($m['text']) ? $m['text'] : ''),
                'at' => (float) (isset($m['at']) ? $m['at'] : 0),
                'kind' => (isset($m['kind']) && $m['kind'] === 'ai') ? 'ai' : 'user',
                'file' => isset($m['file']) ? $m['file'] : null,
            );
        }
        $events = array();
        foreach ($arch['events'] as $e) {
            if (!is_array($e)) continue;
            $events[] = array(
                'type' => (string) (isset($e['type']) ? $e['type'] : ''),
                'by' => (string) (isset($e['by']) ? $e['by'] : ''),
                'byName' => (string) (isset($e['byName']) ? $e['byName'] : ''),
                'at' => (float) (isset($e['at']) ? $e['at'] : 0),
                'ids' => isset($e['ids']) && is_array($e['ids']) ? array_map('intval', $e['ids']) : array(),
            );
        }
        tc_json(200, array('thread' => $meta, 'messages' => $msgs, 'archive' => array('msgs' => $orig, 'events' => $events)));
    });
}

// POST /api/admin/im/purge {threadIds:[...]}:物理清理留档行,并回收不再被引用的附件文件
function tc_api_admin_im_purge() {
    tc_with_db(true, function (&$db) {
        // 物理删除留档与附件,而 imDeleted 不在演示快照范围内 —— 一旦执行无法随
        // 演示到期还原,与「清理用户笔记 / 删除留档对话」同样一律拒绝
        $admin = tc_demo_guard(tc_require_admin($db), '演示管理员不能清理用户聊天留档');
        if (!tc_rate_limit_check('imadmin:' . $admin['id'], 10)) tc_fail(429, '操作过于频繁，请稍后再试');
        $b = tc_read_json_body(131072);
        $ids = array();
        foreach ((array) (isset($b['threadIds']) ? $b['threadIds'] : array()) as $v) {
            $tid = (string) $v;
            if (tc_im_tid_ok($tid)) $ids[$tid] = true;
            if (count($ids) >= 100) break;
        }
        if (!$ids) tc_fail(400, '请选择要清理的留档');
        $archMap = tc_assoc(isset($db['imDeleted']) ? $db['imDeleted'] : null);
        $collected = array();
        $purged = 0;
        foreach (array_keys($ids) as $tid) {
            if (!isset($archMap[$tid]) || !is_array($archMap[$tid])) continue;
            foreach ((array) (isset($archMap[$tid]['msgs']) ? $archMap[$tid]['msgs'] : array()) as $m) {
                if (is_array($m) && isset($m['file']['id'])) $collected[(string) $m['file']['id']] = true;
            }
            unset($archMap[$tid]);
            $purged++;
        }
        $db['imDeleted'] = tc_object_map($archMap);
        // 回收:清掉的留档若不再被任何消息/其余留档引用,物理删除文件
        $alive = array();
        foreach (tc_im_msgs_all($db) as $doc) {
            $msgs = isset($doc['msgs']) && is_array($doc['msgs']) ? $doc['msgs'] : array();
            foreach ($msgs as $m) {
                if (is_array($m) && isset($m['file']['id'])) $alive[(string) $m['file']['id']] = true;
            }
        }
        foreach (tc_im_arch_all_ids($db) as $fid => $_) $alive[(string) $fid] = true;
        $files = 0;
        foreach (array_keys($collected) as $fid) {
            if (isset($alive[$fid])) continue;
            $owner = tc_im_file_owner($fid);
            if ($owner === '') continue;
            $f = tc_im_user_dir($owner, false) . '/' . $fid . '.bin';
            if (is_file($f) && @unlink($f)) $files++;
        }
        tc_json(200, array('ok' => true, 'purged' => $purged, 'files' => $files));
    });
}
