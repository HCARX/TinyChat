<?php
/**
 * 工具:文本处理(一页多能)。
 *
 * 一个常驻输入框 + 七个功能面板(去重 / 排序 / 清洗 / 大小写 / 行操作 / 转义 / 统计),
 * 用 .seg 分段控件切换,切换只改输出形态、不动输入。输入即算(120ms 防抖)。
 *
 * 关键实现选择:
 *   - 全部纯 JS 自写,零依赖(沙箱里也拉不到 CDN)。自然排序、全角转半角、
 *     不可见字符判定、Fisher-Yates 洗牌都各自实现,注释里写了边界。
 *   - 输入超过 1MB(UTF-8 字节)直接拒绝处理并在界面上说明,避免长循环卡死页面;
 *     列表类结果最多渲染 500 条(文本结果不受限)。
 *   - 统计/重复次数用 .rows 与 table 渲染,直接 textContent 写入,不拼 HTML。
 */
$body = <<<'TCTT_BODY'
<style>
.tt-panel[hidden],.tt-box[hidden]{display:none}
.seg.tt-seg{flex-wrap:wrap}
.tt-hint{margin:0 0 10px;font-size:.786rem;color:var(--t3)}
.tt-note{margin:6px 0 0;font-size:.786rem;color:var(--t3)}
#tt-in{min-height:200px}
#tt-out{min-height:200px}
.tt-fn-hd{margin:12px 0 0;font-size:.786rem;color:var(--t3)}
</style>

<div class="hd">
  <div class="grow">
    <h1>文本处理</h1>
    <div class="sub">去重、排序、清洗、大小写、行操作、转义、字符统计都在一页;边输入边算,结果可复制,也可一键替换回输入。</div>
  </div>
  <div class="acts">
    <button class="btn" id="tt-demo">填入示例</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>输入</h2>
      <span class="grow"></span>
      <span class="msg" id="tt-in-msg"></span>
      <button class="btn xs ghost" id="tt-in-clear">清空</button>
    </div>
    <textarea id="tt-in" class="wrap" spellcheck="false" placeholder="在这里粘贴或输入文本,支持多行;下面的统计与处理会随输入实时更新。"></textarea>
    <div class="stats mt" id="tt-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>功能</h2>
      <span class="grow"></span>
      <span class="msg" id="tt-fn-msg"></span>
    </div>
    <div class="seg tt-seg" id="tt-fn">
      <button class="seg-btn on" data-v="dedupe">去重</button>
      <button class="seg-btn" data-v="sort">排序</button>
      <button class="seg-btn" data-v="clean">清洗</button>
      <button class="seg-btn" data-v="case">大小写</button>
      <button class="seg-btn" data-v="line">行操作</button>
      <button class="seg-btn" data-v="escape">转义</button>
      <button class="seg-btn" data-v="stat">统计</button>
    </div>

    <div class="tt-panel" data-fn="dedupe" style="margin-top:12px">
      <p class="tt-hint">按整行比较,不改变其余行的相对顺序。「忽略大小写 / 首尾空格」只影响比较,不修改输出内容;末尾单个换行不计为一行。</p>
      <div class="seg tt-seg" id="tt-dd-mode">
        <button class="seg-btn on" data-v="first">保留首次</button>
        <button class="seg-btn" data-v="last">保留最后一次</button>
        <button class="seg-btn" data-v="dups">只看重复项</button>
        <button class="seg-btn" data-v="counts">重复次数</button>
      </div>
      <div class="row mt">
        <label class="row" style="gap:6px"><input type="checkbox" id="tt-dd-ic"> 忽略大小写</label>
        <label class="row" style="gap:6px"><input type="checkbox" id="tt-dd-tr"> 忽略首尾空格</label>
      </div>
    </div>

    <div class="tt-panel" data-fn="sort" hidden style="margin-top:12px">
      <p class="tt-hint">升 / 降序按字符编码逐位比较;「自然排序」把数字段当数值比,所以 a2 排在 a10 前面;「随机打乱」用 Fisher-Yates,洗牌时优先取 crypto 随机数,拿不到才退回 Math.random(前者不可预测,后者只适合随机展示)。</p>
      <div class="seg tt-seg" id="tt-so-mode">
        <button class="seg-btn on" data-v="asc">升序</button>
        <button class="seg-btn" data-v="desc">降序</button>
        <button class="seg-btn" data-v="lenDesc">长→短</button>
        <button class="seg-btn" data-v="lenAsc">短→长</button>
        <button class="seg-btn" data-v="natural">自然排序</button>
        <button class="seg-btn" data-v="shuffle">随机打乱</button>
      </div>
      <div class="row mt">
        <label class="row" style="gap:6px"><input type="checkbox" id="tt-so-ic"> 排序时忽略大小写</label>
      </div>
    </div>

    <div class="tt-panel" data-fn="clean" hidden style="margin-top:12px">
      <p class="tt-hint">可多选,按下列顺序执行:去空行 → 每行去首尾空格 → 去行首行尾指定字符 → 去掉所有空格 → 合并连续空格 → 全角转半角。</p>
      <div class="cols tight">
        <div class="f">
          <label class="row" style="gap:6px"><input type="checkbox" id="tt-cl-empty" checked> 去空行(整行只有空白也算空)</label>
          <label class="row" style="gap:6px"><input type="checkbox" id="tt-cl-trimline" checked> 每行去首尾空格</label>
          <label class="row" style="gap:6px"><input type="checkbox" id="tt-cl-nospace"> 去掉所有空格(含制表、全角空格,不动换行)</label>
          <label class="row" style="gap:6px"><input type="checkbox" id="tt-cl-collapse"> 合并连续空格为一个</label>
          <label class="row" style="gap:6px"><input type="checkbox" id="tt-cl-fw"> 全角转半角(字母数字与常见标点)</label>
        </div>
        <div class="f">
          <label class="row" style="gap:6px"><input type="checkbox" id="tt-cl-edge"> 去掉行首行尾的指定字符</label>
          <input type="text" id="tt-cl-edgechars" class="mono" spellcheck="false" placeholder="字符集合,例如: #*· 空格">
          <span class="tt-note">这里的每个字符构成一个集合,逐行从两端删掉属于集合的字符;中间的不动。</span>
        </div>
      </div>
    </div>

    <div class="tt-panel" data-fn="case" hidden style="margin-top:12px">
      <p class="tt-hint">「每行首字母大写」只把每行第一个字母改为大写,其余字符不动;「英文标题化」把虚词(a / the / of 等)小写,除非它落在首词或末词。</p>
      <div class="seg tt-seg" id="tt-cs-mode">
        <button class="seg-btn on" data-v="upper">全大写</button>
        <button class="seg-btn" data-v="lower">全小写</button>
        <button class="seg-btn" data-v="capFirst">每行首字母</button>
        <button class="seg-btn" data-v="capWords">每词首字母</button>
        <button class="seg-btn" data-v="swap">反转大小写</button>
        <button class="seg-btn" data-v="title">标题化</button>
      </div>
    </div>

    <div class="tt-panel" data-fn="line" hidden style="margin-top:12px">
      <p class="tt-hint">行与行按换行划分,末尾的单个换行不计为一行。分隔符与连接符里可以写 \n、\t 表示真实换行 / 制表。</p>
      <div class="seg tt-seg" id="tt-ln-mode">
        <button class="seg-btn on" data-v="number">加行号</button>
        <button class="seg-btn" data-v="unnumber">去行号</button>
        <button class="seg-btn" data-v="affix">加前后缀</button>
        <button class="seg-btn" data-v="split">拆分成多行</button>
        <button class="seg-btn" data-v="join">合并成一行</button>
      </div>

      <div class="tt-lnsub" data-ln="number" style="margin-top:10px">
        <div class="cols tight">
          <div class="f"><span class="lab">起始值</span><input type="number" id="tt-ln-start" value="1" step="1"></div>
          <div class="f"><span class="lab">编号与内容之间的分隔符</span><input type="text" id="tt-ln-sep" class="mono" value=". " spellcheck="false"></div>
          <div class="f"><span class="lab">选项</span><label class="row" style="gap:6px"><input type="checkbox" id="tt-ln-pad"> 左侧补零对齐</label></div>
        </div>
      </div>

      <div class="tt-lnsub" data-ln="unnumber" hidden style="margin-top:10px">
        <p class="tt-note">删掉行首形如「12. 」「3、」「7) 」的编号及其后空格;单独的数字后必须有分隔符或空格才处理,所以「2026年」这类正文不会被误删。</p>
      </div>

      <div class="tt-lnsub" data-ln="affix" hidden style="margin-top:10px">
        <div class="cols tight">
          <div class="f"><span class="lab">每行前缀</span><input type="text" id="tt-ln-pre" class="mono" spellcheck="false" placeholder="例如: - "></div>
          <div class="f"><span class="lab">每行后缀</span><input type="text" id="tt-ln-suf" class="mono" spellcheck="false" placeholder="例如: ,"></div>
        </div>
        <label class="row mt" style="gap:6px"><input type="checkbox" id="tt-ln-askip"> 跳过空行</label>
      </div>

      <div class="tt-lnsub" data-ln="split" hidden style="margin-top:10px">
        <div class="cols tight">
          <div class="f"><span class="lab">分隔符</span><input type="text" id="tt-ln-del" class="mono" value="," spellcheck="false"></div>
          <div class="f">
            <span class="lab">选项</span>
            <label class="row" style="gap:6px"><input type="checkbox" id="tt-ln-delrx"> 按正则表达式</label>
            <label class="row" style="gap:6px"><input type="checkbox" id="tt-ln-deltrim" checked> 去每段首尾空格</label>
            <label class="row" style="gap:6px"><input type="checkbox" id="tt-ln-deldrop" checked> 丢弃空段</label>
          </div>
        </div>
      </div>

      <div class="tt-lnsub" data-ln="join" hidden style="margin-top:10px">
        <div class="cols tight">
          <div class="f"><span class="lab">连接符</span><input type="text" id="tt-ln-conn" class="mono" value=", " spellcheck="false"></div>
          <div class="f"><span class="lab">选项</span><label class="row" style="gap:6px"><input type="checkbox" id="tt-ln-skipempty"> 跳过空行</label></div>
        </div>
      </div>
    </div>

    <div class="tt-panel" data-fn="escape" hidden style="margin-top:12px">
      <p class="tt-hint">「反转义」把 \n \t \\ \uXXXX \xXX 之类的写法还原成真实字符;「JSON 字面量」输出带引号、可直接粘进代码的字符串;「清理不可见字符」删掉零宽与格式控制字符(保留换行、制表、回车)。</p>
      <div class="seg tt-seg" id="tt-es-mode">
        <button class="seg-btn on" data-v="unescape">反转义</button>
        <button class="seg-btn" data-v="json">JSON 字面量</button>
        <button class="seg-btn" data-v="strip">清理不可见</button>
      </div>
    </div>

    <div class="tt-panel" data-fn="stat" hidden style="margin-top:12px">
      <p class="tt-hint">统计全文字符出现次数,列出最多的 10 个。换行、制表、空格在表里会显示成可见符号。</p>
      <label class="row" style="gap:6px"><input type="checkbox" id="tt-st-igws" checked> 忽略空白字符</label>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>输出</h2>
    <span class="grow"></span>
    <span class="msg" id="tt-out-msg"></span>
    <span class="tag" id="tt-out-bytes">0 B</span>
  </div>
  <div class="tt-box" id="tt-out-box">
    <textarea id="tt-out" class="wrap" readonly spellcheck="false" placeholder="处理结果会显示在这里"></textarea>
  </div>
  <div class="tt-box rows" id="tt-list" hidden></div>
  <div class="tt-box" id="tt-tbl-box" hidden>
    <table>
      <thead><tr><th>字符</th><th class="num">次数</th><th class="num">占比</th></tr></thead>
      <tbody id="tt-tbody"></tbody>
    </table>
  </div>
  <div class="row mt">
    <button class="btn p" id="tt-copy">复制结果</button>
    <button class="btn" id="tt-use">用结果替换输入</button>
    <span class="sp"></span>
    <button class="btn ghost" id="tt-out-clear">清空输出</button>
  </div>
  <p class="tt-note">结果只在本页处理,不上传;「复制结果」走系统剪贴板,失败时会退回选区复制。</p>
</div>
TCTT_BODY;
$script = <<<'TCTT_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  var MAX_BYTES = 1048576;    // 1MB:超过直接拒绝处理
  var WARN_BYTES = 524288;    // 512KB:提示但照常处理
  var LIST_CAP = 500;         // 列表类结果最多渲染的行数

  var fn = 'dedupe';
  var cur = { kind: 'text', text: '', note: '', noteKind: '' };
  var timer = 0;

  // ================= 基础工具 =================
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
  // 码点数(代理对算一个字符)
  function cpLen(s) {
    var n = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) i++;
      }
      n++;
    }
    return n;
  }
  // 拆行:末尾单个换行不计为一行(常见编辑器的观感)
  function splitLines(t) {
    if (t === '') return [];
    var a = t.split(/\r\n|\r|\n/);
    if (a.length > 1 && a[a.length - 1] === '') a.pop();
    return a;
  }
  function countWords(t) {
    var han = (t.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || []).length;
    var rest = t.replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, ' ');
    var lat = (rest.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []).length;
    return han + lat;
  }
  function finish(text, note, kind) {
    return { kind: 'text', text: text, note: note || '', noteKind: kind || '' };
  }
  function stat(k, v) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }

  // ================= 输入统计 =================
  function updateStats() {
    var t = $('#tt-in').value;
    var lines = splitLines(t);
    var longest = 0, i;
    for (i = 0; i < lines.length; i++) {
      var l = cpLen(lines[i]);
      if (l > longest) longest = l;
    }
    var uniq = lines.length ? new Set(lines).size : 0;
    $('#tt-stats').innerHTML =
      stat('字符', cpLen(t)) +
      stat('字节', utf8Len(t)) +
      stat('行数', lines.length) +
      stat('词数', countWords(t)) +
      stat('去重行', uniq) +
      stat('最长行', longest);
  }

  // ================= 去重 =================
  function fDedupe(t) {
    var lines = splitLines(t);
    if (!lines.length) return finish('', '没有内容');
    var mode = OC.segVal('#tt-dd-mode') || 'first';
    var ic = $('#tt-dd-ic').checked, tr = $('#tt-dd-tr').checked;
    function key(s) { if (tr) s = s.trim(); return ic ? s.toLowerCase() : s; }
    var info = {}, order = [];
    for (var i = 0; i < lines.length; i++) {
      var k = key(lines[i]);
      if (!info[k]) { info[k] = { n: 0, first: lines[i] }; order.push(k); }
      info[k].n++;
    }
    if (mode === 'counts') {
      var rows = order.map(function (k) { return { v: info[k].first, n: info[k].n }; });
      // sort 是稳定排序:次数相同则保持首次出现顺序
      rows.sort(function (a, b) { return b.n - a.n; });
      var txt = rows.map(function (r) { return r.n + '\t' + r.v; }).join('\n');
      return { kind: 'list', list: rows, text: txt, note: '共 ' + rows.length + ' 种,合计 ' + lines.length + ' 行', noteKind: '' };
    }
    if (mode === 'dups') {
      var dup = order.filter(function (k) { return info[k].n > 1; });
      var out = dup.map(function (k) { return info[k].first; });
      return finish(out.join('\n'), dup.length ? '重复的 ' + dup.length + ' 种(冗余 ' + (lines.length - dup.length) + ' 行)' : '没有重复行', dup.length ? '' : 'warn');
    }
    if (mode === 'last') {
      var seen = {}, rev = [];
      for (var j = lines.length - 1; j >= 0; j--) {
        var kj = key(lines[j]);
        if (!seen[kj]) { seen[kj] = 1; rev.push(lines[j]); }
      }
      rev.reverse();
      return finish(rev.join('\n'), lines.length + ' → ' + rev.length + ' 行(保留最后一次)');
    }
    var seen2 = {}, out2 = [];
    for (var m = 0; m < lines.length; m++) {
      var km = key(lines[m]);
      if (!seen2[km]) { seen2[km] = 1; out2.push(lines[m]); }
    }
    return finish(out2.join('\n'), lines.length + ' → ' + out2.length + ' 行(保留首次)');
  }

  // ================= 排序 =================
  // 自然排序:把字符串切成「数字段 / 非数字段」交替,数字段按数值比,
  // 因此 a2 < a10;ic 为真时非数字段忽略大小写。
  function natCmp(a, b, ic) {
    var A = a.match(/\d+|\D+/g) || [], B = b.match(/\d+|\D+/g) || [];
    var n = Math.min(A.length, B.length), i, x, y;
    for (i = 0; i < n; i++) {
      x = A[i]; y = B[i];
      var xn = /^\d/.test(x), yn = /^\d/.test(y);
      if (xn && yn) {
        var dx = Number(x), dy = Number(y);
        if (dx !== dy) return dx < dy ? -1 : 1;
      } else {
        if (ic) { x = x.toLowerCase(); y = y.toLowerCase(); }
        if (x !== y) return x < y ? -1 : 1;
      }
    }
    return A.length - B.length;
  }
  // 洗牌取随机数的差别:crypto.getRandomValues 不可预测(适合任何用途),
  // Math.random 可被推断、只适合随机展示。这里优先 crypto,拿不到才退回。
  function randInt(n) {
    if (n <= 1) return 0;
    if (window.crypto && window.crypto.getRandomValues) {
      var lim = Math.floor(4294967296 / n) * n;   // 拒绝采样,避免模偏差
      var a = new Uint32Array(1);
      do { window.crypto.getRandomValues(a); } while (a[0] >= lim);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function fSort(t) {
    var lines = splitLines(t);
    if (lines.length < 2) return finish(lines.join('\n'), lines.length ? '不足两行,顺序不变' : '没有内容', lines.length ? 'warn' : '');
    var mode = OC.segVal('#tt-so-mode') || 'asc';
    var ic = $('#tt-so-ic').checked;
    var arr = lines.slice(), cmp, dir;
    if (mode === 'shuffle') {
      shuffle(arr);
      return finish(arr.join('\n'), '已随机打乱 ' + arr.length + ' 行');
    }
    if (mode === 'natural') cmp = function (a, b) { return natCmp(a, b, ic); };
    else if (mode === 'lenDesc' || mode === 'lenAsc') {
      dir = mode === 'lenDesc' ? -1 : 1;
      cmp = function (a, b) { return (cpLen(a) - cpLen(b)) * dir; };
    } else {
      dir = mode === 'desc' ? -1 : 1;
      cmp = function (a, b) {
        var x = ic ? a.toLowerCase() : a, y = ic ? b.toLowerCase() : b;
        return x < y ? -dir : x > y ? dir : 0;
      };
    }
    arr.sort(cmp);
    var label = { asc: '升序', desc: '降序', lenDesc: '按长度(长→短)', lenAsc: '按长度(短→长)', natural: '自然排序' }[mode] || mode;
    return finish(arr.join('\n'), '已' + label + ',共 ' + arr.length + ' 行');
  }

  // ================= 清洗 =================
  function trimEdge(s, set) {
    var a = 0, b = s.length;
    while (a < b && set.indexOf(s.charAt(a)) >= 0) a++;
    while (b > a && set.indexOf(s.charAt(b - 1)) >= 0) b--;
    return s.slice(a, b);
  }
  // 全角转半角:FF01-FF5E 与 ASCII 21-7E 一一对应(区码差 0xFEE0),
  // 全角空格 3000 单独映射;另外补一张常见标点的显式表。
  var FW_EXTRA = {
    0x3000: ' ', 0x3002: '.', 0x3001: ',', 0x201C: '"', 0x201D: '"',
    0x2018: "'", 0x2019: "'", 0x3010: '[', 0x3011: ']', 0x3014: '(', 0x3015: ')',
    0x2014: '-', 0x2013: '-', 0x2026: '...', 0x00B7: '.'
  };
  function fullToHalf(s) {
    var out = '', i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
      else if (FW_EXTRA[c] !== undefined) out += FW_EXTRA[c];
      else out += s.charAt(i);
    }
    return out;
  }
  function fClean(t) {
    var lines = splitLines(t), notes = [], before, set;
    var doEmpty = $('#tt-cl-empty').checked, doTrim = $('#tt-cl-trimline').checked;
    var doEdge = $('#tt-cl-edge').checked, doNoSp = $('#tt-cl-nospace').checked;
    var doCollapse = $('#tt-cl-collapse').checked, doFw = $('#tt-cl-fw').checked;
    if (doEmpty) {
      before = lines.length;
      lines = lines.filter(function (l) { return l.trim() !== ''; });
      if (lines.length !== before) notes.push('去空行 ' + before + '→' + lines.length);
    }
    if (doTrim) { lines = lines.map(function (l) { return l.trim(); }); notes.push('每行去首尾空格'); }
    if (doEdge) {
      set = $('#tt-cl-edgechars').value;
      if (set) { lines = lines.map(function (l) { return trimEdge(l, set); }); notes.push('去行首行尾指定字符'); }
    }
    var out = lines.join('\n');
    if (doNoSp) { out = out.replace(/[ \t\u3000]+/g, ''); notes.push('去所有空格'); }
    if (doCollapse) { out = out.replace(/[ \t\u3000]{2,}/g, ' '); notes.push('合并连续空格'); }
    if (doFw) { out = fullToHalf(out); notes.push('全角转半角'); }
    if (!notes.length) return finish(out, '未勾选任何清洗项,输出与输入相同', 'warn');
    return finish(out, '已' + notes.join(' · '));
  }

  // ================= 大小写 =================
  var SMALL = ['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'for', 'of', 'in', 'on',
    'at', 'to', 'from', 'by', 'with', 'without', 'as', 'per', 'via', 'vs', 'into',
    'onto', 'over', 'under', 'is', 'are', 'be'];
  function titleCase(line) {
    var re = /[A-Za-z][A-Za-z'-]*/g, m, tokens = [], last = 0, res = '', i;
    while ((m = re.exec(line))) tokens.push({ w: m[0], s: m.index, e: re.lastIndex });
    if (!tokens.length) return line;
    for (i = 0; i < tokens.length; i++) {
      var lower = tokens[i].w.toLowerCase();
      var edge = (i === 0 || i === tokens.length - 1);
      var out = (!edge && SMALL.indexOf(lower) >= 0) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
      res += line.slice(last, tokens[i].s) + out;
      last = tokens[i].e;
    }
    return res + line.slice(last);
  }
  function fCase(t) {
    var mode = OC.segVal('#tt-cs-mode') || 'upper';
    if (mode === 'upper') return finish(t.toUpperCase(), '已转全大写');
    if (mode === 'lower') return finish(t.toLowerCase(), '已转全小写');
    var lines = splitLines(t);
    if (mode === 'capFirst') {
      return finish(lines.map(function (l) {
        return l.replace(/[A-Za-z]/, function (c) { return c.toUpperCase(); });
      }).join('\n'), '每行首字母大写');
    }
    if (mode === 'capWords') {
      return finish(lines.map(function (l) {
        return l.replace(/[A-Za-z]+/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1); });
      }).join('\n'), '每个词首字母大写');
    }
    if (mode === 'swap') {
      return finish(t.replace(/[A-Za-z]/g, function (c) {
        return c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
      }), '已反转大小写');
    }
    return finish(lines.map(titleCase).join('\n'), '英文标题化(虚词小写)');
  }

  // ================= 行操作 =================
  function padNum(n, w) {
    var s = String(n), neg = s.charAt(0) === '-', digs = neg ? s.slice(1) : s;
    while (digs.length < w) digs = '0' + digs;
    return (neg ? '-' : '') + digs;
  }
  function decodeEsc(s) {
    return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
  }
  function fLine(t) {
    var lines = splitLines(t);
    var mode = OC.segVal('#tt-ln-mode') || 'number';
    var i, out;
    if (mode === 'number') {
      var start = parseInt($('#tt-ln-start').value, 10);
      if (isNaN(start)) start = Number($('#tt-ln-start').value) || 0;
      var sep = $('#tt-ln-sep').value;
      var pad = $('#tt-ln-pad').checked;
      var lastN = start + Math.max(0, lines.length - 1);
      var w = pad ? String(Math.abs(lastN)).length : 0;
      out = lines.map(function (l, idx) {
        var n = start + idx;
        return (pad && n >= 0 ? padNum(n, w) : String(n)) + sep + l;
      }).join('\n');
      return finish(out, '已加行号(起始 ' + start + ',分隔符「' + sep + '」)');
    }
    if (mode === 'unnumber') {
      var re1 = /^\s*\d+\s*[.)、:：\-]\s*/;
      var re2 = /^\s*\d+\s+/;
      var hit = 0;
      out = lines.map(function (l) {
        var r = l.replace(re1, '');
        if (r === l) r = l.replace(re2, '');
        if (r !== l) hit++;
        return r;
      }).join('\n');
      return finish(out, hit ? '已去掉 ' + hit + ' 行的行首编号' : '没有发现行首编号', hit ? '' : 'warn');
    }
    if (mode === 'affix') {
      var pre = $('#tt-ln-pre').value, suf = $('#tt-ln-suf').value, askip = $('#tt-ln-askip').checked;
      var used = 0;
      out = lines.map(function (l) {
        if (askip && l.trim() === '') return l;
        used++;
        return pre + l + suf;
      }).join('\n');
      return finish(out, '已给 ' + used + ' 行加前后缀');
    }
    if (mode === 'split') {
      var del = $('#tt-ln-del').value;
      if (!del) return finish(t, '分隔符为空,未拆分', 'warn');
      del = decodeEsc(del);
      var parts;
      try {
        parts = $('#tt-ln-delrx').checked ? t.split(new RegExp(del, 'g')) : t.split(del);
      } catch (e) {
        return { kind: 'text', text: '', note: '分隔符不是合法正则:' + ((e && e.message) || e), noteKind: 'bad' };
      }
      if ($('#tt-ln-deltrim').checked) parts = parts.map(function (s) { return s.trim(); });
      if ($('#tt-ln-deldrop').checked) parts = parts.filter(function (s) { return s !== ''; });
      return finish(parts.join('\n'), '已拆成 ' + parts.length + ' 行');
    }
    var conn = decodeEsc($('#tt-ln-conn').value);
    var skipE = $('#tt-ln-skipempty').checked;
    var arr = skipE ? lines.filter(function (l) { return l.trim() !== ''; }) : lines;
    return finish(arr.join(conn), '已把 ' + arr.length + ' 行合并成一行');
  }

  // ================= 转义 =================
  var ESC_MAP = {
    n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v',
    '0': String.fromCharCode(0), '\\': '\\'
  };
  // 零宽 / 格式控制 / 不可见码点:保留 \t \n \r
  function isInvisible(cp) {
    if (cp === 0x09 || cp === 0x0A || cp === 0x0D) return false;
    if (cp < 0x20) return true;
    if (cp >= 0x7F && cp <= 0x9F) return true;
    if (cp === 0xAD) return true;
    if (cp === 0x034F) return true;
    if (cp >= 0x180B && cp <= 0x180E) return true;
    if (cp >= 0x200B && cp <= 0x200F) return true;
    if (cp >= 0x202A && cp <= 0x202E) return true;
    if (cp >= 0x2060 && cp <= 0x2064) return true;
    if (cp >= 0x206A && cp <= 0x206F) return true;
    if (cp >= 0xFE00 && cp <= 0xFE0F) return true;
    if (cp === 0xFEFF) return true;
    return false;
  }
  function fEscape(t) {
    var mode = OC.segVal('#tt-es-mode') || 'unescape';
    if (mode === 'json') return finish(JSON.stringify(t), '已转成 JSON 字符串字面量(含首尾引号)');
    if (mode === 'unescape') {
      var n = 0;
      var out = t.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrtbfv0\\'"\/])/g, function (m, g) {
        n++;
        if (g.charAt(0) === 'u' || g.charAt(0) === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
        if (g === "'" || g === '"' || g === '/') return g;
        return ESC_MAP[g] !== undefined ? ESC_MAP[g] : m;
      });
      return finish(out, n ? '已还原 ' + n + ' 处转义' : '没有发现可还原的转义序列', n ? '' : 'warn');
    }
    var removed = 0, kinds = {}, res = '', i, cp, ch;
    for (i = 0; i < t.length; i++) {
      cp = t.codePointAt(i);
      ch = String.fromCodePoint(cp);
      if (cp > 0xFFFF) i++;
      if (isInvisible(cp)) { removed++; kinds[cp] = 1; continue; }
      res += ch;
    }
    var kindN = Object.keys(kinds).length;
    return finish(res, removed ? '已剔除 ' + removed + ' 个不可见字符(共 ' + kindN + ' 种码点)' : '没有发现零宽或不可见字符', removed ? '' : 'warn');
  }

  // ================= 统计 =================
  function visChar(ch) {
    var cp = ch.codePointAt(0);
    if (ch === '\n') return '↵(换行)';
    if (ch === '\r') return '␍(回车)';
    if (ch === '\t') return '⇥(制表)';
    if (ch === ' ') return '␠(空格)';
    if (ch === '\u3000') return '□(全角空格)';
    if (cp < 0x20 || cp === 0x7F) return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    return ch;
  }
  function fStat(t) {
    var igws = $('#tt-st-igws').checked;
    var map = {}, order = [], total = 0, i, cp, ch;
    for (i = 0; i < t.length; i++) {
      cp = t.codePointAt(i);
      ch = String.fromCodePoint(cp);
      if (cp > 0xFFFF) i++;
      if (igws && /\s/.test(ch)) continue;
      if (map[ch] === undefined) { map[ch] = 0; order.push(ch); }
      map[ch]++;
      total++;
    }
    if (!total) return { kind: 'table', table: [], text: '', note: '没有可统计的字符', noteKind: 'warn' };
    var rows = order.map(function (c) { return { ch: c, n: map[c] }; });
    rows.sort(function (a, b) { return b.n - a.n; });
    var top = rows.slice(0, 10);
    var txt = top.map(function (r) { return visChar(r.ch) + '\t' + r.n + '\t' + (r.n / total * 100).toFixed(2) + '%'; }).join('\n');
    var table = top.map(function (r) {
      return { ch: visChar(r.ch), n: r.n, pct: (r.n / total * 100).toFixed(2) + '%' };
    });
    return {
      kind: 'table', table: table, text: txt,
      note: '共 ' + total + ' 个字符,去重后 ' + rows.length + ' 种;下表为最多的 ' + top.length + ' 个', noteKind: ''
    };
  }

  // ================= 分派 =================
  function dispatch(t) {
    switch (fn) {
      case 'sort': return fSort(t);
      case 'clean': return fClean(t);
      case 'case': return fCase(t);
      case 'line': return fLine(t);
      case 'escape': return fEscape(t);
      case 'stat': return fStat(t);
      default: return fDedupe(t);
    }
  }

  // ================= 输出渲染 =================
  function renderList(items) {
    var box = $('#tt-list');
    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = '<div class="empty">没有重复行</div>';
      return;
    }
    if (items.length > LIST_CAP) {
      var w = document.createElement('div');
      w.className = 'msg warn';
      w.textContent = '共 ' + items.length + ' 种,只显示前 ' + LIST_CAP + ' 种。';
      box.appendChild(w);
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < Math.min(items.length, LIST_CAP); i++) {
      var it = document.createElement('div');
      it.className = 'it';
      var g = document.createElement('span');
      g.className = 'grow mono';
      g.textContent = items[i].v === '' ? '(空行)' : items[i].v;
      g.title = items[i].v;
      var t = document.createElement('span');
      t.className = 'tag';
      t.textContent = '× ' + items[i].n;
      it.appendChild(g);
      it.appendChild(t);
      frag.appendChild(it);
    }
    box.appendChild(frag);
  }
  function renderTable(rows) {
    var tb = $('#tt-tbody');
    tb.innerHTML = '';
    if (!rows.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'empty';
      td.textContent = '没有可统计的字符';
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var r = document.createElement('tr');
      var c1 = document.createElement('td');
      c1.className = 'mono';
      c1.textContent = rows[i].ch;
      var c2 = document.createElement('td');
      c2.className = 'num';
      c2.textContent = rows[i].n;
      var c3 = document.createElement('td');
      c3.className = 'num';
      c3.textContent = rows[i].pct;
      r.appendChild(c1); r.appendChild(c2); r.appendChild(c3);
      tb.appendChild(r);
    }
  }
  function renderOutput(res) {
    cur = res || { kind: 'text', text: '', note: '', noteKind: '' };
    var text = cur.text || '';
    $('#tt-out').value = text;
    var kind = cur.kind || 'text';
    $('#tt-out-box').hidden = kind !== 'text';
    $('#tt-list').hidden = kind !== 'list';
    $('#tt-tbl-box').hidden = kind !== 'table';
    if (kind === 'list') renderList(cur.list || []);
    if (kind === 'table') renderTable(cur.table || []);
    OC.say('#tt-out-msg', cur.note || '', cur.noteKind || '');
    $('#tt-out-bytes').textContent = OC.fmtBytes(utf8Len(text));
  }

  // ================= 主流程 =================
  function process() {
    var t = $('#tt-in').value;
    var bytes = utf8Len(t);
    var outMsg = $('#tt-out-msg');
    if (bytes > MAX_BYTES) {
      renderOutput({ kind: 'text', text: '', note: '', noteKind: '' });
      OC.say('#tt-in-msg', OC.fmtBytes(bytes) + ' / 1MB 上限', 'bad');
      OC.say(outMsg, '输入 ' + OC.fmtBytes(bytes) + ' 超过 1MB,已停止处理;请分段处理后再用结果替换输入。', 'bad');
      return;
    }
    OC.say('#tt-in-msg', bytes > WARN_BYTES ? OC.fmtBytes(bytes) + ' · 较大输入,列表类结果最多显示 ' + LIST_CAP + ' 条' : (bytes ? OC.fmtBytes(bytes) : ''), bytes > WARN_BYTES ? 'warn' : '');
    if (!t) { renderOutput({ kind: 'text', text: '', note: '输入为空,先在左上角粘贴文本', noteKind: 'warn' }); return; }
    var res;
    try { res = dispatch(t); }
    catch (e) {
      renderOutput({ kind: 'text', text: '', note: '', noteKind: '' });
      OC.say(outMsg, '处理出错:' + ((e && e.message) || e), 'bad');
      return;
    }
    renderOutput(res);
  }
  function live() {
    clearTimeout(timer);
    timer = setTimeout(function () { updateStats(); process(); }, 120);
  }

  // ================= 面板切换 =================
  function showPanel(v) {
    var panels = $$('.tt-panel');
    for (var i = 0; i < panels.length; i++) panels[i].hidden = panels[i].getAttribute('data-fn') !== v;
  }
  function showLnSub(v) {
    var subs = $$('.tt-lnsub');
    for (var i = 0; i < subs.length; i++) subs[i].hidden = subs[i].getAttribute('data-ln') !== v;
  }

  // ================= 接线 =================
  var LIVE_CB = ['#tt-dd-ic', '#tt-dd-tr', '#tt-so-ic', '#tt-cl-empty', '#tt-cl-trimline',
    '#tt-cl-nospace', '#tt-cl-collapse', '#tt-cl-edge', '#tt-cl-fw', '#tt-ln-pad',
    '#tt-ln-askip', '#tt-ln-delrx', '#tt-ln-deltrim', '#tt-ln-deldrop',
    '#tt-ln-skipempty', '#tt-st-igws'];
  var LIVE_IN = ['#tt-ln-start', '#tt-ln-sep', '#tt-ln-pre', '#tt-ln-suf',
    '#tt-ln-del', '#tt-ln-conn', '#tt-cl-edgechars'];

  function wire() {
    OC.seg('#tt-fn', function (v) { fn = v; showPanel(v); live(); });
    OC.seg('#tt-dd-mode', live);
    OC.seg('#tt-so-mode', live);
    OC.seg('#tt-cs-mode', live);
    OC.seg('#tt-es-mode', live);
    OC.seg('#tt-ln-mode', function (v) { showLnSub(v); live(); });

    LIVE_CB.forEach(function (s) { var n = $(s); if (n) n.addEventListener('change', live); });
    LIVE_IN.forEach(function (s) { var n = $(s); if (n) n.addEventListener('input', live); });

    $('#tt-in').addEventListener('input', live);

    $('#tt-copy').addEventListener('click', function () {
      var msg = cur.kind === 'table' ? '统计结果已复制' : cur.kind === 'list' ? '重复统计已复制' : '结果已复制';
      OC.copy(cur.text || '', msg);
    });
    $('#tt-use').addEventListener('click', function () {
      if (!cur.text) { OC.toast('没有可替换的结果', 'bad'); return; }
      $('#tt-in').value = cur.text;
      live();
      OC.toast('已用结果替换输入');
    });
    $('#tt-out-clear').addEventListener('click', function () {
      renderOutput({ kind: 'text', text: '', note: '', noteKind: '' });
    });
    $('#tt-in-clear').addEventListener('click', function () {
      $('#tt-in').value = '';
      updateStats();
      process();
      $('#tt-in').focus();
    });
    $('#tt-demo').addEventListener('click', fillDemo);
  }

  var DEMO = [
    'item10', 'item2', 'apple', 'Apple', '  banana ', 'banana', 'Banana',
    'cherry', '', '你好世界', 'Hello World', 'the quick brown fox'
  ].join('\n');
  function fillDemo() {
    $('#tt-in').value = DEMO;
    updateStats();
    process();
    OC.toast('示例已填入,可切换上面的功能');
  }

  wire();
  showPanel(fn);
  showLnSub(OC.segVal('#tt-ln-mode') || 'number');
  fillDemo();
})();
TCTT_JS;

return array(
    'id' => 'texttool',
    'cat' => 'text',
    'title' => '文本处理',
    'body' => $body,
    'script' => $script,
);
