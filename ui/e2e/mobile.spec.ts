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

/** save → Saved 表示待ち。RECENT list は撤去済みのため name は #result ("Saved: <name>") から取る。
 * 前回 save の表示が残るため、#result の text が変化したことを待ってから読む。 */
async function saveAndWait(page: Page, text: string): Promise<string> {
  await page.fill("#text", text);
  const before = await page.textContent("#result");
  await page.click("#save");
  await page.waitForFunction(
    (prev) => document.querySelector("#result")?.textContent !== prev && (document.querySelector("#result")?.textContent ?? "").startsWith("Saved: "),
    before,
    { timeout: 5_000 },
  );
  const name = ((await page.textContent("#result")) ?? "").slice("Saved: ".length);
  expect(name.length).toBeGreaterThan(0);
  return name;
}

/** Search overlay を開いて title で検索 → 先頭の一致行を click → read 表示の切り替え待ち。
 * selectRecord は async read を含むため race 対策として read-name を待つ。 */
async function selectAndWait(page: Page, title: string): Promise<void> {
  await page.click("#search");
  await expect(page.locator("#search-input")).toBeFocused();
  await page.fill("#search-input", title);
  await page.locator("#search-results button", { hasText: title }).first().click();
  await expect(page.locator("#read-name")).toContainText(title);
}

// Paste as New: clipboard → 既存 save pipeline → 即保存 → 右 pane read-only 表示。
// Composer を経由しない 1 click 操作であることを固定する。空 clipboard は既存 save rules に委任
// (新規に拒否 rule を作らない: Save で空を入れても同様に保存される)。
test("paste as new: clipboard text becomes a record without touching the Composer", async ({ browser }) => {
  const page = await newPage(browser);
  const clip = "ペースト本文 clipboard body\n2行目: line2";
  const draft = "composer draft これは保存されていない下書き";
  await page.evaluate((text) => navigator.clipboard.writeText(text), clip);
  await page.fill("#text", draft); // Composer に別内容の draft を先に入れておく
  await page.click("#paste-as-new");

  await expect(page.locator("#record-count")).toHaveText("records: 1"); // 新 record が保存されている
  await expect(page.locator("#read")).toBeVisible(); // 保存直後の record を表示
  await expect(page.locator("#read-name")).toContainText("ペースト本文");
  expect(await readTextContent(page)).toBe(clip); // 保存内容は clipboard text
  expect(await page.inputValue("#text")).toBe(draft); // Composer は draft のまま。save 経路を通っていない

  // 空 clipboard も既存 save rules に従う (空 record として append). paste-as-new 単独の特別扱いはしない
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.click("#paste-as-new");
  await expect(page.locator("#record-count")).toHaveText("records: 2");
});

// Paste as New の連打: 1 回目の clipboard read 中の再 click は無視される (concurrent guard)。
// 同一 clipboard 内容で 2 record は作らない。
test("paste as new: rapid double invocation does not create duplicate records", async ({ browser }) => {
  const page = await newPage(browser, () => {
    // 限定 fault injection: readText の解決を test 側で手動解除する。resolver は window に置く
    // (production への hook ではなく、この context 内の test kit)。
    let pending: ((text: string) => void) | null = null;
    (window as { resolveClipboard?: () => void }).resolveClipboard = () => {
      const r = pending;
      pending = null;
      r?.("double guard body");
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: () => new Promise<string>((resolve) => {
          pending = resolve;
        }),
      },
    });
  });
  await page.click("#paste-as-new");
  await page.click("#paste-as-new"); // read 待ちの間にもう一度 click
  await page.evaluate(() => (window as { resolveClipboard?: () => void }).resolveClipboard?.());

  await expect(page.locator("#read-text")).toHaveText("double guard body", { timeout: 5_000 });
  await expect(page.locator("#record-count")).toHaveText("records: 1");
  await expect(page.locator("#paste-as-new")).toBeEnabled(); // 失敗/成功後も再び使える
});

// clipboard read 失敗: user-visible error・Composer 保持・silent fallback なし。
test("paste as new: clipboard failure shows visible error, Composer unchanged", async ({ browser }) => {
  const page = await newPage(browser, () => {
    // 限定 fault injection: readText だけを常に失敗させる
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.reject(new DOMException("injected denial", "NotAllowedError")) },
    });
  });
  await page.fill("#text", "composer must stay");
  await page.click("#paste-as-new");
  await expect(page.locator("#result")).toContainText("Failed: clipboard_read");
  expect(await page.inputValue("#text")).toBe("composer must stay");
  await expect(page.locator("#record-count")).toHaveText("records: 0");
});

// 右 pane: 初期は常時表示の empty state。record を選ぶと表示が入れ替わる。
test("right pane empty state: visible until a record is selected", async ({ browser }) => {
  const page = await newPage(browser);
  await expect(page.locator("#empty-state")).toBeVisible();
  await expect(page.locator("#empty-state")).toHaveText("Select a record to view it here.");
  await saveAndWait(page, "empty state body");
  await selectAndWait(page, "empty state body");
  await expect(page.locator("#empty-state")).toBeHidden();
  await expect(page.locator("#read")).toBeVisible();
  await expect(page.locator("#copy")).toBeEnabled();
  await expect(page.locator("#delete")).toBeEnabled();
});

// mobile (390×780): Search → Record view → Back → Composer。Search は再 open 可能。
// Phase 1 RECENT は撤去済みのため retrieval は Search overlay 一本。
test("mobile: search → record view → back → composer restored, search reopenable", async ({ browser }) => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 390, height: 780 }); // mobile viewport に切り替えてから検証する
  await saveAndWait(page, "mobile search body");
  await expect(page.locator("#text")).toBeVisible(); // default = Composer view

  await selectAndWait(page, "mobile search body"); // search open → 選択
  await expect(page.locator("#read-name")).toContainText("mobile search"); // Record view へ移動
  await expect(page.locator("#text")).toBeHidden();
  await expect(page.locator("#back")).toBeVisible();

  await page.click("#back"); // Back → Composer
  await expect(page.locator("#text")).toBeVisible();

  await page.click("#search"); // 再度 open 可能
  await expect(page.locator("#search-overlay")).toBeVisible();
  await expect(page.locator("#search-results li button")).toHaveCount(1); // empty query = recent records
  await page.keyboard.press("Escape"); // Esc close は mobile でも機能する
  await expect(page.locator("#search-overlay")).toBeHidden();
});

// Search overlay (desktop): open → autofocus → empty query = recent records → 日本語 AND 検索 filter →
// result click で閉じて右 pane に表示。Composer draft は壊さない。
test("search: open, recent, Japanese filter, result opens record, draft preserved", async ({ browser }) => {
  const page = await newPage(browser);
  const name = await saveAndWait(page, "空調 設定を変更しました 東側ラウンジ");
  await saveAndWait(page, "unrelated other memo");
  await expect(page.locator("#search")).toBeEnabled();

  await page.fill("#text", "draft must remain"); // Composer draft
  await page.click("#search");
  await expect(page.locator("#search-overlay")).toBeVisible();
  await expect(page.locator("#search-input")).toBeFocused(); // open 時 autofocus
  await expect(page.locator("#search-results li button")).toHaveCount(2); // empty query = recent records
  await expect(page.locator("#search-results li button", { hasText: "unrelated other" })).toHaveCount(1); // 両 record が recent に出る

  await page.fill("#search-input", "空調 設定"); // 日本語 AND: 両 token を含む record のみ
  await expect(page.locator("#search-results li button")).toHaveCount(1);
  await expect(page.locator("#search-results li button")).toHaveText(name);

  await page.fill("#search-input", "一致しない語 xyz"); // non-match は消える
  await expect(page.locator("#search-results li button")).toHaveCount(0);

  await page.fill("#search-input", "空調");
  await page.locator("#search-results button").first().click(); // mouse selection
  await expect(page.locator("#search-overlay")).toBeHidden(); // click で close
  await expect(page.locator("#read-name")).toHaveText(name); // 右 pane に表示
  expect(await readTextContent(page)).toContain("東側ラウンジ");
  await expect(page.locator("#empty-state")).toBeHidden();
  expect(await page.inputValue("#text")).toBe("draft must remain"); // Composer draft は維持
});

// keyboard inside overlay only: Arrow/Enter/Esc。検索外では通常入力 (/ は Composer の文字)。
test("search keyboard: arrows move selection, Enter opens, Esc closes; no global shortcuts", async ({ browser }) => {
  const page = await newPage(browser);
  await saveAndWait(page, "keyboard alpha body");
  await saveAndWait(page, "keyboard beta body"); // 新しい順: beta, alpha

  await page.click("#search");
  await expect(page.locator("#search-input")).toBeFocused();
  await expect(page.locator("#search-results li button").first()).toHaveClass(/selected/); // 先頭選択
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#search-results li button").nth(1)).toHaveClass(/selected/); // ↓ で次へ
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#search-results li button").first()).toHaveClass(/selected/);
  await page.keyboard.press("Enter"); // ↑↓/Enter は Search 内でのみ.*動く
  await expect(page.locator("#search-overlay")).toBeHidden();
  await expect(page.locator("#read-name")).toContainText("keyboard beta");

  // Esc で close。focus は SEARCH button へ戻る
  await page.click("#search");
  await page.focus("#search-input");
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-overlay")).toBeHidden();

  // global shortcut は無い: Composer focus 中の `/` も通常 text。Ctrl+K で検索も開かない
  await page.click("#text");
  await page.keyboard.type("slash / test");
  await expect(page.locator("#search-overlay")).toBeHidden();
  expect(await page.inputValue("#text")).toBe("slash / test");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#search-overlay")).toBeHidden(); // Ctrl/Cmd+K は Search を開かない
});

// desktop layout: 長い本文で document が伸びない。pane 内 scroll。footer も viewport 内に維持。
test("layout: long record scrolls inside pane, document height unchanged", async ({ browser }) => {
  const page = await newPage(browser);
  const text = `long record body\n${"padding line\n".repeat(500)}`;
  await saveAndWait(page, text);
  await selectAndWait(page, "long record");
  await expect(page.locator("#read-text")).toBeVisible();

  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const readText = document.querySelector("#read-text")!;
    return {
      noPageGrowth: doc.scrollHeight <= doc.clientHeight,
      readScrollable: readText.scrollHeight > readText.clientHeight,
      footerBottom: document.querySelector("footer")!.getBoundingClientRect().bottom,
      innerHeight: window.innerHeight,
    };
  });
  expect(m.noPageGrowth).toBe(true); // record 本文のため document 全体を scroll させない
  expect(m.readScrollable).toBe(true); // record text は pane 内で scroll
  expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight); // footer の骨格位置が保たれる
});

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
  await expect(page.locator("#search")).toBeDisabled(); // data が読めないため Search も使えない
  // Save 処理へ進まない: textarea に入れても result は空のまま (fallback 保存も起こらない)
  await page.fill("#text", "must not be saved");
  await expect(page.locator("#result")).toHaveText("");
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

  // delete: confirm accept → 即削除 → 件数 0、read area は閉じる
  dialogAction = "accept";
  await page.click("#delete");
  dialogAction = "dismiss";
  await expect(page.locator("#record-count")).toHaveText("records: 0");
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

  // read A 開始 (成功 event は遅延) → Search を閉じて B を先に完了させる
  await page.click("#search");
  await page.fill("#search-input", "read race slow");
  await page.locator("#search-results button", { hasText: "read race slow" }).first().click();
  await page.focus("#search-input"); // Esc close は Search input focus 中
  await page.keyboard.press("Escape"); // A の read 完了を待たず overlay を閉じる
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

  // A の delete 完了後も B の選択・read 表示は壊れない。record は定義から消えている
  await expect(page.locator("#read-name")).toHaveText(keepName);
  expect(await readTextContent(page)).toBe("delete race keep B body");
  await expect(page.locator("#record-count")).toHaveText("records: 1");
  await page.click("#search"); // A が消えたことを Search でも確認
  await page.fill("#search-input", "delete race");
  await expect(page.locator("#search-results button")).toHaveCount(1); // slow A は出ない
  await expect(page.locator("#search-results button", { hasText: "delete race keep" })).toHaveCount(1);
  await page.keyboard.press("Escape");
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
    await expect(page.locator("#record-count")).toHaveText("records: 0");

    expect(errors).toEqual([]);
    expect(violations.filter((t) => t.includes("Content-Security-Policy"))).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
