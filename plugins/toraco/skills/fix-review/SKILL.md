---
name: fix-review
description: Claude Code Review のコメント（集約型・インライン型の両方）を取得してバグ・設計問題を修正し、インラインコメントには返信と Resolve conversation を行う
---

# Fix code review comments from Claude Code Review: $ARGUMENTS

**使い方**: `/fix-review [pr-number] [--yes]`

## Goal

Fetch Claude Code Review comments from the current branch's PR, parse identified issues,
fix bugs and design issues, then verify with checks.

Claude Code Review の出力形態は 2 種類ある。両方に対応すること。

- **集約コメント型**: PR に 1 件の issue comment としてレビュー全体が投稿される
- **インラインコメント型**: 差分の各行に review comment（review thread）として投稿される

インラインコメント型の場合は、対応したスレッドへの**返信**と、解決した指摘の
**Resolve conversation** まで行う（Step 8）。

## Steps (obey strictly)

### Step 1: Identify the PR

- Parse `$ARGUMENTS`:
  - The first numeric token (if any) is the PR number.
  - The flag `--yes` (anywhere) enables non-interactive mode — Steps 3 と 7 の Y/N 確認を全てスキップする。
- If a PR number was given, use it: `gh pr view <number> --json comments,number,headRefName`
- Otherwise detect the current branch's PR: `gh pr view --json comments,number,headRefName`
- If no PR is found, inform the user and stop.

### Step 2: Extract review comments

#### Step 2-1: 集約コメント型（issue comments）

- From the PR comments, find comments where `author.login` is `"claude"`.
  Use: `gh pr view <number> --json comments --jq '.comments[] | select(.author.login == "claude") | .body'`
- Parse the comment body looking for severity sections. Claude Code Review は **emoji 形式**（`🔴`/`🟡`/`🟢`）と **英語形式**（`High`/`Medium`/`Low`）のどちらでも出力するため、両方を検出すること。判定は `###` 見出し行（`####` も対象に含めて良い）に対し、大文字小文字を区別せず以下のキーワード／絵文字が含まれるかで行う:
  - **High severity**（fix対象）: `🔴` または `High`（例: `### 🔴 バグ`, `### High`, `### High Priority`, `### 🔴 High`, `### High Severity Issues`）
  - **Medium severity**（fix対象）: `🟡` または `Medium`（例: `### 🟡 設計上の問題`, `### Medium`, `### Medium Priority`）
  - **Low severity**（参考のみ）: `🟢` または `Low`（例: `### 🟢 指摘・改善提案`, `### Low`, `### Low Priority`）
- For each issue under **High / Medium** sections, extract:
  - Issue number and title (from `#### N. Title`)
  - File path (from `**ファイル:** path` or `**File:** path`)
  - Problem description and suggested fix (from code blocks and text)
- For each `claude` comment, check whether it contains at least one severity section (High / Medium / Low in either emoji or English form). If it does NOT contain any severity section, treat that comment's body as a supplementary note: display it in Step 3 under Low as "📝 追記" but do NOT include it as an auto-fix target. This applies even if the supplementary note suggests test additions related to a High/Medium fix — always treat it as reference-only.

#### Step 2-2: インラインコメント型（review threads）

差分行に付いたインラインコメントを review thread 単位で取得する。Resolve には GraphQL node ID が
必須なので、REST（`/pulls/<n>/comments`）ではなく GraphQL で取得すること。

```bash
OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO=$(gh repo view --json name --jq '.name')
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            viewerCanReply
            viewerCanResolve
            path
            line
            comments(first:20) {
              nodes { databaseId author { login } body }
            }
          }
        }
      }
    }
  }' -f owner="$OWNER" -f repo="$REPO" -F pr=<number>
```

- `pageInfo.hasNextPage` が true の場合は `endCursor` を `-f cursor=...` に渡して全件取得する。
- 対象スレッドの条件: `comments.nodes[0].author.login == "claude"` **かつ** `isResolved == false`。
  既に Resolve 済みのスレッドは対応済みとみなし、対象から除外する。
- 各対象スレッドについて以下を保持する:
  - `thread_id`: `nodes[].id`（Step 8 の Resolve に使う GraphQL node ID）
  - `root_comment_id`: `comments.nodes[0].databaseId`（Step 8 の返信に使う数値 ID）
  - `path` / `line` / 先頭コメント本文
  - `viewerCanReply` / `viewerCanResolve`（Step 8 の可否判定に使う）
- severity 判定はインライン本文にも Step 2-1 と同じキーワード／絵文字ルールを適用する。
  見出し行が無く本文中に `🔴`/`🟡`/`🟢` や `High`/`Medium`/`Low` の表記だけがある場合は、それを severity とみなす。
  どの表記も無いインラインコメントは **Medium 相当**として fix 対象に含める。
- 対象スレッドが 0 件なら「集約コメント型のみ」と判断し、Step 8 はスキップする。

#### Step 2-3: 合流

- Step 2-1 と Step 2-2 で抽出した issue を 1 つのリストに統合する。
  インライン由来の issue には `thread_id` / `root_comment_id` / `path:line` を必ず紐づけて保持し、
  Step 8 まで持ち回ること。
- 集約コメントとインラインコメントで同一箇所の指摘が重複している場合は 1 件に統合し、
  `thread_id` を保持する側（インライン由来）の情報を優先する。
- If no review comments or no issues found, inform the user and stop.

### Step 3: Display issues and confirm

- Display the list of **High / Medium** issues to fix (with file paths and brief descriptions). 表示時は元コメントの形式（🔴/🟡 か High/Medium か）をそのまま反映してよい。
  インライン由来の issue は `path:line` と「インライン」である旨を併記する。
- Display **Low** suggestions as reference only (will NOT be fixed automatically).
- `--yes` が指定されていれば確認をスキップし、そのまま Step 4 へ進む。
  指定されていなければユーザーに確認を求めてから次へ進む。

### Step 4: Fix each issue sequentially

For each confirmed issue (**High first, then Medium**):

1. Read the target file and understand the surrounding code context.
2. Apply the fix following the review comment's suggestion.
3. If the fix requires test changes, update them as well.
4. Run tests after each fix to verify no regressions.
5. If a test fails, debug and resolve before moving to the next issue.
6. 各 issue の対応結果を **`fixed`（修正した）** / **`wontfix`（対応不要と判断した）** のいずれかで記録する。
   インライン由来の issue は `thread_id` とセットで記録すること（Step 8 で使う）。

### Step 5: Run full project checks

After all fixes are applied, run the project's standard checks:

1. Run the linter and fix any errors.
2. Run all tests and fix any failures.
3. Run build dry-run checks and fix any errors.

Note: Detect the correct check commands from the repository (e.g., package.json scripts).

### Step 6: Report

Print a summary of:
- Issues fixed (with file paths and what was changed)
- Low severity suggestions not addressed (for manual review)
- Check results (all passed / any remaining issues)

### Step 7: Commit & Push

- レポート表示後、ユーザーに「修正内容を commit & push しますか？(Y/N)」と確認する。
  ただし `--yes` が指定されていれば確認をスキップし、自動で Y(es) として扱う。
- Y(es) の場合:
  1. 変更ファイルを `git add` でステージング
  2. プロジェクトの commit 規約（`git log --oneline -10` で検出）に従ったメッセージで commit を作成
  3. `git push` でリモートに push
  4. `git rev-parse --short HEAD` で修正コミットの短縮 hash を控える（Step 8 の返信で使う）
- N(o) の場合: commit/push せずに終了する（Step 8 も実行しない）。

### Step 8: レビューコメントへの返信 & Resolve（インラインコメント型のみ）

**実行条件**: Step 2-2 で対象 review thread が 1 件以上あり、かつ Step 7 で push が完了していること。
集約コメント型のみの場合、および Step 7 で N(o) を選んだ場合は本 Step 全体をスキップする。

Step 4 で対応した各スレッドについて、以下を実行する。

0. **可否チェック**: Step 2-2 で取得した `viewerCanReply` / `viewerCanResolve` を確認する。
   `viewerCanReply == false` なら返信を skip、`viewerCanResolve == false` なら Resolve を skip し、
   いずれもスレッドを特定できる形で記録して Step 8-3 の出力に含める（黙って握り潰さない）。

1. **返信を投稿する**（`fixed` / `wontfix` いずれの場合も必ず返信する）:

   ```bash
   gh api --method POST \
     "repos/{owner}/{repo}/pulls/<number>/comments/<root_comment_id>/replies" \
     -f body='<返信本文>'
   ```

2. **Resolve する**（`fixed` の場合のみ）:

   ```bash
   gh api graphql -f query='
     mutation($threadId:ID!) {
       resolveReviewThread(input:{threadId:$threadId}) {
         thread { id isResolved }
       }
     }' -f threadId='<thread_id>'
   ```

   - `wontfix`（対応を見送った / 修正不要と判断した）のスレッドは **返信のみ**で Resolve しない。
     判断の妥当性を人間が確認できる状態を残すため。
   - Resolve に失敗した場合（権限不足等）はエラーを握り潰さず、どのスレッドで失敗したかを表示する。

3. 全スレッド処理後、以下の件数を出力する（auto-fix-review がこの出力を集約するため、必ず明示すること）:
   返信件数 / Resolve 件数 / `wontfix` として返信のみ行った件数 / 権限不足等で skip した件数 / 失敗件数。

#### 返信文面のルール（厳守）

- **である調**で書く。文末は「〜した」「〜である」「〜と判断した」。
  「〜しました」「〜です」「〜ます」等の敬体は使わない。
- 相手は AI レビュアーであるため、**感謝・同意・謝罪の表現は書かない**。
  禁止例: 「ご指摘ありがとうございます」「おっしゃる通りです」「失礼しました」
  「ご確認ください」「対応いたしました」
- 事実のみを簡潔に記す。1〜3 文程度。前置き・締めの挨拶は不要。
- 記載内容:
  - `fixed`: 何をどう変更したか（対象箇所と変更内容）。Step 7 で控えた短縮 hash を末尾に添える。
  - `wontfix`: 修正しない理由と、その結果コードを変更していない旨。
- 日本語で書く。コード識別子・ファイルパスは原文のまま記す。

返信例（`fixed`）:

```
`parseArgs` に early return を追加し、引数が空配列のときに undefined を参照する経路を除去した。併せて空配列ケースの単体テストを追加した。(abc1234)
```

返信例（`wontfix`）:

```
当該値は呼び出し元の `validateInput` で null チェック済みであり、二重の防御は不要と判断した。コードは変更していない。
```
