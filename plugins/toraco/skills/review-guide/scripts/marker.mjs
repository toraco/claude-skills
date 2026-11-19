// レビューガイドのコメントに埋め込む「見なくてよい」一覧の読み書きと、
// 実際に Viewed を付けるパスの絞り込み。API 呼び出しは apply.mjs が行う。

import { classifyFile, DEFAULT_NEVER_SKIP, matchesAny } from './classify.mjs'

const MARKER_RE = /<!--\s*review-guide:skip\s+([\s\S]*?)\s*-->/

const PAGE_RE = /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/

/** ガイドのコメントに埋め込む機械可読の一覧を作る。page はレビューページの URL（再実行で同じページを更新するため）。 */
export function buildMarker({ head, paths, page }) {
  return `<!-- review-guide:skip ${JSON.stringify({ head, paths, ...(page ? { page } : {}) })} -->`
}

/** コメント本文から一覧を取り出す。形が合わなければ null。 */
export function parseMarker(body) {
  const m = MARKER_RE.exec(body ?? '')
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    if (typeof data.head !== 'string' || !/^[0-9a-f]{7,40}$/.test(data.head)) return null
    if (!Array.isArray(data.paths) || !data.paths.every((p) => typeof p === 'string')) return null
    return { head: data.head, paths: data.paths, ...(typeof data.page === 'string' && PAGE_RE.test(data.page) ? { page: data.page } : {}) }
  } catch {
    return null
  }
}

/**
 * Viewed を付けるパスを決める。安全側に倒す条件は次のとおり。
 * - ガイドを書いた時点の head と、いまの PR の head が違えば、ガイドの一覧は使わない
 * - PR の変更ファイルに無いパスは無視する
 * - never-skip のパスは、ガイドが挙げていても付けない
 * 機械的に確かめられるもの（lockfile など）は、ガイドの有無に関わらず付ける。
 */
export function selectPaths({ marker, prHead, files, neverSkip = DEFAULT_NEVER_SKIP, options = {} }) {
  const stale = marker !== null && !prHead.startsWith(marker.head)
  const fromGuide = new Set(marker && !stale ? marker.paths : [])
  const selected = []
  const rejected = []
  for (const file of files) {
    const path = file.filename
    const mechanical = classifyFile(file, { ...options, neverSkip, files })
    if (mechanical.skip) {
      selected.push({ path, reason: mechanical.reason })
    } else if (fromGuide.has(path)) {
      const blocked =
        matchesAny(path, neverSkip) ||
        (file.previous_filename ? matchesAny(file.previous_filename, neverSkip) : false)
      if (blocked) rejected.push(path)
      else selected.push({ path, reason: 'guide' })
    }
  }
  return { selected, rejected, stale }
}
