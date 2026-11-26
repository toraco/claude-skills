import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'secret-scan.py')
const dirs = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// ファイルを作業ディレクトリに書き、パスを返す
const files = (map) => {
  const d = mkdtempSync(join(tmpdir(), 'secret-scan-test-'))
  dirs.push(d)
  return Object.fromEntries(
    Object.entries(map).map(([name, body]) => {
      const p = join(d, name)
      writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
      return [name, p]
    }),
  )
}

const scan = (...args) => {
  const r = spawnSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr }
}

// 設定ファイル 1 つに置いた値が、下書きにあるとき検出されるか
const detects = (configName, config, value) => {
  const f = files({ [configName]: config, 'draft.md': `本文\n値: ${value}\n` })
  return scan(f['draft.md'], f[configName]).code === 1
}

// テストファイル自体が秘密情報の検査に引っかからないよう、鍵の形は実行時に組み立てる
const fake = {
  recaptcha: '6L' + 'x'.repeat(38),
  aws: 'AKIA' + 'Q'.repeat(16),
  ghp: 'ghp_' + 'a'.repeat(36),
  ghpat: 'github_pat_' + 'b'.repeat(40),
  slack: 'xoxb-' + '1234567890-abc',
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
}

test('引数がないと、使い方を出して 2 を返す', () => {
  const r = scan()
  assert.equal(r.code, 2)
  assert.match(r.stderr, /使い方/)
  assert.equal(r.stdout, '')
})

test('下書きがないと 2 を返し、検査しない', () => {
  const f = files({ 'a.json': { secret: 'value-123456' } })
  const r = scan(join(dirname(f['a.json']), 'nothing.md'), f['a.json'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /nothing\.md がない/)
  assert.equal(r.stdout, '')
})

test('渡した設定ファイルが 1 つでもないと 2 を返し、ないものだけを列挙する。一致なしの 0 にはしない', () => {
  const f = files({ 'draft.md': 'ふつうの文章\n', 'ok.json': { secret: 'value-123456' } })
  const missing1 = join(dirname(f['ok.json']), 'gone1.json')
  const missing2 = join(dirname(f['ok.json']), 'gone2.json')
  const r = scan(f['draft.md'], f['ok.json'], missing1, missing2)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /gone1\.json がない/)
  assert.match(r.stderr, /gone2\.json がない/)
  assert.doesNotMatch(r.stderr, /ok\.json/)
  assert.equal(r.stdout, '')
})

test('下書きにディレクトリを渡すと 2 を返す', () => {
  const f = files({ 'a.json': {} })
  const d = join(dirname(f['a.json']), 'dir.md')
  mkdirSync(d)
  assert.equal(scan(d).code, 2)
})

test('読めないファイルは、パスだけを出して 2 を返す', { skip: process.getuid?.() === 0 && 'root では読み取り権限を外せない' }, () => {
  const secret = 'unreadable-secret-1'
  const f = files({ 'draft.md': 'ふつうの文章\n', 'locked.env': `API_TOKEN=${secret}\n` })
  chmodSync(f['locked.env'], 0o000)
  try {
    const r = scan(f['draft.md'], f['locked.env'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /locked\.env を読めない/)
    assert.ok(!r.out.includes(secret))
  } finally {
    chmodSync(f['locked.env'], 0o600)
  }
})

test('JSON: キー名が secret / key / token / pass / mail / user / auth などを含む値を集める（大文字小文字は区別しない）', () => {
  for (const key of ['RecaptchaSecret', 'API_KEY', 'accessToken', 'Password', 'mailAddress', 'username', 'authHeader', 'sitekey']) {
    assert.ok(detects('c.json', { [key]: 'collected-value-1' }, 'collected-value-1'), key)
  }
  assert.ok(!detects('c.json', { title: 'not-collected-1' }, 'not-collected-1'))
})

test('JSON: to / from / cc / bcc は完全一致のときだけ集める', () => {
  for (const key of ['to', 'from', 'cc', 'bcc', 'TO']) assert.ok(detects('c.json', { [key]: 'ops-team-01' }, 'ops-team-01'), key)
  for (const key of ['stop', 'tomorrow', 'accent']) assert.ok(!detects('c.json', { [key]: 'ops-team-01' }, 'ops-team-01'), key)
})

test('JSON: キー名に関係なく @ を含む値を集め、ネストと配列もたどる', () => {
  assert.ok(detects('c.json', { title: 'someone@internal' }, 'someone@internal'))
  assert.ok(detects('c.json', { a: { b: [{ password: 'nested-pw-1' }] } }, 'nested-pw-1'))
  assert.ok(detects('c.json', { apiKeys: ['list-value-1'] }, 'list-value-1'))
  assert.ok(detects('c.json', ['top@array'], 'top@array'))
  assert.ok(!detects('c.json', { secret: 123456789 }, '123456789'))
})

test('6 文字未満の値と、localhost / undefined / example は集めない（大文字小文字は問わない）。6 文字ちょうどは集める', () => {
  assert.ok(!detects('c.json', { secret: 'abcde' }, 'abcde'))
  assert.ok(detects('c.json', { secret: 'abcdef' }, 'abcdef'))
  assert.ok(detects('c.json', { secret: '  abcdef  ' }, 'abcdef'))
  for (const v of ['localhost', 'Undefined', 'EXAMPLE']) {
    assert.ok(!detects('c.json', { user: v }, v), v)
  }
})

test('.json の中身が壊れていたら、テキストとして KEY=VALUE を読む', () => {
  assert.ok(detects('broken.json', 'SECRET=broken-json-1\n{', 'broken-json-1'))
})

test('JSON でないファイル: KEY=VALUE（値は空白・引用符・# の手前まで）、=>、define から集める', () => {
  assert.ok(detects('.env', 'API_TOKEN=env-token-1 # memo\n', 'env-token-1'))
  assert.ok(detects('.env', 'export DB_PASS="env-pass-1"\n', 'env-pass-1'))
  assert.ok(detects('config.php', "<?php return ['auth_key' => 'php-auth-1'];\n", 'php-auth-1'))
  assert.ok(detects('wp-config.php', "define( 'DB_PASSWORD', 'define-pw-1' );\n", 'define-pw-1'))
  assert.ok(!detects('wp-config.php', "define('WP_HOME', 'home-value-1');\n", 'home-value-1'))
  // KEY=VALUE は最初の空白の手前までなので、値の後半だけでは一致しない
  assert.ok(!detects('.env', 'SECRET="first second-part-1"\n', 'second-part-1'))
})

test('設定ファイルがなくても、秘密らしい形を検出する', () => {
  for (const [name, value] of Object.entries({ email: 'alice@example.co.jp', ...fake })) {
    const f = files({ 'draft.md': `ふつうの行\n${value}\n` })
    const r = scan(f['draft.md'])
    assert.equal(r.code, 1, name)
    assert.match(r.stdout, /照合した設定値: 0 件（0 ファイル）/)
    assert.match(r.stdout, /2 行目/, name)
  }
})

test('形の境界: reCAPTCHA は 38 文字ちょうど、AWS は 16 文字ちょうどのときだけ検出する', () => {
  for (const value of ['6L' + 'x'.repeat(37), '6L' + 'x'.repeat(39), 'AKIA' + 'Q'.repeat(15), 'AKIA' + 'Q'.repeat(17)]) {
    const f = files({ 'draft.md': `${value}\n` })
    assert.equal(scan(f['draft.md']).code, 0, value)
  }
})

test('定型の noreply アドレスは検出しない。似せた別ドメインは検出する', () => {
  for (const ok of ['noreply@github.com', 'no-reply@github.com', 'noreply@users.noreply.github.com', 'Co-Authored-By: Claude <noreply@anthropic.com>']) {
    const f = files({ 'draft.md': `${ok}\n` })
    assert.equal(scan(f['draft.md']).code, 0, ok)
  }
  const f = files({ 'draft.md': 'noreply@github.com.evil.com\n' })
  assert.equal(scan(f['draft.md']).code, 1)
})

test('一致がなければ、照合した件数と「一致なし」を出して 0 を返す', () => {
  const f = files({ 'draft.md': 'ふつうの文章\n', 'a.json': { secret: 'value-aaaa-1', user: 'value-bbbb-2' }, '.env': 'TOKEN=value-cccc-3\n' })
  const r = scan(f['draft.md'], f['a.json'], f['.env'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /照合した設定値: 3 件（2 ファイル）/)
  assert.match(r.stdout, /一致なし/)
})

test('一致があれば、行番号の順に重複なく、ファイル名・キー名・種類だけを出して 1 を返す。値や行の本文は出さない', () => {
  const secret = 'super-secret-value-1'
  const draft = [`3 行目より前: ${fake.aws}`, 'ふつうの行', `値が 2 回: ${secret} ${secret} と ${fake.aws}`].join('\n')
  const f = files({ 'draft.md': draft, 'conf.json': { RecaptchaSecret: secret } })
  const r = scan(f['draft.md'], f['conf.json'])
  assert.equal(r.code, 1)
  const hits = r.stdout.split('\n').filter((l) => l.startsWith('一致:'))
  assert.deepEqual(hits, [
    'draft.md の 1 行目 — AWS のアクセスキー',
    'draft.md の 3 行目 — AWS のアクセスキー',
    'draft.md の 3 行目 — conf.json のキー「RecaptchaSecret」の値',
  ].map((h) => `一致: ${h}`))
  assert.ok(!r.out.includes(secret))
  assert.ok(!r.out.includes(fake.aws))
  assert.ok(!r.out.includes('ふつうの行'))
  assert.ok(!r.out.includes('値が 2 回'))
})

test('下書きも設定ファイルも変更しない', () => {
  const f = files({ 'draft.md': `x ${fake.ghp}\n`, 'conf.json': { secret: 'unchanged-1' } })
  const before = [readFileSync(f['draft.md'], 'utf8'), readFileSync(f['conf.json'], 'utf8')]
  scan(f['draft.md'], f['conf.json'])
  assert.deepEqual([readFileSync(f['draft.md'], 'utf8'), readFileSync(f['conf.json'], 'utf8')], before)
})
