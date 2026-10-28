import '../css/audio.css'

const startButton = document.getElementById('start') as HTMLButtonElement
const stopButton = document.getElementById('stop') as HTMLButtonElement
const status = document.getElementById('status')!
const meter = document.querySelector('.meter')!
const bars = Array.from({ length: 31 }, () => {
  const bar = document.createElement('i')
  meter.append(bar)
  return bar
})
let stream: MediaStream | null = null
let context: AudioContext | null = null
let analyser: AnalyserNode | null = null
let frame = 0
let previous = new Uint8Array(0)
let baseline = 0
let lastBeatAt = 0
let audioData = new Uint8Array(0)

function stopAnalysis(message = 'Off · lyric-timed ambient light remains available'): void {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
  if (context && context.state !== 'closed') void context.close()
  context = null
  analyser = null
  document.body.classList.remove('active')
  startButton.hidden = false
  stopButton.hidden = true
  status.textContent = message
  window.lyricsApp.audio.beat(0)
  bars.forEach((bar) => (bar.style.height = '3px'))
}

async function startAnalysis(): Promise<void> {
  startButton.disabled = true
  status.textContent = 'Waiting for Windows system audio…'
  try {
    // This request is only made after the user's explicit button press. The main process
    // grants system loopback from a dedicated, app-controlled capture session.
    context = new AudioContext({ latencyHint: 'interactive' })
    const contextReady = context.resume()
    const captureRequest = navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 16, height: 16, frameRate: 1 }
    })
    stream = await captureRequest
    await contextReady
    for (const track of stream.getVideoTracks()) track.stop()
    if (!stream.getAudioTracks().length) throw new Error('Windows did not provide a system audio loopback track.')
    analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0
    context.createMediaStreamSource(stream).connect(analyser)
    audioData = new Uint8Array(analyser.frequencyBinCount)
    previous = new Uint8Array(analyser.frequencyBinCount)
    baseline = 0
    lastBeatAt = 0
    document.body.classList.add('active')
    startButton.hidden = true
    stopButton.hidden = false
    startButton.disabled = false
    status.textContent = 'Listening to system output · audio stays on this PC'
    stream.getAudioTracks()[0]?.addEventListener('ended', () => stopAnalysis('System audio ended · start again when ready'), { once: true })
    frame = requestAnimationFrame(analyzeFrame)
  } catch (error) {
    stopAnalysis(error instanceof Error ? error.message : 'Could not start system audio analysis')
    startButton.disabled = false
  }
}

function analyzeFrame(now: number): void {
  if (!analyser || !context) return
  analyser.getByteFrequencyData(audioData)
  const hzPerBin = context.sampleRate / analyser.fftSize
  const lowStart = Math.max(1, Math.floor(35 / hzPerBin))
  const lowEnd = Math.min(audioData.length - 1, Math.ceil(180 / hzPerBin))
  let bass = 0
  let flux = 0
  let bins = 0
  for (let i = lowStart; i <= lowEnd; i++) {
    const level = audioData[i]! / 255
    bass += level * level
    const rise = Math.max(0, audioData[i]! - previous[i]!) / 255
    flux += rise * rise
    previous[i] = audioData[i]!
    bins++
  }
  bass = bins ? Math.sqrt(bass / bins) : 0
  flux = bins ? Math.sqrt(flux / bins) : 0
  if (baseline === 0) baseline = Math.max(0.008, bass)
  const threshold = Math.max(0.014, baseline * 1.42)
  const transient = Math.max(0, bass - baseline) + flux * 0.55
  const refractory = now - lastBeatAt >= 185
  if (refractory && bass > threshold && transient > 0.012) {
    lastBeatAt = now
    const ratio = (bass - baseline) / Math.max(0.015, baseline)
    const strength = Math.max(0.2, Math.min(1, 0.25 + ratio * 0.36 + flux * 1.5))
    window.lyricsApp.audio.beat(strength)
  }
  // Adapt slowly enough that a beat does not immediately raise the local noise floor.
  baseline += (bass - baseline) * (bass < baseline ? 0.045 : 0.006)
  for (let i = 0; i < bars.length; i++) {
    const bin = lowStart + Math.floor((i / bars.length) * Math.max(1, lowEnd - lowStart))
    const value = audioData[bin] ?? 0
    bars[i]!.style.height = `${3 + value / 255 * 18}px`
  }
  frame = requestAnimationFrame(analyzeFrame)
}

startButton.addEventListener('click', () => void startAnalysis())
stopButton.addEventListener('click', () => stopAnalysis())
window.addEventListener('pagehide', () => stopAnalysis())
