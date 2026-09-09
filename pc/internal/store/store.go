// Package store は root 直下の ordinary text file への dirfd 基準 I/O を提供する
// (DESIGN-v2 §6.2, §6.6–§6.8)。閉じ込めは pin した dirfd 相対の directory-relative syscall で
// 成立する。record 操作で root path を組み立てた path-based operation は使わない。
// root path を使うのは Open と rootChanged 検出 (§6.2, UX 要求の best-effort) のみである。
package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"golang.org/x/sys/unix"

	"spool/internal/namegen"
	"spool/internal/textcheck"
)

// sentinel error。Unit 3 server が HTTP error code (§6.5) へ mapping する。
var (
	ErrRootMissing  = errors.New("root path missing")
	ErrRootChanged  = errors.New("root path replaced")
	ErrNotFound     = errors.New("record not found")
	ErrInvalidName  = errors.New("invalid record name")
	ErrNameConflict = errors.New("name conflict")
	ErrIO           = errors.New("filesystem error")
)

// Kind は list の derived 分類 (§3.6)。永続化しない。
const (
	KindCaptured = "captured"
	KindExternal = "external"
)

// RecordInfo は list 1 件分。Size は本文の byte 数。
type RecordInfo struct {
	Name string
	Size int64
	Kind string
}

// SaveState は save の結果区分 (§6.6, §10.5)。publish 前の確認済み失敗が SaveFailed、
// publish (linkat) 成功後の障害が SaveUncertain、directory fsync まで成功が SaveSaved。
type SaveState int

const (
	SaveFailed SaveState = iota
	SaveUncertain
	SaveSaved
)

// SaveResult は save 操作の結果。Unit 3 server が saved / failed / uncertain へ mapping する。
type SaveResult struct {
	State SaveState
	Err   error
}

// Store は起動時に root directory を開き、得た directory descriptor を process 生存中の
// operating root として保持する (§6.2 fd pinning)。既に開いた dirfd の外へ出る操作は構造的に存在しない。
type Store struct {
	rootPath string
	dirFile  *os.File // pin した root directory (Readdirnames 用に保持)
	dirfd    int      // openat / linkat / unlinkat / fstat / fsync の基準
	// testDirSync は §14 の限定 fault injection 用 (test のみ設定。production は常に nil)。
	testDirSync func() error
}

// Open は既存 root directory を開いて dirfd を pin する。root の作成は行わない (--init は Unit 4)。
// root が存在しない / directory でない場合は error で停止する。
func Open(rootPath string) (*Store, error) {
	fd, err := unix.Open(rootPath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) {
			return nil, fmt.Errorf("%w: %q: %v", ErrRootMissing, rootPath, err)
		}
		return nil, fmt.Errorf("%w: open %q: %v", ErrIO, rootPath, err)
	}
	f := os.NewFile(uintptr(fd), rootPath)
	return &Store{rootPath: rootPath, dirFile: f, dirfd: int(f.Fd())}, nil
}

// Close は pin した root directory fd を閉じる。
func (s *Store) Close() error {
	return s.dirFile.Close()
}

// checkRoot は root path の消失・置換を検出する (§6.2)。race-free 保証ではなく best-effort の
// UX 要求であり、閉じ込めの成立条件ではない (閉じ込めは dirfd 相対操作自体で成立)。
func (s *Store) checkRoot() error {
	var st unix.Stat_t
	if err := unix.Stat(s.rootPath, &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("%w: %q: %v", ErrRootMissing, s.rootPath, err)
		}
		return fmt.Errorf("%w: stat %q: %v", ErrIO, s.rootPath, err)
	}
	var d unix.Stat_t
	if err := unix.Fstat(s.dirfd, &d); err != nil {
		return fmt.Errorf("%w: fstat dirfd: %v", ErrIO, err)
	}
	if st.Dev != d.Dev || st.Ino != d.Ino {
		return ErrRootChanged
	}
	return nil
}

// validRecordName は read / delete 対象名の safe root-direct-child 検証 (§6.4)。
// Unit 1 の validator を使う。store 内で再実装しない。
func validRecordName(name string) error {
	if !namegen.IsValidRootDirectChildName(name) {
		return fmt.Errorf("%w: %q", ErrInvalidName, name)
	}
	return nil
}

// List は root 直下の対象 regular .txt を name 昇順で返す (§6.4, §6.7)。
// recursive traversal なし。symlink / directory / special file / 非 .txt / *.spool-tmp-* は
// 対象外。external .txt は対象。captured / external は list 時の derived 分類であり永続化しない。
func (s *Store) List() ([]RecordInfo, error) {
	if err := s.checkRoot(); err != nil {
		return nil, err
	}
	// Readdirnames は directory stream を消費して巻き戻らないため、pin した dirFile を
	// 直接読むと 2 回目以降の list が空になる (Unit 5 E2E で発見した contract 不整合)。
	// list は操作のたびに実行される (DESIGN §6.7, UI の Refresh) ので、list のたびに
	// 同一 directory の新しい file descriptor を dirfd 相対で開く。dup は open file
	// description (offset) を共有するため使わない。"." は pin した dirfd の指す inode
	// 自身であり、root path を再解決しない。
	df, err := unix.Openat(s.dirfd, ".", unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, fmt.Errorf("%w: reopen dirfd: %v", ErrIO, err)
	}
	dir := os.NewFile(uintptr(df), ".")
	defer dir.Close() // 開いた fd はこの list 操作内で閉じる。pin した dirfd とは別物
	names, err := dir.Readdirnames(-1)
	sort.Strings(names)
	records := make([]RecordInfo, 0, len(names))
	for _, name := range names {
		if strings.HasPrefix(name, ".spool-tmp-") {
			continue // temp 残骸は対象外 (§6.6)。scan 削除はしない (手動整理対象)
		}
		if err := validRecordName(name); err != nil {
			continue // 単一 component 以外・非 .txt は対象外
		}
		st, err := s.statRegular(name)
		if err != nil {
			if errors.Is(err, errNotRecord) {
				continue // symlink / directory / special / list 中に消失
			}
			return nil, err
		}
		kind := KindExternal
		if namegen.ValidateGeneratedFilename(name) {
			kind = KindCaptured
		}
		records = append(records, RecordInfo{Name: name, Size: st.Size, Kind: kind})
	}
	return records, nil
}

// errNotRecord は「その entry は record として扱えない」ことを表す内部 sentinel。
var errNotRecord = errors.New("not a record entry")

// statRegular は dirfd 相対で name を O_NOFOLLOW で開き、fstat で regular file のみを
// 受け付ける (§6.7)。O_NONBLOCK は FIFO 等の open が停止しないための付与であり、
// no-follow 契約 (§6.7) には影響しない。文字列 path 検証は boundary ではなく早期報告の補助。
func (s *Store) statRegular(name string) (unix.Stat_t, error) {
	fd, err := unix.Openat(s.dirfd, name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return unix.Stat_t{}, errNotRecord
		}
		return unix.Stat_t{}, fmt.Errorf("%w: openat %q: %v", ErrIO, name, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return unix.Stat_t{}, fmt.Errorf("%w: fstat %q: %v", ErrIO, name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return unix.Stat_t{}, errNotRecord // directory / FIFO / 特殊 file (§6.7)
	}
	return st, nil
}

// Read は name の現在の本文を返す (§6.7)。openat(O_NOFOLLOW) → fstat → read。
// symlink は ELOOP で追従が構造的に不可能。open と fstat の間に実体が差し替えられても
// 以後の read は開いた fd の inode に閉じる。root path を再解決しない。
func (s *Store) Read(name string) ([]byte, error) {
	if err := validRecordName(name); err != nil {
		return nil, err
	}
	if err := s.checkRoot(); err != nil {
		return nil, err
	}
	fd, err := unix.Openat(s.dirfd, name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, fmt.Errorf("%w: %q: %v", ErrNotFound, name, err)
		}
		if errors.Is(err, unix.ELOOP) {
			return nil, fmt.Errorf("%w: %q: %v", ErrInvalidName, name, err)
		}
		return nil, fmt.Errorf("%w: openat %q: %v", ErrIO, name, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, fmt.Errorf("%w: fstat %q: %v", ErrIO, name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, fmt.Errorf("%w: %q: not a regular file", ErrInvalidName, name)
	}
	return readAll(fd)
}

// Delete は name の直接削除 (§6.7, §6.8)。openat + fstat で regular file 確認後、
// unlinkat(dirfd, name, 0) で dirfd 直下の entry を削除する。symlink entry を追って
// 指す先を消す経路は存在しない。確認後に入れ替わった場合も削除対象は dirfd 直下の
// 指定 name entry であり、root 外へ出ない。Trash / rename / tombstone は存在しない。
func (s *Store) Delete(name string) error {
	if err := validRecordName(name); err != nil {
		return err
	}
	if err := s.checkRoot(); err != nil {
		return err
	}
	fd, err := unix.Openat(s.dirfd, name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("%w: %q: %v", ErrNotFound, name, err)
		}
		if errors.Is(err, unix.ELOOP) {
			return fmt.Errorf("%w: %q: %v", ErrInvalidName, name, err)
		}
		return fmt.Errorf("%w: openat %q: %v", ErrIO, name, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fmt.Errorf("%w: fstat %q: %v", ErrIO, name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("%w: %q: not a regular file", ErrInvalidName, name)
	}
	if err := unix.Unlinkat(s.dirfd, name, 0); err != nil {
		if errors.Is(err, unix.ENOENT) {
			// §6.8: delete 中の外部変更 (rename 済み等) は not_found で終了。追跡しない
			return fmt.Errorf("%w: %q: %v", ErrNotFound, name, err)
		}
		return fmt.Errorf("%w: unlinkat %q: %v", ErrIO, name, err)
	}
	return nil
}

// Save は完成した本文を指定された final name で create-only に publish する (§6.6)。
// suffix collision retry の所有者は server (Unit 3) であるため、store は suffix loop を回さず、
// EEXIST を ErrNameConflict として返す。temp (.spool-tmp-*) を dirfd 相対で作り、fsync 後に
// linkat(dirfd, temp, dirfd, final, 0) で公開する。root path を publish 時に再解決しない。
func (s *Store) Save(finalName string, text []byte) SaveResult {
	if err := textcheck.Check(text); err != nil {
		return SaveResult{State: SaveFailed, Err: err}
	}
	if !namegen.ValidateGeneratedFilename(finalName) {
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: %q", ErrInvalidName, finalName)}
	}
	if err := s.checkRoot(); err != nil {
		return SaveResult{State: SaveFailed, Err: err}
	}

	temp, tfd, err := s.createTemp()
	if err != nil {
		return SaveResult{State: SaveFailed, Err: err}
	}

	// step 2: 全文を書き切り、fsync 後に close (§6.6 step 2)。ここまでの失敗は publish 未成立 = failed。
	if werr := writeAll(tfd, text); werr != nil {
		unix.Close(tfd)
		s.unlinkTemp(temp)
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: write temp: %v", ErrIO, werr)}
	}
	var tst unix.Stat_t
	if ferr := unix.Fstat(tfd, &tst); ferr != nil {
		unix.Close(tfd)
		s.unlinkTemp(temp)
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: fstat temp: %v", ErrIO, ferr)}
	}
	if serr := unix.Fsync(tfd); serr != nil {
		unix.Close(tfd)
		s.unlinkTemp(temp)
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: fsync temp: %v", ErrIO, serr)}
	}
	if cerr := unix.Close(tfd); cerr != nil {
		s.unlinkTemp(temp)
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: close temp: %v", ErrIO, cerr)}
	}

	// publish (§6.6 step 3): linkat(dirfd, temp, dirfd, final, 0)。
	// AT_FDCWD・AT_SYMLINK_FOLLOW は使わない。link は既存 entry を置換しないため、
	// 非上書き保証が原子操作で得られる。存在確認の後追い判定ではない。
	if lerr := unix.Linkat(s.dirfd, temp, s.dirfd, finalName, 0); lerr != nil {
		s.unlinkTemp(temp)
		if errors.Is(lerr, unix.EEXIST) {
			return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: %q", ErrNameConflict, finalName)}
		}
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: linkat %q: %v", ErrIO, finalName, lerr)}
	}

	// publish 後 (§6.6 step 4–6): ここからの障害は final が publish 済みであるため uncertain。
	if verr := s.verifyPublish(finalName, tst); verr != nil {
		return SaveResult{State: SaveUncertain, Err: verr}
	}
	// temp unlink は通常経路 (§6.6 step 5)。補償削除を atomicity とは呼ばない。失敗時の
	// 残骸は手動整理対象 (scan 削除はしない) であり、final は publish 済みなので uncertain。
	if uerr := unix.Unlinkat(s.dirfd, temp, 0); uerr != nil {
		return SaveResult{State: SaveUncertain, Err: fmt.Errorf("%w: unlink temp: %v", ErrIO, uerr)}
	}
	// directory fsync (§6.6 step 6)。ここまで成功して fully committed。
	if derr := s.syncDir(); derr != nil {
		return SaveResult{State: SaveUncertain, Err: derr}
	}
	return SaveResult{State: SaveSaved}
}

// createTemp は dirfd 相対で .spool-tmp-<16hex> を O_CREATE|O_EXCL で作る (§6.6 step 2)。
// temp 名は crypto/rand 8 byte → 16 lowercase hex。同名衝突は新 random 名で再試行する
// (無制限な抽象 retry framework は作らない)。
func (s *Store) createTemp() (string, int, error) {
	for range 8 {
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", -1, fmt.Errorf("%w: temp name: %v", ErrIO, err)
		}
		temp := ".spool-tmp-" + hex.EncodeToString(b[:])
		fd, err := unix.Openat(s.dirfd, temp, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_CLOEXEC, 0644)
		if err == nil {
			return temp, fd, nil
		}
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		return "", -1, fmt.Errorf("%w: create temp: %v", ErrIO, err)
	}
	return "", -1, fmt.Errorf("%w: temp name collision", ErrIO)
}

// writeAll は partial write と EINTR を正しく処理して全文を書き切る (§6.6 step 2)。
func writeAll(fd int, data []byte) error {
	for len(data) > 0 {
		n, err := unix.Write(fd, data)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return fmt.Errorf("%w: write temp: %v", ErrIO, err)
		}
		data = data[n:]
	}
	return nil
}

// readAll は開いた fd (open 時点の inode に閉じている) から EOF まで読む。
func readAll(fd int) ([]byte, error) {
	var buf []byte
	chunk := make([]byte, 32*1024)
	for {
		n, err := unix.Read(fd, chunk)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("%w: read: %v", ErrIO, err)
		}
		if n == 0 {
			return buf, nil
		}
		buf = append(buf, chunk[:n]...)
	}
}

// verifyPublish は publish 直後の補助検証 (§6.6 step 4)。temp close 前に取得した dev/ino と
// final の openat + fstat 結果の一致を確認する。atomicity・閉じ込めの成立条件ではなく補助検証であり、
// 不一致は内部不変条件の違反として扱う。
func (s *Store) verifyPublish(finalName string, temp unix.Stat_t) error {
	fd, err := unix.Openat(s.dirfd, finalName, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("%w: verify openat %q: %v", ErrIO, finalName, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fmt.Errorf("%w: verify fstat %q: %v", ErrIO, finalName, err)
	}
	if st.Dev != temp.Dev || st.Ino != temp.Ino {
		return fmt.Errorf("%w: published inode mismatch for %q", ErrIO, finalName)
	}
	return nil
}

// unlinkTemp は自操作が作った temp の best-effort cleanup。既存残骸の scan 削除は行わない (§11)。
func (s *Store) unlinkTemp(temp string) {
	_ = unix.Unlinkat(s.dirfd, temp, 0)
}

// syncDir は directory entry の flush (§6.6 step 6)。testDirSync が設定されている場合のみ
// test が注入した実装へ委譲する (§14 fault injection。production では常に nil)。
func (s *Store) syncDir() error {
	if s.testDirSync != nil {
		return s.testDirSync()
	}
	return unix.Fsync(s.dirfd)
}
