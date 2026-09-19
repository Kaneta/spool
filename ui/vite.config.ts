// vite.config.ts — Mobile/Web build entry list。Mobile build (main.mobile.ts) と
// 同一 origin の read-only Saved Record page (record.html)、Markdown Preview page
// (markdown-preview.html, Composer session channel 連携) を 1 回の build で出す。
// PC build (vite.pc.config.ts) は entry が違い、この file を使わない。
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // modulepreload link は実測で SW を素通りする (offline: preload 失敗 → module script も
    // 毒される)。offline shell のため entry のみで十分なので link 生成を止める (§23)。
    modulePreload: false,
    rollupOptions: {
      input: ["index.html", "record.html", "markdown-preview.html"],
    },
  },
});
