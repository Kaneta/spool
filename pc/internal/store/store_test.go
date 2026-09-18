package store

// 実 filesystem test (t.TempDir)。fake だけで完成判定にしない (Baseline §14)。
// 本 file は OS 非依存の store contract test。Linux syscall 固有の境界 test
// (dirfd 直接 / FIFO) は store_linux_test.go にある。

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"spool/internal/namegen"
)

const testPrefix = "20260909-0705"

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatalf("open %q: %v", root, err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, root
}

func requireSaved(t *testing.T, s *Store, name, text string) {
	t.Helper()
	r := s.Save(name, []byte(text))
	if r.State != SaveSaved || r.Err != nil {
		t.Fatalf("save %q: state=%v err=%v", name, r.State, r.Err)
	}
}

func assertNoTempResidue(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".spool-tmp-") {
			t.Fatalf("temp residue in root: %q", e.Name())
		}
	}
}

// symlink は Windows では特権 / Developer Mode が必要なため、作れない環境では skip。
func requireSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
}

// A: save → 実 file を OS から直接読み戻す。temp 残骸なし。store 経由 read も一致。
func TestSaveThenReadRealFile(t *testing.T) {
	s, root := openTestStore(t)
	text := "hello spool\n日本語\n"
	name := testPrefix + "-hello.txt"

	r := s.Save(name, []byte(text))
	if r.State != SaveSaved || r.Err != nil {
		t.Fatalf("save: state=%v err=%v", r.State, r.Err)
	}

	got, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		t.Fatalf("read file directly: %v", err)
	}
	if string(got) != text {
		t.Fatalf("file content mismatch: %q", got)
	}

	viaStore, err := s.Read(name)
	if err != nil {
		t.Fatalf("read via store: %v", err)
	}
	if string(viaStore) != text {
		t.Fatalf("store read mismatch: %q", viaStore)
	}

	infos, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(infos) != 1 || infos[0].Name != name || infos[0].Size != int64(len(text)) || infos[0].Kind != KindCaptured {
		t.Fatalf("list mismatch: %+v", infos)
	}

	if _, err := s.Read(testPrefix + "-missing.txt"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read missing: %v, want ErrNotFound", err)
	}
	assertNoTempResidue(t, root)
}

// Open: root 不在 / directory でない場合は error。
func TestOpenErrors(t *testing.T) {
	_, root := openTestStore(t)

	if _, err := Open(filepath.Join(root, "missing-dir")); !errors.Is(err, ErrRootMissing) {
		t.Fatalf("open missing: %v, want ErrRootMissing", err)
	}
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(file); !errors.Is(err, ErrRootMissing) {
		t.Fatalf("open regular file: %v, want ErrRootMissing", err)
	}
}

// Save: 生成 filename 契約と textcheck を store 内で再実装せず Unit 1 を使う。
func TestSaveRejectsInvalidInput(t *testing.T) {
	s, _ := openTestStore(t)

	if r := s.Save("my notes.txt", []byte("x")); r.State != SaveFailed || !errors.Is(r.Err, ErrInvalidName) {
		t.Fatalf("non-generated name: state=%v err=%v", r.State, r.Err)
	}
	if r := s.Save(testPrefix+"-bad.txt", []byte{0xff, 0xfe}); r.State != SaveFailed || r.Err == nil {
		t.Fatalf("invalid utf-8: state=%v err=%v", r.State, r.Err)
	}
	long := testPrefix + "-" + strings.Repeat("x", 250) + ".txt"
	if r := s.Save(long, []byte("x")); r.State != SaveFailed || !errors.Is(r.Err, ErrInvalidName) {
		t.Fatalf("oversize generated name: state=%v err=%v", r.State, r.Err)
	}
}

// B: 既存 final は置換しない (publish 衝突 → ErrNameConflict)。本文 1 byte も変わらない。
func TestSaveDoesNotOverwrite(t *testing.T) {
	s, root := openTestStore(t)
	name := testPrefix + "-original.txt"
	if err := os.WriteFile(filepath.Join(root, name), []byte("ORIGINAL"), 0o644); err != nil {
		t.Fatal(err)
	}

	r := s.Save(name, []byte("NEW"))
	if r.State != SaveFailed || !errors.Is(r.Err, ErrNameConflict) {
		t.Fatalf("overwrite attempt: state=%v err=%v", r.State, r.Err)
	}

	got, err := os.ReadFile(filepath.Join(root, name))
	if err != nil || string(got) != "ORIGINAL" {
		t.Fatalf("existing content changed: %q err=%v", got, err)
	}
	assertNoTempResidue(t, root)
}

// B2 (name conflict retry の temp lifecycle): 同一 final name への連続保存は
// ErrNameConflict で失敗するが、各 Save invocation は自分の temp (.spool-tmp-*) を
// return 前に閉じる。失敗 retry のたびに temp が 1 個残る漏洩の regression test
// (collision 1 回でなく複数 retry を通す)。final 既存 record は変更されない。
func TestConflictRetriesLeakNoTemp(t *testing.T) {
	s, root := openTestStore(t)
	name := testPrefix + "-collide.txt"
	if err := os.WriteFile(filepath.Join(root, name), []byte("EXISTING"), 0o644); err != nil {
		t.Fatal(err)
	}

	const attempts = 4
	for i := range attempts {
		r := s.Save(name, []byte("NEW"))
		if r.State != SaveFailed || !errors.Is(r.Err, ErrNameConflict) {
			t.Fatalf("attempt %d: state=%v err=%v, want failed/ErrNameConflict", i, r.State, r.Err)
		}
		assertNoTempResidue(t, root)
	}

	got, err := os.ReadFile(filepath.Join(root, name))
	if err != nil || string(got) != "EXISTING" {
		t.Fatalf("existing record changed after retries: %q err=%v", got, err)
	}
}

// C: 同一 final への並行 create。成功は 1 件、他は name conflict、本文は成功 1 件の完成本文。
// 同一 pin からの同時 publish でも overwrite されない atomic 性。
func TestConcurrentCreateRace(t *testing.T) {
	s, root := openTestStore(t)
	name := testPrefix + "-race.txt"

	const n = 8
	texts := make([]string, n)
	for i := range n {
		texts[i] = "body-" + strings.Repeat("x", i) + "\n"
	}

	results := make([]SaveResult, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = s.Save(name, []byte(texts[i]))
		}(i)
	}
	wg.Wait()

	winner := -1
	for i, r := range results {
		switch {
		case r.State == SaveSaved:
			if winner != -1 {
				t.Fatalf("multiple saves succeeded: %d and %d", winner, i)
			}
			winner = i
		case errors.Is(r.Err, ErrNameConflict):
			// 期待どおり
		default:
			t.Fatalf("goroutine %d: unexpected state=%v err=%v", i, r.State, r.Err)
		}
	}
	if winner == -1 {
		t.Fatal("no goroutine succeeded")
	}

	got, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		t.Fatalf("read winner file: %v", err)
	}
	if string(got) != texts[winner] {
		t.Fatalf("winner content mismatch: %q != %q", got, texts[winner])
	}
	assertNoTempResidue(t, root)
}

// D: list の分類と対象外。path-based os.ReadDir に依存しない list であることの確認も兼ねる。
// symlink は store_linux_test.go の Unix 固有 test でも確認する。
func TestListClassificationAndExclusions(t *testing.T) {
	s, root := openTestStore(t)

	requireSaved(t, s, testPrefix+"-gen.txt", "abc") // captured
	if err := os.WriteFile(filepath.Join(root, "my notes.txt"), []byte("efgh"), 0o644); err != nil {
		t.Fatal(err) // external
	}
	if err := os.Mkdir(filepath.Join(root, "notes.txt"), 0o755); err != nil {
		t.Fatal(err) // directory 名の .txt → 対象外
	}
	requireSymlink(t, "my notes.txt", filepath.Join(root, "link.txt")) // symlink → 対象外
	if err := os.WriteFile(filepath.Join(root, "readme.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err) // 非 .txt → 対象外
	}
	if err := os.WriteFile(filepath.Join(root, ".spool-tmp-0123456789abcdef"), []byte("junk"), 0o644); err != nil {
		t.Fatal(err) // temp 残骸 → 対象外
	}

	infos, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	want := []RecordInfo{
		{Name: testPrefix + "-gen.txt", Size: 3, Kind: KindCaptured},
		{Name: "my notes.txt", Size: 4, Kind: KindExternal},
	}
	if len(infos) != len(want) {
		t.Fatalf("list = %v, want %v", infos, want)
	}
	for i, w := range want {
		if infos[i] != w {
			t.Fatalf("list[%d] = %+v, want %+v", i, infos[i], w)
		}
	}
}

// E: symlink を read しない。outside に届かない。
func TestReadSymlinkRejected(t *testing.T) {
	s, root := openTestStore(t)
	outside := t.TempDir()
	target := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(target, []byte("OUTSIDE"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, target, filepath.Join(root, "evil.txt"))

	got, err := s.Read("evil.txt")
	if !errors.Is(err, ErrInvalidName) {
		t.Fatalf("read symlink: %v, want ErrInvalidName", err)
	}
	if got != nil {
		t.Fatalf("symlink target leaked: %q", got)
	}
}

// F: symlink を record として削除しない。削除の対象は pin 直下 entry だけ。
func TestDeleteSymlinkSafety(t *testing.T) {
	s, root := openTestStore(t)
	outside := t.TempDir()
	target := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(target, []byte("OUTSIDE"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "evil.txt")
	requireSymlink(t, target, link)
	if err := os.WriteFile(filepath.Join(root, "plain.txt"), []byte("p"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := s.Delete("evil.txt"); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("delete symlink: %v, want ErrInvalidName", err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatalf("symlink entry must remain: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("symlink target must survive: %v", err)
	}

	if err := s.Delete("plain.txt"); err != nil {
		t.Fatalf("delete external: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "plain.txt")); !os.IsNotExist(err) {
		t.Fatalf("deleted file still present: %v", err)
	}
	if err := s.Delete(testPrefix + "-missing.txt"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete missing: %v, want ErrNotFound", err)
	}
	if err := s.Delete("a/b.txt"); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("delete traversal: %v, want ErrInvalidName", err)
	}
}

// H: root path の置換 (同名の別 directory) で全 public 操作が rootChanged で停止し、新 root へ書かない。
func TestRootChangedStopsOperations(t *testing.T) {
	s, root := openTestStore(t)
	renamed := root + "-moved"
	if err := os.Rename(root, renamed); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err) // 同じ元 path に別 directory
	}

	if _, err := s.List(); !errors.Is(err, ErrRootChanged) {
		t.Fatalf("list: %v, want ErrRootChanged", err)
	}
	if _, err := s.Read("x.txt"); !errors.Is(err, ErrRootChanged) {
		t.Fatalf("read: %v, want ErrRootChanged", err)
	}
	if err := s.Delete("x.txt"); !errors.Is(err, ErrRootChanged) {
		t.Fatalf("delete: %v, want ErrRootChanged", err)
	}
	if r := s.Save(testPrefix+"-x.txt", []byte("v")); r.State != SaveFailed || !errors.Is(r.Err, ErrRootChanged) {
		t.Fatalf("save: state=%v err=%v, want failed/ErrRootChanged", r.State, r.Err)
	}

	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("new root must stay empty: %v entries=%v", err, entries)
	}
}

// I: root 消失で public 操作が停止し、自動再作成しない。
func TestRootMissingStopsOperations(t *testing.T) {
	s, root := openTestStore(t)
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}

	if _, err := s.List(); !errors.Is(err, ErrRootMissing) {
		t.Fatalf("list: %v, want ErrRootMissing", err)
	}
	if _, err := s.Read("x.txt"); !errors.Is(err, ErrRootMissing) {
		t.Fatalf("read: %v, want ErrRootMissing", err)
	}
	if err := s.Delete("x.txt"); !errors.Is(err, ErrRootMissing) {
		t.Fatalf("delete: %v, want ErrRootMissing", err)
	}
	if r := s.Save(testPrefix+"-x.txt", []byte("v")); r.State != SaveFailed || !errors.Is(r.Err, ErrRootMissing) {
		t.Fatalf("save: state=%v err=%v, want failed/ErrRootMissing", r.State, r.Err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("root must not be recreated: %v", err)
	}
}

// K (§14 fault injection): publish 成功後の directory flush 失敗 → result uncertain。
// final は完成本文で publish 済み。
func TestUncertainWhenDirFsyncFails(t *testing.T) {
	s, root := openTestStore(t)
	defer func() { s.testDirSync = nil }()
	s.testDirSync = func() error { return errors.New("injected dir sync failure") }

	name := testPrefix + "-durability.txt"
	r := s.Save(name, []byte("DURABLE-BODY"))
	if r.State != SaveUncertain {
		t.Fatalf("state=%v err=%v, want SaveUncertain", r.State, r.Err)
	}

	got, err := os.ReadFile(filepath.Join(root, name))
	if err != nil || string(got) != "DURABLE-BODY" {
		t.Fatalf("published file mismatch: %q err=%v", got, err)
	}
	assertNoTempResidue(t, root)
}

// fixture 由来でない補助: 分類関数が generated/external を正しく分けること (Unit 1 validator 経由)。
func TestKindDerivedFromValidator(t *testing.T) {
	if !namegen.ValidateGeneratedFilename(testPrefix + "-a.txt") {
		t.Fatal("test fixture name must be generated")
	}
	if namegen.ValidateGeneratedFilename("my notes.txt") {
		t.Fatal("external name must not be generated")
	}
}

// list は操作のたびに呼ばれる (UI Refresh 等)。list のたびに同一 directory の新しい
// handle / enumeration を行うことで反復可能にする (Unit 5 E2E で発見した contract
// 不整合の回帰 test)。
func TestListIsRepeatableAndFollowsChanges(t *testing.T) {
	s, root := openTestStore(t)
	requireSaved(t, s, testPrefix+"-one.txt", "one")

	first, err := s.List()
	if err != nil || len(first) != 1 {
		t.Fatalf("first list: %v %v", first, err)
	}

	// 外部 editor / shell による file 追加は次の list に現れる。
	if err := os.WriteFile(filepath.Join(root, "external note.txt"), []byte("ext"), 0o644); err != nil {
		t.Fatalf("write external: %v", err)
	}
	second, err := s.List()
	if err != nil || len(second) != 2 {
		t.Fatalf("second list: %v %v", second, err)
	}

	// 外部削除も次の list に反映される。
	if err := os.Remove(filepath.Join(root, testPrefix+"-one.txt")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	third, err := s.List()
	if err != nil || len(third) != 1 || third[0].Name != "external note.txt" {
		t.Fatalf("third list: %v %v", third, err)
	}
	assertNoTempResidue(t, root)
}
