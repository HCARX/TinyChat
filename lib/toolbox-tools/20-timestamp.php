<?php
/**
 * 工具:时间戳转换。
 *
 * 一个页面把「时间戳 ↔ 时间」这件事做全:实时「现在」(秒/毫秒,隐藏页暂停)、时间戳转多种格式、
 * 时间文本反解、时区、批量、快捷时间点、时间差。
 *
 * 关键实现选择:
 *   - 单位识别按量级而不是位数硬编码(< 1e11 秒、< 1e14 毫秒、< 1e17 微秒、更大当纳秒),
 *     10/13/16 位自然落位,11/12/15 位这类「非标准位」也能猜对;也允许手动指定单位。
 *   - 时间文本解析不用 new Date(字符串) 兜底(各浏览器对 "2026-01-01 12:00:00" 与带时区 ISO
 *     的处理不一致),而是自己按 日期/时间/偏移 逐段构造:不带偏移按**本地时区**,带 Z / ±HH:MM
 *     按给定偏移,先做全角与中文(年月日时分秒)归一化,失败才落到浏览器解析并标注「按浏览器规则」。
 *   - 时区用 Intl.DateTimeFormat(...,{timeZone}) + formatToParts 反推偏移(比 getTimezoneOffset
 *     能表达任意时区),formatToParts 的 hour 用 hourCycle=h23 避免 "24 时"。
 *   - 「现在」用 setInterval(200ms) 而不是 rAF:rAF 在后台标签页仍可能以 1fps 空转,
 *     这里用 visibilitychange 显式停/起,页面隐藏时完全不占 CPU。
 *   - 沙箱里没有存储、不能落盘,所以复制一律走 OC.copy,不需要导出文件。
 */
$body = <<<'TCTS_BODY'
<style>
.it[hidden]{display:none}
.cols > .card + .card{margin-top:0}
.ts-big{font-family:var(--mono);font-size:1.36rem;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.ts-tbl-wrap{overflow:auto;max-height:440px;border-radius:var(--r)}
.ts-batch-in{display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.ts-sel{max-width:360px}
.ts-hint{font-size:.786rem;color:var(--t3)}
@media(max-width:640px){.ts-batch-in{max-width:120px}.ts-sel{max-width:100%}}
</style>

<div class="hd">
  <div class="grow">
    <h1>时间戳转换</h1>
    <div class="sub">Unix 时间戳与日期互转:秒 / 毫秒 / 微秒自动识别,多格式输出,时区、批量、快捷时间点与时间差都在这一页。</div>
  </div>
  <div class="acts">
    <button class="btn" id="ts-demo">填入示例</button>
    <button class="btn ghost" id="ts-clear">清空</button>
  </div>
</div>

<div class="cols">
  <div class="card span2">
    <div class="card-h">
      <h2>现在</h2>
      <span class="grow"></span>
      <span class="tag" id="ts-live-tag"><span class="dot"></span>实时刷新</span>
    </div>
    <div class="cols">
      <div class="f">
        <span class="lab">Unix 时间戳(秒)</span>
        <div class="row">
          <span class="ts-big" id="ts-now-s">—</span>
          <span class="sp"></span>
          <button class="btn xs" data-copy="#ts-now-s" data-ok="秒级时间戳已复制">复制</button>
        </div>
      </div>
      <div class="f">
        <span class="lab">Unix 时间戳(毫秒)</span>
        <div class="row">
          <span class="ts-big" id="ts-now-ms">—</span>
          <span class="sp"></span>
          <button class="btn xs" data-copy="#ts-now-ms" data-ok="毫秒级时间戳已复制">复制</button>
        </div>
      </div>
    </div>
    <div class="row mt">
      <span class="lab" style="margin:0;flex:0 0 auto">UTC ISO 8601</span>
      <span class="mono grow brk" id="ts-now-iso">—</span>
      <button class="btn xs" data-copy="#ts-now-iso" data-ok="ISO 8601 已复制">复制</button>
    </div>
    <div class="msg mt" id="ts-now-local"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>时间戳 → 时间</h2>
      <span class="grow"></span>
      <span class="msg" id="ts-t2h-msg"></span>
    </div>
    <div class="f">
      <span class="lab">时间戳</span>
      <div class="row">
        <input type="text" id="ts-t2h-in" class="mono" style="flex:1;min-width:150px" spellcheck="false" autocomplete="off" placeholder="1735689600 / 1735689600000 / 1735689600000000">
        <button class="btn" id="ts-t2h-now">用现在</button>
      </div>
    </div>
    <div class="f mt">
      <span class="lab">单位</span>
      <div class="seg" id="ts-t2h-unit">
        <button class="seg-btn on" data-v="auto">自动识别</button>
        <button class="seg-btn" data-v="s">秒</button>
        <button class="seg-btn" data-v="ms">毫秒</button>
        <button class="seg-btn" data-v="us">微秒</button>
      </div>
    </div>
    <div class="rows mt" id="ts-t2h-out"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>时间 → 时间戳</h2>
      <span class="grow"></span>
      <span class="msg" id="ts-h2t-msg"></span>
    </div>
    <div class="f">
      <span class="lab">时间文本</span>
      <input type="text" id="ts-h2t-in" class="mono" spellcheck="false" autocomplete="off" placeholder="2026-01-01 12:00:00 / 2026/1/1 12:00 / 2026-01-01T12:00:00+08:00">
    </div>
    <div class="it sel mt" id="ts-h2t-sum" hidden></div>
    <div class="rows mt" id="ts-h2t-out"></div>
    <div class="ts-hint mt">也接受:2026-01-01、12:30(今天)、now / 现在,以及纯数字时间戳。</div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>时区</h2>
      <span class="grow"></span>
      <span class="msg" id="ts-tz-msg"></span>
    </div>
    <div class="row">
      <select id="ts-tz" class="ts-sel" aria-label="时区">
        <option value="UTC">UTC</option>
        <option value="Asia/Shanghai" selected>Asia/Shanghai</option>
        <option value="Asia/Tokyo">Asia/Tokyo</option>
        <option value="America/New_York">America/New_York</option>
        <option value="Europe/London">Europe/London</option>
      </select>
    </div>
    <div class="rows mt" id="ts-tz-out"></div>
    <div class="ts-hint mt">列表来自 Intl.supportedValuesOf('timeZone');环境不支持时退回内置常用时区清单。</div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>时间差</h2>
      <span class="grow"></span>
      <span class="msg" id="ts-diff-msg"></span>
    </div>
    <div class="cols tight">
      <div class="f">
        <span class="lab">开始(时间戳或时间)</span>
        <input type="text" id="ts-diff-a" class="mono" spellcheck="false" autocomplete="off" placeholder="1735689600 或 2026-01-01 00:00:00">
      </div>
      <div class="f">
        <span class="lab">结束</span>
        <input type="text" id="ts-diff-b" class="mono" spellcheck="false" autocomplete="off" placeholder="1735689600 或 2026-01-01 00:00:00">
      </div>
    </div>
    <div class="row mt">
      <button class="btn sm" id="ts-diff-swap">交换</button>
      <button class="btn sm" id="ts-diff-nowA">开始 = 现在</button>
      <button class="btn sm" id="ts-diff-nowB">结束 = 现在</button>
    </div>
    <div class="msg mt" id="ts-diff-human"></div>
    <div class="stats mt" id="ts-diff-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>快捷时间点</h2>
      <span class="grow"></span>
      <span class="msg" id="ts-quick-msg"></span>
    </div>
    <div class="row" id="ts-quick-btns">
      <button class="btn sm" data-q="today">今天 0 点</button>
      <button class="btn sm" data-q="yest">昨天此时</button>
      <button class="btn sm" data-q="mon">本周一</button>
      <button class="btn sm" data-q="m1">本月 1 号</button>
      <button class="btn sm" data-q="m2">下月 1 号</button>
      <button class="btn sm" data-q="y1">明年今天</button>
    </div>
    <div class="rows mt tall" id="ts-quick-out"></div>
  </div>

  <div class="card span2">
    <div class="card-h">
      <h2>批量转换</h2>
      <span class="grow"></span>
      <span class="msg" id="ts-batch-msg"></span>
      <button class="btn sm" id="ts-batch-copy">复制结果</button>
      <button class="btn sm ghost" id="ts-batch-clear">清空</button>
    </div>
    <textarea id="ts-batch" class="wrap" spellcheck="false" placeholder="每行一个时间戳或时间,例如:&#10;1735689600&#10;1735689600000&#10;2026-01-01 12:00:00&#10;2026-01-01T12:00:00+08:00"></textarea>
    <div class="ts-tbl-wrap mt">
      <table>
        <thead><tr>
          <th class="num">#</th><th>输入</th><th>识别</th><th>本地时间</th><th class="num">时间戳(秒)</th><th>相对现在</th><th>状态</th>
        </tr></thead>
        <tbody id="ts-batch-body"></tbody>
      </table>
    </div>
    <div class="ts-hint mt">一行解析失败不影响其它行;失败行会在「状态」列给出原因。</div>
  </div>
</div>
TCTS_BODY;
$script = <<<'TCTS_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$, p2 = OC.p2, esc = OC.esc;
  var DAY = 86400000;
  var MAX_BATCH_LINES = 500;
  var MAX_BATCH_CHARS = 200000;
  var MAX_DATE_MS = 8.64e15;

  // ==================== 格式化 ====================
  function fmtLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' '
      + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
      + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  function fmtLocalSec(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' '
      + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function fmtUTC(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' '
      + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds())
      + '.' + String(d.getUTCMilliseconds()).padStart(3, '0') + ' UTC';
  }
  function isoUtc(ms) { return new Date(ms).toISOString(); }
  function isoLocal(ms) {
    var d = new Date(ms), off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-', a = Math.abs(off);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T'
      + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.'
      + String(d.getMilliseconds()).padStart(3, '0') + sign + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  }
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function rfc2822(ms) {
    var d = new Date(ms), off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-', a = Math.abs(off);
    return WD[d.getDay()] + ', ' + p2(d.getDate()) + ' ' + MO[d.getMonth()] + ' ' + d.getFullYear()
      + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
      + ' ' + sign + p2(Math.floor(a / 60)) + p2(a % 60);
  }
  function num(x) {
    if (!isFinite(x)) return String(x);
    return String(Math.round(x * 1000) / 1000);
  }
  function shorten(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function fmtOffset(min) {
    var sign = min < 0 ? '-' : '+', a = Math.abs(min);
    return 'UTC' + sign + Math.floor(a / 60) + (a % 60 ? ':' + p2(a % 60) : '');
  }
  function localTzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }
  function localTzLabel() {
    return fmtOffset(-new Date().getTimezoneOffset()) + ' ' + localTzName();
  }

  // 相对现在:「3 天前」/「2 小时后」,只取最大单位
  function humanRel(diffMs) {
    var abs = Math.abs(diffMs);
    if (abs < 1000) return '刚刚';
    var units = [[31536000000, '年'], [2592000000, '个月'], [DAY, '天'], [3600000, '小时'], [60000, '分钟'], [1000, '秒']];
    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i][0]) return Math.floor(abs / units[i][0]) + ' ' + units[i][1] + (diffMs < 0 ? '前' : '后');
    }
    return '刚刚';
  }
  // 时间差:多单位拼接「3 天 2 小时 15 分 4 秒」
  function humanDur(ms) {
    var abs = Math.abs(ms), d, h, m, s, rest;
    d = Math.floor(abs / DAY); rest = abs - d * DAY;
    h = Math.floor(rest / 3600000); rest -= h * 3600000;
    m = Math.floor(rest / 60000); rest -= m * 60000;
    s = Math.floor(rest / 1000); rest -= s * 1000;
    var parts = [];
    if (d) parts.push(d + ' 天');
    if (h) parts.push(h + ' 小时');
    if (m) parts.push(m + ' 分');
    if (s || !parts.length) parts.push(s + ' 秒');
    if (!d && !h && !m && s < 10 && rest > 0) parts.push(Math.floor(rest) + ' 毫秒');
    return parts.join(' ');
  }

  // ==================== 单位识别 ====================
  // 按量级猜单位,而不是钉死 10/13/16 位:10 位秒、13 位毫秒、16 位微秒都能自然落位,
  // 11/12/15 位这类非标准长度也不会猜错方向。
  function detectUnit(s) {
    var neg = s.charAt(0) === '-';
    var body = (s.charAt(0) === '+' || neg) ? s.slice(1) : s;
    if (body.indexOf('.') >= 0) return 's';
    var a = Math.abs(Number(s));
    if (!isFinite(a)) return null;
    if (a < 1e11) return 's';
    if (a < 1e14) return 'ms';
    if (a < 1e17) return 'us';
    return 'ns';
  }
  var UNIT_NAME = { s: '秒', ms: '毫秒', us: '微秒', ns: '纳秒' };
  function validMs(ms) {
    return typeof ms === 'number' && isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;
  }
  function tsToMs(raw, unit) {
    var s = String(raw).trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return { err: '不是纯数字时间戳(可带负号与小数)' };
    var n = Number(s);
    if (!isFinite(n)) return { err: '数字超出可精确表示的范围' };
    var detected = false, u = unit;
    if (!u || u === 'auto') { u = detectUnit(s); detected = true; }
    if (!u) return { err: '无法判断时间戳单位' };
    var ms = u === 's' ? n * 1000 : u === 'ms' ? n : u === 'us' ? n / 1000 : n / 1e6;
    if (!validMs(ms)) return { err: '时间戳超出可表示范围(约公元 ±27 万年)' };
    return { ms: ms, unit: u, detected: detected, digits: s.replace(/[^0-9]/g, '').length };
  }

  // ==================== 时间文本解析 ====================
  function toHalf(s) {
    return s.replace(/[\uFF10-\uFF19]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/\uFF1A/g, ':').replace(/\uFF0F/g, '/').replace(/\uFF0D/g, '-');
  }
  // 中文日期归一化:先把 时/分/秒 变成冒号再收拾边界,免得 "12时30分" 变成 "12:30:"
  function normalizeTime(s) {
    s = toHalf(s).trim();
    s = s.replace(/秒/g, '');
    s = s.replace(/[年月]/g, '-');
    s = s.replace(/[日号]/g, ' ');
    s = s.replace(/[时時點点]/g, ':');
    s = s.replace(/分/g, ':');
    s = s.replace(/[，,]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/[:\-]+$/, '').trim();
    return s;
  }
  function checkYMD(y, mo, d) {
    if (!(mo >= 1 && mo <= 12)) throw new Error('月份不合法:' + mo + '(应为 1-12)');
    if (!(d >= 1 && d <= 31)) throw new Error('日期不合法:' + d);
    var probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
      throw new Error('这一天不存在:' + y + '-' + mo + '-' + d + '(请检查该月天数)');
    }
  }
  function checkHMS(h, mi, se) {
    if (!(h >= 0 && h <= 23)) throw new Error('小时不合法:' + h + '(应为 0-23)');
    if (!(mi >= 0 && mi <= 59)) throw new Error('分钟不合法:' + mi);
    if (!(se >= 0 && se <= 59)) throw new Error('秒不合法:' + se);
  }
  function localMs(y, mo, d, h, mi, se, msPart) {
    return new Date(y, mo - 1, d, h, mi, se || 0, 0).getTime() + (Number(msPart) || 0);
  }
  var KIND = {
    'ts-s': '时间戳(秒)', 'ts-ms': '时间戳(毫秒)', 'ts-us': '时间戳(微秒)', 'ts-ns': '时间戳(纳秒)',
    'iso-z': 'ISO 8601(UTC)', 'iso-off': 'ISO 8601(带偏移)', 'local': '本地日期时间',
    'date': '只有日期(按本地 0 点)', 'time': '今天的时间', 'now': '当前时刻', 'loose': '按浏览器规则解析'
  };
  function parseTimeText(raw) {
    var orig = String(raw == null ? '' : raw).trim();
    if (!orig) throw new Error('请输入时间');
    if (orig.length > 120) throw new Error('输入过长,请控制在 120 字以内');
    var low = orig.toLowerCase();
    if (low === 'now' || orig === '现在' || orig === '此刻' || orig === '当前') return { ms: Date.now(), kind: 'now' };
    if (/^[+-]?\d+(\.\d+)?$/.test(orig)) {
      var t = tsToMs(orig, 'auto');
      if (t.err) throw new Error(t.err);
      return { ms: t.ms, kind: t.unit === 's' ? 'ts-s' : t.unit === 'ms' ? 'ts-ms' : t.unit === 'us' ? 'ts-us' : 'ts-ns' };
    }
    var s = normalizeTime(orig);
    var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,6}))?)?\s*(Z|z|[+-]\d{1,2}:?\d{2})$/.exec(s);
    if (m) {
      var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = m[6] ? +m[6] : 0;
      var frac = m[7] ? Number('0.' + m[7]) : 0;
      checkYMD(y, mo, d); checkHMS(h, mi, se);
      var tzs = m[8], offMin = 0;
      if (tzs !== 'Z' && tzs !== 'z') {
        var sg = tzs.charAt(0) === '-' ? -1 : 1;
        var rest = tzs.slice(1).replace(':', '');
        offMin = sg * (Number(rest.slice(0, Math.max(1, rest.length - 2))) * 60 + Number(rest.slice(-2)));
      }
      var msIso = Date.UTC(y, mo - 1, d, h, mi, se) + Math.round(frac * 1000) - offMin * 60000;
      return { ms: msIso, kind: (tzs === 'Z' || tzs === 'z') ? 'iso-z' : 'iso-off' };
    }
    m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,3}))?)?)?$/.exec(s);
    if (m) {
      var y2 = +m[1], mo2 = +m[2], d2 = +m[3];
      checkYMD(y2, mo2, d2);
      if (m[4] === undefined) return { ms: localMs(y2, mo2, d2, 0, 0, 0, 0), kind: 'date' };
      var h2 = +m[4], mi2 = +m[5], se2 = m[6] ? +m[6] : 0, fr2 = m[7] ? +m[7] : 0;
      checkHMS(h2, mi2, se2);
      return { ms: localMs(y2, mo2, d2, h2, mi2, se2, fr2), kind: 'local' };
    }
    m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,3}))?)?$/.exec(s);
    if (m) {
      var h3 = +m[1], mi3 = +m[2], se3 = m[3] ? +m[3] : 0, fr3 = m[4] ? +m[4] : 0;
      checkHMS(h3, mi3, se3);
      var now = new Date();
      return { ms: localMs(now.getFullYear(), now.getMonth() + 1, now.getDate(), h3, mi3, se3, fr3), kind: 'time' };
    }
    var dt = new Date(orig);
    if (!isNaN(dt.getTime())) return { ms: dt.getTime(), kind: 'loose' };
    throw new Error('无法识别这个格式,试试 2026-01-01 12:00:00 / 2026/1/1 / 2026-01-01T12:00:00+08:00 / 时间戳');
  }

  // ==================== 时区 ====================
  var tzFmtCache = {};
  var TZ_CN = {
    'UTC': '协调世界时', 'Asia/Shanghai': '上海', 'Asia/Chongqing': '重庆', 'Asia/Urumqi': '乌鲁木齐',
    'Asia/Hong_Kong': '香港', 'Asia/Macau': '澳门', 'Asia/Taipei': '台北', 'Asia/Tokyo': '东京',
    'Asia/Seoul': '首尔', 'Asia/Singapore': '新加坡', 'Asia/Bangkok': '曼谷', 'Asia/Kolkata': '加尔各答',
    'Asia/Dubai': '迪拜', 'Europe/Moscow': '莫斯科', 'Europe/Berlin': '柏林', 'Europe/Paris': '巴黎',
    'Europe/London': '伦敦', 'Europe/Lisbon': '里斯本', 'America/New_York': '纽约', 'America/Chicago': '芝加哥',
    'America/Denver': '丹佛', 'America/Los_Angeles': '洛杉矶', 'America/Sao_Paulo': '圣保罗',
    'Australia/Sydney': '悉尼', 'Pacific/Auckland': '奥克兰', 'Africa/Cairo': '开罗', 'Africa/Johannesburg': '约翰内斯堡'
  };
  var FALLBACK_TZ = ['UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul',
    'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/Moscow', 'Europe/Berlin',
    'Europe/Paris', 'Europe/London', 'Europe/Lisbon', 'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland', 'Africa/Cairo', 'Africa/Johannesburg'];
  // 用 formatToParts 在指定时区里取出「墙上时钟」,再和真实时刻相减得到偏移(分钟)
  function tzParts(tz, date) {
    var dtf = tzFmtCache[tz];
    if (!dtf) {
      dtf = tzFmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    var parts = dtf.formatToParts(date), o = {};
    for (var i = 0; i < parts.length; i++) if (parts[i].type !== 'literal') o[parts[i].type] = parts[i].value;
    return o;
  }
  function tzOffsetMinutes(tz, date) {
    var o = tzParts(tz, date);
    var asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
    var real = Math.floor(date.getTime() / 1000) * 1000;
    return Math.round((asUTC - real) / 60000);
  }
  function tzTime(tz, ms) {
    var o = tzParts(tz, new Date(ms));
    return o.year + '-' + o.month + '-' + o.day + ' ' + o.hour + ':' + o.minute + ':' + o.second;
  }
  function tzLabel(tz) { return TZ_CN[tz] ? TZ_CN[tz] + '(' + tz + ')' : tz; }

  // ==================== DOM 小工具 ====================
  var curTz = 'UTC';
  var batchRows = [];
  var quickMap = {};
  var tickTimer = 0, tickN = 0;

  function setText(sel, t) {
    var n = $(sel);
    if (n && n.textContent !== t) n.textContent = t;
  }
  function empty(box, text) {
    box.innerHTML = '<div class="empty">' + esc(text) + '</div>';
  }
  function copyBtn(label, value, ok) {
    var b = document.createElement('button');
    b.className = 'btn xs';
    b.textContent = label;
    b.addEventListener('click', function () { OC.copy(value, ok || '已复制'); });
    return b;
  }
  // 一行「标签 + 值 + 复制」。可选:copyBtns 多个复制按钮;id 时复制按钮走 data-copy 读实时文本
  function addRow(box, label, value, opts) {
    opts = opts || {};
    var it = document.createElement('div');
    it.className = 'it' + (opts.cls ? ' ' + opts.cls : '');
    var l = document.createElement('span');
    l.className = 'lab';
    l.style.margin = '0'; l.style.flex = '0 0 auto'; l.style.minWidth = opts.minWidth || '96px';
    l.textContent = label;
    var v = document.createElement('span');
    v.className = 'mono grow';
    v.style.whiteSpace = 'nowrap'; v.style.overflow = 'hidden'; v.style.textOverflow = 'ellipsis';
    v.textContent = value; v.title = value;
    if (opts.id) v.id = opts.id;
    if (opts.relMs != null) v.setAttribute('data-rel-ms', String(opts.relMs));
    it.appendChild(l); it.appendChild(v);
    if (opts.copyBtns && opts.copyBtns.length) {
      for (var i = 0; i < opts.copyBtns.length; i++) {
        it.appendChild(copyBtn(opts.copyBtns[i].label, opts.copyBtns[i].value, opts.copyBtns[i].ok));
      }
    } else {
      var b = document.createElement('button');
      b.className = 'btn xs';
      b.textContent = opts.btnLabel || '复制';
      if (opts.id) {
        b.setAttribute('data-copy', '#' + opts.id);
      } else {
        (function (val, ok) { b.addEventListener('click', function () { OC.copy(val, ok || '已复制'); }); })(
          opts.copyText != null ? opts.copyText : value, opts.okMsg);
      }
      it.appendChild(b);
    }
    box.appendChild(it);
    return it;
  }

  // ==================== 现在(实时) ====================
  function tick() {
    var now = Date.now();
    setText('#ts-now-s', String(Math.floor(now / 1000)));
    setText('#ts-now-ms', String(now));
    setText('#ts-now-iso', new Date(now).toISOString());
    setText('#ts-now-local', '本地时间 ' + fmtLocalSec(now) + '(' + localTzLabel() + ')');
    if (curTz) setText('#ts-tz-time', tzTime(curTz, now) + '.' + String(new Date(now).getMilliseconds()).padStart(3, '0'));
    if ((tickN++ % 5) === 0) refreshRel();
  }
  function refreshRel() {
    var now = Date.now();
    var els = document.querySelectorAll('[data-rel-ms]');
    for (var i = 0; i < els.length; i++) {
      var ms = Number(els[i].getAttribute('data-rel-ms'));
      if (isFinite(ms)) {
        var t = humanRel(ms - now);
        if (els[i].textContent !== t) els[i].textContent = t;
      }
    }
  }
  function liveTag(on) {
    var t = $('#ts-live-tag');
    if (!t) return;
    t.className = 'tag' + (on ? ' ok' : '');
    t.innerHTML = '<span class="dot"></span>' + (on ? '实时刷新' : '已暂停');
  }
  function startTick() { if (tickTimer) return; tick(); tickTimer = setInterval(tick, 200); liveTag(true); }
  function stopTick() { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; liveTag(false); }

  // ==================== 时间戳 → 时间 ====================
  function renderT2H() {
    var box = $('#ts-t2h-out');
    var raw = $('#ts-t2h-in').value.trim();
    box.innerHTML = '';
    if (!raw) { empty(box, '输入时间戳后这里显示多种格式'); OC.say('#ts-t2h-msg', ''); return; }
    if (raw.length > 40) { empty(box, '输入过长,时间戳不该有这么多字符'); OC.say('#ts-t2h-msg', '输入过长', 'bad'); return; }
    var unit = OC.segVal('#ts-t2h-unit') || 'auto';
    var r = tsToMs(raw, unit);
    if (r.err) { empty(box, r.err); OC.say('#ts-t2h-msg', r.err, 'bad'); return; }
    OC.say('#ts-t2h-msg', (r.detected ? '自动识别为 ' : '按指定单位 ') + UNIT_NAME[r.unit] + '(' + r.digits + ' 位数字)', 'ok');
    addRow(box, '本地时间', fmtLocal(r.ms) + '  ' + localTzLabel(), { minWidth: '100px' });
    addRow(box, 'UTC 时间', fmtUTC(r.ms));
    addRow(box, 'ISO 8601', isoUtc(r.ms));
    addRow(box, 'ISO(本地偏移)', isoLocal(r.ms));
    addRow(box, 'RFC 2822', rfc2822(r.ms));
    addRow(box, 'YYYY-MM-DD HH:mm:ss', fmtLocalSec(r.ms));
    addRow(box, '相对现在', humanRel(r.ms - Date.now()), { id: 'ts-t2h-rel', relMs: r.ms });
    addRow(box, 'Unix 秒', num(r.ms / 1000), { copyText: String(Math.round(r.ms / 1000)), okMsg: '秒级时间戳已复制' });
    addRow(box, 'Unix 毫秒', num(r.ms), { copyText: String(Math.round(r.ms)), okMsg: '毫秒级时间戳已复制' });
    addRow(box, 'Unix 微秒', num(r.ms * 1000), { copyText: String(Math.round(r.ms * 1000)), okMsg: '微秒级时间戳已复制' });
  }

  // ==================== 时间 → 时间戳 ====================
  function renderH2T() {
    var box = $('#ts-h2t-out');
    var sum = $('#ts-h2t-sum');
    var raw = $('#ts-h2t-in').value.trim();
    box.innerHTML = '';
    sum.hidden = true;
    if (!raw) { empty(box, '输入时间文本后这里显示解析结果'); OC.say('#ts-h2t-msg', ''); return; }
    var r;
    try { r = parseTimeText(raw); }
    catch (e) {
      var m = (e && e.message) || '解析失败';
      empty(box, m);
      OC.say('#ts-h2t-msg', m, 'bad');
      return;
    }
    OC.say('#ts-h2t-msg', '解析成功', 'ok');
    // 「我理解到的是什么时间」——把解析结果与命中规则摊开给用户看
    sum.hidden = false;
    sum.innerHTML = '<span class="mono grow" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
      + esc(fmtLocal(r.ms) + '(' + localTzLabel() + ')') + '</span>'
      + '<span class="tag brand">' + esc(KIND[r.kind] || '已解析') + '</span>'
      + '<button class="btn xs" id="ts-h2t-sumcopy">复制时间</button>';
    $('#ts-h2t-sumcopy').addEventListener('click', function () { OC.copy(fmtLocalSec(r.ms), '本地时间已复制'); });
    addRow(box, '理解到的时间', fmtLocal(r.ms), { copyText: fmtLocalSec(r.ms) });
    addRow(box, 'UTC 时间', fmtUTC(r.ms));
    addRow(box, 'ISO 8601', isoUtc(r.ms));
    addRow(box, 'ISO(本地偏移)', isoLocal(r.ms));
    addRow(box, 'RFC 2822', rfc2822(r.ms));
    addRow(box, '相对现在', humanRel(r.ms - Date.now()), { id: 'ts-h2t-rel', relMs: r.ms });
    addRow(box, '时间戳(秒)', num(r.ms / 1000), { copyText: String(Math.round(r.ms / 1000)), okMsg: '秒级时间戳已复制' });
    addRow(box, '时间戳(毫秒)', num(r.ms), { copyText: String(Math.round(r.ms)), okMsg: '毫秒级时间戳已复制' });
    addRow(box, '时间戳(微秒)', num(r.ms * 1000), { copyText: String(Math.round(r.ms * 1000)), okMsg: '微秒级时间戳已复制' });
  }

  // ==================== 时区 ====================
  function fillTz() {
    var sel = $('#ts-tz');
    var list = null;
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') list = Intl.supportedValuesOf('timeZone');
    } catch (e) { list = null; }
    if (!list || !list.length) list = FALLBACK_TZ.slice();
    var set = {};
    for (var i = 0; i < list.length; i++) set[list[i]] = 1;
    var pref = localTzName();
    var ordered = [];
    function add(t) {
      if (t && set[t] && ordered.indexOf(t) < 0) ordered.push(t);
    }
    add('UTC'); add(pref);
    for (var f = 0; f < FALLBACK_TZ.length; f++) add(FALLBACK_TZ[f]);
    for (var j = 0; j < list.length; j++) add(list[j]);
    var now = new Date(), html = [];
    for (var k = 0; k < ordered.length; k++) {
      var tz = ordered[k], label;
      try { label = (TZ_CN[tz] ? TZ_CN[tz] + ' ' : '') + tz + '(' + fmtOffset(tzOffsetMinutes(tz, now)) + ')'; }
      catch (e) { label = tz; }
      html.push('<option value="' + esc(tz) + '">' + esc(label) + '</option>');
    }
    sel.innerHTML = html.join('');
    sel.value = ordered.indexOf(pref) >= 0 ? pref : (ordered.indexOf('UTC') >= 0 ? 'UTC' : ordered[0]);
    // 原生 select 已被运行时换成自绘控件,换完选项要派发 change 让外层标签同步刷新
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function renderTz() {
    var sel = $('#ts-tz'), box = $('#ts-tz-out');
    curTz = sel.value || 'UTC';
    box.innerHTML = '';
    var now = Date.now();
    var off = tzOffsetMinutes(curTz, new Date(now));
    OC.say('#ts-tz-msg', tzLabel(curTz) + ' ' + fmtOffset(off), 'ok');
    addRow(box, '该时区时间', tzTime(curTz, now) + '.' + String(new Date(now).getMilliseconds()).padStart(3, '0'),
      { id: 'ts-tz-time', minWidth: '92px' });
    addRow(box, 'UTC 偏移', fmtOffset(off) + '(' + off + ' 分钟)', { copyText: fmtOffset(off) });
    var rel = off - (-new Date().getTimezoneOffset());
    addRow(box, '与本地时差', (rel > 0 ? '+' : '') + rel + ' 分钟');
  }

  // ==================== 时间差 ====================
  function stat(k, v) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }
  function renderDiff() {
    var a = $('#ts-diff-a').value.trim(), b = $('#ts-diff-b').value.trim();
    var hum = $('#ts-diff-human'), st = $('#ts-diff-stats');
    hum.className = 'msg mt'; hum.textContent = '';
    st.innerHTML = '';
    if (!a || !b) { OC.say('#ts-diff-msg', '两个时间都填上才能算差值'); return; }
    var ra, rb;
    try { ra = parseTimeText(a); } catch (e) { OC.say('#ts-diff-msg', '开始时间:' + e.message, 'bad'); return; }
    try { rb = parseTimeText(b); } catch (e) { OC.say('#ts-diff-msg', '结束时间:' + e.message, 'bad'); return; }
    OC.say('#ts-diff-msg', fmtLocalSec(ra.ms) + ' → ' + fmtLocalSec(rb.ms), 'ok');
    var diff = rb.ms - ra.ms;
    hum.textContent = '相差 ' + humanDur(diff)
      + (diff < 0 ? '(结束早于开始,反向 ' + humanDur(-diff) + ')' : '');
    hum.className = 'msg mt' + (diff < 0 ? ' warn' : '');
    st.innerHTML = stat('秒', num(diff / 1000)) + stat('分', num(diff / 60000))
      + stat('时', num(diff / 3600000)) + stat('天', num(diff / DAY));
  }

  // ==================== 快捷时间点 ====================
  function renderQuick() {
    var box = $('#ts-quick-out');
    box.innerHTML = '';
    var now = new Date();
    var y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
    var toMon = now.getDay() === 0 ? 6 : now.getDay() - 1;
    var items = [
      ['today', '今天 0 点', new Date(y, mo, d).getTime()],
      ['yest', '昨天此时', now.getTime() - DAY],
      ['mon', '本周一 0 点', new Date(y, mo, d - toMon).getTime()],
      ['m1', '本月 1 号 0 点', new Date(y, mo, 1).getTime()],
      ['m2', '下月 1 号 0 点', new Date(y, mo + 1, 1).getTime()],
      ['y1', '明年今天 0 点', new Date(y + 1, mo, d).getTime()]
    ];
    quickMap = {};
    for (var i = 0; i < items.length; i++) {
      var ms = items[i][2];
      quickMap[items[i][0]] = { label: items[i][1], ms: ms };
      addRow(box, items[i][1], fmtLocalSec(ms) + '   ' + Math.floor(ms / 1000), {
        minWidth: '104px',
        copyBtns: [
          { label: '复制秒', value: String(Math.floor(ms / 1000)), ok: '秒级时间戳已复制' },
          { label: '复制时间', value: fmtLocalSec(ms), ok: '时间已复制' }
        ]
      });
    }
    OC.say('#ts-quick-msg', '基准: ' + fmtLocalSec(now.getTime()), 'ok');
  }

  // ==================== 批量转换 ====================
  function renderBatch() {
    var raw = $('#ts-batch').value;
    var tbody = $('#ts-batch-body');
    var msg = $('#ts-batch-msg');
    batchRows = [];
    if (!raw.trim()) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty">每行一个时间戳或时间,这里会逐行给出解析结果</div></td></tr>';
      OC.say(msg, '');
      return;
    }
    var over = raw.length > MAX_BATCH_CHARS;
    var lines = (over ? raw.slice(0, MAX_BATCH_CHARS) : raw).split(/\r?\n/);
    var truncated = lines.length > MAX_BATCH_LINES;
    if (truncated) lines = lines.slice(0, MAX_BATCH_LINES);
    var html = [], okN = 0, badN = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var no = i + 1;
      try {
        var r;
        if (/^[+-]?\d+(\.\d+)?$/.test(line)) {
          var t = tsToMs(line, 'auto');
          if (t.err) throw new Error(t.err);
          r = { ms: t.ms, kind: t.unit === 's' ? 'ts-s' : t.unit === 'ms' ? 'ts-ms' : t.unit === 'us' ? 'ts-us' : 'ts-ns' };
        } else {
          r = parseTimeText(line);
        }
        okN++;
        batchRows.push({ i: no, input: line, kind: KIND[r.kind] || '', local: fmtLocalSec(r.ms), sec: Math.floor(r.ms / 1000), relMs: r.ms, ok: true });
        html.push('<tr><td class="num">' + no + '</td>'
          + '<td><span class="ts-batch-in" title="' + esc(line) + '">' + esc(shorten(line, 48)) + '</span></td>'
          + '<td>' + esc(KIND[r.kind] || '已解析') + '</td>'
          + '<td class="mono">' + esc(fmtLocalSec(r.ms)) + '</td>'
          + '<td class="num">' + Math.floor(r.ms / 1000) + '</td>'
          + '<td class="mono" data-rel-ms="' + r.ms + '">' + esc(humanRel(r.ms - Date.now())) + '</td>'
          + '<td><span class="tag ok">成功</span></td></tr>');
      } catch (e) {
        badN++;
        var m = (e && e.message) || '解析失败';
        batchRows.push({ i: no, input: line, ok: false, err: m });
        html.push('<tr><td class="num">' + no + '</td>'
          + '<td><span class="ts-batch-in" title="' + esc(line) + '">' + esc(shorten(line, 48)) + '</span></td>'
          + '<td>—</td><td>—</td><td class="num">—</td><td>—</td>'
          + '<td><span class="tag bad" title="' + esc(m) + '">' + esc(shorten(m, 26)) + '</span></td></tr>');
      }
    }
    tbody.innerHTML = html.length ? html.join('') : '<tr><td colspan="7"><div class="empty">没有有效行</div></td></tr>';
    var note = over ? ',输入过长只取前 20 万字符' : (truncated ? ',只处理前 ' + MAX_BATCH_LINES + ' 行' : '');
    OC.say(msg, '成功 ' + okN + ' 行' + (badN ? ',失败 ' + badN + ' 行' : '') + note, badN ? 'warn' : 'ok');
  }
  function copyBatch() {
    if (!batchRows.length) { OC.toast('还没有可复制的结果', 'bad'); return; }
    var out = ['序号\t输入\t识别\t本地时间\t时间戳(秒)\t相对现在\t状态'];
    for (var i = 0; i < batchRows.length; i++) {
      var r = batchRows[i];
      if (r.ok) out.push([r.i, r.input, r.kind, r.local, r.sec, humanRel(r.relMs - Date.now()), '成功'].join('\t'));
      else out.push([r.i, r.input, '', '', '', '', r.err].join('\t'));
    }
    OC.copy(out.join('\n'), '已复制 ' + batchRows.length + ' 行结果(Tab 分隔)');
  }

  // ==================== 事件 ====================
  function debounce(fn, wait) {
    var t = 0;
    return function () { clearTimeout(t); t = setTimeout(fn, wait); };
  }
  function nowSec() { return String(Math.floor(Date.now() / 1000)); }

  function wire() {
    OC.enhanceSelects(document);

    OC.seg('#ts-t2h-unit', renderT2H);
    $('#ts-t2h-in').addEventListener('input', debounce(renderT2H, 120));
    $('#ts-h2t-in').addEventListener('input', debounce(renderH2T, 120));
    $('#ts-batch').addEventListener('input', debounce(renderBatch, 140));
    $('#ts-diff-a').addEventListener('input', debounce(renderDiff, 140));
    $('#ts-diff-b').addEventListener('input', debounce(renderDiff, 140));
    $('#ts-tz').addEventListener('change', renderTz);

    $('#ts-t2h-now').addEventListener('click', function () { $('#ts-t2h-in').value = nowSec(); renderT2H(); });

    $('#ts-batch-copy').addEventListener('click', copyBatch);
    $('#ts-batch-clear').addEventListener('click', function () {
      $('#ts-batch').value = '';
      renderBatch();
      OC.toast('批量输入已清空');
    });

    $('#ts-diff-swap').addEventListener('click', function () {
      var a = $('#ts-diff-a').value;
      $('#ts-diff-a').value = $('#ts-diff-b').value;
      $('#ts-diff-b').value = a;
      renderDiff();
    });
    $('#ts-diff-nowA').addEventListener('click', function () { $('#ts-diff-a').value = nowSec(); renderDiff(); });
    $('#ts-diff-nowB').addEventListener('click', function () { $('#ts-diff-b').value = nowSec(); renderDiff(); });

    $('#ts-quick-btns').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      renderQuick();
      var q = quickMap[b.getAttribute('data-q')];
      if (q) OC.toast(q.label + ' = ' + Math.floor(q.ms / 1000));
    });

    $('#ts-demo').addEventListener('click', function () {
      $('#ts-t2h-in').value = '1735689600';
      OC.segSet('#ts-t2h-unit', 'auto');
      $('#ts-h2t-in').value = '2026-01-01 12:00:00';
      $('#ts-batch').value = [
        '1735689600',
        '1735689600000',
        '1735689600000000',
        '2026-01-01 12:00:00',
        '2026/1/1 12:00',
        '2026-01-01T12:00:00+08:00',
        '2026-01-01',
        '12:30',
        '这不是一个时间'
      ].join('\n');
      $('#ts-diff-a').value = '2026-01-01 00:00:00';
      $('#ts-diff-b').value = '2026-01-04 02:15:04';
      renderT2H(); renderH2T(); renderBatch(); renderDiff();
      OC.toast('示例已填入');
    });

    $('#ts-clear').addEventListener('click', function () {
      $('#ts-t2h-in').value = '';
      OC.segSet('#ts-t2h-unit', 'auto');
      $('#ts-h2t-in').value = '';
      $('#ts-batch').value = '';
      $('#ts-diff-a').value = '';
      $('#ts-diff-b').value = '';
      renderT2H(); renderH2T(); renderBatch(); renderDiff();
      OC.toast('已清空');
    });

    // 统一的 data-copy 委托:读元素当时的文本,「现在」这类实时值也能复制
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
      if (!b) return;
      var n = $(b.getAttribute('data-copy'));
      if (!n) return;
      OC.copy(n.value != null ? n.value : n.textContent, b.getAttribute('data-ok') || '已复制');
    });
  }

  // ==================== 初始化 ====================
  wire();
  fillTz();
  renderQuick();
  $('#ts-t2h-in').value = nowSec();
  $('#ts-diff-a').value = String(Math.floor((Date.now() - 90061000) / 1000));
  $('#ts-diff-b').value = nowSec();
  renderT2H();
  renderH2T();
  renderBatch();
  renderDiff();

  // 页面隐藏时不空转:显式停表,回到前台立刻补一次
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopTick(); else startTick();
  });
  if (!document.hidden) startTick();
})();
TCTS_JS;

return array(
    'id' => 'timestamp',
    'cat' => 'dev',
    'title' => '时间戳转换',
    'body' => $body,
    'script' => $script,
);
