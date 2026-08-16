/** Percentile helpers: all cross-platform composites work on within-platform percentiles. */

/**
 * Neutral prior used when a dimension was not measured for an entity.
 * Filling (instead of re-normalizing weights) prevents single-platform entities
 * from being silently rewarded and multi-platform ones from being penalized (audit B2/B3/B4).
 */
export const NEUTRAL = 0.3;

/**
 * Build a percentile lookup (log1p + mid-rank for ties).
 * Zero maps to exactly 0 — "no signal" must not inherit the percentile mass of
 * the zero-tie block (audit B6: 82% zeros previously scored 0.82).
 */
export function percentiler(values: Array<number | undefined>): (v: number | undefined) => number | undefined {
  const pop = values.filter((v): v is number => v !== undefined && Number.isFinite(v)).map((v) => Math.log1p(v));
  pop.sort((a, b) => a - b);
  if (pop.length < 2) return () => undefined;
  return (v) => {
    if (v === undefined || !Number.isFinite(v)) return undefined;
    if (v === 0) return 0;
    const x = Math.log1p(v);
    const upper = upperBound(pop, x);
    const lower = lowerBound(pop, x);
    // mid-rank of the tie block
    return (lower + upper) / 2 / pop.length;
  };
}

function upperBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Weighted mean over available dimensions; weights re-normalized to what's present.
 * Use ONLY where re-normalization is the intended semantic (popularity = install
 * percentile within the platforms where the skill exists). Signal composites like
 * buzz must fill missing channels with NEUTRAL instead — re-normalizing there made
 * unmeasured channels outrank measured zeros (audit M2).
 */
export function weightedMean(parts: Array<[value: number | undefined, weight: number]>): number | undefined {
  let sum = 0;
  let wsum = 0;
  for (const [v, w] of parts) {
    if (v !== undefined) {
      sum += v * w;
      wsum += w;
    }
  }
  return wsum > 0 ? sum / wsum : undefined;
}

/**
 * Exponential recency: 1.0 today → ~0.37 at halfLifeDays.
 * `refMs` is the reference instant — pass the DATA DATE, never Date.now(), so that
 * anyone can reproduce published scores from the CSVs alone (audit SC-16).
 */
export function recency(dateStr: string | undefined, halfLifeDays: number, refMs: number): number | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return undefined;
  const age = Math.max(0, (refMs - d.getTime()) / 86_400_000);
  return Math.exp(-age / halfLifeDays);
}

export function round3(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 1000) / 1000;
}
