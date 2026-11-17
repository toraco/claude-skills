---
name: file-issue
description: バグや課題について、プロジェクトのコードを調査し、原因特定（バグの場合）と対応方針の策定まで行った上で、既存 issue との重複を踏まえて GitHub に反映する（新規起票 / 既存へコメント追記 / スキップ）。1 PR に収まらない課題や複数機能をまとめた入力（要件定義書など）は、指示がなくても親 issue と sub-issues に分けて起票する
---

# File a GitHub issue from user provided description: $ARGUMENTS

**使い方**: `/file-issue [bug-or-task-description]`

## Goal

受け取った課題（バグ / タスク / 機能要望 等）について、

1. プロジェクト内のコードを調査し
2. バグであれば原因を特定し、そうでなくとも対応方針を策定した上で
3. **既存 issue との重複を踏まえて** GitHub に反映する（新規起票 / 既存 issue へのコメント追記 / スキップのいずれか）

起票の単位は、Step 1 で決める **構成**（単独 issue / 親 issue + sub-issues）に従う。親子構成はユーザーの指示がなくても、条件に当てはまれば選ぶ。

**実装はしない。** issue に「何を・なぜ・どう直すか」まで書いて GitHub に反映するのがゴール。

## Steps (obey strictly)

### Step 1: Classify and clarify

- `$ARGUMENTS` を読み、対象を分類する（bug / feature / refactor / chore / question）。
- 重要な情報が欠けている場合（例: bug で再現手順・期待値・実際の挙動が揃っていない）、調査に入る前に **ユーザーに一度だけ** 簡潔に確認する。推測で進めない。
- リポジトリが GitHub リポジトリであることを確認する: `gh repo view`。未設定ならその時点で止めてユーザーに伝える。
- 構成の見立てを立てる（下の「構成の判定」）。確定は Step 3 で対応方針が見えてから行う。

#### 構成の判定（単独 issue / 親 issue + sub-issues）

ユーザーが構成を指示した場合（「機能ごとに親 issue を立てて」「1 件にまとめて」など）は、その指示に従う。指示がなければ次で決める。

**親 issue + sub-issues にする**（どれか 1 つに当てはまれば）:

1. **入力が複数の機能・課題を含む**: 要件定義書・仕様書・議事録・課題リストなどを渡され、独立した機能や課題が 2 つ以上ある。
   → 機能（課題）ごとに親 issue を立て、その実装タスクを sub-issues にする。親 issue が 1 つで済むなら親 1 件 + sub-issues。
2. **1 つの課題でも 1 PR に収まらない**: 対応方針（Step 3）を、独立してレビュー・マージできる単位に分けると 2 つ以上になる。
   目安は、変更が複数のレイヤー（DB / スキーマ → ドメイン → API → フロントエンド）やパッケージにまたがり、
   1 PR にするとレビューしづらい規模になる場合。先に決めないと進められない設計判断（外部サービスの方式選定など）を
   独立したタスクに切り出す場合もこれに当たる。
3. **既存の親 issue（epic）の配下に入る**: Step 5 の検索で、課題がそのまま収まる open な親 issue が見つかった。
   → 新しい親は立てず、起票する issue を既存の親の sub-issue に加える（Step 6 の E）。

**単独 issue にする**:

- 根本原因が 1 つのバグで、修正が 1 PR に収まる
- 小さなタスク・リファクタ・chore で、分けるとかえって追いにくくなる
- 判断に迷う場合は単独 issue を既定にし、「親子に分ける案」を Step 6 の提示に 1 行添える

sub-issue の粒度は **1 sub-issue = 1 PR** にする（`/stack-issues` が 1 issue 1 PR の Stacked PRs に積むため）。
1 つの親に sub-issues が 10 件を超えそうなら、親を機能単位で分けられないか先に検討する。

### Step 2: Investigate the codebase

広域探索が必要なら `Explore` subagent を使う。ライブラリの挙動確認が必要なら `context7` MCP を使う。

- **Bug の場合**:
  - 関連する code path を特定する。
  - 実コードを読みながら **根本原因** を突き止める（対症療法的な推測で止めない）。
  - 可能なら再現条件・影響範囲（どの入力・どのユーザー・どの機能が影響を受けるか）も明確化する。
- **Task / Feature / Refactor の場合**:
  - 変更が入りそうな関連モジュール・ファイルを特定する。
  - 既存の規約・類似実装パターン（命名、レイヤー構造、テスト方針など）を把握する。
  - 既存機能と衝突する箇所、影響が波及する箇所を洗い出す。

### Step 3: Formulate the approach

- **Bug**: 根本原因と、それに対する最小修正方針。リグレッションのリスクがある箇所も明記。
- **Task / Feature / Refactor**: 影響ファイルと変更点を並べた手順。必要なら代替案とトレードオフも併記。
- 判断がつかない点・設計判断を要する点は「Open questions」に分離する。憶測で埋めない。
- 親子構成なら、ここで **構成を確定** する: 親 issue の切り方、各 sub-issue の範囲（1 PR 単位）、着手順、sub-issue 間の依存。

### Step 4: Draft the issue

以下の構造で下書きを作る。

- **Title**: 70 文字以内、動詞始まりで具体的に（例: `Fix <X> crashing when <Y>` / `Add <feature> to <module>`）。
- **Body**:
  - `## Summary` — 何が問題か / 何を達成したいか。bug の場合は再現手順・期待挙動・実挙動も含める。
  - `## Root cause` — **bug のみ**。どこで・なぜ起きているか。`path/to/file.ts:42` 形式の行番号参照で該当箇所を指し示す。
  - `## Proposed approach` — 対応方針。影響ファイル一覧と変更概要。
  - `## Open questions` — 判断保留事項があれば列挙（無ければセクションごと省略）。
- 可能な限り `file:line` 参照でコードに紐付ける。本文だけで読み手がコードに飛べる状態にする。

#### 親子構成の場合

- **親 issue の Body**:
  - `## Summary` — 機能（課題）全体で何を達成するか
  - `## 対象の要件` — 入力が要件定義書などなら、要件 ID や章番号（無ければ省略）
  - `## 進め方` — sub-issues の着手順と、ほかの親 issue との前後関係
  - `## 参照` — 関連する設計書・仕様書のパス
  - `## Open questions` — 機能全体にかかる判断保留事項（無ければ省略）
  - sub-issues の一覧は本文に書かない（GitHub の sub-issues 欄に出るため）
- **sub-issue の Body**: 単独 issue と同じ構造（`## Summary` / `## Root cause`（bug のみ）/ `## Proposed approach` / `## Open questions`）に、次を加える:
  - `## 受け入れ条件` — PR をマージしてよい状態を、確かめられる形で箇条書きにする
  - `## 依存` — 先に終わっている必要がある issue を `- #番号` で列挙する（無ければ省略）。`/stack-issues` がレイヤー順を決めるのに使う
- 起票前は issue 番号が無いので、依存や関連は `{{キー}}` のプレースホルダで書き、起票時に `#番号` に置き換える。
- 合計 5 件を超える場合は、下書きを 1 つのファイルにまとめる。置き場所は `.git/file-issue/<短い名前>/`（`.git` 配下なのでコミットされず、作業ツリーも汚さない）。書式の例:
  ```
  === PARENT [F01] 会員登録とログインを実装する
  （親 issue の本文）

  --- SUB [T0101] 会員テーブルとリポジトリを作る
  （sub-issue の本文。直前の PARENT の sub-issue になる）
  ```
- Title は単独 issue と同じ規則に従う。プロジェクトの issue が日本語なら日本語で書く。

### Step 5: Search for existing issues and classify

新規起票の前に、既存 issue との関係を必ず確認する。

- `gh issue list --search "<keywords>" --state all` で open / closed 両方の重複・類似 issue を検索する。キーワードは複数パターン試す（症状語・コンポーネント名・エラーメッセージ等）。
- 候補が見つかったら `gh issue view <number>` で本文を取得し、ドラフトと突き合わせて以下の **4 分類** のどれに該当するか判定する:

| 分類 | 判定基準 | 取るアクション（Step 6） |
|---|---|---|
| **A. 完全重複** | 既存 issue が同じ問題を同じスコープで扱っており、ドラフトに既存にない新情報が無い | **スキップ**（何もせず既存 issue の URL を提示） |
| **B. 関連あり・追記価値あり** | 既存 issue と同じ問題だが、ドラフトに **新しい根本原因 / 再現条件 / 影響範囲 / 対応方針** など追加情報がある | **コメント追記**（既存 issue にドラフトの差分を投稿） |
| **C. 類似だが別物** | 症状や領域は近いが、根本原因 / 対応方針 / スコープが異なる | **新規起票**（本文で関連 issue を `#番号` でリンク） |
| **D. 重複なし** | 関連する既存 issue が見つからない、またはコマンド失敗（認証 / 権限 / ネットワーク等） | **新規起票** |

- 検索コマンドが失敗した場合は D 扱い。後続提示時に「重複検索: 実行不可のため未確認」を 1 行 note する。
- **親子構成の場合**は、親 issue と sub-issue の **それぞれ** について分類する。A / B に当たった sub-issue は起票せず、既存 issue を流用するかコメント追記に回す（流用する既存 issue を新しい親の sub-issue に加えるかは Step 6 で確認する）。
- あわせて、課題を収められる **open な親 issue（sub-issues を持つ issue）** が無いかも見る。見つかれば「構成の判定」の 3 に当たる:
  ```bash
  gh api "repos/{owner}/{repo}/issues/<number>" --jq '.sub_issues_summary'
  ```
- 判定に迷う場合（B/C の境界など）は両案を併記してユーザーに選ばせる。憶測で進めない。

### Step 6: Confirm and execute

GitHub への反映は共有システムに対する外部公開アクションなので、**実行前に必ず** ユーザーに提示して確認を取る。auto mode でもこの確認はスキップしない。提示内容は分類ごとに変える（親子構成なら E にまとめる）:

#### A. 完全重複 → スキップ

既存 issue の URL と「ドラフトに既存以上の新情報なし」と判定した根拠を 2-3 行で提示する。ユーザーが「やはり別 issue として起票」または「追記する」と指示した場合は C / B のフローに切り替える。

#### B. 関連あり・追記価値あり → コメント追記

- 既存 issue の URL / title と、追記するコメント本文ドラフトを提示する。
- コメント本文は **差分情報のみ** を載せる（既存本文と重複する内容は書かない）。`## Additional findings` / `## Root cause` / `## Proposed approach` など必要な見出しのみ使う。
- 承認後:
  ```bash
  gh issue comment <number> --body "$(cat <<'EOF'
  ## Additional findings
  ...
  EOF
  )"
  ```
- 実行後、コメント URL を表示する。

#### C. 類似だが別物 → 新規起票（関連リンク付き）

- ドラフト（title / body / 予定ラベル）に加え、本文末尾に `## Related` セクションを追加して関連 issue を `#番号` でリンクする。
- 以降は D と同じフロー。

#### D. 重複なし → 新規起票

- ドラフト（title / body / 予定ラベル）をユーザーに提示する。
- プロジェクトの既存ラベル規約を確認する: `gh label list`。
  - 該当ラベル（例: `bug`, `enhancement`, `refactor`）があれば付与候補として提示する。
  - `gh label list` がエラー / 空 / 該当ラベル無し のいずれの場合も **ラベル無しで提案する**。`bug` / `enhancement` 等の汎用名を推測で載せない（プロジェクト独自規約と食い違う恐れがあるため）。
- 承認後、HEREDOC で body を渡して作成する:
  ```bash
  gh issue create --title "..." --body "$(cat <<'EOF'
  ## Summary
  ...
  EOF
  )" --label "bug"
  ```
- 実行後、issue URL を表示する。

#### E. 親 issue + sub-issues → まとめて起票

親子構成のときは、A〜D の分類を issue ごとに付けたうえで、全体を **1 回の確認** にまとめる（issue ごとに確認しない）。

**提示する内容**:

- 構成を選んだ理由（「構成の判定」のどれに当たるか）。ユーザーが構成を指示していない場合は特に明記する
- 親 issue ごとの表: 親のタイトル / sub-issue の数 / 対象の要件や範囲
- 各 issue の分類（A〜D）。D 以外があれば、既存 issue の番号と扱い（流用 / 追記 / スキップ）
- Issue Type とラベルの予定。Issue Type はリポジトリ（または org）に定義されているときだけ使う:
  ```bash
  gh api graphql -f query='{repository(owner:"<owner>",name:"<repo>"){issueTypes(first:20){nodes{name}}}}'
  ```
  `Feature` / `Task` があれば親を `Feature`、sub-issue を `Task` にするのを既定とする（bug の親子なら親を `Bug`）。取得に失敗した / 定義が無い場合は Issue Type を付けない。ラベルは D と同じ規則
- 下書きファイルのパス（ファイルにまとめた場合）。全文はファイルで読んでもらい、メッセージには要点だけ書く
- Open questions と、独立したタスクに切り出した設計判断

**承認後の実行**:

1. 親 issue → その sub-issues の順に作る。Issue Type を付けるときは REST で作る（`gh issue create` は Issue Type を指定できないことがある）:
   ```bash
   gh api -X POST "repos/{owner}/{repo}/issues" -f title="..." -f body="$(cat body.md)" -f type="Task" -f 'labels[]=enhancement'
   ```
   GitHub MCP の `issue_write` を使ってもよい。
2. 作るたびに `キー → {number, id}` を記録する（`.git/file-issue/<短い名前>/created.json` など）。途中で失敗したら、記録済みのキーを飛ばして再開する。**同じ issue を二重に作らない。**
3. 全件を作り終えたら、本文の `{{キー}}` を `#番号` に置き換えて更新する（`gh issue edit <number> --body-file ...`）。
4. sub-issue を親に紐付ける。`sub_issue_id` は issue **番号ではなく REST の `id`**（作成時のレスポンスの `.id`）を渡す:
   ```bash
   gh api -X POST "repos/{owner}/{repo}/issues/<parent-number>/sub_issues" -F sub_issue_id=<sub-issue-id>
   ```
   GitHub MCP の `sub_issue_write` を使ってもよい。既存の親に加える場合（構成の判定の 3）も同じ。
5. 確かめる:
   - 各親の `sub_issues_summary.total` が予定の件数と一致する
   - 本文に `{{` が残っていない
   - Issue Type・ラベルが予定どおり
6. 結果を報告する: 親 issue の番号と URL の表、sub-issue の件数、作らなかった issue（A / B）とその理由。
   最初に着手する親 issue を挙げ、`/stack-issues #<親>` で sub-issues を 1 issue 1 PR の Stacked PRs で実装できることを案内する。
7. 下書きを `.git/file-issue/` に置いた場合は、確認が済んだら削除してよい（削除できなくてもコミットされないので害はない）。

## Non-goals

- コードは修正しない。実装 / パッチ適用は別 skill（`bugfix` 等）に委ねる。
- PR は作成しない。
- 既存 issue の **本文書き換え** はしない（情報追加はコメントで行う）。タイトル変更・ラベル変更・close 等もユーザー指示が無い限り行わない。
  例外は、この skill で作った issue の `{{キー}}` 置き換えと、Step 6 で承認を得た既存の親 issue への sub-issue の追加。
- 親子に分けた sub-issues の実装・計画は行わない（`/stack-issues` や `/make-plan` に委ねる）。
