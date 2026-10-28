export interface BeatDetectorOptions {
  minIntervalMs?: number
  minFlux?: number
  minBass?: number
}

/**
 * Detects percussive attacks rather than guessing a song tempo. It combines low-band
 * spectral flux (new energy arriving in 25–300 Hz) with bass energy (25–180 Hz), adapts
 * its noise floor slowly, and limits retriggers. Values are normalized byte-spectrum
 * magnitudes from Web Audio's AnalyserNode.
 */
export class BeatDetector {
  private previous: Uint8Array = new Uint8Array(0)
  private bassFloor = 0
  private fluxFloor = 0
  private lastBeatAt = Number.NEGATIVE_INFINITY
  private readonly minIntervalMs: number
  private readonly minFlux: number
  private readonly minBass: number

  constructor(options: BeatDetectorOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 190
    this.minFlux = options.minFlux ?? 0.012
    this.minBass = options.minBass ?? 0.025
  }

  reset(): void {
    this.previous = new Uint8Array(0)
    this.bassFloor = 0
    this.fluxFloor = 0
    this.lastBeatAt = Number.NEGATIVE_INFINITY
  }

  /** Returns transient strength in [0, 1], or 0 for non-beat frames. */
  update(spectrum: Uint8Array, sampleRate: number, atMs: number, sensitivity = 1): number {
    if (!spectrum.length || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(atMs)) return 0
    if (this.previous.length !== spectrum.length) this.previous = new Uint8Array(spectrum.length)

    const hzPerBin = sampleRate / (spectrum.length * 2)
    const bassStart = Math.max(1, Math.floor(25 / hzPerBin))
    const bassEnd = Math.min(spectrum.length - 1, Math.ceil(180 / hzPerBin))
    const fluxStart = bassStart
    const fluxEnd = Math.min(spectrum.length - 1, Math.ceil(300 / hzPerBin))
    if (bassEnd < bassStart || fluxEnd < fluxStart) return 0

    let bassSquares = 0
    let fluxSquares = 0
    let bassBins = 0
    let fluxBins = 0
    for (let i = fluxStart; i <= fluxEnd; i++) {
      const value = (spectrum[i] ?? 0) / 255
      const rise = Math.max(0, (spectrum[i] ?? 0) - (this.previous[i] ?? 0)) / 255
      fluxSquares += rise * rise
      fluxBins++
      if (i <= bassEnd) {
        bassSquares += value * value
        bassBins++
      }
      this.previous[i] = spectrum[i] ?? 0
    }
    const bass = bassBins ? Math.sqrt(bassSquares / bassBins) : 0
    const flux = fluxBins ? Math.sqrt(fluxSquares / fluxBins) : 0
    const gain = Math.max(0.5, Math.min(2, Number.isFinite(sensitivity) ? sensitivity : 1))
    const fluxGate = Math.max(this.minFlux / gain, this.fluxFloor * 2.1)
    const bassGate = Math.max(this.minBass, this.bassFloor * 0.65)
    const detected = flux >= fluxGate && bass >= bassGate && atMs - this.lastBeatAt >= this.minIntervalMs

    // A slow upward and faster downward tracker follows average loudness without adapting
    // away a short kick attack or leaving the detector stuck after a quiet section.
    this.bassFloor += (bass - this.bassFloor) * (bass > this.bassFloor ? 0.003 : 0.04)
    this.fluxFloor += (flux - this.fluxFloor) * (flux > this.fluxFloor ? 0.004 : 0.06)

    if (!detected) return 0
    this.lastBeatAt = atMs
    const transient = 0.18 + Math.min(0.45, flux * 1.8) + Math.min(0.25, Math.max(0, bass - this.bassFloor) * 1.1)
    return Math.max(0.18, Math.min(1, transient * Math.sqrt(gain)))
  }
}
