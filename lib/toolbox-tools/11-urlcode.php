<?php
/**
 * 工具:URL 编解码。
 *
 * 纯前端实现,不引任何外部库。要点:
 *   编码:自己实现百分号编码器(按码点取 UTF-8 字节 → %XX 大写),三种粒度分别对应
 *         encodeURIComponent 的 unescaped 集 / encodeURI 的保留集 / 只处理查询串的
 *         name=value 对(保留 & = 结构符,逐个编码参数名与值)。
 *   解码:不用 decodeURIComponent 直接解 —— 它遇到 %ZZ / 尾部单个 % 会直接抛错且不告诉你
 *         位置。这里自己扫描:非法 % 序列记录字符下标、非法 UTF-8 字节序列标 U+FFFD,输出
 *         仍然尽量给全,错误单独提示。
 *   URL 解析:优先用 URL 构造器(scheme/用户名/密码/主机/端口/路径/查询/锚点),查询参数
 *         另存原始值与解码值,可改可增删,再按当前表单风格重新拼出一条 URL。
 *   空格与 +:application/x-www-form-urlencoded 里空格编成 +、解码时 + 还原成空格,这是
 *         最常见的坑,单独一个开关;整条 URL 模式(encodeURI)下 + 不是分隔符,开关置灰。
 *   编码对照表:把输入里每个需要编码的字符列出来(字符 / 码点 / UTF-8 字节 / %XX),让人
 *         看清百分号编码到底做了什么。
 */
$body = <<<'UC_BODY'
<style>
/* 本页用 hidden 属性隐藏的既有 .f / .btn 自带 display,这里兜住,别让它们被 author 规则顶回来 */
[hidden]{display:none !important}
.uc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.uc-tbl input{padding:5px 8px;font-size:.857rem}
.uc-tbl td{padding:5px 7px}
.uc-raw{font-family:var(--mono);font-size:.857rem;color:var(--t2);word-break:break-all;overflow-wrap:anywhere}
.uc-scroll{max-height:300px;overflow:auto;border-radius:var(--r);background:var(--bg-soft);padding:2px}
.uc-chr{display:inline-block;min-width:22px;font-family:var(--mono);font-size:.929rem;text-align:center;
  background:var(--bg-code);border-radius:var(--r-xs);padding:1px 6px}
.uc-hint{font-size:.786rem;color:var(--t3)}
.uc-note{font-size:.857rem;color:var(--t2);background:var(--bg-soft);border-radius:var(--r);padding:8px 11px}
.uc-note .mono{color:var(--text)}
</style>

<div class="hd">
  <div class="grow">
    <h1>URL 编解码</h1>
    <div class="sub">百分号编码与解码:三种编码粒度、表单风格空格、URL 逐段解析与参数重编、编码对照表、容错解码。输入即算。</div>
  </div>
  <div class="acts">
    <button class="btn" id="uc-demo">填入示例</button>
    <button class="btn" id="uc-swap">结果转输入</button>
    <button class="btn accent" id="uc-run">处理</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>输入</h2>
      <span class="grow"></span>
      <span class="msg" id="uc-in-msg"></span>
      <button class="btn sm ghost" id="uc-clear">清空</button>
    </div>
    <div class="f">
      <span class="lab">方向</span>
      <div class="seg" id="uc-dir">
        <button class="seg-btn on" data-v="enc">编码 →</button>
        <button class="seg-btn" data-v="dec">← 解码</button>
      </div>
    </div>
    <div class="f" id="uc-gran-f" style="margin-top:12px">
      <span class="lab">编码粒度</span>
      <div class="seg" id="uc-gran">
        <button class="seg-btn on" data-v="component">组件</button>
        <button class="seg-btn" data-v="uri">整条 URL</button>
        <button class="seg-btn" data-v="query">只编码查询串</button>
      </div>
      <span class="uc-hint" id="uc-gran-hint"></span>
    </div>
    <label class="row mt" style="gap:6px">
      <input type="checkbox" id="uc-plus">
      <span>表单风格:空格 ↔ <span class="mono">+</span>(application/x-www-form-urlencoded)</span>
    </label>
    <textarea id="uc-in" class="wrap" spellcheck="false" style="margin-top:10px" placeholder="输入要编码的文本,或要解码的百分号串…"></textarea>
    <div class="stats mt" id="uc-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>结果</h2>
      <span class="grow"></span>
      <button class="btn sm" id="uc-again" hidden>再解一层</button>
      <button class="btn sm p" id="uc-copy">复制结果</button>
    </div>
    <div class="code brk" id="uc-out"></div>
    <div class="msg mt" id="uc-out-msg"></div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>URL 解析器</h2>
    <span class="grow"></span>
    <span class="msg" id="uc-p-msg"></span>
    <button class="btn sm" id="uc-p-use-in">用上面的输入</button>
    <button class="btn sm" id="uc-p-demo">示例 URL</button>
    <button class="btn sm accent" id="uc-p-parse">解析</button>
  </div>
  <div class="f">
    <span class="lab">粘贴一条完整 URL(缺 scheme 会自动补 https://)</span>
    <input type="text" id="uc-p-url" class="mono" spellcheck="false" placeholder="https://user:pass@host:8443/path?q=value#frag">
  </div>
  <div id="uc-p-body" hidden>
    <div class="uc-grid" style="margin-top:12px">
      <div class="f"><span class="lab">协议</span><input type="text" id="uc-f-scheme" class="mono" spellcheck="false"></div>
      <div class="f"><span class="lab">用户名</span><input type="text" id="uc-f-user" class="mono" spellcheck="false"></div>
      <div class="f"><span class="lab">密码</span><input type="text" id="uc-f-pass" class="mono" spellcheck="false"></div>
      <div class="f"><span class="lab">主机</span><input type="text" id="uc-f-host" class="mono" spellcheck="false"><span class="uc-hint" id="uc-f-host-raw"></span></div>
      <div class="f"><span class="lab">端口</span><input type="text" id="uc-f-port" class="mono" spellcheck="false"></div>
      <div class="f"><span class="lab">路径</span><input type="text" id="uc-f-path" class="mono" spellcheck="false"></div>
      <div class="f"><span class="lab">锚点</span><input type="text" id="uc-f-hash" class="mono" spellcheck="false"></div>
    </div>

    <div class="card-h" style="margin:14px 0 10px">
      <h2>查询参数</h2>
      <span class="grow"></span>
      <button class="btn sm ghost" id="uc-p-add">加一行</button>
    </div>
    <div class="uc-scroll">
      <table class="uc-tbl">
        <thead><tr><th style="width:26%">名称(可改)</th><th style="width:28%">原始值</th><th>解码值(可改,拼新 URL 用它)</th><th style="width:46px"></th></tr></thead>
        <tbody id="uc-p-rows"></tbody>
      </table>
    </div>
    <div class="row mt">
      <button class="btn accent" id="uc-p-gen">重新生成 URL</button>
      <button class="btn ghost" id="uc-p-clear">清空参数</button>
      <span class="sp"></span>
      <span class="uc-hint">只重编查询参数,协议 / 主机 / 路径 / 锚点按你填的原样保留。</span>
    </div>
    <div class="f mt">
      <span class="lab">生成结果</span>
      <div class="code brk" id="uc-p-out"></div>
      <div class="row">
        <button class="btn sm p" id="uc-p-copy">复制新 URL</button>
        <button class="btn sm" id="uc-p-to-in">用它做输入</button>
      </div>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>编码对照表</h2>
    <span class="grow"></span>
    <span class="msg" id="uc-map-msg"></span>
  </div>
  <p class="uc-hint">列出输入里每个需要百分号编码的字符(非 ASCII 与 URL 的保留 / 特殊字符),以及它的码点、UTF-8 字节与编码结果。</p>
  <div class="uc-scroll" style="margin-top:10px">
    <table class="uc-tbl">
      <thead><tr><th style="width:70px">字符</th><th style="width:90px">码点</th><th>UTF-8 字节</th><th>编码结果</th><th class="num" style="width:64px">出现</th></tr></thead>
      <tbody id="uc-map-rows"></tbody>
    </table>
  </div>
  <div class="empty" id="uc-map-empty">输入里没有需要编码的字符(全是字母、数字与 - _ . ! ~ * ' ( ) )</div>
</div>

<div class="card">
  <div class="card-h"><h2>三种粒度与空格的差别</h2></div>
  <div class="uc-note">
    <b>组件(encodeURIComponent)</b>:把整段当成一个参数值,<span class="mono">/ : ? &amp; = # @</span> 这些也全都编码。适合把它塞进查询参数的单个值。<br>
    <b>整条 URL(encodeURI)</b>:保留 <span class="mono">; , / ? : @ &amp; = + $ #</span> 等结构字符,只编码空格、中文与 <span class="mono">[ ] " &lt; &gt;</span> 等。适合整条链接。此模式下空格固定为 <span class="mono">%20</span>,<span class="mono">+</span> 不做特殊处理。<br>
    <b>只编码查询串</b>:找到 <span class="mono">?</span> 之后、<span class="mono">#</span> 之前的部分,逐参数编码参数名与值,保留 <span class="mono">&amp;</span> 与 <span class="mono">=</span> 分隔符;路径与锚点原样保留。<br>
    <b>空格与 +</b>:表单提交(application/x-www-form-urlencoded)把空格写成 <span class="mono">+</span>,读取时再把 <span class="mono">+</span> 当成空格。这是最常见的坑 —— 但只有在表单场景才成立,URL 路径里的 <span class="mono">+</span> 就是加号本身。开关打开即按表单语义编 / 解。
  </div>
</div>
UC_BODY;
$script = <<<'UC_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ---------- 常量 ----------
  var MAX_IN = 200000;          // 超过就拒绝,避免长串把页面卡死
  var MAP_MAX = 300;            // 对照表最多列这么多行
  var SAFE_COMPONENT = /[A-Za-z0-9\-_.!~*'()]/;                                  // encodeURIComponent 不转义的集
  var SAFE_URI = /[A-Za-z0-9;,\/?:@&=+$\-_.!~*'()#]/;                            // encodeURI 不转义的集
  var HINT = {
    component: '组件 = encodeURIComponent:把整段当成一个参数值,/ : ? & = # @ 等全部编码。适合放进查询参数的单个值。',
    uri: '整条 URL = encodeURI:保留 ; / ? : @ & = + $ , # 等结构字符,只编码空格、中文与 [ ] " < > 等。适合整条链接。',
    query: '只编码查询串:只处理 ? 之后、# 之前的部分,逐参数编码参数名与值,保留 & = 分隔符;路径与锚点原样保留。',
  };
  var st = { url: null };
  var timers = { live: 0, url: 0 };

  // ---------- 小工具 ----------
  function hex2(n) { return ('0' + n.toString(16).toUpperCase()).slice(-2); }
  function cpLen(s) { return Array.from(s).length; }
  function utf8FromCp(cp) {
    if (cp < 0x80) return [cp];
    if (cp < 0x800) return [0xC0 | (cp >> 6), 0x80 | (cp & 63)];
    if (cp < 0x10000) return [0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    return [0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  }
  function utf8BytesOf(s) {
    var n = 0, i, cp;
    for (i = 0; i < s.length; i++) {
      cp = s.codePointAt(i);
      if (cp > 0xFFFF) i++;
      n += utf8FromCp(cp).length;
    }
    return n;
  }
  function debounce(key, fn, ms) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(fn, ms);
  }

  // ---------- 百分号编码 ----------
  // 按码点走:safe 命中的 ASCII 直接留,其余(含所有非 ASCII)先转 UTF-8 字节再 %XX。
  function pctEncode(str, safe, plusSpace) {
    var out = '', i = 0, cp, bs, k;
    while (i < str.length) {
      cp = str.codePointAt(i);
      i += (cp > 0xFFFF) ? 2 : 1;
      if (cp < 0x80) {
        var ch = String.fromCharCode(cp);
        if (safe.test(ch)) out += ch;
        else if (plusSpace && cp === 0x20) out += '+';
        else out += '%' + hex2(cp);
      } else {
        bs = utf8FromCp(cp);
        for (k = 0; k < bs.length; k++) out += '%' + hex2(bs[k]);
      }
    }
    return out;
  }

  // ---------- 容错解码 ----------
  // 不用 decodeURIComponent:它遇到非法串直接抛错且不给位置。这里逐字符扫,记录每个字节
  // 的来源下标,非法 % 与非法 UTF-8 都单独提示,输出仍尽量给全。
  function decodeBytes(list, errs) {
    var out = '', i = 0, n = list.length;
    while (i < n) {
      var b = list[i].b, pos = list[i].pos, cp, need, k;
      if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
      if (b >= 0xC2 && b < 0xE0) { need = 2; cp = b & 0x1F; }
      else if (b >= 0xE0 && b < 0xF0) { need = 3; cp = b & 0x0F; }
      else if (b >= 0xF0 && b < 0xF5) { need = 4; cp = b & 0x07; }
      else { errs.push({ pos: pos, kind: 'utf8', byte: b }); out += '\uFFFD'; i++; continue; }
      var good = (i + need <= n);
      if (good) {
        for (k = 1; k < need; k++) {
          var nb = list[i + k].b;
          if ((nb & 0xC0) !== 0x80) { good = false; break; }
          cp = (cp << 6) | (nb & 0x3F);
        }
      }
      if (good) {
        if ((need === 2 && cp < 0x80) || (need === 3 && cp < 0x800) || (need === 4 && cp < 0x10000)
            || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) good = false;
      }
      if (!good) { errs.push({ pos: pos, kind: 'utf8', byte: b }); out += '\uFFFD'; i++; continue; }
      out += String.fromCodePoint(cp);
      i += need;
    }
    return out;
  }
  function tolerantDecode(s, plusSpace) {
    var out = '', errs = [], pending = [], i = 0;
    function flush() { if (pending.length) { out += decodeBytes(pending, errs); pending = []; } }
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === '%') {
        var h = s.substr(i + 1, 2);
        if (h.length === 2 && /^[0-9a-fA-F]{2}$/.test(h)) {
          pending.push({ b: parseInt(h, 16), pos: i });
          i += 3;
        } else {
          flush();
          errs.push({ pos: i, kind: 'pct', token: '%' + h });
          out += ch;
          i += 1;
        }
      } else if (plusSpace && ch === '+') {
        flush();
        out += ' ';
        i += 1;
      } else {
        flush();
        out += ch;
        i += 1;
      }
    }
    flush();
    return { text: out, errors: errs };
  }

  // ---------- 只编码查询串 ----------
  function encodeQueryString(q, plusSpace) {
    return q.split('&').map(function (pair) {
      if (pair === '') return '';
      var idx = pair.indexOf('=');
      var k = idx < 0 ? pair : pair.slice(0, idx);
      var v = idx < 0 ? null : pair.slice(idx + 1);
      var ek = pctEncode(k, SAFE_COMPONENT, plusSpace);
      if (v === null) return ek;
      return ek + '=' + pctEncode(v, SAFE_COMPONENT, plusSpace);
    }).join('&');
  }
  function encodeQueryOnly(input, plusSpace) {
    var qi = input.indexOf('?');
    var prefix, query, anchor = '';
    if (qi < 0) { prefix = ''; query = input; }
    else { prefix = input.slice(0, qi); query = input.slice(qi + 1); }
    var hi = query.indexOf('#');
    if (hi >= 0) { anchor = query.slice(hi); query = query.slice(0, hi); }
    return prefix + (qi < 0 ? '' : '?') + encodeQueryString(query, plusSpace) + anchor;
  }

  // ---------- 编码对照表 ----------
  function charLabel(cp) {
    if (cp === 0x20) return '空格';
    if (cp === 0x09) return 'Tab';
    if (cp === 0x0A) return '换行';
    if (cp === 0x0D) return '回车';
    if (cp < 0x20 || cp === 0x7F) return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    return String.fromCodePoint(cp);
  }
  function buildMap(text) {
    var tbody = $('#uc-map-rows'), empty = $('#uc-map-empty');
    tbody.innerHTML = '';
    var order = [], count = {}, i, cp;
    for (i = 0; i < text.length; i++) {
      cp = text.codePointAt(i);
      if (cp > 0xFFFF) i++;
      if (count[cp] === undefined) { count[cp] = 0; order.push(cp); }
      count[cp]++;
    }
    var need = order.filter(function (c) { return !SAFE_COMPONENT.test(String.fromCodePoint(c)); });
    if (!need.length) {
      empty.hidden = false;
      OC.say('#uc-map-msg', '');
      return;
    }
    empty.hidden = true;
    var shown = need.slice(0, MAP_MAX);
    var frag = document.createDocumentFragment();
    shown.forEach(function (c) {
      var s = String.fromCodePoint(c);
      var bs = utf8FromCp(c).map(hex2).join(' ');
      var tr = document.createElement('tr');
      var td1 = document.createElement('td');
      var sp = document.createElement('span');
      sp.className = 'uc-chr';
      sp.textContent = charLabel(c);
      sp.title = c === 0x20 ? '空格 (U+0020)' : s;
      td1.appendChild(sp);
      var td2 = document.createElement('td');
      td2.className = 'num';
      td2.textContent = 'U+' + c.toString(16).toUpperCase().padStart(4, '0');
      var td3 = document.createElement('td');
      td3.className = 'mono brk';
      td3.textContent = bs;
      var td4 = document.createElement('td');
      td4.className = 'mono brk';
      td4.textContent = pctEncode(s, SAFE_COMPONENT, false);
      var td5 = document.createElement('td');
      td5.className = 'num';
      td5.textContent = String(count[c]);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4); tr.appendChild(td5);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    OC.say('#uc-map-msg', need.length > MAP_MAX ? '共 ' + need.length + ' 种,只列前 ' + MAP_MAX + ' 种' : '共 ' + need.length + ' 种字符', '');
  }

  // ---------- 统计 ----------
  function renderStats(input, out, dir) {
    var box = $('#uc-stats');
    if (!input) { box.innerHTML = ''; return; }
    var chars = cpLen(input), bytes = utf8BytesOf(input);
    var growth = input.length ? ((out.length - input.length) / input.length * 100) : 0;
    var sign = growth > 0 ? '+' : '';
    var label = dir === 'enc' ? '编码后长度' : '解码后长度';
    box.innerHTML =
      '<div class="stat"><div class="k">字符数</div><div class="v">' + chars + '</div></div>' +
      '<div class="stat"><div class="k">字节数</div><div class="v">' + bytes + '</div></div>' +
      '<div class="stat"><div class="k">' + label + '</div><div class="v">' + out.length + '</div></div>' +
      '<div class="stat"><div class="k">增长比例</div><div class="v">' + sign + growth.toFixed(1) + '%</div></div>';
  }

  // ---------- 主流程 ----------
  function readUI() {
    return {
      dir: OC.segVal('#uc-dir') || 'enc',
      gran: OC.segVal('#uc-gran') || 'component',
      plus: $('#uc-plus').checked,
    };
  }
  function syncUI(ui) {
    $('#uc-gran-f').hidden = (ui.dir !== 'enc');
    $('#uc-plus').disabled = (ui.dir === 'enc' && ui.gran === 'uri');
    $('#uc-gran-hint').textContent = HINT[ui.gran] || '';
  }
  function currentOutput() { return $('#uc-out').textContent; }

  function run() {
    var ui = readUI();
    syncUI(ui);
    var input = $('#uc-in').value;
    var outEl = $('#uc-out');
    $('#uc-again').hidden = true;

    if (!input) {
      outEl.textContent = '';
      OC.say('#uc-in-msg', '');
      OC.say('#uc-out-msg', '');
      renderStats('', '', ui.dir);
      buildMap('');
      return;
    }
    if (input.length > MAX_IN) {
      outEl.textContent = '';
      OC.say('#uc-in-msg', '输入过长(' + input.length + ' 字符,上限 ' + MAX_IN + '),请分段处理', 'bad');
      OC.say('#uc-out-msg', '');
      renderStats('', '', ui.dir);
      buildMap('');
      return;
    }
    OC.say('#uc-in-msg', '');

    var out = '', errs = [];
    try {
      if (ui.dir === 'enc') {
        if (ui.gran === 'uri') out = pctEncode(input, SAFE_URI, false);
        else if (ui.gran === 'query') out = encodeQueryOnly(input, ui.plus);
        else out = pctEncode(input, SAFE_COMPONENT, ui.plus);
      } else {
        var r = tolerantDecode(input, ui.plus);
        out = r.text;
        errs = r.errors;
      }
    } catch (e) {
      out = '';
      OC.say('#uc-in-msg', '处理失败:' + ((e && e.message) || e), 'bad');
    }
    outEl.textContent = out;
    renderStats(input, out, ui.dir);
    buildMap(input);

    if (ui.dir === 'dec') {
      if (errs.length) {
        var pct = errs.filter(function (e) { return e.kind === 'pct'; });
        var u8 = errs.length - pct.length;
        var parts = [];
        pct.slice(0, 3).forEach(function (e) {
          parts.push('第 ' + (e.pos + 1) + ' 位「' + e.token + '」不是合法百分号序列');
        });
        var msg = parts.join(';');
        if (pct.length > 3) msg += ' 等 ' + pct.length + ' 处非法 % 序列';
        else if (pct.length) msg += '(共 ' + pct.length + ' 处)';
        if (u8) msg += (msg ? ';' : '') + u8 + ' 处字节不是合法 UTF-8,已用 \uFFFD 代替';
        OC.say('#uc-out-msg', msg, 'bad');
      } else {
        OC.say('#uc-out-msg', '解码完成,没有发现非法序列', 'ok');
      }
      // 还残留 %XX 说明可能编了好几层
      if (/%[0-9A-Fa-f]{2}/.test(out)) $('#uc-again').hidden = false;
    } else {
      OC.say('#uc-out-msg', '已按「' + ({ component: '组件', uri: '整条 URL', query: '只编码查询串' }[ui.gran]) + '」编码'
        + (ui.plus && ui.gran !== 'uri' ? ',空格写成 +' : ''), 'ok');
    }
  }
  function live() { debounce('live', run, 130); }

  // ---------- URL 解析 ----------
  function rawAuthority(work) {
    var m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\/?#]*)/.exec(work);
    if (!m) return '';
    var auth = m[1];
    var at = auth.lastIndexOf('@');
    if (at >= 0) auth = auth.slice(at + 1);
    return auth.replace(/:\d+$/, '');
  }
  function rawQueryOf(work) {
    var qi = work.indexOf('?');
    if (qi < 0) return null;
    var hi = work.indexOf('#', qi + 1);
    return work.slice(qi + 1, hi < 0 ? work.length : hi);
  }
  function safeParse(raw) {
    raw = String(raw || '').trim();
    if (!raw) return { ok: false, msg: '请先粘贴一条 URL' };
    var work = raw;
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(work)) work = /^\/\//.test(work) ? 'http:' + work : 'https://' + work;
    var u;
    try { u = new URL(work); } catch (e) { return { ok: false, msg: '解析失败:不是合法的 URL(缺协议时会自动补 https://,仍失败请检查拼写)' }; }
    var params = [];
    var rq = rawQueryOf(work);
    if (rq !== null && rq !== '') {
      rq.split('&').forEach(function (pair) {
        if (pair === '') return;
        var eq = pair.indexOf('=');
        var hasEq = eq >= 0;
        var rk = hasEq ? pair.slice(0, eq) : pair;
        var rv = hasEq ? pair.slice(eq + 1) : '';
        params.push({
          k: tolerantDecode(rk, true).text,
          v: tolerantDecode(rv, true).text,
          raw: rv,
          hasEq: hasEq,
        });
      });
    }
    return {
      ok: true,
      state: {
        scheme: u.protocol.replace(/:$/, ''),
        user: u.username,
        pass: u.password,
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        hash: u.hash.replace(/^#/, ''),
        params: params,
        rawHost: rawAuthority(work),
      },
    };
  }

  function renderFields() {
    var s = st.url;
    $('#uc-f-scheme').value = s.scheme;
    $('#uc-f-user').value = s.user;
    $('#uc-f-pass').value = s.pass;
    $('#uc-f-host').value = s.host;
    $('#uc-f-port').value = s.port;
    $('#uc-f-path').value = s.path;
    $('#uc-f-hash').value = s.hash;
    $('#uc-f-host-raw').textContent = (s.rawHost && s.rawHost !== s.host) ? '原始主机:' + s.rawHost : '';
  }
  function renderParams() {
    var tb = $('#uc-p-rows');
    tb.innerHTML = '';
    var ps = st.url.params;
    if (!ps.length) {
      var tr0 = document.createElement('tr');
      var td0 = document.createElement('td');
      td0.colSpan = 4;
      td0.className = 'uc-hint';
      td0.textContent = '这条 URL 没有查询参数。点「加一行」手动加。';
      tr0.appendChild(td0);
      tb.appendChild(tr0);
      return;
    }
    ps.forEach(function (p, i) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="text" data-i="' + i + '" data-k="k"></td>'
        + '<td><span class="uc-raw"></span></td>'
        + '<td><input type="text" data-i="' + i + '" data-k="v"></td>'
        + '<td><button class="btn xs ghost" data-del="' + i + '">删</button></td>';
      tr.querySelector('[data-k=k]').value = p.k;
      tr.querySelector('[data-k=v]').value = p.v;
      tr.querySelector('.uc-raw').textContent = p.hasEq ? p.raw : '(无 = )';
      tb.appendChild(tr);
    });
  }
  function syncFields() {
    if (!st.url) return;
    st.url.scheme = $('#uc-f-scheme').value.trim();
    st.url.user = $('#uc-f-user').value;
    st.url.pass = $('#uc-f-pass').value;
    st.url.host = $('#uc-f-host').value.trim();
    st.url.port = $('#uc-f-port').value.trim();
    st.url.path = $('#uc-f-path').value;
    st.url.hash = $('#uc-f-hash').value;
  }
  function genUrl() {
    if (!st.url) return;
    var s = st.url, plus = $('#uc-plus').checked;
    var auth = '';
    if (s.user || s.pass) auth = s.user + (s.pass ? ':' + s.pass : '') + '@';
    var qs = s.params.filter(function (p) { return p.k !== '' || p.v !== ''; }).map(function (p) {
      var ek = pctEncode(p.k, SAFE_COMPONENT, plus);
      if (!p.hasEq && p.v === '') return ek;
      return ek + '=' + pctEncode(p.v, SAFE_COMPONENT, plus);
    }).join('&');
    var scheme = s.scheme || 'https';
    var host = s.host + (s.port ? ':' + s.port : '');
    var out = scheme + '://' + auth + host + (s.path || '') + (qs ? '?' + qs : '') + (s.hash ? '#' + s.hash : '');
    $('#uc-p-out').textContent = out;
    OC.say('#uc-p-msg', '已重新生成', 'ok');
  }
  function doParse() {
    var res = safeParse($('#uc-p-url').value);
    if (!res.ok) {
      $('#uc-p-body').hidden = true;
      OC.say('#uc-p-msg', res.msg, 'bad');
      return;
    }
    st.url = res.state;
    renderFields();
    renderParams();
    $('#uc-p-body').hidden = false;
    genUrl();
    OC.say('#uc-p-msg', '解析完成:' + st.url.params.length + ' 个查询参数', 'ok');
  }

  // ---------- 事件 ----------
  function wire() {
    $('#uc-in').addEventListener('input', live);
    OC.seg('#uc-dir', function () { syncUI(readUI()); live(); });
    OC.seg('#uc-gran', function () { syncUI(readUI()); live(); });
    $('#uc-plus').addEventListener('change', function () { live(); if (st.url) debounce('url', genUrl, 60); });
    $('#uc-run').addEventListener('click', run);

    $('#uc-copy').addEventListener('click', function () {
      var v = currentOutput();
      if (!v) { OC.toast('还没有结果', 'bad'); return; }
      OC.copy(v, '结果已复制');
    });
    $('#uc-again').addEventListener('click', function () {
      var v = currentOutput();
      if (!v) return;
      $('#uc-in').value = v;
      run();
      OC.toast('已再解一层');
    });
    $('#uc-swap').addEventListener('click', function () {
      var v = currentOutput();
      if (!v) { OC.toast('还没有结果', 'bad'); return; }
      $('#uc-in').value = v;
      OC.segSet('#uc-dir', OC.segVal('#uc-dir') === 'enc' ? 'dec' : 'enc');
      run();
    });
    $('#uc-clear').addEventListener('click', function () {
      $('#uc-in').value = '';
      run();
      $('#uc-in').focus();
    });
    $('#uc-demo').addEventListener('click', function () {
      OC.segSet('#uc-dir', 'enc');
      OC.segSet('#uc-gran', 'component');
      $('#uc-plus').checked = true;
      $('#uc-in').value = '搜索 关键词 & 中文/符号:x=1?y=2#锚点';
      run();
      OC.toast('示例已填入,试试点上面的粒度切换');
    });

    // URL 解析器
    $('#uc-p-parse').addEventListener('click', doParse);
    $('#uc-p-url').addEventListener('keydown', function (e) { if (e.key === 'Enter') doParse(); });
    $('#uc-p-use-in').addEventListener('click', function () {
      var v = $('#uc-in').value;
      if (!v) { OC.toast('上面的输入是空的', 'bad'); return; }
      $('#uc-p-url').value = v;
      doParse();
    });
    $('#uc-p-demo').addEventListener('click', function () {
      $('#uc-p-url').value = 'https://us%20er:p%40ss@例子.测试:8443/a b/中文?q=搜索 词&tag=a+b&flag&ref=https%3A%2F%2Fx.test%2F#锚 点';
      doParse();
    });
    $('#uc-p-add').addEventListener('click', function () {
      if (!st.url) { OC.toast('先解析一条 URL', 'bad'); return; }
      st.url.params.push({ k: '', v: '', raw: '', hasEq: false });
      renderParams();
      genUrl();
    });
    $('#uc-p-clear').addEventListener('click', function () {
      if (!st.url) return;
      st.url.params = [];
      renderParams();
      genUrl();
    });
    $('#uc-p-gen').addEventListener('click', genUrl);
    $('#uc-p-copy').addEventListener('click', function () {
      var v = $('#uc-p-out').textContent;
      if (!v) { OC.toast('还没有生成结果', 'bad'); return; }
      OC.copy(v, '新 URL 已复制');
    });
    $('#uc-p-to-in').addEventListener('click', function () {
      var v = $('#uc-p-out').textContent;
      if (!v) { OC.toast('还没有生成结果', 'bad'); return; }
      OC.segSet('#uc-dir', 'dec');
      $('#uc-in').value = v;
      run();
      OC.toast('已放到输入区并按解码处理');
    });

    var body = $('#uc-p-body');
    body.addEventListener('input', function (e) {
      if (!st.url) return;
      var t = e.target;
      if (t.dataset && t.dataset.i != null && t.dataset.k && t.closest('#uc-p-rows')) {
        var i = Number(t.dataset.i);
        var p = st.url.params[i];
        if (!p) return;
        if (t.dataset.k === 'k') p.k = t.value;
        else { p.v = t.value; p.hasEq = true; }
        debounce('url', genUrl, 130);
        return;
      }
      if (t.id && t.id.indexOf('uc-f-') === 0) {
        syncFields();
        debounce('url', genUrl, 130);
      }
    });
    body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b || !st.url) return;
      st.url.params.splice(Number(b.dataset.del), 1);
      renderParams();
      genUrl();
    });
  }

  wire();
  syncUI(readUI());
  $('#uc-in').value = '你好 world & a/b';
  run();
})();
UC_JS;

return array(
    'id' => 'urlcode',
    'cat' => 'enc',
    'title' => 'URL 编解码',
    'body' => $body,
    'script' => $script,
);
