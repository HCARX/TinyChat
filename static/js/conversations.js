'use strict';
/**
 * conversations.js — 会话管理增强
 *  - 侧边栏搜索 / 置顶 / 重命名 / 删除
 *  - 对话分支（Branch）
 *  - 键盘快捷键
 *  - 对话历史持久化
 */

(function () {
  const C = {};

  // ============ 统一线标(见 icons.js) ============
  const ic = window.OC ? window.OC.icon : function (n) { return ''; };
  const I = {
    chat: ic('chat', 15),
    pin: ic('pin', 15),
    pinOff: ic('pinOff', 15),
    rename: ic('edit', 15),
    branch: ic('branch', 15),
    del: ic('trash', 15),
    group: {
      '今天': ic('clock', 14),
      '昨天': ic('sun', 14),
      '本周': ic('calendar', 14),
      '更早': ic('refresh', 14),
    },
  };
  const ITEM_HTML = (c, activeCls) => {
    // 群聊会话用群聊图标标识;普通对话优先显示所用模型的 logo
    const logo = c.groupId
      ? (window.OC && OC.icon ? OC.icon('group', 15) : I.chat)
      : (window.OC && OC.chatLogo && OC.logoImg ? OC.logoImg(OC.chatLogo(c), 'chat-logo') : (c.pinned ? I.pin : I.chat));
    // 置顶标识:模型 logo 会盖住旧的 pin 图标方案,这里独立挂在标题后,始终可见
    const pinMark = c.pinned
      ? '<span class="chat-pin-mark" data-tip="已置顶" aria-label="已置顶">' + (window.OC && OC.icon ? OC.icon('pinMark', 12) : I.pin) + '</span>'
      : '';
    return '<span class="chat-icon">' + logo + '</span>'
      + '<span class="chat-title">' + escapeHtml(c.title || '新对话') + '</span>'
      + pinMark;
  };
  const MENU_HTML = '<button class="menu-btn more-btn" data-act="more" data-tip="更多操作" aria-label="更多操作">' + ic('more', 16) + '</button>';

  // 点击「更多」按钮弹出操作菜单(复用全局下拉组件,支持外点/Esc/滚动关闭)
  function openItemMenu(trigger, c, item, opts) {
    const items = [
      { value: 'pin', label: c.pinned ? '取消置顶' : '置顶', sub: c.pinned ? '已置顶' : '' },
      { value: 'rename', label: '重命名' },
      { value: 'share', label: '分享对话', sub: '生成公开链接' },
      { value: 'branch', label: '创建分支', sub: '复制全部消息' },
      { value: 'del', label: '删除', sub: '不可恢复' },
    ];
    if (!window.OC || !window.OC.openSelect) return;
    window.OC.openSelect(trigger, items, {
      selected: null,
      onSelect: (value) => {
        if (value === 'pin' && opts.onTogglePin) opts.onTogglePin(c);
        else if (value === 'rename' && opts.onRename) opts.onRename(c, item);
        else if (value === 'share' && opts.onShare) opts.onShare(c);
        else if (value === 'branch' && opts.onBranch) opts.onBranch(c);
        else if (value === 'del' && opts.onDelete) opts.onDelete(c);
      },
    });
  }

  C.normalize = function (chats) {
    return (chats || []).map((c) => ({
      pinned: false,
      branchOf: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...c,
    }));
  };

  // ============ 侧边栏渲染（含搜索/置顶/重命名） ============
  /**
   * @param {HTMLElement} listEl #chat-list
   * @param {Array} chats
   * @param {object} opts {currentId, onSelect, onDelete, onRename, onTogglePin, onShare, onBranch}
   */
  C.renderList = function (listEl, chats, opts = {}) {
    const sorted = [...chats].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const prevInput = document.getElementById('chat-search-input');
    const prevKeyword = prevInput ? prevInput.value : (C._searchKeyword || '');
    const keepFocus = !!(prevInput && document.activeElement === prevInput);
    const keepSelStart = keepFocus ? prevInput.selectionStart : null;
    const keepSelEnd = keepFocus ? prevInput.selectionEnd : null;

    listEl.innerHTML = '';

    const filterInput = document.createElement('div');
    filterInput.className = 'chat-search';
    filterInput.innerHTML = (window.OC ? window.OC.icon('search', 13) : '')
      + '<input type="search" id="chat-search-input" placeholder="搜索对话…" value="" autocomplete="off" spellcheck="false">';
    listEl.appendChild(filterInput);

    const searchInput = filterInput.querySelector('input');
    let keyword = prevKeyword;
    C._searchKeyword = keyword;
    searchInput.value = keyword;
    if (keepFocus) {
      requestAnimationFrame(() => {
        searchInput.focus();
        if (keepSelStart != null) {
          try { searchInput.setSelectionRange(keepSelStart, keepSelEnd); } catch (e) { /* ignore */ }
        }
      });
    }

    // 会话项的可访问性:div 上的 click 只对鼠标生效,键盘用户完全打不开会话。
    // 统一挂上 role=button + tabindex + Enter/Space 处理,两条渲染分支共用。
    const wireItem = (item, c, opts) => {
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.addEventListener('click', (e) => {
        if (e.target.closest('.chat-item-menu')) return;
        // 点到内联重命名输入框不能当成「选中会话」:选中会重渲染整份列表,正在编辑的
        // 输入框被换掉 → 触发 blur → 立刻按原值提交。用户看到的就是「点一下输入框,
        // 还没改就保存了,根本没法点进去修改」。
        if (e.target.closest('.rename-input')) return;
        if (opts.onSelect) opts.onSelect(c);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        // 焦点在菜单按钮/内联重命名输入框上时,回车归它们
        if (e.target !== item) return;
        e.preventDefault();
        if (opts.onSelect) opts.onSelect(c);
      });
    };

    const renderItems = () => {
      // 移除旧列表(保留搜索框)
      listEl.querySelectorAll('.chat-item-wrap, .chat-group, .chat-group-section').forEach((el) => el.remove());
      const kw = keyword.trim().toLowerCase();
      // 多模态消息的 content 可能是数组,不能直接 toLowerCase
      const filtered = sorted.filter((c) => !kw || (c.title || '').toLowerCase().includes(kw)
        || (c.messages || []).some((m) => typeof m.content === 'string' && m.content.toLowerCase().includes(kw)));
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'chat-list-empty';
        empty.textContent = kw ? '无匹配对话' : '暂无对话,点击上方「新建对话」开始';
        listEl.appendChild(empty);
        return;
      }
      // 搜索模式下按更新时间倒序平铺;非搜索模式按时间分块
      if (kw) {
        filtered.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((c) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-item-wrap';
          const item = document.createElement('div');
          item.className = 'chat-item' + (c.id === opts.currentId ? ' active' : '');
          item.innerHTML = ITEM_HTML(c);
          const menu = document.createElement('div');
          menu.className = 'chat-item-menu';
          menu.innerHTML = MENU_HTML;
          item.appendChild(menu);
          wrap.appendChild(item);
          listEl.appendChild(wrap);
          wireItem(item, c, opts);
          menu.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!e.target.closest('.more-btn')) return;
            openItemMenu(menu, c, item, opts);
          });
        });
        return;
      }
      // ---- 时间分块:今天 / 昨天 / 本周 / 更早 ----
      const timeGroupOf = function (ts) {
        const t = Number(ts) || Date.now();
        const now = new Date();
        const d = new Date(t);
        const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const todayStart = startOfDay(now);
        const yesterdayStart = todayStart - 86400000;
        const day = (now.getDay() + 6) % 7;
        const weekStart = todayStart - day * 86400000;
        if (t >= todayStart) return '今天';
        if (t >= yesterdayStart) return '昨天';
        if (t >= weekStart) return '本周';
        return '更早';
      };
      // 开放 API 产生的会话(调用 /v1 接口时服务端顺手记下的那份,聊天记录上带 apiKey)
      // 在每个时间段里再单独成一组:「今天 API」紧跟「今天」、「昨天 API」紧跟「昨天」……
      // 一个渠道一天可能攒下几十条接口调用,和手动聊的会话混在同一块里会把手动的挤到看不见。
      // 判定交给 opts.isApiChat(app.js 与「显示 API 对话」开关同一口径),没给就全按普通对话
      // 分组 —— 退化成加这个功能之前的样子,而不是崩掉。
      const API_SUFFIX = ' API';
      const GROUP_ORDER = [];
      ['今天', '昨天', '本周', '更早'].forEach((base) => { GROUP_ORDER.push(base, base + API_SUFFIX); });
      const p2 = (n) => String(n).padStart(2, '0');
      const isApiOpt = typeof opts.isApiChat === 'function' ? opts.isApiChat : null;
      const groups = {};
      filtered.forEach((c) => {
        const base = timeGroupOf(c.updatedAt || c.createdAt);
        const g = (isApiOpt && isApiOpt(c)) ? base + API_SUFFIX : base;
        (groups[g] = groups[g] || []).push(c);
      });
      GROUP_ORDER.forEach((g) => {
        const list = groups[g] || [];
        if (!list.length) return;
        const isApi = g.slice(-API_SUFFIX.length) === API_SUFFIX;
        const baseGroup = isApi ? g.slice(0, -API_SUFFIX.length) : g;
        // 分组折叠:今天默认展开,昨天及更早默认折叠(状态记忆在 localStorage)。
        // 「今天 API」按「今天」的默认展开(折叠状态仍各记各的,收起一个不影响另一个)。
        const COLLAPSE_KEY = 'oc_chat_group_collapsed';
        let collapsedMap = {};
        try { collapsedMap = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch (e) { collapsedMap = {}; }
        const isCollapsed = collapsedMap[g] !== undefined ? collapsedMap[g] : (baseGroup !== '今天');
        const section = document.createElement('div');
        section.className = 'chat-group-section' + (isCollapsed ? ' collapsed' : '');
        const title = document.createElement('div');
        title.className = 'chat-group' + (baseGroup === '今天' ? ' is-today' : '') + (isApi ? ' is-api' : '');
        title.setAttribute('role', 'button');
        title.setAttribute('tabindex', '0');
        title.setAttribute('aria-expanded', String(!isCollapsed));
        // 「展开今天 API 对话」比「展开今天 API对话」好读,Latin 后缀前后各留一个空格
        const tipName = isApi ? baseGroup + ' API 对话' : g + '对话';
        title.setAttribute('data-tip', (isCollapsed ? '展开' : '收起') + tipName);
        title.innerHTML = '<span class="chat-group-chev">' + ic('chevronDown', 11) + '</span>'
          + '<span class="chat-group-label">' + g + '</span>'
          + '<span class="chat-group-count">' + list.length + '</span>';
        const toggle = () => {
          const cur = section.classList.contains('collapsed');
          section.classList.toggle('collapsed', !cur);
          title.setAttribute('aria-expanded', String(cur));
          title.setAttribute('data-tip', (cur ? '收起' : '展开') + tipName);
          collapsedMap[g] = !cur;
          try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedMap)); } catch (e) {}
          if (window.OCSettingsSync) window.OCSettingsSync.touchUi('chatGroupCollapsed');
        };
        title.addEventListener('click', toggle);
        title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        section.appendChild(title);
        listEl.appendChild(section);
        list.forEach((c) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-item-wrap';
          const item = document.createElement('div');
          item.className = 'chat-item' + (c.id === opts.currentId ? ' active' : '');
          item.innerHTML = ITEM_HTML(c);
          const menu = document.createElement('div');
          menu.className = 'chat-item-menu';
          menu.innerHTML = MENU_HTML;
          item.appendChild(menu);
          wrap.appendChild(item);
          section.appendChild(wrap);
          wireItem(item, c, opts);
          menu.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!e.target.closest('.more-btn')) return;
            openItemMenu(menu, c, item, opts);
          });
        });
      });
    };
    renderItems();
    searchInput.addEventListener('input', () => {
      keyword = searchInput.value;
      C._searchKeyword = keyword;
      renderItems();
    });
  };

  // 内联重命名
  C.renameInline = function (chatItem, currentTitle, onDone) {
    const titleEl = chatItem.querySelector('.chat-title');
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = currentTitle || '';
    input.maxLength = 60;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    // 只允许第一次结果生效:Esc 取消后 input 被移除会再触发 blur,不能把编辑内容又保存回去
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      onDone(value);
    };
    const commit = () => finish(input.value.trim() || currentTitle);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 中文输入法组词确认
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(currentTitle); }
    });
    input.addEventListener('blur', () => { if (!finished) commit(); });
  };

  // ============ 对话分支 ============
  /**
   * 从指定消息处创建分支
   * @param {object} chat 原对话
   * @param {number} msgIndex 分支起点（该消息之后的将被替换）
   */
  C.createBranch = function (chat, msgIndex) {
    const branch = {
      id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
      title: chat.title ? chat.title + ' (分支)' : '新对话',
      messages: (chat.messages || []).slice(0, msgIndex + 1),
      pinned: false,
      branchOf: chat.id,
      assistantId: chat.assistantId || null,
      assistantName: chat.assistantName || '',
      systemPrompt: chat.systemPrompt || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return branch;
  };

  // ============ 键盘快捷键 ============
  C.initShortcuts = function (handlers) {
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // 弹窗打开时不劫持快捷键:避免后台新建会话/切换侧栏等动作穿透到弹窗之下的页面
      if (window.OCUI && typeof window.OCUI.isModalOpen === 'function' && window.OCUI.isModalOpen()) return;
      const k = e.key.toLowerCase();
      // 避免输入框内快捷键冲突（保留必要项）
      const target = e.target;
      const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (k === 'k' && !inInput) {
        e.preventDefault();
        if (handlers.onNewChat) handlers.onNewChat();
      } else if (k === 'l') {
        e.preventDefault();
        if (handlers.onFocusInput) handlers.onFocusInput();
      } else if (k === 'p' && !inInput) {
        e.preventDefault();
        if (handlers.onToggleSidebar) handlers.onToggleSidebar();
      } else if (k === 'enter' && inInput) {
        // Cmd/Ctrl+Enter 发送（输入框内）
        if (handlers.onSend) handlers.onSend();
      }
    });
  };

  // ============ 标题自动生成 ============
  C.autoTitle = function (text) {
    const clean = (text || '').replace(/[#*`>|~]/g, '').trim();
    return clean.length > 20 ? clean.slice(0, 20) + '…' : (clean || '新对话');
  };

  window.OCConversations = C;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();