# cowork

`cowork` は Claude Code の `SessionStart` / `UserPromptSubmit` / `PostToolUse` / `Stop` hook からセッション境界と指示履歴を追記し、共有用 brief と確認バッジを作る MVP-0 CLI です。状態は既定で `~/cowork-state` に置き、`COWORK_STATE` で変更できます。

## インストール

Node.js 22.18.0 以降と Corepack が必要です。CLI 本体は Node のネイティブ型ストリッピングで TypeScript を直接実行するため、ビルドはありません。

```sh
cd /path/to/co-working/cowork
corepack enable
pnpm install
pnpm setup # 初回だけ。表示された指示どおり PATH を反映後、シェルを開き直す
pnpm add --global .
cowork init
```

hook は `~/.claude/settings.json`(グローバル)に登録します。`pnpm add --global .` で PATH に入れた `cowork` を呼び出します。

cowork の価値の中心は「規律ゼロの受動捕捉」で、これはリポジトリを横断して初めて成立します。実際、2026-07-30 の実測(27スレッド)も 2026-08-01 の K1 自己盲検も、グローバル登録の状態で採れたデータです。影響範囲を対象プロジェクトだけに絞りたい場合は、同じ内容を対象プロジェクトの `.claude/settings.json` に置いても動きます。

> [mvp0-spec.md](../mvp0-spec.md) の「受け入れ条件」6 は「検証用の hook 登録はプロジェクト側。`~/.claude/settings.json` は触らない」と書いていますが、これは 2026-07-25 時点の方針で、実運用はグローバル登録に移りました(→ 2026-08-02、本ファイルの記述を正とする)。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cowork capture"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cowork capture"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "cowork capture"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cowork capture"
          }
        ]
      }
    ]
  }
}
```

登録後、対象プロジェクトで PATH と記録を確認します。

`AskUserQuestion` の回答は brief の「判断したこと」に全件表示され、指示の時系列には重複表示されません。AI の最終返答は `(AI)` として表示されます。既定では各セッションの最後の AI 返答だけが全文、それ以前の返答は200字までになり、`cowork brief --full` では全 AI 返答を全文表示します。

```sh
command -v cowork
cd /path/to/target-repository
node -e 'console.log(JSON.stringify({cwd:process.cwd(),session_id:"manual-check",prompt:"cowork hook check"}))' | cowork capture
cowork brief
```

`command -v` が `cowork` のパスを返し、brief の指示欄に `cowork hook check` が出れば登録できています。

**状態ディレクトリ(`~/cowork-state`)は共有しません。** 共有するのは `cowork brief` の出力(成果物)だけです。state に remote を張らないでください —— 誤 push の入口になり、検証データそのものを壊します。ローカルに履歴を残したい場合に限り、remote 無しで commit してください。

(この扱いは決定 A による。根拠と経緯は `work/2026-07-30-process-synthesis/proposal.md` §3-A。以前ここには「状態リポジトリの共有は手動の `git pull` / `git push` で行います」と書かれていたが、決定 A と正面衝突するため 2026-08-02 に撤回した)

## タスクディレクトリ

複数リポジトリにまたがる作業や、途中でブランチが分かれる作業にはタスクディレクトリを使います。タスクを置きたい親ディレクトリで作成コマンドを実行し、その下にworktreeやcloneを配置します。

```sh
cd ~/tasks
cowork task new 0002-policy-redesign
cd 0002-policy-redesign
# この下に対象リポジトリをclone、またはworktreeを作成
```

`cowork task new` は `<id>/.cowork/task.json` を作成します。このmarkerがタスクIDの正本です。`cowork capture` と引数なしの `cowork brief` はcwdから親方向へmarkerを探索し、見つかった場合はブランチ名ではなくタスクIDを使います。

タスクの履歴は `cowork-state/tasks/<task-id>/` に集約されます。各レコードの `repo` と `branch` は、captureを呼び出したリポジトリの値を保持します。markerがない場所では、ブランチを問わず `cowork-state/unfiled/<repo>/<thread-id>/` がフォールバックとして使われます。gitリポジトリ外ではrepo名に `_unknown` を使います。

状態ディレクトリのレイアウトは次のとおりです。指示履歴は並行セッション同士が同じファイルへ追記しないよう、1セッションにつき1つのJSONLファイルに保存します。

```text
cowork-state/
├── tasks/<task-id>/
│   ├── meta.json
│   ├── sessions/<session-id>.jsonl
│   ├── intent-log.jsonl
│   └── receipts.jsonl
└── unfiled/<repo>/<thread-id>/
    ├── meta.json
    ├── sessions/<session-id>.jsonl
    ├── intent-log.jsonl
    └── receipts.jsonl
```

`sessions/<session-id>.jsonl` の先頭行は、セッション中に変わらない情報を持つヘッダです。`session_id` はファイル名へ使う前の生の値です。

```jsonl
{"kind":"meta","schema":2,"session_id":"session/1","by":"user@example.com","by_name":"User","repo":"project","started":"2026-07-27T00:00:00.000Z"}
{"ts":"2026-07-27T00:00:00.000Z","branch":"feature/example","prompt":"最初の指示"}
{"ts":"2026-07-27T00:01:00.000Z","kind":"ai","branch":"feature/example","prompt":"AIの応答"}
```

イベント行は時点ごとに変わる `ts`、`branch`、`kind`、`prompt` または `source` だけを持ちます。読み込み時にヘッダの `session_id`、`by`、`by_name`、`repo` が補完されます。生の `session_id` が空の場合だけは `_unknown.jsonl` に複数セッションが混ざる可能性があるため、ヘッダを置かず、各イベント行が従来の全フィールドを保持します。

`intent-log.jsonl` は方針の版ごとに、内容とハッシュに加えて、絶対パスを含まないリポジトリ相対の識別子 `path` を持ちます。

```jsonl
{"ts":"2026-08-01T00:00:00.000Z","by":"user@example.com","hash":"...","body":"- なぜ: ...\n","path":"project/docs/cowork/feature-example/intent.md"}
```

同じ `path` の最後の版から内容が変わった場合だけ追記されます。旧形式の `path` がない行は、空文字列の同一グループとして読み込まれます。

## 既知の欠損 — brief を人に渡す前に読むこと

**セッションの途中でブランチを切り替えると、そのセッションの記録は複数のスレッドに分かれて書かれます。**
cowork はレコード単位で repo+branch からスレッドを解決するためで、切り替え後の記録は別スレッドに入ります。
記録自体は失われていませんが、**brief は続きが別スレッドにあることを示す信号を出さない**ため、
片方のスレッドの brief は「セッションが応答なしで終わった」ように見えます。
実測では**セッションの 3.4% が分裂し、その波及でスレッドの 53%(9/17)が不完全**でした。

brief を他人に渡す前に、そのセッション ID が他のスレッドにも書かれていないかを確認してください。

このほか、Stop hook が発火せず記録が本当に失われる経路(セッションの 6.1%)と、
payload に `last_assistant_message` が無く無言で捨てられる経路(Stop の 0.76%)があります。
測定方法・実データ・Run 2a への含意は
[docs/records/2026-08-02-capture-loss-paths.md](../docs/records/2026-08-02-capture-loss-paths.md) にあります
(`出典:` この節の数値の根拠)。

## コマンド

- `cowork init`: 状態リポジトリを初期化し、`tasks/`、`unfiled/`、JSONL用の `.gitattributes` を用意します。
- `cowork task new <id>`: cwdにタスクディレクトリと `.cowork/task.json` を作り、状態側にも `tasks/<id>/meta.json` を作成します。IDに `/` は使えず、`.` で始めることもできません。
- `cowork capture`: hook 専用です。stdin の JSON にあるセッション開始、指示、`AskUserQuestion` への回答、AI の最終返答を記録し、失敗時も終了コード 0 を返します。`<task-notification>` で始まる注入プロンプトは記録しません。失敗は状態ディレクトリの `capture-errors.log` にも追記します。
- `cowork brief [id] [--full]`: 共有ドキュメントに貼れる brief を出力します。`AskUserQuestion` の回答は「判断したこと」に、各セッションの最後の AI 返答は全文で表示します。省略時は親方向のtask marker、markerがなければ現在のリポジトリとブランチから解決します。曖昧な場合はタスクを `tasks/<id>`、フォールバックスレッドを `unfiled/<repo>/<thread>` で指定します。方針が未設定なら置き場所の候補も表示します。`--full` で全 AI 返答を省略せず表示します。
- `cowork list`: 自分が未確認でバッジのあるスレッドだけを表示します。`--all` で自分の確認済みとバッジなしも展開します。
- `cowork receipt [id] --kind <kind> [--note <note>]`: 自分の確認を追記します。ID省略時はmarkerまたはcwdから解決し、曖昧な場合は `tasks/<id>` または `unfiled/<repo>/<thread>` で指定します。`kind` は `read` / `understood-intent` / `ran` / `object` のいずれかです。異議は `--kind object --note "理由"` とし、確認済みには数えません。
- `cowork why [id]`: 方針変更の差分と異議の note を表示します。ID省略時の解決と修飾形式はbrief、receiptと同じです。

フォールバック層の `thread_id` はブランチ名の `/` を `-` に置換した値です。featureブランチ、`main`、`master`、detached HEADのすべてを `unfiled/<repo>/<thread_id>/` に保存します。listではタスクを `tasks/<id>`、フォールバックスレッドを `unfiled/<repo>/<thread>` と表示します。

旧 `instructions.jsonl` と `threads/` レイアウトからの移行には、一回限りのv2スクリプトを使います。セッション別ファイルへの分割時にtask notification行を除外して件数を表示します。最初にdry-runで移行元と移行先を確認してください。

```sh
COWORK_STATE=/path/to/cowork-state node scripts/migrate-layout-v2.mjs --dry-run
COWORK_STATE=/path/to/cowork-state node scripts/migrate-layout-v2.mjs
```

## 方針(intent.md)の置き場所

作業するリポジトリの `docs/cowork/<thread_id>/intent.md` に方針10行を置きます。タスクディレクトリ内では `<thread_id>` がtask IDになります。
`capture` は git toplevel が得られる場合はそのリポジトリを探索します。task marker がある場合は、marker のディレクトリ直下にある、`.` で始まらない子ディレクトリを辞書順に1階層だけ探索します。両方から同じファイルへ到達した場合は1件にまとめ、実在するすべての `intent.md` を記録します。marker がなく git 外で実行した場合は、既存挙動どおり capture の失敗として標準エラーと `capture-errors.log` に記録され、cwd 基準の相対パスは探索しません。

- `cowork brief` の「方針」節はこのファイルの内容です
- `方針変更` バッジは、同じ `path` の中に異なる内容の版が2つ以上あることを意味します

置かなくても `capture` は動きます(指示履歴だけが記録され、方針節にはテンプレートと期待パスが出ます)。
