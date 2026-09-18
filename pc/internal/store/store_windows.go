//go:build windows

// store_windows.go — Windows 向け store primitive (DESIGN-v2 §6.6–§6.7)。
// 閉じ込めは pin した root directory handle を RootDirectory に指定した NtCreateFile
// (directory-relative open) で成立させる。Win32 の path-based API は record 操作に使わない。
// root path を使うのは openRoot と changed (rootChanged 検出) のみである。
package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// x/sys/windows が export していない NT 定数 (アクセス権 / FILE_INFORMATION_CLASS / NTSTATUS)。
const (
	ntDELETE = 0x00010000

	// FILE_INFORMATION_CLASS (wdm ne-wdm-_file_information_class)。
	// NtQueryInformationFile / NtSetInformationFile / NtQueryDirectoryFile の番号体系であり、
	// kernel32 GetFileInformationByHandleEx の FILE_INFO_BY_HANDLE_CLASS (FileStandardInfo=1,
	// FileAttributeTagInfo=9, FileIdInfo=18, …) とは別物。名前が似ていても流用しない。
	ntFileDirectoryInformation    = 1  // FileDirectoryInformation
	ntFileStandardInformation     = 5  // FileStandardInformation
	ntFileRenameInformation       = 10 // FileRenameInformation
	ntFileDispositionInformation  = 13 // FileDispositionInformation
	ntFileAttributeTagInformation = 35 // FileAttributeTagInformation
	ntFileIdInformation           = 59 // FileIdInformation (Win7+)

	ntSTATUS_INVALID_PARAMETER     windows.NTStatus = 0xC000000D
	ntSTATUS_NO_SUCH_FILE          windows.NTStatus = 0xC000000F
	ntSTATUS_OBJECT_NAME_INVALID   windows.NTStatus = 0xC0000033
	ntSTATUS_OBJECT_NAME_NOT_FOUND windows.NTStatus = 0xC0000034
	ntSTATUS_OBJECT_NAME_COLLISION windows.NTStatus = 0xC0000035
	ntSTATUS_OBJECT_PATH_NOT_FOUND windows.NTStatus = 0xC000003A
	ntSTATUS_DELETE_PENDING        windows.NTStatus = 0xC0000056
	ntSTATUS_FILE_IS_A_DIRECTORY   windows.NTStatus = 0xC00000BA
	ntSTATUS_NO_MORE_FILES         windows.NTStatus = 0x80000006
)

// ntFileIDInfo は FILE_ID_INFO (NtQueryInformationFile FileIdInformation の応答)。
// Linux の dev/ino 相当の正体識別子。
type ntFileIDInfo struct {
	VolumeSerialNumber uint64
	FileId             [16]byte
}

// ntAttrTagInfo は FILE_ATTRIBUTE_TAG_INFORMATION。
type ntAttrTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// ntStandardInfo は FILE_STANDARD_INFORMATION。EndOfFile = 本文の byte 数。
type ntStandardInfo struct {
	AllocationSize int64
	EndOfFile      int64
	NumberOfLinks  uint32
	DeletePending  uint32
	Directory      uint32
}

// ntRenameInfo は FILE_RENAME_INFORMATION (x64 layout)。RootDirectory を pin に指定すると
// FileName は pin 相対で解釈され、root path を再解決しない閉じ込めが保たれる。
// ReplaceIfExists = FALSE で既存名との衝突は STATUS_OBJECT_NAME_COLLISION になる。
type ntRenameInfo struct {
	ReplaceIfExists uint32
	_               uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32 // FileName の byte 数 (NUL なし)
	FileName        [256]uint16
}

// ntDispositionInfo は FILE_DISPOSITION_INFORMATION (NT ABI)。BOOLEAN DeleteFile の 1 byte
// struct であり、NtSetInformationFile へ渡す Length も 1 byte にする。長さは class ごとの
// 要求長と一致している必要があり (MS-FSCC 2.4.11: DeletePending は 1 byte、不一致は
// STATUS_INFO_LENGTH_MISMATCH)、Win32 の FILE_DISPOSITION_INFO / 32-bit BOOL とは別物として
// 扱う。
type ntDispositionInfo struct {
	DeleteFile uint8
}

// ntStatusOf は Nt* wrapper の返す error を NTSTATUS へ戻す (成功は nil → 0)。
func ntStatusOf(err error) windows.NTStatus {
	if s, ok := err.(windows.NTStatus); ok {
		return s
	}
	return 0
}

func ntIsNotFound(s windows.NTStatus) bool {
	switch s {
	case ntSTATUS_NO_SUCH_FILE, ntSTATUS_OBJECT_NAME_NOT_FOUND, ntSTATUS_OBJECT_PATH_NOT_FOUND:
		return true
	}
	return false
}

func ntIsCollision(s windows.NTStatus) bool {
	return s == ntSTATUS_OBJECT_NAME_COLLISION
}

func ntIsInvalid(s windows.NTStatus) bool {
	return s == ntSTATUS_FILE_IS_A_DIRECTORY || s == ntSTATUS_OBJECT_NAME_INVALID
}

// ntErr は NTSTATUS を error 化する (RtlNtStatusToDosError で DOS code に写像)。
func ntErr(s windows.NTStatus) error {
	if s == 0 {
		return nil
	}
	dos, _, _ := ntRtlNtStatusToDosError.Call(uintptr(s))
	if dos == 0 {
		return fmt.Errorf("ntstatus 0x%08x", uint32(s))
	}
	return syscall.Errno(dos)
}

var (
	ntdll                   = syscall.NewLazyDLL("ntdll.dll")
	ntRtlNtStatusToDosError = ntdll.NewProc("RtlNtStatusToDosError")
	ntNtQueryDirectoryFile  = ntdll.NewProc("NtQueryDirectoryFile")
)

// fileID は record file の正体 (volume serial + 128-bit file id)。Linux の dev/ino 相当。
type fileID struct {
	Volume uint64
	ID     [16]byte
}

// sameID は 2 つの fileID が同一 file を指すか。
func sameID(a, b fileID) bool {
	return a.Volume == b.Volume && a.ID == b.ID
}

// rootDir は pin した root directory handle。全 record 操作はこの handle を RootDirectory
// に指定した NtCreateFile で行う (path を組み立てない)。path は changed (rootChanged
// 検出, best-effort) のみで使う。
type rootDir struct {
	handle windows.Handle
	path   string
}

// openRoot は既存 root directory を開いて pin する。root の作成は行わない。
// Win32 path をそのまま渡すため相対 path は CWD 基準 (Linux の unix.Open と同形)。
// directory 以外も open できてしまうため、attributes で directory 確認する (ENOTDIR 相当)。
// access は GENERIC_READ|GENERIC_WRITE (dwDesiredAccess): FlushFileBuffers (§6.6 step 6)
// は HANDLE への GENERIC_WRITE を要求する (Microsoft contract)。GENERIC_READ のみの
// directory handle では FlushFileBuffers が ACCESS_DENIED になり、正常保存まで
// uncertain に堕ちる。directory の write access 開放には FILE_FLAG_BACKUP_SEMANTICS が
// 必要であり、非管理者の通常 NTFS directory で成功する (実機 probe 済み)。
// pin 相対 operation (RootDirectory) は handle の access mask に依存しないため、
// root pinning / relative operation / confinement の意味は変わらない。
func openRoot(rootPath string) (*rootDir, error) {
	p, err := windows.UTF16PtrFromString(rootPath)
	if err != nil {
		return nil, fmt.Errorf("%w: open %q: %v", ErrIO, rootPath, err)
	}
	h, err := windows.CreateFile(p,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return nil, fmt.Errorf("%w: %q: %v", ErrRootMissing, rootPath, err)
		}
		return nil, fmt.Errorf("%w: open %q: %v", ErrIO, rootPath, err)
	}
	attrs, _, err := queryAttrTag(h)
	if err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%w: attributes %q: %v", ErrIO, rootPath, err)
	}
	if attrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%w: %q: not a directory", ErrRootMissing, rootPath)
	}
	return &rootDir{handle: h, path: rootPath}, nil
}

// close は pin した root directory handle を閉じる。
func (d *rootDir) close() error {
	return windows.CloseHandle(d.handle)
}

// changed は root path の消失・置換を検出する (§6.2)。path で開いた handle の file id と
// pin の file id を比較する。race-free 保証ではなく best-effort の UX 要求であり、
// 閉じ込めの成立条件ではない (閉じ込めは RootDirectory 相対操作自体で成立)。
func (d *rootDir) changed() error {
	id, err := fileIDOfHandle(d.handle)
	if err != nil {
		return fmt.Errorf("%w: file id: %v", ErrIO, err)
	}
	p, err := windows.UTF16PtrFromString(d.path)
	if err != nil {
		return fmt.Errorf("%w: %q: %v", ErrRootMissing, d.path, err)
	}
	h, err := windows.CreateFile(p,
		windows.FILE_GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return fmt.Errorf("%w: %q: %v", ErrRootMissing, d.path, err)
		}
		return fmt.Errorf("%w: stat %q: %v", ErrIO, d.path, err)
	}
	defer windows.CloseHandle(h)
	other, err := fileIDOfHandle(h)
	if err != nil {
		return fmt.Errorf("%w: stat %q: %v", ErrIO, d.path, err)
	}
	if !sameID(id, other) {
		return ErrRootChanged
	}
	return nil
}

// names は root 直下の全 entry 名を返す (読み順不定。List が sort する)。
// NtQueryDirectoryFile を pin した handle で行う (path 再解決なし)。
// NTSTATUS が STATUS_NO_MORE_FILES 以外の error なら partial list を正常な完全一覧と
// して返さず error を返す (§6.7)。
func (d *rootDir) names() ([]string, error) {
	const bufLen = 64 * 1024
	buf := make([]byte, bufLen)
	var names []string
	restart := uint8(1)
	for {
		var iosb windows.IO_STATUS_BLOCK
		r1, _, _ := ntNtQueryDirectoryFile.Call(
			uintptr(d.handle), 0, 0, 0, uintptr(unsafe.Pointer(&iosb)),
			uintptr(unsafe.Pointer(&buf[0])), bufLen,
			ntFileDirectoryInformation, 0 /*ReturnSingleEntry*/, 0 /*FileName*/, uintptr(restart),
		)
		st := windows.NTStatus(r1)
		if st == ntSTATUS_NO_MORE_FILES {
			break
		}
		if st != 0 {
			return nil, fmt.Errorf("%w: readdir: %v", ErrIO, ntErr(st))
		}
		restart = 0
		walk := buf
		for {
			// FileDirectoryInformation: NextEntryOffset @0, FileNameLength @60, FileName @64。
			if len(walk) < 64 {
				break
			}
			next := *(*uint32)(unsafe.Pointer(&walk[0]))
			nameLen := *(*uint32)(unsafe.Pointer(&walk[60]))
			if nameLen == 0 {
				break
			}
			entry := windows.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&walk[64])), nameLen/2))
			if entry != "." && entry != ".." {
				names = append(names, entry)
			}
			if next == 0 {
				break
			}
			walk = walk[next:]
		}
	}
	return names, nil
}

// ntOpen は pin 相対の directory-relative open (openat 相当)。
// name は既に validator を通過した単一 component である。access は caller が要求する
// specific access (delete なら ntDELETE 等)。本関数は常に FILE_SYNCHRONOUS_IO_NONALERT を
// CreateOptions に渡すため、SYNCHRONIZE は本関数が付与する (caller に要求しない)。
func ntOpen(root windows.Handle, name string, access uint32, disposition uint32, options uint32) (windows.Handle, error) {
	// Microsoft contract (WDK NtCreateFile CreateOptions): FILE_SYNCHRONOUS_IO_NONALERT を
	// 指定する場合、DesiredAccess に SYNCHRONIZE が必要。欠くと NtCreateFile は
	// STATUS_INVALID_PARAMETER ("The parameter is incorrect") を返し、name の存在に関わらず
	// open が失敗する。FILE_GENERIC_READ / FILE_GENERIC_WRITE は SYNCHRONIZE を含むため
	// read / write 経路だけが通っていた (delete 経路が DELETE|FILE_READ_ATTRIBUTES のみを
	// 要求して実機で失敗した)。
	access |= windows.SYNCHRONIZE

	ustr, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, ntSTATUS_INVALID_PARAMETER
	}
	oa := windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: root,
		ObjectName:    ustr,
		Attributes:    windows.OBJ_CASE_INSENSITIVE,
	}
	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	if st := windows.NtCreateFile(&h, access, &oa, &iosb, nil, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		disposition, options, 0, 0); st != nil {
		return 0, st
	}
	return h, nil
}

// fileIDOfHandle は開いた handle の fileID を得る (§6.6 step 4 の補助検証に使う)。
func fileIDOfHandle(h windows.Handle) (fileID, error) {
	var info ntFileIDInfo
	var iosb windows.IO_STATUS_BLOCK
	st := windows.NtQueryInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)), uint32(ntFileIdInformation))
	if st != nil {
		return fileID{}, ntErr(ntStatusOf(st))
	}
	return fileID{Volume: info.VolumeSerialNumber, ID: info.FileId}, nil
}

// queryAttrTag は handle の attributes と reparse tag を得る。
func queryAttrTag(h windows.Handle) (uint32, uint32, error) {
	var info ntAttrTagInfo
	var iosb windows.IO_STATUS_BLOCK
	st := windows.NtQueryInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)), uint32(ntFileAttributeTagInformation))
	if st != nil {
		return 0, 0, ntErr(ntStatusOf(st))
	}
	return info.FileAttributes, info.ReparseTag, nil
}

// querySize は handle の本文 byte 数 (FileStandardInformation EndOfFile) を得る。
func querySize(h windows.Handle) (int64, error) {
	var info ntStandardInfo
	var iosb windows.IO_STATUS_BLOCK
	st := windows.NtQueryInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)), uint32(ntFileStandardInformation))
	if st != nil {
		return 0, ntErr(ntStatusOf(st))
	}
	return info.EndOfFile, nil
}

func ntIsReparse(attrs uint32) bool {
	return attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

func ntIsDirectory(attrs uint32) bool {
	return attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0
}

// errNotRegular は「no-follow open は成功したが record として扱えない」ことを表す内部
// sentinel (reparse point / directory)。errNotRecord / ErrInvalidName への写像は caller が行う。
var errNotRegular = errors.New("not a regular record file")

// ntOpenRegular は pin 相対で name を no-follow で開き、regular file のみ受け付ける (§6.7)。
// reparse point (symlink / junction) は FILE_OPEN_REPARSE_POINT で本体を開いた上で属性検査
// で拒否する (Linux の O_NOFOLLOW + ELOOP と同形: 指す先には届かない)。
func ntOpenRegular(root windows.Handle, name string, access uint32) (windows.Handle, error) {
	h, st := ntOpen(root, name, access, windows.FILE_OPEN,
		windows.FILE_SYNCHRONOUS_IO_NONALERT|windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT)
	if st != nil {
		return 0, st
	}
	attrs, _, err := queryAttrTag(h)
	if err != nil {
		windows.CloseHandle(h)
		return 0, err
	}
	if ntIsReparse(attrs) || ntIsDirectory(attrs) {
		windows.CloseHandle(h)
		return 0, errNotRegular
	}
	return h, nil
}

// statRegular は pin 相対で name を no-follow で開き、regular file のみを受け付ける (§6.7)。
// 消失 / reparse / directory は errNotRecord。
func (d *rootDir) statRegular(name string) (fileID, int64, error) {
	h, err := ntOpenRegular(d.handle, name, windows.FILE_GENERIC_READ)
	if err != nil {
		if errors.Is(err, errNotRegular) || ntIsNotFound(ntStatusOf(err)) || ntIsInvalid(ntStatusOf(err)) {
			return fileID{}, 0, errNotRecord
		}
		return fileID{}, 0, fmt.Errorf("%w: openat %q: %v", ErrIO, name, err)
	}
	defer windows.CloseHandle(h)
	id, err := fileIDOfHandle(h)
	if err != nil {
		return fileID{}, 0, fmt.Errorf("%w: fstat %q: %v", ErrIO, name, err)
	}
	size, err := querySize(h)
	if err != nil {
		return fileID{}, 0, fmt.Errorf("%w: fstat %q: %v", ErrIO, name, err)
	}
	return id, size, nil
}

// openRegular は pin 相対で name を no-follow で開き、regular file のみ受け付ける (§6.7)。
// 消失 → ErrNotFound、reparse / 非 regular → ErrInvalidName。
// 返す *os.File は open 時点の inode に閉じている。
func (d *rootDir) openRegular(name string) (*os.File, error) {
	h, err := ntOpenRegular(d.handle, name, windows.FILE_GENERIC_READ)
	if err != nil {
		if errors.Is(err, errNotRegular) {
			return nil, fmt.Errorf("%w: %q: not a regular file", ErrInvalidName, name)
		}
		st := ntStatusOf(err)
		switch {
		case ntIsNotFound(st):
			return nil, fmt.Errorf("%w: %q: %v", ErrNotFound, name, ntErr(st))
		case ntIsInvalid(st):
			return nil, fmt.Errorf("%w: %q: %v", ErrInvalidName, name, ntErr(st))
		default:
			return nil, fmt.Errorf("%w: openat %q: %v", ErrIO, name, ntErr(st))
		}
	}
	return os.NewFile(uintptr(h), name), nil
}

// unlinkRegular は pin 直下の指定 name entry を削除する (§6.7, §6.8)。no-follow で
// regular 確認後、FileDispositionInformation(DeleteFile) を設定し close で削除。
// symlink を追って指す先を消す経路は存在しない。delete 中の外部変更 (rename 済み等) は
// not_found で終了し追跡しない (§6.8)。
func (d *rootDir) unlinkRegular(name string) error {
	return ntDelete(d.handle, name)
}

// ntDelete は pin 相対で name の entry を削除する (record delete と temp cleanup の共通部)。
// temp cleanup では、自 Save invocation が閉じるべき temp の lifecycle の最終 step であり、
// 失敗 (STATUS_DELETE_PENDING 含む) は caller へ伝搬して隠さない。
func ntDelete(root windows.Handle, name string) error {
	h, err := ntOpenRegular(root, name, ntDELETE|windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		if errors.Is(err, errNotRegular) {
			return fmt.Errorf("%w: %q: not a regular file", ErrInvalidName, name)
		}
		st := ntStatusOf(err)
		switch {
		case ntIsNotFound(st):
			return fmt.Errorf("%w: %q: %v", ErrNotFound, name, ntErr(st))
		case st == ntSTATUS_DELETE_PENDING:
			// 前段 handle の close が未完了で削除予約中。temp lifecycle としては
			// 消滅が確定しているため not-found 同等 (cleanup 完了)。
			return fmt.Errorf("%w: %q: delete pending", ErrNotFound, name)
		case ntIsInvalid(st):
			return fmt.Errorf("%w: %q: %v", ErrInvalidName, name, ntErr(st))
		default:
			return fmt.Errorf("%w: unlinkat %q: %v", ErrIO, name, ntErr(st))
		}
	}
	defer windows.CloseHandle(h)
	// 他 process が排他 open している場合、設定自体が失敗するか close 時に失敗する。
	var disp ntDispositionInfo
	disp.DeleteFile = 1
	var iosb windows.IO_STATUS_BLOCK
	if st := windows.NtSetInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&disp)),
		uint32(unsafe.Sizeof(disp)), uint32(ntFileDispositionInformation)); st != nil {
		return fmt.Errorf("%w: unlinkat %q: %v", ErrIO, name, ntErr(ntStatusOf(st)))
	}
	return nil
}

// createTemp は pin 相対で .spool-tmp-<16hex> を create-only (FILE_CREATE) で作る
// (§6.6 step 2)。同名衝突は新 random 名で再試行する (無制限な抽象 retry framework は
// 作らない)。write access を持つ handle を *os.File として返す (close 責務は caller)。
func (d *rootDir) createTemp() (string, *os.File, fileID, error) {
	for range 8 {
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", nil, fileID{}, fmt.Errorf("%w: temp name: %v", ErrIO, err)
		}
		temp := ".spool-tmp-" + hex.EncodeToString(b[:])
		h, st := ntOpen(d.handle, temp,
			windows.FILE_GENERIC_WRITE|ntDELETE,
			windows.FILE_CREATE,
			windows.FILE_SYNCHRONOUS_IO_NONALERT|windows.FILE_NON_DIRECTORY_FILE)
		if ntIsCollision(ntStatusOf(st)) {
			continue
		}
		if st != nil {
			return "", nil, fileID{}, fmt.Errorf("%w: create temp: %v", ErrIO, ntErr(ntStatusOf(st)))
		}
		id, err := fileIDOfHandle(h)
		if err != nil {
			windows.CloseHandle(h)
			return "", nil, fileID{}, fmt.Errorf("%w: fstat temp: %v", ErrIO, err)
		}
		return temp, os.NewFile(uintptr(h), temp), id, nil
	}
	return "", nil, fileID{}, fmt.Errorf("%w: temp name collision", ErrIO)
}

// publish は flush 済み temp を final name で create-only に公開する (§6.6 step 3)。
// NtSetInformationFile(FileRenameInformation): RootDirectory = pin (temp と final は
// 同一 pin 相対)、ReplaceIfExists = FALSE。rename は原子操作であり、存在確認の後追い判定
// ではない。rename 成功後 temp entry は存在しない。
// rename 成功後の temp close 失敗は「published=true かつ error」(→ uncertain) になる。
func (d *rootDir) publish(f *os.File, temp, final string) (bool, error) {
	units, err := windows.UTF16FromString(final)
	if err != nil {
		return false, fmt.Errorf("%w: rename %q: %v", ErrIO, final, err)
	}
	if len(units) > len(ntRenameInfo{}.FileName) {
		return false, fmt.Errorf("%w: rename %q: name too long", ErrIO, final)
	}
	var ri ntRenameInfo
	ri.RootDirectory = d.handle
	copy(ri.FileName[:], units)
	ri.FileNameLength = uint32((len(units) - 1) * 2) // NUL なし byte 数
	length := uint32(unsafe.Offsetof(ri.FileName)) + ri.FileNameLength
	var iosb windows.IO_STATUS_BLOCK
	if st := windows.NtSetInformationFile(windows.Handle(f.Fd()), &iosb,
		(*byte)(unsafe.Pointer(&ri)), length, uint32(ntFileRenameInformation)); st != nil {
		s := ntStatusOf(st)
		if ntIsCollision(s) {
			return false, fmt.Errorf("%w: %q", ErrNameConflict, final)
		}
		return false, fmt.Errorf("%w: rename %q: %v", ErrIO, final, ntErr(s))
	}
	if cerr := f.Close(); cerr != nil {
		return true, fmt.Errorf("%w: close temp: %v", ErrIO, cerr)
	}
	return true, nil
}

// clearTemp は自操作が作った temp entry の cleanup (§6.6 step 5)。publish (rename) 成功後は
// temp entry が既に存在しないため not-found → nil (正常経路)。publish 未成立の試行は
// Save が return 前に呼び、cleanup failure は隠さない (残骸の可能性 = uncertain)。
// 既存残骸の scan 削除は行わない (§11)。
func (d *rootDir) clearTemp(temp string) error {
	err := ntDelete(d.handle, temp)
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrNotFound) {
		return nil // 既に無い → cleanup 完了
	}
	return err
}

// sync は directory entry の flush (§6.6 step 6)。FlushFileBuffers(dir handle)。
// 注意: Linux fsync(dirfd) との完全な同等性は未確認 (検証手順 §8 を参照)。
func (d *rootDir) sync() error {
	if err := windows.FlushFileBuffers(d.handle); err != nil {
		return fmt.Errorf("%w: sync dir: %v", ErrIO, err)
	}
	return nil
}
