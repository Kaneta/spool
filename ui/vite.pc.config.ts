// vite.pc.config.ts — PC build (M2 Unit 5 §3)。entry: index-pc.html → output: ../pc/web/dist。
// Mobile build (既定 config) とは entry と出力先だけが違い、runtime probing は存在しない。
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false, // public/ は Mobile 専用 (sw.js)。PC build には載せない (§5)
  build: {
    outDir: "../pc/web/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "index-pc.html", // 出力名は入力 file 名になるため、npm script で index.html に rename する
    },
  },
});
