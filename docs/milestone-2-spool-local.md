# Milestone 2: spool Local — 実装計画

Status: 実装計画 (2026-09-09)。上位基準は `docs/spool-design-baseline-v2.md` (Baseline)、次いで `DESIGN-v2.md`。本書は M2 の範囲抽出と実装順の決定のみを行い、DESIGN が明示していない機能・保証・正本を追加しない。

現在地: Milestone 1 (spool Web: Browser UI + IndexedDB) 完了 (`4568fcb`)、Milestone 2 (spool Local: Go process → ordinary files) 完了 + hardening 完了 (`601e20b`)、`spool add` CLI (`bce9e6b`)、KDE clipboard capture (`6fd602a`) 完了。PC 側の基本 capture path は実機確認済み。詳細は `docs/checkpoint-2026-09-09.md`。

---

## 1. M2 スコープ (DESIGN-v2 / Baseline からの抽出)

### 1.1 対象 (縦切り §15-2: PC: Browser → Go → ordinary file)

| 領域 | 内容 | 根拠 |
|---|---|---|
| Go binary | `pc/` に単一 binary。依存は stdlib + `golang.org/x/sys/unix` のみ (`x/text` は M3 Search で初登場) | §6.1 |
| package 構成 | `main.go` / `internal/config` / `internal/namegen` / `internal/textcheck` / `internal/store` / `internal/server` / `web/` | §6.1 |
| 起動 | `spool --root <dir> [--port N] [--init]`。`--init` 付き初回のみ root 作成 (`os.Mkdir` 相当。親 directory は既に存在していなければならず、暗黙に作成しない)。以後 root 不在はエラー停止・再作成しない。設定は `~/.config/spool/config.json` (root, port) のみ、CLI 引数が優先 | §6.2 |
| root 境界 | 起動時に root を open し dirfd を process 生存中 pin。全操作は openat / unlinkat / linkat の directory-relative。root path 再解決なし。`AT_FDCWD` / `AT_SYMLINK_FOLLOW` 不使用。root 置換検出は `stat(rootPath)` vs `fstat(dirfd)` の dev/ino 比較 (UX 要求・best-effort、閉じ込めの成立条件ではない) | §6.2, §6.7 |
| atomic save | temp (`.spool-tmp-<16hex>`, `O_CREATE\|O_EXCL\|O_WRONLY`, 0644) → 書込 → fsync → close → `linkat(dirfd, temp, dirfd, final, 0)`。EEXIST → suffix 候補 (`~01`…、byte 上限で `name_conflict`)。publish 後の inode 照合は補助検証。補償 unlinkat → `fsync(dirfd)`。publish 後の障害は `uncertain`、publish 前の確認済み失敗は `failed` + code (server 内部で publish phase を追跡) | §6.6, §6.5, §16-13 |
| read / delete / list | read: `openat(O_RDONLY\|O_NOFOLLOW)` + `fstat` で regular 確認 (ELOOP → 拒否)。delete: 同確認後 `unlinkat`。list: pin した dirfd から `Readdirnames`、各 entry を `openat(O_NOFOLLOW)` + `fstat` で regular `.txt` のみ対象。`*.spool-tmp-*` は一覧対象外 (削除はしない)。path-based lstat は使わない | §6.7, §6.8, §6.6 |
| HTTP | bind `127.0.0.1` のみ。token 128-bit base64url / `X-Spool-Token` (API 全 request、不一致 401)。Host 完全一致 (`403`)。state-changing (POST, DELETE) は Origin 完全一致 (`403`)。CORS なし。静的配信は token 不要。log は method + path のみ。起動時 `http://127.0.0.1:<port>/#token=<token>` を端末へ出力 | §6.2, §6.3 |
| endpoints | `GET /api/health` / `GET /api/records` (name 昇順、`{name,size,kind}`) / `GET /api/records/{name}` (text/plain) / `POST /api/records` / `DELETE /api/records/{name}`。`Cache-Control: no-store`、`nosniff`。POST 応答は必ず body に `result: saved\|failed\|uncertain` を持ち、client は status ではなく `result` で分類 | §6.4 |
| POST body | `{"text": "...", "captured_at": "YYYY-MM-DDTHH:MM:00"}`。text は UTF-8 ≤ 256 KiB (**PROVISIONAL** §17-2)。`captured_at` は grammar 完全一致 + 暦有効のみ (`Z`・offset 付きは拒否)、未来拒否なし | §6.4 |
| name 検証 2 層 | safe root-direct-child name (単一 component、`/` `\` NUL なし、`.` `..` でない、UTF-8、≤255 byte、`.txt` 終端) を read / delete 対象に。`validateGeneratedFilename` は分類と POST 時の server 生成のみに使用 | §6.4, §3.6 |
| error taxonomy | `invalid_input` / `invalid_name` / `not_found` / `name_conflict` / `too_large` / `root_missing` / `root_changed` / `io_error` / `forbidden` / `unavailable`。status は参考値、client は code で分岐 | §6.5 |
| filename 規則 | `YYYYMMDD-HHMM-<title>[~NN…].txt`。`captured_at` は client (browser) が保存開始時に一度だけ決定。suffix retry・確認再試行でも時刻を進めない。title 導出は TS と Go に意図的に重複実装し、共有 fixture で一致を固定 | §3.2–§3.6, §13.1, §16-15 |
| PC UI | `build:pc` target。`storage/httpapi.ts` (token は `location.hash`、`result` field 分類、応答喪失・応答不能は `uncertain`)。capture / list / read / copy / delete。list で external を区別表示。Go binary へ `embed.FS` で embed、`index.html` no-cache・asset immutable、CSP `default-src 'self'; connect-src 'self'`、`nosniff`、`Referrer-Policy: no-referrer` | §4.2, §6.9, §3.6 |
| test | 共有 fixture `test/vectors/filename.json` (TS / Go 両方から読む)。Go tempdir 実境界 test (§13.3 全項目)。token / Host / Origin negative test。PC Playwright (実 Go server + 実 UI: paste→file 確認→list→read→copy→delete、save 応答断 → uncertain 表示) | §13.1, §13.3, §13.6 |

### 1.2 対象外 (本 milestone で作らない)

* M3 Search: 正規化 / NFKC / 本文走査 / `search.json` — 進まない。
* M4/M5: Bridge / E2EE / Pairing / Transfer — 進まない。
* directory emulation・再帰巡回・mkdir/move/rename・symlink 追従 (§2.1, Baseline §5)。
* PC 本文 DB・永続 index・File registry (Baseline §5)。
* Windows (`openat` / `O_NOFOLLOW` / `linkat` 原子性を同形で提供できない、§6.7)。
* macOS `F_FULLFSYNC` — flush 保証の正は Linux (§6.7)。初期対応環境確定時に明示する差分として M2 では実装しない。
* 自動 fallback・自動再作成・自動再保存・Trash・undo・Import・背景 queue (Baseline §12, §17)。
* config の拡張 (root, port 以外)、`--init` 以外の対話操作 (§6.2)。

---

## 2. spool Web からの再利用 / 非再利用

### 2.1 再利用する

| 既存 | 用途 |
|---|---|
| `ui/src/filename.ts` の純粋関数 (`deriveTitle` / `capturedAtPrefix` / `candidateName` / `isNameWithinLimit` / `utf8ByteLength`) | PC build でも同一規則。`capturedAtIso(d)` (ISO minute 文字列生成) を 1 つ追加するのみ。既存 export は変更しない |
| `ui/index.html` の画面構成・操作フロー (capture → saved 表示 → list refresh → read → copy → delete、plain text 表示、`window.confirm` 削除) | PC build で同じ view ロジックを使う。storage 注入だけが切替わる (§4.2) |
| `ui/src/indexeddb.ts` の意味論 (`AddOutcome` / tx complete 判定 / ConstraintError 分類) | Mobile 正本としてそのまま維持。suffix retry loop を view から `indexeddb.ts` 側へ移す (下記 §2.3) |
| `ui/package.json` / `tsconfig.json` / vitest 構成 | 変更なし (devDependencies に Playwright を追加するのみ) |
| `client-zip` / `sw.js` / persist prompt | Mobile 専用としてそのまま (PC build から除外) |

### 2.2 再利用しない (M2 で新規に書く)

* Go 側 namegen / textcheck / store / server / config — TS 実装の移植ではなく「同一規則の Go 実装」+ 共有 fixture (§13.1、code generation・共有 runtime は作らない)。
* `storage/httpapi.ts` — PC API client。IndexedDB module との意味論の統一 (fake FS 等) は作らない (Baseline §10)。
* `build:pc` target と `index-pc.html`。

### 2.3 移動 (整理) する

* `main.ts` の suffix retry loop (`candidateName` / `isNameWithinLimit` を使う部分) を `indexeddb.ts` 側の save 関数へ移す。view 側は両 mode 共通で `storage.save(text)` → `SaveResult` を呼ぶ形にする。これは forwarding facade ではなく、§4.2「storage module だけが切替わる」のための最小再配置である。
* PC 側 save は suffix loop を持たない (server が linkat EEXIST で解決し最終名を返す)。
* entry は `main.mobile.ts` / `main.pc.ts` の 2 本に分け、共有 body を 1 箇所に置く。実行時 probing なし (§4.2)。

### 2.4 PC build から除外する Mobile 専用機能

* 全件 zip export・1件 export (§5.4 は Mobile storage の機能。PC の正本は既に普通の file であるため意味を持たない)
* `navigator.storage.persist()` (§5.5)
* offline app shell / service worker (§5.5)

---

## 3. 実装順 (最小・各 unit で repo が green かつ検証可能)

依存: 1 → 2 → 3 → 4 → 5 (直列)。各 unit 完了ごとに commit。

| # | Unit | 内容 | 受け入れ |
|---|---|---|---|
| 1 | Go namegen + 共有 fixture | `pc/` Go module 新規作成。`internal/namegen` 純粋関数 (`deriveTitle` / `parseCapturedAt` / `candidateName` / `validateGeneratedFilename` / `isValidRootDirectChildName`)、`internal/textcheck` (UTF-8 有効性 + 256 KiB 上限)。`test/vectors/filename.json` を新設し、TS `filename.test.ts` を fixture 読み込みに載せ替え | `cd spool2/pc && go test ./...`、`cd spool2/ui && npx vitest run` が同一 fixture で green |
| 2 | store (dirfd 境界) | `internal/store`: root dirfd open / pin、`rootChanged()` (dev/ino 比較)、list / read / delete / save (`temp openat → fsync → linkat EEXIST → 補助照合 → unlinkat → fsync dirfd`)。§13.3 の実境界 test をここで固定: 実 file 読み戻し、並行同時 create の非上書き race、symlink / directory / `.spool-tmp-*` 一覧除外、O_NOFOLLOW 拒否、root path rename 注入で dirfd 外に出ないこと、root 置換で `root_changed`、fsync 失敗注入で uncertain 相当の結果分類 | `cd spool2/pc && go test -race ./...` |
| 3 | server (HTTP 境界) | `internal/server`: 5 endpoints、token / Host / Origin 検証、error taxonomy → status mapping、POST の suffix loop (namegen + store)、publish phase 追跡 (`failed` / `uncertain` 分類)、静的配信 (handler は `fs.FS` を受ける。`web/dist` には仮 index 1 枚を commit)。negative test (token / Host / Origin / invalid_name / traversal) | `cd spool2/pc && go test -race ./...` |
| 4 | main + config | flag 解析、`--root` 必須、`--init`、`~/.config/spool/config.json` (CLI 優先)、port 既定は OS 任せ、`127.0.0.1` bind、起動 URL 出力、log (method + path のみ)。実 binary を temp root で起動し curl で health / save / list / read / delete を確認 (投げ捨て script) | 実 run の証拠 (起動 URL、`ls root`、curl 応答) |
| 5 | PC UI + E2E | `storage/httpapi.ts` (health / save / list / read / delete、`result` 分類、fetch 失敗・応答解析不能は `uncertain`)、`main.pc.ts` + `index-pc.html` (export / persist / sw なし、Refresh ボタンと external 区別表示を追加)、`build:pc` → `pc/web/dist`、Playwright (実 Go + 実 UI: paste→実 file→list→read→copy→delete、route abort → uncertain 表示、reload 後も file が残ること)。vitest は既存分が green のまま | `npm run build:pc` → `go run .` → Playwright spec green。Mobile 側 (`npm run build` / vitest) に regression がないこと |

---

## 4. 最初の atomic 実装単位

**Unit 1: Go namegen (純粋関数) + 共有 fixture。**

理由:

* 外部依存ゼロ・I/O ゼロで、POST / list / 分類の全経路が参照する契約を最初に固定できる。
* §13.1 が要求する TS/Go 重複 + 共有 fixture を最初に作ることで、以後の unit は I/O に集中できる。
* 失敗時の切戻しが fixture 追加のみで済む (既存 M1 動作に触れるのは `filename.test.ts` の fixture 読み込みだけ)。

成果物は §5 のプロンプトのとおり。`store` / `server` / `main` / `httpapi` / UI には一切触れない。

---

## 5. Unit 1 実装プロンプト (AI 実装者へ渡す・このまま copy-paste)

```text
# 依頼: spool M2 Unit 1 — Go namegen (純粋関数) + 共有 fixture

## 正本 (最初に読む。この順で)
1. docs/spool-design-baseline-v2.md — §4 (Record model), §10 (Technology direction)。Baseline が上位。
2. spool2/DESIGN-v2.md — §3.2–§3.6 (filename / title / 衝突 / 分類), §6.4 (name 検証 2 層), §13.1 (共有 fixture), §16 (決定 1 / 2 / 15)。
3. 参照実装: spool2/ui/src/filename.ts と spool2/ui/src/filename.test.ts (TS 側の既存規則。これと同一規則の Go 実装を作る)。

旧 legacy 実装・LunaReview は根拠にしない。

## 現在地
Milestone 1 (Browser UI + IndexedDB) は完了済み (commit 4568fcb)。今回が Go 側最初の実装。
作るのは純粋関数と fixture のみ。I/O・HTTP・server・store・UI は作らない (後続 unit)。

## 成果物 (この 3 点だけ。それ以外の file は作らない)
1. spool2/test/vectors/filename.json — 単一の fixture。TS と Go の両テストがここから読む
   (fixture が無ければ両テストが fail する状態にする)。
2. spool2/pc/ (Go module を新規作成)
   - spool2/pc/go.mod — module spool / go 1.27。dependency なし (stdlib のみ)
   - spool2/pc/internal/namegen/ — namegen.go + namegen_test.go (fixture を読む)
   - spool2/pc/internal/textcheck/ — textcheck.go + textcheck_test.go (こちらは fixture でなく inline test)
3. spool2/ui/src/filename.test.ts — fixture 読み込みに載せ替え
   (fs.readFileSync + import.meta.url で spool2/test/vectors/filename.json を読む。
    bundler の JSON import 機能に依存しない。既存 case で fixture に移せるものは移し、
    fixture に載らない構文確認だけを残してよい)
   - spool2/ui/src/filename.ts に capturedAtIso(d: Date): string | null を 1 つ追加してよい
     (local time の ISO minute 文字列 "YYYY-MM-DDTHH:MM:00"。Invalid Date は null。
      既存 export の挙動・signature は一切変えない)

## 実装する契約 (要点の再掲。DESIGN §3 が正。TS 実装と 1 バイトも違えてはならない)

### deriveTitle(text) → title (§3.4)
1. "\n" で分割し、前後の ASCII whitespace を除いて非空になる最初の「行 (raw のまま)」を選ぶ。
   全行空なら "paste" を返す。
2. 選んだ行から制御文字 U+0000–U+001F と U+007F、および "/ \ : * ? \" < > |" を「削除」する
   (置換ではない。U+0009–U+000D もここで消える。space 化しない)。
3. 連続する空白を単一 U+0020 に畳み、前後の空白を削る。
   空白集合は ASCII whitespace のみ: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020。
   Unicode whitespace (U+00A0 等) は対象外。
4. 先頭の U+0020 / "." / "-" を、いずれかが先頭に存在する限り繰り返し削除する。途中の . と - は保持。Unicode whitespace は対象外。
5. 空になったら "paste"。
6. 64 code point かつ 234 UTF-8 byte の両方を満たすまで code point 境界で切り詰める
   (byte 上限が実質の制約。切断のたびに byte 数を再計算。切断で露出した末尾の
   ASCII whitespace は削る)。

### parseCapturedAt(s) → prefix (Go 側。§6.4 captured_at)
- 入力は "YYYY-MM-DDTHH:MM:00" の完全一致 (regex ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$) かつ
  暦上有効 (2月30日・25時・13月等は拒否。閏日 2024-02-29 は有効。秒は常に 00 でなければならない)。
- 出力は 14 文字の prefix "YYYYMMDD-HHMM"。
- 未来時刻の拒否・timezone 解釈・正規化は一切しない。
- TS 側は capturedAtIso (Date → 同 form の生成) のみで、parse を持たない。
  fixture の capturedAt cases は「iso 入力 → 期待 prefix (または拒否)」を両側で検証する
  (TS は new Date(iso) → capturedAtIso / capturedAtPrefix、Go は parseCapturedAt)。
  iso 入力に Z や offset は含めない (local 意味論のため)。

### candidateName(prefix, title, suffix) と byte 上限 (§3.5)
- suffix 0 → 付加なし。1–99 → "~01"…"~99" (2 桁 zero-pad)。100 以上 → "~100" (自然桁)。
- name 全体は UTF-8 ≤ 255 byte。超える候補は「生成不可」であり、呼び出し側は name_conflict にする。
  (Go には isNameWithinLimit 相当の純粋関数を用意する)

### validateGeneratedFilename(name) → bool (§3.6「生成規則の完全検証」)
1 つでも違えば false。規則:
- prefix: 14 文字 "YYYYMMDD-HHMM" かつ暦上有効 (parseCapturedAt と同じ判定を流用してよい)。
- title: 1 code point 以上。制御文字 (U+0000–U+001F, U+007F) と "/ \ : * ? \" < > |" を含まない。
  先頭が "." でも "-" でもない。U+0020 が先頭・末尾・連続に現れない。
  title は 64 code point かつ 234 byte 以内。
- suffix: なし、または "~" + 2 桁 zero-pad (01–99)、または "~" + 3 桁以上 (100 以上・leading zero なし)。
  "~1" / "~00" / "~010" / "~099" は生成され得ないので不可。
- 終端は ".txt" (大文字小文字含め他の拡張形は不可)。
- name 全体が有効 UTF-8 かつ ≤ 255 byte。

### isValidRootDirectChildName(name) → bool (§6.4 safe name。read / delete 対象)
- 単一 path component: "/" "\" NUL を含まない。"." と ".." でない。
- 有効 UTF-8、≤ 255 byte、終端 ".txt"。
- 生成 format 外の名前 (例: "my notes.txt") も true になり得る (validateGeneratedFilename と別物)。

### Go 実装上の制約
- package は internal/namegen と internal/textcheck のみ。純粋関数のみ。global state・init 関数なし。I/O なし。
- 文字列走査は code point 単位 (range rune)。unicode.IsSpace 等の間接的な文字集合を使わず、
  §3.4 の明示集合を直接書く。
- error は普通の error / 戻り値の bool。Result / Option 型、自作 monad、interface 抽象は作らない。
- NFKC 等 Unicode 正規化・trim・改行変換は一切しない。
- textcheck: 本文 text (Go では []byte) の UTF-8 有効性と ≤ 256 KiB (262144 byte) の検証のみ。
  関数 1–2 個。invalid UTF-8 は JSON で表現できないため inline test で確認する。

## fixture (spool2/test/vectors/filename.json) がカバーするケース
40–80 件程度。deterministic。既存 filename.test.ts の case をすべて移すこと。
- title: 空本文 → paste / 全行空行 → paste / 最初の非空行 (前後空白付き raw 行) / 制御文字削除 /
  invalid 記号削除 / U+0009–000D は削除される (space 化しない) / 連続空白圧縮 + trim /
  Unicode whitespace は保持 (U+00A0) / 先頭 . - 除去・途中保持 / "a".repeat(65) → 64 /
  絵文字 4-byte code point の 234 byte 境界 truncate / 切断で露出した末尾空白の削除 /
  全行空 + 記号のみ等の複合
- capturedAt: fixture 内で責務を分ける (TS/Go で無理に対称化しない)。
  `capturedAtGenerationCases` (TS のみ消費: Date local fields → `YYYY-MM-DDTHH:MM:00` → prefix) と
  `capturedAtParsingCases` (Go のみ消費: captured_at string → grammar/calendar 検証 → `YYYYMMDD-HHMM`) に分け、
  1 つの `filename.json` に置く。JS の Date parsing 拒否 test は作らず、Go の parser 拒否 cases
  (2月30日 / 25:00 / 秒が 00 でない / Z・offset 付き) は Go 側だけで検証する
- generatedFilename: 正常 (suffix なし・~01・~99・~100) → true / 2月30日 prefix → false /
  suffix grammar 不正 (~1, ~00, ~010, ~099) → false / 生成 format 外だが .txt → false
  (例: "my notes.txt" / "2026-09-08.txt" / "20260908-1234.txt" (title なし) /
   "20260908-1234--foo.txt" (title 先頭 "-") / "20260908-1234-foo  bar.txt" (連続空白) /
   byte 超過) / title が 64 code point を超える → false
- rootDirectChild: "my notes.txt" → true / "20260908-1234-abc.txt" → true /
  "../a.txt" / "a/b.txt" / "a\\b.txt" / NUL 含む / "." / ".." / ".txt" 以外
  ("notes.md", "x.TXT", "x.txt ") / 255 byte 超過 → false
- nameBuilding (candidate + limit): suffix 0 / 1 / 99 / 100 / 101 の期待名 /
  234 byte title + ~99 がちょうど 255 / 同 title + ~100 が 256 (withinLimit=false) /
  絵文字 58 個 + "ab" の 234 byte 境界
- 分類の整合: generatedFilename=true の case はすべて rootDirectChild=true でもあることを
  両テストで cross-check する (検証コード側で assert)

## 受け入れ基準 (証拠を出して完了)
1. cd spool2/pc && go test ./... — green (gofmt 済み)
2. cd spool2/ui && npx vitest run — green (tsc strict error なし)
3. 両テストが同一 fixture (spool2/test/vectors/filename.json) を読んでいること
4. 上記 3 点 + 触れた file 以外の変更がないこと
   (ui/src/filename.ts は capturedAtIso 追加のみ。main.ts / indexeddb.ts には触れない)

## 報告形式
変更点は「ファイル:行範囲 + 要約」のみ。テスト出力・file 内容の再掲はしない。
```

---

## 6. 明示しておく判断

* **config file は M2 に含める** (§6.2 に規定、最小: root + port、CLI 優先)。Unit 4 で最後に実装する。core 経路には不要。
* **export / persist / sw は PC build から除外** (§5.4 / §5.5 は Mobile storage の節)。UI 共通化の対象外。
* **macOS `F_FULLFSYNC` は M2 で実装しない** (§6.7: flush 保証の正は Linux。差分は初期対応環境確定時に明示)。
* **256 KiB は PROVISIONAL** (§17-2)。定数として隔離し、wire format がこの値に依存しない形で書く。
* **suffix loop の所有者**: Mobile は client (indexeddb module 内)、PC は server (linkat EEXIST)。共通化しない — 意味論が別物であるため (Baseline §10「Browser と filesystem の意味論を同一 interface に押し込まない」)。
* **`--init` は `os.Mkdir` 相当** (親 directory を暗黙に作成しない)。Unit 4 で採用。
* **Unit 1 の TS 追加関数**: `capturedAtIso` に加え、§8 invariant (generated → rootDirectChild の cross-check を TS/Go 双方で) と DESIGN §3.6/§13.1 (validator の TS/Go 重複 + 共有 vector) のため `validateGeneratedFilename` / `isValidRootDirectChildName` も `filename.ts` に追加する。既存 export の挙動は変更しない。
* **M3 以降への先送り**: search / NFKC / `search.json` / Bridge / E2EE / Playwright Mobile 側。
