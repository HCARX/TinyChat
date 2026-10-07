'use strict';
const $ = (id) => document.getElementById(id);

const cacheKey = 'oc_token';

if (window.OCUI && typeof window.OCUI.initTheme === 'function') {
  window.OCUI.initTheme();
}

function showError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  // 登录被「邮箱未验证」挡住时,就地给出重发验证邮件的入口
  const stale = document.getElementById('resend-verify-row');
  if (stale) stale.remove();
  if (/验证邮箱/.test(String(msg))) {
    const row = document.createElement('div');
    row.id = 'resend-verify-row';
    row.style.marginTop = '8px';
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = '重发验证邮件';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      let email = ($('login-name') ? $('login-name').value : '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const typed = (window.OCUI && OCUI.prompt)
          ? await OCUI.prompt({ title: '重发验证邮件', message: '请输入注册时填写的邮箱地址', confirmText: '发送' })
          : window.prompt('请输入注册时填写的邮箱地址', '');
        if (typed === null) return;
        email = String(typed).trim();
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('请先在「用户名」里输入注册邮箱，或点击链接后按提示填写'); return; }
      link.textContent = '发送中…';
      try {
        const r = await fetch(apiUrl('/api/auth/resend-verification'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { showError((d.error && d.error.message) || '发送失败'); return; }
        showError('验证邮件已重新发送，请查收后完成验证再登录');
      } catch (err) {
        showError('网络错误，请稍后再试');
      }
    });
    row.appendChild(link);
    el.appendChild(row);
  }
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}
function clearError() {
  $('auth-error').classList.add('hidden');
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.classList.toggle('is-loading', busy);
  btn.textContent = busy ? '请稍候…' : label;
}

async function submitAuth(api, name, password, btn, label, email, extra) {
  clearError();
  setBusy(btn, true, label);
  try {
    const r = await fetch(apiUrl(api), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(email ? { name, password, email } : { name, password }, typeof extra === 'object' && extra ? extra : {})),
    });
    const data = await r.json();
    if (!r.ok) {
      showError((data.error && data.error.message) || '请求失败');
      return;
    }
    if (data.pendingVerification) {
      showError('注册成功，请查收验证邮件并完成邮箱验证后登录');
      return;
    }
    localStorage.setItem(cacheKey, data.token);
    localStorage.setItem('oc_user', JSON.stringify(data.user));
    location.href = apiUrl('/');
  } catch (e) {
    showError('网络错误: ' + e.message + (location.protocol === 'file:' ? '（file:// 打开时请先设置 localStorage.setItem(\'oc_api_base\', \'http://你的地址:3000\')）' : ''));
  } finally {
    setBusy(btn, false, label);
  }
}

function switchAuthForm(showId, hideId, focusId) {
  ['forgot-form', 'reset-form'].forEach((id) => { const e=$(id); if(e) e.classList.add('hidden'); });
  const show = $(showId);
  const hide = $(hideId);
  if (!show || !hide) return;
  hide.classList.add('hidden');
  show.classList.remove('hidden');
  show.classList.remove('auth-form-switching');
  void show.offsetWidth;
  show.classList.add('auth-form-switching');
  const switchEl = $('login-switch');
  if (switchEl) switchEl.classList.toggle('hidden', showId === 'register-form');
  clearError();
  const focus = $(focusId);
  if (focus) setTimeout(() => focus.focus(), 40);
}

function bindPasswordToggles() {
  // 主站登录弹窗与登录页共用同一份实现(见 ui.js 的 OCUI.bindPasswordToggles):
  // 各写一份的结果是「弹窗修了、登录页没修」这类只在一处复现的缺陷。
  if (window.OCUI && window.OCUI.bindPasswordToggles) return window.OCUI.bindPasswordToggles(document);
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.for);
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
}

const verifyToken = new URLSearchParams(location.search).get('verify');
const resetToken = new URLSearchParams(location.search).get('reset');
// 游客持令牌访问登录页:不重定向,并直接展示注册表单(游客无密码,登录表单对其无用)。
// 若这里把游客弹回首页,从游客条点「注册」就会陷入
// 「跳转登录页 → 判定已登录 → 跳回首页」的死循环,永远进不了注册表单。
let guestSession = false;
function showRegisterForGuest() {
  if (!guestSession) return;
  const reg = $('register-form');
  if (reg && !reg.classList.contains('hidden')) return;   // 已在注册表单
  if ($('show-register')) switchAuthForm('register-form', 'login-form', 'reg-name');
}
if (!verifyToken && !resetToken && localStorage.getItem(cacheKey)) {
  fetch(apiUrl('/api/auth/me'), { headers: { Authorization: 'Bearer ' + localStorage.getItem(cacheKey) } })
    .then((r) => r.ok ? r.json() : Promise.reject())
    .then((d) => {
      if (d && d.user && d.user.guest) { guestSession = true; showRegisterForGuest(); return; }
      location.href = apiUrl('/');
    })
    .catch(() => localStorage.removeItem(cacheKey));
}

fetch(apiUrl('/api/config')).then((r) => r.json()).then((cfg) => {
  // 找回密码依赖邮件功能:开关关闭或未配置 SMTP 时,前台不展示"忘记密码"入口
  if (cfg && (cfg.passwordResetEnabled === false || cfg.mailReady === false)) {
    const forgotLink = $('show-forgot');
    const wrap = forgotLink ? forgotLink.closest('.auth-switch') : null;
    if (wrap) wrap.classList.add('hidden');
  }
  // 站点关闭注册时,隐藏注册切换与注册表单(后端同样会拒绝,这里提前不给入口)
  if (cfg && cfg.allowRegister === false) {
    const showReg = $('show-register');
    const regWrap = showReg ? showReg.closest('.auth-switch') : null;
    if (regWrap) regWrap.classList.add('hidden');
    const reg = $('register-form');
    if (reg) { reg.classList.add('hidden'); }
    const login = $('login-form');
    if (login) login.classList.remove('hidden');
  }
  // 用户协议:启用时注册页展示勾选项
  if (cfg && cfg.agreementEnabled) {
    const row = $('reg-agree-row');
    if (row) row.classList.remove('hidden');
  }
  // 注册邀请码:启用时注册页展示输入框
  if (cfg && cfg.registerInviteRequired) {
    const row = $('reg-invite-row');
    if (row) row.classList.remove('hidden');
  }
  // 第三方一键登录:后台启用的提供商渲染为图标按钮
  renderOauthIcons(cfg && cfg.oauth);
  // 配置就绪后再兜一次(此时注册表单的协议/邀请码等已按需显示)
  showRegisterForGuest();
  // 主站登录弹窗的「立即注册」带 ?register=1 进来,直接展开注册表单
  if (cfg && cfg.allowRegister !== false && new URLSearchParams(location.search).get('register') === '1') {
    switchAuthForm('register-form', 'login-form', 'reg-name');
  }
  if (!cfg || !cfg.needsSetup) return;
  showEnvGate();
}).catch(() => {
  // 配置读取失败(如存储引擎不可用)时同样展示自检,便于定位
  showEnvGate();
});

// 首次安装流程:先展示环境自检,全部通过并点击「下一步」后才进入管理员创建
function showEnvGate() {
  const box = $('env-check-box');
  const setup = $('setup-form');
  const login = $('login-form');
  const reg = $('register-form');
  const sw = $('login-switch');
  if (box) box.classList.remove('hidden');
  if (setup) setup.classList.add('hidden');
  if (login) login.classList.add('hidden');
  if (reg) reg.classList.add('hidden');
  if (sw) sw.classList.add('hidden');
  runEnvCheck();
}
function proceedToSetup() {
  const box = $('env-check-box');
  if (box) box.classList.add('hidden');
  const setup = $('setup-form');
  if (setup) {
    setup.classList.remove('hidden');
    const name = $('setup-name');
    if (name) setTimeout(() => name.focus(), 40);
  }
}
function escLogin(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function runEnvCheck() {
  const box = $('env-check-box');
  const list = $('env-check-list');
  if (!box || !list) return;
  box.classList.remove('hidden');
  list.innerHTML = '<span class="muted">正在检查运行环境…</span>';
  const next = $('env-check-next');
  if (next) next.classList.add('hidden');
  fetch(apiUrl('/api/env-check')).then((r) => r.json()).then((d) => {
    const checks = d.checks || [];
    list.innerHTML = checks.map((c) => {
      const mark = c.ok ? '<span style="color:#16a34a">✓</span>' : (c.critical ? '<span style="color:#dc2626">✗</span>' : '<span style="color:#d97706">△</span>');
      return '<div>' + mark + ' ' + escLogin(c.name) + (c.detail ? ' <span class="muted small">' + escLogin(c.detail) + '</span>' : '') + '</div>';
    }).join('');
    const blocked = (checks || []).some((c) => c.critical && !c.ok);
    const status = $('env-check-status');
    const retry = $('env-check-retry');
    const setup = $('setup-form');
    if (status) status.textContent = blocked
      ? '存在未通过的关键项，请按提示处理后点「重新检查」'
      : '环境检查全部通过';
    if (retry) retry.classList.toggle('hidden', !blocked);
    if (next) next.classList.toggle('hidden', blocked);
    if (setup && !blocked) return; // 等待用户点「下一步」
  }).catch(() => {
    const list2 = $('env-check-list');
    if (list2) list2.innerHTML = '<span style="color:#dc2626">✗ 无法读取环境检查结果，请刷新重试</span>';
  });
}
if ($('env-check-retry')) $('env-check-retry').addEventListener('click', () => runEnvCheck());
if ($('env-check-next')) $('env-check-next').addEventListener('click', () => proceedToSetup());

bindPasswordToggles();
const forgotForm = $('forgot-form');
const resetForm = $('reset-form');
const showForgot = $('show-forgot');
if (showForgot) showForgot.addEventListener('click', (e) => { e.preventDefault(); $('login-form').classList.add('hidden'); $('register-form').classList.add('hidden'); forgotForm.classList.remove('hidden'); clearError(); });
if ($('forgot-back')) $('forgot-back').addEventListener('click', (e) => { e.preventDefault(); forgotForm.classList.add('hidden'); $('login-form').classList.remove('hidden'); });
if (forgotForm) forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 发信慢的时候连点会重复发多封重置邮件:按钮要锁住,失败/成功都要解锁
  const btn = $('forgot-btn');
  setBusy(btn, true, '发送中');
  try {
    const r = await fetch(apiUrl('/api/auth/forgot-password'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('forgot-email').value.trim() }) });
    const d = await r.json();
    if (!r.ok) return showError((d.error && d.error.message) || '发送失败');
    showError('如果邮箱存在，重置链接已发送。');
  } catch (er) {
    showError('发送失败，请检查网络后重试');
  } finally {
    setBusy(btn, false, '发送重置邮件');
  }
});
if (resetToken) { $('login-form').classList.add('hidden'); $('register-form').classList.add('hidden'); resetForm.classList.remove('hidden'); }
if ($('reset-back')) $('reset-back').addEventListener('click', (e) => { e.preventDefault(); resetForm.classList.add('hidden'); $('login-form').classList.remove('hidden'); });
if (resetForm) resetForm.addEventListener('submit', async (e) => { e.preventDefault(); if($('reset-password').value !== $('reset-password2').value)return showError('两次密码不一致'); const r=await fetch(apiUrl('/api/auth/reset-password'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:resetToken,password:$('reset-password').value})}); const d=await r.json(); if(!r.ok)return showError((d.error&&d.error.message)||'重置失败'); showError('密码已重置，请返回登录。'); resetForm.classList.add('hidden'); $('login-form').classList.remove('hidden'); });
if (verifyToken) fetch(apiUrl('/api/auth/verify-email'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: verifyToken }) }).then((r) => r.json().then((d) => r.ok ? showError('邮箱验证成功，请登录') : showError((d.error && d.error.message) || '验证失败'))).catch(() => showError('验证请求失败'));

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth('/api/auth/login', $('login-name').value.trim(), $('login-password').value, $('login-btn'), '登录');
});

if ($('setup-form')) {
  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAuth('/api/setup', $('setup-name').value.trim(), $('setup-password').value, $('setup-btn'), '创建管理员');
  });
}

$('register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth('/api/auth/register', $('reg-name').value.trim(), $('reg-password').value, $('register-btn'), '注册并登录', $('reg-email') ? $('reg-email').value.trim() : '', {
    agreementAccepted: !!($('reg-agree') && $('reg-agree').checked),
    invite: ($('reg-invite') && $('reg-invite').value.trim()) || '',
  });
});

$('show-register').addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthForm('register-form', 'login-form', 'reg-name');
});
$('show-login').addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthForm('login-form', 'register-form', 'login-name');
});


// ============ 第三方一键登录 ============
function renderOauthIcons(oauth) {
  // 与主站登录弹窗共用同一份渲染与跳转逻辑(见 ui.js 的 OCUI.renderOauthIcons)
  if (window.OCUI && window.OCUI.renderOauthIcons) {
    return window.OCUI.renderOauthIcons($('oauth-login'), $('oauth-icons'), oauth && oauth.providers);
  }
  const wrap = $('oauth-login');
  const box = $('oauth-icons');
  if (!wrap || !box) return;
  const providers = (oauth && Array.isArray(oauth.providers)) ? oauth.providers : [];
  if (!providers.length) { wrap.classList.add('hidden'); return; }
  box.innerHTML = providers.map((p) =>
    '<button type="button" class="oauth-icon" data-oauth-go="' + escLogin(p.id) + '" title="使用 ' + escLogin(p.name) + ' 登录">'
    + '<img src="' + escLogin(p.logo) + '" alt="' + escLogin(p.name) + '" loading="lazy"></button>'
  ).join('');
  wrap.classList.remove('hidden');
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-oauth-go]');
    if (!btn) return;
    btn.disabled = true;
    // 整页跳转到授权端点(第三方登录必须离开当前页面)
    location.href = '/auth/' + encodeURIComponent(btn.getAttribute('data-oauth-go'));
  });
}
// 回调回来时前端消费一次性票据/错误(# 片段不发给服务器,读完立刻清掉)
(function consumeOauthFragment() {
  const hash = String(location.hash || '');
  if (!hash || hash.indexOf('oauth_') < 0) return;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const err = params.get('oauth_error');
  const ticket = params.get('oauth_ticket');
  const created = params.get('oauth_created') === '1';
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 忽略 */ }
  if (err) { showError(err); return; }
  if (!ticket) return;
  setBusy($('login-btn'), true, '登录');
  fetch(apiUrl('/api/auth/oauth/exchange'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: ticket }),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, d: d }))).then((res) => {
    if (!res.ok) throw new Error((res.d.error && res.d.error.message) || '登录失败');
    try { localStorage.setItem(cacheKey, res.d.token); } catch (e) { /* 忽略 */ }
    // 后台要求补全资料、且该账号还没有密码时,进入补全流程(补全后可脱离第三方登录)
    if (res.d.needsProfile) {
      // 新建账号时先明确告知,避免用户不知道自己已被创建
      showError(created ? '已用第三方账号创建新账号，请继续完善用户名与密码' : '请继续完善用户名与密码');
      showProfileGate(res.d.token, res.d.user);
      return;
    }
    location.replace('/');
  }).catch((e) => {
    setBusy($('login-btn'), false, '登录');
    showError(e.message || '登录失败');
  });
})();

// —— 第三方登录后的资料补全(用户名 + 密码) ——
function showProfileGate(token, user) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="pg-title">'
    + '<div class="modal-header">'
    + '<h3 id="pg-title">完善账号信息</h3>'
    + '<button class="icon-btn" type="button" id="pg-x" aria-label="关闭">'
    + '<svg class="oc-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke-linecap="round"/></svg>'
    + '</button>'
    + '</div>'
    + '<div class="modal-body">'
    + '<p class="muted small pg-tip">本站要求补全用户名与密码，之后你也可以直接用用户名密码登录。</p>'
    + '<label class="field"><span>用户名</span><input type="text" id="pg-name" maxlength="32" value="" placeholder="2-32 位（字母/数字/中文/._@-）" autocomplete="off"></label>'
    + '<label class="field"><span>密码（至少 4 位）</span><input type="password" id="pg-pwd" autocomplete="new-password"></label>'
    + '<label class="field"><span>确认密码</span><input type="password" id="pg-pwd2" autocomplete="new-password"></label>'
    + '<div class="hidden pg-err" id="pg-err" role="alert" aria-live="polite"></div>'
    + '</div>'
    + '<div class="modal-footer">'
    + '<button type="button" class="btn primary" id="pg-save">保存并进入</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(mask);
  const nameInput = mask.querySelector('#pg-name');
  if (nameInput && user && user.name) nameInput.value = user.name;
  const errBox = mask.querySelector('#pg-err');
  const showErr = (m) => { errBox.textContent = m; errBox.classList.remove('hidden'); };
  // 已拿到登录态:选择暂不完善时直接进站,不要把人留在登录页
  const xBtn = mask.querySelector('#pg-x');
  if (xBtn) xBtn.addEventListener('click', () => location.replace('/'));
  const btn = mask.querySelector('#pg-save');
  if (nameInput) nameInput.focus();
  btn.addEventListener('click', async () => {
    const name = (nameInput.value || '').trim();
    const pwd = (mask.querySelector('#pg-pwd').value || '');
    const pwd2 = (mask.querySelector('#pg-pwd2').value || '');
    if (!name) return showErr('请输入用户名');
    if (pwd.length < 4) return showErr('密码至少 4 位');
    if (pwd !== pwd2) return showErr('两次输入的密码不一致');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      // 设密码会使旧 token 立即失效(tv 递增),后续请求必须用返回的新 token
      let activeToken = token;
      const call = (url, body) => fetch(apiUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + activeToken },
        body: JSON.stringify(body),
      }).then((r) => r.json().then((d) => ({ ok: r.ok, d: d })));
      // 先设密码,再改用户名(两者都返回新 token,保留最后一次)
      const r1 = await call('/api/auth/password', { oldPassword: '', newPassword: pwd });
      if (!r1.ok) throw new Error((r1.d.error && r1.d.error.message) || '设置密码失败');
      let finalToken = r1.d.token || token;
      if (r1.d.token) activeToken = r1.d.token;
      if (user && name && name !== user.name) {
        const r2 = await call('/api/auth/name', { name: name, password: pwd });
        if (!r2.ok) throw new Error((r2.d.error && r2.d.error.message) || '设置用户名失败');
        if (r2.d.token) finalToken = r2.d.token;
      }
      try { localStorage.setItem(cacheKey, finalToken); } catch (e) { /* 忽略 */ }
      location.replace('/');
    } catch (e) {
      btn.disabled = false; btn.textContent = '保存并进入';
      showErr(e.message || '保存失败');
    }
  });
}
