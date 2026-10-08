<?php
/**
 * 工具:Base64 编解码。
 *
 * 文本 ↔ Base64 双向实时互转(UTF-8 安全,中文与 emoji 不乱码),外加文件 ↔ Base64/DataURL。
 * 关键实现选择:
 *   - 文本编码优先用 TextEncoder(拿不到时退回手写 UTF-8 编码);解码不走 TextDecoder,
 *     而是自写一个带**字节定位**的 UTF-8 校验器 —— 非 UTF-8 字节要能说清是第几个字节出的问题,
 *     TextDecoder(fatal) 只抛异常不给位置。
 *   - Base64 自己实现(往返、变体、填充与解耦都在一处),按 Uint8Array 分段处理,
 *     几 MB 的文件也不会因为字符串拼接卡住;解码前逐字符校验并把非法字符的原文/有效位次报出来。
 *   - 沙箱没有下载权限,所以“导出文件”统一走 OC.openBlob(blob) 开新标签页,
 *     界面上写明让用户在新标签页里 Ctrl+S / 右键另存为。
 */
$body = <<<'TCB64_BODY'
<style>
.b64-mini{font-size:.786rem;color:var(--t3)}
.b64-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px}
.b64-tags:empty{display:none}
.b64-blk{margin-top:12px}
.b64-blk > .code{max-height:190px}
.b64-out{min-height:132px}
</style>

<div class="hd">
  <div class="grow">
    <h1>Base64 编解码</h1>
    <div class="sub">文本与 Base64 双向实时互转,UTF-8 安全;支持 URL 安全变体、MIME 换行、填充符开关,以及文件与 DataURL 互转。</div>
  </div>
  <div class="acts">
    <span class="tag" id="b64-dir-tag">文本 → Base64</span>
    <button class="btn" id="b64-demo">填入示例</button>
    <button class="btn accent" id="b64-run">转换</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>输入</h2>
      <span class="grow"></span>
      <div class="seg" id="b64-dir">
        <button class="seg-btn on" data-v="enc">文本 → Base64</button>
        <button class="seg-btn" data-v="dec">Base64 → 文本</button>
      </div>
    </div>
    <textarea id="b64-in" class="wrap" spellcheck="false" placeholder="输入要编码的文本,支持中文与 emoji;输入即转换。"></textarea>

    <div class="row mt">
      <span class="lab" style="margin:0">变体</span>
      <div class="seg" id="b64-variant">
        <button class="seg-btn on" data-v="std">标准</button>
        <button class="seg-btn" data-v="url">URL 安全</button>
        <button class="seg-btn" data-v="auto">自动容错</button>
      </div>
    </div>
    <div class="msg" id="b64-var-hint"></div>

    <div class="row" id="b64-enc-opts">
      <label class="row" style="gap:6px"><input type="checkbox" id="b64-pad" checked> 保留 = 填充</label>
      <label class="row" style="gap:6px"><input type="checkbox" id="b64-wrap"> 每 76 字符换行(MIME)</label>
    </div>

    <div class="row">
      <span class="msg">解码时会自动忽略空格、制表与换行。</span>
      <span class="sp"></span>
      <button class="btn sm ghost" id="b64-clear">清空</button>
    </div>
    <div class="stats mt" id="b64-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>结果</h2>
      <span class="grow"></span>
      <span class="msg" id="b64-out-msg"></span>
      <button class="btn sm" id="b64-copy">复制结果</button>
    </div>
    <div class="code brk b64-out" id="b64-out"><div class="empty">输入后这里显示转换结果</div></div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>文件 → Base64</h2>
    <span class="grow"></span>
    <span class="msg" id="b64-f-info"></span>
  </div>
  <div class="drop" id="b64-f-drop">
    <b>拖入或点击选择任意文件</b>
    <span class="hint">纯本地读取,不上传;超过 8 MB 会先确认(DataURL 会很长)</span>
  </div>
  <div class="b64-tags" id="b64-f-tags"></div>

  <div class="f b64-blk">
    <span class="lab">纯 Base64</span>
    <div class="code brk" id="b64-f-b64"><div class="empty">选择文件后显示</div></div>
    <div class="row">
      <span class="sp"></span>
      <span class="b64-mini" id="b64-f-b64n"></span>
      <button class="btn xs" id="b64-f-copy-b64">复制纯 Base64</button>
    </div>
  </div>

  <div class="f b64-blk">
    <span class="lab">DataURL</span>
    <div class="code brk" id="b64-f-url"><div class="empty">选择文件后显示</div></div>
    <div class="row">
      <span class="sp"></span>
      <span class="b64-mini" id="b64-f-urln"></span>
      <button class="btn xs" id="b64-f-copy-url">复制 DataURL</button>
    </div>
    <span class="b64-mini">纯 Base64 按当前「变体 / 填充」设置生成;DataURL 一律用标准 Base64 并带填充,才能被 img / 其它程序直接识别。</span>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>Base64 / DataURL → 文件</h2>
    <span class="grow"></span>
    <span class="tag" id="b64-g-mime" hidden></span>
    <button class="btn sm ghost" id="b64-g-clear">清空</button>
  </div>
  <textarea id="b64-g-in" class="wrap" spellcheck="false" placeholder="粘贴纯 Base64,或 data:image/png;base64,... 形式的 DataURL"></textarea>
  <div class="row mt">
    <div class="f" style="flex:1;min-width:200px">
      <span class="lab">另存时建议的文件名</span>
      <input type="text" id="b64-g-name" value="decoded.bin" spellcheck="false" class="mono">
    </div>
    <button class="btn accent" id="b64-g-open" style="align-self:flex-end">解码并打开</button>
  </div>
  <div class="msg mt" id="b64-g-msg">沙箱不能直接落盘,请在新标签页里 Ctrl+S 或右键另存为。MIME 从 DataURL 前缀识别(纯 Base64 会嗅探文件头),纯文本的 DataURL 也支持。非图片/文本类型浏览器可能直接触发下载而被沙箱拦下,那种情况请改用上面的文本解码。</div>
</div>
TCB64_BODY;
$script = <<<'TCB64_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ================= 常量 =================
  var MAX_TEXT = 1000000;             // 编码输入上限(字符)
  var MAX_B64 = 16000000;             // 解码输入上限(字符)
  var LARGE_FILE = 8 * 1024 * 1024;   // 超过这个大小,读 DataURL 前先确认
  var HARD_FILE = 32 * 1024 * 1024;   // 文件硬上限
  var SHOW_CAP = 200000;              // 单块显示上限:超出只截断显示,复制仍是完整内容
  var DEMO = 'TinyChat 在线工具箱 · Base64 编解码示例 🚀\n中文、English、emoji 😀🎉 混排,往返不乱码。\nOrder 20260101-0001 / 价格 ¥1,299.00';
  var EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf', 'application/zip': 'zip', 'application/json': 'json',
    'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4'
  };
  var G_NOTE = '沙箱不能直接落盘,请在新标签页里 Ctrl+S 或右键另存为。MIME 从 DataURL 前缀识别(纯 Base64 会嗅探文件头),纯文本的 DataURL 也支持。非图片/文本类型浏览器可能直接触发下载而被沙箱拦下,那种情况请改用上面的文本解码。';

  // ================= UTF-8 =================
  function utf8EncodeFallback(s) {
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
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
  function textToBytes(s) {
    if (typeof TextEncoder === 'function') {
      try { return new TextEncoder().encode(s); } catch (e) {}
    }
    return utf8EncodeFallback(s);
  }
  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }

  // 带字节定位的 UTF-8 校验解码:出错时返回第几个字节、值是多少、为什么。
  function utf8DecodeChecked(bytes) {
    var out = '', i = 0, n = bytes.length;
    while (i < n) {
      var b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
      var need, cp;
      if (b >= 0xC2 && b <= 0xDF) { need = 1; cp = b & 0x1F; }
      else if (b >= 0xE0 && b <= 0xEF) { need = 2; cp = b & 0x0F; }
      else if (b >= 0xF0 && b <= 0xF4) { need = 3; cp = b & 0x07; }
      else {
        var why = (b >= 0x80 && b <= 0xBF) ? '这是续字节,不能单独作起始字节' : '不是合法的 UTF-8 起始字节';
        return { error: '解码出的字节第 ' + (i + 1) + ' 个(0x' + hex2(b) + ')不合法:' + why + '(共 ' + n + ' 字节)' };
      }
      for (var k = 1; k <= need; k++) {
        if (i + k >= n) {
          return { error: '解码出的字节第 ' + (i + 1) + ' 个(0x' + hex2(b) + ')起需要 ' + (need + 1) + ' 个字节,但只剩 ' + (n - i) + ' 个,序列被截断' };
        }
        var c = bytes[i + k];
        if ((c & 0xC0) !== 0x80) {
          return { error: '解码出的字节第 ' + (i + k + 1) + ' 个(0x' + hex2(c) + ')不是续字节(应为 10xxxxxx),UTF-8 序列在这里断了' };
        }
        cp = (cp << 6) | (c & 0x3F);
      }
      var bad = (need === 1 && cp < 0x80) || (need === 2 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) || (need === 3 && (cp < 0x10000 || cp > 0x10FFFF));
      if (bad) {
        return { error: '解码出的字节第 ' + (i + 1) + ' 个起是一段非法 UTF-8(过长编码或代理区 U+' + cp.toString(16).toUpperCase() + '),不是可显示的文本' };
      }
      if (cp >= 0x10000) {
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
      } else out += String.fromCharCode(cp);
      i += need + 1;
    }
    return { text: out };
  }

  // ================= Base64 =================
  var STD_T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var URL_T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function encodeBytes(bytes, urlSafe, pad) {
    var T = urlSafe ? URL_T : STD_T;
    var n = bytes.length, i = 0;
    var parts = [], buf = [];
    for (; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      buf.push(T[(v >> 18) & 63], T[(v >> 12) & 63], T[(v >> 6) & 63], T[v & 63]);
      if (buf.length >= 8192) { parts.push(buf.join('')); buf.length = 0; }
    }
    var rem = n - i;
    if (rem === 1) {
      var v1 = bytes[i] << 16;
      buf.push(T[(v1 >> 18) & 63], T[(v1 >> 12) & 63]);
      if (pad) buf.push('==');
    } else if (rem === 2) {
      var v2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      buf.push(T[(v2 >> 18) & 63], T[(v2 >> 12) & 63], T[(v2 >> 6) & 63]);
      if (pad) buf.push('=');
    }
    parts.push(buf.join(''));
    return parts.join('');
  }

  function stdVal(ch) {
    var c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) return c - 65;
    if (c >= 97 && c <= 122) return c - 97 + 26;
    if (c >= 48 && c <= 57) return c - 48 + 52;
    if (ch === '+') return 62;
    if (ch === '/') return 63;
    return -1;
  }
  function valFor(ch, variant) {
    var v = stdVal(ch);
    if (v >= 0) return variant === 'url' ? -1 : v;
    if (ch === '-') return variant === 'std' ? -1 : 62;
    if (ch === '_') return variant === 'std' ? -1 : 63;
    return -1;
  }
  function variantHint(v) {
    if (v === 'url') return 'URL 安全模式只接受 - 与 _;若文本里是 + /,请切到「标准」或「自动容错」';
    if (v === 'std') return '标准模式只接受 + 与 /;若文本里是 - _,请切到「URL 安全」或「自动容错」';
    return '自动容错模式只接受 A-Z a-z 0-9 + / - _';
  }

  // 解码并逐字符校验。成功:{ bytes, cleanLen };失败:{ error }(错误里带位置)。
  function b64Decode(str, variant) {
    var items = [], i;
    for (i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v' || ch === '\u00a0') continue;
      items.push({ ch: ch, pos: i });
    }
    if (!items.length) return { error: '没有可解码的字符(输入里只有空白)' };

    var eqAt = -1, eqCount = 0, j;
    for (j = 0; j < items.length; j++) {
      if (items[j].ch === '=') { if (eqAt < 0) eqAt = j; eqCount++; }
      else if (eqAt >= 0) {
        return { error: '第 ' + (j + 1) + ' 个有效字符「' + items[j].ch + '」出现在填充符「=」之后(原文第 ' + (items[j].pos + 1) + ' 个字符):填充符只能出现在末尾' };
      }
    }
    if (eqCount > 2) return { error: '填充符「=」出现了 ' + eqCount + ' 次,最多只能有 2 个' };

    var payload = eqAt < 0 ? items : items.slice(0, eqAt);
    var vals = [], k;
    for (k = 0; k < payload.length; k++) {
      var it = payload[k];
      var v = valFor(it.ch, variant);
      if (v < 0) {
        return { error: '第 ' + (k + 1) + ' 个有效字符「' + it.ch + '」不是合法的 Base64 字符(原文第 ' + (it.pos + 1) + ' 个字符)。' + variantHint(variant) };
      }
      vals.push(v);
    }

    var L = vals.length;
    if (L % 4 === 1) {
      return { error: '去掉空白与填充后共 ' + L + ' 个字符,长度模 4 余 1,不是合法 Base64 长度(合法长度是 4 的倍数,末组允许少 1~2 个字符)' };
    }
    if (eqCount && (L + eqCount) % 4 !== 0) {
      return { error: '数据 ' + L + ' 个字符配上 ' + eqCount + ' 个填充符,合计 ' + (L + eqCount) + ' 不是 4 的倍数,填充符数量不对' };
    }

    var out = new Uint8Array(Math.floor(L * 3 / 4));
    var oi = 0, acc = 0, bits = 0;
    for (k = 0; k < L; k++) {
      acc = (acc << 6) | vals[k];
      bits += 6;
      if (bits >= 8) { bits -= 8; out[oi++] = (acc >> bits) & 0xFF; }
    }
    if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
      return { error: '最后一个字符「' + payload[L - 1].ch + '」的低 ' + bits + ' 位不是 0,数据像是被截断或损坏了' };
    }
    return { bytes: out, cleanLen: L };
  }

  function wrap76(s) {
    var out = [], i;
    for (i = 0; i < s.length; i += 76) out.push(s.substr(i, 76));
    return out.join('\n');
  }

  // ================= MIME 嗅探 =================
  function sniffMime(b) {
    if (!b || b.length < 4) return '';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
    if (b[0] === 0x50 && b[1] === 0x4B) return 'application/zip';
    if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x7B && b[1] === 0x22) return 'application/json';
    if (b[0] === 0x3C) return 'text/html';
    return '';
  }

  // ================= 渲染 =================
  var lastOut = '';
  function pct(r) { return (Number(r) || 0).toFixed(1) + '%'; }

  function showOut(s) {
    lastOut = s == null ? '' : String(s);
    var el = $('#b64-out');
    if (!lastOut) { el.innerHTML = '<div class="empty">输入后这里显示转换结果</div>'; return; }
    if (lastOut.length > SHOW_CAP) {
      el.textContent = lastOut.slice(0, SHOW_CAP) + '\n…(内容较长,仅显示前 ' + SHOW_CAP + ' 个字符;「复制结果」复制的是完整内容)';
    } else el.textContent = lastOut;
  }
  function fillCode(sel, s, emptyText) {
    var el = $(sel);
    if (!s) { el.innerHTML = '<div class="empty">' + OC.esc(emptyText) + '</div>'; return; }
    if (s.length > SHOW_CAP) el.textContent = s.slice(0, SHOW_CAP) + '\n…(已截断显示,复制按钮复制的是完整内容)';
    else el.textContent = s;
  }
  function renderStats(rows) {
    var h = '', i;
    for (i = 0; i < rows.length; i++) {
      h += '<div class="stat"><div class="k">' + OC.esc(rows[i][0]) + '</div><div class="v">' + OC.esc(rows[i][1]) + '</div></div>';
    }
    $('#b64-stats').innerHTML = h;
  }
  function updateVarHint(v) {
    var hints = {
      std: '输出用 + / 与 = ;解码模式只接受这两个符号',
      url: '输出用 - _ 代替 + / ;解码模式只接受 URL 安全字符',
      auto: '编码按标准输出;解码 + / 与 - _ 都接受,并自动忽略换行与空白'
    };
    $('#b64-var-hint').textContent = hints[v] || '';
  }

  // ================= 主转换 =================
  function run() {
    var dir = OC.segVal('#b64-dir') || 'enc';
    var variant = OC.segVal('#b64-variant') || 'std';
    var raw = $('#b64-in').value;
    $('#b64-dir-tag').textContent = dir === 'enc' ? '文本 → Base64' : 'Base64 → 文本';
    updateVarHint(variant);

    if (dir === 'enc') {
      if (!raw) { showOut(''); OC.say('#b64-out-msg', ''); renderStats([['输入字节', '0'], ['输入字符', '0'], ['输出字符', '0'], ['压缩率', '0.0%']]); return; }
      if (raw.length > MAX_TEXT) {
        showOut(''); OC.say('#b64-out-msg', '输入太长(' + raw.length + ' 字符,上限 ' + MAX_TEXT + '),请分段处理', 'bad');
        renderStats([['输入字符', raw.length.toLocaleString()], ['状态', '已拒绝']]); return;
      }
      var bytes = textToBytes(raw);
      var out = encodeBytes(bytes, variant === 'url', $('#b64-pad').checked);
      var shown = $('#b64-wrap').checked ? wrap76(out) : out;
      showOut(shown);
      var ratio = bytes.length ? out.length / bytes.length * 100 : 0;
      renderStats([['输入字节', String(bytes.length)], ['输入字符', String(raw.length)], ['输出字符', String(out.length)], ['压缩率', pct(ratio)]]);
      OC.say('#b64-out-msg', '已编码 ' + bytes.length + ' 字节 → ' + out.length + ' 字符' + (variant === 'url' ? '(URL 安全)' : ''), 'ok');
      return;
    }

    // 解码
    if (raw.replace(/[\s\u00a0]/g, '') === '') {
      showOut(''); OC.say('#b64-out-msg', ''); renderStats([['输入字符', '0'], ['输出字节', '0'], ['输出字符', '0'], ['压缩率', '0.0%']]); return;
    }
    if (raw.length > MAX_B64) {
      showOut(''); OC.say('#b64-out-msg', '输入太长(' + raw.length + ' 字符,上限 ' + MAX_B64 + '),请改用「Base64 → 文件」或分段处理', 'bad');
      renderStats([['输入字符', raw.length.toLocaleString()], ['状态', '已拒绝']]); return;
    }
    var body = raw.trim(), isData = false;
    var dm = /^data:([^,]*),([\s\S]*)$/i.exec(body);
    if (dm) { isData = true; body = dm[2]; }

    var dec = b64Decode(body, variant);
    if (dec.error) {
      showOut('');
      OC.say('#b64-out-msg', dec.error + (isData ? '(已按 DataURL 去掉前缀后校验正文)' : ''), 'bad');
      renderStats([['输入字符', body.replace(/[\s\u00a0]/g, '').length.toLocaleString()], ['状态', '解码失败']]);
      return;
    }
    var utf = utf8DecodeChecked(dec.bytes);
    if (utf.error) {
      showOut('');
      OC.say('#b64-out-msg', utf.error + ' —— 若这是二进制文件,请用下方「Base64 / DataURL → 文件」。', 'bad');
      renderStats([['输入字符', String(dec.cleanLen)], ['输出字节', String(dec.bytes.length)], ['状态', '不是 UTF-8 文本']]);
      return;
    }
    showOut(utf.text);
    var ratio2 = dec.cleanLen ? dec.bytes.length / dec.cleanLen * 100 : 0;
    renderStats([['输入字符', String(dec.cleanLen)], ['输出字节', String(dec.bytes.length)], ['输出字符', String(utf.text.length)], ['压缩率', pct(ratio2)]]);
    OC.say('#b64-out-msg', '已解码 ' + dec.cleanLen + ' 个 Base64 字符 → ' + utf.text.length + ' 字符 / ' + dec.bytes.length + ' 字节' + (isData ? '(已识别 DataURL 前缀)' : ''), 'ok');
  }

  // ================= 示例 =================
  function demo() {
    var dir = OC.segVal('#b64-dir') || 'enc';
    var ta = $('#b64-in');
    if (dir === 'enc') { ta.value = DEMO; OC.toast('已填入中英混排 + emoji 示例'); }
    else { ta.value = wrap76(encodeBytes(textToBytes(DEMO), false, true)); OC.toast('已填入带换行的 Base64 示例(解码会自动忽略换行)'); }
    ta.focus();
    run();
  }

  // ================= 文件 → Base64 =================
  var fileState = { b64: '', dataUrl: '', name: '', type: '', size: 0 };
  function handleFile(f) {
    if (!f) return;
    if (f.size > HARD_FILE) { OC.say('#b64-f-info', '文件太大(' + OC.fmtBytes(f.size) + '),上限 32 MB', 'bad'); return; }
    if (f.size > LARGE_FILE && !window.confirm('这个文件有 ' + OC.fmtBytes(f.size) + ',DataURL 会长达约 ' + OC.fmtBytes(f.size * 1.4) + ',页面可能变卡。仍然继续吗?')) {
      OC.say('#b64-f-info', '已取消大文件读取', 'warn');
      return;
    }
    OC.say('#b64-f-info', '读取中…');
    OC.readFile(f, 'buffer').then(function (buf) {
      var bytes = new Uint8Array(buf);
      var variant = OC.segVal('#b64-variant');
      var mime = f.type || sniffMime(bytes) || 'application/octet-stream';
      var b64 = encodeBytes(bytes, variant === 'url', $('#b64-pad').checked);
      var dataUrl = 'data:' + mime + ';base64,' + encodeBytes(bytes, false, true);
      fileState = { b64: b64, dataUrl: dataUrl, name: f.name || 'file', type: mime, size: f.size };
      fillCode('#b64-f-b64', b64, '选择文件后显示');
      fillCode('#b64-f-url', dataUrl, '选择文件后显示');
      $('#b64-f-b64n').textContent = b64.length.toLocaleString() + ' 字符';
      $('#b64-f-urln').textContent = dataUrl.length.toLocaleString() + ' 字符';
      $('#b64-f-tags').innerHTML =
        '<span class="tag">' + OC.esc(f.name || '文件') + '</span>'
        + '<span class="tag brand">' + OC.esc(mime) + '</span>'
        + '<span class="tag">' + OC.fmtBytes(f.size) + '</span>'
        + (f.size > LARGE_FILE ? '<span class="tag bad">大文件</span>' : '');
      OC.say('#b64-f-info', '已读取 ' + (f.name || '文件') + '(' + OC.fmtBytes(f.size) + ')', 'ok');
      if (dataUrl.length > 500000) OC.toast('DataURL 很长,复制或粘贴可能较慢', 'bad');
    }, function (e) {
      OC.say('#b64-f-info', '读取失败:' + ((e && e.message) || '未知错误'), 'bad');
    });
  }

  // ================= Base64 / DataURL → 文件 =================
  var lastAutoName = 'decoded.bin';
  function parsePasted(str) {
    str = (str || '').trim();
    if (!str) return { error: '请先粘贴 Base64 或 DataURL' };
    var isData = false, mime = '', payload = str;
    var m = /^data:([^,]*),([\s\S]*)$/i.exec(str);
    if (m) {
      isData = true;
      var meta = m[1] || '';
      payload = m[2];
      var semi = meta.indexOf(';');
      mime = (semi >= 0 ? meta.slice(0, semi) : meta).trim();
      if (!/;\s*base64/i.test(meta)) {
        // 百分号编码的文本 DataURL
        var txt;
        try { txt = decodeURIComponent(payload); } catch (e) { return { error: 'DataURL 既不是 base64,正文也不是合法的百分号编码' }; }
        return { bytes: textToBytes(txt), mime: mime || 'text/plain' };
      }
    }
    var dec = b64Decode(payload, 'auto');
    if (dec.error) return { error: (isData ? 'DataURL 正文无效:' : '') + dec.error };
    var sniffed = sniffMime(dec.bytes);
    return { bytes: dec.bytes, mime: mime || sniffed || 'application/octet-stream', isData: isData };
  }
  function openFile() {
    var r = parsePasted($('#b64-g-in').value);
    var mimeEl = $('#b64-g-mime');
    if (r.error) { mimeEl.hidden = true; OC.say('#b64-g-msg', r.error, 'bad'); return; }
    mimeEl.hidden = false;
    mimeEl.textContent = r.mime;
    var bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
    var ext = EXT[r.mime] || String(r.mime.split('/')[1] || '').replace(/[^a-z0-9]+/gi, '').slice(0, 8) || 'bin';
    var nameEl = $('#b64-g-name');
    if (!nameEl.value || nameEl.value === lastAutoName || /^decoded\./.test(nameEl.value)) nameEl.value = 'decoded.' + ext;
    lastAutoName = nameEl.value;
    OC.openBlob(new Blob([bytes], { type: r.mime }));
    OC.say('#b64-g-msg', '已在新标签页打开 ' + OC.fmtBytes(bytes.length) + ' 的 ' + r.mime + ' 文件;建议另存为 ' + nameEl.value + '。沙箱不能直接落盘,请在新标签页里按 Ctrl+S 或右键另存为。', 'ok');
  }

  // ================= 接线 =================
  function syncDir() {
    var dir = OC.segVal('#b64-dir') || 'enc';
    $('#b64-enc-opts').hidden = dir !== 'enc';
    $('#b64-in').placeholder = dir === 'enc'
      ? '输入要编码的文本,支持中文与 emoji;输入即转换。'
      : '粘贴 Base64(可带换行与空白,也可直接粘 data:...;base64,...)。';
  }
  function wire() {
    var deb = 0;
    function live() { clearTimeout(deb); deb = setTimeout(run, 120); }

    OC.seg('#b64-dir', function () { syncDir(); run(); });
    OC.seg('#b64-variant', function () { run(); });

    $('#b64-in').addEventListener('input', live);
    $('#b64-pad').addEventListener('change', run);
    $('#b64-wrap').addEventListener('change', run);
    $('#b64-run').addEventListener('click', run);
    $('#b64-demo').addEventListener('click', demo);
    $('#b64-clear').addEventListener('click', function () { $('#b64-in').value = ''; run(); $('#b64-in').focus(); });
    $('#b64-copy').addEventListener('click', function () { OC.copy(lastOut, '结果已复制'); });

    // 文件 → Base64
    OC.drop('#b64-f-drop', function (files) { handleFile(files[0]); });
    $('#b64-f-copy-b64').addEventListener('click', function () {
      if (!fileState.b64) { OC.toast('还没有文件内容', 'bad'); return; }
      OC.copy(fileState.b64, '纯 Base64 已复制');
    });
    $('#b64-f-copy-url').addEventListener('click', function () {
      if (!fileState.dataUrl) { OC.toast('还没有文件内容', 'bad'); return; }
      OC.copy(fileState.dataUrl, 'DataURL 已复制');
    });

    // Base64 / DataURL → 文件
    $('#b64-g-open').addEventListener('click', openFile);
    $('#b64-g-clear').addEventListener('click', function () {
      $('#b64-g-in').value = '';
      $('#b64-g-mime').hidden = true;
      $('#b64-g-name').value = 'decoded.bin';
      lastAutoName = 'decoded.bin';
      OC.say('#b64-g-msg', G_NOTE);
    });
  }

  wire();
  syncDir();
  OC.say('#b64-g-msg', G_NOTE);
  run();
})();
TCB64_JS;

return array(
    'id' => 'base64',
    'cat' => 'enc',
    'title' => 'Base64 编解码',
    'body' => $body,
    'script' => $script,
);
