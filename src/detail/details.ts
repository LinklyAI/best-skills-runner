import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readCsv } from "../lib/csv.js";
import { env } from "../lib/env.js";
import { log } from "../lib/log.js";
import { mapLimit } from "../judge/jev.js";
import { buildEntities, type Entity } from "../rank/entity.js";
import type { RawTable } from "../sources/types.js";
import { type About, type DescribeClient } from "./describe.js";
import { loadHistory, type DayPoint } from "./history.js";
import { GitHubReader, parseFrontmatter, readClawHub, type SkillSource } from "./source.js";
import { computeStats, type SkillStats } from "./stats.js";

/**
 * One JSON file per skill for the detail pages (data/skills/<path>.json), rebuilt every
 * day for every skill that appears in a ranking. The web page is a template over this
 * file; it fetches nothing else.
 *
 *   numbers  — recomputed daily from the data repo (history.ts, stats.ts)
 *   facts    — read off SKILL.md by code (source.ts)
 *   about    — written by a model from SKILL.md, only when SKILL.md changed (describe.ts)
 *
 * A skill that drops out of every ranking keeps its last file; `date` tells the page
 * the numbers stopped there. data/skills/index.json lists every file for the sitemap.
 */

export const DETAIL_SCHEMA = 1;
/** Page files live here, relative to data/. */
export const SKILLS_DIR = "skills";
/** At most this many model calls a day, so a backfill spreads over several runs. */
const DESCRIBE_MAX_PER_RUN = 150;
const SOURCE_CONCURRENCY = 6;
const DESCRIBE_CONCURRENCY = 4;
const PEERS = 4;
/** Lists whose rows get a page. Repo-level lists (top-repos, official-vendors) are not skills. */
const SKILL_LISTS = ["best-100", "top-installs", "trending-7d", "official-100", "rising-stars", "social-buzz", "most-active"];

export interface Peer {
  name: string;
  /** Page path when the peer has its own page. */
  path?: string;
  url?: string;
  total?: number;
  description?: string;
  /** SKILL.md of this skill calls the peer. */
  depends?: boolean;
}

export interface SkillDetail {
  schema: number;
  /** Data date the numbers are from. */
  date: string;
  key: string;
  path: string;
  name: string;
  platform: string;
  /** owner/repo for skills.sh, owner handle for ClawHub, publisher for SkillHub. */
  owner?: string;
  authorName?: string;
  repo?: string;
  repoUrl?: string;
  url?: string;
  install?: string;
  installAll?: string;
  description?: string;
  descriptionZh?: string;
  category?: string;
  flags?: string[];
  official?: boolean;
  github?: { stars?: number; pushedAt?: string };
  /** What the cumulative count counts on this platform. */
  totalKind: "installs" | "downloads";
  stats: SkillStats;
  /** [date, cumulative, Best 100 rank] per day; null when unknown. */
  series: Array<[string, number | null, number | null]>;
  peers: Peer[];
  peersKind: "repo" | "owner" | "none";
  source?: {
    hash: string;
    updatedAt?: string;
    invocation: "manual" | "auto";
    depends: string[];
    scripts?: boolean;
  };
  about?: About & { model: string; writtenOn: string; hash: string };
}

/** Page path of an entity key: skills.sh keeps its source path, other platforms get a prefix. */
export function skillPath(key: string): string | undefined {
  const [prefix, rest] = [key.slice(0, 3), key.slice(3)];
  const path = prefix === "ss:" ? rest : prefix === "ch:" ? `clawhub/${rest}` : prefix === "sh:" ? `skillhub/${rest}` : undefined;
  if (!path) return undefined;
  return path.split("/").every((s) => /^[a-z0-9][a-z0-9._-]*$/.test(s)) ? path : undefined;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function readJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isGitHubRepo(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

/** ClawHub owner handle from the page URL https://clawhub.ai/<owner>/skills/<slug>. */
export function clawhubOwner(url: string | undefined): string | undefined {
  return url?.match(/^https:\/\/clawhub\.ai\/([^/]+)\/(?:skills\/)?[^/]+$/)?.[1];
}

interface Scoped {
  key: string;
  path: string;
  row: Record<string, unknown>;
  entity?: Entity;
}

export async function buildSkillDetails(
  dataDir: string,
  date: string,
  rankings: readonly RawTable[],
  llm: DescribeClient | null,
  opts: { offline?: boolean } = {},
): Promise<{ written: number; described: number; sourced: number }> {
  const rawDir = join(dataDir, date, "raw");
  const entities = buildEntities(rawDir);

  // Every skill row of every list; the first list a skill appears in supplies its row.
  const scoped = new Map<string, Scoped>();
  for (const t of rankings) {
    if (!SKILL_LISTS.includes(t.name)) continue;
    for (const row of t.rows) {
      const key = String(row["skill_key"] ?? "");
      const path = skillPath(key);
      if (!path || scoped.has(key)) continue;
      scoped.set(key, { key, path, row, entity: entities.get(key) });
    }
  }
  const history = loadHistory(dataDir, new Set(scoped.keys()), date);
  const pathOf = new Map([...scoped.values()].map((s) => [s.key, s.path]));

  const stars = new Map<string, { stars?: number; pushedAt?: string }>();
  const repoCsv = join(rawDir, "github-repos.csv");
  if (existsSync(repoCsv)) {
    for (const r of readCsv(repoCsv)) stars.set((r["repo"] ?? "").toLowerCase(), { stars: num(r["stars"]), pushedAt: r["pushed_at"] || undefined });
  }

  // Same-repo and same-owner peers come from today's whole raw data, not only ranked skills.
  const byRepo = new Map<string, Entity[]>();
  const byOwner = new Map<string, Entity[]>();
  for (const e of entities.values()) {
    if (e.ssSource && e.ssInstalls !== undefined) byRepo.set(e.ssSource.toLowerCase(), [...(byRepo.get(e.ssSource.toLowerCase()) ?? []), e]);
    if (e.platform === "clawhub" && e.chOwner) byOwner.set(e.chOwner.toLowerCase(), [...(byOwner.get(e.chOwner.toLowerCase()) ?? []), e]);
  }

  const outDir = join(dataDir, SKILLS_DIR);
  const fileOf = (path: string) => join(outDir, `${path}.json`);
  const github = opts.offline ? null : new GitHubReader();
  const peerDescriptions = new Map<string, string>();

  const details: SkillDetail[] = [];
  const pendingAbout: Array<{ d: SkillDetail; src: SkillSource }> = [];
  let sourced = 0;

  await mapLimit([...scoped.values()], SOURCE_CONCURRENCY, async (s) => {
    const e = s.entity;
    const row = s.row as Record<string, string | number | undefined>;
    const prev = readJson<SkillDetail>(fileOf(s.path));
    const platform = e?.platform ?? String(row["platform"] ?? "");
    const repo = e?.ssSource && isGitHubRepo(e.ssSource) ? e.ssSource : undefined;
    const owner = platform === "skills.sh" ? e?.ssSource : platform === "clawhub" ? clawhubOwner(String(row["url"] ?? "")) ?? e?.chOwner : String(row["vendor"] ?? "") || undefined;

    // Source: re-read daily so a changed SKILL.md is noticed; offline runs keep yesterday's facts.
    let src: SkillSource | undefined;
    if (!opts.offline) {
      try {
        if (platform === "skills.sh" && repo && github) src = await github.read(repo, s.entity?.name ?? String(row["skill"]));
        else if (platform === "clawhub") src = await readClawHub(e?.chSlug ?? String(row["skill"]), owner);
      } catch (err) {
        log.warn("detail", `${s.key}: source read failed: ${String(err)}`);
      }
    }
    if (src) {
      sourced++;
      if (src.ref.kind === "github") {
        src.updatedAt = prev?.source?.hash === src.hash ? prev.source.updatedAt : await github!.lastChanged(src.ref.repo, src.ref.path);
      }
    }
    const source = src
      ? { hash: src.hash, updatedAt: src.updatedAt, invocation: src.invocation, depends: src.depends, scripts: src.scripts }
      : prev?.source;

    // Peers.
    let peers: Peer[] = [];
    let peersKind: SkillDetail["peersKind"] = "none";
    if (platform === "skills.sh" && e?.ssSource) {
      peersKind = "repo";
      const deps = new Set((source?.depends ?? []).map((n) => n.toLowerCase()));
      const mates = (byRepo.get(e.ssSource.toLowerCase()) ?? [])
        .filter((m) => m.key !== s.key)
        .sort((a, b) => Number(deps.has(b.name.toLowerCase())) - Number(deps.has(a.name.toLowerCase())) || (b.ssInstalls ?? 0) - (a.ssInstalls ?? 0))
        .slice(0, PEERS);
      peers = mates.map((m) => ({
        name: m.name,
        path: pathOf.get(m.key),
        url: `https://www.skills.sh/${e.ssSource}/${m.name}`,
        total: m.ssInstalls,
        ...(deps.has(m.name.toLowerCase()) && { depends: true }),
      }));
      // Peer one-liners from their own SKILL.md frontmatter (cached per run and carried from yesterday).
      for (const p of peers) {
        const cacheKey = `${e.ssSource}/${p.name}`.toLowerCase();
        const carried = prev?.peers.find((x) => x.name === p.name)?.description;
        if (carried) {
          p.description = carried;
          continue;
        }
        if (!peerDescriptions.has(cacheKey) && repo && github) {
          const ps = await github.read(repo, p.name).catch(() => undefined);
          peerDescriptions.set(cacheKey, ps ? parseFrontmatter(ps.markdown).fields["description"] ?? "" : "");
        }
        p.description = peerDescriptions.get(cacheKey) || undefined;
      }
    } else if (platform === "clawhub" && owner) {
      peersKind = "owner";
      peers = (byOwner.get(owner.toLowerCase()) ?? [])
        .filter((m) => m.key !== s.key)
        .sort((a, b) => (b.chDownloads ?? 0) - (a.chDownloads ?? 0))
        .slice(0, PEERS)
        .map((m) => ({
          name: m.name,
          path: pathOf.get(m.key),
          url: `https://clawhub.ai/${owner}/skills/${m.chSlug ?? m.name}`,
          total: m.chDownloads,
          description: m.description,
        }));
    }

    const series: DayPoint[] = history.get(s.key) ?? [];
    const d: SkillDetail = {
      schema: DETAIL_SCHEMA,
      date,
      key: s.key,
      path: s.path,
      name: e?.name ?? String(row["skill"] ?? ""),
      platform,
      owner,
      authorName: src?.authorName ?? prev?.authorName,
      repo,
      repoUrl: String(row["repo_url"] ?? "") || (repo ? `https://github.com/${repo}` : undefined),
      url: String(row["url"] ?? "") || undefined,
      install: String(row["install"] ?? "") || undefined,
      installAll: repo ? `npx skills add https://github.com/${repo}` : undefined,
      description: String(row["description"] ?? "") || e?.description,
      descriptionZh: String(row["description_zh"] ?? "") || e?.descriptionZh,
      category: String(row["category"] ?? "") || e?.category,
      flags: e?.flags,
      official: e?.ssOfficial || e?.chOfficialFeed || e?.shVerified || undefined,
      github: repo ? stars.get(repo.toLowerCase()) : undefined,
      totalKind: platform === "skills.sh" ? "installs" : "downloads",
      stats: computeStats(series, date),
      series: series.map((p) => [p.date, p.total ?? null, p.rank ?? null]),
      peers,
      peersKind,
      source,
      about: prev?.about,
    };
    details.push(d);
    if (src && llm && (prev?.about?.hash !== src.hash || prev.about.model !== llm.model)) pendingAbout.push({ d, src });
  });

  // Model text: only new or changed SKILL.md, capped per run.
  let described = 0;
  if (llm && pendingAbout.length > 0) {
    const max = Number(env("DETAIL_MAX_PER_RUN") ?? DESCRIBE_MAX_PER_RUN);
    const batch = pendingAbout.slice(0, Number.isFinite(max) ? max : DESCRIBE_MAX_PER_RUN);
    log.info("detail", `describing ${batch.length} skills (${pendingAbout.length} pending)`);
    let failed = 0;
    await mapLimit(batch, DESCRIBE_CONCURRENCY, async ({ d, src }) => {
      try {
        const about = await llm.describe({ name: d.name, platform: d.platform, listing: d.description, markdown: src.markdown });
        d.about = { ...about, model: llm.model, writtenOn: date, hash: src.hash };
        described++;
      } catch (err) {
        failed++;
        if (failed <= 5) log.warn("detail", String(err));
      }
    });
    if (failed > 0) log.warn("detail", `${failed}/${batch.length} descriptions failed; they retry next run`);
  }

  for (const d of details) {
    const f = fileOf(d.path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${JSON.stringify(d)}\n`);
  }
  writeIndex(outDir);
  log.info("detail", `${details.length} skill pages written, ${sourced} sources read, ${described} described${github ? `, ${github.requests} GitHub API calls` : ""}`);
  return { written: details.length, described, sourced };
}

export interface IndexEntry {
  path: string;
  name: string;
  platform: string;
  /** Last data date of the file; older than the latest run means the skill left the lists. */
  date: string;
  rank?: number;
}

/** Lists every page file, the sitemap's source. */
export function writeIndex(outDir: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".json") && p !== join(outDir, "index.json")) {
        const d = readJson<SkillDetail>(p);
        if (!d) continue;
        entries.push({ path: relative(outDir, p).slice(0, -5), name: d.name, platform: d.platform, date: d.date, ...(d.stats.rank !== undefined && { rank: d.stats.rank }) });
      }
    }
  };
  walk(outDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(entries)}\n`);
  return entries;
}
