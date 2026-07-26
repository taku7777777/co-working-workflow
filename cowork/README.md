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

対象プロジェクトの `.claude/settings.json` に hook を登録します。`pnpm add --global .` で PATH に入れた `cowork` を呼び出します。

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

`AskUserQuestion` の回答は `(回答)`、AI の最終返答は `(AI)` として brief に表示されます。AI の返答は既定で200字に省略され、`cowork brief --full` で全文を表示できます。

```sh
command -v cowork
cd /path/to/target-repository
node -e 'console.log(JSON.stringify({cwd:process.cwd(),session_id:"manual-check",prompt:"cowork hook check"}))' | cowork capture
cowork brief
```

`command -v` が `cowork` のパスを返し、brief の指示欄に `cowork hook check` が出れば登録できています。

状態リポジトリの共有は手動の `git pull` / `git push` で行います。

## タスクディレクトリ

複数リポジトリにまたがる作業や、途中でブランチが分かれる作業にはタスクディレクトリを使います。タスクを置きたい親ディレクトリで作成コマンドを実行し、その下にworktreeやcloneを配置します。

```sh
cd ~/tasks
cowork task new 0002-policy-redesign
cd 0002-policy-redesign
# この下に対象リポジトリをclone、またはworktreeを作成
```

`cowork task new` は `<id>/.cowork/task.json` を作成します。このmarkerがタスクIDの正本です。`cowork capture` と引数なしの `cowork brief` はcwdから親方向へmarkerを探索し、見つかった場合はブランチ名ではなくタスクIDを使います。

タスクの履歴は `cowork-state/tasks/<task-id>/` に集約されます。各レコードの `repo` と `branch` は、captureを呼び出したリポジトリの値を保持します。markerがない場所では、従来の `cowork-state/threads/` がフォールバックとして使われます。

## コマンド

- `cowork init`: 状態リポジトリを初期化します。
- `cowork task new <id>`: cwdにタスクディレクトリと `.cowork/task.json` を作成します。IDに `/` は使えず、`.` で始めることもできません。
- `cowork capture`: hook 専用です。stdin の JSON にあるセッション開始、指示、`AskUserQuestion` への回答、AI の最終返答を記録し、失敗時も終了コード 0 を返します。失敗は状態ディレクトリの `capture-errors.log` にも追記します。
- `cowork brief [id] [--full]`: 共有ドキュメントに貼れる brief を出力します。省略時は親方向のtask marker、markerがなければ現在のリポジトリとブランチから解決します。曖昧な場合はタスクを `tasks/<id>`、フォールバックスレッドを `<repo>/<thread>` で指定します。`--full` で AI の返答を省略せず表示します。
- `cowork list`: 自分が未確認でバッジのあるスレッドだけを表示します。`--all` で自分の確認済みとバッジなしも展開します。
- `cowork receipt [id] --kind <kind> [--note <note>]`: 自分の確認を追記します。ID省略時はmarkerまたはcwdから解決し、曖昧な場合は `tasks/<id>` または `<repo>/<thread>` で指定します。`kind` は `read` / `understood-intent` / `ran` / `object` のいずれかです。異議は `--kind object --note "理由"` とし、確認済みには数えません。
- `cowork why [id]`: 方針変更の差分と異議の note を表示します。ID省略時の解決と修飾形式はbrief、receiptと同じです。

フォールバック層の `thread_id` はブランチ名の `/` を `-` に置換した値です。通常は `threads/<repo>/<thread_id>/`、`main`、`master`、detached HEADは `threads/unfiled/<repo>/<branch>/` に保存されます。listではタスクを `tasks/<id>`、フォールバックスレッドを `<repo>/<thread>` と表示します。

旧フラットレイアウトからの移行には、一回限りのスクリプトを使います。最初に dry-run で移行元と移行先を確認してください。

```sh
COWORK_STATE=~/cowork-state node scripts/migrate-layout.mjs --dry-run
COWORK_STATE=~/cowork-state node scripts/migrate-layout.mjs
```

## 方針(intent.md)の置き場所

作業するリポジトリの `docs/cowork/<thread_id>/intent.md` に方針10行を置きます。タスクディレクトリ内では `<thread_id>` がtask IDになります。
`capture` はここを読み、内容が変わっていたときだけ `intent-log.jsonl` に版を追記します。

- `cowork brief` の「方針」節はこのファイルの内容です
- `方針変更` バッジは、この版が2つ以上あることを意味します

置かなくても `capture` は動きます(指示履歴だけが記録され、方針節は空欄のまま出ます)。
