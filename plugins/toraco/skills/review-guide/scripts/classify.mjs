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
export const MIGRATIONS_GLOB = '**/migrations/**'
export const DEFAULT_NEVER_SKIP = ['.github/**', MIGRATIONS_GLOB]

export const REASONS = {
  moved: '内容が同じままの移動・リネーム',
  lockfile: 'lockfile',
  generated: '生成物（設定で指定したパス）',
  whitespace: '行末の空白・改行コードだけの差分',
  migrationMeta: 'migration ツールが生成するメタデータ（同じ PR に migration の SQL がある）',
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

const MIGRATION_META_RE = /^(.*\/)?migrations\/meta\/(_journal\.json|(\d+)_snapshot\.json)$/

/**
 * migration ツール（drizzle-kit）が SQL と一緒に生成する `meta/_journal.json` と
 * `meta/<番号>_snapshot.json` かを判定する。同じ PR で、対応する SQL が
 * `migrations/` の直下に追加・変更されているときだけ true にする。
 * snapshot は番号の同じ SQL を求める。SQL の無いメタデータだけの変更は、手で書き換えた
 * 可能性があるので false にする。
 */
export function isMigrationMeta(file, files) {
  if (file.status !== 'added' && file.status !== 'modified') return false
  const m = MIGRATION_META_RE.exec(file.filename)
  if (!m) return false
  const dir = `${m[1] ?? ''}migrations/`
  const number = m[3]
  return files.some((f) => {
    if (f.status === 'removed' || !f.filename.startsWith(dir)) return false
    const name = f.filename.slice(dir.length)
    if (name.includes('/') || !name.endsWith('.sql')) return false
    return number === undefined || name.startsWith(`${number}_`)
  })
}

/**
 * @param {object} file REST API の変更ファイル 1 件
 * @param {{lockfiles?: string[], generated?: string[], neverSkip?: string[], files?: object[]}} [options]
 *   `files` は PR の変更ファイルの全件。migration のメタデータの判定にだけ使う
 * @returns {{path: string, skip: boolean, reason?: keyof typeof REASONS}}
 */
export function classifyFile(file, options = {}) {
  const lockfiles = options.lockfiles ?? DEFAULT_LOCKFILES
  const generated = options.generated ?? []
  const neverSkip = options.neverSkip ?? DEFAULT_NEVER_SKIP
  const path = file.filename
  const keep = { path, skip: false }

  // 既定の `**/migrations/**` に当たるだけなら、生成されたメタデータは通す。
  // リポジトリが足した never-skip に当たるものは通さない
  if (options.files && isMigrationMeta(file, options.files)) {
    const others = neverSkip.filter((g) => g !== MIGRATIONS_GLOB)
    return matchesAny(path, others) ? keep : { path, skip: true, reason: 'migrationMeta' }
  }
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
  return files.map((f) => classifyFile(f, { ...options, files }))
}
