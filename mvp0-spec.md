# cowork MVP-0 実装スペック(2026-07-25 時点の初期設計)

> この文書は 2026-07-25 時点の設計であり、現在の計画の正本ではない。
> 正本は `work/2026-07-30-process-synthesis/proposal.md`。実装の現況は Tier 0 まで到達しており
> (PR #3・2026-08-01)、本スペックの記述は当時のまま残している。食い違ったときは正本を採る。

## 位置づけ — Phase -1 と競合しない

Phase -1 の手作業は「方針10行 + 指示履歴を共有ドキュメントに貼り、別の人が引き継げるか試す」
([docs/records/phase-minus-1.md](docs/records/phase-minus-1.md) §2)。**MVP-0 はこのうち「指示履歴を集めて貼れる形にする」だけを自動化する。**

- Phase -1 を止めない。むしろ貼る材料が自動で用意される
- phase-minus-1.md §2 の抽出スクリプトは `~/.claude/projects/*/*.jsonl` を直接読んでいる。
  **MVP-0 はこれを公式 hook 経路に置き換える**(非公式機構への依存を減らす)
- Phase -1 が「メモだけで引き継げた」に終わっても無駄にならない。
  捨てるのは合流機構であって、指示ログの収集ではない(phase-minus-1.md §1 の表)

## 作るもの

`cowork` CLI 1本。サブコマンド6つ。

| コマンド | やること |
|---|---|
| `cowork init` | cowork-state リポジトリの初期化 |
| `cowork capture` | **hook 専用**。`UserPromptSubmit` の stdin JSON を受けて追記する。`PostToolUse`(matcher: `AskUserQuestion`)は回答を `kind:"answer"`、`Stop` は最終AI返答(`last_assistant_message`)を `kind:"ai"` として同じ時系列に追記する(いずれも Run 1 のFBで追加。下記) |
| `cowork brief [thread]` | phase-minus-1.md §3 のテンプレートを埋めて標準出力へ。**Phase -1 で貼るのはこれ** |
| `cowork list [--all]` | スレッド一覧。既定は「自分が未確認 × バッジ付き」(decision-records.md §7.2) |
| `cowork receipt <thread> --kind <k>` | 確認の記録を追記する |
| `cowork why <thread>` | バッジの根拠を展開する(§7.3 の「根拠へ展開できること」の規約) |

**MVP-0 では作らない**: 合流 / Web UI / 自動同期デーモン / union merge driver /
リスク階層のパス推定(decision-records.md §7.5 で未実測。Phase 0 まで保留)

同期は **Phase -1 の間は手動 `git pull` / `git push`** でよい。`cowork sync` は作らない。

## 確定した技術的事実(実測済み。再検証しないこと)

- `UserPromptSubmit` hook の stdin JSON の**実機フィールド名は `prompt`**。
  公式ドキュメントの `user_message` ではない(feasibility.md)。
  **capture は `prompt` → `user_message` の順で両対応する**(表記が公式側に揃えられた場合、
  exit 0 のまま全指示を無言で取りこぼすため。2026-07-25 の精査指摘で復元した要件)
- **Stop hook の stdin JSON には `last_assistant_message`(最終AI返答の全文)が公式フィールドとして入る**
  (実機 v2.1.220 で確認)。トランスクリプトの非公式パースなしでAI返答を記録できる。
  人間の指示・回答は直前のAI発話への反応なので、AI側が無いと判断の意図を汲み取れない(Run 1 のFB)。
  **記録は全ターン分・表示は brief で200字に切り詰め**(`--full` で全文)という記録/表示の分離で、
  「AIの出力を貼らない」規律(量の問題)と両立させる。
  Stop 経路でも intent スナップショットを取るため、セッション末尾のAIによる intent.md 更新も拾える
- **AskUserQuestion への回答は `UserPromptSubmit` を通らない。** `PostToolUse` hook の
  `tool_response` に入る(実機 v2.1.220 で確認。Phase -1 Run 1 で発覚)。形状は2通り:
  構造化 `{questions, answers: {質問全文: 回答}, annotations}` と文字列 `The user answered: ...`。
  拒否(Esc)時は `User rejected` で始まる文字列になるので**記録しない**。
  どちらの形でも解釈できない場合は記録せず capture-errors.log に残す(形状変更に気づく経路)
- stdin JSON に `session_id` / `cwd` / `transcript_path` / `prompt` / `hook_event_name` が入る
- **hook の失敗が Claude Code を止めてはならない。何があっても exit 0**
- ただし **exit 0 は失敗を不可視にする**。stderr は hook 実行時に誰も見ないので、
  失敗した時だけ `<COWORK_STATE>/capture-errors.log` に1行残す。
  「動いていなかった」に後から気づける経路が1本要る

## スレッドID

**git のブランチ名から作る。**

- `thread_id = branch.replace(/\//g, "-")` — `feature/0042-x` → `feature-0042-x`。
  スラッシュを潰さないと `threads/<id>/` が入れ子になり一覧が壊れる
- `main` / `master` / detached HEAD → **`_unfiled-<repo>`**(捨てない)。
  **リポジトリごとに分けること。** 単一の `_unfiled` にすると、`main` で作業した全リポジトリの
  指示が1本の `instructions.jsonl` に積まれ、`brief` が複数リポジトリの混ざった履歴を出す。
  brief は Phase -1 で他人が予備知識なしに読む唯一の資料なので、**混ざったメモは無いより悪い**
- **`docs/cowork/<thread_id>/intent.md` は同じ文字列を使う**。
  decision-records.md §6(a) でスレッドIDを主キーと決めているので、名前は単一でなければならない
- 新しい開始操作(`cowork start` 等)は作らない。ブランチを切ればスレッドができる

## データ形式

```
cowork-state/                    # 既定 ~/cowork-state。COWORK_STATE で上書き可
└── threads/<thread_id>/
    ├── instructions.jsonl       # 追記のみ
    ├── intent-log.jsonl         # 追記のみ。intent.md が変わった時だけ1行
    └── receipts.jsonl           # 追記のみ
```

**すべて追記のみ。既存行を書き換えない**(cowork-state が衝突しない性質の根拠)。

```json
// instructions.jsonl
{"ts":"2026-07-25T11:00:00Z","by":"a@example.com","by_name":"takuto",
 "repo":"your-repo","branch":"0042-payment-refactor","session_id":"...","prompt":"..."}
// AskUserQuestion への回答も同じファイルに時系列で入る(kind で区別)
{"ts":"...","by":"a@example.com","by_name":"takuto","repo":"your-repo",
 "branch":"0042-payment-refactor","session_id":"...","kind":"answer",
 "prompt":"実施時間はどれくらいを想定していますか？ → 90分\n参加者の環境はどうしますか？ → 発表者のみ"}
// 回答行は質問の全文を使う(短い header に圧縮しない)。
// brief だけを読む人に質問の背景が伝わることを優先する(Run 1 のFBで決定)

// intent-log.jsonl  (capture 時に intent.md を読み、直前と hash が違う時だけ追記)
{"ts":"...","by":"a@example.com","hash":"ab12...","body":"<intent.md の全文>"}

// receipts.jsonl
{"ts":"...","by":"a@example.com","by_name":"takuto","thread":"0042-payment-refactor",
 "kind":"read","note":""}
```

**`by` は `git config user.email`。** `user.name` は表記揺れ(takuto / Takuto / 本名)で
「自分の未確認」フィルタが黙って壊れるので、キーには使わない。表示にだけ `by_name` を使う。
`user.name` が未設定なら**メールアドレスのローカル部(@より前)**を表示名にする。
生のメールアドレスを一覧やバッジに出さないこと。

上記3ファイルが MVP-0 の範囲。設計上はこのほかに `thread.md` / `links.jsonl` / `sessions/` があり
(proposal.md §5.1)、いずれも後続フェーズで追加する。

**`cwd` は記録しない。** 作業者のローカルパスであって他人の環境では解決できない。

### なぜ intent.md の本文を過程側に持つのか

`intent.md` の正本はコードのリポジトリ側(上書きで最新を保つ)。
`intent-log.jsonl` はその**スナップショットの時系列**であって、競合する正本ではない。

これがないと `cowork list` が他人のコードリポジトリを読まなければバッジを出せない。
**過程側に閉じて計算できるようにするための記録**である(10行なので量も問題にならない)。

## `cowork list` の表示規則

```
▼ 要確認 (2)
  0042-payment-refactor   [方針変更]     最終指示 2h前  takuto
  0038-rate-limit         [object:田中]  最終指示 5h前  tanaka

▶ その他 (17件)  — `cowork list --all` で展開
```

- **既定** = 自分(`git config user.email`)の確認が無い **かつ** バッジが1つ以上
- **順位は保存しない。表示時に各自のクライアントが決める**(decision-records.md §7.1)
- MVP-0 のバッジは2つだけ:
  - `方針変更` — `intent-log.jsonl` に異なる hash が2つ以上ある
  - `object:<名前>` — receipts に `kind:"object"` がある
- **バッジは根拠へ展開できること**(§7.3 の規約)。`cowork why <thread>` で
  intent.md の版間 diff / 異議の note を出す

**表示は3群。畳むだけで、消してはならない。**
`--all` で `▼ 要確認` / `▼ 確認済み` / `▼ バッジなし` の全群を出す。
群分けは**すべて自分の視点**であり、他人の確認状況では決して分けない。

**`object` は「確認済み」にしない。**
確認の深さは `read` / `understood-intent` / `ran` の3段階で、
`object`(異議あり)はそれとは別種のマークである(solution.md「D. 確認する」)。
異議を出したスレッドこそ追い続けたいので、`object` で未確認を解除しない。

**`--kind` は4語に限定する。** `read` / `understood-intent` / `ran` / `object` 以外はエラーで落とす。
検証しないと、タイポで**黙ってスレッドが一覧から隠れる**。

## 実装側の禁止事項

**他人の未確認を出す経路をコード上に作らない**(decision-records.md §7.6)。

- 参加者名簿を持たない。receipts に無い人を列挙する処理を書かない
- 「誰が確認済みか」は出してよい。「誰が確認していないか」は出さない
- 自分の未確認は自分にだけ出す

## `cowork brief` の出力

**節の構成と見出しは phase-minus-1.md §3 のテンプレートと完全に一致させる**(そのまま貼るため)。
自動で埋まるのは「方針」「ブランチ」「AIに出した指示(時系列)」だけ。
残りはプレースホルダのまま出し、人が埋める(3分で書ける量が上限という制約に従う)。

「方針」節には `intent-log.jsonl` の最新 body をそのまま入れる。
`intent.md` 自体がテンプレートの5項目(なぜ/何を/やらないこと/触る範囲/完了条件)で書かれている前提であり、
**cowork 側で整形はしない**(整形すると人が書いた内容を書き換えることになる)。
`intent-log.jsonl` が空なら、テンプレートの空欄5行をそのまま出す。

```markdown
## スレッド: <thread_id>

### 方針
<intent-log.jsonl の最新の body。無ければテンプレートの空欄をそのまま>

### 判断したこと
- <選んだ案> ← <棄却した案> を採らなかった理由

### 現在地
- 終わったこと:
- 残っていること:
- ブランチ: <branch>

### AIに出した指示(時系列)
- <instructions.jsonl から古い順に。改行はスペースに畳む>
```

引数を省略したら**カレントブランチのスレッド**を出す。

## 技術選定

- **Node.js + TypeScript。ただしビルドは持たない。**
  Node のネイティブ型ストリッピングで `.ts` を直接実行する(実測: Node v22.23.1 でフラグ不要、
  `node --test` も `.ts` で通る)
- **ビルド成果物を hook が指してはならない。** `dist/` を指すと gitignore された成果物を
  clone 先が持たず、**`capture` は常に exit 0 なので誰も気づかないまま指示が1件も記録されない**。
  型ストリッピングを使えばビルド自体が存在しなくなるので、この失敗経路が構造的に消える
- **`@ts-nocheck` を禁止する。** 型検査を無効にした `.ts` は `.js` より悪い(型がある顔をして無い)。
  `tsconfig.json` は `erasableSyntaxOnly` と `verbatimModuleSyntax` を有効にし、
  型ストリッピングで動かない構文(enum / namespace / parameter properties / decorators)を
  **コンパイラ側で禁止**する。import は `./lib.ts` と拡張子付きで書く
  (`allowImportingTsExtensions` が要る)
- **ランタイム依存ゼロ。** devDependency は型検査用の `typescript` と `@types/node` のみ。
  **Node の型を手書きしないこと。** 手書きの `.d.ts` は実際のシグネチャとずれ
  (例: `spawnSync` の `stdout` は `encoding` を渡さなければ `Buffer` であって `string` ではない)、
  **自分で書いた不正確な型に対して strict チェックが通る**という最悪の形になる
- **パッケージマネージャは pnpm。** `packageManager` フィールドで版を固定し corepack 経由で使う
- 置き場: リポジトリ直下の `cowork/`

### bin は plain JavaScript の shim にする

**Node 22.18 未満では `.ts` がパースできず、hook が無言で死ぬ。**
`capture` は仕様上必ず exit 0 で終わるので、この失敗は自力では絶対に発覚しない
(`dist/` の件・絶対パスの件と同じ失敗の3度目の入口)。

したがって **`bin/cowork.js` だけは素の JavaScript** にし、そこで

1. Node のバージョンを確認し、足りなければ**何が問題かを明示して**終わる
2. `../src/cli.ts` を動的 import する。失敗したら `capture-errors.log` に理由を残す
3. 終了コードの規約(`capture` は常に 0、それ以外は通常どおり)はここで一元管理する

shim が `.js` である理由は1つだけ — **どの Node でも必ずパースできる必要があるから**。
ここに型は要らない。

## 受け入れ条件

1. hook を入れた状態で Claude Code に指示を出すと `instructions.jsonl` に1行増える
2. **hook が失敗しても Claude Code の動作を妨げない**(exit 0)
3. `cowork brief` の出力をそのまま共有ドキュメントに貼れる(phase-minus-1.md §3 と同形)
4. `cowork list` が既定で短い(バッジなしが畳まれている)
5. **他人の未確認を出す経路がコード上に1つも無い**
6. 検証用の hook 登録は**プロジェクト側の `.claude/settings.json`**。
   `~/.claude/settings.json` は触らない(自分の稼働環境で試すため)
   → 2026-08-02 撤回。実運用はグローバル(`~/.claude/settings.json`)登録に移った。
   リポジトリ横断でないと「規律ゼロの受動捕捉」が成立せず、2026-07-30 の実測 27スレッドも
   K1 自己盲検もグローバル登録で採れている。現行の手順は cowork/README.md を正とする
7. **hook のコマンドに絶対パスを書かない。** `cowork capture` として PATH 経由で呼ぶ。
   絶対パスを git 管理下の設定に書くと、clone 先で他人のホームディレクトリを指したまま
   **exit 0 で無言で失敗する**(dist/ の問題と同じ失敗が別の入口から入る)。
   PATH に無い場合もやはり無言で失敗するので、**README に登録確認の手順を1つ置く**
