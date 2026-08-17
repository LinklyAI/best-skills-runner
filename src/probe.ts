import { skillsSh } from "./sources/skills-sh.js";
import { clawhub } from "./sources/clawhub.js";
import { skillhub } from "./sources/skillhub.js";
import { githubSource } from "./sources/github.js";
import { fetchJson } from "./lib/http.js";
import { env } from "./lib/env.js";
import { log } from "./lib/log.js";

interface ProbeTarget {
  id: string;
  probe(): Promise<string>;
}

// A probe has to exercise the same request the collectors make — same User-Agent,
// same error reporting — or "the probe says it is fine" proves nothing about the
// pipeline. Retries stay off: a probe reports the state now, it does not wait it out.
const PROBE_OPTS = { timeoutMs: 30_000, retries: 0 } as const;

const targets: ProbeTarget[] = [
  skillsSh,
  clawhub,
  skillhub,
  githubSource,
  {
    id: "hn-algolia",
    async probe(): Promise<string> {
      const d = await fetchJson<{ nbHits?: number }>(
        "https://hn.algolia.com/api/v1/search_by_date?query=%22claude%20skills%22&hitsPerPage=1",
        PROBE_OPTS,
      );
      return `nbHits=${d.nbHits}`;
    },
  },
  {
    id: "bluesky",
    async probe(): Promise<string> {
      const d = await fetchJson<{ hitsTotal?: number }>(
        "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=%22claude%20skills%22&limit=1",
        PROBE_OPTS,
      );
      return `hitsTotal=${d.hitsTotal}`;
    },
  },
  {
    id: "x-rapidapi",
    async probe(): Promise<string> {
      const key = env("RAPIDAPI_KEY");
      if (!key) throw new Error("RAPIDAPI_KEY not set");
      const d = await fetchJson<{ status?: string; timeline?: unknown[] }>(
        "https://twitter-api45.p.rapidapi.com/search.php?query=claude%20skills&search_type=Latest",
        {
          ...PROBE_OPTS,
          timeoutMs: 60_000,
          headers: { "x-rapidapi-host": "twitter-api45.p.rapidapi.com", "x-rapidapi-key": key },
        },
      );
      return `status=${d.status} items=${d.timeline?.length}`;
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const t of targets) {
    try {
      const info = await t.probe();
      log.info("probe", `✅ ${t.id}: ${info}`);
    } catch (err) {
      failed++;
      log.error("probe", `❌ ${t.id}: ${String(err)}`);
    }
  }
  log.info("probe", failed === 0 ? "all sources reachable" : `${failed}/${targets.length} sources FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
