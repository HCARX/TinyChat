/* 注册邮箱必填标签契约自检:
 *   node tests/register-email-label.js
 *
 * 后台开启「邮箱验证」后,注册接口会拒掉空邮箱(tc_api_register),可注册表单的标签
 * 一直写着「邮箱（可选）」—— 用户照着「可选」留空提交,只会换来一句后端报错。
 * 这里锁住三件事:
 *   1) UI.applyEmailRequirement 的行为:开则标签去掉「(可选)」并给输入框补 required,关则还原;
 *   2) 两处注册表单都接了这条链路 —— 登录页(/login)与主站登录弹窗(index.html),
 *      各处必须同时有带 id 的标签 span 与调用点。少接一处时行为照旧、界面只是「提示不对」,
 *      读 diff 极易看漏;
 *   3) /api/config 仍下发 emailVerificationEnabled —— 前台拿不到这个字段就无从判断。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (name, cond) => { if (cond) ok(name); else bad(name); };

// ---- 最小沙箱:只为把 ui.js 这个 IIFE 跑起来,导出 OCUI ----
const noop = () => {};
const listeners = {};
const makeEl = () => {
  const classes = new Set();
  return {
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    _classes: classes,
    addEventListener: noop, removeEventListener: noop, appendChild: noop,
    querySelector: () => null, querySelectorAll: () => [], remove: noop,
    setAttribute: noop, getAttribute: () => null,
    style: { outline: '', setProperty: noop, removeProperty: noop, getPropertyValue: () => '' },
    dataset: {}, innerHTML: '', textContent: '', value: '',
    offsetWidth: 0, offsetHeight: 0, getClientRects: () => [], focus: noop,
    isConnected: true,
  };
};
const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: () => 1,
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: noop,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { pathname: '/', origin: 'http://localhost', protocol: 'http:' },
  navigator: { userAgent: 'node' },
  document: {
    readyState: 'complete',
    body: makeEl(), head: makeEl(), documentElement: makeEl(),
    createElement: makeEl,
    getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: noop,
    activeElement: null,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.HTMLElement = class HTMLElement {};
vm.createContext(sandbox);
try {
  vm.runInContext(read('static/js/ui.js'), sandbox, { filename: 'ui.js' });
} catch (e) {
  console.error('✗ ui.js 在最小沙箱中执行失败: ' + e.message);
  process.exit(1);
}
const UI = sandbox.OCUI;
if (!UI || typeof UI.applyEmailRequirement !== 'function') {
  console.error('✗ ui.js 未导出 OCUI.applyEmailRequirement');
  process.exit(1);
}

console.log('== 1. 开启邮箱验证:标签去掉「(可选)」且输入框必填 ==');
{
  const label = makeEl();
  const input = makeEl();
  label.textContent = '邮箱（可选）';
  UI.applyEmailRequirement(label, input, true);
  check('标签变成「邮箱」', label.textContent === '邮箱', '实际: ' + label.textContent);
  check('输入框被置为必填', input.required === true, '实际: ' + input.required);
}

console.log('\n== 2. 未开启(或读不到配置):保持「可选」且不拦提交 ==');
{
  const label = makeEl();
  const input = makeEl();
  // 先按「已开启」跑一遍,再关掉:必须能还原,否则开关来回切会粘住上一次的文案
  UI.applyEmailRequirement(label, input, true);
  UI.applyEmailRequirement(label, input, false);
  check('标签还原为「邮箱（可选）」', label.textContent === '邮箱（可选）', '实际: ' + label.textContent);
  check('输入框不再必填', input.required === false, '实际: ' + input.required);
  const l2 = makeEl(); const i2 = makeEl();
  UI.applyEmailRequirement(l2, i2, undefined);   // cfg 读失败时传的是 undefined
  check('required 传 undefined 时按「可选」处理', l2.textContent === '邮箱（可选）' && i2.required === false);
}

console.log('\n== 3. 两处注册表单都接了这条链路 ==');
{
  // 登录页:/login
  const loginHtml = read('login.html');
  const loginJs = read('static/js/login.js');
  check('login.html 的邮箱标签有 id', /<span id="reg-email-label">/.test(loginHtml));
  check('login.js 调用了 applyEmailRequirement', /applyEmailRequirement\(\$\('reg-email-label'\), \$\('reg-email'\)/.test(loginJs));
  check('login.js 依据 emailVerificationEnabled 判断', /emailVerificationEnabled/.test(loginJs));

  // 主站登录弹窗:index.html + app.js
  const indexHtml = read('index.html');
  const appJs = read('static/js/app.js');
  check('index.html 的邮箱标签有 id', /<span id="am-reg-email-label">/.test(indexHtml));
  check('app.js 调用了 applyEmailRequirement', /applyEmailRequirement\(\$\('am-reg-email-label'\), \$\('am-reg-email'\)/.test(appJs));
  check('app.js 依据 emailVerificationEnabled 判断', /emailVerificationEnabled/.test(appJs));

  // 标签的默认文案必须是「可选」:未开启邮箱验证的站点占多数,占位文案不能反过来
  check('login.html 默认文案仍是「邮箱（可选）」', /<span id="reg-email-label">邮箱（可选）<\/span>/.test(loginHtml));
  check('index.html 默认文案仍是「邮箱（可选）」', /<span id="am-reg-email-label">邮箱（可选）<\/span>/.test(indexHtml));
}

console.log('\n== 4. /api/config 仍下发 emailVerificationEnabled ==');
{
  const api = read('lib/api.php');
  check('公共配置里带 emailVerificationEnabled', /'emailVerificationEnabled' =>/.test(api));
}

console.log('\n' + (fail ? `✗ 注册邮箱必填标签契约自检失败: ${fail} 项` : '✓ 注册邮箱必填标签契约自检通过'));
process.exit(fail ? 1 : 0);
