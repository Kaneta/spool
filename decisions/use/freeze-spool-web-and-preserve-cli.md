# Spool Webを凍結し、Spool CLIを独立して維持する

**Status:** Accepted  
**Date:** 2026-10-21  
**Scope:** `Kaneta/spool` のWeb／PC利用、将来の再構成方針

## Decision

- **Spool Web（`spool.knc.jp`）は現行の完成形として凍結する。** 利用者が理想と評価しているUI・操作の意図を長期の参照契約として保存し、当面の機能追加やローカルPC向け同期実装は進めない。障害・安全性のための最小限の保守を禁止する意味ではない。
- Spool WebのIndexedDBデータとPCの `~/spool/*.txt` は現在接続されていない。接続しているかのように説明しない。**今は移行・同期・リポジトリ分割をしない。** Web内の既存データもCLIの通常ファイルも変更しない。
- PCの**`spool add` CLI**（stdin → ordinary `.txt` をcreate-onlyで保存）と、Rofi／Clipboardアダプターを継続する。この操作はHTTPサーバーやブラウザを起動せずに完結しなければならない。既存のファイル名・非上書き・確定成功／失敗／不確実結果の契約を維持する。
- 現行の**引数なし `spool` で起動するlocalhost HTTPサーバー／PCブラウザUIは試作として扱う。** これを将来の製品実装の起点や、必須の互換性対象にしない。旧コードを残すこと自体は契約ではないが、削除や起動挙動の変更はCLIの回帰検証と別の明示的工程で行う。
- 将来、`~/spool/` のテキストへWeb UIからアクセスする価値が確かめられた場合に、**完成済みSpool WebのUI Decision・実機Evidence・使い勝手**を入力として、新しい小さな実装をアトミックに設計する。旧HTTPのコード・API・ライブラリ構成を移植する前提は置かない。
- その将来案の接続方法（Tailscale Serve、PCローカルHTTP、その他）、スマホキャッシュ、新規送信、書込み認可、提供URL、配布方式は**未決定**。現在のWebを移行する必要はない。
- **Rollは別製品**であり、PCの画像を閲覧してClipboardへ出力する。Spoolのテキスト保存機能や現行WebをRollへ統合しない。連動構想はRoll／将来のテキスト側の別Decisionとする。

## Why

Spool WebのUIは既に利用者の要求を満たしている。一方で、PCの通常ファイルを扱う日常経路は `spool add` とRofiだけで十分機能しており、HTTPは必須ではない。未決定の接続方式に合わせて完成したWebやCLIを改造すると、保守範囲と移行リスクだけが増える。

**試作は使い捨てても判断は蓄積する。** 現在の製品を固定し、将来の必要が明らかになった段階で新実装をDecisionから起こす。

## 現行実装・文書との境界

- `pc/main.go`: `spool add` はCLI直行、引数なしはHTTP起動という現行の二経路。Rofi／`spool-clipboard` はCLIを使用する。
- `pc/internal/server/`、`ui/src/main.pc.ts`、`pc/web/dist/`：試作HTTP／PC UIとして残存するが、今回のDecisionで機能変更・削除を実施するものではない。
- `ui/` の現行Spool Webビルド・`docs/UI-DESIGN.md`：完成UIの参照。既存ブラウザ内データを触らない。
- `DESIGN-v2.md`：従来の複合Web／PC／Bridge実装設計を履歴として維持する。本Decisionの凍結・分離方針と衝突する**今後の実装計画**は、本Decisionを優先する。ただし過去に動作したというEvidenceやCLIに有効な保存契約まで否定しない。

## Rejected / deferred

- Spool WebとCLIを今すぐ一つに統合すること、現行IndexedDBと `~/spool/` のデータ移行。
- 完成Webのためだけに新リポジトリを作ること。
- 将来のテキストHTTPサーバーを、現行試作HTTPから無条件に拡張・流用すること。
- Rollをテキスト＋画像の統合ビュー／同期サーバーへ拡張すること。

## Evidence / Reopen when

「UIは理想で完成している」は2026-10-21の利用者評価であり、公開HTTPの現在の状態や全端末での動作確認を本Decisionで新たに認定しない。保存CLIの実機確認は既存checkpoint参照。今回の記録だけで旧HTTPの稼働停止・配備・削除は行わない。

`~/spool/` をブラウザから使う具体的な利用頻度・閲覧／送信条件・保護すべき入力が明らかになったとき、接続方式と必要なWeb UIを改めて設計する。現行Webの安全性・機能上の修正が必要になったときは凍結の範囲内で対応する。

## 上位原則

KNC Architectureの[PrototypeからDecisionを継承する](https://github.com/Kaneta/knc-architecture/blob/main/decisions/use/inherit-decisions-from-prototypes.md)に従う。
