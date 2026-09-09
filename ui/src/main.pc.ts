// main.pc.ts — PC build entry (M2 Unit 5)。storage backend は httpapi (DESIGN-v2 §6.4)。
// build target で IndexedDB build と分かれており、runtime probing はしない (§1)。
// 正本は root 直下の ordinary .txt。list / read / copy / delete / refresh のみで、
// export / persist / service worker / offline は PC build に存在しない (§5)。

import { capturedAtIso } from "./filename";
import "./pc.css";
import {
  ApiError,
  deleteRecord,
  health,
  listRecords,
  readRecord,
  saveRecord,
  tokenFromHash,
  type RecordEntry,
} from "./storage/httpapi";

const textarea = document.querySelector<HTMLTextAreaElement>("#text")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save")!;
const result = document.querySelector<HTMLParagraphElement>("#result")!;
const listElement = document.querySelector<HTMLUListElement>("#list")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const serverState = document.querySelector<HTMLParagraphElement>("#server-state")!;
const readArea = document.querySelector<HTMLElement>("#read")!;
const readName = document.querySelector<HTMLElement>("#read-name")!;
const readText = document.querySelector<HTMLPreElement>("#read-text")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy")!;
const deleteButton = document.querySelector<HTMLButtonElement>("#delete")!;
const readResult = document.querySelector<HTMLParagraphElement>("#read-result")!;

let selectedName: string | null = null; // ephemeral は選択 state のみ。本文は毎回 server から読む
// 操作単位の小さな generation (§4.4): 最後に開始した select / delete だけが選択 state と
// read 表示を更新できる。stale な完了が後続の選択を壊さないためのもの。永続化しない。
let selectGeneration = 0;
let deleteGeneration = 0;

const token = tokenFromHash(location.hash); // fragment は HTTP server へ送られない (§9)
if (token === null) {
  // token なし UI: 利用不能であることを最小表示する。推測・再取得の機能は作らない (§27)
  setDisabled(true);
  serverState.textContent = "Server unavailable: token missing in URL fragment";
} else {
  void checkHealth();
  saveButton.addEventListener("click", () => {
    void saveNew();
  });
  refreshButton.addEventListener("click", () => {
    void refreshList();
  });
  copyButton.addEventListener("click", () => {
    void copySelected();
  });
  deleteButton.addEventListener("click", () => {
    void deleteSelected();
  });
  await refreshList(); // reload 後は server から一覧を再構築する
}

function setDisabled(disabled: boolean): void {
  saveButton.disabled = disabled;
  refreshButton.disabled = disabled;
  updateActionButtons();
}

function updateActionButtons(): void {
  copyButton.disabled = selectedName === null;
  deleteButton.disabled = selectedName === null;
}

/** 起動時の availability 表示 (§27)。失敗でも保存操作自体は妨げない (実行すれば uncertain 表示になる)。 */
async function checkHealth(): Promise<void> {
  if (!(await health(token ?? ""))) {
    serverState.textContent = "Server unavailable (token mismatch or process is down)";
  }
}

function describe(e: unknown): string {
  return e instanceof ApiError ? e.code : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

async function saveNew(): Promise<void> {
  const text = textarea.value; // snapshot: 完了時の比較はこれで固定 (§4.4)
  const capturedAt = capturedAtIso(new Date()); // 開始時に一度だけ。suffix retry でも進めない (§3.3)
  if (capturedAt === null) {
    result.textContent = "Failed: invalid_clock (local time unavailable)";
    return;
  }
  saveButton.disabled = true;
  try {
    const outcome = await saveRecord(token ?? "", text, capturedAt);
    switch (outcome.kind) {
      case "saved":
        result.textContent = `Saved: ${outcome.name}`;
        // 保存開始時 snapshot と現在の textarea が同じ場合だけ clear (stale completion protection)
        if (textarea.value === text) textarea.value = "";
        await refreshList();
        return;
      case "failed":
        result.textContent = `Failed: ${outcome.code}`; // textarea 保持。勝手に retry しない
        return;
      case "uncertain":
        // commit した可能性がある。自動再 POST しない。一覧確認は明示 Refresh (§12)
        result.textContent = "Uncertain: save may have completed — check the list (Refresh)";
        return;
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function refreshList(): Promise<void> {
  let records: RecordEntry[];
  try {
    records = await listRecords(token ?? ""); // wire は name 昇順 (server 正)
  } catch (e) {
    serverState.textContent = `List failed: ${describe(e)}`; // 前の list 表示は保持
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const record of records.toReversed()) {
    // 表示は name 降順 = 新しい record が上 (DESIGN §4.3)。wire 順と表示順は別概念
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.name = record.name;
    button.textContent = record.kind === "external" ? `${record.name} [external]` : record.name; // plain text。innerHTML は使わない
    button.addEventListener("click", () => {
      void selectRecord(record.name);
    });
    li.append(button);
    fragment.append(li);
  }
  listElement.replaceChildren(fragment);
  markSelected();
  serverState.textContent = ""; // 正常に server に届いたので可用性 banner は消す
}

async function selectRecord(name: string): Promise<void> {
  const generation = ++selectGeneration; // 新しい選択が開始したら前の read 完了は無効
  let text: string;
  try {
    text = await readRecord(token ?? "", name); // 選択のたびに現在の server 内容を取得する
  } catch (e) {
    // 失敗表示は「最後に開始した操作」のものだけにする
    if (generation === selectGeneration) showActionFailed(describe(e)); // 選択表示・一覧は保持
    return;
  }
  if (generation !== selectGeneration) return; // stale read: 後続の選択を上書きしない
  selectedName = name;
  readArea.hidden = false;
  readName.textContent = name;
  readText.textContent = text; // plain text 表示。HTML として解釈しない
  markSelected();
  readResult.textContent = ""; // record を切り替えたら前の操作結果表示は消す
  updateActionButtons();
}

function markSelected(): void {
  for (const button of listElement.querySelectorAll("button")) {
    button.classList.toggle("selected", button.dataset.name === selectedName);
  }
}

async function copySelected(): Promise<void> {
  const name = selectedName;
  if (name === null) return;
  let text: string;
  try {
    text = await readRecord(token ?? "", name); // copy 時も現在値を読む (cache state は作らない)
  } catch (e) {
    showActionFailed(describe(e));
    return;
  }
  try {
    await navigator.clipboard.writeText(text); // 本文そのまま。変換しない (§4.3)
    readResult.textContent = `Copied: ${name}`;
  } catch (e) {
    showActionFailed(`copy_failed (${e instanceof Error ? e.name : String(e)})`);
  }
}

async function deleteSelected(): Promise<void> {
  const name = selectedName;
  if (name === null) return;
  if (!window.confirm(`Delete ${name}?`)) return; // 標準確認のみ。trash・undo・独自 modal は作らない
  const generation = ++deleteGeneration; // delete 対象 snapshot。完了時は「対象が今も選択中」のときだけ clear
  try {
    await deleteRecord(token ?? "", name);
  } catch (e) {
    if (generation === deleteGeneration) showActionFailed(describe(e)); // delete 失敗なら選択を勝手に消さない
    return;
  }
  // 削除中に別 record を選んだ場合は新 selection を壊さない。list refresh は常に実行する。
  if (generation === deleteGeneration && selectedName === name) {
    selectedName = null;
    readArea.hidden = true;
    readName.textContent = "";
    readText.textContent = "";
    updateActionButtons();
  }
  await refreshList();
}

function showActionFailed(cause: string): void {
  readResult.textContent = `Failed: ${cause}`; // 選択表示・一覧は保持する
}
