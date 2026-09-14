---
name: local-review
description: ローカルで Claude Code Review 相当のレビューを生成し、🔴バグを自動修正・🟡設計問題は確認の上で修正、最大3周ループする
---

# Local code review & auto-fix loop: $ARGUMENTS

**使い方**: `/local-review [--include-uncommitted]`

## Goal

GitHub App による Claude Code Review（公式 `code-review` プラグイン）と
同等のレビューをローカルで生成し、検出された問題を自動修正する。
レビュー → 修正 → 再レビュー を最大 3 周まで繰り返し、🔴 / 🟡 に分類される
指摘（分類しきい値は Step 4 参照）がゼロになったら終了する。

## Steps (obey strictly)

### Step 0: Setup

- 状態変数を宣言: `iteration = 1`, `MAX_ITERATIONS = 3`,
  `SKIPPED_ISSUES = []`（ユーザーが「スキップする」を選んだ 🟡 の識別子
  リスト。`<file>:<lines>:<title>` 形式で保持し、周をまたいでも維持する）
- `$ARGUMENTS` に `--include-uncommitted` が含まれていれば
  `INCLUDE_UNCOMMITTED = true`、それ以外は false
- デフォルトブランチを以下の順で検出し `DEFAULT_BRANCH` に保存:
  1. `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'`
  2. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
  3. `main` が存在すれば `main`、なければ `master`
- `git fetch origin $DEFAULT_BRANCH --quiet` を 1 回だけ実行
- 現在のブランチが default branch と同じ場合は「default branch 上ではレビュー
  対象がありません」と表示して終了
- **タスクリスト化**: `TaskCreate` でこの skill の主要ステップ
  （対象差分検出 / 事前コンテキスト収集 / 並列レビュー / スコアリング / 修正 /
  検証 / ループ判定 / 最終レポート）をタスクとして登録する。各ステップ開始時に
  `in_progress`、完了時に `completed` に更新する

### Step 1: 対象差分の検出

- `DIFF_RANGE = "origin/$DEFAULT_BRANCH...HEAD"` をレビュー対象とする
- `INCLUDE_UNCOMMITTED` が true の場合は、加えて `git diff HEAD` も対象に含める
- **iteration >= 2 の場合は `INCLUDE_UNCOMMITTED` を強制的に `true` に上書き
  する**（前周の 🔴 自動修正や 🟡 修正は commit せず working tree にある
  ため、これを含めないと同じ修正要求が永続し無限ループする）
- `git diff $DIFF_RANGE --name-only` で変更ファイル一覧を `CHANGED_FILES` に保存
- 差分が空なら「レビュー対象の差分がありません」と表示して終了
- コミットメッセージ一覧を `COMMIT_LOG` に保存:
  `git log --format='%h %s' origin/$DEFAULT_BRANCH..HEAD`

### Step 1.5: 事前コンテキスト収集（2 並列）

**`Agent` ツールを 1 メッセージ内で 2 回並列呼び出し** する。両方とも
`subagent_type: "Explore"`、`model: "haiku"` を **明示** する。

#### 1.5a: CLAUDE.md ファイル列挙

- 入力: `CHANGED_FILES`
- タスク: リポジトリルートの `CLAUDE.md`、および `CHANGED_FILES` に含まれる
  ファイルが存在するディレクトリとその全祖先ディレクトリにある `CLAUDE.md`
  のパスを列挙する。**中身は読まず、パス一覧だけを返す**
- 結果を `CLAUDE_MD_PATHS`（文字列配列）に保存

#### 1.5b: 変更サマリ生成

- 入力: `DIFF_RANGE`、`CHANGED_FILES`、`COMMIT_LOG`、および
  `git log --format='%h %s%n%b' origin/$DEFAULT_BRANCH..HEAD` の詳細ログ
- タスク: 差分と commit メッセージから変更の全体像を把握し、以下の形式で返す:
  ```
  purpose: <1-2文で変更の目的>
  high_level_changes:
    - <主要な変更点 1>
    - <主要な変更点 2>
    - ...
  risk_areas:
    - <レビュー時に特に注視すべき領域 1>
    - <領域 2>
    - ...
  ```
- 結果を `CHANGE_SUMMARY` に保存

この 2 つの結果（`CLAUDE_MD_PATHS` と `CHANGE_SUMMARY`）は Step 2 の 5 reviewer
**および** Step 3 の全 scoring エージェントに共通プレフィックスとして渡す。

## Loop: iteration 1 → MAX_ITERATIONS

各周の冒頭で `===== Review iteration <N>/<MAX> =====` を表示する。2 周目以降は
`CHANGE_SUMMARY` と `CLAUDE_MD_PATHS` を **再生成せず** そのまま再利用する
（差分の主旨は周をまたいでも変わらないため）。

### Step 2: 並列レビュー（Agent ツール 5 並列）

`Agent` ツールを **1 メッセージ内で 5 回並列呼び出し** する。全 5 エージェントで
`subagent_type: "Explore"`、`model: "sonnet"` を **必ず明示** する
（公式プラグインとパリティを取るための最重要設定）。各 subagent には
共通で以下を渡す:

- `DIFF_RANGE`（例: `origin/main...HEAD`）
- `CHANGED_FILES`（変更ファイルパス一覧）
- `DEFAULT_BRANCH` 名
- `CHANGE_SUMMARY`（Step 1.5b の成果物 — 変更の目的・主要変更・リスク領域）
- `CLAUDE_MD_PATHS`（Step 1.5a の成果物）
- `COMMIT_LOG`（コミットメッセージ一覧。ローカル固有の強い意図シグナル）
- 後述の「false positive 例」リスト
- **引用義務**: 「各 issue には、対象コードを最低 1 行コードブロックで引用
  せよ。引用できない指摘は出力から除外せよ。**例外**: 『テスト追加』『新規
  ファイル作成』など存在しないコードを要求する issue の場合は、関連する既存
  ファイル（対象関数の定義元など）を引用して良い」
- **差分外コンテキストの読解**: reviewer #2（浅いバグスキャン）を除き、
  各 reviewer は判断のために対象ファイル全体を `Read` して周辺コンテキストを
  理解してから判断すること。**ただし Read の目的は差分の理解だけであり、
  指摘対象は差分内の変更行に限る**。差分外で見つけた問題（pre-existing な
  バグ・未使用コード・typo 等）は指摘しないこと（false positive 例「差分外
  の行に関する指摘」に該当）
- ツール使用ポリシー（全 subagent 共通 / 必ずそのまま渡すこと）:
  - 現 HEAD のファイル内容を確認するときは必ず `Read` ツールを使う
  - `git show <rev>:<path>` は過去リビジョンの内容が必要な場合のみ使用する
    （現 HEAD の内容取得に `git show HEAD:<path>` を使ってはいけない）
  - `git log` / `git blame` / `git diff` は履歴・責任調査目的の場合のみ使用する
  - 差分そのものは渡された DIFF_RANGE から参照し、周辺コードの文脈が必要な
    場合は `git show` ではなく `Read` でファイル全体を読む

各 subagent には以下の形式で結果を返すよう指示する:

```
- file: <path>
- lines: <start>-<end>
- category: bug | claude-md | history | comment | prior-pr
- title: <one line>
- detail: <description>
- code_excerpt: |
    <1-5 行の引用コード>
- suggested_fix: <how to fix>
```

5 役割（全て `subagent_type: "Explore"` + `model: "sonnet"`）:

| # | 役割 | 指示の要点 |
|---|------|-----------|
| 1 | CLAUDE.md 準拠監査 | `CLAUDE_MD_PATHS` の各ファイルを実際に Read し、差分がそれらのガイダンスに違反していないかチェック。CLAUDE.md は Claude へのガイダンスなのでレビューに不適なもの（執筆指針等）は除外する |
| 2 | 浅いバグスキャン | **差分内のみ** を読み、明らかなバグ・大きな誤りに集中。nitpick・lint で取れるものは無視。周辺ファイルは読まなくてよい（他 reviewer と役割分担） |
| 3 | git history 観点 | 変更箇所の `git log -p` / `git blame` で歴史的経緯と矛盾する変更（過去の fix を巻き戻していないか等）がないかチェック。現 HEAD のファイル内容を見る必要がある場合は `git show` ではなく `Read` を使う |
| 4 | 過去 PR 観点 | `gh pr list --search "<file>" --state merged` で過去 PR を探し、`gh pr view <n> --comments` で過去のレビューコメントが現在の差分にも当てはまらないかチェック。ファイル現状の確認には `Read` を使う（`git show` は不要） |
| 5 | コードコメント準拠 | 変更ファイル内の既存コメント（TODO / NOTE / WARNING 等）が述べるガイダンスに差分が従っているかチェック |

False positive 例（全 subagent に必ず渡す）:

- Pre-existing issues（差分に含まれない既存の問題）
- 型エラー / インポート漏れ / lint の指摘 / フォーマットなど、コンパイラ・
  リンタ・テストが取れるもの
- pedantic な nitpick
- CLAUDE.md にあっても明示的に silenced（例: lint ignore コメント）されているもの
- 意図的と思われる挙動変更で、PR の主目的に直接関係するもの
- 差分外の行に関する指摘
- ドキュメント不足・テスト不足など一般的なコード品質の指摘（CLAUDE.md で
  明示要求されているものを除く）

### Step 3: Confidence scoring（並列）

Step 2 で集まった全 issue について、各 issue ごとに `Agent` ツールを並列呼び出し
し、0-100 のスコアを返させる。全 scoring 呼び出しで `subagent_type: "Explore"`、
`model: "haiku"` を **必ず明示** する（公式と同じ軽量モデル）。
1 メッセージ内で全 issue 分の Agent 呼び出しを並列化する。

各 scoring 呼び出しに渡す情報:

- `CHANGE_SUMMARY`（Step 1.5b の成果物）
- `CLAUDE_MD_PATHS`（Step 1.5a の成果物）
- `DIFF_RANGE`（必要なら scoring agent が自力で diff 取得可）
- 対象 issue の全フィールド（特に `code_excerpt` を必ず含める）
- Step 2 と同じ「false positive 例」リスト
- 下記 rubric（verbatim）

スコアリング rubric（公式プラグインと同じ。subagent にそのまま渡すこと）:

- **0**: Not confident at all. False positive that doesn't stand up to light scrutiny, or pre-existing issue.
- **25**: Somewhat confident. Might be a real issue, but may also be false positive. Could not verify. Stylistic issues not explicitly called out in CLAUDE.md fall here.
- **50**: Moderately confident. Verified it's a real issue, but may be a nitpick or rare. Not very important relative to the rest of the PR.
- **75**: Highly confident. Double-checked and very likely to hit in practice. Important and directly impacts functionality, or directly mentioned in relevant CLAUDE.md.
- **100**: Absolutely certain. Double-checked and confirmed. Will happen frequently. Direct evidence.

追加指示:

- CLAUDE.md カテゴリの issue については、「`CLAUDE_MD_PATHS` の該当ファイルを
  実際に `Read` で開き、その指摘が明示的に書かれているかを verbatim レベルで
  double-check せよ。明示されていなければ 25 以下を付けること。**明示が確認
  できた場合は 80 以上を付けること**（rubric の 75 "Highly confident. directly
  mentioned in CLAUDE.md" は本 skill の 🟡 閾値 80 との整合のため verbatim 案件
  では 80 に引き上げる）」と指示する
- `category` が `prior-pr` の issue については、「過去 PR のレビューコメントの
  文面が、現差分の該当箇所に同じ問題として当てはまる場合は score を **80 以上**
  にすること。コメントが抽象的で差分との対応が不明瞭な場合は 50 以下。
  （claude-md と同様、🟡 閾値 80 との整合のため verbatim マッチ案件は 80 に
  引き上げる）」と指示する
- `code_excerpt` が空の issue、または `code_excerpt` と実際のファイル内容が
  一致しない issue は **0 点** とする（hallucination 対策）。**例外**: 「テスト
  追加」「新規ファイル作成」など存在しないコードを要求する issue の場合、関連
  する既存ファイル（対象関数の定義元など）を `code_excerpt` に使って良い。
  この場合は空・不一致ペナルティを適用しない
- **category を問わず**、内容が lint / typecheck / formatter で自動検出可能な
  性質（未使用 import、未使用変数、型エラー、import 漏れ、フォーマット、命名
  規則違反など）の場合は **25 以下** を付けること。Step 2 の false positive 例
  にも列挙されているが、reviewer が拾ってしまった場合・category を誤ラベリング
  した場合の最終ゲートとして scoring 側で落とす（Step 6 の lint で取れるものは、
  ここで 🔴 / 🟡 に上げない）。

### Step 4: フィルタリング & 分類

- **まず dedup**: 同一ファイル・近接行（±3 行）で同趣旨の指摘が複数 reviewer
  から出ている場合、score が最も高い 1 件を **採用**（category と score もその
  まま採用、merge はしない）、他は **🟢 参考リストに個別エントリとして残す**。
  「同趣旨」の判定は `title` / `detail` / `suggested_fix` の類似性で行う。
  score 同点の場合は category の優先順（`bug` > `history` > `claude-md` >
  `prior-pr` > `comment`）で 1 件選ぶ。
- **次にスキップ済みフィルタ**: `SKIPPED_ISSUES` に含まれる identifier
  （`<file>:<lines>:<title>`）と一致する issue は 🟢 参考リストに降格し、🟡
  分類対象から除外する（前周でユーザーが「スキップする」を選んだものを再度
  `AskUserQuestion` で聞き直さないため）。
- issue を以下のしきい値で分類:
  - 🔴 **バグ**: `category` が `bug` または `history` **かつ** score >= 50
  - 🟡 **設計問題**: `category` が `claude-md` / `comment` / `prior-pr`
    **かつ** score >= 80
- 上記いずれにも該当しない issue は **破棄**（参考リストには残す）
- ユーザー向けに以下を表示:
  - 🔴 一覧: ファイル:行 / 一行サマリ / なぜフラグされたか / score
  - 🟡 一覧: 同上
  - 🟢 参考（修正対象外になったもの。category と score を併記）
- 🔴 / 🟡 ともに 0 件なら **Step 7 へジャンプ**（ループ終了判定）

### Step 5: 修正フェーズ

#### 🔴 バグの自動修正

- ユーザー確認なしで自動修正する
- 各 issue ごとに対象ファイルを `Read` してから `Edit` で `suggested_fix` を適用
  （新規ファイル作成が必要な場合は `Write` を使う）
- 同一ファイルに複数の修正がある場合はまとめて適用し、Edit の競合を避ける
- 修正後に `git diff <file>` で意図通りか確認

#### 🟡 設計問題の確認

- 🟡 が 1 件以上ある場合は `AskUserQuestion` で確認する
- 件数が多ければ 1 質問あたり最大 4 件までに分割
- 各 issue について以下の選択肢を提示:
  - 「指示通り修正する」
  - 「スキップする」
  - 「内容を変えて修正する」（選択時は notes でユーザーに修正内容を記述してもらう）
- ユーザー回答に従って修正を適用（既存ファイル編集は `Edit`、新規ファイル作成
  は `Write`）
- ユーザーが「スキップする」を選んだ issue は、その identifier
  （`<file>:<lines>:<title>`）を `SKIPPED_ISSUES` に追加する。これにより次周
  以降の Step 4「スキップ済みフィルタ」で除外され、`AskUserQuestion` で再度
  聞かれることはない

### Step 6: ローカル検証（check 相当）

以下を順に実行する。コマンドは `package.json` の scripts などから自動検出。

1. **テスト**: 例 `yarn test`。失敗があればそのループ内で修正する
2. **リント**: 例 `yarn lint`。エラーがあれば修正
3. **ビルド dryrun**: 例 `yarn <workspace> build:dryrun`。エラーがあれば修正

検証由来の修正で **連続して同じエラーが解消できない**、もしくは
**大量に新規エラーが出ている** 場合は、ループを止めてユーザーに状況を
報告し、続行可否を確認する。

### Step 7: ループ判定

以下のいずれかを満たしたら **ループ終了 → Step 8 へ**:

1. Step 4 で 🔴 / 🟡 いずれにも分類される issue が 0 件
2. `iteration == MAX_ITERATIONS`（= 3）
3. Step 6 で連続失敗が発生しユーザーが中断を選んだ

それ以外の場合は `iteration += 1` して **Step 2 へ戻る**。

### Step 8: 最終レポート

以下を表示:

- 周回数（何周回したか / 上限到達か / ゼロで自然終了か）
- 各周で検出された 🔴 / 🟡 件数と修正した件数
- 修正した issue の一覧（ファイル + 一行説明）
- 🟢 参考扱い（score < 80）の一覧
- 最終の test / lint / build dryrun の結果
- 注意: **commit / push は行わない**。必要であればユーザーに `/commit` や
  `/ship` skill の利用を案内する

## Notes

- **`Agent` ツール呼び出しでは必ず `model` を明示する**:
  - Step 1.5a / 1.5b (事前コンテキスト): `model: "haiku"`
  - Step 2 (5 reviewer): `model: "sonnet"`
  - Step 3 (scoring): `model: "haiku"`
  - `model` 未指定だとデフォルトの軽量モデルが走り、公式プラグインとの品質差が
    顕著になる（この skill を作り直した主因）
- レビュー subagent には「build / typecheck は別途 CI で走るので、ここでは
  チェックしないし、それ由来の指摘はしない」と必ず伝えること
- `gh` コマンドは Step 2 #4 と Step 0 のフォールバックでのみ使用する
- このスキルは Agent Teams を使わない。並列化は Skill 内からの `Agent` ツール
  並列呼び出しで行う
- **使用コマンド一覧**（事前に `~/.claude/settings.json` の `permissions.allow`
  に登録すると実行時の確認を減らせる）:
  - Git (read-only): `git symbolic-ref`, `git fetch`, `git diff`, `git log`,
    `git blame`, `git show`（過去リビジョンのみ）
  - GitHub CLI (read-only): `gh repo view`, `gh pr list`, `gh pr view`
  - 検証（プロジェクトに応じて可変）: `yarn test`, `yarn lint`,
    `yarn build:dryrun`, `yarn <workspace> build:dryrun`。`npm test` /
    `pnpm test` 系の代替あり
  - 内部ツール（harness の設定で allow 済みなことが多い）: `Read`, `Edit`,
    `Write`, `Agent`, `AskUserQuestion`, `TaskCreate`
