'use strict';
/**
 * im.js — 在线聊天(好友 / 单聊 / 群聊)模块
 *  - 侧栏「在线聊天」入口 → 近全屏 Telegram 风格弹窗(会话列表 | 聊天窗)
 *  - 好友:用户名搜索 → 发请求/同意;群聊:好友拉群、邀请、退群/解散
 *  - AI 召唤:输入 @ 选「AI 回答」(或会话开启 AI 模式)→ 服务端生成回复,轮询收取
 *  - 附件:/api/im/upload,图片内联预览,文件下载卡片;上限由后台设置
 *  - 双向删除:消息/会话删除后双方不可见,内容进管理端留档
 *  - 实时性:打开 4s / 关闭 25s 轮询 /api/im/updates(角标),发送后立即增量拉取
 */
(function () {
  const S = {
    ready: false, open: false,
    tab: 'chats',                 // chats | friends | newgroup
    threads: [],                  // 会话列表(threads 全量 + updates 增量合并)
    friends: [], requests: [], sent: [],
    searchResults: null,
    current: null,                // 当前会话(pub thread,含 members)
    msgs: new Map(),              // tid -> {list:[], lastId:int}
    aiPending: new Map(),         // tid -> true(等待 AI 回复)
    pollTimer: null, badgeTimer: null, pollBusy: false,
    aiUsed: 0, aiLimit: 0,
    newBelow: new Map(),          // tid -> 离开底部期间累积的新消息数(回底浮钮)
    upload: null,                 // {state:'uploading'|'done', id,name,size,mime,image, progress}
    els: {}, tmpSeq: 0,
  };

  // ============ 小工具 ============
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // 附件地址来自服务端响应。esc 挡得住属性逃逸,挡不住 javascript: 协议,
  // 这里只放行 http(s) 与站内相对地址,其余降级为不可点。
  function safeUrl(v) {
    const s = String(v == null ? '' : v).trim();
    return /^(https?:\/\/|\/)/i.test(s) ? s : '';
  }
  function icon(name, size) {
    return (window.OC && window.OC.icon) ? window.OC.icon(name, size || 15) : '';
  }
  function toast(msg, isErr) {
    if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isErr ? 'error' : undefined);
    if (typeof window.toast === 'function') return window.toast(msg, isErr);
  }
  function myId() { const u = window.OCApp && window.OCApp.state && window.OCApp.state.user; return u ? String(u.id) : ''; }
  function myName() { const u = window.OCApp && window.OCApp.state && window.OCApp.state.user; return (u && u.name) || '我'; }
  function imEnabled() {
    try {
      const cfg = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
      if (cfg && typeof cfg.imEnabled === 'boolean' && !cfg.imEnabled) return false;
    } catch (e) {}
    // 总开关之外还有「仅管理员 / 仅名单」这层按人判定(/api/me 下发)
    if (window.OCFeatures && !window.OCFeatures.allowed('im')) return false;
    return true;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const yest = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yest.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function fmtFullTime(ts) { const d = new Date(Number(ts) || Date.now()); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  // Telegram 式头像:按名字哈希取一组渐变色兜底,再叠一张 static/role 里的
  // 角色头像(1~20.png,按用户 id 稳定哈希取一张 —— 同一个人在任何设备都是同一张);
  // 群头像 = 群主的头像。图片缺失时由 CSS 自动落回渐变 + 首字。
  const ROLE_AVATAR_COUNT = 20;
  const AV_GRADS = [
    ['#ff885e', '#ff516a'],   // 红
    ['#ffcd6a', '#ffa85c'],   // 橙
    ['#82b1ff', '#665fff'],   // 蓝紫
    ['#a0de7e', '#54cb68'],   // 绿
    ['#53edd6', '#28c9b7'],   // 青
    ['#64b5ef', '#3287d8'],   // 蓝
  ];
  function nameHash(s) {
    let h = 0;
    s = String(s || '?');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function avPair(name) { return AV_GRADS[nameHash(name) % AV_GRADS.length]; }
  function avInitial(name) {
    const s = String(name || '?').trim();
    return s ? Array.from(s)[0].toUpperCase() : '?';
  }
  function avatarHtml(name, size, extra, key) {
    const pair = avPair(name);
    const k = key != null && key !== '' ? String(key) : String(name || '?');
    // 角色头像用绝对地址直接写进 inline background-image:
    // 相对路径放进自定义属性会被按「使用它的样式表」的基址解析(//static/css/...),踩过坑
    const url = roleBase() + (1 + nameHash(k) % ROLE_AVATAR_COUNT) + '.png';
    const bg = 'background-image:url(\'' + url + '\'), linear-gradient(135deg, ' + pair[0] + ', ' + pair[1] + ');';
    return '<span class="im-avatar im-has-role' + (extra ? ' ' + extra : '') + '" style="' + bg + 'width:' + (size || 40) + 'px;height:' + (size || 40) + 'px;font-size:' + Math.round((size || 40) * 0.42) + 'px">' + esc(avInitial(name)) + '</span>';
  }
  // static/role 的绝对基址:从本模块 CSS 的 <link> 反推(兼容子目录/file:// 部署)
  let ROLE_BASE = null;
  function roleBase() {
    if (ROLE_BASE !== null) return ROLE_BASE;
    const link = document.querySelector('link[href*="im.min.css"], link[href*="im.css"]');
    if (link && link.href) {
      ROLE_BASE = link.href.replace(/static\/css\/im(\.min)?\.css.*$/, 'static/role/');
    } else {
      ROLE_BASE = location.pathname.replace(/[^/]*$/, '') + 'static/role/';
    }
    return ROLE_BASE;
  }
  // 从成员列表里挑出「代表头像」的人:群 = 群主,单聊 = 对方,兜底取第一位
  function threadAvatarPerson(t) {
    const members = (t && t.members) || [];
    if (!isGroup(t)) {
      const me = myId();
      return members.find((m) => m.id !== me) || members[0] || null;
    }
    return members.find((m) => String(m.id) === String(t.ownerId || '')) || members[0] || null;
  }
  function threadAvatarHtml(t, size) {
    const p = threadAvatarPerson(t);
    return avatarHtml(p ? p.name : threadName(t), size, isGroup(t) ? 'group' : '', p ? p.id : (t ? t.ownerId : ''));
  }
  function threadName(t) {
    if (!t) return '';
    if (t.type === 'group') return t.title || '群聊';
    const me = myId();
    const other = (t.members || []).find((m) => m.id !== me);
    return (other && other.name) || '已注销用户';
  }
  function threadMembersOf(t) { return (t && t.members) || []; }
  function isGroup(t) { return t && t.type === 'group'; }
  function amOwner(t) { return t && String(t.ownerId) === myId(); }
  function api(path, opts) { return window.OCApp.api(path, opts); }
  async function apiJson(path, opts) {
    const r = await api(path, opts);
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    if (!r.ok) throw new Error((data.error && data.error.message) || ('请求失败（HTTP ' + r.status + '）'));
    return data;
  }
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) {}
    return undefined;
  }

  // ============ 全屏骨架(Telegram 风格:左列表 + 右聊天) ============
  function buildShell() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask im-fs-mask hidden';
    mask.innerHTML =
      '<div class="im-fs" role="dialog" aria-modal="true" aria-label="在线聊天">'
      + '<header class="im-head">'
      + '<div class="im-head-left">'
      + '<button class="im-brand" id="im-brand" data-tip="返回对话首页" aria-label="返回对话首页">'
      + '<img src="./logo.svg" class="brand-logo-light" alt="TinyChat">'
      + '<img src="./logo-dark.svg" class="brand-logo-dark" alt="TinyChat">'
      + '</button>'
      + '<span class="im-head-sep" aria-hidden="true"></span>'
      + '<button class="im-back-btn" id="im-back" data-tip="返回对话（Esc）">' + icon('chevronLeft', 14) + '<span>返回</span></button>'
      + '</div>'
      // 顶栏右侧:四个页签(聊天/好友/验证消息/发起群聊),手机端转为底部 dock
      + '<nav class="im-tabs" id="im-tabs" role="tablist" aria-label="聊天页签">' + imTabButtons('im-tab') + '</nav>'
      + '<span class="im-sync" id="im-sync-dot"></span>'
      + '</header>'
      + '<div class="im-body">'
      // 左栏:列表(页签已上移到顶栏)
      + '<aside class="im-side" id="im-side">'
      + '<div class="im-side-scroll" id="im-side-scroll"></div>'
      + '</aside>'
      // 右栏:聊天窗
      + '<section class="im-pane" id="im-pane"></section>'
      + '</div>'
      // 手机端底部 dock(四个入口全部带图标)
      + '<nav class="im-dock" id="im-dock" role="tablist" aria-label="聊天导航">' + imTabButtons('im-dock-item') + '</nav>'
      + '</div>';
    document.body.appendChild(mask);
    S.els.mask = mask;
    S.els.sideScroll = mask.querySelector('#im-side-scroll');
    S.els.pane = mask.querySelector('#im-pane');
    S.els.syncDot = mask.querySelector('#im-sync-dot');

    mask.querySelector('#im-back').addEventListener('click', close);
    // Logo 与返回按钮一致:点击回到对话首页(notes 同款惯例)
    mask.querySelector('#im-brand').addEventListener('click', close);
    // 页签(顶栏 + 底部 dock)统一委托
    mask.querySelectorAll('.im-tab, .im-dock-item').forEach((b) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
    });
    // Esc 关闭(弹窗栈接管之外:抽屉态的二级返回交给 CSS/内部状态)
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.current && document.body.classList.contains('im-chat-open')) {
        e.stopPropagation();
        closeThread();
      }
    });
  }

  // ============ 页签(顶栏 + 手机 dock 共用) ============
  // 四个入口:聊天 / 好友 / 验证消息 / 发起群聊 —— 全部带图标,验证消息带待处理角标
  const IM_TABS = [
    { tab: 'chats', ic: 'chat', label: '聊天' },
    { tab: 'friends', ic: 'user', label: '好友' },
    { tab: 'requests', ic: 'check', label: '验证消息', badge: true },
    { tab: 'newgroup', ic: 'group', label: '发起群聊' },
  ];
  function imTabButtons(cls) {
    return IM_TABS.map((t) =>
      '<button class="' + cls + (S.tab === t.tab ? ' active' : '') + '" data-tab="' + t.tab + '" role="tab" aria-selected="' + (S.tab === t.tab) + '">'
      + icon(t.ic, cls === 'im-dock-item' ? 20 : 15)
      + '<span>' + t.label + '</span>'
      + (t.badge ? '<span class="im-tab-badge hidden" data-role="req-badge"></span>' : '')
      + '</button>').join('');
  }
  function setTab(tab) {
    S.tab = tab;
    S.searchResults = null;
    S.els.mask.querySelectorAll('.im-tab, .im-dock-item').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderSide();
  }

  // 独立地址 /im:与 /ainotes 同一机制 —— 打开时推入,关闭回根路径,
  // 刷新/直达由 initEntry 的 boot 检测自动打开,前进后退由 popstate 保持同步
  function isImPath() {
    try { return location.pathname.replace(/\/+$/, '') === '/im'; } catch (e) { return false; }
  }

  function open() {
    if (!window.OCApp || !window.OCApp.state || !window.OCApp.state.user) {
      toast('请先登录后再使用在线聊天', true);
      return;
    }
    if (!S.ready) { buildShell(); S.ready = true; }
    if (S.open) return;
    S.open = true;
    const mask = S.els.mask;
    mask.classList.remove('hidden');
    mask.classList.add('show');
    // 独立地址:刷新后仍停留在聊天页
    if (window.history && !isImPath()) {
      try { history.pushState({ im: true }, '', '/im'); } catch (e) {}
    }
    if (window.OCUI) window.OCUI.openModal(mask);
    // closeModal 的 320ms 落幕定时器不认「已经重开」:若关闭后 320ms 内重开,
    // 它会把 hidden 再挂回来(全站弹层既有竞态,IM 开关频繁最容易踩中),这里兜底摘掉
    setTimeout(() => { if (S.open) mask.classList.remove('hidden'); }, 340);
    startPoll(4000);
    renderChat();   // 先画出空态,refreshAll 恢复上次会话后会被聊天窗替换
    refreshAll();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    S.els.mask.classList.remove('show');
    const m = S.els.mask;
    setTimeout(() => { if (!S.open) m.classList.add('hidden'); }, 240);
    if (window.OCUI) window.OCUI.closeModal(m);
    // 返回对话首页:地址同步回根路径(仅在确实处于 /im 时)
    if (isImPath() && window.history) {
      try { history.pushState(null, '', '/'); } catch (e) {}
    }
    stopPoll();
    startBadge(25000);
  }

  // ============ 数据刷新 ============
  async function refreshAll() {
    try {
      const [threadsData, friendsData, upd] = await Promise.all([
        apiJson('/api/im/threads'),
        apiJson('/api/friends'),
        apiJson('/api/im/updates').catch(() => null),
      ]);
      S.threads = mergeThreads(threadsData.threads || []);
      S.friends = friendsData.friends || [];
      S.requests = friendsData.requests || [];
      S.sent = friendsData.sent || [];
      if (upd) applyUpdates(upd);
      renderSide();
      renderEntryBadge();
      updateReqBadge();
      // 恢复上次会话
      if (!S.current) {
        const last = store('oc_im_last');
        const t = last && S.threads.find((x) => x.id === last);
        if (t) openThread(t.id, { silent: true });
      } else if (S.current) {
        const fresh = S.threads.find((x) => x.id === S.current.id);
        if (fresh) { S.current = Object.assign({}, fresh, { members: (S.current.members || fresh.members) }); renderChat(); }
      }
    } catch (e) { toast(e.message || '刷新失败', true); }
  }

  // updates 的线程缺 members,与全量数据合并
  function mergeThreads(list) {
    const prev = new Map(S.threads.map((t) => [t.id, t]));
    return list.map((t) => {
      const old = prev.get(t.id);
      if (old && !t.members) t.members = old.members;
      if (old && old.members) t.members = old.members;
      return t;
    });
  }

  function applyUpdates(upd) {
    S.aiUsed = upd.aiUsed || 0;
    S.aiLimit = upd.aiLimit || 0;
    if (Array.isArray(upd.threads)) {
      const known = new Map(S.threads.map((t) => [t.id, t]));
      S.threads = mergeThreads(upd.threads.map((t) => Object.assign({}, known.get(t.id) || {}, t)));
    }
    if (Array.isArray(upd.requests)) S.requests = upd.requests;
    renderEntryBadge();
    updateReqBadge();
  }

  async function pollUpdates() {
    if (S.pollBusy) return;
    S.pollBusy = true;
    try {
      const upd = await apiJson('/api/im/updates');
      applyUpdates(upd);
      if (S.open && S.current) {
        const tid = S.current.id;
        const fresh = S.threads.find((x) => x.id === tid);
        if (fresh) {
          S.current = Object.assign({}, fresh, { members: S.current.members || fresh.members });
          renderChatHeader();
          // 对侧删除了消息(修订号推进):整窗重拉,删除占位同步出现
          const m = msgsOf(tid);
          if (typeof fresh.msgRev === 'number' && m.rev != null && fresh.msgRev !== m.rev) {
            await fetchNewMessages(tid, { full: true });
          }
        }
        if (S.current && S.current.id === tid) await fetchNewMessages(S.current.id);
      }
      renderThreadList();
    } catch (e) { /* 静默:轮询失败不打扰 */ }
    finally { S.pollBusy = false; }
  }

  // ============ 会话消息 ============
  function msgsOf(tid) {
    if (!S.msgs.has(tid)) S.msgs.set(tid, { list: [], lastId: 0, loaded: false });
    return S.msgs.get(tid);
  }

  async function fetchNewMessages(tid, opts) {
    const full = !!(opts && opts.full);   // 整窗重拉(感知对侧删除时用)
    const m = msgsOf(tid);
    const r = await apiJson('/api/im/messages?thread=' + encodeURIComponent(tid) + '&after=' + (full ? 0 : (m.lastId || 0)) + '&limit=' + (full ? 500 : 200));
    if (S.current && S.current.id === tid && r.thread) {
      S.current = Object.assign({}, S.current, r.thread, { members: S.current.members || (r.thread.members || []) });
      renderChatHeader();
    }
    if (typeof r.thread.msgRev === 'number') m.rev = r.thread.msgRev;
    if (full) {
      m.list = (r.messages || []).slice();
    } else if (r.messages && r.messages.length) {
      for (const msg of r.messages) appendMessage(tid, msg);
    }
    if (r.messages && r.messages.length) {
      const t = S.threads.find((x) => x.id === tid);
      if (t) { t.unread = 0; renderThreadList(); renderEntryBadge(); }
      renderMessages(tid, full ? 0 : r.messages.length);
      if (r.messages.some((x) => x.kind === 'ai')) S.aiPending.delete(tid);
    } else if (full) {
      renderMessages(tid, 0);
    }
    m.loaded = true;
  }

  function appendMessage(tid, msg) {
    const m = msgsOf(tid);
    if (typeof msg.id === 'number' && msg.id > (m.lastId || 0)) m.lastId = msg.id;
    // 按 id 去重(发送响应与轮询可能重复)
    const exist = m.list.find((x) => x._tmp || x.id === msg.id);
    if (exist && !exist._tmp) return;
    if (exist && exist._tmp && typeof msg.id === 'number') {
      Object.assign(exist, msg, { _tmp: false });
      return;
    }
    m.list.push(msg);
  }

  async function openThread(tid, opts) {
    try {
      const r = await apiJson('/api/im/messages?thread=' + encodeURIComponent(tid) + '&limit=200');
      S.current = r.thread;
      store('oc_im_last', tid);
      const m = msgsOf(tid);
      m.list = (r.messages || []).slice();
      m.lastId = (r.thread && r.thread.lastMsgId) || (m.list.length ? m.list[m.list.length - 1].id : 0);
      m.rev = (r.thread && r.thread.msgRev) || 0;
      m.loaded = true;
      S.newBelow.delete(tid);
      const t = S.threads.find((x) => x.id === tid);
      if (t) t.unread = 0;
      document.body.classList.add('im-chat-open');
      renderSide();
      renderChat();
      renderThreadList();
      renderEntryBadge();   // 已读当下就把入口上的未读数清掉,别等下一次轮询(最长 25s)
      if (!opts || !opts.silent) S.els.pane.querySelector('#im-input') && S.els.pane.querySelector('#im-input').focus();
    } catch (e) { toast(e.message || '打开会话失败', true); }
  }

  function closeThread() {
    S.current = null;
    document.body.classList.remove('im-chat-open');
    store('oc_im_last', '');
    renderChat();
    renderThreadList();
  }

  // ============ 发送 ============
  // 文本里出现「@AI」提及词即视为召唤(与后端 tc_im_ai_trigger 同规则)
  const AI_HINT_RE = /(?:^|\s)[@＠][AaＡａ][IiＩｉ](?![A-Za-z0-9])/;
  // 输入 @ 后可选的提及项(目前只有 AI;后续可扩展成成员提及)
  const MENTION_ITEMS = [
    { key: 'ai', label: 'AI 回答', desc: '让 AI 回答这条消息', ic: 'bot' },
  ];
  // renderComposer 注入的「收起提及弹层」回调:发送后清空输入框时一并收起
  let dismissMention = null;
  // 好友请求附加验证消息上限(需与后端 TC_IM_REQ_MSG_MAX 一致)
  const TC_REQ_MSG_MAX = 60;

  async function sendCurrent() {
    if (!S.current) return;
    const ta = S.els.pane.querySelector('#im-input');
    if (!ta) return;
    const text = ta.value.replace(/\s+$/, '');
    const tid = S.current.id;
    if (!text.trim() && !(S.upload && S.upload.state === 'done')) {
      if (S.upload && S.upload.state === 'uploading') toast('附件还在上传中，请稍候', true);
      return;
    }
    ta.value = '';
    autoGrow(ta);
    if (dismissMention) dismissMention();
    renderComposerState();

    // 本地回显(临时消息,服务端确认后替换)
    const tmp = {
      id: 'tmp-' + (++S.tmpSeq), _tmp: true, from: myId(), name: myName(),
      text: text, at: Date.now(), kind: 'user', self: true, pending: true,
    };
    if (S.upload && S.upload.state === 'done') tmp.file = { id: S.upload.id, name: S.upload.name, size: S.upload.size, mime: S.upload.mime, image: S.upload.image, url: S.upload.url };
    const m = msgsOf(tid);
    m.list.push(tmp);
    renderMessages(tid);
    S.upload = null;
    renderComposerState();

    try {
      const body = { thread: tid, text: text };
      if (tmp.file) body.file = { id: tmp.file.id, name: tmp.file.name, mime: tmp.file.mime, size: tmp.file.size, image: tmp.file.image };
      const r = await apiJson('/api/im/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // 替换临时消息(按位置;若轮询已带回同 id 消息则去重)
      if (r.message) appendMessage(tid, r.message);
      if (r.thread) {
        const idx = S.threads.findIndex((x) => x.id === tid);
        if (idx >= 0) S.threads[idx] = Object.assign({}, S.threads[idx], r.thread, { members: S.threads[idx].members });
        else S.threads.push(Object.assign({}, r.thread));
        if (S.current && S.current.id === tid) S.current = Object.assign({}, S.current, r.thread, { members: S.current.members || r.thread.members });
      }
      m.lastId = Math.max(m.lastId || 0, (r.message && r.message.id) || 0);
      const lst = msgsOf(tid).list;
      const i = lst.indexOf(tmp);
      if (i >= 0 && r.message) { lst.splice(i, 1); if (!lst.some((x) => x.id === r.message.id)) lst.push(r.message); }
      else if (i >= 0) lst.splice(i, 1);
      renderMessages(tid);
      renderThreadList();
      if (r.ai && r.ai.pending) {
        S.aiPending.set(tid, true);
        renderMessages(tid);
      } else if (r.ai && r.ai.error) {
        toast(r.ai.error, true);
      }
      setTimeout(() => { fetchNewMessages(tid); }, 800);
    } catch (e) {
      const lst = msgsOf(tid).list;
      const i = lst.indexOf(tmp);
      if (i >= 0) { tmp.failed = true; tmp.pending = false; }
      renderMessages(tid);
      toast(e.message || '发送失败', true);
    }
  }

  // ============ 附件 ============
  function pickFiles() {
    if (!S.current) return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    try {
      const cfg = JSON.parse(localStorage.getItem('oc_cfg') || '{}');
      if (cfg && cfg.imAllowFiles === false) inp.accept = 'image/*';
    } catch (e) {}
    inp.addEventListener('change', () => { if (inp.files && inp.files.length) uploadFile(inp.files[0]); });
    inp.click();
  }

  async function uploadFile(file) {
    if (!S.current) return;
    if (S.upload && S.upload.state === 'uploading') { toast('请等待当前附件上传完成', true); return; }
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('threadId', S.current.id);
    S.upload = { state: 'uploading', name: file.name, size: file.size, image: /^image\//.test(file.type || ''), progress: 0 };
    renderComposerState();
    try {
      // XMLHttpRequest 才有上传进度;fetch 在这里拿不到
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', (window.OCApp.apiUrl ? window.OCApp.apiUrl('/api/im/upload') : '/api/im/upload'));
        xhr.setRequestHeader('Authorization', 'Bearer ' + ((window.OCApp.state && window.OCApp.state.token) || ''));
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && S.upload) {
            S.upload.progress = Math.round((e.loaded / e.total) * 100);
            renderComposerState();
          }
        });
        xhr.addEventListener('load', () => {
          let d = {};
          try { d = JSON.parse(xhr.responseText || '{}'); } catch (err) {}
          if (xhr.status >= 200 && xhr.status < 300) resolve(d);
          else reject(new Error((d.error && d.error.message) || ('上传失败（HTTP ' + xhr.status + '）')));
        });
        xhr.addEventListener('error', () => reject(new Error('上传失败，请检查网络')));
        xhr.send(fd);
      });
      S.upload = {
        state: 'done', id: data.id, name: data.name, size: data.size,
        mime: data.mimeType, image: !!data.image, url: data.url,
      };
      renderComposerState();
    } catch (e) {
      S.upload = null;
      renderComposerState();
      toast(e.message || '上传失败', true);
    }
  }

  // ============ 好友操作 ============
  async function searchUsers(q) {
    // 只更新 #im-search-results 容器:整面板重渲染会把正在输入的搜索框一起清掉
    if (!q) { S.searchResults = null; renderSearchResults(); return; }
    try {
      const r = await apiJson('/api/im/users/search?q=' + encodeURIComponent(q));
      S.searchResults = r.users || [];
      renderSearchResults();
    } catch (e) { toast(e.message || '搜索失败', true); }
  }

  async function friendRequest(name, message) {
    try {
      const body = { name };
      if (message) body.message = message;
      const r = await apiJson('/api/friends/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 'matched') toast('对方正好也向你发起了请求，你们已成为好友');
      else toast('好友请求已发送');
      await refreshFriends();
      renderSide();
    } catch (e) { toast(e.message || '发送失败', true); }
  }

  async function friendRespond(reqId, accept) {
    try {
      await apiJson('/api/friends/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, accept: !!accept }),
      });
      toast(accept ? '已同意好友请求' : '已拒绝好友请求');
      await refreshFriends();
      renderSide();
    } catch (e) { toast(e.message || '操作失败', true); }
  }

  async function friendRemove(uid) {
    const f = S.friends.find((x) => x.id === uid);
    const ok = await (window.OCUI && window.OCUI.confirm ? window.OCUI.confirm({
      title: '删除好友「' + ((f && f.name) || '') + '」？',
      message: '删除后双方不再是好友；历史聊天记录会保留。',
      danger: true, confirmText: '删除',
    }) : Promise.resolve(window.confirm('删除该好友？')));
    if (!ok) return;
    try {
      await api('/api/friends/' + encodeURIComponent(uid), { method: 'DELETE' });
      toast('已删除好友');
      await refreshFriends();
      renderSide();
    } catch (e) { toast(e.message || '操作失败', true); }
  }

  async function refreshFriends() {
    const r = await apiJson('/api/friends');
    S.friends = r.friends || [];
    S.requests = r.requests || [];
    S.sent = r.sent || [];
    updateReqBadge();
    renderEntryBadge();
  }

  // ============ 会话操作 ============
  async function startDm(uid) {
    try {
      const r = await apiJson('/api/im/threads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dm', uid }),
      });
      if (r.thread) {
        const idx = S.threads.findIndex((x) => x.id === r.thread.id);
        if (idx >= 0) S.threads[idx] = Object.assign({}, S.threads[idx], r.thread);
        else S.threads.unshift(r.thread);
        setTab('chats');
        openThread(r.thread.id);
      }
    } catch (e) { toast(e.message || '操作失败', true); }
  }

  async function createGroup(title, memberIds) {
    try {
      const r = await apiJson('/api/im/threads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'group', title, members: memberIds }),
      });
      toast('群聊已创建');
      if (r.thread) {
        S.threads.unshift(r.thread);
        setTab('chats');
        openThread(r.thread.id);
      }
    } catch (e) { toast(e.message || '创建失败', true); }
  }

  async function addMembers(tid, uids) {
    try {
      await apiJson('/api/im/threads/' + encodeURIComponent(tid) + '/members', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uids }),
      });
      toast('已添加成员');
      await refreshAll();
    } catch (e) { toast(e.message || '操作失败', true); }
  }

  async function toggleAi(tid, enabled) {
    try {
      const r = await apiJson('/api/im/threads/' + encodeURIComponent(tid) + '/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!enabled }),
      });
      if (S.current && S.current.id === tid) S.current.aiEnabled = !!r.aiEnabled;
      const t = S.threads.find((x) => x.id === tid);
      if (t) t.aiEnabled = !!r.aiEnabled;
      toast(enabled ? 'AI 模式已开启：每条消息 AI 都会回复' : 'AI 模式已关闭');
      renderChatHeader();
    } catch (e) { toast(e.message || '操作失败', true); }
  }

  async function deleteCurrentThread() {
    if (!S.current) return;
    const t = S.current;
    const isGrp = isGroup(t);
    const owner = amOwner(t);
    const title = isGrp ? (owner ? '解散群聊「' + threadName(t) + '」？' : '退出群聊「' + threadName(t) + '」？') : '删除与「' + threadName(t) + '」的会话？';
    const msg = isGrp
      ? (owner ? '解散后所有成员的聊天记录都会被移除，内容将进入管理端留档。' : '退出后你将不再收到该群消息；其余成员的记录保留。')
      : '删除后双方的聊天记录都会被移除（好友关系保留），内容进入管理端留档。';
    const ok = await (window.OCUI && window.OCUI.confirm ? window.OCUI.confirm({ title, message: msg, danger: true, confirmText: isGrp && !owner ? '退出' : '删除' }) : Promise.resolve(window.confirm(title)));
    if (!ok) return;
    try {
      await api('/api/im/threads/' + encodeURIComponent(t.id), { method: 'DELETE' });
      S.threads = S.threads.filter((x) => x.id !== t.id);
      S.msgs.delete(t.id);
      closeThread();
      renderThreadList();
      renderEntryBadge();
      toast(isGrp && !owner ? '已退出群聊' : '已删除');
    } catch (e) { toast(e.message || '操作失败', true); }
  }

  async function deleteMessages(ids) {
    if (!S.current || !ids || !ids.length) return;
    const tid = S.current.id;
    try {
      await apiJson('/api/im/messages/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread: tid, ids }),
      });
      const m = msgsOf(tid);
      for (const msg of m.list) {
        if (ids.indexOf(msg.id) >= 0) { msg.deleted = true; delete msg.text; delete msg.file; }
      }
      renderMessages(tid);
      toast('已删除（双方可见删除状态）');
    } catch (e) { toast(e.message || '删除失败', true); }
  }

  // ============ 渲染:左栏 ============
  function renderSide() {
    if (!S.ready) return;
    const el = S.els.sideScroll;
    if (S.tab === 'chats') renderThreadList();
    else if (S.tab === 'friends') renderFriendsPanel();
    else if (S.tab === 'requests') renderRequestsPanel();
    else if (S.tab === 'newgroup') renderNewGroupPanel();
  }

  function renderThreadList() {
    if (!S.ready || S.tab !== 'chats') return;
    const el = S.els.sideScroll;
    if (!S.threads.length) {
      el.innerHTML =
        '<div class="im-empty">' + icon('bubbles', 26)
        + '<p>还没有聊天</p><p class="im-empty-sub">到「好友」页添加朋友,或发起群聊</p>'
        + '<button class="im-btn primary" data-act="goto-friends">添加好友</button></div>';
      const b = el.querySelector('[data-act="goto-friends"]');
      if (b) b.addEventListener('click', () => setTab('friends'));
      return;
    }
    const me = myId();
    el.innerHTML = S.threads.map((t) => {
      const name = threadName(t);
      const other = t.type === 'dm' ? (t.members || []).find((x) => x.id !== me) : null;
      const online = other && other.lastSeen > 0 && (Date.now() - other.lastSeen) < 70000;
      const preview = t.lastMsgText || (t.lastMsgId ? '' : '开始聊天吧');
      const badge = t.unread ? '<span class="im-unread">' + (t.unread > 99 ? '99+' : t.unread) + '</span>' : '';
      const aiMark = t.aiEnabled ? '<span class="im-ai-mark" data-tip="AI 模式开启中">' + icon('bot', 12) + '</span>' : '';
      return '<div class="im-item' + (S.current && S.current.id === t.id ? ' active' : '') + '" data-tid="' + esc(t.id) + '">'
        + threadAvatarHtml(t, 46)
        + '<div class="im-item-main"><div class="im-item-top"><span class="im-item-name">' + esc(name) + aiMark + '</span>'
        + '<span class="im-item-time">' + esc(t.lastMsgAt ? fmtTime(t.lastMsgAt) : '') + '</span></div>'
        + '<div class="im-item-bottom"><span class="im-item-preview">' + esc(preview) + '</span>' + badge + '</div></div>'
        + (online ? '<span class="im-online-dot" data-tip="在线"></span>' : '')
        + '</div>';
    }).join('');
    el.querySelectorAll('.im-item').forEach((row) => {
      row.addEventListener('click', () => openThread(row.dataset.tid));
    });
  }

  function updateReqBadge() {
    if (!S.ready) return;
    const n = S.requests.length;
    // 页签与底部 dock 上的所有待处理角标一起更新
    S.els.mask.querySelectorAll('[data-role="req-badge"]').forEach((b) => {
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.toggle('hidden', !n);
    });
  }

  function renderFriendsPanel() {
    if (!S.ready) return;
    const el = S.els.sideScroll;
    // 重建前记住搜索框的内容与焦点:面板因任何原因重渲染都不打断输入
    const prevInput = document.getElementById('im-user-search');
    const prevVal = prevInput ? prevInput.value : '';
    const prevFocus = !!(prevInput && document.activeElement === prevInput);
    const parts = [];
    // 搜索添加
    parts.push('<div class="im-search"><span class="im-search-icon">' + icon('search', 14) + '</span>'
      + '<input id="im-user-search" type="search" placeholder="输入用户名,添加好友" autocomplete="off" spellcheck="false">'
      + '</div><div id="im-search-results"></div>');
    // 全部好友(发起群聊已升级为独立页签)
    parts.push('<div class="im-side-title">全部好友（' + S.friends.length + '）</div>');
    if (!S.friends.length) {
      parts.push('<div class="im-empty small"><p>还没有好友</p><p class="im-empty-sub">在上方输入用户名搜索并添加</p></div>');
    } else {
      parts.push(S.friends.map((f) =>
        '<div class="im-friend-row">'
        + avatarHtml(f.name, 38, '', f.id) + (f.online ? '<span class="im-online-dot" data-tip="在线"></span>' : '')
        + '<div class="im-friend-main"><span class="im-friend-name' + (f.isAdmin ? ' is-admin' : '') + '">' + esc(f.name) + adminTag(f.isAdmin) + '</span>'
        + '<span class="im-friend-sub">' + (f.online ? '在线' : (f.lastSeen ? '最近 ' + fmtTime(f.lastSeen) : '')) + (f.guest ? ' · 游客' : '') + '</span></div>'
        + '<button class="im-btn small" data-chat="' + esc(f.id) + '">' + icon('chat', 13) + ' 聊天</button>'
        + '<button class="im-btn small danger-ghost" data-remove="' + esc(f.id) + '" data-tip="删除好友">' + icon('trash', 13) + '</button>'
        + '</div>').join(''));
    }
    el.innerHTML = parts.join('');

    const search = el.querySelector('#im-user-search');
    if (search) {
      if (prevVal) search.value = prevVal;
      if (prevFocus) {
        search.focus();
        try { search.setSelectionRange(search.value.length, search.value.length); } catch (e) {}
      }
      search.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchUsers(search.value.trim()); });
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        const v = search.value.trim();
        timer = setTimeout(() => searchUsers(v), 350);
      });
    }
    el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => friendRespond(b.dataset.accept, true)));
    el.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', () => friendRespond(b.dataset.decline, false)));
    el.querySelectorAll('[data-chat]').forEach((b) => b.addEventListener('click', () => startDm(b.dataset.chat)));
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => friendRemove(b.dataset.remove)));
    renderSearchResults();
  }

  // 验证消息页:收到的好友请求(同意/拒绝)与我发出的请求(等待同意)
  function renderRequestsPanel() {
    if (!S.ready) return;
    const el = S.els.sideScroll;
    const parts = [];
    if (S.requests.length) {
      parts.push('<div class="im-side-title">收到的验证（' + S.requests.length + '）</div>');
      parts.push(S.requests.map((r) =>
        '<div class="im-friend-row">'
        + avatarHtml(r.name, 40, '', r.id)
        + '<div class="im-friend-main"><span class="im-friend-name">' + esc(r.name) + '</span>'
        + '<span class="im-friend-sub">请求添加你为好友 · ' + (r.at ? fmtTime(r.at) : '') + '</span>'
        + (r.msg ? '<span class="im-req-msg">' + esc(r.msg) + '</span>' : '') + '</div>'
        + '<button class="im-btn small primary" data-accept="' + esc(r.reqId) + '">' + icon('check', 13) + ' 同意</button>'
        + '<button class="im-btn small" data-decline="' + esc(r.reqId) + '">' + icon('close', 13) + '</button>'
        + '</div>').join(''));
    }
    if (S.sent.length) {
      parts.push('<div class="im-side-title">我发出的（等待对方同意）</div>');
      parts.push(S.sent.map((r) =>
        '<div class="im-friend-row">'
        + avatarHtml(r.name, 40, '', r.id)
        + '<div class="im-friend-main"><span class="im-friend-name">' + esc(r.name) + '</span>'
        + '<span class="im-friend-sub">已发送请求 · ' + (r.at ? fmtTime(r.at) : '') + '</span>'
        + (r.msg ? '<span class="im-req-msg">' + esc(r.msg) + '</span>' : '') + '</div>'
        + '<span class="im-req-pending">等待同意</span>'
        + '</div>').join(''));
    }
    if (!S.requests.length && !S.sent.length) {
      parts.push('<div class="im-empty">' + icon('check', 26)
        + '<p>暂无验证消息</p><p class="im-empty-sub">收到和我发出的好友请求都会显示在这里</p></div>');
    }
    el.innerHTML = parts.join('');
    el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => friendRespond(b.dataset.accept, true)));
    el.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', () => friendRespond(b.dataset.decline, false)));
  }

  function renderSearchResults() {
    const box = document.getElementById('im-search-results');
    if (!box) return;
    if (!S.searchResults) { box.innerHTML = ''; return; }
    if (!S.searchResults.length) {
      box.innerHTML = '<div class="im-search-empty">没有找到该用户</div>';
      return;
    }
    const REL = { yes: ['已是好友', ''], in: ['同意', 'primary'], out: ['等待同意', ''], none: ['添加好友', 'primary'] };
    box.innerHTML = '<div class="im-side-title">搜索结果</div>' + S.searchResults.map((u) => {
      const [label, cls] = REL[u.rel] || REL.none;
      let act;
      if (u.rel === 'yes') {
        act = '<button class="im-btn small" data-chat="' + esc(u.id) + '">' + icon('chat', 13) + ' 聊天</button>';
      } else if (u.rel === 'in') {
        // 对方已经请求过我 → 直接同意,不必再发一次请求
        act = '<button class="im-btn small primary" data-accept-uid="' + esc(u.id) + '">' + icon('check', 13) + ' 同意</button>';
      } else if (u.rel === 'out') {
        act = '<button class="im-btn small" data-tip="已发送请求，等待对方同意" disabled>等待同意</button>';
      } else {
        act = '<button class="im-btn small ' + cls + '" data-add="' + esc(u.name) + '">' + esc(label) + '</button>';
      }
      return '<div class="im-friend-row">' + avatarHtml(u.name, 38, '', u.id)
        + '<div class="im-friend-main"><span class="im-friend-name' + (u.admin ? ' is-admin' : '') + '">' + esc(u.name)
        + adminTag(u.admin) + '</span>'
        + '<span class="im-friend-sub">' + (u.guest ? '游客账号' : '用户') + '</span></div>' + act + '</div>';
    }).join('');
    box.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => askFriendRequest(b.dataset.add)));
    box.querySelectorAll('[data-accept-uid]').forEach((b) => b.addEventListener('click', () => acceptFromSearch(b.dataset.acceptUid)));
    box.querySelectorAll('[data-chat]').forEach((b) => b.addEventListener('click', () => startDm(b.dataset.chat)));
  }

  // 管理员徽标:统一走这里,避免各处图标/对齐不一致(皇冠 + 金色,与名字同一水平线)
  function adminTag(isAdmin) {
    return isAdmin ? ' <em class="im-admin-tag"><span class="im-admin-ic">' + icon('crown', 14) + '</span>管理员</em>' : '';
  }

  // 搜索结果里「同意」:从已加载的请求里找到 reqId 后接受
  async function acceptFromSearch(uid) {
    let r = S.requests.find((x) => x.id === uid);
    if (!r) { await refreshFriends(); r = S.requests.find((x) => x.id === uid); }
    if (!r) { toast('请求已失效，请刷新后重试', true); await refreshFriends(); renderSide(); return; }
    await friendRespond(r.reqId, true);
  }

  // 添加好友前先让用户决定是否附一条验证消息
  function askFriendRequest(name) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask im-dlg-mask show';
    mask.innerHTML =
      '<div class="im-dlg" role="dialog" aria-modal="true"><h3>添加好友</h3>'
      + '<div class="im-addf">'
      + avatarHtml(name, 44, '', '') + '<div class="im-addf-main"><span class="im-addf-name">' + esc(name) + '</span>'
      + '<span class="im-addf-sub">向对方发送好友请求</span></div></div>'
      + '<label class="im-set-field"><span>验证消息（可选，' + TC_REQ_MSG_MAX + ' 字内）</span>'
      + '<textarea id="im-req-msg" rows="2" maxlength="' + TC_REQ_MSG_MAX + '" placeholder="例如：我是 XX，加个好友"></textarea></label>'
      + '</div>'
      + '<div class="im-dlg-btns"><button class="im-btn" data-act="cancel">取消</button>'
      + '<button class="im-btn primary" data-act="ok">发送请求</button></div></div>';
    document.body.appendChild(mask);
    if (window.OCUI) window.OCUI.openModal(mask);
    const dismiss = () => { if (window.OCUI) window.OCUI.closeModal(mask); mask.remove(); };
    mask.querySelector('[data-act="cancel"]').addEventListener('click', dismiss);
    mask.addEventListener('click', (e) => { if (e.target === mask) dismiss(); });
    const ta = mask.querySelector('#im-req-msg');
    const submit = () => {
      const msg = ta.value.trim();
      dismiss();
      friendRequest(name, msg);
    };
    mask.querySelector('[data-act="ok"]').addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
    setTimeout(() => { try { ta.focus(); } catch (err) { /* 忽略 */ } }, 60);
  }

  function renderNewGroupPanel() {
    if (!S.ready) return;
    const el = S.els.sideScroll;
    if (!S.friends.length) {
      el.innerHTML = '<div class="im-empty small"><p>还没有好友</p><p class="im-empty-sub">先去「好友」页添加朋友,再拉群</p><button class="im-btn primary" data-act="goto-friends">去添加</button></div>';
      const b = el.querySelector('[data-act="goto-friends"]');
      if (b) b.addEventListener('click', () => setTab('friends'));
      return;
    }
    el.innerHTML =
      '<div class="im-side-title"><button class="im-btn small" data-act="back">' + icon('chevronLeft', 12) + ' 返回</button></div>'
      + '<div class="im-ng"><input id="im-group-title" type="text" placeholder="群聊名称（必填）" maxlength="40" autocomplete="off">'
      + '<div class="im-side-title">选择成员（' + S.friends.length + ' 位好友）</div>'
      + '<div class="im-ng-list">' + S.friends.map((f) =>
        '<label class="im-ng-row"><input type="checkbox" value="' + esc(f.id) + '">'
        + avatarHtml(f.name, 30, '', f.id) + '<span>' + esc(f.name) + '</span></label>').join('')
      + '</div>'
      + '<button class="im-btn primary block" id="im-group-create">' + icon('group', 14) + ' 创建群聊</button>'
      + '<p class="im-ng-tip">群聊最多 ' + 50 + ' 人；创建后任何成员都可以邀请自己的好友。</p></div>';
    el.querySelector('[data-act="back"]').addEventListener('click', () => setTab('friends'));
    el.querySelector('#im-group-create').addEventListener('click', () => {
      const title = el.querySelector('#im-group-title').value.trim();
      const ids = Array.from(el.querySelectorAll('.im-ng-row input:checked')).map((i) => i.value);
      if (!title) { toast('请填写群聊名称', true); return; }
      if (!ids.length) { toast('请至少选择一位好友', true); return; }
      createGroup(title, ids);
    });
  }

  // ============ 渲染:聊天窗 ============
  function renderChat() {
    const pane = S.els.pane;
    if (!S.current) {
      pane.innerHTML =
        '<div class="im-pane-empty">' + icon('bubbles', 40)
        + '<p>选择一个会话开始聊天</p>'
        + '<p class="im-empty-sub">输入 @ 选「AI 回答」可召唤 AI<br>输入框旁可开启整会话 AI 模式</p></div>';
      return;
    }
    const t = S.current;
    pane.innerHTML =
      '<header class="im-chat-head" id="im-chat-head"></header>'
      + '<div class="im-msgs" id="im-msgs"></div>'
      + '<button class="im-scroll-btn hidden" id="im-scroll-btn" data-tip="回到底部"><span class="im-scroll-arrow">' + icon('arrowDown', 15) + '</span><span class="im-scroll-count hidden"></span></button>'
      + '<footer class="im-composer" id="im-composer"></footer>';
    renderChatHeader();
    renderMessages(t.id);
    renderComposer();
    // 滚动状态:贴底时清空「新消息」计数,离开底部时浮出回底按钮
    const box = pane.querySelector('#im-msgs');
    const btn = pane.querySelector('#im-scroll-btn');
    btn.addEventListener('click', () => { box.scrollTop = box.scrollHeight; setNewBelow(t.id, 0, box); });
    box.addEventListener('scroll', () => {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (atBottom && S.newBelow.get(t.id)) setNewBelow(t.id, 0, box);
      updateScrollBtn(box, t.id);
    });
  }

  function renderChatHeader() {
    const head = S.els.pane.querySelector('#im-chat-head');
    if (!head || !S.current) return;
    const t = S.current;
    const name = threadName(t);
    let sub = '';
    if (isGroup(t)) {
      sub = (t.members || []).length + ' 位成员';
    } else {
      const other = (t.members || []).find((m) => m.id !== myId());
      sub = other && other.lastSeen > 0 && (Date.now() - other.lastSeen) < 70000 ? '在线' : '离线';
    }
    const aiChecked = t.aiEnabled ? ' checked' : '';
    head.innerHTML =
      '<button class="im-icon-btn" id="im-close-chat" data-tip="返回列表">' + icon('chevronLeft', 15) + '</button>'
      + threadAvatarHtml(t, 38)
      + '<div class="im-chat-title"><span class="im-chat-name">' + esc(name) + '</span>'
      + '<button class="im-chat-sub' + (isGroup(t) ? ' clickable' : '') + '" id="im-sub">' + esc(sub) + '</button></div>'
      + '<label class="switch im-ai-switch" data-tip="AI 模式:开启后每条消息 AI 都会回复">'
      + '<input type="checkbox" id="im-ai-toggle"' + aiChecked + '><span class="slider"></span></label>'
      + '<span class="im-ai-label">AI</span>'
      + '<button class="im-icon-btn" id="im-more" data-tip="会话操作">' + icon('more', 16) + '</button>';
    head.querySelector('#im-close-chat').addEventListener('click', closeThread);
    head.querySelector('#im-ai-toggle').addEventListener('change', (e) => toggleAi(t.id, e.target.checked));
    head.querySelector('#im-more').addEventListener('click', (e) => openThreadMenu(e.currentTarget));
    if (isGroup(t)) head.querySelector('#im-sub').addEventListener('click', openMembersDialog);
  }

  // 群成员弹层:点头部副标题(「N 位成员」)查看,含群主标记与在线状态
  function openMembersDialog() {
    const t = S.current;
    if (!t || !isGroup(t)) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask im-dlg-mask show';
    const owner = String(t.ownerId || '');
    mask.innerHTML =
      '<div class="im-dlg" role="dialog" aria-modal="true"><h3>群成员（' + (t.members || []).length + '）</h3>'
      + '<div class="im-ng-list tall">' + (t.members || []).map((m) =>
        '<div class="im-ng-row static">'
        + avatarHtml(m.name, 30, '', m.id) + (m.lastSeen > 0 && (Date.now() - m.lastSeen) < 70000 ? '<span class="im-online-dot in-list" data-tip="在线"></span>' : '')
        + '<span class="im-member-name">' + esc(m.name) + (m.guest ? ' <em class="im-guest-tag">游客</em>' : '') + '</span>'
        + (String(m.id) === owner ? '<span class="im-owner-tag">' + icon('gear', 12) + ' 群主</span>' : '')
        + '</div>').join('')
      + '</div>'
      + '<div class="im-dlg-btns"><button class="im-btn" data-act="close">关闭</button></div></div>';
    document.body.appendChild(mask);
    if (window.OCUI) window.OCUI.openModal(mask);
    mask.querySelector('[data-act="close"]').addEventListener('click', () => { if (window.OCUI) window.OCUI.closeModal(mask); mask.remove(); });
    mask.addEventListener('click', (e) => { if (e.target === mask) { if (window.OCUI) window.OCUI.closeModal(mask); mask.remove(); } });
  }

  function openThreadMenu(trigger) {
    const t = S.current;
    if (!t || !window.OC || !window.OC.openSelect) return;
    const items = [];
    items.push({ value: 'settings', label: '设置' });
    if (isGroup(t)) items.push({ value: 'add', label: '添加成员' });
    items.push({ value: 'del', label: isGroup(t) ? (amOwner(t) ? '解散群聊' : '退出群聊') : '删除会话', danger: true });
    window.OC.openSelect(trigger, items, {
      selected: '',
      onSelect: (v) => {
        if (v === 'del') deleteCurrentThread();
        else if (v === 'add') openMemberPicker();
        else if (v === 'settings') openThreadSettings();
      },
    });
  }

  // 会话设置:群名(群主可改)、AI 回答开关、群成员管理、危险操作。入口 = 右上角「会话操作」菜单
  function openThreadSettings() {
    const t = S.current;
    if (!t) return;
    const grp = isGroup(t);
    const owner = amOwner(t);
    const members = t.members || [];
    const other = members.find((m) => m.id !== myId());
    const sub = grp ? members.length + ' 位成员' : (other ? (other.guest ? '游客账号' : '用户') : '');
    const mask = document.createElement('div');
    mask.className = 'modal-mask im-dlg-mask show';
    mask.innerHTML =
      '<div class="im-dlg im-dlg-wide" role="dialog" aria-modal="true"><h3>设置</h3>'
      + '<div class="im-set">'
      + '<div class="im-set-id">' + threadAvatarHtml(t, 44)
      + '<div class="im-set-idmain"><span class="im-set-idname">' + esc(threadName(t)) + '</span>'
      + '<span class="im-set-idsub">' + esc(sub) + '</span></div></div>'
      + (grp && owner
        ? '<label class="im-set-field"><span>群名称</span>'
          + '<input type="text" id="im-set-title" maxlength="40" value="' + esc(threadName(t)) + '" autocomplete="off"></label>'
        : '')
      + '<div class="im-set-row"><div class="im-set-rowmain"><span class="im-set-rowtitle">AI 回答</span>'
      + '<span class="im-set-rowsub">开启后每条消息 AI 都会回复</span></div>'
      + '<label class="switch"><input type="checkbox" id="im-set-ai"' + (t.aiEnabled ? ' checked' : '') + '><span class="slider"></span></label></div>'
      + '<div class="im-set-row"><div class="im-set-rowmain"><span class="im-set-rowtitle">AI 读取上下文</span>'
      + '<span class="im-set-rowsub">关闭后 AI 只根据当前这条消息回答，不读取本会话历史</span></div>'
      + '<label class="switch"><input type="checkbox" id="im-set-ctx"' + (t.aiContext === false ? '' : ' checked') + '><span class="slider"></span></label></div>'
      + (grp
        ? '<div class="im-set-sec"><span>群成员（' + members.length + '）</span>'
          + '<button class="im-btn small" data-act="add">' + icon('plus', 12) + ' 添加</button></div>'
          + '<div class="im-ng-list tall">' + members.map((m) =>
            '<div class="im-ng-row static">' + avatarHtml(m.name, 30, '', m.id)
            + '<span class="im-member-name">' + esc(m.name) + (m.guest ? ' <em class="im-guest-tag">游客</em>' : '') + '</span>'
            + (String(m.id) === String(t.ownerId) ? '<span class="im-owner-tag">' + icon('gear', 12) + ' 群主</span>' : '')
            + '</div>').join('') + '</div>'
        : '')
      + '</div>'
      + '<div class="im-dlg-btns">'
      + '<button class="im-btn" data-act="close">关闭</button>'
      + '<button class="im-btn danger-ghost" data-act="del">' + (grp ? (owner ? '解散群聊' : '退出群聊') : '删除会话') + '</button>'
      + (grp && owner ? '<button class="im-btn primary" data-act="save">保存</button>' : '')
      + '</div></div>';
    document.body.appendChild(mask);
    if (window.OCUI) window.OCUI.openModal(mask);
    const dismiss = () => { if (window.OCUI) window.OCUI.closeModal(mask); mask.remove(); };
    mask.querySelector('[data-act="close"]').addEventListener('click', dismiss);
    mask.addEventListener('click', (e) => { if (e.target === mask) dismiss(); });
    mask.querySelector('#im-set-ai').addEventListener('change', (e) => toggleAi(t.id, e.target.checked));
    mask.querySelector('#im-set-ctx').addEventListener('change', (e) => setAiContext(t.id, e.target.checked));
    const addBtn = mask.querySelector('[data-act="add"]');
    if (addBtn) addBtn.addEventListener('click', () => { dismiss(); openMemberPicker(); });
    mask.querySelector('[data-act="del"]').addEventListener('click', () => { dismiss(); deleteCurrentThread(); });
    const save = mask.querySelector('[data-act="save"]');
    if (save) save.addEventListener('click', async () => {
      const input = mask.querySelector('#im-set-title');
      const title = (input ? input.value : '').trim();
      if (!title) { toast('请填写群名称', true); return; }
      save.disabled = true;
      if (await renameThread(t.id, title)) dismiss(); else save.disabled = false;
    });
  }

  async function setAiContext(tid, on) {
    try {
      const r = await apiJson('/api/im/threads/' + encodeURIComponent(tid) + '/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: !!on }),
      });
      if (S.current && S.current.id === tid) S.current.aiContext = r.aiContext !== false;
      const t = S.threads.find((x) => x.id === tid);
      if (t) t.aiContext = r.aiContext !== false;
      toast(on ? 'AI 将读取本会话上下文' : 'AI 只回答当前消息（不读上下文）');
    } catch (e) { toast(e.message || '操作失败', true); }
  }

  async function renameThread(tid, title) {
    try {
      const r = await apiJson('/api/im/threads/' + encodeURIComponent(tid) + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const nt = r.thread;
      if (nt) {
        if (S.current && S.current.id === tid) S.current = Object.assign({}, S.current, nt);
        const i = S.threads.findIndex((x) => x.id === tid);
        if (i >= 0) S.threads[i] = Object.assign({}, S.threads[i], nt);
      }
      toast('群名称已更新');
      renderChatHeader();
      renderThreadList();
      return true;
    } catch (e) { toast(e.message || '修改失败', true); return false; }
  }

  function openMemberPicker() {
    const t = S.current;
    if (!t) return;
    const have = new Set((t.members || []).map((m) => m.id));
    const cand = S.friends.filter((f) => !have.has(f.id));
    if (!cand.length) { toast('你的好友都已在群里', true); return; }
    // 简易多选弹层(复用 notes 的对话框习惯:自制 mask + 确认)
    const mask = document.createElement('div');
    mask.className = 'modal-mask im-dlg-mask show';
    mask.innerHTML =
      '<div class="im-dlg" role="dialog" aria-modal="true"><h3>添加成员</h3>'
      + '<div class="im-ng-list tall">' + cand.map((f) =>
        '<label class="im-ng-row"><input type="checkbox" value="' + esc(f.id) + '">'
        + avatarHtml(f.name, 30, '', f.id) + '<span>' + esc(f.name) + '</span></label>').join('')
      + '</div>'
      + '<div class="im-dlg-btns"><button class="im-btn" data-act="cancel">取消</button>'
      + '<button class="im-btn primary" data-act="ok">添加</button></div></div>';
    document.body.appendChild(mask);
    if (window.OCUI) window.OCUI.openModal(mask);
    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => { if (window.OCUI) window.OCUI.closeModal(mask); mask.remove(); });
    mask.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const ids = Array.from(mask.querySelectorAll('input:checked')).map((i) => i.value);
      if (!ids.length) { toast('请选择要添加的好友', true); return; }
      if (window.OCUI) window.OCUI.closeModal(mask);
      mask.remove();
      addMembers(t.id, ids);
    });
  }

  function canDeleteMsg(m) {
    if (!S.current || m.deleted) return false;
    if (m._tmp) return false;
    if (isGroup(S.current)) return String(m.from) === myId() || amOwner(S.current);
    return true;   // 单聊:双方都可双向删除
  }

  function renderMessages(tid, added) {
    const box = S.els.pane.querySelector('#im-msgs');
    if (!box || !S.current || S.current.id !== tid) return;
    const m = msgsOf(tid);
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    let html = '';
    let lastDay = '';
    for (const msg of m.list) {
      const d = new Date(msg.at || Date.now());
      const day = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      if (day !== lastDay) {
        lastDay = day;
        html += '<div class="im-day-sep"><span>' + (d.getMonth() + 1) + '月' + d.getDate() + '日' + (d.toDateString() === new Date().toDateString() ? '（今天）' : '') + '</span></div>';
      }
      html += renderMsg(msg);
    }
    if (S.aiPending.get(tid)) {
      html += '<div class="im-row ai" id="im-ai-pending">' + aiAvatarHtml(34, S.current && S.current.model)
        + '<div class="im-bubble ai im-typing"><span></span><span></span><span></span></div></div>';
    }
    box.innerHTML = html || '<div class="im-empty small"><p>还没有消息</p><p class="im-empty-sub">打个招呼吧,输入 @ 选「AI 回答」可以召唤 AI</p></div>';
    bindMsgActions(box);
    if (nearBottom) {
      box.scrollTop = box.scrollHeight;
      if (S.newBelow.get(tid)) setNewBelow(tid, 0, box);
    } else if (added > 0) {
      // 用户正翻历史:不抢滚动,浮钮上累加新消息数
      setNewBelow(tid, (S.newBelow.get(tid) || 0) + added, box);
    }
    updateScrollBtn(box, tid);
  }

  // 「回到底部」浮钮:离开底部时出现,有未读新消息时带数字
  function setNewBelow(tid, n, box) {
    if (n <= 0) S.newBelow.delete(tid);
    else S.newBelow.set(tid, n);
    if (!box) box = S.els.pane.querySelector('#im-msgs');
    if (box) updateScrollBtn(box, tid);
  }
  function updateScrollBtn(box, tid) {
    const btn = S.els.pane.querySelector('#im-scroll-btn');
    if (!btn) return;
    const away = box.scrollHeight - box.scrollTop - box.clientHeight;
    const n = S.newBelow.get(tid) || 0;
    btn.classList.toggle('hidden', away < 160 && !n);
    const c = btn.querySelector('.im-scroll-count');
    c.textContent = n > 99 ? '99+' : String(n || '');
    c.classList.toggle('hidden', !n);
  }

  // AI 头像与首页对话保持同一套逻辑:优先显示该模型的品牌 logo(deepseek / openai / …),
  // 取不到时退回站点 logo —— 与 app.js 的 aiAvatarHtml 一致,免得同一句 AI 回答
  // 在首页和聊天里长得不一样。
  function aiAvatarHtml(size, modelText) {
    if (window.OC && OC.logoImg && OC.modelLogo) {
      const html = OC.logoImg(OC.modelLogo(String(modelText || '')), 'im-avatar-logo');
      if (html) return '<span class="im-avatar ai" style="width:' + size + 'px;height:' + size + 'px">' + html + '</span>';
    }
    return '<span class="im-avatar ai" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.47) + 'px">' + icon('bot', Math.round(size * 0.47)) + '</span>';
  }

  function renderMsg(msg) {
    const who = msg.kind === 'ai' ? 'ai' : (msg.self ? 'self' : 'other');
    const av = who === 'self' ? '' : (msg.kind === 'ai'
      ? aiAvatarHtml(34, msg.model || S.current && S.current.model)
      : avatarHtml(msg.name, 34, '', msg.from));
    // 群聊发送者名字用头像同款渐变色(Telegram 惯例),一眼分辨谁在说话
    const nameLine = who === 'other' && isGroup(S.current)
      ? '<div class="im-msg-name" style="--nc:' + avPair(msg.name)[0] + '">' + esc(msg.name || '') + '</div>'
      : '';
    const aiName = msg.kind === 'ai' ? '<div class="im-msg-ai-name">' + icon('bot', 12) + ' AI' + (msg.model ? ' · ' + esc(msg.model) : '') + '</div>' : '';
    if (msg.deleted) {
      // 删除占位保持完整行布局(头像/名字都在),双方列表不会因为删除而跳动
      return '<div class="im-row ' + who + '" data-mid="' + esc(String(msg.id)) + '">'
        + av
        + '<div class="im-msg-col">' + nameLine + aiName
        + '<div class="im-bubble deleted">消息已删除</div>'
        + '</div></div>';
    }
    let bodyHtml = '';
    if (msg.file) bodyHtml += renderFilePart(msg.file);
    if (msg.text) {
      if (msg.kind === 'ai' && window.OCRenderer && window.OCRenderer.renderInto) {
        bodyHtml += '<div class="im-md" data-md="' + esc(String(msg.id)) + '">' + esc(msg.text) + '</div>';
      } else {
        bodyHtml += '<div class="im-text">' + esc(msg.text).replace(/\n/g, '<br>') + '</div>';
      }
    }
    const meta = '<span class="im-meta">' + (msg.pending ? '发送中…' : (msg.failed ? '发送失败' : fmtFullTime(msg.at))) + '</span>';
    const actions = [];
    if (msg.text && !msg.pending) actions.push('<button class="im-msg-act" data-copy="' + esc(String(msg.id)) + '" data-tip="复制">' + icon('copy', 13) + '</button>');
    if (canDeleteMsg(msg)) actions.push('<button class="im-msg-act danger" data-del="' + esc(String(msg.id)) + '" data-tip="双向删除">' + icon('trash', 13) + '</button>');
    return '<div class="im-row ' + who + (msg.pending ? ' pending' : '') + (msg.failed ? ' failed' : '') + '" data-mid="' + esc(String(msg.id)) + '">'
      + av
      + '<div class="im-msg-col">'
      + nameLine
      + aiName
      + '<div class="im-bubble ' + who + (msg.aiError ? ' err' : '') + '">' + bodyHtml + meta + '</div>'
      + '</div>'
      + (actions.length ? '<span class="im-msg-acts">' + actions.join('') + '</span>' : '')
      + '</div>';
  }

  function renderFilePart(f) {
    if (!f) return '';
    const url = safeUrl(f.url);
    if (f.image && url) {
      return '<img class="im-img" src="' + esc(url) + '" alt="' + esc(f.name) + '" loading="lazy" data-href="' + esc(url) + '">';
    }
    return '<a class="im-file" href="' + esc(url || '#') + '" download>'
      + '<span class="im-file-icon">' + icon('file', 16) + '</span>'
      + '<span class="im-file-main"><span class="im-file-name">' + esc(f.name) + '</span>'
      + '<span class="im-file-size">' + esc(fmtSize(f.size)) + '</span></span>'
      + '<span class="im-file-dl">' + icon('download', 14) + '</span></a>';
  }

  function bindMsgActions(box) {
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.del);
        if (!id) return;
        const ok = await (window.OCUI && window.OCUI.confirm ? window.OCUI.confirm({
          title: '删除这条消息？',
          message: '删除后双方都会看到「消息已删除」，内容进入管理端留档。',
          danger: true, confirmText: '删除',
        }) : Promise.resolve(window.confirm('删除这条消息？')));
        if (ok) deleteMessages([id]);
      });
    });
    box.querySelectorAll('[data-copy]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const m = msgsOf(S.current ? S.current.id : '').list.find((x) => String(x.id) === b.dataset.copy);
        const text = m && m.text ? m.text : '';
        if (!text) return;
        // 三条路径都要给结果反馈:剪贴板权限被拒时静默失败,用户会以为复制了
        if (window.OCUI && window.OCUI.copyText) {
          Promise.resolve(window.OCUI.copyText(text)).then((ok) => toast(ok === false ? '复制失败' : '已复制')).catch(() => toast('复制失败', true));
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(() => toast('已复制'), () => toast('复制失败', true));
        } else toast('已复制');
      });
    });
    // 图片:模块内灯箱(点击放大,再点/Esc 关闭),不再跳新标签页
    box.querySelectorAll('.im-img').forEach((img) => {
      img.addEventListener('click', () => openLightbox(img.dataset.href, img.alt));
    });
    // AI 消息 Markdown 渲染(与聊天同一条 DOMPurify 管线)
    if (window.OCRenderer && window.OCRenderer.renderInto) {
      box.querySelectorAll('[data-md]').forEach((el) => {
        const m = msgsOf(S.current ? S.current.id : '').list.find((x) => String(x.id) === el.dataset.md);
        if (m && m.text) window.OCRenderer.renderInto(el, m.text);
      });
    }
  }

  // ============ 灯箱 ============
  function openLightbox(src, alt) {
    if (!src) return;
    let lb = document.getElementById('im-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'im-lightbox';
      lb.className = 'im-lightbox';
      lb.innerHTML = '<img alt="">';
      lb.addEventListener('click', () => lb.classList.remove('open'));
      document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape' && lb.classList.contains('open')) { lb.classList.remove('open'); e.stopPropagation(); }
      });
      document.body.appendChild(lb);
    }
    lb.querySelector('img').src = src;
    lb.querySelector('img').alt = alt || '';
    requestAnimationFrame(() => lb.classList.add('open'));
  }

  function renderComposer() {
    const foot = S.els.pane.querySelector('#im-composer');
    if (!foot || !S.current) return;
    foot.innerHTML =
      '<div class="im-upload-bar hidden" id="im-upload-bar"></div>'
      + '<div class="im-ai-hint hidden" id="im-ai-hint">' + icon('bot', 13) + ' 将召唤 AI 回答这个问题</div>'
      + '<div class="im-input-box">'
      + '<div class="im-mention hidden" id="im-mention"></div>'
      + '<textarea id="im-input" rows="1" placeholder="输入消息，@AI 召唤 AI 回答" maxlength="4000"></textarea>'
      + '<div class="im-input-bar">'
      + '<button class="im-icon-btn" id="im-attach" data-tip="发送图片或文件">' + icon('paperclip', 18) + '</button>'
      + '<span class="im-composer-tip">Enter 发送 · Shift+Enter 换行 · 输入 @ 召唤 AI</span>'
      + '<span class="im-char-cnt" id="im-char-cnt"></span>'
      + '<button class="im-send-btn dim" id="im-send" data-tip="发送">' + icon('send', 17) + '</button>'
      + '</div>'
      + '</div>';
    const ta = foot.querySelector('#im-input');
    const mentionEl = foot.querySelector('#im-mention');
    const mention = { open: false, idx: 0, items: [], at: -1 };
    const closeMention = () => {
      mention.open = false;
      mentionEl.classList.add('hidden');
      mentionEl.innerHTML = '';
    };
    const renderMention = () => {
      mentionEl.innerHTML = mention.items.map((m, i) =>
        '<button type="button" class="im-mention-item' + (i === mention.idx ? ' active' : '') + '" data-key="' + esc(m.key) + '">'
        + '<span class="im-mention-ic">' + icon(m.ic, 15) + '</span>'
        + '<span class="im-mention-main"><span class="im-mention-label">' + esc(m.label) + '</span>'
        + '<span class="im-mention-desc">' + esc(m.desc) + '</span></span></button>').join('');
      mentionEl.querySelectorAll('.im-mention-item').forEach((b) => {
        // pointerdown 抢在 blur 之前触发,避免点选时输入框失焦丢光标
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); applyMention(b.dataset.key); });
      });
    };
    const applyMention = (key) => {
      const it = mention.items.find((m) => m.key === key);
      if (!it || mention.at < 0) { closeMention(); return; }
      const caret = ta.selectionStart;
      const text = '@' + key.toUpperCase() + ' ';   // 目前只有 ai → 「@AI 」
      ta.value = ta.value.slice(0, mention.at) + text + ta.value.slice(caret);
      const pos = mention.at + text.length;
      closeMention();
      ta.focus();
      try { ta.setSelectionRange(pos, pos); } catch (err) { /* 忽略 */ }
      autoGrow(ta);
      renderComposerState();
    };
    // 光标前是否正处在一段「@查询」中(以行首/空白起头,且查询段内无空白,避开邮箱里的 @)
    const mentionContext = () => {
      if (ta.selectionStart !== ta.selectionEnd) return null;
      const caret = ta.selectionStart;
      const before = ta.value.slice(0, caret);
      const at = Math.max(before.lastIndexOf('@'), before.lastIndexOf('＠'));
      if (at < 0) return null;
      if (at > 0 && !/\s/.test(before[at - 1])) return null;
      const seg = before.slice(at + 1);
      if (/[\s@＠]/.test(seg)) return null;
      return { at, query: seg };
    };
    const syncMention = () => {
      const ctx = mentionContext();
      if (!ctx) { if (mention.open) closeMention(); return; }
      const q = ctx.query.toLowerCase();
      const items = MENTION_ITEMS.filter((m) => !q || m.key.indexOf(q) === 0 || m.label.toLowerCase().indexOf(q) >= 0);
      if (!items.length) { if (mention.open) closeMention(); return; }
      mention.items = items;
      mention.at = ctx.at;
      if (!mention.open) mention.idx = 0;
      else mention.idx = Math.min(mention.idx, items.length - 1);
      mention.open = true;
      mentionEl.classList.remove('hidden');
      renderMention();
    };
    dismissMention = closeMention;
    ta.addEventListener('keydown', (e) => {
      if (mention.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          mention.idx = (mention.idx + (e.key === 'ArrowDown' ? 1 : mention.items.length - 1)) % mention.items.length;
          renderMention();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {   // 弹层开着时回车=选中提及,不发送
          e.preventDefault();
          applyMention(mention.items[mention.idx].key);
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendCurrent();
      }
    });
    ta.addEventListener('input', () => { autoGrow(ta); renderComposerState(); syncMention(); });
    ta.addEventListener('click', syncMention);
    ta.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) >= 0) syncMention(); });
    ta.addEventListener('blur', () => { setTimeout(() => { if (!mentionEl.contains(document.activeElement)) closeMention(); }, 120); });
    foot.querySelector('#im-send').addEventListener('click', sendCurrent);
    foot.querySelector('#im-attach').addEventListener('click', pickFiles);
    // 粘贴图片直接上传
    ta.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.kind === 'file' && /^image\//.test(it.type || '')) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); uploadFile(f); return; }
        }
      }
    });
    // 拖拽上传
    foot.addEventListener('dragover', (e) => { e.preventDefault(); });
    foot.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadFile(f);
    });
    renderComposerState();
  }

  function renderComposerState() {
    const foot = S.els.pane.querySelector('#im-composer');
    if (!foot) return;
    const hint = foot.querySelector('#im-ai-hint');
    const ta = foot.querySelector('#im-input');
    if (hint && ta) hint.classList.toggle('hidden', !AI_HINT_RE.test(ta.value));
    // 发送键的「无内容」弱化态 + 接近上限时的字数提示
    const send = foot.querySelector('#im-send');
    if (send && ta) send.classList.toggle('dim', !ta.value.trim() && !(S.upload && S.upload.state === 'done'));
    const cnt = foot.querySelector('#im-char-cnt');
    if (cnt && ta) {
      const left = 4000 - ta.value.length;
      cnt.textContent = left <= 200 ? String(left) : '';
      cnt.classList.toggle('warn', left <= 100);
    }
    const bar = foot.querySelector('#im-upload-bar');
    if (!bar) return;
    if (!S.upload) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    if (S.upload.state === 'uploading') {
      bar.innerHTML = '<span class="im-up-name">' + esc(S.upload.name) + '</span>'
        + '<span class="im-up-bar"><span style="width:' + (S.upload.progress || 5) + '%"></span></span>'
        + '<span class="im-up-pct">' + (S.upload.progress || 0) + '%</span>';
    } else {
      bar.innerHTML = '<span class="im-up-name">' + (S.upload.image ? icon('image', 13) : icon('file', 13)) + ' ' + esc(S.upload.name) + '</span>'
        + '<span class="im-up-pct">已就绪</span>'
        + '<button class="im-icon-btn small" id="im-up-remove" data-tip="移除附件">' + icon('close', 12) + '</button>';
      const rm = bar.querySelector('#im-up-remove');
      if (rm) rm.addEventListener('click', () => { S.upload = null; renderComposerState(); });
    }
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  }

  // ============ 角标与轮询 ============
  function renderEntryBadge() {
    const btn = document.getElementById('im-entry-btn');
    if (!btn) return;
    const badge = document.getElementById('im-entry-badge');
    if (!badge) return;
    let n = S.requests.length;
    for (const t of S.threads) n += t.unread || 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', !n);
  }

  function startPoll(ms) {
    stopPoll();
    S.pollTimer = setInterval(() => { if (!document.hidden) pollUpdates(); }, ms);
  }
  function stopPoll() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    if (S.badgeTimer) { clearInterval(S.badgeTimer); S.badgeTimer = null; }
  }
  function startBadge(ms) {
    if (S.badgeTimer) clearInterval(S.badgeTimer);
    S.badgeTimer = setInterval(() => { if (!document.hidden) tick(); }, ms);
  }

  // 关闭状态下的轻量轮询:只刷角标
  async function tick() {
    if (S.open || !imEnabled()) return;
    if (!window.OCApp || !window.OCApp.state || !window.OCApp.state.user) return;
    try {
      const upd = await apiJson('/api/im/updates');
      applyUpdates(upd);
    } catch (e) { /* 静默 */ }
  }

  function warmUp() {
    if (!imEnabled()) {
      const btn = document.getElementById('im-entry-btn');
      if (btn) btn.classList.add('hidden');
      return;
    }
    tick();
    startBadge(25000);
  }

  // ============ 入口 ============
  function initEntry() {
    const btn = document.getElementById('im-entry-btn');
    if (!btn) return;
    if (!imEnabled()) { btn.classList.add('hidden'); return; }
    const iconEl = document.getElementById('im-entry-icon');
    if (iconEl && window.OC && OC.icon) iconEl.innerHTML = OC.icon('bubbles', 15);
    btn.addEventListener('click', open);
    warmUp();
    // 直达 /im(或刷新):等登录态就绪后自动进入聊天页
    if (isImPath()) {
      let tries = 0;
      const boot = async () => {
        tries++;
        const st = window.OCApp && window.OCApp.state;
        if (st && st.user) { open(); return; }
        if (tries < 40) { setTimeout(boot, 250); return; }
        // 10 秒还没等到登录态:刻意不自动开(未登录时聊天接口会 401,开了也是空壳),
        // 必须让用户知道发生了什么 —— 否则停在对话页,看起来像 /im 这个地址坏了。
        if (!st || !st.user) {
          toast('登录状态未就绪，聊天暂未打开；请刷新页面或重新登录', true);
        }
      };
      boot();
    }
    // 浏览器前进/后退:地址与模块状态保持一致
    window.addEventListener('popstate', () => {
      const shown = S.open && S.els.mask && S.els.mask.classList.contains('show');
      if (isImPath() && !shown) open();
      else if (!isImPath() && shown) close();
    });
    // /api/me 带回按人判定后会广播:入口可能先渲染、权限后到(或反之),这里重判一次
    window.addEventListener('oc:features', () => {
      const ok = imEnabled();
      btn.classList.toggle('hidden', !ok);
      if (!ok) {
        if (S.badgeTimer) { clearInterval(S.badgeTimer); S.badgeTimer = null; }
        if (S.open) close();
      } else warmUp();
    });
  }

  window.OCIM = {
    open, close, tick, warmUp,
    isOpen: () => S.open,
    _debug: S,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEntry);
  else initEntry();
})();
