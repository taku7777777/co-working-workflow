# co-working-workflow

他メンバーと協業して開発を進めるための仕組み

LLM時代のPRレビューコスト増大([issue.md](docs/records/issue.md))への解決策として、タスクごとの「作業スレッド」を共有し、
誰でも合流して続きを進められるようにする協働ワークフロー(仮称 cowork)の設計ドキュメントと MVP-0 実装。

## 読む順序

1. [goal.md](goal.md) — 目的と展開計画(判定の目的関数・介在点マップ・習熟モデル)
2. [issue.md](docs/records/issue.md) — 課題
3. [solution.md](solution.md) — 解決案の要約(最新版)
4. [proposal.md](docs/records/proposal.md) — 詳細提案
5. [decision-records.md](docs/records/decision-records.md) — 意思決定の記録
6. [feasibility.md](docs/records/feasibility.md) — 技術検証(実測記録)
7. [review.md](docs/records/review.md) — 初稿への独立レビュー
8. [phase-minus-1.md](docs/records/phase-minus-1.md) — 最初の検証フェーズ(ツール不要の予行演習)
9. [mvp0-spec.md](mvp0-spec.md) — MVP-0 実装スペック

(当時形の記録6本は `docs/records/` にある —— 上書きせず注記で扱う。作業中間物は `work/`。規約は AGENTS.md = artifact-policy v7)

## 実装

[cowork/](cowork/) — 指示・質問への回答・AI返答を Claude Code hooks で自動収集し、
引き継ぎ用 brief を生成する CLI(MVP-0)。セットアップは [cowork/README.md](cowork/README.md) を参照。
