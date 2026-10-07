<?php
/**
 * 内置的系统小工具(在线工具箱的初始内容)。
 *
 * 只在「库里还没有 sysToolbox 这一行」时被 require 一次(见 tc_migrate_db):装好后
 * 这 10 套工具就落库了,之后由后台自行增删改 —— 管理员把它们全删掉也不会被重新塞回来。
 *
 * ⚠ 这些 HTML 与用户自存的工具走完全相同的通路与隔离:服务端不清洗,打开时一律在不透明源
 * 的沙箱里运行(iframe sandbox / CSP sandbox),所以里面**不得**依赖 localStorage、
 * document.cookie、同源接口等任何需要本站身份的能力 —— 那些在沙箱里会直接抛错。
 * 也因此这 10 套工具只用纯前端 API(TextEncoder/btoa/crypto/Intl),不联网。
 *
 * 写法约定:每套工具是独立整页,共用下面这段基础样式(字符串拼接注入,不用 heredoc 插值,
 * 免得 HTML 里的 $ 被当成 PHP 变量)。
 */

const TC_TOOLBOX_DEFAULT_CSS = <<<'CSSBASE'
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:18px;font:14px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;background:#f6f7f9;color:#1f2328}
h1{font-size:16px;margin:0 0 12px;font-weight:600}
h2{font-size:13px;margin:14px 0 6px;font-weight:600;color:#57606a}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.row.tight{gap:6px}
textarea,input,select{font:inherit;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:inherit;width:100%}
textarea{min-height:130px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.55;white-space:pre;overflow-wrap:normal;overflow-x:auto}
input[type=number],input[type=text],input[type=color]{width:auto;min-width:120px}
input[type=color]{height:38px;padding:3px}
input[type=checkbox],input[type=radio]{width:auto;margin:0}
button{font:inherit;padding:7px 13px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:inherit;cursor:pointer;transition:background .13s,border-color .13s}
button:hover{background:#f0f1f3}
button.p{background:#2563eb;border-color:#2563eb;color:#fff}
button.p:hover{filter:brightness(1.08)}
button.sm{padding:4px 9px;font-size:12.5px}
label{display:inline-flex;align-items:center;gap:5px;font-size:13px;color:#57606a}
.muted{color:#6b7280;font-size:12.5px}
.msg{margin-left:2px;font-size:12.5px;color:#6b7280}
.msg.bad{color:#dc2626}
.msg.ok{color:#15803d}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.grid2{grid-template-columns:1fr}}
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;align-items:center;font-size:13px}
.kv b{font-weight:500;color:#57606a}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.list{border:1px solid #e5e7eb;border-radius:8px;background:#fff;max-height:260px;overflow:auto}
.list .it{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid #f1f2f4}
.list .it:last-child{border-bottom:0}
.list .it .mono{flex:1}
.swatch{width:100%;height:96px;border-radius:8px;border:1px solid #d0d5dd}
.hl{background:#fde68a}
.hl:nth-child(even){background:#bfdbfe}
mark{background:#fde68a;padding:0 1px;border-radius:2px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #e5e7eb;padding:5px 8px;text-align:left}
th{background:#fafafa;font-weight:500;color:#57606a}
@media(prefers-color-scheme:dark){
  body{background:#16181d;color:#e6e6e6}
  h2,.kv b,.muted{color:#9aa4b2}
  textarea,input,select,button{background:#1e2128;border-color:#333842;color:inherit}
  button:hover{background:#272b33}
  button.p{background:#3b82f6;border-color:#3b82f6}
  .list{border-color:#2a2e36}
  .list .it{border-bottom-color:#22262e}
  .swatch{border-color:#333842}
  th,td{border-color:#2a2e36}
  th{background:#1b1e24}
  .hl{background:#7c5300}
  .hl:nth-child(even){background:#1e3a8a}
  mark{background:#7c5300}
}
CSSBASE;

// ============ 1. Base64 编解码 ============
const TC_TOOLBOX_HTML_BASE64 = <<<'BODY_B64'
<h1>Base64 编解码</h1>
<div class="row">
  <button class="p" id="enc">编码 →</button>
  <button id="dec">← 解码</button>
  <button id="swap">交换两侧</button>
  <button id="clear">清空</button>
  <label><input type="checkbox" id="url">URL 安全（用 -_ 且去掉末尾 =）</label>
  <span class="msg" id="msg"></span>
</div>
<div class="grid2">
  <div><h2>原文（UTF-8）</h2><textarea id="a" placeholder="在这里输入文本…"></textarea></div>
  <div><h2>Base64</h2><textarea id="b" placeholder="在这里粘贴 Base64…"></textarea></div>
</div>
<div class="row" style="margin-top:10px">
  <button id="copya">复制原文</button><button id="copyb">复制 Base64</button>
  <span class="muted">中文等非 ASCII 按 UTF-8 编码，不会乱码。</span>
</div>
BODY_B64;

const TC_TOOLBOX_JS_BASE64 = <<<'JS_B64'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function enc(s,url){
  var u=new TextEncoder().encode(s),o='';for(var i=0;i<u.length;i++)o+=String.fromCharCode(u[i]);
  var r=btoa(o);
  if(url)r=r.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return r;
}
function dec(s){
  var t=String(s).replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
  while(t.length%4)t+='=';
  var bin=atob(t),u=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
  return new TextDecoder().decode(u);
}
function copy(el){
  var v=el.value;if(!v)return msg('这一侧是空的', 'bad');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(v).then(function(){msg('已复制','ok')},function(){pick(el)});
  }else pick(el);
}
function pick(el){el.focus();el.select();try{document.execCommand('copy');msg('已复制','ok')}catch(e){msg('请按 Ctrl+C 复制','bad')}}
$('#enc').onclick=function(){try{$('#b').value=enc($('#a').value,$('#url').checked);msg('编码完成','ok')}catch(e){msg('编码失败：'+e.message,'bad')}};
$('#dec').onclick=function(){try{$('#a').value=dec($('#b').value);msg('解码完成','ok')}catch(e){msg('不是合法的 Base64：'+e.message,'bad')}};
$('#swap').onclick=function(){var t=$('#a').value;$('#a').value=$('#b').value;$('#b').value=t;msg('已交换两侧')};
$('#clear').onclick=function(){$('#a').value='';$('#b').value='';msg('')};
$('#copya').onclick=function(){copy($('#a'))};
$('#copyb').onclick=function(){copy($('#b'))};
JS_B64;

// ============ 2. URL 编解码 ============
const TC_TOOLBOX_HTML_URL = <<<'BODY_URL'
<h1>URL 编解码</h1>
<div class="row">
  <button class="p" id="enc">编码 →</button>
  <button id="dec">← 解码</button>
  <button id="swap">交换两侧</button>
  <label><input type="checkbox" id="whole">整段地址（保留 / ? &amp; 等分隔符）</label>
  <span class="msg" id="msg"></span>
</div>
<div class="grid2">
  <div><h2>原文</h2><textarea id="a" placeholder="https://example.com/搜索?q=你好 世界"></textarea></div>
  <div><h2>编码结果</h2><textarea id="b" placeholder="粘贴编码后的内容…"></textarea></div>
</div>
<h2>查询串解析（对左侧原文）</h2>
<div id="qs" class="muted">输入带 ? 的地址后自动解析出参数。</div>
BODY_URL;

const TC_TOOLBOX_JS_URL = <<<'JS_URL'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function fn(){return $('#whole').checked?encodeURI:encodeURIComponent}
function dfn(){return $('#whole').checked?decodeURI:decodeURIComponent}
$('#enc').onclick=function(){try{$('#b').value=fn()($('#a').value);msg('编码完成','ok')}catch(e){msg('编码失败：'+e.message,'bad')}parse()};
$('#dec').onclick=function(){try{$('#a').value=dfn()($('#b').value);msg('解码完成','ok')}catch(e){msg('不是合法的编码：'+e.message,'bad')}parse()};
$('#swap').onclick=function(){var t=$('#a').value;$('#a').value=$('#b').value;$('#b').value=t;msg('已交换两侧')};
$('#a').addEventListener('input',parse);
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function parse(){
  var v=$('#a').value,host=$('#qs'),i=v.indexOf('?');
  if(i<0){host.className='muted';host.textContent='输入带 ? 的地址后自动解析出参数。';return}
  var q=v.slice(i+1).split('#')[0],rows=q?q.split('&'):[],html='<table><tr><th>参数</th><th>值</th></tr>',n=0;
  for(var k=0;k<rows.length;k++){
    if(!rows[k])continue;
    var p=rows[k].split('='),key=p.shift(),val=p.join('=');
    function dec1(x){try{return decodeURIComponent(x.replace(/\+/g,' '))}catch(e){return x}}
    html+='<tr><td>'+esc(dec1(key))+'</td><td>'+esc(dec1(val))+'</td></tr>';n++;
  }
  if(!n){host.className='muted';host.textContent='没解析到参数。';return}
  host.className='';host.innerHTML=html+'</table>';
}
JS_URL;

// ============ 3. JSON 格式化 ============
const TC_TOOLBOX_HTML_JSON = <<<'BODY_JSON'
<h1>JSON 格式化 / 校验</h1>
<div class="row">
  <button class="p" id="fmt">格式化（2 空格）</button>
  <button id="min">压缩成一行</button>
  <button id="check">只校验</button>
  <button id="esc">转义成字符串</button>
  <button id="clear">清空</button>
  <span class="msg" id="msg"></span>
</div>
<textarea id="a" placeholder='{"name":"TinyChat","tags":["php","sqlite"],"ok":true}'></textarea>
<div class="row" style="margin-top:10px">
  <button id="copy">复制结果</button>
  <span class="muted" id="stat"></span>
</div>
BODY_JSON;

const TC_TOOLBOX_JS_JSON = <<<'JS_JSON'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function stat(t){$('#stat').textContent=t||''}
function parse(){
  var v=$('#a').value;if(!v.trim())throw new Error('内容为空');
  return JSON.parse(v);
}
// 出错时把行列算出来,便于在大段 JSON 里定位
function where(e){
  var m=/position (\d+)/.exec(e.message);
  if(!m)return '';
  var pos=parseInt(m[1],10),before=$('#a').value.slice(0,pos).split('\n');
  return '（第 '+before.length+' 行第 '+(before[before.length-1].length+1)+' 列附近）';
}
function run(fn){
  try{
    var o=parse();$('#a').value=fn(o);stat('已更新');msg('JSON 合法','ok');
  }catch(e){msg('JSON 不合法：'+String(e.message).replace(/^JSON\.parse: /,'')+where(e),'bad');stat('')}
}
$('#fmt').onclick=function(){run(function(o){return JSON.stringify(o,null,2)})};
$('#min').onclick=function(){run(function(o){return JSON.stringify(o)})};
$('#check').onclick=function(){
  try{
    var o=parse(),t=JSON.stringify(o);
    msg('JSON 合法','ok');
    stat('顶层类型：'+(Array.isArray(o)?'数组':typeof o)+'，压缩后 '+t.length+' 字符');
  }catch(e){msg('JSON 不合法：'+String(e.message).replace(/^JSON\.parse: /,'')+where(e),'bad');stat('')}
};
$('#esc').onclick=function(){
  try{var t=JSON.stringify(parse());$('#a').value=JSON.stringify(t);msg('已转义为字符串字面量','ok');stat('')}
  catch(e){msg('先修好 JSON 再转义','bad')}
};
$('#clear').onclick=function(){$('#a').value='';msg('');stat('')};
$('#copy').onclick=function(){
  var v=$('#a').value;if(!v)return msg('没有可复制的内容','bad');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){msg('已复制','ok')},function(){pick()});
  else pick();
};
function pick(){$('#a').focus();$('#a').select();try{document.execCommand('copy');msg('已复制','ok')}catch(e){msg('请按 Ctrl+C 复制','bad')}}
JS_JSON;

// ============ 4. 时间戳转换 ============
const TC_TOOLBOX_HTML_TIME = <<<'BODY_TIME'
<h1>时间戳转换</h1>
<h2>时间戳 → 时间</h2>
<div class="row">
  <input type="number" id="ts" placeholder="1735689600" step="1">
  <select id="unit"><option value="1">秒</option><option value="1000">毫秒</option></select>
  <button class="p" id="go">转换</button>
  <button id="now">填入当前时间</button>
  <span class="msg" id="msg"></span>
</div>
<div id="out" class="kv"></div>
<h2>时间 → 时间戳</h2>
<div class="row"><input type="datetime-local" id="dt" step="1"><button id="back">反算时间戳</button><span class="msg" id="msg2"></span></div>
BODY_TIME;

const TC_TOOLBOX_JS_TIME = <<<'JS_TIME'
var $=function(s){return document.querySelector(s)};
function msg(id,t,cls){var m=$(id);m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function p2(n){return String(n).padStart(2,'0')}
function fmt(d){
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
}
function rel(ms){
  var s=Math.round((Date.now()-ms)/1000),a=Math.abs(s),t=s>=0?'前':'后';
  if(a<60)return a+' 秒'+t;
  if(a<3600)return Math.round(a/60)+' 分钟'+t;
  if(a<86400)return Math.round(a/3600)+' 小时'+t;
  if(a<2592000)return Math.round(a/86400)+' 天'+t;
  return Math.round(a/2592000)+' 个月'+t;
}
function showRow(list){$('#out').innerHTML=list.map(function(r){return '<b>'+r[0]+'</b><span class="mono">'+r[1]+'</span>'}).join('')}
function conv(){
  var v=$('#ts').value.trim();
  if(!v)return msg('#msg','请先填一个时间戳','bad');
  var n=Number(v);
  if(!isFinite(n))return msg('#msg','不是合法的数字','bad');
  var ms=n*(Number($('#unit').value)||1);
  var d=new Date(ms);
  if(isNaN(d.getTime()))return msg('#msg','这个时间戳超出可表示范围','bad');
  msg('#msg','','');
  showRow([
    ['本地时间',fmt(d)],
    ['UTC',d.toISOString().replace('T',' ').replace('.000Z',' UTC')],
    ['ISO 8601',d.toISOString()],
    ['星期','星期'+'日一二三四五六'[d.getDay()]],
    ['距今',rel(ms)]
  ]);
}
$('#go').onclick=conv;
$('#ts').addEventListener('keydown',function(e){if(e.key==='Enter')conv()});
$('#now').onclick=function(){$('#unit').value='1';$('#ts').value=Math.floor(Date.now()/1000);conv()};
$('#back').onclick=function(){
  var v=$('#dt').value;if(!v)return msg('#msg2','请先选一个时间','bad');
  var d=new Date(v);
  if(isNaN(d.getTime()))return msg('#msg2','时间格式不对','bad');
  msg('#msg2','','');
  showRow([['秒',String(Math.floor(d.getTime()/1000))],['毫秒',String(d.getTime())]]);
};
JS_TIME;

// ============ 5. 哈希计算 ============
const TC_TOOLBOX_HTML_HASH = <<<'BODY_HASH'
<h1>哈希 / 摘要计算</h1>
<div class="row">
  <label>算法
    <select id="alg"><option>SHA-256</option><option>SHA-1</option><option>SHA-384</option><option>SHA-512</option></select>
  </label>
  <button class="p" id="go">计算</button>
  <span class="msg" id="msg"></span>
</div>
<textarea id="a" placeholder="输入要计算摘要的文本…"></textarea>
<div class="row" style="margin-top:10px">
  <label>编码 <select id="enc"><option value="hex">十六进制</option><option value="base64">Base64</option></select></label>
  <button id="copy">复制结果</button>
</div>
<div id="out" class="mono" style="margin-top:8px"></div>
BODY_HASH;

const TC_TOOLBOX_JS_HASH = <<<'JS_HASH'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function hex(buf){
  var u=new Uint8Array(buf),o='';
  for(var i=0;i<u.length;i++)o+=String.fromCharCode(u[i]).charCodeAt(0).toString(16).padStart(2,'0');
  return o;
}
function b64(buf){
  var u=new Uint8Array(buf),s='';
  for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);
  return btoa(s);
}
function run(){
  // 沙箱里没有同源身份,但 crypto.subtle 只要求「安全上下文」:站点走 https 时可用,
  // 纯 http 打开时不存在 —— 这种情况给出明确提示,而不是静默无反应。
  if(!(window.crypto&&window.crypto.subtle)){
    msg('当前环境不提供加密接口（浏览器要求 https 或 localhost），换用 https 打开本站即可','bad');
    return;
  }
  var text=$('#a').value;
  if(!text)return msg('请先输入文本','bad');
  var alg=$('#alg').value;
  msg('计算中…','');
  crypto.subtle.digest(alg,new TextEncoder().encode(text)).then(function(buf){
    var v=$('#enc').value==='base64'?b64(buf):hex(buf);
    $('#out').textContent=v;
    msg(alg+' · '+v.length+' 个字符','ok');
  }).catch(function(e){msg('计算失败：'+e.message,'bad')});
}
$('#go').onclick=run;
$('#alg').onchange=run;
$('#enc').onchange=run;
$('#a').addEventListener('input',function(){clearTimeout(window.__t);window.__t=setTimeout(run,300)});
$('#copy').onclick=function(){
  var v=$('#out').textContent;if(!v)return msg('还没有结果','bad');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){msg('已复制','ok')},function(){msg('请手动选择复制','bad')});
  else msg('请手动选择复制','bad');
};
JS_HASH;

// ============ 6. 随机密码生成 ============
const TC_TOOLBOX_HTML_PWD = <<<'BODY_PWD'
<h1>随机密码生成</h1>
<div class="row">
  <label>长度 <input type="number" id="len" value="16" min="4" max="128" style="width:88px"></label>
  <label>个数 <input type="number" id="cnt" value="5" min="1" max="50" style="width:74px"></label>
  <button class="p" id="go">生成</button>
  <span class="msg" id="msg"></span>
</div>
<div class="row">
  <label><input type="checkbox" id="lo" checked>小写 a-z</label>
  <label><input type="checkbox" id="up" checked>大写 A-Z</label>
  <label><input type="checkbox" id="di" checked>数字 0-9</label>
  <label><input type="checkbox" id="sy">符号 !@#$%^&amp;*</label>
  <label><input type="checkbox" id="safe" checked>排除易混字符 0O1lI</label>
</div>
<div class="list" id="out"></div>
<div class="row" style="margin-top:10px"><button id="copyall">复制全部</button><span class="muted">用浏览器的加密随机数生成，不由本页面记录。</span></div>
BODY_PWD;

const TC_TOOLBOX_JS_PWD = <<<'JS_PWD'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function pool(){
  var s='';
  if($('#lo').checked)s+='abcdefghijklmnopqrstuvwxyz';
  if($('#up').checked)s+='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if($('#di').checked)s+='0123456789';
  if($('#sy').checked)s+='!@#$%^&*()-_=+[]{};:,.?';
  if($('#safe').checked)s=s.replace(/[0O1lI]/g,'');
  return s;
}
function rnd(n){
  var u=new Uint32Array(1),max=Math.floor(4294967296/n)*n,v;
  // 拒绝采样:直接取模会让靠前的字符概率偏高
  do{crypto.getRandomValues(u);v=u[0]}while(v>=max);
  return v%n;
}
function make(len,p){
  var o='';
  for(var i=0;i<len;i++)o+=p.charAt(rnd(p.length));
  return o;
}
function strength(pw,p){
  var kinds=0;
  if(/[a-z]/.test(pw))kinds++;
  if(/[A-Z]/.test(pw))kinds++;
  if(/[0-9]/.test(pw))kinds++;
  if(/[^a-zA-Z0-9]/.test(pw))kinds++;
  var bits=Math.round(pw.length*Math.log(p.length)/Math.LN2);
  var txt=bits>=128?'很强':bits>=80?'强':bits>=60?'中等':'偏弱';
  return {bits:bits,txt:txt,kinds:kinds};
}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function gen(){
  var p=pool();
  if(!p)return msg('至少要勾选一种字符','bad');
  var len=Math.max(4,Math.min(128,parseInt($('#len').value,10)||16));
  var cnt=Math.max(1,Math.min(50,parseInt($('#cnt').value,10)||5));
  var out=[],i;
  for(i=0;i<cnt;i++)out.push(make(len,p));
  var s=strength(out[0],p);
  $('#msg').className='msg ok';
  $('#msg').textContent='已生成 '+cnt+' 条 · 单条约 '+s.bits+' bit 熵（'+s.txt+'）';
  $('#out').innerHTML=out.map(function(v){
    return '<div class="it"><span class="mono">'+esc(v)+'</span><button class="sm" data-pw="'+esc(v)+'">复制</button></div>';
  }).join('');
}
$('#go').onclick=gen;
$('#out').addEventListener('click',function(e){
  var b=e.target.closest('button[data-pw]');if(!b)return;
  var v=b.getAttribute('data-pw');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){msg('已复制','ok')},function(){msg('复制被浏览器拒绝，请手动选择','bad')});
  else msg('请手动选择复制','bad');
});
$('#copyall').onclick=function(){
  var v=[].map.call($('#out').querySelectorAll('button[data-pw]'),function(b){return b.getAttribute('data-pw')}).join('\n');
  if(!v)return msg('还没有生成','bad');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){msg('已复制全部','ok')},function(){msg('复制被浏览器拒绝','bad')});
  else msg('请手动选择复制','bad');
};
gen();
JS_PWD;

// ============ 7. UUID 生成 ============
const TC_TOOLBOX_HTML_UUID = <<<'BODY_UUID'
<h1>UUID 生成</h1>
<div class="row">
  <label>个数 <input type="number" id="cnt" value="5" min="1" max="200" style="width:80px"></label>
  <label><input type="checkbox" id="upper">大写</label>
  <label><input type="checkbox" id="plain">去掉连字符</label>
  <button class="p" id="go">生成</button>
  <span class="msg" id="msg"></span>
</div>
<div class="list" id="out"></div>
<div class="row" style="margin-top:10px"><button id="copyall">复制全部</button><span class="muted">标准 v4（随机）UUID，用加密随机数生成。</span></div>
BODY_UUID;

const TC_TOOLBOX_JS_UUID = <<<'JS_UUID'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function uuid(){
  if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();
  var u=new Uint8Array(16);crypto.getRandomValues(u);
  u[6]=(u[6]&0x0f)|0x40;   // 版本 4
  u[8]=(u[8]&0x3f)|0x80;   // 变体 10xx
  var h=[],i;
  for(i=0;i<16;i++)h.push((u[i]+0x100).toString(16).slice(1));
  return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('');
}
function render(){
  var cnt=Math.max(1,Math.min(200,parseInt($('#cnt').value,10)||5)),up=$('#upper').checked,plain=$('#plain').checked;
  var out=[],i,v;
  for(i=0;i<cnt;i++){v=uuid();if(up)v=v.toUpperCase();if(plain)v=v.replace(/-/g,'');out.push(v)}
  $('#msg').className='msg ok';$('#msg').textContent='已生成 '+cnt+' 条';
  $('#out').innerHTML=out.map(function(v){return '<div class="it"><span class="mono">'+esc(v)+'</span><button class="sm" data-u="'+esc(v)+'">复制</button></div>'}).join('');
}
$('#go').onclick=render;
$('#upper').onchange=render;
$('#plain').onchange=render;
$('#out').addEventListener('click',function(e){
  var b=e.target.closest('button[data-u]');if(!b)return;
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(b.getAttribute('data-u')).then(function(){msg('已复制','ok')},function(){msg('请手动选择复制','bad')});
  else msg('请手动选择复制','bad');
});
$('#copyall').onclick=function(){
  var v=[].map.call($('#out').querySelectorAll('button[data-u]'),function(b){return b.getAttribute('data-u')}).join('\n');
  if(!v)return msg('还没有生成','bad');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){msg('已复制全部','ok')},function(){msg('复制被浏览器拒绝','bad')});
  else msg('请手动选择复制','bad');
};
render();
JS_UUID;

// ============ 8. 颜色转换 ============
const TC_TOOLBOX_HTML_COLOR = <<<'BODY_COLOR'
<h1>颜色转换</h1>
<div class="row">
  <input type="color" id="pick" value="#2563eb">
  <input type="text" id="hex" value="#2563eb" spellcheck="false" style="width:130px">
  <button class="p" id="go">转换</button>
  <span class="msg" id="msg"></span>
</div>
<div class="row" style="align-items:stretch">
  <div style="flex:0 0 180px"><div class="swatch" id="sw"></div></div>
  <div style="flex:1"><div class="kv" id="out"></div></div>
</div>
<h2>深浅色阶</h2>
<div class="row tight" id="scale"></div>
<h2>常用中性色</h2>
<div class="row tight" id="presets"></div>
BODY_COLOR;

const TC_TOOLBOX_JS_COLOR = <<<'JS_COLOR'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function hex2rgb(h){
  h=String(h).trim().replace(/^#/,'');
  if(h.length===3)h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
  if(!/^[0-9a-fA-F]{6}$/.test(h))return null;
  return {r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};
}
function rgb2hex(c){
  return '#'+[c.r,c.g,c.b].map(function(v){return Math.round(v).toString(16).padStart(2,'0')}).join('');
}
function rgb2hsl(c){
  var r=c.r/255,g=c.g/255,b=c.b/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,h=0,s=0,l=(mx+mn)/2;
  if(d){
    s=l>0.5?d/(2-mx-mn):d/(mx+mn);
    if(mx===r)h=((g-b)/d+(g<b?6:0));
    else if(mx===g)h=((b-r)/d+2);
    else h=((r-g)/d+4);
    h*=60;
  }
  return {h:Math.round(h),s:Math.round(s*100),l:Math.round(l*100)};
}
function hsl2rgb(h,s,l){
  h=((h%360)+360)%360;s/=100;l/=100;
  var c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2,r=0,g=0,b=0;
  if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}
  else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}
  return {r:(r+m)*255,g:(g+m)*255,b:(b+m)*255};
}
function shade(hex,p){
  var c=hex2rgb(hex),h=rgb2hsl(c),out=[],i;
  for(i=-4;i<=4;i++)out.push(rgb2hex(hsl2rgb(h.h,h.s,Math.max(4,Math.min(96,h.l+i*9)))));
  return out;
}
function show(hex){
  var c=hex2rgb(hex);
  if(!c)return msg('不是合法的颜色值（支持 #rgb 与 #rrggbb）','bad');
  msg('','');
  var h=rgb2hsl(c);
  $('#hex').value=rgb2hex(c);$('#pick').value=rgb2hex(c);$('#sw').style.background=rgb2hex(c);
  $('#out').innerHTML=[
    ['HEX',rgb2hex(c)],
    ['RGB','rgb('+c.r+', '+c.g+', '+c.b+')'],
    ['HSL','hsl('+h.h+', '+h.s+'%, '+h.l+'%)'],
    ['亮度','约 '+Math.round((0.299*c.r+0.587*c.g+0.114*c.b)/255*100)+'%（深浅参考）']
  ].map(function(r){return '<b>'+r[0]+'</b><span class="mono">'+r[1]+'</span>'}).join('');
  $('#scale').innerHTML=shade(hex).map(function(v,i){
    return '<button class="sm mono" data-c="'+v+'" style="background:'+v+';color:'+(i<4?'#111':'#fff')+';border-color:'+v+'">'+v.slice(1)+'</button>';
  }).join('');
}
$('#go').onclick=function(){show($('#hex').value)};
$('#hex').addEventListener('keydown',function(e){if(e.key==='Enter')show($('#hex').value)});
$('#hex').addEventListener('input',function(){if(hex2rgb($('#hex').value))show($('#hex').value)});
$('#pick').addEventListener('input',function(){show($('#pick').value)});
$('#presets').innerHTML=['#111827','#374151','#6b7280','#9ca3af','#d1d5db','#f3f4f6','#ffffff','#ef4444','#f59e0b','#22c55e','#3b82f6','#8b5cf6']
  .map(function(v){return '<button class="sm mono" data-c="'+v+'" style="background:'+v+';width:34px;height:26px;border-color:#d0d5dd" title="'+v+'"></button>'}).join('');
document.addEventListener('click',function(e){
  var b=e.target.closest('button[data-c]');if(!b)return;
  var v=b.getAttribute('data-c');show(v);
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){msg('已复制 '+v,'ok')},function(){});
});
show('#2563eb');
JS_COLOR;

// ============ 9. 正则测试 ============
const TC_TOOLBOX_HTML_RE = <<<'BODY_RE'
<h1>正则表达式测试</h1>
<div class="row">
  <span class="mono">/</span><input type="text" id="re" value="\w+@\w+\.\w+" spellcheck="false" style="min-width:280px;flex:1;font-family:ui-monospace,Menlo,Consolas,monospace"><span class="mono">/</span>
  <label><input type="checkbox" id="f-g" checked>g</label>
  <label><input type="checkbox" id="f-i">i</label>
  <label><input type="checkbox" id="f-m">m</label>
  <label><input type="checkbox" id="f-s">s</label>
  <label><input type="checkbox" id="f-u">u</label>
  <span class="msg" id="msg"></span>
</div>
<h2>测试文本</h2>
<textarea id="txt" placeholder="粘贴要测试的文本…">联系 zhang@example.com 或 li@test.org 均可。</textarea>
<h2>匹配结果</h2>
<div id="list" class="list" style="max-height:200px"></div>
<h2>高亮预览</h2>
<div id="hl" style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;background:#fff;white-space:pre-wrap;word-break:break-word"></div>
BODY_RE;

const TC_TOOLBOX_JS_RE = <<<'JS_RE'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function flags(){return ['g','i','m','s','u'].filter(function(f){return $('#f-'+f).checked}).join('')}
function run(){
  var pat=$('#re').value,text=$('#txt').value,F=flags();
  if(!pat){msg('','');$('#list').innerHTML='';$('#hl').innerHTML=esc(text);return}
  var rx;
  try{rx=new RegExp(pat,F)}catch(e){msg('正则不合法：'+e.message,'bad');$('#list').innerHTML='';$('#hl').innerHTML=esc(text);return}
  var rows=[],m,guard=0,marks=[];
  var global=/g/.test(F);
  if(global){
    while((m=rx.exec(text))!==null&&guard++<2000){
      rows.push(m);marks.push([m.index,m.index+m[0].length]);
      if(m[0]==='')rx.lastIndex++;   // 空匹配必须手动前移,否则死循环
    }
  }else{
    m=rx.exec(text);
    if(m){rows.push(m);marks.push([m.index,m.index+m[0].length])}
  }
  msg(rows.length?('匹配到 '+rows.length+' 处'+(global?'':'（未开 g，只取第一处）')):'没有匹配',''+(rows.length?'ok':''));
  $('#list').innerHTML=rows.length?rows.map(function(m,i){
    var g=[];
    for(var k=1;k<m.length;k++)g.push('<span class="muted">$'+k+'</span> '+esc(m[k]===undefined?'(未参与)':m[k]));
    return '<div class="it"><span class="mono" style="flex:0 0 46px">'+(m.index)+'</span><span class="mono" style="flex:1">'+esc(m[0])+'</span>'
      +'<span class="mono" style="flex:1">'+(g.join(' · ')||'<span class="muted">无分组</span>')+'</span></div>';
  }).join(''):'<div class="it"><span class="muted">没有匹配</span></div>';
  // 高亮:先转义再按区间插入 <mark>,避免把文本里的标签当 HTML 执行
  marks.sort(function(a,b){return a[0]-b[0]});
  var out='',pos=0;
  marks.forEach(function(r){
    if(r[0]<pos)return;
    out+=esc(text.slice(pos,r[0]))+'<mark>'+esc(text.slice(r[0],r[1]))+'</mark>';
    pos=r[1];
  });
  $('#hl').innerHTML=out+esc(text.slice(pos));
}
['#re','#txt','#f-g','#f-i','#f-m','#f-s','#f-u'].forEach(function(s){
  var el=$(s);el.addEventListener('input',run);el.addEventListener('change',run);
});
run();
JS_RE;

// ============ 10. 文本处理 ============
const TC_TOOLBOX_HTML_TEXT = <<<'BODY_TEXT'
<h1>文本处理</h1>
<div class="row tight">
  <button id="trim">去首尾空白</button>
  <button id="uniq">行去重</button>
  <button id="blank">删空行</button>
  <button id="sort">按行排序</button>
  <button id="rsort">倒序</button>
  <button id="lower">转小写</button>
  <button id="upper">转大写</button>
  <button id="json">转 JSON 字符串</button>
  <button id="wrapper">按行加引号+逗号</button>
  <button id="undo">撤销</button>
  <span class="msg" id="msg"></span>
</div>
<textarea id="a" placeholder="在这里粘贴文本，再点上面的按钮处理…"></textarea>
<div class="row" style="margin-top:10px">
  <span class="muted" id="stat"></span>
  <span class="muted" style="margin-left:auto"></span>
  <button class="sm" id="copy">复制</button>
  <button class="sm" id="clear">清空</button>
</div>
BODY_TEXT;

const TC_TOOLBOX_JS_TEXT = <<<'JS_TEXT'
var $=function(s){return document.querySelector(s)};
function msg(t,cls){var m=$('#msg');m.textContent=t||'';m.className='msg'+(cls?' '+cls:'')}
var history=[];
function stat(){
  var v=$('#a').value,lines=v?v.split('\n').length:0,chars=v.length;
  var cjk=(v.match(/[\u4e00-\u9fa5]/g)||[]).length;
  var words=0;
  if(v.trim())words=(cjk?v.replace(/[\u4e00-\u9fa5]/g,' '):v).trim().split(/\s+/).filter(Boolean).length+cjk;
  $('#stat').textContent=lines+' 行 · '+chars+' 字符 · 约 '+words+' 词 · '+new Blob([v]).size+' 字节';
}
function apply(fn,label){
  history.push($('#a').value);
  if(history.length>50)history.shift();
  $('#a').value=fn($('#a').value);
  stat();msg('已'+label,'ok');
}
$('#trim').onclick=function(){apply(function(v){return v.split('\n').map(function(s){return s.trim()}).join('\n')},'去首尾空白')};
$('#uniq').onclick=function(){apply(function(v){
  var seen={},out=[];
  v.split('\n').forEach(function(s){var k=s.trim();if(k===''){out.push(s);return}if(seen[k])return;seen[k]=1;out.push(s)});
  return out.join('\n');
},'按行去重')};
$('#blank').onclick=function(){apply(function(v){return v.split('\n').filter(function(s){return s.trim()!==''}).join('\n')},'删空行')};
$('#sort').onclick=function(){apply(function(v){return v.split('\n').sort(function(a,b){return a.localeCompare(b,'zh')}).join('\n')},'排序')};
$('#rsort').onclick=function(){apply(function(v){return v.split('\n').sort(function(a,b){return b.localeCompare(a,'zh')}).join('\n')},'倒序')};
$('#lower').onclick=function(){apply(function(v){return v.toLowerCase()},'转小写')};
$('#upper').onclick=function(){apply(function(v){return v.toUpperCase()},'转大写')};
$('#json').onclick=function(){apply(function(v){return JSON.stringify(v)},'转 JSON 字符串')};
$('#wrapper').onclick=function(){apply(function(v){
  return v.split('\n').map(function(s){return '"'+s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'}).join(',\n');
},'按行加引号')};
$('#undo').onclick=function(){
  if(!history.length)return msg('没有可撤销的操作','bad');
  $('#a').value=history.pop();stat();msg('已撤销','ok');
};
$('#clear').onclick=function(){history.push($('#a').value);$('#a').value='';stat();msg('')};
$('#copy').onclick=function(){
  var v=$('#a').value;if(!v)return msg('内容是空的','bad');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(function(){msg('已复制','ok')},function(){$('#a').focus();$('#a').select()});
  else{$('#a').focus();$('#a').select();try{document.execCommand('copy');msg('已复制','ok')}catch(e){msg('请按 Ctrl+C 复制','bad')}}
};
$('#a').addEventListener('input',stat);
stat();
JS_TEXT;

// ============ 组装 ============
/**
 * 装配一整套工具页。用字符串拼接注入共用样式与脚本,不用 heredoc 插值:
 * 工具内容里出现的 $ 与反引号都不会被 PHP 或 JS 模板串解释出错。
 */
function tc_toolbox_default_page($title, $body, $script) {
    return '<!doctype html>' . "\n"
        . '<html lang="zh-CN"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>' . $title . '</title><style>' . TC_TOOLBOX_DEFAULT_CSS . '</style></head><body>'
        . $body
        . '<script>' . $script . '</' . 'script></body></html>';
}

/**
 * 系统工具库的初始内容:5 个分类 + 10 套常用小工具。
 * 每套都是独立整页(自带样式与脚本),与用户自存的工具格式完全一致。
 */
function tc_toolbox_default_system() {
    $mk = 'tc_toolbox_default_page';
    return array(
        'cats' => array(
            array('id' => 'enc', 'name' => '编码转换'),
            array('id' => 'dev', 'name' => '开发辅助'),
            array('id' => 'gen', 'name' => '随机生成'),
            array('id' => 'text', 'name' => '文本处理'),
            array('id' => 'ui', 'name' => '颜色与设计'),
        ),
        'items' => array(
            array('id' => 'base64', 'cat' => 'enc', 'title' => 'Base64 编解码',
                'html' => $mk('Base64 编解码', TC_TOOLBOX_HTML_BASE64, TC_TOOLBOX_JS_BASE64)),
            array('id' => 'urlcode', 'cat' => 'enc', 'title' => 'URL 编解码',
                'html' => $mk('URL 编解码', TC_TOOLBOX_HTML_URL, TC_TOOLBOX_JS_URL)),
            array('id' => 'jsonfmt', 'cat' => 'enc', 'title' => 'JSON 格式化 / 校验',
                'html' => $mk('JSON 格式化 / 校验', TC_TOOLBOX_HTML_JSON, TC_TOOLBOX_JS_JSON)),
            array('id' => 'timestamp', 'cat' => 'dev', 'title' => '时间戳转换',
                'html' => $mk('时间戳转换', TC_TOOLBOX_HTML_TIME, TC_TOOLBOX_JS_TIME)),
            array('id' => 'hash', 'cat' => 'dev', 'title' => '哈希 / 摘要计算',
                'html' => $mk('哈希 / 摘要计算', TC_TOOLBOX_HTML_HASH, TC_TOOLBOX_JS_HASH)),
            array('id' => 'regex', 'cat' => 'dev', 'title' => '正则表达式测试',
                'html' => $mk('正则表达式测试', TC_TOOLBOX_HTML_RE, TC_TOOLBOX_JS_RE)),
            array('id' => 'password', 'cat' => 'gen', 'title' => '随机密码生成',
                'html' => $mk('随机密码生成', TC_TOOLBOX_HTML_PWD, TC_TOOLBOX_JS_PWD)),
            array('id' => 'uuid', 'cat' => 'gen', 'title' => 'UUID 生成',
                'html' => $mk('UUID 生成', TC_TOOLBOX_HTML_UUID, TC_TOOLBOX_JS_UUID)),
            array('id' => 'color', 'cat' => 'ui', 'title' => '颜色转换与色阶',
                'html' => $mk('颜色转换与色阶', TC_TOOLBOX_HTML_COLOR, TC_TOOLBOX_JS_COLOR)),
            array('id' => 'texttool', 'cat' => 'text', 'title' => '文本处理（去重 / 排序 / 大小写）',
                'html' => $mk('文本处理', TC_TOOLBOX_HTML_TEXT, TC_TOOLBOX_JS_TEXT)),
        ),
    );
}
