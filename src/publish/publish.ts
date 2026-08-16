import { execSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { env, REPO_ROOT } from "../lib/env.js";
import { writeCsv } from "../lib/csv.js";
import { log } from "../lib/log.js";
import type { RawTable } from "../sources/types.js";

export function dataRepoPath(): string {
  const p = env("BEST_SKILLS_REPO_PATH") ?? "../best-skills";
  const abs = resolve(REPO_ROOT, p);
  if (!existsSync(join(abs, ".git"))) {
    throw new Error(`BEST_SKILLS_REPO_PATH does not point to a git repo: ${abs}`);
  }
  return abs;
}

function writeTables(subdir: "raw" | "rankings", date: string, tables: RawTable[]): void {
  const dayDir = join(dataRepoPath(), "data", date);
  for (const t of tables) {
    writeCsv(join(dayDir, subdir, `${t.name}.csv`), t.columns, t.rows);
    log.info("publish", `wrote ${subdir}/${t.name}.csv (${t.rows.length} rows)`);
  }
}

export function writeRaw(date: string, tables: RawTable[]): void {
  writeTables("raw", date, tables);
}

export function writeRankings(date: string, tables: RawTable[]): void {
  writeTables("rankings", date, tables);
  // Delete ranking files this pipeline no longer produces — write-only publishing let a
  // withdrawn list (most-positive.csv) linger and ship for a full day (audit M1).
  const dir = join(dataRepoPath(), "data", date, "rankings");
  const expected = new Set(tables.map((t) => `${t.name}.csv`));
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".csv") && !expected.has(f)) {
      rmSync(join(dir, f));
      log.warn("publish", `removed stale rankings/${f}`);
    }
  }
}

/** Mirror today's folder to data/latest/ for stable URLs. */
export function refreshLatest(date: string): void {
  const repo = dataRepoPath();
  const dayDir = join(repo, "data", date);
  const latest = join(repo, "data", "latest");
  rmSync(latest, { recursive: true, force: true });
  cpSync(dayDir, latest, { recursive: true });
}

export function commitAndPush(date: string): void {
  const repo = dataRepoPath();
  const run = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  // Commit local changes FIRST — `pull --rebase` refuses to run over unstaged changes.
  run("git add data README.md");
  const status = run("git status --porcelain data README.md");
  if (!status.trim()) {
    log.info("publish", "no data changes to commit");
    return;
  }
  run(`git commit --quiet -m "data: ${date}"`);
  run("git pull --rebase --quiet");
  run("git push --quiet");
  log.info("publish", `pushed data for ${date}`);
}
