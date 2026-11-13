/**
 * dsh-bgm — host half.
 *
 * The only job here is to answer two questions for the client:
 *
 *   GET /dsh-bgm/list.json         what is in $DSH_HOME/bgm right now
 *   GET /dsh-bgm/media/<name>      the bytes of one of those files
 *
 * Playback itself lives entirely in the browser (lib/client.js). Keeping the
 * host half this small is deliberate: a music player needs no authority, and
 * every line of host code is a line that can break a boot.
 *
 * The directory is re-scanned on every request rather than cached, so dropping
 * a file into ~/.dsh/bgm is picked up without a restart — the same rule the
 * boot-animation plugin uses for its clip folder.
 */
import { createReadStream, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

export const name = 'dsh-bgm'

/** The webserver is the only host service this plugin needs. */
export const inject = ['webServer']

const BASE = '/dsh-bgm'
const LIST_ROUTE = `${BASE}/list.json`
/**
 * NO trailing slash: the webserver matches a prefix route with
 * `pathname !== prefix && !pathname.startsWith(prefix + '/')`, so a registered
 * path ending in '/' is tested as '//' and never matches a real request.
 */
const MEDIA_ROUTE = `${BASE}/media`
const SETTINGS_ROUTE = `${BASE}/settings.json`
/** Hidden so the folder stays a playlist, but still lives beside the tracks. */
const SETTINGS_FILE = '.settings.json'
const DEFAULT_SETTINGS = { volume: 0.35, muted: false, pos: null }
/** A pill parked off-screen is useless; anything past this is a bad client. */
const MAX_POS = 20000

/** Extensions the browser is likely to decode. Anything else is ignored. */
const AUDIO_EXT = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.webm', 'audio/webm'],
])

/** $DSH_HOME/bgm — resolved per call so a moved home never pins a stale path. */
function bgmDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'bgm')
}

/**
 * Every playable file in the folder, sorted by name.
 *
 * A missing folder is not an error: it just means "no tracks yet", and the
 * client shows a quiet hint instead of failing.
 */
function scan() {
  const dir = bgmDir()
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { dir, tracks: [] }
  }
  const tracks = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    const type = AUDIO_EXT.get(ext)
    if (type === undefined) continue
    const full = join(dir, entry.name)
    let stats = null
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    tracks.push({
      name: entry.name,
      title: basename(entry.name, extname(entry.name)),
      url: `${MEDIA_ROUTE}/${encodeURIComponent(entry.name)}`,
      type,
      bytes: stats.size,
      mtime: Math.round(stats.mtimeMs),
    })
  }
  tracks.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return { dir, tracks }
}

function sendJson(res, value, status = 200) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** The requested file name, or null when it is not one the folder contains. */
function requestedName(req) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const tail = pathname.slice(MEDIA_ROUTE.length + 1)
  if (tail === '') return null
  let decoded
  try {
    decoded = decodeURIComponent(tail)
  } catch {
    return null
  }
  // One flat file name, nothing else: no separators, no traversal, no drive letters.
  if (decoded !== basename(decoded)) return null
  if (decoded.includes('/') || decoded.includes('\\')) return null
  if (!AUDIO_EXT.has(extname(decoded).toLowerCase())) return null
  return decoded
}

/** `bytes=start-end` → `{ start, end }`, or null for "serve the whole thing". */
function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    // Suffix form: the LAST n bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

/** A stored drag position, or null when absent/malformed. */
function normalizePos(value) {
  if (value === null || typeof value !== 'object') return null
  const { x, y } = value
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  return {
    x: Math.round(Math.min(Math.max(0, x), MAX_POS)),
    y: Math.round(Math.min(Math.max(0, y), MAX_POS)),
  }
}

/** Clamp anything a client sends into the fields this plugin owns. */
function normalizeSettings(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const rawVolume = typeof source.volume === 'number' && Number.isFinite(source.volume) ? source.volume : DEFAULT_SETTINGS.volume
  return {
    volume: Math.min(1, Math.max(0, rawVolume)),
    muted: typeof source.muted === 'boolean' ? source.muted : DEFAULT_SETTINGS.muted,
    pos: normalizePos(source.pos),
  }
}

/** The stored settings, or the defaults when the file is missing or unreadable. */
function readSettings() {
  try {
    const raw = readFileSync(join(bgmDir(), SETTINGS_FILE), 'utf8')
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Write through a temp file so a crash mid-write cannot leave half a JSON. */
function writeSettings(value) {
  const dir = bgmDir()
  mkdirSync(dir, { recursive: true })
  const target = join(dir, SETTINGS_FILE)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
}

export function apply(ctx) {
  const serveList = (req, res) => {
    try {
      const { dir, tracks } = scan()
      sendJson(res, {
        ok: true,
        dir,
        accepts: [...AUDIO_EXT.keys()],
        count: tracks.length,
        tracks,
      })
    } catch (cause) {
      sendJson(res, { ok: false, error: String(cause) }, 500)
    }
  }

  const serveMedia = (req, res) => {
    const name = requestedName(req)
    if (name === null) {
      sendJson(res, { ok: false, error: 'not a playable file name' }, 400)
      return
    }
    const full = join(bgmDir(), name)
    let stats = null
    try {
      stats = statSync(full)
    } catch {
      sendJson(res, { ok: false, error: 'gone' }, 404)
      return
    }
    if (!stats.isFile()) {
      sendJson(res, { ok: false, error: 'not a file' }, 404)
      return
    }
    const type = AUDIO_EXT.get(extname(name).toLowerCase()) ?? 'application/octet-stream'
    const range = parseRange(req.headers.range, stats.size)
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'last-modified': new Date(stats.mtimeMs).toUTCString(),
    }
    if (range === null) {
      headers['content-length'] = String(stats.size)
      res.writeHead(200, headers)
      createReadStream(full).pipe(res)
      return
    }
    headers['content-length'] = String(range.end - range.start + 1)
    headers['content-range'] = `bytes ${range.start}-${range.end}/${stats.size}`
    res.writeHead(206, headers)
    createReadStream(full, { start: range.start, end: range.end }).pipe(res)
  }

  /**
   * Playback settings, stored HOST-side on purpose.
   *
   * localStorage is scoped to `host:port`, and the desktop client binds a fresh
   * port on every launch — so anything kept there is silently lost on restart.
   * A small JSON file next to the music survives that, and is shared by every
   * port the app may come up on.
   */
  const serveSettings = (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() === 'GET') {
      sendJson(res, { ok: true, ...readSettings() })
      return
    }
    if ((req.method ?? '').toUpperCase() !== 'POST') {
      sendJson(res, { ok: false, error: 'method not allowed' }, 405)
      return
    }
    let raw = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // 4 KiB is far more than two numbers need; refuse anything bigger.
      if (size > 4096) {
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw === '' ? '{}' : raw)
        const next = normalizeSettings(parsed)
        writeSettings(next)
        sendJson(res, { ok: true, ...next })
      } catch (cause) {
        sendJson(res, { ok: false, error: String(cause) }, 400)
      }
    })
  }

  ctx.webServer.register({ kind: 'prefix', path: LIST_ROUTE, handler: serveList })
  ctx.webServer.register({ kind: 'prefix', path: MEDIA_ROUTE, handler: serveMedia })
  ctx.webServer.register({ kind: 'prefix', path: SETTINGS_ROUTE, handler: serveSettings })

  // A folder that does not exist yet is normal on a fresh install: create it so
  // the user has somewhere obvious to drop files. Failure is not fatal — the
  // list route already reports "no tracks" for a missing directory.
  try {
    mkdirSync(bgmDir(), { recursive: true })
  } catch {
    /* the plugin still lists and serves whatever exists */
  }
}
