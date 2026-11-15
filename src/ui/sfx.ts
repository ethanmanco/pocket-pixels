// Chiptune sound effects synthesized with Web Audio: square and triangle
// waves plus a little noise. No audio files.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let noiseBuffer: AudioBuffer | null = null;

export function setMuted(value: boolean): void {
  muted = value;
  if (master) master.gain.value = muted ? 0 : 0.5;
}

export function isMuted(): boolean {
  return muted;
}

/** Browsers only allow audio after a tap; call this from the first one. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

function ready(): AudioContext | null {
  if (muted || !ctx || !master || ctx.state !== "running") return null;
  return ctx;
}

function tone(
  freq: number,
  at: number,
  dur: number,
  opts: { type?: OscillatorType; vol?: number; to?: number } = {},
): void {
  const c = ready();
  if (!c) return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = opts.type ?? "square";
  osc.frequency.setValueAtTime(freq, t);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
  const vol = opts.vol ?? 0.12;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(master!);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(at: number, dur: number, vol: number, highpass: number): void {
  const c = ready();
  if (!c) return;
  if (!noiseBuffer) {
    noiseBuffer = c.createBuffer(1, c.sampleRate * 0.3, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = c.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = highpass;
  const gain = c.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter).connect(gain).connect(master!);
  src.start(t);
  src.stop(t + dur + 0.02);
}

export const sfx = {
  /** A card sliding across the felt. */
  deal(at = 0): void {
    noise(at, 0.06, 0.25, 3000);
    tone(1400, at, 0.03, { vol: 0.03 });
  },
  /** A card turning over. */
  flip(at = 0): void {
    noise(at, 0.04, 0.2, 2000);
    tone(700, at + 0.01, 0.05, { type: "triangle", vol: 0.1, to: 1100 });
  },
  /** Chips hitting the table. */
  chips(): void {
    tone(1800, 0, 0.04, { vol: 0.06 });
    tone(2400, 0.05, 0.04, { vol: 0.05 });
    noise(0, 0.05, 0.12, 5000);
  },
  /** Two knocks on the table. */
  check(): void {
    tone(180, 0, 0.06, { type: "triangle", vol: 0.25 });
    tone(180, 0.1, 0.06, { type: "triangle", vol: 0.25 });
  },
  fold(): void {
    tone(440, 0, 0.14, { type: "triangle", vol: 0.12, to: 180 });
  },
  allIn(): void {
    tone(262, 0, 0.3, { vol: 0.08, to: 1046 });
    tone(392, 0.05, 0.3, { vol: 0.05, to: 1568 });
  },
  /** It's your turn. */
  turn(): void {
    tone(988, 0, 0.08, { vol: 0.07 });
    tone(1319, 0.09, 0.12, { vol: 0.07 });
  },
  /** The pot sliding to the winner. */
  potSlide(): void {
    for (let i = 0; i < 4; i++) tone(1600 + i * 200, i * 0.05, 0.04, { vol: 0.04 });
  },
  /** You won the pot. */
  win(): void {
    const notes = [523, 659, 784, 1047, 784, 1047];
    notes.forEach((f, i) => tone(f, i * 0.08, i === notes.length - 1 ? 0.3 : 0.09, { vol: 0.09 }));
  },
};
