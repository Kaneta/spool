//go:build unix

// store_unix.go — Linux / Unix 向け store primitive (DESIGN-v2 §6.6–§6.8)。
// 閉じ込めは pin した dirfd 相対の directory-relative syscall (openat / linkat / unlinkat /
// fsync) で成立する。root path を使うのは openRoot と changed (rootChanged 検出) のみ。
package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

// fileID は record file の正体 (dev/ino)。verifyPublish の補助検証で使う。
type fileID = unix.Stat_t

// sameID は 2 つの fileID が同一 inode を指すか。
func sameID(a, b fileID) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino
}

// rootDir は pin した root directory。dirfd は openat / linkat / unlinkat / fstat / fsync の
// 基準である。dirFile は dirfd の os.File 表現。
type rootDir struct {
	dirFile *os.File
	dirfd   int
}

// openRoot は既存 root directory を open (O_DIRECTORY) して pin する。
// root の作成は行わない。
func openRoot(rootPath string) (*rootDir, error) {
	fd, err := unix.Open(rootPath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) {
			return nil, fmt.Errorf("%w: %q: %v", ErrRootMissing, rootPath, err)
		}
		return nil, fmt.Errorf("%w: open %q: %v", ErrIO, rootPath, err)
	}
	f := os.NewFile(uintptr(fd), rootPath)
	return &rootDir{dirFile: f, dirfd: int(f.Fd())}, nil
}

// close は pin した root directory fd を閉じる。
func (d *rootDir) close() error {
	return d.dirFile.Close()
}

// changed は root path の消失・置換を検出する (§6.2)。stat(rootPath) と fstat(dirfd) の
// dev/ino 比較。best-effort の UX 要求であり、閉じ込めの成立条件ではない。
func (d *rootDir) changed() error {
	var st unix.Stat_t
	if err := unix.Stat(d.dirFile.Name(), &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("%w: %q: %v", ErrRootMissing, d.dirFile.Name(), err)
		}
		return fmt.Errorf("%w: stat %q: %v", ErrIO, d.dirFile.Name(), err)
	}
	var fd unix.Stat_t
	if err := unix.Fstat(d.dirfd, &fd); err != nil {
		return fmt.Errorf("%w: fstat dirfd: %v", ErrIO, err)
	}
	if st.Dev != fd.Dev || st.Ino != fd.Ino {
		return ErrRootChanged
	}
	return nil
}

// names は root 直下の全 entry 名を返す (読み順不定。List が sort する)。
// Readdirnames は directory stream を消費して巻き戻らないため、pin した dirFile を
// 直接読むと 2 回目以降の list が空になる (Unit 5 E2E で発見した contract 不整合)。
// list は操作のたびに実行される (DESIGN §6.7, UI の Refresh) ので、list のたびに
// 同一 directory の新しい file descriptor を dirfd 相対で開く。dup は open file
// description (offset) を共有するため使わない。"." は pin した dirfd の指す inode
// 自身であり、root path を再解決しない。
func (d *rootDir) names() ([]string, error) {
	df, err := unix.Openat(d.dirfd, ".", unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, fmt.Errorf("%w: reopen dirfd: %v", ErrIO, err)
	}
	dir := os.NewFile(uintptr(df), ".")
	defer dir.Close() // 開いた fd はこの list 操作内で閉じる。pin した dirfd とは別物
	// io.EOF は正常終了。EOF 以外 (filesystem I/O error 等) は partial list を
	// 「正常な完全一覧」として返さず、呼び出し側へ error を返す (§6.7)。
	names, err := dir.Readdirnames(-1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: readdir: %v", ErrIO, err)
	}
	return names, nil
}

// statRegular は dirfd 相対で name を O_NOFOLLOW で開き、fstat で regular file のみを
// 受け付ける (§6.7)。O_NONBLOCK は FIFO 等の open が停止しないための付与であり、
// no-follow 契約 (§6.7) には影響しない。文字列 path 検証は boundary ではなく早期報告の補助。
func (d *rootDir) statRegular(name string) (fileID, int64, error) {
	fd, err := unix.Openat(d.dirfd, name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return unix.Stat_t{}, 0, errNotRecord
		}
		return unix.Stat_t{}, 0, fmt.Errorf("%w: openat %q: %v", ErrIO, name, err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return unix.Stat_t{}, 0, fmt.Errorf("%w: fstat %q: %v", ErrIO, name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return unix.Stat_t{}, 0, errNotRecord // directory / FIFO / 特殊 file (§6.7)
	}
	return st, st.Size, nil
}

// openRegular は dirfd 相対で name を O_NOFOLLOW で開き、regular file のみ受け付ける
// (§6.7)。symlink は ELOOP → ErrInvalidName。ENOENT → ErrNotFound。非 regular → ErrInvalidName。
// 返す *os.File は open 時点の inode に閉じている。
func (d *rootDir) openRegular(name string) (*os.File, error) {
	fd, err := unix.Openat(d.dirfd, name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, fmt.Errorf("%w: %q: %v", ErrNotFound, name, err)
		}
		if errors.Is(err, unix.ELOOP) {
			return nil, fmt.Errorf("%w: %q: %v", ErrInvalidName, name, err)
		}
		return nil, fmt.Errorf("%w: openat %q: %v", ErrIO, name, err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("%w: fstat %q: %v", ErrIO, name, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		return nil, fmt.Errorf("%w: %q: not a regular file", ErrInvalidName, name)
	}
	return os.NewFile(uintptr(fd), name), nil
}

// unlinkRegular は pin した root 直下の指定 name entry を削除する (§6.7, §6.8)。
// unlinkat は symlink を追わず entry を削除する。delete 中の外部変更 (rename 済み等) は
// not_found で終了し、追跡しない (§6.8)。
func (d *rootDir) unlinkRegular(name string) error {
	if err := unix.Unlinkat(d.dirfd, name, 0); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("%w: %q: %v", ErrNotFound, name, err)
		}
		return fmt.Errorf("%w: unlinkat %q: %v", ErrIO, name, err)
	}
	return nil
}

// createTemp は dirfd 相対で .spool-tmp-<16hex> を O_CREATE|O_EXCL で作る (§6.6 step 2)。
// temp 名は crypto/rand 8 byte → 16 lowercase hex。同名衝突は新 random 名で再試行する
// (無制限な抽象 retry framework は作らない)。fd は *os.File として返す (close の責務は caller)。
func (d *rootDir) createTemp() (string, *os.File, fileID, error) {
	for range 8 {
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", nil, unix.Stat_t{}, fmt.Errorf("%w: temp name: %v", ErrIO, err)
		}
		temp := ".spool-tmp-" + hex.EncodeToString(b[:])
		fd, err := unix.Openat(d.dirfd, temp, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_CLOEXEC, 0o644)
		if err == nil {
			var st unix.Stat_t
			if ferr := unix.Fstat(fd, &st); ferr != nil {
				unix.Close(fd)
				return "", nil, unix.Stat_t{}, fmt.Errorf("%w: fstat temp: %v", ErrIO, ferr)
			}
			return temp, os.NewFile(uintptr(fd), temp), st, nil
		}
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		return "", nil, unix.Stat_t{}, fmt.Errorf("%w: create temp: %v", ErrIO, err)
	}
	return "", nil, unix.Stat_t{}, fmt.Errorf("%w: temp name collision", ErrIO)
}

// publish は flush 済み temp を final name で create-only に公開する (§6.6 step 3)。
// linkat(dirfd, temp, dirfd, final, 0)。AT_FDCWD・AT_SYMLINK_FOLLOW は使わない。
// link は既存 entry を置換しないため、非上書き保証が原子操作で得られる。
// 存在確認の後追い判定ではない。publish に先立ち temp fd を close する (§6.6 step 2)。
// したがって unix では「published=true かつ error」は発生し得ない。
func (d *rootDir) publish(f *os.File, temp, final string) (bool, error) {
	if cerr := f.Close(); cerr != nil {
		return false, fmt.Errorf("%w: close temp: %v", ErrIO, cerr)
	}
	if lerr := unix.Linkat(d.dirfd, temp, d.dirfd, final, 0); lerr != nil {
		if errors.Is(lerr, unix.EEXIST) {
			return false, fmt.Errorf("%w: %q", ErrNameConflict, final)
		}
		return false, fmt.Errorf("%w: linkat %q: %v", ErrIO, final, lerr)
	}
	return true, nil
}

// clearTemp は自操作が作った temp entry の cleanup (§6.6 step 5)。publish 未成立の
// 試行は Save が return 前に呼び、cleanup failure は隠さない (残骸の可能性 = uncertain)。
// publish 成功後の unlinkat 失敗は final が publish 済みであるため Save 側で uncertain
// に写像。not-found は「既に消えている」= cleanup 完了として扱う。
// 既存残骸の scan 削除は行わない (§11)。
func (d *rootDir) clearTemp(temp string) error {
	if err := unix.Unlinkat(d.dirfd, temp, 0); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil // 既に無い → cleanup 完了
		}
		return fmt.Errorf("%w: unlink temp: %v", ErrIO, err)
	}
	return nil
}

// sync は directory entry の flush (§6.6 step 6)。fsync(dirfd)。
func (d *rootDir) sync() error {
	return unix.Fsync(d.dirfd)
}
