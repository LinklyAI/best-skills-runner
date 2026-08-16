import { fetchText, sleep } from "../lib/http.js";
import { log } from "../lib/log.js";
import type { Collector, RawTable } from "./types.js";

const BASE = "https://www.skills.sh";

interface SkillsShSkill {
  source: string;
  skillId?: string;
  name: string;
  installs: number;
  weeklyInstalls?: number[];
  installsYesterday?: number;
  change?: number;
  isOfficial?: boolean;
}

interface OfficialOwner {
  owner: string;
  totalInstalls: number;
  featuredSkill?: { name?: string };
  repos?: Array<{ repo: string; totalInstalls?: number; skills?: Array<{ name: string; installs: number }> }>;
}

/** Decode the RSC flight payload embedded in `self.__next_f.push([1,"..."])` chunks. */
function decodeFlightPayload(html: string): string {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/gs)].map((m) => m[1] ?? "");
  return chunks
    .map((c) => {
      try {
        return JSON.parse(`"${c}"`);
      } catch {
        return "";
      }
    })
    .join("");
}

/** Scan the payload for the JSON array that follows `"<key>":` and satisfies `pick`. */
function extractArrays<T>(payload: string, key: string, pick: (arr: T[]) => boolean): T[][] {
  const found: T[][] = [];
  const needle = `"${key}":[`;
  let idx = 0;
  while ((idx = payload.indexOf(needle, idx)) !== -1) {
    const start = idx + needle.length - 1;
    const arr = tryParseArrayAt(payload, start);
    if (arr && pick(arr as T[])) found.push(arr as T[]);
    idx += needle.length;
  }
  return found;
}

/** Parse a balanced JSON array starting at `start` (payload[start] === "["). */
function tryParseArrayAt(payload: string, start: number): unknown[] | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(payload.slice(start, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchView(path: string, view: string): Promise<SkillsShSkill[]> {
  const html = await fetchText(`${BASE}${path}`);
  const payload = decodeFlightPayload(html);
  const candidates = [
    ...extractArrays<SkillsShSkill>(payload, "initialSkills", (a) => a.length > 0 && typeof a[0] === "object" && a[0] !== null && "installs" in (a[0] as object) && "source" in (a[0] as object)),
    ...extractArrays<SkillsShSkill>(payload, "skills", (a) => a.length > 100 && typeof a[0] === "object" && a[0] !== null && "installs" in (a[0] as object) && "source" in (a[0] as object)),
  ];
  const best = candidates.sort((a, b) => b.length - a.length)[0];
  if (!best || best.length === 0) {
    throw new Error(`skills.sh ${view}: parsed 0 skills — page layout may have changed`);
  }
  log.info("skills-sh", `${view}: ${best.length} skills`);
  return best;
}

async function fetchOfficialOwners(): Promise<OfficialOwner[]> {
  const html = await fetchText(`${BASE}/official`);
  const payload = decodeFlightPayload(html);
  const candidates = extractArrays<OfficialOwner>(
    payload,
    "owners",
    (a) => a.length > 0 && typeof a[0] === "object" && a[0] !== null && "totalInstalls" in (a[0] as object),
  );
  const best = candidates.sort((a, b) => b.length - a.length)[0] ?? [];
  log.info("skills-sh", `official owners: ${best.length}`);
  return best;
}

export const skillsSh: Collector = {
  id: "skills-sh",

  async probe(): Promise<string> {
    const skills = await fetchView("/", "all-time");
    return `all-time top1 = ${skills[0]?.source}/${skills[0]?.name} (${skills[0]?.installs} installs)`;
  },

  async collect(): Promise<RawTable[]> {
    const allTime = await fetchView("/", "all-time");
    await sleep(1000);
    const trending = await fetchView("/trending", "trending");
    await sleep(1000);
    const hot = await fetchView("/hot", "hot");
    await sleep(1000);
    const owners = await fetchOfficialOwners();

    const byView = [
      { view: "all-time", skills: allTime },
      { view: "trending", skills: trending },
      { view: "hot", skills: hot },
    ];
    const skillRows = byView.flatMap(({ view, skills }) =>
      skills.map((s, i) => ({
        view,
        rank: i + 1,
        source: s.source,
        name: s.name,
        installs: s.installs,
        is_official: s.isOfficial ?? false,
        installs_yesterday: s.installsYesterday,
        change: s.change,
        weekly_installs: s.weeklyInstalls ? s.weeklyInstalls.join("|") : undefined,
      })),
    );

    const ownerRows = owners
      .sort((a, b) => (b.totalInstalls ?? 0) - (a.totalInstalls ?? 0))
      .map((o, i) => ({
        rank: i + 1,
        owner: o.owner,
        total_installs: o.totalInstalls,
        repos: o.repos?.length ?? 0,
        skills: o.repos?.reduce((n, r) => n + (r.skills?.length ?? 0), 0) ?? 0,
        featured_skill: o.featuredSkill?.name,
      }));

    return [
      {
        name: "skills-sh",
        columns: ["view", "rank", "source", "name", "installs", "is_official", "installs_yesterday", "change", "weekly_installs"],
        rows: skillRows,
      },
      {
        name: "skills-sh-official",
        columns: ["rank", "owner", "total_installs", "repos", "skills", "featured_skill"],
        rows: ownerRows,
      },
    ];
  },
};
