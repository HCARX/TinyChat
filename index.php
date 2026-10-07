<?php
/**
 * TinyChat PHP 入口。
 * Apache / Nginx 把未命中静态文件的请求都交给本文件。
 */
define('TC_ROOT', __DIR__);
require_once __DIR__ . '/lib/core.php';
require_once __DIR__ . '/lib/integrity.php';
require_once __DIR__ . '/lib/api.php';
require_once __DIR__ . '/lib/im.php';
require_once __DIR__ . '/lib/proxy.php';
require_once __DIR__ . '/lib/web.php';
require_once __DIR__ . '/lib/tasks.php';
require_once __DIR__ . '/lib/oauth.php';
require_once __DIR__ . '/lib/updater.php';

tc_send_cors();

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$method = strtoupper($_SERVER['REQUEST_METHOD']);
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
$path = parse_url($uri, PHP_URL_PATH);
if ($path === false || $path === null || $path === '') $path = '/';
if (strlen($path) > 1 && substr($path, -1) === '/') $path = substr($path, 0, -1);

// 子目录部署：去掉脚本所在前缀
$scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
if ($scriptDir && $scriptDir !== '/' && strpos($path, $scriptDir) === 0) {
    $path = substr($path, strlen($scriptDir)) ?: '/';
}

if ($path === '/favicon.ico') {
    http_response_code(204);
    exit;
}

// 完整性校验(第一处):链接被替换/删除时暂停程序并给出提示。
// 另一处在 lib/core.php 的数据层入口,两处独立生效。
tc_integrity_guard();

try {
    tc_bootstrap_maybe(function () {
        tc_with_db(true, function (&$db) {
            $changed = tc_seed_admin($db);
            $changed = tc_seed_default_assistants($db) || $changed;
            // 演示管理员改动的设置在有效期后自动还原
            $changed = tc_demo_revert($db) || $changed;
            // 迁移期间新种进内存的内容(如内置系统工具箱)还没进库。读请求不落库,
            // 不在这里顺手写下去的话,种子每次请求都要重新装配一遍。
            if (!empty($GLOBALS['_tc_db_seed_dirty'])) $changed = true;
            if (!$changed) tc_db_skip_write();
        });
    });
    tc_uptime_sec();
} catch (Exception $e) {
    // 首次写库失败时仍允许继续，具体接口会再报错
}

if ($path === '/api' || strpos($path, '/api/') === 0 || $path === '/v1' || strpos($path, '/v1/') === 0) {
    try {
        tc_dispatch($method, $path);
    } catch (Exception $e) {
        // 对外只给固定文案:异常消息可能带绝对路径等敏感信息,详情写运行日志供后台排查
        try {
            tc_push_log(array('kind' => 'err', 'userName' => 'system', 'action' => '服务器异常(' . $method . ' ' . $path . '): ' . $e->getMessage(), 'error' => true));
        } catch (Throwable $t) { /* 日志不可用时不影响响应 */ }
        if (!headers_sent()) tc_fail(500, '服务器开小差了，请稍后重试');
    }
    exit;
}

if ($method === 'GET' || $method === 'HEAD') {
    $pages = array(
        '/' => 'index.html',
        '/index.html' => 'index.html',
        // 会话页别名。用 /app 而非 /chat:部分虚拟主机(如 InfinityFree)的边缘 WAF
        // 会拦截路径里含 "chat" 的请求,连路由地址也一样,用户会撞上主机的 403 页。
        '/app' => 'index.html',
        // AI 笔记独立地址:刷新后仍停留在笔记页(前端 boot 时检测该路径自动打开)
        '/ainotes' => 'index.html',
        // 在线聊天独立地址:刷新后仍停留在聊天页(前端 boot 时检测该路径自动打开)
        '/im' => 'index.html',
        // 在线浏览器独立地址:刷新后仍停留在浏览器页(前端 boot 时检测该路径自动打开)
        '/browser' => 'index.html',
        // 在线工具箱独立地址:刷新后仍停留在工具箱页(前端 boot 时检测该路径自动打开)
        '/toolbox' => 'index.html',
        '/login' => 'login.html',
        '/login.html' => 'login.html',
        '/admin' => 'admin.html',
        '/admin.html' => 'admin.html',
    );
    if (isset($pages[$path])) {
        tc_send_page($pages[$path]);
        exit;
    }
    if (preg_match('/^\/s\/[A-Za-z0-9]+$/', $path)) {
        tc_send_page('share.html');
        exit;
    }
    // AI 笔记分享页(实时读取属主笔记,关闭分享即失效)
    if (preg_match('/^\/n\/[A-Za-z0-9]+$/', $path)) {
        tc_send_page('note-share.html');
        exit;
    }
    if ($path === '/agreement') {
        tc_api_agreement_page();
        exit;
    }
    // 第三方一键登录:/auth/<provider> 发起授权,/auth/<provider>/callback 处理回调
    if (preg_match('#^/auth/([a-z0-9]+)$#', $path, $m)) {
        tc_oauth_start($m[1]);
        exit;
    }
    if (preg_match('#^/auth/([a-z0-9]+)/callback$#', $path, $m)) {
        tc_oauth_callback($m[1]);
        exit;
    }
}

http_response_code(404);
header('Content-Type: application/json; charset=utf-8');
echo tc_json_encode(array('error' => array('message' => '页面或接口不存在')));
exit;

function tc_send_page($file) {
    $full = TC_ROOT . '/' . $file;
    if (!is_file($full)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '页面不存在';
        return;
    }
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    // SEO 元信息里的 {{SITE_URL}} 占位符替换为站点绝对地址
    $html = file_get_contents($full);
    if (strpos($html, '{{SITE_URL}}') !== false) {
        $html = str_replace('{{SITE_URL}}', tc_public_base_url(), $html);
    }
    echo $html;
}

function tc_dispatch($method, $path) {
    $routes = array(
        array('GET', '#^/api/config$#', 'tc_api_public_config_wrap'),
        array('GET', '#^/api/env-check$#', 'tc_api_env_check'),
        array('POST', '#^/api/setup$#', 'tc_api_setup'),
        array('POST', '#^/api/auth/register$#', 'tc_api_register'),
        array('POST', '#^/api/auth/login$#', 'tc_api_login'),
        array('POST', '#^/api/auth/guest$#', 'tc_api_guest_login'),
        array('POST', '#^/api/auth/oauth/exchange$#', 'tc_api_oauth_exchange'),
        array('POST', '#^/api/auth/oauth/bind-ticket$#', 'tc_api_oauth_bind_ticket'),
        array('GET', '#^/api/me/oauth$#', 'tc_api_me_oauth'),
        array('GET', '#^/api/me/quota/ledger$#', 'tc_api_me_quota_ledger'),
        array('DELETE', '#^/api/me/oauth/([^/]+)$#', 'tc_api_me_oauth_unbind'),
        array('POST', '#^/api/auth/verify-email$#', 'tc_api_verify_email'),
        array('POST', '#^/api/auth/resend-verification$#', 'tc_api_resend_verification'),
        array('POST', '#^/api/auth/forgot-password$#', 'tc_api_forgot_password'),
        array('POST', '#^/api/auth/reset-password$#', 'tc_api_reset_password'),
        array('POST', '#^/api/auth/logout$#', 'tc_api_logout'),
        array('GET', '#^/api/auth/me$#', 'tc_api_me'),
        array('GET', '#^/api/me$#', 'tc_api_me'),
        array('POST', '#^/api/me/tools$#', 'tc_api_save_tools'),
        array('GET', '#^/api/me/apikeys$#', 'tc_api_me_apikeys_list'),
        array('POST', '#^/api/me/apikeys$#', 'tc_api_me_apikeys_create'),
        array('DELETE', '#^/api/me/apikeys/([^/]+)$#', 'tc_api_me_apikeys_delete'),
        array('GET', '#^/api/admin/invites$#', 'tc_api_admin_invites_list'),
        array('POST', '#^/api/admin/invites$#', 'tc_api_admin_invites_create'),
        array('DELETE', '#^/api/admin/invites/([^/]+)$#', 'tc_api_admin_invites_delete'),
        array('GET', '#^/api/admin/usage/export$#', 'tc_api_admin_usage_export'),
        array('POST', '#^/api/auth/password$#', 'tc_api_change_password'),
        array('POST', '#^/api/auth/name$#', 'tc_api_change_name'),
        array('POST', '#^/api/auth/delete$#', 'tc_api_delete_own_account'),
        array('GET', '#^/api/providers$#', 'tc_api_list_providers'),
        array('POST', '#^/api/providers$#', 'tc_api_create_provider'),
        // 保留:管理端/第三方客户端可用的全局供应商查询端点(当前内置前端未调用)
        array('GET', '#^/api/providers/global$#', 'tc_api_get_global_provider'),
        array('POST', '#^/api/providers/test$#', 'tc_api_user_test_model'),
        array('POST', '#^/api/providers/([^/]+)/key$#', 'tc_api_reveal_provider_key'),
        array('POST', '#^/api/providers/([^/]+)$#', 'tc_api_update_provider'),
        array('DELETE', '#^/api/providers/([^/]+)$#', 'tc_api_delete_provider'),
        array('GET', '#^/api/sync/chats$#', 'tc_api_sync_get_chats'),
        array('POST', '#^/api/sync/chats$#', 'tc_api_sync_save_chats'),
        array('DELETE', '#^/api/sync/chats$#', 'tc_api_sync_clear_chats'),
        array('POST', '#^/api/votes$#', 'tc_api_vote'),
        array('POST', '#^/api/shares$#', 'tc_api_create_share'),
        array('GET', '#^/api/shares/([^/]+)$#', 'tc_api_get_share'),
        // AI 笔记:整文档同步 / 附件上传与签名输出 / 分享链接(实时读取,支持 edit-link)
        array('GET', '#^/api/sync/notes$#', 'tc_api_notes_get'),
        array('POST', '#^/api/sync/notes$#', 'tc_api_notes_save'),
        // 用户设置云同步:界面偏好/外观/群聊配置/生成参数(整文档 + 乐观并发,换设备免重设)
        array('GET', '#^/api/sync/settings$#', 'tc_api_sync_get_settings'),
        array('POST', '#^/api/sync/settings$#', 'tc_api_sync_save_settings'),
        array('POST', '#^/api/notes/upload$#', 'tc_api_note_attachment_upload'),
        array('GET', '#^/api/notes/file$#', 'tc_api_note_attachment_serve'),
        array('DELETE', '#^/api/notes/file$#', 'tc_api_note_attachment_delete'),
        array('POST', '#^/api/notes/files/gc$#', 'tc_api_note_attachments_gc'),
        array('GET', '#^/api/notes/usage$#', 'tc_api_notes_usage'),
        array('POST', '#^/api/notes/ai/consume$#', 'tc_api_notes_ai_consume'),
        // 管理端笔记:用户用量列表 / 审阅某用户笔记 / 清理
        array('GET', '#^/api/admin/notes$#', 'tc_api_admin_notes_users'),
        array('GET', '#^/api/admin/notes/view$#', 'tc_api_admin_notes_view'),
        array('POST', '#^/api/admin/notes/purge$#', 'tc_api_admin_notes_purge'),
        array('POST', '#^/api/notes/share$#', 'tc_api_note_share_create'),
        array('DELETE', '#^/api/notes/share$#', 'tc_api_note_share_close'),
        array('GET', '#^/api/notes/shared/([A-Za-z0-9]+)$#', 'tc_api_note_shared_get'),
        array('POST', '#^/api/notes/shared/([A-Za-z0-9]+)$#', 'tc_api_note_shared_edit'),
        // 在线聊天(IM):好友 / 单聊 / 群聊 / 附件 / AI 召唤(handler 在 lib/im.php)
        array('GET', '#^/api/im/users/search$#', 'tc_api_im_user_search'),
        array('GET', '#^/api/friends$#', 'tc_api_friends_list'),
        array('POST', '#^/api/friends/request$#', 'tc_api_friend_request'),
        array('POST', '#^/api/friends/respond$#', 'tc_api_friend_respond'),
        array('DELETE', '#^/api/friends/([^/]+)$#', 'tc_api_friend_remove'),
        array('GET', '#^/api/im/threads$#', 'tc_api_im_threads'),
        array('POST', '#^/api/im/threads$#', 'tc_api_im_thread_create'),
        array('POST', '#^/api/im/threads/([^/]+)/members$#', 'tc_api_im_thread_add_members'),
        array('POST', '#^/api/im/threads/([^/]+)/ai$#', 'tc_api_im_thread_ai_toggle'),
        array('POST', '#^/api/im/threads/([^/]+)/rename$#', 'tc_api_im_thread_rename'),
        array('DELETE', '#^/api/im/threads/([^/]+)$#', 'tc_api_im_thread_delete'),
        array('GET', '#^/api/im/messages$#', 'tc_api_im_messages'),
        array('POST', '#^/api/im/messages$#', 'tc_api_im_send'),
        array('POST', '#^/api/im/messages/delete$#', 'tc_api_im_msg_delete'),
        array('POST', '#^/api/im/upload$#', 'tc_api_im_upload'),
        array('GET', '#^/api/im/file$#', 'tc_api_im_file'),
        array('POST', '#^/api/im/files/gc$#', 'tc_api_im_files_gc'),
        array('GET', '#^/api/im/updates$#', 'tc_api_im_updates'),
        // 管理端:会话列表 / 查看消息与删除留档 / 物理清理
        array('GET', '#^/api/admin/im/threads$#', 'tc_api_admin_im_threads'),
        array('GET', '#^/api/admin/im/view$#', 'tc_api_admin_im_view'),
        array('POST', '#^/api/admin/im/purge$#', 'tc_api_admin_im_purge'),
        // 在线浏览器:服务端反向代理(页面/子资源)、正文抽取、网页 AI 总结(handler 在 lib/web.php)
        array('GET', '#^/api/web/page$#', 'tc_api_web_page'),
        array('POST', '#^/api/web/page$#', 'tc_api_web_page'),
        array('GET', '#^/api/web/res$#', 'tc_api_web_res'),
        array('POST', '#^/api/web/ticket$#', 'tc_api_web_ticket'),
        array('GET', '#^/api/web/read$#', 'tc_api_web_read'),
        array('POST', '#^/api/web/summary$#', 'tc_api_web_summary'),
        array('GET', '#^/api/web/usage$#', 'tc_api_web_usage'),
        array('GET', '#^/api/web/bookmarks$#', 'tc_api_web_bookmarks_get'),
        array('POST', '#^/api/web/bookmarks$#', 'tc_api_web_bookmarks_save'),
        // 在线工具箱:整文档同步(与笔记同构) + 工具页面的签名输出(响应头带 CSP sandbox)
        array('GET', '#^/api/sync/toolbox$#', 'tc_api_toolbox_get'),
        array('POST', '#^/api/sync/toolbox$#', 'tc_api_toolbox_save'),
        array('GET', '#^/api/toolbox/page$#', 'tc_api_toolbox_page'),
        // 系统工具箱(后台维护、全员共用):读全体可用,写要管理员
        array('GET', '#^/api/admin/toolbox$#', 'tc_api_admin_toolbox_get'),
        array('POST', '#^/api/admin/toolbox$#', 'tc_api_admin_toolbox_save'),
        array('GET', '#^/api/assistants$#', 'tc_api_list_assistants'),
        array('POST', '#^/api/assistants/categories$#', 'tc_api_create_assistant_category'),
        array('POST', '#^/api/assistants/categories/([^/]+)$#', 'tc_api_update_assistant_category'),
        array('DELETE', '#^/api/assistants/categories/([^/]+)$#', 'tc_api_delete_assistant_category'),
        array('POST', '#^/api/assistants$#', 'tc_api_create_assistant'),
        array('POST', '#^/api/assistants/([^/]+)/reset$#', 'tc_api_reset_assistant'),
        array('POST', '#^/api/assistants/([^/]+)$#', 'tc_api_update_assistant'),
        array('DELETE', '#^/api/assistants/([^/]+)$#', 'tc_api_delete_assistant'),
        array('GET', '#^/api/admin/stats$#', 'tc_api_admin_stats'),
        array('GET', '#^/api/admin/system$#', 'tc_api_admin_system'),
        array('GET', '#^/api/admin/storage$#', 'tc_api_admin_storage'),
        array('POST', '#^/api/admin/storage/clean$#', 'tc_api_admin_storage_clean'),
        array('GET', '#^/api/admin/settings$#', 'tc_api_admin_get_settings'),
        array('POST', '#^/api/admin/settings$#', 'tc_api_admin_save_settings'),
        array('POST', '#^/api/admin/session/invalidate$#', 'tc_api_admin_invalidate_sessions'),
        array('GET', '#^/api/admin/thinking$#', 'tc_api_admin_get_thinking'),
        array('POST', '#^/api/admin/thinking$#', 'tc_api_admin_save_thinking'),
        array('GET', '#^/api/packages$#', 'tc_api_list_packages'),
        array('POST', '#^/api/packages/redeem$#', 'tc_api_redeem_package'),
        array('POST', '#^/api/packages/claim$#', 'tc_api_claim_package'),
        array('GET', '#^/api/admin/packages$#', 'tc_api_admin_list_packages'),
        array('POST', '#^/api/admin/packages$#', 'tc_api_admin_save_package'),
        array('DELETE', '#^/api/admin/packages/([^/]+)$#', 'tc_api_admin_delete_package'),
        array('POST', '#^/api/admin/packages/([^/]+)/codes$#', 'tc_api_admin_generate_codes'),
        array('GET', '#^/api/admin/packages/([^/]+)/codes/export$#', 'tc_api_admin_export_codes'),
        array('DELETE', '#^/api/admin/codes/([^/]+)$#', 'tc_api_admin_delete_code'),
        array('POST', '#^/api/admin/codes/prune$#', 'tc_api_admin_prune_codes'),
        array('POST', '#^/api/admin/codes/fixed$#', 'tc_api_admin_create_fixed_code'),
        array('POST', '#^/api/admin/settings/test-email$#', 'tc_api_admin_test_email'),
        array('POST', '#^/api/admin/settings/smtp-reveal$#', 'tc_api_admin_smtp_reveal'),
        array('GET', '#^/api/admin/settings/mail-template-defaults$#', 'tc_api_admin_mail_template_defaults'),
        array('GET', '#^/api/admin/model-meta$#', 'tc_api_admin_model_meta_list'),
        array('POST', '#^/api/admin/model-meta$#', 'tc_api_admin_model_meta_save'),
        array('DELETE', '#^/api/admin/model-meta$#', 'tc_api_admin_model_meta_delete'),
        array('POST', '#^/api/admin/model-meta/clear$#', 'tc_api_admin_model_meta_clear'),
        array('POST', '#^/api/admin/model-meta/sync$#', 'tc_api_admin_model_meta_sync'),
        array('GET', '#^/api/admin/update/check$#', 'tc_api_admin_update_check'),
        array('POST', '#^/api/admin/update/perform$#', 'tc_api_admin_update_perform'),
        array('POST', '#^/api/admin/search/test$#', 'tc_api_admin_test_search'),
        array('GET', '#^/api/admin/logs$#', 'tc_api_admin_logs'),
        array('DELETE', '#^/api/admin/logs$#', 'tc_api_admin_delete_logs'),
        array('GET', '#^/api/admin/backup$#', 'tc_api_admin_backup_list'),
        array('POST', '#^/api/admin/backup$#', 'tc_api_admin_backup_create'),
        array('GET', '#^/api/admin/backup/download$#', 'tc_api_admin_backup_download'),
        array('POST', '#^/api/admin/backup/restore$#', 'tc_api_admin_backup_restore'),
        array('GET', '#^/api/admin/users$#', 'tc_api_admin_users'),
        array('GET', '#^/api/admin/users/chats$#', 'tc_api_admin_user_chats'),
        // 已删除对话留档(A 设备删除后仍保留在云端,管理员可看可清)
        array('GET', '#^/api/admin/chats/deleted$#', 'tc_api_admin_deleted_chats'),
        array('GET', '#^/api/admin/chats/deleted/view$#', 'tc_api_admin_deleted_chat_view'),
        array('POST', '#^/api/admin/chats/deleted/purge$#', 'tc_api_admin_deleted_chats_purge'),
        array('POST', '#^/api/admin/users$#', 'tc_api_admin_create_user'),
        array('POST', '#^/api/admin/users/update$#', 'tc_api_admin_update_user'),
        array('POST', '#^/api/admin/users/quota$#', 'tc_api_admin_set_quota'),
        array('POST', '#^/api/admin/users/group$#', 'tc_api_admin_set_user_group'),
        array('GET', '#^/api/admin/users/oauth$#', 'tc_api_admin_user_oauth_list'),
        array('DELETE', '#^/api/admin/users/([^/]+)/oauth/([^/]+)$#', 'tc_api_admin_user_oauth_unbind'),
        array('DELETE', '#^/api/admin/users/([^/]+)$#', 'tc_api_admin_delete_user'),
        array('POST', '#^/api/admin/users/bulk-delete$#', 'tc_api_admin_bulk_delete_users'),
        array('POST', '#^/api/admin/users/purge-guests$#', 'tc_api_admin_purge_guests'),
        array('GET', '#^/api/admin/groups$#', 'tc_api_admin_groups'),
        array('POST', '#^/api/admin/groups$#', 'tc_api_admin_create_group'),
        array('POST', '#^/api/admin/groups/default$#', 'tc_api_admin_set_default_group'),
        array('POST', '#^/api/admin/groups/([^/]+)$#', 'tc_api_admin_update_group'),
        array('DELETE', '#^/api/admin/groups/([^/]+)$#', 'tc_api_admin_delete_group'),
        array('GET', '#^/api/admin/access$#', 'tc_api_admin_get_access'),
        array('POST', '#^/api/admin/access$#', 'tc_api_admin_set_access'),
        array('GET', '#^/api/admin/assistants$#', 'tc_api_admin_list_assistants'),
        array('POST', '#^/api/admin/assistants/categories$#', 'tc_api_admin_create_assistant_category'),
        array('POST', '#^/api/admin/assistants/categories/([^/]+)$#', 'tc_api_admin_update_assistant_category'),
        array('DELETE', '#^/api/admin/assistants/categories/([^/]+)$#', 'tc_api_admin_delete_assistant_category'),
        array('POST', '#^/api/admin/assistants$#', 'tc_api_admin_create_assistant'),
        array('POST', '#^/api/admin/assistants/([^/]+)$#', 'tc_api_admin_update_assistant'),
        array('DELETE', '#^/api/admin/assistants/([^/]+)$#', 'tc_api_admin_delete_assistant'),
        array('POST', '#^/api/admin/providers/test$#', 'tc_api_admin_test_model'),
        array('POST', '#^/api/admin/providers/([^/]+)$#', 'tc_api_admin_update_provider'),
        array('DELETE', '#^/api/admin/providers/([^/]+)$#', 'tc_api_admin_delete_provider'),
        array('POST', '#^/api/documents/parse$#', 'tc_api_parse_document'),
        // 保留:任务详情查询端点(内置前端只用 /events 与 /cancel,第三方客户端可用)
        array('GET', '#^/api/proxy/tasks/([^/]+)$#', 'tc_api_proxy_task'),
        array('GET', '#^/api/proxy/tasks/([^/]+)/events$#', 'tc_api_proxy_task_events'),
        array('POST', '#^/api/proxy/tasks/([^/]+)/cancel$#', 'tc_api_proxy_task_cancel'),
        array('POST', '#^/api/proxy/chat$#', 'tc_api_proxy_chat'),
        array('POST', '#^/api/proxy/completions$#', 'tc_api_proxy_completions'),
        array('POST', '#^/api/proxy/responses$#', 'tc_api_proxy_responses'),
        array('POST', '#^/api/proxy/anthropic$#', 'tc_api_proxy_anthropic'),
        array('GET', '#^/api/proxy/models$#', 'tc_api_list_models'),
        array('POST', '#^/api/proxy/fetch-models$#', 'tc_api_fetch_models'),
        array('POST', '#^/api/proxy/images$#', 'tc_api_proxy_images'),
        array('POST', '#^/api/proxy/videos$#', 'tc_api_proxy_videos'),
        // 生图结果图片代理(签名鉴权,见 lib/proxy.php;供 <img> 同源加载)
        array('GET', '#^/api/proxy/image$#', 'tc_api_image_proxy'),
        // 视频结果代理(签名鉴权;转发 Range,供 <video> 同源播放)
        array('GET', '#^/api/proxy/video$#', 'tc_api_video_proxy'),
        array('POST', '#^/v1/chat/completions$#', 'tc_api_v1_chat_completions'),
        array('GET', '#^/v1/models$#', 'tc_api_v1_models'),
        array('POST', '#^/v1/images/generations$#', 'tc_api_v1_images_generations'),
        array('POST', '#^/v1/videos$#', 'tc_api_v1_videos'),
    );
    foreach ($routes as $r) {
        if ($r[0] !== $method) continue;
        if (!preg_match($r[1], $path, $m)) continue;
        $params = array_slice($m, 1);
        foreach ($params as &$p) $p = rawurldecode($p);
        unset($p);
        call_user_func_array($r[2], $params);
        return;
    }
    tc_fail(404, '接口不存在: ' . $method . ' ' . $path);
}

function tc_api_public_config_wrap() {
    // 数据库不可读写(常见于 data/ 目录权限不足)时也要返回可用的最小配置,
    // 让登录页能进入环境自检而不是停在无法注册的注册页。
    try {
        tc_with_db(false, function ($db) { tc_api_public_config($db); });
    } catch (Throwable $e) {
        tc_fail_public_config($e->getMessage());
    }
}

function tc_fail_public_config($reason) {
    // 异常原文可能带绝对路径/驱动细节,只记后台日志;对外仅给布尔标记。
    try { tc_push_log(array('kind' => 'err', 'userName' => 'system', 'action' => '公共配置读取失败: ' . $reason, 'error' => true)); } catch (Throwable $t) {}
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo tc_json_encode(array(
        'siteName' => 'TinyChat',
        'allowRegister' => false,
        'freeQuota' => 0,
        'version' => TC_VERSION,
        'hasProvider' => false,
        'needsSetup' => true,
        'dbError' => true,
        'emailVerificationEnabled' => false,
        'passwordResetEnabled' => false,
        'mailReady' => false,
        'webSearch' => array('enabled' => false),
        'mineru' => array('token' => '', 'enabled' => false),
        'announcement' => array('enabled' => false, 'text' => '', 'updatedAt' => 0),
        'registerInviteRequired' => false,
        'demoMode' => false,
        'demoExpireMinutes' => 10,
        'guestEnabled' => false,
        'guestRounds' => 3,
    ));
    exit;
}

function tc_api_proxy_task($id) {
    tc_with_db(false, function ($db) use ($id) {
        $user = tc_require_auth($db); $task = tc_task_read($id);
        if (!$task || (string) ($task['userId'] ?? '') !== (string) $user['id']) tc_fail(404, '任务不存在');
        $out = $task; unset($out['events']); tc_json(200, $out);
    });
}
function tc_api_proxy_task_events($id) {
    tc_with_db(false, function ($db) use ($id) {
        $user = tc_require_auth($db); $task = tc_task_read($id);
        if (!$task || (string) ($task['userId'] ?? '') !== (string) $user['id']) tc_fail(404, '任务不存在');
        $after = max(0, (int) ($_GET['after'] ?? 0)); $events = array_values(array_filter((array) ($task['events'] ?? array()), function ($e) use ($after) { return (int) ($e['seq'] ?? 0) > $after; }));
        tc_json(200, array('status' => $task['status'], 'seq' => (int) ($task['seq'] ?? 0), 'events' => $events, 'error' => $task['error'] ?? ''));
    });
}
function tc_api_proxy_task_cancel($id) {
    tc_with_db(true, function (&$db) use ($id) {
        $user = tc_require_auth($db); $task = tc_task_read($id);
        if (!$task || (string) ($task['userId'] ?? '') !== (string) $user['id']) tc_fail(404, '任务不存在');
        tc_task_finish($id, 'cancelled', '用户取消'); tc_json(200, array('ok' => true));
    });
}
function tc_api_proxy_chat() { tc_api_proxy('chat'); }
function tc_api_proxy_completions() { tc_api_proxy('completions'); }
function tc_api_proxy_responses() { tc_api_proxy('responses'); }
function tc_api_proxy_anthropic() { tc_api_proxy('anthropic'); }
