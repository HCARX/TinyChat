<?php
/**
 * 工具:正则表达式测试。
 *
 * 输入即算的实时正则调试器:模式 + 标志(g/i/m/s/u/y)一改就重算,给出每条匹配(序号、起始位置、
 * 匹配文本、捕获组与命名组表格)、整段高亮预览,以及带 $1 / $<name> / $& 的替换试算。
 *
 * 关键实现选择:
 *   - 匹配用 exec 手写循环而不是 matchAll/replace,是为了把「迭代次数」握在自己手里:
 *     迭代超过 50 万次或墙钟超过 1.5s 就中止,提示可能是灾难性回溯 —— 单次 exec 无法被中断,
 *     所以另配一个嵌套量词的静态嗅探,在跑之前先提醒。页面不会卡死。
 *   - 高亮把匹配位置拼成 span,用户文本一律走 OC.esc,不做 innerHTML 注入;匹配数上限 2000。
 *   - 命名组编号靠自写的小扫描器从模式里数出来(JS 没有 name→number 的现成映射),
 *     扫描时跳过转义与字符类,顺带能做括号/字符类的配平定位,把浏览器报错翻成中文并指出位置。
 *   - d 标志(组索引)只在浏览器支持时才提供,不支持则禁用勾选框并说明。
 */
$body = <<<'TCRX_BODY'
<style>
.mt{margin-top:12px}
.rx-patline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rx-patline input{flex:1 1 220px;min-width:150px}
.rx-slashes{font-family:var(--mono);color:var(--t3);font-size:1.05rem;line-height:1}
.rx-flags{display:flex;gap:4px;flex-wrap:wrap}
.rx-flag{cursor:pointer;user-select:none;-webkit-user-select:none;font-family:var(--mono)}
.rx-flags-view{font-size:.786rem;color:var(--t3);word-break:break-all;font-family:var(--mono)}
.rx-caret{margin-top:6px;font-family:var(--mono);font-size:.857rem;white-space:pre;overflow:auto;
  background:var(--danger-bg);color:var(--danger);border-radius:var(--r-sm);padding:8px 10px}
.rx-preview{max-height:360px;min-height:60px}
.rx-hit{background:var(--ring);border-radius:3px}
.rx-zw{display:inline-block;width:2px;height:1em;background:var(--warn);vertical-align:-.12em;border-radius:1px}
.rx-none{color:var(--t3)}
.rx-m{border-radius:var(--r);background:var(--bg-soft);padding:9px 11px}
.rx-m + .rx-m{margin-top:6px}
.rx-m-h{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.rx-m-txt{margin:0;font-family:var(--mono);font-size:.857rem;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
.rx-gtable{margin-top:8px;background:var(--bg-surface);border-radius:var(--r-sm);overflow:hidden}
.rx-tpls{display:flex;flex-wrap:wrap;gap:6px}
.rx-repl-out{min-height:64px}
@media(max-width:640px){.rx-patline input{flex-basis:100%}}
</style>

<div class="hd">
  <div class="grow">
    <h1>正则表达式测试</h1>
    <div class="sub">实时匹配、高亮预览、捕获组与命名组、替换试算;带灾难性回溯与超时保护。</div>
  </div>
  <div class="acts">
    <button class="btn" id="rx-demo">填入示例</button>
    <button class="btn ghost" id="rx-clear">清空</button>
  </div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>模式与标志</h2>
    </div>
    <div class="rx-patline">
      <span class="rx-slashes">/</span>
      <input type="text" id="rx-pattern" class="mono" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="例如 \b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b">
      <span class="rx-slashes">/</span>
      <div class="rx-flags" id="rx-flags">
        <button type="button" class="tag rx-flag" data-flag="g" title="全局:找出全部匹配,关掉只看第一个">g</button>
        <button type="button" class="tag rx-flag" data-flag="i" title="忽略大小写">i</button>
        <button type="button" class="tag rx-flag" data-flag="m" title="多行:^ 与 $ 匹配每行首尾">m</button>
        <button type="button" class="tag rx-flag" data-flag="s" title="点号也匹配换行">s</button>
        <button type="button" class="tag rx-flag" data-flag="u" title="Unicode 模式:按码点处理 \u{...} 与 \p{...}">u</button>
        <button type="button" class="tag rx-flag" data-flag="y" title="粘性:只从上次匹配结束处继续">y</button>
      </div>
    </div>
    <div class="msg" id="rx-desc"></div>
    <div class="rx-flags-view mt" id="rx-flags-view"></div>
    <div class="rx-caret" id="rx-caret" hidden></div>

    <div class="f mt">
      <span class="lab">测试文本 <span class="rx-none" id="rx-len"></span></span>
      <textarea id="rx-text" class="wrap" spellcheck="false" placeholder="把要匹配的文本粘到这里,改动会实时重算"></textarea>
    </div>
    <div class="row mt">
      <label class="row"><input type="checkbox" id="rx-groups" checked> 显示捕获组</label>
      <label class="row"><input type="checkbox" id="rx-indices"> 显示组索引(d 标志)</label>
      <span class="sp"></span>
      <button class="btn sm ghost" id="rx-copy-pattern">复制模式</button>
    </div>
    <div class="stats mt" id="rx-stats"></div>
  </div>

  <div class="card">
    <div class="card-h"><h2>常用模板</h2><span class="grow"></span><span class="msg" id="rx-tpl-desc"></span></div>
    <div class="rx-tpls" id="rx-tpls"></div>
    <div class="msg mt">点一下把模式填进上面的模式框(并自动切换合适的标志),测试文本不动,可再点「填入示例」。</div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>高亮预览</h2>
    <span class="grow"></span>
    <span class="msg" id="rx-hl-msg"></span>
  </div>
  <div class="code brk rx-preview" id="rx-preview"><span class="rx-none">(没有结果)</span></div>
</div>

<div class="cols">
  <div class="card">
    <div class="card-h">
      <h2>匹配结果</h2>
      <span class="grow"></span>
      <span class="msg" id="rx-match-msg"></span>
      <button class="btn sm ghost" id="rx-copy-matches">复制全部匹配</button>
    </div>
    <div class="rows tall" id="rx-matches"><div class="empty">匹配结果会显示在这里</div></div>
  </div>

  <div class="card">
    <div class="card-h"><h2>替换试算</h2><span class="grow"></span><span class="msg" id="rx-repl-msg"></span></div>
    <div class="f">
      <span class="lab">替换为(支持 $1、$&lt;name&gt;、$&amp;)</span>
      <input type="text" id="rx-repl" class="mono" spellcheck="false" autocomplete="off" placeholder="例如 &lt;$&amp;&gt; 或 $1-$2">
    </div>
    <div class="row mt">
      <span class="tag" id="rx-repl-count">替换 0 处</span>
      <span class="sp"></span>
      <button class="btn sm" id="rx-repl-copy">复制结果</button>
      <button class="btn sm ghost" id="rx-repl-apply">写回测试文本</button>
    </div>
    <div class="code brk rx-repl-out mt" id="rx-repl-out"></div>
    <div class="msg mt">替换按当前模式与标志执行;关掉 g 只替换第一处,打开 d 标志不影响替换结果。</div>
  </div>
</div>

<div class="card">
  <div class="card-h">
    <h2>正则语法速查</h2>
    <span class="grow"></span>
    <button class="btn sm ghost" id="rx-ref-toggle">收起</button>
  </div>
  <div class="cols tight" id="rx-ref">
    <div>
      <div class="lab">元字符与字符类</div>
      <table>
        <thead><tr><th>写法</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td class="mono">.</td><td>任意字符(默认不含换行,s 标志可让它匹配换行)</td></tr>
          <tr><td class="mono">\d / \D</td><td>数字 / 非数字</td></tr>
          <tr><td class="mono">\w / \W</td><td>字母数字下划线 / 非单词字符</td></tr>
          <tr><td class="mono">\s / \S</td><td>空白(空格、制表、换行) / 非空白</td></tr>
          <tr><td class="mono">\b / \B</td><td>单词边界 / 非单词边界(零宽)</td></tr>
          <tr><td class="mono">[abc]</td><td>集合中的任意一个字符</td></tr>
          <tr><td class="mono">[^abc]</td><td>不在集合中的任意字符</td></tr>
          <tr><td class="mono">[a-z0-9]</td><td>范围内的字符,可叠加</td></tr>
          <tr><td class="mono">\1 / \k&lt;n&gt;</td><td>反向引用第 1 个 / 名为 n 的捕获组</td></tr>
          <tr><td class="mono">\u4e00 \p{Han}</td><td>Unicode 转义 / Unicode 属性(需 u 标志)</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <div class="lab">量词、断言与分组</div>
      <table>
        <thead><tr><th>写法</th><th>含义</th></tr></thead>
        <tbody>
          <tr><td class="mono">*</td><td>0 次或多次(贪婪,尽量多)</td></tr>
          <tr><td class="mono">+</td><td>1 次或多次</td></tr>
          <tr><td class="mono">?</td><td>0 次或 1 次</td></tr>
          <tr><td class="mono">{n} {n,} {n,m}</td><td>恰好 n 次 / 至少 n 次 / n 到 m 次</td></tr>
          <tr><td class="mono">*? +? {n,m}?</td><td>末尾加 ? 改为懒惰(最短匹配)</td></tr>
          <tr><td class="mono">^ $</td><td>串首 / 串尾,m 标志下按行首行尾</td></tr>
          <tr><td class="mono">(?= ) (?! )</td><td>正向 / 负向先行断言(零宽)</td></tr>
          <tr><td class="mono">(?&lt;= ) (?&lt;! )</td><td>正向 / 负向后行断言(零宽)</td></tr>
          <tr><td class="mono">( )</td><td>捕获组,可用 $1、\1 引用</td></tr>
          <tr><td class="mono">(?&lt;name&gt; )</td><td>命名捕获组,引用为 $&lt;name&gt;</td></tr>
          <tr><td class="mono">(?: )</td><td>非捕获组,不占组号</td></tr>
          <tr><td class="mono">a|b</td><td>或:匹配 a 或 b</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>
TCRX_BODY;
$script = <<<'TCRX_JS'
(function () {
  'use strict';
  var $ = OC.$, $$ = OC.$$;

  // ================= 容量与保护阈值 =================
  var MAX_MATCHES = 2000;     // 单次扫描收集的匹配上限(高亮与替换试算都按它)
  var LIST_MAX = 300;         // 列表里最多渲染多少块(避免上万条 DOM)
  var MAX_ITER = 500000;      // exec 循环硬上限,超过就当作灾难性回溯
  var TIME_LIMIT = 1500;      // 匹配阶段墙钟上限(ms)
  var MAX_TEXT = 200000;      // 测试文本超过就只处理前 N 个字符
  var DANGER_PREFIX = 20;     // 检测到指数级回溯风险时,只喂这么长的前缀给引擎
  var DEBOUNCE = 120;

  var flagOn = { g: true, i: false, m: false, s: false, u: false, y: false };
  var timer = 0, last = null, lastAborted = true, lastBounded = false;
  var curList = [], curGroups = { names: {}, count: 0 };

  // d 标志(组索引)是较新的能力,不支持时明确禁用而不是静默失败
  var D_OK = (function () { try { new RegExp('a', 'd'); return true; } catch (e) { return false; } })();

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  // ================= 模板库 =================
  var TEMPLATES = [
    { n: '邮箱', p: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', f: 'g', d: '常规邮箱:本地名允许字母数字与 ._%+- ,域名后缀至少 2 个字母。' },
    { n: '手机号', p: '1[3-9]\\d{9}', f: 'g', d: '中国大陆手机号:1 开头、第二位 3-9、共 11 位数字,用 \\b 包裹可避免粘到长数字里。' },
    { n: '网址', p: 'https?://[\\w.-]+(?::\\d+)?(?:/[^\\s]*)?', f: 'g', d: 'http/https 链接,含可选端口与路径;末尾用 [^\\s] 防止把后文空白也吞进来。' },
    { n: 'IPv4', p: '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b', f: 'g', d: 'IPv4 地址:每段 0-255,不匹配 999.1.1.1 这类非法地址。' },
    { n: '身份证号', p: '\\b\\d{17}[\\dXx]\\b', f: 'g', d: '二代身份证 18 位:前 17 位数字 + 末位数字或 X。' },
    { n: '日期', p: '\\b\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])\\b', f: 'g', d: 'YYYY-MM-DD,月 01-12、日 01-31,能挡掉 2026-13-40 这类明显越界。' },
    { n: '时间', p: '\\b(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?\\b', f: 'g', d: 'HH:MM 或 HH:MM:SS,24 小时制。' },
    { n: '十六进制颜色', p: '#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b', f: 'g', d: '#RGB 或 #RRGGBB。' },
    { n: '中文字符', p: '[\\u4e00-\\u9fa5]+', f: 'g', d: '连续的中日韩统一表意文字(常用汉字区间)。' },
    { n: '空白行', p: '^[ \\t]*$', f: 'gm', d: '整行只有空格/制表符的行;需 m 标志,换行用 \\r?\\n 另行处理。' },
    { n: '数字', p: '-?\\d+(?:\\.\\d+)?', f: 'g', d: '整数或小数,可带负号;要千分位请自行加逗号分组。' },
    { n: 'HTML 标签', p: '<\\/?[A-Za-z][\\w:-]*(?:\\s[^<>]*)?>', f: 'g', d: '起止标签(含属性部分),不用它解析嵌套结构,只做粗筛。' },
  ];

  var DEMO_TEXT = [
    '客服邮箱 support@example.com,备用 hi.bot+test@mail.co.uk。',
    '联系电话 13800138000,座机 010-12345678。',
    '文档地址 https://example.com/docs/regex?lang=zh 与内网 http://intra.local/a/b。',
    '发布日期 2026-10-08,时间 09:30。',
    '颜色 #1a2b3c,中文备注:这一行用来试匹配。',
  ].join('\n');
  var DEMO_PATTERN = '(?<mail>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})|(?<phone>1[3-9]\\d{9})|(?<url>https?://[^\\s,，。]+)|(?<date>\\d{4}-\\d{2}-\\d{2})';

  // ================= 模式分析 =================
  // 命名组编号:扫描模式,跳过转义与字符类,数出每个捕获组并记下 (?(?<name>…) 的名字。
  // JS 没有 name→number 的现成映射,所以只能自己数。
  function namedGroupMap(src) {
    var names = {}, idx = 0, esc = false, cls = false, i, c, n = src.length;
    for (i = 0; i < n; i++) {
      c = src.charAt(i);
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (cls) { if (c === ']') cls = false; continue; }
      if (c === '[') { cls = true; continue; }
      if (c !== '(') continue;
      if (src.charAt(i + 1) === '?') {
        if (src.charAt(i + 2) === '<') {
          var c3 = src.charAt(i + 3);
          if (c3 === '=' || c3 === '!') continue;   // 后行断言,非捕获
          var close = src.indexOf('>', i + 3);
          var nm = close > i + 3 ? src.slice(i + 3, close) : '';
          idx++;
          if (nm) names[idx] = nm;
        }
        continue;   // (?: (?= (?! (?<= (?<! 都不占组号
      }
      idx++;
    }
    return { names: names, count: idx };
  }

  // 括号 / 字符类 / 结尾反斜杠的配平扫描,用来把报错定位到具体字符。
  function locateBalance(src) {
    var stack = [], cls = -1, esc = false, i, c;
    for (i = 0; i < src.length; i++) {
      c = src.charAt(i);
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (cls >= 0) { if (c === ']') cls = -1; continue; }
      if (c === '[') { cls = i; continue; }
      if (c === '(') stack.push(i);
      else if (c === ')') {
        if (stack.length) stack.pop();
        else return { pos: i, hint: '多了一个 )' };
      }
    }
    if (esc) return { pos: src.length - 1, hint: '模式以单个反斜杠结尾,请写成 \\\\' };
    if (cls >= 0) return { pos: cls, hint: '字符类 [ 没有闭合' };
    if (stack.length) return { pos: stack[stack.length - 1], hint: '有 ( 没有对应的 )' };
    return null;
  }

  var ERR_MAP = [
    ['unterminated group', '括号没有闭合:有 ( 缺少对应的 )'],
    ['unmatched )', '括号不匹配:多了一个 )'],
    ['missing )', '括号没有闭合:缺少 )'],
    ['unterminated character class', '字符类没有闭合:[ 缺少对应的 ]'],
    ['missing ]', '字符类没有闭合:缺少 ]'],
    ['nothing to repeat', '量词前面没有可重复的内容(* + ? { 不能出现在开头,也不能紧跟 ( 或 |)'],
    ['numbers out of order in {} quantifier', '{m,n} 写法不合法:n 不能小于 m'],
    ['lone quantifier brackets', '量词 { 写法不合法:缺少配对的 },或内容不是数字'],
    ['invalid quantifier', '量词写法不合法'],
    ['invalid capture group name', '命名捕获组的名字不合法:只能用字母、数字、$、_ ,且不能以数字开头'],
    ['duplicate capture group name', '命名捕获组重名:同一个名字只能用一次'],
    ['invalid named capture referenced', '替换字符串引用了不存在的命名组'],
    ['invalid named reference', '反向引用 \\k<name> 指向了不存在的命名组'],
    ['invalid group', '分组语法非法:检查 (?...) 的写法,例如 (?<name>...) 或 (?:...)'],
    ['unterminated parenthetical', '括号没有闭合:缺少 )'],
    ['invalid decimal escape', '十进制转义不合法'],
    ['invalid unicode escape', 'Unicode 转义不合法:检查 \\uXXXX 或 \\u{...}'],
    ['invalid escape', '非法转义:反斜杠后面的字符没有特殊含义'],
    ['invalid character class', '字符类内容不合法(常见于 u 模式下的 \\p{...})'],
    ['invalid property name', '\\p{...} 里的 Unicode 属性名不合法'],
    ['invalid regular expression flags', '标志位不合法或当前浏览器不支持该标志'],
    ['\\ at end of pattern', '模式以单个反斜杠结尾,请写成 \\\\'],
  ];
  function translate(msg) {
    var low = String(msg || '').toLowerCase();
    for (var i = 0; i < ERR_MAP.length; i++) if (low.indexOf(ERR_MAP[i][0]) >= 0) return ERR_MAP[i][1];
    return '';
  }
  function parsePos(msg) {
    var m = /\bat position (\d+)/i.exec(msg) || /\bposition (\d+)/i.exec(msg);
    return m ? Number(m[1]) : -1;
  }
  function cleanupMsg(msg) {
    return String(msg || '').replace(/^\s*invalid regular expression:\s*/i, '').replace(/^\/[\s\S]*?\/\s*:\s*/, '');
  }

  // 灾难性回溯的静态嗅探。单次 exec 一旦陷入指数级回溯就无法被中断(迭代计数只在 exec
  // 返回后才递增),所以唯一的硬保护是「不把触发串喂给引擎」:识别出风险就把输入截到 DANGER_PREFIX。
  // 判据只抓真正指数级的形状 —— 一个「无界量词」修饰的组,其内部又含量词、反向引用或歧义分支
  // (分支最小长度不同 / 分支自带量词)。有界的 {3} 这类多项式重复(如 IPv4 模板)不在此列。
  function stripClasses(s) {
    return s.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  }
  function normalizeBody(body) {
    if (body.indexOf('?:') === 0) return body.slice(2);
    var m = /^\?<[^>]*>/.exec(body);
    return m ? body.slice(m[0].length) : body;
  }
  function bodyHasNestedQuant(body) {
    var t = stripClasses(body);
    return /[+*]/.test(t) || /\{\d/.test(t);
  }
  function branchMinLen(b) {
    var t = stripClasses(b), n = 0, i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charAt(i);
      if (c === '*' || c === '?') continue;
      if (c === '+') { n += 1; continue; }
      if (c === '{') {
        var mm = /^\{(\d+)/.exec(t.slice(i));
        if (mm) { n += Number(mm[1]); i += mm[0].length; }
        continue;
      }
      n += 1;
    }
    return n;
  }
  function ambiguousAlts(body) {
    var t = stripClasses(body);
    if (t.indexOf('|') < 0) return false;
    var parts = t.split('|'), lens = {}, i;
    for (i = 0; i < parts.length; i++) {
      if (/[+*?{]/.test(parts[i])) return true;   // 分支自带量词(含可空),长度可重叠
      lens[branchMinLen(parts[i])] = 1;
    }
    return Object.keys(lens).length > 1;          // 分支最小长度不唯一
  }
  function dangerHeuristic(pat) {
    var stack = [], esc = false, cls = false, i, c, n = pat.length;
    for (i = 0; i < n; i++) {
      c = pat.charAt(i);
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (cls) { if (c === ']') cls = false; continue; }
      if (c === '[') { cls = true; continue; }
      if (c === '(') { stack.push(i); continue; }
      if (c !== ')' || !stack.length) continue;
      var start = stack.pop();
      var j = i + 1;
      while (j < n && /\s/.test(pat.charAt(j))) j++;
      var q = pat.charAt(j);
      // 只看无界量词(+ * {n,});有界的 {n} / {n,m} 是多项式重复,不当作指数风险
      var unbounded = q === '+' || q === '*' || (q === '{' && /^\{\d*,\}/.test(pat.slice(j)));
      if (!unbounded) continue;
      var body = normalizeBody(pat.slice(start + 1, i));
      if (body.indexOf('(') >= 0) return true;        // 组里还套组再被无界量化
      if (bodyHasNestedQuant(body)) return true;
      if (/\\[1-9]/.test(body)) return true;
      if (ambiguousAlts(body)) return true;
    }
    return false;
  }

  // ================= 匹配执行(带迭代与超时保护) =================
  function snap(m) {
    var i, groups = [];
    for (i = 1; i < m.length; i++) groups.push(m[i]);
    var named = null;
    if (m.groups) {
      named = {};
      for (var k in m.groups) if (Object.prototype.hasOwnProperty.call(m.groups, k)) named[k] = m.groups[k];
    }
    return { index: m.index, text: m[0], groups: groups, named: named, indices: m.indices ? m.indices : null };
  }

  function runMatches(re, text) {
    var list = [], iter = 0, t0 = now(), m;
    if (!re.global) {
      m = re.exec(text);
      if (m) list.push(snap(m));
      return { list: list, aborted: '', capped: false };
    }
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      iter++;
      // 迭代上限:一次匹配内部无法中断,只能靠「试了多少次」兜住常见的爆炸式回溯。
      if (iter > MAX_ITER) return { list: list, aborted: 'iter', capped: false };
      list.push(snap(m));
      if (list.length >= MAX_MATCHES) return { list: list, aborted: '', capped: true };
      if (m[0] === '') {
        // 零宽匹配不推进 lastIndex,手动前进一个码点,否则死循环。
        var adv = 1;
        if (re.unicode && re.lastIndex < text.length && text.codePointAt(re.lastIndex) > 0xFFFF) adv = 2;
        re.lastIndex += adv;
        if (re.lastIndex > text.length) break;
      }
      if ((iter & 63) === 0 && now() - t0 > TIME_LIMIT) return { list: list, aborted: 'time', capped: false };
    }
    return { list: list, aborted: '', capped: false };
  }

  // ================= 渲染 =================
  function tag(text, kind) {
    var s = document.createElement('span');
    s.className = 'tag' + (kind ? ' ' + kind : '');
    s.textContent = text;
    return s;
  }
  function th(text, num) {
    var e = document.createElement('th');
    if (num) e.className = 'num';
    e.textContent = text;
    return e;
  }
  function stat(k, v) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + OC.esc(v) + '</div></div>';
  }
  function stats(n, groups, ms, textLen, capped) {
    $('#rx-stats').innerHTML =
      stat('匹配数', (capped ? n + '+' : String(n)))
      + stat('捕获组', String(groups))
      + stat('耗时', ms.toFixed(1) + ' ms')
      + stat('文本长度', String(textLen));
  }

  function renderHighlight(text, list, note) {
    var box = $('#rx-preview');
    if (!text) {
      box.innerHTML = '<span class="rx-none">(没有测试文本)</span>';
      OC.say('#rx-hl-msg', note || '');
      return;
    }
    if (!list.length) {
      box.textContent = text;
      OC.say('#rx-hl-msg', (note ? note + ' · ' : '') + '0 处匹配', 'warn');
      return;
    }
    var out = '', pos = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.index < pos) continue;   // 正常不会重叠,保险
      out += OC.esc(text.slice(pos, m.index));
      if (m.text === '') out += '<span class="rx-zw" title="零宽匹配"></span>';
      else out += '<span class="rx-hit">' + OC.esc(m.text) + '</span>';
      pos = m.index + m.text.length;
    }
    out += OC.esc(text.slice(pos));
    box.innerHTML = out;
    OC.say('#rx-hl-msg', (note ? note + ' · ' : '') + '已标出 ' + list.length + ' 处', note ? 'warn' : '');
  }

  function matchBlock(m, i, gm) {
    var el = document.createElement('div');
    el.className = 'rx-m';

    var head = document.createElement('div');
    head.className = 'rx-m-h';
    head.appendChild(tag('#' + (i + 1), 'brand'));
    head.appendChild(tag('起始 ' + m.index));
    head.appendChild(tag('长度 ' + m.text.length));
    if (m.indices) head.appendChild(tag('区间 [' + m.indices[0][0] + ', ' + m.indices[0][1] + ')'));
    var hasNamed = false;
    if (m.named) for (var k in m.named) { hasNamed = true; break; }
    if (hasNamed) head.appendChild(tag('含命名组', 'ok'));
    el.appendChild(head);

    var txt = document.createElement('p');
    txt.className = 'rx-m-txt';
    if (m.text === '') { txt.textContent = '(零宽匹配)'; txt.style.color = 'var(--t3)'; }
    else txt.textContent = m.text;
    el.appendChild(txt);

    if ($('#rx-groups').checked && gm.count > 0) {
      var withIdx = !!m.indices;
      var tbl = document.createElement('table');
      tbl.className = 'rx-gtable';
      var thead = document.createElement('thead');
      var trh = document.createElement('tr');
      trh.appendChild(th('组号', true));
      trh.appendChild(th('名称', false));
      trh.appendChild(th('值', false));
      if (withIdx) trh.appendChild(th('位置', false));
      thead.appendChild(trh);
      tbl.appendChild(thead);
      var tb = document.createElement('tbody');
      for (var g = 1; g <= gm.count; g++) {
        var tr = document.createElement('tr');
        var tdn = document.createElement('td');
        tdn.className = 'num';
        tdn.textContent = String(g);
        tr.appendChild(tdn);
        var tdnm = document.createElement('td');
        tdnm.className = 'mono';
        tdnm.textContent = gm.names[g] || '—';
        tr.appendChild(tdnm);
        var tdv = document.createElement('td');
        tdv.className = 'mono brk';
        var val = m.groups[g - 1];
        if (val === undefined) { tdv.textContent = '未参与匹配'; tdv.style.color = 'var(--t3)'; }
        else if (val === '') { tdv.textContent = '(空字符串)'; tdv.style.color = 'var(--t3)'; }
        else tdv.textContent = val;
        tr.appendChild(tdv);
        if (withIdx) {
          var tdi = document.createElement('td');
          tdi.className = 'num';
          var ind = m.indices[g];
          tdi.textContent = ind ? '[' + ind[0] + ', ' + ind[1] + ')' : '—';
          tr.appendChild(tdi);
        }
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      el.appendChild(tbl);
    }
    return el;
  }

  function renderMatches(list, gm) {
    var box = $('#rx-matches');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="empty">没有匹配</div>';
      return;
    }
    var n = Math.min(list.length, LIST_MAX);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < n; i++) frag.appendChild(matchBlock(list[i], i, gm));
    box.appendChild(frag);
    if (list.length > n) {
      var w = document.createElement('div');
      w.className = 'msg warn';
      w.textContent = '匹配较多,只列出前 ' + n + ' 条(共 ' + list.length + ' 条)。';
      box.appendChild(w);
    }
  }

  function renderReplace(re, text, list, capped, aborted, note) {
    var box = $('#rx-repl-out');
    var cnt = $('#rx-repl-count');
    if (aborted || !re) {
      box.textContent = aborted ? '匹配阶段已中止,未执行替换。' : '';
      cnt.textContent = '替换 —';
      OC.say('#rx-repl-msg', '');
      return;
    }
    var repl = $('#rx-repl').value;
    try {
      var out = text.replace(re, repl);
      box.textContent = out;
      var n = re.global ? list.length : Math.min(list.length, 1);
      cnt.textContent = '替换 ' + n + ' 处' + (capped ? '(达到上限,可能更多)' : '');
      OC.say('#rx-repl-msg', note || '', note ? 'warn' : '');
    } catch (e) {
      var msg = String((e && e.message) || e);
      var zh = /named/i.test(msg)
        ? '替换字符串引用了不存在的命名组(检查 $<name>)'
        : '替换字符串不合法:检查 $1、$<name> 这类引用是否存在';
      box.textContent = '';
      cnt.textContent = '替换 0 处';
      OC.say('#rx-repl-msg', zh, 'bad');
    }
  }

  function clearOutputs(textLen) {
    $('#rx-preview').innerHTML = '<span class="rx-none">(没有结果)</span>';
    $('#rx-matches').innerHTML = '<div class="empty">匹配结果会显示在这里</div>';
    $('#rx-repl-out').textContent = '';
    $('#rx-repl-count').textContent = '替换 0 处';
    OC.say('#rx-hl-msg', '');
    OC.say('#rx-repl-msg', '');
    stats(0, 0, 0, textLen, false);
  }

  // ================= 主流程 =================
  function flagsStr() {
    var d = (D_OK && $('#rx-indices').checked) ? 'd' : '';
    return d + (flagOn.g ? 'g' : '') + (flagOn.i ? 'i' : '') + (flagOn.m ? 'm' : '')
      + (flagOn.s ? 's' : '') + (flagOn.u ? 'u' : '') + (flagOn.y ? 'y' : '');
  }
  function syncFlagButtons() {
    $$('#rx-flags .rx-flag').forEach(function (b) {
      var on = !!flagOn[b.getAttribute('data-flag')];
      b.classList.toggle('brand', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function showPatternError(pat, e) {
    var raw = String((e && e.message) || e);
    var pos = parsePos(raw);
    var loc = locateBalance(pat);
    var hint = translate(raw);
    if (loc) {
      if (pos < 0) pos = loc.pos;
      if (!hint) hint = loc.hint;
    }
    if (pos > pat.length) pos = pat.length;
    var text = '模式非法';
    if (pos >= 0) text += '(第 ' + (pos + 1) + ' 个字符附近)';
    text += ':' + (hint || cleanupMsg(raw));
    $('#rx-desc').textContent = text;
    $('#rx-desc').className = 'msg bad';
    $('#rx-flags-view').textContent = '';
    var caret = $('#rx-caret');
    if (pos >= 0) {
      caret.hidden = false;
      caret.textContent = pat + '\n' + new Array(pos + 1).join(' ') + '^';
    } else caret.hidden = true;
    OC.say('#rx-match-msg', '模式无法编译,没有结果', 'bad');
    last = null;
    lastAborted = true;
    lastBounded = false;
    curList = [];
    curGroups = { names: {}, count: 0 };
    clearOutputs($('#rx-text').value.length);
  }

  function run() {
    syncFlagButtons();
    var pat = $('#rx-pattern').value;
    var rawText = $('#rx-text').value;
    var truncated = rawText.length > MAX_TEXT;
    var text = truncated ? rawText.slice(0, MAX_TEXT) : rawText;
    $('#rx-len').textContent = rawText ? '· ' + rawText.length + ' 字符' + (truncated ? '(只处理前 ' + MAX_TEXT + ' 个)' : '') : '';

    if (pat === '') {
      $('#rx-desc').textContent = '请输入正则模式,或在右侧模板里点一个快速填入。';
      $('#rx-desc').className = 'msg';
      $('#rx-caret').hidden = true;
      $('#rx-flags-view').textContent = '';
      last = null;
      lastAborted = true;
      lastBounded = false;
      curList = [];
      curGroups = { names: {}, count: 0 };
      clearOutputs(rawText.length);
      return;
    }

    var re;
    try { re = new RegExp(pat, flagsStr()); }
    catch (e) { showPatternError(pat, e); return; }

    last = re;
    lastAborted = false;
    var groups = namedGroupMap(pat);
    var danger = dangerHeuristic(pat);
    // 单次 exec 无法中断,检测到指数级回溯风险时只喂一小段前缀(见 dangerHeuristic 说明)
    var bounded = danger && text.length > DANGER_PREFIX;
    var scanText = bounded ? text.slice(0, DANGER_PREFIX) : text;
    lastBounded = bounded;
    var note = bounded ? '检测到回溯风险,仅匹配文本前 ' + DANGER_PREFIX + ' 个字符' : (truncated ? '仅处理文本前 ' + MAX_TEXT + ' 个字符' : '');
    $('#rx-desc').textContent = danger ? '模式含嵌套量词或歧义分支,可能指数级回溯;为防页面卡死,只在测试文本前 ' + DANGER_PREFIX + ' 个字符内匹配。' : '';
    $('#rx-desc').className = 'msg' + (danger ? ' warn' : '');
    $('#rx-caret').hidden = true;
    $('#rx-flags-view').textContent = '/' + pat + '/' + flagsStr();

    var t0 = now();
    var res = runMatches(re, scanText);
    var ms = now() - t0;

    curList = res.list;
    curGroups = groups;

    if (res.aborted === 'iter') {
      OC.say('#rx-match-msg', '已在 ' + MAX_ITER + ' 次尝试后中止:模式可能造成灾难性回溯', 'bad');
      lastAborted = true;
    } else if (res.aborted === 'time') {
      OC.say('#rx-match-msg', '匹配超过 ' + TIME_LIMIT + 'ms 已中止:模式可能造成灾难性回溯', 'bad');
      lastAborted = true;
    } else if (res.capped) {
      OC.say('#rx-match-msg', '匹配数超过 ' + MAX_MATCHES + ' 条,已停止收集', 'warn');
    } else {
      OC.say('#rx-match-msg', res.list.length ? '' : '没有匹配', res.list.length ? '' : 'warn');
    }

    renderHighlight(text, res.list, note);
    renderMatches(res.list, groups);
    stats(res.list.length, groups.count, ms, rawText.length, res.capped);
    renderReplace(re, scanText, res.list, res.capped, lastAborted, note);
  }

  function live() { clearTimeout(timer); timer = setTimeout(run, DEBOUNCE); }

  // ================= 模板与示例 =================
  function buildTemplates() {
    var box = $('#rx-tpls');
    box.innerHTML = '';
    TEMPLATES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn sm';
      b.textContent = t.n;
      b.title = t.d;
      b.addEventListener('click', function () { useTemplate(t); });
      box.appendChild(b);
    });
  }
  function useTemplate(t) {
    $('#rx-pattern').value = t.p;
    flagOn = { g: false, i: false, m: false, s: false, u: false, y: false };
    (t.f || 'g').split('').forEach(function (c) { if (c in flagOn) flagOn[c] = true; });
    syncFlagButtons();
    $('#rx-tpl-desc').textContent = t.n + ':' + t.d;
    run();
  }
  function loadDemo() {
    $('#rx-pattern').value = DEMO_PATTERN;
    $('#rx-text').value = DEMO_TEXT;
    $('#rx-repl').value = '[$&]';
    flagOn = { g: true, i: false, m: false, s: false, u: false, y: false };
    syncFlagButtons();
    $('#rx-tpl-desc').textContent = '';
    run();
  }

  // ================= 事件接线 =================
  function wire() {
    $$('#rx-flags .rx-flag').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = b.getAttribute('data-flag');
        flagOn[f] = !flagOn[f];
        syncFlagButtons();
        live();
      });
    });
    $('#rx-pattern').addEventListener('input', live);
    $('#rx-text').addEventListener('input', live);
    $('#rx-repl').addEventListener('input', live);
    $('#rx-groups').addEventListener('change', live);
    $('#rx-indices').addEventListener('change', function () {
      if (!D_OK) { this.checked = false; OC.toast('当前浏览器不支持 d 标志(组索引)', 'bad'); return; }
      live();
    });

    $('#rx-copy-pattern').addEventListener('click', function () {
      if (!$('#rx-pattern').value) { OC.toast('模式是空的', 'bad'); return; }
      OC.copy('/' + $('#rx-pattern').value + '/' + flagsStr(), '模式已复制');
    });
    $('#rx-copy-matches').addEventListener('click', function () {
      if (!curList.length) { OC.toast('没有匹配可复制', 'bad'); return; }
      OC.copy(curList.map(function (m) { return m.text; }).join('\n'), '已复制 ' + curList.length + ' 条匹配文本');
    });
    $('#rx-repl-copy').addEventListener('click', function () {
      var out = $('#rx-repl-out').textContent;
      if (!out) { OC.toast('没有替换结果可复制', 'bad'); return; }
      OC.copy(out, '替换结果已复制');
    });
    $('#rx-repl-apply').addEventListener('click', function () {
      if (lastAborted || !last) { OC.toast('匹配已中止,未写回', 'bad'); return; }
      if (lastBounded) { OC.toast('有回溯风险,替换只覆盖前 ' + DANGER_PREFIX + ' 个字符,未写回', 'bad'); return; }
      if (!$('#rx-text').value) { OC.toast('测试文本是空的', 'bad'); return; }
      $('#rx-text').value = $('#rx-repl-out').textContent;
      run();
      OC.toast('已写回测试文本');
    });

    $('#rx-demo').addEventListener('click', loadDemo);
    $('#rx-clear').addEventListener('click', function () {
      $('#rx-pattern').value = '';
      $('#rx-text').value = '';
      $('#rx-repl').value = '';
      flagOn = { g: true, i: false, m: false, s: false, u: false, y: false };
      $('#rx-indices').checked = false;
      $('#rx-tpl-desc').textContent = '';
      run();
      $('#rx-pattern').focus();
    });

    var refBtn = $('#rx-ref-toggle');
    refBtn.addEventListener('click', function () {
      var box = $('#rx-ref');
      box.hidden = !box.hidden;
      refBtn.textContent = box.hidden ? '展开' : '收起';
    });
  }

  buildTemplates();
  wire();
  if (!D_OK) {
    var cb = $('#rx-indices');
    cb.disabled = true;
    cb.parentNode.title = '当前浏览器不支持 d 标志(组索引)';
  }
  loadDemo();
})();
TCRX_JS;

return array(
    'id' => 'regex',
    'cat' => 'dev',
    'title' => '正则表达式测试',
    'body' => $body,
    'script' => $script,
);
