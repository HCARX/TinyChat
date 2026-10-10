/* TinyChat Service Worker
 * 策略:同源 GET 静态资源按类型区分——
 *   脚本/样式(js/css)走 network-first:发版后即使浏览器缓存了旧副本也能立刻拿到新代码。
 *   早期版本对全部静态资源都用 stale-while-revalidate,导致「刷新一次仍是旧 JS、修复要刷两次」
 *   (第三方登录票据消费这类启动期逻辑尤其受影响)。
 *   其余资源(图片/字体/图标)仍用 stale-while-revalidate,省流量、加载快。
 * HTML 页面 / API / SSE 流式 / /v1 出口一律直连,绝不缓存(登录态与流式响应不可缓存)。
 */
const CACHE = 'tinychat-static-2.0.164';
// 本 SW 拥有的缓存前缀。清理时只删自己这一族,不动同源下别的应用/子站缓存。
const CACHE_PREFIX = 'tinychat-static-';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 部署前缀:SW 可能注册在子目录(/subdir/),路径判断前先剥掉前缀,
// 否则子目录部署时 /subdir/api/... 会被误判为静态资源而缓存(旧版 bug)。
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  let p = url.pathname;
  if (BASE && p.indexOf(BASE) === 0) p = p.slice(BASE.length) || '/';
  // 接口与流式响应永不缓存
  if (p.indexOf('/api/') === 0 || p.indexOf('/v1/') === 0 || p.slice(-4) === '.php') return;
  // HTML 页面不缓存(登录态、版本更新需要即时生效)
  if (p === '/'
    || p.slice(-5) === '.html'
    || p === '/app' || p === '/admin' || p === '/login'
    // 笔记页与笔记分享页:都是路由到 HTML 的地址,漏掉它们会把页面 shell 缓存下来,
    // 分享链接失效后仍能打开旧页面(表单里的内容还会泄露给下一个使用者)
    || p === '/ainotes' || p === '/agreement'
    // 同样路由到 index.html 的两个整屏模块地址:缓存住 shell 会让发版后的新代码拿不到
    || p === '/im' || p === '/browser'
    || p.indexOf('/s/') === 0 || p.indexOf('/n/') === 0) return;
  // 样式和 sw.js 自身直连。旧的 network-first 仍会把请求放进 Cache Storage,
  // 浏览器刷新时先拿这份缓存,版本号变了也要等下一次才换成新样式。
  if (p.indexOf('/static/css/') === 0 || p.slice(-4) === '.css' || p.slice(-6) === '/sw.js') return;
  // 脚本:network-first(拿不到网络才回退缓存)
  if (p.indexOf('/static/js/') === 0) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.open(CACHE)
          .then((cache) => cache.match(req))
          .then((hit) => hit || Response.error()))
    );
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
