---
name: file-issue
description: バグや課題について、プロジェクトのコードを調査し、原因特定（バグの場合）と対応方針の策定まで行った上で、既存 issue との重複を踏まえて GitHub に反映する（新規起票 / 既存へコメント追記 / スキップ）。実装タスクが複数の PR に分かれる課題や、複数機能をまとめた入力（要件定義書・設計書・議事録など）は、指示がなくても親 issue と sub-issues（1 issue 1 PR）に分けて起票する
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

前提は **1 issue = 1 PR**（`/stack-issues` が 1 issue 1 PR の Stacked PRs に積む）。
**実装タスクが複数の PR に分かれるなら、issue も分ける。** ユーザーが構成を指示した場合
（「機能ごとに親 issue を立てて」「1 件にまとめて」「2〜4 を 1 件にまとめる」など）はその指示に従い、
指示がなければ次で決める。

**親 issue + sub-issues にする**（どれか 1 つに当てはまれば）:

1. **入力が複数の機能・課題を含む**: 要件定義書・設計書・調査結果・監査結果・議事録・課題リストなどを渡され、
   独立した機能や課題が 2 つ以上ある。
   → 機能（の大分類）ごとに親 issue を立て、その実装タスクを sub-issues にする。親が 1 つで済むなら親 1 件 + sub-issues。
2. **1 つの課題でも 1 PR に収まらない**: 対応方針（Step 3）を、独立してレビュー・マージできる単位に分けると 2 つ以上になる。
   - 変更が複数のレイヤー（DB / スキーマ → ドメイン → API → admin / フロントエンド → E2E）やパッケージにまたがり、
     1 PR では数十ファイルを超えてレビューしづらい
   - 先に決めないと実装できない設計判断・外部との合意がある（`docs(design): …を決める` のような sub-issue に切り出す）
   - 段階的に移行・展開する（段階やフェーズごとに sub-issue）
3. **既存の issue の残作業を分ける**: 番号付きの対応方針を持つ大きな既存 issue のうち、一部だけを PR で対応し、
   残りを書き出すよう頼まれた（「#N の残作業を sub-issues に」など）。
   → 既存 issue をそのまま親にし、残りを sub-issues にする。親の本文は書き換えない。
4. **既存の親 issue（epic）の配下に入る**: Step 5 の検索で、課題がそのまま収まる open な親 issue が見つかった。
   → 新しい親は立てず、起票する issue をその親の sub-issue に加える **案を出す**（Step 6 の E）。加えるかはユーザーが決める
   （新しく立てた親を既存の大きな epic にさらにぶら下げる案も同じ。自動では入れない）。

**単独 issue にする**:

- 根本原因が 1 つのバグで、修正が 1 PR に収まる
- 既存の部品を使い回せる画面改修や、小さなタスク・リファクタ・chore で、1 PR に収まる
- 判断に迷う場合は単独 issue を既定にし、「親子に分ける案」（どう分けるか）を Step 6 の確認の選択肢に入れる

**sub-issue の粒度**:

- 1 sub-issue = 1 PR。レイヤーで縦に切る（基盤 → 機能）か、機能の縦の切れ端にするかは、
  下のレイヤーが上のレイヤーを前提にしない順に積めるほうを選ぶ。
- **細かくしすぎない**: 別々にレビューする意味のない作業（同じファイル群への小さな変更、設定の追加だけの作業）は 1 件にまとめる。
  Open questions は、実装の前に決める必要があるものだけを独立した sub-issue にし、それ以外は関係する sub-issue の
  Open questions に入れる。
- 1 つの親の sub-issues が 10 件を超えそうなら、親を機能単位で分けられないか先に検討する。
  親の下に親を作る 3 段の入れ子は、段階移行など明確な理由があるときだけにする。
- 調べて対象外にしたもの（このリポジトリで扱わない・今回は見送る）は、親の `## 範囲外` に書く。
  後で追いかける必要があるものは、sub-issue にする案を確認時に出す（本文の注記だけで済ませない）。

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

まず、リポジトリの既存の親 issue（`sub_issues_summary.total > 0` のもの）を 1〜2 件読み、タイトルの書き方
（例: 末尾の `（親 issue）`、`feat(scope): …` の形式）と見出しの慣例があればそれに合わせる。慣例が無ければ次を使う。

- **親 issue の Body**:
  - `## Summary` — 機能（課題）全体で何を達成するか。設計書があればそのパスと「この issue は実装の親で、下の sub-issue に分けて進める」の一文
  - `## sub-issue と依存の順` — `| # | 内容 | 依存 |` の表。着手順に並べ、依存は `#番号` を並べるか「なし」。
    既存 issue を流用する場合や、ほかの親に残す作業はこの表の下に注記する。起票時は `{{キー}}` で書き、全件の作成後に番号へ置き換える
  - `## 方針` — sub-issue 全体にかかる設計方針（無ければ省略）
  - `## 範囲外` — 扱わないもの・別の issue で扱うもの（無ければ省略）
  - `## Open questions` — 実装に入る前に決めることと、それが影響する sub-issue（無ければ省略）
  - `## Related` — 設計 issue・関連する親 issue・設計書
- **sub-issue の Body**: 単独 issue と同じ構造に、次を加える。
  - `## Summary` の冒頭で、親のどの部分に当たるかを書く（既存 issue を親にした場合は「#N の「Proposed approach」の 2」など）
  - `## 現状` — 関係する既存コードを `file:line` で示す（必要なとき）
  - `## 受け入れ条件` — PR をマージしてよい状態を、確かめられる形で箇条書きにする（テストの観点を含める）
  - `## 依存` — 先にマージされている必要がある issue を `- #番号（理由）` で列挙する（無ければ「なし」）。
    親の表と同じ内容にする。`/stack-issues` がレイヤー順を決めるのに使う
  - `## Related` — 先頭に `- #<親>（親 issue）` を書く
- **済んだ作業の記録用 sub-issue**: 既存 issue の一部を PR で対応済みの場合（構成の判定の 3）、その分も記録用の
  sub-issue にして close するかを確認時に聞く。作る場合は本文に `## 対応内容`（PR・リリースの番号と確認結果）を書き、
  close する前に結果をコメントする。
- 起票前は issue 番号が無いので、依存や関連は `{{キー}}` のプレースホルダで書き、起票時に `#番号` に置き換える。
  番号を予測して書いたり、名前で書いたりしない。
- 合計 5 件を超える場合は、下書きを 1 つのファイルにまとめ、全文はファイルで読んでもらう。置き場所は `.git/file-issue/<短い名前>/`
  （`.git` 配下なのでコミットされず、作業ツリーも汚さない。リポジトリ内の `docs/` などには置かない）。書式の例:
  ```
  === PARENT [F01] 会員登録とログインを実装する
  （親 issue の本文）

  --- SUB [T0101] 会員テーブルとリポジトリを作る
  （sub-issue の本文。直前の PARENT の sub-issue になる）
  ```
- Title は単独 issue と同じ規則に従う。プロジェクトの issue が日本語なら日本語で書く。親の番号はタイトルに入れない。
- CLAUDE.md などに文書の推敲ルール（例: 日本語の issue は yomiyasu で推敲する）があれば、起票前に下書きへ適用する。

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
- GraphQL が使えない環境（`gh issue list` / `gh label list` が 403 になる）では REST で代える。
  `gh api -X GET search/issues -f q='repo:{owner}/{repo} is:issue <keywords>'`（`is:issue` が無いと 422 になる）、
  `gh api "repos/{owner}/{repo}/labels" --paginate --jq '.[].name'`。
- **親子構成の場合**は、親 issue と sub-issue の **それぞれ** について分類する。A / B に当たった sub-issue は起票せず、既存 issue を流用するかコメント追記に回す（流用する既存 issue を新しい親の sub-issue に加えるかは Step 6 で確認する）。
- あわせて、課題を収められる **open な親 issue（sub-issues を持つ issue）** が無いかも見る。見つかれば「構成の判定」の 4 に当たる:
  ```bash
  gh api "repos/{owner}/{repo}/issues/<number>" --jq '.sub_issues_summary'
  ```
- 「#N で対応する」「既存の #N に含まれる」と判断した作業は、#N の本文を読んで本当に含まれているかを確かめる。
  含まれていなければ B（追記）か新しい sub-issue にする。
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

**提示する内容**（1 つのメッセージにまとめる）:

- 構成を選んだ理由（「構成の判定」のどれに当たるか）。ユーザーが構成を指示していない場合は特に明記する。
  単独 issue を選んだ場合も、判定の理由を冒頭に 1 行書く
- 親 issue ごとの表: 親のタイトル / sub-issue の数 / 対象の要件や範囲。親が 1 件なら sub-issue の表（タイトル / 内容 / 依存）
- 分け方で判断したところ: まとめたもの・独立させた設計判断・起票しないもの（範囲外）・前提が決まらず着手できないもの
- 各 issue の分類（A〜D）。D 以外があれば、既存 issue の番号と扱い（流用 / 追記 / スキップ）
- Issue Type とラベルの予定。Issue Type はリポジトリ（または org）に定義されているときだけ使う:
  ```bash
  gh api graphql -f query='{repository(owner:"<owner>",name:"<repo>"){issueTypes(first:20){nodes{name}}}}'
  ```
  `Feature` / `Task` があれば親を `Feature`、sub-issue を `Task` にするのを既定とする（bug の親子なら親を `Bug`）。
  取得に失敗した（GraphQL や `list_issue_types` が 403）/ 定義が無い場合は Issue Type を付けない。
  ラベルは D と同じ規則で、既存 issue を親にした場合は親のラベルに揃える
- 下書きファイルのパス（ファイルにまとめた場合）。全文はファイルで読んでもらい、メッセージには要点だけ書く
- Open questions

続けて `AskUserQuestion` で聞く（先頭の選択肢を推奨案にし、ラベル末尾に「(推奨)」を付ける）。当てはまる問いだけを使う:

- 起票してよいか（この構成で起票する / 分け方を変える（まとめる案・分ける案を具体的に）/ 修正してから起票）
- 既存の親 issue（epic）の配下に入れるか（構成の判定の 4。入れない、も選択肢に含める）
- 既存 issue を sub-issue として流用するか
- 済んだ作業の記録用 sub-issue を作って close するか（構成の判定の 3）
- 範囲外にしたもののうち、追いかける必要があるものを sub-issue にするか

**承認後の実行**:

1. 作る順は **親 → sub-issues を依存の順** にする。こうすると、sub-issue の本文は作成済みの番号（親と先行の sub-issue）だけを参照でき、
   後から置き換えるのは親の表だけになる。既存 issue を親にする場合（構成の判定の 3）は、親を作らずに sub-issues から始める。
   - GitHub MCP の `issue_write`（method=create）に `parent_issue_number` を渡すと、作成と同時に親に紐付く。`type`（Issue Type）と `labels` も渡せる
   - `gh` で作る場合は REST を使う（`gh issue create` は Issue Type を指定できないことがある）:
     ```bash
     gh api -X POST "repos/{owner}/{repo}/issues" -f title="..." -f body="$(cat body.md)" -f type="Task" -f 'labels[]=enhancement'
     ```
     作ったあとに親へ紐付ける。`sub_issue_id` は issue **番号ではなく REST の `id`**（作成時のレスポンスの `.id`）を渡す:
     ```bash
     gh api -X POST "repos/{owner}/{repo}/issues/<parent-number>/sub_issues" -F sub_issue_id=<sub-issue-id>
     ```
   - 既存 issue を流用して sub-issue にする場合は、`gh api "repos/{owner}/{repo}/issues/<n>" --jq .id` で id を取って同じように紐付ける
     （GitHub MCP の `sub_issue_write` でもよい）
2. 作るたびに `キー → {number, id}` を記録する（`.git/file-issue/<短い名前>/created.json` など）。途中で失敗したら、
   記録済みのキーを飛ばして再開する。**同じ issue を二重に作らない。** 失敗したらループを止め、原因を直してから再開する。
3. 全件を作り終えたら、残った `{{キー}}`（主に親の表）を `#番号` に置き換えて更新する（`gh issue edit <number> --body-file ...`）。
4. 確かめる:
   - 各親の sub-issue の件数が予定と一致する（`gh api "repos/{owner}/{repo}/issues/<parent>" --jq '.sub_issues_summary.total'`、または `issue_read` の `get_sub_issues`）
   - 本文に `{{` が残っていない
   - Issue Type・ラベルが予定どおり
5. 記録用 sub-issue を作った場合は、対応状況をコメントしてから close する（`state_reason: completed`）。
   デプロイなど結果待ちのものは、結果が出てから close する。
6. 結果を報告する: 親 issue の番号と URL、sub-issue の番号・内容・依存の表、作らなかった issue（A / B）とその理由。
   互いに依存しない最初の sub-issue を挙げ、`/stack-issues #<親>` で sub-issues を 1 issue 1 PR の Stacked PRs で実装できることを案内する。
   依存は本文に書いただけで GitHub の依存関係（blocked by）は設定していないことも 1 行添える。
7. 下書きを `.git/file-issue/` に置いた場合は、確認が済んだら削除してよい（削除できなくてもコミットされないので害はない）。

## Non-goals

- コードは修正しない。実装 / パッチ適用は別 skill（`bugfix` 等）に委ねる。
- PR は作成しない。
- 既存 issue の **本文書き換え** はしない（情報追加はコメントで行う）。タイトル変更・ラベル変更・close 等もユーザー指示が無い限り行わない。
  例外は、この skill で作った issue の `{{キー}}` 置き換えと、Step 6 で承認を得た既存の親 issue への sub-issue の追加。
- 親子に分けた sub-issues の実装・計画は行わない（`/stack-issues` や `/make-plan` に委ねる）。
