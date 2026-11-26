import { env } from "../lib/env.js";
import { describeHttpError, sleep } from "../lib/http.js";

/**
 * Writes the explanatory text of a detail page from the skill's SKILL.md. The model
 * returns JSON only; the page template places it. It never writes numbers about
 * popularity — those come from the data — and never invents examples.
 */

export const DEFAULT_DETAIL_MODEL = "anthropic/claude-haiku-5.5";
export const ABOUT_LANGS = ["en", "zh"] as const;
export type AboutLang = (typeof ABOUT_LANGS)[number];

export interface AboutText {
  /** Short line after the skill name in the page title: what it is for. */
  tagline: string;
  /** Two or three sentences: what the skill does and what problem it solves. */
  summary: string;
  /** Paragraphs for "what problem it solves". */
  problem: string[];
  fit: string[];
  unfit: string[];
  /** How it works, in order. */
  steps: string[];
}

export type About = Record<AboutLang, AboutText>;

export interface DescribeInput {
  name: string;
  platform: string;
  listing?: string;
  markdown: string;
}

export interface DescribeClient {
  model: string;
  describe(input: DescribeInput): Promise<About>;
}

// OpenRouter app attribution (team rule: X-Title starts with "Linkly AI").
const APP_HEADERS = {
  "HTTP-Referer": "https://linkly.ai",
  "X-Title": "Linkly AI best-skills-detail",
};

const MAX_INPUT_CHARS = 24_000;
const RETRIES = 3;

const SYSTEM = `You write the explanation on a web page about one AI agent skill. Read the skill's SKILL.md and return JSON only, no prose around it.

Write for a developer deciding whether to install the skill. Plain, short sentences. Name things the way the skill's users would. No marketing words, no hype, no metaphors, no emoji.

Rules:
- Use only what SKILL.md says. Do not invent features, examples, commands, file names or numbers.
- Never mention installs, downloads, stars, rankings or popularity.
- If SKILL.md is unclear about something, leave it out rather than guess.
- "tagline": what the skill is for, as a short phrase without the skill name (en: at most 60 characters; zh: at most 24 Chinese characters).
- "summary": 2-3 sentences: what it does and the problem it solves.
- "problem": 1-2 short paragraphs on the situation it helps with and what changes when it is used.
- "fit": 2-3 situations where it helps. "unfit": 1-2 situations where it does not help. Short phrases.
- "steps": 3-6 steps of how it works, in order, each one sentence. Inline code in backticks is fine.
- Write the same content in English ("en") and Simplified Chinese ("zh"). The Chinese is natural Chinese, not a word-for-word translation; keep code, commands and product names as they are.

Return exactly:
{"en":{"tagline":"","summary":"","problem":[""],"fit":[""],"unfit":[""],"steps":[""]},"zh":{...same keys...}}`;

function isStrings(v: unknown, min: number, max: number): v is string[] {
  return Array.isArray(v) && v.length >= min && v.length <= max && v.every((s) => typeof s === "string" && s.trim() !== "");
}

/** Validates the model's JSON; throws with the reason so the skill is retried next run. */
export function parseAbout(text: string): About {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in reply");
  const data = JSON.parse(text.slice(start, end + 1)) as Record<string, Record<string, unknown>>;
  const out = {} as About;
  for (const lang of ABOUT_LANGS) {
    const t = data[lang];
    if (!t) throw new Error(`missing ${lang}`);
    const str = (k: string) => {
      const v = t[k];
      if (typeof v !== "string" || !v.trim()) throw new Error(`${lang}.${k} missing`);
      return v.trim();
    };
    const list = (k: string, min: number, max: number) => {
      const v = t[k];
      if (!isStrings(v, min, max)) throw new Error(`${lang}.${k} must be ${min}-${max} strings`);
      return v.map((s) => s.trim());
    };
    out[lang] = {
      tagline: str("tagline"),
      summary: str("summary"),
      problem: list("problem", 1, 3),
      fit: list("fit", 1, 4),
      unfit: list("unfit", 1, 3),
      steps: list("steps", 2, 8),
    };
  }
  return out;
}

/** Returns null when LLM_API_BASE / LLM_API_KEY are unset — pages then ship without AI text. */
export function describeClient(): DescribeClient | null {
  const apiBase = env("LLM_API_BASE");
  const apiKey = env("LLM_API_KEY");
  if (!apiBase || !apiKey) return null;
  const model = env("DETAIL_MODEL") ?? DEFAULT_DETAIL_MODEL;
  const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;

  const describe = async (input: DescribeInput): Promise<About> => {
    const user = [
      `Skill name: ${input.name}`,
      `Platform: ${input.platform}`,
      input.listing ? `Listing description: ${input.listing}` : "",
      "SKILL.md:",
      input.markdown.slice(0, MAX_INPUT_CHARS),
    ]
      .filter(Boolean)
      .join("\n\n");
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...APP_HEADERS },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 4000,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: user },
            ],
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const diag = await describeHttpError(res);
          if (res.status !== 429 && res.status < 500) throw new Error(`fatal: ${diag}`);
          throw new Error(diag);
        }
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return parseAbout(data.choices?.[0]?.message?.content ?? "");
      } catch (err) {
        lastErr = err;
        if (String(err).includes("fatal:")) break;
      }
      if (attempt < RETRIES) await sleep(1_000 * 2 ** attempt);
    }
    throw new Error(`describe ${input.name}: ${String(lastErr)}`);
  };

  return { model, describe };
}
