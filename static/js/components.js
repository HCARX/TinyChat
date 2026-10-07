'use strict';
/**
 * 自定义下拉组件（替代原生 <select>）
 * - 菜单用 position:fixed 挂在 body 顶层（.oc-menu，z-index 1700，见 style.css 的层级阶梯），不会被容器裁剪或遮挡
 * - 自动翻转：下方空间不足时向上展开
 * - 支持搜索过滤、分组标题、选中勾选态
 * - 点击外部 / Esc 关闭
 */

(function () {
  let openMenu = null;

  function closeOpenMenu() {
    if (!openMenu) return;
    if (typeof openMenu._cleanup === 'function') {
      try { openMenu._cleanup(); } catch (e) { /* ignore */ }
    }
    openMenu.remove();
    openMenu = null;
  }

  /**
   * 创建并弹出菜单
   * @param {HTMLElement} trigger 触发元素（用于定位）
   * @param {Array} groups [{label, items:[{value,label,sub}]}] 或 [{value,label,sub}]
   * @param {object} opts {selected, onSelect, searchable, width}
   */
  function openSelect(trigger, groups, opts = {}) {
    closeOpenMenu();
    const flatItems = [];
    const menu = document.createElement('div');
    menu.className = 'oc-menu' + (opts.menuClass ? ' ' + opts.menuClass : '');

    // 宽度：脱离触发器容器，但始终留在视口内；fitWidth 时按内容自适应（渲染后实测收窄）
    const tw = trigger.getBoundingClientRect().width;
    const maxViewport = Math.max(220, window.innerWidth - 16);
    menu.style.width = opts.fitWidth ? 'max-content' : Math.min(Math.max(opts.width || tw, 220), maxViewport) + 'px';

    // 搜索框
    let search = null;
    if (opts.searchable) {
      search = document.createElement('input');
      search.className = 'oc-menu-search';
      search.placeholder = opts.searchPlaceholder || '搜索…';
      search.type = 'search';
      search.autocomplete = 'off';
      search.spellcheck = false;
      menu.appendChild(search);
      search.addEventListener('input', () => render(search.value.trim().toLowerCase()));
      search.addEventListener('click', (e) => e.stopPropagation());
    }

    // 筛选标签（如按供应商筛选模型）
    let activeChip = '';
    const chipKey = opts.chipKey || 'providerId';
    const chipSearchText = () => (search ? search.value.trim().toLowerCase() : '');
    if (opts.chips && opts.chips.length) {
      const bar = document.createElement('div');
      bar.className = 'oc-menu-chips';
      const syncChips = () => {
        if (chipAllBtn) chipAllBtn.classList.toggle('active', activeChip === '');
        bar.querySelectorAll('.oc-menu-chip[data-chip]').forEach((b) => {
          b.classList.toggle('active', b.dataset.chip === activeChip);
        });
      };
      const chipAllBtn = document.createElement('button');
      chipAllBtn.type = 'button';
      chipAllBtn.className = 'oc-menu-chip active';
      chipAllBtn.textContent = opts.chipsAllLabel || '全部';
      chipAllBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      chipAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeChip = '';
        syncChips();
        render(chipSearchText());
      });
      bar.appendChild(chipAllBtn);
      opts.chips.forEach((chip) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'oc-menu-chip';
        b.dataset.chip = String(chip.value);
        b.innerHTML = (chip.icon && window.OC.logoImg ? OC.logoImg(chip.icon, 'chip-logo') : '')
          + '<span class="chip-label">' + escapeHtml(chip.label) + '</span>';
        b.title = chip.label;
        b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          activeChip = activeChip === String(chip.value) ? '' : String(chip.value);
          syncChips();
          render(chipSearchText());
        });
        bar.appendChild(b);
      });
      menu.appendChild(bar);
    }

    const list = document.createElement('div');
    list.className = 'oc-menu-list';
    menu.appendChild(list);

    const hasGroup = Array.isArray(groups) && groups.length > 0 && groups[0] && groups[0].label !== undefined && Array.isArray(groups[0].items);

    function render(filter = '') {
      list.innerHTML = '';
      const source = hasGroup ? groups : [{ label: '', items: groups }];
      let shown = 0;
      source.forEach((g) => {
        const items = (g.items || []).filter((it) => {
          if (activeChip && String(it[chipKey] || '') !== String(activeChip)) return false;
          return !filter || (it.label || '').toLowerCase().includes(filter) || (it.search || '').toLowerCase().includes(filter);
        });
        if (!items.length) return;
        if (g.label) {
          const title = document.createElement('div');
          title.className = 'oc-menu-title';
          title.textContent = g.label;
          list.appendChild(title);
        }
        items.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'oc-menu-item' + (it.value === opts.selected ? ' active' : '');
          row.dataset.value = String(it.value);
          const healthName = it.health === 'ok' ? 'healthOk' : (it.health === 'bad' ? 'healthBad' : ((it.health === 'idle' || it.health === 'warn') ? 'healthIdle' : ''));
          row.innerHTML = (it.icon && window.OC.logoImg ? OC.logoImg(it.icon, 'item-logo') : '')
            + '<span class="item-label">' + escapeHtml(it.label) + '</span>'
            + (it.sub ? '<span class="item-sub">' + escapeHtml(it.sub) + '</span>' : '')
            + '<span class="check">' + window.OC.icon('check', 14) + '</span>'
            + (healthName ? '<span class="oc-menu-health ' + it.health + '" title="' + escapeHtml(it.healthTitle || '') + '">' + window.OC.icon(healthName, 12) + '</span>' : '')
            + (opts.onPin ? '<button type="button" class="oc-menu-pin' + (it.value === opts.pinned ? ' active' : '') + '" data-pin="' + escapeHtml(String(it.value)) + '" title="' + (it.value === opts.pinned ? '取消置顶' : '置顶，新建对话使用此模型') + '">' + window.OC.icon('pinMark', 15) + '</button>' : '');
          const pinBtn = row.querySelector('.oc-menu-pin');
          if (pinBtn) pinBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 置顶是开关:同一项再点一次取消,不同项则改为置顶它。
            // 这里就地更新 opts.pinned 与按钮高亮——菜单是一次性渲染的,
            // 之前只改了偏好、没刷新按钮,导致要点完关闭再打开才看到蓝色。
            const nowPinned = opts.pinned === it.value ? null : String(it.value);
            if (opts.onPin) opts.onPin(it.value, it);
            opts.pinned = nowPinned;
            list.querySelectorAll('.oc-menu-pin').forEach((b) => {
              const on = b.dataset.pin === nowPinned;
              b.classList.toggle('active', on);
              b.title = on ? '取消置顶' : '置顶，新建对话使用此模型';
            });
          });
          row.addEventListener('mousedown', (e) => {
            if (e.target.closest('.oc-menu-pin')) return;
            e.preventDefault(); // 防止输入框失焦导致菜单先关
            e.stopPropagation();
            closeOpenMenu();
            row._ocSelected = true;
            if (opts.onSelect) opts.onSelect(it.value, it);
          });
          // 触屏/部分自动化环境只派发 click 不派发 mousedown:click 兜底触发一次(防重)
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (row._ocSelected) return;
            row._ocSelected = true;
            closeOpenMenu();
            row._ocSelected = true;
            if (opts.onSelect) opts.onSelect(it.value, it);
          });
          list.appendChild(row);
          shown++;
        });
      });
      if (!shown) {
        const empty = document.createElement('div');
        empty.className = 'oc-menu-item';
        empty.style.cursor = 'default';
        empty.style.color = 'var(--text-tertiary)';
        empty.textContent = '无匹配项';
        list.appendChild(empty);
      }
    }

    render();
    document.body.appendChild(menu);

    // fitWidth：以最宽一行的自然宽度为准，超出视口才收窄
    if (opts.fitWidth) {
      menu.style.width = Math.max(220, Math.min(menu.offsetWidth, maxViewport)) + 'px';
    }

    // 定位：默认向下，空间不足向上翻转；opts.center 时在视口正中显示
    // (用于「移动到文件夹」这类与触发位置无关、锚在角落会跑出视野的选择)
    if (opts.center) {
      menu.style.top = Math.max(8, Math.round((window.innerHeight - Math.min(menu.offsetHeight, 360)) / 2)) + 'px';
      menu.style.left = Math.max(8, Math.round((window.innerWidth - menu.offsetWidth) / 2)) + 'px';
    } else {
      const tr = trigger.getBoundingClientRect();
      const mh = Math.min(menu.offsetHeight, 320);
      const gap = 6;
      let top;
      if (tr.bottom + mh + gap > window.innerHeight && tr.top - mh - gap > 0) {
        top = tr.top - mh - gap;
      } else {
        top = tr.bottom + gap;
      }
      let left = tr.left;
      if (left + menu.offsetWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
      }
      menu.style.top = Math.max(8, Math.round(top)) + 'px';
      menu.style.left = Math.round(left) + 'px';
    }

    openMenu = menu;

    // 搜索自动聚焦:桌面端方便直接输入;触摸端不聚焦——聚焦会弹出软键盘,
    // 键盘又会改变视口尺寸并触发 resize/scroll,导致菜单「一闪而过」。
    const sq = menu.querySelector('.oc-menu-search');
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (sq && !coarse) setTimeout(() => sq.focus(), 30);

    // 关闭处理
    const onDoc = (e) => {
      if (!menu.contains(e.target) && e.target !== trigger) closeOpenMenu();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 捕获阶段拦截:只关菜单,不让同一个 Esc 再把底层弹窗也关掉
      e.preventDefault();
      e.stopPropagation();
      closeOpenMenu();
    };
    const onScroll = (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (menu.contains(e.target) || path.indexOf(menu) >= 0) return;
      // 软键盘弹出时浏览器会把聚焦元素滚入视野,这不代表用户在滚动页面,不应关掉菜单
      if (menu.contains(document.activeElement)) return;
      closeOpenMenu();
    };
    // 只在「宽度」变化时关闭(旋转屏幕/调整窗口);忽略软键盘导致的纯高度变化
    let lastWidth = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      closeOpenMenu();
    };
    const stopInside = (e) => e.stopPropagation();
    menu.addEventListener('wheel', stopInside, { passive: true, capture: true });
    menu.addEventListener('touchmove', stopInside, { passive: true, capture: true });

    menu._cleanup = () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // 捕获阶段注册:保证先于 OCUI 的弹窗 Esc(document 冒泡)触发
    setTimeout(() => {
      // 冒泡阶段监听：菜单项的 mousedown/click 通过 stopPropagation 阻止关闭
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
    }, 0);

    return menu;
  }

  // 表格比容器宽时:给一条"可以左右滑"的提示(只作首次发现用,一滑就收),
  // 同时给吸附的首列加阴影,避免停止滚动时看不出内容被盖住。
  // 放在模块级:获取模型弹窗与供应商表单里的模型清单共用同一套行为。
  function bindScrollAffordance(scroller, tipEl) {
    if (!scroller) return;
    let raf = 0;
    const sync = () => {
      const max = scroller.scrollWidth - scroller.clientWidth;
      const canPan = max > 2;
      const atStart = scroller.scrollLeft <= 2;
      const atEnd = canPan && scroller.scrollLeft >= max - 2;
      scroller.classList.toggle('is-pan-x', canPan && !atEnd);
      // 提示只在"还没滑动过"时出现:用户一动就知道能滑,不必常驻一行
      if (tipEl) tipEl.hidden = !(canPan && atStart);
    };
    scroller.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; sync(); });
    }, { passive: true });
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(sync);
      ro.observe(scroller);
      const inner = scroller.firstElementChild;
      if (inner) ro.observe(inner);
    } else {
      window.addEventListener('resize', sync);
    }
    // 内容重绘后列数会变(搜索过滤、切换 Key 并入新模型),每次 render 都要重测
    scroller.__syncScrollAffordance = sync;
    sync();
  }

  // 给一个 .model-check-list 容器补上滑动提示条(若页面里还没写)并绑定行为
  function wireModelCheckList(listEl) {
    if (!listEl) return;
    let tip = listEl.previousElementSibling;
    if (!tip || !tip.classList || !tip.classList.contains('mt-scroll-tip')) {
      tip = document.createElement('p');
      tip.className = 'mt-scroll-tip';
      tip.hidden = true;
      tip.innerHTML = (window.OC && window.OC.icon ? window.OC.icon('chevronRight', 13) : '')
        + '<span>表格可左右滑动查看全部列</span>';
      listEl.parentNode.insertBefore(tip, listEl);
    }
    bindScrollAffordance(listEl, tip);
  }

  function modelTableHtml(rowsHtml, opts) {
    opts = opts || {};
    const keyHead = opts.showKey
      ? '<th class="col-key" title="该模型用哪把 Key 请求上游；仅在供应商配置了多个 Key 时出现">密钥</th>'
      : '';
    // showCost=false 用于用户自建供应商:自己的 Key 不扣站点次数,「单次扣减」列没有意义
    const costHead = opts.showCost === false
      ? ''
      : '<th class="col-cost" title="该模型单次调用扣减的额度次数；留空则跟随供应商的「每次调用扣费次数」">单次扣减</th>';
    return '<table class="model-table">'
      + '<thead><tr>'
      + '<th class="col-check"></th>'
      + '<th class="col-id">模型 ID</th>'
      + '<th class="col-name">显示名称</th>'
      + costHead
      + keyHead
      + '<th class="col-img" title="标记为生图模型：调用对话接口时会自动改用 images/generations（未标记时按模型名自动判断）">生图</th>'
      + '<th class="col-img" title="标记为视频生成模型：调用对话接口时会自动改用 videos（未标记时按模型名自动判断）">视频</th>'
      + '</tr></thead><tbody>'
      + rowsHtml
      + '</tbody></table>';
  }

  function modelNameCell(m, editable) {
    if (editable) {
      return '<input class="mname" type="text" data-mid="' + escapeHtml(m.id) + '" value="'
        + escapeHtml(m.name || m.id) + '" placeholder="前台显示名称" autocomplete="off" spellcheck="false">';
    }
    return '<span class="mname-static">' + escapeHtml(m.name || m.id)
      + (m.enabled ? '<em>已启用</em>' : '') + '</span>';
  }

  // 单次调用扣减次数:留空 = 跟随供应商价格;填写后该模型单独计价
  function modelCostCell(m, editable) {
    const raw = (m && m.cost !== undefined && m.cost !== null && m.cost !== '') ? Number(m.cost) : '';
    const v = (raw !== '' && isFinite(raw) && raw >= 0) ? raw : '';
    if (editable) {
      return '<input class="mcost" type="number" min="0" max="1000" step="0.1" data-mid="' + escapeHtml(m.id)
        + '" value="' + v + '" placeholder="跟随" autocomplete="off">';
    }
    return '<span class="mcost-static">' + (v === '' ? '<i class="muted">跟随</i>' : v) + '</span>';
  }

  // 模型绑定的密钥列(仅多 Key 时渲染):下拉选择,空值表示跟随默认密钥
  // 模型绑定的密钥链(仅多 Key 时渲染)。
  // 语义:同一模型可绑定多把 Key 作为「多重保障」——上游用第一把失败(认证/连接)时
  // 自动回退到下一把。单元格里按优先级顺序列出,可增删与调整次序(↑↓ 或删除)。
  function modelKeyCell(m, opts) {
    const keys = (opts && opts.keys) || [];
    if (keys.length < 2) return '';
    const chain = Array.isArray(m && m.keyIds) ? m.keyIds.slice() : ((m && m.keyId) ? [m.keyId] : []);
    const nameOf = (kid) => {
      const hit = keys.find((k) => String(k.id) === String(kid));
      return hit ? String(hit.name || hit.id) : String(kid);
    };
    if (opts.stale) {
      return '<td class="col-key">' + (chain.length ? escapeHtml(chain.map(nameOf).join(' → ')) : '<i class="muted">默认</i>') + '</td>';
    }
    const chips = chain.map((kid, i) =>
      '<span class="mk-chip" data-mid="' + escapeHtml(m.id) + '" data-kid="' + escapeHtml(String(kid)) + '">'
      + '<b>' + (i + 1) + '</b>' + escapeHtml(nameOf(kid))
      + (i > 0 ? '<button type="button" class="mk-up" title="上移(提高优先级)">↑</button>' : '')
      + '<button type="button" class="mk-del" title="移除">×</button>'
      + '</span>'
    ).join('');
    // 可添加的密钥(尚未加入链的)
    const rest = keys.filter((k) => !chain.some((x) => String(x) === String(k.id)));
    const add = rest.length
      ? '<select class="mk-add" data-mid="' + escapeHtml(m.id) + '" title="添加一把备用密钥(失败时自动回退)"><option value="">+ 加备用 Key</option>'
        + rest.map((k) => '<option value="' + escapeHtml(String(k.id)) + '">' + escapeHtml(String(k.name || k.id)) + '</option>').join('')
        + '</select>'
      : '';
    return '<td class="col-key"><div class="mk-chain">'
      + (chips || '<span class="muted small">默认密钥</span>') + add
      + '</div></td>';
  }

  function modelRowHtml(m, opts) {
    opts = opts || {};
    const checked = opts.checked ? ' checked' : '';
    const attr = opts.stale ? 'data-stale' : 'data-mid';
    const costCell = opts.showCost === false ? '' : '<td class="col-cost">' + modelCostCell(m, !opts.stale) + '</td>';
    // 生图标记:显式 image 字段优先;未显式设置时按模型名给出建议默认值(仅用于勾选态展示)
    const isImage = Object.prototype.hasOwnProperty.call(m, 'image') ? !!m.image : (window.OC && OC.isImageModelName ? OC.isImageModelName(m.id) : false);
    const imageCell = opts.stale
      ? '<td class="col-img">' + (isImage ? '<span class="img-flag">生图</span>' : '<i class="muted">—</i>') + '</td>'
      : '<td class="col-img"><input type="checkbox" class="mimg" data-mid="' + escapeHtml(m.id) + '" title="标记为生图模型"' + (isImage ? ' checked' : '') + '></td>';
    // 视频标记:显式 video 字段优先;未显式设置时按模型名给出建议默认值
    const isVideo = Object.prototype.hasOwnProperty.call(m, 'video') ? !!m.video : (window.OC && OC.isVideoModelName ? OC.isVideoModelName(m.id) : false);
    const videoCell = opts.stale
      ? '<td class="col-img">' + (isVideo ? '<span class="img-flag video-flag">视频</span>' : '<i class="muted">—</i>') + '</td>'
      : '<td class="col-img"><input type="checkbox" class="mvideo" data-mid="' + escapeHtml(m.id) + '" title="标记为视频生成模型"' + (isVideo ? ' checked' : '') + '></td>';
    // is-on:已勾选的行加左侧色条(样式见 chrome.css),长列表里一眼看出哪些会被保存
    const cls = 'model-row' + (opts.stale ? ' is-stale' : '') + (checked && !opts.stale ? ' is-on' : '');
    return '<tr class="' + cls + '">'
      + '<td class="col-check"><input type="checkbox" ' + attr + '="' + escapeHtml(m.id) + '"' + checked + '></td>'
      + '<td class="col-id"><span class="mid">' + escapeHtml(m.id) + '</span></td>'
      + '<td class="col-name">' + modelNameCell(m, !opts.stale) + '</td>'
      + costCell
      + modelKeyCell(m, opts)
      + imageCell
      + videoCell
      + '</tr>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 供应商模型清单:拉取全量后手动勾选启用。
   * cfg: { listId, queryId, allId, countId, addId }
   */
  function bindModelChecklist(cfg) {
    const listEl = document.getElementById(cfg.listId);
    if (!listEl) return null;
    const qEl = cfg.queryId ? document.getElementById(cfg.queryId) : null;
    const allEl = cfg.allId ? document.getElementById(cfg.allId) : null;
    const countEl = cfg.countId ? document.getElementById(cfg.countId) : null;
    const addBtn = cfg.addId ? document.getElementById(cfg.addId) : null;
    // 多密钥:可选的密钥列表 [{id,name}],为空则表格不显示密钥列
    let keyOptions = Array.isArray(cfg.keys) ? cfg.keys.slice() : [];

    let catalog = [];
    const selected = new Set();

    function upsertCatalog(models, opts) {
      const selectNew = !!(opts && opts.selectNew);
      const updateName = !!(opts && opts.updateName);
      const syncEnabled = !!(opts && opts.syncEnabled);
      (models || []).forEach((m) => {
        const id = String((m && (m.id || m.name)) || '').trim();
        if (!id) return;
        const incoming = String((m && m.name) || '').trim();
        // 生图标记只有调用方显式携带时才更新(上游拉取的原始列表没有该字段,不能覆盖已保存值)
        const hasImage = !!(m && Object.prototype.hasOwnProperty.call(m, 'image'));
        const incomingImage = hasImage ? !!m.image : undefined;
        const hasVideo = !!(m && Object.prototype.hasOwnProperty.call(m, 'video'));
        const incomingVideo = hasVideo ? !!m.video : undefined;
        // 单次扣减:只有调用方显式携带且是数字时才更新(上游原始列表没有该字段)
        const hasCost = !!(m && Object.prototype.hasOwnProperty.call(m, 'cost') && m.cost !== '' && m.cost !== null && isFinite(Number(m.cost)));
        const incomingCost = hasCost ? Math.max(0, Math.min(1000, Number(m.cost))) : undefined;
        const hasKey = !!(m && Object.prototype.hasOwnProperty.call(m, 'keyId') && String(m.keyId) !== '');
        const incomingKey = hasKey ? String(m.keyId) : undefined;
        const hasChain = !!(m && Array.isArray(m.keyIds) && m.keyIds.length);
        const incomingChain = hasChain ? m.keyIds.map((x) => String(x)).filter(Boolean) : undefined;
        const found = catalog.find((x) => x.id === id);
        if (found) {
          if (updateName && incoming) found.name = incoming;
          else if (incoming && (!found.name || found.name === found.id)) found.name = incoming;
          if (hasImage) found.image = incomingImage;
          if (hasVideo) found.video = incomingVideo;
          if (hasCost) found.cost = incomingCost;
          if (hasChain) { found.keyIds = incomingChain; found.keyId = incomingChain[0]; }
          else if (hasKey) { found.keyId = incomingKey; found.keyIds = [incomingKey]; }
          else { delete found.keyId; delete found.keyIds; }
        } else {
          const item = { id, name: incoming || id };
          if (hasImage) item.image = incomingImage;
          else if (window.OC && OC.isImageModelName) item.image = OC.isImageModelName(id);
          if (hasVideo) item.video = incomingVideo;
          else if (window.OC && OC.isVideoModelName) item.video = OC.isVideoModelName(id);
          if (hasCost) item.cost = incomingCost;
          if (hasChain) { item.keyIds = incomingChain; item.keyId = incomingChain[0]; }
          else if (hasKey) { item.keyId = incomingKey; item.keyIds = [incomingKey]; }
          catalog.push(item);
          if (selectNew) selected.add(id);
        }
        if (syncEnabled) {
          if (m && m.enabled) selected.add(id);
          else selected.delete(id);
        }
      });
      catalog.sort((a, b) => a.id.localeCompare(b.id));
    }

    function addToCatalog(models, selectNew) {
      upsertCatalog(models, { selectNew: !!selectNew });
    }

    function query() {
      return qEl ? qEl.value.trim().toLowerCase() : '';
    }

    function visible() {
      const q = query();
      if (!q) return catalog.slice();
      return catalog.filter((m) =>
        m.id.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q)
      );
    }

    function updateMeta() {
      if (countEl) {
        countEl.textContent = catalog.length
          ? ('已启用 ' + selected.size + ' / ' + catalog.length)
          : '未获取模型';
      }
      if (allEl) {
        const vis = visible();
        const n = vis.filter((m) => selected.has(m.id)).length;
        allEl.checked = vis.length > 0 && n === vis.length;
        allEl.indeterminate = n > 0 && n < vis.length;
      }
    }

    function render() {
      if (!catalog.length) {
        listEl.innerHTML = '<div class="model-check-empty">点击「获取列表」从上游拉取，或在上方输入模型 ID 后添加</div>';
        if (listEl.__syncScrollAffordance) listEl.__syncScrollAffordance();
        updateMeta();
        return;
      }
      const vis = visible();
      if (!vis.length) {
        listEl.innerHTML = '<div class="model-check-empty">没有匹配的模型</div>';
        if (listEl.__syncScrollAffordance) listEl.__syncScrollAffordance();
        updateMeta();
        return;
      }
      listEl.innerHTML = modelTableHtml(vis.map((m) =>
        modelRowHtml(m, { checked: selected.has(m.id), keys: keyOptions, showCost: cfg.showCost })
      ).join(''), { showKey: keyOptions.length > 1, showCost: cfg.showCost });
      // 「+ 加备用 Key」是动态渲染的原生 select:换成站内自定义下拉
      if (typeof enhanceSelects === 'function') enhanceSelects(listEl);
      if (listEl.__syncScrollAffordance) listEl.__syncScrollAffordance();
      updateMeta();
    }

    listEl.addEventListener('change', (e) => {
      const imgInp = e.target && e.target.closest ? e.target.closest('input.mimg[data-mid]') : null;
      if (imgInp) {
        const item = catalog.find((x) => x.id === imgInp.dataset.mid);
        if (item) item.image = !!imgInp.checked;
        return;
      }
      const vidInp = e.target && e.target.closest ? e.target.closest('input.mvideo[data-mid]') : null;
      if (vidInp) {
        const item = catalog.find((x) => x.id === vidInp.dataset.mid);
        if (item) item.video = !!vidInp.checked;
        return;
      }
      const addSel = e.target && e.target.closest ? e.target.closest('select.mk-add[data-mid]') : null;
      if (addSel) {
        const item = catalog.find((x) => x.id === addSel.dataset.mid);
        if (item && addSel.value) {
          const chain = Array.isArray(item.keyIds) ? item.keyIds.slice() : (item.keyId ? [item.keyId] : []);
          if (!chain.some((x) => String(x) === addSel.value)) chain.push(addSel.value);
          item.keyIds = chain; item.keyId = chain[0];
          render();
        }
        return;
      }
      const inp = e.target && e.target.closest ? e.target.closest('input[type="checkbox"][data-mid]') : null;
      if (!inp) return;
      if (inp.checked) selected.add(inp.dataset.mid);
      else selected.delete(inp.dataset.mid);
      updateMeta();
    });

    listEl.addEventListener('input', (e) => {
      const nameInp = e.target && e.target.closest ? e.target.closest('input.mname') : null;
      if (nameInp) {
        const item = catalog.find((x) => x.id === nameInp.dataset.mid);
        if (item) item.name = nameInp.value.trim() || item.id;
        return;
      }
      const costInp = e.target && e.target.closest ? e.target.closest('input.mcost') : null;
      if (costInp) {
        const item = catalog.find((x) => x.id === costInp.dataset.mid);
        if (item) {
          const raw = String(costInp.value || '').trim();
          if (raw === '' || !isFinite(Number(raw))) delete item.cost;
          else item.cost = Math.max(0, Math.min(1000, Number(raw)));
        }
        return;
      }
    });

    // 密钥链:移除某把 / 上移提高优先级
    listEl.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const del = t.closest('.mk-del');
      if (del) {
        const chip = del.closest('.mk-chip');
        const item = chip ? catalog.find((x) => x.id === chip.dataset.mid) : null;
        if (item) {
          const chain = (Array.isArray(item.keyIds) ? item.keyIds : (item.keyId ? [item.keyId] : []))
            .filter((x) => String(x) !== chip.dataset.kid);
          if (chain.length) { item.keyIds = chain; item.keyId = chain[0]; }
          else { delete item.keyIds; delete item.keyId; }
          render();
        }
        return;
      }
      const up = t.closest('.mk-up');
      if (up) {
        const chip = up.closest('.mk-chip');
        const item = chip ? catalog.find((x) => x.id === chip.dataset.mid) : null;
        if (item) {
          const chain = (Array.isArray(item.keyIds) ? item.keyIds : (item.keyId ? [item.keyId] : [])).slice();
          const i = chain.findIndex((x) => String(x) === chip.dataset.kid);
          if (i > 0) { const tmp = chain[i - 1]; chain[i - 1] = chain[i]; chain[i] = tmp; item.keyIds = chain; item.keyId = chain[0]; render(); }
        }
        return;
      }
    });

    listEl.addEventListener('keydown', (e) => {
      const cls = e.target && e.target.classList;
      if (e.key === 'Enter' && cls && (cls.contains('mname') || cls.contains('mcost'))) {
        e.preventDefault();
        e.target.blur();
      }
    });

    if (allEl) {
      allEl.addEventListener('change', () => {
        visible().forEach((m) => {
          if (allEl.checked) selected.add(m.id);
          else selected.delete(m.id);
        });
        render();
      });
    }

    function addManual() {
      const id = qEl ? qEl.value.trim() : '';
      if (!id) return false;
      // 多密钥时,手动新增的模型默认绑定第一把密钥,避免落到「默认密钥」而与预期不符
      const defKey = keyOptions.length > 1 ? keyOptions[0].id : '';
      addToCatalog([{ id, name: id, keyIds: defKey ? [defKey] : undefined }], true);
      if (qEl) qEl.value = '';
      render();
      return true;
    }

    if (qEl) {
      qEl.addEventListener('input', render);
      qEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addManual();
        }
      });
    }
    if (addBtn) addBtn.addEventListener('click', addManual);

    render();
    // 首屏就先绑上滑动提示:表列较多时立刻能看出右边还有内容
    wireModelCheckList(listEl);

    return {
      setFromFetch(models) {
        addToCatalog(models, false);
        render();
      },
      applyFetched(models, staleIds) {
        upsertCatalog(models, { updateName: true, syncEnabled: true });
        const drop = new Set((staleIds || []).map((id) => String(id || '').trim()).filter(Boolean));
        if (drop.size) {
          catalog = catalog.filter((m) => !drop.has(m.id));
          drop.forEach((id) => selected.delete(id));
        }
        render();
      },
      setEnabled(models) {
        catalog = [];
        selected.clear();
        addToCatalog(models, true);
        render();
      },
      getCatalog() {
        return catalog.map((m) => {
          const row = { id: m.id, name: m.name || m.id, enabled: selected.has(m.id) };
          if (Object.prototype.hasOwnProperty.call(m, 'image')) row.image = !!m.image;
          if (Object.prototype.hasOwnProperty.call(m, 'video')) row.video = !!m.video;
          if (Object.prototype.hasOwnProperty.call(m, 'cost')) row.cost = m.cost;
          if (Array.isArray(m.keyIds) && m.keyIds.length) { row.keyIds = m.keyIds.map((x) => String(x)); row.keyId = String(m.keyIds[0]); }
          else if (m.keyId) row.keyId = String(m.keyId);
          return row;
        });
      },
      getEnabled() {
        return catalog
          .filter((m) => selected.has(m.id))
          .map((m) => {
            const row = { id: m.id, name: m.name || m.id };
            if (Object.prototype.hasOwnProperty.call(m, 'image')) row.image = !!m.image;
            if (Object.prototype.hasOwnProperty.call(m, 'video')) row.video = !!m.video;
            if (Object.prototype.hasOwnProperty.call(m, 'cost')) row.cost = m.cost;
            if (Array.isArray(m.keyIds) && m.keyIds.length) { row.keyIds = m.keyIds.map((x) => String(x)); row.keyId = String(m.keyIds[0]); }
            else if (m.keyId) row.keyId = String(m.keyId);
            return row;
          });
      },
      setEnabledIds(ids) {
        const keep = new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean));
        selected.clear();
        catalog.forEach((m) => {
          if (keep.has(m.id)) selected.add(m.id);
        });
        render();
      },
      setKeys(keys) {
        keyOptions = Array.isArray(keys) ? keys.slice() : [];
        render();
      },
      reset() {
        catalog = [];
        selected.clear();
        if (qEl) qEl.value = '';
        if (allEl) {
          allEl.checked = false;
          allEl.indeterminate = false;
        }
        render();
      },
    };
  }

  /**
   * 获取模型后的弹窗：勾选启用，并修改前台显示名称。
   * opts: { existing:[{id,name,enabled}], onApply(items), title }
   */
  function openFetchedModelsModal(models, opts) {
    opts = opts || {};
    // showCost=false 用于用户自建供应商:自己的 Key 不扣站点次数,不展示「单次扣减」列
    const showCost = opts.showCost !== false;
    const existingMap = new Map();
    (opts.existing || []).forEach((m) => {
      const id = String((m && m.id) || '').trim();
      if (id) existingMap.set(id, m);
    });
    const keyList = Array.isArray(opts.keys) ? opts.keys : [];
    let fetchedKeyId = String(opts.fetchedKeyId || '');
    const keyName = (kid) => {
      const hit = keyList.find((k) => String(k.id) === String(kid));
      return hit ? String(hit.name || hit.id) : '';
    };
    const items = [];
    const stale = [];
    const itemById = (id) => items.find((x) => x.id === id);
    // 逐批合并:同一模型在不同 Key 下都可用时,天然合并为一条(同 id 去重),
    // 并把「本次获取所用的 Key」累加进该模型的「优先级链」——上游用第一把失败会自动回退下一把。
    const mergeModels = (list, keyId) => {
      const kid = String(keyId || '');
      (list || []).forEach((m) => {
        const id = String((m && (m.id || m.name)) || '').trim();
        if (!id) return;
        const upstream = String((m && m.name) || '').trim();
        const prev = existingMap.get(id);
        let item = itemById(id);
        if (!item) {
          item = { id, name: (prev && prev.name) || upstream || id, enabled: !!(prev && prev.enabled) };
          if (Object.prototype.hasOwnProperty.call(prev || {}, 'image')) item.image = !!prev.image;
          if (Object.prototype.hasOwnProperty.call(prev || {}, 'video')) item.video = !!prev.video;
          if (prev && Object.prototype.hasOwnProperty.call(prev, 'cost')) item.cost = prev.cost;
          // 已有模型沿用原链(本次的 Key 再追加);新模型从「本次获取的 Key」起链
          if (prev && Array.isArray(prev.keyIds) && prev.keyIds.length) item.keyIds = prev.keyIds.map((x) => String(x));
          else if (prev && prev.keyId) item.keyIds = [String(prev.keyId)];
          items.push(item);
        } else if (upstream && (!item.name || item.name === item.id)) {
          item.name = upstream;
        }
        if (kid) {
          const chain = Array.isArray(item.keyIds) ? item.keyIds.slice() : [];
          // 多 Key:确保本次的 Key 在链里;单 Key:仅当尚无绑定时绑定
          if (!chain.some((x) => String(x) === kid) && (keyList.length > 1 || !chain.length)) chain.push(kid);
          if (chain.length) item.keyIds = chain;
        }
        if (Array.isArray(item.keyIds) && item.keyIds.length) item.keyId = item.keyIds[0];
      });
    };
    // 失效模型 = 已保存但「本次(含多次获取的并集)」都没出现的。多 Key 下按并集判定,避免误删另一把 Key 才有的模型。
    const rebuildStale = () => {
      stale.length = 0;
      const live = new Set(items.map((m) => m.id));
      existingMap.forEach((prev, id) => {
        if (live.has(id)) return;
        stale.push({
          id,
          name: String((prev && prev.name) || '').trim() || id,
          enabled: !!(prev && prev.enabled),
          remove: true,
        });
      });
      stale.sort((a, b) => a.id.localeCompare(b.id));
    };
    mergeModels(models, fetchedKeyId);
    items.sort((a, b) => a.id.localeCompare(b.id));
    rebuildStale();
    if (!items.length && !stale.length) return null;

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const showKey = keyList.length > 1;
    // 顶部摘要只留一行事实(数量 + 本次用的 Key),把用法说明收进可折叠区:
    // 打开弹窗第一眼应该是列表,而不是三段使用说明。
    const summaryLine = '共 ' + items.length + ' 个模型'
      + (showKey ? ' · 本次密钥「' + escapeHtml(keyName(fetchedKeyId) || '默认密钥') + '」' : '');
    const noticeHtml = showKey
      ? '<p><b>勾选要启用的模型</b>,并可直接修改前台显示名称。输出上限与上下文窗口不在这里配置，统一到「模型元数据」按模型名维护。</p>'
        + '<p><b>密钥优先级链：</b>同一个模型可绑定多把密钥。上游用第一把失败时自动回退下一把，数字越小越优先。</p>'
        + '<ul>'
        + '<li>在「密钥」列点 <kbd>+ 加备用 Key</kbd> 追加，点 <kbd>↑</kbd> 提前优先级，点 <kbd>×</kbd> 移除。</li>'
        + '<li>切换上方「获取用 Key」再点「获取列表」，可拉取另一把 Key 下的模型；点「并入并继续获取」并入当前列表（同一模型自动合并为一条链）。</li>'
        + '<li>本轮没出现的已存模型会列在下方「已失效模型」里，默认勾选清除。</li>'
        + '<li>新加的模型会自动出现在「模型元数据」表里并标注<b>待复核</b>，请到那里核对它的窗口与输出上限。</li>'
        + '</ul>'
      : '<p><b>勾选要启用的模型</b>,并可直接修改前台显示名称。输出上限与上下文窗口不在这里配置，统一到「模型元数据」按模型名维护。</p>'
        + '<ul>'
        + '<li>表格较宽时<b>左右滑动</b>查看全部列；表头与「模型 ID」列会固定在左侧。</li>'
        + '<li>本轮没出现的已存模型会列在下方「已失效模型」里，默认勾选清除。</li>'
        + '<li>新加的模型会自动出现在「模型元数据」表里并标注<b>待复核</b>，请到那里核对它的窗口与输出上限。</li>'
        + '</ul>';
    mask.innerHTML =
      '<div class="modal modal-lg model-fetch-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + escapeHtml(opts.title || '获取到的模型') + '</h3>'
      + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">'
      + (window.OC && window.OC.icon ? window.OC.icon('close', 16) : '×')
      + '</button></div>'
      + '<div class="modal-body">'
      + '<details class="mf-notice">'
      + '<summary>' + (window.OC && window.OC.icon ? window.OC.icon('table', 14) : '')
      + '<span data-role="msg">' + summaryLine + '</span></summary>'
      + '<div class="mf-notice-body" data-role="noticebody">' + noticeHtml + '</div>'
      + '</details>'
      + '<div class="model-fetch-toolbar">'
      + '<label class="model-fetch-search">'
      + (window.OC && window.OC.icon ? window.OC.icon('search', 14) : '')
      + '<input type="search" data-role="q" placeholder="搜索模型 ID 或显示名称" autocomplete="off" spellcheck="false">'
      + '</label>'
      + (showKey
        ? '<label class="model-fetch-key"><span class="muted small">获取用 Key</span>'
          + '<select data-role="fetchkey">'
          + keyList.map((k) => '<option value="' + escapeHtml(String(k.id)) + '"' + (String(k.id) === fetchedKeyId ? ' selected' : '') + '>' + escapeHtml(String(k.name || k.id)) + '</option>').join('')
          + '</select>'
          + '<button class="btn small" type="button" data-role="refetch">切换并继续获取</button>'
          + '</label>'
        : '')
      + '<span class="mfc-spacer"></span>'
      + '<label class="model-check-all"><input type="checkbox" data-act="all"> 全选当前列表</label>'
      + '</div>'
      + '<p class="mt-scroll-tip" data-role="scrolltip" hidden>'
      + (window.OC && window.OC.icon ? window.OC.icon('chevronRight', 13) : '')
      + '<span>表格可左右滑动查看全部列</span></p>'
      + '<div class="model-fetch-list" data-role="list"></div>'
      + '<details class="model-stale-block" data-role="staleblock"' + (stale.length ? '' : ' hidden') + '>'
        + '<summary>已失效模型 <span class="muted small" data-role="stalecount">' + stale.length + '</span></summary>'
        + '<div class="model-stale-body">'
        + '<div class="model-stale-head">'
        + '<p class="model-stale-hint">这些模型本轮获取都没出现（多个 Key 时按并集判断），勾选后会从本地目录移除。</p>'
        + '<label class="model-check-all"><input type="checkbox" data-act="stale-all" checked> 全选清除</label>'
        + '</div>'
        + '<div class="model-fetch-list model-stale-list" data-role="stale"></div>'
        + '</div>'
      + '</details>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<span class="muted small" data-role="footcount"></span>'
      + '<span class="mfc-spacer"></span>'
      + '<button class="btn" type="button" data-act="cancel">取消</button>'
      + '<button class="btn primary" type="button" data-act="ok">应用到列表</button>'
      + '</div></div>';
    document.body.appendChild(mask);

    const qEl = mask.querySelector('[data-role="q"]');
    const listEl = mask.querySelector('[data-role="list"]');
    const staleEl = mask.querySelector('[data-role="stale"]');
    const staleBlockEl = mask.querySelector('[data-role="staleblock"]');
    const staleCountEl = mask.querySelector('[data-role="stalecount"]');
    const msgEl = mask.querySelector('[data-role="msg"]');
    // 「获取用 Key」是原生 select:换成站内自定义下拉(change 委托仍照常工作)
    if (typeof enhanceSelects === 'function') enhanceSelects(mask);
    const fetchKeyEl = mask.querySelector('[data-role="fetchkey"]');
    const refetchBtn = mask.querySelector('[data-role="refetch"]');
    const countEl = mask.querySelector('[data-role="count"]');
    const footCountEl = mask.querySelector('[data-role="footcount"]');
    const allEl = mask.querySelector('[data-act="all"]');
    const staleAllEl = mask.querySelector('[data-act="stale-all"]');
    const scrollTipEl = mask.querySelector('[data-role="scrolltip"]');
    let filter = '';

    function updateMsg() {
      if (!msgEl) return;
      msgEl.textContent = '共 ' + items.length + ' 个模型'
        + (showKey ? ' · 本次密钥「' + (keyName(fetchedKeyId) || '默认密钥') + '」' : '');
    }

    function visible() {
      const q = filter;
      if (!q) return items.slice();
      return items.filter((m) =>
        m.id.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q)
      );
    }

    function render() {
      const vis = visible();
      const n = vis.filter((m) => m.enabled).length;
      const onCount = items.filter((m) => m.enabled).length;
      if (countEl) countEl.textContent = '已选 ' + onCount + ' / ' + items.length;
      if (footCountEl) {
        footCountEl.textContent = vis.length === items.length
          ? ('已选 ' + onCount + ' / ' + items.length)
          : ('筛选出 ' + vis.length + ' 个 · 已选 ' + onCount + ' / ' + items.length);
      }
      if (allEl) {
        allEl.checked = vis.length > 0 && n === vis.length;
        allEl.indeterminate = n > 0 && n < vis.length;
      }
      if (!vis.length) {
        listEl.innerHTML = '<div class="model-check-empty">' + (items.length ? '没有匹配的模型' : '这次上游没有返回模型') + '</div>';
      } else {
        listEl.innerHTML = modelTableHtml(vis.map((m) =>
          modelRowHtml(m, { checked: m.enabled, keys: keyList, showCost })
        ).join(''), { showKey: showKey, showCost });
      }
      if (listEl.__syncScrollAffordance) listEl.__syncScrollAffordance();
      renderStale();
      updateMsg();
    }

    function renderStale() {
      if (staleBlockEl) staleBlockEl.hidden = stale.length === 0;
      if (staleCountEl) staleCountEl.textContent = stale.length;
      if (!staleEl) return;
      const n = stale.filter((m) => m.remove).length;
      if (staleAllEl) {
        staleAllEl.checked = stale.length > 0 && n === stale.length;
        staleAllEl.indeterminate = n > 0 && n < stale.length;
      }
      staleEl.innerHTML = stale.length ? modelTableHtml(stale.map((m) =>
        modelRowHtml(m, { checked: m.remove, stale: true, keys: keyList, showCost })
      ).join(''), { showKey: showKey, showCost }) : '';
    }

    function updateMetaOnly() {
      const vis = visible();
      const n = vis.filter((m) => m.enabled).length;
      if (countEl) countEl.textContent = '已选 ' + items.filter((m) => m.enabled).length + ' / ' + items.length;
      if (allEl) {
        allEl.checked = vis.length > 0 && n === vis.length;
        allEl.indeterminate = n > 0 && n < vis.length;
      }
    }

    listEl.addEventListener('change', (e) => {
      const addSel = e.target && e.target.closest ? e.target.closest('select.mk-add[data-mid]') : null;
      if (addSel) {
        const item = itemById(addSel.dataset.mid);
        if (item && addSel.value) {
          const chain = Array.isArray(item.keyIds) ? item.keyIds.slice() : (item.keyId ? [item.keyId] : []);
          if (!chain.some((x) => String(x) === addSel.value)) chain.push(addSel.value);
          item.keyIds = chain; item.keyId = chain[0];
          render();
        }
        return;
      }
      const inp = e.target && e.target.closest ? e.target.closest('input[type="checkbox"][data-mid]') : null;
      if (!inp) return;
      const item = itemById(inp.dataset.mid);
      if (item) item.enabled = !!inp.checked;
      updateMetaOnly();
    });
    // 密钥链:移除某把 / 上移提高优先级(与供应商表单内的编辑器一致)
    listEl.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const del = t.closest('.mk-del');
      if (del) {
        const chip = del.closest('.mk-chip');
        const item = chip ? itemById(chip.dataset.mid) : null;
        if (item) {
          const chain = (Array.isArray(item.keyIds) ? item.keyIds : (item.keyId ? [item.keyId] : []))
            .filter((x) => String(x) !== chip.dataset.kid);
          if (chain.length) { item.keyIds = chain; item.keyId = chain[0]; }
          else { delete item.keyIds; delete item.keyId; }
          render();
        }
        return;
      }
      const up = t.closest('.mk-up');
      if (up) {
        const chip = up.closest('.mk-chip');
        const item = chip ? itemById(chip.dataset.mid) : null;
        if (item) {
          const chain = (Array.isArray(item.keyIds) ? item.keyIds : (item.keyId ? [item.keyId] : [])).slice();
          const i = chain.findIndex((x) => String(x) === chip.dataset.kid);
          if (i > 0) { const tmp = chain[i - 1]; chain[i - 1] = chain[i]; chain[i] = tmp; item.keyIds = chain; item.keyId = chain[0]; render(); }
        }
        return;
      }
    });
    if (staleEl) {
      staleEl.addEventListener('change', (e) => {
        const inp = e.target && e.target.closest ? e.target.closest('input[type="checkbox"][data-stale]') : null;
        if (!inp) return;
        const item = stale.find((x) => x.id === inp.dataset.stale);
        if (item) item.remove = !!inp.checked;
        renderStale();
      });
    }
    listEl.addEventListener('input', (e) => {
      const nameInp = e.target && e.target.closest ? e.target.closest('input.mname') : null;
      if (nameInp) {
        const item = itemById(nameInp.dataset.mid);
        if (item) item.name = nameInp.value;
        return;
      }
      const costInp = e.target && e.target.closest ? e.target.closest('input.mcost') : null;
      if (costInp) {
        const item = itemById(costInp.dataset.mid);
        if (item) {
          const raw = String(costInp.value || '').trim();
          if (raw === '' || !isFinite(Number(raw))) delete item.cost;
          else item.cost = Math.max(0, Math.min(1000, Number(raw)));
        }
      }
    });
    listEl.addEventListener('keydown', (e) => {
      const cls = e.target && e.target.classList;
      if (e.key === 'Enter' && cls && (cls.contains('mname') || cls.contains('mcost'))) {
        e.preventDefault();
        e.target.blur();
      }
    });
    if (qEl) {
      qEl.addEventListener('input', () => {
        filter = qEl.value.trim().toLowerCase();
        render();
      });
    }
    if (allEl) {
      allEl.addEventListener('change', () => {
        visible().forEach((m) => { m.enabled = !!allEl.checked; });
        render();
      });
    }
    if (staleAllEl) {
      staleAllEl.addEventListener('change', () => {
        stale.forEach((m) => { m.remove = !!staleAllEl.checked; });
        renderStale();
      });
    }
    // 切换 Key 继续获取:在弹窗内直接用所选 Key 再拉一批,并入当前清单(同模型并入同一条优先级链)
    if (refetchBtn) {
      refetchBtn.addEventListener('click', async () => {
        if (typeof opts.onRefetch !== 'function') { close(true, 'again'); return; }
        const kid = fetchKeyEl ? fetchKeyEl.value : '';
        refetchBtn.disabled = true;
        const old = refetchBtn.textContent;
        refetchBtn.textContent = '获取中…';
        try {
          const res = await opts.onRefetch(kid);
          const list = (res && res.models) || res || [];
          if (!list.length) { if (window.OC && OC.toast) OC.toast('该 Key 未返回模型'); return; }
          fetchedKeyId = String((res && res.keyId) || kid || '');
          mergeModels(list, fetchedKeyId);
          items.sort((a, b) => a.id.localeCompare(b.id));
          rebuildStale();
          render();
          if (window.OC && OC.toast) OC.toast('已并入 ' + list.length + ' 个模型（密钥「' + (keyName(fetchedKeyId) || '默认密钥') + '」）');
        } catch (e) {
          if (window.OC && OC.toast) OC.toast('获取失败:' + e.message, true);
        } finally {
          refetchBtn.disabled = false;
          refetchBtn.textContent = old;
        }
      });
    }

    const close = (apply, action) => {
      if (apply && typeof opts.onApply === 'function') {
        const keepOpen = opts.onApply(
          items.map((m) => {
            const row = { id: m.id, name: String(m.name || '').trim() || m.id, enabled: !!m.enabled };
            if (Array.isArray(m.keyIds) && m.keyIds.length) { row.keyIds = m.keyIds.map((x) => String(x)); row.keyId = String(m.keyIds[0]); }
            else if (m.keyId) row.keyId = String(m.keyId);
            return row;
          }),
          stale.filter((m) => m.remove).map((m) => m.id),
          action || 'apply'
        );
        // 调用方返回 false 表示「继续获取」:保留弹窗
        if (keepOpen === false) return;
      }
      if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(mask);
      else mask.remove();
      setTimeout(() => { if (mask.parentNode) mask.remove(); }, 360);
    };

    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.closest('[data-act="close"]') || e.target.closest('[data-act="cancel"]')) {
        close(false);
        return;
      }
      if (e.target.closest('[data-act="ok"]')) close(true, 'apply');
    });

    render();
    // 表格渲染完才量得出真实宽度:绑定横向滑动提示 + 吸附列阴影
    bindScrollAffordance(listEl, scrollTipEl);
    bindScrollAffordance(staleEl, null);
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    if (qEl) setTimeout(() => qEl.focus(), 80);
    return mask;
  }

  function bindAppTips() {
    if (document.documentElement.dataset.ocTipsBound === '1') return;
    document.documentElement.dataset.ocTipsBound = '1';
    let tip = null;
    let hideTimer = 0;
    let autoHideTimer = 0;
    const TIP_DELAY = 420;
    // 触摸端没有 mouseout,提示会一直挂在屏幕上(表现为「点一下菜单,黑框菜单二字就一直显示」)。
    // 因此所有提示最多展示这么久后自动消失;触摸触发的提示会更快收起。
    const TIP_LIFE_POINTER = 4000;
    const TIP_LIFE_TOUCH = 2400;

    function ensureTip() {
      if (tip) return tip;
      tip = document.createElement('div');
      tip.className = 'oc-tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
      return tip;
    }

    function hideTip() {
      clearTimeout(hideTimer);
      clearTimeout(autoHideTimer);
      hideTimer = 0;
      autoHideTimer = 0;
      if (tip) tip.classList.remove('show');
    }

    function showTip(el, touch) {
      const text = (el.getAttribute('data-tip') || el.getAttribute('aria-label') || '').trim();
      if (!text) return;
      const box = ensureTip();
      box.textContent = text;
      box.classList.add('show');
      const r = el.getBoundingClientRect();
      const tw = box.offsetWidth;
      const th = box.offsetHeight;
      let left = r.left + (r.width - tw) / 2;
      let top = r.top - th - 8;
      if (top < 8) top = r.bottom + 8;
      left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
      // 自动消失:防止触摸端提示永久停留
      clearTimeout(autoHideTimer);
      autoHideTimer = window.setTimeout(hideTip, touch ? TIP_LIFE_TOUCH : TIP_LIFE_POINTER);
    }

    function tipTarget(el) {
      if (!el || !el.closest) return null;
      return el.closest('[data-tip]');
    }

    function onEnter(e) {
      const el = tipTarget(e.target);
      if (!el) return;
      if (el.hasAttribute('title')) el.removeAttribute('title');
      hideTip();
      const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
      hideTimer = window.setTimeout(() => showTip(el, touch), touch ? 0 : TIP_DELAY);
    }
    function onLeave(e) {
      const from = tipTarget(e.target);
      const to = tipTarget(e.relatedTarget);
      if (from && from !== to) hideTip();
    }

    document.addEventListener('pointerover', onEnter);
    document.addEventListener('mouseover', onEnter);
    document.addEventListener('pointerout', onLeave);
    document.addEventListener('mouseout', onLeave);
    document.addEventListener('pointerdown', hideTip, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }

  function restyleNativeTitles(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[title]').forEach((el) => {
      const text = (el.getAttribute('title') || '').trim();
      if (!text) { el.removeAttribute('title'); return; }
      if (!el.getAttribute('data-tip')) el.setAttribute('data-tip', text);
      el.removeAttribute('title');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      restyleNativeTitles(document);
      bindAppTips();
    });
  } else {
    restyleNativeTitles(document);
    bindAppTips();
  }

  const titleObserver = new MutationObserver((recs) => {
    recs.forEach((rec) => {
      // 运行时改 title(如思考强度「中→高」、模型健康度)要同步到 data-tip,
      // 否则自定义提示永远停留在初次转换时的旧文案
      if (rec.type === 'attributes' && rec.attributeName === 'title') {
        const el = rec.target;
        const text = (el.getAttribute('title') || '').trim();
        if (!text) return;
        el.setAttribute('data-tip', text);
        el.removeAttribute('title');
        return;
      }
      rec.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.hasAttribute && n.hasAttribute('title')) restyleNativeTitles(n);
        else if (n.querySelectorAll) restyleNativeTitles(n);
      });
    });
  });
  titleObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });

  // 生图模型名启发式(与后端 tc_image_model_name_hint 对应):供前后台共同复用。
  // 仅用于 UI 默认勾选/下拉建议,最终以后台显式标记(image 字段)为准。
  const IMAGE_HINTS = [
    /dall-?e/, /gpt-image/, /\bimage-?gen(eration)?s?\b/, /stable-?diffusion/,
    /\bsdxl\b/, /\bsd3\b/, /\bsd-?3(\.5)?\b/, /sd-?turbo/, /\bflux\b/, /flux-?\d/,
    /midjourney/, /\bniji\b/, /seedream/, /\bimagen\b/, /\bkolors\b/, /cogview/,
    /qwen-?image/, /\bwanx\b/, /wan-?\d/, /hunyuan-?image/, /grok-?\d*(-|_)?image/,
    /-image\b/, /image-generation/,
  ];
  function isImageModelName(id) {
    const s = String(id || '').toLowerCase();
    if (!s) return false;
    return IMAGE_HINTS.some((re) => re.test(s));
  }

  // 视频模型名启发式(与后端 tc_video_model_name_hint 对应)
  const VIDEO_HINTS = [
    /agnes-video/, /(^|[^a-z0-9])video(s)?([^a-z0-9]|$)/, /text-to-video/, /image-to-video/,
    /(^|[^a-z0-9])(t2v|i2v)([^a-z0-9]|$)/, /kling/, /sora/, /(^|[^a-z0-9])veo([^a-z0-9]|$)/,
    /runway/, /pika/, /seedance/, /hailuo/, /vidu/, /wan-?video/,
  ];
  function isVideoModelName(id) {
    const s = String(id || '').toLowerCase();
    if (!s) return false;
    return VIDEO_HINTS.some((re) => re.test(s));
  }

  // 暴露全局
  window.OC = window.OC || {};
  window.OC.isImageModelName = isImageModelName;
  window.OC.isVideoModelName = isVideoModelName;
  window.OC.openSelect = openSelect;
  window.OC.closeSelect = closeOpenMenu;
  window.OC.bindScrollAffordance = bindScrollAffordance;
  window.OC.bindModelChecklist = bindModelChecklist;
  window.OC.openFetchedModelsModal = openFetchedModelsModal;
  // ============ 原生 <select> → 站内自定义下拉 ============
  // 全站唯一实现:任何页面/模块只要提供 select 元素即可换成 .select-box 观感,
  // 交互沿用原生 change 语义(现有监听器无需改动)。
  function enhanceSelect(sel, opts) {
    opts = opts || {};
    if (!sel || sel.tagName !== 'SELECT' || sel.dataset.enhanced === '1') return null;
    if (typeof openSelect !== 'function') return null;
    sel.dataset.enhanced = '1';
    sel.style.display = 'none';
    // 无障碍:原生 select 仍留在 DOM 里(只是隐藏),给读屏器保留语义
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');

    const box = document.createElement('div');
    box.className = 'select-box' + (opts.className ? ' ' + opts.className : '');
    if (sel.id) box.id = sel.id + '-box';
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-haspopup', 'listbox');
    box.setAttribute('aria-expanded', 'false');
    // 原 select 上的内联布局样式(如工具栏里的 flex:1;min-width)挪到新控件,
    // 否则换完控件这一行会塌掉。只搬布局相关属性,视觉交给 .select-box。
    ['flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'min-width', 'max-width', 'width', 'margin'].forEach((prop) => {
      const v = sel.style.getPropertyValue(prop);
      if (v) box.style.setProperty(prop, v);
    });
    if (sel.classList.contains('search-input')) box.classList.add('search-input');
    const label = document.createElement('span');
    label.className = 'sb-label';
    const arrow = document.createElement('span');
    arrow.className = 'sb-arrow';
    arrow.innerHTML = '<svg class="oc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5L12 14.5 17 9.5"/></svg>';
    box.appendChild(label);
    box.appendChild(arrow);
    sel.parentNode.insertBefore(box, sel);

    const items = () => Array.prototype.map.call(sel.options, (o) => ({ value: o.value, label: o.textContent }));
    const sync = (v) => {
      const hit = items().find((o) => o.value === String(v));
      label.textContent = hit ? hit.label : String(v == null ? '' : v);
      box.dataset.value = sel.value;
    };
    // 选项动态填充(如文件夹列表变化)后重新同步显示文字
    box.syncLabel = () => sync(sel.value);
    sync(sel.value);

    const open = () => {
      // 只读态取决于原生 select 的 disabled:新控件是独立元素,隐藏的原生控件拦不住点击,
      // 所以这里要自己守一道(工具箱「查看源码」把分类下拉设成只读就是靠这条路)。
      if (sel.disabled) return;
      box.setAttribute('aria-expanded', 'true');
      openSelect(box, items(), {
        selected: sel.value,
        center: !!opts.center,
        menuClass: opts.menuClass || '',
        onSelect: (val) => {
          box.setAttribute('aria-expanded', 'false');
          if (sel.value === val) { sync(val); return; }
          sel.value = val;
          sync(val);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    };
    box.addEventListener('click', open);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    // 外部直接给 select 赋值时同步显示文字
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && !sel.dataset.valuePatched) {
      sel.dataset.valuePatched = '1';
      Object.defineProperty(sel, 'value', {
        get() { return desc.get.call(sel); },
        set(v) { desc.set.call(sel, v); sync(v); },
        configurable: true,
      });
    }
    // 只读态同理:调用方写的是 cat.disabled = true,不跟着反映的话,新控件看着还能点开
    const syncDisabled = (off) => {
      box.classList.toggle('disabled', !!off);
      box.setAttribute('aria-disabled', off ? 'true' : 'false');
      // 原生控件被 disabled 后本来就进不了 Tab 序列,新控件上要手动对齐
      box.setAttribute('tabindex', off ? '-1' : '0');
    };
    const ddesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'disabled');
    if (ddesc && !sel.dataset.disabledPatched) {
      sel.dataset.disabledPatched = '1';
      Object.defineProperty(sel, 'disabled', {
        get() { return ddesc.get.call(sel); },
        set(v) { ddesc.set.call(sel, v); syncDisabled(v); },
        configurable: true,
      });
    }
    syncDisabled(sel.disabled);
    return box;
  }
  // 按容器批量替换(未指定则全文档);scope 内的 select 都会被接管
  function enhanceSelects(scope) {
    const root = scope || document;
    const out = [];
    root.querySelectorAll('select').forEach((sel) => {
      const box = enhanceSelect(sel);
      if (box) out.push(box);
    });
    return out;
  }

  window.OC.enhanceSelect = enhanceSelect;
  window.OC.enhanceSelects = enhanceSelects;
  window.OC.restyleNativeTitles = restyleNativeTitles;
})();
