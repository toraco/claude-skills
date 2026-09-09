---
name: revise-tests
description: テストコード（ユニット / 統合 / E2E 等）の過不足を見直したいときに使う。実装 × 仕様 × 既存テストの三面を突合し、不足テストの追加・乖離したテストの更新・死んだテストの削除を自動で行う。バイアス排除された subagent を並列で走らせ、Tidy First 原則でテスト側のみ編集する。
allowed-tools: Bash(git symbolic-ref:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git rm:*), Bash(ls:*), Bash(npm test:*), Bash(yarn test:*), Bash(pnpm test:*), Bash(pytest:*), Bash(go test:*), Bash(cargo test:*), Bash(bundle exec rspec:*), Read, Edit, Write, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate
---

# Revise tests: $ARGUMENTS

**使い方**: `/revise-tests [--mode=auto|impl-only] [--scope=<glob>] [--interactive]`

## Goal

TDD 前提のプロジェクトで、ブランチの現在状態に対してテストが **過不足なく** 張られているかを点検し、必要な追加・更新・削除を自動で行う。

三面（実装 / 仕様 / 既存テスト）を **別々の subagent で独立に読ませてバイアスを排除** し、親 skill が突合して差分を抽出する。テスト側のみ編集し、実装側の修正が必要と判明した項目は最終レポートに受け渡しリストとして積み、`bugfix` / `local-review` に委ねる。

## いつ使うか

- TDD で実装を一通り書いた後、テストカバレッジに抜けが無いか確認したい
- リファクタリング後、構造変更に伴ってテストが古くなっていないか確認したい
- 仕様変更に伴い、対応するテスト側の更新漏れを洗い出したい
- 機能削除後、不要になったテストが残っていないか確認したい
- PR レビューで「このケースのテストは？」と指摘された
- TDD のつもりでも抜け落ちやすいエッジケース（境界値・異常系・並行実行など）を補完したい

使わない場面:

- テスト・リント・ビルドの実行と失敗修正 → `/check`
- 実装側のバグ修正（テストは付帯的） → `bugfix`
- 仕様書そのものの見直し → `revise-spec`
- テストも含めた PR レビュー全般 → `local-review` / `review`

## 前提

- 本 skill は共通方法論 `${CLAUDE_SKILL_DIR}/../_shared/bias-free-review.md` に従う（subagent dispatch / scoring 並列化 / confidence 表示 / AskUserQuestion 運用 / Tidy First の規約）。**Step 0 開始時に必ず Read すること**
- `Agent` ツールで subagent を dispatch できる環境（並列は最低 2、できれば 3 までスケール）
- 対象ブランチで `git` の diff / log が取得可能
- テストランナー（Jest / Vitest / Pytest / RSpec / go test 等）がリポジトリで実行可能な設定になっている
- TDD の前提: テストはプロダクションコードと同等の扱いを受ける一級市民であり、`__tests__/` や `*.test.*` / `*_spec.*` などの慣習で識別可能

## ワークフロー

### Step 0: Mode と対象の決定

- 状態変数を宣言: `MODE`（`auto` or `impl-only`）、`DIFF_RANGE`、`IMPL_PATHS`（実装側の変更ファイル配列）、`TEST_PATHS`（既存テストファイル配列 + 今回追加予定のテストが置かれるべきパス群）、`SPEC_PATHS`（仕様ファイル配列、無ければ空）、`INTERACTIVE`（既定 `false`）、`SKIPPED_ITEMS = []`、`HANDOFF_LIST = []`
- **タスクリスト化**: `TaskCreate` で主要ステップ（対象特定 / 三面スキャン / 突合 & 分類 / ユーザー確認 / テスト編集 / ランナー検証 / 最終レポート）を登録。各ステップ開始時に `in_progress`、完了時に `completed` に更新

#### 0a. 引数解析

- `$ARGUMENTS` に `--mode=auto` / `--mode=impl-only` があれば該当モードを採用。未指定時は後述の自動判定を行い、**判定結果をそのままデフォルトとして採用する**（確認は挟まない。共通方法論「Step 0 の自動確定」に従う）
- `--scope=<glob>` が指定されていれば、`IMPL_PATHS` / `TEST_PATHS` のフィルタに使う（例: `--scope=src/auth/**`）
- `--interactive` があれば `INTERACTIVE = true`。このときのみ Step 0 の各項目を従来通り `AskUserQuestion` で確認する

#### 0b. diff 範囲と実装ファイルの確定

- `git symbolic-ref refs/remotes/origin/HEAD` で default branch を検出
- `DIFF_RANGE = "origin/<default>...HEAD"` を **そのまま採用**し、確認は挟まない。diff が空 / default branch を検出できない場合のみ `AskUserQuestion` でコミット範囲を問う
- `INTERACTIVE = true` のときのみ、後述 0d の Mode 確認と **1 つの複合 question にまとめて** 確認する（2 回連続の AskUserQuestion を避けるため。options 例: `diff 範囲 OK + 推奨 Mode で進める` / `diff 範囲を変更` / `Mode を変更` / `両方変更（Other）`）
- `git diff --name-only $DIFF_RANGE` の出力から、実装ファイルとテストファイルを以下のルールで分離:
  - **テストファイル判定**: パスに `__tests__/` / `.test.` / `.spec.` / `_spec.` / `_test.` / `tests/` を含む、またはテストランナー設定 (`jest.config.*` / `vitest.config.*` / `pytest.ini` 等) で指定された glob に一致
  - それ以外の `.ts` / `.tsx` / `.js` / `.py` / `.rb` / `.go` / `.rs` / `.java` / `.kt` 等を `IMPL_PATHS`
  - ドキュメント (`*.md`) / 設定 (`*.yml` / `*.json` 等) は除外（設定変更が振る舞いに影響する場合のみ別途ユーザー判断）
- **TEST_PATHS の補完**: `git diff` に現れないが `IMPL_PATHS` に対応する既存テストも TEST_PATHS に含める。IMPL ファイルのベース名から glob で推定する（例: `src/utils/date.ts` → `src/utils/date.test.ts` / `src/utils/__tests__/date.test.ts` / `tests/**/date_test.py`）。1-test に「対応実装の挙動カバレッジ」を評価させるために必要

#### 0c. 仕様ファイルの探索（Mode 自動判定の材料）

以下の順で候補を探索し、見つかったものを `SPEC_PATHS` に入れる:

1. `.claude/plans/` 配下の最終更新が最新のプランファイル
2. `docs/specs/` 配下で、`IMPL_PATHS` のファイル名・ディレクトリ名に関連するもの
3. `IMPL_PATHS` の祖先ディレクトリにある `CLAUDE.md`
4. リポジトリルートの `CLAUDE.md`

見つからない / 不明瞭な場合は `SPEC_PATHS = []`。

#### 0d. Mode 自動判定

- `SPEC_PATHS` が空 → **Mode impl-only**
- `SPEC_PATHS` が 1 件以上 → **Mode auto**
- 判定結果は **そのまま `MODE` に採用**し、確認は挟まない。`INTERACTIVE = true` のときのみ 0b の diff 範囲確認と統合した 1 つの複合 `AskUserQuestion` で確定する（個別質問を 2 回発行しない）

#### 0e. テスト格納先ディレクトリの把握

- 既存のテストファイル配置から慣習を抽出:
  - `src/foo.ts` に対し `src/foo.test.ts` が共存（co-located 形式）
  - `src/foo.ts` に対し `src/__tests__/foo.test.ts`（__tests__ ディレクトリ形式）
  - `src/` に対し `tests/` が並列（分離形式）
- `TEST_LAYOUT` に判定結果を格納。新規テスト追加時に同じ慣習で置く

#### 0f. Step 0 完了報告

Step 1 に進む前に、自動確定した内容を **1 ブロックで必ず提示** する。確認質問を出さない代わりに、ユーザーが「対象が違う」と気づいて中断できる状態を作る:

```
## 対象（自動確定）
- MODE: auto（SPEC_PATHS が 1 件以上見つかったため）
- DIFF_RANGE: origin/main...HEAD（実装 8 ファイル / テスト 3 ファイル）
- SPEC_PATHS: .claude/plans/2026-09-03-foo.md
- TEST_LAYOUT: co-located（`src/foo.ts` → `src/foo.test.ts`）

違う場合は中断し、`/revise-tests --mode=<mode> --scope=<glob>` で明示するか `--interactive` を付けて再実行してください。
```

**この Step が完了するまで Step 1 には進まない**。対象と慣習が曖昧なまま走らせると以降のスキャンが無価値になる。

### Step 1: 三面バイアス排除スキャン

Mode に応じて `Agent` ツールを **1 メッセージ内で並列呼び出し** する。**全呼び出しで `subagent_type: "Explore"`、`model: "sonnet"` を明示すること**。互いの情報源を禁止し合うことで、三面スキャンのバイアスを排除する。

#### Agent 1-impl: 実装 diff のみから「テストすべき挙動」を抽出

プロンプト:

```
あなたは実装コードだけを読むコードアナリストです。

## タスク
以下の `git diff` 範囲および関連する実装ファイルだけを読み、実装が実現している「テストすべき挙動」を統一フォーマットで列挙してください。
- DIFF_RANGE: <DIFF_RANGE>
- 主要変更ファイル: <IMPL_PATHS>

## 禁止事項
- 仕様書・プラン・docs/ 配下・CLAUDE.md を Read しないこと
- 既存テストファイル（`*.test.*` / `*.spec.*` / `__tests__/` / `tests/` 配下等）を Read しないこと
- コミットメッセージ・PR 本文を読まないこと
- 仕様やテストを想像しないこと（コードに書かれていることのみを根拠とする）

## 読んで良い範囲
- DIFF_RANGE に含まれる実装ファイル
- それらが直接 import/参照する既存実装ファイル（型定義・ヘルパー）
- **削除されたファイル**は working tree に存在しないため、`git show <DIFF_RANGE の起点 ref>:<path>` で旧内容を取得して読んでよい（例: `git show origin/main:app/legacy_auth.py`）。これは禁止事項の「テストを読む」「仕様を読む」には該当しない

## 抽出観点（TDD の観点でテストすべき挙動）
- 正常系: 主要な入力パターンごとの出力
- 境界値: off-by-one / 空入力 / 上限値 / 型境界
- 異常系: 想定外入力・例外パス・エラーハンドリング
- 副作用: I/O・DB・外部 API 呼び出し・状態変化
- 非同期 / 並行性: async 境界・race condition・ordering
- 分岐カバレッジ: if / switch / guard clause の全パス

## 出力フォーマット
各挙動について次の形式で返す:
- id: I1, I2, ...（1-origin 連番、prefix `I`）
- area: <機能領域名 / クラス名 / 関数名>
- behavior: <テストすべき挙動 1 行>
- source: <実装ファイル:関数名 or 行番号>
- priority: high | medium | low（high = 分岐の主要パス・異常系の到達ルート、medium = 標準的正常系、low = 些末な内部動作）

粒度: 「入力 X に対して Y を返す」「A のとき副作用 B が発生」レベル。変更箇所の挙動を網羅する（10-40 件が目安、変更規模による）。
```

#### Agent 1-spec: 仕様だけから「テストすべき挙動」を抽出（Mode auto のみ）

プロンプト:

```
あなたは仕様書だけを読む仕様アナリストです。

## タスク
以下のパスの仕様書だけを読み、仕様が規定する「テストすべき挙動」を統一フォーマットで列挙してください。
<SPEC_PATHS>

## 禁止事項
- 実装ファイル (`.ts` / `.tsx` / `.js` / `.py` / `.rb` など) を Read しないこと
- テストファイルを Read しないこと
- `git diff` / `git log` / `git show` を実行しないこと
- 実装から仕様を推論しないこと

## 抽出観点
- 機能要件として記述された挙動
- エラー条件・例外ケース
- 境界条件・前提条件
- 非機能要件のうちテストで検証可能な項目（パフォーマンス閾値等）

## 出力フォーマット
各挙動について次の形式で返す:
- id: S1, S2, ...（1-origin 連番、prefix `S`）
- area: <機能領域名 / エンドポイント名 / 関数名>
- behavior: <テストすべき挙動 1 行>
- source: <仕様ファイル:節タイトル or 行番号>
- priority: high | medium | low

粒度: 1-impl と揃えることで、あとで突合可能にする。
```

#### Agent 1-test: 既存テストだけから「既にテストされている挙動」を抽出

プロンプト:

```
あなたは既存テストコードだけを読むテストアナリストです。

## タスク
以下のテストファイル群だけを読み、既に「テストされている挙動」を統一フォーマットで列挙してください。
- 対象テスト: <TEST_PATHS 全件（既存 + diff で変更されたテスト）>

## 禁止事項
- 実装ファイル（テスト対象の本体コード）を Read しないこと
- 仕様書・プラン・docs/ 配下・CLAUDE.md を Read しないこと
- `git diff` / `git log` を実行しないこと
- テストのコメントやテスト名以外からコードの意図を推論しないこと

## 読んで良い範囲
- テストファイル本体
- テスト内で import されているテストユーティリティ / fixture / mock

## 抽出観点
- `it` / `test` / `describe` / `context` / `@Test` などのブロック単位でテストケースを列挙
- skip / pending / `.only` / `xit` なども含めて状態を明記
- 1 つのテストブロックが複数 assert を持つ場合は主要な assert を 1 件として抽出

## 出力フォーマット
各テストケースについて次の形式で返す:
- id: T1, T2, ...（1-origin 連番、prefix `T`）
- area: <対象コードの領域名 / 関数名>
- covered_behavior: <テストで検証されている挙動 1 行>
- source: <テストファイル:ブロック名 or 行番号>
- status: active | skipped | only | pending
```

#### Mode impl-only の場合

Agent 1-spec をスキップし、1-impl と 1-test の 2 並列のみ実行する。

### Step 2: 突合と 5 分類

#### 2a. 親 skill による突合

Step 1 の 3 つ（Mode impl-only なら 2 つ）の subagent 出力を親 skill で突合する。**突合の主体は親 skill**。scoring subagent に「三面を読ませて差分を探させる」ことは禁止（複数を読むとバイアスが混入する）。

突合ロジック:

1. **1-impl の挙動を 2 つに仕分ける**（`source` のファイルパスで判定）:
   - `source` が **現存する** 実装ファイルの挙動 → `LiveExpected`（テストすべき現行挙動）
   - `source` が **削除された** 実装ファイル（`git show <起点>:<path>` で読んだもの）の挙動 → `RemovedExpected`（もはや存在しない挙動）
2. **Expected behaviors** = `LiveExpected ∪ 1-spec.behaviors`（Mode impl-only では `LiveExpected` のみ）
3. **Covered behaviors** = `1-test.covered_behaviors`
4. **Covered と RemovedExpected のマッチ** → 🔴 **remove 強根拠**（「対応する実装が消失した dead test」の明示的シグナル。scoring に「removal_evidence: file_deleted」として渡す）
5. `area` が一致する残りのエントリ同士をペアリングし、`behavior` と `covered_behavior` の意味論を比較。**判定は以下の順序で適用する**（上から評価し、最初にヒットした分類を採用。複数条件に該当する場合は上位優先）:
   1. **Mode auto で 1-impl と 1-spec が食い違う** → **decision-needed 候補**（update/add より優先。ユーザー判断なしに進めると修正が間違った側に寄るため）
   2. **Expected にあり Covered に無い** → **add 候補**
   3. **Covered にあり Expected に無い** → **remove 候補**
   4. **両方あるが意味が食い違う**（上記 1 に該当しない場合）→ **update 候補**

**粒度ルール**: area が同じでも `behavior` が異なれば個別の突合 id を立てる。area 単位で統合しない。例: `calculate_tax` の「整数税額を返す」「端数を切り上げる」「税率 0 で 0 を返す」は別 id とする。1 area に複数挙動がある場合に統合すると、scoring と AskUserQuestion の粒度が粗くなり decision の精度が落ちる。

ペアリングが曖昧な項目（area 名が揺れている等）は、そのまま曖昧フラグを立てて scoring subagent に判断を委ねる。

#### 2b. Scoring subagent で分類を確定

突合結果の各項目に対し、scoring / 分類 subagent を並列呼び出しする（`subagent_type: "Explore"`、`model: "haiku"`）。

**並列化ルール**: 共通方法論「Scoring の並列化ルール」に従う（1 突合項目につき 1 subagent、10 件以上は 5 件バッチの順次パイプライン）。

scoring プロンプト:

```
あなたはテスト見直しの分類担当です。

## 入力
- MODE: <auto | impl-only>
- 突合項目: <1 件の詳細（Expected エントリ / Covered エントリ / 突合種別）>

## タスク
以下の 5 分類のいずれかを提案し、理由を添えてください。

- 🟢 add: 不足しているテストを追加すべき
  - Expected にあるが Covered に無く、priority = high/medium
- 🟡 update: 既存テストを新しい挙動に更新すべき
  - 両方あるが意味が食い違い、Expected 側（実装または仕様）が正として自然
- 🔴 remove: 既存テストを削除すべき
  - Covered にあるが対応する実装 / 仕様が消失している（dead test）
- 🟣 decision-needed: ユーザーの意思決定が必要
  - Mode auto で実装と仕様が食い違う
  - Expected 項目だが priority 判定が曖昧で追加要否が分かれる
  - 削除候補だが意図的な冗長テスト（regression guard）の可能性
- ⚪ out-of-scope: テスト対象外
  - 型システムで保証されている（テスト不要）
  - E2E / 統合テストの管轄で、本レイヤーのユニットテストには不適
  - 外部依存が強すぎてモック化の ROI が低い
  - スタイル / 命名 / コメント系の観点

## 出力
- id: <対応する突合項目 id>
- classification: add | update | remove | decision-needed | out-of-scope
- reason: <1-2 行で分類の根拠>
- confidence: 0-100
- suggested_test_sketch: <classification=add/update の場合、テストの骨子（describe/it 構造、assert 対象、必要な mock）を 3-8 行で>
- suggested_options: <classification=decision-needed の場合のみ、最大 3 件の方針候補を箇条書き>
```

scoring 結果と突合項目本体をマージして、ユーザー提示用の `CLASSIFIED_ITEMS` を生成する。

#### 2c. ユーザー提示

```
## テスト過不足の検出結果 (<件数>件)

| id | 領域 | 分類 | 信頼度 | サマリ |
|----|------|------|--------|--------|
| D1 | auth/login | 🟢 add | 85 | 期限切れトークンの拒否テストが無い |
| D2 | auth/session | 🟡 update | 75 | session 更新ロジックが変わったがテストが古い |
| D3 | auth/legacy | 🔴 remove | 90 | legacy 関数が削除されたがテストが残存 |
| D4 | billing | 🟣 decision-needed | 60 | 仕様と実装の金額端数処理が食い違う |
| ...
```

**表示規則**: 共通方法論「confidence の表示規則」に従う。

### Step 3: ユーザー確認 (AskUserQuestion)

🟢 / 🟡 / 🔴 / 🟣 に分類された項目について、`AskUserQuestion` で対応方針を確定する。質問の分割・options 上限は共通方法論「AskUserQuestion の運用」に従う（分類混合 OK）。

**各項目の選択肢（AskUserQuestion の options 上限 4 件に合わせて 4 択に圧縮済み）**:

1. **実行（指示通り）**: `suggested_test_sketch` の通り skill がテストを追加/更新/削除する
2. **実行（内容を変更）**: `notes` でユーザーが具体的な内容を指定し、それに従う
3. **handoff（skill 外で対応）**: テスト側で解決できず、実装または仕様の修正が必要。`notes` で `implementation` か `specification` を指定してもらい、`HANDOFF_LIST` に積む（`implementation` → `bugfix` / `local-review`、`specification` → `revise-spec`）
4. **スキップ**: 項目を無視し `SKIPPED_ITEMS` に追加

**🟣 decision-needed の特別扱い**: 通常の 4 択ではなく、scoring 出力の `suggested_options`（最大 3 件）+ 「スキップ」= 4 件で提示する。ユーザーが suggested_options のいずれかを選んだら、それに沿って通常の編集フロー（実行 or handoff）に戻す。

### Step 4: テスト編集の実行

Step 3 でユーザーが「実行」系を選んだ項目について、テストファイルを編集する。

#### 4a. 追加（🟢 add）

- `TEST_LAYOUT` の慣習に従って格納先を決定
- 既存テストファイルに追記する場合は `Edit`、新規ファイルは `Write`
- describe / describe 階層は既存テストに倣う
- mock / fixture は既存の utility を優先利用。新規 helper を勝手に作らない
- **TDD Red 確認**: 追加直後に該当テストのみランナーで実行し「一度緑になる（実装が既に満たしている）」ことを確認する。もし **赤（失敗）** になった場合は、実装側に不備がある可能性を示唆する → `HANDOFF_LIST` に "🟢 追加したが即失敗した" 項目として積み、ユーザーに報告（このテストは skip せず赤のまま残すか、ユーザー判断）

#### 4b. 更新（🟡 update）

- 対象テストブロックを `Edit` で修正
- describe / it 名も挙動に合った表現に更新
- 古い assert 値・期待構造を新しい挙動に合わせる
- 更新後にランナーで実行し緑を確認

#### 4c. 削除（🔴 remove）

- 対象テストブロックを `Edit` で削除
- ブロック削除でファイルが空になった場合はファイル自体を削除（`git rm` 相当）
- 孤立した import / fixture / helper も併せて削除（未参照になったもののみ）

#### 4d. 共通ルール

- 同一ファイルに複数の編集がある場合はまとめて適用し、Edit の競合を避ける
- 大規模な再構成（describe 階層の組み替え等）が必要な場合は、編集前にユーザーに `AskUserQuestion` で確認
- テストで使うダミーデータは既存の factory / builder 関数を優先（`revise-spec` 同様、周辺コードの慣習を尊重）
- **実装コードは一切編集しない**。実装修正が必要な項目は `HANDOFF_LIST` に積むだけ

### Step 5: テストランナー検証

編集後にテストランナーで **編集したテストのみ** を実行する。

- ランナーと実行コマンドはリポジトリから推論:
  - `package.json` の `scripts.test` / `scripts.test:unit` 等
  - `pytest` / `go test` / `cargo test` / `bundle exec rspec` 等
- 実行範囲は編集したテストファイルに絞る（`--testPathPattern` / `::` 指定等）
- 全緑ならそのまま Step 6 へ
- 赤のテストがあれば以下の分岐:
  - 🟢 追加したテストが赤 → **実装側の不備の可能性**。Step 4a の扱いに従い `HANDOFF_LIST` に積む
  - 🟡 更新したテストが赤 → 更新内容が実装と合っていない可能性。ユーザーに報告し、テストを元に戻すか実装修正を handoff するか確認
  - 🔴 削除は赤になりえない（削除されたのでそもそも走らない）。削除により他テストが壊れた場合は共通 helper の削除ミス等が疑われる → 確認

**ランナーが既存赤テスト（本 skill の編集前から失敗していたもの）を巻き込まないよう注意**。編集対象テストのみフィルタして実行する。

### Step 6: 最終整合性確認（軽量再突合）

編集後のテスト群で、Step 1 の 1-test だけを再実行し、カバレッジが期待通り増減したかを確認する（1-impl / 1-spec は元のまま再利用）。

- 親 skill が再突合し、Step 3 で「実行」に回した項目が全て解消されているかチェック
- 解消されていない項目があれば警告とともに一覧化
- `SKIPPED_ITEMS` と `HANDOFF_LIST` の項目は残っていて当然なので報告対象外

**1-impl / 1-spec は再実行しない**（実装と仕様は本 skill では変えていないため）。1-test 再実行は `subagent_type: "Explore"`、`model: "sonnet"` で新規呼び出し（Agent はセッション継続できないため毎回新規呼び出しになる前提）。

### Step 7: 最終レポート

次を表示して終了:

- 編集したテストファイル一覧（パス + 追加/更新/削除の種別 + 件数）
- 新規追加テストの「Red/Green」結果サマリ
- `HANDOFF_LIST` 全件（実装側対応 / 仕様側対応に分けて）
  - 各項目について「次のステップ: `bugfix` / `local-review` / `revise-spec` skill の利用を推奨」と添える
- `SKIPPED_ITEMS` の id 一覧（次回再提示されないよう skill 内で保持されることを明示）
- Step 6 で残った未解決項目があれば警告とともに一覧化
- **commit / push は行わない**。必要であれば `/commit` skill の利用を案内する

## Notes

- 共通規約（model 明示 / 反対側読み禁止 / scoring 並列化 / confidence 表示 / AskUserQuestion 上限 / `..` と `...` / commit しない）は `${CLAUDE_SKILL_DIR}/../_shared/bias-free-review.md` を参照。特に 1-impl に「テストを読むな」、1-test に「実装を読むな」は強く指示すること
- 対象テストが複数レイヤー（unit + integration + e2e）にまたがる場合、レイヤーごとに skill を適用することを推奨。混ぜて見ると「このケースは e2e で見るべき / unit で見るべき」の判断が雑になる
- 変更規模が大きい場合（50+ 挙動抽出）は、`--scope` で機能単位に分割して複数回 skill を適用する
- **1-impl が読んでよいファイル範囲**: `DIFF_RANGE` に含まれる変更ファイル + それらが直接 import/参照する既存実装ファイル。禁止は `docs/` / `CLAUDE.md` / プラン / **テストファイル** / コミットメッセージ / PR 本文
- **1-test が読んでよいファイル範囲**: テストファイル本体 + テストユーティリティ / fixture / mock モジュール。禁止は実装側コード（テスト対象の本体）
- 頻用コマンド（read-only git + 主要テストランナー + 内部ツール）は frontmatter の `allowed-tools` で許可済み。リポジトリ固有のテストコマンドは実行時に確認される

## Red flags（共通 Red flags は bias-free-review.md 参照）

| 出てくる合理化 | 実態 |
|---|---|
| 「追加したテストが赤なら実装を直してしまおう」 | スコープ外。赤のテストは報告し、`bugfix` / `local-review` に委ねる。 |
| 「Mode auto なのに仕様を読まないでおこう」 | 仕様ファイルが存在するのに 1-spec をスキップすると、仕様と実装の drift が検出できない。必ず並列で走らせる。 |
| 「TDD 前提なのだから Red を確認せず Green だけ見れば十分」 | 既存実装に対して後追いテストを書く場合でも、追加直後に赤が出るなら実装側の不備の兆候。`HANDOFF_LIST` に積む価値がある。 |
| 「対象を自動確定したので 0f の報告も省いて良い」 | 完了報告が確認質問の代替になっている。省くとユーザーが diff 範囲違い・Mode 違いに気づけない。 |

## よくある失敗

- **diff 範囲が広すぎ / 狭すぎ**: ブランチ全体を対象にすると過去コミット分のテスト gap も混入し、スコープが膨張する。必要なら `--scope` で絞る
- **テスト配置慣習を無視**: co-located と __tests__ 形式が混在するリポジトリで、新規追加を間違った場所に置くとレビューで全て差し戻しになる。Step 0e で必ず慣習を確認
- **mock / fixture を勝手に新設**: 既存の factory / builder があるのに新設すると重複が増える。必ず既存 utility を先に探す
- **テストランナー実行をスキップ**: 追加・更新したテストが実際に緑になるかを確認しないと handoff の判断がつかない。Step 5 は必ず実行
- **🔴 削除で helper 巻き込みを見逃す**: 削除したテストだけが使っていた fixture / helper を削除し忘れると dead code が残る。孤立判定を必ず確認

## 関連

- `revise-spec` — 仕様書側の見直し。本 skill で「仕様側で対応」に回した項目の受け皿
- `bugfix` — 実装側のバグ修正。本 skill で「実装側で対応」に回した項目の受け皿
- `local-review` — コード + テスト含む diff の総合レビュー。本 skill より広いスコープで、本 skill の後段として使える
- `/check` — テスト・リント・ビルドの実行と失敗修正。本 skill で編集したテストを含む全体確認として使える
- `empirical-prompt-tuning` — バイアス排除の方法論はここから借用
- `/commit` — テスト更新後のコミットはこちらに案内する
