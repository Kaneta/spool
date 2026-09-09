# DESIGN-v2 再監査

## A. Final verdict

`NOT READY`

前回の修正で、旧レビューの多くの指摘は具体化されました。特に、read/delete の dirfd 境界、Bridge の主要な atomic transition、purpose の厳密検証、uncertain の内部 phase 追跡は前進しています。

ただし、実装開始を止めた2点はまだ解消していません。

1. **B1 は PARTIALLY RESOLVED**: MAC の構成は Bridge による handshake 差し替えを、`pairing_secret` が漏れていない条件では防ぎます。しかし QR を盗み見た第三者は正規 B と同じ `join_secret` / `pairing_secret` / join capability を持ち、正規 B と暗号上区別されません。さらに、双方の confirmation 完了前に送信を禁止する状態遷移が API として閉じていません。
2. **B2 は NOT RESOLVED**: save の `linkat(AT_FDCWD, <rootPath>/.spool-tmp-..., dirfd, ...)` が残っており、publish source が root path に依存します。設計自身が認める通り、inode照合後の補償 unlink は一時的な誤 publish を原子には戻しません。

加えて、Baseline §11 の PC 本文検索を削除した点、Baseline §8 の nonce 非再利用を random collision probability に置き換えた点は、単なる好みではなく上位仕様との不一致です。

---

## B. Previous BLOCKER status

### B1 E2EE pairing — `PARTIALLY RESOLVED`

解消された部分:

- `session_id` と join capability は分離された。
- QR の `A_static_pub` と、B の `B_eph_pub` が鍵導出に入る。
- `session_id`、両公開鍵、`expires_at`、`bridge_base_url`、version が transcript hash と MAC に束縛される。
- `K_confirm_a` / `K_confirm_b` と role byte が分離され、ECDH と QR secret の両方を知らない Bridge は MAC を偽造できない。
- A→B、B→A の key confirmation 計算自体は相互になっている。Bridge が B の handshake を別の公開鍵へ差し替えるだけでは A の `confirm_b` 検証に失敗する。A の `confirm_a` は A static private key と QR secret の知識を B に証明する。

未解消の部分:

- **QR bearer と正規 B の区別がない。** QR に `join_secret` と `pairing_secret` が平文の認証材料として載るため、QR を盗み見た M は正規 B と全く同じ join capability を計算できる。M が先に join すれば一回限りの B slot を消費でき、正常 B は join できない。M が先に join しなくても、M は同じ transcript と MAC を生成して A に B として受け入れられる。
- これは「Bridge が QR を差し替えられない」という性質とは別である。現設計が認証するのは「QR secret を持つ相手」であり、「意図した物理端末 B」ではない。
- A は `confirm_b` 検証直後に `confirmed = true` とし、`confirm_a` を投稿する。B がそれを検証した事実を A が受け取る状態・endpoint はない。`paired` は handshake message が両方存在すること以上を定義していない。したがって「双方が confirmed になるまで本文を送らない」を実装可能な共有契約にできていない。少なくとも B 側が未確認なら data を受理しない、かつ A 側の送信開始条件を明示する必要がある。

結論: **旧レビューの一方向 MAC 欠陥と transcript 欠落は解消**。しかし、QR 盗視を脅威に含めた pairing authentication と、双方確認済みの送信 gate は未解消なので RESOLVED にはできない。

### B2 filesystem boundary — `NOT RESOLVED`

解消された部分:

- 起動時に root directory fd を pin する。
- read は `openat(dirfd, name, O_RDONLY | O_NOFOLLOW)` 後に `fstat` し、開いた実体が regular file であることを確認する。確認後に name が差し替えられても、read は開いた inode に閉じる。
- delete は `openat` + `fstat` 後に `unlinkat(dirfd, name, 0)` を使う。確認後に同名 entry が差し替わっても、削除は pin した root 直下の entry に限られ、root 外へは出ない。これは delete の security boundary として Baseline 上許容できる。
- list も pin した fd の directory read と fd 相対 open を使う。

未解消の blocker:

```text
linkat(AT_FDCWD, <rootPath>/.spool-tmp-<16hex>, dirfd, final, AT_SYMLINK_FOLLOW)
```

- source 側だけ root path を再解決している。
- temp 作成後 publish 前に root path が rename・置換されると、別 directory の同名 temp を pinned root の final に hard-link できる。
- step 4 の inode照合は publish 後の検知であり、誤った final entry が存在する時間、他 reader が観測する時間、unlink 自体の失敗を原子には消せない。
- `AT_SYMLINK_FOLLOW` は source symlink を追従させ得るため、no-follow boundary の説明とも矛盾する。
- 「root directory 自体へ書込できる攻撃者は対象外」という限定では足りない。root path の親を置換できる主体だけでも、この source path race を発生させられる。Baseline §5/§13 と今回の指定どおり、root path 依存 race が残る限り BLOCKER である。

最小の正しい publish primitive は、temp も final も同じ pinned fd 相対にすることである。

```text
linkat(dirfd, temp_base_name, dirfd, final_name, 0)
```

Linux では open fd を `/proc/self/fd` 経由で逃がす必要はなく、macOS を含む POSIX の `linkat` の olddirfd/newdirfd に同じ dirfd を渡せる形を先に採用すべきである。`AT_EMPTY_PATH` は Linux 専用の別案であり、ここでは不要である。

---

## C. Remaining BLOCKER

1. **B2 save/publish の root path race**。`linkat` の source を dirfd-relative に変更するまで残る。
2. **B1 pairing の認証対象が QR secret holder に留まること**。QR 盗視第三者を正規 B と区別する要件を維持するなら、現在の QR bearer model だけでは不足する。別の端末間確認材料（例えば表示コードの手入力など）が必要で、設計上の脅威モデルを明示的に確定する必要がある。
3. **Baseline §11 の PC 本文検索逸脱**。Baseline は軽い name/title filter に加えて必要時の本文検索を要求し、大規模・複雑な検索を `rg` / shell / AI に委ねている。PC UI 本文検索を全面削除する判断はその再解釈であり、設計を戻すか Baseline を製品理由付きで改訂するまで compliant ではない。
4. **Nonce の絶対非再利用契約**。設計は random collision probability の受容を明記しただけで、Baseline §8 の「同一鍵で nonce を再利用しない」を満たしていない。これは AES-GCM の安全性に直接関わるため、厳密な契約を維持するなら残る。

---

## D. Remaining SHOULD-FIX

1. QR wire format と transcript の実バイト表現を固定する。現在の pipe 表記は URL 内の区切り文字や escape 規則を定義していない。巨大な CBOR は不要で、固定長 field + `u16 length + URL bytes` 程度で足りる。
2. `bridge_base_url` を canonicalize する規則を固定する。scheme/host の ASCII lowercase、default port、末尾 slash、query/fragment、userinfo、IDN、cross-origin redirect の扱いを決め、T と HTTP 接続先で同じ値を使う。
3. `expires_at` は QR・JSON・T の全てで同じ表現（例えば unsigned epoch seconds, big-endian）を使い、範囲・timezone・Bridge が受理した値との一致を明記する。P-256 公開鍵も uncompressed 65-byte、canonical point、infinity/invalid point 拒否を明記する。
4. H2 の「同じ transaction」を persistence 実装可能な契約へ落とす。最低限、`(session_id, sender_role, transfer_id)` の一意制約、body 完全受信後の insert、session invalidation と upload/ack の線形化点、GET の status/read の transaction 境界、purge との競合を定義する。
5. captured 判定を単なる日付 prefix 判定から、生成 filename validator と整合する exact validator にする。valid date だが title 規則外の root file を `captured` と誤分類しない。
6. publish 後の inode mismatch / temp unlink failure を `failed` と扱う箇所と `uncertain` の規則を統一する。link が一度成功した時点で commit の可能性を否定しない。
7. Linux/macOS の durability を個別に固定する。directory `fsync`、macOS の `F_FULLFSYNC` の適用対象、失敗時の結果を「同等」とだけ書かない。
8. §17 の PROVISIONAL な OS/filesystem、text size、TTL、quota/rate、Mobile browser を、該当機能の実装前に製品判断として確定する。設計自身がこの値を実装 gate と認めている。

---

## E. Previous findings matrix

| 前回項目 | 状態 |
|---|---|
| B1 | partially resolved |
| B2 | unresolved |
| H1 | resolved（操作系は共通化。ただし分類 validator は SHOULD-FIX） |
| H2 | partially resolved |
| H3 | resolved |
| H4 | resolved |
| M1 | resolved |
| M2/M3 | resolved |
| M4 | resolved |
| M5 | partially resolved（規則は明文化。captured 判定の exactness が残る） |
| M6 | unresolved（random nonce を確率保証と明示したが、Baseline の絶対契約は満たさない） |
| M7 | resolved |

### HIGH 再確認

- **H1**: safe root-direct-child name validation と generated filename validation は分離され、external `.txt` も list/read/send/delete の対象になった。H1 の主欠陥は解消。ただし §3.6 の分類が生成規則全体ではなく日付 prefix だけなので、M5 系の SHOULD-FIX が残る。
- **H2**: upload 完全受信後の atomic insert、同 ID の一意制約、ack bytes/state 同一 transaction、receiver-only POST、cancel/expiration との線形化は明記された。旧レビューの未定義状態は大部分解消。ただし persistence 方式に依存しない実装契約としては transaction の境界と GET/read/purge の線形化がまだ抽象的で、完全 resolved とはしない。
- **H3**: data は `purpose == 0x01`、ack は `purpose == 0x02` を厳密比較し、purpose は AAD に入る。解消。
- **H4**: server 内部で publish phase を追跡し、publish 前の確認済み failure と publish 後の uncertain を分け、応答断を client uncertain とした。解消。ただし B2 の inode mismatch 経路は publish 後を failed と書いており、別途整合が必要。

### MEDIUM 再確認

1. Mobile `kind` 削除 — 解消。`name` / `text` のみ。
2. filename UTF-8 byte 制約 — 解消。code point と byte を分離し、255 byte 算術を明記。
3. suffix 可変桁 — 解消。`~99` 後も桁を増やし、byte limit を優先。
4. future clock rejection — 解消。未来拒否を削除。
5. TS / Go filename 規則 — 大部分解消。ASCII whitespace、grammar、UTF-8 境界、normalization 方針を明記。ただし classifier の exact validator が不足。
6. random nonce の確率保証 — 修正内容自体（絶対保証と偽らない）は解消。しかし上位 Baseline の絶対的な nonce 非再利用契約との不一致は残る。
7. Mobile↔Bridge CORS / CSP — 解消。HTTPS、exact origin list、wildcard/無条件反射禁止、Mobile `connect-src` を明記。

---

## F. E2EE final verdict

| 項目 | 判定 | 理由 |
|---|---|---|
| pairing authentication | `BLOCKER` | MAC は QR secret holder を認証するが、QR 盗視第三者と正規 B を区別しない |
| join capability | `SHOULD FIX` | session ID 分離と一回性は OK。ただし bearer QR を盗んだ者も同じ capability を持つ |
| transcript | `SHOULD FIX` | fixed-length の binary 部分は良い。QR framing と URL canonicalization が未固定 |
| KDF | `OK` | ECDH X と pairing secret を HKDF に入れ、transcript hash と domain-separated labels を使う構成は妥当 |
| key confirmation | `SHOULD FIX` | A/B の MAC 式は相互。双方 verification 完了を送信 gate にする共有状態が不足 |
| envelope | `OK` | version/purpose/session/direction/transfer_id を固定 AAD に束縛し、data/ack purpose を厳密検証 |
| nonce | `BLOCKER` | random nonce は衝突を検出・防止せず、Baseline の絶対非再利用を満たさない |
| ack | `OK` | receiver-only、逆方向 key、purpose 0x02、同一 transfer の bytes/state atomicity が定義されている |
| reload secret lifetime | `OK` | confirmed 後に必要な方向鍵だけ保存し、pairing/confirmation secret を保存しない。失効時に破棄する |

### 二秘密構成

現状の二秘密は安全性の必須条件ではない。Bridge は `join_capability` しか見ず、pairing secret を逆算できないため、**domain separation を正しく入れれば一つの QR secret に SIMPLIFY 可能**である。例えば同じ `S` から、`HMAC(S, "spool-join/v1" || session_id)` と `HMAC(S, "spool-e2ee-salt/v1")` を別々に導出し、後者を HKDF salt に使う。

ただし、二秘密は join authorization と E2EE authentication の漏洩範囲を分ける defense-in-depth ではある。現在のまま二秘密を維持しても誤りではないが、小ささを優先するなら `SIMPLIFY` が可能であり、どちらを採るかを wire format として固定する必要がある。二秘密にしても QR 盗視問題は解決しない。

---

## G. Filesystem final verdict

| 項目 | 判定 | 理由 |
|---|---|---|
| root pinning | `OK` | process lifetime の dirfd pinning。path 検出は UX 用で boundary 依存なし |
| read | `OK` | dirfd-relative `openat` + `O_NOFOLLOW` + post-open `fstat` |
| delete | `OK` | dirfd-relative `unlinkat`。race があっても root 外へ出ず、symlink を追わない |
| save/publish | `BLOCKER` | source 側 `AT_FDCWD` + rootPath が残る |
| symlink race | `BLOCKER` | read/delete は閉じるが、publish source の `AT_SYMLINK_FOLLOW` が残る |
| root replacement | `BLOCKER` | pinned root 自体は安全だが、publish source の再解決が置換された root を使い得る |
| durability semantics | `SHOULD FIX` | publish phase と fsync の意図は良いが、OS別の directory flush が未固定 |
| Linux/macOS portability | `SHOULD FIX` | Windows除外は明確。Linux/macOS の linkat flags と durability 実装差が未確定 |

---

## H. Complexity check

| 対象 | 判定 | 理由 |
|---|---|---|
| 2 pairing secrets | `SIMPLIFY` | domain-separated derivation で一つにできる。現行二秘密も防御上の分離としては妥当 |
| Bridge state | `KEEP` | upload/ack/cancel/TTL の線形化に必要な最小 state。追加の accept/download/receipt DB は不要 |
| filesystem primitive | `KEEP` | Baseline の実 I/O boundary に必要。linkat の source fd だけ修正する |
| crypto transcript | `KEEP` | session/key/expiry/endpoint binding に必要。巨大 serializer は不要 |

---

## I. Minimal final patch

実装開始前に必要な最小 patch は次の8件。

1. save の publish を `linkat(dirfd, tempBase, dirfd, final, 0)` に変更し、root path と `AT_FDCWD` を source から排除する。inode照合は補助検証として残してよい。
2. QR 盗視第三者を排除する要件を維持するなら、QR secret possession 以外の端末間確認材料を追加する。追加しない場合は「QR を読める者を pairing authorized bearer とする」と脅威モデルを明記し、正規 B 認証という主張を削る。この選択なしに B1 を resolved にしない。
3. A/B の confirmation verification 完了を送信条件にする状態遷移と endpoint 契約を明記する。片側の local `confirmed` だけで data upload を開始できないようにする。
4. QR/T の canonical bytes を固定する。固定長 binary fields、URL length prefix、canonical HTTPS URL、epoch-seconds、P-256 public key encoding/validation を一つの wire rule にする。
5. Bridge の session status、upload、ack、GET、purge を、実 persistence の一意制約・transaction/CAS・read boundary へ落とし、同 ID 同 bytes / 異 bytes と cancellation ordering を実装可能にする。
6. PC UI 本文検索を復元するか、Baseline §11 を「PC UI は name filter のみ」と製品理由付きで改訂する。現状のままでは上位仕様逸脱。
7. nonce の厳密非再利用 allocator を設計する。複製 tab、reload、双方向 key ごとの競合を含めて保証できないなら、random probability を受け入れる Baseline変更なしに実装開始しない。
8. §17 の初期 OS/filesystem、サイズ、TTL/rate/quota、Mobile browser と Linux/macOS durability semantics を確定し、captured filename validator を exact generated rule に揃える。

`READY` にするために要求を緩めるべきではない。現状は、crypto primitive の選択が良いことや設計の説明量が増えたことを理由に、B1/B2 と Baseline §8/§11 の不一致を通過させられない。
