// main.ts — Paste as New → 保存 → 一覧 → 読む の一本道 (DESIGN-v2 §10.1, §4.3, §5.3)。
// textarea → 保存開始時刻を一度取得 → filename生成 → IndexedDB add → transaction complete → Saved 表示 → list refresh。

import { candidateName, capturedAtPrefix, deriveTitle, isNameWithinLimit } from "./filename";
import { addRecord, deleteRecord, listRecords, openDatabase, readAllRecords, readRecord, type AddOutcome } from "./indexeddb";
import { downloadZip } from "client-zip"; // §5.4: STORE 専用・dependency なしの小さな zip library

const textarea = document.querySelector<HTMLTextAreaElement>("#text")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save")!;
const result = document.querySelector<HTMLParagraphElement>("#result")!;
const listElement = document.querySelector<HTMLUListElement>("#list")!;
const readArea = document.querySelector<HTMLElement>("#read")!;
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

let selectedName: string | null = null; // ephemeral は選択 state のみ。一覧は毎回 IndexedDB から読む (第二正本を作らない)

const db = await openDatabase();

saveButton.addEventListener("click", () => {
  void saveNew();
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
await refreshList(); // reload 後は IndexedDB から一覧を再構築する

void requestPersistence(); // §5.5: 初回利用準備。eviction されにくくする要求であり保存成功条件ではない (Baseline §6)
registerAppShell(); // §5.5: offline app shell。準備失敗は shell 機能のみに影響し保存と混ぜない

async function saveNew(): Promise<void> {
  const text = textarea.value; // snapshot: 保存内容と完了時の比較はこれで固定 (§4.4)
  const prefix = capturedAtPrefix(new Date()); // 開始時に一度だけ。衝突 retry でも進めない (§3.3)
  const title = deriveTitle(text);
  saveButton.disabled = true;
  try {
    for (let suffix = 0; ; suffix += 1) {
      const name = candidateName(prefix, title, suffix);
      if (!isNameWithinLimit(name)) {
        showFailed("name_conflict", `${name}: suffix を付けると 255 UTF-8 byte を超える`);
        return;
      }
      let outcome: AddOutcome;
      try {
        outcome = await addRecord(db, { name, text }); // tx 開始自体の失敗 (unavailable / invalid state) も保存未成立
      } catch (e) {
        showFailed("save_failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return;
      }
      if (outcome.kind === "committed") {
        showSaved(name, text);
        await refreshList(); // tx complete → Saved 表示 → list refresh。失敗時は refresh しない
        return;
      }
      if (outcome.kind === "conflict") continue; // 同じ時刻・同じ title のまま suffix を進める (§3.5)
      showFailed(
        "save_failed",
        outcome.error instanceof Error ? `${outcome.error.name}: ${outcome.error.message}` : String(outcome.error),
      );
      return;
    }
  } finally {
    saveButton.disabled = false;
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


async function refreshList(): Promise<void> {
  const names = (await listRecords(db)).toReversed(); // name 降順 = 新しい record が上 (§4.3)
  const fragment = document.createDocumentFragment();
  for (const name of names) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name; // plain text。innerHTML は使わない
    button.addEventListener("click", () => {
      void selectRecord(name);
    });
    li.append(button);
    fragment.append(li);
  }
  listElement.replaceChildren(fragment);
  markSelected();
}

async function selectRecord(name: string): Promise<void> {
  const record = await readRecord(db, name); // 選択のたびに現在の IndexedDB から読む。list は text を持たない
  if (record === undefined) {
    selectedName = null;
    readArea.hidden = true;
    readName.textContent = "";
    readText.textContent = "";
  } else {
    selectedName = name;
    readArea.hidden = false;
    readName.textContent = record.name;
    readText.textContent = record.text; // plain text 表示。HTML として解釈しない
  }
  markSelected();
  readResult.textContent = ""; // record を切り替えたら前の操作結果表示は消す
  updateActionButtons();
}

function markSelected(): void {
  for (const button of listElement.querySelectorAll("button")) {
    button.classList.toggle("selected", button.textContent === selectedName);
  }
}

async function copySelected(): Promise<void> {
  const name = selectedName;
  if (name === null) return;
  const record = await readRecord(db, name); // copy 時も現在の IndexedDB から読む (cache state は作らない)
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
  const outcome = await deleteRecord(db, name);
  if (outcome.kind !== "deleted") {
    const e = outcome.error;
    showActionFailed("delete_failed", e instanceof Error ? `${e.name}: ${e.message}` : String(e)); // 一覧・選択表示は変更しない
    return;
  }
  // tx complete 後のみ: 選択 clear → read area clear → list refresh (IndexedDB 正本から)
  selectedName = null;
  readArea.hidden = true;
  readName.textContent = "";
  readText.textContent = "";
  await refreshList();
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
  const record = await readRecord(db, name); // export 時も現在の IndexedDB から読む
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
    const records = await readAllRecords(db);
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
