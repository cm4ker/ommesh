/**
 * The notification sound, drawn from numbers rather than recorded, so it can
 * be tuned here and rendered again (`pnpm sounds`). Plain JavaScript with no
 * Node in it: the page that let the candidates be heard ran this same file.
 *
 * A sound is a list of voices. A voice is one tone: it starts `at` seconds
 * in, glides from `f0` to `f1` Hz over `dur` seconds (a pitch-straight,
 * exponential glide), and is shaped by an attack, an optional exponential
 * decay and a release. `partials` add overtones: [ratio, amplitude, how much
 * faster than the fundamental it dies away].
 */

export const RATE = 48000;

/** The signals the reader picks from (Settings › Notifications › Sound); `chirp` is the default. */
export const SOUNDS = {
  // A LoRa packet opens with a preamble of up-chirps and then down-chirps:
  // this is that, slowed down and pitched into hearing. Two up, one down.
  chirp: {
    wet: 0.16,
    voices: [
      { at: 0, dur: 0.075, f0: 700, f1: 1400, gain: 0.8, attack: 0.006, release: 0.02, partials: [[1, 1], [2, 0.16], [3, 0.05]] },
      { at: 0.105, dur: 0.075, f0: 700, f1: 1400, gain: 0.85, attack: 0.006, release: 0.02, partials: [[1, 1], [2, 0.16], [3, 0.05]] },
      { at: 0.21, dur: 0.2, f0: 1400, f1: 933, gain: 1, attack: 0.006, release: 0.09, decay: 0.3, partials: [[1, 1], [2, 0.16], [3, 0.05]] },
    ],
  },
  // "R" in Morse, di-dah-dit: on the air it means "received", roger.
  roger: {
    wet: 0.18,
    voices: [
      { at: 0, dur: 0.07, f0: 1047, gain: 0.8, attack: 0.008, release: 0.02, decay: 0.5, partials: [[1, 1], [2, 0.2, 2], [3, 0.06, 3]] },
      { at: 0.14, dur: 0.21, f0: 1568, gain: 1, attack: 0.008, release: 0.04, decay: 0.5, partials: [[1, 1], [2, 0.2, 2], [3, 0.06, 3]] },
      { at: 0.42, dur: 0.07, f0: 1319, gain: 0.85, attack: 0.008, release: 0.03, decay: 0.5, partials: [[1, 1], [2, 0.2, 2], [3, 0.06, 3]] },
    ],
  },
  // Three hops up through the mesh, and the last one relayed twice, fainter each time.
  hop: {
    wet: 0.14,
    voices: [
      { at: 0, dur: 0.3, f0: 1175, gain: 0.75, attack: 0.003, release: 0.05, decay: 0.12, partials: [[1, 1], [3.93, 0.3, 3.5], [9.2, 0.06, 7]] },
      { at: 0.085, dur: 0.3, f0: 1568, gain: 0.85, attack: 0.003, release: 0.05, decay: 0.12, partials: [[1, 1], [3.93, 0.3, 3.5], [9.2, 0.06, 7]] },
      { at: 0.17, dur: 0.4, f0: 1976, gain: 1, attack: 0.003, release: 0.08, decay: 0.16, partials: [[1, 1], [3.93, 0.3, 3.5], [9.2, 0.06, 7]] },
      { at: 0.33, dur: 0.3, f0: 1976, gain: 0.32, attack: 0.003, release: 0.06, decay: 0.12, partials: [[1, 1], [3.93, 0.3, 3.5]] },
      { at: 0.48, dur: 0.3, f0: 1976, gain: 0.14, attack: 0.003, release: 0.06, decay: 0.12, partials: [[1, 1], [3.93, 0.3, 3.5]] },
    ],
  },
  // A ping out, and an answer a fifth below: someone out there heard it.
  sonar: {
    wet: 0.3,
    voices: [
      { at: 0, dur: 0.45, f0: 1760, f1: 1700, gain: 0.9, attack: 0.002, release: 0.1, decay: 0.13, partials: [[1, 1], [2, 0.08, 2]] },
      { at: 0.22, dur: 0.55, f0: 1175, gain: 0.75, attack: 0.004, release: 0.12, decay: 0.2, partials: [[1, 1], [2, 0.1, 2]] },
    ],
  },
};

/**
 * What a coverage survey says after each ask, for a reader whose eyes are on
 * the road. They are told apart by which way they go, not by their pitch: a
 * lone beep in a car's noise is hard to place as high or low.
 */
export const CUES = {
  // Two notes up: a repeater answered.
  heard: {
    wet: 0.1,
    voices: [
      { at: 0, dur: 0.09, f0: 988, gain: 0.85, attack: 0.005, release: 0.025, partials: [[1, 1], [2, 0.2], [3, 0.06]] },
      { at: 0.1, dur: 0.15, f0: 1319, gain: 1, attack: 0.005, release: 0.05, decay: 0.4, partials: [[1, 1], [2, 0.2], [3, 0.06]] },
    ],
  },
  // Two notes down: nobody did. The overtones carry it on a phone's small speaker, which loses the notes themselves.
  unheard: {
    wet: 0.1,
    voices: [
      { at: 0, dur: 0.11, f0: 523, gain: 0.9, attack: 0.006, release: 0.03, partials: [[1, 1], [2, 0.5], [3, 0.3], [4, 0.12]] },
      { at: 0.12, dur: 0.22, f0: 392, gain: 1, attack: 0.006, release: 0.08, decay: 0.5, partials: [[1, 1], [2, 0.5], [3, 0.3], [4, 0.12]] },
    ],
  },
};

/** How long the sound is, reverb tail included. */
function length(sound) {
  return Math.max(...sound.voices.map((v) => v.at + v.dur)) + 0.35;
}

function voice(out, v) {
  const start = Math.round(v.at * RATE);
  const n = Math.round(v.dur * RATE);
  const f1 = v.f1 ?? v.f0;
  const partials = v.partials ?? [[1, 1]];
  const release = v.release ?? 0.02;
  let phase = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / RATE;
    const f = v.f0 * Math.pow(f1 / v.f0, t / v.dur);
    phase += (2 * Math.PI * f) / RATE;
    // A quarter-sine attack and release: no click at either end.
    let env = 1;
    if (t < v.attack) env *= Math.sin((Math.PI / 2) * (t / v.attack));
    const left = v.dur - t;
    if (left < release) env *= Math.sin((Math.PI / 2) * Math.max(0, left / release));
    let sample = 0;
    for (const [ratio, amp, faster = 1] of partials) {
      const fade = v.decay ? Math.exp(-t / (v.decay / faster)) : 1;
      sample += amp * fade * Math.sin(phase * ratio);
    }
    out[start + i] += (v.gain ?? 1) * env * sample;
  }
}

/** A small Schroeder room: four damped combs in parallel, two all-passes after them. */
function room(dry, wet) {
  if (!wet) return dry;
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => ({ buf: new Float32Array(Math.round(s * RATE)), i: 0, low: 0 }));
  const passes = [0.005, 0.0017].map((s) => ({ buf: new Float32Array(Math.round(s * RATE)), i: 0 }));
  const out = new Float32Array(dry.length);
  for (let n = 0; n < dry.length; n++) {
    let sum = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.low = y * 0.6 + c.low * 0.4;
      c.buf[c.i] = dry[n] + c.low * 0.72;
      c.i = (c.i + 1) % c.buf.length;
      sum += y;
    }
    let x = sum / combs.length;
    for (const p of passes) {
      const y = p.buf[p.i];
      p.buf[p.i] = x + y * 0.5;
      p.i = (p.i + 1) % p.buf.length;
      x = y - x * 0.5;
    }
    out[n] = dry[n] + wet * x;
  }
  return out;
}

/**
 * The samples, at `RATE`: as loud as each other on average, and never over
 * just under full scale, so a sound with more notes in it is not the louder.
 */
export function render(sound) {
  const dry = new Float32Array(Math.ceil(length(sound) * RATE));
  for (const v of sound.voices) voice(dry, v);
  const out = room(dry, sound.wet);
  let peak = 0;
  let power = 0;
  for (const s of out) {
    peak = Math.max(peak, Math.abs(s));
    power += s * s;
  }
  const rms = Math.sqrt(power / out.length);
  const scale = peak ? Math.min(0.89 / peak, 0.2 / rms) : 1;
  // The last 60 ms fade out, so the tail never stops on a click.
  const fade = Math.round(0.06 * RATE);
  for (let i = 0; i < out.length; i++) {
    const left = out.length - i;
    out[i] *= scale * (left < fade ? left / fade : 1);
  }
  return out;
}

/** A 16-bit mono PCM WAV file, which every shell plays: iOS and Android notification sounds, PlaySound, a browser. */
export function wav(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return bytes;
}
