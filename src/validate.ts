import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./lib/csv.js";
import { log } from "./lib/log.js";

/** Minimum row counts per raw file. Tripping these means a source silently degraded. */
const RAW_MIN_ROWS: Record<string, number> = {
  "skills-sh": 1500,
  "skills-sh-official": 50,
  clawhub: 900,
  "clawhub-official": 500,
  skillhub: 900,
  "skillhub-enterprise": 500,
  "github-repos": 2000,
  buzz: 50,
};

/** Rankings that must exist; min rows (some lists legitimately run short early on). */
const RANKING_MIN_ROWS: Record<string, number> = {
  "best-100": 50,
  "top-installs": 50,
  "trending-7d": 50,
  "social-buzz": 5,
  "most-active": 20,
  "official-100": 20,
  "official-vendors": 20,
  "top-repos": 50,
  "rising-stars": 0,
};

/** Primary sort column per ranking — every list must be monotonically non-increasing on it. */
const RANKING_SORT_COL: Record<string, string | null> = {
  "best-100": "wis",
  "top-installs": "pop_score",
  "trending-7d": null, // ordered by upstream trending rank, ascending
  "social-buzz": "buzz_score",
  "most-active": "freshness_score",
  "official-100": "pop_score",
  "official-vendors": null, // grouped by platform, sorted within groups
  "top-repos": "stars",
  "rising-stars": "pop_score",
};

/** Allowed day-over-day row count drift for raw files whose size is not fixed by construction. */
const DRIFT_CHECKED = new Set(["github-repos", "clawhub-official", "buzz"]);
const MAX_ROW_DRIFT = 0.3;

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

function isNonNegNumber(s: string): boolean {
  if (s === "") return true;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0;
}

export function validate(dataDir: string, date: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dayDir = join(dataDir, date);

  // --- directory closure: no unexpected files may ship (audit M1 — a withdrawn
  // ranking survived every per-file check because nothing enumerated the directory) ---
  const expectDir = (subdir: string, expected: Set<string>): void => {
    const dir = join(dayDir, subdir);
    if (!existsSync(dir)) return; // missing files are reported per-file below
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".csv") && !expected.has(f.replace(/\.csv$/, ""))) {
        errors.push(`${subdir}/${f} is not a known output — stale file from an older pipeline?`);
      }
    }
  };
  expectDir("rankings", new Set(Object.keys(RANKING_MIN_ROWS)));
  expectDir("raw", new Set([...Object.keys(RAW_MIN_ROWS), "x-posts"]));

  // --- raw files ---
  for (const [name, minRows] of Object.entries(RAW_MIN_ROWS)) {
    const p = join(dayDir, "raw", `${name}.csv`);
    if (!existsSync(p)) {
      errors.push(`raw/${name}.csv missing`);
      continue;
    }
    const rows = readCsv(p);
    if (rows.length < minRows) errors.push(`raw/${name}.csv has ${rows.length} rows (< ${minRows})`);

    const numericCols = ["installs", "downloads", "stars", "total_installs", "hn_hits_7d", "x_mentions_7d"];
    for (const col of numericCols) {
      if (rows[0] && col in rows[0]) {
        const bad = rows.filter((r) => !isNonNegNumber(r[col] ?? ""));
        if (bad.length > 0) errors.push(`raw/${name}.csv: ${bad.length} rows with invalid ${col}`);
      }
    }

    if (DRIFT_CHECKED.has(name)) {
      const prevDate = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
      const prevPath = join(dataDir, prevDate, "raw", `${name}.csv`);
      if (existsSync(prevPath)) {
        const prevRows = readCsv(prevPath).length;
        if (prevRows > 0) {
          const drift = Math.abs(rows.length - prevRows) / prevRows;
          if (drift > MAX_ROW_DRIFT) errors.push(`raw/${name}.csv row count drifted ${(drift * 100).toFixed(0)}% vs ${prevDate} (${prevRows} → ${rows.length})`);
        }
      }
    }
  }

  // anchor: the all-time #1 must be a mega-hit (catches parser picking up a wrong array)
  const ssPath = join(dayDir, "raw", "skills-sh.csv");
  if (existsSync(ssPath)) {
    const top = readCsv(ssPath).find((r) => r["view"] === "all-time" && r["rank"] === "1");
    if (!top) errors.push("skills-sh: no all-time rank 1 row");
    else if (Number(top["installs"]) < 1_000_000) errors.push(`skills-sh: all-time #1 has ${top["installs"]} installs (< 1M — parser suspect)`);
  }

  // buzz must contain real measurements, not just pre-filled empty rows (audit B9)
  const buzzPath = join(dayDir, "raw", "buzz.csv");
  if (existsSync(buzzPath)) {
    const rows = readCsv(buzzPath);
    const measured = rows.filter((r) =>
      ["hn_hits_7d", "bsky_hits_7d", "gh_mentions_7d", "x_mentions_7d"].some((c) => (r[c] ?? "") !== ""),
    );
    if (rows.length > 0 && measured.length / rows.length < 0.5) {
      errors.push(`buzz.csv: only ${measured.length}/${rows.length} rows have any platform measurement — collection likely failed`);
    }
  }

  // --- rankings ---
  for (const [name, minRows] of Object.entries(RANKING_MIN_ROWS)) {
    const p = join(dayDir, "rankings", `${name}.csv`);
    if (!existsSync(p)) {
      errors.push(`rankings/${name}.csv missing`);
      continue;
    }
    const rows = readCsv(p);
    if (rows.length < minRows) errors.push(`rankings/${name}.csv has ${rows.length} rows (< ${minRows})`);

    const badRank = rows.some((r, i) => Number(r["rank"]) !== i + 1);
    if (badRank) errors.push(`rankings/${name}.csv: rank column is not 1..n`);

    const scoreCol = RANKING_SORT_COL[name];
    if (scoreCol && rows[0] && scoreCol in rows[0]) {
      for (let i = 1; i < rows.length; i++) {
        const prev = Number(rows[i - 1]?.[scoreCol]);
        const cur = Number(rows[i]?.[scoreCol]);
        if (Number.isFinite(prev) && Number.isFinite(cur) && cur > prev + 1e-9) {
          errors.push(`rankings/${name}.csv: ${scoreCol} not sorted at rank ${i + 1}`);
          break;
        }
      }
    }
    if (name === "best-100") {
      const bad = rows.filter((r) => Number(r["wis"]) < 0 || Number(r["wis"]) > 100);
      if (bad.length > 0) errors.push(`best-100: ${bad.length} rows with WIS outside [0,100]`);
    }
    if (name === "top-repos") {
      const repos = rows.map((r) => (r["repo"] ?? "").toLowerCase());
      if (new Set(repos).size !== repos.length) errors.push("top-repos: duplicate repositories");
    }
    if (name === "social-buzz") {
      const truncated = rows.filter((r) => r["x_truncated"] === "true").length;
      if (rows.length >= 10 && truncated / rows.length > 0.3) {
        warnings.push(`social-buzz: ${truncated}/${rows.length} rows still X-truncated at page cap`);
      }
    }
  }

  return { errors, warnings };
}

export function reportAndExit(result: ValidationResult): void {
  for (const w of result.warnings) log.warn("validate", w);
  for (const e of result.errors) log.error("validate", e);
  if (result.errors.length > 0) {
    log.error("validate", `FAILED with ${result.errors.length} error(s) — data NOT pushed`);
    process.exit(1);
  }
  log.info("validate", "all checks passed");
}
