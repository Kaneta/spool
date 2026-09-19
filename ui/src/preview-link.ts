// preview-link.ts — Composer ↔ Markdown Preview session link (UI-DESIGN.md §12)。
// 1 Composer tab = 1 ephemeral session (crypto.randomUUID)。永続保存しない (reload で新 session)。
// channel は global "spool-preview" を使わない: 複数 Composer tab の混線を防ぐため
// `spool-markdown-preview:<session-id>` を session 毎に作る。preview page から ready → 現行 source を返す。

export type PreviewLink = {
  /** OPEN PREVIEW: user gesture 内で同期的に preview tab を open (popup blocker 対策)。既存なら focus。 */
  openPreview(): void;
  /** 現行 textarea 値を preview へ送る。ChatChannel sender order のみで順序を扱う (§11)。 */
  send(text: string): void;
};

export function createPreviewLink(getText: () => string, windowNameBase = "spool-markdown-preview"): PreviewLink | null {
  if (typeof BroadcastChannel === "undefined" || !window.crypto?.randomUUID) return null;
  const sessionId = window.crypto.randomUUID();
  const channel = new BroadcastChannel(`spool-markdown-preview:${sessionId}`);
  // Preview の ready には現行 source で応答。Preview page reload でも再 handshake できる (§10)。
  let waitForReady = true; // 初回 ready まで input 逐次送信は不要
  channel.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { type?: string };
    if (msg.type === "ready") {
      waitForReady = false;
      channel.postMessage({ type: "source", text: getText() });
    }
  });
  return {
    openPreview() {
      // window name (= session ID 付き) で既存 Preview tab を再利用・focus。features は付けない:
      // noopener は実測で named window reuse を壊す (Chromium, §34)。opener 参照は不要のため、
      // open 直後にここで切る (primary)。preview page 側にも load 時の null 化 fallback がある。
      const preview = window.open(`markdown-preview.html?session=${encodeURIComponent(sessionId)}`, windowNameBase + ":" + sessionId);
      if (preview) preview.opener = null;
    },
    send(text) {
      if (waitForReady) return; // 未接続では送らない (Ready handshake で届け直される)
      channel.postMessage({ type: "source", text });
    },
  };
}
