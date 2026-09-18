// mobile.spec.ts — Mobile/Web build の実 browser E2E。production build (vite build → dist) を
// vite preview で配信して検証する (dev server は完成判定に使わない)。実 Chromium + 実 IndexedDB。
// fault injection は addInitScript で browser API を包む方式 (fake-indexeddb は使わない)。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createHeadersServer } from "./cloudflare-headers";

const uiDir = path.resolve(import.meta.dirname, ".."); // ui/e2e → ui
const distDir = path.join(uiDir, "dist");
const headersPath = path.join(uiDir, "public", "_headers");

let preview: ChildProcess | undefined;
let base = "";
let dialogAction: "accept" | "dismiss" = "dismiss"; // confirm は既定 dismiss。必要な test だけ accept に切り替える

test.beforeAll(async () => {
  execSync("npx vite build", { cwd: uiDir, stdio: "pipe" }); // production mobile build (index.html → main.mobile.ts)
  preview = spawn("npx", ["vite", "preview", "--port", "0", "--strictPort"], {
    cwd: uiDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise<string>((resolve, reject) => {
    let out = "";
    preview!.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/localhost:(\d+)\//);
      if (m) resolve(m[0]);
    });
    preview!.on("exit", (code) => reject(new Error(`vite preview exited early: ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`vite preview startup timeout\n${out}`)), 15_000);
  });
}, 120_000);

test.afterAll(async () => {
  if (preview !== undefined && preview.exitCode === null) {
    preview.kill("SIGTERM");
    await new Promise<void>((resolve) => preview!.on("exit", () => resolve()));
  }
});

// 各 test は独立 context (IndexedDB origin state も隔離)。fault injection が必要な test だけ
// addInitScript を挟む。
async function newPage(browser: Browser, initScript?: () => void): Promise<Page> {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  page.on("dialog", (dialog) => {
    if (dialogAction === "accept") void dialog.accept();
    else void dialog.dismiss();
  });
  if (initScript) await page.addInitScript(initScript);
  await page.goto(base);
  await expect(page.locator("#save")).toBeVisible();
  return page;
}

const readTextContent = (page: Page): Promise<string | null> =>
  page.locator("#read-text").evaluate((el) => el.textContent);

/** save → Saved 表示 → list 反映待ち。返り値は list に出現した button text (record name)。
 * name を #result から取ると前回 save の "Saved:" にすぐ一致してしまう (stale 表示) ため list から読む。 */
async function saveAndWait(page: Page, text: string): Promise<string> {
  await page.fill("#text", text);
  await page.click("#save");
  const firstLine = text.split("\n")[0]!.trim();
  const button = page.locator("#list button", { hasText: firstLine });
  await expect(button).toHaveCount(1);
  const name = (await button.textContent()) ?? "";
  expect(name.length).toBeGreaterThan(0);
  return name;
}

/** list click → read 表示の切り替え待ち (selectRecord は async read を含むため race 対策)。 */
async function selectAndWait(page: Page, title: string): Promise<void> {
  await page.locator("#list button", { hasText: title }).click();
  await expect(page.locator("#read-name")).toContainText(title);
}

// Bug 5 regression: IndexedDB open 失敗が UI に見え、Save 等が disabled になり、
// fallback storage に逃がさないこと。open だけを常に失敗させる限定 fault injection。
test("IndexedDB open failure: visible error, Save disabled, no fallback", async ({ browser }) => {
  const page = await newPage(browser, () => {
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

// production build での成功動線: save → list → select/read → copy → export single → export all → delete。
// 実 IndexedDB の正本に対して全操作が通ることを 1 本で固定する。
test("success path: save → list → select/read → copy → export single → export all → delete", async ({ browser }) => {
  const page = await newPage(browser);
  const text = "success path body 日本語\n\tTABあり\n末尾空白:   ";
  const name = await saveAndWait(page, text);
  expect(await page.inputValue("#text")).toBe(""); // snapshot 一致 → textarea clear

  // select / read
  await selectAndWait(page, "success path body");
  await expect(page.locator("#read-name")).toHaveText(name);
  expect(await readTextContent(page)).toBe(text);
  await expect(page.locator("#list button.selected", { hasText: "success path body" })).toHaveCount(1);

  // copy: 選択中 record を改めて読み、clipboard へそのまま copy
  await page.click("#copy");
  await expect(page.locator("#read-result")).toContainText(`Copied: ${name}`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  // export single: 本文そのままの .txt download
  const [txt] = await Promise.all([page.waitForEvent("download"), page.click("#export-txt")]);
  expect(txt.suggestedFilename()).toBe(name);
  expect(await txt.path()).toBeTruthy();

  // export all: name → text の zip
  const [zip] = await Promise.all([page.waitForEvent("download"), page.click("#export-all")]);
  expect(zip.suggestedFilename()).toBe("spool-export.zip");
  expect(await zip.path()).toBeTruthy();

  // delete: confirm accept → 即削除 → list から消え、read area は閉じる
  dialogAction = "accept";
  await page.click("#delete");
  dialogAction = "dismiss";
  await expect(page.locator("#list li")).toHaveCount(0);
  await expect(page.locator("#read")).toBeHidden();
  await expect(page.locator("#copy")).toBeDisabled();
});

// §4.4 read race — A の read 完了を遅延させ、B を先に表示させる。A の遅い完了が
// 後続の B 表示を上書きしないことを実 browser + 実 IndexedDB で固定する。
test("read race: stale completion does not overwrite newer selection", async ({ browser }) => {
  const page = await newPage(browser, () => {
    // 限定 delay injection: "read race slow" を含む name の get 成功 event だけ 500ms 遅延する。
    // indexeddb.ts の readonlyRequest は req.onsuccess / req.onerror / req.result しか触らないため、
    // それらを遅延配信する薄い proxy で包む。
    const origGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key: IDBValidKey, ...rest: unknown[]) {
      const req = origGet.apply(this, [key, ...rest] as [IDBValidKey]);
      if (!String(key).includes("read race slow")) return req;
      const holder: { onsuccess: EventListener | null; onerror: EventListener | null } = { onsuccess: null, onerror: null };
      req.onsuccess = (ev) => setTimeout(() => holder.onsuccess?.call(req, ev), 500);
      req.onerror = (ev) => setTimeout(() => holder.onerror?.call(req, ev), 500);
      return new Proxy(holder, {
        get: (t, prop) => (prop in t ? t[prop as keyof typeof t] : Reflect.get(req, prop, req)),
        set: (t, prop, v) => ((t as Record<PropertyKey, unknown>)[prop] = v, true),
      });
    } as typeof IDBObjectStore.prototype.get;
  });
  await saveAndWait(page, "read race slow A body");
  await saveAndWait(page, "read race fast B body");

  await page.locator("#list button", { hasText: "read race slow" }).click(); // read A 開始 (成功 event は遅延)
  await selectAndWait(page, "read race fast"); // B を先に完了させる
  await expect(page.locator("#read-name")).toContainText("read race fast", { timeout: 2_000 });
  await page.waitForTimeout(800); // A の遅延 read 完了を待つ
  await expect(page.locator("#read-name")).toContainText("read race fast"); // 上書きされない
  expect(await readTextContent(page)).toBe("read race fast B body");
});

// §4.4 delete race — A の delete 完了を遅延させ、その間に B を選ぶ。A の完了が
// B の選択・read 表示を clear しないことを固定する。
test("delete race: old delete completion keeps newer selection", async ({ browser }) => {
  const page = await newPage(browser, () => {
    // 限定 delay injection: "delete race slow" を対象にした delete を含む readwrite transaction の
    // complete event だけ 500ms 遅延する。indexeddb.ts は tx.oncomplete / onabort / onerror と
    // objectStore(...).delete を触るため、その配信を遅らせる。実際の削除自体は即時に行われる。
    const origTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (storeNames: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      const tx = origTransaction.call(this, storeNames, mode, options);
      if (mode !== "readwrite") return tx;
      let delayMs = 0;
      const origObjectStore = tx.objectStore.bind(tx);
      tx.objectStore = (name: string) => {
        const store = origObjectStore(name);
        const origDelete = store.delete.bind(store);
        store.delete = (key: IDBValidKey) => {
          if (String(key).includes("delete race slow")) delayMs = 500;
          return origDelete(key);
        };
        return store;
      };
      const holder: { oncomplete: EventListener | null } = { oncomplete: null };
      tx.addEventListener("complete", (ev) => {
        const deliver = () => holder.oncomplete?.call(tx, ev);
        if (delayMs > 0) setTimeout(deliver, delayMs);
        else deliver();
      });
      return new Proxy(tx, {
        get: (t, prop) => (prop === "oncomplete" ? holder.oncomplete : Reflect.get(t, prop, t)),
        set: (t, prop, v) => {
          if (prop === "oncomplete") holder.oncomplete = v as EventListener;
          else (t as Record<PropertyKey, unknown>)[prop] = v;
          return true;
        },
      });
    } as typeof IDBDatabase.prototype.transaction;
  });
  const slowName = await saveAndWait(page, "delete race slow A body");
  const keepName = await saveAndWait(page, "delete race keep B body");
  await selectAndWait(page, "delete race slow");
  await expect(page.locator("#read-name")).toHaveText(slowName);

  dialogAction = "accept";
  await page.click("#delete"); // A delete 開始 (complete event は遅延)
  await selectAndWait(page, "delete race keep"); // delete 完了前に B を選択
  await page.waitForTimeout(800); // A の delete 完了を待つ
  dialogAction = "dismiss";

  // A は list から消える (stale 完了後の refresh)。B の選択・read 表示は壊れない
  await expect(page.locator("#list button", { hasText: "delete race slow" })).toHaveCount(0);
  await expect(page.locator("#read-name")).toHaveText(keepName);
  expect(await readTextContent(page)).toBe("delete race keep B body");
  await expect(page.locator("#list button.selected", { hasText: "delete race keep" })).toHaveCount(1);
});

// CSP: production artifact を Cloudflare Pages と同じ _headers で配信し、console に violation が
// 出ないこと。CSS 適用 / JS 起動 / IndexedDB 操作 / /sw.js registration / export を一巡する。
test("CSP: _headers applied, no console violations on production artifact", async ({ browser }) => {
  const server = createHeadersServer(distDir, headersPath);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  try {
    // response headers の模擬確認 (_headers がそのまま効いていること)
    const res = await fetch(url);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    const cssHref = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    expect(cssHref).toBeTruthy(); // CSS は外部 file (inline <style> は廃止済み)
    const cssRes = await fetch(`http://127.0.0.1:${port}${cssHref}`);
    expect(cssRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const violations: string[] = [];
    const errors: string[] = [];
    const context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
    const page = await context.newPage();
    page.on("dialog", (dialog) => {
      if (dialogAction === "accept") void dialog.accept();
      else void dialog.dismiss();
    });
    page.on("console", (m) => {
      if (m.type() === "error") violations.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    await expect(page.locator("#save")).toBeVisible();

    // CSS が適用される (mobile.css の #read-text border #ddd)
    const borderColor = await page.evaluate(() => getComputedStyle(document.querySelector("#read-text")!).borderColor);
    expect(borderColor).toBe("rgb(221, 221, 221)");

    // JS 起動 + 実 IndexedDB: save → select → copy
    const name = await saveAndWait(page, "csp body");
    await selectAndWait(page, "csp body");
    await page.click("#copy");
    await expect(page.locator("#read-result")).toContainText(`Copied: ${name}`);

    // /sw.js registration 成功: 失敗時にのみ出る shell-state 表示が出ない
    await expect(page.locator("#shell-state")).toHaveText("");

    // export single / export all
    const [txt] = await Promise.all([page.waitForEvent("download"), page.click("#export-txt")]);
    expect(txt.suggestedFilename()).toBe(name);
    const [zip] = await Promise.all([page.waitForEvent("download"), page.click("#export-all")]);
    expect(zip.suggestedFilename()).toBe("spool-export.zip");

    // delete
    dialogAction = "accept";
    await page.click("#delete");
    dialogAction = "dismiss";
    await expect(page.locator("#list li")).toHaveCount(0);

    expect(errors).toEqual([]);
    expect(violations.filter((t) => t.includes("Content-Security-Policy"))).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
