import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "../lib/csv.js";

/** Rank changes compare against the same list this many days earlier. */
export const RANK_CHANGE_DAYS = 7;

/**
 * Ranks of a list published `RANK_CHANGE_DAYS` before `date`, by row identity, or
 * undefined when there is nothing comparable: no file that day, or (for folded lists)
 * a file from before folding, whose ranks would make every row look like it moved.
 */
export function previousRanks(
  dataDir: string,
  date: string,
  name: string,
  identities: (row: Record<string, string>) => string[],
  requireColumn?: string,
): Map<string, number> | undefined {
  const prevDate = new Date(Date.parse(`${date}T00:00:00Z`) - RANK_CHANGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const p = join(dataDir, prevDate, "rankings", `${name}.csv`);
  if (!existsSync(p)) return undefined;
  const rows = readCsv(p);
  if (requireColumn && rows[0] && !(requireColumn in rows[0])) return undefined;
  const ranks = new Map<string, number>();
  for (const r of rows) {
    const rank = Number(r["rank"]);
    if (!Number.isFinite(rank)) continue;
    for (const id of identities(r)) if (id && !ranks.has(id)) ranks.set(id, rank);
  }
  return ranks;
}

/**
 * `+3` (moved up three places), `-5`, `0`, `new` (not on the list then), or "" when
 * there is no comparable list. Any of a row's identities may match: a folded bundle
 * is the same row even when a different member leads it this week.
 */
export function rankChange(rank: number, ids: string[], prev: Map<string, number> | undefined): string {
  if (!prev) return "";
  let before: number | undefined;
  for (const id of ids) {
    const r = prev.get(id);
    if (r !== undefined && (before === undefined || r < before)) before = r;
  }
  if (before === undefined) return "new";
  const delta = before - rank;
  return delta > 0 ? `+${delta}` : String(delta);
}
