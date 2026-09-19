// search.test.ts — Search matching core の unit test (UI-DESIGN.md: normalization / AND / whitespace)。
import { describe, expect, it } from "vitest";
import { normalizeText, recordMatches, searchRecords, queryTokens } from "./search";

describe("normalizeText", () => {
  it("NFKC normalizes fullwidth ASCII", () => {
    expect(normalizeText("ＡＢＣ：")).toBe("abc:");
  });

  it("folds uppercase to lowercase", () => {
    expect(normalizeText("ABC memo")).toBe("abc memo");
  });
});

describe("queryTokens", () => {
  it("splits on whitespace and ignores empty tokens (#4 whitespace)", () => {
    expect(queryTokens("  空調  \t 設定 \n ")).toEqual(["空調", "設定"]);
  });

  it("returns no tokens for whitespace-only query", () => {
    expect(queryTokens(" \t ")).toEqual([]);
  });
});

describe("recordMatches", () => {
  it("#1 fullwidth record text matches ASCII query", () => {
    expect(recordMatches("abc", { name: "x.txt", text: "ＡＢＣが出た" })).toBe(true);
  });

  it("#2 Japanese whitespace AND query matches body", () => {
    expect(recordMatches("空調 設定", { name: "20260918-note.txt", text: "東側の空調設定を変更" })).toBe(true);
  });

  it("#3 AND requires every token (no match when one token missing)", () => {
    expect(recordMatches("空調 西側", { name: "note.txt", text: "東側の空調を確認" })).toBe(false);
  });

  it("matches against filename too", () => {
    expect(recordMatches("東側", { name: "20260911-1540-東側空調.txt", text: "" })).toBe(true);
  });

  it("empty query matches everything", () => {
    expect(recordMatches("", { name: "a.txt", text: "" })).toBe(true);
    expect(recordMatches(" \t", { name: "b.txt", text: "x" })).toBe(true);
  });
});

describe("searchRecords", () => {
  const records = [
    { name: "20260911-1540-東側空調.txt", text: "東側ラウンジ" },
    { name: "20260905-0812-講義室メモ.txt", text: "講義室の空調設定を変更" },
    { name: "20260918-0932-空調設定変更.txt", text: "西側の空調" },
  ];

  it("filters in existing chronological order without ranking", () => {
    expect(searchRecords("東側 ラウンジ", records).map((r) => r.name)).toEqual([
      "20260911-1540-東側空調.txt",
    ]);
  });

  it("keeps all records for empty query", () => {
    expect(searchRecords("", records)).toHaveLength(3);
  });
});
