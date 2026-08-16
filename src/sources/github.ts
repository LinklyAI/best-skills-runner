import { fetchJson, sleep } from "../lib/http.js";
// Note: GraphQL calls below use fetch directly (POST); fetchJson is GET-only.
import { githubToken } from "../lib/github-auth.js";
import { log } from "../lib/log.js";
import type { RawTable } from "./types.js";

const SEED_URL = "https://raw.githubusercontent.com/Chat2AnyLLM/awesome-repo-configs/main/skill_repos.json";
const BATCH = 100;

/** Accepts "owner/repo", full GitHub URLs, or objects with a repo-ish field. */
function normalizeRepoRef(entry: unknown): string | null {
  let s: string | null = null;
  if (typeof entry === "string") s = entry;
  else if (entry && typeof entry === "object") {
    const o = entry as Record<string, unknown>;
    const cand = o["full_name"] ?? o["repo"] ?? o["name"] ?? o["url"] ?? o["html_url"];
    if (typeof cand === "string") s = cand;
  }
  if (!s) return null;
  const m = s.match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git|\/.*)?$/);
  if (!m || !m[1] || !m[2]) return null;
  if (m[1].includes(".") && !s.includes("github.com")) return null; // skip non-github hosts like open.feishu.cn
  return `${m[1]}/${m[2]}`;
}

async function fetchSeeds(): Promise<string[]> {
  const data = await fetchJson<unknown>(SEED_URL);
  // Current format: an object keyed by "owner/repo". Also accept arrays of refs, defensively.
  const list = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null
      ? Object.keys(data)
      : [];
  const repos = list.map(normalizeRepoRef).filter((r): r is string => r !== null);
  if (repos.length === 0) throw new Error("seed list parsed to 0 repos — format may have changed");
  return [...new Set(repos)];
}

interface RepoStat {
  repo: string;
  stars: number;
  pushed_at: string;
  archived: boolean;
  topics: string;
  description: string;
}

interface GqlRepo {
  nameWithOwner: string;
  stargazerCount: number;
  pushedAt: string | null;
  isArchived: boolean;
  description: string | null;
  repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
}

async function fetchStats(repos: string[], token: string): Promise<RepoStat[]> {
  const out: RepoStat[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < repos.length; i += BATCH) {
    const batch = repos.slice(i, i + BATCH);
    const fields = batch
      .map((r, j) => {
        const [owner, name] = r.split("/");
        return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner stargazerCount pushedAt isArchived description repositoryTopics(first: 10) { nodes { topic { name } } } }`;
      })
      .join("\n");
    const resp = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query {\n${fields}\n}` }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`GitHub GraphQL HTTP ${resp.status}`);
    const json = (await resp.json()) as { data?: Record<string, GqlRepo | null> | null; errors?: Array<{ type?: string }> };
    // GraphQL errors often come back as HTTP 200 with data: null — do not swallow a whole batch (audit B21)
    if (!json.data) {
      const kinds = [...new Set((json.errors ?? []).map((e) => e.type ?? "unknown"))].join(",");
      throw new Error(`GitHub GraphQL returned no data (errors: ${kinds || "none"})`);
    }
    let got = 0;
    for (let j = 0; j < batch.length; j++) {
      const stat = json.data[`r${j}`];
      if (!stat) continue; // renamed/deleted/blocked repo — expected per-alias null
      const canonical = stat.nameWithOwner; // dedupe renamed repos (audit: shadcn/ui + shadcn-ui/ui)
      if (seen.has(canonical.toLowerCase())) continue;
      seen.add(canonical.toLowerCase());
      out.push({
        repo: canonical,
        stars: stat.stargazerCount,
        pushed_at: stat.pushedAt ? stat.pushedAt.slice(0, 10) : "",
        archived: stat.isArchived,
        topics: stat.repositoryTopics.nodes.map((n) => n.topic.name).join("|"),
        description: (stat.description ?? "").slice(0, 150).replace(/\s+/g, " "),
      });
      got++;
    }
    if (got === 0 && batch.length > 10) log.warn("github", `batch at ${i}: 0/${batch.length} repos resolved`);
    log.info("github", `stats ${Math.min(i + BATCH, repos.length)}/${repos.length}`);
    await sleep(500);
  }
  return out;
}

export const githubSource = {
  id: "github",

  async probe(): Promise<string> {
    const token = githubToken();
    const stats = await fetchStats(["anthropics/skills"], token);
    const s = stats[0];
    if (!s) throw new Error("github: GraphQL returned no data for anthropics/skills");
    return `anthropics/skills = ${s.stars} stars, pushed ${s.pushed_at}`;
  },

  /** @param extraRepos repos discovered from today's registry data (e.g. skills.sh sources) */
  async collect(extraRepos: string[]): Promise<RawTable[]> {
    const token = githubToken();
    const seeds = await fetchSeeds().catch((err) => {
      log.warn("github", `seed list unavailable (${String(err)}), continuing with registry-discovered repos only`);
      return [] as string[];
    });
    const fromRegistry = extraRepos.map(normalizeRepoRef).filter((r): r is string => r !== null);
    const repos = [...new Set([...seeds, ...fromRegistry])];
    log.info("github", `star snapshot for ${repos.length} repos (${seeds.length} seed + ${fromRegistry.length} registry)`);
    if (repos.length === 0) throw new Error("github: no repos to snapshot");

    const stats = await fetchStats(repos, token);
    stats.sort((a, b) => b.stars - a.stars);
    return [
      {
        name: "github-repos",
        columns: ["rank", "repo", "stars", "pushed_at", "archived", "topics", "description"],
        rows: stats.map((s, i) => ({ rank: i + 1, ...s })),
      },
    ];
  },
};
