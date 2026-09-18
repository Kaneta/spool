// Package store は root 直下の ordinary text file への pinned directory handle 基準 I/O を
// 提供する (DESIGN-v2 §6.2, §6.6–§6.8)。閉じ込めは pin した directory handle 相対の
// directory-relative 操作で成立する。record 操作で root path を組み立てた path-based
// operation は使わない。root path を使うのは Open と rootChanged 検出 (§6.2, UX 要求の
// best-effort) のみである。
//
// OS 固有 primitive (Linux: dirfd + openat/linkat/unlinkat/fsync、Windows: RootDirectory
// 付き NtCreateFile + no-replace rename) は store_unix.go / store_windows.go に分離する。
// 本 file は OS 非依存の public API と orchestration のみを持つ。抽象 layer / interface は
// 作らず、両 OS で同一の unexported 関数群 (rootDir, openRoot, fileID, sameID) を
// build tag で切替える。
package store

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

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
// publish (Linux: linkat / Windows: no-replace rename) 成功後の障害が SaveUncertain、
// directory flush まで成功が SaveSaved。
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

// Store は起動時に root directory を開き、得た directory handle を process 生存中の
// operating root として保持する (§6.2 handle pinning)。既に開いた pin の外へ出る操作は
// 構造的に存在しない。testDirSync は §14 の限定 fault injection 用 (test のみ設定。
// production は常に nil)。
type Store struct {
	rootPath    string
	root        *rootDir
	testDirSync func() error
}

// Open は既存 root directory を開いて pin する。root の作成は行わない (--init は Unit 4)。
// root が存在しない / directory でない場合は error で停止する。
func Open(rootPath string) (*Store, error) {
	root, err := openRoot(rootPath)
	if err != nil {
		return nil, err
	}
	return &Store{rootPath: rootPath, root: root}, nil
}

// Close は pin した root directory handle を閉じる。
func (s *Store) Close() error {
	return s.root.close()
}

// checkRoot は root path の消失・置換を検出する (§6.2)。race-free 保証ではなく best-effort の
// UX 要求であり、閉じ込めの成立条件ではない (閉じ込めは pin 相対操作自体で成立)。
func (s *Store) checkRoot() error {
	return s.root.changed()
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
	names, err := s.root.names()
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	records := make([]RecordInfo, 0, len(names))
	for _, name := range names {
		if strings.HasPrefix(name, ".spool-tmp-") {
			continue // temp 残骸は対象外 (§6.6)。scan 削除はしない (手動整理対象)
		}
		if err := validRecordName(name); err != nil {
			continue // 単一 component 以外・非 .txt は対象外
		}
		_, size, err := s.root.statRegular(name)
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
		records = append(records, RecordInfo{Name: name, Size: size, Kind: kind})
	}
	return records, nil
}

// errNotRecord は「その entry は record として扱えない」ことを表す内部 sentinel。
var errNotRecord = errors.New("not a record entry")

// Read は name の現在の本文を返す (§6.7)。openat 相当 (no-follow) → regular 確認 → read。
// symlink は追従が構造的に不可能。open と確認の間に実体が差し替えられても
// 以後の read は開いた handle の inode に閉じる。root path を再解決しない。
func (s *Store) Read(name string) ([]byte, error) {
	if err := validRecordName(name); err != nil {
		return nil, err
	}
	if err := s.checkRoot(); err != nil {
		return nil, err
	}
	f, err := s.root.openRegular(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return readAll(f)
}

// Delete は name の直接削除 (§6.7, §6.8)。openat 相当 (no-follow) で regular file 確認後、
// pin した root 直下の指定 name entry を削除する。symlink entry を追って指す先を消す
// 経路は存在しない。確認後に入れ替わった場合も削除対象は pin 直下の指定 name entry であり、
// root 外へ出ない。Trash / rename / tombstone は存在しない。
func (s *Store) Delete(name string) error {
	if err := validRecordName(name); err != nil {
		return err
	}
	if err := s.checkRoot(); err != nil {
		return err
	}
	f, err := s.root.openRegular(name)
	if err != nil {
		return err
	}
	f.Close()
	return s.root.unlinkRegular(name)
}

// Save は完成した本文を指定された final name で create-only に publish する (§6.6)。
// suffix collision retry の所有者は server / CLI caller であるため、store は suffix loop を
// 回さず、衝突を ErrNameConflict として返す。各 Save invocation は自分で作った temp
// (.spool-tmp-*) の lifecycle を閉じる: publish 未成立で終わる試行は return 前に自分の
// temp を削除し (cleanup 失敗は隠さず uncertain)、成功試行は publish (rename) と同時に
// temp entry が消える。temp を pin 相対で作り、flush 後に no-replace publish
// (Linux: linkat(dirfd, temp, dirfd, final, 0)、Windows: RootDirectory 相対の
// rename with ReplaceIfExists=FALSE) で公開する。root path を publish 時に再解決しない。
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

	temp, f, tempID, err := s.root.createTemp()
	if err != nil {
		return SaveResult{State: SaveFailed, Err: err}
	}

	// step 2: 全文を書き切り、flush 後に publish。ここまでの失敗は publish 未成立 = failed。
	// temp cleanup もこの試行の責務。cleanup 失敗は隠さない: 元の失敗と cleanup 失敗を
	// 結合して failed として報告する (publish 未成立は確認済みであり uncertain ではない)。
	if werr := writeAll(f, text); werr != nil {
		f.Close()
		if cerr := s.root.clearTemp(temp); cerr != nil {
			return SaveResult{State: SaveFailed, Err: errors.Join(werr, cerr)}
		}
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: write temp: %v", ErrIO, werr)}
	}
	if serr := f.Sync(); serr != nil {
		f.Close()
		if cerr := s.root.clearTemp(temp); cerr != nil {
			return SaveResult{State: SaveFailed, Err: errors.Join(serr, cerr)}
		}
		return SaveResult{State: SaveFailed, Err: fmt.Errorf("%w: fsync temp: %v", ErrIO, serr)}
	}

	// publish (§6.6 step 3): no-replace な原子 publish。
	// Linux: linkat(dirfd, temp, dirfd, final, 0)。Windows: FileRenameInformation
	// (RootDirectory = pin, ReplaceIfExists = FALSE)。既存 entry を置換しないため、
	// 非上書き保証が原子操作で得られる。存在確認の後追い判定ではない。
	// published=false の失敗は publish 未成立 → temp cleanup して failed。
	// published=true の失敗 (Windows の temp close 失敗) は final publish 済み → uncertain。
	published, perr := s.root.publish(f, temp, finalName)
	if perr != nil {
		if !published {
			// publish 未成立。この試行が作った temp の lifecycle をここで閉じる
			// (suffix retry で temp が 1 試行 1 個残る漏洩を構造的に防ぐ)。
			// cleanup failure は隠さない: 元の失敗 (ErrNameConflict を含む) と
			// cleanup 失敗を結合して failed として報告する。errors.Join により
			// errors.Is(err, ErrNameConflict) は保たれ、caller の suffix retry
			// (§3.5) は継続する。final は publish 未成立のため uncertain ではない。
			f.Close() // unix は publish 内で閉じ済み (冪等)。windows はここで閉じる
			if cerr := s.root.clearTemp(temp); cerr != nil {
				return SaveResult{State: SaveFailed, Err: errors.Join(perr, cerr)}
			}
			return SaveResult{State: SaveFailed, Err: perr}
		}
		return SaveResult{State: SaveUncertain, Err: perr}
	}

	// publish 後 (§6.6 step 4–6): ここからの障害は final が publish 済みであるため uncertain。
	if verr := s.verifyPublish(finalName, tempID); verr != nil {
		return SaveResult{State: SaveUncertain, Err: verr}
	}
	// temp の通常経路 cleanup (§6.6 step 5)。Windows では publish (rename) と同時に
	// temp entry が消えるため no-op。Linux は unlinkat 失敗を uncertain に写像する。
	if uerr := s.root.clearTemp(temp); uerr != nil {
		return SaveResult{State: SaveUncertain, Err: uerr}
	}
	// directory flush (§6.6 step 6)。ここまで成功して fully committed。
	if derr := s.syncDir(); derr != nil {
		return SaveResult{State: SaveUncertain, Err: derr}
	}
	return SaveResult{State: SaveSaved}
}

// writeAll は partial write を正しく処理して全文を書き切る (§6.6 step 2)。
// os.File の Write は EINTR / short write を runtime 側で処理するため、EOF まで書く loop で足りる。
func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if n > 0 {
			data = data[n:]
		}
		if err != nil {
			return fmt.Errorf("%w: write temp: %v", ErrIO, err)
		}
		if n == 0 {
			return fmt.Errorf("%w: write temp: short write", ErrIO)
		}
	}
	return nil
}

// readAll は開いた handle (open 時点の inode に閉じている) から EOF まで読む。
func readAll(r io.Reader) ([]byte, error) {
	var buf []byte
	chunk := make([]byte, 32*1024)
	for {
		n, err := r.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
		}
		if errors.Is(err, io.EOF) {
			return buf, nil
		}
		if err != nil {
			return nil, fmt.Errorf("%w: read: %v", ErrIO, err)
		}
	}
}

// verifyPublish は publish 直後の補助検証 (§6.6 step 4)。flush 後に取得した temp の
// volume/inode と、final の no-follow open + stat 結果の一致を確認する。atomicity・閉じ込めの
// 成立条件ではなく補助検証であり、不一致は内部不変条件の違反として扱う。
func (s *Store) verifyPublish(finalName string, tempID fileID) error {
	id, _, err := s.root.statRegular(finalName)
	if err != nil {
		return fmt.Errorf("%w: verify openat %q: %v", ErrIO, finalName, err)
	}
	if !sameID(id, tempID) {
		return fmt.Errorf("%w: published inode mismatch for %q", ErrIO, finalName)
	}
	return nil
}

// syncDir は directory entry の flush (§6.6 step 6)。testDirSync が設定されている場合のみ
// test が注入した実装へ委譲する (§14 fault injection。production では常に nil)。
func (s *Store) syncDir() error {
	if s.testDirSync != nil {
		return s.testDirSync()
	}
	return s.root.sync()
}
