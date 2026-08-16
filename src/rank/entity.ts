import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "../lib/csv.js";

/**
 * One skill entity. The primary key is FULLY QUALIFIED per ecosystem — short names
 * collide constantly (three different "frontend-design"s exist on skills.sh alone),
 * so same-name entries are separate entities unless joined by exact evidence:
 *   ss:<owner/repo>/<name>   skills.sh entry
 *   ch:<slug>                ClawHub entry (slug is platform-unique); SkillHub rows
 *                            with a resolvable upstream_url attach here (exact join)
 *   sh:<slug>                SkillHub entry without resolvable upstream
 */
export interface Entity {
  key: string;
  name: string;
  /** Primary ecosystem anchor of this entity. */
  platform: "skills.sh" | "clawhub" | "skillhub-cn";
  ssSource?: string;
  ssInstalls?: number;
  ssWeekly?: number[];
  ssOfficial?: boolean;
  ssTrendingRank?: number;
  chSlug?: string;
  chDownloads?: number;
  chInstalls?: number;
  chStars?: number;
  chVersions?: number;
  chCreatedAt?: string;
  chUpdatedAt?: string;
  chOfficialFeed?: boolean;
  chPublisher?: string;
  /** Tencent SkillHub (China-region counters; attached via upstream join or own entity) */
  shDownloads?: number;
  shInstalls?: number;
  shVerified?: boolean;
  shCertifiedName?: string;
  shCreatedAt?: string;
  shUpdatedAt?: string;
  shMatch?: "upstream" | "upstream-unresolved" | "own";
  /** Buzz (searched by short name; attributed to the most popular same-name entity) */
  hn?: number;
  hnRaw?: number;
  bsky?: number;
  bskyRaw?: number;
  ghMentions?: number;
  xMentions?: number;
  xTruncated?: boolean;
  xEngagement?: number;
  buzzMeasured?: boolean;
  buzzShared?: boolean;
  description?: string;
  descriptionZh?: string;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function readIf(dir: string, file: string): Array<Record<string, string>> {
  const p = join(dir, `${file}.csv`);
  return existsSync(p) ? readCsv(p) : [];
}

/** Load all raw CSVs for a date directory and build entities keyed by qualified id. */
export function buildEntities(rawDir: string): Map<string, Entity> {
  const entities = new Map<string, Entity>();

  // skills.sh — key by source+name; same key appears in all three views (max installs wins)
  for (const r of readIf(rawDir, "skills-sh")) {
    const name = (r["name"] ?? "").trim();
    const source = (r["source"] ?? "").trim();
    if (!name) continue;
    const key = `ss:${source}/${name}`.toLowerCase();
    let e = entities.get(key);
    if (!e) {
      e = { key, name, platform: "skills.sh", ssSource: source };
      entities.set(key, e);
    }
    const installs = num(r["installs"]);
    if (installs !== undefined && (e.ssInstalls === undefined || installs > e.ssInstalls)) {
      e.ssInstalls = installs;
      if (r["weekly_installs"]) e.ssWeekly = r["weekly_installs"].split("|").map(Number);
    }
    if (r["is_official"] === "true") e.ssOfficial = true;
    if (r["view"] === "trending") {
      const rank = num(r["rank"]);
      if (rank !== undefined && (e.ssTrendingRank === undefined || rank < e.ssTrendingRank)) e.ssTrendingRank = rank;
    }
  }

  // ClawHub — slug is platform-unique
  const bySlug = new Map<string, Entity>();
  for (const r of readIf(rawDir, "clawhub")) {
    const slug = (r["slug"] ?? "").trim();
    if (!slug) continue;
    const key = `ch:${slug}`.toLowerCase();
    const e: Entity = entities.get(key) ?? { key, name: slug, platform: "clawhub" };
    entities.set(key, e);
    e.chSlug = slug;
    e.chDownloads = num(r["downloads"]);
    e.chInstalls = num(r["installs"]);
    e.chStars = num(r["stars"]);
    e.chVersions = num(r["versions"]);
    e.chCreatedAt = r["created_at"];
    e.chUpdatedAt = r["updated_at"];
    if (r["summary"]) e.description = r["summary"];
    bySlug.set(slug.toLowerCase(), e);
  }

  for (const r of readIf(rawDir, "clawhub-official")) {
    const slug = ((r["id"] ?? "").split("/").pop() ?? "").trim();
    const e = bySlug.get(slug.toLowerCase());
    if (e) {
      e.chOfficialFeed = true;
      if (r["publisher"]) e.chPublisher = r["publisher"];
    }
  }

  // SkillHub — attach to ClawHub entity only on exact upstream evidence; else own entity
  for (const r of readIf(rawDir, "skillhub")) {
    const slug = (r["slug"] ?? "").trim();
    if (!slug) continue;
    const upstream = ((r["upstream_url"] ?? "").split("?")[0] ?? "").replace(/\/+$/, "");
    const upstreamSlug = upstream.includes("clawhub.ai/") ? (upstream.split("/").pop() ?? "").trim() : "";
    const target = upstreamSlug ? bySlug.get(upstreamSlug.toLowerCase()) : undefined;
    let e: Entity;
    if (target) {
      e = target;
      e.shMatch = "upstream";
    } else {
      const key = `sh:${slug}`.toLowerCase();
      e = entities.get(key) ?? { key, name: slug, platform: "skillhub-cn" };
      entities.set(key, e);
      e.shMatch = upstreamSlug ? "upstream-unresolved" : "own";
    }
    const downloads = num(r["downloads"]);
    if (downloads !== undefined && (e.shDownloads === undefined || downloads > e.shDownloads)) {
      e.shDownloads = downloads;
      e.shInstalls = num(r["installs"]);
      e.shVerified = r["publisher_verified"] === "true";
      e.shCertifiedName = r["certified_name"] || undefined;
      e.shCreatedAt = r["created_at"];
      e.shUpdatedAt = r["updated_at"];
      if (!e.description && r["description"]) e.description = r["description"];
      if (r["description_zh"]) e.descriptionZh = r["description_zh"];
    }
  }

  // Buzz — searched by short name; attribute each name's signals to the most popular
  // same-name entity (discussion overwhelmingly refers to the well-known one) and flag it.
  const byName = new Map<string, Entity[]>();
  for (const e of entities.values()) {
    const n = e.name.trim().toLowerCase();
    byName.set(n, [...(byName.get(n) ?? []), e]);
  }
  for (const r of readIf(rawDir, "buzz")) {
    const nameKey = (r["skill_key"] ?? "").trim().toLowerCase();
    if (!nameKey) continue;
    const group = byName.get(nameKey);
    if (!group || group.length === 0) continue;
    const e = group.reduce((best, cur) =>
      (cur.ssInstalls ?? cur.chDownloads ?? cur.shDownloads ?? 0) > (best.ssInstalls ?? best.chDownloads ?? best.shDownloads ?? 0) ? cur : best,
    );
    e.hn = num(r["hn_hits_7d"]);
    e.hnRaw = num(r["hn_raw_7d"]);
    e.bsky = num(r["bsky_hits_7d"]);
    e.bskyRaw = num(r["bsky_raw_7d"]);
    e.ghMentions = num(r["gh_mentions_7d"]);
    e.xMentions = num(r["x_mentions_7d"]);
    e.xTruncated = r["x_truncated"] === "true";
    e.xEngagement = num(r["x_engagement_7d"]);
    e.buzzMeasured = [e.hn, e.bsky, e.ghMentions, e.xMentions].some((v) => v !== undefined);
    e.buzzShared = group.length > 1;
  }

  return entities;
}
