// sw.js — §5.5 offline app shell。静的資産のみを扱い、本文・IndexedDB・API には触れない。
// network-first (navigation) → cache fallback、hashed asset は cache-first。
const CACHE = "spool-shell-v1";
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // 古い shell cache のみ削除。user 本文 (IndexedDB) には触れない
    await Promise.all(names.filter((n) => n.startsWith("spool-shell-") && n !== CACHE).map((n) => caches.delete(n)));
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return; // 非GET・cross-origin は既定動作
  if (event.request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    // HTML: network-first → cache fallback。更新を cache に閉じ込めない
    event.respondWith((async () => {
      try {
        const fresh = await fetch(event.request);
        const cache = await caches.open(CACHE);
        cache.put("/", fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cached = (await caches.match("/")) ?? (await caches.match("/index.html"));
        return cached ?? Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // hashed asset: URL が content-hash 付きで不変 → cache-first / network fallback
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const fresh = await fetch(event.request);
      const cache = await caches.open(CACHE);
      cache.put(event.request, fresh.clone()).catch(() => {});
      return fresh;
    })());
  }
});
