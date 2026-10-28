import '../css/audio.css'
import { BeatDetector } from './beat-detector'

const startButton = document.getElementById('start') as HTMLButtonElement
const stopButton = document.getElementById('stop') as HTMLButtonElement
const status = document.getElementById('status')!
const meter = document.querySelector('.meter')!
const sensitivityControl = document.getElementById('sensitivity') as HTMLInputElement
const sensitivityLabel = document.getElementById('sensitivity-label')!
const bars = Array.from({ length: 31 }, () => {
  const bar = document.createElement('i')
  meter.append(bar)
  return bar
})
const detector = new BeatDetector()
let stream: MediaStream | null = null
let context: AudioContext | null = null
let analyser: AnalyserNode | null = null
let frame = 0
let startGeneration = 0
let audioData = new Uint8Array(0)

function stopAnalysis(message = 'Off · lyric-timed ambient light remains available'): void {
  // Invalidates any display-media request that is still resolving. Its eventual stream is
  // stopped as soon as it arrives, instead of starting capture behind a closed panel.
  startGeneration++
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
  if (context && context.state !== 'closed') void context.close().catch(() => undefined)
  context = null
  analyser = null
  detector.reset()
  document.body.classList.remove('active')
  startButton.hidden = false
  startButton.disabled = false
  stopButton.hidden = true
  stopButton.textContent = 'Stop analysis'
  status.textContent = message
  window.lyricsApp.audio.beat(0)
  bars.forEach((bar) => (bar.style.height = '3px'))
}

function explainCaptureError(error: unknown): string {
  if (!(error instanceof Error)) return 'Could not start system audio analysis. Check Windows audio output and try again.'
  if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
    return 'Capture was canceled or not permitted. Nothing is being analyzed; press Start to try again.'
  }
  if (error.name === 'NotFoundError' || error.message.includes('did not provide a system audio')) {
    return 'Windows did not provide system audio loopback. Check that an audio output is connected, then try again.'
  }
  if (error.name === 'NotReadableError') return 'Windows could not open the audio output. Close apps holding it exclusively, then retry.'
  return 'Could not start system audio analysis. Check Windows audio output and try again.'
}

async function startAnalysis(): Promise<void> {
  const generation = ++startGeneration
  startButton.disabled = true
  stopButton.hidden = false
  stopButton.textContent = 'Cancel'
  status.textContent = 'Waiting for Windows system audio…'
  try {
    // Both requests start synchronously from the explicit button gesture so Chromium's
    // user-activation requirement is preserved for getDisplayMedia and AudioContext.
    const audioContext = new AudioContext({ latencyHint: 'interactive' })
    context = audioContext
    const contextReady = audioContext.resume()
    const captureRequest = navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 16, height: 16, frameRate: 1 }
    })
    const capturedStream = await captureRequest
    if (generation !== startGeneration) {
      for (const track of capturedStream.getTracks()) track.stop()
      if (audioContext.state !== 'closed') void audioContext.close().catch(() => undefined)
      return
    }
    stream = capturedStream
    await contextReady
    if (generation !== startGeneration) {
      for (const track of capturedStream.getTracks()) track.stop()
      if (stream === capturedStream) stream = null
      if (context === audioContext) context = null
      if (audioContext.state !== 'closed') void audioContext.close().catch(() => undefined)
      return
    }
    for (const track of capturedStream.getVideoTracks()) track.stop()
    if (!capturedStream.getAudioTracks().length) throw new Error('Windows did not provide a system audio loopback track.')

    const nextAnalyser = audioContext.createAnalyser()
    nextAnalyser.fftSize = 2048
    nextAnalyser.smoothingTimeConstant = 0
    audioContext.createMediaStreamSource(capturedStream).connect(nextAnalyser)
    analyser = nextAnalyser
    audioData = new Uint8Array(nextAnalyser.frequencyBinCount)
    detector.reset()
    document.body.classList.add('active')
    startButton.hidden = true
    stopButton.hidden = false
    stopButton.textContent = 'Stop analysis'
    startButton.disabled = false
    status.textContent = 'Listening to system output · audio stays on this PC'
    capturedStream.getAudioTracks()[0]?.addEventListener(
      'ended',
      () => stopAnalysis('System audio ended · start again when ready'),
      { once: true }
    )
    frame = requestAnimationFrame(analyzeFrame)
  } catch (error) {
    if (generation !== startGeneration) return
    stopAnalysis(explainCaptureError(error))
  }
}

function analyzeFrame(now: number): void {
  if (!analyser || !context) return
  analyser.getByteFrequencyData(audioData)
  const strength = detector.update(audioData, context.sampleRate, now, Number(sensitivityControl.value))
  if (strength > 0) window.lyricsApp.audio.beat(strength)

  const hzPerBin = context.sampleRate / analyser.fftSize
  const lowStart = Math.max(1, Math.floor(35 / hzPerBin))
  const lowEnd = Math.min(audioData.length - 1, Math.ceil(180 / hzPerBin))
  for (let i = 0; i < bars.length; i++) {
    const bin = lowStart + Math.floor((i / bars.length) * Math.max(1, lowEnd - lowStart))
    const value = audioData[bin] ?? 0
    bars[i]!.style.height = `${3 + (value / 255) * 18}px`
  }
  frame = requestAnimationFrame(analyzeFrame)
}

function updateSensitivityLabel(): void {
  const value = Number(sensitivityControl.value)
  sensitivityLabel.textContent = value < 0.8 ? 'Subtle' : value > 1.35 ? 'Reactive' : 'Balanced'
}

startButton.addEventListener('click', () => void startAnalysis())
stopButton.addEventListener('click', () => stopAnalysis())
sensitivityControl.addEventListener('input', updateSensitivityLabel)
window.addEventListener('pagehide', () => stopAnalysis())
updateSensitivityLabel()
