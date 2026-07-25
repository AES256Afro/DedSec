/**
 * Deterministic pseudo-random generation.
 *
 * Every stochastic decision in the simulation flows through an Rng that was
 * derived from the world seed. Two runs with the same seed and the same player
 * inputs produce byte-identical world state, which is what makes the forensic
 * "ghost score" reproducible and makes the test-suite meaningful.
 */

const UINT32 = 0x100000000;

/** Fast, well-distributed 32-bit hash used to derive child streams from labels. */
export function hashString(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number | string) {
    const numeric = typeof seed === "string" ? hashString(seed) : seed >>> 0;
    // Avoid the degenerate all-zero state.
    this.state = (numeric || 0x9e3779b9) >>> 0;
  }

  /** Raw 32-bit step (mulberry32). */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / UINT32;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform pick. Throws on an empty list so generator bugs surface loudly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick called with an empty list");
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Weighted pick. Weights need not be normalised; non-positive weights are skipped. */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    let total = 0;
    for (const item of items) {
      const w = weightOf(item);
      if (w > 0) total += w;
    }
    if (total <= 0) return this.pick(items);
    let roll = this.next() * total;
    for (const item of items) {
      const w = weightOf(item);
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) return item;
    }
    return items[items.length - 1]!;
  }

  /** Pick `count` distinct entries (or fewer if the pool is smaller). */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    this.shuffle(pool);
    return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
  }

  /** In-place Fisher-Yates. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  /** Roughly normal via the mean of four uniforms, clamped to [min, max]. */
  bell(min: number, max: number): number {
    const s = (this.next() + this.next() + this.next() + this.next()) / 4;
    return min + s * (max - min);
  }

  /** A child stream keyed by a label — lets subsystems draw independently. */
  fork(label: string): Rng {
    return new Rng(hashString(label, this.nextUint32()));
  }
}
