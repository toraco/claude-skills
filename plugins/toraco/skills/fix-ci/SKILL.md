---
name: fix-ci
description: 失敗した CI (GitHub Actions) の原因を調査し、コード起因なら修正して push、flaky・環境起因なら切り分けて file-issue で起票する。修正後は再実行を監視して green を確認する。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Fix CI: $ARGUMENTS

**使い方**: `/fix-ci [run-url | job-url | pr-number] [--no-push] [--max-rounds=N]`

## Goal

失敗している CI を「原因が特定され、コード起因なら修正が push され、flaky / 環境起因なら issue として追跡され、最終的に green が確認された」状態にする。

これまで「この run URL が落ちている原因を調査して修正して」「flaky なら /file-issue で起票して」「監視しておいて」と毎回手書きしていた定型フローの置き換え。

## いつ使うか

- 失敗した GitHub Actions の run / job URL を貼って原因調査と修正を依頼したいとき
- PR の checks が落ちていて、修正か flaky 切り分けかを判断してほしいとき
- 引数なしで現在ブランチの最新の失敗 run を調べてほしいとき

使わない場面:

- ローカルのテスト・リント・ビルド失敗 → `check`
- CI は通っているがバグ挙動がある → `bugfix`

## 引数

| 引数 | 既定 | 意味 |
|---|---|---|
| `run-url` / `job-url` | 現在ブランチの最新失敗 run | 調査対象の run |
| `pr-number` | なし | この PR の失敗 checks を対象にする |
| `--no-push` | false | 修正はローカル commit まで（push しない） |
| `--max-rounds=N` | 3 | 修正 → 再実行確認のループ上限 |

## ワークフロー

### Step 1: 失敗の特定

- 対象 run の決定:
  - URL 指定: `gh run view <run-id> --json status,conclusion,workflowName,headBranch,jobs`
  - PR 指定: `gh pr checks <N> --json name,bucket,link` で失敗 check を列挙
  - 引数なし: `gh run list --branch $(git branch --show-current) --limit 5` から最新の失敗 run
- `gh run view <run-id> --log-failed` で失敗ジョブ・ステップのログを取得
- 失敗が複数ジョブに及ぶ場合はジョブごとにエラー内容を整理する

### Step 2: 原因の分類

失敗ごとに以下のいずれかに分類し、根拠とともに提示する:

- **(a) コード起因**: このブランチの変更が原因（テスト失敗・型エラー・リント・ビルド失敗）。ローカルで該当テスト / コマンドを再現して確認する
- **(b) flaky**: タイミング依存・外部サービス依存・乱数依存など非決定的な失敗。判定材料:
  - 同一 workflow の直近 run 履歴（`gh run list --workflow=<name> --limit 20`）で同じテストが成功と失敗を行き来している
  - このブランチの変更と失敗箇所に依存関係がない
  - リトライで通る（`gh run rerun <run-id> --failed`）
- **(c) 環境・インフラ起因**: runner イメージ・キャッシュ破損・権限・rate limit・依存レジストリ障害など

分類に迷う場合は (a) として深掘りし、ブランチ差分との依存関係が否定できたときのみ (b)/(c) に倒す。

### Step 3: 分類ごとの対応

- **(a) コード起因**: 原因を修正 → ローカルで該当テスト / コマンドが通ることを確認 → プロジェクト慣例に沿って commit → push（`--no-push` 時はここで停止して報告）
- **(b) flaky**: `/file-issue` で起票する（失敗ログ・run URL・再現頻度・同一テストの成功/失敗履歴を含める。既存の flaky issue があれば重複起票せずコメント追記に回るのは file-issue 側の挙動に従う）。起票後 `gh run rerun <run-id> --failed` で再実行
- **(c) 環境・インフラ起因**: 設定ファイル（workflow yml / キャッシュキー等)で直せるものは (a) と同様に修正。プロジェクト側で直せないもの（外部障害等）は再実行 + 状況報告に留める

### Step 4: 再実行の監視

- push または rerun 後、`gh run watch <run-id> --exit-status` か、バックグラウンドの `gh pr checks --watch` で完了を待つ
- **green**: 完了。Step 5 へ
- **再失敗**: Step 1 に戻る。同一原因で `--max-rounds` に達したら、それ以上の修正試行をやめて現状と仮説を報告して停止（無限ループしない）

### Step 5: 最終報告

- 失敗ジョブと原因（分類 a/b/c）/ 取ったアクション（修正 commit・起票した issue URL・rerun）/ 最終的な CI の状態、を 1 ブロックで報告

## Notes

- **ログは `--log-failed` から読む**。全ログのダンプは読まない（大きすぎる）。足りなければ `gh api /repos/{owner}/{repo}/actions/jobs/<job-id>/logs` で個別取得
- flaky 判定は「自分のブランチと無関係」の証明が本体。**ブランチ差分と失敗テストの依存関係を必ず確認**してから (b) に分類する
- 監視の待ち時間が長い workflow では、完了待ちをバックグラウンド化してユーザーに中間報告する
- 使用コマンド: `gh run list/view/rerun/watch`, `gh pr checks`, `gh api`, ローカルのテストランナー
- 内部ツール: `Skill`（file-issue 呼び出し）

## Red flags

| 出てくる合理化 | 実態 |
|---|---|
| 「とりあえず rerun して通れば OK」 | コード起因の失敗を隠すだけ。分類 (a) の可能性を潰してから rerun する |
| 「テストを skip / 緩和して通そう」 | 失敗の隠蔽。テスト側を変えるのは、テストが仕様と乖離していると確認できた場合のみ |
| 「flaky っぽいので起票せず流す」 | 次に同じ失敗を踏む。flaky 判定したら必ず起票して追跡可能にする |
| 「CI 上でしか再現しないから直接 push で試行錯誤」 | push 連打はレビューとログを汚す。可能な限りローカル再現（同バージョン・同コマンド）を先に試す |

## 関連

- `check` — ローカルのテスト・リント・ビルドを回す。fix-ci の (a) 修正後のローカル確認にも使える
- `file-issue` — flaky / 環境起因の起票先
- `bugfix` — CI ではなく実挙動のバグ修正
