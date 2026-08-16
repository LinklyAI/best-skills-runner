import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv, writeCsv } from "../lib/csv.js";
import { log } from "../lib/log.js";
import type { RawTable } from "../sources/types.js";
import { buildEntities, type Entity } from "./entity.js";
import { percentiler, weightedMean, recency, round3, NEUTRAL } from "./score.js";

const TOP = 100;
const RISING_DAYS = 30;

type Row = Record<string, string | number | boolean | null | undefined>;

interface Scored extends Entity {
  popScore?: number;
  buzzScore?: number;
  freshScore?: number;
  momentum?: number;
  trust: number;
  coverage: "A" | "B" | "C";
  ageDays?: number;
  isOfficialAny: boolean;
  vendor?: string;
  anomaly?: string;
  match: string;
}

/** Days between a date string and the reference instant (the data date, not wall clock). */
function daysSince(dateStr: string | undefined, refMs: number): number | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return undefined;
  return Math.floor((refMs - d.getTime()) / 86_400_000);
}

/**
 * Skill names without a hyphen are everyday words (github, weather, prototype…) —
 * mention counts for them cannot be reliably attributed to the skill, and X/HN/Bsky
 * queries drown in false positives (audit M3: weather hn=15 vs ground truth 0).
 * Same rule as keywords.ts isGeneric.
 */
function isGenericName(name: string): boolean {
  return !name.includes("-");
}

/** Detect implausible patterns: >=3 skills of one vendor sharing an identical install count. */
function detectAnomalies(entities: Entity[]): Map<string, string> {
  const flagged = new Map<string, string>();
  const groups = new Map<string, Entity[]>();
  for (const e of entities) {
    const vendor = e.ssSource?.split("/")[0] ?? e.chPublisher ?? e.shCertifiedName;
    for (const [metric, value] of [
      ["ss", e.ssInstalls],
      ["ch", e.chDownloads],
      ["sh", e.shDownloads],
    ] as const) {
      if (vendor && value !== undefined && value > 1000) {
        const k = `${vendor}|${metric}|${value}`;
        const g = groups.get(k) ?? [];
        g.push(e);
        groups.set(k, g);
      }
    }
  }
  for (const [k, g] of groups) {
    if (g.length >= 3) {
      for (const e of g) flagged.set(e.key, `identical-counts:${k.split("|")[0]}`);
    }
  }
  return flagged;
}

function computeScores(entities: Entity[], refMs: number): Scored[] {
  const ssPct = percentiler(entities.map((e) => e.ssInstalls));
  const chPct = percentiler(entities.map((e) => e.chDownloads));
  const shPct = percentiler(entities.map((e) => e.shDownloads));
  // Generic-name signals are unattributable noise — keep them out of the percentile
  // distributions AND out of each generic entity's own buzz (audit M3). GitHub search
  // is the exception: title-exact match + "skill" keeps it meaningful for any name.
  const hnPct = percentiler(entities.map((e) => (isGenericName(e.name) ? undefined : e.hn)));
  const bskyPct = percentiler(entities.map((e) => (isGenericName(e.name) ? undefined : e.bsky)));
  const ghPct = percentiler(entities.map((e) => e.ghMentions));
  const xPct = percentiler(entities.map((e) => (isGenericName(e.name) ? undefined : e.xMentions)));
  const verPct = percentiler(entities.map((e) => e.chVersions));
  const anomalies = detectAnomalies(entities);

  return entities.map((e): Scored => {
    const popScore = weightedMean([
      [ssPct(e.ssInstalls), 0.5],
      [chPct(e.chDownloads), 0.3],
      [shPct(e.shDownloads), 0.2],
    ]);
    // Buzz: only meaningful when this entity was in the sampled target list;
    // unmeasured entities get the neutral prior instead of a silent exemption (audit B2/B7).
    // Within a measured entity, missing channels (X only covers the top-N targets,
    // generic names have no attributable X/HN/Bsky signal) are ALSO filled with NEUTRAL —
    // re-normalizing weights made "unmeasured" outrank "measured zero" (audit M2).
    const generic = isGenericName(e.name);
    const buzzScore = e.buzzMeasured
      ? 0.4 * ((generic ? undefined : xPct(e.xMentions)) ?? NEUTRAL) +
        0.25 * (ghPct(e.ghMentions) ?? NEUTRAL) +
        0.2 * ((generic ? undefined : hnPct(e.hn)) ?? NEUTRAL) +
        0.15 * ((generic ? undefined : bskyPct(e.bsky)) ?? NEUTRAL)
      : undefined;
    // Freshness: ClawHub is the only source with a content-update timestamp.
    const freshScore =
      e.chSlug !== undefined
        ? weightedMean([
            [recency(e.chUpdatedAt, 45, refMs), 0.6],
            [verPct(e.chVersions), 0.4],
          ])
        : undefined;
    // Momentum: within the skills.sh ecosystem, absence from trending is a real 0
    // (audit B4: previously off-list scored better than trending rank 600).
    const momentum =
      e.ssInstalls !== undefined
        ? e.ssTrendingRank !== undefined
          ? Math.max(0, 1 - (e.ssTrendingRank - 1) / 600)
          : 0
        : undefined;

    const isOfficialAny = Boolean(e.ssOfficial || e.chOfficialFeed || e.shVerified);
    const trust = Math.min(1, 0.2 + (e.ssOfficial || e.chOfficialFeed ? 0.5 : 0) + (e.shVerified ? 0.3 : 0));

    const platforms = [e.ssInstalls, e.chDownloads, e.shDownloads].filter((v) => v !== undefined).length;
    const coverage: "A" | "B" | "C" = platforms >= 3 ? "A" : platforms === 2 ? "B" : "C";
    const created = [e.chCreatedAt, e.shCreatedAt].filter(Boolean).sort()[0];
    const vendor = e.ssSource?.split("/")[0] ?? e.chPublisher ?? e.shCertifiedName ?? undefined;
    // Pass the unresolved state through — "claimed an upstream we couldn't resolve"
    // is different information from "never claimed one" (audit DOC-12).
    const match = e.shMatch === "upstream" || e.shMatch === "upstream-unresolved" ? e.shMatch : "single";

    return {
      ...e,
      popScore,
      buzzScore,
      freshScore,
      momentum,
      trust,
      coverage,
      ageDays: daysSince(created, refMs),
      isOfficialAny,
      vendor,
      anomaly: anomalies.get(e.key),
      match,
    };
  });
}

/**
 * WIS over all five dimensions. Missing dimensions are filled with the neutral prior
 * (never re-normalized away) so sparse data cannot inflate a score (audit B2/B3).
 * Requires popularity — entities without any install signal are not rankable.
 */
function wis(s: Scored): number | undefined {
  if (s.popScore === undefined) return undefined;
  const base =
    0.3 * s.popScore +
    0.15 * (s.momentum ?? NEUTRAL) +
    0.2 * (s.buzzScore ?? NEUTRAL) +
    0.15 * (s.freshScore ?? NEUTRAL) +
    0.2 * s.trust;
  const penalty = s.anomaly ? 0.6 : 1;
  return Math.round(base * penalty * 1000) / 10;
}

const IDENT = (s: Scored): Row => ({
  skill: s.name,
  platform: s.platform,
  vendor: s.vendor,
  source_skillssh: s.ssSource,
  slug_clawhub: s.chSlug,
  match: s.match,
  description: s.description,
  description_zh: s.descriptionZh,
});

const IDENT_COLS = ["skill", "platform", "vendor", "source_skillssh", "slug_clawhub", "match", "description", "description_zh"];

/** Maintain the cumulative first-seen index (data/index/first-seen.csv). */
function updateFirstSeen(dataDir: string, date: string, entities: Entity[]): { firstSeen: Map<string, string>; earliest: string } {
  const p = join(dataDir, "index", "first-seen.csv");
  const idx = new Map<string, string>();
  if (existsSync(p)) {
    for (const r of readCsv(p)) if (r["key"] && r["first_seen"]) idx.set(r["key"], r["first_seen"]);
  }
  for (const e of entities) {
    if (!idx.has(e.key)) idx.set(e.key, date);
  }
  writeCsv(
    p,
    ["key", "first_seen"],
    [...idx.entries()].sort().map(([key, d]) => ({ key, first_seen: d })),
  );
  const earliest = [...idx.values()].sort()[0] ?? date;
  return { firstSeen: idx, earliest };
}

export function computeRankings(dataDir: string, date: string): RawTable[] {
  const rawDir = join(dataDir, date, "raw");
  // All time-dependent scores reference the END of the data date (never wall clock)
  // so published numbers are reproducible from the CSVs alone (audit SC-16).
  const refMs = Date.parse(`${date}T00:00:00Z`) + 86_400_000;
  const entities = [...buildEntities(rawDir).values()];
  const scored = computeScores(entities, refMs);
  const { firstSeen, earliest: indexEarliest } = updateFirstSeen(dataDir, date, entities);
  log.info("rank", `${scored.length} merged entities`);
  const ranked = (rows: Row[]): Row[] => rows.slice(0, TOP).map((r, i) => ({ rank: i + 1, ...r }));

  const tables: RawTable[] = [];
  const add = (name: string, columns: string[], rows: Row[]): void => {
    tables.push({ name, columns: ["rank", ...columns], rows: ranked(rows) });
    log.info("rank", `${name}: ${Math.min(rows.length, TOP)} rows`);
  };

  // Effective age: registry created_at or our own first-seen index (only meaningful
  // after the index's first day — day-one entries are unknown-age, not new).
  const effectiveAge = (s: Scored): number | undefined => {
    const ours = firstSeen.get(s.key);
    const oursAge = ours && ours > indexEarliest ? daysSince(ours, refMs) : undefined;
    if (s.ageDays === undefined) return oursAge;
    if (oursAge === undefined) return s.ageDays;
    return Math.min(s.ageDays, oursAge);
  };

  // 1. top-installs
  add(
    "top-installs",
    [...IDENT_COLS, "installs_skillssh", "downloads_clawhub", "downloads_skillhub_cn", "pop_score", "coverage"],
    scored
      .filter((s) => s.popScore !== undefined)
      .sort((a, b) => (b.popScore ?? 0) - (a.popScore ?? 0))
      .map((s) => ({
        ...IDENT(s),
        installs_skillssh: s.ssInstalls,
        downloads_clawhub: s.chDownloads,
        downloads_skillhub_cn: s.shDownloads,
        pop_score: round3(s.popScore),
        coverage: s.coverage,
      })),
  );

  // 2. trending-7d — source honestly labeled; own-snapshot growth replaces this after 7 days of history
  add(
    "trending-7d",
    [...IDENT_COLS, "installs_skillssh", "trending_rank_skillssh", "weekly_recent", "weekly_prev", "growth_pct", "data_source"],
    scored
      .filter((s) => s.ssTrendingRank !== undefined)
      .sort((a, b) => (a.ssTrendingRank ?? 1e9) - (b.ssTrendingRank ?? 1e9))
      .map((s) => {
        const w = s.ssWeekly ?? [];
        // Array direction verified 2026-08-11: tail = most recent week (62/69 samples)
        const recent = w[w.length - 1];
        const prev = w[w.length - 2];
        // No growth when prev is the FIRST non-zero bucket — a launch-week partial
        // bucket produces absurd percentages (audit M4: +90572% on writing-for-agents).
        const prevIsLaunchWeek = w.findIndex((v) => v > 0) === w.length - 2;
        const growth =
          recent !== undefined && prev !== undefined && prev > 0 && !prevIsLaunchWeek
            ? Math.round(((recent - prev) / prev) * 1000) / 10
            : undefined;
        return {
          ...IDENT(s),
          installs_skillssh: s.ssInstalls,
          trending_rank_skillssh: s.ssTrendingRank,
          weekly_recent: recent,
          weekly_prev: prev,
          growth_pct: growth,
          data_source: "skills.sh-trending",
        };
      }),
  );

  // 3. social-buzz — at least 2 platforms with signal and 3 total mentions.
  // Generic (hyphen-less) names are excluded outright: their X/HN/Bsky counts cannot
  // be attributed to the skill (audit M3 — "weather" hn was ground-truthed to 0).
  // Raw HN/Bsky totals ride along so readers can see the pre-filter magnitudes.
  add(
    "social-buzz",
    [...IDENT_COLS, "x_mentions_7d", "x_truncated", "hn_hits_7d", "hn_raw_7d", "bsky_hits_7d", "bsky_raw_7d", "gh_mentions_7d", "x_engagement_7d", "buzz_score", "buzz_shared"],
    scored
      .filter((s) => {
        if (s.buzzScore === undefined || isGenericName(s.name)) return false;
        const signals = [s.xMentions, s.hn, s.bsky, s.ghMentions].filter((v) => (v ?? 0) > 0);
        const total = (s.hn ?? 0) + (s.bsky ?? 0) + (s.xMentions ?? 0) + (s.ghMentions ?? 0);
        return signals.length >= 2 && total >= 3;
      })
      .sort((a, b) => (b.buzzScore ?? 0) - (a.buzzScore ?? 0))
      .map((s) => ({
        ...IDENT(s),
        x_mentions_7d: s.xMentions,
        x_truncated: s.xTruncated ?? false,
        hn_hits_7d: s.hn,
        hn_raw_7d: s.hnRaw,
        bsky_hits_7d: s.bsky,
        bsky_raw_7d: s.bskyRaw,
        gh_mentions_7d: s.ghMentions,
        x_engagement_7d: s.xEngagement,
        buzz_score: round3(s.buzzScore),
        buzz_shared: s.buzzShared ?? false,
      })),
  );

  // 4. most-active — freshness within the ClawHub ecosystem (only source with update timestamps)
  add(
    "most-active",
    [...IDENT_COLS, "last_update", "versions_clawhub", "installs_or_downloads", "freshness_score", "data_scope"],
    scored
      .filter((s) => s.freshScore !== undefined && s.chUpdatedAt !== undefined && (s.popScore ?? 0) > 0.5)
      .sort((a, b) => (b.freshScore ?? 0) - (a.freshScore ?? 0))
      .map((s) => ({
        ...IDENT(s),
        last_update: s.chUpdatedAt,
        versions_clawhub: s.chVersions,
        installs_or_downloads: s.ssInstalls ?? s.chDownloads ?? s.shDownloads,
        freshness_score: round3(s.freshScore),
        data_scope: "clawhub",
      })),
  );

  // 5. official-100
  add(
    "official-100",
    [...IDENT_COLS, "verified_by", "installs_skillssh", "downloads_clawhub", "downloads_skillhub_cn", "pop_score"],
    scored
      .filter((s) => s.isOfficialAny && s.popScore !== undefined)
      .sort((a, b) => (b.popScore ?? 0) - (a.popScore ?? 0))
      .map((s) => ({
        ...IDENT(s),
        verified_by: [s.ssOfficial ? "skills.sh" : null, s.chOfficialFeed ? "clawhub" : null, s.shVerified ? "skillhub" : null]
          .filter(Boolean)
          .join("|"),
        installs_skillssh: s.ssInstalls,
        downloads_clawhub: s.chDownloads,
        downloads_skillhub_cn: s.shDownloads,
        pop_score: round3(s.popScore),
      })),
  );

  // 6. official-vendors — three platform sections, ranked within platform, never across
  const vendorRows: Row[] = [];
  const vendorsRaw = existsSync(join(rawDir, "skills-sh-official.csv")) ? readCsv(join(rawDir, "skills-sh-official.csv")) : [];
  for (const r of vendorsRaw.sort((a, b) => Number(b["total_installs"] ?? 0) - Number(a["total_installs"] ?? 0)).slice(0, 40)) {
    const skillsCount = Number(r["skills"] ?? "");
    const total = Number(r["total_installs"] ?? "");
    vendorRows.push({
      platform: "skills.sh",
      vendor: r["owner"],
      skills_count: Number.isFinite(skillsCount) ? skillsCount : undefined,
      // skills.sh publishes vendor totals itself — the count and the total share one basis
      tracked_skills: Number.isFinite(skillsCount) ? skillsCount : undefined,
      total_installs_or_downloads: Number.isFinite(total) ? total : undefined,
      featured_skill: r["featured_skill"],
    });
  }
  // ClawHub: aggregate official-feed publishers over our top-1000 downloads snapshot (partial, honest)
  const chOfficialPub = new Map<string, string[]>(); // publisher -> slugs
  for (const r of existsSync(join(rawDir, "clawhub-official.csv")) ? readCsv(join(rawDir, "clawhub-official.csv")) : []) {
    const id = r["id"] ?? "";
    const pub = r["publisher"] ?? id.replace(/^@/, "").split("/")[0] ?? "";
    const slug = id.split("/").pop() ?? "";
    if (pub && slug) chOfficialPub.set(pub, [...(chOfficialPub.get(pub) ?? []), slug]);
  }
  const chDownloadsBySlug = new Map<string, number>();
  for (const s of scored) if (s.chSlug && s.chDownloads !== undefined) chDownloadsBySlug.set(s.chSlug.toLowerCase(), s.chDownloads);
  const chVendors = [...chOfficialPub.entries()]
    .map(([pub, slugs]) => {
      const tracked = slugs.map((sl) => chDownloadsBySlug.get(sl.toLowerCase())).filter((v): v is number => v !== undefined);
      return { pub, skills: slugs.length, downloads: tracked.reduce((a, b) => a + b, 0), tracked: tracked.length };
    })
    .filter((v) => v.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 30);
  for (const v of chVendors) {
    vendorRows.push({
      platform: "clawhub",
      vendor: v.pub,
      skills_count: v.skills,
      // downloads only cover the slugs inside our top-1000 snapshot — publish that
      // denominator so "246 skills / 8,014 downloads" can't be misread (audit M8)
      tracked_skills: v.tracked,
      total_installs_or_downloads: v.downloads,
      featured_skill: undefined,
    });
  }
  // SkillHub: aggregate verified-enterprise publishers (China ecosystem)
  const shEnt = existsSync(join(rawDir, "skillhub-enterprise.csv")) ? readCsv(join(rawDir, "skillhub-enterprise.csv")) : [];
  const shVendorAgg = new Map<string, { skills: number; downloads: number; top?: string; topDl: number }>();
  for (const r of shEnt) {
    const vendor = r["certified_name"] || r["publisher"];
    const dl = Number(r["downloads"] ?? 0);
    if (!vendor || !Number.isFinite(dl)) continue;
    const agg = shVendorAgg.get(vendor) ?? { skills: 0, downloads: 0, topDl: -1 };
    agg.skills++;
    agg.downloads += dl;
    if (dl > agg.topDl) {
      agg.topDl = dl;
      agg.top = r["slug"];
    }
    shVendorAgg.set(vendor, agg);
  }
  for (const [vendor, agg] of [...shVendorAgg.entries()].sort((a, b) => b[1].downloads - a[1].downloads).slice(0, 30)) {
    vendorRows.push({
      platform: "skillhub-cn",
      vendor,
      skills_count: agg.skills,
      tracked_skills: agg.skills,
      total_installs_or_downloads: agg.downloads,
      featured_skill: agg.top,
    });
  }
  add("official-vendors", ["platform", "vendor", "skills_count", "tracked_skills", "total_installs_or_downloads", "featured_skill"], vendorRows);

  // 7. top-repos — canonical dedupe + skills-relevance filter + 1-day star delta
  const reposRaw = existsSync(join(rawDir, "github-repos.csv")) ? readCsv(join(rawDir, "github-repos.csv")) : [];
  const prevDate = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const prevPath = join(dataDir, prevDate, "raw", "github-repos.csv");
  const prevStars = new Map<string, number>();
  if (existsSync(prevPath)) {
    for (const r of readCsv(prevPath)) prevStars.set((r["repo"] ?? "").toLowerCase(), Number(r["stars"] ?? 0));
  }
  const skillCountByRepo = new Map<string, number>();
  for (const s of scored) {
    if (s.ssSource) skillCountByRepo.set(s.ssSource.toLowerCase(), (skillCountByRepo.get(s.ssSource.toLowerCase()) ?? 0) + 1);
  }
  const RELEVANT = /skill|claude|agent|openclaw|llm|mcp|copilot|prompt/i;
  const seenRepos = new Set<string>();
  add(
    "top-repos",
    ["repo", "stars", "stars_1d", "pushed_at", "skills_tracked", "topics"],
    reposRaw
      .sort((a, b) => Number(b["stars"] ?? 0) - Number(a["stars"] ?? 0))
      .filter((r) => {
        const repo = (r["repo"] ?? "").toLowerCase();
        if (!repo || seenRepos.has(repo)) return false;
        seenRepos.add(repo);
        const hay = `${r["repo"]} ${r["topics"] ?? ""} ${r["description"] ?? ""}`;
        return RELEVANT.test(hay) || skillCountByRepo.has(repo);
      })
      .map((r) => {
        const repo = r["repo"] ?? "";
        const stars = Number(r["stars"] ?? 0);
        const prev = prevStars.get(repo.toLowerCase());
        return {
          repo,
          stars,
          stars_1d: prev !== undefined ? stars - prev : undefined,
          pushed_at: r["pushed_at"],
          skills_tracked: skillCountByRepo.get(repo.toLowerCase()),
          topics: r["topics"],
        };
      }),
  );

  // 8. rising-stars — registry created_at or our own first-seen index
  add(
    "rising-stars",
    [...IDENT_COLS, "first_seen_days", "installs_skillssh", "downloads_clawhub", "downloads_skillhub_cn", "pop_score"],
    scored
      .map((s) => ({ s, age: effectiveAge(s) }))
      .filter(({ s, age }) => age !== undefined && age < RISING_DAYS && s.popScore !== undefined)
      .sort((a, b) => (b.s.popScore ?? 0) - (a.s.popScore ?? 0))
      .map(({ s, age }) => ({
        ...IDENT(s),
        first_seen_days: age,
        installs_skillssh: s.ssInstalls,
        downloads_clawhub: s.chDownloads,
        downloads_skillhub_cn: s.shDownloads,
        pop_score: round3(s.popScore),
      })),
  );

  // 9. best-100 — WIS composite (neutral-prior filled); newcomers stay in rising-stars.
  // Raw per-platform counts ride along — the "every CSV keeps the raw numbers" promise
  // must hold on the flagship list too (audit M7).
  add(
    "best-100",
    [...IDENT_COLS, "installs_skillssh", "downloads_clawhub", "downloads_skillhub_cn", "wis", "popularity", "momentum", "buzz", "maintenance", "trust", "coverage", "anomaly"],
    scored
      .filter((s) => {
        const age = effectiveAge(s);
        return !(age !== undefined && age < RISING_DAYS);
      })
      .map((s) => ({ s, score: wis(s) }))
      .filter((x): x is { s: Scored; score: number } => x.score !== undefined)
      .sort((a, b) => b.score - a.score)
      .map(({ s, score }) => ({
        ...IDENT(s),
        installs_skillssh: s.ssInstalls,
        downloads_clawhub: s.chDownloads,
        downloads_skillhub_cn: s.shDownloads,
        wis: score,
        popularity: round3(s.popScore),
        momentum: round3(s.momentum),
        buzz: round3(s.buzzScore),
        maintenance: round3(s.freshScore),
        trust: round3(s.trust),
        coverage: s.coverage,
        anomaly: s.anomaly,
      })),
  );

  return tables;
}
