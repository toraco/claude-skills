import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMarker, parseMarker, selectPaths } from './marker.mjs'

const HEAD = '1486b8c3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const mod = (filename) => ({ filename, status: 'modified', changes: 2, patch: '@@\n-a\n+b' })

test('一覧はコメント本文に埋め込んで取り出せる', () => {
  const body = `## ガイド\n\n${buildMarker({ head: '1486b8c', paths: ['a.ts', 'b c/d.ts'] })}\n`
  assert.deepEqual(parseMarker(body), { head: '1486b8c', paths: ['a.ts', 'b c/d.ts'] })
})

test('一覧が無い・壊れているコメントは null', () => {
  assert.equal(parseMarker('ただのコメント'), null)
  assert.equal(parseMarker('<!-- review-guide:skip {oops} -->'), null)
  assert.equal(parseMarker('<!-- review-guide:skip {"head":"zzz","paths":[]} -->'), null)
  assert.equal(parseMarker('<!-- review-guide:skip {"head":"1486b8c","paths":[1]} -->'), null)
})

test('ガイドが挙げたパスのうち、PR の変更ファイルにあるものだけを選ぶ', () => {
  const r = selectPaths({
    marker: { head: '1486b8c', paths: ['src/a.ts', 'src/gone.ts'] },
    prHead: HEAD,
    files: [mod('src/a.ts'), mod('src/b.ts')],
  })
  assert.deepEqual(r.selected, [{ path: 'src/a.ts', reason: 'guide' }])
  assert.equal(r.stale, false)
})

test('head が変わっていたら、ガイドの一覧は使わない', () => {
  const r = selectPaths({
    marker: { head: 'deadbee', paths: ['src/a.ts'] },
    prHead: HEAD,
    files: [mod('src/a.ts'), mod('pnpm-lock.yaml')],
  })
  assert.equal(r.stale, true)
  assert.deepEqual(r.selected, [{ path: 'pnpm-lock.yaml', reason: 'lockfile' }])
})

test('never-skip のパスは、ガイドが挙げていても選ばない', () => {
  const r = selectPaths({
    marker: { head: '1486b8c', paths: ['prisma/migrations/1/migration.sql', '.github/workflows/ci.yml', 'src/a.ts'] },
    prHead: HEAD,
    files: [mod('prisma/migrations/1/migration.sql'), mod('.github/workflows/ci.yml'), mod('src/a.ts')],
  })
  assert.deepEqual(r.selected, [{ path: 'src/a.ts', reason: 'guide' }])
  assert.deepEqual(r.rejected, ['prisma/migrations/1/migration.sql', '.github/workflows/ci.yml'])
})

test('ガイドが無くても、機械的に確かめられるものは選ぶ', () => {
  const r = selectPaths({ marker: null, prHead: HEAD, files: [mod('pnpm-lock.yaml'), mod('src/a.ts')] })
  assert.deepEqual(r.selected, [{ path: 'pnpm-lock.yaml', reason: 'lockfile' }])
})
