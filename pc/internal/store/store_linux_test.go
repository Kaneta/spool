//go:build linux

// store_linux_test.go — Linux syscall 固有の境界 test。
// 共通 store contract test は store_test.go。本 file は dirfd を直接扱う閉じ込め証明と、
// Unix 特有の special file (FIFO) の扱いを固定する。
package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// G: dirfd pinning の閉じ込め証明。root path を rename しても pin した dirfd は元 inode を指し、
// dirfd 相対操作は rename 後の位置 (元 inode 配下) で完結し、別 path へ飛ばない。
func TestDirfdFollowsRenamedRoot(t *testing.T) {
	s, root := openTestStore(t)
	renamed := root + "-moved"
	if err := os.Rename(root, renamed); err != nil {
		t.Fatal(err)
	}

	fd, err := unix.Openat(s.root.dirfd, "pinned.txt", unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_CLOEXEC, 0o644)
	if err != nil {
		t.Fatalf("openat via pinned dirfd: %v", err)
	}
	if _, err := unix.Write(fd, []byte("PINNED")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Close(fd); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(filepath.Join(renamed, "pinned.txt"))
	if err != nil || string(got) != "PINNED" {
		t.Fatalf("dirfd-relative write escaped: %q err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(root, "pinned.txt")); !os.IsNotExist(err) {
		t.Fatalf("old path should not exist: %v", err)
	}
}

// J: directory / FIFO を record として扱わない。O_NONBLOCK により FIFO open で停止しない。
func TestSpecialFilesNotRecords(t *testing.T) {
	s, root := openTestStore(t)

	if err := os.Mkdir(filepath.Join(root, "sub.txt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(root, "pipe.txt"), 0o644); err != nil {
		t.Fatal(err)
	}

	infos, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("special files listed: %v", infos)
	}
	for _, name := range []string{"sub.txt", "pipe.txt"} {
		if _, err := s.Read(name); !errors.Is(err, ErrInvalidName) {
			t.Fatalf("read %q: %v, want ErrInvalidName", name, err)
		}
		if err := s.Delete(name); !errors.Is(err, ErrInvalidName) {
			t.Fatalf("delete %q: %v, want ErrInvalidName", name, err)
		}
	}
	// 対象外扱いでも entry は削除していない (削除は明示操作の対象外)
	if _, err := os.Lstat(filepath.Join(root, "pipe.txt")); err != nil {
		t.Fatalf("fifo entry must survive: %v", err)
	}
}
