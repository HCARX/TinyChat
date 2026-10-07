'use strict';
/**
 * toolbox.js — 在线工具箱(用户自存的 HTML 单页)
 *
 * 侧栏「在线工具箱」入口(在「在线浏览器」下方)→ 近全屏弹窗:
 *   · 列表:自己存的工具卡片(名称 / 更新时间 / 打开 / 编辑 / 删除)
 *   · 编辑:标题 + HTML 源码,可「运行预览」试跑
 *   · 预览:渲染当前 HTML,并可「在新标签页打开」
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
 */
(function () {
  const S = {
    ready: false, open: false,
    doc: null, revision: 0,
    view: 'list',            // list | editor | preview
    editingId: '',           // 编辑中的工具 id('' = 新建)
    savedSnapshot: '',       // 进入编辑时的内容指纹,用于「有未保存改动」判断
    previewHtml: '',
    busy: false, loading: false,
    els: {}, tmpSeq: 0,
  };

  const MAX_HTML = 200000;   // 与服务端 TC_TOOLBOX_MAX_HTML 一致(先在本地提示,服务端仍会拦)

  // ============ 小工具 ============
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
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
  // 总开关(browserEnabled 同款的匿名层)+ 按人判定(/api/me 下发的 features)
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
  // 墓碑必须是「普通对象」而不是数组:服务端空 map 可能被编码成 `[]`,而数组上挂的
  // 字符串属性会被 JSON.stringify 丢掉 —— 表现为删除动作推上去之后什么也没发生,
  // 工具过一会儿又被别的设备的旧副本合并回来。这里统一收口,不依赖服务端的编码。
  function tombs() {
    if (!S.doc) S.doc = { items: [], tombs: {} };
    if (!S.doc.tombs || typeof S.doc.tombs !== 'object' || Array.isArray(S.doc.tombs)) S.doc.tombs = {};
    return S.doc.tombs;
  }
  function findItem(id) {
    const list = items();
    for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function totalChars() {
    return items().reduce((n, it) => n + String(it.html || '').length, 0);
  }

  // ============ 骨架 ============
  function buildShell() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask tb-mask hidden';
    // 这里只拼静态骨架:任何来自工具的数据都走 esc() 或 DOM 属性赋值,不拼进 innerHTML
    mask.innerHTML =
      '<div class="tb-fs" role="dialog" aria-modal="true" aria-label="在线工具箱">'
      + '<header class="tb-head">'
      + '<span class="tb-title">' + icon('layers', 17) + '<span>在线工具箱</span></span>'
      + '<span class="tb-sub" id="tb-sub"></span>'
      + '<span class="tb-head-actions">'
      + '<button class="tb-btn primary" id="tb-new" type="button">' + icon('plus', 14) + '<span>新建工具</span></button>'
      + '<button class="tb-btn" id="tb-close" type="button" data-tip="关闭（Esc）" aria-label="关闭">' + icon('close', 16) + '</button>'
      + '</span>'
      + '</header>'
      + '<div class="tb-body">'
      + '<div class="tb-view" id="tb-view-list"><div class="tb-grid" id="tb-grid"></div></div>'
      + '<div class="tb-view hidden" id="tb-view-editor">'
      + '<div class="tb-field"><label class="tb-label" for="tb-name">名称</label>'
      + '<input class="tb-input" id="tb-name" type="text" maxlength="60" placeholder="给这个工具起个名字" autocomplete="off"></div>'
      + '<div class="tb-field tb-field-grow"><label class="tb-label" for="tb-code">HTML 源码'
      + '<span class="tb-hint">整页 HTML,可含脚本与样式;最多 ' + MAX_HTML + ' 字符</span></label>'
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
      + '<button class="tb-btn" id="tb-preview-back" type="button">' + icon('chevronLeft', 14) + '<span>返回编辑</span></button>'
      + '<button class="tb-btn" id="tb-preview-newtab" type="button">' + icon('link', 14) + '<span>在新标签页打开</span></button>'
      + '<button class="tb-btn" id="tb-preview-close" type="button">关闭预览</button>'
      + '</div>'
      + '<div class="tb-frame-wrap" id="tb-frame-wrap"></div>'
      + '</div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(mask);
    S.els.mask = mask;
    S.els.sub = mask.querySelector('#tb-sub');
    S.els.grid = mask.querySelector('#tb-grid');
    S.els.viewList = mask.querySelector('#tb-view-list');
    S.els.viewEditor = mask.querySelector('#tb-view-editor');
    S.els.viewPreview = mask.querySelector('#tb-view-preview');
    S.els.name = mask.querySelector('#tb-name');
    S.els.code = mask.querySelector('#tb-code');
    S.els.count = mask.querySelector('#tb-count');
    S.els.previewName = mask.querySelector('#tb-preview-name');
    S.els.frameWrap = mask.querySelector('#tb-frame-wrap');

    mask.querySelector('#tb-close').addEventListener('click', close);
    mask.querySelector('#tb-new').addEventListener('click', () => startEdit(''));
    mask.querySelector('#tb-save').addEventListener('click', saveEdit);
    mask.querySelector('#tb-cancel').addEventListener('click', cancelEdit);
    mask.querySelector('#tb-preview-run').addEventListener('click', () => runPreview(null));
    mask.querySelector('#tb-preview-back').addEventListener('click', () => setView('editor'));
    mask.querySelector('#tb-preview-close').addEventListener('click', () => setView(S.editingId ? 'editor' : 'list'));
    mask.querySelector('#tb-preview-newtab').addEventListener('click', openPreviewInNewTab);
    S.els.code.addEventListener('input', updateCount);
    S.els.grid.addEventListener('click', onGridClick);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKeydown);
  }

  function setView(v) {
    S.view = v;
    S.els.viewList.classList.toggle('hidden', v !== 'list');
    S.els.viewEditor.classList.toggle('hidden', v !== 'editor');
    S.els.viewPreview.classList.toggle('hidden', v !== 'preview');
    // 离开预览就把 iframe 拆掉,别让工具在后台继续跑(定时器/动画白占资源)
    if (v !== 'preview') S.els.frameWrap.innerHTML = '';
    if (v === 'editor') S.els.code.focus();
  }

  function renderSub() {
    const n = items().length;
    const kb = Math.round(totalChars() / 1024);
    S.els.sub.textContent = n ? (n + ' 个工具 · 约 ' + kb + ' KB') : '';
  }

  // ============ 列表 ============
  function renderList() {
    S.els.grid.innerHTML = renderListHtml();
    renderSub();
  }

  function renderListHtml() {
    const list = items().slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    let head = '<button class="tb-card tb-card-new" type="button" data-new="1">'
      + '<span class="tb-card-plus">' + icon('plus', 20) + '</span><span class="tb-card-newtxt">新建工具</span></button>';
    if (!list.length) {
      head += '<div class="tb-empty">'
        + '<p class="tb-empty-title">工具箱还是空的</p>'
        + '<p class="tb-empty-desc">把你写好的 HTML 单页存进来(计算器、查表、小游戏、常用代码片段…),之后在这里一键打开。'
        + '工具在沙箱里运行,读不到本站的登录状态。</p></div>';
    }
    const cards = list.map((it) => {
      // 全部经 esc:标题是用户输入,不能直接拼进 HTML
      return '<div class="tb-card" data-id="' + esc(it.id) + '">'
        + '<div class="tb-card-main" data-run="' + esc(it.id) + '" role="button" tabindex="0" title="打开运行">'
        + '<span class="tb-card-ico">' + icon('code', 18) + '</span>'
        + '<span class="tb-card-text">'
        + '<span class="tb-card-name">' + esc(it.title || '未命名工具') + '</span>'
        + '<span class="tb-card-meta">' + esc(fmtTime(it.updatedAt)) + ' · ' + Math.max(1, Math.round(String(it.html || '').length / 1024)) + ' KB</span>'
        + '</span></div>'
        + '<span class="tb-card-acts">'
        + '<button class="tb-icon-btn" data-edit="' + esc(it.id) + '" type="button" data-tip="编辑" aria-label="编辑">' + icon('edit', 15) + '</button>'
        + '<button class="tb-icon-btn danger" data-del="' + esc(it.id) + '" type="button" data-tip="删除" aria-label="删除">' + icon('trash', 15) + '</button>'
        + '</span></div>';
    }).join('');
    return head + cards;
  }

  function onGridClick(e) {
    const t = e.target.closest ? e.target.closest('[data-new],[data-run],[data-edit],[data-del]') : null;
    if (!t) return;
    if (t.hasAttribute('data-new')) { startEdit(''); return; }
    if (t.hasAttribute('data-run')) { runPreview(t.getAttribute('data-run')); return; }
    if (t.hasAttribute('data-edit')) { startEdit(t.getAttribute('data-edit')); return; }
    if (t.hasAttribute('data-del')) { deleteItem(t.getAttribute('data-del')); }
  }

  // ============ 编辑器 ============
  function draftHtml() { return String(S.els.code.value || ''); }
  function fingerprint() { return S.els.name.value + '\u0000' + draftHtml(); }
  function dirty() { return S.view === 'editor' && fingerprint() !== S.savedSnapshot; }

  function updateCount() {
    S.els.count.textContent = draftHtml().length.toLocaleString() + ' / ' + MAX_HTML.toLocaleString() + ' 字符';
  }

  function startEdit(id) {
    const it = id ? findItem(id) : null;
    S.editingId = it ? String(it.id) : '';
    S.els.name.value = it ? String(it.title || '') : '';
    // 新建给个能直接跑起来的最小骨架,省得对着空白框发呆
    S.els.code.value = it ? String(it.html || '') : defaultTemplate();
    S.savedSnapshot = fingerprint();
    updateCount();
    setView('editor');
  }

  function defaultTemplate() {
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>我的小工具</title>\n<style>\n  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px; }\n  button { padding: 6px 12px; }\n</style>\n</head>\n<body>\n  <h1>你好</h1>\n  <p>这是你自己写的一页小工具。</p>\n  <button onclick="document.getElementById(\'out\').textContent = new Date().toLocaleString()">看看现在几点</button>\n  <p id="out"></p>\n</body>\n</html>\n';
  }

  function cancelEdit() {
    const back = () => { S.editingId = ''; setView('list'); renderList(); };
    if (!dirty()) { back(); return; }
    const ask = (window.OCUI && window.OCUI.confirm)
      ? window.OCUI.confirm({ title: '放弃修改', message: '这次的改动还没保存，确定放弃吗？', danger: true, confirmText: '放弃' })
      : Promise.resolve(true);
    ask.then((okFlag) => { if (okFlag) back(); });
  }

  function saveEdit() {
    if (S.busy) return;
    const title = String(S.els.name.value || '').trim() || '未命名工具';
    const html = draftHtml();
    if (html.length > MAX_HTML) {
      toast('内容超过 ' + MAX_HTML + ' 字符上限，请精简后再保存', true);
      return;
    }
    if (!S.doc) S.doc = { items: [], tombs: {} };
    if (!Array.isArray(S.doc.items)) S.doc.items = [];
    const now = Date.now();
    const id = S.editingId || newId();
    const existing = S.editingId ? findItem(S.editingId) : null;
    // 只保留服务端认的字段:pageUrl 之类是下发投影,推回去也会被服务端丢掉,这里顺手减重
    const row = {
      id: id,
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
      if (okFlag) { S.editingId = ''; setView('list'); renderList(); }
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

  // ============ 预览(不透明源沙箱)============
  function runPreview(id) {
    const it = id ? findItem(id) : null;
    if (id && !it) return;
    S.previewHtml = it ? String(it.html || '') : draftHtml();
    S.previewId = it ? String(it.id) : '';
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
    setView('preview');
  }

  function openPreviewInNewTab() {
    // 新标签页打开走服务端端点:响应头带 CSP sandbox,即使被直接导航也仍是不透明源。
    // 面板里的预览用 srcdoc(不产生可分享链接);这里才需要真实地址,靠签名 + Cookie 认人。
    const it = S.previewId ? findItem(S.previewId) : null;
    const url = it && it.pageUrl ? apiUrlOf(it.pageUrl) : '';
    if (!url) { toast('请先保存这个工具，然后再在新标签页打开', true); return; }
    const w = window.open(url, '_blank', 'noopener');
    if (!w) toast('浏览器拦截了弹窗，请允许后重试', true);
  }

  // ============ 云同步 ============
  function load() {
    if (S.loading) return Promise.resolve(false);
    S.loading = true;
    return apiFetch('/api/sync/toolbox').then((r) => r.json().then((d) => {
      if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
      S.doc = d.doc || { items: [], tombs: {} };
      tombs();   // 立刻归一化,后面的写入才落在真正的对象上
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
    const body = { doc: { items: items(), tombs: tombs() }, baseRevision: S.revision };
    return apiFetch('/api/sync/toolbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((d) => {
      if (r.status === 409) {
        // 另一处已经改过云端(另一台设备 / 另一个标签页)。这里没有本地持久化可合并,
        // 直接采纳云端并告知用户,避免把两边的内容搅在一起。
        S.doc = d.doc || { items: [], tombs: {} };
        tombs();
        S.revision = Number(d.revision) || 0;
        renderList();
        toast('工具箱已在其他页面更新，已载入最新内容', true);
        return false;
      }
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      S.revision = Number(d.revision) || S.revision;
      // 采纳服务端回带的文档:本地那条是刚拼的,没有 pageUrl(签名地址在服务端算),
      // 不换过来的话「存完立刻在新标签页打开」会拿不到地址而静默失败。
      if (d.doc) { S.doc = d.doc; tombs(); }
      renderSub();
      if (okMsg) toast(okMsg);
      return true;
    })).catch((e) => { toast(e.message || '保存失败', true); return false; })
      .then((okFlag) => { S.busy = false; return okFlag; });
  }

  // ============ 开关 ============
  function onKeydown(e) {
    if (!S.open) return;
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (S.view === 'preview') { setView(S.editingId ? 'editor' : 'list'); return; }
    if (S.view === 'editor') { cancelEdit(); return; }
    close();
  }

  function open() {
    if (!loggedIn()) { toast('请先登录后再使用在线工具箱', true); return; }
    if (!S.ready) { buildShell(); S.ready = true; }
    if (S.open) return;
    S.open = true;
    const mask = S.els.mask;
    mask.classList.remove('hidden');
    mask.classList.add('show');
    if (window.OCUI) window.OCUI.openModal(mask);
    else document.body.classList.add('modal-open');
    setView('list');
    S.els.grid.innerHTML = '<div class="tb-loading">正在加载…</div>';
    load().then((okFlag) => {
      if (!S.open) return;
      if (okFlag) renderList();
      else S.els.grid.innerHTML = '<div class="tb-loading">加载失败，请稍后重试</div>';
    });
  }

  function close() {
    if (!S.open) return;
    if (S.view === 'editor' && dirty()) {
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
    const mask = S.els.mask;
    setView('list');
    if (window.OCUI) window.OCUI.closeModal(mask);
    else {
      mask.classList.remove('show');
      setTimeout(() => { if (!S.open) mask.classList.add('hidden'); }, 240);
    }
  }

  function initEntry() {
    const btn = byId('toolbox-entry-btn');
    if (!btn) return;
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

  window.OCToolbox = {
    open, close,
    isOpen: () => S.open,
    _debug: S,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEntry);
  else initEntry();
})();
