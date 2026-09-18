package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestUTF16ToUTF8(t *testing.T) {
	le := func(units ...uint16) []byte {
		b := make([]byte, 0, len(units)*2)
		for _, u := range units {
			b = append(b, byte(u), byte(u>>8))
		}
		return b
	}
	tests := []struct {
		name    string
		in      []byte
		want    string
		wantErr bool
	}{
		{name: "ascii", in: le('h', 'i', 0), want: "hi"},
		{name: "japanese", in: le(0x3053, 0x3093, 0x306b, 0x3061, 0x306f, 0), want: "こんにちは"},
		{name: "empty text (leading NUL is valid)", in: le(0), want: ""},
		{name: "NUL beyond allocation bound", in: le('a', 'b'), wantErr: true},
		{name: "NUL in odd trailing byte ignored", in: append(le('a', 0), 0x55), want: "a"},
		{name: "lone surrogate becomes U+FFFD not error", in: le(0xD800, 'x', 0), want: "\uFFFDx"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := utf16ToUTF8(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("want error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if string(got) != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestResolveSpoolExeSiblingPreferred(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "spool.exe")
	if err := os.WriteFile(sibling, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := siblingOrPath(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != sibling {
		t.Fatalf("got %q, want sibling %q", got, sibling)
	}
}

func TestRunChildExitPropagation(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh unavailable")
	}
	tests := []struct {
		script string
		want   int
	}{
		{"exit 0", 0},
		{"exit 1", 1},
		{"exit 2", 2},
	}
	for _, tt := range tests {
		code, err := runChild(sh, []string{"-c", tt.script}, []byte{})
		if err != nil {
			t.Fatalf("%s: %v", tt.script, err)
		}
		if code != tt.want {
			t.Fatalf("script %q: exit %d, want %d", tt.script, code, tt.want)
		}
	}
}

func TestRunChildStartFailure(t *testing.T) {
	_, err := runChild(filepath.Join(t.TempDir(), "no-such-exe"), []string{"add"}, []byte{})
	if err == nil {
		t.Fatal("want error for unstartable child")
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		t.Fatalf("start failure must not look like child exit: %v", err)
	}
}
