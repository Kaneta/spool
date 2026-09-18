# Windows clipboard capture checkpoint (2026-09-19)

Status: Windows clipboard capture milestone の COMPLETE 記録。実機確認の事実を記録するものであり、新しい設計の保証を追加しない。既存 checkpoint は `docs/checkpoint-2026-09-18-windows-local.md`。作業メモは `docs/spool-windows-launcher.md`。

---

## 1. Status

Windows clipboard capture: **COMPLETE**

目的:

> Windows で `spool-clipboard.exe` を 1 回起動すると、clipboard の plain text が既存 `spool.exe add` を通って root 直下の ordinary `.txt` record として保存される。

## 2. 実装

adapter は Windows 専用の thin 層で、`spool` 本体はクリップボード機能を持たない (Linux/KDE と同じ境界)。filename 生成・title 導出・衝突処理・text 検証・保存はすべて `spool add` の責務。

```text
Windows clipboard (CF_UNICODETEXT)
        ↓
spool-clipboard.exe   (thin adapter, Windows 専用)
        ↓ UTF-8 stdin
spool.exe add
```

* `pc/cmd/spool-clipboard/` — Windows clipboard adapter
* adapter は自身の実行 directory の sibling `spool.exe` を第一候補とし、無い場合だけ PATH fallback
* exit code は `spool add` の 0 (saved) / 1 (failed) / 2 (uncertain) を透過

## 3. 実機確認

環境:

* Windows 11 Home
* x86-64
* 非管理者
* NTFS fixed drive

確認事項:

* 日本語 + ASCII 保存成功 (byte preservation 確認済み)
* 同一 minute collision → `~01` 確認済み
* 画像のみ clipboard は record 生成なし (exit 1)
* Desktop shortcut 起動で保存成功

## 4. icon 共通化

launcher icon の正本は repository の:

```text
assets/spool.svg
```

Linux / Plasma と Windows で同じ design を使用する。platform ごとに別 design / 別 SVG は持たない。

Windows 用 `.ico` は同じ SVG から生成:

```text
assets/spool.ico
```

収録 size:

```text
16, 20, 24, 32, 40, 48, 64, 128, 256 px
```

Desktop shortcut の icon はこの `.ico` を指定する。

## 5. Deferred

* installer
* toast notification
* console 非表示 (`-H windowsgui`)
* clipboard image / HTML / RTF support
* clipboard history
* config path の `%APPDATA%` 移行
