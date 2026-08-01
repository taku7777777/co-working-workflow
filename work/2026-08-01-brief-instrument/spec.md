# Tier 0 — 計器を仮説が測れる状態にする(実装仕様)

日付: 2026-08-01 / 起案: Claude(設計)→ Codex(実装)
前提: work/2026-07-30-process-synthesis/proposal.md §3-C・§4 Tier 0(コミット 71014f2)
位置づけ: Phase -1 の判定(K1 自己盲検)へのクリティカルパス。**0-1 はバグ修正、0-2 は表示変更**であり、
両者を混同しない。判定文には「Tier 0 適用後の brief で測った」を併記する前提。
対象: `cowork/`(src/cli.ts, src/lib.ts, test/, README.md)

## 決定事項(ユーザーと合意)

1. 判定前に許可する実装は、この2件に限る。**スコープを広げない。**
2. 0-2 は仕様どおりの挙動を実データに基づいて変える**表示の再設計**であり、バグ修正ではない。
3. brief が満たすべきは4要素(目的 / 現在地 / 判断したこと / 未解決)。うち構造的に出せない
   「判断したこと」と「現在地」を、**すでに記録済みのデータから**埋める。

---

## 0-1 バグ修正 — intent 探索がタスクルートで壊れる

### 実測した現象と機構(再現済み)

`cowork brief tasks/0003-state-restructure` は `docs/cowork/0003-state-restructure/intent.md` が実在するのに
空テンプレを返す。追跡結果:

| 観測 | 値 |
|---|---|
| `~/cowork-state/tasks/0003-state-restructure/intent-log.jsonl` | **存在しない** |
| セッションヘッダ | `repo:""` |
| 全イベント行 | `branch:"HEAD"` |
| marker の位置 | `~/tasks/0003-state-restructure/.cowork/task.json` |
| その階層 | **git リポジトリではない**(`rev-parse --show-toplevel` が fatal) |
| 実際の intent.md | `~/tasks/0003-state-restructure/co-working-workflow/docs/cowork/0003-state-restructure/intent.md` |

機構は次のとおり。**タスクルート(クローンより上の階層)で capture が走ったときだけ**壊れる:

1. cli.ts:521 — marker が見つかると `required=false` で `rev-parse --show-toplevel` を呼ぶため、
   git 外では例外にならず `top=""` になる。
2. cli.ts:572 — `join("", "docs", "cowork", threadId, "intent.md")` が**相対パス**に落ちる。
3. プロセスの cwd 基準で解決されて ENOENT → cli.ts:577 で**無言のまま `return 0`**。

クローンの中で作業していれば `top` が解決するため動く。したがって「壊れている」のではなく
「**タスクディレクトリモデルの意図した使い方(ルートに marker、その下にクローン)でだけ壊れる**」。

### 修正

1. `findTaskMarker` の戻り値を `{ taskId }` → `{ taskId, directory }` にする
   (`directory` は `.cowork/task.json` を持つディレクトリの絶対パス)。
2. intent の探索を「**候補パスの列挙 → 実在するものすべてを記録**」に変える。候補は次の順:
   - `top` が非空なら `<top>/docs/cowork/<threadId>/intent.md`
   - marker があれば `<markerDir>/<child>/docs/cowork/<taskId>/intent.md`
     (**子ディレクトリ1階層のみ**・辞書順・`.` で始まる名前は除外)
   - `resolve` 後の文字列が一致する候補は重複排除する(クローン内で capture した場合に同じファイルを二重に数えない)
3. **`top` が空かつ marker も無い場合は探索しない**。相対パスに落ちる経路を塞ぐ
   (無関係なファイルを拾う事故の防止)。
4. 1件も見つからなくても従来どおり無言で正常終了する(指示の記録は済んでいる)。
   見つからないこと自体は 0-2 ③ の期待パス表示で可視化される。

### 併せて修正 — intent-log のピンポン増殖

cli.ts:583 は `intents.at(-1)?.hash !== hash` と**直前1件だけ**を比較する。複数リポジトリのタスクで
A・B の intent.md を交互に捕捉すると、内容が変わっていないのに版が無限に増え、
`方針変更` バッジが恒久的に誤点灯する。

- intent-log のエントリに `path` を追加する: `{ts, by, hash, body, path}`。
- `path` は **`<リポジトリ名>/docs/cowork/<threadId>/intent.md`**。
  **絶対パスは記録しない**(ユーザー名が公開ツリーに漏れる。コミット 51198ac と同じ理由)。
  リポジトリ名は その intent.md が属する git toplevel の basename。
- 追記判定は「**同じ `path` の最後のエントリ**と hash が異なるとき」に変える。
- 既存エントリ(`path` 無し)は `path:""` のグループとして扱い、移行スクリプトは書かない
  (実データは1リポジトリ1グループなので、既存の版はそのまま連続する)。
- `determineBadges` の `方針変更` は「**同一 `path` 内で** distinct hash が2件以上」に変える
  (誤バッジの防止。これが増殖の可視的な害である)。
- **`why` と brief の `path` 別表示は作らない。**1タスクに複数リポジトリの intent.md が同居する
  ケースは実データに0件であり、テストも実データで検証できない(範囲外を参照)。

---

## 0-2 表示変更 — brief の欠落2要素を埋める(バグ修正ではない)

### ① 「判断したこと」節に `kind:"answer"` を昇格

- `kind:"answer"` のレコードを時系列順に全件列挙する。実データでは 14/14 が「質問全文 → 決定」のペアで、
  現在は時系列に埋没している。
- 1レコードの本文は `質問 → 回答` が改行区切りの複数行なので、**行ごとに `- ` を付けて列挙**する
  (各行 trim、空行は捨てる)。**省略しない**(回答は短い)。
- **時系列節からは `answer` を除外する。**同じ情報を2箇所に出さない。回答は「AIに出した指示」ではなく
  「判断」であり、置く節が違う。
- `answer` が0件のときは現行のプレースホルダ(`- <選んだ案> ← …`)を維持する。

### ② 「現在地」の材料 — 各セッションの最終 `kind:"ai"` のみ全文

- rehydrate 後の `session_id` でグループ化し、**各セッションの最後の `kind:"ai"` だけ全文**表示する。
  それ以外の `ai` は従来どおり200字で省略する。実データの `ai` は中央値868字で、
  コミットハッシュ・テスト結果・次の一手を含む(現状は77%が失われている)。
- `session_id` が空のレコード群は1つのセッションとして扱う。
- `--full` の挙動は変えない(全 `ai` を全文)。
- **「現在地」節そのものの自動生成(終わったこと / 残っていること)は範囲外。**要約が必要であり、
  Tier 2-2「締めて → 4節サマリ」が担う。本項が埋めるのはその材料である。

### ③ 方針が空のときに期待パスを1行表示

- `EMPTY_INTENT` を出したときだけ、直後に1行を足す:
  `(未設定: <expected> に置くと、ここに表示されます)`
- `<expected>` は cli 側で組み立てて `generateBrief` の引数で渡す(lib.ts は fs を触らない):
  - unfiled: `<repo>/docs/cowork/<threadId>/intent.md`
  - task: `<タスク配下の各リポジトリ>/docs/cowork/<taskId>/intent.md`
- 方針が入っているときの出力は現状と一致させる。

---

## 範囲外(明示。触らないこと)

proposal §9 は「Tier 0 のスコープ拡大が Phase -1 を4巡目に押しやる」を最大のリスクに挙げている。
以下は改善ではあるが**計器の要件ではない**ので、判定後に回す:

- 相槌の畳み込み、行頭の `by_name`・日付表示
- 「現在地」節の自動要約
- セッションヘッダの `repo:""` / `branch:"HEAD"`(タスクルートで走ったときの**正しい観測値**であり、変えない)
- `why` と brief 方針節の `path` 別表示(1タスクに複数リポジトリの intent.md が実在したら着手する。
  現在0件。`path` の記録と per-path dedup だけ先に入れておく)
- Tier 1 全般(Codex 委譲プロンプトの捕捉・handoff の取り込み・ExitPlanMode・スレッドの status)
- `cowork list` の表示、doctor、SessionStart への注入

## テスト・ドキュメント

0-1:

- marker あり・**タスクルート(git 外)**から capture → 子リポジトリの intent.md が記録される
- marker あり・**子リポジトリ内**から capture → 同じ intent.md が二重に記録されない
- marker 無し・git 外から capture → 相対パスを読まない(無関係なファイルを拾わない)
- 2リポジトリの intent.md を交互に capture → エントリが増殖しない・`方針変更` が誤点灯しない
- `path` 無しの既存エントリとの互換(読み込み・バッジ・why・brief)

0-2:

- `answer` が「判断したこと」節に出て、時系列から消える / `answer` 0件でプレースホルダ
- 各セッションの最終 `ai` のみ全文、他は200字 / `--full` で全 `ai` が全文
- 方針が空のとき期待パスが1行出る / 方針があるときの出力は現状と一致

- `pnpm test` / `pnpm typecheck` 通過。
- `cowork/README.md` を更新(brief の表示仕様、intent-log の `path` フィールド、intent.md の探索範囲)。

## 制約

- 編集はこのリポジトリの worktree 内のみ。**`~/cowork-state` の実データには触れない。**
  手動確認の state は、既存テストと同じ方式(`mkdtemp(join(tmpdir(), …))` + `COWORK_STATE` 環境変数。
  `cowork/test/capture.test.ts` 参照)で用意する。新しい仕組みを作らない。
- 記録に絶対パスを残さない(ユーザー名の露出。コミット 51198ac 参照)。
- 各項目1〜2日を上限とする。超過が見えたら実装を止めて報告する(proposal §9)。
- 完了報告には 変更ファイル一覧 / テスト・typecheck の結果 / 迷った判断 を含める。

## 受け入れ確認(実装後にユーザーが行う)

一時 state に 0003 相当の構成(タスクルート + 子クローン + intent.md)を再現し、
タスクルートから capture を1回流したうえで `cowork brief tasks/<id>` が
方針・判断したこと・最終 ai 全文を表示すること。

**K1 に入る前の前提(この仕様の範囲外だが、先に潰しておく)**: proposal §6 が K1 の対象に挙げる
`unfiled/sekisho/sekisho-m1` は **unfiled スレッド**であり、リポジトリ内で capture が走るため
0-1 の障害は起きていない。方針が空なのは単に `sekisho/docs/cowork/sekisho-m1/intent.md` が
**存在しない**ためである(実測: sekisho に `docs/cowork/` 自体が無い。intent-log を持つスレッドは
全10件中2件)。Tier 0 を入れても、このままでは4要素のうち「目的」が空のまま測ることになる。
K1 の対象スレッドには**事前に intent.md を置く**か、intent.md がある対象を選ぶ。
