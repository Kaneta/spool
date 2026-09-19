// markdown-preview.ts — Markdown Preview page entry (UI-DESIGN.md §12)。
// Composer の現在の textarea 内容だけを描画する derived read-only surface。Saved Record を読まない。
// BroadcastChannel (session 毎) で Composer と接続: Preview 側は { type: "ready" } を送り、
// Composer から { type: "source", text } を受けて render する。render は軽い debounce のみ。
import "./markdown-preview.css"; // CSP default-src 'self' のため外部 file (record.css と同構成)
import { renderMarkdown } from "./markdown-render";

const bodyEl = document.querySelector<HTMLElement>("#preview-body")!;
const stateEl = document.querySelector<HTMLParagraphElement>("#preview-state")!;

// window name 再利用のため opener 付きで開かれるが、primary は Composer open 直後に切断する
// (preview-link.ts)。この module load 時の null 化は defensive fallback (composer 側が
// WindowProxy を得られなかった環境用)。連携は全て BroadcastChannel のため opener 参照は不要。
if (window.opener !== null) window.opener = null;

const sessionId = new URLSearchParams(location.search).get("session");
if (sessionId === null || sessionId.length === 0) {
  stateEl.textContent = "Preview session missing.";
} else if (typeof BroadcastChannel === "undefined") {
  stateEl.textContent = "Live preview unavailable.";
} else {
  const channel = new BroadcastChannel(`spool-markdown-preview:${sessionId}`);

  // 軽い debounce (§12): 大きな本文の連続送信ごとに毎 render しない。順序は channel 到着順のまま。
  let pendingText: string | null = null;
  let scheduled = 0;
  function show(text: string): void {
    if (text.length === 0) {
      stateEl.textContent = "Nothing to preview.";
      bodyEl.hidden = true;
      bodyEl.replaceChildren();
      return;
    }
    bodyEl.innerHTML = renderMarkdown(text); // html: false で rendered markup のみ (生の user HTML は入らない)
    bodyEl.hidden = false;
    stateEl.textContent = "";
  }
  channel.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { type?: string; text?: string };
    if (msg.type !== "source" || typeof msg.text !== "string") return; // 想定外は捨てる
    pendingText = msg.text;
    if (scheduled !== 0) return;
    scheduled = window.setTimeout(() => {
      scheduled = 0;
      if (pendingText !== null) show(pendingText); // 最新の source のみ render
    }, 75);
  });
  channel.postMessage({ type: "ready" }); // handshake: load timing に依存しない initial 取得 (§10)
}
