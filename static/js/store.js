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
  let warnedFull = false;

  function noteFail(why, key, err) {
    fails.push({ why: why, key: key, msg: String((err && err.message) || err || '') });
    if (fails.length > 20) fails.shift();
  }

  // 本地实在写不下时只提示一次:重复弹窗会把聊天页刷屏,而用户能做的动作是同一个
  function warnOnce(text) {
    if (warnedFull) return;
    warnedFull = true;
    try {
      if (window.OCUI && typeof window.OCUI.toast === 'function') window.OCUI.toast(text, true);
      else console.warn(text);
    } catch (e) { /* 提示失败不影响主流程 */ }
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打不开'));
      // 同一域名下另一个标签页正卡在版本升级/删除库上:不能一直挂着等,超时即退回 localStorage
      req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'));
    }).catch((e) => { noteFail('open', '', e); return null; });
    return openP;
  }

  function put(key, val) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(() => {
      if (!db) return Promise.resolve();
      return new Promise((resolve) => {
        let tx;
        try { tx = db.transaction(OBJECT_STORE, 'readwrite'); } catch (e) { noteFail('tx', key, e); resolve(); return; }
        tx.onabort = tx.onerror = () => { noteFail('put', key, tx.error); resolve(); };
        tx.oncomplete = () => resolve();
        try { tx.objectStore(OBJECT_STORE).put({ k: key, v: val }); } catch (e) { noteFail('put', key, e); resolve(); }
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
      if (!ok) warnOnce('浏览器本地存储已满:最新内容已保存在云端,但本机缓存写不进去');
      return ok;
    },

    /** 删除(mirror + 两个后端都删)。异步部分不阻塞调用方。 */
    del(key) {
      mem.delete(key);
      lsDel(key);
      if (mode === 'idb' && db) drop(key);
    },

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