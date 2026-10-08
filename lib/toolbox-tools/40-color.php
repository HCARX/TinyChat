<?php
/**
 * 工具:颜色转换与配色。
 *
 * 一个「输入即算」的颜色工作台:任意格式(HEX / HEX 简写 / HEX8 / RGB(A) / HSL / HSV / CMYK /
 * CSS 变量)都可编辑,改了立刻反推其余格式;再顺手把设计里最常用的几件事做完 —— 色阶生成、
 * 两色插值、WCAG 对比度检查与「一键把前景调到刚好达标」、互补/近似/三角/四角配色、CSS 渐变代码、
 * 常用色板。
 *
 * 关键实现选择:
 *   - 颜色一律在内部存成 {r,g,b,a},展示层才转成各种写法。任意一格编辑时按该格式反向解析回
 *     {r,g,b,a};解析器同时接受函数式写法(rgb(29 29 31 / .5)、hsl(210,100%,45%))与省略函数名
 *     的纯数值列表,减少「必须写得很标准」的摩擦。
 *   - 所有换算都用标准公式手写(见下方注释),不依赖任何库(沙箱里也拉不到 CDN)。
 *   - 对比度用 WCAG 2.x 的相对亮度:sRGB 先线性化(<=0.03928 除以 12.92,否则 ((c+0.055)/1.055)^2.4),
 *     再按 0.2126R + 0.7152G + 0.0722B 加权,两个亮度算 (L1+0.05)/(L2+0.05)。
 *   - 沙箱里没有存储与下载,所以「拿走结果」只有复制一条路(OC.copy);文件类导出本工具用不上。
 */
$body = <<<'TCCOLOR_BODY'
<style>
.cl-grid{display:flex;flex-direction:column;gap:6px}
.cl-fmt{display:flex;align-items:center;gap:8px}
.cl-fmt .lab{flex:0 0 76px;margin:0}
.cl-fmt input{flex:1;min-width:0;font-family:var(--mono)}
.cl-scale{display:grid;grid-template-columns:repeat(21,minmax(0,1fr));gap:3px}
.cl-cell{height:34px;border-radius:var(--r-xs);cursor:pointer;box-shadow:var(--sh-xs);transition:transform .1s}
.cl-cell:hover{transform:scale(1.09)}
.cl-cell.cur{box-shadow:0 0 0 2px var(--brand)}
.cl-scale-labels{display:flex;justify-content:space-between;color:var(--t3);font-size:.75rem}
.cl-sample{flex:1;min-width:190px;padding:10px 12px;border-radius:var(--r);font-weight:600;font-size:.929rem}
.cl-scheme{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:var(--r);background:var(--bg-soft)}
.cl-scheme + .cl-scheme{margin-top:6px}
.cl-scheme .nm{flex:0 0 44px;font-weight:600;font-size:.857rem}
.cl-sw{display:flex;gap:4px;flex:1;min-width:168px}
.cl-sw i{flex:1;height:34px;border-radius:var(--r-xs);cursor:pointer;box-shadow:var(--sh-xs);transition:transform .1s}
.cl-sw i:hover{transform:scale(1.09)}
.cl-pal-row + .cl-pal-row{margin-top:10px}
.cl-pal-name{font-size:.786rem;color:var(--t3);margin-bottom:4px}
.cl-pal{display:flex;flex-wrap:wrap;gap:4px}
.cl-pal i{width:30px;height:30px;border-radius:var(--r-xs);cursor:pointer;box-shadow:var(--sh-xs);transition:transform .1s}
.cl-pal i:hover{transform:scale(1.14)}
.cl-prev{padding:12px 14px;border-radius:var(--r);line-height:1.55;width:100%}
</style>

<div class="hd">
  <div class="grow">
    <h1>颜色转换与配色</h1>
    <div class="sub">任一格式输入即换算成其余全部格式;色阶、两色插值、WCAG 对比度与无障碍修正、配色方案、CSS 渐变都在这页完成。</div>
  </div>
  <div class="acts">
    <button class="btn" id="cl-random">随机颜色</button>
    <button class="btn" id="cl-reset">重置</button>
    <button class="btn accent" id="cl-copy-all">复制全部格式</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>当前颜色</h2>
      <span class="grow"></span>
      <span class="tag brand">取色器联动</span>
    </div>
    <div class="cf">
      <input type="color" id="cl-pick" value="#0071e3" aria-label="取色器">
      <input type="text" id="cl-hex" class="mono" value="#0071e3" spellcheck="false" aria-label="十六进制颜色">
      <button class="btn sm" id="cl-hex-copy">复制</button>
    </div>
    <div class="f mt">
      <span class="lab">不透明度 <b class="mono" id="cl-alpha-v">100</b>%</span>
      <input type="range" id="cl-alpha" data-out="#cl-alpha-v" min="0" max="100" step="1" value="100">
    </div>
    <div class="checker mt"><div class="swatch" id="cl-swatch" style="height:110px"></div></div>
    <div class="row mt">
      <span class="cl-sample" id="cl-sample-w">白色底上的示例文字 Aa 中</span>
      <span class="cl-sample" id="cl-sample-b">黑色底上的示例文字 Aa 中</span>
    </div>
    <div class="stats mt" id="cl-stats"></div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>颜色格式</h2>
      <span class="grow"></span>
      <span class="msg" id="cl-fmt-msg"></span>
    </div>
    <div class="cl-grid" id="cl-formats"></div>
    <div class="msg mt">每格都能改:改了按该格式反向解析,其余格实时重算。支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsv() / cmyk() 等写法,也接受省略函数名的纯数值。</div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>色阶</h2>
    <span class="grow"></span>
    <button class="btn sm" id="cl-scale-copy">复制全部</button>
  </div>
  <div class="msg">以当前色的 HSL 明度为中心,向两端各取 10 级(明度等间距,色相与饱和度不变)。点击任意色块复制该色值。</div>
  <div class="cl-scale-labels mt"><span>变暗 10</span><span>当前色</span><span>变亮 10</span></div>
  <div class="cl-scale mt" id="cl-scale"></div>

  <div class="card-h mt" style="margin-top:18px">
    <h2>两色插值</h2>
    <span class="grow"></span>
    <button class="btn sm" id="cl-mix-use">起点=当前色</button>
    <button class="btn sm" id="cl-mix-copy">复制全部</button>
  </div>
  <div class="cf">
    <input type="color" id="cl-mix1-c" value="#0071e3" aria-label="起点色">
    <input type="text" id="cl-mix1" class="mono" value="#0071e3" spellcheck="false">
    <span class="lab">→</span>
    <input type="color" id="cl-mix2-c" value="#ffffff" aria-label="终点色">
    <input type="text" id="cl-mix2" class="mono" value="#ffffff" spellcheck="false">
  </div>
  <div class="cl-scale mt" id="cl-mix"></div>
  <div class="msg mt">两端之间等间距取 9 个中间色(含两端共 11 格,按 sRGB 通道线性插值)。点击色块复制。</div>
</div>

<div class="card">
  <div class="card-h">
    <h2>对比度检查(WCAG)</h2>
    <span class="grow"></span>
    <div class="seg" id="cl-target">
      <button class="seg-btn" data-v="3">大字 3:1</button>
      <button class="seg-btn on" data-v="4.5">正文 4.5:1</button>
      <button class="seg-btn" data-v="7">AAA 7:1</button>
    </div>
    <button class="btn sm accent" id="cl-fix">一键修正前景</button>
  </div>
  <div class="cols tight">
    <div class="f">
      <span class="lab">前景色</span>
      <div class="cf">
        <input type="color" id="cl-fg-c" value="#0071e3" aria-label="前景取色器">
        <input type="text" id="cl-fg" class="mono" value="#0071e3" spellcheck="false">
      </div>
      <label class="row" style="gap:6px"><input type="checkbox" id="cl-fg-follow" checked> 前景跟随当前颜色</label>
    </div>
    <div class="f">
      <span class="lab">背景色</span>
      <div class="cf">
        <input type="color" id="cl-bg-c" value="#ffffff" aria-label="背景取色器">
        <input type="text" id="cl-bg" class="mono" value="#ffffff" spellcheck="false">
      </div>
      <div class="row" style="gap:6px">
        <button class="btn xs" data-bg="#ffffff">白底</button>
        <button class="btn xs" data-bg="#000000">黑底</button>
        <button class="btn xs" id="cl-bg-swap">前景/背景互换</button>
      </div>
    </div>
  </div>
  <div class="row mt">
    <span class="tag" id="cl-cr">对比度 —</span>
    <span class="tag" id="cl-aa-b" data-label="AA 正文 4.5:1">AA 正文 4.5:1</span>
    <span class="tag" id="cl-aa-l" data-label="AA 大字 3:1">AA 大字 3:1</span>
    <span class="tag" id="cl-aaa-b" data-label="AAA 正文 7:1">AAA 正文 7:1</span>
    <span class="tag" id="cl-aaa-l" data-label="AAA 大字 4.5:1">AAA 大字 4.5:1</span>
  </div>
  <div class="msg mt" id="cl-cr-msg"></div>
  <div class="pv mt"><div class="cl-prev" id="cl-prev">
    <div style="font-size:1.15rem;font-weight:650">大字示例 Large Text</div>
    <div style="font-size:.893rem">正文示例:这段文字用来检查前景与背景的对比度是否达到无障碍要求。The quick brown fox jumps over the lazy dog.</div>
  </div></div>
</div>

<div class="card">
  <div class="card-h"><h2>配色方案</h2><span class="grow"></span></div>
  <div id="cl-schemes"></div>
  <div class="msg mt">基于当前色的色相旋转生成;点单个色块复制该色,「复制 CSS 变量」或「复制 JSON」可整组带走。</div>
</div>

<div class="card">
  <div class="card-h">
    <h2>CSS 渐变</h2>
    <span class="grow"></span>
    <button class="btn sm" id="cl-g1-use">起点=当前色</button>
    <button class="btn sm" id="cl-g2-use">终点=当前色</button>
    <button class="btn sm accent" id="cl-grad-copy">复制 CSS</button>
  </div>
  <div class="cf">
    <input type="color" id="cl-g1-c" value="#0071e3" aria-label="渐变起点">
    <input type="text" id="cl-g1" class="mono" value="#0071e3" spellcheck="false">
    <span class="lab">→</span>
    <input type="color" id="cl-g2-c" value="#af52de" aria-label="渐变终点">
    <input type="text" id="cl-g2" class="mono" value="#af52de" spellcheck="false">
  </div>
  <div class="f mt">
    <span class="lab">角度 <b class="mono" id="cl-ang-v">90</b>°</span>
    <input type="range" id="cl-ang" data-out="#cl-ang-v" min="0" max="360" step="1" value="90">
  </div>
  <label class="row mt" style="gap:6px"><input type="checkbox" id="cl-g-mid"> 启用中间停靠点</label>
  <div class="row" id="cl-g-mid-row" hidden>
    <div class="cf">
      <input type="color" id="cl-gm-c" value="#7f7f7f" aria-label="中间色">
      <input type="text" id="cl-gm" class="mono" value="#7f7f7f" spellcheck="false">
    </div>
    <div class="f" style="flex:1;min-width:170px">
      <span class="lab">停靠位置 <b class="mono" id="cl-gm-v">50</b>%</span>
      <input type="range" id="cl-gm-pos" data-out="#cl-gm-v" min="0" max="100" step="1" value="50">
    </div>
  </div>
  <div class="swatch mt" id="cl-grad-prev" style="height:84px"></div>
  <div class="code mt" id="cl-grad-css"></div>
</div>

<div class="card">
  <div class="card-h"><h2>常用色板</h2><span class="grow"></span><span class="msg">点击色块设为当前色</span></div>
  <div id="cl-palettes"></div>
</div>
TCCOLOR_BODY;
$script = <<<'TCCOLOR_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ===================== 基础工具 =====================
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
  function hex2(n) { n = clamp(Math.round(n), 0, 255); return (n < 16 ? '0' : '') + n.toString(16); }
  function hexOf(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
  function rA(a) { return String(Math.round(a * 100) / 100); }
  function n1(x) { var v = Math.round(x * 10) / 10; return (v % 1 === 0) ? String(v) : v.toFixed(1); }
  // 带透明度时输出 rgba(),不透明时输出 HEX(便于直接粘进 CSS)
  function colorCss(c) { var a = (c.a == null ? 1 : c.a); return a >= 1 ? hexOf(c) : 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + rA(a) + ')'; }
  // ===================== 颜色模型换算 =====================
  // RGB 与 HSL / HSV 的关系:把 RGB 归一化到 0-1 后,max 决定明度(V=max,L=(max+min)/2),
  // 差值 delta=max-min 决定饱和度;色相由谁最大决定落在哪一段 60° 区间。
  // HSL 的 s 用除以 (1-|2L-1|) 而不是除以 max,这是它与 HSV 唯一的差别。
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0, s = 0, l = (max + min) / 2;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s * 100, l: l * 100 };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d) {
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: (max === 0 ? 0 : d / max) * 100, v: max * 100 };
  }
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; v = clamp(v, 0, 100) / 100;
    var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }
  // CMYK 是减色模型:k=1-max(r,g,b) 表示三通道共同被吸收的量;其余通道再按 (1-c-k) 归一。
  function rgbToCmyk(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var k = 1 - Math.max(r, g, b);
    if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
    return { c: (1 - r - k) / (1 - k) * 100, m: (1 - g - k) / (1 - k) * 100, y: (1 - b - k) / (1 - k) * 100, k: k * 100 };
  }
  function cmykToRgb(c, m, y, k) {
    c = clamp(c, 0, 100) / 100; m = clamp(m, 0, 100) / 100; y = clamp(y, 0, 100) / 100; k = clamp(k, 0, 100) / 100;
    return { r: Math.round(255 * (1 - c) * (1 - k)), g: Math.round(255 * (1 - m) * (1 - k)), b: Math.round(255 * (1 - y) * (1 - k)) };
  }

  // ===================== WCAG 相对亮度与对比度 =====================
  // sRGB 线性化:对每个通道除以 255 后,<= 0.03928 的走线性段(除以 12.92),
  // 否则走幂函数段 ((c+0.055)/1.055)^2.4 —— 这就是 WCAG 2.0/2.1 的定义。
  // 相对亮度 = 0.2126·R + 0.7152·G + 0.0722·B(人眼对绿最敏感)。
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function luminance(r, g, b) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
  // 对比度 =(较亮+0.05)/(较暗+0.05),范围 1:1 ~ 21:1。
  function contrast(l1, l2) { var a = Math.max(l1, l2), b = Math.min(l1, l2); return (a + 0.05) / (b + 0.05); }
  function contrastRgb(c1, c2) { return contrast(luminance(c1.r, c1.g, c1.b), luminance(c2.r, c2.g, c2.b)); }

  // ===================== 解析 =====================
  var NAMED = {
    white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff',
    yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080',
    silver: '#c0c0c0', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a',
    navy: '#000080', teal: '#008080', olive: '#808000', lime: '#00ff00', gold: '#ffd700',
    indigo: '#4b0082', violet: '#ee82ee', salmon: '#fa8072', tomato: '#ff6347', khaki: '#f0e68c'
  };
  function parseColor(s) {
    s = String(s == null ? '' : s).trim().toLowerCase();
    if (!s) return null;
    if (NAMED[s]) s = NAMED[s];
    var m = s.match(/^#?([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})$/);
    if (m) {
      var h = m[1], r, g, b, a = null;
      if (h.length === 3 || h.length === 4) {
        r = parseInt(h.charAt(0) + h.charAt(0), 16);
        g = parseInt(h.charAt(1) + h.charAt(1), 16);
        b = parseInt(h.charAt(2) + h.charAt(2), 16);
        if (h.length === 4) a = parseInt(h.charAt(3) + h.charAt(3), 16) / 255;
      } else {
        r = parseInt(h.substr(0, 2), 16);
        g = parseInt(h.substr(2, 2), 16);
        b = parseInt(h.substr(4, 2), 16);
        if (h.length === 8) a = parseInt(h.substr(6, 2), 16) / 255;
      }
      return { r: r, g: g, b: b, a: a };
    }
    var fm = s.match(/^(rgba?|hsla?|hsva?|hsb|hsv|cmyk)\s*\(([^)]*)\)$/);
    if (!fm) return null;
    var parts = fm[2].split(/[\s,\/]+/).filter(function (x) { return x !== ''; });
    var vals = [];
    for (var i = 0; i < parts.length; i++) {
      var v = parseFloat(parts[i]);
      if (isNaN(v)) return null;
      vals.push({ v: v, pct: /%$/.test(parts[i]) });
    }
    var fn = fm[1];
    if (fn === 'rgb' || fn === 'rgba') {
      if (vals.length < 3) return null;
      var rr = vals[0].pct ? vals[0].v * 255 / 100 : vals[0].v;
      var gg = vals[1].pct ? vals[1].v * 255 / 100 : vals[1].v;
      var bb = vals[2].pct ? vals[2].v * 255 / 100 : vals[2].v;
      var aa = null;
      if (vals.length > 3) aa = vals[3].pct ? vals[3].v / 100 : vals[3].v;
      return { r: clamp(Math.round(rr), 0, 255), g: clamp(Math.round(gg), 0, 255), b: clamp(Math.round(bb), 0, 255), a: (aa == null ? null : clamp(aa, 0, 1)) };
    }
    if (fn === 'hsl' || fn === 'hsla') {
      if (vals.length < 3) return null;
      var t = hslToRgb(vals[0].v, vals[1].v, vals[2].v);
      return { r: t.r, g: t.g, b: t.b };
    }
    if (fn === 'hsv' || fn === 'hsb' || fn === 'hsva') {
      if (vals.length < 3) return null;
      var t2 = hsvToRgb(vals[0].v, vals[1].v, vals[2].v);
      return { r: t2.r, g: t2.g, b: t2.b };
    }
    if (fn === 'cmyk') {
      if (vals.length < 4) return null;
      var t3 = cmykToRgb(vals[0].v, vals[1].v, vals[2].v, vals[3].v);
      return { r: t3.r, g: t3.g, b: t3.b };
    }
    return null;
  }
  function isNumericField(k) { return k === 'rgb' || k === 'rgba' || k === 'hsl' || k === 'hsv' || k === 'cmyk'; }
  // 省略函数名的纯数值:RGB 按 0-255,HSL/HSV 按 色相,饱和度%,明度/亮度%,CMYK 按四个百分比。
  function parseNums(k, str) {
    var parts = str.replace(/[()]/g, ' ').split(/[\s,\/]+/).filter(function (x) { return x !== ''; });
    var v = [];
    for (var i = 0; i < parts.length; i++) { var n = parseFloat(parts[i]); if (isNaN(n)) return null; v.push(n); }
    if (k === 'rgb' || k === 'rgba') {
      if (v.length < 3) return null;
      var a = v.length > 3 ? clamp(v[3], 0, 1) : null;
      return { r: clamp(Math.round(v[0]), 0, 255), g: clamp(Math.round(v[1]), 0, 255), b: clamp(Math.round(v[2]), 0, 255), a: a };
    }
    if (k === 'hsl') { if (v.length < 3) return null; var t = hslToRgb(v[0], v[1], v[2]); return { r: t.r, g: t.g, b: t.b }; }
    if (k === 'hsv') { if (v.length < 3) return null; var t2 = hsvToRgb(v[0], v[1], v[2]); return { r: t2.r, g: t2.g, b: t2.b }; }
    if (k === 'cmyk') { if (v.length < 4) return null; var t3 = cmykToRgb(v[0], v[1], v[2], v[3]); return { r: t3.r, g: t3.g, b: t3.b }; }
    return null;
  }
  function parseField(k, str) {
    str = String(str == null ? '' : str).trim();
    if (!str) return null;
    if (k === 'cssvar') {
      var mm = str.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/);
      return mm ? parseColor(mm[0]) : null;
    }
    var lower = str.toLowerCase();
    var fnForm = /^(rgba?|hsla?|hsva?|hsb|hsv|cmyk)\s*\(/.test(lower);
    if (!fnForm && isNumericField(k) && /^[-+0-9.,%\s]+$/.test(str)) return parseNums(k, str);
    var c = parseColor(str);
    if (c) return c;
    if (isNumericField(k)) return parseNums(k, str);
    return null;
  }

  // ===================== 状态 =====================
  var st = { r: 0, g: 113, b: 227, a: 1 };                 // 当前颜色
  var mix = { a: { r: 0, g: 113, b: 227 }, b: { r: 255, g: 255, b: 255 } };   // 两色插值
  var grad = { c1: { r: 0, g: 113, b: 227 }, c2: { r: 175, g: 82, b: 222 }, mid: { r: 127, g: 127, b: 127 } };
  var ctr = { fg: { r: 0, g: 113, b: 227 }, bg: { r: 255, g: 255, b: 255 } };   // 对比度前景/背景

  // ===================== 各格式输出 =====================
  var FORMATS = [
    { k: 'hex', label: 'HEX', list: false, get: function () { return hexOf(st); } },
    { k: 'hex3', label: 'HEX 简写', list: true, get: function () {
        var r = hex2(st.r), g = hex2(st.g), b = hex2(st.b);
        if (r.charAt(0) !== r.charAt(1) || g.charAt(0) !== g.charAt(1) || b.charAt(0) !== b.charAt(1)) return '';
        return '#' + r.charAt(0) + g.charAt(0) + b.charAt(0);
      } },
    { k: 'hex8', label: 'HEX8', list: true, get: function () { return hexOf(st) + hex2(st.a * 255); } },
    { k: 'rgb', label: 'RGB', list: true, get: function () { return 'rgb(' + st.r + ', ' + st.g + ', ' + st.b + ')'; } },
    { k: 'rgba', label: 'RGBA', list: true, get: function () { return 'rgba(' + st.r + ', ' + st.g + ', ' + st.b + ', ' + rA(st.a) + ')'; } },
    { k: 'hsl', label: 'HSL', list: true, get: function () { var c = rgbToHsl(st.r, st.g, st.b); return 'hsl(' + n1(c.h) + ', ' + n1(c.s) + '%, ' + n1(c.l) + '%)'; } },
    { k: 'hsv', label: 'HSV', list: true, get: function () { var c = rgbToHsv(st.r, st.g, st.b); return 'hsv(' + n1(c.h) + ', ' + n1(c.s) + '%, ' + n1(c.v) + '%)'; } },
    { k: 'cmyk', label: 'CMYK', list: true, get: function () { var c = rgbToCmyk(st.r, st.g, st.b); return 'cmyk(' + n1(c.c) + '%, ' + n1(c.m) + '%, ' + n1(c.y) + '%, ' + n1(c.k) + '%)'; } },
    { k: 'cssvar', label: 'CSS 变量', list: true, get: function () { return '--color: ' + ((st.a >= 1) ? hexOf(st) : 'rgba(' + st.r + ', ' + st.g + ', ' + st.b + ', ' + rA(st.a) + ')') + ';'; } }
  ];
  function fmtByKey(k) { for (var i = 0; i < FORMATS.length; i++) if (FORMATS[i].k === k) return FORMATS[i]; return null; }

  // ===================== 构建:格式行 =====================
  function buildFormats() {
    var box = $('#cl-formats');
    for (var i = 0; i < FORMATS.length; i++) FORMATS[i].inputs = [];
    // 顶部那个十六进制框也是「输入口」,不只用来显示。它的格式在 FORMATS 里是 list:false
    // (不重复出现在格式表里),所以下面那个只处理 list 行的循环不会给它接线 —— 单独接一次,
    // 逻辑与格式行里的输入框完全一致,否则用户在上面敲颜色会毫无反应。
    var hexIn = $('#cl-hex');
    fmtByKey('hex').inputs.push(hexIn);
    hexIn.addEventListener('input', function () {
      var got = parseField('hex', hexIn.value);
      if (!got) { OC.say('#cl-fmt-msg', '「HEX」看不懂这个写法', 'bad'); return; }
      applyParsed(got);
      OC.say('#cl-fmt-msg', '', '');
      schedule('hex');
    });
    hexIn.addEventListener('blur', function () { renderFormats(null); });
    $('#cl-hex-copy').addEventListener('click', function () { OC.copy(hexOf(st), '已复制 ' + hexOf(st)); });

    FORMATS.forEach(function (f) {
      if (!f.list) return;
      var row = document.createElement('div');
      row.className = 'cl-fmt';
      var lab = document.createElement('span');
      lab.className = 'lab';
      lab.textContent = f.label;
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.spellcheck = false;
      inp.className = 'mono';
      inp.setAttribute('aria-label', f.label);
      var btn = document.createElement('button');
      btn.className = 'btn xs';
      btn.textContent = '复制';
      row.appendChild(lab); row.appendChild(inp); row.appendChild(btn);
      box.appendChild(row);
      f.inputs.push(inp);
      f.btn = btn;
      btn.addEventListener('click', function () {
        var v = f.get();
        if (!v) { OC.toast('当前颜色无法用「' + f.label + '」表示', 'bad'); return; }
        OC.copy(v, '已复制 ' + v);
      });
      inp.addEventListener('input', function () {
        var got = parseField(f.k, inp.value);
        if (!got) { OC.say('#cl-fmt-msg', '「' + f.label + '」看不懂这个写法', 'bad'); return; }
        applyParsed(got);
        OC.say('#cl-fmt-msg', '', '');
        schedule(f.k);
      });
      inp.addEventListener('blur', function () { renderFormats(null); });
    });
  }
  function applyParsed(got) {
    st.r = clamp(Math.round(got.r), 0, 255);
    st.g = clamp(Math.round(got.g), 0, 255);
    st.b = clamp(Math.round(got.b), 0, 255);
    if (got.a != null) st.a = clamp(got.a, 0, 1);
  }
  function renderFormats(skip) {
    FORMATS.forEach(function (f) {
      var v = f.get();
      if (f.k !== skip) {
        for (var i = 0; i < f.inputs.length; i++) {
          f.inputs[i].value = v;
          if (f.k === 'hex3') f.inputs[i].placeholder = v ? '' : '此色无法简写为 3 位';
        }
      }
      if (f.btn) {
        var dis = (f.k === 'hex3' && !v);
        f.btn.disabled = dis;
        f.btn.classList.toggle('disabled', dis);
      }
    });
  }

  // ===================== 渲染:当前色 =====================
  function renderSwatch() {
    var css = 'rgba(' + st.r + ',' + st.g + ',' + st.b + ',' + rA(st.a) + ')';
    $('#cl-swatch').style.background = css;
    $('#cl-sample-w').style.color = hexOf(st);
    $('#cl-sample-b').style.color = hexOf(st);
    var p = $('#cl-pick');
    var h = hexOf(st);
    if (p.value !== h) p.value = h;
  }
  function renderStats() {
    var lum = luminance(st.r, st.g, st.b);
    var cw = contrast(lum, luminance(255, 255, 255));
    var cb = contrast(lum, luminance(0, 0, 0));
    var hsl = rgbToHsl(st.r, st.g, st.b);
    function stat(k, v) { return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
    $('#cl-stats').innerHTML =
      stat('相对亮度', lum.toFixed(4)) +
      stat('对比 白', cw.toFixed(2) + ':1') +
      stat('对比 黑', cb.toFixed(2) + ':1') +
      stat('色相角', n1(hsl.h) + '°') +
      stat('饱和度', n1(hsl.s) + '%') +
      stat('明度', n1(hsl.l) + '%');
  }
  function alphaVisual() {
    var r = $('#cl-alpha');
    r.value = Math.round(st.a * 100);
    r.style.setProperty('--p', (st.a * 100) + '%');
    $('#cl-alpha-v').textContent = Math.round(st.a * 100);
  }

  // ===================== 渲染:色阶 =====================
  function cell(c, title) {
    var h = hexOf(c);
    var cur = (h === hexOf(st)) ? ' cur' : '';
    return '<div class="cl-cell' + cur + '" data-hex="' + h + '" title="' + title + ' · ' + h + '" style="background:' + h + '"></div>';
  }
  function renderScale() {
    var hsl = rgbToHsl(st.r, st.g, st.b);
    var out = [], i, l, c;
    for (i = 10; i >= 1; i--) {
      l = hsl.l * (1 - i / 11);
      c = hslToRgb(hsl.h, hsl.s, l);
      out.push(cell(c, '变暗 ' + i + ' 级 · L ' + n1(l) + '%'));
    }
    out.push('<div class="cl-cell cur" data-hex="' + hexOf(st) + '" title="当前色 · ' + hexOf(st) + '" style="background:' + hexOf(st) + '"></div>');
    for (i = 1; i <= 10; i++) {
      l = hsl.l + (100 - hsl.l) * (i / 11);
      c = hslToRgb(hsl.h, hsl.s, l);
      out.push(cell(c, '变亮 ' + i + ' 级 · L ' + n1(l) + '%'));
    }
    $('#cl-scale').innerHTML = out.join('');
  }
  function scaleHexes() {
    var hsl = rgbToHsl(st.r, st.g, st.b), out = [], i;
    for (i = 10; i >= 1; i--) out.push(hexOf(hslToRgb(hsl.h, hsl.s, hsl.l * (1 - i / 11))));
    out.push(hexOf(st));
    for (i = 1; i <= 10; i++) out.push(hexOf(hslToRgb(hsl.h, hsl.s, hsl.l + (100 - hsl.l) * (i / 11))));
    return out;
  }

  // ===================== 渲染:两色插值 =====================
  function mixHexes() {
    var out = [];
    for (var i = 0; i <= 10; i++) {
      var t = i / 10;
      out.push(hexOf({
        r: Math.round(mix.a.r + (mix.b.r - mix.a.r) * t),
        g: Math.round(mix.a.g + (mix.b.g - mix.a.g) * t),
        b: Math.round(mix.a.b + (mix.b.b - mix.a.b) * t)
      }));
    }
    return out;
  }
  function renderMix() {
    var hs = mixHexes(), out = [];
    for (var i = 0; i < hs.length; i++) {
      var cur = (hs[i] === hexOf(st)) ? ' cur' : '';
      out.push('<div class="cl-cell' + cur + '" data-hex="' + hs[i] + '" title="' + Math.round(i / 10 * 100) + '% · ' + hs[i] + '" style="background:' + hs[i] + '"></div>');
    }
    $('#cl-mix').innerHTML = out.join('');
  }

  // ===================== 渲染:对比度 =====================
  function target() { return Number(OC.segVal('#cl-target')) || 4.5; }
  function tgl(sel, ok) {
    var e = $(sel);
    var base = e.getAttribute('data-label') || e.textContent;
    e.setAttribute('data-label', base);
    e.textContent = base + (ok ? ' ✓' : ' ✗');
    e.className = 'tag ' + (ok ? 'ok' : 'bad');
  }
  // 调前景:保持色相与饱和度,只沿着「变暗」或「变亮」两个方向逐 1% 试明度,
  // 取第一个刚好达标的;两个方向都到不了就取对比度最高的那个作为建议。
  function fixColor(fg, bg, tgt) {
    var hsl = rgbToHsl(fg.r, fg.g, fg.b);
    var lb = luminance(bg.r, bg.g, bg.b);
    var results = [];
    [-1, 1].forEach(function (dir) {
      var best = null;
      var limit = dir < 0 ? Math.ceil(hsl.l) : Math.ceil(100 - hsl.l);
      for (var i = 1; i <= limit; i++) {
        var l = hsl.l + dir * i;
        if (l < 0 || l > 100) break;
        var rgb = hslToRgb(hsl.h, hsl.s, l);
        var cr = contrast(luminance(rgb.r, rgb.g, rgb.b), lb);
        if (!best || cr > best.cr) best = { rgb: rgb, cr: cr, i: i, darken: dir < 0 };
        if (cr >= tgt) { best = { rgb: rgb, cr: cr, i: i, hit: true, darken: dir < 0 }; break; }
      }
      if (best) results.push(best);
    });
    if (!results.length) return null;
    var hits = results.filter(function (r) { return r.hit; });
    if (hits.length) { hits.sort(function (a, b) { return a.i - b.i; }); return hits[0]; }
    results.sort(function (a, b) { return b.cr - a.cr; });
    return results[0];
  }
  function renderContrast() {
    var cr = contrastRgb(ctr.fg, ctr.bg);
    var el = $('#cl-cr');
    el.textContent = '对比度 ' + cr.toFixed(2) + ':1';
    el.className = 'tag ' + (cr >= 4.5 ? 'ok' : 'bad');
    tgl('#cl-aa-b', cr >= 4.5);
    tgl('#cl-aa-l', cr >= 3);
    tgl('#cl-aaa-b', cr >= 7);
    tgl('#cl-aaa-l', cr >= 4.5);
    var prev = $('#cl-prev');
    prev.style.background = hexOf(ctr.bg);
    prev.style.color = hexOf(ctr.fg);
    var tgt = target();
    if (cr >= tgt) {
      OC.say('#cl-cr-msg', '当前对比度 ' + cr.toFixed(2) + ':1,已达所选目标 ' + tgt + ':1。', 'ok');
    } else {
      var fx = fixColor(ctr.fg, ctr.bg, tgt);
      if (fx && fx.hit) {
        OC.say('#cl-cr-msg', '当前 ' + cr.toFixed(2) + ':1,未达 ' + tgt + ':1;把前景' + (fx.darken ? '调暗' : '调亮') + '到 ' + hexOf(fx.rgb) + ' 可达 ' + fx.cr.toFixed(2) + ':1,可点「一键修正前景」。', 'warn');
      } else if (fx) {
        OC.say('#cl-cr-msg', '当前 ' + cr.toFixed(2) + ':1,未达 ' + tgt + ':1;这个背景色下最多只能到 ' + fx.cr.toFixed(2) + ':1(' + hexOf(fx.rgb) + '),建议换背景色。', 'bad');
      } else {
        OC.say('#cl-cr-msg', '当前 ' + cr.toFixed(2) + ':1,未达 ' + tgt + ':1,且无法靠调整前景达标。', 'bad');
      }
    }
  }

  // ===================== 渲染:配色方案 =====================
  var SCHEMES = [
    { id: 'comp', name: '互补' },
    { id: 'ana', name: '近似' },
    { id: 'tri', name: '三角' },
    { id: 'tet', name: '四角' }
  ];
  function clampL(l) { return clamp(l, 0, 100); }
  function schemeColors(kind) {
    var hsl = rgbToHsl(st.r, st.g, st.b), h = hsl.h, s = hsl.s, l = hsl.l;
    function at(dh, dl) { return hexOf(hslToRgb(h + dh, s, clampL(l + (dl || 0)))); }
    if (kind === 'comp') return [at(0), at(180), at(0, 18), at(0, -18), at(180, -12)];
    if (kind === 'ana') return [at(-40), at(-20), at(0), at(20), at(40)];
    if (kind === 'tri') return [at(0), at(120), at(240), at(0, 18), at(0, -18)];
    return [at(0), at(90), at(180), at(270), at(0, 18)];
  }
  function renderSchemes() {
    var html = '';
    SCHEMES.forEach(function (sp) {
      var cols = schemeColors(sp.id);
      html += '<div class="cl-scheme"><span class="nm">' + sp.name + '</span><span class="cl-sw">';
      for (var i = 0; i < cols.length; i++) {
        html += '<i data-hex="' + cols[i] + '" title="' + cols[i] + '" style="background:' + cols[i] + '"></i>';
      }
      html += '</span><button class="btn xs" data-css="' + sp.id + '">复制 CSS 变量</button>'
        + '<button class="btn xs" data-json="' + sp.id + '">复制 JSON</button></div>';
    });
    $('#cl-schemes').innerHTML = html;
  }
  function schemeCss(kind) {
    var cols = schemeColors(kind);
    var lines = cols.map(function (c, i) { return '  --' + kind + '-' + (i + 1) + ': ' + c + ';'; });
    return ':root {\n' + lines.join('\n') + '\n}';
  }

  // ===================== 渲染:渐变 =====================
  function gradientCss() {
    var ang = Number($('#cl-ang').value) || 0;
    var mid = $('#cl-g-mid').checked;
    var stops = [colorCss(grad.c1) + ' 0%'];
    if (mid) stops.push(colorCss(grad.mid) + ' ' + (Number($('#cl-gm-pos').value) || 0) + '%');
    stops.push(colorCss(grad.c2) + ' 100%');
    var body = 'linear-gradient(' + ang + 'deg, ' + stops.join(', ') + ')';
    return { body: body, css: 'background: ' + body + ';' };
  }
  function renderGradient() {
    var g = gradientCss();
    $('#cl-grad-prev').style.background = g.body;
    $('#cl-grad-css').textContent = g.css;
    $('#cl-g-mid-row').hidden = !$('#cl-g-mid').checked;
  }

  // ===================== 渲染:色板 =====================
  var PALETTES = [
    { name: '品牌色', colors: ['#0071e3', '#0b5fff', '#5856d6', '#af52de', '#ff2d55', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7'] },
    { name: '中性灰阶', colors: ['#000000', '#1d1d1f', '#3a3a3c', '#545456', '#6e6e73', '#8e8e93', '#aeaeb2', '#c7c7cc', '#d1d1d6', '#e5e5ea', '#f2f2f7', '#ffffff'] },
    { name: '语义色', colors: ['#1a9c48', '#4ad07a', '#b26a00', '#f0b24a', '#e0241a', '#ff6b60', '#0071e3', '#2997ff'] }
  ];
  function buildPalettes() {
    var html = '';
    PALETTES.forEach(function (p) {
      html += '<div class="cl-pal-row"><div class="cl-pal-name">' + p.name + '</div><div class="cl-pal">';
      for (var i = 0; i < p.colors.length; i++) {
        html += '<i data-hex="' + p.colors[i] + '" title="' + p.colors[i] + '" style="background:' + p.colors[i] + '"></i>';
      }
      html += '</div></div>';
    });
    $('#cl-palettes').innerHTML = html;
  }

  // ===================== 主渲染 =====================
  var timer = 0, skipKey = null;
  function schedule(key) {
    skipKey = key;
    clearTimeout(timer);
    timer = setTimeout(function () { apply(skipKey); }, 120);
  }
  function apply(skip) {
    renderFormats(skip);
    renderSwatch();
    renderStats();
    alphaVisual();
    renderScale();
    renderSchemes();
    if ($('#cl-fg-follow').checked) {
      ctr.fg = { r: st.r, g: st.g, b: st.b };
      if (ctrPair) ctrPair.sync();
    }
    renderContrast();
  }
  function setCurrent(c) {
    st.r = c.r; st.g = c.g; st.b = c.b;
    apply(null);
  }
  function rand255() { return Math.floor(Math.random() * 256); }

  // ===================== 绑定:色块对(文本 + 原生取色器) =====================
  function bindPair(holder, key, textSel, pickSel, after) {
    var t = $(textSel), p = $(pickSel);
    function fromHex(h) {
      var c = parseColor(h);
      if (!c) return null;
      return { r: clamp(Math.round(c.r), 0, 255), g: clamp(Math.round(c.g), 0, 255), b: clamp(Math.round(c.b), 0, 255) };
    }
    function sync() { var h = hexOf(holder[key]); t.value = h; p.value = h; }
    sync();
    t.addEventListener('input', function () {
      var c = fromHex(t.value);
      if (!c) return;
      holder[key] = c;
      p.value = hexOf(holder[key]);
      after();
    });
    t.addEventListener('blur', sync);
    p.addEventListener('input', function () {
      var c = fromHex(p.value);
      if (!c) return;
      holder[key] = c;
      t.value = hexOf(holder[key]);
      after();
    });
    return { sync: sync, holder: holder, key: key };
  }

  // ===================== 事件接线 =====================
  var ctrPair, ctrPairBg, mixPairA, mixPairB, gPair1, gPair2, gPairMid;
  function wire() {
    // 原生取色器 + 不透明度
    $('#cl-pick').addEventListener('input', function () {
      var c = parseColor(this.value);
      if (!c) return;
      st.r = c.r; st.g = c.g; st.b = c.b;
      apply(null);
    });
    OC.range('#cl-alpha', function (v) { st.a = clamp(Number(v) / 100, 0, 1); apply(null); });

    // 头部的操作
    $('#cl-random').addEventListener('click', function () {
      var c = hslToRgb(Math.random() * 360, 55 + Math.random() * 40, 38 + Math.random() * 28);
      setCurrent({ r: c.r, g: c.g, b: c.b });
      OC.toast('已换成 ' + hexOf(st));
    });
    $('#cl-reset').addEventListener('click', function () {
      st.a = 1;
      setCurrent({ r: 0, g: 113, b: 227 });
      OC.toast('已重置');
    });
    $('#cl-copy-all').addEventListener('click', function () {
      var lines = FORMATS.map(function (f) { var v = f.get(); return f.label + ': ' + (v || '—'); });
      OC.copy(lines.join('\n'), '已复制全部格式');
    });

    // 色阶 / 色板 / 配色方案的点击委托
    $('#cl-scale').addEventListener('click', function (e) {
      var t = e.target.closest('[data-hex]');
      if (t) OC.copy(t.getAttribute('data-hex'), '已复制 ' + t.getAttribute('data-hex'));
    });
    $('#cl-mix').addEventListener('click', function (e) {
      var t = e.target.closest('[data-hex]');
      if (t) OC.copy(t.getAttribute('data-hex'), '已复制 ' + t.getAttribute('data-hex'));
    });
    $('#cl-schemes').addEventListener('click', function (e) {
      var sw = e.target.closest('[data-hex]');
      if (sw) { OC.copy(sw.getAttribute('data-hex'), '已复制 ' + sw.getAttribute('data-hex')); return; }
      var cs = e.target.closest('[data-css]');
      if (cs) { OC.copy(schemeCss(cs.getAttribute('data-css')), 'CSS 变量已复制'); return; }
      var js = e.target.closest('[data-json]');
      if (js) { OC.copy(JSON.stringify(schemeColors(js.getAttribute('data-json')), null, 2), 'JSON 已复制'); return; }
    });
    $('#cl-palettes').addEventListener('click', function (e) {
      var t = e.target.closest('[data-hex]');
      if (!t) return;
      var c = parseColor(t.getAttribute('data-hex'));
      if (c) setCurrent({ r: c.r, g: c.g, b: c.b });
    });
    $('#cl-scale-copy').addEventListener('click', function () { OC.copy(scaleHexes().join('\n'), '已复制 21 级色阶'); });

    // 两色插值
    mixPairA = bindPair(mix, 'a', '#cl-mix1', '#cl-mix1-c', renderMix);
    mixPairB = bindPair(mix, 'b', '#cl-mix2', '#cl-mix2-c', renderMix);
    $('#cl-mix-use').addEventListener('click', function () { mix.a = { r: st.r, g: st.g, b: st.b }; mixPairA.sync(); renderMix(); });
    $('#cl-mix-copy').addEventListener('click', function () { OC.copy(mixHexes().join('\n'), '已复制 11 级插值'); });

    // 对比度
    ctrPair = bindPair(ctr, 'fg', '#cl-fg', '#cl-fg-c', function () {
      $('#cl-fg-follow').checked = false;
      renderContrast();
    });
    ctrPairBg = bindPair(ctr, 'bg', '#cl-bg', '#cl-bg-c', renderContrast);
    $('#cl-fg-follow').addEventListener('change', function () {
      if (this.checked) {
        ctr.fg = { r: st.r, g: st.g, b: st.b };
        ctrPair.sync();
      }
      renderContrast();
    });
    $$('.btn[data-bg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = parseColor(b.getAttribute('data-bg'));
        if (!c) return;
        ctr.bg = { r: c.r, g: c.g, b: c.b };
        ctrPairBg.sync();
        renderContrast();
      });
    });
    $('#cl-bg-swap').addEventListener('click', function () {
      var t = ctr.fg; ctr.fg = ctr.bg; ctr.bg = t;
      $('#cl-fg-follow').checked = false;
      ctrPair.sync();
      ctrPairBg.sync();
      renderContrast();
    });
    OC.seg('#cl-target', renderContrast);
    $('#cl-fix').addEventListener('click', function () {
      var tgt = target();
      var fx = fixColor(ctr.fg, ctr.bg, tgt);
      if (!fx) { OC.toast('这个背景色下无法自动修正', 'bad'); return; }
      if ($('#cl-fg-follow').checked) {
        setCurrent({ r: fx.rgb.r, g: fx.rgb.g, b: fx.rgb.b });
        OC.toast('当前色已改为 ' + hexOf(fx.rgb) + ',对比度 ' + fx.cr.toFixed(2) + ':1');
      } else {
        ctr.fg = { r: fx.rgb.r, g: fx.rgb.g, b: fx.rgb.b };
        ctrPair.sync();
        renderContrast();
        OC.toast('前景已改为 ' + hexOf(fx.rgb) + ',对比度 ' + fx.cr.toFixed(2) + ':1');
      }
    });

    // 渐变
    gPair1 = bindPair(grad, 'c1', '#cl-g1', '#cl-g1-c', renderGradient);
    gPair2 = bindPair(grad, 'c2', '#cl-g2', '#cl-g2-c', renderGradient);
    gPairMid = bindPair(grad, 'mid', '#cl-gm', '#cl-gm-c', renderGradient);
    $('#cl-g1-use').addEventListener('click', function () { grad.c1 = { r: st.r, g: st.g, b: st.b }; gPair1.sync(); renderGradient(); });
    $('#cl-g2-use').addEventListener('click', function () { grad.c2 = { r: st.r, g: st.g, b: st.b }; gPair2.sync(); renderGradient(); });
    OC.range('#cl-ang', renderGradient);
    OC.range('#cl-gm-pos', renderGradient);
    $('#cl-g-mid').addEventListener('change', renderGradient);
    $('#cl-grad-copy').addEventListener('click', function () { OC.copy(gradientCss().css, 'CSS 已复制'); });
  }

  // ===================== 启动 =====================
  buildFormats();
  buildPalettes();
  wire();
  apply(null);
  renderMix();
  renderGradient();
})();
TCCOLOR_JS;

return array(
    'id' => 'color',
    'cat' => 'ui',
    'title' => '颜色转换与配色',
    'body' => $body,
    'script' => $script,
);
