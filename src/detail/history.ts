import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "../lib/csv.js";

/**
 * Per-skill daily history for detail pages: the platform's cumulative count and the
 * Best 100 rank on each day the data repo has a folder for.
 *
 * The cumulative count is the platform's own lifetime number: skills.sh all-time
 * installs, ClawHub downloads, SkillHub downloads. Weekly figures on the page are
 * differences of these snapshots, so every platform uses one definition.
 */

export interface DayPoint {
  date: string;
  /** Cumulative installs (skills.sh) or downloads (ClawHub, SkillHub); undefined when not listed that day. */
  total?: number;
  /** Best 100 rank; undefined when not in the list that day. */
  rank?: number;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Entity key of a ranking row. Older Best 100 files have no `skill_key` column, so the
 * key is rebuilt from the platform columns the same way entity.ts builds it.
 */
export function rowKey(r: Record<string, string>): string | undefined {
  if (r["skill_key"]) return r["skill_key"];
  const name = (r["skill"] ?? "").trim();
  if (!name) return undefined;
  switch (r["platform"]) {
    case "skills.sh":
      return `ss:${(r["source_skillssh"] ?? "").trim()}/${name}`.toLowerCase();
    case "clawhub":
      return `ch:${(r["slug_clawhub"] || name).trim()}`.toLowerCase();
    case "skillhub-cn":
      return `sh:${name}`.toLowerCase();
    default:
      return undefined;
  }
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** Reads every dated folder up to `date` and returns the history of the requested keys. */
export function loadHistory(dataDir: string, keys: ReadonlySet<string>, date: string): Map<string, DayPoint[]> {
  const out = new Map<string, DayPoint[]>();
  for (const k of keys) out.set(k, []);
  const days = existsSync(dataDir)
    ? readdirSync(dataDir)
        .filter((d) => DATE_DIR.test(d) && d <= date)
        .sort()
    : [];
  for (const day of days) {
    const totals = new Map<string, number>();
    const raw = (file: string) => {
      const p = join(dataDir, day, "raw", `${file}.csv`);
      return existsSync(p) ? readCsv(p) : [];
    };
    for (const r of raw("skills-sh")) {
      if (r["view"] !== "all-time") continue;
      const key = `ss:${(r["source"] ?? "").trim()}/${(r["name"] ?? "").trim()}`.toLowerCase();
      const n = num(r["installs"]);
      if (keys.has(key) && n !== undefined) totals.set(key, n);
    }
    for (const r of raw("clawhub")) {
      const key = `ch:${(r["slug"] ?? "").trim()}`.toLowerCase();
      const n = num(r["downloads"]);
      if (keys.has(key) && n !== undefined) totals.set(key, n);
    }
    for (const r of raw("skillhub")) {
      const key = `sh:${(r["slug"] ?? "").trim()}`.toLowerCase();
      const n = num(r["downloads"]);
      // A slug can appear in both the community and enterprise feeds; keep the larger.
      if (keys.has(key) && n !== undefined && n > (totals.get(key) ?? -1)) totals.set(key, n);
    }
    const ranks = new Map<string, number>();
    const best = join(dataDir, day, "rankings", "best-100.csv");
    if (existsSync(best)) {
      for (const r of readCsv(best)) {
        const key = rowKey(r);
        const rank = num(r["rank"]);
        if (key && keys.has(key) && rank !== undefined) ranks.set(key, rank);
      }
    }
    for (const [key, series] of out) {
      const total = totals.get(key);
      const rank = ranks.get(key);
      if (total === undefined && rank === undefined) continue;
      series.push({ date: day, ...(total !== undefined && { total }), ...(rank !== undefined && { rank }) });
    }
  }
  return out;
}
