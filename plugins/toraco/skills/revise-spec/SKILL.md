---
name: revise-spec
description: 仕様書（プラン / 設計書 / CLAUDE.md / docs/specs/ 等）を見直したいときに使う。仕様単体のレビュー（矛盾・曖昧さ・不足の検出）と、仕様×実装の drift 抽出（乖離の検出）の両方をサポート。バイアス排除された subagent に読ませ、検出した問題を Tidy First 原則で仕様側に反映する。
allowed-tools: Bash(git symbolic-ref:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(ls:*), Read, Edit, Write, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate
---

# Revise spec: $ARGUMENTS

**使い方**: `/revise-spec [--mode=spec-only|with-impl] [仕様パス] [--interactive]`

## Goal

仕様書（プラン・基本設計書・CLAUDE.md・docs/specs/ 等、テキストで書かれた「何を作るか / どう振る舞うか」の記述）を **バイアス排除された第三者視点** で見直し、見つかった問題を Tidy First 原則（仕様更新と実装修正を分離）で仕様側に反映する。

実装コードの修正は扱わない。実装側の修正が必要と判断された項目は最終レポートに受け渡しリストとして積み、`bugfix` / `local-review` に委ねる。

## いつ使うか

- 仕様書・プラン・設計書を書いた直後、内部の矛盾・曖昧さ・不足を洗い出したい (**Mode A**)
- 実装を一通り書いた後、コード読み返しや動作確認で仕様側の不備・drift に気づいた (**Mode B**)
- PR レビューで「仕様が曖昧」「仕様と違う」と指摘され、仕様側を直す必要がある
- 既存仕様に新しい機能追加を反映する前に、現状仕様の健全性を確認したい

使わない場面:

- 仕様を新規作成するとき → `make-plan`
- コードのバグ修正のみ（仕様はそのまま） → `bugfix` / `local-review`
- agent 向け指示プロンプト（skill / slash command）の品質改善 → `empirical-prompt-tuning`
- コミット / PR 作成 → `/commit` / `/ship`

## 前提

- 本 skill は共通方法論 `${CLAUDE_SKILL_DIR}/../_shared/bias-free-review.md` に従う（subagent dispatch / scoring 並列化 / confidence 表示 / AskUserQuestion 運用 / Tidy First の規約）。**Step 0 開始時に必ず Read すること**
- `Agent` ツールで subagent を dispatch できる環境であること（並列は最低 2、できれば 3 までスケール）
- 対象仕様がテキストファイルとして存在する（口頭仕様・チャットログのみはサポート外）
- Mode B の場合、実装 diff が `git` で取得可能な状態であること

## ワークフロー

### Step 0: Mode と対象の決定

- 状態変数を宣言: `MODE`（`spec-only` or `with-impl`）、`SPEC_PATHS`（対象仕様ファイル配列）、`DIFF_RANGE`（Mode B のみ）、`INTERACTIVE`（既定 `false`）、`SKIPPED_ITEMS = []`（ユーザーがスキップを選んだ項目の id 一覧）
- **タスクリスト化**: `TaskCreate` で主要ステップ（対象特定 / バイアス排除スキャン / 指摘抽出 / ユーザー確認 / 仕様更新 / 整合性確認 / 最終レポート）をタスクとして登録。各ステップ開始時に `in_progress`、完了時に `completed` に更新

#### 0a. 引数解析

- `$ARGUMENTS` に `--mode=spec-only` があれば `MODE = spec-only`
- `--mode=with-impl` があれば `MODE = with-impl`
- 未指定の場合は後述の自動判定を行い、**判定結果をそのままデフォルトとして採用する**（確認は挟まない。共通方法論「Step 0 の自動確定」に従う）
- 引数にパス（`.md` や `docs/` 配下）が含まれれば `SPEC_PATHS` の初期候補に入れる
- `--interactive` があれば `INTERACTIVE = true`。このときのみ Step 0 の各項目を従来通り `AskUserQuestion` で確認する

#### 0b. 対象仕様の特定

引数でパスが指定されていない場合は、以下の順で候補を探索する:

1. `.claude/plans/` 配下の最終更新が最新のプランファイル（`ls -t` 相当）
2. `docs/specs/` 配下の関連ファイル（Mode B 候補なら変更ファイル名を grep キーワード源として使ってよい。コミットメッセージは禁止。キーワード源が無ければこの優先度はスキップ）
3. リポジトリルートの `CLAUDE.md` および変更ファイルの祖先ディレクトリにある `CLAUDE.md`
4. 上記いずれも無ければ `AskUserQuestion` でユーザーに対象パスを問う

**対象確定ルール**（共通方法論「Step 0 の自動確定」に従う）:
- 引数でパスが明示されている → それを `SPEC_PATHS` として即確定
- 候補が 1 件以上見つかった → **最上位の優先度の中で最終更新が最新の 1 件を自動採用**し、確認は挟まない。採用しなかった候補は Step 0e の完了報告に「他候補」として列挙する
- 候補が 0 件 → 自動確定できないので `AskUserQuestion` で対象パスを問う
- `INTERACTIVE = true` のときのみ、以下の従来ルールで `AskUserQuestion` を発行する:
  - **候補が 4 件以下**: 全件を options に列挙。優先度 1 を先頭、以下優先度順。優先度を跨いで混在表示（例: 優先度 1 が 2 件 + 優先度 2 が 1 件 = 3 options）
  - **候補が 5 件以上**: 上位 3 件 + 「Other (パス手入力)」の 4 options に圧縮。「上位 3 件」の選び方:
    1. 優先度 1 (`.claude/plans/`) の中で最新更新順に最大 3 件
    2. 優先度 1 が 3 件未満なら、優先度 2 (`docs/specs/`) → 優先度 3 (`CLAUDE.md`) の順で最新更新順に補充
    3. Other 手入力では圧縮で外れた候補を自由記述で選べる
  - options 上限 4 は共通方法論「AskUserQuestion の運用」の制約に準拠（5 件以上になるケースは必ず Other に圧縮）

#### 0c. Mode の自動判定（`--mode` 未指定時）

以下の条件で判定:

- `git symbolic-ref refs/remotes/origin/HEAD` で default branch を検出
- `git log origin/<default>..HEAD --oneline` に 1 件以上コミットがある、かつ変更ファイルに `.md` 以外（実装コード）が含まれる → **Mode B 候補**
- それ以外 → **Mode A 候補**

判定結果は **そのまま `MODE` に採用** し、確認は挟まない。`INTERACTIVE = true` のときのみ `AskUserQuestion` で確定する。

#### 0d. Mode B 時の実装 diff 範囲確定

- `DIFF_RANGE = "origin/<default>...HEAD"` を **そのまま採用**し、確認は挟まない
- `git diff --name-only $DIFF_RANGE` の出力は Step 0e の完了報告に含め、対象仕様との対応関係をユーザーが目視で否定できる状態にする
- diff が空 / default branch を検出できない → 自動確定できないので `AskUserQuestion` でコミット範囲を問う
- `INTERACTIVE = true` のときのみ、従来通り「この diff 範囲で合っているか / 別のコミット範囲を指定するか」を `AskUserQuestion` で確認する

#### 0e. Step 0 完了報告

Step 1 に進む前に、自動確定した内容を **1 ブロックで必ず提示** する。確認質問を出さない代わりに、ユーザーが「対象が違う」と気づいて中断できる状態を作る:

```
## 対象（自動確定）
- MODE: with-impl（origin/main..HEAD に 5 コミット、実装ファイルの変更あり）
- SPEC_PATHS: .claude/plans/2026-09-03-foo.md（.claude/plans/ の最新）
  - 他候補: docs/specs/foo.md, CLAUDE.md
- DIFF_RANGE: origin/main...HEAD（変更 12 ファイル）

違う場合は中断し、`/revise-spec --mode=<mode> <仕様パス>` で明示するか `--interactive` を付けて再実行してください。
```

**この Step が完了するまで Step 1 には進まない**。対象が曖昧なまま走らせると以降のスキャンが無価値になる。

### Step 1: バイアス排除スキャン

Mode に応じて `Agent` ツールを呼び出す。**全呼び出しで `subagent_type: "Explore"`、`model: "sonnet"` を明示すること**（未指定だと品質差が出る）。

#### Mode A: 仕様単体レビュー（subagent 1 個）

1 メッセージで 1 つの Agent を呼び出し、次のプロンプトを渡す:

```
あなたは <SPEC_PATHS> を白紙で読むレビュアーです。

## タスク
以下のパスの仕様書を読み、問題点を箇条書きで抽出してください。
<SPEC_PATHS>

## 抽出対象
- 内部矛盾: 仕様内で相反する記述がある
- 曖昧な表現 / 未定義用語: 読み手によって解釈が割れる記述、定義なしに登場する用語
- 機能要件の不足: エラーケース・境界条件・異常系が言及されていない
- 暗黙の前提: 記述されないと再現性がない前提条件
- 未決定事項: 「TBD」「要検討」「いずれか」などの保留項目

## 禁止事項
- 実装コードを読まないこと（ファイル Read は `SPEC_PATHS` に限定）
- プロジェクト規約 (`CLAUDE.md` など) からの推論で補わないこと
- スタイル指摘 (typo / 句読点 / 表記ゆれ) は除外すること

## 出力フォーマット
各指摘について次の形式で返す:
- id: A1, A2, ...（1-origin 連番）
- file: <仕様ファイルのパス>
- location: <該当節のタイトル or 行番号>
- category: contradiction | ambiguity | missing | implicit | undecided
- summary: <1 行で問題の要約>
- detail: <2-4 行で問題の詳細>
- quote: |
    <該当箇所を 1-5 行引用>
```

#### Mode B: 仕様 × 実装 drift 抽出（subagent 2 個を並列）

**1 メッセージ内で 2 つの Agent を並列呼び出し** する。互いの情報源を禁止し合うことで、書き手バイアスのない両面スキャンを実現する。

##### 1B-spec: 仕様のみから期待挙動を抽出

プロンプト:

```
あなたは <SPEC_PATHS> を白紙で読む仕様アナリストです。

## タスク
以下のパスの仕様書だけを読み、仕様が規定する「期待される挙動」を統一フォーマットで列挙してください。
<SPEC_PATHS>

## 禁止事項
- 実装ファイル (`.ts` / `.tsx` / `.js` / `.py` / `.rb` など) を Read しないこと
- `git diff` / `git log` / `git show` を実行しないこと
- 実装から仕様を推論しないこと（仕様書に書かれていることのみを根拠とする）

## 出力フォーマット
各挙動について次の形式で返す:
- id: S1, S2, ...（1-origin 連番、prefix `S`）
- area: <機能領域名 / エンドポイント名 / 関数名 など>
- expected: <期待される挙動 1 行>
- source: <仕様ファイル:節タイトル or 行番号>

粒度: 「入力 X に対して Y を返す」「A のときは B になる」レベルの粒度で、仕様書の記述を可能な限り網羅する（10-30 件が目安）。
```

##### 1B-impl: 実装 diff のみから実挙動を抽出

プロンプト:

```
あなたは実装コードだけを読むコードアナリストです。

## タスク
以下の `git diff` 範囲および関連する実装ファイルだけを読み、実装が実現している「実際の挙動」を統一フォーマットで列挙してください。
- DIFF_RANGE: <DIFF_RANGE>
- 主要変更ファイル: <`git diff --name-only $DIFF_RANGE` の出力>

## 禁止事項
- 仕様書・プラン・docs/ 配下・CLAUDE.md を Read しないこと
- コミットメッセージ・PR 本文を読まないこと
- 仕様を推論・想像しないこと（コードに書かれていることのみを根拠とする）

## 出力フォーマット
各挙動について次の形式で返す:
- id: I1, I2, ...（1-origin 連番、prefix `I`）
- area: <機能領域名 / エンドポイント名 / 関数名 など>
- actual: <実装されている挙動 1 行>
- source: <実装ファイル:関数名 or 行番号>

粒度: 「入力 X に対して Y を返す」「A のときは B になる」レベルで 1B-spec と揃え、あとで突合可能にする（10-30 件が目安）。
```

### Step 2: 指摘の抽出 & 4 分類

#### Mode A の場合

- Step 1 の subagent の出力をそのまま指摘リスト `ISSUES` とする
- 各指摘に分類（🔵🟣⚪）の scoring を行う（後述）。Mode A では 🟠 は発生しない

#### Mode B の場合

- Step 1 の 1B-spec 出力 `S1..Sn` と 1B-impl 出力 `I1..Im` を突合
- 突合ロジック: `area` が一致するエントリ同士を対にし、`expected` と `actual` の意味論を比較
  - 意味が一致 → drift 無し（出力しない）
  - spec にあり impl に無い → drift 1 件（仕様過剰 or 実装不足）
  - impl にあり spec に無い → drift 1 件（仕様不足 or 実装逸脱）
  - 両方あるが意味が異なる → drift 1 件（解釈の違い）
- **突合の主体は親 skill（このレイヤー）**。`area` 一致でのペアリングと「drift あり/なし」の一次判定は親 skill が行い、scoring subagent には drift と判定した 1 件（S対 / I対 / S×I 対）を渡して分類だけ任せる。scoring subagent に「仕様と実装の両方を読ませて drift を探させる」ことは禁止（両方読むとバイアスが混入する）。

#### Scoring subagent（両 Mode 共通）

全ての指摘について scoring/分類 subagent を並列呼び出しする（`subagent_type: "Explore"`、`model: "haiku"`）。並列化・バッチ規則は共通方法論「Scoring の並列化ルール」に従う。

scoring プロンプト:

```
あなたは仕様レビューの分類担当です。

## 入力
- MODE: <spec-only | with-impl>
- 指摘 / drift 項目: <1 件の詳細>
- （Mode B の場合）該当する S エントリと I エントリの対

## タスク
以下の 4 分類のいずれかを提案し、理由を添えてください。

- 🔵 spec-fix: 仕様側を直すべき
  - Mode A: 曖昧・不足・矛盾で、実装に依存せず仕様単体で直せる
  - Mode B: 実装挙動が自然で、仕様が古い / 誤り / 不足
- 🟠 impl-fix: Mode B のみ。実装の方が誤っており、仕様通りに直すべき
- 🟣 decision-needed: ユーザーの意思決定が必要
  - Mode A: 未決定事項 (TBD) で仕様起案者が決める必要
  - Mode B: 仕様・実装とも不完全で新しい合意が必要
- ⚪ out-of-scope: 指摘対象外
  - 意図的な実装詳細 (性能最適化・内部リファクタ等)
  - 故意の曖昧さ (拡張余地として残した)
  - スタイル指摘 (typo / 表記ゆれ / 命名規則)
  - lint / typecheck / formatter で自動検出可能な性質

## 出力
- id: <対応する指摘 id>
- classification: spec-fix | impl-fix | decision-needed | out-of-scope
- reason: <1-2 行で分類の根拠>
- confidence: 0-100
- suggested_options: <classification=decision-needed の場合のみ、最大 3 件の方針候補を箇条書き。それ以外は省略>
```

`suggested_options` は Step 3 で 🟣 の AskUserQuestion 選択肢として利用する。scoring subagent が方針を思いつかない場合は空配列を返し、Step 3 で親 skill が「仕様更新（内容を変更）」の自由記述に誘導する。

scoring 結果と指摘本体をマージして、ユーザー提示用の `CLASSIFIED_ISSUES` を生成する。

#### ユーザー提示

指摘リストを以下の表形式で提示:

```
## 検出された指摘 (<件数>件)

| id | 領域 | 分類 | 信頼度 | サマリ |
|----|------|------|--------|--------|
| A1 | ... | 🔵 spec-fix | 85 | ... |
| A2 | ... | 🟣 decision-needed | 70 | ... |
| ...

詳細:

### A1 🔵 spec-fix (信頼度 85)
- location: docs/specs/foo.md §3.2
- summary: ...
- detail: ...
- reason: ...
- quote / diff: ...
```

- `confidence < 50` の表示規則と `SKIPPED_ITEMS` の除外は、共通方法論「confidence の表示規則」に従う

### Step 3: ユーザー確認 (AskUserQuestion)

🔵 / 🟠 / 🟣 に分類された指摘について、`AskUserQuestion` で対応方針を確定する。質問の分割・options 上限は共通方法論「AskUserQuestion の運用」に従う（分類をまたいだ混合は OK。🔵 と 🟣 を同じ質問にまとめて良い）。

各指摘について次の選択肢を提示:

- **仕様更新（指示通り）**: skill が仕様を編集する
- **仕様更新（内容を変更）**: `notes` でユーザーが具体的な更新内容を指定する → skill がその内容で編集
- **実装側で対応**: 🟠 の場合、および Mode B で仕様が正だと判明した場合。本 skill は編集せず、最終レポートに受け渡しリストとして積む
- **スキップ**: 指摘を無視。id を `SKIPPED_ITEMS` に追加し、次回以降の実行時に再提示しない

🟣（decision-needed）については、選択肢として「方針 A / 方針 B / ...」を scoring subagent の出力から引き出して提示すると判断しやすい。方針が決まった後は「仕様更新（指示通り）」相当の扱いとする。

### Step 4: 仕様更新の実行

Step 3 でユーザーが「仕様更新」を選んだ項目について、対象仕様ファイルを `Edit`（新規ファイル作成が必要なら `Write`）する。

- 同一ファイルに複数の更新がある場合はまとめて適用し、Edit の競合を避ける
- 更新後に `git diff <file>` で意図通りか確認する
- 更新が複雑（節の全書き換え・構成変更など）の場合は、サマリを返す前にユーザーに「このファイルは大きく変わるが進めて良いか」を `AskUserQuestion` で再確認する

**コード側の修正は一切しない**。🟠 項目および「実装側で対応」を選んだ項目は、次の受け渡しリストに積むだけにとどめる:

```
HANDOFF_LIST:
- id: B3
  file (impl): src/foo/bar.ts:42-50
  issue: 仕様 §2.1 で「A のとき B」と規定されているが、実装では A のとき C になっている
  suggested_action: 実装を B に直す
- id: ...
```

### Step 5: 最終整合性確認

更新後の仕様ファイルで、バイアス排除スキャンを再実行する。

- Mode A: Step 1 と同じプロンプトで、**元の `SPEC_PATHS` 全件** を対象に subagent を再呼び出し（Step 4 で編集していないファイルも再スキャン対象。更新によって別ファイルと整合が崩れる可能性を拾うため）。新たな矛盾・曖昧さが残っていないか確認
- Mode B: Step 1 の 1B-spec のみ再実行（実装は変えていないため 1B-impl は前回結果を再利用）し、drift を再突合。再 scoring は **Step 2 と同じプロンプト・同じ設定 (`Explore` + `haiku`) で新規に scoring subagent を呼び出す**（Agent ツールはセッション継続できないため毎回新規呼び出しになる前提）。親 skill は突合のペアリングまでを担当し、drift あり/なしの最終判定は必ず scoring 層を通す

残存指摘がある場合:

- 件数が **減っている** → 更新の効果を確認して完了
- 件数が **減っていない / 増えている** → 更新で新たな問題を作った可能性。ユーザーに状況を報告し、続行可否を確認

`SKIPPED_ITEMS` や「実装側で対応」に回した項目は残っていて当然なので、「対応済みのはずなのに残っている項目」のみを報告対象にする。

### Step 6: 最終レポート

次を表示して終了:

- 更新した仕様ファイル一覧（パス + 何を変えたかの 1 行）
- 🟠 / 「実装側で対応」に分類された項目一覧（`HANDOFF_LIST` 全件）
  - 各項目について「次のステップ: `bugfix` または `local-review` skill の利用を推奨」と添える
- スキップされた項目一覧（id のみ、次回再提示されないよう `SKIPPED_ITEMS` に入っていることを明示）
- Step 5 で残った未解決指摘があれば警告とともに一覧化
- **commit / push は行わない**。必要であれば `/commit` skill の利用を案内する

## Notes

- 共通規約（model 明示 / 反対側読み禁止 / scoring 並列化 / confidence 表示 / AskUserQuestion 上限 / `..` と `...` / commit しない）は `${CLAUDE_SKILL_DIR}/../_shared/bias-free-review.md` を参照
- 対象仕様が複数ファイル（例: プランと CLAUDE.md と docs/specs/ の複数ファイル）にまたがる場合は、`SPEC_PATHS` を配列として全 subagent に渡し、まとめて読ませる
- Mode B で実装 diff が巨大（1000+ 行）な場合、subagent 1B-impl が全量を読みきれない可能性がある。その場合は `DIFF_RANGE` を機能単位に分割して複数回この skill を適用する
- **1B-impl が読んでよいファイル範囲**: `DIFF_RANGE` に含まれる変更ファイル + それらが直接 import/参照する既存実装ファイル（型定義・ヘルパー）。禁止されているのは `docs/` 配下 / `CLAUDE.md` / プラン / コミットメッセージ / PR 本文のみ。import グラフ上の関連ファイルは実装挙動の根拠になるので読んで良い
- 頻用コマンド（read-only git + 内部ツール）は frontmatter の `allowed-tools` で許可済み

## Red flags（共通 Red flags は bias-free-review.md 参照）

| 出てくる合理化 | 実態 |
|---|---|
| 「Mode A なのに CLAUDE.md も参考に読ませよう」 | バイアス混入。Mode A では「仕様ファイルそのもの」だけを読ませる。CLAUDE.md が対象仕様なら `SPEC_PATHS` に入れる形が正しい。 |
| 「Step 0 の Mode 判定をスキップして即スキャン」 | Mode を確定させずに走らせると 1B-impl への diff 範囲が不定になり、scope が発散する。 |
| 「対象を自動確定したので報告も省いて良い」 | 0e の完了報告が確認質問の代替になっている。省くとユーザーが対象違いに気づけない。 |

## よくある失敗

- **対象仕様が広すぎ / 狭すぎ**: リポジトリ全体の docs を丸ごと対象にすると指摘が爆発する。変更の話題に沿った 1-3 ファイルに絞る
- **Mode B で `DIFF_RANGE` が合っていない**: 仕様と無関係なコミットまで入ると drift がノイズだらけになる。Step 0e の完了報告で範囲を明示し、違っていればユーザーが中断できるようにする

## 関連

- `empirical-prompt-tuning` — バイアス排除の方法論はここから借用。agent 向け指示プロンプトの品質改善専用
- `make-plan` — 仕様の新規**立案**。本 skill は**見直し**なので使い分ける
- `local-review` — コード側の修正ループ。本 skill の 🟠 受け渡し先
- `bugfix` — 実装側のバグ修正。同じく 🟠 の受け渡し先
- `revise-tests` — テスト側の見直し。仕様更新に伴いテストの過不足が生じた場合の受け渡し先
- `/commit` — 仕様更新後のコミットはこちらに案内する
