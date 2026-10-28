import '../css/stage.css'
import { DEFAULT_PALETTE } from '@shared/palette-defaults'
import type { StageState } from '@shared/ipc'
import type { Palette, ShowOn, StyleId } from '@shared/types'
import { SongClock } from './clock'
import { LockClock } from './lock-clock'
import { activeWordIndex, buildModel, msUntilNextWord, type LyricsModel } from './model'
import { createStyle } from './styles/registry'
import type { StageStyle } from './styles/types'

const api = window.lyricsApp.stage
const root = document.getElementById('stage')!
const rimLight = document.createElement('div')
rimLight.className = 'rim-light'
rimLight.setAttribute('aria-hidden', 'true')
document.body.insertBefore(rimLight, root)
const songCard = document.createElement('section')
songCard.className = 'song-card'
songCard.setAttribute('aria-hidden', 'true')
songCard.innerHTML = '<div class="song-card-art"><img alt="" /><span>♫</span></div><div class="song-card-copy"><div class="song-card-kicker">NOW PLAYING</div><div class="song-card-title"></div><div class="song-card-artist"></div><div class="song-card-album"></div><div class="song-card-progress"><i></i></div></div>'
document.body.append(songCard)
const songArtwork = songCard.querySelector('img')!
const songTitle = songCard.querySelector('.song-card-title')!
const songArtist = songCard.querySelector('.song-card-artist')!
const songAlbum = songCard.querySelector('.song-card-album')!
const songProgress = songCard.querySelector('.song-card-progress i') as HTMLElement
let cardTrackKey = ''
let trackDurationMs = 0
let audioBeat = 0
let audioBeatAt = 0
const clock = new SongClock()
const lockClock = new LockClock(document.body)

let style: StageStyle | null = null
let styleId: StyleId | null = null
let model: LyricsModel | null = null
let lyricsSignature = ''
let palette: Palette = { ...DEFAULT_PALETTE }
let mode: ShowOn = 'lock'
let snapshotMode = false
let loopRunning = false
let pendingState: StageState | null = null

// Text is measured on a canvas, so the bundled font must be ready before the first layout.
const fontsReady = Promise.all([
  document.fonts.load('700 100px "Inter Variable"'),
  document.fonts.load('600 100px "Inter Variable"')
]).then(
  () => undefined,
  () => undefined
)

function signature(state: StageState): string {
  const l = state.lyrics
  if (!l) return `${state.track?.key ?? ''}|none`
  const last = l.lines.at(-1)
  return `${state.track?.key ?? ''}|${l.lines.length}|${l.lines[0]?.start ?? 0}|${last?.end ?? 0}|${l.wordTiming}`
}

function applyPaletteVars(p: Palette): void {
  const s = document.documentElement.style
  s.setProperty('--lyric', p.lyric)
  s.setProperty('--highlight', p.highlight)
  s.setProperty('--highlight-text', p.highlightText)
  s.setProperty('--secondary', p.secondary)
}

function applyState(state: StageState): void {
  mode = state.config.mode
  document.body.dataset.mode = mode
  lockClock.setVisible(mode === 'lock')
  palette = state.config.palette
  applyPaletteVars(palette)
  document.documentElement.style.setProperty('--rim-a', state.config.ambientPalette.highlight)
  document.documentElement.style.setProperty('--rim-b', state.config.ambientPalette.lyric)
  document.body.dataset.lighting = state.config.lighting ? 'on' : 'off'
  const track = state.track
  trackDurationMs = track?.durationMs ?? 0
  songCard.hidden = !track?.title
  songCard.setAttribute('aria-hidden', track?.title ? 'false' : 'true')
  if (track?.title) {
    if (track.key !== cardTrackKey) {
      cardTrackKey = track.key
      songCard.classList.remove('song-card-enter')
      void songCard.offsetWidth
      songCard.classList.add('song-card-enter')
    }
    songTitle.textContent = track.title
    songArtist.textContent = track.artist || track.app
    songAlbum.textContent = track.album || ''
    songArtwork.src = state.artworkUrl || ''
    songCard.classList.toggle('has-artwork', Boolean(state.artworkUrl))
  }
  clock.setOffset(state.config.offsetMs)

  const sig = signature(state)
  const lyricsChanged = sig !== lyricsSignature
  if (lyricsChanged) {
    lyricsSignature = sig
    model = state.lyrics ? buildModel(state.lyrics) : null
  }

  if (state.config.style !== styleId || !style) {
    style?.destroy()
    style = createStyle(state.config.style)
    styleId = state.config.style
    style.mount(root)
    style.setLyrics(model)
  } else if (lyricsChanged) {
    style.setLyrics(model)
  }
  style.setMode(mode)
  style.setPalette(palette)
  startLoop()
}

/**
 * Frames per second: full rate only while a word is popping in; the slow ambient drift
 * looks the same at a lower rate and costs a fraction of the power. The desktop overlay
 * is capped lower because Windows composites transparent full-screen windows expensively.
 */
const FRAME_RATE: Record<ShowOn, { busy: number; idle: number }> = {
  lock: { busy: 60, idle: 24 },
  always: { busy: 30, idle: 15 }
}

function render(songMs: number, wallMs: number): boolean {
  updateLighting(songMs, wallMs)
  const busy = style?.frame({ songMs, wallMs, width: window.innerWidth, height: window.innerHeight }) ?? false
  if (mode === 'lock') lockClock.update(Date.now())
  return busy
}

/** Light swells at word onsets using the same corrected song clock as the lyric renderer. */
function updateLighting(songMs: number, wallMs: number): void {
  if (trackDurationMs > 0) songProgress.style.transform = `scaleX(${Math.max(0, Math.min(1, songMs / trackDurationMs))})`
  document.body.dataset.playing = clock.playing ? 'yes' : 'no'
  if (document.body.dataset.lighting !== 'on' || !clock.playing) {
    rimLight.style.opacity = '0'
    document.documentElement.style.setProperty('--beat-glow', '0')
    return
  }
  let level = 0.2
  const beatPulse = audioBeat * Math.exp(-Math.max(0, wallMs - audioBeatAt) / 330)
  document.documentElement.style.setProperty('--beat-glow', String(Math.min(1, beatPulse)))
  if (model?.words.length) {
    const word = model.words[activeWordIndex(model, songMs)]
    if (word && songMs >= word.start && songMs <= word.end) {
      const duration = Math.max(1, word.end - word.start)
      const progress = Math.max(0, Math.min(1, (songMs - word.start) / duration))
      level += 0.52 * Math.min(1, progress * 9) * (1 - progress * 0.82)
    }
  } else {
    // Gentle ambient fallback while lyrics are unavailable; this is not beat detection.
    level += 0.08 * (0.5 + 0.5 * Math.sin(wallMs / 1200))
  }
  rimLight.style.opacity = String(Math.max(0, Math.min(0.88, level + beatPulse * 0.72)))
}

function loop(): void {
  if (snapshotMode) {
    loopRunning = false
    return
  }
  const started = performance.now()
  const songMs = clock.now(started, Date.now())
  const busy = render(songMs, started)
  const fps = FRAME_RATE[mode][busy ? 'busy' : 'idle']
  if (fps >= 60) {
    requestAnimationFrame(loop)
    return
  }
  // Wait out most of the frame budget, then align the next frame to vsync — but never
  // sleep through the start of the next word, or it would light up a frame late.
  let wait = 1000 / fps - (performance.now() - started) - 8
  if (model && clock.playing) wait = Math.min(wait, msUntilNextWord(model, songMs) - 12)
  setTimeout(() => requestAnimationFrame(loop), Math.max(0, wait))
}

function startLoop(): void {
  if (loopRunning || snapshotMode) return
  loopRunning = true
  requestAnimationFrame(loop)
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

api.onState((state) => {
  pendingState = state
  void fontsReady.then(() => {
    if (!pendingState) return
    const s = pendingState
    pendingState = null
    applyState(s)
  })
})

api.onAnchor((anchor) => {
  clock.setAnchor(anchor, performance.now(), Date.now())
  startLoop()
})

api.onBeat((strength) => {
  audioBeat = Math.max(audioBeat, Math.min(1, strength))
  audioBeatAt = performance.now()
  startLoop()
})

api.onSnapshot((req) => {
  snapshotMode = true
  void fontsReady.then(async () => {
    if (pendingState) {
      applyState(pendingState)
      pendingState = null
    }
    await style?.ready?.()
    render(req.songMs, req.wallMs)
    await nextFrame()
    await nextFrame()
    api.snapshotDone(req.id)
  })
})

// Lock mode: any real input closes the screen (the main process applies a grace period).
let travelled = 0
let lastMove: { x: number; y: number; at: number } | null = null
window.addEventListener('mousemove', (e) => {
  if (mode !== 'lock') return
  const from = lastMove
  if (from && e.timeStamp - from.at < 600) travelled += Math.hypot(e.screenX - from.x, e.screenY - from.y)
  else travelled = 0
  lastMove = { x: e.screenX, y: e.screenY, at: e.timeStamp }
  if (travelled > 12) {
    api.dismiss({
      kind: 'input',
      detail: `mousemove ${Math.round(travelled)}px (${from?.x},${from?.y})→(${e.screenX},${e.screenY}) trusted=${e.isTrusted}`
    })
    travelled = 0
  }
})
window.addEventListener('keydown', (e) => {
  if (mode !== 'lock') return
  if (e.key === 'Escape') api.dismiss({ kind: 'escape', detail: 'Esc' })
  else api.dismiss({ kind: 'input', detail: `keydown key=${e.key} repeat=${e.repeat} trusted=${e.isTrusted}` })
})
for (const type of ['mousedown', 'wheel', 'touchstart'] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (mode === 'lock') api.dismiss({ kind: 'input', detail: `${type} trusted=${e.isTrusted}` })
    },
    { passive: true }
  )
}

// "Press Esc to close" fades in and out when a lyrics screen opens that only Esc closes.
const hint = document.createElement('div')
hint.className = 'stage-hint'
document.body.append(hint)
api.onSession(({ hint: text }) => {
  hint.classList.remove('show')
  if (!text) return
  hint.textContent = text
  void hint.offsetWidth // restart the fade animation
  hint.classList.add('show')
})
