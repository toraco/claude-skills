import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyFile, classifyFiles, DEFAULT_NEVER_SKIP, globToRegExp, isWhitespaceOnlyPatch } from './classify.mjs'

const modified = (filename, patch) => ({ filename, status: 'modified', changes: 2, patch })

test('内容が同じままのリネームはスキップする', () => {
  const r = classifyFile({ filename: 'src/b.ts', previous_filename: 'src/a.ts', status: 'renamed', changes: 0 })
  assert.deepEqual(r, { path: 'src/b.ts', skip: true, reason: 'moved' })
})

test('内容も変わったリネームはスキップしない', () => {
  const r = classifyFile({
    filename: 'src/b.ts',
    previous_filename: 'src/a.ts',
    status: 'renamed',
    changes: 2,
    patch: '@@ -1 +1 @@\n-a\n+b',
  })
  assert.equal(r.skip, false)
})

test('lockfile は階層を問わずスキップする', () => {
  assert.equal(classifyFile(modified('pnpm-lock.yaml', '@@\n-a\n+b')).reason, 'lockfile')
  assert.equal(classifyFile(modified('cdk/package-lock.json', '@@\n-a\n+b')).reason, 'lockfile')
})

test('生成物は設定で指定したパスだけスキップする', () => {
  const file = modified('packages/api/src/generated/client.ts', '@@\n-a\n+b')
  assert.equal(classifyFile(file).skip, false)
  assert.equal(classifyFile(file, { generated: ['**/generated/**'] }).reason, 'generated')
})

test('never-skip のパスは、どの理由に当たってもスキップしない', () => {
  const moved = {
    filename: 'prisma/migrations/2/migration.sql',
    previous_filename: 'prisma/migrations/1/migration.sql',
    status: 'renamed',
    changes: 0,
  }
  assert.equal(classifyFile(moved).skip, false)
  assert.equal(classifyFile(modified('.github/workflows/ci.yml', '@@\n-a \n+a')).skip, false)
  const out = { filename: 'src/a.sql', previous_filename: 'db/migrations/a.sql', status: 'renamed', changes: 0 }
  assert.equal(classifyFile(out).skip, false)
})

test('削除はスキップしない', () => {
  assert.equal(classifyFile({ filename: 'pnpm-lock.yaml', status: 'removed', changes: 9 }).skip, false)
})

test('行末の空白と改行コードだけの差分はスキップする', () => {
  assert.equal(isWhitespaceOnlyPatch('@@ -1,2 +1,2 @@\n ctx\n-const a = 1  \n+const a = 1'), true)
  assert.equal(isWhitespaceOnlyPatch('@@ -1 +1 @@\n-a\r\n+a'), true)
  assert.equal(isWhitespaceOnlyPatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a'), true)
})

test('内容・インデント・行の移動・空行の増減は空白だけの差分としない', () => {
  assert.equal(isWhitespaceOnlyPatch('@@ -1 +1 @@\n-a\n+b'), false)
  assert.equal(isWhitespaceOnlyPatch('@@ -1 +1 @@\n-  a\n+a'), false)
  assert.equal(isWhitespaceOnlyPatch('@@ -1,3 +1,3 @@\n-a\n ctx\n+a'), false)
  assert.equal(isWhitespaceOnlyPatch('@@ -1,2 +1,2 @@\n-a\n-b\n+b\n+a'), false)
  assert.equal(isWhitespaceOnlyPatch('@@ -1,2 +1,3 @@\n a\n+\n b'), false)
  assert.equal(isWhitespaceOnlyPatch('@@ -1,2 +1,2 @@\n+a\n-a'), false)
})

test('patch がないファイル（バイナリや巨大な差分）はスキップしない', () => {
  assert.equal(isWhitespaceOnlyPatch(undefined), false)
  assert.equal(classifyFile({ filename: 'a.png', status: 'modified', changes: 0 }).skip, false)
})

test('glob は ** と * を解釈する', () => {
  assert.equal(globToRegExp('**/migrations/**').test('a/b/migrations/1/x.sql'), true)
  assert.equal(globToRegExp('**/migrations/**').test('migrations/x.sql'), true)
  assert.equal(globToRegExp('.github/**').test('.github/workflows/a.yml'), true)
  assert.equal(globToRegExp('*.snap').test('a/b.snap'), false)
  assert.equal(globToRegExp('**/*.snap').test('a/b.snap'), true)
  assert.equal(globToRegExp('a.b').test('axb'), false)
})

const added = (filename) => ({ filename, status: 'added', changes: 1, patch: '@@ -0,0 +1 @@\n+a' })

test('migration の SQL と一緒に生成されたメタデータはスキップする', () => {
  const files = [
    added('api/db/migrations/0001_seller.sql'),
    added('api/db/migrations/meta/0001_snapshot.json'),
    modified('api/db/migrations/meta/_journal.json', '@@\n+a'),
  ]
  assert.deepEqual(
    classifyFiles(files).map((r) => r.reason),
    [undefined, 'migrationMeta', 'migrationMeta'],
  )
})

test('対応する SQL が無いメタデータはスキップしない', () => {
  const journal = modified('api/db/migrations/meta/_journal.json', '@@\n+a')
  const snapshot = added('api/db/migrations/meta/0002_snapshot.json')
  // SQL が無い、番号が違う、SQL を消した、別のディレクトリにある
  assert.equal(classifyFiles([journal, snapshot])[1].skip, false)
  assert.equal(classifyFiles([journal])[0].skip, false)
  assert.equal(classifyFiles([added('api/db/migrations/0001_seller.sql'), snapshot])[1].skip, false)
  assert.equal(
    classifyFiles([{ ...added('api/db/migrations/0002_x.sql'), status: 'removed' }, journal])[1].skip,
    false,
  )
  assert.equal(classifyFiles([added('web/db/migrations/0002_x.sql'), journal])[1].skip, false)
})

test('メタデータ自体の削除や、メタデータ以外の migration のファイルはスキップしない', () => {
  const sql = added('api/db/migrations/0001_seller.sql')
  const removed = { ...added('api/db/migrations/meta/0001_snapshot.json'), status: 'removed' }
  assert.equal(classifyFiles([sql, removed])[1].skip, false)
  assert.equal(classifyFiles([sql, added('api/db/migrations/meta/notes.json')])[1].skip, false)
})

test('リポジトリが足した never-skip に当たるメタデータはスキップしない', () => {
  const files = [added('api/db/migrations/0001_seller.sql'), added('api/db/migrations/meta/0001_snapshot.json')]
  const neverSkip = [...DEFAULT_NEVER_SKIP, 'api/db/**']
  assert.equal(classifyFile(files[1], { files, neverSkip }).skip, false)
})
