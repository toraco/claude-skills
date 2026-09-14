---
name: ship
description: 現在の変更を適切なブランチに載せ、commit → push → PR 作成/更新までを一括で行う。main/develop 上で作業してしまった変更の新ブランチへの退避も吸収する。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Ship: $ARGUMENTS

**使い方**: `/ship [branch-name-hint] [--draft] [--no-pr] [pr-context]`

## Goal

作業済みの変更を「正しいブランチで commit され、push され、PR になっている」状態まで一括で持っていく。

これまで「checkout branch, commit, push and create PR」とフリーテキストで依頼していた定型フローの置き換え。`commit` skill + push + PR 作成の合成 + 前段のブランチ退避判定。

## いつ使うか

- 実装・修正が一段落し、変更を PR にしたいとき（`/ship`）
- main / develop 上でうっかり作業してしまった変更を、新ブランチに退避してから PR にしたいとき
- 既に PR があるブランチで追加 commit を積み、PR の description も差分に合わせて更新したいとき

使わない場面:

- commit だけしたい → `commit`

## 引数

| 引数 | 既定 | 意味 |
|---|---|---|
| `branch-name-hint` | 自動生成 | 新ブランチを切る場合の名前のヒント |
| `--draft` | false | PR を draft で作成する |
| `--no-pr` | false | commit + push まで（PR 作成/更新をしない） |
| `pr-context` | なし | PR description に反映する補足コンテキスト |

## ワークフロー

### Step 1: 状態確認とブランチ判定

- `git status` / `git diff` / `git log --oneline -5` で変更内容と現在ブランチを確認
- 変更が何もない（未 commit の変更も未 push の commit もない）場合はその旨を報告して停止
- ブランチ判定:
  - **保護ブランチ（main / master / develop）上に未 commit の変更 or 未 push の commit がある** → 新ブランチを作成して退避する
    - 未 commit のみ: `git switch -c <new-branch>`（変更はそのまま付いてくる）
    - 保護ブランチに commit してしまっている: `git switch -c <new-branch>` 後、保護ブランチを `git branch -f <protected> origin/<protected>` でリモートに戻す（未 push commit が失われないことを reflog で確認してから）
  - **作業ブランチ上** → そのまま使う。ブランチは切り直さない
- 新ブランチ名は `branch-name-hint` > worktree ディレクトリ名の issue 番号（例: `issue-1319-gift-purchase-api`）> 変更内容、の優先順で決める。既存ブランチの命名規則（`git branch -r` で prefix を確認: feature/ / fix/ など）に従う

### Step 2: Commit

- `commit` skill と同じ規約で行う: `git log --oneline -10` でプロジェクトの commit メッセージ慣例（絵文字 prefix・言語・形式）を確認し、それに従う
- 未ステージの変更は原則すべてステージする。ただし明らかに意図しないファイル（一時ファイル・シークレット・巨大バイナリ）が混ざっていれば除外して報告
- 変更の性質が明確に分かれる場合（構造変更 vs 振る舞い変更）は commit を分割してよい
- 未 commit の変更がなく未 push の commit だけがある場合はこの Step をスキップ

### Step 3: Push

- `git push -u origin HEAD`
- 失敗したら（権限 / non-fast-forward 等）原因を報告して停止。force push はしない

### Step 4: PR 作成 / 更新

`--no-pr` 指定時はスキップ。

- `gh pr view --json url,title,body,isDraft` で既存 PR を確認
- **PR がない場合**: 次の規約で作成する
  - `.github/PULL_REQUEST_TEMPLATE.md` があればテンプレートに沿って body を構成する
  - title は 70 文字以内でブランチの commit 群から生成
  - body には `## Summary`（変更点の箇条書き）と `## Test plan`（動作確認手順のチェックリスト）を含める（テンプレートがある場合はその構成を優先）
  - `pr-context` があれば description に反映
  - `--draft` 指定時は `gh pr create --draft`
- **PR が既にある場合**: 今回 push した commit 分の変更が description と乖離していないか確認し、乖離していれば `gh pr edit --body` で Summary / Test plan を差分に合わせて更新する（人間が手書きした節は消さず、変更点の追記に留める）
- PR URL を表示

### Step 5: 最終報告

- ブランチ名 / commit（件数と要約）/ push 結果 / PR URL（作成 or 更新 or スキップ）を 1 ブロックで報告

## Notes

- **force push・保護ブランチへの直 push・`git reset --hard` は一切行わない**。ブランチ退避で歴史を動かす場合は必ず reflog で復元可能性を確認してから
- worktree 運用（`.claude/worktrees/issue-NNNN-*`）では、worktree が対象 issue 用のブランチを既に持っていることが多い。その場合はそのブランチをそのまま使う
- 「変更したはずのファイルが見当たらない」場合は、別の worktree や main 側を変更してしまっている可能性を疑い、`git -C <main-checkout> status` を確認して報告する（勝手に取り込まない）
- 使用コマンド: `git status/diff/log/switch/branch/push`, `gh pr view/create/edit`

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「main 上の commit は reset --hard で消せばよい」 | 未 push commit の消失リスク。新ブランチへ退避してから `branch -f` で戻し、reflog で確認する |
| 「全部ステージして 1 commit でよい」 | 一時ファイルやシークレットの混入が事故になる。ステージ前に一覧を確認する |
| 「PR description は毎回全文書き直す」 | 人間の手書き節が消える。追記・更新に留める |

## 関連

- `commit` — commit 単体。メッセージ規約はこちらに従う
- `auto-fix-review` — PR 作成後のレビュー対応ループはこちら
