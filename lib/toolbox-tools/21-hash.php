<?php
/**
 * 工具:哈希与摘要。
 *
 * 一次算出多种摘要:SHA-1/256/384/512 走 crypto.subtle,MD5 与 CRC32 是自写的纯 JS 实现,
 * 所以在没有 WebCrypto 的环境(非 https/localhost)里仍然能用 —— 界面上会明确说明这一点,
 * 并把不可用的项隐藏/禁用,不做静默降级。
 *
 * 关键实现:
 *   - 自写 MD5 是「字节流」实现:先把输入按 UTF-8 编成字节再算(含代理对),保证中文/emoji 正确;
 *     并封装成增量式 update/final,文件可以 file.slice 分块喂进去,不必把大文件一次读进内存。
 *   - 自写 CRC32 用标准 0xEDB88320 反射多项式,同样是增量式,和 MD5 共用一套分块读取循环。
 *   - 文件的 SHA 系列需要整块 ArrayBuffer(crypto.subtle.digest 没有流式接口),因此单独读一次;
 *     MD5/CRC32 则 4MB 一块累积,互不影响。
 *   - 输出统一用 Uint8Array 承载,hex 小写 / hex 大写 / Base64 三种格式从字节重排,所以切换格式
 *     不需要重算。CRC32 的 Base64 采用大端 4 字节(PNG/zlib 的常见写法)。
 */
$body = <<<'TCHASH_BODY'
<style>
.hash-tb th:first-child,.hash-tb td:first-child{white-space:nowrap}
.hash-tb td:nth-child(2){min-width:150px}
.hash-val{font-family:var(--mono);font-size:.857rem;color:var(--text);word-break:break-all;overflow-wrap:anywhere}
.hash-note{font-size:.75rem;color:var(--t3);margin-top:2px}
.hash-cmp textarea{min-height:76px;font-size:.893rem}
.hash-info{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:.893rem;word-break:break-all}
.hash-banner .msg{margin:0}
</style>

<div class="hd">
  <div class="grow">
    <h1>哈希与摘要</h1>
    <div class="sub">一段文本或一个文件,一次算出 MD5 / CRC32 / SHA-1 / SHA-256 / SHA-384 / SHA-512;支持 HMAC 与两值对比校验。</div>
  </div>
  <div class="acts">
    <span class="tag" id="hash-env">检测中…</span>
    <button class="btn" id="hash-demo">填入示例</button>
    <button class="btn accent" id="hash-refresh">重新计算</button>
  </div>
</div>

<div class="card hash-banner" id="hash-banner" hidden>
  <div class="row">
    <span class="dot"></span>
    <span class="msg warn" id="hash-banner-msg"></span>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>消息</h2>
      <span class="grow"></span>
      <span class="hash-note">先按 UTF-8 编码成字节再算</span>
      <button class="btn sm ghost" id="hash-clear">清空</button>
    </div>
    <textarea id="hash-msg" class="wrap" spellcheck="false" placeholder="输入要计算摘要的文本,输入即算"></textarea>
    <div class="row mt">
      <span class="lab" style="margin:0">输出格式</span>
      <div class="seg" id="hash-fmt">
        <button class="seg-btn on" data-v="hex">hex 小写</button>
        <button class="seg-btn" data-v="HEX">HEX 大写</button>
        <button class="seg-btn" data-v="base64">Base64</button>
      </div>
      <span class="sp"></span>
      <button class="btn sm ghost" id="hash-trim" hidden>去掉首尾空白</button>
      <button class="btn sm" id="hash-copy-all">复制全部摘要</button>
    </div>
    <div class="msg mt" id="hash-ws-hint"></div>
    <div class="msg" id="hash-msg-status"></div>
    <div class="stats mt" id="hash-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>摘要结果</h2>
      <span class="grow"></span>
      <span class="msg" id="hash-out-msg"></span>
    </div>
    <table class="hash-tb">
      <thead><tr><th>算法</th><th>摘要值</th><th class="num">耗时(ms)</th><th class="num">长度</th><th></th></tr></thead>
      <tbody id="hash-tbody"></tbody>
    </table>
    <div class="msg mt">MD5 与 SHA-1 已被证明存在碰撞,不适合安全用途;校验下载文件请优先对比 SHA-256。每一行的值都可单独复制。</div>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>HMAC</h2>
      <span class="grow"></span>
      <span class="tag" id="hash-hmac-tag">HMAC-SHA256/384/512</span>
    </div>
    <label class="lab" for="hash-key">密钥(消息取自左侧「消息」输入框)</label>
    <input type="text" id="hash-key" class="mono" spellcheck="false" placeholder="例如 secret-key" autocomplete="off">
    <div class="msg mt" id="hash-key-msg"></div>
    <table class="hash-tb mt">
      <thead><tr><th>算法</th><th>摘要值</th><th class="num">耗时(ms)</th><th class="num">长度</th><th></th></tr></thead>
      <tbody id="hash-hmac-tbody"></tbody>
    </table>
  </div>

  <div class="card hash-cmp">
    <div class="card-h">
      <h2>对比校验</h2>
      <span class="grow"></span>
      <span class="tag" id="hash-cmp-result">待比较</span>
    </div>
    <div class="cols tight">
      <div class="f">
        <span class="lab">A(原文或摘要值)</span>
        <textarea id="hash-cmp-a" class="wrap" spellcheck="false" placeholder="粘贴文本或摘要"></textarea>
      </div>
      <div class="f">
        <span class="lab">B(原文或摘要值)</span>
        <textarea id="hash-cmp-b" class="wrap" spellcheck="false" placeholder="粘贴文本或摘要"></textarea>
      </div>
    </div>
    <div class="row mt">
      <span class="tag" id="hash-cmp-tag-a">A —</span>
      <span class="tag" id="hash-cmp-tag-b">B —</span>
      <span class="sp"></span>
      <button class="btn sm ghost" id="hash-cmp-fill">摘要填入 B</button>
      <button class="btn sm ghost" id="hash-cmp-swap">交换</button>
      <button class="btn sm ghost" id="hash-cmp-clear">清空</button>
    </div>
    <div class="msg mt" id="hash-cmp-msg"></div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>文件摘要</h2>
    <span class="grow"></span>
    <button class="btn sm" id="hash-file-copy">复制文件摘要</button>
  </div>
  <div class="drop" id="hash-drop">
    <b>拖入或点击选择文件</b>
    <span class="hint">文件不会上传,全部在本机计算;MD5 / CRC32 分块读取,适合大文件</span>
  </div>
  <div class="row mt">
    <span class="hash-info" id="hash-file-info"></span>
    <span class="sp"></span>
    <span class="msg" id="hash-file-msg"></span>
  </div>
  <table class="hash-tb mt">
    <thead><tr><th>算法</th><th>摘要值</th><th class="num">耗时(ms)</th><th class="num">长度</th><th></th></tr></thead>
    <tbody id="hash-file-tbody"><tr><td colspan="5"><div class="empty">拖入文件后在这里显示摘要</div></td></tr></tbody>
  </table>
</div>
TCHASH_BODY;
$script = <<<'TCHASH_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ================= 环境 =================
  var subtle = null;
  try { subtle = (window.crypto && window.crypto.subtle) || null; } catch (e) { subtle = null; }
  var HARD = 1000000;            // 文本硬上限:100 万字节
  var FILE_CHUNK = 4 * 1024 * 1024;

  function now() { return (window.performance && window.performance.now) ? window.performance.now() : Date.now(); }

  // ================= UTF-8 =================
  function utf8Bytes(str) {
    str = String(str == null ? '' : str);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xD800 && c <= 0xDBFF) {
        var c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
        } else out.push(0xEF, 0xBF, 0xBD);
      } else if (c >= 0xDC00 && c <= 0xDFFF) out.push(0xEF, 0xBF, 0xBD);
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  // ================= 自写 MD5(字节流,增量式) =================
  var MD5_S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
               5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
               4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
               6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
  var MD5_K = (function () {
    var k = new Uint32Array(64);
    for (var i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    return k;
  })();

  function MD5() {
    this.a = 0x67452301; this.b = 0xefcdab89; this.c = 0x98badcfe; this.d = 0x10325476;
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.total = 0;
    this.M = new Uint32Array(16);
  }
  MD5.prototype._block = function (view, off) {
    var M = this.M, j, q;
    for (j = 0; j < 16; j++) {
      q = off + j * 4;
      M[j] = (view[q] | (view[q + 1] << 8) | (view[q + 2] << 16) | (view[q + 3] << 24)) >>> 0;
    }
    var A = this.a, B = this.b, C = this.c, D = this.d;
    for (var k = 0; k < 64; k++) {
      var F, g;
      if (k < 16) { F = (B & C) | (~B & D); g = k; }
      else if (k < 32) { F = (D & B) | (~D & C); g = (5 * k + 1) % 16; }
      else if (k < 48) { F = B ^ C ^ D; g = (3 * k + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * k) % 16; }
      var tmp = D;
      D = C; C = B;
      var x = (A + F + MD5_K[k] + M[g]) >>> 0;
      var r = MD5_S[k];
      B = (B + (((x << r) | (x >>> (32 - r))) >>> 0)) >>> 0;
      A = tmp;
    }
    this.a = (this.a + A) >>> 0; this.b = (this.b + B) >>> 0;
    this.c = (this.c + C) >>> 0; this.d = (this.d + D) >>> 0;
  };
  MD5.prototype.update = function (bytes) {
    var len = bytes.length, i = 0;
    this.total += len;
    if (this.bufLen > 0) {
      var need = 64 - this.bufLen;
      if (len < need) {
        this.buf.set(bytes, this.bufLen);
        this.bufLen += len;
        return this;
      }
      for (var k = 0; k < need; k++) this.buf[this.bufLen + k] = bytes[k];
      this._block(this.buf, 0);
      this.bufLen = 0;
      i = need;
    }
    while (i + 64 <= len) { this._block(bytes, i); i += 64; }
    var rem = len - i;
    if (rem > 0) {
      for (var j = 0; j < rem; j++) this.buf[j] = bytes[i + j];
      this.bufLen = rem;
    }
    return this;
  };
  MD5.prototype.final = function () {
    var bitLen = this.total * 8;
    var padLen = this.bufLen < 56 ? (56 - this.bufLen) : (120 - this.bufLen);
    var pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    var lo = bitLen >>> 0, hi = Math.floor(bitLen / 4294967296);
    pad[padLen] = lo & 255; pad[padLen + 1] = (lo >>> 8) & 255;
    pad[padLen + 2] = (lo >>> 16) & 255; pad[padLen + 3] = (lo >>> 24) & 255;
    pad[padLen + 4] = hi & 255; pad[padLen + 5] = (hi >>> 8) & 255;
    pad[padLen + 6] = (hi >>> 16) & 255; pad[padLen + 7] = (hi >>> 24) & 255;
    this.update(pad);
    var out = new Uint8Array(16), st = [this.a, this.b, this.c, this.d];
    for (var t = 0; t < 4; t++) {
      out[t * 4] = st[t] & 255;
      out[t * 4 + 1] = (st[t] >>> 8) & 255;
      out[t * 4 + 2] = (st[t] >>> 16) & 255;
      out[t * 4 + 3] = (st[t] >>> 24) & 255;
    }
    return out;
  };
  function md5Bytes(bytes) { return new MD5().update(bytes).final(); }

  // ================= 自写 CRC32(增量式) =================
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32Update(crc, bytes) {
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return crc >>> 0;
  }
  function u32be(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }

  // ================= 格式化 =================
  function bytesToHex(bytes, upper) {
    var h = '';
    for (var i = 0; i < bytes.length; i++) h += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return upper ? h.toUpperCase() : h;
  }
  function bytesToBase64(bytes) {
    var s = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(s);
  }
  function formatBytes(bytes, mode) {
    if (mode === 'base64') return bytesToBase64(bytes);
    return bytesToHex(bytes, mode === 'HEX');
  }

  // ================= 状态 =================
  var fmt = 'hex';
  var textEntries = [], hmacEntries = [], fileEntries = [];
  var lastChars = 0, lastBytes = 0;
  var gen = 0, hgen = 0, fgen = 0;
  var timer = 0;

  function newEntry(algo, bits, memo, pending) {
    return { algo: algo, bits: bits, note: memo || '', bytes: null, ms: null, err: null, pending: pending !== false };
  }

  // ================= 渲染 =================
  function renderTable(sel, entries, emptyText) {
    var tb = $(sel);
    if (!entries.length) {
      tb.innerHTML = '<tr><td colspan="5"><div class="empty">' + OC.esc(emptyText || '没有可显示的摘要') + '</div></td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], cell;
      if (e.err) cell = '<span class="tag bad">失败</span> <span class="msg bad">' + OC.esc(e.err) + '</span>';
      else if (!e.bytes) cell = '<span class="msg">计算中…</span>';
      else cell = '<span class="hash-val">' + OC.esc(formatBytes(e.bytes, fmt)) + '</span>';
      html += '<tr><td>' + OC.esc(e.algo) + (e.note ? '<div class="hash-note">' + OC.esc(e.note) + '</div>' : '') + '</td>'
        + '<td>' + cell + '</td>'
        + '<td class="num">' + (e.ms == null ? '—' : e.ms.toFixed(2)) + '</td>'
        + '<td class="num">' + e.bits + ' 位</td>'
        + '<td>' + (e.bytes ? '<button class="btn xs" data-copy="' + i + '">复制</button>' : '') + '</td></tr>';
    }
    tb.innerHTML = html;
    [].forEach.call(tb.querySelectorAll('[data-copy]'), function (btn) {
      btn.addEventListener('click', function () {
        var e = entries[Number(btn.getAttribute('data-copy'))];
        if (e && e.bytes) OC.copy(formatBytes(e.bytes, fmt), e.algo + ' 已复制');
      });
    });
  }
  function renderAll() {
    renderTable('#hash-tbody', textEntries, '输入消息后显示摘要');
    renderTable('#hash-hmac-tbody', hmacEntries, subtle ? '填入密钥后显示 HMAC 结果' : '当前环境没有 WebCrypto,HMAC 不可用');
    renderTable('#hash-file-tbody', fileEntries, '拖入文件后在这里显示摘要');
  }

  function refreshStats() {
    var all = textEntries.concat(hmacEntries);
    var ms = 0, pending = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].pending) pending = true;
      else if (all[i].ms != null) ms += all[i].ms;
    }
    var html = '<div class="stat"><div class="k">字符</div><div class="v">' + lastChars + '</div></div>'
      + '<div class="stat"><div class="k">字节</div><div class="v">' + lastBytes + '</div></div>'
      + '<div class="stat"><div class="k">摘要</div><div class="v">' + all.length + '</div></div>'
      + '<div class="stat"><div class="k">耗时</div><div class="v">' + (pending ? '…' : ms.toFixed(2) + ' ms') + '</div></div>';
    $('#hash-stats').innerHTML = html;
    OC.say('#hash-out-msg', all.length ? (pending ? '正在计算…' : '已计算 ' + all.length + ' 种摘要') : '');
  }

  // ================= 文本摘要 =================
  function updateWsHint(msg) {
    var el = $('#hash-ws-hint'), trim = $('#hash-trim');
    if (!msg) { OC.say(el, ''); trim.hidden = true; return; }
    var lead = /^\s*/.exec(msg)[0].length;
    var trail = (lead === msg.length) ? 0 : /\s*$/.exec(msg)[0].length;
    if (lead || trail) {
      trim.hidden = false;
      OC.say(el, '输入含首尾空白:开头 ' + lead + ' 个、结尾 ' + trail + ' 个 —— 这是哈希对不上最常见的原因。', 'warn');
    } else {
      trim.hidden = true;
      OC.say(el, '输入不含首尾空白。', 'ok');
    }
  }

  function recomputeText() {
    var my = ++gen;
    var msg = $('#hash-msg').value;
    var bytes = utf8Bytes(msg);
    lastChars = msg.length; lastBytes = bytes.length;
    updateWsHint(msg);
    OC.say('#hash-msg-status', '');

    textEntries = [];
    if (bytes.length > HARD) {
      OC.say('#hash-msg-status', '文本已超过 100 万字节,为避免页面卡死暂停计算 —— 请把内容存成 .txt 后用下方「文件摘要」计算。', 'bad');
      renderTable('#hash-tbody', textEntries, '输入消息后显示摘要');
      recomputeHmac();
      refreshStats();
      return;
    }

    // 自写算法:同步、不需要安全上下文
    var eMd5 = newEntry('MD5', 128, '自写实现');
    var eCrc = newEntry('CRC32', 32, '自写实现');
    var t0 = now(); eMd5.bytes = md5Bytes(bytes); eMd5.ms = now() - t0; eMd5.pending = false;
    t0 = now(); eCrc.bytes = u32be(crc32Update(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF); eCrc.ms = now() - t0; eCrc.pending = false;
    textEntries.push(eMd5, eCrc);

    if (subtle) {
      var defs = [['SHA-1', 'SHA-1', 160], ['SHA-256', 'SHA-256', 256], ['SHA-384', 'SHA-384', 384], ['SHA-512', 'SHA-512', 512]];
      for (var i = 0; i < defs.length; i++) {
        (function (name, bits) {
          var e = newEntry(name, bits, 'WebCrypto');
          textEntries.push(e);
          var t = now();
          subtle.digest(name, bytes).then(function (buf) {
            e.bytes = new Uint8Array(buf); e.ms = now() - t; e.pending = false;
            if (my === gen) { renderTable('#hash-tbody', textEntries, '输入消息后显示摘要'); refreshStats(); }
          }, function (err) {
            e.err = (err && err.message) || '计算失败'; e.pending = false;
            if (my === gen) { renderTable('#hash-tbody', textEntries, '输入消息后显示摘要'); refreshStats(); }
          });
        })(defs[i][1], defs[i][2]);
      }
    }
    renderTable('#hash-tbody', textEntries, '输入消息后显示摘要');
    recomputeHmac();
    refreshStats();
  }

  // ================= HMAC =================
  function recomputeHmac() {
    var my = ++hgen;
    hmacEntries = [];
    if (!subtle) {
      renderTable('#hash-hmac-tbody', hmacEntries, '当前环境没有 WebCrypto,HMAC 不可用');
      refreshStats();
      return;
    }
    var key = $('#hash-key').value;
    var keyBytes = utf8Bytes(key);
    var msgBytes = utf8Bytes($('#hash-msg').value);
    if (msgBytes.length > HARD) {
      OC.say('#hash-key-msg', '消息过长,HMAC 已跳过。', 'bad');
      renderTable('#hash-hmac-tbody', hmacEntries, '消息过长');
      refreshStats();
      return;
    }
    if (!key) OC.say('#hash-key-msg', '密钥为空 —— 这是未加盐的 HMAC,仅作演示。', 'warn');
    else OC.say('#hash-key-msg', '密钥 ' + keyBytes.length + ' 字节,消息取自左侧「消息」输入框。');

    var defs = [['HMAC-SHA256', 'SHA-256', 256], ['HMAC-SHA384', 'SHA-384', 384], ['HMAC-SHA512', 'SHA-512', 512]];
    for (var i = 0; i < defs.length; i++) {
      (function (name, hashName, bits) {
        var e = newEntry(name, bits, 'WebCrypto');
        hmacEntries.push(e);
        var t = now();
        var fin = function () {
          if (my === hgen) { renderTable('#hash-hmac-tbody', hmacEntries, '填入密钥后显示 HMAC 结果'); refreshStats(); }
        };
        subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: { name: hashName } }, false, ['sign'])
          .then(function (k) { return subtle.sign('HMAC', k, msgBytes); })
          .then(function (buf) { e.bytes = new Uint8Array(buf); e.ms = now() - t; e.pending = false; fin(); },
                function (err) { e.err = (err && err.message) || '计算失败'; e.pending = false; fin(); });
      })(defs[i][0], defs[i][1], defs[i][2]);
    }
    renderTable('#hash-hmac-tbody', hmacEntries, '填入密钥后显示 HMAC 结果');
    refreshStats();
  }

  // ================= 文件摘要 =================
  function resetFileTable() {
    fileEntries = [];
    renderTable('#hash-file-tbody', fileEntries, '拖入文件后在这里显示摘要');
    $('#hash-file-info').textContent = '';
    OC.say('#hash-file-msg', '');
  }

  function fileDone() {
    var pending = 0, ms = 0;
    for (var i = 0; i < fileEntries.length; i++) {
      if (fileEntries[i].pending) pending++;
      else if (fileEntries[i].ms != null) ms += fileEntries[i].ms;
    }
    if (pending) return;
    OC.say('#hash-file-msg', '完成:共 ' + fileEntries.length + ' 个摘要,合计 ' + ms.toFixed(1) + ' ms。', 'ok');
  }

  function hashFile(file) {
    var my = ++fgen;
    resetFileTable();
    if (!file) return;
    $('#hash-file-info').textContent = (file.name || '未命名文件') + ' · ' + OC.fmtBytes(file.size) + (file.type ? ' · ' + file.type : '');
    OC.say('#hash-file-msg', '计算中…');

    // 展示顺序:先 WebCrypto 的 SHA 系列,再自写的 MD5 / CRC32
    var eSha256 = newEntry('SHA-256', 256, subtle ? 'WebCrypto' : '不可用');
    var eSha1 = newEntry('SHA-1', 160, 'WebCrypto');
    var eSha384 = newEntry('SHA-384', 384, 'WebCrypto');
    var eSha512 = newEntry('SHA-512', 512, 'WebCrypto');
    var eMd5 = newEntry('MD5', 128, '自写实现 · 分块读取');
    var eCrc = newEntry('CRC32', 32, '自写实现 · 分块读取');
    if (subtle) fileEntries.push(eSha256, eSha1, eSha384, eSha512);
    fileEntries.push(eMd5, eCrc);
    renderTable('#hash-file-tbody', fileEntries, '');

    // 1) 自写 MD5 + CRC32:file.slice 分块,增量喂入,避免整文件驻留内存
    var md5 = new MD5(), crc = 0xFFFFFFFF, off = 0, chunkT0 = now();
    var chunkStep = function () {
      if (my !== fgen) return;
      if (off >= file.size) {
        var dt = now() - chunkT0;
        eMd5.bytes = md5.final(); eMd5.ms = dt; eMd5.pending = false;
        eCrc.bytes = u32be(crc ^ 0xFFFFFFFF); eCrc.ms = dt; eCrc.pending = false;
        renderTable('#hash-file-tbody', fileEntries, '');
        fileDone();
        return;
      }
      var end = Math.min(file.size, off + FILE_CHUNK);
      OC.readFile(file.slice(off, end), 'buffer').then(function (buf) {
        if (my !== fgen) return;
        var b = new Uint8Array(buf);
        md5.update(b);
        crc = crc32Update(crc, b);
        off = end;
        if (file.size > 0) OC.say('#hash-file-msg', '分块读取中… ' + Math.round(off / file.size * 100) + '%');
        chunkStep();
      }, function (err) {
        if (my !== fgen) return;
        eMd5.err = eCrc.err = (err && err.message) || '读取失败';
        eMd5.pending = eCrc.pending = false;
        renderTable('#hash-file-tbody', fileEntries, '');
        fileDone();
      });
    };
    chunkStep();

    // 2) SHA 系列:subtle.digest 没有流式接口,整块读入一次
    if (subtle) {
      var jobs = [[eSha256, 'SHA-256'], [eSha1, 'SHA-1'], [eSha384, 'SHA-384'], [eSha512, 'SHA-512']];
      OC.readFile(file, 'buffer').then(function (ab) {
        if (my !== fgen) return;
        var tasks = jobs.map(function (j) {
          var t = now();
          return subtle.digest(j[1], ab).then(function (out) {
            j[0].bytes = new Uint8Array(out); j[0].ms = now() - t; j[0].pending = false;
          }, function (err) {
            j[0].err = (err && err.message) || '计算失败'; j[0].pending = false;
          });
        });
        return Promise.all(tasks);
      }, function (err) {
        if (my !== fgen) return;
        for (var i = 0; i < jobs.length; i++) { jobs[i][0].err = (err && err.message) || '读取失败'; jobs[i][0].pending = false; }
      }).then(function () {
        if (my !== fgen) return;
        renderTable('#hash-file-tbody', fileEntries, '');
        fileDone();
      });
    }
  }

  // ================= 对比校验 =================
  function setTag(el, cls, text) { var n = $(el); n.className = 'tag' + (cls ? ' ' + cls : ''); n.textContent = text; }
  function compareNow() {
    var a = $('#hash-cmp-a').value, b = $('#hash-cmp-b').value;
    var la = utf8Bytes(a).length, lb = utf8Bytes(b).length;
    setTag('#hash-cmp-tag-a', '', 'A ' + a.length + ' 字 / ' + la + ' B');
    setTag('#hash-cmp-tag-b', '', 'B ' + b.length + ' 字 / ' + lb + ' B');
    if (!a && !b) { setTag('#hash-cmp-result', '', '待比较'); OC.say('#hash-cmp-msg', '两边填入内容后开始实时比较。'); return; }
    if (!a || !b) { setTag('#hash-cmp-result', '', '等待另一边'); OC.say('#hash-cmp-msg', '另一边还空着,补齐后再比较。', 'warn'); return; }
    if (a === b) { setTag('#hash-cmp-result', 'ok', '完全相同'); OC.say('#hash-cmp-msg', '两边逐字节一致(' + la + ' 字节)。', 'ok'); return; }
    if (a.trim() === b.trim()) { setTag('#hash-cmp-result', 'ok', '相同(仅首尾空白不同)'); OC.say('#hash-cmp-msg', '去掉首尾空白后一致;直接逐字节比较会因空白而不同。', 'ok'); return; }
    if (a.trim().toLowerCase() === b.trim().toLowerCase()) { setTag('#hash-cmp-result', 'ok', '相同(忽略大小写)'); OC.say('#hash-cmp-msg', '忽略大小写与首尾空白后一致 —— 校验摘要值时通常可以接受。', 'ok'); return; }
    var n = Math.min(a.length, b.length), pos = -1;
    for (var i = 0; i < n; i++) if (a.charAt(i) !== b.charAt(i)) { pos = i; break; }
    setTag('#hash-cmp-result', 'bad', '不同');
    var detail = '长度 ' + a.length + ' 与 ' + b.length + ' 字符(字节 ' + la + ' / ' + lb + ')';
    if (pos >= 0) detail += ',第 ' + (pos + 1) + ' 个字符起不同';
    else if (a.length !== b.length) detail += ',前 ' + n + ' 个字符相同';
    OC.say('#hash-cmp-msg', '两边不一致(' + detail + ')。', 'bad');
  }

  // ================= 复制 =================
  function copyEntries(entries, emptyMsg) {
    var lines = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.err) { lines.push(e.algo + ': (失败) ' + e.err); continue; }
      if (!e.bytes) continue;
      lines.push(e.algo + ': ' + formatBytes(e.bytes, fmt));
    }
    if (!lines.length) { OC.toast(emptyMsg || '还没有可复制的结果', 'bad'); return; }
    OC.copy(lines.join('\n'), '已复制 ' + lines.length + ' 条摘要');
  }

  // ================= 环境 =================
  function detectEnv() {
    var tag = $('#hash-env');
    if (subtle) {
      tag.className = 'tag ok'; tag.textContent = 'WebCrypto 可用';
      return;
    }
    tag.className = 'tag bad'; tag.textContent = '无 WebCrypto';
    $('#hash-banner').hidden = false;
    OC.say('#hash-banner-msg', '当前环境没有 WebCrypto(需要 https 或 localhost),只提供自写的 MD5 与 CRC32;SHA-1/256/384/512 与 HMAC 已停用。', 'warn');
    var htag = $('#hash-hmac-tag');
    htag.className = 'tag bad'; htag.textContent = '不可用';
    $('#hash-key').disabled = true;
  }

  // ================= 接线 =================
  function recompute() { recomputeText(); compareNow(); }
  var live = function () { clearTimeout(timer); timer = setTimeout(recompute, 130); };
  var liveHmac = function () { clearTimeout(timer); timer = setTimeout(function () { recomputeHmac(); refreshStats(); }, 130); };

  OC.seg('#hash-fmt', function (v) { fmt = v; renderAll(); });
  $('#hash-msg').addEventListener('input', live);
  $('#hash-key').addEventListener('input', liveHmac);
  $('#hash-refresh').addEventListener('click', recompute);
  $('#hash-clear').addEventListener('click', function () { $('#hash-msg').value = ''; recompute(); $('#hash-msg').focus(); });
  $('#hash-trim').addEventListener('click', function () { var ta = $('#hash-msg'); ta.value = ta.value.trim(); recompute(); OC.toast('已去掉首尾空白'); });
  $('#hash-demo').addEventListener('click', function () {
    $('#hash-msg').value = '你好，哈希\nThe quick brown fox jumps over the lazy dog';
    $('#hash-key').value = 'secret-key';
    recompute();
    OC.toast('已填入示例');
  });
  $('#hash-copy-all').addEventListener('click', function () { copyEntries(textEntries, '还没有可复制的摘要'); });
  $('#hash-file-copy').addEventListener('click', function () { copyEntries(fileEntries, '还没有文件摘要'); });

  $('#hash-cmp-a').addEventListener('input', compareNow);
  $('#hash-cmp-b').addEventListener('input', compareNow);
  $('#hash-cmp-swap').addEventListener('click', function () {
    var a = $('#hash-cmp-a'); var b = $('#hash-cmp-b');
    var t = a.value; a.value = b.value; b.value = t; compareNow();
  });
  $('#hash-cmp-clear').addEventListener('click', function () { $('#hash-cmp-a').value = ''; $('#hash-cmp-b').value = ''; compareNow(); });
  $('#hash-cmp-fill').addEventListener('click', function () {
    var pick = null, i;
    var order = ['SHA-256', 'SHA-1', 'MD5', 'CRC32'];
    for (var k = 0; k < order.length && !pick; k++) {
      for (i = 0; i < textEntries.length; i++) if (textEntries[i].algo === order[k] && textEntries[i].bytes) { pick = textEntries[i]; break; }
    }
    if (!pick) { OC.toast('还没有算好的摘要', 'bad'); return; }
    $('#hash-cmp-b').value = formatBytes(pick.bytes, fmt);
    compareNow();
    OC.toast('已把 ' + pick.algo + ' 结果填入 B');
  });

  OC.drop('#hash-drop', function (files) { hashFile(files && files[0]); });

  // ================= 初始化 =================
  detectEnv();
  $('#hash-msg').value = '你好，哈希\nThe quick brown fox jumps over the lazy dog';
  $('#hash-key').value = 'secret-key';
  renderAll();
  recompute();
})();
TCHASH_JS;

return array(
    'id' => 'hash',
    'cat' => 'dev',
    'title' => '哈希与摘要',
    'body' => $body,
    'script' => $script,
);
