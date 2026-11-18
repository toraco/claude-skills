#!/usr/bin/env node
// レビューガイドの下準備と組み立て。GitHub の API は呼ばない。
//
//   node render.mjs prepare <files.json>
//     変更ファイルの一覧を、機械的な判定の結果と一緒に出す（仕分けの材料）
//   node render.mjs render <spec.json> <files.json> <pr.json>
//     仕分け（spec）を検査し、PR に投稿するコメントの本文を標準出力に出す
//
// files.json は `GET /repos/{owner}/{repo}/pulls/{n}/files` の全ページをつないだ配列、
// pr.json は `GET /repos/{owner}/{repo}/pulls/{n}` の結果。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { classifyFile, DEFAULT_NEVER_SKIP, matchesAny, REASONS } from './classify.mjs'
import { buildMarker } from './marker.mjs'

export const GUIDE_MARKER = '<!-- review-guide -->'
export const SECTIONS = ['must', 'skim', 'tests', 'docs', 'skip']

/** 一覧の中で区別がつく最短の表示名（末尾 2 階層から、重なるものだけ伸ばす）。 */
export function shortNames(paths) {
  const names = new Map()
  const depth = new Map(paths.map((p) => [p, 2]))
  const name = (p) => p.split('/').slice(-depth.get(p)).join('/')
  for (;;) {
    const groups = new Map()
    for (const p of paths) groups.set(name(p), [...(groups.get(name(p)) ?? []), p])
    let extended = false
    for (const group of groups.values()) {
      if (group.length < 2) continue
      for (const p of group) {
        if (depth.get(p) < p.split('/').length) {
          depth.set(p, depth.get(p) + 1)
          extended = true
        }
      }
    }
    if (!extended) break
  }
  for (const p of paths) names.set(p, name(p))
  return names
}

export function prepare(files, { neverSkip = DEFAULT_NEVER_SKIP } = {}) {
  return files.map((f) => {
    const mechanical = classifyFile(f, { neverSkip })
    return {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.previous_filename ? { previous: f.previous_filename } : {}),
      ...(mechanical.skip ? { mechanical: REASONS[mechanical.reason] } : {}),
      ...(matchesAny(f.filename, neverSkip) ? { neverSkip: true } : {}),
    }
  })
}

/** spec の誤りを文字列の配列で返す。空なら問題なし。 */
export function validate(spec, files, { neverSkip = DEFAULT_NEVER_SKIP } = {}) {
  const errors = []
  const known = new Map(files.map((f) => [f.filename, f]))
  const seen = new Map()
  for (const section of SECTIONS) {
    if (!Array.isArray(spec[section])) {
      errors.push(`${section} が配列ではありません`)
      continue
    }
    for (const entry of spec[section]) {
      if (typeof entry?.path !== 'string') {
        errors.push(`${section} に path の無い項目があります`)
        continue
      }
      if (!known.has(entry.path)) errors.push(`${section}: PR の変更ファイルに無いパスです: ${entry.path}`)
      if (seen.has(entry.path)) errors.push(`${entry.path} が ${seen.get(entry.path)} と ${section} の両方にあります`)
      seen.set(entry.path, section)
      const needsNote = section === 'must' || section === 'skim' || section === 'skip'
      if (needsNote && !entry.note?.trim()) errors.push(`${section}: 説明（note）がありません: ${entry.path}`)
      if (section === 'skip') {
        const f = known.get(entry.path)
        const blocked = matchesAny(entry.path, neverSkip) || (f?.previous_filename && matchesAny(f.previous_filename, neverSkip))
        if (blocked) errors.push(`skip: 必ず見るパスなので「見なくてよい」に入れられません: ${entry.path}`)
      }
    }
  }
  for (const path of known.keys()) if (!seen.has(path)) errors.push(`仕分けられていないファイルがあります: ${path}`)
  if (!Array.isArray(spec.points) || spec.points.length === 0) errors.push('points（判断してほしい点）が空です。無ければ「特になし」と理由を 1 件書いてください')
  return errors
}

export function render(spec, files, pr, { repo, links = true } = {}) {
  const byPath = new Map(files.map((f) => [f.filename, f]))
  const names = shortNames(files.map((f) => f.filename))
  const stat = (p) => `（+${byPath.get(p).additions} −${byPath.get(p).deletions}）`
  const label = (p, withLink) => {
    const text = `\`${names.get(p)}\``
    if (!withLink || !links) return `${text}${stat(p)}`
    const hash = createHash('sha256').update(p).digest('hex')
    return `[${text}](https://github.com/${repo}/pull/${pr.number}/files#diff-${hash})${stat(p)}`
  }
  const item = (e, withLink) => `${label(e.path, withLink)}${e.note?.trim() ? `: ${e.note.trim()}` : ''}`
  const fold = (summary, lines) => `<details><summary>${summary}</summary>\n\n${lines.join('\n')}\n\n</details>`
  const head = pr.head.sha.slice(0, 7)
  const out = [
    GUIDE_MARKER,
    '## レビューガイド',
    '',
    `head \`${head}\` の ${files.length} ファイルを、差分を読んで仕分けました。必読は ${spec.must.length} 件です。「見なくてよい」の ${spec.skip.length} 件は、Viewed を付ける対象です。仕分けは Claude の判断で、機械的な検証はしていません。`,
    '',
    '### 判断してほしい点',
    '',
    ...spec.points.map((p, i) => `${i + 1}. ${p}`),
    '',
    `### 必読（${spec.must.length} 件、読む順）`,
    '',
    ...(spec.must.length ? spec.must.map((e, i) => `${i + 1}. ${item(e, true)}`) : ['なし']),
    '',
    `### 流し読み（${spec.skim.length} 件）`,
    '',
    ...(spec.skim.length ? spec.skim.map((e) => `- ${item(e, true)}`) : ['なし']),
    '',
  ]
  if (spec.tests.length) {
    out.push(`### テスト（${spec.tests.length} 件、テスト名で確認）`, '')
    if (spec.testsNote?.trim()) out.push(spec.testsNote.trim(), '')
    out.push(fold('ファイルの一覧', spec.tests.map((e) => `- ${item(e, false)}`)), '')
  }
  if (spec.docs.length) {
    out.push(`### ドキュメント（${spec.docs.length} 件）`, '')
    out.push(fold('ファイルの一覧', spec.docs.map((e) => `- ${item(e, false)}`)), '')
  }
  out.push(`### 見なくてよい（${spec.skip.length} 件）`, '')
  if (spec.skip.length) {
    if (spec.skipNote?.trim()) out.push(spec.skipNote.trim(), '')
    out.push(fold('ファイルと理由', spec.skip.map((e) => `- ${item(e, false)}`)), '')
  } else {
    out.push('なし', '')
  }
  out.push(buildMarker({ head, paths: spec.skip.map((e) => e.path) }))
  return `${out.join('\n')}\n`
}

const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'prepare' && args.length === 1) {
    console.log(JSON.stringify(prepare(read(args[0])), null, 1))
  } else if (command === 'render' && args.length === 3) {
    const [spec, files, pr] = args.map(read)
    const errors = validate(spec, files)
    if (errors.length) {
      console.error(errors.map((e) => `- ${e}`).join('\n'))
      process.exit(1)
    }
    process.stdout.write(render(spec, files, pr, { repo: pr.base.repo.full_name, links: process.env.NO_LINKS !== 'true' }))
  } else {
    console.error('usage: render.mjs prepare <files.json> | render <spec.json> <files.json> <pr.json>')
    process.exit(2)
  }
}
