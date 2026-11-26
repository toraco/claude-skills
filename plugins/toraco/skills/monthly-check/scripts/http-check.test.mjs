import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 本物の curl で、ローカルに立てた HTTP サーバーへ取りに行く（外のネットワークは使わない）
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'http-check.sh')
const HTML = '<html><body>ok</body></html>'

let server
let base
const requests = []
const work = []

before(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers, at: Date.now() })
    const path = req.url.split('?')[0]
    if (path === '/moved') return res.writeHead(301, { Location: '/ok' }).end()
    if (path === '/loop') return res.writeHead(302, { Location: '/loop' }).end()
    const m = path.match(/^\/status\/(\d{3})$/)
    if (m) return res.writeHead(Number(m[1]), { 'Content-Type': 'text/html' }).end('err')
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(HTML)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  for (const d of work) rmSync(d, { recursive: true, force: true })
})

const outDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'http-check-test-'))
  work.push(d)
  return join(d, 'out')
}

// サーバーと同じプロセスで動かすため、spawnSync ではなく非同期で実行する
const run = (args, input = '', env = {}) =>
  new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], { env: { ...process.env, MONTHLY_CHECK_DELAY: '0', ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => {
      const rows = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      resolve({ code, stdout, stderr, rows })
    })
    child.stdin.end(input)
  })

const freePort = async () => {
  const s = createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

test('base-url か out-dir がないと異常終了し、何も出さない', async () => {
  const noBase = await run([], '/ok\n')
  assert.notEqual(noBase.code, 0)
  assert.equal(noBase.stdout, '')
  assert.match(noBase.stderr, /base-url が必要です/)
  const noOut = await run([base], '/ok\n')
  assert.notEqual(noOut.code, 0)
  assert.equal(noOut.stdout, '')
  assert.match(noOut.stderr, /out-dir が必要です/)
})

test('標準入力が空なら何も出さずに 0 で終わる', async () => {
  const r = await run([base, outDir()], '')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
})

test('空行と # で始まる行は飛ばし、連番は有効な行だけに振る。末尾に改行がない最終行も処理する', async () => {
  const r = await run([base, outDir()], '# コメント\n\nトップ\t/ok\n\n# もう一つ\n最後\t/ok')
  assert.equal(r.code, 0)
  assert.deepEqual(r.rows.map((x) => [x.n, x.label]), [[1, 'トップ'], [2, '最後']])
})

test('TAB がないラベルだけの行は、ラベルを取得先にも使う', async () => {
  const r = await run([base, outDir()], '/ok\n')
  assert.equal(r.rows[0].label, '/ok')
  assert.equal(r.rows[0].url, `${base}/ok`)
})

test('URL の組み立て: http(s):// はそのまま、/ 始まりは base につなげ、それ以外は base/ を補う。base 末尾の / は取り除く', async () => {
  const r = await run([`${base}/`, outDir()], `絶対\t${base}/ok?abs\nスラッシュ\t/ok\n相対\tok\n`)
  assert.deepEqual(r.rows.map((x) => x.url), [`${base}/ok?abs`, `${base}/ok`, `${base}/ok`])
  assert.ok(r.rows.every((x) => x.final_status === 200))
})

test('1 件 1 行の JSON を出し、本文とヘッダーを pages/<n> に保存する。301 → 200 は first と final に分かれる', async () => {
  const out = outDir()
  const r = await run([base, out], '転送\t/moved\n直接\t/ok\n')
  assert.equal(r.code, 0)
  assert.equal(r.rows.length, 2)
  const [moved, ok] = r.rows
  assert.deepEqual(Object.keys(moved).sort(), [
    'body', 'bytes', 'content_type', 'final_status', 'final_url', 'first_status', 'label', 'n', 'redirects', 'seconds', 'url',
  ])
  for (const k of ['n', 'first_status', 'final_status', 'redirects', 'seconds', 'bytes']) assert.equal(typeof moved[k], 'number', k)
  assert.equal(moved.first_status, 301)
  assert.equal(moved.final_status, 200)
  assert.equal(moved.redirects, 1)
  assert.equal(moved.final_url, `${base}/ok`)
  assert.equal(ok.first_status, 200)
  assert.equal(ok.redirects, 0)
  assert.match(ok.content_type, /^text\/html/)
  assert.equal(ok.bytes, Buffer.byteLength(HTML))
  assert.equal(moved.body, join(out, 'pages', '1.html'))
  assert.equal(readFileSync(ok.body, 'utf8'), HTML)
  assert.ok(existsSync(join(out, 'pages', '1.headers')))
  assert.ok(existsSync(join(out, 'pages', '2.headers')))
})

test('ラベルに引用符・バックスラッシュ・日本語があっても正しい JSON になる', async () => {
  const label = '会社 "概要" \\ テスト'
  const r = await run([base, outDir()], `${label}\t/ok\n`)
  assert.equal(r.rows[0].label, label)
})

test('4xx / 5xx でも止まらず、最後の件まで処理して 0 で終わる', async () => {
  const codes = [401, 403, 404, 500, 503]
  const input = codes.map((c) => `${c}\t/status/${c}`).join('\n') + '\n最後\t/ok\n'
  const r = await run([base, outDir()], input)
  assert.equal(r.code, 0)
  assert.deepEqual(r.rows.map((x) => x.final_status), [...codes, 200])
})

test('転送が 5 回を超えたら final_status を 0、final_url を空にして、次の件へ進む', async () => {
  const r = await run([base, outDir()], 'ループ\t/loop\n最後\t/ok\n')
  assert.equal(r.code, 0)
  assert.equal(r.rows[0].final_status, 0)
  assert.equal(r.rows[0].final_url, '')
  assert.equal(r.rows[1].final_status, 200)
})

test('接続できないときも final_status を 0、final_url を空にして、次の件へ進む', async () => {
  const port = await freePort()
  const r = await run([base, outDir()], `閉じたポート\thttp://127.0.0.1:${port}/\n最後\t/ok\n`)
  assert.equal(r.code, 0)
  assert.equal(r.rows.length, 2)
  assert.equal(r.rows[0].final_status, 0)
  assert.equal(r.rows[0].first_status, 0)
  assert.equal(r.rows[0].final_url, '')
  assert.equal(r.rows[1].final_status, 200)
})

test('認証情報（Authorization・Cookie）を送らず、既定の User-Agent を名乗る。MONTHLY_CHECK_UA で変えられる', async () => {
  const from = requests.length
  await run([base, outDir()], '既定\t/ok?ua=default\n')
  await run([base, outDir()], '上書き\t/ok?ua=custom\n', { MONTHLY_CHECK_UA: 'custom/9.9' })
  const [def, custom] = requests.slice(from)
  for (const r of [def, custom]) {
    assert.equal(r.headers.authorization, undefined)
    assert.equal(r.headers.cookie, undefined)
  }
  assert.equal(def.headers['user-agent'], 'monthly-check/1.0 (Claude Code; read-only)')
  assert.equal(custom.headers['user-agent'], 'custom/9.9')
})

test('1 件ずつ入力の順に送り、間に MONTHLY_CHECK_DELAY 秒待つ', async () => {
  const from = requests.length
  await run([base, outDir()], 'a\t/ok?seq=1\nb\t/ok?seq=2\n', { MONTHLY_CHECK_DELAY: '1' })
  const [first, second] = requests.slice(from)
  assert.deepEqual([first.url, second.url], ['/ok?seq=1', '/ok?seq=2'])
  assert.ok(second.at - first.at >= 900, `間隔 ${second.at - first.at}ms`)
})
