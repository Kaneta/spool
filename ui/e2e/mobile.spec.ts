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

/** Paste as New で record を保存・選択し (transitional record view 経由)、確定した name を返す。
 * Search の結果選択は別 tab open になったため、record view 上の選択はこの経路だけ。 */
async function pasteNew(page: Page, text: string): Promise<string> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.click("#paste-as-new");
  await expect(page.locator("#read")).toBeVisible();
  const name = (await page.textContent("#read-name")) ?? "";
  expect(name.endsWith(".txt")).toBe(true);
  return name;
}

/** Search overlay を開いて query で絞り込む (open はしない。preview 系 test で共通)。 */
async function searchQuery(page: Page, query: string): Promise<void> {
  await page.click("#search");
  await expect(page.locator("#search-input")).toBeFocused();
  await page.fill("#search-input", query);
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

// record view: permanent pane は廃止済み。record 未選択の間は Composer が表示され、
// 選択すると既存 registry swap で record view に置き換わる (§3 transitional)。Search からは開かない。
test("record view: hidden until a record is selected, then replaces Composer", async ({ browser }) => {
  const page = await newPage(browser);
  await expect(page.locator("#view")).toBeHidden(); // 常設 pane ではない
  await pasteNew(page, "paste view body");
  await expect(page.locator("#view")).toBeVisible();
  await expect(page.locator("#empty-state")).toBeHidden();
  await expect(page.locator("#read")).toBeVisible();
  await expect(page.locator("#back")).toBeVisible();
  await expect(page.locator("#copy")).toBeEnabled();
  await expect(page.locator("#delete")).toBeEnabled();
  await page.click("#back");
  await expect(page.locator("#view")).toBeHidden();
  await expect(page.locator("#text")).toBeVisible();
});

// mobile (390×780): record view → Back、Search は再 open 可能。result open は別 tab (§16)。
// Phase 1 RECENT は撤去済みのため retrieval は Search overlay 一本。
test("mobile: record view via paste, back, search reopenable, result tap opens new tab", async ({ browser }) => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 390, height: 780 }); // mobile viewport に切り替えてから検証する
  await saveAndWait(page, "mobile search body");
  await expect(page.locator("#text")).toBeVisible(); // default = Composer view

  await pasteNew(page, "mobile paste view body"); // record view は Paste as New 経由 (transitional)
  await expect(page.locator("#text")).toBeHidden();
  await expect(page.locator("#back")).toBeVisible();

  await page.click("#back"); // Back → Composer
  await expect(page.locator("#text")).toBeVisible();

  await page.click("#search"); // re-open 可能
  await expect(page.locator("#search-overlay")).toBeVisible();
  await expect(page.locator("#search-results li button")).toHaveCount(2); // empty query = recent records
  // mobile: live preview pane なし (狭い viewport に押し込まない)
  await expect(page.locator("#search-preview")).toBeHidden();
  // result tap → 別 tab で record page。overlay は open のまま
  const popupPromise = page.context().waitForEvent("page");
  await page.locator("#search-results button", { hasText: "mobile search body" }).click();
  const popup = await popupPromise;
  await expect(popup.locator("#record-name")).toHaveText(/mobile search body\.txt$/);
  await expect(page.locator("#search-overlay")).toBeVisible(); // overlay は残る
  await page.keyboard.press("Escape"); // Esc close は mobile でも機能する
  await expect(page.locator("#search-overlay")).toBeHidden();

  // backdrop tap → close。focus は SEARCH に戻る
  await page.click("#search");
  await page.click("#search-overlay", { position: { x: 20, y: 20 } }); // box 外 = backdrop
  await expect(page.locator("#search-overlay")).toBeHidden();

  // [ CLOSE ] tap → close
  await page.click("#search");
  await page.click("#search-close");
  await expect(page.locator("#search-overlay")).toBeHidden();
  await expect(page.locator("#search")).toBeFocused();
});

// Search overlay (desktop): open → autofocus → empty query = recent records → preview 先頭 →
// 日本語 AND 検索 filter → preview 追従 → 0 results empty state → Enter 別 tab open。
// overlay・query・選択・preview・Composer draft は全部保持される。
test("search: open, recent, preview follows selection/filter, zero-result empty state, Enter opens new tab", async ({ browser }) => {
  const page = await newPage(browser);
  const name = await saveAndWait(page, "空調 設定を変更しました 東側ラウンジ");
  await saveAndWait(page, "unrelated other memo");
  await expect(page.locator("#search")).toBeEnabled();

  await page.fill("#text", "draft must remain"); // Composer draft

  // desktop default viewport (1280): preview pane が最初の選択 (新しい record) を表示する
  await page.click("#search");
  await expect(page.locator("#search-overlay")).toBeVisible();
  await expect(page.locator("#search-input")).toBeFocused(); // open 時 autofocus
  await expect(page.locator("#search-preview")).toBeVisible();
  const firstName = (await page.locator("#search-results li button").first().textContent()) ?? "";
  await expect(page.locator("#search-preview-name")).toHaveText(firstName); // preview = 選択中 (先頭) result
  expect((await page.textContent("#search-preview-text"))?.length ?? 0).toBeGreaterThan(0);

  // 日本語 AND: 両 token を含む record のみ。query 変更で選択は先頭に戻り preview も追従する
  await page.fill("#search-input", "空調 設定"); // 日本語 AND: 両 token を含む record のみ
  await expect(page.locator("#search-results li button")).toHaveCount(1);
  await expect(page.locator("#search-results li button")).toHaveText(name);
  await expect(page.locator("#search-preview-name")).toHaveText(name);
  expect((await page.textContent("#search-preview-text"))?.includes("東側ラウンジ")).toBe(true);
  expect(await page.inputValue("#text")).toBe("draft must remain"); // Composer draft は維持

  await page.fill("#search-input", "一致しない語 xyz"); // non-match は消える → empty state
  await expect(page.locator("#search-results li button")).toHaveCount(0);
  await expect(page.locator("#search-preview-text")).toHaveText("No matching record.");

  await page.fill("#search-input", "空調");
  // Enter: user gesture 内で同期 open。original tab の overlay / query / 選択 / preview は保持
  const popupPromise = page.context().waitForEvent("page");
  await page.keyboard.press("Enter");
  const popup = await popupPromise;
  await popup.waitForLoadState("load");
  expect(popup.url()).toContain("record.html?name=" + encodeURIComponent(name));
  await expect(popup.locator("#record-name")).toHaveText(name);
  expect((await popup.textContent("#record-text"))?.includes("東側ラウンジ")).toBe(true);
  await expect(popup.locator("#record-copy")).toBeVisible();

  await expect(page.locator("#search-overlay")).toBeVisible(); // overlay は open のまま
  await expect(page.locator("#search-input")).toHaveValue("空調"); // query 維持
  await expect(page.locator("#search-preview-text")).toContainText("東側ラウンジ"); // preview 維持
  expect(await page.evaluate(() => document.body.dataset.view)).not.toBe("record"); // record view へ遷移しない
  await page.keyboard.press("Escape"); // close は通常どおり
  await expect(page.locator("#search-overlay")).toBeHidden();
  await expect(page.locator("#view")).toBeHidden(); // current-tab record view に遷移していない
});

// result row click も別 tab open。一回の click gesture から同期 open (popup blocker 対策)。
test("search: result row click opens record page in new tab", async ({ browser }) => {
  const page = await newPage(browser);
  const name = await saveAndWait(page, "click open target body");
  await page.click("#search");
  await expect(page.locator("#search-input")).toBeFocused();
  const popupPromise = page.context().waitForEvent("page");
  await page.locator("#search-results button", { hasText: "click open target" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("load");
  expect(popup.url()).toContain("record.html?name=" + encodeURIComponent(name));
  await expect(popup.locator("#record-name")).toHaveText(name);
  await expect(page.locator("#search-overlay")).toBeVisible(); // original Search は残る
  await page.keyboard.press("Escape");
});

// keyboard inside overlay only: Arrow/Enter/Esc。検索外では通常入力 (/ は Composer の文字)。
// ↓/↑ は selection の移動 + preview 即時追従。Enter は別 tab open。
test("search keyboard: arrows move selection+preview, Enter opens new tab, Esc closes; no global shortcuts", async ({ browser }) => {
  const page = await newPage(browser);
  await saveAndWait(page, "keyboard alpha body");
  await saveAndWait(page, "keyboard beta body"); // 新しい順: beta, alpha

  await page.click("#search");
  await expect(page.locator("#search-input")).toBeFocused();
  await expect(page.locator("#search-preview-name")).toContainText("keyboard beta"); // 先頭選択
  expect((await page.textContent("#search-preview-text"))?.includes("keyboard beta body")).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#search-results li button").nth(1)).toHaveClass(/selected/); // ↓ で次へ
  await expect(page.locator("#search-preview-name")).toContainText("keyboard alpha"); // preview 即時更新
  expect((await page.textContent("#search-preview-text"))?.includes("keyboard alpha body")).toBe(true);
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#search-results li button").first()).toHaveClass(/selected/);
  await expect(page.locator("#search-preview-name")).toContainText("keyboard beta");

  await page.keyboard.press("Enter"); // ↑↓/Enter は Search 内でのみ動く
  const popup = await page.context().waitForEvent("page");
  await popup.waitForLoadState("load");
  await expect(popup.locator("#record-name")).toContainText("keyboard beta");
  await expect(page.locator("#search-overlay")).toBeVisible(); // overlay は open のまま

  // Esc で close。focus は SEARCH button へ戻る
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-overlay")).toBeHidden();
  await expect(page.locator("#search")).toBeFocused();
  await expect(page.locator("#view")).toBeHidden(); // current-tab record view への遷移なし

  // global shortcut は無い: Composer focus 中の `/` も通常 text。Ctrl+K で検索も開かない
  await page.click("#text");
  await page.keyboard.type("slash / test");
  await expect(page.locator("#search-overlay")).toBeHidden();
  expect(await page.inputValue("#text")).toContain("slash / test");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#search-overlay")).toBeHidden(); // Ctrl/Cmd+K は Search を開かない
});

// wide (1920×1080): left control rail | flexible Composer workspace。右 rail / top header / footer なし。
// Composer は 52rem cap 無しで workspace 余り幅を使用。record 本文は pane 内 scroll。document は伸びない。
test("layout wide: rail visible, Composer uses remaining width (not 52rem-capped), long record scrolls inside pane", async ({ browser }) => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(page.locator("#left-rail")).toBeVisible();
  await expect(page.locator("#right-rail")).toBeHidden(); // 右 rail は存在しない
  await expect(page.locator("#focus")).toBeHidden(); // Focus mode は廃止
  await expect(page.locator("#rail-toggle")).toBeVisible();
  expect(await page.locator("#rail-toggle").getAttribute("aria-label")).toBe("Collapse controls");
  await expect(page.locator("#paste-as-new")).toBeVisible(); // primary は rail 内
  await expect(page.locator("#record-count")).toBeVisible();
  await page.fill("#text", `long record body\n${"padding line\n".repeat(100)}`);

  // Compose view で workspace 幅を測る (record view 中は #text が hidden になるため)
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main")!;
    const rail = document.querySelector("#left-rail")!;
    const text = document.querySelector("#text")!;
    return {
      mainRect: main.getBoundingClientRect(),
      railRect: rail.getBoundingClientRect(),
      innerWidth: window.innerWidth,
      textWidth: text.getBoundingClientRect().width,
      noPageGrowth: doc.scrollHeight <= doc.clientHeight,
    };
  });
  expect(m.railRect.right).toBeLessThanOrEqual(m.innerWidth * 0.2); // rail は狭い control column
  expect(m.mainRect.left).toBeGreaterThanOrEqual(m.railRect.right - 1); // workspace は rail に接する
  expect(m.mainRect.right).toBeGreaterThan(m.innerWidth - 32); // 右 rail の余白を作らない
  expect(m.textWidth).toBeGreaterThan(800); // 旧 ~52rem (~832px) cap を超える: flexible workspace
  expect(m.noPageGrowth).toBe(true); // document 全体を scroll させない

  await page.evaluate((t) => navigator.clipboard.writeText(t), `long paste body\n${"padding line\n".repeat(100)}`);
  await page.click("#paste-as-new"); // record view = 長い本文 → pane 内 scroll (transitional)
  await expect(page.locator("#read-text")).toBeVisible();
  const rv = await page.evaluate(() => {
    const doc = document.documentElement;
    const readText = document.querySelector("#read-text")!;
    return { noPageGrowth: doc.scrollHeight <= doc.clientHeight, readScrollable: readText.scrollHeight > readText.clientHeight };
  });
  expect(rv.noPageGrowth).toBe(true);
  expect(rv.readScrollable).toBe(true); // record text は pane 内で scroll
});

// rail collapse (wide): draft / caret / 同一 textarea DOM を保ったまま rail を閉じ、
// workspace が広がり、minimal reopen handle が残る。reopen で rail が戻る。
test("rail collapse: workspace widens, reopen handle remains, draft and textarea DOM preserved", async ({ browser }) => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const draft = "rail collapse draft これは下書き";
  await page.fill("#text", draft);
  await page.click("#text");
  await page.keyboard.press("End"); // caret を本文末尾へ

  const before = await page.evaluate(() => {
    const text = document.querySelector("#text")!;
    (text as HTMLTextAreaElement & { _mark?: boolean })._mark = true;
    return { textWidth: text.getBoundingClientRect().width, railWidth: (document.querySelector("#left-rail")!).getBoundingClientRect().width };
  });

  await page.click("#rail-toggle");
  await expect(page.locator("#search")).toBeHidden(); // commands は rail closed で非表示
  await expect(page.locator("#app-title")).toBeHidden();
  await expect(page.locator("#rail-toggle")).toBeVisible(); // reopen handle は残る
  expect(await page.locator("#rail-toggle").getAttribute("aria-label")).toBe("Expand controls");
  expect(await page.evaluate(() => document.body.getAttribute("data-rail"))).toBe("closed");

  const closed = await page.evaluate(() => {
    const rail = document.querySelector("#left-rail")!;
    return { railWidth: rail.getBoundingClientRect().width, textWidth: document.querySelector("#text")!.getBoundingClientRect().width };
  });
  expect(closed.railWidth).toBeLessThan(before.railWidth * 0.35); // collapsed strip 化
  expect(closed.textWidth).toBeGreaterThan(before.textWidth); // rail 分だけ workspace が広がる
  expect(closed.railWidth).toBeLessThan(closed.textWidth * 0.1); // handle が実質的に strip

  await page.waitForTimeout(100);
  const after = await page.evaluate(() => {
    const text = document.querySelector<HTMLTextAreaElement>("#text")!;
    return {
      sameMark: (text as HTMLTextAreaElement & { _mark?: boolean })._mark === true, // 同一 textarea DOM
      selection: text.selectionStart,
      value: text.value,
    };
  });
  expect(after.sameMark).toBe(true);
  expect(after.value).toBe(draft);
  expect(after.selection).toBe(draft.length); // caret は End のまま保たれる (自然維持)

  await page.click("#rail-toggle"); // reopen
  await expect(page.locator("#search")).toBeVisible();
  await expect(page.locator("#app-title")).toBeVisible();
  expect(await page.evaluate(() => document.body.getAttribute("data-rail"))).toBe("open");
  expect(await page.inputValue("#text")).toBe(draft);
});

// 960×800: rail は維持 (自動 top bar 化/auto-collapse しない)。Composer が自然に縮む。
test("layout 960: rail remains visible, no automatic top bar, Composer shrinks, toggle works", async ({ browser }) => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 960, height: 800 });
  await expect(page.locator("#left-rail")).toBeVisible();
  await expect(page.locator("#search")).toBeVisible(); // rail 内 command は top bar に変換せず表示継続
  await expect(page.locator("#text")).toBeVisible();
  await page.fill("#text", "960 draft");

  // rail open のまま grid: rail left | workspace right
  const open = await page.evaluate(() => {
    const rail = document.querySelector("#left-rail")!;
    const text = document.querySelector("#text")!;
    return { railLeft: rail.getBoundingClientRect().left, textRight: text.getBoundingClientRect().right, overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  expect(open.railLeft).toBe(0);
  expect(open.textRight).toBeGreaterThan(open.railLeft);
  expect(open.overflow).toBe(false); // 960 で横 overflow しない

  await page.click("#rail-toggle");
  await expect(page.locator("#rail-toggle")).toBeVisible();
  await page.click("#rail-toggle"); // reopen
  await expect(page.locator("#search")).toBeVisible();
});

// mobile (390×780): layout 壊れない・既存 command 到達可能・Composer 可用。
test("mobile 390: no horizontal overflow, essential commands reachable, Composer usable", async ({ browser }) => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.locator("#text")).toBeVisible();
  for (const sel of ["#save", "#search", "#paste-as-new", "#export-all"]) {
    await expect(page.locator(sel).first()).toBeVisible();
  }
  const m = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(m.overflow).toBe(false);
  // 基本動線: paste as new → record view → back
  await page.evaluate((t) => navigator.clipboard.writeText(t), "mobile paste body");
  await page.click("#paste-as-new");
  await expect(page.locator("#read")).toBeVisible();
  await page.click("#back");
  await expect(page.locator("#text")).toBeVisible();
  await saveAndWait(page, "mobile save body");
});


// desktop rail + synthetic long status: 縦 1 列固定。横第2 column への配置/横 overflow は発生させず、
// rail 内 vertical scroll で全 control に到達する。
test("rail overflow: long status keeps single column, vertical scroll reaches all controls", async ({ browser }) => {
  const page = await newPage(browser);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const long = `Storage: persistence not granted\n${"error line です\n".repeat(60)}`;
  await page.evaluate((t) => { (document.querySelector("#storage-state")!).textContent = t; }, long);

  const m = await page.evaluate(() => {
    const rail = document.querySelector("#left-rail")!;
    return {
      railWidth: rail.getBoundingClientRect().width,
      scrollW: rail.scrollWidth,
      clientW: rail.clientWidth,
      scrollableY: rail.scrollHeight > rail.clientHeight,
      overflowX: rail.scrollWidth > rail.clientWidth,
    };
  });
  expect(m.railWidth).toBeLessThanOrEqual(m.clientW + 1); // rail 幅は固定のまま
  expect(m.overflowX).toBe(false); // 横 overflow / 第2 column なし
  expect(m.scrollableY).toBe(true); // 縦 scroll で処理

  for (const sel of ["#search", "#paste-as-new", "#export-all", "#rail-toggle"]) {
    await page.locator(sel).scrollIntoViewIfNeeded();
    await expect(page.locator(sel)).toBeVisible();
  }
});

// search polish (human acceptance): prompt なし / CLEAR / CLOSE / backdrop close / Tab loop。
test("search polish: prompt-free input, CLEAR, CLOSE, backdrop close, tab loop", async ({ browser }) => {
  const page = await newPage(browser);
  await saveAndWait(page, "polish target body");
  await page.click("#search");

  // 1. terminal prompt なし: placeholder も `>` も残さない
  expect(await page.locator("#search-input").getAttribute("placeholder")).toBe(null);

  // 4. CLEAR: query を戻すだけで、overlay は open のまま・input に focus
  await page.fill("#search-input", "存在しない key");
  await expect(page.locator("#search-results li button")).toHaveCount(0);
  await expect(page.locator("#search-clear")).toBeEnabled();
  await page.click("#search-clear");
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect(page.locator("#search-results li button")).toHaveCount(1); // recent records 復元
  await expect(page.locator("#search-clear")).toBeDisabled();
  await expect(page.locator("#search-input")).toBeFocused();
  await expect(page.locator("#search-overlay")).toBeVisible();

  // 3. backdrop click → close / box 内 click → close しない
  await page.mouse.click(10, 10);
  await expect(page.locator("#search-overlay")).toBeHidden();
  await page.click("#search");
  await page.click("#search-title");
  await expect(page.locator("#search-overlay")).toBeVisible();

  // 5. CLOSE click → close。focus は SEARCH へ
  await page.click("#search-close");
  await expect(page.locator("#search-overlay")).toBeHidden();
  await expect(page.locator("#search")).toBeFocused();

  // 7. Tab loop: overlay 内 input ⇄ CLEAR ⇄ CLOSE。result row / 背後の UI には抜けない
  await page.click("#search");
  await page.fill("#search-input", "polish"); // CLEAR enabled
  const focusId = () => page.evaluate(() => document.activeElement?.id ?? "");
  await page.keyboard.press("Tab");
  expect(await focusId()).toBe("search-clear");
  await page.keyboard.press("Tab");
  expect(await focusId()).toBe("search-close");
  await page.keyboard.press("Tab");
  expect(await focusId()).toBe("search-input");
  await page.keyboard.press("Shift+Tab");
  expect(await focusId()).toBe("search-close");
  await page.keyboard.press("Shift+Tab");
  expect(await focusId()).toBe("search-clear");
  // Escape は overlay 内のどの control focus でも close する
  await page.keyboard.press("Escape"); // CLEAR focused
  await expect(page.locator("#search-overlay")).toBeHidden();

  // overlay 外 (SEARCH button focused) の Esc は捕捉しない
  await page.click("#search");
  await page.click("#search-close"); // close → focus は SEARCH (overlay 外)
  await expect(page.locator("#search-overlay")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-overlay")).toBeHidden(); // reopen しない

  // input focus / CLOSE focus からの Esc
  await page.click("#search");
  await expect(page.locator("#search-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-overlay")).toBeHidden();
  await page.click("#search");
  await page.keyboard.press("Tab"); // focus = CLEAR (空 query なので CLOSE は次)
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-overlay")).toBeHidden();
});

// 長い filename の検索結果でも横 scroll は出ない。filename は 1 行 + ellipsis (visual polish)。
test("search: long filename does not cause horizontal overflow", async ({ browser }) => {
  const page = await newPage(browser);
  const longLine = `long ${"x".repeat(200)} end`;
  await saveAndWait(page, longLine);
  await page.click("#search");
  await expect(page.locator("#search-results li button")).toHaveCount(1);
  const overflow = await page.evaluate(() => {
    const results = document.querySelector("#search-results")!;
    return results.scrollWidth - results.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1); // overflow-x は発生しない (ellipssis で truncate)
  await page.keyboard.press("Escape");
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

// production build での成功動線: save → paste-as-new record view → copy → export single → export all → delete。
// 実 IndexedDB の正本に対して全操作が通ることを 1 本で固定する。
// (record view への選択は Paste as New 経由。Search 結果は別 tab open になったため。)
test("success path: save → select/read via paste → copy → export single → export all → delete", async ({ browser }) => {
  const page = await newPage(browser);
  const text = "success path body 日本語\n\tTABあり\n末尾空白:   ";
  await saveAndWait(page, text); // Composer save 経路 (別 test でも網羅)
  expect(await page.inputValue("#text")).toBe(""); // snapshot 一致 → textarea clear

  // select / read: clipboard 同 text を paste as new → 保存 + record view 表示
  const selName = await pasteNew(page, text);
  expect(await readTextContent(page)).toBe(text);

  // copy: 選択中 record を改めて読み、clipboard へそのまま copy
  await page.click("#copy");
  await expect(page.locator("#read-result")).toContainText(`Copied: ${selName}`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  // export single: 本文そのままの .txt download
  const [txt] = await Promise.all([page.waitForEvent("download"), page.click("#export-txt")]);
  expect(txt.suggestedFilename()).toBe(selName);
  expect(await txt.path()).toBeTruthy();

  // export all: name → text の zip
  const [zip] = await Promise.all([page.waitForEvent("download"), page.click("#export-all")]);
  expect(zip.suggestedFilename()).toBe("spool-export.zip");
  expect(await zip.path()).toBeTruthy();

  // delete: confirm accept → 即削除。2 records (save + paste) 中 1 件消える。read area は閉じる
  dialogAction = "accept";
  await page.click("#delete");
  dialogAction = "dismiss";
  await expect(page.locator("#record-count")).toHaveText("records: 1");
  await expect(page.locator("#read")).toBeHidden();
  await expect(page.locator("#copy")).toBeDisabled();
});

// §4.4 delete race — A の delete 完了を遅延させ、その間に B を選ぶ。A の完了が
// B の選択・read 表示を clear しないことを固定する。
// (旧 read race test は変更で維持: Search 結果は別 tab open になり、record view への選択は
// Paste as New 経由のみ (pasteBusy guard あり) となり、UI 上で重複した selectRecord が
// 起こり得なくなったため test を削除した。)
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
  await pasteNew(page, "delete race slow A body"); // A を選択 (read 表示確認)
  await pasteNew(page, "delete race keep B body"); // B を選択しておく (A delete 中の選択維持確認用)

  dialogAction = "accept";
  await page.click("#delete"); // A delete 開始 (complete event は遅延)
  await pasteNew(page, "delete race again B body"); // delete 完了前に B を選択
  await page.waitForTimeout(800); // A の delete 完了を待つ
  dialogAction = "dismiss";

  // A の delete 完了後も B の選択・read 表示は壊れない。record は定義から消えている
  await expect(page.locator("#read-name")).toHaveText(/delete race again B body\.txt$/);
  expect(await readTextContent(page)).toBe("delete race again B body");
  await expect(page.locator("#record-count")).toHaveText("records: 2"); // A deleted; keep, again
  await page.click("#search"); // A が消えたことを Search でも確認
  await page.fill("#search-input", "delete race");
  await expect(page.locator("#search-results button")).toHaveCount(2); // slow A は出ない
  await expect(page.locator("#search-results button", { hasText: "delete race again" })).toHaveCount(1);
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

    // JS 起動 + 実 IndexedDB: paste-as-new (保存 + record view 表示) → copy
    const selName = await pasteNew(page, "csp body");
    expect(await readTextContent(page)).toBe("csp body");
    await page.click("#copy");
    await expect(page.locator("#read-result")).toContainText(`Copied: ${selName}`);

    // /sw.js registration 成功: 失敗時にのみ出る shell-state 表示が出ない
    await expect(page.locator("#shell-state")).toHaveText("");

    // export single / export all
    const [txt] = await Promise.all([page.waitForEvent("download"), page.click("#export-txt")]);
    expect(txt.suggestedFilename()).toBe(selName);
    const [zip] = await Promise.all([page.waitForEvent("download"), page.click("#export-all")]);
    expect(zip.suggestedFilename()).toBe("spool-export.zip");

    // delete
    dialogAction = "accept";
    await page.click("#delete");
    dialogAction = "dismiss";
    await expect(page.locator("#record-count")).toHaveText("records: 0");

    // Markdown Preview page も CSP 下で動く: script 起動 / BroadcastChannel handshake / render
    await page.fill("#text", "# csp preview");
    const popupPromise = page.context().waitForEvent("page");
    await page.click("#open-preview");
    const popup = await popupPromise;
    popup.on("console", (m) => {
      if (m.type() === "error") violations.push(m.text());
    });
    await expect(popup.locator("#preview-body h1")).toHaveText("csp preview");
    await popup.close();

    expect(errors).toEqual([]);
    expect(violations.filter((t) => t.includes("Content-Security-Policy"))).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Saved Record page (UI-DESIGN.md §10): 同一 origin 静的 page が実 IndexedDB から record を読み、
// plain text (HTML 解釈なし / Markdown render なし) を restricted reading column に表示する。
test("record page: found state, literal HTML text, no XSS, reading width; not-found and name-missing states", async ({ browser }) => {
  const page = await newPage(browser);
  const xssBody = "<script>alert(1)</script>\n日本語 本文 第2行\n<trailing tag>\n";
  const name = await saveAndWait(page, xssBody);
  await page.setViewportSize({ width: 1280, height: 800 });

  // found: page URL = record.html?name=<encoded>
  await page.goto(`${base}/record.html?name=${encodeURIComponent(name)}`);
  await expect(page.locator("#record-name")).toHaveText(name);
  await expect(page.locator("#record-text")).toHaveText(xssBody); // literal 表示、script 実行なし
  expect(await page.evaluate(() => (window as { alertCalled?: boolean }).alertCalled)).toBeUndefined();
  await expect(page.locator("#record-copy")).toBeVisible();

  // COPY: exact saved text → clipboard
  await page.click("#record-copy");
  await expect(page.locator("#record-state")).toContainText(`Copied: ${name}`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(xssBody);

  // reading column: width ~52rem cap で viewport 全幅に伸びない
  const w = await page.evaluate(() => document.querySelector("#record-column")!.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(600);
  expect(w).toBeLessThanOrEqual(52 * 16 + 1);

  // not found / name missing: 小さな明示 error
  await page.goto(`${base}/record.html?name=${encodeURIComponent("20260101-0000-not-there.txt")}`);
  await expect(page.locator("#record-state")).toHaveText("Record not found.");
  await page.goto(`${base}/record.html`);
  await expect(page.locator("#record-state")).toHaveText("Record name missing.");
});

// Search → 別 tab の record page: popup の URL / 内容と、original tab の state 保持 (§6/§12)。
test("search: Enter keeps original state while popup shows the record", async ({ browser }) => {
  const page = await newPage(browser);
  await saveAndWait(page, "popup target body");
  await page.fill("#text", "popup test draft");
  await page.click("#search");
  await expect(page.locator("#search-input")).toBeFocused();
  await page.locator("#search-results button").first().waitFor(); // openSearch の getAll 完了待ち
  const popupPromise = page.context().waitForEvent("page");
  await page.keyboard.press("Enter");
  const popup = await popupPromise;
  await expect(popup.locator("#record-text")).toHaveText("popup target body");
  // original: Search open / query 空のまま / selected 維持 / preview 維持 / draft 維持
  await expect(page.locator("#search-overlay")).toBeVisible();
  await expect(page.locator("#search-preview-text")).toContainText("popup target body");
  expect(await page.inputValue("#text")).toBe("popup test draft");
  expect(await page.evaluate(() => document.body.dataset.view)).not.toBe("record");
  await page.keyboard.press("Escape");
});

// ===== Markdown Preview (UI-DESIGN.md §2 Preview)。Composer 現行 textarea の derived read-only
// render を別 tab で行う。BroadcastChannel は同一 context 内で有効なため、preview 系 test は
// 1 context に Composer + Preview を置く (context をまたぐと channel が分離する)。

/** preview test 共用: Composer page を 1 つ作る (既存 newPage と同型だが context を page から辿れる)。 */
async function newComposerPage(browser: Browser, initScript?: () => void): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (initScript) await page.addInitScript(initScript);
  await page.goto(base);
  await expect(page.locator("#open-preview")).toBeVisible();
  return page;
}

/** OPEN PREVIEW click → popup page。window.open は click handler 内の同期的に発火するため、
 * waitForEvent は click の前に仕掛ける (§27 実装 review 要件の test 側での固定)。 */
async function openPreview(page: Page): Promise<Page> {
  const popupPromise = page.context().waitForEvent("page");
  await page.click("#open-preview");
  const popup = await popupPromise;
  await popup.waitForLoadState("load");
  return popup;
}

// OPEN PREVIEW: 別 tab に markdown-preview.html?session=<uuid> を開き、現行 source を render。
// Composer は変更されない (§27)。
test("markdown preview: OPEN PREVIEW renders current source in a separate tab, composer unchanged", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", "# Hello\n\n**world**\n");
  const popup = await openPreview(page);
  const url = new URL(popup.url());
  expect(url.pathname).toBe("/markdown-preview.html");
  expect(url.searchParams.get("session")).toBeTruthy();
  // content-only surface: page 内 chrome (MARKDOWN PREVIEW header / divider) は置かない。
  // browser tab title のみが区分を担う。
  expect(await popup.evaluate(() => document.querySelector("#preview-title"))).toBeNull();
  expect(await popup.locator("#preview-state").textContent()).toBe(""); // state message は発生時のみ
  await expect(popup.locator("#preview-body h1")).toHaveText("Hello");
  await expect(popup.locator("#preview-body strong")).toHaveText("world");
  expect(await page.inputValue("#text")).toBe("# Hello\n\n**world**\n"); // Composer unchanged
  // 52rem reading column は維持 (chrome 削除と独立)
  const bodyWidth = await popup.evaluate(() => document.querySelector("#preview-body")!.getBoundingClientRect().width);
  expect(bodyWidth).toBeGreaterThan(400);
  expect(bodyWidth).toBeLessThanOrEqual(52 * 16 + 1);
});

// 長い code line: code block 内部 scroll で吸収され、page 全体に横 scroll が出ない (§18)。
test("markdown preview: long code line scrolls inside pre, no page horizontal overflow", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", "```text\n" + "x".repeat(5000) + "\n```\n");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body pre")).toBeVisible();
  const box = await popup.evaluate(() => {
    const pre = document.querySelector("#preview-body pre")!;
    return {
      innerScroll: pre.scrollWidth > pre.clientWidth, // code block 内部 scroll
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  expect(box.innerScroll).toBe(true);
  expect(box.pageOverflow).toBe(false);
});

// live update: 同一 Composer tab の編集が同一 Preview tab に反映される。tab 増殖なし (§28)。
test("markdown preview: live update without reopening", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", "# First");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body h1")).toHaveText("First");
  await page.fill("#text", "# Second");
  await expect(popup.locator("#preview-body h1")).toHaveText("Second");
  expect(page.context().pages().length).toBe(2); // Composer + Preview のまま
});

// reload: Preview reload 後に ready handshake で現行 source を再取得する (§29)。
test("markdown preview: reload re-syncs via ready handshake", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", "# Reload check");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body h1")).toHaveText("Reload check");
  await popup.reload();
  await expect(popup.locator("#preview-body h1")).toHaveText("Reload check"); // ready → source 再 reply
});

// session isolation: Composer tab 毎の UUID channel。A の編集は A Preview にのみ届く (§30)。
test("markdown preview: two composer sessions never mix", async ({ browser }) => {
  const pageA = await newComposerPage(browser);
  const pageB = await newComposerPage(browser);
  await pageA.fill("#text", "# Alpha");
  await pageB.fill("#text", "# Beta");
  const popupA = await openPreview(pageA);
  const popupB = await openPreview(pageB);
  await expect(popupA.locator("#preview-body h1")).toHaveText("Alpha");
  await expect(popupB.locator("#preview-body h1")).toHaveText("Beta");
  await pageA.fill("#text", "# Alpha Changed");
  await expect(popupA.locator("#preview-body h1")).toHaveText("Alpha Changed");
  await expect(popupB.locator("#preview-body h1")).toHaveText("Beta"); // B は混線しない
});

// security: raw HTML は文字表示のみ (script / event handler 実行なし)、javascript: link は
// anchor として生成されない (§31)。
test("markdown preview: raw script and javascript: link are inert", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", '<script>window.__pwned = true</script>\n<img src=x onerror="window.__pwned = true">\n[bad](javascript:alert(1))\nplain **ok**');
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body strong")).toHaveText("ok"); // render 自体は生きている
  expect(await popup.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();
  expect(await popup.evaluate(() => document.querySelector("#preview-body script, #preview-body [onerror]"))).toBeNull();
  const hrefs = await popup.evaluate(() => [...document.querySelectorAll("#preview-body a")].map((a) => (a.getAttribute("href") ?? "").toLowerCase()));
  expect(hrefs.some((h) => h.startsWith("javascript:"))).toBe(false);
});

// Save 成功: existing semantics で textarea が clear されると preview も "Nothing to preview." (§32)。
test("markdown preview: save success clears composer and preview", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", "# draft to save");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body h1")).toHaveText("draft to save");
  await page.click("#save");
  await expect(page.locator("#result")).toContainText("Saved:");
  expect(await page.inputValue("#text")).toBe("");
  await expect(popup.locator("#preview-state")).toHaveText("Nothing to preview.");
});

// Save 失敗: Composer draft 維持・preview も同じ source 維持 (§32)。fault injection: readwrite tx を
// readonly に差し替え、addRecord が save_failed 経路に落ちるようにする (既存 pattern と同じ addInitScript)。
test("markdown preview: save failure keeps composer draft and preview source", async ({ browser }) => {
  const page = await newComposerPage(browser, () => {
    const orig = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (storeNames: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      return orig.call(this, storeNames, mode === "readwrite" ? "readonly" : mode, options);
    } as typeof IDBDatabase.prototype.transaction;
  });
  await page.fill("#text", "# failure keeps me");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body h1")).toHaveText("failure keeps me");
  await page.click("#save");
  await expect(page.locator("#result")).toContainText("Failed: save_failed");
  expect(await page.inputValue("#text")).toBe("# failure keeps me"); // draft 維持
  await expect(popup.locator("#preview-body h1")).toHaveText("failure keeps me"); // preview も維持
});

// rail collapse / reopen: Preview session に影響しない。closed 中も live update 継続 (§20/§33)。
test("markdown preview: rail collapse keeps preview session alive", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", "# Rail test");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body h1")).toHaveText("Rail test");
  await page.click("#rail-toggle"); // rail closed
  await page.fill("#text", "# Rail test changed");
  await expect(popup.locator("#preview-body h1")).toHaveText("Rail test changed"); // closed 中も live
  await page.click("#rail-toggle"); // rail open
  await page.fill("#text", "# Rail test again");
  await expect(popup.locator("#preview-body h1")).toHaveText("Rail test again");
});

// mobile 390: OPEN PREVIEW 到達可能 / tap → 別 tab / initial render (§21/§33)。inline pane は作らない。
test("markdown preview: mobile 390 reachable with initial handshake", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await context.newPage();
  await page.goto(base);
  await expect(page.locator("#open-preview")).toBeVisible();
  await page.fill("#text", "# Mobile");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body h1")).toHaveText("Mobile");
});

// window reuse: 同じ Composer の再 click は既存 Preview tab を再利用 (増殖なし)、閉じた後は新 tab (§34)。
test("markdown preview: window reuse without duplicates, reopenable after close", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.fill("#text", "# Reuse");
  const popup = await openPreview(page);
  await expect(popup.locator("#preview-body h1")).toHaveText("Reuse");
  await page.click("#open-preview"); // 既存 tab を focus/reuse (ready handshake で再 render)
  await page.waitForTimeout(300);
  const popups = page.context().pages().filter((p) => p !== page);
  expect(popups.length).toBe(1); // 増殖なし
  expect(await popups[0].evaluate(() => window.opener)).toBeNull(); // opener は Composer open 直後に切断済み
  await expect(popups[0].locator("#preview-body h1")).toHaveText("Reuse");
  await popups[0].close();
  const again = await openPreview(page); // 閉じた後は新しい tab
  await expect(again.locator("#preview-body h1")).toHaveText("Reuse");
});

// 大きな paste: render storm にならず、debounce 内で最新 source に到達する (§35)。
test("markdown preview: large paste stays responsive", async ({ browser }) => {
  const page = await newComposerPage(browser);
  const big = `${"big paragraph line\n".repeat(5_000)}# end marker`;
  const popup = await openPreview(page); // 空 → empty state
  await expect(popup.locator("#preview-state")).toHaveText("Nothing to preview.");
  await page.fill("#text", big); // paste 相当
  await expect(popup.locator("#preview-body h1")).toHaveText("end marker", { timeout: 10_000 });
});

// offline: SW shell (markdown-preview.html + 資産先取り) で OPEN PREVIEW が render まで通る。
// BroadcastChannel 自体は network 不要 (§23)。
test("markdown preview: offline shell opens and renders via handshake", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base);
  await expect(page.locator("#save")).toBeVisible();
  await expect(page.locator("#shell-state")).toHaveText(""); // SW registration 成功
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.fill("#text", "# Offline preview");
  await context.setOffline(true); // preview を一度も online 開かずに offline open (install 時の資産先取りが効く)
  const popup = await openPreview(page);
  // Composer shell へ誤 fallback していない: preview page は state 要素で区別する (in-page header なし)
  expect(await popup.evaluate(() => document.querySelector("#preview-body") !== null)).toBe(true);
  await expect(popup.locator("#preview-body h1")).toHaveText("Offline preview");
  await context.setOffline(false);
});
// ===== split-window desktop window (human acceptance): 狭 desktop でも rail | Composer と
// collapse を使えること。breakpoint は 561px (real mobile 560px 未満のみ stacked)。

// 狭 desktop (700px = 1920 の半 window 相当): rail / toggle が残り、collapse と reopen が効く。
// 561px ではまだ rail (最狭 desktop)、560px で mobile stacked に切り替わる (境界 ±1)。
// scaled desktop 実機 (~960px window → CSS viewport ~640px) でも 640px は rail のまま。
test("split window: rail layout and collapse at narrow desktop width, breakpoint at 561/560", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.setViewportSize({ width: 700, height: 800 });
  expect(await railLayout(page)).toBe(true);
  await expect(page.locator("#rail-toggle")).toBeVisible();
  const openW = await composerWidth(page);
  await page.click("#rail-toggle"); // closed: reopen strip (2.25rem) | Composer 拡幅
  expect(await railLayout(page)).toBe(true); // closed でも rail layout のまま (stacked 化しない)
  const closedW = await composerWidth(page);
  expect(closedW).toBeGreaterThan(openW); // Composer widens
  await page.click("#rail-toggle"); // reopen works
  expect(await composerWidth(page)).toBe(openW);

  // scaled split-window 相当: 640 / 620 / 600 / 580 でも rail | Composer を維持
  for (const w of [640, 620, 600, 580]) {
    await page.setViewportSize({ width: w, height: 800 });
    expect(await railLayout(page), `width ${w}`).toBe(true);
    await expect(page.locator("#rail-toggle"), `width ${w}`).toBeVisible();
    expect(await composerWidth(page)).toBeGreaterThan(250); // Composer usable
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  }

  // breakpoint 境界: 561 = rail (最狭 desktop), 560 = stacked (崩れる直前の geometry)
  await page.setViewportSize({ width: 561, height: 800 });
  expect(await railLayout(page)).toBe(true);
  await expect(page.locator("#rail-toggle")).toBeVisible();
  expect(await composerWidth(page)).toBeGreaterThan(280); // ≈329px 可用
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  await page.setViewportSize({ width: 560, height: 800 });
  expect(await railLayout(page)).toBe(false); // stacked
  await expect(page.locator("#rail-toggle")).toBeHidden(); // mobile では collapse control 不要
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
});

async function railLayout(page: Page): Promise<boolean> {
  return page.evaluate(() => getComputedStyle(document.querySelector("#left-rail")!).flexDirection === "column");
}
async function composerWidth(page: Page): Promise<number> {
  return Math.round(await page.locator("#text").evaluate((el) => el.getBoundingClientRect().width));
}

// resize は rail state を変更しない: closed のまま mobile に入り、desktop へ戻っても closed (§4/§5)。
// 永続化なし → reload のみ open に戻る。
test("resize: rail closed state survives resize and mobile transition, reload opens", async ({ browser }) => {
  const page = await newComposerPage(browser);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click("#rail-toggle"); // closed (user state)
  expect(await page.evaluate(() => document.body.dataset.rail)).toBe("closed");

  await page.setViewportSize({ width: 700, height: 800 }); // desktop 範囲内で縮める
  expect(await page.evaluate(() => document.body.dataset.rail)).toBe("closed");
  await page.setViewportSize({ width: 560, height: 800 }); // real mobile range
  expect(await page.evaluate(() => document.body.dataset.rail)).toBe("closed"); // 勝手に open へ戻さない
  await page.setViewportSize({ width: 1280, height: 800 }); // desktop へ戻る
  expect(await page.evaluate(() => document.body.dataset.rail)).toBe("closed");
  await expect(page.locator("#rail-toggle")).toBeVisible(); // reopen strip が残る
  expect(await railLayout(page)).toBe(true);

  await page.reload(); // reload のみ open に戻る (non-persistent, localStorage なし)
  await expect(page.locator("#save")).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.rail)).toBe("open");
});
