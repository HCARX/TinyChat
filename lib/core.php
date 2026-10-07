<?php
/**
 * TinyChat PHP 核心：配置、JSON 库、JWT、密码、日志、限流。
 */
if (!defined('TC_ROOT')) {
    define('TC_ROOT', dirname(__DIR__));
}

define('TC_VERSION', '2.0.145');
// 单篇笔记正文上限(字符)。超出时接口明确报错而不是静默截断。
define('TC_NOTE_MAX_CHARS', 500000);
// 敏感词库上限(去重后的条数)。达到上限后新增词条被丢弃,单个词条本身不截断。
define('TC_MODERATION_MAX_WORDS', 50000);
// ---- 在线工具箱 ----
// 每用户最多几个工具、单个工具 HTML 上限(字符)、每用户总字符上限。
// 与笔记同一取舍:超出时接口明确报错,不静默截断 —— 用户的工具被悄悄截掉半页,
// 表现是「页面偶尔缺一半脚本」,比直接报错难查得多。
define('TC_TOOLBOX_MAX_ITEMS', 50);
define('TC_TOOLBOX_MAX_HTML', 200000);
define('TC_TOOLBOX_MAX_TOTAL', 4000000);
// 分类上限(用户自建分类与系统分类各算一份)与分类名长度;系统工具总数另设上限,
// 它与 TC_TOOLBOX_MAX_ITEMS 是两回事:前者是「后台给所有人发的」,后者是「自己攒的」。
define('TC_TOOLBOX_MAX_CATS', 50);
define('TC_TOOLBOX_CAT_NAME_MAX', 20);
define('TC_TOOLBOX_MAX_SYS_ITEMS', 200);
// 系统工具箱整份文档的字符上限。它整键存成一行,给到 8MB 留足空间,
// 同时保证 JSON 请求体(转义后还会膨胀)仍在后台接口 16MB 的读入上限之内。
define('TC_TOOLBOX_MAX_SYS_TOTAL', 8000000);
// 工具打开时用的 Cookie(见 lib/api.php 的 tc_toolbox_cookie_*):
// 页面是在 iframe/新标签页里被**浏览器直接导航**的,带不了 Authorization 头,
// 只能靠 Cookie 认人。作用域与笔记附件 Cookie 分开,便于各自失效。
define('TC_TOOLBOX_COOKIE', 'oc_tbox');
define('TC_DB_VERSION', 2);
define('TC_PBKDF2_ITER', 120000);
define('TC_LOG_LIMIT', 500);
// 邮件默认模板版本:升级默认样式时 +1,旧默认(或为空)会自动换成新版,自定义模板不受影响
define('TC_MAIL_TPL_VERSION', 2);

// 输出上限与上下文窗口的唯一来源是「模型元数据」表(按模型名匹配,全站渠道共用)。
// 表里没有该模型时,取数处会按这两个常量自动补一条并标记「待人工复核」,
// 管理员复核后即成为该模型的正式上限。
//   输出上限 8192:推理模型的思维链与正文共用这个额度,取值需为正文留余量;
//   上下文窗口 131072:128K 是当前主流模型的常见窗口,偏保守以免高估小模型。
define('TC_MODEL_META_AUTO_OUTPUT', 8192);
define('TC_MODEL_META_AUTO_CONTEXT', 131072);

// 内置模型元数据表的版本。改动 tc_builtin_model_meta() 后 +1:
// 升级时只补「库里还没有、或仍是自动兜底值」的条目,管理员改过的一律不动。
define('TC_MODEL_META_BUILTIN_VERSION', 1);

// 默认邮件模板:同一套卡片式外壳,占位符 {siteName} {name} {link} {expires}
function tc_mail_default_templates() {
    $shell = function ($title, $introHtml, $buttonText, $noteText) {
        return '<!DOCTYPE html>'
            . '<html lang="zh-CN"><body style="margin:0;padding:0;background:#eef1f6;">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f6;padding:36px 16px;">'
            . '<tr><td align="center">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">'
            . '<tr><td style="background:#ffffff;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',Helvetica,Arial,sans-serif;">'
            . '<div style="height:5px;background:#4f46e5;line-height:5px;font-size:0;">&nbsp;</div>'
            . '<div style="padding:34px 40px 0;">'
            . '<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:#eef2ff;color:#4f46e5;font-size:12px;font-weight:600;letter-spacing:0.5px;">{siteName}</span>'
            . '<h1 style="margin:18px 0 0;font-size:21px;line-height:1.4;color:#0f172a;font-weight:700;">' . $title . '</h1>'
            . '<div style="margin:14px 0 0;font-size:14px;line-height:1.85;color:#475569;">' . $introHtml . '</div>'
            . '</div>'
            . '<div style="padding:26px 40px 0;text-align:center;">'
            . '<a href="{link}" style="display:inline-block;background:#4f46e5;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 38px;border-radius:12px;">' . $buttonText . '</a>'
            . '</div>'
            . '<div style="padding:22px 40px 0;">'
            . '<p style="margin:0;font-size:12.5px;line-height:1.8;color:#94a3b8;word-break:break-all;">若按钮无法点击，请复制以下链接到浏览器打开：<br><a href="{link}" style="color:#4f46e5;text-decoration:none;">{link}</a></p>'
            . '<p style="margin:12px 0 0;font-size:12.5px;line-height:1.8;color:#94a3b8;">' . $noteText . '如果这不是你本人操作，可以放心忽略这封邮件。</p>'
            . '</div>'
            . '<div style="padding:26px 40px 30px;">'
            . '<div style="height:1px;background:#e8ecf3;line-height:1px;font-size:0;">&nbsp;</div>'
            . '<p style="margin:14px 0 0;font-size:12px;color:#b6c0cf;text-align:center;">此邮件由 {siteName} 系统发送，请勿直接回复</p>'
            . '</div>'
            . '</td></tr></table>'
            . '</td></tr></table>'
            . '</body></html>';
    };
    return array(
        'tplVersion' => TC_MAIL_TPL_VERSION,
        'verifySubject' => '验证你的 {siteName} 账号',
        'verifyHtml' => $shell(
            '验证你的邮箱',
            '<p style="margin:0;">你好，<b style="color:#0f172a;">{name}</b>：</p><p style="margin:10px 0 0;">感谢注册 {siteName}。点击下方按钮完成邮箱验证，即可开始使用全部功能。</p>',
            '验证邮箱',
            '链接 {expires} 内有效。'
        ),
        'resetSubject' => '重置你的 {siteName} 密码',
        'resetHtml' => $shell(
            '重置你的密码',
            '<p style="margin:0;">你好，<b style="color:#0f172a;">{name}</b>：</p><p style="margin:10px 0 0;">我们收到了你重置 {siteName} 账号密码的请求。点击下方按钮设置新密码。</p>',
            '重置密码',
            '链接 {expires} 内有效。'
        ),
    );
}

// 内置的默认用户协议正文(HTML)。后台「内容安全」里可自由修改,默认不启用
// (agreementEnabled=false 时公开页 /agreement 返回 404)。预置一段通用文本是为了让管理员
// 不必从空白起步:内容刻意用「本平台」这类中性称谓,可直接套用,也可按实际业务改写。
function tc_default_agreement_html() {
    return '<h3>一、协议的接受</h3>'
        . '<p>欢迎使用本平台。在使用本平台前，请你仔细阅读并充分理解本协议的全部内容。'
        . '当你勾选同意、注册账号或以其他方式使用本平台服务时，即表示你已阅读、理解并同意接受本协议的全部条款。'
        . '如你不同意本协议的任何内容，请停止注册或使用本平台。</p>'
        . '<h3>二、账号注册与安全</h3>'
        . '<p>你在注册时应提供真实、准确、完整的必要信息，并及时更新。你应妥善保管账号与密码，'
        . '对通过你的账号进行的一切操作负责。如发现账号被他人非法使用，请立即通知本平台。</p>'
        . '<h3>三、用户行为规范</h3>'
        . '<p>你承诺遵守中华人民共和国法律法规及本平台的相关规则。使用本平台时，你不得从事或协助他人从事下列行为：</p>'
        . '<ol>'
        . '<li>发布、传播法律法规禁止的信息，或侵犯他人合法权益的内容；</li>'
        . '<li>利用本平台从事欺诈、骚扰、赌博、传播恶意程序等违法活动；</li>'
        . '<li>通过自动化程序或技术手段恶意请求、抓取、攻击本平台，影响服务的正常运行；</li>'
        . '<li>未经许可收集、存储、使用他人的个人信息；</li>'
        . '<li>其他违反法律法规、公序良俗或本平台规则的行为。</li>'
        . '</ol>'
        . '<h3>四、人工智能生成内容</h3>'
        . '<p>本平台的输出由人工智能模型生成，可能存在不准确、不完整或不符合预期的情况，仅供你参考，'
        . '不构成任何专业建议。你在使用生成内容前应自行核实，并对据此作出的判断与决定自行承担责任。</p>'
        . '<h3>五、内容与知识产权</h3>'
        . '<p>你对自己依法享有权利的内容保留相应权利，并应保证所提交的内容未侵犯任何第三方的合法权益。'
        . '本平台的界面、标识、程序及相关文档等知识产权归本平台或相应权利人所有。</p>'
        . '<h3>六、隐私与数据保护</h3>'
        . '<p>本平台重视你的个人信息保护，仅在提供与改进服务所必需的范围内处理相关信息，'
        . '并采取合理的技术与管理措施保障数据安全。具体处理规则以本平台的隐私说明为准。</p>'
        . '<h3>七、服务变更、中断与终止</h3>'
        . '<p>本平台可能因升级、维护、故障或不可抗力等原因变更、中断或终止部分或全部服务，并将尽合理努力提前通知。'
        . '对于因此造成的不便或损失，本平台在法律允许的范围内不承担责任。'
        . '如你违反本协议或相关规则，本平台有权视情节采取警示、限制功能、暂停或终止账号等措施。</p>'
        . '<h3>八、免责声明</h3>'
        . '<p>在法律允许的最大范围内，本平台不对服务的绝对稳定、无差错或满足你的特定用途作出保证。'
        . '对于因不可抗力、第三方原因或非本平台过错导致的服务中断或数据丢失，本平台不承担责任。</p>'
        . '<h3>九、协议的修改</h3>'
        . '<p>本平台有权根据法律法规变化或运营需要修改本协议，并以适当方式公布。修改后的协议自公布之日起生效。'
        . '若你继续使用本平台，即视为接受修改后的协议。</p>'
        . '<h3>十、其他</h3>'
        . '<p>本协议的解释与争议解决适用中华人民共和国法律。本协议部分条款如被认定无效或不可执行，'
        . '不影响其他条款的效力。本协议自公布之日起生效。</p>';
}

$TC_SETTINGS_DEFAULTS = array(
    'siteName' => 'TinyChat',
    'allowRegister' => true,
    'freeQuota' => 100,
    'freeQuotaUnlimited' => false,
    'allowUserProviders' => true,
    'emailVerificationEnabled' => false,
    'passwordResetEnabled' => false,
    'smtp' => array(),
    'mailTemplates' => null, // 下面统一赋值,避免默认数组里塞大段 HTML
    'packages' => array(),
    'proxyTimeoutMs' => 120000,
    // 出站 HTTP 代理(如 http://127.0.0.1:2080)。留空=直连。
    // 拉取 litellm 价格表等外部资源时用;国内网络直连 raw.githubusercontent.com
    // 常在中途卡死(下到约 1MB 就停滞),走代理可稳定完成。
    'outboundProxy' => '',
    'loginMaxFails' => 5,
    'loginLockMs' => 60000,
    // 第三方一键登录:每个提供商的开关与凭据;开启且填全后前台登录页出现对应图标
    'oauthProviders' => array(),
    // 第三方登录时若未绑定过本站账号,是否自动建号(关闭则提示先注册并绑定)
    'oauthAutoRegister' => true,
    // 自动建号/首次绑定后是否强制补全用户名与密码(补全后即可脱离第三方用密码登录)
    'oauthRequireProfile' => false,
    // 默认开启联网搜索:默认检索源用 DuckDuckGo(免 Key、无需配置即可用)
    'webSearchEnabled' => true,
    'webSearchProvider' => 'ddg',
    'webSearchTavilyKey' => '',
    'webSearchBraveKey' => '',
    'webSearchJinaKey' => '',
    'webSearchSearxUrl' => '',
    'webSearchMaxResults' => 5,
    'webSearchAllowUser' => false,
    'urlReadEnabled' => true,
    'urlReadMax' => 3,
    'mineruToken' => '',
    'mineruAllowUser' => false,
    'paddleOcrUrl' => '',
    'paddleOcrKey' => '',
    'mistralOcrKey' => '',
    'parseChannels' => array('pdf' => 'mineru', 'image' => 'mineru', 'office' => 'mineru'),
    'defaultGroupId' => '',
    'contextMessages' => 12,
    'maxContextMessages' => 200,
    // 说明:单次输出上限与上下文窗口不再有全局设置,统一由「模型元数据」表按模型名控制
    // (见 $TC_MODEL_META_AUTO_* 常量与该表的 ensure/取数逻辑)。
    // 全局采样温度: null = 不发送该参数(用模型默认);设置后 0-2
    'temperature' => null,
    // 数据备份:每日自动备份整库快照到 data/backup/,保留最近 N 份
    'backupEnabled' => true,
    'backupKeep' => 7,
    // 代理接口限流:每用户每分钟最大请求数,0 = 不限制
    'rateLimitPerMin' => 30,
    // 会话:登录态有效天数;authEpoch 递增可强制全站重新登录
    'sessionDays' => 7,
    'authEpoch' => 1,
    // 从上游 context length 报错自动回填模型的 maxContext(不覆盖手动设置)
    'contextAutoLearn' => true,
    // 模型可用性显示阈值(%):成功率 ≥ healthOkMin 显示「良好」,≥ healthWarnMin 显示「一般」,低于则「较差」
    'healthOkMin' => 75,
    'healthWarnMin' => 40,
    // 内容审核:发送前对用户消息做敏感词过滤
    'moderation' => array('enabled' => false, 'words' => ''),
    // 用户协议:启用后注册页需勾选同意,/agreement 展示协议正文
    'agreementEnabled' => false,
    'agreementHtml' => '',
    // 隐私:关闭后服务器不保存对话记录(客户端仅本地留存)
    'persistChats' => true,
    // 用户设置云同步:开启后用户的偏好/外观/群聊配置等随账号同步,换设备无需重新设置
    'syncSettings' => true,
    // 开放 API 调用记录到用户的对话列表(前台可见,便于集中查看与配密钥;需 persistChats 开启)
    'apiSaveChats' => true,
    // 全站公告:enabled 且 text 非空时前台展示
    'announcement' => array('enabled' => false, 'text' => '', 'updatedAt' => 0),
    // OpenAI 兼容 API 出口:允许用户生成 sk- 密钥通过第三方客户端调用
    'apiKeysEnabled' => true,
    // API 密钥(开放接口)限流:每把密钥每分钟最大请求数,0 = 不限制
    'apiKeyRateLimitPerMin' => 60,
    // 开放接口对外暴露的模型白名单,元素形如 "providerId|modelId";为空数组表示全部可用模型
    'apiExposedModels' => array(),
    // 演示模式:演示管理员修改的设置将在演示有效期后自动还原
    'demoMode' => false,
    'demoExpireMinutes' => 10,
    // 游客模式:允许未登录访客直接体验对话;每个访客自动生成独立账号并归入游客组
    'guestEnabled' => false,
    // 游客可进行的有效对话轮数(每轮 1 次调用),新游客账号按此发放额度
    'guestRounds' => 3,
    // 注册邀请码:开启后注册必须提供有效邀请码
    'registerInviteRequired' => false,
    // 注册限流:每 IP 每小时最大注册尝试次数
    'registerLimitPerHour' => 5,
    // 账号注销:用户可自行注销账号
    //   off   = 不允许注销
    //   soft  = 软注销:清空资料并改名为「原名-已注销-xxxx」「邮箱+已注销」,邮箱/用户名可被重新注册
    //   hard  = 硬注销:直接删除账号及其对话、自建供应商等全部数据
    'accountDeletionMode' => 'soft',
    // 性能优化(默认关闭,开启后减少前台加载体积;改动在用户下次访问时生效)
    // 不加载内置网页字体(思源宋体/阿里巴巴普惠体等,合计约 19MB);不加载 KaTeX 公式渲染;
    // 不加载代码高亮 highlight.js;不加载 Mermaid 图表。
    'perfNoWebfonts' => false,
    'perfNoKatex' => false,
    'perfNoHighlight' => false,
    'perfNoMermaid' => false,
    // 生图结果本地留存(默认开启):出图后即时把图片下载并存到本站 data/,
    // 避免上游图床链接过期导致历史图打不开。
    'imageArchiveEnabled' => true,
    // 本地留存总量上限(MB),超出按最旧优先清理
    'imageArchiveQuotaMb' => 500,
    // ---- AI 笔记 ----
    // 笔记功能总开关(关闭后前台入口隐藏、接口拒绝)
    'notesEnabled' => true,
    // 每用户笔记附件空间上限(MB),0 = 不限;用户侧边栏左下角显示剩余
    'notesQuotaMb' => 200,
    // 单个附件大小上限(MB);图片另有独立上限(固定 10MB)
    'notesMaxFileMb' => 50,
    // 允许普通用户上传非图片附件(关闭后仅图片可传)
    'notesAllowFiles' => true,
    // 分享链接仅包含正文(默认开启):分享出去的内容只有标题、正文与标签,
    // 正文里的图片/附件引用会被移除,附件也不随分享暴露。
    // 关闭后分享页同样能看正文内引用的图片与附件。
    'notesShareBodyOnly' => true,
    // 笔记内 AI 编辑(右键扩写/总结/翻译等)每日每用户次数上限,0 = 不限。
    // 单次调用仍照常扣减用户额度(走 _purpose=note-edit 的标准计费通道)。
    'notesAiDailyLimit' => 50,
    // 允许用户自定义右键菜单的动作(关闭后固定为内置五项,齿轮只读)
    'notesAiCustomizable' => true,
    // 笔记图片附件单文件上限(MB)——此前写死 10MB,收进后台设置
    'notesMaxImageMb' => 10,
    // ---- 在线聊天(IM) ----
    // 好友/单聊/群聊总开关(关闭后前台入口隐藏、接口拒绝)
    'imEnabled' => true,
    // 每用户空间上限(MB),0 = 不限;聊天附件独立存放在 data/im/{uid}/,不占笔记配额
    'imQuotaMb' => 500,
    // 聊天单文件大小上限(MB,非图片)
    'imMaxFileMb' => 20,
    // 聊天图片单文件上限(MB)
    'imMaxImageMb' => 10,
    // 允许在聊天中发送非图片文件(关闭后仅图片)
    'imAllowFiles' => true,
    // 「召唤 AI」每用户每日次数上限(消息以 AI 开头或会话开启 AI 模式时计数),0 = 不限
    'imAiDailyLimit' => 50,
    // 好友搜索可见性:普通用户始终能搜到管理员与「对所有人可见」名单里的用户
    'imVisibleUsers' => array(),
    // 所有人默认互为好友:开启后注册用户之间无需添加即可直接聊天(虚拟关系)
    'imMutualFriends' => false,
    // ---- 在线浏览器(服务端反向代理) ----
    // 总开关(关闭后前台入口隐藏、代理接口与票据一律拒绝)。
    // 注意:开启后本机出网会被用户用来访问任意公网站点,出口 IP 与流量算在本站账上。
    'browserEnabled' => true,
    // 网页 AI 总结每用户每日次数上限(0 = 不限);单次调用仍照常扣减用户额度
    'webAiDailyLimit' => 50,
    // 浏览器主页收藏夹:留空用内置默认(Google 学术/arXiv/PubMed/…),配置后覆盖默认
    'webBookmarks' => array(),
    // 仅允许访问「解析到中国 IP」的网站(默认开启)。
    // 动机:代理出网走的是本站服务器,境外站点的滥用/合规风险与流量都记在本站账上;
    // 限制成国内站后,「看国内资料」这个主要用途不受影响,风险面小很多。
    'webCnOnly' => true,
    // 开了「仅限中国 IP」时,是否放行「页面主站是国内、但子资源域名解析到境外」的资源。
    // 必须默认开启:国内大站的静态资源常走海外 CDN(实测百度首页会引用 ir.baidu.com,
    // 它解析到 Akamai 的 23.206.26.151),按「每个域名各自判归属」会把首页图片/脚本打掉,
    // 用户看到的就是「百度都打不开」。判定改为:导航请求(整页)按中国 IP 严格判,
    // 子资源只要它的**来源页**是中国站就放行(见 tc_web_fetch 的 originCn 参数)。
    'webCnAllowAssets' => true,
    // 在线浏览器每用户每日出网流量上限(MB,0 = 不限)。代理抓取的字节都算在本站出口,
    // 这里按用户记账:同一用户当天抓取的字节(含页面与全部子资源)超过上限即拒绝。
    'webDailyTrafficMb' => 500,
    // 单页面子资源并发抓取上限(1 = 串行)。调大能让重图片的页面更快出来,
    // 但并发出网会同时占用多个连接与内存,虚拟主机上不宜过高。
    'webConcurrency' => 6,
    // ---- 在线工具箱(用户自存的 HTML 单页) ----
    // 总开关(关闭后前台入口隐藏、接口一律拒绝)。
    // 存的是用户自己写的 HTML,打开时在**不透明源**的沙箱里运行,读不到本站登录态;
    // 数量与体积上限见 TC_TOOLBOX_MAX_* 常量。
    'toolboxEnabled' => true,
);
$TC_SETTINGS_DEFAULTS['mailTemplates'] = tc_mail_default_templates();
// 三个拓展功能的访问级别(全站 / 仅管理员 / 仅名单)与名单
require_once __DIR__ . '/features.php';
$TC_SETTINGS_DEFAULTS = array_merge($TC_SETTINGS_DEFAULTS, tc_feature_access_defaults());

function tc_load_config() {
    // 环境变量只在「已设置且非空」时才算数:未设置的值不能把 config.php 里的配置抹掉。
    $env = array();
    foreach (array('admin_name', 'admin_password', 'jwt_secret', 'cors_origin', 'data_dir', 'site_url', 'timezone') as $k) {
        $v = getenv(strtoupper($k));
        if ($v !== false && $v !== '') $env[$k] = $v;
    }
    // 站点是否部署在反向代理(Nginx/CDN/宝塔)之后:
    // 只有设为 1 时才信任 X-Forwarded-For 取真实客户端 IP;
    // 默认 false——直连部署下该头可被任意伪造,会绕过注册/游客/找回密码的按 IP 限流
    if (getenv('TRUST_PROXY') !== false) $env['trust_proxy'] = getenv('TRUST_PROXY') === '1';

    $cfg = array(
        'admin_name' => 'admin',
        'admin_password' => '',
        'jwt_secret' => '',
        'cors_origin' => '*',
        'data_dir' => '',
        'site_url' => '',
        'timezone' => '',
        'trust_proxy' => false,
    );
    $file = TC_ROOT . '/config.php';
    if (is_file($file)) {
        $user = include $file;
        if (is_array($user)) $cfg = array_merge($cfg, $user);
    }
    // 文档承诺「环境变量优先于 config.php」,所以环境变量最后合并。
    // 反过来的话,容器里改 ADMIN_PASSWORD 会被镜像内残留的 config.php 静默顶掉。
    return array_merge($cfg, $env);
}

function tc_cfg($key = null) {
    static $cfg = null;
    if ($cfg === null) $cfg = tc_load_config();
    if ($key === null) return $cfg;
    return isset($cfg[$key]) ? $cfg[$key] : null;
}

function tc_data_dir() {
    $dir = tc_cfg('data_dir');
    if (!$dir) $dir = TC_ROOT . '/data';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

function tc_cacert_path() {
    static $path = null;
    if ($path !== null) return $path;
    $candidates = array(
        TC_ROOT . '/lib/cacert.pem',
        ini_get('curl.cainfo'),
        ini_get('openssl.cafile'),
        getenv('SSL_CERT_FILE'),
        getenv('CURL_CA_BUNDLE'),
    );
    foreach ($candidates as $c) {
        if ($c && is_file($c) && is_readable($c)) {
            $path = $c;
            return $path;
        }
    }
    $path = '';
    return $path;
}

// 出站代理地址。优先级:环境变量 TC_OUTBOUND_PROXY > 显式设置的值(由 tc_with_db 内取好)。
// 之所以不做成「这里直接查库」:tc_with_db 结束会释放全局 db,而同步流程里网络请求
// 刻意放在事务之外(不占写锁),那时已经没有 db 可读,必须提前把值带出来。
function tc_outbound_proxy() {
    static $proxy = null;
    if ($proxy !== null) return $proxy;
    $env = trim((string) getenv('TC_OUTBOUND_PROXY'));
    if ($env !== '' && preg_match('#^(https?|socks5h?)://[^\s]{1,300}$#i', $env)) { $proxy = $env; return $proxy; }
    $proxy = '';
    if (!isset($GLOBALS['_tc_outbound_proxy'])) return $proxy;
    $v = trim((string) $GLOBALS['_tc_outbound_proxy']);
    if ($v !== '' && preg_match('#^(https?|socks5h?)://[^\s]{1,300}$#i', $v)) $proxy = $v;
    return $proxy;
}

// 时区:全站有若干处用 date()(备份文件名、导出文件名、笔记 AI 每日配额的分界)。
// 不显式设置时取主机 php.ini 的值,很多镜像/虚拟主机默认 UTC —— 表现为
// 备份名与站点本地时间差 8 小时、每日配额在北京时间早上 8 点而非 0 点重置。
// 顺序很关键:必须在任何 date() 调用之前生效。
function tc_apply_timezone() {
    static $done = false;
    if ($done) return;
    $done = true;
    $tz = trim((string) tc_cfg('timezone'));
    if ($tz === '') $tz = 'Asia/Shanghai';   // 面向中文用户,给一个符合直觉的默认值
    if (@date_default_timezone_set($tz)) return;
    @date_default_timezone_set('Asia/Shanghai');   // 配置写了无效时区也不至于退回 UTC
}
tc_apply_timezone();

function tc_now() {
    return (int) round(microtime(true) * 1000);
}

// 站点对外基址。用于生成重置密码/验证邮件里的链接,所以「谁来决定这个域名」很关键:
// Host 头由请求方自由填写,直接采信等于让攻击者把受害者引到他自己的域名上收 token
// (伪造 Host 发一封找回密码请求,受害者点到的就是攻击者站)。
// 因此:优先用配置的 site_url;否则只在 Host 与本机 SERVER_NAME 一致时采信它
// (一致才说明没有被伪造,同时能保留 Host 里的端口),不一致就退回 SERVER_NAME + SERVER_PORT。
function tc_public_base_url() {
    $configured = trim((string) tc_cfg('site_url'));
    if ($configured !== '') return rtrim($configured, '/');
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $clean = function ($h) { return preg_replace('/[^A-Za-z0-9.:-]/', '', (string) $h); };
    $serverName = $clean(isset($_SERVER['SERVER_NAME']) ? $_SERVER['SERVER_NAME'] : '');
    $httpHost = $clean(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '');
    // Host 里的主机名部分与 SERVER_NAME 相同(仅大小写/端口可能不同)才认它
    $httpHostName = preg_replace('/:\d+$/', '', $httpHost);
    if ($httpHost !== '' && ($serverName === '' || strcasecmp($httpHostName, $serverName) === 0)) {
        $safeHost = $httpHost;
    } else {
        $safeHost = $serverName;
        // SERVER_NAME 不带端口:非默认端口要从 SERVER_PORT 补回来,
        // 否则站点跑在 :8099 这类端口时,邮件里的链接会指向默认端口而打不开。
        $port = isset($_SERVER['SERVER_PORT']) ? (int) $_SERVER['SERVER_PORT'] : 0;
        if ($port > 0 && !in_array($port, array(80, 443), true)) $safeHost .= ':' . $port;
    }
    if ($safeHost === '') $safeHost = 'localhost';
    $script = str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '/'));
    $script = rtrim($script, '/');
    return $scheme . '://' . $safeHost . ($script === '/' ? '' : $script);
}

function tc_public_link($path, $token) {
    return tc_public_base_url() . '/' . ltrim($path, '/') . '?token=' . rawurlencode($token);
}

// 测试/自建环境的例外开关:置 1 时允许上游指向内网(如 E2E 用 127.0.0.1 的 mock 上游)。
// 与 TC_PAGE_FETCH_BASE 等测试钩子同一约定——只能由部署者通过环境变量开启,
// 不来自任何请求内容,所以不会成为绕过 SSRF 防线的口子。生产环境不要设置。
function tc_upstream_allow_private() {
    $v = strtolower(trim((string) getenv('TC_ALLOW_PRIVATE_UPSTREAM')));
    return $v === '1' || $v === 'true' || $v === 'yes' || $v === 'on';
}

// 供应商 Base URL 的出站目标校验(SSRF 防线)。
// 供应商地址由用户自行填写,服务端却会带着自己的网络身份去请求它:不拦住内网目标,
// 等于把「读内网服务」的能力交给任何能填供应商的人(云上 169.254.169.254 更直接)。
// 只允许 http/https + 常见端口,且所有解析结果都必须是公网地址。
// 写入时与请求时都会校验,避免旧数据绕过。
function tc_upstream_url_is_safe($url) {
    $p = @parse_url((string) $url);
    if (!is_array($p) || empty($p['host'])) return false;
    // 端口与协议限制对内网 mock 同样适用,所以放在例外开关之前判断
    $scheme = strtolower(isset($p['scheme']) ? $p['scheme'] : '');
    if ($scheme !== 'http' && $scheme !== 'https') return false;
    $port = isset($p['port']) ? (int) $p['port'] : ($scheme === 'https' ? 443 : 80);
    // 测试/自建例外:允许任意端口与内网地址(E2E 的 mock 上游跑在 127.0.0.1:8100)
    if (tc_upstream_allow_private()) {
        if (isset($p['user']) || isset($p['pass'])) return false;
        return trim((string) $p['host']) !== '';
    }
    if (!in_array($port, array(80, 443, 8080, 8443), true)) return false;
    // 带用户信息的 URL(user:pass@host)会让主机判断失真,直接拒绝
    if (isset($p['user']) || isset($p['pass'])) return false;
    $host = trim(strtolower((string) $p['host']), '[]');
    if ($host === '' || $host === 'localhost') return false;
    if (preg_match('/\.(local|internal|intranet|lan|home\.arpa|arpa)$/i', $host)) return false;
    $ipOk = function ($ip) {
        return is_string($ip) && $ip !== ''
            && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    };
    $ips = array();
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips[] = $host;
    } else {
        foreach ((array) @gethostbynamel($host) as $ip) $ips[] = $ip;
        if (!$ips && function_exists('dns_get_record')) {
            foreach ((array) @dns_get_record($host, DNS_AAAA) as $rec) {
                if (!empty($rec['ipv6'])) $ips[] = $rec['ipv6'];
            }
        }
    }
    if (!$ips) return false;
    // 任一解析结果是内网/保留地址就拒绝:DNS 轮询可能让校验与请求落到不同 IP
    foreach ($ips as $ip) if (!$ipOk($ip)) return false;
    return true;
}

function tc_uid($len = 16) {
    return bin2hex(random_bytes($len));
}

function tc_today_key($ms = null) {
    $t = $ms ? (int) floor($ms / 1000) : time();
    return date('Y-m-d', $t);
}

function tc_b64url($bin) {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function tc_b64url_decode($str) {
    $b = strtr((string) $str, '-_', '+/');
    $pad = strlen($b) % 4;
    if ($pad) $b .= str_repeat('=', 4 - $pad);
    return base64_decode($b);
}

// 把可能是非法 UTF-8 的文本转成合法 UTF-8。
// 典型来源:中文邮件服务商(QQ/163 等)用 GBK 回错误描述、部分系统的 strerror 也是本地编码。
// 这类字节直接进 json_encode 会整体编码失败 —— 接口会返回空响应体,前端只能看到
// 「服务器返回了非预期内容」,真实原因被彻底埋掉。
function tc_utf8_clean($s) {
    $s = (string) $s;
    if ($s === '') return '';
    if (preg_match('//u', $s)) return $s; // 已是合法 UTF-8
    if (function_exists('mb_convert_encoding')) {
        $try = @mb_convert_encoding($s, 'UTF-8', 'GBK');
        if (is_string($try) && $try !== '' && preg_match('//u', $try)) return $try;
        $try = @mb_convert_encoding($s, 'UTF-8', 'UTF-8');
        if (is_string($try) && $try !== '' && preg_match('//u', $try)) return $try;
    }
    if (function_exists('iconv')) {
        $try = @iconv('GBK', 'UTF-8//IGNORE', $s);
        if (is_string($try) && $try !== '' && preg_match('//u', $try)) return $try;
    }
    // 兜底:把非法字节替换掉,宁可损失个别字符也不能让整个响应编码失败
    $out = preg_replace('/[\x80-\xFF]/', '?', $s);
    return is_string($out) ? $out : '';
}

function tc_json_encode($obj) {
    // JSON_INVALID_UTF8_SUBSTITUTE:个别非法字节只替换成 U+FFFD,不让整个响应变成空体。
    // 这是全站兜底——任何来源(上游错误、系统 strerror、用户输入)的脏字节都不该让接口失联。
    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    $json = json_encode($obj, $flags);
    if ($json === false) {
        // 极端情况(递归/资源/超深结构):退化成一条可读的错误,也不要返回空体
        $json = json_encode(array('error' => array('message' => '响应内容无法编码', 'detail' => tc_utf8_clean(json_last_error_msg()))),
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    return $json === false ? '{"error":{"message":"响应编码失败"}}' : $json;
}

// AI 思考策略:全局默认 + 按模型规则(自动学习/手动配置),保证各上游都能接受推理参数
function tc_normalize_thinking($raw) {
    $t = is_array($raw) ? $raw : array();
    $efforts = array('off', 'low', 'medium', 'high');
    $def = isset($t['defaultEffort']) && in_array($t['defaultEffort'], $efforts, true) ? $t['defaultEffort'] : 'medium';
    $rules = array();
    foreach ((array) (isset($t['rules']) ? $t['rules'] : array()) as $r) {
        if (!is_array($r)) continue;
        $match = substr(trim((string) (isset($r['match']) ? $r['match'] : '')), 0, 80);
        if ($match === '') continue;
        $mode = (isset($r['mode']) && in_array($r['mode'], array('map', 'force', 'off'), true)) ? $r['mode'] : 'map';
        $levels = array();
        foreach ((array) (isset($r['levels']) ? $r['levels'] : array()) as $lv) {
            $lv = strtolower(trim((string) $lv));
            if (in_array($lv, array('minimal', 'none', 'low', 'medium', 'high', 'max'), true) && !in_array($lv, $levels, true)) $levels[] = $lv;
        }
        $force = strtolower(trim((string) (isset($r['forceEffort']) ? $r['forceEffort'] : '')));
        $rules[] = array(
            'id' => substr(trim((string) (isset($r['id']) ? $r['id'] : '')), 0, 24) ?: tc_uid(8),
            'match' => $match,
            'mode' => $mode,
            'levels' => $levels,
            'forceEffort' => in_array($force, array('low', 'medium', 'high', 'max'), true) ? $force : '',
            'enabled' => !array_key_exists('enabled', $r) || !empty($r['enabled']),
            'source' => ((isset($r['source']) ? $r['source'] : 'manual') === 'auto') ? 'auto' : 'manual',
            'updatedAt' => (int) (isset($r['updatedAt']) ? $r['updatedAt'] : tc_now()),
        );
    }
    return array(
        'defaultEffort' => $def,
        'allowUserOverride' => !array_key_exists('allowUserOverride', $t) || !empty($t['allowUserOverride']),
        'autoLearn' => !array_key_exists('autoLearn', $t) || !empty($t['autoLearn']),
        'rules' => $rules,
    );
}

// 档位序(从轻到重);取离当前档位最近的受支持档位,优先向上取
function tc_nearest_effort($cur, $levels) {
    $order = array('minimal', 'none', 'low', 'medium', 'high', 'max');
    $idx = array_search(strtolower((string) $cur), $order, true);
    if ($idx === false) return (string) $levels[0];
    for ($i = $idx + 1; $i < count($order); $i++) if (in_array($order[$i], $levels, true)) return $order[$i];
    for ($i = $idx - 1; $i >= 0; $i--) if (in_array($order[$i], $levels, true)) return $order[$i];
    return (string) $levels[0];
}

function tc_thinking_effort_set(&$body, $value) {
    if (array_key_exists('reasoning_effort', $body)) $body['reasoning_effort'] = $value;
    if (array_key_exists('thinking_effort', $body)) $body['thinking_effort'] = $value;
    if (isset($body['reasoning']) && is_array($body['reasoning']) && array_key_exists('effort', $body['reasoning'])) $body['reasoning']['effort'] = $value;
    if (isset($body['output_config']) && is_array($body['output_config']) && array_key_exists('effort', $body['output_config'])) $body['output_config']['effort'] = $value;
}

// 请求发出前套用思考策略:规则匹配模型 ID(包含匹配),首个命中的生效
// 规则:off=移除推理参数;force=强制档位;map=当前档位不在支持列表内时就近修正
// 无规则命中时:若管理员关闭了"用户自选",统一改写为全局默认档位
function tc_apply_thinking_rules(&$body, $thinking) {
    $model = strtolower((string) (isset($body['model']) ? $body['model'] : ''));
    if ($model === '' || !is_array($thinking)) return;
    $rules = is_array(isset($thinking['rules']) ? $thinking['rules'] : null) ? $thinking['rules'] : array();
    foreach ($rules as $rule) {
        if (empty($rule['enabled'])) continue;
        $match = strtolower((string) (isset($rule['match']) ? $rule['match'] : ''));
        if ($match === '' || strpos($model, $match) === false) continue;
        $mode = isset($rule['mode']) ? $rule['mode'] : 'map';
        if ($mode === 'off') {
            tc_strip_reasoning_params($body, array('enable_thinking', 'reasoning_effort', 'thinking_effort', 'thinking', 'reasoning', 'output_config'));
            return;
        }
        if ($mode === 'force') {
            $force = (string) (isset($rule['forceEffort']) ? $rule['forceEffort'] : '');
            if ($force !== '') tc_thinking_effort_set($body, $force);
            return;
        }
        $levels = is_array(isset($rule['levels']) ? $rule['levels'] : null) ? array_map('strtolower', $rule['levels']) : array();
        if (!$levels) return;
        foreach (array('reasoning_effort', 'thinking_effort') as $key) {
            if (array_key_exists($key, $body) && !in_array(strtolower((string) $body[$key]), $levels, true)) $body[$key] = tc_nearest_effort($body[$key], $levels);
        }
        if (isset($body['reasoning']) && is_array($body['reasoning']) && array_key_exists('effort', $body['reasoning']) && !in_array(strtolower((string) $body['reasoning']['effort']), $levels, true)) {
            $body['reasoning']['effort'] = tc_nearest_effort($body['reasoning']['effort'], $levels);
        }
        if (isset($body['output_config']) && is_array($body['output_config']) && array_key_exists('effort', $body['output_config']) && !in_array(strtolower((string) $body['output_config']['effort']), $levels, true)) {
            $body['output_config']['effort'] = tc_nearest_effort($body['output_config']['effort'], $levels);
        }
        return;
    }
    if (empty($thinking['allowUserOverride'])) {
        $def = (string) (isset($thinking['defaultEffort']) ? $thinking['defaultEffort'] : 'medium');
        if ($def === 'off') tc_strip_reasoning_params($body, array('enable_thinking', 'reasoning_effort', 'thinking_effort', 'thinking', 'reasoning', 'output_config'));
        else tc_thinking_effort_set($body, $def);
    }
}

// ---- 模型元数据:上下文窗口与价格 ----
// litellm 维护的公开价格表:一份 JSON 覆盖数千模型,字段含窗口与各类单价。
define('TC_LITELLM_PRICES_URL', 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json');

// 把 litellm 的原始条目映射成本项目的字段;无任何有效数值则返回 null
function tc_litellm_map_item($row) {
    if (!is_array($row)) return null;
    $pick = function ($key) use ($row) {
        if (!isset($row[$key]) || !is_numeric($row[$key])) return 0;
        $n = (float) $row[$key];
        return $n > 0 ? $n : 0;
    };
    // max_output_tokens 是较新字段;旧条目只有 max_tokens(语义为"单次输出上限")
    $maxIn = (int) $pick('max_input_tokens');
    $maxOut = (int) $pick('max_output_tokens');
    if ($maxOut <= 0) $maxOut = (int) $pick('max_tokens');
    $pIn = $pick('input_cost_per_token');
    $pOut = $pick('output_cost_per_token');
    $cRead = $pick('cache_read_input_token_cost');
    $cWrite = $pick('cache_creation_input_token_cost');
    if ($maxIn <= 0 && $maxOut <= 0 && $pIn <= 0 && $pOut <= 0 && $cRead <= 0 && $cWrite <= 0) return null;
    return array(
        'maxInputTokens' => $maxIn,
        'maxOutputTokens' => $maxOut,
        'inputCostPerToken' => $pIn,
        'outputCostPerToken' => $pOut,
        'cacheReadCostPerToken' => $cRead,
        'cacheWriteCostPerToken' => $cWrite,
        'provider' => (string) (isset($row['litellm_provider']) ? $row['litellm_provider'] : ''),
        'mode' => (string) (isset($row['mode']) ? $row['mode'] : ''),
        'source' => 'litellm',
        'enabled' => true,
        'updatedAt' => tc_now(),
    );
}

// 一组数值里取众数(出现次数最多的值)。用于合并同一模型在各平台的价格:
// 多数平台报同一个价时,它比「取第一条」可靠得多 —— 例如 deepseek-v4.1-flash
// 有 8 个来源,5 家报 0.30/1.20,只有 sail 报 0.15/0.60,取众数即得主流价。
// 数值先按有效位归一(避免浮点尾差被当成两个值)。
//
// 众数并列时(600 个多来源模型里有 136 个是各方报价两两不同,根本没有众数)
// 退化为「最近邻聚类」:在报价里找一个簇,使 25% 相对误差内的邻居最多,取该簇均值。
// 这比取最小值稳 —— claude-4-opus 三家报 1.65E-5 / 1.5E-5 / 5E-6(促销价),
// 取最小会落到 5E-6 的促销价,聚类则落在前两家的 1.575E-5 上。
// 开权重模型(llama/mixtral)各家报价本就相近,聚类均值同样合理。
function tc_mode_number($values) {
    $counts = array();
    $raw = array();
    $vals = array();
    foreach ($values as $v) {
        if (!is_numeric($v)) continue;
        $n = (float) $v;
        if ($n <= 0) continue; // 0 表示未配置,不参与投票
        $key = sprintf('%.10g', $n);
        $counts[$key] = (isset($counts[$key]) ? $counts[$key] : 0) + 1;
        $raw[$key] = $n;
        $vals[] = $n;
    }
    if (!$counts) return 0;
    $best = null; $bestN = -1;
    foreach ($counts as $key => $n) {
        if ($n > $bestN) { $best = $raw[$key]; $bestN = $n; }
    }
    if ($bestN > 1) return (float) $best; // 有唯一众数,直接采用
    // 全体并列(每个值只出现一次):最近邻聚类,取最大簇的均值
    sort($vals);
    $pick = null; $pickSize = 0;
    foreach ($vals as $c) {
        $size = 0; $sum = 0;
        foreach ($vals as $x) {
            if (abs($x - $c) <= 0.25 * max($c, $x)) { $size++; $sum += $x; }
        }
        if ($size > $pickSize || ($size === $pickSize && $pick !== null && $c > $pick)) {
            $pickSize = $size; $pick = $sum / $size;
        }
    }
    return $pick === null ? (float) $best : (float) $pick;
}

// 文本字段取众数(如 mode):同名字段里出现最多的值,并列时取字典序最小的,保证可复现
function tc_mode_string($values) {
    $counts = array();
    foreach ($values as $v) {
        $v = (string) $v;
        if ($v === '') continue;
        $counts[$v] = (isset($counts[$v]) ? $counts[$v] : 0) + 1;
    }
    if (!$counts) return '';
    $best = ''; $bestN = -1;
    foreach ($counts as $v => $n) {
        if ($n > $bestN || ($n === $bestN && strcmp($v, $best) < 0)) { $best = $v; $bestN = $n; }
    }
    return $best;
}

// 把 litellm 的整份 JSON 压成「短名 -> 条目」表。
// 键有三类形态:裸名(gpt-4o)、单前缀(azure/gpt-4o)、多前缀(openrouter/openai/gpt-4o)。
// 用户填的模型名通常不带前缀,故取最后一段做短名。
//
// 同名合并策略 —— 逐字段取众数,而不是挑某一条:
// 上游价格表的同一个模型会挂在各家平台上(deepseek-v4.1-flash 有 8 个来源),
// 各平台报价未必一致(渠道加价、批量价、汇率)。早期实现「优先裸名、否则取第一条」
// 会撞上离群便宜的那条(实测取到了 sail 的半价,而 5 家主流平台都是另一个价)。
// 按字段投票能稳定落在多数平台一致的值上,单个离群来源无法左右结果。
// 每个数值字段各自投票 —— 某平台缺某个价格时不会拖累其它字段,缺的字段自动由其他来源补。
// 各方报价两两不同(无众数)时,以裸名条目兜底,见 tc_mode_number。
function tc_litellm_index($raw) {
    $groups = array();
    foreach ((array) $raw as $name => $row) {
        $name = (string) $name;
        if ($name === '') continue;
        $mapped = tc_litellm_map_item($row);
        if ($mapped === null) continue;
        $pos = strrpos($name, '/');
        $short = tc_model_meta_key($pos === false ? $name : substr($name, $pos + 1));
        if ($short === '' || strlen($short) > 200) continue;
        if (!isset($groups[$short])) $groups[$short] = array();
        $mapped['provider'] = (string) $mapped['provider'];
        $groups[$short][] = $mapped;
    }
    $out = array();
    foreach ($groups as $short => $items) {
        if (count($items) === 1) { $out[$short] = $items[0]; continue; }
        $col = function ($field) use ($items) {
            $v = array();
            foreach ($items as $it) $v[] = isset($it[$field]) ? $it[$field] : 0;
            return $v;
        };
        // 窗口与价格逐字段取众数
        $maxIn = (int) round(tc_mode_number($col('maxInputTokens')));
        $maxOut = (int) round(tc_mode_number($col('maxOutputTokens')));
        $pIn = tc_mode_number($col('inputCostPerToken'));
        $pOut = tc_mode_number($col('outputCostPerToken'));
        $cRead = tc_mode_number($col('cacheReadCostPerToken'));
        $cWrite = tc_mode_number($col('cacheWriteCostPerToken'));
        // provider 只是溯源信息,取票数最多的那个;mode 同理
        $providers = array(); $modes = array();
        foreach ($items as $it) { $providers[] = $it['provider']; $modes[] = $it['mode']; }
        $out[$short] = array(
            'maxInputTokens' => $maxIn,
            'maxOutputTokens' => $maxOut,
            'inputCostPerToken' => $pIn,
            'outputCostPerToken' => $pOut,
            'cacheReadCostPerToken' => $cRead,
            'cacheWriteCostPerToken' => $cWrite,
            'provider' => tc_mode_string($providers),
            'mode' => tc_mode_string($modes),
            'source' => 'litellm',
            'enabled' => true,
            'updatedAt' => tc_now(),
        );
    }
    return $out;
}

// 与 litellm 的 model_prices_and_context_window.json 字段对照:
//   max_input_tokens -> maxInputTokens, max_output_tokens -> maxOutputTokens,
//   input_cost_per_token -> inputCostPerToken, output_cost_per_token -> outputCostPerToken,
//   cache_read_input_token_cost -> cacheReadCostPerToken,
//   cache_creation_input_token_cost -> cacheWriteCostPerToken。
// 价格统一按「每 token」存(与 litellm 一致),展示时由前端换算成百万 token。
// source 四态:
//   builtin —— 内置的开箱即用值(见 tc_builtin_model_meta),同步与清空都不动它;
//   manual —— 管理员手工维护,同步不覆盖;
//   litellm —— 从公开价格表同步;
//   auto   —— 模型没匹配到本表时自动补的兜底值,带 needsReview 待人工复核。
function tc_model_meta_key($name) {
    return strtolower(trim((string) $name));
}

// 归一化单条模型元数据;无有效字段时返回 null(调用方据此剔除该条)
function tc_normalize_model_meta_item($raw) {
    if (!is_array($raw)) return null;
    $num = function ($v, $min, $max) {
        if ($v === null || $v === '' || !is_numeric($v)) return 0;
        $n = (float) $v;
        if ($n < 0) return 0;
        return min($max, max($min, $n));
    };
    $input = (int) round($num(isset($raw['maxInputTokens']) ? $raw['maxInputTokens'] : null, 0, 200000000));
    $output = (int) round($num(isset($raw['maxOutputTokens']) ? $raw['maxOutputTokens'] : null, 0, 200000000));
    $pIn = $num(isset($raw['inputCostPerToken']) ? $raw['inputCostPerToken'] : null, 0, 1000);
    $pOut = $num(isset($raw['outputCostPerToken']) ? $raw['outputCostPerToken'] : null, 0, 1000);
    $cRead = $num(isset($raw['cacheReadCostPerToken']) ? $raw['cacheReadCostPerToken'] : null, 0, 1000);
    $cWrite = $num(isset($raw['cacheWriteCostPerToken']) ? $raw['cacheWriteCostPerToken'] : null, 0, 1000);
    if ($input === 0 && $output === 0 && $pIn <= 0 && $pOut <= 0 && $cRead <= 0 && $cWrite <= 0) return null;
    $srcRaw = isset($raw['source']) ? (string) $raw['source'] : '';
    $source = in_array($srcRaw, array('builtin', 'manual', 'auto'), true) ? $srcRaw : 'litellm';
    return array(
        'maxInputTokens' => $input,
        'maxOutputTokens' => $output,
        'inputCostPerToken' => $pIn,
        'outputCostPerToken' => $pOut,
        'cacheReadCostPerToken' => $cRead,
        'cacheWriteCostPerToken' => $cWrite,
        // litellm_provider:上游托管平台标识(bedrock/azure/openrouter…),不是模型厂商。
        // 同一模型常同时出现在多个平台下,仅作数据溯源保留,不对外当「公司」展示。
        'provider' => substr((string) (isset($raw['provider']) ? $raw['provider'] : ''), 0, 60),
        'mode' => substr((string) (isset($raw['mode']) ? $raw['mode'] : ''), 0, 40),
        'source' => $source,
        // 自动补的兜底值需人工复核:管理员确认或编辑后清除该标记
        'needsReview' => $source === 'auto' && !empty($raw['needsReview']),
        // 是否启用:停用的条目不参与窗口计算,但保留数据便于复查
        'enabled' => !array_key_exists('enabled', $raw) || !empty($raw['enabled']),
        'updatedAt' => isset($raw['updatedAt']) && is_numeric($raw['updatedAt']) ? (int) $raw['updatedAt'] : tc_now(),
    );
}

function tc_normalize_model_meta($raw) {
    $out = array();
    foreach (tc_assoc($raw) as $name => $item) {
        $key = tc_model_meta_key($name);
        if ($key === '' || strlen($key) > 200) continue;
        $norm = tc_normalize_model_meta_item($item);
        if ($norm === null) continue;
        $out[$key] = $norm;
        if (count($out) >= 20000) break;
    }
    return $out;
}

// 解析模型名命中的元数据键(唯一匹配入口),找不到返回 null。
//   1) 先精确命中:去空格转小写后与键完全一致;
//   2) 精确没有时做「包含匹配」:渠道常给同一个模型加前缀或后缀
//      (XXX/deepseek-flash、deepseek-flash-2026、deepseek-flash:free),
//      名字里含该键即视为同一模型。
// 包含匹配要求命中处两侧是「非字母数字」边界(串首/串尾、/ - _ . : 空格 等),
// 否则 gpt-4 会把 gpt-4o 抢走 —— 这种误配会静默套用错误的窗口,比不命中更危险。
// 多个键同时被包含时取最长(最具体)的那个,保证 gemini-2.5-flash-lite 不被
// gemini-2.5-flash 截胡;精确键即使已停用也直接返回它(由调用方按 enabled 判定),
// 不再退到更宽的包含匹配上。
function tc_model_meta_resolve($db, $model) {
    if (!isset($db['modelMeta']) || !is_array($db['modelMeta'])) return null;
    $key = tc_model_meta_key($model);
    if ($key === '') return null;
    if (isset($db['modelMeta'][$key])) return $key;
    $best = null; $bestLen = 0;
    foreach (array_keys($db['modelMeta']) as $k) {
        $k = (string) $k;
        $len = strlen($k);
        // 长度下限 2:兼顾 o1/o3 这类短名;单字符键信息量太低,不参与包含匹配
        if ($len < 2 || $len <= $bestLen) continue;
        if (strpos($key, $k) === false) continue;
        if (!preg_match('/(?<![a-z0-9])' . preg_quote($k, '/') . '(?![a-z0-9])/', $key)) continue;
        $best = $k; $bestLen = $len;
    }
    return $best;
}

// 取某模型的元数据;找不到返回 null。$onlyEnabled=true 时忽略已停用条目。
function tc_model_meta_get($db, $model, $onlyEnabled = true) {
    $key = tc_model_meta_resolve($db, $model);
    if ($key === null) return null;
    $item = $db['modelMeta'][$key];
    if ($onlyEnabled && empty($item['enabled'])) return null;
    return $item;
}

// 某模型的输出上限/上下文窗口(唯一取数入口)。
// 元数据表按模型名命中即用其值;未命中(或该侧为 0)时用常量兜底不写库,
// 因此即使表被删空,请求也不会失去上限。$meta 可传入已取好的条目避免重复查找。
function tc_model_meta_caps($meta) {
    $out = ($meta !== null && !empty($meta['maxOutputTokens'])) ? (int) $meta['maxOutputTokens'] : TC_MODEL_META_AUTO_OUTPUT;
    $ctx = ($meta !== null && !empty($meta['maxInputTokens'])) ? (int) $meta['maxInputTokens'] : TC_MODEL_META_AUTO_CONTEXT;
    return array($out, $ctx);
}

// 模型加进供应商后,若元数据表里还没有它,自动补一条兜底值并标记「待人工复核」。
// 让新加的模型立刻出现在「模型元数据」表里(而不是静默沿用兜底值),便于管理员核对修正。
// 名字能被现有条目包含匹配到(如 XXX/deepseek-flash 命中 deepseek-flash)时不补 ——
// 复用已有条目的窗口/价格,避免同一模型在表里出现两条互相矛盾的数据。
function tc_model_meta_ensure_auto(&$db, $models) {
    if (!isset($db['modelMeta']) || !is_array($db['modelMeta'])) $db['modelMeta'] = array();
    $added = 0;
    foreach ((array) $models as $m) {
        $name = is_array($m) ? (isset($m['id']) ? (string) $m['id'] : '') : (string) $m;
        $key = tc_model_meta_key($name);
        if ($key === '' || strlen($key) > 200 || isset($db['modelMeta'][$key])) continue;
        if (tc_model_meta_resolve($db, $name) !== null) continue;
        $db['modelMeta'][$key] = tc_normalize_model_meta_item(array(
            'maxInputTokens' => TC_MODEL_META_AUTO_CONTEXT,
            'maxOutputTokens' => TC_MODEL_META_AUTO_OUTPUT,
            'source' => 'auto',
            'needsReview' => true,
            'enabled' => true,
            'updatedAt' => tc_now(),
        ));
        $added++;
        if (count($db['modelMeta']) >= 20000) break;
    }
    return $added;
}

// 内置的模型元数据表:常见模型的开箱即用值,省得管理员逐个手工录入。
// 价格按「每百万 token」书写(贴近各家报价习惯),取数时统一 /1e6 转「每 token」,
// 与 litellm 的存储口径一致;窗口/输出上限直接按 token 填。
// 币种:全表统一按美元(USD)录入,与后台「$/M」展示口径一致;DeepSeek/Agnes
// 的官方人民币报价已按美元值填入,不在这里做任何汇率换算。
// 空值(如 Grok 未公布输出上限、Agnes 未公布缓存写价)填 0,取数处按 0 视为未配置。
function tc_builtin_model_meta() {
    $perM = function ($v) { return ((float) $v) / 1000000; };
    $row = function ($ctx, $out, $in, $outCost, $read, $write) use ($perM) {
        return array(
            'maxInputTokens' => (int) $ctx,
            'maxOutputTokens' => (int) $out,
            'inputCostPerToken' => $perM($in),
            'outputCostPerToken' => $perM($outCost),
            'cacheReadCostPerToken' => $perM($read),
            'cacheWriteCostPerToken' => $perM($write),
        );
    };
    return array(
        'gpt-6-astra' => $row(1050000, 128000, 10, 50, 1, 12.5),
        'gpt-6.1-sol' => $row(1050000, 128000, 2, 10, 0.1, 2.5),
        'gpt-6-luna' => $row(1050000, 128000, 0.1, 0.5, 0.01, 0.13),
        'gpt-6-sol' => $row(1050000, 128000, 2, 10, 0.2, 2.5),
        'gpt-5.6-sol' => $row(1050000, 128000, 4, 20, 0.4, 5),
        'gpt-5.6-terra' => $row(1050000, 128000, 2, 12, 0.2, 2.5),
        'gpt-5.6-luna' => $row(1050000, 128000, 0.2, 1.2, 0.02, 0.25),
        'deepseek-flash' => $row(1000000, 384000, 0.3, 1.2, 0.04, 0),
        'deepseek-v4-pro' => $row(1000000, 384000, 1.32, 3.96, 0.3, 0),
        'deepseek-v4-flash' => $row(1000000, 384000, 0.3, 1.2, 0.04, 0),
        'deepseek-v4-flash-vision-exp' => $row(1000000, 384000, 0.3, 1.2, 0.04, 0),
        'grok-4.7' => $row(500000, 0, 2, 6, 0.5, 0),
        'grok-4.6' => $row(500000, 0, 2, 6, 0.5, 0),
        'gemini-3.8-flash' => $row(1048576, 65536, 0.75, 3.75, 0.08, 0.5),
        'gemini-3.7-flash' => $row(1048576, 65536, 0.75, 3.75, 0.08, 0.5),
        'gemini-3.1-pro-preview' => $row(1048576, 65536, 2, 12, 0.2, 4.5),
        'gemini-2.5-pro' => $row(1048576, 65536, 1.25, 10, 0.13, 4.5),
        'gemini-2.5-flash' => $row(1048576, 65536, 0.3, 2.5, 0.03, 1),
        'gemini-2.5-flash-lite' => $row(1048576, 65536, 0.1, 0.4, 0.01, 1),
        'agnes-3.0-flash' => $row(500000, 65536, 0, 0, 0, 0),
        'agnes-2.5-flash' => $row(500000, 65536, 0, 0, 0, 0),
        'agnes-2.5-pro' => $row(1000000, 65536, 0.45, 0.9, 0.05, 0),
        'agnes-3.0-pro' => $row(1000000, 65536, 0.45, 0.9, 0.05, 0),
        'agnes-2.0-flash' => $row(256000, 65536, 0, 0, 0, 0),
    );
}

// 把内置元数据补进库。三条规则:
//   1) 库里没有 → 新增(source=builtin);
//   2) 库里是 auto(source=auto,即「没数据时自动补的兜底值」)→ 用内置真实值替换;
//   3) 库里是 manual/litellm/builtin → 一律不动(管理员改过的、同步来的真实数据优先)。
// 返回新增或替换的条数。可重复调用:第二次起不会再有 auto 条目被替换。
function tc_model_meta_seed_builtin(&$db) {
    if (!isset($db['modelMeta']) || !is_array($db['modelMeta'])) $db['modelMeta'] = array();
    $n = 0;
    foreach (tc_builtin_model_meta() as $name => $row) {
        $key = tc_model_meta_key($name);
        if ($key === '') continue;
        $cur = isset($db['modelMeta'][$key]) && is_array($db['modelMeta'][$key]) ? $db['modelMeta'][$key] : null;
        if ($cur !== null && (string) (isset($cur['source']) ? $cur['source'] : '') !== 'auto') continue;
        $item = tc_normalize_model_meta_item(array_merge($row, array(
            'source' => 'builtin',
            'enabled' => true,
            'updatedAt' => tc_now(),
        )));
        if ($item === null) continue;
        $db['modelMeta'][$key] = $item;
        $n++;
    }
    return $n;
}

function tc_normalize_settings($raw) {
    global $TC_SETTINGS_DEFAULTS;
    $s = array_merge($TC_SETTINGS_DEFAULTS, is_array($raw) ? $raw : array());
    $s['thinking'] = tc_normalize_thinking(isset($s['thinking']) ? $s['thinking'] : null);
    $s['siteName'] = substr((string) (isset($s['siteName']) ? $s['siteName'] : $TC_SETTINGS_DEFAULTS['siteName']), 0, 40);
    $s['allowRegister'] = !empty($s['allowRegister']);
    $s['allowUserProviders'] = !empty($s['allowUserProviders']);
    $s['freeQuotaUnlimited'] = !empty($s['freeQuotaUnlimited']);
    $s['freeQuota'] = max(0, (int) $s['freeQuota']);
    $s['emailVerificationEnabled'] = !empty($s['emailVerificationEnabled']);
    $s['passwordResetEnabled'] = !empty($s['passwordResetEnabled']);
    $smtp = is_array($s['smtp']) ? $s['smtp'] : array();
    $tpl = is_array($s['mailTemplates']) ? $s['mailTemplates'] : array();
    // 模板版本升级:仅当存储的仍是旧版默认(或为空)时换成新版默认,管理员自定义的不动
    if (((int) ($tpl['tplVersion'] ?? 0)) < TC_MAIL_TPL_VERSION) {
        $oldVerify = '<p>你好，{name}：</p><p>请点击下面的链接验证邮箱：</p><p><a href="{link}">验证邮箱</a></p>';
        $oldReset = '<p>你好，{name}：</p><p>请点击下面的链接重置密码：</p><p><a href="{link}">重置密码</a></p>';
        $verifyIsPristine = ((string) ($tpl['verifyHtml'] ?? '') === '' || (string) ($tpl['verifyHtml'] ?? '') === $oldVerify);
        $resetIsPristine = ((string) ($tpl['resetHtml'] ?? '') === '' || (string) ($tpl['resetHtml'] ?? '') === $oldReset);
        if ($verifyIsPristine && $resetIsPristine) $tpl = array();
        $tpl['tplVersion'] = TC_MAIL_TPL_VERSION;
    }
    $s['mailTemplates'] = array_merge($TC_SETTINGS_DEFAULTS['mailTemplates'], $tpl);
    $s['smtp'] = array('host' => substr(trim((string) ($smtp['host'] ?? '')), 0, 180), 'port' => min(65535, max(1, (int) ($smtp['port'] ?? 587))), 'username' => substr(trim((string) ($smtp['username'] ?? '')), 0, 180), 'password' => tc_smtp_normalize_password($smtp['password'] ?? ''), 'encryption' => in_array(($smtp['encryption'] ?? 'tls'), array('none','ssl','tls'), true) ? ($smtp['encryption'] ?? 'tls') : 'tls', 'fromName' => substr(trim((string) ($smtp['fromName'] ?? 'TinyChat')), 0, 80), 'fromEmail' => substr(trim((string) ($smtp['fromEmail'] ?? '')), 0, 180));
    // 「SMTP 密码保存后保持显示」:勾选后可随时在后台点小眼睛取回明文(便于复制到其它系统)，
    // 未勾选则只显示掩码且取不回明文。演示管理员无论该开关如何都不可见。
    $s['smtpKeyRevealable'] = !empty($s['smtpKeyRevealable']);
    $timeout = isset($s['proxyTimeoutMs']) ? (int) $s['proxyTimeoutMs'] : $TC_SETTINGS_DEFAULTS['proxyTimeoutMs'];
    $s['proxyTimeoutMs'] = min(600000, max(5000, $timeout ?: $TC_SETTINGS_DEFAULTS['proxyTimeoutMs']));
    // 出站代理:只接受 http/https/socks5 形态,避免把任意字符串塞进 curl 选项
    $outProxy = trim((string) (isset($s['outboundProxy']) ? $s['outboundProxy'] : ''));
    $s['outboundProxy'] = preg_match('#^(https?|socks5h?)://[^\s]{1,300}$#i', $outProxy) ? $outProxy : '';
    $s['loginMaxFails'] = min(50, max(0, (int) $s['loginMaxFails']));
    // 第三方登录配置归一化:只接受注册表里的提供商与字段,凭据截断长度。
    // 注册表在 lib/oauth.php;单独加载 core 的场景(如 CI 自检)没有它,
    // 此时按已知字段名兜底,避免让整个数据层硬依赖可选模块。
    $oauthIn = isset($s['oauthProviders']) && is_array($s['oauthProviders']) ? $s['oauthProviders'] : array();
    $oauth = array();
    $oauthRegistry = function_exists('tc_oauth_providers') ? tc_oauth_providers() : array();
    if (!$oauthRegistry) {
        foreach (array('wechat', 'qq', 'linuxdo', 'nodeloc') as $pid) {
            $oauthRegistry[$pid] = array('fields' => array('appId' => 1, 'appSecret' => 1, 'appKey' => 1, 'clientId' => 1, 'clientSecret' => 1));
        }
    }
    foreach ($oauthRegistry as $pid => $prov) {
        $row = isset($oauthIn[$pid]) && is_array($oauthIn[$pid]) ? $oauthIn[$pid] : array();
        $clean = array('enabled' => !empty($row['enabled']));
        foreach (array_keys($prov['fields']) as $f) {
            $clean[$f] = substr(trim((string) (isset($row[$f]) ? $row[$f] : '')), 0, 200);
        }
        $oauth[$pid] = $clean;
    }
    $s['oauthProviders'] = $oauth;
    $s['oauthAutoRegister'] = !array_key_exists('oauthAutoRegister', $s) || !empty($s['oauthAutoRegister']);
    $s['oauthRequireProfile'] = !empty($s['oauthRequireProfile']);
    $s['loginLockMs'] = min(3600000, max(0, (int) $s['loginLockMs']));
    $s['webSearchEnabled'] = !empty($s['webSearchEnabled']);
    $prov = strtolower(trim((string) (isset($s['webSearchProvider']) ? $s['webSearchProvider'] : 'ddg')));
    $s['webSearchProvider'] = in_array($prov, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true) ? $prov : 'ddg';
    $s['webSearchTavilyKey'] = substr(trim((string) (isset($s['webSearchTavilyKey']) ? $s['webSearchTavilyKey'] : '')), 0, 200);
    $s['webSearchBraveKey'] = substr(trim((string) (isset($s['webSearchBraveKey']) ? $s['webSearchBraveKey'] : '')), 0, 200);
    $s['webSearchJinaKey'] = substr(trim((string) (isset($s['webSearchJinaKey']) ? $s['webSearchJinaKey'] : '')), 0, 200);
    $s['webSearchSearxUrl'] = tc_searx_urls_text(isset($s['webSearchSearxUrl']) ? $s['webSearchSearxUrl'] : '');
    $max = isset($s['webSearchMaxResults']) ? (int) $s['webSearchMaxResults'] : 5;
    $s['webSearchMaxResults'] = min(8, max(1, $max ?: 5));
    $s['webSearchAllowUser'] = !empty($s['webSearchAllowUser']);
    // 链接读取:用户消息里的 http(s) 链接自动抓取正文作为回答材料
    $s['urlReadEnabled'] = !array_key_exists('urlReadEnabled', $s) || !empty($s['urlReadEnabled']);
    $s['urlReadMax'] = min(5, max(1, (int) (isset($s['urlReadMax']) ? $s['urlReadMax'] : 3) ?: 3));
    $s['mineruToken'] = substr(trim((string) (isset($s['mineruToken']) ? $s['mineruToken'] : '')), 0, 300);
    $s['mineruAllowUser'] = !empty($s['mineruAllowUser']);
    // 文档解析通道:PaddleOCR 服务地址/Key、Mistral OCR Key,以及按类别的路由表
    $s['paddleOcrUrl'] = rtrim(trim((string) (isset($s['paddleOcrUrl']) ? $s['paddleOcrUrl'] : '')), '/');
    $s['paddleOcrKey'] = substr(trim((string) (isset($s['paddleOcrKey']) ? $s['paddleOcrKey'] : '')), 0, 300);
    $s['mistralOcrKey'] = substr(trim((string) (isset($s['mistralOcrKey']) ? $s['mistralOcrKey'] : '')), 0, 300);
    $channelsIn = isset($s['parseChannels']) && is_array($s['parseChannels']) ? $s['parseChannels'] : array();
    $channels = array();
    foreach (array('pdf', 'image', 'office') as $pcat) {
        $pval = strtolower(trim((string) (isset($channelsIn[$pcat]) ? $channelsIn[$pcat] : 'mineru')));
        $channels[$pcat] = in_array($pval, array('mineru', 'paddle', 'mistral'), true) ? $pval : 'mineru';
    }
    $s['parseChannels'] = $channels;
    $s['defaultGroupId'] = substr(trim((string) (isset($s['defaultGroupId']) ? $s['defaultGroupId'] : '')), 0, 64);
    $maxCtx = isset($s['maxContextMessages']) ? (int) $s['maxContextMessages'] : $TC_SETTINGS_DEFAULTS['maxContextMessages'];
    $s['maxContextMessages'] = min(500, max(2, $maxCtx ?: $TC_SETTINGS_DEFAULTS['maxContextMessages']));
    $ctx = isset($s['contextMessages']) ? (int) $s['contextMessages'] : $TC_SETTINGS_DEFAULTS['contextMessages'];
    $s['contextMessages'] = min($s['maxContextMessages'], max(2, $ctx ?: $TC_SETTINGS_DEFAULTS['contextMessages']));
    $temp = isset($s['temperature']) && $s['temperature'] !== '' && $s['temperature'] !== null ? (float) $s['temperature'] : null;
    $s['temperature'] = $temp === null ? null : min(2, max(0, $temp));
    $s['backupEnabled'] = !array_key_exists('backupEnabled', $s) || !empty($s['backupEnabled']);
    $s['backupKeep'] = min(30, max(1, (int) (isset($s['backupKeep']) ? $s['backupKeep'] : 7) ?: 7));
    $s['rateLimitPerMin'] = min(600, max(0, (int) (isset($s['rateLimitPerMin']) ? $s['rateLimitPerMin'] : 30)));
    $s['sessionDays'] = min(30, max(1, (int) (isset($s['sessionDays']) ? $s['sessionDays'] : 7) ?: 7));
    $s['authEpoch'] = max(1, (int) (isset($s['authEpoch']) ? $s['authEpoch'] : 1));
    $s['contextAutoLearn'] = !array_key_exists('contextAutoLearn', $s) || !empty($s['contextAutoLearn']);
    $s['apiSaveChats'] = !array_key_exists('apiSaveChats', $s) || !empty($s['apiSaveChats']);
    // 可用性阈值:两个百分比,保证 okMin > warnMin(输入颠倒时自动纠正)
    $okMin = min(100, max(1, (int) (isset($s['healthOkMin']) ? $s['healthOkMin'] : 75) ?: 75));
    $warnMin = min(99, max(0, (int) (isset($s['healthWarnMin']) ? $s['healthWarnMin'] : 40)));
    if ($warnMin >= $okMin) $warnMin = max(0, $okMin - 1);
    $s['healthOkMin'] = $okMin;
    $s['healthWarnMin'] = $warnMin;
    $mod = isset($s['moderation']) && is_array($s['moderation']) ? $s['moderation'] : array();
    $s['moderation'] = array(
        'enabled' => !empty($mod['enabled']),
        'words' => tc_moderation_words_text(isset($mod['words']) ? $mod['words'] : ''),
    );
    $s['agreementEnabled'] = !empty($s['agreementEnabled']);
    // 用户协议:正文为空时填入内置默认模板,方便管理员在此基础上改写;写过内容就不再覆盖
    // (与邮件模板的版本升级同一取舍)。启用与否只由 agreementEnabled 决定,默认不启用。
    if (trim((string) (isset($s['agreementHtml']) ? $s['agreementHtml'] : '')) === '') {
        $s['agreementHtml'] = tc_default_agreement_html();
    }
    $s['agreementHtml'] = substr((string) $s['agreementHtml'], 0, 200000);
    // 性能优化开关(默认关闭)
    $s['notesEnabled'] = !array_key_exists('notesEnabled', $s) || !empty($s['notesEnabled']);
    $s['notesQuotaMb'] = min(102400, max(0, (int) (isset($s['notesQuotaMb']) ? $s['notesQuotaMb'] : 200)));
    $s['notesMaxFileMb'] = min(2048, max(1, (int) (isset($s['notesMaxFileMb']) ? $s['notesMaxFileMb'] : 50)));
    $s['notesAllowFiles'] = !array_key_exists('notesAllowFiles', $s) || !empty($s['notesAllowFiles']);
    $s['notesShareBodyOnly'] = !array_key_exists('notesShareBodyOnly', $s) || !empty($s['notesShareBodyOnly']);
    $s['notesAiDailyLimit'] = min(10000, max(0, (int) (isset($s['notesAiDailyLimit']) ? $s['notesAiDailyLimit'] : 50)));
    $s['notesAiCustomizable'] = !array_key_exists('notesAiCustomizable', $s) || !empty($s['notesAiCustomizable']);
    // 笔记图片单文件上限(MB):此前写死 10MB,收进后台设置(1~2048)
    $s['notesMaxImageMb'] = min(2048, max(1, (int) (isset($s['notesMaxImageMb']) ? $s['notesMaxImageMb'] : 10) ?: 10));
    // 在线聊天(IM):总开关、附件空间/大小限制与 AI 召唤每日上限
    $s['imEnabled'] = !array_key_exists('imEnabled', $s) || !empty($s['imEnabled']);
    $s['imQuotaMb'] = min(102400, max(0, (int) (isset($s['imQuotaMb']) ? $s['imQuotaMb'] : 500)));
    $s['imMaxFileMb'] = min(2048, max(1, (int) (isset($s['imMaxFileMb']) ? $s['imMaxFileMb'] : 20) ?: 20));
    $s['imMaxImageMb'] = min(2048, max(1, (int) (isset($s['imMaxImageMb']) ? $s['imMaxImageMb'] : 10) ?: 10));
    $s['imAllowFiles'] = !array_key_exists('imAllowFiles', $s) || !empty($s['imAllowFiles']);
    $s['imAiDailyLimit'] = min(10000, max(0, (int) (isset($s['imAiDailyLimit']) ? $s['imAiDailyLimit'] : 50)));
    $s['imShowAllMembers'] = !empty($s['imMutualFriends']);   // 旧开关语义并入新开关(兼容存量数据)
    unset($s['imShowAllMembers']);
    $s['imMutualFriends'] = !empty($s['imMutualFriends']);
    // 「对所有人可见」名单:接受数组或逗号/换行分隔的字符串,去重去空,每人最多 100 个
    $vuIn = isset($s['imVisibleUsers']) ? $s['imVisibleUsers'] : array();
    if (is_string($vuIn)) $vuIn = preg_split('/[\s,，、;；]+/u', $vuIn);
    $vuOut = array();
    foreach ((array) $vuIn as $vn) {
        $vn = tc_utf_cut(trim((string) $vn), 32);
        if ($vn === '') continue;
        $vuOut[$vn] = true;
        if (count($vuOut) >= 100) break;
    }
    $s['imVisibleUsers'] = array_keys($vuOut);
    // 在线浏览器:总开关、网页总结每日上限、收藏夹(逐项清洗,不让 javascript: 之类落进主页)
    $s['browserEnabled'] = !array_key_exists('browserEnabled', $s) || !empty($s['browserEnabled']);
    $s['webAiDailyLimit'] = min(10000, max(0, (int) (isset($s['webAiDailyLimit']) ? $s['webAiDailyLimit'] : 50)));
    $wbIn = isset($s['webBookmarks']) && is_array($s['webBookmarks']) ? $s['webBookmarks'] : array();
    $wbOut = array();
    foreach ($wbIn as $wb) {
        if (!is_array($wb)) continue;
        $wbName = tc_utf_cut(trim((string) (isset($wb['name']) ? $wb['name'] : '')), 40);
        $wbUrl = tc_utf_cut(trim((string) (isset($wb['url']) ? $wb['url'] : '')), 500);
        if ($wbName === '' || $wbUrl === '') continue;
        if (!preg_match('#^https?://#i', $wbUrl)) $wbUrl = 'https://' . ltrim($wbUrl, '/');
        if (!preg_match('#^https?://#i', $wbUrl)) continue;
        $wbOut[] = array('name' => $wbName, 'url' => $wbUrl);
        if (count($wbOut) >= 200) break;
    }
    $s['webBookmarks'] = $wbOut;
    // 仅限中国 IP 站点:默认开启(旧库缺字段也按开启);并发上限 1~16
    $s['webCnOnly'] = !array_key_exists('webCnOnly', $s) || !empty($s['webCnOnly']);
    $s['webCnAllowAssets'] = !array_key_exists('webCnAllowAssets', $s) || !empty($s['webCnAllowAssets']);
    $s['webDailyTrafficMb'] = min(1024000, max(0, (int) (isset($s['webDailyTrafficMb']) ? $s['webDailyTrafficMb'] : 500)));
    $s['webConcurrency'] = min(16, max(1, (int) (isset($s['webConcurrency']) ? $s['webConcurrency'] : 6) ?: 6));
    // 拓展功能的访问级别与名单(在线浏览器 / AI 笔记 / 在线聊天 / 在线工具箱)
    foreach (array('notes', 'im', 'web', 'toolbox') as $feat) {
        $s[$feat . 'Access'] = tc_feature_access_mode(isset($s[$feat . 'Access']) ? $s[$feat . 'Access'] : 'all');
        $s[$feat . 'AccessUsers'] = tc_feature_access_list(isset($s[$feat . 'AccessUsers']) ? $s[$feat . 'AccessUsers'] : array());
        $s[$feat . 'AccessGroups'] = tc_feature_access_list(isset($s[$feat . 'AccessGroups']) ? $s[$feat . 'AccessGroups'] : array(), 50);
    }
    $s['perfNoWebfonts'] = !empty($s['perfNoWebfonts']);
    $s['perfNoKatex'] = !empty($s['perfNoKatex']);
    $s['perfNoHighlight'] = !empty($s['perfNoHighlight']);
    $s['perfNoMermaid'] = !empty($s['perfNoMermaid']);
    // 生图本地留存:默认开启;总量上限限制在 50MB~10GB
    $s['imageArchiveEnabled'] = !array_key_exists('imageArchiveEnabled', $s) || !empty($s['imageArchiveEnabled']);
    $s['imageArchiveQuotaMb'] = min(10240, max(50, (int) (isset($s['imageArchiveQuotaMb']) ? $s['imageArchiveQuotaMb'] : 500) ?: 500));
    $s['persistChats'] = !array_key_exists('persistChats', $s) || !empty($s['persistChats']);
    // 用户设置云同步:默认开启。关闭后 /api/sync/settings 只读不写(与 persistChats 同一套隐私语义),
    // 用户偏好/外观/群聊配置就只留在各自浏览器本地。
    $s['syncSettings'] = !array_key_exists('syncSettings', $s) || !empty($s['syncSettings']);
    $ann = isset($s['announcement']) && is_array($s['announcement']) ? $s['announcement'] : array();
    $annText = trim((string) (isset($ann['text']) ? $ann['text'] : ''));
    if (function_exists('mb_substr')) {
        $annText = mb_substr($annText, 0, 2000, 'UTF-8');
    } elseif (preg_match('/^.{0,2000}/us', $annText, $annSlice)) {
        $annText = $annSlice[0];
    } else {
        $annText = substr($annText, 0, 2000);
    }
    $annChanged = isset($ann['updatedAt']) ? (int) $ann['updatedAt'] : 0;
    $s['announcement'] = array(
        'enabled' => !empty($ann['enabled']) && $annText !== '',
        'text' => $annText,
        'updatedAt' => $annChanged,
    );
    $s['apiKeysEnabled'] = !array_key_exists('apiKeysEnabled', $s) || !empty($s['apiKeysEnabled']);
    $s['apiKeyRateLimitPerMin'] = min(600, max(0, (int) (isset($s['apiKeyRateLimitPerMin']) ? $s['apiKeyRateLimitPerMin'] : $TC_SETTINGS_DEFAULTS['apiKeyRateLimitPerMin'])));
    $exposed = isset($s['apiExposedModels']) && is_array($s['apiExposedModels']) ? $s['apiExposedModels'] : array();
    $exposedList = array();
    foreach ($exposed as $item) {
        $item = trim((string) $item);
        if ($item !== '' && strpos($item, '|') !== false) $exposedList[$item] = true;
    }
    $s['apiExposedModels'] = array_keys($exposedList);
    $s['demoMode'] = !empty($s['demoMode']);
    $s['demoExpireMinutes'] = min(1440, max(1, (int) (isset($s['demoExpireMinutes']) ? $s['demoExpireMinutes'] : 10) ?: 10));
    $s['guestEnabled'] = !empty($s['guestEnabled']);
    $s['guestRounds'] = min(1000, max(1, (int) (isset($s['guestRounds']) ? $s['guestRounds'] : 3) ?: 3));
    $s['registerInviteRequired'] = !empty($s['registerInviteRequired']);
    $s['registerLimitPerHour'] = min(1000, max(1, (int) (isset($s['registerLimitPerHour']) ? $s['registerLimitPerHour'] : 5) ?: 5));
    // 注销模式:仅接受 off/soft/hard,其余一律回落软注销(默认值)
    $adMode = isset($s['accountDeletionMode']) ? (string) $s['accountDeletionMode'] : 'soft';
    $s['accountDeletionMode'] = in_array($adMode, array('off', 'soft', 'hard'), true) ? $adMode : 'soft';
    return $s;
}

function tc_searx_urls_text($raw) {
    $out = array();
    $seen = array();
    foreach (preg_split('/[\s,;]+/', (string) $raw) as $part) {
        $u = rtrim(trim($part), '/');
        if ($u === '' || !preg_match('#^https?://#i', $u)) continue;
        $k = strtolower($u);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $out[] = $u;
        if (count($out) >= 12) break;
    }
    return substr(implode("\n", $out), 0, 2400);
}

function tc_searx_url_list($raw) {
    $text = tc_searx_urls_text($raw);
    if ($text === '') return array();
    return explode("\n", $text);
}

function tc_web_search_ready($s) {
    if (empty($s['webSearchEnabled'])) return false;
    $prov = isset($s['webSearchProvider']) ? (string) $s['webSearchProvider'] : 'ddg';
    if ($prov === 'searxng') {
        return tc_searx_url_list(isset($s['webSearchSearxUrl']) ? $s['webSearchSearxUrl'] : '') !== array();
    }
    if ($prov === 'brave') {
        return trim((string) (isset($s['webSearchBraveKey']) ? $s['webSearchBraveKey'] : '')) !== '';
    }
    if ($prov === 'ddg' || $prov === 'jina') {
        return true; // 免 Key;Jina 填 Key 仅为提升配额
    }
    return trim((string) (isset($s['webSearchTavilyKey']) ? $s['webSearchTavilyKey'] : '')) !== '';
}

function tc_mineru_token($s) {
    return trim((string) (isset($s['mineruToken']) ? $s['mineruToken'] : ''));
}

function tc_user_tools($u) {
    $raw = (isset($u['tools']) && is_array($u['tools'])) ? $u['tools'] : array();
    $src = isset($raw['webSearchSource']) ? (string) $raw['webSearchSource'] : 'platform';
    $parse = isset($raw['parseSource']) ? (string) $raw['parseSource'] : 'platform';
    $provider = strtolower(trim((string) (isset($raw['webSearchProvider']) ? $raw['webSearchProvider'] : 'ddg')));
    $provider = in_array($provider, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true) ? $provider : 'ddg';
    $max = isset($raw['webSearchMaxResults']) ? (int) $raw['webSearchMaxResults'] : 5;
    return array(
        'webSearchSource' => $src === 'own' ? 'own' : 'platform',
        'webSearchProvider' => $provider,
        'webSearchTavilyKey' => substr(trim((string) (isset($raw['webSearchTavilyKey']) ? $raw['webSearchTavilyKey'] : '')), 0, 200),
        'webSearchBraveKey' => substr(trim((string) (isset($raw['webSearchBraveKey']) ? $raw['webSearchBraveKey'] : '')), 0, 200),
        'webSearchJinaKey' => substr(trim((string) (isset($raw['webSearchJinaKey']) ? $raw['webSearchJinaKey'] : '')), 0, 200),
        'webSearchSearxUrl' => tc_searx_urls_text(isset($raw['webSearchSearxUrl']) ? $raw['webSearchSearxUrl'] : ''),
        'webSearchMaxResults' => min(8, max(1, $max ?: 5)),
        'parseSource' => $parse === 'own' ? 'own' : 'platform',
        'mineruToken' => substr(trim((string) (isset($raw['mineruToken']) ? $raw['mineruToken'] : '')), 0, 300),
    );
}

// 各检索源「用户自备配置是否已填完整」:ddg/jina 免 Key,恒可用
function tc_user_search_own_ready($tools) {
    $prov = isset($tools['webSearchProvider']) ? (string) $tools['webSearchProvider'] : 'ddg';
    if ($prov === 'searxng') return $tools['webSearchSearxUrl'] !== '';
    if ($prov === 'brave') return $tools['webSearchBraveKey'] !== '';
    if ($prov === 'ddg' || $prov === 'jina') return true;
    return $tools['webSearchTavilyKey'] !== '';
}

function tc_user_search_settings($user, $site) {
    $tools = tc_user_tools($user);
    if (!empty($site['webSearchAllowUser']) && $tools['webSearchSource'] === 'own') {
        return array(
            'webSearchEnabled' => true,
            'webSearchProvider' => $tools['webSearchProvider'],
            'webSearchTavilyKey' => $tools['webSearchTavilyKey'],
            'webSearchBraveKey' => $tools['webSearchBraveKey'],
            'webSearchJinaKey' => $tools['webSearchJinaKey'],
            'webSearchSearxUrl' => $tools['webSearchSearxUrl'],
            'webSearchMaxResults' => $tools['webSearchMaxResults'],
        );
    }
    return $site;
}

function tc_user_mineru_token($user, $site) {
    $tools = tc_user_tools($user);
    if (!empty($site['mineruAllowUser']) && $tools['parseSource'] === 'own') return $tools['mineruToken'];
    return tc_mineru_token($site);
}

function tc_user_tools_public($user, $site) {
    $tools = tc_user_tools($user);
    $ownReady = tc_user_search_own_ready($tools);
    return array(
        'webSearch' => array(
            'allowOwn' => !empty($site['webSearchAllowUser']),
            'platformReady' => tc_web_search_ready($site),
            'source' => $tools['webSearchSource'],
            'provider' => $tools['webSearchProvider'],
            'hasKey' => $tools['webSearchTavilyKey'] !== '',
            'keyMask' => $tools['webSearchTavilyKey'] !== '' ? tc_mask_key($tools['webSearchTavilyKey']) : '',
            'braveKeyMask' => $tools['webSearchBraveKey'] !== '' ? tc_mask_key($tools['webSearchBraveKey']) : '',
            'jinaKeyMask' => $tools['webSearchJinaKey'] !== '' ? tc_mask_key($tools['webSearchJinaKey']) : '',
            'searxUrl' => $tools['webSearchSearxUrl'],
            'maxResults' => $tools['webSearchMaxResults'],
            'ownReady' => $ownReady,
        ),
        'parse' => array(
            'allowOwn' => !empty($site['mineruAllowUser']),
            'platformMode' => tc_mineru_token($site) !== '' ? 'precise' : 'lite',
            'source' => $tools['parseSource'],
            'hasToken' => $tools['mineruToken'] !== '',
            'tokenMask' => $tools['mineruToken'] !== '' ? tc_mask_key($tools['mineruToken']) : '',
        ),
    );
}

function tc_mineru_public($s) {
    $channels = isset($s['parseChannels']) && is_array($s['parseChannels']) ? $s['parseChannels'] : array();
    return array(
        'enabled' => true,
        'mode' => tc_mineru_token($s) !== '' ? 'precise' : 'lite',
        'allowOwn' => !empty($s['mineruAllowUser']),
        'routes' => array(
            'pdf' => isset($channels['pdf']) ? $channels['pdf'] : 'mineru',
            'image' => isset($channels['image']) ? $channels['image'] : 'mineru',
            'office' => isset($channels['office']) ? $channels['office'] : 'mineru',
        ),
    );
}

function tc_web_search_public($s) {
    $prov = isset($s['webSearchProvider']) ? (string) $s['webSearchProvider'] : 'ddg';
    return array(
        'enabled' => tc_web_search_ready($s),
        'provider' => in_array($prov, array('tavily', 'searxng', 'brave', 'ddg', 'jina'), true) ? $prov : 'ddg',
        'allowOwn' => !empty($s['webSearchAllowUser']),
    );
}

// 后台设置对外下发前的脱敏。$forDemo=true 时按演示管理员的可见边界处理:
// 除常规掩码外,SMTP 密码/发件人账号这类「可用于冒用站点发信」的凭据一律不下发
// (连掩码都不给——掩码本身会泄露首尾字符,可被用于缩小猜测范围)。
function tc_admin_settings_public($s, $forDemo = false) {
    $out = is_array($s) ? $s : array();
    if (!empty($out['webSearchTavilyKey'])) $out['webSearchTavilyKey'] = tc_mask_key($out['webSearchTavilyKey']);
    if (!empty($out['paddleOcrKey'])) $out['paddleOcrKey'] = tc_mask_key($out['paddleOcrKey']);
    if (!empty($out['mistralOcrKey'])) $out['mistralOcrKey'] = tc_mask_key($out['mistralOcrKey']);
    if (!empty($out['webSearchBraveKey'])) $out['webSearchBraveKey'] = tc_mask_key($out['webSearchBraveKey']);
    if (!empty($out['webSearchJinaKey'])) $out['webSearchJinaKey'] = tc_mask_key($out['webSearchJinaKey']);
    if (!empty($out['mineruToken'])) $out['mineruToken'] = tc_mask_key($out['mineruToken']);
    // 第三方登录密钥掩码(前端回显用;保存时按 •• 跳过,不回写)
    if (!empty($out['oauthProviders']) && is_array($out['oauthProviders'])) {
        foreach ($out['oauthProviders'] as $pid => $row) {
            if (!is_array($row)) continue;
            foreach (array('appSecret', 'appKey', 'clientSecret') as $sk) {
                if (!empty($row[$sk])) $out['oauthProviders'][$pid][$sk] = tc_mask_key($row[$sk]);
            }
        }
    }
    if (!empty($out['smtp']) && is_array($out['smtp'])) {
        if ($forDemo) {
            // 演示管理员:整段 SMTP 凭据不可见(前端据此把该区域置为只读)
            $out['smtp']['password'] = '';
            $out['smtp']['username'] = '';
            $out['smtp']['host'] = '';
            $out['smtp']['fromEmail'] = '';
            $out['smtpRestricted'] = true;
            $out['smtpKeyRevealable'] = false;
        } elseif (!empty($out['smtp']['password'])) {
            // 勾选「保持显示」时下发真实明文(前端直接可读可复制);
            // 未勾选则只给掩码,取回明文要走 smtp-reveal 且会被拒绝。
            if (empty($out['smtpKeyRevealable'])) $out['smtp']['password'] = tc_mask_key($out['smtp']['password']);
        }
    } elseif ($forDemo) {
        $out['smtp'] = array('host' => '', 'port' => 587, 'username' => '', 'password' => '', 'encryption' => 'tls', 'fromName' => '', 'fromEmail' => '');
        $out['smtpRestricted'] = true;
    }
    // 敏感词库是运营方的审核策略,演示身份不可见:连内容都不下发(前端据此把输入框置为只读)。
    // enabled 开关仍照常下发,方便演示者了解该功能存在。
    if ($forDemo && !empty($out['moderation']) && is_array($out['moderation'])) {
        $out['moderation']['words'] = '';
        $out['moderationRestricted'] = true;
    }
    $out['webSearchAllowUser'] = !empty($out['webSearchAllowUser']);
    $out['mineruAllowUser'] = !empty($out['mineruAllowUser']);
    return $out;
}

function tc_empty_db() {
    return array(
        'version' => TC_DB_VERSION,
        'users' => array(),
        'providers' => array(),
        'defaultProviderId' => null,
        'stats' => array('totalCalls' => 0, 'totalQuotaGiven' => 0, 'callsByDay' => new stdClass(), 'modelVotes' => new stdClass(), 'usageLedger' => new stdClass(), 'modelHealth' => new stdClass()),
        'settings' => tc_normalize_settings(null),
        'userChats' => new stdClass(),
        // 已删除对话留档:{userId: {chats:[完整记录], tombs:{chatId: 删除时间}}}——用户端删除只打标记,
        // 内容留在云端供管理员查看与批量清理;tombs 是墓碑,防止别的设备用旧副本把对话合并回来
        'userDeletedChats' => new stdClass(),
        // AI 笔记:按用户拆成 note:{uid} 行(与 userChats 同一套省写放大机制),
        // 值为 {folders:[], notes:[], tombs:{id:删除时间}} 整份文档,由客户端驱动同步
        'userNotes' => new stdClass(),
        // 笔记文档乐观并发修订号:{userId: int},语义与 userChatRevisions 一致
        'userNoteRevisions' => new stdClass(),
        // 笔记分享:{token: {token, ownerId, noteId, mode, createdAt}},内容不快照、读取时按属主实时取
        'noteShares' => new stdClass(),
        // 在线工具箱:按用户拆成 tbox:{uid} 行(与 userNotes 同一套省写放大机制),
        // 值为 {items:[{id,title,html,createdAt,updatedAt}], tombs:{id:删除时间}} 整份文档,
        // 由客户端驱动同步。HTML 原样保存、不做清洗 —— 隔离靠打开时的沙箱,不靠改写内容。
        'userToolbox' => new stdClass(),
        // 工具箱文档乐观并发修订号:{userId: int},语义与 userNoteRevisions 一致
        'userToolboxRevisions' => new stdClass(),
        // 系统工具箱(所有人共用、由后台维护的那份):{cats:[{id,name}], items:[{id,cat,title,html,...}]}。
        // 量小(10 套内置工具约 30KB),不按用户拆行,整键一行存,与 assistants 等同类。
        // null 表示「还没种过」,由 tc_seed_system_toolbox 在首次运行时填入内置内容;
        // 种过之后(含被管理员删空)一律用库里的值,不会再塞回来。
        'sysToolbox' => null,
        // 用户设置(界面偏好/外观/群聊配置/生成参数等):按用户拆成 uset:{uid} 行,
        // 值为整份设置文档(含逐键更新时间戳),换设备登录即可恢复,无需重新设置
        'userSettings' => new stdClass(),
        // 设置文档乐观并发修订号:{userId: int},语义与 userChatRevisions 一致
        'userSettingsRevisions' => new stdClass(),
        'shares' => new stdClass(),
        'userGroups' => array(),
        'accessRules' => array(),
        'assistantCategories' => array(),
        'assistants' => array(),
        'packages' => array(),
        'redemptionCodes' => array(),
        'quotaLedger' => array(),
        'inviteCodes' => array(),
        // 模型元数据(上下文窗口/价格):按模型名索引的全局表,与供应商解耦。
        // 后台可手工维护,也可从 litellm 的 model_prices_and_context_window.json 同步。
        // 同一模型在多个供应商下复用时只需维护一份;source=manual 的条目不会被同步覆盖。
        'modelMeta' => new stdClass(),
        // 演示模式快照:演示管理员改动前的站点状态,到期后由 tc_demo_revert 还原
        'demoSnapshot' => null,
        // 演示还原标记:{userId: 时间戳},客户端据此整体采纳云端(见 tc_demo_revert)
        'demoReverted' => new stdClass(),
        // 在线聊天(IM):会话(单聊/群聊)元数据,量小整键存
        'imThreads' => new stdClass(),
        // 好友关系与好友请求:按用户拆成 friend:{uid} 行,值为 {friends:[], reqs:[]}
        'userFriends' => new stdClass(),
        // IM 已读游标:按用户拆成 imst:{uid} 行,值为 {lastRead:{threadId: msgId}}
        'userImState' => new stdClass(),
        // 会话消息:按会话拆成 immsg:{threadId} 行(与 note:{uid} 同一套省写放大机制),
        // 值为 {msgs:[{id,from,name,text,at,kind,...}]},只保留每个会话最近若干条
        'imMessages' => new stdClass(),
        // IM 删除留档:按会话拆成 imdel:{threadId} 行(与 chatdel:{uid} 同一套墓碑语义),
        // 双向删除的消息原文/整会话快照留在这里供管理员查看,清理才物理删除
        'imDeleted' => new stdClass(),
    );
}

function tc_is_demo_user($u) {
    return is_array($u) && !empty($u['demo']);
}

// 快照覆盖范围:演示管理员能改动的站点内容。settings 含公告/限流/思考等全部设置。
function tc_demo_snapshot_fields() {
    return array('settings', 'accessRules', 'providers', 'packages', 'assistants', 'defaultProviderId');
}

// 拍一张演示快照(改动前的状态),并按设置的有效期计时。
// 已有生效中的快照时不覆盖——必须保留最早那份作为还原基准。
// 但「生效中」的快照会随演示活动的继续而**顺延到期时间**(滑动窗口):
// 否则演示者正在进行的对话会被中途抹掉(表现为"刷新就没了")。
// $force=true 用于「把某个用户转为演示管理员」:以转为演示的那一刻作为还原原点,
// 强制重拍快照并重新计时,而不是沿用上一轮还没到期的旧基准。
function tc_demo_arm(&$db, $user, $force = false) {
    if (!tc_is_demo_user($user)) return false;
    $snap = isset($db['demoSnapshot']) ? $db['demoSnapshot'] : null;
    $minutes = (int) (isset($db['settings']['demoExpireMinutes']) ? $db['settings']['demoExpireMinutes'] : 10);
    $minutes = min(1440, max(1, $minutes ?: 10));
    $uid = isset($user['id']) ? (string) $user['id'] : '';
    $active = is_array($snap) && !empty($snap['expireAt']) && tc_now() < (int) $snap['expireAt'];
    if (!$force && $active) {
        // 属主发起的活动:把到期时间顺延到「现在 + 有效期」。
        // 别家演示账号占着生效快照时不顺延(同一时刻只维护一份快照)。
        if (isset($snap['userId']) && (string) $snap['userId'] === $uid) {
            $next = tc_now() + $minutes * 60000;
            if ($next > (int) $snap['expireAt']) {
                $db['demoSnapshot']['expireAt'] = $next;
                $db['demoSnapshot']['minutes'] = $minutes;
                return true;
            }
        }
        return false;
    }
    // 上一轮还原后遗留的基准:重建快照时必须沿用「最初的干净状态」,而不是把演示期间的
    // 改动当成新基准 —— 否则那些改动会被永久固化,再也清不掉。
    $prevBase = null;
    if (is_array($snap) && !empty($snap['userId']) && (string) $snap['userId'] === $uid) {
        $prevBase = $snap;
    } elseif (isset($db['demoBaseline']) && is_array($db['demoBaseline'])
        && !empty($db['demoBaseline']['userId']) && (string) $db['demoBaseline']['userId'] === $uid) {
        $prevBase = $db['demoBaseline'];
    }
    $snapshot = array(
        'expireAt' => tc_now() + $minutes * 60000,
        'userId' => $uid,
        'minutes' => $minutes,
    );
    foreach (tc_demo_snapshot_fields() as $k) {
        $snapshot[$k] = isset($db[$k]) ? $db[$k] : null;
    }
    // 演示管理员的「个人数据」同样在转换那一刻定格:自己的对话与额度,到期后一并恢复。
    $chatsMap = tc_assoc(isset($db['userChats']) ? $db['userChats'] : array());
    if ($prevBase !== null && array_key_exists('demoChats', $prevBase)) {
        $snapshot['demoChats'] = $prevBase['demoChats'];              // 沿用最初基准
        $snapshot['demoQuota'] = isset($prevBase['demoQuota']) ? $prevBase['demoQuota'] : 0;
        $snapshot['demoQuotaGrants'] = isset($prevBase['demoQuotaGrants']) ? $prevBase['demoQuotaGrants'] : array();
    } else {
        $snapshot['demoChats'] = ($uid !== '' && isset($chatsMap[$uid]) && is_array($chatsMap[$uid])) ? $chatsMap[$uid] : array();
        $snapshot['demoQuota'] = isset($user['quota']) ? $user['quota'] : 0;
        $snapshot['demoQuotaGrants'] = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    }
    // 已删除对话留档同样定格:演示期间删掉的对话(含墓碑)在还原时一并回到当时的状态,
    // 否则墓碑会把快照里恢复出来的对话再次过滤掉。
    if ($prevBase !== null && array_key_exists('demoDeletedChats', $prevBase)) {
        $snapshot['demoDeletedChats'] = $prevBase['demoDeletedChats'];
    } else {
        $delMap = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
        $snapshot['demoDeletedChats'] = ($uid !== '' && isset($delMap[$uid]) && is_array($delMap[$uid]))
            ? $delMap[$uid] : array('chats' => array(), 'tombs' => array());
    }
    $revMap = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
    $snapshot['demoChatRevision'] = isset($revMap[$uid]) ? (int) $revMap[$uid] : 0;
    // 工具箱同为「演示管理员的个人数据」:内容不在上面那六个站点字段里,不显式定格的话,
    // 演示期间存进去的工具在到期还原后会永久留下 —— 与笔记一样会变成清不掉的痕迹。
    $tboxMap = tc_assoc(isset($db['userToolbox']) ? $db['userToolbox'] : array());
    if ($prevBase !== null && array_key_exists('demoToolbox', $prevBase)) {
        $snapshot['demoToolbox'] = $prevBase['demoToolbox'];          // 沿用最初基准
    } else {
        $snapshot['demoToolbox'] = ($uid !== '' && isset($tboxMap[$uid]) && is_array($tboxMap[$uid]))
            ? $tboxMap[$uid] : array();
    }
    $tboxRevMap = tc_assoc(isset($db['userToolboxRevisions']) ? $db['userToolboxRevisions'] : array());
    $snapshot['demoToolboxRevision'] = isset($tboxRevMap[$uid]) ? (int) $tboxRevMap[$uid] : 0;
    $db['demoSnapshot'] = $snapshot;
    $db['settings']['demoMode'] = true;
    return true;
}

// 演示有效期到期后,把演示管理员改动过的内容还原为快照值
function tc_demo_revert(&$db) {
    $snap = isset($db['demoSnapshot']) ? $db['demoSnapshot'] : null;
    if (!is_array($snap) || empty($snap['expireAt'])) return false;
    if (tc_now() < (int) $snap['expireAt']) return false;
    if (isset($snap['settings']) && is_array($snap['settings'])) {
        $db['settings'] = tc_normalize_settings($snap['settings']);
    }
    foreach (array('accessRules', 'providers', 'packages', 'assistants') as $k) {
        if (isset($snap[$k]) && is_array($snap[$k])) $db[$k] = $snap[$k];
    }
    if (array_key_exists('defaultProviderId', $snap)) {
        $db['defaultProviderId'] = $snap['defaultProviderId'];
    }
    // 恢复演示管理员的个人数据(对话 / 额度)到转换那一刻。
    // 若该账号已被改回普通用户,则其数据保留、不还原(见需求:转普通用户后数据保留)。
    $uid = isset($snap['userId']) ? (string) $snap['userId'] : '';
    if ($uid !== '') {
        $stillDemo = false;
        foreach ($db['users'] as $u) {
            if (isset($u['id']) && (string) $u['id'] === $uid) { $stillDemo = !empty($u['demo']); break; }
        }
        if ($stillDemo) {
            if (array_key_exists('demoChats', $snap) && is_array($snap['demoChats'])) {
                $chatsMap = tc_assoc(isset($db['userChats']) ? $db['userChats'] : array());
                $chatsMap[$uid] = $snap['demoChats'];
                $db['userChats'] = tc_object_map($chatsMap);
                $revMap = tc_assoc(isset($db['userChatRevisions']) ? $db['userChatRevisions'] : array());
                $revMap[$uid] = (isset($revMap[$uid]) ? (int) $revMap[$uid] : 0) + 1;
                $db['userChatRevisions'] = tc_object_map($revMap);
            }
            // 删除留档/墓碑还原到快照时刻:演示期间的删除不再拦着被恢复的对话
            $delMap = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array());
            if (array_key_exists('demoDeletedChats', $snap) && is_array($snap['demoDeletedChats'])) {
                $delMap[$uid] = $snap['demoDeletedChats'];
            } else {
                unset($delMap[$uid]);
            }
            $db['userDeletedChats'] = tc_object_map($delMap);
            // 工具箱还原到转换那一刻(内容不在站点字段快照里,必须显式处理,否则演示期间
            // 存进去的工具会一直留着)
            $tboxMap = tc_assoc(isset($db['userToolbox']) ? $db['userToolbox'] : array());
            if (array_key_exists('demoToolbox', $snap) && is_array($snap['demoToolbox'])) {
                $tboxMap[$uid] = $snap['demoToolbox'];
            } else {
                unset($tboxMap[$uid]);
            }
            $db['userToolbox'] = tc_object_map($tboxMap);
            $tboxRevMap = tc_assoc(isset($db['userToolboxRevisions']) ? $db['userToolboxRevisions'] : array());
            $tboxRevMap[$uid] = (isset($tboxRevMap[$uid]) ? (int) $tboxRevMap[$uid] : 0) + 1;
            $db['userToolboxRevisions'] = tc_object_map($tboxRevMap);
            foreach ($db['users'] as &$u) {
                if (!isset($u['id']) || (string) $u['id'] !== $uid) continue;
                if (array_key_exists('demoQuota', $snap)) $u['quota'] = $snap['demoQuota'];
                if (array_key_exists('demoQuotaGrants', $snap)) $u['quotaGrants'] = $snap['demoQuotaGrants'];
                break;
            }
            unset($u);
        }
    }
    // 快照已消费:但把「最初的干净基准」留在 demoBaseline 里。
    // 演示管理员通常还会继续演示(继续聊天/改设置),下一轮 tc_demo_arm 必须沿用这份原始基准,
    // 否则会把演示期间的改动当成新基准固化下来,那些内容就永远清不掉了。
    $db['demoBaseline'] = array(
        'userId' => isset($snap['userId']) ? (string) $snap['userId'] : '',
        'demoChats' => array_key_exists('demoChats', $snap) ? $snap['demoChats'] : array(),
        'demoQuota' => array_key_exists('demoQuota', $snap) ? $snap['demoQuota'] : 0,
        'demoQuotaGrants' => array_key_exists('demoQuotaGrants', $snap) ? $snap['demoQuotaGrants'] : array(),
        'demoDeletedChats' => array_key_exists('demoDeletedChats', $snap) ? $snap['demoDeletedChats'] : array('chats' => array(), 'tombs' => array()),
        'demoToolbox' => array_key_exists('demoToolbox', $snap) ? $snap['demoToolbox'] : array(),
    );
    // 还原标记:客户端凭它识别「这是一次整体还原」,从而丢弃本地旧副本整体采纳云端。
    // 没有这个标记,浏览器里残留的旧对话会在下一次合并时把已还原的内容"复活"回服务端。
    if (isset($snap['userId']) && (string) $snap['userId'] !== '') {
        $map = tc_assoc(isset($db['demoReverted']) ? $db['demoReverted'] : array());
        $map[(string) $snap['userId']] = tc_now();
        $db['demoReverted'] = tc_object_map($map);
    }
    $db['demoSnapshot'] = null;
    return true;
}

// 采集快照覆盖字段的当前值(供真实管理员改动前后比对)
function tc_demo_capture($db) {
    $out = array();
    foreach (tc_demo_snapshot_fields() as $k) {
        $out[$k] = isset($db[$k]) ? $db[$k] : null;
    }
    return $out;
}

// 真实管理员改动生效后,只把「确实被动过的字段」写回快照基线。
// 这样真实管理员的修改成为新的还原基准(不会被演示到期还原冲掉),
// 又不会把演示管理员在其它字段上的在途改动一并固化。
function tc_demo_rebaseline(&$db, $before) {
    $snap = isset($db['demoSnapshot']) ? $db['demoSnapshot'] : null;
    if (!is_array($snap) || empty($snap['expireAt']) || !is_array($before)) return false;
    $changed = false;
    foreach (tc_demo_snapshot_fields() as $k) {
        $cur = isset($db[$k]) ? $db[$k] : null;
        $old = array_key_exists($k, $before) ? $before[$k] : null;
        if ($k === 'settings' && is_array($cur) && is_array($old)) {
            // settings 逐键比对:演示管理员在别的设置项上的改动不会被顺带固化
            $merged = isset($snap[$k]) && is_array($snap[$k]) ? $snap[$k] : array();
            foreach ($cur as $sk => $sv) {
                $ov = array_key_exists($sk, $old) ? $old[$sk] : null;
                if (tc_json_encode($ov) !== tc_json_encode($sv)) { $merged[$sk] = $sv; $changed = true; }
            }
            foreach ($old as $sk => $ov) {
                if (!array_key_exists($sk, $cur) && array_key_exists($sk, $merged)) { unset($merged[$sk]); $changed = true; }
            }
            $snap[$k] = $merged;
        } elseif (tc_json_encode($cur) !== tc_json_encode($old)) {
            $snap[$k] = $cur;
            $changed = true;
        }
    }
    if ($changed) $db['demoSnapshot'] = $snap;
    return $changed;
}

// 邀请码可用次数:未设置视为 1 次(老数据兼容),<0 表示不限次数
function tc_invite_max_uses($c) {
    if (!is_array($c) || !array_key_exists('maxUses', $c)) return 1;
    $n = (int) $c['maxUses'];
    if ($n < 0) return -1;
    return max(1, $n);
}

function tc_invite_used_count($c) {
    if (!is_array($c)) return 0;
    if (array_key_exists('usedCount', $c)) return max(0, (int) $c['usedCount']);
    return !empty($c['usedBy']) ? 1 : 0;
}

function tc_invite_is_usable($c) {
    if (!is_array($c) || empty($c['code'])) return false;
    $max = tc_invite_max_uses($c);
    if ($max < 0) return true;
    return tc_invite_used_count($c) < $max;
}

function tc_assoc($v) {
    if (is_object($v)) $v = (array) $v;
    return is_array($v) ? $v : array();
}

function tc_object_map($v) {
    if ($v instanceof stdClass) return $v;
    if (!is_array($v)) return new stdClass();
    $o = new stdClass();
    foreach ($v as $k => $val) $o->{$k} = $val;
    return $o;
}

function tc_group_by_id($db, $id) {
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (isset($g['id']) && (string) $g['id'] === (string) $id) return $g;
    }
    return null;
}

function tc_grant_group_all_globals(&$db, $gid) {
    $seen = array();
    foreach ((isset($db['accessRules']) ? $db['accessRules'] : array()) as $r) {
        if (isset($r['groupId']) && $r['groupId'] === $gid && isset($r['providerId'])) $seen[$r['providerId']] = true;
    }
    $added = false;
    foreach ((isset($db['providers']) ? $db['providers'] : array()) as $p) {
        if (!isset($p['scope']) || $p['scope'] !== 'global' || empty($p['id'])) continue;
        if (isset($seen[$p['id']])) continue;
        $db['accessRules'][] = array('id' => tc_uid(), 'groupId' => $gid, 'providerId' => $p['id'], 'modelIds' => array('*'));
        $added = true;
    }
    return $added;
}

// 新添加的全局供应商默认授权给全部用户组(含自定义组),即"新模型默认对所有分组开放"
function tc_grant_all_groups_provider(&$db, $providerId) {
    if (!$providerId) return;
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (empty($g['id'])) continue;
        $exists = false;
        foreach ($db['accessRules'] as $r) {
            if ($r['groupId'] === $g['id'] && $r['providerId'] === $providerId) { $exists = true; break; }
        }
        if ($exists) continue;
        $db['accessRules'][] = array('id' => tc_uid(), 'groupId' => $g['id'], 'providerId' => $providerId, 'modelIds' => array('*'));
    }
}

// 供应商新增模型时,把"本次新出现的模型 ID"补进该供应商已有的授权规则:
// 通配规则('*')本就覆盖新模型;显式清单只追加新模型,
// 不回填管理员此前刻意取消勾选的模型。
function tc_sync_new_models_access(&$db, $providerId, $newModelIds) {
    if (!is_array($newModelIds) || !$newModelIds) return;
    $add = array();
    foreach ($newModelIds as $mid) {
        $mid = (string) $mid;
        if ($mid !== '') $add[$mid] = true;
    }
    if (!$add) return;
    foreach ($db['accessRules'] as &$r) {
        if (!isset($r['providerId']) || $r['providerId'] !== $providerId) continue;
        $ids = isset($r['modelIds']) && is_array($r['modelIds']) ? $r['modelIds'] : array();
        if (!$ids || in_array('*', $ids, true)) continue;
        $changed = false;
        foreach (array_keys($add) as $mid) {
            if (!in_array($mid, $ids, true)) { $ids[] = $mid; $changed = true; }
        }
        if ($changed) $r['modelIds'] = array_values($ids);
    }
    unset($r);
}

function tc_find_builtin_group($db, $role) {
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (isset($g['role']) && $g['role'] === $role) return $g;
    }
    return null;
}

function tc_ensure_builtin_group(&$db, $role, $name) {
    $groups = isset($db['userGroups']) && is_array($db['userGroups']) ? $db['userGroups'] : array();
    $idx = -1;
    foreach ($groups as $i => $g) {
        if ((isset($g['role']) && $g['role'] === $role) || (isset($g['name']) && $g['name'] === $name)) {
            $idx = $i;
            break;
        }
    }
    $fresh = false;
    if ($idx < 0) {
        $db['userGroups'][] = array(
            'id' => tc_uid(), 'name' => $name, 'createdAt' => tc_now(),
            'builtin' => true, 'role' => $role,
        );
        $idx = count($db['userGroups']) - 1;
        $fresh = true;
    } else {
        if (empty($db['userGroups'][$idx]['builtin'])) $db['userGroups'][$idx]['builtin'] = true;
        if (!isset($db['userGroups'][$idx]['role']) || $db['userGroups'][$idx]['role'] !== $role) {
            $db['userGroups'][$idx]['role'] = $role;
        }
        if (!isset($db['userGroups'][$idx]['name']) || $db['userGroups'][$idx]['name'] !== $name) {
            $db['userGroups'][$idx]['name'] = $name;
        }
    }
    $gid = $db['userGroups'][$idx]['id'];
    if ($fresh) tc_grant_group_all_globals($db, $gid);
    return $gid;
}

function tc_ensure_default_group(&$db) {
    $userGid = tc_ensure_builtin_group($db, 'user', '默认用户组');
    $adminGid = tc_ensure_builtin_group($db, 'admin', '管理员');
    $guestGid = tc_ensure_builtin_group($db, 'guest', '游客');
    tc_grant_group_all_globals($db, $adminGid);
    foreach ($db['users'] as &$u) {
        $gid = isset($u['groupId']) ? (string) $u['groupId'] : '';
        if (!empty($u['admin'])) {
            if ($gid === '' || !tc_group_by_id($db, $gid)) $u['groupId'] = $adminGid;
        } elseif (!empty($u['guest'])) {
            // 游客账号固定归入游客组,便于后台按组限轮数与清理
            $u['groupId'] = $guestGid;
        } elseif ($gid === '' || !tc_group_by_id($db, $gid)) {
            $u['groupId'] = $userGid;
        }
    }
    unset($u);
    $current = isset($db['settings']['defaultGroupId']) ? (string) $db['settings']['defaultGroupId'] : '';
    if ($current === '' || $current === $adminGid || !tc_group_by_id($db, $current)) {
        $db['settings']['defaultGroupId'] = $userGid;
    }
    return true;
}

function tc_default_register_group($db) {
    $id = isset($db['settings']['defaultGroupId']) ? (string) $db['settings']['defaultGroupId'] : '';
    if ($id !== '' && tc_group_by_id($db, $id)) return $id;
    foreach ((isset($db['userGroups']) ? $db['userGroups'] : array()) as $g) {
        if (isset($g['name']) && $g['name'] === '默认用户组') return $g['id'];
    }
    return null;
}

// 系统工具箱种子:首次运行时把内置工具落库,之后完全交给后台增删改。
//
// 标记键只挡「重复种子」这一件事:管理员把内置工具全删了(存成 {cats:[],items:[]})也是
// 合法状态,标记已置位,下次不会再塞回来 —— 否则删了又长出来,没人能真正清空。
// 返回本次是否动过库(补了内容或补了标记,相对 store 里的状态都算变更):
// 调用方(引导流程)据此决定要不要立刻落库,见 tc_migrate_db 里的说明。
function tc_seed_system_toolbox(&$db) {
    if (!empty($db['toolboxSysSeeded'])) return false;
    $cur = isset($db['sysToolbox']) ? $db['sysToolbox'] : null;
    // 已经是合法文档(哪怕是空的 {cats:[],items:[]})就不动它,只补标记
    if (!is_array($cur) || !$cur) {
        require_once __DIR__ . '/toolbox-default.php';
        $db['sysToolbox'] = tc_toolbox_default_system();
    }
    $db['toolboxSysSeeded'] = true;
    return true;
}

function tc_migrate_db($raw) {
    $base = tc_empty_db();
    $db = array_merge($base, is_array($raw) ? $raw : array());
    // 默认值一次性迁移(v2.0.52):把「仍等于旧默认值」的存量设置顺移到新默认值。
    // 仅当字段确实存在且等于旧默认值时才改——管理员自定义过的值一律不动。
    // 用独立标记键避免重复执行(该键会由逐键比对机制自动落库)。
    if (empty($db['settingsMigrated52']) && isset($db['settings']) && is_array($db['settings'])) {
        if (array_key_exists('contextMessages', $db['settings']) && (int) $db['settings']['contextMessages'] === 40) {
            $db['settings']['contextMessages'] = 12;
        }
    }
    $db['settingsMigrated52'] = true;
    // 内置模型元数据(v2.0.132):常见模型的窗口/输出上限/价格开箱即用,
    // 省去管理员逐条手工录入。放在下面的 119 迁移之前:这样内置值先落库,
    // 119 就不会再为这些模型补「自动兜底」条目。用版本号做标记,便于以后扩表。
    if ((int) (isset($db['modelMetaBuiltinVersion']) ? $db['modelMetaBuiltinVersion'] : 0) < TC_MODEL_META_BUILTIN_VERSION) {
        tc_model_meta_seed_builtin($db);
        $db['modelMetaBuiltinVersion'] = TC_MODEL_META_BUILTIN_VERSION;
    }
    // 上限来源统一迁移(v2.0.119):此前 max_tokens/最大上下文可在「供应商模型项」与
    // 「对话设置」两处各配一份,现全部收归「模型元数据」表。这里的迁移保证存量配置不丢:
    //   1) 供应商里手填的 maxTokens/maxContext 写进元数据表(标 manual,不被同步覆盖);
    //   2) 供应商里已启用、但表里没有的模型,补一条自动兜底值并标记「待人工复核」,
    //      让它们立刻出现在后台表里可核对;
    //   3) 全局 maxOutputTokens 仅当表里该模型没有输出上限时兜底写入,之后该键即废弃。
    // 用独立标记键避免重复执行(该键会由逐键比对机制自动落库)。
    if (empty($db['metaMigrated119'])) {
        if (!isset($db['modelMeta']) || !is_array($db['modelMeta'])) $db['modelMeta'] = array();
        $legacyGlobalOut = 0;
        if (isset($db['settings']['maxOutputTokens']) && (int) $db['settings']['maxOutputTokens'] > 0) {
            $legacyGlobalOut = min(128000, max(256, (int) $db['settings']['maxOutputTokens']));
        }
        $enabledModels = array();
        foreach ((isset($db['providers']) && is_array($db['providers']) ? $db['providers'] : array()) as $p) {
            if (!is_array($p) || !isset($p['models']) || !is_array($p['models'])) continue;
            foreach ($p['models'] as $m) {
                if (!is_array($m) || empty($m['id'])) continue;
                $key = tc_model_meta_key($m['id']);
                if ($key === '' || strlen($key) > 200) continue;
                $mt = isset($m['maxTokens']) ? (int) $m['maxTokens'] : 0;
                $mc = isset($m['maxContext']) ? (int) $m['maxContext'] : 0;
                if ($mt > 0 || $mc > 0) {
                    // 手填值优先:并进已有条目(手工声明的渠道约束比同步来的参考值更可信)
                    $item = isset($db['modelMeta'][$key]) && is_array($db['modelMeta'][$key]) ? $db['modelMeta'][$key] : array();
                    $item['source'] = 'manual';
                    $item['needsReview'] = false;
                    if ($mt > 0) $item['maxOutputTokens'] = min(128000, max(256, $mt));
                    if ($mc > 0) $item['maxInputTokens'] = min(2000000, max(256, $mc));
                    $item['updatedAt'] = tc_now();
                    $db['modelMeta'][$key] = $item;
                } else {
                    // 没手填过:记下模型名,稍后统一补自动条目
                    $enabledModels[] = (string) $m['id'];
                }
            }
        }
        // 供应商里已启用的模型凡是表里没有的,一律补一条自动兜底值(与实际加模型时同一逻辑)。
        // 曾经生效的全局上限若还在,优先用它作为输出上限——迁移前后行为保持一致。
        $missing = array();
        foreach (array_unique($enabledModels) as $name) {
            $key = tc_model_meta_key($name);
            // 精确或包含匹配到现有条目的不补:渠道给模型加前缀/后缀时复用原条目
            if ($key !== '' && !isset($db['modelMeta'][$key]) && tc_model_meta_resolve($db, $name) === null) $missing[] = $name;
        }
        if ($missing) {
            if ($legacyGlobalOut > 0) {
                foreach ($missing as $name) {
                    $key = tc_model_meta_key($name);
                    $db['modelMeta'][$key] = tc_normalize_model_meta_item(array(
                        'maxInputTokens' => TC_MODEL_META_AUTO_CONTEXT,
                        'maxOutputTokens' => $legacyGlobalOut,
                        'source' => 'auto',
                        'needsReview' => true,
                        'enabled' => true,
                        'updatedAt' => tc_now(),
                    ));
                }
            } else {
                tc_model_meta_ensure_auto($db, $missing);
            }
        }
        unset($db['settings']['maxOutputTokens']);
        $db['metaMigrated119'] = true;
    }
    // 内置系统工具箱(v2.0.145):首次运行把 10 套常用小工具种进 sysToolbox(见 lib/toolbox-default.php)。
    // 迁移是在**读**请求里跑的,而读请求不落库(tc_db_commit 对读请求直接返回),只在这里改内存的话
    // 种子永远进不了库、每次请求都要重新装配一遍。所以把「动过库」记到全局变量上,由同样跑在
    // 写事务里的引导流程(tc_bootstrap_maybe)顺手写下去。
    if (tc_seed_system_toolbox($db)) {
        $GLOBALS['_tc_db_seed_dirty'] = true;
    }
    $db['version'] = TC_DB_VERSION;
    foreach (array('users', 'providers', 'userGroups', 'accessRules', 'assistantCategories', 'assistants', 'packages', 'redemptionCodes', 'quotaLedger', 'inviteCodes') as $k) {
        $db[$k] = isset($db[$k]) && is_array($db[$k]) ? array_values($db[$k]) : array();
    }
    tc_migrate_provider_keys($db);
    $db['userChats'] = tc_object_map(isset($db['userChats']) ? $db['userChats'] : array());
    // 已删除对话留档:老库里没有这个键(默认空);逐用户规整为 {chats:[], tombs:{}} 形状,
    // 避免半截数据(只有 chats 没有 tombs)在后续读写里取不到键而报错
    $delMap = array();
    foreach (tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : array()) as $uid => $row) {
        $row = tc_assoc($row);
        $delMap[$uid] = array(
            'chats' => isset($row['chats']) && is_array($row['chats']) ? array_values($row['chats']) : array(),
            'tombs' => tc_assoc(isset($row['tombs']) ? $row['tombs'] : array()),
        );
    }
    $db['userDeletedChats'] = tc_object_map($delMap);
    $db['shares'] = tc_object_map(isset($db['shares']) ? $db['shares'] : array());
    // AI 笔记:老库没有这些键(默认空);文档本体按用户拆行存储,这里只规整映射形状
    $db['userNotes'] = tc_object_map(isset($db['userNotes']) ? $db['userNotes'] : array());
    $db['userNoteRevisions'] = tc_object_map(isset($db['userNoteRevisions']) ? $db['userNoteRevisions'] : array());
    $db['noteShares'] = tc_object_map(isset($db['noteShares']) ? $db['noteShares'] : array());
    // 用户设置:同样是老库没有的键(默认空),按用户拆行存储,这里只规整映射形状
    $db['userSettings'] = tc_object_map(isset($db['userSettings']) ? $db['userSettings'] : array());
    $db['userSettingsRevisions'] = tc_object_map(isset($db['userSettingsRevisions']) ? $db['userSettingsRevisions'] : array());
    $stats = tc_assoc(isset($db['stats']) ? $db['stats'] : array());
    $votes = array();
    foreach (tc_assoc(isset($stats['modelVotes']) ? $stats['modelVotes'] : array()) as $model => $row) {
        $name = substr(trim((string) $model), 0, 80);
        if ($name === '') continue;
        $row = tc_assoc($row);
        $up = isset($row['up']) ? (int) $row['up'] : 0;
        $down = isset($row['down']) ? (int) $row['down'] : 0;
        if ($up < 0) $up = 0;
        if ($down < 0) $down = 0;
        if ($up === 0 && $down === 0) continue;
        $votes[$name] = array('up' => $up, 'down' => $down);
    }
    $db['stats'] = array(
        'totalCalls' => isset($stats['totalCalls']) ? (int) $stats['totalCalls'] : 0,
        'totalQuotaGiven' => isset($stats['totalQuotaGiven']) ? (int) $stats['totalQuotaGiven'] : 0,
        'callsByDay' => tc_object_map(isset($stats['callsByDay']) ? $stats['callsByDay'] : array()),
        'modelVotes' => tc_object_map($votes),
        'usageLedger' => tc_object_map(tc_assoc(isset($stats['usageLedger']) ? $stats['usageLedger'] : array())),
        'modelHealth' => tc_object_map(tc_assoc(isset($stats['modelHealth']) ? $stats['modelHealth'] : array())),
    );
    $db['settings'] = tc_normalize_settings(isset($db['settings']) ? $db['settings'] : null);
    $db['modelMeta'] = tc_normalize_model_meta(isset($db['modelMeta']) ? $db['modelMeta'] : array());
    unset($db['sessions']);
    foreach ($db['users'] as &$u) {
        if (!isset($u['tv']) || !is_numeric($u['tv'])) $u['tv'] = 0;
        if (isset($u['quota']) && (string) $u['quota'] === '-1') $u['quota'] = -1;
        elseif (!isset($u['quota']) || !is_numeric($u['quota'])) $u['quota'] = 0;
        if (!array_key_exists('email', $u)) $u['email'] = '';
        if (!array_key_exists('emailVerifiedAt', $u)) $u['emailVerifiedAt'] = 1;
        if (!array_key_exists('groupId', $u)) $u['groupId'] = null;
        $u['admin'] = !empty($u['admin']);
        $u['tools'] = tc_user_tools($u);
    }
    unset($u);
    foreach ($db['providers'] as $pi => &$p) {
        if (!isset($p['models']) || !is_array($p['models'])) $p['models'] = array();
        if (!isset($p['costPerCall']) || !is_numeric($p['costPerCall'])) $p['costPerCall'] = 1;
        if (!isset($p['scope']) || $p['scope'] !== 'global') $p['scope'] = 'user';
        if (!array_key_exists('enabled', $p)) $p['enabled'] = true;
        if (empty($p['createdAt'])) $p['createdAt'] = tc_now();
        // 供应商排序:旧数据按当前数组顺序补一个 order,之后可在后台调整
        if (!isset($p['order']) || !is_numeric($p['order'])) $p['order'] = $pi;
    }
    unset($p);
    // 旧数据补的 order 即原数组下标,顺序不变;已排过序的数据保持其顺序
    if (function_exists('tc_sort_providers')) $db['providers'] = tc_sort_providers($db['providers']);
    if (!empty($db['defaultProviderId'])) {
        $found = false;
        foreach ($db['providers'] as $p) {
            if ($p['id'] === $db['defaultProviderId']) { $found = true; break; }
        }
        if (!$found) $db['defaultProviderId'] = null;
    }
    tc_ensure_default_group($db);
    // 清理指向已不存在用户组的授权规则(旧版每次加载重生成组 ID 会留下这类孤儿规则)
    $validGroups = array();
    foreach ($db['userGroups'] as $g) if (!empty($g['id'])) $validGroups[(string) $g['id']] = true;
    $db['accessRules'] = array_values(array_filter($db['accessRules'], function ($r) use ($validGroups) {
        return is_array($r) && !empty($r['groupId']) && isset($validGroups[(string) $r['groupId']]);
    }));
    return $db;
}

function tc_db_file() { return tc_data_dir() . '/tinychat.sqlite'; }

// ---- 数据备份:data/backup/db-YYYYMMDD-HHMMSS.json,自动每日一份并按 backupKeep 轮换 ----
function tc_backup_dir() {
    $dir = tc_data_dir() . '/backup';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

function tc_backup_list() {
    $dir = tc_backup_dir();
    $out = array();
    foreach ((is_dir($dir) ? scandir($dir) : array()) as $f) {
        if (!preg_match('/^db-\d{8}-\d{6}(?:-[a-z0-9]{4})?\.json$/', (string) $f)) continue;
        $full = $dir . '/' . $f;
        // 统一用毫秒:filemtime 给的是秒,而全站时间基准 tc_now() 是毫秒。
        // 这里换算成毫秒,避免调用方(如 tc_backup_maybe 的间隔判断)把两种单位混着算。
        $out[] = array('name' => $f, 'size' => (int) @filesize($full), 'time' => ((int) @filemtime($full)) * 1000);
    }
    usort($out, function ($a, $b) { return $b['time'] - $a['time']; });
    return $out;
}

function tc_backup_create($db = null) {
    $name = 'db-' . date('Ymd-His') . '.json';
    if (is_file(tc_backup_dir() . '/' . $name)) {
        // 同一秒内多次备份:追加短随机后缀避免覆盖
        $name = 'db-' . date('Ymd-His') . '-' . substr(bin2hex(random_bytes(2)), 0, 4) . '.json';
    }
    try {
        $snapshot = $db !== null ? $db : tc_with_db(false, function ($d) { return $d; });
        $json = tc_json_encode($snapshot);
    } catch (Throwable $e) {
        return null;
    }
    if (file_put_contents(tc_backup_dir() . '/' . $name, $json, LOCK_EX) === false) return null;
    return $name;
}

function tc_backup_prune($settings) {
    $keep = isset($settings['backupKeep']) ? (int) $settings['backupKeep'] : 7;
    if ($keep < 1) $keep = 1;
    $list = tc_backup_list();
    foreach (array_slice($list, $keep) as $old) {
        @unlink(tc_backup_dir() . '/' . $old['name']);
    }
}

// 管理后台加载时惰性触发:距最近一份备份超过 24 小时(或还没有)就自动备份一次
function tc_backup_maybe($db) {
    $settings = isset($db['settings']) && is_array($db['settings']) ? $db['settings'] : array();
    if (empty($settings['backupEnabled'])) return;
    try {
        $list = tc_backup_list();
        if ($list && (tc_now() - (int) $list[0]['time']) < 24 * 3600 * 1000) return;
        if (tc_backup_create($db) !== null) tc_backup_prune($settings);
    } catch (Throwable $e) { /* 备份失败不影响主流程 */ }
}

function tc_backup_path($name) {
    if (!preg_match('/^db-\d{8}-\d{6}(?:-[a-z0-9]{4})?\.json$/', (string) $name)) return '';
    $full = tc_backup_dir() . '/' . $name;
    return is_file($full) ? $full : '';
}

// ---- 接口限流:滑动窗口(每用户每分钟) ----
// 计数按 key 分片存 data/ratelimit/{hash}.json:写锁只串行化同一用户,不同用户互不阻塞
function tc_rate_limit_file($key) {
    $dir = tc_data_dir() . '/ratelimit';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir . '/' . hash('sha256', (string) $key) . '.json';
}

// 限流计数文件按 IP/用户分片,公网部署下来源会持续增加;惰性清理:
// 以五十分之一的概率触发,删掉 1 小时没再写过的分片(限流窗口最长 1 分钟,远超即失效)
function tc_rate_limit_gc() {
    static $ran = false;
    if ($ran) return;
    $ran = true;
    if (random_int(1, 50) !== 1) return;
    $dir = tc_data_dir() . '/ratelimit';
    if (!is_dir($dir)) return;
    $cut = time() - 3600;
    foreach ((array) @scandir($dir) as $f) {
        if (substr((string) $f, -5) !== '.json') continue;
        $full = $dir . '/' . $f;
        if (@filemtime($full) < $cut) @unlink($full);
    }
}

// 读取-改-写 JSON 小文件,全程持锁。
// file_put_contents(..., LOCK_EX) 只锁「写」这一下,读在锁外:
// 并发的两个请求会同时读到旧内容,后写的那个把先写的改动整个盖子掉
// (登录失败计数、笔记附件索引、笔记 AI 配额都踩过)。这里读改写在同一把锁里。
function tc_json_mutate($file, $fn, $default = array()) {
    $fp = @fopen($file, 'c+');
    if (!$fp) return $default;
    @flock($fp, LOCK_EX);
    $raw = (string) stream_get_contents($fp);
    $cur = json_decode($raw, true);
    if (!is_array($cur)) $cur = $default;
    $next = $fn($cur);
    if ($next === null) {           // 回调返回 null = 不改也不写
        flock($fp, LOCK_UN);
        fclose($fp);
        return $cur;
    }
    // 覆盖写之前先截断:新内容比旧内容短时,不截断会留下旧尾巴,JSON 直接失效
    $json = tc_json_encode($next);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, $json);
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $next;
}

function tc_rate_limit_check($key, $limitPerMin, $windowMs = 60000) {
    $limit = (int) $limitPerMin;
    if ($limit <= 0 || $key === '') return true;
    tc_rate_limit_gc();
    $window = max(1000, (int) $windowMs);
    $fp = @fopen(tc_rate_limit_file($key), 'c+');
    // 计数存储不可用时放行而非拦截:磁盘满/目录不可写时若一律拒绝,
    // 整站会立刻全站不可用(比限流失效严重得多)。但要留下痕迹,方便排查。
    if (!$fp) { error_log('TinyChat: 限流计数不可写，本次请求未限流 (' . $key . ')'); return true; }
    @flock($fp, LOCK_EX);
    $data = json_decode((string) stream_get_contents($fp), true);
    $now = tc_now();
    $mine = array();
    foreach ((is_array($data) ? $data : array()) as $t) {
        if ((int) $t > $now - $window) $mine[] = (int) $t;
    }
    $allowed = count($mine) < $limit;
    if ($allowed) {
        $mine[] = $now;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, tc_json_encode($mine));
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $allowed;
}

// mbstring 属「建议安装」而非必需扩展(见 README 扩展表),但有几处直接调 mb_*:
// 没装的主机上会直接 Fatal error。这里统一走带兜底的包装(缺扩展时按字节近似)。
function tc_mb_len($s) {
    $s = (string) $s;
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}
function tc_mb_cut($s, $n) {
    $s = (string) $s;
    if ($n <= 0) return '';
    return function_exists('mb_substr') ? mb_substr($s, 0, $n, 'UTF-8') : substr($s, 0, $n);
}

// ---- 内容审核:本地敏感词表(每行一个,也支持逗号分隔),发送前对用户消息匹配 ----
function tc_moderation_words_text($raw) {
    $out = array();
    $seen = array();
    foreach (preg_split('/[\r\n,;，；]+/u', (string) $raw) as $w) {
        $w = trim((string) $w);
        if ($w === '' || tc_mb_len($w) > 100) continue;
        $k = strtolower($w);
        if (isset($seen[$k])) continue;
        $seen[$k] = true;
        $out[] = $w;
        if (count($out) >= TC_MODERATION_MAX_WORDS) break;
    }
    return implode("\n", $out);
}

function tc_moderation_hit($moderation, $text) {
    if (empty($moderation['enabled'])) return '';
    $words = (string) (isset($moderation['words']) ? $moderation['words'] : '');
    if (trim($words) === '') return '';
    $haystack = (string) $text;
    if ($haystack === '') return '';
    if (function_exists('mb_stripos')) {
        foreach (preg_split('/[\r\n]+/u', $words, -1, PREG_SPLIT_NO_EMPTY) as $w) {
            if (mb_stripos($haystack, $w, 0, 'UTF-8') !== false) return $w;
        }
        return '';
    }
    $haystack = strtolower($haystack);
    foreach (preg_split('/[\r\n]+/u', $words, -1, PREG_SPLIT_NO_EMPTY) as $w) {
        if (strpos($haystack, strtolower($w)) !== false) return $w;
    }
    return '';
}

// ---- 用户 API 密钥(sk-tc-...):哈希落库,仅创建时完整展示一次,用于 OpenAI 兼容出口 ----
function tc_api_key_generate() {
    return 'sk-tc-' . tc_uid(24);
}

function tc_api_key_hash($key) {
    return hash_hmac('sha256', (string) $key, tc_secret() . '|api-key-v1');
}

function tc_api_key_prefix($key) {
    return substr((string) $key, 0, 12);
}

// 按明文 Key 定位用户:key 哈希比对(每用户最多 5 把)。返回 ['userId','keyIndex'] 或 null
function tc_find_api_key_owner($db, $key) {
    if ((string) $key === '' || strpos((string) $key, 'sk-tc-') !== 0) return null;
    $hash = tc_api_key_hash($key);
    foreach ($db['users'] as $ui => $u) {
        if (empty($u['apiKeys']) || !is_array($u['apiKeys'])) continue;
        foreach ($u['apiKeys'] as $ki => $k) {
            if (!is_array($k) || !isset($k['hash'])) continue;
            if (hash_equals((string) $k['hash'], $hash)) return array('userId' => (string) $u['id'], 'keyIndex' => $ki);
        }
    }
    return null;
}

// ---- 数据库:SQLite(WAL 模式) ----
// 库表 store(k, v):顶层键各占一行(JSON 编码);userChats 例外——按用户拆成 chat:{uid} 行,
// 聊天保存只重写该用户自己的行。事务由 SQLite 原生保证,不再依赖 flock 与全量重写。
function tc_db() {
    static $pdo = null;
    if ($pdo !== null) return $pdo;
    if (!extension_loaded('pdo_sqlite')) throw new RuntimeException('主机缺少 pdo_sqlite 扩展，无法运行');
    $pdo = new PDO('sqlite:' . tc_db_file(), null, null, array(
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ));
    $pdo->exec('PRAGMA journal_mode=WAL');
    $pdo->exec('PRAGMA busy_timeout=5000');
    $pdo->exec('PRAGMA synchronous=NORMAL');
    $pdo->exec('CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    tc_db_import_legacy($pdo);
    return $pdo;
}

// 一次性导入旧版 db.json(存在且库为空时),导入成功后原文件改名留档
function tc_db_import_legacy($pdo) {
    $legacy = tc_data_dir() . '/db.json';
    if (!is_file($legacy)) return;
    $n = (int) $pdo->query('SELECT COUNT(*) FROM store')->fetchColumn();
    if ($n > 0) return;
    $json = json_decode((string) @file_get_contents($legacy), true);
    if (is_array($json) && isset($json['users']) && is_array($json['users']) && count($json['users']) > 0) {
        try {
            tc_db_write_snapshot($pdo, tc_migrate_db($json));
        } catch (Throwable $e) {
            return; // 导入失败保留原文件,继续以空库运行
        }
    }
    @rename($legacy, $legacy . '.imported-' . date('Ymd-His'));
}

// 从 store 表装配出业务数组(含迁移与默认值),userChats 保持 stdClass 形状
function tc_db_load_all($pdo) {
    list($db) = tc_db_load_with_baseline($pdo);
    return $db;
}

// 单遍装配:一次 SELECT 同时产出业务数组与逐行原始 JSON 基线。
// 此前装配与快照各做一次全表扫描,每个 tc_with_db 要读两遍库;合并后减半。
// 变更检测基线取自"迁移前"的原始存储;若取自迁移后,迁移过程新建的
// userGroups / defaultGroupId 会被视为"未变化"而永不落库,导致每次请求都生成
// 新的用户组 ID,授权规则随之全部失效。
function tc_db_load_with_baseline($pdo) {
    $db = tc_empty_db();
    $db['userChats'] = new stdClass();
    $db['userNotes'] = new stdClass();
    $db['userToolbox'] = new stdClass();
    $orig = array();
    $origChats = array();
    $origDeleted = array();
    $origNotes = array();
    $origSettings = array();
    $origMsgs = array();
    $origArch = array();
    $origToolbox = array();
    $rows = $pdo->query('SELECT k, v FROM store')->fetchAll();
    foreach ($rows as $row) {
        $k = (string) $row['k'];
        $raw = (string) $row['v'];
        if (strncmp($k, 'imdel:', 6) === 0) {
            $origArch[substr($k, 6)] = $raw;
            $val = json_decode($raw, true);
            if (is_array($val)) {
                $db['imDeleted']->{substr($k, 6)} = $val;
            }
            continue;
        }
        if (strncmp($k, 'immsg:', 6) === 0) {
            $origMsgs[substr($k, 6)] = $raw;
            $val = json_decode($raw, true);
            if (is_array($val)) {
                $db['imMessages']->{substr($k, 6)} = $val;
            }
            continue;
        }
        if (strncmp($k, 'chatdel:', 8) === 0) {
            $origDeleted[substr($k, 8)] = $raw;
            $val = json_decode($raw, true);
            if (is_array($val)) {
                $db['userDeletedChats']->{substr($k, 8)} = $val;
            }
            continue;
        }
        if (strncmp($k, 'chat:', 5) === 0) {
            $origChats[substr($k, 5)] = $raw;
            $val = json_decode($raw, true);
            if (is_array($val)) {
                $db['userChats']->{substr($k, 5)} = $val;
            }
            continue;
        }
        if (strncmp($k, 'note:', 5) === 0) {
            $origNotes[substr($k, 5)] = $raw;
            $val = json_decode($raw, true);
            if (is_array($val)) {
                $db['userNotes']->{substr($k, 5)} = $val;
            }
            continue;
        }
        if (strncmp($k, 'uset:', 5) === 0) {
            $origSettings[substr($k, 5)] = $raw;
            $val = json_decode($raw, true);
            if (is_array($val)) {
                $db['userSettings']->{substr($k, 5)} = $val;
            }
            continue;
        }
        if (strncmp($k, 'tbox:', 5) === 0) {
            $origToolbox[substr($k, 5)] = $raw;
            $val = json_decode($raw, true);
            if (is_array($val)) {
                $db['userToolbox']->{substr($k, 5)} = $val;
            }
            continue;
        }
        $orig[$k] = $raw;
        $val = json_decode($raw, true);
        if ($val === null && $raw !== 'null') continue;
        $db[$k] = $val;
    }
    return array(tc_migrate_db($db), $orig, $origChats, $origDeleted, $origNotes, $origSettings, $origMsgs, $origArch, $origToolbox);
}

// 整库快照写入(迁移导入 / 恢复备份用):清空后按顶层键落行
function tc_db_write_snapshot($pdo, $db) {
    $pdo->exec('DELETE FROM store');
    $ins = $pdo->prepare('INSERT INTO store (k, v) VALUES (:k, :v)');
    foreach ($db as $k => $v) {
        if ($k === 'userChats') {
            foreach (tc_assoc($v) as $uid => $row) {
                $ins->execute(array(':k' => 'chat:' . $uid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        if ($k === 'userNotes') {
            foreach (tc_assoc($v) as $uid => $row) {
                $ins->execute(array(':k' => 'note:' . $uid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        if ($k === 'userDeletedChats') {
            foreach (tc_assoc($v) as $uid => $row) {
                $ins->execute(array(':k' => 'chatdel:' . $uid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        if ($k === 'userSettings') {
            foreach (tc_assoc($v) as $uid => $row) {
                $ins->execute(array(':k' => 'uset:' . $uid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        if ($k === 'userToolbox') {
            foreach (tc_assoc($v) as $uid => $row) {
                $ins->execute(array(':k' => 'tbox:' . $uid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        if ($k === 'imMessages') {
            foreach (tc_assoc($v) as $tid => $row) {
                $ins->execute(array(':k' => 'immsg:' . $tid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        if ($k === 'imDeleted') {
            foreach (tc_assoc($v) as $tid => $row) {
                $ins->execute(array(':k' => 'imdel:' . $tid, ':v' => tc_json_encode($row)));
            }
            continue;
        }
        $ins->execute(array(':k' => $k, ':v' => tc_json_encode($v)));
    }
}

function tc_with_db($write, $fn) {
    // 完整性校验的第二道关卡:即使入口处的检查被移除,任何走数据库的请求也会在此拦截。
    // 结果按请求缓存,不产生额外文件读取开销。
    tc_integrity_guard();
    $pdo = tc_db();
    // 关键顺序:写事务必须**先** BEGIN IMMEDIATE 拿到写锁,再读整库。
    // 反过来(先读后 BEGIN)在 WAL 下读不会被写者阻塞,两个并发写者会各自基于
    // 同一份旧快照改内存,再先后提交——后提交的一方把自己那份「与旧快照的差异」
    // 写回去,前一方刚写的数据被整行覆盖(本函数下方的提交是逐键 diff 语义,
    // 只写「与读到的快照不同」的键),即经典的 lost update:
    // 实测 6 个并发预扣各 1 点,最终只扣了 1 点。
    // 先取锁后读,锁内读到的一定是最新状态,diff 也建立在最新基线上。
    if ($write) $pdo->exec('BEGIN IMMEDIATE');
    $db = null;
    $orig = $origChats = $origDeleted = $origNotes = $origSettings = $origMsgs = $origArch = $origToolbox = array();
    try {
        list($db, $orig, $origChats, $origDeleted, $origNotes, $origSettings, $origMsgs, $origArch, $origToolbox) = tc_db_load_with_baseline($pdo);
    } catch (Throwable $e) {
        if ($write) { try { $pdo->exec('ROLLBACK'); } catch (Throwable $e2) {} }
        throw $e;
    }
    $GLOBALS['_tc_db'] = &$db;
    // 出站代理随库一起带出来:网络请求可能在事务释放之后才发,那时读不到 db 了
    $GLOBALS['_tc_outbound_proxy'] = isset($db['settings']['outboundProxy']) ? (string) $db['settings']['outboundProxy'] : '';
    $GLOBALS['_tc_demo_before'] = null;
    $GLOBALS['_tc_db_ctx'] = array(
        'write' => $write, 'committed' => false, 'pdo' => $pdo,
        'orig' => $orig, 'origChats' => $origChats, 'origDeleted' => $origDeleted,
        'origNotes' => $origNotes, 'origSettings' => $origSettings,
        'origMsgs' => $origMsgs, 'origArch' => $origArch, 'origToolbox' => $origToolbox,
    );
    try {
        $ret = $fn($db);
        tc_db_commit();
        return $ret;
    } catch (Throwable $e) {
        if (empty($GLOBALS['_tc_db_ctx']['committed'])) {
            try { $pdo->exec('ROLLBACK'); } catch (Throwable $e2) {}
            $GLOBALS['_tc_db_ctx']['committed'] = true;
        }
        throw $e;
    } finally {
        tc_db_release();
    }
}

function tc_db_skip_write() {
    if (empty($GLOBALS['_tc_db_ctx']) || !empty($GLOBALS['_tc_db_ctx']['committed'])) return;
    $GLOBALS['_tc_db_ctx']['committed'] = true;
    if (!empty($GLOBALS['_tc_db_ctx']['write'])) {
        try { $GLOBALS['_tc_db_ctx']['pdo']->exec('ROLLBACK'); } catch (Throwable $e) {}
    }
}

// 提交:只写发生变化的行(逐键比对),userChats 按用户粒度比对
function tc_db_commit() {
    if (empty($GLOBALS['_tc_db_ctx']) || !empty($GLOBALS['_tc_db_ctx']['committed'])) return;
    $ctx = &$GLOBALS['_tc_db_ctx'];
    $ctx['committed'] = true;
    $pdo = $ctx['pdo'];
    if (empty($ctx['write'])) return; // 读请求不落库
    try {
        $db = $GLOBALS['_tc_db'];
        // 真实管理员改动生效后,把被改动的字段写回演示快照基线
        if (!empty($GLOBALS['_tc_demo_before']) && isset($db['demoSnapshot'])) {
            tc_demo_rebaseline($db, $GLOBALS['_tc_demo_before']);
        }
        $GLOBALS['_tc_demo_before'] = null;
        $ups = $pdo->prepare('INSERT INTO store (k, v) VALUES (:k, :v) ON CONFLICT(k) DO UPDATE SET v = :v2');
        $del = $pdo->prepare('DELETE FROM store WHERE k = :k');
        $newChats = tc_assoc(isset($db['userChats']) ? $db['userChats'] : null);
        $newDeleted = tc_assoc(isset($db['userDeletedChats']) ? $db['userDeletedChats'] : null);
        $newNotes = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : null);
        $newSettings = tc_assoc(isset($db['userSettings']) ? $db['userSettings'] : null);
        $newToolbox = tc_assoc(isset($db['userToolbox']) ? $db['userToolbox'] : null);
        $newMsgs = tc_assoc(isset($db['imMessages']) ? $db['imMessages'] : null);
        $newArch = tc_assoc(isset($db['imDeleted']) ? $db['imDeleted'] : null);
        $origDeleted = isset($ctx['origDeleted']) ? $ctx['origDeleted'] : array();
        $origNotes = isset($ctx['origNotes']) ? $ctx['origNotes'] : array();
        $origSettings = isset($ctx['origSettings']) ? $ctx['origSettings'] : array();
        $origToolbox = isset($ctx['origToolbox']) ? $ctx['origToolbox'] : array();
        $origMsgs = isset($ctx['origMsgs']) ? $ctx['origMsgs'] : array();
        $origArch = isset($ctx['origArch']) ? $ctx['origArch'] : array();
        foreach ($db as $k => $v) {
            if ($k === 'userChats') {
                foreach ($newChats as $uid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($ctx['origChats'][$uid]) && $ctx['origChats'][$uid] === $json) continue;
                    $ups->execute(array(':k' => 'chat:' . $uid, ':v' => $json, ':v2' => $json));
                }
                foreach ($ctx['origChats'] as $uid => $json) {
                    if (!array_key_exists($uid, $newChats)) $del->execute(array(':k' => 'chat:' . $uid));
                }
                continue;
            }
            if ($k === 'userNotes') {
                foreach ($newNotes as $uid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($origNotes[$uid]) && $origNotes[$uid] === $json) continue;
                    $ups->execute(array(':k' => 'note:' . $uid, ':v' => $json, ':v2' => $json));
                }
                foreach ($origNotes as $uid => $json) {
                    if (!array_key_exists($uid, $newNotes)) $del->execute(array(':k' => 'note:' . $uid));
                }
                continue;
            }
            if ($k === 'userDeletedChats') {
                foreach ($newDeleted as $uid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($origDeleted[$uid]) && $origDeleted[$uid] === $json) continue;
                    $ups->execute(array(':k' => 'chatdel:' . $uid, ':v' => $json, ':v2' => $json));
                }
                foreach ($origDeleted as $uid => $json) {
                    if (!array_key_exists($uid, $newDeleted)) $del->execute(array(':k' => 'chatdel:' . $uid));
                }
                continue;
            }
            if ($k === 'userSettings') {
                foreach ($newSettings as $uid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($origSettings[$uid]) && $origSettings[$uid] === $json) continue;
                    $ups->execute(array(':k' => 'uset:' . $uid, ':v' => $json, ':v2' => $json));
                }
                foreach ($origSettings as $uid => $json) {
                    if (!array_key_exists($uid, $newSettings)) $del->execute(array(':k' => 'uset:' . $uid));
                }
                continue;
            }
            if ($k === 'userToolbox') {
                foreach ($newToolbox as $uid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($origToolbox[$uid]) && $origToolbox[$uid] === $json) continue;
                    $ups->execute(array(':k' => 'tbox:' . $uid, ':v' => $json, ':v2' => $json));
                }
                foreach ($origToolbox as $uid => $json) {
                    if (!array_key_exists($uid, $newToolbox)) $del->execute(array(':k' => 'tbox:' . $uid));
                }
                continue;
            }
            if ($k === 'imMessages') {
                foreach ($newMsgs as $tid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($origMsgs[$tid]) && $origMsgs[$tid] === $json) continue;
                    $ups->execute(array(':k' => 'immsg:' . $tid, ':v' => $json, ':v2' => $json));
                }
                foreach ($origMsgs as $tid => $json) {
                    if (!array_key_exists($tid, $newMsgs)) $del->execute(array(':k' => 'immsg:' . $tid));
                }
                continue;
            }
            if ($k === 'imDeleted') {
                foreach ($newArch as $tid => $row) {
                    $json = tc_json_encode($row);
                    if (isset($origArch[$tid]) && $origArch[$tid] === $json) continue;
                    $ups->execute(array(':k' => 'imdel:' . $tid, ':v' => $json, ':v2' => $json));
                }
                foreach ($origArch as $tid => $json) {
                    if (!array_key_exists($tid, $newArch)) $del->execute(array(':k' => 'imdel:' . $tid));
                }
                continue;
            }
            $json = tc_json_encode($v);
            if (isset($ctx['orig'][$k]) && $ctx['orig'][$k] === $json) continue;
            $ups->execute(array(':k' => $k, ':v' => $json, ':v2' => $json));
        }
        foreach ($ctx['orig'] as $k => $json) {
            if (!array_key_exists($k, $db)) $del->execute(array(':k' => $k));
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        try { $pdo->exec('ROLLBACK'); } catch (Throwable $e2) {}
        throw new RuntimeException('数据库写入失败: ' . $e->getMessage());
    }
}

function tc_db_release() {
    tc_db_commit();
    unset($GLOBALS['_tc_db'], $GLOBALS['_tc_db_ctx']);
}

// 入口引导(建管理员/内置助手/演示还原)低频触发。
// 这些种子逻辑是幂等的,但每个请求都为此全量装配一次数据库代价太高;
// 满足任一条件才真正执行:从未跑过、版本变更(在线更新/恢复备份后)、距上次超过 5 分钟、
// 或演示快照已到期(还原是时间敏感的,不能等 5 分钟窗口)。
// 到期检测用单行主键查询(微秒级),不装配全库;直接改库/恢复备份的场景也能感知。
// 标记存 data/.bootstrap(不经数据库);种子未跑的窗口内极端情况最多延迟 5 分钟补上。
function tc_bootstrap_maybe($fn) {
    $file = tc_data_dir() . '/.bootstrap';
    $j = json_decode((string) @file_get_contents($file), true);
    if (is_array($j)) {
        $fresh = (tc_now() - (isset($j['t']) ? (int) $j['t'] : 0)) < 5 * 60 * 1000;
        $sameVer = (string) (isset($j['v']) ? $j['v'] : '') === TC_VERSION;
        if ($fresh && $sameVer && !tc_demo_revert_due()) return;
    }
    $fn();
    @file_put_contents($file, tc_json_encode(array('v' => TC_VERSION, 't' => tc_now())), LOCK_EX);
}

// 演示快照是否已到期待还原(单行查询;任何异常按「未到期」处理,不阻塞引导)
function tc_demo_revert_due() {
    try {
        $st = tc_db()->prepare('SELECT v FROM store WHERE k = ?');
        $st->execute(array('demoSnapshot'));
        $row = $st->fetchColumn();
        if ($row === false || $row === null) return false;
        $snap = json_decode((string) $row, true);
        return is_array($snap) && !empty($snap['expireAt']) && tc_now() >= (int) $snap['expireAt'];
    } catch (Throwable $e) {
        return false;
    }
}

function tc_secret() {
    static $secret = null;
    if ($secret !== null) return $secret;
    $fromCfg = tc_cfg('jwt_secret');
    if ($fromCfg) {
        $secret = (string) $fromCfg;
        return $secret;
    }
    $file = tc_data_dir() . '/secret';
    // 首次生成必须持锁再判空:并发请求若各自生成一份,文件里存的是最后写的那份,
    // 而先写的那份已经被用来签 JWT / 加密供应商密钥 —— 之后这些数据全都解不开。
    // 'c+' 不截断,配合 flock 保证「检查-生成-写入」原子。
    $fp = @fopen($file, 'c+');
    if ($fp) {
        @flock($fp, LOCK_EX);
        $cur = trim((string) stream_get_contents($fp));
        if ($cur !== '') {
            $secret = $cur;
        } else {
            $secret = tc_uid(32);
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, $secret);
            fflush($fp);
        }
        @flock($fp, LOCK_UN);
        fclose($fp);
        @chmod($file, 0600); // JWT 签名密钥,仅限 PHP 进程可读
        return $secret;
    }
    // 打不开(目录不可写)时退回原行为,至少让本次请求能跑下去
    if (is_file($file)) {
        $secret = trim((string) file_get_contents($file));
        if ($secret !== '') return $secret;
    }
    $secret = tc_uid(32);
    @file_put_contents($file, $secret, LOCK_EX);
    @chmod($file, 0600);
    return $secret;
}

function tc_jwt_sign($payload) {
    $header = tc_b64url(tc_json_encode(array('alg' => 'HS256', 'typ' => 'JWT')));
    $body = tc_b64url(tc_json_encode($payload));
    $sig = tc_b64url(hash_hmac('sha256', $header . '.' . $body, tc_secret(), true));
    return $header . '.' . $body . '.' . $sig;
}

function tc_jwt_verify($token) {
    $parts = explode('.', (string) $token);
    if (count($parts) !== 3) return null;
    list($h, $b, $s) = $parts;
    $expect = tc_b64url(hash_hmac('sha256', $h . '.' . $b, tc_secret(), true));
    if (!hash_equals($expect, $s)) return null;
    $json = tc_b64url_decode($b);
    $payload = json_decode($json, true);
    if (!is_array($payload)) return null;
    // 有效期在这里统一把关:签名只证明「是我们签发的」,不代表「还能用」。
    // 以前只有会话令牌在调用处查 exp,一次性票据(登录/绑定)全都漏检,
    // 导致票据被记录后可以无限期重放。签发处一律带 exp,所以在这里拒绝是安全的。
    if (empty($payload['exp']) || (int) $payload['exp'] < tc_now()) return null;
    return $payload;
}

function tc_hash_password($password, $salt) {
    return hash_pbkdf2('sha256', substr((string) $password, 0, 256), $salt, TC_PBKDF2_ITER, 64, false);
}

function tc_verify_password($password, $user) {
    $h = tc_hash_password($password, isset($user['salt']) ? $user['salt'] : '');
    $expect = isset($user['passwordHash']) ? (string) $user['passwordHash'] : '';
    if (strlen($h) !== strlen($expect) || $expect === '') return false;
    return hash_equals($expect, $h);
}

function tc_set_password(&$user, $password) {
    $salt = tc_uid(8);
    $user['salt'] = $salt;
    $user['passwordHash'] = tc_hash_password($password, $salt);
    $user['tv'] = (isset($user['tv']) ? (int) $user['tv'] : 0) + 1;
}

// SMTP 密码归一化。
// 两个真实的坑:① 粘贴时容易带上首尾空白(从网页复制的验证码/密码常带空格或换行);
// ② Google 的应用专用密码在页面上是「abcd efgh ijkl mnop」四组带空格的形式,
//    用户整段复制就会把空格一起存进去 —— 部分服务端会因此拒绝认证(535)。
// 对「去掉空白后恰好是 16 位小写字母」的值自动去掉内部空格(这正是 Google 应用专用密码的形态)。
function tc_smtp_normalize_password($pw) {
    $pw = trim((string) $pw);
    if ($pw === '') return '';
    $stripped = preg_replace('/\s+/', '', $pw);
    if (is_string($stripped) && $stripped !== $pw && preg_match('/^[a-z]{16}$/', $stripped)) {
        return $stripped;
    }
    return $pw;
}

// 已知邮箱服务商的专属排查提示(认证被拒时给出,直接可执行)
function tc_smtp_provider_hint($host, $authUser = '') {
    // 服务商判定优先看用户名域名(用户填的 smtp 主机可能是别名或自建域名)
    $u = strtolower((string) $authUser);
    $hint = strpos($u, '@') !== false ? substr($u, strpos($u, '@') + 1) : '';
    $h = $hint !== '' ? $hint : strtolower((string) $host);
    if (strpos($h, 'gmail') !== false || strpos($h, 'googlemail') !== false) {
        return "\nGmail 请依次核对：\n"
            . "① 「用户名」必须是完整 Gmail 地址，且与创建应用专用密码的那个账号一致——若你在 Google 账号页顶部切换过账号（网址带 /u/2 这类后缀），很容易把 A 账号的密码配到 B 账号上；\n"
            . "② 「密码」必须是 16 位应用专用密码（形如 abcd efgh ijkl mnop），不是 Google 账号登录密码；\n"
            . "③ 该账号必须已开启两步验证——关闭后应用专用密码会立即失效；\n"
            . "④ 若之后改过 Google 账号密码，所有应用专用密码会被吊销，需要重新生成；\n"
            . "⑤ 端口建议：SSL 用 465、STARTTLS 用 587。";
    }
    if (strpos($h, 'qq.com') !== false || strpos($h, 'exmail') !== false) {
        return "\nQQ 邮箱请核对：「密码」必须是在「设置 → 账户 → POP3/IMAP/SMTP 服务」里生成的 16 位授权码（不是 QQ 登录密码），并确认已开启 SMTP 服务。端口建议：SSL 465 或 STARTTLS 587。";
    }
    if (strpos($h, '163.com') !== false || strpos($h, '126.com') !== false || strpos($h, 'yeah.net') !== false) {
        return "\n网易邮箱请核对：「密码」必须是客户端授权码（在「设置 → POP3/SMTP/IMAP」中开启服务并生成），不是登录密码；「用户名」需为完整邮箱地址。端口建议：SSL 465 或 STARTTLS 994/587。";
    }
    if (strpos($h, 'outlook') !== false || strpos($h, 'office365') !== false || strpos($h, 'hotmail') !== false) {
        return "\nOutlook / Microsoft 365 请核对：账号需已开启两步验证，并使用「应用密码」；若组织启用了安全默认值，SMTP AUTH 默认被禁用，需要管理员在后台为该邮箱启用 SMTP AUTH。端口：STARTTLS 587。";
    }
    return '';
}

function tc_mail_send($settings, $to, $subject, $html, $text = '', &$err = null) {
    $err = '';
    $smtp = isset($settings['smtp']) && is_array($settings['smtp']) ? $settings['smtp'] : array();
    if (empty($smtp['host'])) { $err = '未配置 SMTP 服务器：请先在「用户验证」页填写并保存 SMTP 配置'; return false; }
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) { $err = '收件邮箱无效'; return false; }
    $from = str_replace(array("\r", "\n"), '', $smtp['fromEmail'] ?: $smtp['username']);
    $fromName = str_replace(array("\r", "\n"), '', $smtp['fromName'] ?: 'TinyChat');
    $subject = str_replace(array("\r", "\n"), '', $subject);
    // 显示名含非 ASCII(中文站点名)时必须按 RFC 2047 编码,否则部分收件服务器拒信或显示乱码
    if (preg_match('/[^\x20-\x7E]/', $fromName)) {
        $fromName = '=?UTF-8?B?' . base64_encode($fromName) . '?=';
    }
    if (!filter_var($from, FILTER_VALIDATE_EMAIL)) { $err = '发件人邮箱无效（' . ($from === '' ? '未填写' : $from) . '）：请填写有效的发件人地址，或先填写 SMTP 用户名作为回退'; return false; }
    // 归一化密码(去首尾空白;Google 应用专用密码去掉内部空格),避免把复制的空格一起拿去认证
    $authUser = trim((string) (isset($smtp['username']) ? $smtp['username'] : ''));
    $authPass = tc_smtp_normalize_password(isset($smtp['password']) ? $smtp['password'] : '');
    // 填了用户名却没密码 = 必然 535,提前给出可读原因,而不是让服务端回一句看不懂的英文
    if ($authUser !== '' && $authPass === '') {
        $err = '已填写 SMTP 用户名但密码为空：请把邮箱服务商提供的「授权码 / 应用专用密码」填入密码框后重新保存';
        return false;
    }
    // 正文里单独成行的「.」会被 SMTP 当成 DATA 结束(RFC 5321 transparency),必须转义成「..」
    $payload = preg_replace('/(^|\r\n)\./', '$1..', (string) $html);
    $body = "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nFrom: " . $fromName . " <" . $from . ">\r\nTo: " . $to . "\r\nSubject: =?UTF-8?B?" . base64_encode($subject) . "?=\r\n\r\n" . $payload . "\r\n.";
    $transport = $smtp['encryption'] === 'ssl' ? 'ssl://' : '';
    $deadline = microtime(true) + 20; // 整体预算:超过就主动放弃并报错,避免被网关超时截断成 502 HTML 页
    $connectAt = microtime(true);
    $fp = @stream_socket_client($transport . $smtp['host'] . ':' . (int) $smtp['port'], $errno, $errstr, 6);
    $connectMs = (int) round((microtime(true) - $connectAt) * 1000);
    if (!$fp) {
        // 连接失败即失败:不要回退到 mail()。PHP 的 mail() 在多数环境下返回 true
        // 却把邮件丢给不存在的本地 MTA,会让接口报「发送成功」而用户永远收不到,
        // 同时把这里的真实原因(端口不通/域名解析失败)吞掉,导致完全无法排查。
        // $errstr 可能带本地编码(中文系统),统一清洗成合法 UTF-8 再拼进消息。
        $raw = tc_utf8_clean($errstr !== '' ? $errstr : '连接超时');
        $target = $smtp['host'] . ':' . (int) $smtp['port'];
        $isResolver = (bool) preg_match('/getaddrinfo|php_network_getaddresses|Name or service not known|no such host|不知道这样的主机/i', $raw);
        // 超时(耗满 8 秒)= 防火墙/主机商静默丢包,这是「端口被屏蔽」最典型的特征;
        // 立即被拒 = 目标端口上没有服务在听。两者给不同的处置建议。
        $isTimeout = ($connectMs >= 5000) || (bool) preg_match('/timed?\s*out|超时/i', $raw);
        if ($isResolver) {
            $err = '无法解析 SMTP 服务器域名「' . $smtp['host'] . '」：' . $raw
                . '。请检查域名拼写；若站点所在主机无法解析外网域名，请改用该邮箱服务商提供的 IP 地址。';
        } elseif ($isTimeout) {
            $err = '连接 SMTP 服务器超时（' . $target . '，等待 ' . round($connectMs / 1000, 1) . ' 秒无响应）。'
                . '目标端口没有回应，通常是被防火墙或主机商屏蔽了出站 SMTP 连接（很多虚拟主机默认封禁 25 / 465 / 587），'
                . '也可能是地址或端口填错。'
                . '建议依次尝试：① 换端口（SSL 常用 465、STARTTLS 常用 587、明文常用 25）；'
                . '② 向主机商确认是否允许对外发信，必要时申请放行或改用其提供的发信服务；'
                . '③ 换用其它邮箱服务商的 SMTP。';
        } else {
            $err = '连接 SMTP 服务器失败（' . $target . '，' . $raw . '）。'
                . '该端口上可能没有服务在监听，或被对方防火墙拒绝。'
                . '请核对地址与端口，并按加密方式选择对应端口：SSL→465、STARTTLS→587、无加密→25。';
        }
        return false;
    }
    stream_set_timeout($fp, 8);
    $lastLine = '';
    $readTimedOut = false;
    // SMTP 服务器原文同样要清洗:中文服务商常用 GBK 回错误描述。
    // 单次读最多 8 秒;没读到时记下是不是超时,交给调用方决定继续等还是放弃。
    // 整体预算(20 秒)先到才算发送超时,否则一次 8 秒的静默会被误报成「没有响应」。
    $read = function () use ($fp, &$lastLine, &$readTimedOut, $deadline, &$err) {
        $out = '';
        $readTimedOut = false;
        $wait = (int) ceil($deadline - microtime(true));
        if ($wait < 1) { $err = '发送超时（累计超过 20 秒）：服务器响应过慢，请检查网络、SMTP 地址与端口是否正确'; return ''; }
        stream_set_timeout($fp, min(8, $wait));
        while (($line = fgets($fp, 512)) !== false) { $out .= $line; if (isset($line[3]) && $line[3] === ' ') break; }
        $meta = stream_get_meta_data($fp);
        if ($out === '' && !empty($meta['timed_out'])) $readTimedOut = true;
        if ($out === '' && microtime(true) >= $deadline) {
            $err = '发送超时（累计超过 20 秒）：服务器响应过慢，请检查网络、SMTP 地址与端口是否正确';
        }
        $lastLine = tc_utf8_clean(trim($out));
        return $out;
    };
    // SMTP 响应码 → 人话 + 排查方向(直接透传到后台,便于自查)
    $explain = function ($code, $line) use ($smtp, $authUser) {
        $hint = '';
        if ($code === 535 || $code === 534 || $code === 530) {
            $hint = '：用户名或密码不正确，或该账号要求使用「授权码」而非登录密码';
            $hint .= tc_smtp_provider_hint(isset($smtp['host']) ? $smtp['host'] : '', $authUser);
            // 明确回显本次用于登录的账号,方便核对「应用密码是不是这个账号的」
            $hint .= "
本次用于登录的账号：" . ($authUser !== '' ? $authUser : '（未填写用户名）');
        } elseif ($code === 550 || $code === 553 || $code === 501) {
            $hint = '：发件人地址被服务器拒绝，通常要求发件人邮箱与 SMTP 账号一致。本次发件人：' . (isset($smtp['fromEmail']) && $smtp['fromEmail'] !== '' ? $smtp['fromEmail'] : '(回退为用户名)');
        } elseif ($code === 554) $hint = '：邮件被判定为垃圾邮件或被策略拒绝，请检查发件人与内容';
        elseif ($code === 421 || $code === 450 || $code === 451 || $code === 452) $hint = '：服务器暂时不可用或触发限流，请稍后重试';
        elseif ($code === 500 || $code === 502 || $code === 504) $hint = '：服务器不支持该指令，请尝试切换加密方式（TLS / SSL / 无）';
        return 'SMTP 服务器拒绝了请求 (' . $code . ')' . $hint . '（服务器原文：' . $line . '）';
    };
    $ok = function ($response, $codes) use (&$err, &$lastLine, &$readTimedOut, $deadline, $explain) {
        if (trim((string) $response) === '') {
            if ($err === '' && $readTimedOut && microtime(true) < $deadline) return false; // 单次读超时,由外层续上
            if ($err === '') $err = 'SMTP 服务器没有响应（连接被中断或超时）';
            return false;
        }
        $code = (int) substr(trim((string) $response), 0, 3);
        if (!in_array((int) $code, array_map('intval', $codes), true)) { $err = $explain($code, $lastLine); return false; }
        return true;
    };
    // 单次读超时且总预算还没到:继续等,直到读到响应或累计超过 20 秒。
    // 每一条命令都走这里,否则只有开场问候能续等,后面某一步卡住仍会报成笼统的「没有响应」。
    $await = function ($codes) use ($read, $ok, &$readTimedOut, $deadline, &$err) {
        do {
            $got = $ok($read(), $codes);
            if ($got || $err !== '' || !$readTimedOut) return $got;
        } while (microtime(true) < $deadline);
        if ($err === '') $err = '发送超时（累计超过 20 秒）：服务器响应过慢，请检查网络、SMTP 地址与端口是否正确';
        return false;
    };
    $write = function ($cmd, $codes) use ($fp, $await, $deadline, &$err) {
        if (microtime(true) > $deadline) { $err = '发送超时（累计超过 20 秒）：服务器响应过慢，请检查网络、SMTP 地址与端口是否正确'; return false; }
        if (fwrite($fp, $cmd . "\r\n") === false) { $err = 'SMTP 连接中断'; return false; }
        return $await($codes);
    };
    if (!$await(array(220))) { fclose($fp); return false; }
    if (!$write('EHLO localhost', array(250))) { fclose($fp); return false; }
    if ($smtp['encryption'] === 'tls') { if (!$write('STARTTLS', array(220)) || @stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT) !== true || !$write('EHLO localhost', array(250))) { if ($err === '') $err = 'STARTTLS 加密握手失败：服务器可能不支持 STARTTLS，请把加密方式改为 SSL（端口通常 465）或「无」（端口通常 25）后重试'; fclose($fp); return false; } }
    if ($authUser !== '') { if (!$write('AUTH LOGIN', array(334)) || !$write(base64_encode($authUser), array(334)) || !$write(base64_encode($authPass), array(235))) { if ($err === '') { $err = 'SMTP 认证失败：请确认「用户名」填的是完整邮箱，且「密码」用的是该邮箱的 SMTP 授权码（多数邮箱不支持用登录密码直接发信）' . tc_smtp_provider_hint(isset($smtp['host']) ? $smtp['host'] : '', $authUser) . "
本次用于登录的账号：" . $authUser; } fclose($fp); return false; } }
    if (!$write('MAIL FROM:<' . $from . '>', array(250)) || !$write('RCPT TO:<' . $to . '>', array(250,251)) || !$write('DATA', array(354))) { if ($err === '') $err = 'SMTP 会话在传输阶段被中断（发件人或收件人未被服务器接受）'; fclose($fp); return false; }
    if (fwrite($fp, $body . "\r\n") === false || !$ok($read(), array(250))) { if ($err === '') $err = '邮件内容未被服务器接受：可能被判为垃圾邮件，请检查发件人域名与是否配置了 SPF/DKIM'; fclose($fp); return false; }
    $write('QUIT', array(221,250)); fclose($fp); return true;
}

function tc_issue_token($user, $settings = null) {
    $s = is_array($settings) ? $settings : array();
    $days = isset($s['sessionDays']) ? max(1, (int) $s['sessionDays']) : 7;
    $epoch = isset($s['authEpoch']) ? max(1, (int) $s['authEpoch']) : 1;
    return tc_jwt_sign(array(
        'sub' => $user['id'],
        'name' => $user['name'],
        'admin' => !empty($user['admin']),
        'tv' => isset($user['tv']) ? (int) $user['tv'] : 0,
        'ep' => $epoch,
        'exp' => tc_now() + $days * 24 * 3600 * 1000,
    ));
}

function tc_sanitize_user($u) {
    return array(
        'id' => $u['id'],
        'name' => $u['name'],
        // 展示"有效额度":已过期分账的剩余量即时扣减(落库回收在下次扣费/领取时完成)
        'quota' => isset($u['quota']) ? tc_quota_effective($u) : 0,
        // 生命周期调用计数(服务器台账口径,清空对话不影响)
        'totalCalls' => isset($u['totalCalls']) ? (int) $u['totalCalls'] : 0,
        'email' => isset($u['email']) ? $u['email'] : '',
        'emailVerified' => !empty($u['emailVerifiedAt']),
        'createdAt' => isset($u['createdAt']) ? $u['createdAt'] : 0,
        'lastSeen' => isset($u['lastSeen']) ? (float) $u['lastSeen'] : 0,
        'admin' => !empty($u['admin']),
        'demo' => !empty($u['demo']),
        'demoExpireAt' => !empty($u['demoExpireAt']) ? (int) $u['demoExpireAt'] : 0,
        'guest' => !empty($u['guest']),
        'lastIp' => isset($u['lastIp']) ? (string) $u['lastIp'] : '',
        'groupId' => isset($u['groupId']) ? $u['groupId'] : null,
        // 是否已设密码:第三方登录建号的用户为 false,前端据此隐藏「当前密码」并允许直接设置
        'hasPassword' => isset($u['passwordHash']) && (string) $u['passwordHash'] !== '',
    );
}

// 演示管理员看到的用户资料:登录 IP 与邮箱属用户隐私,演示场景一律不展示。
// 注意不要改动上面的 tc_sanitize_user 默认行为(真实管理员与用户本人仍需要这些字段)。
function tc_sanitize_user_for($viewer, $u) {
    $pub = tc_sanitize_user($u);
    if (is_array($viewer) && !empty($viewer['demo'])) {
        $pub['lastIp'] = '';
        $pub['email'] = '';
    }
    return $pub;
}

// 演示管理员敏感操作守卫:账号管理、查看对话、公告等一律拒绝,并给出统一提示。
// $reason 传入完整的拒绝原因文案。
function tc_demo_guard($user, $reason = '演示管理员不可修改此处') {
    if (is_array($user) && !empty($user['demo'])) {
        tc_fail(403, $reason);
    }
}

// 用户协议是管理员写的 HTML,会原样出现在公开页 /agreement。
// 规则与前端 renderer.js 的 sanitizeRenderedHtml 对齐:去掉可执行标签、事件属性和危险地址,
// 保留排版所需的普通标签。没有 DOM 扩展时退回纯文本,避免把未过滤的 HTML 发出去。
function tc_agreement_html($html) {
    $html = (string) $html;
    if (trim($html) === '') return '';
    if (!class_exists('DOMDocument')) {
        return htmlspecialchars(trim(strip_tags($html)), ENT_QUOTES, 'UTF-8');
    }
    $prev = libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    $wrapped = '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div id="tc-agreement">'
        . $html . '</div></body></html>';
    $loaded = $dom->loadHTML($wrapped, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    if (!$loaded) return htmlspecialchars(trim(strip_tags($html)), ENT_QUOTES, 'UTF-8');
    $root = $dom->getElementById('tc-agreement');
    if (!$root) return '';
    tc_agreement_sanitize_node($root);
    $out = '';
    foreach ($root->childNodes as $child) $out .= $dom->saveHTML($child);
    return $out;
}

function tc_agreement_sanitize_node($node) {
    $blocked = array(
        'script' => true, 'style' => true, 'iframe' => true, 'object' => true, 'embed' => true,
        'link' => true, 'meta' => true, 'base' => true, 'form' => true, 'input' => true,
        'textarea' => true, 'select' => true, 'button' => true, 'svg' => true, 'math' => true,
        'html' => true, 'head' => true, 'body' => true, 'frame' => true, 'frameset' => true,
    );
    $kids = array();
    foreach ($node->childNodes as $child) $kids[] = $child;
    foreach ($kids as $child) {
        if ($child->nodeType !== XML_ELEMENT_NODE) continue;
        $tag = strtolower($child->nodeName);
        if (isset($blocked[$tag])) {
            $child->parentNode->removeChild($child);
            continue;
        }
        if ($child->hasAttributes()) {
            $drop = array();
            foreach ($child->attributes as $attr) {
                $name = strtolower($attr->name);
                $val = (string) $attr->value;
                if (strpos($name, 'on') === 0 || $name === 'srcdoc' || $name === 'srcset') {
                    $drop[] = $attr->name;
                    continue;
                }
                if (($name === 'href' || $name === 'src' || $name === 'xlink:href') && !tc_agreement_url_ok($name, $val)) {
                    $drop[] = $attr->name;
                    continue;
                }
                if ($name === 'style' && !tc_agreement_style_ok($val)) $drop[] = $attr->name;
            }
            foreach ($drop as $name) $child->removeAttribute($name);
        }
        tc_agreement_sanitize_node($child);
    }
}

function tc_agreement_url_ok($name, $val) {
    // 浏览器解析 URL 前会剥掉制表符/换行等控制字符,「jav&#x09;ascript:」在 DOM 里
    // 就还原成 javascript:。判断协议前缀前先把空白与控制字符整体去掉,别让它们漏网。
    $v = preg_replace('/[\x00-\x20\x7f]/', '', (string) $val);
    if (!preg_match('/^(javascript|vbscript|data):/i', $v)) return true;
    if (($name === 'src' || $name === 'xlink:href')
        && preg_match('#^data:image/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=]+$#i', $v)) {
        return true;
    }
    return false;
}

function tc_agreement_style_ok($val) {
    return !preg_match('/expression\s*\(|@import|javascript\s*:|vbscript\s*:|behavior\s*:|url\s*\(/i', (string) $val);
}

function tc_touch_user(&$db, $userId) {
    $userId = (string) $userId;
    if ($userId === '') return;
    foreach ($db['users'] as &$u) {
        if (!isset($u['id']) || $u['id'] !== $userId) continue;
        $u['lastSeen'] = tc_now();
        // 记录最近来源 IP,后台用户列表据此展示与排查
        $ip = tc_client_ip();
        if ($ip !== '' && $ip !== 'unknown') $u['lastIp'] = $ip;
        return;
    }
    unset($u);
}

function tc_mask_key($k) {
    if (!$k) return '';
    if (strlen($k) <= 8) return '••••';
    return substr($k, 0, 4) . '••••••' . substr($k, -4);
}

// ---- 供应商 API Key 静态加密(AES-256-GCM,密钥来自 data/secret,密文与供应商/属主绑定) ----
function tc_provider_key_aad($p) {
    $owner = isset($p['ownerId']) && $p['ownerId'] ? (string) $p['ownerId'] : '';
    return (isset($p['id']) ? (string) $p['id'] : '') . '|' . $owner;
}

function tc_is_encrypted_secret($v) {
    return is_string($v) && (bool) preg_match('/^enc1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/', $v);
}

function tc_encrypt_secret($plaintext, $aad) {
    $key = hash_hmac('sha256', 'provider-apikey-v1', tc_secret(), true);
    $iv = random_bytes(12);
    $tag = '';
    $ct = openssl_encrypt((string) $plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, (string) $aad);
    if ($ct === false) return false;
    return 'enc1.' . tc_b64url($iv) . '.' . tc_b64url($tag) . '.' . tc_b64url($ct);
}

function tc_decrypt_secret($blob, $aad) {
    if (!is_string($blob) || strpos($blob, 'enc1.') !== 0) return (string) $blob;
    $parts = explode('.', $blob);
    if (count($parts) !== 4) return '';
    $iv = tc_b64url_decode($parts[1]);
    $tag = tc_b64url_decode($parts[2]);
    $ct = tc_b64url_decode($parts[3]);
    if ($iv === false || $tag === false || $ct === false || strlen($iv) !== 12 || strlen($tag) !== 16) return '';
    $key = hash_hmac('sha256', 'provider-apikey-v1', tc_secret(), true);
    $plain = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, (string) $aad);
    return $plain === false ? '' : $plain;
}

// 读取供应商明文 Key(默认/第一把):enc1. 密文按 AAD 解密,旧明文原样返回(兼容未迁移数据)
function tc_provider_key($p) {
    $k = isset($p['apiKey']) ? (string) $p['apiKey'] : '';
    if ($k === '') {
        // 多密钥结构:退回第一把密钥
        $keys = tc_provider_keys($p);
        if (!$keys) return '';
        $v = (string) $keys[0]['apiKey'];
        if ($v === '') return '';
        return strpos($v, 'enc1.') === 0 ? tc_decrypt_secret($v, tc_provider_key_aad($p)) : $v;
    }
    if (strpos($k, 'enc1.') === 0) return tc_decrypt_secret($k, tc_provider_key_aad($p));
    return $k;
}

// ---- 多密钥支持:一个供应商可配置多个 Key(各自命名),模型可绑定到指定 Key ----
// 归一化供应商的密钥列表。兼容旧的单 `apiKey` 字段:
// 返回 [['id'=>string,'name'=>string,'apiKey'=>密文或明文], ...];无任何 Key 时返回 []。
function tc_provider_keys($p) {
    $out = array();
    if (isset($p['keys']) && is_array($p['keys'])) {
        foreach ($p['keys'] as $k) {
            if (!is_array($k)) continue;
            $id = substr(trim((string) (isset($k['id']) ? $k['id'] : '')), 0, 40);
            if ($id === '') $id = 'k' . substr(hash('sha256', tc_json_encode($k)), 0, 6);
            $out[] = array(
                'id' => $id,
                'name' => substr(trim((string) (isset($k['name']) ? $k['name'] : '')), 0, 40),
                'apiKey' => isset($k['apiKey']) ? (string) $k['apiKey'] : '',
            );
        }
    }
    if (!$out && isset($p['apiKey']) && (string) $p['apiKey'] !== '') {
        // 旧数据:单 Key 视为一个无名密钥,固定 id 便于模型引用
        $out[] = array('id' => 'k0', 'name' => '', 'apiKey' => (string) $p['apiKey']);
    }
    return $out;
}

// 供应商的默认(第一个)密钥 id;无密钥返回 ''
function tc_provider_default_key_id($p) {
    $keys = tc_provider_keys($p);
    return $keys ? (string) $keys[0]['id'] : '';
}

// 取指定 keyId 的明文密钥;找不到时回退默认密钥
function tc_provider_key_by_id($p, $keyId) {
    $keyId = trim((string) $keyId);
    $keys = tc_provider_keys($p);
    if (!$keys) return '';
    $pick = null;
    if ($keyId !== '') {
        foreach ($keys as $k) if ((string) $k['id'] === $keyId) { $pick = $k; break; }
    }
    if (!$pick) $pick = $keys[0];
    $v = (string) $pick['apiKey'];
    if ($v === '') return '';
    if (strpos($v, 'enc1.') === 0) return tc_decrypt_secret($v, tc_provider_key_aad($p));
    return $v;
}

// 模型绑定的密钥 id 链(按调用优先级排序)。兼容旧的单个 keyId 字段。
function tc_model_key_ids($p, $modelId) {
    $id = trim((string) $modelId);
    if ($id === '' || empty($p['models']) || !is_array($p['models'])) return array();
    foreach ($p['models'] as $m) {
        if (!is_array($m)) continue;
        if ((string) (isset($m['id']) ? $m['id'] : '') !== $id) continue;
        $out = array();
        if (isset($m['keyIds']) && is_array($m['keyIds'])) {
            foreach ($m['keyIds'] as $kid) {
                $kid = trim((string) $kid);
                if ($kid !== '' && !in_array($kid, $out, true)) $out[] = $kid;
            }
        }
        if (!$out && isset($m['keyId']) && trim((string) $m['keyId']) !== '') $out[] = trim((string) $m['keyId']);
        return $out;
    }
    return array();
}

// 按模型解析出「按优先级排列的明文密钥链」:依次尝试,前一把失败自动换下一把。
// 链的组成:模型显式绑定的密钥(按顺序)在前;其后把该供应商「其余尚未入选的密钥」按供应商
// 顺序追加为备用。这样「配了多把 Key」就能天然获得多重保障——即使模型只绑了一把(或没绑),
// 第一把认证失败/连不上时也会自动尝试供应商下的其它 Key,无需逐个模型手动配链。
function tc_provider_key_chain($p, $modelId) {
    $out = array();
    $add = function ($plain) use (&$out) {
        $plain = (string) $plain;
        if ($plain !== '' && !in_array($plain, $out, true)) $out[] = $plain;
    };
    foreach (tc_model_key_ids($p, $modelId) as $kid) {
        $add(tc_provider_key_by_id($p, $kid));
    }
    // 追加供应商下其余密钥作备用(显式绑定的排在最前,保持用户设定的优先级)
    foreach (tc_provider_keys($p) as $k) {
        $add(tc_provider_key_by_id($p, (string) $k['id']));
    }
    if ($out) return $out;
    $def = tc_provider_key($p);
    return $def === '' ? array() : array($def);
}

// 按模型选用密钥:取链中的第一把(调用方需要回退时用 tc_provider_key_chain)。
// 这是「多 Key 下请求必须用用户设置的那把 Key」的落地点。
function tc_provider_key_for_model($p, $modelId) {
    $chain = tc_provider_key_chain($p, $modelId);
    return $chain ? $chain[0] : '';
}

// Key 名称唯一性校验(多 Key 时名称不可重复且不可为空),返回错误信息或 ''
function tc_provider_keys_error($keys) {
    if (count($keys) < 2) return '';
    $seen = array();
    foreach ($keys as $k) {
        $name = trim((string) (isset($k['name']) ? $k['name'] : ''));
        if ($name === '') return '配置了多个 Key 时，每个 Key 都需要填写名称';
        $low = strtolower($name);
        if (isset($seen[$low])) return 'Key 名称不能重复：' . $name;
        $seen[$low] = true;
    }
    return '';
}

// 将明文 Key 加密后写入供应商记录;失败时返回 false 且不改动记录
function tc_provider_set_key(&$p, $plain) {
    $enc = tc_encrypt_secret($plain, tc_provider_key_aad($p));
    if ($enc === false) return false;
    $p['apiKey'] = $enc;
    return true;
}

function tc_migrate_provider_keys(&$db) {
    if (!isset($db['providers']) || !is_array($db['providers'])) return;
    foreach ($db['providers'] as &$p) {
        if (!is_array($p) || !isset($p['apiKey']) || !is_string($p['apiKey']) || $p['apiKey'] === '') continue;
        if (strpos($p['apiKey'], 'enc1.') === 0) continue;
        tc_provider_set_key($p, $p['apiKey']);
    }
    unset($p);
}

function tc_client_ip() {
    // 仅在 config.php 显式声明 trust_proxy => true(部署在可信反代后)时才采信
    // X-Forwarded-For;直连部署下盲信该头等于允许任何人伪造 IP 绕过按 IP 限流
    if (tc_cfg('trust_proxy') && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        return trim($parts[0]);
    }
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
}

function tc_bearer() {
    $h = '';
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) $h = $_SERVER['HTTP_AUTHORIZATION'];
    elseif (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) $h = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    elseif (function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        foreach ($headers as $k => $v) {
            if (strtolower($k) === 'authorization') { $h = $v; break; }
        }
    }
    if (preg_match('/^Bearer\s+(.+)$/i', $h, $m)) return $m[1];
    return '';
}

function tc_auth_user($db) {
    $token = tc_bearer();
    if ($token === '') return null;
    $payload = tc_jwt_verify($token);
    if (!$payload || empty($payload['sub']) || empty($payload['exp']) || $payload['exp'] < tc_now()) return null;
    // 全站会话纪元:authEpoch 递增后旧令牌全部失效(缺 ep 的老令牌视为纪元 1)
    $epoch = isset($db['settings']['authEpoch']) ? (int) $db['settings']['authEpoch'] : 1;
    $payloadEpoch = isset($payload['ep']) ? (int) $payload['ep'] : 1;
    if ($payloadEpoch !== $epoch) return null;
    foreach ($db['users'] as $u) {
        if ($u['id'] === $payload['sub']) {
            $tv = isset($u['tv']) ? (int) $u['tv'] : 0;
            $ptv = isset($payload['tv']) ? (int) $payload['tv'] : 0;
            if ($ptv !== $tv) return null;
            // 顺手补发笔记附件 Cookie:浏览器加载正文里的 <img>/<a> 带不了请求头,
            // 只能靠它认人(实现见 lib/api.php,只加载 core.php 的自检脚本没有它)
            if (function_exists('tc_note_attach_cookie_sync')) tc_note_attach_cookie_sync($db, $u);
            // 工具箱页面同理:它是在 iframe / 新标签页里被浏览器直接导航的,也没有请求头
            if (function_exists('tc_toolbox_cookie_sync')) tc_toolbox_cookie_sync($db, $u);
            return $u;
        }
    }
    return null;
}

function tc_json($code, $obj, $extraHeaders = array()) {
    tc_db_commit();
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    foreach ($extraHeaders as $k => $v) header($k . ': ' . $v);
    echo tc_json_encode($obj);
    exit;
}

function tc_fail($code, $msg) {
    // 已预扣额度但本次请求要失败退出:把预扣部分退回,免得用户为一次没拿到的回答买单。
    // (预留成功→上游失败→tc_fail 的路径有多条,集中在这里兜住,避免逐个出口去补。)
    tc_quota_refund_pending();
    tc_db_skip_write();
    tc_json($code, array('error' => array('message' => $msg)));
}

// 记录一笔待结算的预扣(供失败退款)。
function tc_quota_mark_pending($userId, $cost) {
    $GLOBALS['_tc_quota_pending'] = array('userId' => (string) $userId, 'cost' => max(0, (float) $cost));
}

// 失败退款:把待结算的预扣按全额退回,并清除待结算标记。
function tc_quota_refund_pending() {
    if (empty($GLOBALS['_tc_quota_pending'])) return;
    $p = $GLOBALS['_tc_quota_pending'];
    $GLOBALS['_tc_quota_pending'] = null;
    $uid = isset($p['userId']) ? (string) $p['userId'] : '';
    $cost = isset($p['cost']) ? (float) $p['cost'] : 0;
    if ($uid === '' || $cost <= 0) return;
    try {
        tc_with_db(true, function (&$db) use ($uid, $cost) {
            foreach ($db['users'] as $i => $u) {
                if ((string) $u['id'] !== $uid) continue;
                unset($db['users'][$i]['_quotaReserved']);
                if (tc_is_unlimited_quota($u)) return;
                $before = isset($u['quota']) ? (float) $u['quota'] : 0;
                $db['users'][$i]['quota'] = round($before + $cost, 4);
                tc_quota_note($db, $uid, array(
                    'amount' => $cost, 'source' => 'refund',
                    'purpose' => '请求失败,预扣额度已退回',
                    'before' => round($before, 4),
                    'after' => round((float) $db['users'][$i]['quota'], 4),
                ));
                return;
            }
        });
    } catch (Throwable $e) { /* 退款失败不应遮蔽原始错误 */ }
}

// 结算完成后清除待结算标记(成功路径)。
function tc_quota_clear_pending() {
    $GLOBALS['_tc_quota_pending'] = null;
}

function tc_require_auth($db) {
    $user = tc_auth_user($db);
    if (!$user) tc_fail(401, '未登录或登录已过期');
    // 演示管理员:只要在「写」请求里活动(含前台发消息、保存对话),就确保有一张生效中的还原快照。
    // 关键:快照此前只在 tc_require_admin(后台操作)里拍摄,演示管理员纯聊天时不经过那里,
    // 于是第一次到期还原后快照被消费、再也不会重建 —— 他之后产生的对话就永久留存、不再自动清除。
    if (!empty($user['demo']) && !empty($GLOBALS['_tc_db_ctx']['write']) && isset($GLOBALS['_tc_db'])) {
        tc_demo_arm($GLOBALS['_tc_db'], $user);
    }
    return $user;
}

function tc_require_admin($db) {
    $user = tc_require_auth($db);
    if (empty($user['admin'])) tc_fail(403, '需要管理员权限');
    // 演示管理员:每次写入前确保有一张生效中的还原快照。
    // 这样"改动 → 到期还原"可以反复进行,而不是只保护第一轮改动。
    if (!empty($GLOBALS['_tc_db_ctx']['write']) && isset($GLOBALS['_tc_db'])) {
        if (tc_is_demo_user($user)) {
            tc_demo_arm($GLOBALS['_tc_db'], $user);
        } elseif (is_array(isset($GLOBALS['_tc_db']['demoSnapshot']) ? $GLOBALS['_tc_db']['demoSnapshot'] : null)) {
            // 真实管理员的改动要生效,并在提交时把被改动的字段写回快照(成为新的还原基准)
            $GLOBALS['_tc_demo_before'] = tc_demo_capture($db);
        }
    }
    return $user;
}

function tc_read_json_body($limit = 2097152) {
    $raw = file_get_contents('php://input');
    if ($raw === false) $raw = '';
    if (strlen($raw) > $limit) tc_fail(400, '请求体过大');
    if ($raw === '') return array();
    $json = json_decode($raw, true);
    if (!is_array($json)) tc_fail(400, '请求体格式错误');
    return $json;
}

function tc_query() {
    return $_GET;
}

function tc_send_cors() {
    // PHP 警告/通知若被 display_errors 直接打印出来,会污染 JSON 响应,
    // 前端就会报 "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"。
    // 这里统一改为只写日志不输出,保证接口响应始终是合法 JSON。
    @ini_set('display_errors', '0');
    @ini_set('html_errors', '0');
    $origin = tc_cfg('cors_origin') ?: '*';
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Expose-Headers: X-Oc-Cost, X-Oc-Quota, X-Oc-Elapsed, X-Oc-Citations');
    header('Access-Control-Max-Age: 86400');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    // 页面含内联脚本/样式(主题色预置、各页面内嵌 JS),CSP 需保留 unsafe-inline;
    // 站点资源全部本地化,外部来源仅放行聊天内容里的 https 图片
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
}

function tc_login_file() { return tc_data_dir() . '/login-fails.json'; }

function tc_login_key($name) {
    return tc_client_ip() . '|' . strtolower((string) $name);
}

function tc_login_state() {
    $file = tc_login_file();
    if (!is_file($file)) return array();
    $j = json_decode((string) file_get_contents($file), true);
    return is_array($j) ? $j : array();
}

function tc_login_state_mutate($fn) {
    return tc_json_mutate(tc_login_file(), $fn, array());
}

function tc_check_login_lock($settings, $name) {
    $max = isset($settings['loginMaxFails']) ? (int) $settings['loginMaxFails'] : 0;
    if (!$max) return null;
    $state = tc_login_state();
    $k = tc_login_key($name);
    if (empty($state[$k]['lockedUntil'])) return null;
    $until = (int) $state[$k]['lockedUntil'];
    if ($until > tc_now()) return (int) ceil(($until - tc_now()) / 1000);
    return null;
}

function tc_note_login_fail($settings, $name) {
    $max = isset($settings['loginMaxFails']) ? (int) $settings['loginMaxFails'] : 0;
    if (!$max) return;
    $k = tc_login_key($name);
    tc_login_state_mutate(function ($state) use ($k, $max, $settings) {
        $rec = isset($state[$k]) ? $state[$k] : array('count' => 0, 'lockedUntil' => 0);
        $rec['count'] = (isset($rec['count']) ? (int) $rec['count'] : 0) + 1;
        if ($rec['count'] >= $max) {
            $rec['lockedUntil'] = tc_now() + (int) $settings['loginLockMs'];
            $rec['count'] = 0;
        }
        $state[$k] = $rec;
        if (count($state) > 5000) {
            $now = tc_now();
            foreach ($state as $key => $v) {
                if (empty($v['lockedUntil']) || $v['lockedUntil'] < $now) unset($state[$key]);
            }
        }
        return $state;
    });
}

function tc_clear_login_fail($name) {
    $k = tc_login_key($name);
    tc_login_state_mutate(function ($state) use ($k) {
        unset($state[$k]);
        return $state;
    });
}

// 日志存储:每行一条 JSON(NDJSON,追加写)。
// 旧实现是单 JSON 对象,每条日志都整文件读出再整体重写,多用户并发时锁竞争明显;
// 追加式把常规写入降为 O(1),仅在超过体积上限压缩时才整文件重写一次。
function tc_logs_file() { return tc_data_dir() . '/logs.ndjson'; }

// 日志内容上限:提示词/回复按字符截断,避免日志过度膨胀
if (!defined('TC_LOG_TEXT_LIMIT')) define('TC_LOG_TEXT_LIMIT', 10000);
// 文件超过该体积时压缩到最近 TC_LOG_LIMIT 条(常规增量追加不受影响)
if (!defined('TC_LOG_FILE_MAX_BYTES')) define('TC_LOG_FILE_MAX_BYTES', 8 * 1024 * 1024);

function tc_log_clip($s, $n) {
    $s = (string) $s;
    if ($n <= 0 || strlen($s) <= $n) return $s;
    // 按字符边界截断,避免把多字节字符切坏
    return tc_mb_cut($s, $n) . "\n…（已截断，共 " . tc_mb_len($s) . ' 字）';
}

// 旧版 logs.json(单 JSON 对象)一次性迁移为 NDJSON;成功后原文件改名留档
function tc_logs_migrate_legacy() {
    $file = tc_logs_file();
    if (is_file($file)) return;
    $legacy = tc_data_dir() . '/logs.json';
    if (!is_file($legacy)) return;
    $data = json_decode((string) @file_get_contents($legacy), true);
    $items = (is_array($data) && isset($data['items']) && is_array($data['items'])) ? $data['items'] : array();
    $lines = '';
    foreach ($items as $it) {
        if (!is_array($it)) continue;
        $lines .= tc_json_encode($it) . "\n";
    }
    if ($lines !== '') @file_put_contents($file, $lines, LOCK_EX);
    @rename($legacy, $legacy . '.migrated');
}

// 取文件末尾最后一条日志(用 fseek 只读尾部,不整文件加载)
function tc_log_last_item($fp, $size) {
    $tail = min($size, 65536);
    fseek($fp, max(0, $size - $tail));
    $raw = (string) stream_get_contents($fp);
    $lines = explode("\n", $raw);
    for ($i = count($lines) - 1; $i >= 0; $i--) {
        $line = trim($lines[$i]);
        if ($line === '') continue;
        $j = json_decode($line, true);
        if (is_array($j)) return $j;
    }
    return null;
}

// 读出全部日志条目(旧→新顺序);返回 [items, lastId]
function tc_log_read_all($fp) {
    $items = array();
    $lastId = 0;
    fseek($fp, 0);
    while (($line = fgets($fp)) !== false) {
        $line = trim($line);
        if ($line === '') continue;
        $j = json_decode($line, true);
        if (!is_array($j)) continue;
        $items[] = $j;
        $lastId = max($lastId, (int) (isset($j['id']) ? $j['id'] : 0));
    }
    return array($items, $lastId);
}

function tc_push_log($entry) {
    tc_logs_migrate_legacy();
    $file = tc_logs_file();
    $fp = fopen($file, 'c+');
    if (!$fp) return 0;
    flock($fp, LOCK_EX);
    $size = (int) fstat($fp)['size'];
    $last = tc_log_last_item($fp, $size);
    $item = $entry;
    $item['id'] = ($last && isset($last['id'])) ? ((int) $last['id'] + 1) : 1;
    $item['t'] = tc_now();
    $line = tc_json_encode($item) . "\n";
    // 体积超限时顺手压缩到最近 TC_LOG_LIMIT 条(复用同一把锁,避免与追加竞争)
    if ($size + strlen($line) > TC_LOG_FILE_MAX_BYTES) {
        list($items, $lastId) = tc_log_read_all($fp);
        $items = array_slice($items, -TC_LOG_LIMIT);
        $items[] = $item;
        $buf = '';
        foreach ($items as $it) $buf .= tc_json_encode($it) . "\n";
        ftruncate($fp, 0);
        fseek($fp, 0);
        fwrite($fp, $buf);
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        return isset($items[count($items) - 1]['id']) ? $items[count($items) - 1]['id'] : $lastId + 1;
    }
    fseek($fp, 0, SEEK_END);
    fwrite($fp, $line);
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $item['id'];
}

// 回填日志条目(流式对话在收尾时才有完整回复/用量,先记 id 再补内容)
function tc_update_log($id, $patch) {
    $id = (int) $id;
    if ($id <= 0 || !is_array($patch) || !$patch) return false;
    tc_logs_migrate_legacy();
    $file = tc_logs_file();
    if (!is_file($file)) return false;
    $fp = fopen($file, 'c+');
    if (!$fp) return false;
    flock($fp, LOCK_EX);
    list($items, ) = tc_log_read_all($fp);
    $hit = false;
    foreach ($items as &$it) {
        if (isset($it['id']) && (int) $it['id'] === $id) {
            foreach ($patch as $k => $v) $it[$k] = $v;
            $hit = true;
            break;
        }
    }
    unset($it);
    if ($hit) {
        $buf = '';
        foreach ($items as $it) $buf .= tc_json_encode($it) . "\n";
        ftruncate($fp, 0);
        fseek($fp, 0);
        fwrite($fp, $buf);
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $hit;
}

// 对话日志的通用元信息:提示词(最后一条用户消息)与来源 IP
function tc_log_chat_meta($body, $format) {
    $prompt = '';
    if (function_exists('tc_last_user_text')) $prompt = tc_last_user_text($body, $format);
    return array(
        'prompt' => tc_log_clip($prompt, 8000),
        'ip' => tc_client_ip(),
    );
}

function tc_list_logs($limit) {
    $n = min(TC_LOG_LIMIT, max(1, (int) $limit ?: 100));
    tc_logs_migrate_legacy();
    $file = tc_logs_file();
    if (!is_file($file)) return array();
    $fp = @fopen($file, 'r');
    if (!$fp) return array();
    list($items, ) = tc_log_read_all($fp);
    fclose($fp);
    return array_reverse(array_slice($items, -$n));
}

function tc_clear_logs() {
    tc_logs_migrate_legacy();
    @file_put_contents(tc_logs_file(), '', LOCK_EX);
}

function tc_provider_cost($provider) {
    $c = isset($provider['costPerCall']) ? (float) $provider['costPerCall'] : 1;
    if (!is_numeric($c) || is_nan($c) || $c == INF || $c == -INF) $c = 1;
    return max(0, $c);
}

// 单次调用实际扣费:模型级 cost 优先(实现「同一供应商下各模型不同价格」),未设置时回退供应商的 costPerCall
function tc_model_cost($provider, $modelId) {
    $id = trim((string) $modelId);
    if ($id !== '' && !empty($provider['models']) && is_array($provider['models'])) {
        foreach ($provider['models'] as $m) {
            if (!is_array($m)) continue;
            if ((string) (isset($m['id']) ? $m['id'] : '') !== $id) continue;
            if (array_key_exists('cost', $m)) {
                $c = (float) $m['cost'];
                if (is_numeric($c) && !is_nan($c) && $c != INF && $c != -INF) return max(0, $c);
            }
            break;
        }
    }
    return tc_provider_cost($provider);
}

// 按模型 ID / 名称猜测是否为「生图模型」,用于后台默认勾选与请求自动路由的兜底判断。
// 只做保守匹配:宁可漏判(交给管理员手动勾选),也不要把普通对话/视觉模型误判成生图。
function tc_image_model_name_hint($id) {
    $s = strtolower(trim((string) $id));
    if ($s === '') return false;
    $patterns = array(
        '/dall-?e/',                 // dall-e-3 / dalle3
        '/gpt-image/',               // gpt-image-1
        '/\bimage-?gen(eration)?s?\b/', // image-generation / imagegen
        '/stable-?diffusion/',
        '/\bsdxl\b/', '/\bsd3\b/', '/\bsd-?3(\.5)?\b/', '/sd-?turbo/',
        '/\bflux\b/', '/flux-?\d/',  // flux / flux-1.1
        '/midjourney/', '/\bniji\b/',
        '/seedream/',                // 豆包 Seedream
        '/\bimagen\b/',              // Google Imagen
        '/\bkolors\b/',              // 快手可图
        '/cogview/',                 // 智谱 CogView
        '/qwen-?image/',             // 通义千问生图
        '/\bwanx\b/', '/wan-?\d/',
        '/hunyuan-?image/',
        '/grok-?\d*(-|_)?image/', '/grok-imagine/',
        '/-image\b/',                // 形如 xxx-image 的生图模型
        '/image-generation/',
        '/nano-?banana/',            // Gemini 系「纳米香蕉」生图
        '/\bimagine\b/',             // grok imagine 等
        '/-image-edit/', '/image-edit/', // 图像编辑类模型
        '/\bsora[_-]?image\b/',
        '/\bkling-image/',
        '/\bz-image/',
    );
    foreach ($patterns as $re) {
        if (preg_match($re, $s)) return true;
    }
    return false;
}

// 判断某供应商下的某个模型是否按生图模型处理:
// 优先用供应商配置里的显式 image 标记,未设置时退回名称猜测。
function tc_model_is_image($provider, $modelId) {
    $mid = (string) $modelId;
    if ($mid === '') return false;
    if (isset($provider['models']) && is_array($provider['models'])) {
        foreach ($provider['models'] as $m) {
            if (!is_array($m) || !isset($m['id']) || (string) $m['id'] !== $mid) continue;
            if (array_key_exists('image', $m)) return !empty($m['image']);
            return tc_image_model_name_hint($mid);
        }
    }
    return tc_image_model_name_hint($mid);
}

function tc_is_unlimited_quota($user) {
    return isset($user['quota']) && (string) $user['quota'] === '-1';
}

// —— 余量明细(用户可追溯每次增减) ——
// 写入 quotaLedger:与充值/兑换码共用一张表,用 source 区分:
//   usage=消耗 | package_redeem/package_claim/fixed_code=获得 | admin=管理员调整
// 明细只保留最近 N 条(按用户分片),避免库无限增长。
define('TC_QUOTA_LEDGER_PER_USER', 200);

function tc_quota_note(&$db, $userId, $entry) {
    $userId = (string) $userId;
    if ($userId === '') return;
    if (!isset($db['quotaLedger']) || !is_array($db['quotaLedger'])) $db['quotaLedger'] = array();
    $row = array_merge(array('id' => tc_uid(8), 'userId' => $userId, 'createdAt' => tc_now()), $entry);
    $db['quotaLedger'][] = $row;
    // 超过上限时,只裁该用户最旧的记录(其他人的不动)
    $mine = 0;
    foreach ($db['quotaLedger'] as $e) {
        if (isset($e['userId']) && (string) $e['userId'] === $userId) $mine++;
    }
    if ($mine > TC_QUOTA_LEDGER_PER_USER) {
        $drop = $mine - TC_QUOTA_LEDGER_PER_USER;
        $kept = array();
        foreach ($db['quotaLedger'] as $e) {
            if ($drop > 0 && isset($e['userId']) && (string) $e['userId'] === $userId) { $drop--; continue; }
            $kept[] = $e;
        }
        $db['quotaLedger'] = $kept;
    }
}

// 用途标签:让用户看懂「这笔扣费是因为什么」
function tc_quota_purpose_label($purpose, $model = '') {
    $p = strtolower(trim((string) $purpose));
    $map = array(
        'chat' => '对话',
        'image' => '生图',
        'video' => '生视频',
        'title' => '生成标题',
        'followup' => '生成跟进建议',
        'judge' => 'AI 工具判定',
        'search' => '联网检索',
        'parse' => '文档解析',
        'compare' => '多模型对比',
        'assistant' => '助手对话',
        'api' => 'API 调用',
        // ---- AI 笔记 ----
        'note' => 'AI 笔记整理',        // 「保存到 AI 笔记」的自动归档
        'note-edit' => 'AI 笔记编辑',    // 选中文字右键的扩写/总结/翻译等
        'note-doc' => 'AI 笔记全文',     // 大纲/待办/摘要/自动整理
        'note-tags' => 'AI 笔记标签',
        'note-ask' => 'AI 笔记问答',
        'note-continue' => 'AI 笔记续写',
        'note-digest' => 'AI 笔记日报',
    );
    if (isset($map[$p])) return $map[$p];
    // 未标注用途时按模型名兜底推断
    $m = strtolower((string) $model);
    if (strpos($m, '(图像)') !== false) return '生图';
    if (strpos($m, '(视频)') !== false) return '生视频';
    return $p !== '' ? $p : '对话';
}

function tc_add_quota(&$db, &$user, $amount, $expiresAt = 0) {
    if ((string) $amount === '-1' || tc_is_unlimited_quota($user)) {
        $user['quota'] = -1;
        tc_replace_user($db, $user);
        return;
    }
    $n = (float) $amount;
    if ($n <= 0) return;
    $user['quota'] = max(0, (isset($user['quota']) ? (float) $user['quota'] : 0) + $n);
    $db['stats']['totalQuotaGiven'] = (isset($db['stats']['totalQuotaGiven']) ? (float) $db['stats']['totalQuotaGiven'] : 0) + $n;
    // 分笔记账:带有效期的额度单独成桶,到期按剩余量回收(tc_enforce_quota_expiry)
    if ($expiresAt > 0) {
        $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
        $grants[] = array('amount' => $n, 'remaining' => $n, 'expiresAt' => (int) $expiresAt, 'createdAt' => tc_now());
        $user['quotaGrants'] = $grants;
    }
    tc_replace_user($db, $user);
}

// 有效额度 = 账面额度 − 已过期未用完的分账(只读不落库;落库回收见 tc_enforce_quota_expiry)
function tc_quota_effective($user, $now = null) {
    if (tc_is_unlimited_quota($user)) return -1;
    $quota = (float) (isset($user['quota']) ? $user['quota'] : 0);
    $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    if (!$grants) return $quota;
    $now = $now === null ? tc_now() : $now;
    foreach ($grants as $g) {
        if (!empty($g['expiresAt']) && (int) $g['expiresAt'] <= $now && isset($g['remaining']) && (float) $g['remaining'] > 0) {
            $quota = max(0, $quota - (float) $g['remaining']);
        }
    }
    return $quota;
}

// 到期回收:从账面额度扣掉过期分账的剩余量,并清掉过期分账。需在写模式下调用。
function tc_enforce_quota_expiry(&$db, &$user, $now = null) {
    $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    if (!$grants) return 0;
    $now = $now === null ? tc_now() : $now;
    $reclaimed = 0;
    $kept = array();
    foreach ($grants as $g) {
        if (!empty($g['expiresAt']) && (int) $g['expiresAt'] <= $now && isset($g['remaining']) && (float) $g['remaining'] > 0) {
            $reclaimed += (float) $g['remaining'];
        } else {
            $kept[] = $g;
        }
    }
    if (count($kept) === count($grants)) return 0;
    $user['quotaGrants'] = $kept;
    if ($reclaimed > 0 && !tc_is_unlimited_quota($user)) {
        $user['quota'] = max(0, (float) $user['quota'] - $reclaimed);
    }
    tc_replace_user($db, $user);
    return $reclaimed;
}

// 扣费时按"先到期先用"从分账里核销,返回核销总量(其余部分扣的是无期限额度)
function tc_consume_quota_grants(&$user, $n) {
    $grants = isset($user['quotaGrants']) && is_array($user['quotaGrants']) ? $user['quotaGrants'] : array();
    $live = array();
    foreach ($grants as $g) if (isset($g['remaining']) && (float) $g['remaining'] > 0) $live[] = $g;
    if (!$live) return 0;
    usort($live, function ($a, $b) {
        $ea = !empty($a['expiresAt']) ? (int) $a['expiresAt'] : PHP_INT_MAX;
        $eb = !empty($b['expiresAt']) ? (int) $b['expiresAt'] : PHP_INT_MAX;
        if ($ea !== $eb) return $ea - $eb;
        return ((isset($a['createdAt']) ? $a['createdAt'] : 0) <=> (isset($b['createdAt']) ? $b['createdAt'] : 0));
    });
    $remaining = $n;
    foreach ($live as $i => $g) {
        if ($remaining <= 0) break;
        $take = min((float) $g['remaining'], $remaining);
        $live[$i]['remaining'] = (float) $g['remaining'] - $take;
        $remaining -= $take;
    }
    $kept = array();
    foreach ($live as $g) if ((float) $g['remaining'] > 0) $kept[] = $g;
    $user['quotaGrants'] = $kept;
    return $n - $remaining;
}

function tc_replace_user(&$db, $user) {
    foreach ($db['users'] as $i => $u) {
        if ($u['id'] === $user['id']) { $db['users'][$i] = $user; return; }
    }
}

// 额度预扣:在写事务里「检查 + 扣减」一次完成。
// 原来是在只读事务里查余额、等上游返回后再另开写事务扣费,两个事务之间留有窗口:
// 并发请求会同时读到同一笔余额并全部放行,最后每笔都 max(0,…) 落到 0,
// 等于用 1 次的额度换到了 N 次调用。BEGIN IMMEDIATE 下这里天然串行。
// 返回 true=预扣成功(或无需扣费),false=余额不足。
function tc_quota_reserve(&$db, $userId, $cost) {
    $n = max(0, (float) $cost);
    foreach ($db['users'] as $i => $u) {
        if ((string) $u['id'] !== (string) $userId) continue;
        if ($n <= 0 || tc_is_unlimited_quota($u)) {
            $db['users'][$i]['_quotaReserved'] = 0.0;
            return true;
        }
        tc_enforce_quota_expiry($db, $u);
        $effective = tc_quota_effective($u);
        if ($effective < $n) {
            $db['users'][$i] = $u;   // 过期清理后的状态要落库
            return false;
        }
        $before = isset($u['quota']) ? (float) $u['quota'] : 0;
        $u['quota'] = max(0, round($before - $n, 4));
        tc_consume_quota_grants($u, $n);
        $u['_quotaReserved'] = $n;
        $db['users'][$i] = $u;
        return true;
    }
    return false;
}

// 结算预扣:按实际费用多退少补,并记一条「消耗明细」。
// 明细的金额取实际消耗,而 before/after 跨越预扣与找零,所以一条就能说明整次调用,
// 不需要额外再记退款条目(否则一次调用会出现两条明细)。
function tc_quota_settle(&$db, $userId, $actualCost, $model = '', $purpose = '') {
    $actual = max(0, (float) $actualCost);
    foreach ($db['users'] as $i => $u) {
        if ((string) $u['id'] !== (string) $userId) continue;
        $reserved = isset($u['_quotaReserved']) ? (float) $u['_quotaReserved'] : 0.0;
        unset($db['users'][$i]['_quotaReserved']);
        if (tc_is_unlimited_quota($u)) return $actual;
        $before = isset($u['quota']) ? (float) $u['quota'] : 0;   // 预扣之后的余额
        $diff = round($reserved - $actual, 4);
        $after = max(0, round($before + $diff, 4));
        if (abs($diff) >= 0.00005) $db['users'][$i]['quota'] = $after;
        if ($actual > 0) {
            tc_quota_note($db, (string) $u['id'], array(
                'amount' => -$actual,
                'source' => 'usage',
                'purpose' => tc_quota_purpose_label($purpose, $model),
                'model' => (string) $model,
                'before' => round($before + $reserved, 4),   // 这次调用之前的余额
                'after' => $after,
            ));
        }
        return $actual;
    }
    return $actual;
}

function tc_charge_user(&$db, &$user, $cost, $model = '', $purpose = '') {
    $n = max(0, (float) $cost);
    $unlimited = tc_is_unlimited_quota($user);
    if (!$unlimited) tc_enforce_quota_expiry($db, $user);
    $before = isset($user['quota']) ? (float) $user['quota'] : 0;
    // 0 成本(自有 Key)与无限额度的调用不扣额度,但同样计入调用次数
    if ($n > 0 && !$unlimited) {
        // 按 token 计费会出现小数额度,4 位舍入避免浮点尘埃累积
        $user['quota'] = max(0, round($before - $n, 4));
        tc_consume_quota_grants($user, $n);
        // 余量明细:记录每次实际扣减(含用途与前后余量),供用户追溯
        tc_quota_note($db, (string) $user['id'], array(
            'amount' => -$n,
            'source' => 'usage',
            'purpose' => tc_quota_purpose_label($purpose, $model),
            'model' => (string) $model,
            'before' => round($before, 4),
            'after' => round((float) $user['quota'], 4),
        ));
    }
    tc_charge_user_stats($db, $user, $model, $purpose);
    return $unlimited ? 0 : $n;
}

// 只记调用统计,不动额度。额度已由 tc_quota_reserve / tc_quota_settle 处理,
// 分开是为了让「预扣 + 结算」路径不会把费用扣第二遍。
function tc_charge_user_stats(&$db, &$user, $model = '', $purpose = '') {
    // 生命周期调用计数:存用户记录上,清空对话也不丢失
    if (!isset($user['totalCalls'])) {
        // 首次建立计数:用台账里可查的历史调用打底,避免老用户计数从 0 跳变
        $seed = 0;
        $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
        $mine = tc_assoc(isset($ledger[$user['id']]) ? $ledger[$user['id']] : array());
        foreach ($mine as $day) {
            $day = tc_assoc($day);
            foreach ($day as $cell) {
                $cell = tc_assoc($cell);
                $seed += (int) (isset($cell['calls']) ? $cell['calls'] : 0);
            }
        }
        $user['totalCalls'] = $seed;
    }
    $user['totalCalls'] = (int) $user['totalCalls'] + 1;
    $db['stats']['totalCalls'] = (isset($db['stats']['totalCalls']) ? (int) $db['stats']['totalCalls'] : 0) + 1;
    $k = tc_today_key();
    $by = tc_assoc($db['stats']['callsByDay']);
    $by[$k] = (isset($by[$k]) ? (int) $by[$k] : 0) + 1;
    // 与用量台账同样只保留最近 45 天,避免逐日累加、逐年膨胀
    if (count($by) > 45) {
        ksort($by);
        $by = array_slice($by, -45, null, true);
    }
    $db['stats']['callsByDay'] = tc_object_map($by);
    tc_replace_user($db, $user);
}

function tc_health_key($providerId, $model) {
    $pid = substr(trim((string) $providerId), 0, 80);
    $name = substr(trim((string) $model), 0, 80);
    if ($pid === '' || $name === '') return '';
    return $pid . "\n" . $name;
}

function tc_health_prune($events, $now = null) {
    $cut = ($now === null ? tc_now() : (int) $now) - 4 * 3600 * 1000;
    $kept = array();
    foreach ((array) $events as $ev) {
        if (!is_array($ev)) continue;
        $t = isset($ev['t']) ? (int) $ev['t'] : 0;
        if ($t < $cut) continue;
        $kept[] = array('t' => $t, 'ok' => !empty($ev['ok']) ? 1 : 0);
    }
    if (count($kept) > 400) $kept = array_slice($kept, -400);
    return $kept;
}

function tc_record_model_health(&$db, $providerId, $model, $ok) {
    $key = tc_health_key($providerId, $model);
    if ($key === '') return;
    $now = tc_now();
    $health = tc_assoc(isset($db['stats']['modelHealth']) ? $db['stats']['modelHealth'] : array());
    $row = tc_health_prune(isset($health[$key]) ? $health[$key] : array(), $now);
    $row[] = array('t' => $now, 'ok' => $ok ? 1 : 0);
    if (count($row) > 400) $row = array_slice($row, -400);
    $health[$key] = $row;
    if (count($health) > 800) {
        $slim = array();
        foreach ($health as $k => $events) {
            $events = tc_health_prune($events, $now);
            if ($events) $slim[$k] = $events;
        }
        $health = $slim;
    }
    $db['stats']['modelHealth'] = tc_object_map($health);
}

function tc_model_health_summary($db, $providerId) {
    $pid = substr(trim((string) $providerId), 0, 80);
    $settings = isset($db['settings']) && is_array($db['settings']) ? $db['settings'] : array();
    $now = tc_now();
    $health = tc_assoc(isset($db['stats']['modelHealth']) ? $db['stats']['modelHealth'] : array());
    $prefix = $pid . "\n";
    $out = array();
    foreach ($health as $key => $events) {
        if ($pid !== '' && strpos((string) $key, $prefix) !== 0) continue;
        $model = $pid !== '' ? substr((string) $key, strlen($prefix)) : (string) $key;
        $events = tc_health_prune($events, $now);
        $calls = count($events);
        if ($calls <= 0 || $model === '') continue;
        $ok = 0;
        foreach ($events as $ev) if (!empty($ev['ok'])) $ok++;
        $rate = $ok / $calls;
        // 分级阈值由后台「对话设置 → 模型可用性显示」配置(默认 ≥75% 良好,≥40% 一般,其余较差)
        $okMin = min(100, max(1, (int) (isset($settings['healthOkMin']) ? $settings['healthOkMin'] : 75) ?: 75)) / 100;
        $warnMin = min(99, max(0, (int) (isset($settings['healthWarnMin']) ? $settings['healthWarnMin'] : 40))) / 100;
        if ($warnMin >= $okMin) $warnMin = max(0, $okMin - 0.01);
        $state = 'bad';
        if ($rate >= $okMin) $state = 'ok';
        elseif ($rate >= $warnMin) $state = 'warn';
        $out[$model] = array(
            'state' => $state,
            'calls' => $calls,
            'ok' => $ok,
            'rate' => round($rate, 4),
        );
    }
    return $out;
}

// 用量台账:流式结束后由代理调用,记录 调用次数/计费额度/上下行 token(按 用户+日期+模型 聚合)
function tc_record_usage_entry(&$db, $userId, $model, $cost, $prompt, $completion) {
    $uid = (string) $userId;
    if ($uid === '') return;
    $name = substr(trim((string) $model), 0, 80);
    if ($name === '') $name = '未知模型';
    $day = tc_today_key();
    $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
    $mine = tc_assoc(isset($ledger[$uid]) ? $ledger[$uid] : array());
    $row = tc_assoc(isset($mine[$day]) ? $mine[$day] : array());
    $cell = tc_assoc(isset($row[$name]) ? $row[$name] : array());
    $cell['calls'] = (isset($cell['calls']) ? (int) $cell['calls'] : 0) + 1;
    $cell['cost'] = (isset($cell['cost']) ? (float) $cell['cost'] : 0) + max(0, (float) $cost);
    if ($prompt > 0) $cell['prompt'] = (isset($cell['prompt']) ? (int) $cell['prompt'] : 0) + (int) $prompt;
    if ($completion > 0) $cell['completion'] = (isset($cell['completion']) ? (int) $cell['completion'] : 0) + (int) $completion;
    $row[$name] = $cell;
    $mine[$day] = tc_object_map($row);
    if (count($mine) > 45) {
        ksort($mine);
        $mine = array_slice($mine, -45, null, true);
    }
    $ledger[$uid] = tc_object_map($mine);
    $db['stats']['usageLedger'] = tc_object_map($ledger);
}

function tc_admin_usage_rows($db, $days) {
    $names = array();
    foreach ((isset($db['users']) ? $db['users'] : array()) as $u) {
        if (isset($u['id'])) $names[(string) $u['id']] = isset($u['name']) ? (string) $u['name'] : '';
    }
    $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
    $out = array();
    foreach ($ledger as $uid => $daysMap) {
        $rows = tc_usage_rows($db, $uid, $days);
        $calls = 0;
        $cost = 0;
        $byModel = array();
        foreach ($rows as $row) {
            $calls += $row['calls'];
            $cost += $row['cost'];
            foreach ($row['models'] as $m) {
                $key = $m['model'];
                if (!isset($byModel[$key])) $byModel[$key] = array('model' => $key, 'calls' => 0, 'cost' => 0);
                $byModel[$key]['calls'] += $m['calls'];
                $byModel[$key]['cost'] += $m['cost'];
            }
        }
        if ($calls <= 0 && $cost <= 0) continue;
        $models = array_values($byModel);
        usort($models, function ($a, $b) {
            if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
            return ($a['cost'] < $b['cost']) ? 1 : -1;
        });
        $out[] = array(
            'userId' => (string) $uid,
            'name' => isset($names[$uid]) && $names[$uid] !== '' ? $names[$uid] : '已删除用户',
            'calls' => $calls,
            'cost' => $cost,
            'models' => array_slice($models, 0, 6),
        );
    }
    usort($out, function ($a, $b) {
        if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
        return ($a['cost'] < $b['cost']) ? 1 : -1;
    });
    return array_slice($out, 0, 12);
}

function tc_usage_rows($db, $userId, $days) {
    $uid = (string) $userId;
    $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
    $mine = tc_assoc(isset($ledger[$uid]) ? $ledger[$uid] : array());
    $out = array();
    foreach ($days as $day) {
        $row = tc_assoc(isset($mine[$day]) ? $mine[$day] : array());
        $models = array();
        $calls = 0;
        $cost = 0;
        $prompt = 0;
        $completion = 0;
        foreach ($row as $model => $cell) {
            $cell = tc_assoc($cell);
            $c = isset($cell['calls']) ? (int) $cell['calls'] : 0;
            $spent = isset($cell['cost']) ? (float) $cell['cost'] : 0;
            $pt = isset($cell['prompt']) ? (int) $cell['prompt'] : 0;
            $ct = isset($cell['completion']) ? (int) $cell['completion'] : 0;
            if ($c <= 0 && $spent <= 0 && $pt <= 0 && $ct <= 0) continue;
            $models[] = array('model' => (string) $model, 'calls' => $c, 'cost' => $spent, 'prompt' => $pt, 'completion' => $ct);
            $calls += $c;
            $cost += $spent;
            $prompt += $pt;
            $completion += $ct;
        }
        usort($models, function ($a, $b) {
            if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
            return ($a['cost'] < $b['cost']) ? 1 : -1;
        });
        if ($models) $out[] = array('day' => $day, 'calls' => $calls, 'cost' => $cost, 'prompt' => $prompt, 'completion' => $completion, 'models' => $models);
    }
    return array_reverse($out);
}

function tc_apply_model_vote(&$db, $model, $from, $to) {
    $name = substr(trim((string) $model), 0, 80);
    if ($name === '') return;
    $from = ($from === 'up' || $from === 'down') ? $from : '';
    $to = ($to === 'up' || $to === 'down') ? $to : '';
    if ($from === $to) return;
    $votes = tc_assoc(isset($db['stats']['modelVotes']) ? $db['stats']['modelVotes'] : array());
    $row = tc_assoc(isset($votes[$name]) ? $votes[$name] : array());
    $up = isset($row['up']) ? (int) $row['up'] : 0;
    $down = isset($row['down']) ? (int) $row['down'] : 0;
    if ($from === 'up') $up = max(0, $up - 1);
    if ($from === 'down') $down = max(0, $down - 1);
    if ($to === 'up') $up++;
    if ($to === 'down') $down++;
    if ($up === 0 && $down === 0) unset($votes[$name]);
    else $votes[$name] = array('up' => $up, 'down' => $down);
    $db['stats']['modelVotes'] = tc_object_map($votes);
}

function tc_model_vote_rows($db) {
    $votes = tc_assoc(isset($db['stats']['modelVotes']) ? $db['stats']['modelVotes'] : array());
    $rows = array();
    foreach ($votes as $model => $row) {
        $row = tc_assoc($row);
        $up = isset($row['up']) ? (int) $row['up'] : 0;
        $down = isset($row['down']) ? (int) $row['down'] : 0;
        $rows[] = array('model' => (string) $model, 'up' => $up, 'down' => $down);
    }
    usort($rows, function ($a, $b) {
        $da = ($b['up'] + $b['down']) - ($a['up'] + $a['down']);
        if ($da !== 0) return $da;
        return strcmp($a['model'], $b['model']);
    });
    return $rows;
}

function tc_valid_name($name) {
    return (bool) preg_match('/^[A-Za-z0-9_\x{4e00}-\x{9fa5}.@-]{2,32}$/u', $name);
}

function tc_uptime_sec() {
    $file = tc_data_dir() . '/.uptime';
    if (!is_file($file)) @file_put_contents($file, (string) time());
    $start = (int) @file_get_contents($file);
    if ($start <= 0) $start = time();
    return max(0, time() - $start);
}

function tc_seed_admin(&$db) {
    $password = (string) tc_cfg('admin_password');
    if ($password === '' || $password === '请改成你的密码') return false;
    $name = (string) (tc_cfg('admin_name') ?: 'admin');
    foreach ($db['users'] as $u) {
        if (!empty($u['admin'])) return false;
    }
    $user = array(
        'id' => tc_uid(),
        'name' => $name,
        'salt' => '',
        'passwordHash' => '',
        'quota' => 1e15,
        'createdAt' => tc_now(),
        'admin' => true,
        'groupId' => null,
        'tv' => 0,
    );
    tc_set_password($user, $password);
    $db['users'][] = $user;
    return true;
}

function tc_catalog() {
    static $cat = null;
    if ($cat !== null) return $cat;
    $file = __DIR__ . '/catalog.json';
    $j = json_decode((string) file_get_contents($file), true);
    $cat = is_array($j) ? $j : array('categories' => array(), 'assistants' => array(), 'DEFAULT_ASSISTANT_ID' => 'as-present');
    return $cat;
}
