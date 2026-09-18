package main

import (
	"fmt"
	"unicode/utf16"
)

// utf16ToUTF8 は LE UTF-16 byte 列 (最初の U+0000 で終端) を UTF-8 へ変換する。
// 入力は clipboard allocation の GlobalSize で切り取った byte 列であり、これ以上の
// 読み出しは行わない (memory bound は呼び出し側で保証)。末尾の奇数 byte は無視する。
// NUL が範囲内に無い場合は clipboard allocation が壊れているとして error。
func utf16ToUTF8(data []byte) ([]byte, error) {
	n := len(data) - len(data)%2
	elems := make([]uint16, n/2)
	for i := 0; i < n/2; i++ {
		elems[i] = uint16(data[2*i]) | uint16(data[2*i+1])<<8
	}
	end := -1
	for i, r := range elems {
		if r == 0 {
			end = i
			break
		}
	}
	if end < 0 {
		return nil, fmt.Errorf("clipboard text is not NUL terminated")
	}
	return []byte(string(utf16.Decode(elems[:end]))), nil
}
