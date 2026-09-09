---
name: triage-issues
description: open issue を現在の実装・マージ済み PR・ドキュメントと突合し、すでに解決済みの issue と設計変更で不要になった issue を根拠付きでクローズする。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Triage open issues: $ARGUMENTS

**使い方**: `/triage-issues [--repo=owner/name] [--label=X] [--issue=N ...] [--limit=N] [--dry-run]`

## Goal

open issue の一覧を実態と突合し、「まだやることが残っている issue だけが open」の状態にする。具体的には:

1. **解決済み (RESOLVED)**: 対応する実装が既にデフォルトブランチにマージされている issue を、根拠（PR / commit / 該当コード）付きでクローズする
2. **陳腐化 (OBSOLETE)**: 設計変更・方針転換により対応自体が不要になった issue を、根拠（決定の記録）付きでクローズする

実装は行わない。`pr-triage` が「PR 起点でクローズ漏れを拾う」のに対し、本 skill は「issue 起点で open 全量を棚卸しする」。

## いつ使うか

- open issue が溜まってきて、実装済み・不要になったものを一掃したいとき
- 大きなリファクタ・移行・設計変更のマージ後に、前提が変わった issue を見直したいとき
- 特定 issue 群について「これはもう不要になった？」を判定したいとき（`--issue=N`）

使わない場面:

- open issue を実装して潰したい → `solve-issues`
- クローズ済み PR からフォローアップを整理したい → `pr-triage`
- 新しい課題を起票したい → `file-issue`

## 前提

- 対象リポジトリで `gh` の認証が通っており、issue write 権限がある
- 判定はデフォルトブランチの実装を正とする（作業ブランチの未マージ変更は解決の根拠にしない）

## 引数

| フラグ | 既定 | 意味 |
|---|---|---|
| `--repo=owner/name` | カレントの `gh repo view` | 対象リポジトリ |
| `--label=X` | なし | 対象を label で絞る |
| `--issue=N ...` | なし | 指定 issue のみ判定（複数可） |
| `--limit=N` | 50 | 対象 issue の上限（古い順ではなく更新が古い順に優先） |
| `--dry-run` | false | 判定のみ。クローズせずレポートだけ出力 |

## ワークフロー

### Step 0: Setup

- 状態変数: `REPO`, `ISSUE_LIST`, `DRY_RUN`, `ACTIONS_TAKEN = []`, `ACTIONS_DEFERRED = []`
- `gh repo view <REPO>` で存在確認。デフォルトブランチ名を取得し、ローカルの checkout がそれに追従していることを確認（`git fetch` 済みの origin/<default> を参照する）
- `TaskCreate` で主要ステップ（issue 列挙 / 判定 / クローズ実行 / レポート）を登録し進行に合わせて更新

### Step 1: 対象 issue の列挙

```bash
gh issue list --repo $REPO --state open \
  --json number,title,body,labels,updatedAt,url --limit $LIMIT
```

- `--issue=N` 指定時は `gh issue view N --json ...` で個別取得
- epic / 親 issue（sub-issue を束ねるだけのもの）は判定対象に含めるが、クローズは sub-issue が全て閉じている場合のみ候補にする

### Step 2: 各 issue の判定（並列）

`Agent` ツール（`subagent_type: "Explore"`, `model: "sonnet"`）を issue 件数分並列で呼び出す。10 件以上は 5 件ずつのバッチで順次実行。

各 subagent への入力: issue 1 件分の JSON、`REPO`、デフォルトブランチ名。

各 subagent への指示プロンプト（verbatim）:

```
あなたは GitHub issue の解決状態を判定するアナリストです。以下の issue 1 件について、現在のコードベースとマージ済み PR を根拠に判定してください。

## 調査手順
1. issue 本文から「何が実現されればこの issue は閉じられるか」の完了条件を 1-3 行で言語化する
2. 以下の情報源を横断して証拠を集める:
   - `gh pr list --repo <REPO> --state merged --search "<issue番号 or キーワード>"` で関連するマージ済み PR
   - `gh issue view <N> --comments` のコメント（「対応済み」「不要になった」等の言及）
   - デフォルトブランチのコード・ドキュメント（Grep / Read で完了条件に対応する実装・記述の実在を確認）
   - `git log --oneline --grep="<issue番号>"` での関連 commit
3. 判定する

## 判定基準
- RESOLVED: 完了条件を満たす実装/記述がデフォルトブランチに実在し、根拠 (PR / commit / ファイルパス) を specific に示せる
- OBSOLETE: 設計変更・方針転換で完了条件自体が不要になったことが、issue コメント / 関連 PR / ドキュメントに明示的に記録されている
- STILL_OPEN: 上記どちらの根拠も揃わない（部分的対応・計画のみ・推測しかない場合を含む）

## 出力フォーマット (YAML 風)
issue_number: <N>
verdict: <RESOLVED | OBSOLETE | STILL_OPEN>
confidence: 0-100
completion_criteria: <言語化した完了条件>
evidence:
  - <PR URL / commit hash / ファイルパス:行 / issue コメント引用>
rationale: <判定理由 1-3 行>
remaining: <STILL_OPEN の場合、何が残っているか 1-2 行。それ以外は "none">

## confidence スケール（目安）
- 90-100: マージ済み PR が issue を明示参照し、かつ実装の実在をコードで確認できた。または「不要」の明示的な決定記録がある
- 80-89: 実装の実在は確認できたが issue との対応が明示参照ではなく内容一致による
- 50-79: 部分的に対応済み、または状況証拠のみ
- 0-49: 推測の域を出ない

## 禁止事項
- 計画ドキュメントや未マージブランチの存在を「解決済み」の根拠にしない
- issue タイトルの類似だけで判定しない（完了条件ベースで判定する）
- コードを読まずに PR タイトルだけで RESOLVED にしない
```

### Step 3: 自動実行ガードと分類

- 🟢 **auto-close**: `verdict != STILL_OPEN` かつ `confidence >= 80` かつ evidence に具体的な PR / commit / コードパスが含まれる
- 🟡 **defer**: `verdict != STILL_OPEN` かつ `confidence >= 50`（レポートで人間に委ねる）
- ⚪ **keep open**: それ以外（レポートに参考行のみ）

`--dry-run` 時は 🟢 をすべて 🟡 に降格する。

### Step 4: クローズ実行（🟢 のみ）

```bash
# RESOLVED
gh issue close <N> --repo $REPO --reason completed \
  --comment "Closed via triage-issues skill: <rationale>. Evidence: <evidence を箇条書き>"

# OBSOLETE
gh issue close <N> --repo $REPO --reason "not planned" \
  --comment "Closed via triage-issues skill (no longer needed): <rationale>. Evidence: <evidence を箇条書き>"
```

- label 編集・assign・milestone 変更はしない。state 変更はこの close のみ
- 個別失敗は `ACTIONS_DEFERRED` に記録して継続。同種の失敗が連続 3 件で自動実行を中断し残りを 🟡 に降格

### Step 5: 最終レポート

```
# Issue triage report

対象 repo: <REPO>
対象 issue: <件数>件 / mode: <execute | dry-run>

## クローズ済み (🟢)
- #<N> "<title>" — <RESOLVED|OBSOLETE> (conf=<score>): <根拠 1 行>
- (なし)

## 要確認 (🟡)
- #<N> "<title>" — <verdict> (conf=<score>): <理由と残作業>
- (なし)

## open 継続 (⚪)
- #<N> "<title>" — <remaining 1 行>

## 失敗・スキップ
- (なし)
```

- 各セクション 0 件時は `- (なし)` を出す（セクション自体は省略しない）

## Notes

- **`Agent` 呼び出しでは必ず `model: "sonnet"` を明示する**
- 判定の正は常に **デフォルトブランチのコード実在**。「PR がマージされた」だけでなく「その内容が今も残っている」ことまで確認する（後続の revert で消えているケースがある）
- 初回運用は `--dry-run` 推奨。誤クローズ傾向を確認してから自動実行に切り替える
- 使用コマンド一覧: `gh repo view`, `gh issue list/view/close`, `gh pr list/view`, `git log/fetch`
- 内部ツール: `Agent`, `TaskCreate`

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「PR に Closes #N と書いてあるからマージ済みなら閉じてよい」 | それは `pr-triage` の領分。本 skill は実装の実在まで確認して閉じる |
| 「コメントで『不要かも』とあるから OBSOLETE」 | 「かも」は決定ではない。明示的な決定記録がなければ 🟡 に留める |
| 「issue が古いから実質不要だろう」 | 経過時間は根拠にならない。完了条件ベースで判定する |
| 「epic も中身を見ずにまとめて閉じよう」 | sub-issue が全て閉じているときだけ候補にする |

## よくある失敗

- **未マージブランチを根拠にする**: worktree や作業ブランチに実装があっても、デフォルトブランチになければ RESOLVED ではない
- **部分対応を全対応と誤認**: 完了条件を複数含む issue は、全条件の充足を確認する。一部のみなら 🟡 で「残作業」を明記
- **revert の見落とし**: 参照 PR がマージ済みでも後で revert されていることがある。コードの現在の状態で判定する

## 関連

- `pr-triage` — クローズ済み PR 起点の点検（時間窓ベース）。本 skill は open issue 起点の全量棚卸し
- `solve-issues` — STILL_OPEN と判定された issue の実装はこちら
- `file-issue` — 棚卸し中に見つかった新課題の起票
