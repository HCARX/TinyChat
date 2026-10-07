'use strict';
/**
 * groupui.js — 群聊模式
 *
 * 文件名不含 "chat"(旧名 groupchat.js):部分虚拟主机的边缘 WAF 会拦截
 * URL 路径里含 "chat" 的请求,连静态资源也返回 403,导致整个群聊功能失效。
 *
 * 侧栏「模型切换」下方有一行模式入口(图标 + 简单对话/群聊 + 开关):
 *   - 打开开关 → 发送走群聊管线,并打开「群聊设置」大弹窗;
 *   - 群聊模式下点击该行 → 重新打开设置弹窗。四个标签页保留各自的配置:
 *     1) 群聊列表  2) 参与人数与模型分配
 *     3) 角色配置  4) 对话模式(群主组织 / 自由讨论 / 轮流发言 / 专家协作)
 *
 * 群配置存浏览器本地(oc_groups);会话经 chat.groupId 关联。消息经 msg.participant
 * 标识发言成员、阶段(任务分配 / 成员讨论 / 群主总结)与时间。成员发言复用单聊流式
 * 管线与计费;回合期间暂停云端拉取/推送,防止整体替换 state.chats 导致发言丢失。
 */
(function () {
  const G = {};
  const STORE_KEY = 'oc_groups';
  const MODE_KEY = 'oc_composer_mode';
  const SEP = '\n';
  const NL = '\n';

  const EMOJI_POOL = ['🦊', '🐼', '🐯', '🦁', '🐨', '🐸', '🐙', '🦉', '🐧', '🐝', '🦄', '🐢', '🐺', '🦋', '🐬', '🦚'];
  const NAME_POOL = ['小狐', '小猫', '小虎', '小狮', '考拉', '小蛙', '章鱼', '猫头鹰', '企鹅', '蜜蜂', '独角兽', '小龟', '小狼', '蝴蝶', '海豚', '孔雀'];
  // static/role 内置头像,按成员顺序循环使用(1.png … 20.png)
  const ROLE_AVATAR_COUNT = 20;
  const MIN_MEMBERS = 2;
  const MAX_MEMBERS = 8;
  const STYLES = [
    { key: '', label: '不限' },
    { key: 'rational', label: '理性' },
    { key: 'humor', label: '幽默' },
    { key: 'brief', label: '简洁' },
    { key: 'pro', label: '专业' },
  ];
  const STYLE_HINT = {
    rational: '发言风格：理性。先给判断，再给依据，避免情绪化表达。',
    humor: '发言风格：幽默。保持轻松，但观点要具体，不靠段子凑字数。',
    brief: '发言风格：简洁。用几句话把重点说完，不铺垫。',
    pro: '发言风格：专业。使用该角色领域的准确说法，并交代边界与前提。',
  };
  const MODES = [
    { key: 'owner', title: '群主组织', desc: '群主先点名，只请最相关的几位发言，并规定每人只谈哪一块。没被点到的不发言，最后由群主整合成一个决定。' },
    { key: 'free', title: '自由讨论', desc: '群主先抛出一个可争论的命题。成员只表态支持或反对，后面每轮只反驳上一位，不再各写一篇答案。' },
    { key: 'round', title: '轮流发言', desc: '群主先按这个问题列出接力层次。每位只写自己这一层，后一位接着前一位往下接，不能回头重写。' },
    { key: 'expert', title: '专家协作', desc: '群主先把问题拆成互不重叠的子任务。每位专家只交自己那一份，不评论别人，最后由群主拼成结论、依据、分歧和建议。' },
  ];
  const MEMBER_PROMPT = '你是群聊的一位成员。结合自己的角色给出具体、友善的回答；不重复别人已经说清楚的内容。';
  const ADMIN_PROMPT = '你是群聊的群主。职责：先弄清用户真正要解决的问题；按成员专长分工，避免重复、空泛和互相矛盾；最后把讨论收成可执行的结论。被直接提问时，以群主身份简明回应。点名时必须写成 @名字，名字与成员名完全一致，例如 @谬误发现者。';
  // 新建群的默认班底:覆盖「弄清问题、核对事实、找逻辑漏洞、落到做法、提出反面」
  const ROLE_PRESETS = [
    {
      key: 'owner',
      admin: true,
      name: '群主',
      emoji: '👑',
      style: '',
      bio: '弄清问题，按专长分工，并把讨论收成可执行的结论。',
      prompt: ADMIN_PROMPT,
    },
    {
      key: 'framer',
      name: '拆题人',
      emoji: '🧭',
      style: 'rational',
      bio: '把含糊的问题拆成必须先回答的几个小问题。',
      prompt: '你是拆题人。先用一两句复述用户真正要解决的问题，再把它拆成 2 到 4 个必须回答的子问题，并说明先答哪个。不展开长篇解答，不重复别人的结论。子问题要具体到可以交给另一位成员去做。',
    },
    {
      key: 'checker',
      name: '事实核查',
      emoji: '🔎',
      style: 'pro',
      bio: '区分事实、推断和未知，标出缺的证据。',
      prompt: '你是事实核查。把讨论里的说法分成三类：已能确定的事实、合理推断、还不知道。每一类最多三条，并写清依据或缺口。不编造来源、数据或引用；没有把握就明确说「无法确认」。不负责做最终决定。',
    },
    {
      key: 'fallacy',
      name: '谬误发现者',
      emoji: '⚖️',
      style: 'rational',
      bio: '指出逻辑错误、错误假设和站不住的结论。',
      prompt: '你是谬误发现者。你要留意无效的论点，指出声明和论述中可能存在的逻辑错误或不一致之处。你的工作是提供基于证据的反馈，并指出任何谬误、错误的推理、错误的假设或不正确的结论，这些都可能被其他人忽略了。做法：先引用原话或主张，再点明谬误类型（如以偏概全、滑坡、假两难、诉诸权威、因果倒置、循环论证、偷换概念），说明它为什么不成立，最后给一个更稳妥的表述。没有明显谬误时直接说「这里没有发现明显逻辑错误」，不要为了找错而找错。',
    },
    {
      key: 'doer',
      name: '执行顾问',
      emoji: '🛠️',
      style: 'brief',
      bio: '把结论收成现在就能做的下一步。',
      prompt: '你是执行顾问。只关心「接下来怎么做」。给出最多三个步骤，每步写清谁来做、做什么、怎样算做完。标出最大的风险和最小可行的第一步。不重复原理，不展开背景。',
    },
    {
      key: 'critic',
      name: '反方',
      emoji: '🗡️',
      style: 'rational',
      bio: '提出最强的反对意见和被忽略的代价。',
      prompt: '你是反方。针对目前最主要的方案，提出最强的反对意见：它在什么前提下会失败、谁会承担代价、有没有更简单的替代。反对必须具体，不唱反调，也不重复谬误发现者已经指出的逻辑问题。最后用一句话说明，什么证据会让你改变看法。',
    },
  ];
  const DEFAULT_SETTINGS = {
    maxMembers: MAX_MEMBERS,
    maxRounds: 2,
    allowQuote: true,
    autoSummary: true,
    saveFullHistory: true,
  };

  // ---------- 存储 ----------
  let cache = null;
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { cache = null; }
    if (!cache || !Array.isArray(cache.groups)) cache = { groups: [], activeId: null };
    cache.groups.forEach(hydrateGroup);
    // 系统默认就带着六人班底。用户把群删光后,下次打开再补一个,不在本次会话里反复创建
    if (!cache.groups.length) {
      const g = makeGroup('问题研讨');
      cache.groups.unshift(g);
      cache.activeId = g.id;
      save();
    } else if (!cache.groups.some((g) => g.id === cache.activeId)) {
      cache.activeId = cache.groups[0].id;
      save();
    }
    return cache;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cache)); } catch (e) { /* 本地存储不可用时群聊配置不持久化 */ }
    // 设置云同步:按 id 对比出改动/删除的群,记时间戳并防抖推送
    if (window.OCSettingsSync) window.OCSettingsSync.syncGroups(cache);
  }
  function uid() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function roleAvatarSrc(n) {
    const i = ((Number(n) || 1) - 1) % ROLE_AVATAR_COUNT;
    return './static/role/' + (i + 1) + '.png';
  }
  // 头像序号默认跟随成员在群里的位置;用户手动换过的(avatarPinned)不再被覆盖
  function assignRoleAvatars(group) {
    if (!group || !Array.isArray(group.participants)) return;
    group.participants.forEach((p, i) => {
      if (p.avatarPinned) return;
      p.avatar = (i % ROLE_AVATAR_COUNT) + 1;
    });
  }
  function nextRoleAvatar(p) {
    const cur = Number(p && p.avatar) || 1;
    return (cur % ROLE_AVATAR_COUNT) + 1;
  }
  function makeParticipant(i, isAdmin) {
    return {
      id: uid() + '-' + i,
      name: isAdmin ? '群主' : (NAME_POOL[i % NAME_POOL.length] || ('成员' + (i + 1))),
      emoji: isAdmin ? '👑' : EMOJI_POOL[i % EMOJI_POOL.length],
      avatar: (i % ROLE_AVATAR_COUNT) + 1,
      bio: isAdmin ? '弄清问题，按专长分工，并把讨论收成可执行的结论。' : '',
      prompt: isAdmin ? ADMIN_PROMPT : MEMBER_PROMPT,
      preset: isAdmin ? 'owner' : '',
      style: '',
      enabled: true,
      admin: !!isAdmin,
      providerId: '',
      model: '',
    };
  }
  function participantFromPreset(preset, i) {
    const p = makeParticipant(i, !!preset.admin);
    p.name = preset.name;
    p.emoji = preset.emoji || p.emoji;
    p.bio = preset.bio || '';
    p.prompt = preset.prompt || (preset.admin ? ADMIN_PROMPT : MEMBER_PROMPT);
    p.style = preset.style || '';
    p.preset = preset.key || '';
    p.admin = !!preset.admin;
    return p;
  }
  function defaultPromptFor(p) {
    const preset = ROLE_PRESETS.find((x) => x.key && x.key === (p && p.preset));
    if (preset) return preset.prompt;
    return p && p.admin ? ADMIN_PROMPT : MEMBER_PROMPT;
  }
  function makeGroup(name, intro) {
    return {
      id: uid(),
      name: String(name || '问题研讨').slice(0, 30) || '问题研讨',
      intro: String(intro || '').slice(0, 200),
      mode: 'owner',
      rosterVersion: 2,
      settings: Object.assign({}, DEFAULT_SETTINGS),
      createdAt: Date.now(),
      participants: ROLE_PRESETS.map((preset, i) => participantFromPreset(preset, i)),
    };
  }
  // 还停在「群主 + 小狐/小猫」这套占位成员上的群,换成默认班底;已改过角色的不动
  function upgradeStarterRoster(group) {
    if (!group || group.rosterVersion >= 2) return;
    const ps = group.participants || [];
    const stockNames = new Set(['群主', '群管理员'].concat(NAME_POOL));
    const untouched = ps.length >= 2 && ps.length <= 4 && ps.every((p) => {
      const prompt = String(p.prompt || '').trim();
      const generic = !prompt || prompt === ADMIN_PROMPT || prompt === MEMBER_PROMPT
        || prompt.indexOf('你是群聊的群主') === 0 || prompt.indexOf('你是群聊的一位成员') === 0
        || prompt.indexOf('你是群聊的群管理员') === 0;
      return stockNames.has(p.name) && generic;
    });
    if (!untouched) { group.rosterVersion = 2; return; }
    const models = ps.map((p) => ({ providerId: p.providerId || '', model: p.model || '' }));
    const fallback = models.find((m) => m.providerId && m.model) || { providerId: '', model: '' };
    group.participants = ROLE_PRESETS.map((preset, i) => {
      const p = participantFromPreset(preset, i);
      const src = models[i] || fallback;
      p.providerId = src.providerId || fallback.providerId;
      p.model = src.model || fallback.model;
      return p;
    });
    if (group.name === '我的群聊' || group.name === '新群聊') group.name = '问题研讨';
    group.rosterVersion = 2;
  }
  // 旧版本地配置没有简介 / 风格 / 启用 / 规则,打开时补齐,不改用户已填的内容
  function hydrateGroup(group) {
    if (!group) return group;
    if (typeof group.intro !== 'string') group.intro = '';
    if (!group.createdAt) group.createdAt = Date.now();
    upgradeStarterRoster(group);
    if (!group.settings) group.settings = Object.assign({}, DEFAULT_SETTINGS);
    else {
      // 逐自有键拷贝并跳过 __proto__:group.settings 来自 localStorage,JSON.parse 出来的
      // "__proto__" 是自有属性,Object.assign 会经 [[Set]] 换掉 settings 的原型。
      const merged = Object.assign({}, DEFAULT_SETTINGS);
      for (const k of Object.keys(group.settings)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        merged[k] = group.settings[k];
      }
      group.settings = merged;
    }
    const cap = Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, Number(group.settings.maxMembers) || MAX_MEMBERS));
    group.settings.maxMembers = cap;
    group.settings.maxRounds = Math.min(4, Math.max(1, Number(group.settings.maxRounds) || 2));
    (group.participants || []).forEach((p) => {
      if (typeof p.bio !== 'string') p.bio = '';
      if (typeof p.style !== 'string') p.style = '';
      if (typeof p.enabled !== 'boolean') p.enabled = true;
      if (!p.prompt) p.prompt = p.admin ? ADMIN_PROMPT : MEMBER_PROMPT;
      if (typeof p.avatarPinned !== 'boolean') p.avatarPinned = false;
    });
    assignRoleAvatars(group);
    return group;
  }
  G.groups = function () { return load().groups; };
  G.activeGroup = function () {
    const c = load();
    return c.groups.find((g) => g.id === c.activeId) || null;
  };
  G.createGroup = function (name, intro) {
    const c = load();
    const g = makeGroup(name, intro);
    c.groups.unshift(g);
    c.activeId = g.id;
    save();
    return g;
  };
  G.removeGroup = function (id) {
    const c = load();
    c.groups = c.groups.filter((g) => g.id !== id);
    if (c.activeId === id) c.activeId = c.groups.length ? c.groups[0].id : null;
    save();
  };
  G.setActive = function (id) {
    const c = load();
    c.activeId = id;
    save();
  };
  G.save = save;

  // ---------- 模式 ----------
  G.isGroupMode = function () {
    try { return localStorage.getItem(MODE_KEY) === 'group'; } catch (e) { return false; }
  };
  G.setMode = function (mode) {
    try { localStorage.setItem(MODE_KEY, mode === 'group' ? 'group' : 'simple'); } catch (e) {}
    if (window.OCSettingsSync) window.OCSettingsSync.touchUi('composerMode');
    syncModeUI();
  };
  // 云同步应用了新的群聊配置 / 模式后调用:丢弃内存缓存重新加载并刷新界面
  G.reload = function () {
    cache = null;
    load();
    syncModeUI();
    // 弹窗是运行时建的,直接认闭包里的 modalEl(而不是按 id 去查 —— 曾经这里查的 id
    // 与元素对不上,永远取到 null,「同步后重绘已打开的弹窗」这行等于没写:开着设置弹窗时
    // 云同步落下来,面板还停在旧配置上)。「开着」按全站统一判据(有 show)判断,不用 hidden ——
    // closeModal 是先摘 show、320ms 后才加 hidden,那段时间其实已经关了。
    if (modalEl && modalEl.classList.contains('show')) render();
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 侧栏模式行:图标 + 文案 + 开关
  function syncModeUI() {
    const group = G.isGroupMode();
    const label = document.getElementById('chat-mode-label');
    const toggle = document.getElementById('chat-mode-toggle');
    const iconEl = document.getElementById('chat-mode-icon');
    const row = document.getElementById('chat-mode-row');
    if (label) label.textContent = group ? '多角色对话/简单' : '简单对话/多角色';
    if (toggle) toggle.checked = group;
    if (iconEl && window.OC && OC.icon) iconEl.innerHTML = OC.icon(group ? 'group' : 'chat', 15);
    if (row) row.title = group ? '群聊模式：点击打开群聊设置' : '简单对话模式：打开开关进入群聊';
  }

  // ---------- 发言顺序与角色 ----------
  function styleHint(p) {
    return STYLE_HINT[p && p.style] || '';
  }
  G.rolePromptFor = function (group, p, task) {
    const who = p.admin ? '群主' : '成员';
    const identity = '你在群聊「' + (group.name || '') + '」中是' + who + '「' + p.name + '」。';
    const setting = String(p.prompt || '').trim() || (p.admin ? ADMIN_PROMPT : MEMBER_PROMPT);
    const bio = String(p.bio || '').trim();
    const lines = [identity, '角色设定：' + setting];
    if (bio) lines.push('角色简介：' + bio);
    const style = styleHint(p);
    if (style) lines.push(style);
    if (group.intro) lines.push('群聊简介：' + group.intro);
    lines.push('以该身份自然发言，不要自称 AI 助手。');
    if (task) lines.push('本轮给你的任务：' + task);
    if (group.settings && group.settings.allowQuote) lines.push('可以引用其他成员已经说过的观点，但不要整段复述。');
    else lines.push('只从自己的角色出发回答，不要复述其他成员的发言。');
    return lines.join(NL);
  };

  function enabledMembers(group) {
    return (group.participants || []).filter((p) => p.enabled !== false && p.providerId && p.model);
  }
  function groupAdmin(group, members) {
    return (group.participants || []).find((p) => p.admin && p.enabled !== false && p.providerId && p.model)
      || (members || [])[0] || null;
  }
  function rosterText(members) {
    return members.map((p) => '- ' + p.name + (p.admin ? '（群主）' : '')
      + (p.bio ? '，简介：' + String(p.bio).slice(0, 60) : '')
      + '，角色：' + String(p.prompt || '').slice(0, 80)).join(NL);
  }
  // 让群主模型读问题和成员名单,返回 JSON。安排失败时由调用方决定回退。
  async function askAdmin(admin, sys, user) {
    const r = await api('/api/proxy/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: admin.providerId,
        model: admin.model,
        stream: false,
        _purpose: 'judge',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user || '请给出安排。' },
        ],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
    return String(extractText(data, 'chat') || '');
  }
  function parsePlan(text, members) {
    const m = String(text || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr = [];
    try { arr = JSON.parse(m[0]); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    arr.forEach((x) => {
      const name = String((x && (x.name || x.member)) || '').trim();
      const p = members.find((mm) => mm.name === name);
      if (!p || p.admin || out.some((o) => o.id === p.id)) return;
      out.push({ id: p.id, task: String((x && (x.task || x.note)) || '').slice(0, 300) });
    });
    return out;
  }

  // 群主先看问题:含糊就给选项,太简单就自己答并询问要不要讨论,值得深挖才安排成员。
  function parseGate(text) {
    const raw = String(text || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj = null;
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const action = String(obj.action || '').trim();
    if (action !== 'clarify' && action !== 'offer' && action !== 'discuss') return null;
    const options = (Array.isArray(obj.options) ? obj.options : [])
      .map((x) => String(x || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 4);
    return {
      action: action,
      question: String(obj.question || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      options: options,
    };
  }
  G.gateQuestion = async function (group, userMsg, members) {
    const admin = groupAdmin(group, members);
    if (!admin) return null;
    const question = String(userMsg.content || '').trim();
    if (!question) return null;
    const sys = '你是群聊「' + (group.name || '') + '」的群主「' + admin.name + '」。先判断这句话该怎么处理，这一步不要回答问题本身。' + NL
      + '三选一，只输出一个 JSON，不要输出其他内容：' + NL
      + '1. clarify：指代不明，或能理解成几种完全不同的意思。例如「这个怎么弄」「帮我看看」「优化一下」。' + NL
      + '   输出 {"action":"clarify","question":"一句追问","options":["方向一","方向二","方向三"]}。options 给 2 到 4 个互不相同、能直接选的方向，每个不超过 24 个字。' + NL
      + '2. offer：意思清楚，但一两句话就能答完，不值得多人讨论。例如事实、定义、换算、单一做法、「你好」。' + NL
      + '   输出 {"action":"offer"}。' + NL
      + '3. discuss：意思清楚，而且比较、方案、原因、权衡或容易有分歧，值得成员讨论。例如「帮我对比 A 和 B 哪个更适合新手」。' + NL
      + '   输出 {"action":"discuss"}。' + NL
      + '拿不准时选 offer，不要为了讨论而讨论。';
    try {
      const text = await askAdmin(admin, sys, '用户刚说：' + question.slice(0, 800));
      const parsed = parseGate(text);
      if (!parsed) return null;
      if (parsed.action === 'clarify' && parsed.options.length < 2) return null;
      return parsed;
    } catch (e) { return null; }
  };

  // 群主组织 / 专家协作:群主决定邀请谁、各自的任务
  G.planByOwner = async function (group, userMsg, members, expert) {
    const admin = groupAdmin(group, members);
    const others = members.filter((p) => !p.admin);
    const cap = Math.min(3, Math.max(1, Number(group.settings && group.settings.maxMembers) || 3));
    if (!admin || !others.length) return others.slice(0, cap).map((p) => ({ id: p.id, task: '' }));
    const sys = '你是群聊「' + (group.name || '') + '」的群主「' + admin.name + '」。' + NL
      + '成员：' + NL + rosterText(others) + NL + NL
      + '用户的问题：' + NL + String(userMsg.content || '').slice(0, 2000) + NL + NL
      + (expert
        ? '把问题拆成不超过 ' + cap + ' 个互不重叠的子任务，每个子任务是一份可以单独提交的交付物，交给最合适的一名成员。task 里写清交付物，并写明不要涉及其他子任务。没有对应专长的成员不要安排。'
        : '只点名最相关的 1-' + cap + ' 名成员。task 里写清这个人只谈哪一块、不要谈什么。不相关的人不要为了凑数写进去。')
      + '只输出 JSON 数组，形如 [{"name":"成员名","task":"一句话任务"}]，不要输出其他内容。';
    try {
      const text = await askAdmin(admin, sys, expert ? '请拆分并分配子任务。' : '请安排发言。');
      const plan = parsePlan(text, others).slice(0, cap);
      if (plan.length) return plan;
    } catch (e) { /* 安排失败:回退为全体成员依次回答 */ }
    return others.slice(0, cap).map((p) => ({ id: p.id, task: '' }));
  };

  // ---------- 发送一轮群聊 ----------
  G.sendGroupTurn = async function (text, attachments) {
    // 群聊一轮是「多个成员串行请求」的循环,循环间隙 state.streaming 会被
    // requestAssistantReply 的 finally 复位 —— 只看 streaming 的话,成员正在讨论时
    // 用户再按 Enter 就会并行起第二个回合:两个回合往同一段对话里穿插发言,
    // 且第二个回合 beginTurn() 递增令牌会把第一个回合整体静默掐死(没有提示)。
    // _groupTurnActive 只在整回合结束才复位,必须一起守。
    // 返回 true/false:调用方据此决定要不要清空输入框,被拒时用户的草稿不能丢。
    if (state.streaming || state._groupTurnActive) {
      toast(state._groupTurnActive ? '群聊回合进行中，请等成员们说完' : '正在生成中，请稍候', true);
      return false;
    }
    try {
      // inner 在「根本没开跑」时(没建群 / 没给角色分配模型 / 未登录 / 额度不足)显式返回 false,
      // 这里原样透出:只弹一句提示不算数,调用方要靠返回值保住输入框里的草稿。
      const started = await G.sendGroupTurnInner(text, attachments);
      return started !== false;
    } finally {
      state._groupTurnActive = false;
    }
  };

  function setPhase(label) {
    state._groupPhase = label || '';
    const el = document.getElementById('group-phase');
    if (!el) return;
    if (!label) { el.textContent = ''; el.classList.add('hidden'); return; }
    el.textContent = label;
    el.classList.remove('hidden');
  }
  // 发言前重新拿到当前会话对象:云同步替换 state.chats 后,旧引用上的发言不会显示
  function liveChat(chatId, fallback) {
    return state.chats.find((c) => c.id === chatId) || fallback;
  }
  async function speak(chatId, chat, group, p, stage, task, label) {
    chat = liveChat(chatId, chat);
    if (!p || p.enabled === false || !p.providerId || !p.model) return chat;
    const stageLabel = label || (stage === 'plan' ? '任务分配'
      : (stage === 'clarify' ? '先确认问题'
      : (stage === 'offer' ? '先简要回答'
      : (stage === 'summary' ? '群主总结' : '成员讨论'))));
    setPhase(stageLabel + ' · ' + p.name);
    p._rolePrompt = G.rolePromptFor(group, p, task);
    if (!p.avatarPinned) {
      const idx = group.participants.indexOf(p);
      if (idx >= 0) p.avatar = (idx % ROLE_AVATAR_COUNT) + 1;
    }
    await requestGroupReply(chat, p, { stage: stage, stageLabel: stageLabel });
    return liveChat(chatId, chat);
  }

  // 返回值:false = 这一轮没有发出去(纯提示),调用方必须保留输入框草稿;其余情况视为已发出
  G.sendGroupTurnInner = async function (text, attachments) {
    const group = G.activeGroup();
    if (!group) { toast('请先在群聊设置中创建并进入一个群聊', true); setPhase(''); return false; }
    hydrateGroup(group);
    const members = enabledMembers(group);
    if (!members.length) { toast('请先在「参与人数」里启用成员并分配模型', true); setPhase(''); return false; }
    if (!state.user) { openAuthModal(); return false; }
    if (!quotaIsUnlimited(state.user.quota) && state.user.quota <= 0) {
      if (state.isGuest) {
        state.isGuestExpired = true;
        showGuestBar();
        openAuthModal('游客体验次数已用完，注册或登录后可继续对话');
      } else {
        toast('剩余次数不足，请联系管理员', true);
      }
      return false;
    }
    let chat = currentChat();
    if (!chat || !chat.id) chat = newChat();
    if (!chat.messages || !chat.messages.length) {
      chat.title = group.name || '群聊';
      renderChatList();
    }
    chat.groupId = group.id;
    chat.updatedAt = Date.now();
    const displayParts = [];
    if (text) displayParts.push(text);
    if (attachments && attachments.length && window.OCMultimodal) {
      attachments.forEach((a) => displayParts.push(window.OCMultimodal.toMarkdown(a)));
    }
    const userMsg = {
      role: 'user',
      content: displayParts.join(NL + NL) || '（附件）',
      text,
      attachments,
      createdAt: Date.now(),
      // 与单模型对话一致:气泡里回显这条提问选中的 @助手 / @笔记 引用
      mentions: (window.OCApp && window.OCApp.mentionsSnapshot) ? window.OCApp.mentionsSnapshot(chat) : [],
    };
    chat.messages.push(userMsg);
    if (window.OCApp && window.OCApp.clearNoteMentionsAfterSend) window.OCApp.clearNoteMentionsAfterSend();
    jumpToLatestOnSend();
    saveChats();
    renderMessages();

    // 回合期间暂停云端拉取/推送:发言间隙若整体替换 state.chats,
    // 后续成员会写进幽灵副本(回答不出现),且反复重绘导致界面闪烁
    state._groupTurnActive = true;
    // 本回合的整体令牌:成员是一个接一个发言的,用户中途点「停止」时
    // 只 abort 当前请求不会让下面的循环停下(下一轮照样开跑并计费),
    // 这里记下令牌,每轮发言前自查,被停止就整体退出。
    const turnId = (function () {
      if (window.OCApp && typeof window.OCApp.beginTurn === 'function') return window.OCApp.beginTurn();
      state.turnToken = (state.turnToken || 0) + 1;
      return state.turnToken;
    })();
    const stopped = () => (window.OCApp && typeof window.OCApp.turnCancelled === 'function')
      ? window.OCApp.turnCancelled(turnId)
      : turnId !== state.turnToken;
    const chatId = chat.id;
    const admin = groupAdmin(group, members);
    const others = members.filter((p) => !p.admin);
    const mode = MODES.some((m) => m.key === group.mode) ? group.mode : 'owner';
    const wantSummary = !group.settings || group.settings.autoSummary !== false;

    if (admin) {
      setPhase('群主判断 · ' + admin.name);
      const gate = await G.gateQuestion(group, userMsg, members);
      if (gate && gate.action === 'clarify') {
        const ask = gate.question || '这句话可以有几种理解，你更想讨论哪一种？';
        chat = await speak(chatId, chat, group, admin, 'clarify',
          '用户的问题还不够具体，先不要安排成员发言，也不要自己把问题答完。' + NL
          + '用「' + ask + '」作为开头，然后只给出下面这些选项，每个选项单独成行，行首用「1. 」「2. 」这样的序号：' + NL
          + gate.options.map((o, i) => (i + 1) + '. ' + o).join(NL) + NL
          + '最后补一句：选一个编号，或直接补充你的具体意思，我再安排讨论。');
        chat = liveChat(chatId, chat);
        setPhase('');
        state._groupTurnActive = false;
        saveChats();
        renderMessages();
        scheduleCloudSync();
        return;
      }
      if (gate && gate.action === 'offer') {
        chat = await speak(chatId, chat, group, admin, 'offer',
          '这个问题一两句话就能回答，不要安排成员发言，也不要展开成长文。' + NL
          + '先用不超过三句话直接给出答案，然后另起一行问用户：要不要让群成员展开讨论？回复「讨论」就安排，回复「不用」就到这里。');
        chat = liveChat(chatId, chat);
        setPhase('');
        state._groupTurnActive = false;
        saveChats();
        renderMessages();
        scheduleCloudSync();
        return;
      }
    }

    if (mode === 'free') {
      const rounds = Math.min(4, Math.max(1, Number(group.settings && group.settings.maxRounds) || 1));
      const seats = others.slice(0, Math.min(others.length, Math.max(2, Number(group.settings && group.settings.maxMembers) || others.length)));
      let motion = '围绕用户的问题，给出一个可以赞成或反对的判断';
      if (admin && seats.length) {
        try {
          const raw = await askAdmin(admin,
            '把用户的问题收成一个可以争论的命题，不超过 30 个字。只输出命题本身，不要解释。',
            String(userMsg.content || '').slice(0, 500));
          const line = String(raw || '').replace(/\s+/g, ' ').trim();
          if (line) motion = line.slice(0, 40);
        } catch (e) { /* 命题生成失败时用原问题 */ }
      }
      let previous = null;
      for (let round = 1; round <= rounds; round++) {
        if (stopped()) break;
        for (let i = 0; i < seats.length; i++) {
          if (stopped()) break;
          const p = seats[i];
          const side = (i + round) % 2 === 1 ? '反对' : '支持';
          const task = !previous
            ? '自由讨论只争这一个命题：「' + motion + '」。你的立场是' + side + '。开头先写「' + side + '。」，再用不超过三句给一条理由。不要解释命题，不要给方案，不要替别人说话。'
            : '自由讨论第 ' + round + ' 轮，命题仍是：「' + motion + '」。你只反驳 @' + previous.name + ' 的上一条，立场是' + side + '。开头先写「' + side + '。」，点出对方哪一句不成立，再补一条新理由。不要总结全场，不要重复自己前面说过的话。';
          chat = await speak(chatId, chat, group, p, 'talk', task, '自由讨论 · ' + side);
          previous = p;
        }
      }
    } else if (mode === 'round') {
      const seats = others.slice(0, 4);
      const fallback = ['先界定问题', '给出一种做法', '指出这种做法的风险', '写下下一步'];
      let layers = seats.map((_, i) => fallback[Math.min(i, fallback.length - 1)]);
      if (admin && seats.length) {
        try {
          const raw = await askAdmin(admin,
            '按用户的问题设计 ' + seats.length + ' 层接力，每层只做一件事，后一层必须依赖前一层。只输出 JSON 字符串数组，每项不超过 18 个字，不要输出其他内容。',
            String(userMsg.content || '').slice(0, 500));
          const m = String(raw || '').match(/\[[\s\S]*\]/);
          const arr = m ? JSON.parse(m[0]) : [];
          const clean = (Array.isArray(arr) ? arr : []).map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
          if (clean.length >= seats.length) layers = clean.slice(0, seats.length);
        } catch (e) { /* 用固定层次 */ }
      }
      let previous = null;
      for (let i = 0; i < seats.length; i++) {
        if (stopped()) break;
        const layer = layers[i];
        const mark = '第 ' + (i + 1) + '/' + seats.length + ' 层';
        const task = !previous
          ? '轮流接力，你是 ' + mark + '，这一层只做：' + layer + '。只写这一层，不超过四句。不要写后面几层，也不要给完整答案。'
          : '轮流接力，你是 ' + mark + '，紧接 @' + previous.name + '。这一层只做：' + layer + '。先用半句接住对方的最后一点，再写本层。不要重写前面的层，不要另起方案。不超过四句。';
        chat = await speak(chatId, chat, group, seats[i], 'talk', task, '轮流接力 · ' + (i + 1) + '/' + seats.length);
        previous = seats[i];
      }
    } else if (mode === 'expert') {
      setPhase('任务分配 · ' + (admin ? admin.name : '群主') + ' 拆题中');
      const plan = await G.planByOwner(group, userMsg, members, true);
      if (admin) {
        chat = await speak(chatId, chat, group, admin, 'plan',
          '你在做专家协作的拆题，不要自己回答问题。先用一句话写出最终要交付的结果，然后每个子任务单独成行。每行必须以 @名字 开头（名字与成员名完全一致），再写这一份交付物，并写明「不要涉及其他子任务」。子任务之间不能重叠。安排如下：' + NL
          + plan.map((x) => {
            const who = group.participants.find((p) => p.id === x.id);
            return who ? ('@' + who.name + ' ' + (x.task || '完成与你的专长对应的那一部分')) : '';
          }).filter(Boolean).join(NL),
          '专家拆题');
      }
      for (let i = 0; i < plan.length; i++) {
        if (stopped()) break;
        const step = plan[i];
        const p = group.participants.find((x) => x.id === step.id);
        const task = '专家协作：你只提交自己的那一份，不评论其他专家，不补充别人的任务，也不做全场总结。' + NL
          + '你的交付物：' + (step.task || '完成与你的专长对应的那一部分') + '。' + NL
          + '用「结论」「依据」两个小标题写完即可。';
        chat = await speak(chatId, chat, group, p, 'talk', task, '专家交付 ' + (i + 1) + '/' + plan.length);
      }
    } else {
      setPhase('任务分配 · ' + (admin ? admin.name : '群主') + ' 点名中');
      const plan = await G.planByOwner(group, userMsg, members, false);
      if (admin) {
        chat = await speak(chatId, chat, group, admin, 'plan',
          '你在组织讨论，不要自己把问题答完。先用一句话说明为什么只请这几位、其他人这次不发言。然后每个被点到的人单独成行，行首必须是 @名字（名字与成员名完全一致），后面用一句话限定对方只谈哪一块、不要谈什么。安排如下：' + NL
          + plan.map((x) => {
            const who = group.participants.find((p) => p.id === x.id);
            return who ? ('@' + who.name + ' ' + (x.task || '只从你的角色回答')) : '';
          }).filter(Boolean).join(NL),
          '群主点名');
      }
      for (const step of plan) {
        if (stopped()) break;
        const p = group.participants.find((x) => x.id === step.id);
        const task = '群主组织：只完成点名时交给你的这一块，不要把整个问题答完，也不要替没被点到的人发言。' + NL
          + '你的范围：' + (step.task || '只从你的角色回答') + '。' + NL
          + '若发言会超出这个范围，就停住并说明这超出了你的任务。';
        chat = await speak(chatId, chat, group, p, 'talk', task, '限范围发言');
      }
    }

    if (wantSummary && admin && mode !== 'offer') {
      const summaryTask = {
        owner: '这是群主组织的收口。用三个小标题写：决定、谁的意见被采纳、还没覆盖的部分。不要逐条复述，也不要再点名展开新一轮。',
        free: '这是自由讨论的收口。用三个小标题写：已形成的共识、仍在争论的一点、如果继续讨论最值得追问的一个问题。不要把每轮发言再讲一遍。',
        round: '这是轮流发言的收口。按成员接力的顺序，把每一层合成一条连续的回答，最后单列「下一步」。不要重新引入接力里没有出现的方案。',
        expert: '这是专家协作的拼接。用四个小标题：结论、依据、分歧点、建议。依据必须能对应到某一位专家的交付，分歧只写子任务之间对不上的地方。不要替专家补写他们没交的内容。',
      }[mode] || '成员已经发言完毕。请做总结：先给结论，再点出一致与分歧，最后给一条可执行的建议。不要复述每条发言。';
      const summaryLabel = { owner: '组织收口', free: '讨论收口', round: '接力收口', expert: '专家拼接' }[mode] || '群主总结';
      chat = await speak(chatId, chat, group, admin, 'summary', summaryTask, summaryLabel);
    }
    chat = liveChat(chatId, chat);
    if (group.settings && group.settings.saveFullHistory === false && chat && Array.isArray(chat.messages)) {
      const start = chat.messages.lastIndexOf(userMsg);
      if (start >= 0) {
        const head = chat.messages.slice(0, start + 1);
        const tail = chat.messages.slice(start + 1).filter((m) => m && m.participant && m.participant.stage === 'summary');
        chat.messages = head.concat(tail.length ? tail : chat.messages.slice(-1));
      }
    }
    setPhase('');
    state._groupTurnActive = false;
    saveChats();
    renderMessages();
    scheduleCloudSync();
  };

  // ---------- 群聊设置大弹窗(与用户设置弹窗同风格) ----------
  let modalEl = null;
  let panelTab = 'list';
  const TABS = [
    { key: 'list', label: '群聊列表' },
    { key: 'members', label: '参与人数' },
    { key: 'roles', label: '角色配置' },
    { key: 'mode', label: '对话模式' },
  ];

  function modelItemsFlat() {
    const flat = [];
    (availableModelItems ? availableModelItems() : []).forEach((g) => (g.items || []).forEach((it) => flat.push(it)));
    return flat;
  }

  function avatarHtml(p, extraClass) {
    const src = roleAvatarSrc(p && p.avatar);
    return '<img class="group-role-avatar' + (extraClass ? ' ' + extraClass : '') + '" src="' + esc(src) + '" alt="" draggable="false">';
  }
  function memberCardHtml(p) {
    const hit = modelItemsFlat().find((it) => String(it.value) === (p.providerId + SEP + p.model));
    const label = hit ? hit.label : (p.model || '选择模型…');
    const icon = hit && hit.icon && window.OC && OC.logoImg ? OC.logoImg(hit.icon, 'item-logo') : '';
    const on = p.enabled !== false;
    return '<div class="group-member-card' + (on ? '' : ' is-off') + '">'
      + '<button type="button" class="group-avatar-swap" data-pid="' + esc(p.id) + '" title="换一个头像" aria-label="更换 ' + esc(p.name) + ' 的头像">' + avatarHtml(p) + '</button>'
      + '<div class="group-member-name' + (p.admin ? ' is-admin' : '') + '">' + esc(p.name) + (p.admin ? '<span class="group-admin-badge">群主</span>' : '') + '</div>'
      + '<button type="button" class="group-model-btn" data-pid="' + esc(p.id) + '">' + icon + '<span class="group-model-label">'
      + esc(label) + '</span></button>'
      + '<label class="group-enable"><input type="checkbox" class="group-enable-input" data-pid="' + esc(p.id) + '"' + (on ? ' checked' : '') + '> 启用</label>'
      + '</div>';
  }

  function rolesHtml(group) {
    return '<div class="group-roles">' + group.participants.map((p) =>
      '<div class="group-role-row' + (p.admin ? ' is-admin' : '') + '">'
      + '<div class="group-role-head">'
      + avatarHtml(p, 'small')
      + '<input class="group-role-name" data-pid="' + esc(p.id) + '" value="' + esc(p.name) + '" maxlength="12" aria-label="成员名称">'
      + '<label class="group-admin-radio"><input type="radio" name="group-admin" data-pid="' + esc(p.id) + '"' + (p.admin ? ' checked' : '') + '> 群主</label>'
      + '</div>'
      + '<input class="group-role-bio" data-pid="' + esc(p.id) + '" value="' + esc(p.bio || '') + '" maxlength="80" placeholder="一句话简介，如「负责从用户视角挑错」" aria-label="角色简介">'
      + '<div class="group-style-row">' + STYLES.map((s) =>
        '<button type="button" class="group-style' + ((p.style || '') === s.key ? ' active' : '') + '" data-pid="' + esc(p.id) + '" data-style="' + s.key + '">' + s.label + '</button>'
      ).join('') + '</div>'
      + '<textarea class="group-role-prompt" data-pid="' + esc(p.id) + '" rows="3" placeholder="该成员的角色预设（Prompt）…" aria-label="角色预设">' + esc(p.prompt || '') + '</textarea>'
      + '<div class="group-role-ops">'
      + '<button type="button" class="btn small group-prompt-copy" data-pid="' + esc(p.id) + '">复制</button>'
      + '<button type="button" class="btn small group-prompt-reset" data-pid="' + esc(p.id) + '">恢复默认</button>'
      + '</div>'
      + '</div>'
    ).join('') + '</div>';
  }

  function modeHtml(group) {
    const s = group.settings || DEFAULT_SETTINGS;
    const checks = [
      { key: 'allowQuote', label: '允许成员引用彼此的发言' },
      { key: 'autoSummary', label: '讨论结束后由群主自动总结' },
      { key: 'saveFullHistory', label: '保存完整群聊记录（关闭后只保留每轮的问题与群主总结）' },
    ];
    return '<div class="group-modes">' + MODES.map((m) =>
      '<button type="button" class="group-mode-card' + (group.mode === m.key ? ' active' : '') + '" data-mode="' + m.key + '">'
      + '<div class="group-mode-title">' + m.title + (group.mode === m.key ? '<span class="group-mode-check">当前</span>' : '') + '</div>'
      + '<div class="group-mode-desc">' + m.desc + '</div>'
      + '</button>'
    ).join('') + '</div>'
    + '<div class="group-rules">'
    + '<div class="group-rule"><span>每轮最多发言成员</span>'
    + '<button type="button" class="group-rule-pick" data-key="maxMembers" aria-label="每轮最多发言成员">'
    + '<span>' + (Number(s.maxMembers) || MAX_MEMBERS) + ' 人</span></button></div>'
    + '<div class="group-rule"><span>自由讨论最多轮数</span>'
    + '<button type="button" class="group-rule-pick" data-key="maxRounds" aria-label="自由讨论最多轮数">'
    + '<span>' + (Number(s.maxRounds) || 2) + ' 轮</span></button></div>'
    + checks.map((c) => '<label class="group-rule"><input type="checkbox" class="group-rule-check" data-key="' + c.key + '"' + (s[c.key] !== false ? ' checked' : '') + '> ' + c.label + '</label>').join('')
    + '</div>'
    + '<p class="group-mode-hint muted small">每位成员的发言都按一次对话计费。群主安排发言时额外用一次。</p>';
  }

  function groupSummary(g) {
    const chats = (typeof state !== 'undefined' && state.chats) || [];
    let last = '';
    chats.forEach((c) => {
      if (!c || c.groupId !== g.id) return;
      (c.messages || []).forEach((m) => {
        if (m && m.role === 'user' && m.content) last = String(m.content);
      });
    });
    last = last.replace(/\s+/g, ' ').trim();
    if (last.length > 42) last = last.slice(0, 42) + '…';
    return last;
  }
  function formatCreated(ts) {
    const n = Number(ts);
    if (!n) return '';
    const d = new Date(n);
    if (isNaN(d.getTime())) return '';
    const p2 = (v) => String(v).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }
  function listHtml() {
    const c = load();
    let html = '<div class="group-create">'
      + '<input id="group-new-name" maxlength="30" placeholder="群聊名称，如「产品讨论」" aria-label="新群聊名称">'
      + '<input id="group-new-intro" maxlength="200" placeholder="群聊简介（可选），如「评测新功能的可用性」" aria-label="群聊简介">'
      + '<button type="button" class="btn primary small" id="group-create-btn">创建群聊</button>'
      + '</div>';
    if (!c.groups.length) {
      html += '<p class="muted small group-empty">还没有群聊。创建一个，选好成员和模型就能开始。</p>';
    } else {
      html += '<div class="group-list">' + c.groups.map((g) => {
        const mode = (MODES.find((m) => m.key === g.mode) || MODES[0]).title;
        const summary = groupSummary(g);
        const when = formatCreated(g.createdAt);
        return '<div class="group-item' + (g.id === c.activeId ? ' active' : '') + '" data-gid="' + esc(g.id) + '">'
          + '<div class="group-item-main">'
          + '<div class="group-item-name">' + esc(g.name) + (g.id === c.activeId ? '<span class="group-current-badge">当前</span>' : '') + '</div>'
          + (g.intro ? '<div class="group-item-intro">' + esc(g.intro) + '</div>' : '')
          + '<div class="group-item-sub muted small">' + g.participants.length + ' 位成员 · ' + mode + (when ? ' · 创建于 ' + when : '') + '</div>'
          + (summary ? '<div class="group-item-summary muted small">最近：' + esc(summary) + '</div>' : '')
          + '</div>'
          + '<button type="button" class="btn small group-enter" data-gid="' + esc(g.id) + '">' + (g.id === c.activeId ? '编辑' : '选择') + '</button>'
          + '<button type="button" class="icon-btn group-del" data-gid="' + esc(g.id) + '" title="删除群聊" aria-label="删除群聊">🗑</button>'
          + '</div>';
      }).join('') + '</div>';
    }
    return html;
  }

  function membersHtml(group) {
    if (!group) return '<p class="muted small group-empty">请先在「群聊列表」创建或选择一个群聊。</p>';
    const cap = Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, Number(group.settings && group.settings.maxMembers) || MAX_MEMBERS));
    return '<div class="group-count-row">'
      + '<span>参与人数</span>'
      + '<div class="group-count-stepper">'
      + '<button type="button" id="group-count-minus" aria-label="减少成员"' + (group.participants.length <= MIN_MEMBERS ? ' disabled' : '') + '>−</button>'
      + '<span class="group-count-num">' + group.participants.length + '</span>'
      + '<button type="button" id="group-count-plus" aria-label="增加成员"' + (group.participants.length >= cap ? ' disabled' : '') + '>+</button>'
      + '</div>'
      + '<span class="muted small">' + MIN_MEMBERS + '–' + cap + ' 人，点头像可更换</span>'
      + '</div>'
      + '<div class="group-member-grid">' + group.participants.map((p) => memberCardHtml(p)).join('') + '</div>'
      + '<p class="muted small">没有可选模型时，先在「设置 → 供应商」里添加。停用的成员不参与本轮发言。</p>';
  }

  function render() {
    if (!modalEl) return;
    const group = G.activeGroup();
    const tabs = TABS.map((t) =>
      '<button type="button" class="settings-tab' + (panelTab === t.key ? ' active' : '') + '" data-tab="' + t.key + '" role="tab">' + t.label + '</button>'
    ).join('');
    let body = '';
    if (panelTab === 'list') body = listHtml();
    else if (panelTab === 'members') body = membersHtml(group);
    else if (panelTab === 'roles') body = group ? rolesHtml(group) : '<p class="muted small group-empty">请先在「群聊列表」创建并进入一个群聊。</p>';
    else body = group ? modeHtml(group) : '<p class="muted small group-empty">请先在「群聊列表」创建并进入一个群聊。</p>';
    const bodyEl = modalEl.querySelector('.modal-body');
    if (bodyEl) bodyEl.innerHTML = body;
    const tabsEl = modalEl.querySelector('#group-modal-tabs');
    if (tabsEl) tabsEl.innerHTML = tabs;
    const titleEl = modalEl.querySelector('#group-modal-title');
    if (titleEl) titleEl.textContent = '群聊设置' + (group ? ' · ' + group.name : '');
  }

  function closeModal() {
    if (!modalEl) return;
    if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(modalEl);
    else modalEl.classList.add('hidden');
  }

  function openModal() {
    if (!modalEl) {
      modalEl = document.createElement('div');
      // 以前它没有 id,而 G.reload 又按 id 去找它 —— 两边对不上,同步后重绘就一直是死代码。
      // 补上 id(与里面的 group-modal-tabs / group-modal-title 同一套命名),元素可被寻址,
      // 打开状态也能用选择器直接查。
      modalEl.id = 'group-modal';
      modalEl.className = 'modal-mask hidden';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.innerHTML =
        '<div class="modal modal-lg">'
        + '<div class="modal-header"><h3 id="group-modal-title">群聊设置</h3>'
        + '<button class="icon-btn" data-act="close" aria-label="关闭群聊设置">' + (window.OC && OC.icon ? OC.icon('close', 16) : '✕') + '</button></div>'
        + '<div class="settings-shell"><div class="settings-tabs" id="group-modal-tabs" role="tablist"></div>'
        + '<div class="modal-body"></div></div>'
        + '</div>';
      document.body.appendChild(modalEl);
      // 事件委托(面板重渲染不重复绑定)
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl || e.target.closest('[data-act="close"]')) { closeModal(); return; }
        const tab = e.target.closest('.settings-tab');
        if (tab) { panelTab = tab.dataset.tab; render(); return; }
        if (e.target.closest('#group-create-btn')) {
          const input = modalEl.querySelector('#group-new-name');
          const introEl = modalEl.querySelector('#group-new-intro');
          const name = String((input && input.value) || '').trim();
          const intro = String((introEl && introEl.value) || '').trim();
          G.createGroup(name || ('群聊 ' + (load().groups.length + 1)), intro);
          panelTab = 'members';
          render();
          return;
        }
        const enter = e.target.closest('.group-enter');
        if (enter) { G.setActive(enter.dataset.gid); panelTab = 'members'; render(); return; }
        const del = e.target.closest('.group-del');
        if (del) { G.removeGroup(del.dataset.gid); render(); return; }
        if (e.target.closest('#group-count-plus')) {
          const group = G.activeGroup();
          const cap = group ? Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, Number(group.settings && group.settings.maxMembers) || MAX_MEMBERS)) : MAX_MEMBERS;
          if (group && group.participants.length < cap) {
            const used = new Set(group.participants.map((p) => p.emoji));
            const idxBase = group.participants.length;
            let nx = { emoji: '🤖', name: '成员' + (idxBase + 1) };
            for (let i = 0; i < EMOJI_POOL.length; i++) {
              const emoji = EMOJI_POOL[(idxBase + i) % EMOJI_POOL.length];
              if (!used.has(emoji)) { nx = { emoji, name: NAME_POOL[(idxBase + i) % NAME_POOL.length] || nx.name }; break; }
            }
            const usedNames = new Set(group.participants.map((p) => p.name));
            const preset = ROLE_PRESETS.find((r) => !r.admin && !usedNames.has(r.name));
            group.participants.push(preset ? participantFromPreset(preset, idxBase) : makeParticipant(idxBase, false));
            const p = group.participants[group.participants.length - 1];
            if (!preset) { p.emoji = nx.emoji; p.name = nx.name; }
            assignRoleAvatars(group);
            save(); render();
          }
          return;
        }
        if (e.target.closest('#group-count-minus')) {
          const group = G.activeGroup();
          if (group && group.participants.length > MIN_MEMBERS) {
            const gone = group.participants.pop();
            if (gone.admin && group.participants.length) group.participants[0].admin = true;
            assignRoleAvatars(group);
            save(); render();
          }
          return;
        }
        const modeCard = e.target.closest('.group-mode-card');
        if (modeCard) {
          const group = G.activeGroup();
          const key = modeCard.dataset.mode;
          if (group && MODES.some((m) => m.key === key)) { group.mode = key; save(); render(); }
          return;
        }
        const swap = e.target.closest('.group-avatar-swap');
        if (swap) {
          const group = G.activeGroup();
          const p = group && group.participants.find((x) => x.id === swap.dataset.pid);
          if (p) {
            p.avatar = nextRoleAvatar(p);
            p.avatarPinned = true;
            save(); render();
          }
          return;
        }
        const styleBtn = e.target.closest('.group-style');
        if (styleBtn) {
          const group = G.activeGroup();
          const p = group && group.participants.find((x) => x.id === styleBtn.dataset.pid);
          if (p && STYLES.some((s) => s.key === styleBtn.dataset.style)) {
            p.style = styleBtn.dataset.style;
            save(); render();
          }
          return;
        }
        const copyBtn = e.target.closest('.group-prompt-copy');
        if (copyBtn) {
          const group = G.activeGroup();
          const p = group && group.participants.find((x) => x.id === copyBtn.dataset.pid);
          const text = p ? String(p.prompt || '') : '';
          const done = () => toast('已复制角色预设');
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
          else done();
          return;
        }
        const resetBtn = e.target.closest('.group-prompt-reset');
        if (resetBtn) {
          const group = G.activeGroup();
          const p = group && group.participants.find((x) => x.id === resetBtn.dataset.pid);
          if (p) {
            p.prompt = defaultPromptFor(p);
            save(); render();
            toast('已恢复默认预设');
          }
          return;
        }
        const adminRadio = e.target.closest('input[name="group-admin"]');
        if (adminRadio) {
          const group = G.activeGroup();
          if (group) {
            group.participants.forEach((p) => {
              p.admin = p.id === adminRadio.dataset.pid;
              if (p.admin && p.preset === 'owner') p.name = '群主';
            });
            save(); render();
          }
          return;
        }
        const rulePick = e.target.closest('.group-rule-pick');
        if (rulePick) {
          const group = G.activeGroup();
          if (!group || !window.OC || !OC.openSelect) return;
          if (!group.settings) group.settings = Object.assign({}, DEFAULT_SETTINGS);
          const key = rulePick.dataset.key;
          const choices = key === 'maxMembers' ? [2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4];
          const unit = key === 'maxMembers' ? ' 人' : ' 轮';
          OC.openSelect(rulePick, choices.map((n) => ({ value: String(n), label: n + unit })), {
            fitWidth: true,
            selected: String(group.settings[key]),
            onSelect: (val) => {
              const n = Number(val);
              if (key === 'maxMembers') group.settings.maxMembers = Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, n || MAX_MEMBERS));
              if (key === 'maxRounds') group.settings.maxRounds = Math.min(4, Math.max(1, n || 2));
              save(); render();
            },
          });
          return;
        }
        const modelBtn = e.target.closest('.group-model-btn');
        if (modelBtn) {
          const group = G.activeGroup();
          const p = group && group.participants.find((x) => x.id === modelBtn.dataset.pid);
          if (!p) return;
          const items = availableModelItems();
          const total = items.reduce((n, g) => n + g.items.length, 0);
          if (!total) { toast('暂无可用模型，请先在设置里添加供应商', true); return; }
          OC.openSelect(modelBtn, items, {
            menuClass: 'oc-model-menu',
            fitWidth: true,
            searchable: total > 8,
            searchPlaceholder: '搜索供应商或模型…',
            selected: p.providerId ? p.providerId + SEP + p.model : null,
            onSelect: (val) => {
              const parts = String(val).split(SEP);
              p.providerId = parts[0] || '';
              p.model = parts.slice(1).join(SEP) || '';
              save(); render();
            },
          });
          return;
        }
      });
      modalEl.addEventListener('input', (e) => {
        const group = G.activeGroup();
        if (!group) return;
        const nameInput = e.target.closest('.group-role-name');
        if (nameInput) {
          const p = group.participants.find((x) => x.id === nameInput.dataset.pid);
          if (p) { p.name = String(nameInput.value || '').trim().slice(0, 12) || p.name; save(); }
          return;
        }
        const promptInput = e.target.closest('.group-role-prompt');
        if (promptInput) {
          const p = group.participants.find((x) => x.id === promptInput.dataset.pid);
          if (p) { p.prompt = String(promptInput.value || '').slice(0, 2000); save(); }
          return;
        }
        const bioInput = e.target.closest('.group-role-bio');
        if (bioInput) {
          const p = group.participants.find((x) => x.id === bioInput.dataset.pid);
          if (p) { p.bio = String(bioInput.value || '').slice(0, 80); save(); }
        }
      });
      modalEl.addEventListener('change', (e) => {
        const group = G.activeGroup();
        if (!group) return;
        const enable = e.target.closest('.group-enable-input');
        if (enable) {
          const p = group.participants.find((x) => x.id === enable.dataset.pid);
          if (p) { p.enabled = !!enable.checked; save(); render(); }
          return;
        }
        const check = e.target.closest('.group-rule-check');
        if (check) {
          if (!group.settings) group.settings = Object.assign({}, DEFAULT_SETTINGS);
          if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, check.dataset.key)) {
            group.settings[check.dataset.key] = !!check.checked;
            save();
          }
        }
      });
    }
    panelTab = 'list';
    render();
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(modalEl);
    else { modalEl.classList.remove('hidden'); requestAnimationFrame(() => modalEl.classList.add('show')); }
  }

  // ---------- 入口绑定 ----------
  function wire() {
    const row = document.getElementById('chat-mode-row');
    const toggle = document.getElementById('chat-mode-toggle');
    if (!row || !toggle) return;
    // 这一行本身是 <button>,里面再放 checkbox 时,点击会冒泡到按钮。
    // 复选框的状态要等 click 冒泡结束后才翻转,所以这里不能读 toggle.checked,
    // 否则「关掉」会被读成还开着,模式立刻被设回群聊,表现为开关关不掉。
    row.addEventListener('click', (e) => {
      const onSwitch = !!e.target.closest('.switch');
      if (onSwitch) e.preventDefault(); // 状态由下面按当前模式翻转,不交给 checkbox 自己改
      const turnOn = onSwitch ? !G.isGroupMode() : true;
      G.setMode(turnOn ? 'group' : 'simple');
      if (turnOn) openModal();
    });
    syncModeUI();
  }

  G.init = function () {
    load();
    wire();
    syncModeUI();
  };

  window.OCGroup = G;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => G.init());
  else G.init();
})();
