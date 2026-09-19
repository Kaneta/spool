// markdown-render.test.ts — Markdown Preview renderer の契約 (UI-DESIGN.md §12)。
// raw HTML は実行材料にならないこと (escape)、そして render 非対象要素が HTML に潜らないことを押さえる。
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown-render";

describe("renderMarkdown", () => {
  it("escapes raw HTML script tags (html: false)", () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes HTML event handlers instead of rendering them", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("onerror=");
    expect(html).not.toMatch(/<[a-z]+[^>]*onerror/);
  });

  it("renders headings, emphasis, and strong", () => {
    const html = renderMarkdown("# Title\n\na *b* c **d**");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>b</em>");
    expect(html).toContain("<strong>d</strong>");
  });

  it("renders unordered / ordered lists, blockquote, inline code, fenced code, links, horizontal rule", () => {
    const html = renderMarkdown(
      "- one\n- two\n\n1. first\n\n> quoted\n\n`code`\n\n```text\nfenced\nfenced\n```\n\n[spool](https://example.com/spool)\n\n---",
    );
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('class="language-text"');
    expect(html).toContain("fenced");
    expect(
      (html.match(/<blockquote>/g) ?? []).length,
      "fenced block must not be split by blockquote",
    ).toBe(1);
    expect((html.match(/<hr>/g) ?? []).length).toBe(1);
  });

  it("renders external links but strips dangerous protocols", () => {
    expect(renderMarkdown("[ok](https://example.com/)")).toContain('href="https://example.com/"');
    const bad = renderMarkdown("[x](javascript:alert(1))");
    expect(bad).not.toMatch(/<a\s/); // link は作られず、escaped な literal text として表示される (実行されない)
    expect(bad).not.toMatch(/href="/);
  });
});
