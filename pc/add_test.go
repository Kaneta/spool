package main

// `spool add` 契約の test (実 filesystem は t.TempDir)。TTY 本体経路は pty smoke で
// 確認するため、ここでは terminal 判定の negative と非 terminal stdin の保存を固定する。

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"spool/internal/namegen"
	"spool/internal/textcheck"
)

// runAddTest は --root root 付きで runAdd を実行し、exit code と stdout / stderr を返す。
func runAddTest(t *testing.T, root, stdin string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := runAdd([]string{"--root", root}, strings.NewReader(stdin), &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

// A: 通常保存。exit 0、stdout は filename 1 行のみ、file byte は stdin 全文と一致
// (trim / 改行追加 / normalization なし)。
func TestAddSavesStdinText(t *testing.T) {
	root := t.TempDir()
	code, out, errOut := runAddTest(t, root, "hello\n")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, errOut)
	}
	name := strings.TrimSpace(out)
	if name == "" || strings.ContainsAny(name, " \n") {
		t.Fatalf("stdout is not a single filename: %q", out)
	}
	if !namegen.ValidateGeneratedFilename(name) {
		t.Fatalf("stdout is not a valid generated filename: %q", out)
	}
	data, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if string(data) != "hello\n" {
		t.Fatalf("content mismatch: %q", data)
	}
}

// B: empty stdin は有効。空本文は既存規則で "paste" title。
func TestAddEmptyStdinUsesPasteTitle(t *testing.T) {
	root := t.TempDir()
	code, out, errOut := runAddTest(t, root, "")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, errOut)
	}
	name := strings.TrimSpace(out)
	if !strings.HasSuffix(name, "-paste.txt") {
		t.Fatalf("name %q does not use paste title", name)
	}
	data, err := os.ReadFile(filepath.Join(root, name))
	if err != nil || len(data) != 0 {
		t.Fatalf("empty text not saved as-is: %v %q", err, data)
	}
}

// C: 同一 prefix / title の連続保存は suffix で衝突解決 (base / ~01)。overwrite なし。
func TestAddSuffixCollision(t *testing.T) {
	root := t.TempDir()
	code1, out1, errOut1 := runAddTest(t, root, "hello\n")
	if code1 != 0 {
		t.Fatalf("first: exit=%d stderr=%q", code1, errOut1)
	}
	code2, out2, errOut2 := runAddTest(t, root, "hello\n")
	if code2 != 0 {
		t.Fatalf("second: exit=%d stderr=%q", code2, errOut2)
	}
	first := strings.TrimSpace(out1)
	second := strings.TrimSpace(out2)
	if first == second {
		t.Fatalf("same name reused: %q", first)
	}
	if want := strings.TrimSuffix(first, ".txt") + "~01.txt"; second != want {
		t.Fatalf("second name %q, want %q", second, want)
	}
	data, err := os.ReadFile(filepath.Join(root, first))
	if err != nil || string(data) != "hello\n" {
		t.Fatalf("first file touched: %v %q", err, data)
	}
}

// D: 上限超過は failed (too_large)。file は作られない。
func TestAddTooLargeFails(t *testing.T) {
	root := t.TempDir()
	big := string(bytes.Repeat([]byte("a"), textcheck.MaxTextBytes+1))
	code, _, errOut := runAddTest(t, root, big)
	if code != 1 {
		t.Fatalf("exit=%d stderr=%q", code, errOut)
	}
	if !strings.HasPrefix(errOut, "failed: too_large: ") {
		t.Fatalf("stderr=%q", errOut)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("root not empty: %v", err)
	}
}

// E: invalid UTF-8 は failed (invalid_input)。file は作られない。
func TestAddInvalidUTF8Fails(t *testing.T) {
	root := t.TempDir()
	code, _, errOut := runAddTest(t, root, "\xff\xfe")
	if code != 1 {
		t.Fatalf("exit=%d stderr=%q", code, errOut)
	}
	if !strings.HasPrefix(errOut, "failed: invalid_input: ") {
		t.Fatalf("stderr=%q", errOut)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("root not empty: %v", err)
	}
}

// F: root 不在は failed (root_missing)。自動作成しない。
func TestAddRootMissingFailsWithoutCreate(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nope")
	code, _, errOut := runAddTest(t, root, "hello\n")
	if code != 1 {
		t.Fatalf("exit=%d stderr=%q", code, errOut)
	}
	if !strings.HasPrefix(errOut, "failed: root_missing: ") {
		t.Fatalf("stderr=%q", errOut)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("root was created: %v", err)
	}
}

// G: null device (os.DevNull) は terminal でないため、char device stdin でも空本文を保存する。
// 真の TTY (stdin_required) 経路は pty smoke で確認する。
func TestAddDevNullStdinSavesEmpty(t *testing.T) {
	root := t.TempDir()
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Skipf("null device unavailable: %v", err)
	}
	defer f.Close()
	if isTerminal(f) {
		t.Fatal("/dev/null misdetected as terminal")
	}
	var stdout, stderr bytes.Buffer
	code := runAdd([]string{"--root", root}, f, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr.String())
	}
	if !strings.HasSuffix(strings.TrimSpace(stdout.String()), "-paste.txt") {
		t.Fatalf("stdout=%q", stdout.String())
	}
}

// H: 並行 add は suffix で解決し、overwrite しない。全 worker の保存が成功し、
// 名前は一意で、各 file が自 worker の本文を保持する。
func TestAddConcurrentNoOverwrite(t *testing.T) {
	root := t.TempDir()
	const n = 4
	var wg sync.WaitGroup
	names := make([]string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var stdout, stderr bytes.Buffer
			code := runAdd([]string{"--root", root}, strings.NewReader("hello\n"), &stdout, &stderr)
			if code != 0 {
				t.Errorf("worker %d: exit=%d stderr=%q", i, code, stderr.String())
				return
			}
			names[i] = strings.TrimSpace(stdout.String())
		}(i)
	}
	wg.Wait()
	seen := map[string]bool{}
	for i, name := range names {
		if name == "" {
			t.Fatalf("worker %d has no name", i)
		}
		if seen[name] {
			t.Fatalf("duplicate name %q", name)
		}
		seen[name] = true
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(data) != "hello\n" {
			t.Fatalf("file %s: %v %q", name, err, data)
		}
	}
}

// I: positional 引数は拒否 (positional text は存在しない)。file は作られない。
func TestAddRejectsPositionalArgs(t *testing.T) {
	root := t.TempDir()
	var stdout, stderr bytes.Buffer
	code := runAdd([]string{"--root", root, "text"}, strings.NewReader(""), &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit=%d stderr=%q", code, stderr.String())
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("root not empty: %v", err)
	}
}
