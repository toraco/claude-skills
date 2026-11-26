#!/usr/bin/env node
// レビューガイドが Viewed の対象（見なくてよい・流し読み）としたファイルに、トークンの持ち主として Viewed を付ける。
// 一覧は、トークンの持ち主自身が投稿したレビューガイドのコメントから読む。
// 他人のコメントは信用しない（ファイルをレビューから隠す手段になるため）。
//
// 環境変数: VIEWED_TOKEN（必須）、TARGET_REPO（owner/name）、PR_NUMBER、
//           NEVER_SKIP / GENERATED（改行区切りの glob、任意）、DRY_RUN=true、
//           LOG_PATHS=true（既定ではパスをログに出さない）

import { appendFileSync } from 'node:fs'
import { DEFAULT_NEVER_SKIP } from './classify.mjs'
import { parseMarker, selectPaths } from './marker.mjs'

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const token = process.env.VIEWED_TOKEN
const repo = process.env.TARGET_REPO
const prNumber = Number(process.env.PR_NUMBER)
const dryRun = process.env.DRY_RUN === 'true'
const logPaths = process.env.LOG_PATHS === 'true'
const lines = (v) => (v ?? '').split('\n').map((s) => s.trim()).filter(Boolean)

if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isInteger(prNumber)) {
  console.error('VIEWED_TOKEN、TARGET_REPO（owner/name）、PR_NUMBER を指定してください')
  process.exit(2)
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'auto-viewed',
}

async function rest(path) {
  const out = []
  let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`
  while (url) {
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) return data
    out.push(...data)
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null
  }
  return out
}

async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.errors) {
    const detail = (data.errors ?? []).map((e) => `${e.type ?? ''} ${e.message}`).join('; ')
    throw new Error(`GraphQL: HTTP ${res.status} ${detail}`)
  }
  return data.data
}

const summary = (text) => {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

const { viewer } = await graphql('{ viewer { login } }')
const pr = await rest(`/repos/${repo}/pulls/${prNumber}`)
const files = await rest(`/repos/${repo}/pulls/${prNumber}/files`)
const comments = await rest(`/repos/${repo}/issues/${prNumber}/comments`)

// トークンの持ち主が投稿したガイドのうち、最も新しいものを使う
const marker =
  comments
    .filter((c) => c.user?.login === viewer.login)
    .map((c) => parseMarker(c.body))
    .filter(Boolean)
    .at(-1) ?? null

const neverSkip = [...DEFAULT_NEVER_SKIP, ...lines(process.env.NEVER_SKIP)]
const { selected, rejected, stale } = selectPaths({
  marker,
  prHead: pr.head.sha,
  files,
  neverSkip,
  options: { generated: lines(process.env.GENERATED) },
})

summary(`変更ファイル ${files.length} 件のうち ${selected.length} 件を Viewed の対象にします（${viewer.login} として）`)
if (!marker) summary('レビューガイドの一覧が見つからないため、機械的に確かめられるものだけを対象にしました')
if (stale) summary('レビューガイドを書いた後に PR が更新されているため、ガイドの一覧は使いませんでした')
if (rejected.length) summary(`ガイドが挙げた ${rejected.length} 件は、必ず見るパスに当たるため対象から外しました`)
if (logPaths) for (const s of selected) console.log(`  ${s.reason}\t${s.path}`)

if (dryRun) {
  summary('dry-run のため、Viewed は付けていません')
} else {
  for (let i = 0; i < selected.length; i += 40) {
    const chunk = selected.slice(i, i + 40)
    const body = chunk
      .map((_, j) => `f${j}: markFileAsViewed(input: { pullRequestId: $id, path: $p${j} }) { clientMutationId }`)
      .join('\n')
    const decl = chunk.map((_, j) => `$p${j}: String!`).join(', ')
    const vars = Object.fromEntries(chunk.map((s, j) => [`p${j}`, s.path]))
    await graphql(`mutation($id: ID!, ${decl}) {\n${body}\n}`, { id: pr.node_id, ...vars })
  }
  summary(`${selected.length} 件に Viewed を付けました`)
}
