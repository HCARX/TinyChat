/* 本地大块数据存储契约自检:
 *   node tests/local-store.js
 *
 * 背景:会话列表(oc_chats_<uid>)与「删除副本」(oc_chat_delcopies_<uid>)里带着图片的
 * data URL —— 消息 content 内联一份、attachments[].dataUrl 再存一份,一张 3MB 的图在本地
 * 就是 800 万字符;localStorage 每源只有约 5MB(实测 5,242,837 字符),两三张图就写不下。
 * 笔记正文同理:单篇上限 50 万**字节**,十来篇就压满。写不下时旧实现只 console.warn,
 * 用户看到的是「这次对话没存住,刷新回到上一版」。
 * 现在这几处统一走 static/js/store.js(IndexedDB 优先,localStorage 兜底)。
 *
 * 这里钉的是「读代码看不出来」的那几条:
 *   1) 大块键不得再直接走 localStorage —— 少改一处就是那一处继续受 5MB 限制,
 *      功能照常、界面照常,只有用户的图存不住;
 *   2) 读之前必须先 await 打开本地库(库是异步打开的,读在它前面就只能拿到空列表);
 *   3) 旧键迁移必须先落新家再拆旧家,且库打不开时不许删(删了就真丢了);
 *   4) 新库里有数据时旧键不得盖回去(升级后第二次打开,新数据比陈旧的 localStorage 新);
 *   5) 浏览器不给用 IndexedDB 时整层退回 localStorage(不能因为换存储把页面弄坏);
 *   6) index.html 里 store.js 必须排在用到它的脚本之前(defer 按文档顺序执行)。
 *
 * 检查的是源码;真正的读写行为由 tests/local-store-gui.mjs 在真浏览器里量。
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

console.log('== 1. 大块键不得再直接走 localStorage ==');
const appSrc = read('static/js/app.js');
const notesSrc = read('static/js/notes.js');
const storeSrc = read('static/js/store.js');

// 会话列表 / 删除副本:任何一处直接 setItem/getItem 都说明漏改了一处
const directChatWrites = appSrc.match(/localStorage\.(set|get|remove)Item\(\s*'oc_chats_/g) || [];
const directCopyWrites = appSrc.match(/localStorage\.(set|get|remove)Item\(\s*'oc_chat_delcopies_/g) || [];
check('app.js 里没有直接读写 oc_chats_ 的地方', directChatWrites.length === 0, directChatWrites.join(' '));
check('app.js 里没有直接读写 oc_chat_delcopies_ 的地方', directCopyWrites.length === 0, directCopyWrites.join(' '));
const directNotesWrites = notesSrc.match(/localStorage\.(set|get|remove)Item\(\s*lsDocKey\(\)/g) || [];
check('notes.js 里没有直接读写笔记本地副本的地方', directNotesWrites.length === 0, directNotesWrites.join(' '));
// 键名只该在一处拼:散开写迟早有一处漏改
check('键名收敛在 chatsKey()/delCopiesKey() 两个函数里',
  /function chatsKey\(\)/.test(appSrc) && /function delCopiesKey\(\)/.test(appSrc),
  '键名散落在各处,漏改一处就退回 5MB 的旧存储');
check('这些键都经 OCStore,不再直连 localStorage',
  /window\.OCStore\.set\(chatsKey\(\)/.test(appSrc)
  && /window\.OCStore\.get\(chatsKey\(\)/.test(appSrc)
  && /window\.OCStore\.set\(delCopiesKey\(\)/.test(appSrc)
  && /window\.OCStore\.set\(lsDocKey\(\)/.test(notesSrc)
  && /window\.OCStore\.get\(lsDocKey\(\)/.test(notesSrc));

console.log('\n== 2. 读之前必须先打开本地库 ==');
// 库是异步打开的;读在 ready() 之前只能拿到空列表(表现为「刷新后对话全没了」)
const readyAt = appSrc.indexOf('OCStore.ready([');
const loadAt = appSrc.indexOf('\n    loadChats();');
check('会话页在 loadChats() 之前 await OCStore.ready(…)', readyAt > 0 && loadAt > readyAt, 'ready=' + readyAt + ' loadChats=' + loadAt);
check('会话页 ready() 里传的是会话与删除副本两个键',
  /OCStore\.ready\(\[chatsKey\(\), delCopiesKey\(\)\]\)/.test(appSrc));
check('ready() 失败不拦着用(try/catch 兜底)', /try\s*\{\s*await window\.OCStore\.ready\(/.test(appSrc));
// 笔记模块:本地副本读完之前不能往下走
check('笔记模块先 await loadLocalDoc() 再判定已加载',
  /async function ensureLoaded\(\)\s*\{[^}]*ensureUser\(\)[^}]*await loadLocalDoc\(\)/s.test(notesSrc),
  'loadLocal() 直接读会读到空库');
check('笔记模块把本地副本的键声明给 OCStore',
  /OCStore\.ready\(\[lsDocKey\(\)\]\)/.test(notesSrc));

console.log('\n== 3. store.js 自身的几条底线 ==');
check('用 IndexedDB 打开库', /indexedDB\.open\(/.test(storeSrc));
check('建了对象仓库(kv)', /createObjectStore\(OBJECT_STORE,\s*\{\s*keyPath:\s*'k'\s*\}\)/.test(storeSrc));
check('有 localStorage 兜底路径', /mode === 'idb' && db/.test(storeSrc) && /lsSet\(key, s\)/.test(storeSrc));
check('库打不开时后端如实报成 ls(不假装成功)',
  /mode = 'ls'/.test(storeSrc) && /mode\(\)\s*\{\s*return mode;/.test(storeSrc));
// 迁移:先落新家、再拆旧家;库打不开时不许删
check('迁移时先写新库再删旧键(中途断电只会重复不会丢)',
  /await put\(it\.key, it\.val\);[\s\S]{0,200}?lsDel\(it\.key\);/.test(storeSrc),
  '顺序反了:写完就删,写失败就两头都没有');
check('库打不开时不删旧键', /if \(!db\) return 0;[\s\S]{0,120}?旧键原地不动/.test(storeSrc));
check('新库已有这个键时不拿旧值盖回去', /if \(mem\.has\(key\)\) \{ lsDel\(key\); continue; \}/.test(storeSrc),
  '升级后第二次打开会用陈旧的 localStorage 盖掉库里更新的数据');
check('同一键的多次写按调用顺序串行落盘', /chains/.test(storeSrc) && /tx\.oncomplete/.test(storeSrc),
  '两次写乱序会让旧值盖掉新值');
check('写不进去时提示用户一次(不是只 console.warn)', /warnOnce\(/.test(storeSrc) && /OCUI\.toast\(text, true\)/.test(storeSrc));
check('set() 返回是否写进了持久存储(调用方据此换更小的副本)',
  /const ok = lsSet\(key, s\);/.test(storeSrc) && /return ok;/.test(storeSrc));
check('saveChats 仍保留瘦身副本兜底',
  /if \(!window\.OCStore\.set\(key, JSON\.stringify\(state\.chats\)\)\)/.test(appSrc)
  && /slimChatsForStore\(state\.chats\)/.test(appSrc));

console.log('\n== 5. 兜底与清理的接线 ==');
// 落盘失败(配额满)时 set() 已经同步报过成功,只能靠回调补写瘦身副本 —— 没接上就等于没有
check('app.js 给会话注册了落盘失败回调', /window\.OCStore\.onWriteFail\(/.test(appSrc) && /state\._slimRetried/.test(appSrc));
check('笔记也给自己的键注册了落盘失败回调', /window\.OCStore\.onWriteFail\(/.test(notesSrc) && /slimDocPayload\(\)/.test(notesSrc));
// 换号清理必须在启动时跑,否则「换个账号还能看到上一个人的图」
check('app.js 启动时清掉其它用户的大块副本',
  /pruneOtherUsers\(state\.user\.id\)/.test(appSrc)
  && appSrc.indexOf('pruneOtherUsers(state.user.id)') > appSrc.indexOf('OCStore.ready([chatsKey(), delCopiesKey()])'),
  '清理要么没接,要么排在打开本地库之前(那时库还没开,库里别人的数据清不掉)');
check('清理只认这三类大块键,不碰别的键',
  /oc_chats_\|oc_chat_delcopies_\|oc_notes_/.test(storeSrc)
  && !/oc_prefs/.test(storeSrc.slice(storeSrc.indexOf('BULK_KEY_RE'), storeSrc.indexOf('BULK_KEY_RE') + 900)),
  '把偏好设置之类的小键也扫进去,换号会把用户的设置一起删掉');
// 键名末尾必须正好是一个 uid(十六进制)。按 '(.+)' 通配时 oc_notes_ui_<uid>、
// oc_notes_ver_<uid>_<id>、oc_notes_guide_seen 都会落进网里 —— 症状是「每次打开都重新弹笔记引导」。
check('清理要求键名末尾正好是 uid(小键/全局标记不在网内)',
  /BULK_KEY_RE = \/\^\(\?:oc_chats_\|oc_chat_delcopies_\|oc_notes_\)\(\[0-9a-f\]\{16,\}\)\$\/i/.test(storeSrc),
  '改成通配就等着误删 oc_notes_ui_* / oc_notes_ver_* / oc_notes_guide_seen');
check('没登录时(uid 为空)不做清理', /if \(!mine\) return 0;/.test(storeSrc));
// 重复推送同样的内容纯属浪费:整套会话(含图片)白推一次,还占限流名额
check('内容与上次成功推送一致时不再推送',
  /function syncUpToDate\(\)/.test(appSrc) && /if \(syncUpToDate\(\)\) return;/.test(appSrc)
  && appSrc.indexOf('if (syncUpToDate()) return;') < appSrc.indexOf('lastPushedKey = syncContentKey()'),
  '守卫没接上,或在记录指纹之前 —— 都会让「原样重推」继续发生');
check('指纹不含 baseRevision(否则永远对不上,优化等于没做)',
  /function syncContentKey\(\)[\s\S]{0,300}?deletedChats:/.test(appSrc)
  && !/function syncContentKey\(\)[\s\S]{0,300}?baseRevision/.test(appSrc));

console.log('\n== 4. 加载顺序 ==');
const html = read('index.html');
const storeTag = html.indexOf('static/js/store.min.js');
const appTag = html.indexOf('static/js/app.min.js');
const notesTag = html.indexOf('static/js/notes.min.js');
check('index.html 引入了 store.js', storeTag > 0);
check('store.js 排在 app.js 之前(defer 按文档顺序执行)', storeTag > 0 && storeTag < appTag, storeTag + ' vs ' + appTag);
check('store.js 排在 notes.js 之前', storeTag > 0 && storeTag < notesTag, storeTag + ' vs ' + notesTag);

console.log(fail === 0 ? '\n本地存储契约自检通过\n' : '\n失败 ' + fail + ' 项\n');
process.exit(fail === 0 ? 0 : 1);
