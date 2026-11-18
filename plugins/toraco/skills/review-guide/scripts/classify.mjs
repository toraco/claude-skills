// PR の変更ファイルを「見なくてよいと機械的に確かめられるもの」とそれ以外に分ける。
// 入力は GitHub REST API `GET /repos/{owner}/{repo}/pulls/{n}/files` の要素。
// LLM の判断は入れない。迷うものはすべて「スキップしない」に倒す。

export const DEFAULT_LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Podfile.lock',
  'flake.lock',
]

// どの理由に当たってもスキップしないパス。リポジトリごとに `never-skip` で足す。
export const DEFAULT_NEVER_SKIP = ['.github/**', '**/migrations/**']

export const REASONS = {
  moved: '内容が同じままの移動・リネーム',
  lockfile: 'lockfile',
  generated: '生成物（設定で指定したパス）',
  whitespace: '行末の空白・改行コードだけの差分',
}

/** `**` と `*` だけを解釈する最小限の glob。パス区切りは `/`。 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path))
}

const basename = (path) => path.slice(path.lastIndexOf('/') + 1)
const normalize = (line) => line.replace(/\s+$/, '')

/**
 * patch が「行末の空白・改行コード・ファイル末尾の改行」だけの差分かを判定する。
 * 文脈行を挟まずに続く削除行と追加行のかたまりごとに、行末の空白を除いた内容が
 * 順序どおり一致することを求める。行の移動や空行の増減は一致しないので false になる。
 */
export function isWhitespaceOnlyPatch(patch) {
  if (typeof patch !== 'string' || patch === '') return false
  let removed = []
  let added = []
  let sawChange = false
  const flush = () => {
    if (removed.length !== added.length) return false
    for (let i = 0; i < removed.length; i++) {
      if (normalize(removed[i]) !== normalize(added[i])) return false
    }
    removed = []
    added = []
    return true
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('-')) {
      // 追加行の後に削除行が来たら、別のかたまりとして扱う
      if (added.length > 0 && !flush()) return false
      removed.push(line.slice(1))
      sawChange = true
    } else if (line.startsWith('+')) {
      added.push(line.slice(1))
      sawChange = true
    } else if (!flush()) {
      return false
    }
  }
  return flush() && sawChange
}

/**
 * @param {object} file REST API の変更ファイル 1 件
 * @param {{lockfiles?: string[], generated?: string[], neverSkip?: string[]}} [options]
 * @returns {{path: string, skip: boolean, reason?: keyof typeof REASONS}}
 */
export function classifyFile(file, options = {}) {
  const lockfiles = options.lockfiles ?? DEFAULT_LOCKFILES
  const generated = options.generated ?? []
  const neverSkip = options.neverSkip ?? DEFAULT_NEVER_SKIP
  const path = file.filename
  const keep = { path, skip: false }

  if (matchesAny(path, neverSkip)) return keep
  if (file.previous_filename && matchesAny(file.previous_filename, neverSkip)) return keep
  // 削除は「テストを消した」などの重要な変更になり得るので、種類を問わず残す
  if (file.status === 'removed') return keep

  if (file.status === 'renamed' && file.changes === 0) return { path, skip: true, reason: 'moved' }
  if (lockfiles.includes(basename(path))) return { path, skip: true, reason: 'lockfile' }
  if (matchesAny(path, generated)) return { path, skip: true, reason: 'generated' }
  if (file.status === 'modified' && isWhitespaceOnlyPatch(file.patch)) {
    return { path, skip: true, reason: 'whitespace' }
  }
  return keep
}

export function classifyFiles(files, options = {}) {
  return files.map((f) => classifyFile(f, options))
}
