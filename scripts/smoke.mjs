/**
 * Offline smoke test for the dsh-bgm host half.
 *
 * Self-contained on purpose: it builds its own throwaway $DSH_HOME with two
 * generated WAV files (a hand-written RIFF header, no ffmpeg and no fixtures in
 * the repo), mounts the routes on a real HTTP server, and exercises:
 *
 *   - the listing (and that non-audio files are ignored)
 *   - a full GET
 *   - a Range GET (206 + content-range)
 *   - traversal refusal
 *   - the settings round-trip, including the drag position
 *
 * Run with:  node scripts/smoke.mjs
 */
import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A few milliseconds of 8 kHz mono 16-bit PCM, as a valid .wav. */
function wavBytes(seconds = 0.2) {
  const rate = 8000
  const samples = Math.round(rate * seconds)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const home = mkdtempSync(join(tmpdir(), 'dsh-bgm-smoke-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'bgm'), { recursive: true })
writeFileSync(join(home, 'bgm', 'a-track.wav'), wavBytes())
writeFileSync(join(home, 'bgm', 'b-track.wav'), wavBytes())
writeFileSync(join(home, 'bgm', 'notes.txt'), 'not audio')

const { apply } = await import('../lib/index.js')

const routes = []
apply({
  webServer: {
    register(route) {
      routes.push(route)
    },
  },
})

function match(pathname) {
  for (const route of routes) {
    if (pathname === route.path || pathname.startsWith(route.path + '/')) return route
  }
  return null
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const route = match(pathname)
  if (route === null) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}

const listResponse = await fetch(`${base}/dsh-bgm/list.json`)
const list = await listResponse.json()
check('list status 200', listResponse.status === 200)
check('list finds 2 audio files', list.count === 2, `count=${list.count}`)
check('ignores .txt', !JSON.stringify(list.tracks).includes('notes.txt'))
check('tracks carry an encoded url', list.tracks.every((t) => t.url.startsWith('/dsh-bgm/media/')))

const first = list.tracks[0]
const full = await fetch(`${base}${first.url}`)
const fullBytes = Buffer.from(await full.arrayBuffer())
check('full GET 200', full.status === 200, `status=${full.status}`)
check('full GET accepts ranges', full.headers.get('accept-ranges') === 'bytes')
check('full GET length matches file', fullBytes.length === first.bytes, `${fullBytes.length} vs ${first.bytes}`)
check('wav content-type', (full.headers.get('content-type') ?? '') === 'audio/wav')

const ranged = await fetch(`${base}${first.url}`, { headers: { range: 'bytes=0-1023' } })
const rangedBytes = Buffer.from(await ranged.arrayBuffer())
check('range GET 206', ranged.status === 206, `status=${ranged.status}`)
check('range length 1024', rangedBytes.length === 1024, `${rangedBytes.length}`)
check(
  'range content-range header',
  ranged.headers.get('content-range') === `bytes 0-1023/${first.bytes}`,
  ranged.headers.get('content-range') ?? 'null',
)
check('range bytes match the head of the file', rangedBytes.equals(fullBytes.subarray(0, 1024)))

const traversal = await fetch(`${base}/dsh-bgm/media/..%2f..%2fsecret.mp3`)
check('traversal refused', traversal.status === 400 || traversal.status === 404, `status=${traversal.status}`)

const missing = await fetch(`${base}/dsh-bgm/media/nope.mp3`)
check('missing file 404', missing.status === 404, `status=${missing.status}`)

// --- settings persistence (survives a new port, unlike localStorage) ---
const defaults = await (await fetch(`${base}/dsh-bgm/settings.json`)).json()
check('settings default volume 0.35', defaults.volume === 0.35, `volume=${defaults.volume}`)
check('settings default not muted', defaults.muted === false)

const saved = await (
  await fetch(`${base}/dsh-bgm/settings.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volume: 0.8, muted: true }),
  })
).json()
check('POST settings accepted', saved.ok === true && saved.volume === 0.8 && saved.muted === true, JSON.stringify(saved))

const reread = await (await fetch(`${base}/dsh-bgm/settings.json`)).json()
check('settings persisted across requests', reread.volume === 0.8 && reread.muted === true, JSON.stringify(reread))

const clamped = await (
  await fetch(`${base}/dsh-bgm/settings.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volume: 99, muted: 'yes' }),
  })
).json()
check('out-of-range volume clamped to 1', clamped.volume === 1, `volume=${clamped.volume}`)
check('non-boolean muted falls back', clamped.muted === false, `muted=${clamped.muted}`)

const afterSettings = await (await fetch(`${base}/dsh-bgm/list.json`)).json()
check('settings file is not listed as a track', afterSettings.count === 2, `count=${afterSettings.count}`)

// --- drag position round-trips, and garbage is refused ---
const withPos = await (
  await fetch(`${base}/dsh-bgm/settings.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volume: 0.5, muted: false, pos: { x: 120, y: 340 } }),
  })
).json()
check('POST keeps the drag position', withPos.pos?.x === 120 && withPos.pos?.y === 340, JSON.stringify(withPos.pos))

const posReread = await (await fetch(`${base}/dsh-bgm/settings.json`)).json()
check('drag position persists', posReread.pos?.x === 120 && posReread.pos?.y === 340, JSON.stringify(posReread.pos))

const badPos = await (
  await fetch(`${base}/dsh-bgm/settings.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volume: 0.5, muted: false, pos: { x: 'left', y: null } }),
  })
).json()
check('malformed position is dropped', badPos.pos === null, JSON.stringify(badPos.pos))

const clampedPos = await (
  await fetch(`${base}/dsh-bgm/settings.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ volume: 0.5, muted: false, pos: { x: 999999, y: -50 } }),
  })
).json()
check('absurd position is clamped', clampedPos.pos?.x === 20000 && clampedPos.pos?.y === 0, JSON.stringify(clampedPos.pos))

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
