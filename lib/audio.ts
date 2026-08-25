/**
 * Procedural sound effects.
 *
 * Every sound is synthesised from oscillators at runtime, so the project ships
 * no audio files and the whole kit costs a couple of kilobytes. It also means
 * the sounds can be derived from gameplay values — the coin pitch rises with
 * each one collected in a row, which is most of what makes collecting them feel
 * good.
 *
 * Browsers refuse to start an AudioContext without a user gesture, so nothing is
 * constructed until the player presses Start.
 */

export type Sfx =
  | "jump"
  | "land"
  | "bounce"
  | "coin"
  | "death"
  | "win"
  | "crumble"
  | "stomp"
  | "tunnel"
  | "ui";

type Ctx = AudioContext & { _unlocked?: boolean };

let ctx: Ctx | null = null;
let master: GainNode | null = null;
let coinStreak = 0;

export function unlockAudio() {
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return;
  }
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return;
  ctx = new AC() as Ctx;
  master = ctx.createGain();
  master.gain.value = 0.28;
  master.connect(ctx.destination);
}

export function resetCoinStreak() {
  coinStreak = 0;
}

/** One oscillator with an exponential pitch sweep and a percussive envelope. */
function blip(
  type: OscillatorType,
  from: number,
  to: number,
  duration: number,
  volume: number,
  delay = 0,
) {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + duration);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** Filtered noise, for impacts that should sound like material rather than tone. */
function noise(duration: number, volume: number, freq: number) {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime;
  const frames = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const chan = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    chan[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(master);
  src.start(t0);
}

export function playSfx(name: Sfx) {
  if (!ctx) return;
  switch (name) {
    case "jump":
      blip("square", 320, 620, 0.11, 0.16);
      break;
    case "land":
      noise(0.07, 0.1, 320);
      break;
    case "bounce":
      blip("sine", 260, 900, 0.2, 0.3);
      blip("triangle", 520, 1400, 0.16, 0.12, 0.02);
      break;
    case "coin": {
      // Each coin in a run lands a step higher, up to an octave.
      const step = Math.min(coinStreak, 7);
      coinStreak++;
      const base = 880 * Math.pow(2, step / 12);
      blip("square", base, base, 0.06, 0.18);
      blip("square", base * 1.5, base * 1.5, 0.12, 0.14, 0.05);
      break;
    }
    case "crumble":
      noise(0.22, 0.14, 900);
      break;
    case "death":
      coinStreak = 0;
      blip("sawtooth", 380, 60, 0.42, 0.24);
      noise(0.16, 0.12, 200);
      break;
    case "win": {
      coinStreak = 0;
      // A little major arpeggio: the only melodic moment in the game.
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => blip("triangle", f, f, 0.34, 0.2, i * 0.09));
      break;
    }
    case "stomp": {
      // Short, low and wet. Deliberately unlike the coin so a stomp never
      // reads as a pickup.
      blip("square", 240, 90, 0.12, 0.26);
      noise(0.09, 0.16, 420);
      break;
    }
    case "tunnel": {
      // A downward slide: the sound of going somewhere else.
      blip("sine", 700, 160, 0.42, 0.24);
      blip("triangle", 350, 80, 0.46, 0.16, 0.04);
      break;
    }
    case "ui":
      blip("sine", 660, 880, 0.05, 0.1);
      break;
  }
}
