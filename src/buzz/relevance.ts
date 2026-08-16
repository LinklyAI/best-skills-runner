import { env } from "../lib/env.js";
import { log } from "../lib/log.js";
import { sleep } from "../lib/http.js";

const BATCH = 30;
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

export interface Candidate {
  id: string;
  text: string;
}

const SYSTEM_PROMPT =
  "You filter search results for an AI agent-skills popularity index. " +
  "Given a skill name (and optional description) plus a list of posts/titles that matched a keyword search, " +
  "decide for each item whether it is genuinely about that AI agent skill / tool " +
  "(installing it, using it, discussing it) — as opposed to an unrelated everyday use of the same words. " +
  "When the skill name is an everyday word (weather, github, prototype…), an item is relevant ONLY if it " +
  "explicitly refers to an AI agent / Claude / LLM skill by that name — a post merely about the everyday topic " +
  "(a weather app, the GitHub platform itself) is NOT relevant, even if it matches the description's subject. " +
  'Respond with ONLY a JSON object mapping each item id to true (relevant) or false. When unsure, answer false.';

/**
 * LLM relevance filter. Returns null when the LLM is unavailable or every batch failed,
 * so callers can fall back to raw counts EXPLICITLY instead of silently zeroing (audit B10).
 */
export async function filterRelevant(
  skillName: string,
  skillDesc: string | undefined,
  candidates: Candidate[],
): Promise<Map<string, boolean> | null> {
  if (candidates.length === 0) return new Map();
  const apiBase = env("LLM_API_BASE");
  const apiKey = env("LLM_API_KEY");
  if (!apiBase || !apiKey) return null;
  const model = env("LLM_MODEL") ?? DEFAULT_MODEL;

  const out = new Map<string, boolean>();
  let anySuccess = false;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    try {
      const res = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({ skill: skillName, description: skillDesc?.slice(0, 150), items: batch }),
            },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("no JSON in LLM output");
      for (const [id, v] of Object.entries(JSON.parse(jsonMatch[0]) as Record<string, unknown>)) {
        out.set(id, v === true || v === "true");
      }
      anySuccess = true;
    } catch (err) {
      log.warn("relevance", `${skillName} batch ${i / BATCH}: ${String(err)}`);
    }
    await sleep(300);
  }
  return anySuccess ? out : null;
}
