// markdown-render.ts — Composer Markdown Preview 用の最小 renderer (UI-DESIGN.md §12)。
// dependency は markdown-it 1 つに限定。html: false で raw HTML は render せず escape するため、
// Composer 本文 (= untrusted plain text) の script / event handler は実行されない。
// link protocol は markdown-it 既定の validateLink (javascript: / vbscript: / file: / data: を拒否) に委ねる。
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false });

export function renderMarkdown(text: string): string {
  return md.render(text);
}
