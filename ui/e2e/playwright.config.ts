// playwright.config.ts — PC E2E (M2 Unit 5 §24)。実 Go process + production PC build を使い、
// fake server だけでは完成判定にしない (Baseline §14)。webServer は使わず、spec が
// go build した実 binary を temp root で起動する (port 0 → actual port を stdout から取得)。
// 配置は ui/e2e (ui/node_modules の解決経路に乗る。DESIGN §14 の test/playwright 相当)。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "pc.spec.ts",
  timeout: 30_000,
  workers: 1, // 1 process / 1 root を全 test で共有するため直列
  use: {
    headless: true,
  },
});
