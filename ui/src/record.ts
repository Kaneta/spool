// record.ts — Saved Record page entry (UI-DESIGN.md §10)。Search の Enter / row click で別 tab に
// 開かれる read-only reading surface。既存 IndexedDB helper (indexeddb.ts, DB spool / records /
// keyPath name) を再利用し、schema / version は変更しない。表示は textContent のみ (HTML 解釈なし)。
// Composer / Save / Edit / Markdown render は追加しない。
import { openDatabase, readRecord } from "./indexeddb";
import "./record.css"; // CSP default-src 'self' のため外部 file (mobile.css と同構成)

const recordNameEl = document.querySelector<HTMLElement>("#record-name")!;
const recordTextEl = document.querySelector<HTMLPreElement>("#record-text")!;
const recordStateEl = document.querySelector<HTMLParagraphElement>("#record-state")!;
const copyButton = document.querySelector<HTMLButtonElement>("#record-copy")!;

function issueReadFailed(cause: string, e: unknown): void {
  recordStateEl.textContent = `Record read failed: ${cause} (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`;
}

try {
  const recordName = new URLSearchParams(location.search).get("name");
  if (recordName === null || recordName.length === 0) {
    recordStateEl.textContent = "Record name missing.";
  } else {
    const db = await openDatabase(); // open 失敗は fallback せず小さな error 表示で止める
    const record = await readRecord(db, recordName);
    if (record === undefined) {
      recordStateEl.textContent = "Record not found.";
    } else {
      recordNameEl.textContent = record.name; // filename
      recordTextEl.textContent = record.text; // plain text。script も文字として表示される
      copyButton.hidden = false; // [ COPY ] は本文が読めた時だけ出す (name missing / not found では不要)
      copyButton.addEventListener("click", () => {
        void navigator.clipboard
          .writeText(record.text) // exact saved plain text。変換しない (§4.3)
          .then(() => {
            recordStateEl.textContent = `Copied: ${record.name}`;
          })
          .catch((e: unknown) => {
            recordStateEl.textContent = `Copy failed (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`;
          });
      });
    }
  }
} catch (e) {
  issueReadFailed("record_read", e);
}
