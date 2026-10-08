'use strict';
/* OpenAI Chat 前端逻辑 */

const $ = (id) => document.getElementById(id);
const quotaIsUnlimited = (value) => String(value) === '-1';
window.OCState = null;
let streamSaveTimer = null;
const state = {
  token: localStorage.getItem('oc_token') || '',
  user: null,
  providers: [],
  defaultProviderId: null,
  currentProviderId: null,
  currentModel: null,
  streaming: false,
  abortController: null,
  _followStream: true, // 流式期间是否自动吸底(用户上翻时暂停)
  chats: [], // {id, title, messages: [{role, content}]}
  currentChatId: null,
  // 云同步删除模型(软删除,云端始终留档):
  //   deletedIds    本端已删、待推送给云端归档的 id(推送成功即清)
  //   _deletedCopies 本端删除时暂存的对话副本,随推送带给云端留档(本端可能比云端最后一次推送更新)
  //   serverTombs   云端已删除 id(墓碑),合并/加载时据此排除,保证 A 删 B 也删、旧设备回推不复活
  deletedIds: [],
  _deletedCopies: {},
  serverTombs: null,
  streamToggle: true,
  assistants: [],
  assistantCategories: [],
  defaultAssistant: null,
  mention: { open: false, q: '', index: 0, start: -1 },
  noteMentions: [], // @笔记:待发送的笔记引用(发送后清空并挂到该条消息上)
  noteFolderMentions: [], // @笔记文件夹:整目录引用(发送时展开为该目录全部笔记)
  clearAssistantAt: 0,
  webSearchAvailable: false,
  tools: null,
  mineru: { enabled: true, mode: 'lite' },
  chatLimits: { contextMessages: 12, maxContextMessages: 200 },
};

window.OCState = state;

// 从 UI 偏好系统读取运行参数(未加载时回退默认值)
function uiPref(key, def) {
  return (window.OCUI && window.OCUI.getPref(key) !== undefined) ? window.OCUI.getPref(key) : def;
}
// 设置云同步:本机改动记时间戳并防抖推送(模块未加载时静默跳过)
function syncTouch(field) {
  if (window.OCSettingsSync) window.OCSettingsSync.touchUi(field);
}
function streamEnabled() { return !!uiPref('stream', true); }
function followUpsEnabled() { return !!uiPref('followups', true); }
function autoTitleEnabled() { return !!uiPref('autotitle', true); }
// AI 工具判定总开关:关闭后不再发起判定调用(省一次额度),联网交给后端启发式、
// 出图回退关键词粗略识别、会话标题回退本地截取
function aiJudgeEnabled() { return !!uiPref('aiJudge', true); }
// 解析「辅助任务(跟进建议/命名)」指定的模型。
// pref 形如 'providerId\nmodelId';空值返回 null(调用方回退当前模型/本地截取)。
// 只接受对话模型(生图/生视频模型不用于文本辅助任务)。
function resolveAuxModel(prefKey) {
  const raw = String(uiPref(prefKey, '') || '');
  if (!raw) return null;
  const parts = raw.split('\n');
  const providerId = parts[0] || '';
  const modelId = parts.slice(1).join('\n');
  if (!providerId || !modelId) return null;
  const p = (state.providers || []).find((x) => x.id === providerId);
  if (!p || p.enabled === false) return null;
  const m = (p.models || []).find((x) => x && String(x.id) === modelId);
  if (!m) return null;
  if (modelIsImage(modelId) || modelIsVideo(modelId)) return null;
  return { providerId, model: modelId, format: p.apiFormat || 'chat' };
}
function elapsedEnabled() { return !!uiPref('elapsed', true); }
function reasoningEnabled() { return !!uiPref('reasoning', true); }
function reasoningEffort() {
  const v = String(uiPref('reasoningEffort', 'medium') || 'medium').toLowerCase();
  return (v === 'low' || v === 'high' || v === 'medium') ? v : 'medium';
}
const EFFORT_LABELS = { off: '关', low: '低', medium: '中', high: '高' };
function currentEffortMode() {
  return reasoningEnabled() ? reasoningEffort() : 'off';
}
const WEBSEARCH_LABELS = { auto: '智能', on: '始终', off: '关闭' };
// 模型元数据缺失时的兜底上限,与后端 lib/core.php 的 TC_MODEL_META_AUTO_OUTPUT /
// TC_MODEL_META_AUTO_CONTEXT 保持一致:两处都是「清单没给值」时的最后一道兜底,
// 取值写死在不同的语言里容易各自漂移,集中成常量至少让改动有明确落点。
const FALLBACK_MAX_OUTPUT = 8192;
const FALLBACK_MAX_CONTEXT = 131072;
function searchReady() {
  const t = state.tools && state.tools.webSearch;
  if (!t) return !!state.webSearchAvailable;
  if (t.source === 'own' && t.allowOwn) return !!t.ownReady;
  return !!t.platformReady;
}
function parseModeNow() {
  const t = state.tools && state.tools.parse;
  if (t && t.source === 'own' && t.allowOwn) return t.hasToken ? 'precise' : 'lite';
  return (state.mineru && state.mineru.mode) || 'lite';
}
function webSearchMode() {
  if (!searchReady()) return 'off';
  const stored = uiPref('webSearchMode', undefined);
  if (stored === 'auto' || stored === 'on' || stored === 'off') return stored;
  if (uiPref('webSearch', undefined) === true) return 'on';
  return 'auto';
}
function webSearchEnabled() {
  return webSearchMode() === 'on';
}
function setWebSearchMode(mode) {
  const next = (mode === 'on' || mode === 'off') ? mode : 'auto';
  if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('webSearchMode', next);
  syncComposerWebSearch();
}
function syncComposerWebSearch() {
  const btn = $('composer-websearch');
  if (!btn) return;
  const ready = searchReady();
  const mode = ready ? webSearchMode() : 'off';
  btn.classList.remove('hidden');
  btn.classList.toggle('on', ready && mode === 'on');
  btn.classList.toggle('auto', ready && mode === 'auto');
  btn.classList.toggle('off', !ready || mode === 'off');
  btn.setAttribute('aria-pressed', mode === 'on' ? 'true' : 'false');
  const own = state.tools && state.tools.webSearch && state.tools.webSearch.source === 'own';
  const title = !ready
    ? (own ? '联网搜索（还没填自己的配置）' : '联网搜索（后台尚未配置）')
    : ('联网：' + (WEBSEARCH_LABELS[mode] || '智能') + (own ? ' · 自己的' : ''));
  btn.title = title;
  btn.setAttribute('aria-label', title);
  document.querySelectorAll('#websearch-pop [data-websearch], #composer-tool-search [data-websearch]').forEach((b) => {
    b.classList.toggle('active', b.dataset.websearch === mode);
  });
  // 「≡」菜单按钮上加圆点:联网已开启(始终)时提示,收起菜单后也能一眼看出状态
  const more = $('composer-more');
  if (more) more.classList.toggle('flag-on', ready && mode === 'on');
}
function setEffortMode(mode) {
  const next = (mode === 'off' || mode === 'low' || mode === 'high') ? mode : 'medium';
  if (window.OCUI && window.OCUI.setPref) {
    if (next === 'off') window.OCUI.setPref('reasoning', false);
    else {
      window.OCUI.setPref('reasoning', true);
      window.OCUI.setPref('reasoningEffort', next);
    }
  }
  if (typeof syncPrefsPanel === 'function') syncPrefsPanel();
  if (typeof syncComposerEffort === 'function') syncComposerEffort();
}
function syncComposerEffort() {
  const mode = currentEffortMode();
  const btn = $('composer-effort');
  const lab = $('composer-effort-label');
  if (lab) lab.textContent = EFFORT_LABELS[mode] || '中';
  if (btn) {
    btn.classList.toggle('off', mode === 'off');
    const title = mode === 'off' ? '思维链已关闭' : ('思考强度：' + (EFFORT_LABELS[mode] || mode));
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
  document.querySelectorAll('#effort-pop [data-effort], #composer-tool-effort [data-effort]').forEach((b) => {
    b.classList.toggle('active', b.dataset.effort === mode);
  });
}
function partsText(parts, thinking) {
  if (!Array.isArray(parts)) {
    if (thinking) return '';
    return typeof parts === 'string' ? parts : '';
  }
  return parts.map((p) => {
    if (!p) return '';
    const isThink = p.type === 'thinking' || p.type === 'reasoning' || p.type === 'thought';
    if (thinking) {
      if (!isThink) return '';
      return p.thinking || p.text || p.reasoning || '';
    }
    if (isThink) return '';
    if (typeof p === 'string') return p;
    return p.text || '';
  }).join('');
}
function reasoningText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.content || val.text || val.thinking || '';
  return String(val);
}
function upsertReasoningPanel(contentEl, msg, streaming) {
  if (!contentEl) return;
  const text = reasoningText(msg && msg.reasoning);
  let panel = contentEl.querySelector(':scope > .live-reasoning');
  if (!text) {
    if (panel) panel.remove();
    return;
  }
  const answering = !!(streaming && msg && msg.content);
  const userOpen = !!(panel && panel.dataset.userOpen === '1');
  const open = userOpen || (!!streaming && !answering);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'reasoning-wrap live-reasoning';
    panel.dataset.role = 'reasoning';
    // 标签条和群聊名牌留在最上面,思考链紧跟其后(各模型的思维链不同)
    const anchor = contentEl.querySelector(':scope > .reply-tabs, :scope > .participant-tag');
    const after = anchor ? (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('participant-tag') ? anchor.nextElementSibling : anchor) : null;
    contentEl.insertBefore(panel, after ? after.nextSibling : contentEl.firstChild);
    panel.addEventListener('click', (e) => {
      if (!e.target.closest('.reasoning-header')) return;
      const next = !panel.classList.contains('open');
      panel.dataset.userOpen = next ? '1' : '0';
      panel.classList.toggle('open', next);
      const steps = panel.querySelector('.reasoning-steps');
      if (steps) steps.style.display = next ? '' : 'none';
    });
    panel.innerHTML =
      '<div class="reasoning-header">'
      + '<span class="reasoning-icon"></span>'
      + '<span class="reasoning-copy">'
      + '<span class="reasoning-title"></span>'
      + '<span class="reasoning-preview"></span>'
      + '</span>'
      + '<span class="phase-spinner" hidden></span>'
      + '<span class="reasoning-chev"></span>'
      + '</div>'
      + '<div class="reasoning-steps">'
      + '<div class="reasoning-body reasoning-live md-prose"></div>'
      + '</div>';
  }
  panel.classList.toggle('streaming', !!streaming);
  panel.classList.toggle('open', open);
  const icon = (window.OC && window.OC.icon) ? window.OC.icon('think', 14) : '';
  const chev = (window.OC && window.OC.icon) ? window.OC.icon('chevronDown', 14) : '';
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 72);
  const iconEl = panel.querySelector('.reasoning-icon');
  const titleEl = panel.querySelector('.reasoning-title');
  const previewEl = panel.querySelector('.reasoning-preview');
  const spinner = panel.querySelector('.phase-spinner');
  const chevEl = panel.querySelector('.reasoning-chev');
  const steps = panel.querySelector('.reasoning-steps');
  const body = panel.querySelector('.reasoning-live');
  if (iconEl) iconEl.innerHTML = icon;
  if (titleEl) titleEl.textContent = streaming ? (answering ? '思考完成' : '正在思考') : '思考过程';
  if (previewEl) {
    if (!open && preview) {
      previewEl.hidden = false;
      previewEl.textContent = preview + (text.length > 72 ? '…' : '');
    } else {
      previewEl.hidden = true;
      previewEl.textContent = '';
    }
  }
  if (spinner) spinner.hidden = !streaming || answering;
  if (chevEl) chevEl.innerHTML = chev;
  if (steps) steps.style.display = open ? '' : 'none';
  if (body) {
    if (window.OCRenderer && streaming && window.OCRenderer.renderStreamingInto) {
      window.OCRenderer.renderStreamingInto(body, text);
    } else if (window.OCRenderer && window.OCRenderer.renderInto) {
      window.OCRenderer.renderInto(body, text);
    } else {
      body.textContent = text;
    }
    if (streaming) body.scrollTop = body.scrollHeight;
  }
}

const ENDPOINT_BY_FORMAT = {
  chat: '/api/proxy/chat',
  responses: '/api/proxy/responses',
  completions: '/api/proxy/completions',
  anthropic: '/api/proxy/anthropic',
};

// ============ 基础工具 ============
function api(path, opts = {}) {
  const sentToken = state.token;
  opts.headers = Object.assign({ Authorization: 'Bearer ' + (sentToken || '') }, opts.headers || {});
  return fetch(apiUrl(path), opts).then(async (r) => {
    // 仅在「本次确实带了 token 且该 token 仍是当前 token」时才登出:
    // 启动阶段第三方登录正在换票据时 state.token 可能还是空/旧值,此时 401 不该清登录态、
    // 更不能把用户踢到登录页(会丢掉正在处理的 oauth_ticket 片段)。
    if (r.status === 401 && sentToken && sentToken === state.token) {
      logout();
      throw new Error('登录已过期');
    }
    return r;
  });
}

// 容错解析 JSON:响应不是 JSON(常见于服务器返回 HTML 错误页)时返回带提示的对象,而不是抛解析异常
async function readJsonSafe(res) {
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try { return JSON.parse(trimmed); } catch (e) { /* 落到下面统一处理 */ }
  }
  return { error: { message: '服务器返回了非预期内容（HTTP ' + res.status + '），请检查站点配置或稍后重试' } };
}

// 出字前的状态:在干嘛就写在干嘛。显示在 AI 回复气泡里(m.phase),不占输入框下方。
function setReplyPhase(msg, text) {
  if (!msg) return;
  msg.phase = text || '';
  const chat = currentChat();
  if (!chat) return;
  const idx = (chat.messages || []).indexOf(msg);
  if (idx < 0) { renderMessages(); return; }
  const node = document.querySelector('#messages .msg.assistant[data-idx="' + idx + '"] .phase-text');
  if (node) { node.textContent = text || '思考中'; return; }
  renderMessages();
}

// 把这一轮用户消息立刻发进对话(含 AI 占位),输入框随即清空。
// existing 是判定阶段已经发出去的那条时直接复用,避免同一条消息发两遍。
function postUserTurn(text, attachments, existing) {
  if (existing && existing.chat && existing.userMsg && existing.assistantMsg) return existing;
  const input = $('input');
  input.value = '';
  autosizeInput();
  state.pendingAttachments = [];
  renderAttachments();
  updateSendBtn();
  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();
  // 新会话第一个消息先按本地截取起标题;判定给出的标题稍后由调用方补上
  if (chat.messages.length === 0 && autoTitleEnabled()) {
    const seed = text || (attachments[0] && attachments[0].name) || '新对话';
    chat.title = (state._judgeTitle && state._judgeTitle.trim()) || window.OCConversations.autoTitle(seed);
    chat._autoTitled = true;
    renderChatList();
  }
  state._judgeTitle = '';
  const displayParts = [];
  if (text) displayParts.push(text);
  if (attachments.length && window.OCMultimodal) {
    attachments.forEach((a) => displayParts.push(window.OCMultimodal.toMarkdown(a)));
  }
  const content = displayParts.join('\n\n') || '（附件）';
  const userMsg = { role: 'user', content, text, attachments, createdAt: Date.now() };
  // 发送那一刻的 @助手 / @文件夹 / @笔记 快照:气泡里按输入框的样子回显引用
  userMsg.mentions = mentionsSnapshot(chat);
  clearNoteMentionsAfterSend();
  chat.messages.push(userMsg);
  jumpToLatestOnSend();
  chat.updatedAt = Date.now();
  // 占位先挂 _streaming:首 token 之前气泡里显示当前步骤(判定/检索/思考)
  const assistantMsg = { role: 'assistant', content: '', phase: '思考中', _streaming: true, createdAt: Date.now() };
  chat.messages.push(assistantMsg);
  saveChats();
  renderMessages();
  return { chat, userMsg, assistantMsg };
}
function phaseIndicatorHtml(text) {
  return '<div class="phase-indicator" aria-live="polite">'
    + '<span class="phase-live" aria-hidden="true"><i></i><i></i><i></i></span>'
    + '<span class="phase-text">' + escapeHtml(text || '思考中') + '</span>'
    + '</div>';
}
function judgePhaseText(opts) {
  opts = opts || {};
  const parts = [];
  if (opts.image) parts.push('生图');
  if (opts.search) parts.push('联网');
  if (opts.title) parts.push('标题');
  if (!parts.length) return '正在判定';
  return '正在判定是否' + parts.join('、');
}
function toast(msg, isError = false) {
  if (window.OCUI) return window.OCUI.toast(msg, isError ? 'error' : undefined);
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// 只放行 http(s) 与站内相对地址:escapeHtml 挡得住属性逃逸,挡不住 javascript: 协议。
// 用于一切「服务端/第三方给来的 URL 挂到 href/src」的场景(引用来源、套餐跳转、附件地址)。
function safeUrl(v) {
  const s = String(v == null ? '' : v).trim();
  return /^(https?:\/\/|\/)/i.test(s) ? s : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============ 头像(默认用 logo) ============
const LOGO_AVATAR_HTML = '<img src="./logo.svg" class="brand-logo-light avatar-logo-img" alt="">'
  + '<img src="./logo-dark.svg" class="brand-logo-dark avatar-logo-img" alt="">';
const USER_AVATAR_SVG = LOGO_AVATAR_HTML;
const AI_AVATAR_SVG = LOGO_AVATAR_HTML;
// 生图模型判定:优先用供应商配置里的显式 image 标记,缺省时按模型名启发式
function modelIsImage(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  const hint = (window.OC && OC.isImageModelName) ? OC.isImageModelName : () => false;
  for (const p of state.providers || []) {
    for (const m of p.models || []) {
      if (m && String(m.id) === id) {
        if (Object.prototype.hasOwnProperty.call(m, 'image')) return !!m.image;
        return hint(id);
      }
    }
  }
  return hint(id);
}
function imageModelLogo() {
  return (window.OC && OC.imageLogo) ? OC.imageLogo() : 'static/logo/picture.svg';
}
// 视频模型判定:优先用供应商配置里的显式 video 标记,缺省时按模型名启发式;
// 若供应商接口格式本身就是 video,该供应商下模型一律视为视频模型。
function modelIsVideo(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  const hint = (window.OC && OC.isVideoModelName) ? OC.isVideoModelName : () => false;
  for (const p of state.providers || []) {
    if (p && p.apiFormat === 'video') {
      for (const m of p.models || []) {
        if (m && String(m.id) === id) return true;
      }
    }
    for (const m of p.models || []) {
      if (m && String(m.id) === id) {
        if (Object.prototype.hasOwnProperty.call(m, 'video')) return !!m.video;
        return hint(id);
      }
    }
  }
  return hint(id);
}
// 当前供应商下被判定为视频生成的模型
function videoModelsOfCurrentProvider() {
  const p = (state.providers || []).find((x) => x.id === state.currentProviderId);
  if (!p || !Array.isArray(p.models)) return [];
  return p.models.filter((m) => m && m.id && modelIsVideo(m.id));
}
function videoModelLogo() {
  return (window.OC && OC.videoLogo) ? OC.videoLogo() : 'static/logo/video-camera.svg';
}
// 生图 / 生视频都「不使用助手」,也不参与 @助手 候选
function modelIsVisual(modelId) {
  return modelIsImage(modelId) || modelIsVideo(modelId);
}
// 读取本地图片为 data URL(供改图参考图使用)
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
// 压缩参考图:长边不超过 1536px、JPEG 质量 0.9。
// 参考图只用于给上游做编辑依据,无需原图分辨率;压缩能显著减小请求体与上游处理开销。
// 输入既可以是 File,也可以是 data URL(输入框附件保存的就是 data URL),
// 这样「输入框上传图片」与「绘图弹窗添加参考图」走同一套压缩逻辑,发给上游的结果一致。
function compressImageRef(source, maxEdge = 1536) {
  return new Promise((resolve) => {
    const finishFromDataUrl = (dataUrl) => {
      if (!dataUrl) return resolve('');
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth, h = img.naturalHeight;
          const scale = Math.min(1, maxEdge / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          // JPEG 无透明通道:先铺白底,避免透明 PNG 转出黑块
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const out = c.toDataURL('image/jpeg', 0.9);
          resolve(out || dataUrl);
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    if (typeof source === 'string') return finishFromDataUrl(source);
    if (!source) return resolve('');
    readFileAsDataUrl(source).then(finishFromDataUrl).catch(() => resolve(''));
  });
}
function readImageRefCompressed(file, maxEdge = 1536) {
  return compressImageRef(file, maxEdge);
}
// 图片规格解析:支持像素尺寸(1024x1024)、档位(2K/4K)与宽高比(16:9)。
// 上游对「尺寸」与「宽高比」是两个不同参数,这里按形态分派,非法值一律回退默认尺寸。
function parseImageSpec(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[×*]/g, 'x');
  if (/^\d{3,4}x\d{3,4}$/.test(s)) return { size: s, ratio: '' };
  if (/^[1-4]k$/.test(s)) return { size: s.toUpperCase(), ratio: '' };
  if (/^\d{1,2}:\d{1,2}$/.test(s)) return { size: '', ratio: s };
  return { size: '1024x1024', ratio: '' };
}
// 视频规格:时长(4~12 秒)与画面比例,沿用生视频弹窗最近一次的选择
const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
function parseVideoSpec() {
  const rawSec = parseInt(localStorage.getItem('oc_video_seconds') || '', 10);
  const seconds = (rawSec >= 4 && rawSec <= 12) ? rawSec : 5;
  const rawRatio = String(localStorage.getItem('oc_video_ratio') || '').trim();
  const ratio = VIDEO_RATIOS.indexOf(rawRatio) >= 0 ? rawRatio : '16:9';
  return { seconds, ratio };
}
// 助手头像按消息所属模型匹配图标:生图模型用 picture.svg、生视频模型用 video-camera.svg,
// 其余匹配厂商 logo,未命中回退站点 logo
function aiAvatarHtml(modelText) {
  const raw = String(modelText || '').trim();
  // 生图结果的消息模型名形如 "xxx (图像)",生视频形如 "xxx (视频)"
  const isImageMsg = /\(图像\)\s*$/.test(raw);
  const isVideoMsg = /\(视频\)\s*$/.test(raw);
  const modelId = raw.replace(/\s*\((图像|视频)\)\s*$/, '');
  const isVid = isVideoMsg || (!!modelId && modelIsVideo(modelId));
  const isImg = isImageMsg || (!isVid && !!modelId && modelIsImage(modelId));
  if (window.OC && window.OC.logoImg && (isImg || isVid)) {
    const html = window.OC.logoImg(isVid ? videoModelLogo() : imageModelLogo(), 'avatar-logo-img');
    if (html) return html;
  }
  if (raw && window.OC && window.OC.logoImg && window.OC.modelLogo) {
    const html = window.OC.logoImg(window.OC.modelLogo(raw), 'avatar-logo-img');
    if (html) return html;
  }
  return AI_AVATAR_SVG;
}
// 群聊成员头像:按成员序号取 static/role 内置图,没有序号时退回 emoji
function participantAvatarHtml(p) {
  const n = Number(p && p.avatar) || 0;
  if (n > 0) {
    const src = './static/role/' + (((n - 1) % 20) + 1) + '.png';
    return '<img class="participant-avatar role-photo" src="' + escapeHtml(src) + '" alt="" draggable="false">';
  }
  return '<span class="participant-avatar">' + escapeHtml((p && p.emoji) || '🤖') + '</span>';
}
function fillLogoAvatar(el) {
  if (!el) return;
  el.classList.add('avatar-logo');
  el.style.background = '';
  el.style.color = '';
  el.innerHTML = LOGO_AVATAR_HTML;
}

// ============ 会话 / 侧边栏 ============
// 会话列表与「删除副本」里带着图片本体(data URL 一份内联在 content、一份在 attachments),
// 一张 300KB 的图在本地就是 80 万字符,远不是 localStorage 那 5MB 能长期装下的东西 ——
// 统一走 OCStore(IndexedDB 优先,写不下时退回 localStorage)。键名只在这两个函数里拼,
// 别再手写字符串:散开写迟早漏改一处,那一处又会退回 5MB 的旧存储。
function chatsKey() { return 'oc_chats_' + (state.user ? state.user.id : ''); }
function delCopiesKey() { return 'oc_chat_delcopies_' + (state.user ? state.user.id : ''); }
function loadChats() {
  try {
    state.chats = window.OCConversations.normalize(JSON.parse(window.OCStore.get(chatsKey()) || '[]'));
    state.chats.forEach((c) => (c.messages || []).forEach((m) => { if (m && m.role === 'assistant') m._voteSent = m.vote || null; }));
  } catch (e) { state.chats = []; }
  // 刷新/重进页面时,把上次没跑完的「流式回答 / 生图占位」定稿:普通对话请求没有服务端任务可续,
  // 挂着 _streaming 会永远显示「思考中」,占位被合并丢掉后又只剩一条点不动的空白消息。
  // 有 taskId 且仍在跑的交给 resumePendingTasks 续传,这里不动。
  let healed = false;
  state.chats.forEach((c) => (c.messages || []).forEach((m) => {
    if (!m || m.role !== 'assistant') return;
    if (m.taskId && m.taskStatus === 'running') return;
    if (m._streaming) {
      m._streaming = false;
      m.interrupted = true;
      healed = true;
      if (!String(m.content || '').trim() && !m.reasoning) {
        m.error = true;
        m.failNote = '页面刷新，本次回答中断（未产生内容），可点击重试';
      }
    }
    if (m.imagePending) {
      m.imagePending = false;
      m.error = true;
      m.failNote = '页面刷新，生成已中断，请重新发送';
      healed = true;
    }
  }));
  if (healed) saveChats();
  // 恢复删除状态(按用户隔离):
  //  - 待推送删除(墓碑):刷新后继续把删除同步给云端
  //  - 被删对话副本:随下次推送带给云端留档
  //  - 云端墓碑:刷新后立刻把别处删掉的对话从列表里排除,不必等首次拉取
  try {
    const tombs = JSON.parse(localStorage.getItem('oc_chat_tombs_' + state.user.id) || '[]');
    state.deletedIds = Array.isArray(tombs) ? tombs.filter((x) => typeof x === 'string') : [];
  } catch (e) { state.deletedIds = []; }
  try {
    const copies = JSON.parse(window.OCStore.get(delCopiesKey()) || '{}');
    state._deletedCopies = (copies && typeof copies === 'object' && !Array.isArray(copies)) ? copies : {};
  } catch (e) { state._deletedCopies = {}; }
  try {
    const st = JSON.parse(localStorage.getItem('oc_chat_stombs_' + state.user.id) || '{}');
    state.serverTombs = (st && typeof st === 'object' && !Array.isArray(st)) ? st : {};
  } catch (e) { state.serverTombs = {}; }
  state.chats = state.chats.filter((c) => c && !state.serverTombs[c.id] && !(state.deletedIds || []).includes(c.id));
  state.currentChatId = state.chats[0] ? state.chats[0].id : null;
}
function persistTombstones() {
  if (!state.user) return;
  try {
    // 与推送端点接受的上限一致:更早的删除即便丢了显式清单,
    // 云端也能从「新列表里没有」推断出来并归档
    if ((state.deletedIds || []).length > 500) state.deletedIds = state.deletedIds.slice(-500);
    localStorage.setItem('oc_chat_tombs_' + state.user.id, JSON.stringify(state.deletedIds || []));
  } catch (e) { /* 忽略 */ }
}
function persistDeletedCopies() {
  if (!state.user) return;
  try {
    const entries = Object.entries(state._deletedCopies || {}).slice(-20);
    state._deletedCopies = Object.fromEntries(entries);
    window.OCStore.set(delCopiesKey(), JSON.stringify(state._deletedCopies));
  } catch (e) { /* 存储已满等场景忽略,删除仍会随列表同步生效 */ }
}
function persistServerTombs() {
  if (!state.user) return;
  try {
    // 只保留最近 2000 条(对象键序即写入序),与云端墓碑上限一致,避免本地存储无限膨胀
    const all = Object.keys(state.serverTombs || {});
    if (all.length > 2000) {
      state.serverTombs = Object.fromEntries(all.slice(-2000).map((id) => [id, 1]));
    }
    localStorage.setItem('oc_chat_stombs_' + state.user.id, JSON.stringify(state.serverTombs || {}));
  } catch (e) { /* 忽略 */ }
}
// 把云端墓碑合进本端:排除本地列表里对应对话。返回是否有内容被移除(用于决定是否重绘)
function applyServerTombs(ids) {
  if (!state.serverTombs || typeof state.serverTombs !== 'object') state.serverTombs = {};
  const list = Array.isArray(ids) ? ids : Object.keys(ids || {});
  if (!list.length) return false;
  let added = false;
  list.forEach((id) => {
    if (typeof id !== 'string' || !id) return;
    if (!state.serverTombs[id]) { state.serverTombs[id] = 1; added = true; }
  });
  if (!added) return false;
  const before = (state.chats || []).length;
  state.chats = (state.chats || []).filter((c) => c && !state.serverTombs[c.id]);
  if (state.currentChatId && !state.chats.some((c) => c.id === state.currentChatId)) {
    state.currentChatId = state.chats[0] ? state.chats[0].id : null;
  }
  persistServerTombs();
  return state.chats.length !== before;
}
// 记录一条本端删除:进待推送清单,并暂存对话副本供云端留档
function markChatDeleted(chat) {
  if (!chat || !chat.id) return;
  if (!(state.deletedIds || []).includes(chat.id)) state.deletedIds.push(chat.id);
  if (!state._deletedCopies || typeof state._deletedCopies !== 'object') state._deletedCopies = {};
  try {
    // 只带近期若干条,避免刷新前最后一个大对话把 localStorage 撑满
    const copy = JSON.parse(JSON.stringify(chat));
    state._deletedCopies[chat.id] = copy;
  } catch (e) { /* 结构不可序列化时跳过副本,服务端仍会自行留档 */ }
  persistTombstones();
  persistDeletedCopies();
  // 云端墓碑立即生效:同一页面内的后续合并不会再把它捞回来
  if (!state.serverTombs || typeof state.serverTombs !== 'object') state.serverTombs = {};
  state.serverTombs[chat.id] = 1;
  persistServerTombs();
}
// 同步进行中(流式/编辑/群聊回合):此时整套替换 state.chats 会打断正在写的回答
function syncBusy() {
  return !!(state.streaming || state._editingMsg || state._groupTurnActive || state.applyingCloudChats);
}

// 云同步：保存到本地 + 防抖推送云端
let syncTimer = null;
function slimChatsForStore(chats) {
  return (chats || []).map((c) => {
    const copy = Object.assign({}, c);
    copy.messages = (c.messages || []).map((m) => {
      const msg = Object.assign({}, m);
      if (msg.attachments && msg.attachments.length) {
        msg.attachments = msg.attachments.map((a) => {
          const att = Object.assign({}, a);
          if (att.dataUrl && att.dataUrl.length > 8000) att.dataUrl = '';
          if (att.content && att.content.length > 20000) att.content = att.content.slice(0, 20000);
          return att;
        });
      }
      return msg;
    });
    return copy;
  });
}
function scheduleStreamSave() {
  if (streamSaveTimer || !state.user) return;
  streamSaveTimer = setTimeout(() => { streamSaveTimer = null; saveChats(); }, 700);
}
function saveChats() {
  if (!state.user || state.applyingCloudChats) return;
  const key = chatsKey();
  // 返回 false = 这一次连兜底存储都没写进去(浏览器不给 IndexedDB、localStorage 又满),
  // 此时退一份瘦身副本(附件本体与超长字段不落本地),云端仍是权威副本
  if (!window.OCStore.set(key, JSON.stringify(state.chats))) {
    window.OCStore.set(key, JSON.stringify(slimChatsForStore(state.chats)));
  }
  scheduleCloudSync();
}
function scheduleCloudSync() {
  if (!state.token || !state.user) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushChatsToCloud(), 1500);
}
// 立即推送(删除等高危操作调用,不等防抖)
function syncNow() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  return pushChatsToCloud();
}
// 推送载荷:列表 + 待归档的删除(id 清单 + 本端副本)
function syncPayload() {
  const deletedChats = Object.values(state._deletedCopies || {}).slice(0, 20);
  return JSON.stringify({
    chats: state.chats,
    baseRevision: state.chatRevision || 0,
    deletedIds: state.deletedIds || [],
    deletedChats,
  });
}
// 推送成功后清掉「已确认归档」的待删清单与副本(服务端返回的墓碑集合整体采纳)
function ackDeleted(data) {
  const serverIds = data && data.deletedIds ? Object.keys(data.deletedIds) : [];
  if (serverIds.length) {
    applyServerTombs(serverIds);
  }
  if ((state.deletedIds || []).length) { state.deletedIds = []; persistTombstones(); }
  if (state._deletedCopies && Object.keys(state._deletedCopies).length) {
    state._deletedCopies = {};
    persistDeletedCopies();
  }
}
async function pushChatsToCloud() {
  syncTimer = null;
  if (state._groupTurnActive) { scheduleCloudSync(); return; } // 群聊回合期间延后推送,回合结束再同步
  try {
    const r = await api('/api/sync/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: syncPayload(),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409) {
      // 演示还原导致的冲突:整体采纳云端,不做按时间戳合并。
      // 流式/编辑/群聊回合期间不能整套替换(会把正在写的回答换掉,表现为不出字),延后到空闲再处理。
      if (syncBusy()) { scheduleCloudSync(); return; }
      if (adoptDemoRevert(data)) return;
      const revision = Number(data.revision) || 0;
      if (data.deletedIds) applyServerTombs(Object.keys(data.deletedIds));
      const prevId = state.currentChatId;
      const prev = (state.chats || []).find((c) => c.id === prevId) || null;
      const prevStamp = chatViewStamp(prev);
      state.chats = mergeChatLists(data.chats || [], state.chats || []);
      state.chatRevision = revision;
      if (state.user) localStorage.setItem('oc_chat_rev_' + state.user.id, String(revision));
      saveChats();
      renderChatList();
      const next = (state.chats || []).find((c) => c.id === state.currentChatId) || null;
      if (state.currentChatId !== prevId || chatViewStamp(next) !== prevStamp) renderMessages();
      // 手里还有未确认的删除:合并已排除它们,这里再推一次把服务端的也删掉
      if ((state.deletedIds || []).length) { scheduleCloudSync(); }
      return;
    }
    if (!r.ok) throw new Error('sync failed');
    state.chatRevision = Number(data.revision) || state.chatRevision || 0;
    if (state.user) localStorage.setItem('oc_chat_rev_' + state.user.id, String(state.chatRevision));
    // 推送成功:服务端已按本端列表落库(含删除归档),待删清单可清空
    ackDeleted(data);
  } catch (e) {
    // 静默失败,下次修改会重试
  }
}
// 页面关闭/刷新前冲刷待同步数据(防抖定时器会被取消,这里兜底防止云端残留旧数据)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.streaming) pullChatsFromCloud();
});
window.addEventListener('focus', () => { if (!state.streaming) pullChatsFromCloud(); });
// 已打开的页面不会收到焦点事件。只在可见、且没有待上传改动、也没有正在进行的生成/编辑时对一下版本号。
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (syncTimer || syncBusy()) return;
  pullChatsFromCloud();
}, 8000);
window.addEventListener('beforeunload', () => {
  if (state.token && state.user) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    try {
      // keepalive 请求在页面卸载时仍能送达,且可带 Authorization header
      fetch(apiUrl('/api/sync/chats'), {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
        body: syncPayload(),
      }).catch(() => {});
    } catch (e) { /* 降级:放弃本次冲刷 */ }
  }
});
// 登录后从云端拉取并合并到本地
function chatViewStamp(chat) {
  if (!chat) return '';
  const msgs = chat.messages || [];
  // 必须覆盖「会画到屏幕上」的字段。只看 updatedAt / 最后一条长度时,
  // 云同步每轮都换一份内容相同的对象,画面被整页重绘,入场动画就表现为时不时闪一下。
  const body = msgs.map((m) => {
    if (!m) return '';
    const versions = Array.isArray(m.versions) ? m.versions : [];
    const p = m.participant || {};
    return [
      m.role || '',
      String(m.content || '').length,
      String(m.reasoning || '').length,
      m.model || '',
      m.versionIndex || 0,
      versions.length,
      versions.map((v) => String((v && v.content) || '').length + '/' + String((v && v.reasoning) || '').length + '/' + (v && v.model || '')).join(','),
      m.error ? 1 : 0,
      m.interrupted ? 1 : 0,
      m._streaming ? 1 : 0,
      m.vote || '',
      (m.followUps || []).length,
      (m.citations || []).length,
      m.elapsedMs || 0,
      p.name || '',
      p.avatar || '',
    ].join(':');
  }).join('\n');
  // 只比对云端也会回传的内容:像 _visibleCount 这类纯本地字段云端永远没有,
  // 放进来会让每一轮同步都误判「有变化」,把消息列表整页重绘(正在编辑的输入框会被销毁)。
  return [chat.id, msgs.length, body].join('|');
}
function applyCloudChats(chats, revision) {
  if (!state.user) return;
  state.applyingCloudChats = true;
  try {
    const prevId = state.currentChatId;
    const prev = (state.chats || []).find((c) => c.id === prevId) || null;
    const prevStamp = chatViewStamp(prev);
    state.chats = window.OCConversations.normalize(chats || []);
    state.chatRevision = Number(revision) || 0;
    window.OCStore.set(chatsKey(), JSON.stringify(state.chats));
    localStorage.setItem('oc_chat_rev_' + state.user.id, String(state.chatRevision));
    state.currentChatId = state.chats.some((c) => c.id === state.currentChatId) ? state.currentChatId : null;
    // 当前对话被整体还原清掉时,落到列表第一条,避免停在空白页
    if (!state.currentChatId && state.chats.length) state.currentChatId = state.chats[0].id;
    const next = (state.chats || []).find((c) => c.id === state.currentChatId) || null;
    renderChatList();
    if (state.currentChatId !== prevId || chatViewStamp(next) !== prevStamp) renderMessages();
  } finally {
    state.applyingCloudChats = false;
  }
}

// 演示管理员到期还原后,服务端会带一个新的 demoRevertedAt 标记。
// 客户端此时必须「整体采纳云端」而不是按 updatedAt 合并:否则本地残留的演示期内容
// 会因为时间戳更新而赢过已还原的云端版本,把刚清掉的内容又推回服务端(表现为
// 对话时有时无、刷新后内容忽隐忽现)。
function adoptDemoRevert(data) {
  if (!state.user || !data) return false;
  const at = Number(data.demoRevertedAt) || 0;
  if (!at) return false;
  const key = 'oc_chat_demo_reset_' + state.user.id;
  const seen = Number(localStorage.getItem(key) || 0);
  if (at <= seen) return false;
  applyCloudChats(data.chats || [], Number(data.revision) || 0);
  // 服务端已把该账号的对话重置为基准:本地墓碑(待删除清单)与云端墓碑随之作废
  state.deletedIds = [];
  state._deletedCopies = {};
  state.serverTombs = {};
  persistTombstones();
  persistDeletedCopies();
  persistServerTombs();
  try { localStorage.setItem(key, String(at)); } catch (e) { /* 存储不可用 */ }
  return true;
}

async function pullChatsFromCloud() {
  if (!state.token || !state.user) return;
  if (syncBusy()) return; // 流式/编辑/群聊回合进行中:整套替换 state.chats 会打断正在写的回答
  try {
    const r = await api('/api/sync/chats');
    if (!r.ok) return;
    const data = await r.json();
    if (syncBusy()) return;
    if (adoptDemoRevert(data)) return;
    const revision = Number(data.revision) || 0;
    // 云端墓碑先落地:A 设备删除的对话在这里让本端也删掉(不必等 revision 变化)
    const tombChanged = data.deletedIds ? applyServerTombs(Object.keys(data.deletedIds)) : false;
    const seen = Number(localStorage.getItem('oc_chat_rev_' + state.user.id) || 0);
    if (revision !== seen) {
      const prevId = state.currentChatId;
      const prev = (state.chats || []).find((c) => c.id === prevId) || null;
      const prevStamp = chatViewStamp(prev);
      const merged = mergeChatLists(data.chats || [], state.chats || []);
      state.chats = merged;
      state.chatRevision = revision;
      window.OCStore.set(chatsKey(), JSON.stringify(merged));
      localStorage.setItem('oc_chat_rev_' + state.user.id, String(revision));
      renderChatList();
      if (!state.currentChatId && merged.length) state.currentChatId = merged[0].id;
      const next = (state.chats || []).find((c) => c.id === state.currentChatId) || null;
      if (state.currentChatId !== prevId || chatViewStamp(next) !== prevStamp) renderMessages();
      return;
    }
    const cloud = data.chats || [];
    if (!cloud.length && !(state.chats || []).length) {
      if (tombChanged) { saveChats(); renderChatList(); renderMessages(); }
      return;
    }
    const prevId = state.currentChatId;
    const prev = (state.chats || []).find((c) => c.id === prevId) || null;
    const prevStamp = chatViewStamp(prev);
    const merged = mergeChatLists(cloud, state.chats || []);
    if (!tombChanged && merged.length === (state.chats || []).length && chatViewStamp(merged.find((c) => c.id === prevId) || null) === prevStamp) {
      const sameIds = merged.every((c, i) => state.chats[i] && state.chats[i].id === c.id && (state.chats[i].updatedAt || 0) === (c.updatedAt || 0) && !!state.chats[i].pinned === !!c.pinned);
      if (sameIds) return;
    }
    state.chats = merged;
    if (!state.currentChatId) state.currentChatId = state.chats[0] ? state.chats[0].id : null;
    saveChats();
    renderChatList();
    const next = (state.chats || []).find((c) => c.id === state.currentChatId) || null;
    if (state.currentChatId !== prevId || chatViewStamp(next) !== prevStamp) renderMessages();
  } catch (e) {
    // 网络失败用本地
  }
}

// 副本「信息量」:条数 + 可见内容总长。仅用于 updatedAt 完全相同时的决胜,
// 让更完整的一份胜出(同一会话两个标签页时,旧标签页的短副本不会覆盖新写的长回答)。
function chatRichness(chat) {
  if (!chat) return 0;
  const msgs = chat.messages || [];
  let n = msgs.length * 1000;
  for (const m of msgs) {
    if (!m) continue;
    n += String(m.content || '').length + String(m.reasoning || '').length;
  }
  return n;
}

function mergeChatLists(cloudChats, localChats) {
  // 合并云端与本端列表:云端有、本端没有的补进来(多端同步);
  // 但删除的聊天要排除:本端待推送删除(deletedIds)与云端墓碑(serverTombs)都不能复活,
  // 否则删除后再次合并会被云端旧副本捞回来。
  const deleted = new Set([...(state.deletedIds || []), ...Object.keys(state.serverTombs || {})]);
  const cloud = window.OCConversations.normalize(cloudChats || []).filter((c) => !deleted.has(c.id));
  const local = window.OCConversations.normalize(localChats || []).filter((c) => !deleted.has(c.id));
  const merged = cloud.slice();
  local.forEach((lc) => {
    const found = merged.find((c) => c.id === lc.id);
    if (!found) {
      merged.push(lc);
      return;
    }
    // 时间戳相同时:保留信息量更大的一份。回复刚写完、推送还没落地时两端 updatedAt 一样,
    // 取云端旧副本会让刚生成的回答刷新后消失;取本地短副本则会在多标签页时把长回答推回旧版。
    const lt = lc.updatedAt || 0;
    const ft = found.updatedAt || 0;
    if (lt > ft || (lt === ft && chatRichness(lc) >= chatRichness(found))) {
      merged[merged.indexOf(found)] = lc;
    } else if ((found._visibleCount || 0) < (lc._visibleCount || 0)) {
      // 云端副本赢了也不能丢本地已展开的分页进度
      found._visibleCount = lc._visibleCount;
    }
  });
  merged.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return merged;
}

// 切换对话时清空待发送的 @笔记(不同对话不应共享引用)
function resetNoteMentions() {
  if ((state.noteMentions || []).length || (state.noteFolderMentions || []).length) {
    state.noteMentions = [];
    state.noteFolderMentions = [];
    renderNoteMentions();
  }
}
function currentChat() {
  return state.chats.find((c) => c.id === state.currentChatId) || null;
}
// 云同步合并会整体替换 state.chats(连同消息对象),而消息操作栏/菜单回调里握着的是
// 渲染那一刻的对象引用。生成前一律用这两个函数把引用换回「当前列表里的活对象」:
// 否则写进旧对象的内容画不出来(表现为 @重答/编辑重答不出字),会话也会因为写错对象而丢更新。
function liveChat(chat) {
  if (!chat || !chat.id) return currentChat();
  return (state.chats || []).find((c) => c.id === chat.id) || null;
}
function liveMessage(chat, msg) {
  const live = liveChat(chat);
  if (!live || !msg) return null;
  const msgs = live.messages || [];
  let idx = msgs.indexOf(msg);
  if (idx >= 0) return { chat: live, msg, idx };
  // 对象已被替换:先按「旧列表里的位置」取新列表同位置副本,再退回 createdAt+role 匹配
  const staleIdx = (chat.messages || []).indexOf(msg);
  const cand = staleIdx >= 0 ? msgs[staleIdx] : null;
  if (cand && cand.role === msg.role && (!msg.createdAt || !cand.createdAt || cand.createdAt === msg.createdAt)) {
    return { chat: live, msg: cand, idx: staleIdx };
  }
  const hit = msgs.findIndex((m) => m && m.role === msg.role && m.createdAt && msg.createdAt && m.createdAt === msg.createdAt);
  if (hit >= 0) return { chat: live, msg: msgs[hit], idx: hit };
  return null;
}
// API 对话是否显示在列表:用户偏好(默认开启),关闭后列表只显示网页端对话
function showApiChats() { return !!uiPref('showApiChats', true); }
function isApiChat(c) { return !!(c && c.apiKey); }
function visibleChats() {
  const all = state.chats || [];
  return showApiChats() ? all : all.filter((c) => !isApiChat(c));
}
function renderChatList() {
  const list = $('chat-list');
  list.innerHTML = '';
  if (!window.OCConversations || !list) { renderChatListSimple(list); return; }
  window.OCConversations.renderList(list, visibleChats(), {
    currentId: state.currentChatId,
    // 开放 API 调用产生的会话要在每个时间段里单独成组(「今天 API」紧跟「今天」)。
    // 判定口径与「显示 API 对话」开关共用同一处,免得两处各写一份、日后漂移。
    isApiChat,
    onSelect: (c) => {
      if (state.streaming) { stopStreaming(); }
      state.currentChatId = c.id;
      resetNoteMentions();
      state._scrollHistoryToBottom = true;
      if (c._visibleCount != null) delete c._visibleCount;
      renderChatList(); renderMessages(); resetComposer(); updateAssistantChip();
    },
    onDelete: async (c) => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除对话', message: '确认删除此对话？删除后本机与其它设备都会同步移除。', danger: true, confirmText: '删除' })
        : confirm('确认删除此对话？删除后本机与其它设备都会同步移除。');
      if (!ok) return;
      // 正在流式输出的会话被删除:先停止,否则内容会画进切换后的新会话里
      if (state.streaming && state.currentChatId === c.id) stopStreaming();
      state.chats = state.chats.filter((x) => x.id !== c.id);
      // 软删除:内容进云端留档(管理员可查看/清理),并记墓碑让其它设备同步删除
      markChatDeleted(c);
      if (state.currentChatId === c.id) state.currentChatId = state.chats[0] ? state.chats[0].id : null;
      saveChats(); renderChatList(); renderMessages();
      syncNow();
    },
    onRename: (c, item) => {
      window.OCConversations.renameInline(item, c.title, (title) => {
        // 云端合并会整体替换 state.chats(每个对话都是新对象),列表渲染那一刻捕获的 c
        // 可能已经不在列表里 —— 直接写 c 就是写进孤儿对象,renderChatList 一刷新,
        // 用户刚改的标题就无声消失。这里按 id 重新解析到「活对象」再写(与生成路径同一约定)。
        const live = liveChat(c);
        if (!live) return;
        live.title = title;
        // 手动重命名后不再是「自动标题」,AI 命名完成时不得覆盖
        live._autoTitled = false;
        live.updatedAt = Date.now();
        saveChats(); renderChatList();
      });
    },
    onTogglePin: (c) => {
      const live = liveChat(c);
      if (!live) return;
      live.pinned = !live.pinned;
      live.updatedAt = Date.now();
      saveChats(); renderChatList();
      toast(live.pinned ? '已置顶「' + (live.title || '新对话') + '」' : '已取消置顶');
    },
    onShare: (c) => shareConversation(c),
    onBranch: (c) => {
      // 分支复制当前消息(含流式中的占位):先停流,避免内容继续写进新分支
      if (state.streaming && state.currentChatId === c.id) stopStreaming();
      // 在新对话中复制全部消息作为分支起点
      const branch = {
        id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
        title: c.title + '（副本）',
        messages: JSON.parse(JSON.stringify(c.messages || [])),
        pinned: false,
        branchOf: c.id,
        assistantId: c.assistantId || null,
        assistantName: c.assistantName || '',
        systemPrompt: c.systemPrompt || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.chats.unshift(branch);
      state.currentChatId = branch.id;
      saveChats(); renderChatList(); renderMessages(); resetComposer();
      updateAssistantChip();
    },
  });
}
function renderChatListSimple(list) {
  // 兜底：无 OCConversations 时的旧版渲染
  visibleChats().forEach((c) => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === state.currentChatId ? ' active' : '');
    item.textContent = c.title;
    item.addEventListener('click', () => {
      state.currentChatId = c.id;
      renderChatList(); renderMessages();
    });
    list.appendChild(item);
  });
}

// 分支：从消息处创建（右键/悬浮菜单触发专用）
function branchFromMessage(msg, chat) {
  const live = liveMessage(chat, msg);
  if (!live) return;
  const branch = window.OCConversations.createBranch(live.chat, live.idx);
  state.chats.unshift(branch);
  state.currentChatId = branch.id;
  saveChats(); renderChatList(); renderMessages(); resetComposer();
  updateAssistantChip();
  toast('已从该消息创建分支');
}

// 删除单条消息:用于清理无关上下文(用户消息与回答分别删除)
function deleteMessage(msg, chat) {
  if (!msg || !chat) return;
  const live = liveMessage(chat, msg);
  if (!live) return;
  chat = live.chat;
  chat.messages.splice(live.idx, 1);
  chat.updatedAt = Date.now();
  saveChats(); renderChatList(); renderMessages();
  toast('已删除该消息');
}

async function loadDefaultAssistant() {
  try {
    const r = await api('/api/assistants');
    const data = await r.json();
    if (!r.ok) return;
    syncAssistantCatalog(data);
    updateAssistantChip();
  } catch (e) { /* 助手库不可用时保持普通对话 */ }
}
function syncAssistantCatalog(data) {
  if (!data) return;
  if (Array.isArray(data.assistants)) state.assistants = data.assistants;
  if (Array.isArray(data.categories)) state.assistantCategories = data.categories;
  state.defaultAssistant = data.defaultAssistant
    || (state.assistants || []).find((a) => a.id === 'as-present')
    || state.defaultAssistant
    || null;
}
window.syncAssistantCatalog = syncAssistantCatalog;
function defaultAssistant() {
  return state.defaultAssistant
    || (state.assistants || []).find((a) => a.id === 'as-present')
    || null;
}
function resolveNewChatAssistant(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'assistant')) return opts.assistant;
  return defaultAssistant();
}
function ensureDefaultAssistantOnBlank(chat) {
  const target = chat || currentChat();
  if (!isBlankChat(target) || target.assistantId) return false;
  const assistant = defaultAssistant();
  if (!assistant) return false;
  applyAssistantToChat(target, assistant);
  target.updatedAt = Date.now();
  return true;
}
function applyAssistantToChat(chat, assistant) {
  if (!chat) return chat;
  if (assistant && assistant.id) {
    chat.assistantId = assistant.id;
    chat.assistantName = assistant.name || '';
    chat.systemPrompt = String(assistant.prompt || '');
  } else {
    chat.assistantId = null;
    chat.assistantName = '';
    chat.systemPrompt = '';
  }
  return chat;
}
function isBlankChat(chat) {
  return !!(chat && !(chat.messages && chat.messages.length));
}
function findBlankChat() {
  const cur = currentChat();
  if (isBlankChat(cur)) return cur;
  return (state.chats || []).find(isBlankChat) || null;
}
function newChat(opts) {
  if (state.streaming) { stopStreaming(); }
  if (window.OCGroup && typeof window.OCGroup.setMode === 'function') window.OCGroup.setMode('simple');
  const existing = findBlankChat();
  if (existing) {
    state.currentChatId = existing.id;
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'assistant')) {
      applyAssistantToChat(existing, opts.assistant);
      existing.updatedAt = Date.now();
    } else {
      ensureDefaultAssistantOnBlank(existing);
    }
    existing.groupId = '';
    saveChats();
    renderChatList();
    renderMessages();
    renderEmptyState();
    resetComposer();
    updateAssistantChip();
    autosizeInput();
    Promise.resolve(applyPinnedModel()).catch(() => {});
    const reuseInput = $('input');
    if (reuseInput) reuseInput.focus();
    return existing;
  }
  const assistant = resolveNewChatAssistant(opts);
  const chat = {
    id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
    title: '新对话',
    messages: [],
    pinned: false,
    groupId: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  applyAssistantToChat(chat, assistant);
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
      resetNoteMentions();
  saveChats(); renderChatList(); renderMessages(); renderEmptyState(); resetComposer();
  updateAssistantChip();
  autosizeInput();
  Promise.resolve(applyPinnedModel()).catch(() => {});
  const input = $('input');
  if (input) input.focus();
  return chat;
}
function useAssistantOnChat(assistant, opts) {
  const silent = opts && opts.silent;
  let chat = currentChat();
  if (!chat) chat = newChat({ assistant: assistant || null });
  else {
    applyAssistantToChat(chat, assistant || null);
    chat.updatedAt = Date.now();
    saveChats();
    updateAssistantChip();
  }
  if (!silent) {
    toast(assistant ? '已选用「' + (assistant.name || '助手') + '」' : '已取消助手');
  }
  return chat;
}
// 选用生图模型时自动去除当前对话的 @助手:
// 助手注入的是对话系统提示词,对生图请求没有意义,反而可能干扰生图平台。
function enforceImageModelAssistant(opts) {
  const chat = currentChat();
  if (!chat || !chat.assistantId) return false;
  const name = chat.assistantName || '助手';
  applyAssistantToChat(chat, null);
  chat.updatedAt = Date.now();
  saveChats();
  updateAssistantChip();
  if (!(opts && opts.silent)) toast('生图模型不使用助手，已自动取消「' + name + '」');
  return true;
}
function startAssistantChat(assistant) {
  if (!assistant) {
    useAssistantOnChat(null);
    return;
  }
  useAssistantOnChat(assistant);
}
window.startAssistantChat = startAssistantChat;
window.useAssistantOnChat = useAssistantOnChat;
function updateAssistantChip() {
  const label = $('assistant-lib-label');
  const chip = $('composer-assistant');
  const chat = currentChat();
  const name = chat && chat.assistantName ? String(chat.assistantName).trim() : '';
  if (label) label.textContent = name || '助手库';
  if (!chip) return;
  if (!name) {
    chip.classList.add('hidden');
    chip.textContent = '';
    chip.removeAttribute('data-tip');
    chip.removeAttribute('title');
    if (typeof syncComposerIndent === 'function') syncComposerIndent();
    return;
  }
  chip.classList.remove('hidden');
  chip.textContent = '@' + name;
  chip.setAttribute('data-tip', '当前助手：' + name + '（再按两下 Backspace 可取消）');
  chip.removeAttribute('title');
  if (typeof syncComposerIndent === 'function') syncComposerIndent();
}
function renderEmptyState() {
  const empty = $('empty-state');
  empty.style.display = (state.currentChatId && currentChat() && currentChat().messages.length) ? 'none' : 'flex';
  updateAssistantChip();
}
function resetComposer() {
  const input = $('input');
  if (input) {
    input.value = '';
    if (typeof autosizeInput === 'function') autosizeInput();
  }
  state.pendingAttachments = [];
  if (typeof renderAttachments === 'function') renderAttachments();
  if (typeof updateSendBtn === 'function') updateSendBtn();
}
function renderMessages() {
  const chat = currentChat();
  const box = $('messages');
  // 重建前后保持阅读位置:innerHTML 重建的瞬间内容会变矮(图片/公式/高亮异步渲染),
  // 浏览器把 scrollTop 夹进变小的高度,表现为"切换回答标签/重答后跳到会话顶部"。
  // 同一会话内重建时按高度差恢复;原本就在底部则继续跟底。
  const area = $('chat-area');
  const sameChat = !!(chat && area && state._renderedChatId === chat.id);
  const prevTop = sameChat ? area.scrollTop : 0;
  const prevH = sameChat ? area.scrollHeight : 0;
  const wasAtBottom = sameChat && (area.scrollHeight - area.scrollTop - area.clientHeight < 80);
  box.innerHTML = '';
  renderEmptyState();
  if (!chat) { state._renderedChatId = null; return; }
  // 长对话分页:默认渲染最近 100 条,「加载更早」每次增量展开 100 条。
  // 不再一次性渲染全部 —— 几千条消息的会话点一下按钮会连 DOM 带高亮全部重建,直接卡死。
  const MAX_VISIBLE = 100;
  const msgs = chat.messages;
  if (chat._visibleCount == null || chat._visibleCount < MAX_VISIBLE) chat._visibleCount = Math.min(MAX_VISIBLE, msgs.length);
  if (msgs.length > chat._visibleCount) {
    const rest = msgs.length - chat._visibleCount;
    const pg = document.createElement('div');
    pg.className = 'msgs-pagination';
    const btn = document.createElement('button');
    btn.textContent = '↑ 加载更早的 ' + Math.min(rest, MAX_VISIBLE) + ' 条消息（还有 ' + rest + ' 条）';
    btn.addEventListener('click', () => {
      const area = $('chat-area');
      const before = area ? area.scrollHeight : 0;
      const top = area ? area.scrollTop : 0;
      chat._visibleCount = Math.min(chat._visibleCount + MAX_VISIBLE, msgs.length);
      renderMessages();
      if (area) area.scrollTop = top + (area.scrollHeight - before);
    });
    pg.appendChild(btn);
    box.appendChild(pg);
  }
  const startIdx = Math.max(0, msgs.length - chat._visibleCount);
  for (let i = startIdx; i < msgs.length; i++) {
    if (msgs[i] && msgs[i].role === 'system') continue;
    box.appendChild(buildMsgNode(msgs[i], chat, i));
  }
  renderChatToc();
  if (state._scrollHistoryToBottom) {
    state._scrollHistoryToBottom = false;
    scrollToBottom();
  } else if (sameChat && prevH > 0) {
    if (wasAtBottom) scrollToBottom();
    else area.scrollTop = Math.max(0, prevTop + (area.scrollHeight - prevH));
  }
  state._renderedChatId = chat.id;
}
function scrollToBottom() {
  const area = document.getElementById('chat-area');
  if (!area) return;
  const move = () => { area.scrollTop = area.scrollHeight; };
  move();
  requestAnimationFrame(() => {
    move();
    requestAnimationFrame(move);
  });
  setTimeout(move, 120);
}

// 用户主动发送时调用:无条件恢复吸底并滚到底部。
// 发送是明确的「我要看新内容」意图,不应被此前「上翻查看历史」的状态拦住。
function jumpToLatestOnSend() {
  state._followStream = true;
  scrollToBottom();
}

function tocPreview(text, limit) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '（空）';
  const n = limit || 36;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function chatRounds(chat) {
  const rounds = [];
  const msgs = (chat && chat.messages) || [];
  let pending = null;
  msgs.forEach((m, i) => {
    if (!m || m.role === 'system') return;
    if (m.role === 'user') {
      pending = { userIdx: i, user: m, assistantIdx: -1, assistant: null };
      rounds.push(pending);
      return;
    }
    if (m.role === 'assistant') {
      if (pending && pending.assistantIdx < 0) {
        pending.assistantIdx = i;
        pending.assistant = m;
      } else {
        pending = { userIdx: -1, user: null, assistantIdx: i, assistant: m };
        rounds.push(pending);
      }
    }
  });
  return rounds;
}

function renderChatToc() {
  const toc = $('chat-toc');
  const main = document.querySelector('main.main');
  if (!toc) return;
  const chat = currentChat();
  const rounds = chatRounds(chat);
  const show = !!(chat && rounds.length >= 2);
  toc.classList.toggle('hidden', !show);
  if (main) main.classList.toggle('has-toc', show);
  if (!show) {
    toc.innerHTML = '';
    toc.classList.remove('open');
    return;
  }
  const activeIdx = toc.dataset.active ? Number(toc.dataset.active) : -1;
  toc.innerHTML = '';
  const marks = document.createElement('div');
  marks.className = 'chat-toc-marks';
  rounds.forEach((_, i) => {
    const tick = document.createElement('span');
    tick.className = 'chat-toc-mark' + (i === activeIdx ? ' active' : '');
    tick.dataset.round = String(i);
    marks.appendChild(tick);
  });
  toc.appendChild(marks);
  const head = document.createElement('div');
  head.className = 'chat-toc-head';
  head.textContent = '本轮目录';
  toc.appendChild(head);
  rounds.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-toc-item' + (i === activeIdx ? ' active' : '');
    btn.dataset.round = String(i);
    const q = tocPreview(r.user && r.user.content, 34);
    const a = r.assistant
      ? (r.assistant._streaming && !String(r.assistant.content || '').trim()
        ? '正在生成…'
        : tocPreview(r.assistant.content, 42))
      : '';
    btn.innerHTML =
      '<span class="chat-toc-num">' + (i + 1) + '</span>'
      + '<span class="chat-toc-copy">'
      + '<span class="chat-toc-q">' + escapeHtml(q) + '</span>'
      + (a ? '<span class="chat-toc-a">' + escapeHtml(a) + '</span>' : '')
      + '</span>';
    btn.addEventListener('click', () => jumpToRound(r.userIdx >= 0 ? r.userIdx : r.assistantIdx));
    toc.appendChild(btn);
  });
}

function jumpToRound(idx) {
  const chat = currentChat();
  if (!chat) return;
  if (chat.messages && chat.messages.length > (chat._visibleCount || 100)) {
    // 目标轮次在未展开区时,把可见窗口扩到能覆盖它(按需增量,不整会话全开)
    chat._visibleCount = Math.max(chat._visibleCount || 100, chat.messages.length - idx);
    renderMessages();
  }
  const node = document.querySelector('#messages .msg[data-idx="' + idx + '"]');
  const area = $('chat-area');
  if (node && area) {
    const top = node.offsetTop - 16;
    area.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  const toc = $('chat-toc');
  if (toc) {
    toc.dataset.active = String(chatRounds(chat).findIndex((r) => r.userIdx === idx || r.assistantIdx === idx));
    toc.querySelectorAll('.chat-toc-item, .chat-toc-mark').forEach((el) => {
      el.classList.toggle('active', el.dataset.round === toc.dataset.active);
    });
  }
}

let syncTocTimer = 0;
function syncTocActive() {
  const toc = $('chat-toc');
  const area = $('chat-area');
  const chat = currentChat();
  if (!toc || toc.classList.contains('hidden') || !area || !chat) return;
  const rounds = chatRounds(chat);
  if (!rounds.length) return;
  const mid = area.scrollTop + Math.min(160, area.clientHeight * 0.28);
  let active = 0;
  rounds.forEach((r, i) => {
    const idx = r.userIdx >= 0 ? r.userIdx : r.assistantIdx;
    const node = document.querySelector('#messages .msg[data-idx="' + idx + '"]');
    if (node && node.offsetTop <= mid) active = i;
  });
  if (String(active) === toc.dataset.active) return;
  toc.dataset.active = String(active);
  toc.querySelectorAll('.chat-toc-item, .chat-toc-mark').forEach((el) => {
    el.classList.toggle('active', el.dataset.round === String(active));
  });
}
function snapshotReplyVersion(msg) {
  if (!msg || msg.role !== 'assistant') return null;
  const content = String(msg.content || '');
  if (!content.trim() && !msg.error) return null;
  const known = findModelItem(msg.providerId, msg.model);
  if (known) {
    if (!msg.providerId) msg.providerId = known.providerId;
    msg.providerName = known.providerName || providerNameOf(known.providerId);
  }
  return {
    content: content,
    reasoning: msg.reasoning || '',
    followUps: Array.isArray(msg.followUps) ? msg.followUps.slice() : [],
    citations: Array.isArray(msg.citations) ? msg.citations.slice() : [],
    vote: msg.vote || null,
    model: msg.model || '',
    providerId: msg.providerId || (known ? known.providerId : ''),
    providerName: msg.providerName || (known ? (known.providerName || providerNameOf(known.providerId)) : ''),
    error: !!msg.error,
    interrupted: !!msg.interrupted,
    failNote: msg.failNote || '',
    elapsedMs: typeof msg.elapsedMs === 'number' ? msg.elapsedMs : null,
    createdAt: msg.createdAt || Date.now(),
    usage: msg.usage ? Object.assign({}, msg.usage) : null,
    contextCount: Number(msg.contextCount) || 0,
    contextLimit: Number(msg.contextLimit) || 0,
  };
}

function applyReplyVersion(msg, snap) {
  if (!msg || !snap) return;
  msg.content = snap.content || '';
  msg.reasoning = snap.reasoning || '';
  msg.followUps = Array.isArray(snap.followUps) ? snap.followUps.slice() : [];
  msg.citations = Array.isArray(snap.citations) ? snap.citations.slice() : [];
  msg.vote = snap.vote || null;
  msg._voteSent = msg.vote;
  msg.model = snap.model || msg.model;
  msg.providerId = snap.providerId || msg.providerId;
  msg.providerName = snap.providerName || msg.providerName || '';
  msg.error = !!snap.error;
  msg.interrupted = !!snap.interrupted;
  msg.failNote = snap.failNote != null ? snap.failNote : (msg.failNote || '');
  msg.elapsedMs = typeof snap.elapsedMs === 'number' ? snap.elapsedMs : null;
  msg.createdAt = snap.createdAt || msg.createdAt;
  msg.usage = snap.usage ? Object.assign({}, snap.usage) : null;
  msg.contextCount = Number(snap.contextCount) || 0;
  msg.contextLimit = Number(snap.contextLimit) || 0;
  delete msg._startTime;
}

function ensureReplyVersions(msg) {
  if (!msg.versions || !msg.versions.length) {
    const snap = snapshotReplyVersion(msg);
    msg.versions = snap ? [snap] : [];
    msg.versionIndex = msg.versions.length ? msg.versions.length - 1 : 0;
  }
  if (typeof msg.versionIndex !== 'number' || msg.versionIndex < 0) {
    msg.versionIndex = Math.max(0, msg.versions.length - 1);
  }
  return msg.versions;
}

function persistCurrentReplyVersion(msg) {
  if (!msg || msg.role !== 'assistant') return;
  const versions = ensureReplyVersions(msg);
  const snap = snapshotReplyVersion(msg);
  if (!snap) return;
  const i = Math.min(Math.max(0, msg.versionIndex || 0), Math.max(0, versions.length - 1));
  versions[i] = snap;
}

function pushReplyVersion(msg) {
  persistCurrentReplyVersion(msg);
  const versions = ensureReplyVersions(msg);
  versions.push({
    content: '',
    reasoning: '', // 每个模型各自一份思维链,切换标签时随版本换回
    followUps: [],
    citations: [],
    vote: null,
    model: state.currentModel || '',
    providerId: state.currentProviderId || '',
    providerName: providerNameOf(state.currentProviderId),
    error: false,
    interrupted: false,
    failNote: '',
    elapsedMs: null,
    createdAt: Date.now(),
    usage: null,
    contextCount: 0,
    contextLimit: 0,
  });
  msg.versionIndex = versions.length - 1;
  applyReplyVersion(msg, versions[msg.versionIndex]);
}

function switchReplyVersion(msg, chat, delta) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const live = liveMessage(chat, msg);
  if (!live) return;
  chat = live.chat; msg = live.msg;
  const versions = ensureReplyVersions(msg);
  if (versions.length < 2) return;
  persistCurrentReplyVersion(msg);
  const next = Math.min(versions.length - 1, Math.max(0, (msg.versionIndex || 0) + delta));
  if (next === msg.versionIndex) return;
  msg.versionIndex = next;
  applyReplyVersion(msg, versions[next]);
  chat.updatedAt = Date.now();
  saveChats();
  renderMessages();
}

function finalizeReplyTiming(msg) {
  if (!msg || !msg._startTime) return;
  msg.elapsedMs = Math.max(0, Date.now() - msg._startTime);
  persistCurrentReplyVersion(msg);
  // 回复写完必须把所属会话的时间戳推到最新:否则云端还留着「生成中/占位」那一版,
  // 时间戳相同的旧副本会在下次合并(刷新/轮询)时把刚写好的回答覆盖掉。
  const owner = (state.chats || []).find((c) => (c.messages || []).indexOf(msg) >= 0);
  if (owner) owner.updatedAt = Date.now();
}

function formatElapsedMs(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '';
  return (n / 1000).toFixed(1) + 's';
}

function formatTokenCount(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return '';
  if (v >= 10000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}
function formatUsageText(msg) {
  if (!msg || msg.role !== 'assistant' || msg._streaming) return '';
  const usage = msg.usage || {};
  const total = Number(usage.total);
  const prompt = Number(usage.prompt);
  const completion = Number(usage.completion);
  const parts = [];
  if (isFinite(prompt) && prompt > 0) parts.push('↑ ' + formatTokenCount(prompt));
  if (isFinite(completion) && completion > 0) parts.push('↓ ' + formatTokenCount(completion));
  if (!parts.length && isFinite(total) && total > 0) parts.push('合计 ' + formatTokenCount(total));
  return parts.join(' · ');
}
function usageTitle(msg) {
  const usage = (msg && msg.usage) || {};
  const bits = [];
  if (usage.prompt) bits.push('输入 ' + usage.prompt);
  if (usage.completion) bits.push('输出 ' + usage.completion);
  if (usage.total) bits.push('合计 ' + usage.total);
  const sent = Number(msg && msg.contextCount);
  const limit = Number(msg && msg.contextLimit);
  if (isFinite(sent) && sent > 0) bits.push('本次带上 ' + Math.round(sent) + ' 条' + (isFinite(limit) && limit > 0 ? '，上限 ' + Math.round(limit) + ' 条' : ''));
  return bits.join(' · ') || 'Token 与上下文';
}
function takeUsage(target, raw) {
  if (!target || !raw || typeof raw !== 'object') return;
  const prompt = Number(raw.prompt_tokens != null ? raw.prompt_tokens : raw.input_tokens);
  const completion = Number(raw.completion_tokens != null ? raw.completion_tokens : raw.output_tokens);
  let total = Number(raw.total_tokens);
  if (!isFinite(total) || total < 0) {
    total = (isFinite(prompt) ? prompt : 0) + (isFinite(completion) ? completion : 0);
  }
  if (!(total > 0) && !(prompt > 0) && !(completion > 0)) return;
  target.usage = {
    prompt: isFinite(prompt) && prompt > 0 ? Math.round(prompt) : 0,
    completion: isFinite(completion) && completion > 0 ? Math.round(completion) : 0,
    total: Math.round(total),
  };
}
function formatMsgClock(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const p = (v) => String(v).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function stripInterruptMarks(text) {
  return String(text || '').replace(/\n*(\*\(已停止生成\)\*|\*\(生成中断，回答可能不完整\)\*)\s*$/g, '').trim();
}

function replyWasInterrupted(msg) {
  if (!msg || msg.role !== 'assistant' || msg.error || msg._streaming) return false;
  if (msg.interrupted) return true;
  const content = String(msg.content || '');
  if (/\*\((已停止生成|生成中断，回答可能不完整)\)\*/.test(content)) return true;
  const draft = content.replace(/\s+/g, '');
  return !draft && String(msg.reasoning || '').trim().length > 0;
}

function streamLooksComplete(format, text) {
  if (text.indexOf('[DONE]') >= 0) return true;
  if (format === 'anthropic' && text.indexOf('message_stop') >= 0) return true;
  if (format === 'responses' && (text.indexOf('response.completed') >= 0 || text.indexOf('response.incomplete') >= 0)) return true;
  return /"finish_reason"\s*:\s*"(stop|length|tool_calls|content_filter)"/.test(text);
}

function streamEndedEarly(format, raw, assistantMsg) {
  if (assistantMsg && assistantMsg.interrupted) return false;
  if (!raw || streamLooksComplete(format, raw)) return false;
  const content = String((assistantMsg && assistantMsg.content) || '').trim();
  const reasoning = String((assistantMsg && assistantMsg.reasoning) || '').trim();
  return !!(content || reasoning);
}

function renderElapsed(container, msg) {
  container.querySelectorAll('.reply-cost, .reply-versions').forEach((el) => el.remove());
  const elapsedText = elapsedEnabled()
    ? (typeof msg.elapsedMs === 'number'
      ? formatElapsedMs(msg.elapsedMs)
      : (msg && msg._startTime ? formatElapsedMs(Date.now() - msg._startTime) : ''))
    : '';
  const versions = (msg && Array.isArray(msg.versions)) ? msg.versions : [];
  const showPager = versions.length > 1 && !msg._streaming;
  const clockText = formatMsgClock(msg.createdAt);
  const usageText = formatUsageText(msg);
  if (!elapsedText && !showPager && !clockText && !usageText && !replyWasInterrupted(msg)) return;

  const mount = document.createElement('div');
  mount.className = 'reply-meta';
  const clock = formatMsgClock(msg.createdAt);
  if (clock) {
    const time = document.createElement('span');
    time.className = 'reply-time';
    time.textContent = clock;
    time.title = '回答时间';
    mount.appendChild(time);
  }
  const who = String(msg.model || '').trim();
  if (who) {
    const model = document.createElement('span');
    model.className = 'reply-model';
    model.textContent = who;
    model.title = '回答模型';
    mount.appendChild(model);
  }
  if (usageText) {
    const usage = document.createElement('span');
    usage.className = 'reply-usage';
    usage.textContent = usageText;
    usage.title = usageTitle(msg);
    mount.appendChild(usage);
  }
  if (replyWasInterrupted(msg)) {
    const flag = document.createElement('span');
    flag.className = 'reply-flag';
    flag.textContent = '中断';
    const who = String(msg.model || '').trim();
    flag.title = (who ? who + ' ' : '') + '生成被中断，回答可能不完整';
    mount.appendChild(flag);
    if (msg.failNote) {
      const note = document.createElement('span');
      note.className = 'reply-fail';
      note.textContent = msg.failNote;
      note.title = msg.failNote;
      mount.appendChild(note);
    }
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'reply-continue';
    go.textContent = '继续生成';
    go.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chat = currentChat();
      if (chat) continueInterrupted(msg, chat);
    });
    mount.appendChild(go);
  }
  if (elapsedText) {
    const cost = document.createElement('span');
    cost.className = 'reply-cost';
    cost.textContent = elapsedText;
    cost.title = '生成耗时';
    mount.appendChild(cost);
  }
  // 多版本切换已由消息顶部的模型标签页(reply-tabs)承担

  const bar = container.querySelector('.msg-actions');
  if (bar) bar.appendChild(mount);
  else container.appendChild(mount);
}

// 回到底部悬浮按钮:滚动远离底部时显示,点击回到底部
(function initScrollBottomBtn() {
  const btn = $('scroll-bottom-btn');
  const area = $('chat-area');
  if (!btn || !area) return;
  const NEAR_BOTTOM = 120;
  const update = () => {
    const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
    btn.classList.toggle('show', dist > NEAR_BOTTOM);
  };
  area.addEventListener('scroll', update, { passive: true });
  btn.addEventListener('click', () => {
    area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
  });
  // 消息渲染后也检查一次
  const mo = new MutationObserver(() => update());
  mo.observe($('messages'), { childList: true, subtree: true });
  update();
})();
// 用户消息里的图片一律按 attachments 重建,不直接信 content 里的内联拷贝。
// 同一张图在消息里有两份:content 内的 ![名](data:image/...;base64,...) 与 attachments[].dataUrl。
// 云端同步对 content 有 200000 字符上限(见 lib/api.php tc_sanitize_chats),大图会被从中间切断,
// 剩下的半截 base64 既不是图片也不是链接,只能整段当文字画出来 —— 换设备登录后看到的
// 「一堆字符」就是它。attachments[].dataUrl 的上限是 8MB,是更可靠的载体,这里据它重建。
function userMsgDisplay(m, shown) {
  const atts = Array.isArray(m && m.attachments) ? m.attachments : [];
  const imgs = atts.filter((a) => a && a.type === 'image' && a.dataUrl
    && window.OCMultimodal && window.OCMultimodal.toMarkdown);
  if (!imgs.length) return shown;
  let i = 0;
  // 正文里每个 data: 图片片段(含被截断、没有右括号的残尾)都换成附件里的完整 markdown,
  // 位置保持不变;附件里没有对应的(极少数情况)保留原样,绝不删用户内容。
  let out = String(shown || '').replace(/!\[[^\]]*\]\(\s*data:[^)\s]*\)?/g, (match) => (
    i < imgs.length ? window.OCMultimodal.toMarkdown(imgs[i++]) : match
  ));
  // 附件里有、正文里已丢失的(没在 content 里留下任何痕迹的)补到末尾
  while (i < imgs.length) out = (out ? out + '\n\n' : '') + window.OCMultimodal.toMarkdown(imgs[i++]);
  return out;
}
// 历史数据(本次修复前同步过的)里可能已经存在被截断的图片片段:![名](data:image/png;base64,AAAA…
// 末尾没有右括号,Markdown 只能当普通文字画出来 —— 就是用户看到的「一堆字符」。
// 用户消息可以从 attachments 完整重建(见上);助手消息没有可依赖的副本,只能把这段残片
// 收成一句话,避免整屏乱码。只匹配「到字符串末尾仍未闭合」的 data 图片,完整图片不受影响。
function stripBrokenDataImages(text) {
  return String(text || '').replace(
    /!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]*;?(?:base64)?,[^\s)]*$/i,
    (mm, alt) => '（图片「' + (alt || '未命名') + '」在同步时被截断，已无法显示）'
  );
}
function buildMsgNode(m, chat, idx) {
  const role = m.role || 'assistant';
  const div = document.createElement('div');
  div.className = 'msg ' + role + (m.error ? ' msg-errored' : '');
  if (typeof idx === 'number') div.dataset.idx = String(idx);
  const avatar = role === 'user'
    ? USER_AVATAR_SVG
    : (m && m.participant
      ? participantAvatarHtml(m.participant)
      : aiAvatarHtml((m && m.model) || state.currentModel || ''));
  div.innerHTML = '<div class="msg-avatar">' + avatar + '</div>';
  const contentDiv = document.createElement('div');
  contentDiv.className = 'msg-content';
  if (m.error) {
    // 失败的那次若是 @模型重答,这条消息上还挂着别的模型的回答:标签条要照常画出来。
    // 否则报错会把之前那个模型的回答一起藏掉,再也切不回去。
    if (Array.isArray(m.versions) && m.versions.length > 1) {
      contentDiv.appendChild(buildReplyTabs(m, chat));
    }
    const kept = stripInterruptMarks(m.content);
    const note = String(m.failNote || m.content || '请求出错');
    const body = document.createElement('div');
    body.innerHTML = (kept
      ? '<div class="msg-render-root md-prose"></div>'
      : '') + '<div class="msg-error">' + escapeHtml(note) + '</div>';
    if (kept && window.OCRenderer) {
      window.OCRenderer.renderInto(body.querySelector('.msg-render-root'), kept);
    }
    contentDiv.appendChild(body);
    if (role === 'assistant') {
      // 失败时提供重试按钮
      const retryRow = document.createElement('div');
      retryRow.className = 'msg-retry-row';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn small';
      retryBtn.textContent = '↻ 重试';
      retryBtn.addEventListener('click', () => {
        regenerateMessage(m, chat);
      });
      retryRow.appendChild(retryBtn);
      if (kept) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'btn small';
        go.textContent = '继续生成';
        go.addEventListener('click', () => continueInterrupted(m, chat));
        retryRow.appendChild(go);
      }
      contentDiv.appendChild(retryRow);
    }
  } else if (role === 'assistant') {
    if (m.imagePending && !m.content) {
      // 生图/生视频占位:出图通常要 10–60 秒,出视频更久,给出明确的等待提示而不是空白气泡。
      // m.phase 优先(判定/改图等更具体的步骤),没有再按类型给兜底文案。
      const waiting = m.phase || (m.pendingKind === 'video' ? '正在生成视频（可能需要 1–5 分钟）…' : '正在生成图片…');
      contentDiv.innerHTML = phaseIndicatorHtml(waiting);
      div.appendChild(contentDiv);
      return div;
    }
    if (!m.createdAt && typeof idx === 'number' && chat && chat.messages) {
      for (let j = idx - 1; j >= 0; j--) {
        const prev = chat.messages[j];
        if (prev && prev.role === 'user' && prev.createdAt) {
          m.createdAt = prev.createdAt + (typeof m.elapsedMs === 'number' ? m.elapsedMs : 0);
          break;
        }
      }
    }
    // 多版本回答:浏览器标签条置顶,并且在思考链之上
    // (不同模型各有自己的思维链,切换模型时思考内容跟着变)
    // 生成中也挂着:新开的标签先出现,再在里面回答,和浏览器新建标签一样
    if (Array.isArray(m.versions) && m.versions.length > 1) {
      contentDiv.appendChild(buildReplyTabs(m, chat));
    }
    // 群聊成员名牌:角色、阶段、模型、时间
    if (m.participant) contentDiv.appendChild(buildParticipantTag(m));
    // 新渲染管线：Markdown + 公式 + 代码 + Mermaid + 组件
    if (m.reasoning) upsertReasoningPanel(contentDiv, m, !!m._streaming);
    if (m._streaming) {
      // 流式中先出头像+当前步骤,有字后再跟光标,避免首 token 前像没头像
      if (m.content) {
        const root = document.createElement('div');
        root.className = 'stream-answer';
        contentDiv.appendChild(root);
        if (window.OCRenderer && window.OCRenderer.renderStreamingInto) {
          window.OCRenderer.renderStreamingInto(root, m.content);
        } else {
          root.classList.add('stream-inline');
          root.innerHTML = escapeHtml(m.content) + '<span class="stream-cursor"></span>';
        }
      } else if (!m.reasoning) {
        contentDiv.innerHTML = phaseIndicatorHtml(m.phase || '思考中');
      }
    } else {
      const root = document.createElement('div');
      contentDiv.appendChild(root);
      // 历史数据里被同步截断的 data 图片只剩半截 base64,渲染出来就是一屏乱码;
      // 助手消息没有 attachments 可重建,这里把残片收成一句说明。
      window.OCRenderer.renderInto(root, stripBrokenDataImages(m.content || ''));
      highlightGroupMentions(root, chat);
      // HTML/SVG 代码块附加「在 Artifacts 中打开」按钮
      if (window.OCMultimodal && window.OCMultimodal.enhanceArtifactButtons) {
        window.OCMultimodal.enhanceArtifactButtons(root);
      }
      // 来源引用 [n] → 可点击上标
      if (window.OCCitations && m.citations && m.citations.length) {
        window.OCCitations.enhanceCitations(root, m.citations);
      }
      // 末尾「参考笔记」来源行(仅回答侧;挂在 contentDiv 内,不挤正文也不会重复)
      appendNoteRefs(contentDiv, m);
    }
  } else {
    // 用户消息：走渲染管线以支持附件（图片/文件卡片），但限制富文本能力
    // @笔记 引用只用于注入上下文,展示时从正文里剥掉,改在气泡内回显引用
    const raw = String(m.content || '');
    let shown = raw.split(NOTE_CTX_SEP)[0];
    // 早期版本点「整个文件夹」会漏删输入框里正在输入的 @,于是消息开头多一个孤立的 @
    // (现已修)。按「带笔记上下文 + 开头是孤立 @」识别,用户自己写的 @未分类 不受影响。
    if (raw.indexOf(NOTE_CTX_SEP) >= 0) shown = shown.replace(/^\s*@(?=\s|$)\s*/, '');
    // 图片以附件为准确来源重建(云端同步会截断 content 里的内联 base64);
    // 连附件副本都被上限裁掉的极端情况,再把残片收成一句说明,不留一屏乱码。
    shown = stripBrokenDataImages(userMsgDisplay(m, shown));
    const root = document.createElement('div');
    contentDiv.appendChild(root);
    // 用户输入的 HTML 按字面显示而不是解析:先转义再走 Markdown(表格/代码/公式仍正常),
    // 否则 <script> 会被清洗到整段消失、<img src=x> 渲染成裂图,和用户输入不一致
    window.OCRenderer.renderInto(root, escapeHtml(shown));
    // 回显这条提问选中的 @助手 / @文件夹 / @笔记(与输入框同一套配色)
    appendMsgMentions(root, m.mentions);
  }
  div.appendChild(contentDiv);

  // 操作栏 + 快捷指令（仅在非流式完成时）
  if (role === 'assistant' && !m._streaming && (m.content || m.reasoning || replyWasInterrupted(m))) {
  window.OCMessages.attachActions(div, m, {
    onRegenerate: (mm) => regenerateMessage(mm, chat),
    onAt: (mm, btn) => openAtAnswerModal(mm, chat, btn),
    onShare: (mm) => shareMessage(mm),
    onSaveNote: (mm) => saveMessageToNotes(mm, chat),
    onVote: submitMessageVote,
    onQuickAction: quickAction,
    onBranch: (mm) => branchFromMessage(mm, chat),
    onDelete: (mm) => deleteMessage(mm, chat),
  });
    // 跟进建议
    if (m.followUps && m.followUps.length) {
      window.OCMultimodal.renderFollowUps(div, m.followUps, applyFollowUp);
    }
    // 来源列表
    if (m.citations && m.citations.length && window.OCCitations) {
      window.OCCitations.renderSources(div, m.citations);
    }
    // 耗时显示
    if (typeof renderElapsed === 'function') renderElapsed(div, m);
  }
  if (role === 'user' && !m._streaming) {
    window.OCMessages.attachActions(div, m, {
      onEdit: (mm, el) => editAndResend(mm, chat, el || div),
      onBranch: (mm) => branchFromMessage(mm, chat),
      onDelete: (mm) => deleteMessage(mm, chat),
    });
    const clock = formatMsgClock(m.createdAt);
    if (clock) {
      const bar = div.querySelector('.msg-actions');
      if (bar) {
        const time = document.createElement('span');
        time.className = 'reply-time';
        time.textContent = clock;
        time.title = '提问时间';
        bar.appendChild(time);
      }
    }
  }
  return div;
}

// ============ 供应商 / 模型 ============
function persistCurrentModel() {
  if (!(window.OCUI && window.OCUI.setPref)) return;
  window.OCUI.setPref('lastProviderId', state.currentProviderId || null);
  window.OCUI.setPref('lastModel', state.currentModel || null);
}
function pinnedModelId() { return uiPref('pinnedModel', null) || null; }
function pinnedProviderId() { return uiPref('pinnedProviderId', null) || null; }
function isPinnedModel(id) {
  return !!id && id === pinnedModelId() && (!pinnedProviderId() || pinnedProviderId() === state.currentProviderId);
}
function togglePinModel(modelId) {
  if (!modelId || !(window.OCUI && window.OCUI.setPref)) return pinnedModelId();
  if (isPinnedModel(modelId)) {
    window.OCUI.setPref('pinnedModel', null);
    window.OCUI.setPref('pinnedProviderId', null);
    toast('已取消置顶');
  } else {
    window.OCUI.setPref('pinnedModel', modelId);
    window.OCUI.setPref('pinnedProviderId', state.currentProviderId);
    toast('已置顶，新建对话将使用此模型');
  }
  renderModelPicker();
  const now = pinnedModelId();
  document.querySelectorAll('.oc-menu-pin').forEach((btn) => {
    const on = btn.getAttribute('data-pin') === now && isPinnedModel(now);
    btn.classList.toggle('active', on);
    btn.title = on ? '取消置顶' : '置顶，新建对话使用此模型';
  });
  return now;
}
async function applyPinnedModel() {
  const pinProv = pinnedProviderId();
  const pinModel = pinnedModelId();
  if (!pinModel) return;
  if (pinProv && pinProv !== state.currentProviderId) {
    if (!state.providers.some((p) => p.id === pinProv)) return;
    state.currentProviderId = pinProv;
    await loadModels({ prefer: pinModel });
    renderProviderLabel();
    return;
  }
  if (state.models.some((m) => m.id === pinModel) && state.currentModel !== pinModel) {
    state.currentModel = pinModel;
    persistCurrentModel();
    renderModelPicker();
  }
}
async function loadProviders() {
  const r = await api('/api/providers');
  const data = await r.json();
  // 已停用的供应商(仅管理员会从接口拿到)不在聊天侧展示与选用,后台管理列表除外
  state.providers = (data.providers || []).filter((p) => p.enabled !== false);
  state.defaultProviderId = data.defaultProviderId;
  state.webSearchAvailable = !!(data.webSearch && data.webSearch.enabled);
  state.mineru = (data.mineru && data.mineru.mode) ? data.mineru : { enabled: true, mode: 'lite' };
  if (data.chatLimits) {
    state.chatLimits = {
      contextMessages: Math.min(500, Math.max(2, Number(data.chatLimits.contextMessages) || 12)),
      maxContextMessages: Math.min(500, Math.max(2, Number(data.chatLimits.maxContextMessages) || 200)),
    };
  }
  if (!state.tools) {
    state.tools = {
      webSearch: { allowOwn: !!(data.webSearch && data.webSearch.allowOwn), platformReady: state.webSearchAvailable, source: 'platform', ownReady: false },
      parse: { allowOwn: !!(data.mineru && data.mineru.allowOwn), platformMode: state.mineru.mode, source: 'platform', hasToken: false },
    };
  }
  if (typeof syncComposerWebSearch === 'function') syncComposerWebSearch();
  // 标记需要点选默认供应商的场景
  const provs = state.providers;
  const lastProv = uiPref('lastProviderId', null);
  const pinProv = pinnedProviderId();
  const d = provs.find((p) => p.id === lastProv)
    || provs.find((p) => p.id === pinProv)
    || provs.find((p) => p.id === state.defaultProviderId)
    || provs.find((p) => p.scope === 'global')
    || provs.find((p) => p.ownerId === (state.user && state.user.id))
    || state.providers[0];
  state.currentProviderId = d ? d.id : null;
  await loadModels({ prefer: pinnedModelId() });
  await applyPinnedModel();
  renderProviderLabel();
  // 对话在供应商之前就画过一次,标签当时对不上「供应商@模型」,这里补画
  if (!state.streaming) renderMessages();
}
async function loadModels(opts) {
  opts = opts || {};
  state.currentModel = null;
  state.models = [];
  if (!state.currentProviderId) { renderModelPicker(); return; }

  const r = await api('/api/proxy/models?provider=' + encodeURIComponent(state.currentProviderId));
  const data = await r.json();
  const prov = state.providers.find((p) => p.id === state.currentProviderId);
  state.models = data.models || [];
  state.modelHealth = data.health && typeof data.health === 'object' ? data.health : {};
  state.modelCosts = data.costs && typeof data.costs === 'object' ? data.costs : {};
  const prefer = opts.prefer || pinnedModelId() || uiPref('lastModel', null);
  const found = prefer && state.models.find((x) => x.id === prefer);
  if (found) state.currentModel = found.id;
  else if (prov) state.currentModel = (state.models[0] ? state.models[0].id : null) || prov.defaultModel || null;
  else if (state.models.length) state.currentModel = state.models[0].id;
  persistCurrentModel();
  renderModelPicker();
  // 切换后若当前模型是生图/生视频模型,自动取消 @助手
  if (modelIsVisual(state.currentModel)) enforceImageModelAssistant({ silent: true });
}
// 当前供应商下某模型的单次扣减次数:模型级 cost 优先(costs 映射),否则用供应商价
function modelCostOf(id, providerId) {
  const pid = providerId || state.currentProviderId;
  const prov = (state.providers || []).find((p) => p.id === pid);
  if (!prov) return null;
  const m = (prov.models || []).find((x) => x && String(x.id) === String(id));
  if (m && Object.prototype.hasOwnProperty.call(m, 'cost')) {
    const c = Number(m.cost);
    if (isFinite(c) && c >= 0) return c;
  }
  if (pid === state.currentProviderId && state.modelCosts && Object.prototype.hasOwnProperty.call(state.modelCosts, String(id))) {
    const c = Number(state.modelCosts[String(id)]);
    if (isFinite(c) && c >= 0) return c;
  }
  // 属主自己的供应商不计费
  if (state.user && ((prov.ownerId && String(prov.ownerId) === String(state.user.id)) || prov.mine)) return 0;
  const pc = Number(prov.costPerCall);
  return isFinite(pc) && pc >= 0 ? pc : null;
}
function costTextOf(id, providerId) {
  const c = modelCostOf(id, providerId);
  if (c === null) return '';
  return c === 0 ? '免费（不计站点次数）' : ('每次调用扣 ' + c + ' 次');
}
// 可用性分级:阈值由后台「对话设置 → 模型可用性显示」配置
function healthLabelOf(stateName) {
  if (stateName === 'ok') return '可用';
  if (stateName === 'warn') return '不稳定';
  if (stateName === 'bad') return '较差';
  return '暂无数据';
}
function modelHealthOf(id, providerId) {
  const row = id && state.modelHealth ? state.modelHealth[id] : null;
  const allowed = ['ok', 'warn', 'bad'];
  const stateName = row && allowed.indexOf(row.state) >= 0 ? row.state : 'idle';
  const calls = row && Number(row.calls) > 0 ? Number(row.calls) : 0;
  const rate = row && isFinite(Number(row.rate)) ? Math.round(Number(row.rate) * 100) : 0;
  const cost = costTextOf(id, providerId);
  const costLine = cost ? String.fromCharCode(10) + cost : '';
  if (stateName === 'idle') return { state: 'idle', title: '最近 4 小时无人调用' + costLine };
  return {
    state: stateName,
    title: healthLabelOf(stateName) + '：最近 4 小时 ' + calls + ' 次调用，成功率 ' + rate + '%' + costLine,
  };
}
function healthIconName(stateName) {
  if (stateName === 'ok') return 'healthOk';
  if (stateName === 'bad') return 'healthBad';
  return 'healthIdle';   // idle 与 warn 共用省略号图标(warn 由文字与颜色区分)
}
function providerNameOf(providerId) {
  const p = (state.providers || []).find((x) => x.id === providerId);
  return (p && p.name) || '';
}
function modelDisplayName(model) {
  const provider = state.providers.find((x) => x.id === state.currentProviderId);
  const name = model && (model.name || model.id);
  // 汇总项不自带「供应商@」前缀(它的名字本身就是前台展示名)
  if (provider && provider.agg) return name || '';
  return provider && name ? provider.name + '@' + name : (name || '');
}
// 按「供应商 + 模型」在模型切换列表里找同一项。
// 旧回答可能只存了模型 id、没有供应商,精确对不上时按模型 id 回退,
// 这样标签仍能显示 logo 和「供应商@模型」,和侧栏模型切换列表一致。
function findModelItem(providerId, modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  const flat = [];
  availableModelItems().forEach((g) => (g.items || []).forEach((it) => flat.push(it)));
  const pid = String(providerId || '');
  if (pid) {
    const exact = flat.find((it) => it.providerId === pid && it.modelId === id);
    if (exact) return exact;
  }
  return flat.find((it) => it.modelId === id) || null;
}
function renderModelPicker() {
  const nameEl = $('model-name');
  if (!nameEl) return;
  if (!state.currentModel) {
    nameEl.textContent = state.models && state.models.length ? '' : '选择模型';
    if (!state.models || !state.models.length) nameEl.textContent = '暂无模型';
  } else {
    const m = state.models.find((x) => x.id === state.currentModel);
    nameEl.textContent = modelDisplayName(m) || state.currentModel;
  }
  const picker = $('model-picker');
  if (picker) picker.classList.toggle('is-pinned', isPinnedModel(state.currentModel));
  const health = $('model-health');
  const mark = $('model-pin-mark');
  const pinned = isPinnedModel(state.currentModel);
  if (health) {
    const info = modelHealthOf(state.currentModel);
    health.classList.remove('hidden', 'ok', 'bad', 'idle');
    if (!state.currentModel) health.classList.add('hidden');
    else {
      health.classList.add(info.state);
      health.title = info.title;
      health.innerHTML = window.OC && window.OC.icon ? window.OC.icon(healthIconName(info.state), 12) : '';
    }
  }
  if (mark) {
    mark.classList.toggle('hidden', !pinned);
    mark.classList.toggle('solo', !state.currentModel);
  }
  syncComposerTools();
}
// 后台是否有任何可用的生图 / 生视频模型:决定「≡」菜单里的「绘画」「生视频」入口是否显示。
// 一个都没有时(纯对话站)不显示对应入口,避免点开才发现没有模型。
function hasAnyImageModel() {
  return (state.providers || []).some((p) => (p.models || []).some((m) => m && m.id && modelIsImage(m.id)));
}
function hasAnyVideoModel() {
  return (state.providers || []).some((p) => (p.models || []).some((m) => m && m.id && modelIsVideo(m.id)));
}
function syncComposerTools() {
  const imgTool = $('composer-tool-image');
  const vidTool = $('composer-tool-video');
  if (imgTool) imgTool.classList.toggle('hidden', !hasAnyImageModel());
  if (vidTool) vidTool.classList.toggle('hidden', !hasAnyVideoModel());
}
function renderProviderLabel() {
  const p = state.providers.find((x) => x.id === state.currentProviderId);
  const hint = $('empty-hint');
  if (!hint) return;
  if (p) {
    hint.textContent = '';
    hint.hidden = true;
  } else {
    hint.hidden = false;
    hint.textContent = '暂无可用的 API 供应商，点击左下角「设置」添加';
  }
}

// 自定义模型选择器：汇总所有有权限的供应商模型
// 模型选择器的分组:对话模型在前,生图模型自动归入末尾的「生图模型」分组。
// openSelect 检测 groups[0].label !== undefined 时按分组渲染。
function availableModelItems() {
  const chat = [];
  const image = [];
  const video = [];
  (state.providers || []).forEach((provider) => {
    (provider.models || []).forEach((m) => {
      const id = m && m.id ? String(m.id) : '';
      if (!id) return;
      const name = m.name || id;
      const health = provider.id === state.currentProviderId
        ? modelHealthOf(id, provider.id)
        : (function () {
            // 非当前供应商没有健康数据,但仍显示价格(提示里最有用的信息)
            const c = modelCostOf(id, provider.id);
            const costLine = (c === null) ? '' : (String.fromCharCode(10) + (c === 0 ? '免费（不计站点次数）' : ('每次调用扣 ' + c + ' 次')));
            return { state: 'idle', title: '最近 4 小时无人调用' + costLine };
          })();
      const isVideo = provider.apiFormat === 'video'
        || (Object.prototype.hasOwnProperty.call(m, 'video')
          ? !!m.video
          : !!((window.OC && OC.isVideoModelName) ? OC.isVideoModelName(id) : false));
      const isImage = !isVideo && (Object.prototype.hasOwnProperty.call(m, 'image')
        ? !!m.image
        : !!((window.OC && OC.isImageModelName) ? OC.isImageModelName(id) : false));
      const logo = (window.OC && OC.modelIcon)
        ? OC.modelIcon(id + ' ' + name, provider.name, isImage, isVideo)
        : '';
      const item = {
        value: provider.id + '\n' + id, providerId: provider.id, modelId: id,
        // 汇总项(多个渠道聚合成一个 ID)只显示模型名:前台看上去和一个普通模型
        // 完全一样,不再拼成「汇总名@汇总名」这种重复的标签。
        label: provider.agg ? name : (provider.name + '@' + name),
        providerName: provider.name || '', search: provider.name + ' ' + id + ' ' + name,
        health: health.state, healthTitle: health.title, icon: logo, isImage, isVideo,
        agg: !!provider.agg, aggStrategy: provider.aggStrategy || '', aggCount: Number(provider.aggCount) || 0,
      };
      (isVideo ? video : (isImage ? image : chat)).push(item);
    });
  });
  // 后台可排序:供应商顺序(接口按 order 升序下发)与各供应商内的模型顺序(数组原序)原样保留。
  // 不再按名称重排,否则后台调整的供应商顺序在前台会被打乱。
  const groups = [];
  const hasVisual = image.length || video.length;
  if (chat.length) groups.push({ label: hasVisual ? '对话模型' : '', items: chat });
  if (image.length) groups.push({ label: '生图模型', items: image });
  if (video.length) groups.push({ label: '生视频模型', items: video });
  return groups;
}
function togglePinnedSelection(value) {
  const parts = String(value || '').split('\n'); const providerId = parts[0], modelId = parts.slice(1).join('\n');
  if (!providerId || !modelId || !(window.OCUI && window.OCUI.setPref)) return;
  const same = pinnedProviderId() === providerId && pinnedModelId() === modelId;
  window.OCUI.setPref('pinnedProviderId', same ? null : providerId);
  window.OCUI.setPref('pinnedModel', same ? null : modelId);
  toast(same ? '已取消置顶' : '已置顶，新建对话将使用此模型');
  renderModelPicker();
}
const modelPickerEl = $('model-picker');
if (modelPickerEl) {
  modelPickerEl.addEventListener('click', () => {
    const groups = availableModelItems();
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (!total) { toast('暂无可用模型', true); return; }
    const selected = state.currentProviderId && state.currentModel ? state.currentProviderId + '\n' + state.currentModel : null;
    OC.openSelect(modelPickerEl, groups, {
      menuClass: 'oc-model-menu',
      fitWidth: true,
      selected,
      pinned: pinnedProviderId() && pinnedModelId() ? pinnedProviderId() + '\n' + pinnedModelId() : null,
      searchable: total > 8,
      searchPlaceholder: '搜索供应商或模型…',
      chips: (state.providers || []).length > 1 ? state.providers.map((p) => ({ value: p.id, label: p.name || p.id, icon: window.OC && OC.providerLogo ? OC.providerLogo(p.models, p.name) : '' })) : null,
      onSelect: async (val, item) => {
        const parts = String(val).split('\n');
        state.currentProviderId = parts[0];
        await loadModels({ prefer: parts.slice(1).join('\n') });
        renderProviderLabel();
        renderModelPicker();
        if (item && (item.isImage || item.isVideo)) enforceImageModelAssistant();
      },
      onPin: (val) => togglePinnedSelection(val),
    });
  });
  modelPickerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); modelPickerEl.click(); }
  });
}

// ============ 发送消息 ============
function messageApiContent(m, format) {
  if (m.role === 'user' && m.attachments && m.attachments.length && window.OCMultimodal && window.OCMultimodal.toApiContent) {
    return window.OCMultimodal.toApiContent(m.text != null ? m.text : '', m.attachments, format);
  }
  if (typeof m.content === 'string' || Array.isArray(m.content)) return m.content;
  return '';
}
function flattenApiContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (part.text) return part.text;
    if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') return '[图片]';
    return '';
  }).filter(Boolean).join('\n');
}
function chatSystemPrompt(chat) {
  const base = String((chat && chat.systemPrompt) || '').trim();
  // 群聊模式下,由发送管线临时挂载当前发言成员的角色预设(state._pendingRolePrompt)
  const role = String(state._pendingRolePrompt || '').trim();
  return role ? (base ? base + '\n\n' + role : role) : base;
}
function contextLimitNow() {
  const site = state.chatLimits || {};
  const cap = Math.min(500, Math.max(2, Number(site.maxContextMessages) || 200));
  const fallback = Math.min(cap, Math.max(2, Number(site.contextMessages) || 12));
  const chosen = Number(uiPref('contextMessages', fallback));
  return Math.min(cap, Math.max(2, isFinite(chosen) ? chosen : fallback));
}
// 粗略 token 估算:中日韩按 1 token/字,其余按 4 字符/token(与服务端同一口径,宁高勿低)
function estimateTextTokens(s) {
  const str = String(s || '');
  if (!str) return 0;
  const cjk = (str.match(/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaf6\uff00-\uffef]/g) || []).length;
  return Math.round(cjk + (str.length - cjk) / 4);
}
function estimateMessageTokens(m) {
  let n = estimateTextTokens(flattenApiContent(messageApiContent(m, 'chat')));
  // 图片/文件附件按固定开销计,避免按文本低估
  if (m && Array.isArray(m.attachments)) n += m.attachments.length * 1024;
  return n;
}
function currentModelSpec() {
  if (!state.currentModel) return null;
  return (state.models || []).find((x) => x && x.id === state.currentModel) || null;
}
function outgoingMessages(chatMessages, chat) {
  let source = chatMessages || [];
  let baselineAt = -1;
  for (let i = source.length - 1; i >= 0; i--) {
    if (source[i] && source[i].contextBaseline) { baselineAt = i; break; }
  }
  if (baselineAt > 0) {
    let priorUser = null;
    for (let i = baselineAt - 1; i >= 0; i--) {
      if (source[i] && source[i].role === 'user') { priorUser = source[i]; break; }
    }
    source = (priorUser ? [priorUser] : []).concat(source.slice(baselineAt));
  }
  const msgs = source.filter((m) => m && m.role !== 'system');
  const limit = contextLimitNow();
  let kept = msgs.length > limit ? msgs.slice(-limit) : msgs;
  // 模型的上下文窗口来自「模型元数据」表(随模型清单下发),再做一轮 token 预算裁剪:
  // 输入 + 预留输出不超过窗口
  const spec = currentModelSpec();
  const maxCtx = spec && parseInt(spec.maxContext, 10) > 0 ? parseInt(spec.maxContext, 10) : 0;
  if (maxCtx > 0 && kept.length) {
    const outCap = spec && parseInt(spec.maxTokens, 10) > 0 ? parseInt(spec.maxTokens, 10) : 0;
    const reserve = Math.min(outCap > 0 ? outCap : Math.floor(maxCtx / 2), Math.max(256, Math.floor(maxCtx / 2)));
    const budget = maxCtx - reserve;
    const sysTokens = estimateTextTokens(chatSystemPrompt(chat));
    const costs = kept.map((m) => estimateMessageTokens(m));
    let total = sysTokens + costs.reduce((a, b) => a + b, 0);
    let drop = 0;
    while (total > budget && drop < kept.length - 1) {
      total -= costs[drop];
      drop++;
    }
    if (drop > 0) kept = kept.slice(drop);
  }
  const prompt = chatSystemPrompt(chat);
  const out = prompt ? [{ role: 'system', content: prompt }].concat(kept) : kept;
  out.contextCount = kept.length;
  out.contextLimit = limit;
  return out;
}
function modelVendor(model) {
  const id = String(model || '').toLowerCase();
  if (/claude|anthropic/.test(id)) return 'anthropic';
  if (/deepseek/.test(id)) return 'deepseek';
  if (/(^|\/|:)(gpt-|o[1-9]|chatgpt)/.test(id) || /openai/.test(id)) return 'openai';
  return '';
}
// 部分模型只支持 effort 档位的子集,直接发界面的档位会被上游整包拒绝。
// 已知限制(匹配模型 ID,不区分供应商;遇到新模型在这里加一行即可):
//   Kimi K3(Nvidia/官方)只接受 low/high/max,没有 medium
//   Grok 3 mini(xAI)只接受 low/high
// 策略与 DeepSeek 一致:就近向上取档(中→高),保留推理强度而不是丢掉参数。
const MODEL_EFFORT_SUPPORT = [
  { test: /kimi-k3|kimi_k3|kimi k3/, levels: ['low', 'high', 'max'] },
  { test: /grok-3-mini/, levels: ['low', 'high'] },
];
function compatEffort(model, effort) {
  const id = String(model || '').toLowerCase();
  if (!effort || effort === 'off') return effort;
  for (const rule of MODEL_EFFORT_SUPPORT) {
    if (!rule.test.test(id) || rule.levels.includes(effort)) continue;
    const order = ['low', 'medium', 'high', 'max'];
    const idx = order.indexOf(effort);
    if (idx < 0) return effort;
    for (let i = idx + 1; i < order.length; i++) if (rule.levels.includes(order[i])) return order[i];
    for (let i = idx - 1; i >= 0; i--) if (rule.levels.includes(order[i])) return order[i];
    return effort;
  }
  return effort;
}
function applyReasoningToBody(body, format) {
  const enabled = reasoningEnabled();
  const vendor = modelVendor(body && body.model);
  const model = String((body && body.model) || '').toLowerCase();
  const effort = compatEffort(model, reasoningEffort());
  const deepseekEffort = effort === 'low' ? 'low' : 'high';
  if (format === 'anthropic') {
    if (!enabled) return body;
    if (vendor === 'deepseek') {
      body.thinking = { type: 'enabled' };
      body.output_config = { effort: deepseekEffort };
      return body;
    }
    if (vendor === 'anthropic' && /claude-(?:opus|sonnet|haiku)-4-6/.test(model)) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: effort };
      return body;
    }
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudgetFor(effort) };
    return body;
  }
  if (format === 'responses') {
    if (!enabled) {
      if (vendor === 'deepseek') body.reasoning = { effort: 'none' };
      return body;
    }
    body.reasoning = { effort: vendor === 'deepseek' ? deepseekEffort : effort };
    if (vendor !== 'deepseek') {
      body.reasoning.summary = 'auto';
      body.include = Array.from(new Set((body.include || []).concat(['reasoning.encrypted_content'])));
    }
    return body;
  }
  if (vendor === 'deepseek') {
    body.thinking = { type: enabled ? 'enabled' : 'disabled' };
    if (enabled) {
      // DeepSeek 官方映射：界面“中”对应实际 high，不能直接发送 medium/max。
      body.reasoning_effort = deepseekEffort;
    }
    return body;
  }
  if (!enabled) return body;
  // OpenAI Chat Completions and compatible gateways use the top-level field.
  body.reasoning_effort = effort;
  return body;
}

// 当前模型的输出上限与上下文窗口:来自「模型元数据」表(随模型清单下发),
// 供应商与对话设置里都不再配置这两项。清单接口保证有值,这里只做兜底。
function modelCapsNow() {
  const spec = currentModelSpec();
  const out = spec && parseInt(spec.maxTokens, 10) > 0 ? parseInt(spec.maxTokens, 10) : FALLBACK_MAX_OUTPUT;
  const ctx = spec && parseInt(spec.maxContext, 10) > 0 ? parseInt(spec.maxContext, 10) : FALLBACK_MAX_CONTEXT;
  return { out, ctx };
}
function thinkingBudgetFor(effort) {
  return effort === 'high' ? 16000 : effort === 'low' ? 2048 : 8000;
}
// 思维链与正文共用输出额度:预算放不下时压缩思维预算,而不是抬高输出上限
// (上限是模型能力的天花板)。服务端发出前还会再兜一次。
function fitThinkingBudget(body, cap) {
  const t = body && body.thinking;
  if (!t || typeof t !== 'object' || t.type === 'disabled') return;
  if (!t.budget_tokens) return;
  const budget = parseInt(t.budget_tokens, 10) || 0;
  if (budget <= 0) return;
  const limit = parseFloat(cap) > 0 ? cap : budget + 2048;
  let room = limit - 2048;
  if (room < 1024) room = 1024;
  if (room > limit - 1) room = limit - 1;
  if (room < 1) room = 1;
  if (budget > room) t.budget_tokens = room;
}
function buildRequestBody(chatMessages, format, chat, extra) {
  const msgs = outgoingMessages(chatMessages, chat);
  const cap = modelCapsNow().out;
  const system = chatSystemPrompt(chat);
  if (format === 'anthropic') {
    const body = {
      model: state.currentModel,
      stream: state.streamToggle,
      max_tokens: cap,
      messages: msgs.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: messageApiContent(m, format),
      })),
    };
    if (system) body.system = system;
    if (state.currentProviderId) body.providerId = state.currentProviderId;
    const readyA = attachWebSearchFlag(applyReasoningToBody(body, format));
    fitThinkingBudget(readyA, cap);
    return stampContext(readyA, msgs);
  }
  if (format === 'responses') {
    const body = {
      model: state.currentModel,
      stream: state.streamToggle,
      // 每一项都必须是 {role, content} 对象:Responses 只接受顶层字符串或对象数组,
      // 纯文本消息若按裸字符串放进数组(如 ["你好"]),上游会判成「不支持的参数」直接 400。
      input: msgs.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: messageApiContent(m, format),
      })),
    };
    if (system) body.instructions = system;
    if (state.currentProviderId) body.providerId = state.currentProviderId;
    const readyR = attachWebSearchFlag(applyReasoningToBody(body, format));
    readyR.max_output_tokens = cap;
    return stampContext(readyR, msgs);
  }
  if (format === 'completions') {
    const head = system ? 'System: ' + system + '\n\n' : '';
    const bodyC = attachWebSearchFlag({
      model: state.currentModel,
      stream: state.streamToggle,
      max_tokens: cap,
      prompt: head + msgs.filter((m) => m.role !== 'system').map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + flattenApiContent(messageApiContent(m, format))).join('\n\n'),
    });
    if (state.currentProviderId) bodyC.providerId = state.currentProviderId;
    return stampContext(bodyC, msgs);
  }
  // chat
  const body = applyReasoningToBody({
    model: state.currentModel,
    stream: state.streamToggle,
    messages: msgs.map((m) => ({ role: m.role, content: messageApiContent(m, format) })),
  }, format);
  if (state.currentProviderId) body.providerId = state.currentProviderId;
  const ready = attachWebSearchFlag(body);
  // 输出上限 = 该模型在「模型元数据」里的值;思维预算放不下时压缩思维预算保住正文
  ready.max_tokens = cap;
  fitThinkingBudget(ready, cap);
  if (extra && extra.continueFrom) ready.webSearch = 'off';
  return stampContext(ready, msgs);
}
function stampContext(body, msgs) {
  body._contextCount = msgs.contextCount || 0;
  body._contextLimit = msgs.contextLimit || body._contextCount;
  return body;
}

function attachWebSearchFlag(body) {
  const mode = webSearchMode();
  if (mode === 'on' || mode === 'off') { body.webSearch = mode; state._toolSearch = null; return body; }
  if (mode === 'auto') {
    // 智能:优先用统一 AI 工具判定给出的结果(省一次主模型判定);否则交给后端启发式
    if (state._toolSearch === true || state._toolSearch === false) {
      body.webSearch = state._toolSearch ? 'on' : 'off';
    } else {
      body.webSearch = 'auto';
    }
    state._toolSearch = null;
  }
  return body;
}
function citationsFromResponse(resp) {
  if (!resp || !resp.headers || !resp.headers.get) return [];
  const raw = resp.headers.get('X-Oc-Citations') || resp.headers.get('x-oc-citations');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
function applyCitations(assistantMsg, resp) {
  const cites = citationsFromResponse(resp);
  if (cites.length) assistantMsg.citations = cites;
}

function applyFollowUp(q) {
  const text = String(q || '').trim();
  if (!text) return;
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const input = $('input');
  if (!input) return;
  input.value = text;
  autosizeInput();
  updateSendBtn();
  sendMessage();
}
// 对话模型下识别「要画图」意图:出现明确的绘图口令即认为要出图。
// 例:「画一张…」「帮我画个…」「生成一张图」「来张海报」「画个 logo」「draw …」
function wantsDrawImage(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 明显是在「问/讨论」而不是「下命令」时不触发:
  // 以疑问收尾,或含「是什么/为什么/如何/怎么/能不能」等讨论性措辞,或过去式叙述(我画了…)
  if (/[?？]$/.test(t) || /[吗呢]$/.test(t)) return false;
  if (/(是什么|为什么|啥意思|什么意思|如何|怎么|怎样|能不能|可否|可不可以|是不是)/.test(t)) return false;
  // 过去式叙述(我画了/他画了…),但「帮我画/给我画/替我画/为你画」属祈使,不算
  if (/(^|[^帮给替为])(我|他|她|他们|她们)画了?/.test(t)) return false;
  const drawRe = /(画一张|画一幅|画一个|画个|画张|画幅|帮我画|给我画|帮忙画|替我画|画一下|画出来|绘制|重新画|再画|重画|生成图片|生成图像|生成一张|生成一幅|生成个图|生成插画|生成海报|生成头像|生成logo|生成标志|出一张图|出个图|来一张图|来张图|做个图|做一张图|设计一张|设计个logo|设计一个logo)/i;
  if (drawRe.test(t)) return true;
  // 「画 + 数量词 + 对象」:如「画一只柯基」「画两张海报」(已排除疑问/叙述)
  if (/画[一二三四五六七八九十两几]?[只个条张幅匹头朵棵盆群尾轮帧]/.test(t)) return true;
  if (/\b(draw|paint|sketch|illustrate|generate an image|create an image|make an image|generate a picture|create a picture|render an image)\b/i.test(t)) return true;
  return false;
}
// 「编辑已有图片」意图:必须有可用的参考图(本次附件或本会话上一张生成图),且有明确编辑动词。
// 单独的「这张图是什么」这类看图问题不应命中。
function wantsEditImage(text) {
  const t = String(text || '');
  if (!t) return false;
  return /(改成|换成|修改|改一下|改变|调整成|调整一下|变成|变为|去掉|删除掉|删掉|加个|加上|添加|添个|换个|替换成|替换|重新画|再画|重画)/.test(t);
}
// 对上一张生成图的「评价式反馈」(无编辑动词,如「不够优雅」「太暗了」「背景太乱」)。
// 这类短句在会话里有生成图时,几乎都是在要求重画/改图;此前只认编辑动词,
// 导致「不够优雅」被当普通对话发给对话模型,表现为「追问第二轮不出图」。
function wantsImageFeedback(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 纯致谢/确认不算
  if (/^(谢谢|好的|好|嗯|行|收到|辛苦了|ok|OK|thanks?)[！!。.~～]?$/.test(t)) return false;
  // 过长通常是新指令或新问题,不算轻量反馈
  if (t.length > 40) return false;
  // 提问不算(用户在问,不是要改)
  if (/[?？]$/.test(t) || /(是什么|为什么|啥意思|什么意思|如何|怎么|怎样|能不能|可否|是不是)/.test(t) || /[吗呢]$/.test(t)) return false;
  // 欠缺/程度类:「不够优雅」「不太行」「再亮一点」「更柔和一些」
  if (/(不够|不太|不怎么|缺少|少了|缺了)/.test(t)) return true;
  // 负面评价类:「不好看」「太乱」「不自然」(注意先于夸赞词判断:「不好看」含「好看」)
  if (/(不好看|难看|好丑|太丑|奇怪|违和|诡异|不协调|不和谐|太乱|太杂|太脏|太糊|模糊|不清楚|不清晰|太暗|太亮|太假|不自然|生硬|呆板|死板|单调|空洞|敷衍)/.test(t)) return true;
  if (/(更|再)[^，。！？!?]{0,8}(一点|一些|点)/.test(t)) return true;
  if (/[^，。！？!?]{1,8}(一点|一些)($|[，。！？!?])/.test(t)) return true;
  // 「有点糊」「有些怪」这类轻量负面
  if (/(有点|有些|略微|稍微|稍微有点)[^，。！？!?]{0,6}(糊|脏|乱|暗|亮|假|怪|丑|土|僵|虚|油|崩|歪|斜|廉价|塑料|违和|奇怪|生硬|死板)/.test(t)) return true;
  // 画面要素 + 负向词:「背景太乱」「颜色不对」「光线不好」
  if (/(背景|颜色|色调|配色|构图|光线|光影|氛围|细节|姿势|表情|服装|衣服|脸|手|眼睛)[^，。！？!?]{0,6}(不对|不好|太|怪|乱|假|糊|脏|暗|亮)/.test(t)) return true;
  // 正面夸赞不算(用户满意,不需要重画)
  if (/(太棒|太好|太美|太漂亮|太帅|太可爱|太惊艳|太赞|很喜欢|太满意|完美|好看)/.test(t)) return false;
  return false;
}
// 文本是否明确指代「上一张图」(决定追问是否把它作为参考图)
function refersToPrevImage(text) {
  return /(上面|刚才|上一张|上张|之前|这张图|这张|那张图|那张|这个图|那个图|此图|它)/.test(String(text || ''));
}
// 对话中自动出图的模式:off=关闭 | rough=粗略关键词识别 | auto=智能判定(用统一工具判定模型)
function autoImageMode() {
  const v = String(uiPref('autoImageMode', 'auto') || 'auto').toLowerCase();
  if (v === 'off' || v === 'rough' || v === 'auto' || v === 'ai') return v === 'ai' ? 'auto' : v;
  return 'rough';
}
// 统一的「AI 工具判定」:一次轻量调用判定本次发言需要启用哪些工具/功能。
// ctx: { imageEnabled, searchEnabled, prevImage } → 返回 {draw,edit,search,title}|null(判定失败)。
// 判定模型 = 设置里的「AI 工具判定模型」,未设置则跟随当前对话模型。判定会额外消耗一次调用。
async function aiJudgeTools(text, ctx) {
  ctx = ctx || {};
  const aux = resolveAuxModel('judgeModel');
  const providerId = aux ? aux.providerId : state.currentProviderId;
  const model = aux ? aux.model : state.currentModel;
  const format = aux ? aux.format : providerFormat();
  if (!providerId || !model) return null;
  const wantImage = ctx.imageEnabled !== false;
  const wantSearch = !!ctx.searchEnabled;
  const wantTitle = !!ctx.wantTitle;
  let sys = '你是「AI 助手调度器」。根据用户最新一句话判断这次回答需要启用哪些能力，只输出一个 JSON 对象，不要输出任何解释或多余文字。字段：'
    + '{"search":true|false,"draw":true|false,"edit":true|false'
    + (wantTitle ? ',"title":"简短标题"' : '') + '}。'
    + 'search=需要联网检索最新/实时信息（如新闻、天气、股价、当前时间、近期事件、需查证的事实）；闲聊、写作、代码、翻译、数学等不联网。';
  if (wantImage) {
    sys += 'draw=用户在要求生成一张新图片（如「画一只猫」「生成海报」）；edit=用户在要求修改已有的图片，也包括对上一张图表达不满或要求改进（如「把上面的图换成蓝色」「不够优雅」「颜色太暗，再亮一点」）。'
      + '注意：讨论、提问或解释（如「画一个圆是什么原理」）不算。';
    if (ctx.prevImage) sys += '当前上下文里有一张可供修改的图片。';
    else sys += '当前上下文里没有可修改的图片，edit 一律为 false。';
  } else {
    sys += '本回合不支持生图，draw 与 edit 一律为 false。';
  }
  if (wantTitle) sys += 'title=根据这句话为本次对话起一个简短中文标题（不超过 14 字、不加引号、不用「对话/标题」等字眼）。';
  const user = '用户发言：' + text;
  const body = { model, providerId, stream: false, _purpose: 'judge', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
  try {
    const r = await api(ENDPOINT_BY_FORMAT[format] || ENDPOINT_BY_FORMAT.chat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    const raw = String(extractText(data, format) || '');
    const lower = raw.toLowerCase();
    const val = (k) => {
      const m = lower.match(new RegExp('"' + k + '"\\s*:\\s*(true|false)'));
      return m ? m[1] === 'true' : false;
    };
    let title = '';
    if (wantTitle) {
      const tm = raw.match(/"title"\s*:\s*"([^"]{1,40})"/);
      if (tm) title = tm[1].replace(/^["'「『]+|["'」』。.]+$/g, '').trim().slice(0, 24);
    }
    return { search: val('search'), draw: wantImage && val('draw'), edit: wantImage && val('edit'), title };
  } catch (e) {
    return null;
  }
}

async function sendMessage() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const input = $('input');
  let text = input.value.trim();
  const attachments = (state.pendingAttachments || []).slice();
  if (attachments.some((a) => a && a.parsing)) {
    toast('文档还在解析，请稍候', true);
    return;
  }
  if (!text && !attachments.length) return;

  if (!state.user) {
    openAuthModal();
    return;
  }
  // 群聊模式的模型来自每个角色各自的配置,不依赖全局的「当前模型」。
  // 群聊下拿它拦发送会误伤:角色还没分配模型时用户本该看到的是群聊那条提示。
  const inGroupMode = !!(window.OCGroup && window.OCGroup.isGroupMode());
  if (!inGroupMode && (!state.currentProviderId || !state.currentModel)) {
    // 已登录但没有可用供应商/模型(后台清空、加载失败等):明确提示,而不是把人往登录框赶
    toast('暂无可用的模型，请联系管理员或稍后重试', true);
    return;
  }
  if (!quotaIsUnlimited(state.user.quota) && state.user.quota <= 0) {
    // 游客额度用尽:引导登录;普通用户则提示充值
    if (state.isGuest) {
      state.isGuestExpired = true;
      showGuestBar();
      openAuthModal('游客体验次数已用完，注册或登录后可继续对话');
    } else {
      toast('剩余次数不足，请联系管理员', true);
    }
    return;
  }

  // @笔记:把被提及笔记的正文拼进本轮提问,让 AI 基于笔记回答。
  // 注入原文而不是「让 AI 自己去查」——单轮请求无法访问本地笔记。
  const noteCtx = noteMentionsContext(4000);
  let noteRefs = [];
  if (noteCtx) {
    // 回答末尾「参考笔记」来源行用:记录这轮真正注入的笔记(整文件夹已展开成具体笔记)
    noteRefs = noteCtx.notes.map((n) => ({ id: n.id, title: n.title || '无标题' }));
    text = (text || '请总结这些笔记的内容。') + '\n\n---\n'
      + noteCtx.instruction + '\n\n' + noteCtx.text;
  }

  // 群聊模式:交给群聊管线(多成员按对话模式顺序发言),不走单模型/生图/视频意图
  if (inGroupMode) {
    // 先让管线确认能开跑(回合进行中 / 没建群 / 没给角色分配模型都会被拒),再清空输入框。
    // 反过来的话,被拒的用户会既没发出消息又丢了刚打的字 —— 这条承诺由管线回传的
    // true/false 守住,所以「拒绝了」也必须在返回值里说出来,不能只是弹个提示。
    const accepted = await window.OCGroup.sendGroupTurn(text, attachments);
    if (!accepted) return;
    input.value = '';
    autosizeInput();
    state.pendingAttachments = [];
    renderAttachments();
    updateSendBtn();
    await refreshMe();
    refreshModelHealth();
    return;
  }

  // 多模型并答:用户先在入口勾好 2–3 个模型,这里把问题依次问它们,回答成为可切换的标签页。
  // 放在生图/视频分支之前:这是用户的显式选择,应优先于「画图意图」的自动识别。
  if (Array.isArray(state._compareModels) && state._compareModels.length >= 2) {
    input.value = '';
    autosizeInput();
    state.pendingAttachments = [];
    renderAttachments();
    updateSendBtn();
    await sendCompareTurn(text, attachments);
    await refreshMe();
    refreshModelHealth();
    return;
  }

  // 生图模型:纯文本=文生图,带图=图生图,都走生图接口。
  // 之前只处理「带图」的情况,纯文本会被当成普通对话发出去:后端虽然会自动改走生图接口,
  // 但返回的是 {images:[...]} 结构,对话渲染按 choices 取文本取不到,于是表现为「不出图」。
  if (modelIsImage(state.currentModel)) {
    const imageAtts = attachments.filter((a) => a && a.type === 'image' && a.dataUrl).slice(0, 4);
    if (!text && !imageAtts.length) {
      // 生图模型只认画面描述与图片:这轮两样都没有(例如只挂了一份文档)。
      // 下面会清空输入框,所以先拦一道,别让用户的附件和草稿凭空消失。
      toast('当前是生图模型，请输入画面描述或添加图片', true);
      return;
    }
    input.value = '';
    autosizeInput();
    state.pendingAttachments = [];
    renderAttachments();
    updateSendBtn();
    // 消息立刻进对话,生成进展写在 AI 回复那一格里
    await sendImageTurn(text, imageAtts, { phase: imageAtts.length ? '正在按参考图改图' : '正在生成图片' });
    return;
  }

  // 视频模型:纯文本=文生视频,带图=以图为参考生视频,都走视频接口(异步任务)。
  if (modelIsVideo(state.currentModel)) {
    const imageAtts = attachments.filter((a) => a && a.type === 'image' && a.dataUrl).slice(0, 5);
    if (!text && !imageAtts.length) {
      // 同上:先拦下空发,再谈清空输入框
      toast('当前是视频模型，请输入画面描述或添加图片', true);
      return;
    }
    input.value = '';
    autosizeInput();
    state.pendingAttachments = [];
    renderAttachments();
    updateSendBtn();
    await sendVideoTurn(text, imageAtts, { phase: '正在生成视频' });
    return;
  }

  // 对话模型下:识别到「画图 / 改图」意图时,自动改用「默认生图模型」出图,
  // 并自动带上上一张生成图或本次附件作参考图(改图)。识别方式由设置决定:
  // off=关闭 | rough=粗略关键词识别 | auto=统一 AI 工具判定(更准,但多一次调用)。
  // 「联网=智能」时也复用同一次判定,避免再用主模型多判一次、也更省 token。
  const aim = autoImageMode();
  // 判定阶段已发出去的那一轮(用户消息 + AI 占位):块外的发送收尾也要用,提升到外层作用域
  let posted = null;
  {
    const imgAtts = attachments.filter((a) => a && a.type === 'image' && a.dataUrl).slice(0, 4);
    let prevImg = '';
    if (typeof lastImageSourceInChat === 'function') {
      const c = currentChat();
      if (c) prevImg = lastImageSourceInChat(c) || '';
    }
    const hasRef = imgAtts.length > 0 || !!prevImg;
    const hasImageModel = typeof defaultImageModel === 'function' ? !!defaultImageModel() : false;
    const searchReady = typeof webSearchMode === 'function' && webSearchMode() === 'auto';
    // 新对话首条消息且开启了自动命名:让判定顺带给出标题,省去单独一次命名调用
    const curChat = currentChat();
    const isFirstMsg = !!curChat && (!curChat.messages || curChat.messages.length === 0) && autoTitleEnabled();
    // 需要 AI 工具判定的条件:总开关打开,且(生图设为智能判定 / 联网=智能 / 需要 AI 命名)。
    // 总开关关闭时完全不发起判定调用,上面三处各自回退(粗略识别 / 后端启发式 / 本地截取)。
    const judgeOn = aiJudgeEnabled();
    const needJudge = judgeOn && text && ((aim === 'auto' && hasImageModel) || searchReady || isFirstMsg);
    let verdict = null;
    if (needJudge) {
      // 判定期间锁住发送,避免重复触发。判定请求必须有超时:
      // 它不走流式、也没有停止按钮,上游一挂起 streaming 就会一直为真,
      // 再点发送只提示「正在生成中」。判定进展写在 AI 回复气泡里,消息即时进对话。
      posted = postUserTurn(text, attachments);
      setReplyPhase(posted.assistantMsg, judgePhaseText({ image: aim === 'auto' && hasImageModel, search: searchReady, title: isFirstMsg }));
      state.streaming = true; updateSendBtn();
      // 判定阶段也要给出「停止」:它最长可挂 12 秒,原来这里只把 streaming 置真,
      // 停止按钮不出现、发送按钮仍是可用态(点了只弹「正在生成中」),用户只能干等。
      // 判定用的 AbortController 挂到 state.abortController 上,停止按钮就能掐掉它;
      // 其余善后(令牌递增/按钮复位)走 stopStreaming 原有逻辑,finally 里再兜底复位一次。
      $('send-btn').classList.add('hidden');
      $('stop-btn').classList.remove('hidden');
      const judgeAc = new AbortController();
      state.abortController = judgeAc;
      const judgeTimer = setTimeout(() => judgeAc.abort(), 12000);
      // 判定期间用户可能切换会话(或点了停止)。判题用的是局部 AbortController,
      // 不在 state.abortController 上,stopStreaming 掐不到它;若不管,
      // 判定返回后会把答案/占位画进「已经切过去的那条会话」(索引错位),甚至重复投递用户消息。
      // 因此记住发起时的会话与轮次令牌,返回后先确认仍是同一会话、同一轮,否则整段放弃。
      const judgeChatId = posted.chat && posted.chat.id;
      const judgeTurnId = beginTurn();
      try {
        verdict = await aiJudgeTools(text, { imageEnabled: hasImageModel, searchEnabled: searchReady, prevImage: hasRef, wantTitle: isFirstMsg, signal: judgeAc.signal });
      } finally {
        clearTimeout(judgeTimer);
        state.abortController = null;
        state.streaming = false; updateSendBtn();
        // 恢复按钮:判定结束(正常/超时/被停止)都要回到「可发送」态。
        // stopStreaming 已经做过一次,这里兜底覆盖「自然结束」这条路径。
        $('stop-btn').classList.add('hidden');
        $('send-btn').classList.remove('hidden');
      }
      const stillHere = judgeChatId && state.currentChatId === judgeChatId;
      if (!stillHere || turnCancelled(judgeTurnId)) {
        // 已切走/已停止:丢弃这次判定结果,不再往下发真正的请求。
        return null;
      }
    }
    // 联网:判定成功则按结果显式开关;失败则回退后端启发式(body.webSearch 保持 'auto')
    state._toolSearch = (verdict && searchReady) ? !!verdict.search : null;
    // 判定给出的标题:首条消息刚发出去时,用判定结果刷新自动标题
    const judgeTitle = (verdict && verdict.title) ? String(verdict.title).trim() : '';
    if (posted && judgeTitle && posted.chat && posted.chat._autoTitled) {
      posted.chat.title = judgeTitle;
      renderChatList();
    }
    // 标题已消费:正常路径的 postUserTurn 复用 posted 时不会再读它
    state._judgeTitle = '';
    let isDraw = false, isEdit = false;
    if (aim !== 'off') {
      const feedback = wantsImageFeedback(text);
      if (aim === 'auto' && verdict) {
        isDraw = !!verdict.draw;
        // 判定模型漏看评价式反馈时兜底:有参考图且命中反馈模式,仍按改图处理
        isEdit = (!!verdict.edit || feedback) && hasRef;
      } else {
        // 粗略识别,或「智能判定」失败时回退
        isDraw = wantsDrawImage(text);
        // 改图意图:必须能定位到一张图。附图即视为要改这张图;否则需本会话有上一张生成图,
        // 且文本明确指代它(上面/这张图/它…)或是针对上一张图的评价式反馈(不够优雅/太暗了)。
        // 避免把「把这段话改成英文」这类文本编辑误判为改图。
        isEdit = (wantsEditImage(text) || feedback) && (imgAtts.length > 0 || (!!prevImg && (refersToPrevImage(text) || feedback)));
      }
    }
    // 参考图策略:显式编辑或明确指代上一张图时带上;全新绘图默认不带
    const usePrevRef = imgAtts.length === 0 && (isEdit || (isDraw && !!prevImg));
    if (isDraw || isEdit) {
      const target = defaultImageModel();
      if (target) {
        state._toolSearch = null; // 本次改走生图,联网判定结果不适用于后续对话
        input.value = '';
        autosizeInput();
        state.pendingAttachments = [];
        renderAttachments();
        updateSendBtn();
        // 记住用户原本的对话模型,出图后恢复,让用户继续留在对话模型里
        const prevProviderId = state.currentProviderId;
        const prevModel = state.currentModel;
        // 临时切到默认生图模型(仅本次出图,不改变用户的置顶/上次使用偏好)
        state.currentProviderId = target.providerId;
        await loadModels({ prefer: target.modelId });
        state.currentModel = target.modelId;
        renderProviderLabel();
        renderModelPicker();
        const withRef = imgAtts.length > 0 || usePrevRef;
        toast((isEdit ? '识别到改图意图，已用生图模型「' : '识别到绘图意图，已用生图模型「') + (target.label || target.modelId) + '」' + (withRef ? '并带上参考图' : ''));
        try {
          await sendImageTurn(text, imgAtts, { autoRef: usePrevRef, posted, phase: isEdit ? '判定为改图，正在生成' : '判定为生图，正在生成' });
        } finally {
          // 无论出图成功或失败,都恢复到用户原本的对话模型
          state.currentProviderId = prevProviderId;
          await loadModels({ prefer: prevModel });
          state.currentModel = prevModel;
          renderProviderLabel();
          renderModelPicker();
        }
        return;
      }
    }
  }

  // 消息立刻进对话(判定阶段已发过就复用),输入框随即清空;进展写在 AI 回复气泡里。
  const turn = postUserTurn(text, attachments, posted);
  // 回答末尾的「参考笔记」来源行跟着这一轮回答走(与提问气泡里的 @ 回显互补:
  // 气泡回显的是用户选了什么,@来源行列出真正喂给模型的笔记)
  if (noteRefs.length && turn && turn.assistantMsg) turn.assistantMsg.noteRefs = noteRefs;
  const searching = state._toolSearch === true || webSearchMode() === 'on';
  setReplyPhase(turn.assistantMsg, searching ? '正在联网检索' : '思考中');
  try {
    await requestAssistantReply(turn.chat, turn.userMsg);
  } finally {
    // 前置校验没过(无可用模型/额度不足等)时请求根本没开始:占位不能一直挂着「思考中」
    const am = turn.assistantMsg;
    if (am && am._streaming && !String(am.content || '').trim() && !am.error && !am.taskId && !state.streaming) {
      am._streaming = false;
      am.error = true;
      am.failNote = am.failNote || '未能开始生成，请检查模型与额度后重试';
      saveChats();
      renderMessages();
    }
  }
  await refreshMe();
  refreshModelHealth();
}

// (AI 会话标题已并入统一的「AI 工具判定」:新建对话首条消息时由 aiJudgeTools 顺带生成,省一次调用。)
function providerFormat() {
  const p = state.providers.find((x) => x.id === state.currentProviderId);
  return (p && p.apiFormat) || 'chat';
}

// 流式请求
async function streamRequest(format, body, chat, assistantMsg) {
  state.streaming = true;
  state._followStream = true;
  document.documentElement.classList.add('oc-streaming');
  assistantMsg._streaming = true;
  assistantMsg.interrupted = false;
  assistantMsg.createdAt = assistantMsg.createdAt || Date.now();
  assistantMsg._startTime = Date.now();
  $('send-btn').classList.add('hidden');
  $('stop-btn').classList.remove('hidden');
  const ac = new AbortController();
  state.abortController = ac;

  // 渲染占位（待 AI 回复）。文案保持这一步真正在做的事,不再轮播成「分析中 / 整理中」。
  renderMessages();

  try {
    const resp = await api(ENDPOINT_BY_FORMAT[format], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
      throw new Error(msg);
    }
    applyCitations(assistantMsg, resp);
    const taskId = resp.headers.get('X-Oc-Task-Id');
    if (taskId) { assistantMsg.taskId = taskId; assistantMsg.taskFormat = resp.headers.get('X-Oc-Task-Format') || format; assistantMsg.taskSeq = 0; assistantMsg.taskStatus = 'running'; saveChats(); }
    const ctype = resp.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      const text = await resp.text();
      const data = JSON.parse(text);
      assistantMsg.content = extractText(data, format);
      // @ 到生图模型时后端会改走生图接口,返回 {images:[...]} 而不是 choices。
      // 只按文本取会是空串,标签里就剩一个没有任何内容的空气泡:把图片渲染进这次回答。
      if (!assistantMsg.content && data && Array.isArray(data.images) && data.images.length) {
        assistantMsg.content = imageLinksFromResults(data.images, '生成图片');
      }
      const think = extractReasoning(data, format);
      if (think) assistantMsg.reasoning = think;
      absorbThinkTags(assistantMsg, true);
      if (data && data.usage) takeUsage(assistantMsg, data.usage);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      raw += piece;
      if (raw.length > 12000) raw = raw.slice(-12000);
      buffer += piece;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);
        handleSseChunk(chunk, format, assistantMsg);
        if (assistantMsg.taskId) assistantMsg.taskSeq += 1;
        scheduleStreamSave();
        updateStreamingText(assistantMsg);
      }
    }
    if (buffer.trim()) { handleSseChunk(buffer, format, assistantMsg); updateStreamingText(assistantMsg); }
    absorbThinkTags(assistantMsg, true);
    updateStreamingText(assistantMsg);
    if (streamEndedEarly(format, raw, assistantMsg)) {
      assistantMsg.interrupted = true;
      noteModelFailure(assistantMsg, '连接中断，已保留已写出的内容');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      assistantMsg.interrupted = true;
    } else {
      throw e;
    }
  } finally {
    cancelStreamPaint();
    assistantMsg._streaming = false;
    if (assistantMsg.taskId) assistantMsg.taskStatus = assistantMsg.interrupted ? 'interrupted' : (assistantMsg.error ? 'failed' : 'completed');
    finalizeReplyTiming(assistantMsg);
    // 完成后仅重绘最后一条 AI 消息（走 Markdown/公式/code 管线），避免全量重绘跳动
    reRenderLastAssistant(assistantMsg);
    initStreamingState();
    // 异步生成 AI 跟进建议（受偏好开关控制,不阻塞主回复;群聊成员发言不生成,避免逐条额外计费与重绘）
    if (followUpsEnabled() && !assistantMsg.participant && assistantMsg.content && !assistantMsg.error) {
      aiFollowUps(assistantMsg.content).then((ups) => {
        if (ups && ups.length && assistantMsg.followUps !== ups) {
          assistantMsg.followUps = ups;
          saveChats();
          reRenderLastAssistant(assistantMsg);
        }
      });
    }
  }
}

// 引用已快照进这条用户消息:清空输入区的待发 chip(所有发送路径共用,避免漏清)
function clearNoteMentionsAfterSend() {
  if (!(state.noteMentions || []).length && !(state.noteFolderMentions || []).length) return;
  state.noteMentions = [];
  state.noteFolderMentions = [];
  renderNoteMentions();
}

// 记录这条提问选中的 @助手 / @整文件夹 / @笔记(发送那一刻的快照)。
// 用户气泡据此回显「@助手 @文件夹 @笔记 问题正文」,与输入框里的连排观感一致;
// 引用被移除后重发也不再改历史消息,历史消息忠实于当时发出去的样子。
function mentionsSnapshot(chat) {
  const mentions = [];
  const c = chat || currentChat();
  const name = c && c.assistantName ? String(c.assistantName).trim() : '';
  if (name) mentions.push({ kind: 'assistant', name: name });
  (state.noteFolderMentions || []).forEach((f) => {
    mentions.push({ kind: 'folder', id: f.id, name: f.name || '文件夹' });
  });
  (state.noteMentions || []).forEach((n) => {
    mentions.push({ kind: 'note', id: n.id, name: n.title || '无标题笔记' });
  });
  return mentions;
}

// 用户消息气泡里的 @ 回显:与输入框同一套 chip(助手蓝、笔记/文件夹红),可点开笔记
function appendMsgMentions(root, mentions) {
  if (!Array.isArray(mentions) || !mentions.length) return;
  const row = document.createElement('span');
  row.className = 'msg-mentions';
  mentions.forEach((m) => {
    const chip = document.createElement('span');
    chip.className = 'note-mention-chip' + (m.kind === 'assistant' ? ' note-mention-assistant' : '')
      + (m.kind === 'folder' ? ' note-mention-folder' : '');
    chip.innerHTML = '<b>@</b>' + escapeHtml(m.name || '') + (m.kind === 'folder' ? ' 文件夹' : '');
    if (m.kind === 'assistant') {
      chip.title = '这条提问使用的助手';
    } else {
      chip.title = m.kind === 'folder'
        ? '这轮提问引用了整个文件夹「' + (m.name || '') + '」的笔记，点击打开 AI 笔记'
        : '这轮提问引用了这篇笔记，点击打开 AI 笔记';
      chip.setAttribute('role', 'button');
      chip.tabIndex = 0;
      chip.addEventListener('click', () => { if (window.OCNotes) window.OCNotes.open(); });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (window.OCNotes) window.OCNotes.open(); }
      });
    }
    row.appendChild(chip);
  });
  // 与正文连读为「@助手 @文件夹 @笔记 问题正文」:插到首个块级元素的开头,
  // 而不是另起一行(气泡里第一行放不下时自然折行,后续行回到最左)。
  const first = root.firstElementChild;
  if (first && /^(P|DIV|LI|BLOCKQUOTE|H[1-6])$/.test(first.tagName)) first.insertBefore(row, first.firstChild);
  else root.insertBefore(row, root.firstChild);
}

// 回答末尾的「参考笔记」来源行:列出这轮回答真正喂给模型的笔记,点击打开 AI 笔记。
// 必须挂在 .msg-content 之内:一来与正文同宽(挂到 .msg 上会变成 flex 兄弟节点,
// 把正文挤窄),二来随 contentEl 一起重建,精准重绘不会像从前那样每次多叠一份。
function appendNoteRefs(contentEl, msg) {
  if (!contentEl || !msg || !Array.isArray(msg.noteRefs) || !msg.noteRefs.length) return;
  const refs = document.createElement('div');
  refs.className = 'note-ref-row';
  refs.innerHTML = msg.noteRefs.map((r) => '<span class="note-mention-chip" role="button" tabindex="0"'
    + ' title="这轮回答引用了这篇笔记，点击打开 AI 笔记"><b>@</b>'
    + escapeHtml(r.title || '无标题笔记') + '</span>').join('');
  const openNotes = () => { if (window.OCNotes) window.OCNotes.open(); };
  refs.querySelectorAll('.note-mention-chip').forEach((chip) => {
    chip.addEventListener('click', openNotes);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNotes(); }
    });
  });
  contentEl.appendChild(refs);
}

// 精准重绘最后一条 assistant 消息（流式结束后调用）
function reRenderLastAssistant(assistantMsg) {
  const chat = currentChat();
  if (!chat) return;
  const idx = (chat.messages || []).indexOf(assistantMsg);
  if (idx < 0) return;
  const last = document.querySelector('#messages .msg.assistant[data-idx="' + idx + '"]');
  if (!last) return;
  const _av = last.querySelector('.msg-avatar');
  if (_av) {
    _av.innerHTML = assistantMsg.participant
      ? participantAvatarHtml(assistantMsg.participant)
      : aiAvatarHtml(assistantMsg.model || state.currentModel || '');
  }
  const contentEl = last.querySelector('.msg-content');
  if (!contentEl) return;
  contentEl.innerHTML = '';
  // 标签条在思考链之上:先挂标签,思考面板插到标签后面
  if (Array.isArray(assistantMsg.versions) && assistantMsg.versions.length > 1) {
    contentEl.appendChild(buildReplyTabs(assistantMsg, chat));
  }
  if (assistantMsg.participant) contentEl.appendChild(buildParticipantTag(assistantMsg));
  upsertReasoningPanel(contentEl, assistantMsg, false);
  const root = document.createElement('div');
  contentEl.appendChild(root);
  window.OCRenderer.renderInto(root, assistantMsg.content || '');
  highlightGroupMentions(root, chat);
  if (window.OCMultimodal && window.OCMultimodal.enhanceArtifactButtons) {
    window.OCMultimodal.enhanceArtifactButtons(root);
  }
  if (window.OCCitations && assistantMsg.citations && assistantMsg.citations.length) {
    window.OCCitations.enhanceCitations(root, assistantMsg.citations);
  }
  // 末尾「参考笔记」来源行重挂:contentEl 刚被清空重建,这里补回唯一一份
  appendNoteRefs(contentEl, assistantMsg);
  // 重新挂载操作栏 + 快捷指令 + 跟进建议
  last.querySelectorAll('.msg-actions, .quick-actions, .follow-ups, .cite-sources').forEach((el) => el.remove());
  if (assistantMsg.content || assistantMsg.reasoning || replyWasInterrupted(assistantMsg)) {
  window.OCMessages.attachActions(last, assistantMsg, {
    onRegenerate: (mm) => regenerateMessage(mm, chat),
    onAt: (mm, btn) => openAtAnswerModal(mm, chat, btn),
    onShare: (mm) => shareMessage(mm),
    onSaveNote: (mm) => saveMessageToNotes(mm, chat),
    onVote: submitMessageVote,
    onQuickAction: quickAction,
    onBranch: (mm) => branchFromMessage(mm, chat),
  });
    if (assistantMsg.followUps && assistantMsg.followUps.length) {
      window.OCMultimodal.renderFollowUps(last, assistantMsg.followUps, applyFollowUp);
    }
    if (assistantMsg.citations && assistantMsg.citations.length && window.OCCitations) {
      window.OCCitations.renderSources(last, assistantMsg.citations);
    }
    // 耗时显示(先清旧再渲染,避免重复叠加)
    if (typeof renderElapsed === 'function') renderElapsed(last, assistantMsg);
  }
  saveChats();
  scrollToBottom();
}

// 流式文本即时更新：已闭合的 Markdown / HTML / 图表马上呈现
let streamPaintAt = 0;
let streamPaintTimer = null;
function cancelStreamPaint() {
  if (streamPaintTimer) {
    clearTimeout(streamPaintTimer);
    streamPaintTimer = null;
  }
}

function paintStreamingText(assistantMsg) {
  if (!assistantMsg || !assistantMsg._streaming) return;
  // @ 重答旧消息时定位到目标节点;常规流式取最后一条
  let last = null;
  if (typeof state._streamFocusIdx === 'number') {
    last = document.querySelector('#messages .msg.assistant[data-idx="' + state._streamFocusIdx + '"]');
  }
  if (!last) {
    const msgs = document.querySelectorAll('#messages .msg.assistant:not(.msg-errored)');
    last = msgs[msgs.length - 1];
  }
  if (!last) return;
  const contentEl = last.querySelector('.msg-content');
  if (!contentEl) return;
  upsertReasoningPanel(contentEl, assistantMsg, true);
  const phase = contentEl.querySelector('.phase-indicator');
  if ((assistantMsg.reasoning || assistantMsg.content) && phase) phase.remove();
  let root = contentEl.querySelector(':scope > .stream-answer');
  if (!assistantMsg.content) {
    if (root) root.remove();
    if (state._followStream !== false) scrollToBottom();
    return;
  }
  if (!root) {
    root = document.createElement('div');
    root.className = 'stream-answer';
    contentEl.appendChild(root);
  }
  if (window.OCRenderer && window.OCRenderer.renderStreamingInto) {
    window.OCRenderer.renderStreamingInto(root, assistantMsg.content || '');
    highlightGroupMentions(root, currentChat());
  } else {
    root.classList.add('stream-inline');
    root.innerHTML = escapeHtml(assistantMsg.content || '') + '<span class="stream-cursor"></span>';
  }
  // 用户向上翻阅时暂停吸底,拉回底部附近即恢复跟随
  if (state._followStream !== false) scrollToBottom();
}
function updateStreamingText(assistantMsg) {
  if (!assistantMsg || !assistantMsg._streaming) return;
  const now = Date.now();
  if (now - streamPaintAt < 80) {
    if (streamPaintTimer) clearTimeout(streamPaintTimer);
    streamPaintTimer = setTimeout(() => {
      streamPaintTimer = null;
      streamPaintAt = Date.now();
      paintStreamingText(assistantMsg);
    }, 80);
    return;
  }
  if (streamPaintTimer) { clearTimeout(streamPaintTimer); streamPaintTimer = null; }
  streamPaintAt = now;
  paintStreamingText(assistantMsg);
}

function appendReasoning(assistantMsg, text) {
  if (!text) return;
  assistantMsg.reasoning = String(assistantMsg.reasoning || '') + text;
}

const THINK_OPEN = /<\s*(?:think|redacted_thinking)\s*>/i;
const THINK_CLOSE = /<\/\s*(?:think|redacted_thinking)\s*>/i;

function absorbThinkTags(assistantMsg, finished) {
  if (!assistantMsg) return;
  const raw = String(assistantMsg.content || '');
  const cursor = Math.min(assistantMsg._thinkCursor || 0, raw.length);
  let pending = String(assistantMsg._thinkHold || '') + raw.slice(cursor);
  assistantMsg._thinkHold = '';
  let visible = raw.slice(0, cursor);
  let guard = 0;
  while (pending && guard++ < 20) {
    if (assistantMsg._inThink) {
      const end = pending.search(THINK_CLOSE);
      if (end < 0) {
        const tail = finished ? 0 : incompleteTagTail(pending, false);
        appendReasoning(assistantMsg, pending.slice(0, pending.length - tail));
        assistantMsg._thinkHold = pending.slice(pending.length - tail);
        pending = '';
        break;
      }
      appendReasoning(assistantMsg, pending.slice(0, end));
      pending = pending.slice(end).replace(THINK_CLOSE, '');
      assistantMsg._inThink = false;
      continue;
    }
    const start = pending.search(THINK_OPEN);
    if (start < 0) {
      const tail = finished ? 0 : incompleteTagTail(pending, true);
      assistantMsg._thinkHold = pending.slice(pending.length - tail);
      visible += pending.slice(0, pending.length - tail);
      pending = '';
      break;
    }
    const open = pending.slice(start).match(THINK_OPEN);
    if (!open) break;
    visible += pending.slice(0, start);
    pending = pending.slice(start + open[0].length);
    assistantMsg._inThink = true;
  }
  assistantMsg.content = visible;
  assistantMsg._thinkCursor = visible.length;
  if (finished) {
    delete assistantMsg._thinkHold;
    delete assistantMsg._thinkCursor;
    delete assistantMsg._inThink;
  }
}

function incompleteTagTail(text, opening) {
  const src = String(text || '');
  const max = opening ? 8 : 22;
  for (let n = Math.min(max, src.length); n > 0; n--) {
    const tail = src.slice(src.length - n);
    if ((opening ? '<think' : '</think').startsWith(tail.toLowerCase()) || (opening ? '<redacted_thinking' : '</redacted_thinking').startsWith(tail.toLowerCase())) {
      return n;
    }
  }
  return 0;
}

function handleSseChunk(chunk, format, assistantMsg) {
  chunk.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let j;
    try { j = JSON.parse(payload); } catch (e) { return; }
    const think = getReasoningDelta(j, format);
    if (think) appendReasoning(assistantMsg, think);
    captureStreamUsage(j, format, assistantMsg);
    const delta = getDelta(j, format);
    if (delta) assistantMsg.content += delta;
  });
  absorbThinkTags(assistantMsg);
}

function captureStreamUsage(j, format, assistantMsg) {
  if (!j || !assistantMsg) return;
  if (j.usage) takeUsage(assistantMsg, j.usage);
  if (j.message && j.message.usage) takeUsage(assistantMsg, j.message.usage);
  if (j.type === 'message_delta' && j.usage) takeUsage(assistantMsg, j.usage);
  if (j.type === 'message_start' && j.message && j.message.usage) takeUsage(assistantMsg, j.message.usage);
  if (j.response && j.response.usage) takeUsage(assistantMsg, j.response.usage);
  if (format === 'responses' && j.usage) takeUsage(assistantMsg, j.usage);
}
function getReasoningDelta(j, format) {
  if (!j) return '';
  if (format === 'anthropic') {
    if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'thinking_delta') return j.delta.thinking || '';
      if (typeof j.delta.thinking === 'string') return j.delta.thinking;
    }
    return '';
  }
  if (format === 'responses' || (j.type && String(j.type).indexOf('reasoning') >= 0)) {
    if (j.type === 'response.reasoning_text.delta') return j.delta || '';
    if (j.type === 'response.reasoning_summary_text.delta') return j.delta || '';
    if (j.type === 'response.reasoning.delta') {
      if (typeof j.delta === 'string') return j.delta;
      if (j.delta && typeof j.delta.text === 'string') return j.delta.text;
    }
    if (typeof j.reasoning === 'string') return j.reasoning;
  }
  if (j.choices && j.choices[0]) {
    const c = j.choices[0];
    const d = c.delta || c.message || {};
    if (typeof d.reasoning_content === 'string') return d.reasoning_content;
    if (typeof d.reasoning === 'string') return d.reasoning;
    if (d.reasoning && typeof d.reasoning === 'object') return d.reasoning.content || d.reasoning.text || '';
    if (typeof c.reasoning_content === 'string') return c.reasoning_content;
    const fromParts = partsText(d.content, true);
    if (fromParts) return fromParts;
  }
  return '';
}
function getDelta(j, format) {
  if (format === 'anthropic') {
    if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') return j.delta.text;
    return '';
  }
  if (format === 'responses' || (j.type === 'response.output_text.delta')) {
    if (j.type === 'response.output_text.delta') return j.delta || '';
    if (j.type && String(j.type).includes('output_text')) return j.delta || '';
    return '';
  }
  // chat / completions
  if (j.choices && j.choices[0]) {
    const c = j.choices[0];
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    if (c.delta && Array.isArray(c.delta.content)) return partsText(c.delta.content, false);
    if (c.delta && typeof c.delta.text === 'string') return c.delta.text;
    if (typeof c.text === 'string') return c.text;
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (c.message && Array.isArray(c.message.content)) return partsText(c.message.content, false);
  }
  return '';
}

function extractText(data, format) {
  if (!data) return '';
  if (format === 'anthropic') {
    if (Array.isArray(data.content)) return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return data.content || '';
  }
  if (format === 'responses') {
    if (data.output_text) return data.output_text;
    if (Array.isArray(data.output)) return data.output.map((o) => (o && o.content && Array.isArray(o.content) ? o.content.map((c) => c.text || '').join('') : '')).join('');
    return '';
  }
  if (data.choices && data.choices[0]) {
    const c = data.choices[0];
    if (c.message && Array.isArray(c.message.content)) return partsText(c.message.content, false);
    if (c.message && c.message.content) return c.message.content;
    if (c.text) return c.text;
  }
  return data.text || '';
}
function extractReasoning(data, format) {
  if (!data) return '';
  if (format === 'anthropic' && Array.isArray(data.content)) {
    return data.content.filter((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))
      .map((b) => b.thinking || b.text || '').join('');
  }
  if (format === 'responses' && Array.isArray(data.output)) {
    return data.output.filter((o) => o && o.type === 'reasoning').map((o) => {
      if (typeof o.summary === 'string') return o.summary;
      if (Array.isArray(o.summary)) return o.summary.map((s) => s.text || '').join('\n');
      if (Array.isArray(o.content)) return o.content.map((c) => c.text || '').join('');
      return o.text || '';
    }).join('\n');
  }
  if (data.choices && data.choices[0]) {
    const c = data.choices[0];
    const m = c.message || {};
    if (typeof m.reasoning_content === 'string') return m.reasoning_content;
    if (typeof m.reasoning === 'string') return m.reasoning;
    if (m.reasoning && typeof m.reasoning === 'object') return m.reasoning.content || m.reasoning.text || '';
    if (typeof c.reasoning_content === 'string') return c.reasoning_content;
    return partsText(m.content, true) || '';
  }
  return '';
}

function buildMsgNodeUpdate(chat, assistantMsg, errorText) {
  // 已由新渲染管线处理，保留占位兼容
}

// ============ 消息操作 ============
// 重新生成：截断到该条消息，重新请求
function continueMessages(chat, msg) {
  const idx = chat.messages.indexOf(msg);
  const prior = idx >= 0 ? chat.messages.slice(0, idx) : chat.messages.filter((m) => m !== msg);
  const draft = stripInterruptMarks(msg.content);
  const thought = String(msg.reasoning || '').trim();
  const note = [];
  if (thought) note.push('你上次的思考进行到这里，请接着想完并给出回答，不要重复已写过的部分：\n' + thought.slice(-4000));
  if (draft) note.push('你上次的回答写到这里，请从断点接着写完，不要重复：\n' + draft.slice(-4000));
  if (!note.length) return prior;
  return prior.concat([{ role: 'assistant', content: note.join('\n\n') }]);
}

function noteModelFailure(msg, reason) {
  if (!msg) return;
  const model = String(msg.model || state.currentModel || '').trim() || '当前模型';
  const why = String(reason || '请求失败').replace(/^请求失败:\s*/, '').trim();
  msg.failNote = model + '：' + why;
}

async function continueInterrupted(msg, chat) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!msg || !chat) return;
  const live = liveMessage(chat, msg);
  if (!live) { toast('找不到这条回答', true); return; }
  chat = live.chat; msg = live.msg;
  // 通道级故障由请求失败路径统一提示(noteModelFailure),不再对特定模型名一刀切拒绝
  msg.content = stripInterruptMarks(msg.content);
  msg.interrupted = false;
  msg.error = false;
  msg.failNote = '';
  msg._continuing = true;
  saveChats();
  renderMessages();
  const lastUser = [...chat.messages.slice(0, chat.messages.indexOf(msg))].reverse().find((m) => m.role === 'user');
  await requestAssistantReply(chat, lastUser || { role: 'user', content: '' }, { continueFrom: msg });
}

async function regenerateMessage(msg, chat) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const live = liveMessage(chat, msg);
  if (!live) { toast('找不到这条回答', true); return; }
  chat = live.chat; msg = live.msg;
  const idx = live.idx;
  chat.messages = chat.messages.slice(0, idx + 1);
  persistCurrentReplyVersion(msg);
  pushReplyVersion(msg);
  msg.content = '';
  msg.reasoning = '';
  msg.followUps = [];
  msg.citations = [];
  msg.vote = null;
  msg.error = false;
  msg.interrupted = false;
  msg.failNote = '';
  msg.elapsedMs = null;
  msg._startTime = Date.now();
  msg.createdAt = Date.now();
  // 重答会截断消息列表:时间戳必须跟着更新,否则旧的云端副本(含更长的历史)会赢下合并
  chat.updatedAt = Date.now();
  saveChats();
  renderMessages();
  const lastUser = [...chat.messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    await requestAssistantReply(chat, lastUser);
  } else {
    toast('没有可重新生成的用户消息', true);
  }
}

// 编辑用户消息并重新生成
function editAndResend(msg, chat, msgEl) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!chat || !msg) return;
  let idx = msgEl && msgEl.dataset.idx !== undefined ? Number(msgEl.dataset.idx) : -1;
  if (!(idx >= 0) || chat.messages[idx] !== msg) {
    idx = chat.messages.indexOf(msg);
  }
  if (idx < 0) {
    idx = chat.messages.findIndex((m) =>
      m && m.role === 'user' && m.content === msg.content &&
      (!msg.createdAt || m.createdAt === msg.createdAt)
    );
  }
  if (idx < 0) return toast('找不到这条消息', true);
  const target = msgEl || document.querySelector('#messages .msg.user[data-idx="' + idx + '"]');
  if (!target || !window.OCMessages) return;
  // 编辑期间挂起云同步拉取:轮询合并会整段替换 state.chats 并重绘消息列表,
  // 正在输入的编辑框会被连带销毁(表现为刚点编辑就自己弹回)。
  state._editingMsg = msg;
  window.OCMessages.enterEditMode(target, msg, {
    onSaveEdit: async (newText) => {
      state._editingMsg = null;
      const next = String(newText || '').trim();
      if (!next) return toast('消息不能为空', true);
      // 编辑期间列表可能被合并替换过:保存时取回活对象,新回答才会写进画面上的那条消息
      const live = liveMessage(chat, msg);
      if (!live) { toast('该消息已不在当前对话中', true); return; }
      chat = live.chat; msg = live.msg;
      const at = live.idx;
      msg.content = next;
      if (msg.text !== undefined) msg.text = next;
      chat.messages = chat.messages.slice(0, at + 1);
      chat.messages.push({ role: 'assistant', content: '' });
      chat.updatedAt = Date.now();
      saveChats();
      renderMessages();
      await requestAssistantReply(chat, msg);
    },
    onExitEdit: () => { state._editingMsg = null; renderMessages(); },
  });
}

// 请求一条 AI 回复（通用入口）
async function requestAssistantReply(chat, userMsg, extra) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!state.currentProviderId || !state.currentModel) {
    toast('请先选择供应商和模型', true);
    return;
  }
  if (!state.user || (!quotaIsUnlimited(state.user.quota) && state.user.quota <= 0)) {
    const spent = usageTodayText();
    toast('剩余次数不足' + (spent ? '。' + spent : '') + '，请联系管理员', true);
    return;
  }
  // @ 重答等场景:目标消息与历史截断点由 extra 指定;常规发送沿用「尾部占位」逻辑
  const upToIdx = (extra && Number.isInteger(extra.upToIdx))
    ? Math.max(1, Math.min(extra.upToIdx, chat.messages.length))
    : chat.messages.length;
  let assistantMsg = (extra && extra.target) || null;
  if (!assistantMsg) {
    assistantMsg = upToIdx > 0 ? chat.messages[upToIdx - 1] : null;
    if (!assistantMsg || assistantMsg.role !== 'assistant') {
      assistantMsg = { role: 'assistant', content: '' };
      chat.messages.splice(upToIdx, 0, assistantMsg);
    }
  }
  // 流式定位:重答的是旧消息时,流式渲染要落在该消息节点而不是列表末尾
  state._streamFocusIdx = chat.messages.indexOf(assistantMsg);
  // 记录本次回答所用的模型/供应商:消息头像按此匹配厂商 logo
  assistantMsg.model = state.currentModel;
  assistantMsg.providerId = state.currentProviderId;
  saveChats();
  const format = providerFormat();
  state.streamToggle = streamEnabled();
  assistantMsg._startTime = Date.now();
  const continuing = !!(extra && extra.continueFrom === assistantMsg);
  const source = continuing
    ? continueMessages(chat, assistantMsg)
    : chat.messages.slice(0, upToIdx).filter((m) => {
      if (!m || m.error || m.content === undefined) return false;
      if (m === assistantMsg && !String(m.content || '').trim()) return false;
      return true;
    });
  const body = buildRequestBody(source, format, chat, continuing ? { continueFrom: assistantMsg } : null);
  // 调用方自定义计费用途(如多模型对比记为 «多模型对比»);不传则沿用默认的对话计费
  if (extra && extra._purpose) body._purpose = extra._purpose;
  assistantMsg.contextCount = body._contextCount || 0;
  assistantMsg.contextLimit = body._contextLimit || assistantMsg.contextCount;
  delete body._contextCount;
  delete body._contextLimit;
  try {
    if (state.streamToggle) {
      await streamRequest(format, body, chat, assistantMsg);
    } else {
      assistantMsg._streaming = true;
      // 非流式同样要可停止、防重复发送:与流式共用发送/停止按钮与 abort 通道
      state.streaming = true;
      state._followStream = true;
      document.documentElement.classList.add('oc-streaming');
      $('send-btn').classList.add('hidden');
      $('stop-btn').classList.remove('hidden');
      state.abortController = new AbortController();
      renderMessages();
      const r = await api(ENDPOINT_BY_FORMAT[format], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: state.abortController.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
      applyCitations(assistantMsg, r);
      assistantMsg.content = extractText(data, format);
      const think = extractReasoning(data, format);
      if (think) assistantMsg.reasoning = think;
      absorbThinkTags(assistantMsg, true);
      if (data && data.usage) takeUsage(assistantMsg, data.usage);
      if (!assistantMsg.participant) assistantMsg.followUps = await aiFollowUps(assistantMsg.content);
      refreshMe();
    }
  } catch (e) {
    const aborted = !!(e && e.name === 'AbortError');
    const kept = stripInterruptMarks(assistantMsg.content);
    assistantMsg.content = kept;
    assistantMsg.interrupted = true;
    if (!aborted) {
      assistantMsg.error = true;
      noteModelFailure(assistantMsg, (e && e.message) || '请求失败');
      if (!kept && !assistantMsg.reasoning) assistantMsg.content = assistantMsg.failNote + '（本次请求未扣费）';
    }
  } finally {
    cancelStreamPaint();
    assistantMsg._streaming = false;
    if (assistantMsg.taskId) assistantMsg.taskStatus = assistantMsg.interrupted ? 'interrupted' : (assistantMsg.error ? 'failed' : 'completed');
    finalizeReplyTiming(assistantMsg);
    if (assistantMsg.error) {
      persistCurrentReplyVersion(assistantMsg);
      renderMessages();
    } else {
      persistCurrentReplyVersion(assistantMsg);
      reRenderLastAssistant(assistantMsg);
    }
    saveChats();
    initStreamingState();
    state._streamFocusIdx = null;
  }
  await refreshMe();
  refreshModelHealth();
}

function availableModels() {
  const out = [];
  (state.providers || []).forEach((p) => {
    const models = Array.isArray(p.models) ? p.models : [];
    models.forEach((m) => {
      const id = typeof m === 'string' ? m : (m && (m.id || m.name));
      if (!id) return;
      out.push({ providerId: p.id, provider: p.name || '供应商', model: String(id) });
    });
  });
  return out;
}

function shareableMessages(chat) {
  return ((chat && chat.messages) || []).filter((m) => m && m.role !== 'system' && !m.error && String(m.content || '').trim()).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content || ''),
  }));
}

function showShareLinkModal(url) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML =
    '<div class="modal modal-sm" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>分享对话</h3>'
    + '<button class="icon-btn" data-act="close" aria-label="关闭">' + (window.OC ? window.OC.icon('close', 16) : '×') + '</button></div>'
    + '<div class="modal-body">'
    + '<p class="confirm-message">已生成公开链接，任何人打开即可查看这份对话快照。</p>'
    + '<div class="share-link-row">'
    + '<input id="share-link-input" type="text" readonly value="' + escapeHtml(url) + '">'
    + '<button class="btn primary" data-act="copy">复制</button>'
    + '</div>'
    + '<p class="share-link-hint">链接指向生成时的内容，之后修改对话不会同步。</p>'
    + '</div></div>';
  document.body.appendChild(mask);
  const input = mask.querySelector('#share-link-input');
  const close = () => {
    if (window.OCUI) window.OCUI.closeModal(mask);
    else mask.remove();
    setTimeout(() => mask.remove(), 360);
  };
  const copyLink = async () => {
    const ok = window.OCUI ? await window.OCUI.copyText(url) : false;
    if (ok) toast('链接已复制');
    else if (input) { input.focus(); input.select(); toast('请手动复制链接'); }
  };
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-act="close"]')) return close();
    if (e.target.closest('[data-act="copy"]')) copyLink();
  });
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(mask);
  else mask.classList.add('show');
  if (input) { input.focus(); input.select(); }
  copyLink();
}

async function shareConversation(chat) {
  const target = chat || currentChat();
  const messages = shareableMessages(target);
  if (!messages.length) return toast('当前对话为空，无法分享', true);
  try {
    const r = await api('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: (target && target.title) || '未命名对话', messages }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.error && data.error.message) || '分享失败');
    const path = data.url || (data.share && data.share.id ? '/s/' + data.share.id : '');
    if (!path) throw new Error('未返回分享链接');
    showShareLinkModal(location.origin + path);
  } catch (e) {
    toast(e.message || '分享失败', true);
  }
}

function shareMessage() {
  shareConversation(currentChat());
}

// 保存到 AI 笔记:交给 notes.js 让 AI 整理归档(引用换回活对象,防止云同步替换后写丢)
function saveMessageToNotes(msg, chat) {
  const live = liveChat(chat) || chat;
  const lm = live ? (liveMessage(live, msg) || { msg }).msg : msg;
  if (!lm || !(lm.content || '').trim()) {
    toast('这条回复还没有内容，无法保存到笔记', true);
    return;
  }
  if (!window.OCNotes || !window.OCApp) {
    toast('笔记模块尚未加载，请刷新页面后重试', true);
    return;
  }
  window.OCNotes.archiveFromMessage(live, lm);
}

// 快捷指令
function submitMessageVote(msg) {
  persistCurrentReplyVersion(msg);
  saveChats();
  const model = String((msg && msg.model) || state.currentModel || '').trim();
  if (!model) {
    toast('这条回复没有模型记录，无法计入统计', true);
    return;
  }
  const from = msg._voteSent || null;
  const to = msg.vote || null;
  if (from === to) return;
  msg._voteSent = to;
  api('/api/votes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, from, to }),
  }).then(async (r) => {
    if (r.ok) return;
    msg.vote = from;
    msg._voteSent = from;
    persistCurrentReplyVersion(msg);
    saveChats();
    renderMessages();
    toast('评价没有保存', true);
  }).catch(() => {
    msg.vote = from;
    msg._voteSent = from;
    persistCurrentReplyVersion(msg);
    saveChats();
    renderMessages();
    toast('评价没有保存', true);
  });
}

function quickAction(action) {
  const templates = {
    continue: '请继续刚才的内容，接着上次的结尾继续生成。',
    summarize: '请用 3-5 句话简要总结以上内容。',
    expand: '请对以上内容进行详细扩展说明，补充背景和细节。',
    extract: '请从以上内容中提取要点，用列表形式列出。',
  };
  const prompt = templates[action] || templates.summarize;
  const input = $('input');
  input.value = prompt;
  autosizeInput();
  // 程序化填入不会触发 input 事件,手动刷新发送按钮状态
  updateSendBtn();
  input.focus();
}

// 跟进建议（简单启发式：根据回复内容生成 3-4 个问题）
function suggestFollowUps(content) {
  if (!content) return [];
  const text = content.trim();
  if (text.length < 20) return [];
  const list = [];
  if (text.includes('总结')) list.push('请把上面的内容整理成表格');
  if (/代码|function|def |class |const /.test(text)) list.push('请解释一下上面代码的关键逻辑');
  if (/\d+%|提升|增长|对比|差距/.test(text)) list.push('这个结论的数据依据是什么？');
  if (text.length > 200) list.push('能否给出一个更简洁的版本？');
  list.push('有哪些可能的问题或局限需要注意？');
  return list.slice(0, 4);
}

// 用 AI 生成跟进建议（失败时降级为启发式）
async function aiFollowUps(content) {
  // 可在设置 → 对话里指定「跟进建议模型」;未指定(或指定模型已不可用)时跟随当前对话模型
  const aux = resolveAuxModel('followupsModel');
  const providerId = aux ? aux.providerId : state.currentProviderId;
  const model = aux ? aux.model : state.currentModel;
  const format = aux ? aux.format : providerFormat();
  if (!content || !providerId || !model) return suggestFollowUps(content);
  try {
    const body = {
      model,
      stream: false,
      providerId,
      _purpose: 'followup',
      messages: [
        { role: 'system', content: '你是对话助手。根据用户与 AI 的最后一条回复，生成 3 个简短、自然的追问建议。只输出 3 个短句，每行一个，不要编号，不要引号。' },
        { role: 'user', content: '最后回复内容：\n' + content.slice(0, 3000) },
      ],
    };
    const r = await api(ENDPOINT_BY_FORMAT[format] || ENDPOINT_BY_FORMAT.chat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return suggestFollowUps(content);
    const data = await r.json();
    const text = extractText(data, format) || '';
    const lines = text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter((l) => l && l.length < 50);
    return lines.slice(0, 3).length >= 1 ? lines.slice(0, 3) : suggestFollowUps(content);
  } catch (e) {
    return suggestFollowUps(content);
  }
}

function stopStreaming() {
  cancelStreamPaint();
  const chat = currentChat();
  const pending = chat && [...(chat.messages || [])].reverse().find((m) => m && m.role === 'assistant' && m.taskId && m.taskStatus === 'running');
  if (pending) { pending.taskStatus = 'cancelled'; api('/api/proxy/tasks/' + encodeURIComponent(pending.taskId) + '/cancel', { method: 'POST' }).catch(() => {}); }
  if (state.abortController) state.abortController.abort();
  state.abortController = null;
  // 作废当前这一轮:多模型对比与群聊是「串行问多个模型」的循环,
  // 只 abort 当前请求 + 清 streaming 标志的话,循环下一轮会照常开跑
  // (requestAssistantReply 的守卫看到 streaming=false 就继续),用户点了停止仍被继续计费。
  // 递增令牌让循环在每轮开头自查并整体退出。
  state.turnToken = (state.turnToken || 0) + 1;
  state.streaming = false;
  document.documentElement.classList.remove('oc-streaming');
  $('stop-btn').classList.add('hidden');
  $('send-btn').classList.remove('hidden');
  // 停止后消息内容已定稿,时间戳同步推进,已写出的内容不会被云端旧副本合并覆盖
  if (chat) chat.updatedAt = Date.now();
  saveChats();
}

// 开启新的一轮:记下令牌,循环用同一个值判断自己有没有被停止。
function beginTurn() {
  state.turnToken = (state.turnToken || 0) + 1;
  return state.turnToken;
}

// 该轮是否已被停止(用于多模型对比/群聊这类多步循环的中途退出)
function turnCancelled(token) {
  return token !== state.turnToken;
}

function initStreamingState() {
  state.streaming = false;
  document.documentElement.classList.remove('oc-streaming');
  state.abortController = null;
  $('stop-btn').classList.add('hidden');
  $('send-btn').classList.remove('hidden');
  if (typeof updateSendBtn === 'function') updateSendBtn();
}

// ============ 用户 / 时长 ============
async function refreshModelHealth() {
  if (!state.currentProviderId) return;
  try {
    const r = await api('/api/proxy/models?provider=' + encodeURIComponent(state.currentProviderId));
    const data = await r.json();
    if (!r.ok) return;
    state.modelHealth = data.health && typeof data.health === 'object' ? data.health : {};
    renderModelPicker();
  } catch (e) {}
}
function planPriceInfo(p) {
  // 优先用数字价格;老数据没有 price 时回退到 priceLabel 文本
  if (p.price !== null && p.price !== undefined && p.price !== '') {
    const n = parseFloat(p.price);
    if (n === 0) return { free: true, text: '0 元', unit: '直接到账' };
    return { free: false, text: '¥' + n, unit: '一次性' };
  }
  return { free: false, text: p.priceLabel || '', unit: '' };
}

async function loadAccountPackages() {
  const box = $('plan-packages'); if (!box) return;
  try {
    const r = await api('/api/packages'); const d = await r.json(); if (!r.ok) return;
    const pkgs = d.packages || [];
    if (!pkgs.length) { box.innerHTML = '<span class="muted small">暂无套餐，请联系管理员。</span>'; return; }
    box.innerHTML = '<div class="plan-grid">' + pkgs.map((p) => {
      const price = planPriceInfo(p);
      const validity = (p.validityDays && p.validityDays > 0) ? p.validityDays + ' 天有效' : '永久有效';
      const quotaTxt = p.quota === -1 ? '无限次对话' : p.quota + ' 次对话';
      const limit = (p.limitPerUser != null) ? parseInt(p.limitPerUser, 10) : 1;
      const claimedN = Number(p.claimedCount) || 0;
      let action;
      if (price.free) {
        if (state.isGuest) {
          // 游客仅享有体验轮数,不参与套餐领取(与后端一致)
          action = '<button class="btn small plan-tile-btn" disabled>注册后可领取</button>';
        } else if (p.claimed || (limit === 0)) {
          action = '<button class="btn small plan-tile-btn" disabled>' + (limit === 0 ? '暂不可领取' : '已达领取上限') + '</button>';
        } else {
          action = '<button class="btn small primary plan-tile-btn" data-claim="' + escapeHtml(p.id) + '">立即领取</button>';
        }
      } else if (p.purchaseUrl) {
        // 套餐跳转地址由后台填写(服务端已限 http/https),这里再挡一道历史数据/导入数据
        // 里的可疑协议:escapeHtml 挡得住属性逃逸,挡不住 javascript: 协议本身。
        const buy = safeUrl(p.purchaseUrl);
        action = buy
          ? '<a class="btn small primary plan-tile-btn" href="' + escapeHtml(buy) + '" target="_blank" rel="noopener noreferrer">前往购买</a>'
          : '<button class="btn small plan-tile-btn" disabled>请用兑换码兑换</button>';
      } else {
        action = '<button class="btn small plan-tile-btn" disabled>请用兑换码兑换</button>';
      }
      let statsLine = '<span>' + escapeHtml(quotaTxt) + '</span><span class="plan-tile-dot">·</span><span>' + escapeHtml(validity) + '</span>';
      if (price.free && limit !== -1) {
        statsLine += '<span class="plan-tile-dot">·</span><span>剩余 ' + Math.max(0, limit - claimedN) + ' 次领取机会</span>';
      }
      return '<div class="plan-tile' + (price.free ? ' plan-tile-free' : '') + '">'
        + '<div class="plan-tile-head"><span class="plan-tile-name">' + escapeHtml(p.name) + '</span>'
        + (price.free ? '<span class="plan-tile-tag">限时免费</span>' : '') + '</div>'
        + '<div class="plan-tile-price"><span class="plan-tile-amount">' + escapeHtml(price.text || '—') + '</span>'
        + (price.unit ? '<span class="plan-tile-unit">' + escapeHtml(price.unit) + '</span>' : '') + '</div>'
        + '<div class="plan-tile-stats">' + statsLine + '</div>'
        + (p.description ? '<p class="plan-tile-desc">' + escapeHtml(p.description) + '</p>' : '')
        + '<div class="plan-tile-foot">' + action + '</div>'
        + '</div>';
    }).join('') + '</div>';
    box.querySelectorAll('[data-claim]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r2 = await api('/api/packages/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: btn.dataset.claim }) });
        const d2 = await r2.json();
        if (!r2.ok) { toast((d2.error && d2.error.message) || '领取失败', true); btn.disabled = false; return; }
        if (d2.user) { state.user = d2.user; renderUser(); renderAccountPanel(); }
        toast('领取成功，额度已到账');
        loadAccountPackages();
      } catch (e) { btn.disabled = false; toast('网络错误，请重试', true); }
    }));
  } catch (e) {}
}
async function resumeTaskMessage(chat, message) {
  if (!message || !message.taskId || message.taskStatus === 'completed' || message.taskStatus === 'cancelled') return;
  const format = message.taskFormat || providerFormat();
  // Keep the existing partial until the first replay event succeeds.
  const oldContent = message.content || '';
  const oldReasoning = message.reasoning || '';
  const oldSeq = Number(message.taskSeq) || 0;
  message._streaming = true;
  let replayBuffer = '';
  let active = true;
  while (active && message.taskId) {
    try {
      const r = await api('/api/proxy/tasks/' + encodeURIComponent(message.taskId) + '/events?after=' + (Number(message.taskSeq) || 0));
      const d = await r.json();
      if (!r.ok) {
        message.content = oldContent; message.reasoning = oldReasoning; message._streaming = false; message.interrupted = true; message.taskStatus = 'failed'; saveChats(); reRenderLastAssistant(message); break;
      }
      for (const event of (d.events || [])) {
        if (Number(event.seq) <= (Number(message.taskSeq) || 0)) continue;
        replayBuffer += event.data || '';
        let cut;
        while ((cut = replayBuffer.indexOf('\n\n')) >= 0) {
          const frame = replayBuffer.slice(0, cut + 2);
          replayBuffer = replayBuffer.slice(cut + 2);
          handleSseChunk(frame, format, message);
        }
        message.taskSeq = Number(event.seq);
        updateStreamingText(message);
      }
      message.taskStatus = d.status || 'running';
      saveChats();
      if (d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled') {
        if (replayBuffer.trim()) { handleSseChunk(replayBuffer, format, message); replayBuffer = ''; }
        message._streaming = false;
        if (d.status !== 'completed') message.interrupted = true;
        absorbThinkTags(message, true);
        reRenderLastAssistant(message);
        saveChats();
        active = false;
      } else await new Promise((resolve) => setTimeout(resolve, 900));
    } catch (e) {
      message.content = oldContent; message.reasoning = oldReasoning; message._streaming = false; message.interrupted = true; message.taskStatus = 'failed'; saveChats(); reRenderLastAssistant(message); active = false;
    }
  }
}
function resumePendingTasks() {
  const chat = currentChat();
  if (!chat) return;
  (chat.messages || []).filter((m) => m && m.role === 'assistant' && m.taskId && m.taskStatus === 'running').forEach((m) => resumeTaskMessage(chat, m));
}

async function refreshMe() {
  try {
    const r = await api('/api/auth/me');
    const data = await r.json();
    if (r.ok) {
      state.user = data.user;
      state.usage = Array.isArray(data.usage) ? data.usage : [];
      // 拓展功能的按人可用性(仅管理员 / 仅名单):落盘并广播,让已渲染的入口重判
      if (data.features && window.OCFeatures) window.OCFeatures.set(data.features);
      renderUser();
      loadAccountPackages();
    }
  } catch (e) {}
}
function renderUser() {
  if (!state.user) return;
  fillLogoAvatar($('user-avatar'));
  $('user-name').textContent = state.user.name;
  const quotaEl = $('user-quota');
  quotaEl.textContent = '剩余次数: ' + (quotaIsUnlimited(state.user.quota) ? '无限' : state.user.quota);
quotaEl.classList.toggle('low', !quotaIsUnlimited(state.user.quota) && state.user.quota <= 5);
  const tip = usageTodayText();
  quotaEl.title = tip || '剩余可用次数';
  $('admin-link').hidden = !state.user.admin;
  $('admin-link').classList.toggle('hidden', !state.user.admin);
  // 用户信息就绪后:按「是否已有密码」调整改密表单,并刷新第三方绑定列表
  if (window.OCAccountOauth) window.OCAccountOauth();
}
function usageTodayText() {
  const today = new Date().toISOString().slice(0, 10);
  const row = (state.usage || []).find((x) => x && x.day === today);
  if (!row || !(row.calls > 0)) return '';
  const models = (row.models || []).slice(0, 3).map((m) => m.model + ' ' + m.calls + ' 次').join('，');
  return '今日已用 ' + row.calls + ' 次' + (models ? '（' + models + '）' : '');
}
// ============ 用量页:消耗总结 + 使用日志 ============
const USAGE2_PAGE_SIZE = 20;
let usage2Limit = USAGE2_PAGE_SIZE;
function collectUsageEntries() {
  const entries = [];
  (state.chats || []).forEach((c) => (c.messages || []).forEach((m) => {
    if (!m || m.role !== 'assistant' || m._streaming) return;
    const model = String(m.model || '').trim();
    if (!model) return;
    entries.push({
      t: Number(m.createdAt) || 0,
      model,
      usage: (m.usage && typeof m.usage === 'object') ? m.usage : null,
      error: !!m.error,
      interrupted: replyWasInterrupted(m),
    });
  }));
  entries.sort((a, b) => b.t - a.t);
  return entries;
}
function renderUsagePanel() {
  const sumBox = $('usage2-summary');
  if (!sumBox) return;
  const entries = collectUsageEntries();
  const byModel = new Map();
  let totPrompt = 0, totCompletion = 0, totErr = 0;
  entries.forEach((e) => {
    if (e.error) totErr++;
    const cell = byModel.get(e.model) || { calls: 0, prompt: 0, completion: 0, errors: 0 };
    cell.calls++;
    if (e.error) cell.errors++;
    if (e.usage) {
      totPrompt += e.usage.prompt || 0;
      totCompletion += e.usage.completion || 0;
      cell.prompt += e.usage.prompt || 0;
      cell.completion += e.usage.completion || 0;
    }
    byModel.set(e.model, cell);
  });
  const headNote = $('usage2-head-note');
  if (headNote) headNote.textContent = '统计来自服务器台账，清空对话不影响；下方日志为本机对话明细。';
  // 台账口径(服务器记录,清空对话不影响):全部调用 = 生命周期计数;近 14 天/Tokens/模型分布 = 近 14 天台账
  const rows = state.usage || [];
  let calls14 = 0, cost14 = 0, prompt14 = 0, completion14 = 0;
  const modelMap = new Map();
  rows.forEach((r) => {
    calls14 += Number(r.calls) || 0;
    cost14 += Number(r.cost) || 0;
    prompt14 += Number(r.prompt) || 0;
    completion14 += Number(r.completion) || 0;
    (r.models || []).forEach((m) => {
      const key = m.model || '未知模型';
      const cell = modelMap.get(key) || { calls: 0, prompt: 0, completion: 0 };
      cell.calls += Number(m.calls) || 0;
      cell.prompt += Number(m.prompt) || 0;
      cell.completion += Number(m.completion) || 0;
      modelMap.set(key, cell);
    });
  });
  if (!entries.length && !calls14) {
    sumBox.innerHTML = '<span class="muted small">还没有调用记录。</span>';
  } else {
    const models = [...modelMap.entries()].sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion));
    const maxCalls = Math.max.apply(null, models.map(([, c]) => c.calls));
    const lifetimeCalls = (state.user && Number(state.user.totalCalls) > 0) ? Number(state.user.totalCalls) : entries.length;
    const stat = (label, value, sub, accent) => '<div class="usage-stat' + (accent ? ' usage-stat-accent' : '') + '">'
      + '<span class="usage-stat-label">' + label + '</span>'
      + '<span class="usage-stat-value">' + value + '</span>'
      + (sub ? '<span class="usage-stat-sub">' + sub + '</span>' : '')
      + '</div>';
    sumBox.innerHTML = '<div class="usage-cards">'
      + stat('全部调用', lifetimeCalls, '成功调用 · 服务器台账', true)
      + stat('近 14 天调用', calls14, '平台计费 ' + cost14 + ' 额度')
      + stat('总 Tokens（14 天）', formatTokenCount(prompt14 + completion14), '↑ ' + formatTokenCount(prompt14) + ' · ↓ ' + formatTokenCount(completion14))
      + stat('涉及模型', modelMap.size, '按下方占比分布')
      + '</div>'
      + (models.length ? '<div class="usage-model-grid">' + models.map(([model, c]) => {
        const pct = maxCalls ? Math.round((c.calls / maxCalls) * 100) : 0;
        return '<div class="usage-model-card">'
          + '<div class="usage-model-name" title="' + escapeHtml(model) + '">' + escapeHtml(model) + '</div>'
          + '<div class="share-bar"><span style="width:' + pct + '%"></span></div>'
          + '<div class="usage-model-meta"><span>' + c.calls + ' 次</span>'
          + '<span class="usage-model-tokens">↑ ' + formatTokenCount(c.prompt) + ' · ↓ ' + formatTokenCount(c.completion) + '</span></div>'
          + '</div>';
      }).join('') + '</div>' : '');
  }
  const listBox = $('usage2-log');
  if (listBox) {
    const shown = entries.slice(0, usage2Limit);
    if (!shown.length) {
      listBox.innerHTML = '<span class="muted small">还没有使用记录。</span>';
    } else {
      listBox.innerHTML = shown.map((e) => {
        const d = new Date(e.t);
        const p = (v) => String(v).padStart(2, '0');
        const when = isNaN(d.getTime()) ? '-' : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        const tokens = e.usage ? '↑ ' + formatTokenCount(e.usage.prompt || 0) + ' · ↓ ' + formatTokenCount(e.usage.completion || 0) : '<span class="muted">tokens 未知</span>';
        const flag = e.error ? ' <span class="reply-flag">失败</span>' : (e.interrupted ? ' <span class="muted small">中断</span>' : '');
        return '<div class="row-between"><span style="min-width:0">' + escapeHtml(e.model) + flag
          + '<br><span class="muted small">' + when + '</span></span>'
          + '<span style="white-space:nowrap">' + tokens + '</span></div>';
      }).join('');
    }
    const note = $('usage2-log-note');
    if (note) note.textContent = '已显示 ' + shown.length + ' / ' + entries.length + ' 条';
    const more = $('usage2-more');
    if (more) more.classList.toggle('hidden', entries.length <= usage2Limit);
  }
}
const usage2MoreBtn = $('usage2-more');
if (usage2MoreBtn) usage2MoreBtn.addEventListener('click', () => { usage2Limit += USAGE2_PAGE_SIZE; renderUsagePanel(); });

function logout() {
  // 关闭账户菜单,再清除登录状态
  const menu = $('user-menu');
  if (menu) menu.classList.add('hidden');
  const chip = $('account-chip');
  if (chip) { chip.classList.remove('menu-open'); chip.setAttribute('aria-expanded', 'false'); }
  // 先让服务端吊销会话(审计留痕、token 立即失效),再清本地跳转
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    localStorage.removeItem('oc_token');
    localStorage.removeItem('oc_user');
    location.href = apiUrl('/login');
  };
  const revoke = () => {
    try {
      fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { 'Authorization': 'Bearer ' + (state.token || '') } })
        .catch(() => {})
        .finally(done);
    } catch (e) { done(); }
  };
  // 退出前把还没推上去的设置改动补推一次,再吊销会话(否则 token 先失效会丢掉最后一次改动)
  if (window.OCSettingsSync) {
    try { Promise.resolve(window.OCSettingsSync.flushAsync()).catch(() => {}).then(revoke); }
    catch (e) { revoke(); }
  } else {
    revoke();
  }
  // 网络异常时也要保证 2s 内完成登出跳转
  setTimeout(done, 2000);
}

// ============ 主题切换(委托 OCUI 统一管理;ui.js 未加载时走旧逻辑) ============
function applyTheme(t) {
  if (window.OCUI) { window.OCUI.applyTheme(t); return; }
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('oc_theme', t);
  const hljsLink = document.getElementById('hljs-theme');
  const resolved = t === 'dark' ? 'dark' : 'light';
  if (hljsLink) {
    hljsLink.setAttribute('href', window.API_BASE + '/vendor/highlight/' + (resolved === 'dark' ? 'github-dark.min.css' : 'github.min.css') + (window.OC_ASSET_V ? '?v=' + encodeURIComponent(window.OC_ASSET_V) : ''));
  }
  if (window.OCRenderer && typeof window.OCRenderer.syncMermaidTheme === 'function') {
    window.OCRenderer.syncMermaidTheme();
  }
}
function initTheme() {
  if (window.OCUI) { window.OCUI.initTheme(); return; }
  const saved = localStorage.getItem('oc_theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}
$('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(cur);
});

// ============ 设置弹窗与账户菜单 ============
const accountChip = $('account-chip');
const userMenu = $('user-menu');
if (accountChip && userMenu) {
  accountChip.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = userMenu.classList.toggle('hidden');
    accountChip.classList.toggle('menu-open', !open);
    accountChip.setAttribute('aria-expanded', String(!open));
  });
  userMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (!userMenu.classList.contains('hidden')) {
      userMenu.classList.add('hidden');
      accountChip.classList.remove('menu-open');
      accountChip.setAttribute('aria-expanded', 'false');
    }
  });
}
function closeUserMenu() {
  if (!userMenu || !accountChip) return;
  userMenu.classList.add('hidden');
  accountChip.classList.remove('menu-open');
  accountChip.setAttribute('aria-expanded', 'false');
}
$('user-menu-settings').addEventListener('click', () => {
  closeUserMenu();
  openSettings();
});
const githubLink = $('user-menu-github');
if (githubLink) githubLink.addEventListener('click', () => closeUserMenu());
const announceMenuBtn = $('user-menu-announce');
if (announceMenuBtn) announceMenuBtn.addEventListener('click', () => {
  closeUserMenu();
  if (window.OCShowAnnouncement) window.OCShowAnnouncement();
});

// ---- 主题市场(左下角用户菜单 → 主题市场) ----
const themeMarketModal = $('theme-market-modal');
// 缩略图配色从主题目录(theme-boot.js 的 OC_THEME_PACKS)读,浅色/深色各一套。
// 样式表只认 --tp-* 这五个变量,所以新增主题只要在目录里补一个 swatch,
// 这里和 chrome.css 都不用动。
function themeSwatchStyle(pack) {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const s = (pack && pack.swatch && (dark ? pack.swatch.dark : pack.swatch.light)) || {};
  return '--tp-bg:' + (s.bg || 'transparent')
    + ';--tp-panel:' + (s.panel || 'transparent')
    + ';--tp-text:' + (s.text || 'currentColor')
    + ';--tp-accent:' + (s.accent || 'transparent')
    + ';--tp-bubble:' + (s.bubble || 'transparent');
}
function renderThemeGrid() {
  const grid = $('theme-grid');
  if (!grid || !window.OCUI || !window.OCUI.themePacks) return;
  const cur = window.OCUI.themePack ? window.OCUI.themePack() : null;
  const curId = cur ? cur.id : 'default';
  grid.innerHTML = window.OCUI.themePacks().map((p) => {
    const active = p.id === curId;
    return '<button type="button" class="theme-card" role="radio" data-theme-id="' + escapeHtml(p.id) + '"'
      + ' aria-checked="' + (active ? 'true' : 'false') + '">'
      + '<span class="theme-preview" style="' + themeSwatchStyle(p) + '" aria-hidden="true">'
      + '<span class="tp-side-row"></span><span class="tp-side-row"></span><span class="tp-side-row"></span>'
      + '<span class="tp-main"><span class="tp-bubble"></span><span class="tp-line"></span>'
      + '<span class="tp-line tp-line-short"></span><span class="tp-dot"></span></span>'
      + '</span>'
      + '<span class="theme-meta">'
      + '<span class="theme-name">' + escapeHtml(p.name || p.id)
      + (active ? '<span class="theme-badge">使用中</span>' : '') + '</span>'
      + '<span class="theme-desc">' + escapeHtml(p.desc || '') + '</span>'
      + '</span></button>';
  }).join('');
  // 自带配色的主题会让「设置 → 外观 → 主题色」失效,这一点必须写在用户看得见的地方,
  // 否则用户改主题色没反应只会当成 bug。
  const foot = $('theme-market-foot');
  if (foot) foot.textContent = (cur && cur.ownsPalette) ? '该主题自带配色，「设置 → 外观 → 主题色」对它不生效。' : '';
}
function openThemeMarket() {
  if (!themeMarketModal) return;
  renderThemeGrid();
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(themeMarketModal);
  else themeMarketModal.classList.remove('hidden');
}
const themeMenuBtn = $('user-menu-theme');
if (themeMenuBtn) themeMenuBtn.addEventListener('click', () => {
  closeUserMenu();
  openThemeMarket();
});
// 「设置 → 外观 → 界面主题」是同一个市场的第二个入口:主题藏在用户菜单里很容易被漏掉。
// 设置弹窗开着时市场弹窗叠在其上,弹窗栈(ui.js 的 modalStack)已支持多层,Esc 关最上层。
const themePackEntry = $('pref-theme-pack');
if (themePackEntry) themePackEntry.addEventListener('click', openThemeMarket);
if (themeMarketModal) {
  // bindModal 的 closeSelector 走 querySelector,只能命中第一个匹配,
  // 所以两个关闭按钮分开绑(不能用 '#x, #done' 一把梭)。
  if (window.OCUI && window.OCUI.bindModal) {
    window.OCUI.bindModal(themeMarketModal, { closeSelector: '#theme-market-x' });
  }
  const themeDoneBtn = $('theme-market-done');
  if (themeDoneBtn) themeDoneBtn.addEventListener('click', () => {
    if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(themeMarketModal);
    else themeMarketModal.classList.add('hidden');
  });
  const themeGrid = $('theme-grid');
  if (themeGrid) themeGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.theme-card');
    if (!card || !window.OCUI || !window.OCUI.applyThemePack) return;
    const id = card.getAttribute('data-theme-id');
    const before = window.OCUI.themePack ? window.OCUI.themePack().id : 'default';
    const pack = window.OCUI.applyThemePack(id);
    renderThemeGrid();
    // 设置弹窗可能正开着(从「外观 → 界面主题」进来的),同步它的当前主题名与提示
    try { syncPrefsPanel(); } catch (e) {}
    if (before !== id) toast(pack.id === 'default' ? '已恢复默认主题' : '已应用主题：' + pack.name);
  });
}
const modal = $('settings-modal');
// Esc 走 OCUI.closeModal 时也要清密钥明文:挂 _onClose,统一覆盖所有关闭路径
modal._onClose = () => { if (typeof resetApiKeySecret === 'function') resetApiKeySecret(); };
function openSettings(tab) {
  // 每次打开都从干净状态开始:上次生成的密钥明文不再保留在 DOM 中
  if (typeof resetApiKeySecret === 'function') resetApiKeySecret();
  if (window.OCUI && window.OCUI.openModal) {
    window.OCUI.openModal(modal);
  } else {
    modal.classList.remove('hidden');
    modal.classList.add('show');
  }
  // 渲染各面板内容(供应商/账户/偏好)
  try { renderProviderList(); } catch (e) { console.error(e); }
  try { renderAccountPanel(); } catch (e) { console.error(e); }
  try { syncPrefsPanel(); } catch (e) { console.error(e); }
  try { refreshSettingsSyncStatus(); } catch (e) { console.error(e); }
  try { loadAccountPackages(); } catch (e) { console.error(e); }
  // tab 可能来自事件对象(MouseEvent),必须校验为字符串;不带参数时默认落在「账户」
  switchSettingsTab(typeof tab === 'string' && tab ? tab : 'account');
}
function switchSettingsTab(name) {
  document.querySelectorAll('#settings-tabs .settings-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#settings-modal .settings-panel').forEach((p) => p.classList.toggle('active', p.id === 'sp-' + name));
  if (name === 'usage2') {
    usage2Limit = USAGE2_PAGE_SIZE;
    try { renderUsagePanel(); } catch (e) { console.error(e); }
    // 余量明细也在这个面板:切进来时重新拉第一页,保证数据是最新的
    try { if (window.OCLoadQuotaLedger) window.OCLoadQuotaLedger(true); } catch (e) { console.error(e); }
  }
}
function closeSettings() {
  // 关闭即清除已生成密钥明文,避免重新打开设置仍能看到
  if (typeof resetApiKeySecret === 'function') resetApiKeySecret();
  if (window.OCUI && window.OCUI.closeModal) {
    window.OCUI.closeModal(modal);
  } else {
    modal.classList.remove('show');
    modal.classList.add('hidden');
  }
}
const settingsTabsEl = $('settings-tabs');
if (settingsTabsEl) settingsTabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-tab');
  if (btn) switchSettingsTab(btn.dataset.tab);
});
$('settings-close').addEventListener('click', closeSettings);
modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });

// ============ 设置云同步(面板开关 + 应用回调) ============
// 云端设置应用后,把依赖偏好的界面重新走一遍:主题/字体/侧栏/群聊/笔记/设置面板回显。
// 没有这一步,新设备拉回的主题与布局要等下次刷新才生效。
function applySyncedSettings() {
  if (window.OCUI) {
    if (window.OCUI.applyTheme) { try { window.OCUI.applyTheme(null); } catch (e) {} }
    if (window.OCUI.applyAppearance) { try { window.OCUI.applyAppearance(); } catch (e) {} }
  }
  // 侧边栏折叠与宽度
  const sidebar = $('sidebar');
  if (sidebar) {
    const collapsed = localStorage.getItem('oc_sidebar_collapsed') === '1';
    sidebar.classList.toggle('collapsed', collapsed);
    const floatBtn = $('sidebar-float-btn');
    if (floatBtn) floatBtn.classList.toggle('hidden', !collapsed);
    const w = parseInt(localStorage.getItem('oc_sidebar_width') || '', 10);
    if (Number.isFinite(w) && w > 0) sidebar.style.setProperty('--sidebar-w', w + 'px');
  }
  // 对话列宽度:新格式是 "61.8%"(旧格式是 px,initChatResizers 会换算后覆盖;
  // 这里先按原样写进去,避免首屏闪一下默认值)。0 表示「没设过」,保持 CSS 默认。
  const cwRaw = String(localStorage.getItem('oc_content_width') || '').trim();
  if (cwRaw && cwRaw !== '0') {
    const cw = parseFloat(cwRaw);
    if (Number.isFinite(cw) && cw > 0) {
      document.documentElement.style.setProperty('--content-w', cwRaw.endsWith('%') ? cw.toFixed(1) + '%' : cw + 'px');
    }
  }
  // 群聊配置与模式(丢弃内存缓存重新加载)
  if (window.OCGroup && window.OCGroup.reload) { try { window.OCGroup.reload(); } catch (e) {} }
  // 笔记界面(动作配置 / 排序 / 分栏宽度 / 悬浮工具条位置)
  if (window.OCNotes && window.OCNotes.applySyncedSettings) { try { window.OCNotes.applySyncedSettings(); } catch (e) {} }
  // 设置面板与输入区回显
  try { syncPrefsPanel(); } catch (e) {}
  try { syncComposerEffort(); } catch (e) {}
  try { syncComposerWebSearch(); } catch (e) {}
  try { updateSendBtn(); } catch (e) {}
}
function refreshSettingsSyncStatus(st) {
  const el = $('pref-sync-status');
  const box = $('pref-sync-settings');
  const sync = window.OCSettingsSync;
  if (!el) return;
  if (!sync) { el.textContent = '不可用'; return; }
  const s = st || sync.status();
  if (box) box.checked = !!s.enabled;
  if (s.guest) { el.textContent = '游客模式不同步'; return; }
  if (!s.enabled) { el.textContent = '已在本机关闭（本地设置照常保存）'; return; }
  if (s.serverDisabled) { el.textContent = '站点已关闭设置云同步'; return; }
  if (!s.active) { el.textContent = '登录后自动同步'; return; }
  if (s.syncing || s.dirty) { el.textContent = '同步中…'; return; }
  if (s.lastError) { el.textContent = '同步失败：' + s.lastError + '（稍后自动重试）'; return; }
  el.textContent = s.lastSyncAt
    ? '已同步 ' + new Date(s.lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '已开启';
}
(function bindSettingsSyncPanel() {
  const sync = window.OCSettingsSync;
  if (!sync) return;
  sync.onApply(() => { try { applySyncedSettings(); } catch (e) { console.error(e); } });
  sync.onStatus((s) => { try { refreshSettingsSyncStatus(s); } catch (e) {} });
  const box = $('pref-sync-settings');
  if (box) box.addEventListener('change', () => {
    sync.setEnabled(box.checked);
    refreshSettingsSyncStatus();
    toast(box.checked ? '已开启设置云同步' : '已在本机关闭设置云同步，本地设置不受影响');
  });
  const nowBtn = $('pref-sync-now');
  if (nowBtn) nowBtn.addEventListener('click', async () => {
    if (!sync.isActive()) { toast('登录后可用', true); return; }
    nowBtn.disabled = true;
    nowBtn.textContent = '同步中';
    try {
      await sync.pull({ force: true });
      await sync.push();
      toast('设置已同步');
    } catch (e) {
      toast('同步失败，请稍后重试', true);
    } finally {
      nowBtn.disabled = false;
      nowBtn.textContent = '同步';
      refreshSettingsSyncStatus();
    }
  });
  refreshSettingsSyncStatus();
})();

// ============ 账户面板 / 偏好面板 ============
function renderAccountPanel() {
  if (!state.user) return;
  const avatar = $('acc-avatar');
  if (avatar) fillLogoAvatar(avatar);
  const nm = $('acc-name');
  if (nm) nm.textContent = state.user.name + (state.user.admin ? ' · 管理员' : '');
  const extra = $('acc-extra');
  if (extra) {
    extra.textContent = '注册于 ' + new Date(state.user.createdAt).toLocaleDateString('zh-CN');
  }
  const q = $('acc-quota');
  if (q) {
    q.textContent = '剩余次数: ' + (quotaIsUnlimited(state.user.quota) ? '无限' : state.user.quota);
    q.style.color = !quotaIsUnlimited(state.user.quota) && state.user.quota <= 5 ? 'var(--danger)' : '';
  }
}

// ============ 辅助任务模型选择(跟进建议/对话命名) ============
// 候选只含对话模型;生图/生视频模型不参与文本辅助任务。
function auxModelItems() {
  const items = [];
  availableModelItems().forEach((g) => {
    if (g.label === '生图模型' || g.label === '生视频模型') return;
    (g.items || []).forEach((it) => items.push({ value: it.value, label: it.label, search: it.search }));
  });
  return items;
}
function auxModelLabel(val, mode) {
  const v = String(val || '');
  if (mode === 'title') {
    if (v === 'current') return '跟随当前模型（AI 生成）';
    if (!v) return '本地截取';
  } else if (!v) return '跟随当前模型';
  const found = auxModelItems().find((it) => it.value === v);
  return found ? found.label : (mode === 'title' ? '本地截取' : '跟随当前模型');
}
function syncAuxModelSelect(id, prefKey, mode) {
  const box = $(id);
  if (!box) return;
  const val = String(uiPref(prefKey, '') || '');
  box.setAttribute('data-value', val);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = auxModelLabel(val, mode);
}
function bindAuxModelSelect(id, prefKey, mode) {
  const box = $(id);
  if (!box || !window.OC || !OC.openSelect) return;
  const open = () => {
    const items = auxModelItems().slice();
    if (mode === 'title') items.unshift({ value: 'current', label: '跟随当前模型（AI 生成）' });
    items.unshift({ value: '', label: mode === 'title' ? '本地截取' : '跟随当前模型' });
    OC.openSelect(box, items, {
      selected: String(uiPref(prefKey, '') || ''),
      searchable: items.length > 8,
      fitWidth: true,
      onSelect: (val, item) => {
        if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(prefKey, val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || auxModelLabel(val, mode);
      },
    });
  };
  box.addEventListener('click', open);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
}
// 生图模型候选(跨供应商),供「默认生图模型」设置项使用
// 生图模型候选(跨供应商,仅生图,不含生视频),供「默认生图模型」设置项使用
function imageModelItems() {
  const items = [];
  availableModelItems().forEach((g) => {
    if (g.label !== '生图模型') return;
    (g.items || []).forEach((it) => items.push({ value: it.value, label: it.label, search: it.search }));
  });
  return items;
}
function imageModelLabel(val) {
  const v = String(val || '');
  if (!v) return '第一个生图模型';
  const found = imageModelItems().find((it) => it.value === v);
  return found ? found.label : '第一个生图模型';
}
function syncImageModelSelect(id, prefKey) {
  const box = $(id);
  if (!box) return;
  const val = String(uiPref(prefKey, '') || '');
  box.setAttribute('data-value', val);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = imageModelLabel(val);
}
function bindImageModelSelect(id, prefKey) {
  const box = $(id);
  if (!box || !window.OC || !OC.openSelect) return;
  const open = () => {
    const items = imageModelItems().slice();
    items.unshift({ value: '', label: '第一个生图模型' });
    OC.openSelect(box, items, {
      selected: String(uiPref(prefKey, '') || ''),
      searchable: items.length > 8,
      fitWidth: true,
      onSelect: (val, item) => {
        if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(prefKey, val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || imageModelLabel(val);
      },
    });
  };
  box.addEventListener('click', open);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
}
// 全站可用的生图模型 [{providerId, modelId, value, label}]（后台「默认生图模型」与自动改走生图都用到）
function allImageModels() {
  const out = [];
  (state.providers || []).forEach((p) => {
    (p.models || []).forEach((m) => {
      if (!m || !m.id) return;
      if (!modelIsImage(m.id)) return;
      out.push({ providerId: p.id, modelId: String(m.id), value: p.id + '\n' + m.id, label: p.agg ? (m.name || m.id) : ((p.name || p.id) + '@' + (m.name || m.id)) });
    });
  });
  return out;
}
// 解析「默认生图模型」:优先用户设置,否则第一个可用生图模型
function defaultImageModel() {
  const list = allImageModels();
  if (!list.length) return null;
  const pref = String(uiPref('imageModel', '') || '');
  if (pref) {
    const hit = list.find((x) => x.value === pref);
    if (hit) return hit;
  }
  return list[0];
}
function syncPrefsPanel() {
  const checks = [
    ['pref-stream', 'stream'],
    ['pref-show-api-chats', 'showApiChats'],
    ['pref-followups', 'followups'],
    ['pref-autotitle', 'autotitle'],
    ['pref-aijudge', 'aiJudge'],
    ['pref-elapsed', 'elapsed'],
    ['pref-reasoning', 'reasoning'],
  ];
  checks.forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.checked = key === 'aiJudge' ? aiJudgeEnabled() : !!uiPref(key, true);
  });
  // AI 工具判定关闭时:受它控制的子项整体置灰并折叠为一行摘要
  // (保留可展开,用户仍能看到有哪些项、当前值是什么,只是不再随判定生效)
  const judgeOn = aiJudgeEnabled();
  const judgeModelRow = $('pref-judge-model-row');
  if (judgeModelRow) judgeModelRow.classList.toggle('is-disabled', !judgeOn);
  const controlled = $('pref-judge-controlled');
  if (controlled) {
    controlled.classList.toggle('is-disabled', !judgeOn);
    // 只在开关状态变化时改折叠态,避免覆盖用户手动展开
    const was = controlled.dataset.judgeOn === '1';
    if (was !== judgeOn) {
      controlled.open = judgeOn;
      controlled.dataset.judgeOn = judgeOn ? '1' : '0';
    }
  }
  const judgeHint = $('pref-judge-hint');
  if (judgeHint) {
    judgeHint.textContent = judgeOn
      ? '一次判定同时决定：本轮要联网还是出图，并用同一个模型为新对话命名，不重复消耗。'
      : '判定已关闭：不再发起判定调用（省一次额度）。联网改用系统启发式判断，出图回退关键词粗略识别，标题改用本地截取。';
  }
  syncAuxModelSelect('pref-notes-model', 'notesModel', '');
  syncAuxModelSelect('pref-followups-model', 'followupsModel', '');
  syncAuxModelSelect('pref-judge-model', 'judgeModel', '');
  syncImageModelSelect('pref-image-model', 'imageModel');
  // 对话中自动出图:三选一分段(默认粗略)
  const aiMode = autoImageMode();
  document.querySelectorAll('#pref-auto-image .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.autoimage === aiMode);
  });
  const effortVal = reasoningEffort();
  document.querySelectorAll('#pref-reasoning-effort .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.effort === effortVal);
  });
  const effortRow = $('pref-reasoning-effort-row');
  if (effortRow) effortRow.style.opacity = reasoningEnabled() ? '1' : '0.45';
  const ctxInput = $('pref-context');
  const ctxCap = Math.min(500, Math.max(2, Number((state.chatLimits || {}).maxContextMessages) || 200));
  const ctxDefault = Math.min(ctxCap, Math.max(2, Number((state.chatLimits || {}).contextMessages) || 12));
  if (ctxInput) {
    ctxInput.min = '2';
    ctxInput.max = String(ctxCap);
    const stored = Number(uiPref('contextMessages', ctxDefault));
    ctxInput.value = String(Math.min(ctxCap, Math.max(2, isFinite(stored) ? stored : ctxDefault)));
  }
  const ctxDesc = $('pref-context-desc');
  if (ctxDesc) ctxDesc.textContent = '每次请求带上最近的对话消息，不含系统提示词。最多 ' + ctxCap + ' 条';
  const themeVal = (window.OCUI && window.OCUI.getPref && window.OCUI.getPref('theme')) || 'system';
  document.querySelectorAll('#pref-theme .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeVal === themeVal);
  });
  // 界面主题行:显示当前主题包名(入口本身在用户菜单,这里只是同步状态)
  const packBtn = $('pref-theme-pack');
  if (packBtn && window.OCUI && window.OCUI.themePack) {
    const pack = window.OCUI.themePack();
    const nameEl = $('pref-theme-pack-name');
    if (nameEl) nameEl.textContent = pack.name || pack.id;
    const descEl = $('pref-theme-pack-desc');
    if (descEl) descEl.textContent = pack.ownsPalette
      ? '自带配色，「主题色」对该主题不生效'
      : '在主题市场里挑选整套外观';
  }
  // 外观控件
  const fs = Number(uiPref('fontSize', 14)) || 14;
  const fsEl = $('pref-fontsize');
  if (fsEl) fsEl.value = fs;
  const fsVal = $('pref-fontsize-val');
  if (fsVal) fsVal.textContent = fs + 'px · ' + Math.round(fs / 14 * 100) + '%';
  const syncFontChoice = (key, inputId, selectId, fallback, labels) => {
    const value = String(uiPref(key, fallback) || fallback).trim();
    const input = $(inputId);
    if (input) input.value = (value === fallback || value === 'system') ? '' : value;
    const trigger = $(selectId);
    if (trigger) {
      const label = trigger.querySelector('.font-select-label');
      if (label) label.textContent = labels[value] || (value === 'system' ? '系统字体' : value);
    }
  };
  syncFontChoice('fontCjk', 'pref-font-cjk', 'pref-font-cjk-select', 'source-han-serif', { 'source-han-serif': '思源宋体', 'alibaba-puhuiti': 'AlibabaPuHuiTi', system: '系统字体' });
  syncFontChoice('fontLatin', 'pref-font-latin', 'pref-font-latin-select', 'alibaba-sans', { 'times-new-roman': 'Times New Roman', helvetica: 'Helvetica', 'alibaba-sans': 'AlibabaSans', system: '系统字体' });
  if (typeof syncAccentPicker === 'function') {
    const hex = /^#[0-9a-fA-F]{3,8}$/.test(uiPref('accent', ''))
      ? uiPref('accent', '')
      : ((window.OCUI && window.OCUI.defaultAccent) || '#2563eb');
    syncAccentPicker(hex);
  }
  if (typeof syncComposerEffort === 'function') syncComposerEffort();
  if (typeof syncToolSourcePanel === 'function') syncToolSourcePanel();
}
function syncToolSourcePanel() {
  const search = (state.tools && state.tools.webSearch) || {};
  const parse = (state.tools && state.tools.parse) || {};
  const searchRow = $('pref-search-source-row');
  const parseRow = $('pref-parse-source-row');
  if (searchRow) searchRow.classList.toggle('hidden', !search.allowOwn);
  if (parseRow) parseRow.classList.toggle('hidden', !parse.allowOwn);
  document.querySelectorAll('#pref-search-source .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === (search.source || 'platform'));
  });
  document.querySelectorAll('#pref-parse-source .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === (parse.source || 'platform'));
  });
  const searchOwn = $('pref-search-own');
  const parseOwn = $('pref-parse-own');
  if (searchOwn) searchOwn.classList.toggle('hidden', !search.allowOwn || search.source !== 'own');
  if (parseOwn) parseOwn.classList.toggle('hidden', !parse.allowOwn || parse.source !== 'own');
  const provider = $('pref-search-provider');
  const SEARCH_NAMES = { tavily: 'Tavily', searxng: 'SearXNG', brave: 'Brave Search', ddg: 'DuckDuckGo', jina: 'Jina AI' };
  const providerVal = SEARCH_NAMES[search.provider] ? search.provider : 'ddg';
  if (provider) {
    provider.setAttribute('data-value', providerVal);
    const lab = provider.querySelector('.sb-label');
    if (lab) lab.textContent = SEARCH_NAMES[providerVal];
  }
  const keyRow = $('pref-search-key-row');
  const braveRow = $('pref-search-brave-row');
  const jinaRow = $('pref-search-jina-row');
  const urlRow = $('pref-search-url-row');
  if (keyRow) keyRow.classList.toggle('hidden', providerVal !== 'tavily');
  if (braveRow) braveRow.classList.toggle('hidden', providerVal !== 'brave');
  if (jinaRow) jinaRow.classList.toggle('hidden', providerVal !== 'jina');
  if (urlRow) urlRow.classList.toggle('hidden', providerVal !== 'searxng');
  const key = $('pref-search-key');
  if (key && document.activeElement !== key) key.value = search.keyMask || '';
  const braveKey = $('pref-search-brave-key');
  if (braveKey && document.activeElement !== braveKey) braveKey.value = search.braveKeyMask || '';
  const jinaKey = $('pref-search-jina-key');
  if (jinaKey && document.activeElement !== jinaKey) jinaKey.value = search.jinaKeyMask || '';
  const url = $('pref-search-url');
  if (url && document.activeElement !== url) url.value = search.searxUrl || '';
  const token = $('pref-parse-token');
  if (token && document.activeElement !== token) token.value = parse.tokenMask || '';
  const searchDesc = $('pref-search-source-desc');
  if (searchDesc) {
    searchDesc.textContent = search.source === 'own'
      ? (search.ownReady ? '当前使用你自己的检索配置' : '已选自己的配置，但还没填完整')
      : (search.platformReady ? '当前使用平台配置' : '平台还没有可用的联网配置');
  }
  const parseDesc = $('pref-parse-source-desc');
  if (parseDesc) {
    const mode = parse.source === 'own' ? (parse.hasToken ? '精准' : '轻量') : (parse.platformMode === 'precise' ? '精准' : '轻量');
    parseDesc.textContent = (parse.source === 'own' ? '当前使用你自己的解析：' : '当前使用平台解析：') + mode;
  }
  const actions = $('pref-tools-actions');
  const locked = !search.allowOwn && !parse.allowOwn;
  if (actions) actions.classList.toggle('hidden', locked);
  const note = $('pref-tools-locked');
  if (note) note.classList.toggle('hidden', !locked);
}
function applyToolState(tools) {
  if (!tools) return;
  state.tools = tools;
  const parse = tools.parse || {};
  if (parse.source === 'own' && parse.allowOwn) {
    state.mineru = { enabled: true, mode: parse.hasToken ? 'precise' : 'lite', allowOwn: true };
  }
  syncToolSourcePanel();
  if (typeof syncComposerWebSearch === 'function') syncComposerWebSearch();
}
async function saveToolSource(patch) {
  const tip = $('pref-tools-tip');
  if (tip) tip.textContent = '保存中…';
  const r = await api('/api/me/tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '保存失败');
  applyToolState(data.tools);
  if (tip) tip.textContent = '已保存';
}
(function bindToolSource() {
  document.querySelectorAll('#pref-search-source .seg-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await saveToolSource({ webSearchSource: b.dataset.source }); }
      catch (e) { toast(e.message || '保存失败', true); }
    });
  });
  document.querySelectorAll('#pref-parse-source .seg-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await saveToolSource({ parseSource: b.dataset.source }); }
      catch (e) { toast(e.message || '保存失败', true); }
    });
  });
  const provider = $('pref-search-provider');
  if (provider && window.OC && window.OC.openSelect) {
    const SEARCH_PROVIDERS = [
      { value: 'ddg', label: 'DuckDuckGo', sub: '免 Key，默认；有速率限制' },
      { value: 'tavily', label: 'Tavily', sub: '官方搜索 API，填自己的 Key' },
      { value: 'searxng', label: 'SearXNG', sub: '自建元搜索，填实例地址' },
      { value: 'brave', label: 'Brave Search', sub: '独立索引，填自己的 Key' },
      { value: 'jina', label: 'Jina AI', sub: '免 Key 可用，填 Key 提升配额' },
    ];
    const open = () => {
      window.OC.openSelect(provider, SEARCH_PROVIDERS, {
        selected: provider.getAttribute('data-value') || 'ddg',
        onSelect: (val) => {
          const next = SEARCH_NAMES[val] ? val : 'ddg';
          provider.setAttribute('data-value', next);
          const lab = provider.querySelector('.sb-label');
          if (lab) lab.textContent = SEARCH_NAMES[next];
          if (keyRow) keyRow.classList.toggle('hidden', next !== 'tavily');
          if (braveRow) braveRow.classList.toggle('hidden', next !== 'brave');
          if (jinaRow) jinaRow.classList.toggle('hidden', next !== 'jina');
          if (urlRow) urlRow.classList.toggle('hidden', next !== 'searxng');
        },
      });
    };
    provider.addEventListener('click', open);
    provider.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }
  const save = $('pref-tools-save');
  if (save) save.addEventListener('click', async () => {
    const search = (state.tools && state.tools.webSearch) || {};
    const body = {
      webSearchProvider: (provider && provider.getAttribute('data-value')) || 'ddg',
      webSearchSearxUrl: ($('pref-search-url') && $('pref-search-url').value) || '',
    };
    const key = ($('pref-search-key') && $('pref-search-key').value || '').trim();
    const braveKey = ($('pref-search-brave-key') && $('pref-search-brave-key').value || '').trim();
    const jinaKey = ($('pref-search-jina-key') && $('pref-search-jina-key').value || '').trim();
    const token = ($('pref-parse-token') && $('pref-parse-token').value || '').trim();
    if (key !== (search.keyMask || '')) body.webSearchTavilyKey = key;
    if (braveKey !== (search.braveKeyMask || '')) body.webSearchBraveKey = braveKey;
    if (jinaKey !== (search.jinaKeyMask || '')) body.webSearchJinaKey = jinaKey;
    if (token !== (((state.tools && state.tools.parse) || {}).tokenMask || '')) body.mineruToken = token;
    save.disabled = true;
    try {
      await saveToolSource(body);
      toast('工具来源已保存');
    } catch (e) {
      toast(e.message || '保存失败', true);
      const tip = $('pref-tools-tip');
      if (tip) tip.textContent = '';
    } finally {
      save.disabled = false;
    }
  });
})();
(function bindPrefsPanel() {
  const bindCheck = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(key, el.checked);
      else localStorage.setItem('oc_pref_' + key, el.checked ? '1' : '0');
      if (key === 'stream') state.streamToggle = el.checked;
      // 「显示 API 对话」关掉后列表要当场少掉那些会话(以及它们的「今天 API」分组)。
      // 这个开关只改了偏好,没有任何后续动作会重绘侧栏 —— 不在这里重绘,用户会看到
      // 开关明明关了、列表却原样不动,直到某次刷新才生效。
      if (key === 'showApiChats') renderChatList();
      if (key === 'reasoning') {
        syncPrefsPanel();
        syncComposerEffort();
      }
    });
  };
  bindCheck('pref-stream', 'stream');
  bindCheck('pref-show-api-chats', 'showApiChats');
  bindCheck('pref-followups', 'followups');
  bindCheck('pref-autotitle', 'autotitle');
  // AI 工具判定总开关:切换后即时刷新提示与子项状态
  const judgeEl = $('pref-aijudge');
  if (judgeEl) judgeEl.addEventListener('change', () => {
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('aiJudge', judgeEl.checked);
    syncPrefsPanel();
  });
  bindAuxModelSelect('pref-notes-model', 'notesModel', 'notes');
  bindAuxModelSelect('pref-followups-model', 'followupsModel', 'followups');
  bindAuxModelSelect('pref-judge-model', 'judgeModel', '');
  bindImageModelSelect('pref-image-model', 'imageModel');
  // 对话中自动出图:三选一(关闭 / 粗略 / 智能判定)
  const autoImgBox = $('pref-auto-image');
  if (autoImgBox) autoImgBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || !btn.dataset.autoimage) return;
    document.querySelectorAll('#pref-auto-image .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('autoImageMode', btn.dataset.autoimage);
  });
  bindCheck('pref-elapsed', 'elapsed');
  bindCheck('pref-reasoning', 'reasoning');
  const effortBox = $('pref-reasoning-effort');
  if (effortBox) effortBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const val = btn.dataset.effort;
    if (!val) return;
    document.querySelectorAll('#pref-reasoning-effort .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('reasoningEffort', val);
    if (!reasoningEnabled() && window.OCUI && window.OCUI.setPref) {
      window.OCUI.setPref('reasoning', true);
      const sw = $('pref-reasoning');
      if (sw) sw.checked = true;
    }
    syncPrefsPanel();
    syncComposerEffort();
  });

  const ctxInput = $('pref-context');
  const commitContext = (raw, delta) => {
    if (!ctxInput) return;
    const cap = Math.min(500, Math.max(2, Number(ctxInput.max) || Number((state.chatLimits || {}).maxContextMessages) || 200));
    const current = parseInt(ctxInput.value, 10) || 2;
    const n = Math.min(cap, Math.max(2, (delta ? current + delta : parseInt(raw, 10)) || 2));
    ctxInput.value = String(n);
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('contextMessages', n);
  };
  if (ctxInput) {
    ctxInput.addEventListener('change', () => commitContext(ctxInput.value));
    ctxInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitContext(ctxInput.value); ctxInput.blur(); }
    });
  }
  const ctxMinus = $('pref-context-minus');
  const ctxPlus = $('pref-context-plus');
  if (ctxMinus) ctxMinus.addEventListener('click', () => commitContext(null, -1));
  if (ctxPlus) ctxPlus.addEventListener('click', () => commitContext(null, 1));

  const themeBox = $('pref-theme');
  if (themeBox) themeBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const val = btn.dataset.themeVal;
    document.querySelectorAll('#pref-theme .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (window.OCUI && window.OCUI.applyTheme) window.OCUI.applyTheme(val);
    else applyTheme(val);
  });

  // ---- 外观:字体大小 ----
  const applyFontSize = (v) => {
    const n = Math.min(22, Math.max(11, Number(v) || 14));
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('fontSize', n);
    if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    const valEl = $('pref-fontsize-val');
    if (valEl) valEl.textContent = n + 'px · ' + Math.round(n / 14 * 100) + '%';
    const slider = $('pref-fontsize');
    if (slider) slider.value = n;
  };
  const fsSlider = $('pref-fontsize');
  if (fsSlider) fsSlider.addEventListener('input', () => applyFontSize(fsSlider.value));
  const fsMinus = $('pref-fontsize-minus');
  if (fsMinus) fsMinus.addEventListener('click', () => applyFontSize((Number(fsSlider.value) || 14) - 1));
  const fsPlus = $('pref-fontsize-plus');
  if (fsPlus) fsPlus.addEventListener('click', () => applyFontSize((Number(fsSlider.value) || 14) + 1));

  // ---- 外观:中文与英文/希腊字母字体 ----
  const applyFontChoice = (key, inputId, value, fallback) => {
    const name = String(value || '').trim() || fallback;
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref(key, name);
    if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
    const el = $(inputId);
    if (el) el.value = (name === fallback || name === 'system') ? '' : name;
  };
  const bindFontChoice = (config) => {
    const { key, inputId, selectId, browseId, fallback, labels, options } = config;
    const input = $(inputId);
    const select = $(selectId);
    if (select) select.addEventListener('click', () => {
      const current = (window.OCUI && window.OCUI.getPref) ? window.OCUI.getPref(key) : fallback;
      window.OC.openSelect(select, options.map((value) => ({ value, label: labels[value] || value })), {
        selected: current,
        onSelect: (value) => {
          applyFontChoice(key, inputId, value, fallback);
          const label = select.querySelector('.font-select-label');
          if (label) label.textContent = labels[value] || value;
        },
      });
    });
    if (input) {
      let timer = null;
      const commit = () => applyFontChoice(key, inputId, input.value, fallback);
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(commit, 300);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); commit(); }
      });
    }
    const browse = $(browseId);
    if (browse) browse.addEventListener('click', async () => {
      if (!window.queryLocalFonts) {
        toast('当前浏览器不支持读取本机字体,请直接输入字体名', true);
        return;
      }
      let fonts = [];
      try { fonts = await window.queryLocalFonts(); }
      catch (e) { toast('无法读取本机字体:' + e.message, true); return; }
      const seen = new Set();
      const uniq = [];
      fonts.forEach((f) => {
        const name = f.family || '';
        if (!name || seen.has(name)) return;
        seen.add(name);
        uniq.push(name);
      });
      uniq.sort((a, b) => a.localeCompare(b, 'zh'));
      if (!uniq.length) { toast('未找到本机字体'); return; }
      const current = input ? input.value.trim() : '';
      window.OC.openSelect(browse, uniq.map((name) => ({ value: name, label: name })), {
        selected: current,
        searchable: true,
        searchPlaceholder: '搜索本机字体…',
        width: 320,
        onSelect: (name) => applyFontChoice(key, inputId, name, fallback),
      });
      document.querySelectorAll('.oc-menu-item[data-value]').forEach((row) => {
        const name = row.dataset.value;
        const label = row.querySelector('.item-label');
        if (label && name) label.style.fontFamily = '"' + name.replace(/"/g, '') + '"';
      });
    });
  };
  bindFontChoice({ key: 'fontCjk', inputId: 'pref-font-cjk', selectId: 'pref-font-cjk-select', browseId: 'pref-font-cjk-browse', fallback: 'source-han-serif', options: ['source-han-serif', 'alibaba-puhuiti', 'system'], labels: { 'source-han-serif': '思源宋体', 'alibaba-puhuiti': 'AlibabaPuHuiTi', system: '系统字体' } });
  bindFontChoice({ key: 'fontLatin', inputId: 'pref-font-latin', selectId: 'pref-font-latin-select', browseId: 'pref-font-latin-browse', fallback: 'alibaba-sans', options: ['alibaba-sans', 'times-new-roman', 'helvetica', 'system'], labels: { 'times-new-roman': 'Times New Roman', helvetica: 'Helvetica', 'alibaba-sans': 'AlibabaSans', system: '系统字体' } });

  // ---- 外观:主题色（色相 / 饱和度 / 明度 / 透明度）----
  function hexToRgba(hex) {
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
  function pad2(n) {
    return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  }
  function rgbToHex(r, g, b) {
    return '#' + pad2(r) + pad2(g) + pad2(b);
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }
  function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;
    if (s === 0) {
      const v = l * 255;
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const tk = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: tk(hue + 1 / 3) * 255, g: tk(hue) * 255, b: tk(hue - 1 / 3) * 255 };
  }
  const accentState = { h: 221, s: 0.83, l: 0.53, a: 1 };
  function currentAccentHex() {
    const rgb = hslToRgb(accentState.h, accentState.s, accentState.l);
    let hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    if (accentState.a < 0.999) hex += pad2(accentState.a * 255);
    return hex.toUpperCase();
  }
  function paintAccent() {
    const rgb = hslToRgb(accentState.h, accentState.s, accentState.l);
    const solid = rgbToHex(rgb.r, rgb.g, rgb.b);
    const css = 'rgba(' + Math.round(rgb.r) + ', ' + Math.round(rgb.g) + ', ' + Math.round(rgb.b) + ', ' + accentState.a + ')';
    const hueThumb = $('accent-hue-thumb');
    const satThumb = $('accent-sat-thumb');
    const lightThumb = $('accent-light-thumb');
    const alphaThumb = $('accent-alpha-thumb');
    if (hueThumb) hueThumb.style.left = ((accentState.h / 360) * 100) + '%';
    if (satThumb) satThumb.style.left = (accentState.s * 100) + '%';
    if (lightThumb) lightThumb.style.left = (accentState.l * 100) + '%';
    if (alphaThumb) alphaThumb.style.left = (accentState.a * 100) + '%';
    const hue = $('accent-hue');
    const sat = $('accent-sat');
    const light = $('accent-light');
    const alpha = $('accent-alpha');
    if (hue) hue.setAttribute('aria-valuenow', String(Math.round(accentState.h)));
    if (sat) {
      sat.setAttribute('aria-valuenow', String(Math.round(accentState.s * 100)));
      const gray = hslToRgb(accentState.h, 0, accentState.l);
      const full = hslToRgb(accentState.h, 1, accentState.l);
      sat.style.background = 'linear-gradient(90deg, ' + rgbToHex(gray.r, gray.g, gray.b) + ', ' + rgbToHex(full.r, full.g, full.b) + ')';
    }
    if (light) {
      light.setAttribute('aria-valuenow', String(Math.round(accentState.l * 100)));
      const mid = hslToRgb(accentState.h, accentState.s, 0.5);
      light.style.background = 'linear-gradient(90deg, #141414, ' + rgbToHex(mid.r, mid.g, mid.b) + ' 50%, #fff)';
    }
    if (alpha) {
      alpha.setAttribute('aria-valuenow', String(Math.round(accentState.a * 100)));
      alpha.style.setProperty('--accent-solid', solid);
    }
    const hueVal = $('accent-hue-val');
    const satVal = $('accent-sat-val');
    const lightVal = $('accent-light-val');
    const alphaVal = $('accent-alpha-val');
    if (hueVal) hueVal.textContent = Math.round(accentState.h) + '°';
    if (satVal) satVal.textContent = Math.round(accentState.s * 100) + '%';
    if (lightVal) lightVal.textContent = Math.round(accentState.l * 100) + '%';
    if (alphaVal) alphaVal.textContent = Math.round(accentState.a * 100) + '%';
    const fill = (el) => { if (el) el.style.setProperty('--swatch', css); };
    fill($('accent-preview'));
    fill($('accent-swatch'));
    const entry = $('accent-entry-swatch');
    if (entry) entry.style.setProperty('--swatch', css);
    const entryHex = $('accent-entry-hex');
    if (entryHex) entryHex.textContent = currentAccentHex();
    const hexEl = $('pref-accent-hex');
    if (hexEl && document.activeElement !== hexEl) hexEl.value = currentAccentHex();
    const clearBtn = $('pref-accent-clear');
    if (clearBtn) clearBtn.classList.toggle('is-clear', accentState.a < 0.01);
  }
  function commitAccent() {
    if (window.OCUI && window.OCUI.setPref) window.OCUI.setPref('accent', currentAccentHex());
    if (window.OCUI && window.OCUI.applyAppearance) window.OCUI.applyAppearance();
  }
  function applyAccentHex(hex, persist) {
    const rgba = hexToRgba(hex);
    if (!rgba) return false;
    const hsl = rgbToHsl(rgba.r, rgba.g, rgba.b);
    accentState.h = hsl.h;
    accentState.s = hsl.s;
    accentState.l = hsl.l;
    accentState.a = rgba.a;
    paintAccent();
    if (persist) commitAccent();
    return true;
  }
  window.syncAccentPicker = function (hex) {
    applyAccentHex(hex || ((window.OCUI && window.OCUI.defaultAccent) || '#2563eb'), false);
  };
  function bindAccentTrack(el, kind) {
    if (!el) return;
    const setFromEvent = (ev) => {
      const rect = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, ((ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left) / (rect.width || 1)));
      if (kind === 'hue') accentState.h = t * 360;
      else if (kind === 'sat') accentState.s = t;
      else if (kind === 'light') accentState.l = t;
      else accentState.a = t;
      paintAccent();
      commitAccent();
    };
    const onMove = (ev) => { ev.preventDefault(); setFromEvent(ev); };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (el.setPointerCapture) el.setPointerCapture(ev.pointerId);
      setFromEvent(ev);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    el.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 8 : 2;
      const dir = (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') ? -1
        : (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') ? 1 : 0;
      if (!dir) return;
      ev.preventDefault();
      if (kind === 'hue') accentState.h = (accentState.h + dir * step + 360) % 360;
      else if (kind === 'sat') accentState.s = Math.max(0, Math.min(1, accentState.s + dir * step / 100));
      else if (kind === 'light') accentState.l = Math.max(0, Math.min(1, accentState.l + dir * step / 100));
      else accentState.a = Math.max(0, Math.min(1, accentState.a + dir * step / 100));
      paintAccent();
      commitAccent();
    });
  }
  bindAccentTrack($('accent-hue'), 'hue');
  bindAccentTrack($('accent-sat'), 'sat');
  bindAccentTrack($('accent-light'), 'light');
  bindAccentTrack($('accent-alpha'), 'alpha');
  const accHex = $('pref-accent-hex');
  if (accHex) {
    accHex.addEventListener('change', () => { if (!applyAccentHex(accHex.value, true)) paintAccent(); });
    accHex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!applyAccentHex(accHex.value, true)) paintAccent();
        accHex.blur();
      }
    });
  }
  const accClear = $('pref-accent-clear');
  if (accClear) accClear.addEventListener('click', () => {
    accentState.a = accentState.a < 0.01 ? 1 : 0;
    paintAccent();
    commitAccent();
  });
  // 恢复默认:写回内置默认色(而不是删键——云同步按「键存在与否」比对,
  // 删掉的键下次拉取会被云端的旧颜色重新填回来)。
  const accReset = $('accent-modal-reset');
  if (accReset) accReset.addEventListener('click', () => {
    applyAccentHex((window.OCUI && window.OCUI.defaultAccent) || '#2563eb', true);
    toast('已恢复默认主题色');
  });
  const accOpen = $('accent-open');
  if (accOpen) accOpen.addEventListener('click', () => {
    const stored = (window.OCUI && window.OCUI.getPref) ? window.OCUI.getPref('accent') : '';
    applyAccentHex(stored || ((window.OCUI && window.OCUI.defaultAccent) || '#2563eb'), false);
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal($('accent-modal'));
  });
  if (window.OCUI && window.OCUI.bindModal) {
    window.OCUI.bindModal($('accent-modal'), { closeSelector: '#accent-modal-x, #accent-modal-done' });
  }

})();

// ============ 账户操作:改密 / 导出 / 清空 ============
// 账户面板:改用户名/改密码改为「点击弹窗」,不再把长表单铺在面板里
(function bindAccountActions() {
  // 通用小弹窗:标题 + 若干输入项 + 确定/取消
  function openAccountDialog(title, fields, onSubmit) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const inputs = fields.map((f, idx) =>
      '<label class="field"><span>' + escapeHtml(f.label) + '</span>'
      + '<input type="' + (f.type || 'text') + '" id="acd-' + idx + '"'
      + (f.placeholder ? ' placeholder="' + escapeHtml(f.placeholder) + '"' : '')
      + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '')
      + ' autocomplete="' + (f.type === 'password' ? 'new-password' : 'off') + '"></label>').join('');
    // 用应用统一的弹窗三段式(modal-header/body/footer):padding、标题与底部按钮对齐
    // 都由既有样式提供,与「添加助手」等弹窗保持一致
    const closeIcon = (window.OC && OC.icon) ? OC.icon('close', 16) : '';
    mask.innerHTML = '<div class="modal modal-sm" role="dialog" aria-modal="true">'
      + '<div class="modal-header">'
      + '<h3>' + escapeHtml(title) + '</h3>'
      + '<button class="icon-btn" type="button" id="acd-x" aria-label="关闭">' + closeIcon + '</button>'
      + '</div>'
      + '<div class="modal-body">'
      + inputs
      + '<div class="hidden" id="acd-err" style="color:#dc2626;font-size:13px;margin:4px 0"></div>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn" type="button" id="acd-cancel">取消</button>'
      + '<button class="btn primary" type="button" id="acd-ok">确定</button>'
      + '</div></div>';
    document.body.appendChild(mask);
    // 纳入统一弹窗栈:支持 Esc 关闭
    const rawClose = () => { try { document.body.removeChild(mask); } catch (e) { /* 忽略 */ } };
    const close = (window.OCUI && window.OCUI.adoptModal) ? window.OCUI.adoptModal(mask, rawClose) : rawClose;
    const errBox = mask.querySelector('#acd-err');
    const showErr = (m) => { errBox.textContent = m; errBox.classList.remove('hidden'); };
    const first = mask.querySelector('#acd-0');
    if (first) first.focus();
    const xBtn = mask.querySelector('#acd-x');
    if (xBtn) xBtn.addEventListener('click', close);
    mask.querySelector('#acd-cancel').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    const okBtn = mask.querySelector('#acd-ok');
    okBtn.addEventListener('click', async () => {
      const vals = fields.map((f, idx) => (mask.querySelector('#acd-' + idx).value || ''));
      okBtn.disabled = true; const label = okBtn.textContent; okBtn.textContent = '提交中…';
      try {
        await onSubmit(vals, showErr);
        close();
      } catch (e) {
        showErr((e && e.message) || '操作失败');
      } finally {
        okBtn.disabled = false; okBtn.textContent = label;
      }
    });
  }

  // 修改密码(按钮 → 弹窗)
  const changePwd = $('acc-change-pwd');
  if (changePwd) changePwd.addEventListener('click', () => {
    const needsOld = !!(state.user && state.user.hasPassword);
    const fields = [];
    if (needsOld) fields.push({ label: '当前密码', type: 'password' });
    fields.push({ label: '新密码（至少 4 位）', type: 'password' });
    fields.push({ label: '确认新密码', type: 'password' });
    openAccountDialog(needsOld ? '修改密码' : '设置密码', fields, async (vals, showErr) => {
      const off = needsOld ? 1 : 0;
      const oldPwd = needsOld ? vals[0] : '';
      const newPwd = vals[off];
      const newPwd2 = vals[off + 1];
      if (needsOld && !oldPwd) throw new Error('请填写当前密码');
      if (!newPwd) throw new Error('请填写新密码');
      if (newPwd.length < 4) throw new Error('新密码至少 4 个字符');
      if (newPwd !== newPwd2) throw new Error('两次输入的新密码不一致');
      const r = await api('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
      });
      const data = await readJsonSafe(r);
      if (!r.ok) throw new Error((data.error && data.error.message) || '修改失败');
      state.token = data.token;
      try { localStorage.setItem('oc_token', data.token); } catch (e) { /* 忽略 */ }
      if (state.user) state.user.hasPassword = true;
      renderAccountPanel();
      toast('密码已更新，其它设备上的登录已失效');
    });
  });

  // 注销账号:后台可配置为不允许 / 软注销 / 硬注销。
  // 确认弹窗只保留一句后果说明,细节不在前台铺陈(追问细节请联系管理员)
  const delAcc = $('acc-delete-account');
  if (delAcc) {
    delAcc.addEventListener('click', async () => {
      const mode = String((state.config && state.config.accountDeletionMode) || 'soft');
      const hasPwd = !!(state.user && state.user.hasPassword);
      const soft = mode !== 'hard';
      const note = soft
        ? '将立即清除你的账号资料、全部对话与自建供应商。'
        : '将立即删除你的账号及其全部数据（对话、自建供应商、API 密钥等），此操作不可恢复。';
      const ok = window.OCUI && window.OCUI.confirm
        ? await window.OCUI.confirm({ title: '注销账号', message: note, danger: true, confirmText: '继续注销' })
        : window.confirm(note);
      if (!ok) return;
      // 二次确认:有密码验密码,无密码要求手输用户名
      const fields = hasPwd
        ? [{ label: '当前密码（确认身份）', type: 'password' }]
        : [{ label: '输入当前用户名以确认', placeholder: String((state.user && state.user.name) || ''), maxlength: 32 }];
      openAccountDialog('确认注销账号', fields, async (vals, showErr) => {
        const body = hasPwd ? { password: vals[0] || '' } : { confirmName: (vals[0] || '').trim() };
        if (hasPwd && !body.password) throw new Error('请输入当前密码');
        if (!hasPwd && !body.confirmName) throw new Error('请输入当前用户名');
        const r = await api('/api/auth/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await readJsonSafe(r);
        if (!r.ok) throw new Error((d.error && d.error.message) || '注销失败');
        try { localStorage.removeItem('oc_token'); } catch (e) { /* 忽略 */ }
        state.token = '';
        state.user = null;
        try { sessionStorage.setItem('oc_just_deleted', d.mode === 'hard' ? '1' : 'soft'); } catch (e) { /* 忽略 */ }
        location.replace('/login');
      });
    });
  }

  // 注销入口可见性:后台关掉时不显示(具体后果在点击后的确认弹窗里说明)
  function renderDeleteAccount() {
    const zone = $('acc-danger-zone');
    if (!zone) return;
    const mode = String((state.config && state.config.accountDeletionMode) || 'soft');
    zone.classList.toggle('hidden', mode === 'off');
  }
  window.OCRefreshDeleteAccount = renderDeleteAccount;
  renderDeleteAccount();

  // 修改用户名(用户名旁的小按钮 → 弹窗)
  const editName = $('acc-edit-name');
  if (editName) {
    if (window.OC && OC.icon) editName.innerHTML = OC.icon('edit', 15);
    editName.addEventListener('click', () => {
      const needsPwd = !!(state.user && state.user.hasPassword);
      const fields = [{ label: '新用户名', maxlength: 32, placeholder: '2-32 位（字母/数字/中文/._@-）' }];
      if (needsPwd) fields.push({ label: '当前密码（确认身份）', type: 'password' });
      openAccountDialog('修改用户名', fields, async (vals, showErr) => {
        const name = (vals[0] || '').trim();
        const pwd = needsPwd ? vals[1] : '';
        if (!name) throw new Error('请输入新用户名');
        const r = await api('/api/auth/name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, password: pwd }),
        });
        const d = await readJsonSafe(r);
        if (!r.ok) throw new Error((d.error && d.error.message) || '修改失败');
        if (d.token) {
          state.token = d.token;
          try { localStorage.setItem('oc_token', d.token); } catch (e) { /* 忽略 */ }
        }
        if (d.user) state.user = d.user;
        renderUser();
        renderAccountPanel();
        toast('用户名已更新，下次请用新用户名登录');
      });
    });
  }

  // 第三方账号绑定:列出提供商与绑定状态,可解绑
  function renderAccountOauth(data) {
    const box = $('acc-oauth-list');
    if (!box) return;
    // 只展示管理员已启用的平台:未启用的对用户没有意义(既不显示也不占位)。
    // 已绑定的即便被管理员停用也保留显示,否则用户没法自行解绑。
    const list = (data && Array.isArray(data.providers)) ? data.providers.filter((p) => p.enabled || p.bound) : [];
    if (!list.length) {
      box.innerHTML = '<p class="muted small" style="margin:0">管理员尚未开启第三方登录。</p>';
      return;
    }
    box.innerHTML = list.map((p) => {
      let label = p.bound ? '已绑定' + (p.boundName ? '（' + escapeHtml(p.boundName) + '）' : '') : '未绑定';
      if (!p.enabled) label += '（该方式已停用）';
      let act = '';
      if (p.bound) {
        act = '<button class="btn small" type="button" data-oauth-unbind="' + escapeHtml(p.id) + '">解绑</button>';
      } else if (p.enabled) {
        act = '<button class="btn small primary" type="button" data-oauth-bind="' + escapeHtml(p.id) + '">绑定</button>';
      }
      return '<div class="row-between" style="padding:8px 0;border-bottom:1px solid var(--hairline,#eee)">'
        + '<div style="display:flex;align-items:center;gap:8px"><img src="' + escapeHtml(p.logo) + '" alt="" style="width:18px;height:18px;border-radius:4px;object-fit:contain">'
        + '<div><div>' + escapeHtml(p.name) + '</div><div class="muted small">' + label + '</div></div></div>'
        + '<div>' + act + '</div></div>';
    }).join('');
  }
  async function loadAccountOauth() {
    try {
      const r = await api('/api/me/oauth');
      const d = await r.json();
      if (r.ok) renderAccountOauth(d);
    } catch (e) { /* 忽略 */ }
  }
  // 暴露给 renderUser(用户信息加载完成后联动刷新)
  window.OCAccountOauth = loadAccountOauth;
  const oauthList = $('acc-oauth-list');
  if (oauthList) {
    oauthList.addEventListener('click', async (e) => {
      const bindBtn = e.target.closest('[data-oauth-bind]');
      if (bindBtn) {
        // 绑定:先带登录态换一次性绑定票据,再跳授权端点(导航请求不带 Bearer 头,票据即身份证明)
        const pid = bindBtn.getAttribute('data-oauth-bind');
        const uid = (state.user && state.user.id) ? state.user.id : '';
        try {
          bindBtn.disabled = true;
          const r = await api('/api/auth/oauth/bind-ticket', { method: 'POST', body: JSON.stringify({ provider: pid }) });
          const d = await readJsonSafe(r);
          if (!r.ok || !d.ticket) throw new Error((d.error && d.error.message) || '获取绑定票据失败');
          location.href = '/auth/' + encodeURIComponent(pid) + '?bind=' + encodeURIComponent(uid) + '&t=' + encodeURIComponent(d.ticket);
        } catch (err) {
          bindBtn.disabled = false;
          toast('发起绑定失败：' + ((err && err.message) || '未知错误'), true);
        }
        return;
      }
      const unbindBtn = e.target.closest('[data-oauth-unbind]');
      if (!unbindBtn) return;
      const id = unbindBtn.getAttribute('data-oauth-unbind');
      unbindBtn.disabled = true;
      try {
        const r = await api('/api/me/oauth/' + encodeURIComponent(id), { method: 'DELETE' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((d.error && d.error.message) || '解绑失败');
        toast('已解绑');
        loadAccountOauth();
      } catch (err) {
        unbindBtn.disabled = false;
        toast(err.message || '解绑失败', true);
      }
    });
    loadAccountOauth();
  }

  // 余量明细:逐笔展示额度增减,分页 + 滚动加载
  let quotaLedgerOffset = 0;
  let quotaLedgerLoading = false;
  let quotaLedgerTotal = 0;      // 服务端报告的总条数(用于判断是否还有下一页)
  let quotaLedgerMax = 300;      // 自动加载的条数上限,超过后只允许手动继续,避免长列表拖慢页面
  const QUOTA_PAGE = 30;
  function quotaEntryHtml(e) {
    const amt = Number(e.amount) || 0;
    const sign = amt > 0 ? '+' : '';
    const cls = amt > 0 ? 'color:#16a34a' : (amt < 0 ? 'color:#dc2626' : '');
    const when = e.createdAt ? new Date(e.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const flow = (typeof e.before === 'number' && typeof e.after === 'number')
      ? '<span class="muted small">' + e.before + ' → ' + e.after + '</span>' : '';
    return '<div class="row-between" style="padding:8px 0;border-bottom:1px solid var(--hairline,#eee);gap:10px">'
      + '<div style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(e.title || '额度变化') + '</div>'
      + '<div class="muted small">' + when + '</div></div>'
      + '<div style="text-align:right;white-space:nowrap"><b style="' + cls + '">' + sign + amt + '</b><br>' + flow + '</div></div>';
  }
  // 余量明细:分页拉取 + 滚动到底自动加载。
  // 台账可能积累上万条,一次性渲染会卡死页面:这里每页 30 条,并且给自动加载设条数上限,
  // 超过上限后停止自动加载(改为手动按钮),保证长期使用也不会越滚越卡。
  async function loadQuotaLedger(reset) {
    const box = $('usage2-quota-list');
    if (!box) return;
    if (quotaLedgerLoading) return;
    quotaLedgerLoading = true;
    if (reset) { quotaLedgerOffset = 0; box.innerHTML = '<p class="muted small">加载中…</p>'; }
    try {
      const r = await api('/api/me/quota/ledger?limit=' + QUOTA_PAGE + '&offset=' + quotaLedgerOffset);
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || '加载失败');
      const rows = Array.isArray(d.entries) ? d.entries : [];
      if (reset) box.innerHTML = '';
      if (!rows.length && quotaLedgerOffset === 0) {
        box.innerHTML = '<p class="muted small">暂无记录。</p>';
      } else {
        box.insertAdjacentHTML('beforeend', rows.map(quotaEntryHtml).join(''));
      }
      quotaLedgerOffset += rows.length;
      const sum = $('usage2-quota-summary');
      if (sum && typeof d.gained === 'number') {
        sum.textContent = '当前余额 ' + d.quota + ' · 累计获得 ' + d.gained + ' · 累计消耗 ' + d.spent
          + '（逐笔记录含生成标题、跟进建议等辅助调用）';
      }
      const total = d.total || 0;
      quotaLedgerTotal = total;
      const overflow = quotaLedgerOffset >= quotaLedgerMax && quotaLedgerOffset < total;
      const moreWrap = $('usage2-quota-more-wrap');
      if (moreWrap) {
        moreWrap.style.display = overflow ? '' : 'none';
        const moreBtn = $('usage2-quota-more');
        if (moreBtn && overflow) moreBtn.textContent = '已加载 ' + quotaLedgerOffset + ' / ' + total + ' 条，继续加载';
      }
    } catch (e) {
      if (reset) box.innerHTML = '<p class="muted small">加载失败：' + escapeHtml(e.message || '') + '</p>';
    } finally {
      quotaLedgerLoading = false;
    }
  }
  // 滚动进入视口即自动加载下一页(达到上限后不再自动触发)
  const quotaSentinel = $('usage2-quota-sentinel');
  if (quotaSentinel && typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        if (quotaLedgerOffset >= quotaLedgerMax) return;
        if (quotaLedgerOffset >= quotaLedgerTotal) return;
        loadQuotaLedger(false);
      });
    }, { rootMargin: '120px' });
    io.observe(quotaSentinel);
  }
  const moreBtn = $('usage2-quota-more');
  if (moreBtn) moreBtn.addEventListener('click', () => {
    // 手动继续:同时放宽上限,否则点一次就又被卡住
    quotaLedgerMax += QUOTA_PAGE * 5;
    loadQuotaLedger(false);
  });
  window.OCLoadQuotaLedger = loadQuotaLedger;
  if ($('sp-usage2')) {
    loadQuotaLedger(true);
  }

  function chatToMarkdown(c) {
    const lines = ['# ' + ((c && c.title) || '未命名对话'), ''];
    ((c && c.messages) || []).forEach((m) => {
      if (!m || m.error) return;
      const text = stripInterruptMarks(m.content);
      if (!text) return;
      const who = m.role === 'user' ? '用户' : ('AI' + (m.model ? ' · ' + m.model : ''));
      lines.push('## ' + who, '', text, '');
    });
    return lines.join('\n');
  }

  const exportCurrent = $('chat-export-md');
  if (exportCurrent) exportCurrent.addEventListener('click', () => {
    const chat = currentChat();
    if (!chat || !(chat.messages || []).some((m) => m && String(m.content || '').trim() && !m.error)) {
      return toast('当前对话没有可导出的内容', true);
    }
    const name = String(chat.title || '当前对话').replace(/[\\/:*?"<>|]+/g, ' ').trim() || '当前对话';
    window.OCUI && window.OCUI.download(name + '.md', chatToMarkdown(chat), 'text/markdown');
    toast('已导出当前对话');
  });

  const exportMd = $('acc-export-md');
  if (exportMd) exportMd.addEventListener('click', () => {
    if (!state.chats.length) return toast('暂无对话可导出');
    const lines = [];
    state.chats.forEach((c) => {
      lines.push('# ' + c.title, '');
      (c.messages || []).forEach((m) => {
        if (m.error) return;
        lines.push('## ' + (m.role === 'user' ? '用户' : 'AI'), '', m.content || '', '');
      });
    });
    window.OCUI && window.OCUI.download('chat-export-' + Date.now() + '.md', lines.join('\n'), 'text/markdown');
    toast('已导出 Markdown');
  });

  const exportJson = $('acc-export-json');
  if (exportJson) exportJson.addEventListener('click', () => {
    if (!state.chats.length) return toast('暂无对话可导出');
    const payload = { exportedAt: new Date().toISOString(), user: state.user ? state.user.name : '', chats: state.chats };
    window.OCUI && window.OCUI.download('chat-backup-' + Date.now() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('已导出 JSON 备份');
  });

  const importJson = $('acc-import-json');
  if (importJson) importJson.addEventListener('click', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      let raw = '';
      try { raw = await file.text(); } catch (e) { return toast('读取文件失败', true); }
      let data;
      try { data = JSON.parse(raw); } catch (e) { return toast('不是有效的 JSON 备份', true); }
      const incoming = Array.isArray(data) ? data : (data && data.chats);
      if (!Array.isArray(incoming) || !incoming.length) return toast('备份里没有对话', true);
      const imported = window.OCConversations.normalize(incoming).map((c) => {
        const copy = Object.assign({}, c);
        copy.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        copy.updatedAt = Date.now();
        return copy;
      });
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '导入对话', message: '将导入 ' + imported.length + ' 段对话，与现有记录合并，不会覆盖原对话。确定继续吗？', confirmText: '导入' })
        : confirm('将导入 ' + imported.length + ' 段对话，确定继续吗？');
      if (!ok) return;
      state.chats = imported.concat(state.chats || []);
      if (!state.currentChatId && state.chats[0]) state.currentChatId = state.chats[0].id;
      saveChats();
      renderChatList();
      renderMessages();
      toast('已导入 ' + imported.length + ' 段对话');
    });
    picker.click();
  });

  const clearChats = $('acc-clear-chats');
  if (clearChats) clearChats.addEventListener('click', async () => {
    if (!state.chats.length) return toast('没有可清空的聊天记录');
    const ok = window.OCUI
      ? await window.OCUI.confirm({ title: '清空聊天记录', message: '将从本机与云端删除全部对话,所有设备同步清空。确定继续吗?', danger: true, confirmText: '清空' })
      : confirm('将从本机与云端删除全部对话,所有设备同步清空。确定继续吗?');
    if (!ok) return;
    try {
      const r = await api('/api/sync/chats', { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('sync failed');
      state.chats = [];
      state.currentChatId = null;
      state.chatRevision = Number(data.revision) || (Number(state.chatRevision) || 0) + 1;
      // 服务端已把全部对话归档并立墓碑:本端待推送删除随即作废
      state.deletedIds = [];
      state._deletedCopies = {};
      persistTombstones();
      persistDeletedCopies();
      window.OCStore.set(chatsKey(), '[]');
      localStorage.setItem('oc_chat_rev_' + state.user.id, String(state.chatRevision));
      renderChatList();
      renderMessages();
      toast('已清空全部对话');
    } catch (e) {
      toast('清空失败: ' + e.message, true);
    }
  });

  const accLogout = $('acc-logout');
  if (accLogout) accLogout.addEventListener('click', logout);
})();

// ============ 顶栏导出当前对话 ============
// (index.html 当前没有导出入口,保留函数化能力时再挂载)

function renderProviderList() {
  const list = $('provider-list');
  list.innerHTML = '';
  state.providers.forEach((p) => {
    // 汇总 ID 是「模型」而不是供应商:它出现在模型选择器里,但不属于用户的供应商管理列表
    if (p.agg) return;
    const card = document.createElement('div');
    card.className = 'provider-card';
    const isOwner = p.mine || p.ownerId === state.user.id;
    const isDefault = p.id === state.defaultProviderId;
    const badges = [];
    if (p.scope === 'global') badges.push('<span class="badge global">管理员</span>');
    if (isDefault) badges.push('<span class="badge default">默认</span>');
    if (isOwner) badges.push('<span class="badge user">我的</span>');
    // 普通用户不显示全局供应商的网址（管理员配置的接口地址应隐藏，只显示名称）
    const isAdmin = !!state.user.admin;
    const showUrl = isOwner || isAdmin;
    const urlText = showUrl ? p.baseUrl : '';
    // 只有平台计费的全局供应商才需要展示扣费;自己的 Key 不扣次数,不必说明
    const costText = isOwner ? '' : '每次调用扣 ' + p.costPerCall + ' 次';
    const urlParts = [urlText, p.apiFormat, costText].filter(Boolean).map((x) => escapeHtml(x));
    const urlHtml = urlParts.length ? '<div class="pc-url">' + urlParts.join(' · ') + '</div>' : '';
    let keyHtml = '';
    if (isOwner && p.hasKey && p.keyRevealable) {
      // 仅在属主勾选了「保存后保持显示」时展示遮罩 Key + 小眼睛
      keyHtml = '<div class="pc-key">Key: <span class="pc-key-value" data-key-value="' + p.id + '" data-masked="' + escapeHtml(p.apiKey || '••••••') + '">' + escapeHtml(p.apiKey || '••••••') + '</span>'
        + '<button class="pc-key-eye" data-reveal="' + p.id + '" type="button" title="显示 Key" aria-label="显示 Key">' + window.OC.icon('eye', 13) + '</button></div>';
    }
    card.innerHTML = `
      <div class="pc-info">
        <div class="pc-name">${escapeHtml(p.name)} ${badges.join('')}</div>
        ${urlHtml}
        ${keyHtml}
      </div>
      <div class="provider-card-actions" style="display:flex;gap:6px;flex-shrink:0">
        ${isOwner ? '<button class="btn small" data-edit="' + p.id + '">编辑</button><button class="btn small" data-test-provider="' + p.id + '">测试</button><button class="btn small" data-test-all-provider="' + p.id + '">批量测试</button><button class="btn small danger" data-del="' + p.id + '">删除</button>' : ''}
      </div>`;
    card.querySelector('[data-edit]')?.addEventListener('click', () => openProviderEdit(p));
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
        const key = await revealProviderKey(p.id);
        span.textContent = key;
        span.setAttribute('data-revealed', '1');
        btn.innerHTML = window.OC.icon('eyeOff', 13);
        btn.title = '隐藏 Key';
      } catch (err) {
        toast(err.message || '无法查看 Key', true);
      } finally {
        btn.disabled = false;
      }
    });
    card.querySelector('[data-test-provider]')?.addEventListener('click', () => openProviderTest(p));
    card.querySelector('[data-test-all-provider]')?.addEventListener('click', () => openProviderTest(p, true));
    card.querySelector('[data-del]')?.addEventListener('click', async (e) => {
      const ok = window.OCUI
        ? await window.OCUI.confirm({ title: '删除供应商', message: '确认删除该供应商？', danger: true, confirmText: '删除' })
        : confirm('确认删除该供应商？');
      if (!ok) return;
      const r = await api('/api/providers/' + encodeURIComponent(p.id), { method: 'DELETE' });
      if (r.ok) {
        if (providerEditingId === p.id) resetProviderForm();
        toast('已删除'); await loadProviders(); renderProviderList();
      }
      else toast('删除失败', true);
    });
    list.appendChild(card);
  });
  if (!state.providers.length) list.innerHTML = '<p class="muted small">暂无供应商，请添加或等待管理员配置</p>';
}

// ============ 供应商编辑 / Key 查看 ============
let providerEditingId = null;
let providerEditingRevealable = false;
const PROVIDER_FORMAT_LABELS = {
  chat: 'OpenAI chat/completions',
  responses: 'OpenAI responses',
  completions: 'OpenAI completions',
  anthropic: 'Anthropic messages',
};
async function revealProviderKey(providerId) {
  const r = await api('/api/providers/' + encodeURIComponent(providerId) + '/key', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '无法查看 Key');
  return String(data.key || '');
}
function resetProviderForm() {
  providerEditingId = null;
  providerEditingRevealable = false;
  $('p-name').value = '';
  $('p-baseurl').value = '';
  $('p-key').value = '';
  $('p-key').type = 'password';
  setPKeyVisibility(false);
  $('p-key').placeholder = 'sk-...';
  if ($('p-key-keep')) $('p-key-keep').checked = true;
  const fmt = $('p-format');
  fmt.setAttribute('data-value', 'chat');
  const fmtLabel = fmt.querySelector('.sb-label');
  if (fmtLabel) fmtLabel.textContent = PROVIDER_FORMAT_LABELS.chat;
  if (pModelList) pModelList.reset();
  const summary = $('provider-form-summary');
  if (summary) summary.textContent = '+ 添加自定义供应商';
  $('p-save').textContent = '保存供应商';
  $('p-cancel')?.classList.add('hidden');
}
function openProviderEdit(p) {
  const wrap = $('provider-form-wrap');
  if (wrap && !wrap.open) wrap.open = true;
  providerEditingId = p.id;
  providerEditingRevealable = !!p.keyRevealable;
  $('p-name').value = p.name || '';
  $('p-baseurl').value = p.baseUrl || '';
  $('p-key').value = '';
  $('p-key').type = 'password';
  setPKeyVisibility(false);
  $('p-key').placeholder = p.hasKey
    ? (p.keyRevealable ? ('已保存 ' + (p.apiKey || '') + '，留空保持不变') : '已加密保存，不可查看；更换请输入新 Key')
    : 'sk-...';
  if ($('p-key-keep')) $('p-key-keep').checked = !!p.keyRevealable;
  const fmt = $('p-format');
  fmt.setAttribute('data-value', p.apiFormat || 'chat');
  const fmtLabel = fmt.querySelector('.sb-label');
  if (fmtLabel) fmtLabel.textContent = PROVIDER_FORMAT_LABELS[p.apiFormat] || p.apiFormat || 'OpenAI chat/completions';
  if (pModelList) pModelList.setEnabled(p.models || []);
  const summary = $('provider-form-summary');
  if (summary) summary.textContent = '编辑供应商';
  $('p-save').textContent = '保存修改';
  $('p-cancel')?.classList.remove('hidden');
  $('p-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('p-name').focus(), 350);
}

let providerTestProvider = null;
let providerTestBatch = false;
let providerTestAbort = null;
let providerTestPassedModels = [];
let providerTestFailedModels = [];
function providerTestModels(provider) {
  return (provider && Array.isArray(provider.models) ? provider.models : []).map((m) => ({
    value: m.id,
    label: m.name || m.id,
    sub: m.name && m.name !== m.id ? m.id : '',
  })).filter((m) => m.value);
}
function setProviderTestModel(value) {
  const box = $('provider-test-model');
  if (!box) return;
  box.setAttribute('data-value', value || '');
  const choice = providerTestModels(providerTestProvider).find((m) => m.value === value);
  const lab = box.querySelector('.sb-label');
  if (lab) lab.textContent = choice ? choice.label : '选择模型';
}
function renderProviderTestResult(row, append) {
  const out = $('provider-test-result');
  if (!out) return;
  const ok = !!(row && row.ok);
  if (!append) out.innerHTML = '';
  out.classList.remove('hidden');
  const item = document.createElement('div');
  item.className = 'provider-test-result-item ' + (ok ? 'ok' : 'bad');
  item.innerHTML = '<div class="provider-test-result-title">' + escapeHtml(ok ? '测试成功' : '测试失败') + ' · ' + escapeHtml((row && row.model) || '') + '</div>'
    + '<div class="provider-test-result-meta">' + escapeHtml(String((row && row.ms) || 0)) + ' ms</div>'
    + '<div class="provider-test-result-text">' + escapeHtml(ok ? ((row && row.reply) || '已响应') : ((row && row.error) || '无回复')) + '</div>';
  out.appendChild(item);
}
function setProviderTestBusy(on) {
  const run = $('provider-test-run');
  const stop = $('provider-test-stop');
  const model = $('provider-test-model');
  if (run) run.disabled = on;
  if (model) model.classList.toggle('disabled', on);
  if (stop) stop.hidden = !on;
}
async function requestProviderTest(model) {
  model = model || ($('provider-test-model') && $('provider-test-model').getAttribute('data-value'));
  const prompt = ($('provider-test-prompt') && $('provider-test-prompt').value.trim()) || '回复一个字：好';
  if (!providerTestProvider || !model) throw new Error('请选择要测试的模型');
  providerTestAbort = new AbortController();
  const r = await api('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: providerTestProvider.id, model, prompt }),
    signal: providerTestAbort.signal,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '测试失败');
  return data.result || { ok: false, model, error: '无测试结果' };
}
async function removeUnavailableProviderModels() {
  if (!providerTestProvider || !providerTestFailedModels.length) return;
  const keep = providerTestModels(providerTestProvider)
    .filter((m) => providerTestPassedModels.indexOf(m.value) >= 0)
    .map((m) => ({ id: m.value, name: m.label }));
  if (!keep.length) return toast('没有可保留的可用模型', true);
  const ok = window.OCUI
    ? await window.OCUI.confirm({ title: '移除不可用模型', message: '将保留 ' + keep.length + ' 个可用模型，移除 ' + providerTestFailedModels.length + ' 个不可用模型。确定继续吗？', danger: true, confirmText: '移除并保存' })
    : confirm('确认移除不可用模型并保存？');
  if (!ok) return;
  const r = await api('/api/providers/' + encodeURIComponent(providerTestProvider.id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models: keep }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || '保存失败');
  providerTestProvider.models = keep;
  providerTestFailedModels = [];
  $('provider-test-remove-bad')?.classList.add('hidden');
  toast('已移除不可用模型，保留 ' + keep.length + ' 个');
  await loadProviders();
  renderProviderList();
}
function openProviderTest(provider, batch) {
  providerTestProvider = provider;
  providerTestBatch = !!batch;
  const target = $('provider-test-target');
  if (target) target.textContent = (provider.name || '个人供应商') + (providerTestBatch ? ' · 批量测试全部已保存模型' : ' · 不扣站内额度');
  const models = providerTestModels(provider);
  setProviderTestModel(models[0] ? models[0].value : '');
  if ($('provider-test-prompt')) $('provider-test-prompt').value = '回复一个字：好';
  if ($('provider-test-status')) $('provider-test-status').textContent = '';
  providerTestPassedModels = [];
  providerTestFailedModels = [];
  if ($('provider-test-result')) { $('provider-test-result').innerHTML = ''; $('provider-test-result').classList.add('hidden'); }
  const removeBad = $('provider-test-remove-bad');
  if (removeBad) removeBad.classList.add('hidden');
  $('provider-test-use')?.classList.add('hidden');
  const run = $('provider-test-run');
  if (run) run.textContent = providerTestBatch ? '开始批量测试' : '开始测试';
  if (window.OCUI) window.OCUI.openModal($('provider-test-modal'));
}
(function initProviderTest() {
  const modal = $('provider-test-modal');
  if (!modal) return;
  if (window.OCUI) window.OCUI.bindModal(modal, { closeId: 'provider-test-close', maskClose: false, onClose: () => {
    if (providerTestAbort) providerTestAbort.abort();
    providerTestAbort = null;
    setProviderTestBusy(false);
  }});
  const model = $('provider-test-model');
  if (model) {
    model.addEventListener('click', () => {
      if (model.classList.contains('disabled')) return;
      const choices = providerTestModels(providerTestProvider);
      if (!choices.length) return toast('该供应商没有已保存模型', true);
      OC.openSelect(model, choices, { selected: model.getAttribute('data-value') || '', onSelect: setProviderTestModel });
    });
    model.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); model.click(); }
    });
  }
  const close = () => { if (window.OCUI) window.OCUI.closeModal(modal); };
  $('provider-test-cancel')?.addEventListener('click', close);
  $('provider-test-stop')?.addEventListener('click', () => { if (providerTestAbort) providerTestAbort.abort(); });
  $('provider-test-remove-bad')?.addEventListener('click', async () => {
    try { await removeUnavailableProviderModels(); } catch (e) { toast(e.message || '保存失败', true); }
  });
  $('provider-test-use')?.addEventListener('click', async () => {
    if (!providerTestProvider || !providerTestPassedModels.length) return toast('请先完成一次成功的测试', true);
    const model = providerTestPassedModels[providerTestPassedModels.length - 1];
    state.currentProviderId = providerTestProvider.id;
    await loadModels({ prefer: model });
    renderProviderLabel();
    close();
    toast('已切换为对话模型：' + providerTestProvider.name + '@' + model);
  });
  $('provider-test-run')?.addEventListener('click', async () => {
    const status = $('provider-test-status');
    const models = providerTestModels(providerTestProvider);
    if (!models.length) return toast('该供应商没有已保存模型', true);
    setProviderTestBusy(true);
    if (status) status.textContent = providerTestBatch ? '准备批量测试…' : '正在请求上游…';
    let passed = 0;
    let tested = 0;
    try {
      const queue = providerTestBatch ? models : [models.find((m) => m.value === (($('provider-test-model') && $('provider-test-model').getAttribute('data-value')) || '')) || models[0]];
      if ($('provider-test-result')) { $('provider-test-result').innerHTML = ''; $('provider-test-result').classList.remove('hidden'); }
      for (const item of queue) {
        if (providerTestBatch && status) status.textContent = '正在测试 ' + (tested + 1) + ' / ' + queue.length + ' · ' + item.label;
        setProviderTestModel(item.value);
        let row;
        try {
          row = await requestProviderTest(item.value);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          row = { ok: false, model: item.value, ms: 0, error: e.message || '测试失败' };
        }
        tested++;
        if (row.ok) {
          passed++;
          if (providerTestPassedModels.indexOf(item.value) < 0) providerTestPassedModels.push(item.value);
        } else if (providerTestFailedModels.indexOf(item.value) < 0) {
          providerTestFailedModels.push(item.value);
        }
        renderProviderTestResult(row, providerTestBatch || tested > 1);
      }
      if (providerTestBatch && providerTestFailedModels.length) $('provider-test-remove-bad')?.classList.remove('hidden');
      if (passed) $('provider-test-use')?.classList.remove('hidden');
      if (status) status.textContent = providerTestBatch ? ('完成 · 可用 ' + passed + ' / ' + tested) : (passed ? '供应商可用' : '供应商返回异常');
    } catch (e) {
      if (e.name === 'AbortError') {
        if (status) status.textContent = '已停止 · 已完成 ' + tested + ' 个';
      } else {
        if (status) status.textContent = '';
        toast(e.message || '测试失败', true);
      }
    } finally {
      providerTestAbort = null;
      setProviderTestBusy(false);
    }
  });
})();
function maskKey(k) {
  if (!k || k.length <= 8) return k ? '••••' : '（管理员密钥，不显示）';
  return k.slice(0, 4) + '••••••' + k.slice(-4);
}

// API 格式自定义选择
(function initFormatSelect() {
  const box = $('p-format');
  if (!box) return;
  const FORMATS = [
    { value: 'chat', label: 'OpenAI chat/completions', sub: '对话接口 /v1/chat/completions（常用）' },
    { value: 'responses', label: 'OpenAI responses', sub: '新版接口 /v1/responses' },
    { value: 'completions', label: 'OpenAI completions', sub: '旧版补全 /v1/completions' },
    { value: 'anthropic', label: 'Anthropic messages', sub: 'Claude 消息接口 /v1/messages' },
  ];
  const setLabel = () => {
    const v = box.getAttribute('data-value');
    const f = FORMATS.find((x) => x.value === v);
    box.querySelector('.sb-label').textContent = f ? f.label : v;
  };
  box.addEventListener('click', () => {
    OC.openSelect(box, FORMATS.map((f) => ({ value: f.value, label: f.label, sub: f.sub })), {
      selected: box.getAttribute('data-value'),
      onSelect: (val) => { box.setAttribute('data-value', val); setLabel(); },
    });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
  });
})();

const pModelList = window.OC && window.OC.bindModelChecklist
  ? window.OC.bindModelChecklist({
    listId: 'p-models-list',
    queryId: 'p-model-q',
    allId: 'p-models-all',
    countId: 'p-models-count',
    addId: 'p-model-add',
    // 自建供应商用自己的 Key,不扣站点次数,不展示「单次扣减」列
    showCost: false,
  })
  : null;

const pFetchBtn = $('p-fetch-models');
if (pFetchBtn) {
  pFetchBtn.addEventListener('click', async () => {
    const baseUrl = $('p-baseurl').value.trim();
    const apiKey = $('p-key').value.trim();
    const apiFormat = $('p-format').getAttribute('data-value') || 'chat';
    if (!baseUrl) { toast('请先填写 Base URL', true); return; }
    // 编辑已有供应商时 Key 允许留空(保持原 Key):带上 providerId 让服务端回退用存储的密钥
    if (!apiKey && !providerEditingId) { toast('请先填写 API Key', true); return; }
    pFetchBtn.disabled = true;
    pFetchBtn.textContent = '获取中…';
    try {
      const r = await api('/api/proxy/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, apiFormat, providerId: providerEditingId || undefined }),
      });
      // 上游或服务器异常时可能返回 HTML 错误页,直接 .json() 会抛 "Unexpected token '<'",
      // 这里改为先取文本再尝试解析,给出可读提示
      const data = await readJsonSafe(r);
      if (!r.ok) { toast((data.error && data.error.message) || ('获取失败（HTTP ' + r.status + '）'), true); return; }
      const models = data.models || [];
      if (!models.length) { toast('上游未返回模型', true); return; }
      if (window.OC && window.OC.openFetchedModelsModal) {
        window.OC.openFetchedModelsModal(models, {
          title: '获取到的模型',
          existing: pModelList ? pModelList.getCatalog() : [],
          showCost: false, // 自建供应商不扣费,不展示「单次扣减」列
          onApply: (picked, staleIds) => {
            if (pModelList) pModelList.applyFetched(picked, staleIds);
            const n = picked.filter((m) => m.enabled).length;
            const cleared = (staleIds || []).length;
            toast('已应用 ' + n + ' 个启用模型' + (cleared ? '，清除 ' + cleared + ' 个失效模型' : '') + '，保存后生效');
          },
        });
      } else if (pModelList) {
        pModelList.setFromFetch(models);
        toast('已获取 ' + models.length + ' 个模型，勾选后保存即可启用');
      }
    } catch (e) {
      toast('获取失败: ' + e.message, true);
    } finally {
      pFetchBtn.disabled = false;
      pFetchBtn.textContent = '获取列表';
    }
  });
}

const pKeyInput = $('p-key');
const pKeyToggle = $('p-key-toggle');
function setPKeyVisibility(visible) {
  if (!pKeyInput || !pKeyToggle) return;
  pKeyInput.type = visible ? 'text' : 'password';
  pKeyToggle.innerHTML = window.OC.icon(visible ? 'eyeOff' : 'eye', 14);
  pKeyToggle.title = visible ? '隐藏 Key' : '显示 Key';
  pKeyToggle.setAttribute('aria-label', pKeyToggle.title);
}
if (pKeyInput && pKeyToggle) pKeyToggle.addEventListener('click', async () => {
  // 编辑模式且输入框为空:点小眼睛取回服务器上已保存的 Key(仅限勾选了「保存后保持显示」的供应商)
  if (providerEditingId && pKeyInput.value.trim() === '') {
    if (!providerEditingRevealable) {
      toast('该 Key 保存时未勾选「保存后保持显示」，无法查看', true);
      return;
    }
    try {
      pKeyToggle.disabled = true;
      const key = await revealProviderKey(providerEditingId);
      pKeyInput.value = key;
      setPKeyVisibility(true);
    } catch (e) {
      toast(e.message || '无法查看 Key', true);
    } finally {
      pKeyToggle.disabled = false;
    }
    return;
  }
  setPKeyVisibility(pKeyInput.type !== 'text');
  pKeyInput.focus();
});

$('p-save').addEventListener('click', async () => {
  const name = $('p-name').value.trim();
  const baseUrl = $('p-baseurl').value.trim();
  const apiKey = $('p-key').value.trim();
  const apiFormat = $('p-format').getAttribute('data-value') || 'chat';
  const keyRevealable = !!(($('p-key-keep') && $('p-key-keep').checked));
  const editing = !!providerEditingId;
  if (!baseUrl) { toast('请填写 Base URL', true); return; }
  if (!editing && !apiKey) { toast('请填写 API Key', true); return; }
  const models = pModelList ? pModelList.getEnabled() : [];
  if (!models.length) { toast('请先获取模型并至少勾选一个', true); return; }

  // 自建供应商不扣费(用自己的 Key),因此不提交 costPerCall:服务端保留原值(默认 1),
  // 而计费路径对 ownerId 命中的供应商一律按 0 计(见 lib/proxy.php)。
  const payload = { name, baseUrl, apiFormat, models, keyRevealable };
  if (!editing || apiKey) payload.apiKey = apiKey;
  const r = await api(editing ? '/api/providers/' + encodeURIComponent(providerEditingId) : '/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) { toast((data.error && data.error.message) || '保存失败', true); return; }
  toast(editing ? '已保存修改' : '供应商已添加');
  resetProviderForm();
  await loadProviders();
  renderProviderList();
});
$('p-cancel')?.addEventListener('click', () => resetProviderForm());

// ============ 事件绑定 ============
const redeemBtn = $('plan-redeem-btn');
if (redeemBtn) redeemBtn.addEventListener('click', async () => {
  try {
    const code = ($('plan-redeem-code') && $('plan-redeem-code').value || '').trim();
    if (!code) return toast('请输入兑换码', true);
    const r = await api('/api/packages/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (!r.ok) return toast((d.error && d.error.message) || '兑换失败', true);
    if (d.user) state.user = d.user;
    if ($('plan-redeem-code')) $('plan-redeem-code').value = '';
    renderUser(); renderAccountPanel(); toast('兑换成功');
  } catch (e) { toast('兑换失败，请检查网络连接', true); }
});
const goPlanBtn = $('acc-go-plan');
if (goPlanBtn) goPlanBtn.addEventListener('click', () => switchSettingsTab('plan'));
$('send-btn').addEventListener('click', sendMessage);
$('stop-btn').addEventListener('click', stopStreaming);
$('new-chat-btn').addEventListener('click', newChat);
const composerAt = $('composer-assistant');
if (composerAt) {
  composerAt.addEventListener('click', () => {
    if (window.OCAssistants && typeof window.OCAssistants.open === 'function') window.OCAssistants.open();
  });
}
// 退出登录已移入「设置 → 账户」(见 sp-account 里的 acc-logout 绑定)
$('admin-link').addEventListener('click', () => location.href = apiUrl('/admin'));

// ============ 全站公告 ============
(function initAnnouncement() {
  // PWA 的 service worker 注册已提前到 theme-boot.js(head 内,静态资源更早进入离线缓存)
  const modal = $('announce-modal');
  if (!modal) return;
  let current = null;
  function markSeen() {
    const t = current && current.updatedAt ? current.updatedAt : Date.now();
    try { localStorage.setItem('oc_announcement_seen', String(t)); } catch (e) {}
    syncTouch('announcementSeen');
  }
  function showAnnouncement(ann) {
    if (!ann || !ann.text) return;
    current = ann;
    const txt = $('announce-text');
    if (txt) {
      // 公告支持 Markdown 与内联 HTML(经渲染器统一清洗),便于富文本排版
      const raw = String(ann.text);
      let html = '';
      if (window.OCRenderer && window.OCRenderer.render) {
        try { html = window.OCRenderer.render(raw); } catch (e) { html = ''; }
      }
      if (!html) html = escapeHtml(raw).replace(/\n/g, '<br>');
      txt.innerHTML = html;
    }
    const title = $('announce-title');
    if (title) title.textContent = ann.title || '公告';
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(modal);
    else modal.classList.remove('hidden');
  }
  function closeAnnouncement() {
    if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(modal);
    else modal.classList.add('hidden');
  }
  if (window.OCUI && window.OCUI.bindModal) {
    window.OCUI.bindModal(modal, {
      closeId: 'announce-close',
      closeSelector: '#announce-ok',
      onClose: markSeen,
    });
  } else {
    $('announce-close') && $('announce-close').addEventListener('click', () => { closeAnnouncement(); markSeen(); });
    $('announce-ok') && $('announce-ok').addEventListener('click', () => { closeAnnouncement(); markSeen(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) { closeAnnouncement(); markSeen(); } });
  }
  window.OCShowAnnouncement = () => {
    // 用户菜单里的「公告」入口:总是展示最新公告,不写已读
    showAnnouncement(current || { text: '', updatedAt: 0 });
    if (current) return true;
    return false;
  };
  window.OCGetAnnouncement = () => current;
  fetch(apiUrl('/api/config')).then((r) => r.json()).then((cfg) => {
    state.config = cfg || {};
    // 注销入口按后台设置显隐(该配置在打开设置面板时才用得到,这里顺带刷新)
    if (window.OCRefreshDeleteAccount) window.OCRefreshDeleteAccount();
    // 第三方账号绑定回跳:提示结果并刷新绑定列表
    if (location.hash.indexOf('oauth_bound=') >= 0) {
      const pid = decodeURIComponent((location.hash.split('oauth_bound=')[1] || '').split('&')[0]);
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 忽略 */ }
      setTimeout(() => toast('已绑定第三方账号' + (pid ? '：' + pid : '')), 500);
    }
    const ann = cfg && cfg.announcement;
    // 自动弹出:公告启用且内容比上次已读更新时
    if (!ann || !ann.enabled || !ann.text) {
      const menuBtn = $('user-menu-announce');
      if (menuBtn) { menuBtn.hidden = true; menuBtn.classList.add('hidden'); }
      return;
    }
    current = ann;
    const menuBtn = $('user-menu-announce');
    if (menuBtn) { menuBtn.hidden = false; menuBtn.classList.remove('hidden'); }
    const seen = Number(localStorage.getItem('oc_announcement_seen')) || 0;
    if (ann.updatedAt && ann.updatedAt <= seen) return;
    showAnnouncement(ann);
  }).catch(() => {});
})();

// ============ API 密钥(OpenAI 兼容出口) ============
function renderApiKeys(keys) {
  const box = $('apikey-list');
  if (!box) return;
  if (!keys.length) { box.innerHTML = '<p class="muted small" style="margin:8px 0 0">还没有 API 密钥</p>'; return; }
  box.innerHTML = keys.map((k) => {
    const last = k.lastUsed ? new Date(k.lastUsed).toLocaleString('zh-CN') : '从未使用';
    return '<div class="row-between" style="padding:6px 0;border-bottom:1px solid var(--hairline)">'
      + '<div style="min-width:0"><div>' + escapeHtml(k.name) + ' <code class="muted small">' + escapeHtml(k.prefix) + '••••</code></div>'
      + '<div class="muted small">创建于 ' + new Date(k.createdAt).toLocaleDateString('zh-CN') + ' · 最后使用 ' + last + '</div></div>'
      + '<button class="btn small danger" data-del-key="' + escapeHtml(k.id) + '" type="button">删除</button></div>';
  }).join('');
  box.querySelectorAll('[data-del-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = window.OCUI && OCUI.confirm
        ? await OCUI.confirm({ title: '删除 API 密钥', message: '使用该密钥的客户端将立即无法调用。确认删除？', danger: true, confirmText: '删除' })
        : confirm('确认删除该 API 密钥？');
      if (!ok) return;
      try {
        const r = await api('/api/me/apikeys/' + encodeURIComponent(btn.dataset.delKey), { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok) return toast((d.error && d.error.message) || '删除失败', true);
        toast('已删除'); loadApiKeys();
      } catch (e) { toast('删除失败: ' + e.message, true); }
    });
  });
}
function apiKeyLimitText(d) {
  const parts = [];
  const keyLimit = Number(d && d.keyRateLimitPerMin);
  const userLimit = Number(d && d.userRateLimitPerMin);
  const maxKeys = Number(d && d.maxKeys) || 5;
  parts.push('单密钥限流 ' + (keyLimit > 0 ? keyLimit + ' 次/分钟' : '不限'));
  if (userLimit > 0) parts.push('账号合计 ' + userLimit + ' 次/分钟');
  parts.push('最多 ' + maxKeys + ' 个密钥');
  if (d && d.exposeRestricted) parts.push('仅部分模型对开放接口开放');
  return parts.join(' · ');
}
function loadApiKeys() {
  const box = $('apikey-list');
  if (!box) return;
  api('/api/me/apikeys').then((r) => r.json()).then((d) => {
    const note = $('apikey-limit-note');
    const enabled = d.enabled !== false;
    if (note) {
      note.textContent = enabled ? ('本站限制：' + apiKeyLimitText(d)) : '管理员已关闭 API 密钥功能';
    }
    if ($('apikey-create')) $('apikey-create').disabled = !enabled;
    renderApiKeys(enabled ? (d.keys || []) : []);
    if ($('acc-api-base')) $('acc-api-base').textContent = location.origin + '/v1';
  }).catch(() => {});
}
// 关闭设置弹窗时清空"仅显示一次"的密钥框,避免下次打开仍能看到明文
function resetApiKeySecret() {
  const val = $('apikey-new-value');
  const box = $('apikey-new-box');
  if (val) val.textContent = '';
  if (box) box.classList.add('hidden');
}
(function initApiKeysUI() {
  const create = $('apikey-create');
  if (!create) return;
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const r = await api('/api/me/apikeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ($('apikey-name') && $('apikey-name').value.trim()) || '' }),
      });
      const d = await r.json();
      if (!r.ok) return toast((d.error && d.error.message) || '创建失败', true);
      const box = $('apikey-new-box');
      const val = $('apikey-new-value');
      if (box && val) { val.textContent = d.secret; box.classList.remove('hidden'); }
      const input = $('apikey-name');
      if (input) input.value = '';
      loadApiKeys();
      toast('密钥已生成，请立即复制保存');
    } catch (e) {
      toast('创建失败: ' + e.message, true);
    } finally { create.disabled = false; }
  });
  if ($('sp-apikeys') && window.MutationObserver) {
    new MutationObserver(() => { if ($('sp-apikeys').classList.contains('active')) loadApiKeys(); })
      .observe($('sp-apikeys'), { attributes: true, attributeFilter: ['class'] });
  }
})();

// ============ 空状态建议 ============
(function initEmptySuggests() {
  const wrap = $('empty-suggests');
  if (!wrap) return;
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.empty-suggest');
    if (!btn) return;
    const text = btn.getAttribute('data-q') || '';
    const input = $('input');
    if (!input || !text) return;
    input.value = text;
    autosizeInput();
    updateSendBtn();
    input.focus();
    const end = input.value.length;
    if (input.setSelectionRange) input.setSelectionRange(end, end);
  });
})();

// ============ 附件上传 ============
state.pendingAttachments = [];
// 进度变化只定点更新对应卡片,避免整块重建导致图片缩略图反复重载而闪烁
const ATTACH_ELS = new WeakMap();
function renderAttachments() {
  const box = $('attach-previews');
  box.innerHTML = '';
  state.pendingAttachments.forEach((a, idx) => {
    let el;
    if (a.type === 'image') {
      el = document.createElement('div');
      el.className = 'attach-img-preview';
      el.innerHTML = '<img src="' + a.dataUrl + '" alt="">'
        + '<button class="fc-remove" title="移除">' + window.OC.icon('close', 10) + '</button>';
    } else {
      el = document.createElement('div');
      el.className = 'file-card' + (a.parsing ? ' is-parsing' : '');
      const meta = a.meta || {};
      const size = window.OCMultimodal.formatSize(a.size);
      const status = a.parsing ? (a.parseLabel || '正在解析') : size;
      const fileName = String(a.name || '未命名文件');
      el.innerHTML = '<span class="fc-icon" style="background:' + (meta.color || '#94a3b8') + '22">' + (meta.svg || window.OC.icon('file', 15)) + '</span>'
        + '<span class="fc-info"><span class="fc-name" title="' + escapeHtml(fileName) + '">' + escapeHtml(fileName) + '</span><span class="fc-size">' + escapeHtml(status) + '</span>'
        + (a.parsing ? '<span class="fc-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + (a.parsePct || 0) + '"><span style="width:' + (a.parsePct || 8) + '%"></span></span>' : '')
        + '</span>'
        + '<button class="fc-remove">' + window.OC.icon('close', 10) + '</button>';
    }
    el.querySelector('.fc-remove').addEventListener('click', () => {
      state.pendingAttachments.splice(idx, 1);
      renderAttachments();
      updateSendBtn();
    });
    ATTACH_ELS.set(a, {
      root: el,
      fill: el.querySelector('.fc-progress > span'),
      bar: el.querySelector('.fc-progress'),
      status: el.querySelector('.fc-size'),
    });
    box.appendChild(el);
  });
}
function setParseProgress(attach, pct, label) {
  attach.parsePct = pct;
  attach.parseLabel = label;
  if (ACTIVE_PARSE_MODAL && ACTIVE_PARSE_MODAL.attach === attach) ACTIVE_PARSE_MODAL.update(pct, label);
  const els = ATTACH_ELS.get(attach);
  if (els && els.root && els.root.isConnected && els.fill) {
    if (els.bar) els.bar.setAttribute('aria-valuenow', String(pct));
    els.fill.style.width = pct + '%';
    if (els.status && label) els.status.textContent = label;
  } else {
    renderAttachments();
  }
}
// 粗略判断当前模型是否支持图片输入(多模态)。判断不准时,图片解析弹窗里仍可手动选择发送方式。
const VISION_MODEL_RE = /(vision|omni|多模态|gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|(^|[^a-z0-9])(o1|o3|o4-mini|o4)($|[^a-z0-9])|gemini|claude-(3|4|sonnet|opus|haiku)|glm-4v|glm-[0-9][0-9.]*v($|[^a-z0-9])|qwen[^ ]{0,8}(vl|qvq)|qvq|(^|[^a-z0-9])vl($|[^a-z0-9])|doubao[^ ]*vision|seed-1\.[567]|kimi-latest|kimi[^ ]*vision|moonshot[^ ]*vision|grok-(2-vision|4)|step-1v|step-1o|yi-vision|internvl|hunyuan[^ ]*vision|ernie[^ ]*(vt|vision)|pixtral|llama-3\.2[^ ]*vision|llama-?4|mistral-small-3)/i;
function modelSupportsVision() {
  const id = String(state.currentModel || '');
  const m = state.models.find((x) => x.id === id) || {};
  const s = (id + ' ' + (m.name || '')).toLowerCase();
  if (!s.trim()) return false;
  if (/o1-mini|o1-preview|deepseek-(v[23]|r\d|chat)(?![a-z]*vl)/.test(s)) return /vision|vl/.test(s);
  return VISION_MODEL_RE.test(s);
}

// MinerU 解析进度弹窗。关闭方式:取消解析 / 后台解析(遮罩与 Esc 视为后台,不打断解析)。
let ACTIVE_PARSE_MODAL = null;
function showParseModal(attach, opts = {}) {
  const mm = window.OCMultimodal;
  const isImg = attach.type === 'image';
  const meta = attach.meta || {};
  const modeText = mm.mineruMode() === 'precise' ? '精准' : '轻量';
  const mask = document.createElement('div');
  mask.className = 'modal-mask oc-parse-mask';
  mask.innerHTML =
    '<div class="modal oc-parse-modal" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>' + (isImg ? '正在提取图片文字' : '正在解析文档') + '</h3></div>'
    + '<div class="modal-body">'
    + '<div class="parse-file-row">'
    + '<span class="fc-icon" style="background:' + (meta.color || '#94a3b8') + '22">' + (meta.svg || window.OC.icon('file', 16)) + '</span>'
    + '<span class="parse-file-name">' + escapeHtml(attach.name || '文件') + '</span>'
    + '<span class="parse-file-size">' + escapeHtml(mm.formatSize(attach.size || 0)) + '</span>'
    + '</div>'
    + '<div class="parse-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span style="width:0%"></span></div>'
    + '<div class="parse-meta"><span class="parse-label">正在上传</span><span class="parse-pct">0%</span></div>'
    + '<p class="parse-hint">' + (isImg
      ? '当前模型可能不支持图片输入，将使用 MinerU' + modeText + '解析提取图中文字后发送；也可以直接按原图发送。'
      : escapeHtml(mm.mineruLimitText()))
    + '</p>'
    + '</div>'
    + '<div class="modal-footer">'
    + (isImg ? '<button class="btn" data-act="image">直接按图片发送</button>' : '')
    + '<button class="btn" data-act="cancel">取消解析</button>'
    + '<button class="btn primary" data-act="background">后台解析</button>'
    + '</div></div>';
  document.body.appendChild(mask);
  window.OCUI.openModal(mask);
  const modal = {
    attach,
    update(pct, label) {
      if (!mask.isConnected) return;
      const fill = mask.querySelector('.parse-bar > span');
      if (fill) fill.style.width = pct + '%';
      const bar = mask.querySelector('.parse-bar');
      if (bar) bar.setAttribute('aria-valuenow', String(pct));
      const pctEl = mask.querySelector('.parse-pct');
      if (pctEl) pctEl.textContent = pct + '%';
      const labelEl = mask.querySelector('.parse-label');
      if (labelEl && label) labelEl.textContent = label;
    },
    close() {
      if (ACTIVE_PARSE_MODAL === modal) ACTIVE_PARSE_MODAL = null;
      window.OCUI.closeModal(mask);
      setTimeout(() => mask.remove(), 380);
    },
  };
  mask._onClose = () => { if (ACTIVE_PARSE_MODAL === modal) ACTIVE_PARSE_MODAL = null; };
  mask.addEventListener('click', (e) => {
    if (e.target === mask) { modal.close(); return; } // 点遮罩 = 后台解析,不打断
    const act = e.target.closest('[data-act]');
    if (!act) return;
    e.preventDefault();
    const k = act.dataset.act;
    if (k === 'cancel') { modal.close(); if (opts.onCancel) opts.onCancel(); }
    else if (k === 'image') { modal.close(); if (opts.onSendImage) opts.onSendImage(); }
    else { modal.close(); }
  });
  ACTIVE_PARSE_MODAL = modal;
  return modal;
}

async function attachDocument(file, attach) {
  const mm = window.OCMultimodal;
  const isImage = attach.type === 'image';
  // 多模态模型:图片直接发送,不解析
  if (isImage && modelSupportsVision()) return attach;
  // 生图模型:图片是「参考图」(图生图),保留原图直接发送,不能送去 OCR 解析成文字
  if (isImage && modelIsImage(state.currentModel)) return attach;
  // 文本类等本地可读文件:无需解析
  if (!isImage && !(mm && mm.needsMineru && mm.needsMineru(file))) return attach;
  if (mm.mineruTooBig(file)) {
    toast(mm.mineruLimitText(), true);
    return null;
  }
  attach.parsing = true;
  if (state.pendingAttachments.indexOf(attach) < 0) state.pendingAttachments.push(attach);
  const ac = new AbortController();
  let keepAsImage = false;
  const modal = showParseModal(attach, {
    onCancel() { ac.abort(); },
    onSendImage() { keepAsImage = true; ac.abort(); },
  });
  setParseProgress(attach, 12, '正在上传');
  updateSendBtn();
  const body = new FormData();
  body.append('file', file, file.name);
  let timer = null;
  let result = attach;
  try {
    timer = setInterval(() => {
      const cur = attach.parsePct || 12;
      if (cur < 88) setParseProgress(attach, cur + 4, cur < 28 ? '正在上传' : '正在解析');
    }, 700);
    const r = await api('/api/documents/parse', { method: 'POST', body, signal: ac.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.error && data.error.message) || '解析失败';
      const limited = /10MB|20 页|200MB|200 页|超过|上限|拆分/.test(msg);
      throw new Error(limited ? (msg + '。MinerU 不支持按页拆开多次解析，请自行拆分后再上传。') : msg);
    }
    attach.content = data.markdown || '';
    attach.parsed = true;
    if (isImage) attach.imageAsText = true; // 图片文字已提取,发送时按文本附件走
    attach.parseMode = data.mode || mm.mineruMode();
    setParseProgress(attach, 100, '解析完成');
  } catch (e) {
    if (ac.signal.aborted && keepAsImage) {
      toast('将按原图发送；若模型不支持图片输入可能无法识别', true);
      result = attach;
    } else if (ac.signal.aborted) {
      toast('已取消解析');
      result = null;
    } else if (isImage) {
      // 图片解析失败时按原图保留,不阻塞发送(模型若为多模态仍可识别)
      toast((e.message || '图片解析失败') + '，已按原图添加', true);
      result = attach;
    } else {
      attach.parsing = false;
      modal.close();
      if (timer) clearInterval(timer);
      const idx = state.pendingAttachments.indexOf(attach);
      if (idx >= 0) state.pendingAttachments.splice(idx, 1);
      renderAttachments();
      updateSendBtn();
      throw e;
    }
  } finally {
    if (timer) clearInterval(timer);
    modal.close();
    attach.parsing = false;
    attach.parseLabel = '';
    attach.parsePct = 0;
    if (result !== attach) {
      const idx = state.pendingAttachments.indexOf(attach);
      if (idx >= 0) state.pendingAttachments.splice(idx, 1);
    }
    renderAttachments();
    updateSendBtn();
  }
  return result;
}
// 把一个文件收进待发送附件:读取 → 必要时解析 → 入列。
// 上传按钮、粘贴、拖拽三条入口共用这一条路径,行为保持一致。
async function ingestOneFile(file) {
  if (!file) return false;
  // 解析(PDF/图片 OCR)可能要几十秒。收进来的那一刻记下「是哪个输入框的队列」:
  // 期间用户切到别的对话会整体重置 pendingAttachments(换成新数组),解析完若还按
  // 引用 push,附件就会凭空出现在另一条对话的输入区里 —— 用户莫名其妙就把
  // 上一个对话的 PDF 发了出去。队列已被换掉就不再入列,并明确告知。
  const queue = state.pendingAttachments;
  const chatId = state.currentChatId;
  const attach = await window.OCMultimodal.readFile(file);
  const ready = await attachDocument(file, attach);
  if (!ready) return false;
  if (state.pendingAttachments !== queue || state.currentChatId !== chatId) {
    toast('「' + (file.name || '附件') + '」已解析完成，但你已切换对话，未自动加入输入区', true);
    return false;
  }
  if (state.pendingAttachments.indexOf(ready) < 0) state.pendingAttachments.push(ready);
  renderAttachments();
  updateSendBtn();
  return true;
}

// 批量收取(粘贴/拖拽可能一次带来多个文件):逐个处理,失败逐个提示,不影响其余文件
async function ingestFiles(files, opts) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return 0;
  let ok = 0;
  for (const f of list) {
    try {
      if (await ingestOneFile(f)) ok++;
    } catch (e) {
      toast('读取「' + (f.name || '文件') + '」失败：' + ((e && e.message) || '未知错误'), true);
    }
  }
  if (ok && opts && opts.toastOnSuccess) {
    toast(ok === 1 ? ('已添加 ' + (list.length === 1 ? (opts.singleLabel || '附件') : '附件')) : ('已添加 ' + ok + ' 个附件'));
  }
  return ok;
}

(function initUpload() {
  const attachBtn = $('attach-btn');
  if (!attachBtn) return;
  const { btn, input } = window.OCMultimodal.createUploadButton(async (attach, file) => {
    try {
      const ready = await attachDocument(file, attach);
      if (!ready) return;
      if (state.pendingAttachments.indexOf(ready) < 0) state.pendingAttachments.push(ready);
      renderAttachments();
      updateSendBtn();
    } catch (e) {
      toast(e.message || '解析失败', true);
    }
  });
  // 搬真节点,不用 innerHTML 拷贝:btn 里已经挂着真正接好事件的 <input type=file>,
  // 而 innerHTML 会把它一起序列化成一份没有监听器的副本 —— 再 appendChild(input) 就成了
  // 按钮里两个文件输入框,取到副本的那个「选了文件毫无反应」。移节点还能保住原监听。
  attachBtn.replaceChildren(...btn.childNodes);
  attachBtn.addEventListener('click', () => input.click());
  const more = $('composer-more');
  const tools = $('composer-tools');
  const fileTool = $('composer-tool-file');
  const searchTool = $('composer-tool-search');
  const effortTool = $('composer-tool-effort');
  if (more && tools) {
    const closeTools = () => {
      tools.classList.add('hidden');
      more.setAttribute('aria-expanded', 'false');
    };
    more.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = tools.classList.contains('hidden');
      tools.classList.toggle('hidden', !open);
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (fileTool) fileTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      input.click();
    });
    if (searchTool) searchTool.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-websearch]');
      if (!opt) return;
      e.preventDefault();
      e.stopPropagation();
      if (!searchReady()) {
        const own = state.tools && state.tools.webSearch && state.tools.webSearch.source === 'own';
        toast(own ? '还没有可用的自备检索配置' : '管理员尚未配置联网搜索', true);
        return;
      }
      setWebSearchMode(opt.dataset.websearch);
    });
    if (effortTool) effortTool.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-effort]');
      if (!opt) return;
      e.preventDefault();
      e.stopPropagation();
      setEffortMode(opt.dataset.effort);
    });
    document.addEventListener('click', (e) => {
      if (tools.classList.contains('hidden')) return;
      if (e.target.closest('#composer-tools') || e.target.closest('#composer-more')) return;
      closeTools();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !tools.classList.contains('hidden')) closeTools();
    });
    const compareTool = $('composer-tool-compare');
    if (compareTool) compareTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      openCompareDialog();
    });
    const imageTool = $('composer-tool-image');
    if (imageTool) imageTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      openImageDialog();
    });
    const videoTool = $('composer-tool-video');
    if (videoTool) videoTool.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTools();
      openVideoDialog();
    });
  }
})();

// ============ 粘贴上传:截图 / 复制的图片或文件直接进附件 ============
// 只读游客、未登录等状态不做拦截(它们的发送入口本来就会弹登录)。
(function initPasteUpload() {
  const inputEl = $('input');
  if (!inputEl) return;
  inputEl.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [];
    // 截图/复制的图片以 file 形式出现在 items 里;某些浏览器只在 files 里给出
    if (dt.items && dt.items.length) {
      for (const it of dt.items) {
        if (!it || it.kind !== 'file') continue;
        const f = it.getAsFile && it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length && dt.files && dt.files.length) files.push(...dt.files);
    if (!files.length) return; // 纯文本粘贴:交给浏览器默认行为
    e.preventDefault();
    ingestFiles(files, { toastOnSuccess: true });
  });
})();

// ============ 拖拽上传:把文件拖到输入区或整页任意位置 ============
// 用计数器抵消子元素冒泡产生的 dragenter/dragleave 抖动,避免遮罩闪烁。
(function initDropUpload() {
  const inputEl = $('input');
  const main = document.querySelector('.main');
  if (!inputEl) return;
  let depth = 0;
  const hasFiles = (e) => {
    const dt = e && e.dataTransfer;
    if (!dt) return false;
    if (dt.types && Array.from(dt.types).indexOf('Files') >= 0) return true;
    return !!(dt.files && dt.files.length);
  };
  const showOverlay = () => {
    if (!main) return;
    main.classList.add('drop-active');
  };
  const hideOverlay = () => {
    depth = 0;
    if (main) main.classList.remove('drop-active');
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    showOverlay();
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    // 必须 preventDefault,否则浏览器会直接打开文件
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth -= 1;
    if (depth <= 0) hideOverlay();
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideOverlay();
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (!files.length) return;
    ingestFiles(files, { toastOnSuccess: true });
  });
  // 拖到非文件区域(如整页空白)时不要触发浏览器打开文件
  ['dragend'].forEach((ev) => document.addEventListener(ev, hideOverlay));
  window.addEventListener('blur', hideOverlay);
})();

// ============ 图像生成 ============
// 当前供应商下被判定为生图的模型:显式 image 标记优先,否则按模型名启发式判断
function imageModelsOfCurrentProvider() {
  const p = (state.providers || []).find((x) => x.id === state.currentProviderId);
  if (!p || !Array.isArray(p.models)) return [];
  return p.models.filter((m) => m && m.id && modelIsImage(m.id));
}
// 在动态弹窗里挂一个自定义下拉,替代原生 <select>:样式与全站统一,且支持搜索。
function bindModalSelect(box, getItems, onSelect) {
  if (!box || !window.OC || !OC.openSelect) return;
  const open = () => {
    const items = typeof getItems === 'function' ? getItems() : (getItems || []);
    if (!items.length) return;
    OC.openSelect(box, items, {
      selected: box.getAttribute('data-value') || '',
      searchable: items.length > 8,
      fitWidth: true,
      onSelect: (val, item) => {
        box.setAttribute('data-value', val);
        const lab = box.querySelector('.sb-label');
        if (lab) lab.textContent = (item && item.label) || val;
        if (onSelect) onSelect(val, item);
      },
    });
  };
  box.addEventListener('click', open);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
}
// 自定义下拉的 HTML 骨架(与全站 .select-box 同款)
function selectBoxHtml(id, label, value) {
  return '<div class="select-box" id="' + id + '" data-value="' + escapeHtml(value || '') + '" role="button" tabindex="0" aria-haspopup="listbox">'
    + '<span class="sb-label">' + escapeHtml(label || '请选择') + '</span>'
    + '<span class="sb-arrow"><svg class="oc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9.5L12 14.5 17 9.5"/></svg></span>'
    + '</div>';
}

function openImageDialog() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!state.currentProviderId) { toast('请先在顶部选择供应商', true); return; }
  if (document.querySelector('.img-modal')) return; // 已打开时不重复弹出
  const lastModel = localStorage.getItem('oc_image_model') || '';
  // 常用尺寸快捷项;具体规格可在下方输入框自定义(像素 1024x1024 / 档位 2K / 宽高比 16:9)
  const IMG_SIZE_PRESETS = ['1024x1024', '1792x1024', '1024x1792', '512x512', '2K', '4K', '16:9', '9:16'];
  const storedSize = (localStorage.getItem('oc_image_size') || '').trim();
  const lastSize = storedSize || IMG_SIZE_PRESETS[0];
  // 当前供应商里可用的生图模型(显式标记优先,其次按模型名判断)
  const imageModels = imageModelsOfCurrentProvider();
  const hasModelList = imageModels.length > 0;
  // 默认模型优先级:用户设置的「默认生图模型」(若在本供应商) > 上次使用 > 第一个
  const prefImg = defaultImageModel();
  const prefModelHere = (prefImg && prefImg.providerId === state.currentProviderId && imageModels.some((m) => m.id === prefImg.modelId)) ? prefImg.modelId : '';
  const defaultModel = prefModelHere
    || (imageModels.some((m) => m.id === lastModel) ? lastModel : (imageModels[0] ? imageModels[0].id : ''));

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const iconHtml = (window.OC && OC.logoImg) ? OC.logoImg(imageModelLogo(), 'img-dialog-logo') : '';
  const modelBlock = hasModelList
    ? '<div class="field"><span>图像模型</span>' + selectBoxHtml('img-model-box', '选择生图模型', defaultModel) + '</div>'
      + '<label class="field" id="img-model-custom-row" style="display:none"><span>模型 ID</span>'
      + '<input id="img-model" placeholder="手动输入模型 ID" autocomplete="off"></label>'
    : '<div class="field"><span>图像模型</span>'
      + '<input id="img-model" placeholder="例如 dall-e-3 / gpt-image-1" value="' + escapeHtml(lastModel) + '" autocomplete="off"></div>';

  mask.innerHTML =
    '<div class="modal img-modal" role="dialog" aria-modal="true" aria-labelledby="img-dialog-title">'
    + '<div class="modal-header">'
    + '<h3 id="img-dialog-title">' + iconHtml + 'AI 生图</h3>'
    + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + (window.OC ? OC.icon('close', 16) : '×') + '</button>'
    + '</div>'
    + '<div class="modal-body">'
    + '<p class="img-modal-tip">描述你想要的画面；上传参考图即可<b>修改图片</b>。结果会插入当前对话，每次按一次调用计费。</p>'
    + '<label class="field"><span>提示词</span>'
    + '<textarea id="img-prompt" rows="3" placeholder="例如：一只戴墨镜的柯基在冲浪，扁平插画风" style="resize:vertical"></textarea>'
    + '</label>'
    + '<div class="img-modal-grid">'
    + modelBlock
    + '<div class="field"><span>图片规格</span>'
    + selectBoxHtml('img-size-box', lastSize, lastSize)
    + '<input class="img-size-input" id="img-size-custom" type="text" placeholder="自定义，如 1024x1024 / 2K / 16:9" autocomplete="off">'
    + '</div>'
    + '</div>'
    + '<div class="field"><span>参考图（选填，最多 4 张；上传后按提示词修改图片）</span>'
    + '<div class="img-refs" id="img-refs"></div>'
    + '<input type="file" id="img-ref-input" accept="image/*" multiple hidden>'
    + '<button class="btn small img-ref-add-btn" id="img-ref-add" type="button">'
    + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>添加图片</span></button>'
    + '</div>'
    + '</div>'
    + '<div class="modal-footer img-modal-footer">'
    + '<span class="img-status" id="img-status" role="status" aria-live="polite"></span>'
    + '<button class="btn primary img-run-btn" id="img-run" type="button">生成图片</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(mask);
  // 纳入统一弹窗栈:支持 Esc 关闭与焦点管理
  const rawClose = () => mask.remove();
  const close = (window.OCUI && window.OCUI.adoptModal) ? window.OCUI.adoptModal(mask, rawClose) : rawClose;
  mask.addEventListener('click', (e) => { if (e.target === mask || e.target.closest('[data-act="close"]')) close(); });

  // 自定义下拉:模型 + 尺寸
  const modelBox = mask.querySelector('#img-model-box');
  const customRow = mask.querySelector('#img-model-custom-row');
  const sizeBox = mask.querySelector('#img-size-box');
  const syncCustom = () => {
    if (!customRow || !modelBox) return;
    const custom = modelBox.getAttribute('data-value') === '__custom__';
    customRow.style.display = custom ? '' : 'none';
    if (custom) { const inp = mask.querySelector('#img-model'); if (inp) inp.focus(); }
  };
  if (modelBox) {
    const items = imageModels.map((m) => ({ value: m.id, label: m.name || m.id }))
      .concat([{ value: '__custom__', label: '其他（手动输入）' }]);
    bindModalSelect(modelBox, items, () => syncCustom());
    syncCustom();
  }
  // 图片规格:下拉选预设;也可在输入框里自定义。两者联动(改一边同步另一边),
  // readSizeInput 以输入框为准,输入框为空时才用下拉的预设值。
  const sizeInput = mask.querySelector('#img-size-custom');
  if (sizeBox) {
    bindModalSelect(sizeBox, IMG_SIZE_PRESETS.map((s) => ({ value: s, label: s })), (val) => {
      if (sizeInput) sizeInput.value = val === IMG_SIZE_PRESETS[0] ? '' : val;
    });
  }
  if (sizeInput) {
    sizeInput.addEventListener('input', () => {
      const v = sizeInput.value.trim();
      const label = sizeBox && sizeBox.querySelector('.sb-label');
      if (!label) return;
      label.textContent = v || '选择预设';
    });
  }
  const readImageModel = () => {
    if (modelBox) {
      const v = modelBox.getAttribute('data-value') || '';
      if (v && v !== '__custom__') return v;
    }
    return (mask.querySelector('#img-model') && mask.querySelector('#img-model').value.trim()) || '';
  };
  const readSize = () => {
    const typed = sizeInput ? sizeInput.value.trim() : '';
    if (typed) return typed;
    return (sizeBox && sizeBox.getAttribute('data-value')) || lastSize;
  };
  // 参考图(改图用):保存 data URL 列表并渲染缩略图
  const imgRefs = [];
  const refsBox = mask.querySelector('#img-refs');
  const refInput = mask.querySelector('#img-ref-input');
  const IMG_REF_MAX = 4;
  function renderImgRefs() {
    if (!refsBox) return;
    refsBox.innerHTML = imgRefs.map((r, i) =>
      '<span class="img-ref"><img src="' + r + '" alt="">'
      + '<button type="button" class="img-ref-del" data-idx="' + i + '" aria-label="移除">×</button></span>'
    ).join('');
    refsBox.querySelectorAll('[data-idx]').forEach((b) => b.addEventListener('click', () => {
      imgRefs.splice(Number(b.dataset.idx), 1);
      renderImgRefs();
    }));
  }
  const refAdd = mask.querySelector('#img-ref-add');
  if (refAdd && refInput) {
    refAdd.addEventListener('click', () => refInput.click());
    refInput.addEventListener('change', async () => {
      const files = Array.from(refInput.files || []);
      for (const f of files) {
        if (imgRefs.length >= IMG_REF_MAX) { toast('最多 ' + IMG_REF_MAX + ' 张参考图', true); break; }
        if (!/^image\//.test(f.type)) continue;
        if (f.size > 15 * 1024 * 1024) { toast('单张参考图请小于 15MB', true); continue; }
        try { imgRefs.push(await readImageRefCompressed(f)); } catch (e) { /* 跳过读失败的文件 */ }
      }
      refInput.value = '';
      renderImgRefs();
    });
  }
  const run = mask.querySelector('#img-run');
  run.addEventListener('click', async () => {
    const prompt = (mask.querySelector('#img-prompt') && mask.querySelector('#img-prompt').value.trim()) || '';
    const model = readImageModel();
    const spec = parseImageSpec(readSize());
    const status = mask.querySelector('#img-status');
    if (!prompt) return toast('请输入提示词', true);
    if (!model) return toast('请填写图像模型', true);
    localStorage.setItem('oc_image_model', model);
    syncTouch('imageModel');
    // 记住「用户实际表达」的规格:像素/档位存 size,宽高比存 ratio,两条入口据此还原
    localStorage.setItem('oc_image_size', spec.ratio || spec.size);
    syncTouch('imageSize');
    run.disabled = true;
    status.textContent = '生成中，通常需要 10–60 秒…';
    try {
      const r = await api('/api/proxy/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: state.currentProviderId, model, prompt, size: spec.size, ratio: spec.ratio, n: 1, images: imgRefs.slice() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
      // url / display(同源代理) / b64_json 三种形态统一交给 insertImageResult
      insertImageResult(model, prompt, d.images, imgRefs.length ? '修改要求' : '', imgRefs.slice());
      close();
      toast(imgRefs.length ? '已改图并插入对话' : '已生成并插入对话');
      await refreshMe();
    } catch (e) {
      // 失败原因同时显示在弹窗内(常驻,不会被 toast 错过)与 toast
      const msg = (e && e.message) ? e.message : '未知错误';
      if (status) {
        status.textContent = '生成失败：' + msg;
        status.classList.add('img-status-error');
      }
      toast('生成失败: ' + msg, true);
    } finally { run.disabled = false; }
  });
  setTimeout(() => { const p = mask.querySelector('#img-prompt'); if (p) p.focus(); }, 60);
}

// ============ 视频生成 ============
// 生视频弹窗:提示词 + 模式(文字/首尾帧/参考图) + 时长 + 画面比例 + 参考图。
// 后端建任务并轮询到出片,结果插入当前对话。
function openVideoDialog() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!state.currentProviderId) { toast('请先在顶部选择供应商', true); return; }
  if (document.querySelector('.vid-modal')) return;
  const videoModels = videoModelsOfCurrentProvider();
  const lastModel = localStorage.getItem('oc_video_model') || '';
  const hasModelList = videoModels.length > 0;
  const defaultModel = videoModels.some((m) => m.id === lastModel) ? lastModel : (videoModels[0] ? videoModels[0].id : '');
  const spec = parseVideoSpec();
  const SECONDS = ['4', '5', '6', '8', '10', '12'];

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const iconHtml = (window.OC && OC.logoImg) ? OC.logoImg(videoModelLogo(), 'img-dialog-logo') : '';
  const modelBlock = hasModelList
    ? '<div class="field"><span>视频模型</span>' + selectBoxHtml('vid-model-box', '选择视频模型', defaultModel) + '</div>'
      + '<label class="field" id="vid-model-custom-row" style="display:none"><span>模型 ID</span>'
      + '<input id="vid-model" placeholder="手动输入模型 ID" autocomplete="off"></label>'
    : '<div class="field"><span>视频模型</span>'
      + '<input id="vid-model" placeholder="例如 agnes-video-2.5-flash" value="' + escapeHtml(lastModel) + '" autocomplete="off"></div>';

  mask.innerHTML =
    '<div class="modal img-modal vid-modal" role="dialog" aria-modal="true" aria-labelledby="vid-dialog-title">'
    + '<div class="modal-header">'
    + '<h3 id="vid-dialog-title">' + iconHtml + 'AI 生视频</h3>'
    + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + (window.OC ? OC.icon('close', 16) : '×') + '</button>'
    + '</div>'
    + '<div class="modal-body">'
    + '<p class="img-modal-tip">描述你想要的画面与运镜；<b>首尾帧模式</b>上传首帧/尾帧，<b>参考图模式</b>可上传最多 5 张参考图。生成较慢（约 1–5 分钟），完成后插入当前对话，每次按一次调用计费。</p>'
    + '<label class="field"><span>提示词</span>'
    + '<textarea id="vid-prompt" rows="3" placeholder="例如：雨后的未来城市街道，镜头缓慢推进，霓虹倒影" style="resize:vertical"></textarea>'
    + '</label>'
    + '<div class="img-modal-grid">'
    + modelBlock
    + '<div class="field"><span>生成模式</span>' + selectBoxHtml('vid-mode-box', '文字生成', 'text') + '</div>'
    + '</div>'
    + '<div class="img-modal-grid">'
    + '<div class="field"><span>时长（秒）</span>' + selectBoxHtml('vid-sec-box', String(spec.seconds), String(spec.seconds)) + '</div>'
    + '<div class="field"><span>画面比例</span>' + selectBoxHtml('vid-ratio-box', spec.ratio, spec.ratio) + '</div>'
    + '</div>'
    + '<div class="field" id="vid-first-last" style="display:none"><span>首帧 / 尾帧（至少一张）</span>'
    + '<div class="vid-two">'
    + '<div class="vid-slot" data-slot="first_frame"><div class="img-refs" id="vid-first-refs"></div>'
    + '<input type="file" id="vid-first-input" accept="image/*" hidden>'
    + '<button class="btn small img-ref-add-btn" id="vid-first-add" type="button">' + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>首帧</span></button></div>'
    + '<div class="vid-slot" data-slot="last_frame"><div class="img-refs" id="vid-last-refs"></div>'
    + '<input type="file" id="vid-last-input" accept="image/*" hidden>'
    + '<button class="btn small img-ref-add-btn" id="vid-last-add" type="button">' + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>尾帧</span></button></div>'
    + '</div>'
    + '</div>'
    + '<div class="field" id="vid-refs-field" style="display:none"><span>参考图（最多 5 张）</span>'
    + '<div class="img-refs" id="vid-refs"></div>'
    + '<input type="file" id="vid-ref-input" accept="image/*" multiple hidden>'
    + '<button class="btn small img-ref-add-btn" id="vid-ref-add" type="button">'
    + (window.OC && OC.icon ? OC.icon('plus', 13) : '') + '<span>添加图片</span></button>'
    + '</div>'
    + '</div>'
    + '<div class="modal-footer img-modal-footer">'
    + '<span class="img-status" id="vid-status" role="status" aria-live="polite"></span>'
    + '<button class="btn primary img-run-btn" id="vid-run" type="button">生成视频</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(mask);
  // 纳入统一弹窗栈:支持 Esc 关闭与焦点管理
  const rawClose = () => mask.remove();
  const close = (window.OCUI && window.OCUI.adoptModal) ? window.OCUI.adoptModal(mask, rawClose) : rawClose;
  mask.addEventListener('click', (e) => { if (e.target === mask || e.target.closest('[data-act="close"]')) close(); });

  // 自定义下拉:模型 / 模式 / 时长 / 比例
  const modelBox = mask.querySelector('#vid-model-box');
  const customRow = mask.querySelector('#vid-model-custom-row');
  const modeBox = mask.querySelector('#vid-mode-box');
  const secBox = mask.querySelector('#vid-sec-box');
  const ratioBox = mask.querySelector('#vid-ratio-box');
  const MODES = [
    { value: 'text', label: '文字生成', sub: '纯文本生成视频' },
    { value: 'keyframe', label: '首尾帧', sub: '给定首帧/尾帧生成过渡' },
    { value: 'reference', label: '参考图', sub: '以图片/音频为参考' },
  ];
  const syncMode = (val) => {
    const m = val || (modeBox && modeBox.getAttribute('data-value')) || 'text';
    const fl = mask.querySelector('#vid-first-last');
    const rf = mask.querySelector('#vid-refs-field');
    if (fl) fl.style.display = m === 'keyframe' ? '' : 'none';
    if (rf) rf.style.display = m === 'reference' ? '' : 'none';
  };
  const syncCustom = () => {
    if (!customRow || !modelBox) return;
    const custom = modelBox.getAttribute('data-value') === '__custom__';
    customRow.style.display = custom ? '' : 'none';
    if (custom) { const inp = mask.querySelector('#vid-model'); if (inp) inp.focus(); }
  };
  if (modelBox) {
    const items = videoModels.map((m) => ({ value: m.id, label: m.name || m.id }))
      .concat([{ value: '__custom__', label: '其他（手动输入）' }]);
    bindModalSelect(modelBox, items, () => syncCustom());
    syncCustom();
  }
  if (modeBox) bindModalSelect(modeBox, MODES.map((m) => ({ value: m.value, label: m.label, sub: m.sub })), (v) => syncMode(v));
  if (secBox) bindModalSelect(secBox, SECONDS.map((s) => ({ value: s, label: s + ' 秒' })));
  if (ratioBox) bindModalSelect(ratioBox, VIDEO_RATIOS.map((r) => ({ value: r, label: r })));
  syncMode('text');
  const readVideoModel = () => {
    if (modelBox) {
      const v = modelBox.getAttribute('data-value') || '';
      if (v && v !== '__custom__') return v;
    }
    return (mask.querySelector('#vid-model') && mask.querySelector('#vid-model').value.trim()) || '';
  };
  const readVal = (box, fallback) => (box && box.getAttribute('data-value')) || fallback;

  // 参考图:refs(参考图模式)/ first/last(首尾帧模式)
  const refs = [];
  const firstRef = [];
  const lastRef = [];
  const renderRefs = (box, arr, onDel) => {
    if (!box) return;
    box.innerHTML = arr.map((r, i) =>
      '<span class="img-ref"><img src="' + r + '" alt="">'
      + '<button type="button" class="img-ref-del" data-idx="' + i + '" aria-label="移除">×</button></span>'
    ).join('');
    box.querySelectorAll('[data-idx]').forEach((b) => b.addEventListener('click', () => { onDel(Number(b.dataset.idx)); }));
  };
  const bindRefInput = (addId, inputId, paneId, arr, max) => {
    const add = mask.querySelector(addId), input = mask.querySelector(inputId), pane = mask.querySelector(paneId);
    if (!add || !input || !pane) return;
    const redraw = () => renderRefs(pane, arr, (i) => { arr.splice(i, 1); redraw(); });
    add.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      for (const f of files) {
        if (arr.length >= max) { toast('最多 ' + max + ' 张', true); break; }
        if (!/^image\//.test(f.type)) continue;
        if (f.size > 15 * 1024 * 1024) { toast('单张图片请小于 15MB', true); continue; }
        try { arr.push(await readImageRefCompressed(f)); } catch (e) { /* 跳过读失败的文件 */ }
      }
      input.value = '';
      redraw();
    });
  };
  bindRefInput('#vid-ref-add', '#vid-ref-input', '#vid-refs', refs, 5);
  bindRefInput('#vid-first-add', '#vid-first-input', '#vid-first-refs', firstRef, 1);
  bindRefInput('#vid-last-add', '#vid-last-input', '#vid-last-refs', lastRef, 1);

  const run = mask.querySelector('#vid-run');
  run.addEventListener('click', async () => {
    const prompt = (mask.querySelector('#vid-prompt') && mask.querySelector('#vid-prompt').value.trim()) || '';
    const model = readVideoModel();
    const mode = readVal(modeBox, 'text');
    const seconds = parseInt(readVal(secBox, '5'), 10) || 5;
    const ratio = readVal(ratioBox, '16:9');
    const status = mask.querySelector('#vid-status');
    if (!prompt) return toast('请输入提示词', true);
    if (!model) return toast('请填写视频模型', true);
    if (mode === 'keyframe' && !firstRef.length && !lastRef.length) return toast('首尾帧模式至少上传首帧或尾帧', true);
    localStorage.setItem('oc_video_model', model);
    localStorage.setItem('oc_video_seconds', String(seconds));
    localStorage.setItem('oc_video_ratio', ratio);
    syncTouch('videoModel');
    syncTouch('videoSeconds');
    syncTouch('videoRatio');
    run.disabled = true;
    status.textContent = '生成中，通常需要 1–5 分钟，请勿关闭页面…';
    try {
      const payload = { providerId: state.currentProviderId, model, prompt, mode, seconds, aspect_ratio: ratio, n: 1 };
      if (mode === 'reference') payload.images = refs.slice();
      if (mode === 'keyframe') {
        if (firstRef[0]) payload.first_frame = firstRef[0];
        if (lastRef[0]) payload.last_frame = lastRef[0];
      }
      const r = await api('/api/proxy/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
      insertVideoResult(model, prompt, d.videos, mode);
      close();
      toast('已生成视频并插入对话');
      await refreshMe();
    } catch (e) {
      const msg = (e && e.message) ? e.message : '未知错误';
      if (status) { status.textContent = '生成失败：' + msg; status.classList.add('img-status-error'); }
      toast('生成失败: ' + msg, true);
    } finally { run.disabled = false; }
  });
  setTimeout(() => { const p = mask.querySelector('#vid-prompt'); if (p) p.focus(); }, 60);
}
// 把生视频结果插入当前对话
function insertVideoResult(model, prompt, videos, mode) {
  const links = videoLinksFromResults(videos, prompt);
  if (!links) throw new Error('未返回可用的视频数据');
  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });
  const userMsg = { role: 'user', content: prompt || '（视频）', text: prompt, attachments: [], createdAt: Date.now() };
  chat.messages.push(userMsg);
  jumpToLatestOnSend();
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = '视频 · ' + String(prompt || '生成视频').slice(0, 18);
    renderChatList();
  }
  const modes = { text: '提示词', keyframe: '首尾帧', reference: '参考图' };
  const head = '**' + (modes[mode] || '提示词') + '：** ' + prompt;
  const reply = { role: 'assistant', content: head + '\n\n' + links, model: model + ' (视频)', createdAt: Date.now() };
  chat.messages.push(reply);
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  return links;
}

// 把生图结果插入当前对话(绘图弹窗路径)。与输入框路径一样,先落用户消息再落结果,
// 保证两条入口在对话里的呈现一致;refUrls 为参考图(改图时)的 data URL 列表。
function insertImageResult(model, prompt, images, kindLabel, refUrls) {
  const links = imageLinksFromResults(images, prompt);
  if (!links) throw new Error('未返回可用的图像数据');
  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });
  const refs = (refUrls || []).filter(Boolean).slice(0, 4);
  const parts = [];
  if (prompt) parts.push(prompt);
  refs.forEach((u, i) => parts.push('![参考图' + (i + 1) + '](' + u + ')'));
  const userMsg = {
    role: 'user',
    content: parts.join('\n\n') || '（参考图）',
    text: prompt,
    attachments: refs.map((u, i) => ({ type: 'image', name: '参考图' + (i + 1), dataUrl: u })),
    createdAt: Date.now(),
  };
  chat.messages.push(userMsg);
  jumpToLatestOnSend();
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = (kindLabel || '绘画') + ' · ' + String(prompt || '参考图').slice(0, 18);
    renderChatList();
  }
  const head = kindLabel ? '**' + kindLabel + '：** ' + (prompt || '参考图') : '**提示词：** ' + prompt;
  const reply = { role: 'assistant', content: head + '\n\n' + links, model: model + ' (图像)', createdAt: Date.now() };
  chat.messages.push(reply);
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  return links;
}

// 对话内生图:生图模型下在输入框发指令(纯文本=文生图,带图=图生图)。
// 与绘图弹窗共用同一接口与时序:先落一条用户消息(带附件则在气泡里显示参考图),
// 再放一个占位的助手消息,拿到图片后替换为结果。
async function sendImageTurn(prompt, imageAtts, opts) {
  opts = opts || {};
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const model = state.currentModel;
  const providerId = state.currentProviderId;
  const text = String(prompt || '').trim();
  const atts = (imageAtts || []).slice(0, 4);
  if (!text && !atts.length) return;

  // 落用户消息,让输入框里的提示词与参考图和弹窗路径表现一致
  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();

  // 参考图:优先用本次附的图;用户没附图时,追问自动把本会话上一张生成图作为参考图(改图)。
  // 取到后统一压缩(长边 1536 / JPEG),与绘图弹窗走同一逻辑,发给上游的图片一致。
  // opts.autoRef === false 时不做「自动带上上一张图」(用于纯文生图的新画,避免误当作改图)。
  let refUrls = (await Promise.all(atts.map((a) => compressImageRef(a.dataUrl || a)))).filter(Boolean);
  let autoRef = false;
  if (!refUrls.length && text && opts.autoRef !== false) {
    const prev = lastImageSourceInChat(chat);
    if (prev) {
      const dataUrl = await imageSourceToDataUrl(prev);
      const comp = dataUrl ? await compressImageRef(dataUrl) : '';
      // 只有确实拿到可用的图片才作为参考图;取不到(过期/跨域失败/非图片)就静默回退为纯文生图
      if (comp && /^data:image\//i.test(comp)) { refUrls = [comp]; autoRef = true; }
    }
  }
  const hasRefs = refUrls.length > 0;
  if (!hasRefs && !text) { toast('请输入画面描述', true); return; }

  // 展示用附件:用户附图沿用其文件名;自动参考的上一张图给一个可读名字
  const refAtts = autoRef
    ? [{ type: 'image', name: '上一张图', size: 0, meta: {}, dataUrl: refUrls[0] }]
    : atts.map((a, i) => Object.assign({}, a, { dataUrl: refUrls[i] || a.dataUrl }));

  const parts = [];
  if (text) parts.push(text);
  if (refAtts.length && window.OCMultimodal) refAtts.forEach((a) => parts.push(window.OCMultimodal.toMarkdown(a)));
  // 判定阶段消息已进对话时复用它:只补齐参考图附件,不重复落一条用户消息
  const reuse = opts.posted && opts.posted.userMsg && chat.messages.indexOf(opts.posted.userMsg) >= 0 ? opts.posted : null;
  let userMsg;
  let placeholder;
  if (reuse) {
    userMsg = reuse.userMsg;
    userMsg.content = parts.join('\n\n') || '（参考图）';
    userMsg.text = text;
    userMsg.attachments = refAtts;
    placeholder = reuse.assistantMsg;
  } else {
    userMsg = { role: 'user', content: parts.join('\n\n') || '（参考图）', text, attachments: refAtts, createdAt: Date.now() };
    placeholder = { role: 'assistant', content: '', createdAt: Date.now() };
    chat.messages.push(userMsg, placeholder);
    jumpToLatestOnSend();
  }
  if (!userMsg.mentions) userMsg.mentions = mentionsSnapshot(chat);
  clearNoteMentionsAfterSend();
  placeholder.imagePending = true;
  placeholder.model = model;
  placeholder.providerId = providerId;
  placeholder.phase = opts.phase || (atts.length ? '正在按参考图改图' : '正在生成图片');
  placeholder._streaming = true;
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = (hasRefs ? '改图' : '绘画') + ' · ' + String(text || '参考图').slice(0, 18);
    renderChatList();
  }
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });
  if (autoRef) toast('已把上一张图作为参考图，可直接描述要修改的地方');

  // 图片规格沿用「绘图弹窗」里最近一次的选择(尺寸或宽高比),两条入口共用同一偏好
  const spec = parseImageSpec(localStorage.getItem('oc_image_size') || '');
  state.streaming = true;
  state._followStream = true;
  document.documentElement.classList.add('oc-streaming');
  $('send-btn').classList.add('hidden');
  $('stop-btn').classList.remove('hidden');
  state.abortController = new AbortController();
  updateSendBtn();
  try {
    const r = await api('/api/proxy/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, model, prompt: text, n: 1, size: spec.size, ratio: spec.ratio, images: refUrls }),
      signal: state.abortController.signal,
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
    // 解析图片地址(display 同源代理 / url / b64_json 三种形态)
    const links = imageLinksFromResults(d.images, text);
    if (!links) throw new Error('未返回可用的图像数据');
    const head = '**' + (hasRefs ? '修改要求' : '提示词') + '：** ' + (text || '参考图');
    placeholder.content = head + '\n\n' + links;
    placeholder.imagePending = false;
    placeholder._streaming = false;
    placeholder.createdAt = Date.now();
    saveChats();
    renderMessages();
    toast(hasRefs ? '已改图并插入对话' : '已生成并插入对话');
    await refreshMe();
  } catch (e) {
    placeholder.imagePending = false;
    placeholder._streaming = false;
    if (e && e.name === 'AbortError') {
      placeholder.content = '已停止生成。';
      saveChats();
      renderMessages();
      toast('已停止生成');
    } else {
      placeholder.error = true;
      placeholder.content = '生图失败：' + ((e && e.message) || '未知错误');
      saveChats();
      renderMessages();
      toast('生图失败: ' + ((e && e.message) || '未知错误'), true);
    }
  } finally {
    // 出图/失败都在这里定稿:时间戳推进,已生成的结果不会被云端旧副本合并覆盖
    chat.updatedAt = Date.now();
    initStreamingState();
    refreshModelHealth();
  }
}
// 从生图接口返回项里取出可用的 Markdown 图片链接(url / 同源代理 display / b64)
function imageLinksFromResults(images, prompt) {
  const alt = String(prompt || '').replace(/[\[\]]/g, '').slice(0, 60);
  return (images || []).map((im) => {
    const src = imageSourceOf(im);
    return src ? '![' + alt + '](' + src + ')' : '';
  }).filter(Boolean).join('\n\n');
}
// 视频结果 → Markdown 链接(渲染端识别 .mp4/.webm/.mov 后缀渲染为 <video>)
function videoSourceOf(v) {
  if (!v) return '';
  return v.display || v.url || '';
}
function videoLinksFromResults(videos, prompt) {
  const alt = String(prompt || '').replace(/[()\[\]]/g, '').slice(0, 60) || '生成视频';
  return (videos || []).map((v) => {
    const src = videoSourceOf(v);
    return src ? '[' + alt + '](' + src + ')' : '';
  }).filter(Boolean).join('\n\n');
}
// 对话内生视频:视频模型下在输入框发指令(纯文本=文生视频,带图=以图生视频)。
// 后端建任务并轮询到出片后返回视频地址;期间显示「正在生成视频…」占位。
async function sendVideoTurn(prompt, imageAtts, opts) {
  opts = opts || {};
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const model = state.currentModel;
  const providerId = state.currentProviderId;
  const text = String(prompt || '').trim();
  const atts = (imageAtts || []).slice(0, 5);
  if (!text && !atts.length) return;

  let chat = currentChat();
  if (!chat || !chat.id) chat = newChat();

  const refUrls = (await Promise.all(atts.map((a) => compressImageRef(a.dataUrl || a)))).filter(Boolean);
  const refAtts = atts.map((a, i) => Object.assign({}, a, { dataUrl: refUrls[i] || a.dataUrl }));
  const hasRefs = refUrls.length > 0;
  if (!text && !hasRefs) { toast('请输入画面描述', true); return; }

  const parts = [];
  if (text) parts.push(text);
  if (refAtts.length && window.OCMultimodal) refAtts.forEach((a) => parts.push(window.OCMultimodal.toMarkdown(a)));
  // 判定阶段消息已进对话时复用,不重复落用户消息
  const reuse = opts.posted && opts.posted.userMsg && chat.messages.indexOf(opts.posted.userMsg) >= 0 ? opts.posted : null;
  let userMsg;
  let placeholder;
  if (reuse) {
    userMsg = reuse.userMsg;
    userMsg.content = parts.join('\n\n') || '（参考图）';
    userMsg.text = text;
    userMsg.attachments = refAtts;
    placeholder = reuse.assistantMsg;
  } else {
    userMsg = { role: 'user', content: parts.join('\n\n') || '（参考图）', text, attachments: refAtts, createdAt: Date.now() };
    placeholder = { role: 'assistant', content: '', createdAt: Date.now() };
    chat.messages.push(userMsg, placeholder);
    jumpToLatestOnSend();
  }
  if (!userMsg.mentions) userMsg.mentions = mentionsSnapshot(chat);
  clearNoteMentionsAfterSend();
  placeholder.imagePending = true;
  placeholder.pendingKind = 'video';
  placeholder.model = model;
  placeholder.providerId = providerId;
  placeholder.phase = opts.phase || '正在生成视频';
  placeholder._streaming = true;
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = '视频 · ' + String(text || '参考图').slice(0, 18);
    renderChatList();
  }
  chat.updatedAt = Date.now();
  state.currentChatId = chat.id;
  saveChats();
  renderMessages();
  if (chat.assistantId) enforceImageModelAssistant({ silent: true });

  // 视频规格沿用绘图弹窗里最近一次的选择(时长 / 比例)
  const spec = parseVideoSpec();
  state.streaming = true;
  state._followStream = true;
  document.documentElement.classList.add('oc-streaming');
  $('send-btn').classList.add('hidden');
  $('stop-btn').classList.remove('hidden');
  state.abortController = new AbortController();
  updateSendBtn();
  try {
    const r = await api('/api/proxy/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, model, prompt: text, mode: hasRefs ? 'reference' : 'text', seconds: spec.seconds, aspect_ratio: spec.ratio, images: refUrls }),
      signal: state.abortController.signal,
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
    const links = videoLinksFromResults(d.videos, text);
    if (!links) throw new Error('未返回可用的视频数据');
    const head = '**' + (hasRefs ? '参考图视频' : '提示词') + '：** ' + (text || '参考图');
    placeholder.content = head + '\n\n' + links;
    placeholder.imagePending = false;
    placeholder._streaming = false;
    placeholder.createdAt = Date.now();
    saveChats();
    renderMessages();
    toast('已生成视频并插入对话');
    await refreshMe();
  } catch (e) {
    placeholder.imagePending = false;
    placeholder._streaming = false;
    if (e && e.name === 'AbortError') {
      placeholder.content = '已停止生成。';
      saveChats();
      renderMessages();
      toast('已停止生成');
    } else {
      placeholder.error = true;
      placeholder.content = '生视频失败：' + ((e && e.message) || '未知错误');
      saveChats();
      renderMessages();
      toast('生视频失败: ' + ((e && e.message) || '未知错误'), true);
    }
  } finally {
    // 视频定稿同样推进时间戳,防止云端旧副本把结果合并掉
    chat.updatedAt = Date.now();
    initStreamingState();
    refreshModelHealth();
  }
}
function imageSourceOf(im) {
  if (!im) return '';
  if (im.display) return im.display;                       // 同源代理地址(优先:fetch 不受跨域限制)
  if (im.url) return im.url;
  if (im.b64_json) return 'data:image/png;base64,' + im.b64_json;
  return '';
}
// 找本会话最近一张生成图的地址:从最新的助手消息往前找,取消息里的最后一张图。
// 追问改图时用它作为参考图(用户没另外附图时)。
function lastImageSourceInChat(chat) {
  const msgs = (chat && chat.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const re = /!\[[^\]]*\]\(([^)]+)\)/g;
    let hit = '';
    let match;
    while ((match = re.exec(m.content))) hit = match[1];
    if (hit) return hit;
  }
  return '';
}
// 把图片来源转成 data URL:data: 直接用;同源代理地址 / 公网地址则 fetch 回来。
// 失败返回 '',调用方据此回退为「纯文生图」,不会因参考图取不到而中断。
function imageSourceToDataUrl(src) {
  const s = String(src || '');
  if (!s) return Promise.resolve('');
  if (/^data:image\//i.test(s)) return Promise.resolve(s);
  return new Promise((resolve) => {
    fetch(s, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((blob) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(blob);
      })
      .catch(() => resolve(''));
  });
}

// ============ 多模型并答对比 ============
// 这里只负责「选模型」:选好后问题照常从输入框发,各模型的回答以标签页呈现在同一轮对话里
// (与「@模型重答」同一套 UI),点标签切换对比。每个所选模型各计费一次(用途记为「多模型对比」)。
function compareChatModels() {
  const items = [];
  (availableModelItems() || []).forEach((group) => {
    (group.items || []).forEach((it) => {
      // 只列对话模型:拿生图/生视频模型对比没有意义
      if (it.isImage || it.isVideo) return;
      items.push(it);
    });
  });
  return items;
}

function openCompareDialog() {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const models = compareChatModels();
  if (models.length < 2) return toast('至少需要两个对话模型才能对比', true);
  const picked = {};
  (state._compareModels || []).forEach((p) => { picked[p.providerId + '\n' + p.model] = true; });
  const hasSaved = Array.isArray(state._compareModels) && state._compareModels.length > 0;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const options = models.map((item) => {
    const on = hasSaved
      ? !!picked[item.providerId + '\n' + item.modelId]
      : (item.providerId === state.currentProviderId && item.modelId === state.currentModel);
    return '<label class="compare-model-opt"><input type="checkbox" value="' + escapeHtml(item.providerId + '\n' + item.modelId) + '"' + (on ? ' checked' : '') + '>'
      + (item.icon && window.OC && OC.logoImg ? OC.logoImg(item.icon, 'compare-model-logo') : '')
      + '<span>' + escapeHtml(item.label) + '</span></label>';
  }).join('');
  mask.innerHTML =
    '<div class="modal compare-modal" role="dialog" aria-modal="true">'
    + '<div class="modal-header"><h3>多模型并答</h3>'
    + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">' + (window.OC ? OC.icon('close', 16) : '×') + '</button></div>'
    + '<div class="modal-body" id="compare-body">'
    + '<p class="muted small" style="margin:0 0 8px">勾选 2–3 个对话模型。选好后在输入框输入问题发送，各模型的回答会成为这一轮对话里的标签页，点标签即可切换对比。</p>'
    + '<div class="compare-model-list" id="compare-models">' + options + '</div>'
    + '<div class="form-actions" style="margin-top:10px"><button class="btn primary" id="compare-run" type="button">用这些模型回答</button><span class="muted small" id="compare-status"></span></div>'
    + '</div></div>';
  document.body.appendChild(mask);
  // 纳入统一弹窗栈:支持 Esc 关闭
  const rawClose = () => mask.remove();
  const closeCompare = (window.OCUI && window.OCUI.adoptModal) ? window.OCUI.adoptModal(mask, rawClose) : rawClose;
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-act="close"]')) closeCompare();
  });
  const status = mask.querySelector('#compare-status');
  const syncStatus = () => {
    const n = mask.querySelectorAll('#compare-models input:checked').length;
    if (status) status.textContent = n >= 2 ? ('已选 ' + n + ' 个模型') : '请勾选 2–3 个模型';
  };
  mask.querySelectorAll('#compare-models input').forEach((inp) => inp.addEventListener('change', syncStatus));
  syncStatus();
  mask.querySelector('#compare-run').addEventListener('click', () => {
    const picks = [];
    mask.querySelectorAll('#compare-models input:checked').forEach((inp) => {
      const [providerId, model] = inp.value.split('\n');
      picks.push({ providerId, model });
    });
    if (picks.length < 2) return toast('请至少勾选 2 个模型', true);
    if (picks.length > 3) return toast('最多对比 3 个模型', true);
    // 只记住这次选择:问题由输入框正常发送时据此依次问这些模型
    state._compareModels = picks;
    closeCompare();
    toast('已选 ' + picks.length + ' 个模型，输入问题发送即可对比');
    const input = $('input');
    if (input) input.focus();
  });
}

// 键盘快捷键
window.OCConversations.initShortcuts({
  onNewChat: () => newChat(),
  onFocusInput: () => { const i = $('input'); i.focus(); },
  onToggleSidebar: () => toggleSidebar(),
  onSend: () => sendMessage(),
});
// ============ 侧边栏折叠 ============
function setSidebarCollapsed(collapsed) {
  const sidebar = $('sidebar');
  sidebar.classList.toggle('collapsed', collapsed);
  const floatBtn = $('sidebar-float-btn');
  if (floatBtn) floatBtn.classList.toggle('hidden', !collapsed);
  // 侧边栏头部按钮图标方向
  localStorage.setItem('oc_sidebar_collapsed', collapsed ? '1' : '0');
  syncTouch('sidebarCollapsed');
}
function toggleSidebar() {
  setSidebarCollapsed(!$('sidebar').classList.contains('collapsed'));
}
(function initSidebar() {
  // 恢复折叠状态
  const saved = localStorage.getItem('oc_sidebar_collapsed');
  if (saved === '1') setSidebarCollapsed(true);
  else setSidebarCollapsed(false);
  const t = $('toggle-sidebar');
  if (t) t.addEventListener('click', toggleSidebar);
  const f = $('sidebar-float-btn');
  if (f) f.addEventListener('click', toggleSidebar);

  // 移动端:侧边栏抽屉 + 遮罩
  const sidebar = $('sidebar');
  const mask = $('sidebar-mask');
  const menuBtn = $('mobile-menu-btn');
  const openMobile = () => {
    sidebar.classList.add('mobile-open');
    if (mask) mask.classList.remove('hidden');
    if (mask) mask.classList.add('show');
  };
  const closeMobile = () => {
    sidebar.classList.remove('mobile-open');
    if (mask) { mask.classList.remove('show'); mask.classList.add('hidden'); }
  };
  if (menuBtn) menuBtn.addEventListener('click', openMobile);
  if (mask) mask.addEventListener('click', closeMobile);
  // 移动端点击会话或选中后自动收起
  document.addEventListener('click', (e) => {
    if (window.innerWidth > 768) return;
    if (e.target.closest('.chat-item') || e.target.closest('.model-picker') || e.target.closest('.chat-mode-strip')) closeMobile();
  });
  // 窗口放大回桌面时重置
  window.addEventListener('resize', () => { if (window.innerWidth > 768) closeMobile(); });

  const toc = $('chat-toc');
  const area = $('chat-area');
  const main = document.querySelector('main.main');
  if (toc && main) {
    let tocLeaveTimer = 0;
    const canShow = () => main.classList.contains('has-toc') && !toc.classList.contains('hidden');
    const enterToc = () => {
      if (tocLeaveTimer) { clearTimeout(tocLeaveTimer); tocLeaveTimer = 0; }
      if (canShow()) toc.classList.add('open');
    };
    const leaveToc = () => {
      tocLeaveTimer = setTimeout(() => toc.classList.remove('open'), 160);
    };
    toc.addEventListener('mouseenter', enterToc);
    toc.addEventListener('mouseleave', leaveToc);
    toc.addEventListener('focusin', enterToc);
    toc.addEventListener('focusout', (e) => {
      if (!toc.contains(e.relatedTarget)) leaveToc();
    });
  }
  if (area) {
    // 吸底跟随:只在「用户真的往上滚」时暂停,避免把「内容变高」误判成上翻。
    // 之前只看「离底部多远」判断:新消息/新内容追加时 scrollHeight 变大而 scrollTop 不变,
    // 距离自然拉开,于是被当成用户在翻阅 —— 结果发新问题时不再自动跳到最底下。
    // 现在改为按 scrollTop 的移动方向判断:内容增高不改变 scrollTop,不会触发暂停。
    let lastTop = area.scrollTop;
    area.addEventListener('scroll', () => {
      const top = area.scrollTop;
      const delta = top - lastTop;
      lastTop = top;
      const gap = area.scrollHeight - top - area.clientHeight;
      if (gap < 80) state._followStream = true;          // 回到(或接近)底部 → 恢复跟随
      else if (delta < -4) state._followStream = false;  // 用户向上滚动 → 暂停跟随
      if (syncTocTimer) cancelAnimationFrame(syncTocTimer);
      syncTocTimer = requestAnimationFrame(syncTocActive);
    }, { passive: true });
  }

  // ============ 侧边栏拖拽调宽 ============
  const resizer = $('sidebar-resizer');
  if (resizer && sidebar) {
    // 侧栏宽度上下限跟随「外观 → 字号」等比缩放(基准 14px)
    const rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
    const MIN_W = Math.round(200 * rootFs / 14);
    const MAX_W = Math.round(480 * rootFs / 14);
    // 恢复上次宽度
    const savedW = parseInt(localStorage.getItem('oc_sidebar_width') || '', 10);
    if (savedW >= MIN_W && savedW <= MAX_W) {
      sidebar.style.setProperty('--sidebar-w', savedW + 'px');
    }
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      sidebar.classList.add('resizing');
      document.body.classList.add('sidebar-resizing');
      const onMove = (ev) => {
        const w = Math.min(MAX_W, Math.max(MIN_W, startW + (ev.clientX - startX)));
        sidebar.style.setProperty('--sidebar-w', w + 'px');
      };
      const onUp = () => {
        const w = sidebar.getBoundingClientRect().width;
        localStorage.setItem('oc_sidebar_width', String(Math.round(w)));
        syncTouch('sidebarWidth');
        sidebar.classList.remove('resizing');
        document.body.classList.remove('sidebar-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ============ 对话列两侧拖拽调宽 ============
  // 宽度以「可用主区宽度的百分比」表示,默认 61.8%(见 redesign.css 的 --content-w)。
  // 之所以按百分比而不是 px:同一个设置要在 1280 的笔记本和 2560 的显示器上都合理,
  // px 会让宽屏上内容栏永远只占一小条、窄屏上又几乎撑满。
  (function initChatResizers() {
    const left = $('chat-resizer-left');
    const right = $('chat-resizer-right');
    const mainEl = document.querySelector('main.main');
    if (!left || !right || !mainEl) return;

    const MIN_PCT = 50;    // 最窄:占主区一半
    const MAX_PCT = 100;   // 最宽:铺满主区
    const root = document.documentElement;

    function clampPct(p) {
      if (!Number.isFinite(p)) return 61.8;
      return Math.round(Math.min(MAX_PCT, Math.max(MIN_PCT, p)) * 10) / 10;
    }
    function applyPct(p) {
      root.style.setProperty('--content-w', clampPct(p) + '%');
    }
    // 当前生效的百分比:可能来自我们写进去的 px(旧版本存的),换算回百分比
    function currentPct() {
      const raw = String(getComputedStyle(root).getPropertyValue('--content-w') || '').trim();
      if (raw.endsWith('%')) return clampPct(parseFloat(raw));
      const px = parseFloat(raw);
      const avail = mainEl.getBoundingClientRect().width;
      if (Number.isFinite(px) && avail > 0) return clampPct((px / avail) * 100);
      return 61.8;
    }

    // 旧版本把宽度存成 px;这里统一按「当时的主区宽度」换算成百分比后再用,
    // 免得升级后旧值在更宽的屏上显得过窄。
    const savedRaw = localStorage.getItem('oc_content_width');
    if (savedRaw) {
      const savedPct = savedRaw.endsWith('%')
        ? parseFloat(savedRaw)
        : (() => {
            const px = parseFloat(savedRaw);
            const avail = mainEl.getBoundingClientRect().width;
            return (Number.isFinite(px) && avail > 0) ? (px / avail) * 100 : NaN;
          })();
      if (Number.isFinite(savedPct)) applyPct(savedPct);
    }

    function persist() {
      localStorage.setItem('oc_content_width', currentPct() + '%');
      syncTouch('contentWidth');
    }

    function startDrag(e, side) {
      if (window.innerWidth <= 768) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const avail = Math.max(1, mainEl.getBoundingClientRect().width);
      const startPct = currentPct();
      const sign = side === 'left' ? -1 : 1;
      left.classList.add('active');
      right.classList.add('active');
      document.body.classList.add('chat-resizing');
      const onMove = (ev) => {
        // 拖 1px 改动的百分比 = 1px / 主区宽度;乘 2 是因为左右各拖一边,
        // 用户期望「拖一点就有明显变化」。
        applyPct(startPct + ((ev.clientX - startX) * sign * 2 / avail) * 100);
      };
      const onUp = () => {
        persist();
        left.classList.remove('active');
        right.classList.remove('active');
        document.body.classList.remove('chat-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    left.addEventListener('mousedown', (e) => startDrag(e, 'left'));
    right.addEventListener('mousedown', (e) => startDrag(e, 'right'));

    function nudge(deltaPct) {
      applyPct(currentPct() + deltaPct);
      persist();
    }
    [left, right].forEach((el) => {
      el.addEventListener('keydown', (e) => {
        // 键盘每次调 2%(约等于拖 20px 左右),够精确也不至于要点很多下
        if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(el === left ? 2 : -2); }
        if (e.key === 'ArrowRight') { e.preventDefault(); nudge(el === left ? -2 : 2); }
      });
    });

    // 百分比宽度天然随窗口缩放,不需要再在 resize 里夹一次;
    // 但拖拽中窗口尺寸变了会让 startPct 失准,直接结束这次拖拽更稳妥。
    window.addEventListener('resize', () => {
      if (document.body.classList.contains('chat-resizing')) {
        left.classList.remove('active');
        right.classList.remove('active');
        document.body.classList.remove('chat-resizing');
      }
    });
  })();
})();
// 阻止侧边栏收起在移动端的默认行为无碍

const inputEl = $('input');
// 占位符按「窗口宽窄」和「@ 行是否占位」两条维度选:
//   - 窄屏(≤768px):最短的「输入消息」;
//   - 宽屏且没有 @ 行:完整长提示;
//   - 宽屏但有 @ 行(chip 在):**短提示**。
// 第三种是必须的:选中助手后正文有悬挂缩进(首行让出 @ 行宽度,实测 76.7px),
// 首行可用宽度显著变窄,长占位符会折成两行 —— 空输入框就会撑高到 62px 而不是 41px,
// 观感像「输入框莫名变高」(这正是 theme 收窄对话列后暴露出来的)。
// 缩进激活时自动换成短提示,既保留指引又不会折行。
function applyComposerPlaceholder() {
  // 自己取元素,不用上面那个 inputEl 常量:本函数是函数声明(会被提升),
  // 而 syncComposerIndent 在初始化早期就可能调到它,那时 inputEl 还在 TDZ 里。
  const inp = $('input');
  if (!inp) return;
  const desktop = inp.dataset.placeholderDesktop || '';
  const compact = inp.dataset.placeholderCompact || desktop;
  const mobile = inp.dataset.placeholderMobile || '';
  const narrow = window.matchMedia('(max-width: 768px)').matches;
  const row = $('composer-at-row');
  const chip = $('composer-assistant');
  const box = $('note-mention-row');
  const hasAt = !!(row && ((chip && !chip.classList.contains('hidden')) || (box && !box.classList.contains('hidden'))));
  inp.placeholder = narrow ? mobile : (hasAt ? compact : desktop);
}
(function syncComposerPlaceholder() {
  applyComposerPlaceholder();
  const mq = window.matchMedia('(max-width: 768px)');
  const onChange = () => applyComposerPlaceholder();
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else mq.addListener(onChange);
})();
inputEl.addEventListener('input', () => {
  autosizeInput();
  updateSendBtn();
  syncMentionFromInput();
});
function updateSendBtn() {
  const btn = $('send-btn');
  if (!btn) return;
  const readyAttach = (state.pendingAttachments || []).filter((a) => a && !a.parsing);
  const hasText = !!inputEl.value.trim();
  const hasAttach = readyAttach.length > 0;
  const canSend = hasText || hasAttach;
  btn.disabled = !canSend && !state.streaming;
  btn.classList.toggle('muted', !canSend && !state.streaming);
}
(function bindComposerEffort() {
  const btn = $('composer-effort');
  const pop = $('effort-pop');
  if (!btn || !pop) return;
  const close = () => {
    pop.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    syncComposerEffort();
    pop.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop.classList.contains('hidden')) open();
    else close();
  });
  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-effort]');
    if (!opt) return;
    e.preventDefault();
    setEffortMode(opt.dataset.effort);
    close();
  });
  document.addEventListener('click', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (e.target.closest('.effort-wrap')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) close();
  });
  syncComposerEffort();
})();
(function bindComposerWebSearch() {
  const btn = $('composer-websearch');
  const pop = $('websearch-pop');
  if (!btn || !pop) return;
  const close = () => {
    pop.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    syncComposerWebSearch();
    pop.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!searchReady()) {
      const own = state.tools && state.tools.webSearch && state.tools.webSearch.source === 'own';
      toast(own ? '还没有可用的自备检索配置' : '管理员尚未配置联网搜索', true);
      return;
    }
    if (pop.classList.contains('hidden')) open();
    else close();
  });
  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-websearch]');
    if (!opt) return;
    e.preventDefault();
    setWebSearchMode(opt.dataset.websearch);
    close();
  });
  document.addEventListener('click', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (e.target.closest('.websearch-wrap')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) close();
  });
  syncComposerWebSearch();
})();
function assistantCatName(id) {
  const c = (state.assistantCategories || []).find((x) => x.id === id);
  return c ? c.name : '';
}
function mentionQuery() {
  const el = inputEl;
  if (!el) return null;
  // 生图/生视频模型不使用助手,选中时不再弹出 @助手 候选
  if (modelIsVisual(state.currentModel)) return null;
  const pos = typeof el.selectionStart === 'number' ? el.selectionStart : String(el.value || '').length;
  const before = String(el.value || '').slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const prev = at === 0 ? '' : before.charAt(at - 1);
  if (prev && /[^\s(\[（【]/.test(prev)) return null;
  const q = before.slice(at + 1);
  if (/[\s\n]/.test(q)) return null;
  if (q.length > 24) return null;
  return { start: at, q: q };
}
function mentionCandidates(q) {
  const kw = String(q || '').trim().toLowerCase();
  const list = (state.assistants || []).filter((a) => {
    if (!kw) return true;
    return [a.name, a.desc, assistantCatName(a.categoryId)].some((s) => String(s || '').toLowerCase().includes(kw));
  });
  const none = { id: '', name: '不使用助手', desc: '普通对话，不注入系统提示', icon: '💬', _none: true };
  const ranked = list.slice().sort((a, b) => {
    const an = String(a.name || '');
    const bn = String(b.name || '');
    if (!kw) return (a.sort - b.sort) || an.localeCompare(bn, 'zh');
    const ap = an.toLowerCase().startsWith(kw) ? 0 : 1;
    const bp = bn.toLowerCase().startsWith(kw) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.sort - b.sort) || an.localeCompare(bn, 'zh');
  });
  return [none].concat(ranked.slice(0, 12));
}
// 笔记候选(@笔记):标题命中优先,其次标签,最后正文。
// 用户可能没打开过笔记模块,这里静默预热一次数据(仅一次)。
// 确保笔记数据可用(用户可能从没打开过笔记模块):首次触发静默预热一次
function ensureNotesForMention() {
  if (!window.OCNotes) return;
  if (window.OCNotes.isReady && window.OCNotes.isReady()) return;
  if (state._notesWarming) return;
  state._notesWarming = true;
  Promise.resolve(window.OCNotes.warmUp && window.OCNotes.warmUp())
    .then(() => {
      state._notesWarming = false;
      if (state.mention && state.mention.open) renderMention();
    })
    .catch(() => { state._notesWarming = false; });
}

function closeMention() {
  state.mention = { open: false, q: '', index: 0, start: -1 };
  const pop = $('mention-pop');
  if (pop) {
    pop.classList.add('hidden');
    pop.innerHTML = '';
  }
}
function renderMention() {
  const pop = $('mention-pop');
  if (!pop) return;
  if (!state.mention.open) {
    pop.classList.add('hidden');
    pop.innerHTML = '';
    return;
  }
  // 分类页签:0=助手,1=笔记(Tab 键切换)
  const tab = state.mention.tab === 1 ? 1 : 0;
  state.mention.tab = tab;
  const items = tab === 1 ? noteMentionItems(state.mention.q) : mentionCandidates(state.mention.q);
  const pickable = items.filter((x) => !x._folder);
  if (state.mention.index < 0) state.mention.index = 0;
  if (state.mention.index >= pickable.length) state.mention.index = Math.max(0, pickable.length - 1);
  // 把「可选项序号」写回 item,便于键盘与点击共用
  let pi = 0;
  items.forEach((x) => { if (!x._folder) x._pickIdx = pi++; });
  pop.innerHTML = '<div class="mention-tabs">'
    + '<button type="button" class="mention-tab' + (tab === 0 ? ' active' : '') + '" data-tab="0">助手</button>'
    + '<button type="button" class="mention-tab' + (tab === 1 ? ' active' : '') + '" data-tab="1">笔记</button>'
    + '<span class="mention-tab-hint">' + (tab === 1 ? '↑↓ 选择 · Tab 切换 · 点文件夹展开' : '↑↓ 选择 · Tab 切换') + '</span>'
    + '</div>'
    + '<div class="mention-body">' + mentionBodyHtml(items, tab) + '</div>';
  pop.classList.remove('hidden');
  const active = pop.querySelector('.mention-item.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

// 笔记候选:按文件夹分组(可展开),搜索时平铺
function noteMentionItems(q) {
  const dbg = window.OCNotes && window.OCNotes._debug;
  if (!dbg || !dbg.doc) return [];
  const kw = String(q || '').trim().toLowerCase();
  const notes = (dbg.doc.notes || []).filter((n) => {
    if (!kw) return true;
    return [n.title, (n.tags || []).join(' '), n.content].some((x) => String(x || '').toLowerCase().includes(kw));
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (kw) return notes.map((n) => noteMentionItem(n, folderNameOf(dbg, n.folderId)));
  const openMap = state.mention.folderOpen || (state.mention.folderOpen = {});
  const folders = (dbg.doc.folders || []).slice();
  const known = {};
  folders.forEach((f) => { known[f.id] = f; });
  const out = [];
  const pushGroup = (id, name, list) => {
    if (!list.length) return;
    const isOpen = openMap[id] === true; // 默认折叠:点文件夹才展开
    out.push({ _folder: true, id: id, name: name, count: list.length, open: isOpen });
    if (isOpen) list.forEach((n) => out.push(noteMentionItem(n, name)));
  };
  folders.forEach((f) => pushGroup(f.id, f.name, notes.filter((n) => n.folderId === f.id)));
  pushGroup('__orphan', '未归类', notes.filter((n) => !known[n.folderId]));
  return out;
}
function folderNameOf(dbg, fid) {
  const f = (dbg.doc.folders || []).find((x) => x.id === fid);
  return f ? f.name : '未归类';
}
function noteMentionItem(n, folderName) {
  const tags = (n.tags || []).slice(0, 3).map((t) => '#' + t).join(' ');
  return {
    id: n.id,
    name: n.title || '无标题笔记',
    desc: (folderName ? folderName : '笔记') + (tags ? ' · ' + tags : ''),
    icon: '📒',
    _note: true,
    _noteId: n.id,
  };
}
// 候选主体(文件夹行与助手/笔记项)
function mentionBodyHtml(items, tab) {
  if (!items.length) return '<div class="mention-empty">' + (tab === 1 ? '还没有笔记，或没有匹配项' : '没有匹配的助手') + '</div>';
  return items.map((a) => {
    if (a._folder) {
      const picked = (state.noteFolderMentions || []).some((x) => x.id === a.id);
      return '<div class="mention-folder-row">'
        + '<button type="button" class="mention-folder' + (a.open ? ' open' : '') + '" data-folder="' + escapeHtml(a.id) + '">'
        + '<span class="mention-folder-chev">' + (a.open ? '▾' : '▸') + '</span>'
        + '<span class="mention-folder-name">' + escapeHtml(a.name) + '</span>'
        + '<span class="mention-folder-count">' + a.count + ' 篇</span></button>'
        // 默认就是「选整个文件夹」——点这一项把目录下全部笔记加入引用
        + '<button type="button" class="mention-folder-pick' + (picked ? ' picked' : '') + '" data-folder-pick="' + escapeHtml(a.id) + '" data-folder-name="' + escapeHtml(a.name) + '" data-tip="' + (picked ? '已选整个文件夹' : '选整个文件夹') + '">'
        + (picked ? '✓ 整个文件夹' : '整个文件夹') + '</button>'
        + '</div>';
    }
    const active = a._pickIdx === state.mention.index;
    const picked = a._note && (state.noteMentions || []).some((x) => x.id === a._noteId);
    return '<button type="button" class="mention-item' + (active ? ' active' : '') + (a._note ? ' mention-note' : '') + (picked ? ' picked' : '') + '" data-idx="' + a._pickIdx + '" role="option" aria-selected="' + (active ? 'true' : 'false') + '">'
      + '<span class="mention-ico">' + escapeHtml(a.icon || '✨') + '</span>'
      + '<span class="mention-text"><span class="mention-name">' + (picked ? '✓ ' : '') + escapeHtml(a.name || '') + '</span>'
      + '<span class="mention-desc">' + escapeHtml(a.desc || assistantCatName(a.categoryId) || '') + '</span></span></button>';
  }).join('');
}

function openMention(q, start) {
  state.mention = { open: true, q: q || '', index: 0, start: start == null ? -1 : start };
  renderMention();
}
function syncMentionFromInput() {
  const hit = mentionQuery();
  if (!hit) {
    if (state.mention.open) closeMention();
    return;
  }
  ensureNotesForMention();
  const wasOpen = state.mention.open;
  state.mention.open = true;
  state.mention.q = hit.q;
  state.mention.start = hit.start;
  state.mention.index = 0;
  if (!wasOpen) {
    // 刚打开面板:已经选过助手时直接给「笔记」页签(常见诉求是 @ 笔记),
    // 没选助手则先给「助手」。
    const hasAssistant = !!(currentChat() && currentChat().assistantId);
    state.mention.tab = hasAssistant ? 1 : 0;
    if (hasAssistant) ensureNotesForMention();
  }
  renderMention();
}
// 从输入框里删掉正在输入的 @ 片段(连同光标之前的候选词),光标回到 @ 处。
// @ 候选的三种选择(助手 / 笔记 / 整个文件夹)必须都走这里:
// 漏掉任何一条都会在输入框里留下一个多余的 @,下一个 Enter 还会被 @ 面板吃掉。
function stripMentionFromInput() {
  const el = inputEl;
  const start = state.mention ? state.mention.start : -1;
  if (!el || !(start >= 0)) return;
  const pos = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  el.value = (el.value.slice(0, start) + el.value.slice(pos)).replace(/^\s+/, '');
  el.selectionStart = el.selectionEnd = Math.max(0, start);
}

function pickMention(item) {
  const el = inputEl;
  if (item && item._note) {
    // @笔记:把提及文本删掉,改在输入区上方显示浅红色 chip(可多个,可移除)
    stripMentionFromInput();
    closeMention();
    addNoteMention(item._noteId, item.name);
    // 不调用 autosizeInput:chip 不在 textarea 内,重算高度只会让输入框莫名变高
    updateSendBtn();
    if (el) el.focus();
    return;
  }
  if (!item) {
    // 候选为空(搜索无结果、笔记还没加载出来)时的 Enter:只收面板,不要顺手清掉当前助手
    closeMention();
    updateSendBtn();
    return;
  }
  stripMentionFromInput();
  closeMention();
  if (item && item._none) useAssistantOnChat(null);
  else if (item) useAssistantOnChat(item);
  autosizeInput();
  updateSendBtn();
  if (el) el.focus();
}

// ============ @笔记:提及的笔记集合与 chip ============
// 注入上下文与正文的分隔标记(展示时据此剥离,只留用户原本写的问题)
const NOTE_CTX_SEP = String.fromCharCode(10, 10, 45, 45, 45, 10);
// 与「保存到 AI 笔记」共用笔记文档;这里只记录 id,发送时检索正文注入上下文。
function addNoteMention(id, title) {
  if (!id) return;
  // 防御:标题不能是文件夹名(历史脏数据会显示成 @默认分类)
  const dbg = window.OCNotes && window.OCNotes._debug;
  const n = dbg && dbg.doc ? (dbg.doc.notes || []).find((x) => x.id === id) : null;
  if (n) title = n.title || '无标题笔记';
  state.noteMentions = state.noteMentions || [];
  if (state.noteMentions.some((x) => x.id === id)) { toast('已经 @ 过这篇笔记了'); return; }
  state.noteMentions.push({ id: id, title: title || '无标题笔记' });
  renderNoteMentions();
}
// 整文件夹引用:@ 一个目录 = 引用其中全部笔记(发送时展开)
function toggleFolderMention(fid, name) {
  if (!fid) return;
  state.noteFolderMentions = state.noteFolderMentions || [];
  const i = state.noteFolderMentions.findIndex((x) => x.id === fid);
  if (i >= 0) { state.noteFolderMentions.splice(i, 1); toast('已取消引用文件夹「' + name + '」'); }
  else {
    state.noteFolderMentions.push({ id: fid, name: name || '文件夹' });
    toast('已引用整个文件夹「' + name + '」');
  }
  renderNoteMentions();
  updateSendBtn();
}
function removeNoteMention(id) {
  state.noteMentions = (state.noteMentions || []).filter((x) => x.id !== id);
  renderNoteMentions();
}
// 首行缩进变化会改变 placeholder / 正文的折行行数,输入框高度必须跟着重算。
// 否则会停在按旧缩进算出的高度上:引用清空后输入框「莫名变高」、引用变宽后又被截断,
// 都要等到下一次输入事件才恢复。
function resyncInputHeight(inp) {
  if (typeof autosizeInput !== 'function') return;
  const prev = inp.style.height;
  // 必须先归零再量:scrollHeight 不会小于 clientHeight,带着旧高度量会自我印证、永远收不回去
  inp.style.height = 'auto';
  const want = Math.min(inp.scrollHeight, 180);
  if (Math.abs(want - (parseFloat(prev) || 0)) > 0.5) autosizeInput();
  else inp.style.height = prev;
}
// 首行缩进:让正文第一行从 @ 行之后开始,折行后回到最左侧(悬挂缩进)。
// 宽度取 @ 行实际渲染宽度,并在 @ 行变化时同步。
function syncComposerIndent() {
  const row = $('composer-at-row');
  const inp = $('input');
  if (!row || !inp) return;
  const hasAt = (row.querySelector('#composer-assistant') && !row.querySelector('#composer-assistant').classList.contains('hidden'))
    || (row.querySelector('#note-mention-row') && !row.querySelector('#note-mention-row').classList.contains('hidden'));
  // 占位符要跟着 @ 行一起换:有 @ 行时首行让出了缩进,原来那句长提示会折成两行、
  // 把空输入框撑高(见 applyComposerPlaceholder 的说明)。缩进变 → 提示也要重算。
  if (typeof applyComposerPlaceholder === 'function') applyComposerPlaceholder();
  if (!hasAt) { inp.style.textIndent = ''; resyncInputHeight(inp); return; }
  // 用 next frame 测量:chip 刚插入 DOM 时宽度尚未确定,直接测量会偏小/为 0
  // 缩进量按 @ 行实际宽度换算成 em(相对输入字号):
  // 字号变化 / 页面缩放(Zoom)时缩进都随之等比缩放,无需重新测量。
  // 但 @ 行宽度本身会因字号/字体/助手名变化而变,所以还要在布局变化后重测:
  // 用 ResizeObserver 盯住 @ 行,任何尺寸变化都重新换算一次。
  const apply = () => {
    const w = row.getBoundingClientRect().width;
    if (w <= 0) return;
    const fs = parseFloat(window.getComputedStyle(inp).fontSize) || 14;
    const gap = fs * 0.57;              // 约 8px @ 14px 字号
    inp.style.textIndent = ((w + gap) / fs).toFixed(3) + 'em';
    resyncInputHeight(inp);
  };
  apply();
  requestAnimationFrame(apply);
  // 只挂一次:观察 @ 行的尺寸变化(助手名/笔记数/字号/缩放都会触发)
  if (!row._indentObserver && typeof ResizeObserver === 'function') {
    row._indentObserver = new ResizeObserver(() => apply());
    row._indentObserver.observe(row);
  }
}

function renderNoteMentions() {
  const box = $('note-mention-row');
  if (!box) return;
  const list = state.noteMentions || [];
  const folders = state.noteFolderMentions || [];
  if (!list.length && !folders.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    syncComposerIndent();
    return;
  }
  box.classList.remove('hidden');
  // 顺序:@助手 在前,随后是 @文件夹 与 @笔记,连读为「@助手 @笔记 提问内容」
  const folderHtml = folders.map((f) => ''
    + '<span class="note-mention-chip note-mention-folder" data-fid="' + escapeHtml(f.id) + '" title="整个文件夹的笔记都会作为参考，点 × 移除">'
    + '<b>@</b>' + escapeHtml(f.name) + ' 文件夹'
    + '<button type="button" class="nmc-x" aria-label="移除">×</button></span>').join('');
  const noteHtml = list.map((x) => ''
    + '<span class="note-mention-chip" data-id="' + escapeHtml(x.id) + '" title="基于这篇笔记提问，点 × 移除">'
    + '<b>@</b>' + escapeHtml(x.title || '无标题笔记')
    + '<button type="button" class="nmc-x" aria-label="移除">×</button></span>').join('');
  box.innerHTML = folderHtml + noteHtml;
  if (typeof syncComposerIndent === 'function') syncComposerIndent();
  box.querySelectorAll('.nmc-x').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const chip = e.target.closest('.note-mention-chip');
      if (!chip) return;
      if (chip.dataset.fid) {
        state.noteFolderMentions = (state.noteFolderMentions || []).filter((x) => x.id !== chip.dataset.fid);
        renderNoteMentions();
      } else {
        removeNoteMention(chip.dataset.id);
      }
      updateSendBtn();
    });
  });
}
// 发送前把 @笔记 的内容拼成上下文(供 AI 引用);返回 null 表示没有 @笔记
function noteMentionsContext(limitPerNote) {
  const list = state.noteMentions || [];
  const folders = state.noteFolderMentions || [];
  if (!list.length && !folders.length) return null;
  const dbg = window.OCNotes && window.OCNotes._debug;
  const found = [];
  const seen = {};
  if (dbg && dbg.doc) {
    // 整文件夹引用:展开为该目录下全部笔记(已在列表里的不重复)
    folders.forEach((f) => {
      (dbg.doc.notes || []).filter((n) => n.folderId === f.id).forEach((n) => {
        if (!seen[n.id]) { seen[n.id] = 1; found.push(n); }
      });
    });
    list.forEach((m) => {
      const n = (dbg.doc.notes || []).find((x) => x.id === m.id);
      if (n && !seen[n.id]) { seen[n.id] = 1; found.push(n); }
    });
  }
  if (!found.length) return null;
  const cap = limitPerNote || 4000;
  // 整文件夹引用可能命中很多篇:取最近更新的前 N 篇,避免上下文爆炸
  const MAX_NOTES = 20;
  const picked = found.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, MAX_NOTES);
  const parts = picked.map((n, i) => '【笔记' + (i + 1) + '】' + (n.title || '无标题') + '\n'
    + String(n.content || '').slice(0, cap));
  return {
    notes: picked,
    text: parts.join('\n\n'),
    instruction: '用户 @ 了 ' + picked.length + ' 篇笔记，请只根据下面提供的笔记内容回答；'
      + '笔记里没有的信息要明确说明「笔记里没有相关内容」，不要编造。回答后不要自行编造引用编号。',
  };
}
function ensureAssistantsLoaded() {
  if ((state.assistants || []).length) return Promise.resolve();
  return loadDefaultAssistant();
}
const mentionPop = $('mention-pop');
if (mentionPop) {
  mentionPop.addEventListener('mousedown', (e) => {
    const tabBtn = e.target.closest('.mention-tab');
    if (tabBtn) {
      e.preventDefault();
      state.mention.tab = Number(tabBtn.dataset.tab) === 1 ? 1 : 0;
      state.mention.index = 0;
      if (state.mention.tab === 1) ensureNotesForMention();
      renderMention();
      return;
    }
    const pickBtn = e.target.closest('[data-folder-pick]');
    if (pickBtn) {
      e.preventDefault();
      // 与 @助手/@笔记 一致:选完把正在输入的 @ 片段从输入框删掉,
      // 否则会残留一个孤零零的 @(接着按 Enter 还会被候选面板当成选择)
      stripMentionFromInput();
      closeMention();
      toggleFolderMention(pickBtn.dataset.folderPick, pickBtn.dataset.folderName);
      updateSendBtn();
      if (inputEl) inputEl.focus();
      return;
    }
    const folderBtn = e.target.closest('.mention-folder');
    if (folderBtn) {
      e.preventDefault();
      const fid = folderBtn.dataset.folder;
      const openMap = state.mention.folderOpen || (state.mention.folderOpen = {});
      // 默认折叠:点击在「展开 / 折叠」之间切换
      openMap[fid] = openMap[fid] !== true;
      renderMention();
      return;
    }
    const btn = e.target.closest('.mention-item');
    if (!btn) return;
    e.preventDefault();
    // data-idx 是「可选项序号」(文件夹行不参与编号),按它查找而不是数组下标
    const want = Number(btn.dataset.idx);
    const list = currentMentionItems().filter((x) => !x._folder);
    pickMention(list[want] || list[0]);
  });
}
// 当前页签下的可选项(与 renderMention 的编号保持一致)
function currentMentionItems() {
  const tab = state.mention.tab === 1 ? 1 : 0;
  return tab === 1 ? noteMentionItems(state.mention.q) : mentionCandidates(state.mention.q);
}
inputEl.addEventListener('keydown', (e) => {
  // 中文输入法组词期间的 Enter 是「确认候选词」,不能当成发送;
  // isComposing 之外的 keyCode===229 兜底旧版 Safari。
  if (e.isComposing || e.keyCode === 229) return;
  if (state.mention.open) {
    const all = currentMentionItems();
    const items = all.filter((x) => !x._folder);
    if (e.key === 'Tab') {
      // Tab 在「助手 / 笔记」两个页签之间切换
      e.preventDefault();
      state.mention.tab = state.mention.tab === 1 ? 0 : 1;
      state.mention.index = 0;
      if (state.mention.tab === 1) ensureNotesForMention();
      renderMention();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.mention.index = Math.min(items.length - 1, state.mention.index + 1);
      renderMention();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.mention.index = Math.max(0, state.mention.index - 1);
      renderMention();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pickMention(items[state.mention.index] || items[0]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const chat = currentChat();
    const hasAssistant = !!(chat && chat.assistantId);
    const caretAtStart = (inputEl.selectionStart || 0) === 0 && (inputEl.selectionEnd || 0) === 0;
    const empty = !String(inputEl.value || '');
    if (hasAssistant && (empty || (e.key === 'Backspace' && caretAtStart))) {
      const now = Date.now();
      if (state.clearAssistantAt && now - state.clearAssistantAt < 700) {
        e.preventDefault();
        state.clearAssistantAt = 0;
        useAssistantOnChat(null);
        return;
      }
      state.clearAssistantAt = now;
    } else {
      state.clearAssistantAt = 0;
    }
  } else if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
    state.clearAssistantAt = 0;
  }
});
inputEl.addEventListener('focus', () => {
  if (mentionQuery()) syncMentionFromInput();
});
inputEl.addEventListener('blur', () => {
  setTimeout(() => closeMention(), 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== '@' && !(e.shiftKey && e.key === '2' && e.code === 'Digit2')) return;
  if (document.activeElement !== inputEl) return;
  ensureAssistantsLoaded().then(() => {
    setTimeout(() => syncMentionFromInput(), 0);
  });
});
function autosizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}

// ============ 游客 / 未登录 ============
// 主站登录弹窗:与 /login 保持同一套能力(登录 / 注册 / 忘记密码 / 第三方一键登录)。
// 以前这里只有一个登录表单,注册与找回密码都得离开当前页跳去 /login —— 用户正在写的内容
// 会被整页导航丢掉。现在四个视图在同一弹窗内切换,行为与登录页一致。
let AUTH_MODAL_BOUND = false;
let AUTH_MODAL_VIEW = 'login';
let AUTH_MODAL_CFG = null;
let AUTH_MODAL_CFG_LOADING = false;

function amError(msg) {
  const err = $('auth-modal-error');
  if (!err) return;
  err.textContent = msg || '';
  err.classList.toggle('hidden', !msg);
}
function amBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle('is-loading', busy);
  btn.textContent = busy ? '请稍候…' : label;
}
// 切视图:登录 / 注册 / 找回密码。只切显隐与标题,不重建 DOM(重挂会丢用户已填的内容)。
function amShowView(view, focusId) {
  AUTH_MODAL_VIEW = view;
  const forms = { login: 'auth-modal-login', register: 'auth-modal-register', forgot: 'auth-modal-forgot' };
  Object.keys(forms).forEach((k) => {
    const el = $(forms[k]);
    if (el) el.classList.toggle('hidden', k !== view);
  });
  const titles = { login: '登录后继续对话', register: '注册新账号', forgot: '找回密码' };
  const title = $('auth-modal-title');
  if (title && titles[view]) title.textContent = titles[view];
  amError('');
  const focus = focusId ? $(focusId) : null;
  if (focus) setTimeout(() => focus.focus(), 40);
  // 按配置决定各入口显隐(内部会渲染第三方图标)
  amApplyConfig();
  // 必须在 amApplyConfig 之后收口:它渲染第三方图标时会 remove('hidden'),先隐藏会被它重新显示出来
  const oauth = $('am-oauth');
  if (oauth && view === 'forgot') oauth.classList.add('hidden');
}
// 按 /api/config 决定各入口显隐。缺字段时按「不展示」处理:注册与找回密码
// 都可能在后台被关掉,展示出来点进去只会得到一个错误。
function amApplyConfig() {
  const cfg = AUTH_MODAL_CFG || state.config || null;
  if (!cfg) { amLoadConfig(); return; }
  const allowRegister = cfg.allowRegister !== false;
  const regHint = $('am-register-hint');
  if (regHint) regHint.classList.toggle('hidden', !allowRegister);
  const regForm = $('auth-modal-register');
  if (!allowRegister && regForm && AUTH_MODAL_VIEW === 'register') amShowView('login', 'am-name');
  // 找回密码依赖邮件:功能关闭或未配置 SMTP 时不给入口
  const canReset = cfg.passwordResetEnabled !== false && cfg.mailReady !== false;
  const forgotHint = $('am-forgot-hint');
  if (forgotHint) forgotHint.classList.toggle('hidden', !canReset);
  // 邀请码与用户协议:与 /login 一样按后台设置显隐
  const inviteRow = $('am-reg-invite-row');
  if (inviteRow) inviteRow.classList.toggle('hidden', !cfg.registerInviteRequired);
  const agreeRow = $('am-reg-agree-row');
  if (agreeRow) agreeRow.classList.toggle('hidden', !cfg.agreementEnabled);
  // 邮箱验证:开启后邮箱是必填,标签要去掉「(可选)」(与 /login 同款)
  if (window.OCUI && window.OCUI.applyEmailRequirement) {
    window.OCUI.applyEmailRequirement($('am-reg-email-label'), $('am-reg-email'), !!cfg.emailVerificationEnabled);
  }
  // 第三方登录图标
  if (window.OCUI && window.OCUI.renderOauthIcons) {
    window.OCUI.renderOauthIcons($('am-oauth'), $('am-oauth-icons'), cfg.oauth && cfg.oauth.providers);
  }
}
function amLoadConfig() {
  if (AUTH_MODAL_CFG_LOADING) return;   // 没配置时每次切视图都会走到这里,别重复请求
  AUTH_MODAL_CFG_LOADING = true;
  fetch(apiUrl('/api/config')).then((r) => r.json()).then((cfg) => {
    AUTH_MODAL_CFG = cfg || {};
    AUTH_MODAL_CFG_LOADING = false;
    if (AUTH_MODAL_BOUND) amApplyConfig();
  }).catch(() => { AUTH_MODAL_CFG_LOADING = false; /* 读不到配置就用默认:保留入口,由接口报错 */ });
}
function amFinishLogin(d) {
  localStorage.setItem('oc_token', d.token);
  localStorage.setItem('oc_user', JSON.stringify(d.user || {}));
  state.token = d.token;
  location.reload();
}
function openAuthModal(message) {
  const modal = $('auth-modal');
  if (!modal) { location.href = apiUrl('/login'); return; }
  if (!AUTH_MODAL_BOUND && window.OCUI) {
    AUTH_MODAL_BOUND = true;
    AUTH_MODAL_CFG = state.config || null;
    window.OCUI.bindModal(modal, { closeId: 'auth-modal-close' });
    window.OCUI.bindPasswordToggles(modal);
    if (!AUTH_MODAL_CFG) amLoadConfig();

    const loginForm = $('auth-modal-login');
    if (loginForm) loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = ($('am-name') && $('am-name').value.trim()) || '';
      const pass = ($('am-pass') && $('am-pass').value) || '';
      if (!name || !pass) return amError('请输入用户名和密码');
      const btn = $('am-login-btn');
      amBusy(btn, true, '登录');
      try {
        const r = await fetch(apiUrl('/api/auth/login'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, password: pass }),
        });
        const d = await readJsonSafe(r);
        if (!r.ok) throw new Error((d.error && d.error.message) || '登录失败');
        amFinishLogin(d);
      } catch (ex) {
        amError(ex.message);
        amBusy(btn, false, '登录');
      }
    });

    const regForm = $('auth-modal-register');
    if (regForm) regForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = ($('am-reg-name') && $('am-reg-name').value.trim()) || '';
      const pass = ($('am-reg-pass') && $('am-reg-pass').value) || '';
      if (!name || !pass) return amError('请输入用户名和密码');
      const btn = $('am-register-btn');
      amBusy(btn, true, '注册并登录');
      try {
        const r = await fetch(apiUrl('/api/auth/register'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name,
            password: pass,
            email: ($('am-reg-email') && $('am-reg-email').value.trim()) || '',
            agreementAccepted: !!($('am-reg-agree') && $('am-reg-agree').checked),
            invite: ($('am-reg-invite') && $('am-reg-invite').value.trim()) || '',
          }),
        });
        const d = await readJsonSafe(r);
        if (!r.ok) throw new Error((d.error && d.error.message) || '注册失败');
        // 开启邮箱验证时不发令牌:提示去查收邮件,不要谎报登录成功
        if (d.pendingVerification) { amBusy(btn, false, '注册并登录'); return amError('注册成功，请查收验证邮件并完成邮箱验证后登录'); }
        amFinishLogin(d);
      } catch (ex) {
        amError(ex.message);
        amBusy(btn, false, '注册并登录');
      }
    });

    const forgotForm = $('auth-modal-forgot');
    if (forgotForm) forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('am-forgot-btn');
      amBusy(btn, true, '发送重置邮件');
      try {
        const r = await fetch(apiUrl('/api/auth/forgot-password'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ($('am-forgot-email') && $('am-forgot-email').value.trim()) || '' }),
        });
        const d = await readJsonSafe(r);
        if (!r.ok) throw new Error((d.error && d.error.message) || '发送失败');
        amError('如果邮箱存在，重置链接已发送。');
      } catch (ex) {
        amError(ex.message);
      } finally {
        amBusy(btn, false, '发送重置邮件');
      }
    });

    const goReg = $('am-go-register');
    if (goReg) goReg.addEventListener('click', (e) => { e.preventDefault(); amShowView('register', 'am-reg-name'); });
    const goForgot = $('am-go-forgot');
    if (goForgot) goForgot.addEventListener('click', (e) => { e.preventDefault(); amShowView('forgot', 'am-forgot-email'); });
    const regBack = $('am-register-back');
    if (regBack) regBack.addEventListener('click', (e) => { e.preventDefault(); amShowView('login', 'am-name'); });
    const forgotBack = $('am-forgot-back');
    if (forgotBack) forgotBack.addEventListener('click', (e) => { e.preventDefault(); amShowView('login', 'am-name'); });
  }
  // 每次打开都回到「登录」视图并重新按配置刷新入口:绑定块只在首次执行,放它后面才能
  // 保证「第一次打开弹窗」也渲染第三方图标(放在绑定之前会先跑一遍空配置)。
  amShowView('login');
  // 报错必须在 amShowView 之后:它内部会清空错误框,顺序反了会把调用方传来的提示擦掉
  // (游客额度用尽、登录态失效都靠这条提示说明为什么弹出这个框)。
  amError(message || '');
  if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(modal);
  else modal.classList.remove('hidden');
}
function showGuestBar() {
  const bar = $('guest-bar');
  if (!bar) return;
  const txt = $('guest-bar-text');
  const left = state.user ? state.user.quota : 0;
  if (txt) {
    txt.textContent = (state.isGuestExpired || (Number.isFinite(left) && left <= 0))
      ? '游客体验次数已用完，登录后可继续对话'
      : '您正在以游客身份体验，剩余 ' + left + ' 轮'
        + (state.guestRounds ? '（开通账号可无限使用）' : '');
  }
  bar.classList.remove('hidden');
  const btn = $('guest-bar-login');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => openAuthModal());
  }
}
// 第三方一键登录回跳到主站时的票据消费:
// 落地页是 /(主站),票据在 URL 片段里;用一次性票据换正式登录态。
// 需要补全资料时(后台开启 oauthRequireProfile 且该账号还没设密码)弹补全表单。
async function consumeOauthTicketOnBoot() {
  const hash = String(location.hash || '');
  if (hash.indexOf('oauth_') < 0) return;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const err = params.get('oauth_error');
  const ticket = params.get('oauth_ticket');
  const bound = params.get('oauth_bound');
  const created = params.get('oauth_created') === '1';
  // 片段不发给服务器,读完立刻从地址栏清掉(避免刷新重复消费/泄露)
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 忽略 */ }
  if (err) { setTimeout(() => toast(err, true), 400); return; }
  if (bound) { setTimeout(() => toast('已绑定第三方账号'), 400); return; }
  if (!ticket) return;
  try {
    const r = await fetch(apiUrl('/api/auth/oauth/exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: ticket }),
    });
    const d = await readJsonSafe(r);
    if (!r.ok) throw new Error((d && d.error && d.error.message) || '登录失败');
    state.token = d.token;
    try { localStorage.setItem('oc_token', d.token); } catch (e) { /* 忽略 */ }
    if (d.needsProfile) {
          // 要求补全:先说明「已创建账号,请完善信息」,再弹表单
          setTimeout(() => toast(created
            ? '已用第三方账号创建新账号，请继续完善用户名与密码'
            : '请继续完善用户名与密码'), 400);
          openOauthProfileGate(d.token, d.user);
        } else if (created) {
          const uname = (d.user && d.user.name) ? d.user.name : '';
          setTimeout(() => toast('已用第三方账号创建新账号' + (uname ? '：' + uname : '') + '（可在「设置 → 账户」修改用户名与密码）'), 600);
        }
  } catch (e) {
    setTimeout(() => toast('第三方登录失败：' + ((e && e.message) || '未知错误'), true), 400);
  }
}
// 资料补全弹窗:后台要求补全时,强制填写用户名与密码(之后可脱离第三方登录)
function openOauthProfileGate(token, user) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const closeIcon = (window.OC && OC.icon) ? OC.icon('close', 16) : '';
  mask.innerHTML = '<div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="og-title">'
    + '<div class="modal-header">'
    + '<h3 id="og-title">完善账号信息</h3>'
    + '<button class="icon-btn" type="button" id="og-x" aria-label="关闭">' + closeIcon + '</button>'
    + '</div>'
    + '<div class="modal-body">'
    + '<p class="muted small pg-tip">本站要求补全用户名与密码；完成后你也可以直接用用户名密码登录。</p>'
    + '<label class="field"><span>用户名</span><input type="text" id="og-name" maxlength="32" placeholder="2-32 位（字母/数字/中文/._@-）" autocomplete="off"></label>'
    + '<label class="field"><span>密码（至少 4 位）</span><input type="password" id="og-pwd" autocomplete="new-password"></label>'
    + '<label class="field"><span>确认密码</span><input type="password" id="og-pwd2" autocomplete="new-password"></label>'
    + '<div class="hidden pg-err" id="og-err" role="alert" aria-live="polite"></div>'
    + '</div>'
    + '<div class="modal-footer">'
    + '<button type="button" class="btn primary" id="og-save">保存并进入</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(mask);
  const nameInput = mask.querySelector('#og-name');
  if (nameInput && user && user.name) nameInput.value = user.name;
  const errBox = mask.querySelector('#og-err');
  const showErr = (m) => { errBox.textContent = m; errBox.classList.remove('hidden'); };
  // 已有登录态,选择暂不完善就收起弹窗直接使用(不是死路)
  const xBtn = mask.querySelector('#og-x');
  const rawGateClose = () => mask.remove();
  const gateClose = (window.OCUI && window.OCUI.adoptModal) ? window.OCUI.adoptModal(mask, rawGateClose) : rawGateClose;
  if (xBtn) xBtn.addEventListener('click', gateClose);
  const btn = mask.querySelector('#og-save');
  if (nameInput) nameInput.focus();
  // 用可变变量保存当前 token:设置密码会递增 tv 使旧 token 立即失效(服务端安全设计),
  // 后续请求必须用上一步返回的新 token,否则会「未登录或登录已过期」。
  let activeToken = token;
  const call = (url, body) => fetch(apiUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + activeToken },
    body: JSON.stringify(body),
  }).then((r) => readJsonSafe(r).then((d) => ({ ok: r.ok, d: d })));
  btn.addEventListener('click', async () => {
    const name = (nameInput.value || '').trim();
    const pwd = (mask.querySelector('#og-pwd').value || '');
    const pwd2 = (mask.querySelector('#og-pwd2').value || '');
    if (!name) return showErr('请输入用户名');
    if (pwd.length < 4) return showErr('密码至少 4 位');
    if (pwd !== pwd2) return showErr('两次输入的密码不一致');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r1 = await call('/api/auth/password', { oldPassword: '', newPassword: pwd });
      if (!r1.ok) throw new Error((r1.d && r1.d.error && r1.d.error.message) || '设置密码失败');
      let finalToken = r1.d.token || token;
      if (r1.d.token) activeToken = r1.d.token;
      if (user && name && name !== user.name) {
        const r2 = await call('/api/auth/name', { name: name, password: pwd });
        if (!r2.ok) throw new Error((r2.d && r2.d.error && r2.d.error.message) || '设置用户名失败');
        if (r2.d.token) finalToken = r2.d.token;
      }
      state.token = finalToken;
      try { localStorage.setItem('oc_token', finalToken); } catch (e) { /* 忽略 */ }
      location.reload();
    } catch (e) {
      btn.disabled = false; btn.textContent = '保存并进入';
      showErr((e && e.message) || '保存失败');
    }
  });
}
// 未登录且未开启游客模式:正常显示对话主页(只读),点击输入框/发送弹出登录弹窗
function enterReadonlyHome() {
  state.readonlyGuest = true;
  document.body.classList.add('readonly-guest');
  const composer = document.querySelector('.composer-wrap') || document.querySelector('.composer');
  if (composer) {
    composer.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAuthModal();
    }, true);
  }
  const input = $('input');
  if (input) {
    input.setAttribute('readonly', 'readonly');
    input.addEventListener('focus', (e) => { input.blur(); openAuthModal(); });
  }
  const send = $('send-btn');
  if (send) send.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openAuthModal(); }, true);
  document.querySelectorAll('#new-chat-btn, #assistant-lib-btn, #account-chip').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openAuthModal(); }, true);
  });
}

// ============ 启动 ============
(async function init() {
  initTheme();
  // 第三方一键登录回跳到主站(/):落地页是主站而不是登录页,必须在这里消费票据,
  // 否则票据被丢弃、用户会停在未登录态(此前只有 login.js 处理,导致第三方登录后进不去)。
  await consumeOauthTicketOnBoot();
  if (!state.token) {
    let cfg = null;
    try {
      const cr = await fetch(apiUrl('/api/config'));
      cfg = await readJsonSafe(cr);
    } catch (e) { cfg = null; }
    if (cfg && cfg.guestEnabled) {
      // 开启游客模式:为本次访客自动创建一个独立游客账号,便于后台管理
      try {
        const gr = await fetch(apiUrl('/api/auth/guest'), { method: 'POST' });
        const gd = await readJsonSafe(gr);
        if (gr.ok && gd.token) {
          state.token = gd.token;
          localStorage.setItem('oc_token', gd.token);
          state.isGuest = true;
          state.guestRounds = gd.rounds || 0;
        }
      } catch (e) { /* 落到只读首页 */ }
    }
    if (!state.token) {
      // 未开启游客:直接显示对话主页(不再强制跳转登录页),点击输入框再弹登录
      enterReadonlyHome();
      return;
    }
  }
  try {
    const r = await api('/api/auth/me');
    const data = await r.json();
    // 认证失败时不要跳登录页:第三方登录刚落地时票据可能还在兑换中,这里会短暂失败。
    // 保留 token 并退回只读首页,后续请求会自然恢复(或用户手动登录)。
    if (!r.ok) {
      enterReadonlyHome();
      return;
    }
    state.user = data.user;
    if (state.user && state.user.guest) { state.isGuest = true; state.guestRounds = state.guestRounds || 0; }
    if (data.tools) state.tools = data.tools;
    // 启动时必须带上用量数据,否则设置→用量/账户面板在首次刷新前显示为 0
    state.usage = Array.isArray(data.usage) ? data.usage : [];
    // 设置云同步:先把云端设置(主题/字体/模型选择/群聊配置/生成参数)拉回来并应用,
    // 再加载供应商与会话 —— 新设备首次打开就是熟悉的样子,不必重新设置一遍。
    // 失败(离线/接口异常)时继续用本地设置,不影响使用。
    if (window.OCSettingsSync) {
      try { await window.OCSettingsSync.init(state.user); } catch (e) { /* 本地设置兜底 */ }
    }
    renderUser();
    // 会话正文在本地库(IndexedDB)里,读之前先把库打开、镜像灌满,并把上个版本留在
    // localStorage 里的旧副本迁进来。这一步失败不拦着用:OCStore 会退回 localStorage,
    // 读到的仍是同一份数据(只是又受那 5MB 限制)。
    if (window.OCStore) { try { await window.OCStore.ready([chatsKey(), delCopiesKey()]); } catch (e) { /* 兜底存储 */ } }
    loadChats();
    renderChatList();
    state._scrollHistoryToBottom = true;
    renderMessages();
    renderEmptyState();
    // 云同步:登录后先拉取云端聊天记录并合并(await 保证完成,避免后续盲推覆盖云端)
    await pullChatsFromCloud();
    try { await loadProviders(); } catch (e) { toast('供应商加载失败，已保留登录状态，请稍后重试', true); }
    await loadDefaultAssistant();
    if (ensureDefaultAssistantOnBlank()) {
      saveChats();
      updateAssistantChip();
    }
    resumePendingTasks();
    if (!state.currentProviderId) {
      toast('暂无可用的 API 供应商,请点击左下角「设置」添加,或等待管理员配置', true);
    }
    // 拉取合并后 push 由 saveChats/scheduleCloudSync 增量触发,无需盲推
    updateSendBtn();
    if (typeof syncComposerEffort === 'function') syncComposerEffort();
    if (typeof syncComposerWebSearch === 'function') syncComposerWebSearch();
    if (state.isGuest) showGuestBar();
  } catch (e) {
    // 令牌失效或接口异常:清掉令牌回到只读首页并提示登录,而不是硬跳转到独立登录页
    localStorage.removeItem('oc_token');
    localStorage.removeItem('oc_user');
    state.token = '';
    state.user = null;
    enterReadonlyHome();
    openAuthModal('登录状态已失效，请重新登录');
  }
})();
// ============ @ 其他模型重答(多版本标签页) ============

// 切换到指定版本(绝对下标;供消息顶部的模型标签页使用)
function switchReplyVersionTo(msg, chat, target) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  const live = liveMessage(chat, msg);
  if (!live) return;
  chat = live.chat; msg = live.msg;
  const versions = ensureReplyVersions(msg);
  if (!Number.isInteger(target) || target < 0 || target >= versions.length || target === msg.versionIndex) return;
  persistCurrentReplyVersion(msg);
  msg.versionIndex = target;
  applyReplyVersion(msg, versions[target]);
  chat.updatedAt = Date.now();
  saveChats();
  renderMessages();
}

// 一个回答版本在标签上的展示:和侧栏模型切换同一套 logo 与「供应商@模型」
function replyTabMeta(v, i) {
  const modelId = String((v && v.model) || '').trim();
  const hit = findModelItem(v && v.providerId, modelId);
  // 供应商名写在版本上:刷新时对话先画、供应商后到,列表还没加载也能显示「供应商@模型」
  const providerName = (hit && hit.providerName)
    || (v && v.providerName)
    || providerNameOf((hit && hit.providerId) || (v && v.providerId))
    || '';
  const label = (hit && hit.label)
    || (providerName && modelId ? (providerName + '@' + modelId) : '')
    || modelId
    || ('回答 ' + (i + 1));
  const icon = hit && hit.icon
    ? hit.icon
    : ((window.OC && OC.modelIcon && (modelId + ' ' + providerName))
      ? OC.modelIcon(modelId + ' ' + providerName, providerName, false, false)
      : '');
  return { label, icon };
}
function replyTabButton(meta, active) {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'reply-tab' + (active ? ' active' : '');
  tab.title = '切换到 ' + meta.label + ' 的回答';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', active ? 'true' : 'false');
  tab.innerHTML = (meta.icon && window.OC && OC.logoImg ? OC.logoImg(meta.icon, 'reply-tab-logo') : '')
    + '<span class="reply-tab-label">' + escapeHtml(meta.label) + '</span>';
  return tab;
}
// 放不下的靠左标签收进这个按钮,点开是一份带 logo 的回答列表(和浏览器标签溢出一样)
function openReplyTabList(anchor, versions, current, msg, chat) {
  const items = versions.map((v, i) => {
    const meta = replyTabMeta(v, i);
    return { value: String(i), label: meta.label, icon: meta.icon };
  });
  OC.openSelect(anchor, items, {
    menuClass: 'oc-model-menu reply-tab-menu',
    fitWidth: true,
    searchable: items.length > 8,
    searchPlaceholder: '搜索回答…',
    selected: String(current),
    onSelect: (val) => switchReplyVersionTo(msg, chat, Number(val)),
  });
}
// 消息顶部的模型标签页:浏览器标签风格,显示供应商 logo 与 供应商@模型,点击切换。
// 一条里放不下时,左侧超出的收成展开按钮,点开查看全部回答。
function buildReplyTabs(msg, chat) {
  const versions = ensureReplyVersions(msg);
  const strip = document.createElement('div');
  strip.className = 'reply-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', '不同模型的回答');
  const idx = Math.min(Math.max(0, msg.versionIndex || 0), versions.length - 1);
  const metas = versions.map((v, i) => replyTabMeta(v, i));

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'reply-tab-more';
  more.hidden = true;
  more.title = '查看全部回答';
  more.setAttribute('aria-label', '查看全部回答');
  more.innerHTML = '<span class="reply-tab-more-chev" aria-hidden="true"></span><span class="reply-tab-more-count"></span>';
  more.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openReplyTabList(more, versions, idx, msg, chat);
  });
  strip.appendChild(more);

  const tabs = metas.map((meta, i) => {
    const tab = replyTabButton(meta, i === idx);
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      switchReplyVersionTo(msg, chat, i);
    });
    strip.appendChild(tab);
    return tab;
  });

  // 从左往右藏,直到当前标签和剩下的标签都能排进这一行
  let fitting = false;
  const fit = () => {
    // fit 会改子元素的 hidden,从而改变 strip 自身的宽度:不挡住重入,
    // ResizeObserver 就会被自己触发的尺寸变化反复叫醒,标签条一直抖,
    // 下面的操作栏(含 @)也跟着迟迟定不下来。
    if (fitting) return;
    fitting = true;
    try {
      tabs.forEach((tab) => { tab.hidden = false; });
      more.hidden = true;
      if (strip.scrollWidth <= strip.clientWidth + 1) return;
      more.hidden = false;
      let hidden = 0;
      for (let i = 0; i < tabs.length; i++) {
        if (strip.scrollWidth <= strip.clientWidth + 1) break;
        if (i === idx) continue;
        tabs[i].hidden = true;
        hidden++;
      }
      // 当前标签自己就超宽时,它留在条上(文字省略),其余全部进列表
      if (strip.scrollWidth > strip.clientWidth + 1) {
        tabs.forEach((tab, i) => { if (i !== idx) tab.hidden = true; });
      }
      hidden = tabs.filter((tab) => tab.hidden).length;
      const count = more.querySelector('.reply-tab-more-count');
      if (count) count.textContent = hidden > 0 ? String(hidden) : '';
      more.hidden = hidden === 0;
      more.title = hidden > 0 ? ('还有 ' + hidden + ' 个回答') : '查看全部回答';
    } finally {
      fitting = false;
    }
  };
  if (typeof ResizeObserver === 'function') {
    // 只对「可用宽度」变化重新排版。子元素增删导致的 strip 尺寸抖动不在此列,
    // 否则隐藏/显示标签会再次触发观察,形成自我循环。
    let lastWidth = -1;
    const ro = new ResizeObserver((entries) => {
      const w = entries.length && entries[0].contentRect ? entries[0].contentRect.width : strip.clientWidth;
      if (Math.abs(w - lastWidth) < 1) return;
      lastWidth = w;
      fit();
    });
    ro.observe(strip);
  }
  requestAnimationFrame(fit);
  return strip;
}

// 打开模型选择菜单:选中后以该模型重答当前问题
function openAtAnswerModal(msg, chat, anchorBtn) {
  if (!chat) chat = currentChat();
  if (!msg || !chat || chat.messages.indexOf(msg) < 0) return;
  const items = availableModelItems();
  const total = items.reduce((n, g) => n + g.items.length, 0);
  if (!total) { toast('暂无可用模型', true); return; }
  OC.openSelect(anchorBtn, items, {
    menuClass: 'oc-model-menu',
    fitWidth: true,
    searchable: total > 8,
    searchPlaceholder: '搜索供应商或模型…',
    onSelect: (val) => {
      const parts = String(val).split('\n');
      const providerId = parts[0];
      const modelId = parts.slice(1).join('\n');
      reanswerWithModel(msg, chat, providerId, modelId);
    },
  });
}

// 以指定模型重答:历史仅取该消息之前的上下文,新回答成为该消息的一个可切换版本;
// 后续对话以上方当前选中的回答作为上文(版本内容会同步回消息本身)
async function reanswerWithModel(msg, chat, providerId, modelId) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!chat) chat = currentChat();
  if (!msg || !chat) return;
  // 菜单打开期间云同步可能整段替换过 state.chats:把引用换回当前列表里的活对象,
  // 否则新回答写进被丢弃的旧对象,界面上什么都不显示(表现为 @模型重答不出字)。
  const live = liveMessage(chat, msg);
  if (!live) { toast('找不到原回答', true); return; }
  chat = live.chat; msg = live.msg;
  const n = live.idx;
  if (!chat.messages.slice(0, n).some((m) => m && m.role === 'user')) { toast('找不到原始问题', true); return; }
  if (!providerId || !modelId) return;
  // 同一个模型也可以再答一次:每次 @ 都新开一个标签,再在这个标签里生成
  const savedProv = state.currentProviderId;
  const savedModel = state.currentModel;
  state.currentProviderId = providerId;
  state.currentModel = modelId;
  persistCurrentReplyVersion(msg);
  pushReplyVersion(msg);
  msg.error = false;
  msg.interrupted = false;
  msg.failNote = '';
  msg._startTime = Date.now();
  // 新版本开始生成,会话时间戳随之更新,避免刚重答的内容被云端旧副本合并掉
  chat.updatedAt = Date.now();
  saveChats();
  renderMessages();
  try {
    await requestAssistantReply(chat, { role: 'user', content: '' }, { target: msg, upToIdx: n + 1 });
  } finally {
    state.currentProviderId = savedProv;
    state.currentModel = savedModel;
    renderProviderLabel();
    renderModelPicker();
  }
}

// 多模型并答:一条用户消息,依次问选中的每个模型,各自成为该回答的一个可切换标签。
// 必须串行(requestAssistantReply 有 state.streaming 守卫),好处是全程走流式管线:
// 出字可见、可随时停止,与「@模型重答」体验一致。每个模型各计费一次(用途「多模型对比」)。
async function sendCompareTurn(text, attachments) {
  const picks = (state._compareModels || []).slice(0, 3);
  // 一次性:发送后即失效,后续消息恢复单模型,不会一直问多个模型
  state._compareModels = null;
  const turn = postUserTurn(text, attachments);
  const chat = turn.chat;
  const msg = turn.assistantMsg;
  const savedProv = state.currentProviderId;
  const savedModel = state.currentModel;
  // 一轮多模型对比的整体令牌:用户中途点「停止」时,循环在下一轮开头退出,
  // 不再继续问剩下的模型(每个模型都会真实计费)。
  const turnId = beginTurn();
  try {
    for (let i = 0; i < picks.length; i++) {
      if (turnCancelled(turnId)) break;
      // 第 2 个及以后:在当前回答上追加一个空白版本(标签),写法与 @模型重答一致
      if (i > 0) {
        const live = liveMessage(chat, msg);
        if (!live) break;
        persistCurrentReplyVersion(live.msg);
        pushReplyVersion(live.msg);
        live.msg.error = false;
        live.msg.interrupted = false;
        live.msg.failNote = '';
        live.msg._startTime = Date.now();
        chat.updatedAt = Date.now();
        saveChats();
        renderMessages();
      }
      // pushReplyVersion 与 requestAssistantReply 都从全局 state 取模型,这里临时切换
      state.currentProviderId = picks[i].providerId;
      state.currentModel = picks[i].model;
      renderProviderLabel();
      renderModelPicker();
      const live = liveMessage(chat, msg);
      if (!live) break;
      const n = live.idx;
      try {
        // 单个模型失败不回滚整轮:requestAssistantReply 内部会把该版本标成 error,
        // 标签条照常渲染(带重试按钮),继续问下一个模型。
        await requestAssistantReply(chat, turn.userMsg, {
          target: live.msg,
          upToIdx: n + 1,
          _purpose: 'compare',
        });
      } catch (e) { /* 已由内部标记为错误版本,继续下一个 */ }
    }
    // 全部答完停在第一个模型的回答上,标签顺序即勾选顺序
    const live = liveMessage(chat, msg);
    if (live && Array.isArray(live.msg.versions) && live.msg.versions.length) {
      live.msg.versionIndex = 0;
      applyReplyVersion(live.msg, live.msg.versions[0]);
    }
    chat.updatedAt = Date.now();
    saveChats();
    renderMessages();
  } finally {
    state.currentProviderId = savedProv;
    state.currentModel = savedModel;
    renderProviderLabel();
    renderModelPicker();
  }
}

function groupMentionNames(chat) {
  if (!chat || !chat.groupId || !window.OCGroup || typeof window.OCGroup.groups !== 'function') return [];
  const group = window.OCGroup.groups().find((g) => g && g.id === chat.groupId);
  if (!group) return [];
  const names = [];
  (group.participants || []).forEach((p) => {
    const name = String((p && p.name) || '').trim();
    if (name && names.indexOf(name) < 0) names.push(name);
  });
  names.sort((a, b) => b.length - a.length);
  return names;
}
function highlightGroupMentions(root, chat) {
  if (!root) return;
  const names = groupMentionNames(chat);
  if (!names.length) return;
  const pattern = new RegExp('@(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('pre, code, a, .group-mention, .katex')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.indexOf('@') >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const hits = [];
  while (walker.nextNode()) hits.push(walker.currentNode);
  hits.forEach((node) => {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) return;
    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = pattern.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('span');
      mark.className = 'group-mention';
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  });
}
function buildParticipantTag(m) {
  const p = (m && m.participant) || {};
  const tag = document.createElement('div');
  tag.className = 'participant-tag' + (p.admin ? ' is-admin' : '');
  const name = document.createElement('span');
  name.className = 'participant-name' + (p.admin ? ' is-admin' : '');
  name.textContent = p.name || '成员';
  tag.appendChild(name);
  if (p.stageLabel) {
    const stage = document.createElement('span');
    stage.className = 'participant-stage' + (p.stage ? ' is-' + p.stage : '');
    stage.textContent = p.stageLabel;
    tag.appendChild(stage);
  }
  if (m.model) {
    const model = document.createElement('span');
    model.className = 'participant-model';
    model.textContent = m.model;
    tag.appendChild(model);
  }
  const clock = formatMsgClock(m.createdAt);
  if (clock) {
    const time = document.createElement('span');
    time.className = 'participant-time';
    time.textContent = clock;
    tag.appendChild(time);
  }
  if (p.stage === 'talk' && !m._streaming && m.content) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'participant-pin' + (m.contextBaseline ? ' active' : '');
    pin.textContent = m.contextBaseline ? '本轮基准' : '设为基准';
    pin.title = '之后的提问优先参考这条回答';
    pin.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chat = currentChat();
      if (!chat || !Array.isArray(chat.messages)) return;
      const on = !m.contextBaseline;
      chat.messages.forEach((x) => { if (x) x.contextBaseline = false; });
      m.contextBaseline = on;
      saveChats();
      renderMessages();
    });
    tag.appendChild(pin);
  }
  return tag;
}

// ============ 群聊:成员发言管线 ============
// 由 OCGroup 驱动;与单聊共用流式管线,角色预设经 state._pendingRolePrompt 注入 system。
async function requestGroupReply(chat, participant, stageInfo) {
  if (state.streaming) { toast('正在生成中，请稍候', true); return; }
  if (!state.user || (!quotaIsUnlimited(state.user.quota) && state.user.quota <= 0)) {
    toast('剩余次数不足，请联系管理员', true);
    return;
  }
  const stage = stageInfo || {};
  const placeholder = {
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    participant: {
      name: participant.name,
      emoji: participant.emoji || '',
      avatar: Number(participant.avatar) || 0,
      admin: !!participant.admin,
      stage: stage.stage || '',
      stageLabel: stage.stageLabel || '',
    },
  };
  chat.messages.push(placeholder);
  saveChats();
  renderMessages();
  const savedProv = state.currentProviderId;
  const savedModel = state.currentModel;
  state.currentProviderId = participant.providerId;
  state.currentModel = participant.model;
  state._pendingRolePrompt = participant._rolePrompt || '';
  try {
    await requestAssistantReply(chat, { role: 'user', content: '' }, { target: placeholder, upToIdx: chat.messages.length });
  } finally {
    state.currentProviderId = savedProv;
    state.currentModel = savedModel;
    state._pendingRolePrompt = null;
  }
}

// ============ 对后加载模块(notes.js)的桥接 ============
// notes.js 在 app.js 之后解析,这里把对话模块的能力收口成一个稳定出口;
// aiComplete 是通用的单次非流式补全:辅助模型偏好(notesModel→followupsModel)→当前对话模型。
async function aiComplete(messages, opts = {}) {
  const aux = resolveAuxModel('notesModel') || resolveAuxModel('followupsModel');
  const providerId = aux ? aux.providerId : state.currentProviderId;
  const model = aux ? aux.model : state.currentModel;
  const format = aux ? aux.format : providerFormat();
  if (!providerId || !model) throw new Error('没有可用的模型，请先在模型选择器中选择');
  const body = {
    model,
    providerId,
    stream: false,
    max_tokens: opts.maxTokens || modelCapsNow().out,
    _purpose: opts.purpose || 'note',
    messages,
  };
  const r = await api(ENDPOINT_BY_FORMAT[format] || ENDPOINT_BY_FORMAT.chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await readJsonSafe(r);
  if (!r.ok) throw new Error((data.error && data.error.message) || ('请求失败（HTTP ' + r.status + '）'));
  const text = extractText(data, format) || '';
  if (!text.trim()) throw new Error('模型返回了空内容');
  return text;
}

window.OCApp = {
  state,
  api,
  toast,
  extractText,
  ENDPOINT_BY_FORMAT,
  providerFormat,
  resolveAuxModel,
  aiComplete,
  // 一轮对话的整体取消令牌:多模型对比/群聊是多步循环,
  // 只 abort 当前请求不足以让循环停下,调用方用它们自查是否该整体退出。
  beginTurn,
  turnCancelled,
  // 后加载模块(notes.js)拼提示词时要按模型真实窗口裁剪输入:
  // 弱模型上下文只有 8k~32k,把整段回答硬塞进去会被上游直接拒绝。
  modelCapsNow,
  estimateTextTokens,
  // 群聊自己构造用户消息:复用同一份 @ 引用快照,气泡里的回显与单模型一致
  mentionsSnapshot,
  clearNoteMentionsAfterSend,
};
