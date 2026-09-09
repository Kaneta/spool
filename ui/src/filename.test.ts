import { expect, it } from "vitest";
import { candidateName, capturedAtPrefix, deriveTitle, isNameWithinLimit, utf8ByteLength } from "./filename";

// DESIGN-v2 §3.4 title 導出の純粋 test。
it("空本文は paste", () => {
  expect(deriveTitle("")).toBe("paste");
});

it("全行空行は paste", () => {
  expect(deriveTitle("  \n\t\n \n")).toBe("paste");
});

it("最初の非空行を使う", () => {
  expect(deriveTitle("  world  \nsecond")).toBe("world");
});

it("control 文字を削除", () => {
  expect(deriveTitle("a\u0007b\u0000c")).toBe("abc");
});

it("invalid 記号を削除", () => {
  expect(deriveTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
});

it("U+0009–U+000D は step 2 で削除される (space 置換ではない)", () => {
  expect(deriveTitle("a\tb")).toBe("ab");
});

it("ASCII 空白の連続を一つに畳む", () => {
  expect(deriveTitle("a   b   c")).toBe("a b c");
});

it("Unicode whitespace は空白扱いしない", () => {
  expect(deriveTitle("a\u00a0b")).toBe("a\u00a0b");
});

it("先頭の . と - を削除", () => {
  expect(deriveTitle("..--foo")).toBe("foo");
});

it("途中の . と - は保持", () => {
  expect(deriveTitle("foo-bar.baz")).toBe("foo-bar.baz");
});

it("64 code point で切る", () => {
  expect(deriveTitle("a".repeat(65))).toBe("a".repeat(64));
});

it("234 UTF-8 byte で切る (4-byte code point)", () => {
  const title = deriveTitle("😀".repeat(80));
  expect([...title].length).toBe(58);
  expect(utf8ByteLength(title)).toBe(232);
});

it("切断で露出した末尾空白を削る", () => {
  expect(deriveTitle("a".repeat(63) + " " + "b".repeat(10))).toBe("a".repeat(63));
});

// §3.2 / §3.3 / §3.5
it("prefix は保存開始時の端末 local time minute", () => {
  // local constructor の Date の local field がそのまま出る。実行環境の timezone に依存しない
  expect(capturedAtPrefix(new Date(2026, 8, 9, 7, 5))).toBe("20260909-0705");
});

it("suffix なし → ~01 → ~99 → ~100", () => {
  const prefix = "20260909-0705";
  expect(candidateName(prefix, "paste", 0)).toBe("20260909-0705-paste.txt");
  expect(candidateName(prefix, "paste", 1)).toBe("20260909-0705-paste~01.txt");
  expect(candidateName(prefix, "paste", 99)).toBe("20260909-0705-paste~99.txt");
  expect(candidateName(prefix, "paste", 100)).toBe("20260909-0705-paste~100.txt");
});

it("byte 上限内の最大 title でも suffix ~NN を受けられる", () => {
  const name = candidateName("20260909-0705", deriveTitle("😀".repeat(80) + "ab"), 1);
  expect(isNameWithinLimit(name)).toBe(true);
  expect(utf8ByteLength(name)).toBeLessThanOrEqual(255);
});

it("234 byte title + suffix ~99 は ちょうど 255 byte (限界内)", () => {
  const title = "😀".repeat(58) + "ab"; // 58 emoji (232 byte) + ab = 234 byte、64 code point 未満
  expect(utf8ByteLength(title)).toBe(234);
  const name = candidateName("20260909-1046", title, 99);
  expect(utf8ByteLength(name)).toBe(255);
  expect(isNameWithinLimit(name)).toBe(true);
});

it("234 byte title + suffix ~100 は 255 byte 超え (name_conflict になる境界)", () => {
  const title = "😀".repeat(58) + "ab";
  const name = candidateName("20260909-1046", title, 100);
  expect(utf8ByteLength(name)).toBe(256);
  expect(isNameWithinLimit(name)).toBe(false);
});
