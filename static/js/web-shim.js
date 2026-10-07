'use strict';
/**
 * web-shim.js — 注入到「被代理页面」里的运行期垫片。
 *
 * 服务端只能改写静态 HTML/CSS 里的地址;页面跑起来之后由 JS 现算出来的地址
 * (fetch/XHR/动态建 <script>/location 跳转/pushState…)服务端看不见,必须在这里拦。
 * 因此本文件随每个被代理页面注入,且在 <head> 最前面执行,先于站点自己的脚本。
 *
 * 它同时充当两种“替身”,因为被代理文档处在 sandbox 造成的不透明源里,
 * 浏览器原生的这些能力要么抛异常、要么写不进去:
 *   1) localStorage / sessionStorage → 内存实现(不少 SPA 只要求“有个能用的 storage”)
 *   2) document.cookie → 内存 jar,并按请求把 jar 用 c= 参数交给服务端,
 *      由服务端合并进上游 Cookie 头(沙箱里浏览器自己的 Cookie 存不住)
 *
 * 与本文件配套的服务端实现在 lib/web.php;http(s) 地址一律回填成 /api/web/{page,res}。
 * 注意:路由与文件命名避开 "chat" 关键字(免费主机 WAF 惯例)。
 */
(function () {
  var cfg = window.__OCW || {};
  if (!cfg.o || !cfg.t) return;                 // 配置缺失(不在代理页里)直接放行,不影响页面

  var PAGE = cfg.p || '/api/web/page';
  var RES = cfg.r || '/api/web/res';
  var REMOTE = cfg.o;

  // ============ 编解码与地址解析 ============

  function b64(u) {
    var bytes = new TextEncoder().encode(String(u));
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unb64(s) {
    try {
      var t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
      while (t.length % 4) t += '=';
      var bin = atob(t);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) { return ''; }
  }

  // 当前页面真正对应的原始地址(从自身 URL 的 u= 参数解出,比缓存 cfg.o 更准)
  function remoteUrl() {
    try {
      var m = /[?&]u=([^&]+)/.exec(location.search || '');
      if (m) { var u = unb64(decodeURIComponent(m[1])); if (/^https?:\/\//i.test(u)) return u; }
    } catch (e) {}
    return REMOTE;
  }

  function abs(u) {
    try { return new URL(String(u), remoteUrl()).href; } catch (e) { return ''; }
  }

  function isSkip(s) {
    return /^(#|javascript:|data:|blob:|about:|mailto:|tel:|sms:|file:|chrome:|moz-extension:|wss?:|ws:)/i.test(String(s).replace(/^\s+/, ''));
  }

  function isProxied(s) {
    return s.indexOf('/api/web/page?') >= 0 || s.indexOf('/api/web/res?') >= 0;
  }

  // 把任意地址转成走代理的地址;不需要/不可能代理的原样返回
  function proxied(u, kind) {
    var s = u == null ? '' : String(u);
    if (s === '' || isSkip(s) || isProxied(s)) return s;
    var a = abs(s);
    if (!/^https?:\/\//i.test(a)) return s;
    var q = '?u=' + b64(a) + '&t=' + encodeURIComponent(cfg.t);
    var ck = cookieString();
    if (ck) q += '&c=' + encodeURIComponent(ck);
    return (kind === 'page' ? PAGE : RES) + q;
  }

  // ============ cookie 替身(内存 jar) ============

  var jar = {};
  try {
    var seed = cfg.ck || {};
    for (var k in seed) if (Object.prototype.hasOwnProperty.call(seed, k)) jar[k] = String(seed[k]);
  } catch (e) {}

  function cookieString() {
    var out = [];
    for (var k in jar) if (Object.prototype.hasOwnProperty.call(jar, k)) out.push(k + '=' + jar[k]);
    return out.join('; ');
  }

  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () {
        var out = [];
        for (var k in jar) if (Object.prototype.hasOwnProperty.call(jar, k)) out.push(k + '=' + jar[k]);
        return out.join('; ');
      },
      set: function (v) {
        try {
          var parts = String(v).split(';');
          var first = (parts[0] || '').trim();
          if (first.indexOf('=') < 0) return;
          var name = first.slice(0, first.indexOf('=')).trim();
          var val = first.slice(first.indexOf('=') + 1).trim();
          var dead = false;
          for (var i = 1; i < parts.length; i++) {
            if (/^\s*max-age\s*=\s*0\s*$/i.test(parts[i])) dead = true;
            if (/^\s*expires\s*=\s*Thu,\s*01\s+Jan\s+1970/i.test(parts[i])) dead = true;
          }
          if (dead) delete jar[name]; else if (name) jar[name] = val;
        } catch (e) {}
      },
    });
  } catch (e) {}

  // ============ storage 替身 ============

  function memStore() {
    var m = {};
    var api = {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[String(k)] = String(v); },
      removeItem: function (k) { delete m[String(k)]; },
      clear: function () { m = {}; },
      key: function (i) { return Object.keys(m)[i] == null ? null : Object.keys(m)[i]; },
    };
    Object.defineProperty(api, 'length', { get: function () { return Object.keys(m).length; } });
    return api;
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var broken = false;
    try { void window[name].length; } catch (e) { broken = true; }
    if (!broken) return;
    try { Object.defineProperty(window, name, { configurable: true, value: memStore() }); } catch (e) {}
  });

  // 沙箱里注册不了 Service Worker;留着报错不如让站点的能力探测直接拿到“不支持”
  try {
    if (navigator.serviceWorker) Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: function () { return undefined; } });
  } catch (e) {}

  // ============ 上报给外层(地址栏/标题/AI 取正文) ============

  function report(type, extra) {
    try {
      if (!window.parent || window.parent === window) return;
      var m = { __ocw: 1, type: type, url: remoteUrl(), title: document.title || '' };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
      window.parent.postMessage(m, '*');
    } catch (e) {}
  }

  // 只认宿主(app)发来的指令:shim 运行在沙箱 iframe 里,能 postMessage 进来的窗口
  // 不止父级一个(同页面的其它 iframe 也可以)。不校验来源的话,任意同页脚本都能
  // 让 shim 跳转到别的代理地址、或把代理页正文(最多 40KB)交出去。
  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev && ev.data;
    if (!d || d.__ocwCmd == null) return;
    if (d.__ocwCmd === 'text') {
      var t = '';
      try { t = (document.body && document.body.innerText) || ''; } catch (e) {}
      report('text', { text: String(t).slice(0, 40000), ok: String(t).trim().length > 0 });
    } else if (d.__ocwCmd === 'nav' && typeof d.url === 'string') {
      try { location.assign(proxied(d.url, 'page')); } catch (e) {}
    }
  });

  // ============ 网络 API 改写 ============

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          input = proxied(String(input), 'res');
        } else if (input && typeof input === 'object' && input.url) {
          input = new Request(proxied(input.url, 'res'), input);
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }

  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var rest = Array.prototype.slice.call(arguments, 2);
    try { url = proxied(url, 'res'); } catch (e) {}
    return XO.apply(this, [method, url].concat(rest));
  };

  ['EventSource', 'WebSocket', 'Worker', 'SharedWorker'].forEach(function (name) {
    var Orig = window[name];
    if (typeof Orig !== 'function') return;
    window[name] = function (url) {
      var rest = Array.prototype.slice.call(arguments, 1);
      try { url = proxied(url, 'res'); } catch (e) {}
      try {
        return new (Function.prototype.bind.apply(Orig, [null].concat([url], rest)))();
      } catch (e) {
        // 不透明源下 Worker/WebSocket 可能被直接拒绝;给出一个能吞掉调用的哑对象,
        // 免得站点在构造处就抛异常、整页白屏。
        return {
          postMessage: function () {}, terminate: function () {}, close: function () {},
          addEventListener: function () {}, removeEventListener: function () {},
          onmessage: null, onerror: null, onopen: null, readyState: 3,
        };
      }
    };
  });

  if (navigator.sendBeacon) {
    var sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { url = proxied(url, 'res'); } catch (e) {}
      return sb(url, data);
    };
  }

  // ============ 元素属性改写(动态插入的资源) ============
  // innerHTML/XHR 注入的 DOM 走 MutationObserver;<script>.src 这类访问器走 defineProperty。
  var ATTRS = ['src', 'href', 'action', 'poster', 'formaction', 'data-src', 'background'];

  function fixAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === 'A' && el.hasAttribute('target') && !el.hasAttribute('rel')) el.setAttribute('rel', 'noopener noreferrer');
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      if (!v) continue;
      var kind = (el.tagName === 'A' || el.tagName === 'FORM' || el.tagName === 'IFRAME' || el.tagName === 'AREA') ? 'page' : 'res';
      var nv = proxied(v, kind);
      if (nv !== v) el.setAttribute(a, nv);
    }
    if (el.hasAttribute && el.hasAttribute('srcset')) {
      var ss = el.getAttribute('srcset');
      var fixed = String(ss).split(',').map(function (item) {
        var t = item.trim();
        if (!t) return t;
        var sp = t.split(/\s+/);
        sp[0] = proxied(sp[0], 'res');
        return sp.join(' ');
      }).join(', ');
      if (fixed !== ss) el.setAttribute('srcset', fixed);
    }
    if (el.tagName === 'STYLE') {
      var css = el.textContent || '';
      var nc = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (m, q, u) { return 'url("' + proxied(u, 'res') + '")'; });
      if (nc !== el.textContent) el.textContent = nc;
    }
  }

  try {
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes') { fixAttrs(r.target); continue; }
        var nodes = r.addedNodes || [];
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.nodeType !== 1) continue;
          fixAttrs(n);
          var kids = n.querySelectorAll ? n.querySelectorAll('[src],[href],[action],[poster],[srcset]') : [];
          for (var q = 0; q < kids.length; q++) fixAttrs(kids[q]);
        }
      }
    });
    mo.observe(document.documentElement || document, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ATTRS.concat(['srcset']),
    });
  } catch (e) {}

  // 属性访问器:el.src = 'x' / el.href = 'x' 这类直接赋值也要绕过
  var accessors = [
    [window.HTMLScriptElement, 'src', 'res'],
    [window.HTMLImageElement, 'src', 'res'],
    [window.HTMLIFrameElement, 'src', 'page'],
    [window.HTMLSourceElement, 'src', 'res'],
    [window.HTMLTrackElement, 'src', 'res'],
    [window.HTMLEmbedElement, 'src', 'res'],
    [window.HTMLObjectElement, 'data', 'res'],
    [window.HTMLLinkElement, 'href', 'res'],
    [window.HTMLAnchorElement, 'href', 'page'],
    [window.HTMLAreaElement, 'href', 'page'],
    [window.HTMLFormElement, 'action', 'page'],
  ];
  accessors.forEach(function (row) {
    var proto = row[0];
    var prop = row[1];
    var kind = row[2];
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || typeof d.get !== 'function' || typeof d.set !== 'function') return;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: function () { return d.get.call(this); },
        set: function (v) { try { v = proxied(v, kind); } catch (e) {} d.set.call(this, v); },
      });
    } catch (e) {}
  });

  // ============ 表单提交 ============
  // 服务端把 <form> 的原始 action 放在 data-ocw-action 上,并把 action 指向代理。
  // 这里在 submit 时把表单字段拼成查询串追加到代理地址的 u 上 —— 浏览器自己提交表单时
  // 会丢弃 action 里已有的查询串,不接管就会丢掉用户输入(必应搜索框就是这么坏的)。
  function formQuery(form) {
    var parts = [];
    try {
      var els = form.elements || [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || !el.name || el.disabled) continue;
        var tag = (el.tagName || '').toLowerCase();
        var type = (el.type || '').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file' || type === 'image') continue;
        if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
        var val = el.value == null ? '' : String(el.value);
        if (tag === 'select' && el.multiple) {
          for (var j = 0; j < el.options.length; j++) {
            if (el.options[j].selected) parts.push([el.name, el.options[j].value]);
          }
          continue;
        }
        parts.push([el.name, val]);
      }
    } catch (e) {}
    var out = [];
    for (var k = 0; k < parts.length; k++) {
      out.push(encodeURIComponent(parts[k][0]) + '=' + encodeURIComponent(parts[k][1]));
    }
    return out.join('&');
  }

  // 把提交目标(原始 action)+ 字段拼回一个「让代理去取」的地址
  function formTarget(form) {
    var action = form.getAttribute('data-ocw-action') || remoteUrl();
    var a;
    try { a = new URL(action); } catch (e) { return ''; }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return '';
    var q = formQuery(form);
    if (q) {
      // 目标地址自己可能已经带查询串,用 & 接上
      a.search = a.search ? (a.search + '&' + q) : ('?' + q);
    }
    return a.href;
  }

  // 用冒泡阶段监听:站点自己的 submit 处理器(常在捕获/更早的冒泡里改写字段)先跑完,
  // 我们再按最终字段值算目标地址。
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || (form.tagName || '').toLowerCase() !== 'form') return;
    if (!form.hasAttribute('data-ocw-action')) return;
    var target;
    try { target = formTarget(form); } catch (e) { return; }
    if (!target) return;
    // 站点若自己 preventDefault 了,说明它要用 XHR 自己发,交给它
    if (ev.defaultPrevented) return;
    ev.preventDefault();
    try { location.assign(proxied(target, 'page')); } catch (e) {}
  }, false);

  // ============ 导航与历史 ============

  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    if (typeof orig !== 'function') return;
    history[fn] = function (state, title, url) {
      var out;
      try {
        var t = (url === undefined || url === null) ? url : proxied(url, 'page');
        out = orig.call(history, state, title, t);
      } catch (e) {
        try { out = orig.call(history, state, title, url); } catch (e2) {}
      }
      report('navigate');
      return out;
    };
  });

  try {
    ['assign', 'replace'].forEach(function (fn) {
      var orig = window.Location.prototype[fn];
      if (typeof orig !== 'function') return;
      window.Location.prototype[fn] = function (u) {
        try { u = proxied(u, 'page'); } catch (e) {}
        return orig.call(this, u);
      };
    });
  } catch (e) {}

  var origOpen = window.open;
  if (typeof origOpen === 'function') {
    window.open = function (u) {
      var rest = Array.prototype.slice.call(arguments, 1);
      try { if (u) u = proxied(u, 'page'); } catch (e) {}
      return origOpen.apply(window, [u].concat(rest));
    };
  }

  // 站内跳转(被改写成代理地址的 <a>)之后本垫片会重新注入一次,这里把新地址回报给外层
  window.addEventListener('DOMContentLoaded', function () { report('load'); });
  window.addEventListener('load', function () { report('load'); });
  window.addEventListener('popstate', function () { report('navigate'); });

  // 标题多半在加载完成后才由脚本写入,盯一段时间保证地址栏能显示正确标题
  try {
    var titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(function () { report('title'); }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  } catch (e) {}

  report('load');
})();
