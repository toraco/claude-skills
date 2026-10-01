---
name: garden-deps
description: Renovate が自動マージしない依存更新と Renovate 管轄外の依存をまとめて棚卸し・追従修正・検証し、統合ブランチ向けの 1 本の PR にする。dev 反映確認と release への引き継ぎまで扱う。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Garden deps: $ARGUMENTS

**使い方**: `/garden-deps [--until=plan|pr|dev|release] [--auto] [--only=<#PR|pkg,...>] [--skip=<#PR|pkg,...>] [--base=develop] [context]`

## Goal

溜まった依存更新を「棚卸しされ、採否が根拠つきで決まり、採用分が追従修正込みで 1 本の PR に載って CI を通り、見送り分は理由とともに次回へ引き継がれた」状態にする。`--until` に応じて、dev 環境への反映確認と本番リリース（`release` skill）への引き継ぎまで進める。

月次で手作業していた「Renovate の手動レビュー PR を順にマージ → 破壊的変更に追従 → dev で確認 → develop から main へリリース」の置き換え。Renovate は patch や devDeps の minor を自動マージするので、**この skill の対象は Renovate が人に残したものと、Renovate がそもそも見ていないもの**。

**この skill の本体は Step 2 の影響調査**。バージョン番号だけで「minor だから安全」と判断せず、リリースノートの破壊的変更とこのリポジトリでの使われ方を突き合わせる。

## いつ使うか

- 定期のパッケージガーデニング（`/garden-deps`。既定は PR 作成まで）
- Routine（クラウドの定期実行）から無人で回す（`--auto`。PR 作成までで止まる）
- 溜まっている依存更新の量と危険度を見積もりたいとき（`--until=plan`。何も書き込まない）
- 作ったガーデニング PR の続き（develop へのマージ → dev 確認 → リリース PR）を進めたいとき（`--until=dev` / `--until=release` で再入）
- セキュリティ更新など特定の更新だけ急いで出したいとき（`--only`）

使わない場面:

- Renovate 自体の導入・設定変更 → `setup-renovate`
- develop から main へのリリースそのもの → `release`（本 skill の Step 6 から呼ぶ）
- ガーデニング PR の CI が落ちた原因調査 → `fix-ci`

## 引数

| 引数 | 既定 | 意味 |
|---|---|---|
| `--until=plan\|pr\|dev\|release` | `pr` | どこまで進めるか。`plan`=棚卸しと採否判定まで（書き込みなし）/ `pr`=ガーデニング PR 作成と CI 確認まで / `dev`=PR を統合ブランチへマージして dev デプロイ確認まで / `release`=`release` skill でリリース PR 作成まで |
| `--auto` | false | 無人実行。ユーザー確認を挟まず、判断は PR 本文と記録 issue に残す。**`--until` は `pr` が上限**（マージを伴う段へは進まない） |
| `--only` | なし | 対象をこの PR 番号 / パッケージ名に絞る |
| `--skip` | なし | 対象から外す PR 番号 / パッケージ名 |
| `--base` | Renovate の `baseBranches`（無ければ `develop`） | ガーデニング PR のマージ先（統合ブランチ） |
| `context` | なし | 今回の方針の補足（「major は見送り」「nodemailer は今回やる」など） |

## ワークフロー

### Step 0: 前提の確認と再入判定

- `git fetch origin --prune`。作業は `--base` の最新から切った worktree かクリーンな作業ツリーで行う。未 commit の変更がある作業ツリーで始めない
- **今月のガーデニング PR が既にあるか**: `gh pr list --state all --search "head:claude/gardening-$(date +%Y%m)" --json number,state,headRefName`
  - open → 新しく作らず、その PR の続きから再入する（Step 3 の追加取り込み、または Step 5 以降）
  - merged → Step 5（dev 確認）から再入する
- **記録 issue を読む**: タイトルが `Package gardening log` の open issue（無ければ初回）。最新コメントに前回の見送り一覧と理由・再開条件がある。**前回見送った理由がまだ有効かを Step 2 で再判定する**（例: 「上流のバグ待ち」が解消していれば今回採る）
- このリポジトリの検証手段を**推測せず実物から**把握する:
  - CI の PR 用 workflow（`.github/workflows/` のうち `pull_request` で走るもの）が実行している lint / test / typecheck / build のコマンド
  - `CLAUDE.md` / `AGENTS.md` / `Makefile` / `docs/` の依存更新・リリース関連の記述（例: ロックファイルの再生成手順、`make lock-upgrade`）
  - 統合ブランチへの push で起動する dev デプロイ workflow と、その `paths` フィルタ
  - パッケージマネージャとそのバージョン（`packageManager` / `.tool-versions` / `.node-version`）。**ロックファイルはそのバージョンで再生成する**（corepack を使う）

### Step 1: 棚卸し

次の 4 つの供給源から候補を集め、1 つの表にする。

1. **Renovate の open PR**: `gh pr list --author app/renovate --state open --json number,title,headRefName,labels,createdAt,mergeable`
   - 各 PR の差分（`gh pr diff <n> --name-only` と依存定義の変更行）から、パッケージ・現行版・更新後版・更新種別（patch / minor / major）・`[SECURITY]` の有無を取る
   - 同じパッケージに複数 PR がある（例: `axios-1.x` と `axios-1.x-lockfile`）ときは新しい方に寄せ、古い方は Step 3 で閉じる候補にする
2. **Dependency Dashboard**（`Dependency Dashboard` issue の本文）:
   - `Pending Status Checks` / `Rate-Limited` / `Awaiting Schedule` / `Pending Approval`: まだ PR になっていない更新。候補に入れ、Step 3 ではパッケージマネージャで直接上げる
     - **滞留の大半はここにある**。`prConcurrentLimit` で PR が数件しか開かないため、open PR だけ見ると実態を大きく見誤る（例: open PR 7 件に対し Rate-Limited 32 件、うち major 19 件）。各行は `<!-- unlimit-branch=renovate/... -->` / `<!-- approvePr-branch=... -->` のコメントで識別できるので、本文を grep するときにこれらの行を落とさない
     - グループ名だけの行（`Update hono (...)`）は対象パッケージが括弧内にある。更新後の版は行に書かれていないことがあるので、レジストリで最新を引く
   - `PR Closed (Blocked)`: 過去に閉じた更新（例: major を見送って close）。**閉じた理由（その PR のコメント・記録 issue）がまだ有効か**を確認し、無効なら候補に戻す
   - `Deprecations / Replacements`・`Config Migration Needed`: 依存更新ではないので Step 2 の表には入れず、報告と記録 issue に載せるだけにする
3. **Renovate が更新しない設定にしているもの**（`renovate.json` の `enabled: false` や `ignoreDeps`）: **意図的な固定**。上げない。固定理由（`description`）を報告に転記するだけ
   - 設定は無いが**本番のマネージドサービスと版を揃えるべきもの**も同じ扱いにする。典型は docker-compose / CI のサービスコンテナの DB イメージ（RDS の engine version と揃える）。IaC（`cdk/` の `MysqlEngineVersion` 等）で本番の版を確かめ、食い違う更新は見送り、`renovate.json` で対象外にする提案を報告に書く
4. **Renovate 管轄外**: `renovate.json` が無い、またはマネージャが対応していない依存
   - npm / pnpm / yarn: `pnpm outdated -r` 等
   - Python: `requirements.in` + pip-compile のロックなら `pip list --outdated` 相当（ロックを読む）と、リポジトリの再生成手段（`make lock-upgrade` 等）
   - Dart / Flutter: `flutter pub outdated`
   - Docker のベースイメージ・CI の実行環境のバージョン（`.node-version` 等）は、Renovate が見ていない場合だけ候補にする

`--only` / `--skip` をここで適用する。

### Step 2: 影響調査と採否判定（最重要）

候補ごとに次を調べる。major・`[SECURITY]`・ランタイム依存（`dependencies`）を優先し、devDeps の minor は軽めでよい。

**先に移行規模で振り分ける**。UI フレームワークやフレームワーク本体の major（例: Chakra UI v2→v3、React 19 / Next の major、Prisma の major、ESLint の flat config 移行、zod 4、TypeScript のネイティブ版）は、ガーデニングの枠に収まらない独立した移行案件なので、深い調査をせずに「見送り（個別移行）」とする。記録 issue に載せ、`file-issue` で単独の issue にするかをユーザーに提案する（`--auto` では提案だけ書く）。

候補が多い（目安 10 件超）ときは、ランタイム（API）/ フロントエンド / ツール・インフラのように領域で分け、読み取り専用のサブエージェントに並列で調査させる。指示には「ファイル変更・install・git 操作・GitHub への書き込みをしない」と、下記の調査項目と判定の 3 区分、返してほしい表の列を明記する。

- **リリースノート / CHANGELOG**: 現行版から更新後版までの**全区間**の破壊的変更・非推奨化・既定値の変更・最低要件（Node / Python / SDK の版）の引き上げを拾う。取得元は GitHub Releases（`gh release list -R <owner>/<repo>`、`gh api repos/<o>/<r>/releases`）か、パッケージの CHANGELOG。Renovate の PR 本文にあるリリースノートは途中で切れていることがあるので、それだけで済ませない
- **このリポジトリでの使われ方**: 破壊的変更に該当する API・設定・オプションを `git grep` で数える。「該当箇所 0」は判定の根拠として PR 本文に書く
- **ピア依存・同時更新が必要な組**: 例として `@hookform/resolvers` と `zod`、`react` と `@types/react`、`freezed` と `freezed_annotation`。片方だけ上げると壊れる組は 1 単位として扱う
- **実行時にしか出ない非互換**: 単体テスト・型チェック・ビルドでは捕まらない種類の変更（既定のスケジューラ・タイムアウト・TLS 検証・静的エクスポートの出力形式など）が含まれるなら、Step 4 で実地確認する項目として書き出す
- **CI の死角**: PR の CI が実際に何を検査していないかを先に洗い出す。よくあるもの: 一部ワークスペースの型チェックが無い（deploy 時の Docker build でしか走らない）、format チェックが無い、型チェック対象外のディレクトリ（`docs/` 等）、`--immutable` が効かない yarn 1、deploy workflow しか触らない Actions（PR では動かない）。死角に落ちる更新は Step 4 で手元検証の対象にする
- **最新版を入れてもランタイムが上がらないもの**: Docker のベースイメージで OS 版まで固定したタグ（例: `node:22-alpine3.21`）は、その OS 版のサポートが切れた時点で Node のパッチ更新が止まる。`.node-version` だけ上げても本番は古いまま。Docker Hub のタグの最終更新日で確かめる
- **新しすぎる版**: Renovate の `minimumReleaseAge` を満たさない版（公開から日が浅い版）は採らない。Dashboard に載っている版を上限にする
- **消すべき依存**: 使用 0 件の依存（`git grep` で import・CLI 呼び出しとも 0）や、本体が型を同梱したことで不要になった `@types/*` は、上げずに削除を提案する

判定は 3 つ:

| 判定 | 条件 |
|---|---|
| **採用** | 破壊的変更が非該当、または追従修正が小さく振る舞いを変えない |
| **採用（追従修正あり）** | 修正が必要だが、範囲が依存更新への追従に収まる（型の厳密化への対応、廃止オプションの削除、import 先の変更など） |
| **見送り** | 機能仕様の判断が要る / 修正が広範（目安: 10 ファイル超、またはテストの期待値変更を伴う）/ 上流のバグ待ち / 実地確認の手段が無い。**理由と再開条件を必ず書く** |

`[SECURITY]` を見送るときは、脆弱性がこのリポジトリの使い方で到達可能かを併記する（例: 「該当するのは SMTP の添付取得だけで、本リポジトリは SES 経由の HTML 本文のみ」）。

- 対話時: 判定表（パッケージ / 現行→更新後 / 種別 / 判定 / 根拠 / 追従修正の見込み）を**ユーザーに提示して確認を取る**。ここが唯一の事前ゲート
- `--auto`: 確認を取らずに進め、表は PR 本文に載せる。迷うものは見送りに倒す
- `--until=plan` ならここで表を報告して終了（何も書き込まない）

### Step 3: ガーデニングブランチへの適用

- `git switch -c claude/gardening-YYYYMM origin/<base>`（同月 2 回目は `-2`）。ブランチ名は `claude/` で始める。クラウド実行では `claude/` 以外への push が拒否されることがある
- 採用した更新を 1 件（または組）ずつ適用し、**1 件ごとに commit する**（後で 1 件だけ外せるように）:
  - **Renovate の PR があるもの**: `git merge --no-ff origin/<renovate-branch>`。ロックファイルが衝突したら手で直さず、`git checkout --ours <lockfile>` → 依存定義（`package.json` 等）が両側の和集合になっているのを確かめる → 指定バージョンのパッケージマネージャでロックファイルを再生成 → `git add`。依存定義そのものが衝突したら、先に手で正しくマージしてから再生成する
  - **PR が無いもの**（Dashboard の未作成分・管轄外）: パッケージマネージャで上げる（`pnpm up <pkg>@<ver> -r` / `make lock-upgrade PACKAGE=<pkg>` / `flutter pub upgrade --major-versions <pkg>` 等）。commit メッセージは Renovate の慣例（`git log --author=renovate -5 --format=%s`）に揃える
  - **追従修正**は依存更新の commit と分けて、直後に別 commit にする（何がライブラリ都合の修正かを履歴で追えるように）
  - **フォーマッタ（prettier 等）を上げたときの整形差分**は、旧版でも差分が出るファイルを除いてから判断する（旧版を `npx <tool>@<旧版> --list-different` で当てる）。CI で format を検査していないリポジトリは旧版の時点で既に未整形のことが多く、全体整形の差分の大半は更新と無関係になる。更新由来の差分がわずかなら整形コミットは入れない
- 1 件適用するごとに、影響のあるワークスペースの型チェックとテストを回す。全体の検証は Step 4 でまとめて行う

### Step 4: 検証

- CI の PR 用 workflow と同じコマンドをローカルで実行する（lint / test / typecheck / build:dryrun 等）。全部 green になるまで Step 3 に戻って直す
- Step 2 で書き出した「実行時にしか出ない非互換」を実地で確認する（静的エクスポートの出力をブラウザで開く、実際の送信処理を dry-run する、クローラを手元のサイトに走らせる等）。**確認できなかった項目は「未確認」として PR 本文に残す**
- 直せない失敗が出た更新は、その commit を `git revert` で外して見送りに回す（理由に失敗内容を書く）。**テストを skip・削除したり、期待値を緩めて通したりしない**

### Step 5: PR 作成と CI 確認

- `git push -u origin claude/gardening-YYYYMM`
- `gh pr create --base <base> --title "..." --body-file <path>`。タイトルは過去のガーデニング PR / リリース PR の慣例に揃える（前例が無ければ `:arrow_up: パッケージガーデニング YYYY-MM`）。本文:
  - **採用した更新**の表（パッケージ / 現行→更新後 / 種別 / 元の Renovate PR / 追従修正の有無と内容）
  - **見送った更新**の表（理由 / 再開条件）
  - **意図的な固定**（Step 1 の 3）と Dashboard の非推奨・設定移行の指摘
  - 検証結果（実行したコマンドと結果、実地確認した項目と未確認の項目）
  - dev / 本番への影響（デプロイが起動するパス、マイグレーションの有無、インフラ変更の有無）
- `gh pr checks <n> --watch --interval 30` をバックグラウンドで待つ。落ちたら `fix-ci` で直す
- **記録 issue（`Package gardening log`）にコメントする**。無ければ作る。内容は今回の PR 番号・採用数・見送り一覧（理由・再開条件）。次回の Step 0 はこれを読む
- 吸収した Renovate PR は閉じない。ガーデニング PR が merge commit で入れば GitHub が merged 扱いにし、squash で入っても Renovate が次の実行で自動クローズする。古い重複 PR（Step 1 の同一パッケージ重複）だけは、ガーデニング PR へのリンクをコメントしてから閉じる（`--auto` では閉じずに報告だけ）
- `--until=pr` または `--auto` ならここで報告して終了

### Step 6: 統合ブランチへのマージと dev 確認（`--until=dev` 以上）

- **マージ前にユーザーの承認を取る**（統合ブランチへの push は dev デプロイを起動する）
- マージ方式はリポジトリの慣例（`gh pr list --base <base> --state merged --limit 10` の実物）に従う
- マージで起動した dev デプロイ workflow を `gh run list --branch <base>` で特定し、完了を待つ。**成功表示だけで終わらせず、ログでデプロイの実体（新しいイメージ・Worker のバージョン・CloudFront の無効化など）を確認する**
- **dev デプロイの `paths` に入っていない更新**（例: `cdk/**` が dev の対象外）は、dev で一度も検証されないまま本番が初適用になる。報告とリリース PR の本文に明記する
- dev 環境の疎通確認（ヘルスチェックの URL、主要画面の表示）。手段がリポジトリに無ければ「dev はデプロイ成功まで確認、画面は未確認」と書く

### Step 7: リリースへの引き継ぎ（`--until=release`）

- `release` skill を `--until=pr` で呼び、ガーデニング PR 以外に develop に溜まっている変更も含めた収録範囲の判断はそちらに任せる
- 本番へのマージは `release` skill のゲートでユーザーが判断する。この skill からは main をマージしない

### Step 8: 最終報告

ガーデニング PR / 採用した更新と追従修正 / 見送った更新と理由 / 検証結果（未確認の項目を含む）/ CI と dev デプロイの結果 / リリース PR（あれば）/ 記録 issue のコメント、を 1 ブロックで報告する。

## `--auto` のときの追加規則

Routine など、誰も見ていない状態で動かすときの規則。

- **書き込んでよいのは `claude/gardening-*` ブランチ、ガーデニング PR、記録 issue のコメントだけ**。統合ブランチ・本番ブランチへのマージ、Renovate PR のクローズ、Dashboard のチェックボックス操作、`renovate.json` の変更はしない
- 迷ったら見送りに倒す。見送りは失敗ではなく、理由が書いてあれば次回の人が判断できる
- 1 件の追従修正に時間がかかりすぎる（目安: 同じ失敗に 3 回修正を試みても green にならない）ときは、その更新を revert して見送りにし、次の候補へ進む
- 長いコマンド（全体テスト・ビルド）はバックグラウンドで実行して完了を待つ。クラウドの前景コマンドは 10 分で打ち切られる
- 採用が 0 件でも記録 issue にはコメントする（「今月は見送りのみ」も次回の判断材料になる）

## Notes

- 統合ブランチ・本番ブランチへの直接 push・force push はしない。すべて PR 経由
- PR 本文・issue コメントは `--body-file` でファイル経由で渡す
- ロックファイルを手で編集しない。衝突は片側採用 → 再生成
- 依存更新に紛れて無関係なリファクタリングをしない。追従修正は「その更新が無ければ不要だった変更」に限る
- 使用コマンド: `git fetch/switch/merge/revert/grep/push`, `gh pr list/view/diff/create/checks/merge/comment`, `gh issue list/view/create/comment`, `gh run list/view/watch`, `gh release list`, `gh api`, 各パッケージマネージャ
- 内部ツール: `Skill`（`fix-ci` / `release` の呼び出し）、`Monitor`（CI・デプロイの完了待ち）

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「minor だから破壊的変更は無い」 | semver を守らないパッケージは珍しくない（例: hono の minor での型の厳密化）。リリースノートと使われ方を見る |
| 「Renovate の PR が CI を通っているからそのままマージしてよい」 | CI は単体テストと型とビルドしか見ていない。既定値の変更や実行時の非互換は通ってしまう（例: scrapy の `start_requests` が警告なしに無視される） |
| 「全部まとめて上げて最後にテストすればよい」 | 落ちたときにどの更新が原因か切り分けられない。1 件ずつ commit と型チェックを挟む |
| 「テストが落ちるのは古いテストのせいなので期待値を直す」 | 期待値の変更は振る舞いの変更。見送りにして人に判断を委ねる |
| 「SECURITY なので何があっても今回入れる」 | 追従修正が広範なら、到達可能性を評価したうえで見送りにして issue にする方が安全なこともある。どちらにしても理由を書く |
| 「見送り理由は自明なので書かなくてよい」 | 次回は別のセッション（クラウドならメモリも無い）が判断する。記録 issue に書いていない理由は失われる |

## 関連

- `release` — 統合ブランチから本番ブランチへの反映。本 skill の Step 7 から呼ぶ
- `fix-ci` — ガーデニング PR / dev デプロイの CI 失敗の調査と修正
- `setup-renovate` — Renovate の導入・設定。手動の更新が毎月多すぎるなら、自動マージの範囲を見直す
- `file-issue` — 見送った更新のうち、まとまった作業が要るもの（major の移行など）を単独の issue にする
