<?php
/**
 * 在线工具箱「第二版」内置工具(设计系统 + 共用运行时 + 逐套工具)。
 *
 * 与 lib/toolbox-default.php 的分工:
 *   - toolbox-default.php = **2.0.145/2.0.151 出厂原样(冻结)**。它保留 v1 包装(带 1px 描边的
 *     老样式 + 原生下拉)与 v2 包装(自绘下拉),唯一用途是让升级迁移能按字节认出「这套工具
 *     还是出厂原文吗」。里面的常量一个字节都不要动。
 *   - 本文件 = 当前出厂内容。整套视觉按站内设计系统重做(浅深两套 token、无描边圆角控件),
 *     工具本身也逐套重写。
 *
 * 工具页跑在**不透明源的沙箱**里(iframe sandbox / CSP sandbox),拿不到宿主的样式、脚本与
 * 存储。所以:样式与运行时都内联进每一页;页面里不得出现 localStorage / document.cookie /
 * sessionStorage;不得引外部资源(断网、内网都要能跑)。这些都由 tests/toolbox.php 钉着。
 *
 * 每套工具一个文件,见 lib/toolbox-tools/*.php —— 新加一套只要丢一个文件进去,不用改清单
 * (装配时按文件名排序,文件名前缀就是展示顺序)。
 */

// ============ 设计系统 ============
// 与站内 static/css/style.css 的 token 同一套取值(近白画布 + 白色面板 + 苹果灰阶 + 单一强调色)。
// 站内控件按「浅色为默认、深色覆盖」写;工具页拿不到宿主的 [data-theme],所以由运行时把
// prefers-color-scheme(以及宿主通过 postMessage 传进来的主题)落到 <html data-oc-theme> 上,
// CSS 只需两套 token,不必把深色规则写成 media query 再抄一份。
//
// 关于「不得使用带描边的矩形」:全篇没有 border。分层靠**底色 + 极淡 hairline(1px 内阴影)
// + 投影**,与站内 .composer(background + 1px solid var(--hairline))是同一套观感 ——
// 一圈看得见的灰边(旧版 #d0d5dd)正是这次要换掉的东西。
const TC_TOOLBOX_V3_CSS = <<<'CSS3'
*,*::before,*::after{box-sizing:border-box}
/* [hidden] 要压得住组件自己的 display:设计系统里 .f/.btn 等都设了 display,
   作者样式优先于浏览器默认的 [hidden]{display:none},不加这条 hidden 会失效 */
[hidden]{display:none!important}
:root{
  color-scheme:light;
  --bg-app:#fcfcfc;--bg-surface:#fff;--bg-soft:#f2f2f4;--bg-input:#f2f2f4;--bg-input-focus:#fff;--bg-code:rgba(0,0,0,.055);
  --text:#1d1d1f;--t2:#6e6e73;--t3:#86868b;
  --hairline:rgba(0,0,0,.07);--hairline-2:rgba(0,0,0,.12);
  --brand:#0071e3;--brand-ink:#fff;--ring:rgba(0,113,227,.18);
  --primary:#1d1d1f;--primary-ink:#fff;
  --ok:#1a9c48;--warn:#b26a00;--danger:#e0241a;--danger-bg:rgba(255,59,48,.1);
  --r-xs:6px;--r-sm:8px;--r:12px;--r-lg:16px;--r-xl:22px;--r-pill:999px;
  --sh-xs:0 1px 2px rgba(0,0,0,.05);--sh-sm:0 2px 10px rgba(0,0,0,.07);
  --sh-md:0 8px 30px rgba(0,0,0,.1);--sh-pop:0 12px 44px rgba(0,0,0,.16);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --fs:14px;
}
html[data-oc-theme="dark"]{
  color-scheme:dark;
  --bg-app:#000;--bg-surface:#1d1d1f;--bg-soft:#232326;--bg-input:#232326;--bg-input-focus:#2c2c2e;--bg-code:rgba(255,255,255,.08);
  --text:#f5f5f7;--t2:#98989d;--t3:#6e6e73;
  --hairline:rgba(255,255,255,.08);--hairline-2:rgba(255,255,255,.16);
  --brand:#2997ff;--ring:rgba(41,151,255,.24);
  --primary:#f5f5f7;--primary-ink:#1d1d1f;
  --ok:#4ad07a;--warn:#f0b24a;--danger:#ff6b60;--danger-bg:rgba(255,69,58,.16);
  --sh-xs:0 1px 2px rgba(0,0,0,.3);--sh-sm:0 2px 10px rgba(0,0,0,.4);
  --sh-md:0 8px 30px rgba(0,0,0,.5);--sh-pop:0 12px 44px rgba(0,0,0,.6);
}
html,body{margin:0}
body{
  background:var(--bg-app);color:var(--text);font-size:var(--fs);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  line-height:1.6;letter-spacing:-.01em;padding:20px 22px 40px;
  -webkit-font-smoothing:antialiased;
}
::selection{background:var(--brand);color:#fff}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(128,128,128,.28);border-radius:8px}
::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.45)}
h1{font-size:1.214rem;font-weight:650;margin:0 0 3px;letter-spacing:-.02em}
h2{font-size:.893rem;font-weight:600;margin:0 0 8px;color:var(--t2)}
p{margin:0}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
/* 页头:标题 + 一句话说明,右侧可放操作 */
.hd{display:flex;align-items:flex-start;gap:14px;margin:0 0 16px;flex-wrap:wrap}
.hd .sub{color:var(--t2);font-size:.857rem;margin-top:2px}
.hd .grow{flex:1;min-width:200px}
.hd .acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* 卡片:面板层。没有边框,靠底色差与极淡投影分层 */
.card{background:var(--bg-surface);border-radius:var(--r-lg);padding:14px 16px;box-shadow:var(--sh-xs)}
.card + .card{margin-top:12px}
.card-h{display:flex;align-items:center;gap:10px;margin:0 0 10px;flex-wrap:wrap}
.card-h h2{margin:0}
.card-h .grow{flex:1}
/* 两栏 / 多栏 */
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;align-items:start}
.cols.tight{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.span2{grid-column:1/-1}
/* 表单 */
label,.lab{font-size:.857rem;color:var(--t2);font-weight:500}
.lab{display:block;margin:0 0 6px}
input[type=text],input[type=number],input[type=search],input[type=password],textarea,select{
  font:inherit;width:100%;padding:9px 11px;color:inherit;background:var(--bg-input);
  border:0;border-radius:var(--r-sm);box-shadow:none;
  transition:background .15s,box-shadow .15s;appearance:none;-webkit-appearance:none;
}
input[type=number]{font-variant-numeric:tabular-nums}
textarea{min-height:132px;resize:vertical;font-family:var(--mono);font-size:.929rem;line-height:1.6;white-space:pre;overflow-wrap:normal;overflow-x:auto}
textarea.wrap{white-space:pre-wrap;overflow-wrap:anywhere}
input:focus,textarea:focus,select:focus{outline:none;background:var(--bg-input-focus);box-shadow:0 0 0 4px var(--ring)}
input::placeholder,textarea::placeholder{color:var(--t3)}
input[type=checkbox],input[type=radio]{width:auto;appearance:auto;-webkit-appearance:auto;accent-color:var(--brand);margin:0}
/* 行内控件成组 */
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row + .row{margin-top:8px}
.row.mt{margin-top:12px}
.row .sp{flex:1}
.f{display:flex;flex-direction:column;gap:6px}
.f > .lab{margin:0}
/* 按钮:无描边圆角矩形,按下有回弹 */
button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;border-radius:var(--r-sm);
  background:var(--bg-soft);color:var(--text);font-weight:500;box-shadow:var(--sh-xs);
  transition:background .14s,transform .1s,box-shadow .14s;white-space:nowrap}
.btn:hover{background:var(--bg-code)}
.btn:active{transform:scale(.97)}
.btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.btn.p{background:var(--primary);color:var(--primary-ink);box-shadow:none;font-weight:600}
.btn.p:hover{filter:brightness(1.12)}
.btn.accent{background:var(--brand);color:#fff;box-shadow:none;font-weight:600}
.btn.accent:hover{filter:brightness(1.08)}
.btn.danger{background:var(--danger-bg);color:var(--danger);box-shadow:none}
.btn.danger:hover{background:var(--danger);color:#fff}
.btn.ghost{background:transparent;box-shadow:none;color:var(--t2)}
.btn.ghost:hover{background:var(--bg-code);color:var(--text)}
.btn.sm{padding:5px 10px;font-size:.857rem;border-radius:var(--r-xs)}
.btn.xs{padding:3px 8px;font-size:.786rem;border-radius:var(--r-xs)}
.btn.icon{padding:8px;border-radius:var(--r-pill)}
.btn[disabled],.btn.disabled{opacity:.45;pointer-events:none}
.btn.act{background:var(--brand);color:#fff;box-shadow:none}
.link{background:none;color:var(--brand);padding:0;font-weight:500}
.link:hover{text-decoration:underline}
/* 分段控件(视图/模式切换) */
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:var(--r-sm);background:var(--bg-code);box-shadow:none}
.seg-btn{padding:5px 12px;border-radius:var(--r-xs);color:var(--t2);font-size:.893rem;transition:background .14s,color .14s}
.seg-btn:hover{color:var(--text)}
.seg-btn.on{background:var(--bg-surface);color:var(--text);font-weight:600;box-shadow:var(--sh-xs)}
html[data-oc-theme="dark"] .seg-btn.on{background:#2c2c2e}
/* 小标签 / 圆点 */
.tag{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:var(--r-pill);background:var(--bg-code);color:var(--t2);font-size:.786rem}
.tag.ok{background:rgba(26,156,72,.12);color:var(--ok)}
.tag.bad{background:var(--danger-bg);color:var(--danger)}
.tag.brand{background:rgba(0,113,227,.12);color:var(--brand)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--t3);flex:0 0 auto}
/* 状态文字 */
.msg{font-size:.857rem;color:var(--t2)}
.msg.ok{color:var(--ok)}.msg.bad{color:var(--danger)}.msg.warn{color:var(--warn)}
/* 统计块 */
.stats{display:flex;gap:8px;flex-wrap:wrap}
.stat{background:var(--bg-soft);border-radius:var(--r);padding:7px 11px;min-width:74px}
.stat .k{font-size:.75rem;color:var(--t3)}
.stat .v{font-family:var(--mono);font-size:.929rem;font-variant-numeric:tabular-nums}
/* 列表:行与行之间靠留白,不画线 */
.rows{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto;padding:2px}
.rows.tall{max-height:460px}
.it{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--r-sm);background:var(--bg-soft)}
.it:hover{background:var(--bg-code)}
.it .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.it.sel{background:rgba(0,113,227,.12)}
/* 表格:斑马纹代替竖线横线 */
table{border-collapse:collapse;width:100%;font-size:.893rem}
th,td{padding:7px 10px;text-align:left;vertical-align:top}
th{font-size:.786rem;font-weight:600;color:var(--t3);text-transform:none}
tbody tr:nth-child(odd){background:var(--bg-soft)}
tbody tr:hover{background:var(--bg-code)}
td.num,th.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
/* 代码/等宽块 */
.code{font-family:var(--mono);font-size:.893rem;background:var(--bg-code);border-radius:var(--r);padding:10px 12px;
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}
.mono{font-family:var(--mono);font-size:.893rem}
.brk{word-break:break-all;overflow-wrap:anywhere}
/* 拖放区:底色 + 图标,不画虚线框 */
.drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:112px;padding:18px;
  border-radius:var(--r-lg);background:var(--bg-soft);color:var(--t2);text-align:center;cursor:pointer;
  transition:background .16s,box-shadow .16s}
.drop:hover{background:var(--bg-code)}
.drop.over{background:rgba(0,113,227,.1);box-shadow:inset 0 0 0 1px var(--brand)}
.drop b{color:var(--text);font-weight:600}
.drop .hint{font-size:.786rem;color:var(--t3)}
/* 滑杆 */
input[type=range]{appearance:none;-webkit-appearance:none;width:100%;height:22px;background:none;padding:0;box-shadow:none;margin:0}
input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:var(--r-pill);
  background:linear-gradient(90deg,var(--brand) var(--p,50%),var(--bg-code) var(--p,50%))}
input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:18px;height:18px;margin-top:-6px;
  border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3),inset 0 0 0 1px var(--hairline-2)}
html[data-oc-theme="dark"] input[type=range]::-webkit-slider-thumb{background:#f5f5f7}
input[type=range]::-moz-range-track{height:6px;border-radius:var(--r-pill);background:var(--bg-code)}
input[type=range]::-moz-range-progress{height:6px;border-radius:var(--r-pill);background:var(--brand)}
input[type=range]::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3)}
/* 取色:一个色块 + 一个十六进制输入,色块本身不带描边 */
.cf{display:flex;align-items:center;gap:8px}
.cf input[type=color]{width:38px;height:36px;padding:0;border:0;border-radius:var(--r-sm);background:none;cursor:pointer;
  box-shadow:var(--sh-xs)}
.cf input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.cf input[type=color]::-webkit-color-swatch{border:0;border-radius:var(--r-sm)}
.swatch{border-radius:var(--r);min-height:64px;box-shadow:var(--sh-sm)}
/* 棋盘格(透明预览) */
.checker{border-radius:var(--r);padding:12px;background:
  repeating-conic-gradient(rgba(128,128,128,.14) 0 25%,transparent 0 50%) 0 0/16px 16px}
/* 预览容器 */
.pv{display:flex;align-items:center;justify-content:center;min-height:120px;padding:14px;border-radius:var(--r-lg);
  background:var(--bg-soft);overflow:auto}
.pv img,.pv canvas{max-width:100%;height:auto;display:block;border-radius:var(--r-sm)}
/* 空状态 */
.empty{padding:26px 14px;text-align:center;color:var(--t3);font-size:.893rem}
/* 提示条 */
.toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,14px);z-index:80;
  background:rgba(29,29,31,.94);color:#fff;padding:9px 16px;border-radius:var(--r-pill);
  font-size:.893rem;box-shadow:var(--sh-pop);opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:80vw}
.toast.on{opacity:1;transform:translate(-50%,0)}
html[data-oc-theme="dark"] .toast{background:rgba(245,245,247,.95);color:#1d1d1f}
.toast.bad{background:rgba(200,32,24,.96);color:#fff}
/* 自绘下拉(原生 select 留在 DOM 里当取值载体) */
.oc-sel{position:relative;display:inline-flex;align-items:center;justify-content:space-between;gap:8px;
  min-width:112px;padding:9px 11px;border-radius:var(--r-sm);background:var(--bg-input);color:inherit;
  font:inherit;cursor:pointer;user-select:none;-webkit-user-select:none;
  box-shadow:none;transition:background .14s,box-shadow .14s}
.oc-sel:hover{background:var(--bg-code)}
.oc-sel:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.oc-sel[aria-expanded="true"]{background:var(--bg-input-focus);box-shadow:0 0 0 4px var(--ring)}
.oc-sel.disabled{opacity:.5;cursor:default;pointer-events:none}
.oc-sel-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oc-sel-arrow{display:flex;flex-shrink:0;color:var(--t3);transition:transform .16s}
.oc-sel[aria-expanded="true"] .oc-sel-arrow{transform:rotate(180deg)}
.oc-sel-menu{position:fixed;z-index:90;min-width:120px;max-height:min(300px,60vh);overflow:auto;padding:5px;
  border-radius:var(--r);background:var(--bg-surface);box-shadow:var(--sh-pop);
  animation:ocFade .12s ease-out}
@keyframes ocFade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.oc-sel-item{padding:7px 10px;border-radius:var(--r-xs);font-size:.929rem;cursor:pointer;white-space:nowrap}
.oc-sel-item:hover{background:var(--bg-code)}
.oc-sel-item.on{background:rgba(0,113,227,.12);color:var(--brand);font-weight:600}
@media(max-width:640px){
  body{padding:14px 14px 32px}
  .cols{grid-template-columns:1fr}
  .hd{margin-bottom:12px}
}
CSS3;

// ============ 共用运行时 ============
/**
 * 工具页自带的运行时。三件事:主题(站内主题要能传进来)、自绘下拉、以及一组小工具
 * (toast / 复制 / 文件读取 / 分段控件 / 滑杆填充 / 打开图片)。
 *
 * 关于导出:工具页在沙箱里,`<a download>` 与 showSaveFilePicker 都被沙箱拦掉
 * (实测:两者都不产生下载、后者抛 SecurityError)。能用的只有两条:
 *   1) URL.createObjectURL(blob) 后用 window.open 开新标签页(实测可导航,blob:null/…),
 *      用户在那边按 Ctrl+S 或右键另存;
 *   2) 右键图片 → 图片另存为(浏览器自带菜单,沙箱不影响)。
 * 所以 OC.saveImage() 走第 1 条,并在界面上写明第 2 条。
 *
 * 注:下面 function closeMenu() / sel.style.display = 'none' /
 * dispatchEvent(new Event('change', { bubbles: true })) 三处是 tests/toolbox.php 用来认
 * 「这套工具注入了且只注入一份下拉运行时」的标记,改名要同步改测试。
 */
const TC_TOOLBOX_V3_UI_JS = <<<'UI3'
(function () {
  var doc = document, root = doc.documentElement;
  var OC = window.OC = window.OC || {};

  // ---- 主题:先按系统偏好定,宿主的主题随后可以覆盖(面板预览用它对齐站内观感) ----
  function applyTheme(mode) {
    if (mode === 'dark' || mode === 'light') root.setAttribute('data-oc-theme', mode);
  }
  OC.setTheme = applyTheme;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme:dark)') : null;
  var m = /[?&]theme=(dark|light)/.exec(location.search);
  applyTheme(m ? m[1] : (mq && mq.matches ? 'dark' : 'light'));
  if (mq) {
    var onMq = function (e) { if (!root.getAttribute('data-oc-theme-lock')) applyTheme(e.matches ? 'dark' : 'light'); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || typeof d !== 'object' || !d.ocTheme) return;
    root.setAttribute('data-oc-theme-lock', '1');   // 宿主说了算,不再跟随系统
    applyTheme(d.ocTheme);
  });

  // ---- toast ----
  var toastEl = null, toastTimer = 0;
  OC.toast = function (text, kind) {
    if (!toastEl) { toastEl = doc.createElement('div'); toastEl.className = 'toast'; doc.body.appendChild(toastEl); }
    toastEl.textContent = text;
    toastEl.className = 'toast on' + (kind === 'bad' ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast' + (kind === 'bad' ? ' bad' : ''); }, 2000);
  };
  // 就地状态文字(配合 .msg 用)
  OC.say = function (el, text, kind) {
    var n = typeof el === 'string' ? doc.querySelector(el) : el;
    if (!n) return;
    n.textContent = text || '';
    n.className = 'msg' + (kind ? ' ' + kind : '');
  };

  // ---- 复制:优先异步剪贴板,失败退回 execCommand(旧版工具一直这么兜底) ----
  OC.copy = function (text, okMsg) {
    text = String(text == null ? '' : text);
    if (!text) { OC.toast('没有可复制的内容', 'bad'); return; }
    var done = function () { OC.toast(okMsg || '已复制'); };
    var fallback = function () {
      var ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
      doc.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      doc.body.removeChild(ta);
      if (ok) done(); else OC.toast('复制被浏览器拒绝，请手动选择', 'bad');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  };
  OC.copyNode = function (el, okMsg) {
    var n = typeof el === 'string' ? doc.querySelector(el) : el;
    OC.copy(n ? (n.value != null ? n.value : n.textContent) : '', okMsg);
  };

  // ---- 文件读取 ----
  OC.readFile = function (file, as) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = function () { rej(fr.error || new Error('读取失败')); };
      fr.onload = function () { res(fr.result); };
      if (as === 'dataURL') fr.readAsDataURL(file);
      else if (as === 'buffer') fr.readAsArrayBuffer(file);
      else fr.readAsText(file);
    });
  };
  OC.fmtBytes = function (n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  };
  // 拖放/点选:不画虚线框,靠底色变化提示
  OC.drop = function (zone, onFiles, opt) {
    var z = typeof zone === 'string' ? doc.querySelector(zone) : zone;
    if (!z) return;
    opt = opt || {};
    var input = doc.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (opt.multiple) input.multiple = true;
    if (opt.accept) input.accept = opt.accept;
    z.appendChild(input);
    function take(files) { if (files && files.length) onFiles(opt.multiple ? [].slice.call(files) : [files[0]]); }
    z.addEventListener('click', function () { input.value = ''; input.click(); });
    input.addEventListener('change', function () { take(input.files); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      z.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'dragleave' && z.contains(e.relatedTarget)) return; z.classList.remove('over'); });
    });
    z.addEventListener('drop', function (e) { if (e.dataTransfer) take(e.dataTransfer.files); });
    return input;
  };
  // 打开图片:沙箱里没有下载权限,能走的只有 blob 新标签页(见文件头说明)
  OC.openBlob = function (blob) {
    var url = URL.createObjectURL(blob);
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (!w) OC.toast('浏览器拦下了新标签页，请右键图片另存为', 'bad');
    return w;
  };
  OC.canvasToBlob = function (canvas) {
    return new Promise(function (res, rej) {
      if (canvas.toBlob) canvas.toBlob(function (b) { b ? res(b) : rej(new Error('导出失败')); }, 'image/png');
      else rej(new Error('当前浏览器不支持导出 PNG'));
    });
  };

  // ---- 分段控件:点击切换 .on,并派发 oc-seg 事件 ----
  OC.seg = function (sel, onChange) {
    var groups = typeof sel === 'string' ? doc.querySelectorAll(sel) : [sel];
    [].forEach.call(groups, function (g) {
      if (!g || g.__ocSeg) return;
      g.__ocSeg = 1;
      g.addEventListener('click', function (e) {
        var b = e.target.closest('.seg-btn');
        if (!b || !g.contains(b)) return;
        [].forEach.call(g.querySelectorAll('.seg-btn'), function (x) { x.classList.toggle('on', x === b); });
        if (onChange) onChange(b.getAttribute('data-v'), b, g);
      });
    });
  };
  OC.segVal = function (sel) {
    var g = typeof sel === 'string' ? doc.querySelector(sel) : sel;
    var on = g ? g.querySelector('.seg-btn.on') : null;
    return on ? on.getAttribute('data-v') : '';
  };
  OC.segSet = function (sel, v) {
    var g = typeof sel === 'string' ? doc.querySelector(sel) : sel;
    if (!g) return;
    [].forEach.call(g.querySelectorAll('.seg-btn'), function (x) { x.classList.toggle('on', x.getAttribute('data-v') === String(v)); });
  };

  // ---- 滑杆:把百分比写进 --p,轨道用渐变画出已选段 ----
  OC.range = function (sel, onInput) {
    var list = typeof sel === 'string' ? doc.querySelectorAll(sel) : [sel];
    [].forEach.call(list, function (r) {
      if (!r) return;
      var sync = function () {
        var min = Number(r.min || 0), max = Number(r.max === '' ? 100 : r.max);
        var p = max > min ? ((Number(r.value) - min) / (max - min)) * 100 : 0;
        r.style.setProperty('--p', p + '%');
        var out = r.getAttribute('data-out') ? doc.querySelector(r.getAttribute('data-out')) : null;
        if (out) out.textContent = r.value;
        if (onInput) onInput(r.value, r);
      };
      r.addEventListener('input', sync);
      sync();
      if (typeof MutationObserver === 'function') {
        new MutationObserver(sync).observe(r, { attributes: true, attributeFilter: ['disabled', 'min', 'max'] });
      }
    });
  };

  // ---- 自绘下拉 ----
  var OPEN = null;
  function closeMenu() {
    if (!OPEN) return;
    OPEN.off();
    if (OPEN.menu.parentNode) OPEN.menu.parentNode.removeChild(OPEN.menu);
    var box = OPEN.box;
    if (box) box.setAttribute('aria-expanded', 'false');
    OPEN = null;
  }
  OC.closeMenus = closeMenu;
  function enhance(sel) {
    if (sel.__ocSel) return;
    sel.__ocSel = 1;
    sel.style.display = 'none';
    var box = doc.createElement('span');
    box.className = 'oc-sel';
    box.setAttribute('role', 'combobox');
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-expanded', 'false');
    var label = doc.createElement('span');
    label.className = 'oc-sel-label';
    var arrow = doc.createElement('span');
    arrow.className = 'oc-sel-arrow';
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>';
    box.appendChild(label);
    box.appendChild(arrow);
    sel.parentNode.insertBefore(box, sel);
    function sync() {
      var opt = sel.options[sel.selectedIndex];
      label.textContent = opt ? opt.textContent : '';
      box.className = 'oc-sel' + (sel.disabled ? ' disabled' : '');
      box.setAttribute('aria-disabled', sel.disabled ? 'true' : 'false');
      box.setAttribute('aria-label', sel.getAttribute('aria-label') || (opt ? opt.textContent : ''));
    }
    sel.addEventListener('change', sync);
    function open() {
      if (sel.disabled) return;
      if (OPEN) { closeMenu(); return; }
      var menu = doc.createElement('div');
      menu.className = 'oc-sel-menu';
      for (var i = 0; i < sel.options.length; i++) {
        (function (idx) {
          var item = doc.createElement('div');
          item.className = 'oc-sel-item' + (idx === sel.selectedIndex ? ' on' : '');
          item.textContent = sel.options[idx].textContent;
          item.addEventListener('mousedown', function (e) { e.preventDefault(); });
          item.addEventListener('click', function () {
            if (sel.selectedIndex !== idx) {
              sel.selectedIndex = idx;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            sync();
            closeMenu();
          });
          menu.appendChild(item);
        })(i);
      }
      doc.body.appendChild(menu);
      // 先按触发器定位,再按实测尺寸掰回视口内(工具页不一定只有一屏,滚动时直接收起)
      var r = box.getBoundingClientRect();
      menu.style.minWidth = Math.round(r.width) + 'px';
      menu.style.left = Math.round(r.left) + 'px';
      menu.style.top = Math.round(r.bottom + 5) + 'px';
      var mm = menu.getBoundingClientRect();
      if (mm.bottom > window.innerHeight - 8) menu.style.top = Math.round(Math.max(8, r.top - 5 - mm.height)) + 'px';
      if (mm.right > window.innerWidth - 8) menu.style.left = Math.round(Math.max(8, window.innerWidth - 8 - mm.width)) + 'px';
      box.setAttribute('aria-expanded', 'true');
      var onDoc = function (e) { if (!menu.contains(e.target) && !box.contains(e.target)) closeMenu(); };
      // 捕获阶段拦下 Esc:这一个 Esc 只该收起菜单,别再往页面上冒
      var onKey = function (e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      };
      var onScroll = function () { closeMenu(); };
      OPEN = {
        box: box, menu: menu,
        off: function () {
          doc.removeEventListener('mousedown', onDoc);
          doc.removeEventListener('keydown', onKey, true);
          window.removeEventListener('scroll', onScroll, true);
        },
      };
      doc.addEventListener('mousedown', onDoc);
      doc.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
      sync();
    }
    box.addEventListener('click', open);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    sync();
  }
  OC.enhanceSelects = function (scope) {
    var list = (scope || doc).querySelectorAll('select');
    for (var i = 0; i < list.length; i++) enhance(list[i]);
  };
  OC.enhanceSelects();

  // ---- 杂项 ----
  OC.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  OC.p2 = function (n) { return String(n).padStart(2, '0'); };
  OC.$ = function (s) { return doc.querySelector(s); };
  OC.$$ = function (s) { return [].slice.call(doc.querySelectorAll(s)); };
  OC.on = function (sel, ev, fn) {
    var list = typeof sel === 'string' ? doc.querySelectorAll(sel) : [sel];
    [].forEach.call(list, function (n) { if (n) n.addEventListener(ev, fn); });
  };
})();
UI3;

/**
 * 装配一套工具页:样式与运行时内联,只有两个 <script>(运行时 + 工具脚本)。
 * 用字符串拼接而不是 heredoc 插值:工具正文里的 $ 不该被当成 PHP 变量。
 */
function tc_toolbox_page_v3($title, $body, $script) {
    return '<!doctype html>' . "\n"
        . '<html lang="zh-CN"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>' . $title . '</title>'
        . '<style>' . TC_TOOLBOX_V3_CSS . '</style></head><body>'
        . $body
        . '<script>' . TC_TOOLBOX_V3_UI_JS . '</' . 'script>'
        . '<script>' . $script . '</' . 'script></body></html>';
}

/**
 * 逐套工具:lib/toolbox-tools/*.php,每个文件 return 一份数组
 * id / cat / title / body(正文 HTML)/ script(工具脚本)。
 * 按文件名排序 —— 前缀数字决定展示顺序(同一分类内也用它)。
 */
function tc_toolbox_v3_tools() {
    $dir = __DIR__ . '/toolbox-tools';
    $files = @scandir($dir);
    if (!is_array($files)) return array();
    sort($files, SORT_STRING);
    $out = array();
    foreach ($files as $f) {
        if (substr($f, -4) !== '.php') continue;
        $item = require $dir . '/' . $f;
        if (!is_array($item) || empty($item['id']) || !isset($item['body']) || !isset($item['script'])) continue;
        $out[] = $item;
    }
    return $out;
}

function tc_toolbox_v3_cats() {
    return array(
        array('id' => 'enc', 'name' => '编码转换'),
        array('id' => 'dev', 'name' => '开发辅助'),
        array('id' => 'gen', 'name' => '随机生成'),
        array('id' => 'qr', 'name' => '二维码'),
        array('id' => 'ui', 'name' => '颜色与设计'),
        array('id' => 'text', 'name' => '文本处理'),
    );
}

/** 当前出厂的系统工具箱:逐套工具 + 分类。 */
function tc_toolbox_system_v3() {
    $items = array();
    foreach (tc_toolbox_v3_tools() as $t) {
        $items[] = array(
            'id' => $t['id'],
            'cat' => isset($t['cat']) ? $t['cat'] : '',
            'title' => $t['title'],
            'html' => tc_toolbox_page_v3($t['title'], $t['body'], $t['script']),
        );
    }
    return array('cats' => tc_toolbox_v3_cats(), 'items' => $items);
}

/** 逐套工具的自检入口(单元自检用,避免把整页字符串拿来比对)。 */
function tc_toolbox_v3_raw($id) {
    foreach (tc_toolbox_v3_tools() as $t) if ($t['id'] === $id) return $t;
    return null;
}
