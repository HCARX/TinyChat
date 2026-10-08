# TinyChat

**自托管的 AI 对话站点系统**：纯 PHP，上传虚拟主机即可运行——不需要独立的数据库服务（数据存于 PHP 自带的 SQLite）、不需要 Composer / Node / 常驻进程。ChatGPT 风格界面（四套主题可选），支持 OpenAI、Anthropic 及各类兼容接口的多模型切换，内置文生图、AI 笔记、用户注册、额度计费、兑换码、助手库、联网搜索、游客体验与在线更新——部署一次，即可让团队或朋友注册使用，所有数据都在你自己手里。

开源地址：[github.com/TinyNano/TinyChat](https://github.com/TinyNano/TinyChat) · License: MIT

## 目录

- [Demo](#-demo) · [界面预览](#-界面预览) · [功能特性](#-功能特性) · [定位差异](#-与同类项目的定位差异)
- **全免费部署**：[手把手教你使用 InfinityFree 免费主机部署](docs/free-hosting/README.md)
- **部署**：[环境要求](#环境要求) · [目录权限](#目录权限重要) · [虚拟主机](#虚拟主机部署) · [宝塔面板](#宝塔面板部署小白步骤) · [本机预览](#本机预览已装-php) · [首次运行](#首次运行)
- **使用**：[OpenAI 兼容 API](#openai-兼容-api) · [AI 生视频](#ai-生视频) · [AI 生图](#ai-生图文生图--图生图)
- **维护**：[配置](#配置configphp--环境变量) · [在线更新](#在线更新) · [数据与备份](#数据与备份) · [测试](#测试) · [服务器配置示例](#附录服务器配置示例)

## 🔗 Demo

- 前台：<https://tinychat.infinityfree.io/>
- 后台：<https://tinychat.infinityfree.io/admin>
- 用户名：`demo` 密码：`123456`
- **维护中站点：https://tiny.l.cd**

> Demo 站的 `demo` 账号是「演示管理员」：可以修改设置并在前台立即生效，但**改动会在 10 分钟后自动还原**，且不能修改密码。请把它当成沙盒，尽快体验。
> 目前**这一账号里做了部分功能的测试，可登录查看对话记录。**

## 🖼 界面预览

| 深色主题 | 浅色主题 |
|:---:|:---:|
| ![TinyChat 深色主题对话界面，含代码块、公式与引用](docs/screenshots/chat-dark.png) | ![TinyChat 浅色主题对话界面，含代码块、公式与引用](docs/screenshots/chat-light.png) |

**主题市场**（左下角用户菜单 → 主题市场）：当前上架四套，每套都含浅色 / 深色完整配色，点一下立即生效并随账号同步到其他设备。

![TinyChat 主题市场 · 四套主题](docs/screenshots/themes.png)

| 方块 | Claude 风格 |
|:---:|:---:|
| ![方块主题 · 苹果产品页式的圆角矩形分块](docs/screenshots/theme-block.png) | ![Claude 风格主题 · 暖米白纸感配色与宽扁输入框](docs/screenshots/theme-claude.png) |

**AI 笔记**：独立的全屏 Markdown 工作台，左侧文件树、中间源码、右侧实时预览（可切编辑 / 分屏 / 预览）。

![TinyChat AI 笔记 · 分屏编辑与实时预览](docs/screenshots/notes.png)

**群聊**：侧栏模型下方切换。每位成员单独选模型，四种协作方式互不混用。

| 参与人数 | 对话模式 |
|:---:|:---:|
| ![群聊设置 · 参与人数与成员头像](docs/screenshots/group-members.png) | ![群聊设置 · 四种对话模式](docs/screenshots/group-chat.png) |

**管理后台 · 概览**（服务器状态、调用量与额度）：

![TinyChat 管理后台概览](docs/screenshots/admin.png)

## ✨ 功能特性

**对话体验**

- **主题市场**（左下角用户菜单 → 主题市场）：整套切换界面外观，当前上架四套，各自含浅色 / 深色完整配色 ——
  - **TinyChat 默认**：经典外观，蓝色点缀，可自定义主题色，可拖动会话栏与对话列宽度
  - **ChatGPT 风格**：黑白极简、大圆角气泡与胶囊输入框，自带配色
  - **方块**：苹果产品页式的圆角矩形分块，不画分割线，靠留白与浅投影分区，自带配色
  - **Claude 风格**：暖米白纸感配色、陶土橙点缀，助手整栏通排与宽扁两行式输入框，自带配色

  四套都做了完整的移动端适配（窄屏下内边距、圆角与底部留白各自收窄），切回默认外观原样还原；主题选择随账号同步。
- 流式输出、Markdown、代码高亮（代码块单一底色，语言名与复制按钮同在顶栏）、KaTeX 公式、引用块、Mermaid 图表 / 思维导图
- **群聊**：侧栏「简单对话 / 群聊」开关进入。成员 2–8 人，各自指定模型与角色；四种模式分开运行，不混在同一次发言里
  - 群主组织：群主点名，只请相关的人发言，再收成一个决定
  - 自由讨论：先抛出可争论的命题，之后每轮只反驳上一位
  - 轮流发言：按层次接力，后一位接着前一位写，不回头重写
  - 专家协作：拆成互不重叠的子任务，每人只交自己那一份，由群主拼结论
- 思维链展示与思考强度（关 / 低 / 中 / 高，含按模型规则自动修正）
- 图片与文件附件、自动追问一键发送、双击 Backspace 取消生成
- 附件解析：PDF / 图片 / Word / PPT / Excel（接 MinerU），链接读取自动抓取正文
- 助手库：内置 + 管理员/用户自建，@ 选择助手、可拖拽整理分类
- **AI 跟进建议**：回复后生成 3 条追问，可指定用哪个模型生成（默认跟随当前模型）
- **AI 对话命名**：新会话可按首条消息本地截取标题（默认，不扣费），也可选「AI 生成」并指定模型
- 会话管理：置顶 / 重命名 / 分支 / 分享链接 / 搜索，对话云同步（可选）
- **设置云同步（可选）**：主题与外观、模型选择、生成参数、群聊配置、自定义字体、笔记工作台界面等随账号保存到服务器，换设备 / 换浏览器登录同一账号即自动恢复，无需重新设置；逐键合并 + 删除墓碑，多设备改动不会互相覆盖
- **API 对话单独分组**：用 `sk-tc-` 密钥调用 `/v1` 产生的对话记入本站后，按时间段再分一组 —— 今天 → **今天 API** → 昨天 → **昨天 API** → 本周 → 更早，不和手动聊的会话混在一起（一天几十条接口调用不会把手动对话冲走）；两组折叠状态各记各的，「设置 → 数据」里也能一键整块隐藏
- 全端适配：桌面端与移动端（抽屉侧栏、软键盘适配、安全区）均可正常使用

**AI 笔记**

侧栏「AI 笔记」进入，是一个独立地址（`/ainotes`）的全屏 Markdown 工作台，与对话数据分开存放。

- 分栏布局：左侧文件夹 / 笔记树，中间源码，右侧实时预览，可切「编辑 / 分屏 / 预览」
- 选中文字右键让 AI 扩写 / 总结 / 翻译 / 检查谬误 / 降低重复率，结果追加在选中文字之后，可 Ctrl+Z 撤销；右键菜单可自定义（增删动作、改提示词）
- 输入 `/` 插入模板，Tab 让 AI 接着写；顶栏「问笔记」能基于你的全部笔记回答问题并标出引用来源
- 插入图片与附件（粘贴 / 拖拽均可），附件按用户单独统计空间、只有本人可读
- 笔记可分享（`/n/<token>`）、可归档（把对话里的一段整理成笔记再存进来）
- 完整的移动端体验：窄屏侧栏改为抽屉，模式切换排到控件条最前，选中即收

**在线工具箱**

侧栏「在线工具箱」进入，是一个独立地址（`/toolbox`）的工作台：内置常用小工具即开即用，也能把你自己写的一段 HTML 存成工具，面板里卡片式管理、分类归置。

- **内置 12 套工具**，分 6 类：编码转换（Base64 / URL / JSON）、开发辅助（时间戳、哈希、正则、JWT）、随机生成（密码、UUID / ULID）、颜色与设计、文本处理、二维码
- **批量二维码生成与识别**：一次贴多行内容批量出码（自动去重、可逐条删除 / 复制），完整出码设置 —— 纠错等级（L/M/Q/H）、码点尺寸、留白宽度、圆点形状与圆角、前景 / 背景色（背景可透明，前景可双色渐变）、定位图案样式，以及中心填充（文字或图片，可调比例与留白）；右侧识别面板把图片拖进来即可反查原文、支持多张批量识别，并对「中心填充是否还在纠错余量内」「涂掉一块后还能不能扫」如实自检提示
- **每套工具都是一个自带主题的独立页面**：面板里预览、或在新标签页打开，深色站内打开就是深色，不出现白底白字
- **任意工具都是纯前端 HTML**：面板内可查看源码 / 编辑 / 运行预览，直接改成自己的版本；分类可自建，工具可增删改
- **后台可维护「系统工具」**：管理员在后台增删分类与工具，前台所有用户即可用；每个用户也能自建一套只属于自己的工具
- **安全隔离**：用户工具一律在不透明源（`sandbox` 且不给 `allow-same-origin`）里运行 —— 读不到登录态 Cookie 与 `localStorage`，弹窗也挣不脱沙箱，因此接受任意用户提交的 HTML 也不会外泄本站数据

**模型与供应商**

- 多供应商多模型：OpenAI Chat / Responses / 旧 Completions、Anthropic Messages、视频生成接口，以及各类 OpenAI 兼容接口
- **模型汇总**（后台「模型汇总」，默认关闭）：把多个渠道的模型收成一个自定义 ID，前台与开放 API 都只看到这个 ID —— 客户端一行代码不改就获得多渠道容错
  - 每个汇总可选**轮询**（依次轮流）或**故障自动转移**（当前渠道连不上、超时或回 5xx/429 就换下一个渠道再试；流式在首字节发出前同样会换，已开始输出则不换，避免重复计费）
  - 开启后自动**汇总同名模型**：同一个模型名出现在 ≥2 个启用渠道时自动生成汇总（汇总 ID 就是模型名），无需手工配置；只剩一个渠道时自动清理
  - 汇总项的**前台显示顺序可调**（与供应商共用一条顺序序列），也可选择只显示汇总、隐藏其余未汇总的模型
  - 被汇总的成员渠道不再单独出现在前台，界面看上去与「只加了一个供应商的一个模型」完全一致
  - 候选渠道沿用原有的可见性与用户组模型授权：无权的渠道不会进入候选，也不会因汇总而绕过授权
- 用户可自建「个人供应商」，不出现在管理后台；API Key 以 AES-256-GCM 加密落库并与属主绑定
- 置顶模型（新建对话默认使用）、模型健康度展示
- 联网搜索：Tavily 或自建 SearXNG，输入框旁一键开关，回复附来源链接

**用户与运营**

- 用户注册登录、邮箱验证、找回密码（内置 SMTP 邮件与模板编辑器）
- **注册与账号安全**（后台「用户验证」）：开放注册开关、注册限流（每 IP 每小时）、登录失败锁定（次数 + 时长）、是否允许用户自建供应商
- 按次计费：额度套餐、兑换码（批量生成 / 导出 / 固定码 / 限领次数 / 有效期）
- 按量计费可选：供应商可切换为「按 token」模式（每 1K token 价格，含输入+输出，用量缺失自动回退按次）
- 用户组与模型授权：组 → 供应商 → 模型粒度控制，**可只授权某供应商下的部分模型**（逐个勾选即可）；勾「全部」＝开放该供应商所有模型（含新增），取消后可再逐个挑选
- 管理后台：统计看板、14 天趋势、用量台账（一键导出 CSV）、运行日志、全局设置
- **用户 IP 记录**：后台用户列表展示最近登录 IP，便于治理
- 全站公告：后台发布，支持 Markdown / HTML 富文本，前台居中弹窗展示，用户可随时从菜单再次查看
- 注册邀请码：开启后注册必须提供有效邀请码，后台批量生成、支持一码多次有效
- **游客免登录体验**：访客直接对话，每人自动生成独立游客账号（归入「游客」组，后台可见 IP 与对话数），轮数与可用模型可配
- **演示管理员**：可自由改设置、到期自动还原，但不可改公告/账号/密码、不可查看用户对话

**安全与稳定**

- 接口限流：代理接口每用户滑动窗口限流（可配，可关闭）
- 内容审核：本地敏感词库（最多 5000 条），发送前匹配用户消息，命中即拒绝
- 用户协议：/agreement 协议页 + 注册勾选确认
- 模型熔断：连续失败的模型自动快速失败并提示换模型，事件老化后自动恢复；管理员豁免
- 自动学习：上游报错自动记录可用思考档位、自动回填模型上下文窗口
- 429/5xx 自动重试一次（未向客户端发送字节前才重试，不重复计费）
- 安全响应头：CSP、X-Frame-Options、Permissions-Policy；会话有效期可配 + 全站强制下线

**AI 生图（文生图 / 图生图）**

- 文生图：调用供应商的 `images/generations` 接口（dall-e-3、gpt-image-1、flux、seedream、stable-diffusion、imagen、qwen-image 等），结果以 Markdown 图片插入对话
- **图生图 / 改图**：上传 1–4 张参考图并填写修改要求即可改图；对话中给生图模型附图片也走改图流程
- **生图模型自动识别**：后台模型清单可显式勾选「生图」；未勾选时按模型名自动识别。模型选择器会把生图模型自动归入末尾的「生图模型」分组
- **对话中无缝生图**：直接用生图模型发消息会自动改走上游生图接口，不再报 `is an image model` 错误；生图模型不使用 @助手
- **自定义图片规格**：像素尺寸（`1024x1024`）、档位（`2K` / `4K`）、宽高比（`16:9` / `9:16`）均可填
- **两类接口都能对接**：独立生图端点型，以及图片放在对话回复里的对话式出图型，后者自动回退到对话接口并提取图片
- **高兼容性对接**：兼容多种返回形态；对不接受部分参数的接口自动降级重试；放宽连接超时并在网络抖动时自动重试；结果图经同源代理展示，避免第三方存储域不可达导致「看不到图」

**AI 生视频**

- 后台「接口格式」新增**视频生成**（`/v1/videos` 异步任务），配好供应商即可在前台生成视频
- 三种模式：**文字生成** / **首尾帧**（分别上传首帧、尾帧）/ **参考图**（最多 5 张）
- 时长（4–12 秒）与画面比例（21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16）可选
- 生成期间显示进度提示，完成后以内嵌播放器插入对话；对话中直接用视频模型发消息也可生成
- 视频经同源签名代理播放（转发 Range，支持拖动进度）

**开放能力**

- OpenAI 兼容 API：`/v1/chat/completions`（含流式）、`/v1/models`、`/v1/images/generations`、`/v1/videos`；用户在「设置 → API 密钥」生成 `sk-tc-` 密钥（哈希落库、仅显示一次、数量上限可配），第三方客户端直接接入，计费与网页端一致
- **开放 API 独立管控**：单密钥限流、站点总限流、对外可用模型白名单（未开放的模型不出现在 `/v1/models` 且调用被拒，网页端不受影响）
- 多模型对比：同一问题并行发给 2–3 个模型，并排查看、一键投票（计入模型评价）
- **@ 其他模型重答**：在已有回复上 @ 另一个模型，用新标签页给出另一份回答，不覆盖原文

**部署与数据**

- 纯 PHP（7.4+），不需要 Composer、MySQL、Node 或常驻进程；数据存于 SQLite（WAL 模式），多数虚拟主机默认支持
- 首次运行自动跑环境自检：PHP 版本、pdo_sqlite / curl / openssl 扩展、data/ 目录权限逐项核对，不通过不放行安装
- 数据备份：每日自动轮换备份整库，后台一键手动备份 / 下载 / 恢复
- 隐私模式可选：关闭后服务器不保存对话记录，对话仅存用户浏览器本地；「用户设置云同步」另有独立开关（后台可整站关闭，用户也可只关掉本机的设置同步）
- PWA：可「添加到主屏幕 / 安装」，静态资源离线缓存（需 HTTPS）
- Apache / Nginx / IIS 伪静态配置齐备，常见虚拟主机、宝塔面板可直接跑

## 🆚 与同类项目的定位差异

NextChat、LobeChat 等项目是「面向个人的聊天客户端」，TinyChat 的定位是「面向站长的小型 AI 站点系统」：你部署一次，其他人在你的站点上注册、消费额度、使用你配置的模型。

| | TinyChat | NextChat | LobeChat | Open WebUI |
|---|---|---|---|---|
| 运行依赖 | 仅 PHP 7.4+ | Node.js | Node.js / Docker | Docker / Python |
| 数据库 | 不需要（文件存储） | 不需要 | 建议配置 | 需要 |
| 共享虚拟主机可部署 | ✅ | ❌ | ❌ | ❌ |
| 多用户注册 / 用户组 | ✅ 内置 | — | ✅（需服务端模式） | ✅ |
| 额度计费 / 兑换码 | ✅ 内置 | ❌ | 云端版部分支持 | ❌ |
| 数据归属 | 全部在自己主机 | 浏览器本地 | 服务器 | 服务器 |

适合：想给自己/团队/朋友搭一个有账号体系、能控制额度、能插自己供应商 Key 的独立 AI 站点。
不适合：只需要一个本地单机客户端（这场景 NextChat 更轻）。

## 部署

> 不想买服务器？先看[**全免费部署**：用 InfinityFree 免费主机搭建 TinyChat（图文教程）](docs/free-hosting/README.md)。

### 环境要求

- PHP 7.4+（推荐 8.x），扩展：`pdo_sqlite`（数据存储）、`curl`、`openssl`、`json`；在线更新需要 `zip` 或 `phar + zlib`
- 首次访问登录页会自动运行环境自检表单，逐项核对扩展与 `data/` 目录权限
- Apache `mod_rewrite`，或 Nginx `try_files` 转到 `index.php`
- 站点目录可写 `data/`（SQLite 库、JWT 密钥、备份都写在这里）

### 目录权限（重要）

首次访问会显示**环境自检表单**，其中「`data/` 目录可写」一项用真实写入探针验证。**即使权限不足，自检页也会正常打开**并明确标出这一项失败，页面给出修复指引而不会放行安装（此前权限不足时配置接口会直接报错，页面停在无法注册的注册页）。

推荐权限（Linux / 宝塔类面板）：

```bash
# 目录：755；宿主机 PHP 进程与文件属主一致时即可写。
# 若主机以 www / nginx 等其它用户运行 PHP，把 data/ 属主交给它，或放宽到 775：
chmod 755 data
chown -R www:www data    # 用户/组名按你的主机而定（www-data / nginx / apache）

# 仅当无法改属主时，才退而求其次放宽权限：
chmod -R 775 data
```

- 不要把整个站点目录设为 `777`。程序运行只需要 `data/` 可写。
- `lib/`、`config.php` 平时不应有写权限；只有**使用后台「在线更新」**时才需要站点根目录、`lib/`、`static/` 可写（更新过程要覆盖这些目录里的文件）。不想开这个口子，就到 GitHub 下载新版本手动覆盖，功能完全一样。
- `data/` 建议禁止外部直接访问（仓库自带的 `data/.htaccess` 已做拒绝规则；Nginx / IIS 见文末示例）。
- 权限不足时的典型现象是：能进环境自检页，但「`data/` 目录可写」一项标红，无法创建管理员。
- 用宝塔面板部署的话，可直接照做下方「宝塔面板部署（小白步骤）」，权限设置在第 3 步。

### 虚拟主机部署

1. 把本仓库整个上传到主机网站根目录（不要只传 `public`）。
2. 确认根目录里有 `index.php`、`.htaccess`、`lib/`、`static/`、`vendor/`。
3. 按上节「目录权限」把 `data/` 设为可写（一般 `755`，PHP 进程用户不一致时 `775` 并调整属主）。
4. Apache 面板打开「伪静态 / Rewrite」。用宝塔面板的话，见下方「宝塔面板部署（小白步骤）」。
5. 浏览器打开站点。还没有管理员时，登录页会先显示环境自检，全部通过后点「下一步：创建管理员」再创建。然后进管理后台添加全局供应商。

也可以复制 `config.sample.php` 为 `config.php`，写上 `admin_password`，首次访问会自动种下管理员（只在库里还没有管理员时生效）。

### 宝塔面板部署（小白步骤）

面向第一次用宝塔的站长，一步步照做即可。全程只需要 **Nginx + PHP**，**不需要 MySQL**——所以别建数据库。

#### 准备工作

1. 服务器已装好宝塔面板，能正常打开面板地址。
2. 「软件商店」里确认已安装 **Nginx** 与 **PHP 7.4 以上**（推荐 8.0 / 8.1）。只装了 Nginx 的话，先搜 `PHP` 装一个。
3. 准备好程序压缩包：从 [Releases](https://github.com/TinyNano/TinyChat/releases) 下载源码包，或在仓库页点 `Code → Download ZIP`。

#### 第 1 步：新建网站

1. 左侧菜单「网站」→ 右上角「添加站点」。
2. **域名**：填自己的域名；还没解析域名就先填服务器公网 IP。
3. **根目录**：保持默认，记住这个路径（通常是 `/www/wwwroot/你的域名`），程序稍后传到这里。
4. **FTP**：不创建；**数据库**：不创建。
5. **PHP 版本**：选 7.4 以上，推荐 8.1。
6. 点「提交」。

#### 第 2 步：上传压缩包并解压

1. 左侧菜单「文件」→ 进入第 1 步记住的站点根目录。
2. 若看到宝塔创建站点时自带的占位页（一个几十字节、内容是「站点创建成功」的 `index.html`，以及 `404.html`），把这两个删掉；**不要删 `.user.ini`**（那是宝塔的 PHP 配置文件）。
3. 点上方「上传」→ 选择程序压缩包 → 等上传完成。
4. 在文件列表里**右键该压缩包 →「解压」→ 解压到当前目录**。
5. **检查目录层级**（很关键）：解压后根目录里应该**直接**能看到这些内容——

```
index.php          程序入口
index.html         聊天主界面（约 60 KB，别删）
lib/  static/  vendor/   后端与前端资源
.htaccess          Apache 规则（Nginx 用不到，留着无妨）
```

   - 若看到的是一层文件夹（例如 `TinyChat-main/`），说明多套了一层：进入该文件夹 → 全选所有文件 → 剪切 → 回到站点根目录 → 粘贴。
   - 若根目录出现两个 `index.html`，以大小判断：**约 60 KB、用浏览器打开是 TinyChat 聊天界面的那个才是程序的**；把「站点创建成功」那个小的删掉。

#### 第 3 步：授予目录权限

1. 在站点根目录找到 `data` 文件夹。刚上传时没有它属正常现象，程序首次访问会自动创建；可以先跳过，等访问后出现再设置。
2. 右键 `data` →「权限」：
   - 所有者：`www`
   - 权限：`755`
   - 勾选「应用到子目录」→ 确定
3. 如果首次访问时环境自检提示 `data/` 目录不可写，就对**整个站点目录**做一次同样的操作（所有者 `www`、权限 `755`）。
4. 会用 SSH 的话，下面两条命令等效：

```bash
chown -R www:www /www/wwwroot/你的站点目录
chmod -R 755 /www/wwwroot/你的站点目录
```

> 不要图省事用 `777`。目录属主是 `www`、权限 755 时 PHP 就已经可写，`777` 反而带来安全风险。

#### 第 4 步：设置伪静态（最关键的一步）

1. 「网站」→ 点站点右侧的「设置」→ 左侧选「伪静态」。
2. 把输入框里原有内容**全部清空**，粘贴下面这段：

```nginx
# 必填：未命中静态文件的请求，全部交给程序入口 index.php
location / {
    try_files $uri $uri/ /index.php?$query_string;
}

# 建议保留：禁止外部直接下载数据库、后端源码与开发文件
location ^~ /data/ { deny all; }
location ^~ /lib/ { deny all; }
location ^~ /tests/ { deny all; }
location ^~ /tools/ { deny all; }
location ^~ /.git/ { deny all; }
location = /config.php { deny all; }
location ~* ^/(README|CHANGELOG|LICENSE|checksums)\.(md|txt)$ { deny all; }
```

3. 点「保存」。

> **为什么必须配**：`/api`、`/login`、`/admin`、`/s/xxx` 这些地址都没有对应的真实文件，全靠这一段转发给 `index.php` 处理。不配的话首页能打开，但一登录、一进后台就会 404。
> 后面的 `deny all` 是顺手加上的安全项：`data/` 里是数据库与密钥，`lib/` 是后端源码，`tests/` 与 `tools/` 是自检与脚本（`tests/attribution.php` 会改写 `index.html`，匿名访问也能触发），`.git/` 里有完整历史，都不该被浏览器直接下载。Apache 下 `.htaccess` 已自带等价规则，Nginx / IIS 需要自己加（下面的示例已含）。

#### 第 5 步：确认 PHP 扩展

「软件商店」→ 找到你在用的 PHP 版本 → 点「设置」→「安装扩展」，确认这几项已安装并启用：

| 扩展 | 用途 |
|---|---|
| **pdo_sqlite** | 数据存储，**必须** |
| curl | 调用上游 AI 接口，**必须** |
| openssl | 加密供应商密钥，**必须** |
| json | 数据序列化，**必须**（PHP 默认自带） |
| mbstring | 中文用量估算与敏感词匹配（建议） |

宝塔多数版本默认自带这几项；若自检页标红了哪一项，回这里补装即可。

#### 第 6 步：首次访问并初始化

1. 浏览器打开你的域名。
2. 页面会先显示**环境自检**，逐项列出 PHP 版本、扩展、`data/` 目录权限；全部通过后点「下一步：创建管理员」。
3. 设置管理员账号与密码。
4. 进入「管理后台 → 供应商」，添加你的 AI 接口（Base URL + API Key），即可开始对话。

#### 第 7 步（可选）：开启 HTTPS

「网站设置」→「SSL」→「Let's Encrypt」→ 勾选域名 → 申请 → 申请成功后打开「强制 HTTPS」。

> 建议开启：浏览器的剪贴板、PWA「添加到主屏幕」等能力需要 HTTPS 才能正常工作。

#### 常见问题

| 现象 | 处理办法 |
|---|---|
| 打开显示「站点创建成功」（宝塔占位页） | 宝塔自带的占位 `index.html` 还在，或程序没解压到站点根目录（回第 2 步）。**注意别删错**：程序自带的 `index.html`（约 60 KB，是聊天界面）必须保留 |
| 打开是宝塔默认页 / 空白 | 程序多解压了一层文件夹（回第 2 步检查目录层级） |
| 首页正常，一登录或进后台就 404 | 伪静态没配或没保存成功（回第 4 步）；保存后清一次浏览器缓存 |
| 保存伪静态时提示 `duplicate location` | 站点配置里已存在 `location /`：到「网站设置 → 配置文件」把原有的 `location / { ... }` 整段删掉（或把 `try_files` 那行合并进去）再保存 |
| 环境自检「`data/` 目录可写」标红 | 按第 3 步把属主改成 `www`、权限改为 755 |
| 环境自检「PHP 版本 ≥ 7.4」标红 | 「网站 → 站点设置 → 网站目录 / PHP 版本」里把 PHP 版本切到 7.4 以上，保存后重新访问 |
| 环境自检提示缺扩展 | 按第 5 步安装扩展，装完到「软件商店 → PHP → 重启」 |
| 页面报 500 或只显示「服务器内部错误」 | 先看「网站设置 → 网站日志」里的具体报错；常见原因是缺扩展（如 `pdo_sqlite`）或目录权限不足（回第 3、5 步） |
| 流式回复不是逐字出现，而是一次性整段蹦出 | 程序默认已附带关闭缓冲的响应头；若仍如此，见下方「流式输出排查」 |
| 上传文档解析失败 | 「软件商店 → PHP → 设置 → 配置修改」里把 `upload_max_filesize`、`post_max_size` 调大（如 200M）；再到「网站设置 → 配置文件」把 `client_max_body_size` 调大 |

**流式输出排查（一般用不到）**：如果确认是服务器缓冲导致的，在伪静态里追加下面这段。其中 `fastcgi_pass` 那一行要换成你站点的真实写法——打开「网站设置 → 配置文件」，找到 `location ~ [^/]\.php(/|$)` 那一段，把它里面的 `fastcgi_pass` 整行复制过来替换示例里的那一行：

```nginx
location ^~ /api/proxy/ {
    fastcgi_buffering off;
    gzip off;
    include fastcgi_params;
    fastcgi_pass unix:/tmp/php-cgi-81.sock;   # ← 换成你配置文件里的那一行
    fastcgi_param SCRIPT_FILENAME $document_root/index.php;
    fastcgi_read_timeout 300;
}
```

### 本机预览（已装 PHP）

```bash
php -S 127.0.0.1:8080 router.php
```

Nginx / IIS 的伪静态示例见文末「附录：服务器配置示例」。Nginx 关键是 `try_files` 到 `index.php`（宝塔用户可直接照搬上文教程的伪静态规则）。

子目录部署时，把 `.htaccess` 里的 `RewriteBase /` 改成实际路径，例如 `RewriteBase /chat/`。

### 首次运行

1. 浏览器打开站点：还没有管理员时，登录页会先展示**环境自检**（PHP 版本 / 扩展 / `data/` 可写逐项核对）。
2. 全部通过后点「下一步：创建管理员」，设置管理员账号密码。
3. 进入管理后台（`/admin`）→「平台配置 → 供应商」添加全局供应商（Base URL + API Key + 模型列表）。
4. 「模型授权」中把模型开放给需要的用户组（默认组默认已授权全部模型）。

> 也可以复制 `config.sample.php` 为 `config.php` 并写上 `admin_password`，首次访问会自动创建管理员（仅在库里还没有管理员时生效）。

## OpenAI 兼容 API

在「设置 → API 密钥」生成 `sk-tc-` 密钥后，把任意 OpenAI 兼容客户端的 Base URL 指向 `https://你的站点/v1` 即可。密钥支持流式、计费、限流与模型白名单，与网页端策略一致。可用端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/chat/completions` | 对话（默认流式，支持 `stream: true`）；生图模型会自动改走生图接口 |
| `GET` | `/v1/models` | 列出当前用户可用（且管理员开放）的模型 |
| `POST` | `/v1/images/generations` | 文生图，返回 `{created, data:[{url\|b64_json}]}` |
| `POST` | `/v1/videos` | 生视频（同步返回最终地址，服务端完成建任务与轮询） |

请求示例：

```bash
curl https://your-site/v1/images/generations \
  -H "Authorization: Bearer sk-tc-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"一只戴墨镜的柯基在冲浪","size":"1024x1024","n":1}'
```

```bash
curl https://your-site/v1/videos \
  -H "Authorization: Bearer sk-tc-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-video-model","prompt":"雨后的未来城市街道","mode":"text","seconds":5,"aspect_ratio":"16:9"}'
```

```bash
curl https://your-site/v1/chat/completions \
  -H "Authorization: Bearer sk-tc-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}]}'
```

限流与开放范围在后台「平台配置 → 开放 API」中配置：单密钥限流、账号总限流、对外模型白名单。

## AI 生视频

对接提供 `/v1/videos` 异步任务的视频生成接口。

### 配置步骤

1. 后台「平台配置 → 供应商」新增供应商，填入 Base URL 与 API Key。
2. 「接口格式」选择**视频生成**（列表中带「视频生成 /v1/videos」说明的那一项）；选中后该供应商下所有模型按视频模型处理。
3. 模型列表填入视频模型 ID；也可在模型清单的「视频」列按模型单独勾选。
4. 「模型授权」中把该供应商开放给需要的用户组。

### 三种模式

| 模式 | 说明 |
|---|---|
| 文字生成 | 只填提示词，直接生成视频 |
| 首尾帧 | 分别上传首帧、尾帧，生成两帧之间的过渡视频（至少上传一张） |
| 参考图 | 上传最多 5 张参考图，模型据此生成视频 |

时长可选 4–12 秒，画面比例可选 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16。

### 用法

- 输入区「≡ → 生视频」打开生成弹窗；
- 或直接在模型选择器里选「生视频模型」分组中的模型，发消息即可生成（带图则以图为参考）；
- 生成通常需要 1–5 分钟，期间弹窗与对话气泡都会显示进度提示，完成后以内嵌播放器插入对话；
- 第三方客户端可用 `sk-tc-` 密钥调用 `POST /v1/videos`（同步返回最终地址，服务端完成轮询）。

视频文件较大，结果经**同源签名代理**（`/api/proxy/video`）播放：转发浏览器的 Range 请求以支持拖动进度，按字节流式回传、不整段缓存。

## AI 生图（文生图 / 图生图）

TinyChat 支持对接任意提供 OpenAI 兼容生图接口的供应商，并尽量抹平各平台差异，无需为不同平台改代码。

### 配置步骤

1. 后台「平台配置 → 供应商」新增供应商，填入 Base URL 与 API Key。
   - Base URL 直接粘供应商文档给的地址即可：**带不带 `/v1` 都能正确对接**（不带时自动补 `/v1`，贴了完整接口地址则原样使用）。
2. 该供应商的模型列表里填入生图模型。
3. 在模型清单的 **「生图」列**勾选生图模型；名称能被自动识别的模型（`dall-e`、`gpt-image`、`flux`、`seedream`、`stable-diffusion`、`imagen`、`qwen-image`、`nano-banana` 等）会默认勾上，可手动纠正。
4. 「模型授权」中把该供应商开放给需要的用户组（游客组亦可，便于演示）。

### 四种用法

| 用法 | 说明 |
|---|---|
| 输入区「⋯ → 绘画」 | 打开生图弹窗，选择生图模型（或手动输入）并填提示词即可生成 |
| 对话中直接用生图模型 | 模型选择器末尾的「生图模型」分组里选一个，直接发消息——自动改走生图接口 |
| **图生图 / 改图** | 弹窗里「添加图片」上传 1–4 张参考图，再填「把杯子改成红色」这类修改要求；或在对话中给生图模型附上图片 + 说明，自动走改图流程 |
| 第三方客户端 | 用 `sk-tc-` 密钥调用 `POST /v1/images/generations`，与 OpenAI 官方客户端一致 |

### 两类生图接口都能对接

- **独立生图接口型**：供应商提供 `images/generations` 端点，直接调用。
- **对话式出图型**：部分平台的图片是在 `chat/completions` 的回复里给出的（模型列表常只标 `openai` 而不含生图端点）。TinyChat 检测到生图端点不可用、或响应里取不到图片时，会**自动回退到对话接口**并从回复中提取图片，无需手动切换。

改图时参考图会在浏览器端自动压缩（长边 ≤1536px），再按供应商接口形态发送（`image` 数组 或 `image_url` 多模态消息）。

### 兼容性说明

- **返回形态**：兼容 `data[].url`、`data[].b64_json`、`images[]`、`output[]`、顶层 `url`、`data[]` 直接是 URL 字符串或 data URL，以及对话回复内嵌的 Markdown 图片；`b64_json` 会直接内联展示。
- **尺寸与比例**：`size` 支持精确值（如 `1024x1024`）与档位（`1K` / `2K` / `3K` / `4K`）；另支持 `ratio`（`1:1` / `16:9` / `9:16` 等），适配用「档位 + 比例」表达构图的接口。
- **参数降级**：先按完整参数请求；被上游以参数类错误拒绝时自动逐级降级重试——先去掉 `quality` / `style` / `ratio` 等冷门可选参数，最后才去掉 `size`（部分接口 `size` 必填）。`response_format` 顶层被拒时会自动改放进 `extra_body`。认证 / 限流 / 余额类错误不会重试。
- **超时与容错**：生图请求放宽连接超时，网络抖动时自动重试一次（不重复计费）；上游调用会动态抬高 PHP 执行时限，避免长耗时生图被中断。
- **计费与审核**：每次生图按一次调用计费，与对话一致，失败不计费；提示词同样经过后台敏感词过滤。
- **图片显示**：不少平台把图片放在第三方对象存储域，部分网络下浏览器直连加载不到（表现为「后端出图了但页面看不到」）。TinyChat 会把结果图经**本站同源代理**（`/api/proxy/image`）转发后展示；该代理带 HMAC 签名鉴权、仅允许公网地址（阻止 SSRF）、有体积上限与本地缓存。
- **失败可见**：生图失败原因常驻显示在弹窗内，便于定位。

> 对接第三方平台的排查顺序：① 先用平台的 curl 示例确认 Key 与模型名可用；② Base URL 直接粘平台文档给的地址即可，不必自己拼路径；③ 若报 `Not Found`，多半是 Base URL 里多了或少了路径段；④ 若报参数错误，TinyChat 会自动降级重试，仍失败时弹窗会显示上游返回的具体原因。

## 配置（config.php / 环境变量）

复制 `config.sample.php` 为 `config.php` 按需修改，也可以用环境变量代替（环境变量优先）：

| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 首次访问时创建 / 同步管理员密码 |
| `ADMIN_NAME` | 管理员用户名，默认 `admin` |
| `JWT_SECRET` | JWT 密钥；不设则写在 `data/secret` |
| `DATA_DIR` | 数据目录，默认 `./data` |
| `CORS_ORIGIN` | 跨域来源，默认 `*` |
| `SITE_URL` | 站点对外地址（邮件链接、SEO canonical 用），不设则自动推断 |

> ⚠️ 公网部署强烈建议显式设置 `SITE_URL`：不设置时邮件里的验证 / 重置链接取自请求的 Host 头，可能被中间人伪造，诱导用户把重置令牌送到攻击者站点。

在线更新相关（一般用默认即可）：

| 变量 | 说明 |
|------|------|
| `github_repo` | 仓库，默认 `TinyNano/TinyChat` |
| `github_token` | 私有仓库必填；公开仓库留空即可 |
| `github_api_base` | API 根地址，默认 `https://api.github.com`，可换镜像 |
| `github_base` | 发布包下载根地址，默认 `https://github.com`，可填自建反代等加速前缀 |

## 在线更新

后台「平台配置 → 版本更新」可检查并在线安装新版本：程序对比 GitHub Releases 最新 tag 与 `lib/core.php` 里的 `TC_VERSION`，有新版时下载该 tag 的源码包，解压校验后覆盖站点文件。**`data/` 与 `config.php` 不会被改动**，升级前的程序自动备份到 `data/update/backup/`（仅保留最近一次）。

自己发新版的流程：

1. 改 `lib/core.php` 里的 `TC_VERSION`（如 `'1.0.1'`），提交并推送；
2. 打同名 tag（`v1.0.1`），在 GitHub 上基于该 tag 创建 Release（Release 说明会显示在后台）。

已部署的站点进后台点「检查更新 → 一键更新」即可。主机连不上 GitHub 时，`config.php` 里可把 `github_api_base` / `github_base` 配置成镜像或加速前缀。

## 代码结构

```
TinyChat/
├── index.php              # 入口：路由、页面、/api
├── router.php             # 仅本地 php -S 使用
├── robots.txt             # 搜索引擎爬虫规则
├── .htaccess              # Apache 伪静态
├── config.sample.php      # 复制为 config.php
├── lib/                   # PHP 后端
│   ├── core.php           # 数据层（SQLite）、设置、JWT、密码、版本号
│   ├── api.php            # 认证 / 供应商 / 助手 / 管理端
│   ├── proxy.php          # 上游 curl 代理（含 SSE、生图、生视频、图片与视频代理）
│   ├── tasks.php          # 后台任务（流式请求的断线续传）
│   ├── updater.php        # 在线更新：检查 GitHub Releases、下载覆盖
│   ├── integrity.php      # 完整性校验
│   ├── catalog.json       # 内置助手库
│   └── cacert.pem         # Mozilla CA，Windows / 部分虚拟主机缺证书时用
├── static/  vendor/       # 前端（含模型图标 static/logo/）
├── tests/                 # E2E 与自检脚本（见下方「测试」）
├── .github/workflows/ci.yml  # CI：PHP lint + JS 语法 + 自检 + E2E
├── index.html login.html admin.html share.html
└── data/                  # 运行数据（不要提交）
```

## 测试

```bash
# 各种自检（无需起服务）
node tests/logos-check.js      # 模型图标匹配
php tests/demo-revert.php      # 演示管理员还原
php tests/image-parse.php      # 生图返回形态解析
php tests/image-chat.php       # 对话式生图 / 改图
php tests/image-proxy.php      # 生图图片代理（签名 / SSRF）
php tests/upstream-url.php     # 上游接口地址拼接（补 /v1）
php tests/attribution.php      # 完整性校验
php tests/settings-sync.php    # 用户设置云同步（白名单收敛 / 分片落库 / 注销清理）
php tests/model-groups.php    # 模型汇总（同名自动生成 / 候选过滤 / 轮询游标 / 请求展开）
node tests/settings-merge.js   # 设置合并（逐键时间戳 / 删除墓碑 / 快照往返）
node tests/local-store.js      # 本地大块数据存储契约（IndexedDB 优先 / 旧键迁移 / 兜底 / 换号清理）
node tests/chat-image-inline.js # 正文内联图片契约（只内联缩略图 / 预算小于服务端上限 / 拿不到就不内联）
node tests/chat-image-preview-gui.mjs  # 真浏览器：上传大图 → 落库 → 分享 → 分享页仍有图（含对照）
node tests/model-groups-gui.mjs        # 真浏览器：汇总面板 / 前台只剩一条 / 弹窗排版几何 / Auto@ 标签
node tests/storage-panel-gui.mjs       # 真浏览器：存储管理的文件清单默认折叠 / 分页 / 末页边界
node tests/focus-ring-gui.mjs          # 真浏览器：聚焦环 / 主题色恢复默认 / 字体切换往返 / 注册勾选行排版

# 端到端冒烟：起真实 PHP 服务 + mock 上游，跑完整业务流
bash tests/e2e.sh
# 模型汇总专项：同名自动汇总 / 自定义汇总 ID / 跨渠道故障转移 / 轮询
bash tests/model-groups-e2e.sh
```

## 发版

```bash
# 改 lib/core.php 的 TC_VERSION 后跑一条命令:
#   - 业务 JS/CSS 压缩为 .min 并统一 HTML 里的 ?v= 版本号
#   - sw.js 缓存名联动 TC_VERSION(发版即清旧 PWA 缓存)
#   - 重新生成 checksums.txt(在线更新的包完整性清单)
node tools/release.mjs
```

> 内置 CJK 字体为切片分包(`static/fonts/`,由 `tools/slice_fonts.py` 生成),只有更换字体文件时才需要重跑切片脚本(需 `pip install fonttools brotli`)。

E2E 覆盖登录与设置、备份与越权防护、邀请码注册、按次与按 token 计费、流式结算、敏感词审核、接口限流、API 密钥与 `/v1` 出口、获取模型列表、生图（含自动路由与两种返回形态）、生视频、无限额度、游客模式、演示管理员等；`tests/model-groups-e2e.sh` 另起两个带标识的 mock 上游，专门验证模型汇总的跨渠道故障转移与轮询（断言回复来自哪个渠道）。CI 会在 PHP 7.4 / 8.1 / 8.3 上分别运行。另有一组 GUI 自检（真 Chromium + 真服务端）覆盖只能在浏览器里现形的接线问题，清单见 `.github/workflows/ci.yml` 的 `gui` 作业。

## 数据与备份

数据存于 `data/tinychat.sqlite`（WAL 模式），`data/secret` 保存 JWT 与加密密钥。不要提交到 Git。

v1.x 的 `db.json` 会在首次访问时自动导入到 SQLite 并改名为 `db.json.imported-*` 留档，无需手工迁移。

删掉 `data/` 里的 `tinychat.sqlite` / `secret` 即清空本机数据，下次访问会重建空库。若 `config.php` 写了管理员密码且库里还没有管理员，首次访问会再创建一个。

`data/` 自带 `.htaccess` 拒绝 Web 直访（Nginx / IIS 配置示例里同样已屏蔽）；供应商 API Key 以 AES-256-GCM 加密存储，密钥与站点绑定，拿走文件也无法在其他站点解密。

**浏览器本地副本**：服务端的数据库是权威副本；浏览器里那份「刷新即恢复」的即时副本放在 **IndexedDB**（`static/js/store.js`，会话列表、删除副本、笔记正文），不再用 localStorage —— 它的每源上限只有约 5MB，而会话消息里带着图片本体，两三张图就写满，写满之后本机副本会静默落后于云端。升级后第一次打开会自动把 localStorage 里的旧副本搬进 IndexedDB 并删掉旧键；浏览器不给用 IndexedDB 时（隐私模式 / 策略禁用）自动退回 localStorage，功能照常；IndexedDB 也写不下时（配额满）改存一份瘦身副本并提示一次。**换号登录**会清掉上一位用户留在本机的大块副本（会话 / 删除副本 / 笔记正文），当前用户自己的副本不动 —— 退出登录不删自己的数据，避免丢掉还没推上云的最后一次编辑。登录令牌、偏好设置、本地墓碑清单等小数据仍在 localStorage。

**图片在消息里的两份**：原图存在 `attachments[].dataUrl`（发给上游模型、对话页渲染用，服务端上限 8MB）；消息 `content` 里另内联一张**长边 ≤1024 的缩略图**（约 10 万字符）。这份缩略图不是冗余 —— **分享出去的对话只带走 `role`+`content`**（服务端 `tc_sanitize_share_messages`），它是分享页唯一的图源；而 `content` 在服务端有 200000 字符上限，内联原图会被整段切掉，分享页反而看不到图。缩略图拿不到时（例如几乎压不动的噪声图）就不内联，绝不退回原图。

**看到的图仍是原图**：`content` 里那份缩略图只服务于分享页与文本导出。对话页的气泡由 `attachments[].dataUrl` 重建（`userMsgDisplay`），点开大图的灯箱取的就是气泡这张 —— 所以聊天里点开看到的始终是原图，画质与缩略图无关。`tests/chat-image-preview-gui.mjs` 会在真浏览器里真的去点那张图，断言灯箱的 `src` 是 `data:image/png`、长度等于附件原图、并按原图分辨率（900px）解码。

## 附录：服务器配置示例

### Nginx

```nginx
server {
    listen 80;
    server_name example.com;
    root /www/wwwroot/tinychat;
    index index.php index.html;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ ^/api/proxy/ {
        include fastcgi_params;
        fastcgi_pass unix:/tmp/php-cgi.sock;
        fastcgi_param SCRIPT_FILENAME $document_root/index.php;
        fastcgi_read_timeout 300;
        fastcgi_buffering off;
        gzip off;
    }

    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/tmp/php-cgi.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300;
    }

    # 用 ^~ 前缀匹配:优先级高于上面的正则,确保 lib/ 下的 .php 不会被当脚本执行
    location ^~ /data/ { deny all; }
    location ^~ /lib/ { deny all; }
    location ^~ /tests/ { deny all; }
    location ^~ /tools/ { deny all; }
    location ^~ /.git/ { deny all; }
    location = /config.php { deny all; }
    location ~* ^/(README|CHANGELOG|LICENSE|checksums)\.(md|txt)$ { deny all; }
}
```

把 `root` 改成站点目录，并确认 PHP-FPM 套接字路径。`/api/proxy/` 的缓冲与 gzip 建议关闭；程序本身也会发送 `X-Accel-Buffering: no` 响应头，若流式输出已被正确逐字返回，则无需额外配置。

### IIS（web.config）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="TinyChat" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="index.php" />
        </rule>
      </rules>
    </rewrite>
    <httpProtocol>
      <customHeaders>
        <add name="X-Content-Type-Options" value="nosniff" />
      </customHeaders>
    </httpProtocol>
    <security>
      <requestFiltering>
        <hiddenSegments>
          <add segment="data" />
          <add segment="lib" />
          <add segment="tests" />
          <add segment="tools" />
          <add segment=".git" />
        </hiddenSegments>
        <fileExtensions>
          <add fileExtension=".md" allowed="false" />
        </fileExtensions>
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

把上面内容存为站点根目录的 `web.config` 即可（已包含伪静态与 `data` / `lib` / `tests` / `tools` / `.git` 的访问屏蔽；`.md` 类文档一并禁止下载）。

## 许可证

MIT

## 致谢

- **群聊设计与头像素材 —— [Nexus](https://github.com/nexus-research-lab/nexus)**：本项目使用了 Nexus 的头像素材，群聊部分的设计也参考了它。Nexus 在功能与完成度上都远胜本程序，本项目的群聊实现其实非常简陋；但正因为有这样一个优秀的作品摆在前面，才有了这里的起点。非常感谢 Nexus 的作者。
- **开发过程 —— 国产 AI 模型**：我不懂代码，本项目完全由国产 AI 模型开发——充了一点 DeepSeek，也白嫖了 ZCode 的 GLM-5.3-Flash。所以使用中难免出现各种问题，欢迎提出您的意见，我会努力让 AI 修复。
- **社区支持 —— [LINUX DO](https://linux.do/)**：感谢 LINUX DO 社区为开源项目的交流与共建提供空间。在论坛里，我见过很多大佬开发的复杂 AI 程序，本程序难以望其项背；但也希望本程序能给和我类似的小白一点帮助。
