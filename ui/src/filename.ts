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

/** §6.4: 保存操作開始端末の local civil time を ISO minute 形式 ("YYYY-MM-DDTHH:MM:00") で返す。
 * UTC getter は使わず、timezone offset・名は入れない。Invalid Date は null。 */
export function capturedAtIso(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
  );
}

/** §3.6: 生成規則 (§3.2–§3.5) の完全検証。1 つでも違えば false であり、分類は external 候補になる。
 * Go 側 namegen.ValidateGeneratedFilename と同一規則 (共有 fixture で一致を固定)。 */
export function validateGeneratedFilename(name: string): boolean {
  if (!isNameWithinLimit(name)) return false;
  if (!name.endsWith(".txt")) return false;
  const body = name.slice(0, -4); // ".txt" を除いた部分
  // prefix: 13 文字 (YYYYMMDD-HHMM) + separator '-'
  if (body.length < 14 || body[13] !== "-" || !validCompact(body.slice(0, 13))) return false;
  const rest = body.slice(14);
  // suffix は rest の末尾の "~" + 数字列。suffix 形を検出したら suffix としてのみ判定する
  // (「suffix grammar 不正 → external」。title への読み替えはしない)
  const i = rest.lastIndexOf("~");
  if (i >= 0 && isSuffixShaped(rest.slice(i))) {
    if (!validSuffix(rest.slice(i))) return false;
    return validTitle(rest.slice(0, i));
  }
  return validTitle(rest);
}

/** §6.4: read / delete 対象名の safe root-direct-child 検証。生成 format であることは要求しない。
 * validateGeneratedFilename とは別物として統合しない。 */
export function isValidRootDirectChildName(name: string): boolean {
  if (name === "." || name === "..") return false;
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c === 0x2f || c === 0x5c || c === 0) return false; // / \ NUL
  }
  if (!isNameWithinLimit(name)) return false;
  return name.endsWith(".txt");
}

/** 13 文字 "YYYYMMDD-HHMM" の構造と暦有効性。 */
function validCompact(d: string): boolean {
  if (d.length !== 13 || d[8] !== "-") return false;
  if (!isAllDigits(d.slice(0, 8)) || !isAllDigits(d.slice(9))) return false;
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const hour = Number(d.slice(9, 11));
  const minute = Number(d.slice(11, 13));
  // Date は範囲外 field を正規化するため、roundtrip 一致で暦有効性 (2/30・25:00 等) を判定する
  const date = new Date(year, month - 1, day, hour, minute);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
  );
}

/** tail が "~" + 数字列のみの形か。 */
function isSuffixShaped(tail: string): boolean {
  return tail.length >= 2 && tail[0] === "~" && isAllDigits(tail.slice(1));
}

/** suffix grammar: 2 桁 zero-pad (01–99) または 3 桁以上 (100 以上・leading zero なし)。
 * "~1" / "~00" / "~010" / "~099" は生成され得ないため不可 (§3.5)。 */
function validSuffix(tail: string): boolean {
  const d = tail.slice(1);
  if (d[0] === "0") return d.length === 2 && d[1] !== "0";
  return d.length === 2 || d.length >= 3;
}

/** title 部分の規則: 生成結果が満たす文字条件 (§3.4)。 */
function validTitle(t: string): boolean {
  const cps = [...t];
  if (cps.length === 0 || cps.length > TITLE_MAX_CODE_POINTS || utf8ByteLength(t) > TITLE_MAX_BYTES) return false;
  if (cps[0] === "." || cps[0] === "-" || cps[0] === " " || cps[cps.length - 1] === " ") return false;
  let prevSpace = false;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || c === 0x7f || INVALID_CHARS.includes(ch)) return false;
    if (ch === " ") {
      if (prevSpace) return false; // 連続 space は生成されない
      prevSpace = true;
    } else {
      prevSpace = false;
    }
  }
  return true;
}

/** ASCII 数字のみの非空文字列か。 */
function isAllDigits(s: string): boolean {
  return s !== "" && [...s].every((ch) => ch >= "0" && ch <= "9");
}
