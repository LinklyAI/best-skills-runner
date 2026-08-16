import { fetchJson, sleep } from "../lib/http.js";
import { log } from "../lib/log.js";
import type { Collector, RawTable } from "./types.js";

const BASE = "https://clawhub.ai";
const TARGET = 1000;
const PAGE_LIMIT = 100;

interface ClawHubSkill {
  slug: string;
  displayName?: string;
  summary?: string;
  topics?: string[];
  stats?: { comments?: number; downloads?: number; installs?: number; stars?: number; versions?: number };
  createdAt?: number;
  updatedAt?: number;
  latestVersion?: { version?: string; createdAt?: number };
}

interface ListResponse {
  skills?: ClawHubSkill[];
  items?: ClawHubSkill[];
  nextCursor?: string;
}

interface FeedEntry {
  id: string;
  title?: string;
  version?: string;
  featured?: boolean;
  publisher?: { id?: string; trust?: string };
}

async function fetchPage(cursor?: string): Promise<ListResponse> {
  const url = new URL(`${BASE}/api/v1/skills`);
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (cursor) url.searchParams.set("cursor", cursor);
  return fetchJson<ListResponse>(url.toString());
}

export const clawhub: Collector = {
  id: "clawhub",

  async probe(): Promise<string> {
    const page = await fetchPage();
    const items = page.skills ?? page.items ?? [];
    const top = items[0];
    if (!top) throw new Error("clawhub: empty first page");
    return `top1 = ${top.slug} (${top.stats?.downloads} downloads)`;
  },

  async collect(): Promise<RawTable[]> {
    const all: ClawHubSkill[] = [];
    let cursor: string | undefined;
    while (all.length < TARGET) {
      const page = await fetchPage(cursor);
      const items = page.skills ?? page.items ?? [];
      if (items.length === 0) break;
      all.push(...items);
      cursor = page.nextCursor;
      if (!cursor) break;
      await sleep(800);
    }
    if (all.length === 0) throw new Error("clawhub: parsed 0 skills — API may have changed");
    // Sanity: verify the sort we asked for is actually applied (params are silently ignored on change)
    const d0 = all[0]?.stats?.downloads ?? 0;
    const d9 = all[Math.min(9, all.length - 1)]?.stats?.downloads ?? 0;
    if (d0 < d9) throw new Error("clawhub: response not sorted by downloads — API contract changed");
    log.info("clawhub", `collected ${all.length} skills`);

    await sleep(800);
    const feed = await fetchJson<{ entries?: FeedEntry[] }>(`${BASE}/v1/feeds/skills`);
    const entries = feed.entries ?? [];
    log.info("clawhub", `official feed: ${entries.length} entries`);

    return [
      {
        name: "clawhub",
        columns: ["rank", "slug", "display_name", "summary", "downloads", "installs", "stars", "comments", "versions", "created_at", "updated_at", "latest_version", "topics"],
        rows: all.slice(0, TARGET).map((s, i) => ({
          rank: i + 1,
          slug: s.slug,
          display_name: s.displayName,
          summary: s.summary?.slice(0, 200).replace(/\s+/g, " "),
          downloads: s.stats?.downloads,
          installs: s.stats?.installs,
          stars: s.stats?.stars,
          comments: s.stats?.comments,
          versions: s.stats?.versions,
          created_at: s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : undefined,
          updated_at: s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 10) : undefined,
          latest_version: s.latestVersion?.version,
          topics: s.topics?.join("|"),
        })),
      },
      {
        name: "clawhub-official",
        columns: ["id", "title", "version", "featured", "publisher", "trust"],
        rows: entries.map((e) => ({
          id: e.id,
          title: e.title,
          version: e.version,
          featured: e.featured ?? false,
          publisher: e.publisher?.id,
          trust: e.publisher?.trust,
        })),
      },
    ];
  },
};
