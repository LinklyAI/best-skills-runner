import { env } from "../lib/env.js";
import { describeHttpError, sleep } from "../lib/http.js";
import { log } from "../lib/log.js";

/**
 * Client for jev, TypeSafe's decision model, reached through OpenRouter's System One
 * endpoint (`POST {LLM_API_BASE}/systemone`).
 *
 * jev answers typed questions about a `state` object and returns calibrated
 * probabilities instead of generated text: `noul` = P(yes), `choice` = one option plus
 * a probability per option. Every judgement in the pipeline (post relevance, entity
 * quality, categories) goes through here.
 *
 * The version is pinned on purpose: the thresholds in judge/ and buzz/ were tuned
 * against it, and the `~latest` alias would move them silently on the next release.
 * Skill judgements record the dated `model` the endpoint actually served.
 */
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

// OpenRouter app attribution, so these requests show up as best-skills in its dashboard.
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/LinklyAI/best-skills",
  "X-Title": "best-skills",
};

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option id → what the option covers. */
  criteria: Record<string, string>;
}

export type JevQuestion = NoulQuestion | ChoiceQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer;

export interface JevResult {
  /** Dated model id the endpoint served, e.g. typesafe/jev-1.13-20260917. */
  model: string;
  answers: Record<string, JevAnswer>;
}

export interface JevClient {
  model: string;
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult>;
}

const RETRIES = 4;

/** A request the endpoint rejected on its merits (bad body, bad key) — retrying cannot help. */
class FatalJevError extends Error {}

/** 429 = rate limited, 529 = overloaded, 5xx = transient; 4xx otherwise means a bad request. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Returns null when LLM_API_BASE / LLM_API_KEY are unset — callers degrade explicitly. */
export function jevClient(): JevClient | null {
  const apiBase = env("LLM_API_BASE");
  const apiKey = env("LLM_API_KEY");
  if (!apiBase || !apiKey) return null;
  const model = env("LLM_MODEL") ?? DEFAULT_JEV_MODEL;
  const url = `${apiBase.replace(/\/+$/, "")}/systemone`;

  const ask = async (state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...APP_HEADERS },
          body: JSON.stringify({ model, state, questions }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const data = (await res.json()) as Partial<JevResult>;
          if (!data.answers) throw new Error("jev response has no answers");
          return { model: data.model ?? model, answers: data.answers };
        }
        const diag = await describeHttpError(res);
        if (!isRetryable(res.status)) throw new FatalJevError(`jev ${diag}`);
        lastErr = new Error(`jev ${diag}`);
      } catch (err) {
        // Rejected requests surface immediately; throttling, network errors and timeouts retry.
        if (err instanceof FatalJevError) throw err;
        lastErr = err;
      }
      if (attempt < RETRIES) {
        const delay = 1_000 * 2 ** attempt + Math.floor(Math.random() * 500);
        log.info("jev", `${String(lastErr)}, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
    throw new Error(`jev failed after ${RETRIES + 1} attempts: ${String(lastErr)}`);
  };

  return { model, ask };
}

/** P(yes) of a noul answer; undefined when the answer is missing or malformed. */
export function noulOf(answer: JevAnswer | undefined): number | undefined {
  return answer?.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : undefined;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. The endpoint's rate limit is
 * shared per key and starts refusing around 8 concurrent requests, so callers stay
 * well below that.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
