<?php
/**
 * 工具:UUID 与 ULID 生成。
 *
 * 一个页面里做四件事:批量生成(按需切换 UUID v4 / UUID v7 / ULID / NanoID 风格短 ID)、
 * 输出格式化、粘贴校验解析(版本位、变体位、内嵌时间戳换算本地时间)、以及把碰撞概率
 * 的量级算清楚写明白。
 *
 * 关键实现选择:
 *   - 随机字节一律走 crypto.getRandomValues(CSPRNG),不用 Math.random(可预测,见脚本内注释);
 *   - UUID v7 的 rand_a 12 位与 ULID 的 80 位随机部分都实现了「同一毫秒内递增」,
 *     保证同一批严格有序、不重复;关掉开关则退回纯随机并说明差别;
 *   - 短 ID 用 NanoID 的「掩码 + 拒绝采样」,不是取模,避免前几个字符概率偏高;
 *   - 生成与格式化分离:改变大小写/连字符/前缀只重渲染,不重新抽随机数。
 */
$body = <<<'UU_BODY'
<style>
/* 只补少量工具专属样式,其余全部复用设计系统类名。
   [hidden] 必须显式写成 display:none —— 本页的 .f / .cols 等类自带 display,
   作者样式优先级高于浏览器默认的 [hidden]{display:none},不写这条 hidden 属性会失效。 */
[hidden]{display:none !important}
.uu-sub{font-size:.786rem;color:var(--t3)}
.uu-prev{font-family:var(--mono);font-size:.857rem;background:var(--bg-code);border-radius:var(--r);padding:9px 11px;
  word-break:break-all;overflow-wrap:anywhere;max-height:130px;overflow:auto}
.uu-idx{font-family:var(--mono);font-size:.75rem;color:var(--t3);min-width:2.4em;text-align:right;flex:0 0 auto}
.uu-par{padding:10px 11px;border-radius:var(--r);background:var(--bg-soft)}
.uu-par + .uu-par{margin-top:6px}
.uu-par .v{font-family:var(--mono);font-size:.857rem;margin:6px 0 0;word-break:break-all;overflow-wrap:anywhere}
.uu-par .meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.uu-note p{margin:0 0 8px}
.uu-note p:last-child{margin-bottom:0}
.uu-k{font-family:var(--mono);background:var(--bg-code);border-radius:var(--r-xs);padding:1px 5px}
</style>

<div class="hd">
  <div class="grow">
    <h1>UUID 与 ULID 生成</h1>
    <div class="sub">用系统密码学随机源批量生成 UUID v4 / v7、ULID 与自定义短 ID;输出格式可调;粘贴一个 UUID 或 ULID 还能判断版本、变体位并把内嵌时间戳换算成本地时间。</div>
  </div>
  <div class="acts">
    <span class="tag" id="uu-tag">0 条</span>
    <button class="btn" id="uu-again">换一批</button>
    <button class="btn accent" id="uu-gen">生成</button>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>生成设置</h2>
    <span class="grow"></span>
    <span class="msg" id="uu-set-msg"></span>
  </div>

  <div class="f">
    <span class="lab">类型</span>
    <div class="seg" id="uu-kind">
      <button class="seg-btn on" data-v="v4">UUID v4</button>
      <button class="seg-btn" data-v="v7">UUID v7</button>
      <button class="seg-btn" data-v="ulid">ULID</button>
      <button class="seg-btn" data-v="sid">短 ID</button>
    </div>
    <span class="uu-sub" id="uu-kind-hint"></span>
  </div>

  <div class="cols tight" style="margin-top:12px">
    <div class="f">
      <span class="lab">生成数量 <b id="uu-count-v" class="mono">10</b> 条(1–200)</span>
      <input type="range" id="uu-count" data-out="#uu-count-v" min="1" max="200" step="1" value="10">
      <div class="row">
        <input type="number" id="uu-count-n" min="1" max="200" step="1" value="10" style="width:84px" aria-label="生成数量">
        <button class="btn sm ghost" data-count="1">1</button>
        <button class="btn sm ghost" data-count="10">10</button>
        <button class="btn sm ghost" data-count="100">100</button>
        <button class="btn sm ghost" data-count="200">200</button>
      </div>
    </div>

    <div class="f" id="uu-g-uuid">
      <span class="lab">UUID 输出格式</span>
      <div class="seg" id="uu-case">
        <button class="seg-btn on" data-v="lower">小写</button>
        <button class="seg-btn" data-v="upper">大写</button>
      </div>
      <label class="row" style="gap:6px"><input type="checkbox" id="uu-nohyphen"> 去掉连字符(32 位十六进制)</label>
      <label class="row" style="gap:6px"><input type="checkbox" id="uu-braces"> 花括号包裹 {…}</label>
      <label class="row" style="gap:6px"><input type="checkbox" id="uu-urn"> 加 urn:uuid: 前缀</label>
      <span class="lab" style="margin-top:6px">输出预览</span>
      <div class="uu-prev" id="uu-prev">—</div>
      <span class="uu-sub" id="uu-prev-note"></span>
    </div>

    <div class="f" id="uu-g-mono">
      <span class="lab">同一毫秒内</span>
      <label class="row" style="gap:6px"><input type="checkbox" id="uu-mono" checked> 随机部分递增(严格单调)</label>
      <span class="uu-sub" id="uu-mono-hint"></span>
    </div>

    <div class="f" id="uu-g-ulid">
      <span class="lab">ULID 选项</span>
      <label class="row" style="gap:6px"><input type="checkbox" id="uu-ulid-lower"> 小写输出(规范形式是全大写)</label>
      <span class="uu-sub">26 个字符的 Crockford Base32(去掉了 I L O U),前 10 位是 48 位毫秒时间戳,后 16 位(80 bit)随机。因为时间戳在高位,ULID 按字典序排就是按时间排。</span>
    </div>

    <div class="f" id="uu-g-sid">
      <span class="lab">短 ID 长度 <b id="uu-sidlen-v" class="mono">21</b>(4–64)</span>
      <input type="range" id="uu-sidlen" data-out="#uu-sidlen-v" min="4" max="64" step="1" value="21">
      <span class="lab">字母表</span>
      <select id="uu-alpha" aria-label="短 ID 字母表">
        <option value="url">A-Z a-z 0-9 _ -(默认,64 个)</option>
        <option value="alnum">A-Z a-z 0-9(62 个)</option>
        <option value="lower">a-z 0-9(36 个)</option>
        <option value="hex">0-9 a-f(16 个)</option>
        <option value="num">0-9(10 个)</option>
        <option value="custom">自定义…</option>
      </select>
      <input type="text" id="uu-alpha-custom" class="mono" spellcheck="false" placeholder="自定义字母表,重复字符会自动去重" hidden>
      <label class="row" style="gap:6px"><input type="checkbox" id="uu-sid-confuse" checked> 去掉易混字符(0 O 1 l I)</label>
      <span class="uu-sub" id="uu-alpha-info"></span>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>生成结果</h2>
    <span class="grow"></span>
    <span class="msg" id="uu-out-msg"></span>
    <button class="btn sm" id="uu-copy-all">全部复制</button>
    <button class="btn sm" id="uu-open-txt">导出为文本文件</button>
    <button class="btn sm ghost" id="uu-clear">清空</button>
  </div>
  <div class="rows tall" id="uu-list"><div class="empty">改上面的设置或点「生成」,结果会列在这里</div></div>
  <div class="stats mt" id="uu-stats"></div>
  <div class="msg mt"><b>怎么拿走:</b>「全部复制」按每行一条放进剪贴板;「导出为文本文件」会在新标签页打开一个 .txt —— 工具页跑在沙箱里,浏览器不允许直接落盘,请在那边按 Ctrl+S 或右键「另存为」。</div>
</div>

<div class="card">
  <div class="card-h">
    <h2>校验与解析</h2>
    <span class="grow"></span>
    <span class="msg" id="uu-par-msg"></span>
    <button class="btn sm ghost" id="uu-par-demo">填入示例</button>
    <button class="btn sm ghost" id="uu-par-clear">清空</button>
  </div>
  <textarea id="uu-par-in" class="wrap" spellcheck="false" style="min-height:86px" placeholder="粘贴一个或多个 UUID / ULID,每行一个。支持 8-4-4-4-12、去掉连字符的 32 位、{花括号}、urn:uuid: 前缀与任意大小写。"></textarea>
  <div class="rows mt" id="uu-par-list"><div class="empty">粘进来就会自动判断:格式是否合法、版本号、变体位,并对 v1 / v6 / v7 与 ULID 解析出内嵌时间戳</div></div>
</div>

<div class="card">
  <div class="card-h"><h2>说明</h2></div>
  <div class="uu-note">
    <p><b>UUID v4</b> —— 16 字节里 122 位是随机的,另外 6 位固定拿来当版本号和变体位。它不携带任何时间信息,所以从 ID 本身看不出生成先后,也反推不出生成机器;代价是数据库拿它当主键时插入点完全是随机的。</p>
    <p><b>UUID v7(RFC 9562)</b> —— 前 48 位放 Unix 毫秒时间戳,接着 4 位版本、2 位变体,剩下 74 位随机。字符串按字典序排就是时间序,做数据库主键时基本是顺序追加,不像 v4 那样把 B+ 树索引打散。本工具把版本号后面那 12 位当计数器,同一毫秒内递增,所以一批里严格有序、不重复(每毫秒最多 4096 个,用满自动进位到下一毫秒);关掉「同毫秒内递增」,这 12 位就退回纯随机。</p>
    <p><b>ULID</b> —— 和 v7 是同一个思路(48 位时间 + 80 位随机,一共 128 位),但它不是 UUID:ULID 用 Crockford Base32 编码成 26 个字符,没有版本位和变体位,所以 ULID 字符串不能当 UUID 用,反过来也不行。好处是不区分大小写、比 UUID 短 10 个字符,而且天然按时间排序。同一毫秒内把 80 位随机部分整体 +1,一批内严格递增。</p>
    <p><b>短 ID(NanoID 风格)</b> —— 长度和字母表自己定。默认 21 个字符 × 64 字符的字母表约 126 位熵,和 UUID v4 的 122 位同一量级;想更短就得接受更小的搜索空间(信息量 = 长度 × log2(字母表大小),上面面板直接算给你看)。抽字符用的是「掩码 + 拒绝采样」而不是取模,不会出现前几个字符概率偏高。</p>
    <p><b>碰撞概率的量级</b> —— v4 有 122 位随机,按生日界,累计生成约 <span class="uu-k">1.1774 × 2^61 ≈ 2.71 × 10^18</span> 个才有一半概率撞上重复;如果每秒生成 10 亿个,要不停歇地跑约 <span class="uu-k">86 年</span> 才走到这个点。v7 的随机部分只有 74 位,但碰撞只可能发生在同一毫秒内:每秒 10 亿意味着每毫秒 100 万个,同一毫秒里撞一次的概率约 <span class="uu-k">(10^6)² / 2^75 ≈ 2.6 × 10^-11</span>;ULID 是 80 位随机,更小。短 ID 的风险完全取决于你选的长度和字母表 —— 熵低于 64 位就不该拿它当不可猜测的凭证。</p>
    <p class="uu-sub">上面都是随机碰撞的理论值,不含实现层面的问题(时钟回拨、多个进程各自抽随机、随机源被复用等)。要真正防猜测,除了长度,随机源也必须是密码学安全的 —— 这正是本工具只用 <span class="uu-k">crypto.getRandomValues</span> 的原因。</p>
  </div>
</div>
UU_BODY;
$script = <<<'UU_JS'
/* 生成与解析逻辑。
 *
 * 随机源:一律 crypto.getRandomValues,绝不 Math.random(理由见 rnd 的注释)。
 * UUID v7 的 rand_a(12 位)与 ULID 的随机部分(80 位)都做了「同毫秒内递增」,
 * 让同一批严格有序且不重复;生成值以规范形式存下来,格式化只影响展示与复制。
 */
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;
  var LN2 = Math.LN2;

  // ================= 随机源 =================
  var CRYPTO_OK = !!(window.crypto && typeof window.crypto.getRandomValues === 'function');
  /**
   * 取 n 个密码学随机字节。
   *
   * 为什么不用 Math.random:
   *   1) Math.random 是可预测的伪随机。V8 / SpiderMonkey 都维护一个 xorshift128+ 状态,
   *      攻击者拿到少量输出就能反推内部状态,从而预测之后生成的所有值 —— UUID / 短 ID 常被
   *      用作主键、会话标识、邀请码,可预测就等于可枚举、可伪造。
   *   2) 规范只要求 Math.random 给出 [0,1) 上的近似均匀值,既不保证每一位独立,
   *      也不保证输出互不相同;它不是密码学随机源。
   *   3) crypto.getRandomValues 由浏览器直连操作系统的 CSPRNG(/dev/urandom、BCryptGenRandom),
   *      是 Web Crypto 规范里的密码学安全随机源,沙箱环境里也能用。
   * 每批一次取够需要的字节(16 / 10 / step),不逐字节调用。
   */
  function rnd(n) {
    var b = new Uint8Array(n);
    window.crypto.getRandomValues(b);
    return b;
  }

  // ================= 常量 =================
  var HEX = '0123456789abcdef';
  var CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford Base32:去掉 I L O U
  var CONFUSE = '0O1lI';
  var ALPHABETS = {
    url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
    alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    lower: 'abcdefghijklmnopqrstuvwxyz0123456789',
    hex: '0123456789abcdef',
    num: '0123456789',
  };
  var KIND_LABEL = { v4: 'UUID v4', v7: 'UUID v7', ulid: 'ULID', sid: '短 ID' };
  var KIND_HINT = {
    v4: '122 位随机,不含时间信息。最通用,也不泄漏生成时间。',
    v7: '高 48 位是毫秒时间戳,字典序即时间序。适合做数据库主键。',
    ulid: '26 字符 Crockford Base32,48 位时间 + 80 位随机,比 UUID 短 10 个字符。',
    sid: 'NanoID 风格:长度与字母表自定,适合短链接、文件名、邀请码。',
  };
  var SAMPLE_HEX = '0198f3c2a7b47def8891c0ffee123456';   // 仅用于格式预览
  var UNIX_100NS_AT_1582 = 12219292800000;                 // 1582-10-15 → 1970-01-01 的毫秒差
  var MAX_PARSE_LINES = 100;
  var MAX_PARSE_LEN = 256;

  // ================= 状态 =================
  var st = {
    kind: 'v4', count: 10,
    upper: false, nohyphen: false, braces: false, urn: false,
    mono: true, ulidLower: false,
    sidLen: 21, alpha: 'url', custom: '', noConf: true,
  };
  var items = [];                 // { kind, value(规范形式), ms?, mono? }
  var ready = false;              // 首次生成之前不响应实时重算(避免初始化时重复生成)
  var genTimer = 0, parTimer = 0;
  var v7st = { ms: -1, counter: 0 };
  var ulidSt = { ms: -1, last: null };

  // ================= 小工具 =================
  function bytesToHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += HEX.charAt(b[i] >> 4) + HEX.charAt(b[i] & 15);
    return s;
  }
  function hyphen(h) {
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function p3(n) { return String(n).padStart(3, '0'); }
  function fmtClock(ms) {
    var d = new Date(ms);
    if (!isFinite(ms) || isNaN(d.getTime())) return '时间不可用';
    return OC.p2(d.getHours()) + ':' + OC.p2(d.getMinutes()) + ':' + OC.p2(d.getSeconds()) + '.' + p3(d.getMilliseconds());
  }
  function fmtFull(ms) {
    var d = new Date(ms);
    if (!isFinite(ms) || isNaN(d.getTime())) return '时间戳超出可表示范围';
    return d.getFullYear() + '-' + OC.p2(d.getMonth() + 1) + '-' + OC.p2(d.getDate()) + ' ' + fmtClock(ms);
  }
  function relTime(ms) {
    var diff = Date.now() - ms, ad = Math.abs(diff), s;
    if (ad < 1500) return '刚刚';
    if (ad < 60000) s = Math.round(ad / 1000) + ' 秒';
    else if (ad < 3600000) s = Math.round(ad / 60000) + ' 分钟';
    else if (ad < 86400000) s = (ad / 3600000).toFixed(1) + ' 小时';
    else if (ad < 31536000000) s = (ad / 86400000).toFixed(1) + ' 天';
    else s = (ad / 31536000000).toFixed(1) + ' 年';
    return '约 ' + s + (diff >= 0 ? '前' : '后');
  }

  // ================= 格式 =================
  function fmtUuid(canonical) {
    var s = canonical;
    if (st.nohyphen) s = s.replace(/-/g, '');
    s = st.upper ? s.toUpperCase() : s.toLowerCase();
    if (st.braces) s = '{' + s + '}';
    if (st.urn) s = 'urn:uuid:' + s;   // 前缀按 RFC 4122 的写法固定小写,不跟着大小写开关变
    return s;
  }
  function displayValue(it) {
    if (it.kind === 'v4' || it.kind === 'v7') return fmtUuid(it.value);
    if (it.kind === 'ulid') return st.ulidLower ? it.value.toLowerCase() : it.value;
    return it.value;
  }

  // ================= 短 ID 字母表 =================
  function alphabetFor() {
    if (st.alpha === 'custom') {
      var seen = {}, out = '', cs = st.custom || '';
      for (var i = 0; i < cs.length; i++) {
        var c = cs.charAt(i);
        if (/\s/.test(c)) continue;              // 空白字符去掉(URL 与文件名里都不好用)
        if (seen[c]) continue;                   // 重复字符去重
        seen[c] = 1;
        out += c;
      }
      if (out.length >= 2) return out;
    }
    var base = ALPHABETS[st.alpha] || ALPHABETS.url;
    if (st.noConf) {
      var b2 = '';
      for (var k = 0; k < base.length; k++) if (CONFUSE.indexOf(base.charAt(k)) < 0) b2 += base.charAt(k);
      if (b2.length >= 2) base = b2;
    }
    return base;
  }
  /** NanoID 的取字符法:掩码 + 拒绝采样。取模会让前几个字符概率偏高,这里不用取模。 */
  function nanoId(len, alpha) {
    var n = alpha.length;
    var mask = (2 << Math.floor(Math.log(n - 1) / LN2)) - 1;
    var step = Math.ceil((1.6 * mask * len) / n);
    var out = '';
    for (;;) {
      var bytes = rnd(step);
      for (var i = 0; i < step; i++) {
        var j = bytes[i] & mask;
        if (j < n) {
          out += alpha.charAt(j);
          if (out.length === len) return out;
        }
      }
    }
  }

  // ================= 生成 =================
  function newV4() {
    var b = rnd(16);
    b[6] = (b[6] & 0x0f) | 0x40;    // 版本 4
    b[8] = (b[8] & 0x3f) | 0x80;    // 变体 RFC 4122/9562
    return hyphen(bytesToHex(b));
  }
  /* UUID v7:48 位毫秒时间戳 + 4 位版本 + 12 位 rand_a + 2 位变体 + 62 位随机。
     单调做法(RFC 9562 method A):同一毫秒内 rand_a 当计数器递增,新毫秒用随机种子。
     时间戳一律写进高 48 位;系统时钟回拨时沿用上一毫秒继续递增,保证只增不减。 */
  function newV7() {
    var now = Date.now(), ms, counter, mono = false;
    if (st.mono) {
      if (now > v7st.ms) {
        var seed = rnd(2);
        v7st.ms = now;
        v7st.counter = ((seed[0] << 8) | seed[1]) & 0x0fff;
      } else {
        var c = (v7st.counter + 1) & 0x0fff;
        if (c === 0) v7st.ms = v7st.ms + 1;      // 4096 个/毫秒用尽:进位到下一毫秒
        v7st.counter = c;
        mono = true;
      }
    } else {
      var s2 = rnd(2);
      v7st.ms = now;
      v7st.counter = ((s2[0] << 8) | s2[1]) & 0x0fff;   // 不做单调时 rand_a 也用随机
    }
    ms = v7st.ms;
    counter = v7st.counter;
    var b = rnd(16);
    b[0] = Math.floor(ms / 0x10000000000) % 256;  // 1e12 超出 int32,不能用位运算
    b[1] = Math.floor(ms / 0x100000000) % 256;
    b[2] = Math.floor(ms / 0x1000000) % 256;
    b[3] = Math.floor(ms / 0x10000) % 256;
    b[4] = Math.floor(ms / 0x100) % 256;
    b[5] = ms % 256;
    b[6] = 0x70 | ((counter >> 8) & 0x0f);
    b[7] = counter & 0xff;
    b[8] = (b[8] & 0x3f) | 0x80;
    return { value: hyphen(bytesToHex(b)), ms: ms, mono: mono };
  }
  function encTime48(ms) {
    var out = '', v = ms;
    for (var i = 0; i < 10; i++) { out = CROCK.charAt(v % 32) + out; v = Math.floor(v / 32); }
    return out;
  }
  function encRandom80(bytes) {
    var out = '', acc = 0, bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { bits -= 5; out += CROCK.charAt((acc >>> bits) & 31); }
      acc &= (1 << bits) - 1;
    }
    return out;
  }
  /** 80 位无符号数 +1(带进位);溢出返回 null。 */
  function inc80(b) {
    var o = new Uint8Array(10);
    o.set(b);
    for (var i = 9; i >= 0; i--) {
      o[i] = (o[i] + 1) & 0xff;
      if (o[i] !== 0) return o;
    }
    return null;
  }
  function newUlid() {
    var now = Date.now(), ms, r, mono = false;
    if (st.mono && ulidSt.last && now <= ulidSt.ms) {
      var inc = inc80(ulidSt.last);
      if (inc) { ms = ulidSt.ms; r = inc; mono = true; }        // 同毫秒:随机部分 +1
      else { ms = ulidSt.ms + 1; r = rnd(10); }                  // 80 位溢出(几乎不可能):换新随机
    } else {
      ms = now;
      r = rnd(10);
    }
    ulidSt.ms = ms;
    ulidSt.last = r;
    return { value: encTime48(ms) + encRandom80(r), ms: ms, mono: mono };
  }

  // ================= 采集 / 可见性 =================
  function collect() {
    st.kind = OC.segVal('#uu-kind') || 'v4';
    st.upper = OC.segVal('#uu-case') === 'upper';
    st.nohyphen = $('#uu-nohyphen').checked;
    st.braces = $('#uu-braces').checked;
    st.urn = $('#uu-urn').checked;
    st.mono = $('#uu-mono').checked;
    st.ulidLower = $('#uu-ulid-lower').checked;
    st.sidLen = Math.max(4, Math.min(64, Number($('#uu-sidlen').value) || 21));
    st.alpha = $('#uu-alpha').value;
    st.custom = $('#uu-alpha-custom').value;
    st.noConf = $('#uu-sid-confuse').checked;
    st.count = Math.max(1, Math.min(200, Number($('#uu-count').value) || 10));
  }
  function syncVisibility() {
    var k = st.kind;
    $('#uu-g-uuid').hidden = !(k === 'v4' || k === 'v7');
    $('#uu-g-mono').hidden = !(k === 'v7' || k === 'ulid');
    $('#uu-g-ulid').hidden = k !== 'ulid';
    $('#uu-g-sid').hidden = k !== 'sid';
    $('#uu-alpha-custom').hidden = st.alpha !== 'custom';
    $('#uu-kind-hint').textContent = KIND_HINT[k] || '';
    $('#uu-mono-hint').textContent = k === 'ulid'
      ? '开启后同一毫秒内把 80 位随机部分整体 +1,一批内严格递增;关闭则同毫秒内顺序不确定(碰撞概率约 10^-13 量级,但排序不保证)。'
      : '开启后同一毫秒内 12 位 rand_a 计数器递增(最多 4096 个/毫秒);关闭则 rand_a 退回纯随机,排序不再严格。';
  }
  function alphaBits(len, size) { return len * Math.log(size) / LN2; }
  function updateAlphaInfo() {
    var a = alphabetFor();
    var per = Math.log(a.length) / LN2;
    var bits = alphaBits(st.sidLen, a.length);
    var warn = '';
    if (a.length < 8) warn = ';字母表太短,很容易被穷举,建议至少 16 个字符';
    if (bits < 64 && a.length >= 8) warn = ';总熵不足 64 位,不适合当不可猜测的凭证';
    $('#uu-alpha-info').textContent = '字母表 ' + a.length + ' 个字符,每位 ' + per.toFixed(2) + ' bit,共约 ' + bits.toFixed(0) + ' bit 熵' + warn;
  }
  function syncPreview() {
    if (!(st.kind === 'v4' || st.kind === 'v7')) return;
    var mine = items.length && (items[0].kind === 'v4' || items[0].kind === 'v7');
    var src = mine ? items[0].value : hyphen(SAMPLE_HEX);
    $('#uu-prev').textContent = fmtUuid(src);
    $('#uu-prev-note').textContent = mine ? '当前第一批的第 1 条' : '固定示例;生成后这里显示你实际拿到的第一条';
  }

  // ================= 列表 / 统计 =================
  function rowTags(it) {
    if (it.kind === 'v4') return ['122 bit 随机'];
    if (it.kind === 'sid') {
      var a = alphabetFor();
      return [st.sidLen + ' 位 · ' + Math.round(alphaBits(st.sidLen, a.length)) + ' bit'];
    }
    if (it.mono) return [it.kind === 'ulid' ? '同毫秒 · 随机部分 +1' : '同毫秒 · 计数器递增'];
    return [fmtClock(it.ms)];
  }
  function buildRow(it, i) {
    var el = document.createElement('div');
    el.className = 'it';
    var idx = document.createElement('span');
    idx.className = 'uu-idx';
    idx.textContent = String(i + 1);
    var v = document.createElement('span');
    v.className = 'grow mono';
    var shown = displayValue(it);
    v.textContent = shown;
    v.title = shown;
    el.appendChild(idx);
    el.appendChild(v);
    var k = document.createElement('span');
    k.className = 'tag';
    k.textContent = KIND_LABEL[it.kind];
    el.appendChild(k);
    var tags = rowTags(it);
    for (var t = 0; t < tags.length; t++) {
      var g = document.createElement('span');
      g.className = 'tag' + (it.mono ? ' ok' : '');
      g.textContent = tags[t];
      el.appendChild(g);
    }
    var b = document.createElement('button');
    b.className = 'btn xs';
    b.textContent = '复制';
    b.addEventListener('click', function () { OC.copy(displayValue(it), '已复制'); });
    el.appendChild(b);
    return el;
  }
  function renderList() {
    var list = $('#uu-list');
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="empty">改上面的设置或点「生成」,结果会列在这里</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) frag.appendChild(buildRow(items[i], i));
    list.appendChild(frag);
  }
  function stat(k, v) {
    return '<div class="stat"><div class="k">' + OC.esc(k) + '</div><div class="v">' + OC.esc(v) + '</div></div>';
  }
  function updateStats() {
    var a = alphabetFor();
    var bits = st.kind === 'sid' ? Math.round(alphaBits(st.sidLen, a.length))
      : (st.kind === 'v4' ? 122 : st.kind === 'v7' ? 74 : 80);
    var html = stat('条数', items.length)
      + stat('类型', KIND_LABEL[st.kind] || st.kind)
      + stat('随机位', '约 ' + bits + ' bit')
      + stat('随机源', CRYPTO_OK ? 'crypto.getRandomValues' : '不可用');
    if (st.kind === 'sid') html += stat('字母表', a.length + ' 个字符');
    $('#uu-stats').innerHTML = html;
    $('#uu-tag').textContent = items.length + ' 条';
  }
  function generate(announce) {
    collect();
    if (!CRYPTO_OK) {
      items = [];
      renderList();
      updateStats();
      OC.say('#uu-out-msg', '当前环境没有 crypto.getRandomValues,出于安全考虑不生成 ID', 'bad');
      return;
    }
    var n = st.count;
    items = [];
    for (var i = 0; i < n; i++) {
      if (st.kind === 'v4') {
        items.push({ kind: 'v4', value: newV4() });
      } else if (st.kind === 'v7') {
        var r7 = newV7();
        items.push({ kind: 'v7', value: r7.value, ms: r7.ms, mono: r7.mono });
      } else if (st.kind === 'ulid') {
        var ru = newUlid();
        items.push({ kind: 'ulid', value: ru.value, ms: ru.ms, mono: ru.mono });
      } else {
        items.push({ kind: 'sid', value: nanoId(st.sidLen, alphabetFor()) });
      }
    }
    renderList();
    updateStats();
    syncPreview();
    if (announce) OC.say('#uu-out-msg', '已生成 ' + n + ' 条', 'ok');
  }
  function live() {
    if (!ready) return;
    clearTimeout(genTimer);
    genTimer = setTimeout(function () { generate(false); }, 140);
  }
  function reformat() { collect(); syncVisibility(); renderList(); syncPreview(); }
  function lines() {
    var out = [];
    for (var i = 0; i < items.length; i++) out.push(displayValue(items[i]));
    return out;
  }

  // ================= 校验与解析 =================
  function stripPrefix(s) {
    var t = s, steps = [];
    if (/^urn:uuid:/i.test(t)) { t = t.slice(9); steps.push('去掉 urn:uuid: 前缀'); }
    if (t.length >= 2 && t.charAt(0) === '{' && t.charAt(t.length - 1) === '}') { t = t.slice(1, -1); steps.push('去掉花括号'); }
    return { core: t.replace(/^\s+|\s+$/g, ''), steps: steps };
  }
  function crockVal(ch) {
    if (ch === 'I' || ch === 'L') return 1;    // Crockford 允许把 I/L 当 1
    if (ch === 'O') return 0;                  // O 当 0
    return CROCK.indexOf(ch);                  // 其余(U 等)不在表里,返回 -1
  }
  function tryParseUlid(core) {
    var up = core.toUpperCase(), vals = [], fixed = [];
    for (var i = 0; i < 26; i++) {
      var c = up.charAt(i), v = crockVal(c);
      if (v < 0) return { ok: false, fail: '第 ' + (i + 1) + ' 个字符 “' + core.charAt(i) + '” 不在 Crockford Base32 里(该字母表去掉了 I L O U)' };
      if (c === 'I' || c === 'L' || c === 'O') fixed.push(c);
      vals.push(v);
    }
    var t = 0;
    for (i = 0; i < 10; i++) t = t * 32 + vals[i];
    return { ok: true, ms: t, over: t >= 281474976710656, fixed: fixed };
  }
  function tryParseUuidCore(core) {
    var low = core.toLowerCase(), hx;
    if (low.indexOf('-') >= 0) {
      if (low.length !== 36) return { ok: false, fail: '带连字符的 UUID 应为 36 个字符(8-4-4-4-12),当前 ' + low.length + ' 个' };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(low)) {
        return { ok: false, fail: '连字符分组不对:标准写法是 8-4-4-4-12,每段只能是十六进制' };
      }
      hx = low.replace(/-/g, '');
    } else {
      if (low.length !== 32) return { ok: false, fail: '不像 UUID:去掉连字符后应为 32 位十六进制,当前 ' + low.length + ' 位(ULID 是固定 26 个字符)' };
      if (!/^[0-9a-f]{32}$/.test(low)) return { ok: false, fail: '含非十六进制字符(无连字符写法只允许 0-9 a-f)' };
      hx = low;
    }
    return { ok: true, hex: hx };
  }
  var VER_NOTE = {
    0: '版本位是 0,UUID 里 0 不是标准版本号',
    1: 'v1:60 位时间戳 + 节点(MAC 地址),可能暴露生成机器,注意隐私',
    2: 'v2:DCE 安全版本,含 POSIX UID 与时间戳(字段顺序与 v1 不同,未做时间解析)',
    3: 'v3:名字空间 + MD5 哈希,同样的输入必得同样的 ID,不含时间戳',
    4: 'v4:122 位纯随机,不含时间戳',
    5: 'v5:名字空间 + SHA-1 哈希,确定性生成,不含时间戳',
    6: 'v6:重排过的 v1,时间戳高位在前,便于按字典序排序',
    7: 'v7:48 位毫秒时间戳 + 74 位随机',
  };
  function analyzeUuid(hex) {
    var ver = parseInt(hex.charAt(12), 16);
    var vn = parseInt(hex.charAt(16), 16);
    var variantTag, variantFull;
    if ((vn & 0x8) === 0) { variantTag = 'NCS'; variantFull = 'NCS 反向兼容(0xxx)'; }
    else if ((vn & 0x4) === 0) { variantTag = 'RFC 4122'; variantFull = 'RFC 4122 / 9562(10xx)'; }
    else if ((vn & 0x2) === 0) { variantTag = '微软 GUID'; variantFull = '微软 GUID(110x)'; }
    else { variantTag = '保留'; variantFull = '保留(111x)'; }
    var tsMs = null, timeNote = '';
    if (ver === 1) {
      // v1:时间戳是 100ns 单位、起点 1582-10-15;time_low(32) + time_mid(16) + time_hi(12)
      var lo = parseInt(hex.slice(0, 8), 16), mid = parseInt(hex.slice(8, 12), 16), hi = parseInt(hex.slice(13, 16), 16);
      var ts100 = hi * 281474976710656 + mid * 4294967296 + lo;
      tsMs = ts100 / 10000 - UNIX_100NS_AT_1582;
      timeNote = 'v1 时间戳按 100ns 单位、1582-10-15 起点换算(展示到毫秒)';
    } else if (ver === 6) {
      // v6:同样是 100ns 时间戳,只是把高位放在最前面
      var h48 = parseInt(hex.slice(0, 12), 16), l12 = parseInt(hex.slice(13, 16), 16);
      tsMs = (h48 * 4096 + l12) / 10000 - UNIX_100NS_AT_1582;
      timeNote = 'v6 时间戳按 100ns 单位、1582-10-15 起点换算(高位在前)';
    } else if (ver === 7) {
      tsMs = parseInt(hex.slice(0, 12), 16);
      timeNote = 'v7 时间戳就是前 48 位毫秒数,Unix 毫秒直接读';
    }
    return { ver: ver, variantTag: variantTag, variantFull: variantFull, tsMs: tsMs, timeNote: timeNote };
  }
  function finishUuid(g, raw) {
    var a = analyzeUuid(g.hex);
    var notes = [];
    notes.push('变体 ' + a.variantFull);
    notes.push(VER_NOTE[a.ver] || ('版本 ' + a.ver + ',不在常用的 1/3/4/5/7 之列'));
    if (a.timeNote) notes.push(a.timeNote);
    if (a.variantTag !== 'RFC 4122') notes.push('变体位不是 RFC 4122 / 9562,严格说不是标准 UUID');
    var time = null;
    if (a.tsMs != null) {
      time = fmtFull(a.tsMs) + '(' + relTime(a.tsMs) + ')';
      var now = Date.now();
      if (a.tsMs < 0 || a.tsMs > now + 31536000000) notes.push('解析出的时间不在合理范围(1970 年之前或一年以后),可能是随机数据或时钟异常');
    }
    return {
      ok: true, raw: raw, kind: 'UUID' + (a.ver >= 1 && a.ver <= 8 ? ' v' + a.ver : ''),
      display: hyphen(g.hex),
      tags: ['版本 ' + a.ver, '变体 ' + a.variantTag],
      time: time, note: notes.join(';'),
    };
  }
  function finishUlid(u, core, raw) {
    if (!u.ok) return { ok: false, raw: core, fail: u.fail };
    var tags = ['Crockford Base32', '26 字符', '80 bit 随机'];
    var notes = [];
    if (core !== core.toUpperCase()) notes.push('已转成全大写规范形式');
    if (u.fixed.length) notes.push('含易混字符 ' + u.fixed.join(' ') + ',按 Crockford 规则归一(I/L→1、O→0)');
    notes.push('前 10 位是 48 位毫秒时间戳,后 16 位随机;字典序与时间序一致');
    if (u.over) {
      tags.push('时间戳超 48 位');
      notes.push('时间戳部分超过 48 位,不是标准 ULID(正常前 10 位最大是字符 7ZZZZZZZZZ)');
    }
    var time = fmtFull(u.ms) + '(' + relTime(u.ms) + ')';
    var now = Date.now();
    if (u.ms < 0 || u.ms > now + 31536000000) notes.push('解析出的时间不在合理范围,可能是随机数据或时钟异常');
    return { ok: true, raw: raw, kind: 'ULID', display: core.toUpperCase(), tags: tags, time: time, note: notes.join(';') };
  }
  /** 按规范形式判断一个(已去掉 urn/花括号的)字符串。 */
  function tryCore(core) {
    if (core.length === 26 && /^[0-9A-Za-z]{26}$/.test(core)) return finishUlid(tryParseUlid(core), core, core);
    var g = tryParseUuidCore(core);
    if (g.ok) return finishUuid(g, core);
    return { ok: false, raw: core, fail: g.fail };
  }
  function parseOne(raw) {
    var s = String(raw == null ? '' : raw).replace(/^\s+|\s+$/g, '');
    if (!s) return null;
    if (s.length > MAX_PARSE_LEN) return { ok: false, raw: s.slice(0, 60) + '…', fail: '输入过长:单个标识符不应超过 ' + MAX_PARSE_LEN + ' 个字符' };
    var sp = stripPrefix(s);
    var core = sp.core;
    if (!core) return { ok: false, raw: s, fail: '去掉前缀/花括号后没有内容' };
    var r = tryCore(core);
    var ignoredSpace = false;
    if (!r.ok) {
      // 从网页/文档里粘过来常夹着换行与不间断空格:把空白全部去掉后若能成立,就按成立处理
      var alt = core.replace(/\s+/g, '');
      if (alt && alt !== core) {
        var r2 = tryCore(alt);
        if (r2.ok) { r = r2; ignoredSpace = true; }
      }
    }
    if (r.ok) {
      if (ignoredSpace) r.note = '已忽略输入里的空白字符;' + r.note;
      if (sp.steps.length) r.note = sp.steps.join('、') + ';' + r.note;
      r.raw = s;
      return r;
    }
    var fail = r.fail;
    var bare = core.replace(/\s+/g, '');
    if (bare.length >= 20 && bare.length <= 32 && /^[0-9A-Za-z]+$/.test(bare)) {
      fail += ';另外它也不是合法的 ULID(需要恰好 26 个 Crockford Base32 字符)';
    }
    return { ok: false, raw: s, fail: fail };
  }
  function addParRow(res, idx) {
    var row = document.createElement('div');
    row.className = 'uu-par';
    if (!res.ok) {
      row.innerHTML = '<div class="meta"><span class="tag bad">不合法</span>'
        + '<span class="uu-sub">第 ' + (idx + 1) + ' 个输入</span></div>'
        + '<div class="msg bad">' + OC.esc(res.fail) + '</div>'
        + '<div class="v">' + OC.esc(res.raw) + '</div>';
      return row;
    }
    var h = '<div class="meta"><span class="tag ok">合法</span>'
      + '<span class="tag brand">' + OC.esc(res.kind) + '</span>';
    for (var i = 0; i < res.tags.length; i++) h += '<span class="tag">' + OC.esc(res.tags[i]) + '</span>';
    h += '</div><div class="v">' + OC.esc(res.display) + '</div>';
    if (res.time) h += '<div class="msg">内嵌时间:' + OC.esc(res.time) + '</div>';
    if (res.note) h += '<div class="uu-sub">' + OC.esc(res.note) + '</div>';
    h += '<div class="row mt">'
      + '<button class="btn xs" data-a="canon">复制规范化形式</button>'
      + '<button class="btn xs ghost" data-a="orig">复制原文</button>'
      + '</div>';
    row.innerHTML = h;
    row.querySelector('[data-a=canon]').addEventListener('click', function () { OC.copy(res.display, '已复制规范化形式'); });
    row.querySelector('[data-a=orig]').addEventListener('click', function () { OC.copy(res.raw, '已复制原文'); });
    return row;
  }
  function parseAll() {
    var list = $('#uu-par-list');
    list.innerHTML = '';
    var raw = $('#uu-par-in').value;
    var all = raw.split(/\r?\n/), linesArr = [], truncated = false;
    for (var i = 0; i < all.length; i++) {
      var s = all[i].replace(/^\s+|\s+$/g, '');
      if (!s) continue;
      if (linesArr.length >= MAX_PARSE_LINES) { truncated = true; break; }
      linesArr.push(s);
    }
    if (!linesArr.length) {
      list.innerHTML = '<div class="empty">粘进来就会自动判断:格式是否合法、版本号、变体位,并对 v1 / v6 / v7 与 ULID 解析出内嵌时间戳</div>';
      OC.say('#uu-par-msg', '');
      return;
    }
    var frag = document.createDocumentFragment(), ok = 0, bad = 0;
    for (i = 0; i < linesArr.length; i++) {
      var res = parseOne(linesArr[i]);
      if (!res) continue;
      if (res.ok) ok++; else bad++;
      frag.appendChild(addParRow(res, i));
    }
    list.appendChild(frag);
    OC.say('#uu-par-msg',
      '共 ' + linesArr.length + ' 个输入:合法 ' + ok + (bad ? ',不合法 ' + bad : '') + (truncated ? ';只解析了前 ' + MAX_PARSE_LINES + ' 个' : ''),
      bad ? 'warn' : 'ok');
  }
  function livePar() {
    clearTimeout(parTimer);
    parTimer = setTimeout(parseAll, 140);
  }

  // ================= 接线 =================
  function wire() {
    OC.enhanceSelects(document);
    OC.seg('#uu-kind', function () { collect(); syncVisibility(); updateAlphaInfo(); live(); });
    OC.seg('#uu-case', reformat);
    OC.range('#uu-count', function (v) {
      $('#uu-count-n').value = v;
      st.count = Number(v) || 10;
      live();
    });
    OC.range('#uu-sidlen', function (v) {
      st.sidLen = Number(v) || 21;
      updateAlphaInfo();
      live();
    });
    $('#uu-count-n').addEventListener('input', function () {
      var v = Math.max(1, Math.min(200, Math.round(Number(this.value) || 1)));
      var r = $('#uu-count');
      if (Number(r.value) !== v) { r.value = v; r.dispatchEvent(new Event('input')); }
    });
    $('#uu-count-n').addEventListener('change', function () {
      this.value = Math.max(1, Math.min(200, Math.round(Number(this.value) || 1)));
    });
    $$('[data-count]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = Number(b.getAttribute('data-count'));
        var r = $('#uu-count');
        r.value = v;
        r.dispatchEvent(new Event('input'));
        $('#uu-count-n').value = v;
        generate(true);
      });
    });
    ['#uu-nohyphen', '#uu-braces', '#uu-urn', '#uu-ulid-lower'].forEach(function (sel) {
      $(sel).addEventListener('change', reformat);
    });
    $('#uu-mono').addEventListener('change', function () { collect(); syncVisibility(); live(); });
    $('#uu-alpha').addEventListener('change', function () { collect(); syncVisibility(); updateAlphaInfo(); live(); });
    $('#uu-sid-confuse').addEventListener('change', function () { collect(); updateAlphaInfo(); live(); });
    $('#uu-alpha-custom').addEventListener('input', function () { collect(); updateAlphaInfo(); live(); });

    $('#uu-gen').addEventListener('click', function () { generate(true); });
    $('#uu-again').addEventListener('click', function () { generate(true); OC.say('#uu-out-msg', '已换一批随机值', 'ok'); });
    $('#uu-clear').addEventListener('click', function () {
      items = [];
      renderList();
      updateStats();
      OC.say('#uu-out-msg', '');
    });
    $('#uu-copy-all').addEventListener('click', function () {
      if (!items.length) { OC.toast('还没有可复制的结果', 'bad'); return; }
      var l = lines();
      OC.copy(l.join('\n'), '已复制 ' + l.length + ' 条(每行一条)');
    });
    $('#uu-open-txt').addEventListener('click', function () {
      if (!items.length) { OC.toast('还没有可导出的结果', 'bad'); return; }
      var text = lines().join('\r\n') + '\r\n';
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      OC.openBlob(blob);
      OC.toast('已在新标签页打开,按 Ctrl+S 或右键另存为');
    });

    $('#uu-par-in').addEventListener('input', livePar);
    $('#uu-par-clear').addEventListener('click', function () {
      $('#uu-par-in').value = '';
      parseAll();
      $('#uu-par-in').focus();
    });
    $('#uu-par-demo').addEventListener('click', function () {
      $('#uu-par-in').value = [
        '0198f3c2-a7b4-7def-8891-c0ffee123456',
        '{0198F3C2A7B47DEF8891C0FFEE123456}',
        'urn:uuid:0191f2a3-4b5c-11ee-9f01-23456789abcd',
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        '0198f3c2-a7b4-4def-8891-c0ffee123456',
        '这一行不是合法的 ID',
      ].join('\n');
      parseAll();
      OC.toast('示例已填入,可直接看解析结果');
    });
  }

  wire();
  collect();
  syncVisibility();
  updateAlphaInfo();
  ready = true;
  generate(true);
  parseAll();

  // ================= 参数依据 =================
  // 1) 熵:v4 的 122 位 = 128 - 4(版本)- 2(变体);v7 的 74 位 = 128 - 48(时间)
  //    - 4(版本)- 2(变体);ULID 的 80 位 = 128 - 48(时间);短 ID = 长度 × log2(字母表大小)
  //    (默认 21 × log2(64) = 126 位)。
  // 2) 生日界:P ≈ 1 - exp(-n²/2N),取 P = 50% 得 n ≈ 1.1774·√N(√(2ln2) ≈ 1.17741)。
  //    v4:N = 2^122 ≈ 5.3169×10^36,√N = 2^61 = 2305843009213693952,
  //        n ≈ 1.17741 × 2.3058×10^18 ≈ 2.715×10^18 个;
  //        每秒 10^9 个 → 2.715×10^18 / 10^9 = 2.715×10^9 秒;
  //        1 年 = 365.2425 × 86400 = 31556952 秒 → 2.715×10^9 / 3.1557×10^7 ≈ 86.0 年。
  // 3) v7 同毫秒:随机部分是 74 位,但碰撞只在同一毫秒内有意义。
  //    每秒 10^9 个 = 每毫秒 10^6 个;同毫秒内近似 P ≈ n²/2^75
  //    = (10^6)² / 3.7779×10^22 = 10^12 / 3.7779×10^22 ≈ 2.65×10^-11。
  //    ULID 是 80 位随机:P ≈ 10^12 / 2^81 = 10^12 / 2.4179×10^24 ≈ 4.1×10^-13。
})();
UU_JS;

return array(
    'id' => 'uuid',
    'cat' => 'gen',
    'title' => 'UUID 与 ULID 生成',
    'body' => $body,
    'script' => $script,
);
