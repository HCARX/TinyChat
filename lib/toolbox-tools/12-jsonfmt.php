<?php
/**
 * 工具:JSON 格式化与校验。
 *
 * 关键实现选择:
 *   1) 错误定位自己写了一个严格递归下降扫描器(jsonScan),所以能给出精确的行列位置,
 *      并把原因翻译成中文;浏览器的英文报错作为兜底显示的原文。
 *   2) 大整数不丢精度:先扫描出「值位置」上的数字字面量,用不会与正文冲突的占位字符串替换掉,
 *      再 JSON.parse(得到结构与顺序都正确、但数字仍是原文的树),序列化时把占位符还原成原始字面量。
 *      所以默认的「保留原样」模式不会把 123456789012345678901234567890 变成 1.2345678901234568e+29。
 *   3) 序列化是自己写的(JSON.stringify 的 space 最多 10 个空格、也不支持 Tab/自定义),这样缩进、键名排序、
 *      数字原样三件事能一起做到;字符串转义交给 JSON.stringify 单值处理,保证非 ASCII 不被转成 \uXXXX。
 *   4) 转义/去转义、再解一层、查询串互转、路径取值(支持数组下标与 * 通配)都在本地完成,无外部依赖。
 *   5) 输入超过 2 MB 直接拒绝解析,避免页面卡死。
 */
$body = <<<'JF_BODY'
<style>
.jf-ta{min-height:200px}
#jf-out{min-height:240px}
.jf-pv{font-family:var(--mono);font-size:.786rem;color:var(--t3);max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jf-grow{flex:1;min-width:180px}
.jf-numhint{font-size:.786rem;color:var(--t3)}
</style>

<div class="hd">
  <div class="grow">
    <h1>JSON 格式化与校验</h1>
    <div class="sub">粘贴即校验:合法时给出类型与规模,非法时精确到行列并翻译成中文原因;支持缩进/压缩/键名排序、字符串转义与再解一层、查询串互转、路径取值,并原样保留大整数。</div>
  </div>
  <div class="acts">
    <span class="tag" id="jf-tag">等待输入</span>
    <button class="btn" id="jf-demo">填入示例</button>
    <button class="btn ghost" id="jf-clear-in">清空</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>输入</h2>
      <span class="grow"></span>
      <span class="msg" id="jf-size"></span>
    </div>
    <textarea id="jf-in" class="jf-ta" spellcheck="false" placeholder='把 JSON 粘到这里,例如 {"a":1,"b":[true,null]}'></textarea>
    <div class="drop mt" id="jf-drop" style="min-height:62px">
      <b>拖入 .json / .txt 文件</b>
      <span class="hint">也可以在框里直接 Ctrl+V;单次输入上限 2 MB</span>
    </div>
    <div id="jf-status" class="mt"></div>
    <div class="stats mt" id="jf-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>输出</h2>
      <span class="grow"></span>
      <span class="msg" id="jf-out-size"></span>
      <button class="btn sm" id="jf-copy">复制</button>
      <button class="btn sm" id="jf-to-in">用输出替换输入</button>
      <button class="btn sm ghost" id="jf-clear-out">清空</button>
    </div>
    <div class="row">
      <span class="lab" style="margin:0">缩进</span>
      <div class="seg" id="jf-indent">
        <button class="seg-btn on" data-v="2">2 空格</button>
        <button class="seg-btn" data-v="4">4 空格</button>
        <button class="seg-btn" data-v="tab">Tab</button>
        <button class="seg-btn" data-v="custom">自定义</button>
      </div>
      <input type="number" id="jf-width" min="1" max="8" step="1" value="3" style="width:70px" aria-label="自定义缩进空格数" hidden>
      <span class="sp"></span>
    </div>
    <div class="row">
      <span class="lab" style="margin:0">数字</span>
      <div class="seg" id="jf-num">
        <button class="seg-btn on" data-v="raw">保留原样</button>
        <button class="seg-btn" data-v="num">解析为数字</button>
      </div>
      <span class="sp"></span>
      <label class="row" style="gap:6px"><input type="checkbox" id="jf-sort"> 键名排序(递归)</label>
    </div>
    <div class="msg jf-numhint mt" id="jf-num-hint">「保留原样」重排时不会动数字本身,超出 2^53 的大整数不会变成 1e+21;「解析为数字」按 JS 数值处理,大整数会失真。</div>
    <div class="row mt">
      <button class="btn sm p" id="jf-format">格式化</button>
      <button class="btn sm" id="jf-min">压缩为一行</button>
    </div>
    <textarea id="jf-out" class="jf-ta mt" spellcheck="false" placeholder="结果会显示在这里"></textarea>
    <div class="msg mt" id="jf-op"></div>
  </div>
</div>

<div class="cols" style="margin-top:12px">
  <div class="card">
    <div class="card-h">
      <h2>转义与查询串</h2>
      <span class="grow"></span>
      <span class="msg" id="jf-qs-msg"></span>
    </div>
    <div class="row">
      <span class="lab" style="margin:0">转义</span>
      <button class="btn sm" id="jf-esc">把输入转成字符串字面量</button>
      <button class="btn sm" id="jf-unesc">去掉输入的转义</button>
      <button class="btn sm" id="jf-unwrap">再解一层</button>
    </div>
    <div class="msg mt">用来处理「接口返回里嵌了一层 JSON 字符串」这类内容:转义会把整个输入变成一个带引号的字符串字面量;去掉转义是反向操作;「再解一层」会识别字符串里是不是 JSON 并递归解开(最多 8 层)。这几个动作的结果都写到「输出」面板。</div>
    <div class="row mt">
      <span class="lab" style="margin:0">查询串</span>
      <div class="seg" id="jf-qs-dir">
        <button class="seg-btn on" data-v="to">JSON → 查询串</button>
        <button class="seg-btn" data-v="from">查询串 → JSON</button>
      </div>
      <span class="sp"></span>
      <button class="btn sm accent" id="jf-qs-run">转换</button>
    </div>
    <div class="msg mt">按 application/x-www-form-urlencoded 编码:顶层对象的每个字段一个 键=值;嵌套值(对象/数组)以 JSON 字符串形式编码。反向转换时,像对象/数组的值会自动解成嵌套结构,重复键合并成数组,纯数字还原为数字。</div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>路径取值</h2>
      <span class="grow"></span>
      <button class="btn sm" id="jf-path-copy">复制结果</button>
    </div>
    <div class="row">
      <div class="jf-grow"><input type="text" id="jf-path" class="mono" spellcheck="false" placeholder="a.b[0].c 或 items[*].name"></div>
      <button class="btn sm accent" id="jf-path-run">取值</button>
    </div>
    <div class="msg mt" id="jf-path-msg"></div>
    <div class="rows mt" id="jf-path-list"><div class="empty">输入 JSON 后,这里会列出可点选的常用路径</div></div>
    <div class="code mt" id="jf-path-out" hidden></div>
  </div>
</div>
JF_BODY;
$script = <<<'JF_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;
  var MAX = 2 * 1024 * 1024;

  // ============ 状态 ============
  var st = { indent: '2', customW: 3, num: 'raw', sort: false, outMode: 'format' };
  var cur = { ok: false, tree: null, map: null };
  var lastPathOut = '';
  var inTimer = 0;

  var DEMO = [
    '{',
    '  "名称": "在线工具箱 · JSON 工具",',
    '  "版本": 3,',
    '  "启用": true,',
    '  "大整数": 123456789012345678901234567890,',
    '  "标签": ["json", "格式化", "校验"],',
    '  "作者": {',
    '    "姓名": "张三",',
    '    "邮箱": "zhangsan@example.com"',
    '  },',
    '  "配置": {',
    '    "缩进": 2,',
    '    "键名排序": false,',
    '    "嵌套": {',
    '      "层级1": {',
    '      "层级2": [',
    '          { "id": 1, "名称": "甲" },',
    '          { "id": 2, "名称": "乙" },',
    '          { "id": 3, "名称": "丙" }',
    '        ]',
    '      }',
    '    }',
    '  },',
    '  "说明": "支持中文、emoji 🎉 与嵌套结构"',
    '}'
  ].join('\n');

  // ============ 小工具 ============
  function rep(s, n) { var o = '', i; for (i = 0; i < n; i++) o += s; return o; }
  function pad2(v, w) { v = String(v); while (v.length < w) v = ' ' + v; return v; }
  function utf8Len(s) {
    var n = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function isRawVal(v, map) { return !!map && typeof v === 'string' && Object.prototype.hasOwnProperty.call(map, v); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function typeOf(v, map) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '数组';
    var t = typeof v;
    if (t === 'object') return '对象';
    if (t === 'boolean') return '布尔值';
    if (t === 'number') return '数字';
    if (t === 'string') return isRawVal(v, map) ? '数字' : '字符串';
    return t;
  }
  function indentStr() {
    if (st.indent === 'tab') return '\t';
    if (st.indent === 'custom') return rep(' ', Math.min(8, Math.max(1, st.customW)));
    return rep(' ', Number(st.indent) || 2);
  }
  function natCmp(a, b) {
    var re = /(\d+)|(\D+)/g;
    var ax = String(a).match(re) || [], bx = String(b).match(re) || [];
    var n = Math.max(ax.length, bx.length), i, x, y, nx, ny, d;
    for (i = 0; i < n; i++) {
      x = ax[i]; y = bx[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      nx = /^\d+$/.test(x); ny = /^\d+$/.test(y);
      if (nx && ny) { d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
      else if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  function statEl(k, v) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }
  function setTag(kind, text) {
    var t = $('#jf-tag');
    t.textContent = text;
    t.className = 'tag' + (kind ? ' ' + kind : '');
  }
  function opMsg(t, k) {
    var n = $('#jf-op');
    n.textContent = t || '';
    n.className = 'msg mt' + (k ? ' ' + k : '');
  }
  function pmsg(t, k) {
    var n = $('#jf-path-msg');
    n.textContent = t || '';
    n.className = 'msg mt' + (k ? ' ' + k : '');
  }
  function schedule(ms) {
    clearTimeout(inTimer);
    inTimer = setTimeout(analyze, ms == null ? 130 : ms);
  }

  // ============ 严格扫描:给出行列与中文原因 ============
  function jsonScan(text) {
    var i = 0, n = text.length, spans = [];
    function err(pos, reason) { throw { __jf: true, pos: pos, reason: reason }; }
    function ws() {
      while (i < n) {
        var c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++;
        else break;
      }
    }
    function val(d) {
      if (d > 1200) err(i, '嵌套层级太深,已放弃解析');
      ws();
      if (i >= n) err(n, '这里本应有一个值,内容却已经结束');
      var c = text.charAt(i);
      if (c === '{') return obj(d);
      if (c === '[') return arr(d);
      if (c === '"') { str(); return; }
      if (c === '-' || (c >= '0' && c <= '9')) { num(); return; }
      if (text.substr(i, 4) === 'true') { i += 4; return; }
      if (text.substr(i, 5) === 'false') { i += 5; return; }
      if (text.substr(i, 4) === 'null') { i += 4; return; }
      err(i, '出现了不能作为值的字符「' + c + '」');
    }
    function str() {
      var s = i; i++;
      while (i < n) {
        var ch = text.charAt(i);
        if (ch === '"') {
          i++;
          try { JSON.parse(text.slice(s, i)); } catch (e2) { err(i - 1, '字符串里的转义写法不合法'); }
          return;
        }
        if (ch === '\\') { i += 2; continue; }
        if (text.charCodeAt(i) < 32) err(i, '字符串里不能出现未转义的控制字符或换行,换行要写成 \\n');
        i++;
      }
      err(s, '字符串缺少收尾的双引号');
    }
    function num() {
      var s = i;
      if (text.charAt(i) === '-') i++;
      if (!(i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9')) err(i, '负号后面需要数字');
      if (text.charAt(i) === '0') {
        i++;
        if (i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9') err(i, '数字不能有多余的前导零');
      } else {
        while (i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++;
      }
      if (text.charAt(i) === '.') {
        i++;
        if (!(i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9')) err(i, '小数点后面缺少数字');
        while (i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++;
      }
      if (text.charAt(i) === 'e' || text.charAt(i) === 'E') {
        i++;
        if (text.charAt(i) === '+' || text.charAt(i) === '-') i++;
        if (!(i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9')) err(i, '指数部分缺少数字');
        while (i < n && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++;
      }
      spans.push({ s: s, e: i, lit: text.slice(s, i) });
    }
    function obj(d) {
      i++; ws();
      if (text.charAt(i) === '}') { i++; return; }
      while (true) {
        ws();
        if (i >= n) err(i, '对象缺少收尾的右花括号');
        if (text.charAt(i) !== '"') err(i, '对象的键名必须用双引号包起来');
        str(); ws();
        if (text.charAt(i) !== ':') err(i, '键名后面缺少冒号');
        i++;
        val(d + 1); ws();
        var ch = text.charAt(i);
        if (ch === ',') { i++; ws(); if (text.charAt(i) === '}') err(i, '结尾多了一个逗号'); continue; }
        if (ch === '}') { i++; return; }
        if (i >= n) err(i, '对象缺少收尾的右花括号');
        err(i, '这里本应是逗号或右花括号,却出现了「' + ch + '」');
      }
    }
    function arr(d) {
      i++; ws();
      if (text.charAt(i) === ']') { i++; return; }
      while (true) {
        val(d + 1); ws();
        var ch = text.charAt(i);
        if (ch === ',') { i++; ws(); if (text.charAt(i) === ']') err(i, '结尾多了一个逗号'); continue; }
        if (ch === ']') { i++; return; }
        if (i >= n) err(i, '数组缺少收尾的右方括号');
        err(i, '这里本应是逗号或右方括号,却出现了「' + ch + '」');
      }
    }
    try {
      ws();
      if (i >= n) return { ok: false, pos: 0, reason: '内容为空' };
      val(0); ws();
      if (i < n) return { ok: false, pos: i, reason: '一个 JSON 结束后还有多余内容' };
    } catch (e) {
      if (e && e.__jf) return { ok: false, pos: e.pos, reason: e.reason };
      return { ok: false, pos: 0, reason: '解析失败:' + (e && e.message ? e.message : String(e)) };
    }
    return { ok: true, spans: spans };
  }
  function buildRaw(text, spans) {
    var nonce = '@@JF';
    while (text.indexOf(nonce) >= 0) nonce += Math.random().toString(36).slice(2, 6);
    var map = Object.create(null);
    var out = text, k, sp, ph;
    for (k = spans.length - 1; k >= 0; k--) {
      sp = spans[k];
      ph = nonce + k + '@@';
      map[ph] = sp.lit;
      out = out.slice(0, sp.s) + '"' + ph + '"' + out.slice(sp.e);
    }
    return { text: out, map: map };
  }

  // ============ 浏览器英文报错 -> 中文 ============
  function translateError(msg) {
    msg = String(msg || '');
    var m;
    if (/unexpected end of (json )?input|unexpected end of data|end of data/i.test(msg)) return '内容在中途就结束了:括号、引号或值没有收尾';
    if (/unexpected non-whitespace character/i.test(msg)) return '一个完整的 JSON 结束后还跟着多余内容';
    if (/bad control character/i.test(msg)) return '字符串里出现了没有转义的换行或控制字符';
    if (/expected property name or|double-quoted property name|property name must be a string|expected double-quoted/i.test(msg)) return '对象的键名必须用双引号包起来(不能单引号、也不能裸写)';
    if (/expected ':' after property name|expected colon/i.test(msg)) return '键名后面缺少冒号';
    if (/expected ',' or '}'/i.test(msg)) return '这里本应是逗号或右花括号';
    if (/expected ',' or ']'/i.test(msg)) return '这里本应是逗号或右方括号';
    if (/unexpected identifier|unexpected token/i.test(msg)) {
      m = /["']([^"']{1,12})["']/.exec(msg);
      return m ? ('出现了不能识别的写法「' + m[1] + '」;字面量只能是 true / false / null,字符串要用双引号')
               : '出现了不能识别的写法';
    }
    if (/invalid number|out of range/i.test(msg)) return '数字写法不合法或超出范围';
    return 'JSON 语法有误';
  }
  function msgPos(msg, text) {
    var m = /at position (\d+)/i.exec(msg);
    if (m) return Number(m[1]);
    m = /line (\d+) column (\d+)/i.exec(msg);
    if (m) {
      var L = Number(m[1]), C = Number(m[2]), lines = text.split('\n'), off = 0, i;
      for (i = 0; i < L - 1 && i < lines.length; i++) off += lines[i].length + 1;
      return off + C - 1;
    }
    return -1;
  }
  function lineColAt(text, pos) {
    if (pos < 0) pos = 0;
    if (pos > text.length) pos = text.length;
    var line = 1, ls = 0, i;
    for (i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) { line++; ls = i + 1; }
    return { line: line, col: pos - ls + 1 };
  }
  function snippet(text, pos) {
    var lc = lineColAt(text, pos);
    var lines = text.split('\n');
    var li = lc.line - 1;
    var from = Math.max(0, li - 1), to = Math.min(lines.length - 1, li + 1);
    var w = String(to + 1).length;
    var W = 96, out = [], i, s, start, seg, caret;
    for (i = from; i <= to; i++) {
      s = lines[i]; start = 0;
      var truncated = false;
      if (i === li && s.length > W) { start = Math.max(0, lc.col - 1 - 44); truncated = start > 0; }
      else if (i !== li && s.length > W) { s = s.slice(0, W) + '…'; }
      seg = s.slice(start, start + W);
      if (truncated) seg = '…' + seg;
      else if (i === li && s.length > start + W) seg = seg + '…';
      out.push(pad2(i + 1, w) + ' | ' + seg);
      if (i === li) {
        caret = lc.col - 1 - start + (truncated ? 1 : 0);
        if (caret < 0) caret = 0;
        if (caret > W + 2) caret = W + 2;
        out.push(rep(' ', w) + ' | ' + rep(' ', caret) + '^');
      }
    }
    return out.join('\n');
  }

  // ============ 序列化(数字原样 + 缩进 + 排序) ============
  function ser(v, opt) {
    var ind = opt.indent || '', map = opt.map || null, sort = !!opt.sort;
    function q(s) { return JSON.stringify(s); }
    function pad(d) { var s = '', i; for (i = 0; i < d; i++) s += ind; return s; }
    function go(v2, d) {
      if (v2 === null) return 'null';
      if (v2 === true) return 'true';
      if (v2 === false) return 'false';
      var t = typeof v2;
      if (t === 'number') return JSON.stringify(v2);
      if (t === 'string') return isRawVal(v2, map) ? map[v2] : q(v2);
      if (Array.isArray(v2)) {
        if (!v2.length) return '[]';
        var parts = [], i;
        for (i = 0; i < v2.length; i++) parts.push(go(v2[i], d + 1));
        return ind ? '[\n' + parts.map(function (p) { return pad(d + 1) + p; }).join(',\n') + '\n' + pad(d) + ']'
                   : '[' + parts.join(',') + ']';
      }
      var ks = Object.keys(v2), j, items = [];
      if (sort) ks.sort(natCmp);
      if (!ks.length) return '{}';
      for (j = 0; j < ks.length; j++) items.push(q(ks[j]) + (ind ? ': ' : ':') + go(v2[ks[j]], d + 1));
      return ind ? '{\n' + items.map(function (p) { return pad(d + 1) + p; }).join(',\n') + '\n' + pad(d) + '}'
                 : '{' + items.join(',') + '}';
    }
    return go(v, 0);
  }

  // ============ 统计 ============
  function deepStats(tree) {
    var keys = 0, arrEls = 0, maxD = 0;
    function walk(v, d) {
      var i, ks;
      if (Array.isArray(v)) {
        arrEls += v.length;
        if (d > maxD) maxD = d;
        for (i = 0; i < v.length; i++) walk(v[i], d + 1);
        return;
      }
      if (v && typeof v === 'object') {
        ks = Object.keys(v);
        keys += ks.length;
        if (d > maxD) maxD = d;
        for (i = 0; i < ks.length; i++) walk(v[ks[i]], d + 1);
      }
    }
    if (tree && typeof tree === 'object') walk(tree, 1);
    else maxD = 1;
    return { keys: keys, arrEls: arrEls, depth: maxD };
  }

  // ============ 转义 / 去转义 / 再解一层 ============
  function manualUnescape(s) {
    var out = '', i = 0, c, d, hex;
    while (i < s.length) {
      c = s.charAt(i);
      if (c !== '\\') { out += c; i++; continue; }
      d = s.charAt(i + 1);
      if (d === 'n') { out += '\n'; i += 2; }
      else if (d === 't') { out += '\t'; i += 2; }
      else if (d === 'r') { out += '\r'; i += 2; }
      else if (d === 'b') { out += '\b'; i += 2; }
      else if (d === 'f') { out += '\f'; i += 2; }
      else if (d === 'u') {
        hex = s.substr(i + 2, 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 6; }
        else { out += d; i += 2; }
      } else { out += (d || ''); i += 2; }
    }
    return out;
  }
  function unescapeText(text) {
    var t = String(text).trim();
    if (!t) return { ok: false };
    if (t.charAt(0) === '"') {
      try { return { ok: true, text: JSON.parse(t), manual: false }; } catch (e) { /* 退回手工 */ }
      t = t.slice(1, t.length - 1);
    } else if (t.charAt(0) === "'") {
      t = t.slice(1, t.length - 1);
    }
    return { ok: true, text: manualUnescape(t), manual: true };
  }
  function unwrapAll(text) {
    var t = String(text).trim(), layers = 0, i, v, inner;
    function done() { return layers > 0 ? { text: t, layers: layers } : null; }
    for (i = 0; i < 8; i++) {
      try { v = JSON.parse(t); } catch (e) { return done(); }
      if (typeof v !== 'string') return done();
      inner = v.trim();
      if (!inner || !/^[[{"]/.test(inner)) return done();
      try { JSON.parse(inner); } catch (e2) { return done(); }
      t = inner; layers++;
    }
    return { text: t, layers: layers };
  }

  // ============ 查询串 ============
  function encQS(s) { return encodeURIComponent(String(s)).replace(/%20/g, '+'); }
  function decQS(s) { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); } }
  function qsValue(v, map) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string') return isRawVal(v, map) ? map[v] : v;
    if (t === 'number' || t === 'boolean') return String(v);
    return ser(v, { indent: '', sort: false, map: map });
  }
  function toQuery(obj, map) {
    var ks = Object.keys(obj), parts = [], i;
    for (i = 0; i < ks.length; i++) parts.push(encQS(ks[i]) + '=' + encQS(qsValue(obj[ks[i]], map)));
    return parts.join('&');
  }
  function coerceQueryVal(v) {
    var t = v.trim();
    if (!t) return v;
    if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch (e) { return v; } }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
    return v;
  }
  function fromQuery(q) {
    q = String(q).trim().replace(/^[?&]/, '');
    if (!q) return { ok: false, reason: '查询串为空' };
    var obj = {}, parts = q.split('&'), i, p, eq, key, val, v2;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (!p) continue;
      eq = p.indexOf('=');
      key = decQS(eq < 0 ? p : p.slice(0, eq));
      val = eq < 0 ? '' : decQS(p.slice(eq + 1));
      v2 = coerceQueryVal(val);
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
        obj[key].push(v2);
      } else obj[key] = v2;
    }
    return { ok: true, value: obj };
  }

  // ============ 路径 ============
  function pathKey(base, k) {
    var bare = k && !/[.[\]"\s]/.test(k);
    if (bare) return (base ? base + '.' : '') + k;
    return base + '[' + JSON.stringify(k) + ']';
  }
  function parsePath(s) {
    s = String(s).trim();
    if (s.charAt(0) === '$') s = s.slice(1);
    var re = /\[\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]]*)\s*\]|([^.[\]]+)/g;
    var toks = [], m, inner;
    while ((m = re.exec(s)) !== null) {
      if (m[1] !== undefined) {
        inner = m[1].trim();
        if (inner === '*') toks.push('*');
        else if (inner.charAt(0) === '"') { try { toks.push(JSON.parse(inner)); } catch (e) { throw new Error('方括号里的键名写法不合法'); } }
        else if (inner.charAt(0) === "'") toks.push(inner.slice(1, -1));
        else toks.push(inner);
      } else if (m[2] !== undefined) {
        if (m[2] === '*') toks.push('*');
        else toks.push(m[2]);
      }
    }
    return toks;
  }
  function stepPath(node, tok, base) {
    var out = [], i, ks;
    if (tok === '*') {
      if (Array.isArray(node)) {
        for (i = 0; i < node.length; i++) out.push({ v: node[i], p: base + '[' + i + ']' });
      } else if (node && typeof node === 'object') {
        ks = Object.keys(node);
        for (i = 0; i < ks.length; i++) out.push({ v: node[ks[i]], p: pathKey(base, ks[i]) });
      }
      return out;
    }
    if (Array.isArray(node)) {
      if (/^\d+$/.test(tok)) {
        i = Number(tok);
        if (i < node.length) out.push({ v: node[i], p: base + '[' + i + ']' });
      }
      return out;
    }
    if (node && typeof node === 'object') {
      if (Object.prototype.hasOwnProperty.call(node, tok)) out.push({ v: node[tok], p: pathKey(base, tok) });
    }
    return out;
  }
  function collectPaths(root, limit) {
    var out = [];
    function walk(v, p) {
      var i, ks, cp;
      if (out.length >= limit) return;
      if (Array.isArray(v)) {
        for (i = 0; i < v.length && out.length < limit; i++) {
          cp = p + '[' + i + ']';
          out.push({ p: cp, v: v[i] });
          walk(v[i], cp);
        }
        return;
      }
      if (v && typeof v === 'object') {
        ks = Object.keys(v);
        for (i = 0; i < ks.length && out.length < limit; i++) {
          cp = pathKey(p, ks[i]);
          out.push({ p: cp, v: v[ks[i]] });
          walk(v[ks[i]], cp);
        }
      }
    }
    walk(root, '');
    return out;
  }
  function preview(v) {
    if (v === null) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    if (typeof v === 'string') {
      if (isRawVal(v, cur.map)) return cur.map[v];
      var s = JSON.stringify(v);
      return s.length > 42 ? s.slice(0, 42) + '…' : s;
    }
    if (Array.isArray(v)) return '[' + v.length + ' 项]';
    return '{' + Object.keys(v).length + ' 键}';
  }

  // ============ 校验与渲染 ============
  function setOut(s) {
    $('#jf-out').value = s || '';
    $('#jf-out-size').textContent = s ? (s.length + ' 字符') : '';
  }
  function render() {
    if (!cur.ok) return;
    setOut(ser(cur.tree, { indent: st.outMode === 'minify' ? '' : indentStr(), sort: st.sort, map: cur.map }));
  }
  function fail(text, pos, reason, eng) {
    cur = { ok: false, tree: null, map: null };
    setTag('bad', '非法');
    var box = $('#jf-status');
    box.innerHTML = '';
    var lc = lineColAt(text, pos);
    var m = document.createElement('div');
    m.className = 'msg bad';
    m.textContent = '✗ JSON 非法 · 第 ' + lc.line + ' 行 第 ' + lc.col + ' 列:' + reason;
    box.appendChild(m);
    if (pos >= 0) {
      var pre = document.createElement('div');
      pre.className = 'code mt';
      pre.textContent = snippet(text, pos);
      box.appendChild(pre);
    }
    if (eng) {
      var en = document.createElement('div');
      en.className = 'msg mt';
      en.textContent = '浏览器原文:' + eng;
      box.appendChild(en);
    }
    $('#jf-stats').innerHTML = statEl('字符', text.length);
    var pl = $('#jf-path-list');
    pl.innerHTML = '';
    var em = document.createElement('div'); em.className = 'empty'; em.textContent = '输入不是合法 JSON,无法取值';
    pl.appendChild(em);
    $('#jf-path-out').hidden = true;
  }
  function analyze() {
    var raw = $('#jf-in').value;
    var len = raw.length;
    $('#jf-size').textContent = len ? (len + ' 字符 · ' + OC.fmtBytes(utf8Len(raw))) : '';
    $('#jf-size').className = 'msg' + (len > 512 * 1024 ? ' warn' : '');

    if (len > MAX) {
      cur = { ok: false, tree: null, map: null };
      setTag('bad', '输入过大');
      var box = $('#jf-status');
      box.innerHTML = '';
      var w = document.createElement('div');
      w.className = 'msg bad';
      w.textContent = '输入约 ' + OC.fmtBytes(utf8Len(raw)) + ',超过 2 MB 上限,已停止解析以免页面卡死。请拆小后再试。';
      box.appendChild(w);
      $('#jf-stats').innerHTML = '';
      var pl = $('#jf-path-list');
      pl.innerHTML = '';
      var e0 = document.createElement('div'); e0.className = 'empty'; e0.textContent = '输入过大,未解析';
      pl.appendChild(e0);
      $('#jf-path-out').hidden = true;
      return;
    }

    var text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    if (!text.trim()) {
      cur = { ok: false, tree: null, map: null };
      setTag('', '等待输入');
      $('#jf-status').innerHTML = '';
      $('#jf-stats').innerHTML = '';
      renderPathListEmpty();
      $('#jf-path-out').hidden = true;
      if (st.outMode !== 'custom') setOut('');
      return;
    }

    var scan = jsonScan(text);
    if (!scan.ok) { fail(text, scan.pos, scan.reason, ''); return; }

    var tree, map = null;
    try {
      if (st.num === 'raw') {
        var built = buildRaw(text, scan.spans);
        map = built.map;
        tree = JSON.parse(built.text);
      } else {
        tree = JSON.parse(text);
      }
    } catch (e) {
      fail(text, msgPos(e.message, text), translateError(e.message), e.message);
      return;
    }

    cur = { ok: true, tree: tree, map: map };
    setTag('ok', '合法');
    var ds = deepStats(tree);
    var box2 = $('#jf-status');
    box2.innerHTML = '';
    var ok = document.createElement('div');
    ok.className = 'msg ok';
    ok.textContent = '✓ 合法 JSON · ' + typeOf(tree, map) + ' · ' + ds.keys + ' 个键 · 深度 ' + ds.depth + ' · 数组元素 ' + ds.arrEls;
    box2.appendChild(ok);
    $('#jf-stats').innerHTML = statEl('字符', len) + statEl('字节', utf8Len(raw)) +
      statEl('键(递归)', ds.keys) + statEl('最大深度', ds.depth) + statEl('数组元素', ds.arrEls);

    renderPathList();
    if (st.outMode !== 'custom') render();
  }
  function renderPathListEmpty() {
    var pl = $('#jf-path-list');
    pl.innerHTML = '';
    var e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '输入 JSON 后,这里会列出可点选的常用路径';
    pl.appendChild(e);
  }
  function renderPathList() {
    var pl = $('#jf-path-list');
    pl.innerHTML = '';
    if (!cur.ok) { renderPathListEmpty(); return; }
    var items = collectPaths(cur.tree, 80);
    if (!items.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '这个 JSON 里没有更深层的子路径';
      pl.appendChild(e);
      return;
    }
    var make = function (it) {
      var row = document.createElement('div');
      row.className = 'it';
      var g = document.createElement('div');
      g.className = 'grow mono brk';
      g.textContent = '$' + it.p;
      row.appendChild(g);
      var tg = document.createElement('span');
      tg.className = 'tag';
      tg.textContent = typeOf(it.v, cur.map);
      row.appendChild(tg);
      row.title = '点击把这条路径填回输入框';
      row.addEventListener('click', function () {
        $('#jf-path').value = it.p.replace(/^\./, '');
        runPath();
      });
      pl.appendChild(row);
    };
    for (var i = 0; i < items.length; i++) make(items[i]);
  }

  // ============ 路径取值 ============
  function runPath() {
    var p = $('#jf-path').value.trim();
    if (!p) { pmsg('先填一个路径,例如 配置.嵌套.层级1.层级2[*].名称', 'bad'); return; }
    if (!cur.ok) { pmsg('输入不是合法 JSON,无法取值', 'bad'); return; }
    var toks;
    try { toks = parsePath(p); } catch (e) { pmsg(e.message || '路径写法不合法', 'bad'); return; }
    if (!toks.length) { pmsg('路径写法不合法', 'bad'); return; }
    var list = [{ v: cur.tree, p: '' }], i, j, k, nxt, got;
    for (i = 0; i < toks.length; i++) {
      nxt = [];
      for (j = 0; j < list.length; j++) {
        got = stepPath(list[j].v, toks[i], list[j].p);
        for (k = 0; k < got.length; k++) nxt.push(got[k]);
        if (nxt.length > 800) break;
      }
      list = nxt;
      if (!list.length) break;
    }
    var listEl = $('#jf-path-list'), outEl = $('#jf-path-out');
    if (!list.length) {
      listEl.innerHTML = '';
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '路径 ' + p + ' 没有匹配到内容';
      listEl.appendChild(e);
      outEl.hidden = true;
      lastPathOut = '';
      pmsg('没有匹配到内容', 'bad');
      return;
    }
    pmsg('匹配到 ' + list.length + ' 处', 'ok');
    listEl.innerHTML = '';
    var shown = Math.min(list.length, 200);
    var make = function (r) {
      var row = document.createElement('div');
      row.className = 'it';
      var g = document.createElement('div');
      g.className = 'grow mono brk';
      g.textContent = '$' + r.p;
      row.appendChild(g);
      var pv = document.createElement('span');
      pv.className = 'jf-pv';
      pv.textContent = preview(r.v);
      row.appendChild(pv);
      var tg = document.createElement('span');
      tg.className = 'tag';
      tg.textContent = typeOf(r.v, cur.map);
      row.appendChild(tg);
      row.title = '点击把这条具体路径填回输入框';
      row.addEventListener('click', function () {
        $('#jf-path').value = r.p.replace(/^\./, '');
        runPath();
      });
      listEl.appendChild(row);
    };
    for (i = 0; i < shown; i++) make(list[i]);
    if (list.length > shown) {
      var more = document.createElement('div');
      more.className = 'msg warn';
      more.textContent = '还有 ' + (list.length - shown) + ' 处未列出';
      listEl.appendChild(more);
    }
    var val = list.length === 1 ? list[0].v : list.map(function (r) { return r.v; });
    lastPathOut = ser(val, { indent: indentStr(), sort: st.sort, map: cur.map });
    outEl.textContent = lastPathOut;
    outEl.hidden = false;
  }

  // ============ 事件接线 ============
  function wire() {
    $('#jf-in').addEventListener('input', function () { st.outMode = 'format'; schedule(); });

    OC.seg('#jf-indent', function (v) {
      st.indent = v;
      $('#jf-width').hidden = v !== 'custom';
      if (st.outMode !== 'custom') render();
    });
    OC.seg('#jf-num', function (v) {
      st.num = v;
      $('#jf-num-hint').textContent = v === 'raw'
        ? '「保留原样」重排时不会动数字本身,超出 2^53 的大整数不会变成 1e+21;「解析为数字」按 JS 数值处理,大整数会失真。'
        : '当前按 JS 数值解析:超出 2^53 的大整数会失真(例如变成科学计数法),需要保真请切回「保留原样」。';
      analyze();
    });
    $('#jf-width').addEventListener('input', function () {
      var n = Number(this.value);
      st.customW = isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 3;
      if (st.outMode !== 'custom' && st.indent === 'custom') render();
    });
    $('#jf-sort').addEventListener('change', function () {
      st.sort = this.checked;
      if (st.outMode !== 'custom') render();
    });

    $('#jf-format').addEventListener('click', function () {
      if (!cur.ok) { OC.toast('输入不是合法 JSON', 'bad'); return; }
      st.outMode = 'format';
      render();
      var name = st.indent === 'tab' ? 'Tab' : (st.indent === 'custom' ? st.customW + ' 空格' : st.indent + ' 空格');
      opMsg('已格式化:' + name + (st.sort ? ' · 键名已排序' : '') + (st.num === 'raw' ? ' · 数字保留原样' : ''), 'ok');
    });
    $('#jf-min').addEventListener('click', function () {
      if (!cur.ok) { OC.toast('输入不是合法 JSON', 'bad'); return; }
      st.outMode = 'minify';
      render();
      opMsg('已压缩为一行', 'ok');
    });

    $('#jf-esc').addEventListener('click', function () {
      var t = $('#jf-in').value;
      if (!t.trim()) { OC.toast('先输入内容', 'bad'); return; }
      setOut(JSON.stringify(t.trim()));
      st.outMode = 'custom';
      opMsg('已转成字符串字面量,可直接嵌进代码或某个 JSON 字段的值', 'ok');
    });
    $('#jf-unesc').addEventListener('click', function () {
      var t = $('#jf-in').value;
      if (!t.trim()) { OC.toast('先输入内容', 'bad'); return; }
      var r = unescapeText(t);
      setOut(r.text);
      st.outMode = 'custom';
      opMsg(r.manual ? '已按常见转义规则还原(无法识别的转义按原样保留),点「用输出替换输入」继续处理'
                     : '已去掉转义,点「用输出替换输入」把它变回 JSON', r.manual ? 'warn' : 'ok');
    });
    $('#jf-unwrap').addEventListener('click', function () {
      var t = $('#jf-in').value;
      if (!t.trim()) { OC.toast('先输入内容', 'bad'); return; }
      var r = unwrapAll(t);
      if (!r) { opMsg('输入不是「字符串里装着 JSON」的形态,无法再解一层(可以先试「去掉输入的转义」)', 'warn'); return; }
      $('#jf-in').value = r.text;
      st.outMode = 'format';
      analyze();
      opMsg('已解开 ' + r.layers + ' 层,当前内容已是可直接解析的 JSON', 'ok');
    });

    $('#jf-qs-run').addEventListener('click', function () {
      var dir = OC.segVal('#jf-qs-dir') || 'to';
      var t = $('#jf-in').value;
      if (!t.trim()) { OC.say('#jf-qs-msg', '请先在输入框里放内容', 'bad'); return; }
      if (dir === 'to') {
        if (!cur.ok) { OC.say('#jf-qs-msg', '输入不是合法 JSON,无法生成查询串', 'bad'); return; }
        if (!isObj(cur.tree)) { OC.say('#jf-qs-msg', '只有顶层是对象才能生成查询串', 'bad'); return; }
        setOut(toQuery(cur.tree, cur.map));
        st.outMode = 'custom';
        OC.say('#jf-qs-msg', '已生成查询串,结果在「输出」', 'ok');
        opMsg('JSON → 查询串', 'ok');
      } else {
        var r = fromQuery(t);
        if (!r.ok) { OC.say('#jf-qs-msg', r.reason, 'bad'); return; }
        setOut(ser(r.value, { indent: indentStr(), sort: st.sort, map: null }));
        st.outMode = 'custom';
        OC.say('#jf-qs-msg', '已解析出 ' + Object.keys(r.value).length + ' 个字段,结果在「输出」', 'ok');
        opMsg('查询串 → JSON', 'ok');
      }
    });

    $('#jf-path-run').addEventListener('click', runPath);
    $('#jf-path').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runPath(); }
    });
    $('#jf-path-copy').addEventListener('click', function () {
      if (!lastPathOut) { OC.toast('还没有可复制的结果', 'bad'); return; }
      OC.copy(lastPathOut, '取值结果已复制');
    });

    $('#jf-copy').addEventListener('click', function () { OC.copyNode('#jf-out', '输出已复制'); });
    $('#jf-to-in').addEventListener('click', function () {
      var v = $('#jf-out').value;
      if (!v) { OC.toast('输出为空,没有可替换的内容', 'bad'); return; }
      $('#jf-in').value = v;
      st.outMode = 'format';
      analyze();
      OC.toast('已用输出替换输入');
    });
    $('#jf-clear-out').addEventListener('click', function () { setOut(''); opMsg(''); });
    $('#jf-clear-in').addEventListener('click', function () {
      $('#jf-in').value = '';
      st.outMode = 'format';
      analyze();
      $('#jf-in').focus();
    });
    $('#jf-demo').addEventListener('click', function () {
      $('#jf-in').value = DEMO;
      st.outMode = 'format';
      schedule(0);
    });

    OC.drop('#jf-drop', function (files) {
      var f = files[0];
      if (!f) return;
      if (f.size > MAX) { OC.toast('文件超过 2 MB,已拒绝', 'bad'); return; }
      OC.readFile(f, 'text').then(function (t) {
        $('#jf-in').value = t;
        st.outMode = 'format';
        schedule(0);
        OC.toast('已载入 ' + f.name);
      }, function () { OC.toast('文件读取失败', 'bad'); });
    }, { accept: '.json,.txt,.js,.geojson,application/json,text/plain' });
  }

  // 初始化:先接好线,再放一个带嵌套/数组/中文/大整数的示例
  wire();
  $('#jf-in').value = DEMO;
  analyze();
})();
JF_JS;

return array(
    'id' => 'jsonfmt',
    'cat' => 'enc',
    'title' => 'JSON 格式化与校验',
    'body' => $body,
    'script' => $script,
);
