# spool 完成済み基礎 checkpoint (2026-09-09)

Status: 実装の完成状態の記録。上位基準は `docs/spool-design-baseline-v2.md` (Baseline)、次いで `DESIGN-v2.md`。(注: Baseline 文書は現在の repository には含まれない。DESIGN-v2.md が現行 canonical 設計) 本書は既に完成・実機確認できた範囲を checkpoint として固定するものであり、新しい設計を追加しない。実機確認の事実は記録するが、設計上の保証を追加しない。

---

## 1. 現在地 (定位)

spool は同期アプリではない。「端末を問わず、単純な内容を時系列に追加する store」である。

PC 側の完成した動線:

```text
Clipboard
  -> xclip
  -> spool-clipboard
  -> spool add
  -> ~/spool/*.txt
  -> editor / rg / shell / AI / Git / backup
```

PC では ordinary files が source of truth。一覧・検索・編集は `rg` / shell / editor / AI が直接 file を扱う。

クリップボード取得と KDE 固有処理は spool 本体に入れず、adapter (`spool-clipboard`) と launcher (`spool.desktop` + SVG) に分離する (docs/spool-kde-launcher.md)。

## 2. 完了した milestone

| 項目 | 状態 | 根拠 commit |
|---|---|---|
| M1 spool Web (Browser UI + IndexedDB) | COMPLETE | `4568fcb` |
| M2 spool Local (Go process → ordinary files) | COMPLETE | `9132b05`…`733813d` |
| M2 hardening (実境界 failure 対応) | COMPLETE | `601e20b` |
| `spool add` CLI (stdin capture) | COMPLETE | `bce9e6b` |
| KDE clipboard capture (xclip + adapter + launcher + SVG + install script) | COMPLETE | `6fd602a` |

PC 側の基本 capture path (Clipboard → xclip → spool-clipboard → spool add → ~/spool/*.txt) は実機 (KDE Plasma / X11) で動作確認済み。

M2 の詳細は `docs/milestone-2-spool-local.md`、KDE 側は `docs/spool-kde-launcher.md`。

## 3. 明示した判断

* **Search は延期 / need-driven**: 必須 milestone としない。PC では ordinary files + `rg` / shell / AI で十分か、まず実運用で確認する。UI 検索 (DESIGN-v2 §7) は need が確認された時点で再評価する。
* **bookmarklet は不採用**: クリップボード取り込みは `spool add` (stdin) 経路に一本化する。
* **Chrome extension は将来候補に留める**: 今回は作らない。need が生じた時点で検討する。
* **Bridge は次の大きな開発候補** (DESIGN-v2 §8 の protocol 設計はある) が、本 checkpoint 時点で未着手。着手判断は別途行う。

## 4. 本 checkpoint では進めないこと

* Bridge 設計・実装 (E2EE / pairing を含む)
* Web / Mobile 検索
* Chrome extension
* Wayland 自動対応 (X11 専用 adapter のまま。移行時は adapter だけ差し替える、docs/spool-kde-launcher.md)
* KDE ランチャーの追加改善
* spool 本体の新機能追加
* refactor / 一般化
