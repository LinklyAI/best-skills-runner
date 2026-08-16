import { fetchJson, sleep } from "../lib/http.js";
import { log } from "../lib/log.js";
import type { Collector, RawTable } from "./types.js";

const BASE = "https://api.skillhub.cn";
const TARGET = 1000;
const PAGE_SIZE = 100;

interface SkillHubSkill {
  slug: string;
  name?: string;
  namespace?: { canonicalName?: string; handle?: string };
  downloads?: number;
  installs?: number;
  stars?: number;
  source?: string;
  category?: string;
  publisher?: { name?: string; verified?: boolean; certifiedName?: string };
  created_at?: number;
  updated_at?: number;
  version?: string;
  upstream_url?: string | null;
  description?: string;
  description_zh?: string;
}

interface ListResponse {
  code: number;
  data?: { skills?: SkillHubSkill[]; total?: number };
}

async function fetchPage(page: number, source?: string): Promise<SkillHubSkill[]> {
  const url = new URL(`${BASE}/api/skills`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("sortBy", "downloads");
  if (source) url.searchParams.set("source", source);
  const res = await fetchJson<ListResponse>(url.toString());
  if (res.code !== 0) throw new Error(`skillhub: API code ${res.code}`);
  return res.data?.skills ?? [];
}

function toRow(s: SkillHubSkill, i: number) {
  return {
    rank: i + 1,
    slug: s.slug,
    canonical_name: s.namespace?.canonicalName,
    downloads: s.downloads,
    installs: s.installs,
    stars: s.stars,
    source: s.source,
    category: s.category,
    publisher: s.publisher?.name,
    publisher_verified: s.publisher?.verified ?? false,
    certified_name: s.publisher?.certifiedName,
    upstream_url: s.upstream_url ?? undefined,
    created_at: s.created_at ? new Date(s.created_at).toISOString().slice(0, 10) : undefined,
    updated_at: s.updated_at ? new Date(s.updated_at).toISOString().slice(0, 10) : undefined,
    version: s.version,
    description: s.description?.slice(0, 200).replace(/\s+/g, " "),
    description_zh: s.description_zh?.slice(0, 200).replace(/\s+/g, " "),
  };
}

const COLUMNS = [
  "rank", "slug", "canonical_name", "downloads", "installs", "stars", "source", "category",
  "publisher", "publisher_verified", "certified_name", "upstream_url", "created_at", "updated_at", "version",
  "description", "description_zh",
];

export const skillhub: Collector = {
  id: "skillhub",

  async probe(): Promise<string> {
    const skills = await fetchPage(1);
    const top = skills[0];
    if (!top) throw new Error("skillhub: empty first page");
    return `top1 = ${top.slug} (${top.downloads} downloads)`;
  },

  async collect(): Promise<RawTable[]> {
    const all: SkillHubSkill[] = [];
    for (let page = 1; all.length < TARGET; page++) {
      const skills = await fetchPage(page);
      if (skills.length === 0) break;
      all.push(...skills);
      await sleep(800);
    }
    if (all.length === 0) throw new Error("skillhub: parsed 0 skills — API may have changed");
    log.info("skillhub", `collected ${all.length} skills (all sources)`);

    const enterprise: SkillHubSkill[] = [];
    for (let page = 1; enterprise.length < TARGET; page++) {
      const skills = await fetchPage(page, "enterprise");
      if (skills.length === 0) break;
      enterprise.push(...skills);
      await sleep(800);
    }
    log.info("skillhub", `enterprise: ${enterprise.length} skills`);

    return [
      { name: "skillhub", columns: COLUMNS, rows: all.slice(0, TARGET).map(toRow) },
      { name: "skillhub-enterprise", columns: COLUMNS, rows: enterprise.slice(0, TARGET).map(toRow) },
    ];
  },
};
