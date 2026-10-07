---
name: land
description: レビュー済み PR をマージし、マージ後の CI（主にデプロイ）を監視して結果を報告、必要ならデプロイ先環境で動作確認し、関連 issue をクローズするまでを一括で行う。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Land: $ARGUMENTS

**使い方**: `/land [pr-number | pr-url] [--until=merge|deploy|verify|close] [--verify=auto|always|skip] [context]`

## Goal

レビューが済んだ PR を「マージされ、マージ後の CI / デプロイが成功したことが実体で確認され、必要な動作確認が済み、関連 issue が適切に閉じられた」状態にする。

これまで PR のレビュー完了後に「マージして」「デプロイ ci を監視して結果を教えて」「必要なら dev で動作確認して」「関連 issue を close して」とフリーテキストで毎回依頼していた定型フローの置き換え。

## いつ使うか

- レビューが通り CI も通過した（または実行中の）機能 PR / 修正 PR をマージして、デプロイ完了・issue クローズまで見届けたいとき（`/land`）
- マージとデプロイ監視だけしたいとき（`--until=deploy`）
- 既にマージ済みの PR について、デプロイ監視以降だけ進めたいとき（マージ済みなら Step 2 から再入する）

使わない場面:

- PR がまだない / 変更を PR にしたい → `ship`
- PR の CI が落ちている → `fix-ci`（CI が通過してから `/land`）
- レビュー指摘がまだ残っている → `fix-review` / `auto-fix-review`
- 統合ブランチ（develop）→ 本番ブランチ（main）のリリース PR → `release`（収録範囲の確定と back-merge が必要なため、本 skill では扱わない）

## 引数

| 引数 | 既定 | 意味 |
|---|---|---|
| `pr-number` / `pr-url` | 現在ブランチの PR | 対象 PR |
| `--until=merge\|deploy\|verify\|close` | `close` | どこまで進めるか。`merge`=マージまで / `deploy`=マージ後 CI の確認まで / `verify`=動作確認まで / `close`=関連 issue の処理まで |
| `--verify=auto\|always\|skip` | `auto` | 動作確認の要否。`auto`=Step 3 の基準で判断 / `always`=必ず実施 / `skip`=実施しない |
| `context` | なし | 動作確認の観点・issue に残すコメントの補足など |

フリーテキストで「マージして deploy を見ておいて」のように依頼された場合は、対応する `--until` として解釈する。

## ワークフロー

### Step 0: 対象 PR と慣例の確認

- 対象 PR の特定: 引数 → なければ `gh pr view --json number,url,state,baseRefName,headRefName`（現在ブランチの PR）。見つからなければ停止して聞く
- PR が既に `MERGED` なら Step 1 を飛ばして Step 2 から再入する。`CLOSED`（未マージ）なら停止
- **base が本番ブランチ（main 等）で、中身が統合ブランチからのリリースなら `release` を案内して停止する**（収録範囲の確認なしに本番へ出さない）
- 慣例を**推測せず実物から**確認する:
  - マージ方式: 同じ base への直近のマージ済み PR（`gh pr list --base <base> --state merged --limit 10 --json number,title,mergeCommit`）と、リポジトリで許可されている方式（`gh api repos/{owner}/{repo} --jq '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge, delete_branch_on_merge}'`）
  - **マージ後に走る workflow**: `.github/workflows/` のうち `on.push.branches` に base を含むもの・`workflow_run` で連鎖するもの。どれがデプロイで、**どの環境（dev / stg / prod）に出るか**
  - 動作確認先の環境 URL・ヘルスチェック・ログの見方: `CLAUDE.md` / `README` / `docs/` / workflow の `environment.url`
  - プロジェクト memory `~/.claude/projects/<slug>/memory/` に `project_*` があれば読む（`<slug>` はリポジトリの絶対パスの `/` と `.` を `-` に置換したもの）。**環境 URL・確認手順・issue クローズの慣例はここに蓄積されている**

### Step 1: マージ前の確認 → マージ

**マージの前提は「PR の CI が通過していること」**。`/land` はレビュー完了後に起動される前提なので、レビューの完了はユーザーの起動をもって判断し、CI の通過をこの skill が確かめる唯一のマージ条件とする。

#### CI の通過確認

- `gh pr checks <n> --json name,state,bucket,link` で head コミットの checks を取得する
  - 対象は**必須かどうかに関わらず PR 上のすべての checks**（GitHub Actions・外部 CI・Claude Code Review / Claude Approvals 等の check を含む）
  - 通過とみなすのは `bucket` が `pass` / `skipping` のもの。`fail` / `cancel` が 1 つでもあれば未通過
- **実行中（`pending`）のものがあれば完了まで待つ**: `gh pr checks <n> --watch --interval 30` をバックグラウンドで実行するか `Monitor` で待つ。待っている間に Step 0 の慣例確認や Step 3 の判断材料の読み込みを進める
- **未通過ならマージせずここで停止する**（`--until` に関わらず）。失敗した check と `--log-failed` から読み取れる原因を報告し、`fix-ci` での調査・修正を提案する。rerun・テストの skip・ブランチ保護の迂回でマージ可能な状態を作らない
- **check が 1 つもない**（CI 未設定のリポジトリ / まだ check が登録されていない）場合: push 直後で未登録の可能性があるので数十秒おきに数回見直す。それでも無ければ「CI なし」として、マージしてよいかユーザーに確認する（CI 通過の前提を満たせないため）
- 待っている間に head へ新しいコミットが push されたら、新しい head の checks で判定し直す

#### その他の状態確認

CI が通過したら、`gh pr view <n> --json isDraft,mergeable,mergeStateStatus` で次を確認する。満たさなければ、何が足りないかを報告して停止する（自分で approve したり、ブランチ保護を迂回したりしない）。

- draft でない / `mergeable` が `MERGEABLE`（コンフリクトがあれば停止）
- base の先行で PR が古くなっている（`mergeStateStatus` が `BEHIND`）場合、ブランチ保護が up-to-date を要求していなければそのままマージしてよい。要求していれば `gh pr update-branch <n>` → **新しい head で CI の通過確認からやり直す**
- 必須レビュー等のブランチ保護の条件は GitHub 側の判定に任せる。`gh pr merge` が保護ルールで拒否されたら、その理由を報告して停止する
- 未解決のレビュースレッドが残っていても停止はしないが、件数と概要を最終報告に含める

- マージ:
  - Step 0 で確認した**このリポジトリの慣例の方式**で `gh pr merge <n> --<squash|merge|rebase>`。慣例が読み取れなければ許可されている方式のうち squash を優先し、その旨を報告する
  - head ブランチの削除はリポジトリの `delete_branch_on_merge` か過去の慣例に従う（`--delete-branch`）
  - auto-merge やマージキューを運用しているリポジトリでは、それに乗せてマージ完了を待つ
- マージ後、`gh pr view <n> --json mergeCommit,mergedAt` で**マージコミットの SHA を控える**（Step 2 の起点）
- ローカルが当該ブランチにいれば base に切り替えて pull する
- `--until=merge` ならここで報告して終了

### Step 2: マージ後 CI（デプロイ）の監視

- マージコミットに紐づく run を特定する: `gh run list --commit <merge-sha> --json databaseId,name,status,conclusion,event,url`
  - push 直後は run がまだ作られていないことがある。数十秒おきに数回見て、それでも出なければ `gh run list --branch <base> --limit 5` で確認する
  - `workflow_run` で後段に連鎖する workflow（ビルド → デプロイ等）も対象に含める
  - **該当する workflow が 1 つもない**リポジトリ（マージ後 CI なし）なら、その旨を報告して Step 3 へ
- 完了待ちはバックグラウンドで行う: `gh run watch <run-id> --interval 20 --exit-status`、または `Monitor`。複数 run は並行して待つ。待っている間に Step 3 の判断材料（PR の差分・Test plan）を読んでおく
- 完了後、**成功の実体をログで確認する**（"success" 表示だけで終わらせない）:
  - デプロイ先の環境名と、成果物のバージョン（イメージタグ、Worker Version ID、ECS の `rolloutState=COMPLETED`、Lambda のバージョン等）
  - DB マイグレーションがあれば適用された / 差分なしで no-op だった
  - デプロイジョブが条件付きで **skip されていないか**（パスフィルタ・`if:` 条件で何もデプロイされていないケース）
- **失敗した場合はここで停止する**（`--until` に関わらず Step 3 以降へ進まない）:
  - 失敗したジョブ・ステップと、ログから読み取れる原因を報告する。**どのジョブまで進み、どれが skip されたか**を切り分け、「マイグレーションだけ適用されてアプリは旧版のまま」のような中途半端な状態かどうかを明示する
  - 次の手として ①`fix-ci` で原因調査・修正 ②再実行（一過性の外部要因が明らかな場合のみ）③revert PR、を影響範囲つきで提示し、**ユーザーの判断を仰ぐ**。デプロイ先環境に対する回復操作（revert・再デプロイ・ロールバック）を独断で実行しない
- `--until=deploy` ならここで報告して終了

### Step 3: 動作確認の要否判断と実施

#### 要否の判断（`--verify=auto`）

PR の内容（タイトル・本文・差分・Test plan）と**このセッションのやり取り**から判断し、**判断と理由を 1〜2 行で必ず報告する**（黙ってスキップしない）。

実施する（いずれかに該当）:

- ユーザーから見える挙動・UI・API のレスポンスが変わる
- 本番相当の環境でしか確かめられないもの: 環境変数 / Secrets / IAM・権限 / インフラ / 外部サービス連携 / DB マイグレーション / キャッシュ・CDN 設定
- バグ修正で、元の不具合がデプロイ先環境で観測・再現されていた
- PR の Test plan に未チェックの項目や「デプロイ後に確認」と書かれた項目がある
- このセッション中に「デプロイしたら確認する」「dev で見てみる」などの合意があった
- `context` 引数で確認観点が指定された

実施しない（すべてが該当）:

- ドキュメント・コメント・テストコードのみの変更、または振る舞いを変えないリファクタリング
- CI 設定や開発用ツールのみの変更（マージ後 CI の成功そのものが確認になる）
- 上の「実施する」のいずれにも当たらない

判断に迷う場合は実施側に倒す。ただし確認手段がない（後述）場合はユーザーに委ねる。

#### 実施

- **確認項目を先に列挙する**: PR の変更点・Test plan・元 issue の再現手順から、「何を・どこで・どうなっていれば OK か」を箇条書きにする
- 確認手段（環境で取れるものを使う）:
  - HTTP: `curl` でヘルスチェック・API のレスポンス・ステータスコード・ヘッダ
  - UI: Playwright でページを開いて操作し、スクリーンショットを取る（クラウドセッションでは Chromium がプリインストール済み。`playwright install` はしない）
  - ログ・メトリクス: CloudWatch Logs 等をデプロイ時刻以降で検索し、新規エラーが出ていないか（`aws logs filter-log-events` 等）
  - デプロイ成果物: 環境が実際に新しいバージョンを返しているか（バージョンエンドポイント・レスポンスヘッダ・タスク定義リビジョン）
- **読み取り系の確認を基本にする**。共有環境（dev / stg）でデータを作成・変更する操作が必要なら、内容を示して事前に確認を取る。**本番環境に書き込む操作は行わない**（必要ならスクリプトや手順を提示して実行はユーザーに委ねる）
- 認証情報・ネットワーク到達性がなく自分で確認できない項目は、**手動確認の手順（URL・操作・期待結果）をユーザーに渡す**。確認できていない項目を「確認済み」と書かない
- 結果は項目ごとに OK / NG / 未確認（理由）で、根拠（レスポンス抜粋・スクリーンショット・ログ）とともに報告する
- **NG があればここで停止する**。issue はクローズせず、`bugfix` での修正か `file-issue` での起票を提案して判断を仰ぐ
- `--until=verify` ならここで報告して終了

### Step 4: 関連 issue の処理

- 関連 issue の洗い出し（漏れなく、重複なく）:
  - `gh pr view <n> --json closingIssuesReferences,body` の closing 参照（`Closes #N` 等）
  - PR 本文の `#N` / `Refs #N` / issue URL、ブランチ名に含まれる issue 番号
  - このセッションの中で扱っていた issue
- **自動クローズの効き方を確認する**: closing キーワードによる自動クローズは**リポジトリの default branch へのマージでしか発動しない**。base が develop 等なら issue は開いたままなので、各 issue の現在の state を `gh issue view <N> --json state,stateReason` で確認する
- issue ごとに方針を決める:
  - **クローズする**: PR がその issue の内容を完了させている。`gh issue close <N> --reason completed --comment-file <path>`
  - **開いたままコメントだけ残す**: 一部対応（チェックリストに残りがある / 「part of」「段階 1」等）・本番反映が別途必要で、このリポジトリの慣例が「本番反映でクローズ」の場合
  - **触らない**: 参照しているだけで、この PR とは対応関係がない issue
  - どれに当たるか迷う issue は方針案を示してユーザーに確認する
- コメントを残す場合の内容（簡潔に。コメントは既に自動クローズされた issue にも、補足が有用なら残してよい）:
  - 対応した PR（URL）とマージコミット
  - デプロイ先の環境と結果（run URL）
  - 動作確認の結果（実施した / 不要と判断した理由 / ユーザーへ委ねた項目）
  - 残作業がある場合はその内容（本番リリース待ち等）
- コメント本文は**ファイル経由**で渡す（`--comment-file` / `--body-file`）
- issue 管理がリポジトリ外（Backlog 等）のプロジェクトでは、その管理ツールで同等の操作を行う。どのツールを使うか不明なら確認する

### Step 5: 最終報告

1 ブロックで報告する:

- PR（URL）/ マージ前の CI 結果 / マージ方式とマージコミット / 未解決のレビュースレッド（あれば）
- マージ後 CI: run URL・結果・デプロイ先とバージョン
- 動作確認: 実施有無とその理由、項目ごとの結果、ユーザーへ委ねた項目
- 関連 issue: クローズした / コメントのみ / 未処理、それぞれの理由
- 未完了・要対応の項目

## Notes

- **ユーザーゲートは Step 1 の CI 未通過・マージ不可時の停止と、Step 2・3 の失敗時の停止**。CI が通過してマージ可能であれば、`/land` の起動そのものをマージ・issue クローズの承認とみなして確認なしで進めてよい
- **base への直接 push・force push、ブランチ保護の解除は行わない**
- `gh` が使えない環境（クラウドセッション等）では、GitHub MCP ツール（`mcp__github__*`）で同等の操作を行う（PR の取得・マージ、Actions の run / job ログの取得、issue のコメント・クローズ）
- このセッションが PR の activity を購読していた場合（`subscribe_pr_activity`）、マージ後に購読を解除する
- 監視の待ち時間が長い workflow はバックグラウンド化し、待っている間に動作確認項目の洗い出しや issue コメントの下書きを進める
- 使用コマンド: `gh pr view/list/checks/merge/update-branch`, `gh run list/view/watch`, `gh issue view/close/comment`, `gh api`, `curl`, `aws`, Playwright
- 内部ツール: `Monitor`（CI・デプロイの完了検知）、`Skill`（fix-ci / bugfix / file-issue 呼び出し）

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「レビューは通っているので CI の完了を待たずにマージしてよい」 | CI 通過がこの skill のマージの前提。未完了・失敗のままマージすると base が壊れ、後続の全 PR に波及する。完了まで待つ |
| 「必須でない check の失敗だから無視してマージしてよい」 | 必須かどうかに関わらず、失敗している check があれば未通過として停止する。無視してよいかはユーザーが判断する |
| 「たぶん flaky なので rerun して通ったらマージ」 | 失敗の原因を確かめずに rerun しない。`fix-ci` で切り分ける |
| 「デプロイ run が success なので確認完了」 | パスフィルタや `if:` で肝心のジョブが skip されていても success になる。ログで実体を確認する |
| 「小さい変更なので動作確認は不要」 | 要否は変更の大きさではなく**種類**で決める。環境変数 1 つの追加でも環境依存の確認は要る。判断理由を必ず報告する |
| 「確認できなかったが、たぶん大丈夫なので OK と書く」 | 未確認は未確認と報告し、手動確認の手順を渡す |
| 「`Closes #N` と書いてあるから issue は勝手に閉じる」 | default branch 以外へのマージでは閉じない。state を実際に確認する |
| 「関連しそうな issue はまとめて閉じておく」 | 一部対応・参照だけの issue を閉じると残作業が消える。issue ごとに対応関係を確認する |
| 「デプロイが失敗したのでとりあえず revert する」 | 環境への回復操作は影響範囲を提示してユーザー判断を仰ぐ。独断で実行しない |

## 関連

- `ship` — PR 作成まで。本 skill の前段
- `fix-review` / `auto-fix-review` — レビュー指摘の反映。本 skill の前段
- `fix-ci` — マージ前 / マージ後の CI が落ちたときの原因調査と修正
- `release` — 統合ブランチ → 本番ブランチのリリース。本 skill でデプロイした変更を本番へ出す後段
- `bugfix` / `file-issue` — 動作確認で NG が出たときの修正・起票
