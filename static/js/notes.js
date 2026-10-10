'use strict';
/**
 * notes.js — AI 笔记模块
 *  - 侧栏「AI 笔记」入口 → 近全屏三栏弹窗(文件夹树 / 笔记列表 / 编辑与预览)
 *  - Markdown 渲染复用聊天管线(renderer.js 的 OCRenderer.renderInto + .msg.assistant 结构)
 *  - 图片/附件上传(粘贴、拖拽、选择文件)→ /api/notes/upload,签名 URL 内嵌预览
 *  - 分享:仅自己可见 / 持链接查看 / 持链接可编辑(/n/{token},关闭或重新生成即失效)
 *  - AI 归档:消息操作栏「保存到 AI 笔记」→ AI 判定文件夹/标题/标签并结构化,确认后保存
 *  - 数据:本地副本走 OCStore(IndexedDB 优先,localStorage 兜底)作即时层,
 *    云端 /api/sync/notes 按 baseRevision 乐观并发同步(删除走 tombs 墓碑,与对话云同步同构)
 */
(function () {
  const UNCATA = 'uncat';  // 内部 id 保持不变(兼容已存数据),界面文案为「默认分类」
  const UNCATA_LABEL = '默认分类';
  const MODES = ['edit', 'split', 'preview'];
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  const DOC_EXT = ['pdf', 'txt', 'md', 'csv', 'json', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];

  let resolvedWarm = false;
  const N = {
    ready: false,
    _localLoaded: false,   // 本地副本是否已从 OCStore 读过(见 loadLocalDoc)
    doc: { folders: [], notes: [], tombs: {} },
    revision: 0,
    shares: [],
    userId: null,
    pushTimer: null,
    pushBusy: false,
    dirty: false,
    ui: {
      folderId: UNCATA,
      search: '',
      sort: 'updated',
      mode: 'split',
      expanded: {},
      selNoteId: null,
      mobileSide: false,   // 窄屏抽屉是否展开(不持久化,见 setMobileSide)
    },
    els: {},
    editor: null, // {noteId, ta, preview, saveTimer, renderTimer, dirty}
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
  function uid(prefix) {
    return (prefix || 'n') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function icon(name, size) {
    return (window.OC && window.OC.icon) ? window.OC.icon(name, size || 15) : '';
  }
  function toast(msg, isErr) {
    if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isErr ? 'error' : undefined);
    if (typeof window.toast === 'function') return window.toast(msg, isErr);
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtClock(ts) {
    const d = new Date(Number(ts) || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDate(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    const now = new Date();
    if (d.getFullYear() === now.getFullYear()) {
      if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return fmtClock(ts);
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    return fmtDate(ts);
  }
  function fmtFull(ts) {
    const d = new Date(Number(ts) || Date.now());
    return fmtDate(ts) + ' ' + fmtClock(ts);
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function debounce(fn, ms) {
    let t = null;
    const wrapped = function () { clearTimeout(t); t = setTimeout(fn, ms); };
    wrapped.now = function () { clearTimeout(t); fn(); };
    return wrapped;
  }
  function apiUrlOf(path) {
    return window.apiUrl ? window.apiUrl(path) : path;
  }
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

  // ============ 存储层 ============
  function lsDocKey() { return 'oc_notes_' + (N.userId || 'anon'); }
  function lsUiKey() { return 'oc_notes_ui_' + (N.userId || 'anon'); }

  function ensureUncat() {
    if (N.doc.folders.some((f) => f.id === UNCATA)) return;
    const now = Date.now();
    N.doc.folders.unshift({
      id: UNCATA, parentId: null, name: UNCATA_LABEL, description: '',
      createdAt: now, updatedAt: now, system: true,
    });
  }
  // 本地只留索引(正文不落本地)的瘦身副本:保住离线副本的骨架,云端仍是权威副本。
  // 两个入口共用它 —— set() 同步返回失败(退回 localStorage 且已满),以及
  // IndexedDB 落盘失败(异步,只能靠 onWriteFail 回调补写)。
  function slimDocPayload() {
    return {
      doc: {
        folders: N.doc.folders,
        tombs: N.doc.tombs,
        notes: N.doc.notes.map((n) => Object.assign({}, n, {
          content: '', // 正文不落本地(云端仍是权威副本)
          _localSlim: true,
        })),
      },
      revision: N.revision,
      shares: N.shares,
      _slim: true,
    };
  }
  function persistLocal() {
    const payload = { doc: N.doc, revision: N.revision, shares: N.shares };
    // OCStore 在写不进去时自己会提示一次(「本地存储已满」),这里只管换更小的副本
    if (window.OCStore.set(lsDocKey(), JSON.stringify(payload))) return;
    window.OCStore.set(lsDocKey(), JSON.stringify(slimDocPayload()));
  }
  function persistUi() {
    try { localStorage.setItem(lsUiKey(), JSON.stringify(N.ui)); } catch (e) {}
    if (window.OCSettingsSync) window.OCSettingsSync.touchUi('notesUi');
  }
  function loadLocal() {
    try {
      const raw = window.OCStore.get(lsDocKey());
      if (!raw) return false;
      const j = JSON.parse(raw);
      if (!j || !j.doc || !Array.isArray(j.doc.notes)) return false;
      N.doc = { folders: j.doc.folders || [], notes: j.doc.notes || [], tombs: j.doc.tombs || {} };
      // 本地瘦身副本(正文为空)不能当作有效内容:只保留结构,等云端拉回正文
      if (j._slim) N._localSlim = true;
      N.revision = Number(j.revision) || 0;
      N.shares = Array.isArray(j.shares) ? j.shares : [];
      ensureUncat();
      return true;
    } catch (e) { return false; }
  }
  function loadUi() {
    try {
      const raw = localStorage.getItem(lsUiKey());
      if (!raw) return;
      const j = JSON.parse(raw);
      // 只拷贝自有键:JSON.parse 出来的 "__proto__" 是自有属性,Object.assign 会经
      // [[Set]] 触发 N.ui 的原型 setter,把整个 UI 状态对象的原型换掉。
      if (j && typeof j === 'object') {
        for (const k of Object.keys(j)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          N.ui[k] = j[k];
        }
      }
    } catch (e) {}
    if (MODES.indexOf(N.ui.mode) < 0) N.ui.mode = 'split';
  }

  // 文档按条目 updatedAt 合并(新者胜),tombs 墓碑双向吸收并压制复活
  function mergeDocs(local, remote) {
    const tombs = Object.assign({}, local.tombs || {}, remote.tombs || {});
    const pick = (a, b) => ((Number(b.updatedAt) || 0) > (Number(a.updatedAt) || 0) ? b : a);
    const fMap = {};
    (local.folders || []).forEach((f) => { fMap[f.id] = f; });
    (remote.folders || []).forEach((f) => { fMap[f.id] = fMap[f.id] ? pick(fMap[f.id], f) : f; });
    const nMap = {};
    (local.notes || []).forEach((n) => { nMap[n.id] = n; });
    (remote.notes || []).forEach((n) => { nMap[n.id] = nMap[n.id] ? pick(nMap[n.id], n) : n; });
    const alive = (item) => !(item.id in tombs && Number(tombs[item.id]) >= (Number(item.updatedAt) || 0));
    return {
      folders: Object.values(fMap).filter(alive),
      notes: Object.values(nMap).filter(alive),
      tombs,
    };
  }

  function schedulePush() {
    N.dirty = true;
    clearTimeout(N.pushTimer);
    N.pushTimer = setTimeout(pushNow, 1500);
  }
  async function pushNow() {
    clearTimeout(N.pushTimer);
    if (!N.dirty || N.pushBusy || !N.userId) return;
    N.pushBusy = true;
    const baseRevision = N.revision;
    try {
      const r = await apiFetch('/api/sync/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: N.doc, baseRevision }),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        // 冲突不再静默:提示用户「已自动合并」(按条目更新时间取新)
        syncDot('conflict');
        toast('检测到其他设备的改动，已自动合并（较新的版本保留）');
        const remote = (data && data.doc) || { folders: [], notes: [], tombs: {} };
        N.doc = mergeDocs(N.doc, remote);
        N.revision = Number(data && data.revision) || N.revision;
        if (Array.isArray(data && data.shares)) N.shares = data.shares;
        ensureUncat();
        persistLocal();
        N.dirty = true;
        schedulePush(); // 以新 baseRevision 重推本地合并结果
        if (N.ready) renderAll();
      } else if (r.ok) {
        const data = await r.json().catch(() => ({}));
        N.revision = Number(data.revision) || baseRevision + 1;
        N.dirty = false;
        persistLocal();
        syncDot('ok');
        // 云同步落定:保存状态从「同步中」收敛为「已保存 HH:MM」
        if (N.editor && !N.editor.dirty) setSaveState('saved');
      } else {
        syncDot('err');
      }
    } catch (e) {
      syncDot('err');
    } finally {
      N.pushBusy = false;
    }
  }
  async function pullFromCloud() {
    try {
      const r = await apiFetch('/api/sync/notes');
      if (!r.ok) return;
      const data = await r.json().catch(() => ({}));
      if (!data || !data.doc) { N.revision = Number(data && data.revision) || 0; return; }
      const hadLocal = N.doc.notes.length > 0 || N.doc.folders.length > 1;
      N.doc = hadLocal ? mergeDocs(N.doc, data.doc) : {
        folders: Array.isArray(data.doc.folders) ? data.doc.folders : [],
        notes: Array.isArray(data.doc.notes) ? data.doc.notes : [],
        tombs: data.doc.tombs || {},
      };
      N.revision = Number(data.revision) || 0;
      N.shares = Array.isArray(data.shares) ? data.shares : [];
      ensureUncat();
      persistLocal();
      if (N.ready) renderAll();
    } catch (e) { /* 离线时继续用本地 */ }
  }

  // 所有变更经由 mutate:立即落本地 + 防抖推云端 + 重绘
  function mutate(fn, opts) {
    fn();
    invalidateSearchIndex();
    persistLocal();
    schedulePush();
    if (N.ready && !(opts && opts.noRender)) renderAll();
  }

  // ============ 数据操作 ============
  function folderById(id) { return N.doc.folders.find((f) => f.id === id) || null; }
  function noteById(id) { return N.doc.notes.find((n) => n.id === id) || null; }
  function folderName(id) { const f = folderById(id); return f ? f.name : UNCATA_LABEL; }
  function childFolders(pid) { return N.doc.folders.filter((f) => f.parentId === pid); }
  function folderDepth(id, guard) {
    guard = guard || 0;
    let d = 0;
    let cur = folderById(id);
    while (cur && cur.parentId && guard < 10) {
      d++; guard++;
      cur = folderById(cur.parentId);
    }
    return d;
  }

  function createFolder(name, parentId, opts) {
    const now = Date.now();
    const f = {
      id: uid('f'), parentId: parentId || null, name: String(name || '').trim() || '新建文件夹',
      description: '', createdAt: now, updatedAt: now,
    };
    N.doc.folders.push(f);
    if (!(opts && opts.silent)) mutate(() => {});
    return f;
  }
  function renameFolder(id, name) {
    const f = folderById(id);
    if (!f) return;
    f.name = String(name || '').trim() || f.name;
    f.updatedAt = Date.now();
    mutate(() => {});
  }
  function deleteFolder(id) {
    if (id === UNCATA) return;
    const f = folderById(id);
    if (!f) return;
    const now = Date.now();
    // 子文件夹上提一级,笔记全部落入「默认分类」
    N.doc.folders.forEach((x) => { if (x.parentId === id) { x.parentId = f.parentId || null; x.updatedAt = now; } });
    N.doc.notes.forEach((n) => { if (n.folderId === id) { n.folderId = UNCATA; n.updatedAt = now; } });
    N.doc.tombs[id] = now;
    N.doc.folders = N.doc.folders.filter((x) => x.id !== id);
    if (N.ui.folderId === id) N.ui.folderId = UNCATA;
    mutate(() => {});
    persistUi();
  }
  function createNote(folderId, data) {
    const now = Date.now();
    const n = {
      id: uid('n'),
      folderId: folderById(folderId) ? folderId : UNCATA,
      title: String((data && data.title) || '').trim() || '无标题笔记',
      content: String((data && data.content) || ''),
      tags: Array.isArray(data && data.tags) ? data.tags.filter(Boolean).slice(0, 20) : [],
      attachments: Array.isArray(data && data.attachments) ? data.attachments : [],
      isPinned: false,
      shareMode: 'private',
      shareToken: '',
      source: (data && data.source) || null,
      createdAt: now,
      updatedAt: now,
    };
    N.doc.notes.push(n);
    if (!(data && data.silent)) mutate(() => {});
    else { persistLocal(); schedulePush(); }
    return n;
  }
  function updateNote(id, patch) {
    const n = noteById(id);
    if (!n) return;
    Object.assign(n, patch, { updatedAt: Date.now() });
    mutate(() => {}, patch && patch._noRender ? { noRender: true } : undefined);
  }
  function deleteNote(id) {
    const n = noteById(id);
    if (!n) return;
    // 先回收该笔记的附件(否则文件会永久占用空间配额)
    const atts = (n.attachments || []).map((a) => a && a.id).filter(Boolean);
    const now = Date.now();
    N.doc.tombs[id] = now;
    N.doc.notes = N.doc.notes.filter((x) => x.id !== id);
    if (N.ui.selNoteId === id) { N.ui.selNoteId = null; N.editor = null; }
    mutate(() => {});
    persistUi();
    if (atts.length) deleteAttachments(atts);
  }

  // 删除附件文件(逐个;失败不阻塞删除,留给 GC 回收)
  function deleteAttachments(ids) {
    let done = 0;
    const total = ids.length;
    ids.forEach((fid) => {
      apiFetch('/api/notes/file?id=' + encodeURIComponent(fid), { method: 'DELETE' })
        .then((r) => { if (r.ok) done++; })
        .catch(() => {})
        .finally(() => {
          if (done === total) refreshUsage();
        });
    });
  }

  // 孤儿附件回收:把云端现存笔记的附件集合与服务端文件对账,清掉无主文件。
  // 节流:每 6 小时最多一次(回收本身有服务端限流)。
  function maybeGcAttachments() {
    let last = 0;
    try { last = Number(localStorage.getItem('oc_notes_gc_at') || 0); } catch (e) {}
    if (Date.now() - last < 6 * 3600 * 1000) return;
    try { localStorage.setItem('oc_notes_gc_at', String(Date.now())); } catch (e) {}
    apiFetch('/api/notes/files/gc', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.removed > 0) { refreshUsage(); }
      })
      .catch(() => {});
  }
  function togglePin(id) {
    const n = noteById(id);
    if (!n) return;
    n.isPinned = !n.isPinned;
    n.updatedAt = Date.now();
    mutate(() => {});
  }
  function moveNote(id, folderId) {
    const n = noteById(id);
    if (!n || !folderById(folderId) || n.folderId === folderId) return;
    n.folderId = folderId;
    n.updatedAt = Date.now();
    mutate(() => {});
    toast('已移动到「' + folderName(folderId) + '」');
  }

  // ============ 云端分享状态对齐(服务端为准) ============
  function shareOf(noteId) { return N.shares.find((s) => s.noteId === noteId) || null; }
  function alignShareState() {
    N.doc.notes.forEach((n) => {
      const s = shareOf(n.id);
      if (s) { n.shareMode = s.mode; n.shareToken = s.token; }
      else { n.shareMode = 'private'; n.shareToken = ''; }
    });
  }

  // ============ 模块初始化 ============
  function ensureUser() {
    const s = appState();
    const id = s && s.user && s.user.id;
    if (!id) return false;
    if (N.userId !== id) {
      N.userId = id;
      N.ready = false;
      N._localLoaded = false;
      resolvedWarm = false;
      N.doc = { folders: [], notes: [], tombs: {} };
      N.revision = 0;
      N.shares = [];
    }
    return true;
  }
  // 笔记正文可以很长(一篇几万字),本地副本放 IndexedDB:localStorage 那 5MB 装不下
  // 一个重度用户的笔记。打开库并把上个版本留在 localStorage 的旧副本迁进来,然后再读。
  async function loadLocalDoc() {
    if (N._localLoaded) return;
    N._localLoaded = true;
    if (window.OCStore) {
      try { await window.OCStore.ready([lsDocKey()]); } catch (e) { /* 退回 localStorage */ }
      // IndexedDB 落盘失败(多见于配额满)时 set() 已经同步报过成功,只能补一次瘦身重写。
      // 每次打开笔记最多补一次,避免瘦身后的失败再次触发。
      if (typeof window.OCStore.onWriteFail === 'function') {
        window.OCStore.onWriteFail((key) => {
          if (key !== lsDocKey() || N._slimRetried) return;
          N._slimRetried = true;
          try { window.OCStore.set(key, JSON.stringify(slimDocPayload())); } catch (e) { /* 忽略 */ }
        });
      }
    }
    loadLocal();
    loadUi();
  }
  async function ensureLoaded() {
    if (!ensureUser()) return false;
    await loadLocalDoc();
    if (!N.ready) {
      N.ready = true;
      alignShareState();
      pullFromCloud();
    }
    return true;
  }

  // ============ 全屏模块骨架 ============
  function buildShell() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-fs-mask hidden';
    mask.innerHTML =
      '<div class="notes-fs" role="dialog" aria-modal="true" aria-label="AI 笔记">'
      + '<header class="notes-fs-head" id="notes-fs-head">'
      + '<div class="nfh-left">'
      + '<button class="nf-brand" id="notes-brand" data-tip="返回对话首页" aria-label="返回对话首页">'
      + '<img src="./logo.svg" class="brand-logo-light" alt="TinyChat">'
      + '<img src="./logo-dark.svg" class="brand-logo-dark" alt="TinyChat">'
      + '</button>'
      + '<button class="notes-back-btn" data-act="close" data-tip="返回对话（Esc）">' + icon('chevronLeft', 14) + '<span>返回</span></button>'
      + '</div>'
      + '<div class="nfh-right">'
      // 编辑器控件压缩在顶栏(标题与下方输入区左对齐);未选中笔记时隐藏
      + '<div class="notes-editor-bar hidden" id="notes-editor-bar">'
      + '<input class="neb-title" id="ne-title" placeholder="无标题笔记" maxlength="200" spellcheck="false">'
      + '<button class="neb-folder" id="ne-folder" data-tip="移动到其他文件夹"><span id="ne-folder-name"></span>' + icon('chevronDown', 11) + '</button>'
      + '<span class="neb-time" id="ne-time">更新于 --</span>'
      + '<span class="neb-sep">·</span>'
      + '<span class="ne-save-state" id="ne-save-state">已保存</span>'
      + '<button class="neb-tags-btn" id="ne-tags-btn" data-tip="编辑标签">' + icon('tag', 13) + '<span>标签</span></button>'
      + '<button class="neb-ai-btn" id="ne-ai" data-tip="AI 全文操作">' + icon('spark', 13) + '<span>AI</span></button>'
      + '<button class="neb-ai-btn" id="ne-ask" data-tip="基于全部笔记回答问题">' + icon('search', 13) + '<span>问笔记</span></button>'
      + '<button class="notes-icon-btn" id="ne-undo" data-tip="上一步（Ctrl+Z）" aria-label="上一步">' + icon('undo', 15) + '</button>'
      + '<button class="notes-icon-btn" id="ne-redo" data-tip="下一步（Ctrl+Shift+Z）" aria-label="下一步">' + icon('redo', 15) + '</button>'
      + '<div class="notes-mode-switch" id="ne-mode-switch">'
      + '<button data-mode="edit">编辑</button>'
      + '<button data-mode="split">分屏</button>'
      + '<button data-mode="preview">预览</button>'
      + '</div>'
      + '<div class="notes-editor-toolbar">'
      + '<button class="notes-icon-btn" data-act="mdbar" data-tip="Markdown 工具栏（可拖动）">' + icon('markdown', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="image" data-tip="插入图片（也可直接粘贴 / 拖拽）">' + icon('image', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="attach" data-tip="添加附件">' + icon('paperclip', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="share" data-tip="分享设置">' + icon('link', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="export" data-tip="导出 .md">' + icon('download', 15) + '</button>'
      + '<button class="notes-icon-btn" data-act="delete" data-tip="删除笔记">' + icon('trash', 15) + '</button>'
      + '</div>'
      + '</div>'
      + '<span class="notes-sync" id="notes-sync-dot" data-tip="云同步状态"></span>'
      + '</div>'
      + '</header>'
      + '<button class="notes-side-float hidden" id="notes-side-float" data-tip="展开文件夹面板">' + icon('panelLeft', 15) + '</button>'
      + '<div class="notes-fs-body" id="notes-fs-body">'
      // 窄屏抽屉遮罩:点空白收起文件夹面板(宽屏不显示)
      + '<div class="notes-side-scrim" id="notes-side-scrim" aria-hidden="true"></div>'
      + '<aside class="notes-side" id="notes-side">'
      + '<div class="notes-side-tools">'
      + '<button class="notes-new-btn" id="notes-new-btn">' + icon('plus', 13) + '新建笔记</button>'
      + '<button class="notes-new-btn" id="notes-folder-new">' + icon('folderPlus', 14) + '新文件夹</button>'
      + '<button class="notes-icon-btn" id="notes-sort-btn" data-tip="排序">' + icon('sort', 15) + '</button>'
      + '<button class="notes-icon-btn" id="notes-side-collapse" data-tip="收起面板">' + icon('panelLeft', 15) + '</button>'
      + '</div>'
      + '<div class="notes-search">'
      + '<span class="notes-search-icon">' + icon('search', 14) + '</span>'
      + '<input id="notes-search-input" type="search" placeholder="搜索标题、内容或标签" autocomplete="off" spellcheck="false">'
      + '</div>'
      + '<div class="notes-tree" id="notes-tree"></div>'
      + '<div class="notes-usage-row">'
      + '<span class="notes-usage" id="notes-usage"></span>'
      + '<button class="notes-icon-btn notes-gear" id="notes-gear" data-tip="自定义右键菜单">' + icon('gear', 14) + '</button>'
      + '</div>'
      + '</aside>'
      + '<div class="notes-side-resizer" id="notes-side-resizer" data-tip="拖动调整宽度" aria-hidden="true"></div>'
      + '<section class="notes-editor-pane" id="notes-editor-pane"></section>'
      + '</div>'
      + '<div class="notes-upload-bar hidden" id="notes-upload-bar"></div>'
      + '</div>';
    document.body.appendChild(mask);
    N.els.mask = mask;
    N.els.head = mask.querySelector('#notes-fs-head');
    N.els.bar = mask.querySelector('#notes-editor-bar');
    N.els.tree = mask.querySelector('#notes-tree');
    N.els.editorPane = mask.querySelector('#notes-editor-pane');
    N.els.searchInput = mask.querySelector('#notes-search-input');
    N.els.syncDot = mask.querySelector('#notes-sync-dot');
    N.els.uploadBar = mask.querySelector('#notes-upload-bar');
    N.els.usage = mask.querySelector('#notes-usage');
    // 恢复上次侧栏宽度
    const savedW = parseInt(localStorage.getItem('oc_notes_side_w') || '', 10);
    if (savedW >= 200 && savedW <= 560) mask.querySelector('.notes-fs').style.setProperty('--notes-side-w', savedW + 'px');
    initSideResizer(mask);
    mask.querySelector('#notes-gear').addEventListener('click', (e) => openAiSettingsMenu(e.currentTarget));

    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) flushEditor();
    });
    // 编辑器工具栏:统一事件委托(工具栏按钮由 renderEditor 重建,委托可避免监听丢失/重复)
    const head = mask.querySelector('#notes-fs-head');
    head.addEventListener('click', (e) => {
      const b = e.target.closest('#notes-editor-bar [data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const n = N.ui.selNoteId ? noteById(N.ui.selNoteId) : null;
      if (act === 'mdbar') { toggleMdBar(b); return; }
      if (act === 'image') { pickFiles(true); return; }
      if (act === 'attach') { pickFiles(false); return; }
      if (!n) return;
      if (act === 'share') openShareDialog(n.id);
      else if (act === 'export') exportNote(noteById(n.id) || n);
      else if (act === 'delete') {
        window.OCUI.confirm({ title: '删除笔记「' + (n.title || '') + '」？', message: '删除后其他设备也会同步删除。', danger: true, confirmText: '删除' })
          .then((ok) => { if (ok) deleteNote(n.id); });
      }
    });
    // 模式切换(同样委托)
    head.addEventListener('click', (e) => {
      const b = e.target.closest('#ne-mode-switch button[data-mode]');
      if (!b) return;
      N.ui.mode = b.dataset.mode;
      persistUi();
      const panes = N.els.editorPane.querySelector('.notes-editor-panes');
      if (panes) ['edit', 'split', 'preview'].forEach((m) => panes.classList.toggle('mode-' + m, m === N.ui.mode));
      head.querySelectorAll('#ne-mode-switch button').forEach((x) => x.classList.toggle('active', x.dataset.mode === N.ui.mode));
      if (N.ui.mode !== 'edit' && N.editor) renderPreview(N.editor.ta.value);
    });
    head.addEventListener('click', (e) => {
      const b = e.target.closest('#ne-tags-btn');
      if (!b) return;
      const n = N.ui.selNoteId ? noteById(N.ui.selNoteId) : null;
      if (n) openTagsDialog(n);
    });
    head.addEventListener('click', (e) => {
      if (e.target.closest('#ne-undo')) { undo(); return; }
      if (e.target.closest('#ne-redo')) { redo(); return; }
      if (e.target.closest('#ne-ai')) { openDocAiMenu(e.target.closest('#ne-ai')); return; }
      if (e.target.closest('#ne-ask')) { openAskNotes(); return; }
      const f = e.target.closest('#ne-folder');
      if (f) {
        const n = N.ui.selNoteId ? noteById(N.ui.selNoteId) : null;
        if (n) pickFolder((ff) => moveNote(n.id, ff), n.folderId);
      }
    });
    // 右键菜单的全局收起(只注册一次;模块重开也不再重复挂)
    document.addEventListener('mousedown', (e) => {
      if (aiCtxMenu && !aiCtxMenu.contains(e.target)) closeAiCtxMenu();
    }, true);
    mask.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAiCtxMenu(); });
    mask.querySelector('[data-act="close"]').addEventListener('click', close);
    // Logo 与返回按钮一致:关闭笔记模块回到对话首页
    mask.querySelector('#notes-brand').addEventListener('click', close);
    mask.querySelector('#notes-folder-new').addEventListener('click', () => {
      // 选中普通文件夹时在其内部新建子文件夹;默认分类/根保持顶层
      const sel = folderById(N.ui.folderId);
      promptNewFolder(sel && sel.id !== UNCATA ? sel.id : null);
    });
    mask.querySelector('#notes-sort-btn').addEventListener('click', (e) => {
      const items = [
        { value: 'updated', label: '按更新时间（新→旧）' },
        { value: 'created', label: '按创建时间（新→旧）' },
        { value: 'title', label: '按标题（A→Z）' },
      ];
      window.OC.openSelect(e.currentTarget, items, {
        selected: N.ui.sort,
        onSelect: (v) => { N.ui.sort = v; persistUi(); renderTree(); },
      });
    });
    mask.querySelector('#notes-new-btn').addEventListener('click', (e) => openNewNoteDialog(e.currentTarget));
    // 仿对话首页的整栏侧栏折叠
    mask.querySelector('#notes-side-collapse').addEventListener('click', toggleSide);
    mask.querySelector('#notes-side-float').addEventListener('click', toggleSide);
    // 窄屏抽屉:点遮罩收起(宽屏该遮罩不显示)
    const scrim = mask.querySelector('#notes-side-scrim');
    if (scrim) scrim.addEventListener('click', () => setMobileSide(false));
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && N.ui.mobileSide) { e.stopPropagation(); setMobileSide(false); }
    });
    N.els.searchInput.addEventListener('input', debounce(() => {
      N.ui.search = N.els.searchInput.value.trim();
      renderTree();
    }, 160));
    // Esc 已由 modal 栈接管;Ctrl+S 手动保存
    mask.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flushEditor();
        pushNow();
        toast('已保存' + (N.dirty ? '（待同步）' : ''));
      }
    });
    applySideState();
  }

  // 侧栏整栏折叠/展开:宽屏是「收起整栏」,窄屏是「抽屉推拉」。
  // 窄屏下不能用 sideCollapsed 表达打开——CSS 里 .notes-side 在窄屏恒为
  // translateX(-100%),只有 .mobile-side-open 才把它拉回屏内;若继续复用
  // sideCollapsed,点浮标只会切换折叠类,侧栏永远停在屏外(表现为「侧栏加载不出来」)。
  function isNarrow() { return window.innerWidth <= 760; }
  function toggleSide() {
    if (isNarrow()) {
      setMobileSide(!N.ui.mobileSide);
      return;
    }
    N.ui.sideCollapsed = !N.ui.sideCollapsed;
    persistUi();
    applySideState();
  }
  // 窄屏抽屉开关(不持久化:每次进入都应是收起状态,避免恢复出半个屏幕的面板)
  function setMobileSide(open) {
    N.ui.mobileSide = !!open;
    applySideState();
  }
  function applySideState() {
    const fs = N.els.mask && N.els.mask.querySelector('.notes-fs');
    if (!fs) return;
    const narrow = isNarrow();
    // 只折叠左侧面板:编辑器区域占满剩余宽度
    fs.classList.toggle('side-collapsed', !narrow && !!N.ui.sideCollapsed);
    fs.classList.toggle('mobile-side-open', narrow && !!N.ui.mobileSide);
    const float = N.els.mask.querySelector('#notes-side-float');
    // 窄屏(抽屉式侧栏)时浮标常显,否则用户找不到目录入口;
    // 抽屉已展开时藏起来——浮标是绝对定位,不收会压在抽屉内容上。
    if (float) float.classList.toggle('hidden', narrow ? !!N.ui.mobileSide : !N.ui.sideCollapsed);
  }

  // 模块内的输入弹窗:圆角输入框、聚焦不做蓝色高亮(替代全局 OCUI.prompt)
  function notesPrompt(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask notes-prompt-mask hidden';
      mask.innerHTML =
        '<div class="modal notes-prompt-modal" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>' + esc(opts.title || '请输入') + '</h3></div>'
        + '<div class="modal-body">'
        + (opts.message ? '<p class="confirm-message">' + esc(opts.message) + '</p>' : '')
        + '<input type="text" class="notes-prompt-input" maxlength="' + (opts.maxlength || 60) + '" spellcheck="false">'
        + '</div>'
        + '<div class="modal-footer">'
        + '<button class="btn" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>'
        + '<button class="btn primary" data-act="ok">' + esc(opts.confirmText || '确定') + '</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      const input = mask.querySelector('.notes-prompt-input');
      input.value = opts.value || '';
      // settled 守卫:closeModal 会触发 _onClose,不能再进入关闭流程(否则无限递归)
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
        window.OCUI.closeModal(mask);
        setTimeout(() => mask.remove(), 340);
      };
      mask._onClose = () => finish(null);
      mask.addEventListener('click', (e) => {
        if (e.target === mask) return finish(null);
        const act = e.target.closest('[data-act]');
        if (!act) return;
        finish(act.dataset.act === 'ok' ? String(input.value).trim() : null);
      });
      mask.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); finish(String(input.value).trim()); }
      });
      if (window.OCUI) window.OCUI.openModal(mask);
      else mask.classList.add('show');
      setTimeout(() => { input.focus(); input.select(); }, 60);
    });
  }

  // 标签编辑弹窗:增删即时保存
  function openTagsDialog(n) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-tags-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-tags-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>标签</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<div class="ntags-list" id="ntags-list"></div>'
      + '<input type="text" class="notes-prompt-input" id="ntags-input" placeholder="输入标签，回车添加" maxlength="24" spellcheck="false">'
      + '</div>'
      + '<div class="modal-footer"><button class="btn primary" data-close>完成</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    let tagSettled = false;
    const closeDlg = () => {
      if (tagSettled) return;
      tagSettled = true;
      window.OCUI.closeModal(mask);
      setTimeout(() => mask.remove(), 340);
    };
    mask._onClose = closeDlg;
    mask.querySelector('[data-close]').addEventListener('click', closeDlg);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeDlg(); });
    const renderList = () => {
      const cur = noteById(n.id);
      const tags = cur ? (cur.tags || []) : [];
      const list = mask.querySelector('#ntags-list');
      list.innerHTML = tags.length
        ? tags.map((t, i) => '<span class="ne-tag" data-i="' + i + '">#' + esc(t) + '<button class="ne-tag-x" data-tip="移除标签">×</button></span>').join('')
        : '<span class="nt-none">还没有标签，回车即可添加。</span>';
      list.querySelectorAll('.ne-tag-x').forEach((x) => {
        x.addEventListener('click', () => {
          const i = Number(x.closest('.ne-tag').dataset.i);
          const c = noteById(n.id);
          if (!c) return;
          const tags = (c.tags || []).slice();
          tags.splice(i, 1);
          updateNote(n.id, { tags });
          renderList();
        });
      });
    };
    const input = mask.querySelector('#ntags-input');
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      const c = noteById(n.id);
      if (!c) return;
      const tags = (c.tags || []).slice();
      if (tags.indexOf(v) < 0) tags.push(v);
      updateNote(n.id, { tags });
      input.value = '';
      renderList();
    });
    renderList();
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    setTimeout(() => { input.focus(); }, 60);
  }

  // 侧栏左下角:附件空间剩余(配额在后台设置,0 表示不限)
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  // 侧栏拖拽调宽(与对话首页侧边栏同一套交互,宽度记忆在本地)
  function initSideResizer(root) {
    const resizer = root.querySelector('#notes-side-resizer');
    const fs = root.querySelector('.notes-fs');
    if (!resizer || !fs) return;
    const MIN = 200, MAX = 560;
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = fs.querySelector('.notes-side').getBoundingClientRect().width;
      fs.classList.add('resizing');
      const onMove = (ev) => {
        const w = Math.min(MAX, Math.max(MIN, startW + (ev.clientX - startX)));
        fs.style.setProperty('--notes-side-w', w + 'px');
      };
      const onUp = () => {
        const w = fs.querySelector('.notes-side').getBoundingClientRect().width;
        try { localStorage.setItem('oc_notes_side_w', String(Math.round(w))); } catch (err) {}
        if (window.OCSettingsSync) window.OCSettingsSync.touchUi('notesSideW');
        fs.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // 左下角齿轮:定义右键菜单里显示哪些 AI 动作
  // 内置动作提示词(自定义动作直接存完整 prompt 模板,占位符 {{text}} 为选中文字)
  const BUILTIN_ACTIONS = [
    {
      key: 'expand', label: '扩写', desc: '把选中的内容展开写详细', builtin: true,
      prompt: '请扩写下面这段内容：补充细节、背景与必要的例子，使表达更充分，但不要改变原意，也不要引入原文没有的事实。',
    },
    {
      key: 'check', label: '谬误检查', desc: '检查事实与逻辑上的问题', builtin: true,
      prompt: '请检查下面这段内容中的事实性错误、逻辑漏洞与表述不严谨之处，并给出修正后的版本：保留原有结构与有效信息，改正的问题要落实到正文里（不要只列问题清单）。',
    },
    {
      key: 'summarize', label: '总结', desc: '压缩为要点', builtin: true,
      prompt: '请把下面这段内容总结为简洁的要点：保留关键信息、结论与限制条件，删除冗余表述。',
    },
    {
      key: 'translate', label: '翻译', desc: '中→英 / 英→中 / 中英混杂→英', builtin: true,
      autoDir: true,
      prompt: '请把下面这段内容翻译成地道的{{lang}}：专有名词与技术术语保留原文（必要时括注），语气与原文一致。',
    },
    {
      key: 'dedupe', label: '降低重复率', desc: '改写去除重复表达', builtin: true,
      prompt: '请改写下面这段内容以降低重复率：合并同义表述、删除重复信息、替换冗余句式，保持原意与信息完整性不变。',
    },
  ];
  // 读取用户自定义(停用列表 + 自定义动作 + 内置动作的覆盖)
  function aiConfig() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('oc_notes_ai_cfg') || 'null'); } catch (e) {}
    const cfg = saved && typeof saved === 'object' ? saved : {};
    return {
      disabled: Array.isArray(cfg.disabled) ? cfg.disabled : [],
      custom: Array.isArray(cfg.custom) ? cfg.custom.filter((x) => x && x.key && x.label) : [],
      overrides: cfg.overrides && typeof cfg.overrides === 'object' ? cfg.overrides : {},
    };
  }
  function aiConfigSave(cfg) {
    try { localStorage.setItem('oc_notes_ai_cfg', JSON.stringify(cfg)); } catch (e) {}
    if (window.OCSettingsSync) window.OCSettingsSync.touchUi('notesAiCfg');
  }
  // 当前生效的动作列表(内置已覆盖 + 自定义,按顺序)
  function aiActions() {
    const cfg = aiConfig();
    const list = BUILTIN_ACTIONS.map((a) => {
      const ov = cfg.overrides[a.key] || {};
      return Object.assign({}, a, {
        label: ov.label || a.label,
        desc: ov.desc || a.desc,
        prompt: ov.prompt || a.prompt,
        enabled: cfg.disabled.indexOf(a.key) < 0,
      });
    });
    cfg.custom.forEach((c) => {
      list.push({
        key: c.key, label: c.label, desc: c.desc || '自定义动作', prompt: c.prompt || '{{text}}',
        custom: true, enabled: cfg.disabled.indexOf(c.key) < 0,
      });
    });
    return list;
  }
  // 兼容旧调用:启用映射
  function aiActionsEnabled() {
    const map = {};
    aiActions().forEach((a) => { map[a.key] = a.enabled; });
    return map;
  }

  // 中文占比判断:用于翻译方向(中文→英文,英文→中文,中英混杂→英文)
  function mostlyChinese(text) {
    const cn = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
    const en = (String(text).match(/[A-Za-z]/g) || []).length;
    return cn > 0 && cn * 2 >= en; // 中文占比过半 → 视为中文文本
  }
  function aiActionPrompt(action, text) {
    // 统一约束:只输出结果本身,不加解释、不加代码块围栏,便于直接插回正文
    const tail = '\n直接输出处理后的内容本身，不要任何解释、前言、编号或代码块围栏，保持 Markdown 格式。';
    let body = String((action && action.prompt) || '{{text}}');
    if (action && action.autoDir) {
      body = body.replace('{{lang}}', mostlyChinese(text) ? '英文' : '中文');
    }
    // 模板含占位符则替换,否则把原文附在末尾(自定义动作两种写法都支持)
    if (body.indexOf('{{text}}') >= 0) return body.replace('{{text}}', text) + tail;
    return body + tail + '\n\n' + text;
  }
  // ============ Markdown 工具栏(可拖动悬浮窗) ============
  // 语法动作:对选中文字加标记;无选中时插入占位文字并把占位选中,便于直接改。
  const MD_TOOLS = [
    { key: 'bold', label: '加粗', tip: '加粗 **文字**', icon: 'bold' },
    { key: 'italic', label: '倾斜', tip: '倾斜 *文字*', icon: 'italic' },
    { key: 'strike', label: '删除线', tip: '删除线 ~~文字~~', icon: 'strike' },
    { key: 'code', label: '行内代码', tip: '行内代码 `代码`', icon: 'code' },
    { key: 'h1', label: 'H1', tip: '一级标题', icon: null, textOnly: 'H1' },
    { key: 'h2', label: 'H2', tip: '二级标题', icon: null, textOnly: 'H2' },
    { key: 'h3', label: 'H3', tip: '三级标题', icon: null, textOnly: 'H3' },
    { key: 'h4', label: 'H4', tip: '四级标题', icon: null, textOnly: 'H4' },
    { key: 'h5', label: 'H5', tip: '五级标题', icon: null, textOnly: 'H5' },
    { key: 'quote', label: '引用', tip: '引用块', icon: 'quote' },
    { key: 'ul', label: '无序列表', tip: '无序列表', icon: 'listUl' },
    { key: 'ol', label: '有序列表', tip: '有序列表', icon: 'listOl' },
    { key: 'task', label: '任务列表', tip: '任务列表 - [ ]', icon: 'listTask' },
    { key: 'table', label: '表格', tip: '插入表格', icon: 'table' },
    { key: 'link', label: '链接', tip: '插入链接', icon: 'link' },
    { key: 'image', label: '图片', tip: '插入图片语法', icon: 'image' },
    { key: 'hr', label: '分隔线', tip: '插入分隔线', icon: 'minus' },
    { key: 'codeblock', label: '代码块', tip: '插入代码块', icon: 'codeBlock' },
    { key: 'formula', label: '公式', tip: '插入数学公式', icon: 'sigma' },
    { key: 'mermaid', label: '图表', tip: '插入 Mermaid 图表', icon: 'graph' },
  ];

  let mdBarEl = null;
  function mdBarPos() {
    try {
      const j = JSON.parse(localStorage.getItem('oc_notes_mdbar_pos') || 'null');
      if (j && typeof j.x === 'number' && typeof j.y === 'number') return j;
    } catch (e) {}
    return null;
  }
  function toggleMdBar(anchor) {
    if (mdBarEl) { closeMdBar(); return; }
    const el = document.createElement('div');
    el.className = 'notes-mdbar';
    el.innerHTML =
      '<div class="mdbar-head" id="mdbar-drag">'
      + icon('markdown', 13) + '<span>Markdown</span>'
      + '<span class="mdbar-hint">拖动可移动</span>'
      + '<button class="mdbar-close" data-close data-tip="关闭">' + icon('close', 13) + '</button>'
      + '</div>'
      + '<div class="mdbar-body">'
      + MD_TOOLS.map((t) => '<button class="mdbar-btn" data-md="' + t.key + '" data-tip="' + esc(t.tip) + '">'
          + (t.textOnly ? esc(t.textOnly) : icon(t.icon, 15)) + '</button>').join('')
      + '</div>';
    document.body.appendChild(el);
    // 位置:记忆优先,否则放在编辑区右上角附近
    const saved = mdBarPos();
    const r = el.getBoundingClientRect();
    let x = saved ? saved.x : (window.innerWidth - r.width - 40);
    let y = saved ? saved.y : 120;
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    mdBarEl = el;

    el.querySelector('[data-close]').addEventListener('click', (e) => { e.stopPropagation(); closeMdBar(); });
    el.querySelectorAll('[data-md]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 保住 textarea 焦点与选区
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); applyMdTool(b.dataset.md); });
    });
    initMdBarDrag(el);
    if (anchor) anchor.classList.add('active');
  }
  function closeMdBar() {
    if (!mdBarEl) return;
    mdBarEl.remove();
    mdBarEl = null;
    if (N.els.bar) {
      const b = N.els.bar.querySelector('[data-act="mdbar"]');
      if (b) b.classList.remove('active');
    }
  }
  // 拖动:按住标题区移动,松手记忆位置
  function initMdBarDrag(el) {
    const handle = el.querySelector('#mdbar-drag');
    let dragging = false, offX = 0, offY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-close]')) return;
      dragging = true;
      const r = el.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      el.classList.add('dragging');
      e.preventDefault();
    });
    const move = (e) => {
      if (!dragging) return;
      const r = el.getBoundingClientRect();
      const x = Math.max(4, Math.min(e.clientX - offX, window.innerWidth - r.width - 4));
      const y = Math.max(4, Math.min(e.clientY - offY, window.innerHeight - r.height - 4));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      try {
        localStorage.setItem('oc_notes_mdbar_pos', JSON.stringify({
          x: Math.round(el.getBoundingClientRect().left),
          y: Math.round(el.getBoundingClientRect().top),
        }));
        if (window.OCSettingsSync) window.OCSettingsSync.touchUi('notesMdbarPos');
      } catch (err) {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    el._cleanupDrag = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }

  // 应用一个 Markdown 语法动作到当前选区
  function applyMdTool(key) {
    const ta = N.editor && N.editor.ta;
    if (!ta) { toast('先打开一篇笔记', true); return; }
    ta.focus();
    const a = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    const b = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : a;
    const sel = ta.value.slice(a, b);
    const lineStart = ta.value.lastIndexOf('\n', a - 1) + 1;
    const lineEndIdx = ta.value.indexOf('\n', b);
    const lineEnd = lineEndIdx < 0 ? ta.value.length : lineEndIdx;

    // 工具:包住选区 / 前缀行 / 插入模板
    const wrap = (before, after, placeholder) => {
      const body = sel || (placeholder || '文字');
      setValue(ta.value.slice(0, a) + before + body + after + ta.value.slice(b), a + before.length, a + before.length + body.length);
    };
    const prefixLines = (prefix, placeholder) => {
      // 无选区时以当前行为目标;有选区则逐行加前缀
      const s0 = sel ? lineStart : lineStart;
      const s1 = sel ? lineEnd : lineEnd;
      const block = ta.value.slice(s0, s1) || (placeholder || '');
      const out = block.split('\n').map((ln) => prefix + ln).join('\n');
      const caret = s0 + prefix.length;
      setValue(ta.value.slice(0, s0) + out + ta.value.slice(s1), caret, caret + (block.length || 0));
    };
    const insertBlock = (text, caretOffset) => {
      const needPre = a > 0 && ta.value[a - 1] !== '\n' ? '\n\n' : '';
      const needPost = ta.value[b] && ta.value[b] !== '\n' ? '\n\n' : '\n';
      const ins = needPre + text + needPost;
      const pos = a + needPre.length + (caretOffset == null ? text.length : caretOffset);
      setValue(ta.value.slice(0, a) + ins + ta.value.slice(b), pos, pos);
    };
    const setValue = (v, selStart, selEnd) => {
      ta.value = v;
      ta.selectionStart = selStart;
      ta.selectionEnd = selEnd;
      N.editor.dirty = true;
      pushHistory({ force: true });
      renderPreview(v);
      setSaveState('editing');
      clearTimeout(N.editor.saveTimer);
      N.editor.saveTimer = setTimeout(saveEditor, 600);
    };

    if (key === 'bold') return wrap('**', '**', '加粗文字');
    if (key === 'italic') return wrap('*', '*', '倾斜文字');
    if (key === 'strike') return wrap('~~', '~~', '删除文字');
    if (key === 'code') return wrap('`', '`', 'code');
    if (/^h[1-5]$/.test(key)) {
      const lvl = Number(key.slice(1));
      const prefix = '#'.repeat(lvl) + ' ';
      // 已有标题级别则先剥掉,避免叠加
      const s0 = lineStart, s1 = lineEnd;
      const block = (ta.value.slice(s0, s1) || '标题').replace(/^#{1,6}\s*/, '');
      const out = prefix + block;
      const caret = s0 + out.length;
      return setValue(ta.value.slice(0, s0) + out + ta.value.slice(s1), caret, caret);
    }
    if (key === 'quote') return prefixLines('> ', '引用内容');
    if (key === 'ul') return prefixLines('- ', '列表项');
    if (key === 'ol') return prefixLines('1. ', '列表项');
    if (key === 'task') return prefixLines('- [ ] ', '待办事项');
    if (key === 'table') {
      return insertBlock('| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |', 2);
    }
    if (key === 'link') return wrap('[', '](https://)', sel ? '链接文字' : '链接文字');
    if (key === 'image') return insertBlock('![图片说明](图片地址)', 2);
    if (key === 'hr') return insertBlock('---', 3);
    if (key === 'codeblock') {
      const body = sel || '代码';
      return insertBlock('```\n' + body + '\n```', 3);
    }
    if (key === 'formula') return wrap('$', '$', 'x^2');
    if (key === 'mermaid') {
      return insertBlock('```mermaid\ngraph LR\n  A[开始] --> B[结束]\n```', 8);
    }
  }

  // ============ 正文选区右键:AI 编辑 ============
  // 选区先在源码里定位(sel = {start,end}),结果走对照预览;确认后替换这段选区。
  // 定位不到(preview-only)时只提供常用编辑,AI 项禁用并说明原因。
  let aiCtxMenu = null;
  function closeAiCtxMenu() {
    if (aiCtxMenu) { aiCtxMenu.remove(); aiCtxMenu = null; }
  }
  // 常用编辑(原生 textarea 能力):以一排小图标放在 AI 动作上方。
  // 「粘贴纯文本」用 navigator.clipboard.readText 过滤格式,粘贴为无格式文本。
  const CTX_TOOLS = [
    { key: 'cut', tip: '剪切', icon: 'cut' },
    { key: 'copy', tip: '复制', icon: 'copy' },
    { key: 'paste', tip: '粘贴', icon: 'clipboard' },
    { key: 'paste-plain', tip: '粘贴为纯文本', icon: 'clipboardPlain' },
    { key: 'selectall', tip: '全选', icon: 'selectAll' },
    { key: 'undo', tip: '撤销', icon: 'undo' },
    { key: 'redo', tip: '重做', icon: 'redo' },
  ];
  function runCtxTool(tool) {
    const ta = N.editor && N.editor.ta;
    if (!ta) return;
    if (tool === 'cut' || tool === 'copy') {
      const a = ta.selectionStart, b = ta.selectionEnd;
      if (a === b) { toast('先选中要' + (tool === 'cut' ? '剪切' : '复制') + '的内容'); return; }
      const sel = ta.value.slice(a, b);
      const done = () => {
        if (tool === 'cut') {
          ta.value = ta.value.slice(0, a) + ta.value.slice(b);
          ta.selectionStart = ta.selectionEnd = a;
          N.editor.dirty = true;
          pushHistory({ force: true });
          renderPreview(ta.value);
          scheduleSaveSoon();
        }
        toast(tool === 'cut' ? '已剪切' : '已复制');
      };
      if (window.OCUI && window.OCUI.copyText) {
        window.OCUI.copyText(sel).then((ok) => { if (ok) done(); else toast('复制失败', true); });
      } else {
        try { navigator.clipboard.writeText(sel).then(done); } catch (e) { toast('复制失败', true); }
      }
      return;
    }
    if (tool === 'paste' || tool === 'paste-plain') {
      const insert = (txt) => {
        const a = ta.selectionStart, b = ta.selectionEnd;
        ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b);
        ta.selectionStart = ta.selectionEnd = a + txt.length;
        N.editor.dirty = true;
        pushHistory({ force: true });
        renderPreview(ta.value);
        scheduleSaveSoon();
      };
      if (tool === 'paste-plain') {
        // 纯文本:剥掉 Markdown 结构符号与多余空行
        const plain = (raw) => String(raw)
          .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, ''))
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/^\s{0,3}#{1,6}\s+/gm, '')
          .replace(/^\s{0,3}>\s?/gm, '')
          .replace(/^\s*[-*+]\s+/gm, '')
          .replace(/[*_~`]+/g, '')
          .replace(/\n{3,}/g, '\n\n');
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((raw) => insert(plain(raw))).catch(() => {
            toast('浏览器未授权读取剪贴板，请用 Ctrl+Shift+V', true);
          });
        } else {
          toast('当前浏览器不支持，请用 Ctrl+Shift+V', true);
        }
        return;
      }
      // 普通粘贴:交给原生事件(这里显式读取剪贴板文本兜底)
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(insert).catch(() => toast('请用 Ctrl+V 粘贴', true));
      } else {
        toast('请用 Ctrl+V 粘贴', true);
      }
      return;
    }
    if (tool === 'selectall') {
      ta.focus();
      ta.selectionStart = 0;
      ta.selectionEnd = ta.value.length;
      return;
    }
    if (tool === 'undo') { undo(); return; }
    if (tool === 'redo') { redo(); return; }
  }

  function ctxToolbarHtml() {
    return '<div class="ncm-tools">' + CTX_TOOLS.map((t) =>
      '<button class="ncm-tool" data-tool="' + t.key + '" data-tip="' + esc(t.tip) + '" aria-label="' + esc(t.tip) + '">'
      + icon(t.icon, 14) + '</button>').join('') + '</div>';
  }

  function openAiCtxMenu(x, y, text, sel) {
    closeAiCtxMenu();
    // sel: 源码中的 [start,end) 区间;end === 'preview-only' 表示定位失败
    const previewOnly = sel === 'preview-only';
    const acts = previewOnly ? [] : aiActions().filter((a) => a.enabled);
    const menu = document.createElement('div');
    menu.className = 'notes-ctx-menu';
    menu.innerHTML = ctxToolbarHtml()
      + '<div class="ncm-sep"></div>'
      + (acts.length
        ? '<div class="ncm-head">AI 编辑</div>'
          + acts.map((a) => '<button class="ncm-item" data-ai="' + a.key + '"><span>' + esc(a.label) + '</span><i>' + esc(a.desc) + '</i></button>').join('')
        : '<div class="ncm-empty">' + (previewOnly
            ? '这段文字未能在源码中定位（可能跨了格式标记），请在编辑区选中后使用 AI 编辑。'
            : '没有启用的动作。点左下角齿轮添加或启用。') + '</div>');
    document.body.appendChild(menu);
    menu.querySelectorAll('[data-tool]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 保住输入框焦点与选区
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAiCtxMenu();
        runCtxTool(b.dataset.tool);
      });
    });
    // 视口内定位(靠近边缘时自动内收)
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    aiCtxMenu = menu;
    menu.querySelectorAll('[data-ai]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAiCtxMenu();
        runAiEdit(b.dataset.ai, text, sel);
      });
    });
  }

  async function runAiEdit(key, text, sel) {
    if (!window.OCApp || !window.OCApp.aiComplete) { toast('AI 能力尚未就绪，请刷新页面', true); return; }
    const noteId = N.editor && N.editor.noteId;
    const n = noteById(noteId);
    if (!n) return;
    const act = aiActions().find((a) => a.key === key);
    const label = act ? act.label : 'AI 编辑';
    const busy = showAiBusy(label);
    try {
      const out = await aiRun('note-edit', [
        { role: 'system', content: '你是严谨的中文写作助手。只按用户要求处理文本并直接输出结果，不要解释过程。' },
        { role: 'user', content: aiActionPrompt(act, text) },
      ], 4096);
      const clean = String(out || '').trim().replace(/^```[a-zA-Z]*\n?|\n?```$/g, '').trim();
      if (!clean) throw new Error('模型没有返回内容');
      // 先预览对照,确认后才替换 —— 改写是破坏性的,不给后悔机会比直接插入安全得多
      showAiDiff({
        title: label + '预览',
        oldHead: '修改前（选中内容）',
        oldText: text,
        newHead: '修改后',
        newText: clean,
        applyLabel: '替换选中内容',
        apply: () => {
          const ta = N.editor && N.editor.ta;
          if (!ta) return;
          const at = sel && typeof sel.start === 'number' ? sel.start : null;
          const en = sel && typeof sel.end === 'number' ? sel.end : null;
          // 选中区间在预览期间若已变化(极端情况),退回光标处插入,避免错位覆盖
          if (at === null || en === null || ta.value.slice(at, en) !== text) {
            insertAtCursor(clean, ta.selectionEnd);
          } else {
            replaceRange(at, en, clean);
          }
          toast(label + '完成（可 Ctrl+Z 撤销）');
        },
      });
    } catch (e) {
      toast('AI 编辑失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
      setSaveState('editing');
    }
  }

  // 用 text 替换源码 [start,end) 区间,并把光标落到替换内容之后
  function replaceRange(start, end, text) {
    const ta = N.editor && N.editor.ta;
    if (!ta) return;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    N.editor.dirty = true;
    pushHistory({ force: true });
    renderPreview(ta.value);
    scheduleSaveSoon();
  }

  // 在指定位置插入文本,并把光标移到插入内容之后
  function insertAtCursor(text, at) {
    const ta = N.editor && N.editor.ta;
    if (!ta) return;
    const pos = typeof at === 'number' ? at : (ta.selectionEnd || ta.value.length);
    ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + text.length;
    N.editor.dirty = true;
    pushHistory({ force: true });
    renderPreview(ta.value);
    scheduleSaveSoon();
  }
  function scheduleSaveSoon() {
    if (!N.editor) return;
    clearTimeout(N.editor.saveTimer);
    N.editor.saveTimer = setTimeout(saveEditor, 500);
  }
  // ============ AI 扩展能力 ============
  // 统一的 AI 取用入口:先扣每日配额(后端),再调用补全,避免被当作免费 LLM 通道
  async function aiRun(purpose, messages, maxTokens) {
    const r = await apiFetch('/api/notes/ai/consume', { method: 'POST' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error((d.error && d.error.message) || '今日 AI 次数不足');
    }
    const out = await window.OCApp.aiComplete(messages, { purpose: purpose, maxTokens: maxTokens || 4096 });
    refreshUsage();
    return out;
  }
  function stripFence(t) {
    return String(t || '').trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  // ---- 建议1:全文 AI 动作 ----
  function openDocAiMenu(anchor) {
    const items = [
      { value: 'outline', label: '生成大纲 · 提取小标题层级' },
      { value: 'todos', label: '提取待办 · 汇总为任务列表' },
      { value: 'summary', label: '写入摘要 · 追加到正文开头' },
      { value: 'tags', label: '推荐标签 · 自动补充标签' },
      { value: 'tidy', label: '自动整理 · 重排结构（预览后应用）' },
      { value: 'links', label: '双链图谱 · 生成 Mermaid 关系图' },
      { value: 'digest', label: '生成日报 · 汇总近 24 小时更新的笔记' },
      { value: 'versions', label: '历史版本 · 查看并恢复本机留档' },
    ];
    window.OC.openSelect(anchor, items, {
      fitWidth: true,
      onSelect: (v) => runDocAi(v),
    });
  }
  async function runDocAi(kind) {
    if (kind === 'digest') { void runDailyDigest(); return; }
    if (kind === 'versions') {
      const noteForVer = noteById(N.ui.selNoteId);
      if (noteForVer) openVersionHistory(noteForVer);
      return;
    }
    const n = noteById(N.ui.selNoteId);
    if (!n || !N.editor) return;
    const text = N.editor.ta.value || '';
    if (!text.trim()) { toast('笔记还是空的，先写点内容吧', true); return; }
    const busy = showAiBusy(DOC_AI_LABEL[kind] || '处理');
    try {
      if (kind === 'tags') {
        const out = await aiRun('note-tags', [
          { role: 'system', content: '你是笔记助手。只输出 3-6 个简短中文标签，用中文逗号分隔，不要解释。' },
          { role: 'user', content: '为下面这篇笔记推荐标签：\n\n' + text.slice(0, 6000) },
        ], 200);
        const tags = stripFence(out).split(/[,，、\n]/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean).slice(0, 8);
        if (!tags.length) throw new Error('没有解析出标签');
        const cur = noteById(n.id);
        const merged = Array.from(new Set(((cur && cur.tags) || []).concat(tags))).slice(0, 20);
        updateNote(n.id, { tags: merged });
        toast('已补充标签：' + tags.join('、'));
        return;
      }
      const prompts = {
        outline: '请为下面这篇笔记生成层级大纲：用 Markdown 无序列表输出 2 层，覆盖全文要点，不要解释。',
        todos: '请从下面这篇笔记里提取所有待办事项，输出 Markdown 任务列表（- [ ] 事项），注明负责人与时间（若有），不要解释。',
        summary: '请为下面这篇笔记写一段 100 字以内的摘要，直接输出摘要正文（不要「摘要：」前缀）。',
        tidy: '请重排下面这篇笔记的结构：补齐小标题、把并列信息改成列表、合并重复段落，保留全部事实与代码。直接输出整理后的完整 Markdown 全文。',
        links: '请分析下面这篇笔记涉及的核心概念及其关系，输出一个 Mermaid 代码块（graph LR，节点用中文短语，最多 12 个节点），不要解释。',
      };
      const out = await aiRun('note-doc', [
        { role: 'system', content: '你是严谨的中文写作助手。只输出要求的内容本身，不要任何解释或额外前言。' },
        { role: 'user', content: prompts[kind] + '\n\n' + text.slice(0, 12000) },
      ], kind === 'tidy' ? 8192 : 2048);
      const clean = stripFence(out);
      if (!clean) throw new Error('模型没有返回内容');
      if (kind === 'tidy') { showTidyPreview(n, clean); return; }
      // 写入摘要 / 大纲 / 待办 / 双链都会改写整篇正文:先预览对照再应用
      const cur = noteById(n.id);
      const base = cur ? cur.content : text;
      let next = '';
      let applyLabel = '应用';
      if (kind === 'summary') {
        next = '> **摘要**：' + clean.replace(/\n+/g, ' ').trim() + '\n\n' + base;
        applyLabel = '写入摘要';
      } else {
        next = base + '\n\n## ' + (DOC_AI_HEAD[kind] || 'AI 生成') + '\n\n' + clean + '\n';
        applyLabel = (DOC_AI_LABEL[kind] || 'AI') + '结果追加到文末';
      }
      showAiDiff({
        title: (DOC_AI_LABEL[kind] || 'AI') + '预览',
        oldText: base,
        newText: next,
        applyLabel: applyLabel,
        apply: () => {
          const c = noteById(n.id);
          updateNote(n.id, { content: kind === 'summary'
            ? '> **摘要**：' + clean.replace(/\n+/g, ' ').trim() + '\n\n' + (c ? c.content : base)
            : (c ? c.content : base) + '\n\n## ' + (DOC_AI_HEAD[kind] || 'AI 生成') + '\n\n' + clean + '\n' });
          saveEditorSoon(n.id);
          toast((DOC_AI_LABEL[kind] || 'AI') + '已完成（可 Ctrl+Z 撤销）');
        },
      });
    } catch (e) {
      toast('AI 操作失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
    }
  }
  const DOC_AI_LABEL = { outline: '生成大纲', todos: '提取待办', summary: '写入摘要', tags: '推荐标签', tidy: '自动整理', links: '生成双链图谱', digest: '生成日报' };
  const DOC_AI_HEAD = { outline: '大纲', todos: '待办事项', links: '概念关系图' };
  // 把更新后的内容灌回编辑器并触发保存(不重渲染编辑器,避免打断光标)
  function saveEditorSoon(noteId) {
    if (!N.editor || N.editor.noteId !== noteId) { renderEditor(); return; }
    const cur = noteById(noteId);
    if (!cur) return;
    const ti = N.els.bar.querySelector('#ne-title');
    if (ti && ti.value !== cur.title) ti.value = cur.title;
    N.editor.ta.value = cur.content;
    N.editor.dirty = true;
    pushHistory({ force: true });
    renderPreview(cur.content);
    setSaveState('editing');
    clearTimeout(N.editor.saveTimer);
    N.editor.saveTimer = setTimeout(saveEditor, 400);
    renderTree();
  }

  // AI 改写对照预览:左「修改前」右「修改后」,确认后才写回。
  // 原先只服务「自动整理」(showTidyPreview),现在同时用于选中文字的 AI 编辑与
  // 写入摘要/生成大纲等全文动作 —— 改动落盘前先让用户看见改成什么样。
  // opts: { title, oldHead, newHead, oldText, newText, applyLabel, apply }
  //   apply() 省略时按「整篇正文替换为 newText」处理。
  function showAiDiff(opts) {
    const o = opts || {};
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-tidy-mask hidden';
    mask.innerHTML =
      '<div class="modal modal-lg notes-tidy-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('spark', 15) + ' ' + esc(o.title || 'AI 修改预览') + '</h3></div>'
      + '<div class="modal-body notes-tidy-body">'
      + '<div class="tidy-col"><div class="tidy-head">' + esc(o.oldHead || '修改前') + '</div><div class="tidy-pane md-prose msg assistant" id="tidy-old"></div></div>'
      + '<div class="tidy-col"><div class="tidy-head">' + esc(o.newHead || '修改后') + '</div><div class="tidy-pane md-prose msg assistant" id="tidy-new"></div></div>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn" data-close type="button">放弃</button>'
      + '<button class="btn primary" id="tidy-apply" type="button">' + esc(o.applyLabel || '应用修改') + '</button>'
      + '</div></div>';
    document.body.appendChild(mask);
    // settled 守卫:closeModal 会回调 _onClose,不能再进关闭流程(与其它弹窗同一纪律)
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (window.OCUI) window.OCUI.closeModal(mask);
      setTimeout(() => mask.remove(), 340);
    };
    mask._onClose = done;
    mask.querySelector('[data-close]').addEventListener('click', done);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(); });
    const oldText = String(o.oldText == null ? '' : o.oldText);
    const newText = String(o.newText == null ? '' : o.newText);
    if (window.OCRenderer) {
      window.OCRenderer.renderInto(mask.querySelector('#tidy-old'), oldText);
      window.OCRenderer.renderInto(mask.querySelector('#tidy-new'), newText);
    } else {
      mask.querySelector('#tidy-old').textContent = oldText;
      mask.querySelector('#tidy-new').textContent = newText;
    }
    mask.querySelector('#tidy-apply').addEventListener('click', () => {
      if (settled) return;
      if (typeof o.apply === 'function') o.apply();
      done();
    });
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    return { close: done };
  }

  // 自动整理:整篇正文替换,走通用预览
  function showTidyPreview(n, newContent) {
    showAiDiff({
      title: '自动整理预览',
      oldText: N.editor.ta.value,
      newText: newContent,
      applyLabel: '应用整理结果',
      apply: () => {
        const cur = noteById(n.id);
        updateNote(n.id, { content: newContent });
        saveEditorSoon(n.id);
        toast('已应用整理结果（可 Ctrl+Z 撤销）');
        void cur;
      },
    });
  }

  // ---- 建议3:问笔记(关键词召回 + 引用来源) ----
  function noteKeywords(q) {
    const raw = String(q).toLowerCase();
    const words = raw.match(/[a-z0-9_]+|[\u4e00-\u9fff]{2,}/g) || [];
    const out = new Set(words);
    // 中文长词再切 2-gram,提升召回
    words.forEach((w) => {
      if (/^[\u4e00-\u9fff]+$/.test(w) && w.length > 2) {
        for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
      }
    });
    return Array.from(out).slice(0, 24);
  }
  function recallNotes(q, limit) {
    const kws = noteKeywords(q);
    const scored = [];
    N.doc.notes.forEach((n) => {
      const hay = ((n.title || '') + '\n' + (n.content || '')).toLowerCase();
      let score = 0;
      kws.forEach((k) => { if (k && hay.indexOf(k) >= 0) score += Math.min(4, k.length); });
      if (kws.some((k) => (n.title || '').toLowerCase().indexOf(k) >= 0)) score += 6;
      if (score > 0) scored.push({ note: n, score: score });
    });
    scored.sort((a, b) => b.score - a.score || (b.note.updatedAt || 0) - (a.note.updatedAt || 0));
    return scored.slice(0, limit || 5);
  }
  function openAskNotes() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-ask-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-ask-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('search', 15) + ' 问笔记</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<p class="muted small">基于你的全部笔记回答，最多引用 5 篇；回答会列出引用来源，仅作参考，请自行核对。</p>'
      + '<div class="ask-row"><input class="notes-prompt-input" id="ask-q" placeholder="例如：容器查询和媒体查询的差别是什么？" maxlength="300" spellcheck="false">'
      + '<button class="btn primary" id="ask-go" type="button">提问</button></div>'
      + '<div class="ask-answer" id="ask-answer"></div>'
      + '</div>'
      + '<div class="modal-footer"><button class="btn" data-close>关闭</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', done));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(); });
    const input = mask.querySelector('#ask-q');
    const ans = mask.querySelector('#ask-answer');
    const go = async () => {
      const q = input.value.trim();
      if (!q) return;
      const hits = recallNotes(q, 5);
      ans.innerHTML = '<div class="ask-loading"><span class="nab-spin"></span>正在阅读你的笔记…</div>';
      try {
        let ctx = '';
        hits.forEach((h, i) => {
          ctx += '\n\n【笔记' + (i + 1) + '】标题：' + h.note.title + '\n' + String(h.note.content || '').slice(0, 3000);
        });
        const out = await aiRun('note-ask', [
          { role: 'system', content: '你是笔记助手。只根据提供的笔记内容回答问题；如果笔记里没有相关信息，直接说明「笔记里没有相关内容」，不要编造。回答后不要自行编造引用编号。' },
          { role: 'user', content: '问题：' + q + '\n\n我的笔记：' + (ctx || '（没有检索到相关笔记）') },
        ], 2048);
        ans.innerHTML = '<div class="ask-text"></div><div class="ask-src"></div>';
        const textBox = ans.querySelector('.ask-text');
        if (window.OCRenderer) window.OCRenderer.renderInto(textBox, stripFence(out));
        else textBox.textContent = stripFence(out);
        const src = ans.querySelector('.ask-src');
        src.innerHTML = hits.length
          ? '<div class="ask-src-head">引用来源（' + hits.length + '）</div>' + hits.map((h) => ''
              + '<button class="ask-src-item" data-id="' + esc(h.note.id) + '">' + esc(h.note.title || '无标题') + '</button>').join('')
          : '<div class="ask-src-head">没有检索到相关笔记，回答仅供参考</div>';
        src.querySelectorAll('[data-src-item], .ask-src-item').forEach((b) => {
          b.addEventListener('click', () => {
            const id = b.dataset.id;
            done();
            if (noteById(id)) openNote(id);
          });
        });
        refreshUsage();
      } catch (e) {
        ans.innerHTML = '<div class="ask-err">' + esc(e.message || '提问失败，请稍后重试') + '</div>';
      }
    };
    mask.querySelector('#ask-go').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    setTimeout(() => input.focus(), 80);
  }

  // ---- 建议2:Tab 续写 ----
  let continueBusy = false;
  async function continueWriting() {
    if (continueBusy || !N.editor) return;
    const ta = N.editor.ta;
    const caret = ta.selectionStart || 0;
    const before = ta.value.slice(0, caret);
    const after = ta.value.slice(ta.selectionEnd || caret);
    if (!before.trim()) { toast('先写一点内容，AI 才知道怎么接', true); return; }
    continueBusy = true;
    const busy = showAiBusy('续写');
    try {
      const out = await aiRun('note-continue', [
        { role: 'system', content: '你是写作助手。请接着用户已写的内容自然地续写一小段（60-160 字），保持语气与 Markdown 格式一致；只输出续写内容本身，不要重复已有文字，不要解释。' },
        { role: 'user', content: '已有内容（末尾是我停笔的地方）：\n\n' + before.slice(-3000) + (after.trim() ? '\n\n[后面还有内容]' : '') },
      ], 800);
      const ins = stripFence(out);
      if (!ins) throw new Error('没有生成内容');
      const marker = '\n\n<!--AI:' + Date.now().toString(36) + '-->\n';
      ta.value = before + marker + after;
      ta.selectionStart = ta.selectionEnd = before.length + marker.length;
      const rep = '\n\n' + ins + '\n';
      ta.value = before + rep + after;
      // 光标停在补全内容之后,继续按 Tab 可接着写
      ta.selectionStart = ta.selectionEnd = before.length + rep.length;
      N.editor.dirty = true;
      pushHistory({ force: true });
      renderPreview(ta.value);
      setSaveState('editing');
      clearTimeout(N.editor.saveTimer);
      N.editor.saveTimer = setTimeout(saveEditor, 600);
      toast('已续写（可 Ctrl+Z 撤销）');
    } catch (e) {
      toast('续写失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
      continueBusy = false;
    }
  }

  // ---- 建议8:每日摘要(把近期改动的笔记汇总成一篇日报) ----
  async function runDailyDigest() {
    const now = Date.now();
    const since = now - 24 * 3600 * 1000;
    const picks = N.doc.notes
      .filter((n) => (n.updatedAt || 0) >= since && !(n.source && n.source.generatedByAI && n.source.digest))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 20);
    if (!picks.length) { toast('最近 24 小时没有更新的笔记', true); return; }
    const busy = showAiBusy('生成日报');
    try {
      const ctx = picks.map((n) => '## ' + (n.title || '无标题') + '\n' + String(n.content || '').slice(0, 1200)).join('\n\n');
      const out = await aiRun('note-digest', [
        { role: 'system', content: '你是学习/工作记录助手。请把下面的笔记汇总成一份简洁的日报：先给 3-5 条要点，再列出待办（若有），最后注明涉及的笔记标题。直接输出 Markdown。' },
        { role: 'user', content: ctx },
      ], 2048);
      const day = new Date().toISOString().slice(0, 10);
      const content = '## ' + day + ' 每日摘要\n\n' + stripFence(out) + '\n\n---\n\n> 由 AI 汇总，涉及 ' + picks.length + ' 篇近 24 小时更新的笔记。';
      const note = createNote(N.ui.folderId || UNCATA, {
        title: day + ' 日报', tags: ['日报'], content: content,
        source: { conversationId: '', messageId: '', userQuestion: '', generatedByAI: true, digest: true },
      });
      openNote(note.id);
      toast('已生成日报（' + picks.length + ' 篇来源）');
    } catch (e) {
      toast('日报生成失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
    }
  }

  // ============ 使用导航 ============
  // 空态里常驻一份简版导航;首次进入再弹一次完整引导(加粗深色突出「可右键」)
  function usageGuideHtml() {
    return '<ul class="notes-guide">'
      + '<li><b>选文字右键</b>，用 AI 扩写、总结、翻译、检查谬误或降低重复率；结果先对照预览，确认后替换掉选中文字。</li>'
      + '<li><b>左下角齿轮</b>可自定义右键菜单里的动作（添加、删除、改名、改提示词）。</li>'
      + '<li><b>打「/」</b>插入模板，<b>按 Tab</b> 让 AI 续写下一句。</li>'
      + '<li><b>顶栏「问笔记」</b>基于全部笔记回答你的问题。</li>'
      + '<li><b>拖拽</b>图片或文件到编辑区即可上传；<b>拖笔记</b>可移动到其他文件夹。</li>'
      + '</ul>';
  }
  function maybeShowFirstRunGuide() {
    let seen = false;
    try { seen = localStorage.getItem('oc_notes_guide_seen') === '1'; } catch (e) {}
    if (seen) return;
    try { localStorage.setItem('oc_notes_guide_seen', '1'); } catch (e) {}
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-guide-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-guide-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('notebook', 15) + ' 欢迎使用 AI 笔记</h3></div>'
      + '<div class="modal-body">'
      + '<p class="ng-lead">这是一套可以用 AI 帮你写作的 Markdown 笔记。几个关键用法：</p>'
      + '<div class="ng-items">'
      + '<div class="ng-item"><span class="ng-num">1</span><div><b>选中文字后右键</b>，让 AI 扩写 / 总结 / 翻译 / 检查谬误 / 降低重复率；结果先弹「修改前 / 修改后」对照，确认后才替换掉选中文字，可随时 Ctrl+Z 撤销。</div></div>'
      + '<div class="ng-item"><span class="ng-num">2</span><div><b>左下角齿轮</b>可以自定义这个右键菜单：添加自己的动作、改写提示词、停用不需要的。</div></div>'
      + '<div class="ng-item"><span class="ng-num">3</span><div><b>输入 / 或按 Tab</b>：斜杠插入模板，Tab 让 AI 接着写。</div></div>'
      + '<div class="ng-item"><span class="ng-num">4</span><div><b>顶栏「问笔记」</b>能基于你的全部笔记回答问题，并标出引用来源。</div></div>'
      + '<div class="ng-item"><span class="ng-num">5</span><div><b>拖入图片或文件</b>即上传；把笔记<b>拖到左侧文件夹</b>即可移动；<b>拖动侧栏右缘</b>可调宽度。</div></div>'
      + '</div>'
      + '<p class="ng-foot">这份导航随时可以在左下角齿轮里重新查看。</p>'
      + '</div>'
      + '<div class="modal-footer"><button class="btn primary" id="ng-ok" type="button">开始使用</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelector('#ng-ok').addEventListener('click', done);
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  // 把预览区选中的文本回定位到 Markdown 源文。
  // 预览与源码存在差异(行内标记、软换行),所以先直接找,再退一步做归一化查找。
  function locateInSource(src, picked) {
    if (!src || !picked) return null;
    const direct = src.indexOf(picked);
    if (direct >= 0) return { start: direct, end: direct + picked.length };
    // 归一化:去掉 Markdown 行内标记后再比对,用累计偏移映射回原文
    const strip = (t) => t.replace(/[*_`~]/g, '');
    const flat = strip(src);
    const target = strip(picked.replace(/\s+/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!target) return null;
    const flatIdx = flat.indexOf(target);
    if (flatIdx < 0) {
      // 再退一步:用前 12 个字符做锚点
      const anchor = target.slice(0, Math.min(12, target.length));
      const ai = flat.indexOf(anchor);
      if (ai < 0) return null;
      const map = mapFlatToSource(src, strip);
      if (!map) return null;
      const start = map[ai];
      const endIdx = Math.min(target.length, flat.length - ai);
      const end = map[Math.min(ai + endIdx, map.length - 1)];
      return (start == null || end == null) ? null : { start: start, end: end + 1 };
    }
    const map = mapFlatToSource(src, strip);
    if (!map) return null;
    const start = map[flatIdx];
    const end = map[Math.min(flatIdx + target.length, map.length - 1)];
    return (start == null || end == null) ? null : { start: start, end: end + 1 };
  }
  // 建立「归一化后字符串下标 → 原文字符下标」的映射表
  function mapFlatToSource(src, stripFn) {
    const map = [];
    let flatLen = 0;
    for (let i = 0; i < src.length; i++) {
      const before = stripFn(src[i]);
      const keep = before.length > 0;
      if (keep) { map[flatLen] = i; flatLen += before.length; }
    }
    return map.length ? map : null;
  }

  // 处理中的浮标(右下角,不遮挡编辑)
  function showAiBusy(label) {
    const el = document.createElement('div');
    el.className = 'notes-ai-busy';
    el.innerHTML = '<span class="nab-spin"></span>AI 正在' + esc(label) + '…';
    (N.els.mask || document.body).appendChild(el);
    return el;
  }

  // 齿轮:右键菜单管理(自定义添加/删除/编辑/启停)
  function openAiSettingsMenu(anchor) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-aimgr-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-aimgr-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('gear', 15) + ' 右键菜单动作</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<p class="muted small">这些动作会出现在正文选中文字的右键菜单里。可停用、改名、改提示词，或添加自己的动作（提示词里用 <code>{{text}}</code> 代表选中的文字）。</p>'
      + '<div class="aimgr-list" id="aimgr-list"></div>'
      + '<details class="aimgr-add"><summary>＋ 添加自定义动作</summary>'
      + '<label class="field"><span>名称（右键菜单里显示）</span><input id="aimgr-new-label" maxlength="16" placeholder="例如：改写成表格"></label>'
      + '<label class="field"><span>提示词（<code>{{text}}</code> 为选中文字，可省略）</span>'
      + '<textarea id="aimgr-new-prompt" rows="3" spellcheck="false" placeholder="请把下面这段内容改写为 Markdown 表格，列包括…"></textarea></label>'
      + '<button class="btn primary" id="aimgr-add-btn" type="button">添加</button>'
      + '</details>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn" id="aimgr-shares" type="button">' + icon('share', 13) + '已分享管理</button>'
      + '<button class="btn" id="aimgr-guide" type="button">重新查看使用导航</button>'
      + '<button class="btn primary" data-close>完成</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const closeDlg = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = closeDlg;
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDlg));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeDlg(); });
    mask.querySelector('#aimgr-shares').addEventListener('click', () => {
      closeDlg();
      setTimeout(openShareManager, 380);
    });
    mask.querySelector('#aimgr-guide').addEventListener('click', () => {
      closeDlg();
      try { localStorage.removeItem('oc_notes_guide_seen'); } catch (e) {}
      setTimeout(maybeShowFirstRunGuide, 380);
    });

    const renderList = () => {
      const cfg = aiConfig();
      const list = mask.querySelector('#aimgr-list');
      list.innerHTML = aiActions().map((a) => ''
        + '<div class="aimgr-item' + (a.enabled ? '' : ' off') + '" data-key="' + esc(a.key) + '">'
        + '<label class="aimgr-switch" data-tip="' + (a.enabled ? '停用' : '启用') + '">'
        + '<input type="checkbox" data-act="toggle"' + (a.enabled ? ' checked' : '') + '><span class="slider"></span></label>'
        + '<div class="aimgr-main">'
        + '<input class="aimgr-label" data-act="label" value="' + esc(a.label) + '" maxlength="16" placeholder="动作名称">'
        + '<textarea class="aimgr-prompt" data-act="prompt" rows="2" spellcheck="false" placeholder="提示词（{{text}} 代表选中文字）">' + esc(a.prompt) + '</textarea>'
        + '</div>'
        + '<div class="aimgr-ops">'
        + (a.builtin ? '' : '<button class="notes-icon-btn" data-act="del" data-tip="删除">' + icon('trash', 14) + '</button>')
        + (a.builtin ? '<span class="aimgr-tag" data-tip="内置动作，可停用与改写提示词">内置</span>' : '')
        + '</div>'
        + '</div>').join('');
      list.querySelectorAll('.aimgr-item').forEach((row) => {
        const key = row.dataset.key;
        row.querySelector('[data-act="toggle"]').addEventListener('change', (e) => {
          const c = aiConfig();
          const i = c.disabled.indexOf(key);
          if (e.target.checked) { if (i >= 0) c.disabled.splice(i, 1); }
          else if (i < 0) c.disabled.push(key);
          aiConfigSave(c);
          row.classList.toggle('off', !e.target.checked);
          row.querySelector('.aimgr-switch').dataset.tip = e.target.checked ? '停用' : '启用';
        });
        const lab = row.querySelector('[data-act="label"]');
        lab.addEventListener('change', () => {
          const c = aiConfig();
          const v = lab.value.trim() || '未命名动作';
          lab.value = v;
          if (BUILTIN_ACTIONS.some((b) => b.key === key)) {
            c.overrides[key] = Object.assign({}, c.overrides[key], { label: v });
          } else {
            const it = c.custom.find((x) => x.key === key);
            if (it) it.label = v;
          }
          aiConfigSave(c);
        });
        const pr = row.querySelector('[data-act="prompt"]');
        pr.addEventListener('change', () => {
          const c = aiConfig();
          const v = pr.value;
          if (BUILTIN_ACTIONS.some((b) => b.key === key)) {
            c.overrides[key] = Object.assign({}, c.overrides[key], { prompt: v });
          } else {
            const it = c.custom.find((x) => x.key === key);
            if (it) it.prompt = v;
          }
          aiConfigSave(c);
        });
        const del = row.querySelector('[data-act="del"]');
        if (del) del.addEventListener('click', () => {
          const c = aiConfig();
          c.custom = c.custom.filter((x) => x.key !== key);
          c.disabled = c.disabled.filter((x) => x !== key);
          aiConfigSave(c);
          renderList();
        });
      });
    };
    mask.querySelector('#aimgr-add-btn').addEventListener('click', () => {
      const label = (mask.querySelector('#aimgr-new-label').value || '').trim();
      const prompt = (mask.querySelector('#aimgr-new-prompt').value || '').trim();
      if (!label) { toast('请填写动作名称', true); return; }
      const c = aiConfig();
      c.custom.push({ key: 'c' + Date.now().toString(36), label: label, desc: '自定义动作', prompt: prompt || '{{text}}' });
      aiConfigSave(c);
      mask.querySelector('#aimgr-new-label').value = '';
      mask.querySelector('#aimgr-new-prompt').value = '';
      renderList();
      toast('已添加动作「' + label + '」');
    });
    renderList();
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  async function refreshUsage() {
    const el = N.els.usage;
    if (!el) return;
    try {
      const r = await apiFetch('/api/notes/usage');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { el.textContent = ''; return; }
      N.usage = d;
      const quota = Number(d.quota) || 0;
      const aiUsed = Number(d.aiUsedToday) || 0;
      const aiLimit = Number(d.aiDailyLimit) || 0;
      N.usageAi = { used: aiUsed, limit: aiLimit };
      if (!quota) {
        el.innerHTML = icon('upload', 12) + '<span>已用 ' + fmtBytes(d.used) + '（不限量）</span>';
      } else {
        const left = Math.max(0, quota - (Number(d.used) || 0));
        const pct = Math.min(100, Math.round(((Number(d.used) || 0) / quota) * 100));
        el.innerHTML = icon('upload', 12) + '<span>剩余 ' + fmtBytes(left) + ' / ' + fmtBytes(quota) + '</span>';
        el.title = '笔记附件空间已用 ' + fmtBytes(d.used) + '（' + pct + '%），上限 ' + fmtBytes(quota);
      }
      if (aiLimit > 0) el.title += ' · 今日 AI 已用 ' + aiUsed + '/' + aiLimit + ' 次（按服务器时区计日）';
    } catch (e) { el.textContent = ''; }
  }

  function syncDot(state) {
    const dot = N.els.syncDot;
    if (!dot) return;
    dot.dataset.state = state || '';
    dot.dataset.tip = state === 'err' ? '云同步失败，稍后自动重试'
      : (state === 'conflict' ? '检测到其他设备的改动，已自动合并'
      : (state === 'ok' ? '已同步到云端' : '云同步中'));
  }

  function isNotesPath() {
    try { return location.pathname.replace(/\/+$/, '') === '/ainotes'; } catch (e) { return false; }
  }
  async function open(opts) {
    opts = opts || {};
    if (!(await ensureLoaded())) { toast('请先登录后再使用 AI 笔记', true); return; }
    if (!N.els.mask) buildShell();
    flushEditor();
    refreshUsage();
    maybeGcAttachments();
    // 每次进入都从「抽屉收起」开始:窄屏下若沿用上次状态,一进来就是面板压住正文
    N.ui.mobileSide = false;
    applySideState();
    N.ui.search = '';
    N.els.searchInput.value = '';
    renderAll();
    // 独立地址:刷新后仍停留在笔记页
    if (window.history && !isNotesPath()) {
      try { history.pushState({ notes: true }, '', '/ainotes'); } catch (e) {}
    }
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(N.els.mask);
    else N.els.mask.classList.add('show');
    if (!opts.boot) maybeShowFirstRunGuide();
    else setTimeout(maybeShowFirstRunGuide, 400);
  }
  function close() {
    closeAiCtxMenu();
    closeMdBar();
    flushEditor();
    if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(N.els.mask);
    else N.els.mask.classList.remove('show');
    // 返回对话首页:地址同步回根路径(仅在确实处于 /ainotes 时)
    if (isNotesPath() && window.history) {
      try { history.pushState(null, '', '/'); } catch (e) {}
    }
  }

  // ============ 渲染 ============
  function renderAll() {
    renderTree();
    renderEditor();
    alignShareState();
  }

  function sortCmp(a, b) {
    if (N.ui.sort === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
    if (N.ui.sort === 'title') return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  }
  function folderNotes(folderId) {
    return N.doc.notes
      .filter((n) => n.folderId === folderId)
      .sort((a, b) => ((b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0)) || sortCmp(a, b));
  }

  // 左栏:文件夹(可折叠)与笔记的同一棵树。文件夹行点击=选中并展开;箭头=折叠/展开。
  function renderTree() {
    const tree = N.els.tree;
    if (!tree) return;
    tree.innerHTML = '';
    const q = N.ui.search.toLowerCase();
    if (q) {
      const matches = visibleNotes();
      const head = document.createElement('div');
      head.className = 'nt-search-head';
      head.textContent = '搜索「' + N.ui.search + '」· ' + matches.length + ' 篇';
      tree.appendChild(head);
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'nt-none';
        empty.textContent = '没有匹配的笔记';
        tree.appendChild(empty);
      }
      matches.forEach((n) => tree.appendChild(noteRow(n, true)));
      return;
    }
    tree.appendChild(folderBlock(folderById(UNCATA) || { id: UNCATA, name: UNCATA_LABEL }, 0));
    const build = (pid, depth, host) => {
      if (N.ui.expanded[pid] === false) return;
      childFolders(pid).forEach((f) => {
        if (f.id === UNCATA) return; // 默认分类已固定在顶部
        host.appendChild(folderBlock(f, depth));
        build(f.id, depth + 1, host);
      });
    };
    build(null, 0, tree);
  }

  // 一个文件夹块 = 文件夹行 + (展开时的)笔记列表与子文件夹块
  function folderBlock(f, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'nt-block';
    wrap.appendChild(folderRow(f, depth));
    if (N.ui.expanded[f.id] !== false) {
      const notes = folderNotes(f.id);
      if (notes.length) {
        const list = document.createElement('div');
        list.className = 'nt-notes';
        list.style.paddingLeft = (26 + depth * 14) + 'px';
        notes.forEach((n) => list.appendChild(noteRow(n, false)));
        wrap.appendChild(list);
      }
      childFolders(f.id).forEach((sub) => {
        if (sub.id === UNCATA) return;
        wrap.appendChild(folderBlock(sub, depth + 1));
      });
    }
    return wrap;
  }

  function folderRow(f, depth) {
    const row = document.createElement('div');
    row.className = 'notes-folder-row' + (N.ui.folderId === f.id && !N.ui.search ? ' active' : '');
    row.dataset.folderId = f.id;
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    const open = N.ui.expanded[f.id] !== false;
    const kids = childFolders(f.id);
    const notes = folderNotes(f.id);
    const expandable = kids.length > 0 || notes.length > 0;
    const chev = document.createElement('button');
    chev.className = 'notes-chev' + (expandable ? '' : ' leaf');
    chev.innerHTML = icon('chevronRight', 12);
    chev.dataset.tip = open ? '折叠' : '展开';
    if (expandable) {
      row.classList.add('has-kids');
      row.classList.toggle('open-row', open);
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        N.ui.expanded[f.id] = !open;
        persistUi();
        renderTree();
      });
    } else {
      chev.disabled = true;
    }
    const ic = document.createElement('span');
    ic.className = 'notes-folder-icon';
    ic.innerHTML = icon('folder', 15);
    const name = document.createElement('span');
    name.className = 'notes-folder-name';
    name.textContent = f.name;
    const count = document.createElement('span');
    count.className = 'notes-folder-count';
    count.textContent = notes.length || '';
    const more = document.createElement('button');
    more.className = 'notes-row-more';
    more.innerHTML = icon('more', 14);
    more.dataset.tip = '文件夹操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      folderMenu(more, f);
    });
    row.appendChild(chev); row.appendChild(ic); row.appendChild(name); row.appendChild(count); row.appendChild(more);
    row.addEventListener('click', () => {
      // 点击 = 选中该文件夹并展开其笔记列表(折叠只走左侧箭头,避免误折叠)
      N.ui.folderId = f.id;
      if (expandable) N.ui.expanded[f.id] = true;
      persistUi();
      renderTree();
    });
    // 双击直接重命名
    row.addEventListener('dblclick', () => {
      if (f.id !== UNCATA) renameFolderFlow(f);
    });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/oc-note-id');
      if (id) moveNote(id, f.id);
    });
    return row;
  }

  function folderMenu(more, f) {
    const items = [];
    if (f.id !== UNCATA) items.push({ value: 'sub', label: '新建子文件夹' });
    if (f.id !== UNCATA) items.push({ value: 'rename', label: '重命名' });
    if (f.id !== UNCATA) items.push({ value: 'delete', label: '删除文件夹' });
    window.OC.openSelect(more, items, {
      onSelect: async (v) => {
        if (v === 'sub') promptNewFolder(f.id);
        else if (v === 'rename') renameFolderFlow(f);
        else if (v === 'delete') {
          const cnt = folderNotes(f.id).length;
          const ok = await window.OCUI.confirm({
            title: '删除文件夹「' + f.name + '」？',
            message: cnt ? ('其中 ' + cnt + ' 篇笔记将移动到「' + UNCATA_LABEL + '」，子文件夹上提一级。') : '空文件夹将被删除。',
            danger: true, confirmText: '删除',
          });
          if (ok) deleteFolder(f.id);
        }
      },
    });
  }

  function renameFolderFlow(f) {
    notesPrompt({
      title: '重命名文件夹',
      value: f.name, maxlength: 80, confirmText: '保存',
    }).then((name) => {
      if (name && name.trim() && name.trim() !== f.name) renameFolder(f.id, name.trim());
    });
  }

  function promptNewFolder(parentId) {
    notesPrompt({
      title: parentId ? '新建子文件夹' : '新建文件夹',
      message: '名称要语义明确、可长期使用，避免「其他」「杂项」这类泛化名称。',
      value: '', maxlength: 80, confirmText: '创建',
    }).then((name) => {
      name = String(name || '').trim();
      if (!name) return;
      const f = createFolder(name, parentId);
      N.ui.expanded[parentId || 'root'] = true;
      if (parentId) N.ui.expanded[parentId] = true;
      N.ui.folderId = f.id;
      persistUi();
      renderAll();
    });
  }

  function noteRow(n, searching) {
    const item = document.createElement('div');
    item.className = 'nt-note' + (N.ui.selNoteId === n.id ? ' active' : '') + (n.isPinned ? ' pinned' : '');
    item.draggable = true;
    item.dataset.noteId = n.id;
    item.title = n.title || '无标题笔记';
    item.innerHTML =
      (n.isPinned
        ? '<span class="nt-pin">' + icon('pin', 11) + '</span>'
        : '<span class="nt-doc">' + icon('notebook', 12) + '</span>')
      + '<span class="nt-note-title">' + esc(n.title || '无标题笔记') + '</span>'
      + (searching ? '<span class="nt-folder-badge">' + icon('folder', 10) + esc(folderName(n.folderId)) + '</span>' : '')
      + '<span class="nt-time">' + esc(fmtTime(n.updatedAt)) + '</span>';
    const more = document.createElement('button');
    more.className = 'notes-row-more';
    more.innerHTML = icon('more', 13);
    more.dataset.tip = '笔记操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      noteMenu(more, n);
    });
    item.appendChild(more);
    item.addEventListener('click', () => openNote(n.id));
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/oc-note-id', n.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    return item;
  }

  function noteMenu(more, n) {
    const s = shareOf(n.id);
    const items = [
      { value: 'pin', label: n.isPinned ? '取消置顶' : '置顶' },
      { value: 'move', label: '移动到…' },
      { value: 'rename', label: '重命名' },
      { value: 'share', label: s ? '分享（已开启）' : '分享…' },
      { value: 'export', label: '导出 .md' },
      { value: 'delete', label: '删除笔记' },
    ];
    // AI 动作单独成组:直接在列表上对某篇笔记跑,不必先打开
    const aiItems = [
      { value: 'ai-title', label: '生成标题 · 依正文起个题目' },
      { value: 'ai-tags', label: '推荐标签 · 自动补充标签' },
      { value: 'ai-summary', label: '生成摘要 · 写入正文开头' },
    ];
    const groups = [{ label: '', items: items }, { label: 'AI', items: aiItems }];
    window.OC.openSelect(more, groups, {
      onSelect: async (v) => {
        if (v === 'pin') togglePin(n.id);
        else if (v === 'move') pickFolder((f) => moveNote(n.id, f));
        else if (v === 'rename') {
          const t = await notesPrompt({ title: '重命名笔记', value: n.title, maxlength: 200, confirmText: '保存' });
          if (t && t.trim()) updateNote(n.id, { title: t.trim() });
        } else if (v === 'share') openShareDialog(n.id);
        else if (v === 'export') exportNote(n);
        else if (v === 'delete') {
          const ok = await window.OCUI.confirm({ title: '删除笔记「' + n.title + '」？', message: '删除后其他设备也会同步删除。', danger: true, confirmText: '删除' });
          if (ok) deleteNote(n.id);
        } else if (v === 'ai-title') void listAiTitle(n);
        else if (v === 'ai-tags') void listAiTags(n);
        else if (v === 'ai-summary') void listAiSummary(n);
      },
    });
  }

  // ---- 列表页 AI:直接对某篇笔记跑动作,无需先打开编辑器 ----
  // 与编辑器内的同类动作共用提示词口径,但结果落到列表项字段(title / tags / content)。
  function listAiBody(n) {
    const c = noteById(n.id) || n;
    return String(c.content || '');
  }
  async function listAiTitle(n) {
    const body = listAiBody(n);
    if (!body.trim()) { toast('这篇笔记还是空的，先写点内容吧', true); return; }
    const busy = showAiBusy('生成标题');
    try {
      const out = await aiRun('note-title', [
        { role: 'system', content: '你是笔记助手。只输出一个简短中文标题（不超过 20 字），不加书名号、不加引号、不要解释。' },
        { role: 'user', content: '为下面这篇笔记起一个标题：\n\n' + body.slice(0, 6000) },
      ], 100);
      const title = stripFence(out).split('\n')[0].replace(/^["“”'']|["“”'']$/g, '').trim().slice(0, 60);
      if (!title) throw new Error('模型没有返回标题');
      const cur = noteById(n.id) || n;
      const ok = await window.OCUI.confirm({
        title: '使用这个标题？',
        message: '原标题：' + (cur.title || '（无）') + '\n\n新标题：' + title,
        confirmText: '替换',
      });
      if (!ok) { toast('已保留原标题'); return; }
      updateNote(n.id, { title: title });
      toast('标题已更新');
    } catch (e) {
      toast('生成标题失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
    }
  }
  async function listAiTags(n) {
    const body = listAiBody(n);
    if (!body.trim()) { toast('这篇笔记还是空的，先写点内容吧', true); return; }
    const busy = showAiBusy('推荐标签');
    try {
      const out = await aiRun('note-tags', [
        { role: 'system', content: '你是笔记助手。只输出 3-6 个简短中文标签，用中文逗号分隔，不要解释。' },
        { role: 'user', content: '为下面这篇笔记推荐标签：\n\n' + body.slice(0, 6000) },
      ], 200);
      const tags = stripFence(out).split(/[,，、\n]/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean).slice(0, 8);
      if (!tags.length) throw new Error('没有解析出标签');
      const cur = noteById(n.id) || n;
      const merged = Array.from(new Set(((cur.tags) || []).concat(tags))).slice(0, 20);
      updateNote(n.id, { tags: merged });
      toast('已补充标签：' + tags.join('、'));
    } catch (e) {
      toast('推荐标签失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
    }
  }
  async function listAiSummary(n) {
    const body = listAiBody(n);
    if (!body.trim()) { toast('这篇笔记还是空的，先写点内容吧', true); return; }
    const busy = showAiBusy('生成摘要');
    try {
      const out = await aiRun('note-doc', [
        { role: 'system', content: '你是严谨的中文写作助手。只输出要求的内容本身，不要任何解释或额外前言。' },
        { role: 'user', content: '请为下面这篇笔记写一段 100 字以内的摘要，直接输出摘要正文（不要「摘要：」前缀）。\n\n' + body.slice(0, 12000) },
      ], 2048);
      const clean = stripFence(out);
      if (!clean) throw new Error('模型没有返回内容');
      const cur = noteById(n.id) || n;
      const base = String(cur.content || '');
      const next = '> **摘要**：' + clean.replace(/\n+/g, ' ').trim() + '\n\n' + base;
      showAiDiff({
        title: '生成摘要预览',
        oldText: base,
        newText: next,
        applyLabel: '写入摘要',
        apply: () => {
          // 若用户此刻正编辑这篇,走 saveEditorSoon 同步回编辑器(并进撤销历史);否则直接改数据
          const editing = N.editor && N.editor.noteId === n.id;
          updateNote(n.id, { content: next });
          if (editing) { saveEditorSoon(n.id); toast('摘要已写入正文开头（可 Ctrl+Z 撤销）'); }
          else toast('摘要已写入正文开头');
        },
      });
    } catch (e) {
      toast('生成摘要失败：' + (e.message || '请稍后重试'), true);
    } finally {
      busy.remove();
    }
  }

  // 搜索索引:为每篇笔记缓存「小写化 + 去 Markdown 标记」的搜索文本,按 updatedAt 增量重建。
  // 原先每次输入都对全文做 includes(大笔记 + 多笔记会卡),这里把重活摊到笔记变更时。
  const searchIndex = { map: {}, rev: 0 };
  function noteSearchText(n) {
    const raw = (n.title || '') + '\n' + (n.content || '') + '\n' + (n.tags || []).join(' ');
    // 去代码块与链接外壳,降低体积;保留正文关键词
    return raw
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase();
  }
  function searchTextOf(n) {
    const hit = searchIndex.map[n.id];
    if (hit && hit.t === n.updatedAt && hit.r === searchIndex.rev) return hit.s;
    const text = noteSearchText(n);
    searchIndex.map[n.id] = { t: n.updatedAt, r: searchIndex.rev, s: text };
    return text;
  }
  function invalidateSearchIndex() { searchIndex.rev++; }

  function visibleNotes() {
    const q = N.ui.search.toLowerCase();
    let notes = N.doc.notes.filter((n) => !(n.id in (N.doc.tombs || {})));
    if (q) {
      notes = notes.filter((n) => searchTextOf(n).indexOf(q) >= 0);
    } else {
      notes = notes.filter((n) => n.folderId === N.ui.folderId);
    }
    return notes.sort((a, b) => ((b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0)) || sortCmp(a, b));
  }

  function pickFolder(cb, excludeId) {
    if (!N.els.mask) return;
    const items = N.doc.folders
      .filter((f) => f.id !== excludeId)
      .sort((a, b) => folderDepth(a.id) - folderDepth(b.id))
      .map((f) => ({ value: f.id, label: '　'.repeat(folderDepth(f.id)) + f.name }));
    // 锚到编辑区(页面居中偏右),避免出现在左下角看不见
    const anchor = N.els.editorPane && N.els.editorPane.offsetWidth
      ? N.els.editorPane
      : N.els.mask;
    window.OC.openSelect(anchor, items, { searchable: true, searchPlaceholder: '搜索文件夹…', center: true, onSelect: cb });
  }

  function exportNote(n) {
    const blob = new Blob([n.content || ''], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (n.title || '笔记').replace(/[\\/:*?"<>|]/g, '_') + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  // ============ 编辑器 ============
  function openNote(id) {
    flushEditor();
    const n = noteById(id);
    // 选中笔记时,所属文件夹同步选中并展开(两者高亮保持一致)
    if (n) {
      N.ui.folderId = n.folderId;
      N.ui.expanded[n.folderId] = true;
    }
    N.ui.selNoteId = id;
    // 窄屏:选中即收起抽屉,否则文件夹面板会一直盖住刚打开的正文
    if (isNarrow()) N.ui.mobileSide = false;
    persistUi();
    renderTree();
    renderEditor();
    applySideState();
  }

  function renderEditor() {
    const pane = N.els.editorPane;
    const bar = N.els.bar;
    const head = N.els.head;
    if (!pane || !bar || !head) return;
    const n = N.ui.selNoteId ? noteById(N.ui.selNoteId) : null;
    if (!n) {
      N.editor = null;
      bar.classList.add('hidden');
      head.classList.remove('has-editor');
      pane.innerHTML = '<div class="notes-editor-empty">'
        + icon('notebook', 34)
        + '<h3>选择或新建一篇笔记</h3>'
        + usageGuideHtml()
        + '<button class="notes-new-btn" id="notes-empty-new">' + icon('plus', 13) + '新建笔记</button>'
        + '</div>';
      const btn = pane.querySelector('#notes-empty-new');
      if (btn) btn.addEventListener('click', () => openNewNoteDialog(btn));
      return;
    }
    const mode = N.ui.mode;
    bar.classList.remove('hidden');
    head.classList.add('has-editor');
    // 顶栏右上角:标题 / 标签 / 分类 / 时间 / 模式 / 工具
    bar.querySelector('#ne-title').value = n.title || '';
    bar.querySelector('#ne-folder-name').textContent = folderName(n.folderId);
    bar.querySelector('#ne-time').textContent = '更新于 ' + fmtTime(n.updatedAt);
    bar.querySelector('#ne-time').dataset.tip = '创建于 ' + fmtFull(n.createdAt);
    bar.querySelectorAll('#ne-mode-switch button').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
    pane.innerHTML =
      '<div class="notes-editor">'
      + '<div class="notes-editor-panes mode-' + mode + '">'
      + '<textarea class="notes-ta" id="ne-ta" spellcheck="false" placeholder="用 Markdown 书写…粘贴图片或拖入文件可直接上传。"></textarea>'
      + '<div class="notes-preview-wrap"><div class="notes-preview msg assistant"><div class="msg-content" id="ne-preview"></div></div></div>'
      + '</div>'
      + '</div>';
    const ta = pane.querySelector('#ne-ta');
    const preview = pane.querySelector('#ne-preview');
    ta.value = n.content || '';
    N.editor = { noteId: n.id, ta, preview, dirty: false, saveTimer: null, renderTimer: null };
    renderPreview(n.content || '');
    renderAttachCards();
    resetHistory(n.id);


    ta.addEventListener('input', () => {
      N.editor.dirty = true;
      pushHistory();
      setSaveState('editing');
      clearTimeout(N.editor.saveTimer);
      N.editor.saveTimer = setTimeout(saveEditor, 900);
      clearTimeout(N.editor.renderTimer);
      N.editor.renderTimer = setTimeout(() => renderPreview(ta.value), 450);
    });
    ta.addEventListener('keydown', (e) => {
      // 撤销 / 重做:自建历史栈(原生 undo 在重渲染后会失效)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveEditor();
        toast('已保存');
      }
      // Tab:行尾/空选区 → 让 AI 续写;行内缩进场景仍做缩进
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const sPos = ta.selectionStart, ePos = ta.selectionEnd;
        const lineStart = ta.value.lastIndexOf('\n', sPos - 1) + 1;
        const lineEnd = ta.value.indexOf('\n', sPos);
        const atLineEnd = (lineEnd < 0 || ePos >= lineEnd);
        const atEmptyLine = ta.value.slice(lineStart, lineEnd < 0 ? ta.value.length : lineEnd).trim() === '';
        if (atLineEnd || atEmptyLine) { continueWriting(); return; }
        ta.value = ta.value.slice(0, sPos) + '  ' + ta.value.slice(ePos);
        ta.selectionStart = ta.selectionEnd = sPos + 2;
        ta.dispatchEvent(new Event('input'));
      }
    });
    // 选区右键 → AI 编辑菜单(编辑区与预览区都支持)
    const ctxTargets = [ta, pane.querySelector('.notes-preview-wrap')];
    ctxTargets.forEach((zone) => {
      zone.addEventListener('contextmenu', (e) => {
        if (zone === ta) {
          // 编辑区:直接用 textarea 选区与位置
          const from = ta.selectionStart, to = ta.selectionEnd;
          if (from === to) return; // 没选文字,保留系统菜单
          e.preventDefault();
          openAiCtxMenu(e.clientX, e.clientY, ta.value.slice(from, to), { start: from, end: to });
          return;
        }
        // 预览区:把选中的渲染文本回定位到 Markdown 源文,避免结果插到错误位置
        const picked = (window.getSelection ? String(window.getSelection().toString() || '') : '').trim();
        if (!picked) return;
        const hit = locateInSource(ta.value, picked);
        if (!hit) {
          e.preventDefault();
          openAiCtxMenu(e.clientX, e.clientY, picked, 'preview-only');
          return;
        }
        e.preventDefault();
        openAiCtxMenu(e.clientX, e.clientY, ta.value.slice(hit.start, hit.end), { start: hit.start, end: hit.end });
      });
    });
    // 点空白 / 滚动时收起右键菜单(document 级监听在 buildShell 里只挂一次)
    pane.addEventListener('scroll', closeAiCtxMenu, true);

    // 粘贴 / 拖拽上传(编辑区 + 预览区都接)
    [ta, pane.querySelector('.notes-preview-wrap')].forEach((zone) => {
      zone.addEventListener('paste', (e) => {
        const files = clipboardFiles(e);
        if (files.length) { e.preventDefault(); uploadFiles(files); }
      });
    });
    const panesEl = pane.querySelector('.notes-editor-panes');
    panesEl.addEventListener('dragover', (e) => { e.preventDefault(); panesEl.classList.add('drag-over'); });
    panesEl.addEventListener('dragleave', (e) => { if (!panesEl.contains(e.relatedTarget)) panesEl.classList.remove('drag-over'); });
    panesEl.addEventListener('drop', (e) => {
      e.preventDefault();
      panesEl.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) uploadFiles(files);
    });
    if (N.ui.mode !== 'edit') setTimeout(() => { ta.blur(); }, 0);
  }

  function clipboardFiles(e) {
    const out = [];
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return out;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  }

  function setSaveState(state) {
    const el = N.els.bar && N.els.bar.querySelector('#ne-save-state');
    if (!el) return;
    el.dataset.state = state;
    if (state === 'editing') el.textContent = '正在编辑…';
    else if (state === 'saving') el.textContent = '保存中…';
    else if (state === 'syncing') el.textContent = '已保存，同步中…';
    else el.textContent = '已保存 ' + fmtClock(Date.now());
  }

  function saveEditor() {
    if (!N.editor || !N.editor.dirty) return;
    const n = noteById(N.editor.noteId);
    if (!n) return;
    setSaveState('saving');
    const ta = N.editor.ta;
    const titleInput = N.els.bar.querySelector('#ne-title');
    n.content = ta.value;
    if (titleInput && titleInput.value.trim()) n.title = titleInput.value.trim();
    n.updatedAt = Date.now();
    N.editor.dirty = false;
    pushVersion(n.id, n.content, n.title);
    persistLocal();
    schedulePush();
    setSaveState('syncing');
    // 树行时间与头部「更新于」同步刷新(不整体重绘,避免打断输入)
    const timeEl = N.els.bar.querySelector('#ne-time');
    if (timeEl) timeEl.textContent = '更新于 ' + fmtTime(n.updatedAt);
    const row = N.els.tree && N.els.tree.querySelector('.nt-note[data-note-id="' + n.id + '"] .nt-time');
    if (row) row.textContent = fmtTime(n.updatedAt);
    const titleRow = N.els.tree && N.els.tree.querySelector('.nt-note[data-note-id="' + n.id + '"] .nt-note-title');
    if (titleRow) titleRow.textContent = n.title;
  }
  function flushEditor() {
    if (N.editor && N.editor.dirty) saveEditor();
  }

  // ============ 版本历史(本地) ============
  // 每次「实质保存」留一份快照,保留最近 N 版;刷新/重开页面后仍可回看,
  // 补上「撤销栈只在会话内有效」的空档。存 localStorage,超限时自动裁剪。
  const VER_KEEP = 20;
  const VER_MIN_GAP_MS = 60 * 1000; // 1 分钟内多次保存只留最后一版,避免刷屏
  function verKey(noteId) { return 'oc_notes_ver_' + (N.userId || 'anon') + '_' + noteId; }
  function readVersions(noteId) {
    try {
      const j = JSON.parse(localStorage.getItem(verKey(noteId)) || '[]');
      return Array.isArray(j) ? j : [];
    } catch (e) { return []; }
  }
  function pushVersion(noteId, content, title) {
    if (!noteId) return;
    const list = readVersions(noteId);
    const last = list[list.length - 1];
    const now = Date.now();
    if (last && now - last.at < VER_MIN_GAP_MS && last.content === content) return;
    // 内容未变则不记(避免重复快照)
    if (last && last.content === content && last.title === title) return;
    list.push({ at: now, content: content, title: title, len: content.length });
    while (list.length > VER_KEEP) list.shift();
    try {
      localStorage.setItem(verKey(noteId), JSON.stringify(list));
    } catch (e) {
      // 空间不足:砍掉一半旧版本再试一次
      try {
        const half = list.slice(Math.floor(list.length / 2));
        localStorage.setItem(verKey(noteId), JSON.stringify(half));
      } catch (e2) { /* 放弃记录历史,不影响正文保存 */ }
    }
  }
  function openVersionHistory(n) {
    const list = readVersions(n.id).slice().reverse();
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-ver-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-ver-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('clock', 15) + ' 历史版本</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + (list.length
        ? '<p class="muted small">本机保留的最近 ' + list.length + ' 个版本（最多 ' + VER_KEEP + ' 个）。恢复会覆盖当前内容，可用 Ctrl+Z 撤销。</p>'
          + '<div class="ver-list">' + list.map((v, i) => ''
            + '<div class="ver-item"><span class="ver-time">' + esc(fmtFull(v.at)) + '</span>'
            + '<span class="ver-len">' + v.len + ' 字符</span>'
            + '<button class="btn small" data-ver="' + i + '">预览并恢复</button></div>').join('') + '</div>'
        : '<p class="muted small">还没有历史版本。编辑保存后会自动留档（本机保留，最多 ' + VER_KEEP + ' 个）。</p>')
      + '</div>'
      + '<div class="modal-footer"><button class="btn" data-close>关闭</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', done));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(); });
    mask.querySelectorAll('[data-ver]').forEach((b) => {
      b.addEventListener('click', async () => {
        const v = list[Number(b.dataset.ver)];
        const ok = await window.OCUI.confirm({
          title: '恢复到 ' + fmtFull(v.at) + ' 的版本？',
          message: '当前内容会被替换（可 Ctrl+Z 撤销）。',
          confirmText: '恢复',
        });
        if (!ok) return;
        const cur = noteById(n.id);
        if (!cur) return;
        pushVersion(n.id, cur.content || '', cur.title || ''); // 先存当前,便于回退
        updateNote(n.id, { content: v.content, title: v.title || cur.title });
        saveEditorSoon(n.id);
        done();
        toast('已恢复历史版本');
      });
    });
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  // ============ 已分享管理 ============
  // 一处集中管理全部笔记分享链接:改权限/有效期、取消分享。
  async function openShareManager() {
    // 拉一次服务端分享状态(权威),避免本地副本过期
    try {
      const r = await apiFetch('/api/sync/notes');
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        if (Array.isArray(d.shares)) { N.shares = d.shares; alignShareState(); }
      }
    } catch (e) { /* 离线时用本地副本 */ }

    const render = () => {
      const rows = N.shares.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!rows.length) return '<p class="muted small">还没有分享中的笔记。在笔记里点「分享」即可生成链接。</p>';
      return '<div class="shm-list">' + rows.map((sh) => {
        const n = noteById(sh.noteId);
        const title = n ? (n.title || '无标题') : '（笔记已删除）';
        const exp = Number(sh.expireAt) || 0;
        const left = exp ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : 0;
        const expText = exp ? (left > 0 ? '剩余 ' + left + ' 天' : '已过期') : '永久有效';
        const modeText = sh.mode === 'edit-link' ? '持链接可编辑' : '持链接可查看';
        return '<div class="shm-item" data-token="' + esc(sh.token) + '" data-note="' + esc(sh.noteId) + '">'
          + '<div class="shm-main">'
          + '<b>' + esc(title) + '</b>'
          + '<div class="shm-meta">' + esc(modeText) + ' · ' + esc(expText)
          + (n ? '' : ' · <span class="shm-warn">笔记已删除</span>') + '</div>'
          + '</div>'
          + '<div class="shm-ops">'
          + '<button class="btn small" data-act="copy">复制链接</button>'
          + '<button class="btn small" data-act="edit"' + (n ? '' : ' disabled') + '>修改设置</button>'
          + '<button class="btn small danger" data-act="close">取消分享</button>'
          + '</div></div>';
      }).join('') + '</div>';
    };

    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-shm-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-shm-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('share', 15) + ' 已分享管理</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<p class="muted small">这里汇总所有分享中的笔记链接。可修改权限与有效期（链接不变），或取消分享（链接立即失效）。</p>'
      + '<div id="shm-body">' + render() + '</div>'
      + '</div>'
      + '<div class="modal-footer"><button class="btn" data-close>关闭</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', done));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(); });

    const refresh = () => { mask.querySelector('#shm-body').innerHTML = render(); bind(); };
    const bind = () => {
      mask.querySelectorAll('.shm-item').forEach((item) => {
        const token = item.dataset.token;
        const noteId = item.dataset.note;
        const sh = N.shares.find((x) => x.token === token);
        item.querySelector('[data-act="copy"]').addEventListener('click', async () => {
          const url = location.origin + '/n/' + token;
          let ok = false;
          if (window.OCUI && window.OCUI.copyText) ok = await window.OCUI.copyText(url);
          else { try { await navigator.clipboard.writeText(url); ok = true; } catch (e) {} }
          toast(ok ? '链接已复制' : '复制失败，请手动复制', !ok);
        });
        item.querySelector('[data-act="edit"]').addEventListener('click', () => {
          if (!sh) return;
          openShareSettings(sh, noteId, refresh);
        });
        item.querySelector('[data-act="close"]').addEventListener('click', async () => {
          const n = noteById(noteId);
          const ok = await window.OCUI.confirm({
            title: '取消分享「' + (n ? n.title : '该笔记') + '」？',
            message: '链接会立即失效，已发出的链接将无法访问。',
            danger: true, confirmText: '取消分享',
          });
          if (!ok) return;
          try {
            const r2 = await apiFetch('/api/notes/share', {
              method: 'DELETE', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ noteId }),
            });
            if (!r2.ok) throw new Error('取消失败');
            N.shares = N.shares.filter((x) => x.noteId !== noteId);
            alignShareState();
            persistLocal();
            toast('已取消分享');
            refresh();
            renderTree();
          } catch (e) {
            toast(e.message || '取消失败', true);
          }
        });
      });
    };
    bind();
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  // 修改某条分享的设置:权限与有效期(keepToken 保留原链接)
  function openShareSettings(sh, noteId, onSaved) {
    const n = noteById(noteId);
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-shm-edit-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-shm-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>修改分享设置</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      + '<p class="muted small">' + esc(n ? (n.title || '无标题') : '（笔记已删除）') + '</p>'
      + '<div class="ns-modes">'
      + '<label class="ns-mode"><input type="radio" name="shm-mode" value="view-link" ' + (sh.mode !== 'edit-link' ? 'checked' : '') + '><div><b>持链接可查看</b><span>任何人拿到链接都能阅读这篇笔记</span></div></label>'
      + '<label class="ns-mode"><input type="radio" name="shm-mode" value="edit-link" ' + (sh.mode === 'edit-link' ? 'checked' : '') + '><div><b>持链接可编辑</b><span>拿到链接的人可以直接修改笔记内容</span></div></label>'
      + '</div>'
      + '<label class="ns-expire">链接有效期'
      + '<select id="shm-expire">'
      + '<option value="0">永久有效</option>'
      + '<option value="1">1 天</option>'
      + '<option value="7">7 天</option>'
      + '<option value="30">30 天</option>'
      + '<option value="90">90 天</option>'
      + '</select></label>'
      + '<p class="ns-hint">修改后链接保持不变，旧链接继续可用直到你取消分享。</p>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn" data-close>取消</button>'
      + '<button class="btn primary" id="shm-save">保存</button>'
      + '</div></div>';
    document.body.appendChild(mask);
    const done = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask._onClose = done;
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', done));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(); });
    if (window.OC && window.OC.enhanceSelects) window.OC.enhanceSelects(mask);
    mask.querySelector('#shm-save').addEventListener('click', async () => {
      const mode = (mask.querySelector('input[name="shm-mode"]:checked') || {}).value || 'view-link';
      const expireDays = Number((mask.querySelector('#shm-expire') || {}).value || 0);
      try {
        const r = await apiFetch('/api/notes/share', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ noteId, mode, expireDays, keepToken: true }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
        const share = d.share;
        N.shares = N.shares.filter((x) => x.noteId !== noteId).concat([share]);
        alignShareState();
        persistLocal();
        toast('分享设置已更新（链接不变）');
        done();
        if (typeof onSaved === 'function') onSaved();
      } catch (e) {
        toast(e.message || '保存失败', true);
      }
    });
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
  }

  // ============ 撤销 / 重做 ============
  // 自建历史栈(不依赖浏览器原生 undo:重渲染后原生栈会丢失)。
  // 快照 = {content, title};连续输入按时间窗合并成一步,上限 120 步。
  const HISTORY_LIMIT = 120;
  const HISTORY_MERGE_MS = 700;
  let hist = { noteId: '', stack: [], index: -1, lastAt: 0 };

  function editorSnapshot() {
    if (!N.editor) return null;
    const ti = N.els.bar && N.els.bar.querySelector('#ne-title');
    return { content: N.editor.ta ? N.editor.ta.value : '', title: ti ? ti.value : '' };
  }
  function sameSnapshot(a, b) {
    return !!a && !!b && a.content === b.content && a.title === b.title;
  }
  function resetHistory(noteId) {
    hist = { noteId: noteId || '', stack: [], index: -1, lastAt: 0 };
    const snap = editorSnapshot();
    if (snap) { hist.stack = [snap]; hist.index = 0; }
    syncUndoButtons();
  }
  function pushHistory(opts) {
    opts = opts || {};
    if (!N.editor) return;
    const snap = editorSnapshot();
    if (!snap) return;
    if (hist.noteId !== N.editor.noteId) { resetHistory(N.editor.noteId); return; }
    const cur = hist.stack[hist.index];
    if (sameSnapshot(cur, snap)) return;
    const now = Date.now();
    const mergeable = !opts.force && (now - hist.lastAt) < HISTORY_MERGE_MS && hist.index === hist.stack.length - 1;
    if (mergeable && hist.index > 0) {
      // 连续输入:覆盖栈顶,而不是每敲一个字就记一步
      hist.stack[hist.index] = snap;
    } else {
      hist.stack = hist.stack.slice(0, hist.index + 1);
      hist.stack.push(snap);
      if (hist.stack.length > HISTORY_LIMIT) hist.stack.shift();
      hist.index = hist.stack.length - 1;
    }
    hist.lastAt = now;
    syncUndoButtons();
  }
  function applySnapshot(snap) {
    if (!snap || !N.editor) return;
    const ta = N.editor.ta;
    const ti = N.els.bar && N.els.bar.querySelector('#ne-title');
    if (ta && ta.value !== snap.content) ta.value = snap.content;
    if (ti && ti.value !== snap.title) ti.value = snap.title;
    N.editor.dirty = true;
    setSaveState('editing');
    clearTimeout(N.editor.saveTimer);
    N.editor.saveTimer = setTimeout(saveEditor, 700);
    renderPreview(ta ? ta.value : '');
  }
  function undo() {
    if (!N.editor) return;
    // 先把「尚未入栈的当前输入」记进去,保证第一次 Ctrl+Z 能回到编辑前一刻
    pushHistory();
    if (hist.index <= 0) { toast('已经是最早一步'); return; }
    hist.index--;
    hist.lastAt = 0;
    applySnapshot(hist.stack[hist.index]);
    syncUndoButtons();
  }
  function redo() {
    if (!N.editor) return;
    if (hist.index >= hist.stack.length - 1) { toast('已经是最新一步'); return; }
    hist.index++;
    hist.lastAt = 0;
    applySnapshot(hist.stack[hist.index]);
    syncUndoButtons();
  }
  function syncUndoButtons() {
    const bar = N.els.bar;
    if (!bar) return;
    const u = bar.querySelector('#ne-undo');
    const r = bar.querySelector('#ne-redo');
    if (u) u.disabled = !N.editor || hist.index <= 0;
    if (r) r.disabled = !N.editor || hist.index >= hist.stack.length - 1;
  }

  // 非图片附件:在预览区底部渲染为可下载的文件卡片(而不是只有一行 md 链接)
  function renderAttachCards() {
    const pane = N.els.editorPane;
    const n = noteById(N.ui.selNoteId);
    if (!pane || !n) return;
    const old = pane.querySelector('.notes-attach-cards');
    if (old) old.remove();
    const files = (n.attachments || []).filter((a) => a && a.mimeType && a.mimeType.indexOf('image/') !== 0);
    if (!files.length) return;
    const box = document.createElement('div');
    box.className = 'notes-attach-cards';
    box.innerHTML = '<div class="nac-head">附件（' + files.length + '）</div>' + files.map((a) => ''
      + '<a class="nac-item" href="' + esc(safeUrl(a.url) || '#') + '" target="_blank" rel="noopener noreferrer" download>'
      + '<span class="nac-icon">' + icon('file', 15) + '</span>'
      + '<span class="nac-main"><b>' + esc(a.name || 'file') + '</b><i>' + fmtBytes(a.size) + '</i></span>'
      + '<span class="nac-dl">' + icon('download', 14) + '</span>'
      + '</a>').join('');
    const panes = pane.querySelector('.notes-editor-panes');
    if (panes) panes.parentNode.insertBefore(box, panes.nextSibling);
  }

  function renderPreview(md) {
    const preview = N.editor && N.editor.preview;
    if (!preview) return;
    // 附件走签名 URL 且需身份鉴权:属主本人由浏览器携带登录态即可取用
    if (window.OCRenderer && window.OCRenderer.renderInto) {
      window.OCRenderer.renderInto(preview, md);
    } else {
      preview.textContent = md;
    }
  }

  // 标题输入单独挂(input 委托,编辑器重建间不丢)
  document.addEventListener('input', (e) => {
    if (!N.editor || !N.els.editorPane) return;
    if (e.target && e.target.id === 'ne-title') {
      N.editor.dirty = true;
      pushHistory();
      setSaveState('editing');
      clearTimeout(N.editor.saveTimer);
      N.editor.saveTimer = setTimeout(saveEditor, 900);
    }
  });

  // ============ 新建笔记 / 模板 ============
  const TEMPLATES = [
    { key: 'blank', name: '空白笔记', desc: '从零开始书写', body: '' },
    {
      key: 'meeting', name: '会议纪要', desc: '议题 / 结论 / 待办',
      body: '## 会议信息\n\n- **时间**：\n- **参与人**：\n- **记录人**：\n\n## 议题与讨论\n\n1. \n\n## 结论\n\n- \n\n## 待办事项\n\n- [ ] 事项（负责人，截止时间）\n',
    },
    {
      key: 'study', name: '学习笔记', desc: '概念 / 要点 / 示例',
      body: '## 概念\n\n一句话说清它是什么。\n\n## 要点\n\n- \n\n## 示例\n\n```text\n\n```\n\n## 注意事项与疑问\n\n- \n',
    },
    {
      key: 'project', name: '项目记录', desc: '背景 / 进展 / 风险',
      body: '## 背景\n\n## 目标\n\n## 进展\n\n- [ ] \n\n## 风险与备注\n\n- \n',
    },
  ];

  function templateBody(key) {
    const t = TEMPLATES.find((x) => x.key === key);
    return t ? t.body : '';
  }

  function openNewNoteDialog(anchor) {
    const folderId = N.ui.folderId;
    const items = TEMPLATES.map((t) => ({ value: t.key, label: t.name + ' · ' + t.desc }));
    window.OC.openSelect(anchor || N.els.mask, items, {
      fitWidth: true,
      onSelect: async (key) => {
        const t = TEMPLATES.find((x) => x.key === key);
        const title = await notesPrompt({
          title: '新建' + (t ? t.name : '笔记'),
          message: '标题要可检索;标签用逗号分隔。创建/更新时间在编辑器右上角展示。',
          value: '', maxlength: 200, confirmText: '创建',
        });
        if (title === null) return;
        const name = String(title || '').trim() || (t ? t.name : '无标题笔记');
        const tags = name.match(/#(\S+)/g) ? [] : [];
        const content = t && t.body ? t.body : '';
        const n = createNote(folderId, { title: name, content, tags });
        N.ui.expanded[folderId] = true;
        persistUi();
        openNote(n.id);
        toast('已创建「' + n.title + '」');
      },
    });
  }

  // ============ 上传 ============
  let fileInput = null;
  function pickFiles(imageOnly) {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = '';
        if (files.length) uploadFiles(files);
      });
    }
    fileInput.accept = imageOnly ? 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml' : '';
    fileInput.click();
  }

  function extOf(name) { const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
  function validateFile(f) {
    const ext = extOf(f.name);
    const maxFileMb = (N.usage && Number(N.usage.maxFileMb)) || 50;
    if (IMAGE_EXT.indexOf(ext) >= 0) {
      if (f.size > 10 * 1048576) return '图片不能超过 10MB';
      return '';
    }
    if (N.usage && N.usage.allowFiles === false) return '本站仅允许上传图片附件';
    // 通用文件:仅要求有扩展名(服务端按类型给出 MIME,非图片强制下载)
    if (!ext) return '文件缺少扩展名，无法识别类型';
    if (f.size > maxFileMb * 1048576) return '附件不能超过 ' + maxFileMb + 'MB';
    return '';
  }

  function uploadFiles(files) {
    if (!N.editor || !noteById(N.editor.noteId)) { toast('先选择一篇笔记再上传', true); return; }
    files.forEach((f) => {
      const err = validateFile(f);
      if (err) { toast(f.name + '：' + err, true); return; }
      uploadOne(f);
    });
  }

  function uploadChip(file) {
    const bar = N.els.uploadBar;
    bar.classList.remove('hidden');
    const chip = document.createElement('div');
    chip.className = 'notes-upload-chip uploading';
    chip.innerHTML =
      '<span class="uc-icon">' + icon('upload', 14) + '</span>'
      + '<span class="uc-name" title="' + esc(file.name) + '">' + esc(file.name) + '</span>'
      + '<span class="uc-bar"><i style="width:0%"></i></span>'
      + '<span class="uc-pct">0%</span>'
      + '<button class="uc-act" data-a="cancel" data-tip="取消">' + icon('close', 13) + '</button>';
    bar.appendChild(chip);
    const remove = () => { chip.remove(); if (!bar.children.length) bar.classList.add('hidden'); };
    chip.querySelector('[data-a="cancel"]').addEventListener('click', remove);
    return {
      progress(pct) {
        chip.querySelector('.uc-bar i').style.width = pct + '%';
        chip.querySelector('.uc-pct').textContent = Math.round(pct) + '%';
      },
      done() { chip.classList.remove('uploading'); chip.classList.add('done'); chip.querySelector('.uc-pct').textContent = '完成'; setTimeout(remove, 1400); },
      fail(retry) {
        chip.classList.remove('uploading');
        chip.classList.add('failed');
        chip.querySelector('.uc-pct').textContent = '失败';
        const act = chip.querySelector('.uc-act');
        act.dataset.a = 'retry';
        act.dataset.tip = '重试';
        act.innerHTML = icon('refresh', 13);
        act.onclick = () => { remove(); retry(); };
      },
      remove,
    };
  }

  function uploadOne(file, attempt) {
    const noteId = N.editor && N.editor.noteId;
    const chip = uploadChip(file);
    const doUpload = () => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      // 绑定归属笔记:附件鉴权与「通过分享下载」据此判定
      if (noteId) fd.append('noteId', noteId);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrlOf('/api/notes/upload'));
      xhr.setRequestHeader('Authorization', 'Bearer ' + bearerToken());
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) chip.progress((e.loaded / e.total) * 100);
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data.url) {
          chip.done();
          insertAttachment(noteId, file.name, data);
          refreshUsage();
        } else {
          chip.fail(() => uploadOne(file));
          toast((data && data.error && data.error.message) || ('上传失败（HTTP ' + xhr.status + '）'), true);
        }
      });
      xhr.addEventListener('error', () => { chip.fail(() => uploadOne(file)); });
      xhr.addEventListener('abort', () => chip.remove());
      xhr.send(fd);
    };
    if (attempt === 'retry') doUpload();
    else doUpload();
  }

  function insertAttachment(noteId, name, data) {
    const n = noteById(noteId);
    if (!n || !N.editor) return;
    const isImage = data.mimeType && data.mimeType.indexOf('image/') === 0;
    const snippet = isImage ? ('\n\n![' + name.replace(/[\[\]]/g, '') + '](' + data.url + ')\n\n')
      : ('\n\n[📎 ' + name.replace(/[\[\]]/g, '') + '](' + data.url + ')\n\n');
    const ta = N.editor.ta;
    const pos = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    ta.value = ta.value.slice(0, pos) + snippet.replace(/^\n+/, '\n\n') + ta.value.slice(ta.selectionEnd || pos);
    const att = {
      id: data.id || uid('a'), name: name, url: data.url,
      mimeType: data.mimeType || '', size: Number(data.size) || 0,
      createdAt: Number(data.createdAt) || Date.now(),
    };
    n.attachments = (n.attachments || []).concat([att]);
    N.editor.dirty = true;
    setSaveState('editing');
    saveEditor();
    renderPreview(ta.value);
    renderAttachCards();
  }

  // ============ 分享 ============
  function openShareDialog(noteId) {
    const n = noteById(noteId);
    if (!n) return;
    const s = shareOf(noteId);
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-share-mask hidden';
    mask.innerHTML =
      '<div class="modal notes-share-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>分享「' + esc(n.title) + '」</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body">'
      // 未分享时不需要「仅自己可见」这一项——不生成链接即是私密;
      // 已分享时用底部「关闭分享」取消,语义更直接。
      + '<div class="ns-modes">'
      + '<label class="ns-mode"><input type="radio" name="ns-mode" value="view-link" ' + (!s || s.mode === 'view-link' ? 'checked' : '') + '><div><b>持链接可查看</b><span>任何人拿到链接都能阅读这篇笔记</span></div></label>'
      + '<label class="ns-mode"><input type="radio" name="ns-mode" value="edit-link" ' + (s && s.mode === 'edit-link' ? 'checked' : '') + '><div><b>持链接可编辑</b><span>拿到链接的人可以直接修改笔记内容</span></div></label>'
      + '</div>'
      + '<div class="ns-link-row' + (s ? '' : ' hidden') + '" id="ns-link-row">'
      + '<input readonly id="ns-link" value="' + esc(s ? location.origin + '/n/' + s.token : '') + '">'
      + '<button class="notes-mini-btn" id="ns-copy">' + icon('copy', 13) + '复制</button>'
      + '</div>'
      + '<label class="ns-expire"><span class="ns-expire-label">链接有效期</span>'
      + '<select id="ns-expire">'
      + '<option value="0">永久有效</option>'
      + '<option value="1">1 天</option>'
      + '<option value="7">7 天</option>'
      + '<option value="30">30 天</option>'
      + '<option value="90">90 天</option>'
      + '</select></label>'
      + '<p class="ns-hint" id="ns-hint">' + (s ? '链接实时显示笔记最新内容;重新生成会使旧链接立即失效。' : '开启后可随时关闭或重新生成链接。') + '</p>'
      + '</div>'
      + '<div class="modal-footer">'
      // 「关闭分享」在未分享时也占位(隐藏),生成成功后原地显形,而不是重排页脚
      + '<button class="btn danger' + (s ? '' : ' hidden') + '" id="ns-close-share">' + icon('close', 13) + '关闭分享</button>'
      + '<button class="btn' + (s ? '' : ' hidden') + '" id="ns-regen">重新生成链接</button>'
      // 取消始终存在:生成链接后页脚会多出「关闭分享 / 重新生成」,此前没有退出口,
      // 用户生成完只能点右上角 ×,窄屏上很容易以为卡住了。
      + '<button class="btn" id="ns-cancel">取消</button>'
      + '<button class="btn primary" id="ns-apply">' + (s ? '保存设置' : '生成链接') + '</button>'
      + '</div></div>';
    document.body.appendChild(mask);
    const closeDlg = () => { window.OCUI.closeModal(mask); setTimeout(() => mask.remove(), 340); };
    mask.querySelector('[data-close]').addEventListener('click', closeDlg);
    mask.querySelector('#ns-cancel').addEventListener('click', closeDlg);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeDlg(); });
    const linkRow = mask.querySelector('#ns-link-row');
    // 回填当前有效期(距到期剩余天数就近映射到预设档位)
    if (s && s.expireAt) {
      const leftMs = Number(s.expireAt) - Date.now();
      const leftDays = Math.max(1, Math.round(leftMs / 86400000));
      const selEl = mask.querySelector('#ns-expire');
      const preset = [1, 7, 30, 90].find((d) => leftDays <= d) || 90;
      if (selEl) selEl.value = String(preset);
    }
    const regenBtn = mask.querySelector('#ns-regen');
    const applyBtn = mask.querySelector('#ns-apply');
    const hint = mask.querySelector('#ns-hint');
    const currentMode = () => (mask.querySelector('input[name="ns-mode"]:checked') || {}).value || 'private';

    mask.querySelector('#ns-copy').addEventListener('click', async () => {
      const v = mask.querySelector('#ns-link').value;
      let ok = false;
      if (window.OCUI && window.OCUI.copyText) ok = await window.OCUI.copyText(v);
      else { try { await navigator.clipboard.writeText(v); ok = true; } catch (e) {} }
      toast(ok ? '链接已复制' : '复制失败,请手动选择复制', !ok);
    });

    const showShare = (share) => {
      linkRow.classList.remove('hidden');
      regenBtn.classList.remove('hidden');
      // 生成链接成功后「关闭分享」也要显形,否则新分享没法从这个弹窗撤回
      const closeShareEl = mask.querySelector('#ns-close-share');
      if (closeShareEl) closeShareEl.classList.remove('hidden');
      mask.querySelector('#ns-link').value = location.origin + '/n/' + share.token;
      hint.textContent = '链接实时显示笔记最新内容;重新生成会使旧链接立即失效。';
    };

    applyBtn.addEventListener('click', async () => {
      const mode = currentMode();
      applyBtn.disabled = true;
      try {
        const expireDays = Number((mask.querySelector('#ns-expire') || {}).value || 0);
        {
          const r = await apiFetch('/api/notes/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId, mode, expireDays }) });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((data.error && data.error.message) || '生成分享链接失败');
          const share = data.share;
          N.shares = N.shares.filter((x) => x.noteId !== noteId).concat([share]);
          alignShareState();
          persistLocal();
          showShare(share);
          applyBtn.textContent = '保存设置';
          toast('分享已开启');
        }
      } catch (e) {
        toast(e.message || '操作失败', true);
      } finally {
        applyBtn.disabled = false;
        renderTree();
      }
    });
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      try {
        const mode = currentMode() === 'private' ? 'view-link' : currentMode();
        const r = await apiFetch('/api/notes/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId, mode }) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((data.error && data.error.message) || '重新生成失败');
        const share = data.share;
        N.shares = N.shares.filter((x) => x.noteId !== noteId).concat([share]);
        alignShareState();
        persistLocal();
        showShare(share);
        toast('已重新生成,旧链接已失效');
      } catch (e) {
        toast(e.message || '操作失败', true);
      } finally {
        regenBtn.disabled = false;
      }
    });
    const closeShareBtn = mask.querySelector('#ns-close-share');
    if (closeShareBtn) {
      closeShareBtn.addEventListener('click', async () => {
        closeShareBtn.disabled = true;
        try {
          const r = await apiFetch('/api/notes/share', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId }) });
          if (!r.ok) throw new Error('关闭分享失败');
          N.shares = N.shares.filter((x) => x.noteId !== noteId);
          alignShareState();
          persistLocal();
          toast('分享已关闭');
          closeDlg();
        } catch (e) {
          toast(e.message || '操作失败', true);
        } finally { closeShareBtn.disabled = false; renderTree(); }
      });
    }
    // 原生 select(链接有效期)换成站内自定义下拉
    if (window.OC && window.OC.enhanceSelects) window.OC.enhanceSelects(mask);
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    renderTree();
  }

  // ============ AI 归档:保存到 AI 笔记 ============
  // 系统提示分两档。首轮用完整 JSON 契约(信息最全);模型解析失败或输出被截断时,
  // 降级到「分隔符文本」格式——不用转义、不用闭合括号,结尾被截断也照样能解析,
  // 弱模型(小参数/小上下文)更容易照做。
  const ARCHIVE_SYSTEM_PROMPT = [
    '你是 AI 笔记整理助手。请根据当前用户问题、AI 回答内容和已有笔记目录，',
    '将有长期价值的信息整理为一篇可检索、可复用的 Markdown 笔记。',
    '',
    '要求：',
    '1. 优先选择语义最匹配的已有文件夹。',
    '2. 只有当现有文件夹均不合适时，才创建新文件夹。',
    '3. 新文件夹名称必须简洁、明确、可长期使用，避免「其他」「杂项」「临时」等名称。',
    '4. 新建笔记标题应准确概括核心内容，不得使用「AI 回答」「新笔记」等无意义标题。',
    '5. 不要机械复制原回答；应提炼、分层、结构化，并保留关键细节、限制条件和行动项。',
    '6. 不编造原回答中不存在的事实、数据、来源或结论。',
    '7. 保留必要的代码、公式、表格和链接，并使用标准 Markdown。',
    '8. 在文末添加「来源」区块，记录原始问题、生成时间和对话引用信息。',
    '9. 输出 JSON，字段包括：',
    '   - folderAction: "existing" 或 "create"',
    '   - targetFolderId: 已有文件夹时填写 ID',
    '   - newFolderName: 新建文件夹时填写名称',
    '   - noteTitle',
    '   - tags',
    '   - markdownContent',
    '   - reasoning: 简要说明归档原因',
    '',
    '只输出 JSON,不要输出任何其他文字或代码块围栏。',
  ].join('\n');

  // 降级提示:纯文本 + 显式分隔行。字段顺序固定、正文最后写,
  // 即使模型写不完被截断,前面已写出的字段仍然可用。
  const ARCHIVE_SYSTEM_PROMPT_SIMPLE = [
    '你是 AI 笔记整理助手。把下面的 AI 回答整理成一篇结构化、可检索的 Markdown 笔记。',
    '',
    '严格按下面格式输出，每一行都以标记开头，不要输出 JSON、不要代码块围栏、不要额外说明：',
    '',
    '文件夹ID：填现有文件夹的 id；没有合适的就留空这一行',
    '新文件夹名：只有留空了文件夹ID时才填；否则这一行留空',
    '标题：一句话概括内容',
    '标签：标签1,标签2（最多 6 个，逗号分隔）',
    '理由：一句话说明归档原因',
    '内容：',
    '（从这里开始写 Markdown 正文，提炼分层、保留关键事实与代码，不要复制原文）',
  ].join('\n');

  function findUserQuestion(chat, msg) {
    const msgs = (chat && chat.messages) || [];
    let idx = msgs.indexOf(msg);
    if (idx < 0) idx = msgs.length;
    for (let i = idx - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'user') {
        let t = String(m.text || m.content || '').trim();
        // 去掉附件卡片的 markdown 块,只留提问正文
        t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[📎[^\]]*\]\([^)]*\)/g, '');
        return t.replace(/\s+/g, ' ').trim().slice(0, 400);
      }
    }
    return '';
  }

  // 文件夹树按 token 预算裁剪:文件夹多、笔记标题长时,这段提示本身就能吃掉弱模型的全部窗口
  function folderTreePromptLines(budgetTokens) {
    const all = N.doc.folders.map((f) => ({
      f: f,
      depth: folderDepth(f.id),
      titles: N.doc.notes.filter((n) => n.folderId === f.id).slice(0, 6).map((n) => n.title),
    }));
    const head = all.filter((x) => x.depth === 0);
    const rest = all.filter((x) => x.depth > 0);
    const lines = [];
    let used = 0;
    const cap = budgetTokens || 1200;
    // 顶层文件夹必须全部保留(它们是主要归档目标);子文件夹与笔记标题按预算追加
    const push = (x, titles) => {
      const line = '- ' + '  '.repeat(x.depth) + x.f.name + '（id: ' + x.f.id
        + (x.f.description ? ', 说明: ' + String(x.f.description).slice(0, 40) : '') + '）'
        + (titles.length ? ' 已有笔记: ' + titles.join('、') : '（空）');
      const cost = estimateTokens(line);
      if (used + cost > cap && lines.length) return false;
      used += cost;
      lines.push(line);
      return true;
    };
    head.forEach((x) => push(x, x.titles.slice(0, 4)));
    rest.forEach((x) => push(x, x.titles.slice(0, 2)));
    return lines;
  }
  function estimateTokens(s) {
    if (window.OCApp && window.OCApp.estimateTextTokens) return window.OCApp.estimateTextTokens(s);
    const str = String(s || '');
    const cjk = (str.match(/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaf6\uff00-\uffef]/g) || []).length;
    return Math.round(cjk + (str.length - cjk) / 4);
  }
  // 归档请求的输入预算:窗口 − 输出预留 − 提示词与文件夹树开销。
  // 弱模型窗口可能只有 8k,这里必须真的按 token 裁,不能只按字符数切一刀。
  // 返回值同时给出建议的输出上限:窗口很小时先把输出压下来,把位置让给输入,
  // 否则「输入满 + 输出要 8192」会被上游直接拒绝(输入+输出超过窗口)。
  function archiveBudgets(systemPrompt, folderLines) {
    const caps = (window.OCApp && window.OCApp.modelCapsNow) ? window.OCApp.modelCapsNow() : { out: 8192, ctx: 131072 };
    const ctx = Number(caps.ctx) > 0 ? Number(caps.ctx) : 131072;
    const capOut = Number(caps.out) > 0 ? Number(caps.out) : 8192;
    const overhead = estimateTokens(systemPrompt) + estimateTokens(folderLines.join('\n')) + 400;
    const MIN_IN = 1500;   // 正文至少要留这么多,否则整理没有意义
    let reserve = Math.min(capOut, 8192);
    let budget = ctx - reserve - overhead;
    if (budget < MIN_IN) {
      reserve = Math.max(512, ctx - overhead - MIN_IN);
      budget = ctx - reserve - overhead;
    }
    return { input: Math.max(512, budget), output: Math.max(512, Math.min(reserve, capOut)) };
  }
  // 按 token 预算截断长文本,尽量在段落边界收尾
  function truncateToTokens(text, maxTokens) {
    const src = String(text || '');
    if (estimateTokens(src) <= maxTokens) return src;
    const cjkChars = (src.match(/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaf6\uff00-\uffef]/g) || []).length;
    // 按中文密度估算可保留的字符数(中文 1 字≈1 token,英文 4 字符≈1 token)
    const ratio = src.length ? cjkChars / src.length : 0;
    const perChar = ratio + (1 - ratio) / 4;
    let chars = Math.max(200, Math.floor((maxTokens / Math.max(perChar, 0.2)) * 0.95));
    if (chars >= src.length) return src;
    let cut = src.slice(0, chars);
    const br = cut.lastIndexOf('\n\n');
    if (br > chars * 0.6) cut = cut.slice(0, br);
    return cut + '\n\n……（内容过长，已截断。请就以上部分整理，不要编造被截断的内容）';
  }

  async function archiveFromMessage(chat, msg) {
    if (!(await ensureLoaded())) { toast('请先登录后再使用 AI 笔记', true); return; }
    const question = findUserQuestion(chat, msg);
    const answer = String(msg.content || '');
    const dlg = buildArchiveDialog();
    showArchiveLoading(dlg);

    let cancelled = false;
    dlg._onClose = () => { cancelled = true; };
    // Esc 由 ui.js 的全局处理器直接关闭弹窗(不经过 _onClose),所以还要看
    // 弹窗是否还在 DOM 里、以及是否已被重新加上 .hidden:任一不成立就说明
    // 用户已经放弃这次整理,迟到的响应不得再往弹窗里写内容。
    // (用 .hidden 而不是 .show——后者是打开动画下一帧才加上的。)
    const alive = () => !cancelled && document.body.contains(dlg) && !dlg.classList.contains('hidden');

    let plan = null;
    let lastErr = null;
    // 两轮:第 1 轮完整 JSON 契约;第 2 轮换「分隔符文本」降级格式并缩短输入。
    // 两轮用的是不同提示与不同输入长度,不是把同一个注定失败的请求重发一遍。
    for (let attempt = 0; attempt < 2 && !plan && !cancelled; attempt++) {
      const simple = attempt > 0;
      const sys = simple ? ARCHIVE_SYSTEM_PROMPT_SIMPLE : ARCHIVE_SYSTEM_PROMPT;
      const folderLines = folderTreePromptLines(simple ? 600 : 1200);
      const budgets = archiveBudgets(sys, folderLines);
      const answerForPrompt = truncateToTokens(answer, budgets.input);
      const truncated = answerForPrompt.length < answer.length;
      const context = [
        '## 当前对话主题',
        (chat && chat.title) || '（无标题对话）',
        '',
        '## 用户问题',
        question || '（未找到原始问题）',
        '',
        '## AI 回答全文',
        answerForPrompt,
        '',
        '## 现有笔记文件夹树（含层级与已有笔记标题摘要）',
        folderLines.join('\n') || '（还没有任何文件夹,只有默认的「默认分类」）',
        '',
        '## 用户指定文件夹',
        '无',
        '',
        simple ? '请按系统要求的纯文本格式输出。' : '请按系统要求输出 JSON。',
      ].join('\n');

      try {
        if (alive()) showArchiveLoading(dlg, simple);
        const text = await window.OCApp.aiComplete(
          [{ role: 'system', content: sys }, { role: 'user', content: context }],
          { purpose: 'note', maxTokens: budgets.output }
        );
        plan = simple ? parseArchivePlanLoose(text) : parseArchivePlan(text);
        if (!plan) lastErr = new Error(simple ? 'AI 返回的内容无法解析为结构化结果' : 'AI 字段不完整，正在换一种更简单的格式重试');
        else if (truncated) plan._truncated = true;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!plan) {
      if (cancelled || !alive()) return;
      showArchiveError(dlg, (lastErr && lastErr.message) || '整理失败', () => ({
        folderAction: 'create', newFolderName: UNCATA_LABEL, noteTitle: (question || '笔记').slice(0, 60),
        tags: [], markdownContent: answer, reasoning: 'AI 整理失败,直接保存原文。',
        _forceFolder: UNCATA,
      }), question, answer, () => archiveFromMessage(chat, msg));
      return;
    }
    if (cancelled || !alive()) return;
    showArchivePlan(dlg, plan, { chat, msg, question, answer });
  }

  // 从正文推导标题:优先一级/任意级标题,其次首个非空行(去掉 Markdown 标记)
  function deriveTitle(content) {
    const lines = String(content || '').split(/\r?\n/);
    for (const line of lines) {
      const h = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (h) return h[1].replace(/[*_`]/g, '').trim().slice(0, 60);
    }
    for (const line of lines) {
      const t = line.replace(/^\s*(?:[-*+>]\s+|\d+[.、)]\s+)/, '').replace(/[*_`#]/g, '').trim();
      if (t) return t.slice(0, 60);
    }
    return '';
  }

  // JSON 修复:弱模型常见的三种坏味道——字符串里有裸换行、尾逗号、括号没闭合(写一半被截断)。
  // 修不好也不提前放弃:截断在正文中间时,补上引号与括号后仍能取回已写出的部分。
  function repairJson(s) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = false; out += ch; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
        if (ch < ' ') { out += ' '; continue; }
        out += ch;
        continue;
      }
      if (ch === '"') { inStr = true; out += ch; continue; }
      if (ch === ',') {
        // 尾逗号:逗号后除空白外直接是 } 或 ] 时丢弃
        let k = i + 1;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (k < s.length && (s[k] === '}' || s[k] === ']')) continue;
        out += ch;
        continue;
      }
      out += ch;
    }
    if (inStr) out += '"';
    // 补齐未闭合的括号(末尾被截断时的补救)
    const stack = [];
    let q = false;
    let e2 = false;
    for (let i = 0; i < out.length; i++) {
      const ch = out[i];
      if (q) {
        if (e2) { e2 = false; continue; }
        if (ch === '\\') { e2 = true; continue; }
        if (ch === '"') q = false;
        continue;
      }
      if (ch === '"') { q = true; continue; }
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    while (stack.length) out += stack.pop() === '{' ? '}' : ']';
    return out;
  }

  // 字段归一:两个解析器共用。容忍 tags 是字符串、标题缺失、folderAction 缺失等情况。
  function normalizeArchivePlan(src) {
    const content = String(src.content || '').trim();
    if (!content) return null;
    let tags = src.tags;
    if (typeof tags === 'string') tags = tags.split(/[,，、;；\n]+/);
    tags = Array.isArray(tags)
      ? tags.map((x) => String(x).trim().replace(/^[#\-\s]+/, '')).filter(Boolean).slice(0, 20)
      : [];
    const newFolderName = String(src.newFolderName || '').trim().slice(0, 80);
    const targetFolderId = String(src.targetFolderId || '').trim();
    let action = String(src.folderAction || '').toLowerCase();
    if (action !== 'create' && action !== 'existing') {
      action = targetFolderId ? 'existing' : (newFolderName ? 'create' : 'existing');
    }
    const title = String(src.title || '').trim() || deriveTitle(content);
    return {
      folderAction: action,
      targetFolderId: targetFolderId,
      newFolderName: newFolderName,
      noteTitle: (title || '无标题笔记').slice(0, 200),
      tags: tags,
      markdownContent: content,
      reasoning: String(src.reasoning || '').trim(),
    };
  }

  function parseArchivePlan(text) {
    let t = String(text || '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const s = t.indexOf('{');
    if (s < 0) return null;
    const e = t.lastIndexOf('}');
    // 有闭合括号就取整段;没有(被截断)则从 { 一路取到尾交给修复器补括号
    const body = (e > s) ? t.slice(s, e + 1) : t.slice(s);
    let j = null;
    try { j = JSON.parse(body); } catch (e1) { /* 落到修复解析 */ }
    if (!j || typeof j !== 'object') {
      try { j = JSON.parse(repairJson(body)); } catch (e2) { return null; }
    }
    if (!j || typeof j !== 'object') return null;
    return normalizeArchivePlan({
      folderAction: j.folderAction,
      targetFolderId: j.targetFolderId || j.folderId || j.folder_id || '',
      newFolderName: j.newFolderName || j.folderName || j.new_folder_name || '',
      title: j.noteTitle || j.title || j.note_title || '',
      tags: j.tags || j.tag || [],
      content: j.markdownContent || j.content || j.markdown || j.body || '',
      reasoning: j.reasoning || j.reason || '',
    });
  }

  // 降级解析:纯文本标记格式。不用转义、不用闭合括号,被截断也能拿到正文。
  const LOOSE_KEYS = {
    '文件夹id': 'targetFolderId', 'folderid': 'targetFolderId', 'folder_id': 'targetFolderId',
    '目标文件夹': 'targetFolderId', 'folderaction': 'folderAction', 'folder_action': 'folderAction',
    '新文件夹名': 'newFolderName', '新文件夹名称': 'newFolderName', '新文件夹': 'newFolderName',
    '文件夹名': 'newFolderName', 'newfoldername': 'newFolderName', 'new_folder_name': 'newFolderName',
    '标题': 'title', '笔记标题': 'title', 'title': 'title', 'notetitle': 'title', 'note_title': 'title',
    '标签': 'tags', 'tags': 'tags', 'tag': 'tags',
    '理由': 'reasoning', '归档理由': 'reasoning', 'reasoning': 'reasoning', 'reason': 'reasoning',
    '内容': '__content', '正文': '__content', '笔记内容': '__content',
    'markdowncontent': '__content', 'content': '__content', 'markdown': '__content',
  };
  function parseArchivePlanLoose(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    let t = raw.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    const lines = t.split(/\r?\n/);
    const val = {};
    let contentAt = -1;
    let contentInline = '';
    for (let i = 0; i < lines.length; i++) {
      // 容忍:列表符号、**加粗**、中英文冒号、键名前后空格、snake_case 键名
      const m = lines[i].match(/^\s*(?:[-*+]\s+|\d+[.、)]\s+)?(?:\*\*|__)?\s*([^：:*\n]{1,24}?)\s*(?:\*\*|__)?\s*[：:]\s*(.*)$/);
      if (!m) continue;
      const key = LOOSE_KEYS[m[1].replace(/\s+/g, '').toLowerCase()] || LOOSE_KEYS[m[1].replace(/\s+/g, '')];
      if (!key) continue;
      if (key === '__content') {
        contentAt = i;
        contentInline = m[2];
        break;
      }
      if (val[key] === undefined) val[key] = m[2].trim();
    }
    let content;
    if (contentAt >= 0) content = [contentInline].concat(lines.slice(contentAt + 1)).join('\n').trim();
    else content = t.replace(/^```[a-zA-Z]*\s*/, '').trim();  // 没有标记:整段当正文(弱模型常直接写笔记)
    if (!content) return null;
    // 文件夹:先按 id 匹配,再按名称匹配(弱模型常回名字而不是 id)
    let targetId = String(val.targetFolderId || '').trim();
    if (targetId && !folderById(targetId)) {
      const byName = N.doc.folders.find((f) => f.name === targetId);
      if (byName) targetId = byName.id;
      else if (!val.newFolderName) { val.newFolderName = targetId; targetId = ''; }
      else targetId = '';
    }
    let action = String(val.folderAction || '').toLowerCase();
    if (action !== 'create' && action !== 'existing') action = targetId ? 'existing' : (val.newFolderName ? 'create' : 'existing');
    return normalizeArchivePlan({
      folderAction: action,
      targetFolderId: targetId,
      newFolderName: val.newFolderName,
      title: val.title,
      tags: val.tags,
      content: content,
      reasoning: val.reasoning,
    });
  }

  function buildArchiveDialog() {
    const old = document.getElementById('notes-ai-mask');
    if (old) old.remove();
    const mask = document.createElement('div');
    mask.className = 'modal-mask notes-ai-mask hidden';
    mask.id = 'notes-ai-mask';
    mask.innerHTML =
      '<div class="modal notes-ai-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + icon('noteSave', 16) + ' AI 整理预览</h3>'
      + '<button class="notes-icon-btn" data-close>' + icon('close', 15) + '</button></div>'
      + '<div class="modal-body" id="nai-body"></div>'
      + '<div class="modal-footer" id="nai-foot"></div>'
      + '</div>';
    document.body.appendChild(mask);
    mask.querySelector('[data-close]').addEventListener('click', () => closeArchiveDialog(mask));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.querySelector('[data-close]').click(); });
    // Esc / 点遮罩关闭时把等待中的 AI 请求作废(见 archiveFromMessage 的 alive()):
    // 否则请求回来后还会往已移除的弹窗里写内容,或反过来把用户关掉弹窗的动作当没发生。
    if (window.OCUI) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    return mask;
  }

  function closeArchiveDialog(mask) {
    if (!mask) return;
    if (mask._onClose) { const fn = mask._onClose; mask._onClose = null; fn(); }
    if (window.OCUI) window.OCUI.closeModal(mask);
    setTimeout(() => mask.remove(), 340);
  }

  function showArchiveLoading(mask, retryStage) {
    mask.querySelector('#nai-body').innerHTML =
      '<div class="nai-loading"><span class="nai-spinner"></span>'
      + (retryStage
        ? '<p>正在换用更简单的格式重新整理…</p>'
          + '<p class="muted">上次的返回格式无法解析，这次让模型直接输出纯文本笔记。</p>'
        : '<p>AI 正在整理回答并选择归档位置…</p>'
          + '<p class="muted">它会根据现有笔记目录判断最合适的文件夹,并生成结构化笔记。</p>')
      + '</div>';
    mask.querySelector('#nai-foot').innerHTML = '';
  }

  function showArchiveError(mask, message, fallbackPlanFn, question, answer, retryFn) {
    const body = mask.querySelector('#nai-body');
    const foot = mask.querySelector('#nai-foot');
    body.innerHTML =
      '<div class="nai-error"><p>' + esc(message) + '</p>'
      + '<p class="muted">可以让 AI 重试,也可以把原始回答不做加工直接存入「默认分类」。</p></div>';
    foot.innerHTML =
      '<button class="btn" id="nai-cancel">取消</button>'
      + '<button class="btn" id="nai-raw">直接保存原文</button>'
      + '<button class="btn primary" id="nai-retry">重试 AI 整理</button>';
    foot.querySelector('#nai-cancel').addEventListener('click', () => closeArchiveDialog(mask));
    foot.querySelector('#nai-raw').addEventListener('click', () => {
      const plan = fallbackPlanFn();
      plan._direct = true;
      showArchivePlan(mask, plan, { chat: null, msg: null, question, answer });
    });
    foot.querySelector('#nai-retry').addEventListener('click', () => {
      closeArchiveDialog(mask);
      if (typeof retryFn === 'function') retryFn();
    });
  }

  function showArchivePlan(mask, plan, ctx) {
    const body = mask.querySelector('#nai-body');
    const foot = mask.querySelector('#nai-foot');
    // 文件夹选项:existing 计划若指向不存在的 id,自动降级为「新建」
    let folderId = plan.targetFolderId;
    if (plan.folderAction === 'existing' && !folderById(folderId)) {
      plan.folderAction = 'create';
      folderId = '';
    }
    // 既没给已有文件夹、也没给新文件夹名(弱模型只写了正文时的常见情形):
    // 落「默认分类」即可保存;否则会弹「请填写新文件夹名称」把用户卡在这一步。
    if (plan.folderAction === 'create' && !plan.newFolderName && !plan._forceFolder) {
      plan.folderAction = 'existing';
      folderId = UNCATA;
    }
    const recommendedName = plan.folderAction === 'create'
      ? (plan.newFolderName || (plan._forceFolder ? UNCATA_LABEL : ''))
      : folderName(folderId);
    const direct = !!plan._direct;
    body.innerHTML =
      '<div class="nai-reason">' + icon('spark', 13) + ' ' + esc(plan.reasoning || '已根据内容主题选择归档位置。') + '</div>'
      + (plan._truncated
        ? '<p class="nai-warn">' + icon('wrench', 12) + ' 原回答较长,已按当前模型的上下文窗口截取前半部分整理。需要完整内容可改用上下文更大的模型,或直接「保存原文」。</p>'
        : '')
      + '<div class="nai-grid">'
      + '<label class="nai-field"><span>归档文件夹</span>'
      + '<div class="nai-folder-row">'
      + '<select id="nai-folder"></select>'
      + '<input id="nai-newfolder" class="hidden" placeholder="新文件夹名称（如：前端开发）" maxlength="80">'
      + '</div></label>'
      + '<label class="nai-field"><span>笔记标题</span><input id="nai-title" value="' + esc(plan.noteTitle) + '" maxlength="200" ' + (direct ? 'readonly' : '') + '></label>'
      + '<label class="nai-field"><span>标签（逗号分隔）</span><input id="nai-tags" value="' + esc(plan.tags.join(', ')) + '" ' + (direct ? 'readonly' : '') + '></label>'
      + '</div>'
      + '<div class="nai-content-head">'
      + '<span>笔记内容</span>'
      + '<button class="notes-mini-btn" id="nai-toggle">' + icon('eye', 13) + '查看 Markdown 源码</button>'
      + '</div>'
      + '<div class="nai-content">'
      + '<div class="nai-preview msg assistant"><div class="msg-content" id="nai-preview"></div></div>'
      + '<textarea id="nai-ta" class="hidden" spellcheck="false"></textarea>'
      + '</div>'
      + (direct ? '' : '<p class="nai-tip">文末会自动追加「来源」区块（原始问题、整理时间与对话引用），保存后可随时编辑。</p>');

    const sel = body.querySelector('#nai-folder');
    const newInput = body.querySelector('#nai-newfolder');
    const ta = body.querySelector('#nai-ta');
    const previewBox = body.querySelector('#nai-preview');
    // 归档文件夹下拉是原生 select,换成站内控件;syncFolderBox 必须在使用它的
    // fillFolderOptions 之前声明——否则 const 的暂时性死区会让 fillFolderOptions
    // 抛 ReferenceError,弹窗只画出空内容区、底部按钮永远不生成。
    let folderBox = null;
    const syncFolderBox = () => { if (folderBox && folderBox.syncLabel) folderBox.syncLabel(); };

    const commit = async () => {
      // 收集最终值(直接保存=AI 推荐;确认保存=表单当前值)
      let targetId = sel.value;
      if (targetId === '__create__') {
        const name = (newInput.value || '').trim();
        if (!name) { toast('请填写新文件夹名称', true); return; }
        const exist = N.doc.folders.find((f) => f.name === name);
        targetId = exist ? exist.id : createFolder(name, null, { silent: true }).id;
      }
      const title = (body.querySelector('#nai-title').value || '').trim() || plan.noteTitle;
      const tags = (body.querySelector('#nai-tags').value || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
      const md = ta.value;
      const sourceLines = [];
      if (ctx.question) sourceLines.push('- **原始问题**：' + ctx.question.replace(/\n/g, ' '));
      sourceLines.push('- **整理时间**：' + fmtFull(Date.now()));
      if (ctx.chat && ctx.chat.id) sourceLines.push('- **对话**：' + ((ctx.chat.title || '未命名对话') + '（ID: ' + ctx.chat.id + '）'));
      const content = md + '\n\n---\n\n## 来源\n\n'
        + sourceLines.join('\n') + '\n\n> 本笔记由 AI 自动整理生成,可直接修改。';
      const note = createNote(targetId, {
        title, tags, content,
        source: {
          conversationId: (ctx.chat && ctx.chat.id) || '',
          messageId: '',
          userQuestion: (ctx.question || '').slice(0, 2000),
          generatedByAI: true,
        },
      });
      pushNow();
      closeArchiveDialog(mask);
      toast('已保存到 AI 笔记「' + folderName(targetId) + ' / ' + title + '」');
      // 若笔记弹窗开着,刷新视图并选中
      if (N.els.mask && N.els.mask.classList.contains('show')) {
        N.ui.folderId = targetId;
        N.ui.search = '';
        persistUi();
        openNote(note.id);
        renderAll();
      }
    };

    // 先挂底部操作按钮,再做其余渲染:即便下拉/预览环节出错,用户仍有「取消 / 保存」可用,
    // 不会留下一个既没内容又没按钮的死弹窗。
    // 只保留一个「保存」:各字段已用 AI 推荐值预填,commit 读的是表单**当前值**,
    // 用户改过就存改后的,没改就存推荐值。此前额外的「直接保存（使用 AI 推荐）」
    // 会用推荐值覆盖用户输入,语义上与「保存」冲突,容易误把改好的内容冲掉。
    foot.innerHTML = '<button class="btn" id="nai-cancel">取消</button>'
      + '<button class="btn primary" id="nai-save">保存</button>';
    foot.querySelector('#nai-cancel').addEventListener('click', () => closeArchiveDialog(mask));
    foot.querySelector('#nai-save').addEventListener('click', () => { commit(); });

    // 正文先落到 textarea:它是保存时的取值来源,必须无条件写入;
    // 渲染预览属于「锦上添花」,失败不影响保存内容。
    ta.value = plan.markdownContent;
    const fillFolderOptions = (selectedId) => {
      const opts = [];
      N.doc.folders.slice().sort((a, b) => folderDepth(a.id) - folderDepth(b.id)).forEach((f) => {
        opts.push('<option value="' + esc(f.id) + '">' + '　'.repeat(folderDepth(f.id)) + esc(f.name) + '</option>');
      });
      opts.push('<option value="__create__">➕ 新建文件夹…</option>');
      sel.innerHTML = opts.join('');
      sel.value = selectedId || (plan._forceFolder || '');
      if (!sel.value) sel.value = UNCATA;
      syncFolderBox();
    };
    try {
      if (window.OC && window.OC.enhanceSelect) {
        folderBox = window.OC.enhanceSelect(sel, { className: 'nai-folder-box' });
      }
      // 选项必须在 enhanceSelect 之后填充:enhanceSelect 会劫持 value 的 setter,
      // 先填充则显示文字停留在空选项上(下拉看着是空的)。
      fillFolderOptions(plan.folderAction === 'existing' ? folderId : (plan._forceFolder || '__create__'));
      if (plan.folderAction === 'create' && !plan._forceFolder) {
        sel.value = '__create__';
        newInput.classList.remove('hidden');
        newInput.value = recommendedName || '';
        syncFolderBox();
      }
      sel.addEventListener('change', () => {
        if (sel.value === '__create__') newInput.classList.remove('hidden');
        else newInput.classList.add('hidden');
      });
    } catch (e) {
      // 下拉装载失败不能拖垮整个弹窗:退回原生 select,至少还能选文件夹保存
      try { fillFolderOptions(plan.folderAction === 'existing' ? folderId : (plan._forceFolder || '__create__')); } catch (e2) {}
    }
    try {
      if (window.OCRenderer) window.OCRenderer.renderInto(previewBox, plan.markdownContent);
      else previewBox.textContent = plan.markdownContent;
    } catch (e) {
      previewBox.textContent = plan.markdownContent;
    }
    const toggleBtn = body.querySelector('#nai-toggle');
    if (toggleBtn) {
      // 预览与源码是同一块内容的两种呈现,必须互斥:此前只切 textarea 的 hidden,
      // 预览区一直留着,于是「切到源码」后渲染结果与源码框上下并存,源码框被挤到
      // 可视区之外——用户看到的是「点了没反应、也看不到源码」。
      const showSource = (on) => {
        previewBox.classList.toggle('hidden', on);
        ta.classList.toggle('hidden', !on);
        toggleBtn.innerHTML = on
          ? icon('eye', 13) + '查看渲染效果'
          : icon('edit', 13) + '查看 Markdown 源码';
      };
      toggleBtn.addEventListener('click', () => {
        const toSource = ta.classList.contains('hidden');
        if (!toSource) {
          try {
            if (window.OCRenderer) window.OCRenderer.renderInto(previewBox, ta.value);
            else previewBox.textContent = ta.value;
          } catch (e) { previewBox.textContent = ta.value; }
        }
        showSource(toSource);
        // 切到源码后把光标放进文本框,直接可编辑(少一次点击)
        if (toSource) { try { ta.focus(); } catch (e) {} }
      });
    }
  }

  // ============ 入口 ============
  // 入口按后台开关显示(公开配置 cached 在 localStorage['oc_cfg'])
  function notesFeatureEnabled() {
    try {
      const cfg = JSON.parse(localStorage.getItem('oc_cfg') || 'null');
      if (cfg && typeof cfg.notesEnabled === 'boolean' && !cfg.notesEnabled) return false;
    } catch (e) {}
    // 总开关之外还有「仅管理员 / 仅名单」这层按人判定(/api/me 下发)
    if (window.OCFeatures && !window.OCFeatures.allowed('notes')) return false;
    return true;
  }
  function initEntry() {
    const btn = document.getElementById('notes-entry-btn');
    if (btn && !notesFeatureEnabled()) btn.classList.add('hidden');
    if (btn) {
      const iconEl = document.getElementById('notes-entry-icon');
      if (iconEl && window.OC && OC.icon) iconEl.innerHTML = OC.icon('notebook', 15);
      btn.addEventListener('click', open);
      // /api/me 带回按人判定后会广播:入口可能先渲染、权限后到(或反之),这里重判一次
      window.addEventListener('oc:features', () => {
        const ok = notesFeatureEnabled();
        btn.classList.toggle('hidden', !ok);
        if (!ok && N.ready && N.els.mask && N.els.mask.classList.contains('show')) close();
      });
    }
    // 直接访问 /ainotes(或刷新)时自动进入笔记;登录态未就绪时等 app 初始化完再试
    if (isNotesPath()) {
      let tries = 0;
      const boot = async () => {
        tries++;
        const st = window.OCApp && window.OCApp.state;
        if (st && st.user) { open({ boot: true }); return; }
        if (tries < 40) { setTimeout(boot, 250); return; }
        // 10 秒还没等到登录态:刻意不自动开(未登录时笔记接口会 401,开了也是空壳),
        // 但必须让用户知道发生了什么 —— 否则停在对话页,看起来像 /ainotes 这个地址坏了。
        if (!st || !st.user) {
          toast('登录状态未就绪，笔记暂未打开；请刷新页面或重新登录', true);
        }
      };
      boot();
    }
    // 浏览器前进/后退:地址与模块状态保持一致
    window.addEventListener('resize', () => {
      if (!N.ready) return;
      // 变宽后抽屉状态没有意义(宽屏是常驻侧栏),清掉免得回到窄屏时"半开"
      if (!isNarrow()) N.ui.mobileSide = false;
      applySideState();
    });
    window.addEventListener('popstate', () => {
      const shown = N.els.mask && N.els.mask.classList.contains('show');
      if (isNotesPath() && !shown) open();
      else if (!isNotesPath() && shown) close();
    });
  }

  // 对话页 @笔记需要笔记数据:进入对话页后静默预热一次(不弹界面),
  // 否则用户没打开过笔记时 @ 候选里看不到任何笔记。
  function warmUp() {
    if (!ensureUser()) return Promise.resolve(false);
    return loadLocalDoc().then(() => {
      if (N.ready) return true;
      return new Promise((resolve) => {
        N.ready = true;
        alignShareState();
        pullFromCloud().finally(() => {
          // 预热后不自动开界面,只让数据可用
          resolve(true);
        });
      });
    });
  }

  // 设置云同步应用了云端设置后调用:重载笔记界面状态(AI 动作配置读取时实时生效)
  function applySyncedSettings() {
    loadUi();
    if (N.ready) renderAll();
  }

  window.OCNotes = {
    open,
    close,
    archiveFromMessage,
    openShareManager,
    warmUp,
    applySyncedSettings,
    isReady: () => !!N.ready,
    listNotes: () => (N.doc.notes || []).map((n) => ({ id: n.id, title: n.title, tags: n.tags || [], content: n.content || '', updatedAt: n.updatedAt })),
    searchNotes: (q, limit) => recallNotes(q, limit || 5).map((h) => ({ id: h.note.id, title: h.note.title, content: h.note.content })),
    _debug: N,
    // 供 tests/notes-archive.js 直接验证解析器:弱模型的输出千奇百怪,
    // 解析必须能在无浏览器环境下被穷举回归。
    _parse: { strict: parseArchivePlan, loose: parseArchivePlanLoose, repairJson, truncateToTokens, estimateTokens },
    _budgets: archiveBudgets,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEntry);
  else initEntry();
})();
