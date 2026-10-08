'use strict';
/* 管理后台逻辑 */
const $ = (id) => document.getElementById(id);
const token = localStorage.getItem('oc_token') || '';

if (window.OCUI && typeof window.OCUI.initTheme === 'function') {
  window.OCUI.initTheme();
}

function api(path, opts = {}) {
  opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
  return fetch(apiUrl(path), opts).then(async (r) => {
    if (r.status === 401) { location.href = apiUrl('/login'); throw new Error('未登录'); }
    return r;
  });
}
// 容错解析 JSON:响应不是 JSON(服务器返回 HTML 错误页 / 网关拦截页)时,
// 把 HTTP 状态与响应片段一并带出——否则「非预期内容」四个字根本没法排查。
async function readJsonSafe(res) {
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      error: {
        message: '服务器未返回任何内容（HTTP ' + res.status + '）。'
          + '常见原因：请求被网关截断（如邮件发送耗时超过网关超时）、或后端进程异常退出。请查看服务器错误日志。',
      },
    };
  }
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try { return JSON.parse(trimmed); } catch (e) { /* noop */ }
  }
  // 剥掉标签只留文字,便于在提示区里直接读
  const plain = trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const hint = /502|503|504/.test(String(res.status))
    ? '（网关返回的错误页，通常是后端超时或异常退出）'
    : '';
  return {
    error: {
      message: '服务器返回了非 JSON 内容（HTTP ' + res.status + '）' + hint
        + '：' + (plain ? plain.slice(0, 300) : '（内容为空）'),
    },
  };
}
function toast(msg, isError = false) {
  if (window.OCUI && window.OCUI.toast) return window.OCUI.toast(msg, isError);
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 把原生 <select> 换成站内统一的自定义下拉(.select-box)。
// 后台此前混用两种控件:原生 select 点开是操作系统菜单,和旁边 11 个自定义下拉完全两个观感,
// 长选项还会把整行撑满。这里保持原来的 .value / change 语义不变,
// 所以调用方(读取 $('x').value、监听 change、直接赋值)一句都不用改。
// 用法:enhanceNativeSelect('th-mode') —— 在 DOM 就绪后调用一次。
// 复用 components.js 的通用实现(全站同一套观感)
function enhanceNativeSelect(id, opts = {}) {
  const sel = $(id);
  if (!sel || !window.OC || typeof window.OC.enhanceSelect !== 'function') return null;
  return window.OC.enhanceSelect(sel, opts);
}

function enhanceAllNativeSelects(ids) {
  ids.forEach((id) => enhanceNativeSelect(id));
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

// ============ 统计 ============
// ============ 服务器状态看板（概览顶部） ============
// 取不到的指标（如 Windows 下的 CPU/整机内存）直接隐藏，不显示会误导人的 0
function fmtBytesBig(n) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtUptime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分';
}
// 环形指标卡:标签(单行省略) + 主值(大字) + 副值(小字省略)。
// 主/副分离是为了让「2.61 GB / 5.79 GB」这类长串不再挤成两行乱折。
function sysRing(label, value, pct, color, sub) {
  const has = (pct !== null && pct !== undefined);
  const p = has ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  return '<div class="sys-meter">'
    + '<div class="sys-ring"' + (has ? ' style="--ring-color:' + color + ';--pct:' + p + '"' : ' style="--ring-color:#cbd5e1"') + '>'
    + '<span>' + (has ? p + '%' : '—') + '</span></div>'
    + '<div class="sys-meter-meta">'
    + '<div class="k">' + escapeHtml(label) + '</div>'
    + '<div class="v">' + escapeHtml(value) + '</div>'
    + (sub ? '<div class="sub">' + escapeHtml(sub) + '</div>' : '')
    + '</div></div>';
}
function sysRingColor(pct) { return pct >= 85 ? '#dc2626' : (pct >= 60 ? '#f59e0b' : '#16a34a'); }
// 无环数值卡片:网速、运行时长、体积这类没有百分比可言的指标用大字直接显示
function sysStat(label, value, sub) {
  return '<div class="sys-meter sys-stat"><div class="sys-meter-meta">'
    + '<div class="k">' + escapeHtml(label) + '</div><div class="v">' + escapeHtml(String(value)) + '</div>'
    + (sub ? '<div class="sub">' + escapeHtml(sub) + '</div>' : '') + '</div></div>';
}
function fmtBps(n) { return fmtBytesBig(n) + '/s'; }
function fmtCores(n) { return (Math.round(Number(n) * 100) / 100) + ' 核'; }
async function loadSystemBoard() {
  const metersEl = $('sys-meters');
  if (!metersEl) return;
  let d = null;
  try {
    const r = await api('/api/admin/system');
    d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
  } catch (e) {
    metersEl.innerHTML = '<p class="muted small" style="margin:0">服务器指标加载失败：' + escapeHtml(e.message || '') + '</p>';
    return;
  }
  const cpu = d.cpu || {}, mem = d.memory || {}, disk = d.disk || {}, net = d.net || {};
  const uptime = d.uptime || {}, srv = d.server || {}, quota = d.quota || {};
  const meters = [];
  // 虚拟主机/容器里整机 CPU 取不到,后端会退一步读 cgroup 配额,这里同样按「配额 > 整机 > 核数」兜底
  const hasQuotaCpu = (quota.cpuPercent !== null && quota.cpuPercent !== undefined)
    || (quota.cpuCoreUsage !== null && quota.cpuCoreUsage !== undefined);
  if (hasQuotaCpu) {
    const sub = [];
    if (quota.cpuCores) sub.push('配额 ' + fmtCores(quota.cpuCores));
    if (quota.cpuCoreUsage !== null && quota.cpuCoreUsage !== undefined) sub.push('现用 ' + fmtCores(quota.cpuCoreUsage));
    meters.push(sysRing(quota.cpuCores ? 'CPU 配额' : 'CPU 用量',
      quota.cpuCoreUsage !== null && quota.cpuCoreUsage !== undefined ? fmtCores(quota.cpuCoreUsage) : '—',
      quota.cpuPercent, sysRingColor(quota.cpuPercent || 0), sub.join(' · ')));
  } else if (cpu.percent !== null && cpu.percent !== undefined) {
    const la = (cpu.loadavg && cpu.loadavg.length) ? '负载 ' + cpu.loadavg.join(' / ') : '';
    meters.push(sysRing('CPU 使用率', cpu.cores ? cpu.cores + ' 核' : '—', cpu.percent, sysRingColor(cpu.percent), la));
  } else if (cpu.cores) {
    meters.push(sysRing('CPU', cpu.cores + ' 核', null, '#cbd5e1'));
  }
  // 内存同理:配额比整机更有约束力时(或整机取不到)用配额;此时 PHP 进程内存另立一格,免得丢掉 memory_limit 视角
  const hasQuotaMem = quota.memLimitBytes > 0 && quota.memUsedBytes !== null && quota.memUsedBytes !== undefined
    && (!mem.totalBytes || quota.memLimitBytes < mem.totalBytes);
  const phpRing = () => {
    if (!mem.phpBytes) return;
    const lim = mem.phpLimitBytes;
    meters.push(sysRing('PHP 进程内存', fmtBytesBig(mem.phpBytes),
      lim ? mem.phpBytes * 100 / lim : null, sysRingColor(lim ? mem.phpBytes * 100 / lim : 0),
      lim ? '上限 ' + fmtBytesBig(lim) : ''));
  };
  if (hasQuotaMem) {
    const pct = quota.memUsedBytes * 100 / quota.memLimitBytes;
    meters.push(sysRing('内存配额', fmtBytesBig(quota.memUsedBytes), pct, sysRingColor(pct), '共 ' + fmtBytesBig(quota.memLimitBytes)));
  } else if (mem.totalBytes) {
    const pct = mem.usedBytes * 100 / mem.totalBytes;
    meters.push(sysRing('内存', fmtBytesBig(mem.usedBytes), pct, sysRingColor(pct), '共 ' + fmtBytesBig(mem.totalBytes)));
  }
  if (disk.totalBytes && disk.freeBytes !== null && disk.freeBytes !== undefined) {
    const used = disk.totalBytes - disk.freeBytes;
    const pct = used * 100 / disk.totalBytes;
    meters.push(sysRing('磁盘', fmtBytesBig(used), pct, sysRingColor(pct), '共 ' + fmtBytesBig(disk.totalBytes)));
  }
  // 网速:上行=出站(回复与图片发给用户),下行=入站(用户请求进来)
  if (net.txBps !== null && net.txBps !== undefined) {
    meters.push(sysStat('上行网速', fmtBps(net.txBps), '累计出站 ' + fmtBytesBig(net.txBytes)));
  }
  if (net.rxBps !== null && net.rxBps !== undefined) {
    meters.push(sysStat('下行网速', fmtBps(net.rxBps), '累计入站 ' + fmtBytesBig(net.rxBytes)));
  }
  if (uptime.systemSec !== null && uptime.systemSec !== undefined) meters.push(sysStat('系统运行时长', fmtUptime(uptime.systemSec)));
  if (uptime.appSec !== null && uptime.appSec !== undefined) meters.push(sysStat('应用运行时长', fmtUptime(uptime.appSec)));
  if (d.db && d.db.bytes) {
    const dataBytes = (d.storage || []).reduce((sum, c) => sum + (c.bytes || 0), 0);
    meters.push(sysStat('数据库大小', fmtBytesBig(d.db.bytes), dataBytes ? '数据目录共 ' + fmtBytesBig(dataBytes) : ''));
  }
  phpRing();
  if ((hasQuotaCpu || hasQuotaMem) && quota.source) {
    meters.push('<p class="muted small sys-note">整机指标被当前环境屏蔽，CPU / 内存为账户配额用量（' + escapeHtml(quota.source) + '），非物理机总量。</p>');
  }
  metersEl.innerHTML = meters.join('') || '<p class="muted small" style="margin:0">当前环境未提供 CPU / 内存指标。</p>';
  const hostEl = $('sys-host');
  if (hostEl) {
    const parts = [
      'v' + (d.version || '?'), srv.phpVersion ? 'PHP ' + srv.phpVersion : '', srv.sapi, srv.os,
      srv.arch, srv.sqliteVersion ? 'SQLite ' + srv.sqliteVersion : '', srv.host, srv.timezone,
    ].filter(Boolean);
    // 环境信息很长(内核版本 + 主机名等),单行显示会挤压右侧按钮:
    // 只显示前若干项,剩余折成 +N,完整内容放 title 里悬停可见。
    const shown = parts.slice(0, 4).join(' · ');
    const rest = parts.length > 4 ? parts.slice(4) : [];
    hostEl.textContent = rest.length ? (shown + ' +' + rest.length) : shown;
    hostEl.title = parts.join(' · ');
  }
  const upEl = $('sys-updated');
  if (upEl) upEl.textContent = '更新于 ' + fmtTime(Date.now()).replace(/^.*\s/, '').replace(/:\d\d$/, '');
  OV.sys = d;
  renderOverviewGrid();
}
(function initSystemBoard() {
  const btn = $('sys-refresh');
  if (btn) btn.addEventListener('click', () => { btn.disabled = true; Promise.resolve(loadSystemBoard()).then(() => { btn.disabled = false; }); });
})();

// ============ 概览(只放用户 / 运营 / 对话 / 调用,服务器指标见上方看板) ============
// 两块数据来自不同接口(系统看板给用户与调用,统计接口给额度),谁先到都先渲染一次,
// 后到的补齐;这样单独刷新任一边都不会把另一边的格子抹掉。
const OV = { sys: null, stats: null };
// 大数字缩写:额度类数值动辄上亿,原始数字既读不了也会撑破概览卡片(悬停可见完整值)
function fmtBigNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  const abs = Math.abs(n);
  const cut = (x) => String(Math.round(x * 100) / 100);
  if (abs >= 1e16) return cut(n / 1e16) + ' 亿亿';
  if (abs >= 1e12) return cut(n / 1e12) + ' 万亿';
  if (abs >= 1e8)  return cut(n / 1e8) + ' 亿';
  if (abs >= 1e4)  return cut(n / 1e4) + ' 万';
  return n.toLocaleString('en-US');
}
function ovCard(label, value, sub, full) {
  return '<div class="stat-card"><div class="stat-value"'
    + (full != null && full !== String(value) ? ' title="' + escapeHtml(full) + '"' : '')
    + '>' + escapeHtml(String(value)) + '</div>'
    + '<div class="stat-label">' + escapeHtml(label) + '</div>'
    + (sub ? '<div class="stat-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>';
}
function renderOverviewGrid() {
  const el = $('stats-grid');
  if (!el) return;
  const sys = OV.sys || {}, s = (OV.stats || {}).stats || {};
  const users = sys.users || {}, calls = sys.calls || {}, content = sys.content || {};
  const cards = [];
  if (OV.sys) {
    cards.push(['当前在线用户', users.online, '最近 ' + (users.onlineWindowMin || 5) + ' 分钟活跃']);
    const adminN = s.adminCount ? ' · 管理员 ' + s.adminCount : '';
    cards.push(['总用户', users.total, '24 小时活跃 ' + (users.active24h || 0) + adminN]);
    cards.push(['今日调用', calls.today, '近 7 天 ' + (calls.last7d || 0)]);
    cards.push(['累计调用', calls.total]);
    cards.push(['对话总数', content.chats, content.deletedChats ? '已删除留档 ' + content.deletedChats : '']);
    cards.push(['模型供应商', content.providers, '用户分组 ' + (content.groups || 0)]);
    cards.push(['助手数', content.assistants]);
  }
  if (OV.stats) {
    const given = s.totalQuotaGiven || 0;
    cards.push(['已发放额度', fmtBigNum(given), '', String(given)]);
    const freeQ = OV.stats.freeQuotaUnlimited ? '不限' : fmtBigNum(OV.stats.freeQuota || 0);
    cards.push(['注册默认额度', freeQ, '', OV.stats.freeQuotaUnlimited ? '' : String(OV.stats.freeQuota || 0)]);
  }
  el.innerHTML = cards.map((c) => ovCard(c[0], c[1], c[2])).join('');
}

// ============ 存储管理 ============
function stRow(name, desc, bytes, maxBytes, action) {
  const pct = maxBytes > 0 ? Math.min(100, bytes * 100 / maxBytes) : 0;
  return '<div class="st-row">'
    + '<div class="st-row-main"><div class="st-row-name">' + escapeHtml(name) + '</div>'
    + '<div class="st-row-desc">' + escapeHtml(desc) + '</div>'
    + '<div class="st-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>'
    + '<div class="st-row-val">' + fmtBytesBig(bytes) + (action || '') + '</div></div>';
}
async function loadStorage() {
  const catEl = $('st-categories');
  if (!catEl) return;
  catEl.innerHTML = '<p class="muted small">加载中…</p>';
  let d = null;
  try {
    const r = await api('/api/admin/storage');
    d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
  } catch (e) {
    catEl.innerHTML = '<p class="muted small">加载失败：' + escapeHtml(e.message || '') + '</p>';
    return;
  }
  const total = d.totalBytes || 1;
  const byKey = {};
  (d.categories || []).forEach((c) => { byKey[c.key] = c; });
  const meters = [sysRing('数据目录占用', fmtBytesBig(d.totalBytes), null, '#cbd5e1')];
  if (d.disk && d.disk.totalBytes) {
    const used = d.disk.totalBytes - d.disk.freeBytes;
    const pct = used * 100 / d.disk.totalBytes;
    meters.push(sysRing('磁盘已用', fmtBytesBig(used) + ' / ' + fmtBytesBig(d.disk.totalBytes), pct, sysRingColor(pct)));
  }
  const quotaBytes = (d.quotaMb > 0 ? d.quotaMb : 0) * 1048576;
  meters.push(sysRing('生图留存', fmtBytesBig(d.images.bytes) + (d.archiveEnabled ? '' : '（留存已关闭）'),
    quotaBytes > 0 ? d.images.bytes * 100 / quotaBytes : null, d.images.bytes * 100 > quotaBytes * 85 ? '#f59e0b' : '#16a34a'));
  meters.push(sysRing('数据备份', d.backups.count + ' 个文件', null, '#cbd5e1'));
  if ($('st-meters')) $('st-meters').innerHTML = meters.join('');
  catEl.innerHTML = (d.categories || []).map((c) => stRow(c.name,
    c.desc + (c.exists ? '' : '（当前不存在）') + (c.files ? ' · ' + c.files + ' 个文件' : ''), c.bytes, total)).join('');
  const cl = [];
  if (byKey.imgcache && byKey.imgcache.bytes > 0) cl.push(['imagecache', '图片代理缓存（' + (byKey.imgcache.files || 0) + ' 个文件）', fmtBytesBig(byKey.imgcache.bytes) + ' 可释放']);
  if (d.images.count > 0) cl.push(['images', '生图留存（' + d.images.count + ' 个文件）', fmtBytesBig(d.images.bytes) + ' 可释放']);
  if (d.backups.count > 0) cl.push(['backups', '数据备份（' + d.backups.count + ' 个文件）', fmtBytesBig(d.backups.bytes) + ' 可释放']);
  if (byKey.logs && byKey.logs.bytes > 0) cl.push(['logs', '运行日志（' + d.logs.count + ' 条）', fmtBytesBig(byKey.logs.bytes) + ' 可释放']);
  if (byKey.update && byKey.update.bytes > 0) cl.push(['updates', '更新残留（' + (byKey.update.files || 0) + ' 个文件）', fmtBytesBig(byKey.update.bytes) + ' 可释放']);
  if ($('st-clean')) $('st-clean').innerHTML = cl.length ? cl.map((x) =>
    '<div class="st-row"><div class="st-row-main"><div class="st-row-name">' + escapeHtml(x[1]) + '</div>'
    + '<div class="st-row-desc">' + escapeHtml(x[2]) + '</div></div>'
    + '<div class="st-row-val"><button class="btn small st-danger" type="button" data-st-clean="' + x[0] + '">清理</button></div></div>').join('')
    : '<p class="muted small">暂无可清理项。</p>';
  if ($('st-deleted')) {
    const del = d.deleted || { count: 0, bytes: 0, users: [] };
    $('st-deleted').innerHTML = del.count
      ? '<div class="st-row"><div class="st-row-main"><div class="st-row-name">已删除对话留档（' + del.count + ' 条）</div>'
        + '<div class="st-row-desc">涉及 ' + (del.users || []).length + ' 个用户 · 估算 ' + fmtBytesBig(del.bytes)
        + ' · 清理后不可恢复' + (del.users || []).slice(0, 3).map((u) => ' · ' + escapeHtml(u.name) + ' ' + u.count + ' 条').join('') + '</div></div>'
        + '<div class="st-row-val"><button class="btn small" type="button" id="st-deleted-open">查看 / 清理</button></div></div>'
      : '<p class="muted small">暂无用户删除的对话。</p>';
  }
  // 文件清单一律分页:接口只给最近 30 个,全铺出来会随文件数把页面拉得很长。
  // 折叠标题上直接写清「多少文件 / 多大」,不展开也知道规模。
  // 每次刷新数据回到第一页(文件是「最近优先」的,刷新后停在旧页码没有意义)
  ST_PAGES.data = { images: d.images, backups: d.backups };
  ST_PAGES.resetPages();
  ST_PAGES.repaint();
}
// 存储管理页里「文件清单」的分页状态:两份清单共用一套渲染,接口只取一次。
// 单独放在模块级是因为翻页按钮要重画,而 loadStorage 的局部变量那时已经出栈了。
const ST_PAGES = {
  data: { images: { count: 0, items: [], bytes: 0 }, backups: { count: 0, items: [], bytes: 0 } },
  per: 10,
  resetPages() {
    const a = $('st-images-pager'), b = $('st-backups-pager');
    if (a) a.dataset.page = '1';
    if (b) b.dataset.page = '1';
  },
  repaint() {
    ST_PAGES.render('st-images', 'st-images-pager', 'st-images-sum', ST_PAGES.data.images, '暂无生图留存文件。');
    ST_PAGES.render('st-backups', 'st-backups-pager', 'st-backups-sum', ST_PAGES.data.backups, '暂无备份文件（可在「版本更新」页开启自动备份）。');
  },
  render(boxId, pagerId, sumId, list, emptyText) {
    const box = $(boxId), pager = $(pagerId), sum = $(sumId);
    if (!box) return;
    const total = (list && list.count) || 0;
    const items = (list && list.items) || [];
    const fileRow = (f) => '<div class="st-row"><div class="st-row-main"><div class="st-row-name">' + escapeHtml(f.name) + '</div>'
      + '<div class="st-row-desc">' + fmtTime(f.mtime) + '</div></div>'
      + '<div class="st-row-val">' + fmtBytesBig(f.bytes) + '</div></div>';
    if (!total) {
      if (sum) sum.textContent = '（无）';
      box.innerHTML = '<p class="muted small">' + emptyText + '</p>';
      if (pager) { pager.innerHTML = ''; pager.dataset.page = '1'; }
      return;
    }
    if (sum) sum.textContent = '（' + total + ' 个 · ' + fmtBytesBig(list.bytes) + '）';
    const per = ST_PAGES.per;
    let page = Math.max(1, parseInt(pager && pager.dataset.page, 10) || 1);
    const pages = Math.max(1, Math.ceil(items.length / per));
    if (page > pages) page = pages;
    if (pager) pager.dataset.page = String(page);
    box.innerHTML = items.slice((page - 1) * per, page * per).map(fileRow).join('')
      + (total > items.length
        ? '<p class="muted small">仅列出最近 ' + items.length + ' 个，共 ' + total + ' 个（完整清单在服务器的 data 目录）。</p>'
        : '');
    if (pager) {
      pager.innerHTML = items.length <= per ? ''
        : '<button class="btn small" type="button" data-st-page="' + boxId + '" data-st-dir="-1"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>'
          + '<span class="muted small">第 ' + page + ' / ' + pages + ' 页</span>'
          + '<button class="btn small" type="button" data-st-page="' + boxId + '" data-st-dir="1"' + (page >= pages ? ' disabled' : '') + '>下一页</button>';
    }
  },
};
// ============ 用户删除的对话（云端留档）查看 / 批量清理 ============
let DC_PAGE = 1;
let DC_DATA = { items: [], total: 0, pageSize: 50 };
const DC_SELECTED = new Set(); // 'userId\nchatId'
function dcKey(it) { return it.userId + '\n' + it.chatId; }
function dcOpenModal() {
  const modal = $('deleted-chats-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
}
function dcCloseModal() {
  const modal = $('deleted-chats-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.closeModal(modal);
  else modal.classList.add('hidden');
}
async function loadDeletedChats(page) {
  const content = $('deleted-chats-content');
  if (!content) return;
  if (page) DC_PAGE = page;
  content.innerHTML = '<p class="muted small" style="text-align:center;padding:24px 0">加载中…</p>';
  try {
    const q = $('dc-search');
    const kw = q ? q.value.trim() : '';
    const url = '/api/admin/chats/deleted?page=' + DC_PAGE + '&pageSize=50' + (kw ? '&q=' + encodeURIComponent(kw) : '');
    const r = await api(url);
    const d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
    DC_DATA = { items: d.items || [], total: d.total || 0, pageSize: d.pageSize || 50 };
    // 清掉不在当前结果里的选中项
    const valid = new Set(DC_DATA.items.map(dcKey));
    Array.from(DC_SELECTED).forEach((k) => { if (!valid.has(k)) DC_SELECTED.delete(k); });
    renderDeletedChats();
  } catch (e) {
    content.innerHTML = '<p class="muted small" style="text-align:center;padding:24px 0">加载失败：' + escapeHtml(e.message || '') + '</p>';
  }
}
function renderDeletedChats() {
  const content = $('deleted-chats-content');
  if (!content) return;
  const items = DC_DATA.items || [];
  if (!items.length) {
    content.innerHTML = '<p class="muted small" style="text-align:center;padding:24px 0">' + (DC_PAGE > 1 ? '本页没有记录' : '暂无用户删除的对话') + '</p>';
  } else {
    content.innerHTML = items.map((it) => {
      const k = dcKey(it);
      const when = it.deletedAt ? it.deletedAt : it.updatedAt;
      return '<div class="st-row"><div class="st-row-main">'
        + '<label class="user-form-admin" style="margin:0"><span class="switch"><input type="checkbox" class="dc-pick" data-k="' + escapeHtml(k) + '"' + (DC_SELECTED.has(k) ? ' checked' : '') + '><span class="slider"></span></span>'
        + '<span class="st-row-name">' + escapeHtml(it.title || '新对话') + (it.pinned ? ' · 置顶' : '') + '</span></label>'
        + '<div class="st-row-desc">' + escapeHtml(it.userName) + ' · ' + (it.messageCount || 0) + ' 条消息 · 删除于 ' + (when ? fmtTime(when) : '—')
        + (it.preview ? '<br>' + escapeHtml(it.preview) + (it.preview.length >= 80 ? '…' : '') : '') + '</div></div>'
        + '<div class="st-row-val"><button class="btn small" type="button" data-dc-view="' + escapeHtml(k) + '">查看</button></div></div>';
    }).join('');
  }
  const info = $('dc-page-info');
  if (info) info.textContent = DC_DATA.total ? ('共 ' + DC_DATA.total + ' 条 · 第 ' + DC_PAGE + ' 页 / 共 ' + Math.max(1, Math.ceil(DC_DATA.total / DC_DATA.pageSize)) + ' 页') : '';
  const prev = $('dc-prev');
  const next = $('dc-next');
  if (prev) prev.disabled = DC_PAGE <= 1;
  if (next) next.disabled = DC_PAGE >= Math.ceil(DC_DATA.total / DC_DATA.pageSize);
  const sel = $('dc-purge-selected');
  if (sel) { sel.disabled = DC_SELECTED.size === 0; sel.textContent = DC_SELECTED.size ? ('清理所选 (' + DC_SELECTED.size + ')') : '清理所选'; }
}
// 单条全文查看(与用户对话历史同样的 Markdown/思维链渲染)
async function viewDeletedChat(key) {
  const modal = $('deleted-chat-view-modal');
  const content = $('deleted-chat-view-content');
  if (!modal || !content) return;
  const parts = String(key).split('\n');
  const userId = parts[0];
  const chatId = parts.slice(1).join('\n');
  if (window.OCUI) window.OCUI.openModal(modal); else modal.classList.remove('hidden');
  $('deleted-chat-view-title').textContent = '对话详情';
  content.innerHTML = '<p class="muted small" style="text-align:center;padding:24px 0">加载中…</p>';
  try {
    const r = await api('/api/admin/chats/deleted/view?userId=' + encodeURIComponent(userId) + '&chatId=' + encodeURIComponent(chatId));
    const d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
    const c = d.chat;
    if (!c) { content.innerHTML = '<p class="muted small">该留档已被清理</p>'; return; }
    $('deleted-chat-view-title').textContent = (c.title || '对话') + ' · ' + ((d.user && d.user.name) || '');
    const renderMarkdown = (el, text) => {
      if (window.OCRenderer && OCRenderer.renderInto) {
        try { OCRenderer.renderInto(el, String(text || '')); return; } catch (e) { /* 回退纯文本 */ }
      }
      el.textContent = String(text || '');
    };
    const msgs = (c.messages || []).map((m) => {
      const who = m.role === 'user' ? '用户' : (m.role === 'system' ? '系统' : 'AI');
      const err = m.error ? ' <span class="log-badge err">失败</span>' : '';
      const reasoning = m.reasoning
        ? '<details class="chat-reasoning"><summary>思维链</summary><div class="chat-reasoning-body"></div></details>'
        : '';
      return '<div class="chat-msg ' + (m.role === 'user' ? 'u' : 'a') + '"><span class="chat-msg-who">' + who + escapeHtml(m.model ? ' · ' + m.model : '') + err + '</span>'
        + reasoning
        + '<div class="chat-msg-text md-prose" data-md></div></div>';
    }).join('');
    content.innerHTML = '<div class="muted small" style="margin-bottom:8px">删除时间：' + (d.deletedAt ? fmtTime(d.deletedAt) : '—')
      + ' · ' + (c.messages || []).length + ' 条消息</div><div class="chat-detail"><div class="chat-detail-msgs">' + msgs + '</div></div>';
    let mi = 0;
    (c.messages || []).forEach((m) => {
      const root = content.querySelectorAll('[data-md]')[mi++];
      if (!root) return;
      renderMarkdown(root, m.content);
      if (m.reasoning) {
        const rb = root.closest('.chat-msg') ? root.closest('.chat-msg').querySelector('.chat-reasoning-body') : null;
        if (rb) renderMarkdown(rb, m.reasoning);
      }
    });
  } catch (e) {
    content.innerHTML = '<p class="muted small">加载失败：' + escapeHtml(e.message || '') + '</p>';
  }
}
async function purgeDeletedChats(payload, confirmMsg) {
  const ok = window.OCUI && window.OCUI.confirm
    ? await window.OCUI.confirm({ title: '清理留档', message: confirmMsg, danger: true, confirmText: '清理' })
    : window.confirm(confirmMsg);
  if (!ok) return;
  try {
    const r = await api('/api/admin/chats/deleted/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '清理失败');
    DC_SELECTED.clear();
    toast('已清理 ' + (d.removed || 0) + ' 条留档，释放 ' + fmtBytesBig(d.freedBytes || 0));
    await loadDeletedChats(1);
    await loadStorage();
  } catch (e) {
    toast('清理失败：' + (e.message || ''), true);
  }
}
(function initDeletedChats() {
  // 存储管理页里的入口按钮是动态渲染的:用委托绑定
  const st = $('st-deleted');
  if (st) st.addEventListener('click', (e) => {
    if (e.target.closest('#st-deleted-open')) { DC_PAGE = 1; DC_SELECTED.clear(); dcOpenModal(); loadDeletedChats(1); }
  });
  const close = $('deleted-chats-close');
  if (close) close.addEventListener('click', dcCloseModal);
  const modal = $('deleted-chats-modal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) dcCloseModal(); });
  const viewModal = $('deleted-chat-view-modal');
  const viewClose = $('deleted-chat-view-close');
  if (viewClose) viewClose.addEventListener('click', () => {
    if (window.OCUI) window.OCUI.closeModal(viewModal); else viewModal.classList.add('hidden');
  });
  if (viewModal) viewModal.addEventListener('click', (e) => { if (e.target === viewModal) { if (window.OCUI) window.OCUI.closeModal(viewModal); else viewModal.classList.add('hidden'); } });
  const content = $('deleted-chats-content');
  if (content) {
    content.addEventListener('change', (e) => {
      const pick = e.target.closest('.dc-pick');
      if (!pick) return;
      const k = pick.getAttribute('data-k');
      if (pick.checked) DC_SELECTED.add(k); else DC_SELECTED.delete(k);
      renderDeletedChats();
    });
    content.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-dc-view]');
      if (!btn) return;
      viewDeletedChat(btn.getAttribute('data-dc-view'));
    });
  }
  const search = $('dc-search');
  if (search) search.addEventListener('input', () => { clearTimeout(search._t); search._t = setTimeout(() => loadDeletedChats(1), 300); });
  const reload = $('dc-reload');
  if (reload) reload.addEventListener('click', () => loadDeletedChats(DC_PAGE));
  const prev = $('dc-prev');
  if (prev) prev.addEventListener('click', () => { if (DC_PAGE > 1) loadDeletedChats(DC_PAGE - 1); });
  const next = $('dc-next');
  if (next) next.addEventListener('click', () => loadDeletedChats(DC_PAGE + 1));
  const sel = $('dc-purge-selected');
  if (sel) sel.addEventListener('click', () => {
    const items = Array.from(DC_SELECTED).map((k) => {
      const p = k.split('\n');
      return { userId: p[0], chatId: p.slice(1).join('\n') };
    });
    if (!items.length) return;
    const withTombs = !!($('dc-with-tombs') && $('dc-with-tombs').checked);
    purgeDeletedChats({ items: items, withTombstones: withTombs },
      '确认清理选中的 ' + items.length + ' 条留档？清理后不可恢复。' + (withTombs ? '（将同时删除墓碑）' : ''));
  });
  const all = $('dc-purge-all');
  if (all) all.addEventListener('click', () => {
    const withTombs = !!($('dc-with-tombs') && $('dc-with-tombs').checked);
    purgeDeletedChats({ all: true, withTombstones: withTombs },
      '确认清空全部用户删除的对话留档？所有用户的留档都会被删除，且不可恢复。' + (withTombs ? '（将同时删除墓碑）' : ''));
  });
})();

(function initStoragePanel() {
  const b = $('st-refresh');
  if (b) b.addEventListener('click', () => { b.disabled = true; Promise.resolve(loadStorage()).then(() => { b.disabled = false; }); });
  // 文件清单的翻页:数据已经在手上,只改页码重画那一段,不必重新请求接口
  document.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-st-page]');
    if (!pg) return;
    const pager = pg.closest('.st-pager');
    if (!pager) return;
    const dir = parseInt(pg.getAttribute('data-st-dir'), 10) || 0;
    pager.dataset.page = String(Math.max(1, (parseInt(pager.dataset.page, 10) || 1) + dir));
    ST_PAGES.repaint();
  });
  const box = $('st-clean');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-st-clean]');
    if (!btn) return;
    const target = btn.getAttribute('data-st-clean');
    const label = btn.closest('.st-row').querySelector('.st-row-name').textContent;
    const hint = {
      imagecache: '仅清空代理图片缓存，用户下次访问会重新抓取，不影响历史内容。',
      images: '已生成图片的本地留存会被删除，历史对话中这些图片将无法再显示。',
      backups: '历史数据快照会被删除，删除后无法回滚到这些时间点。',
      logs: '运行日志会被清空，仅影响排查记录。',
      updates: '更新下载的包与旧版本备份会被删除，不影响当前运行。',
    }[target] || '';
    const msg = hint + '清理后不可恢复，确定继续？';
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '清理' + label, message: msg, danger: true, confirmText: '清理' })
      : window.confirm('清理' + label + '？' + msg);
    if (!ok) return;
    btn.disabled = true;
    try {
      const r = await api('/api/admin/storage/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: target }) });
      const res = await readJsonSafe(r);
      if (!r.ok) throw new Error((res.error && res.error.message) || '清理失败');
      toast('已清理' + res.label + '：' + res.removed + ' 个文件，释放 ' + fmtBytesBig(res.freedBytes));
      await loadStorage();
    } catch (err) {
      btn.disabled = false;
      toast(err.message || '清理失败', true);
    }
  });
})();

async function loadStats() {
  const r = await api('/api/admin/stats');
  const data = await r.json();
  const s = data.stats || {};
  OV.stats = data;
  renderOverviewGrid();   // 概览格子:与系统看板的用户/调用数据合在一处渲染

  // 近 14 天趋势(纯 CSS 柱状)
  const trendEl = $('trend-chart');
  if (trendEl) {
    const trend = (s.trend || []).slice(-14);
    const total = trend.reduce((acc, x) => acc + (x.calls || 0), 0);
    if (!total) {
      trendEl.innerHTML = '<div class="trend-empty">近 14 天暂无调用记录</div>';
    } else {
      const max = Math.max(1, ...trend.map((x) => x.calls || 0));
      trendEl.innerHTML = trend.map((x) => {
        const n = x.calls || 0;
        const has = n > 0;
        const h = Math.max(has ? 8 : 3, Math.round((n / max) * 100));
        const today = x.day === new Date().toISOString().slice(0, 10);
        return '<div class="trend-col' + (has ? ' has' : '') + (today ? ' today' : '') + '">'
          + '<div class="trend-bar" style="height:' + h + 'px"' + (has ? ' data-n="' + n + '"' : '') + '><span class="trend-val">' + n + '</span></div>'
          + '<div class="trend-label">' + x.day.slice(5) + '</div></div>';
      }).join('');
    }
  }

  // 运行信息
  const metaEl = $('meta-row');
  if (metaEl) {
    const up = s.uptimeSec || 0;
    const days = Math.floor(up / 86400), hrs = Math.floor((up % 86400) / 3600), mins = Math.floor((up % 3600) / 60);
    metaEl.innerHTML = '<span>服务版本 <b>' + (s.version || '-') + '</b></span>'
      + '<span>运行时间 <b>' + (days ? days + '天' : '') + hrs + '小时' + mins + '分</b></span>'
      + '<span>内存 <b>' + (s.memoryMB || 0) + ' MB</b></span>'
      + '<span>用户组 <b>' + (s.groupCount ?? 0) + '</b></span>'
      + '<span>全局供应商 <b>' + (s.globalProviderCount ?? 0) + '</b>' + ((s.globalProviderDisabledCount ?? 0) > 0 ? '（停用 ' + s.globalProviderDisabledCount + '）' : '') + '</span>';
  }

  const usageEl = $('usage-ledger');
  if (usageEl) {
    const rows = s.usage || [];
    usageEl.innerHTML = rows.length
      ? rows.map((u) => {
        const models = (u.models || []).map((m) => escapeHtml(m.model) + ' ' + (m.calls || 0) + ' 次 / ' + (m.cost || 0) + ' 额度').join('，');
        return '<div class="usage-row"><span class="usage-name">' + escapeHtml(u.name || '用户') + '</span>'
          + '<span class="usage-sum">' + (u.calls || 0) + ' 次 · ' + (u.cost || 0) + ' 额度</span>'
          + '<span class="usage-models muted small">' + (models || '无模型明细') + '</span></div>';
      }).join('')
      : '<p class="muted small">近 14 天还没有扣费记录。此前的调用没有按模型记账。</p>';
  }

  const voteEl = $('model-votes');
  if (voteEl) {
    const votes = s.modelVotes || [];
    voteEl.innerHTML = votes.length
      ? votes.map((v) => '<div class="model-vote-row"><span class="mv-name">' + escapeHtml(v.model) + '</span><span class="mv-up">赞 ' + (v.up || 0) + '</span><span class="mv-down">踩 ' + (v.down || 0) + '</span></div>').join('')
      : '<p class="muted small">还没有点赞或点踩</p>';
  }

  // 额度 Top5
  const topEl = $('top-users');
  if (topEl) {
    const tops = (s.topUsers || []).slice(0, 5);
    topEl.innerHTML = tops.length
      ? tops.map((u, i) => '<div class="mini-user"><span class="mu-rank">' + (i + 1) + '</span><span class="mu-name">' + escapeHtml(u.name) + (u.admin ? ' <span class="badge global">管理员</span>' : '') + '</span><span class="mu-quota">' + u.quota + ' 次</span></div>').join('')
      : '<p class="muted small">暂无用户</p>';
  }
}


let USER_FILTER = 'all';
let USER_LIST = [];
let USER_SELECTED = new Set();
let USER_FORM_ID = null;
let USER_FORM_WAS_DEMO = false; // 编辑对象原本是否为演示管理员(决定保存时要不要提交 demoMinutes)
let DEMO_MINUTES_CFG = 10;      // 站点当前的全局演示还原窗口(/api/config),编辑表单据此回填
let ME_ID = (JSON.parse(localStorage.getItem('oc_user') || '{}').id || '');

function currentUserKw() {
  const input = $('user-search');
  return input ? input.value.trim() : '';
}

function groupLabel(groupId) {
  const g = GROUPS.find((x) => x.id === groupId);
  return g ? g.name : '';
}

function setGroupSelect(el, groupId) {
  if (!el) return;
  el.setAttribute('data-value', groupId || '');
  const label = el.querySelector('.sb-label');
  if (label) {
    const name = groupLabel(groupId);
    label.innerHTML = name ? escapeHtml(name) : '<span class="muted">未分组</span>';
  }
}

function bindGroupSelect(el) {
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', () => {
    const adminOn = !!($('uf-admin') && $('uf-admin').checked);
    const items = GROUPS
      .filter((g) => adminOn ? g.role === 'admin' : g.role !== 'admin')
      .map((g) => ({ value: g.id, label: g.name }));
    window.OC.openSelect(el, items, {
      selected: el.getAttribute('data-value') || '',
      onSelect: (val) => setGroupSelect(el, val || ''),
    });
  });
}

async function ensureGroups() {
  if (GROUPS.length) return;
  try {
    const gr = await api('/api/admin/groups');
    const gd = await readJsonSafe(gr);
    if (!gr.ok) throw new Error((gd.error && gd.error.message) || ('HTTP ' + gr.status));
    GROUPS = gd.groups || [];
  } catch (e) {
    // 下拉会退化为无分组可选,必须让管理员知道原因
    toast('用户组加载失败：' + (e.message || '网络错误'), true);
  }
}

// ============ 后台:用户第三方绑定管理 ============
// 管理员可查看/解除某用户的第三方绑定,也可复制"绑定链接"让用户自己完成授权
async function loadUserOauth(userId) {
  const wrap = $('uf-oauth-wrap');
  const box = $('uf-oauth-list');
  if (!wrap || !box) return;
  if (!userId) { wrap.hidden = true; box.innerHTML = ''; return; }
  wrap.hidden = false;
  box.innerHTML = '<p class="muted small" style="margin:0">加载中…</p>';
  try {
    const r = await api('/api/admin/users/oauth?userId=' + encodeURIComponent(userId));
    const d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
    const list = Array.isArray(d.providers) ? d.providers : [];
    const userInfo = d.user || {};
    if (!list.some((p) => p.enabled || p.bound)) {
      box.innerHTML = '<p class="muted small" style="margin:0">后台尚未开启任何第三方登录方式。</p>';
      return;
    }
    box.innerHTML = list.map((p) => {
      let label, act = '';
      if (p.bound) {
        label = '已绑定' + (p.boundName ? '（' + escapeHtml(p.boundName) + '）' : '');
        act = '<button class="btn small" type="button" data-ao-unbind="' + escapeHtml(p.id) + '">解除</button>';
      } else if (p.enabled) {
        label = '未绑定';
        act = '<button class="btn small" type="button" data-ao-copy="' + escapeHtml(p.bindUrl || '') + '">复制绑定链接</button>';
      } else {
        label = '未启用';
      }
      return '<div class="row-between" style="padding:8px 0;border-bottom:1px solid var(--line,#eee);gap:8px">'
        + '<div style="display:flex;align-items:center;gap:8px;min-width:0">'
        + '<img src="' + escapeHtml(p.logo) + '" alt="" style="width:16px;height:16px;border-radius:4px;object-fit:contain">'
        + '<div><div>' + escapeHtml(p.name) + '</div><div class="muted small">' + label + '</div></div></div>'
        + '<div>' + act + '</div></div>';
    }).join('');
    if (!userInfo.hasPassword && list.filter((p) => p.bound).length === 1) {
      box.innerHTML += '<p class="muted small" style="margin:8px 0 0">该用户还没有设置密码，解除唯一绑定后将无法登录，建议先让其在「设置 → 账户」设置密码。</p>';
    }
    box.dataset.userId = userId;
  } catch (e) {
    box.innerHTML = '<p class="muted small" style="margin:0">加载失败：' + escapeHtml(e.message || '') + '</p>';
  }
}
(function initUserOauthPanel() {
  const box = $('uf-oauth-list');
  if (!box) return;
  box.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-ao-copy]');
    if (copyBtn) {
      const val = copyBtn.getAttribute('data-ao-copy') || '';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(val);
        else {
          const ta = document.createElement('textarea');
          ta.value = val; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
        const old = copyBtn.textContent;
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = old; }, 1200);
      } catch (err) { toast('复制失败，请手动选择复制', true); }
      return;
    }
    const unbindBtn = e.target.closest('[data-ao-unbind]');
    if (!unbindBtn) return;
    const pid = unbindBtn.getAttribute('data-ao-unbind');
    const userId = box.dataset.userId || '';
    unbindBtn.disabled = true;
    try {
      const r = await api('/api/admin/users/' + encodeURIComponent(userId) + '/oauth/' + encodeURIComponent(pid), { method: 'DELETE' });
      const d = await readJsonSafe(r);
      if (!r.ok) throw new Error((d.error && d.error.message) || '解除失败');
      toast('已解除绑定');
      loadUserOauth(userId);
    } catch (err) {
      unbindBtn.disabled = false;
      toast(err.message || '解除失败', true);
    }
  });
})();

async function openUserForm(user) {
  const modal = $('user-form-modal');
  if (!modal) return;
  await ensureGroups();
  USER_FORM_ID = user ? user.id : null;
  USER_FORM_WAS_DEMO = !!(user && user.demo);
  $('user-form-title').textContent = user ? '编辑用户' : '创建用户';
  $('user-form-save').textContent = user ? '保存' : '创建';
  $('uf-name').value = user ? user.name : '';
  $('uf-pass').value = '';
  $('uf-pass-label').textContent = user ? '新密码（留空不改）' : '密码';
  $('uf-quota').value = user ? user.quota : 100;
  $('uf-admin').checked = !!(user && user.admin);
  if ($('uf-demo')) $('uf-demo').checked = !!(user && user.demo);
  // 演示身份不限于创建时:编辑已有用户也能设置/取消
  if ($('uf-demo-row')) $('uf-demo-row').style.display = '';
  if ($('uf-demo-options')) $('uf-demo-options').hidden = !($('uf-demo') && $('uf-demo').checked);
  // 回填站点当前的全局演示窗口,而不是写死 10:否则编辑保存会把全局窗口悄悄改回 10
  if ($('uf-demo-minutes')) $('uf-demo-minutes').value = DEMO_MINUTES_CFG;
  const adminGroup = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
  const preferred = $('uf-admin').checked
    ? adminGroup
    : (user && user.groupId && user.groupId !== adminGroup ? user.groupId : (DEFAULT_GROUP_ID || ''));
  setGroupSelect($('uf-group'), preferred);
  bindGroupSelect($('uf-group'));
  // 第三方绑定管理(仅编辑已有用户时可用)
  loadUserOauth(user ? user.id : null);
  if (!$('uf-admin').dataset.boundGroup) {
    $('uf-admin').dataset.boundGroup = '1';
    $('uf-admin').addEventListener('change', () => {
      // 演示管理员必然也是管理员:不允许单独取消「设为管理员」
      if ($('uf-demo') && $('uf-demo').checked && !$('uf-admin').checked) {
        $('uf-admin').checked = true;
        toast('演示管理员默认也是管理员，请先取消「演示管理员」', true);
        return;
      }
      const nextAdmin = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
      const current = $('uf-group').getAttribute('data-value') || '';
      if ($('uf-admin').checked) setGroupSelect($('uf-group'), nextAdmin);
      else if (!current || current === nextAdmin) setGroupSelect($('uf-group'), DEFAULT_GROUP_ID || '');
    });
  }
  // 演示管理员 = 管理员:勾选「演示管理员」会自动勾选并锁定「设为管理员」,并把用户组切到管理员组。
  const syncDemoPair = () => {
    const demoOn = !!($('uf-demo') && $('uf-demo').checked);
    const adminEl = $('uf-admin');
    const groupEl = $('uf-group');
    const adminGroup = (GROUPS.find((g) => g.role === 'admin') || {}).id || '';
    if (demoOn) {
      // 记下切换前的用户组,取消演示时原样还原
      if (groupEl && groupEl.dataset.preDemoGroup === undefined) {
        groupEl.dataset.preDemoGroup = groupEl.getAttribute('data-value') || '';
      }
      if (adminEl && !adminEl.checked) { adminEl.dataset.forcedByDemo = '1'; adminEl.checked = true; }
      if (adminEl) adminEl.disabled = true;
      setGroupSelect(groupEl, adminGroup);
    } else if (adminEl) {
      adminEl.disabled = false;
      // 若「管理员」是随演示自动带上的,取消演示时一并取消,避免残留为正式管理员
      if (adminEl.dataset.forcedByDemo === '1') {
        adminEl.checked = false;
        adminEl.dataset.forcedByDemo = '';
        const prev = groupEl && groupEl.dataset.preDemoGroup !== undefined ? groupEl.dataset.preDemoGroup : '';
        setGroupSelect(groupEl, prev && prev !== adminGroup ? prev : (DEFAULT_GROUP_ID || ''));
      }
      if (groupEl) delete groupEl.dataset.preDemoGroup;
    }
    if ($('uf-demo-options')) $('uf-demo-options').hidden = !demoOn;
  };
  if ($('uf-demo') && !$('uf-demo').dataset.boundDemo) {
    $('uf-demo').dataset.boundDemo = '1';
    $('uf-demo').addEventListener('change', syncDemoPair);
  }
  // 打开表单时按现有状态同步一次(编辑已有演示管理员时应已锁定「设为管理员」)
  syncDemoPair();
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
  setTimeout(() => $('uf-name').focus(), 30);
}

function closeUserForm() {
  const modal = $('user-form-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.closeModal(modal);
  else modal.classList.add('hidden');
  USER_FORM_ID = null;
}

async function saveUserForm() {
  const name = $('uf-name').value.trim();
  const password = $('uf-pass').value;
  const quota = Number($('uf-quota').value);
  const demo = !!($('uf-demo') && $('uf-demo').checked);
  const demoMinutes = Math.min(1440, Math.max(1, parseInt($('uf-demo-minutes') && $('uf-demo-minutes').value, 10) || 10));
  const admin = $('uf-admin').checked || demo;
  const groupId = $('uf-group').getAttribute('data-value') || '';
  if (!name) return toast('请填写用户名', true);
  if (!USER_FORM_ID && !password) return toast('请填写密码', true);
  if (password && password.length < 4) return toast('密码至少 4 个字符', true);
  if (!Number.isFinite(quota) || quota < 0) return toast('额度无效', true);

  const btn = $('user-form-save');
  btn.disabled = true;
  try {
    if (!USER_FORM_ID) {
      const r = await api('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password, quota, admin, demo, demoMinutes }),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '创建失败', true);
      const created = data.user;
      const createdGroup = created && created.groupId ? created.groupId : '';
      // 后端在创建管理员/演示账号时已自动归入管理员组;仅当用户特意选了别的组时才再调组接口
      if (created && groupId && groupId !== createdGroup) {
        const gr = await api('/api/admin/users/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: created.id, groupId: groupId || null }),
        });
        if (!gr.ok) {
          const dd = await gr.json().catch(() => ({}));
          toast((dd.error && dd.error.message) || '用户组更新失败', true);
        }
      }
      toast('用户已创建');
    } else {
      const body = { userId: USER_FORM_ID, name, admin, demo };
      if (password) body.password = password;
      // demoMinutes 是全局「演示还原窗口」:仅在新建演示身份或明确改动窗口值时提交,
      // 避免每次编辑演示用户都把全局窗口静默重置
      if (demo && (!USER_FORM_WAS_DEMO || demoMinutes !== DEMO_MINUTES_CFG)) body.demoMinutes = demoMinutes;
      const r = await api('/api/admin/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      const qr = await api('/api/admin/users/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_FORM_ID, quota }),
      });
      if (!qr.ok) {
        const qd = await qr.json().catch(() => ({}));
        toast((qd.error && qd.error.message) || '额度更新失败', true);
      }
      // 后端在设为管理员/演示时已自动归入管理员组;仅当目标组与后端结果不一致时才再调组接口,
      // 避免「演示管理员」这类场景下多调一次反而报「用户组更新失败」。
      const newGroup = data.user && data.user.groupId ? data.user.groupId : '';
      if (groupId && groupId !== newGroup) {
        const gr = await api('/api/admin/users/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: USER_FORM_ID, groupId: groupId || null }),
        });
        if (!gr.ok) {
          const gd = await gr.json().catch(() => ({}));
          toast((gd.error && gd.error.message) || '用户组更新失败', true);
        }
      }
      toast('已保存');
    }
    closeUserForm();
    loadUsers(currentUserKw());
    loadStats();
  } finally {
    btn.disabled = false;
  }
}

// ============ 用户组管理 ============
let GROUPS = [];
let ACCESS = [];
let PROVIDERS = [];

let DEFAULT_GROUP_ID = '';

function setDefaultGroupSelect(groupId) {
  const el = $('g-default');
  if (!el) return;
  const id = groupId || '';
  el.setAttribute('data-value', id);
  const label = el.querySelector('.sb-label');
  if (label) label.textContent = groupLabel(id) || '默认用户组';
}

function bindDefaultGroupSelect() {
  const el = $('g-default');
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', () => {
    const items = GROUPS.filter((g) => g.role !== 'admin').map((g) => ({ value: g.id, label: g.name }));
    window.OC.openSelect(el, items, {
      selected: el.getAttribute('data-value') || DEFAULT_GROUP_ID,
      onSelect: (val) => setDefaultGroupSelect(val),
    });
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
}

async function openGroupRename(g) {
  if (g.builtin) {
    toast('系统用户组名称固定（按角色识别），可直接在「模型授权」中调整其可用模型', true);
    return;
  }
  const next = (window.OCUI && OCUI.prompt)
    ? await OCUI.prompt({ title: '修改用户组名称', value: g.name, confirmText: '保存' })
    : window.prompt('修改用户组名称', g.name);
  if (next == null) return;
  const name = String(next).trim();
  if (!name) return toast('组名不能为空', true);
  if (name === g.name) return;
  const r = await api('/api/admin/groups/' + encodeURIComponent(g.id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return toast((d.error && d.error.message) || '修改失败', true);
  toast('用户组已更新');
  loadGroups();
  loadUsers(currentUserKw());
}

async function loadGroups() {
  const r = await api('/api/admin/groups');
  const data = await r.json();
  GROUPS = data.groups || [];
  DEFAULT_GROUP_ID = data.defaultGroupId || '';
  bindDefaultGroupSelect();
  setDefaultGroupSelect(DEFAULT_GROUP_ID);
  const box = $('groups-list');
  box.innerHTML = '';
  if (!GROUPS.length) { box.innerHTML = '<p class="muted small">暂无用户组</p>'; return; }
  GROUPS.forEach((g) => {
    const card = document.createElement('div');
    card.className = 'group-card';
    const badges = (g.role === 'admin' ? '<span class="badge global">全部模型</span>' : '')
      + (g.builtin ? '<span class="badge default">系统</span>' : '')
      + (g.id === DEFAULT_GROUP_ID ? '<span class="badge global">注册默认</span>' : '');
    card.innerHTML = `
      <div class="pc-info">
        <div class="pc-name">${escapeHtml(g.name)} ${badges}</div>
        <div class="pc-url">${g.memberCount} 名成员</div>
      </div>
      <div class="provider-card-actions" style="display:flex;gap:6px;flex-shrink:0">
        ${g.builtin
          ? '<button class="btn small" data-editgroup="' + escapeHtml(g.id) + '">重命名</button>'
          : '<button class="btn small" data-editgroup="' + escapeHtml(g.id) + '">重命名</button><button class="btn small danger" data-delgroup="' + escapeHtml(g.id) + '">删除</button>'}
      </div>`;
    card.querySelector('[data-editgroup]')?.addEventListener('click', () => openGroupRename(g));
    card.querySelector('[data-delgroup]')?.addEventListener('click', async () => {
      const extra = g.id === DEFAULT_GROUP_ID ? '该组当前是注册默认组，删除后会改回系统默认用户组。' : '';
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除用户组', message: '确认删除用户组「' + g.name + '」？该组成员将变为未分组，相关授权一并清除。' + extra, danger: true, confirmText: '删除' })
        : confirm('确认删除用户组 ' + g.name + '？\n该组成员将变为未分组，相关授权一并清除。');
      if (!ok) return;
      const rr = await api('/api/admin/groups/' + g.id, { method: 'DELETE' });
      const body = await rr.json().catch(() => ({}));
      if (rr.ok) { toast('已删除'); loadGroups(); loadUsers(); loadAccess(); }
      else toast((body.error && body.error.message) || '删除失败', true);
    });
    box.appendChild(card);
  });
}

const gDefaultSave = $('g-default-save');
if (gDefaultSave) gDefaultSave.addEventListener('click', async () => {
  const groupId = ($('g-default') && $('g-default').getAttribute('data-value')) || '';
  if (!groupId) return toast('请选择一个用户组', true);
  gDefaultSave.disabled = true;
  try {
    const r = await api('/api/admin/groups/default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    const data = await r.json();
    if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
    toast('注册默认组已保存');
    loadGroups();
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  } finally {
    gDefaultSave.disabled = false;
  }
});

$('g-add').addEventListener('click', async () => {
  const name = $('g-name').value.trim();
  if (!name) return toast('请填写组名', true);
  const r = await api('/api/admin/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await r.json();
  if (!r.ok) return toast((data.error && data.error.message) || '创建失败', true);
  toast('用户组已创建');
  $('g-name').value = '';
  loadGroups(); loadAccess();
});

function visibleUsers() {
  if (USER_FILTER === 'admin') return USER_LIST.filter((u) => u.admin);
  if (USER_FILTER === 'guest') return USER_LIST.filter((u) => u.guest);
  if (USER_FILTER === 'member') return USER_LIST.filter((u) => !u.admin && !u.guest);
  return USER_LIST.slice();
}

// ============ 用户表分页(客户端) ============
let USER_PAGE = 1;
const USER_PAGE_SIZE = 50;
function usersPageOf(list) {
  const pages = Math.max(1, Math.ceil(list.length / USER_PAGE_SIZE));
  if (USER_PAGE > pages) USER_PAGE = pages;
  if (USER_PAGE < 1) USER_PAGE = 1;
  return { slice: list.slice((USER_PAGE - 1) * USER_PAGE_SIZE, USER_PAGE * USER_PAGE_SIZE), pages };
}
function renderUsersPager(pages, total) {
  const box = $('users-pager');
  if (!box) return;
  const multi = pages > 1;
  box.hidden = !multi;
  if (!multi) return;
  const info = $('users-page-info');
  if (info) info.textContent = '第 ' + USER_PAGE + ' / ' + pages + ' 页 · 共 ' + total + ' 人';
  const prev = $('users-page-prev');
  const next = $('users-page-next');
  if (prev) prev.disabled = USER_PAGE <= 1;
  if (next) next.disabled = USER_PAGE >= pages;
}

function renderUsers() {
  const tbody = $('users-tbody');
  if (!tbody) return;
  const list = visibleUsers();
  const countEl = $('users-count');
  if (countEl) {
    countEl.textContent = USER_LIST.length
      ? (list.length === USER_LIST.length ? USER_LIST.length + ' 人' : '显示 ' + list.length + ' / ' + USER_LIST.length + ' 人')
      : '暂无用户';
  }
  tbody.innerHTML = '';
  // 清理已不存在的选中项(切换筛选/删除后)
  const aliveIds = new Set(USER_LIST.map((u) => u.id));
  Array.from(USER_SELECTED).forEach((id) => { if (!aliveIds.has(id)) USER_SELECTED.delete(id); });
  if (!list.length) {
    tbody.innerHTML = '<tr class="users-empty-row"><td colspan="9">' + (USER_LIST.length ? '没有匹配的用户' : '还没有用户，点右上角创建') + '</td></tr>';
    renderUsersPager(1, 0);
    return;
  }
  const { slice, pages } = usersPageOf(list);
  renderUsersPager(pages, list.length);
  slice.forEach((u) => {
    const tr = document.createElement('tr');
    const initial = String(u.name || '?').trim().charAt(0).toUpperCase();
    const gName = groupLabel(u.groupId);
    const me = u.id === ME_ID;
    tr.innerHTML =
      '<td class="col-check">' + (me ? '' : '<input type="checkbox" class="user-pick" data-id="' + escapeHtml(u.id) + '"' + (USER_SELECTED.has(u.id) ? ' checked' : '') + ' aria-label="选择">') + '</td>'
      + '<td class="col-user">'
      + '<div class="user-cell">'
      + '<span class="user-avatar' + (u.admin ? ' is-admin' : '') + '">' + escapeHtml(initial) + '</span>'
      + '<div class="user-meta">'
      + '<div class="user-name">' + escapeHtml(u.name)
      + (u.admin ? ' <span class="badge global">管理员</span>' : '')
      + (u.demo ? ' <span class="badge">演示</span>' : '')
      + (u.guest ? ' <span class="badge">游客</span>' : '')
      + (u.id === ME_ID ? ' <span class="badge default">我</span>' : '')
      + '</div></div></div></td>'
      + '<td class="col-quota">' + (u.quota ?? 0) + '</td>'
      + '<td class="col-group">' + (gName ? escapeHtml(gName) : '<span class="muted">未分组</span>') + '</td>'
      + '<td class="col-chats">' + (u.chatCount || 0) + '</td>'
      + '<td class="col-time muted">' + fmtTime(u.createdAt) + '</td>'
      + '<td class="col-seen muted">' + (u.lastSeen ? fmtTime(u.lastSeen) : '—') + '</td>'
      + '<td class="col-ip muted">' + (u.lastIp ? escapeHtml(u.lastIp) : '—') + '</td>'
      + '<td class="col-actions"><div class="admin-row-actions">'
      + '<button class="btn small" type="button" data-edit="' + escapeHtml(u.id) + '">编辑</button>'
      + '<button class="btn small" type="button" data-chats="' + escapeHtml(u.id) + '">对话</button>'
      + (u.id === ME_ID ? '' : '<button class="btn small danger" type="button" data-deluser="' + escapeHtml(u.id) + '">删除</button>')
      + '</div></td>';
    const pick = tr.querySelector('.user-pick');
    if (pick) pick.addEventListener('change', () => {
      if (pick.checked) USER_SELECTED.add(u.id); else USER_SELECTED.delete(u.id);
      syncUserSelection();
    });
    tr.querySelector('[data-edit]')?.addEventListener('click', () => openUserForm(u));
    tr.querySelector('[data-chats]')?.addEventListener('click', () => openUserChats(u));
    tr.querySelector('[data-deluser]')?.addEventListener('click', async () => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除用户', message: '确认删除用户「' + u.name + '」？其对话和自建供应商会一并清除。', danger: true, confirmText: '删除' })
        : confirm('确认删除用户 ' + u.name + '?');
      if (!ok) return;
      const rr = await api('/api/admin/users/' + u.id, { method: 'DELETE' });
      if (rr.ok) { toast('已删除'); loadUsers(currentUserKw()); loadStats(); }
      else {
        const d = await rr.json().catch(() => ({}));
        toast('删除失败' + (d.error && d.error.message ? '：' + d.error.message : ''), true);
      }
    });
    tbody.appendChild(tr);
  });
  syncUserSelection();
}
// 同步「删除所选」按钮与全选框状态(全选只覆盖当前页,避免跨页误删看不见的用户)
function usersCurrentPageList() {
  const list = visibleUsers();
  return list.slice((USER_PAGE - 1) * USER_PAGE_SIZE, USER_PAGE * USER_PAGE_SIZE);
}
function syncUserSelection() {
  const btn = $('users-bulk-delete');
  if (btn) {
    btn.hidden = USER_SELECTED.size === 0;
    btn.textContent = USER_SELECTED.size ? ('删除所选 (' + USER_SELECTED.size + ')') : '删除所选';
  }
  const all = $('users-check-all');
  if (all) {
    const pickable = usersCurrentPageList().filter((u) => u.id !== ME_ID);
    const picked = pickable.filter((u) => USER_SELECTED.has(u.id)).length;
    all.checked = pickable.length > 0 && picked === pickable.length;
    all.indeterminate = picked > 0 && picked < pickable.length;
  }
}

// 用户批量操作:全选、删除所选、一键清除游客
(function initUserBulk() {
  const all = $('users-check-all');
  if (all) all.addEventListener('change', () => {
    const pickable = usersCurrentPageList().filter((u) => u.id !== ME_ID);
    if (all.checked) pickable.forEach((u) => USER_SELECTED.add(u.id));
    else pickable.forEach((u) => USER_SELECTED.delete(u.id));
    renderUsers();
  });
  const bulk = $('users-bulk-delete');
  if (bulk) bulk.addEventListener('click', async () => {
    const ids = Array.from(USER_SELECTED);
    if (!ids.length) return;
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '批量删除用户', message: '确认删除选中的 ' + ids.length + ' 个用户？其对话与自建供应商会一并清除。', danger: true, confirmText: '删除' })
      : confirm('确认删除选中的 ' + ids.length + ' 个用户?');
    if (!ok) return;
    bulk.disabled = true;
    try {
      const r = await api('/api/admin/users/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '删除失败', true);
      USER_SELECTED.clear();
      toast('已删除 ' + d.deleted + ' 个用户' + (d.skipped ? '，跳过 ' + d.skipped + ' 个' : ''));
      loadUsers(currentUserKw()); loadStats();
    } catch (e) {
      toast('删除失败: ' + e.message, true);
    } finally { bulk.disabled = false; }
  });
  const purge = $('users-purge-guests');
  if (purge) purge.addEventListener('click', async () => {
    const guests = USER_LIST.filter((u) => u.guest);
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '清除全部游客', message: '将删除全部 ' + guests.length + ' 个游客账号及其对话与自建供应商。管理员与普通成员不受影响。', danger: true, confirmText: '全部清除' })
      : confirm('将删除全部 ' + guests.length + ' 个游客账号,确认?');
    if (!ok) return;
    purge.disabled = true;
    try {
      const r = await api('/api/admin/users/purge-guests', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '清除失败', true);
      USER_SELECTED.clear();
      toast(d.removed ? ('已清除 ' + d.removed + ' 个游客账号') : '当前没有游客账号');
      loadUsers(currentUserKw()); loadStats();
    } catch (e) {
      toast('清除失败: ' + e.message, true);
    } finally { purge.disabled = false; }
  });
})();

async function loadUsers(searchKw) {
  try {
    const r = await api('/api/admin/users' + (searchKw ? '?q=' + encodeURIComponent(searchKw) : ''));
    const data = await readJsonSafe(r);
    if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
    if (!GROUPS.length) {
      const gr = await api('/api/admin/groups');
      const gd = await readJsonSafe(gr);
      if (!gr.ok) throw new Error((gd.error && gd.error.message) || '用户组加载失败');
      GROUPS = gd.groups || [];
    }
    USER_LIST = data.users || [];
    USER_PAGE = 1;
    renderUsers();
  } catch (e) {
    toast('用户列表加载失败：' + (e.message || '网络错误'), true);
  }
}

// ============ 模型授权 ============
async function loadAccess() {
  const [r1, r2] = await Promise.all([
    api('/api/admin/access'),
    api('/api/providers'),
  ]);
  const ad = await r1.json();
  const pd = await r2.json();
  ACCESS = ad.rules || [];
  PROVIDERS = (pd.providers || []).filter((p) => p.scope === 'global' && p.enabled !== false);
  const box = $('access-box');
  box.innerHTML = '';
  if (!GROUPS.length) { box.innerHTML = '<p class="muted small">请先创建用户组</p>'; return; }
  if (!PROVIDERS.length) {
    const anyGlobal = (pd.providers || []).some((p) => p.scope === 'global');
    box.innerHTML = '<p class="muted small">' + (anyGlobal ? '全局供应商均已停用，请先在「供应商配置」中启用。' : '暂无可授权的全局供应商，请先在下方添加。') + '</p>';
    return;
  }

  GROUPS.forEach((g) => {
    const section = document.createElement('div');
    section.className = 'access-section';
    const locked = g.role === 'admin';
    section.innerHTML = `<div class="access-title">${escapeHtml(g.name)}${locked ? ' <span class="badge global">始终全部模型</span>' : ''}</div>`;
    PROVIDERS.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'access-row';
      row.dataset.group = g.id;
      row.dataset.provider = p.id;
      row.dataset.locked = locked ? '1' : '';
      row.innerHTML = `
        <div class="access-prov">${escapeHtml(p.name)}
          <label class="access-all" style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;font-weight:normal">
            <input type="checkbox" data-prov="${p.id}" ${locked ? 'disabled' : ''}> 全部
          </label>
        </div>
        <div class="access-models">
          ${p.models.map((m) => `
            <label class="access-model">
              <input type="checkbox" data-model="${p.id}|${m.id}" ${locked ? 'disabled' : ''}>
              ${escapeHtml(m.id)}
            </label>`).join('')}
        </div>`;
      syncAccessRow(row);
      const allChk = row.querySelector('[data-prov]');
      if (locked) { section.appendChild(row); return; }
      // 「全部」= 全选/全不选快捷键:勾上写通配 ['*'],取消则清空(之后可逐个勾选)
      allChk.addEventListener('change', async () => {
        await saveAccessRule(g.id, p.id, allChk.checked ? ['*'] : [], row);
      });
      // 单个模型:直接勾选即可只授权部分模型。全选时写回通配,便于新模型自动纳入。
      row.querySelectorAll('[data-model]').forEach((chk) => {
        chk.addEventListener('change', async () => {
          const boxes = Array.from(row.querySelectorAll('[data-model]'));
          const sel = boxes.filter((c) => c.checked).map((c) => c.dataset.model.split('|')[1]);
          const allSelected = boxes.length > 0 && sel.length === boxes.length;
          await saveAccessRule(g.id, p.id, allSelected ? ['*'] : sel, row);
        });
      });
      section.appendChild(row);
    });
    box.appendChild(section);
  });
}

// 依据当前 ACCESS 同步某一行复选框:通配时全部勾上并显示「全部」;
// 部分授权时「全部」呈半选(不确定)态。
function syncAccessRow(row) {
  if (!row) return;
  const gid = row.dataset.group;
  const pid = row.dataset.provider;
  const locked = row.dataset.locked === '1';
  const rule = ACCESS.find((a) => a.groupId === gid && a.providerId === pid);
  const ids = rule && Array.isArray(rule.modelIds) ? rule.modelIds : [];
  const allOpen = locked || ids.indexOf('*') >= 0;
  const boxFor = (mid) => allOpen || ids.indexOf(mid) >= 0;
  row.querySelectorAll('[data-model]').forEach((chk) => {
    const mid = chk.dataset.model.split('|')[1];
    chk.checked = boxFor(mid);
    chk.disabled = locked;
    const label = chk.closest('.access-model');
    if (label) label.classList.toggle('disabled', false);
  });
  const allChk = row.querySelector('[data-prov]');
  if (allChk) {
    const boxes = row.querySelectorAll('[data-model]');
    const n = Array.from(boxes).filter((c) => c.checked).length;
    allChk.checked = allOpen || (boxes.length > 0 && n === boxes.length);
    allChk.indeterminate = !allOpen && n > 0 && n < boxes.length;
  }
}

async function saveAccessRule(groupId, providerId, modelIds, row) {
  const r = await api('/api/admin/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, providerId, modelIds }),
  });
  const data = await readJsonSafe(r);
  if (!r.ok) {
    toast((data.error && data.error.message) || '保存授权失败', true);
    // 失败时回滚复选框到服务端真实状态
    syncAccessRow(row);
    return;
  }
  ACCESS = data.rules || [];
  const count = modelIds.length === 1 && modelIds[0] === '*' ? '全部模型' : (modelIds.length + ' 个模型');
  toast('授权已更新：' + count);
  // 局部同步复选框状态,避免整块重绘导致闪烁
  if (row) syncAccessRow(row);
  else loadAccess();
}

// ============ 供应商管理 ============
// ---- 多密钥编辑器:每行 = 名称 + Key(掩码/明文) + 显示/删除 ----
function setKeyVisibility(input, button, visible) {
  if (!input || !button) return;
  input.type = visible ? 'text' : 'password';
  button.innerHTML = window.OC.icon(visible ? 'eyeOff' : 'eye', 14);
  button.title = visible ? '隐藏 Key' : '显示 Key';
  button.setAttribute('aria-label', button.title);
}
// 当前编辑中的密钥列表:[{id,name,apiKey,revealable}]
let AP_KEYS = [];
let AP_KEYS_EDIT_ID = null;    // 编辑模式下的供应商 id(用于小眼睛回显)
let AP_KEYS_REVEALABLE = false;
function apKeysBox() { return $('ap-keys'); }
function renderApKeys() {
  const box = apKeysBox();
  if (!box) return;
  // 每把 Key 需要有稳定 id 供模型绑定引用(新加的行为空 id)
  AP_KEYS.forEach((k) => { if (!k.id) k.id = 'k' + Math.random().toString(36).slice(2, 9); });
  box.innerHTML = AP_KEYS.map((k, i) => {
    // 已保存的 Key 不回填掩码到输入框(留空 = 保持不变);掩码只放在 placeholder 里提示
    const val = String(k.apiKey || '');
    const ph = (val === '' && k.hasKey)
      ? ('已保存 ' + String(k.masked || '••••••') + '，留空保持不变')
      : 'sk-...';
    return '<div class="ap-key-row" data-idx="' + i + '">'
      + '<input class="ap-key-name" type="text" data-idx="' + i + '" value="' + escapeHtml(k.name || '') + '" placeholder="Key 名称（多个时必填）" maxlength="40" autocomplete="off">'
      + '<div class="pw-wrap ap-key-pw">'
      + '<input class="ap-key-val" type="password" data-idx="' + i + '" value="' + escapeHtml(val) + '" placeholder="' + escapeHtml(ph) + '" autocomplete="off">'
      + '<button class="pw-toggle ap-key-eye" type="button" data-idx="' + i + '" title="显示 Key" aria-label="显示 Key">' + window.OC.icon('eye', 14) + '</button>'
      + '</div>'
      + '<button class="icon-btn ap-key-del" type="button" data-del="' + i + '" title="移除该 Key" aria-label="移除该 Key">' + window.OC.icon('close', 14) + '</button>'
      + '</div>';
  }).join('');
  const addBtn = $('ap-key-add');
  if (addBtn) addBtn.disabled = AP_KEYS.length >= 20;
  // 密钥列表变化时同步给模型清单(用于密钥列下拉);未命名的暂用「未命名 N」
  if (apModelList && apModelList.setKeys) {
    apModelList.setKeys(AP_KEYS.map((k, i) => ({ id: k.id, name: (k.name || '').trim() || ('未命名 ' + (i + 1)) })));
  }
  syncFetchKeyBox();
}
// 「获取列表」用哪把 Key:多把密钥时显示选择器(默认第一把已填/已保存的)
function syncFetchKeyBox() {
  const box = $('ap-fetch-key');
  if (!box) return;
  const usable = AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
  if (usable.length < 2) { box.classList.add('hidden'); box.setAttribute('data-value', usable[0] ? usefulId(usable[0]) : ''); return; }
  box.classList.remove('hidden');
  let cur = box.getAttribute('data-value') || '';
  const ids = usable.map((k) => usefulId(k));
  if (ids.indexOf(cur) < 0) cur = ids[0];
  box.setAttribute('data-value', cur);
  const hit = usable.find((k) => usefulId(k) === cur);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = (hit && (hit.name || '').trim()) || '获取用 Key';
}
function usefulId(k) { return String((k && k.id) || ''); }
function bindFetchKeyBox() {
  const box = $('ap-fetch-key');
  if (!box || !window.OC || !OC.openSelect) return;
  box.addEventListener('click', () => {
    const usable = AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
    if (usable.length < 2) return;
    OC.openSelect(box, usable.map((k) => ({ value: usefulId(k), label: (k.name || '').trim() || '未命名' })), {
      selected: box.getAttribute('data-value') || '',
      fitWidth: true,
      onSelect: (val, item) => {
        box.setAttribute('data-value', val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || val;
      },
    });
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); } });
}
function apKeysFromProvider(p) {
  AP_KEYS = [];
  AP_KEYS_EDIT_ID = p && p.id ? p.id : null;
  AP_KEYS_REVEALABLE = !!(p && p.keyRevealable);
  const list = (p && Array.isArray(p.keys)) ? p.keys : [];
  if (list.length) {
    // 接口只回掩码:输入框留空表示「保持原 Key」,掩码存起来供 placeholder 展示
    AP_KEYS = list.map((k) => ({ id: String(k.id || ''), name: String(k.name || ''), apiKey: '', masked: String(k.apiKey || ''), hasKey: !!k.hasKey }));
  } else if (p && p.hasKey) {
    // 旧数据:单 Key
    AP_KEYS = [{ id: 'k0', name: '', apiKey: '', masked: String(p.apiKey || '••••••'), hasKey: true }];
  }
  if (!AP_KEYS.length) AP_KEYS = [{ id: '', name: '', apiKey: '' }];
  renderApKeys();
}
function apKeysPayload() {
  // 带回全部行(含未改动、apiKey 为空的):服务端按 id 复用原密文,
  // 否则未改动的密钥会在保存时被丢弃。
  return AP_KEYS.map((k) => ({ id: k.id || '', name: String(k.name || '').trim(), apiKey: String(k.apiKey || '') }));
}
// 有效行:已保存过的(hasKey) 或 刚填了明文
function apKeysEffective() {
  return AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
}
// 只更新模型表密钥下拉的选项文字(不重渲染,避免输入时丢焦点)
function syncKeySelectLabels() {
  const opts = AP_KEYS.map((k, i) => ({ id: k.id, name: (k.name || '').trim() || ('未命名 ' + (i + 1)) }));
  document.querySelectorAll('#ap-models-list select.mkey').forEach((sel) => {
    Array.from(sel.options).forEach((o) => {
      if (!o.value) return;
      const hit = opts.find((x) => String(x.id) === o.value);
      if (hit) o.textContent = hit.name || hit.id;
    });
  });
}
// 校验:多 Key 时名称必填且不可重复;返回错误信息或 ''
function apKeysValidate() {
  const named = apKeysEffective();
  if (named.length < 2) return '';
  const seen = {};
  for (const k of named) {
    const nm = String(k.name || '').trim();
    if (!nm) return '配置了多个 Key 时，每个 Key 都需要填写名称';
    const low = nm.toLowerCase();
    if (seen[low]) return 'Key 名称不能重复：' + nm;
    seen[low] = true;
  }
  return '';
}
(function initApKeys() {
  const box = apKeysBox();
  if (!box) return;
  const addBtn = $('ap-key-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    if (AP_KEYS.length >= 20) return;
    AP_KEYS.push({ id: '', name: '', apiKey: '' });
    renderApKeys();
  });
  box.addEventListener('input', (e) => {
    const nameInp = e.target.closest ? e.target.closest('input.ap-key-name') : null;
    if (nameInp) {
      const k = AP_KEYS[Number(nameInp.dataset.idx)];
      if (k) k.name = nameInp.value;
      // 同步模型表:密钥链芯片与下拉标签都按新名字显示
      // (焦点在密钥名称输入框,不在模型表内,重渲染不会丢焦点)
      syncKeySelectLabels();
      if (apModelList && apModelList.setKeys) {
        apModelList.setKeys(AP_KEYS.map((x, i) => ({ id: x.id, name: (x.name || '').trim() || ('未命名 ' + (i + 1)) })));
      }
      syncFetchKeyBox();
      return;
    }
    const valInp = e.target.closest ? e.target.closest('input.ap-key-val') : null;
    if (valInp) { const k = AP_KEYS[Number(valInp.dataset.idx)]; if (k) { k.apiKey = valInp.value; k.hasKey = true; } syncFetchKeyBox(); return; }
  });
  box.addEventListener('click', async (e) => {
    const del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (del) {
      const i = Number(del.dataset.del);
      const victim = AP_KEYS[i];
      // 该密钥正被模型绑定时先提示:移除后这些模型会回退到默认密钥
      const bound = victim && victim.id && apModelList
        ? (apModelList.getCatalog() || []).filter((m) => String(m.keyId || '') === String(victim.id))
        : [];
      if (bound.length) {
        const names = bound.slice(0, 3).map((m) => m.name || m.id).join('、');
        const more = bound.length > 3 ? ' 等 ' + bound.length + ' 个' : '';
        const ok = window.OCUI
          ? await window.OCUI.confirm({ title: '移除密钥', message: '「' + (victim.name || '未命名') + '」正被模型 ' + names + more + ' 使用，移除后这些模型会改用默认密钥。确认移除？', danger: true, confirmText: '移除' })
          : confirm('密钥「' + (victim.name || '未命名') + '」正被 ' + bound.length + ' 个模型使用，移除后它们会改用默认密钥。确认?');
        if (!ok) return;
      }
      AP_KEYS.splice(i, 1);
      if (!AP_KEYS.length) AP_KEYS.push({ id: '', name: '', apiKey: '' });
      renderApKeys();
      return;
    }
    const eye = e.target.closest ? e.target.closest('.ap-key-eye') : null;
    if (!eye) return;
    const i = Number(eye.dataset.idx);
    const k = AP_KEYS[i];
    if (!k) return;
    const input = box.querySelector('input.ap-key-val[data-idx="' + i + '"]');
    if (!input) return;
    // 编辑模式 + 输入为空 + 属主勾选过「保存后保持显示」:取回服务器上保存的明文
    if (AP_KEYS_EDIT_ID && String(k.apiKey || '').trim() === '') {
      if (!AP_KEYS_REVEALABLE) { toast('该 Key 保存时未勾选「保存后保持显示」，无法查看', true); return; }
      try {
        eye.disabled = true;
        const rr = await api('/api/providers/' + encodeURIComponent(AP_KEYS_EDIT_ID) + '/key?keyId=' + encodeURIComponent(k.id || ''), { method: 'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error((dd.error && dd.error.message) || '无法查看 Key');
        k.apiKey = dd.key || '';
        input.value = k.apiKey;
        setKeyVisibility(input, eye, true);
      } catch (err) {
        toast(err.message || '无法查看 Key', true);
      } finally { eye.disabled = false; }
      return;
    }
    setKeyVisibility(input, eye, input.type !== 'text');
  });
})();

bindFetchKeyBox();

const apModelList = window.OC && window.OC.bindModelChecklist
  ? window.OC.bindModelChecklist({
    listId: 'ap-models-list',
    queryId: 'ap-model-q',
    allId: 'ap-models-all',
    countId: 'ap-models-count',
    addId: 'ap-model-add',
  })
  : null;

// 表单初次渲染就得有一行空白 Key:AP_KEYS 此前只在「编辑供应商 / 保存后」被填充,
// 页面刚打开时密钥区是空的(只有一个「+ 添加 Key」按钮),用户会以为没有可填的地方,
// 必须先点一次添加才出现输入框。放在 apModelList 之后:renderApKeys 会读它
// (const 的暂时性死区,提前调用会直接抛 ReferenceError)。
apKeysFromProvider(null);

// 用户自建供应商不出现在管理后台;这里只展示管理员配置的全局供应商
async function loadProviders() {
  const r = await api('/api/providers');
  const data = await r.json();
  const box = $('admin-providers');
  box.innerHTML = '';
  const providers = (data.providers || []).filter((p) => p.scope === 'global');
  // 上/下移:把当前顺序数组里相邻两项对调后整体提交,保证前台按此顺序展示
  const providerIds = providers.map((p) => p.id);
  const saveReorder = async (ids) => {
    try {
      const rr = await api('/api/admin/providers/' + ids[0], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', order: ids }),
      });
      if (!rr.ok) throw new Error('排序失败');
      loadProviders();
    } catch (e) { toast(e.message || '排序失败', true); }
  };
  providers.forEach((p, idx) => {
    const isDefault = p.id === data.defaultProviderId;
    const disabled = p.enabled === false;
    const card = document.createElement('div');
    card.className = 'provider-card' + (disabled ? ' disabled' : '');
    const keyHtml = p.hasKey && p.keyRevealable
      ? '<div class="pc-key">Key: <span class="pc-key-value" data-key-value="' + p.id + '" data-masked="' + escapeHtml(p.apiKey || '••••••') + '">' + escapeHtml(p.apiKey || '••••••') + '</span>'
        + '<button class="pc-key-eye" data-reveal="' + p.id + '" type="button" title="显示 Key" aria-label="显示 Key">' + window.OC.icon('eye', 13) + '</button></div>'
      : '';
    card.innerHTML = `
      <div class="pc-info">
        <div class="pc-name">${escapeHtml(p.name)}
          <span class="badge global">全局</span>
          ${isDefault ? '<span class="badge default">默认</span>' : ''}
          ${disabled ? '<span class="badge disabled">已停用</span>' : ''}
        </div>
        <div class="pc-url">${escapeHtml(p.baseUrl)} · ${escapeHtml(p.apiFormat)} · ${Array.isArray(p.models) ? p.models.length : 0} 个模型 · ${p.billingMode === 'token' ? ('按 token ' + (p.pricePer1k || 0) + '/1K') : ('扣 ' + p.costPerCall + ' 次')}</div>
        ${keyHtml}
      </div>
      <div class="provider-card-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn small" data-up="' + p.id + '" type="button" title="上移（前台显示更靠前）">↑</button>
        <button class="btn small" data-down="' + p.id + '" type="button" title="下移（前台显示更靠后）">↓</button>
        ${!disabled && !isDefault ? '<button class="btn small" data-default="' + p.id + '">设为默认</button>' : ''}
        <button class="btn small" data-toggle type="button">${disabled ? '启用' : '停用'}</button>
        <button class="btn small" data-test type="button">测试</button>
        <button class="btn small" data-edit type="button">编辑</button>
        <button class="btn small danger" data-del type="button">删除</button>
      </div>`;
    card.querySelector('[data-up]')?.addEventListener('click', () => {
      if (idx <= 0) return;
      const ids = providerIds.slice();
      [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
      saveReorder(ids);
    });
    card.querySelector('[data-down]')?.addEventListener('click', () => {
      if (idx >= providerIds.length - 1) return;
      const ids = providerIds.slice();
      [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]];
      saveReorder(ids);
    });
    card.querySelector('[data-toggle]')?.addEventListener('click', async () => {
      const enable = disabled;
      try {
        const rr = await api('/api/admin/providers/' + p.id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enable }),
        });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error((dd.error && dd.error.message) || '操作失败');
        toast(enable ? '已启用' : '已停用，用户端不再显示该供应商');
        loadProviders();
        loadStats();
      } catch (err) {
        toast(err.message || '操作失败', true);
      }
    });
    card.querySelector('[data-default]')?.addEventListener('click', async () => {
      const rr = await api('/api/admin/providers/' + p.id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-default' }),
      });
      if (rr.ok) { toast('已设为默认'); loadProviders(); } else toast('操作失败', true);
    });
    card.querySelector('[data-reveal]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const span = card.querySelector('[data-key-value="' + p.id + '"]');
      if (!btn || !span) return;
      if (span.getAttribute('data-revealed') === '1') {
        span.textContent = span.getAttribute('data-masked') || '••••••';
        span.removeAttribute('data-revealed');
        btn.innerHTML = window.OC.icon('eye', 13);
        btn.title = '显示 Key';
        return;
      }
      try {
        btn.disabled = true;
        const rr = await api('/api/providers/' + encodeURIComponent(p.id) + '/key', { method: 'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error((dd.error && dd.error.message) || '无法查看 Key');
        span.textContent = dd.key || '';
        span.setAttribute('data-revealed', '1');
        btn.innerHTML = window.OC.icon('eyeOff', 13);
        btn.title = '隐藏 Key';
      } catch (err) {
        toast(err.message || '无法查看 Key', true);
      } finally {
        btn.disabled = false;
      }
    });
    card.querySelector('[data-del]')?.addEventListener('click', async () => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除供应商', message: '确认删除供应商「' + p.name + '」？', danger: true, confirmText: '删除' })
        : confirm('确认删除供应商 ' + p.name + '？');
      if (!ok) return;
      const rr = await api('/api/admin/providers/' + p.id, { method: 'DELETE' });
      if (rr.ok) { toast('已删除'); loadProviders(); loadStats(); } else toast('删除失败', true);
    });
    const fillEditForm = (target) => {
      showAdminTab('providers');
      $('ap-name').value = target.name;
      $('ap-baseurl').value = target.baseUrl;
      // 接口只回掩码:密钥编辑器里空值表示「沿用已保存的密钥」,输入新值才覆盖
      apKeysFromProvider(target);
      $('ap-key-keep').checked = target.keyRevealable !== false;
      window.apEditingRevealable = target.keyRevealable !== false;
      delete $('ap-save').dataset.origKey;
      if (window.__setApFormat) window.__setApFormat(target.apiFormat);
      if (apModelList) {
        apModelList.setKeys((target.keys || []).map((k) => ({ id: k.id, name: k.name || k.id })));
        apModelList.setEnabled(target.models || []);
      }
      $('ap-cost').value = target.costPerCall;
      if (window.__setApBilling) window.__setApBilling(target.billingMode || 'call');
      if ($('ap-price')) $('ap-price').value = target.pricePer1k != null ? target.pricePer1k : 0;
      $('ap-save').dataset.editId = target.id;
      $('ap-save').textContent = '保存修改';
      // 编辑态标识 + 取消入口:避免「以为在新增,实际在覆盖」
      const cancelBtn = $('ap-cancel-edit');
      if (cancelBtn) cancelBtn.classList.remove('hidden');
      const note = $('ap-editing-note');
      if (note) { note.hidden = false; note.textContent = '正在编辑「' + (target.name || target.id) + '」，保存会覆盖其配置'; }
    };
    // 退出编辑态:恢复「新增供应商」默认表单
    const resetProviderForm = () => {
      delete $('ap-save').dataset.editId;
      window.apEditingRevealable = false;
      $('ap-save').textContent = '保存供应商';
      $('ap-name').value = ''; $('ap-baseurl').value = '';
      apKeysFromProvider(null);
      resetModelTestResults();
      if (apModelList) { apModelList.setKeys([]); apModelList.reset(); }
      if (window.__setApBilling) window.__setApBilling('call');
      if ($('ap-price')) $('ap-price').value = 0;
      if ($('ap-key-keep')) $('ap-key-keep').checked = true;
      const cancelBtn = $('ap-cancel-edit');
      if (cancelBtn) cancelBtn.classList.add('hidden');
      const note = $('ap-editing-note');
      if (note) note.hidden = true;
    };
    const cancelBtn0 = $('ap-cancel-edit');
    if (cancelBtn0) cancelBtn0.addEventListener('click', () => {
      resetProviderForm();
      const details = document.querySelector('.add-provider');
      if (details) details.open = false;
      toast('已退出编辑');
    });
card.querySelector('[data-edit]')?.addEventListener('click', () => {
      fillEditForm(p);
      resetModelTestResults();
      // 展开添加/编辑表单
      const details = document.querySelector('.add-provider');
      if (details && !details.open) details.open = true;
      // 滚动到表单
      $('ap-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => $('ap-name').focus(), 350);
    });
    card.querySelector('[data-test]')?.addEventListener('click', () => {
      const details = document.querySelector('.add-provider');
      if (details && !details.open) details.open = true;
      fillEditForm(p);
      resetModelTestResults();
      if ($('ap-test-prompt') && !$('ap-test-prompt').value.trim()) $('ap-test-prompt').value = '回复一个字：好';
      if (typeof refreshModelTestSelect === 'function') refreshModelTestSelect((p.models[0] && p.models[0].id) || '');
      const el = $('ap-test');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    box.appendChild(card);
  });
  if (!providers.length) box.innerHTML = '<p class="muted small">暂无全局供应商。用户自建的供应商仅本人可见，不出现在后台。</p>';
}

const WS_PROVIDERS = [
  { value: 'ddg', label: 'DuckDuckGo', sub: '免 Key，默认；抓结果页，有速率限制' },
  { value: 'tavily', label: 'Tavily', sub: '官方搜索 API，填 Key 即可' },
  { value: 'searxng', label: 'SearXNG', sub: '自建元搜索，填实例地址' },
  { value: 'brave', label: 'Brave Search', sub: '独立索引，免费 2000 次/月' },
  { value: 'jina', label: 'Jina AI', sub: '免 Key 可用，填 Key 提升配额' },
];
const WS_PROVIDER_NAMES = { tavily: 'Tavily', searxng: 'SearXNG', brave: 'Brave Search', ddg: 'DuckDuckGo', jina: 'Jina AI' };
function setWsProvider(val) {
  const box = $('ws-provider');
  if (!box) return;
  const known = WS_PROVIDERS.some((x) => x.value === val);
  const next = known ? val : 'ddg';
  box.setAttribute('data-value', next);
  const f = WS_PROVIDERS.find((x) => x.value === next);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = f ? f.label : next;
  if ($('ws-tavily-row')) $('ws-tavily-row').classList.toggle('hidden', next !== 'tavily');
  if ($('ws-brave-row')) $('ws-brave-row').classList.toggle('hidden', next !== 'brave');
  if ($('ws-jina-row')) $('ws-jina-row').classList.toggle('hidden', next !== 'jina');
  if ($('ws-searx-row')) $('ws-searx-row').classList.toggle('hidden', next !== 'searxng');
}
// 「对话设置」面板专用加载:此前该页签没有 loader,直接打开会显示 HTML 默认值,
// 若此时点保存会把默认值写回服务端、静默重置真实配置。
async function loadChatSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  fillChatLimits((data && data.settings) || {});
}
// 性能优化面板:读取/保存
function fillPerfSettings(s) {
  const src = s || {};
  if ($('perf-no-webfonts')) $('perf-no-webfonts').checked = !!src.perfNoWebfonts;
  if ($('perf-no-katex')) $('perf-no-katex').checked = !!src.perfNoKatex;
  if ($('perf-no-highlight')) $('perf-no-highlight').checked = !!src.perfNoHighlight;
  if ($('perf-no-mermaid')) $('perf-no-mermaid').checked = !!src.perfNoMermaid;
}
async function loadPerfSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  fillPerfSettings((data && data.settings) || {});
}
(function initPerfSettings() {
  const save = $('perf-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const body = {
      perfNoWebfonts: !!($('perf-no-webfonts') && $('perf-no-webfonts').checked),
      perfNoKatex: !!($('perf-no-katex') && $('perf-no-katex').checked),
      perfNoHighlight: !!($('perf-no-highlight') && $('perf-no-highlight').checked),
      perfNoMermaid: !!($('perf-no-mermaid') && $('perf-no-mermaid').checked),
    };
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      fillPerfSettings(data.settings || body);
      toast('性能设置已保存，用户下次访问生效');
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();
async function loadSearchSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  const s = (data && data.settings) || {};
  if ($('ws-enabled')) $('ws-enabled').checked = !!s.webSearchEnabled;
  if ($('ws-allow-user')) $('ws-allow-user').checked = !!s.webSearchAllowUser;
  if ($('ws-url-read')) $('ws-url-read').checked = s.urlReadEnabled !== false;
  if ($('ws-url-read-max')) $('ws-url-read-max').value = Math.min(5, Math.max(1, parseInt(s.urlReadMax, 10) || 3));
  setWsProvider(s.webSearchProvider || 'ddg');
  if ($('ws-tavily-key') && s.webSearchTavilyKey) $('ws-tavily-key').value = s.webSearchTavilyKey;
  if ($('ws-brave-key') && s.webSearchBraveKey) $('ws-brave-key').value = s.webSearchBraveKey;
  if ($('ws-jina-key') && s.webSearchJinaKey) $('ws-jina-key').value = s.webSearchJinaKey;
  if ($('ws-searx-url')) $('ws-searx-url').value = s.webSearchSearxUrl || '';
  if ($('ws-max')) $('ws-max').value = s.webSearchMaxResults || 5;
  fillMineruSettings(s);
  fillChatLimits(s);
}
function fillChatLimits(s) {
  const src = s || {};
  const maxCtx = Math.min(500, Math.max(2, parseInt(src.maxContextMessages, 10) || 200));
  const ctx = Math.min(maxCtx, Math.max(2, parseInt(src.contextMessages, 10) || 12));
  if ($('chat-context-max')) $('chat-context-max').value = maxCtx;
  if ($('chat-context')) $('chat-context').value = ctx;
  if ($('chat-temperature')) {
    const t = parseFloat(src.temperature);
    $('chat-temperature').value = Number.isFinite(t) ? t : '';
  }
  if ($('chat-ratelimit')) $('chat-ratelimit').value = Math.min(600, Math.max(0, parseInt(src.rateLimitPerMin, 10) || 0));
  if ($('chat-timeout')) $('chat-timeout').value = Math.min(600, Math.max(5, Math.round((parseInt(src.proxyTimeoutMs, 10) || 120000) / 1000)));
  if ($('chat-outbound-proxy')) $('chat-outbound-proxy').value = String(src.outboundProxy || '');
  if ($('chat-context-learn')) $('chat-context-learn').checked = src.contextAutoLearn !== false;
  if ($('chat-persist-chats')) $('chat-persist-chats').checked = src.persistChats !== false;
  if ($('chat-sync-settings')) $('chat-sync-settings').checked = src.syncSettings !== false;
  if ($('chat-save-api')) $('chat-save-api').checked = src.apiSaveChats !== false;
  if ($('chat-health-ok')) $('chat-health-ok').value = Math.min(100, Math.max(1, parseInt(src.healthOkMin, 10) || 75));
  if ($('chat-health-warn')) $('chat-health-warn').value = Math.min(99, Math.max(0, parseInt(src.healthWarnMin, 10) || 40));
  if ($('chat-img-archive')) $('chat-img-archive').checked = src.imageArchiveEnabled !== false;
  if ($('chat-img-archive-quota')) $('chat-img-archive-quota').value = Math.min(10240, Math.max(50, parseInt(src.imageArchiveQuotaMb, 10) || 500));
}
(function initChatLimits() {
  document.querySelectorAll('#panel-chat .stepper [data-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.getAttribute('data-target'));
      if (!input) return;
      const delta = parseInt(btn.getAttribute('data-step'), 10) || 0;
      const current = parseInt(input.value, 10) || 0;
      input.value = String(Math.min(500, Math.max(2, current + delta)));
    });
  });
  const save = $('chat-limits-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const maxCtx = Math.min(500, Math.max(2, parseInt($('chat-context-max') && $('chat-context-max').value, 10) || 200));
    const ctx = Math.min(maxCtx, Math.max(2, parseInt($('chat-context') && $('chat-context').value, 10) || 40));
    const tempRaw = parseFloat(($('chat-temperature') && $('chat-temperature').value) || '');
    const temperature = Number.isFinite(tempRaw) ? Math.min(2, Math.max(0, tempRaw)) : null;
    const rateLimit = Math.min(600, Math.max(0, parseInt($('chat-ratelimit') && $('chat-ratelimit').value, 10) || 0));
    const timeoutSec = Math.min(600, Math.max(5, parseInt($('chat-timeout') && $('chat-timeout').value, 10) || 120));
    const contextLearn = !!($('chat-context-learn') && $('chat-context-learn').checked);
    const persistChats = !!($('chat-persist-chats') && $('chat-persist-chats').checked);
    const syncSettings = !!($('chat-sync-settings') && $('chat-sync-settings').checked);
    const apiSaveChats = !!($('chat-save-api') && $('chat-save-api').checked);
    // 可用性阈值:保证 okMin 严格大于 warnMin(输入颠倒时本地纠正并回写)
    let healthOk = Math.min(100, Math.max(1, parseInt($('chat-health-ok') && $('chat-health-ok').value, 10) || 75));
    let healthWarn = Math.min(99, Math.max(0, parseInt($('chat-health-warn') && $('chat-health-warn').value, 10)));
    if (!(healthWarn < healthOk)) healthWarn = Math.max(0, healthOk - 1);
    if ($('chat-health-ok')) $('chat-health-ok').value = healthOk;
    if ($('chat-health-warn')) $('chat-health-warn').value = healthWarn;
    const imageArchiveEnabled = !!($('chat-img-archive') && $('chat-img-archive').checked);
    const imageArchiveQuotaMb = Math.min(10240, Math.max(50, parseInt($('chat-img-archive-quota') && $('chat-img-archive-quota').value, 10) || 500));
    const outboundProxy = String(($('chat-outbound-proxy') && $('chat-outbound-proxy').value) || '').trim();
    // 前端先挡一道:格式不对就不提交,避免保存后静默变空(后端也会再校验一次)
    if (outboundProxy && !/^(https?|socks5h?):\/\/\S{1,300}$/i.test(outboundProxy)) {
      return toast('出站代理格式不正确，应形如 http://127.0.0.1:2080 或 socks5h://127.0.0.1:1080', true);
    }
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextMessages: ctx, maxContextMessages: maxCtx, temperature, rateLimitPerMin: rateLimit, proxyTimeoutMs: timeoutSec * 1000, contextAutoLearn: contextLearn, persistChats, syncSettings, apiSaveChats, healthOkMin: healthOk, healthWarnMin: healthWarn, imageArchiveEnabled, imageArchiveQuotaMb, outboundProxy }),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      fillChatLimits(data.settings || { contextMessages: ctx, maxContextMessages: maxCtx, temperature });
      toast('对话设置已保存');
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();
(function initSearchSettings() {
  const box = $('ws-provider');
  if (box) {
    box.addEventListener('click', () => {
      OC.openSelect(box, WS_PROVIDERS, {
        selected: box.getAttribute('data-value') || 'ddg',
        onSelect: (val) => setWsProvider(val),
      });
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
    });
  }
  const save = $('ws-save');
  function wsPayload(scan) {
    const provider = ($('ws-provider') && $('ws-provider').getAttribute('data-value')) || 'ddg';
    const keyFor = { tavily: 'ws-tavily-key', brave: 'ws-brave-key', jina: 'ws-jina-key' };
    const key = (keyFor[provider] && $(keyFor[provider]) && $(keyFor[provider]).value || '').trim();
    const payload = {
      provider: provider,
      url: ($('ws-searx-url') && $('ws-searx-url').value || '').trim(),
      query: ($('ws-query') && $('ws-query').value || '').trim() || 'openai',
      max: Math.min(5, parseInt($('ws-max') && $('ws-max').value, 10) || 3),
      scan: !!scan,
    };
    if (key && key.indexOf('••') < 0) payload.apiKey = key;
    return payload;
  }
  function renderSearchProbe(data) {
    const box = $('ws-test-result');
    if (!box) return;
    const rows = data.results || (data.result ? [data.result] : []);
    if (!rows.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = rows.map((row) => {
      const ok = !!row.ok;
      const title = escapeHtml(row.url || WS_PROVIDER_NAMES[row.provider] || row.provider);
      const detail = ok
        ? ('返回 ' + (row.count || 0) + ' 条' + (row.sample && row.sample[0] ? ' · ' + row.sample[0].title : ''))
        : (row.error || '不可用');
      const use = row.provider === 'searxng' && row.url
        ? '<button class="btn small" type="button" data-use-searx="' + escapeHtml(row.url) + '">填入</button>'
        : '';
      return '<div class="probe-row ' + (ok ? 'ok' : 'bad') + '">'
        + '<div class="probe-main"><div class="probe-title">' + (ok ? '可用' : '失败') + ' · ' + title + '</div>'
        + '<div class="probe-sub">' + escapeHtml(detail) + '</div></div>'
        + '<div class="probe-side"><span class="probe-ms">' + (row.ms || 0) + ' ms</span>' + use + '</div></div>';
    }).join('');
  }
  async function runSearchProbe(scan) {
    const testBtn = $('ws-test');
    const scanBtn = $('ws-scan');
    const status = $('ws-test-status');
    if (testBtn) testBtn.disabled = true;
    if (scanBtn) scanBtn.disabled = true;
    if (status) status.textContent = scan ? '正在探测公共实例…' : '正在测试…';
    try {
      const r = await api('/api/admin/search/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wsPayload(scan)),
      });
      const data = await r.json();
      if (!r.ok) {
        if (status) status.textContent = '';
        return toast((data.error && data.error.message) || '测试失败', true);
      }
      renderSearchProbe(data);
      const rows = data.results || (data.result ? [data.result] : []);
      const good = rows.filter((x) => x.ok).length;
      const total = data.total || rows.length;
      if (status) status.textContent = scan ? ('可用 ' + good + ' / ' + total) : (good ? '当前接口可用' : '当前接口不可用');
    } catch (e) {
      if (status) status.textContent = '';
      toast('测试失败: ' + e.message, true);
    } finally {
      if (testBtn) testBtn.disabled = false;
      if (scanBtn) scanBtn.disabled = false;
    }
  }
  const testBtn = $('ws-test');
  const scanBtn = $('ws-scan');
  const resultBox = $('ws-test-result');
  if (testBtn) testBtn.addEventListener('click', () => runSearchProbe(false));
  if (scanBtn) scanBtn.addEventListener('click', () => {
    setWsProvider('searxng');
    runSearchProbe(true);
  });
  if (resultBox) resultBox.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-use-searx]');
    if (!btn || !$('ws-searx-url')) return;
    setWsProvider('searxng');
    const url = (btn.getAttribute('data-use-searx') || '').trim().replace(/\/+$/, '');
    const lines = $('ws-searx-url').value.split(/\s+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
    if (lines.some((s) => s.toLowerCase() === url.toLowerCase())) return toast('这个地址已经在列表里');
    lines.push(url);
    $('ws-searx-url').value = lines.join('\n');
    toast('已追加 SearXNG 地址，记得保存');
  });
  if (save) save.addEventListener('click', async () => {
    const key = ($('ws-tavily-key') && $('ws-tavily-key').value || '').trim();
    const braveKey = ($('ws-brave-key') && $('ws-brave-key').value || '').trim();
    const jinaKey = ($('ws-jina-key') && $('ws-jina-key').value || '').trim();
    const payload = {
      webSearchEnabled: !!($('ws-enabled') && $('ws-enabled').checked),
      webSearchAllowUser: !!($('ws-allow-user') && $('ws-allow-user').checked),
      urlReadEnabled: !!($('ws-url-read') && $('ws-url-read').checked),
      urlReadMax: Math.min(5, Math.max(1, parseInt($('ws-url-read-max') && $('ws-url-read-max').value, 10) || 3)),
      webSearchProvider: ($('ws-provider') && $('ws-provider').getAttribute('data-value')) || 'ddg',
      webSearchSearxUrl: ($('ws-searx-url') && $('ws-searx-url').value || '').trim(),
      webSearchMaxResults: parseInt($('ws-max') && $('ws-max').value, 10) || 5,
    };
    if (key && key.indexOf('••') < 0) payload.webSearchTavilyKey = key;
    if (braveKey && braveKey.indexOf('••') < 0) payload.webSearchBraveKey = braveKey;
    if (jinaKey && jinaKey.indexOf('••') < 0) payload.webSearchJinaKey = jinaKey;
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      toast('联网设置已保存');
      if (data.settings) {
        setWsProvider(data.settings.webSearchProvider);
        if ($('ws-enabled')) $('ws-enabled').checked = !!data.settings.webSearchEnabled;
        if ($('ws-allow-user')) $('ws-allow-user').checked = !!data.settings.webSearchAllowUser;
        if ($('ws-tavily-key') && data.settings.webSearchTavilyKey) $('ws-tavily-key').value = data.settings.webSearchTavilyKey;
        if ($('ws-brave-key') && data.settings.webSearchBraveKey) $('ws-brave-key').value = data.settings.webSearchBraveKey;
        if ($('ws-jina-key') && data.settings.webSearchJinaKey) $('ws-jina-key').value = data.settings.webSearchJinaKey;
        if ($('ws-searx-url')) $('ws-searx-url').value = data.settings.webSearchSearxUrl || '';
        if ($('ws-max')) $('ws-max').value = data.settings.webSearchMaxResults || 5;
      }
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();


function shownHasMask(token) {
  return String(token || '').indexOf('••') >= 0;
}

// ============ 第三方一键登录 ============
// 提供商元数据(字段名/显示名/图标/申请入口/回调路径)与后端 tc_oauth_providers() 对应
// callbackPath 必须与后端 tc_oauth_providers()[id] 的路由一致(/auth/<id>/callback)
const OAUTH_PROVIDERS = [
  {
    id: 'wechat', name: '微信', logo: 'static/logo/weixin.svg',
    hint: '需在微信开放平台创建「网站应用」并通过审核，回调域需与备案域名一致',
    docs: 'https://open.weixin.qq.com',
    callbackPath: '/auth/wechat/callback',
    callbackWhere: '填在「网站应用 → 授权回调域」，只需填域名（如 example.com），不要带路径',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: 'wx开头的应用 ID' },
      { key: 'appSecret', label: 'AppSecret', placeholder: '应用密钥', secret: true },
    ],
  },
  {
    id: 'qq', name: 'QQ', logo: 'static/logo/qq.svg',
    hint: '需在 QQ 互联（connect.qq.com）创建网站应用，审核通过后获得 AppID 与 AppKey',
    docs: 'https://connect.qq.com',
    callbackPath: '/auth/qq/callback',
    callbackWhere: '填在「网站应用 → 回调地址」，需填完整地址（含 /auth/qq/callback）',
    fields: [
      { key: 'appId', label: 'AppID', placeholder: '数字 AppID' },
      { key: 'appKey', label: 'AppKey', placeholder: '应用密钥', secret: true },
    ],
  },
  {
    id: 'linuxdo', name: 'LINUX DO', logo: 'static/logo/linuxdo.png',
    hint: '在 connect.linux.do 创建应用；scope 使用 openid profile email',
    docs: 'https://connect.linux.do',
    callbackPath: '/auth/linuxdo/callback',
    callbackWhere: '填在应用的 Redirect URI / 回调地址',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: '应用 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '应用密钥', secret: true },
    ],
  },
  {
    id: 'nodeloc', name: 'NodeLoc', logo: 'static/logo/nodeloc.png',
    hint: '在 nodeloc.com/oauth-provider/applications 创建应用（需 TL2 及以上）',
    docs: 'https://www.nodeloc.com/oauth-provider/applications',
    callbackPath: '/auth/nodeloc/callback',
    callbackWhere: '填在应用的 Redirect URI / 回调地址',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: '应用 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '应用密钥', secret: true },
    ],
  },
];

function renderOauthProviders(s) {
  const box = $('oauth-providers');
  if (!box) return;
  const cfg = (s && s.oauthProviders) || {};
  box.innerHTML = OAUTH_PROVIDERS.map((p) => {
    const row = (cfg[p.id] && typeof cfg[p.id] === 'object') ? cfg[p.id] : {};
    const on = !!row.enabled;
    const fields = p.fields.map((f) => {
      const val = row[f.key] || '';
      return '<label class="field" style="margin:8px 0 0"><span>' + escapeHtml(f.label) + '</span>'
        + '<input type="' + (f.secret ? 'password' : 'text') + '" data-oauth="' + p.id + '" data-key="' + f.key + '"'
        + ' value="' + escapeHtml(f.secret ? val : (val.indexOf('••') >= 0 ? '' : val)) + '"'
        + ' placeholder="' + escapeHtml(f.placeholder || '') + '" autocomplete="off"' + (on ? '' : ' disabled') + '>'
        + '</label>';
    }).join('');
    return '<div class="oauth-row" data-oauth-row="' + p.id + '" style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:12px 14px;margin-bottom:10px">'
      + '<label class="user-form-admin" style="margin:0">'
      + '<span class="switch"><input type="checkbox" data-oauth-enable="' + p.id + '"' + (on ? ' checked' : '') + '><span class="slider"></span></span>'
      + '<img src="' + p.logo + '" alt="" style="width:20px;height:20px;border-radius:5px;object-fit:contain;vertical-align:-4px;margin-right:6px">'
      + '<b>' + escapeHtml(p.name) + '</b>'
      + '</label>'
      + '<p class="muted small" style="margin:6px 0 0">' + escapeHtml(p.hint)
      + ' · <a href="' + escapeHtml(p.docs) + '" target="_blank" rel="noopener">申请入口</a></p>'
      + '<div class="oauth-fields" style="' + (on ? '' : 'display:none') + '">' + fields + '</div>'
      + '</div>';
  }).join('');
  renderOauthCallbacks();
}

// 逐平台列出「该填哪条回调地址」——各平台不能共用,具体路径见 OAUTH_PROVIDERS[].callbackPath
function renderOauthCallbacks() {
  const box = $('oauth-callback-list');
  if (!box) return;
  const origin = location.origin;
  box.innerHTML = OAUTH_PROVIDERS.map((p) => {
    const url = origin + p.callbackPath;
    return '<div class="row-between" style="gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#eee);align-items:flex-start">'
      + '<div style="min-width:0;flex:1">'
      + '<div><img src="' + p.logo + '" alt="" style="width:16px;height:16px;border-radius:4px;object-fit:contain;vertical-align:-3px;margin-right:5px">'
      + '<b>' + escapeHtml(p.name) + '</b>'
      + '<span class="muted small"> · ' + escapeHtml(p.callbackWhere) + '</span></div>'
      + '<code style="word-break:break-all;font-size:12px">' + escapeHtml(url) + '</code>'
      + '</div>'
      + '<button class="btn small" type="button" data-copy-cb="' + escapeHtml(url) + '">复制</button>'
      + '</div>';
  }).join('');
}
function fillOauthSettings(s) {
  if ($('oauth-auto-register')) $('oauth-auto-register').checked = (s && s.oauthAutoRegister) !== false;
  if ($('oauth-require-profile')) $('oauth-require-profile').checked = !!(s && s.oauthRequireProfile);
  renderOauthProviders(s || {});
}
async function loadOauthSettings() {
  const r = await api('/api/admin/settings');
  const data = await r.json();
  if (!r.ok) return toast((data.error && data.error.message) || '加载失败', true);
  fillOauthSettings((data && data.settings) || {});
}
(function initOauthSettings() {
  const box = $('oauth-providers');
  if (box) {
    box.addEventListener('change', (e) => {
      const en = e.target.closest('[data-oauth-enable]');
      if (!en) return;
      const pid = en.getAttribute('data-oauth-enable');
      const row = box.querySelector('[data-oauth-row="' + pid + '"]');
      if (!row) return;
      const fields = row.querySelector('.oauth-fields');
      if (fields) fields.style.display = en.checked ? '' : 'none';
      row.querySelectorAll('[data-oauth]').forEach((inp) => { inp.disabled = !en.checked; });
    });
  }
  // 回调地址一键复制
  const cbList = $('oauth-callback-list');
  if (cbList) {
    cbList.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-copy-cb]');
      if (!btn) return;
      const val = btn.getAttribute('data-copy-cb') || '';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(val);
        else {
          const ta = document.createElement('textarea');
          ta.value = val; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
        const old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch (err) {
        toast('复制失败，请手动选择复制', true);
      }
    });
  }
  const save = $('oauth-save');
  if (save) save.addEventListener('click', async () => {
    const payload = { oauthProviders: {}, oauthAutoRegister: !!($('oauth-auto-register') && $('oauth-auto-register').checked), oauthRequireProfile: !!($('oauth-require-profile') && $('oauth-require-profile').checked) };
    OAUTH_PROVIDERS.forEach((p) => {
      const enableBox = box && box.querySelector('[data-oauth-enable="' + p.id + '"]');
      const row = { enabled: !!(enableBox && enableBox.checked) };
      p.fields.forEach((f) => {
        const inp = box && box.querySelector('[data-oauth="' + p.id + '"][data-key="' + f.key + '"]');
        const v = (inp && inp.value || '').trim();
        // 敏感字段:掩码或留空都不提交,由后端保留原值(避免误清空已保存的密钥)
        if (f.secret && (v === '' || v.indexOf('••') >= 0)) return;
        row[f.key] = v;
      });
      payload.oauthProviders[p.id] = row;
    });
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      toast('第三方登录设置已保存');
      if (data.settings) fillOauthSettings(data.settings);
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();
function fillMineruSettings(s) {
  const token = (s && s.mineruToken) || '';
  if ($('mineru-token') && token) $('mineru-token').value = token;
  const mode = $('mineru-mode');
  const precise = shownHasMask(token);
  const allow = $('mineru-allow-user');
  if (allow) allow.checked = !!(s && s.mineruAllowUser);
  if (mode) mode.textContent = precise
    ? '当前：精准解析。单文件不超过 200MB、200 页，Token 仅保存在服务器。'
    : '当前：轻量解析。单文件不超过 10MB、20 页，同一 IP 每分钟有次数限制。用户上传后直接解析，只有超限或失败时才会看到限制。';
  // 解析通道路由 + 新源配置回填
  const routes = (s && s.parseChannels) || {};
  if ($('paddle-url') && s.paddleOcrUrl != null) $('paddle-url').value = s.paddleOcrUrl;
  if ($('paddle-key') && s.paddleOcrKey) $('paddle-key').value = s.paddleOcrKey;
  if ($('mistral-key') && s.mistralOcrKey) $('mistral-key').value = s.mistralOcrKey;
  setParseRoute('parse-route-pdf', routes.pdf);
  setParseRoute('parse-route-image', routes.image);
  setParseRoute('parse-route-office', routes.office);
}
const PARSE_CHANNELS = [
  { value: 'mineru', label: 'MinerU', sub: '全格式：PDF/图片/Office/HTML' },
  { value: 'paddle', label: 'PaddleOCR', sub: '仅 PDF 与图片（自建 serving 或托管 API）' },
  { value: 'mistral', label: 'Mistral OCR', sub: 'PDF/图片/DOCX/PPTX，效果好，按量计费' },
];
const PARSE_CHANNEL_NAMES = { mineru: 'MinerU', paddle: 'PaddleOCR', mistral: 'Mistral OCR' };
function setParseRoute(boxId, val) {
  const box = $(boxId);
  if (!box) return;
  const next = PARSE_CHANNEL_NAMES[val] ? val : 'mineru';
  box.setAttribute('data-value', next);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = PARSE_CHANNEL_NAMES[next];
}
(function initMineruSettings() {
  // 三个路由下拉共用一套通道选项
  ['parse-route-pdf', 'parse-route-image', 'parse-route-office'].forEach((id) => {
    const box = $(id);
    if (!box) return;
    const open = () => {
      OC.openSelect(box, PARSE_CHANNELS, {
        selected: box.getAttribute('data-value') || 'mineru',
        onSelect: (val) => setParseRoute(id, val),
      });
    };
    box.addEventListener('click', open);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
  const save = $('mineru-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const key = ($('mineru-token') && $('mineru-token').value || '').trim();
    const payload = { mineruAllowUser: !!($('mineru-allow-user') && $('mineru-allow-user').checked) };
    if (!key) payload.mineruToken = '';
    else if (key.indexOf('••') < 0) payload.mineruToken = key;
    payload.parseChannels = {
      pdf: ($('parse-route-pdf') && $('parse-route-pdf').getAttribute('data-value')) || 'mineru',
      image: ($('parse-route-image') && $('parse-route-image').getAttribute('data-value')) || 'mineru',
      office: ($('parse-route-office') && $('parse-route-office').getAttribute('data-value')) || 'mineru',
    };
    payload.paddleOcrUrl = ($('paddle-url') && $('paddle-url').value || '').trim();
    const paddleKey = ($('paddle-key') && $('paddle-key').value || '').trim();
    if (paddleKey.indexOf('••') < 0) payload.paddleOcrKey = paddleKey;
    const mistralKey = ($('mistral-key') && $('mistral-key').value || '').trim();
    if (mistralKey.indexOf('••') < 0) payload.mistralOcrKey = mistralKey;
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
      toast('文档解析设置已保存');
      if (data.settings) fillMineruSettings(data.settings);
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });
})();

// API 格式自定义选择
(function initFormatSelect() {
  const box = $('ap-format');
  if (!box) return;
  const FORMATS = [
    { value: 'chat', label: 'OpenAI chat/completions', sub: '对话接口 /v1/chat/completions（常用）' },
    { value: 'responses', label: 'OpenAI responses', sub: '新版接口 /v1/responses' },
    { value: 'completions', label: 'OpenAI completions', sub: '旧版补全 /v1/completions' },
    { value: 'anthropic', label: 'Anthropic messages', sub: 'Claude 消息接口 /v1/messages' },
    { value: 'video', label: 'Agnes videos', sub: '视频生成 /v1/videos（异步任务，前台可生视频）' },
  ];
  const setLabel = (v) => {
    const f = FORMATS.find((x) => x.value === (v || box.getAttribute('data-value') || 'chat'));
    box.querySelector('.sb-label').textContent = f ? f.label : (v || 'chat');
  };
  window.__setApFormat = (v) => { box.setAttribute('data-value', v); setLabel(v); };
  box.addEventListener('click', () => {
    OC.openSelect(box, FORMATS.map((f) => ({ value: f.value, label: f.label, sub: f.sub })), {
      selected: box.getAttribute('data-value') || 'chat',
      onSelect: (val) => { box.setAttribute('data-value', val); setLabel(val); },
    });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
  });
})();

// 计费模式自定义选择:按次 / 按 token
(function initBillingSelect() {
  const box = $('ap-billing');
  if (!box) return;
  const MODES = [
    { value: 'call', label: '按次（扣费次数）', sub: '每次调用扣固定次数' },
    { value: 'token', label: '按 token', sub: '按实际用量（输入+输出）/1K 计费' },
  ];
  const setLabel = (v) => {
    const m = MODES.find((x) => x.value === (v || 'call'));
    box.querySelector('.sb-label').textContent = m ? m.label : v;
  };
  const togglePrice = (v) => { const row = $('ap-price-row'); if (row) row.classList.toggle('hidden', v !== 'token'); };
  window.__setApBilling = (v) => { box.setAttribute('data-value', v === 'token' ? 'token' : 'call'); setLabel(v); togglePrice(v); };
  box.addEventListener('click', () => {
    OC.openSelect(box, MODES, {
      selected: box.getAttribute('data-value') || 'call',
      onSelect: (val) => { box.setAttribute('data-value', val); setLabel(val); togglePrice(val); },
    });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
  });
})();
$('ap-fetch-models').addEventListener('click', async () => {
  const baseUrl = $('ap-baseurl').value.trim();
  const apiFormat = $('ap-format').getAttribute('data-value') || 'chat';
  if (!baseUrl) return toast('请先填写 Base URL', true);
  const editId = $('ap-save').dataset.editId;
  // 多密钥:用「获取用 Key」选择器指定的那把(默认第一把已填/已保存的)
  const usable = AP_KEYS.filter((k) => k.hasKey || String(k.apiKey || '').trim() !== '');
  const wantId = ($('ap-fetch-key') && $('ap-fetch-key').getAttribute('data-value')) || '';
  const pickKey = usable.find((k) => String(k.id) === wantId) || usable[0];
  const usedKey = pickKey && String(pickKey.apiKey || '').indexOf('••') < 0 ? String(pickKey.apiKey).trim() : '';
  const usedKeyId = pickKey ? pickKey.id : '';
  if (!usedKey && !usedKeyId && !editId) { toast('请先填写 API Key', true); return; }
  // 按某个 Key 拉取模型列表:新供应商用明文字段,已保存的供应商可只传 keyId 由服务端解密
  const fetchByKey = async (kid) => {
    const k = AP_KEYS.find((x) => String(x.id) === String(kid));
    const plain = k && String(k.apiKey || '').indexOf('••') < 0 ? String(k.apiKey).trim() : '';
    const r = await api('/api/proxy/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey: plain, apiFormat, keyId: (kid || undefined), providerId: editId || undefined }),
    });
    const data = await readJsonSafe(r);
    if (!r.ok) throw new Error((data.error && data.error.message) || ('获取失败（HTTP ' + r.status + '）'));
    return { models: data.models || [], keyId: String(kid || '') };
  };
  const btn = $('ap-fetch-models');
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const r = await api('/api/proxy/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey: usedKey, apiFormat, keyId: usedKeyId || undefined, providerId: editId || undefined }),
    });
    const data = await readJsonSafe(r);
    if (!r.ok) return toast((data.error && data.error.message) || ('获取失败（HTTP ' + r.status + '）'), true);
    const models = data.models || [];
    if (!models.length) return toast('上游未返回模型', true);
    if (window.OC && window.OC.openFetchedModelsModal) {
      window.OC.openFetchedModelsModal(models, {
        title: '获取到的模型',
        existing: apModelList ? apModelList.getCatalog() : [],
        keys: AP_KEYS.map((k, i) => ({ id: k.id, name: (k.name || '').trim() || ('未命名 ' + (i + 1)) })),
        fetchedKeyId: usedKeyId || '',
        // 弹窗内切换 Key 继续获取:再次拉取并并入当前清单
        onRefetch: (kid) => fetchByKey(kid),
        onApply: (picked, staleIds) => {
          resetModelTestResults();
          if (apModelList) apModelList.applyFetched(picked, staleIds);
          const n = picked.filter((m) => m.enabled).length;
          const cleared = (staleIds || []).length;
          toast('已应用 ' + n + ' 个启用模型' + (cleared ? '，清除 ' + cleared + ' 个失效模型' : '') + '，保存后生效');
          return true;
        },
      });
    } else if (apModelList) {
      resetModelTestResults();
      apModelList.setFromFetch(models);
      toast('已获取 ' + models.length + ' 个模型，勾选后保存即可启用');
    }
  } catch (e) {
    toast('获取失败: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '获取列表';
  }
});

function modelTestChoices() {
  const models = apModelList ? apModelList.getEnabled() : [];
  return models.map((m) => ({ value: m.id, label: m.name || m.id, sub: m.name && m.name !== m.id ? m.id : '' }));
}
function refreshModelTestSelect(prefer) {
  const box = $('ap-test-model');
  if (!box) return;
  const choices = modelTestChoices();
  const cur = prefer || box.getAttribute('data-value') || '';
  const hit = choices.find((x) => x.value === cur) || choices[0];
  box.setAttribute('data-value', hit ? hit.value : '');
  const lab = box.querySelector('.sb-label');
  if (lab) lab.innerHTML = hit ? escapeHtml(hit.label) : '<span class="muted">先获取或勾选模型</span>';
}
function modelProbeRow(model, row) {
  const ok = !!(row && row.ok);
  const timeout = !!(row && row.timeout);
  const tag = ok ? '可用' : (timeout ? '超时' : '失败');
  const detail = ok
    ? ((row && row.reply) || '已响应')
    : ((row && row.error) || '无回复');
  return '<div class="probe-row ' + (ok ? 'ok' : 'bad') + (timeout ? ' timeout' : '') + '" data-model="' + escapeHtml(model) + '">'
    + '<div class="probe-main"><div class="probe-title">'
    + '<span class="probe-badge">' + tag + '</span>'
    + '<span class="probe-model">' + escapeHtml((row && row.model) || model) + '</span>'
    + '</div>'
    + '<div class="probe-sub">' + escapeHtml(detail) + '</div></div>'
    + '<div class="probe-side"><span class="probe-ms">' + ((row && row.ms) || 0) + ' ms</span></div></div>';
}
function modelTestGapMs() {
  const raw = parseFloat($('ap-test-gap') && $('ap-test-gap').value);
  const sec = Number.isFinite(raw) ? Math.min(60, Math.max(0, raw)) : 1;
  return Math.round(sec * 1000);
}
// 单次测试超时(秒):超时即判定该模型不可用,批量测试会自动继续下一个
function modelTestTimeoutMs() {
  const raw = parseInt($('ap-test-timeout') && $('ap-test-timeout').value, 10);
  const sec = Number.isFinite(raw) ? Math.min(120, Math.max(3, raw)) : 25;
  return sec * 1000;
}
let modelTestAbort = false;
let modelTestBusy = false;
let modelTestPassed = new Set();
// 测试结果全量留存(按模型),用于「有效 / 无效」切换时即时重渲染,不必重跑测试
const MODEL_TEST_ROWS = new Map();
let modelTestTab = 'ok';

function updateKeepPassedAction() {
  const btn = $('ap-keep-passed');
  if (!btn) return;
  const available = !modelTestBusy && modelTestPassed.size > 0;
  btn.classList.toggle('hidden', !available);
  btn.disabled = !available;
}

// 按当前分页(有效/无效)重绘结果列表,并刷新计数与汇总文案
function renderModelTestRows() {
  const out = $('ap-test-result');
  const panel = $('ap-test-panel');
  if (!out || !panel) return;
  const all = Array.from(MODEL_TEST_ROWS.entries());
  const okRows = all.filter(([, r]) => r && r.ok);
  const badRows = all.filter(([, r]) => !(r && r.ok));
  const okCountEl = $('ap-test-ok-count');
  const badCountEl = $('ap-test-bad-count');
  if (okCountEl) okCountEl.textContent = String(okRows.length);
  if (badCountEl) badCountEl.textContent = String(badRows.length);
  panel.classList.toggle('hidden', all.length === 0);
  const shown = modelTestTab === 'ok' ? okRows : badRows;
  out.innerHTML = shown.length
    ? shown.map(([model, row]) => modelProbeRow(model, row)).join('')
    : '<p class="probe-empty">' + (all.length
        ? (modelTestTab === 'ok' ? '没有可用的模型。切到「无效」查看失败原因。' : '全部模型都可用 🎉')
        : '') + '</p>';
  document.querySelectorAll('#ap-test-tabs .probe-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.probeTab === modelTestTab);
  });
  const summary = $('ap-test-summary');
  if (summary) summary.textContent = '测试结果 · 可用 ' + okRows.length + ' / ' + all.length;
}

function resetModelTestResults(clearOutput = true) {
  modelTestPassed.clear();
  MODEL_TEST_ROWS.clear();
  updateKeepPassedAction();
  if (clearOutput) {
    const panel = $('ap-test-panel');
    if (panel) {
      panel.classList.add('hidden');
      panel.open = false;   // 默认折叠:下一轮测试重新展开
    }
    const out = $('ap-test-result');
    if (out) out.innerHTML = '';
  }
}

function keepPassedModels() {
  const ids = apModelList
    ? Array.from(modelTestPassed).filter((id) => apModelList.getCatalog().some((m) => m.id === id))
    : [];
  if (!ids.length) return toast('没有可保留的通过模型', true);
  if (apModelList) apModelList.setEnabledIds(ids);
  refreshModelTestSelect(ids[0]);
  toast('已保留 ' + ids.length + ' 个通过模型，保存后生效');
}

async function requestModelTest(model) {
  const usable = AP_KEYS.filter((k) => String(k.apiKey || '').trim() !== '');
  const pick = usable[0];
  const payload = {
    baseUrl: $('ap-baseurl').value.trim(),
    apiKey: pick && pick.apiKey.indexOf('••') < 0 ? pick.apiKey.trim() : '',
    apiFormat: ($('ap-format') && $('ap-format').getAttribute('data-value')) || 'chat',
    model: model,
    prompt: ($('ap-test-prompt') && $('ap-test-prompt').value.trim()) || '回复一个字：好',
    timeoutSec: Math.round(modelTestTimeoutMs() / 1000),
    providerId: $('ap-save').dataset.editId || undefined,
  };
  const r = await api('/api/admin/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || '测试失败');
  return data.result || { ok: false, model: model, error: '无回复' };
}
function setModelTestBusy(on) {
  modelTestBusy = on;
  updateKeepPassedAction();
  ['ap-test', 'ap-test-all'].forEach((id) => { if ($(id)) $(id).disabled = on; });
  const stop = $('ap-test-stop');
  if (stop) stop.classList.toggle('hidden', !on);
}
(function initModelTest() {
  const box = $('ap-test-model');
  const btn = $('ap-test');
  const allBtn = $('ap-test-all');
  const stopBtn = $('ap-test-stop');
  const keepBtn = $('ap-keep-passed');
  if (keepBtn) keepBtn.addEventListener('click', keepPassedModels);
  if (box) {
    box.addEventListener('click', () => {
      const choices = modelTestChoices();
      if (!choices.length) return toast('请先获取或勾选至少一个模型', true);
      OC.openSelect(box, choices, {
        selected: box.getAttribute('data-value') || '',
        onSelect: (val) => refreshModelTestSelect(val),
      });
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
    });
  }
  const list = $('ap-models-list');
  if (list) list.addEventListener('change', () => {
    resetModelTestResults();
    refreshModelTestSelect();
  });
  if (stopBtn) stopBtn.addEventListener('click', () => { modelTestAbort = true; stopBtn.disabled = true; });
  // 有效 / 无效 切换:只重渲染,不重跑测试
  const tabs = $('ap-test-tabs');
  if (tabs) tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-probe-tab]');
    if (!btn) return;
    e.preventDefault();          // 阻止点到 <summary> 触发折叠
    modelTestTab = btn.dataset.probeTab || 'ok';
    renderModelTestRows();
  });
  if (btn) btn.addEventListener('click', async () => {
    resetModelTestResults();
    const choices = modelTestChoices();
    const model = ($('ap-test-model') && $('ap-test-model').getAttribute('data-value')) || (choices[0] && choices[0].value) || '';
    if (!model) return toast('请先选择要测试的模型', true);
    const status = $('ap-test-status');
    const panel = $('ap-test-panel');
    modelTestAbort = false;
    setModelTestBusy(true);
    if (status) status.textContent = '正在询问 ' + model + '…';
    try {
      const row = await requestModelTest(model);
      MODEL_TEST_ROWS.set(model, row);
      if (row.ok) { modelTestPassed.add(model); updateKeepPassedAction(); }
      // 单个模型测试:结果自然落在对应的分组里,并展开面板让用户看到
      modelTestTab = row.ok ? 'ok' : 'bad';
      if (panel) panel.open = true;
      renderModelTestRows();
      if (status) status.textContent = row.ok ? '模型可用' : (row.timeout ? '超时（已判定不可用）' : '模型不可用');
    } catch (e) {
      if (status) status.textContent = '';
      toast('测试失败: ' + e.message, true);
    } finally {
      if (stopBtn) stopBtn.disabled = false;
      setModelTestBusy(false);
    }
  });
  if (allBtn) allBtn.addEventListener('click', async () => {
    resetModelTestResults();
    const choices = modelTestChoices();
    if (!choices.length) return toast('请先勾选要测试的模型', true);
    const status = $('ap-test-status');
    const panel = $('ap-test-panel');
    const gap = modelTestGapMs();
    const timeoutMs = modelTestTimeoutMs();
    modelTestAbort = false;
    setModelTestBusy(true);
    // 批量测试默认展开结果面板,并在开始时先切到「有效」
    modelTestTab = 'ok';
    if (panel) panel.open = true;
    renderModelTestRows();
    let ok = 0;
    let tested = 0;
    try {
      for (let i = 0; i < choices.length; i++) {
        if (modelTestAbort) break;
        const model = choices[i].value;
        if (status) status.textContent = '正在测试 ' + (i + 1) + ' / ' + choices.length + ' · ' + model;
        let row;
        try {
          row = await requestModelTest(model);
        } catch (e) {
          row = { ok: false, model: model, error: e.message, ms: 0 };
        }
        tested++;
        if (row.ok) ok++;
        // 超时/失败都不中断整批:记录后自动继续下一个模型
        MODEL_TEST_ROWS.set(model, row);
        if (row.ok) modelTestPassed.add(model);
        updateKeepPassedAction();
        renderModelTestRows();
        if (i < choices.length - 1 && gap && !modelTestAbort) {
          if (status) status.textContent = '等待 ' + (gap / 1000) + ' 秒后继续 · ' + (i + 1) + ' / ' + choices.length;
          await new Promise((resolve) => setTimeout(resolve, gap));
        }
      }
      const done = modelTestAbort ? '已停止' : '完成';
      updateKeepPassedAction();
      if (status) {
        const bad = tested - ok;
        status.textContent = done + ' · 可用 ' + ok + ' / ' + tested + (bad ? ('（' + bad + ' 个不可用，可切到「无效」查看原因）') : '')
          + ' · 单次超时 ' + Math.round(timeoutMs / 1000) + ' 秒';
      }
    } finally {
      if (stopBtn) stopBtn.disabled = false;
      setModelTestBusy(false);
    }
  });
})();

$('ap-save').addEventListener('click', async () => {
  const name = $('ap-name').value.trim();
  const baseUrl = $('ap-baseurl').value.trim();
  const apiFormat = $('ap-format').getAttribute('data-value') || 'chat';
  const cost = Number($('ap-cost').value) || 1;
  if (!baseUrl) return toast('请填写 Base URL', true);
  const models = apModelList ? apModelList.getEnabled() : [];
  if (!models.length) return toast('请先获取模型并至少勾选一个', true);
  const keyErr = apKeysValidate();
  if (keyErr) return toast(keyErr, true);
  // 全部行都提交(含未改动、apiKey 为空的):服务端按 id 复用原密文,
  // 只把「既无新明文也非已保存」的空行丢掉。
  const keys = apKeysPayload().filter((k, idx) => {
    if (String(k.apiKey || '').trim() !== '') return true;
    const src = AP_KEYS[idx];
    return !!(src && src.hasKey);   // 已保存过的密钥:保留占位,服务端沿用原密文
  });
  const editId = $('ap-save').dataset.editId;
  if (!keys.length && !editId) return toast('请至少填写一个 API Key', true);
  const url = editId ? '/api/admin/providers/' + editId : '/api/providers';
  const payload = { name, baseUrl, apiFormat, models, keys, costPerCall: cost, billingMode: ($('ap-billing') && $('ap-billing').getAttribute('data-value')) || 'call', pricePer1k: Math.min(1000, Math.max(0, parseFloat($('ap-price') && $('ap-price').value) || 0)), scope: 'global', keyRevealable: !!($('ap-key-keep') && $('ap-key-keep').checked) };
  // 兼容旧字段:取第一把有明文的 Key 作为主 Key;编辑时若一把都没改,不带 apiKey(服务端保留)
  const firstPlain = keys.find((k) => k.apiKey && k.apiKey.indexOf('••') < 0);
  if (firstPlain) payload.apiKey = firstPlain.apiKey;
  else if (!editId) payload.apiKey = (keys[0] && keys[0].apiKey) || '';
  const saveBtn = $('ap-save');
  saveBtn.disabled = true;
  let okSave = false;
  try {
    const r = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { toast((data.error && data.error.message) || '保存失败', true); return; }
    okSave = true;
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || '网络错误'), true);
    return;
  } finally {
    saveBtn.disabled = false;
  }
  if (!okSave) return;
  toast(editId ? '已保存修改' : '全局供应商已添加');
  delete $('ap-save').dataset.editId;
  window.apEditingRevealable = false;
  $('ap-save').textContent = '保存供应商';
  const cancelBtnSave = $('ap-cancel-edit');
  if (cancelBtnSave) cancelBtnSave.classList.add('hidden');
  const noteSave = $('ap-editing-note');
  if (noteSave) noteSave.hidden = true;
  // 恢复表单到「新增」默认态；「保存后保持显示」默认勾选
  $('ap-name').value = ''; $('ap-baseurl').value = '';
  apKeysFromProvider(null);
  resetModelTestResults();
  if (apModelList) { apModelList.setKeys([]); apModelList.reset(); }
  // 计费模式一并回到默认「按次」，避免下次新增供应商继承上次编辑的 token 模式
  if (window.__setApBilling) window.__setApBilling('call');
  if ($('ap-price')) $('ap-price').value = 0;
  if ($('ap-key-keep')) $('ap-key-keep').checked = true;
  loadProviders(); loadStats();
});

// ============ 事件 & 启动 ============
$('back-chat').addEventListener('click', () => location.href = apiUrl('/'));
$('logout-btn').addEventListener('click', () => {
  // 先让服务端吊销会话(审计留痕、token 立即失效),再清本地跳转
  const done = () => {
    localStorage.removeItem('oc_token');
    localStorage.removeItem('oc_user');
    location.href = apiUrl('/login');
  };
  try {
    fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('oc_token') || '') } })
      .catch(() => {})
      .finally(done);
    setTimeout(done, 2000);
  } catch (e) { done(); }
});

// ============ 运行日志 ============
let logKind = '';
async function loadLogs() {
  const r = await api('/api/admin/logs?limit=200');
  const data = await r.json();
  const tbody = $('logs-tbody');
  const empty = $('logs-empty');
  if (!tbody) return;
  tbody.innerHTML = '';
  const logs = (data.logs || []).filter((l) => !logKind || (logKind === 'err' ? (l.status >= 400 || l.error) : l.kind === logKind));
  if (empty) empty.style.display = logs.length ? 'none' : 'block';
  logs.forEach((l) => {
    const tr = document.createElement('tr');
    const status = l.status || 0;
    const hasStatus = typeof l.status === 'number' && l.status > 0;
    const ok = l.error ? false : (hasStatus ? status < 400 : true);
    // 无 HTTP 状态的条目(认证/邮件/管理等)不显示「连接失败」,统一按结果给「成功/失败」
    const statusText = l.error ? '失败' : (hasStatus ? String(status) : (l.status === 0 ? '连接失败' : '成功'));
    const badge = l.kind === 'auth' ? '<span class="log-badge auth">认证</span>'
      : (l.kind === 'parse' ? '<span class="log-badge chat">解析</span>'
      : (l.kind === 'mail' ? '<span class="log-badge auth">邮件</span>'
      : (l.kind === 'admin' ? '<span class="log-badge auth">管理</span>'
      : (status >= 400 || l.error ? '<span class="log-badge err">错误</span>' : '<span class="log-badge chat">对话</span>'))));
    // l.ms 是服务端数值字段;title 属性里不加转义的话,数值一旦变成字符串就成了属性注入入口
    const ms = l.ms !== undefined ? '<span title="' + escapeHtml(String(l.ms)) + 'ms">' + (l.ms >= 1000 ? (l.ms / 1000).toFixed(1) + 's' : l.ms + 'ms') + '</span>' : '-';
    // 信息列:失败原因 / 解析摘要(note) / 认证动作(action)
    const infoMsg = l.error || l.note || l.action || '';
    // 完整内容:提示词 / 模型回复 / 用量 / 来源 IP;点小眼睛展开查看
    const hasDetail = !!(l.prompt || l.reply || l.usage || l.ip);
    let contentCell = '-';
    if (hasDetail) {
      const usage = l.usage && (l.usage.prompt || l.usage.completion)
        ? '用量：输入 ' + (l.usage.prompt || 0) + ' / 输出 ' + (l.usage.completion || 0) + ' tokens'
        : '';
      const detail = [
        l.ip ? '来源 IP：' + l.ip : '',
        l.action ? '动作：' + l.action : '',
        usage,
        l.prompt ? '【提示词】\n' + l.prompt : '',
        l.reply ? '【模型回复】\n' + l.reply : '',
        l.error ? '【错误】\n' + l.error : '',
      ].filter(Boolean).join('\n\n');
      contentCell = '<button class="log-eye" type="button" data-log-eye title="查看完整内容" aria-label="查看完整内容">' + window.OC.icon('eye', 13) + '</button>';
      tr.dataset.detail = detail;
    }
    tr.innerHTML = '<td>' + fmtTime(l.t) + '</td>'
      + '<td>' + escapeHtml(l.userName || '-') + '</td>'
      + '<td>' + badge + '</td>'
      + '<td>' + escapeHtml(l.provider || '-') + '</td>'
      + '<td>' + escapeHtml(l.model || '-') + '</td>'
      + '<td class="log-status ' + (ok ? 'ok' : 'fail') + '">' + statusText + '</td>'
      + '<td>' + ms + '</td>'
      + '<td>' + (l.cost || 0) + '</td>'
      + '<td class="log-msg" title="' + escapeHtml(infoMsg) + '">' + escapeHtml(infoMsg) + '</td>'
      + '<td class="log-content">' + contentCell + '</td>';
    tbody.appendChild(tr);
  });
}
(function bindLogs() {
  const filters = $('log-filters');
  if (!filters) return;
  const tbody = $('logs-tbody');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const eye = e.target.closest ? e.target.closest('[data-log-eye]') : null;
      if (!eye) return;
      const detail = eye.closest('tr') ? eye.closest('tr').dataset.detail : '';
      if (!detail) return;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal modal-lg log-detail-modal" role="dialog" aria-modal="true">'
        + '<div class="modal-header"><h3>日志完整内容</h3>'
        + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + window.OC.icon('close', 16) + '</button></div>'
        + '<div class="modal-body"><pre class="log-detail-pre">' + escapeHtml(detail) + '</pre></div>'
        + '</div>';
      document.body.appendChild(mask);
      if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(mask); else mask.classList.add('show');
      const close = () => { if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(mask); else mask.remove(); setTimeout(() => mask.parentNode && mask.remove(), 360); };
      mask.addEventListener('click', (ev) => { if (ev.target === mask || ev.target.closest('[data-act="close"]')) close(); });
    });
  }
  filters.addEventListener('click', async (e) => {
    const btn = e.target.closest('.log-filter-btn');
    if (!btn) return;
    filters.querySelectorAll('.log-filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
    logKind = btn.dataset.kind || '';
    loadLogs();
  });
  const refresh = $('log-refresh');
  if (refresh) refresh.addEventListener('click', loadLogs);
  const clear = $('log-clear');
  if (clear) clear.addEventListener('click', async () => {
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '清空日志', message: '确认清空全部运行日志？此操作不可恢复。', danger: true, confirmText: '清空' })
      : window.confirm('确认清空全部运行日志?');
    if (!ok) return;
    const rr = await api('/api/admin/logs', { method: 'DELETE' });
    if (rr.ok) { toast('日志已清空'); loadLogs(); } else toast('清空失败', true);
  });
})();

// ============ 用户对话历史查看 ============
let USER_CACHE = [];
async function loadUserOptions() {
  try {
    const r = await api('/api/admin/users');
    const data = await r.json();
    USER_CACHE = data.users || [];
    const select = $('user-chats-select');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">选择用户(输入筛选)</option>'
      + USER_CACHE.map((u) => '<option value="' + u.id + '">' + escapeHtml(u.name) + ' (' + (u.chatCount || 0) + ' 对话)</option>').join('');
    select.value = current || '';
  } catch (e) { /* 静默 */ }
}

async function openUserChats(user) {
  const modal = $('user-chats-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
  $('user-chats-title').textContent = '对话历史 · ' + (user ? user.name : '全部用户');
  $('user-chats-content').innerHTML = '<p class="muted small" style="text-align:center;padding:30px 0">加载中...</p>';
  await loadUserOptions();
  if (user) {
    const select = $('user-chats-select');
    select.value = user.id;
  }
  await loadUserChats(user ? user.id : ($('user-chats-select').value || ''));
}

async function loadUserChats(userId) {
  const content = $('user-chats-content');
  if (!content) return;
  content.innerHTML = '<p class="muted small" style="text-align:center;padding:30px 0">加载中...</p>';
  try {
    const url = '/api/admin/users/chats' + (userId ? '?userId=' + encodeURIComponent(userId) : '');
    const r = await api(url);
    const data = await r.json();
    if (!r.ok) { content.innerHTML = '<p class="muted small">加载失败</p>'; return; }
    const list = (data.usersChats || []).filter((x) => x.chats && x.chats.length);
    if (!list.length) {
      content.innerHTML = '<p class="muted small" style="text-align:center;padding:30px 0">该用户暂无对话记录</p>';
      return;
    }
    let html = '';
    const renderMarkdown = (el, text) => {
      if (window.OCRenderer && OCRenderer.renderInto) {
        try { OCRenderer.renderInto(el, String(text || '')); return; } catch (e) { /* 回退纯文本 */ }
      }
      el.textContent = String(text || '');
    };
    list.forEach((uc) => {
      html += '<div class="section-title" style="margin-top:14px">' + escapeHtml(uc.user.name) + ' · ' + uc.chats.length + ' 个对话</div>';
      uc.chats.forEach((c) => {
        const msgs = (c.messages || []).map((m) => {
          const who = m.role === 'user' ? '用户' : (m.role === 'system' ? '系统' : 'AI');
          const err = m.error ? ' <span class="log-badge err">失败</span>' : '';
          const reasoning = m.reasoning
            ? '<details class="chat-reasoning"><summary>思维链</summary><div class="chat-reasoning-body"></div></details>'
            : '';
          return '<div class="chat-msg ' + (m.role === 'user' ? 'u' : 'a') + '"><span class="chat-msg-who">' + who + err + '</span>'
            + reasoning
            + '<div class="chat-msg-text md-prose" data-md></div></div>';
        }).join('');
        const expanded = msgs ? '<div class="chat-detail"><div class="chat-detail-msgs">' + msgs + '</div></div>' : '';
        html += '<details class="chat-history-item">'
          + '<summary><span class="chat-h-title">' + escapeHtml(c.title) + '</span>'
          + '<span class="chat-h-meta">' + c.messages.length + ' 条 · ' + fmtTime(c.updatedAt) + '</span></summary>'
          + expanded + '</details>';
      });
    });
    content.innerHTML = html;
    // 逐条渲染 Markdown / 代码 / 公式 / 图片(与前台一致),并在有思维链时填入推理内容
    let mi = 0;
    list.forEach((uc) => {
      uc.chats.forEach((c) => {
        (c.messages || []).forEach((m) => {
          const root = content.querySelectorAll('[data-md]')[mi++];
          if (!root) return;
          renderMarkdown(root, m.content);
          if (m.reasoning) {
            const rb = root.closest('.chat-msg') ? root.closest('.chat-msg').querySelector('.chat-reasoning-body') : null;
            if (rb) renderMarkdown(rb, m.reasoning);
          }
        });
      });
    });
  } catch (e) {
    content.innerHTML = '<p class="muted small">加载失败:' + escapeHtml(e.message) + '</p>';
  }
}

(function bindUserChatsModal() {
  const modal = $('user-chats-modal');
  if (!modal) return;
  const hide = () => {
    if (window.OCUI) window.OCUI.closeModal(modal);
    else modal.classList.add('hidden');
  };
  const close = $('user-chats-close');
  if (close) close.addEventListener('click', hide);
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
  const select = $('user-chats-select');
  if (select) select.addEventListener('change', () => {
    const v = select.value;
    const u = USER_CACHE.find((x) => x.id === v);
    $('user-chats-title').textContent = '对话历史 · ' + (u ? u.name : '全部用户');
    loadUserChats(v);
  });
  const reload = $('user-chats-reload');
  if (reload) reload.addEventListener('click', () => loadUserChats(select.value));
})();

// ============ 用户搜索 / 筛选 / 表单 ============
(function bindUserAdmin() {
  const input = $('user-search');
  const clearBtn = $('search-clear');
  let timer = null;
  if (input) {
    input.addEventListener('input', () => {
      const kw = input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(() => { loadUsers(kw); if (clearBtn) clearBtn.hidden = !kw; }, 300);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (input) input.value = '';
      clearBtn.hidden = true;
      loadUsers();
    });
  }
  const filters = $('users-filters');
  if (filters) {
    filters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      USER_FILTER = btn.dataset.filter || 'all';
      USER_PAGE = 1; // 切换筛选回到第一页
      filters.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      renderUsers();
    });
  }
  // 用户表分页
  const prevBtn = $('users-page-prev');
  const nextBtn = $('users-page-next');
  if (prevBtn) prevBtn.addEventListener('click', () => { USER_PAGE -= 1; renderUsers(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { USER_PAGE += 1; renderUsers(); });
  const refreshBtn = $('users-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try { await loadUsers(currentUserKw()); } finally { refreshBtn.disabled = false; }
  });
  const createBtn = $('user-create-btn');
  if (createBtn) createBtn.addEventListener('click', () => openUserForm(null));
  const modal = $('user-form-modal');
  const close = () => closeUserForm();
  if ($('user-form-close')) $('user-form-close').addEventListener('click', close);
  if ($('user-form-cancel')) $('user-form-cancel').addEventListener('click', close);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  if ($('user-form-save')) $('user-form-save').addEventListener('click', saveUserForm);
  if ($('uf-pass')) {
    $('uf-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveUserForm(); }
    });
  }
})();

// ============ 助手库（公共） ============
let ASST_CATS = [];
let ASST_ITEMS = [];
let ASST_FILTER = 'all';
let ASST_FORM_ID = null;
let ASST_CAT_EDIT = null;

function asstIsEmoji(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  try { return /\p{Extended_Pictographic}/u.test(t); } catch (e) { return /[^\x00-\x7F]/.test(t); }
}
function asstIcon(name) {
  if (asstIsEmoji(name)) return '<span class="al-emoji" aria-hidden="true">' + escapeHtml(name) + '</span>';
  return window.OC ? window.OC.icon(name || 'bot', 16) : '';
}
function asstCatMark(c) {
  if (!c) return '';
  if (asstIsEmoji(c.icon)) return c.icon;
  return ({
    'ac-present': '🎨', 'ac-academic': '📚', 'ac-code': '💻', 'ac-life': '🌿',
    'ac-write': '✍️', 'ac-study': '🎓', 'ac-as-ai': '🤖', 'ac-as-mind': '🧠',
    'ac-as-social': '💬', 'ac-as-philosophy': '🏛️', 'ac-as-language': '🌐',
    'ac-as-comments': '⭐', 'ac-as-company': '🏢', 'ac-as-tool': '🧰', 'ac-as-games': '🎲',
  })[c.id] || '';
}

function setAsstCatSelect(id) {
  const el = $('asf-cat');
  if (!el) return;
  const cat = ASST_CATS.find((c) => c.id === id) || ASST_CATS[0];
  el.dataset.value = cat ? cat.id : '';
  const label = el.querySelector('.sb-label');
  if (label) label.textContent = cat ? cat.name : '选择分类';
}

function bindAsstCatSelect() {
  const el = $('asf-cat');
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', () => {
    if (!ASST_CATS.length) return toast('请先添加分类', true);
    window.OC.openSelect(el, ASST_CATS.map((c) => ({ value: c.id, label: c.name })), {
      selected: el.dataset.value || '',
      onSelect: (val) => setAsstCatSelect(val),
    });
  });
}

function renderAssistantCats() {
  const el = $('asst-cats');
  if (!el) return;
  const pinned = [];
  const rest = [];
  ASST_CATS.forEach((c) => (c.id === 'ac-present' ? pinned : rest).push(c));
  const tabs = [{ id: 'all', name: '全部', mark: '📚', count: ASST_ITEMS.length }]
    .concat(pinned.concat(rest).map((c) => ({ id: c.id, name: c.name, mark: asstCatMark(c), count: c.count || 0 })));
  el.innerHTML = tabs.map((t) =>
    '<button class="al-cat' + (t.id === ASST_FILTER ? ' active' : '') + '" type="button" role="tab" aria-selected="' + (t.id === ASST_FILTER ? 'true' : 'false') + '" data-cat="' + escapeHtml(t.id) + '">'
    + (t.mark ? '<i>' + escapeHtml(t.mark) + '</i>' : '')
    + '<span>' + escapeHtml(t.name) + '</span>'
    + '<small>' + (t.count || 0) + '</small>'
    + '</button>'
  ).join('');
}

function renderAssistants() {
  const el = $('asst-body');
  if (!el) return;
  const list = ASST_FILTER === 'all' ? ASST_ITEMS : ASST_ITEMS.filter((a) => a.categoryId === ASST_FILTER);
  const countEl = $('asst-count');
  if (countEl) countEl.textContent = ASST_CATS.length + ' 个分类 · ' + ASST_ITEMS.length + ' 个公共助手';
  if (!list.length) {
    el.innerHTML = '<div class="al-empty">暂无助手，先添加分类再添加助手。</div>';
    return;
  }
  const ordered = ASST_CATS.slice().sort((a, b) => (a.id === 'ac-present' ? -1 : b.id === 'ac-present' ? 1 : 0));
  const groups = (ASST_FILTER === 'all' ? ordered : ordered.filter((c) => c.id === ASST_FILTER)).map((c) => ({
    cat: c,
    items: list.filter((a) => a.categoryId === c.id),
  })).filter((g) => g.items.length);
  el.innerHTML = groups.map((g) =>
    '<section class="al-section">'
    + '<header class="al-section-head"><h4>' + (asstCatMark(g.cat) ? '<i>' + escapeHtml(asstCatMark(g.cat)) + '</i>' : '') + escapeHtml(g.cat.name) + '</h4>'
    + '<button type="button" class="btn small" data-act="rename-cat" data-id="' + escapeHtml(g.cat.id) + '">重命名</button>'
    + '<button type="button" class="btn small danger" data-act="del-cat" data-id="' + escapeHtml(g.cat.id) + '">删除分类</button>'
    + '</header>'
    + '<div class="al-grid">' + g.items.map((a) =>
      '<article class="al-card">'
      + '<div class="al-card-ops">'
      + '<button type="button" class="icon-btn al-mini" data-act="edit" data-id="' + escapeHtml(a.id) + '" aria-label="编辑">' + (window.OC ? window.OC.icon('edit', 14) : '编辑') + '</button>'
      + '<button type="button" class="icon-btn al-mini danger" data-act="del" data-id="' + escapeHtml(a.id) + '" aria-label="删除">' + (window.OC ? window.OC.icon('trash', 14) : '删除') + '</button>'
      + '</div>'
      + '<div class="al-card-main static">'
      + '<span class="al-card-icon">' + asstIcon(a.icon) + '</span>'
      + '<span class="al-card-text">'
      + '<span class="al-card-title">' + escapeHtml(a.name) + '</span>'
      + '<span class="al-card-desc">' + escapeHtml(a.desc || '未填写简介') + '</span>'
      + '</span></div></article>'
    ).join('') + '</div></section>'
  ).join('');
}

async function loadAssistants() {
  const r = await api('/api/admin/assistants');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '加载助手库失败', true);
  ASST_CATS = data.categories || [];
  ASST_ITEMS = data.assistants || [];
  if (ASST_FILTER !== 'all' && !ASST_CATS.some((c) => c.id === ASST_FILTER)) ASST_FILTER = 'all';
  renderAssistantCats();
  renderAssistants();
}

function openAsstForm(asst) {
  const modal = $('asst-form-modal');
  if (!modal) return;
  ASST_FORM_ID = asst ? asst.id : null;
  $('asst-form-title').textContent = asst ? '编辑助手' : '添加助手';
  $('asf-name').value = asst ? asst.name : '';
  $('asf-desc').value = asst ? (asst.desc || '') : '';
  if ($('asf-icon')) $('asf-icon').value = asst && asstIsEmoji(asst.icon) ? asst.icon : (asst ? '' : '✨');
  $('asf-prompt').value = asst ? (asst.prompt || '') : '';
  bindAsstCatSelect();
  setAsstCatSelect(asst ? asst.categoryId : (ASST_FILTER !== 'all' ? ASST_FILTER : ''));
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
}

function closeAsstForm() {
  const modal = $('asst-form-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.closeModal(modal);
  else modal.classList.add('hidden');
  ASST_FORM_ID = null;
}

async function saveAsstForm() {
  const name = ($('asf-name').value || '').trim();
  const desc = ($('asf-desc').value || '').trim();
  const prompt = ($('asf-prompt').value || '').trim();
  const iconVal = ($('asf-icon') && $('asf-icon').value || '').trim();
  const categoryId = $('asf-cat') ? $('asf-cat').dataset.value : '';
  if (!name) return toast('请填写名称', true);
  if (!prompt) return toast('请填写系统提示词', true);
  if (!categoryId) return toast('请选择分类', true);
  const url = ASST_FORM_ID ? '/api/admin/assistants/' + encodeURIComponent(ASST_FORM_ID) : '/api/admin/assistants';
  const r = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, desc, prompt, categoryId, icon: iconVal || '✨' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
  const wasEdit = !!ASST_FORM_ID; // closeAsstForm 会清空 ASST_FORM_ID,先记下
  closeAsstForm();
  await loadAssistants();
  toast(wasEdit ? '助手已保存' : '已添加助手');
}

function openAsstCatForm(cat) {
  const modal = $('asst-cat-modal');
  if (!modal) return;
  ASST_CAT_EDIT = cat ? cat.id : null;
  $('asst-cat-title').textContent = cat ? '重命名分类' : '添加分类';
  $('asc-name').value = cat ? cat.name : '';
  if (window.OCUI) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
}
function closeAsstCatForm() {
  const modal = $('asst-cat-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.closeModal(modal);
  else modal.classList.add('hidden');
  ASST_CAT_EDIT = null;
}
async function saveAsstCatForm() {
  const value = ($('asc-name').value || '').trim();
  if (!value) return toast('请填写分类名称', true);
  const editing = ASST_CAT_EDIT;
  const url = editing
    ? '/api/admin/assistants/categories/' + encodeURIComponent(editing)
    : '/api/admin/assistants/categories';
  const r = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: value }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '保存失败', true);
  closeAsstCatForm();
  await loadAssistants();
  if (data.category && !editing) {
    ASST_FILTER = data.category.id;
    renderAssistantCats();
    renderAssistants();
  }
  toast(editing ? '已重命名' : '已添加分类');
}
function addAsstCategory() { openAsstCatForm(null); }
function renameAsstCategory(id) {
  const cat = ASST_CATS.find((c) => c.id === id);
  if (cat) openAsstCatForm(cat);
}

async function deleteAsstCategory(id) {
  const cat = ASST_CATS.find((c) => c.id === id);
  const ok = window.OCUI
    ? await window.OCUI.confirm({ title: '删除分类', message: '仅删除空分类。确认删除「' + ((cat && cat.name) || '分类') + '」？', danger: true, confirmText: '删除' })
    : confirm('确认删除该分类？');
  if (!ok) return;
  const r = await api('/api/admin/assistants/categories/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '删除失败', true);
  if (ASST_FILTER === id) ASST_FILTER = 'all';
  await loadAssistants();
}

async function deleteAsst(id) {
  const a = ASST_ITEMS.find((x) => x.id === id);
  const ok = window.OCUI
    ? await window.OCUI.confirm({ title: '删除助手', message: '确认删除公共助手「' + ((a && a.name) || '助手') + '」？所有用户将看不到它。', danger: true, confirmText: '删除' })
    : confirm('确认删除该公共助手？');
  if (!ok) return;
  const r = await api('/api/admin/assistants/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast((data.error && data.error.message) || '删除失败', true);
  await loadAssistants();
}

(function bindAssistantAdmin() {
  if ($('asst-add-cat')) $('asst-add-cat').addEventListener('click', addAsstCategory);
  if ($('asst-add')) $('asst-add').addEventListener('click', () => openAsstForm(null));
  if ($('asst-form-close')) $('asst-form-close').addEventListener('click', closeAsstForm);
  if ($('asst-form-cancel')) $('asst-form-cancel').addEventListener('click', closeAsstForm);
  if ($('asst-form-save')) $('asst-form-save').addEventListener('click', saveAsstForm);
  if ($('asst-cat-close')) $('asst-cat-close').addEventListener('click', closeAsstCatForm);
  if ($('asst-cat-cancel')) $('asst-cat-cancel').addEventListener('click', closeAsstCatForm);
  if ($('asst-cat-save')) $('asst-cat-save').addEventListener('click', saveAsstCatForm);
  if ($('asc-name')) {
    $('asc-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveAsstCatForm(); }
    });
  }
  const modal = $('asst-form-modal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeAsstForm(); });
  const catModal = $('asst-cat-modal');
  if (catModal) catModal.addEventListener('click', (e) => { if (e.target === catModal) closeAsstCatForm(); });
  if ($('asst-cats')) {
    $('asst-cats').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-cat]');
      if (!tab) return;
      ASST_FILTER = tab.dataset.cat;
      renderAssistantCats();
      renderAssistants();
    });
  }
  if ($('asst-body')) {
    $('asst-body').addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const act = actEl.dataset.act;
      const id = actEl.dataset.id;
      if (act === 'edit') return openAsstForm(ASST_ITEMS.find((a) => a.id === id));
      if (act === 'del') return deleteAsst(id);
      if (act === 'rename-cat') return renameAsstCategory(id);
      if (act === 'del-cat') return deleteAsstCategory(id);
    });
  }
})();

// ===== 邮件模板编辑器状态 =====
const MAIL_TPL = { active: 'verify', siteName: 'TinyChat', tpl: { verify: { subject: '', html: '' }, reset: { subject: '', html: '' } } };
function mailTplRenderPreview() {
  const frame = $('mtpl-preview'); if (!frame) return;
  const t = MAIL_TPL.tpl[MAIL_TPL.active] || { subject: '', html: '' };
  const sample = { '{siteName}': MAIL_TPL.siteName || 'TinyChat', '{name}': '示例用户', '{link}': location.origin + '/login?verify=sample-token', '{expires}': MAIL_TPL.active === 'reset' ? '1 小时' : '24 小时' };
  let html = String(t.html || '');
  Object.keys(sample).forEach((k) => { html = html.split(k).join(sample[k]); });
  frame.srcdoc = html;
}
function mailTplSyncInputs() {
  const t = MAIL_TPL.tpl[MAIL_TPL.active] || { subject: '', html: '' };
  const s = $('mtpl-subject'), h = $('mtpl-html');
  if (s) s.value = t.subject || '';
  if (h) h.value = t.html || '';
  mailTplRenderPreview();
}
function mailTplBind() {
  const subj = $('mtpl-subject'), body = $('mtpl-html');
  let timer = 0;
  const onEdit = () => {
    const t = MAIL_TPL.tpl[MAIL_TPL.active]; if (!t) return;
    if (subj) t.subject = subj.value;
    if (body) t.html = body.value;
    clearTimeout(timer); timer = setTimeout(mailTplRenderPreview, 250);
  };
  if (subj) subj.addEventListener('input', onEdit);
  if (body) body.addEventListener('input', onEdit);
  const tabs = $('mtpl-tabs');
  if (tabs) tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mtpl]'); if (!btn) return;
    MAIL_TPL.active = btn.dataset.mtpl === 'reset' ? 'reset' : 'verify';
    tabs.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    mailTplSyncInputs();
  });
  const defBtn = $('mtpl-defaults');
  if (defBtn) defBtn.addEventListener('click', async () => {
    const r = await api('/api/admin/settings/mail-template-defaults');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.templates) return toast((d.error && d.error.message) || '获取默认模板失败', true);
    MAIL_TPL.tpl.verify = { subject: d.templates.verifySubject || '', html: d.templates.verifyHtml || '' };
    MAIL_TPL.tpl.reset = { subject: d.templates.resetSubject || '', html: d.templates.resetHtml || '' };
    mailTplSyncInputs();
    toast('已恢复默认模板，记得点「保存验证设置」生效');
  });
  const testBtn = $('smtp-test-btn');
  if (testBtn) testBtn.addEventListener('click', async () => {
    const box = $('smtp-test-result');
    const showResult = (html, isErr) => {
      if (!box) return;
      box.className = 'smtp-test-result' + (isErr ? ' is-err' : ' is-ok');
      box.innerHTML = html;
    };
    testBtn.disabled = true; const old = testBtn.textContent; testBtn.textContent = '发送中…';
    if (box) box.className = 'smtp-test-result hidden';
    try {
      const r = await api('/api/admin/settings/test-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ($('smtp-test-to') || {}).value || '' }) });
      // 容错解析:服务端 500 时可能返回 HTML 错误页,直接 r.json() 会退化成笼统的「发送失败」
      const d = await readJsonSafe(r);
      const detail = (d.error && d.error.message) || '';
      if (!r.ok) {
        toast('测试邮件发送失败', true);
        showResult('<b>发送失败</b><br>' + escapeHtml(detail || ('服务器返回 HTTP ' + r.status + '，未提供更多信息')), true);
      } else {
        toast('测试邮件已发送到 ' + (d.to || '你的邮箱') + '，请查收');
        showResult('<b>发送成功</b><br>已投递到 ' + escapeHtml(d.to || '你的邮箱') + '。若未收到，请检查收件箱的垃圾邮件/广告邮件分类，并确认收件服务器没有延迟。', false);
      }
    } catch (e) {
      toast('发送失败，请检查网络', true);
      showResult('<b>发送失败</b><br>' + escapeHtml((e && e.message) || '网络错误，请求未能送达服务器'), true);
    }
    finally { testBtn.disabled = false; testBtn.textContent = old; }
  });

  // SMTP 密码:小眼睛切换明文/掩码。未勾选「保存后保持显示」时只显示掩码,点击取回明文会被拒绝
  const passToggle = $('smtp-pass-toggle');
  const passInput = $('smtp-pass');
  if (passToggle && passInput) {
    if (window.OC && window.OC.icon) passToggle.innerHTML = OC.icon('eye', 14);
    const syncEye = () => { passToggle.title = passInput.type === 'text' ? '隐藏密码' : '显示密码'; };
    syncEye();
    passToggle.addEventListener('click', async () => {
      if (passInput.type === 'text') { passInput.type = 'password'; syncEye(); return; }
      // 输入框里已是服务端下发的明文(勾选了保持显示)时直接切类型即可
      const val = passInput.value || '';
      if (val && val.indexOf('••') < 0) { passInput.type = 'text'; syncEye(); return; }
      passToggle.disabled = true;
      try {
        const r = await api('/api/admin/settings/smtp-reveal', { method: 'POST' });
        const d = await readJsonSafe(r);
        if (!r.ok) {
          toast((d.error && d.error.message) || '无法查看密码', true);
          return;
        }
        passInput.value = d.password || '';
        passInput.type = 'text';
        syncEye();
        toast('已显示密码，可复制');
      } catch (e) {
        toast('无法查看密码：' + ((e && e.message) || '网络错误'), true);
      } finally {
        passToggle.disabled = false;
      }
    });
  }
}

let VERIFY_LOADED = false; // 「验证设置」表单是否已从服务端加载成功;未加载时禁止保存,防止把 HTML 默认值写回
async function loadVerifySettings() {
  VERIFY_LOADED = false;
  let d;
  try {
    const r = await api('/api/admin/settings');
    d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
  } catch (e) {
    toast('验证设置加载失败：' + (e.message || '网络错误') + '，为防覆盖未加载保存已禁用', true);
    return;
  }
  VERIFY_LOADED = true;
  const s = d.settings || {}; const set = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
  ['verify-email-enabled','verify-reset-enabled','verify-quota-unlimited'].forEach((id, i) => { const e=$(id); if(e) e.checked=!![s.emailVerificationEnabled,s.passwordResetEnabled,s.freeQuotaUnlimited][i]; });
  set('verify-free-quota', s.freeQuota); const smtp=s.smtp||{}; set('smtp-host',smtp.host); set('smtp-port',smtp.port||587); set('smtp-user',smtp.username); set('smtp-pass',smtp.password); set('smtp-encryption',smtp.encryption||'tls'); set('smtp-from-name',smtp.fromName||'TinyChat'); set('smtp-from-email',smtp.fromEmail);
  // 「SMTP 密码保存后保持显示」:勾选后服务端直接下发明文,取消勾选则只给掩码
  if ($('smtp-pass-keep')) $('smtp-pass-keep').checked = !!s.smtpKeyRevealable;
  if ($('smtp-pass')) $('smtp-pass').type = 'password';
  if ($('smtp-pass-toggle')) $('smtp-pass-toggle').disabled = false;
  set('session-days', s.sessionDays || 7);
  if ($('apikeys-enabled')) $('apikeys-enabled').checked = s.apiKeysEnabled !== false;
  if ($('invite-required')) $('invite-required').checked = !!s.registerInviteRequired;
  if ($('guest-enabled')) $('guest-enabled').checked = !!s.guestEnabled;
  set('guest-rounds', s.guestRounds || 3);
  // 注册与账号安全(allowRegister 后端强制:关掉后注册接口 403)
  if ($('register-open')) $('register-open').checked = s.allowRegister !== false;
  set('register-limit', s.registerLimitPerHour || 5);
  if ($('user-providers-allowed')) $('user-providers-allowed').checked = s.allowUserProviders !== false;
  set('account-deletion-mode', s.accountDeletionMode || 'soft');
  set('login-max-fails', s.loginMaxFails != null ? s.loginMaxFails : 5);
  set('login-lock-sec', s.loginLockMs != null ? Math.round(s.loginLockMs / 1000) : 60);
  const tpl = s.mailTemplates || {};
  MAIL_TPL.siteName = s.siteName || 'TinyChat';
  MAIL_TPL.tpl.verify = { subject: tpl.verifySubject || '', html: tpl.verifyHtml || '' };
  MAIL_TPL.tpl.reset = { subject: tpl.resetSubject || '', html: tpl.resetHtml || '' };
  MAIL_TPL.loaded = true;
  mailTplBind();
  mailTplSyncInputs();
  loadInvites();
}
async function loadInvites() {
  try {
    const r = await api('/api/admin/invites');
    const d = await r.json();
    if (!r.ok) return toast((d.error && d.error.message) || '邀请码加载失败', true);
    if ($('invite-required')) $('invite-required').checked = !!d.required;
    const codes = d.codes || [];
    const usable = codes.filter((c) => c.usable).length;
    if ($('invite-count-info')) $('invite-count-info').textContent = '可用 ' + usable + ' / 共 ' + codes.length + ' 张';
    const tb = $('invite-tbody');
    if (!tb) return;
    tb.innerHTML = codes.map((c) => {
      const max = typeof c.maxUses === 'number' ? c.maxUses : 1;
      const used = typeof c.usedCount === 'number' ? c.usedCount : (c.usedBy ? 1 : 0);
      const limit = max < 0 ? '不限' : String(max);
      const status = c.usable
        ? '<b>可用</b>'
        : '<span class="muted">已用完</span>';
      const usage = used + ' / ' + limit
        + (c.usedByName ? '<div class="muted small">最后：' + escapeHtml(c.usedByName) + '</div>' : '');
      return '<tr><td><code>' + escapeHtml(c.code) + '</code></td><td>' + status + '</td><td class="muted small">' + usage + '</td>'
        + '<td style="text-align:right"><button class="btn small danger" data-del-invite="' + escapeHtml(c.code) + '" type="button">删除</button></td></tr>';
    }).join('');
    if ($('invite-empty')) $('invite-empty').style.display = codes.length ? 'none' : 'block';
    tb.querySelectorAll('[data-del-invite]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = window.OCUI
          ? await window.OCUI.confirm({ title: '删除邀请码', message: '确认删除邀请码「' + btn.dataset.delInvite + '」？已注册的账号不受影响。', danger: true, confirmText: '删除' })
          : confirm('确认删除邀请码 ' + btn.dataset.delInvite + '?');
        if (!ok) return;
        btn.disabled = true;
        try {
          const r = await api('/api/admin/invites/' + encodeURIComponent(btn.dataset.delInvite), { method: 'DELETE' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) { toast((d.error && d.error.message) || '删除失败', true); btn.disabled = false; return; }
          toast('邀请码已删除');
          loadInvites();
        } catch (e) {
          btn.disabled = false;
          toast('删除失败：' + ((e && e.message) || '网络错误'), true);
        }
      });
    });
  } catch (e) { toast('邀请码加载失败: ' + e.message, true); }
}
(function initInvites() {
  const gen = $('invite-generate');
  if (!gen) return;
  gen.addEventListener('click', async () => {
    gen.disabled = true;
    try {
      const count = Math.min(50, Math.max(1, parseInt($('invite-count') && $('invite-count').value, 10) || 5));
      const rawMax = parseInt($('invite-max-uses') && $('invite-max-uses').value, 10);
      const maxUses = Number.isFinite(rawMax) && rawMax < 0 ? -1 : Math.min(10000, Math.max(1, rawMax || 1));
      const prefix = (($('invite-prefix') && $('invite-prefix').value) || '').trim();
      const r = await api('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, maxUses, prefix }),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '生成失败', true);
      toast('已生成 ' + (d.created || []).length + ' 个邀请码');
      loadInvites();
    } catch (e) {
      toast('生成失败: ' + e.message, true);
    } finally { gen.disabled = false; }
  });
  // 「注册需要邀请码」属于验证设置,改动后随验证设置一并保存
  const req = $('invite-required');
  if (req) req.addEventListener('change', () => { const sv = $('verify-save'); if (sv) sv.click(); });
})();

// ============ 开放 API(OpenAI 兼容出口)设置 ============
let OPENAPI_MODELS = [];   // [{providerId, providerName, models:[{id,name}]}]
async function loadOpenApi() {
  const [rs, rp] = await Promise.all([api('/api/admin/settings'), api('/api/providers')]);
  const ds = await rs.json();
  const dp = await rp.json();
  if (!rs.ok) return toast((ds.error && ds.error.message) || '加载失败', true);
  const s = ds.settings || {};
  if ($('apikeys-enabled')) $('apikeys-enabled').checked = s.apiKeysEnabled !== false;
  if ($('openapi-key-limit')) $('openapi-key-limit').value = s.apiKeyRateLimitPerMin == null ? 60 : s.apiKeyRateLimitPerMin;
  if ($('openapi-user-limit-hint')) $('openapi-user-limit-hint').textContent = (s.rateLimitPerMin == null ? 30 : s.rateLimitPerMin) + ' 次/分钟';
  const exposed = new Set(Array.isArray(s.apiExposedModels) ? s.apiExposedModels : []);
  if ($('openapi-restrict')) $('openapi-restrict').checked = exposed.size > 0;
  OPENAPI_MODELS = (dp.providers || [])
    .filter((p) => p.scope === 'global' && p.enabled !== false && Array.isArray(p.models) && p.models.length)
    .map((p) => ({ providerId: p.id, providerName: p.name, models: p.models }));
  renderOpenApiModels(exposed);
}
function renderOpenApiModels(exposed) {
  const box = $('openapi-models');
  if (!box) return;
  const restrict = !!($('openapi-restrict') && $('openapi-restrict').checked);
  if (!OPENAPI_MODELS.length) {
    box.innerHTML = '<p class="muted small">暂无可用的全局供应商模型，请先在「供应商」中添加。</p>';
  } else {
    box.innerHTML = OPENAPI_MODELS.map((g) => {
      const items = g.models.map((m) => {
        const key = g.providerId + '|' + m.id;
        const on = !restrict || exposed.has(key);
        return '<label class="access-model' + (restrict ? '' : ' disabled') + '">'
          + '<input type="checkbox" data-expose="' + escapeHtml(key) + '"' + (on ? ' checked' : '') + (restrict ? '' : ' disabled') + '>'
          + escapeHtml(m.name || m.id) + '</label>';
      }).join('');
      return '<div class="access-row"><div class="access-prov">' + escapeHtml(g.providerName) + '</div>'
        + '<div class="access-models">' + items + '</div></div>';
    }).join('');
  }
  updateOpenApiCount();
}
function updateOpenApiCount() {
  const el = $('openapi-model-count');
  if (!el) return;
  const restrict = !!($('openapi-restrict') && $('openapi-restrict').checked);
  if (!restrict) { el.textContent = '当前：全部模型可用'; return; }
  const total = OPENAPI_MODELS.reduce((n, g) => n + g.models.length, 0);
  const picked = document.querySelectorAll('#openapi-models [data-expose]:checked').length;
  el.textContent = '已选 ' + picked + ' / ' + total + ' 个模型';
}
(function initOpenApi() {
  const box = $('openapi-models');
  if (!box) return;
  $('openapi-restrict')?.addEventListener('change', () => { renderOpenApiModels(new Set()); });
  box.addEventListener('change', (e) => { if (e.target.closest('[data-expose]')) updateOpenApiCount(); });
  $('openapi-select-all')?.addEventListener('click', () => {
    box.querySelectorAll('[data-expose]').forEach((c) => { c.checked = true; });
    updateOpenApiCount();
  });
  $('openapi-select-none')?.addEventListener('click', () => {
    box.querySelectorAll('[data-expose]').forEach((c) => { c.checked = false; });
    updateOpenApiCount();
  });
  $('openapi-fetch')?.addEventListener('click', async () => {
    const btn = $('openapi-fetch');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '获取中…';
    try {
      const r = await api('/api/providers?refresh=1');
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || '获取失败');
      OPENAPI_MODELS = (d.providers || [])
        .filter((p) => p.scope === 'global' && p.enabled !== false && Array.isArray(p.models) && p.models.length)
        .map((p) => ({ providerId: p.id, providerName: p.name, models: p.models }));
      renderOpenApiModels(new Set());
      toast('已刷新模型列表');
    } catch (e) {
      toast('获取失败: ' + e.message, true);
    } finally { btn.disabled = false; btn.textContent = old; }
  });
  $('openapi-save')?.addEventListener('click', async () => {
    const btn = $('openapi-save');
    btn.disabled = true;
    try {
      const restrict = !!($('openapi-restrict') && $('openapi-restrict').checked);
      const list = restrict
        ? Array.from(box.querySelectorAll('[data-expose]:checked')).map((c) => c.dataset.expose)
        : [];
      const payload = {
        apiKeysEnabled: !!($('apikeys-enabled') && $('apikeys-enabled').checked),
        apiKeyRateLimitPerMin: Math.min(600, Math.max(0, parseInt($('openapi-key-limit') && $('openapi-key-limit').value, 10) || 0)),
        apiExposedModels: list,
      };
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      toast('开放 API 设置已保存');
      loadOpenApi();
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally { btn.disabled = false; }
  });
})();
let CODES_CACHE = [];
const CODES_PAGE_SIZE = 20;
let CODES_PAGE = 1;
function filteredCodes() {
  const q = ($('codes-search') && $('codes-search').value || '').trim().toLowerCase();
  return CODES_CACHE.filter((c) => !q
    || (c.packageName || '').toLowerCase().includes(q)
    || (c.status || '').toLowerCase().includes(q)
    || (c.codeMask || '').toLowerCase().includes(q));
}
function renderCodesList() {
  const list = $('codes-list'); if (!list) return;
  const rows = filteredCodes();
  const used = CODES_CACHE.filter((c) => c.status === 'used').length;
  const summary = $('codes-summary');
  if (summary) summary.textContent = '共 ' + CODES_CACHE.length + ' 张，已使用 ' + used + ' 张，未使用 ' + (CODES_CACHE.length - used) + ' 张';
  const pages = Math.max(1, Math.ceil(rows.length / CODES_PAGE_SIZE));
  if (CODES_PAGE > pages) CODES_PAGE = pages;
  const pageRows = rows.slice((CODES_PAGE - 1) * CODES_PAGE_SIZE, CODES_PAGE * CODES_PAGE_SIZE);
  const pager = $('codes-pager');
  if (pager) {
    pager.classList.toggle('hidden', pages <= 1);
    const label = $('codes-page-label');
    if (label) label.textContent = '第 ' + CODES_PAGE + ' / ' + pages + ' 页 · 共 ' + rows.length + ' 条';
    const prev = $('codes-prev'), next = $('codes-next');
    if (prev) prev.disabled = CODES_PAGE <= 1;
    if (next) next.disabled = CODES_PAGE >= pages;
  }
  if (!pageRows.length) { list.innerHTML = '<span class="muted small">' + (CODES_CACHE.length ? '没有匹配的兑换码' : '还没有生成过兑换码') + '</span>'; return; }
  list.innerHTML = pageRows.map((c) => {
    const isFixed = c.type === 'fixed';
    const expired = isFixed && c.expiresAt && Date.now() > c.expiresAt;
    const remain = isFixed ? Math.max(0, (c.maxRedemptions || 1) - (c.usedCount || 0)) : 0;
    const statusTxt = !isFixed ? (c.status === 'used' ? '已使用' : '未使用')
      : (c.status === 'used' ? '已用完' : (expired ? '已过期' : '剩 ' + remain + ' 次'));
    const info = isFixed
      ? ' · 每次兑 +' + (c.quota === -1 ? '无限' : c.quota) + ' 次 · 已兑 ' + (c.usedCount || 0) + '/' + (c.maxRedemptions || 1)
        + ' · ' + (c.expiresAt ? '有效期至 ' + fmtTime(c.expiresAt) : '长期有效')
        + (c.perUserLimit ? ' · 每人限兑一次' : '')
      : '';
    return '<div class="row-between" data-code="' + escapeHtml(c.id) + '">'
      + '<span><code>' + escapeHtml(c.codeMask || '') + '</code> · ' + escapeHtml(c.packageName || '')
      + '<span class="muted small"> 生成于 ' + (c.createdAt ? fmtTime(c.createdAt) : '-') + info
      + (c.status === 'used' && !isFixed ? ' · 使用于 ' + (c.usedAt ? fmtTime(c.usedAt) : '-') + (c.usedByName ? ' · 使用者 ' + escapeHtml(c.usedByName) : '') : '')
      + (isFixed && (c.usedCount || 0) > 0 && c.usedAt ? ' · 最近使用 ' + fmtTime(c.usedAt) + (c.usedByName ? ' · ' + escapeHtml(c.usedByName) : '') : '')
      + '</span></span>'
      + '<span class="row-between" style="gap:8px"><span class="' + ((c.status === 'used' || expired) ? 'muted' : '') + '">' + statusTxt + '</span>'
      + '<button class="btn small danger" data-delcode type="button">删除</button></span>'
      + '</div>';
  }).join('');
  list.querySelectorAll('[data-delcode]').forEach((btn) => btn.addEventListener('click', async () => {
    const row = btn.closest('[data-code]'); const id = row && row.dataset.code;
    const c = CODES_CACHE.find((x) => x.id === id); if (!c) return;
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '删除兑换码', message: '确认删除这张「' + c.packageName + '」的兑换码？删除后无法兑换。', danger: true, confirmText: '删除' })
      : confirm('确认删除该兑换码？删除后无法兑换。');
    if (!ok) return;
    const r = await api('/api/admin/codes/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) return toast('删除失败', true);
    toast('已删除'); loadPackages();
  }));
}

let PKG_EDITING_ID = '';
let PKG_CACHE = [];

function pkgPriceLabel(p) {
  if (p.price !== null && p.price !== undefined && p.price !== '') return (parseFloat(p.price) === 0) ? '免费' : '¥' + p.price;
  return p.priceLabel || '';
}

function renderPackageCards() {
  const list = $('pkg-list'); if (!list) return;
  if (!PKG_CACHE.length) { list.innerHTML = '<p class="muted small">还没有套餐，用上方表单创建第一个套餐。</p>'; return; }
  list.innerHTML = PKG_CACHE.map((p) => {
    const priceTxt = pkgPriceLabel(p);
    const free = p.price !== null && p.price !== undefined && parseFloat(p.price) === 0;
    const validity = (p.validityDays && p.validityDays > 0) ? p.validityDays + ' 天有效' : '永久有效';
    const quotaTxt = p.quota === -1 ? '无限次' : p.quota + ' 次';
    const limit = (p.limitPerUser != null) ? parseInt(p.limitPerUser, 10) : 1;
    const limitTxt = free ? (limit === -1 ? '不限次领取' : (limit === 0 ? '暂不可领取' : '每人限领 ' + limit + ' 次')) : '';
    return '<div class="pkg-card' + (p.enabled ? '' : ' pkg-card-off') + '" data-id="' + escapeHtml(p.id) + '">'
      + '<div class="pkg-card-top"><span class="pkg-card-name">' + escapeHtml(p.name) + '</span>'
      + (free ? '<span class="pkg-tag pkg-tag-free">0 元领取</span>' : (priceTxt ? '<span class="pkg-tag">' + escapeHtml(priceTxt) + '</span>' : ''))
      + (limitTxt ? '<span class="pkg-tag">' + escapeHtml(limitTxt) + '</span>' : '')
      + (!p.enabled ? '<span class="pkg-tag pkg-tag-off">已停用</span>' : '')
      + (PKG_EDITING_ID === p.id ? '<span class="pkg-tag pkg-tag-edit">编辑中</span>' : '') + '</div>'
      + '<div class="pkg-card-stats"><span><b>' + escapeHtml(quotaTxt) + '</b><i>对话次数</i></span><span><b>' + escapeHtml(validity) + '</b><i>有效期</i></span><span><b>' + (priceTxt ? escapeHtml(priceTxt) : '—') + '</b><i>价格</i></span></div>'
      + (p.description ? '<p class="pkg-card-desc">' + escapeHtml(p.description) + '</p>' : '')
      + (p.purchaseUrl ? '<p class="pkg-card-url muted small">购买链接：' + escapeHtml(p.purchaseUrl) + '</p>' : '')
      + '<div class="pkg-card-actions">'
      + '<button class="btn small" data-pkg-edit type="button">编辑</button>'
      + '<button class="btn small" data-pkg-codes type="button">生成兑换码</button>'
      + '<button class="btn small danger" data-pkg-del type="button">删除</button>'
      + '</div></div>';
  }).join('');
  list.querySelectorAll('[data-pkg-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const card = btn.closest('[data-id]'); const p = PKG_CACHE.find((x) => x.id === card.dataset.id); if (!p) return;
    PKG_EDITING_ID = p.id;
    $('pkg-name').value = p.name || '';
    $('pkg-quota').value = p.quota;
    $('pkg-validity').value = p.validityDays || 0;
    $('pkg-limit').value = (p.limitPerUser != null) ? p.limitPerUser : 1;
    $('pkg-price').value = (p.price !== null && p.price !== undefined) ? p.price : '';
    $('pkg-url').value = p.purchaseUrl || '';
    $('pkg-desc').value = p.description || '';
    const cancel = $('pkg-cancel-edit'); if (cancel) cancel.hidden = false;
    renderPackageCards();
    $('pkg-name').focus();
  }));
  list.querySelectorAll('[data-pkg-del]').forEach((btn) => btn.addEventListener('click', async () => {
    const card = btn.closest('[data-id]'); const p = PKG_CACHE.find((x) => x.id === card.dataset.id); if (!p) return;
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '删除套餐', message: '确认删除套餐「' + p.name + '」？已生成的兑换码将无法再兑换。', danger: true, confirmText: '删除' })
      : confirm('确认删除套餐「' + p.name + '」？');
    if (!ok) return;
    const r = await api('/api/admin/packages/' + encodeURIComponent(p.id), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '删除失败', true);
    if (PKG_EDITING_ID === p.id) { PKG_EDITING_ID = ''; const cancel = $('pkg-cancel-edit'); if (cancel) cancel.hidden = true; }
    toast('套餐已删除'); loadPackages();
  }));
  list.querySelectorAll('[data-pkg-codes]').forEach((btn) => btn.addEventListener('click', () => {
    const card = btn.closest('[data-id]');
    const sel = $('pkg-code-package'); if (sel) sel.value = card.dataset.id;
    const count = $('pkg-code-count'); if (count) { count.focus(); count.select(); }
    toast('已在下方兑换码面板选中该套餐，设置数量后点「生成兑换码」');
  }));
}

async function loadPackages() {
  const r=await api('/api/admin/packages'); const d=await r.json(); if(!r.ok)return; const list=$('pkg-list'), sel=$('pkg-code-package'), bulk=$('codes-bulk-package');
  PKG_CACHE = d.packages || [];
  const opts=PKG_CACHE.map(p=>'<option value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+'</option>').join('');
  if(sel) sel.innerHTML=opts;
  if(bulk) bulk.innerHTML=opts;
  // 这两个下拉已换成自定义控件:重建 option 后要把显示文字同步过来,否则标签会停在旧值
  [$('pkg-code-package-box'), $('codes-bulk-package-box')].forEach((b) => { if (b && typeof b.syncLabel === 'function') b.syncLabel(); });
  if (list) renderPackageCards();
  CODES_CACHE = (d.codes || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  renderCodesList();
}
(function initCodesPanel(){
  const search = $('codes-search');
  if (search) search.addEventListener('input', () => { CODES_PAGE = 1; renderCodesList(); });
  const prev = $('codes-prev'); if (prev) prev.addEventListener('click', () => { CODES_PAGE--; renderCodesList(); });
  const next = $('codes-next'); if (next) next.addEventListener('click', () => { CODES_PAGE++; renderCodesList(); });
  const prune = $('codes-prune');
  if (prune) prune.addEventListener('click', async () => {
    const usedCount = CODES_CACHE.filter((c) => c.status === 'used').length;
    if (!usedCount) return toast('没有已使用的兑换码');
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '清理已使用', message: '确认删除全部 ' + usedCount + ' 张已使用的兑换码记录？未使用的兑换码不受影响。', danger: true, confirmText: '清理' })
      : confirm('确认删除全部 ' + usedCount + ' 张已使用的兑换码记录？');
    if (!ok) return;
    const r = await api('/api/admin/codes/prune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'used' }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '清理失败', true);
    toast('已清理 ' + (d.removed || 0) + ' 张'); loadPackages();
  });
  // 按套餐批量导出未使用兑换码明文
  const exp = $('codes-export-unused');
  if (exp) exp.addEventListener('click', async () => {
    const bulkSel = $('codes-bulk-package'); const pid = bulkSel && bulkSel.value;
    if (!pid) return toast('请先选择套餐', true);
    const r = await api('/api/admin/packages/' + encodeURIComponent(pid) + '/codes/export');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '导出失败', true);
    const codes = (d.codes || []).map((x) => x.code);
    if (!codes.length) return toast('该套餐没有可导出的未使用兑换码' + (d.missing ? '（另有 ' + d.missing + ' 张旧码未存明文）' : ''), true);
    const blob = new Blob([codes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '兑换码-' + (d.packageName || pid) + '-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出 ' + codes.length + ' 张' + (d.missing ? '（另有 ' + d.missing + ' 张旧码未存明文）' : ''));
  });
  // 按套餐批量清除未使用兑换码
  const clr = $('codes-clear-unused');
  if (clr) clr.addEventListener('click', async () => {
    const bulkSel = $('codes-bulk-package'); const pid = bulkSel && bulkSel.value;
    if (!pid) return toast('请先选择套餐', true);
    const pkgName = (bulkSel.selectedOptions && bulkSel.selectedOptions[0]) ? bulkSel.selectedOptions[0].textContent : pid;
    const n = CODES_CACHE.filter((c) => c.packageId === pid && c.status !== 'used').length;
    if (!n) return toast('该套餐没有未使用的兑换码');
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '清除未使用兑换码', message: '确认删除「' + pkgName + '」全部 ' + n + ' 张未使用的兑换码？删除后无法兑换，已使用的不受影响。', danger: true, confirmText: '清除' })
      : confirm('确认删除「' + pkgName + '」全部 ' + n + ' 张未使用的兑换码？');
    if (!ok) return;
    const r = await api('/api/admin/codes/prune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'unused', packageId: pid }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '清除失败', true);
    toast('已清除 ' + (d.removed || 0) + ' 张'); loadPackages();
  });
  // 添加固定兑换码
  const fa = $('fixed-code-add');
  if (fa) fa.addEventListener('click', async () => {
    const code = ($('fixed-code-value').value || '').trim();
    if (!code) return toast('请输入兑换码', true);
    const quotaRaw = parseInt($('fixed-code-quota').value, 10);
    if (isNaN(quotaRaw) || (quotaRaw !== -1 && quotaRaw < 1)) return toast('可用次数需大于 0，或填 -1 表示无限', true);
    const body = { code: code, quota: quotaRaw, maxRedemptions: parseInt($('fixed-code-max').value, 10) || 1, perUserLimit: !!(($('fixed-code-peruser') || {}).checked) };
    const expiryVal = ($('fixed-code-expiry').value || '').trim();
    if (expiryVal) {
      const t = new Date(expiryVal).getTime();
      if (!isFinite(t)) return toast('有效期格式不正确', true);
      if (t <= Date.now()) return toast('有效期必须晚于当前时间', true);
      body.expiresAt = t;
    }
    const r = await api('/api/admin/codes/fixed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast((d.error && d.error.message) || '添加失败', true);
    toast('固定兑换码已添加'); $('fixed-code-value').value = ''; loadPackages();
  });
})();
(function initVerifyAndPackages(){
  const save=$('verify-save'); if(save) save.addEventListener('click',async()=>{
    // 表单未从服务端加载成功时禁止保存:防止把 HTML 默认值(空 SMTP 等)整包写回
    if (!VERIFY_LOADED) { toast('验证设置尚未加载完成，已取消保存', true); return; }
    const old=save.textContent; save.disabled=true; save.textContent='保存中…';
    try {
    const tplPayload=MAIL_TPL.loaded?{mailTemplates:{tplVersion:2,verifySubject:MAIL_TPL.tpl.verify.subject,verifyHtml:MAIL_TPL.tpl.verify.html,resetSubject:MAIL_TPL.tpl.reset.subject,resetHtml:MAIL_TPL.tpl.reset.html}}:{}; const payload=Object.assign({emailVerificationEnabled:!!$('verify-email-enabled').checked,passwordResetEnabled:!!$('verify-reset-enabled').checked,freeQuotaUnlimited:!!$('verify-quota-unlimited').checked,freeQuota:parseInt($('verify-free-quota').value,10)||0,sessionDays:Math.min(30,Math.max(1,parseInt($('session-days')&&$('session-days').value,10)||7)),apiKeysEnabled:!!($('apikeys-enabled')&&$('apikeys-enabled').checked),registerInviteRequired:!!($('invite-required')&&$('invite-required').checked),guestEnabled:!!($('guest-enabled')&&$('guest-enabled').checked),guestRounds:Math.min(1000,Math.max(1,parseInt($('guest-rounds')&&$('guest-rounds').value,10)||3)),allowRegister:!!($('register-open')&&$('register-open').checked),registerLimitPerHour:Math.min(1000,Math.max(1,parseInt($('register-limit')&&$('register-limit').value,10)||5)),allowUserProviders:!!($('user-providers-allowed')&&$('user-providers-allowed').checked),accountDeletionMode:($('account-deletion-mode')&&$('account-deletion-mode').value)||'soft',loginMaxFails:Math.min(50,Math.max(0,parseInt($('login-max-fails')&&$('login-max-fails').value,10)||0)),loginLockMs:Math.min(3600000,Math.max(0,parseInt($('login-lock-sec')&&$('login-lock-sec').value,10)||0))*1000,smtpKeyRevealable:!!($('smtp-pass-keep')&&$('smtp-pass-keep').checked),smtp:{host:$('smtp-host').value.trim(),port:parseInt($('smtp-port').value,10)||587,username:$('smtp-user').value.trim(),password:$('smtp-pass').value,encryption:$('smtp-encryption').value,fromName:$('smtp-from-name').value.trim(),fromEmail:$('smtp-from-email').value.trim()}},tplPayload); const r=await api('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); const d=await r.json(); if(!r.ok)return toast((d.error&&d.error.message)||'保存失败',true); toast('验证设置已保存'); } catch(e) { toast('保存失败：' + ((e && e.message) || '网络错误'), true); } finally { save.disabled=false; save.textContent=old; } });
  const invalidate=$('session-invalidate'); if(invalidate) invalidate.addEventListener('click',async()=>{
    const ok=window.OCUI&&OCUI.confirm?await OCUI.confirm({title:'强制全站下线',message:'所有人的现有登录态会立即失效（包括你自己），需要重新登录。确认执行？',danger:true,confirmText:'执行'}):confirm('所有人的现有登录态会立即失效（包括你自己），确认执行？');
    if(!ok) return;
    try { const r=await api('/api/admin/session/invalidate',{method:'POST'}); const d=await r.json(); if(!r.ok)return toast((d.error&&d.error.message)||'操作失败',true); toast('已强制全站下线，即将重新登录'); setTimeout(()=>{ localStorage.removeItem('oc_token'); localStorage.removeItem('oc_user'); location.href=apiUrl('/login'); },1200); } catch(e) { toast('操作失败: '+e.message,true); }
  });
  const ps=$('pkg-save'); if(ps) ps.addEventListener('click',async()=>{
    const priceRaw=$('pkg-price').value.trim();
    const price=(priceRaw===''?'':parseFloat(priceRaw));
    const priceLabel=(priceRaw===''?'':(parseFloat(priceRaw)===0?'免费':'¥'+priceRaw));
    var limRaw = parseInt($('pkg-limit').value, 10);
    var limitPerUser = isNaN(limRaw) ? 1 : Math.max(-1, Math.min(999, limRaw));
    const b={id:PKG_EDITING_ID||'',name:$('pkg-name').value.trim(),quota:parseInt($('pkg-quota').value,10)||0,validityDays:parseInt($('pkg-validity').value,10)||0,limitPerUser:limitPerUser,price:price,priceLabel:priceLabel,purchaseUrl:$('pkg-url').value.trim(),description:$('pkg-desc').value.trim(),enabled:true};
    if(!b.name) return toast('请填写套餐名称',true);
    const r=await api('/api/admin/packages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); const d=await r.json();
    if(!r.ok) return toast((d.error&&d.error.message)||'保存失败',true);
    toast(PKG_EDITING_ID?'套餐已更新':'套餐已创建');
    PKG_EDITING_ID=''; const cancel=$('pkg-cancel-edit'); if(cancel) cancel.hidden=true;
    $('pkg-name').value=''; $('pkg-desc').value='';
    loadPackages();
  });
  const pc=$('pkg-cancel-edit'); if(pc) pc.addEventListener('click',()=>{PKG_EDITING_ID='';pc.hidden=true;toast('已取消编辑');loadPackages();});
  const pg=$('pkg-generate'); if(pg) pg.addEventListener('click',async()=>{const id=$('pkg-code-package').value; const r=await api('/api/admin/packages/'+encodeURIComponent(id)+'/codes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:parseInt($('pkg-code-count').value,10)||1})}); const d=await r.json(); if(!r.ok)return toast((d.error&&d.error.message)||'生成失败',true); $('pkg-generated-codes').value=(d.codes||[]).join('\n');toast('兑换码已生成');loadPackages();});
})();

// ============ AI 思考策略 ============
let THINKING = null;
let TH_EDIT_ID = '';
const TH_MODE_LABEL = { map: '自动映射', force: '强制档位', off: '禁用思考' };

async function loadThinking() {
  const r = await api('/api/admin/thinking'); const d = await r.json(); if (!r.ok) return;
  THINKING = d.thinking || { defaultEffort: 'medium', allowUserOverride: true, autoLearn: true, rules: [] };
  renderThinking();
}

function renderThinking() {
  if (!THINKING) return;
  $('th-default').value = THINKING.defaultEffort || 'medium';
  $('th-override').checked = !!THINKING.allowUserOverride;
  $('th-learn').checked = !!THINKING.autoLearn;
  const list = $('thinking-rules'); if (!list) return;
  const rules = THINKING.rules || [];
  $('th-rule-count').textContent = rules.length ? rules.length + ' 条' : '';
  if (!rules.length) { list.innerHTML = '<p class="muted small">还没有规则。可在下方手动添加,或开启「自动学习」等上游报错时自动生成。</p>'; return; }
  list.innerHTML = rules.map((r) => {
    const detail = r.mode === 'force'
      ? '固定为「' + ({ low: '低', medium: '中', high: '高', max: '最大' }[r.forceEffort] || r.forceEffort) + '」'
      : (r.mode === 'map'
        ? '支持档位:' + ((r.levels || []).join(' / ') || '(空,等同学到后再填充)')
        : '移除全部推理参数');
    return '<div class="pkg-card' + (r.enabled ? '' : ' pkg-card-off') + '" data-id="' + escapeHtml(r.id) + '">'
      + '<div class="pkg-card-top"><span class="pkg-card-name">' + escapeHtml(r.match) + '</span>'
      + '<span class="pkg-tag">' + escapeHtml(TH_MODE_LABEL[r.mode] || r.mode) + '</span>'
      + ((r.source || '') === 'auto' ? '<span class="pkg-tag pkg-tag-free">自动学习</span>' : '<span class="pkg-tag">手动</span>')
      + (!r.enabled ? '<span class="pkg-tag pkg-tag-off">已停用</span>' : '')
      + '</div>'
      + '<p class="pkg-card-desc">' + escapeHtml(detail) + '</p>'
      + '<div class="pkg-card-actions">'
      + '<button class="btn small" data-th-toggle type="button">' + (r.enabled ? '停用' : '启用') + '</button>'
      + '<button class="btn small" data-th-edit type="button">编辑</button>'
      + '<button class="btn small danger" data-th-del type="button">删除</button>'
      + '</div></div>';
  }).join('');
  list.querySelectorAll('[data-th-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.closest('[data-id]').dataset.id;
    const rule = THINKING.rules.find((x) => x.id === id); if (!rule) return;
    rule.enabled = !rule.enabled; saveThinking();
  }));
  list.querySelectorAll('[data-th-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.closest('[data-id]').dataset.id;
    const rule = THINKING.rules.find((x) => x.id === id); if (!rule) return;
    TH_EDIT_ID = id;
    $('th-form-title').textContent = '编辑规则';
    $('th-match').value = rule.match || '';
    $('th-mode').value = rule.mode || 'map';
    $('th-mode').dispatchEvent(new Event('change'));
    $('th-levels').value = (rule.levels || []).join(',');
    $('th-force').value = rule.forceEffort || 'medium';
    $('th-add').textContent = '更新规则';
    const cancel = $('th-cancel'); if (cancel) cancel.hidden = false;
    $('th-match').focus();
  }));
  list.querySelectorAll('[data-th-del]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.closest('[data-id]').dataset.id;
    const rule = THINKING.rules.find((x) => x.id === id); if (!rule) return;
    const ok = window.OCUI && window.OCUI.confirm
      ? await window.OCUI.confirm({ title: '删除规则', message: '确认删除「' + rule.match + '」的思考规则?删除的自动规则可能在上游报错后重新生成。', danger: true, confirmText: '删除' })
      : confirm('确认删除「' + rule.match + '」的思考规则?');
    if (!ok) return;
    THINKING.rules = THINKING.rules.filter((x) => x.id !== id);
    const deleted = (rule.source || '') === 'auto' ? [id] : [];
    saveThinking(deleted);
  }));
}

async function saveThinking(deletedAutoIds) {
  const payload = {
    thinking: {
      defaultEffort: $('th-default').value,
      allowUserOverride: $('th-override').checked,
      autoLearn: $('th-learn').checked,
      rules: THINKING.rules,
    },
    deletedAutoIds: deletedAutoIds || [],
  };
  const r = await api('/api/admin/thinking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json();
  if (!r.ok) return toast((d.error && d.error.message) || '保存失败', true);
  THINKING = d.thinking;
  renderThinking();
}

(function initThinkingPanel() {
  const modeSel = $('th-mode'); if (!modeSel) return;
  const syncMode = () => {
    const map = modeSel.value === 'map', force = modeSel.value === 'force';
    $('th-levels-wrap').hidden = !map;
    $('th-force-wrap').hidden = !force;
  };
  modeSel.addEventListener('change', syncMode);
  syncMode();
  ['th-default', 'th-override', 'th-learn'].forEach((id) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => saveThinking());
  });
  const resetForm = () => {
    TH_EDIT_ID = '';
    $('th-form-title').textContent = '添加规则';
    $('th-match').value = ''; $('th-levels').value = '';
    $('th-add').textContent = '添加规则';
    const cancel = $('th-cancel'); if (cancel) cancel.hidden = true;
  };
  $('th-add').addEventListener('click', () => {
    const match = $('th-match').value.trim();
    if (!match) return toast('请填写匹配关键词', true);
    const mode = $('th-mode').value;
    let levels = [];
    if (mode === 'map') {
      levels = $('th-levels').value.split(/[,，\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!levels.length) return toast('自动映射模式需要填写支持档位', true);
    }
    const rule = {
      id: TH_EDIT_ID || Math.random().toString(36).slice(2, 10),
      match, mode, levels,
      forceEffort: mode === 'force' ? $('th-force').value : '',
      enabled: true,
      updatedAt: Date.now(),
    };
    const existing = THINKING.rules.find((x) => x.id === rule.id);
    if (existing) Object.assign(existing, rule);
    else THINKING.rules.push(rule);
    saveThinking();
    resetForm();
  });
  $('th-cancel').addEventListener('click', resetForm);
})();

// ============ 版本更新 ============
let UPDATE_DATA = null;

function renderUpdate() {
  const d = UPDATE_DATA;
  if (!d) return;
  $('upd-current').textContent = 'v' + (d.current || '-');
  $('upd-cached').textContent = d.cached ? '（缓存于 ' + fmtTime(d.checkedAt) + '，点「检查更新」立即刷新）' : '';
  const latest = d.latest || {};
  const res = $('upd-result');
  if (d.hasUpdate) {
    $('upd-status').textContent = '发现新版本 v' + (latest.version || '?') + '，可一键更新。';
    $('upd-apply').classList.remove('hidden');
    res.classList.remove('hidden');
    $('upd-latest').textContent = 'v' + (latest.version || '?');
    $('upd-published').textContent = latest.publishedAt ? '发布于 ' + fmtTime(latest.publishedAt) : '';
    $('upd-notes').textContent = latest.notes || '（无发布说明）';
    $('upd-notes').hidden = !latest.notes;
    const link = $('upd-link');
    link.hidden = !latest.url;
    if (latest.url) link.href = latest.url;
  } else {
    $('upd-status').textContent = '已是最新版本。';
    $('upd-apply').classList.add('hidden');
    res.classList.add('hidden');
  }
  const last = d.lastUpdate;
  $('upd-last').textContent = last
    ? '上次在线更新：v' + last.from + ' → v' + last.to + '（' + fmtTime(last.at) + '）。更新前程序备份在 data/update/backup/。'
    : '';
}

async function checkUpdate(force) {
  const btn = $('upd-check');
  btn.disabled = true;
  $('upd-status').textContent = force ? '正在连接更新源…' : '正在读取检查结果…';
  try {
    const r = await api('/api/admin/update/check' + (force ? '?force=1' : ''));
    const d = await r.json();
    if (!r.ok) {
      $('upd-status').textContent = d.error && d.error.message ? d.error.message : '检查失败（HTTP ' + r.status + '）';
      return;
    }
    UPDATE_DATA = d;
    renderUpdate();
  } catch (e) {
    $('upd-status').textContent = '检查失败: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function performUpdate() {
  const d = UPDATE_DATA;
  if (!d || !d.hasUpdate) return;
  const ver = d.latest && d.latest.version ? d.latest.version : '';
  if (!confirm('确定要更新到 v' + ver + ' 吗？\n更新期间请勿关闭页面；data/ 数据目录与 config.php 不会被改动。')) return;
  const btn = $('upd-apply');
  btn.disabled = true;
  $('upd-status').textContent = '正在下载并应用更新，视主机网速可能需要 1-2 分钟，请勿关闭页面…';
  try {
    const r = await api('/api/admin/update/perform', { method: 'POST' });
    const res = await r.json();
    if (!r.ok) {
      $('upd-status').textContent = '更新失败：' + (res.error && res.error.message ? res.error.message : 'HTTP ' + r.status)
        + '。若为主机超时中断可重试；更新前程序备份在 data/update/backup/。';
      btn.disabled = false;
      return;
    }
    $('upd-status').textContent = '已更新到 v' + res.to + '，页面将在 3 秒后刷新加载新版本…';
    setTimeout(() => location.reload(), 3000);
  } catch (e) {
    $('upd-status').textContent = '更新失败: ' + e.message;
    btn.disabled = false;
  }
}

async function loadUpdatePanel() {
  UPDATE_DATA = null;
  $('upd-last').textContent = '';
  $('upd-result').classList.add('hidden');
  await checkUpdate(false);
}

(function bindUpdatePanel() {
  const check = $('upd-check');
  if (!check) return;
  check.addEventListener('click', () => checkUpdate(true));
  $('upd-apply').addEventListener('click', performUpdate);
})();

// ============ 页签切换(懒加载) ============
const tabLoaded = {};
// ============ 数据备份 ============
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
async function loadBackups() {
  try {
    const r = await api('/api/admin/backup');
    const d = await r.json();
    if ($('backup-enabled')) $('backup-enabled').checked = !!d.backupEnabled;
    if ($('backup-keep')) $('backup-keep').value = d.backupKeep || 7;
    const tb = $('backup-tbody');
    if (!tb) return;
    const list = d.backups || [];
    tb.innerHTML = list.map((b) => {
      const time = b.time ? new Date(b.time).toLocaleString('zh-CN') : '—';
      return '<tr><td>' + escapeHtml(b.name) + '</td><td>' + fmtBytes(b.size) + '</td><td>' + time + '</td>'
        + '<td style="text-align:right;white-space:nowrap">'
        + '<a class="btn small" href="' + apiUrl('/api/admin/backup/download?id=' + encodeURIComponent(b.name)) + '">下载</a> '
        + '<button class="btn small danger" data-restore="' + escapeHtml(b.name) + '" type="button">恢复</button></td></tr>';
    }).join('');
    if ($('backup-empty')) $('backup-empty').style.display = list.length ? 'none' : 'block';
    tb.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', () => restoreBackup(btn.dataset.restore));
    });
  } catch (e) {
    toast('备份列表加载失败: ' + e.message, true);
  }
}
async function restoreBackup(name) {
  const message = '确认用 ' + name + ' 整体替换当前数据库？恢复点之后的全部数据变更会丢失。';
  const ok = window.OCUI && OCUI.confirm
    ? await OCUI.confirm({ title: '恢复备份', message, danger: true, confirmText: '恢复' })
    : confirm(message);
  if (!ok) return;
  try {
    const r = await api('/api/admin/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name }),
    });
    const d = await r.json();
    if (!r.ok) return toast((d.error && d.error.message) || '恢复失败', true);
    toast('已恢复（' + d.users + ' 个用户），即将刷新页面');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast('恢复失败: ' + e.message, true);
  }
}
(function initBackupUI() {
  const save = $('backup-save');
  if (save) save.addEventListener('click', async () => {
    const payload = {
      backupEnabled: !!($('backup-enabled') && $('backup-enabled').checked),
      backupKeep: Math.min(30, Math.max(1, parseInt($('backup-keep') && $('backup-keep').value, 10) || 7)),
    };
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '保存失败', true);
      toast('备份设置已保存');
      loadBackups();
    } catch (e) { toast('保存失败: ' + e.message, true); }
  });
  const nowBtn = $('backup-now');
  if (nowBtn) nowBtn.addEventListener('click', async () => {
    nowBtn.disabled = true;
    try {
      const r = await api('/api/admin/backup', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '备份失败', true);
      toast('已创建备份 ' + d.created);
      loadBackups();
    } catch (e) {
      toast('备份失败: ' + e.message, true);
    } finally { nowBtn.disabled = false; }
  });
})();

// ============ 模型元数据(上下文窗口 / 价格) ============
// 全站按模型名共享一份;与供应商解耦,同一模型在多个渠道下只维护一份。
// 价格统一以「每 token」存储(与 litellm 一致),界面按「每百万 token」展示更好读。
const MM_STATE = { q: '', page: 1, perPage: 100, total: 0 };

// 每 token -> 每百万 token 的展示值;0 视为未配置,显示为「—」
function mmPricePerMillion(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  // 保留 6 位有效小数,去掉尾部多余的 0(如 2.500000 -> 2.5)
  return String(parseFloat((n * 1e6).toFixed(6)));
}
function mmFmtTokens(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return '<span class="muted">—</span>';
  return escapeHtml(n.toLocaleString('en-US'));
}
function mmSourceBadge(item) {
  if (item.source === 'builtin') return '<span class="mm-src builtin" title="随发布包内置的开箱即用值，同步与清空都不会覆盖">内置</span>';
  if (item.source === 'manual') return '<span class="mm-src manual" title="手工维护，同步不会覆盖">手工</span>';
  if (item.source === 'auto') return '<span class="mm-src auto" title="模型未匹配到本表时自动补的兜底值，需人工复核">自动</span>';
  return '<span class="mm-src sync" title="来自 litellm 价格表">同步</span>';
}

async function loadModelMeta() {
  if (MM_STATE._init) return refreshModelMeta();
  MM_STATE._init = true;
  const search = $('mm-search');
  if (search) {
    // 输入防抖:避免每敲一个字都打一次接口(价格表有 2000+ 条)
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { MM_STATE.q = search.value.trim(); MM_STATE.page = 1; refreshModelMeta(); }, 300);
    });
  }
  if ($('mm-perpage')) $('mm-perpage').addEventListener('change', (e) => {
    MM_STATE.perPage = parseInt(e.target.value, 10) || 100; MM_STATE.page = 1; refreshModelMeta();
  });
  if ($('mm-prev')) $('mm-prev').addEventListener('click', () => {
    if (MM_STATE.page > 1) { MM_STATE.page--; refreshModelMeta(); }
  });
  if ($('mm-next')) $('mm-next').addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(MM_STATE.total / MM_STATE.perPage));
    if (MM_STATE.page < maxPage) { MM_STATE.page++; refreshModelMeta(); }
  });
  if ($('mm-sync')) $('mm-sync').addEventListener('click', () => syncModelMeta($('mm-sync')));
  if ($('mm-clear-litellm')) $('mm-clear-litellm').addEventListener('click', clearModelMeta);
  if ($('mm-new')) $('mm-new').addEventListener('click', () => editModelMeta(null));
  await refreshModelMeta();
}

async function refreshModelMeta() {
  const wrap = $('mm-table-wrap');
  if (!wrap) return;
  const qs = new URLSearchParams({ q: MM_STATE.q, page: MM_STATE.page, perPage: MM_STATE.perPage });
  let d;
  try {
    const r = await api('/api/admin/model-meta?' + qs.toString());
    d = await r.json();
    if (!r.ok) { wrap.innerHTML = '<p class="muted small">' + escapeHtml((d.error && d.error.message) || '加载失败') + '</p>'; return; }
  } catch (e) {
    wrap.innerHTML = '<p class="muted small">加载失败：' + escapeHtml(e.message) + '</p>';
    return;
  }
  MM_STATE.total = d.total || 0;
  // 搜索/清空后总数变小,旧页码可能越界(显示"第 3 / 1 页"且表格为空):回夹到最后一页重取
  const totalPages = Math.max(1, Math.ceil(MM_STATE.total / MM_STATE.perPage));
  if (MM_STATE.page > totalPages) {
    MM_STATE.page = totalPages;
    return refreshModelMeta();
  }
  const st = $('mm-status');
  if (st) {
    const synced = d.syncedAt ? new Date(d.syncedAt).toLocaleString('zh-CN') : '从未同步';
    st.textContent = '共 ' + (d.storedCount || 0) + ' 个模型（源表 ' + (d.sourceCount || 0) + ' 条）· 上次同步：' + synced;
  }
  // 待复核提示条:自动补的兜底值数量(不随搜索/分页变化,来自服务端全表统计)
  const reviewNote = $('mm-review-note');
  if (reviewNote) {
    const rc = Number(d.reviewCount) || 0;
    reviewNote.hidden = rc <= 0;
    if (rc > 0 && $('mm-review-count')) $('mm-review-count').textContent = String(rc);
  }
  const items = d.items || [];
  if (!items.length) {
    wrap.innerHTML = '<p class="muted small">' + (MM_STATE.q ? '没有匹配的模型。' : '还没有数据，点「从 litellm 同步」拉取。') + '</p>';
  } else {
    // 列宽足够时全部并列展示;窗口很窄时横向滑动(表头吸顶、模型名与操作列吸附两侧)
    const head = '<tr>'
      + '<th class="mm-col-name">模型</th>'
      + '<th title="模型一次能接收的最大 token 数（含对话历史）">输入窗口</th>'
      + '<th title="模型一次最多能生成的 token 数，对应请求里的 max_tokens">输出上限</th>'
      + '<th title="每百万输入 token 的价格，仅作估算参考">输入 $/M</th>'
      + '<th title="每百万输出 token 的价格，仅作估算参考">输出 $/M</th>'
      + '<th title="每百万缓存读取 token 的价格">缓存读 $/M</th>'
      + '<th title="每百万缓存写入 token 的价格">缓存写 $/M</th>'
      + '<th title="内置与手工维护的条目不会被 litellm 同步覆盖">来源</th>'
      + '<th class="mm-ops"></th>'
      + '</tr>';
    const rows = items.map((it) => {
      const name = escapeHtml(it.model);
      const rowCls = [it.inUse ? 'mm-inuse' : '', it.needsReview ? 'mm-needs-review' : ''].filter(Boolean);
      // 未配置的数值显示为淡灰「—」,比空白更明确地表示"没有这项数据"
      const cell = (v) => mmFmtTokens(v);
      const price = (v) => {
        const s = mmPricePerMillion(v);
        return s === '' ? '<span class="mm-none">—</span>' : s;
      };
      return '<tr' + (rowCls.length ? ' class="' + rowCls.join(' ') + '"' : '') + '>'
        + '<td class="mm-col-name"><span class="mm-name" title="' + name + '">' + name + '</span>'
        + (it.inUse ? '<span class="mm-inuse-tag" title="当前供应商配置里正在使用">在用</span>' : '')
        + (it.needsReview ? '<span class="mm-review-tag" title="系统自动补的兜底值，未经人工核对">待复核</span>' : '') + '</td>'
        + '<td>' + cell(it.maxInputTokens) + '</td>'
        + '<td>' + cell(it.maxOutputTokens) + '</td>'
        + '<td>' + price(it.inputCostPerToken) + '</td>'
        + '<td>' + price(it.outputCostPerToken) + '</td>'
        + '<td>' + price(it.cacheReadCostPerToken) + '</td>'
        + '<td>' + price(it.cacheWriteCostPerToken) + '</td>'
        + '<td>' + mmSourceBadge(it) + (it.enabled === false ? '<span class="mm-off" title="该条不参与窗口计算，但数据保留">已停用</span>' : '') + '</td>'
        + '<td class="mm-ops">'
        + (it.needsReview ? '<button class="btn small primary" type="button" data-mm-confirm="' + name + '" title="数值无误，去掉待复核标记">确认</button>' : '')
        + '<button class="btn small" type="button" data-mm-edit="' + name + '" title="编辑 ' + name + '">编辑</button>'
        + '<button class="btn small danger" type="button" data-mm-del="' + name + '" title="删除 ' + name + '">删除</button></td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<div class="mm-wrap"><table class="mm-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
    // 表格比容器宽时:吸附列加阴影提示,否则滑到中间时看不出模型名是浮在上层的
    const scroller = wrap.querySelector('.mm-wrap');
    if (scroller) {
      let raf = 0;
      const sync = () => {
        const max = scroller.scrollWidth - scroller.clientWidth;
        const canPan = max > 2;
        const atEnd = canPan && scroller.scrollLeft >= max - 2;
        scroller.classList.toggle('is-pan-x', canPan && !atEnd);
      };
      scroller.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; sync(); });
      }, { passive: true });
      if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(scroller);
      else window.addEventListener('resize', sync);
      sync();
    }
    wrap.querySelectorAll('[data-mm-edit]').forEach((btn) => btn.addEventListener('click', () => {
      const model = btn.getAttribute('data-mm-edit');
      editModelMeta(items.find((x) => x.model === model) || null);
    }));
    wrap.querySelectorAll('[data-mm-confirm]').forEach((btn) => btn.addEventListener('click', async () => {
      const model = btn.getAttribute('data-mm-confirm');
      btn.disabled = true;
      try {
        const r = await api('/api/admin/model-meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, confirm: true }) });
        const rd = await r.json();
        if (!r.ok) return toast((rd.error && rd.error.message) || '确认失败', true);
        toast('已确认 ' + model);
        refreshModelMeta();
      } catch (e) {
        toast('确认失败: ' + e.message, true);
      } finally {
        btn.disabled = false;
      }
    }));
    wrap.querySelectorAll('[data-mm-del]').forEach((btn) => btn.addEventListener('click', async () => {
      const model = btn.getAttribute('data-mm-del');
      const ok = window.OCUI && window.OCUI.confirm
        ? await window.OCUI.confirm({ title: '删除模型元数据', message: '确认删除「' + model + '」的窗口与价格数据？删除后该模型不再有单独上限（请求时按兜底值处理）。', danger: true, confirmText: '删除' })
        : window.confirm('确认删除「' + model + '」？');
      if (!ok) return;
      const r = await api('/api/admin/model-meta', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      const rd = await r.json();
      if (!r.ok) return toast((rd.error && rd.error.message) || '删除失败', true);
      toast('已删除 ' + model);
      refreshModelMeta();
    }));
  }
  const maxPage = Math.max(1, Math.ceil(MM_STATE.total / MM_STATE.perPage));
  if ($('mm-pageinfo')) $('mm-pageinfo').textContent = '第 ' + MM_STATE.page + ' / ' + maxPage + ' 页，共 ' + MM_STATE.total + ' 条';
  if ($('mm-prev')) $('mm-prev').disabled = MM_STATE.page <= 1;
  if ($('mm-next')) $('mm-next').disabled = MM_STATE.page >= maxPage;
}

// 新增/编辑弹窗。item 为 null 时是新增。价格输入按「每百万 token」,提交前换算回每 token。
function editModelMeta(item) {
  const isNew = !item;
  const v = (x) => (x === undefined || x === null ? '' : String(x));
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = ''
    + '<div class="modal admin-modal" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>' + (isNew ? '新增模型元数据' : '编辑模型元数据') + '</h3>'
    + '<button class="icon-btn" type="button" data-close aria-label="关闭">✕</button></div>'
    + '<div class="modal-body">'
    + '<p class="muted small">按「每百万 token」填价格（如 gpt-4o 输入 2.5）。留空＝不配置该项。手工保存的条目标记为「手工」，后续同步不会覆盖它。'
    + (item && item.needsReview ? '<br><b>该条目前是自动补的兜底值</b>，保存后即视为已复核，标记会消失。' : '') + '</p>'
    + '<label class="field"><span>模型名（与供应商里的模型 ID 一致）</span><input id="mm-edit-model" type="text" maxlength="200" value="' + escapeHtml(isNew ? '' : item.model) + '"' + (isNew ? '' : ' readonly') + '></label>'
    + '<div class="pkg-form-grid">'
    + '<label class="field"><span>输入窗口（token）</span><input id="mm-edit-maxin" type="number" min="0" step="1" value="' + v(item && item.maxInputTokens ? item.maxInputTokens : '') + '"></label>'
    + '<label class="field"><span>输出上限（token）</span><input id="mm-edit-maxout" type="number" min="0" step="1" value="' + v(item && item.maxOutputTokens ? item.maxOutputTokens : '') + '"></label>'
    + '</div>'
    + '<div class="pkg-form-grid">'
    + '<label class="field"><span>输入价格（$/百万）</span><input id="mm-edit-pin" type="number" min="0" step="0.0001" value="' + (item ? mmPricePerMillion(item.inputCostPerToken) : '') + '"></label>'
    + '<label class="field"><span>输出价格（$/百万）</span><input id="mm-edit-pout" type="number" min="0" step="0.0001" value="' + (item ? mmPricePerMillion(item.outputCostPerToken) : '') + '"></label>'
    + '</div>'
    + '<div class="pkg-form-grid">'
    + '<label class="field"><span>缓存读价格（$/百万）</span><input id="mm-edit-cread" type="number" min="0" step="0.0001" value="' + (item ? mmPricePerMillion(item.cacheReadCostPerToken) : '') + '"></label>'
    + '<label class="field"><span>缓存写价格（$/百万）</span><input id="mm-edit-cwrite" type="number" min="0" step="0.0001" value="' + (item ? mmPricePerMillion(item.cacheWriteCostPerToken) : '') + '"></label>'
    + '</div>'
    + '<div class="field ma-edit-enabled-row"><label class="user-form-admin"><span class="switch"><input type="checkbox" id="mm-edit-enabled"' + (!item || item.enabled !== false ? ' checked' : '') + '><span class="slider"></span></span><span>启用（停用后该条不参与窗口计算，但数据保留）</span></label></div>'
    + '</div>'
    + '<div class="modal-footer"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="mm-edit-save">保存</button></div>'
    + '</div>';
  document.body.appendChild(wrap);
  const rm = () => wrap.remove();
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', rm));
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) rm(); });
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(wrap);
  const saveBtn = wrap.querySelector('#mm-edit-save');
  saveBtn.addEventListener('click', async () => {
    const model = String(wrap.querySelector('#mm-edit-model').value || '').trim();
    if (!model) return toast('请填写模型名', true);
    // 界面用「每百万」,存储用「每 token」——在这里换算,避免两边各自记一个单位
    const perM = (id) => {
      const raw = String(wrap.querySelector(id).value || '').trim();
      if (raw === '') return 0;
      const n = parseFloat(raw);
      return Number.isFinite(n) && n > 0 ? n / 1e6 : 0;
    };
    const numOr0 = (id) => Math.max(0, parseInt(wrap.querySelector(id).value, 10) || 0);
    const payload = {
      model,
      maxInputTokens: numOr0('#mm-edit-maxin'),
      maxOutputTokens: numOr0('#mm-edit-maxout'),
      inputCostPerToken: perM('#mm-edit-pin'),
      outputCostPerToken: perM('#mm-edit-pout'),
      cacheReadCostPerToken: perM('#mm-edit-cread'),
      cacheWriteCostPerToken: perM('#mm-edit-cwrite'),
      enabled: wrap.querySelector('#mm-edit-enabled').checked,
    };
    saveBtn.disabled = true;
    try {
      const r = await api('/api/admin/model-meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const rd = await r.json();
      if (!r.ok) return toast((rd.error && rd.error.message) || '保存失败', true);
      toast('已保存 ' + model);
      rm();
      refreshModelMeta();
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });
}

async function syncModelMeta(btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '同步中…';
  const st = $('mm-status');
  if (st) st.textContent = '正在拉取 litellm 价格表…';
  try {
    const r = await api('/api/admin/model-meta/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const d = await r.json();
    if (!r.ok) {
      toast((d.error && d.error.message) || '同步失败', true);
      return refreshModelMeta();
    }
    toast('同步完成：新增 ' + d.added + '，更新 ' + d.updated + '，保留手工 ' + d.skipped);
    await refreshModelMeta();
  } catch (e) {
    toast('同步失败: ' + e.message, true);
    refreshModelMeta();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function clearModelMeta() {
  const ok = window.OCUI && window.OCUI.confirm
    ? await window.OCUI.confirm({ title: '清空同步数据', message: '确认清空所有来自 litellm 的数据？手工维护的条目会保留。清空后这些模型不再有单独上限（请求时按兜底值处理）。', danger: true, confirmText: '清空' })
    : window.confirm('确认清空同步数据？手工条目会保留。');
  if (!ok) return;
  const r = await api('/api/admin/model-meta/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const d = await r.json();
  if (!r.ok) return toast((d.error && d.error.message) || '清空失败', true);
  toast('已清空（保留手工条目 ' + d.kept + ' 条）');
  MM_STATE.page = 1;
  refreshModelMeta();
}

// ============ 模型汇总（自定义 ID 聚合多模型 + 轮询/故障转移） ============
const MA_STATE = { groups: [], providers: [], userProviders: [], dupes: [], nextOrder: 1, settings: {}, _init: false };

const MA_STRATEGY_LABEL = { failover: '故障自动转移', roundrobin: '轮询' };

function maProviderById(id) {
  return MA_STATE.providers.find((p) => p.id === String(id)) || null;
}
function maProviderName(id) {
  const p = maProviderById(id);
  return p ? p.name : '';
}
// 成员的可用性:渠道不存在 / 渠道被停用 / 渠道里已没有该模型 —— 三种都标出来,
// 否则管理员只会看到「前台没生效」却不知道是哪一条断的。
function maMemberState(m) {
  const p = maProviderById(m.providerId);
  if (!p) return { ok: false, why: '渠道已删除' };
  if (!p.enabled) return { ok: false, why: '渠道已停用' };
  if (!(p.models || []).some((x) => String(x.id) === String(m.model))) return { ok: false, why: '渠道里已无此模型' };
  return { ok: true, why: '' };
}

async function loadModelAgg() {
  if (!MA_STATE._init) {
    MA_STATE._init = true;
    if ($('ma-settings-save')) $('ma-settings-save').addEventListener('click', saveModelAggSettings);
    if ($('ma-new')) $('ma-new').addEventListener('click', () => editModelAgg(null));
    if ($('ma-automerge-run')) $('ma-automerge-run').addEventListener('click', runModelAggAutomerge);
  }
  await refreshModelAgg();
}

async function refreshModelAgg() {
  const wrap = $('ma-list');
  try {
    const r = await api('/api/admin/model-groups');
    const d = await r.json();
    if (!r.ok) { if (wrap) wrap.innerHTML = '<p class="muted small">' + escapeHtml((d.error && d.error.message) || '加载失败') + '</p>'; return; }
    MA_STATE.groups = d.groups || [];
    MA_STATE.providers = d.providers || [];
    MA_STATE.userProviders = d.userProviders || [];
    MA_STATE.dupes = d.dupes || [];
    MA_STATE.nextOrder = d.nextOrder || 1;
    MA_STATE.settings = d.settings || {};
  } catch (e) {
    if (wrap) wrap.innerHTML = '<p class="muted small">加载失败：' + escapeHtml(e.message) + '</p>';
    return;
  }
  const s = MA_STATE.settings;
  if ($('ma-enabled')) $('ma-enabled').checked = !!s.modelAggEnabled;
  if ($('ma-automerge')) $('ma-automerge').checked = s.modelAggAutoMerge !== false;
  if ($('ma-hide-unmerged')) $('ma-hide-unmerged').checked = !!s.modelAggHideUnmerged;
  renderModelAgg();
}

function renderModelAgg() {
  const wrap = $('ma-list');
  if (!wrap) return;
  const st = $('ma-status');
  if (st) st.textContent = '共 ' + MA_STATE.groups.length + ' 个汇总 ID';
  // 同名可汇总提示:让管理员一眼看到「有哪些模型名在多个渠道都有」
  const dn = $('ma-dupes-note');
  if (dn) {
    dn.hidden = !MA_STATE.dupes.length;
    if ($('ma-dupes-count')) $('ma-dupes-count').textContent = String(MA_STATE.dupes.length);
    if ($('ma-dupes-list')) {
      $('ma-dupes-list').textContent = MA_STATE.dupes.slice(0, 12).map((x) => x.name + '（' + x.count + ' 个渠道）').join('、')
        + (MA_STATE.dupes.length > 12 ? ' 等' : '');
    }
  }
  if (!MA_STATE.groups.length) {
    wrap.innerHTML = '<p class="muted small">还没有汇总 ID。打开上面的「默认汇总同名模型」并保存，或点「手动新增汇总」自己指定一个 ID 与成员。</p>';
    return;
  }
  wrap.innerHTML = MA_STATE.groups.map((g, i) => {
    const tags = [];
    tags.push('<span class="ma-tag' + (g.auto ? ' auto' : '') + '">' + (g.auto ? '同名自动' : '手动') + '</span>');
    tags.push('<span class="ma-tag">' + (MA_STRATEGY_LABEL[g.strategy] || MA_STRATEGY_LABEL.failover) + '</span>');
    tags.push('<span class="ma-tag">' + (g.candidateCount || 0) + ' 个可用渠道</span>');
    if (!g.enabled) tags.push('<span class="ma-tag">已停用</span>');
    const members = (g.resolved || []).map((m, mi) => {
      const bad = !m.exists ? '渠道里已无此模型' : (!m.enabled ? '渠道已停用' : '');
      return '<div class="ma-member' + (bad ? ' is-bad' : '') + '">'
        + '<span class="ma-idx">' + (mi + 1) + '.</span>'
        + '<span>' + escapeHtml(maProviderName(m.providerId) || m.providerName || m.providerId || '（渠道已删除）') + '</span>'
        + '<span class="muted small">' + escapeHtml(m.model) + '</span>'
        + (bad ? '<span class="ma-bad">' + escapeHtml(bad) + '</span>' : '')
        + '</div>';
    }).join('');
    const costText = g.cost === null || g.cost === undefined ? '按实际命中的渠道扣费（预扣取候选最大值）' : ('固定 ' + g.cost + ' 次/调用');
    return '<div class="ma-card' + (g.enabled ? '' : ' is-off') + '">'
      + '<div class="ma-head"><span class="ma-id">' + escapeHtml(g.id) + '</span>'
      + (g.label && g.label !== g.id ? '<span class="muted small">显示名：' + escapeHtml(g.label) + '</span>' : '')
      + tags.join('') + '</div>'
      + '<div class="ma-meta muted small">顺序 ' + (Number(g.order) || 0) + ' · ' + costText + (g.auto ? ' · 成员随渠道配置实时计算' : '') + '</div>'
      + '<div class="ma-members">' + (members || '<div class="ma-member is-bad">没有任何成员渠道</div>') + '</div>'
      + '<div class="ma-ops">'
      + '<button class="btn small" type="button" data-ma-up="' + i + '"' + (i === 0 ? ' disabled' : '') + '>上移</button>'
      + '<button class="btn small" type="button" data-ma-down="' + i + '"' + (i === MA_STATE.groups.length - 1 ? ' disabled' : '') + '>下移</button>'
      + '<button class="btn small" type="button" data-ma-edit="' + i + '">编辑</button>'
      + '<button class="btn small" type="button" data-ma-toggle="' + i + '">' + (g.enabled ? '停用' : '启用') + '</button>'
      + '<span class="spacer"></span>'
      + '<button class="btn small danger" type="button" data-ma-del="' + i + '">删除</button>'
      + '</div></div>';
  }).join('');
  wrap.querySelectorAll('[data-ma-up]').forEach((b) => b.addEventListener('click', () => moveModelAgg(parseInt(b.dataset.maUp, 10), -1)));
  wrap.querySelectorAll('[data-ma-down]').forEach((b) => b.addEventListener('click', () => moveModelAgg(parseInt(b.dataset.maDown, 10), 1)));
  wrap.querySelectorAll('[data-ma-edit]').forEach((b) => b.addEventListener('click', () => editModelAgg(MA_STATE.groups[parseInt(b.dataset.maEdit, 10)])));
  wrap.querySelectorAll('[data-ma-toggle]').forEach((b) => b.addEventListener('click', () => toggleModelAgg(parseInt(b.dataset.maToggle, 10))));
  wrap.querySelectorAll('[data-ma-del]').forEach((b) => b.addEventListener('click', () => deleteModelAgg(parseInt(b.dataset.maDel, 10))));
}

async function saveModelAggSettings() {
  const btn = $('ma-settings-save');
  if (btn) btn.disabled = true;
  try {
    const payload = {
      modelAggEnabled: !!($('ma-enabled') && $('ma-enabled').checked),
      modelAggAutoMerge: !!($('ma-automerge') && $('ma-automerge').checked),
      modelAggHideUnmerged: !!($('ma-hide-unmerged') && $('ma-hide-unmerged').checked),
    };
    // 走统一的设置接口:后端在这些键上是浅合并,不会动到其它设置
    const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
    toast(payload.modelAggEnabled ? '已启用模型汇总' + (payload.modelAggAutoMerge ? '（已按同名自动生成汇总）' : '') : '已关闭模型汇总');
    await refreshModelAgg();
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runModelAggAutomerge() {
  const btn = $('ma-automerge-run');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/admin/model-groups/automerge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minProviders: 2 }) });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '生成失败');
    toast('同名汇总已刷新：新增 ' + d.added + '，清理 ' + d.removed + '，现有 ' + d.kept + ' 个');
    await refreshModelAgg();
  } catch (e) {
    toast('生成失败: ' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 上/下移:只在这些汇总 ID 之间重排它们的 order 值(不动供应商的 order),
// 这样「汇总默认排在供应商之后」的既有格局不会被一次拖动打乱。
async function moveModelAgg(idx, dir) {
  const ids = MA_STATE.groups.map((g) => g.id);
  const to = idx + dir;
  if (to < 0 || to >= ids.length) return;
  const tmp = ids[idx]; ids[idx] = ids[to]; ids[to] = tmp;
  try {
    const r = await api('/api/admin/model-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reorder', order: ids }) });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '排序失败');
    await refreshModelAgg();
  } catch (e) {
    toast('排序失败: ' + e.message, true);
  }
}

async function toggleModelAgg(idx) {
  const g = MA_STATE.groups[idx];
  if (!g) return;
  await saveModelAggGroup({ group: Object.assign({}, g, { enabled: !g.enabled, __origId: g.id }) }, g.enabled ? '已停用 ' : '已启用 ');
}

async function deleteModelAgg(idx) {
  const g = MA_STATE.groups[idx];
  if (!g) return;
  const extra = g.auto ? '这是一个「同名自动」汇总：下次点「重新生成同名汇总」或保存总开关时会被重新创建。' : '';
  const ok = window.OCUI && window.OCUI.confirm
    ? await window.OCUI.confirm({ title: '删除汇总', message: '确认删除汇总 ID「' + g.id + '」？其成员渠道会重新按原样出现在前台。' + extra, danger: true, confirmText: '删除' })
    : window.confirm('确认删除汇总 ID「' + g.id + '」？');
  if (!ok) return;
  try {
    const r = await api('/api/admin/model-groups', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: g.id }) });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '删除失败');
    toast('已删除 ' + g.id);
    await refreshModelAgg();
  } catch (e) {
    toast('删除失败: ' + e.message, true);
  }
}

async function saveModelAggGroup(payload, okPrefix) {
  try {
    const r = await api('/api/admin/model-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
    toast((okPrefix || '已保存 ') + d.group.id);
    await refreshModelAgg();
    return true;
  } catch (e) {
    toast('保存失败: ' + e.message, true);
    return false;
  }
}

// 新增/编辑弹窗。item 为 null 时是新增;auto 组的成员是实时算出来的,成员勾选只读。
// 新增/编辑弹窗。item 为 null 时是新增;auto 组的成员是实时算出来的,成员勾选只读。
// 弹窗底部给出「用户自建渠道」的只读清单:它们不属于平台资源,永远不进汇总成员。
function userProvNote() {
  const ups = MA_STATE.userProviders || [];
  if (!ups.length) return '';
  const rows = ups.map((p) => {
    const owner = p.ownerName ? esc(p.ownerName) : '某用户';
    const models = (p.models || []).map((m) => m.id).join('、');
    return '<div class="ma-pick-row readonly"><span class="ma-user-badge">用户自建</span>'
      + '<span>' + esc(p.name || p.id) + '</span>'
      + '<span class="muted small">' + esc(owner) + ' · ' + esc(models || '（无模型）') + '</span></div>';
  }).join('');
  return '<div class="field ma-user-prov"><span>用户自建渠道（' + ups.length + '，不参与汇总）</span>'
    + '<p class="muted small" style="margin:0 0 6px">这些是用户在自己的设置里添加的渠道，属于他们个人的配置。'
    + '把它们汇总进来，用户一删自己的渠道，全体用户的汇总 ID 就会跟着少一个成员；而且用户本来就能在自己的列表里直接用这些模型。</p>'
    + '<div class="ma-pick ma-pick-readonly">' + rows + '</div></div>';
}

function editModelAgg(item) {
  const isNew = !item;
  const isAuto = !!(item && item.auto);
  const sel = new Set(isNew ? [] : (item.members || []).map((m) => m.providerId + '|' + m.model));
  const esc = escapeHtml;
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  // 成员选择器:只列平台渠道(管理员添加的)。用户在前台自建的渠道不是平台资源,
  // 不能成为全局汇总组的成员 —— 该用户删掉自己的渠道时,全体用户的汇总会跟着少一个成员。
  // 下面单独列出它们(只读),让管理员看得见「为什么某个模型的渠道数比预期少」。
  const pick = MA_STATE.providers.map((p) => {
    if (!(p.models || []).length) return '';
    const rows = p.models.map((m) => {
      const key = p.id + '|' + m.id;
      return '<div class="ma-pick-row"><label><input type="checkbox" data-ma-pick="' + esc(key) + '"'
        + (sel.has(key) ? ' checked' : '') + (isAuto ? ' disabled' : '') + '>'
        + '<span>' + esc(m.name || m.id) + '</span>'
        + '<span class="muted small">' + esc(m.id) + '</span>'
        + (m.image ? '<span class="ma-tag">图</span>' : (m.video ? '<span class="ma-tag">视频</span>' : ''))
        + '</label></div>';
    }).join('');
    return '<div class="ma-pick-prov">' + esc(p.name || p.id) + (p.enabled ? '' : '（已停用）') + '<span class="muted small"> · ' + esc(p.id) + '</span></div>' + rows;
  }).join('');
  wrap.innerHTML = ''
    + '<div class="modal admin-modal" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>' + (isNew ? '新增汇总 ID' : '编辑汇总 ID') + '</h3>'
    + '<button class="icon-btn" type="button" data-close aria-label="关闭">✕</button></div>'
    + '<div class="modal-body">'
    + '<p class="muted small">汇总 ID 就是前台和开放 API 里看到的<b>模型名</b>。成员渠道按从上到下的顺序作为优先级（故障自动转移时先试第一个）。</p>'
    + '<label class="field"><span>汇总 ID *</span><input id="ma-edit-id" type="text" maxlength="100" value="' + esc(isNew ? '' : item.id) + '" placeholder="例如 gpt-4o" autocomplete="off" spellcheck="false"' + (isNew || isAuto ? '' : ' readonly') + '></label>'
    + (isAuto ? '<p class="muted small" style="margin:-6px 0 8px">这是「同名自动」汇总：成员随渠道配置实时计算，改 ID 或成员请直接改渠道，或在下方删除本汇总。</p>' : '')
    + '<label class="field"><span>前台显示名（留空＝直接用汇总 ID）</span><input id="ma-edit-label" type="text" maxlength="60" value="' + esc(item && item.label ? item.label : '') + '" autocomplete="off"></label>'
    + '<div class="pkg-form-grid">'
    + '<label class="field"><span>分流策略</span>'
    + '<div class="select-box" id="ma-edit-strategy" data-value="' + esc((item && item.strategy) || 'failover') + '" role="button" tabindex="0">'
    + '<span class="sb-label">' + (MA_STRATEGY_LABEL[(item && item.strategy) || 'failover']) + '</span>'
    + '<span class="sb-arrow"><svg class="oc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5L12 14.5 17 9.5"/></svg></span>'
    + '</div></label>'
    + '<label class="field"><span>显示顺序（越小越靠前）</span><input id="ma-edit-order" type="number" min="0" step="1" value="' + (item ? Number(item.order) || 0 : MA_STATE.nextOrder) + '"></label>'
    + '</div>'
    + '<label class="field"><span>单次扣费次数（留空＝按实际命中渠道折算，预扣取候选最大值）</span><input id="ma-edit-cost" type="number" min="0" max="1000" step="0.01" value="' + (item && item.cost !== null && item.cost !== undefined ? item.cost : '') + '" placeholder="留空"></label>'
    + '<div class="pkg-form-grid">'
    + '<label class="field"><span>归类</span>'
    + '<div class="select-box" id="ma-edit-media" data-value="' + ((item && item.video) ? 'video' : ((item && item.image) ? 'image' : 'chat')) + '" role="button" tabindex="0">'
    + '<span class="sb-label">' + ((item && item.video) ? '生视频模型' : ((item && item.image) ? '生图模型' : '对话模型')) + '</span>'
    + '<span class="sb-arrow"><svg class="oc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5L12 14.5 17 9.5"/></svg></span>'
    + '</div></label>'
    + '<div class="field"><span>&nbsp;</span>'
    + '<label class="user-form-admin ma-edit-enabled-row"><span class="switch"><input type="checkbox" id="ma-edit-enabled"' + (!item || item.enabled !== false ? ' checked' : '') + '><span class="slider"></span></span><span>启用</span></label>'
    + '</div>'
    + '</div>'
    + '<div class="field"><span>成员渠道' + (isAuto ? '（实时计算，只读）' : '（勾选后按下面的顺序生效）') + '</span>'
    + '<div class="ma-pick" id="ma-edit-pick">' + (pick || '<p class="muted small">还没有可选的供应商模型，请先在「供应商」里添加。</p>') + '</div>'
    + (isAuto ? '' : '<p class="muted small" id="ma-edit-count" style="margin:4px 0 0"></p>')
    + '</div>'
    + userProvNote()
    + '</div>'
    + '<div class="modal-footer"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="ma-edit-save">保存</button></div>'
    + '</div>';
  document.body.appendChild(wrap);
  const rm = () => wrap.remove();
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', rm));
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) rm(); });
  // 分流策略 / 归类:站内自定义下拉(与后台其它 select-box 同一套)
  const strategyBox = wrap.querySelector('#ma-edit-strategy');
  const mediaBox = wrap.querySelector('#ma-edit-media');
  const bindSelect = (box, opts) => {
    if (!box || !window.OC || !OC.openSelect) return;
    const labelOf = (v) => { const o = opts.find((x) => x.value === v); return o ? o.label : opts[0].label; };
    const sync = () => {
      const v = box.getAttribute('data-value') || opts[0].value;
      const lb = box.querySelector('.sb-label');
      if (lb) lb.textContent = labelOf(v);
    };
    const open = () => {
      OC.openSelect(box, opts, {
        selected: box.getAttribute('data-value') || opts[0].value,
        onSelect: (val) => { box.setAttribute('data-value', val); sync(); },
      });
    };
    box.addEventListener('click', open);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  };
  bindSelect(strategyBox, [{ value: 'failover', label: MA_STRATEGY_LABEL.failover }, { value: 'roundrobin', label: MA_STRATEGY_LABEL.roundrobin }]);
  bindSelect(mediaBox, [{ value: 'chat', label: '对话模型' }, { value: 'image', label: '生图模型' }, { value: 'video', label: '生视频模型' }]);
  // 已选成员的顺序 = 勾选状态在 DOM 里的先后(天然与渠道目录顺序一致),这里只提示条数
  const countEl = wrap.querySelector('#ma-edit-count');
  const syncCount = () => {
    if (!countEl) return;
    const n = wrap.querySelectorAll('#ma-edit-pick [data-ma-pick]:checked').length;
    countEl.textContent = '已选 ' + n + ' 个成员' + (n ? '' : '（至少选 1 个）');
  };
  wrap.querySelectorAll('#ma-edit-pick [data-ma-pick]').forEach((c) => c.addEventListener('change', syncCount));
  syncCount();
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(wrap);
  const saveBtn = wrap.querySelector('#ma-edit-save');
  saveBtn.addEventListener('click', async () => {
    const id = String(wrap.querySelector('#ma-edit-id').value || '').trim();
    if (!id) return toast('请填写汇总 ID', true);
    if (id.indexOf('agg:') === 0) return toast('汇总 ID 不能以 agg: 开头', true);
    const members = [];
    if (!isAuto) {
      wrap.querySelectorAll('#ma-edit-pick [data-ma-pick]:checked').forEach((c) => {
        const parts = String(c.dataset.maPick).split('|');
        members.push({ providerId: parts[0], model: parts.slice(1).join('|') });
      });
      if (!members.length) return toast('请至少选择一个成员模型', true);
    }
    const costRaw = String(wrap.querySelector('#ma-edit-cost').value || '').trim();
    const media = mediaBox ? (mediaBox.getAttribute('data-value') || 'chat') : 'chat';
    const payload = {
      group: {
        id,
        label: String(wrap.querySelector('#ma-edit-label').value || '').trim(),
        strategy: strategyBox ? (strategyBox.getAttribute('data-value') || 'failover') : 'failover',
        order: Math.max(0, parseInt(wrap.querySelector('#ma-edit-order').value, 10) || 0),
        cost: costRaw === '' ? null : Math.max(0, parseFloat(costRaw) || 0),
        image: media === 'image',
        video: media === 'video',
        enabled: !!wrap.querySelector('#ma-edit-enabled').checked,
        auto: isAuto,
        matchId: isAuto ? (item.matchId || item.id) : '',
        members,
      },
    };
    if (!isNew) payload.group.__origId = item.id;
    saveBtn.disabled = true;
    const okSave = await saveModelAggGroup(payload);
    saveBtn.disabled = false;
    if (okSave) rm();
  });
}

const TAB_LOADERS = {
  notes: loadNotesSettings,
  im: loadImSettings,
  web: loadWebSettings,
  toolbox: loadToolboxSettings,
  'ext-overview': () => loadExtOverview(),
  overview: () => { loadStats(); loadSystemBoard(); },
  usage: () => loadStats(),
  users: () => loadUsers(),
  groups: () => loadGroups(),
  access: async () => {
    await loadGroups();
    await loadAccess();
  },
  providers: () => loadProviders(),
  chat: () => loadChatSettings(),
  modelmeta: () => loadModelMeta(),
  modelagg: () => loadModelAgg(),
  perf: () => loadPerfSettings(),
  search: () => loadSearchSettings(),
  docs: () => loadSearchSettings(),
  oauth: () => loadOauthSettings(),
  verify: () => loadVerifySettings(),
  // 邀请码页的开关会触发「验证设置」保存:必须先加载完整表单,否则会把未加载的
  // SMTP/注册等默认值整包写回服务端(历史事故:SMTP 配置被清空)
  invite: () => loadVerifySettings(),
  openapi: () => loadOpenApi(),
  packages: () => loadPackages(),
  codes: () => loadPackages(),
  'codes-gen': () => loadPackages(),
  'codes-fixed': () => loadPackages(),
  assistants: () => loadAssistants(),
  logs: () => loadLogs(),
  thinking: () => loadThinking(),
  update: async () => {
    loadUpdatePanel();
    await loadBackups();
  },
  moderation: () => loadModeration(),
  announce: () => loadAnnouncement(),
  storage: () => loadStorage(),
};

// ============ 内容安全 ============
async function loadModeration() {
  const r = await api('/api/admin/settings');
  const d = await r.json();
  if (!r.ok) return toast((d.error && d.error.message) || '加载失败', true);
  const s = d.settings || {};
  const mod = s.moderation || {};
  if ($('mod-enabled')) $('mod-enabled').checked = !!mod.enabled;
  // 演示身份拿不到词表(后端只下发了空串):输入框置空置灰,并给出说明,避免误以为词库被清空
  const modRestricted = !!s.moderationRestricted;
  const modWords = $('mod-words');
  if (modWords) {
    modWords.value = modRestricted ? '' : (mod.words || '');
    modWords.disabled = modRestricted;
    modWords.placeholder = modRestricted ? '演示管理员不可查看敏感词库' : '示例词一\n示例词二';
  }
  if ($('mod-demo-note')) $('mod-demo-note').classList.toggle('hidden', !modRestricted);
  if ($('agreement-enabled')) $('agreement-enabled').checked = !!s.agreementEnabled;
  if ($('agreement-html')) $('agreement-html').value = s.agreementHtml || '';
}
(function initModeration() {
  const save = $('moderation-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const modWords = $('mod-words');
    // 词表被演示边界屏蔽时不要提交 words:提交空串等价于清空运营方词库
    const payload = {
      moderation: { enabled: !!($('mod-enabled') && $('mod-enabled').checked) },
      agreementEnabled: !!($('agreement-enabled') && $('agreement-enabled').checked),
      agreementHtml: ($('agreement-html') && $('agreement-html').value) || '',
    };
    if (!(modWords && modWords.disabled)) payload.moderation.words = (modWords && modWords.value) || '';
    save.disabled = true;
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '保存失败', true);
      toast('内容安全设置已保存');
      loadModeration();
    } catch (e) {
      toast('保存失败: ' + e.message, true);
    } finally { save.disabled = false; }
  });
})();

// ============ 全站公告 ============
let ANNOUNCE_LOADED_TEXT = '';
async function loadAnnouncement() {
  try {
    const r = await api('/api/admin/settings');
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '公告加载失败');
    const ann = (d.settings || {}).announcement || {};
    ANNOUNCE_LOADED_TEXT = ann.text || '';
    if ($('announce-enabled')) $('announce-enabled').checked = !!ann.enabled;
    if ($('announce-text')) $('announce-text').value = ANNOUNCE_LOADED_TEXT;
  } catch (e) {
    if ($('announce-status')) $('announce-status').textContent = '加载失败: ' + e.message;
  }
}
(function initAnnouncement() {
  const save = $('announce-save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const textEl = $('announce-text');
    const status = $('announce-status');
    const text = ((textEl && textEl.value) || '').trim();
    const enabled = !!($('announce-enabled') && $('announce-enabled').checked);
    if (enabled && !text) {
      if (status) status.textContent = '启用公告时请填写公告内容';
      if (textEl) textEl.focus();
      return toast('启用公告时请填写公告内容', true);
    }
    const payload = { announcement: { enabled, text } };
    const oldLabel = save.textContent;
    save.disabled = true;
    save.textContent = '保存中…';
    if (status) status.textContent = '正在保存…';
    try {
      const r = await api('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      const saved = (d.settings || {}).announcement || {};
      if (!!saved.enabled !== enabled || saved.text !== text) throw new Error('服务器未返回已保存的公告');
      ANNOUNCE_LOADED_TEXT = saved.text;
      if (textEl) textEl.value = saved.text;
      if (status) status.textContent = enabled ? '公告已发布' : '公告已关闭';
      toast(enabled ? '公告已发布' : '公告已关闭');
    } catch (e) {
      if (status) status.textContent = '保存失败: ' + e.message;
      toast('保存失败: ' + e.message, true);
    } finally {
      save.disabled = false;
      save.textContent = oldLabel;
    }
  });
})();

// ============ 用量导出 ============
$('usage-export')?.addEventListener('click', async () => {
  const btn = $('usage-export');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/usage/export');
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return toast('导出失败' + (d.error && d.error.message ? '：' + d.error.message : ''), true);
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tinychat-usage-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  } catch (e) {
    toast('导出失败: ' + e.message, true);
  } finally { btn.disabled = false; }
});

// ---------- AI 笔记:设置 + 使用用户列表 + 审阅 ----------
async function loadNotesSettings() {
  await ensureGroupsCache();
  const r = await api('/api/admin/settings');
  const s = ((await r.json()) || {}).settings || {};
  if ($('notes-enabled')) $('notes-enabled').checked = s.notesEnabled !== false;
  renderFeatureAccessBlock('notes', s);
  if ($('notes-allow-files')) $('notes-allow-files').checked = s.notesAllowFiles !== false;
  if ($('notes-quota')) $('notes-quota').value = Number(s.notesQuotaMb != null ? s.notesQuotaMb : 200);
  if ($('notes-max-file')) $('notes-max-file').value = Number(s.notesMaxFileMb != null ? s.notesMaxFileMb : 50);
  if ($('notes-max-image')) $('notes-max-image').value = Number(s.notesMaxImageMb != null ? s.notesMaxImageMb : 10);
  if ($('notes-share-body-only')) $('notes-share-body-only').checked = s.notesShareBodyOnly !== false;
  if ($('notes-ai-limit')) $('notes-ai-limit').value = Number(s.notesAiDailyLimit != null ? s.notesAiDailyLimit : 50);
  if ($('notes-ai-customizable')) $('notes-ai-customizable').checked = s.notesAiCustomizable !== false;
  // 用户列表默认折叠:仅在展开时才拉取,避免打开页面就发请求
  const body = $('notes-users-body');
  if (body && !body.hidden) await loadNotesUsers();
}
async function loadNotesUsers() {
  // 演示管理员:审阅用户笔记的服务端守卫是硬拒绝,这里直接不发请求(卡片也已隐藏)
  if (document.body.classList.contains('is-demo-admin')) return;
  const q = ($('notes-user-search') && $('notes-user-search').value.trim()) || '';
  const r = await api('/api/admin/notes' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
  const box = $('notes-users');
  if ($('notes-overview')) {
    $('notes-overview').textContent = d.users.length + ' 位用户 · 共 ' + d.notesTotal + ' 篇笔记 · 附件占用 ' + fmtBytesBig(d.totalUsed);
  }
  if (!d.users.length) { box.innerHTML = '<p class="muted small">还没有用户使用笔记。</p>'; return; }
  box.innerHTML = d.users.map((u) => ''
    + '<div class="pkg-card" style="display:flex;align-items:center;gap:10px">'
    + '<div style="flex:1;min-width:0">'
    + '<b>' + escapeHtml(u.name) + '</b>'
    + '<div class="muted small">' + u.notes + ' 篇笔记 · ' + u.folders + ' 个文件夹 · 附件 ' + fmtBytesBig(u.used)
    + (u.latestAt ? ' · 最近更新 ' + fmtTime(u.latestAt) : '') + '</div>'
    + '</div>'
    + '<button class="btn small" data-notes-view="' + escapeHtml(u.userId) + '">查看</button>'
    + '<button class="btn small danger" data-notes-purge="' + escapeHtml(u.userId) + '" data-name="' + escapeHtml(u.name) + '">清空</button>'
    + '</div>').join('');
  box.querySelectorAll('[data-notes-view]').forEach((b) => b.addEventListener('click', () => viewUserNotes(b.dataset.notesView)));
  box.querySelectorAll('[data-notes-purge]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await window.OCUI.confirm({
      title: '清空「' + b.dataset.name + '」的全部笔记？',
      message: '笔记、文件夹与附件文件都会被删除，且不可恢复（用户下次同步会得到空列表）。',
      danger: true, confirmText: '清空',
    });
    if (!ok) return;
    const r2 = await api('/api/admin/notes/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: b.dataset.notesView }) });
    const d2 = await r2.json().catch(() => ({}));
    if (!r2.ok) return toast((d2.error && d2.error.message) || '清理失败', true);
    toast('已清理（删除附件 ' + (d2.removedFiles || 0) + ' 个）');
    loadNotesUsers();
  }));
}
async function viewUserNotes(userId) {
  const r = await api('/api/admin/notes/view?userId=' + encodeURIComponent(userId));
  const d = await r.json();
  if (!r.ok) return toast((d.error && d.error.message) || '加载失败', true);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal modal-lg" role="dialog" aria-modal="true" style="max-width:900px">'
    + '<div class="modal-header"><h3>' + escapeHtml(d.name) + ' 的笔记（' + (d.notes || []).length + ' 篇）</h3>'
    + '<button class="icon-btn" data-close aria-label="关闭">×</button></div>'
    + '<div class="modal-body" style="max-height:70vh;overflow:auto">'
    + ((d.notes || []).length ? d.notes.map((n) => ''
      + '<details style="margin-bottom:10px;border:1px solid var(--hairline);border-radius:10px;padding:8px 12px">'
      + '<summary style="cursor:pointer;font-weight:600">' + escapeHtml(n.title || '无标题') + '</summary>'
      + '<div class="muted small" style="margin:6px 0">' + (n.tags || []).map((t) => '#' + escapeHtml(t)).join(' ')
      + ' · ' + fmtTime(n.updatedAt) + ' · ' + ((n.content || '').length) + ' 字</div>'
      + '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12.5px;max-height:320px;overflow:auto">' + escapeHtml(n.content || '') + '</pre>'
      + '</details>').join('') : '<p class="muted small">该用户还没有笔记。</p>')
    + '</div></div>';
  document.body.appendChild(mask);
  const closeDlg = () => window.OCUI.closeModal(mask), rm = () => { closeDlg(); setTimeout(() => mask.remove(), 340); };
  mask.querySelector('[data-close]').addEventListener('click', rm);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) rm(); });
  mask._onClose = closeDlg;
  window.OCUI.openModal(mask);
}

const ADMIN_GROUPS = {
  // 二级首项叫「运营数据」,避免与上方一级分组「概览」重名让人分不清
  overview: [{ id: 'overview', label: '运营数据' }, { id: 'usage', label: '用量分析' }, { id: 'announce', label: '全站公告' }, { id: 'logs', label: '运行日志' }],
  // 拓展功能:三个「对话之外的附加面板」单独成组。此前散在「平台配置」里,与供应商/邮件/存储
  // 这类基础设施混在一起;它们共同点是「面向用户的附加功能」,还共享同一套可见性模型。
  extensions: [{ id: 'ext-overview', label: '总览' }, { id: 'web', label: '在线浏览器' }, { id: 'toolbox', label: '在线工具箱' }, { id: 'notes', label: 'AI 笔记' }, { id: 'im', label: '在线聊天' }],
  users: [{ id: 'users', label: '用户' }, { id: 'groups', label: '用户组' }, { id: 'access', label: '模型授权' }, { id: 'verify', label: '用户验证' }, { id: 'invite', label: '邀请码' }],
  billing: [
    { id: 'packages', label: '额度套餐' },
    { id: 'codes', label: '兑换码使用情况' },
    { id: 'codes-gen', label: '生成兑换码' },
    { id: 'codes-fixed', label: '添加固定兑换码' },
  ],
  platform: [{ id: 'providers', label: '供应商' }, { id: 'modelmeta', label: '模型元数据' }, { id: 'modelagg', label: '模型汇总' }, { id: 'thinking', label: 'AI 思考' }, { id: 'chat', label: '对话设置' }, { id: 'perf', label: '性能优化' }, { id: 'openapi', label: '开放 API' }, { id: 'search', label: '联网搜索' }, { id: 'docs', label: '文档解析' }, { id: 'moderation', label: '内容安全' }, { id: 'oauth', label: '第三方登录' }, { id: 'storage', label: '存储管理' }, { id: 'update', label: '版本更新' }],
  thinking: [{ id: 'thinking', label: '思考策略' }],
  content: [{ id: 'assistants', label: '助手库' }],
};
function adminGroupForTab(tab) { return Object.keys(ADMIN_GROUPS).find((g) => ADMIN_GROUPS[g].some((x) => x.id === tab)) || 'overview'; }
function renderAdminSubnav(group, selected) {
  const box = $('admin-subnav'); if (!box) return;
  const items = ADMIN_GROUPS[group] || [];
  box.classList.toggle('is-single', items.length < 2);
  box.innerHTML = items.map((x) => '<button class="admin-subnav-btn' + (x.id === selected ? ' active' : '') + '" type="button" data-tab="' + x.id + '" role="tab" aria-selected="' + (x.id === selected ? 'true' : 'false') + '">' + x.label + '</button>').join('');
}
function showAdminTab(name, { load = true } = {}) {
  const group = adminGroupForTab(name);
  const entry = (ADMIN_GROUPS[group] || []).find((x) => x.id === name) || ADMIN_GROUPS[group][0];
  name = entry.id;
  document.querySelectorAll('.admin-group-tab').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
  renderAdminSubnav(group, name);
  document.querySelectorAll('.admin-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  const hash = '#' + group + '/' + name;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  const loader = TAB_LOADERS[name];
  if (load && loader && !tabLoaded[name]) { tabLoaded[name] = true; Promise.resolve(loader()).catch((e) => toast('加载失败: ' + e.message, true)); }
  return true;
}

document.addEventListener('click', async (e) => {
  const toggle = e.target.closest('#notes-users-toggle');
  if (toggle) {
    const body = $('notes-users-body');
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) loadNotesUsers().catch((err) => toast('加载失败: ' + err.message, true));
    return;
  }
  const save = e.target.closest('#notes-settings-save');
  if (save) {
    save.disabled = true;
    try {
      const body = {
        notesEnabled: $('notes-enabled').checked,
        notesAllowFiles: $('notes-allow-files').checked,
        notesQuotaMb: Number($('notes-quota').value || 0),
        notesMaxFileMb: Number($('notes-max-file').value || 50),
        notesMaxImageMb: Number($('notes-max-image').value || 10),
        notesShareBodyOnly: $('notes-share-body-only').checked,
        notesAiDailyLimit: Number($('notes-ai-limit').value || 0),
        notesAiCustomizable: $('notes-ai-customizable').checked,
        ...(readFeatureAccess('notes') || {}),
      };
      const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      toast('笔记设置已保存');
      await loadNotesSettings();
    } catch (err) {
      toast(err.message || '保存失败', true);
    } finally { save.disabled = false; }
    return;
  }
  const imSave = e.target.closest('#im-settings-save');
  if (imSave) {
    imSave.disabled = true;
    try {
      const body = {
        imEnabled: $('im-enabled').checked,
        imAllowFiles: $('im-allow-files').checked,
        imMutualFriends: $('im-mutual-friends').checked,
        imVisibleUsers: $('im-visible-users').value,
        imQuotaMb: Number($('im-quota').value || 0),
        imMaxFileMb: Number($('im-max-file').value || 20),
        imMaxImageMb: Number($('im-max-image').value || 10),
        imAiDailyLimit: Number($('im-ai-limit').value || 0),
        ...(readFeatureAccess('im') || {}),
      };
      const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      toast('聊天设置已保存');
      await loadImSettings();
    } catch (err) {
      toast(err.message || '保存失败', true);
    } finally { imSave.disabled = false; }
    return;
  }
  const webSave = e.target.closest('#web-settings-save');
  if (webSave) {
    webSave.disabled = true;
    try {
      const body = {
        browserEnabled: $('web-enabled').checked,
        webCnOnly: $('web-cn-only').checked,
        webCnAllowAssets: $('web-cn-allow-assets').checked,
        webCnWhitelistEnabled: $('web-cn-whitelist-enabled').checked,
        webCnWhitelist: $('web-cn-whitelist').value,
        webConcurrency: Number($('web-concurrency').value || 6),
        webAiDailyLimit: Number($('web-ai-limit').value || 0),
        webDailyTrafficMb: Number($('web-traffic-mb').value || 0),
        webBookmarks: parseWebBookmarks($('web-bookmarks').value),
        ...(readFeatureAccess('web') || {}),
      };
      const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      toast('浏览器设置已保存');
      await loadWebSettings();
    } catch (err) {
      toast(err.message || '保存失败', true);
    } finally { webSave.disabled = false; }
    return;
  }
  const toolboxSave = e.target.closest('#toolbox-settings-save');
  if (toolboxSave) {
    toolboxSave.disabled = true;
    try {
      const body = {
        toolboxEnabled: $('toolbox-enabled').checked,
        ...(readFeatureAccess('toolbox') || {}),
      };
      const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
      toast('工具箱设置已保存');
      await loadToolboxSettings();
    } catch (err) {
      toast(err.message || '保存失败', true);
    } finally { toolboxSave.disabled = false; }
    return;
  }
  if (e.target.closest('#im-threads-refresh')) {
    loadImThreads().catch((err) => toast('加载失败: ' + err.message, true));
    return;
  }
  // ---- 系统工具(全员共用)的增删改 ----
  if (e.target.closest('#toolbox-sys-save')) { saveToolboxSystem(); return; }
  if (e.target.closest('#toolbox-sys-reload')) {
    if (TBOX_SYS.dirty) {
      const go = async () => {
        const ok = window.OCUI && window.OCUI.confirm
          ? await window.OCUI.confirm({ title: '放弃改动', message: '有未保存的改动，重新载入会丢掉它们，确定吗？', danger: true, confirmText: '重新载入' })
          : window.confirm('有未保存的改动，重新载入会丢掉它们，确定吗？');
        if (ok) loadToolboxSystem(true);
      };
      go();
    } else {
      loadToolboxSystem(true);
    }
    return;
  }
  if (e.target.closest('#tsys-cat-add')) { tboxSysAddCategory(); return; }
  if (e.target.closest('#tsys-item-add')) { tboxSysAddItem(); return; }
  const catRen = e.target.closest('[data-tsys-cat-ren]');
  if (catRen) {
    const id = catRen.getAttribute('data-tsys-cat-ren');
    const cur = ((TBOX_SYS.doc.cats || []).find((c) => String(c.id) === String(id)) || {}).name || '';
    const ask = window.OCUI && window.OCUI.prompt
      ? window.OCUI.prompt({ title: '重命名分类', value: cur, maxlength: 20, confirmText: '保存' })
      : Promise.resolve(window.prompt('新分类名称', cur));
    ask.then((name) => {
      const v = String(name == null ? '' : name).trim();
      if (!v || v === cur) return;
      (TBOX_SYS.doc.cats || []).forEach((c) => { if (String(c.id) === String(id)) c.name = v; });
      renderToolboxSystem();
      markTboxSysDirty();
    });
    return;
  }
  const catDel = e.target.closest('[data-tsys-cat-del]');
  if (catDel) { tboxSysDeleteCategory(catDel.getAttribute('data-tsys-cat-del')); return; }
  const itemToggle = e.target.closest('[data-tsys-toggle]');
  if (itemToggle) {
    const row = itemToggle.closest('[data-tsys-item]');
    const tb = row && row.querySelector('.tbox-sys-html');
    if (tb) tb.classList.toggle('hidden');
    return;
  }
  const itemDel = e.target.closest('[data-tsys-del]');
  if (itemDel) { tboxSysDeleteItem(itemDel.getAttribute('data-tsys-del')); return; }
});
document.addEventListener('keydown', (e) => {
  const toggle = e.target.closest && e.target.closest('#notes-users-toggle');
  if (!toggle) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle.click(); }
});

// ---------- 拓展功能:可见性(总开关之外的「谁能用」) ----------
// 三个功能共用同一套模型:<feat>Enabled 是全站总开关,<feat>Access 决定可见范围
// (all=所有人 / admin=仅管理员 / list=仅名单),名单支持用户名与用户组。
// 服务端 tc_feature_allowed 是唯一权威,这里只负责把同一份设置渲染出来。
const FEATURE_META = {
  web: { label: '在线浏览器', desc: '服务端代理抓取网页并在同源下渲染' },
  notes: { label: 'AI 笔记', desc: 'Markdown 写作、附件上传与分享' },
  im: { label: '在线聊天', desc: '好友、单聊与群聊' },
  toolbox: { label: '在线工具箱', desc: '用户自存 HTML 单页,在沙箱里打开运行' },
};

// 渲染一个功能的「可见范围」区块;分组列表按需从 /api/admin/groups 拉取并缓存
let adminGroupsCache = null;
async function ensureGroupsCache() {
  if (adminGroupsCache) return adminGroupsCache;
  try {
    const r = await api('/api/admin/groups');
    const d = await r.json();
    adminGroupsCache = Array.isArray(d.groups) ? d.groups : [];
  } catch (e) { adminGroupsCache = []; }
  return adminGroupsCache;
}

function renderFeatureAccessBlock(feat, s) {
  const host = $(feat + '-access-block');
  if (!host) return;
  const mode = ['all', 'admin', 'list'].indexOf(s[feat + 'Access']) >= 0 ? s[feat + 'Access'] : 'all';
  const users = Array.isArray(s[feat + 'AccessUsers']) ? s[feat + 'AccessUsers'].join(', ') : '';
  const groups = Array.isArray(s[feat + 'AccessGroups']) ? s[feat + 'AccessGroups'].map(String) : [];
  const list = adminGroupsCache || [];
  // 只在需要时重建 DOM:每次加载都整块重写会把用户正在输入的内容抹掉
  if (host.dataset.rendered !== '1') {
    host.innerHTML =
      '<div class="feat-access">'
      + '<div class="feat-access-head"><b>可见范围</b>'
      + '<span class="muted small">管理员始终可用，不受此处限制</span></div>'
      + '<div class="feat-access-modes">'
      + '<label><input type="radio" name="' + feat + '-access" value="all"> <span>所有人</span></label>'
      + '<label><input type="radio" name="' + feat + '-access" value="admin"> <span>仅管理员</span></label>'
      + '<label><input type="radio" name="' + feat + '-access" value="list"> <span>仅名单内</span></label>'
      + '</div>'
      + '<div class="feat-access-lists">'
      + '<label class="field"><span>允许的用户名（逗号或换行分隔）</span>'
      + '<input id="' + feat + '-access-users" type="text" autocomplete="off" placeholder="如：Alice, Bob"></label>'
      + '<div class="field"><span>允许的用户组（可多选）</span><div class="feat-access-groups" id="' + feat + '-access-groups"></div></div>'
      + '</div>'
      + '</div>';
    host.dataset.rendered = '1';
  }
  const gbox = $(feat + '-access-groups');
  if (gbox) {
    const want = list.map((g) => ({ id: String(g.id), name: String(g.name || g.id), on: groups.indexOf(String(g.id)) >= 0 }));
    // 分组列表为空(还没建组)时给一句说明,免得看起来像丢了控件
    gbox.innerHTML = want.length
      ? want.map((g) => '<label class="feat-access-group"><input type="checkbox" data-gid="' + escapeHtml(g.id) + '"'
          + (g.on ? ' checked' : '') + '> <span>' + escapeHtml(g.name) + '</span></label>').join('')
      : '<p class="muted small">还没有用户组，可在「用户与权限 → 用户组」新建。</p>';
  }
  host.querySelectorAll('input[type=radio][name="' + feat + '-access"]').forEach((el) => { el.checked = el.value === mode; });
  const uEl = $(feat + '-access-users');
  if (uEl && document.activeElement !== uEl) uEl.value = users;
  // 只有「仅名单内」需要填名单,其余两种模式下把名单区收起来,减少误操作
  const lists = host.querySelector('.feat-access-lists');
  if (lists) lists.classList.toggle('hidden', mode !== 'list');
}

// 读回某个功能的可见性设置,拼进保存体
function readFeatureAccess(feat) {
  const host = $(feat + '-access-block');
  if (!host || host.dataset.rendered !== '1') return null;
  const picked = host.querySelector('input[type=radio][name="' + feat + '-access"]:checked');
  const mode = picked ? picked.value : 'all';
  const uEl = $(feat + '-access-users');
  const gEl = $(feat + '-access-groups');
  const groups = [];
  if (gEl) gEl.querySelectorAll('input[type=checkbox][data-gid]').forEach((el) => { if (el.checked) groups.push(el.dataset.gid); });
  const body = {};
  body[feat + 'Access'] = mode;
  body[feat + 'AccessUsers'] = uEl ? uEl.value : '';
  body[feat + 'AccessGroups'] = groups;
  return body;
}

// 「仅名单内」被选中时展开名单区(事件委托,页面只挂一次)
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el || el.type !== 'radio' || !el.name || !/-access$/.test(el.name)) return;
  const feat = el.name.replace(/-access$/, '');
  const host = $(feat + '-access-block');
  const lists = host && host.querySelector('.feat-access-lists');
  if (lists) lists.classList.toggle('hidden', el.value !== 'list');
});

// ---------- 拓展功能:总览(三个功能一眼看全) ----------
async function loadExtOverview() {
  await ensureGroupsCache();
  const r = await api('/api/admin/settings');
  const s = ((await r.json()) || {}).settings || {};
  const switchOn = { web: s.browserEnabled !== false, notes: s.notesEnabled !== false, im: s.imEnabled !== false, toolbox: s.toolboxEnabled !== false };
  const modeText = (feat) => {
    const m = s[feat + 'Access'];
    if (m === 'admin') return '仅管理员';
    if (m === 'list') {
      const u = Array.isArray(s[feat + 'AccessUsers']) ? s[feat + 'AccessUsers'].length : 0;
      const g = Array.isArray(s[feat + 'AccessGroups']) ? s[feat + 'AccessGroups'].length : 0;
      return '仅名单（' + u + ' 个用户 · ' + g + ' 个分组）';
    }
    return '所有人';
  };
  const grid = $('ext-status-grid');
  if (grid) {
    grid.innerHTML = ['web', 'toolbox', 'notes', 'im'].map((f) => {
      const on = switchOn[f];
      const mode = modeText(f);
      const effective = !on ? '已关闭' : (mode === '所有人' ? '所有登录用户' : mode);
      return '<div class="ext-tile' + (on ? '' : ' off') + '">'
        + '<div class="ext-tile-head"><span class="ext-tile-name">' + FEATURE_META[f].label + '</span>'
        + '<span class="ext-tile-badge' + (on ? ' on' : '') + '">' + (on ? '已开启' : '已关闭') + '</span></div>'
        + '<p class="ext-tile-desc">' + FEATURE_META[f].desc + '</p>'
        + '<p class="ext-tile-state">可用范围：<b>' + escapeHtml(effective) + '</b></p>'
        + '<button class="btn small" type="button" data-ext-go="' + f + '">前往设置</button>'
        + '</div>';
    }).join('');
    grid.querySelectorAll('[data-ext-go]').forEach((b) => b.addEventListener('click', () => showAdminTab(b.dataset.extGo)));
  }
  const note = $('ext-status-note');
  if (note) {
    const anyOff = ['web', 'toolbox', 'notes', 'im'].some((f) => !switchOn[f]);
    note.textContent = anyOff
      ? '提醒：已关闭的功能会连同其接口一起拒绝，前台入口也不显示。'
      : '这些功能当前都开着。修改后用户下次刷新页面生效。';
  }
}

// ---------- 在线工具箱:设置(总开关 / 可见范围) ----------
async function loadToolboxSettings() {
  await ensureGroupsCache();
  const r = await api('/api/admin/settings');
  const s = ((await r.json()) || {}).settings || {};
  if ($('toolbox-enabled')) $('toolbox-enabled').checked = s.toolboxEnabled !== false;
  renderFeatureAccessBlock('toolbox', s);
  // 系统工具那一卡也一起带上(已加载过就不重复拉,免得把正在编辑的改动冲掉)
  await loadToolboxSystem();
}

// ---------- 在线工具箱:系统工具(全员共用,后台增删改) ----------
// 本地改、整体存:与前台同步同一套「整份文档」模型。逐条保存会在「删除分类」与
// 「改工具归属」之间留下半保存状态,前台那一刻会看到悬空的归属;整份存没有这个问题。
// DOM 是这一卡的唯一数据源:保存时从输入框读回,而不是维护一份容易与界面走样的副本。
const TBOX_SYS = { doc: { cats: [], items: [] }, limits: {}, loaded: false, dirty: false, changed: {} };

function tboxSysUid() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function setTboxSysStatus(msg, isErr) {
  const el = $('toolbox-sys-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}
function markTboxSysDirty(id) {
  if (id) TBOX_SYS.changed[String(id)] = true;
  TBOX_SYS.dirty = true;
  setTboxSysStatus('有未保存的改动');
}

async function loadToolboxSystem(force) {
  if (TBOX_SYS.loaded && !force) return;
  const host = $('toolbox-sys-body');
  if (!host) return;
  try {
    const r = await api('/api/admin/toolbox');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
    const doc = d.doc || {};
    TBOX_SYS.doc = {
      cats: Array.isArray(doc.cats) ? doc.cats : [],
      items: Array.isArray(doc.items) ? doc.items : [],
    };
    TBOX_SYS.limits = d.limits || {};
    TBOX_SYS.loaded = true;
    TBOX_SYS.dirty = false;
    TBOX_SYS.changed = {};
    renderToolboxSystem();
  } catch (err) {
    host.innerHTML = '<p class="muted small">系统工具加载失败：' + escapeHtml(err.message || '') + '</p>';
  }
}

function tboxSysCatOptions(selected) {
  const cats = TBOX_SYS.doc.cats || [];
  return '<option value="">未分类</option>' + cats.map((c) =>
    '<option value="' + escapeHtml(c.id) + '"' + (String(c.id) === String(selected || '') ? ' selected' : '') + '>'
    + escapeHtml(c.name) + '</option>').join('');
}

function tboxSysRowHtml(it) {
  const id = escapeHtml(it.id);
  return '<div class="tbox-sys-item" data-tsys-item="' + id + '"'
    + ' data-created="' + escapeHtml(it.createdAt || '') + '" data-updated="' + escapeHtml(it.updatedAt || '') + '">'
    + '<div class="tbox-sys-head">'
    + '<input class="tbox-sys-title" data-tsys-field="title" type="text" maxlength="60"'
    + ' value="' + escapeHtml(it.title || '') + '" placeholder="工具名称" autocomplete="off">'
    + '<select class="tbox-sys-cat" data-tsys-field="cat">' + tboxSysCatOptions(it.cat) + '</select>'
    + '<button class="btn small" type="button" data-tsys-toggle="' + id + '">源码</button>'
    + (it.pageUrl ? '<a class="btn small" data-tsys-open target="_blank" rel="noopener" href="' + escapeHtml(apiUrl(it.pageUrl)) + '">打开</a>' : '')
    + '<button class="btn small danger" type="button" data-tsys-del="' + id + '">删除</button>'
    + '</div>'
    // HTML 一律走转义后放进 textarea 的文本节点:直接拼会让工具内容里的 </textarea> 破框,
    // 那一步等于在后台上执行任意 HTML。工具数据只以「文本」身份进出。
    + '<textarea class="tbox-sys-html hidden" data-tsys-field="html" spellcheck="false" wrap="off"'
    + ' placeholder="整个页面的 HTML，可含脚本与样式">' + escapeHtml(it.html || '') + '</textarea>'
    + '</div>';
}

function renderToolboxSystem() {
  const host = $('toolbox-sys-body');
  if (!host) return;
  const cats = TBOX_SYS.doc.cats || [];
  const list = TBOX_SYS.doc.items || [];
  const max = TBOX_SYS.limits.maxSysItems || 200;
  host.innerHTML =
    '<div class="tbox-sys-cats">'
    + '<span class="muted small">分类：</span>'
    + (cats.length
      ? cats.map((c) => '<span class="tbox-sys-chip">' + escapeHtml(c.name)
        + '<button type="button" data-tsys-cat-ren="' + escapeHtml(c.id) + '" title="重命名">&#9998;</button>'
        + '<button type="button" data-tsys-cat-del="' + escapeHtml(c.id) + '" title="删除分类">&#215;</button></span>').join('')
      : '<span class="muted small">（还没有分类，工具都归在「未分类」）</span>')
    + '<input class="tbox-sys-newcat" id="tsys-cat-new" type="text" placeholder="新分类名称" maxlength="20" autocomplete="off">'
    + '<button class="btn small" id="tsys-cat-add" type="button">新建分类</button>'
    + '</div>'
    + '<div class="tbox-sys-list">'
    + (list.length ? list.map((it) => tboxSysRowHtml(it)).join('')
      : '<p class="muted small">还没有系统工具。点下面的「新增系统工具」加一个——前台所有人都会看到它。</p>')
    + '</div>'
    + '<div class="tbox-sys-foot">'
    + '<button class="btn small" id="tsys-item-add" type="button">＋ 新增系统工具</button>'
    + '<span class="muted small">共 ' + list.length + ' / ' + max + ' 个</span>'
    + '</div>';
  // 与后台其它下拉保持同一观感;enhanceSelect 只是隐藏原生 select,value/change 语义不变,
  // 所以保存时照样 row.querySelector('select').value 读得到。
  if (window.OC && typeof window.OC.enhanceSelects === 'function') window.OC.enhanceSelects(host);
  TBOX_SYS.dirty = false;
  setTboxSysStatus('');
}

// 从界面读回整份文档。createdAt 沿用首次渲染时的值(服务端只在我们没给的时候才补 now),
// 有改动的行把 updatedAt 推到当前时间(改动记在 TBOX_SYS.changed 里 —— 结构性操作会重建
// DOM,行元素上的标记会跟着没掉)。
function readToolboxSystemDoc() {
  const host = $('toolbox-sys-body');
  const items = [];
  host.querySelectorAll('[data-tsys-item]').forEach((row) => {
    const id = row.getAttribute('data-tsys-item');
    const title = String(row.querySelector('[data-tsys-field="title"]').value || '').trim() || '未命名工具';
    const cat = String(row.querySelector('[data-tsys-field="cat"]').value || '');
    const html = String(row.querySelector('[data-tsys-field="html"]').value || '');
    items.push({
      id: id,
      cat: cat,
      title: title,
      html: html,
      createdAt: Number(row.getAttribute('data-created')) || Date.now(),
      updatedAt: TBOX_SYS.changed[id] ? Date.now() : (Number(row.getAttribute('data-updated')) || Date.now()),
    });
  });
  return { cats: TBOX_SYS.doc.cats || [], items: items };
}

// 结构性操作(增删分类 / 增删工具)会整体重渲染,先把界面上的编辑收回内存,
// 否则「改了两个工具的名字,又去新建一个分类」会把那两处改动悄悄丢掉。
function syncToolboxSystemFromDom() {
  const host = $('toolbox-sys-body');
  if (!host || !host.querySelector('[data-tsys-item]')) return;
  TBOX_SYS.doc.items = readToolboxSystemDoc().items;
}

async function saveToolboxSystem() {
  const btn = $('toolbox-sys-save');
  if (btn) btn.disabled = true;
  try {
    const doc = readToolboxSystemDoc();
    const r = await api('/api/admin/toolbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: doc }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || '保存失败');
    const saved = d.doc || {};
    TBOX_SYS.doc = {
      cats: Array.isArray(saved.cats) ? saved.cats : [],
      items: Array.isArray(saved.items) ? saved.items : [],
    };
    TBOX_SYS.changed = {};
    renderToolboxSystem();
    toast('系统工具已保存，前台刷新后生效');
  } catch (err) {
    setTboxSysStatus(err.message || '保存失败', true);
    toast(err.message || '保存失败', true);
  } finally { if (btn) btn.disabled = false; }
}

async function tboxSysAddCategory() {
  const input = $('tsys-cat-new');
  if (!input) return;
  const name = String(input.value || '').trim();
  if (!name) return toast('请先填分类名称', true);
  const cats = TBOX_SYS.doc.cats || [];
  if (cats.length >= (TBOX_SYS.limits.maxCats || 50)) return toast('分类数量已达上限', true);
  if (cats.some((c) => String(c.name) === name)) return toast('已经有同名分类了', true);
  syncToolboxSystemFromDom();
  let id = tboxSysUid();
  while (cats.some((c) => String(c.id) === id)) id = tboxSysUid();
  cats.push({ id: id, name: name });
  TBOX_SYS.doc.cats = cats;
  renderToolboxSystem();
  markTboxSysDirty();
}

// 删分类不删工具,只把它们的归属清空(与服务端/前台的宽容策略一致:归属指向不存在的分类
// 时前台按「未分类」显示,但存回去时明确清掉更干净)
function tboxSysDeleteCategory(id) {
  syncToolboxSystemFromDom();
  TBOX_SYS.doc.cats = (TBOX_SYS.doc.cats || []).filter((c) => String(c.id) !== String(id));
  (TBOX_SYS.doc.items || []).forEach((it) => {
    if (String(it.cat || '') === String(id)) { it.cat = ''; markTboxSysDirty(it.id); }
  });
  renderToolboxSystem();
  markTboxSysDirty();
}

function tboxSysAddItem() {
  syncToolboxSystemFromDom();
  const list = TBOX_SYS.doc.items || [];
  if (list.length >= (TBOX_SYS.limits.maxSysItems || 200)) return toast('系统工具数量已达上限', true);
  const id = tboxSysUid();
  // 给一个能直接跑的最小骨架:与前台「新建工具」同一份模板,省得对着空白框发呆
  list.push({
    id: id,
    cat: '',
    title: '新工具',
    html: '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>新工具</title>\n</head>\n<body>\n  <h1>你好</h1>\n</body>\n</html>\n',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  TBOX_SYS.doc.items = list;
  TBOX_SYS.changed[id] = true;
  renderToolboxSystem();
  markTboxSysDirty();
  const row = ($('toolbox-sys-body') || document).querySelector('[data-tsys-item="' + id + '"]');
  if (row) {
    const tb = row.querySelector('.tbox-sys-html');
    if (tb) { tb.classList.remove('hidden'); tb.focus(); }
  }
}

async function tboxSysDeleteItem(id) {
  const it = (TBOX_SYS.doc.items || []).find((x) => String(x.id) === String(id));
  const name = (it && it.title) || '这个工具';
  const msg = '确认从系统工具箱删除「' + name + '」？保存后前台所有人都不再看到它。';
  const ok = window.OCUI && window.OCUI.confirm
    ? await window.OCUI.confirm({ title: '删除系统工具', message: msg, danger: true, confirmText: '删除' })
    : window.confirm(msg);
  if (!ok) return;
  syncToolboxSystemFromDom();
  TBOX_SYS.doc.items = (TBOX_SYS.doc.items || []).filter((x) => String(x.id) !== String(id));
  delete TBOX_SYS.changed[id];
  renderToolboxSystem();
  markTboxSysDirty();
}

// ---------- 在线浏览器:设置(总开关 / 可见范围 / 总结次数上限 / 主页收藏夹) ----------
async function loadWebSettings() {
  await ensureGroupsCache();
  const r = await api('/api/admin/settings');
  const s = ((await r.json()) || {}).settings || {};
  if ($('web-enabled')) $('web-enabled').checked = s.browserEnabled !== false;
  if ($('web-cn-only')) $('web-cn-only').checked = s.webCnOnly !== false;
  if ($('web-cn-allow-assets')) $('web-cn-allow-assets').checked = s.webCnAllowAssets !== false;
  if ($('web-cn-whitelist-enabled')) $('web-cn-whitelist-enabled').checked = s.webCnWhitelistEnabled !== false;
  // 白名单留空表示「用内置默认」,此时把内置默认填进输入框 —— 让管理员看到实际生效的名单,
  // 否则输入框空空如也、却拦下了预期外的域名(默认名单在服务端),无从排查。
  if ($('web-cn-whitelist')) {
    const wl = typeof s.webCnWhitelist === 'string' ? s.webCnWhitelist : '';
    $('web-cn-whitelist').value = wl.trim() !== ''
      ? wl
      : (typeof s.webCnWhitelistDefault === 'string' ? s.webCnWhitelistDefault : '');
  }
  if ($('web-concurrency')) $('web-concurrency').value = Number(s.webConcurrency != null ? s.webConcurrency : 6);
  if ($('web-ai-limit')) $('web-ai-limit').value = Number(s.webAiDailyLimit != null ? s.webAiDailyLimit : 50);
  if ($('web-traffic-mb')) $('web-traffic-mb').value = Number(s.webDailyTrafficMb != null ? s.webDailyTrafficMb : 500);
  renderFeatureAccessBlock('web', s);
  if ($('web-bookmarks')) {
    const list = Array.isArray(s.webBookmarks) ? s.webBookmarks : [];
    $('web-bookmarks').value = list.map((b) => (b && b.name ? b.name + '|' + (b.url || '') : '')).filter((x) => x.indexOf('|') > 0).join('\n');
  }
}

// 「名称|网址」逐行解析;网址缺协议时补 https://
function parseWebBookmarks(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t) return;
    const at = t.indexOf('|');
    let name = '', url = '';
    if (at < 0) { name = t; url = t; } else { name = t.slice(0, at).trim(); url = t.slice(at + 1).trim(); }
    if (!name || !url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    out.push({ name: name.slice(0, 40), url: url.slice(0, 500) });
  });
  return out;
}

// ---------- 在线聊天:设置 + 会话与留档 ----------
async function loadImSettings() {
  await ensureGroupsCache();
  const r = await api('/api/admin/settings');
  const s = ((await r.json()) || {}).settings || {};
  if ($('im-enabled')) $('im-enabled').checked = s.imEnabled !== false;
  renderFeatureAccessBlock('im', s);
  if ($('im-allow-files')) $('im-allow-files').checked = s.imAllowFiles !== false;
  if ($('im-mutual-friends')) $('im-mutual-friends').checked = s.imMutualFriends === true;
  if ($('im-visible-users')) $('im-visible-users').value = Array.isArray(s.imVisibleUsers) ? s.imVisibleUsers.join(', ') : (s.imVisibleUsers || '');
  if ($('im-quota')) $('im-quota').value = Number(s.imQuotaMb != null ? s.imQuotaMb : 500);
  if ($('im-max-file')) $('im-max-file').value = Number(s.imMaxFileMb != null ? s.imMaxFileMb : 20);
  if ($('im-max-image')) $('im-max-image').value = Number(s.imMaxImageMb != null ? s.imMaxImageMb : 10);
  if ($('im-ai-limit')) $('im-ai-limit').value = Number(s.imAiDailyLimit != null ? s.imAiDailyLimit : 50);
  await loadImThreads();
}

function imThreadTitle(t) {
  if (t.type === 'group') return '群聊：' + (t.title || '未命名');
  const names = (t.members || []).map((m) => m.name).filter((n) => !!n);
  return '单聊：' + (names.join(' & ') || '未知成员');
}

async function loadImThreads() {
  // 演示管理员:聊天查看与留档清理都被服务端拒绝,这里直接不发请求(卡片也已隐藏)
  if (document.body.classList.contains('is-demo-admin')) return;
  const r = await api('/api/admin/im/threads');
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
  const box = $('im-threads');
  if (!box) return;
  const live = d.threads.filter((t) => !t.archived).length;
  if ($('im-threads-overview')) {
    $('im-threads-overview').textContent = d.threads.length + ' 个会话（在线 ' + live + ' / 留档 ' + (d.threads.length - live) + '）';
  }
  if (!d.threads.length) { box.innerHTML = '<p class="muted small">还没有会话。</p>'; return; }
  box.innerHTML = d.threads.map((t) => ''
    + '<div class="pkg-card" style="display:flex;align-items:center;gap:10px">'
    + '<div style="flex:1;min-width:0">'
    + '<b>' + escapeHtml(imThreadTitle(t)) + '</b>'
    + '<span class="muted small" style="margin-left:6px">' + (t.archived ? '留档' : '在线') + (t.aiEnabled ? ' · AI 模式' : '') + '</span>'
    + '<div class="muted small">' + escapeHtml((t.members || []).map((m) => m.name).join('、')) + ' · 消息 ' + t.msgCount + ' 条 · 留档原文 ' + t.tombCount + ' 条'
    + (t.lastMsgAt ? ' · 最近 ' + fmtTime(t.lastMsgAt) : '') + '</div>'
    + '</div>'
    + '<button class="btn small" data-im-view="' + escapeHtml(t.id) + '">查看</button>'
    + ((t.tombCount || t.archived) ? '<button class="btn small danger" data-im-purge="' + escapeHtml(t.id) + '">清理</button>' : '')
    + '</div>').join('');
  box.querySelectorAll('[data-im-view]').forEach((b) => b.addEventListener('click', () => viewImThread(b.dataset.imView)));
  box.querySelectorAll('[data-im-purge]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await window.OCUI.confirm({
      title: '彻底清理该会话的留档？',
      message: '留档中的消息原文与不再被引用的附件文件会被物理删除，不可恢复；在线会话不受影响。',
      danger: true, confirmText: '清理',
    });
    if (!ok) return;
    const r2 = await api('/api/admin/im/purge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: [b.dataset.imPurge] }),
    });
    const d2 = await r2.json().catch(() => ({}));
    if (!r2.ok) return toast((d2.error && d2.error.message) || '清理失败', true);
    toast('已清理（附件文件 ' + (d2.files || 0) + ' 个）');
    await loadImThreads();
  }));
}

async function viewImThread(tid) {
  const r = await api('/api/admin/im/view?thread=' + encodeURIComponent(tid));
  const d = await r.json();
  if (!r.ok) return toast((d.error && d.error.message) || '加载失败', true);
  const fmt = (ts) => { const x = new Date(Number(ts) || 0); return isNaN(x.getTime()) ? '' : x.toLocaleString(); };
  const rows = [];
  if ((d.messages || []).length) {
    rows.push('<div class="muted small" style="margin:10px 0 4px;font-weight:700">当前消息</div>');
    for (const m of d.messages) {
      const who = m.kind === 'ai' ? 'AI' : (m.name || m.from);
      const body = m.deleted ? '<i class="muted">消息已删除</i>' : escapeHtml(m.text || '');
      rows.push('<div style="margin:6px 0"><b>' + escapeHtml(String(who)) + '</b> <span class="muted small">' + fmt(m.at) + '</span>'
        + '<div style="white-space:pre-wrap;word-break:break-word">' + body + '</div></div>');
    }
  }
  const arch = d.archive || {};
  if ((arch.events || []).length || (arch.msgs || []).length) {
    rows.push('<div class="muted small" style="margin:14px 0 4px;font-weight:700">删除留档</div>');
    for (const e of arch.events || []) {
      const what = e.type === 'msgs' ? '删除了消息 ' + (e.ids || []).join(', ')
        : (e.type === 'delete' ? '删除了整个会话' : (e.type === 'disband' ? '解散了群聊' : escapeHtml(e.type)));
      rows.push('<div class="muted small" style="margin:4px 0">⚠ ' + escapeHtml(e.byName || e.by || '') + ' 于 ' + fmt(e.at) + ' ' + what + '</div>');
    }
    for (const m of arch.msgs || []) {
      const who = m.kind === 'ai' ? 'AI' : (m.name || m.from);
      const file = m.file ? ' [附件 ' + (m.file.name || '') + ' · ' + fmtSizeAdm(m.file.size) + ']' : '';
      rows.push('<div style="margin:6px 0"><b>' + escapeHtml(String(who)) + '</b> <span class="muted small">' + fmt(m.at) + '</span>'
        + '<div style="white-space:pre-wrap;word-break:break-word">' + escapeHtml(m.text || '') + escapeHtml(file) + '</div></div>');
    }
  }
  const mask = document.createElement('div');
  mask.className = 'modal-mask show';
  mask.style.zIndex = '1700';
  mask.innerHTML = '<div class="modal-card" style="width:min(680px,calc(100vw - 32px));max-height:80vh;display:flex;flex-direction:column;overflow:hidden">'
    + '<h3 style="margin:0 0 8px">' + escapeHtml(imThreadTitle(d.thread || {})) + (d.thread && d.thread.archived ? '（留档）' : '') + '</h3>'
    + '<div style="overflow-y:auto;min-height:0;flex:1">' + (rows.join('') || '<p class="muted small">暂无消息</p>') + '</div>'
    + '<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn" data-act="close">关闭</button></div>'
    + '</div>';
  document.body.appendChild(mask);
  mask.querySelector('[data-act="close"]').addEventListener('click', () => mask.remove());
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
}
function fmtSizeAdm(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
let notesSearchTimer = null;
document.addEventListener('input', (e) => {
  if (!e.target || e.target.id !== 'notes-user-search') return;
  clearTimeout(notesSearchTimer);
  notesSearchTimer = setTimeout(() => { loadNotesUsers().catch(() => {}); }, 350);
});

// 系统工具里任何输入都算改动。顺带把该行的「打开」链接撤掉:它指向的是库里已保存的
// 那一版,内容一改就对不上了,留着更容易误导(想预览就先保存)。
document.addEventListener('input', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('#toolbox-sys-body [data-tsys-item]') : null;
  if (!row) return;
  row.classList.add('is-changed');
  markTboxSysDirty(row.getAttribute('data-tsys-item'));
});
document.addEventListener('change', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('#toolbox-sys-body [data-tsys-item]') : null;
  if (!row) return;
  row.classList.add('is-changed');
  markTboxSysDirty(row.getAttribute('data-tsys-item'));
});

$('admin-tabs').addEventListener('click', (e) => {
  const groupBtn = e.target.closest('.admin-group-tab');
  if (groupBtn) return showAdminTab((ADMIN_GROUPS[groupBtn.dataset.group] || [])[0].id);
  const btn = e.target.closest('.admin-subnav-btn');
  if (btn) showAdminTab(btn.dataset.tab);
});

window.addEventListener('hashchange', () => {
  const parts = (location.hash || '').replace(/^#/, '').split('/');
  if (parts[0] && ADMIN_GROUPS[parts[0]]) showAdminTab(parts[1] || ADMIN_GROUPS[parts[0]][0].id);
  else if (parts[0]) showAdminTab(parts[0]);
});

(async function init() {
  if (!token) { location.href = apiUrl('/login'); return; }
  try {
    const me = await api('/api/auth/me');
    const data = await me.json();
    if (!me.ok || !data.user.admin) throw new Error('not admin');
    // 原生下拉统一换成站内自定义下拉,保证后台控件观感一致
    // (脚本是 defer,这里 DOM 已解析完;放在各 tab loader 之前,回填时 .value 也能正确同步文字)
    enhanceAllNativeSelects([
      'th-default', 'th-mode', 'th-force',
      'account-deletion-mode', 'smtp-encryption',
      'pkg-code-package', 'codes-bulk-package', 'user-chats-select',
      'mm-perpage',
    ]);
    localStorage.setItem('oc_user', JSON.stringify(data.user));
    ME_ID = data.user && data.user.id ? data.user.id : ME_ID;
    // 演示管理员:顶部常驻提示,提醒修改会失效;敏感入口直接隐藏,避免误操作撞到 403
    if (data.user && data.user.demo) {
      const banner = $('admin-demo-banner');
      if (banner) banner.classList.remove('hidden');
      document.body.classList.add('is-demo-admin');
      // 隐藏不可用的敏感操作入口(公告保存、创建/编辑用户、邀请码、查看对话等)
      ['announce-save'].forEach((id) => { const el = $(id); if (el) el.disabled = true; });
      const announceBox = $('announce-enabled'); if (announceBox) announceBox.disabled = true;
      const announceText = $('announce-text'); if (announceText) announceText.disabled = true;
      // SMTP 凭据可用于冒用站点域名发信:整段置为只读(服务端同样拒绝写入)
      ['smtp-host', 'smtp-port', 'smtp-user', 'smtp-pass', 'smtp-encryption', 'smtp-from-name', 'smtp-from-email', 'smtp-test-btn', 'smtp-test-to', 'verify-save'].forEach((id) => {
        const el = $(id); if (el) el.disabled = true;
      });
      const smtpNote = document.getElementById('smtp-demo-note');
      // 该元素用 class="hidden" 隐藏(.hidden{display:none!important}),
      // 只改 .hidden 属性去不掉类,提示永远出不来。和上面几处一样按类切换。
      if (smtpNote) smtpNote.classList.remove('hidden');
      // 新增功能里同样属于「个人内容 / 不可逆操作」的两处,服务端已按演示身份拒绝
      // (笔记审阅、聊天查看与留档清理)。这里把入口整块隐藏,免得点开只看到报错:
      //  - 「使用笔记的用户」审阅的是用户私人笔记
      //  - 「会话与留档」能读到聊天原文,且清理留档不随演示快照还原
      ['notes-users-card', 'im-threads-card'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
    }
    // 全局演示还原窗口:用户表单回填用(所有管理员都拉一次,避免编辑表单写死 10)
    try {
      const cr = await api('/api/config');
      const cfg = await cr.json();
      if (cfg && cfg.demoExpireMinutes != null) DEMO_MINUTES_CFG = Math.min(1440, Math.max(1, parseInt(cfg.demoExpireMinutes, 10) || 10));
      if ($('admin-demo-minutes') && data.user && data.user.demo) $('admin-demo-minutes').textContent = DEMO_MINUTES_CFG;
    } catch (e) { /* 提示条/回填不影响后台使用 */ }
    const rawStart = (location.hash || '').replace(/^#/, '');
    const startParts = rawStart.split('/');
    const start = startParts[0] && ADMIN_GROUPS[startParts[0]] ? (startParts[1] || ADMIN_GROUPS[startParts[0]][0].id) : (rawStart || 'overview');
    if (showAdminTab(start)) {
      if (!tabLoaded[start]) { const loader = TAB_LOADERS[start]; if (loader) { await loader(); tabLoaded[start] = true; } }
    } else {
      showAdminTab('overview');
    }
  } catch (e) {
    toast('需要管理员权限', true);
    setTimeout(() => location.href = apiUrl('/'), 1200);
  }
})();