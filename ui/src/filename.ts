// filename.ts — DESIGN-v2 §3.2–§3.5 の純粋処理。I/O なし、本文の正規化 (NFKC・改行変換・trim) は行わない。

export const NAME_MAX_BYTES = 255; // §3.2 name 全体の UTF-8 byte 上限
export const TITLE_MAX_CODE_POINTS = 64; // §3.4 step 6
export const TITLE_MAX_BYTES = 234; // §3.2: 255 − 14 (prefix) − 3 (~NN) − 4 (.txt)

const encoder = new TextEncoder();

export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}

/** ASCII whitespace のみ: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020 (§3.4 step 3) */
function isAsciiWhitespace(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x20;
}

function asciiTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isAsciiWhitespace(s[start]!)) start += 1;
  while (end > start && isAsciiWhitespace(s[end - 1]!)) end -= 1;
  return s.slice(start, end);
}

// §3.4 step 2 の invalid 文字集合 (`/ \ : * ? " < > |`)
const INVALID_CHARS = "/\\:*?\"<>|";

/** §3.4 title 導出。入力は本文、出力は title。 */
export function deriveTitle(text: string): string {
  // step 1: ASCII whitespace で trim して非空になる最初の行。全行空なら "paste"。
  let line: string | undefined;
  for (const l of text.split("\n")) {
    if (asciiTrim(l) !== "") {
      line = l;
      break;
    }
  }
  if (line === undefined) return "paste";

  // step 2: control 文字と invalid 文字を削除する (置換ではない)
  let stripped = "";
  for (const ch of line) {
    const c = ch.codePointAt(0)!;
    if (c > 0x1f && c !== 0x7f && !INVALID_CHARS.includes(ch)) stripped += ch;
  }

  // step 3: ASCII whitespace の連続を U+0020 一つに畳み、前後を削る
  let collapsed = "";
  let pendingWhitespace = false;
  for (const ch of stripped) {
    if (isAsciiWhitespace(ch)) {
      pendingWhitespace = true;
      continue;
    }
    if (pendingWhitespace && collapsed !== "") collapsed += " ";
    pendingWhitespace = false;
    collapsed += ch;
  }

  // step 4: 先頭の . と - を削除
  const title = collapsed.replace(/^[.\-]+/u, "");

  // step 5: 空なら "paste"
  if (title === "") return "paste";

  // step 6
  return truncateTitle(title);
}

/** 64 code point かつ 234 UTF-8 byte になるまで code point 境界で切り詰める。切断で露出した末尾空白は削る。 */
function truncateTitle(s: string): string {
  const cps = [...s];
  while (cps.length > TITLE_MAX_CODE_POINTS || utf8ByteLength(cps.join("")) > TITLE_MAX_BYTES) {
    cps.pop();
    while (cps.length > 0 && isAsciiWhitespace(cps[cps.length - 1]!)) cps.pop();
  }
  return cps.join("");
}

/** §3.3: 保存操作を開始した端末 local time の minute 精度 14 文字 prefix (YYYYMMDD-HHMM) */
export function capturedAtPrefix(d: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    pad(d.getFullYear(), 4) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

/** §3.5: suffix 0 = なし、1 以降は ~01 … ~99, ~100 … (2桁 zero-pad、必要に応じ桁数を増やす) */
export function candidateName(prefix: string, title: string, suffix: number): string {
  const s = suffix === 0 ? "" : `~${String(suffix).padStart(2, "0")}`;
  return `${prefix}-${title}${s}.txt`;
}

export function isNameWithinLimit(name: string): boolean {
  return utf8ByteLength(name) <= NAME_MAX_BYTES;
}
