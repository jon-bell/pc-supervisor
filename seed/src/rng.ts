// Deterministic pseudo-random numbers (mulberry32) so generated scenarios and
// filler text are identical on every run.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash: a stable seed from a string. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rngFor(s: string): Rng {
  return mulberry32(hashSeed(s));
}

/** Integer in [lo, hi]. */
export function intBetween(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, xs: readonly T[]): T {
  if (xs.length === 0) throw new Error("pick from empty list");
  return xs[Math.floor(rng() * xs.length)]!;
}

/** Fisher-Yates shuffle into a new array. */
export function shuffled<T>(rng: Rng, xs: readonly T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Weighted choice: weights need not sum to 1. */
export function weighted<T>(rng: Rng, choices: readonly (readonly [T, number])[]): T {
  const total = choices.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of choices) {
    r -= w;
    if (r < 0) return v;
  }
  return choices[choices.length - 1]![0];
}
