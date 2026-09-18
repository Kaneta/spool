# Windows Local milestone 1 checkpoint (2026-09-18)

Status: Windows Local milestone 1 の COMPLETE 記録。現在の設計基準は `DESIGN-v2.md`。実機確認の事実を記録するものであり、新しい設計の保証を追加しない。既存 checkpoint は `docs/checkpoint-2026-09-09.md`。

---

## 1. Status

Windows Local milestone 1: **COMPLETE**

目的:

> Windows で `spool add` に plain text を渡すと、指定した local spool directory に ordinary `.txt` record が保存される。

## 2. 実装

Linux store の observable contract を維持しつつ、OS 固有処理を build tag で分離した。

主な構成:

* `pc/internal/store/store.go` — portable orchestration
* `pc/internal/store/store_unix.go`
* `pc/internal/store/store_windows.go`
* `pc/terminal_unix.go`
* `pc/terminal_windows.go`

interface layer や汎用 filesystem abstraction は導入していない。

Windows store は pinned root directory HANDLE と NT API の RootDirectory 相対 operation を使用。

## 3. Windows 実装で修正した主要 failure

1. Win32 `FILE_INFO_BY_HANDLE_CLASS` と NT `FILE_INFORMATION_CLASS` の enum 混同

   * `FileAttributeTagInformation = 35`
   * `FileStandardInformation = 5`
   * その他 NT class を local constant として明示

2. directory HANDLE が `GENERIC_READ` のみで `FlushFileBuffers` が `ACCESS_DENIED`

   * `GENERIC_READ | GENERIC_WRITE`
   * `FILE_FLAG_BACKUP_SEMANTICS`
     に修正

3. collision retry 時の `.spool-tmp-*` leak

   * publish 未成立の failure path で temp lifecycle を閉じるよう修正

4. Windows temp delete の `NtCreateFile` が `STATUS_INVALID_PARAMETER`

   * `FILE_SYNCHRONOUS_IO_NONALERT` 使用時に `SYNCHRONIZE` が必要だった
   * `ntOpen` で `SYNCHRONIZE` を保証

5. `FILE_DISPOSITION_INFORMATION`

   * `DeleteFile` を documented NT ABI の 1-byte `BOOLEAN` に修正

## 4. Windows 実機 acceptance

環境:

* Windows 11 Home
* x86-64
* 非管理者
* NTFS fixed drive

Windows 実機で実行した store tests:

| Test | 結果 |
|---|---|
| `TestSaveThenReadRealFile` | PASS |
| `TestSaveDoesNotOverwrite` | PASS |
| `TestConflictRetriesLeakNoTemp` | PASS |
| `TestConcurrentCreateRace` | PASS |
| `TestRootChangedStopsOperations` | PASS |
| `TestRootMissingStopsOperations` | PASS |
| `TestUncertainWhenDirFsyncFails` | PASS |
| `TestListIsRepeatableAndFollowsChanges` | PASS |
| `TestRootHandleFlushable` | PASS |
| `TestSaveSavedWithDirFlush` | PASS |
| `TestClearTempRemovesEntry` | PASS |
| `TestDeleteAccessContract` | PASS |

symlink 作成権限が必要な 3 test は非管理者環境のため SKIP。failure ではない。

実際の `spool.exe add` acceptance:

同一 minute 内に 4 回:

* `20260918-1530-hello.txt`
* `20260918-1530-hello~01.txt`
* `20260918-1530-hello~02.txt`
* `20260918-1530-hello~03.txt`

を生成。

確認事項:

* 正常保存 exit 0
* stdout に filename 1 行
* 本文 `hello` を正常読取
* ordinary `.txt`
* existing record 非上書き
* collision suffix 正常
* `.spool-tmp-*` residue = 0
* terminal stdin は `failed: stdin_required: stdin is a terminal`
* terminal stdin exit code = 1
* directory flush 起因の `uncertain` は発生しない

## 5. 最終再検証

Linux:

* `gofmt -l .` → clean
* `go test -count=1 ./...` → all PASS
* `go test -race -count=1 ./...` → all PASS
* `GOOS=windows GOARCH=amd64 go build` → PASS
* `GOOS=windows GOARCH=amd64 go vet ./...` → clean

実機 acceptance と同一 source から生成した最終 Windows binary:

SHA-256:

```text
72dbcc7839c95b482411b8d7d1c8d23d0b3c015f12c673aff32fb7205c80b963
```

実機 acceptance 済み binary と完全一致。

## 6. Deferred findings

milestone 1 の COMPLETE を妨げないため今回対象外:

* Windows `List()` の concurrent enumeration（pin handle 上の enumeration state 共有可能性）
* read-only root の Windows/Linux capability 差
* createTemp 直後の file identity introspection failure 時の rare temp residue
* exFAT support
* Windows config path (`%APPDATA%`)
* `--init` UX
* Windows clipboard adapter
* installer / autostart
* standalone Spool Web deployment
* Bridge

Bridge は別プロジェクトの Elixir 実装が既に存在し利用中。Go rewrite は後回し。
