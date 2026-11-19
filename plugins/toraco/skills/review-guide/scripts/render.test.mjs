import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMarker } from './marker.mjs'
import { buildPageData, excerpt, exportProse, GUIDE_MARKER, importProse, parsePatch, prepare, renderComment, renderPage, shortNames, validate } from './render.mjs'

const file = (filename, extra = {}) => ({ filename, status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@\n-a\n+b', ...extra })
const files = [
  file('src/usecase/index.ts'),
  file('src/routes/admin/user/handlers.ts'),
  file('src/routes/admin/hotel/user/handlers.ts'),
  file('src/usecase/index.test.ts'),
  file('docs/spec.md'),
]
const pr = { number: 12, head: { sha: 'abcdef0123456789' }, base: { repo: { full_name: 'o/r' } } }
const spec = {
  summary: '会員の認可をホテル単位にする',
  cards: [{ kind: 'behavior', title: '認可の対象が変わる', body: '確かめてください', before: '全体', after: 'ホテルごと', excerpts: [{ path: 'src/usecase/index.ts' }] }],
  must: [{ path: 'src/usecase/index.ts', note: '本体' }],
  skim: [{ path: 'src/routes/admin/hotel/user/handlers.ts', note: '新しいハンドラ' }],
  tests: [{ path: 'src/usecase/index.test.ts' }],
  docs: [{ path: 'docs/spec.md' }],
  skip: [{ path: 'src/routes/admin/user/handlers.ts', note: '削除。置き換え済み' }],
}

test('表示名は、重なるものだけ階層を伸ばして区別する', () => {
  const names = shortNames(files.map((f) => f.filename))
  assert.equal(names.get('src/routes/admin/user/handlers.ts'), 'admin/user/handlers.ts')
  assert.equal(names.get('src/routes/admin/hotel/user/handlers.ts'), 'hotel/user/handlers.ts')
  assert.equal(names.get('docs/spec.md'), 'docs/spec.md')
})

test('正しい仕分けは検査を通る', () => {
  assert.deepEqual(validate(spec, files), [])
})

test('仕分け漏れ・重複・未知のパス・説明の欠落を検出する', () => {
  const broken = {
    ...spec,
    must: [{ path: 'src/usecase/index.ts' }, { path: 'src/unknown.ts', note: 'x' }],
    docs: [],
    skip: [...spec.skip, { path: 'src/usecase/index.test.ts', note: '重複' }],
  }
  const errors = validate(broken, files).join('\n')
  assert.match(errors, /説明（note）がありません: src\/usecase\/index\.ts/)
  assert.match(errors, /変更ファイルに無いパスです: src\/unknown\.ts/)
  assert.match(errors, /src\/usecase\/index\.test\.ts が tests と skip の両方にあります/)
  assert.match(errors, /仕分けられていないファイルがあります: docs\/spec\.md/)
})

test('必ず見るパスは「見なくてよい」に入れられない', () => {
  const withMigration = [...files, file('prisma/migrations/1/migration.sql')]
  const bad = { ...spec, skip: [...spec.skip, { path: 'prisma/migrations/1/migration.sql', note: '小さい' }] }
  assert.match(validate(bad, withMigration).join('\n'), /必ず見るパスなので/)
})

test('確かめることと概要が無ければ通さない', () => {
  const errors = validate({ ...spec, cards: [], summary: ' ' }, files).join('\n')
  assert.match(errors, /cards/)
  assert.match(errors, /summary/)
})

test('カードの種類・前後の対・引用する行の範囲を検査する', () => {
  const big = [file('src/a.ts', { patch: '@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+added\n ctx2' })]
  const base = { summary: 's', must: [{ path: 'src/a.ts', note: 'x' }], skim: [], tests: [], docs: [], skip: [] }
  const card = (extra) => ({ ...base, cards: [{ kind: 'decision', title: 't', body: 'b', ...extra }] })
  assert.deepEqual(validate(card({ excerpts: [{ path: 'src/a.ts', from: 11, to: 12 }] }), big), [])
  const errors = [
    validate(card({ kind: 'other' }), big),
    validate(card({ before: 'x' }), big),
    validate(card({ excerpts: [{ path: 'src/a.ts', from: 10, to: 10 }] }), big),
    validate(card({ excerpts: [{ path: 'src/a.ts', from: 12, to: 11 }] }), big),
    validate(card({ excerpts: [{ path: 'src/b.ts' }] }), big),
  ].map((e) => e.join('\n'))
  assert.match(errors[0], /kind/)
  assert.match(errors[1], /before と after/)
  assert.match(errors[2], /変更行がありません/)
  assert.match(errors[3], /from ≤ to/)
  assert.match(errors[4], /変更ファイルに無いパス/)
})

test('関係図・差分の外・要件の誤りを検出する', () => {
  const bad = {
    ...spec,
    requirements: [{ text: 'r', status: 'done' }],
    outside: [{ path: 'src/usecase/index.ts', line: 3, note: '変更ファイル' }],
    map: { layers: [{ name: 'a', paths: ['src/usecase/index.ts', 'src/nowhere.ts'] }], edges: [{ from: 'src/usecase/index.ts', to: 'docs/spec.md' }] },
  }
  const errors = validate(bad, files).join('\n')
  assert.match(errors, /requirements\[0\]: status/)
  assert.match(errors, /outside\[0\]: PR の変更ファイルは outside に入れません/)
  assert.match(errors, /変更ファイルにも outside にも無いパスです: src\/nowhere\.ts/)
  assert.match(errors, /map\.edges\[0\]/)
})

test('patch の行に、新旧の行番号と新しい側の位置を付ける', () => {
  const lines = parsePatch('@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+added\n ctx2')
  assert.deepEqual(lines.map((l) => [l.t, l.old, l.new, l.anchor]), [
    ['@', undefined, undefined, undefined],
    [' ', 10, 10, 10],
    ['-', 11, undefined, 11],
    ['+', undefined, 11, 11],
    ['+', undefined, 12, 12],
    [' ', 12, 13, 13],
  ])
})

test('抜粋は新しい側の行番号で切り出し、離れた hunk の間に区切りを入れる', () => {
  const f = file('src/a.ts', { patch: '@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -50,2 +50,2 @@\n-x\n+y\n z' })
  assert.deepEqual(excerpt(f, { from: 1, to: 1 }).lines.map((l) => l.t + l.text), ['-a', '+b'])
  assert.deepEqual(excerpt(f).lines.map((l) => l.t + l.text), ['-a', '+b', ' c', '@…', '-x', '+y', ' z'])
  const long = file('src/b.ts', { patch: `@@ -0,0 +1,50 @@\n${Array.from({ length: 50 }, (_, i) => `+l${i}`).join('\n')}` })
  const cut = excerpt(long, {}, 10)
  assert.equal(cut.lines.length, 10)
  assert.equal(cut.truncated, true)
})

const PAGE = 'https://claude.ai/code/artifact/0b5e7c1a-2f3d-4e5f-8a9b-1c2d3e4f5a6b'

test('ページが無いときのコメントは、確かめることを差分つきですべて載せる', () => {
  const body = renderComment(spec, files, pr, { repo: 'o/r' })
  assert.ok(body.startsWith(GUIDE_MARKER))
  assert.match(body, /head `abcdef0` の 5 ファイル。会員の認可をホテル単位にする/)
  assert.match(body, /\*\*1\. 認可の対象が変わる\*\*/)
  assert.match(body, /- これまで: 全体\n- これから: ホテルごと/)
  assert.match(body, /\[`usecase\/index\.ts` 差分\]\(https:\/\/github\.com\/o\/r\/pull\/12\/files#diff-[0-9a-f]{64}R?\d*\)\n\n```diff\n-a\n\+b\n```/)
  assert.doesNotMatch(body, /レビューページ/)
  assert.deepEqual(parseMarker(body), { head: 'abcdef0', paths: ['src/routes/admin/user/handlers.ts'] })
})

test('ページがあるときのコメントは、上位 3 件とページへのリンクにする', () => {
  const many = { ...spec, cards: Array.from({ length: 5 }, (_, i) => ({ kind: 'decision', title: `決めたこと ${i + 1}`, body: 'b' })) }
  const body = renderComment(many, files, pr, { repo: 'o/r', pageUrl: PAGE })
  assert.match(body, new RegExp(`\\[レビューページ\\]\\(${PAGE}\\)に、ファイルの関係図`))
  assert.match(body, /### 確かめること（上位 3 件 \/ 全 5 件）/)
  assert.match(body, /ほかに 2 件: 決めたこと 4 \/ 決めたこと 5/)
  assert.equal(parseMarker(body).page, PAGE)
  assert.throws(() => renderComment(spec, files, pr, { repo: 'o/r', pageUrl: 'https://example.com/x' }), /artifact/)
})

test('差分に ``` を含むときは、それより長いフェンスで囲む', () => {
  const md = [file('README.md', { patch: '@@ -1 +1 @@\n-a\n+```sh' })]
  const s2 = { summary: 's', cards: [{ kind: 'decision', title: 't', body: 'b', excerpts: [{ path: 'README.md' }] }], must: [], skim: [], tests: [], docs: [{ path: 'README.md' }], skip: [] }
  assert.match(renderComment(s2, md, pr, { repo: 'o/r' }), /````diff\n-a\n\+```sh\n````/)
})

test('要件は、ページがあるときは足りないものだけをコメントに出す', () => {
  const withReq = { ...spec, requirements: [{ text: '満たす', status: 'ok' }, { text: '足りない', status: 'missing' }] }
  const body = renderComment(withReq, files, pr, { repo: 'o/r', pageUrl: PAGE })
  assert.match(body, /### 要件とテスト（✅ 1 \/ ⚠️ 1）\n\n- ⚠️ 足りない（テストなし）/)
  assert.doesNotMatch(body, /満たす/)
})

test('ページのデータは、リンク・区分・抜粋を解決し、HTML に安全に埋め込む', () => {
  const s2 = {
    ...spec,
    outside: [{ path: 'src/caller.ts', line: 7, note: '呼び出し元', from: 'src/usecase/index.ts' }],
    map: { layers: [{ name: '中心', paths: ['src/usecase/index.ts', 'src/caller.ts'] }], edges: [{ from: 'src/caller.ts', to: 'src/usecase/index.ts' }] },
    summary: '</script><script>alert(1)</script>',
  }
  assert.deepEqual(validate(s2, files), [])
  const data = buildPageData(s2, files, { ...pr, title: ':sparkles: 認可を変える', head: { sha: 'abcdef0123456789', ref: 'feat' } }, { repo: 'o/r', generatedAt: 't' })
  assert.equal(data.title, '認可を変える')
  assert.equal(data.files.find((f) => f.path === 'src/usecase/index.ts').section, 'must')
  assert.equal(data.outside[0].link, 'https://github.com/o/r/blob/abcdef0123456789/src/caller.ts#L7')
  assert.deepEqual(data.cards[0].excerpts[0].lines.map((l) => l.t), ['-', '+'])
  const html = renderPage(data, '<title>__PAGE_TITLE__</title><script type="application/json">/*__REVIEW_DATA__*/null</script>')
  assert.match(html, /<title>PR #12 認可を変える<\/title>/)
  assert.doesNotMatch(html, /<\/script><script>alert/)
  assert.equal(JSON.parse(html.match(/json">(.*)<\/script>$/)[1]).summary, s2.summary)
})

test('同梱のテンプレートに、データとタイトルの差し込み口がある', () => {
  const html = renderPage(buildPageData(spec, files, pr, { repo: 'o/r' }))
  assert.match(html, /<title>PR #12 /)
  assert.doesNotMatch(html, /__REVIEW_DATA__|__PAGE_TITLE__/)
})

test('下準備は機械的な判定と必ず見るパスを添える', () => {
  const r = prepare([file('pnpm-lock.yaml'), file('.github/workflows/ci.yml'), file('src/a.ts')])
  assert.equal(r[0].mechanical, 'lockfile')
  assert.equal(r[1].neverSkip, true)
  assert.equal(r[2].mechanical, undefined)
})

test('生成された migration のメタデータは「見なくてよい」に入れられる', () => {
  const withMigration = [
    ...files,
    file('db/migrations/0001_x.sql'),
    file('db/migrations/meta/_journal.json'),
  ]
  const ok = {
    ...spec,
    must: [...spec.must, { path: 'db/migrations/0001_x.sql', note: 'テーブルの追加' }],
    skip: [...spec.skip, { path: 'db/migrations/meta/_journal.json', note: '生成物' }],
  }
  assert.deepEqual(validate(ok, withMigration), [])
  const prepared = prepare(withMigration)
  assert.equal(prepared.at(-1).neverSkip, undefined)
  assert.match(prepared.at(-1).mechanical, /migration/)
  assert.equal(prepared.at(-2).neverSkip, true)
})

test('地の文は目印つきで書き出し、推敲した文を同じ欄に書き戻せる', () => {
  const md = exportProse(spec)
  assert.match(md, /^<!-- review-guide:prose summary -->\n会員の認可をホテル単位にする\n/)
  assert.match(md, /<!-- review-guide:prose cards\.0\.before -->\n全体\n/)
  assert.doesNotMatch(md, /tests\.0\.note/) // note の無い欄は出さない
  const polished = md.replace('会員の認可をホテル単位にする', '会員の認可を、ホテルごとに判定します。\n\n2 行目')
  const next = importProse(spec, polished)
  assert.equal(next.summary, '会員の認可を、ホテルごとに判定します。\n\n2 行目')
  assert.equal(next.cards[0].title, spec.cards[0].title)
  assert.equal(spec.summary, '会員の認可をホテル単位にする') // 元の spec は変えない
  assert.deepEqual(importProse(spec, md), spec)
})

test('目印が消えた・増えた・入れ替わった・欄が空になったときは書き戻さない', () => {
  const md = exportProse(spec)
  assert.throws(() => importProse(spec, md.replace('<!-- review-guide:prose cards.0.body -->\n', '')), /足りない: cards\.0\.body/)
  assert.throws(() => importProse(spec, `${md}\n<!-- review-guide:prose cards.9.title -->\nx\n`), /余分: cards\.9\.title/)
  const blocks = md.split('\n\n')
  assert.throws(() => importProse(spec, [blocks[1], blocks[0], ...blocks.slice(2)].join('\n\n')), /順序が違う/)
  assert.throws(() => importProse(spec, md.replace('\n全体\n', '\n\n')), /cards\.0\.before が空/)
  assert.throws(() => importProse(spec, `前置き\n${md}`), /最初の目印より前/)
})
