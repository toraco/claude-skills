---
name: pr-triage
description: 指定範囲のクローズ済み Pull Request を一括点検し、PR マージで閉じるべきだったが open のまま残っている issue をクローズし、PR 本文や out-of-scope 記載から派生する follow-up を新規 issue として起票する。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# PR triage: $ARGUMENTS

**使い方**: `/pr-triage [--repo=owner/name] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--days=N] [--pr=N] [--dry-run]`

## Goal

クローズ済み PR を一括点検し、PR 起因のフォローアップが GitHub の issue 状態に正しく反映されている状態にする。具体的には:

1. PR のマージで本来クローズされるべきだったが、まだ open のまま残っている issue を **クローズする**
2. PR 本文・レビューコメント・out-of-scope 記載などから派生したフォローアップ作業について、**まだ issue 化されていないものを新規 issue として起票する**

実装は行わない。「何を残し、何を片付けたか」を GitHub の issue 上で正しく整える skill。

## いつ使うか

- Claude Code Routine からの定期実行で、毎日昨日マージされた PR を triage する（本 skill の主要想定）
- リリース直後やスプリント終わりに、複数 PR の追跡漏れを一括で点検する
- 単一 PR について後始末漏れがないかチェックする (`--pr=N`)

使わない場面:

- 1 件の bug / task を自分で起票したい → `file-issue`
- まだ未マージの PR の差分をレビューしたい → `local-review`
- 実装に手を入れたい → `bugfix` / `local-review`

## 前提

- リポジトリで `gh` (GitHub CLI) の認証が通っている
- 対象リポジトリの issue write 権限がある（クローズ・起票のため）
- Routine 実行時はユーザー確認を介さず autonomous に動くため、後述の「自動実行ガード」を満たすケースだけ state を変更する

## 引数

| フラグ | 既定 | 意味 |
|---|---|---|
| `--repo=owner/name` | カレントの `gh repo view` | 対象リポジトリ |
| `--since=YYYY-MM-DD` | 24 時間前 (UTC) | この日時以降に close された PR を対象 |
| `--until=YYYY-MM-DD` | 実行時刻 (UTC) | この日時より前に close された PR を対象 |
| `--days=N` | 未指定 | `--since=N日前 (UTC 0:00)`, `--until=今日 (UTC 0:00)` のショートハンド |
| `--pr=N` | 未指定 | 単一 PR のみを対象（時間範囲を上書き） |
| `--dry-run` | false | 検出のみ。issue クローズ・起票を行わずレポートだけ出力 |

`--since` / `--until` / `--days` / `--pr` のいずれも未指定なら `--days=1` 相当として動作する。時刻はすべて UTC で扱う（GitHub の `closed:` 検索が UTC 解釈のため、JST 換算で求めると半日ぶんずれる）。

`--pr=N` 指定時は `SINCE` / `UNTIL` を `n/a` として扱い、後述 Step 5 のレポートヘッダは `(single PR mode: #N)` と表記する。

## ワークフロー

### Step 0: Setup

- 状態変数: `REPO`, `SINCE`, `UNTIL`, `PR_LIST`, `DRY_RUN`, `ACTIONS_TAKEN = []`, `ACTIONS_DEFERRED = []`, `ACTIONS_DROPPED = []`
- 引数を解析して上記に格納
- `gh repo view <REPO>` で存在確認。失敗したら停止し理由をレポートに残して終了
- **タスクリスト化**: `TaskCreate` で主要ステップ（PR 列挙 / 各 PR の triage 分析 / issue クローズ実行 / follow-up 起票実行 / 最終レポート）を登録し、進行に合わせて `in_progress` / `completed` を更新

### Step 1: 対象 PR の列挙

- `--pr=N` 指定時はその 1 件だけを `gh pr view N --repo $REPO --json number,title,body,state,mergedAt,closedAt,author,url,labels,closingIssuesReferences,baseRefName` で取得
- それ以外は次で取得:

```bash
gh pr list --repo $REPO --state closed \
  --search "closed:$SINCE..$UNTIL" \
  --json number,title,body,state,mergedAt,closedAt,author,url,labels,closingIssuesReferences,baseRefName \
  --limit 100
```

- `mergedAt` が null（マージされず close）された PR は **対象外** とし `ACTIONS_DROPPED` に「abandoned: skipped」で記録
- 残った PR が 0 件なら最終レポートに「対象 PR なし」と記載して終了

### Step 2: 各 PR の triage 分析（並列）

`Agent` ツール (`subagent_type: "Explore"`, `model: "sonnet"`) を **PR 件数分 1 メッセージ内で並列呼び出し** する。10 件以上ある場合は 5 件ずつのバッチで順次実行（バッチ内は並列、バッチ間は直列）。`--pr=N` 指定で対象 PR が 1 件の場合も同じく `Agent` を 1 回呼び出す（直接処理に切り替えない: 出力フォーマットの一貫性を保つため）。

各 subagent への入力:

- 該当 PR 1 件分の JSON（`number / title / body / mergedAt / url / labels / closingIssuesReferences / baseRefName`）
- 同 PR の `gh pr view N --repo $REPO --comments --json comments,reviews` 出力
- `REPO`

各 subagent への指示プロンプト（verbatim）:

```
あなたは PR triage アナリストです。以下の PR 1 件を読み、フォローアップを 2 種類抽出してください。

## 抽出対象 1: クローズすべき open issue
- PR 本文 / レビューコメント / 通常コメント中の issue 参照（`#N`、`owner/repo#N`、"Closes #N" / "Fixes #N" / "Resolves #N" / "addresses #N" / "see #N" 等）を漏れなく拾う
- 各参照について `gh issue view N --repo <参照先 repo> --json number,state,title,url` で現在の state を取得
- 以下を **すべて満たす場合のみ** 「クローズ候補」として出力:
  - 当該 issue が **OPEN** である
  - PR が **マージ済み** (`mergedAt` が non-null) である
  - PR の差分・本文・コメントから「この PR で実質的に当該 issue が解決された」と読み取れる
- "see #N" / "related to #N" など参照のみで未解決のものは出力しない

## 抽出対象 2: 新規 issue 化すべき follow-up
- PR 本文中の「Follow-up」「TODO」「Out of scope」「Future work」「Next steps」「残課題」「別 issue で対応」などの節
- レビューコメントで「これは別 issue にしよう」「後で対応」と合意された項目
- 各項目について `gh issue list --repo $REPO --search "<キーワード>" --state all --limit 10` で重複候補を検索し、明確に同一なら候補から除外
- 残ったものを「follow-up 候補」として出力

## 出力フォーマット (YAML 風)

候補が無い場合も該当キーは必ず出力し、値は空配列 `[]` とする（省略しない）。

close_candidates:
  - issue_repo: <owner/name>
    issue_number: <N>
    issue_title: <現タイトル>
    confidence: 0-100
    rationale: <なぜクローズして良いか 1-2 行>
    closing_keyword: <"Closes" | "Fixes" | "Resolves" | "implicit">

followup_candidates:
  - title: <一行・動詞始まり 70 文字以内>
    body_outline: <論理行 2-5 行で要約。関連ファイルパス・行番号があれば記載>
    source_quote: <PR 本文 / コメントから引用 1-3 行。"Out of scope:" / "## Follow-up" のような節ヘッダがあれば併記する>
    duplicate_check: '<query="検索文字列" → 結果。重複疑いの issue 番号 (state) を列挙、なければ "none">'
    confidence: 0-100

## confidence スケール（目安）
- 90-100: 明示的な closing keyword (Closes/Fixes/Resolves) + PR タイトルや本文と issue タイトルの内容一致 + マージ済み。または `## Follow-up` / `Out of scope:` 節に具体的な記述（対象ファイル名・関数名・症状）あり。
- 80-89: 明示節での follow-up 記載があるが具体性がやや弱い。または closing keyword はあるが PR の差分から「実質解決」が読み切れない。
- 50-79: コメントで「別 issue で」と合意されたがレビュアーの意見が分かれている。または推測補完を含む。
- 0-49: "see #N" / "related to #N" 等の参照のみ。あるいは TODO の文脈が短すぎて実体が読めない。

## 禁止事項
- PR の差分そのものに踏み込んだコードレビューはしない（triage に集中）
- 推測で "Closes" キーワードを補わない（本文に書かれている文字列のみを根拠とする）
- 既存 issue が見つかったのに「タイトルが違うから別件」として無理に follow-up 化しない
```

### Step 3: 自動実行ガードと分類

各候補を以下のしきい値で 3 分類する。

- 🟢 **auto-execute**: 自動でアクションを取って良い
  - close_candidate: `confidence >= 80` **かつ** `closing_keyword` が `Closes` / `Fixes` / `Resolves` のいずれか（GitHub が auto-close すべきだったが効かなかったケース、典型は cross-repo 参照や非デフォルトブランチ への merge）
  - followup_candidate: `confidence >= 80` **かつ** `duplicate_check == "none"`
- 🟡 **defer**: 自動実行は見送り、レポートに記載して人間に委ねる
  - 上記いずれにも該当しないが `confidence >= 50` のもの
- ⚪ **drop**: ノイズとして破棄（最終レポートに参考行のみ残す）
  - `confidence < 50`

`--dry-run` 指定時は 🟢 をすべて 🟡 に降格する（実アクションを取らない）。

### Step 4: アクション実行

#### 4a. Issue クローズ（🟢 close_candidates）

```bash
gh issue close <N> --repo <issue_repo> --reason completed \
  --comment "Closed via pr-triage skill: resolved by #<PR_NUMBER> (merged at <mergedAt>) but did not auto-close (likely cross-repo or non-keyword reference). PR: <PR_URL>"
```

コメント文言は固定テンプレ（cross-repo / 非デフォルトブランチ / etc. の個別事情をここに書き分けない。理由分析は close_candidate の `rationale` 欄でレポートに残す）。実行結果を `ACTIONS_TAKEN` に追記。

#### 4b. Follow-up issue 起票（🟢 followup_candidates）

```bash
NEW_URL=$(gh issue create --repo $REPO --title "<title>" --body "$(cat <<'EOF'
## Summary
<body_outline>

## Origin
Filed automatically by pr-triage skill from #<PR_NUMBER> (<PR_URL>).

<source_quote_with_blockquote_prefix>
EOF
)" --json url -q .url)
```

- `body_outline` は段落としてそのまま埋め込む（GFM hard break は使わない / 改行は単なる段落改行）。
- `<source_quote_with_blockquote_prefix>` は source_quote の各行頭に `> ` を付与した GFM blockquote にする。複数行の場合も全行に `> ` を付ける（段落 quote は使わない）。
- `--json url -q .url` は `--body` の後ろ（コマンド末尾）に置く。`gh issue create` の `--json` は CLI バージョンによっては未対応のため、その場合は標準出力末尾の URL を捕捉する fallback (`NEW_URL=$(... | tail -n1)`) を使う。

`$NEW_URL` を `ACTIONS_TAKEN` に追記し、Step 5 のレポート `Filed follow-up issues` 節に反映する。`gh issue create` の `--json` を使えない古い CLI なら標準出力末尾に出る URL を捕捉する。ラベルは付与しない（プロジェクト独自規約と食い違うリスクを避ける。`file-issue` skill と同方針）。

#### 4c. 失敗時の挙動

- 個別の `gh` コマンド失敗（権限 / ネットワーク / 既にクローズ済み等）はその項目だけ `ACTIONS_DEFERRED` に「failed: <理由>」で記録し、残りの処理は継続する
- 同種の失敗（例: 認証エラー / rate limit）が連続 3 件以上発生したら以降の自動実行を中断し、未処理候補をすべて 🟡 扱いに切り替える

### Step 5: 最終レポート

標準出力に次の形式で整形（Routine の通知本文として読める粒度に）:

```
# PR triage report (<SINCE> .. <UNTIL>)        # --pr=N モードでは "(single PR mode: #N)"

対象 repo: <REPO>
対象 PR: <件数>件 (うちマージ済み <件数> / abandoned <件数>)        # 単一 PR モードでもこの行は出す
mode: <execute | dry-run>                                        # 値はこの 2 値のうちいずれか固定

## 自動実行 (🟢)
### Closed issues (<件数>)
- <repo>#<N> "<title>" — closed by PR #<M>
  ...
### Filed follow-up issues (<件数>)
- <new issue url> "<title>" — from PR #<M>     # url は 4b で捕捉した $NEW_URL
  ...

## 要確認 (🟡)
### Issue close 保留
- <repo>#<N> "<title>" (conf=<score>, keyword=<...>) — <理由>: <PR url>
  ...
### Follow-up 起票保留
- "<title>" (conf=<score>) — <PR url> から抽出。重複疑い: <issue 番号 or なし>
  ...

## 失敗・スキップ
- <件: 理由>

## 参考 (⚪ 破棄, conf<50)
- 上位 <最大10件>。<件数> 件超は件数のみ
```

- 各セクションで該当エントリが 0 件の場合は箇条書きの代わりに `- (なし)` の 1 行を出す（セクション自体は省略しない）
- `Filed follow-up issues` / `Issue close 保留` / `Follow-up 起票保留` の各行は **1 行サマリのみ**（duplicate_check / source_quote / body_outline は **レポートには再掲しない**。詳細はそれぞれ起票された issue 本文・PR 内に残るため）
- `mode:` の値は `execute` / `dry-run` のいずれかに固定（`live` `executed` 等の表記揺れは禁止）

レポートは標準出力にのみ書き、外部送信（メール / Slack 等）はしない。Routine 側の通知機構へ渡すかは呼び出し側の責務。

## Notes

- **`Agent` ツール呼び出しでは必ず `model` を明示する**:
  - Step 2 (PR triage 分析): `model: "sonnet"`
- 時刻は **UTC** で統一する。`--days=1` の解釈は「実行時刻時点の UTC 0:00 から 24 時間前まで」
- GitHub が auto-close 済みの issue は `gh issue view` の state が `CLOSED` で返るので候補から自然に外れる。skill 側で追加フィルタを書く必要はない
- cross-repo の `owner/repo#N` 参照も拾うが、`gh issue view` が権限不足で失敗した場合はその候補は 🟡 に降格する
- **本 skill が行う state 変更は「issue close」と「新規 issue create」の 2 つだけ**。close 時の `--comment` で付与する close 理由コメント以外、独立コメントの追加 / label 編集 / assign / milestone 変更は一切しない
- **初回運用は `--dry-run` 推奨**: 1〜2 週間レポートだけ眺めて誤検知傾向を確認してから自動実行に切り替える
- **使用コマンド一覧**（`~/.claude/settings.json` の `permissions.allow` 登録で実行時確認を減らせる）:
  - `gh repo view`, `gh pr list`, `gh pr view`, `gh issue list`, `gh issue view`, `gh issue close`, `gh issue create`
  - 内部ツール: `Agent`, `TaskCreate`

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「`Closes #N` があるなら閉じればよい」 | GitHub が既に auto-close しているはず。state が open のものだけ閉じる（cross-repo / 非デフォルトブランチ merge の取りこぼし対応が本来の用途） |
| 「PR の TODO っぽい記述は全部 issue 化しよう」 | スコープ外 / 議論中 / 既に issue 化済みのものを乱発するとノイズ。`Out of scope:` / `Follow-up:` のような明示節 + confidence>=80 だけを 🟢 にする |
| 「abandoned PR (close-without-merge) も triage しよう」 | マージされていない以上 issue 状態に影響しない。`ACTIONS_DROPPED` に skipped 記録だけ残す |
| 「label も自動推定して付けてしまえ」 | プロジェクト独自規約と食い違うリスク大。label は人間に委ねる |
| 「Routine では `--dry-run` を最初から外そう」 | 誤検知の傾向を見ずに実行すると issue 状態を荒らすリスクがある。最初は dry-run 推奨 |
| 「`closingIssuesReferences` が空なら参照なしと判定して終わり」 | この欄は GitHub UI で linked された issue だけ。本文中の `Closes #N` 文字列や cross-repo 参照は subagent が本文読解で別途拾う必要がある |

## よくある失敗

- **タイムゾーン不整合**: JST で「昨日」を計算すると UTC 換算で対象 PR が抜ける。常に UTC で扱う
- **Cross-repo の権限不足**: 別組織の private repo の issue を閉じようとして失敗 → 🟡 に降格して人間に委ねる
- **Follow-up 重複**: `gh issue list --search` だけだと完全には拾えない（ラベル違い / クローズ済み / タイトル文言違い等）。検索は補助で、最終判断は subagent の confidence に依存する。閾値 80 を下回ったら 🟡 に下げる
- **同じ PR が複数日にまたがって対象になる**: `--since/--until` の境界が UTC 0:00 なので二重 triage はしない設計だが、Routine の cron 設定がずれていると同じ PR を 2 度処理する可能性がある。close 済み issue / 既存 follow-up issue は subagent 側で除外されるため致命傷にはならないが、運用時は cron 周期と `--days` を一致させる

## 関連

- `file-issue` — 1 件の bug / task を自分で起票したい場合はこちら。本 skill は複数 PR の triage 専用
- `local-review` — マージ前の PR レビュー。本 skill は **マージ後** のクリーンアップ
- `bugfix` — issue 起票後の実装フェーズ
