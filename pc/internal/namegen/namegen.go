// Package namegen は DESIGN-v2 §3.2–§3.6 の filename 純粋処理。I/O は行わない。
// TS 側 (ui/src/filename.ts) と同一規則であり、共有 fixture (test/vectors/filename.json) で一致を固定する。
package namegen

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// NameMaxBytes は name 全体の UTF-8 byte 上限 (§3.2)。
	NameMaxBytes = 255
	// TitleMaxCodePoints は title の code point 上限 (§3.4 step 6)。
	TitleMaxCodePoints = 64
	// TitleMaxBytes は title の UTF-8 byte 上限 (§3.2: 255 − 14 (prefix + '-') − 3 (~NN) − 4 (.txt))。
	TitleMaxBytes = 234
)

// invalidChars は §3.4 step 2 の invalid 文字集合 (/ \ : * ? " < > |)。
const invalidChars = `/\:*?"<>|`

// DeriveTitle は本文 text から title を導出する (§3.4)。Unicode 正規化 (NFKC・改行変換・trim) は行わない。
func DeriveTitle(text string) string {
	// step 1: ASCII whitespace で trim して非空になる最初の行を選ぶ。選ぶのは raw の行。
	line := ""
	found := false
	for _, l := range strings.Split(text, "\n") {
		if asciiTrim(l) != "" {
			line, found = l, true
			break
		}
	}
	if !found {
		return "paste"
	}

	// step 2: 制御文字 (U+0000–U+001F, U+007F) と invalid 文字を削除する (置換ではない。TAB もここで消える)。
	var stripped strings.Builder
	for _, r := range line {
		if r > 0x1f && r != 0x7f && !strings.ContainsRune(invalidChars, r) {
			stripped.WriteRune(r)
		}
	}

	// step 3: ASCII whitespace の連続を U+0020 一つに畳み、前後を削る。Unicode whitespace は対象外。
	var collapsed strings.Builder
	pending := false
	for _, r := range stripped.String() {
		if isAsciiWhitespace(r) {
			pending = true
			continue
		}
		if pending && collapsed.Len() > 0 {
			collapsed.WriteRune(' ')
		}
		pending = false
		collapsed.WriteRune(r)
	}

	// step 4: 先頭の U+0020 / "." / "-" を、いずれかが先頭に存在する限り削る (§3.4)。
	title := stripLeading(collapsed.String())

	// step 5: 空なら "paste"。
	if title == "" {
		return "paste"
	}

	// step 6: 64 code point かつ 234 UTF-8 byte まで code point 境界で切り詰める。
	return string(truncateTitle([]rune(title)))
}

// stripLeading は先頭から U+0020 / "." / "-" を繰り返し削る。集合を一般化しない
// (TrimLeft / TrimLeftFunc 等は使わない)。Unicode whitespace (U+00A0 等) は対象外。
// 対象 3 文字は ASCII 単一 byte のため byte 走査は多 byte 文字の境界を壊さない。
func stripLeading(s string) string {
	i := 0
	for i < len(s) {
		switch s[i] {
		case ' ', '.', '-':
			i++
		default:
			return s[i:]
		}
	}
	return ""
}

// isAsciiWhitespace は §3.4 step 3 の空白集合 (U+0009, U+000A, U+000B, U+000C, U+000D, U+0020)。
func isAsciiWhitespace(r rune) bool {
	return r == 0x09 || r == 0x0a || r == 0x0b || r == 0x0c || r == 0x0d || r == 0x20
}

// asciiTrim は ASCII whitespace のみを前後から削る (Unicode whitespace は残す)。
func asciiTrim(s string) string {
	return strings.Trim(s, "\t\n\v\f\r ")
}

// truncateTitle は上限を満たすまで code point 境界で切り詰める。切断で露出した末尾の
// ASCII whitespace は削る。
func truncateTitle(rs []rune) []rune {
	for len(rs) > TitleMaxCodePoints || runeByteLen(rs) > TitleMaxBytes {
		rs = rs[:len(rs)-1]
		for len(rs) > 0 && isAsciiWhitespace(rs[len(rs)-1]) {
			rs = rs[:len(rs)-1]
		}
	}
	return rs
}

// runeByteLen は rune slice の UTF-8 byte 数。
func runeByteLen(rs []rune) int {
	n := 0
	for _, r := range rs {
		n += utf8.RuneLen(r)
	}
	return n
}

// ParseCapturedAt は client 提供の captured_at ("YYYY-MM-DDTHH:MM:00", §6.4) を検証し、
// filename prefix "YYYYMMDD-HHMM" を返す。未来時刻の拒否・timezone 変換はしない。
func ParseCapturedAt(s string) (string, bool) {
	// "YYYY-MM-DDTHH:MM:00" の完全一致 (秒は常に 00)。位置: 0-3 年, 4 '-', 5-6 月, 7 '-',
	// 8-9 日, 10 'T', 11-12 時, 13 ':', 14-15 分, 16 ':', 17-18 秒。
	if len(s) != 19 {
		return "", false
	}
	for i := range 19 {
		c := s[i]
		var ok bool
		switch i {
		case 4, 7:
			ok = c == '-'
		case 10:
			ok = c == 'T'
		case 13, 16:
			ok = c == ':'
		case 17, 18:
			ok = c == '0'
		default:
			ok = c >= '0' && c <= '9'
		}
		if !ok {
			return "", false
		}
	}
	t, err := time.Parse("2006-01-02T15:04", s[:16])
	if err != nil {
		return "", false
	}
	return t.Format("20060102-1504"), true
}

// CandidateName は §3.5 の candidate 名を組み立てる。
// suffix 0 は付加なし、1–99 は 2 桁 zero-pad (~01…~99)、100 以上は自然桁 (~100…)。
func CandidateName(prefix, title string, suffix int) string {
	if suffix == 0 {
		return prefix + "-" + title + ".txt"
	}
	return prefix + "-" + title + "~" + fmt.Sprintf("%02d", suffix) + ".txt"
}

// IsNameWithinLimit は name 全体が ≤ 255 UTF-8 byte かを返す (§3.2)。
func IsNameWithinLimit(name string) bool {
	return len(name) <= NameMaxBytes
}

// ValidateGeneratedFilename は生成規則 (§3.2–§3.5) の完全検証 (§3.6)。
// 1 つでも違えば false であり、分類上 external 候補になる。
func ValidateGeneratedFilename(name string) bool {
	if !utf8.ValidString(name) || len(name) > NameMaxBytes {
		return false
	}
	const ext = ".txt"
	if !strings.HasSuffix(name, ext) {
		return false
	}
	body := name[:len(name)-len(ext)]
	// prefix: 13 文字 (YYYYMMDD-HHMM) + separator '-'。
	if len(body) < 14 || body[13] != '-' || !validCompact(body[:13]) {
		return false
	}
	rest := body[14:]
	// suffix は rest の末尾の "~" + 数字列。suffix 形を検出したら suffix としてのみ判定し
	// (DESIGN §13.1 の「suffix grammar 不正 → external」)、title への読み替えはしない。
	if i := strings.LastIndexByte(rest, '~'); i >= 0 && isSuffixShaped(rest[i:]) {
		if !validSuffix(rest[i:]) {
			return false
		}
		return validTitle(rest[:i])
	}
	return validTitle(rest)
}

// isSuffixShaped は tail が "~" + 数字列のみの形かを返す (長さ制約は validSuffix が見る)。
func isSuffixShaped(tail string) bool {
	if len(tail) < 2 || tail[0] != '~' {
		return false
	}
	return allDigits(tail[1:])
}

// validSuffix は "~01"… "~99" (2 桁 zero-pad) と "~100"… (3 桁以上・leading zero なし) のみ true。
// "~1" / "~00" / "~010" / "~099" は生成され得ないため false (§3.5)。
func validSuffix(tail string) bool {
	d := tail[1:] // 呼び出し条件: tail は "~" + 数字列
	if d[0] == '0' {
		return len(d) == 2 && d[1] != '0'
	}
	return len(d) == 2 || len(d) >= 3
}

// validCompact は 13 文字 "YYYYMMDD-HHMM" の構造と暦有効性を確認する。
func validCompact(d string) bool {
	if len(d) != 13 || d[8] != '-' {
		return false
	}
	if !allDigits(d[:8]) || !allDigits(d[9:]) {
		return false
	}
	_, err := time.Parse("2006-01-02T15:04", d[0:4]+"-"+d[4:6]+"-"+d[6:8]+"T"+d[9:11]+":"+d[11:13])
	return err == nil
}

// validTitle は title 部分の規則 (§3.4 の生成結果が満たす性質) を検証する。
func validTitle(t string) bool {
	rs := []rune(t)
	if len(rs) == 0 || len(rs) > TitleMaxCodePoints || runeByteLen(rs) > TitleMaxBytes {
		return false
	}
	if rs[0] == '.' || rs[0] == '-' || rs[0] == ' ' || rs[len(rs)-1] == ' ' {
		return false
	}
	prevSpace := false
	for _, r := range rs {
		if r <= 0x1f || r == 0x7f || strings.ContainsRune(invalidChars, r) {
			return false
		}
		if r == ' ' {
			if prevSpace {
				return false
			}
			prevSpace = true
		} else {
			prevSpace = false
		}
	}
	return true
}

// allDigits は ASCII 数字のみの非空文字列かを返す。
func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range []byte(s) {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// IsValidRootDirectChildName は read / delete / list 対象名の safe root-direct-child 検証 (§6.4)。
// 生成 format であることは要求しない (external file も対象)。ValidateGeneratedFilename とは別物。
func IsValidRootDirectChildName(name string) bool {
	if name == "." || name == ".." {
		return false
	}
	if strings.ContainsRune(name, '/') || strings.ContainsRune(name, '\\') || strings.IndexByte(name, 0) >= 0 {
		return false
	}
	if !utf8.ValidString(name) || len(name) > NameMaxBytes {
		return false
	}
	return strings.HasSuffix(name, ".txt")
}
