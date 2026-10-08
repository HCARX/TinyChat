<?php
/**
 * 工具:JWT 解析与校验。
 *
 * 纯前端实现,只用 web 标准 API,不引任何库:
 *   - 解析:按 '.' 拆三段,base64url 解码后 UTF-8 还原,header / payload 各自 JSON 美化,
 *     并对 iss / sub / aud / exp / nbf / iat / jti 给出中文解释与「已过期 / 还剩多久」状态。
 *   - 校验:HS 系列走 crypto.subtle.importKey('raw') + verify('HMAC');RS 系列把 PEM 里的
 *     公钥体(base64)解成 DER,importKey('spki') 后 verify。密钥只在本页内存里参与运算,
 *     不发往任何地方;页面在沙箱里,crypto.subtle 只有安全上下文才有,所以 HS256 另备了一份
 *     纯 JS 的 SHA-256 + HMAC 降级实现(见 sha256 / hmacSha256),RS 系列在非安全上下文会明确提示。
 *   - 生成:header / payload 两个 JSON 文本框 + 算法分段控件 + 密钥,用 subtle 签(或降级 HMAC),
 *     base64url 一律按 UTF-8 字节编码,所以 payload 里的中文不会乱码。
 *
 * 说明:这是本工具唯一的一份实现,全部逻辑都在下面的 nowdoc 里;正文没有任何 <script 字面量,
 * 页面装配器统一注入运行时与本脚本。
 */
$body = <<<'TCJWT_BODY'
<div class="hd">
  <div class="grow">
    <h1>JWT 解析与校验</h1>
    <div class="sub">粘贴 token 即可拆出 header / payload、用中文解释常见声明并显示过期状态;能校验 HS / RS 签名,也能现场生成新的 token。全部在本页完成,密钥不会离开这个页面。</div>
  </div>
  <div class="acts">
    <button class="btn" id="jwt-demo">填入示例(已过期)</button>
    <button class="btn accent" id="jwt-parse">解析</button>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>Token 输入</h2>
    <span class="grow"></span>
    <span class="msg" id="jwt-len"></span>
    <label class="row" style="gap:6px"><input type="checkbox" id="jwt-loose"> 宽松模式(标准 base64)</label>
    <button class="btn sm ghost" id="jwt-paste">从剪贴板粘贴</button>
    <button class="btn sm ghost" id="jwt-clear">清空</button>
  </div>
  <textarea id="jwt-in" class="wrap" spellcheck="false" placeholder="粘贴 JWT,例如 eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...&#10;允许带 Bearer 前缀,也允许中间有换行。"></textarea>
  <div class="f mt" id="jwt-notes"></div>
  <div class="row mt"><span class="msg" id="jwt-in-msg"></span></div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>Header</h2>
      <span class="grow"></span>
      <button class="btn sm" id="jwt-copy-head">复制</button>
    </div>
    <div class="code" id="jwt-head">—</div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>Payload</h2>
      <span class="grow"></span>
      <button class="btn sm" id="jwt-copy-pay">复制</button>
    </div>
    <div class="code" id="jwt-pay">—</div>
  </div>

  <div class="card span2">
    <div class="card-h">
      <h2>声明解读</h2>
      <span class="grow"></span>
      <span class="msg" id="jwt-claim-msg"></span>
      <button class="btn sm" id="jwt-copy-all">复制完整解析结果</button>
    </div>
    <div class="stats" id="jwt-stats"></div>
    <div id="jwt-claims" class="mt"><div class="empty">解析后这里会逐条解释 iss / sub / aud / exp / nbf / iat / jti</div></div>
  </div>

  <div class="card span2">
    <div class="card-h">
      <h2>签名段</h2>
      <span class="grow"></span>
      <span class="msg" id="jwt-sig-meta"></span>
      <button class="btn sm" id="jwt-copy-sig">复制签名段</button>
    </div>
    <div class="code brk" id="jwt-sig">—</div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>签名校验</h2>
    <span class="grow"></span>
    <span class="tag" id="jwt-alg-tag">—</span>
    <span class="msg" id="jwt-v-msg"></span>
    <button class="btn sm p" id="jwt-verify">校验签名</button>
  </div>
  <div class="cols">
    <div class="f">
      <span class="lab">密钥 / 公钥</span>
      <textarea id="jwt-key" class="wrap mono" spellcheck="false" placeholder="HS256/384/512:填密钥文本,例如 secret"></textarea>
      <span class="msg">RS256/384/512:改成粘贴 PEM 公钥,带不带 -----BEGIN/END----- 头尾、有没有换行都能识别。</span>
    </div>
    <div class="f">
      <span class="lab">或拖入 PEM 公钥文件</span>
      <div class="drop" id="jwt-key-drop">
        <b>拖入或点击选择公钥文件</b>
        <span class="hint">.pem / .key / .pub / .txt,按纯文本读入到左侧输入框</span>
      </div>
      <div class="msg" id="jwt-key-info"></div>
    </div>
  </div>
  <div class="msg mt" id="jwt-v-note">密钥只在本页内存里参与签名校验,不会离开这个页面,也不会被保存或发送到任何服务器。页面本身运行在沙箱里,关掉标签页即消失。</div>
</div>

<div class="card">
  <div class="card-h">
    <h2>生成 token</h2>
    <span class="grow"></span>
    <span class="msg" id="jwt-g-msg"></span>
    <button class="btn sm accent" id="jwt-g-run">生成</button>
  </div>
  <div class="cols">
    <div class="f">
      <span class="lab">算法</span>
      <div class="seg" id="jwt-alg">
        <button class="seg-btn on" data-v="HS256">HS256</button>
        <button class="seg-btn" data-v="HS384">HS384</button>
        <button class="seg-btn" data-v="HS512">HS512</button>
      </div>
      <span class="lab">kid(可选,写入 header)</span>
      <input type="text" id="jwt-kid" class="mono" spellcheck="false" placeholder="key-1">
    </div>
    <div class="f">
      <span class="lab">签名密钥</span>
      <input type="text" id="jwt-g-key" class="mono" spellcheck="false" value="secret">
      <span class="msg">生成与校验都只在本页内存里进行,密钥不会离开这个页面。</span>
    </div>
    <div class="f">
      <span class="lab">Header(JSON,可直接编辑)</span>
      <textarea id="jwt-g-head" class="wrap mono" spellcheck="false"></textarea>
    </div>
    <div class="f">
      <span class="lab">Payload(JSON,支持中文等非 ASCII 字符)</span>
      <textarea id="jwt-g-pay" class="wrap mono" spellcheck="false"></textarea>
    </div>
  </div>
  <div class="f mt">
    <span class="lab">生成的 token</span>
    <div class="code brk" id="jwt-g-out">—</div>
    <div class="row">
      <button class="btn sm p" id="jwt-g-copy">复制 token</button>
      <button class="btn sm" id="jwt-g-use">拿去解析与校验</button>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>base64url 小工具</h2>
    <span class="grow"></span>
    <div class="seg" id="jwt-b64mode">
      <button class="seg-btn on" data-v="dec">base64url → 文本</button>
      <button class="seg-btn" data-v="enc">文本 → base64url</button>
    </div>
  </div>
  <div class="cols">
    <div class="f">
      <span class="lab">输入</span>
      <textarea id="jwt-b64-in" class="wrap mono" spellcheck="false" placeholder="粘贴一段 base64url,或一段要编码的文本"></textarea>
    </div>
    <div class="f">
      <span class="lab">输出</span>
      <div class="code brk" id="jwt-b64-out">—</div>
      <div class="row"><button class="btn sm" id="jwt-b64-copy">复制输出</button></div>
    </div>
  </div>
  <div class="msg mt" id="jwt-b64-msg">解码按 UTF-8 还原;编码输出不带 = 填充的标准 base64url。上方的「宽松模式」对这里同样生效。</div>
</div>

<div class="card">
  <div class="card-h"><h2>常见问题</h2></div>
  <div class="cols tight">
    <div class="f">
      <span class="lab">段数不对</span>
      <span class="msg">标准 JWT 是 header.payload.signature 三段。只有两段通常是被截断了;五段是 JWE(内容加密),本工具只处理 JWS。</span>
    </div>
    <div class="f">
      <span class="lab">解出来不是 JSON</span>
      <span class="msg">说明 token 不是标准 JWS,或者复制时混进了别的内容。此时会把解出的原始文本照原样显示,便于判断。</span>
    </div>
    <div class="f">
      <span class="lab">alg: none</span>
      <span class="msg">alg 为 none 表示没有签名,任何人都能改 payload 后照样通过解析,属于不安全 token,不要拿它做鉴权依据。</span>
    </div>
    <div class="f">
      <span class="lab">payload 里没有 exp</span>
      <span class="msg">没有 exp 的 token 不会自动过期,一旦泄露就一直有效,服务端一般也会拒绝这种 token。</span>
    </div>
    <div class="f">
      <span class="lab">签名不匹配</span>
      <span class="msg">常见原因:密钥不对、算法与密钥类型不匹配(HS 用了公钥 / RS 用了对称密钥)、token 在复制时被改动过。</span>
    </div>
    <div class="f">
      <span class="lab">时间对不上</span>
      <span class="msg">exp / nbf / iat 都是 UTC 秒级时间戳,这里换算成本地时间显示;若本机时钟不准,过期判断也会偏。</span>
    </div>
  </div>
</div>
TCJWT_BODY;

$script = <<<'TCJWT_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ================= 算法表 =================
  var ALGS = {
    HS256: { rs: false, params: { name: 'HMAC', hash: 'SHA-256' } },
    HS384: { rs: false, params: { name: 'HMAC', hash: 'SHA-384' } },
    HS512: { rs: false, params: { name: 'HMAC', hash: 'SHA-512' } },
    RS256: { rs: true, params: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } },
    RS384: { rs: true, params: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' } },
    RS512: { rs: true, params: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' } }
  };
  var CLAIMS = [
    ['iss', '签发者 (Issuer)', '谁签发了这个 token,通常是应用名或域名。'],
    ['sub', '主体 (Subject)', '这个 token 代表谁,一般是用户 ID。'],
    ['aud', '受众 (Audience)', '这个 token 是给谁用的;校验方对不上就可能拒绝。'],
    ['exp', '过期时间 (Expiration)', '到这个时间之后 token 失效,比当前时间早就是已过期。'],
    ['nbf', '生效时间 (Not Before)', '早于这个时间 token 还不能用。'],
    ['iat', '签发时间 (Issued At)', 'token 是什么时候签发的。'],
    ['jti', '编号 (JWT ID)', 'token 的唯一标识,常用于防重放。']
  ];
  var TIME_CLAIMS = { exp: 1, nbf: 1, iat: 1 };
  var DEMO_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0b29sYm94LWRlbW8iLCJzdWIiOiIxMjM0NTY3ODkwIiwiYXVkIjoib3BlbmFpLWNoYXQiLCJuYW1lIjoi56S65L6L55So5oi3Iiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzM1Njg5NjAwLCJuYmYiOjE3MzU2ODk2MDAsImV4cCI6MTczNTc3NjAwMCwianRpIjoiZGVtby0yMDI1LTAxLTAxIn0.Tq5zEoT17DpU3a0T1njv78toXiLRPGGWSlL0B1tgJPA';
  var MAX_LEN = 300000;

  var last = null;          // 当前解析结果
  var lastToken = '';       // 当前生成的 token
  var parseTimer = 0, gTimer = 0, vTimer = 0, verifySeq = 0;

  // ================= 基础工具 =================
  function hasSubtle() { return !!(window.crypto && window.crypto.subtle); }
  function errText(e) { return (e && e.message) ? e.message : String(e || '未知错误'); }
  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function utf8Bytes(s) {
    var out = [], i, c;
    s = String(s == null ? '' : s);
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
  function asciiBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }
  // bytes → 不带 = 填充的 base64url
  function b64u(bytes) {
    var bin = '', i;
    for (i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // base64url / base64 → bytes;宽松模式开关决定是否接受 +、/、=
  function decodeSeg(raw, label) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, '');
    if (!s) return { ok: true, bytes: new Uint8Array(0), text: '', loose: false, why: '' };
    var nonStd = '';
    if (/[+/=]/.test(s)) nonStd = '检测到 +、/ 或 = 填充';
    else if (!/^[A-Za-z0-9_-]*$/.test(s)) nonStd = '含有 base64 之外的字符';
    var norm = s.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/=]*$/.test(norm)) {
      return { ok: false, err: label + '里出现了非法字符,不是 base64 也不是 base64url' };
    }
    var body = norm.replace(/=+$/, '');
    if (body.length % 4 === 1) return { ok: false, err: label + '的 base64 长度不合法(差了 1 个字符)' };
    while (body.length % 4) body += '=';
    if (nonStd && !$('#jwt-loose').checked) {
      return { ok: false, err: label + '不是标准 base64url(' + nonStd + ');勾选上方的「宽松模式」即可按标准 base64 解码' };
    }
    var bin;
    try { bin = atob(body); } catch (e) { return { ok: false, err: label + '不是合法的 base64' }; }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ok: true, bytes: bytes, text: utf8Decode(bytes), loose: !!nonStd, why: nonStd };
  }

  // ---- 纯 JS 降级:非安全上下文没有 crypto.subtle 时,HS256 用它兜底 ----
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length;
    var total = ((l + 9 + 63) >> 6) << 6;
    var m = new Uint8Array(total);
    m.set(bytes, 0);
    m[l] = 0x80;
    var bits = l * 8;
    var hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
    m[total - 8] = (hi >>> 24) & 255; m[total - 7] = (hi >>> 16) & 255; m[total - 6] = (hi >>> 8) & 255; m[total - 5] = hi & 255;
    m[total - 4] = (lo >>> 24) & 255; m[total - 3] = (lo >>> 16) & 255; m[total - 2] = (lo >>> 8) & 255; m[total - 1] = lo & 255;
    var w = new Int32Array(64), i, t;
    for (i = 0; i < total; i += 64) {
      for (t = 0; t < 16; t++) w[t] = (m[i + t * 4] << 24) | (m[i + t * 4 + 1] << 16) | (m[i + t * 4 + 2] << 8) | m[i + t * 4 + 3];
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 255; out[i * 4 + 1] = (H[i] >>> 16) & 255;
      out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255;
    }
    return out;
  }
  function hmacSha256(keyBytes, msgBytes) {
    var block = 64, k = keyBytes;
    if (k.length > block) k = sha256(k);
    var ip = new Uint8Array(block), op = new Uint8Array(block);
    for (var i = 0; i < block; i++) {
      var kb = i < k.length ? k[i] : 0;
      ip[i] = kb ^ 0x36; op[i] = kb ^ 0x5c;
    }
    var inner = new Uint8Array(block + msgBytes.length);
    inner.set(ip, 0); inner.set(msgBytes, block);
    var ih = sha256(inner);
    var outer = new Uint8Array(block + 32);
    outer.set(op, 0); outer.set(ih, block);
    return sha256(outer);
  }
  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  // PEM → DER 字节。带不带 BEGIN/END 头尾、有没有换行都能吃下。
  function pemToBytes(pem) {
    var s = String(pem == null ? '' : pem).replace(/\r/g, '').replace(/^\uFEFF/, '');
    var label = '', body = '';
    var m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(s);
    if (m) { label = trim(m[1]); body = m[2]; }
    else { label = ''; body = s; }
    body = body.replace(/\s+/g, '');
    if (!body) throw new Error('公钥内容为空');
    if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error('公钥里出现了 base64 之外的字符');
    var core = body.replace(/=+$/, '');
    if (core.length % 4 === 1) throw new Error('公钥 base64 长度不合法');
    while (core.length % 4) core += '=';
    var bin;
    try { bin = atob(core); } catch (e) { throw new Error('公钥不是合法的 base64'); }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) throw new Error('公钥内容为空');
    return { label: label, bytes: bytes };
  }

  // ================= 时间与文本 =================
  function fmtTime(sec) {
    var n = Number(sec);
    if (!isFinite(n)) return null;
    var d = new Date(n * 1000);
    if (isNaN(d.getTime())) return null;
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
    return d.getFullYear() + '-' + OC.p2(d.getMonth() + 1) + '-' + OC.p2(d.getDate()) + ' '
      + OC.p2(d.getHours()) + ':' + OC.p2(d.getMinutes()) + ':' + OC.p2(d.getSeconds())
      + ' (UTC' + sign + oh + (om ? ':' + OC.p2(om) : '') + ')';
  }
  function humanDur(ms) {
    var s = Math.floor(Math.abs(ms) / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return m + ' 分钟' + (rs ? ' ' + rs + ' 秒' : '');
    var h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return h + ' 小时' + (rm ? ' ' + rm + ' 分钟' : '');
    var d = Math.floor(h / 24), rh = h % 24;
    return d + ' 天' + (rh ? ' ' + rh + ' 小时' : '');
  }
  function pretty(v) {
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function valueHtml(val) {
    if (val === null) return '<span class="mono">null</span>';
    if (typeof val === 'string') return '<span class="mono brk">' + OC.esc(val) + '</span>';
    if (typeof val === 'object') return '<span class="mono brk">' + OC.esc(JSON.stringify(val)) + '</span>';
    return '<span class="mono">' + OC.esc(String(val)) + '</span>';
  }
  function isNum(v) { return typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(trim(v))); }

  // ================= 解析 =================
  function setNotes(list) {
    var box = $('#jwt-notes');
    box.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      var d = document.createElement('div');
      d.className = 'msg ' + (list[i].kind || '');
      d.textContent = list[i].text;
      box.appendChild(d);
    }
  }
  function resetOutputs() {
    last = null;
    $('#jwt-head').textContent = '—';
    $('#jwt-pay').textContent = '—';
    $('#jwt-sig').textContent = '—';
    $('#jwt-stats').innerHTML = '';
    $('#jwt-claims').innerHTML = '<div class="empty">解析后这里会逐条解释 iss / sub / aud / exp / nbf / iat / jti</div>';
    $('#jwt-claim-msg').textContent = '';
    $('#jwt-sig-meta').textContent = '';
    $('#jwt-alg-tag').textContent = '—';
    $('#jwt-alg-tag').className = 'tag';
    OC.say('#jwt-v-msg', '');
    $('#jwt-len').textContent = '';
  }

  function claimRowHtml(name, label, val, desc) {
    var nameHtml = '<span class="mono">' + OC.esc(name) + '</span>'
      + (label ? '<br><span class="msg">' + OC.esc(label) + '</span>' : '');
    var valHtml, statusHtml = '';
    if (TIME_CLAIMS[name] && isNum(val)) {
      var sec = Number(val), t = fmtTime(sec), now = Date.now() / 1000;
      valHtml = '<span class="mono">' + OC.esc(String(val)) + '</span>'
        + (t ? '<br><span class="mono">' + OC.esc(t) + '</span>' : '');
      if (!t) statusHtml = '<span class="tag bad">时间无效</span>';
      else if (name === 'exp') {
        statusHtml = now > sec
          ? '<span class="tag bad">已过期 ' + humanDur((now - sec) * 1000) + '</span>'
          : '<span class="tag ok">还有 ' + humanDur((sec - now) * 1000) + ' 过期</span>';
      } else if (name === 'nbf') {
        statusHtml = now < sec
          ? '<span class="tag bad">还有 ' + humanDur((sec - now) * 1000) + ' 才生效</span>'
          : '<span class="tag ok">已生效</span>';
      } else {
        statusHtml = now < sec
          ? '<span class="tag bad">签发时间在未来</span>'
          : '<span class="tag">' + humanDur((now - sec) * 1000) + '前签发</span>';
      }
    } else {
      valHtml = valueHtml(val);
    }
    return '<tr><td>' + nameHtml + '</td><td class="brk">' + valHtml + '</td><td class="msg">' + OC.esc(desc) + '</td><td>' + statusHtml + '</td></tr>';
  }

  function claimsTable(payObj) {
    var rows = '', seen = {}, i;
    for (i = 0; i < CLAIMS.length; i++) {
      var k = CLAIMS[i][0];
      if (!Object.prototype.hasOwnProperty.call(payObj, k)) continue;
      seen[k] = 1;
      rows += claimRowHtml(k, CLAIMS[i][1], payObj[k], CLAIMS[i][2]);
    }
    var extra = [];
    for (var key in payObj) if (Object.prototype.hasOwnProperty.call(payObj, key) && !seen[key]) extra.push(key);
    extra.sort();
    for (i = 0; i < extra.length; i++) {
      rows += claimRowHtml(extra[i], '', payObj[extra[i]], '本工具没有内置这个声明的解释,按原值展示。');
    }
    if (!rows) return '<div class="empty">这个 payload 里没有可解释的常见声明</div>';
    return '<table><thead><tr><th>声明</th><th>值</th><th>说明</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderStats(segCount, alg, len, status, kind) {
    var h = '<div class="stat"><div class="k">段数</div><div class="v">' + segCount + '</div></div>'
      + '<div class="stat"><div class="k">算法</div><div class="v">' + OC.esc(alg || '—') + '</div></div>'
      + '<div class="stat"><div class="k">长度</div><div class="v">' + len + '</div></div>';
    if (status) h += '<div class="stat"><div class="k">状态</div><div class="v"><span class="tag ' + (kind || '') + '">' + OC.esc(status) + '</span></div></div>';
    $('#jwt-stats').innerHTML = h;
  }

  function parseToken() {
    var raw = $('#jwt-in').value;
    var t = trim(raw);
    if (!t) {
      resetOutputs();
      OC.say('#jwt-in-msg', '等待输入:粘贴一个 JWT 即可实时解析', '');
      setNotes([]);
      return;
    }
    if (t.length > MAX_LEN) {
      resetOutputs();
      OC.say('#jwt-in-msg', 'token 太长(' + t.length + ' 字符,上限 ' + MAX_LEN + '),已停止解析', 'bad');
      setNotes([{ text: '解析大 token 会拖慢页面,请确认没有误粘贴整段日志或文件。', kind: 'warn' }]);
      return;
    }
    var m = /^Bearer\s+(.+)$/i.exec(t);
    if (m) t = trim(m[1]);
    $('#jwt-len').textContent = t.length + ' 字符';

    var segs = t.split('.');
    if (segs.length !== 3) {
      resetOutputs();
      $('#jwt-len').textContent = t.length + ' 字符';
      var why = segs.length === 2
        ? '只有 2 段:标准 JWT 是 header.payload.signature 三段,看起来少了一段(复制时被截断?)'
        : (segs.length === 5
          ? '共有 5 段,这是 JWE(内容加密的 token);本工具只解析 JWS(三段结构)'
          : '共有 ' + segs.length + ' 段,标准 JWT 应为 3 段');
      OC.say('#jwt-in-msg', why, 'bad');
      setNotes([{ text: '提示:token 里只有 base64url 字符和「.」,不要粘进引号、逗号或 JSON 片段。', kind: 'warn' }]);
      return;
    }

    var notes = [];
    var hd = decodeSeg(segs[0], 'header');
    var pd = decodeSeg(segs[1], 'payload');
    var sd = decodeSeg(segs[2], '签名段');

    if (!hd.ok || !pd.ok) {
      resetOutputs();
      $('#jwt-len').textContent = t.length + ' 字符';
      var e1 = !hd.ok ? hd.err : pd.err;
      OC.say('#jwt-in-msg', e1, 'bad');
      if (!sd.ok) setNotes([{ text: sd.err, kind: 'warn' }]);
      return;
    }
    if (hd.loose) notes.push({ text: 'header 不是标准 base64url(' + hd.why + '),已按宽松模式解码', kind: 'warn' });
    if (pd.loose) notes.push({ text: 'payload 不是标准 base64url(' + pd.why + '),已按宽松模式解码', kind: 'warn' });

    var headObj = null, payObj = null, headNotJson = false, payNotJson = false;
    try { headObj = JSON.parse(hd.text); } catch (e) { headNotJson = true; }
    try { payObj = JSON.parse(pd.text); } catch (e) { payNotJson = true; }
    if (headNotJson) notes.push({ text: 'header base64 解出来不是 JSON:不是标准 JWS,已按原始文本显示', kind: 'bad' });
    if (payNotJson) notes.push({ text: 'payload base64 解出来不是 JSON:已按原始文本显示', kind: 'bad' });

    var alg = (headObj && typeof headObj === 'object' && !Array.isArray(headObj) && typeof headObj.alg === 'string') ? headObj.alg : '';
    if (!headNotJson && headObj && typeof headObj === 'object' && !Array.isArray(headObj) && !headObj.alg) {
      notes.push({ text: 'header 里没有 alg 字段,无法判断签名算法', kind: 'warn' });
    }
    if (headObj && typeof headObj === 'object' && !Array.isArray(headObj) && typeof headObj.alg === 'string' && headObj.alg.toLowerCase() === 'none') {
      notes.push({ text: 'alg 为 none:这是未签名的 token,任何人都能改 payload 后照样解析通过,不要信任它', kind: 'bad' });
    }

    // 输出 header / payload
    $('#jwt-head').textContent = headNotJson ? hd.text : (headObj && typeof headObj === 'object' ? pretty(headObj) : hd.text);
    $('#jwt-pay').textContent = payNotJson ? pd.text : (payObj && typeof payObj === 'object' ? pretty(payObj) : pd.text);
    $('#jwt-sig').textContent = segs[2] || '(空,没有签名)';
    $('#jwt-sig-meta').textContent = sd.ok
      ? 'base64url 长 ' + segs[2].length + ' · 签名 ' + sd.bytes.length + ' 字节'
      : sd.err;

    // 声明解读
    var isObj = !payNotJson && payObj && typeof payObj === 'object' && !Array.isArray(payObj);
    var claimMsg = '';
    if (payNotJson) {
      $('#jwt-claims').innerHTML = '<div class="empty">payload 不是 JSON,无法逐条解读</div>';
    } else if (Array.isArray(payObj)) {
      $('#jwt-claims').innerHTML = '<div class="empty">payload 解出来是 JSON 数组而不是对象,不做逐条解读</div>';
      claimMsg = 'payload 是数组';
    } else if (typeof payObj !== 'object' || payObj === null) {
      $('#jwt-claims').innerHTML = '<div class="empty">payload 解出来是普通 JSON 值,不做逐条解读</div>';
      claimMsg = 'payload 不是对象';
    } else {
      $('#jwt-claims').innerHTML = claimsTable(payObj);
      var cnt = 0;
      for (var ck in payObj) if (Object.prototype.hasOwnProperty.call(payObj, ck)) cnt++;
      claimMsg = cnt + ' 条声明';
    }
    $('#jwt-claim-msg').textContent = claimMsg;

    if (isObj) {
      var hasExp = Object.prototype.hasOwnProperty.call(payObj, 'exp');
      if (!hasExp) notes.push({ text: 'payload 里没有 exp:这个 token 不会自动过期,泄露后一直有效', kind: 'warn' });
      if (hasExp && isNum(payObj.exp)) {
        var nowS = Date.now() / 1000, expS = Number(payObj.exp);
        if (nowS > expS) notes.push({ text: '已过期:过期时间是 ' + (fmtTime(expS) || payObj.exp) + ',距今 ' + humanDur((nowS - expS) * 1000), kind: 'bad' });
      }
      if (Object.prototype.hasOwnProperty.call(payObj, 'nbf') && isNum(payObj.nbf)) {
        var nbfS = Number(payObj.nbf), n2 = Date.now() / 1000;
        if (n2 < nbfS) notes.push({ text: '尚未生效:要到 ' + (fmtTime(nbfS) || payObj.nbf) + ' 才能用,还有 ' + humanDur((nbfS - n2) * 1000), kind: 'warn' });
      }
    }

    // 总状态
    var status = '', kind = '';
    if (isObj && Object.prototype.hasOwnProperty.call(payObj, 'exp') && isNum(payObj.exp)) {
      if (Date.now() / 1000 > Number(payObj.exp)) { status = '已过期'; kind = 'bad'; }
      else { status = '有效期内'; kind = 'ok'; }
    } else if (isObj) { status = '无 exp'; kind = ''; }
    renderStats(3, alg, t.length, status, kind);

    last = {
      segs: segs, headText: $('#jwt-head').textContent, payText: $('#jwt-pay').textContent,
      rawHead: hd.text, rawPay: pd.text, headObj: headObj, payObj: payObj,
      alg: alg, sigBytes: sd.bytes, headNotJson: headNotJson, payNotJson: payNotJson
    };

    setNotes(notes);
    var bad = false;
    for (var i = 0; i < notes.length; i++) if (notes[i].kind === 'bad') bad = true;
    OC.say('#jwt-in-msg', bad ? '解析完成,但有需要注意的问题(见上)' : (notes.length ? '解析完成(见上方提示)' : '解析完成'), bad ? 'bad' : (notes.length ? 'warn' : 'ok'));
    scheduleVerify();
  }

  // ================= 校验 =================
  function scheduleVerify() {
    clearTimeout(vTimer);
    vTimer = setTimeout(doVerify, 150);
  }
  function algTagText() {
    var el = $('#jwt-alg-tag');
    if (!last) { el.textContent = '—'; el.className = 'tag'; return; }
    el.textContent = last.alg || '无 alg';
    el.className = 'tag' + (last.alg ? (last.alg.toLowerCase() === 'none' ? ' bad' : ' brand') : ' bad');
  }
  function doVerify() {
    var seq = ++verifySeq;
    var msgSel = '#jwt-v-msg';
    algTagText();
    if (!last) { OC.say(msgSel, ''); return; }
    var a = last.alg;
    if (!a) { OC.say(msgSel, 'header 里没有 alg,无法判断算法', 'warn'); return; }
    if (a.toLowerCase() === 'none') { OC.say(msgSel, 'alg 为 none:未签名的 token,不校验签名', 'bad'); return; }
    var spec = ALGS[a];
    if (!spec) { OC.say(msgSel, '暂不支持校验 ' + a + '(仅 HS256/384/512 与 RS256/384/512)', 'warn'); return; }
    if (!last.sigBytes || !last.sigBytes.length) { OC.say(msgSel, '签名段为空,无法校验', 'bad'); return; }
    var key = $('#jwt-key').value;
    if (!trim(key)) { OC.say(msgSel, spec.rs ? '请在上方填入 PEM 公钥后校验' : '请在上方填入密钥后校验', 'warn'); return; }
    var data = asciiBytes(last.segs[0] + '.' + last.segs[1]);
    OC.say(msgSel, '正在校验…', '');

    if (spec.rs) {
      if (!hasSubtle()) { OC.say(msgSel, '当前页面不是安全上下文(需 https 或 localhost),浏览器不提供 crypto.subtle,RSA 校验无法进行', 'warn'); return; }
      var pem;
      try { pem = pemToBytes(key); }
      catch (e) { OC.say(msgSel, '公钥读取失败:' + errText(e), 'bad'); return; }
      if (/PRIVATE KEY/.test(pem.label)) { OC.say(msgSel, '这是一段私钥;校验只需要公钥,请粘贴 -----BEGIN PUBLIC KEY----- 的公钥', 'bad'); return; }
      if (/RSA PUBLIC KEY/.test(pem.label)) { OC.say(msgSel, '这是 PKCS#1 格式(RSA PUBLIC KEY);请转成 SPKI 的 -----BEGIN PUBLIC KEY----- 再校验', 'bad'); return; }
      if (/CERTIFICATE/.test(pem.label)) { OC.say(msgSel, '这是证书;请从证书里导出公钥(-----BEGIN PUBLIC KEY-----)再校验', 'bad'); return; }
      if (pem.label && !/PUBLIC KEY/.test(pem.label)) { OC.say(msgSel, '不认识的公钥类型:' + pem.label, 'bad'); return; }
      crypto.subtle.importKey('spki', pem.bytes, spec.params, false, ['verify']).then(function (k) {
        return crypto.subtle.verify(spec.params, k, last.sigBytes, data);
      }).then(function (ok) {
        if (seq !== verifySeq) return;
        OC.say(msgSel, ok ? '签名有效:公钥与签名匹配' : '签名不匹配:token 可能被改动,或公钥与签发方不一致', ok ? 'ok' : 'bad');
      }, function (e) {
        if (seq !== verifySeq) return;
        OC.say(msgSel, '公钥无法用于校验(' + errText(e) + ')', 'bad');
      });
      return;
    }

    // HMAC
    if (hasSubtle()) {
      crypto.subtle.importKey('raw', new Uint8Array(utf8Bytes(key)), spec.params, false, ['verify']).then(function (k) {
        return crypto.subtle.verify(spec.params, k, last.sigBytes, data);
      }).then(function (ok) {
        if (seq !== verifySeq) return;
        OC.say(msgSel, ok ? '签名有效:密钥与签名匹配' : '签名不匹配:密钥不对,或 token 被改动过', ok ? 'ok' : 'bad');
      }, function (e) {
        if (seq !== verifySeq) return;
        OC.say(msgSel, '校验失败:' + errText(e), 'bad');
      });
      return;
    }
    // 降级:只有安全上下文才给 crypto.subtle,这里用纯 JS 的 HMAC-SHA256 兜底
    if (a !== 'HS256') { OC.say(msgSel, '当前不是安全上下文,降级校验只支持 HS256,无法校验 ' + a + '(请用 https 访问)', 'warn'); return; }
    var mac = hmacSha256(new Uint8Array(utf8Bytes(key)), data);
    var ok2 = bytesEqual(mac, last.sigBytes);
    OC.say(msgSel, (ok2 ? '签名有效:密钥与签名匹配' : '签名不匹配:密钥不对,或 token 被改动过') + '(降级校验,非 crypto.subtle)', ok2 ? 'ok' : 'bad');
  }

  // ================= 生成 =================
  function headerRebuild(alg, kid) {
    var o = {};
    try { o = JSON.parse($('#jwt-g-head').value) || {}; } catch (e) { o = {}; }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) o = {};
    var out = {};
    out.alg = alg;
    var typ = Object.prototype.hasOwnProperty.call(o, 'typ') ? o.typ : 'JWT';
    out.typ = typ;
    if (kid && trim(kid)) out.kid = trim(kid);
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (k === 'alg' || k === 'typ' || k === 'kid') continue;
      out[k] = o[k];
    }
    $('#jwt-g-head').value = pretty(out);
  }
  function syncHeaderToControls() {
    var o = null;
    try { o = JSON.parse($('#jwt-g-head').value); } catch (e) { o = null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    if (typeof o.alg === 'string' && ALGS[o.alg]) OC.segSet('#jwt-alg', o.alg);
    if (document.activeElement !== $('#jwt-kid')) {
      $('#jwt-kid').value = (typeof o.kid === 'string' || typeof o.kid === 'number') ? String(o.kid) : '';
    }
  }
  function generate() {
    var outEl = $('#jwt-g-out'), msg = '#jwt-g-msg';
    var headText = trim($('#jwt-g-head').value);
    var payText = trim($('#jwt-g-pay').value);
    var key = $('#jwt-g-key').value;
    if (!headText) { OC.say(msg, 'header 不能为空', 'bad'); outEl.textContent = '—'; return; }
    if (!payText) { OC.say(msg, 'payload 不能为空', 'bad'); outEl.textContent = '—'; return; }
    var headObj;
    try { headObj = JSON.parse(headText); }
    catch (e) { OC.say(msg, 'header 不是合法 JSON:' + errText(e), 'bad'); outEl.textContent = '—'; return; }
    if (!headObj || typeof headObj !== 'object' || Array.isArray(headObj)) { OC.say(msg, 'header 必须是一个 JSON 对象', 'bad'); outEl.textContent = '—'; return; }
    var payObj;
    try { payObj = JSON.parse(payText); }
    catch (e) { OC.say(msg, 'payload 不是合法 JSON:' + errText(e), 'bad'); outEl.textContent = '—'; return; }
    var useAlg = typeof headObj.alg === 'string' ? headObj.alg : (OC.segVal('#jwt-alg') || 'HS256');
    var spec = ALGS[useAlg];
    if (!spec) { OC.say(msg, '生成只支持 HS256 / HS384 / HS512,header 里的 alg 是 ' + useAlg, 'bad'); outEl.textContent = '—'; return; }
    if (spec.rs) { OC.say(msg, '生成本工具只做 HMAC(HS256/384/512);RSA 签名需要私钥,请在服务端完成', 'bad'); outEl.textContent = '—'; return; }
    OC.segSet('#jwt-alg', useAlg);
    if (!trim(key)) { OC.say(msg, '请先填写签名密钥', 'warn'); outEl.textContent = '—'; return; }

    // JWT 的签名输入是「base64url(header) + '.' + base64url(payload)」这两段编码后的文本,
    // 不是原文 JSON;签错对象会导致生成的 token 拿到这里校验时永远不匹配。
    var hSeg = b64u(new Uint8Array(utf8Bytes(headText)));
    var pSeg = b64u(new Uint8Array(utf8Bytes(payText)));
    var data = asciiBytes(hSeg + '.' + pSeg);
    function finish(sigBytes) {
      var token = hSeg + '.' + pSeg + '.' + b64u(sigBytes);
      lastToken = token;
      outEl.textContent = token;
      OC.say(msg, '已生成 · ' + useAlg + ' · ' + token.length + ' 字符,可复制或拿去解析', 'ok');
    }
    if (hasSubtle()) {
      crypto.subtle.importKey('raw', new Uint8Array(utf8Bytes(key)), spec.params, false, ['sign']).then(function (k) {
        return crypto.subtle.sign(spec.params, k, data);
      }).then(function (buf) {
        finish(new Uint8Array(buf));
      }, function (e) {
        OC.say(msg, '签名失败:' + errText(e), 'bad');
        outEl.textContent = '—';
      });
      return;
    }
    if (useAlg !== 'HS256') { OC.say(msg, '当前不是安全上下文,降级生成只支持 HS256;' + useAlg + ' 需要 https 访问', 'warn'); outEl.textContent = '—'; return; }
    finish(hmacSha256(new Uint8Array(utf8Bytes(key)), data));
  }

  // ================= 复制完整解析结果 =================
  function parseReport() {
    if (!last) return '';
    var lines = [];
    lines.push('JWT 解析结果');
    lines.push('算法: ' + (last.alg || '未知'));
    lines.push('长度: ' + last.segs.join('.').length + ' 字符');
    lines.push('');
    lines.push('Header:');
    lines.push(last.headText);
    lines.push('');
    lines.push('Payload:');
    lines.push(last.payText);
    lines.push('');
    lines.push('声明:');
    var pay = last.payObj;
    if (pay && typeof pay === 'object' && !Array.isArray(pay)) {
      for (var i = 0; i < CLAIMS.length; i++) {
        var k = CLAIMS[i][0];
        if (!Object.prototype.hasOwnProperty.call(pay, k)) continue;
        var v = pay[k], extra = '';
        if (TIME_CLAIMS[k] && isNum(v)) {
          var t = fmtTime(Number(v));
          extra = '  (' + (t || '时间无效') + ')';
          if (k === 'exp') extra += Date.now() / 1000 > Number(v) ? '  [已过期 ' + humanDur((Date.now() / 1000 - Number(v)) * 1000) + ']' : '  [还有 ' + humanDur((Number(v) - Date.now() / 1000) * 1000) + ' 过期]';
        }
        lines.push('  ' + k + ' = ' + JSON.stringify(v) + extra);
      }
    } else {
      lines.push('  (payload 不是对象)');
    }
    lines.push('');
    lines.push('Signature: ' + (last.segs[2] || '(空)'));
    return lines.join('\n');
  }

  // ================= base64url 小工具 =================
  var B64_HELP = '解码按 UTF-8 还原;编码输出不带 = 填充的标准 base64url。上方的「宽松模式」对这里同样生效。';
  function b64tool() {
    var mode = OC.segVal('#jwt-b64mode') || 'dec';
    var inp = $('#jwt-b64-in').value;
    var outEl = $('#jwt-b64-out'), msg = '#jwt-b64-msg';
    if (!trim(inp)) { outEl.textContent = '—'; OC.say(msg, B64_HELP, ''); return; }
    if (mode === 'enc') {
      var bytes = utf8Bytes(inp);
      outEl.textContent = b64u(new Uint8Array(bytes));
      OC.say(msg, '已编码 ' + bytes.length + ' 字节 → base64url(不带 = 填充)', 'ok');
      return;
    }
    var r = decodeSeg(inp, '输入');
    if (!r.ok) { outEl.textContent = '—'; OC.say(msg, r.err, 'bad'); return; }
    outEl.textContent = r.text;
    var note = '已解码 ' + r.bytes.length + ' 字节';
    if (r.loose) note += ' · 这不是标准的 base64url(' + r.why + ')';
    if (r.bytes.length && r.text.indexOf('\uFFFD') >= 0) note += ' · 含无法按 UTF-8 显示的字节,已用占位符代替';
    OC.say(msg, note, r.loose ? 'warn' : 'ok');
  }

  // ================= 事件接线 =================
  function liveParse() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(parseToken, 120);
  }
  function liveGen() {
    clearTimeout(gTimer);
    gTimer = setTimeout(generate, 140);
  }
  function pageDefaults() {
    var now = Math.floor(Date.now() / 1000);
    $('#jwt-g-head').value = pretty({ alg: 'HS256', typ: 'JWT' });
    $('#jwt-g-pay').value = pretty({
      iss: 'toolbox', sub: '1234567890', aud: 'openai-chat',
      name: '示例用户', iat: now, exp: now + 3600
    });
  }
  function demo() {
    $('#jwt-in').value = DEMO_TOKEN;
    $('#jwt-key').value = 'secret';
    $('#jwt-loose').checked = false;
    parseToken();
    doVerify();
    OC.say('#jwt-key-info', '已填入示例密钥 secret;这个 token 已过期,但签名与 secret 匹配', 'ok');
  }

  function wire() {
    $('#jwt-in').addEventListener('input', liveParse);
    $('#jwt-parse').addEventListener('click', function () { parseToken(); doVerify(); });
    $('#jwt-loose').addEventListener('change', function () { parseToken(); b64tool(); doVerify(); });
    $('#jwt-demo').addEventListener('click', demo);
    $('#jwt-clear').addEventListener('click', function () {
      $('#jwt-in').value = '';
      resetOutputs();
      OC.say('#jwt-in-msg', '等待输入:粘贴一个 JWT 即可实时解析', '');
      setNotes([]);
      $('#jwt-in').focus();
    });
    $('#jwt-paste').addEventListener('click', function () {
      if (!(navigator.clipboard && navigator.clipboard.readText)) { OC.toast('这个浏览器不给读剪贴板,请手动 Ctrl+V', 'bad'); return; }
      navigator.clipboard.readText().then(function (txt) {
        if (!trim(txt)) { OC.toast('剪贴板里没有文本', 'bad'); return; }
        $('#jwt-in').value = txt;
        liveParse();
      }, function () { OC.toast('读取剪贴板被拒绝,请手动 Ctrl+V', 'bad'); });
    });

    $('#jwt-copy-head').addEventListener('click', function () { OC.copy(last ? last.headText : '', 'Header 已复制'); });
    $('#jwt-copy-pay').addEventListener('click', function () { OC.copy(last ? last.payText : '', 'Payload 已复制'); });
    $('#jwt-copy-sig').addEventListener('click', function () { OC.copy(last ? last.segs[2] : '', '签名段已复制'); });
    $('#jwt-copy-all').addEventListener('click', function () {
      var rep = parseReport();
      if (!rep) { OC.toast('还没有解析结果', 'bad'); return; }
      OC.copy(rep, '完整解析结果已复制');
    });

    $('#jwt-key').addEventListener('input', scheduleVerify);
    $('#jwt-verify').addEventListener('click', doVerify);
    OC.drop('#jwt-key-drop', function (files) {
      var f = files[0];
      if (!f) return;
      OC.readFile(f, 'text').then(function (txt) {
        if (!trim(txt)) { OC.toast('这个文件是空的', 'bad'); return; }
        $('#jwt-key').value = txt;
        OC.say('#jwt-key-info', '已读入 ' + f.name + '(' + OC.fmtBytes(f.size) + ')', 'ok');
        scheduleVerify();
      }, function () { OC.toast('文件读不出来,请确认是纯文本 PEM', 'bad'); });
    });

    OC.seg('#jwt-alg', function (v) { headerRebuild(v, $('#jwt-kid').value); generate(); });
    $('#jwt-kid').addEventListener('input', function () { headerRebuild(OC.segVal('#jwt-alg') || 'HS256', this.value); liveGen(); });
    $('#jwt-g-head').addEventListener('input', function () { syncHeaderToControls(); liveGen(); });
    $('#jwt-g-pay').addEventListener('input', liveGen);
    $('#jwt-g-key').addEventListener('input', liveGen);
    $('#jwt-g-run').addEventListener('click', generate);
    $('#jwt-g-copy').addEventListener('click', function () { OC.copy(lastToken, 'token 已复制'); });
    $('#jwt-g-use').addEventListener('click', function () {
      if (!lastToken) { OC.toast('先生成一个 token', 'bad'); return; }
      $('#jwt-in').value = lastToken;
      $('#jwt-key').value = $('#jwt-g-key').value;
      parseToken();
      doVerify();
      OC.toast('已放到上方解析与校验');
      if ($('#jwt-in').scrollIntoView) $('#jwt-in').scrollIntoView({ block: 'center' });
    });

    OC.seg('#jwt-b64mode', b64tool);
    $('#jwt-b64-in').addEventListener('input', b64tool);
    $('#jwt-b64-copy').addEventListener('click', function () { OC.copy($('#jwt-b64-out').textContent, '输出已复制'); });
  }

  // ================= 初始化 =================
  wire();
  pageDefaults();
  demo();
  b64tool();
  generate();
})();
TCJWT_JS;

return array(
    'id' => 'jwt',
    'cat' => 'dev',
    'title' => 'JWT 解析与校验',
    'body' => $body,
    'script' => $script,
);
