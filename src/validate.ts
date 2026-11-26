import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./lib/csv.js";
import { log } from "./lib/log.js";
import { flagsOf, isExcluded, scoresOf } from "./judge/quality.js";
import { X_TOP_N } from "./buzz/collect-buzz.js";

/** Minimum row counts per raw file. Tripping these means a source silently degraded. */
const RAW_MIN_ROWS: Record<string, number> = {
  "skills-sh": 1100, // three views × ~600; two views (one lost after retries) still ship
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

/**
 * Most entities the judge excludes from rankings are placeholders and deprecated listings —
 * a fraction of a percent. A share above this means a model or prompt regression, and
 * publishing would silently gut the rankings.
 */
const MAX_EXCLUDED_SHARE = 0.05;

/** Allowed day-over-day row count drift for raw files whose size is not fixed by construction. */
const DRIFT_CHECKED = new Set(["github-repos", "clawhub-official", "buzz"]);
const MAX_ROW_DRIFT = 0.3;
/**
 * Drift above this but within MAX_ROW_DRIFT still ships, with a warning. A shrink
 * just under the hard limit otherwise passes in silence, and the day the source
 * recovers is the first anyone hears of it.
 */
const WARN_ROW_DRIFT = 0.15;
/**
 * A rise past MAX_ROW_DRIFT is accepted (as a warning) when the new count is back
 * within this tolerance of a size published in the last RESTORE_LOOKBACK_DAYS:
 * the source returned to a level that already passed the gate. Only rises — a
 * drop to an earlier low is just as likely a fresh collection failure.
 */
const RESTORE_LOOKBACK_DAYS = 14;
const RESTORE_TOLERANCE = 0.05;

/** X coverage: below these the X columns ship, but the run reports degraded X data. */
const X_MIN_MEASURED_SHARE = 0.5;
const X_VOLUME_LOOKBACK_DAYS = 7;
const X_MIN_VOLUME_SHARE = 0.5;

function daysBefore(date: string, n: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** X targets carry x_pages only when their search succeeded; failed ones stay blank. */
function xStats(rows: Record<string, string>[]): { measured: number; volume: number } {
  const measured = rows.filter((r) => (r["x_pages"] ?? "") !== "");
  return { measured: measured.length, volume: measured.reduce((n, r) => n + (Number(r["x_raw_7d"]) || 0), 0) };
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export interface ValidateOptions {
  /**
   * Raw files whose day-over-day drift is accepted for this run (a confirmed
   * upstream change, e.g. a registry delisting a publisher). Reported as a
   * warning instead of an error so the run stays auditable in the log.
   */
  allowDrift?: ReadonlySet<string>;
}

function isNonNegNumber(s: string): boolean {
  if (s === "") return true;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0;
}

export function validate(dataDir: string, date: string, opts: ValidateOptions = {}): ValidationResult {
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
  // judgments is optional: without an LLM key the judge step still writes carried-forward rows,
  // but a --rank-only run over old data has none.
  expectDir("raw", new Set([...Object.keys(RAW_MIN_ROWS), "x-posts", "judgments"]));

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
      const prevDate = daysBefore(date, 1);
      const prevPath = join(dataDir, prevDate, "raw", `${name}.csv`);
      if (existsSync(prevPath)) {
        const prevRows = readCsv(prevPath).length;
        if (prevRows > 0) {
          const drift = Math.abs(rows.length - prevRows) / prevRows;
          const msg = `raw/${name}.csv row count drifted ${(drift * 100).toFixed(1)}% vs ${prevDate} (${prevRows} → ${rows.length})`;
          if (drift > MAX_ROW_DRIFT) {
            let restoredFrom: string | undefined;
            for (let n = 2; n <= RESTORE_LOOKBACK_DAYS && !restoredFrom && rows.length > prevRows; n++) {
              const d = daysBefore(date, n);
              const p = join(dataDir, d, "raw", `${name}.csv`);
              if (!existsSync(p)) continue;
              const earlier = readCsv(p).length;
              if (earlier > 0 && Math.abs(rows.length - earlier) / earlier <= RESTORE_TOLERANCE) restoredFrom = `${d} (${earlier})`;
            }
            if (opts.allowDrift?.has(name)) warnings.push(`${msg} — accepted via --allow-drift`);
            else if (restoredFrom) warnings.push(`${msg} — accepted: back to the size published on ${restoredFrom}`);
            else errors.push(msg);
          } else if (drift > WARN_ROW_DRIFT) {
            warnings.push(`${msg} — under the ${MAX_ROW_DRIFT * 100}% limit, check the source`);
          }
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

    // One platform failing outright still passes the check above, so X gets its own.
    const x = xStats(rows);
    if (x.measured < X_TOP_N * X_MIN_MEASURED_SHARE) {
      warnings.push(`buzz.csv: X measured for only ${x.measured}/${X_TOP_N} targets — X columns degraded`);
    } else if (x.volume === 0) {
      // Checked on its own: days like this would otherwise drag the baseline down to 0.
      warnings.push(`buzz.csv: X found 0 in-window posts across ${x.measured} targets — provider degraded?`);
    } else {
      const history: number[] = [];
      for (let n = 1; n <= X_VOLUME_LOOKBACK_DAYS; n++) {
        const p = join(dataDir, daysBefore(date, n), "raw", "buzz.csv");
        if (!existsSync(p)) continue;
        const h = xStats(readCsv(p));
        if (h.measured >= X_TOP_N * X_MIN_MEASURED_SHARE && h.volume > 0) history.push(h.volume);
      }
      if (history.length > 0) {
        const base = median(history);
        if (base > 0 && x.volume < base * X_MIN_VOLUME_SHARE) {
          warnings.push(
            `buzz.csv: X found ${x.volume} in-window posts, ${Math.round((x.volume / base) * 100)}% of the ${history.length}-day median (${base}) — provider degraded?`,
          );
        }
      }
    }
  }

  const judgmentsPath = join(dayDir, "raw", "judgments.csv");
  if (existsSync(judgmentsPath)) {
    const rows = readCsv(judgmentsPath);
    // Same derivation as the ranking step, so the gate measures exactly what rankings drop.
    const excluded = rows.filter((r) => isExcluded(flagsOf(scoresOf(r))));
    if (rows.length > 0 && excluded.length / rows.length > MAX_EXCLUDED_SHARE) {
      errors.push(
        `judgments.csv: ${excluded.length}/${rows.length} entities excluded from rankings (> ${MAX_EXCLUDED_SHARE * 100}%) — judge regression?`,
      );
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
