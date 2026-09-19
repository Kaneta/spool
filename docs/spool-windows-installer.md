# spool — Windows installer v1

PowerShell 単体の installer (`scripts/install-spool-windows.ps1`)。
MSI / WiX / Inno Setup / GUI installer は使わない。

## 対応環境 (確認済み前提)

* Windows 11 Home / x86-64 / 非管理者 / NTFS fixed drive
* Windows PowerShell 5.1 および PowerShell 7 双方を想定

## 対応物

| 種別 | 内容 |
|---|---|
| 配布 artifact | `spool-windows-amd64.zip` (中身: `spool.exe`, `spool-clipboard.exe`, `spool.ico`) |
| install dir  | `%LOCALAPPDATA%\Programs\spool\` (固定、変更不可 parameter なし) |
| config file  | `%USERPROFILE%\.config\spool\config.json` |
| default root | `%USERPROFILE%\spool` |
| shortcut     | Desktop `spool.lnk` → `spool-clipboard.exe`, icon `spool.ico` |

## Script interface

release host / official URL は **未決定**。script は URL/hash を仮定せず、両方を必須 parameter として受ける:

```powershell
.\install-spool-windows.ps1 `
    -ArchiveUrl https://<unreleased-host>/spool-windows-amd64.zip `
    -ExpectedSha256 <64-hex>
```

* `-ArchiveUrl`: HTTPS のみ許可 (`^https://` validation)
* `-ExpectedSha256`: zip の SHA-256 (64 hex)。`Get-FileHash` で検証し、
  mismatch は install dir に一切触れる前に fail する (SHA256SUMS 別 download なし)
* fake URL / fake hash を production default にすることはしない
* 将来 `irm <official-host>/install.ps1 | iex` 化する際は release pipeline が
  URL/hash を script に embed する設計に発展可能 (今回未実装)
* `-Launch`: install 成功後、Desktop shortcut を起動して保存できることを
  その場で確認する (v1 の goal に対応)

## 処理手順

1. `%TEMP%\spool-install-<random>` staging。以降 4 step は **install dir 変更前** に全て完了:
   1. download (`Invoke-WebRequest -UseBasicParsing`, HTTPS only)
   2. SHA-256 検証 (`Get-FileHash`)
   3. zip 展開 (`Expand-Archive`)
   4. required 3 files の存在確認
2. install dir 存在確認 → fresh / reinstall を判定
3. reinstall の場合、binary 置換前に 3 files を exclusive open で lock 確認。
   lock 無しで binary 置換 (`Copy-Item -Force`)。
4. first-run provisioning (下記)
5. Desktop shortcut 再生成 (再実行時に上書きしてよい)

## config / root initialization semantics

| 条件 | 挙動 |
|---|---|
| `config.json` 存在 | config は **一切変更しない**。root / records も触らない |
| `config.json` なし | `%USERPROFILE%\spool` を作成し、`%.config\spool\` dir を作成し、`config.json` を新規作成 |

新規作成 JSON は:

```json
{"root":"C:\\Users\\<NAME>\\spool"}
```

UTF-8 **without BOM** (`[System.IO.File]::WriteAllText(..., [System.Text.UTF8Encoding]::new($false))`)。
BOM ありだと Go の JSON parser が `invalid character '\ufeff'` で拒否する。

既存 config / root / records を delete / truncate / initialize する path は script 内に存在しない。

## Fresh install / reinstall / failure semantics

| 状況 | 挙動 |
|---|---|
| staging 完了前失敗 (download / hash / extract / 3 files 欠如) | install dir 変更なし、staging cleanup、non-zero exit |
| fresh install 中失敗 | 今回落とした 3 files が全て非空なら incomplete install dir を削除、それ以外は残置。config / root / records は削除対象外 |
| reinstall (lock) | binary copy 開始前に fail。「spool processes を終了して再実行」を user に表示 |
| reinstall (copy 失敗) | partial になり得る。shortcut は binary 更新成功後のみ再生成 |

full transactional rollback / versioned rollback は **v1 scope 外**。
「完全 rollback を保証する」とは記述しない。staging は finally で cleanup、cleanup 失敗は
primary error を隠さない。install dir に metadata / lock file は残さない。

## PATH / 制約

* **PATH 変更なし** (registry PATH mutation なし)。clipboard launcher が primary use case
* admin elevation / 恒久 execution policy 変更 / Defender exclusion / firewall / service /
  scheduled task / telemetry / auto updater / `%APPDATA%` migration: すべて禁止
* HTTPS 以外の download は不許可

## Uninstall

`scripts/uninstall-spool-windows.ps1` は deferred。将来作る場合も対象は
*install dir の installer-owned files* と *Desktop shortcut* のみで、
config / root / records は絶対削除しない。

## Deferred / 後回し

* official URL / release host の決定 (script 側 embed 化)
* Authenticode signing (現状の trust は HTTPS delivery channel に依存)
* Start Menu shortcut
* uninstall.ps1
* MSI / WiX 等の framework (使わない方針)
