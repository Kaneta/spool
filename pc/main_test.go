package main

// --init 契約の test (M2 Unit 4 §14)。実 filesystem (t.TempDir) を使う。

import (
	"os"
	"path/filepath"
	"testing"
)

// A: parent exists / root missing / --init → root を 1 個だけ作る。
func TestEnsureRootCreatesWithInit(t *testing.T) {
	root := filepath.Join(t.TempDir(), "spool")
	if err := ensureRoot(root, true); err != nil {
		t.Fatalf("ensureRoot: %v", err)
	}
	st, err := os.Stat(root)
	if err != nil || !st.IsDir() {
		t.Fatalf("root not created as directory: %v", err)
	}
}

// B: parent missing / --init → error。中間 directory は作られていない。
func TestEnsureRootFailsOnMissingParent(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "no", "such", "spool")
	if err := ensureRoot(root, true); err == nil {
		t.Fatal("expected error when parent is missing")
	}
	if _, err := os.Stat(filepath.Join(base, "no")); !os.IsNotExist(err) {
		t.Fatalf("intermediate directory was created: %v", err)
	}
}

// C: root missing / no --init → error。自動作成しない。
func TestEnsureRootFailsWithoutInit(t *testing.T) {
	root := filepath.Join(t.TempDir(), "spool")
	if err := ensureRoot(root, false); err == nil {
		t.Fatal("expected error without --init")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("root was created without --init: %v", err)
	}
}

// D: root already directory → そのまま利用 (--init でも破壊・再作成しない)。
func TestEnsureRootUsesExistingDirectory(t *testing.T) {
	root := t.TempDir()
	keep := filepath.Join(root, "keep.txt")
	if err := os.WriteFile(keep, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := ensureRoot(root, true); err != nil {
		t.Fatalf("ensureRoot with --init: %v", err)
	}
	if err := ensureRoot(root, false); err != nil {
		t.Fatalf("ensureRoot without --init: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("existing content touched: %v", err)
	}
}

// E: root is regular file → error。
func TestEnsureRootFailsOnFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "afile")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := ensureRoot(path, true); err == nil {
		t.Fatal("expected error when root is a regular file")
	}
}
