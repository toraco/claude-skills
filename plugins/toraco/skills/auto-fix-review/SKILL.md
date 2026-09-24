---
name: auto-fix-review
description: PR の Claude Code Review を待ち（自動レビュー未設定のリポジトリでは @claude メンションでレビューを依頼し）、High (🔴) / Medium (🟡) の指摘がなくなるまで /fix-review --yes を自動反復実行する
---

# Auto Fix Review Loop: $ARGUMENTS

**使い方**: `/auto-fix-review [pr-number] [--mode auto|mention] [--max-iterations N] [--wait-minutes N] [--max-reruns N]`

## Goal

Claude Code Review が PR に返した **High severity**（`### 🔴 バグ` または `### High` 等）と
**Medium severity**（`### 🟡 設計上の問題` または `### Medium` 等）の指摘を全て解消するまで、
「レビュー待機 → /fix-review --yes 実行 → push → 再レビュー待機」を自動反復する。

レビューコメントは emoji 形式（🔴/🟡/🟢）と英語形式（High/Medium/Low）のどちらでも出力されうるため、
両形式を等価に扱う。詳細な検出ルールは `/fix-review` Step 2 と同じ。

また Claude Code Review は **集約コメント型**（PR への 1 件の issue comment）と
**インラインコメント型**（差分行への review thread）の 2 形態で出力される。本スキルは両方を
完了条件の判定対象とする。インラインコメント型では、対応済みスレッドへの返信と Resolve を
`/fix-review` Step 8 が行うため、**未解決 review thread の残存有無**がそのまま進捗指標になる。

さらに、レビューを投稿する GitHub Actions の run が **`conclusion == success` で完了しているのに
コメントが投稿されない／更新されない**事象が起きうる。この場合いくら待っても新規レビューは
到着しないため、本スキルは待機タイムアウト時に workflow の状態を確認し、必要なら **rerun** して
再投稿を促す（Step 1-3。rerun は 1 回のレビュー待機につき最大 `--max-reruns` 回）。

加えて、リポジトリに **Claude による自動レビュー（PR の push で自動起動するレビュー）が設定されていない**
場合でも、`@claude` メンションに応答する workflow があれば本スキルが使える。この **mention モード**では、
本スキル自身が PR に `@claude` メンション付きのレビュー依頼コメントを投稿し、「レビュー依頼 → レビュー待機 →
/fix-review --yes 実行 → push → 再レビュー依頼」を繰り返す（Step 0-6 でモードを判定し、Step 1-R で依頼する）。

これは `/goal` 的な完了条件ドリブンのループであり、本スキルが起動された時点で
ユーザー追加入力なしに完了条件まで走り切ることが期待される。

## Parameters

`$ARGUMENTS` を以下のように解釈する（順不同・全て省略可）。

- `pr-number`: 数値トークン1個。対象 PR 番号（省略時は current branch から `gh pr view` で検出）
- `--mode auto|mention`: レビュー起動方式を明示する（省略時は Step 0-6 で自動判定）
  - `auto`: push を契機に自動でレビューが投稿されるのを待つ（従来の挙動）
  - `mention`: 本スキルが `@claude` メンション付きコメントでレビューを依頼し、その応答を待つ
- `--max-iterations N`: 修正サイクルの最大反復回数（default 5）
- `--wait-minutes N`: 各レビュー待機の最大分数（default 10）
- `--max-reruns N`: 1 回のレビュー待機あたりの review workflow 再実行回数の上限（default 2。
  workflow の初回実行と合わせて最大 3 回まで実行されることになる）。`0` を指定すると rerun 機構を無効化する。
  mention モードでは「レビュー依頼コメントの再投稿」回数の上限として扱う

## Completion conditions (いずれか満たした時点で終了)

- **A. SUCCESS**: 以下の両方を満たす
  - 最新の `author.login == "claude"` の集約レビューコメントに High severity 見出し（`🔴` または `High`）と Medium severity 見出し（`🟡` または `Medium`）のいずれも含まれない
  - `claude` 発の**未解決（`isResolved == false`）review thread** が 0 件
- **B. MAX_ITER**: 反復回数が `--max-iterations` に到達
- **C. TIMEOUT**: レビュー待機が `--wait-minutes` を超過しても新規レビューが到着せず、かつ rerun 対象の
  workflow run を特定できない（run 実行中・rerun しても状況が変わらない conclusion 等を含む）
- **D. ERROR**: `/fix-review` がエラーで失敗、push に失敗、または `gh run rerun` の実行自体に失敗
- **E. NOT_CONVERGED**: Safety notes の収束チェックで「同一 issue 集合が 2 回連続検出」され、自動継続を停止
- **F. REVIEW_MISSING**: review workflow は完了しているのにレビューコメントが投稿されず、
  rerun 上限（`--max-reruns`）に到達した（mention モードでは依頼の再投稿上限に到達した）
- **G. NO_REVIEWER**: 自動レビューも `@claude` メンション応答も利用できないと判断した
  （Step 0-6 で `REVIEW_MODE = none` となった場合）

## Steps (obey strictly)

### Step 0: 初期化

1. `$ARGUMENTS` を上記 Parameters に従って解析する。
2. 対象 PR を確定する:
   - 引数で指定されていればそれを使う
   - そうでなければ `gh pr view --json number,headRefName` で current branch の PR を検出
   - 見つからなければユーザーに通知して終了
3. `iteration = 0` で初期化する。
4. `baseline_ts` を取得する。集約コメントとインラインコメントの**両方**の最終更新時刻のうち、
   新しい方を採用する:
   ```bash
   # 集約コメント側
   TS_ISSUE=$(gh pr view <pr> --json comments --jq '[.comments[] | select(.author.login=="claude")] | last | .updatedAt // ""')
   # インラインコメント側（claude 発の review comment の最終作成時刻）
   TS_INLINE=$(gh api "repos/{owner}/{repo}/pulls/<pr>/comments" --paginate \
     --jq '[.[] | select(.user.login=="claude") | .created_at] | max // ""')
   # baseline_ts = 辞書順で大きい方（ISO8601 UTC なので辞書順比較 = 時系列比較）
   ```
   どちらも空なら `baseline_ts = ""`（= まだレビュー無し状態）。
   注: `iteration == 0` かつ既存レビューありで Step 2 即終了するケースでは `baseline_ts` は実質未使用だが、
   形式的に取得しておくこと（後続パスとの整合性のため）。
5. `rerun_count = 0` で初期化する（**1 回のレビュー待機あたり**の rerun 回数。Step 4 で反復ごとにリセットする）。
   全反復を通じた累計は `rerun_total` として別に数え、Step 5 のレポートに出す。
   mention モードで投稿したレビュー依頼コメントの累計は `requests_total = 0` から数える。
6. **レビューモード（`REVIEW_MODE`）と review workflow を特定する**（Step 1 の分岐と Step 1-3 の rerun 判定で使う）。
   まず `grep -rl "anthropics/claude-code-action" .github/workflows/ 2>/dev/null` で Claude 系 workflow を列挙し、
   各ファイルの `on:` 配下のトリガ名を確認する。トリガ名は**キー名の完全一致**で判定すること
   （`pull_request_review` / `pull_request_review_comment` は `pull_request` とは別物。部分一致で拾わない）。

   1. `--mode` が指定されていればそれを `REVIEW_MODE` とする（自動判定より優先）。
      ただし mention を指定したのに下記 3. の mention workflow が見つからない場合も、そのまま mention で進めてよい
      （Workflow を使わない Claude のレビュー機能がメンションに応答するケースがあるため）。
      このとき `MENTION_WORKFLOW_NAME` は未特定として扱う
   2. **auto 判定**: `pull_request` / `pull_request_target` トリガを持つ workflow がある → `REVIEW_MODE = auto`。
      複数該当する場合はファイル名または `name:` に `review` を含むものを優先する。
      `name:` の値を `REVIEW_WORKFLOW_NAME` として保持する
   3. **mention 判定**: auto に該当する workflow が無く、`issue_comment`（または `pull_request_review_comment`）
      トリガを持つ workflow がある → `REVIEW_MODE = mention`。
      - `name:` の値を `MENTION_WORKFLOW_NAME` として保持する
      - トリガ文言を `TRIGGER_PHRASE` として保持する: workflow の `with:` に `trigger_phrase:` があればその値、
        無ければ既定の `@claude`
      - workflow の `if:` 条件がメンション投稿者を絞っている場合（`author_association` / 特定ユーザー等）は、
        `gh api user --jq .login` で得た自分がその条件を満たすか確認する。満たさなければ **G (NO_REVIEWER)**
   4. **workflow ファイルが 1 件も見つからない**場合: Actions を使わない Claude のレビュー機能で自動レビューが
      設定されている可能性があるため、いったん `REVIEW_MODE = auto` として開始し、`mention_fallback = true` とする
      （Step 1-3 で rerun 対象の run が見つからず C に倒れる場面で、1 回だけ mention モードに切り替えて依頼を投稿する）
   5. Claude 系 workflow はあるが auto / mention のどちらにも該当しない（`workflow_dispatch` のみ等）
      → `REVIEW_MODE = none` として **G (NO_REVIEWER)** で終了する

   `REVIEW_MODE == auto` で `REVIEW_WORKFLOW_NAME` を決められなかった場合は、Step 1-3 で
   `gh run list --commit <head-sha>` の `workflowName` に `claude` を含む最新 run にフォールバックする。
   それでも特定できない場合は **rerun 機構を無効化**し（待機タイムアウトで C に倒す。`mention_fallback` を除く）、
   その旨を Step 5 のレポートに明記する。
7. `REVIEW_MODE == mention` の場合、`REVIEWER_LOGIN = "claude"` を前提とする（`/fix-review` が `author.login == "claude"`
   のコメントだけを読むため）。レビュー応答が別の login（`github-actions` 等）で投稿された場合（Step 1-3 の mention 手順 6 で検出）は、
   `/fix-review` がそれを読めないので **D (ERROR)** で終了し、workflow が Claude GitHub App の token で
   投稿するよう設定されているか確認を促す。

### Step 1 (loop entry): 最新レビュー取得

#### Step 1-1: 取得と判定

以下の 2 系統を取得する。

- **集約コメント**: `gh pr view <pr> --json comments --jq '[.comments[] | select(.author.login=="claude")] | last'`
- **未解決 review thread**: `/fix-review` Step 2-2 と同じ GraphQL クエリで
  `reviewThreads` を取得し、`comments.nodes[0].author.login == "claude"` かつ
  `isResolved == false` のスレッドを数える。

判定:

- もし `iteration == 0` かつ既存レビュー（集約コメントまたは review thread のいずれか）があれば、
  それを今回の評価対象として Step 2 へ進む。
  - ただし `REVIEW_MODE == mention` の場合は、既存レビューが **PR の head commit より新しい**ときだけ評価対象とする
    （mention モードでは push ごとにレビューが走らないため、古いコミットに対するレビューが残っていることが多い）。
    head commit の時刻は `gh pr view <pr> --json commits --jq '.commits | last | .committedDate'` で取得し、
    既存レビューの時刻（Step 0-4 の `baseline_ts`）と比較する。古ければ既存レビューは無いものとして次へ進む。
- それ以外（push 直後の待機ターン、および初回でまだレビューが 1 件も無いケース）は:
  - `REVIEW_MODE == auto` → Step 1-2 の待機ループへ進む
  - `REVIEW_MODE == mention` → Step 1-R でレビューを依頼してから Step 1-2 へ進む

注: jq の `last` で最新の Claude レビューを取得しているので、既存レビューが古い場合でも
「現時点での最新評価」とみなして問題ない（過去の解消済み issue が紛れ込む心配はない）。
review thread 側は `/fix-review` が対応済みスレッドを Resolve するため、
未解決として残っているものだけが未対応の指摘である。

#### Step 1-R: @claude メンションでレビューを依頼する（mention モードのみ）

自動レビューが設定されていないリポジトリでは、本スキルがレビュー依頼コメントを投稿する。
`REVIEW_MODE == auto` のときはこの Step を実行しない。

1. 以下の本文でコメントを投稿する（`<TRIGGER_PHRASE>` は Step 0-6 で特定した値。既定 `@claude`）。
   出力フォーマットを `/fix-review` Step 2-1 の解析ルールに合わせるよう明示し、レビュアーにコードを
   変更させない（mention 応答の workflow は commit / push できる権限を持つことが多いため）:
   ````bash
   gh pr comment <pr> --body-file - <<'EOF'
   <TRIGGER_PHRASE> この PR の差分全体をレビューしてください。

   - **レビューのみ**を行い、コードの変更・commit・push・ブランチ作成は一切しないでください。
   - 結果はこのコメントへの返信として、次のフォーマットで出力してください。該当する指摘が 1 件も無い
     重大度の見出しは**出力しない**でください（見出しの有無で指摘の有無を判定しています）。

   ```
   ### 🔴 バグ
   #### 1. <指摘タイトル>
   **ファイル:** `path/to/file.ext:<line>`
   <問題の説明と修正案>

   ### 🟡 設計上の問題
   #### 2. <指摘タイトル>
   ...

   ### 🟢 指摘・改善提案
   #### 3. <指摘タイトル>
   ...
   ```

   指摘が 1 件も無い場合は、`### ✅ 指摘なし` とだけ出力してください。
   EOF
   ````
   - 2 回目以降の依頼（Step 4 からの再依頼、Step 1-3 からの再投稿）では、トリガ文言の直後に
     「前回のレビュー以降に指摘を修正して push しました。最新の差分全体を改めてレビューしてください。」と添える
     （コメントはトリガ文言で始めること。Step 1-R-2 の特定と workflow の起動条件がそれに依存する）。
     前回の指摘の再掲・既に解消済みの指摘の再報告は不要である旨も書いてよい
   - 投稿に失敗した場合は **D (ERROR)** で終了する
2. 投稿したコメントの `createdAt` を GitHub から取得し `request_ts` とする:
   ```bash
   REQUEST_TS=$(gh pr view <pr> --json comments \
     --jq '[.comments[] | select(.body | startswith("<TRIGGER_PHRASE>"))] | last | .createdAt')
   ```
   `baseline_ts = max(baseline_ts, request_ts)` に更新する（依頼より前のコメントを新規レビューと誤認しないため）。
3. `requests_total += 1`（Step 5 のレポート用）。Step 1-2 へ進む。

#### Step 1-2: 待機ループ

**いずれか**が `baseline_ts` より新しくなるまで待機する
（ISO8601 UTC 文字列なので辞書順比較 = 時系列順比較で OK）:

- 集約コメントの `updatedAt > baseline_ts`、または
- `claude` 発の review comment の `created_at` の最大値 `> baseline_ts`

**mention モードの追加条件**: メンション応答は「作業中」を示す進捗コメントを先に投稿し、完了時に同じコメントを
書き換える形式であることが多い。途中経過を最終レビューと誤認しないよう、上記に加えて次の**いずれか**を満たすまで待つ:

- `MENTION_WORKFLOW_NAME` の run のうち `createdAt > request_ts` の最新 run が `status == "completed"` になっている
  ```bash
  gh run list --workflow "<MENTION_WORKFLOW_NAME>" --event issue_comment --limit 10 \
    --json databaseId,status,conclusion,url,createdAt \
    --jq '[.[] | select(.createdAt > "<request_ts>")] | sort_by(.createdAt) | last'
  ```
- （`MENTION_WORKFLOW_NAME` が未特定の場合）最新の `claude` コメント本文に作業中の表示（`is working`、
  `working…`、スピナー画像、未完了のチェックリスト `- [ ]` のみ等）が無く、かつ 60 秒後の再取得でも
  `updatedAt` が変化していない

手順:

- 待機予算は `--wait-minutes`。60 秒 sleep → 再取得 を予算いっぱいまで繰り返す。
- 新しいレビューを取得できたら Step 2 へ。
- 予算を使い切ったら **Step 1-3（rerun 判定）** へ進む。従来はここで即 C (TIMEOUT) だったが、
  「workflow は成功しているのにコメントが無い」ケースを救済するため rerun 判定を挟む。
- rerun 実行後にこのループへ戻ってきた場合は、待機予算を新たに `--wait-minutes` 分リセットする。
  したがって 1 回のレビュー待機の総時間上限は `--wait-minutes × (1 + --max-reruns)` となる。
  加えて、rerun 後は対象 run の完了も監視する: `gh run view <run-id> --json status,conclusion` が
  `completed` になり、その 30 秒後の再確認でも新規コメントが無ければ、予算を使い切る前に
  Step 1-3 へ戻ってよい（無駄待ちの回避）。

#### Step 1-3: review workflow の rerun 判定

背景: Claude Code Review の workflow run が `conclusion == success` で終了しているのに、PR に
コメントが投稿されない（あるいは既存コメントが更新されない）ことがある。この状態では待ち続けても
新規レビューは到着しないため、workflow を rerun して再投稿を促す。

Step 0-6 で rerun 機構が無効化されている場合、または `--max-reruns 0` の場合は、この Step を
丸ごとスキップして **C (TIMEOUT)** で終了する（ただし下記「mention へのフォールバック」は `--max-reruns 0` 以外なら適用する）。

**mention モードの場合**は、以下の 1〜7 の代わりにこの手順を行う（メンション起動の run は head SHA に紐付かないため）:

1. Step 1-2 と同じ `gh run list --workflow "<MENTION_WORKFLOW_NAME>" ...` で `createdAt > request_ts` の最新 run を取得する
2. run が見つからない（`MENTION_WORKFLOW_NAME` 未特定の場合を含む）→ メンションが workflow を起動していない。
   **C (TIMEOUT)** で終了し、考えられる原因（トリガ文言の不一致、投稿者の権限不足、workflow の `if:` 条件）を報告する
3. `status != "completed"` → **C (TIMEOUT)** で終了し、run URL を添えて「実行中のまま待機上限に達した」と報告する
4. `status == "completed"` で `conclusion` が `skipped` / `action_required` / `neutral` 等 → **C (TIMEOUT)** で終了し、
   `conclusion` と run URL を報告する
5. `rerun_count >= max-reruns` → **F (REVIEW_MISSING)** で終了する
6. それ以外（`success` / `failure` / `cancelled` / `timed_out` で応答が無い）→ まず `request_ts` より新しい
   `claude` 以外の bot（`github-actions` 等）のコメントが無いか確認する。あればレビューは投稿されているが
   `/fix-review` が読めない login なので、Step 0-7 に従い **D (ERROR)** で終了する。無ければ `gh run rerun` ではなく、
   **Step 1-R のレビュー依頼コメントを再投稿**する（再投稿の方が新しい `request_ts` で追跡できるため）
7. `rerun_count += 1`、`rerun_total += 1`。待機予算をリセットして Step 1-2 に戻る

**mention へのフォールバック**（`mention_fallback == true` の auto モードのみ）: 下記 2. で「対象 run を特定できない」
となった場合は C で終了する代わりに、`REVIEW_MODE = mention`・`mention_fallback = false`・`TRIGGER_PHRASE = "@claude"`・
`MENTION_WORKFLOW_NAME` 未特定として **Step 1-R** に進み、以降の反復も mention モードで続ける。
この切り替えは全体で 1 回限りとし、Step 5 のレポートに「自動レビューが見つからなかったため mention モードに切り替えた」と明記する。

**auto モードの場合**:

1. 現在の head SHA と対象 run を取得する:
   ```bash
   HEAD_SHA=$(gh pr view <pr> --json headRefOid --jq '.headRefOid')
   gh run list --commit "$HEAD_SHA" --limit 30 \
     --json databaseId,workflowName,status,conclusion,url,createdAt \
     --jq '[.[] | select(.workflowName == "<REVIEW_WORKFLOW_NAME>")] | sort_by(.createdAt) | last'
   ```
   `REVIEW_WORKFLOW_NAME` を特定できていない場合は
   `select(.workflowName | test("claude"; "i"))` にフォールバックする。
2. 対象 run を特定できない → **C (TIMEOUT)** で終了（rerun すべき対象が無い）。
3. `status != "completed"`（`queued` / `in_progress`）→ まだ実行中なので rerun しない。
   **C (TIMEOUT)** で終了し、run URL を添えて「実行中のまま待機上限に達した」と報告する。
4. `status == "completed"` の場合、`conclusion` で分岐する:
   - `success` → **本機構の主対象**。成功しているのにコメントが無い＝取りこぼしとみなし rerun する
   - `failure` / `cancelled` / `timed_out` → 同じく「コメントが投稿されない」症状なので rerun 対象。
     rerun 時は `--failed` を付ける（失敗ジョブが無いと拒否されることがあるため、その場合はフラグ無しで再試行）
   - `skipped` / `action_required` / `neutral` 等 → rerun しても状況が変わらないため **C (TIMEOUT)** で終了し、
     `conclusion` と run URL を報告する
5. `rerun_count >= max-reruns` → **F (REVIEW_MISSING)** で終了。
   「workflow は完了しているがレビューコメントが投稿されない」旨・run URL・rerun 回数を報告する。
6. rerun を実行する:
   ```bash
   gh run rerun <run-id>           # conclusion == success の場合
   gh run rerun <run-id> --failed  # conclusion == failure / cancelled / timed_out の場合
   ```
   - `gh run rerun` は**同一 run-id の新しい attempt**として再実行される（run-id は変わらない）。
     完了判定は同じ run-id に対して行う: `gh run view <run-id> --json status,conclusion,attempt`
   - コマンド自体が失敗した場合（run が古すぎる / 権限不足 / 再実行不可）は出力をそのまま表示し、
     **D (ERROR)** で終了する。同じ rerun を繰り返し叩かない
7. `rerun_count += 1`、`rerun_total += 1`。**`baseline_ts` は更新しない**
   （引き続き「元の基準より新しいレビュー」を待つため）。待機予算をリセットして Step 1-2 に戻る。

### Step 2: 重大度判定

- **集約コメント側**: 取得した最新コメント本文に **High** または **Medium** の見出しが含まれるか判定する。
  判定ルール（大文字小文字を区別しない）: `###` または `####` 見出し行に以下のいずれかが含まれれば該当:
  - High: `🔴` または `High`（例: `### 🔴 バグ`, `### High Priority`, `### High Severity Issues`, `### 🔴 High`）
  - Medium: `🟡` または `Medium`（例: `### 🟡 設計上の問題`, `### Medium`, `### 🟡 Medium`）
- **インラインコメント側**: `claude` 発の未解決 review thread が 1 件以上あれば「未対応の指摘あり」とみなす。
  severity 表記が無いインラインコメントも Medium 相当として扱う（`/fix-review` Step 2-2 と同じ扱い）。
- **どちらにも該当しない**（= 集約コメントが Low/🟢 のみまたは severity 見出し皆無、かつ未解決 review thread が 0 件）
  → Completion **A (SUCCESS)** で終了。最終レポートを出力。
- **いずれかに該当する** → Step 3 へ。

### Step 3: /fix-review --yes 実行

- `Skill` ツールで `fix-review` を呼び出す:
  - `args` には `<pr-number> --yes` を渡す（pr-number は Step 0 で確定したもの）
- `/fix-review --yes` は内部で修正・commit・push を完了する想定。
  インラインコメント型の指摘については、対応したスレッドへの返信と、修正済みスレッドの
  Resolve conversation も `/fix-review` Step 8 が実施する。
- `/fix-review` の出力から「返信件数 / Resolve 件数 / `wontfix` として返信のみ行った件数」を
  控えておき、Step 5 の最終レポートに集約する。
- 実行が失敗した場合は Completion **D (ERROR)** で終了し、原因を表示。

### Step 4: 反復制御

- `iteration += 1`
- `iteration >= max-iterations` なら Completion **B (MAX_ITER)** で終了。
- そうでなければ:
  - `rerun_count = 0` にリセットする（push により新しい workflow run が生成されるため、
    rerun 上限は「レビュー待機 1 回あたり」で数え直す。`rerun_total` はリセットしない）。
  - `baseline_ts` を **更新する**: ローカル時刻ではなく、GitHub から再取得した
    現時点での最新 Claude レビューの時刻（Step 0 と同じく集約コメント／インラインコメントの
    新しい方）を採用する。
    ```bash
    # push 直後の race（Claude レビューが既に到着していて取りこぼす）を避けるため
    # 短い sleep を挟んでから再取得する
    sleep 5
    # Step 0 と同じ手順で TS_ISSUE / TS_INLINE を取得し、新しい方を baseline_ts とする
    ```
    （ローカル時刻採取だと GitHub サーバとの時計ズレで新規レビューを取りこぼす or 無限待機するリスクがあるため）
    残余 race（sleep 5 では取りきれない極端ケース）は `--wait-minutes` のタイムアウト後、
    Step 1-3 の rerun 判定を経て Completion **C (TIMEOUT)** / **F (REVIEW_MISSING)** に倒れ、
    ユーザーに再実行を促すことで安全側に倒す。
  - 注: `/fix-review` が `wontfix` としたスレッドは Resolve されずに残るため、次の反復でも
    未解決 review thread として検出される。これは Safety notes の収束チェック（同一 issue 集合の
    2 回連続検出）で **E (NOT_CONVERGED)** に倒れ、人間の判断に委ねられる。
  - Step 1 に戻る（mention モードでは Step 1-1 から Step 1-R に進み、修正後の差分に対するレビューを改めて依頼する）

### Step 5: 最終レポート

終了時に以下を表示する:

- 終了ステータス（A / B / C / D / E / F / G）
- レビューモード（`auto` / `mention`）と判定根拠（`--mode` 指定 / 検出した workflow 名 / auto からのフォールバック）。
  mention モードの場合は投稿したレビュー依頼コメントの件数 `requests_total`
- 実行した反復回数
- 各反復で修正した issue のサマリ（/fix-review の出力を集約）
  - 反復 0 回で SUCCESS した場合は「修正なし（初回時点で High/Medium 指摘なし）」と明示する
- インラインコメント型だった場合の対応件数: 返信した件数 / Resolve した件数 /
  `wontfix` として返信のみ行った件数
- **review workflow の rerun 状況**: 反復ごとの rerun 回数と累計 `rerun_total`、rerun した run URL。
  rerun 機構が無効化されていた場合（Step 0-6 で workflow を特定できなかった / `--max-reruns 0`）はその旨
- 未解消で残った High / Medium 指摘（B / C / E で終了した場合。元コメントの表記 🔴/🟡 か High/Medium かはそのまま反映）
  - 未解決のまま残った review thread は `path:line` を併記する
- 次にユーザーが取るべきアクション（手動レビュー、再実行など）
  - **G (NO_REVIEWER)** の場合は、Claude の自動レビュー workflow（`pull_request` トリガ）または `@claude` メンションに
    応答する workflow（`issue_comment` トリガ）の導入を案内する（例: Claude Code の `/install-github-app`）
  - **F (REVIEW_MISSING)** の場合は、workflow 側の調査を促す: 該当 run のログ確認
    （`gh run view <run-id> --log`）、`GITHUB_TOKEN` / PAT の権限、API rate limit、
    `anthropics/claude-code-action` のバージョンや設定変更の有無

## Safety notes

- 同じ issue が複数反復で繰り返し検出される場合（= 修正が効いていない or レビュアーの観点が新たに広がっている）、
  Step 3 完了時に「直前ターンの修正対象 issue 一覧」と今回の一覧を比較する
  （`iteration >= 1` でのみ発火。`iteration == 0` では「直前ターン」が存在しないのでスキップ）。
  比較単位は、レビュー本文中の `#### N. <title>` 行から `<title>` 部分のみ抽出した
  文字列セット（番号 `N.` と前後の空白は除外）。インライン由来の issue は
  `path:line` + コメント本文先頭行を比較キーとする。集合一致（順序不問）が 2 回連続したら、
  Completion **E (NOT_CONVERGED)** で停止する。
  カウント起点の例: iteration n と n-1 の比較で一致 = 1 回目、続けて n+1 と n の比較でも一致 = 2 回目（= 2 回連続）→ 警告発火。
  停止手段: Step 5 最終レポートに「自動修正が収束していない」旨と次アクション案
  （手動原因調査 / `/fix-review` 方針見直し / 再実行）を出力してプロセスを終了する。
  本 skill は非対話前提のため `AskUserQuestion` 等での対話確認は行わない。
- **rerun 上限の趣旨**: Actions 実行時間と API rate limit を無駄に消費しないため、workflow の再実行は
  1 回のレビュー待機につき最大 `--max-reruns` 回（default 2）= workflow の初回実行と合わせて計 3 回までとする。
  カウンタは反復ごとにリセットされる（各 push が新しい run を生むため）が、`rerun_total` は
  リセットせず必ずレポートに出す。**2 反復以上連続で rerun が発生している場合**は、
  一時的な取りこぼしではなく workflow 側の恒常的な問題（権限・設定・action のバグ）である可能性が高いので、
  その旨をレポートに明記して人間に引き渡す。
- **mention モードの依頼コメントは本スキルの反復に必要な分だけ投稿する**。1 回のレビュー待機につき
  初回依頼 1 件 + 再投稿 `--max-reruns` 件が上限で、新規レビューを待っている間に重ねて依頼しない
  （応答 workflow が多重起動し、Actions 実行時間と API 利用量を浪費するため）。
- mention モードのレビュアーは commit / push 権限を持ちうる。依頼文でコード変更を禁止しているが、
  それでもレビュアーが PR ブランチに commit を push していた場合は、`/fix-review` を実行する前に
  `git pull --ff-only` で取り込み、その commit の存在と内容を Step 5 のレポートに明記する（勝手に revert しない）。
- rerun は「レビューコメントが投稿されない」ことの救済のみを目的とする。レビュー内容そのものが
  気に入らない（指摘が的外れ等）ことを理由に rerun してはならない。
- `/fix-review` の `--yes` は非対話モード。ユーザー確認を全てスキップするので、
  本スキルから呼び出す際は必ず `--yes` を付けること。
- Resolve conversation は取り消しに手間がかかる操作であるため、`/fix-review` が
  **実際に修正した（`fixed`）スレッドのみ** Resolve する。対応を見送った（`wontfix`）
  スレッドは返信のみ行い未解決のまま残す、という原則を本ループから変更しない。
