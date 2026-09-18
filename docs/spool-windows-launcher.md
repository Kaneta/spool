# spool — Windows launcher メモ

Windows で `spool-clipboard.exe` を 1 回起動すると、clipboard の plain text が既存
`spool.exe add` を通って root 直下の ordinary `.txt` record として保存される。

現時点の実機構成 (目標):

```text
Windows clipboard (CF_UNICODETEXT)
        ↓
spool-clipboard.exe   (thin adapter, Windows 専用)
        ↓ UTF-8 stdin
spool.exe add
        ↓
spool root 直下の *.txt
```

`spool` 本体はクリップボード機能を持たない (Linux/KDE と同じ境界)。
filename 生成・title 導出・衝突処理・text 検証・保存はすべて `spool add` の責務。

---

## 1. 配置

`spool.exe` と `spool-clipboard.exe` を **同じ directory** に置く。

```text
C:\spool\bin\spool.exe
C:\spool\bin\spool-clipboard.exe
```

adapter は自身の実行 directory の sibling `spool.exe` を第一候補とし、無い場合だけ
PATH fallback する。絶対 path の shortcut から起動しても PATH に依存しない。

## 2. config path (現行)

`spool add` の root 解決は既存 config resolver をそのまま使う
(CLI `--root` > config file > error)。Windows での config file path:

```text
%USERPROFILE%\.config\spool\config.json
```

(`%APPDATA%` への移行は今後の課題。今回変更しない。)

## 3. root 設定例

```json
{
  "root": "C:\\spool"
}
```

root directory は事前に作っておくこと (存在しないと `spool add` は
`failed: root_missing` で終了する)。

**注意**: `config.json` は UTF-8 **without BOM** で保存すること。
Windows PowerShell のバージョンによっては `Set-Content -Encoding UTF8` が
BOM を付け、Go の JSON parser が `invalid character '\ufeff'` で拒否する。
BOM なしで書く例:

```powershell
$path = "$env:USERPROFILE\.config\spool\config.json"
$json = '{"root":"C:\\spool"}'
[System.IO.File]::WriteAllText(
    $path,
    $json,
    [System.Text.UTF8Encoding]::new($false)
)
```

## 4. smoke test

まず直接実行して確認する:

```text
text をコピーしてから
C:\spool\bin\spool-clipboard.exe
```

期待:

* exit code 0
* stdout に filename 1 行 (`YYYYMMDD-HHMM-<title>.txt`)
* root 直下に record が作成され、日本語を含む本文がそのまま保存される

## 5. shortcut (.lnk)

Start menu または Desktop に shortcut を作成:

* **Target**: `C:\spool\bin\spool-clipboard.exe` の絶対 path
* 作業 folder や引数は不要

## 6. 使い方

1. text を clipboard にコピー
2. shortcut から spool-clipboard.exe を起動
3. 保存される (成功時は console に filename が一瞬出る)

## 7. console window

初期 milestone では起動時に console window が一瞬表示されるが **仕様** である
(失敗時に stderr が見える方が有用)。

## 8. failure の挙動

| 状態 | 挙動 |
|---|---|
| clipboard に plain text あり (空文字含む) | 保存 (空文字は空 record になる) |
| plain text 形式なし (画像のみ等) | `spool add` を起動せず失敗 |
| clipboard busy | 短い retry 後に失敗 |
| root 未設定 / 不在 | `spool add` が `root_missing` で失敗 |

exit code は `spool add` の 0 (saved) / 1 (failed) / 2 (uncertain) をそのまま透過。

## 9. icon

launcher icon の正本は repository の:

```text
assets/spool.svg
```

Linux / Plasma と Windows で同じ design を使用する。

Windows 用 `.ico` は同じ SVG から生成した:

```text
assets/spool.ico
```

を使用する。Desktop shortcut の icon はこの `.ico` を指定する。

`.ico` には以下の size を収録する:

```text
16, 20, 24, 32, 40, 48, 64, 128, 256 px
```

platform ごとに別 design / 別 SVG は持たない。

## 10. 後回し

* installer
* toast notification
* console 非表示 (`-H windowsgui`)
* clipboard image / HTML / RTF support
* clipboard history

---

## 11. 実機確認済み

* Windows 11 Home / x86-64 / 非管理者 / NTFS
* 日本語 + ASCII 保存成功
* byte preservation 確認済み
* 同一 minute collision → `~01` 確認済み
* 画像のみ clipboard は record 生成なし (exit 1)
* Desktop shortcut 起動で保存成功
