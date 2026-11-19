import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMarker } from './marker.mjs'
import { GUIDE_MARKER, prepare, render, shortNames, validate } from './render.mjs'

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
  points: ['認可の対象が変わる'],
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

test('判断してほしい点が空なら通さない', () => {
  assert.match(validate({ ...spec, points: [] }, files).join('\n'), /points/)
})

test('本文には目印・件数・リンク・Viewed 用の一覧が入る', () => {
  const body = render(spec, files, pr, { repo: 'o/r' })
  assert.ok(body.startsWith(GUIDE_MARKER))
  assert.match(body, /head `abcdef0` の 5 ファイル/)
  assert.match(body, /### 必読（1 件、読む順）/)
  assert.match(body, /\[`usecase\/index\.ts`\]\(https:\/\/github\.com\/o\/r\/pull\/12\/files#diff-[0-9a-f]{64}\)（\+3 −1）: 本体/)
  assert.deepEqual(parseMarker(body), { head: 'abcdef0', paths: ['src/routes/admin/user/handlers.ts'] })
})

test('テストやドキュメントが無ければ、その節は出さない', () => {
  const only = [file('src/a.ts')]
  const body = render({ points: ['特になし'], must: [{ path: 'src/a.ts', note: 'x' }], skim: [], tests: [], docs: [], skip: [] }, only, pr, { repo: 'o/r' })
  assert.doesNotMatch(body, /### テスト/)
  assert.doesNotMatch(body, /### ドキュメント/)
  assert.match(body, /### 見なくてよい（0 件）\n\nなし/)
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
