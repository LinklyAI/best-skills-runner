import type { DayPoint } from "./history.js";

/**
 * Numbers a detail page shows, all derived from the daily history by fixed rules so
 * every page reads the same way. Nothing here is written by a model.
 */

export type TrendShape = "accelerating" | "steady" | "slowing" | "stalled" | "new";

export interface SkillStats {
  /** Latest cumulative count. */
  total?: number;
  /** Growth over the last 7 days and the 7 days before that. */
  week?: number;
  prevWeek?: number;
  /** Average daily growth over the last 30 days and the 30 days before that. */
  avg30?: number;
  avgPrev30?: number;
  shape: TrendShape;
  /** Best 100 rank today and 7 days ago. */
  rank?: number;
  rank7d?: number;
  /** Days in Best 100 out of the days the skill appears in the data. */
  best100Days: number;
  days: number;
}

/** History shorter than this has no 30-day comparison and reads as new. */
const MIN_DAYS_FOR_TREND = 60;
/** Ratio of the last 30 days' growth to the 30 days before that. */
const ACCELERATING = 1.25;
const STEADY = 0.8;
const SLOWING = 0.2;
/** A missing day (a skipped run) is bridged by the nearest earlier day within this many days. */
const MAX_GAP = 2;

export function daysBefore(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

function pointAt(series: readonly DayPoint[], date: string): DayPoint | undefined {
  const floor = daysBefore(date, MAX_GAP);
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i]!;
    if (p.date > date) continue;
    return p.date >= floor ? p : undefined;
  }
  return undefined;
}

function growth(series: readonly DayPoint[], end: string, days: number): number | undefined {
  const a = pointAt(series, end)?.total;
  const b = pointAt(series, daysBefore(end, days))?.total;
  return a !== undefined && b !== undefined ? a - b : undefined;
}

export function trendShape(avg30: number | undefined, avgPrev30: number | undefined): TrendShape {
  if (avg30 === undefined || avgPrev30 === undefined || avgPrev30 <= 0) return "new";
  const r = avg30 / avgPrev30;
  if (r >= ACCELERATING) return "accelerating";
  if (r >= STEADY) return "steady";
  if (r >= SLOWING) return "slowing";
  return "stalled";
}

export function computeStats(series: readonly DayPoint[], date: string): SkillStats {
  const today = pointAt(series, date);
  const withTotal = series.filter((p) => p.total !== undefined);
  const span = withTotal.length > 0 ? (Date.parse(date) - Date.parse(withTotal[0]!.date)) / 86_400_000 + 1 : 0;
  const g30 = growth(series, date, 30);
  const gPrev30 = span >= MIN_DAYS_FOR_TREND ? growth(series, daysBefore(date, 30), 30) : undefined;
  const avg30 = g30 !== undefined ? g30 / 30 : undefined;
  const avgPrev30 = gPrev30 !== undefined ? gPrev30 / 30 : undefined;
  return {
    total: today?.total,
    week: growth(series, date, 7),
    prevWeek: growth(series, daysBefore(date, 7), 7),
    avg30: avg30 !== undefined ? Math.round(avg30) : undefined,
    avgPrev30: avgPrev30 !== undefined ? Math.round(avgPrev30) : undefined,
    shape: trendShape(avg30, avgPrev30),
    rank: series.at(-1)?.date === date ? series.at(-1)?.rank : undefined,
    rank7d: series.find((p) => p.date === daysBefore(date, 7))?.rank,
    best100Days: series.filter((p) => p.rank !== undefined).length,
    days: series.length,
  };
}
