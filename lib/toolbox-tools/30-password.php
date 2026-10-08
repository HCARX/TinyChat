<?php
/**
 * 工具:随机密码生成。
 *
 * 三种能力:字符密码、口令短语、以及已有密码的强度检查。
 * 关键实现选择:
 *   - 随机数只用 crypto.getRandomValues(不使用非密码学的普通伪随机);取整数用**拒绝采样**,
 *     把 2^32 里不能被字符集大小整除的尾部区间整个丢掉,避免 `% n` 带来的取模偏差。
 *   - 「每类至少一个」不是生成完再替换(那样会改变长度),而是先为每个开启的字符集
 *     各抽一个字符占据位置,再用合并字符集补满剩余长度,最后整体 Fisher-Yates 洗牌。
 *     因此长度严格等于设定值,约束也一定满足。
 *   - 强度用「长度 × log2(字符集大小)」估算熵,估算时间按离线攻击 1e10 次/秒、
 *     平均尝试一半密钥空间计算;界面上把假设写清楚。
 * 全部在本地完成,不落任何存储(沙箱里也没有 localStorage)。
 */
$body = <<<'TCPW_BODY'
<style>
.pw-val{flex:1;min-width:0;font-family:var(--mono);font-size:.893rem;white-space:normal;word-break:break-all;overflow-wrap:anywhere}
.pw-bar{height:8px;border-radius:var(--r-pill);background:var(--bg-code);overflow:hidden}
.pw-bar>i{display:block;height:100%;width:0;border-radius:var(--r-pill);background:var(--danger);transition:width .28s ease,background .28s ease}
.pw-sub{font-size:.786rem;color:var(--t3)}
.pw-set-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer}
.pw-set-row .mono{font-size:.786rem;color:var(--t2);word-break:break-all}
.pw-chk-note{font-size:.786rem;color:var(--t3);margin-top:4px}
</style>

<div class="hd">
  <div class="grow">
    <h1>随机密码生成</h1>
    <div class="sub">用浏览器密码学随机数(crypto.getRandomValues)生成字符密码或口令短语,实时给出熵、强度分档与估算破解时间。</div>
  </div>
  <div class="acts">
    <span class="tag" id="pw-count">0 条</span>
    <button class="btn accent" id="pw-gen">生成</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>生成设置</h2>
      <span class="grow"></span>
      <div class="seg" id="pw-mode">
        <button class="seg-btn on" data-v="chars">字符密码</button>
        <button class="seg-btn" data-v="phrase">口令短语</button>
      </div>
    </div>

    <div id="pw-chars-panel">
      <div class="f">
        <span class="lab">长度 <b id="pw-len-v" class="mono">20</b> 位</span>
        <input type="range" id="pw-len" data-out="#pw-len-v" min="4" max="128" step="1" value="20">
      </div>

      <div class="f" style="margin-top:12px">
        <span class="lab">字符集(开启的每一类都会至少出现一次)</span>
        <label class="pw-set-row"><input type="checkbox" id="pw-upper" checked> 大写字母 <span class="mono" id="pw-upper-set"></span></label>
        <label class="pw-set-row"><input type="checkbox" id="pw-lower" checked> 小写字母 <span class="mono" id="pw-lower-set"></span></label>
        <label class="pw-set-row"><input type="checkbox" id="pw-digit" checked> 数字 <span class="mono" id="pw-digit-set"></span></label>
        <label class="pw-set-row"><input type="checkbox" id="pw-symbol" checked> 符号 <span class="mono" id="pw-symbol-set"></span></label>
      </div>

      <div class="f" style="margin-top:12px">
        <label class="pw-set-row"><input type="checkbox" id="pw-noconf"> 排除易混字符 <span class="mono" id="pw-conf-set"></span></label>
        <span class="pw-sub">去掉字形相近的字符,手抄、朗读或人工输入时不容易认错。</span>
      </div>

      <div class="f" style="margin-top:12px">
        <span class="lab">排除指定字符(逐个填写)</span>
        <input type="text" id="pw-exclude" class="mono" spellcheck="false" autocomplete="off" placeholder="例如 abcXYZ012">
        <span class="pw-sub">这些字符会从所有字符集里剔除;区分大小写。</span>
      </div>
    </div>

    <div id="pw-phrase-panel" hidden>
      <div class="f">
        <span class="lab">词数 <b id="pw-words-v" class="mono">4</b> 个</span>
        <input type="range" id="pw-words" data-out="#pw-words-v" min="2" max="12" step="1" value="4">
      </div>
      <div class="f" style="margin-top:12px">
        <span class="lab">分隔符</span>
        <div class="seg" id="pw-sep">
          <button class="seg-btn on" data-v="-">连字符</button>
          <button class="seg-btn" data-v=" ">空格</button>
          <button class="seg-btn" data-v=".">句点</button>
          <button class="seg-btn" data-v="_">下划线</button>
          <button class="seg-btn" data-v="">无</button>
        </div>
      </div>
      <label class="pw-set-row" style="margin-top:12px"><input type="checkbox" id="pw-cap"> 每个词首字母大写</label>
      <div class="msg" id="pw-phrase-hint"></div>
    </div>

    <div class="f" style="margin-top:14px">
      <span class="lab">生成条数 <b id="pw-n-v" class="mono">1</b> 条</span>
      <input type="range" id="pw-n" data-out="#pw-n-v" min="1" max="50" step="1" value="1">
    </div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>生成结果</h2>
      <span class="grow"></span>
      <span class="msg" id="pw-out-msg"></span>
      <button class="btn sm" id="pw-again">再来一批</button>
      <button class="btn sm accent" id="pw-copy-all">全部复制</button>
    </div>
    <div class="stats" id="pw-stats"></div>
    <div class="pw-bar" style="margin-top:12px"><i id="pw-bar-fill"></i></div>
    <div class="row" id="pw-bar-label" style="margin-top:8px"></div>
    <div class="rows tall" id="pw-list" style="margin-top:12px"><div class="empty">点「生成」或改动设置,结果会显示在这里</div></div>
    <div class="msg" style="margin-top:10px"><b>强度假设:</b>按字符集大小与长度估算熵(bit),取 log2;估算破解时间按离线攻击 <b class="mono">1e10 次/秒</b>、平均需要尝试一半密钥空间计算。这只是量级参考 —— 真实攻击还会利用弱口令词典与键盘模式,所以「看起来复杂」的规律密码实际会弱得多。</div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>已有密码强度检查</h2>
    <span class="grow"></span>
    <button class="btn sm ghost" id="pw-chk-weak">填入弱密码示例</button>
    <button class="btn sm ghost" id="pw-chk-strong">填入强密码示例</button>
    <button class="btn sm ghost" id="pw-chk-clear">清空</button>
  </div>
  <input type="text" id="pw-check" class="mono" spellcheck="false" autocomplete="off" placeholder="粘贴一个已有密码,这里显示它的字符集构成、熵、估算时间与弱密码提示">
  <div class="stats" id="pw-chk-stats" style="margin-top:12px"></div>
  <div class="pw-bar" style="margin-top:12px"><i id="pw-chk-fill"></i></div>
  <div class="row" id="pw-chk-label" style="margin-top:8px"></div>
  <div class="row" id="pw-chk-tags" style="margin-top:8px"></div>
  <div class="msg" id="pw-chk-msg" style="margin-top:6px"></div>
  <div class="pw-chk-note">检查全部在本地完成,密码不会离开这个页面。</div>
</div>
TCPW_BODY;
$script = <<<'TCPW_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ================= 字符集与词表 =================
  var UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var LOWER = 'abcdefghijklmnopqrstuvwxyz';
  var DIGIT = '0123456789';
  var SYMBOL = '!@#$%^&*()-_=+[]{}<>?/.,;:~';
  // 字形相近、容易被抄错或听错的字符
  var CONFUSABLE = '0Oo1lI|`';
  var BASE = { upper: UPPER, lower: LOWER, digit: DIGIT, symbol: SYMBOL };
  var KEYS = ['upper', 'lower', 'digit', 'symbol'];
  var NAMES = { upper: '大写字母', lower: '小写字母', digit: '数字', symbol: '符号' };

  // 口令短语用的常用词表(xkcd 风格;词越常见越好记,词表越小越需要加词数)
  var WORDS = ('apple anchor amber breeze bridge blossom beacon candle canyon copper coral cypress dawn dolphin dragon diamond drizzle ember eagle eggplant fiddle falcon forest fossil granite garden glacier guitar harbor hammer honey hollow island ivory igloo jungle journey juniper jasmine kettle kernel koala lagoon lantern lemon lotus lighthouse magnet marble meadow melon monsoon nectar nimbus noodle notebook nutmeg orchid ocean olive oasis octopus pebble pepper pumpkin parrot penguin quartz quiver quilt ribbon rainbow rocket raven saddle summit sapphire seahorse sunflower telescope thunder tulip tundra treasure umbrella unity urban violin velvet volcano voyage walnut willow whisper winter xenon yeast yogurt zephyr zebra zenith acorn basket button comet cotton crystal denim domino eclair fable gossip helmet inkwell jigsaw kiwi lobster muffin necklace overture').split(' ');

  // 常见弱密码清单(命中就标红)
  var WEAK = ['password', '123456', '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123', 'admin', 'administrator', '111111', '000000', '666666', '888888', 'abc123', 'a123456', '123123', '112233', '1q2w3e4r', '1qaz2wsx', 'qazwsx', 'zxcvbnm', 'asdfgh', 'asdfghjkl', 'iloveyou', 'welcome', 'monkey', 'dragon', 'letmein', 'master', 'login', 'passw0rd', 'p@ssw0rd', 'root', 'test', 'guest', 'changeme', 'default', 'secret', 'woaini', '5201314', 'taobao', 'football', 'princess', 'sunshine', 'superman', 'michael', 'shadow', 'trustno1', 'hunter2', 'baseball', 'batman', 'starwars', 'whatever'];

  // ================= 密码学随机 =================
  var cryptoObj = window.crypto || window.msCrypto;

  /**
   * 返回 [0, maxExclusive) 上均匀分布的整数。
   * crypto.getRandomValues 给出的是均匀的 32 位整数;直接 `% maxExclusive` 会让
   * 「靠近 2^32 的一段余数区间」概率偏高(取模偏差)。这里改用拒绝采样:
   * 只接受落在能被 maxExclusive 整除的前缀区间里的取值,落在尾部区间就重抽。
   * maxExclusive 最大只有百来,期望迭代次数不到 2,不会明显变慢。
   */
  function randInt(maxExclusive) {
    if (!cryptoObj || !cryptoObj.getRandomValues) {
      throw new Error('当前环境没有密码学随机数接口(crypto.getRandomValues),无法安全生成');
    }
    var limit = Math.floor(4294967296 / maxExclusive) * maxExclusive;   // 4294967296 = 2^32
    var buf = new Uint32Array(1);
    var guard = 0;
    do {
      cryptoObj.getRandomValues(buf);
      if (++guard > 1000) break;   // 极端情况下的保险丝
    } while (buf[0] >= limit);
    return buf[0] % maxExclusive;
  }
  function pickFrom(s) { return s.charAt(randInt(s.length)); }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ================= 熵与时间 =================
  function entropyBits(len, size) {
    if (!(len > 0) || !(size > 1)) return 0;
    return len * (Math.log(size) / Math.LN2);
  }
  function tierOf(bits) {
    if (bits < 28) return { n: '很弱', cls: 'bad', color: 'var(--danger)', pct: 12 };
    if (bits < 40) return { n: '弱', cls: 'bad', color: 'var(--danger)', pct: 28 };
    if (bits < 60) return { n: '中等', cls: '', color: 'var(--warn)', pct: 52 };
    if (bits < 90) return { n: '强', cls: 'ok', color: 'var(--ok)', pct: 76 };
    return { n: '很强', cls: 'brand', color: 'var(--brand)', pct: 100 };
  }
  function barPct(bits) {
    if (!(bits > 0)) return 0;
    return Math.max(3, Math.min(100, bits / 128 * 100));
  }
  function num(v) {
    if (v >= 1e12) return (v / 1e12).toFixed(1) + ' 万亿';
    if (v >= 1e8) return (v / 1e8).toFixed(1) + ' 亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
    if (v >= 1000) return String(Math.round(v));
    if (v >= 10) return v.toFixed(0);
    return v.toFixed(1);
  }
  /**
   * 估算破解时间:离线攻击 1e10 次/秒,平均需要 2^(bits-1) 次尝试。
   * 用对数空间计算,避免长密码(几千位)时 2^bits 溢出成 Infinity。
   */
  function fmtCrack(bits) {
    if (!(bits > 0)) return '立即';
    var log10sec = (bits - 1) * Math.LN2 / Math.LN10 - 10;
    if (log10sec < 0) return '不到 1 秒';
    if (log10sec > 14) {   // 超过约 300 万年,直接用年表达
      var ly = log10sec - Math.log(31557600) / Math.LN10;
      if (ly > 15) return '约 10^' + Math.floor(ly) + ' 年';
      return '约 ' + num(Math.pow(10, ly)) + ' 年';
    }
    var sec = Math.pow(10, log10sec);
    if (sec < 60) return '约 ' + num(sec) + ' 秒';
    if (sec < 3600) return '约 ' + num(sec / 60) + ' 分钟';
    if (sec < 86400) return '约 ' + num(sec / 3600) + ' 小时';
    if (sec < 31557600) return '约 ' + num(sec / 86400) + ' 天';
    return '约 ' + num(sec / 31557600) + ' 年';
  }

  // ================= 状态与采集 =================
  var st = {
    mode: 'chars', len: 20, count: 1,
    upper: true, lower: true, digit: true, symbol: true,
    noConfuse: false, exclude: '',
    words: 4, sep: '-', cap: false,
  };
  var lastValues = [];
  var genTimer = 0, chkTimer = 0;

  function collect() {
    st.mode = OC.segVal('#pw-mode') || 'chars';
    st.len = Number($('#pw-len').value) || 20;
    st.count = Number($('#pw-n').value) || 1;
    st.upper = $('#pw-upper').checked;
    st.lower = $('#pw-lower').checked;
    st.digit = $('#pw-digit').checked;
    st.symbol = $('#pw-symbol').checked;
    st.noConfuse = $('#pw-noconf').checked;
    st.exclude = $('#pw-exclude').value || '';
    st.words = Number($('#pw-words').value) || 4;
    var sv = OC.segVal('#pw-sep');
    st.sep = sv == null ? '-' : sv;
    st.cap = $('#pw-cap').checked;
  }
  function syncVisibility() {
    var phrase = st.mode === 'phrase';
    $('#pw-chars-panel').hidden = phrase;
    $('#pw-phrase-panel').hidden = !phrase;
  }

  // ================= 生成核心 =================
  /** 按排除规则裁剪一个基础字符集。 */
  function effectivePool(base) {
    var bad = {}, i;
    if (st.noConfuse) for (i = 0; i < CONFUSABLE.length; i++) bad[CONFUSABLE.charAt(i)] = 1;
    for (i = 0; i < st.exclude.length; i++) bad[st.exclude.charAt(i)] = 1;
    var out = '';
    for (i = 0; i < base.length; i++) if (!bad[base.charAt(i)]) out += base.charAt(i);
    return out;
  }
  /**
   * 生成一条字符密码,严格长度 len,且 pools 里每一类至少出现一次。
   * 做法:先每类各放一个字符,再用合并字符集补满到 len,最后整体洗牌 ——
   * 不是「生成完再把某位替换成缺失类别」,所以长度不会错乱。
   */
  function makeCharPassword(pools, len) {
    var chars = [], i;
    for (i = 0; i < pools.length; i++) chars.push(pickFrom(pools[i]));
    var all = pools.join('');
    for (i = chars.length; i < len; i++) chars.push(pickFrom(all));
    return shuffle(chars).join('');
  }
  function makePhrase(n, sep, cap) {
    var parts = [];
    for (var i = 0; i < n; i++) {
      var w = WORDS[randInt(WORDS.length)];
      if (cap) w = w.charAt(0).toUpperCase() + w.slice(1);
      parts.push(w);
    }
    return parts.join(sep);
  }

  function buildCharResult() {
    var pools = [], emptied = [];
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (!st[k]) continue;
      var p = effectivePool(BASE[k]);
      if (!p) { emptied.push(k); continue; }   // 这一类被排除字符清空了
      pools.push(p);
    }
    if (!pools.length) {
      return { ok: false, err: '所有字符集都没开(或被排除字符清空),至少要开启一类才能生成。', emptied: emptied };
    }
    if (st.len < pools.length) {
      return { ok: false, err: '长度 ' + st.len + ' 位放不下 ' + pools.length + ' 类字符,请调大长度或关掉一些字符集。', emptied: emptied };
    }
    var poolSize = pools.join('').length;
    var bits = entropyBits(st.len, poolSize);
    var items = [];
    for (var n = 0; n < st.count; n++) items.push({ value: makeCharPassword(pools, st.len), bits: bits });
    return { ok: true, items: items, poolSize: poolSize, poolLabel: '字符集大小', bits: bits, emptied: emptied };
  }
  function buildPhraseResult() {
    var size = WORDS.length;
    var bits = entropyBits(st.words, size);
    var items = [];
    for (var n = 0; n < st.count; n++) items.push({ value: makePhrase(st.words, st.sep, st.cap), bits: bits });
    return { ok: true, items: items, poolSize: size, poolLabel: '词表大小', bits: bits, emptied: [] };
  }

  // ================= 结果渲染 =================
  function statEl(k, v) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }
  function setBar(fillId, pct, color) {
    var el = document.getElementById(fillId);
    if (!el) return;
    el.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (color) el.style.background = color;
  }
  function tierTag(t) {
    return '<span class="tag ' + t.cls + '"' + (t.cls ? '' : ' style="color:var(--warn)"') + '>' + t.n + '</span>';
  }
  function buildItemEl(it, idx, t) {
    var el = document.createElement('div');
    el.className = 'it';
    var val = document.createElement('span');
    val.className = 'pw-val';
    val.textContent = it.value;
    el.appendChild(val);
    var tag = document.createElement('span');
    tag.className = 'tag ' + t.cls;
    if (!t.cls) tag.style.color = 'var(--warn)';
    tag.textContent = t.n;
    tag.title = it.bits.toFixed(1) + ' bit,估算 ' + fmtCrack(it.bits);
    el.appendChild(tag);
    var cp = document.createElement('button');
    cp.className = 'btn xs';
    cp.textContent = '复制';
    cp.addEventListener('click', function () { OC.copy(it.value, '已复制第 ' + (idx + 1) + ' 条'); });
    el.appendChild(cp);
    return el;
  }

  function render(res) {
    var list = $('#pw-list');
    $('#pw-gen').disabled = !res.ok;
    $('#pw-count').textContent = (res.ok ? res.items.length : 0) + ' 条';

    if (!res.ok) {
      lastValues = [];
      list.innerHTML = '<div class="empty">' + OC.esc(res.err) + '</div>';
      $('#pw-stats').innerHTML = statEl('状态', '无法生成');
      setBar('pw-bar-fill', 0, 'var(--danger)');
      $('#pw-bar-label').innerHTML = '<span class="pw-sub">—</span>';
      OC.say('#pw-out-msg', res.err, 'bad');
      return;
    }

    lastValues = [];
    var t = tierOf(res.bits);
    $('#pw-stats').innerHTML =
      statEl(res.poolLabel, res.poolSize) +
      statEl('熵 (bit)', res.bits.toFixed(1)) +
      statEl('条数', res.items.length);
    setBar('pw-bar-fill', barPct(res.bits), t.color);
    $('#pw-bar-label').innerHTML = tierTag(t)
      + '<span class="pw-sub mono">' + res.bits.toFixed(1) + ' bit · 估算 ' + OC.esc(fmtCrack(res.bits)) + '</span>'
      + '<span class="pw-sub">强度分档为「' + t.n + '」</span>';

    var frag = document.createDocumentFragment();
    for (var i = 0; i < res.items.length; i++) {
      lastValues.push(res.items[i].value);
      frag.appendChild(buildItemEl(res.items[i], i, t));
    }
    list.innerHTML = '';
    list.appendChild(frag);

    if (res.emptied && res.emptied.length) {
      var names = res.emptied.map(function (k) { return NAMES[k]; }).join('、');
      OC.say('#pw-out-msg', '已生成 ' + res.items.length + ' 条;但 ' + names + ' 被排除字符清空,未纳入。', 'warn');
    } else {
      OC.say('#pw-out-msg', '已生成 ' + res.items.length + ' 条', 'ok');
    }
  }

  function doGenerate() {
    collect();
    syncVisibility();
    if (st.mode === 'phrase') {
      $('#pw-phrase-hint').textContent = '内建词表 ' + WORDS.length + ' 个词,每词约 '
        + (Math.log(WORDS.length) / Math.LN2).toFixed(1) + ' bit;词表不大,加词数比加分隔符更有效。';
    }
    var res;
    try {
      res = st.mode === 'phrase' ? buildPhraseResult() : buildCharResult();
    } catch (e) {
      res = { ok: false, err: (e && e.message) || '生成失败' };
    }
    render(res);
  }
  function generate() {
    clearTimeout(genTimer);
    genTimer = setTimeout(doGenerate, 110);
  }

  // ================= 已有密码检查 =================
  function seqRun(s) {
    var best = 1, up = 1, dn = 1;
    for (var i = 1; i < s.length; i++) {
      var d = s.charCodeAt(i) - s.charCodeAt(i - 1);
      up = (d === 1) ? up + 1 : 1;
      dn = (d === -1) ? dn + 1 : 1;
      if (up > best) best = up;
      if (dn > best) best = dn;
    }
    return best;
  }
  function weakHits(pw) {
    var out = [];
    if (!pw) return out;
    var lo = pw.toLowerCase(), i, exact = false;
    for (i = 0; i < WEAK.length; i++) if (lo === WEAK[i]) { exact = true; break; }
    if (exact) out.push('完整命中常见弱密码清单');
    else {
      for (i = 0; i < WEAK.length; i++) {
        if (WEAK[i].length >= 6 && lo.indexOf(WEAK[i]) >= 0) {
          out.push('包含常见弱密码片段「' + WEAK[i] + '」');
          break;
        }
      }
    }
    if (/^\d+$/.test(pw)) out.push('纯数字');
    else if (/^[a-z]+$/.test(pw)) out.push('纯小写字母');
    else if (/^[A-Za-z]+$/.test(pw)) out.push('纯字母');
    if (/^(.)\1*$/.test(pw) && pw.length > 1) out.push('所有字符都相同');
    if (seqRun(pw) >= 4) out.push('含连续递增或递减的序列');
    if (/^(19|20)\d{2}/.test(pw)) out.push('以年份开头');
    if (pw.length < 8) out.push('长度不足 8 位');
    return out;
  }
  function analyze(pw) {
    var n = pw.length, u = 0, l = 0, d = 0, s = 0, o = 0;
    for (var i = 0; i < n; i++) {
      var ch = pw.charAt(i);
      if (UPPER.indexOf(ch) >= 0) u++;
      else if (LOWER.indexOf(ch) >= 0) l++;
      else if (DIGIT.indexOf(ch) >= 0) d++;
      else if (SYMBOL.indexOf(ch) >= 0) s++;
      else o++;
    }
    var size = (u ? 26 : 0) + (l ? 26 : 0) + (d ? 10 : 0) + (s ? SYMBOL.length : 0) + (o ? 100 : 0);
    var bits = entropyBits(n, size);
    return { n: n, u: u, l: l, d: d, s: s, o: o, size: size, bits: bits, hits: weakHits(pw) };
  }
  function renderCheck() {
    var pw = $('#pw-check').value;
    if (!pw) {
      $('#pw-chk-stats').innerHTML = statEl('长度', 0) + statEl('字符集大小', 0) + statEl('熵 (bit)', '0.0') + statEl('估算时间', '—');
      setBar('pw-chk-fill', 0, 'var(--danger)');
      $('#pw-chk-label').innerHTML = '<span class="pw-sub">等待输入</span>';
      $('#pw-chk-tags').innerHTML = '';
      OC.say('#pw-chk-msg', '');
      return;
    }
    var shown = pw.length > 20000 ? pw.slice(0, 20000) : pw;
    var a = analyze(shown);
    var t = tierOf(a.bits);
    $('#pw-chk-stats').innerHTML =
      statEl('长度', a.n + (shown.length < pw.length ? '+' : '')) +
      statEl('字符集大小', a.size) +
      statEl('熵 (bit)', a.bits.toFixed(1)) +
      statEl('估算时间', OC.esc(fmtCrack(a.bits)));
    setBar('pw-chk-fill', barPct(a.bits), t.color);
    $('#pw-chk-label').innerHTML = tierTag(t)
      + '<span class="pw-sub mono">' + a.bits.toFixed(1) + ' bit</span>'
      + '<span class="pw-sub">' + (shown.length < pw.length ? '密码过长,只分析了前 2 万位' : '') + '</span>';
    var tags = [];
    if (a.u) tags.push('大写 ' + a.u);
    if (a.l) tags.push('小写 ' + a.l);
    if (a.d) tags.push('数字 ' + a.d);
    if (a.s) tags.push('符号 ' + a.s);
    if (a.o) tags.push('其他 ' + a.o);
    $('#pw-chk-tags').innerHTML = tags.map(function (x) { return '<span class="tag">' + x + '</span>'; }).join('');
    if (a.hits.length) OC.say('#pw-chk-msg', '风险:' + a.hits.join(';') + '。', 'bad');
    else OC.say('#pw-chk-msg', '未命中内置的常见弱密码特征。', 'ok');
  }

  // ================= 事件接线 =================
  function wire() {
    OC.seg('#pw-mode', function () { syncVisibility(); generate(); });
    OC.seg('#pw-sep', generate);
    OC.range('#pw-len', generate);
    OC.range('#pw-words', generate);
    OC.range('#pw-n', generate);

    ['#pw-upper', '#pw-lower', '#pw-digit', '#pw-symbol', '#pw-noconf'].forEach(function (s) {
      $(s).addEventListener('change', generate);
    });
    $('#pw-exclude').addEventListener('input', generate);
    $('#pw-cap').addEventListener('change', generate);

    $('#pw-gen').addEventListener('click', generate);
    $('#pw-again').addEventListener('click', generate);
    $('#pw-copy-all').addEventListener('click', function () {
      if (!lastValues.length) { OC.toast('还没有可复制的结果', 'bad'); return; }
      OC.copy(lastValues.join('\n'), '已复制 ' + lastValues.length + ' 条(每行一条)');
    });

    $('#pw-check').addEventListener('input', function () {
      clearTimeout(chkTimer);
      chkTimer = setTimeout(renderCheck, 120);
    });
    $('#pw-chk-weak').addEventListener('click', function () { $('#pw-check').value = '123456'; renderCheck(); });
    $('#pw-chk-strong').addEventListener('click', function () {
      $('#pw-check').value = makeCharPassword([UPPER, LOWER, DIGIT, SYMBOL], 16);
      renderCheck();
    });
    $('#pw-chk-clear').addEventListener('click', function () { $('#pw-check').value = ''; renderCheck(); $('#pw-check').focus(); });
  }

  // ================= 初始化 =================
  wire();
  $('#pw-upper-set').textContent = UPPER;
  $('#pw-lower-set').textContent = LOWER;
  $('#pw-digit-set').textContent = DIGIT;
  $('#pw-symbol-set').textContent = SYMBOL;
  $('#pw-conf-set').textContent = CONFUSABLE.split('').join(' ');
  generate();
  renderCheck();
})();
TCPW_JS;

return array(
    'id' => 'password',
    'cat' => 'gen',
    'title' => '随机密码生成',
    'body' => $body,
    'script' => $script,
);
