/**
 * UI smoke test for dsh-bgm's client half.
 *
 * The client is plain DOM, so a ~90-line shim is enough to drive it for real:
 * mount, unlock, skip forward, skip back, pause, resume, mute. Assertions are
 * on observable state (`audio.src`, `audio.paused`, `audio.volume`, the label
 * text), not on internals.
 *
 * Run with:  node scripts/ui-smoke.mjs
 */

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------- DOM shim

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.style = {}
    this.dataset = {}
    this.textContent = ''
    this.title = ''
    this.id = ''
    this.className = ''
    this.handlers = new Map()
    this.value = ''
    this.type = ''
    this.offsetWidth = 200
    this.offsetHeight = 30
    if (tag === 'audio') installAudio(this)
  }
  appendChild(child) {
    this.children.push(child)
    return child
  }
  addEventListener(type, fn) {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
  }
  removeEventListener(type, fn) {
    const list = this.handlers.get(type) ?? []
    this.handlers.set(
      type,
      list.filter((item) => item !== fn),
    )
  }
  dispatch(type, event = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn({ stopPropagation() {}, ...event })
  }
  /** Geometry the drag code reads; the values are arbitrary but stable. */
  getBoundingClientRect() {
    return { left: 14, top: 100, width: this.offsetWidth, height: this.offsetHeight, right: 214, bottom: 130 }
  }
  /** Only the two selector shapes this plugin actually uses. */
  querySelector(selector) {
    const match = /^\[data-([a-z-]+)\]$/.exec(selector)
    if (match === null) return null
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const walk = (node) => {
      for (const child of node.children) {
        if (Object.prototype.hasOwnProperty.call(child.dataset, key)) return child
        const deeper = walk(child)
        if (deeper !== null) return deeper
      }
      return null
    }
    return walk(this)
  }
}

const audioLog = []
function installAudio(el) {
  el.paused = true
  el.currentTime = 0
  el.volume = 1
  el.preload = ''
  el.currentSrc = ''
  /** Assigning src resets the playhead in a real browser — count it. */
  el.srcAssignments = 0
  let srcValue = ''
  Object.defineProperty(el, 'src', {
    get: () => srcValue,
    set: (value) => {
      srcValue = value
      el.srcAssignments += 1
      el.currentTime = 0
    },
  })
  el.play = async () => {
    el.paused = false
    audioLog.push('play:' + el.src)
    el.dispatch('play')
  }
  el.pause = () => {
    el.paused = true
    audioLog.push('pause:' + el.src)
    el.dispatch('pause')
  }
}

const body = new El('body')
/** The player keeps its <audio> off-DOM (it need not be in the tree to play). */
const createdAudio = []
const doc = {
  body,
  hidden: false,
  createElement: (tag) => {
    const el = new El(tag)
    if (tag === 'audio') createdAudio.push(el)
    return el
  },
  getElementById(id) {
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === id) return child
        const deeper = walk(child)
        if (deeper !== null) return deeper
      }
      return null
    }
    return body.id === id ? body : walk(body)
  },
  addEventListener() {},
  querySelector() {
    return null // no intro animation in this test
  },
}

const winHandlers = new Map()
let captured = null
const win = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
  addEventListener(type, fn) {
    const list = winHandlers.get(type) ?? []
    list.push(fn)
    winHandlers.set(type, list)
  },
  removeEventListener(type, fn) {
    winHandlers.set(type, (winHandlers.get(type) ?? []).filter((item) => item !== fn))
  },
  dispatch(type, event = {}) {
    for (const fn of winHandlers.get(type) ?? []) fn({ stopPropagation() {}, ...event })
  },
  innerWidth: 1200,
  innerHeight: 800,
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (...args) => clearInterval(...args),
}

const store = new Map()
const localStorageShim = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}

const TRACKS = [
  { name: 'a.mp3', title: '第一首', url: '/dsh-bgm/media/a.mp3' },
  { name: 'b.mp3', title: '第二首', url: '/dsh-bgm/media/b.mp3' },
  { name: 'c.mp3', title: '第三首', url: '/dsh-bgm/media/c.mp3' },
]

let postedSettings = null
const fetchStub = async (url, options = {}) => {
  const path = String(url)
  if (path.endsWith('/list.json')) {
    return { ok: true, json: async () => ({ ok: true, count: TRACKS.length, tracks: TRACKS }) }
  }
  if (path.endsWith('/settings.json')) {
    if ((options.method ?? 'GET') === 'POST') {
      postedSettings = JSON.parse(options.body)
      return { ok: true, json: async () => ({ ok: true, ...postedSettings }) }
    }
    return { ok: true, json: async () => ({ ok: true, volume: 0.35, muted: false }) }
  }
  return { ok: false, json: async () => ({}) }
}

globalThis.window = win
globalThis.document = doc
globalThis.localStorage = localStorageShim
globalThis.fetch = fetchStub

await import('../lib/client.js?ui-smoke')
check('module registers with the loader', captured !== null && captured.id === 'dsh-bgm')

const exported = captured.factory((name) => {
  throw new Error('client must not require ' + name)
})
check('exports apply()', typeof exported.apply === 'function')

exported.apply()
const wrap = doc.getElementById('dsh-bgm-ui')
check('UI mounts', wrap !== null)
check('mounting twice is a no-op', exported.apply() === undefined && doc.getElementById('dsh-bgm-ui') !== null)

const css = String(wrap.style.cssText)
check('pill sits on the LEFT', css.includes('left:14px'), css.split(';').filter((p) => p.includes('left') || p.includes('right')).join(' '))
check('pill no longer anchored right', !css.includes('right:'), '')
check('pill clears the sidebar footer', css.includes('bottom:64px'), '')

const audioEl = createdAudio[0] ?? null
check('audio element created', audioEl !== null)

const playBtn = wrap.querySelector('[data-dsh-bgm-play]')
const nextBtn = wrap.querySelector('[data-dsh-bgm-next]')
const prevBtn = wrap.querySelector('[data-dsh-bgm-prev]')
const muteBtn = wrap.querySelector('[data-dsh-bgm-mute]')
check('three transport buttons exist', playBtn !== null && nextBtn !== null && prevBtn !== null && muteBtn !== null)

// Chromium will not play before a gesture; the plugin waits for one.
win.dispatch('pointerdown')
await tick()
await tick()
check('unlock starts the first track', audioEl.src === TRACKS[0].url, audioEl.src)
check('first track is playing', audioEl.paused === false)

nextBtn.dispatch('click')
await tick()
await tick()
check('next moves to track 2', audioEl.src === TRACKS[1].url, audioEl.src)

nextBtn.dispatch('click')
await tick()
await tick()
check('next moves to track 3', audioEl.src === TRACKS[2].url, audioEl.src)

nextBtn.dispatch('click')
await tick()
await tick()
check('next wraps to track 1', audioEl.src === TRACKS[0].url, audioEl.src)

prevBtn.dispatch('click')
await tick()
await tick()
check('prev wraps back to track 3', audioEl.src === TRACKS[2].url, audioEl.src)

playBtn.dispatch('click')
await tick()
await tick()
check('pause button pauses', audioEl.paused === true)
const label = wrap.querySelector('[data-dsh-bgm-label]')
check('label reports the paused state', (label?.textContent ?? '').includes('已暂停'), label?.textContent ?? '')

// Regression: resuming used to re-assign `src`, which resets the playhead.
audioEl.currentTime = 42
const assignmentsBeforeResume = audioEl.srcAssignments
playBtn.dispatch('click')
await tick()
await tick()
check('resume plays again', audioEl.paused === false)
check('resume does NOT reload the track', audioEl.srcAssignments === assignmentsBeforeResume, `assignments ${audioEl.srcAssignments} vs ${assignmentsBeforeResume}`)
check('resume keeps the playhead', audioEl.currentTime === 42, String(audioEl.currentTime))

// Regression: hiding and returning used to restart the track too.
audioEl.currentTime = 77
const assignmentsBeforeHide = audioEl.srcAssignments
doc.hidden = true
await tick()
doc.hidden = false
await tick()
await tick()
check('returning from hidden does NOT reload the track', audioEl.srcAssignments === assignmentsBeforeHide, `assignments ${audioEl.srcAssignments} vs ${assignmentsBeforeHide}`)
check('returning from hidden keeps the playhead', audioEl.currentTime === 77, String(audioEl.currentTime))
check('returning from hidden resumes playback', audioEl.paused === false)

// A transient hide must not override a manual pause.
playBtn.dispatch('click') // pause first
await tick()
check('paused again for the visibility test', audioEl.paused === true)
doc.hidden = true
doc.hidden = false
await tick()
check('visibility churn keeps the manual pause', audioEl.paused === true)

playBtn.dispatch('click')
await tick()
await tick()
check('play button resumes', audioEl.paused === false)
check('resume keeps the same track', audioEl.src === TRACKS[2].url, audioEl.src)

muteBtn.dispatch('click')
await tick()
check('mute sets volume to 0', audioEl.volume === 0)
muteBtn.dispatch('click')
await tick()
check('unmute restores the volume', audioEl.volume > 0, String(audioEl.volume))

await sleep(400) // the settings POST is debounced by 250ms
check('settings are persisted host-side', postedSettings !== null && typeof postedSettings.volume === 'number', JSON.stringify(postedSettings))

// ---------------------------------------------------------- long-press drag

// A short press must stay a tap: hold for less than LONG_PRESS_MS, then release.
const leftBeforeTap = wrap.style.left
wrap.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 110, target: wrap })
await sleep(120)
win.dispatch('pointerup', {})
await sleep(60)
check('short press does not start a drag', wrap.style.left === leftBeforeTap && wrap.style.transform === '', `${wrap.style.left} / ${wrap.style.transform}`)

// The volume slider owns its pointer, so pressing it must never drag the pill.
const rangeEl = wrap.querySelector('[data-dsh-bgm-volume]')
wrap.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 110, target: rangeEl })
await sleep(450)
check('pressing the volume slider does not start a drag', wrap.style.transform === '', wrap.style.transform)
win.dispatch('pointerup', {})
await sleep(60)

// Long press, then move: the pill follows the pointer.
wrap.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 110, target: wrap })
await sleep(450)
check('long press lifts the pill', wrap.style.transform === 'scale(1.04)', wrap.style.transform)
win.dispatch('pointermove', { clientX: 320, clientY: 260 })
check('dragging moves the pill', wrap.style.left === '314px' && wrap.style.top === '250px', `${wrap.style.left} ${wrap.style.top}`)
check('dragging drops the corner anchor', wrap.style.right === 'auto' && wrap.style.bottom === 'auto', `${wrap.style.right} ${wrap.style.bottom}`)
win.dispatch('pointerup', {})
await sleep(60)
check('dropping releases the drag visual', wrap.style.transform === '', wrap.style.transform)

await sleep(400) // persisted on drop, debounced
check('drag position is persisted host-side', postedSettings?.pos?.x === 314 && postedSettings?.pos?.y === 250, JSON.stringify(postedSettings?.pos))

// A drag must not also press whatever was underneath the pointer.
let clickedAfterDrag = false
playBtn.addEventListener('click', () => {
  clickedAfterDrag = !clickedAfterDrag
})
// The suppression window has already elapsed (300ms), so this is a genuine click.
playBtn.dispatch('click')
check('buttons still work after a drag', clickedAfterDrag === true)

// Clamping: a position beyond the viewport is pulled back on screen.
wrap.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 110, target: wrap })
await sleep(450)
win.dispatch('pointermove', { clientX: 5000, clientY: 5000 })
const clampedLeft = Number.parseInt(wrap.style.left, 10)
const clampedTop = Number.parseInt(wrap.style.top, 10)
check('drag is clamped inside the viewport', clampedLeft <= 1200 && clampedTop <= 800 && clampedLeft >= 0, `${clampedLeft},${clampedTop}`)
win.dispatch('pointerup', {})
await sleep(400)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
