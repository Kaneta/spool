// vitest.config.ts — unit test 専用。e2e/ は Playwright (npm run e2e:pc) が所有するため
// vitest の収集対象から除外する (Playwright spec を vitest が読むと collect error になる)。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
