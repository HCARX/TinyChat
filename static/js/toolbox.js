'use strict';
/**
 * toolbox.js — 在线工具箱(HTML 单页小工具)
 *
 * 侧栏「在线工具箱」入口(在「在线浏览器」下方)→ 全屏页面,自有地址 /toolbox:
 *   · 列表:我的工具(自存)与系统工具(后台维护、全员共用)两区,各带分类筛选
 *   · 编辑:名称 + 分类 + HTML 源码,可「运行预览」试跑
 *   · 预览:渲染当前 HTML,并可「在新标签页打开」
 *   · 分类管理:新建 / 重命名 / 删除自己的分类(系统分类只能由后台改)
 *
 * 数据:GET/POST /api/sync/toolbox,整份文档 + 乐观并发修订号(baseRevision)。
 * 与笔记同一套同步模型,但**不做本地持久化**:每次打开都从云端取,以避免「本地旧副本
 * 把已删除的工具复活」这类合并问题(演示号到期还原也因此天然生效)。保存失败时编辑器里
 * 的内容原样留着,不会丢。
 *
 * ⚠ 安全红线(改这个文件前必读):
 * 工具里的 HTML 是用户自己写的,服务端**不清洗**,因此它的隔离只有一条 —— 必须运行在
 * **不透明源**里。本文件里两处都不许动:
 *   1) 预览用 iframe.srcdoc + sandbox,且 sandbox 里**绝不能加 allow-same-origin**
 *      (加了它,工具就能读 localStorage 里的 oc_token,等于把账号交出去);
 *   2) 也不许加 allow-popups-to-escape-sandbox(弹窗会挣脱沙箱)。
 * 工具的内容一律用 DOM 属性赋值(iframe.srcdoc = html、textarea.value = html),
 * 绝不拼进 innerHTML —— 拼进去就成了「在本站页面里执行用户的 HTML」。
 * 系统工具与用户工具在这两点上没有任何区别:它们同样是不受信任的 HTML。
 */
(function () {
  const S = {
    ready: false, open: false,
    doc: null, revision: 0,
    sys: { cats: [], items: [] },      // 系统工具箱(只读)
    limits: {},                        // 服务端下发的各类上限
    view: 'list',                      // list | editor | preview | cats
    editingId: '',                     // 编辑中的工具 id('' = 新建)
    editingCat: '',                    // 编辑中的工具所属分类
    savedSnapshot: '',                 // 进入编辑时的内容指纹,用于「有未保存改动」判断
    previewRef: null,                  // {kind:'mine'|'sys', id} | null(草稿预览)
    previewFrom: 'list',               // 预览是从哪进来的:'list' 点卡片 | 'editor' 编辑器里的「运行预览」
    catFilter: '',                     // '' = 全部;'__none__' = 未分类;其余为分类 id
    busy: false, loading: false,
    sysHtml: {},                       // 系统工具正文: id -> Promise<string>(按需取,同会话内不重复下载)
    srcSeq: 0,                         // 取正文的序号:回来时对不上就说明用户已经走开了
    els: {}, tmpSeq: 0,
  };

  const NONE = '__none__';
  let LIMITS = { maxItems: 50, maxHtml: 200000, maxTotal: 4000000, maxCats: 50, catNameMax: 20, maxSysItems: 200 };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ============ 小工具 ============
  function icon(name, size) {
    return (window.OC && window.OC.icon) ? window.OC.icon(name, size || 15) : '';
  }
  function toast(msg, isErr) {
    if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isErr ? 'error' : undefined);
    if (typeof window.toast === 'function') return window.toast(msg, isErr);
  }
  function apiUrlOf(path) { return window.apiUrl ? window.apiUrl(path) : path; }
  function appState() { return (window.OCApp && window.OCApp.state) || null; }
  function bearerToken() {
    const s = appState();
    return (s && s.token) || localStorage.getItem('oc_token') || '';
  }
  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + bearerToken() }, opts.headers || {});
    return fetch(apiUrlOf(path), opts);
  }
  function loggedIn() {
    const s = appState();
    return !!(s && s.user);
  }
  // 总开关(匿名层,来自 /api/config 的 oc_cfg)+ 按人判定(/api/me 下发的 features)
  function enabled() {
    try {
      const cfg = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
      if (cfg && typeof cfg.toolboxEnabled === 'boolean' && !cfg.toolboxEnabled) return false;
    } catch (e) {}
    if (window.OCFeatures && !window.OCFeatures.allowed('toolbox')) return false;
    return true;
  }
  function byId(id) { return document.getElementById(id); }
  function newId() {
    S.tmpSeq += 1;
    return 't' + Date.now().toString(36) + S.tmpSeq.toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function fmtTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return '';
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function items() { return (S.doc && Array.isArray(S.doc.items)) ? S.doc.items : []; }
  function myCats() { return (S.doc && Array.isArray(S.doc.cats)) ? S.doc.cats : []; }
  function sysItems() { return Array.isArray(S.sys.items) ? S.sys.items : []; }
  function sysCats() { return Array.isArray(S.sys.cats) ? S.sys.cats : []; }
  function catName(id, kind) {
    if (!id) return '';
    const list = kind === 'sys' ? sysCats() : myCats();
    for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return String(list[i].name || '');
    return '';
  }
  // 墓碑必须是「普通对象」而不是数组:服务端空 map 可能被编码成 `[]`,而数组上挂的
  // 字符串属性会被 JSON.stringify 丢掉 —— 表现为删除动作推上去之后什么也没发生,
  // 工具过一会儿又被别的设备的旧副本合并回来。这里统一收口,不依赖服务端的编码。
  function tombs() {
    if (!S.doc) S.doc = { cats: [], items: [], tombs: {} };
    if (!S.doc.tombs || typeof S.doc.tombs !== 'object' || Array.isArray(S.doc.tombs)) S.doc.tombs = {};
    return S.doc.tombs;
  }
  function findItem(id) {
    const list = items();
    for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function findSys(id) {
    const list = sysItems();
    for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function totalChars() {
    return items().reduce((n, it) => n + String(it.html || '').length, 0);
  }
  // 一个工具该算在哪个分类下:指向已不存在的分类时按「未分类」处理(服务端刻意不校验
  // 归属,见 tc_sanitize_toolbox_row),否则删掉分类后那些工具会在界面上消失。
  function catOf(it, kind) { return catName(it && it.cat, kind) ? String(it.cat) : ''; }

  // ============ 骨架 ============
  function buildShell() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask tb-mask hidden';
    // 这里只拼静态骨架:任何来自工具的数据都走 esc() 或 DOM 属性赋值,不拼进 innerHTML
    mask.innerHTML =
      '<div class="tb-fs" role="dialog" aria-modal="true" aria-label="在线工具箱">'
      + '<header class="tb-head">'
      + '<button class="tb-brand" id="tb-brand" type="button" data-tip="返回对话首页" aria-label="返回对话首页">'
      + '<img src="./logo.svg" class="brand-logo-light" alt="TinyChat">'
      + '<img src="./logo-dark.svg" class="brand-logo-dark" alt="TinyChat">'
      + '</button>'
      + '<button class="tb-back-btn" data-act="close" type="button" data-tip="返回对话（Esc）">' + icon('chevronLeft', 14) + '<span>返回</span></button>'
      + '<span class="tb-title">' + icon('layers', 17) + '<span>在线工具箱</span></span>'
      + '<span class="tb-sub" id="tb-sub"></span>'
      + '<span class="tb-head-actions">'
      + '<button class="tb-btn" id="tb-cats" type="button" data-tip="管理我的分类">' + icon('tag', 14) + '<span>分类</span></button>'
      + '<button class="tb-btn primary" id="tb-new" type="button">' + icon('plus', 14) + '<span>新建工具</span></button>'
      + '<button class="tb-btn" id="tb-close" type="button" data-tip="关闭（Esc）" aria-label="关闭">' + icon('close', 16) + '</button>'
      + '</span>'
      + '</header>'
      + '<div class="tb-body">'
      + '<div class="tb-view" id="tb-view-list">'
      + '<div class="tb-chips" id="tb-chips"></div>'
      + '<div class="tb-sec" id="tb-sec-mine">'
      + '<div class="tb-sec-head"><span class="tb-sec-title">' + icon('folder', 14) + '<span>我的工具</span></span>'
      + '<span class="tb-sec-count" id="tb-count-mine"></span></div>'
      + '<div class="tb-grid" id="tb-grid-mine"></div>'
      + '</div>'
      + '<div class="tb-sec" id="tb-sec-sys">'
      + '<div class="tb-sec-head"><span class="tb-sec-title">' + icon('layers', 14) + '<span>系统工具</span></span>'
      + '<span class="tb-sec-hint">由管理员维护，所有人可用。可「加入我的工具箱」后再改成自己的。</span>'
      + '<span class="tb-sec-count" id="tb-count-sys"></span></div>'
      + '<div class="tb-grid" id="tb-grid-sys"></div>'
      + '</div>'
      + '</div>'
      + '<div class="tb-view hidden" id="tb-view-editor">'
      + '<div class="tb-field"><label class="tb-label" for="tb-name">名称</label>'
      + '<input class="tb-input" id="tb-name" type="text" maxlength="60" placeholder="给这个工具起个名字" autocomplete="off"></div>'
      + '<div class="tb-field"><label class="tb-label" for="tb-cat">分类<span class="tb-hint">可选，只影响分组显示</span></label>'
      + '<select class="tb-input" id="tb-cat"></select></div>'
      + '<div class="tb-field tb-field-grow"><label class="tb-label" for="tb-code">HTML 源码'
      + '<span class="tb-hint" id="tb-maxhint"></span></label>'
      + '<textarea class="tb-code" id="tb-code" spellcheck="false" wrap="off" placeholder="&lt;!doctype html&gt;&#10;&lt;html&gt;…&lt;/html&gt;"></textarea></div>'
      + '<div class="tb-editor-bar">'
      + '<span class="tb-count" id="tb-count"></span>'
      + '<span class="tb-grow"></span>'
      + '<button class="tb-btn" id="tb-cancel" type="button">取消</button>'
      + '<button class="tb-btn" id="tb-preview-run" type="button">' + icon('eye', 14) + '<span>运行预览</span></button>'
      + '<button class="tb-btn primary" id="tb-save" type="button">保存</button>'
      + '</div>'
      + '</div>'
      + '<div class="tb-view hidden" id="tb-view-preview">'
      + '<div class="tb-preview-bar">'
      + '<span class="tb-preview-name" id="tb-preview-name"></span>'
      + '<span class="tb-grow"></span>'
      + '<button class="tb-btn" id="tb-preview-back" type="button">' + icon('chevronLeft', 14) + '<span id="tb-preview-back-text">返回</span></button>'
      + '<button class="tb-btn" id="tb-preview-newtab" type="button">' + icon('link', 14) + '<span>在新标签页打开</span></button>'
      + '<button class="tb-btn" id="tb-preview-close" type="button">关闭预览</button>'
      + '</div>'
      + '<div class="tb-frame-wrap" id="tb-frame-wrap"></div>'
      + '</div>'
      + '<div class="tb-view hidden" id="tb-view-cats">'
      + '<div class="tb-cats-wrap">'
      + '<div class="tb-cats-new">'
      + '<input class="tb-input" id="tb-cat-new" type="text" placeholder="新分类名称" autocomplete="off">'
      + '<button class="tb-btn primary" id="tb-cat-add" type="button">' + icon('plus', 14) + '<span>新建分类</span></button>'
      + '</div>'
      + '<p class="tb-cats-tip">分类只属于你自己，用来给自己的工具分组；系统分类由管理员维护，不能改名或删除。'
      + '删除分类不会删除工具，里面的工具会回到「未分类」。</p>'
      + '<div class="tb-cats-list" id="tb-cats-list"></div>'
      + '</div>'
      + '</div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(mask);
    S.els.mask = mask;
    S.els.sub = mask.querySelector('#tb-sub');
    S.els.chips = mask.querySelector('#tb-chips');
    S.els.gridMine = mask.querySelector('#tb-grid-mine');
    S.els.gridSys = mask.querySelector('#tb-grid-sys');
    S.els.countMine = mask.querySelector('#tb-count-mine');
    S.els.countSys = mask.querySelector('#tb-count-sys');
    S.els.catsList = mask.querySelector('#tb-cats-list');
    S.els.catNew = mask.querySelector('#tb-cat-new');
    S.els.viewList = mask.querySelector('#tb-view-list');
    S.els.viewEditor = mask.querySelector('#tb-view-editor');
    S.els.viewPreview = mask.querySelector('#tb-view-preview');
    S.els.viewCats = mask.querySelector('#tb-view-cats');
    S.els.name = mask.querySelector('#tb-name');
    S.els.cat = mask.querySelector('#tb-cat');
    S.els.code = mask.querySelector('#tb-code');
    S.els.count = mask.querySelector('#tb-count');
    S.els.previewName = mask.querySelector('#tb-preview-name');
    S.els.previewBack = mask.querySelector('#tb-preview-back');
    S.els.previewBackText = mask.querySelector('#tb-preview-back-text');
    S.els.frameWrap = mask.querySelector('#tb-frame-wrap');
    mask.querySelector('#tb-maxhint').textContent = '整页 HTML，可含脚本与样式；最多 ' + LIMITS.maxHtml.toLocaleString() + ' 字符';

    mask.querySelector('#tb-close').addEventListener('click', close);
    mask.querySelector('#tb-brand').addEventListener('click', close);
    mask.querySelector('[data-act="close"]').addEventListener('click', close);
    mask.querySelector('#tb-new').addEventListener('click', () => startEdit(''));
    mask.querySelector('#tb-cats').addEventListener('click', () => { setView('cats'); renderCats(); });
    mask.querySelector('#tb-save').addEventListener('click', saveEdit);
    mask.querySelector('#tb-cancel').addEventListener('click', cancelEdit);
    mask.querySelector('#tb-preview-run').addEventListener('click', () => runPreview(null, ''));
    mask.querySelector('#tb-preview-back').addEventListener('click', () => setView(S.previewFrom === 'editor' ? 'editor' : 'list'));
    mask.querySelector('#tb-preview-close').addEventListener('click', () => setView(S.editingId ? 'editor' : 'list'));
    mask.querySelector('#tb-preview-newtab').addEventListener('click', openPreviewInNewTab);
    mask.querySelector('#tb-cat-add').addEventListener('click', addCategory);
    S.els.catNew.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });
    S.els.code.addEventListener('input', updateCount);
    S.els.cat.addEventListener('change', onCatSelect);
    // 分类下拉换成站内控件:原生 select 点开是操作系统的菜单,和旁边几个输入框是两套观感。
    // 换的只是外观,value / change 语义照旧(onCatSelect 仍然读 S.els.cat.value)。
    if (window.OC && typeof window.OC.enhanceSelect === 'function') {
      S.els.catBox = window.OC.enhanceSelect(S.els.cat, { className: 'tb-cat-box' });
    }
    S.els.catsList.addEventListener('click', onCatsClick);
    S.els.chips.addEventListener('click', onChipsClick);
    S.els.gridMine.addEventListener('click', onGridClick);
    S.els.gridSys.addEventListener('click', onGridClick);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    // 捕获阶段注册(与 lightbox 的 Esc 同一套做法):OCUI 的「Esc 关栈顶」是 document 冒泡,
    // 注册得比本模块早,只有在捕获阶段才抢得到这个键 —— 内层视图要自己退一步而不是整屏关掉。
    document.addEventListener('keydown', onKeydown, true);
  }

  function setView(v) {
    S.view = v;
    S.els.viewList.classList.toggle('hidden', v !== 'list');
    S.els.viewEditor.classList.toggle('hidden', v !== 'editor');
    S.els.viewPreview.classList.toggle('hidden', v !== 'preview');
    S.els.viewCats.classList.toggle('hidden', v !== 'cats');
    // 离开预览就把 iframe 拆掉,别让工具在后台继续跑(定时器/动画白占资源)
    if (v !== 'preview') S.els.frameWrap.innerHTML = '';
    if (v === 'editor') S.els.code.focus();
  }

  function renderSub() {
    const n = items().length, sn = sysItems().length;
    const kb = Math.round(totalChars() / 1024);
    S.els.sub.textContent = (n ? (n + ' 个我的工具 · 约 ' + kb + ' KB') : '')
      + (n && sn ? ' · ' : '')
      + (sn ? (sn + ' 个系统工具') : '');
  }

  // ============ 列表 ============
  function renderList() {
    const f = S.catFilter;
    const mine = items().slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const sys = sysItems().slice();
    const mineShown = mine.filter((it) => catMatch(it, 'mine', f));
    const sysShown = sys.filter((it) => catMatch(it, 'sys', f));
    S.els.gridMine.innerHTML = renderMineHtml(mineShown);
    S.els.gridSys.innerHTML = renderSysHtml(sysShown);
    S.els.countMine.textContent = mine.length ? (f ? (mineShown.length + ' / ' + mine.length) : String(mine.length)) : '';
    S.els.countSys.textContent = sys.length ? (f ? (sysShown.length + ' / ' + sys.length) : String(sys.length)) : '';
    S.els.mask.querySelector('#tb-sec-sys').classList.toggle('hidden', !sys.length);
    renderChips();
    renderSub();
  }

  // 分类筛选:系统工具按系统分类筛,我的工具按我的分类筛(两边 id 各自独立)
  function catMatch(it, kind, f) {
    if (!f) return true;
    const c = catOf(it, kind);
    if (f === NONE) return !c;
    return c === f;
  }

  function renderChips() {
    const f = S.catFilter;
    const seen = {};
    const chips = [];
    // 芯片用「我自己分类的 id + 系统分类的 id」并集。同名不合并(它们归属不同来源),
    // 但 id 相同的只出一次,免得同一条件出现两个看起来一样、点了结果也一样的芯片。
    const push = (id, name) => {
      const k = String(id);
      if (seen[k]) return;
      seen[k] = true;
      chips.push({ id: k, name: String(name) });
    };
    myCats().forEach((c) => push(c.id, c.name));
    sysCats().forEach((c) => push(c.id, c.name));
    const none = items().filter((it) => !catOf(it, 'mine')).length + sysItems().filter((it) => !catOf(it, 'sys')).length;
    let html = '<button class="tb-chip' + (f === '' ? ' on' : '') + '" type="button" data-cat="">全部</button>';
    chips.forEach((c) => {
      html += '<button class="tb-chip' + (f === c.id ? ' on' : '') + '" type="button" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</button>';
    });
    if (none) html += '<button class="tb-chip' + (f === NONE ? ' on' : '') + '" type="button" data-cat="' + NONE + '">未分类</button>';
    // 有工具归到「已删掉的分类」时,也得给个入口,否则那些工具在筛选状态下会显得凭空消失
    const dangling = {};
    items().concat(sysItems()).forEach((it) => {
      const c = String(it.cat || '');
      if (c && !catName(c, 'mine') && !catName(c, 'sys')) dangling[c] = true;
    });
    const dkeys = Object.keys(dangling);
    if (dkeys.length) {
      dkeys.forEach((id) => {
        html += '<button class="tb-chip' + (f === id ? ' on' : '') + '" type="button" data-cat="' + esc(id) + '">' + esc(id) + '（分类已删除）</button>';
      });
    }
    S.els.chips.innerHTML = html;
  }

  function onChipsClick(e) {
    const t = e.target.closest ? e.target.closest('[data-cat]') : null;
    if (!t) return;
    S.catFilter = t.getAttribute('data-cat') || '';
    renderList();
  }

  // 卡片上的体积。系统工具的正文不在列表下发里(见 sysHtmlOf),所以优先用服务端给的 size;
  // 自己的工具正文就在手上,直接用它的长度。
  function bytesOf(it) {
    if (it && typeof it.size === 'number' && it.size >= 0) return it.size;
    return String((it && it.html) || '').length;
  }

  // 系统工具的正文按需取。列表下发里刻意不带 html:重写版 12 套整页合计约 860KB(gzip 也有
  // 230KB),而列表只需要标题/分类/体积。真正要用正文的只有三处 —— 预览、查看源码、加入我的
  // 工具箱,那时按 pageUrl 取一次就好,取到的正是服务端存的同一份 HTML。同一会话内缓存,
  // 反复点不重复下载。
  function sysHtmlOf(it) {
    const id = String((it && it.id) || '');
    if (!id) return Promise.reject(new Error('这个工具没有可读取的 id'));
    if (typeof it.html === 'string' && it.html) return Promise.resolve(it.html);
    if (S.sysHtml[id]) return S.sysHtml[id];
    const url = it.pageUrl ? apiUrlOf(it.pageUrl) : '';
    if (!url) return Promise.reject(new Error('这个工具还没有可读取的地址，请刷新后重试'));
    const pr = fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((t) => (t ? t : Promise.reject(new Error('读到的内容是空的'))))
      .catch(() => { delete S.sysHtml[id]; throw new Error('读取系统工具的源码失败，请检查网络后重试'); });
    S.sysHtml[id] = pr;
    return pr;
  }

  function cardHtml(it, kind) {
    const isSys = kind === 'sys';
    const cat = isSys ? catOf(it, 'sys') : catOf(it, 'mine');
    const cname = (isSys ? catName(cat, 'sys') : catName(cat, 'mine')) || '未分类';
    const acts = isSys
      ? '<button class="tb-icon-btn" data-edit="' + esc(it.id) + '" data-kind="sys" type="button" data-tip="查看源码（只读）" aria-label="查看源码">' + icon('eye', 15) + '</button>'
        + '<button class="tb-icon-btn" data-adopt="' + esc(it.id) + '" type="button" data-tip="加入我的工具箱" aria-label="加入我的工具箱">' + icon('plus', 15) + '</button>'
        + '<button class="tb-icon-btn" data-link="' + esc(it.id) + '" data-kind="sys" type="button" data-tip="在新标签页打开" aria-label="在新标签页打开">' + icon('link', 15) + '</button>'
      : '<button class="tb-icon-btn" data-edit="' + esc(it.id) + '" data-kind="mine" type="button" data-tip="编辑" aria-label="编辑">' + icon('edit', 15) + '</button>'
        + '<button class="tb-icon-btn danger" data-del="' + esc(it.id) + '" type="button" data-tip="删除" aria-label="删除">' + icon('trash', 15) + '</button>';
    return '<div class="tb-card' + (isSys ? ' tb-card-builtin' : '') + '" data-id="' + esc(it.id) + '" data-kind="' + kind + '">'
      + '<div class="tb-card-main" data-run="' + esc(it.id) + '" data-kind="' + kind + '" role="button" tabindex="0" title="打开运行">'
      + '<span class="tb-card-ico">' + icon(isSys ? 'layers' : 'code', 18) + '</span>'
      + '<span class="tb-card-text">'
      + '<span class="tb-card-name">' + esc(it.title || '未命名工具') + '</span>'
      + '<span class="tb-card-meta">' + (isSys ? '<span class="tb-card-badge">系统</span>' : '')
      + esc(cname) + ' · ' + Math.max(1, Math.round(bytesOf(it) / 1024)) + ' KB'
      + (isSys ? '' : (' · ' + esc(fmtTime(it.updatedAt))))
      + '</span>'
      + '</span></div>'
      + '<span class="tb-card-acts">' + acts + '</span></div>';
  }

  function renderMineHtml(list) {
    let head = '<button class="tb-card tb-card-new" type="button" data-new="1">'
      + '<span class="tb-card-plus">' + icon('plus', 20) + '</span><span class="tb-card-newtxt">新建工具</span></button>';
    if (!list.length) {
      head += '<div class="tb-empty">'
        + '<p class="tb-empty-title">' + (S.catFilter ? '这个分类下还没有工具' : '工具箱还是空的') + '</p>'
        + '<p class="tb-empty-desc">' + (S.catFilter
          ? '换一个分类看看，或者点「新建工具」放一个进来。'
          : '把你写好的 HTML 单页存进来(计算器、查表、小游戏、常用代码片段…)，之后在这里一键打开。'
            + '下面还有系统自带的一批常用小工具，点「加入我的工具箱」就能改成自己的。'
            + '工具在沙箱里运行，读不到本站的登录状态。')
        + '</p></div>';
    }
    return head + list.map((it) => cardHtml(it, 'mine')).join('');
  }

  function renderSysHtml(list) {
    if (!sysItems().length) return '';
    if (!list.length) return '<div class="tb-empty"><p class="tb-empty-desc">这个分类下没有系统工具。</p></div>';
    return list.map((it) => cardHtml(it, 'sys')).join('');
  }

  function onGridClick(e) {
    const t = e.target.closest ? e.target.closest('[data-new],[data-run],[data-edit],[data-del],[data-link],[data-adopt]') : null;
    if (!t) return;
    const kind = t.getAttribute('data-kind') || 'mine';
    if (t.hasAttribute('data-new')) { startEdit(''); return; }
    if (t.hasAttribute('data-run')) { runPreview(kind, t.getAttribute('data-run')); return; }
    if (t.hasAttribute('data-del')) { deleteItem(t.getAttribute('data-del')); return; }
    if (t.hasAttribute('data-adopt')) { adoptSys(t.getAttribute('data-adopt')); return; }
    if (t.hasAttribute('data-link')) { openItemInNewTab(kind, t.getAttribute('data-link')); return; }
    if (t.hasAttribute('data-edit')) {
      const id = t.getAttribute('data-edit');
      // 系统工具只读:源码是管理员发的,前台改不了(要改就「加入我的工具箱」再改)
      if (kind === 'sys') { viewSource(id); return; }
      startEdit(id);
      return;
    }
  }

  // ============ 编辑器 ============
  function draftHtml() { return String(S.els.code.value || ''); }
  function fingerprint() { return S.els.name.value + '\u0000' + S.editingCat + '\u0000' + draftHtml(); }
  function dirty() { return S.view === 'editor' && fingerprint() !== S.savedSnapshot; }

  function updateCount() {
    S.els.count.textContent = draftHtml().length.toLocaleString() + ' / ' + LIMITS.maxHtml.toLocaleString() + ' 字符';
  }

  function renderCatSelect(sel) {
    let html = '<option value="">未分类</option>';
    myCats().forEach((c) => {
      html += '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
    });
    html += '<option value="' + NONE + '-new">＋ 新建分类…</option>';
    S.els.cat.innerHTML = html;
    S.els.cat.value = sel || '';
    if (S.els.cat.value !== (sel || '')) S.els.cat.value = '';   // 选中的分类已被删掉
    // 选项是每次重建的,站内控件显示的那行文字要跟着重读一遍
    if (S.els.catBox && S.els.catBox.syncLabel) S.els.catBox.syncLabel();
  }

  function startEdit(id, prefill) {
    const it = id ? findItem(id) : null;
    S.editingId = it ? String(it.id) : '';
    S.els.name.value = it ? String(it.title || '') : String((prefill && prefill.title) || '');
    S.editingCat = it ? String(it.cat || '') : String((prefill && prefill.cat) || '');
    // 新建给个能直接跑起来的最小骨架,省得对着空白框发呆
    S.els.code.value = it ? String(it.html || '')
      : (prefill && prefill.html ? String(prefill.html) : defaultTemplate());
    renderCatSelect(S.editingCat);
    S.savedSnapshot = fingerprint();
    updateCount();
    setView('editor');
  }

  // 「查看源码」:系统工具只读展示。仍然只用 value 赋值,不拼 innerHTML。
  function viewSource(id) {
    const it = findSys(id);
    if (!it) return;
    S.editingId = '';
    S.els.name.value = String(it.title || '');
    // 正文要现取(见 sysHtmlOf),先占位再填。快照按占位内容取一次、填完再取一次 ——
    // 中间这段时间里如果快照对不上,「有未保存改动」就会平白弹出来。
    S.els.code.value = '正在读取源码…';
    renderCatSelect('');
    S.els.name.disabled = true;
    S.els.code.readOnly = true;
    S.els.cat.disabled = true;
    S.savedSnapshot = fingerprint();
    updateCount();
    S.els.count.textContent = '系统工具（只读）';
    setView('editor');
    const seq = ++S.srcSeq;
    sysHtmlOf(it).then((html) => {
      // 取回来的路上用户可能已经点了别的:序号变了、或已经不在这个视图里,就别再往框里写
      if (seq !== S.srcSeq || S.view !== 'editor') return;
      S.els.code.value = html;
      S.savedSnapshot = fingerprint();
      updateCount();
      S.els.count.textContent = '系统工具（只读）· ' + html.length.toLocaleString() + ' 字符 · 点「取消」返回';
    }).catch((e) => {
      if (seq !== S.srcSeq || S.view !== 'editor') return;
      S.els.code.value = '';
      S.savedSnapshot = fingerprint();
      updateCount();
      toast(e.message || '读取系统工具的源码失败', true);
    });
  }

  function editableOn() {
    S.els.name.disabled = false;
    S.els.code.readOnly = false;
    S.els.cat.disabled = false;
    updateCount();
  }

  function defaultTemplate() {
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>我的小工具</title>\n<style>\n  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px; }\n  button { padding: 6px 12px; }\n</style>\n</head>\n<body>\n  <h1>你好</h1>\n  <p>这是你自己写的一页小工具。</p>\n  <button onclick="document.getElementById(\'out\').textContent = new Date().toLocaleString()">看看现在几点</button>\n  <p id="out"></p>\n</body>\n</html>\n';
  }

  function onCatSelect() {
    const v = S.els.cat.value;
    if (v !== NONE + '-new') { S.editingCat = v || ''; return; }
    S.els.cat.value = S.editingCat || '';
    addCategory().then((cat) => { if (cat) { S.editingCat = String(cat.id); renderCatSelect(S.editingCat); } });
  }

  function cancelEdit() {
    const back = () => { S.editingId = ''; editableOn(); setView('list'); renderList(); };
    if (!dirty()) { back(); return; }
    const ask = (window.OCUI && window.OCUI.confirm)
      ? window.OCUI.confirm({ title: '放弃修改', message: '这次的改动还没保存，确定放弃吗？', danger: true, confirmText: '放弃' })
      : Promise.resolve(true);
    ask.then((okFlag) => { if (okFlag) back(); });
  }

  function saveEdit() {
    if (S.busy) return;
    if (S.els.code.readOnly) { toast('系统工具是只读的，请先「加入我的工具箱」再修改', true); return; }
    const title = String(S.els.name.value || '').trim() || '未命名工具';
    const html = draftHtml();
    if (html.length > LIMITS.maxHtml) {
      toast('内容超过 ' + LIMITS.maxHtml.toLocaleString() + ' 字符上限，请精简后再保存', true);
      return;
    }
    if (!S.doc) S.doc = { cats: [], items: [], tombs: {} };
    if (!Array.isArray(S.doc.items)) S.doc.items = [];
    if (!Array.isArray(S.doc.cats)) S.doc.cats = [];
    const now = Date.now();
    const id = S.editingId || newId();
    const existing = S.editingId ? findItem(S.editingId) : null;
    // 只保留服务端认的字段:pageUrl 之类是下发投影,推回去也会被服务端丢掉,这里顺手减重
    const row = {
      id: id,
      cat: S.editingCat || '',
      title: title,
      html: html,
      createdAt: existing ? (Number(existing.createdAt) || now) : now,
      updatedAt: now,
    };
    if (existing) {
      const idx = S.doc.items.indexOf(existing);
      if (idx >= 0) S.doc.items[idx] = row;
      else S.doc.items.push(row);
    } else {
      S.doc.items.push(row);
    }
    // 同一个 id 若还留在墓碑里,得清掉,否则别的设备会把它当「已删除」过滤掉
    delete tombs()[id];
    S.editingId = id;
    S.savedSnapshot = fingerprint();
    push('已保存').then((okFlag) => {
      if (okFlag) { S.editingId = ''; editableOn(); setView('list'); renderList(); }
    });
  }

  function deleteItem(id) {
    const it = findItem(id);
    if (!it) return;
    const ask = (window.OCUI && window.OCUI.confirm)
      ? window.OCUI.confirm({ title: '删除工具', message: '确认删除「' + (it.title || '未命名工具') + '」？删除后各设备都会同步移除。', danger: true, confirmText: '删除' })
      : Promise.resolve(true);
    ask.then((okFlag) => {
      if (!okFlag) return;
      S.doc.items = items().filter((x) => String(x.id) !== String(id));
      // 墓碑:防止别的设备拿着旧副本把这个工具合并回来
      tombs()[String(id)] = Date.now();
      renderList();
      push('已删除');
    });
  }

  // 把系统工具复制一份到自己名下。分类也一并带过来(没有同名分类就在我这边建一个),
  // 否则复制过来的工具会全挤在「未分类」里。
  function adoptSys(id) {
    const it = findSys(id);
    if (!it) return;
    if (items().length >= LIMITS.maxItems) { toast('我的工具已达到 ' + LIMITS.maxItems + ' 个上限，请先删掉一些', true); return; }
    // 判重要比对正文,而正文要现取 —— 所以整段都是异步的(取回来之前不落地任何东西)
    const seq = ++S.srcSeq;
    sysHtmlOf(it).then((html) => {
      if (seq !== S.srcSeq) return;
      const dup = items().filter((x) => String(x.title || '') === String(it.title || '') && String(x.html || '') === html);
      if (dup.length) { toast('「' + (it.title || '系统工具') + '」已经在你的工具箱里了'); return; }
      const prefill = { title: it.title || '系统工具', html: html };
      const srcCat = String(it.cat || '');
      if (srcCat && catName(srcCat, 'sys')) {
        if (!catName(srcCat, 'mine')) {
          // 我的分类里还没有同名 id:直接沿用,分组看起来与系统区一致
          if (!S.doc) S.doc = { cats: [], items: [], tombs: {} };
          if (!Array.isArray(S.doc.cats)) S.doc.cats = [];
          if (S.doc.cats.length < LIMITS.maxCats) {
            S.doc.cats.push({ id: srcCat, name: catName(srcCat, 'sys') });
            prefill.cat = srcCat;
          }
        } else {
          prefill.cat = srcCat;
        }
      }
      startEdit('', prefill);
      toast('已复制到编辑器，改名或改代码后点「保存」就会加进你的工具箱');
    }).catch((e) => toast(e.message || '读取系统工具失败', true));
  }

  // ============ 预览(不透明源沙箱)============
  function runPreview(kind, id) {
    const it = (kind === 'sys') ? (id ? findSys(id) : null) : (id ? findItem(id) : null);
    if (id && !it) return;
    // 系统工具的正文要现取(见 sysHtmlOf):srcdoc 必须等正文到手再设,不能先开一个空框
    if (it && typeof it.html !== 'string') {
      const seq = ++S.srcSeq;
      toast('正在读取工具…');
      sysHtmlOf(it).then((html) => {
        if (seq !== S.srcSeq) return;
        openPreviewFrame(html, it, id, kind);
      }).catch((e) => toast(e.message || '读取系统工具失败', true));
      return;
    }
    openPreviewFrame(it ? String(it.html || '') : draftHtml(), it, id, kind);
  }

  // 站内主题(浅/深):工具页是**另一份文档**,拿不到本站的 data-theme。
  // 两条分发路径各自接上,否则深色用户点开工具会突然看见一块白底。
  function siteTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function openPreviewFrame(html, it, id, kind) {
    S.previewHtml = html;
    S.previewRef = it ? { kind: kind === 'sys' ? 'sys' : 'mine', id: String(it.id) } : null;
    // 带着 id 进来的是从列表卡片点开的,预览里的「返回」该回列表;不带 id 的是编辑器里的
    // 「运行预览」,回编辑器接着改。写死一边都会让另一边从预览里掉到错误的页面。
    S.previewFrom = id ? 'list' : 'editor';
    S.els.previewBackText.textContent = S.previewFrom === 'editor' ? '返回编辑' : '返回列表';
    S.els.previewName.textContent = it ? String(it.title || '未命名工具') : (String(S.els.name.value || '').trim() || '未保存的预览');
    const frame = document.createElement('iframe');
    // srcdoc + sandbox 是本功能唯一的安全边界:没有 allow-same-origin,这份文档就是
    // 不透明源,读不到 localStorage 里的 oc_token;没有 allow-popups-to-escape-sandbox,
    // 弹窗也挣不脱沙箱。见本文件顶部的安全红线。
    frame.className = 'tb-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', '工具预览');
    frame.srcdoc = S.previewHtml;   // 只用属性赋值,绝不拼进 innerHTML
    S.els.frameWrap.innerHTML = '';
    S.els.frameWrap.appendChild(frame);
    // 预览是 srcdoc(不是导航),页内运行时已经带主题消息监听;这里把当前主题递进去,
    // 让预览的观感与站内一致(在 iframe 的 load 之后再发,太早发文档里还没有监听者)
    frame.addEventListener('load', () => {
      try { frame.contentWindow.postMessage({ ocTheme: siteTheme() }, '*'); } catch (e) { /* 不透明源发不出也不影响使用 */ }
    });
    setView('preview');
  }

  function itemOf(kind, id) { return kind === 'sys' ? findSys(id) : findItem(id); }

  function openItemInNewTab(kind, id) {
    // 新标签页打开走服务端端点:响应头带 CSP sandbox,即使被直接导航也仍是不透明源。
    // 面板里的预览用 srcdoc(不产生可分享链接);这里才需要真实地址,靠签名 + Cookie 认人。
    const it = itemOf(kind, id);
    const base = it && it.pageUrl ? apiUrlOf(it.pageUrl) : '';
    if (!base) { toast('这个工具还没有可打开的地址，请先保存', true); return; }
    // 新标签页是**独立导航**,没有 postMessage 这条路,只能把主题写进地址(工具页会读 ?theme=)。
    // 签名只覆盖 id,多一个查询参数不影响校验。
    const url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'theme=' + siteTheme();
    const w = window.open(url, '_blank', 'noopener');
    if (!w) toast('浏览器拦截了弹窗，请允许后重试', true);
  }

  function openPreviewInNewTab() {
    // 草稿(未保存)没有签名地址;已保存的按自己的 kind/id 取地址
    if (!S.previewRef) { toast('请先保存这个工具，然后再在新标签页打开', true); return; }
    openItemInNewTab(S.previewRef.kind, S.previewRef.id);
  }

  // ============ 分类管理 ============
  function renderCats() {
    const list = myCats();
    if (!list.length) {
      S.els.catsList.innerHTML = '<div class="tb-empty"><p class="tb-empty-desc">你还没有自己的分类。'
        + '新建一个，就能把工具分组显示了。</p></div>';
    } else {
      const counts = {};
      items().forEach((it) => {
        const c = catOf(it, 'mine');
        if (c) counts[c] = (counts[c] || 0) + 1;
      });
      S.els.catsList.innerHTML = list.map((c) => {
        const n = counts[String(c.id)] || 0;
        return '<div class="tb-cat-row" data-cat-row="' + esc(c.id) + '">'
          + '<span class="tb-cat-name">' + esc(c.name) + '</span>'
          + '<span class="tb-cat-num">' + n + ' 个工具</span>'
          + '<span class="tb-grow"></span>'
          + '<button class="tb-btn" data-cat-ren="' + esc(c.id) + '" type="button">重命名</button>'
          + '<button class="tb-btn" data-cat-del="' + esc(c.id) + '" type="button">删除</button>'
          + '</div>';
      }).join('');
    }
    S.els.catNew.value = '';
    S.els.catNew.disabled = list.length >= LIMITS.maxCats;
    S.els.catNew.placeholder = list.length >= LIMITS.maxCats ? ('分类数量已达 ' + LIMITS.maxCats + ' 个上限') : '新分类名称';
    S.els.mask.querySelector('#tb-cat-add').disabled = list.length >= LIMITS.maxCats;
  }

  function addCategory() {
    const list = myCats();
    if (list.length >= LIMITS.maxCats) { toast('分类数量已达 ' + LIMITS.maxCats + ' 个上限', true); return Promise.resolve(null); }
    const input = S.view === 'cats' ? S.els.catNew : null;
    const ask = input
      ? Promise.resolve(String(input.value || '').trim())
      : ((window.OCUI && window.OCUI.prompt)
        ? window.OCUI.prompt({ title: '新建分类', message: '分类只属于你自己，用来给自己的工具分组。', maxlength: LIMITS.catNameMax, confirmText: '新建' })
        : Promise.resolve(window.prompt('新分类名称') || ''));
    return ask.then((name) => {
      const v = String(name || '').trim();
      if (!v || v === 'null') return null;
      let id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      // 与系统分类同名同 id 时沿用它的 id:这样从系统区复制过来的工具能直接归到一组
      const same = sysCats().filter((c) => String(c.name) === v);
      if (same.length && !catName(same[0].id, 'mine')) id = String(same[0].id);
      while (catName(id, 'mine')) id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (!S.doc) S.doc = { cats: [], items: [], tombs: {} };
      if (!Array.isArray(S.doc.cats)) S.doc.cats = [];
      const cat = { id: id, name: v.slice(0, LIMITS.catNameMax) };
      S.doc.cats.push(cat);
      renderCats();
      renderCatSelect(S.editingCat);
      renderList();
      push('已新建分类「' + cat.name + '」');
      return cat;
    });
  }

  function onCatsClick(e) {
    const t = e.target.closest ? e.target.closest('[data-cat-ren],[data-cat-del]') : null;
    if (!t) return;
    const id = t.getAttribute('data-cat-ren') || t.getAttribute('data-cat-del');
    if (t.hasAttribute('data-cat-ren')) {
      const cur = catName(id, 'mine');
      const ask = (window.OCUI && window.OCUI.prompt)
        ? window.OCUI.prompt({ title: '重命名分类', value: cur, maxlength: LIMITS.catNameMax, confirmText: '保存' })
        : Promise.resolve(window.prompt('新名称', cur));
      ask.then((name) => {
        const v = String(name == null ? '' : name).trim();
        if (!v || v === cur) return;
        myCats().forEach((c) => { if (String(c.id) === String(id)) c.name = v.slice(0, LIMITS.catNameMax); });
        renderCats();
        renderList();
        push('已重命名分类');
      });
      return;
    }
    // 删除分类:工具不删,只是回到「未分类」(前台显示与服务端的宽容策略一致)
    const n = items().filter((it) => catOf(it, 'mine') === String(id)).length;
    const ask2 = (window.OCUI && window.OCUI.confirm)
      ? window.OCUI.confirm({
        title: '删除分类',
        message: n ? ('删除后，里面的 ' + n + ' 个工具会回到「未分类」，工具本身不会被删除。') : '这个分类下没有工具。',
        danger: true,
        confirmText: '删除',
      })
      : Promise.resolve(true);
    ask2.then((okFlag) => {
      if (!okFlag) return;
      S.doc.cats = myCats().filter((c) => String(c.id) !== String(id));
      items().forEach((it) => { if (String(it.cat || '') === String(id)) it.cat = ''; });
      if (S.catFilter === String(id)) S.catFilter = '';
      renderCats();
      renderCatSelect(S.editingCat === String(id) ? '' : S.editingCat);
      renderList();
      push('已删除分类');
    });
  }

  // ============ 云同步 ============
  function adoptDoc(d) {
    S.doc = d || { cats: [], items: [], tombs: {} };
    if (!Array.isArray(S.doc.cats)) S.doc.cats = [];
    tombs();   // 立刻归一化,后面的写入才落在真正的对象上
  }

  function applyMeta(d) {
    if (d && d.sys && typeof d.sys === 'object') {
      S.sys = { cats: Array.isArray(d.sys.cats) ? d.sys.cats : [], items: Array.isArray(d.sys.items) ? d.sys.items : [] };
    }
    if (d && d.limits && typeof d.limits === 'object') LIMITS = Object.assign(LIMITS, d.limits);
  }

  function load() {
    if (S.loading) return Promise.resolve(false);
    S.loading = true;
    return apiFetch('/api/sync/toolbox').then((r) => r.json().then((d) => {
      if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
      adoptDoc(d.doc);
      applyMeta(d);
      S.revision = Number(d.revision) || 0;
      return true;
    })).catch((e) => {
      toast(e.message || '工具箱加载失败', true);
      return false;
    }).then((okFlag) => { S.loading = false; return okFlag; });
  }

  function push(okMsg) {
    if (S.busy) return Promise.resolve(false);
    S.busy = true;
    const body = { doc: { cats: myCats(), items: items(), tombs: tombs() }, baseRevision: S.revision };
    return apiFetch('/api/sync/toolbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((d) => {
      if (r.status === 409) {
        // 另一处已经改过云端(另一台设备 / 另一个标签页)。这里没有本地持久化可合并,
        // 直接采纳云端并告知用户,避免把两边的内容搅在一起。
        adoptDoc(d.doc);
        S.revision = Number(d.revision) || 0;
        renderList();
        toast('工具箱已在其他页面更新，已载入最新内容', true);
        return false;
      }
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      S.revision = Number(d.revision) || S.revision;
      // 采纳服务端回带的文档:本地那条是刚拼的,没有 pageUrl(签名地址在服务端算),
      // 不换过来的话「存完立刻在新标签页打开」会拿不到地址而静默失败。
      if (d.doc) adoptDoc(d.doc);
      renderSub();
      if (okMsg) toast(okMsg);
      return true;
    })).catch((e) => { toast(e.message || '保存失败', true); return false; })
      .then((okFlag) => { S.busy = false; return okFlag; });
  }

  // ============ 开合 ============
  // Esc 有三层归属,顺序不能错:
  //   1. 工具箱自己弹的确认/输入框是 modal 栈顶 → 交给 OCUI 关它自己
  //   2. 内层视图(预览 / 编辑 / 分类)→ 就地退一步,并截住事件,别让面板被整屏关掉
  //   3. 列表视图 → 不截,由 modal 栈关掉面板,_onClose 再把模块状态同步过来
  function onKeydown(e) {
    if (!S.open) return;
    if (e.key !== 'Escape') return;
    if (document.querySelector('.oc-confirm-mask:not(.hidden)')) return;
    // 站内下拉的菜单开着时,这个 Esc 归它(它的捕获监听在菜单进 DOM 时就挂上了,
    // 但注册排在本科听器之后)。这里必须让路:抢过来的话用户的 Esc 会一步退到上一个视图,
    // 菜单却还浮在上面。让路的前提是它确实接得住 —— 见 components.js 里 openSelect
    // 为何把那条监听的注册从 setTimeout 里挪出来(晚一档就成了「让路的人让了、该接的没接住」,
    // 整屏被别处的 Esc 关掉而菜单还浮着)。
    if (document.querySelector('.oc-menu')) return;
    if (S.view === 'list') return;
    e.stopImmediatePropagation();
    if (S.view === 'preview') { setView(S.previewFrom === 'editor' ? 'editor' : 'list'); return; }
    if (S.view === 'editor') { cancelEdit(); return; }
    if (S.view === 'cats') { setView('list'); renderList(); }
  }

  function isToolboxPath() {
    try { return location.pathname.replace(/\/+$/, '') === '/toolbox'; } catch (e) { return false; }
  }

  function open(opts) {
    opts = opts || {};
    if (!loggedIn()) { toast('请先登录后再使用在线工具箱', true); return; }
    if (!enabled()) { toast('本站未开放在线工具箱功能，或你的账号没有使用权限', true); return; }
    if (!S.ready) { buildShell(); S.ready = true; }
    if (S.open) return;
    S.open = true;
    const mask = S.els.mask;
    mask.classList.remove('hidden');
    mask.classList.add('show');
    if (window.OCUI) window.OCUI.openModal(mask);
    else document.body.classList.add('modal-open');
    // OCUI 的 Esc / 遮罩关闭会直接把遮罩藏掉;少了这条回调,模块自己还以为开着,
    // 再点入口就被 open() 的 `if (S.open) return` 挡住 —— 表现是「关上后再也打不开」。
    mask._onClose = () => { if (S.open) doClose(); };
    setView('list');
    renderChips();
    S.els.gridMine.innerHTML = '<div class="tb-loading">正在加载…</div>';
    S.els.gridSys.innerHTML = '';
    // 独立地址:刷新后仍停留在工具箱页(与笔记 / AI 对话页同一套约定)
    if (window.history && !isToolboxPath()) {
      try { history.pushState({ toolbox: true }, '', '/toolbox'); } catch (e) {}
    }
    load().then((okFlag) => {
      if (!S.open) return;
      if (okFlag) renderList();
      else S.els.gridMine.innerHTML = '<div class="tb-loading">加载失败，请稍后重试</div>';
    });
  }

  function close() {
    if (!S.open) return;
    if (S.view === 'editor' && dirty() && !S.els.code.readOnly) {
      const ask = (window.OCUI && window.OCUI.confirm)
        ? window.OCUI.confirm({ title: '放弃修改', message: '这次的改动还没保存，确定关闭吗？', danger: true, confirmText: '关闭' })
        : Promise.resolve(true);
      ask.then((okFlag) => { if (okFlag) doClose(); });
      return;
    }
    doClose();
  }

  function doClose() {
    S.open = false;
    S.editingId = '';
    S.catFilter = '';
    editableOn();
    const mask = S.els.mask;
    setView('list');
    if (window.OCUI) window.OCUI.closeModal(mask);
    else {
      mask.classList.remove('show');
      setTimeout(() => { if (!S.open) mask.classList.add('hidden'); }, 240);
    }
    // 返回对话首页:地址同步回根路径(仅在确实处于 /toolbox 时)
    if (isToolboxPath() && window.history) {
      try { history.pushState(null, '', '/'); } catch (e) {}
    }
  }

  function initEntry() {
    const btn = byId('toolbox-entry-btn');
    if (btn) {
      const iconEl = byId('toolbox-entry-icon');
      if (iconEl && window.OC && window.OC.icon) iconEl.innerHTML = window.OC.icon('wrench', 15);
      const apply = () => btn.classList.toggle('hidden', !enabled());
      apply();
      btn.addEventListener('click', open);
      // /api/me 带回按人判定后才广播:入口可能先渲染、权限后到(或反之),这里重判一次
      window.addEventListener('oc:features', () => {
        apply();
        if (!enabled() && S.open) doClose();
      });
    }
    // 直接访问 /toolbox(或刷新)时自动进入工具箱;登录态未就绪时等 app 初始化完再试
    if (isToolboxPath()) {
      let tries = 0;
      const boot = () => {
        tries++;
        const st = window.OCApp && window.OCApp.state;
        if (st && st.user) { open({ boot: true }); return; }
        if (tries < 40) { setTimeout(boot, 250); return; }
        // 10 秒还没等到登录态:刻意不自动开(未登录时接口会 401,开了也是空壳),
        // 但必须让用户知道发生了什么 —— 否则停在对话页,看起来像 /toolbox 这个地址坏了。
        if (!st || !st.user) toast('登录状态未就绪，工具箱暂未打开；请刷新页面或重新登录', true);
      };
      boot();
    }
    // 浏览器前进/后退:地址与模块状态保持一致
    window.addEventListener('popstate', () => {
      const shown = S.open;
      if (isToolboxPath() && !shown) open({ boot: true });
      else if (!isToolboxPath() && shown) doClose();
    });
  }

  window.OCToolbox = {
    open, close,
    isOpen: () => S.open,
    _debug: S,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEntry);
  else initEntry();
})();
