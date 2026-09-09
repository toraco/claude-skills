---
name: release
description: 統合ブランチ(既定 develop)の内容を本番ブランチ(既定 main)へ反映する。収録範囲の確定 → release ブランチと PR 作成 → CI 確認 → マージ → 本番デプロイ CI 監視 → back-merge・後片付けまでをカバーする。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Release: $ARGUMENTS

**使い方**: `/release [--until=pr|merge|deploy|backmerge] [--exclude=<#PR|#issue|...>] [--from=develop] [--to=main] [context]`

## Goal

統合ブランチに溜まった変更を「収録範囲が確定し、リリースブランチと PR になり、CI を通ってマージされ、本番デプロイが成功したことまで確認された」状態にする。

これまで「develop から main へリリースする release ブランチと PR を作成して。ci が通ったらマージして prod デプロイ ci を確認」とフリーテキストで毎回依頼していた定型フローの置き換え。複数のリポジトリで手順がほぼ共通。

**この skill の本体は Step 1 の「収録範囲の確定」**。develop 全体を意図せず main に載せてしまう事故が過去に複数回あり、そこが最大の防御ポイント。

## いつ使うか

- 溜まった develop の変更を本番へ出したいとき（`/release`。既定でマージ・本番デプロイ確認まで進む）
- 一部の PR / issue の変更だけを除外して出したいとき（`--exclude`）
- リリース PR だけ先に作っておきたいとき（`--until=pr`）
- 既に作った PR のマージ以降（デプロイ監視・back-merge）だけ進めたいとき（`--until=deploy` 等で再入）
- リリース内容の妥当性（何が載るか・DB マイグレーションの有無・prod 側の事前準備）を検査だけしたいとき（`--until=pr` の Step 1 まで）

使わない場面:

- 機能ブランチ → develop の通常 PR → `ship` / `create-pr`
- リリース PR の CI が落ちた原因調査 → `fix-ci`（本 skill の Step 5 から呼ぶ）
- デプロイ後のリモート環境での機能動作確認そのもの → リリースの範囲外。別途依頼する

## 引数

| 引数 | 既定 | 意味 |
|---|---|---|
| `--until=pr\|merge\|deploy\|backmerge` | `deploy` | どこまで進めるか。`pr`=PR 作成まで / `merge`=マージまで / `deploy`=本番デプロイ CI 確認まで / `backmerge`=back-merge と後片付けまで |
| `--exclude=<#PR\|#issue\|...>` | なし | 収録から除外する PR / issue。指定時は Mode B（選択的 cherry-pick）になる |
| `--from` | `develop` | リリース元の統合ブランチ |
| `--to` | `main` | リリース先の本番ブランチ |
| `context` | なし | リリース PR の description に反映する補足（対象 issue・背景・注意事項など） |

既定は `deploy`。**無指定でもマージして本番に出るところまで進む**ので、Step 1 の収録一覧の確認と Step 5 のマージ前の確認が、本番へ出る前の唯一のユーザーゲートになる。この 2 つは `--until` の指定に関わらず必ず行う。

フリーテキストで「ci が通ったらマージして prod デプロイ ci を確認」のように依頼された場合は、対応する `--until` として解釈する。PR だけ作って止めたい旨が読み取れる場合は `--until=pr` として扱う。

## ワークフロー

### Step 0: 慣例の学習

このリポジトリのリリース慣例を**推測せず実物から**確認する。

- `git fetch origin --prune`
- 過去のリリース PR: `gh pr list --base <to> --state merged --limit 10 --json number,title,headRefName,mergedAt` → ブランチ命名（`release/YYYYMMDD`、同日 2 回目は `-2` 等）・タイトル慣例（絵文字 prefix の有無）・PR 本文の構成を踏襲する
- プロジェクト memory `~/.claude/projects/<slug>/memory/` に `project_release_*` があれば読む。`<slug>` は**リポジトリの絶対パスの `/` と `.` を `-` に置換**したもの（`/Users/me/dev/widget` → `-Users-me-dev-widget`）。`ls ~/.claude/projects/ | grep <リポジトリ名>` で確認できる。**リポジトリ固有の落とし穴（lockfile 競合の解消手順・back-merge 方針・マージ方式の制約）はここに蓄積されている**
- `CLAUDE.md` / `.github/PULL_REQUEST_TEMPLATE.md` / `.github/workflows/` を確認し、**どの workflow が本番デプロイか**、**DB マイグレーションがどこで適用されるか**（CI か、コンテナ起動時の entrypoint か）を特定する
- ブランチ保護 / ruleset / auto-merge の設定（`gh pr view` の `autoMergeRequest`、`gh api repos/{owner}/{repo}/rulesets`）

### Step 1: 収録範囲の確定（最重要）

- 差分の把握は **log と tree の両方**を見る。片方だけでは足りない:
  - コミット: `git log --oneline --no-merges origin/<to>..origin/<from>`
  - 実差分: `git diff --stat origin/<to> origin/<from>`（**2 点**）
  - `...`（3 点）は merge-base からの差分なので、squash マージのリポジトリでは**既リリース分まで差分に見える**。収録範囲の判断には 2 点を使う
- **log と tree が食い違ったら tree を信じる**。log に出るのに tree に差分が無いコミットは、既にリリース済みで履歴だけが乖離している（squash マージ / back-merge 省略）
- 既リリース分の切り分けは、確実な根拠から順に当たる:
  1. **前回リリース PR の本文**（`gh pr view <前回リリース PR 番号> --json body`）。収録した PR 番号が列挙されているので最も確実。番号は Step 0 で取った過去リリース PR 一覧から引く
  2. **tree 差分**（`git diff --name-only origin/<to> origin/<from>`）に現れないファイルしか触っていないコミットは既リリース分
  3. PR 番号の集合差: `git log --format='%s' origin/<to> | grep -oE '\(#[0-9]+\)$' | tr -d '(#)' | sort -u` と `<from>` 側の集合を `comm` で比較。**ただしリリース PR 自体が squash マージされるリポジトリでは `<to>` 側に機能 PR の番号が残らず空振りする**。1 と 2 で裏を取ること
- 各コミットを PR / issue に対応付け、以下を**個別に洗い出す**:
  - **DB マイグレーション**の有無（`prisma/migrations/` `drizzle/` 等の差分。無ければ「no-op」と明示）
  - **インフラ変更**（`cdk/` `terraform/` `wrangler.toml` 等）とそれに伴う**ダウンタイム**の可能性
  - **環境変数 / Secrets の追加**（prod 側に事前投入が必要なもの。**PR を出す前に**ユーザーへ提示する）
  - 破壊的変更・切り戻しが効かない変更
- **収録一覧をユーザーに提示して確認を取る**（PR 番号 / issue / 内容 / 上記の注意点の表）。ここを飛ばさない。**これは確認用の表で、PR 本文の表とは別物**（PR 本文の形式は Step 4 に従う）。issue が紐づかない PR は issue 欄を `-` にする
- `--exclude` 指定時: 除外対象のコミットを特定し、**依存関係**を確認する（除外対象に依存する後続 PR がないか）。見るのは 3 種類:
  - **コード依存**: 除外対象が追加した識別子 / ファイルを後続が参照していないか（`git grep -l <識別子> origin/<from>`）
  - **データ依存**: 除外対象のマイグレーションが作るカラム / テーブルを後続が読み書きしていないか
  - **設定依存**: 除外対象が追加した環境変数 / Secrets を後続が読んでいないか
  依存があれば「**除外対象を広げて依存側もまとめて次回に回す** / 除外せずそのまま出す / フラグで無効化する」の選択肢を提示して判断を仰ぐ（除外対象を広げるのが最も安全。リリース作業の範囲でコードを書き足さずに済む）。**依存によって除外対象が増えるときは、増えた分を含む最終的な収録一覧を 1 回でまとめて提示する**（波及のたびに小出しにしない）

### Step 2: リリースブランチの作成

同名の release ブランチが既に `origin` にある場合（再入・やり直し）は、作る前に次を判定する:

- **そのブランチで PR が既に開いている** → 新規に作らず**その PR を使って続きから再入する**（`--until` の続き）
- **PR は無く、内容が今回作るものと一致する** → そのまま使う（`git push` が `Everything up-to-date` になる）
- **PR は無く、内容が違う** → **force push も削除もしない**。`release/YYYYMMDD-2` のように連番を足して新規に作り、古いブランチをどうするかはユーザーに確認する

再入のときも **Step 1 の収録範囲の確認はやり直す**（中断中に `<from>` へコミットが積まれていることがある）。Step 0 の慣例学習は、既存のブランチ / PR がその慣例に沿っている限り省略してよい。

**Mode A: 全量リリース（除外なし）**

- `git switch -c release/YYYYMMDD origin/<from>`
- tree が `origin/<from>` と完全一致していること（差分ゼロ）を確認

**Mode B: 選択的リリース（`--exclude` あり）**

- `git switch -c release/YYYYMMDD origin/<to>` して収録コミットのみ `git cherry-pick -x <sha>` を順に適用
- コンフリクトしたら**そこで止めて**内容を提示する。強引に解決しない
- 収録の検証（取りこぼし・混入の両方向）:
  - `git diff --name-only origin/<from> HEAD` が、「**除外コミットが触ったファイル**」と「**`<to>` が `<from>` より先行している分のファイル**」の和集合に収まること。それ以外が出たら取りこぼしか混入
  - 後者（`git diff --name-only origin/<from> origin/<to>` で出る）を勘定に入れ忘れると、**back-merge していない hotfix があるリポジトリでは必ず false positive になる**
  - 除外した機能の識別子（フラグ名・関数名・spec ファイル名）を `git grep -l <sig> HEAD` / `git grep -l <sig> origin/<from>` で数え、release 側が 0 であること

**両モード共通**

- `git merge-tree --write-tree origin/<to> HEAD` で**マージ前に**コンフリクト有無を確認する
- **lockfile（`pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`）の競合は手マージしない**。`git checkout --ours <lockfile>` で release 側（= いま居るブランチ = `HEAD` 側。cherry-pick でも merge でも `--ours` が release ブランチ側）を採用 → `pnpm install --lockfile-only` 等で再生成 → `git add`
- `package.json` など**手書きの依存定義が同時にコンフリクトしたら、そちらを先に手で正しくマージしてから** lockfile を再生成する。両側の依存の**和集合**になっているか確認する（片側を捨てると、そこから再生成した lockfile ごと壊れる）。**同じパッケージで版が食い違うときは `<to>` 側の版を採る**（`<to>` の版は既に本番で動いており、hotfix のセキュリティ更新を巻き戻さないため）
- `git push -u origin release/YYYYMMDD`

### Step 3: ローカル検証

Mode B、またはコンフリクト解消・lockfile 再生成をした場合は**必須**（cherry-pick の組み合わせは develop 上で一度も検証されていない）。Mode A で `<from>` tip と**同一コミット**（`git rev-parse HEAD` == `git rev-parse origin/<from>`）なら、その状態は既に `<from>` の CI で検証済みなので省略してよい。**tree だけ一致していてコミットが違う場合は省略しない**（検証されていない組み合わせである可能性がある）。

- プロジェクトの lint / test / build:dryrun（コマンドは `package.json` / `CLAUDE.md` から確認）

### Step 4: リリース PR の作成

- `gh pr create --base <to> --head release/YYYYMMDD --title "..." --body-file <path>`（本文はヒアドキュメントやシェル引数に直書きせずファイル経由）
- 本文の構成は**過去のリリース PR の実物を優先**する。`.github/PULL_REQUEST_TEMPLATE.md` は機能 PR 向けでリリース PR 用でないことが多く、両者が食い違うときは過去のリリース PR に合わせる
- 本文に必ず含める:
  - **収録した変更**の表（列は過去のリリース PR に合わせる。前例が無ければ PR 番号 / 内容）
  - **DB マイグレーションの有無**（無い場合も「差分なし・no-op」と明記）
  - **prod 側の事前準備**（Secrets / 環境変数 / 手動オペ）と**その実施状況**。**自分で実施していないものを「実施済み」と書かない**。未実施なら「要対応（マージ前）」として投入コマンド例を添え、実行はユーザーに委ねる。過去のリリース PR 本文をテンプレとして流用するとき、実施状況の文言まで機械的に踏襲しない
  - **除外したもの**とその理由（Mode B のとき）
  - 切り戻し方針
- `--until=pr` ならここで PR URL を報告して終了

### Step 5: CI 確認 → マージ

- `gh pr checks <n> --watch --interval 30` をバックグラウンド実行、または `Monitor` で完了を待つ（長い workflow を前景で待たない）
- **マージ前に、PR 本文の「prod 側の事前準備」で「要対応」としたものが完了しているかを確認する**。Secrets の投入有無のように自分では確認できない項目は、**「投入済みか確認してください」とユーザーに明示して回答を待つ**。未完了のままマージすると、デプロイ直後に本番が壊れる
- **失敗したら `fix-ci` skill に渡す**。テストの skip や緩和で通そうとしない
- マージ:
  - **merge commit でマージする: `gh pr merge <n> --merge --delete-branch`**
  - **squash は使わない**。squash は `<to>` 側に親リンクの無いコミットを作るため `merge-base` が前進せず、次回以降のリリースで add/add コンフリクトを誘発する（実測済み）
  - リポジトリ側で auto-merge が設定済みなら、マージ完了の検知だけ行う
- マージ後、`git merge-base --is-ancestor origin/<to> origin/<from>` 等で履歴が期待どおりか確認

### Step 6: 本番デプロイ CI の監視

- `gh run list --branch <to> --limit 5 --json databaseId,name,status,conclusion,headSha,createdAt` でマージコミットに対応する run を特定
- `gh run watch <run-id> --interval 20 --exit-status` をバックグラウンドで待つ
- 完了後、**成功の実体をログで確認する**（"success" の表示だけで終わらせない）:
  - マイグレーションが適用された / 差分なしで no-op だった
  - デプロイ成果物のバージョン（Worker Version ID、ECS の `rolloutState=COMPLETED`、タスク定義リビジョン等）
- **失敗した場合**: ログから原因を特定し、①切り戻し（revert PR）② hotfix ③再実行、の選択肢を影響範囲つきで提示して**ユーザーの判断を仰ぐ**。本番に対する回復操作を独断で実行しない
  - **`--until` の指定に関わらず、失敗時はここで停止する**（`--until=backmerge` でも back-merge へ進まない）
  - **どのジョブまで進み、どのジョブがスキップされたかを切り分けて報告する**。「マイグレーションだけ適用されてアプリは旧版のまま」のような**中途半端な状態が最も危ない**ので、アプリ側と DB 側を分けて書く
  - マイグレーションが失敗したときは、**本番 DB が今どうなっているかを推定で断定しない**。適用状況を確認する SQL / コマンドを提示し、実行はユーザーに委ねる（Prisma なら `_prisma_migrations` の当該行と、対象スキーマの実体）。**失敗記録が残っている限り次回以降のリリースも同じ所で止まる**ことも併せて伝える
- `--until=deploy`（既定）ならここで報告して終了

### Step 7: back-merge と後片付け

このリポジトリの運用で back-merge を行っているか（Step 0 の memory / 過去 PR）を確認してから実施する。

- `git switch -c release/YYYYMMDD-backmerge origin/<from>`
- `git merge -s ours origin/<to> -m "chore: <to> を <from> へ取り込む（release/YYYYMMDD の back-merge）"`
- **検証（4 点すべて）**: `git diff origin/<from> HEAD` が 0 行 / `HEAD^{tree}` == `origin/<from>^{tree}` / `origin/<to>` が HEAD の祖先 / 収録ファイル数が想定どおり
- push して `--base <from>` で PR 作成。ここも **merge commit でマージ**
- 後片付け: ローカルの release ブランチ削除、`<from>` を pull、`git fetch --prune`
- リリース内容（日付 / PR 番号 / 収録 PR / 除外 / デプロイ結果 / 遭遇した問題）を `~/.claude/projects/<slug>/memory/project_release_YYYYMMDD.md` に記録し、`MEMORY.md` に 1 行追加する

### Step 8: 最終報告

リリース PR URL / 収録した変更 / CI 結果 / マージコミット / デプロイ run URL と結果 / back-merge PR / 未完了の項目、を 1 ブロックで報告する。

## Notes

- **`--to`（本番ブランチ）への直接 push・force push は一切行わない**。すべて PR 経由
- リリース PR 本文・commit メッセージは**ファイル経由**で渡す（`--body-file`）。長文をシェル引数に直書きするとクォート事故になる
- ブランチ保護 / ruleset が back-merge PR を阻む場合がある。**ruleset の一時解除は必ずユーザーに承認を求め**、変更前の JSON をバックアップし、マージ後に復元して差分ゼロを照合するまでを 1 セットで行う
- 本番 DB / 外部 SaaS への直接の書き込みオペレーションが必要なら、**スクリプトを生成して提示するに留め、実行はユーザーに委ねる**
- 監視の待ち時間が長い workflow ではバックグラウンド化し、待っている間に次の準備（PR 本文・back-merge ブランチ）を進める
- 使用コマンド: `git fetch/log/diff/switch/cherry-pick/merge/merge-tree/push/grep`, `gh pr list/view/create/checks/merge`, `gh run list/view/watch`, `gh api`
- 内部ツール: `Monitor`（CI・デプロイの完了検知）、`Skill`（fix-ci 呼び出し）

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「develop の内容をそのまま出すだけだから収録一覧の確認は不要」 | 未リリースだと思っていた変更が混ざる事故が実際に複数回発生している。**必ず一覧を出してユーザー確認を取る** |
| 「`origin/main..origin/develop` が未リリース分そのもの」 | back-merge 省略や squash マージのリポジトリでは成立しない。**tree 差分（2 点 diff）を正とし、前回リリース PR の本文で裏を取る**。PR 番号の集合差は `<to>` 側が squash されていると空振りする |
| 「squash の方が履歴がきれい」 | merge-base が凍結し、次回リリースで add/add コンフリクトになる。リリース PR は merge commit 固定 |
| 「lockfile の競合は手で直せば速い」 | 依存解決の整合性が壊れる。片側採用 → 再生成が正攻法 |
| 「CI が success なので中身は見なくてよい」 | マイグレーション未適用やデプロイの空振りが success で通ることがある。ジョブログで実体を確認する |
| 「デプロイが失敗したのでとりあえず revert する」 | 本番の回復操作は影響範囲を提示してユーザー判断を仰ぐ。独断で実行しない |
| 「除外指定の PR だけ cherry-pick から外せばよい」 | 依存する後続 PR がビルド不能・機能不全になる。依存関係を先に確認する |

## 関連

- `ship` — 機能ブランチ → develop の通常フロー。リリースの前段
- `fix-ci` — リリース PR / デプロイ CI が落ちたときの原因調査と修正
- `file-issue` — リリース後に観測した副次的問題の起票
