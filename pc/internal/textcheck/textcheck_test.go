package textcheck

import (
	"errors"
	"strings"
	"testing"
)

func TestCheckAcceptsValidText(t *testing.T) {
	for _, text := range []string{"", "hello", "こんにちは", "😀"} {
		if err := Check([]byte(text)); err != nil {
			t.Fatalf("Check(%q) = %v, want nil", text, err)
		}
	}
}

func TestCheckAcceptsBoundarySize(t *testing.T) {
	text := []byte(strings.Repeat("a", MaxTextBytes))
	if err := Check(text); err != nil {
		t.Fatalf("Check(%d byte) = %v, want nil", len(text), err)
	}
}

func TestCheckRejectsTooLarge(t *testing.T) {
	text := []byte(strings.Repeat("a", MaxTextBytes+1))
	err := Check(text)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Check(%d byte) = %v, want ErrTooLarge", len(text), err)
	}
}

func TestCheckRejectsInvalidUTF8(t *testing.T) {
	err := Check([]byte{0xff, 0xfe})
	if !errors.Is(err, ErrNotUTF8) {
		t.Fatalf("Check(invalid utf-8) = %v, want ErrNotUTF8", err)
	}
}
