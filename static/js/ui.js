'use strict';
/**
 * ui.js — 共享 UI 基础能力（前台 / 后台通用）
 *  - toast 轻提示（可堆叠、语义色）
 *  - 确认弹窗（Promise 版，替代 window.confirm）
 *  - 弹窗控制（遮罩点击 / Esc 关闭 / 焦点回收）
 *  - 主题（跟随系统 / 浅色 / 深色）
 *  - 用户偏好（localStorage 持久化 + 变更订阅）
 *  - 工具：转义、下载、复制、防抖节流、时间格式化
 *
 * 注意：本文件不声明 $ / escapeHtml 等全局名，避免与页面脚本重复声明冲突。
 */

(function () {
  const UI = {};
  UI.version = '2.0.0';

  const PREF_KEY = 'oc_prefs';
  // 后台「内置字体默认不加载」开启时,默认字体用系统字体(不下载 ~19MB),
  // 用户仍可在「外观」里自行切换为思源宋体/阿里巴巴普惠体等内置字体(切换后会按需加载)。
  function ocNoWebfonts() { return !!(window.OC_PERF && window.OC_PERF.noWebfonts); }
  function ocDefaultCjkFont() { return ocNoWebfonts() ? 'system' : 'source-han-serif'; }
  function ocDefaultLatinFont() { return ocNoWebfonts() ? 'system' : 'alibaba-sans'; }
  const PREF_DEFAULTS = {
    stream: true,          // 流式输出
    followups: true,       // AI 跟进建议(默认开启;会额外扣费,可在设置中关闭)
    followupsModel: '',    // 跟进建议所用模型:'' = 跟随当前模型;否则 "providerId\nmodelId"
    autotitle: true,       // 自动生成会话标题(新建对话时)
    titleModel: '',        // [已并入 AI 工具判定] 旧字段,仅作迁移回退
    judgeModel: '',        // AI 工具判定所用模型:'' = 跟随当前对话模型;否则 "providerId\nmodelId"
    aiJudge: true,         // AI 工具判定总开关:关闭后不再调用判定,出图回退粗略识别、标题回退本地截取
    imageModel: '',        // 默认生图模型:'' = 用第一个可用生图模型;否则 "providerId\nmodelId"
    videoModel: '',        // 默认生视频模型:'' = 用上次使用/第一个可用视频模型;否则 "providerId\nmodelId"
    autoImageMode: 'auto', // 对话中自动出图:off=关闭 | rough=粗略关键词识别 | auto=智能判定(默认)
    autoImageModel: '',    // [已并入 AI 工具判定] 旧字段,仅作迁移回退
    elapsed: true,         // 显示生成耗时
    reasoning: true,       // 请求并展示思维链
    reasoningEffort: 'medium', // off | low | medium | high
    contextMessages: 12,       // 每次请求带上的最近消息条数(默认 12)
    webSearchMode: 'auto',     // auto | on | off
    theme: 'system',       // system | light | dark
    fontSize: 14,          // 消息区字号(px)
    fontFamily: 'source-han-serif', // 旧版兼容:单一字体
    fontCjk: 'source-han-serif',     // 中文字体
    fontLatin: 'alibaba-sans',       // 英文/希腊字母字体
    accent: '',            // 主题色(空 = 默认)
    themePack: 'default',  // 主题包(主题市场):default = 当前外观;其余见 theme-boot.js 的 OC_THEME_PACKS
    lastProviderId: null,  // 上次使用的供应商
    lastModel: null,       // 上次使用的模型
    pinnedProviderId: null, // 置顶供应商：新建对话使用
    pinnedModel: null,      // 置顶模型：新建对话使用
  };
  PREF_DEFAULTS.fontCjk = ocDefaultCjkFont();
  PREF_DEFAULTS.fontLatin = ocDefaultLatinFont();
  PREF_DEFAULTS.fontFamily = ocDefaultCjkFont();

  let prefs = null;
  const prefListeners = [];

  // 默认值迁移:老浏览器里 oc_prefs 一旦被完整序列化过(改任意偏好时发生),
  // 就会固化当时的默认值,后续改 PREF_DEFAULTS 对这些用户不再生效。
  // 这里按版本号做一次性顺移,并用 oc_prefs_touched 记录用户显式改过的键(绝不覆盖)。
  const PREF_SCHEMA_VERSION = 2;
  const PREF_SCHEMA_KEY = 'oc_prefs_schema';
  const PREF_TOUCHED_KEY = 'oc_prefs_touched';
  const PREF_DEFAULT_MIGRATIONS = [
    ['followups', false, true],          // AI 跟进建议:默认关闭 -> 默认开启
    ['autoImageMode', 'rough', 'auto'],  // 自动出图:粗略识别 -> 智能判定
    ['contextMessages', 40, 12],         // AI 上下文条数:默认 40 -> 12
  ];

  // ============ 偏好 ============
  function loadPrefs() {
    if (prefs) return prefs;
    prefs = Object.assign({}, PREF_DEFAULTS);
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      // 只拷贝自有键并跳过 __proto__/constructor:Object.assign 用 [[Set]] 语义赋值,
      // 源对象里的 "__proto__" 键会触发目标对象的原型 setter,把整个 prefs 的原型换掉。
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          prefs[k] = raw[k];
        }
      }
    } catch (e) { /* 忽略损坏数据 */ }
    if (!localStorage.getItem(PREF_KEY)) {
      // 兼容旧版本单独存储的键
      const legacyTheme = localStorage.getItem('oc_theme');
      if (legacyTheme) prefs.theme = legacyTheme;
      if (localStorage.getItem('oc_sidebar_collapsed') === '1') prefs.sidebarCollapsed = true;
    }
    // 旧版本只有一组字体设置:非默认字体同时迁移到两组,默认字体用当前后台默认(可能为系统字体)。
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'fontCjk')) {
      const legacy = String(raw && raw.fontFamily != null ? raw.fontFamily : '').trim();
      prefs.fontCjk = (legacy && legacy !== 'system' && legacy !== 'source-han-serif') ? legacy : ocDefaultCjkFont();
    }
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'fontLatin')) {
      const legacy = String(raw && raw.fontFamily != null ? raw.fontFamily : '').trim();
      prefs.fontLatin = (legacy && legacy !== 'system' && legacy !== 'source-han-serif') ? legacy : ocDefaultLatinFont();
    } else if (raw.fontLatin === 'times-new-roman' && raw.fontFamily === 'source-han-serif') {
      // 仅迁移上一版的默认组合,不覆盖用户明确选择的其他字体。
      prefs.fontLatin = ocDefaultLatinFont();
    }
    // 旧版「命名方式 / 追问判定模型」并入统一的 AI 工具判定模型:
    // 若用户曾单独指定过 (titleModel 或 autoImageModel),迁移到 judgeModel。
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'judgeModel')) {
      const legacyTitle = String((raw && raw.titleModel) || '').trim();
      const legacyAuto = String((raw && raw.autoImageModel) || '').trim();
      if (legacyTitle && legacyTitle !== 'current') prefs.judgeModel = legacyTitle;
      else if (legacyAuto) prefs.judgeModel = legacyAuto;
    }
    // 默认值一次性迁移(仅当值仍等于旧默认值时顺移;touched 里的键一律跳过)
    let schema = 0;
    try { schema = Number(localStorage.getItem(PREF_SCHEMA_KEY) || 0) || 0; } catch (e) { /* 存储不可用 */ }
    if (schema < PREF_SCHEMA_VERSION) {
      let touched = [];
      try {
        const t = JSON.parse(localStorage.getItem(PREF_TOUCHED_KEY) || '[]');
        if (Array.isArray(t)) touched = t.map((x) => String(x));
      } catch (e) { /* 忽略损坏数据 */ }
      let changed = false;
      PREF_DEFAULT_MIGRATIONS.forEach((m) => {
        const key = m[0], oldVal = m[1], newVal = m[2];
        if (touched.indexOf(key) >= 0) return; // 用户显式设置过,不覆盖
        if (!raw || !Object.prototype.hasOwnProperty.call(raw, key)) return;
        if (prefs[key] !== oldVal) return;
        prefs[key] = newVal;
        changed = true;
      });
      try { localStorage.setItem(PREF_SCHEMA_KEY, String(PREF_SCHEMA_VERSION)); } catch (e) { /* 存储不可用 */ }
      if (changed) {
        try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* 存储不可用 */ }
      }
    }
    return prefs;
  }
  UI.getPrefs = function () { return Object.assign({}, loadPrefs()); };
  UI.getPref = function (key) { return loadPrefs()[key]; };
  UI.setPref = function (key, value) {
    const p = loadPrefs();
    // 记录显式改过:默认值迁移据此跳过,避免覆盖用户自己的选择
    try {
      const t = JSON.parse(localStorage.getItem(PREF_TOUCHED_KEY) || '[]');
      const arr = Array.isArray(t) ? t.map((x) => String(x)) : [];
      if (arr.indexOf(String(key)) < 0) {
        arr.push(String(key));
        localStorage.setItem(PREF_TOUCHED_KEY, JSON.stringify(arr));
      }
    } catch (e) { /* 存储不可用 */ }
    if (p[key] === value) return value;
    p[key] = value;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* 存储不可用 */ }
    prefListeners.forEach((fn) => { try { fn(key, value, p); } catch (e) {} });
    return value;
  };
  UI.onPrefsChange = function (fn) { prefListeners.push(fn); };
  // 整批写入偏好(设置云同步应用云端设置时使用):与 setPref 一样标记 touched
  // (云端值来自用户自己的选择,默认值迁移不得再覆盖),并统一通知订阅者一次,
  // key 传 null 表示「批量变更」,订阅者据此区分是否为单键操作。
  UI.setPrefsBulk = function (obj) {
    if (!obj || typeof obj !== 'object') return false;
    const p = loadPrefs();
    const keys = Object.keys(obj);
    let changed = false;
    keys.forEach((k) => { if (p[k] !== obj[k]) { p[k] = obj[k]; changed = true; } });
    if (!changed) return false;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* 存储不可用 */ }
    try {
      const t = JSON.parse(localStorage.getItem(PREF_TOUCHED_KEY) || '[]');
      const arr = Array.isArray(t) ? t.map((x) => String(x)) : [];
      keys.forEach((k) => { if (arr.indexOf(String(k)) < 0) arr.push(String(k)); });
      localStorage.setItem(PREF_TOUCHED_KEY, JSON.stringify(arr));
    } catch (e) { /* 存储不可用 */ }
    prefListeners.forEach((fn) => { try { fn(null, undefined, p); } catch (e) {} });
    return true;
  };
  // 丢弃内存缓存:换账号登录(设置云同步)时先清掉上一个账号的偏好,下次读取回到默认值
  UI.resetPrefs = function () { prefs = null; };

  // ============ Toast ============
  function toastHost() {
    let host = document.getElementById('oc-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'oc-toast-host';
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }
  /**
   * @param {string} msg 提示内容
   * @param {boolean|string} type true/'error' = 错误；'success' | 'info'
   */
  UI.toast = function (msg, type) {
    const isError = type === true || type === 'error';
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : (type === 'success' ? ' success' : ''));
    t.textContent = String(msg);
    toastHost().appendChild(t);
    const ttl = isError ? 4200 : 2600;
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 240);
    }, ttl);
    return t;
  };

  // ============ 转义与文本 ============
  UI.escapeHtml = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  UI.escapeAttr = function (s) { return UI.escapeHtml(s); };
  UI.truncate = function (s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  // ============ 剪贴板 / 下载 / 格式化 ============
  UI.copyText = async function (text) {
    const t = String(text === undefined || text === null ? '' : text);
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const done = document.execCommand('copy');
        ta.remove();
        return done;
      } catch (e2) {
        return false;
      }
    }
  };
  UI.download = function (filename, content, mime) {
    try {
      const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      return false;
    }
  };
  UI.fmtBytes = function (n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  };
  UI.fmtTime = function (ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  };
  UI.fmtRelative = function (ts) {
    const d = Date.now() - Number(ts || 0);
    if (!Number.isFinite(d) || d < 0) return UI.fmtTime(ts);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
    return new Date(Number(ts)).toLocaleDateString('zh-CN');
  };
  UI.fmtDuration = function (ms) {
    const s = Math.max(0, Number(ms) || 0) / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    return Math.floor(s / 60) + ' 分 ' + Math.round(s % 60) + ' 秒';
  };
  UI.debounce = function (fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(self, args), wait);
    };
  };
  UI.throttle = function (fn, wait) {
    let last = 0;
    let timer = null;
    return function () {
      const args = arguments;
      const self = this;
      const now = Date.now();
      const remain = wait - (now - last);
      if (remain <= 0) {
        last = now;
        fn.apply(self, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(self, args);
        }, remain);
      }
    };
  };
  UI.uid = function (prefix) {
    return (prefix || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };
  // ============ 弹窗控制 ============
  const modalStack = [];
  UI.openModal = function (el) {
    if (!el) return;
    el.classList.remove('hidden');
    // _closeSeq 是「开合代次」:closeModal 的落幕定时器与这里的入场帧都得认它。
    // 作废还在路上的「落幕」定时器:closeModal 是 320ms 后才加 hidden 的,
    // 关掉又立刻重开时,那条定时器会把刚打开的弹窗再藏起来 —— 表现为弹窗闪一下就没了,
    // 用户得再点一次。IM 抽屉曾为此单独打过补丁,这里在入口统一修掉。
    const seq = (el._closeSeq = (el._closeSeq || 0) + 1);
    // 入场那一帧同样要认代次:rAF 在标签页被挂起时会迟到很久(后台标签页 / 卡顿的渲染进程,
    // CI 的 headless 上实测能晚几秒),迟到的那一帧若照加不管,就会把 show 加回一个**已经关掉**
    // 的弹窗上 —— 变成 hidden + show 的幽灵:看不见(display:none 优先级更高),但它仍在 DOM 里
    // 带着 show,.tb-mask.show 这类选择器与「面板还开着吗」的判断全都会认错。
    requestAnimationFrame(() => { if (el._closeSeq === seq) el.classList.add('show'); });
    if (modalStack.indexOf(el) === -1) modalStack.push(el);
    document.body.classList.add('modal-open');
    // 记住触发元素,关闭时把焦点还给它(键盘/读屏用户不再被丢回 body)
    el._prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 默认焦点优先落在输入框,其次是主操作按钮;绝不落在右上角关闭(X)等图标按钮上,
    // 否则弹窗一打开关闭按钮就带着焦点高亮,视觉上像是被"选中"了。
    const pick = [
      '[data-autofocus]:not([disabled])',
      'input:not([type=hidden]):not([disabled]):not([data-no-autofocus])',
      'textarea:not([disabled]):not([data-no-autofocus])',
      'button.btn.primary:not([disabled]):not([data-no-autofocus])',
      '.modal-footer .btn:not(.icon-btn):not([disabled]):not([data-no-autofocus])',
    ];
    let focusable = null;
    const visible = (n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
    for (const sel of pick) {
      // 只挑可见元素:隐藏面板(display:none)里的候选 focus() 会静默失败,
      // 弹窗打开后焦点仍留在 body,键盘直接 Tab 就逃出弹窗
      const found = Array.prototype.slice.call(el.querySelectorAll(sel)).find(visible);
      if (found) { focusable = found; break; }
    }
    if (focusable) setTimeout(() => focusable.focus(), 80);
    else {
      // 没有可聚焦元素时,把焦点交给弹窗容器本身(不可见焦点环),避免浏览器把焦点留给关闭按钮
      el.setAttribute('tabindex', '-1');
      el.style.outline = 'none';
      setTimeout(() => el.focus({ preventScroll: true }), 80);
    }
  };
  UI.closeModal = function (el) {
    if (!el) return;
    el.classList.remove('show');
    const seq = (el._closeSeq = (el._closeSeq || 0) + 1);
    setTimeout(() => { if (el._closeSeq === seq) el.classList.add('hidden'); }, 320);
    const i = modalStack.indexOf(el);
    if (i >= 0) modalStack.splice(i, 1);
    if (!modalStack.length) document.body.classList.remove('modal-open');
    // 焦点归还触发元素;触发元素已从 DOM 移除时(如重渲染后的列表项)跳过
    const prev = el._prevFocus;
    el._prevFocus = null;
    if (prev && prev.isConnected) {
      setTimeout(() => { try { prev.focus({ preventScroll: true }); } catch (e) {} }, 60);
    }
    // 关闭回调只触发一次:大量弹窗把 _onClose 设成「关自己」的 done()(内部又调 closeModal),
    // 若这里原样回调,closeModal ↔ _onClose 会互相递归到爆栈——栈溢出抛在点击处理器里,
    // 后面的代码(如「已分享管理」的 setTimeout 打开下一个弹窗)整段不执行,表现为点了没反应。
    // 先取出并清空,回调内部的再次 closeModal 就成了普通收尾,不再递归。
    const onClose = el._onClose;
    el._onClose = null;
    if (typeof onClose === 'function') onClose();
  };
  UI.isModalOpen = function () { return modalStack.length > 0; };
  // 动态创建的弹窗遮罩(用完直接 remove())纳入统一管理:
  // 获得 Esc 关闭 / 焦点管理 / body.modal-open;返回幂等的 close 函数,
  // 调用方把原有的 mask.remove() 逻辑作为 close 传入即可。
  UI.adoptModal = function (mask, close) {
    if (!mask) return close;
    let closed = false;
    const once = () => {
      if (closed) return;
      closed = true;
      UI.closeModal(mask);
      if (typeof close === 'function') close();
    };
    UI.openModal(mask);
    mask._onClose = once; // Esc 走 closeModal → 触发 once
    return once;
  };
  /** 绑定：遮罩点击关闭 + Esc 关闭 + 关闭按钮 */
  UI.bindModal = function (el, opts = {}) {
    if (!el) return;
    el._onClose = opts.onClose;
    el.addEventListener('mousedown', (e) => {
      if (e.target === el && opts.maskClose !== false) UI.closeModal(el);
    });
    if (opts.closeSelector) {
      const btn = el.querySelector(opts.closeSelector);
      if (btn) btn.addEventListener('click', () => UI.closeModal(el));
    }
    if (opts.closeId) {
      const btn = document.getElementById(opts.closeId);
      if (btn) btn.addEventListener('click', () => UI.closeModal(el));
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalStack.length) {
      e.preventDefault();
      UI.closeModal(modalStack[modalStack.length - 1]);
    }
  });

  // ============ 确认弹窗（Promise） ============
  UI.confirm = function (opts = {}) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask oc-confirm-mask';
      mask.innerHTML =
        '<div class="modal modal-sm" role="alertdialog" aria-modal="true">'
        + '<div class="modal-header"><h3>' + UI.escapeHtml(opts.title || '确认操作') + '</h3></div>'
        + '<div class="modal-body"><p class="confirm-message">' + UI.escapeHtml(opts.message || '确定继续吗？') + '</p></div>'
        + '<div class="modal-footer">'
        + '<button class="btn" data-act="cancel">' + UI.escapeHtml(opts.cancelText || '取消') + '</button>'
        + '<button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" data-act="ok">' + UI.escapeHtml(opts.confirmText || '确定') + '</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      UI.openModal(mask);
      const done = (v) => {
        UI.closeModal(mask);
        setTimeout(() => mask.remove(), 340);
        resolve(v);
      };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return done(false);
        const act = e.target.closest('[data-act]');
        if (!act) return;
        done(act.dataset.act === 'ok');
      });
      mask.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        // 焦点在「取消」上时按 Enter 应执行取消(交给原生 click),不能误触确认
        const t = e.target;
        if (t && t.closest && t.closest('[data-act="cancel"]')) return;
        e.preventDefault();
        done(true);
      });
      setTimeout(() => {
        // 破坏性操作(删除/清空)默认焦点落在「取消」上:键盘用户连按 Enter 不会直接执行删除。
        const target = mask.querySelector(opts.danger ? '[data-act="cancel"]' : '[data-act="ok"]');
        if (target) target.focus();
      }, 60);
    });
  };

  // ============ 输入弹窗（Promise，替代 window.prompt） ============
  UI.prompt = function (opts = {}) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask oc-confirm-mask';
      mask.innerHTML =
        '<div class="modal modal-sm" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>' + UI.escapeHtml(opts.title || '请输入') + '</h3></div>'
        + '<div class="modal-body">'
        + (opts.message ? '<p class="confirm-message">' + UI.escapeHtml(opts.message) + '</p>' : '')
        + '<input type="text" class="oc-prompt-input" data-autofocus maxlength="' + (opts.maxlength || 60) + '" style="width:100%">'
        + '</div>'
        + '<div class="modal-footer">'
        + '<button class="btn" data-act="cancel">' + UI.escapeHtml(opts.cancelText || '取消') + '</button>'
        + '<button class="btn primary" data-act="ok">' + UI.escapeHtml(opts.confirmText || '确定') + '</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      UI.openModal(mask);
      const input = mask.querySelector('.oc-prompt-input');
      input.value = opts.value || '';
      const done = (v) => {
        UI.closeModal(mask);
        setTimeout(() => mask.remove(), 340);
        resolve(v);
      };
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return done(null);
        const act = e.target.closest('[data-act]');
        if (!act) return;
        done(act.dataset.act === 'ok' ? String(input.value).trim() : null);
      });
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); done(String(input.value).trim()); }
        // Esc 已经在这里消费掉了,必须截断冒泡:全局 Esc 处理器会接着关掉弹窗栈里的
        // 下一层,用户按一次 Esc 就把两层都关了。
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 60);
    });
  };

  // ============ 主题 ============
  const HLJS = { light: '/vendor/highlight/github.min.css', dark: '/vendor/highlight/github-dark.min.css' };
  UI.resolveTheme = function (mode) {
    const m = mode || UI.getPref('theme') || 'system';
    if (m === 'light' || m === 'dark') return m;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  };
  UI.applyTheme = function (mode, opts = {}) {
    if (mode) UI.setPref('theme', mode);
    const resolved = UI.resolveTheme();
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem('oc_theme', resolved); // 兼容旧逻辑
    const link = document.getElementById('hljs-theme');
    if (link) link.setAttribute('href', (window.API_BASE || '') + HLJS[resolved] + (window.OC_ASSET_V ? '?v=' + encodeURIComponent(window.OC_ASSET_V) : ''));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#000000' : '#ffffff');
    if (window.OCRenderer && typeof window.OCRenderer.syncMermaidTheme === 'function') {
      try { window.OCRenderer.syncMermaidTheme(); } catch (e) {}
    }
    UI.applyAppearance();
    if (typeof opts.onChange === 'function') opts.onChange(resolved);
    return resolved;
  };
  UI.initTheme = function () {
    UI.applyTheme(null);
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (UI.getPref('theme') === 'system') UI.applyTheme(null); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    }
    return UI.resolveTheme();
  };
UI.toggleTheme = function () {
    const next = UI.resolveTheme() === 'dark' ? 'light' : 'dark';
    return UI.applyTheme(next);
  };

  // ============ 外观设置:字体大小 / 字体 / 主题色 ============
  const CUSTOM_FONT_KEY = 'oc_custom_fonts'; // {name, cssText}
  const ACCENT_DEFAULT_LIGHT = '#2563eb';
  const ACCENT_VARS = [
    '--accent', '--accent-hover',
    '--brand', '--brand-hover', '--brand-soft', '--brand-soft-strong', '--ring-brand',
    '--primary', '--primary-hover',
    '--active-text', '--active-bar', '--bg-selected',
  ];

  function parseHexColor(hex) {
    const m = String(hex || '').trim().match(/^#([0-9a-fA-F]{3,8})$/);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  function hexOf(c) {
    const p = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + p(c.r) + p(c.g) + p(c.b);
  }
  function mixRgb(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
  }
  function rgbaOf(c, a) {
    const alpha = c.a == null ? a : a * c.a;
    return 'rgba(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ', ' + Math.round(alpha * 1000) / 1000 + ')';
  }
  function applyAccentVars(root, hex, isDark) {
    const c = parseHexColor(hex);
    if (!c) {
      ACCENT_VARS.forEach((k) => root.style.removeProperty(k));
      return;
    }
    const hover = isDark ? mixRgb(c, { r: 255, g: 255, b: 255 }, 0.28) : mixRgb(c, { r: 0, g: 0, b: 0 }, 0.18);
    hover.a = c.a;
    const acc = rgbaOf(c, 1);
    const hoverCss = rgbaOf(hover, 1);
    root.style.setProperty('--accent', acc);
    root.style.setProperty('--accent-hover', hoverCss);
    root.style.setProperty('--brand', acc);
    root.style.setProperty('--brand-hover', hoverCss);
    root.style.setProperty('--brand-soft', rgbaOf(c, isDark ? 0.12 : 0.08));
    root.style.setProperty('--brand-soft-strong', rgbaOf(c, isDark ? 0.2 : 0.14));
    root.style.setProperty('--ring-brand', rgbaOf(c, isDark ? 0.3 : 0.2));
    root.style.setProperty('--primary', acc);
    root.style.setProperty('--primary-hover', hoverCss);
    root.style.setProperty('--active-text', isDark ? hoverCss : acc);
    root.style.setProperty('--active-bar', acc);
    root.style.setProperty('--bg-selected', rgbaOf(c, isDark ? 0.14 : 0.07));
  }

  const FONT_RULE_ID = 'oc-font-rules';
  const CJK_UNICODE_RANGE = 'U+2E80-2EFF, U+3000-303F, U+3040-30FF, U+3100-312F, U+31A0-31BF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+20000-2FA1F';
  const LATIN_UNICODE_RANGE = 'U+0000-024F, U+0300-036F, U+0370-03FF, U+1E00-1EFF, U+1F00-1FFF, U+2000-206F, U+2070-209F, U+20A0-20CF, U+2100-214F, U+2190-21FF, U+2200-22FF, U+2300-23FF, U+2500-259F, U+25A0-25FF, U+2600-26FF, U+2700-27BF, U+2B00-2BFF, U+FB00-FB06, U+FF00-FFEF';
  const FONT_SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  function cssString(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\u0000-\u001f\u007f]/g, ' ');
  }
  function fontAsset(name) {
    try { return new URL('./static/' + name, document.baseURI).href; }
    catch (e) { return './static/' + name; }
  }
  const BUILTIN_FONT_FILES = {
    // CJK 字体是切片分包(woff2 + unicode-range),由 fonts/*.css 声明;
    // 拉丁字体为单文件 woff2。
    'source-han-serif': { css: 'fonts/SourceHanSerifCN.css' },
    'alibaba-puhuiti': { css: 'fonts/AlibabaPuHuiTi.css' },
    'times-new-roman': ['fonts/TimesNewRoman.woff2', 'woff2'],
    helvetica: ['fonts/Helvetica.woff2', 'woff2'],
    'alibaba-sans': ['fonts/AlibabaSans.woff2', 'woff2'],
  };
  const CJK_FONT_CSS_ID = 'oc-cjk-font-css';
  // 两款切片共用 TinyChat Text,只保留当前款,并让后面的本机字体规则优先。
  function ensureFontCss(key) {
    const def = BUILTIN_FONT_FILES[key];
    const href = def && def.css
      ? fontAsset(def.css) + (window.OC_ASSET_V ? '?v=' + encodeURIComponent(window.OC_ASSET_V) : '')
      : '';
    const current = document.getElementById(CJK_FONT_CSS_ID);
    if (current && current.getAttribute('href') === href) return;
    if (current) current.remove();
    if (!href) return;
    try {
      const link = document.createElement('link');
      link.id = CJK_FONT_CSS_ID;
      link.rel = 'stylesheet';
      link.href = href;
      document.head.insertBefore(link, document.getElementById(FONT_RULE_ID));
    } catch (e) { /* 注入失败时退回系统字体 */ }
  }
  // 返回 @font-face 的 src 值;切片字体返回 null(改由外部 CSS 提供 unicode-range 分片)
  function fontSource(value, kind) {
    const name = String(value == null ? '' : value).trim();
    const builtin = BUILTIN_FONT_FILES[name];
    const allowed = kind === 'cjk'
      ? name === 'source-han-serif' || name === 'alibaba-puhuiti'
      : name === 'times-new-roman' || name === 'helvetica' || name === 'alibaba-sans';
    if (builtin && allowed) {
      if (builtin.css) return null;
      return 'url("' + cssString(fontAsset(builtin[0])) + '") format("' + builtin[1] + '")';
    }
    if (name === 'system' || !name) {
      return 'local("Segoe UI"), local("PingFang SC"), local("Hiragino Sans GB"), local("Microsoft YaHei"), local("Arial")';
    }
    return 'local("' + cssString(name) + '")';
  }
  function applyFontRules(cjkValue, latinValue) {
    let styleEl = document.getElementById(FONT_RULE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = FONT_RULE_ID;
      document.head.appendChild(styleEl);
    }
    ensureFontCss(cjkValue);
    const family = 'TinyChat Text';
    const face = (src, range) => '@font-face {'
      + 'font-family:"' + family + '";font-style:normal;font-weight:200 900;font-display:swap;'
      + 'src:' + src + ';unicode-range:' + range + ';}';
    let css = '';
    const cjkSrc = fontSource(cjkValue, 'cjk');
    if (cjkSrc) css += face(cjkSrc, CJK_UNICODE_RANGE);
    const latinSrc = fontSource(latinValue, 'latin');
    if (latinSrc) css += face(latinSrc, LATIN_UNICODE_RANGE);
    styleEl.textContent = css;
  }

  // ============ 主题包(主题市场) ============
  // 目录定义在 theme-boot.js 的 OC_THEME_PACKS:它是五页首帧前唯一保证同步执行、
  // 且已持有站点基址推导的地方。首帧套用(theme-boot)与运行时切换(这里)共用同一份
  // 目录与同一套 data-oc-theme 约定,避免两处各写一份而漂移。
  const THEME_PACK_FALLBACK = [{ id: 'default', name: 'TinyChat 默认', desc: '', ownsPalette: false, css: null }];
  function themePacks() {
    const list = window.OC_THEME_PACKS;
    return (list && list.length) ? list : THEME_PACK_FALLBACK;
  }
  function themePackById(id) {
    const list = themePacks();
    const want = String(id == null ? '' : id).trim();
    for (let i = 0; i < list.length; i++) if (list[i].id === want) return list[i];
    return list[0]; // 未知 id 回落到默认:宁可退回原外观,也不能套上半截样式
  }
  UI.themePacks = themePacks;
  UI.themePack = function () { return themePackById(loadPrefs().themePack); };
  UI.themePackById = themePackById;
  // 把主题包落到 DOM:写 data-oc-theme + 按需增删样式表。
  // 幂等且不触发 applyAppearance —— 它会被 applyAppearance 反过来调用(见下方),
  // 所以这里绝不能回头再调一次,否则两者互相递归。
  // 幂等判定直接看 DOM 现状(属性值 + 样式表在不在),这样首帧由 theme-boot.js
  // 注入过的情况也能被识别为「已就位」,不会重复插入 <link>。
  function themePackCssHref(pack) {
    // 路径基准优先用 theme-boot.js 剥出的站点根(子目录部署下 /static/... 是错的);
    // 拿不到时退回 API_BASE 约定,与 applyTheme 里 HLJS 的写法保持一致。
    const base = (typeof window.OC_THEME_CSS_BASE === 'string' && window.OC_THEME_CSS_BASE)
      ? window.OC_THEME_CSS_BASE
      : (window.API_BASE || '') + '/';
    return base + pack.css + (window.OC_ASSET_V ? '?v=' + encodeURIComponent(window.OC_ASSET_V) : '');
  }
  function syncThemePackDom(pack) {
    const root = document.documentElement;
    const link = document.getElementById('oc-theme-pack-css');
    if (root.getAttribute('data-oc-theme') === pack.id && !!link === !!pack.css) return;
    root.setAttribute('data-oc-theme', pack.id);
    if (link) link.remove();
    if (pack.css) {
      const el = document.createElement('link');
      el.rel = 'stylesheet';
      el.id = 'oc-theme-pack-css';
      el.href = themePackCssHref(pack);
      // 样式表是异步加载的:紧随其后的 applyAppearance 要去读 --bg-app 定浏览器 UI 色,
      // 此刻新主题还没生效,读到的会是上一个主题的值。加载完再刷一次外观。
      // 幂等且不递归:那时 syncThemePackDom 的现状判定已命中,不会再插 <link>。
      el.addEventListener('load', () => { UI.applyAppearance(); });
      document.head.appendChild(el);
    }
  }
  // 切换主题包:先落偏好再改 DOM,保证紧随其后的 applyAppearance 读到的已是新主题。
  UI.applyThemePack = function (id, opts) {
    const pack = themePackById(id);
    if (!opts || opts.persist !== false) UI.setPref('themePack', pack.id);
    syncThemePackDom(pack);
    UI.applyAppearance();
    return pack;
  };

  // 应用外观:字号/字体/主题色 → CSS 变量
  UI.applyAppearance = function () {
    const prefs = loadPrefs();
    const root = document.documentElement;

    // 1. 字体大小:整页缩放,基准 14px = 100%
    const fs = clampInt(prefs.fontSize, 11, 22, 14);
    const zoom = Math.round((fs / 14) * 1000) / 1000;
    root.style.setProperty('--oc-font-size-msg', fs + 'px');
    root.style.setProperty('--oc-font-size-ui', fs + 'px');
    root.style.setProperty('--fs', fs + 'px');
    root.style.setProperty('--oc-ui-zoom', String(zoom));

    // 2. 中文与英文/希腊字母按 unicode-range 分流,字体未就绪时由 swap 使用系统回退。
    // 后台「内置字体默认不加载」开启时,默认值是「系统字体」(不下载内置字体);
    // 但用户若在「外观」里明确选了思源宋体等内置字体,仍按选择加载,不做硬屏蔽。
    const cjkValue = String(prefs.fontCjk == null || prefs.fontCjk === '' ? ocDefaultCjkFont() : prefs.fontCjk).trim();
    const latinValue = String(prefs.fontLatin == null || prefs.fontLatin === '' ? ocDefaultLatinFont() : prefs.fontLatin).trim();
    applyFontRules(cjkValue, latinValue);
    // 仅当选择的是内置网页字体时才把 "TinyChat Text" 放进字体栈(系统字体无需该族名)
    const usesWebfont = cjkValue === 'source-han-serif' || cjkValue === 'alibaba-puhuiti'
      || latinValue === 'alibaba-sans' || latinValue === 'times-new-roman' || latinValue === 'helvetica';
    const uiStack = (usesWebfont ? '"TinyChat Text", ' : '') + FONT_SYSTEM_STACK;
    root.style.setProperty('--oc-font-family', uiStack);
    root.style.setProperty('--oc-ui-font', uiStack);
    root.style.setProperty('--oc-latin-font', uiStack);

    // 3. 主题色:同步覆盖品牌色 / 主按钮 / 高亮,而不只改 --accent。
    //    自带完整配色的主题包(ownsPalette)必须让位:这里写的是行内样式,
    //    优先级高于主题样式表里的一切选择器,不让位就会把主题的 --brand/--primary 顶掉,
    //    表现为「换了主题但按钮还是原来的主题色」。传空串即清除这些行内覆盖。
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const pack = themePackById(prefs.themePack);
    // 主题包也在这里落 DOM:设置云同步拉回一份新偏好后,调用方只会走到 applyAppearance
    // (见 app.js 的 applySyncedSettings),不在这里同步就会出现「换了设备主题没跟着回来」。
    syncThemePackDom(pack);
    applyAccentVars(root, pack.ownsPalette ? '' : prefs.accent, isDark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      // 主题包自带配色时,浏览器 UI 色取主题的画布色(从计算样式读,避免在 JS 里再抄一份色值)
      const packBg = (pack.ownsPalette && typeof getComputedStyle === 'function')
        ? String(getComputedStyle(root).getPropertyValue('--bg-app') || '').trim()
        : '';
      const acc = parseHexColor(prefs.accent);
      meta.setAttribute('content', packBg || (acc ? hexOf(acc) : (isDark ? '#000000' : '#ffffff')));
    }
  };
  UI.defaultAccent = ACCENT_DEFAULT_LIGHT;

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  // 本地字体注册:把用户粘贴的 @font-face CSS 存起来(排版用)
  UI.registerCustomFont = function (name, cssText) {
    try {
      const map = JSON.parse(localStorage.getItem(CUSTOM_FONT_KEY) || '{}');
      map[name] = cssText;
      localStorage.setItem(CUSTOM_FONT_KEY, JSON.stringify(map));
      applyCustomFonts();
      if (window.OCSettingsSync) window.OCSettingsSync.syncFonts();
      return true;
    } catch (e) { return false; }
  };
  UI.getCustomFonts = function () {
    try { return JSON.parse(localStorage.getItem(CUSTOM_FONT_KEY) || '{}'); }
    catch (e) { return {}; }
  };
  UI.removeCustomFont = function (name) {
    try {
      const map = JSON.parse(localStorage.getItem(CUSTOM_FONT_KEY) || '{}');
      delete map[name];
      localStorage.setItem(CUSTOM_FONT_KEY, JSON.stringify(map));
      applyCustomFonts();
      if (window.OCSettingsSync) window.OCSettingsSync.syncFonts();
    } catch (e) {}
  };
  function applyCustomFonts() {
    let styleEl = document.getElementById('oc-custom-fonts');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'oc-custom-fonts';
      document.head.appendChild(styleEl);
    }
    // 自定义字体是用户自己贴的 CSS 且会同步到本人其它设备,但它会被注入到应用主文档的
    // <style> 里 —— CSS 注入在这里是真实的能力(UI 伪装、借助属性选择器探测数据)。
    // @font-face 只需要 font-family/src/format/unicode-range/字体度量这些声明,
    // 这里把能带出请求或改变行为的写法整体剥掉,再落到样式表。
    const css = Object.values(UI.getCustomFonts() || {}).join('\n')
      .replace(/@import[^;{]*(;|$)/gi, '')
      .replace(/url\s*\([^)]*\)/gi, '')
      .replace(/expression\s*\([^)]*\)/gi, '')
      .replace(/behaviou?r\s*:[^;}]*(;|$)/gi, '')
      .replace(/javascript\s*:/gi, '');
    styleEl.textContent = css;
  }
  // 初始化时应用自定义字体
  applyCustomFonts();
  // 脚本一加载就刷主题色,避免等 app.init 期间主按钮仍是默认蓝
  UI.applyAppearance();

  // —— 登录相关控件的共享实现 ——
  // 登录页(/login)与主站登录弹窗(index.html 的 auth-modal)是两套 DOM,但交互契约必须一致:
  // 密码显隐、第三方图标、切表单的动效。逻辑各写一份的结果是「弹窗里改了、登录页没改」这类
  // 只在一处复现的缺陷,所以收在这里由两边共同调用。
  UI.bindPasswordToggles = function (root) {
    const scope = root || document;
    scope.querySelectorAll('.pw-toggle').forEach(function (btn) {
      if (btn.dataset.pwBound === '1') return;   // 重复打开弹窗时不要叠加监听
      btn.dataset.pwBound = '1';
      btn.addEventListener('click', function () {
        const input = document.getElementById(btn.getAttribute('data-for'));
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
        btn.title = show ? '隐藏密码' : '显示密码';
        const off = btn.querySelector('.eye-off');
        const on = btn.querySelector('.eye-on');
        if (off) off.classList.toggle('hidden', show);
        if (on) on.classList.toggle('hidden', !show);
      });
    });
  };
  // 第三方登录图标:providers 来自 /api/config 的 oauth.providers。
  // 点击整页跳转到 /auth/<id>(第三方登录必须离开当前页),而不是 fetch —— 授权端点要靠
  // 顶层导航才能让用户看到登录界面。
  UI.renderOauthIcons = function (wrap, box, providers) {
    if (!wrap || !box) return;
    const list = Array.isArray(providers) ? providers : [];
    if (!list.length) { wrap.classList.add('hidden'); return; }
    box.innerHTML = list.map(function (p) {
      return '<button type="button" class="oauth-icon" data-oauth-go="' + UI.escapeAttr(p.id) + '" title="使用 ' + UI.escapeAttr(p.name) + ' 登录">'
        + '<img src="' + UI.escapeAttr(p.logo) + '" alt="' + UI.escapeAttr(p.name) + '" loading="lazy"></button>';
    }).join('');
    if (box.dataset.oauthBound !== '1') {
      box.dataset.oauthBound = '1';
      box.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-oauth-go]');
        if (!btn) return;
        btn.disabled = true;
        location.href = '/auth/' + encodeURIComponent(btn.getAttribute('data-oauth-go'));
      });
    }
    wrap.classList.remove('hidden');
  };
  // 开启邮箱验证后,注册接口会拒掉空邮箱(见 tc_api_register),注册表单的邮箱就从「可选」
  // 变成必填:标签去掉「(可选)」并给输入框补 required,否则用户照着「可选」留空提交,
  // 只会拿到一句后端的报错。登录页与主站登录弹窗共用这份实现 —— 两处必须同款。
  UI.applyEmailRequirement = function (labelEl, inputEl, required) {
    if (labelEl) labelEl.textContent = required ? '邮箱' : '邮箱（可选）';
    if (inputEl) inputEl.required = !!required;
  };

  window.OCUI = UI;
  window.toast = UI.toast; // 兼容既有调用(messages.js / multimodal.js)
})();


