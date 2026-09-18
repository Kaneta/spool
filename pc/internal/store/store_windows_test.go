//go:build windows

// store_windows_test.go — Windows 固有の directory sync contract test。
// 共通 store contract test は store_test.go。本 file は bug 1 (root handle の
// FlushFileBuffers ACCESS_DENIED) の regression test であり、実 NTFS を使うため
// mock は不要。 FlushFileBuffers の Microsoft contract (HANDLE への GENERIC_WRITE
// 要求) を source-level で固定する。
package store

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// W1: pin した root directory handle は FlushFileBuffers に必要な write access を
// 持つ。openRoot が GENERIC_READ|GENERIC_WRITE で directory を開けていることの証明。
// 非管理者の通常 NTFS (t.TempDir) で success することを直接検証する。
// read-only handle で FlushFileBuffers が ACCESS_DENIED になる対照も通す。
func TestRootHandleFlushable(t *testing.T) {
	s, root := openTestStore(t)

	if err := s.root.sync(); err != nil {
		t.Fatalf("flush pinned root handle: %v (openRoot must open the directory with GENERIC_WRITE)", err)
	}

	// 対照: GENERIC_READ のみの directory handle では ACCESS_DENIED になる。
	// これが ACCESS_DENIED にならない環境 (filesystem が NTFS contract と違う等)
	// では本 test の前提が崩れるため fail させる。
	p, err := windows.UTF16PtrFromString(root)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatalf("open read-only dir handle: %v", err)
	}
	defer windows.CloseHandle(h)
	if err := windows.FlushFileBuffers(h); err != windows.ERROR_ACCESS_DENIED {
		t.Fatalf("read-only dir FlushFileBuffers = %v, want ERROR_ACCESS_DENIED (filesystem must follow NTFS FlushFileBuffers contract)", err)
	}
}

// W2: 正常保存 (publish → directory flush) 全体が SaveSaved になる。
// bug 1 では directory flush の ACCESS_DENIED で正常保存が SaveUncertain に堕ちた。
func TestSaveSavedWithDirFlush(t *testing.T) {
	s, root := openTestStore(t)
	name := testPrefix + "-flush.txt"

	r := s.Save(name, []byte("BODY"))
	if r.State != SaveSaved || r.Err != nil {
		t.Fatalf("save: state=%v err=%v (dir flush must not degrade a normal save)", r.State, r.Err)
	}
	assertNoTempResidue(t, root)
}

// W3: 削除経路 (ntDelete) の open contract。ntOpen は CreateOptions に
// FILE_SYNCHRONOUS_IO_NONALERT を渡すため、DesiredAccess に SYNCHRONIZE が必要
// (WDK NtCreateFile CreateOptions contract)。欠くと NtCreateFile が
// STATUS_INVALID_PARAMETER ("The parameter is incorrect") を返し、temp cleanup も
// record delete も実 NTFS 上で必ず失敗する (bug 2)。temp entry が実際に消えることまで固定する。
func TestClearTempRemovesEntry(t *testing.T) {
	s, root := openTestStore(t)

	temp, f, _, err := s.root.createTemp()
	if err != nil {
		t.Fatalf("createTemp: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close temp: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, temp)); err != nil {
		t.Fatalf("temp must exist before cleanup: %v", err)
	}

	if err := s.root.clearTemp(temp); err != nil {
		t.Fatalf("clearTemp %q: %v (delete open must request SYNCHRONIZE)", temp, err)
	}
	if _, err := os.Stat(filepath.Join(root, temp)); !os.IsNotExist(err) {
		t.Fatalf("temp entry survived clearTemp: %v", err)
	}
}

// W4: ntOpen の open contract の対照。存在する entry に対する
// FILE_SYNCHRONOUS_IO_NONALERT 付きの NtCreateFile は、SYNCHRONIZE なしの DesiredAccess を
// STATUS_INVALID_PARAMETER で拒否し、SYNCHRONIZE を加えると成功する。bug 2 は ntDelete が
// DELETE|FILE_READ_ATTRIBUTES のみを要求していたこと (ntOpen が SYNCHRONIZE を付与して
// いなかったこと) による。ntOpen と同じ parameter 組で直接検証する。
func TestDeleteAccessContract(t *testing.T) {
	s, _ := openTestStore(t)
	temp, f, _, err := s.root.createTemp()
	if err != nil {
		t.Fatalf("createTemp: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close temp: %v", err)
	}

	open := func(access uint32) error {
		ustr, err := windows.NewNTUnicodeString(temp)
		if err != nil {
			t.Fatal(err)
		}
		oa := windows.OBJECT_ATTRIBUTES{
			Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
			RootDirectory: s.root.handle,
			ObjectName:    ustr,
			Attributes:    windows.OBJ_CASE_INSENSITIVE,
		}
		var h windows.Handle
		var iosb windows.IO_STATUS_BLOCK
		st := windows.NtCreateFile(&h, access, &oa, &iosb, nil, 0,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			windows.FILE_OPEN,
			windows.FILE_SYNCHRONOUS_IO_NONALERT|windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT,
			0, 0)
		if st != nil {
			return st
		}
		return windows.CloseHandle(h)
	}

	if err := open(ntDELETE | windows.FILE_READ_ATTRIBUTES); ntStatusOf(err) != ntSTATUS_INVALID_PARAMETER {
		t.Fatalf("open without SYNCHRONIZE = %v, want STATUS_INVALID_PARAMETER", err)
	}
	if err := open(ntDELETE | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE); err != nil {
		t.Fatalf("open with SYNCHRONIZE = %v, want success", err)
	}
}
