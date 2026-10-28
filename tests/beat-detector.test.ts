import { describe, expect, it } from 'vitest'
import { BeatDetector } from '../src/renderer/src/audio/beat-detector'

const makeKick = (strength = 180): Uint8Array => {
  const spectrum = new Uint8Array(1024)
  for (let i = 2; i <= 6; i++) spectrum[i] = strength
  return spectrum
}

describe('BeatDetector', () => {
  it('ignores silence and non-finite input', () => {
    const detector = new BeatDetector()
    expect(detector.update(new Uint8Array(1024), 44100, 0)).toBe(0)
    expect(detector.update(new Uint8Array(1024), 44100, Number.NaN)).toBe(0)
  })

  it('detects a bass transient and does not retrigger on a sustained note', () => {
    const detector = new BeatDetector()
    const silence = new Uint8Array(1024)
    const kick = makeKick()
    expect(detector.update(silence, 44100, 0)).toBe(0)
    expect(detector.update(kick, 44100, 100)).toBeGreaterThan(0)
    expect(detector.update(kick, 44100, 300)).toBe(0)
  })

  it('enforces a minimum interval but detects the next attack after release', () => {
    const detector = new BeatDetector()
    const silence = new Uint8Array(1024)
    const kick = makeKick()
    detector.update(silence, 44100, 0)
    expect(detector.update(kick, 44100, 100)).toBeGreaterThan(0)
    detector.update(silence, 44100, 150)
    expect(detector.update(kick, 44100, 220)).toBe(0)
    detector.update(silence, 44100, 350)
    expect(detector.update(kick, 44100, 500)).toBeGreaterThan(0)
  })

  it('responds more strongly at higher sensitivity', () => {
    const low = new BeatDetector()
    const high = new BeatDetector()
    const silence = new Uint8Array(1024)
    const quietKick = makeKick(60)
    low.update(silence, 44100, 0)
    high.update(silence, 44100, 0)
    const lowPulse = low.update(quietKick, 44100, 100, 0.5)
    const highPulse = high.update(quietKick, 44100, 100, 2)
    expect(lowPulse).toBeGreaterThan(0)
    expect(highPulse).toBeGreaterThan(lowPulse)
  })
})
