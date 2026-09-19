// sw.js — §5.5 offline app shell。静的資産のみを扱い、本文・IndexedDB・API には触れない。
// network-first (navigation) → cache fallback、hashed asset は cache-first。
// markdown-preview.html (UI-DESIGN.md §12): Composer の別 tab preview page。静的 shell の一部。
// offline でも OPEN PREVIEW → shell → BroadcastChannel handshake → render が通ること (query 付き
// navigation は canonical key へ倒し、query 毎の cache key を作らない)。
const CACHE = "spool-shell-v3";
// record.html: Search から別 tab で開く read-only reading page (UI-DESIGN.md §10)。静的 shell の一部。
const SHELL = ["/", "/index.html", "/record.html", "/markdown-preview.html"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // preview page の hashed 資産を先取り cache。preview page は通常利用で開かれない事があるため、
    // 1 回目の offline open でも render 可能にする (composer / record は通常 load 時に cache される)。
    const html = await fetch("/markdown-preview.html").then((r) => r.text()).catch(() => "");
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await Promise.all(assets.map((a) => fetch(a).then((r) => cache.put(a, r)).catch(() => {})));
  })());
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
    // HTML: network-first → cache fallback。更新を cache に閉じ込めない。
    // cache key は query を落とした canonical shell (/ /record.html /markdown-preview.html) のみ。
    const shellKey =
      url.pathname === "/record.html" ? "/record.html" :
      url.pathname === "/markdown-preview.html" ? "/markdown-preview.html" : "/";
    event.respondWith((async () => {
      try {
        const fresh = await fetch(event.request);
        const cache = await caches.open(CACHE);
        cache.put(shellKey, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        // 要求 path の shell を先に見る。preview は Composer (/) や record shell へ倒さない
        // (誤った page を返さない)。record は従来どおり / へ倒してよい。
        const cached = (await caches.match(event.request)) ?? (await caches.match(shellKey));
        if (cached) return cached;
        if (shellKey === "/record.html") {
          return (await caches.match("/")) ?? (await caches.match("/index.html")) ?? Response.error();
        }
        return Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // hashed asset: URL が content-hash 付きで不変 → cache-first / network fallback。
    // ignoreVary: Vite が asset response に付ける Vary: Origin が match を mismatch にする
    // (hash 付き URL を key にしている以上 Vary は無視してよい) のを避ける。
    event.respondWith((async () => {
      const cached = await caches.match(event.request, { ignoreVary: true });
      if (cached) return cached;
      const fresh = await fetch(event.request);
      const cache = await caches.open(CACHE);
      cache.put(event.request, fresh.clone()).catch(() => {});
      return fresh;
    })());
  }
});
