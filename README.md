# toraco claude-skills

toraco の共有 Claude Code skills を plugin marketplace として公開しているリポジトリ。

ローカルの Claude Code だけでなく、**Claude Code Web / Cowork のクラウドセッションからも使えるようにする**ために public にしてある。クラウドセッションの GitHub アクセスは専用プロキシ経由で、セッションにアタッチされたリポジトリにしか到達できないため、private リポジトリを marketplace にするとクラウドから clone できない。

## 構成

```
claude-skills/
├── .claude-plugin/marketplace.json   # marketplace: toraco-skills
└── plugins/toraco/
    ├── .claude-plugin/plugin.json    # plugin: toraco
    └── skills/
        ├── _shared/                  # 複数 skill から参照する共通ドキュメント（skill としては発動しない）
        └── <skill-name>/SKILL.md
```

## 収録 skill

| skill | 用途 |
|---|---|
| `commit` / `ship` | コミット・PR 作成・ブランチ退避 |
| `check` / `bugfix` | テスト/リント/ビルド・バグ修正 |
| `local-review` / `fix-review` / `auto-fix-review` | レビュー生成と指摘の反映 |
| `revise-spec` / `revise-tests` | 仕様書・テストの見直し |
| `make-plan` / `grilling` | 計画立案・壁打ち |
| `file-issue` | issue 起票 |
| `release` / `fix-ci` | リリース・CI 修復 |

## 使い方

### ローカル

```
claude plugin marketplace add toraco/claude-skills
claude plugin install toraco@toraco-skills
```

skill は `/toraco:<skill-name>` で起動する。

> marketplace はローカルディレクトリではなく **GitHub ソースで登録すること。** ディレクトリソースで登録すると plugin skill がスラッシュコマンドとして登録されない（anthropics/claude-code#57737）。

### クラウドセッション（Claude Code Web / Cowork）

ユーザースコープの設定（`~/.claude/settings.json` や `~/.claude/skills/`）はクラウドに引き継がれない。作業リポジトリ側で用意する必要がある。

`.claude/settings.json`（コミットする）:

```json
{
  "extraKnownMarketplaces": {
    "toraco-skills": { "source": { "source": "github", "repo": "toraco/claude-skills" } }
  },
  "enabledPlugins": { "toraco@toraco-skills": true }
}
```

宣言だけではインストールが走らない場合があるため（初回セッションで marketplace の clone が session start に間に合わない既知の問題）、クラウド環境の **Setup script** にも冪等な導入コマンドを書いておくと確実。Setup script は Claude Code の起動前に実行される。

```bash
claude plugin marketplace list | grep -q toraco-skills || \
  claude plugin marketplace add toraco/claude-skills
claude plugin list | grep -q "toraco@toraco-skills" || \
  claude plugin install toraco@toraco-skills
```

## SKILL.md の規約

- **frontmatter は Agent Skills spec の 6 キーに絞る**: `name` / `description` / `license` / `compatibility` / `metadata` / `allowed-tools`。plugin 経由の配布では Claude Code 固有キー（`argument-hint` / `disable-model-invocation` など）も使えるが、claude.ai へのアップロード経路と共用できるよう spec に寄せてある。
  - 引数の説明は本文 H1 直後の `**使い方**: /<name> [args]` に書く。
  - 明示起動専用にしたい skill は description 末尾に「自動起動はせず、ユーザーが明示的に指示したときだけ使う。」と書く。
- **description は 200 文字以内**。skill 一覧は文字数予算があり、溢れると使用頻度の低い skill の description ごと落とされる。
- 同梱ファイルを参照するときは `${CLAUDE_SKILL_DIR}` を使う。`_shared/` は `${CLAUDE_SKILL_DIR}/../_shared/` で参照する。

## 検証

```
claude plugin validate .
claude plugin marketplace add toraco/claude-skills && claude plugin install toraco@toraco-skills
claude plugin details toraco   # Skills (14) と出れば OK
```
