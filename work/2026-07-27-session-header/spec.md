# セッションヘッダ行の導入(レイアウト v2 追補)

日付: 2026-07-27 / 起案: Claude(設計)→ Codex(実装)
前提: work/2026-07-26-state-layout-v2/spec.md(コミット d08d591 で実装済み)
位置づけ: **v2 の定義修正**。v2 は実データにまだ適用されていないため、schema_version は 2 のまま
バンプしない。capture・読み側・migrate-layout-v2.mjs を同時に改める。

## 決定事項(ユーザーと合意)

管理原則: **セッション不変の事実はヘッダ行に一度だけ、イベント時点の事実は行に毎回**。

1. `sessions/<session_id>.jsonl` の1行目にセッションヘッダ(`kind:"meta"`)を置く。
2. 後続のイベント行はスリム化し `ts / kind? / branch / prompt|source` のみとする
   (`session_id / by / by_name / repo` はヘッダに一本化)。
3. `branch` はセッション途中の checkout で変わる「イベント時点の観測値」なので行に残す。

## 詳細仕様

### 1. ヘッダ行

```json
{"kind":"meta","schema":2,"session_id":"<raw session_id>","by":"<email>","by_name":"<name>","repo":"<repo(観測値。git外なら空文字)>","started":"<最初のイベントの ts>"}
```

- **書き込みタイミング**: capture がセッションファイルへ追記する際、ファイルが存在しなければ
  「ヘッダ行 + イベント行」を**1回の appendFile 呼び出しで**書く(ヘッダだけの断片化を防ぐ)。
  存在すればイベント行のみ追記。
- 存在チェック→追記の間の競合で稀にヘッダが二重になっても、読み側は「最初の meta 行を採用し、
  以降の meta 行は無視する」ため実害はない(この許容を読み側の仕様とする)。
- `session_id` はサニタイズ前の生値を入れる(ファイル名は従来どおりサニタイズ後)。

### 2. イベント行(スリム化)

- capture が書くイベント行: `{ts, kind?, branch, prompt|source}`。
  `session_id / by / by_name / repo` は**書かない**。
- **例外**: 生の session_id が空のとき(`_unknown.jsonl`)は複数セッションの行が混ざりうるため、
  ヘッダを書かず、従来どおり全フィールド(`ts/by/by_name/repo/branch/session_id/kind?/prompt|source`)
  を行に持たせる。

### 3. 読み側(readInstructions での復元)

- 各ストリームの最初の `kind:"meta"` 行をヘッダとして取り出し、イベント行にはない
  `session_id / by / by_name / repo` を**メモリ上で補完(rehydrate)**してから返す。
  これにより `generateBrief`(セッション境界判定に session_id を使用)と `list`(著者表示に
  by_name を使用)は無変更で動く。lib.ts は変更しない。
- 行に既に該当フィールドがある場合(レガシー instructions.jsonl・_unknown.jsonl)は**行の値を優先**。
- meta 行自体はイベント列に含めない(brief に表示されない)。
- ストリームの整列キーは従来どおり「最初の**イベント**行の ts」(meta 行はスキップ)。

### 4. 移行スクリプト(scripts/migrate-layout-v2.mjs)

- instructions.jsonl をセッション別に分割する際、各セッションファイルの先頭にヘッダを合成する:
  `session_id / by / by_name / repo` はそのセッションの最初の行から、`started` は最初の行の ts。
- 後続行はスリム化して書く: 上記4フィールド**だけ**を取り除き、**それ以外の未知フィールドは保持**
  (実データに `"backfilled": true` 等が存在する)。
- 生 session_id が空の行は `_unknown.jsonl` へ従来どおり全フィールドのまま(ヘッダなし)。
- 冪等性は従来方式(変換後の行での multiset 差分)を維持。

### 5. テスト・ドキュメント

- 新規/更新ケース: ファイル新規作成時にヘッダ+イベントが1書き込みで入る / 2回目以降は
  ヘッダが増えない / スリム行の rehydrate 後に brief のセッション境界・list の著者表示が正しい /
  _unknown の例外 / 移行でのヘッダ合成・未知フィールド保持 / 二重 meta 行の許容(最初を採用)。
- `pnpm test` / `pnpm typecheck` 通過。cowork/README.md のレコード形式説明を更新。

## 制約

- 編集はこのリポジトリの worktree 内のみ。`~/cowork-state` の実データには触れない。
- 完了報告には変更ファイル一覧 / テスト・typecheck 結果 / 迷った判断を含める。
