/**
 * Entity-level judgement vocabulary shared by the judge step (which asks jev) and the
 * ranking step (which applies the verdicts from raw/judgments.csv). Keeping the
 * thresholds here, and deriving flags from the published probabilities, lets anyone
 * re-derive every exclusion from the CSVs alone.
 */

/**
 * Categories follow Tencent SkillHub's fixed taxonomy (so one registry's labels can be
 * checked against ours), plus `other`. Each description is what jev sees for the option.
 */
export const CATEGORIES: Record<string, string> = {
  "ai-agent":
    "Skills whose subject is AI agents themselves: building, orchestrating, evaluating or extending agents; prompts, agent memory, finding or managing skills, agent self-improvement. Not for skills that merely use an agent to do other work.",
  "dev-programming":
    "Software development: writing or reviewing code, frameworks, testing, debugging, git, APIs and SDKs, developer tooling, browser automation for development.",
  "it-ops-security":
    "Cloud platforms, DevOps, infrastructure, deployment, monitoring, system administration, security.",
  "data-analysis":
    "Data processing, analytics, databases, spreadsheets as data, charts and visualization, market or stock analysis.",
  "knowledge-management":
    "Search and retrieval: web search, knowledge bases, reading, summarizing or organizing information and notes.",
  "office-efficiency":
    "Office work: documents, PDF, slides, email, calendar, meetings, office suites, personal productivity.",
  "content-creation":
    "Writing and publishing content: copywriting, articles, social media posts, scripts, marketing copy.",
  "design-media":
    "Visual and media work: UI/UX and graphic design, image, video or audio generation and editing.",
  "business-ops":
    "Business operations: sales, marketing operations, e-commerce, CRM, finance operations, HR, customer support.",
  professional:
    "Specialist domain expertise: legal, medical, financial advice, academic or scientific research, consulting.",
  education: "Learning and teaching: tutoring, courses, exams, language learning.",
  "life-service":
    "Everyday life: weather, travel, food, health or habit tracking, shopping, entertainment, fortune telling.",
  other: "None of the categories above fits.",
};

/**
 * A category is published only when jev puts at least this much probability on it.
 * With 13 options a 0.4 winner is a clear plurality; below it the label is left empty.
 */
export const CATEGORY_MIN_P = 0.4;

/** P(genuine skill) below this: a placeholder, test or advertisement listing. */
export const NOT_A_SKILL_BELOW = 0.2;
/** P(listing says it is deprecated / replaced) at or above this. */
export const DEPRECATED_FROM = 0.7;
/** P(description pressures agents into using it) at or above this. */
export const COERCIVE_FROM = 0.8;
/** P(main purpose is harmful or abusive) at or above this. */
export const HARMFUL_FROM = 0.8;

export interface QualityScores {
  pSkill?: number;
  pDeprecated?: number;
  pCoercive?: number;
  pHarmful?: number;
}

/**
 * Flags that keep an entity out of every ranking (it stays in raw data). `coercive` is
 * published as a warning only: popular, legitimate skills use "You MUST use this"
 * phrasing too, so it informs readers rather than removing the skill.
 */
export const EXCLUDING_FLAGS: ReadonlySet<string> = new Set(["not-a-skill", "deprecated", "harmful"]);

export function isExcluded(flags: readonly string[] | undefined): boolean {
  return flags?.some((f) => EXCLUDING_FLAGS.has(f)) ?? false;
}

/** Flags for one entity. Missing scores never flag: no description, no verdict. */
export function flagsOf(q: QualityScores): string[] {
  const flags: string[] = [];
  if (q.pSkill !== undefined && q.pSkill < NOT_A_SKILL_BELOW) flags.push("not-a-skill");
  if (q.pDeprecated !== undefined && q.pDeprecated >= DEPRECATED_FROM) flags.push("deprecated");
  if (q.pCoercive !== undefined && q.pCoercive >= COERCIVE_FROM) flags.push("coercive");
  if (q.pHarmful !== undefined && q.pHarmful >= HARMFUL_FROM) flags.push("harmful");
  return flags;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Quality probabilities of a raw/judgments.csv row. */
export function scoresOf(r: Record<string, string>): QualityScores {
  return {
    pSkill: num(r["p_skill"]),
    pDeprecated: num(r["p_deprecated"]),
    pCoercive: num(r["p_coercive"]),
    pHarmful: num(r["p_harmful"]),
  };
}
