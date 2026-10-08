/**
 * 大块数据的本地存储:IndexedDB 优先,localStorage 兜底。
 *
 * 为什么要有这一层:会话列表(oc_chats_<uid>)与「删除副本」(oc_chat_delcopies_<uid>)里
 * 带着图片本体 —— 消息 content 里内联一份 ![](data:image/png;base64,...),attachments[].dataUrl
 * 又完整存一份,一张 300KB 的图编码后在本地就是 80 万字符。localStorage 每个源只有约 5MB
 * (Chrome / Firefox 是这个量级,Safari 私密模式直接是 0),两三张图就写满;写满之后旧实现
 * 只在 console 里 warn 一句,用户看到的是「这次对话没存住,刷新后回到上一版」。
 * IndexedDB 的配额是「磁盘可用空间的一个比例」(Chrome 最多 60%),存 base64 图片没有压力。
 *
 * 用法上刻意做成与 localStorage 同形:
 *   - 读是**同步**的(走内存镜像),调用点不必改成 async;
 *   - 写是「同步更新镜像 + 异步落盘」,同一键的多次写按调用顺序串行落盘;
 *   - 页面启动时 await OCStore.ready([...本次要用到的键]) 一次:打开库、灌满镜像,
 *     并把 localStorage 里的旧键(上一个版本留下的)迁进来 —— 迁完就删掉旧键,把那 5MB 让回去。
 *
 * 兜底:浏览器不给用 IndexedDB(隐私模式 / 被策略禁用)时整层退回 localStorage,
 * 行为与引入本模块之前一致 —— 不能因为换存储把「打不开页面」这种更糟的事引入进来。
 */
(function () {
  'use strict';
  const DB_NAME = 'oc_store';
  const DB_VER = 1;
  const OBJECT_STORE = 'kv';

  const declared = new Set();  // 已声明要用的键。迁移只碰这些,不去动别人的键(oc_prefs 等有自己的读写方)
  const mem = new Map();       // 内存镜像:读保持同步
  const chains = new Map();    // 每个键一条落盘链:两次写乱序会让旧值盖掉新值
  const fails = [];            // 最近几次落盘失败,供自检与排查

  let db = null;
  let mode = 'ls';             // 'idb' | 'ls'
  let openP = null;            // 打开库只做一次
  const warned = new Set();    // 同一类提示只弹一次(重复弹会把聊天页刷屏)
  const writeFails = new Set(); // 落盘失败(如配额满)时回调,调用方据此换更小的副本

  function noteFail(why, key, err) {
    fails.push({ why: why, key: key, msg: String((err && err.message) || err || '') });
    if (fails.length > 20) fails.shift();
  }

  // 本地实在写不下时只提示一次:重复弹窗会把聊天页刷屏,而用户能做的动作是同一个
  function warnOnce(tag, text) {
    if (warned.has(tag)) return;
    warned.add(tag);
    try {
      if (window.OCUI && typeof window.OCUI.toast === 'function') window.OCUI.toast(text, true);
      else console.warn(text);
    } catch (e) { /* 提示失败不影响主流程 */ }
  }

  function notifyWriteFail(key) {
    writeFails.forEach((fn) => { try { fn(key); } catch (e) { noteFail('hook', key, e); } });
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); return true; } catch (e) { noteFail('localStorage', key, e); return false; }
  }
  function lsDel(key) {
    try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 请求失败'));
    });
  }

  function openIdb() {
    if (openP) return openP;
    openP = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('浏览器不支持 IndexedDB')); return; }
      let req;
      try { req = window.indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(OBJECT_STORE)) d.createObjectStore(OBJECT_STORE, { keyPath: 'k' });
      };
      req.onsuccess = () => {
        const d = req.result;
        // 另一个标签页要升级或删除本库时,占着连接会让它一直卡在 blocked。
        // 让路:关掉连接并退回 localStorage 继续写(写不下时 saveChats 会瘦身兜底),
        // 下次打开页面自然连上新版本的库。
        d.onversionchange = () => {
          try { d.close(); } catch (e) { /* 忽略 */ }
          db = null;
          mode = 'ls';
          noteFail('versionchange', '', new Error('本地库被其它标签页升级'));
          warnOnce('versionchange', '浏览器本地库被其它标签页升级:本页暂用临时缓存,刷新即可恢复');
        };
        resolve(d);
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB 打不开'));
      // 同一域名下另一个标签页正卡在版本升级/删除库上:不能一直挂着等,超时即退回 localStorage
      req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'));
    }).catch((e) => { noteFail('open', '', e); return null; });
    return openP;
  }

  function put(key, val) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(() => {
      if (!db) { notifyWriteFail(key); return Promise.resolve(); }
      return new Promise((resolve) => {
        let tx;
        try { tx = db.transaction(OBJECT_STORE, 'readwrite'); } catch (e) { noteFail('tx', key, e); notifyWriteFail(key); resolve(); return; }
        // 落盘失败(多见于配额满)时通知调用方:这一次没进任何持久存储,别再报成功
        tx.onabort = tx.onerror = () => { noteFail('put', key, tx.error); notifyWriteFail(key); resolve(); };
        tx.oncomplete = () => resolve();
        try { tx.objectStore(OBJECT_STORE).put({ k: key, v: val }); } catch (e) { noteFail('put', key, e); notifyWriteFail(key); resolve(); }
      });
    });
    chains.set(key, next);
    return next;
  }

  // 删除要走真正的 delete:写一个 v:null 的记录,下次灌镜像时会变成空字符串「又回来了」
  function drop(key) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(() => {
      if (!db) return Promise.resolve();
      return new Promise((resolve) => {
        let tx;
        try { tx = db.transaction(OBJECT_STORE, 'readwrite'); } catch (e) { noteFail('tx', key, e); resolve(); return; }
        tx.onabort = tx.onerror = () => { noteFail('del', key, tx.error); resolve(); };
        tx.oncomplete = () => resolve();
        try { tx.objectStore(OBJECT_STORE).delete(key); } catch (e) { noteFail('del', key, e); resolve(); }
      });
    });
    chains.set(key, next);
    return next;
  }

  // 把 localStorage 里上一个版本留下的旧键迁进 IndexedDB,迁完删掉旧键。
  // 只在库里还没有这个键时迁:迁移失败过、用户又已经写过新数据的场景,不能被旧值盖回去。
  async function adopt(keys) {
    const pending = [];
    for (const key of keys) {
      if (declared.has(key)) continue;
      declared.add(key);
      const legacy = lsGet(key);
      if (legacy === null) continue;
      if (mem.has(key)) { lsDel(key); continue; }
      mem.set(key, legacy);
      pending.push({ key: key, val: legacy });
    }
    if (!pending.length) return 0;
    if (!db) return 0;   // 没有库(退回 localStorage)时旧键原地不动,不能删
    for (const it of pending) {
      await put(it.key, it.val);          // 先落新家
      if (chains.get(it.key)) await chains.get(it.key);
      lsDel(it.key);                      // 再拆旧家,中间断电也只会重复不会丢
    }
    return pending.length;
  }

  // 把「不是当前用户」的大块本地副本清掉。同一台电脑上换号登录后,上一位用户的会话与
  // 笔记正文(含图片)不该继续躺在磁盘上 —— 这是换号场景下唯一真正要紧的隐私问题。
  // 当前用户自己的副本一律不动:退出登录不删自己的数据,否则「刚编辑完就退出登录」
  // 这种时序会丢掉还没推上云的内容(宁可留一份可被云端覆盖的副本)。
  // 只认「正好是 <前缀><uid>」的键:uid 是 32 位十六进制(见服务端 tc_uid),不含下划线。
  // 因此 oc_notes_ui_<uid>(笔记界面状态)、oc_notes_ver_<uid>_<id>(版本历史)、
  // oc_notes_guide_seen(新手引导标记)、oc_notes_anon(未登录时的暂存)后缀都带下划线或
  // 不是十六进制,天然被排除在外 —— 早先按 '(.+)' 通配时这几种全会被当成「别人的数据」删掉,
  // 症状是「每次打开都重新弹一次笔记引导」。
  const BULK_KEY_RE = /^(?:oc_chats_|oc_chat_delcopies_|oc_notes_)([0-9a-f]{16,})$/i;
  async function pruneOtherUsers(myUid) {
    const mine = String(myUid || '');
    if (!mine) return 0;                 // 没登录(只读首页):不知道谁是「当前用户」,不动任何东西
    const isOther = (key) => {
      const m = String(key || '').match(BULK_KEY_RE);
      return !!(m && m[1] !== mine);
    };
    let removed = 0;
    // localStorage 一侧:老版本留下的、或退回 localStorage 时写的
    try {
      const victims = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (isOther(k)) victims.push(k);
      }
      victims.forEach((k) => { lsDel(k); removed++; });
    } catch (e) { noteFail('prune-ls', '', e); }
    // IndexedDB 一侧:库里可能留着上一位用户的记录(键名与镜像无关,得从库里列)
    if (db) {
      try {
        const tx = db.transaction(OBJECT_STORE, 'readonly');
        const keys = await idbRequest(tx.objectStore(OBJECT_STORE).getAllKeys());
        for (const k of keys || []) {
          if (!isOther(k)) continue;
          drop(k);
          removed++;
        }
      } catch (e) { noteFail('prune-idb', '', e); }
    }
    return removed;
  }

  const OCStore = {
    /**
     * 打开本地库并把镜像灌满;keys 是本次页面要用到的「大块数据」键名。
     * 可以多次调用(后调用的键接着声明/迁移),返回同一个 promise。
     */
    ready(keys) {
      const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string' && k);
      if (!openP) {
        openP = openIdb().then(async (d) => {
          if (!d) return;                     // 退回 localStorage:mode 保持 'ls'
          db = d;
          mode = 'idb';
          try {
            const tx = db.transaction(OBJECT_STORE, 'readonly');
            const rows = await idbRequest(tx.objectStore(OBJECT_STORE).getAll());
            (rows || []).forEach((r) => { if (r && typeof r.k === 'string') mem.set(r.k, String(r.v == null ? '' : r.v)); });
          } catch (e) { noteFail('getAll', '', e); }
        });
      }
      return openP.then(() => adopt(list));
    },

    /** 同步读。未 ready 的键退回直读 localStorage,保证早于 ready 的读不会拿到 null。 */
    get(key) {
      if (mem.has(key)) return mem.get(key);
      if (!declared.has(key)) return lsGet(key);
      return null;
    },

    /**
     * 写:同步更新镜像,异步落盘。
     * 返回 false 表示**这一次没写进任何持久存储**(localStorage 也拒绝了,通常是配额满),
     * 调用方据此换更小的副本(如 saveChats 的瘦身兜底);
     * IndexedDB 模式下总是返回 true —— 落盘失败由本层自己降级并提示。
     */
    set(key, val) {
      const s = String(val);
      mem.set(key, s);
      declared.add(key);
      if (mode === 'idb' && db) {
        put(key, s);
        return true;
      }
      const ok = lsSet(key, s);
      if (!ok) warnOnce('quota', '浏览器本地存储已满:最新内容已保存在云端,但本机缓存写不进去');
      return ok;
    },

    /** 删除(mirror + 两个后端都删)。异步部分不阻塞调用方。 */
    del(key) {
      mem.delete(key);
      lsDel(key);
      if (mode === 'idb' && db) drop(key);
    },

    /**
     * 等当前排队的落盘全部结束(自检用:写完立刻 reload 断言数据还在时,
     * 靠它替代 sleep,避免拿时序碰运气)。
     */
    flush() {
      return Promise.all(Array.from(chains.values())).then(() => undefined).catch(() => undefined);
    },

    /**
     * 注册落盘失败回调(可选,可注册多个;返回注销函数)。IndexedDB 写失败时本层
     * 没法同步把失败返回给调用方,用这个回调让调用方换更小的副本重写一次
     * (如 saveChats 的瘦身兜底、笔记的纯文本副本)。
     */
    onWriteFail(fn) {
      if (typeof fn !== 'function') return function () {};
      writeFails.add(fn);
      return function () { writeFails.delete(fn); };
    },

    /** 清掉其它用户的大块本地副本(换号登录时调用);返回清掉的键数 */
    pruneOtherUsers,

    /** 当前后端:'idb' 或 'ls'(自检与「存储用在哪」的排查用) */
    mode() { return mode; },
    /** 已声明的键与内存镜像里各自的字符数(自检用,不对外暴露内容) */
    info() {
      const keys = {};
      mem.forEach((v, k) => { keys[k] = v.length; });
      return { mode: mode, declared: Array.from(declared), keys: keys, fails: fails.slice(-5) };
    },
  };

  window.OCStore = OCStore;
})();