---
name: stack-issues
description: 親 issue の sub-issues を一括計画・実装し、1 issue 1 PR の Stacked PRs に積んで自動レビュー修正まで行う。確認事項は最初に一度だけまとめて聞く。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Stack issues: $ARGUMENTS

**使い方**: `/stack-issues <親 issue | issue の列> [--trunk <branch>] [--draft] [--revise=ask|yes|skip] [--until=plan|implement|revise|pr|review]`

例:

- `/stack-issues #20` — #20 の open な sub-issues をすべて対象にする
- `/stack-issues #2423 #2425 #2428` — 並べた順に下から積む（親 issue は問わない）
- `/stack-issues #15456 --trunk epic-campaign-detail-v2 --draft`

## Goal

親 issue の sub-issues を **1 issue 1 PR の Stacked PRs** として積み上げ、Claude Code Review の High / Medium 指摘が
解消された状態にする。これまで毎回、次のような定型の `/goal` 付きプロンプトで依頼していた流れの置き換え:

> issue#N について /goal open な sub-issues を以下の流れで全て対応してください。最終的に 1 issue 1 PR で Stacked PRs として積まれた状態としたいです。
> 1. 全ての sub-issues について /toraco:make-plan で実装を計画し、確認事項を都度ではなく初回でまとめて確認する。
> 2. 各 issue ごとに実装して各作業ブランチにて commit と push（PR は作成しない）
> 3. /toraco:revise-spec と /toraco:revise-tests は最後にまとめて実施し、対応するブランチにコミットを積む
> 4. Stacked PRs を作成
> 5. /toraco:auto-fix-review --stack でまとめて自動レビューと修正

この skill は数時間ほぼ無人で走ることを前提にしている。**ユーザーへの質問は Step 3 の一括確認に集約し**、
以降は「Safety notes」の停止条件に当たらない限り、完了条件を満たすまで止まらずに進める。
`/goal` と組み合わせる場合は、完了条件として本 skill の「完了条件」を満たすことを指定すればよい
（例: `/goal /toraco:stack-issues #20 を完了条件まで進める`）。

**マージはしない。** 人がレビューして Approve した後のマージ・デプロイ監視・issue クローズは `/land` で行う。

## いつ使うか

- 親 issue（epic）配下の sub-issues を、依存順に積んだ Stacked PRs としてまとめて出したいとき
- `/file-issue` で親 issue を sub-issues に分けた直後に、まとめて着手するとき

使わない場面:

- issue が 1 件だけ → `/make-plan issue#N` → `/ship` → `/auto-fix-review`
- 既に PR が積まれていて、レビュー対応だけしたい → `/auto-fix-review <PR> --stack`
- マージ以降 → `/land`

## Parameters

| 引数 | 既定 | 意味 |
|---|---|---|
| `<親 issue>` | 必須 | `#20` / `issue#20` / issue URL。1 件だけ指定して sub-issues があれば親 issue として扱う |
| `<issue の列>` | — | 2 件以上並べた場合は、その **順序どおりに下（trunk 側）から積む**。親 issue の解決は行わない |
| `--trunk <branch>` | 自動判定（Step 0-3） | stack の土台にするブランチ（`develop`、epic ブランチなど） |
| `--draft` | リポジトリの慣例 | PR を draft で作る |
| `--revise=ask\|yes\|skip` | `ask` | `/revise-spec` → `/revise-tests` の扱い。`ask`=Step 3 で確認 / `yes`=両方 `--yes` で実行 / `skip`=実行しない |
| `--until=...` | `review` | どこまで進めるか。`plan`=Step 3 まで / `implement`=Step 4 まで / `revise`=Step 5 まで / `pr`=Step 6 まで / `review`=Step 7 まで |

## 完了条件

次の **すべて** を満たしたら Step 8 の最終レポートを出して終了する（`--until` 指定時はその Step まで）。

1. 対象 issue ごとに作業ブランチが 1 本あり、実装・チェック済みで origin に push されている
2. 各ブランチは 1 つ下のレイヤー（最下層は `TRUNK`）の最新 head を祖先に含んでいる（`git merge-base --is-ancestor`）
3. `/revise-spec` / `/revise-tests` を選んだ場合、その結果が対応するレイヤーに commit・push されている
4. 対象 issue ごとに PR が 1 本あり、base が 1 つ下のレイヤーのブランチ（最下層は `TRUNK`）になっている
5. すべてのレイヤーで `/auto-fix-review` が SUCCESS（High / Medium の指摘なし）で終わっている

途中で「Safety notes」の停止条件に当たった場合は、そこで Step 8 に進み、どこまで済んだか・何が残っているかを報告する。

## 状態の記録と再開

長時間の実行や中断・再開、コンテキストの要約に備えて、状態をファイルに残す。

- 置き場所: `.git/stack-issues/<親 issue 番号 or 先頭 issue 番号>/`（`.git` 配下なので commit されない）
  - `state.md`: `TRUNK`、レイヤー表（順序・issue・ブランチ・head SHA・PR 番号・各 Step の状態）、一括確認の回答、`FOLLOWUP_SKILLS`
  - `plan-<issue>.md`: issue ごとの計画（Step 2 の出力）
- 各 Step の区切りで `state.md` を更新する。`TaskCreate` / `TaskUpdate` でも Step 0〜8 をタスクとして管理する
- 起動時に `state.md` があれば読み込み、**済んだ Step は飛ばして** 続きから再開する。リモートの実体
  （ブランチの有無・head SHA・PR の有無）と食い違っていれば、実体を正として `state.md` を直す

## Steps (obey strictly)

### Step 0: 初期化

1. **引数の解析**: 上記 Parameters に従う。issue 番号を正規化し、`owner/repo` は `git remote get-url origin` から得る。
2. **origin の取り込み**: `git fetch origin`（ネットワークエラー時は数秒おきに数回リトライ）。
   `git status --porcelain` が空でなければ、勝手に stash せず状況を報告して止まる。
3. **`TRUNK` の決定**（優先順）:
   1. `--trunk` の値
   2. 親 issue の本文・`CLAUDE.md` / `AGENTS.md` / `docs/` のブランチ戦略に、この epic 用の統合ブランチ（例: `epic-*`）が明記されている
   3. origin に `develop` がある → `develop`
   4. origin の default branch
   判断が割れる（epic ブランチらしきものがあるが明記がない等）ときだけ、**この時点で** `AskUserQuestion` で確認する
   （計画の前提になるため Step 3 まで待たない）。`TRUNK` が origin に存在しなければ止まって報告する。
4. **リポジトリの規定を読む**: `make-plan` Step 7-1 と同じ対象（`CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` /
   `docs/` / commitlint・hook 設定 / `.github/PULL_REQUEST_TEMPLATE*`）から、次を抽出して `state.md` に書く:
   - ブランチ命名規則、commit メッセージ規約、push 前に必須のチェック
   - PR テンプレート、draft にする慣例、issue の参照方法（`Refs #N` / `Closes #N`）
   - Stacked PRs の運用ルール（「レイヤーごとにマージしない」など）
   - 文書の推敲ルール（例: 「日本語の PR・issue は /yomiyasu で推敲してから保存する」）、本番操作の事前確認ルール
   規定があればそれに従い、本 skill の既定と食い違えば規定を優先する。
5. **ツールの可用性**（Step 6・7 の分岐に使う）:
   - `gh stack --help` が成功する → `HAS_GH_STACK = true`
   - `gh api graphql -f query='{viewer{login}}'` が成功する → `HAS_GRAPHQL = true`
     （クラウドセッションでは失敗する。README「gh-stack（Stacked PRs）」参照）
   - `NATIVE_STACK_POSSIBLE = HAS_GH_STACK && HAS_GRAPHQL`
6. **ブランチ名の接頭辞**: セッション側から作業ブランチが指定されている場合（クラウドセッションの
   `claude/<name>` など。push 先がそのブランチ配下に制限されていることがある）は、レイヤーのブランチを
   `<指定ブランチ>-<issue 番号>` にする。それ以外は 0-4 の命名規則、なければ `feature/<issue 番号>-<短い kebab-case>`。
7. `state.md` があれば「状態の記録と再開」に従って再開位置を決める。

### Step 1: 対象 issue とレイヤー順の確定

1. **対象 issue の取得**:
   - issue の列が指定された → その順のまま `LAYERS` 候補にする
   - 親 issue が指定された → sub-issues を取得し、**open のものだけ** を対象にする:
     ```bash
     gh api "repos/{owner}/{repo}/issues/<parent>/sub_issues" --paginate \
       --jq '.[] | {number, title, state}'
     ```
     （GitHub MCP の `issue_read`（`get_sub_issues`）でもよい）。sub-issues が 0 件なら、
     `/make-plan issue#<parent>` を案内して終了する
2. 各 issue の本文・コメント・ラベルを読む。次に当たるものは Step 3 の確認項目に回す（勝手に除外・続行しない）:
   - 既に open / merged の PR が紐付いている
   - 本文が薄く、何を作るか決められない
   - 他の issue と内容が重複している
3. **レイヤー順の推奨案を作る**（issue の列が指定された場合はその順を使い、この手順は行わない）:
   - GitHub の依存関係（`gh api "repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by"`）、本文中の
     「#N の後」「#N に依存」などの記述
   - 変更レイヤーの依存（DB / スキーマ → ドメイン → API → フロントエンド）。下のレイヤーが上のレイヤーの
     変更を前提にしない順にする
   - 決め手がなければ sub-issues の並び順
4. 6 レイヤーを超える場合は、レビューと conflict の負担が大きいことを Step 3 で伝え、分割（複数の stack にする）を選択肢に含める。

### Step 2: 全 issue の計画（質問はしない）

`LAYERS` の下から順に、issue ごとに `${CLAUDE_SKILL_DIR}/../make-plan/SKILL.md` の **Step 1〜6** に従って計画を立てる。

- `make-plan` の Step 0（ブランチの最新化）は Step 0 で済んでいるので行わない。コードは `origin/<TRUNK>` の状態を読む
  （作業ツリーが別ブランチなら `git switch --detach origin/<TRUNK>` してから読む）
- 2 層目以降は「下のレイヤーの計画が実装済みである」ことを前提にし、前提にした箇所を計画に明記する。
  下のレイヤーの計画と矛盾・重複する設計（同じテーブルを別々に変更する等）があれば、どちらで扱うかを決めて両方の計画に書く
- **ユーザーに質問しない。** `make-plan` の「ユーザーへの確認事項」は、issue ごとに **推奨案付き** で列挙して保留する。
  小さな仮定は仮定として明記して進める
- `make-plan` Step 2 の「後続スキル実行の確認」は issue ごとには作らない（Step 3 で 1 回だけ聞く）
- issue ごとの計画を `plan-<issue>.md` に保存する。計画には、マージ前・デプロイ前に人手で必要な作業
  （secret・環境変数・インフラ資源の作成、データ移行、外部サービスの設定など）も **「マージ前チェックリスト」** として必ず書く
- issue が 3 件以上ある場合は、issue ごとの計画を `Agent`（`model: "opus"`）に下から順に任せてよい。
  その場合は、下のレイヤーの計画の要約と上記のルールを渡し、返ってきた計画の整合性は親が確認する

`--until=plan` なら、計画の一覧と確認事項を提示して Step 8 へ進む（Step 3 の質問はしない）。

### Step 3: 一括確認（質問はここだけ）

Step 1・2 で保留した確認事項を、**1 回のまとまりとして** 聞く。

1. まず次の内容を 1 つのメッセージにまとめて表示する（ユーザーが離席中に読み返せるように）:
   - `TRUNK` とレイヤー順（下から）、各レイヤーの issue・ブランチ名・計画の要約（3〜5 行）
   - 各計画の仮定
   - 確認事項の一覧（番号付き、それぞれ推奨案と理由）
2. 続けて `AskUserQuestion` で聞く。1 回の呼び出しは 4 問までなので、多いときは **間を空けずに連続で** 呼ぶ。各問の先頭の選択肢を推奨案にし、ラベル末尾に「(推奨)」を付ける:
   - レイヤー順（推奨順 / 変更する）。Step 1-4 で分割を勧めた場合はその選択肢も含める
   - 各計画の確認事項（質問文には issue 番号を含める）
   - Step 1-2 で保留した issue の扱い（対象に含める / 外す / 別 issue に起票する など）
   - `--revise` が `ask` のとき: 実装完了後の `/revise-spec` → `/revise-tests`。選択肢は `make-plan` Step 2 と同じ
     （両方実行する（推奨） / 両方 `--yes` で実行する / `/revise-spec` のみ / 実行しない）。回答を `FOLLOWUP_SKILLS` にする
3. 回答を `state.md` と各 `plan-<issue>.md` に反映する。レイヤー順が変わったら、影響する計画の前提を見直す
   （見直しで新たな確認事項が出た場合に限り、もう一度だけ聞いてよい）。
4. 「別 issue に起票する」と答えたものがあれば、`/file-issue` の手順で起票し、親 issue の sub-issue に加える。

**これ以降、ユーザーへの質問は「Safety notes」の停止条件と、`/revise-*` を確認付きで実行すると決めた場合の質問に限る。**

### Step 4: レイヤーごとの実装（下から順に）

各レイヤー `i` について、計画と Step 3 の回答に従って実装する。

1. **ブランチを用意する**:
   - base は `i == 1` なら `origin/<TRUNK>`、それ以外は 1 つ下のレイヤーのブランチ
   - ブランチがまだなければ `git switch -c <branch> <base>`
   - ブランチが既にある（再開時）なら checkout し、`origin/<branch>` に fast-forward する。下のレイヤーの head を
     含んでいなければ、下記「下のレイヤーの変更を上に伝える」で取り込む
2. **実装する**: `plan-<issue>.md` の範囲だけを変更する。他の issue の範囲に属する変更が必要だと分かったら、
   その変更が属するレイヤーで行う（下のレイヤーなら、そこに commit して上に伝える）。
3. **チェックする**: Step 0-4 で確認した push 前チェック、なければ `/check` と同じ手順（テスト・リント・ビルド）を
   実行し、通るまで直す。直せない失敗は停止条件。
4. **commit する**: `make-plan` Step 7-3 と同じ規約に従う。commit メッセージや本文での issue 参照はリポジトリの慣例に合わせる。
5. **push する**: `git push -u origin <branch>`。PR は作らない。
6. head SHA を `state.md` に記録して次のレイヤーへ進む。

#### 下のレイヤーの変更を上に伝える

上のレイヤーを作った後で下のレイヤーに commit した場合は、上のレイヤーへ **merge で** 伝える。

```bash
# 下から順に、変更したレイヤーより上のすべてのレイヤーで
git switch <upper-branch>
git merge --no-edit <lower-branch>
# conflict が出たら解消し、そのレイヤーでチェックを通してから commit
git push origin <upper-branch>        # fast-forward の push になる
```

- **rebase・force push・`git reset --hard` はしない。** auto mode で拒否されるうえ、push 済みのブランチの履歴を書き換えると、
  PR ができた後では CI とレビューが全レイヤーで起動し直す
- conflict の解消では、両方のレイヤーの意図を残す。どちらかの変更を捨てないと解消できない場合は停止条件

`--until=implement` なら Step 8 へ。

### Step 5: `/revise-spec` → `/revise-tests` をまとめて実行し、対応するレイヤーに積む

`FOLLOWUP_SKILLS` が空なら飛ばす。stack 全体を 1 回で見直し、結果を変更が属するレイヤーに振り分ける。

1. **最上位のレイヤーで実行する**: 最上位のブランチから、ローカル専用の一時ブランチを切る
   （`git switch -c tmp/stack-issues-revise <最上位ブランチ>`。push しない）。`Skill` ツールで順に呼ぶ（並列にしない）:
   - `revise-spec`: `--mode=with-impl --base=<TRUNK>`、更新・追加した仕様ドキュメントのパス、`--yes`（選んだ場合）。
     完了したら変更を一時ブランチに commit する（`git add -A && git commit -m "tmp: revise-spec"`）。変更がなければ commit しない
   - `revise-tests`: `--base=<TRUNK>`、`--yes`（選んだ場合）。完了したら同様に `tmp: revise-tests` として commit する
   どちらのスキルも自分では commit しないので、spec とテストの変更がこの 2 つの一時 commit に分かれる。
   新規ファイルも `git add -A` で拾えるため、振り分けの材料が漏れない。
2. **変更をレイヤーに振り分ける**: `git diff --name-status <最上位ブランチ> tmp/stack-issues-revise` の変更ファイルごとに、属するレイヤーを決める:
   1. 計画（`plan-<issue>.md`）で、その仕様・テストの対象として挙がっている機能を実装したレイヤー
   2. 決められなければ、`git log --format=%H origin/<TRUNK>..<最上位ブランチ> -- <file>` で、そのファイル（新規テストなら、
      テスト対象の実装ファイル）を変更したレイヤーのうち **最も上のもの**
   3. どのレイヤーも変更していない既存ファイルの修正は、その修正が前提とする機能を実装したレイヤー
   1 ファイルの中で複数のレイヤーにまたがる変更は、分けずに最も上のレイヤーに寄せる。
3. **下のレイヤーから順に commit する**: 変更があるレイヤーごとに、一時 commit の差分のうち
   そのレイヤーのファイルだけを当てる（`SPEC` = `tmp: revise-spec` の commit、`TESTS` = `tmp: revise-tests` の commit）:
   ```bash
   git switch <layer-branch>
   git diff --binary SPEC~1 SPEC -- <そのレイヤーのファイル...> | git apply --3way
   # チェックを通して commit（仕様の見直し）
   git diff --binary TESTS~1 TESTS -- <そのレイヤーのファイル...> | git apply --3way
   # チェックを通して commit（テストの見直し）
   git push origin <layer-branch>
   ```
   続けて「下のレイヤーの変更を上に伝える」で上のレイヤーへ merge する。最後に最上位ブランチで
   `git diff <最上位ブランチ> tmp/stack-issues-revise` が空であること（見直しの結果がすべて入ったこと）を確かめてから、
   一時ブランチを `git branch -D tmp/stack-issues-revise` で消す。
4. 両スキルの最終レポートにある **実装側への受け渡しリスト**（`impl-fix` 等）は自動では直さない。Step 8 で報告する。

`--until=revise` なら Step 8 へ。

### Step 6: Stacked PRs の作成

1. **PR の本文を用意する**（レイヤーごと）:
   - PR テンプレートがあればその構成に沿う。なければ `## Summary` / `## Test plan` を含める
   - issue の参照はリポジトリの慣例に従う。慣例がなければ `Refs #<issue>` と `Refs #<parent>` にする。
     `Closes #N` は base が default branch の PR でしか自動クローズされないため、上のレイヤーでは効かないことに注意する
   - 「この PR は Stacked PRs の第 i 層」であることと、stack 全体の表（下から順の issue・PR・ブランチ）を入れる。
     PR 番号は全 PR の作成後に埋める
   - そのレイヤーの「マージ前チェックリスト」（Step 2）を入れる
   - Step 0-4 で推敲ルールがあれば、保存前にそれに従う
2. **PR を作る**:
   - `NATIVE_STACK_POSSIBLE` なら、GitHub ネイティブの stack として作る。`gh stack --help` で使えるサブコマンドを確かめ、
     `gh stack init --base <TRUNK> <下から順のブランチ...>` で追跡を始めてから、`gh stack submit` で PR を作成する
     （既に PR を作った場合は `gh stack link` で stack にする）。失敗したら下の方法に切り替える
   - それ以外（クラウドセッションなど）は、下から順に base をつないだ PR を作る。PR の作成には
     `mcp__github__create_pull_request` を使う（base = 1 つ下のレイヤーのブランチ、最下層は `TRUNK`）。
     この場合、作られるのは **ネイティブの stack ではない**ことを Step 8 で報告する
   - `--draft` 指定時、またはリポジトリで draft にする慣例があれば draft にする
3. 全 PR の番号が確定したら、各 PR の本文の stack 表を更新する。
4. PR の `stack` を確認する: `gh api "repos/{owner}/{repo}/pulls/<最下層の PR>" --jq '.stack'`。
   値があれば `IS_NATIVE_STACK = true`。

`--until=pr` なら Step 8 へ。

### Step 7: 自動レビューと修正

- `IS_NATIVE_STACK = true`: `Skill` ツールで `auto-fix-review` を `args: "<最下層の PR> --stack"` で呼ぶ。
  レイヤーごとの修正と最後の 1 回の cascade は `auto-fix-review` が行う
- `IS_NATIVE_STACK = false`（base をつないだだけの PR）: `auto-fix-review` の `--stack` は効かないので、本 skill が
  下から順にレイヤーを回す:
  1. 1 つ下のレイヤーが前回の伝播以降に進んでいれば、「下のレイヤーの変更を上に伝える」でこのレイヤーに merge して push する
     （レビューの前に済ませ、修正後の下のレイヤーを含んだ状態でレビューを受ける）
  2. `Skill` ツールで `auto-fix-review` を `args: "<このレイヤーの PR>"` で呼ぶ
  3. SUCCESS 以外で終わったら、上のレイヤーには進まず Step 8 へ
  この順序で回せば、修正が上のレイヤーへ伝わるのは各レイヤーにつき 1 回で、レビューの連鎖が起きない
- どちらの場合も、`auto-fix-review` の終了ステータスとレイヤーごとの結果を `state.md` に記録する

### Step 8: 最終レポート

1 つのブロックで次を報告する。

- **完了条件の達成状況**（1〜5 のそれぞれ、達成 / 未達と理由）。停止した場合は停止した Step・理由・再開方法
  （同じ引数で `/stack-issues` を再実行すれば `state.md` から再開できる）
- **stack の構成**（下から順）: レイヤー・issue・ブランチ・PR（URL）・draft か・`auto-fix-review` の結果。
  ネイティブの stack か、base をつないだだけの PR か
- Step 3 で確定した方針と、計画上の仮定
- `/revise-*` の結果: 振り分けた commit（レイヤーごと）と **実装側への受け渡しリスト**
- **マージ前チェックリスト**: 各計画から集めた人手の作業（secret・環境変数・インフラ資源・データ移行など）。
  本番に書き込む作業は実行していないことを明記する
- **マージの案内**:
  - 人がすべてのレイヤーをレビューして Approve してから、**stack をまとめて 1 回でマージする**（レイヤーごとにマージしない）。
    ネイティブの stack なら `gh stack merge <最上位の PR>` または UI のマージ
  - base をつないだだけの PR の場合: GraphQL が使える環境（ローカルなど）で `gh stack init --base <TRUNK> <下から順のブランチ...>`
    → `gh stack link` で stack にしてからマージする手順を示す
  - マージ後は `/land` でデプロイ監視・動作確認・sub-issues と親 issue のクローズまで行える

## Safety notes

- **止まる条件**（Step 8 に進んで報告する。勝手に回避しない）:
  - チェック（テスト・リント・ビルド）の失敗を、計画の範囲内の修正で直せない
  - conflict を、どちらかのレイヤーの変更を捨てずに解消できない
  - 計画の前提が実装中に崩れ、Step 3 で確定した方針を変えないと進めない
  - push が拒否された（権限・ブランチ保護・non-fast-forward）
  - `auto-fix-review` が SUCCESS 以外で終わった
- **しない操作**: force push、`git reset --hard`、push 済みブランチの rebase、`gh stack sync`、PR のマージ、
  issue のクローズ、本番環境への書き込み（secret・インフラ資源の作成を含む）、ユーザーの未 commit 変更の stash・破棄
- ネイティブの stack では、`auto-fix-review` の Safety notes にある「Stacked PRs で禁止する操作」も守る
- PR・issue・コメントへの投稿は、Step 0-4 で確認したリポジトリの規定（推敲ルール・言語）に従う

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「issue ごとに計画を立てたらその都度確認しよう」 | 無人で走らせる前提が崩れ、離席中に止まる。確認は Step 3 にまとめる |
| 「下のレイヤーを直したので上を rebase して force push」 | auto mode で拒否されるうえ、PR 作成後は全レイヤーの CI・レビューが起動し直す。merge で伝える |
| 「revise はレイヤーごとに回そう」 | 起点の差分に下のレイヤーが混ざり、同じ指摘が何度も出る。最上位で 1 回だけ回して振り分ける |
| 「base をつないだ PR でも `--stack` で回せる」 | `auto-fix-review` は `stack` が `null` の PR を stack として扱わない。Step 7 の手順で下から回す |
| 「レビューが通ったのでマージまで進めよう」 | マージは人の Approve の後。`/land` に任せる |

## 関連

- `make-plan` — issue ごとの計画の手順（Step 1〜6）とブランチ・commit の規約（Step 7）
- `revise-spec` / `revise-tests` — `--base=<TRUNK>` で stack 全体を見直す
- `auto-fix-review` — `--stack` でネイティブの stack のレビュー修正と cascade
- `file-issue` — 親 issue を sub-issues に分ける・保留した事項を起票する
- `land` — stack のマージ後のデプロイ監視・issue クローズ
