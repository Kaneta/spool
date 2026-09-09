// Package textcheck は本文 text の最小検証 (§6.4)。変換・正規化は行わない。
// PROVISIONAL の上限 (DESIGN-v2 §17-2) は定数 1 つに隔離し、wire format や型構造へ埋め込まない。
package textcheck

import (
	"errors"
	"fmt"
	"unicode/utf8"
)

// MaxTextBytes は本文の UTF-8 byte 上限 (**PROVISIONAL**, §17-2)。確定は製品判断。
const MaxTextBytes = 256 * 1024

var (
	// ErrNotUTF8 は本文が有効な UTF-8 でない場合の sentinel error。
	ErrNotUTF8 = errors.New("text is not valid UTF-8")
	// ErrTooLarge は本文が上限を超えた場合の sentinel error。
	ErrTooLarge = errors.New("text exceeds limit")
)

// Check は本文が有効 UTF-8 かつ上限内であることだけを検証する。
func Check(text []byte) error {
	if !utf8.Valid(text) {
		return ErrNotUTF8
	}
	if len(text) > MaxTextBytes {
		return fmt.Errorf("%w: %d byte > %d byte", ErrTooLarge, len(text), MaxTextBytes)
	}
	return nil
}
