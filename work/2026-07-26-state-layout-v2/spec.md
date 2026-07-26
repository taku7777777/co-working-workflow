# cowork-state レイアウト v2 実装仕様

日付: 2026-07-26 / 起案: Claude(設計)→ Codex(実装)
対象: `cowork/`(src/cli.ts, src/lib.ts, scripts/, test/, README.md)

## 背景と決定事項

現行レイアウトは `tasks/<id>` + `threads/<repo>/<thread>` + `threads/unfiled/<repo>/<branch>` の3系統併存で、
resolveThread の曖昧性解決・衝突検査の複雑さの源泉になっている。また同一タスクの全セッションが単一
instructions.jsonl に追記されるため並行追記・git 同期で競合点になる。さらに UserPromptSubmit フックが
ハーネス注入の `<task-notification>` を人間の指示として記録している(実データ tasks/0002-policy-redesign
では prompt 6行中3行・最大8.5KB)。

ユーザーと合意した決定:

1. **名前空間は2系統に集約**: `tasks/<task-id>/`(主系・安定ID)+ `unfiled/<repo>/<thread>/`(保険系)。
   `threads/` は廃止。main/master/HEAD 特例(`isUnfiledBranch`)も廃止し、マーカー無しの capture は
   ブランチを問わずすべて unfiled 行き。
2. **instructions は 1セッション=1ファイル**: `<dir>/sessions/<session_id>.jsonl`。書き手が常に1つになり
   並行追記・マージ競合が構造的に消える。
3. **`<task-notification>` 始まりのプロンプトは記録しない**(直後の kind:"ai" 行に AI の応答要約が残るため)。

repo/branch はパスの主キーにせず、従来どおり**各行のフィールドとして**保持する(タスクは複数リポジトリを
またぐため。行スキーマは変更しない)。

## ディレクトリ構造(v2)

```
$COWORK_STATE (既定 ~/cowork-state)/
├── tasks/<task-id>/
│   ├── meta.json
│   ├── sessions/<session_id>.jsonl
│   ├── intent-log.jsonl
│   └── receipts.jsonl
└── unfiled/<repo>/<thread-id>/
    ├── meta.json
    ├── sessions/<session_id>.jsonl
    ├── intent-log.jsonl
    └── receipts.jsonl
```

## 詳細仕様

### 1. パス解決(cli.ts)

- `taskLocation(taskId)`: 従来どおり `tasks/<taskId>`。qualified は `tasks/<taskId>`、header は `<taskId>`。
- `unfiledLocation(repo, branch)`(旧 `locationFor` を置き換え):
  - `threadId = deriveThreadId(branch)`(`/`→`-` 変換は従来どおり)
  - dir は `unfiled/<repo>/<threadId>`、qualified は `unfiled/<repo>/<threadId>`、header は `<repo>/<threadId>`
  - `repo` が空(git リポジトリ外)の場合は `"_unknown"` を使う
- `lib.ts` の `isUnfiledBranch` は削除(参照箇所・テストも含めて)。

### 2. capture(cli.ts)

- **notification 除外**: UserPromptSubmit 経路(prompt / user_message)で、値の `trimStart()` が
  `"<task-notification>"` で始まる場合は何も書かずに `return 0`(intent スナップショットも行わない)。
- **書き込み先**: `<dir>/sessions/<sessionFileName>.jsonl` に追記。
  - `sessionFileName = sanitizeSessionId(session_id)`: `[^A-Za-z0-9._-]` を `-` に置換、先頭が `.` なら
    `-` に置換、結果が空なら `"_unknown"`。
- **meta.json の遅延作成**: 書き込み先 dir に `meta.json` が無ければ作成する。
  - tasks 系: `{"schema_version":2,"kind":"task","task_id":"<id>"}`
  - unfiled 系: `{"schema_version":2,"kind":"unfiled","repo":"<repo>","branch":"<実ブランチ名(変換前)>"}`
- 行スキーマ(ts/by/by_name/repo/branch/session_id/kind?/prompt|source)は**変更しない**。
- intent スナップショット(intent-log.jsonl)の仕組みは変更しない。

### 3. task new(cli.ts)

- 従来のマーカー作成に加え、state 側に `tasks/<id>/` を作成し `meta.json` を書く:
  `{"schema_version":2,"kind":"task","task_id","created","created_by"}`(flag "wx")。
- 衝突チェックは「既存 tasks/<id>」+「unfiled 側に同じ threadId が存在」に置き換え(threads/ 検査の後継)。

### 4. 読み側(brief / list / why / receipt / resolveThread)

- ディレクトリの instructions 読み込みを次のヘルパーに集約する:
  1. `<dir>/instructions.jsonl` があれば1ストリームとして読む(後方互換・移行漏れ対策)
  2. `<dir>/sessions/*.jsonl` を各1ストリームとして読む
  3. ストリームを **first-row の ts 昇順**に並べて連結する(行単位の全体ソートはしない — セッション内の
     順序と連続性を保つため)。first ts の無い/空ストリームは末尾、同値はファイル名昇順。
- `list` の「最終指示」表示・ソートは連結後の末尾行ではなく**全行中 ts 最大の行**を使う
  (並行セッションで末尾ファイルが最新とは限らないため)。
- discover は `tasks/*` と `unfiled/<repo>/<thread>` を列挙。`threads/` はもう見ない。
- `resolveThread`: bare `<id>` は両系統の threadId 一致で検索、曖昧なら qualified
  (`tasks/<id>` / `unfiled/<repo>/<thread>`)の候補列挙(現行の挙動を踏襲)。
- `generateBrief`(lib.ts)は変更しない(「— 別セッション —」境界は連結ストリーム上で従来ロジックのまま機能する)。

### 5. init(cli.ts)

- `mkdir tasks/ unfiled/`(threads/ は作らない)。
- state ルートの `.gitattributes` に `*.jsonl merge=union` の行が無ければ追記する
  (receipts.jsonl 等、複数書き手が残るファイルのマージ保険)。

### 6. 移行スクリプト scripts/migrate-layout-v2.mjs

- 対象: `<root>/tasks/*/instructions.jsonl` と `<root>/threads/**`。
- tasks: `instructions.jsonl` の行を session_id ごとに `sessions/<sanitized>.jsonl` へ分割
  (元の行順を維持)。
- threads: `threads/<repo>/<thread>/` → `unfiled/<repo>/<thread>/`、
  `threads/unfiled/<repo>/<branch>/` → `unfiled/<repo>/<branch>/` へ移動し、同様に分割。
- prompt が `<task-notification>` で始まる行は**移行せず除外**し、除外件数をパスごとに stdout に報告
  (state リポジトリは git 管理なので移行前コミットに原本が残る)。
- `intent-log.jsonl` / `receipts.jsonl` はそのまま移動。移行先ごとに meta.json を作成。
- `--dry-run` 対応・冪等(正常完了後の再実行で重複しない)・移行元は書き込み完了後に削除・
  空になった `threads/` は削除。既存 `scripts/migrate-layout.mjs` の流儀に合わせる。
- **実データへの実行はしない**(レビュー後に別途実行する)。

### 7. テスト・ドキュメント

- 既存テスト(acceptance / capture / lib / migrate-layout)を v2 に更新。
- 新規ケース: notification 除外 / sessions 分割書き込み / ストリーム連結順(複数セッション)/
  マーカー無し feature ブランチが unfiled に入る / 移行の分割・除外・冪等・dry-run。
- `pnpm test` と `pnpm typecheck` を通す。
- `cowork/README.md` のレイアウト説明・コマンド説明を v2 に更新。

## 制約

- 編集はこのリポジトリの worktree 内のみ。
- `~/cowork-state` の実データには一切触れない。
- 完了報告には: 変更ファイル一覧 / テスト・typecheck 結果 / 仕様どおりにできなかった箇所・迷った判断 を含める。
