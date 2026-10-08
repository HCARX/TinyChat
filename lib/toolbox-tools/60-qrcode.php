<?php
/**
 * 工具:批量二维码生成与识别。
 *
 * 二维码编解码是自写的(不依赖任何外部库,沙箱里也拉不到 CDN):
 *   编码:字节/数字/字母数字三种模式,版本 1-40,纠错 L/M/Q/H,自动选版本与掩码(4 条罚分规则)。
 *   解码:Otsu 二值化 → 扫 1:1:3:1:1 找三个定位符(不依赖图像摆正)→ 仿射采样 →
 *        读格式信息 → 反掩码 → 分块去交织 → Reed-Solomon 纠错(BM + Chien + 高斯消元求幅值)。
 * 正确性不靠「自己编自己解」:编码结果与 segno 逐模块一致,并被 ZXing(524/524,版本 1-40 ×
 * 四个等级)与 OpenCV 独立识别;RS 纠错边界实测正好是 ecLen/2。详见 tests/toolbox-tools-gui.mjs
 * 与本轮提交说明。
 */
$body = <<<'TCQR_BODY'
<style>
.qr-it{display:grid;grid-template-columns:96px 1fr;gap:12px;padding:10px;border-radius:var(--r);background:var(--bg-soft)}
.qr-it + .qr-it{margin-top:6px}
.qr-thumb{display:flex;align-items:center;justify-content:center;border-radius:var(--r-sm);background:
  repeating-conic-gradient(rgba(128,128,128,.14) 0 25%,transparent 0 50%) 0 0/12px 12px;overflow:hidden}
.qr-thumb canvas{display:block;width:88px;height:88px;object-fit:contain}
.qr-body{min-width:0}
.qr-txt{font-family:var(--mono);font-size:.857rem;word-break:break-all;overflow-wrap:anywhere;margin:0 0 6px;
  max-height:44px;overflow:hidden;color:var(--text)}
.qr-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.qr-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.qr-sub{font-size:.786rem;color:var(--t3)}
.qr-dec{display:grid;grid-template-columns:1fr;gap:6px;padding:10px;border-radius:var(--r);background:var(--bg-soft)}
.qr-dec + .qr-dec{margin-top:6px}
.qr-dec .out{font-family:var(--mono);font-size:.857rem;word-break:break-all;overflow-wrap:anywhere;white-space:pre-wrap;margin:0}
.qr-dec.bad{background:var(--danger-bg)}
.qr-center{border-radius:var(--r);background:var(--bg-soft);padding:10px}
.qr-center[hidden]{display:none}
.qr-serif{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
</style>

<div class="hd">
  <div class="grow">
    <h1>批量二维码生成与识别</h1>
    <div class="sub">每行一条内容,一次生成一批;纠错等级 / 尺寸 / 描边 / 渐变 / 模块形状 / 定位点 / 中心填充全可调;还能把已有二维码图片识别回文本。</div>
  </div>
  <div class="acts">
    <span class="tag" id="qr-count">0 条</span>
    <button class="btn" id="qr-demo">填入示例</button>
    <button class="btn accent" id="qr-gen">生成</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>内容</h2>
      <span class="grow"></span>
      <select id="qr-tpl" aria-label="快捷模板">
        <option value="">快捷模板…</option>
        <option value="url">网址</option>
        <option value="text">纯文本</option>
        <option value="wifi">WiFi 网络</option>
        <option value="vcard">联系人名片</option>
        <option value="tel">电话</option>
        <option value="sms">短信</option>
        <option value="mail">邮件</option>
        <option value="geo">地理位置</option>
        <option value="event">日历事件</option>
      </select>
    </div>
    <textarea id="qr-text" class="wrap" spellcheck="false" placeholder="每行一条内容,例如:&#10;https://example.com&#10;https://example.com/2&#10;订单编号 20260101-0001"></textarea>
    <div class="row mt">
      <label class="row" style="gap:6px"><input type="checkbox" id="qr-dedupe" checked> 去重</label>
      <label class="row" style="gap:6px"><input type="checkbox" id="qr-trim" checked> 去掉首尾空格</label>
      <span class="sp"></span>
      <button class="btn sm ghost" id="qr-clear">清空</button>
    </div>
    <div class="stats mt" id="qr-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>外观设置</h2>
      <span class="grow"></span>
      <select id="qr-preset" aria-label="配色预设">
        <option value="ink">经典黑白</option>
        <option value="brand">品牌蓝</option>
        <option value="night">暗夜</option>
        <option value="forest">松林绿</option>
        <option value="berry">莓果紫</option>
        <option value="sunset">落日渐变</option>
        <option value="ocean">海洋渐变</option>
        <option value="cocoa">暖棕</option>
      </select>
    </div>

    <div class="cols tight">
      <div class="f">
        <span class="lab">纠错等级</span>
        <div class="seg" id="qr-ec">
          <button class="seg-btn on" data-v="L">L 7%</button>
          <button class="seg-btn" data-v="M">M 15%</button>
          <button class="seg-btn" data-v="Q">Q 25%</button>
          <button class="seg-btn" data-v="H">H 30%</button>
        </div>
        <span class="qr-sub" id="qr-ec-hint">等级越高越耐污损,容量越小</span>
      </div>

      <div class="f">
        <span class="lab">模块尺寸 <b id="qr-ms-v" class="mono">8</b> px</span>
        <input type="range" id="qr-ms" data-out="#qr-ms-v" min="2" max="24" step="1" value="8">
      </div>

      <div class="f">
        <span class="lab">描边(静默区) <b id="qr-qz-v" class="mono">4</b> 模块</span>
        <input type="range" id="qr-qz" data-out="#qr-qz-v" min="0" max="12" step="1" value="4">
      </div>

      <div class="f">
        <span class="lab">模块形状</span>
        <div class="seg" id="qr-shape">
          <button class="seg-btn on" data-v="square">方形</button>
          <button class="seg-btn" data-v="round">圆角</button>
          <button class="seg-btn" data-v="dot">圆点</button>
          <button class="seg-btn" data-v="diamond">菱形</button>
        </div>
      </div>

      <div class="f" id="qr-shape-r-f">
        <span class="lab">圆角比例 <b id="qr-sr-v" class="mono">40</b>%</span>
        <input type="range" id="qr-shape-r" data-out="#qr-sr-v" min="10" max="50" step="5" value="40">
      </div>

      <div class="f">
        <span class="lab">定位点样式</span>
        <div class="seg" id="qr-finder">
          <button class="seg-btn on" data-v="auto">随模块</button>
          <button class="seg-btn" data-v="round">圆角</button>
          <button class="seg-btn" data-v="dot">圆点</button>
        </div>
      </div>

      <div class="f">
        <span class="lab">前景色</span>
        <div class="cf">
          <input type="color" id="qr-fg-c" value="#111111">
          <input type="text" id="qr-fg" value="#111111" spellcheck="false" class="mono">
        </div>
      </div>

      <div class="f">
        <span class="lab">背景色</span>
        <div class="cf">
          <input type="color" id="qr-bg-c" value="#ffffff">
          <input type="text" id="qr-bg" value="#ffffff" spellcheck="false" class="mono">
        </div>
      </div>

      <div class="f">
        <span class="lab">渐变</span>
        <label class="row" style="gap:6px"><input type="checkbox" id="qr-grad"> 前景使用线性渐变</label>
        <div class="cf" id="qr-grad-wrap" hidden>
          <input type="color" id="qr-fg2-c" value="#0071e3">
          <input type="text" id="qr-fg2" value="#0071e3" spellcheck="false" class="mono">
        </div>
        <div id="qr-grad-ang-wrap" hidden>
          <span class="lab">渐变角度 <b id="qr-ga-v" class="mono">-45</b>°</span>
          <input type="range" id="qr-grad-ang" data-out="#qr-ga-v" min="-180" max="180" step="15" value="-45">
        </div>
      </div>

      <div class="f">
        <label class="row" style="gap:6px"><input type="checkbox" id="qr-bg-trans"> 背景透明</label>
        <span class="lab">圆角容器 <b id="qr-rad-v" class="mono">0</b> px</span>
        <input type="range" id="qr-rad" data-out="#qr-rad-v" min="0" max="60" step="2" value="0">
        <span class="qr-sub">给整张图加圆角(带底色时更好看)</span>
      </div>
    </div>

    <div class="card-h mt" style="margin-top:14px">
      <h2>中心填充</h2>
      <span class="grow"></span>
      <div class="seg" id="qr-center">
        <button class="seg-btn on" data-v="none">无</button>
        <button class="seg-btn" data-v="text">文字</button>
        <button class="seg-btn" data-v="color">色块</button>
        <button class="seg-btn" data-v="image">图片</button>
      </div>
    </div>
    <div class="qr-center" id="qr-center-box" hidden>
      <div class="cols tight">
        <div class="f" id="qr-ct-text-f" hidden>
          <span class="lab">中间文字</span>
          <input type="text" id="qr-ct-text" value="扫码" maxlength="6" spellcheck="false">
        </div>
        <div class="f" id="qr-ct-color-f" hidden>
          <span class="lab">中间色块</span>
          <div class="cf">
            <input type="color" id="qr-ct-color-c" value="#0071e3">
            <input type="text" id="qr-ct-color" value="#0071e3" spellcheck="false" class="mono">
          </div>
        </div>
        <div class="f" id="qr-ct-img-f" hidden>
          <span class="lab">中间图片(建议方形、透明背景 PNG)</span>
          <div class="drop" id="qr-ct-drop" style="min-height:84px">
            <b>选择或拖入图片</b>
            <span class="hint">PNG / JPG / SVG,建议 512×512 以内</span>
          </div>
        </div>
        <div class="f">
          <span class="lab">填充大小 <b id="qr-ct-r-v" class="mono">22</b>% 边长</span>
          <input type="range" id="qr-ct-r" data-out="#qr-ct-r-v" min="10" max="34" step="1" value="22">
        </div>
        <div class="f">
          <span class="lab">底板留白 <b id="qr-ct-p-v" class="mono">8</b>%</span>
          <input type="range" id="qr-ct-pad" data-out="#qr-ct-p-v" min="0" max="20" step="1" value="8">
          <label class="row" style="gap:6px"><input type="checkbox" id="qr-ct-plate" checked> 垫一层背景色底板</label>
        </div>
      </div>
      <div class="msg mt" id="qr-ct-hint"></div>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>预览与导出</h2>
    <span class="grow"></span>
    <span class="msg" id="qr-out-msg"></span>
    <button class="btn sm" id="qr-open-all">逐个打开图片</button>
    <button class="btn sm" id="qr-copy-all">复制全部数据链接</button>
  </div>
  <div class="rows tall" id="qr-list"><div class="empty">上面填好内容,这里会逐个显示二维码</div></div>
  <div class="msg mt"><b>导出说明:</b>工具页在沙箱里,浏览器不允许直接落盘。「打开图片」会在新标签页里显示原图,在那里按 Ctrl+S 或右键「图片另存为」即可保存;「复制数据链接」得到的是可直接粘进 img 标签的 DataURL;也可以右键这里的预览图选「图片另存为」。</div>
</div>

<div class="card">
  <div class="card-h">
    <h2>识别已有二维码</h2>
    <span class="grow"></span>
    <span class="msg" id="qr-dec-msg"></span>
    <button class="btn sm ghost" id="qr-dec-clear">清空结果</button>
  </div>
  <div class="drop" id="qr-drop">
    <b>拖入或点击选择二维码图片</b>
    <span class="hint">支持一次多张;也可以直接 Ctrl+V 粘贴截图</span>
  </div>
  <div class="rows tall mt" id="qr-dec-list"><div class="empty">识别结果会显示在这里</div></div>
</div>
TCQR_BODY;
$script = <<<'TCQR_JS'
/* 二维码核心:编码 + 解码(纯 JS,无依赖)。先在这里跑通再嵌进工具页。
 * 编码:byte/numeric/alnum,版本 1-40,纠错 L/M/Q/H,自动选版本与掩码。
 * 解码:矩阵级(含 Reed-Solomon 纠错)+ 图像级(二值化 → 定位 → 采样 → 矩阵)。
 */
var QR = (function () {
  'use strict';

  // ---------- GF(256) ----------
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function gdiv(a, b) { return a === 0 ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]; }
  function gpow(a, n) { return EXP[(LOG[a] * n) % 255]; }

  // ---------- 规格表 ----------
  var LEVELS = ['L', 'M', 'Q', 'H'];
  var LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // 格式信息里的两位编码
  var ECC_PER_BLOCK = {
    L: [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    M: [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    Q: [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    H: [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
  };
  var NUM_BLOCKS = {
    L: [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    M: [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    Q: [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    H: [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
  };
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  function rawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver, level) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[level][ver - 1] * NUM_BLOCKS[level][ver - 1];
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var out = [6], pos = ver * 4 + 10;
    for (var i = 1; i < n; i++) { out.splice(i, 0, pos); pos -= step; }
    return out;
  }

  // ---------- 位缓冲 ----------
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };
  BitBuf.prototype.len = function () { return this.bits.length; };

  function utf8Bytes(s) {
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
    return out;
  }
  function utf8Decode(bytes) {
    var out = '', i = 0;
    while (i < bytes.length) {
      var b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); i++; }
      else if (b >= 0xC0 && b < 0xE0 && i + 1 < bytes.length) { out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
      else if (b >= 0xE0 && b < 0xF0 && i + 2 < bytes.length) { out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
      else if (b >= 0xF0 && i + 3 < bytes.length) {
        var cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
        i += 4;
      } else { out += String.fromCharCode(b); i++; }
    }
    return out;
  }

  // ---------- 字符计数位宽 ----------
  function modeOf(text) {
    if (/^[0-9]+$/.test(text)) return 'num';
    // 字母数字模式只能表示大写(解码出来必然是大写),所以含小写字母时必须走字节模式,
    // 否则用户输入的 "x" 会被编成 "X" 再也还原不回来。
    if (text !== text.toUpperCase()) return 'byte';
    var ok = true;
    for (var i = 0; i < text.length; i++) if (ALNUM.indexOf(text.charAt(i)) < 0) { ok = false; break; }
    return ok ? 'alnum' : 'byte';
  }
  function countBits(mode, ver) {
    var g = ver <= 9 ? 0 : (ver <= 26 ? 1 : 2);
    if (mode === 'num') return [10, 12, 14][g];
    if (mode === 'alnum') return [9, 11, 13][g];
    return [8, 16, 16][g];   // byte / kanji
  }

  function makeSegment(text, mode, ver, eci) {
    var bb = new BitBuf(), i;
    var nonAscii = false;
    for (i = 0; i < text.length && !nonAscii; i++) if (text.charCodeAt(i) > 127) nonAscii = true;
    // 非 ASCII 默认直接写 UTF-8 字节、不声明 ECI 26。这是主流生成器(qrcode/segno/微信)
    // 的实际约定,手机扫码一律按 UTF-8 猜;反而声明了 ECI 的老式扫码器有概率不认识。
    // 需要严格按规范声明的场景可以显式打开 opts.eci。
    if (mode === 'byte' && nonAscii && eci) { bb.put(0x7, 4); bb.put(26, 8); }
    bb.put({ num: 1, alnum: 2, byte: 4 }[mode], 4);
    var bytes = mode === 'byte' ? utf8Bytes(text) : null;
    var n = mode === 'byte' ? bytes.length : text.length;
    bb.put(n, countBits(mode, ver));
    if (mode === 'num') {
      for (i = 0; i < text.length; i += 3) {
        var chunk = text.substr(i, 3);
        bb.put(parseInt(chunk, 10), chunk.length * 3 + 1);
      }
    } else if (mode === 'alnum') {
      var s = text.toUpperCase();
      for (i = 0; i + 1 < s.length; i += 2) bb.put(ALNUM.indexOf(s.charAt(i)) * 45 + ALNUM.indexOf(s.charAt(i + 1)), 11);
      if (i < s.length) bb.put(ALNUM.indexOf(s.charAt(i)), 6);
    } else {
      for (i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
    }
    return bb;
  }

  function versionFor(text, level, eci) {
    var mode = modeOf(text);
    for (var v = 1; v <= 40; v++) {
      var needed = makeSegment(text, mode, v, eci).len() + 4;   // 终止符最多 4 位
      if (needed <= dataCodewords(v, level) * 8) return { ver: v, mode: mode };
    }
    return null;
  }

  // ---------- 纠错码 ----------
  function rsDivisor(deg) {
    var result = new Uint8Array(deg);
    result[deg - 1] = 1;
    var rootI = 0;
    for (var i = 0; i < deg; i++) {
      for (var j = 0; j < deg; j++) {
        result[j] = gmul(result[j], EXP[rootI]);
        if (j + 1 < deg) result[j] ^= result[j + 1];
      }
      rootI++;
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var out = new Uint8Array(divisor.length);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ out[0];
      out.copyWithin(0, 1);
      out[out.length - 1] = 0;
      for (var j = 0; j < divisor.length; j++) out[j] ^= gmul(divisor[j], factor);
    }
    return out;
  }

  // ---------- 画矩阵 ----------
  function functionPattern(ver) {
    var size = ver * 4 + 17;
    var fn = [];
    for (var i = 0; i < size; i++) fn.push(new Uint8Array(size));
    function mark(r, c, h, w) {
      for (var y = r; y < r + h; y++) for (var x = c; x < c + w; x++) if (y >= 0 && y < size && x >= 0 && x < size) fn[y][x] = 1;
    }
    mark(0, 0, 9, 9); mark(0, size - 8, 9, 8); mark(size - 8, 0, 8, 9);   // 定位 + 分隔
    for (var k = 0; k < size; k++) { fn[6][k] = 1; fn[k][6] = 1; }        // 定时
    var pos = alignPositions(ver);
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var r = pos[a], c = pos[b];
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        mark(r - 2, c - 2, 5, 5);
      }
    }
    fn[size - 8][8] = 1;                                                  // 固定黑点
    // 格式信息区
    mark(8, 0, 1, 9); mark(0, 8, 9, 1);
    mark(8, size - 8, 1, 8); mark(size - 7, 8, 7, 1);
    if (ver >= 7) { mark(0, size - 11, 6, 3); mark(size - 11, 0, 3, 6); }
    return fn;
  }

  function drawFunctionPatterns(m, ver) {
    var size = ver * 4 + 17;
    function finder(r, c) {
      for (var y = -1; y <= 7; y++) {
        for (var x = -1; x <= 7; x++) {
          var rr = r + y, cc = c + x;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          // 切比雪夫距离 d:0-1=中心 3×3 实心块,2=中间留白圈,3=最外一圈实线,4=分隔带
          var d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          m[rr][cc] = (d <= 1 || d === 3) ? 1 : 0;
        }
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (var i = 8; i < size - 8; i++) { m[6][i] = (i % 2 === 0) ? 1 : 0; m[i][6] = (i % 2 === 0) ? 1 : 0; }
    var pos = alignPositions(ver);
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var r = pos[a], c = pos[b];
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (var y = -2; y <= 2; y++) for (var x = -2; x <= 2; x++) m[r + y][c + x] = (Math.max(Math.abs(x), Math.abs(y)) !== 1) ? 1 : 0;
      }
    }
    m[size - 8][8] = 1;
    // 预留格式信息:先用 0 占位(稍后写真正值)
    for (var k = 0; k < 9; k++) { if (k !== 6) { m[8][k] = 0; m[k][8] = 0; } }
    for (var k2 = 0; k2 < 8; k2++) { m[8][size - 1 - k2] = 0; m[size - 1 - k2][8] = 0; }
  }

  function drawFormat(m, level, mask, ver) {
    var size = ver * 4 + 17;
    var data = (LEVEL_BITS[level] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    function bit(i) { return (bits >>> i) & 1; }
    // 位 0-5 沿「列 8」自上而下,位 9-14 沿「行 8」自右向左;两份互为转置关系。
    // 写成 m[8][k]=bit(k) 会把两份对调成转置版本 —— 自己编自己解看不出来(读写同源),
    // 真实扫码器读到的却是镜像后的格式串,于是识别不出纠错等级与掩码。
    for (var k = 0; k <= 5; k++) m[k][8] = bit(k);
    m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
    for (var k2 = 9; k2 < 15; k2++) m[8][14 - k2] = bit(k2);
    for (var j = 0; j < 8; j++) m[8][size - 1 - j] = bit(j);
    for (var j2 = 8; j2 < 15; j2++) m[size - 15 + j2][8] = bit(j2);
    m[size - 8][8] = 1;
  }

  function drawVersionInfo(m, ver) {
    if (ver < 7) return;
    var size = ver * 4 + 17, rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1F25);
    var bits = (ver << 12) | rem;
    for (var k = 0; k < 18; k++) {
      var b = (bits >>> k) & 1;
      var a = Math.floor(k / 3), bb = k % 3;
      m[size - 11 + bb][a] = b;
      m[a][size - 11 + bb] = b;
    }
  }

  function drawCodewords(m, data, ver) {
    var size = ver * 4 + 17, i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!m.__fn[y][x] && i < data.length * 8) {
            m[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  }
  function maskFn(k) {
    return [
      function (y, x) { return (x + y) % 2 === 0; },
      function (y) { return y % 2 === 0; },
      function (y, x) { return x % 3 === 0; },
      function (y, x) { return (x + y) % 3 === 0; },
      function (y, x) { return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; },
      function (y, x) { return (x * y) % 2 + (x * y) % 3 === 0; },
      function (y, x) { return ((x * y) % 2 + (x * y) % 3) % 2 === 0; },
      function (y, x) { return ((x + y) % 2 + (x * y) % 3) % 2 === 0; }
    ][k];
  }
  function applyMask(m, ver, k) {
    var size = ver * 4 + 17, fn = m.__fn, f = maskFn(k);
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!fn[y][x] && f(y, x)) m[y][x] ^= 1;
  }
  function penalty(m, ver) {
    var size = ver * 4 + 17, s = 0, x, y, run, i;
    // 规则 1:同色连排
    for (y = 0; y < size; y++) {
      run = 1;
      for (x = 1; x < size; x++) {
        if (m[y][x] === m[y][x - 1]) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
    }
    for (x = 0; x < size; x++) {
      run = 1;
      for (y = 1; y < size; y++) {
        if (m[y][x] === m[y - 1][x]) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
    }
    // 规则 2:2x2 同色块
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3;
    }
    // 规则 3:定位符样式(1:1:3:1:1 且一侧有 4 个空白)
    var pat = [1, 0, 1, 1, 1, 0, 1];
    function hit(get, len) {
      var n = 0;
      for (var i2 = 0; i2 + 7 <= len; i2++) {
        var ok = true;
        for (var j = 0; j < 7; j++) if (get(i2 + j) !== pat[j]) { ok = false; break; }
        if (!ok) continue;
        var before = true, after = true;
        for (var k = 1; k <= 4; k++) { if (i2 - k >= 0 && get(i2 - k) !== 0) { before = false; break; } }
        for (var k2 = 1; k2 <= 4; k2++) { if (i2 + 6 + k2 < len && get(i2 + 6 + k2) !== 0) { after = false; break; } }
        if (before || after) n++;
      }
      return n;
    }
    for (y = 0; y < size; y++) s += 40 * hit((function (yy) { return function (i3) { return m[yy][i3]; }; })(y), size);
    for (x = 0; x < size; x++) s += 40 * hit((function (xx) { return function (i3) { return m[i3][xx]; }; })(x), size);
    // 规则 4:黑白比例
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) dark += m[y][x] ? 1 : 0;
    var total = size * size;
    var k3 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    s += k3 * 10;
    return s;
  }

  // opts: { version: 强制版本, mask: 强制掩码(0-7), eci: 是否为 UTF-8 声明 ECI 26 }
  function encode(text, level, minVersion, opts) {
    opts = opts || {};
    level = LEVELS.indexOf(level) >= 0 ? level : 'M';
    var pick = versionFor(text, level, opts.eci);
    if (!pick) throw new Error('内容太长，一个二维码放不下（可换更高的纠错等级或拆分内容）');
    var ver = Math.max(pick.ver, opts.version || minVersion || 1);
    var seg = makeSegment(text, pick.mode, ver, opts.eci);
    if (seg.len() > dataCodewords(ver, level) * 8) throw new Error('内容太长，一个二维码放不下');
    var cap = dataCodewords(ver, level) * 8;
    // 终止符 + 补齐到字节 + 交替填充 0xEC/0x11
    var bits = seg.bits.slice();
    for (var i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var dataBytes = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      dataBytes.push(v);
    }
    var pad = [0xEC, 0x11], pi = 0;
    while (dataBytes.length < cap / 8) dataBytes.push(pad[pi++ % 2]);

    // 分块 + 纠错 + 交织
    var nb = NUM_BLOCKS[level][ver - 1], ecLen = ECC_PER_BLOCK[level][ver - 1];
    var totalData = dataBytes.length;
    var shortLen = Math.floor(totalData / nb), numLong = totalData % nb;
    var blocks = [], dataBlocks = [], ecBlocks = [], off = 0, bi;
    var div = rsDivisor(ecLen);
    for (bi = 0; bi < nb; bi++) {
      var len = shortLen + (bi >= nb - numLong ? 1 : 0);
      var blk = dataBytes.slice(off, off + len);
      off += len;
      dataBlocks.push(blk);
      ecBlocks.push(rsRemainder(new Uint8Array(blk), div));
    }
    var finalCw = [];
    var maxLen = shortLen + (numLong > 0 ? 1 : 0);
    for (var ci = 0; ci < maxLen; ci++) {
      for (bi = 0; bi < nb; bi++) if (ci < dataBlocks[bi].length) finalCw.push(dataBlocks[bi][ci]);
    }
    for (var ei = 0; ei < ecLen; ei++) {
      for (bi = 0; bi < nb; bi++) finalCw.push(ecBlocks[bi][ei]);
    }

    // 画布
    var size = ver * 4 + 17;
    var m = [];
    for (var r = 0; r < size; r++) m.push(new Uint8Array(size));
    m.__fn = functionPattern(ver);
    drawFunctionPatterns(m, ver);
    drawCodewords(m, finalCw, ver);
    drawFormat(m, level, 0, ver);
    drawVersionInfo(m, ver);
    // 选掩码:逐个试,取罚分最低的(opts.mask 给定时直接用它,便于和规范实现逐模块比对)
    var bestMask = 0;
    if (opts.mask != null) {
      bestMask = opts.mask & 7;
    } else {
      var bestScore = Infinity;
      for (var mk = 0; mk < 8; mk++) {
        applyMask(m, ver, mk);
        drawFormat(m, level, mk, ver);
        var sc = penalty(m, ver);
        if (sc < bestScore) { bestScore = sc; bestMask = mk; }
        applyMask(m, ver, mk);   // 还原
      }
    }
    applyMask(m, ver, bestMask);
    drawFormat(m, level, bestMask, ver);
    var grid = [];
    for (var y = 0; y < size; y++) {
      var row = new Uint8Array(size);
      for (var x = 0; x < size; x++) row[x] = m[y][x] ? 1 : 0;
      grid.push(row);
    }
    grid.__ver = ver; grid.__level = level; grid.__mask = bestMask; grid.__size = size;
    grid.__cw = finalCw;
    return grid;
  }

  // ---------- 解码:矩阵级 ----------
  var FORMAT_LEVELS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
  function readFormat(grid, size) {
    // 两份格式信息都读出来,取能通过 BCH 距离校验的那份
    var got = [];
    // 读法必须与 drawFormat 逐位镜像:i 是「第 i 位」(LSB 起算),不是第 i 个被写下的模块。
    // 写成 v=(v<<1)|get(i) 会把位序整个倒过来 —— 32 个候选里总有一个「距离 3」的近似值,
    // 于是拿不到 null 而是静默返回错误的纠错等级/掩码。
    function bitsFrom(get) {
      var v = 0;
      for (var i = 0; i < 15; i++) v |= (get(i) & 1) << i;
      // v 已经是「带 0x5412 掩码」的最终格式串(drawFormat 就是这么写下去的),
      // 这里再 XOR 一次等于把掩码撤掉,和 encodeFormat 的返回值对不上 —— 表现为恒返回 null。
      return v;
    }
    var copy1 = bitsFrom(function (i) {
      if (i < 6) return grid[i][8];
      if (i === 6) return grid[7][8];
      if (i === 7) return grid[8][8];
      if (i === 8) return grid[8][7];
      return grid[8][14 - i];
    });
    var copy2 = bitsFrom(function (i) { return i < 8 ? grid[8][size - 1 - i] : grid[size - 15 + i][8]; });
    [copy1, copy2].forEach(function (raw) {
      // 与 32 个合法格式串比对,允许最多 3 位错(标准 BCH 距离 7)
      var best = -1, bestD = 99;
      for (var d = 0; d < 32; d++) {
        var enc = encodeFormat((d >> 3) & 3, d & 7);
        var diff = 0, t = enc ^ raw;
        while (t) { diff += t & 1; t >>>= 1; }
        if (diff < bestD) { bestD = diff; best = d; }
      }
      if (bestD <= 3) got.push({ level: FORMAT_LEVELS[(best >> 3) & 3], mask: best & 7, dist: bestD });
    });
    got.sort(function (a, b) { return a.dist - b.dist; });
    return got.length ? got[0] : null;
  }
  function encodeFormat(levelBits, mask) {
    var data = (levelBits << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function readVersion(grid, size) {
    // 版本 ≥ 7 才有版本信息;小图直接按尺寸算版本
    if (size < 45) return (size - 17) / 4;
    var raw = 0;
    for (var i = 0; i < 18; i++) {
      var a = Math.floor(i / 3), b = i % 3;
      raw = (raw << 1) | grid[size - 11 + b][a];
    }
    var best = -1, bestD = 99;
    for (var v = 7; v <= 40; v++) {
      var rem = v;
      for (var k = 0; k < 12; k++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1F25);
      var enc = (v << 12) | rem;
      var diff = 0, t = enc ^ raw;
      while (t) { diff += t & 1; t >>>= 1; }
      if (diff < bestD) { bestD = diff; best = v; }
    }
    var bySize = (size - 17) / 4;
    return (bestD <= 3 || best < 7) ? (best >= 7 && bestD <= 3 ? best : bySize) : bySize;
  }

  function totalCodewords(ver) {
    return Math.floor(rawDataModules(ver) / 8);
  }

  // 每个码字占用的模块坐标(按写入顺序)。自检用:把「打坏 N 个码字」精确地
  // 映射成「翻转哪几个模块」,才能验证 RS 的纠错边界正好是 ecLen/2。
  function codewordModules(ver, cwCount) {
    var size = ver * 4 + 17, fn = functionPattern(ver), res = [], i = 0;
    var limit = (cwCount || totalCodewords(ver)) * 8;
    for (var right = size - 1; right >= 1 && i < limit; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size && i < limit; vert++) {
        for (var j = 0; j < 2 && i < limit; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!fn[y][x]) {
            var ci = i >> 3;
            if (!res[ci]) res[ci] = [];
            res[ci].push([y, x]);
            i++;
          }
        }
      }
    }
    return res;
  }

  function readCodewords(grid, ver) {
    var size = ver * 4 + 17, fn = functionPattern(ver), bits = [];
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!fn[y][x]) bits.push(grid[y][x] ? 1 : 0);
        }
      }
    }
    var out = [];
    for (var i = 0; i + 8 <= bits.length; i += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
      out.push(v);
    }
    return out;
  }

  // ---------- Reed-Solomon 纠错 ----------
  // 码字 cw[0] 是最高次项:x_j 位置对应 X_j = alpha^(n-1-j),伴随式 S_i = Σ_j cw[j]·alpha^(i(n-1-j))。
  // 流程:伴随式 → Berlekamp-Massey 求错误定位多项式 Λ → Chien 搜索找位置 →
  // 解线性方程组求错误幅值(用高斯消元而不是 Forney 公式:少一处易错的推导,
  // 且这里的错误个数 ≤ ecLen/2,规模很小)。
  function polyEval(coefs, x) {   // Σ coefs[i]·x^i
    var v = 0;
    for (var i = coefs.length - 1; i >= 0; i--) v = gmul(v, x) ^ coefs[i];
    return v;
  }
  function solveLinear(A, b, n) {
    for (var c = 0; c < n; c++) {
      var piv = -1;
      for (var r = c; r < n; r++) if (A[r][c]) { piv = r; break; }
      if (piv < 0) throw new Error('二维码损伤过多，纠错失败');
      var t = A[c]; A[c] = A[piv]; A[piv] = t;
      var tb = b[c]; b[c] = b[piv]; b[piv] = tb;
      var inv = gdiv(1, A[c][c]);
      for (var j = c; j < n; j++) A[c][j] = gmul(A[c][j], inv);
      b[c] = gmul(b[c], inv);
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === c || !A[r2][c]) continue;
        var f = A[r2][c];
        for (var j2 = c; j2 < n; j2++) A[r2][j2] ^= gmul(f, A[c][j2]);
        b[r2] ^= gmul(f, b[c]);
      }
    }
    return b;
  }
  function rsCorrect(cw, ecLen) {
    var n = cw.length, i, j, k;
    var syn = new Uint8Array(ecLen);
    var clean = true;
    for (i = 0; i < ecLen; i++) {
      var s = 0;
      for (j = 0; j < n; j++) s = gmul(s, EXP[i]) ^ cw[j];
      syn[i] = s;
      if (s !== 0) clean = false;
    }
    if (clean) return cw;
    // Berlekamp-Massey:Λ(x) = 1 + Σ C[i]·x^i,其根为 X_k^-1
    var C = [1], B = [1], L = 0, m = 1, bCoef = 1;
    for (var nn = 0; nn < ecLen; nn++) {
      var d = syn[nn];
      for (i = 1; i <= L; i++) d ^= gmul(C[i] || 0, syn[nn - i]);
      if (d === 0) { m++; continue; }
      var T = C.slice();
      var coef = gdiv(d, bCoef);
      while (C.length < B.length + m) C.push(0);
      for (i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
      if (2 * L <= nn) { L = nn + 1 - L; B = T; bCoef = d; m = 1; }
      else m++;
    }
    while (C.length > 1 && C[C.length - 1] === 0) C.pop();
    if (L < 1 || 2 * L > ecLen) throw new Error('二维码损伤过多，纠错失败');
    // Chien:测试每个位置「从右数第 i 个」的 X = alpha^i,即 Λ(alpha^-i) 是否为 0
    var xs = [];
    for (i = 0; i < n; i++) {
      if (polyEval(C, EXP[(255 - i) % 255]) === 0) xs.push(i);
    }
    if (xs.length !== L) throw new Error('二维码损伤过多，纠错失败');
    // 幅值:Σ_k e_k·X_k^j = S_j,j = 0..L-1
    var A = [], rhs = [];
    for (j = 0; j < L; j++) {
      var row = [];
      for (k = 0; k < L; k++) row.push(gpow(EXP[xs[k]], j));
      A.push(row);
      rhs.push(syn[j]);
    }
    var mags = solveLinear(A, rhs, L);
    var out = cw.slice();
    for (k = 0; k < L; k++) out[n - 1 - xs[k]] ^= mags[k];
    return out;
  }

  function decodeCodewords(allCw, ver, level) {
    var nb = NUM_BLOCKS[level][ver - 1], ecLen = ECC_PER_BLOCK[level][ver - 1];
    var totalData = Math.floor(rawDataModules(ver) / 8) - ecLen * nb;
    var shortLen = Math.floor(totalData / nb), numLong = totalData % nb;
    var blocks = [], i;
    for (i = 0; i < nb; i++) blocks.push([]);
    var maxLen = shortLen + (numLong > 0 ? 1 : 0);
    var idx = 0;
    for (var ci = 0; ci < maxLen; ci++) {
      for (i = 0; i < nb; i++) if (ci < shortLen + (i >= nb - numLong ? 1 : 0)) blocks[i].push(allCw[idx++]);
    }
    for (var ei = 0; ei < ecLen; ei++) for (i = 0; i < nb; i++) blocks[i].push(allCw[idx++]);
    var data = [];
    for (i = 0; i < nb; i++) {
      var fixed = rsCorrect(new Uint8Array(blocks[i]), ecLen);
      var dlen = shortLen + (i >= nb - numLong ? 1 : 0);
      for (var j = 0; j < dlen; j++) data.push(fixed[j]);
    }
    return data;
  }

  function parseData(bytes, ver) {
    var bb = [];
    for (var i = 0; i < bytes.length; i++) for (var k = 7; k >= 0; k--) bb.push((bytes[i] >>> k) & 1);
    var p = 0, out = '', eci = null;
    function take(n) { var v = 0; for (var i2 = 0; i2 < n; i2++) v = (v << 1) | (bb[p++] || 0); return v; }
    while (p + 4 <= bb.length) {
      var mode = take(4);
      if (mode === 0) break;
      if (mode === 7) {   // ECI
        var first = take(8);
        if ((first & 0x80) === 0) eci = first;
        else if ((first & 0xC0) === 0x80) eci = ((first & 0x3F) << 8) | take(8);
        else eci = ((first & 0x1F) << 16) | take(16);
        continue;
      }
      if (mode === 1 || mode === 2 || mode === 4) {
        var n = take(countBits({ 1: 'num', 2: 'alnum', 4: 'byte' }[mode], ver));
        if (mode === 1) {
          var s1 = '';
          while (n >= 3) { s1 += String(take(10)).padStart(3, '0'); n -= 3; }
          if (n === 2) s1 += String(take(7)).padStart(2, '0');
          else if (n === 1) s1 += String(take(4));
          out += s1;
        } else if (mode === 2) {
          while (n >= 2) { var v2 = take(11); out += ALNUM.charAt(Math.floor(v2 / 45)) + ALNUM.charAt(v2 % 45); n -= 2; }
          if (n === 1) out += ALNUM.charAt(take(6));
        } else {
          var arr = [];
          for (var i3 = 0; i3 < n; i3++) arr.push(take(8));
          out += (eci === 26 || eci === null) ? utf8Decode(arr) : utf8Decode(arr);
        }
      } else {
        throw new Error('这个二维码用了暂不支持的模式（模式 ' + mode + '）');
      }
    }
    return out;
  }

  function rotate(grid, times) {
    var cur = grid;
    for (var t = 0; t < times; t++) {
      var n = cur.length, out = [];
      for (var y = 0; y < n; y++) {
        var row = new Uint8Array(n);
        for (var x = 0; x < n; x++) row[x] = cur[n - 1 - x][y];
        out.push(row);
      }
      out.__ver = cur.__ver; out.__level = cur.__level; out.__size = n;
      cur = out;
    }
    return cur;
  }

  /** 矩阵解码:返回文本;四向旋转都会试。 */
  function decodeMatrix(grid) {
    var errors = [];
    for (var rot = 0; rot < 4; rot++) {
      var g = rotate(grid, rot);
      var size = g.length;
      if ((size - 17) % 4 !== 0 || size < 21 || size > 177) { errors.push('尺寸不是合法二维码'); continue; }
      var ver = readVersion(g, size);
      var fmt = readFormat(g, size);
      if (!fmt) { errors.push('读不出格式信息'); continue; }
      var unmasked = [];
      for (var y = 0; y < size; y++) unmasked.push(Uint8Array.from(g[y]));
      unmasked.__fn = functionPattern(ver);
      applyMask(unmasked, ver, fmt.mask);
      try {
        var cw = readCodewords(unmasked, ver);
        var data = decodeCodewords(cw, ver, fmt.level);
        return { text: parseData(data, ver), version: ver, level: fmt.level, mask: fmt.mask, rotation: rot * 90 };
      } catch (e) {
        errors.push(e.message);
      }
    }
    throw new Error('识别失败：' + (errors[errors.length - 1] || '未知原因'));
  }

  // ---------- 解码:图像级 ----------
  /** 灰度 + Otsu 阈值 → 二值矩阵(1 = 深色)。 */
  function binarize(imgData, w, h) {
    var gray = new Uint8Array(w * h), i, hist = new Uint32Array(256);
    for (i = 0; i < w * h; i++) {
      var r = imgData.data[i * 4], g = imgData.data[i * 4 + 1], b = imgData.data[i * 4 + 2], a = imgData.data[i * 4 + 3];
      var v = a < 128 ? 255 : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[i] = v;
      hist[v]++;
    }
    var total = w * h, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, thr = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    var bins = new Uint8Array(w * h);
    for (i = 0; i < w * h; i++) bins[i] = gray[i] <= thr ? 1 : 0;
    return bins;
  }

  /** 在一行里扫 1:1:3:1:1 的横截面,返回候选中心与模块尺寸估计。 */
  function scanRow(bins, w, y) {
    var runs = [], cur = bins[y * w], cnt = 0, start = 0, x;
    for (x = 0; x < w; x++) {
      var v = bins[y * w + x];
      if (v === cur) cnt++;
      else { runs.push({ v: cur, n: cnt, s: start }); cur = v; cnt = 1; start = x; }
    }
    runs.push({ v: cur, n: cnt, s: start });
    var out = [];
    for (var i = 0; i + 4 < runs.length; i++) {
      var a = runs[i], b = runs[i + 1], c = runs[i + 2], d = runs[i + 3], e = runs[i + 4];
      if (a.v !== 1 || b.v !== 0 || c.v !== 1 || d.v !== 0 || e.v !== 1) continue;
      var m = (a.n + b.n + c.n + d.n + e.n) / 7;
      if (m < 0.8) continue;
      // 允许一定透视/缩放误差,但比例必须接近 1:1:3:1:1
      if (Math.abs(a.n - b.n) > m * 0.9 || Math.abs(b.n - d.n) > m * 0.9 || Math.abs(d.n - e.n) > m * 0.9) continue;
      if (c.n < m * 2 || c.n > m * 5) continue;
      out.push({ x: c.s + c.n / 2, y: y, m: m });
    }
    return out;
  }

  /** 纵向聚类:真定位符会在约 3 个模块行上连续出现 1:1:3:1:1。 */
  function findFinders(bins, w, h) {
    var groups = [], y, i, k;
    for (y = 0; y < h; y++) {
      var row = scanRow(bins, w, y);
      for (i = 0; i < row.length; i++) {
        var c = row[i], g = null;
        for (k = 0; k < groups.length; k++) {
          var gg = groups[k];
          if (gg.lastY >= y - 2 && gg.lastY <= y && Math.abs(gg.lastX - c.x) <= Math.max(gg.m, c.m) * 2.5 &&
              Math.abs(gg.m - c.m) <= gg.m * 0.8) { g = gg; break; }
        }
        if (!g) groups.push({ sumX: c.x, sumM: c.m, n: 1, y0: y, y1: y, lastX: c.x, lastY: y, m: c.m });
        else {
          g.sumX += c.x; g.sumM += c.m; g.n++; g.y1 = y; g.lastX = c.x; g.lastY = y; g.m = g.sumM / g.n;
        }
      }
    }
    var out = [];
    for (k = 0; k < groups.length; k++) {
      var p = groups[k];
      // 定位符的实心块高 3 个模块,横截面至少覆盖 2 个模块高才算数
      if (p.n < 3 || (p.y1 - p.y0 + 1) < p.m * 1.6) continue;
      out.push({ x: p.sumX / p.n, y: (p.y0 + p.y1 + 1) / 2, m: p.m, n: p.n });
    }
    out.sort(function (a, b) { return b.n - a.n; });
    return out;
  }

  /** 由三个定位符中心建仿射变换采样成矩阵(自动带方向,不依赖图像是否摆正)。 */
  function gridFromFinders(fs, bins, w, h) {
    if (fs.length < 3) return null;
    function d2(p, q) { return (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y); }
    var A = fs[0], B = fs[1], C = fs[2];
    var dAB = d2(A, B), dAC = d2(A, C), dBC = d2(B, C), corner, p1, p2;
    if (dAB > dAC && dAB > dBC) { corner = C; p1 = A; p2 = B; }
    else if (dAC > dAB && dAC > dBC) { corner = B; p1 = A; p2 = C; }
    else { corner = A; p1 = B; p2 = C; }
    // 直角顶点就是左上定位符;剩下两个谁在右上由叉积定(图像 y 轴向下)
    var cross = (p1.x - corner.x) * (p2.y - corner.y) - (p1.y - corner.y) * (p2.x - corner.x);
    if (Math.abs(cross) < 1e-6) return null;
    var tr = cross > 0 ? p1 : p2, bl = cross > 0 ? p2 : p1;
    var m = (A.m + B.m + C.m) / 3;
    if (!(m > 0)) return null;
    var size = Math.round((Math.sqrt(d2(corner, tr)) + Math.sqrt(d2(corner, bl))) / 2 / m) + 7;
    size = Math.round((size - 17) / 4) * 4 + 17;          // 合法尺寸 17+4k
    if (size < 21 || size > 177) return null;
    var span = size - 7;
    var ex = { x: (tr.x - corner.x) / span, y: (tr.y - corner.y) / span };
    var ey = { x: (bl.x - corner.x) / span, y: (bl.y - corner.y) / span };
    var grid = [];
    for (var v = 0; v < size; v++) {
      var row = new Uint8Array(size);
      for (var u = 0; u < size; u++) {
        // 定位符中心对应模块坐标 (3.5, 3.5)
        var px = corner.x + ex.x * (u - 3.5) + ey.x * (v - 3.5);
        var py = corner.y + ex.y * (u - 3.5) + ey.y * (v - 3.5);
        var ix = Math.round(px), iy = Math.round(py);
        row[u] = (ix >= 0 && ix < w && iy >= 0 && iy < h) ? bins[iy * w + ix] : 0;
      }
      grid.push(row);
    }
    grid.__size = size;
    return grid;
  }

  /** 图像解码:二值化 → 找三个定位符 → 仿射采样 → 矩阵解码。定位失败时退回外框估算。 */
  function decodeImage(imgData, w, h) {
    var bins = binarize(imgData, w, h);
    var errs = [];
    var fs = findFinders(bins, w, h);
    if (fs.length >= 3) {
      var top = fs.slice(0, 6), i, j, k;
      for (i = 0; i < top.length; i++) for (j = i + 1; j < top.length; j++) for (k = j + 1; k < top.length; k++) {
        var g = gridFromFinders([top[i], top[j], top[k]], bins, w, h);
        if (!g) continue;
        try { return decodeMatrix(g); } catch (e) { errs.push(e.message); }
      }
    }
    // 回退:截图/干净图里二维码外框就是符号边界,直接按外框试各种合法尺寸
    var x, y, minX = w, minY = h, maxX = -1, maxY = -1;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (bins[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) throw new Error('这张图里没有找到深色像素,可能不是二维码');
    var bw = maxX - minX + 1, bh = maxY - minY + 1;
    for (var size = 21; size <= 177; size += 4) {
      var grid = [];
      for (y = 0; y < size; y++) {
        var row = new Uint8Array(size);
        for (x = 0; x < size; x++) {
          var px = Math.min(w - 1, Math.round(minX + (x + 0.5) * (bw / size)));
          var py = Math.min(h - 1, Math.round(minY + (y + 0.5) * (bh / size)));
          row[x] = bins[py * w + px];
        }
        grid.push(row);
      }
      grid.__size = size;
      try { return decodeMatrix(grid); } catch (e) { errs.push(e.message); }
    }
    throw new Error(errs.length ? errs[errs.length - 1] : '没能定位到二维码');
  }

  return {
    encode: encode,
    decodeMatrix: decodeMatrix,
    decodeImage: decodeImage,
    binarize: binarize,
    dataCodewords: dataCodewords,
    versionFor: versionFor,
    rotate: rotate,
    __dbg: {
      rsDivisor: rsDivisor, rsRemainder: rsRemainder, rsCorrect: rsCorrect,
      readFormat: readFormat, readCodewords: readCodewords, functionPattern: functionPattern,
      applyMask: applyMask, dataCodewords: dataCodewords, rawDataModules: rawDataModules,
      penalty: penalty, codewordModules: codewordModules, totalCodewords: totalCodewords,
    },
  };
})();

(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ================= 状态 =================
  var st = {
    ec: 'L', module: 8, quiet: 4, shape: 'square', shapeR: 40, finder: 'auto',
    fg: '#111111', bg: '#ffffff', grad: false, fg2: '#0071e3', gradAng: -45,
    bgTrans: false, radius: 0,
    center: 'none', ctText: '扫码', ctColor: '#0071e3', ctRatio: 22, ctPad: 8, ctPlate: true,
    ctImg: null,
  };
  var items = [];          // { text, grid, ok }
  var ctImgEl = null;      // 中心图片(已加载的 Image)
  var renderTimer = 0;

  // ================= 颜色工具 =================
  function normHex(v, fallback) {
    v = String(v == null ? '' : v).trim();
    if (/^#?[0-9a-fA-F]{3}$/.test(v)) {
      v = v.replace('#', '');
      return '#' + v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    }
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) return '#' + v.replace('#', '').toLowerCase();
    return fallback;
  }
  // 画布上画二维码需要「实色」,透明背景用白底代替(导出的 PNG 仍带透明通道)
  function paintColor(hex, alpha) {
    var h = normHex(hex, '#000000').slice(1);
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return alpha == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function bindColor(textSel, colorSel, key) {
    var t = $(textSel), c = $(colorSel);
    t.addEventListener('input', function () {
      var v = normHex(t.value, null);
      if (v) { st[key] = v; c.value = v; live(); }
    });
    t.addEventListener('blur', function () { t.value = st[key]; });
    c.addEventListener('input', function () { st[key] = c.value; t.value = c.value; live(); });
    t.value = st[key]; c.value = st[key];
  }
  function setColor(textSel, colorSel, key, v) {
    st[key] = v; $(textSel).value = v; $(colorSel).value = v;
  }

  // ================= 控件 =================
  function collect() {
    st.ec = OC.segVal('#qr-ec') || 'L';
    st.shape = OC.segVal('#qr-shape') || 'square';
    st.finder = OC.segVal('#qr-finder') || 'auto';
    st.center = OC.segVal('#qr-center') || 'none';
    st.module = Number($('#qr-ms').value) || 8;
    st.quiet = Number($('#qr-qz').value);
    st.shapeR = Number($('#qr-shape-r').value);
    st.grad = $('#qr-grad').checked;
    st.gradAng = Number($('#qr-grad-ang').value);
    st.bgTrans = $('#qr-bg-trans').checked;
    st.radius = Number($('#qr-rad').value);
    st.ctRatio = Number($('#qr-ct-r').value);
    st.ctPad = Number($('#qr-ct-pad').value);
    st.ctPlate = $('#qr-ct-plate').checked;
    st.ctText = $('#qr-ct-text').value;
  }
  function syncVisibility() {
    var shapeRound = st.shape === 'round' || st.shape === 'diamond';
    $('#qr-shape-r-f').hidden = !shapeRound;
    $('#qr-grad-wrap').hidden = !st.grad;
    $('#qr-grad-ang-wrap').hidden = !st.grad;
    $('#qr-center-box').hidden = st.center === 'none';
    $('#qr-ct-text-f').hidden = st.center !== 'text';
    $('#qr-ct-color-f').hidden = st.center !== 'color';
    $('#qr-ct-img-f').hidden = st.center !== 'image';
    var hints = {
      L: 'L 级 约可纠 7% 的损伤,容量最大 —— 内容长、图干净时用它',
      M: 'M 级 约可纠 15%,日常推荐(多数扫码器默认按 M 生成)',
      Q: 'Q 级 约可纠 25%,带中心图标时建议至少 Q',
      H: 'H 级 约可纠 30%,最耐脏最小容量,有 logo 或有磨损时用',
    };
    $('#qr-ec-hint').textContent = hints[st.ec] || '';
  }

  var PRESETS = {
    ink: { fg: '#111111', bg: '#ffffff', grad: false, shape: 'square', finder: 'auto', radius: 0, bgTrans: false },
    brand: { fg: '#0b3d91', bg: '#ffffff', grad: false, shape: 'round', finder: 'round', radius: 0, bgTrans: false },
    night: { fg: '#f5f5f7', bg: '#1d1d1f', grad: false, shape: 'round', finder: 'round', radius: 24, bgTrans: false },
    forest: { fg: '#14532d', bg: '#f2f7f2', grad: false, shape: 'dot', finder: 'dot', radius: 0, bgTrans: false },
    berry: { fg: '#4c1d95', bg: '#faf5ff', grad: false, shape: 'round', finder: 'round', radius: 0, bgTrans: false },
    sunset: { fg: '#b91c1c', fg2: '#f59e0b', grad: true, bg: '#ffffff', shape: 'round', finder: 'round', radius: 0, bgTrans: false },
    ocean: { fg: '#0e7490', fg2: '#1d4ed8', grad: true, bg: '#ffffff', shape: 'round', finder: 'round', radius: 0, bgTrans: false },
    cocoa: { fg: '#5b3a29', bg: '#fdf6ec', grad: false, shape: 'diamond', finder: 'round', radius: 0, bgTrans: false },
  };
  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    setColor('#qr-fg', '#qr-fg-c', 'fg', p.fg);
    setColor('#qr-bg', '#qr-bg-c', 'bg', p.bg);
    if (p.fg2) setColor('#qr-fg2', '#qr-fg2-c', 'fg2', p.fg2);
    $('#qr-grad').checked = !!p.grad; st.grad = !!p.grad;
    $('#qr-bg-trans').checked = !!p.bgTrans; st.bgTrans = !!p.bgTrans;
    OC.segSet('#qr-shape', p.shape);
    OC.segSet('#qr-finder', p.finder);
    $('#qr-rad').value = p.radius;
    st.shape = p.shape; st.finder = p.finder; st.radius = p.radius;
    var rad = $('#qr-rad'); rad.style.setProperty('--p', ((p.radius - 0) / 60 * 100) + '%');
    var out = rad.getAttribute('data-out'); if (out) $(out).textContent = p.radius;
    syncVisibility();
  }

  // ================= 内容 =================
  function readItems() {
    var raw = $('#qr-text').value.split(/\r?\n/);
    var trim = $('#qr-trim').checked, dedupe = $('#qr-dedupe').checked;
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var s = trim ? raw[i].trim() : raw[i];
      if (!s) continue;
      if (dedupe) { if (seen[s]) continue; seen[s] = 1; }
      out.push(s);
    }
    return out;
  }

  // ================= 编码 =================
  function encodeOne(text) {
    return QR.encode(text, st.ec);
  }
  function thumbModule(n, quiet) {
    // 列表里的缩略图固定约 176px,版本再大也不会把页面撑爆
    var target = 176, span = n + quiet * 2;
    return Math.max(2, Math.min(st.module, Math.floor(target / span) || 2));
  }

  // ================= 绘制 =================
  function roundRectPath(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function isFinderModule(n, y, x) {
    return (y < 7 && x < 7) || (y < 7 && x >= n - 7) || (y >= n - 7 && x < 7);
  }
  function fgPaint(g, W, H) {
    if (!st.grad) return paintColor(st.fg);
    var rad = st.gradAng * Math.PI / 180, dx = Math.cos(rad), dy = Math.sin(rad);
    var cx = W / 2, cy = H / 2, len = Math.abs(W * dx) + Math.abs(H * dy);
    var lg = g.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
    lg.addColorStop(0, paintColor(st.fg));
    lg.addColorStop(1, paintColor(st.fg2));
    return lg;
  }
  function drawModule(g, x, y, ms, shape, r) {
    if (shape === 'dot') {
      g.beginPath(); g.arc(x + ms / 2, y + ms / 2, ms / 2, 0, Math.PI * 2); g.fill();
    } else if (shape === 'diamond') {
      g.beginPath();
      g.moveTo(x + ms / 2, y); g.lineTo(x + ms, y + ms / 2);
      g.lineTo(x + ms / 2, y + ms); g.lineTo(x, y + ms / 2);
      g.closePath(); g.fill();
    } else if (shape === 'round') {
      roundRectPath(g, x, y, ms, ms, ms * r / 100); g.fill();
    } else {
      g.fillRect(x, y, ms, ms);
    }
  }
  function drawFinder(g, px, py, ms, style) {
    // 定位符:外圈 7 模块 + 内芯 3 模块,按样式画成圆角/圆点
    var outer = ms * 7, inner = ms * 3, mid = ms * 5;
    var off = (outer - inner) / 2;
    if (style === 'dot') {
      g.beginPath(); g.arc(px + outer / 2, py + outer / 2, (outer - ms) / 2, 0, Math.PI * 2);
      g.lineWidth = ms; g.strokeStyle = g.fillStyle; g.stroke();
      g.beginPath(); g.arc(px + outer / 2, py + outer / 2, inner / 2, 0, Math.PI * 2); g.fill();
    } else {
      // 圆角外环:外圆角矩形挖掉内圆角矩形(evenodd),再补实心内芯
      var r = ms * 2;
      g.beginPath();
      roundRectPath(g, px, py, outer, outer, r);
      roundRectPath(g, px + ms, py + ms, mid, mid, Math.max(0, r - ms));
      g.fill('evenodd');
      roundRectPath(g, px + off, py + off, inner, inner, Math.max(0, ms * 0.6));
      g.fill();
    }
  }
  function drawCenter(g, W, H, n, ms, quiet) {
    if (st.center === 'none') return;
    var span = n * ms;
    var cw = span * st.ctRatio / 100;
    var cx = (W - cw) / 2, cy = (H - cw) / 2;
    var pad = cw * st.ctPad / 100;
    var plate = st.bgTrans ? '#ffffff' : st.bg;
    if (st.ctPlate) {
      g.fillStyle = paintColor(plate);
      roundRectPath(g, cx - pad, cy - pad, cw + pad * 2, cw + pad * 2, Math.min(cw, cw + pad * 2) * 0.22);
      g.fill();
    }
    if (st.center === 'color') {
      g.fillStyle = paintColor(st.ctColor);
      roundRectPath(g, cx, cy, cw, cw, cw * 0.22); g.fill();
    } else if (st.center === 'text') {
      g.fillStyle = paintColor(st.ctColor);
      var txt = String(st.ctText || '');
      var fs = cw * (txt.length > 3 ? 0.34 : txt.length > 2 ? 0.42 : 0.56);
      g.font = '700 ' + fs.toFixed(1) + 'px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // 字多了/字宽超出就缩到放得下为止
      while (g.measureText(txt).width > cw * 0.92 && fs > 6) {
        fs *= 0.9;
        g.font = '700 ' + fs.toFixed(1) + 'px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif';
      }
      g.fillText(txt, W / 2, H / 2 + fs * 0.04);
    } else if (st.center === 'image' && ctImgEl) {
      var iw = ctImgEl.naturalWidth, ih = ctImgEl.naturalHeight;
      var k = Math.min(cw / iw, cw / ih);
      var dw = iw * k, dh = ih * k;
      g.drawImage(ctImgEl, W / 2 - dw / 2, H / 2 - dh / 2, dw, dh);
    }
  }
  function renderTo(canvas, grid, msOverride) {
    var n = grid.__size, ms = msOverride || st.module, q = st.quiet;
    var side = (n + q * 2) * ms;
    canvas.width = side; canvas.height = side;
    var g = canvas.getContext('2d');
    g.clearRect(0, 0, side, side);
    if (!st.bgTrans) {
      g.fillStyle = paintColor(st.bg);
      if (st.radius > 0) { roundRectPath(g, 0, 0, side, side, st.radius); g.fill(); }
      else g.fillRect(0, 0, side, side);
    } else if (st.radius > 0) {
      // 透明背景 + 圆角:把底色裁成圆角再画模块,圆角外保持透明
      g.save();
      roundRectPath(g, 0, 0, side, side, st.radius);
      g.clip();
    }
    g.fillStyle = fgPaint(g, side, side);
    var off = q * ms, y, x, r = st.shapeR;
    var finderStyle = st.finder;
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        if (!grid[y][x]) continue;
        if (finderStyle !== 'auto' && isFinderModule(n, y, x)) continue;
        drawModule(g, off + x * ms, off + y * ms, ms, st.shape, r);
      }
    }
    if (finderStyle !== 'auto') {
      drawFinder(g, off, off, ms, finderStyle);
      drawFinder(g, off + (n - 7) * ms, off, ms, finderStyle);
      drawFinder(g, off, off + (n - 7) * ms, ms, finderStyle);
    }
    drawCenter(g, side, side, n, ms, q);
    if (st.bgTrans && st.radius > 0) g.restore();
    return canvas;
  }

  // ================= 可扫性自检 =================
  // 中心填充会真的盖掉数据模块。把被盖住的区域按「浅色」重解一次,
  // 能解回原文才说明这个尺寸/等级组合还能扫。
  function scannable(grid, text) {
    if (st.center === 'none') return true;
    var n = grid.__size;
    var cover = Math.ceil(n * (st.ctRatio + st.ctPad * 2) / 100);
    if (cover <= 0) return true;
    var m = [], y, x;
    for (y = 0; y < n; y++) {
      var row = new Uint8Array(n);
      for (x = 0; x < n; x++) row[x] = grid[y][x];
      m.push(row);
    }
    var c0 = Math.floor((n - cover) / 2), c1 = c0 + cover;
    for (y = Math.max(0, c0); y < Math.min(n, c1); y++) {
      for (x = Math.max(0, c0); x < Math.min(n, c1); x++) m[y][x] = 0;
    }
    m.__size = n;
    try { return QR.decodeMatrix(m).text === text; } catch (e) { return false; }
  }

  // ================= SVG 导出(矢量) =================
  function toSvg(grid) {
    var n = grid.__size, ms = st.module, q = st.quiet, side = (n + q * 2) * ms, off = q * ms;
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + side + '" height="' + side + '" viewBox="0 0 ' + side + ' ' + side + '">'];
    var paint = paintColor(st.fg);
    if (st.grad) {
      var rad = st.gradAng * Math.PI / 180, dx = Math.cos(rad), dy = Math.sin(rad);
      var x1 = (0.5 - dx / 2).toFixed(4), y1 = (0.5 - dy / 2).toFixed(4);
      var x2 = (0.5 + dx / 2).toFixed(4), y2 = (0.5 + dy / 2).toFixed(4);
      out.push('<defs><linearGradient id="g" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '">'
        + '<stop offset="0" stop-color="' + st.fg + '"/><stop offset="1" stop-color="' + st.fg2 + '"/></linearGradient></defs>');
      paint = 'url(#g)';
    }
    if (!st.bgTrans) {
      out.push('<rect width="' + side + '" height="' + side + '"' + (st.radius ? ' rx="' + st.radius + '"' : '') + ' fill="' + st.bg + '"/>');
    }
    var y, x, r = ms * st.shapeR / 100;
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        if (!grid[y][x]) continue;
        if (st.finder !== 'auto' && isFinderModule(n, y, x)) continue;
        var px = off + x * ms, py = off + y * ms;
        if (st.shape === 'dot') out.push('<circle cx="' + (px + ms / 2) + '" cy="' + (py + ms / 2) + '" r="' + ms / 2 + '" fill="' + paint + '"/>');
        else if (st.shape === 'diamond') out.push('<path d="M' + (px + ms / 2) + ' ' + py + 'L' + (px + ms) + ' ' + (py + ms / 2) + 'L' + (px + ms / 2) + ' ' + (py + ms) + 'L' + px + ' ' + (py + ms / 2) + 'Z" fill="' + paint + '"/>');
        else out.push('<rect x="' + px + '" y="' + py + '" width="' + ms + '" height="' + ms + '"' + (st.shape === 'round' ? ' rx="' + r.toFixed(2) + '"' : '') + ' fill="' + paint + '"/>');
      }
    }
    if (st.finder !== 'auto') {
      var trio = [[off, off], [off + (n - 7) * ms, off], [off, off + (n - 7) * ms]];
      for (var i = 0; i < 3; i++) {
        var fx = trio[i][0], fy = trio[i][1], o7 = ms * 7, o5 = ms * 5, o3 = ms * 3;
        if (st.finder === 'dot') {
          out.push('<circle cx="' + (fx + o7 / 2) + '" cy="' + (fy + o7 / 2) + '" r="' + (o7 - ms) / 2 + '" fill="none" stroke="' + paint + '" stroke-width="' + ms + '"/>');
          out.push('<circle cx="' + (fx + o7 / 2) + '" cy="' + (fy + o7 / 2) + '" r="' + o3 / 2 + '" fill="' + paint + '"/>');
        } else {
          var rr = ms * 2, ir = Math.max(0, rr - ms);
          out.push('<path fill-rule="evenodd" fill="' + paint + '" d="M' + (fx + rr) + ' ' + fy + 'H' + (fx + o7 - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + (fx + o7) + ' ' + (fy + rr) + 'V' + (fy + o7 - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + (fx + o7 - rr) + ' ' + (fy + o7) + 'H' + (fx + rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + fx + ' ' + (fy + o7 - rr) + 'V' + (fy + rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + (fx + rr) + ' ' + fy + 'Z'
            + 'M' + (fx + ms + ir) + ' ' + (fy + ms) + 'H' + (fx + ms + o5 - ir) + 'A' + ir + ' ' + ir + ' 0 0 1 ' + (fx + ms + o5) + ' ' + (fy + ms + ir) + 'V' + (fy + ms + o5 - ir) + 'A' + ir + ' ' + ir + ' 0 0 1 ' + (fx + ms + o5 - ir) + ' ' + (fy + ms + o5) + 'H' + (fx + ms + ir) + 'A' + ir + ' ' + ir + ' 0 0 1 ' + (fx + ms) + ' ' + (fy + ms + o5 - ir) + 'V' + (fy + ms + ir) + 'A' + ir + ' ' + ir + ' 0 0 1 ' + (fx + ms + ir) + ' ' + (fy + ms) + 'Z"/>');
          out.push('<rect x="' + (fx + ms * 2) + '" y="' + (fy + ms * 2) + '" width="' + o3 + '" height="' + o3 + '" rx="' + (ms * 0.6).toFixed(2) + '" fill="' + paint + '"/>');
        }
      }
    }
    if (st.center !== 'none') {
      var span = n * ms, cw = span * st.ctRatio / 100;
      var cx = (side - cw) / 2, cy = (side - cw) / 2, pad = cw * st.ctPad / 100;
      if (st.ctPlate) out.push('<rect x="' + (cx - pad) + '" y="' + (cy - pad) + '" width="' + (cw + pad * 2) + '" height="' + (cw + pad * 2) + '" rx="' + ((cw) * 0.22).toFixed(2) + '" fill="' + (st.bgTrans ? '#ffffff' : st.bg) + '"/>');
      if (st.center === 'color') out.push('<rect x="' + cx + '" y="' + cy + '" width="' + cw + '" height="' + cw + '" rx="' + (cw * 0.22).toFixed(2) + '" fill="' + st.ctColor + '"/>');
      else if (st.center === 'text') {
        var fs2 = cw * (String(st.ctText).length > 2 ? 0.42 : 0.56);
        out.push('<text x="' + (side / 2) + '" y="' + (side / 2) + '" fill="' + st.ctColor + '" font-size="' + fs2.toFixed(1)
          + '" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif">' + OC.esc(st.ctText) + '</text>');
      } else if (st.center === 'image' && st.ctImg) {
        out.push('<image x="' + cx + '" y="' + cy + '" width="' + cw + '" height="' + cw + '" href="' + st.ctImg + '" preserveAspectRatio="xMidYMid meet"/>');
      }
    }
    out.push('</svg>');
    return out.join('');
  }

  // ================= 列表渲染 =================
  function buildItemEl(it, idx) {
    var el = document.createElement('div');
    el.className = 'qr-it';
    var thumb = document.createElement('div');
    thumb.className = 'qr-thumb';
    var canvas = document.createElement('canvas');
    canvas.title = '右键图片另存为';
    thumb.appendChild(canvas);
    var body = document.createElement('div');
    body.className = 'qr-body';
    body.innerHTML =
      '<p class="qr-txt"></p>'
      + '<div class="qr-meta">'
      + '<span class="tag" data-k="ver"></span>'
      + '<span class="tag" data-k="ec"></span>'
      + '<span class="tag" data-k="size"></span>'
      + '<span class="tag" data-k="scan"></span>'
      + '<span class="qr-sub" data-k="bytes"></span>'
      + '</div>'
      + '<div class="qr-acts">'
      + '<button class="btn xs p" data-a="open">打开图片</button>'
      + '<button class="btn xs" data-a="png">复制图片链接</button>'
      + '<button class="btn xs" data-a="svg">复制 SVG</button>'
      + '<button class="btn xs" data-a="txt">复制内容</button>'
      + '</div>';
    el.appendChild(thumb);
    el.appendChild(body);
    el.querySelector('.qr-txt').textContent = (idx + 1) + '. ' + it.text;
    if (it.error) {
      el.querySelector('[data-k=ver]').textContent = '编码失败';
      el.querySelector('[data-k=ver]').className = 'tag bad';
      el.querySelector('.qr-txt').textContent = (idx + 1) + '. ' + it.text + ' —— ' + it.error;
      return el;
    }
    var g = it.grid;
    var upd = function (ms) { renderTo(canvas, g, ms); };
    upd(thumbModule(g.__size, st.quiet));
    el.querySelector('[data-k=ver]').textContent = '版本 ' + g.__ver + ' · ' + g.__size + '×' + g.__size;
    el.querySelector('[data-k=ec]').textContent = st.ec + ' 级纠错';
    el.querySelector('[data-k=size]').textContent = st.module + 'px/模块';
    var scanEl = el.querySelector('[data-k=scan]');
    var okScan = scannable(g, it.text);
    scanEl.textContent = okScan ? '可扫 ✓' : '可能扫不出';
    scanEl.className = 'tag ' + (okScan ? 'ok' : 'bad');
    scanEl.title = okScan ? '中心填充后仍能解回原文' : '中心填充盖掉了太多数据模块,提高纠错等级或缩小填充';
    el.querySelector('[data-k=bytes]').textContent = it.text.length + ' 字 / ' + utf8Len(it.text) + ' 字节';
    it.canvas = canvas; it.el = el;
    el.querySelector('[data-a=open]').addEventListener('click', function () {
      var c = document.createElement('canvas');
      renderTo(c, g, st.module);
      OC.canvasToBlob(c).then(function (b) { OC.openBlob(b); }, function () { OC.toast('导出失败', 'bad'); });
    });
    el.querySelector('[data-a=png]').addEventListener('click', function () {
      var c = document.createElement('canvas');
      renderTo(c, g, st.module);
      OC.copy(c.toDataURL('image/png'), '图片链接已复制,可直接粘进 img 标签');
    });
    el.querySelector('[data-a=svg]').addEventListener('click', function () { OC.copy(toSvg(g), 'SVG 已复制'); });
    el.querySelector('[data-a=txt]').addEventListener('click', function () { OC.copy(it.text, '内容已复制'); });
    return el;
  }

  function renderList() {
    var list = $('#qr-list');
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="empty">上面填好内容,这里会逐个显示二维码</div>';
      return;
    }
    if (items.length > 60) {
      var w = document.createElement('div');
      w.className = 'msg warn';
      w.textContent = '条目较多(' + items.length + ' 条),只显示前 60 条 —— 清单内容仍然都会生成。';
      list.appendChild(w);
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < Math.min(items.length, 60); i++) frag.appendChild(buildItemEl(items[i], i));
    list.appendChild(frag);
  }

  function updateStats() {
    var n = readItems().length;
    $('#qr-count').textContent = n + ' 条';
    var vers = {}, bytes = 0, bad = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].error) { bad++; continue; }
      vers[items[i].grid.__ver] = (vers[items[i].grid.__ver] || 0) + 1;
      bytes += items[i].text.length;
    }
    var vs = Object.keys(vers).sort(function (a, b) { return a - b; });
    var html = '<div class="stat"><div class="k">条数</div><div class="v">' + n + '</div></div>'
      + '<div class="stat"><div class="k">字符</div><div class="v">' + bytes + '</div></div>'
      + '<div class="stat"><div class="k">纠错</div><div class="v">' + st.ec + '</div></div>';
    if (vs.length) html += '<div class="stat"><div class="k">用到的版本</div><div class="v">' + vs.join(' / ') + '</div></div>';
    if (bad) html += '<div class="stat"><div class="k">编码失败</div><div class="v">' + bad + '</div></div>';
    $('#qr-stats').innerHTML = html;
  }

  function generate() {
    collect();
    syncVisibility();
    var texts = readItems();
    items = [];
    for (var i = 0; i < texts.length; i++) {
      try { items.push({ text: texts[i], grid: encodeOne(texts[i]) }); }
      catch (e) { items.push({ text: texts[i], error: e.message || String(e) }); }
    }
    renderList();
    updateStats();
    if (texts.length > 60) OC.say('#qr-out-msg', '已生成 ' + texts.length + ' 条(页面显示前 60 条)', 'warn');
    else OC.say('#qr-out-msg', texts.length ? '已生成 ' + texts.length + ' 条' : '', texts.length ? 'ok' : '');
  }
  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function live() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(generate, 140);
  }

  // ================= 识别 =================
  var DEC_SCALE = 2200;
  function canvasFromImage(img, scale) {
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    return { canvas: c, g: g, w: w, h: h };
  }
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片读不出来')); };
      img.src = url;
    });
  }
  var bdSupported = null;
  function detectorAvailable() {
    if (bdSupported === null) bdSupported = typeof window.BarcodeDetector === 'function';
    return bdSupported;
  }
  function tryDetect(canvas) {
    return new Promise(function (res, rej) {
      if (!detectorAvailable()) { rej(new Error('当前环境没有系统识别能力')); return; }
      var det;
      try { det = new window.BarcodeDetector({ formats: ['qr_code'] }); }
      catch (e) { rej(e); return; }
      det.detect(canvas).then(function (r) {
        if (r && r.length) res({ text: r[0].rawValue, engine: '系统识别' });
        else rej(new Error('系统识别没有找到二维码'));
      }, function (e) { rej(e || new Error('系统识别失败')); });
    });
  }
  function tryBuiltin(b) {
    var data = b.g.getImageData(0, 0, b.w, b.h);
    var out = QR.decodeImage(data, b.w, b.h);
    return { text: out.text, engine: '内置解码', version: out.version, level: out.level, rotation: out.rotation };
  }
  // 照片远近差别很大:先按原尺寸(必要时缩到 2200px 内),再换几个尺度重试。
  // 系统识别(BarcodeDetector)只在 https/localhost 下可用,不可用或没找到时落到内置解码。
  function decodeOne(img) {
    var base = Math.min(1, DEC_SCALE / Math.max(img.naturalWidth, img.naturalHeight));
    var scales = [base, base * 0.55, base * 0.35, base * 1.6];
    var i = 0, lastErr = null;
    function next() {
      if (i >= scales.length) return Promise.reject(lastErr || new Error('没能识别出二维码'));
      var sc = scales[i++];
      if (!(sc > 0.02)) return next();
      var b = canvasFromImage(img, sc);
      return tryDetect(b.canvas).catch(function () {
        var got;
        try { got = tryBuiltin(b); }
        catch (e) { lastErr = e; return next(); }
        return got;
      });
    }
    return next();
  }
  function addDecRow(name, res, errMsg) {
    var list = $('#qr-dec-list');
    var empty = list.querySelector('.empty');
    if (empty) list.innerHTML = '';
    var row = document.createElement('div');
    row.className = 'qr-dec' + (errMsg ? ' bad' : '');
    var head = document.createElement('div');
    head.className = 'qr-meta';
    var nm = document.createElement('span');
    nm.className = 'qr-sub';
    nm.textContent = name || '剪贴板图片';
    head.appendChild(nm);
    if (errMsg) {
      var t = document.createElement('span');
      t.className = 'tag bad'; t.textContent = '识别失败';
      head.appendChild(t);
      var t2 = document.createElement('span');
      t2.className = 'qr-sub'; t2.textContent = errMsg;
      head.appendChild(t2);
    } else {
      var t3 = document.createElement('span');
      t3.className = 'tag ok'; t3.textContent = res.engine || '已识别';
      head.appendChild(t3);
      if (res.version) {
        var t4 = document.createElement('span');
        t4.className = 'tag';
        t4.textContent = '版本 ' + res.version + (res.level ? ' · ' + res.level + ' 级' : '') + (res.rotation ? ' · 转 ' + res.rotation + '°' : '');
        head.appendChild(t4);
      }
    }
    row.appendChild(head);
    if (!errMsg) {
      var out = document.createElement('p');
      out.className = 'out';
      out.textContent = res.text;
      row.appendChild(out);
      var acts = document.createElement('div');
      acts.className = 'qr-acts';
      var b1 = document.createElement('button');
      b1.className = 'btn xs p'; b1.textContent = '复制内容';
      b1.addEventListener('click', function () { OC.copy(res.text, '内容已复制'); });
      acts.appendChild(b1);
      var b2 = document.createElement('button');
      b2.className = 'btn xs'; b2.textContent = '拿去生成';
      b2.addEventListener('click', function () {
        var ta = $('#qr-text');
        ta.value = ta.value.replace(/\s*$/, '') + (ta.value.trim() ? '\n' : '') + res.text;
        generate();
        OC.toast('已加入内容清单');
      });
      acts.appendChild(b2);
      if (res.text !== (res.text || '').trim()) {
        var b3 = document.createElement('button');
        b3.className = 'btn xs'; b3.textContent = '复制带首尾空白';
        b3.addEventListener('click', function () { OC.copy(res.text, '已按原文复制'); });
        acts.appendChild(b3);
      }
      row.appendChild(acts);
    }
    list.appendChild(row);
    return row;
  }
  var decBusy = 0;
  function decodeFiles(files) {
    var arr = [].slice.call(files || []);
    if (!arr.length) return;
    decBusy += arr.length;
    OC.say('#qr-dec-msg', '正在识别 ' + decBusy + ' 张…');
    var done = 0, okCount = 0, failCount = 0;
    arr.forEach(function (f) {
      if (!/^image\//.test(f.type || '')) {
        addDecRow(f.name, null, '不是图片文件');
        failCount++;
        if (++done === arr.length) finish();
        return;
      }
      loadImage(f).then(function (img) {
        return decodeOne(img);
      }).then(function (res) {
        addDecRow(f.name, res);
        okCount++;
      }, function (e) {
        addDecRow(f.name, null, (e && e.message) || '识别失败');
        failCount++;
      }).then(function () {
        if (++done === arr.length) finish();
      });
    });
    function finish() {
      decBusy = Math.max(0, decBusy - arr.length);
      OC.say('#qr-dec-msg', '成功 ' + okCount + ' 张' + (failCount ? ',失败 ' + failCount + ' 张' : ''), failCount ? 'warn' : 'ok');
      OC.toast('识别完成:成功 ' + okCount + ' 张' + (failCount ? ',失败 ' + failCount + ' 张' : ''), failCount ? 'bad' : '');
    }
  }

  // ================= 事件接线 =================
  function wire() {
    OC.enhanceSelects(document);
    OC.seg('#qr-ec', live);
    OC.seg('#qr-shape', function () { syncVisibility(); live(); });
    OC.seg('#qr-finder', live);
    OC.seg('#qr-center', function () { syncVisibility(); live(); });
    OC.range('#qr-ms', live);
    OC.range('#qr-qz', live);
    OC.range('#qr-shape-r', live);
    OC.range('#qr-grad-ang', live);
    OC.range('#qr-rad', live);
    OC.range('#qr-ct-r', live);
    OC.range('#qr-ct-pad', live);

    bindColor('#qr-fg', '#qr-fg-c', 'fg');
    bindColor('#qr-bg', '#qr-bg-c', 'bg');
    bindColor('#qr-fg2', '#qr-fg2-c', 'fg2');
    bindColor('#qr-ct-color', '#qr-ct-color-c', 'ctColor');

    $('#qr-grad').addEventListener('change', function () { st.grad = this.checked; syncVisibility(); live(); });
    $('#qr-bg-trans').addEventListener('change', function () { st.bgTrans = this.checked; live(); });
    $('#qr-ct-plate').addEventListener('change', function () { st.ctPlate = this.checked; live(); });
    $('#qr-ct-text').addEventListener('input', live);

    $('#qr-text').addEventListener('input', live);
    $('#qr-trim').addEventListener('change', live);
    $('#qr-dedupe').addEventListener('change', live);
    $('#qr-gen').addEventListener('click', generate);
    $('#qr-clear').addEventListener('click', function () { $('#qr-text').value = ''; generate(); $('#qr-text').focus(); });

    $('#qr-preset').addEventListener('change', function () { applyPreset(this.value); generate(); });

    $('#qr-tpl').addEventListener('change', function () {
      var v = this.value;
      this.value = '';
      var ta = $('#qr-text');
      var tpl = TEMPLATES[v];
      if (!tpl) return;
      var cur = ta.value.replace(/\s+$/, '');
      ta.value = (cur ? cur + '\n' : '') + tpl;
      ta.focus();
      generate();
      OC.toast('模板已填入,替换占位内容即可');
    });

    $('#qr-demo').addEventListener('click', function () {
      var ta = $('#qr-text');
      ta.value = [
        'https://example.com',
        'https://example.com/order/20260101-0001',
        'WIFI:T:WPA;S:MyHome;P:12345678;;',
        '你好,二维码',
      ].join('\n');
      generate();
    });

    // 中心图片
    var dropZone = $('#qr-ct-drop');
    OC.drop(dropZone, function (files) {
      var f = files[0];
      if (!f || !/^image\//.test(f.type || '')) { OC.toast('请选择图片文件', 'bad'); return; }
      var fr = new FileReader();
      fr.onload = function () {
        st.ctImg = fr.result;
        var img = new Image();
        img.onload = function () {
          ctImgEl = img;
          OC.segSet('#qr-center', 'image');
          st.center = 'image';
          syncVisibility();
          generate();
          OC.toast('图片已作为中心填充');
        };
        img.onerror = function () { OC.toast('这张图片读不出来', 'bad'); };
        img.src = fr.result;
      };
      fr.readAsDataURL(f);
    }, { accept: 'image/*' });

    // 批量导出
    $('#qr-open-all').addEventListener('click', function () {
      var ok = items.filter(function (it) { return !it.error; });
      if (!ok.length) { OC.toast('还没有可导出的二维码', 'bad'); return; }
      var n = Math.min(ok.length, 20);
      if (ok.length > 20 && !window.confirm('一次打开 20 个标签页,浏览器可能会拦掉后面的,继续吗?')) return;
      if (!window.confirm('将在新标签页里逐个打开 ' + n + ' 张原图;保存请在新标签页里按 Ctrl+S 或右键另存为。继续?')) return;
      (function step(i) {
        if (i >= n) { OC.toast('已打开 ' + n + ' 张'); return; }
        var c = document.createElement('canvas');
        renderTo(c, ok[i].grid, st.module);
        c.toBlob(function (b) {
          OC.openBlob(b);
          setTimeout(function () { step(i + 1); }, 420);
        }, 'image/png');
      })(0);
    });
    $('#qr-copy-all').addEventListener('click', function () {
      var ok = items.filter(function (it) { return !it.error; });
      if (!ok.length) { OC.toast('还没有可复制的二维码', 'bad'); return; }
      var n = Math.min(ok.length, 20);
      var lines = [];
      for (var i = 0; i < n; i++) {
        var c = document.createElement('canvas');
        renderTo(c, ok[i].grid, st.module);
        lines.push(ok[i].text + '\n' + c.toDataURL('image/png'));
      }
      OC.copy(lines.join('\n\n'), '已复制 ' + n + ' 条图片链接(每行:内容 + DataURL)');
    });

    // 识别:拖放 / 点选 / 粘贴
    OC.drop('#qr-drop', function (files) { decodeFiles(files); }, { multiple: true, accept: 'image/*' });
    document.addEventListener('paste', function (e) {
      var its = (e.clipboardData && e.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < its.length; i++) {
        if (its[i].kind === 'file') {
          var f = its[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); decodeFiles(files); }
    });
    $('#qr-dec-clear').addEventListener('click', function () {
      $('#qr-dec-list').innerHTML = '<div class="empty">识别结果会显示在这里</div>';
      OC.say('#qr-dec-msg', '');
    });
  }

  var TEMPLATES = {
    url: 'https://example.com',
    text: '这里写任意文本',
    wifi: 'WIFI:T:WPA;S:网络名称;P:密码;H:false;;',
    vcard: 'BEGIN:VCARD\nVERSION:3.0\nN:姓;名\nFN:显示名\nORG:公司\nTITLE:职位\nTEL;TYPE=CELL:13800138000\nEMAIL:someone@example.com\nURL:https://example.com\nEND:VCARD',
    tel: 'tel:13800138000',
    sms: 'SMSTO:13800138000:短信内容',
    mail: 'MATMSG:TO:someone@example.com;SUB:主题;BODY:正文;;',
    geo: 'geo:39.9042,116.4074',
    event: 'BEGIN:VEVENT\nSUMMARY:会议主题\nLOCATION:会议室\nDTSTART:20260101T100000\nDTEND:20260101T113000\nEND:VEVENT',
  };

  // 初始化:先按预设摆好控件,再放一个示例
  wire();
  applyPreset('ink');
  syncVisibility();
  $('#qr-text').value = 'https://example.com\nTinyChat 在线工具箱\n你好,二维码';
  generate();
})();
TCQR_JS;

return array(
    'id' => 'qrcode',
    'cat' => 'qr',
    'title' => '批量二维码生成与识别',
    'body' => $body,
    'script' => $script,
);
