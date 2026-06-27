// Lightweight Web Audio cues for paper-trading events. No audio assets
// shipped — all tones are synthesised on the fly. Disabled by default;
// toggle via localStorage key "qti.paper.sound".

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return ctx;
}

export function paperSoundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("qti.paper.sound") === "1";
}

export function setPaperSoundEnabled(v: boolean) {
  localStorage.setItem("qti.paper.sound", v ? "1" : "0");
}

function blip(freq: number, durMs: number, type: OscillatorType = "sine", gain = 0.05) {
  if (!paperSoundEnabled()) return;
  const c = ensureCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g);
  g.connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + durMs / 1000);
}

export const paperSounds = {
  placed: () => blip(620, 60, "triangle", 0.04),
  filled: () => {
    blip(720, 80, "sine", 0.06);
    setTimeout(() => blip(960, 90, "sine", 0.06), 90);
  },
  slHit: () => blip(220, 220, "sawtooth", 0.07),
  tpHit: () => {
    blip(700, 90, "sine", 0.05);
    setTimeout(() => blip(880, 90, "sine", 0.05), 100);
    setTimeout(() => blip(1100, 110, "sine", 0.05), 200);
  },
  warn: () => blip(440, 200, "square", 0.04),
  /** Pattern detection cue — a two-tone chirp, brighter than 'placed' so it's
   *  distinguishable from order-side audio when both fire in quick succession. */
  pattern: () => {
    blip(820, 70, "sine", 0.05);
    setTimeout(() => blip(1040, 80, "sine", 0.05), 90);
  },
};
