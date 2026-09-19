// main.mobile.ts — Mobile/Web build entry。Paste as New → 保存 → 一覧 → 読む の一本道 (DESIGN-v2 §10.1, §4.3, §5.3)。
// storage backend は IndexedDB (§5)。PC build (main.pc.ts) とは entry と backend のみが違い、runtime probing はしない。

import { candidateName, capturedAtPrefix, deriveTitle, isNameWithinLimit } from "./filename";
import { addRecord, deleteRecord, listRecords, openDatabase, readAllRecords, readRecord, type AddOutcome, type StoredRecord } from "./indexeddb";
import { searchRecords } from "./search";
import { downloadZip } from "client-zip"; // §5.4: STORE 専用・dependency なしの小さな zip library
import "./mobile.css"; // CSP default-src 'self' で inline style を許可しないため外部 file に分離 (pc.css と同構成)

const textarea = document.querySelector<HTMLTextAreaElement>("#text")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save")!;
const result = document.querySelector<HTMLParagraphElement>("#result")!;
const searchButton = document.querySelector<HTMLButtonElement>("#search")!;
const searchOverlay = document.querySelector<HTMLElement>("#search-overlay")!;
const searchInput = document.querySelector<HTMLInputElement>("#search-input")!;
const searchResults = document.querySelector<HTMLUListElement>("#search-results")!;
const searchClear = document.querySelector<HTMLButtonElement>("#search-clear")!;
const searchClose = document.querySelector<HTMLButtonElement>("#search-close")!;
const readArea = document.querySelector<HTMLElement>("#read")!;
const emptyState = document.querySelector<HTMLElement>("#empty-state")!;
const readName = document.querySelector<HTMLElement>("#read-name")!;
const readText = document.querySelector<HTMLPreElement>("#read-text")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy")!;
const deleteButton = document.querySelector<HTMLButtonElement>("#delete")!;
const readResult = document.querySelector<HTMLParagraphElement>("#read-result")!;
const exportTxtButton = document.querySelector<HTMLButtonElement>("#export-txt")!;
const exportAllButton = document.querySelector<HTMLButtonElement>("#export-all")!;
const exportResult = document.querySelector<HTMLParagraphElement>("#export-result")!;
const storageState = document.querySelector<HTMLParagraphElement>("#storage-state")!;
const shellState = document.querySelector<HTMLParagraphElement>("#shell-state")!;
const pasteAsNewButton = document.querySelector<HTMLButtonElement>("#paste-as-new")!;
const backButton = document.querySelector<HTMLButtonElement>("#back")!;
const recordCount = document.querySelector<HTMLElement>("#record-count")!;

let selectedName: string | null = null; // ephemeral は選択 state のみ。一覧は毎回 IndexedDB から読む (第二正本を作らない)
// 操作単位の小さな generation (PC 側 main.pc.ts と同じ pattern, §4.4): 最後に開始した select / delete だけが
// 選択 state と read 表示を更新できる。stale な完了が後続の選択を壊さないためのもの。永続化しない。
let selectGeneration = 0;
let deleteGeneration = 0;

// openDatabase 失敗時は fallback / 別 store へ逃がさず、利用不能を明示して止める (Baseline §6)。
// 成功時のみ、後続の初期化 (event 登録 / 一覧再構築 / persistence / app shell) を行う。
// 失敗時は requestPersistence も呼ばない: storageState は利用不能表示を保持する
// (persistence 結果表示で「利用不能」を上書きしない。shell 表示は別要素のため registerAppShell は実行する)。
let db: IDBDatabase | null = null;
try {
  db = await openDatabase();
} catch (e) {
  storageState.textContent = `Storage unavailable: IndexedDB open failed (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`;
  setDisabled(true);
  registerAppShell(); // §5.5: offline app shell。準備失敗は shell 機能のみに影響し保存と混ぜない
} finally {
  if (db !== null) {
    setupStorageUi(db);
  }
}

function setDisabled(disabled: boolean): void {
  saveButton.disabled = disabled;
  pasteAsNewButton.disabled = disabled;
  searchButton.disabled = disabled;
  copyButton.disabled = disabled;
  deleteButton.disabled = disabled;
  exportTxtButton.disabled = disabled;
  exportAllButton.disabled = disabled;
  updateActionButtons();
}

function setupStorageUi(database: IDBDatabase): void {
  saveButton.addEventListener("click", () => {
    void commitNew(textarea.value);
  });
  pasteAsNewButton.addEventListener("click", () => {
    void pasteAsNew();
  });
  backButton.addEventListener("click", () => {
    // mobile 最小 navigation: 選択は保持し、compose view に戻るだけ
    document.body.dataset.view = "compose";
  });
  copyButton.addEventListener("click", () => {
    void copySelected();
  });
  deleteButton.addEventListener("click", () => {
    void deleteSelected();
  });
  exportTxtButton.addEventListener("click", () => {
    void exportSelected();
  });
  exportAllButton.addEventListener("click", () => {
    void exportAllRecords();
  });
  searchButton.addEventListener("click", () => {
    void openSearch();
  });
  // key handling は Search input focus 中のみ。global keydown は登録しない
  searchInput.addEventListener("input", () => {
    searchIndex = 0; // query 変更で選択を先頭へ戻す
    renderSearch();
  });
  searchInput.addEventListener("keydown", searchKeydown);
  // Escape: overlay open 中は overlay 内のどの control でも close。overlay 外では捕捉しない
  // (document / window の global keydown は登録しない。overlay 内 bubbled event のみ)
  searchOverlay.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  });
  // CLEAR: query だけを戻す。overlay を閉じない・Composer/選択 record に触らない
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchIndex = 0;
    renderSearch();
    searchInput.focus();
  });
  // CLOSE / backdrop / Escape は同じ closeSearch() を使う
  searchClose.addEventListener("click", () => {
    closeSearch();
  });
  searchOverlay.addEventListener("click", (e) => {
    if (e.target === searchOverlay) closeSearch(); // box 内部の click では close しない
  });
  // Tab / Shift+Tab: overlay 内 control (input → CLEAR → CLOSE) を循環。Tab を global には扱わない
  for (const control of [searchInput, searchClear, searchClose]) {
    control.addEventListener("keydown", (e) => searchTabKey(e as KeyboardEvent));
  }
  void refreshRecordCount(database); // reload 後の件数表示。retrieval は Search overlay が担う
  void requestPersistence(); // §5.5: 初回利用準備。eviction されにくくする要求であり保存成功条件ではない (Baseline §6)
  registerAppShell(); // §5.5: offline app shell。準備失敗は shell 機能のみに影響し保存と混ぜない
}

/** 共通 append pipeline: name 生成 / 衝突 suffix / IndexedDB tx。source は呼び出し側が固定する。
 * 完了時は保存 snapshot と textarea が一致する場合だけ Composer を clear する (Save 後の現行 behavior)。
 * 返り値は保存確定した record name。失敗時は null (表示 text "Saved: ..." を state の代わりに使わない)。 */
async function commitNew(sourceText: string): Promise<string | null> {
  const text = sourceText; // snapshot: 保存内容と完了時の比較はこれで固定 (§4.4)
  const prefix = capturedAtPrefix(new Date()); // 開始時に一度だけ。衝突 retry でも進めない (§3.3)
  const title = deriveTitle(text);
  saveButton.disabled = true;
  pasteAsNewButton.disabled = true;
  try {
    for (let suffix = 0; ; suffix += 1) {
      const name = candidateName(prefix, title, suffix);
      if (!isNameWithinLimit(name)) {
        showFailed("name_conflict", `${name}: suffix を付けると 255 UTF-8 byte を超える`);
        return null;
      }
      let outcome: AddOutcome;
      try {
        outcome = await addRecord(db!, { name, text }); // tx 開始自体の失敗 (unavailable / invalid state) も保存未成立
      } catch (e) {
        showFailed("save_failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return null;
      }
      if (outcome.kind === "committed") {
        showSaved(name, text);
        refreshRecordCount(db!); // tx complete → Saved 表示 → 件数更新。Search は open 時に再読みする
        return name;
      }
      if (outcome.kind === "conflict") continue; // 同じ時刻・同じ title のまま suffix を進める (§3.5)
      showFailed(
        "save_failed",
        outcome.error instanceof Error ? `${outcome.error.name}: ${outcome.error.message}` : String(outcome.error),
      );
      return null;
    }
  } finally {
    saveButton.disabled = false;
    pasteAsNewButton.disabled = false;
  }
}

/** Paste as New: clipboard → 共通 save pipeline → 即保存 → 保存した record を read-only 表示。
 * textarea を経由しない 1 click 操作。clipboard read 失敗時は Composer を変更しない。
 * clipboard read 前に concurrent invocation を guard する (rapid 正押しで同内容を2 record にしない)。 */
let pasteBusy = false;
async function pasteAsNew(): Promise<void> {
  if (pasteBusy) return;
  pasteBusy = true;
  try {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      showFailed(
        "clipboard_read",
        e instanceof Error ? `${e.name}: ${e.message}` : String(e), // user-visible error。silent fallback しない
      );
      return;
    }
    const name = await commitNew(text);
    if (name !== null) {
      await selectRecord(name); // 保存直後の record を右 pane に表示して明示する
      document.body.dataset.view = "record";
    }
  } finally {
    pasteBusy = false; // success / clipboard failure のどちらの経路でも操作可能状態へ戻る
  }
}

function showSaved(name: string, savedText: string): void {
  result.textContent = `Saved: ${name}`;
  // 保存開始時 snapshot と現在の textarea が同じ場合だけ clear。古い非同期完了が新しい入力を消さない。
  if (textarea.value === savedText) textarea.value = "";
}

function showFailed(cause: string, detail: string): void {
  result.textContent = `Failed: ${cause} (${detail})`; // textarea は保持する
}

function refreshRecordCount(database: IDBDatabase): void {
  // Phase 2: RECENT list 撤去。Search overlay が retrieval を担う。ここでは件数表示のみ。
  void listRecords(database)
    .then((names) => {
      recordCount.textContent = `records: ${names.length}`;
      // 復旧したら残っていた List failed 表示を消す。persistence 表示を壊さない
      if (storageState.textContent.startsWith("List failed: ")) storageState.textContent = "";
    })
    .catch((e: unknown) => {
      // 失敗時も前の件数表示は保持する (state を破壊しない)
      storageState.textContent = `List failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    });
}

async function selectRecord(name: string): Promise<void> {
  const generation = ++selectGeneration; // 新しい選択が開始したら前の read 完了は無効
  let record: StoredRecord | undefined;
  try {
    record = await readRecord(db!, name); // 選択のたびに現在の IndexedDB から読む。list は text を持たない
  } catch (e) {
    // 失敗表示は「最後に開始した選択」のものだけにする (PC 側と同じ)
    if (generation === selectGeneration) showActionFailed("read_failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return;
  }
  if (generation !== selectGeneration) return; // stale read: 後続の選択を上書きしない
  if (record === undefined) {
    selectedName = null;
    readArea.hidden = true;
    emptyState.hidden = false;
    readName.textContent = "";
    readText.textContent = "";
    document.body.dataset.view = "compose";
  } else {
    selectedName = name;
    readArea.hidden = false;
    emptyState.hidden = true;
    readName.textContent = record.name;
    readText.textContent = record.text; // plain text 表示。HTML として解釈しない
    document.body.dataset.view = "record"; // mobile: record を選んだら record view へ
  }
  readResult.textContent = ""; // record を切り替えたら前の操作結果表示は消す
  updateActionButtons();
}

// ===== Search overlay (UI-DESIGN.md §2/§4/§5)。dmenu-like finder。read-only retrieval UI。
// global keyboard shortcut は一切登録しない (Ctrl/Cmd+K, `/`, Ctrl+F 等を奪わない)。
// key handling は #search-input focus 中のみ。open 時に全件を 1 本の readonly getAll で読む
// 薄い session cache (閉じたら破棄)。cache layer / search index は作らない。
let searchOpen = false;
let searchSession: StoredRecord[] = [];
let searchIndex = 0;

async function openSearch(): Promise<void> {
  searchOpen = true;
  searchOverlay.hidden = false;
  searchInput.value = ""; // close で query は消える。次 open は empty query = recent records
  searchIndex = 0;
  searchInput.focus(); // open 時に autofocus
  let records: StoredRecord[];
  try {
    records = (await readAllRecords(db!)).toReversed(); // getAll 1 request。key昇順 → 新しい順に反転
  } catch (e) {
    if (searchOpen) {
      showFailed("search_read", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      closeSearch();
    }
    return;
  }
  if (!searchOpen) return; // read 中に close された
  searchSession = records;
  renderSearch();
}

/** 現在の query で session cache を filter (既存 chronological 降順のまま)。ranking なし。filename のみ表示。 */
function renderSearch(): void {
  const matched = searchRecords(searchInput.value, searchSession);
  searchClear.disabled = searchInput.value.length === 0; // CLEAR は query non-empty のときだけ有効
  if (searchIndex >= matched.length) searchIndex = Math.max(0, matched.length - 1);
  const fragment = document.createDocumentFragment();
  matched.forEach((record, i) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = record.name; // filename only。HTML として解釈しない
    button.classList.toggle("selected", i === searchIndex); // reverse-video 選択行
    button.tabIndex = -1; // result row は Tab stop に入れない (Arrow/Enter/click で操作)
    button.addEventListener("click", () => {
      void openFromSearch(record.name);
    });
    li.append(button);
    fragment.append(li);
  });
  searchResults.replaceChildren(fragment);
}

function closeSearch(): void {
  searchOpen = false;
  searchOverlay.hidden = true;
  searchSession = []; // 閉じたら session cache も破棄
  searchButton.focus(); // SEARCH button へ focus を戻す
}

/** Search からの open: 既存 selectRecord (stale guard 含む) を使う。別の read pipeline は作らない。 */
async function openFromSearch(name: string): Promise<void> {
  await selectRecord(name);
  closeSearch();
}

/** Tab / Shift+Tab を overlay 内 control (input → CLEAR → CLOSE) に限定する。
 * disabled CLEAR は order から外れる (native skip と同义)。result row は含めない。overlay open 中のみ有効。 */
function searchTabKey(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const order = [searchInput, searchClear, searchClose].filter((el) => !el.disabled);
  const index = order.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.shiftKey ? (index <= 0 ? order.length - 1 : index - 1) : (index >= order.length - 1 ? 0 : index + 1);
  order[next]?.focus();
}

function searchKeydown(e: KeyboardEvent): void {
  // Arrow / Enter のみ input 固有。Escape は overlay 層で処理する
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); // Arrow は Search 内でのみ扱い、cursor 移動はさせない
    const matched = searchRecords(searchInput.value, searchSession);
    if (matched.length === 0) return;
    searchIndex = e.key === "ArrowDown" ? Math.min(searchIndex + 1, matched.length - 1) : Math.max(searchIndex - 1, 0);
    renderSearch();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const matched = searchRecords(searchInput.value, searchSession);
    if (searchIndex >= matched.length) return;
    void openFromSearch(matched[searchIndex]!.name);
  }
}

async function copySelected(): Promise<void> {
  const name = selectedName;
  if (name === null) return;
  const record = await readRecord(db!, name); // copy 時も現在の IndexedDB から読む (cache state は作らない)
  if (record === undefined) {
    showActionFailed("not_found", `${name} は既に存在しない`);
    return;
  }
  try {
    await navigator.clipboard.writeText(record.text); // 本文をそのままコピーする。変換しない (§4.3)
    readResult.textContent = `Copied: ${record.name}`;
  } catch (e) {
    showActionFailed("copy_failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}

async function deleteSelected(): Promise<void> {
  const name = selectedName;
  if (name === null) return;
  if (!window.confirm(`Delete ${name}?`)) return; // 標準確認のみ。trash・undo・独自 modal は作らない
  const generation = ++deleteGeneration; // delete 対象 snapshot。完了時は「対象が今も選択中」のときだけ clear
  const outcome = await deleteRecord(db!, name);
  if (outcome.kind !== "deleted") {
    const e = outcome.error;
    showActionFailed("delete_failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e)); // 一覧・選択表示は変更しない
    return;
  }
  // 削除中に別 record を選んだ場合は新 selection を壊さない。件数更新は常に実行する (PC 側と同じ)。
  refreshRecordCount(db!);
  if (generation === deleteGeneration && selectedName === name) {
    // tx complete 後のみ: 選択 clear → read area clear
    selectedName = null;
    readArea.hidden = true;
    emptyState.hidden = false;
    readName.textContent = "";
    readText.textContent = "";
    document.body.dataset.view = "compose";
  }
  updateActionButtons();
}

function showActionFailed(cause: string, detail: string): void {
  readResult.textContent = `Failed: ${cause} (${detail})`; // 選択表示・一覧は保持する
}

function updateActionButtons(): void {
  copyButton.disabled = selectedName === null; // record 未選択では操作できない
  exportTxtButton.disabled = selectedName === null;
  deleteButton.disabled = selectedName === null;
}

/** §5.4: 選択中 record の現在値を普通の .txt として download する。export は正本を変更しない。 */
async function exportSelected(): Promise<void> {
  const name = selectedName;
  if (name === null) return;
  const record = await readRecord(db!, name); // export 時も現在の IndexedDB から読む
  if (record === undefined) {
    showActionFailed("not_found", `${name} は既に存在しない`);
    return;
  }
  try {
    downloadBlob(new Blob([record.text], { type: "text/plain" }), record.name); // 本文そのまま。trim・改行変換・NFKC・BOM なし (§5.4)
    readResult.textContent = `Exported: ${record.name}`;
  } catch (e) {
    showActionFailed("export_failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}

/** §5.4: 全 record を zip で download。entry は name → text の .txt のみ (manifest・metadata なし)。 */
async function exportAllRecords(): Promise<void> {
  try {
    const records = await readAllRecords(db!);
    const blob = await downloadZip(records.map((r) => ({ name: r.name, input: r.text }))).blob(); // client-zip は STORE (無圧縮) 専用
    downloadBlob(blob, "spool-export.zip"); // 固定名。時刻入り・version なし (§5.4)
    exportResult.textContent = `Exported: spool-export.zip (${records.length} records)`;
  } catch (e) {
    exportResult.textContent = `Export failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`; // IndexedDB record は変更しない
  }
}

/** Blob → object URL → 一時的な `<a download>` → click → revoke (§5.4)。download manager 等は作らない。 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** §5.5: navigator.storage.persist() を要求し、結果を小さく表示する。拒否でも IndexedDB の通常利用は続く。 */
async function requestPersistence(): Promise<void> {
  try {
    if (!navigator.storage?.persist) {
      storageState.textContent = "Storage: persistence unsupported";
      return;
    }
    if (await navigator.storage.persisted()) {
      storageState.textContent = "Storage: persistent";
      return;
    }
    storageState.textContent = (await navigator.storage.persist()) ? "Storage: persistent" : "Storage: persistence not granted";
  } catch (e) {
    storageState.textContent = `Storage: persistence failed (${e instanceof Error ? e.name : String(e)})`; // 保存機能には影響しない
  }
}

/** §5.5: 手書きの小さな service worker (/sw.js)。静的 shell のみ。lifecycle は browser 標準に任せる。 */
function registerAppShell(): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return; // dev server は対象外 (§5.5 の完成判定は production build)
  navigator.serviceWorker.register("/sw.js").then(
    () => {}, // 成功表示は不要。browser の update lifecycle に任せる
    (e: unknown) => {
      shellState.textContent = `Shell: offline cache unavailable (${e instanceof Error ? e.message : String(e)})`;
    },
  );
}
