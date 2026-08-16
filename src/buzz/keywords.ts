import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "../lib/csv.js";
import type { RawTable } from "../sources/types.js";

export interface BuzzTarget {
  /** Trimmed lowercase skill name — the search identity (buzz is searched by name). */
  key: string;
  /** Exact-phrase query for HN / Bluesky search. */
  phrase: string;
  /** Query with context words, used on X where noise is highest. */
  xQuery: string;
  /** Short description passed to the LLM relevance filter. */
  desc?: string;
  generic: boolean;
}

/**
 * A name is "generic" when it has no hyphen — single English words (prototype, grilling,
 * teach…) produce massive false positives when searched bare on any platform.
 */
function isGeneric(name: string): boolean {
  return !name.includes("-");
}

interface NameCandidate {
  name: string;
  desc?: string;
}

/**
 * Build buzz search targets by interleaving top skills.sh and top ClawHub names —
 * appending one list after the other starved ClawHub of any buzz coverage (audit B7).
 */
export function buildTargets(tables: RawTable[], limit: number): BuzzTarget[] {
  const ss: NameCandidate[] = [];
  const skillsSh = tables.find((t) => t.name === "skills-sh");
  for (const row of skillsSh?.rows ?? []) {
    if (row["view"] === "all-time") ss.push({ name: String(row["name"] ?? "") });
  }
  const ch: NameCandidate[] = [];
  const clawhub = tables.find((t) => t.name === "clawhub");
  for (const row of clawhub?.rows ?? []) {
    ch.push({ name: String(row["slug"] ?? ""), desc: row["summary"] ? String(row["summary"]) : undefined });
  }

  const seen = new Set<string>();
  const targets: BuzzTarget[] = [];
  const push = (c: NameCandidate): void => {
    const name = c.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || targets.length >= limit) return;
    seen.add(key);
    const generic = isGeneric(name);
    targets.push({
      key,
      phrase: generic ? `"${name}" skill` : `"${name}"`,
      xQuery: `"${name}" (claude OR skill OR agent OR openclaw)`,
      desc: c.desc,
      generic,
    });
  };
  for (let i = 0; targets.length < limit && (i < ss.length || i < ch.length); i++) {
    if (i < ss.length) push(ss[i]!);
    if (i < ch.length) push(ch[i]!);
  }
  return targets;
}

/** Same as buildTargets, but reads today's already-written raw CSVs (for --only=buzz runs). */
export function buildTargetsFromRaw(rawDir: string, limit: number): BuzzTarget[] {
  const tables: RawTable[] = [];
  for (const name of ["skills-sh", "clawhub"]) {
    const p = join(rawDir, `${name}.csv`);
    if (existsSync(p)) tables.push({ name, columns: [], rows: readCsv(p) });
  }
  return buildTargets(tables, limit);
}
