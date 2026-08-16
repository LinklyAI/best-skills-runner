import { join } from "node:path";
import { skillsSh } from "./sources/skills-sh.js";
import { clawhub } from "./sources/clawhub.js";
import { skillhub } from "./sources/skillhub.js";
import { githubSource } from "./sources/github.js";
import { buildTargets, buildTargetsFromRaw } from "./buzz/keywords.js";
import { collectBuzz } from "./buzz/collect-buzz.js";
import { computeRankings } from "./rank/rankings.js";
import { writeRaw, writeRankings, refreshLatest, commitAndPush, dataRepoPath } from "./publish/publish.js";
import { renderReadme } from "./publish/readme.js";
import { validate, reportAndExit } from "./validate.js";
import { log } from "./lib/log.js";
import type { RawTable } from "./sources/types.js";

const noPush = process.argv.includes("--no-push");
/** Recompute rankings + README from already-collected raw data (no network). */
const rankOnly = process.argv.includes("--rank-only");
/** --only=skills-sh,clawhub,skillhub,github,buzz — run a subset of collectors for debugging. */
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
const want = (id: string): boolean => only === null || only.has(id);
const BUZZ_TOP_N = 100;

/** --date=YYYY-MM-DD — operate on a specific day (e.g. re-rank yesterday after a pipeline fix). */
const dateArg = process.argv.find((a) => a.startsWith("--date="))?.slice("--date=".length);
if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  log.error("main", `invalid --date=${dateArg} (expected YYYY-MM-DD)`);
  process.exit(1);
}
const date = dateArg ?? new Date().toISOString().slice(0, 10); // UTC

async function collectAll(rawDir: string): Promise<{ tables: RawTable[]; failures: string[] }> {
  const tables: RawTable[] = [];
  const failures: string[] = [];

  for (const collector of [skillsSh, clawhub, skillhub].filter((c) => want(c.id))) {
    try {
      tables.push(...(await collector.collect()));
    } catch (err) {
      failures.push(`${collector.id}: ${String(err)}`);
      log.error(collector.id, String(err));
    }
  }

  // GitHub star snapshot: seed list + repos discovered in today's skills.sh data
  if (want("github")) {
    try {
      const skillsShTable = tables.find((t) => t.name === "skills-sh");
      const registryRepos = [
        ...new Set(
          (skillsShTable?.rows ?? [])
            .map((r) => String(r["source"] ?? ""))
            .filter((s) => s.split("/").length >= 2),
        ),
      ];
      tables.push(...(await githubSource.collect(registryRepos)));
    } catch (err) {
      failures.push(`github: ${String(err)}`);
      log.error("github", String(err));
    }
  }

  // Social buzz across X / HN / Bluesky / GitHub for the top skills
  if (want("buzz")) {
    try {
      const targets = tables.some((t) => t.name === "skills-sh")
        ? buildTargets(tables, BUZZ_TOP_N)
        : buildTargetsFromRaw(rawDir, BUZZ_TOP_N); // --only=buzz: reuse today's written raw
      log.info("buzz", `collecting for ${targets.length} skills`);
      tables.push(...(await collectBuzz(targets)));
    } catch (err) {
      failures.push(`buzz: ${String(err)}`);
      log.error("buzz", String(err));
    }
  }

  return { tables, failures };
}

async function main(): Promise<void> {
  log.info("main", `daily run for ${date}${noPush ? " (no push)" : ""}${rankOnly ? " (rank only)" : ""}`);
  const repoPath = dataRepoPath();
  const dataDir = join(repoPath, "data");
  let failures: string[] = [];

  if (!rankOnly) {
    const collected = await collectAll(join(dataDir, date, "raw"));
    failures = collected.failures;
    if (collected.tables.length === 0) {
      log.error("main", "all collectors failed — nothing to write, keeping yesterday's data");
      process.exit(1);
    }
    writeRaw(date, collected.tables);
  }

  const rankings = computeRankings(dataDir, date);
  writeRankings(date, rankings);
  renderReadme(repoPath, date, rankings);

  const result = validate(dataDir, date);
  if (failures.length > 0) {
    result.warnings.push(`${failures.length} source(s) failed during collect: ${failures.join(" | ")}`);
  }
  if (result.errors.length > 0 || noPush) {
    reportAndExit(result); // exits 1 on errors
    if (result.errors.length === 0) refreshLatest(date); // keep latest/ in sync on clean no-push runs
    log.info("main", "done (not pushed)");
    return;
  }
  reportAndExit(result);
  // latest/ is only refreshed AFTER validation passes — a failed run must not
  // overwrite the last good snapshot (audit B12).
  refreshLatest(date);
  commitAndPush(date);
  log.info("main", "done");
}

main().catch((err) => {
  log.error("main", String(err));
  process.exit(1);
});
