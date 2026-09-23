import { fetchJson, sleep } from "../lib/http.js";
import { env } from "../lib/env.js";
import { bskyLogin } from "../lib/bsky-auth.js";
import { githubToken } from "../lib/github-auth.js";
import { log } from "../lib/log.js";
import type { RawTable } from "../sources/types.js";
import type { JevClient } from "../judge/jev.js";
import type { BuzzTarget } from "./keywords.js";
import { estimateCount, RELEVANT_FROM, scoreRelevance, type Candidate } from "./relevance.js";

const WINDOW_DAYS = 7;
/** X requests are the only metered resource — keep its target list shorter. */
const X_TOP_N = 50;
const X_MAX_PAGES = 5;

interface XPost {
  skill_key: string;
  tweet_url: string;
  created_at: string;
  lang: string;
  favorites: number;
  retweets: number;
  /** jev P(post is about the skill); empty when the filter was unavailable. */
  relevance?: number;
}

interface BuzzRow {
  skill_key: string;
  query: string;
  hn_hits_7d?: number;
  hn_raw_7d?: number;
  bsky_hits_7d?: number;
  bsky_raw_7d?: number;
  gh_mentions_7d?: number;
  x_mentions_7d?: number;
  x_truncated: boolean;
  x_pages?: number;
  x_engagement_7d?: number;
  llm_filtered: boolean;
  /** In-window X posts before the relevance filter. */
  x_raw_7d?: number;
  x_filtered: boolean;
  /** Pinned jev model that scored this row's posts; empty when nothing was scored. */
  judge_model?: string;
}

interface HnHit {
  objectID?: string;
  title?: string;
  story_title?: string;
  comment_text?: string;
}

/** HN comment bodies are HTML; the relevance filter needs the words. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What the relevance filter reads for an HN hit. A story is its title. A comment is its
 * own text — its `title` is null, and falling through to `story_title` used to hand the
 * filter the parent thread's title instead of the comment that matched.
 */
function hnText(h: HnHit): string {
  const text = h.title ? h.title : h.comment_text ? plainText(h.comment_text) : (h.story_title ?? "");
  return text.slice(0, 300);
}

async function hnSearch(phrase: string, sinceEpoch: number): Promise<{ nbHits: number; hits: HnHit[] }> {
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(phrase)}` +
    `&hitsPerPage=30&advancedSyntax=true&numericFilters=created_at_i>${sinceEpoch}`;
  const d = await fetchJson<{ nbHits?: number; hits?: HnHit[] }>(url, { timeoutMs: 30_000 });
  return { nbHits: d.nbHits ?? 0, hits: d.hits ?? [] };
}

interface BskyPost {
  uri?: string;
  record?: { text?: string; createdAt?: string };
}

async function bskySearch(
  phrase: string,
  sinceIso: string,
  token: string | null,
): Promise<{ hitsTotal: number; posts: BskyPost[] }> {
  const url =
    `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(phrase)}` +
    `&limit=25&since=${encodeURIComponent(sinceIso)}`;
  // Anonymous search is throttled per source IP: trip it and it answers 403
  // ("forbidden by administrative rules") for roughly a minute — measured
  // 2026-08-17: 7 requests through, 13 straight refusals, recovery between +35s
  // and +65s. That outlasts any backoff worth putting in front of 100 targets, so
  // anonymous runs fail fast and let the circuit breaker skip the platform.
  // Authenticated runs are metered per account instead and do not hit that wall,
  // so they keep the normal retry budget for ordinary hiccups.
  const d = await fetchJson<{ hitsTotal?: number; posts?: BskyPost[] }>(url, {
    timeoutMs: 30_000,
    retries: token ? 2 : 0,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
  return { hitsTotal: d.hitsTotal ?? 0, posts: d.posts ?? [] };
}

async function ghMentions(name: string, sinceDate: string, token: string): Promise<number> {
  // GitHub search tokenizes hyphens ("to-issues" matches the everyday phrase "to issues")
  // and OR-groups of common words filter nothing. Measured winner: name in the TITLE plus
  // "skill" anywhere ("prototype": bare 74k → this query 47 true mentions).
  const q = `"${name}" in:title skill created:>${sinceDate}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`;
  const d = await fetchJson<{ total_count?: number }>(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 30_000,
  });
  return d.total_count ?? 0;
}

interface XTweet {
  tweet_id?: string;
  created_at?: string;
  lang?: string;
  favorites?: number;
  retweets?: number;
  text?: string;
}

async function xSearchPage(query: string, key: string, cursor?: string): Promise<{ timeline: XTweet[]; next?: string }> {
  const url =
    `https://twitter-api45.p.rapidapi.com/search.php?query=${encodeURIComponent(query)}&search_type=Latest` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const d = await fetchJson<{ timeline?: XTweet[]; next_cursor?: string }>(url, {
    headers: { "x-rapidapi-host": "twitter-api45.p.rapidapi.com", "x-rapidapi-key": key },
    timeoutMs: 60_000,
    retries: 2,
  });
  return { timeline: d.timeline ?? [], next: d.next_cursor };
}

export async function collectBuzz(targets: BuzzTarget[], jev: JevClient | null): Promise<RawTable[]> {
  const ghToken = githubToken();
  const rapidKey = env("RAPIDAPI_KEY");
  const bskyToken = await bskyLogin(); // null → anonymous, still works from a clean IP
  // Fix the window ONCE per run — per-request evaluation drifted the window during
  // the ~20 minute collection (audit B17).
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const sinceEpoch = Math.floor(windowStart.getTime() / 1000);
  const sinceIso = windowStart.toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const rows = new Map<string, BuzzRow>();
  for (const t of targets) {
    rows.set(t.key, {
      skill_key: t.key,
      query: t.phrase,
      x_truncated: false,
      llm_filtered: false,
      x_filtered: false,
    });
  }

  /** Run one platform over all targets with a circuit breaker: 5 consecutive failures → skip the rest. */
  const runPlatform = async (platform: string, paceMs: number, fn: (t: BuzzTarget) => Promise<void>): Promise<void> => {
    let consecutiveFails = 0;
    let done = 0;
    for (const t of targets) {
      try {
        await fn(t);
        consecutiveFails = 0;
        done++;
      } catch (err) {
        consecutiveFails++;
        log.warn(`buzz-${platform}`, `${t.key}: ${String(err)}`);
        if (consecutiveFails >= 5) {
          log.warn(`buzz-${platform}`, `circuit open after 5 consecutive failures — skipping the rest`);
          return;
        }
      }
      await sleep(paceMs);
    }
    log.info("buzz", `${platform} done (${done}/${targets.length})`);
  };

  // HN — pull candidate texts, then jev-score relevance; fall back to raw count explicitly
  await runPlatform("hn", 500, async (t) => {
    const { nbHits, hits } = await hnSearch(t.phrase, sinceEpoch);
    const row = rows.get(t.key)!;
    row.hn_raw_7d = nbHits;
    if (nbHits === 0) {
      row.hn_hits_7d = 0;
      return;
    }
    const candidates = hits
      .map((h): Candidate => ({ id: h.objectID ?? "", text: hnText(h) }))
      .filter((c) => c.id && c.text);
    const verdict = await scoreRelevance(jev, t.key, t.desc, candidates);
    if (verdict === null) {
      row.hn_hits_7d = nbHits; // explicit fallback to raw
    } else {
      // Scale the relevant share up to the full hit count when the page sampled a subset
      row.hn_hits_7d = estimateCount(verdict, candidates, nbHits);
      row.llm_filtered = true;
      row.judge_model = jev?.model;
    }
  });

  // Bluesky — same pattern
  await runPlatform("bsky", 1200, async (t) => {
    const { hitsTotal, posts } = await bskySearch(t.phrase, sinceIso, bskyToken);
    const row = rows.get(t.key)!;
    row.bsky_raw_7d = hitsTotal;
    if (hitsTotal === 0) {
      row.bsky_hits_7d = 0;
      return;
    }
    const candidates = posts
      .map((p, i): Candidate => ({ id: String(i), text: (p.record?.text ?? "").slice(0, 300) }))
      .filter((c) => c.text);
    const verdict = await scoreRelevance(jev, t.key, t.desc, candidates);
    if (verdict === null) {
      row.bsky_hits_7d = hitsTotal;
    } else {
      row.bsky_hits_7d = estimateCount(verdict, candidates, hitsTotal);
      row.llm_filtered = true;
      row.judge_model = jev?.model;
    }
  });

  // GitHub search — 30 req/min hard limit; 2.5s leaves headroom for retries (audit B11)
  await runPlatform("gh", 2500, async (t) => {
    rows.get(t.key)!.gh_mentions_7d = await ghMentions(t.key, sinceDate, ghToken);
  });

  // X — metered; top slice only, paginate past the 20/page cap until the window is covered
  const posts: XPost[] = [];
  if (rapidKey) {
    const xTargets = targets.slice(0, X_TOP_N);
    let requests = 0;
    for (const t of xTargets) {
      try {
        let cursor: string | undefined;
        let pages = 0;
        let windowExhausted = false;
        // In-window posts of this target, with their text kept in memory for the relevance filter
        const inWindow: Array<{ post: XPost; text: string }> = [];
        while (pages < X_MAX_PAGES) {
          const { timeline, next } = await xSearchPage(t.xQuery, rapidKey, cursor);
          requests++;
          pages++;
          if (timeline.length === 0) {
            windowExhausted = true;
            break;
          }
          let sawOutside = false;
          for (const p of timeline) {
            const d = p.created_at ? new Date(p.created_at) : null;
            if (d === null || Number.isNaN(d.getTime())) continue;
            if (d >= windowStart) {
              inWindow.push({
                post: {
                  skill_key: t.key,
                  tweet_url: p.tweet_id ? `https://x.com/i/status/${p.tweet_id}` : "",
                  // normalize Twitter's legacy date format to ISO like every other column (audit PL-15)
                  created_at: d.toISOString(),
                  lang: p.lang ?? "",
                  favorites: p.favorites ?? 0,
                  retweets: p.retweets ?? 0,
                },
                text: (p.text ?? "").slice(0, 300),
              });
            } else {
              sawOutside = true;
            }
          }
          if (sawOutside || !next) {
            windowExhausted = true;
            break;
          }
          cursor = next;
          await sleep(1200);
        }
        // X was the one unfiltered channel: its context-word query still matches everyday
        // uses of the name, and one post matching several names counted for each of them.
        const candidates = inWindow.map(({ text }, i): Candidate => ({ id: String(i), text })).filter((c) => c.text);
        // Nothing to check → no verdict, so x_filtered stays false like HN/Bluesky with zero hits.
        const verdict = candidates.length > 0 ? await scoreRelevance(jev, t.key, t.desc, candidates) : null;
        // Without a verdict every post counts, as before the filter existed.
        const counts = (i: number): boolean => verdict === null || (verdict.get(String(i)) ?? 0) >= RELEVANT_FROM;
        inWindow.forEach(({ post }, i) => {
          const p = verdict?.get(String(i));
          if (p !== undefined) post.relevance = Math.round(p * 100) / 100;
          if (post.tweet_url) posts.push(post);
        });
        const row = rows.get(t.key)!;
        row.x_raw_7d = inWindow.length;
        row.x_mentions_7d = inWindow.filter((_, i) => counts(i)).length;
        row.x_filtered = verdict !== null;
        if (verdict !== null) row.judge_model = jev?.model;
        row.x_pages = pages;
        row.x_truncated = !windowExhausted; // hit the page cap before leaving the window
        row.x_engagement_7d = inWindow.reduce(
          (sum, { post }, i) => sum + (counts(i) ? post.favorites + post.retweets : 0),
          0,
        );
      } catch (err) {
        log.warn("buzz-x", `${t.key}: ${String(err)}`);
      }
      await sleep(1500);
    }
    log.info("buzz", `X done (${xTargets.length} skills, ${requests} requests, ${posts.length} posts)`);
  } else {
    log.warn("buzz", "RAPIDAPI_KEY not set — skipping X");
  }

  return [
    {
      name: "buzz",
      columns: [
        "skill_key", "query", "hn_hits_7d", "hn_raw_7d", "bsky_hits_7d", "bsky_raw_7d",
        "gh_mentions_7d", "x_mentions_7d", "x_truncated", "x_pages", "x_engagement_7d", "llm_filtered",
        // Appended in v1.5 — existing columns keep their positions
        "x_raw_7d", "x_filtered", "judge_model",
      ],
      rows: [...rows.values()].map((r) => ({ ...r })),
    },
    {
      // Only links + metrics are published — post texts never leave the runner (compliance).
      name: "x-posts",
      columns: ["skill_key", "tweet_url", "created_at", "lang", "favorites", "retweets", "relevance"],
      rows: posts.map((p) => ({ ...p })),
    },
  ];
}
