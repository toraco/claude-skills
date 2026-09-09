---
name: solve-issues
description: GitHub の open issue から設計判断が不要なもの（bugfix / refactor / chore / docs / test）だけを抽出し、1 issue = 1 PR で自動実装・PR 作成までループ処理する。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Solve issues: $ARGUMENTS

**使い方**: `/solve-issues [--repo=owner/name] [--issue=N] [--label=...] [--exclude-label=...] [--limit=N] [--dry-run]`

## Goal

GitHub の open issue を一括点検し、**設計判断や仕様確認を要さずに** 安全に対応できる issue（典型: 明確な bug fix / 機械的な refactor / docs / chore / test 追加）を **1 issue = 1 PR** で自動実装し、PR 作成まで完了させる。

新機能追加・大規模リファクタ・仕様確認が必要なものは **対象外** とし、レポートに「人間に委ねる」候補として残すだけにする。

## いつ使うか

- Claude Code Routine からの定期実行で、毎日 / 毎時 open issue を消化する（本 skill の主要想定）
- 手動で「今ある対応可能な issue を一気に片付けたい」とき
- 単一 issue について「これは設計判断不要そうだから自動で PR まで」と判断したとき (`--issue=N`)

使わない場面:

- 1 件の bug を自分で実装したい → `bugfix`
- バグや課題を issue として登録したい → `file-issue`
- マージ後 PR の triage / follow-up 起票 → `pr-triage`
- 設計判断が必要な issue → 対象外（人間に委ねる）

## 前提

- リポジトリで `gh` (GitHub CLI) の認証が通っている
- 対象リポジトリの issue read / PR write 権限がある
- リポジトリにテスト・リント・ビルドの実行手順が定義されている（`check` skill 相当が走る前提）
- Routine 実行時はユーザー確認を介さず autonomous に動くため、後述の「自動実行ガード」を満たすケースだけ実装に進む

## 引数

| フラグ | 既定 | 意味 |
|---|---|---|
| `--repo=owner/name` | カレントの `gh repo view` | 対象リポジトリ |
| `--issue=N` | 未指定 | 単一 issue のみを対象（label フィルタは適用、`--limit` は無視） |
| `--label=a,b` | 未指定 | 指定ラベルのいずれかを持つ issue だけを事前フィルタ |
| `--exclude-label=a,b` | `needs-discussion,blocked,wontfix,question` | 指定ラベルを持つ issue を事前除外 |
| `--limit=N` | 3 | 1 回の実行で **PR まで完了させる最大件数**。triage 分析自体は全件に対して行う |
| `--dry-run` | false | triage と分類のみ。ブランチ作成・実装・PR 作成は行わない |

`--limit` の既定が小さいのは、Routine で 1 度に大量 PR を生やすと CI 負荷・レビュー負荷で運用が破綻するため。Routine の cron 周期と合わせて調整する。

## ワークフロー

### Step 0: Setup

- 状態変数: `REPO`, `ISSUE_LIST`, `LIMIT`, `DRY_RUN`, `LABEL_FILTER`, `EXCLUDE_LABELS`, `CHECK_COMMANDS`, `ACTIONS_TAKEN = []`, `ACTIONS_DEFERRED = []`, `ACTIONS_DROPPED = []`
- 引数を解析。`--exclude-label` は未指定なら既定値を使用
- `gh repo view <REPO>` で存在確認。失敗したら停止し理由をレポートに残して終了
- `git status` がクリーンであることを確認。未コミット変更があれば停止（Routine では事故になる）
- 現在のブランチを `ORIGINAL_BRANCH` として記録。最終的にここへ戻す
- **テスト/lint/build コマンド検出**: `package.json` の `scripts`、`Makefile` ターゲット、`composer.json` の `scripts`、`.github/workflows/*.yml` の典型的コマンド (`pytest`, `phpunit`, `cargo test`, `go test` 等) を grep して `CHECK_COMMANDS = {test, lint, build}` を埋める
  - 検出できないものは `null` のまま残す
  - **`test` が `null`** の場合、「事前ガード違反: テスト手順未定義」として **Step 2 以降をすべてスキップ**（triage 分析も走らせない）。Step 1 で取得したすべての issue を `ACTIONS_DEFERRED` に「skipped: test command not detected」で記録し、レポートは **「失敗・スキップ」節に集約**。ヘッダ件数表記は「対象 issue: N件 (🟢 0 / 🟡 0 / ⚪ 0)」とし、N 件をすべて「失敗・スキップ」節へ
  - `lint` / `build` が `null` の場合は警告のみ。`test` だけは必須ガード
- **タスクリスト化**: `TaskCreate` で主要ステップ（issue 列挙 / triage 分析 / 実装ループ / 最終レポート）を登録し、進行に合わせて `in_progress` / `completed` を更新

### Step 1: 対象 issue の列挙

`--issue=N` 指定時はその 1 件だけを `gh issue view N --repo $REPO --json number,title,body,labels,author,url,createdAt,updatedAt,state` で取得。**取得後** `--exclude-label` の既定値・指定値に該当するラベルが付いていれば、その issue を `ACTIONS_DROPPED` に「excluded by label」で記録して終了する（`--label` 指定があれば同様にラベル不一致をチェックし、不一致なら `ACTIONS_DROPPED`）。`--issue=N` モードでも label フィルタは適用される。

それ以外は次で取得:

```bash
gh issue list --repo $REPO --state open \
  --search "is:open is:issue -linked:pr" \
  --json number,title,body,labels,author,url,createdAt,updatedAt \
  --limit 100
```

- `-linked:pr` で **既に PR が紐づいている issue を除外** する（同じ issue に対して PR を二重に作らないため）
- `--label=a,b` 指定時は `--search` クエリに `label:a OR label:b` を追加する（複数 OR 想定。`gh issue list --label` の複数指定は **AND** 動作のため使わない）
- `--exclude-label=a,b` 指定時も `--search` クエリに `-label:a -label:b` を追加する（gh の `--exclude-label` フラグはバージョンにより未対応のため search で揃える）
- 残った issue が 0 件なら最終レポートに「対象 issue なし」と記載して終了

### Step 2: 各 issue の triage 分析（並列）

`Agent` ツール (`subagent_type: "Explore"`, `model: "sonnet"`) を **issue 件数分 1 メッセージ内で並列呼び出し** する。10 件以上ある場合は 5 件ずつのバッチで順次実行（バッチ内は並列、バッチ間は直列）。`--issue=N` 指定で対象が 1 件の場合も同じく `Agent` を 1 回呼び出す（出力フォーマットの一貫性を保つため）。

各 subagent への入力:

- 該当 issue 1 件分の JSON（`number / title / body / labels / url / createdAt / updatedAt`）
- `REPO` とリポジトリのルートパス

各 subagent への指示プロンプト（verbatim）:

```
あなたは issue triage アナリストです。以下の open issue 1 件を読み、リポジトリ内のコードを調査した上で、「設計判断や仕様確認なしに自動実装して PR まで作って良いか」を判定してください。

## 判定軸

1. **classification**: 以下のいずれか
   - `bug` — 明確に不具合（再現手順 / 期待値 / 実際の挙動が読み取れる）
   - `refactor` — 振る舞い不変の機械的な書き換え
   - `docs` — README / コメント / ドキュメントのみ
   - `chore` — 依存更新 / 設定ファイル / lint 修正等
   - `test` — テスト追加 / 修正のみ
   - `feature` — 新機能追加（**自動対応外**）
   - `question` — 質問・議論（**自動対応外**）
   - `unclear` — 分類不能

2. **needs_design_decision**: true / false
   - **判定原則**: 「ユーザに見える挙動 / 公開 API / データ形式 / 既存仕様との整合性」を変える選択を要する場合のみ true。「実装者が常識的に決められる表面的な選択」は **false**（実装フェーズで適切な選択を 1 つ選べば良いため）。
   - true となる典型例:
     - 振る舞いの選択肢が複数あり、どれを選ぶかで **動作 / API / 出力データ形式 / ユーザ体験** が変わる
     - 既存仕様との整合性に判断を要する（例: 既に他の場所で違う方針が採られていて統一すべきか分岐するか）
     - 影響範囲が広く、関連モジュールへの波及方針を決める必要がある
     - 本文に「TBD」「要相談」「Open questions」などの未確定事項が残っている
     - issue 本文の情報量が少なく、再現条件・期待挙動・想定対象が読み取れない
   - **false 扱いの例（これらの「選択肢」だけでは true にしない）**:
     - エラーメッセージ / ログ出力 / コメント文 / UI ラベルの正確な文言（実装者が読み手に伝わる文を選べば良い）
     - 関数名 / 変数名 / クラス名の命名（既存の命名規約に従えば良い）
     - コード構造（関数を分割する / インライン化する / どこに置くか等の局所的判断）
     - 出力フォーマットの細部（ISO 形式 vs 人間可読、桁数、区切り文字など、issue 本文で明示的に問われていない場合）
     - aria-label / alt 属性などアクセシビリティ文言（descriptive ならどれでも良い類）
   - **誤判定を避けるルール**: 「複数の表現方法があるから設計判断必要」と機械的に判定しない。「**ユーザの目に見える挙動 / 公開 API が変わるか**」「issue 本文が明示的に方針を問うているか」を基準に判断する。

3. **estimated_change_scope**: small / medium / large
   - small: 1〜3 ファイル、合計 50 行以下の変更見積もり
   - medium: 4〜10 ファイル、または 50〜200 行
   - large: それ以上

4. **target_files**: コード調査で当たりをつけた主要ファイル `path/to/file.ts:lineNo` 形式（最大 5 件）

5. **confidence**: 0-100（自動実装の安全度）
   - 90-100: 修正箇所・修正内容ともに 1 通りに確定。テストで検証可能
   - 80-89: 修正方針はほぼ確定だが些細な実装上の選択（命名 / 構造 / **文言 / フォーマット**）が残る
   - 50-79: 大筋は見えるが **動作 / API / 影響範囲 / 仕様の解釈** に余地がある
   - 0-49: 仕様判断 / 設計判断が必須、または情報不足
   - **重要**: 文言・命名・構造・フォーマットの選択肢が残っているだけなら **80-89 帯に留める**（needs_design_decision=false と整合）。50-79 帯は「動作 / API / 影響範囲 / 仕様」に解釈余地がある場合に予約する。両者を混同しない。

## 出力フォーマット (YAML 風)

classification: <bug | refactor | docs | chore | test | feature | question | unclear>
needs_design_decision: <true | false>
estimated_change_scope: <small | medium | large>
target_files:
  - <path:line or path>
  ...
confidence: <0-100>
rationale: <2-4 行。なぜこの分類・confidence になったか。設計判断が要る場合はその論点も明記>
suggested_approach: <自動実装する場合の修正方針 1-3 行。target_files への変更概要>

## 禁止事項

- 推測で「修正可能」と決めつけない。本文 + コードから読み取れる範囲のみで判断する
- feature / question 分類のものに高い confidence を付けない（自動対応の対象外）
- target_files は **実在するファイル** のみを書く（推測のパスを書かない）
- 既に類似の未マージ PR が存在する場合（`gh pr list --search "<keyword>" --state open` で確認）は confidence を 50 未満に下げる
```

### Step 3: 自動実行ガードと分類

各 issue を以下のしきい値で 3 分類する。

分類は **上から順に** 評価し、最初に該当した区分で確定する（優先順 1 → 2 → 3）。

1. ⚪ **drop**: `confidence < 50` または `classification == unclear` のいずれかに該当（最優先で判定。他条件は問わない）
2. 🟢 **auto-execute**: 上記 ⚪ に該当せず、かつ次をすべて満たす:
   - `needs_design_decision == false`
   - `confidence >= 80`
   - `estimated_change_scope` ∈ {`small`, `medium`}
   - `classification` ∈ {`bug`, `refactor`, `docs`, `chore`, `test`}
3. 🟡 **defer**: 上記いずれにも該当しなかったすべて（`confidence >= 50` で 🟢 条件のうち 1 つ以上を欠くもの。`needs_design_decision==true` / `classification ∈ {feature, question}` / `estimated_change_scope==large` / `confidence` が 50-79 帯 — のいずれか）

この優先順により `bug` 分類でも `confidence < 50` なら ⚪ 確定。`feature` 分類でも `confidence < 50` なら ⚪ 確定。「⚪ 優先 → 🟢 ガード → 残り全部 🟡」で重複・優先順曖昧さを排除する。

`--dry-run` 指定時は 🟢 をすべて 🟡 に降格する（実装を行わない）。`--issue=N` モードでは `--limit` を無視（対象が 1 件確定のため）。

🟢 が `--limit` を超える場合、**confidence 降順** に並べ替えて先頭 `LIMIT` 件のみ実装対象とする。残りは 🟡 に降格して「next-run」タグと「次回実行で対応」のメモを `rationale` に追記する。**Step 5 ヘッダの件数表記は降格適用後** の値を使う（`🟢 = LIMIT 件 / 🟡 = 元 🟡 + 降格分` で合算）。N と内訳合計が常に一致するよう保証する。

### Step 4: 実装ループ（🟢 を 1 件ずつ直列処理）

並列実装は同一ファイルの衝突・worktree 管理の複雑度・CI 負荷の観点から行わない。**1 件ずつ直列** で処理する。

**操作主体について**: Step 4a〜4f の各サブステップは **Claude 本体が直接実行** する（Step 2 の triage 分析以外で `Agent` を起動しない）。「`bugfix` skill の手順に準拠」「`check` skill の手順に準拠」等の表現は、それらの SKILL.md を参照しつつ **本 skill の文脈内で順に実行する** という意味であり、subagent の起動ではない。

各 issue について以下を実行:

#### 4a. ブランチ作成

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
git checkout "$DEFAULT_BRANCH"
git pull --ff-only
SLUG=$(echo "<issue_title>" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-40)
BRANCH="fix/issue-${ISSUE_NUMBER}-${SLUG}"
git checkout -b "$BRANCH"
```

`git symbolic-ref refs/remotes/origin/HEAD` が空（initial fetch 不足）の場合は **skill 全体を終了**: 未処理の 🟢 をすべて `ACTIONS_DEFERRED` に「failed: default branch unresolved」で記録し、`git checkout "$ORIGINAL_BRANCH"` で戻して Step 5 のレポートへ進む。`main` / `master` の決め打ちフォールバックはしない（独自命名のリポジトリで誤爆するため）。

#### 4b. 実装

`bugfix` skill の手順に準拠して実装する（subagent 起動ではなく、本 skill の文脈内で順に実行）:

1. issue 本文と `target_files` から関連 code path を読む
2. `bug` の場合は再現可能性を確認（テストが書けるなら failing test を先に書く）
3. 根本原因に対する **最小修正** を適用する（リファクタやスタイル修正を抱き合わせない）
4. 関連箇所のテストを追加・更新する（`test` 分類なら本体）

実装中に「設計判断が要る」「想定外のスコープに広がる」「target_files が間違っていた」と判明したら **即座にループ脱出**:

```bash
git checkout "$ORIGINAL_BRANCH"
git branch -D "$BRANCH"
```

該当 issue を `ACTIONS_DEFERRED` に「escalated during implementation: <理由>」で記録し、次の issue へ。

#### 4c. 検証

`check` skill の手順でテスト・リント・ビルド dry-run を実行。**いずれかが失敗** したら以下のいずれか:

- 失敗が **自分の変更に起因する** ものなら最大 2 回まで自動修正を試みる
- 修正困難 / 関連性不明 / 既存からの failure なら **ループ脱出** して 4b 同様にブランチ破棄、`ACTIONS_DEFERRED` に「check failed: <理由>」で記録

#### 4d. コミット

`commit` skill の手順に準拠（プロジェクトのコミット規約を `git log --oneline -10` から推定）。コミットは **1 つにまとめる**（自動 squash の手間を増やさない）。コミットメッセージ末尾に `Closes #<ISSUE_NUMBER>` を含めない（PR 本文側で行う）。

#### 4e. Push & PR 作成

`create-pr` skill の手順に準拠。PR タイトルは **issue タイトルから派生** させる（70 字以内、動詞始まり、`Fix:` 等のプレフィックスはプロジェクトのコミット規約に合致する場合のみ追加。issue タイトルが既に動詞始まりで簡潔ならそのまま流用する）。PR 本文に必ず `Closes #<ISSUE_NUMBER>` を含めて issue リンクを確立する:

```bash
git push -u origin "$BRANCH"
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<実装内容 1-3 行>

## Changes
- <変更点 bullet>

## Test plan
- [x] <実行済テスト>
- [ ] <追加で確認すべき項目>

Closes #<ISSUE_NUMBER>
EOF
)"
```

PR URL を捕捉して `ACTIONS_TAKEN` に追記。

#### 4f. ブランチ戻し

```bash
git checkout "$ORIGINAL_BRANCH"
```

次の issue ループへ。

#### 4g. 失敗時の挙動

- 個別の `gh` / `git` コマンド失敗はその issue だけ `ACTIONS_DEFERRED` に「failed: <理由>」で記録し、ブランチを破棄して次へ
  - **push 成功後に PR 作成だけ失敗した場合**: ローカルブランチ削除に加え、`git push origin --delete "$BRANCH"` でリモートブランチも削除する（次回実行時に `-linked:pr` 相当のフィルタで取りこぼすのを防ぐ）。リモート削除自体が失敗した場合はその旨も `ACTIONS_DEFERRED` に「remote-leftover: <branch>」で追記し、続行する（リモートブランチが残るのは許容: 「失敗・スキップ」節に明記され追跡可能なため、次回手動でクリーンアップする）
- 同種の失敗（例: push 認証エラー / rate limit / ネットワーク断）が連続 2 件以上発生したら以降のループを **中断** し、未処理の 🟢 をすべて 🟡 に降格する。中断時も最後に `git checkout "$ORIGINAL_BRANCH"` を実行してブランチ位置を戻す（途中で破棄したブランチが残らないよう確認）

### Step 5: 最終レポート

標準出力に次の形式で整形（Routine の通知本文として読める粒度に）:

```
# Solve issues report (limit=<LIMIT>)

対象 repo: <REPO>
対象 issue: <件数>件 (🟢 <件数> / 🟡 <件数> / ⚪ <件数>)        # Step 3 分類完了後の値（`--dry-run` / `--limit` 超過の降格をすべて反映済み）。Step 4 着手後に失敗したものは 🟡 に含めず「失敗・スキップ」節へ分離
mode: <execute | dry-run>

## 自動処理 (🟢)
### Created PRs (<件数>)
- <PR url> "<title>" — Closes #<issue> [conf=<score>, class=<...>]
  ...

## 要確認 (🟡)
### 設計判断必要 / 確信度低 / scope 過大
- #<N> "<title>" (conf=<score>, class=<...>, scope=<...>) — <理由 1 行>
  ...
### 降格 (limit 超過 / dry-run)
- #<N> "<title>" (conf=<score>) — limit-exceeded: 🟢 だが limit=<LIMIT> を超えたため次回実行で対応
- #<N> "<title>" (conf=<score>) — dry-run: 🟢 条件は満たすが --dry-run のため実装スキップ
  # 該当 0 件なら `- (なし)`
  ...

## 失敗・スキップ
- #<N> "<title>" — <理由 1 行>            # Step 4 で実装着手後に失敗 / 中断 / コマンド不在ガード等で `ACTIONS_DEFERRED` に入ったエントリを集約
  ...

## 参考 (⚪ 破棄, conf<50 / unclear)
- 上位 <最大10件>。<件数> 件超は件数のみ
```

- 各セクションで該当エントリが 0 件の場合は箇条書きの代わりに `- (なし)` の 1 行を出す（セクション自体は省略しない）
- 各行は **1 行サマリのみ**（rationale / suggested_approach は再掲しない。詳細は PR 本文・issue 側に残るため）
- `mode:` の値は `execute` / `dry-run` のいずれかに固定

レポートは標準出力にのみ書き、外部送信（メール / Slack 等）はしない。Routine 側の通知機構へ渡すかは呼び出し側の責務。

## Notes

- **`Agent` ツール呼び出しでは必ず `model` を明示する**:
  - Step 2 (issue triage 分析): `model: "sonnet"`
- 実装ループ中は `git status` を頻繁に確認し、想定外のファイル変更が混入していないか目視する。混入があったらブランチ破棄して 🟡 降格
- `Closes #N` 記法は **PR 本文側のみ** に書く（コミットメッセージにも入れると closing keyword が複数箇所に分散して追跡しづらくなるため、PR 本文に集約）。GitHub の close 動作自体は重複しても 1 回しか発火しないので機能上の害は無いが、規約として一元化する
- **本 skill が行う state 変更は「ブランチ作成」「コミット」「push」「PR 作成」のみ**。issue へのコメント追加 / 既存 PR の更新 / label 編集 / assign / milestone 変更は一切しない
- **初回運用は `--dry-run` 推奨**: 1〜2 週間レポートだけ眺めて triage の誤検知傾向を確認してから自動実行に切り替える
- **使用コマンド一覧**（`~/.claude/settings.json` の `permissions.allow` 登録で実行時確認を減らせる）:
  - `gh repo view`, `gh issue list`, `gh issue view`, `gh pr list`, `gh pr create`
  - `git status`, `git checkout`, `git pull`, `git branch`, `git commit`, `git push`, `git symbolic-ref`
  - 内部ツール: `Agent`, `TaskCreate`

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「feature でも本文に方針が書いてあれば自動対応で良い」 | 設計判断は人間に残す。`file-issue` で書かれた `## Proposed approach` も最終確認が必要 |
| 「scope=large でも分割すれば自動対応できる」 | 自動分割は別の設計判断。large はすべて 🟡 に降格して人間に委ねる |
| 「`--limit` を外して全部やってしまえ」 | CI 負荷とレビュー負荷で運用破綻する。limit は守る |
| 「triage が一度通った issue は二度目もそのまま実装で良い」 | issue 本文・関連 PR は更新される。毎回 triage からやり直す |
| 「test が落ちても無関係なら無視して PR 化」 | 無関係を断定するには調査が必要。落ちている状態で PR 化しない |
| 「`Closes #N` を書かなくても手動で閉じれば良い」 | 自動 close 連携が切れると `pr-triage` skill 側の作業が増える。必ず PR 本文に書く |
| 「並列で実装すれば速い」 | 同一ファイル衝突 / worktree 管理 / CI バースト負荷でリスクが大きい。直列で良い |

## よくある失敗

- **既存 PR との重複**: `-linked:pr` で除外しているが、別ブランチで未関連 PR が走っているケースがある。Step 2 で subagent が `gh pr list --search` で確認することで二重作成を防ぐ
- **ブランチ取り残し**: 実装失敗時にブランチ削除を忘れるとローカルが汚れる。Step 4 の各失敗パスで必ず `git branch -D` を実行
- **コミット規約のズレ**: プロジェクト独自の prefix (`:sparkles:` 等の絵文字 / `feat:` / `fix:` 等) を `git log` から推定し損ねる。`commit` skill 同等の手順で必ず最近 10 件のスタイルを確認
- **テスト手順未定義のリポジトリ**: `check` skill 相当が走らせるコマンドが見つからない場合、テスト無しで PR を作るのは危険。「test 手順が検出できない」を理由に当該 issue は 🟡 降格する（Routine 運用前にプロジェクト側でテストコマンドを定義しておく前提）
- **大量 PR 作成による rate limit**: `--limit` を大きくしすぎると GitHub API rate limit や CI 同時実行上限に当たる。Routine の周期に合わせて控えめに設定する

## 関連

- `bugfix` — 単一バグの実装フェーズ。本 skill は内部でこの手順に準拠
- `check` — テスト・リント・ビルド検証。本 skill は内部でこの手順に準拠
- `commit` — コミット作成。本 skill は内部でこの手順に準拠
- `create-pr` — PR 作成。本 skill は内部でこの手順に準拠
- `file-issue` — issue 起票。本 skill の **逆方向**（issue を生やす側）。両者を組み合わせると issue ライフサイクル全域をカバーできる
- `pr-triage` — マージ後 PR の triage / follow-up 起票。本 skill の **後段**
