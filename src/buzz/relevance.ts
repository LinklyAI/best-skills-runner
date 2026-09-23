import { log } from "../lib/log.js";
import { JEV_CONCURRENCY, mapLimit, noulOf, type JevClient, type NoulQuestion } from "../judge/jev.js";

/**
 * A post counts as a mention when P(relevant) reaches this. Summing raw probabilities
 * instead was tried and rejected: jev leaves a 0.02–0.05 floor on clearly unrelated
 * posts, and on a noisy name that floor adds up to phantom mentions (measured on
 * "github": 188 HN hits, where the old yes/no filter had counted 0, summed to 15).
 */
export const RELEVANT_FROM = 0.5;

export interface Candidate {
  id: string;
  text: string;
}

/**
 * Posts per jev request — every post of one search fits in a single request (HN 30,
 * Bluesky 25, X up to 100). jev is built for this: one `state`, many questions answered
 * together, the state billed once.
 */
const BATCH = 100;

const CRITERIA: NoulQuestion["criteria"] = {
  true:
    "The item is genuinely about the named AI agent skill / tool: installing it, using it, " +
    "or discussing it as an AI agent / Claude / LLM skill.",
  false:
    "The item only shares words with the skill name — for example it is about the everyday topic " +
    "(a weather app, the GitHub platform itself, a product prototype) or about a different product " +
    "with the same name — without referring to the AI agent skill.",
};

function question(itemKey: string): NoulQuestion {
  return {
    type: "noul",
    instructions:
      `Consider only item \`items.${itemKey}\`. Is it genuinely about the AI agent skill named \`skill\` ` +
      "(see `description` when present)? When the skill name is an everyday word or phrase, the item counts " +
      "only if it explicitly refers to an AI agent / Claude / LLM skill or tool by that name.",
    criteria: CRITERIA,
  };
}

/** The posts one platform search returned for one skill. */
export interface RelevanceJob {
  skill: string;
  desc?: string;
  candidates: Candidate[];
}

/** One jev request: every post of the batch in `items`, one question per post. */
async function judgeBatch(jev: JevClient, job: RelevanceJob, batch: Candidate[], out: Map<string, number>): Promise<void> {
  const items: Record<string, string> = {};
  const questions: Record<string, NoulQuestion> = {};
  // Positional keys keep ids like HN objectIDs or Bluesky indexes out of the prompt.
  batch.forEach((c, i) => {
    items[`i${i}`] = c.text;
    questions[`i${i}`] = question(`i${i}`);
  });
  const res = await jev.ask({ skill: job.skill, description: job.desc?.slice(0, 300), items }, questions);
  batch.forEach((c, i) => {
    const p = noulOf(res.answers[`i${i}`]);
    if (p !== undefined) out.set(c.id, p);
  });
}

/**
 * Relevance probability per post, from jev. Each search is one request that asks about
 * all of its posts at once; searches are only collected while the platforms are paced,
 * then judged together here.
 *
 * Returns one verdict per job, in order. A verdict is null when jev is unavailable or
 * every request of that job failed, so callers can fall back to raw counts EXPLICITLY
 * instead of silently zeroing (audit B10). Posts of a failed batch are left out of the
 * map; callers scale over what was scored.
 */
export async function scoreRelevance(
  jev: JevClient | null,
  jobs: RelevanceJob[],
): Promise<Array<Map<string, number> | null>> {
  if (!jev) return jobs.map(() => null);

  const tasks = jobs.flatMap((job, j) => {
    const batches: Array<{ job: RelevanceJob; j: number; batch: Candidate[] }> = [];
    for (let i = 0; i < job.candidates.length; i += BATCH) batches.push({ job, j, batch: job.candidates.slice(i, i + BATCH) });
    return batches;
  });
  const verdicts = jobs.map(() => new Map<string, number>());
  let failed = 0;
  const started = Date.now();
  await mapLimit(tasks, JEV_CONCURRENCY, async ({ job, j, batch }) => {
    try {
      await judgeBatch(jev, job, batch, verdicts[j]!);
    } catch (err) {
      failed++;
      if (failed <= 5) log.warn("relevance", `${job.skill}: ${String(err)}`);
    }
  });
  const posts = jobs.reduce((n, job) => n + job.candidates.length, 0);
  log.info(
    "relevance",
    `${posts} posts of ${jobs.length} searches judged in ${tasks.length} requests, ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s` +
      (failed > 0 ? ` (${failed} failed)` : ""),
  );
  // A job with posts but no successful answer has no verdict; a job with no posts has an empty one.
  return jobs.map((job, j) => (job.candidates.length > 0 && verdicts[j]?.size === 0 ? null : (verdicts[j] ?? null)));
}

/**
 * Scale the relevant share of a sample up to the platform's total hit count.
 * `sampled` is the candidate list the probabilities were requested for.
 */
export function estimateCount(verdict: Map<string, number>, sampled: Candidate[], total: number): number {
  const scored = sampled.filter((c) => verdict.has(c.id));
  if (scored.length === 0) return 0;
  const relevant = scored.filter((c) => (verdict.get(c.id) ?? 0) >= RELEVANT_FROM).length;
  return Math.round((relevant / scored.length) * total);
}
