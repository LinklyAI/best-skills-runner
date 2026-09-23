import { log } from "../lib/log.js";
import { noulOf, type JevClient, type NoulQuestion } from "../judge/jev.js";

/** Posts per jev request. One request carries every item plus one question per item. */
const BATCH = 50;

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

/**
 * Relevance probability per candidate, from jev.
 *
 * Returns null when jev is unavailable or every batch failed, so callers can fall back
 * to raw counts EXPLICITLY instead of silently zeroing (audit B10). Candidates missing
 * from a partially failed run are left out of the map; callers scale over what was scored.
 */
export async function scoreRelevance(
  jev: JevClient | null,
  skillName: string,
  skillDesc: string | undefined,
  candidates: Candidate[],
): Promise<Map<string, number> | null> {
  if (!jev) return null;
  if (candidates.length === 0) return new Map();

  const out = new Map<string, number>();
  let anySuccess = false;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    // Positional keys keep ids like HN objectIDs or Bluesky indexes out of the prompt.
    const items: Record<string, string> = {};
    const questions: Record<string, NoulQuestion> = {};
    batch.forEach((c, j) => {
      const key = `i${j}`;
      items[key] = c.text;
      questions[key] = question(key);
    });
    try {
      const res = await jev.ask({ skill: skillName, description: skillDesc?.slice(0, 300), items }, questions);
      batch.forEach((c, j) => {
        const p = noulOf(res.answers[`i${j}`]);
        if (p !== undefined) out.set(c.id, p);
      });
      anySuccess = true;
    } catch (err) {
      log.warn("relevance", `${skillName} batch ${i / BATCH}: ${String(err)}`);
    }
  }
  return anySuccess ? out : null;
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
