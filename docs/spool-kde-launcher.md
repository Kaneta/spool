# spool — KDE パネル登録メモ

## 目的

KDE Plasma のパネルに `spool` アイコンを置き、クリックすると X11 クリップボードの内容を `spool add` で保存する。

現在の実機構成:

```text
KDE Plasma / X11
        ↓
xclip
        ↓
~/.local/bin/spool-clipboard
        ↓
~/.local/bin/spool add
        ↓
~/spool/*.txt
```

`spool` 本体はクリップボード機能を持たず、標準入力だけを受け取る。
クリップボード取得は小さな adapter に分離する。

---

## アイコン

正本:

```text
~/.local/share/icons/spool.svg
```

デザイン方針:

- 4:3 の同じ用紙を3枚
- 同じ遠近投影
- 上の用紙だけ間隔を広くして「追加中」を表現
- 上から下へ、light → mid → dark の3色
- 下へ行くほど「固定された」印象
- 背景透明
- 影なし
- 輪郭なし
- 各用紙内部のグラデーションなし
- 糸巻き・フォルダ・紙の文字記号・矢印は使わない

概念:

```text
incoming item
      ↓
   settling
      ↓
stored / fixed
```

今回作成した SVG はダウンロード済みの `spool.svg` を使用する。

---

## 必要なもの

```bash
which xclip
which spool
```

期待例:

```text
/usr/bin/xclip
/home/kohei/.local/bin/spool
```

`xclip` が未導入なら openSUSE では:

```bash
sudo zypper install xclip
```

---

## clipboard adapter

配置先:

```text
~/.local/bin/spool-clipboard
```

内容:

```bash
#!/usr/bin/env bash

set -u

tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT

xclip -selection clipboard -o >"$tmp" || exit 1
"$HOME/.local/bin/spool" add <"$tmp"
```

理由:

単純に

```bash
xclip -selection clipboard -o | spool add
```

とすると、クリップボード取得に失敗した場合でも `spool add` に空の stdin が渡り、0 byte の `paste.txt` が作成され得る。

一時ファイルを介し、`xclip` が成功した場合だけ `spool add` を実行する。

実行権限:

```bash
chmod +x ~/.local/bin/spool-clipboard
```

手動確認:

```bash
~/.local/bin/spool-clipboard
```

---

## KDE アプリケーションランチャー

配置先:

```text
~/.local/share/applications/spool.desktop
```

内容:

```ini
[Desktop Entry]
Type=Application
Name=spool
Comment=Add clipboard text to spool
Exec=/home/kohei/.local/bin/spool-clipboard
Icon=/home/kohei/.local/share/icons/spool.svg
Terminal=false
Categories=Utility;
```

反映:

```bash
chmod +x ~/.local/share/applications/spool.desktop
update-desktop-database ~/.local/share/applications
```

KDE のアプリケーションランチャーで `spool` を検索し、右クリックして **「パネルに追加」**。

---

## インストール手順

ダウンロードした SVG が `~/Downloads/spool.svg` にある場合:

```bash
mkdir -p ~/.local/bin
mkdir -p ~/.local/share/icons
mkdir -p ~/.local/share/applications

cp ~/Downloads/spool.svg ~/.local/share/icons/spool.svg
```

その後 `spool-clipboard` と `spool.desktop` を上記内容で作成する。

付属の `install-spool-kde.sh` を使えば一括で登録できる。

```bash
bash install-spool-kde.sh ~/Downloads/spool.svg
```

---

## Wayland に移行した場合

`spool` 本体は変更しない。

変更対象は clipboard adapter だけ。

X11:

```bash
xclip -selection clipboard -o
```

Wayland:

```bash
wl-paste
```

KDE ランチャーと `spool add` の境界はそのまま維持する。

---

## トラブルシュート

### 0 byte のファイルができる

クリップボード取得側が失敗している可能性が高い。

X11 で `wl-paste` を実行すると、Wayland server に接続できず空 stdin が `spool add` に渡ることがある。

現在の X11 環境では `xclip` を使用する。

### パネルから起動すると spool が見つからない

GUI セッションの `PATH` に依存しないよう、`.desktop` や helper では:

```text
/home/kohei/.local/bin/spool
```

のように絶対パスを使う。

### アイコンが更新されない

一度パネルからランチャーを削除して再追加する。
必要なら Plasma を再ログインする。

---

## 設計上の境界

```text
spool
  stdin -> chronological ordinary file

spool-clipboard
  X11 clipboard -> stdin

KDE launcher
  click -> spool-clipboard

spool.svg
  presentation only
```

クリップボードや KDE 固有処理を `spool` 本体に入れない。
