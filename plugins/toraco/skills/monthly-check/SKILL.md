---
name: monthly-check
description: 保守しているサイトの月次チェックリスト（docs/monthly-checklist.md）のうち、公開ページの HTTP/HTML 確認とライブラリ監査・GitHub の棚卸しを読み取り専用で実行し、月次報告の下書きを作る。自動起動はせず、ユーザーが明示的に指示したときだけ使う。
---

# Monthly check: $ARGUMENTS

**使い方**: `/monthly-check [--checklist=<path>] [--checklist-ref=<git ref>] [--site=<本番 URL>] [--since=YYYY-MM-DD] [--month=YYYY-MM] [--out=<path>] [--pr-stale-days=30] [--branch-stale-days=90]`

例:

- `/monthly-check` — 作業ツリーの `docs/monthly-checklist.md` を読んで実行する
- `/monthly-check --checklist-ref=origin/docs-branch` — 未マージのブランチにある手順書を読んで実行する
- `/monthly-check --since=2026-10-28` — 前回の実施日を指定して、対象期間をそこからにする

## Goal

月次チェックリストのうち **Claude だけで、本番に何も変更を加えずに確かめられる部分** を実行し、
手順書の「記録用テンプレート」を埋めた **月次報告の下書き** を作る。下書きを人が見直し、残りの項目を確認して、報告先へ投稿する。

- **チェック項目の正本は、各リポジトリの手順書。** この skill には項目を書き写さない。手順書を読み、その時点の項目を実行する。
  サイトごとの違い（URL、ページ、コマンドを実行するディレクトリ）も手順書から読む
- **読み取り専用。** 本番・ステージング・GitHub・リポジトリのどれにも書き込まない（ファイルの変更、commit、issue / PR / コメントの作成、
  報告先への投稿をしない）。下書きはリポジトリの外に保存する
- **見た目の最終判断は人に残す。** HTTP と HTML で確かめられるのは「ページが返る」「要素がある」までで、崩れや画像の見え方は人が見る

## いつ使うか

- 月次チェックの実施日に、自動で確かめられる部分を先に済ませて下書きを作るとき
- 手順書を直した後に、その手順書で自動確認が回るかを試すとき

使わない場面:

- 障害の調査・対応 → 手順書（`docs/incident-response.md` など）に従う
- 依存パッケージを実際に更新する → `garden-deps`
- ログイン・SSH・管理画面が必要な確認。この skill では扱わず、下書きに「人が確認」「未対応」と書くだけにする

## 引数

| 引数 | 既定 | 意味 |
|---|---|---|
| `--checklist=<path>` | `docs/monthly-checklist.md` | 手順書のパス（リポジトリのルートから） |
| `--checklist-ref=<git ref>` | なし | 手順書をこの ref から読む（`git show <ref>:<path>`）。未マージの PR にある手順書を使うとき |
| `--site=<url>` | 手順書から読む | 本番の URL。手順書の記載より優先する |
| `--since=YYYY-MM-DD` | 実施日の 30 日前 | 対象期間の開始日。手順書の「対象期間」の決まりに従い、前回の実施日が分かれば指定する |
| `--month=YYYY-MM` | 下の決め方 | 下書きの見出しに入れる年月 |
| `--out=<path>` | `${TMPDIR:-/tmp}/monthly-check/<repo>-<YYYY-MM>.md` | 下書きの保存先。リポジトリの中は指定しない |
| `--pr-stale-days=<n>` | `30` | 最終更新からこの日数を超えた open PR を「放置された PR」とする（手順書に基準があればそちらを使う） |
| `--branch-stale-days=<n>` | `90` | 最終 commit からこの日数を超え、open PR のないブランチを「古いブランチ」とする（同上） |

`--month` を省略したときは、実施日が月の 15 日までなら前月、16 日以降なら当月にする（手順書に決まりがあればそちらを使う）。

## 守ること（全 Step 共通）

- **秘密情報を読まない・出さない。** 設定ファイル（`.env`、`wp-config.php`、`config/` の下の JSON、`*secret*` など）は
  `Read` / `cat` / `grep` で表示しない。中身を使うのは Step 5 の `secret-scan.py` だけで、このスクリプトは値を出力しない。
  コマンドの出力をそのまま下書きに貼らず、必要な事実（件数、パッケージ名、URL のパス、ステータス）だけを書く
- **認証情報を送らない。** Basic 認証やログインが必要な環境・ページは、この skill の対象外にする（ステージングが Basic 認証付きならステージングも対象外）。
  認証画面にぶつかったら、そこで止めて「人が確認」に回す
- **本番への負荷を抑える。** リクエストは 1 件ずつ順に送り、合計 50 件程度までにする。リンクをたどってサイト全体を巡回しない
- 手順書に書かれていない確認を勝手に足さない。足したほうがよい確認に気づいたら、Step 6 の「手順書への提案」に書く

## ワークフロー

### Step 0: 準備

1. リポジトリのルートで実行する（`git rev-parse --show-toplevel`）。`gh repo view --json nameWithOwner,defaultBranchRef` で GitHub のリポジトリを特定する
2. 手順書を読む。`--checklist-ref` があれば `git fetch origin <branch>` の後に `git show "${ref}:${path}"`、なければ作業ツリーのファイルを `Read` する。
   見つからなければ停止して、手順書の場所をユーザーに聞く
   - zsh では `$ref:path` の `:p` などが修飾子として解釈されるので、変数は必ず `${ref}` のように波括弧で囲む
3. 監査の対象になる作業ツリーのブランチと commit（`git rev-parse --abbrev-ref HEAD`、`git rev-parse --short HEAD`）を記録する。
   手順書やリポジトリの docs に本番の元になるブランチ（統合ブランチ）が書かれていて、今のブランチと違う場合は、そのブランチを `git fetch` してから
   別の worktree で監査するか、ユーザーに確認する。ライブラリの監査結果は、どのブランチを見たかで変わる
4. 作業ディレクトリを作る: `W=$(mktemp -d "${TMPDIR:-/tmp}/monthly-check.XXXXXX")`。取得した HTML や監査の JSON はここに置く（リポジトリには置かない）
5. 実施日（今日）、対象期間、見出しの年月を決める

### Step 1: 手順書を読み解く

手順書から次を取り出す。**推測で補わない**。読み取れなかったものは「手順書から読めない」として Step 6 の提案に回す。

| 取り出すもの | 探す場所の例 |
|---|---|
| 本番の URL | 「対象」の表、冒頭の文、表示確認の章の説明。`--site` があればそれを使う |
| 表示確認のページ | 「表示」の章の表（ページ・URL・見るところ） |
| ライブラリ監査のコマンドと実行場所 | `composer audit`（`<dir>` で実行）、`npm audit`（ルートで実行）などの項目 |
| GitHub の確認項目 | セキュリティアラート、古いブランチ、放置された PR など |
| 基準 | 「古い」「放置」の日数、OK / NG の決め方、重大度の目安 |
| 記録用テンプレート | 「記録用テンプレート」のコードブロック |

次に、手順書の **すべての章・項目** を、次の 3 つに分ける。分けた結果は Step 4 で下書きの各行に使う。

| 区分 | 当てはまる項目 | この skill での扱い |
|---|---|---|
| **自動** | 認証なしで取れる公開ページの HTTP / HTML、リポジトリ内で読み取り専用のコマンド（`npm audit --package-lock-only` など）、`gh` での読み取り | 実行して結果を書く |
| **人が確認** | 管理画面へのログイン、ホスティングの管理画面、フォームの送信、メールの受信、見た目の判断、関係者への確認 | 結果欄は空欄のまま、「人が確認」と書く |
| **未対応（SSH 権限待ち）** | サーバーへの SSH、WP-CLI、サーバー上のログの読み取りが必要で、ブラウザの管理画面では代わりにならないもの | 結果欄は空欄のまま、「未対応（SSH 権限待ち）」と書く |

1 つの章に区分の違う項目が混ざるときは、章の結果欄は空欄にして、メモ欄に項目ごとの区分を書く
（例:「表示の有無は HTML で確認済み。送信テストは人が確認」）。

### Step 2: 表示の確認（公開ページ）

1. 表からページの一覧を作る。1 行に URL が複数あれば全部を対象にする。「対象外」と書かれたページ（非公開など）は取得しない
   - 「最新の記事 1 件」「配下のページ 1 件」のように URL が決まっていないものは、先に一覧ページを取得し、本文中の該当リンク（同じサイト内のもの）から 1 件選ぶ。どのリンクを選んだかを記録する
   - 「存在しないページ」は、404 が返ることを期待値として扱う
2. `${CLAUDE_SKILL_DIR}/scripts/http-check.sh` で取得する。入力は「ラベル<TAB>パス」を 1 行 1 件:

   ```bash
   printf '%s\t%s\n' "トップ" "/" "企業情報" "/company" ... > "$W/targets.tsv"
   bash "${CLAUDE_SKILL_DIR}/scripts/http-check.sh" "<本番 URL>" "$W" < "$W/targets.tsv" > "$W/http.jsonl"
   ```

   各行に `first_status`（最初の応答）・`final_status`（転送後）・`final_url`・`body`（保存した HTML のパス）が入る
3. ステータスを判定する

   | 状況 | 判定 |
   |---|---|
   | 期待どおり（通常のページは最終 200、存在しないページは 404） | OK |
   | 301 / 308 で、末尾の `/` を足しただけ・`http`→`https` だけの転送の後に 200 | OK（メモに転送があったことを書く） |
   | それ以外の転送（別のパス、別のドメイン、ログイン画面） | 要確認 |
   | 別のサイトへの転送で、「見るところ」がそのサイトへのリンク・転送を求めている（例:「採用サイトへのリンク」） | OK |
   | 4xx / 5xx / 000（接続できない） | NG |
   | 本文は PDF や画像なのに、ステータスが 404 など 200 以外（`content_type` と `final_status` を両方見る） | NG（ブラウザでは見えても、検索エンジンやリンクチェッカーからは見つからない扱いになる） |
   | 存在しないページが 200 を返す（いわゆる soft 404） | NG |

4. 「見るところ」の各要素について、保存した HTML に **根拠があるか** を調べる。HTML の中身は表示しすぎない（`grep -c` や、該当箇所の短い抜粋にとどめる）
   - 調べ方の例: スライダーやカルーセルの要素（クラス名、スライドの数）、一覧の記事リンクの数、絞り込みの UI（`select` / タブ / カテゴリのリンク）、
     埋め込み（`iframe` / `script` の読み込み元のドメイン）、言語切り替えのリンク（`hreflang` や別言語のパスへのリンク）、`form` 要素、404 ページの見出し
   - 「PDF のリンク」「入館案内 PDF」のように手順書がファイルを名指しする場合や、PDF へのリンクがある場合は、そのファイルも `http-check.sh` で取得してステータスを見る（ページごとに数件まで）
   - 表に載っているページが入口（ハブ）で、要素がその先のページにある場合（例: お問い合わせの種別ごとにフォームのページが分かれている）は、
     同じサイト内のリンクを 1 件だけたどって確かめ、たどった URL を記録する
   - 表のページが 404 などで、トップページなどからそのページへのリンクも見つからない場合は、ページを廃止した可能性として「要確認」にし、Step 6 の手順書への提案に入れる
   - JavaScript で後から描画される要素、画像の見え方、レイアウトの崩れは HTML では判定しない。「人が確認」にする
   - 判定は「あり」「なし」「HTML では判定できない（人が確認）」の 3 つ。「なし」は NG の候補として下書きに書く
5. ページごとに、ステータス・転送・各要素の判定と根拠（例:「`.swiper-slide` が 5 件」「PDF リンク 2 件、どちらも 200」）を記録する

### Step 3: ライブラリと GitHub

手順書の項目にあるものだけを、手順書が指定する場所で実行する。コマンドがない・失敗したときは、結果を推測せず「未実施（理由）」と書く。

#### ライブラリの監査

| 項目 | 実行するコマンド | 補足 |
|---|---|---|
| `composer audit` | `composer audit --locked --format=json`（手順書の指定ディレクトリで） | `--locked` で `composer.lock` だけを見る（`vendor/` は不要）。`composer` がなければ「未実施（composer がない）」と書き、インストールはユーザーに任せる |
| `npm audit` | `npm audit --package-lock-only --json`（手順書の指定ディレクトリで） | `--package-lock-only` で `package-lock.json` だけを見る（`node_modules/` は不要、何もインストールしない） |

- Node のバージョン管理（nodenv / nvm / volta など）が、リポジトリ指定のバージョンがないために `npm` を止める場合は、入っている別のバージョンで実行してよい
  （例: `NODENV_VERSION=<入っているバージョン> npm audit ...`）。`--package-lock-only` の結果は Node のバージョンにほとんど左右されない。使ったバージョンを下書きの付録に書く
- `npm install` / `composer install` / `npm audit fix` / `composer update` は実行しない（ファイルが変わる）
- 結果は、重大度ごとの件数、パッケージ名、直接依存か間接依存か、修正版の有無、`composer audit` の abandoned（放棄されたパッケージ）にまとめる。
  アドバイザリの本文は貼らず、ID（GHSA / CVE）とリンクだけにする
- コマンドは脆弱性があると 0 以外で終わる。終了コードではなく JSON の中身で判定する

#### GitHub

`<owner>/<repo>` は Step 0 で特定したもの。取得できない（権限がない、機能が無効）ときは、そう書く。

```bash
# Dependabot のアラート（open のもの）
gh api "repos/<owner>/<repo>/dependabot/alerts?state=open&per_page=100" --paginate \
  --jq '.[] | {number, severity: .security_advisory.severity, package: .dependency.package.name,
               ecosystem: .dependency.package.ecosystem, manifest: .dependency.manifest_path,
               ghsa: .security_advisory.ghsa_id, created_at, url: .html_url}'

# ブランチと最終 commit の日付、open PR の有無
gh api graphql --paginate -f owner=<owner> -f repo=<repo> -f query='
  query($owner: String!, $repo: String!, $endCursor: String) {
    repository(owner: $owner, name: $repo) {
      refs(refPrefix: "refs/heads/", first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { name
          target { ... on Commit { committedDate } }
          associatedPullRequests(states: OPEN) { totalCount } }
      }
    }
  }' --jq '.data.repository.refs.nodes[]
           | {name, committed: .target.committedDate, open_prs: .associatedPullRequests.totalCount}'

# open の PR
gh pr list -R <owner>/<repo> --state open --limit 200 \
  --json number,title,author,isDraft,headRefName,baseRefName,createdAt,updatedAt,url
```

- **Dependabot が見るのは default branch だけ。** default branch が、Step 0 で記録した監査対象のブランチ（本番の元になるブランチ）と違う場合は、
  アラートの件数が本番の実態とずれることを下書きに書く。npm / composer の監査結果と食い違うときは、監査のほうを本番に近い結果として扱う
- **古いブランチ:** 最終 commit から `--branch-stale-days` 日を超え、open PR がないもの。default branch と、保護されているブランチは除く
- **放置された PR:** 最終更新から `--pr-stale-days` 日を超えたもの。draft かどうかも書く
- 基準の日数は、下書きにも書いておく（読む人が判定の根拠を確かめられるように）
- ブランチの削除や PR のクローズは提案にとどめ、実行しない

### Step 4: 下書きを作る

手順書の **記録用テンプレートを、そのままの構成で** 埋める。見出しや表の行を足したり消したりしない（詳細は末尾の付録に書く）。

- **確認日:** 実施日。**確認者:** 空欄（人が書く）。**対象期間:** Step 0 で決めたもの
- **自動の章:** 結果欄に OK / NG を入れ、メモ欄に要約（件数と NG の要点）を書く
  - 表示の章は、HTTP / HTML の確認がすべて OK でも、見た目の確認が残るので結果欄は空欄のままにし、メモ欄に
    「HTTP・HTML の自動確認: N ページ OK（見た目は人が確認）」のように書く。NG があれば結果欄に NG と書いてよい
  - ライブラリ・GitHub の章は、脆弱性・アラート・古いブランチ・放置 PR が 1 件でもあれば NG、なければ OK。
    手順書の「NG だった場合」で推奨事項に回すとされているもの（すぐに影響が出ないもの）は、「次月以降の推奨事項」にも書く
- **人が確認 / 未対応の章:** 結果欄は空欄のまま、メモ欄の先頭に「人が確認」か「未対応（SSH 権限待ち）」と書く。1 章の中で分かれるときは Step 1 のとおり項目ごとに書く
- **自動更新と確認の結果 / 対応した事象:** この skill では分からないので、「（人が記入）」と書く
- **見つかった問題と対応:** NG と要確認の項目を、何が・どこで・どうだったかで 1 行ずつ書く。重大度は手順書の目安で **候補** として書き（例:「重大度の候補: P3」）、決定は人に任せる
- **次月以降の推奨事項:** ライブラリの更新、古いブランチの整理など
- テンプレートの後ろに `### 付録: 自動確認の詳細` を足し、Step 2 のページごとの表と、Step 3 の一覧（脆弱性、アラート、ブランチ、PR）を置く。
  付録の冒頭に、この下書きは Claude が作ったもので、人が確認してから投稿すること、使った手順書（パスと commit / ref）、
  監査したブランチと commit、本番の URL、使った基準（日数）を書く

保存先は `--out`（既定 `${TMPDIR:-/tmp}/monthly-check/<repo>-<YYYY-MM>.md`）。

### Step 5: 秘密情報の検査

下書きを保存したら、**ユーザーに見せる前に** 検査する。

```bash
# 秘密情報を含みうる設定ファイルの候補（中身は表示しない）
git ls-files | grep -E '(^|/)(\.env(\..+)?|wp-config\.php)$|(^|/)config/[^/]+\.json$|secret|credential' \
  | grep -vE '\.example$|-sample\.php$' > "$W/secret-files.txt"
python3 -I "${CLAUDE_SKILL_DIR}/scripts/secret-scan.py" "<下書きのパス>" $(cat "$W/secret-files.txt")
```

- 手順書に「秘密情報を含むファイル」が書かれていれば、それも引数に加える
- 終了コードが 1 なら、出力された行を下書きから消すか伏せ字にし、もう一度検査する。0 になるまで次に進まない
- スクリプトの出力（行番号と種類）以外に、設定ファイルの中身を調べにいかない

### Step 6: 報告

チャットに次を出す。下書きの全文はファイルにあるので、チャットには要約だけを書く。

1. 下書きの保存先（フルパス）
2. 結果の要約: 章ごとの OK / NG / 人が確認 / 未対応と、NG・要確認の項目
3. 人が続けて行うこと: 「人が確認」の項目、確認者の記入、見た目の確認、報告先への投稿
4. **手順書への提案:** 実行してみて、手順書から読み取れなかったこと・あいまいだったこと（URL の書き方、基準の日数、OK / NG の決め方など）。
   手順書は直接書き換えず、提案としてユーザーに返す

最後に作業ディレクトリ `$W` を削除する（取得した HTML に個人情報が含まれることがあるため）。
