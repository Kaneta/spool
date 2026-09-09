# spool DESIGN v2 (Atomic Rebuild 詳細設計)

Status: 詳細設計 (2026-09-08)。実装の完成状態は `docs/checkpoint-2026-09-09.md` (checkpoint) に記録する。本書は設計であり、実装の進捗をここでは管理しない。
唯一の上位基準は `docs/spool-design-baseline-v2.md` (以下 Baseline)。本書は Baseline の製品境界を、実装時に迷わない粒度へ具体化したものであり、Baseline が明示していない機能・保証・正本を追加しない。本書と Baseline が矛盾する場合は Baseline が優先し、本書を修正する。
旧DESIGN・旧Baseline・各レビュー・legacy実装の内部構造は本書の根拠に含まない。legacy実装は現行 UX / 既存 Bridge の挙動確認のみに参照し得る。

本書は設計である。実装・migration・legacy改修は含まない。

---

## 1. Scope / authority

- 対象: spool Atomic Rebuild 全体。Browser UI (PC / Mobile 共通)、PC Go localhost process、Mobile IndexedDB、Bridge protocol、E2EE / pairing。
- 決定権: Baseline §2 (product invariants) と §17 (rejected complexity) は本書で再解釈しない。本書は §16「詳細設計で決める」に挙げられた事項と、実装に必要な機械的な詳細 (endpoint・format・数値上限・手順) を固定する。
- 数値上限 (テキストサイズ・TTL・quota・rate) は Baseline §16「製品判断が必要」に属するが、設計を具体的に保つため本書で **PROVISIONAL** 仮値を置く (§6.4, §8.5, §17)。仮値は実装前のユーザー判断対象であり、wire format と security invariant は仮値そのものに依存しない。
- 「初期対応環境」も Baseline §16-1 の製品判断である。本書は POSIX (Linux / macOS) を初期対応環境と仮定して書き (**PROVISIONAL**)、Windows 固有の差分を「未対応」として明示する (§6.7)。仕組みはこの仮定に過度に依存しない。

## 2. Architecture overview

### 2.1 構成要素

```text
[Browser UI (Vanilla TS + Vite)]
   ├─ PC モード:  ←同一origin→  [Go localhost HTTP process] → root直下の普通のtext file
   └─ Mobile モード: ←同一origin→ [IndexedDB]
   共通: [Bridge client (protocol + E2EE)] ←HTTPS→ [Elixir/Phoenix Bridge] ←opaque bytes→
```

- Browser UI は一つのコードベース。PC モードと Mobile モードは storage 境界だけが異なり、Vite の 2 build target として生成する (実行時 probing しない)。
- PC 正本: ユーザー指定 root 直下の一件ずつの普通の `.txt` file。editor・shell・rg から直接扱える。
- Mobile 正本: IndexedDB の flat な `name → text`。
- Bridge は既存 Elixir/Phoenix を継続し、opaque な暗号 bytes と最小の配送状態のみを扱う。本文・file 意味を解釈しない。
- 同期 daemon / 完全同期 / 仮想 directory / 永続 index は存在しない。

### 2.2 データの流れ (Baseline §7 の具体化)

```text
保存:  input → validate → derive filename → storage commit (create-only) → result → list refresh → render
送信:  pick record → read current text → encode → encrypt (envelope v1) → POST upload → (ack待ち) → 表示
受信:  list incoming → GET payload → validate header → decrypt → validate text → user明示save → new local save → ack
```

各矢印は明示的な関数呼び出し。subscriber / effect / 連鎖しない。

### 2.3 状態の所有者 (Baseline §9 の具体化)

| 状態 | 所有者 | 媒体 |
|---|---|---|
| PC の file 正本 | filesystem | root 直下 |
| Mobile の record 正本 | IndexedDB | `records` store |
| 入力 draft (未保存) | capture view の module-local 変数 | メモリのみ。reload で消失 (Baseline §6 の初期保証) |
| 一覧 snapshot | list view の module-local 変数 | メモリ。明示 refresh で更新 |
| 選択中 record | read view の module-local 変数 | メモリ |
| 検索処理 (query・結果・incomplete flag) | search view の module-local 変数 + AbortController | メモリ |
| retry 用 暗号 payload bytes | transfer view の module-local 変数 | メモリ。terminal result で破棄 |
| 送信待ち ack 一覧 | transfer view の module-local 変数 | メモリのみ (receipt DB は作らない) |
| session 復帰情報 | sessionStorage (タブ単位・同一origin) | §9.5 |
| 保存先設定 (PC) | Go process の起動引数 / 最小 config file | root 直下以外 (§6.2) |

`sessionStorage` は唯一の「復帰情報」格納先であり、UI設定・本文・outbox は入れない。

## 3. Record / filename

### 3.1 Record

- 永続 record は `name` (一意キー) と `text` (UTF-8 plain text、空文字有効) のみ。`kind` のような永続分類 column は持たない (File ID・revision・hash・device ID・作成/更新時刻の独立カラム・同期状態も持たない)。
- PC の一覧分類 (captured / external) は §3.6 の純粋関数を list 時に適用して導出する derived 値であり、永続化しない。Mobile に external は発生しないため分類の保持自体が不要。
- PC では時系列は name の prefix から導出する。外部editorによる本文変更・rename の有無は順序に影響しない。

### 3.2 filename format (正確な書式)

```text
YYYYMMDD-HHMM-<title>[~NN…].txt
```

- `YYYYMMDD-HHMM`: この端末で新規取り込みを開始した時刻の端末 local time (minute 精度)。ソート可能。固定 14 byte (ASCII)。
- `<title>`: 本文から導出される安全な短い名前 (§3.4)。上限は **64 code point かつ 234 UTF-8 byte** の両方 (byte 優先)。234 = 255 − 14 (prefix) − 3 (`~NN` 分) − 4 (`.txt`) であり、衝突 suffix を常に受けられる budget。
- `~NN…`: 同一 minute 内の衝突解決 suffix (§3.5)。2桁 zero-pad (`~01`) から始め、必要に応じ桁数を増やす。先頭候補には付かない。
- 拡張子は常に `.txt` (4 byte)。
- name 全体の UTF-8 byte 長は **255 以下**。これは初期対応 filesystem (ext4 / btrfs / xfs / APFS) の `NAME_MAX = 255 byte` を保証としたもの (**PROVISIONAL**, §16-1) であり、「255 byte なら常に安全」という普遍的主張ではない。
- code point 上限と byte 上限は別の制約として扱う。truncation は UTF-8 code point 境界で行い、切断のたびに UTF-8 byte 数を再計算して上限内へ収める (§3.4 step 6)。4-byte code point (絵文字等) だけでも 64 code point で 256 byte を超えるため、byte 上限が実質の制約になる。

### 3.3 timestamp 規則

- captured 時刻は **保存操作の開始時に一度だけ決める**。値は保存操作を開始した端末の local date/time であり、timezone offset・timezone 名は filename に埋め込まない。PC では client (browser) が local time の固定形式 (`2026-09-08T12:34:00`, minute 精度) として `POST /api/records` に添え、Go はそのまま filename に使う。Mobile は `Date` の local field から同じ形式に整形する。
- 同一操作の再試行 (uncertain 後の確認や再送) は同じ captured 時刻を使う。時刻を進めない (Baseline §4)。
- 保存が確定衝突で `~NN` へ進むときも時刻は進めない (Baseline §4「未来のminuteへ進めず」)。
- 不確実な再試行が既存名と衝突した場合、非上書きにより別名 (suffix) の重複 record が生じ得る。これは Baseline §7「まれなduplicateよりloss・overwriteを避ける」の許容に含める。UI は重複を隠さない。
- DST・timezone 変更・端末時計のずれにより local time の時系列は乱れ得る。全端末共通の絶対時系列は保証せず、順序の誤りは Baseline §4 の許容に含める。

### 3.4 title 導出 (純粋関数、PC = Go / Mobile = TS で同一規則)

入力: 本文 text。出力: title 文字列。言語依存の暗黙挙動 (JS `\s` の Unicode 差、Go `unicode.IsSpace` との差) を排除するため、対象集合をすべて明示する。

1. 改行で分割し、trim して非空になる最初の行を取る。全行空なら `"paste"`。
2. その行から、制御文字集合 `U+0000`–`U+001F`, `U+007F` と invalid 文字集合 `/ \ : * ? " < > |` を削除する。
3. 連続する空白を単一の半角スペース `U+0020` に畳み、前後の空白を削る。**空白集合は ASCII whitespace のみ**: `U+0009, U+000A, U+000B, U+000C, U+000D, U+0020`。Unicode whitespace は対象外。
4. 先頭の `U+0020` / `.` / `-` を、これらのいずれかが先頭に存在する限り繰り返し削除する (hidden file・option誤認の回避)。Unicode whitespace は対象外。
5. 空になったら `"paste"`。
6. 64 code point かつ 234 UTF-8 byte (§3.2) の両方を満たすまで、code point 境界で切り詰める。切断のたびに byte 数を再計算する。末尾が空白なら削る。

本文の正規化 (NFKC・改行変換・trim) は **行わない** (Baseline §4)。filename 導出にも Unicode 正規化を適用しない (実装差が大きく、衝突を増やすだけで利点がない)。

### 3.5 衝突規則

- 保存は常に create-only。既存名への書込み・置換は存在しない。
- 衝突検出時、`~01` から順に存在確認なしで試行する (PC: linkat の EEXIST、Mobile: IndexedDB `add` の ConstraintError が判定)。suffix は `~01`…`~99` と進み、100件目以降は桁数を増やして `~100`, `~101`… と続ける。停止条件は magic number ではなく name 全体の byte 制約 (§3.2) で決まる: suffix を付けると 255 byte を超えるなら `name_conflict` で失敗 (byte limit 優先)。実 I/O 失敗 (EEXIST 以外) は `io_error` で停止し、無制限 loop は存在しない。
- 2桁 zero-pad により 99 件までは lexicographic 時系列を維持する。100件以上の同一 minute 衝突では桁幅が混在し lexicographic 順の完全性は崩れる — これを明示的な許容とする (時刻 prefix は変わらないため大勢に影響しない)。

### 3.6 外部 file 分類 (純粋関数、両端末同一)

- captured 判定は filename 生成規則 (§3.2–§3.5) と同じ grammar を検証する純粋関数 `validateGeneratedFilename(name)` に一本化する。独立した captured 用 regex・日時妥当性確認は持たない。`validateGeneratedFilename` は生成規則の契約を完全に検証する: `YYYYMMDD-HHMM-` prefix、実在する年月日時分、title の存在、`.txt` 終端、optional suffix `~NN…` の grammar、UTF-8 有効性、name 全体の byte 上限 (§3.2)、filename として許可する文字条件。
- 分類契約:

```text
if validateGeneratedFilename(name):       → captured
else if safe root-direct-child regular .txt (§6.4 検証): → external
else:                                     → 対象外
```

- external は一覧で区別表示し、取り込み時刻は捏造しない。list・read・send・delete は captured と同一の操作系で扱う (§6.4 の safe root-direct-child name 検証)。非 `.txt` file は PC 一覧に表示しない (対象外)。
- 生成規則と分類規則で「ほぼ同じだが少し違う validator」を二つ持たない。TS / Go に意図的に重複実装する方針は維持し、共有 fixture (§13.1 の filename vectors) で一致を固定する。code generation・共有 runtime は追加しない。

### 3.7 受信時の命名

受信側は受信操作の開始時刻を自分の時計で取り、`YYYYMMDD-HHMM-…` を新規に生成する。送信元の name・作成時刻は継承しない (Baseline §4)。受信 record は受信端末では `captured` として分類される。

## 4. Browser UI

### 4.1 技術

- Vanilla TypeScript (strict) + Vite + 通常の HTML/CSS。framework・global store・独自 reactive system なし。
- 非同期結果は小さな discriminated union で表現する:

```ts
type Ok<T>  = { ok: true;  value: T };
type Err<E> = { ok: false; error: E };
type Result<T, E> = Ok<T> | Err<E>;

type SaveResult =
  | { kind: "saved"; name: string }
  | { kind: "failed"; cause: SaveCause }        // 保存未成立と確認できた失敗
  | { kind: "uncertain" };                       // commitした可能性があるが確認できない
```

- I/O は具体 module に閉じる: `storage/indexeddb.ts` (Mobile) / `storage/httpapi.ts` (PC) / `bridge.ts` (Bridge HTTP)。UI → facade → interface → binding という階層は作らない。
- view 間の連携は明示的な関数呼び出しのみ。例: capture の save 完了後、`capture.ts` が `listView.refresh()` を呼ぶ。event bus・observer は作らない。

### 4.2 build target と起動

- `build:pc` (`index.html` + `mode=pc`) と `build:mobile` (`mode=mobile`)。storage module だけが切替わる。同じ view・pure 関数・bridge client を共有。
- PC build は Go binary に embed される (§6.6)。Mobile build は信頼する HTTPS 配信元から配信される (§12)。

### 4.3 画面と操作

| 画面 | 操作 | 実装 |
|---|---|---|
| capture | textarea + 保存 | `saveNew()` 一関数で validate → commit → result → list refresh → render。成功は名前表示、失敗は入力保持 |
| list | 最近の record 一覧 | name 降順 (captured 時系列)。`external` は区分表示。選択で read view へ |
| read | 本文表示・copy・delete・send | 本文は plain text 表示 (`<pre>`、HTML実行なし)。copy は `navigator.clipboard.writeText`。delete は確認ダイアログ後 直接削除 |
| search | query 入力・結果 | §7 |
| transfer (send) | record 選択 → 送信 | §10.4 の手順。retry buffer は transfer view が所有 |
| transfer (receive) | incoming 一覧 → 明示取得・保存 | §10.5 |
| pairing | QR 表示 / QR 読取 | §9 |

### 4.4 ephemeral state の規則

- 古い非同期完了が新しい入力を壊さない: 各 save / send 操作は開始時に入力 snapshot を closure で持ち、完了時は自分の UI 領域だけを更新する。capture textarea は commit 対象に入らない。
- uncertain の表示: 「保存できた可能性があります。一覧を確認してください」+ refresh ボタン。自動再保存・自動成功表示・rollback はしない (Baseline §12)。
- 未保存 draft の reload 復旧は保証しない。reload 前に `beforeunload` で警告する。

## 5. Mobile storage (IndexedDB)

### 5.1 schema

- database: `spool`、version 1。
- object store: `records`、`keyPath: "name"`。index なし (name 順 iteration = captured 時系列)。
- record shape:

```ts
type StoredRecord = {
  name: string;            // primary key。§3.2 format
  text: string;            // UTF-8 plain text、空文字有効
};
```

- `kind` 等の分類 column は持たない (flat な name → text、Baseline §4)。Mobile に external は発生せず分類は常に captured であるため、導出値としても不要。
- directory emulation・階層・file 意味の模倣は入れない。

### 5.2 create-only save

- `recordStore.add(record)` を使用。既存 key では `ConstraintError` → §3.5 の suffix 再試行。
- 保存成功の判定は **transaction の `complete` event** のみ。個別 request の success では返さない (Baseline §6)。timeout は設けず、transaction 結果を待つ。
- 失敗時は入力を保持し、quota / unavailable の区別を表示に渡す。

### 5.3 list / read / delete

- list: `recordStore.getAllKeys()` (+ 必要なら `getAll()`)。key 順 = 時系列。取得は snapshot であり、以後の外部変更は追跡しない。
- read: `get(name)`。不在なら `not_found`。
- delete: readwrite tx で `delete(name)`。他端末へ伝播しない。復活しない。

### 5.4 export

- 1件: `Blob([text], {type: "text/plain"})` → download link、filename = `name`。
- 全件: 小さな実績ある zip library (STORE 無圧縮、transitive dependency なしの単一 library。例: client-zip 相当) で生成する。各 entry は普通の `.txt` (filename がそのまま entry 名)。自前 CRC32 / ZIP writer は持たない — 「依存ゼロ」のために archive format を自作しない (全件 export は Baseline §6 の必須機能であり、方式としてはこれが最小)。export は明示操作であり、Import・同期は追加しない。
- (解釈) Browser は複数 loose file をまとめて出せないため「全件」は zip 選択。1件は常に素の `.txt`。

### 5.5 quota / availability / offline

- 初回利用準備で `navigator.storage.persist()` を要求し、結果 (granted / denied) を表示する。永久保持・backup は保証しない。
- `QuotaExceededError` / `InvalidStateError` / private browsing 制約は `failed` として原因表示。別 store への自動退避はしない。
- offline app shell: 手書きの小さな service worker 1本。hashed asset を precache、cache-first / network-fallback。本文の第二正本・背景同期 queue には使わない。初回読込後は network なしで保存・閲覧可能。

## 6. PC Go process

### 6.1 構造

- 単一 binary (standard library 中心、追加依存は `golang.org/x/text` (NFKC) と `golang.org/x/sys/unix` (openat / unlinkat / linkat 等の POSIX primitive) のみ)。
- package 構成:

```text
pc/
  main.go                 // flag解析、root解決、token生成、server起動
  internal/config/        // 起動設定 (root, port, token) の純粋処理
  internal/namegen/       // filename / title / 分類 の純粋関数 (Go版 §3)
  internal/textcheck/     // text validation (UTF-8, 上限)
  internal/store/         // filesystem I/O (dirfd 基準の list/read/save/delete) 副作用のみ
  internal/server/        // HTTP handlers、token/Host/Origin検証、静的配信
  web/                    // embed した build済み PC UI
```

- 純粋処理 (namegen・textcheck・config validation) と I/O (store・server) を分ける。Result/Option 型・関数型 framework は作らない。error は通常の `error` + sentinel (`ErrNameConflict` 等)。

### 6.2 起動 / root selection

- `spool --root <dir> [--port N]`。`--root` は必須 (対話 prompt はしない)。
- 初回のみ `--init` を付けた場合に限り root directory を作成する。以後の起動で root が存在しなければ **エラーで停止** し、再作成しない (Baseline §5)。
- 設定の永続化は最小限: `~/.config/spool/config.json` (root, port)。CLI 引数が優先。本文の第二正本にはならない。
- root は起動時に open し、得た directory descriptor (dirfd) を process 生存中は operating root として保持する (**fd pinning**)。すべての filesystem 操作 (list / read / save / delete) はこの dirfd を基準とする directory-relative primitive (§6.6–§6.8) で行い、root path を組み立てた path-based operation は保存・読取・削除に使わない。
- root path の rename・置換・symlink 化が後から起きても、dirfd は元の directory inode を指し続けるため、**既に開いた dirfd の外へ出る操作は構造的に存在しない**。起動時の EvalSymlinks や各操作前の dev/ino 検査は boundary としては行わない。
- root path の置換検出は UX 要求として行う: 各操作の前に `stat(rootPath)` と `fstat(dirfd)` の dev/ino を比較し、不一致なら `root_changed` で全操作を停止する (Baseline §5「変更を検出したら操作を止める」)。この検出は race に対して best-effort であり、**閉じ込めの成立条件ではない** (閉じ込めは dirfd 基準操作そのもの)。
- bind: `127.0.0.1` のみ。port 既定は OS が選んだ空き port (`--port` で固定可能)。起動時に `http://127.0.0.1:<port>/#token=<token>` を端末へ出力する。

### 6.3 capability token / Host / Origin

- token: 起動ごとに 128-bit random → base64url。API の全 request に `X-Spool-Token` header を要求する。不一致は `401`。UI は `location.hash` から token を読み、以後の request に付ける。
- Host 検証: `Host` header が `127.0.0.1:<port>` と完全一致しなければ `403` (DNS rebinding 対策)。
- Origin 検証: state-changing request (`POST`, `DELETE`) は `Origin` header が `http://127.0.0.1:<port>` と完全一致することを要求。不一致・欠落は `403`。
- CORS: 一切発行しない (same-origin のみ)。wildcard CORS は禁止 (Baseline §13)。
- server log は method と path のみ。token・本文・query を出力しない。
- UI 静的配信に token は不要 (静的資産は機密でない)。API は全て token 必須。

### 6.4 API endpoint

| method | path | 成功 | 失敗 |
|---|---|---|---|
| GET | `/api/health` | `{"root": "...", "ok": true, "version": "..."}` | `root_missing` |
| GET | `/api/records` | `{"records":[{"name","size","kind"}]}` (name 昇順) | `root_missing`, `root_changed` |
| GET | `/api/records/{name}` | text/plain 本文 | `invalid_name`, `not_found` |
| POST | `/api/records` | `201 {"result":"saved","name":"..."}` | `invalid_input`, `invalid_name`, `name_conflict`, `too_large`, `root_*`, `io_error` |
| DELETE | `/api/records/{name}` | `204` | `invalid_name`, `not_found` |

- POST body: `{"text": "...", "captured_at": "2026-09-08T12:34:00"}`。`text` は UTF-8 ≤ 256 KiB (**PROVISIONAL**, §17)。`captured_at` は端末 local time (minute 精度、timezone offset は含めない) であり、grammar は `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$` の完全一致 + 暦有効のみ (他の ISO 8601 表記・`Z` 付き UTC は受けない。言語差を排除する)。未来時刻の拒否はしない — 時計の誤りは Baseline §4 の通り順序の誤りとして現れるものであり、server は補正しない。
- request/response は JSON (UTF-8)。list の `size` は byte 数。
- cache は `Cache-Control: no-store`。`X-Content-Type-Options: nosniff`。
- POST 応答 (成功・失敗とも) は body に `result`: `"saved"` / `"failed"` / `"uncertain"` を持つ (§6.6, §10.5)。client は HTTP status ではなく `result` で分類する。
- `{name}` path 参数の検証は 2 層に分ける: **safe root-direct-child name 検証** (read / delete / send 対象) は「単一 path component (`/`, `\`, NUL を含まない、`.` `..` でない) + UTF-8 + ≤255 byte + `.txt` 終端」。これを満たす限り §3.2 生成 format 外の external file も対象 (Baseline §5)。**generated filename validation** (`validateGeneratedFilename(name)`, §3.2–§3.5 の生成規則の完全検証) は分類 (§3.6) と POST 時の server 生成にのみ使う。

### 6.5 error taxonomy

```json
{"error": {"code": "name_conflict", "message": "..."}}
```

| code | 意味 |
|---|---|
| `invalid_input` | body・JSON・captured_at 不正 |
| `invalid_name` | name 形式不正 / path 区切り・traversal 含む |
| `not_found` | 指定 name 不在 |
| `name_conflict` | suffix 枯渇 |
| `too_large` | text 上限超過 |
| `root_missing` | root directory が存在しない |
| `root_changed` | root path と dirfd の dev/ino 不一致 (root path の置換検出)。停止は UX 要求であり、閉じ込めは dirfd 基準操作で維持される (§6.2) |
| `io_error` | 上記以外の filesystem 障害 |
| `forbidden` | token / Host / Origin 検証失敗 |
| `unavailable` | server 停止等 (client 側分類) |

HTTP status: 400 / 404 / 409 / 413 / 404(root_missing は 409 + code)… と code を併用。client は code で分岐し、status は参考値。

### 6.6 atomic / non-overwriting save

POSIX (初期対応環境。`golang.org/x/sys/unix` の openat / linkat / unlinkat / fstat / fsync を使用) の手順。すべての操作 (publish の linkat を含む) は dirfd (§6.2) 基準であり、root path を再解決しない:

1. validate (UTF-8 / 上限) → namegen (§3、`captured_at` は client 提供値)。
2. temp file を dirfd 基準で作成: `openat(dirfd, ".spool-tmp-<16hex>", O_CREATE|O_EXCL|O_WRONLY, 0644)`。書込み → `fsync` → `close`。
3. **publish**: `linkat(dirfd, tempBase, dirfd, final, 0)`。temp と final は共に、process lifetime で pin した **同一の root dirfd** 相対であり、publish 時に root path を再解決しない。`AT_FDCWD`・`AT_SYMLINK_FOLLOW` は使わない (`flags = 0`)。`tempBase` は step 2 の `openat` に渡したのと同じ dirfd 相対 temp 名である。既存名では `EEXIST` → suffix 候補へ (§3.5)。link は既存 entry を置換しないため、非上書き保証が原子操作で得られる。存在確認の後追い判定ではない (Baseline §5)。
4. publish 直後の補助検証: `openat(dirfd, final, O_RDONLY|O_NOFOLLOW)` → `fstat` し、step 2 で close 前に取得した temp の dev/ino と一致を確認する。temp と final は同一 dirfd 相対・`O_EXCL` 作成・無置換 link であるため、別物が link される経路は構造的に存在しない。不一致は内部不変条件の違反として `io_error` で停止する。この確認は補助検証であり、atomicity・閉じ込めの成立条件ではない (Baseline §5)。
5. `unlinkat(dirfd, temp)` (補償削除。atomicity の主張はしない)。
6. `fsync(dirfd)` (directory entry の flush)。ここまで完了して `201 {"result":"saved"}`。
7. publish (step 3) 成功後の障害 — directory fsync 失敗・応答書込み失敗・process crash — は、応答可能なら `result:"uncertain"` を返し、応答不能なら client 側で `uncertain` とする (§10.5)。publish 前の確認済み失敗 (validation / name_conflict / openat・linkat の EEXIST 以外の error) は `result:"failed"` + error code (§6.5)。

- temp file は通常記録として公開されない: 一覧は §3.6 の分類で `.spool-tmp-*` を対象外にする。加えて、起動時・一覧取得時に **全ての** `*.spool-tmp-*` 残骸を一覧対象外とする (削除はしない。手動整理の対象)。
- crash 時に final が link 済みなら本文は完成している (fsync 済み temp への link)。中途半端な本文は final に現れない。

### 6.7 symlink / root escape / 環境差

- 閉じ込めは dirfd 基準の directory-relative 操作で成立する (§6.2)。文字列 path 検証や事前 Lstat は boundary ではなく、早期 error 報告のための補助に過ぎない。
- read: `openat(dirfd, name, O_RDONLY|O_NOFOLLOW)`。symlink は `ELOOP` になり追従が構造的に不可能。open 後に `fstat` で regular file 確認 (`S_ISREG`) — directory・特殊 file は `invalid_name`。open と fstat の間に本体が差し替えられても、開いた fd の先は open 時点の実体であり、以後の read はその inode に閉じる。
- delete: `openat` + `fstat` で regular file 確認後、`unlinkat(dirfd, name, 0)`。unlinkat は symlink を追わず entry を削除する。確認後に対象が差し替えられた場合も、削除対象は dirfd 直下の指定 name の entry であり、root 外へ出ることはない。
- list: 起動時に保持した directory fd から `Readdirnames` (path 再解決なし) で entry 名を得、各 entry は `openat(..., O_NOFOLLOW)` + `fstat` で regular `.txt` のみ記録対象とする。entry Info の path-based lstat は使わない。
- name は server 側で生成するか、`{name}` path 参数は §6.4 の safe root-direct-child name 検証を通す。`/`, `\`, `..` は構造的に入り得ない。
- **Windows は初期対応外**: openat / O_NOFOLLOW / linkat の原子性を同じ形で提供できないため (§17)。初期環境では「普通のtext file が正本」の保証を Windows で宣言しない (Baseline §16-1)。
- Linux / macOS の差: 非上書き publish・no-follow の原子性は両 OS で同等。durability (fsync の power-loss 保証) は OS 差があり、macOS は `F_FULLFSYNC` を用いる。flush 保証の正は Linux とし、macOS の差分は §16-1 の初期対応環境確定時に明示する。

### 6.8 delete semantics

- `DELETE`: §6.7 の手順 (openat + fstat で regular file 確認 → unlinkat)。`204`。既に無ければ `not_found`。Trash・履歴・復旧は存在しない (Baseline §2)。
- delete 中の外部変更 (rename 済み等) は `not_found` で終了。追跡しない。

### 6.9 UI static serving

- `embed.FS` で `web/` を埋め込み、`/` 以下で配信。`/` は `index.html`、asset は immutable cache、`index.html` は no-cache。
- security header: `Content-Security-Policy: default-src 'self'; connect-src 'self'` (+ Mobile build 向け配信元は別途 §12)、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。

## 7. Search

### 7.1 正規化 (純粋関数、TS / Go で同一規則・共有 test vector)

- `normalize(s) = NFKC(s).toLowerCase()`。保存本文は変更しない。検索時のみ適用。
- Go: `golang.org/x/text/unicode/norm.NFKC` + `strings.ToLower`。TS: `s.normalize("NFKC")` + `toLowerCase()`。
- 両言語で結果が完全一致しない edge (NFKC version 差等) は共有 vector で検出する (§14)。

### 7.2 query

- query を空白で分割 → 各 term は normalize され、**全 term が AND substring 一致** を要求。
- 対象: 両端末とも name + 本文。Mobile は §7.3 の cursor 走査。PC は §7.4 の逐次 file 走査 — 明示的な検索操作時だけ、root 直下の対象 regular `.txt` (captured / external 双方) を読み込んで name + 本文を検索する。大規模・階層横断・複雑な検索は rg / shell / AI の責務 (Baseline §11)。UI はその案内を表示する。
- 永続 index なし。keystroke 毎の全本文再読込もしない。検索は明示実行 (Enter / button)。

### 7.3 Mobile 本文走査

- `records` store の cursor を name 順で読み、batch (100件) ごとに `await` で event loop へ譲る。各件で normalize → AND 判定。
- 結果は逐次 render。完了時に「全件走査完了」。読取失敗 record は「読取失敗」と表示し、不完全を「全件一致なし」としない。
- 中断: view が所有する cancel flag。新 query 入力で前走査を無効化 (stale 判定は generation counter)。

### 7.4 PC 本文走査

- 明示検索実行時のみ (§7.2)。list (§6.4, §6.7) で得た対象 regular `.txt` の各 name について、既存の `GET /api/records/{name}` で本文を逐次取得し、normalize(name) と normalize(本文) の両方に対して AND substring 判定する。新しい endpoint・server 側検索・永続 index・background indexing・recursive 走査は作らない。
- 取得は逐次 (並列 fetch しない) で、各件ごとに結果を render。batch ごとの yield・中断 (AbortController / generation counter) は §7.3 と同じ規則。keystroke 毎の自動検索はしない。
- 各 record の取得失敗 (HTTP error・検索中の削除等) は「読取失敗」と表示する。読取失敗・途中結果・完了を区別し、不完全な検索を「全件一致なし」と表示しない。完了時に「全件走査完了」。

## 8. Transfer / Bridge protocol

### 8.1 前提と原則

- Bridge は既存 Elixir/Phoenix を継続。本節は Bridge が提供すべき最小 endpoint 群を定義する (実装は Bridge 側作業であり、本 design の範囲外)。
- 既存 Bridge との差分は「route 追加」にとどまらない: v1 protocol 用の **新しい小さな domain / persistence** (session・transfer の state machine、authorization、atomic transition、cleanup) を既存 Elixir/Phoenix Bridge 内に追加する規模の作業である。legacy の resumable package / item model は再利用しない。Bridge を Go で rewrite することもしない (Baseline §17)。
- Bridge が扱うもの: session、authorization (Bearer token)、Transfer ID、TTL、size、opaque encrypted bytes、最小配送状態 (`pending` / `acked`)。
- Bridge が扱わないもの: 本文・file 意味・暗号解釈・download 履歴・受信端末の保存推定。
- size・時刻・一覧位置で送信結果を推測する設計は禁止。結果表示は exact Transfer ID と E2E 認証済み ack のみによる (Baseline §7)。

### 8.2 identifiers

- `session_id`: 16 random bytes。**pairing の initiator (A) が生成し、Bridge は生成しない**。wire / URL / API 上の表現は 32 文字 **lowercase hex** に固定 (canonical 表現は lowercase のみ)。内部 crypto / transcript / QR payload では raw 16 bytes を使う (§9.2.1, §9.3)。`join_capability` が `session_id` を入力に取るため、initiator は `POST /v1/sessions` の前に `session_id` を確定させる (§9.2)。
- `transfer_id`: 16 random bytes、hex 32 文字。**送信側 client が payload 公開 (upload) 前に生成** し、envelope AAD に束縛する (Baseline §7「payload公開前にexactなTransfer IDを確定」)。
- token: 各 role ごとに 1本 (§8.4)。`Authorization: Bearer <token>`。

### 8.3 endpoints

| method | path | 用途 |
|---|---|---|
| POST | `/v1/sessions` | session 作成 (initiator)。body: `{"session_id": "<32 hex chars>", "expires_at": ..., "join_capability": ...}`。`session_id` は **initiator が事前に生成した値**であり、response で Bridge が生成するものではない。response: `{"session_id", "token", "role":"a"}` — response の `session_id` は新規生成値ではなく、Bridge が登録した client 指定値の echo (confirmation)。`join_capability` = base64url(HMAC-SHA256(pairing_secret, "spool-join/v1" \|\| session_id))。Bridge は `session_id` を検証 (32 文字 lowercase hex、decode 後 16 byte) し一意キーとして登録、`join_capability` を 1 回受理用にその session に結び付けて保存するだけ (`pairing_secret` 自体は知らない、§9.2)。既存 `session_id` との競合は DB の一意制約で拒否し上書きしない (§8.3.1) |
| POST | `/v1/sessions/{sid}/join` | joiner が role b を主張 (一回限り)。body: `{"join_capability"}`。capability 一致のみ受理 → `{"token", "role":"b"}`。session_id は公開 identifier であり、capability が authorization そのもの (QR 由来・session_id から分離) |
| GET | `/v1/sessions/me` | 自 session の状態確認 (`{"session_id","expires_at","paired":bool,"closed":bool}`)。reload 復帰の検証に使う |
| DELETE | `/v1/sessions/me` | 取消。全 transfer を即時 purge、以後の認証を 401 |
| POST | `/v1/sessions/{sid}/handshake` | pairing handshake message (opaque bytes) の投稿。role token 必須。1 role 1 message。同一 role 再投稿は同一 bytes のみ許可、異 bytes は `409` (差し替え防止) |
| GET | `/v1/sessions/{sid}/handshake` | 相手の handshake message 取得 (不在は 404) |
| POST | `/v1/transfers` | 暗号 payload upload。body: envelope v1 の raw bytes |
| GET | `/v1/transfers?box=in\|out` | 自 role の受信箱 / 送信一覧 `[{"transfer_id","size","created_at","state"}]` |
| GET | `/v1/transfers/{tid}` | payload 取得 (反復可能・非破壊) |
| POST | `/v1/transfers/{tid}/ack` | ack 投稿 (opaque ack envelope)。receiver role のみ。同一 bytes 再 POST は `200` / 異 bytes は `409` (§8.3.1) |
| GET | `/v1/transfers/{tid}/ack` | ack 取得 (送信側)。反復可能 |

- upload の冪等性: 同一 transfer_id + 同一 bytes の再 POST → `200` (既存登録)。同一 id で異なる bytes → `409 conflict_error` (Baseline §7「同IDの異なるbytesは拒否」)。bytes 同一性は SHA-256 比較。
- ack の冪等性: 同一 transfer への同一 ack bytes 再 POST → `200`。異なる ack bytes → `409`。ack bytes と state 遷移は同一 transaction (下記)。Bridge は ack bytes を復号せず SHA-256 比較のみ行う。

#### 8.3.1 atomic state transition (同時実行の線形化)

- **upload**: HTTP body を完全に受信し size 検証を通過させ、単一の atomic insert (transfer 一意制約付き) で記録してから inbox / outbox に公開する。**body が途中で切断・中断された場合、transfer は生成されず一覧に現れない**。
- **concurrent upload** (同一 transfer_id): read-then-insert は行わない。DB の一意制約を線形化点とし、先着 1 件のみ insert に成功する。後着は同 bytes → `200`、異 bytes → `409`。race で双方が成功することはない。
- **session invalidation** (cancel / expiration): `active → closed / expired` への単一の atomic 遷移とし、**全 endpoint (upload / ack / join / handshake / GET) は同一 transaction 内で session status を検証する**。invalidation 成立後の新規 upload / ack / join は成功しない (`401` / `410`)。cancel・expiration と upload・ack の競合は transaction 順序で線形化され、いずれかが勝つ (Baseline §7「session失効・取消は先に適用」)。
- **session create** (initiator): client 生成 `session_id` の一意制約を DB の線形化点とし、既存 ID を置換しない。read-then-insert 型の locking は行わない。
- **ack**: receiver role (送信者でない方) の token のみ POST 可能。`state: pending → acked` への遷移と ack bytes の保存は同一 transaction で行う。**`acked` なのに ack GET が 404 になる状態は存在しない**。
- join は 1回限り。capability 不一致・2 回目の join は `403`。

### 8.4 authorization / roles

- role `a` = initiator (session 作成者・QR 表示側)、role `b` = joiner (QR 読取側)。各 role 専用 token。
- `box=in` は「相手 role が送信した transfer」、`box=out` は「自 role が送信した transfer」。
- ack POST は transfer の recipient role の token のみ受理。sender からの ack POST は `403` (§8.3.1)。
- Bridge は role token の検証と box 分類のみを行い、暗号 envelope の direction byte を解釈しない (不整合は受信側 client の negative validation で弾く)。

### 8.5 TTL / quota / cleanup / retry

| 項目 | 既定値 (**PROVISIONAL** — Baseline §16 の製品判断で確定。wire format・security invariant はこれらの値に依存しない) |
|---|---|
| transfer TTL | 24 時間。upload 完了から起算 |
| session TTL | 7 日。作成時に initiator が宣言、上限は Bridge 設定 |
| payload 上限 | 256 KiB + 128 byte (envelope overhead) |
| session 同時 transfer 数 | 32 (inbox + outbox 合計)。超過は `429` |
| rate limit | session ごと 60 upload / 時間。`429` |

- 期限切れ transfer: GET / 再送 / ack すべて `410 gone`。Bridge の periodic sweep (既定 1時間毎) が payload と状態を削除する。cleanup の稼働は保証対象 (Baseline §7)。
- **retry で TTL を延長しない**。upload の再試行 (同一 id・同一 bytes) も残り時間を変更しない。
- `410` を受けた送信側は「期限切れ — 新規送信が必要」と表示する。同一操作の再開を装わない (Baseline §8)。
- Bridge は backup ではない。期限後の復活要求は常に拒否。

### 8.6 送信結果の意味

| Bridge 状態 | 送信側 UI 表示 |
|---|---|
| upload 済み (`pending`) | 「送信済み (相手の保存未確認)」 |
| `acked` (E2E 認証済み ack を取得済み) | 「相手に保存済み」 |

Bridge の `acked` flag は表示の trigger に過ぎず、表示の根拠は client が取得・検証した ack envelope の E2E 認証 (§9.7) である。Bridge 応答だけを根拠にしない。

## 9. E2EE / pairing

### 9.1 選択した方式 (単一 suite、negotiation なし)

| 要素 | 選択 | 理由 |
|---|---|---|
| 鍵合意 | ECDH P-256 (Web Crypto / Go stdlib / libsodium 全て native) | browser 実装確実性。X25519 の WebCrypto 対応差を避ける |
| KDF | HKDF-SHA256 | Web Crypto / x/crypto / libsodium 全て対応 |
| AEAD | AES-256-GCM (96-bit random nonce, 128-bit tag) | 同上。boring で実績十分 |
| 鍵確認 | HMAC-SHA256 | 同上 |

自作 primitive なし。複数 suite・plugin cipher・negotiation なし (Baseline §8)。

### 9.2 pairing 手順 (authenticated、QR)
1. **initiator (A)**: 以下の順に実行する (`session_id` は POST 前に確定する一本道。Bridge から `session_id` を受け取る段階は存在しない):
   1. `session_id` を 16 random bytes 生成 (§8.2)。
   2. `pairing_secret` を 32 random bytes 生成。
   3. session 専用 P-256 keypair (`A_static`) を生成 (永続 device identity ではない)。
   4. `join_capability` を計算: `HMAC-SHA256(pairing_secret, "spool-join/v1" || session_id)` (§8.3)。
   5. `POST /v1/sessions` に `{session_id, expires_at, join_capability}` を提出 (§8.3)。
   6. Bridge から role a token を受け取る。
   7. QR canonical payload を生成して表示:
   `version | bridge_base_url | session_id | A_static_pub (65B uncompressed) | pairing_secret (32B) | expires_at`
   QR の secret は 32-byte `pairing_secret` 1本のみ (`join_secret` は存在しない)。QR の内容は Bridge を経由しない。Bridge は `A_static` も `pairing_secret` も知らないため差し替え不能 (Baseline §8, §13「QRの秘密をBridgeへ送信しない」)。QR payload の canonical byte encoding は §9.2.1 で固定する。
2. **joiner (B)**: QR を読取し、canonical bytes として decode (§9.2.1)。bridge_base_url を canonical form 検証 (§9.2.1: HTTPS のみ・非空 host)。`POST /join` に `join_capability` を提出 → 1回だけ受理され role b token を取得 (§8.3)。ephemeral P-256 keypair (`B_eph`) を生成。`X = ECDH(B_eph_priv, A_static_pub)`、canonical transcript `T` と鍵導出 (§9.3)。`confirm_b = HMAC-SHA256(K_confirm_b, T || 0x62)`。handshake message `{B_eph_pub (65B), confirm_b}` を Bridge へ投稿。
3. **A**: handshake を取得。`X = ECDH(A_static_priv, B_eph_pub)`、QR の内容 + 受け取った `B_eph_pub` から `T` を組み立て鍵導出。`confirm_b` を検証 → 失敗なら pairing 中止 (本文は送らない、Baseline §8)。成功なら **A は B を認証したことになる**: `confirm_b` は `pairing_secret` (QR 由来) と `X` (ECDH 参加証明) の両方の知識証明であり、Bridge が handshake を攻撃者のものへ差し替えても `pairing_secret` を知らず MAC を偽造できない。`confirm_a = HMAC-SHA256(K_confirm_a, T || 0x61)` を投稿し、A の peer-B `confirmed` (local) を `true` にする。この時点から A は B 向け本文を送信できる。
4. **B**: `confirm_a` を検証 → 成功で B の peer-A `confirmed` (local) を `true` にする (B→A 認証: `confirm_a` は `A_static_priv` と `pairing_secret` の知識証明)。この時点から B は A 向け本文を送信できる。`confirmed` は「この端末が相手の authenticated confirmation を検証済み」という **各端末の local state** であり、shared/global な状態ではない。A が B 向け送信可能になる時点は `confirm_b` 検証成功の瞬間、B が A 向け送信可能になる時点は `confirm_a` 検証成功の瞬間。**相手側が自分の confirmation を検証済みであることの追加確認 (third confirmation・confirmation ack・追加 endpoint・polling・shared confirmed state) は要求しない**。

- 認証の根拠: `A_static` は QR (端末間直接確認経路) 由来、`B_eph` は transcript MAC で証明、B の正当性は `pairing_secret` (QR 由来) + ECDH 参加の知識証明。Bridge が観測・差し替えできる値 (session_id・公開鍵・handshake message) だけでは confirm MAC を偽造できない。unknown-key-share・role confusion・MITM・session substitution・handshake 差し替えはいずれも MAC 検証で失敗する。
- pairing が認証するのは「QR の認証材料を保持し、対応する ECDH 参加を証明した peer」である。QR を読めた相手を authorized peer として扱い、特定の物理端末 identity の証明はしない。QR 読取を超える表示コード・手入力確認・永続 device identity は追加しない。
- confirmation gate は local state であり、local `confirmed` でない相手からの data は正規の本文として受理・保存しない (§9.10)。remote peer 側の local `confirmed` を観測する必要はなく、そのための機構は作らない。
- 接続コード等の発見用 short code は鍵認証の代わりにならない (Baseline §8)。本 protocol では short code を使わない。
- QR / pairing 材料 (秘密鍵・`pairing_secret`・confirm 鍵) は Bridge へ送信しない。Bridge へは `pairing_secret` から導出した `join_capability` のみを提示する (§8.3)。用途分離: join 認証は `HMAC-SHA256(pairing_secret, "spool-join/v1" || session_id)`、E2EE salt 導出は §9.3 の `e2ee_salt`。

#### 9.2.1 QR payload canonical byte format (v1)

QR が保持する logical fields は §9.2 の 6 項目。wire 上の canonical bytes は以下で一意に固定する (JSON / CBOR / protobuf / ASN.1 / 汎用 serializer は使わない。小さな固定 binary format):

```text
magic               16 byte  ASCII "spool-pairing/v1"
version             uint8    0x01
session_id          16 byte  raw
A_static_pub        65 byte  P-256 uncompressed SEC1 (0x04 || X(32B) || Y(32B))
pairing_secret      32 byte  raw
expires_at          uint64   big-endian, Unix epoch seconds
bridge_url_length   uint16   big-endian
bridge_base_url     可変長   canonical UTF-8 bytes (byte length == bridge_url_length)
```

- decode は厳密一致のみ: magic / version 不一致、field 順序変更、trailing garbage、truncated payload、`bridge_url_length` と実 byte 数の不一致はすべて拒否する (negative test, §13.1)。
- `bridge_base_url` の canonical rule: UTF-8、`https://` のみ、userinfo 禁止、fragment 禁止、query 禁止、host 必須、scheme / host は lowercase、default HTTPS port `:443` は省略、path が空なら `/`。trailing `/` は canonical form から除去する (path が `/` のみの場合を除く)。複数の表現が同じ URL として通らない。URL normalization framework は作らず、上記 rule のみを実装する。
- QR 表示前 (initiator) と QR 読取後 (joiner) の双方が同じ canonical bytes を生成できることを共有 test vector で固定する (§13.1)。

### 9.3 鍵導出

```text
T (canonical transcript bytes) =
  magic               19 byte  ASCII "spool-transcript/v1"
  version             uint8    0x01
  session_id          16 byte  raw
  A_static_pub        65 byte  P-256 uncompressed SEC1
  B_eph_pub           65 byte  P-256 uncompressed SEC1
  expires_at          uint64   big-endian, Unix epoch seconds
  bridge_url_length   uint16   big-endian
  bridge_base_url     可変長   canonical UTF-8 bytes (§9.2.1 の canonical form)

X         = ECDH shared secret (32B, P-256 x-coordinate)
e2ee_salt = HMAC-SHA256(key = pairing_secret, data = "spool-e2ee-salt/v1")
PRK       = HKDF-Extract(salt = e2ee_salt, IKM = X)
ht  = SHA-256(T)
K_a2b       = HKDF-Expand(PRK, "spool/v1/a2b-key"   || ht, 32)  // A→B 送信用 AES-256-GCM key
K_b2a       = HKDF-Expand(PRK, "spool/v1/b2a-key"   || ht, 32)  // B→A 送信用
K_confirm_a = HKDF-Expand(PRK, "spool/v1/confirm-a" || ht, 32)  // HMAC key
K_confirm_b = HKDF-Expand(PRK, "spool/v1/confirm-b" || ht, 32)
confirm_x   = HMAC-SHA256(K_confirm_x, T || role (1B))  // role: 0x61 ("a") / 0x62 ("b")
```

- transcript binding: 両公開鍵・session_id・expires_at・bridge_base_url・version が canonical bytes T として KDF (ht 経由) と確認 MAC (T) の両方に束縛される。role は confirm MAC の role byte と direction 鍵分離で束縛する。文字列連結・delimiter・JSON serialization には依存しない。T の生成は TS / Go / test vector で完全一致させる (§13.1)。
- domain separation: `pairing_secret` を直接 HKDF salt に流用せず、E2EE 用途を明示した `e2ee_salt = HMAC-SHA256(pairing_secret, "spool-e2ee-salt/v1")` を salt とする。「QR を読んだ者だけが鍵を導出できる」はこれで成立する。join capability (`"spool-join/v1"`) と salt 導出 (`"spool-e2ee-salt/v1"`) の用途分離は label で行う。Bridge は `pairing_secret` を知らないため、handshake を覗き見・差し替えしても鍵も confirm MAC も導出できない。
- direction separation は鍵分離 + envelope の direction byte (AAD) の二重 (Baseline §8「送受信方向を暗号認証で結び付け」)。
- Bridge 認証 credential (Bearer token) と本文暗号鍵は別物。混同しない。

### 9.4 envelope format v1 (payload / ack 共通の wire format)

```text
offset  size  field
0       1     version = 0x01
1       1     purpose: 0x01=data, 0x02=ack, 0x03=handshake(not used in envelope)
2       16    session_id
18      1     direction: 0x01=A→B, 0x02=B→A
19      16    transfer_id
35      12    nonce (random 96-bit)
47      ...   AES-256-GCM ciphertext (plaintext || 16B tag)

AAD = bytes 0..34 (version..transfer_id)
```

- data message の plaintext: UTF-8 本文 bytes (変換・trim なし、Baseline §4)。
- ack message の plaintext: 1 byte `0x01` (「保存済み」のみ。transfer_id は AAD で束縛済み)。ack は transfer に結び付いた E2E 認証済みメッセージであり、Bridge には opaque (Baseline §8「受信端末が保存後に生成するTransferに結び付いたE2E認証済みack」)。
- payload format version は 1 byte。`version ≠ 0x01` は key を使わず拒否 (negative validation)。
- payload 上限: ciphertext ≤ 256 KiB + 128 B。plaintext 上限: 256 KiB。復号後 UTF-8 不正は拒否。

### 9.5 session / reload recovery (sessionStorage)

- 格納先: 同一 origin の **tab 単位** `sessionStorage`、key `spool-session`。
- 内容 (JSON): `{v:1, role, session_id, bridge_url, bridge_token, expires_at, confirmed (local confirmation gate, §9.2), keys:{a2b,b2a}}`。
- 復帰手順 (同一タブ reload):
  1. JSON parse 失敗・`v` 不一致 → 破棄、新規 pairing を要求。
  2. `expires_at` が過去 → 破棄、新規 pairing。
  3. `confirmed !== true` → 破棄。
  4. `GET /v1/sessions/me` で Bridge 側の有効性・`expires_at` 一致を再検証。401 / 不整合 → 破棄。
  5. 全て通過時のみ送受信を再開。
- これは端末上の秘密保持であり XSS 対策ではない (Baseline §8)。整合しない復帰情報から鍵や credential を推測再利用しない。
- タブ終了・browser 再起動後の復帰は保証しない。sessionStorage が復元された場合も上記検証を経る。
- **複製タブ**: sessionStorage は複製されるため、2 タブが同一鍵を持つ。これに依存しない nonce 方式 (§9.6) で安全性を保つ。複製タブの UX (双方からの送信は可能、双方が同一 transfer を retry し得る) は duplicate 許容の範囲。

### 9.6 nonce strategy

- 96-bit nonce は **メッセージごとに Crypto.getRandomValues で無作為生成**。counter・seq・allocation state は使わない。
- したがって nonce の非再利用は **絶対保証ではなく確率的受容** である: 同一鍵で N message 送った場合の衝突確率は ≈ N² / 2^97 (N = 2^16 で ≈ 2^-65、N = 2^32 でも ≈ 2^-33)。session TTL 内の message 数では無視できる水準であり、counter リセット (reload・複製タブ) に依存しない。96-bit random nonce と衝突確率の受容は Baseline §8 の製品判断として確定した契約であり、本書はその実装方式を固定する。
- state を持たないため 2^16 送信上限のような厳密な強制は存在しない。同一鍵あたり 2^16 message を大きく超える送信は想定しない (**advisory** であり、UI 強制・counter state はしない)。

### 9.7 ack 認証

- 受信側は保存 commit 成功後のみ ack を生成 (Baseline §7)。ack = envelope v1, purpose `0x02`, direction = 受信方向の逆, 同一 transfer_id, `K_b2a`(または `K_a2b`) で暗号化。
- 送信側は `GET /v1/transfers/{tid}/ack` で bytes 取得 → header 検証 (version / session_id / direction / transfer_id が自送信と一致、**かつ `purpose == 0x02` の厳密一致**) → 復号 (期待 purpose を AAD に含める) → plaintext `0x01` 確認で「相手に保存済み」表示。
- 偽 ack・他 transfer の ack 差し替えは AAD 検証で失敗する。

### 9.8 expiration / revocation / key loss

- 期限: `expires_at` は pairing 時に認証材料とともに共有され、両端末がローカル検証する。Bridge 応答・reload で延長しない。期限到来で鍵・復帰情報を破棄し、送受信停止。
- 取消: `DELETE /v1/sessions/me` → Bridge が transfer を purge、双方の token を無効化。相手は 401 を受けた時点で鍵を破棄し「session は終了しました」を表示。既に相手が得たコピーの回収は保証しない (Baseline §8)。
- 鍵喪失・侵害: 旧 session の再開を装わない。信頼する端末間で新規 pairing。既存ローカル copy は変更しない (Baseline §12)。

### 9.9 retry with same ciphertext

- 送信側は生成済み暗号 envelope bytes をメモリに保持し、upload 失敗時は **同一 bytes・同一 transfer_id** で再送する。再暗号化しない (Baseline §8)。
- envelope bytes を失った (タブ閉じ・reload) 場合は新規送信として扱い、新 transfer_id・新 nonce で暗号化し直す。装って再開しない。永続 outbox は作らない。
- 同一 payload 再送の許可と自動再保存は別物。受信側の自動再保存は一切しない (Baseline §8)。

### 9.10 negative validation (受信側の拒否規則、保存も ack もしない)

1. envelope size 上限超過 → 拒否。
2. `version ≠ 0x01` → 拒否。
3. `session_id` が自 session と不一致 → 拒否。
4. `direction` が自受信方向不一致 (鍵対応も不一致) → 拒否。
5. `purpose` 期待値不一致 → 拒否。data 受信側は `purpose == 0x01` のみ、ack 検証側は `purpose == 0x02` のみを受ける (「未知 purpose の拒否」に加えて **期待 purpose の厳密一致** を要求。data と ack の差し替え拒否、Baseline §8)。期待 purpose は AAD に含めて復号するため、header 書き換えは GCM tag 検証でも失敗する。
6. GCM tag 検証失敗 → 拒否。
7. plaintext UTF-8 不正 / 上限超過 → 拒否。
8. handshake MAC 検証失敗 → pairing 中止。
9. 自端末の peer `confirmed` (local) が成立する前に相手から届いた data → 拒否 (正規の本文として受理・保存しない、ack もしない)。§9.2 の local confirmation gate。

拒否時は原因を表示するが、Bridge への ack・自動再試行はしない。payload は TTL まで Bridge に残り、明示再取得が可能。

## 10. State / operation flows

一操作の流れを一か所で読める関数として書く。subscriber / effect 連鎖なし (Baseline §9)。

### 10.1 save (共通)

```text
saveNew(input):
  snapshot = {text: input.text, capturedAt: nowMinute()}   // 再試行で時刻を進めない
  result = storage.save(snapshot)                          // create-only commit
  switch result:
    saved(name)    → listView.refresh(); render saved(name)
    failed(cause)  → render failed(cause); input 保持
    uncertain      → render uncertain (「一覧を確認してください」)
```

### 10.2 send

```text
send(recordName):
  text = storage.read(recordName)                // 現在の内容。古いsnapshotを書き戻さない
  tid = random16()                                // 公開前に確定
  bytes = seal(envelope{data, session_id, direction, tid}, K_send, randomNonce())
  loop: POST /v1/transfers (bytes)                // 失敗→メモリ保持し retry 同一bytes
  state = "sent (ack 待ち)"
  poll GET /v1/transfers?box=out → state=="acked" → GET ack → verify → "相手に保存済み"
```

- poll は transfer view が開いている間のみ。背景常駐 polling はしない。

### 10.3 receive

```text
receiveTransfer(tid):
  bytes = GET /v1/transfers/{tid}                 // 非破壊・反復可能
  openEnvelope: header 検証 → decrypt → UTF-8/上限検証     (§9.10、失敗→保存もackもしない)
  preview 表示
  user 明示 save:
    r = saveNew({text, capturedAt: nowMinute()})  // 受信側で新規命名
    r == saved(name) → POST ack (envelope v1 ack) ; render saved(name)
    r == failed     → ack しない。TTL 内なら再取得可能
    r == uncertain  → ack しない。重複可能性を表示
```

### 10.4 failure flows (Baseline §12 の対応)

| 状況 | 具体挙動 |
|---|---|
| save response loss (PC HTTP timeout) | client は `uncertain` 表示。自動再送しない。一覧確認は明示。再試行は同名衝突→重複の可能性を説明 |
| 次の入力が旧 save 完成前に到着 | 操作ごとに snapshot closure。旧完了は自 UI 領域のみ更新。新入力を消さない |
| Bridge upload failure | 暗号 bytes をメモリ保持、同一 bytes 再試行。タブ終了で bytes 失失→新規送信へ |
| decrypt failure | 拒否表示。保存しない・ack しない。TTL 内は再取得可 |
| local save failure (受信後) | ack しない。TTL 内の再取得でやり直し。復号本文の退避 queue は作らない |
| ack failure (network) | ローカル保存は維持、「saved (ack unknown)」表示。メモリ上の pending ack は同タブ内で再試行 |
| ack 失敗後の reload | pending ack はメモリのみのため消失。送信側は ack 待ち timeout → 再送すると重複可能性。受信側で再受信した場合「重複の可能性」を表示し、自動再保存しない。明示保存なら新規 copy |
| session 期限切れ | 送受信 UI を停止、鍵破棄、新規 pairing を促す。期限の延長はしない |
| key loss / 侵害 | 復旧を装わない。新規 pairing。既存ローカル copy は変更しない |
| root 消失・quota 超過 | 操作停止 + 原因表示。自動 fallback なし |

### 10.5 uncertain の型

- PC: server の POST 応答は必ず `result: "saved" | "failed" | "uncertain"` を持つ (§6.4, §6.6)。client は HTTP status ではなく `result` で分類する。
  - publish (linkat) 前の確認済み失敗 → `failed` + error code。入力保持。
  - publish 成功後の障害 (directory fsync 失敗・応答書込み失敗) → server は応答可能なら `uncertain` を返す。応答自体が得られない場合 (timeout / 接続断) も client は `uncertain`。
  - failed / uncertain の区別は server 内部の publish phase 追跡による。HTTP status のみに意味を持たせない。
- Mobile: transaction `error` は `failed`、`complete` 前のタブ終了等は次回起動時に確認不可 → 該当操作の UI はもう存在しないため表示問題なし。

## 11. Security boundaries

| 境界 | 保証 | 保証しない |
|---|---|---|
| Go process | loopback only、token + Host + Origin 検証、root 直下のみ (dirfd pinning + directory-relative 操作で閉じ込め)、symlink 非追従 (O_NOFOLLOW)、非上書きは dirfd 相対 linkat の原子性 | OS level の他 process 侵害、root 外の本文保護 |
| Mobile storage | IndexedDB は origin 内、`navigator.storage.persist()` 要求 | browser eviction・サイトデータ削除・private browsing (明示で警告) |
| Bridge | HTTPS 必須、opaque bytes、TTL・size・rate 検証、credential/鍵/QR秘密を query・log に出さない | malicious 運営者、backup 物理消去、traffic analysis、遅延・破棄 |
| E2EE | malicious Bridge に対する本文機密性・完全性、偽ack・取り違え拒否 | 端末侵害、UI 改竄 (下記) |
| UI delivery | §12 | 改竄された UI は平文・鍵を読み得る |
| 本文表示 | 常に plain text。外部 HTML 実行なし。貼付 text も非信頼入力 | 将来 preview を追加しても保存 text と境界は変更しない |

- CSP `default-src 'self'`、`nosniff`、`Referrer-Policy: no-referrer` を両配信形態で設定。
- 自分で貼った text も HTML として解釈しない。render は `textContent` のみ。

## 12. UI delivery trust

| 配信 | 形態 | 信頼の根拠 | 境界の明示 |
|---|---|---|---|
| PC UI | Go binary が localhost 配信 (embed) | ユーザーが実行した binary の真正性 | 実行物の入手経路 (OSS build / self-build) はユーザー責任。公開ソースだけで真正性は保証されない (Baseline §15) |
| Mobile UI | ユーザーが選択した HTTPS origin (公式 hosted または self-host) | TLS + 配信元の運営者 | origin 変更 = browser storage・session・鍵の別世界。自動共有を装わない |
| Bridge | 既存 Elixir/Phoenix (hosted / self-host) | HTTPS、opaque bytes | E2EE は Bridge 改竄に耐えるが UI 改竄には耐えない |

- E2EE の限界を UI にも明記: 配信された UI が改竄されていれば、復号前の text・鍵は攻撃者に読める。malicious UI delivery 対策 (署名付き配信・更新検証 framework) は本設計では作らない (Baseline §13「巨大なsoftware supply-chain systemは設計しない」)。信頼境界として明示するにとどめる。
- hosted Mobile UI と self-host Mobile UI は同一 build・同一 E2EE 契約。hosted 分岐で suite を増やさない。
- Mobile UI と Bridge は別 origin になり得る (hosted Mobile UI + self-host Bridge 等)。この browser 境界は次で閉じる:
  - Bridge URL は HTTPS のみ。QR の `bridge_base_url` は §9.2.1 の canonical form (UTF-8、`https://` のみ、userinfo / fragment / query 禁止、非空 host) を検証し、canonical form 外は pairing を拒否する。
  - Bridge CORS: 許可 origin を Bridge 設定の exact 文字列リストとして持ち、`Access-Control-Allow-Origin` は一致した 1 origin のみ返す。wildcard `*`・Origin の unconditional 反射は禁止 (Baseline §13)。
  - Mobile UI CSP: `default-src 'self'; connect-src 'self' <許可 Bridge origin>`。許可 origin は Mobile UI 配信元が設定に応じて埋め込む (hosted は運営者の Bridge、self-host は運営者の設定 1 行)。dynamic CSP framework は作らない。
  - self-host を壊さない: Bridge 側許可リストと Mobile UI 配信側 connect-src は、同一運営者が 2 か所に同じ origin を書くだけで完結する最小構成 (Baseline §15)。

## 13. Testing

fake だけで完成判定しない (Baseline §14)。優先順: 実境界 > contract test > 単体。

### 13.1 pure unit (TS / Go 共通)

- **共有 fixture**: `test/vectors/` に JSON で固定し、TS と Go の両方から読む。
  - `filename.json`: title 導出 (空本文・記号・絵文字・長行・control文字)、衝突 suffix、**byte 上限 (4-byte code point のみで 64 個、234 byte 境界の truncate、suffix 追加時の 255 byte 超えで `name_conflict`)**、`validateGeneratedFilename` 分類 vector: 正当 generated filename → captured、正当 suffix 付き → captured、日時不正 (実在しない年月日時分) → external、suffix grammar 不正 → external、`.txt` だが generated grammar 外 → external。external の safe root-direct-child regular `.txt` が read / send / delete 可能であることは既存契約のまま (変更しない)。
  - `search.json`: NFKC + case の正規化 (全角/半角、濁点、ラテン大文字小文字) と AND 一致。
  - `e2ee.json`: 固定 P-256 鍵・固定 nonce からの envelope 全 bytes hex、QR payload canonical bytes、canonical transcript `T` canonical bytes、`join_capability`、`e2ee_salt`、`confirm_a` / `confirm_b`、ack envelope — 同じ logical input から TS 実装と参照 vector が完全一致。不正ケース (各 AAD byte 改竄、**transcript 要素 (公開鍵・expires_at・bridge_base_url・role) 改竄**、direction/transfer_id/session/version/**purpose** 取り違え、非UTF-8、超過) の期待「拒否」。
  - `pairing-wire.json` (negative): QR payload / transcript の期待「拒否」ケース — field 順序変更、`expires_at` byte order 変更、URL 非 canonical 表現、public key byte 変更、session_id 変更、URL 長不一致、trailing garbage、truncated payload。
- 単体の所在: `namegen` (Go) / `pure/filename.ts` `pure/search.ts` (TS) / `transfer/protocol.ts` (encode/decode)。

### 13.2 real IndexedDB browser test (Playwright)

- 実 Chrome で実行。fake-indexeddb は完成判定に使わない。
- 保存 → 実 store を直接読み、reload 後も同じ text。同名並行作成で既存本文が変わらない。`add` の ConstraintError からの suffix 確認。transaction 失敗時の未保存表示。

### 13.3 Go temporary directory test

- `t.TempDir()` root で: save → 実 file を直接読む。**publish が dirfd 相対 linkat (`AT_FDCWD`・`AT_SYMLINK_FOLLOW` 不使用、root path 再解決なし) であること**。linkat による非上書き (並行同時 create の race test 含む)。symlink / directory / `.spool-tmp-*` の一覧除外。**O_NOFOLLOW 読取の symlink 拒否。操作中に root path を rename / 置換する注入で、保存 (publish を含む) が開いた dirfd の inode 外へ出ないこと**。root 削除・置換 (path と dirfd の dev/ino 不一致) で `root_changed` 停止。**publish 後の fsync 失敗注入で `result: "uncertain"`**。token / Host / Origin 検証の negative test。directory fsync までの成功判定。

### 13.4 real Bridge integration test

- session create (client 生成 `session_id`): initiator 指定の `session_id` で session 作成成功、response の `session_id` は request と同一、duplicate `session_id` で既存 session が上書きされない (一意制約で拒否)、malformed hex / uppercase 等の non-canonical 表現は拒否 (§8.2 の canonical 表現契約)。QR payload / canonical transcript で raw 16-byte `session_id` が一致することは §13.1 の共有 vector で固定。
- 実 Elixir Bridge を起動し protocol client から: 双方向 copy、反復可能 GET、同一 id 同一 bytes 再送 200、同一 id 異 bytes 409、**同 id concurrent upload の線形化 (同 bytes / 異 bytes)、body 途中切断で transfer が一覧に現れないこと、cancel と upload / ack の競合で invalidation が勝つこと、ack の sender POST 403、異 ack bytes 409、join capability 不一致・2 回目 join 403**、TTL 経過後 410、取消後 401。clock を進める bridge 側 test hook を使用して TTL を検証。

### 13.5 E2EE test

- vector に加え、実 WebCrypto での: pairing handshake 正否、未認証 handshake (MAC 改竄) 拒否、**transcript 要素改竄の拒否、purpose 0x01 / 0x02 取り違えの拒否**、**confirmation gate (local): A は `confirm_b` 検証成功前に B 向け data を送れない、B は `confirm_a` 検証成功前に A 向け data を送れない、各端末は自 confirmation 検証成功後にのみその peer 向け送信を許可する、remote peer の confirmation-complete 通知・追加 round trip は不要、未 confirmed peer からの data は拒否 (受理・保存しない)**、reload 復帰 (sessionStorage 保存 → reload → 検証)、複製タブでの双方向送信、失効後の拒否、偽 ack 拒否。roundtrip 成功だけを安全性根拠にしない。

### 13.6 Playwright E2E

- PC: 実 Go server + 実 UI で paste→file 確認→list→read→copy→delete→search。
- Mobile: 実 Bridge + 実 UI で pairing→send→receive→save→ack 表示、受信後 save 失敗 (quota fault は browser で注入困難なため、IndexedDB 失敗は §13.2 の runtime stub で意味論のみ検証し、E2E では real 経路を優先)。
- failure scenario: save 応答断 (route abort) → uncertain 表示、次入力が消えないこと、ack 断 → saved (ack unknown) 表示。

## 14. Repository / module structure

```text
spool2/
  DESIGN-v2.md
  README.md                      (後日)
  ui/                            # Vanilla TS + Vite (PC/Mobile 共通)
    src/
      main.ts                    # 起動、storage 注入 (build target で決定)
      views/                     # capture / list / read / search / transfer / pairing
      storage/
        indexeddb.ts             # Mobile 正本
        httpapi.ts               # PC API client (token, error taxonomy)
      pure/                      # 純粋関数のみ。I/O なし
        filename.ts title.ts search.ts validate.ts
      transfer/
        protocol.ts              # envelope v1 encode/decode (純粋)
        e2ee.ts                  # WebCrypto 境界
        bridge.ts                # Bridge HTTP 境界
      export/
        allZip.ts                # 全件 export (zip library 呼び出し)
      sw.ts
  pc/                            # Go (§6.1 構成)
  bridge/                        # 既存 knc-bridge への追加 endpoint (実装フェーズで着地)
  test/
    vectors/                     # 共有 fixture (filename / search / e2ee / pairing-wire)
    bridge-integration/
    playwright/
```

- 純粋規則は TS / Go に意図的に重複して存在し、共有 vector で一致を固定する。共通 runtime・code generation は作らない (小ささ優先)。
- scaffold を先に大量生成しない。最初の実装は縦切り (§15)。

## 15. Implementation milestones (縦切り)

各段階が実際に使える状態で完了する。

| # | 縦切り | 含まれるもの | 根拠 |
|---|---|---|---|
| 1 | Mobile: Paste as New → IndexedDB | capture / list / read / copy / delete / export、create-only save、offline app shell | 製品の基本体験が Mobile 単体で成立。I/O 境界が最も単純 |
| 2 | PC: Browser → Go → ordinary file | Go binary、token/Host/Origin、atomic save (dirfd + linkat)、list/read/delete、PC UI | 正本が普通のfileになる。dirfd 境界と linkat 意味論の test を早期固定 |
| 3 | Search (両端末) | 正規化 vector、PC name + 本文走査 (既存 API で逐次取得)、Mobile cursor 走査、incomplete・読取失敗 表示 | 既存の完成した保存機能の上に重ねる。単独では使えないため 2 の後 |
| 4 | E2EE pairing | handshake、sessionStorage 復帰、negative validation、crypto vector test | 送受信の前提。実 Bridge 前でも handshake 単体 test が回る |
| 5 | 実 Bridge transfer | protocol endpoints、send/receive UI、ack、TTL 動作 | 4 と 1+2 の上に載る最初の端末間動作 |
| 6 | failure scenario 総点検 | Baseline §12 の表を行ごとに E2E 再現、duplicate / uncertain / 410 / 取消 | 完成判定 |

順序の改善点: ユーザー示示順 (1→2→3 offline…→E2EE→Bridge) に対し、search を 3 に繰り上げた (search は保存機能の純粋な付加であり、Bridge 前に検証しておくべき共有 vector を持つ)。他は同一思想 (各段階で単体利用可能) を踏襲。

## 16. Decisions (本書が新たに決めたこと)

1. filename format `YYYYMMDD-HHMM-<title>[~NN…].txt` (端末 local time minute、suffix は必要桁数まで増加、name 全体 ≤ 255 UTF-8 byte、title ≤ 64 code point かつ 234 byte)。captured 時刻は client が操作開始時に一度だけ決定し server へ添付 (grammar は ISO minute の完全一致、未来拒否なし)。
2. title 導出アルゴリズムを 6 step の純粋関数として固定 (空白・invalid 文字集合を明示、Unicode 正規化なし)。TS/Go 重複 + 共有 vector。
3. PC の filesystem 境界は dirfd pinning + openat / unlinkat / linkat + O_NOFOLLOW で実装。publish は `linkat(dirfd, temp, dirfd, final, 0)` (temp・final 同一 dirfd 相対、root path 再解決なし、`AT_FDCWD`・`AT_SYMLINK_FOLLOW` 不使用)。非上書きは linkat EEXIST 原子性。publish 後の inode 照合は補助検証であり、atomicity・閉じ込めの成立条件ではない。crash 時も完成本文のみ公開。Windows は初期対応外。
4. root 置換検出は `stat(rootPath)` と `fstat(dirfd)` の dev/ino 比較 (UX 要求、best-effort)。閉じ込めは dirfd 基準の directory-relative 操作自体で成立し、検出に依存しない。
5. token 128-bit / `X-Spool-Token`、Host 完全一致、state-changing request の Origin 完全一致、CORS なし。静的配信は token 不要。
6. Mobile schema: store 1個 (`records`, keyPath `name`)、record は `name` / `text` のみ (`kind` なし)。`add` による create-only、成功判定は tx `complete`。全件 export は zip library (STORE)、1件は素の `.txt`。
7. Bridge protocol: client 生成 transfer_id (16B)、idempotent upload (同一 bytes 200 / 異 bytes 409、DB 一意制約で線形化)、body 完全受信後のみ公開、非破壊 GET、opaque ack (receiver role のみ、state+bytes 同一 transaction)、TTL 24h / session 7d (**PROVISIONAL**)、410 cleanup、retry で TTL 延長なし。**`session_id` も client (initiator) が 16 random bytes 生成し、session create 時に Bridge へ提示する (Bridge は検証と一意登録のみ、生成しない)**。v1 用の新しい小さな domain / persistence を既存 Bridge 内に追加し、legacy package model は再利用しない。
8. E2EE suite: ECDH P-256 + HKDF-SHA256 + AES-256-GCM (96-bit random nonce、衝突確率の確率的受容を明示、2^16 は advisory)。envelope v1 (AAD = version / purpose / session_id / direction / transfer_id)、data 受信は purpose 0x01、ack 検証は purpose 0x02 を厳密要求、ack は 1-byte AEAD message。
9. pairing: QR が `A_static` + `pairing_secret` (32-byte 1本) を運ぶ。`join_secret` は廃止。join capability = `HMAC-SHA256(pairing_secret, "spool-join/v1" || session_id)` を Bridge へ提示し 1 回のみ受理、raw secret は Bridge へ送らない。E2EE 鍵導出は `e2ee_salt = HMAC-SHA256(pairing_secret, "spool-e2ee-salt/v1")` を HKDF-Extract salt とし用途分離。QR payload (§9.2.1) と canonical transcript (§9.3) は固定長 magic + 固定幅 field + 長さ付き canonical UTF-8 URL の canonical byte format で一意に固定し、共有 test vector で TS/Go 一致を固定。canonical transcript (両公開鍵・session_id・expires_at・bridge_base_url・version・role) を KDF と confirm MAC の両方に束縛した相互認証。QR を読めた相手を authorized peer とし、認証対象は QR の認証材料保持 + 対応する ECDH 参加の証明であり、物理端末 identity は認証しない (追加の表示コード・手入力確認・永続 device identity なし)。primitive 変更なし (P-256 / HKDF / GCM / HMAC を維持)。
10. 検索: NFKC + toLowerCase の共有正規化、AND substring。PC も UI 本文検索を持つ — 明示検索時に root 直下の対象 regular `.txt` を既存 API で逐次取得し name + 本文を検索、読取失敗・途中結果・完了を区別。大規模・階層横断・複雑な検索は rg / shell / AI。Mobile は cursor 走査、incomplete 表示、永続 index なし。
11. UI: view ごとの module-local state + 明示関数呼び出し、storage は Vite 2 build target で切替、実行時 probing なし。
12. 実装順: search を縦切り 3 に繰り上げ (§15 の理由)。
13. PC POST 応答は `result: saved / failed / uncertain` を正本とし、server 内部で publish phase を追跡する。HTTP status は参考値。
14. Mobile ↔ Bridge の別 origin 境界: Bridge URL は HTTPS のみ、Bridge CORS は exact origin list、Mobile CSP `connect-src` に許可 Bridge origin を配信側設定で追加。
15. captured 判定は `validateGeneratedFilename(name)` (§3.2–§3.5 生成規則の完全検証) 1本に一本化 (§3.6)。独立した captured 用 regex・日時妥当性確認は廃止。TS / Go 重複実装 + 共有 fixture は維持。

## 17. Deliberately unresolved (実装前のユーザー判断)

1. **初期対応環境の確定** (Baseline §16-1): PC は Linux / macOS、Mobile は Chrome / Safari 最新を本書は仮定 (**PROVISIONAL**)。`NAME_MAX = 255 byte` の filesystem 保証 (ext4 / btrfs / xfs / APFS) も同様。Windows PC (openat / O_NOFOLLOW / linkat 非対応、§6.7) と Mobile browser の下限 version を製品判断で確定すること。
2. **上限値** (§16-2): text 256 KiB / transfer TTL 24h / session TTL 7d / quota・rate の既定値は仮置き (**PROVISIONAL**)。確定は Bridge・製品判断。
3. **QR が使えない場面の初期サポート** (§16-3): 本設計は QR のみ。short code による代替 pairing は鍵認証を弱めない形でのみ将来検討。
4. **self-host の session 作成制限 / hosted の account UX** (§16-4): protocol は Bridge 設定に委ねる (session 作成を open にするか admission 制御するか)。
5. **ライセンス・配布** (§16-5): 公式 hosted Mobile UI の origin、Go binary の配布方法、更新責任。
6. **Bridge の着地**: v1 protocol 用の新しい小さな domain / persistence を既存 Bridge 内に追加する方向を採用した (§8.1)。残る判断は実装フェーズでの module 配置のみ。
7. Windows publish 方式 (§6.7)、hosted の SLA・運用規模、preview・画像 — 必要になるまで決めない (Baseline §16)。

## 18. Baseline v2 compliance matrix

| Baseline | 要件 (要約) | 本書 |
|---|---|---|
| §2 | Paste as New / 非上書き / 普通のfile正本 / Mobile独立正本 / copy而非同期 / 明示保存先 / commit・Bridge受領・受信保存・ackの区別 / 直接削除 / E2EE必須 | §3.5, §5, §6.6, §8.6, §9.7, §10.4, §11 |
| §3 | Non-goals の不実装 | §2.1, §5.1 (directory emulation なし), 全編 |
| §4 | name+text / filename prefix / retry で時刻不変 / suffix / 時系列は名前導出 / 受信で新規命名 / 外部file区別 | §3 |
| §5 | root 直下 / 非上書きの実保証 / temp 非公開 / 結果不明許容 / root 消失で停止 / symlink 非追従 | §6.2, §6.6, §6.7, §10.4 |
| §6 | IndexedDB 正本 / tx complete / quota 明示 / export / offline shell / draft 復旧なし | §5, §4.4 |
| §7 | 一括小送信 / Bridge opaque / 公開前 Transfer ID / 同ID異bytes拒否 / 非破壊 GET / commit後ack・冪等 / TTL・cleanup / duplicate許容 | §8, §9.9, §10.5 |
| §8 | 単一 suite / QR authenticated pairing / 鍵確認後送信 / AAD束縛 / 拒否規則 / ack はE2E認証 / session寿命・reload / nonce契約 / same-ciphertext retry | §9 |
| §9 | 状態分類・所有者局所化・連鎖禁止 | §2.3, §4.4, §10 |
| §10 | Vanilla TS / discriminated union / Gleam的Go / facade禁止 / fake FS 禁止 | §4, §6.1 |
| §11 | 正規化 / AND substring / 逐次走査 / 不完全区別 / index なし | §7 |
| §12 | failed / uncertain / saved / ack unknown / 各 failure 挙動 | §10.4 |
| §13 | loopback・token・Host/Origin / root閉込 / HTTPS Bridge / plain text表示 / UI delivery 信頼境界の明示 | §11, §12 |
| §14 | 実境界 test / Bridge 実結合 / crypto vector / nonce・寿命 / fake 非依存 | §13 |
| §15 | OSS / self-host 完結 / hosted 分岐なし suite / origin 変更の明示 | §12, §17 |
| §16 | 未確定の先送り尊重 (製品判断を詳細設計で先取りしない) | §1, §17 |
| §17 | rejected complexity の不採用 | 全編 (特に §2.3, §5.1, §8, §9.6) |
