#!/usr/bin/env node
// レビューガイドの下準備と組み立て。GitHub の API は呼ばない。
//
//   node render.mjs prepare <files.json>
//     変更ファイルの一覧を、機械的な判定の結果と一緒に出す（仕分けの材料）
//   node render.mjs check <spec.json> <files.json> <pr.json>
//     仕分け（spec）を検査する。問題が無ければ何も出さずに終わる
//   node render.mjs page <spec.json> <files.json> <pr.json>
//     レビューページ（Artifact に公開する HTML）を標準出力に出す
//   node render.mjs prose-export <spec.json>
//     spec の地の文（概要・カード・要件・注記など）を、推敲用の Markdown に書き出す
//   node render.mjs prose-import <spec.json> <prose.md>
//     推敲した Markdown を spec に書き戻し、新しい spec を標準出力に出す
//   node render.mjs comment <spec.json> <files.json> <pr.json> [<page-url>]
//     PR に投稿するコメントの本文を標準出力に出す。page-url を渡すと、ページへのリンクを入れて
//     コメントを要約にする。渡さなければ、確かめることをすべてコメントに入れる
//
// files.json は `GET /repos/{owner}/{repo}/pulls/{n}/files` の全ページをつないだ配列、
// pr.json は `GET /repos/{owner}/{repo}/pulls/{n}` の結果。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyFile, DEFAULT_NEVER_SKIP, matchesAny, REASONS } from './classify.mjs'
import { buildMarker } from './marker.mjs'

export const GUIDE_MARKER = '<!-- review-guide -->'
export const SECTIONS = ['must', 'skim', 'tests', 'docs', 'skip']
export const SECTION_LABELS = { must: '必読', skim: '流し読み', tests: 'テスト', docs: 'ドキュメント', skip: '見なくてよい' }
export const CARD_KINDS = {
  behavior: '振る舞いの変化',
  decision: '実装で決めたこと',
  assumption: '前提・仮定',
  unlisted: '本文に無い変更',
}
export const REQUIREMENT_STATUS = { ok: '対応あり', partial: '一部', missing: 'テストなし' }
const MAX_CARDS = 7
const EXCERPT_LINES = 40
const COMMENT_EXCERPT_LINES = 16
const COMMENT_CARDS_WITH_PAGE = 3
const PAGE_URL_RE = /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/

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
    const mechanical = classifyFile(f, { neverSkip, files })
    return {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.previous_filename ? { previous: f.previous_filename } : {}),
      ...(mechanical.skip ? { mechanical: REASONS[mechanical.reason] } : {}),
      ...(!mechanical.skip && matchesAny(f.filename, neverSkip) ? { neverSkip: true } : {}),
    }
  })
}

/**
 * unified diff の patch を行に分ける。`anchor` は、その行が新しい側のどの行番号の位置にあるか。
 * 削除行は、直後に来る新しい側の行番号を anchor にする。
 */
export function parsePatch(patch) {
  const out = []
  let oldNo = 0
  let newNo = 0
  for (const raw of (patch ?? '').split('\n')) {
    if (raw.startsWith('@@')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (h) {
        oldNo = Number(h[1])
        newNo = Number(h[2])
      }
      out.push({ t: '@', text: raw })
      continue
    }
    if (raw.startsWith('\\')) continue
    const t = raw[0] ?? ' '
    const text = raw.slice(1)
    if (t === '+') out.push({ t, text, new: newNo, anchor: newNo++ })
    else if (t === '-') out.push({ t, text, old: oldNo++, anchor: newNo })
    else out.push({ t: ' ', text, old: oldNo++, new: newNo, anchor: newNo++ })
  }
  return out
}

/** patch から、新しい側の行番号 from〜to にある行を取り出す。範囲が無ければ全体。 */
export function excerpt(file, { from, to } = {}, max = EXCERPT_LINES) {
  const lo = from ?? -Infinity
  const hi = to ?? Infinity
  const lines = []
  let gap = false
  for (const line of parsePatch(file?.patch)) {
    const inside = line.t !== '@' && line.anchor >= lo && line.anchor <= hi
    if (!inside) {
      gap = true
      continue
    }
    if (gap && lines.length) lines.push({ t: '@', text: '…' })
    gap = false
    lines.push(line)
  }
  const truncated = lines.length > max
  const kept = lines.slice(0, max)
  return { lines: kept, truncated, changed: kept.some((l) => l.t === '+' || l.t === '-') }
}

const diffHash = (path) => createHash('sha256').update(path).digest('hex')
export const diffLink = (repo, number, path, line) =>
  `https://github.com/${repo}/pull/${number}/files#diff-${diffHash(path)}${line ? `R${line}` : ''}`
const blobLink = (repo, sha, path, line) => `https://github.com/${repo}/blob/${sha}/${path}${line ? `#L${line}` : ''}`

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''
const isLine = (v) => v === undefined || (Number.isInteger(v) && v > 0)

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
        const blocked =
          (matchesAny(entry.path, neverSkip) || (f?.previous_filename && matchesAny(f.previous_filename, neverSkip))) &&
          !(f && classifyFile(f, { neverSkip, files }).skip)
        if (blocked) errors.push(`skip: 必ず見るパスなので「見なくてよい」に入れられません: ${entry.path}`)
      }
    }
  }
  for (const path of known.keys()) if (!seen.has(path)) errors.push(`仕分けられていないファイルがあります: ${path}`)

  if (!isNonEmptyString(spec.summary)) errors.push('summary（この PR が何をするか）がありません')

  // 確かめること
  if (!Array.isArray(spec.cards) || spec.cards.length === 0) {
    errors.push('cards（確かめること）が空です。無ければ「特になし」と理由を 1 件書いてください')
  } else {
    if (spec.cards.length > MAX_CARDS) errors.push(`cards は ${MAX_CARDS} 件までです（${spec.cards.length} 件）`)
    const ids = new Set()
    spec.cards.forEach((card, i) => {
      const at = `cards[${i}]`
      if (!CARD_KINDS[card?.kind]) errors.push(`${at}: kind は ${Object.keys(CARD_KINDS).join(' / ')} のどれかです`)
      if (!isNonEmptyString(card?.title)) errors.push(`${at}: title がありません`)
      if (!isNonEmptyString(card?.body)) errors.push(`${at}: body がありません`)
      if (card?.id !== undefined && !/^[\w-]{1,40}$/.test(card.id)) errors.push(`${at}: id は英数字・_・- の 40 文字以内です`)
      const id = card?.id ?? `c${i + 1}`
      if (ids.has(id)) errors.push(`${at}: id が重なっています: ${id}`)
      ids.add(id)
      if ((card?.before === undefined) !== (card?.after === undefined)) errors.push(`${at}: before と after は両方を書くか、両方を省きます`)
      for (const [j, ex] of (card?.excerpts ?? []).entries()) {
        const where = `${at}.excerpts[${j}]`
        const f = known.get(ex?.path)
        if (!f) {
          errors.push(`${where}: PR の変更ファイルに無いパスです: ${ex?.path}`)
          continue
        }
        if (!f.patch) {
          errors.push(`${where}: 差分（patch）の無いファイルは引用できません: ${ex.path}`)
          continue
        }
        if (!isLine(ex.from) || !isLine(ex.to) || (ex.from && ex.to && ex.from > ex.to)) {
          errors.push(`${where}: from / to は 1 以上の行番号で、from ≤ to です`)
          continue
        }
        if (!excerpt(f, ex).changed) errors.push(`${where}: ${ex.path} の L${ex.from ?? '?'}〜${ex.to ?? '?'} に変更行がありません（新しい側の行番号で指定します）`)
      }
    })
  }

  // 要件とテストの対応
  for (const [i, r] of (spec.requirements ?? []).entries()) {
    const at = `requirements[${i}]`
    if (!isNonEmptyString(r?.text)) errors.push(`${at}: text がありません`)
    if (!REQUIREMENT_STATUS[r?.status]) errors.push(`${at}: status は ${Object.keys(REQUIREMENT_STATUS).join(' / ')} のどれかです`)
    for (const impl of r?.impl ?? []) {
      if (!isNonEmptyString(impl?.path) || !isLine(impl?.line)) errors.push(`${at}.impl: path と、任意の line（1 以上）で書きます`)
    }
    if (r?.tests !== undefined && !(Array.isArray(r.tests) && r.tests.every(isNonEmptyString))) errors.push(`${at}.tests はテスト名の配列です`)
  }

  // 差分の外の影響
  for (const [i, o] of (spec.outside ?? []).entries()) {
    if (!isNonEmptyString(o?.path) || !isNonEmptyString(o?.note) || !isLine(o?.line)) errors.push(`outside[${i}]: path と note は必須、line は 1 以上の行番号です`)
    if (known.has(o?.path)) errors.push(`outside[${i}]: PR の変更ファイルは outside に入れません: ${o.path}`)
    if (o?.from !== undefined && !known.has(o.from)) errors.push(`outside[${i}]: from は PR の変更ファイルです: ${o.from}`)
  }

  // ファイルの関係図
  if (spec.map !== undefined) {
    const nodes = new Set()
    const outside = new Set((spec.outside ?? []).map((o) => o?.path))
    for (const [i, layer] of (spec.map.layers ?? []).entries()) {
      if (!isNonEmptyString(layer?.name)) errors.push(`map.layers[${i}]: name がありません`)
      for (const p of layer?.paths ?? []) {
        if (!known.has(p) && !outside.has(p)) errors.push(`map.layers[${i}]: 変更ファイルにも outside にも無いパスです: ${p}`)
        if (nodes.has(p)) errors.push(`map: ${p} が 2 つの層にあります`)
        nodes.add(p)
      }
    }
    for (const [i, e] of (spec.map.edges ?? []).entries()) {
      if (!nodes.has(e?.from) || !nodes.has(e?.to)) errors.push(`map.edges[${i}]: from と to は関係図の層（map.layers）に置いたパスです`)
    }
  }

  for (const [i, c] of (spec.checks ?? []).entries()) {
    if (!isNonEmptyString(c?.title) || !isNonEmptyString(c?.steps)) errors.push(`checks[${i}]: title と steps は必須です`)
  }
  return errors
}

const stripGitmoji = (title) => title.replace(/^(:[\w+-]+:\s*)+/, '').trim()

/** ページに埋め込むデータ。spec のパスを、表示名・リンク・差分の抜粋に解決する。 */
export function buildPageData(spec, files, pr, { repo, generatedAt = new Date().toISOString() } = {}) {
  const byPath = new Map(files.map((f) => [f.filename, f]))
  const names = shortNames([...new Set([...files.map((f) => f.filename), ...(spec.outside ?? []).map((o) => o.path)])])
  const head = pr.head.sha
  const sectionOf = new Map()
  for (const s of SECTIONS) for (const e of spec[s]) sectionOf.set(e.path, { section: s, note: e.note?.trim() ?? '' })
  const link = (path, line) => (byPath.has(path) ? diffLink(repo, pr.number, path, line) : blobLink(repo, head, path, line))
  return {
    version: 2,
    repo,
    number: pr.number,
    title: stripGitmoji(pr.title ?? ''),
    url: pr.html_url ?? `https://github.com/${repo}/pull/${pr.number}`,
    head,
    base: pr.base?.ref ?? '',
    headRef: pr.head?.ref ?? '',
    generatedAt,
    summary: spec.summary.trim(),
    counts: Object.fromEntries(SECTIONS.map((s) => [s, spec[s].length])),
    files: files.map((f) => ({
      path: f.filename,
      name: names.get(f.filename),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...sectionOf.get(f.filename),
      link: link(f.filename),
    })),
    cards: spec.cards.map((c, i) => ({
      id: c.id ?? `c${i + 1}`,
      kind: c.kind,
      title: c.title.trim(),
      body: c.body.trim(),
      ...(c.before !== undefined ? { before: c.before, after: c.after } : {}),
      ...(c.alternatives ? { alternatives: c.alternatives } : {}),
      excerpts: (c.excerpts ?? []).map((ex) => {
        const { lines, truncated } = excerpt(byPath.get(ex.path), ex)
        const first = lines.find((l) => l.new)?.new
        return { path: ex.path, name: names.get(ex.path), from: ex.from, to: ex.to, link: link(ex.path, ex.from ?? first), lines, truncated }
      }),
    })),
    requirements: (spec.requirements ?? []).map((r) => ({
      text: r.text,
      status: r.status,
      note: r.note ?? '',
      impl: (r.impl ?? []).map((x) => ({ path: x.path, name: names.get(x.path) ?? x.path, line: x.line, link: link(x.path, x.line) })),
      tests: r.tests ?? [],
    })),
    map: spec.map
      ? {
          layers: spec.map.layers.map((l) => ({ name: l.name, paths: l.paths })),
          edges: (spec.map.edges ?? []).map((e) => ({ from: e.from, to: e.to, label: e.label ?? '' })),
        }
      : null,
    outsideChecked: spec.outsideChecked !== false,
    outside: (spec.outside ?? []).map((o) => ({
      path: o.path,
      name: names.get(o.path),
      line: o.line,
      note: o.note,
      from: o.from ?? null,
      link: blobLink(repo, head, o.path, o.line),
    })),
    checks: (spec.checks ?? []).map((c) => ({ title: c.title, steps: c.steps })),
    testsNote: spec.testsNote?.trim() ?? '',
    skipNote: spec.skipNote?.trim() ?? '',
  }
}

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'page', 'template.html')
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** テンプレートにデータを埋め込んで、公開する HTML を返す。 */
export function renderPage(data, template = readFileSync(TEMPLATE, 'utf8')) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)
  const full = `PR #${data.number} ${data.title}`
  const title = full.length > 40 ? `${full.slice(0, 39)}…` : full
  return template.replace('__PAGE_TITLE__', () => escapeHtml(title)).replace('/*__REVIEW_DATA__*/null', () => json)
}

/** 差分の行を、コメントに貼る ```diff のブロックにする。 */
function diffBlock(lines, truncated) {
  const body = lines.map((l) => (l.t === '@' ? '@@ … @@' : `${l.t}${l.text}`))
  if (truncated) body.push('@@ … 続きは差分で @@')
  let fence = '```'
  while (body.some((l) => l.includes(fence))) fence += '`'
  return [`${fence}diff`, ...body, fence].join('\n')
}

/** PR に投稿するコメントの本文。pageUrl があればページへの入口として短くする。 */
export function renderComment(spec, files, pr, { repo, pageUrl, links = true } = {}) {
  if (pageUrl !== undefined && !PAGE_URL_RE.test(pageUrl)) throw new Error(`ページの URL が claude.ai の artifact ではありません: ${pageUrl}`)
  const data = buildPageData(spec, files, pr, { repo })
  const byPath = new Map(data.files.map((f) => [f.path, f]))
  const stat = (p) => `（+${byPath.get(p).additions} −${byPath.get(p).deletions}）`
  const fileLabel = (p) => `\`${byPath.get(p).name}\`${stat(p)}`
  const fold = (summary, lines) => `<details><summary>${summary}</summary>\n\n${lines.join('\n')}\n\n</details>`
  const head = data.head.slice(0, 7)
  const out = [GUIDE_MARKER, '## レビューガイド', '', `head \`${head}\` の ${files.length} ファイル。${data.summary}`, '']
  if (pageUrl) {
    out.push(
      `[レビューページ](${pageUrl})に、ファイルの関係図、確かめること ${data.cards.length} 件、要件とテストの対応、動作確認の手順をまとめています。確認した項目には印を付けられます。`,
      '',
    )
  }
  const shown = pageUrl ? data.cards.slice(0, COMMENT_CARDS_WITH_PAGE) : data.cards
  out.push(`### 確かめること（${pageUrl && data.cards.length > shown.length ? `上位 ${shown.length} 件 / 全 ${data.cards.length} 件` : `${data.cards.length} 件`}）`, '')
  shown.forEach((card, i) => {
    out.push(`**${i + 1}. ${card.title}**`, '', `${CARD_KINDS[card.kind]}。${card.body}`, '')
    if (card.before !== undefined) out.push(`- これまで: ${card.before}`, `- これから: ${card.after}`, '')
    if (card.alternatives) out.push(`- 選ばなかった案: ${card.alternatives}`, '')
    for (const ex of card.excerpts) {
      const range = ex.from ? `L${ex.from}${ex.to && ex.to !== ex.from ? `–${ex.to}` : ''}` : '差分'
      const name = links ? `[\`${ex.name}\` ${range}](${ex.link})` : `\`${ex.name}\` ${range}`
      const lines = ex.lines.slice(0, COMMENT_EXCERPT_LINES)
      out.push(name, '', diffBlock(lines, ex.truncated || ex.lines.length > lines.length), '')
    }
  })
  if (pageUrl && data.cards.length > shown.length) {
    out.push(`ほかに ${data.cards.length - shown.length} 件: ${data.cards.slice(shown.length).map((c) => c.title.replace(/[*`]/g, '')).join(' / ')}`, '')
  }
  if (data.requirements.length) {
    const gaps = data.requirements.filter((r) => r.status !== 'ok')
    out.push(`### 要件とテスト（✅ ${data.requirements.length - gaps.length} / ⚠️ ${gaps.length}）`, '')
    const rows = pageUrl ? gaps : data.requirements
    if (rows.length) out.push(...rows.map((r) => `- ${r.status === 'ok' ? '✅' : '⚠️'} ${r.text}${r.status === 'ok' ? '' : `（${REQUIREMENT_STATUS[r.status]}）`}`), '')
  }
  if (!pageUrl && data.outside.length) {
    out.push('### 差分の外で影響を受ける箇所', '', ...data.outside.map((o) => `- [\`${o.name}\` L${o.line}](${o.link}): ${o.note}`), '')
  }
  if (!pageUrl && data.checks.length) {
    out.push('### 動作確認の手順', '')
    for (const c of data.checks) out.push(`**${c.title}**`, '', c.steps.trim(), '')
  }
  out.push(`### 見なくてよい（${spec.skip.length} 件、Viewed を付ける対象）`, '')
  if (spec.skip.length) {
    if (data.skipNote) out.push(data.skipNote, '')
    out.push(fold('ファイルと理由', spec.skip.map((e) => `- ${fileLabel(e.path)}: ${e.note.trim()}`)), '')
  } else {
    out.push('なし', '')
  }
  out.push('仕分けと確かめることは Claude の判断で、機械的な検証はしていません。', '')
  out.push(buildMarker({ head, paths: spec.skip.map((e) => e.path), ...(pageUrl ? { page: pageUrl } : {}) }))
  return `${out.join('\n')}\n`
}

/** 推敲の対象になる地の文の場所。[key, 値の取り出し, 値の書き込み] の配列を返す。 */
export function proseFields(spec) {
  const fields = []
  const add = (key, obj, prop) => {
    if (isNonEmptyString(obj?.[prop])) fields.push([key, obj, prop])
  }
  add('summary', spec, 'summary')
  for (const [i, c] of (spec.cards ?? []).entries()) for (const p of ['title', 'body', 'before', 'after', 'alternatives']) add(`cards.${i}.${p}`, c, p)
  for (const [i, r] of (spec.requirements ?? []).entries()) for (const p of ['text', 'note']) add(`requirements.${i}.${p}`, r, p)
  for (const [i, l] of (spec.map?.layers ?? []).entries()) add(`map.layers.${i}.name`, l, 'name')
  for (const [i, e] of (spec.map?.edges ?? []).entries()) add(`map.edges.${i}.label`, e, 'label')
  for (const [i, o] of (spec.outside ?? []).entries()) add(`outside.${i}.note`, o, 'note')
  for (const [i, c] of (spec.checks ?? []).entries()) for (const p of ['title', 'steps']) add(`checks.${i}.${p}`, c, p)
  for (const section of SECTIONS) for (const [i, e] of (spec[section] ?? []).entries()) add(`${section}.${i}.note`, e, 'note')
  add('testsNote', spec, 'testsNote')
  add('skipNote', spec, 'skipNote')
  return fields
}

const PROSE_MARK = (key) => `<!-- review-guide:prose ${key} -->`
const PROSE_RE = /^<!-- review-guide:prose ([\w.]+) -->$/

/** 地の文を、欄ごとに目印のコメントで区切った Markdown にする。 */
export function exportProse(spec) {
  return `${proseFields(spec).map(([key, obj, prop]) => `${PROSE_MARK(key)}\n${obj[prop].trim()}\n`).join('\n')}`
}

/** 推敲した Markdown を spec に書き戻す。目印の過不足・順序の入れ替わりは誤りにする。 */
export function importProse(spec, markdown) {
  const next = structuredClone(spec)
  const fields = proseFields(next)
  const parts = []
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const m = PROSE_RE.exec(line.trim())
    if (m) parts.push({ key: m[1], lines: [] })
    else if (parts.length) parts.at(-1).lines.push(line)
    else if (line.trim()) throw new Error('最初の目印より前に文があります。目印のコメント（<!-- review-guide:prose ... -->）を消さないでください')
  }
  const expected = fields.map(([key]) => key)
  const got = parts.map((p) => p.key)
  if (expected.join('\n') !== got.join('\n')) {
    const missing = expected.filter((k) => !got.includes(k))
    const extra = got.filter((k) => !expected.includes(k))
    throw new Error(`目印が spec と合いません（足りない: ${missing.join(', ') || 'なし'} / 余分: ${extra.join(', ') || 'なし'}${!missing.length && !extra.length ? ' / 順序が違う' : ''}）`)
  }
  parts.forEach((part, i) => {
    const text = part.lines.join('\n').trim()
    if (!text) throw new Error(`${part.key} が空になりました`)
    const [, obj, prop] = fields[i]
    obj[prop] = text
  })
  return next
}

const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2)
  const load = () => {
    const [spec, files, pr] = args.slice(0, 3).map(read)
    const errors = validate(spec, files)
    if (errors.length) {
      console.error(errors.map((e) => `- ${e}`).join('\n'))
      process.exit(1)
    }
    return { spec, files, pr, repo: pr.base.repo.full_name }
  }
  if (command === 'prepare' && args.length === 1) {
    console.log(JSON.stringify(prepare(read(args[0])), null, 1))
  } else if (command === 'check' && args.length === 3) {
    load()
  } else if (command === 'page' && args.length === 3) {
    const { spec, files, pr, repo } = load()
    process.stdout.write(renderPage(buildPageData(spec, files, pr, { repo })))
  } else if (command === 'prose-export' && args.length === 1) {
    process.stdout.write(exportProse(read(args[0])))
  } else if (command === 'prose-import' && args.length === 2) {
    try {
      process.stdout.write(`${JSON.stringify(importProse(read(args[0]), readFileSync(args[1], 'utf8')), null, 2)}\n`)
    } catch (e) {
      console.error(e.message)
      process.exit(1)
    }
  } else if (command === 'comment' && (args.length === 3 || args.length === 4)) {
    const { spec, files, pr, repo } = load()
    process.stdout.write(renderComment(spec, files, pr, { repo, pageUrl: args[3], links: process.env.NO_LINKS !== 'true' }))
  } else {
    console.error('usage: render.mjs prepare <files.json> | check|page <spec.json> <files.json> <pr.json> | prose-export <spec.json> | prose-import <spec.json> <prose.md> | comment <spec.json> <files.json> <pr.json> [<page-url>]')
    process.exit(2)
  }
}
