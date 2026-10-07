/* 弹窗框架契约自检:
 *   node tests/modal-close.js
 *
 * 锁住两个纯 JS 契约(浏览器里表现为「点了没反应」,但根因在框架层):
 *   1) UI.closeModal 必须把 _onClose 取空后再回调。大量弹窗把 _onClose 设成
 *      「关自己」的 done()(内部再次调用 closeModal),若原样回调就是
 *      closeModal ↔ _onClose 无限互相递归 → RangeError 爆栈;栈溢出抛在点击
 *      处理器里,后面的代码(如「已分享管理」的 setTimeout 打开下一个弹窗)
 *      整段不执行,用户看到按钮是死的。
 *   2) 回调只能触发一次,且回调内部再调 closeModal 必须安全(幂等)。
 * 另检查「开着弹窗时按 Esc 关掉最上层」这条全局链路不被破坏。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'js', 'ui.js'), 'utf8');

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const check = (name, cond) => { if (cond) ok(name); else bad(name); };

// ---- 最小沙箱:收集 document 级监听,提供 css/classList 与定时器 ----
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
const timers = [];
const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  // 同步执行定时器:测试要断言「稍后发生的 class 变化」,异步会难写且不稳
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: (fn) => { timers.push(fn); return 1; },
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: noop,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { pathname: '/', origin: 'http://localhost', protocol: 'http:' },
  navigator: { userAgent: 'node' },
  document: {
    readyState: 'complete',
    body: makeEl(),
    head: makeEl(),
    documentElement: makeEl(),
    createElement: makeEl,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: noop,
    activeElement: null,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// openModal 会用 instanceof HTMLElement 判断是否记住触发元素
sandbox.HTMLElement = class HTMLElement {};
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'ui.js' });
} catch (e) {
  console.error('✗ ui.js 在最小沙箱中执行失败: ' + e.message);
  process.exit(1);
}
const UI = sandbox.OCUI || sandbox.window.OCUI;
if (!UI || typeof UI.openModal !== 'function' || typeof UI.closeModal !== 'function') {
  console.error('✗ ui.js 未导出 OCUI.openModal / closeModal');
  process.exit(1);
}
const drain = () => { while (timers.length) timers.shift()(); };

console.log('== 1. _onClose 内部再关自己:不得爆栈 ==');
{
  const mask = makeEl();
  UI.openModal(mask);
  let calls = 0;
  // 这正是 notes.js 里 done() / closeDlg() 的写法:关自己
  const done = () => { calls++; UI.closeModal(mask); };
  mask._onClose = done;
  let threw = null;
  try { UI.closeModal(mask); } catch (e) { threw = e; }
  check('closeModal 不抛 RangeError' + (threw ? ': ' + threw.message : ''), !threw);
  check('关闭回调只触发一次(实测 ' + calls + ' 次)', calls === 1);
  drain(); // hidden 由 setTimeout 加,同步排空定时器
  check('遮罩进入 hidden 状态', mask._classes.has('hidden'));
}

console.log('\n== 2. 回调内部再调 closeModal 必须幂等 ==');
{
  const mask = makeEl();
  UI.openModal(mask);
  let calls = 0;
  mask._onClose = () => { calls++; UI.closeModal(mask); UI.closeModal(mask); };
  let threw = null;
  try { UI.closeModal(mask); } catch (e) { threw = e; }
  check('多重关闭不抛异常', !threw);
  check('回调仍只触发一次(实测 ' + calls + ' 次)', calls === 1);
}

console.log('\n== 3. 模拟「已分享管理」链路:关掉齿轮后仍能打开下一个弹窗 ==');
{
  const gear = makeEl();
  UI.openModal(gear);
  let opened = false;
  gear._onClose = () => {
    // 真实代码:closeDlg(); setTimeout(openShareManager, 380);
    UI.closeModal(gear);
    try { opened = true; } catch (e) { /* 若爆栈,这里根本到不了 */ }
  };
  let threw = null;
  try { gear._onClose(); } catch (e) { threw = e; }
  check('关闭齿轮后,后续语句照常执行(栈溢出曾把它整段跳过)', !threw && opened);
}

console.log('\n== 4. Esc 仍能关闭最上层弹窗 ==');
{
  const mesc = makeEl();
  UI.openModal(mesc);
  let closed = 0;
  mesc._onClose = () => { closed++; };
  const keydown = (listeners.keydown || []).slice();
  check('已注册 document keydown(Esc 链路存在)', keydown.length > 0);
  if (keydown.length) {
    let prevented = false;
    keydown.forEach((fn) => fn({ key: 'Escape', preventDefault: () => { prevented = true; } }));
    check('Esc 触发了关闭回调', closed === 1);
    check('Esc 阻止了默认行为', prevented);
  }
}

console.log('\n== 5. 回调置空后不再重复触发(同一遮罩两次 closeModal)==');
{
  const m = makeEl();
  UI.openModal(m);
  let n = 0;
  m._onClose = () => { n++; };
  UI.closeModal(m);
  UI.closeModal(m);
  check('两次 closeModal 只回调一次(实测 ' + n + ' 次)', n === 1);
  check('_onClose 已被清空', !m._onClose);
}

console.log('\n== 6. 迟到的入场帧不许把 show 加回已关闭的弹窗(幽灵弹窗)==');
{
  // openModal 靠「下一帧加 show」启动入场过渡,而 rAF 在标签页被挂起时会迟到很久
  // (后台标签页 / 卡顿的渲染进程;CI 的 headless 上实测能晚几秒)。迟到的那一帧若照加不管,
  // 就会把 show 加回一个**已经关掉**的弹窗上 —— 变成 hidden + show 的幽灵:看不见
  // (display:none 优先级更高),却仍在 DOM 里带着 show,`.tb-mask.show` 这类选择器与
  // 「面板还开着吗」的判断全都会认错(工具箱 GUI 用例在 Linux CI 上就是这么红的)。
  // 这里的 rAF 是排队执行的,能精确复现「关掉之后那一帧才到」。
  const g = makeEl();
  UI.openModal(g);          // 入场帧还在队列里
  UI.closeModal(g);         // 没等它跑就关了
  drain();                  // 现在放那一帧进来
  check('关掉后迟到的入场帧不会再加 show', !g._classes.has('show'), [...g._classes].join(' '));
  check('遮罩仍处于 hidden', g._classes.has('hidden'), [...g._classes].join(' '));

  // 反向:正常打开(那一帧在看得到的时候到达)必须照常有 show,别把入场过渡一起修没
  const okEl = makeEl();
  UI.openModal(okEl);
  drain();
  check('正常打开时入场帧照常加 show(过渡没被误伤)', okEl._classes.has('show'), [...okEl._classes].join(' '));

  // 关掉又立刻重开:重开那一代必须拿到 show,不能因为上一代的帧过期就整场不显示
  const re = makeEl();
  UI.openModal(re);
  UI.closeModal(re);
  UI.openModal(re);
  drain();
  check('关掉后立刻重开仍然会显示', re._classes.has('show') && !re._classes.has('hidden'), [...re._classes].join(' '));
}

console.log('\n' + (fail ? `✗ 弹窗框架契约自检失败: ${fail} 项` : '✓ 弹窗框架契约自检通过'));
process.exit(fail ? 1 : 0);
