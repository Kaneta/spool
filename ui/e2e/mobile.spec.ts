// mobile.spec.ts — Bug 5 regression: IndexedDB open 失敗が UI に見え、Save 等が disabled に
// なり、fallback storage に逃がさないこと。実 browser (Chromium) 上で indexedDB.open を
// 失敗させる限定 fault injection。実 Go process は不要 (Mobile は純 browser build)。
// UI は vite dev server で配信する (production build ではなく、挙動は同一 module による)。
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

const uiDir = path.resolve(import.meta.dirname, ".."); // ui/e2e → ui

let dev: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  dev = spawn("npx", ["vite", "--port", "0", "--strictPort"], {
    cwd: uiDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise<string>((resolve, reject) => {
    let out = "";
    dev!.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/localhost:(\d+)\//);
      if (m) resolve(m[0]);
    });
    dev!.on("exit", (code) => reject(new Error(`vite exited early: ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`vite startup timeout\n${out}`)), 15_000);
  });
});

test.afterAll(async () => {
  if (dev !== undefined && dev.exitCode === null) {
    dev.kill("SIGTERM");
    await new Promise<void>((resolve) => dev!.on("exit", () => resolve()));
  }
});

test("IndexedDB open failure: visible error, Save disabled, no fallback", async ({ page }) => {
  await page.addInitScript(() => {
    // 限定 fault injection: open だけを常に失敗させる。他の API は触らない。
    // 実 request の error event に error を載せ、onerror → reject 経路に入れる。
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((name: string, version?: number) => {
      const req = original(name, version);
      queueMicrotask(() => {
        Object.defineProperty(req, "error", { value: new DOMException("injected failure", "UnknownError"), configurable: true });
        req.dispatchEvent(new Event("error"));
      });
      return req;
    }) as typeof indexedDB.open;
  });
  await page.goto(base);
  await expect(page.locator("#storage-state")).toContainText("Storage unavailable");
  await expect(page.locator("#save")).toBeDisabled();
  await expect(page.locator("#export-all")).toBeDisabled();
  await expect(page.locator("#copy")).toBeDisabled();
  await expect(page.locator("#delete")).toBeDisabled();
  await expect(page.locator("#export-txt")).toBeDisabled();
  // Save 処理へ進まない: textarea に入れても result は空のまま (fallback 保存も起こらない)
  await page.fill("#text", "must not be saved");
  await expect(page.locator("#result")).toHaveText("");
  await expect(page.locator("#list li")).toHaveCount(0);
});
