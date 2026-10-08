/* 正文内联图片契约自检:
 *   node tests/chat-image-inline.js
 *
 * 一张图在消息里有两个去处,用途不同、上限也完全不同:
 *   - attachments[].dataUrl:原图。发给上游模型(toApiContent)、对话页渲染(app.js
 *     userMsgDisplay 据此重建)、云同步带着它(服务端上限 8MB)。
 *   - content 里的 ![](data:...):正文内联副本。**聊天分享只带走 role+content**
 *     (服务端 tc_sanitize_share_messages),所以分享页的图只有这一份 —— 不能省;
 *     但 content 在服务端有 200000 字符上限(tc_sanitize_chats),内联原图会被整段切掉,
 *     分享页反而**完全没图**,每次云同步还要白白推上去几 MB。
 * 现在的做法:content 里只内联长边 ≤1280 的缩略图(约 10 万字符),原图仍走 attachments。
 *
 * 这里钉的是「读代码看不出来」的那几条:
 *   1) 三处正文组装(普通发送/生图/生视频)都必须走 messageContentFor,
 *      任何一处漏掉 = 那一条路径继续把原图内联进正文;
 *   2) 内联总预算必须小于服务端 200000 的截断线(否则尾部的图会被切掉);
 *   3) 缩略图拿不到时必须「不内联」而不是退回原图(退回原图就等于没修);
 *   4) 对话页渲染仍要用原图重建(userMsgDisplay 不能改成用缩略图);
 *   5) readFile 必须在返回附件前就把缩略图算好(正文组装是同步的,事后补来不及)。
 *
 * 检查的是源码;真实体积与分享页效果由 tests/chat-image-preview-gui.mjs 在真浏览器里量。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let fail = 0;
const check = (m, c, d) => {
  if (c) console.log('  ✓ ' + m);
  else { fail++; console.log('  ✗ ' + m + (d ? ' —— ' + d : '')); }
};
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const count = (s, re) => (s.match(re) || []).length;
// 取一个函数体(从签名到下一个同缩进的 function/top-level 声明),够用来做「这个函数里有没有…」
const bodyOf = (src, sig) => {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const j = src.indexOf('\nfunction ', i + sig.length);
  const k = src.indexOf('\n(async function', i + sig.length);
  const ends = [j, k].filter((n) => n > 0);
  return src.slice(i, ends.length ? Math.min.apply(null, ends) : src.length);
};

console.log('== 1. 三处正文组装都走统一入口 ==');
const appSrc = read('static/js/app.js');
const mmSrc = read('static/js/multimodal.js');

// 定义 1 处 + 调用 3 处(普通发送 postUserTurn、生图 sendImageTurn、生视频 sendVideoTurn)
const entryUses = count(appSrc, /messageContentFor\(/g);
check('messageContentFor 出现 4 次(1 定义 + 3 调用)', entryUses === 4, '实际 ' + entryUses);
// 原图 markdown 只允许出现在两处:messageContentFor 的旧版兜底、userMsgDisplay 的渲染重建
const rawMarkdownLines = appSrc.split('\n')
  .map((line, i) => ({ n: i + 1, line: line }))
  .filter((x) => /OCMultimodal\.toMarkdown\(/.test(x.line))
  .map((x) => x.n);
const entryBody = bodyOf(appSrc, 'function messageContentFor(');
const displayBody = bodyOf(appSrc, 'function userMsgDisplay(');
const inRange = (lineNo, body) => {
  if (!body) return false;
  const start = appSrc.slice(0, appSrc.indexOf(body)).split('\n').length;
  const end = start + body.split('\n').length;
  return lineNo >= start && lineNo <= end;
};
check('app.js 里直接拼原图 markdown 的只剩渲染重建那 2 处(旧的正文组装已清掉)',
  rawMarkdownLines.length === 2, '实际行号 ' + rawMarkdownLines.join(','));
check('这 2 处都在 userMsgDisplay(渲染重建)里,没有正文组装',
  rawMarkdownLines.every((n) => inRange(n, displayBody)),
  '行号 ' + rawMarkdownLines.join(','));
check('正文组装的旧版兜底只在 messageContentFor 内部(拿不到新模块时)',
  /function messageContentFor\([\s\S]{0,400}?mm\.toMarkdown\(a\)/.test(appSrc) && !!entryBody);

console.log('\n== 2. 预算必须小于服务端截断线 ==');
const budget = Number((mmSrc.match(/const CONTENT_IMAGE_BUDGET = (\d+)/) || [])[1]);
const perImage = Number((mmSrc.match(/const PREVIEW_MAX_CHARS = (\d+)/) || [])[1]);
const apiSrc = read('lib/api.php');
const caps = (apiSrc.match(/tc_md_safe_cut\([^,]+,\s*(\d+)\)/g) || []).map((m) => Number(m.replace(/\D+/g, '')));
const serverCap = caps.length ? Math.min.apply(null, caps) : 0;
check('multimodal.js 声明了内联预算与单图上限', budget > 0 && perImage > 0, 'budget=' + budget + ' perImage=' + perImage);
check('单图上限不超过整条预算', perImage <= budget, perImage + ' > ' + budget);
check('整条预算留出服务端余量(服务端 content 上限 ' + serverCap + ')', serverCap === 200000 && budget < serverCap, budget + ' vs ' + serverCap);

console.log('\n== 3. 拿不到缩略图就不内联(不能退回原图)==');
check('toMarkdownPreview 在没有 previewUrl 时返回空串',
  /function toMarkdownPreview\(attach\)[\s\S]{0,300}?if \(!url\) return '';/.test(mmSrc));
check('buildMessageContent 对空片段/超预算片段都跳过',
  /if \(!md \|\| md\.length > budget\) return;/.test(mmSrc));
check('makePreview 允许失败(返回空串)', /function makePreview\(dataUrl\)/.test(mmSrc) && count(bodyOf(mmSrc, 'function makePreview('), /resolve\(''\)/g) >= 3);
check('readFile 在返回附件前就算好缩略图(正文组装是同步的)',
  /const previewUrl = await makePreview\(dataUrl\);[\s\S]{0,200}?dataUrl, previewUrl, mediaType/.test(mmSrc));
check('绘图/视频的参考图也先补缩略图',
  count(appSrc, /await ensurePreviews\(refAtts\);/g) === 2, '实际 ' + count(appSrc, /await ensurePreviews\(refAtts\);/g));

console.log('\n== 4. 对话页仍按原图渲染,分享页仍拿到图 ==');
check('userMsgDisplay 用附件里的原图重建气泡(不是缩略图)',
  /function userMsgDisplay[\s\S]{0,500}?OCMultimodal\.toMarkdown/.test(appSrc));
check('toMarkdown(原图)仍然存在,是渲染重建与上游请求共用的那份',
  /function toMarkdown\(attach\)[\s\S]{0,140}?return `!\[\$\{attach\.name\}\]\(\$\{attach\.dataUrl\}\)`;/.test(mmSrc));
check('toApiContent 仍用原图 dataUrl 发给上游',
  /image_url: \{ url: img\.dataUrl \}/.test(mmSrc) && /data: raw/.test(mmSrc));
const shareBody = bodyOf(apiSrc, 'function tc_sanitize_share_messages(');
check('分享只带走 role+content(所以正文里那份缩略图不能省)',
  /'content' => \$content/.test(shareBody) && !/attachments/.test(shareBody), shareBody.slice(0, 80));

console.log('\n== 5. 瘦身副本不会把原图重新内联 ==');
check('stripInlineImagesForSlim 存在并被 slimChatsForStore 使用',
  /function stripInlineImagesForSlim\(text\)/.test(appSrc) && /stripInlineImagesForSlim\(msg\.content\)/.test(appSrc));

console.log('\n' + (fail === 0 ? '正文内联图片契约自检通过' : '正文内联图片契约自检失败: ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
