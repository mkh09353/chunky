// Synthesize a two-blast ship's foghorn into a 16-bit mono WAV.
// Usage: bun scripts/make-horn.ts [outfile]
const rate = 44100
const blast = 1.4 // seconds per blast
const gap = 0.4
const total = blast * 2 + gap
const n = Math.round(total * rate)
const samples = new Int16Array(n)

// Big ship horn: dual-tone (two fundamentals ~ a fifth apart), full harmonic
// series with 1/n rolloff driven hard into saturation, slight pitch sag at the
// end of each blast, and a touch of breath noise.
const tones = [
  { f: 58, w: 1.0 }, // A#1-ish, the big one
  { f: 87, w: 0.7 }, // a fifth up — the classic two-note blare
]
const NH = 16 // harmonics per tone

function env(t: number, dur: number): number {
  const attack = 0.08
  const release = 0.3
  if (t < 0 || t > dur) return 0
  if (t < attack) return t / attack
  if (t > dur - release) return (dur - t) / release
  return 1
}

// Pitch sag: horns droop slightly as the blast dies.
function sag(t: number, dur: number): number {
  if (t < 0 || t > dur) return 1
  const tail = 0.35
  if (t < dur - tail) return 1
  return 1 - 0.03 * ((t - (dur - tail)) / tail)
}

// Deterministic noise for breathiness.
let seed = 1
function noise(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x3fffffff - 1
}

// Integrate phase per partial so the pitch sag doesn't click.
const phases = new Float64Array(tones.length * NH)
const starts = [0, blast + gap]
for (let i = 0; i < n; i++) {
  const t = i / rate
  let amp = 0
  let bend = 1
  for (const st of starts) {
    const e = env(t - st, blast)
    if (e > 0) {
      amp += e
      bend = sag(t - st, blast)
    }
  }
  if (amp <= 0) continue
  const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 4.5 * t)
  let s = 0
  let p = 0
  for (const tone of tones) {
    for (let h = 1; h <= NH; h++, p++) {
      phases[p] += (2 * Math.PI * tone.f * h * vib * bend) / rate
      // 1/h rolloff, with a formant bump around harmonics 3-5 for blare
      const bump = h >= 3 && h <= 5 ? 1.8 : 1
      s += (tone.w * bump * Math.sin(phases[p])) / h
    }
  }
  s += 0.02 * noise() // breath
  // drive it hard — this is where the blare comes from
  s = Math.tanh(s * 3.2)
  samples[i] = Math.max(-32767, Math.min(32767, Math.round(s * amp * 0.85 * 32767)))
}

// WAV header
const dataSize = n * 2
const buf = Buffer.alloc(44 + dataSize)
buf.write("RIFF", 0)
buf.writeUInt32LE(36 + dataSize, 4)
buf.write("WAVE", 8)
buf.write("fmt ", 12)
buf.writeUInt32LE(16, 16)
buf.writeUInt16LE(1, 20) // PCM
buf.writeUInt16LE(1, 22) // mono
buf.writeUInt32LE(rate, 24)
buf.writeUInt32LE(rate * 2, 28)
buf.writeUInt16LE(2, 32)
buf.writeUInt16LE(16, 34)
buf.write("data", 36)
buf.writeUInt32LE(dataSize, 40)
Buffer.from(samples.buffer).copy(buf, 44)

const out = process.argv[2] ?? "horn.wav"
await Bun.write(out, buf)
console.log("wrote", out, `${(buf.length / 1024).toFixed(0)}KB`)
