---
name: setup-renovate
description: toraco リポジトリに Renovate（Mend ホスト型 GitHub App 版）を導入する。renovate.json 生成・デプロイ workflow の actor ガード・必須チェック Ruleset・auto-merge 許可を自動化し、Web UI 側の作業は手動チェックリストで提示する。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Setup Renovate for a repository: $ARGUMENTS

**使い方**: `/setup-renovate [--repo=owner/name] [--base-branch=develop] [--dry-run]`

## Goal

対象リポジトリに Renovate（Mend ホスト型）を **toraco 標準方針**で導入する。次の 6 ステップのうち、**gh CLI とファイル編集で完結する 1〜4 を自動化**し、**Web UI でしか出来ない 5〜6 はチェックリストとして提示**する。

1. `renovate.json` の設定
2. デプロイ関連ワークフローの設定（Renovate PR ではデプロイしない）＋ CI の paths フィルタ撤廃
3. GitHub Repo で Rulesets の設定（必須ステータスチェック）
4. GitHub Repo で allow auto-merge の有効化
5. GitHub App の Renovate にリポジトリを追加（**手動 UI**）
6. Mend ダッシュボードで稼働モード切替＆確認（**手動 UI**）

## いつ使うか

- toraco の新規 / 既存リポジトリに依存自動更新（Renovate）を初めて入れるとき。
- 既に導入済みのリポジトリと同じ運用方針を別リポジトリへ横展開するとき。

## 前提・必要権限

- 対象リポジトリの **admin 権限**（Ruleset・auto-merge 設定に必要）。最初に確認する:
  ```bash
  gh api repos/<owner>/<repo> --jq '.permissions'   # admin:true を確認
  ```
- org に Renovate GitHub App が**インストール済み**であること（`repo_selection` が `selected` の場合はステップ5で対象追加が必要）:
  ```bash
  gh api orgs/<org>/installations --jq '.installations[] | select(.app_slug=="renovate") | {repository_selection, permissions}'
  ```
  Renovate App には `contents/issues/pull_requests/workflows/checks: write` が必要。

## 重要な順序依存（必読）

- **CI の paths フィルタ撤廃（ステップ2）は、必須チェック Ruleset（ステップ3）より先に行う。** これを怠ると、依存更新 PR で必須チェックが起動せず、**automerge が永久に詰まる**（チェックが pending のままマージ不能）。
- **renovate.json の `baseBranches` と、Ruleset・CI の対象ブランチを一致させる。** 判定ルール: `develop` ブランチがあれば `develop`、無ければ**そのリポジトリのデフォルトブランチ**（`main` / `master` など実在するもの）に読み替える（ステップ1で判定）。`develop` も `main` も無い古いリポジトリでは default branch（例 `master`）をそのまま使う。
- 自動化分（1〜4）が終わっても、**5（App 追加）と 6（Mend モード切替）を人手で済ませるまで PR は 1 本も出ない。** 特に Mend が **Silent モード**だと、ジョブは成功するのに GitHub 側へ一切書き込まれない。最後に必ずチェックリストを提示すること。

---

## Step 1: 事前調査（対象リポの実態を掴む）

`--repo` が無ければカレントの git リポジトリを対象とする。以下を収集し、後続ステップの入力にする。

1. **デフォルトブランチと develop の有無** → `baseBranches` を決定:
   ```bash
   gh api repos/<owner>/<repo> --jq '{default: .default_branch}'
   gh api repos/<owner>/<repo>/branches/develop --jq '.name' 2>/dev/null   # develop があれば baseBranches=develop
   # develop が無ければ baseBranches はデフォルトブランチ（上で取得した .default_branch。main / master 等）
   ```
2. **実スタックの検出**（テンプレの packageRules を実態に合わせるため）。リポ内の全 `package.json` を読み、依存に含まれるものを確認:
   ```bash
   fd -H -t f 'package.json' -E node_modules || find . -name package.json -not -path '*/node_modules/*'
   ```
   - prisma / firebase / chakra-ui(@emotion) / aws-cdk / aws-sdk / hono / react・next / vitest / eslint・prettier の有無をチェック。
   - Docker タグ（`docker-compose*.y*ml`, `Dockerfile`）、`.nvmrc` / `.node-version`、`.github/workflows` の actions も Renovate 管理対象になる。
3. **CI（必須チェックにすべきワークフロー）の特定**:
   - `.github/workflows/*.y*ml` から lint/test/build を回す PR トリガーのワークフローを探す（例: `checks.yaml`）。
   - **必須チェックの context 名は「実ジョブ名」と完全一致が必要**（GitHub の check context は通常**ジョブ名**であって、ワークフロー名（`name:`）ではない）。既存 PR があれば実際の context 名を取得して確認する（タイポでもその名前を使う。改名は過去参照を壊す）:
     ```bash
     gh pr list --state open --json number -q '.[0].number'   # 任意の PR 番号
     gh pr view <PR> --json statusCheckRollup -q '.statusCheckRollup[].name'
     ```
   - 上記ワークフローに `on.pull_request.paths` フィルタがあるかを確認（あれば撤廃対象）。
4. **デプロイワークフローの特定**: `push` で deploy / cdk deploy / script 実行を行うワークフロー（develop/main 両方）を列挙。これらに actor ガードを追加する。

`--dry-run` の場合はここまでの調査結果と「これから行う変更の一覧」を提示して停止する。

## Step 2: ファイル変更（renovate.json / ワークフロー / CI）

作業ブランチを切る（base は対象リポのデフォルトブランチ）:
```bash
git switch -c chore/introduce-renovate
```

### 2-1. renovate.json を生成

リポジトリ直下に `renovate.json` を作成する。**末尾の「付録: toraco 標準テンプレート」をベースに、Step 1 で検出した実スタックに合わせて packageRules のグループを調整**する:
- **剪定の粒度**: 削除の単位は「グループ（packageRule オブジェクト）」。対象リポがそのスタックを使っていないグループは**オブジェクトごと丸ごと削除**する（例: chakra が無ければ chakra-ui グループを消す）。逆に、残すグループ内の `matchPackageNames` に**未使用のサブパッケージ名が混ざっていても消さなくてよい**（例: react-nextjs を残すなら、現状未使用の `@types/react` 等は将来導入時に効き害が無いので残置）。`matchManagers` ベースのグループ（`github-actions` / `lockFileMaintenance`）はパッケージ数や個別有無に関係なく**常に残す**（manager 単位のグルーピングであり「単一パッケージのグループは作らない」規則の対象外）。
- `baseBranches` を Step 1 の判定値（`develop` があれば `develop`、無ければデフォルトブランチ `main` / `master` 等）にする。
- グループ化は **`matchPackageNames` + glob** で書く。`matchPackageNames` は scope glob（`"@hono/**"`, `"@prisma/**"`）と prefix glob（`"cdk-*"`, `"eslint-*"`, `"vite-*"`）の両方を許容する。`matchPackagePatterns` は非推奨なので使わない。
- 単一パッケージだけのグループは作らない（グループ化の効果が無い）。`typescript` のような単独パッケージはグループ化せず、冒頭の汎用 update-type ルール（patch/minor/major）に乗せる。
- prisma / aws-cdk は破壊的変更の影響が大きいので `automerge: false` を維持。

> ⚠️ **テンプレの例示パッケージをそのまま残さない。** 必ず対象リポの `package.json` で実在を確認してから書く（過去にテンプレの別スタックを誤コミットした事故あり）。

検証（**`-p renovate` 必須**。`renovate-config-validator` 単体名は npm に存在せず E404 になる）:
```bash
npx --yes --package renovate -- renovate-config-validator renovate.json
# → "Config validated successfully" を確認
```

### 2-2. デプロイワークフローに actor ガードを追加

Step 1 で特定した **deploy を行う全ワークフロー・全 job** に、以下を追加する。1 つのワークフローが複数ブランチ（例 `branches: [develop, main]`）を push トリガーにしている場合はその job 1 箇所に追加すれば足り、develop 用 / main 用にワークフローが分かれている場合は各ファイルに追加する:
```yaml
jobs:
  build:   # ← 実際の job 名
    # Renovate による依存更新 PR のマージではデプロイしない
    if: github.actor != 'renovate[bot]'
    ...
```
- **既知の限界**（PR 本文や報告に明記すること）: `github.actor` は push のアクター。automerge で renovate[bot] がマージした場合はスキップされるが、**人間が手動マージすると actor がその人になりスキップされない**。ジョブは `if` で即スキップされ、ワークフロー自体は「成功」扱いになる。

### 2-3. CI の paths フィルタを撤廃（Ruleset の前提）

Step 1 で必須チェックにするワークフロー（例 `checks.yaml`）に `on.pull_request.paths` があれば、それを外して全 PR で起動するようにする:
```yaml
on:
  pull_request:        # paths: フィルタを削除し、これだけにする
```
理由: 依存更新 / cdk / ルート依存の PR は paths 非該当でチェックが起動せず、Ruleset 必須化と組み合わせると automerge が詰まるため。

**対象ワークフローに `paths` フィルタが無ければ、このサブステップは何もせずスキップする**（既に全 PR で起動するため）。スキップした旨は完了報告に 1 行添える。

### 2-4. コミット & PR

`/commit` 慣例（emoji prefix・日本語）に合わせてコミットし、push して PR を作成する。**PR の base は対象リポのデフォルトブランチ**（例 `main`）にする — Renovate は `renovate.json` を**デフォルトブランチから読む**ため、`baseBranches` が `develop` でも設定 PR 自体はデフォルトブランチへ入れる必要がある（`baseBranches` は Renovate が**更新 PR を作る先**であって、設定の読み取り元ブランチとは別物）。本文には「導入内容」「actor ガードの限界」「残る手動ステップ（5・6）」を記載する。`/create-pr` を流用してよい。

> デプロイスキップを別 PR に分けたい場合は `chore/skip-deploy-on-renovate` として 2-2 のみ分離してもよい（過去は別 PR だった）。既定は 1 PR にまとめる。

## Step 3: 必須チェック Ruleset を作成（gh api）

**UI 不要。`gh api` で作成する。** context 名は Step 1 で確認した実ジョブ名、`integration_id` は GitHub Actions の `15368`。対象ブランチは `baseBranches` と一致させる。

```bash
cat > /tmp/ruleset.json <<'JSON'
{
  "name": "Status check before merging",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "exclude": [], "include": ["refs/heads/develop"] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "<実ジョブ名。ワークフロー名(name:)ではなくジョブ名>", "integration_id": 15368 }
        ]
      }
    }
  ],
  "bypass_actors": []
}
JSON
# include の develop と context を対象に合わせて書き換えてから:
gh api --method POST repos/<owner>/<repo>/rulesets --input /tmp/ruleset.json --jq '{id, name, enforcement}'
```

注意:
- 既存 Ruleset を壊さない。事前に `gh api repos/<owner>/<repo>/rulesets --jq '.[] | {id,name}'` で確認する。同名（や対象ブランチが重複する）Ruleset が既にある場合は **自動で上書き・再作成しない**。その Ruleset の現在の context / 対象ブランチを取得して比較する。
  - **既存が対象ブランチ（baseBranches）に対し必要な context を既に required にしている**なら、**充足・作成不要**と判断し、その旨を完了報告に書く（伺いは不要）。
  - 対象ブランチや context に**差分がある**場合のみ、差分をユーザーにテキストで提示して追記・修正の判断を仰ぐ（自動で上書きしない）。
  - 同名・対象重複の Ruleset が無ければ新規作成する。
- org レベルで既に降りている Ruleset（例「Do not push to default branch」）は**リポジトリ側で再作成しない**。
- パラメータの意味: `strict_required_status_checks_policy: false`（マージ前に最新 base への追従を強制しない）、`do_not_enforce_on_create: false`（ブランチ新規作成時もチェックを強制する）、`bypass_actors: []`（バイパス権を誰にも与えない）。いずれも toraco 既定なので変更不要。

## Step 4: allow auto-merge を有効化（gh api）

**UI 不要。API で有効化できる。**
```bash
gh api --method PATCH repos/<owner>/<repo> -F allow_auto_merge=true -F delete_branch_on_merge=true --jq '{allow_auto_merge, delete_branch_on_merge}'
```
`delete_branch_on_merge: true` は toraco 既定（マージ済み renovate/* ブランチを自動削除）。両方まとめて有効化する。
これが無いと、Renovate / GitHub の automerge（PR マージ予約）が機能しない。

## Step 5 & 6: 手動 UI ステップ（チェックリスト提示）

ここから先は **GitHub / Mend の Web UI でしか操作できない**。以下のチェックリストをそのままユーザーに提示し、完了を促す（このスキルでは自動検証しない）。

```
Renovate を稼働させるための残り手動ステップ（Web UI）:

[ ] 5. GitHub App にリポジトリを追加
     https://github.com/organizations/<org>/settings/installations
     → Renovate → Repository access → <repo> を「Select repositories」に追加して Save
     （App が repo_selection: all なら不要）

[ ] 6a. Mend ダッシュボードの稼働モードを切替（★最重要・見落とし注意）
     https://developer.mend.io/github/<org>/<repo>  → Settings → Dependencies
       - Dependency Updates : ON（親スイッチ）
       - Silent mode        : OFF  ← ON だと PR も Dashboard issue も作られない
       - Automated PRs      : ON   ← これが PR を自動作成する本体
       - Require config file: ON（自前 renovate.json 厳守。任意）
       - Create onboarding PRs: OFF（config 導入済みのため不要）
     → SAVE

[ ] 6b. 確認
     - Mend: Recent jobs が DONE / "Pending Approval" が解消され PR 化されること
     - GitHub: Issues に「Dependency Dashboard」が作成され、renovate/* ブランチと PR
       （prConcurrentLimit の範囲で順次）が出ること
```

補足として伝えること:
- **Silent モードのままだとジョブは成功するのに GitHub へ何も書き込まれない**（過去にここで詰まった）。6a を必ず実施。
- 5・6 が終わるまで PR は 1 本も出ない。これは設定ミスではなく Mend 側の稼働ゲート。

## 完了報告

- 自動化分（1〜4）で変更したファイル / 作成した PR / Ruleset id / auto-merge 状態を列挙。
- 手動分（5〜6）のチェックリストを提示し、「これらは Web UI 操作のため未実施」と明示。
- PR がマージされ Mend が Automated に切り替われば、`renovate.json` 通り（automerge ルール・グループ化・`minimumReleaseAge: 7 days`・`prConcurrentLimit`）に稼働する旨を伝える。

---

## 付録: toraco 標準 renovate.json テンプレート

実スタックに合わせて packageRules を取捨選択して使う。`baseBranches` は対象リポに合わせる。

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "baseBranches": ["develop"],
  "dependencyDashboardApproval": false,
  "prConcurrentLimit": 5,
  "osvVulnerabilityAlerts": true,
  "rebaseWhen": "conflicted",
  "minimumReleaseAge": "7 days",
  "internalChecksFilter": "strict",
  "labels": ["dependencies"],
  "commitMessagePrefix": ":arrow_up: ",
  "packageRules": [
    {
      "description": "patch devDeps: auto-merge (branch方式、PRなし)",
      "matchUpdateTypes": ["patch"],
      "matchDepTypes": ["devDependencies"],
      "automerge": true,
      "automergeType": "branch"
    },
    {
      "description": "patch deps: auto-merge (PR方式)",
      "matchUpdateTypes": ["patch"],
      "matchDepTypes": ["dependencies"],
      "automerge": true,
      "automergeType": "pr"
    },
    {
      "description": "minor devDeps: auto-merge (PR方式)",
      "matchUpdateTypes": ["minor"],
      "matchDepTypes": ["devDependencies"],
      "automerge": true,
      "automergeType": "pr"
    },
    {
      "description": "minor deps: 手動レビュー",
      "matchUpdateTypes": ["minor"],
      "matchDepTypes": ["dependencies"]
    },
    {
      "description": "major: 手動レビュー",
      "matchUpdateTypes": ["major"]
    },
    {
      "description": "Hono グループ (minor/patch auto-merge、majorは手動レビュー)",
      "groupName": "hono",
      "matchPackageNames": ["hono", "@hono/**"],
      "matchUpdateTypes": ["minor", "patch"],
      "automerge": true,
      "automergeType": "pr"
    },
    {
      "description": "Prisma グループ (auto-merge無効)",
      "groupName": "prisma",
      "matchPackageNames": ["prisma", "@prisma/**", "zod-prisma-types"],
      "automerge": false
    },
    {
      "description": "React / Next.js グループ",
      "groupName": "react-nextjs",
      "matchPackageNames": ["react", "react-dom", "next", "@types/react", "@types/react-dom"]
    },
    {
      "description": "Firebase グループ",
      "groupName": "firebase",
      "matchPackageNames": ["firebase", "firebase-admin", "firebase-tools"]
    },
    {
      "description": "Chakra UI グループ",
      "groupName": "chakra-ui",
      "matchPackageNames": ["@chakra-ui/**", "@emotion/**"]
    },
    {
      "description": "AWS CDK グループ (auto-merge無効)",
      "groupName": "aws-cdk",
      "matchPackageNames": ["aws-cdk", "aws-cdk-lib", "cdk-*", "constructs"],
      "automerge": false
    },
    {
      "description": "AWS SDK グループ (v2/v3 両対応)",
      "groupName": "aws-sdk",
      "matchPackageNames": ["@aws-sdk/**", "aws-sdk"]
    },
    {
      "description": "Vitest グループ",
      "groupName": "vitest",
      "matchPackageNames": ["vitest", "vite-*", "@vitest/**"]
    },
    {
      "description": "Linting グループ",
      "groupName": "linting",
      "matchPackageNames": ["eslint", "eslint-*", "prettier", "@typescript-eslint/**"]
    },
    {
      "description": "GitHub Actions グループ",
      "matchManagers": ["github-actions"],
      "groupName": "github-actions"
    },
    {
      "description": "Lock file maintenance: 毎週月曜早朝",
      "matchUpdateTypes": ["lockFileMaintenance"],
      "automerge": true,
      "schedule": ["before 6am on Monday"]
    }
  ]
}
```

## ハマりどころ（過去の実作業より）

- `renovate-config-validator` は `npx --package renovate -- ...` 経由でないと取得できない（単体パッケージ名は E404）。
- 必須チェックの context は**実ジョブ名と完全一致**（タイポ込み）。`gh pr view --json statusCheckRollup` で実名を確認する。
- **paths フィルタ撤廃 → Ruleset 必須化** の順序を守る（逆だと automerge デッドロック）。
- Mend の **Silent モード**だと全更新が "Pending Approval" に溜まり GitHub へ出ない。`Automated PRs: ON` / `Silent mode: OFF` に切替（ステップ6a）。
- テンプレの例示パッケージを鵜呑みにせず、必ず対象リポの `package.json` で実スタックを検証する。
