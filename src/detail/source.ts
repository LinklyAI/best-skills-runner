import { createHash } from "node:crypto";
import { fetchJson, fetchText } from "../lib/http.js";
import { githubToken } from "../lib/github-auth.js";

/**
 * Reads a skill's instructions (SKILL.md) from where it is published, plus the facts a
 * program can read off the files without a model: how it is invoked, which sibling
 * skills it calls, whether it ships scripts, when SKILL.md last changed.
 *
 *   skills.sh  → the GitHub repo (`owner/repo`); skills.sh entries hosted on a domain
 *                instead of GitHub have no readable source.
 *   ClawHub    → clawhub.ai/api/v1/skills/<slug>?owner=<handle>; the description field
 *                is the full SKILL.md.
 *   SkillHub   → no public source; pages show the listing text only.
 */

export interface SkillSource {
  /** Full SKILL.md text, frontmatter included. */
  markdown: string;
  /** sha256 of the markdown — the AI text is rewritten only when this changes. */
  hash: string;
  /** Publisher's display name when the platform gives one. */
  authorName?: string;
  /** "manual": frontmatter sets disable-model-invocation; "auto" otherwise. */
  invocation: "manual" | "auto";
  /** Sibling skills of the same repo that SKILL.md calls by name. */
  depends: string[];
  /** Ships files a program runs (scripts), not just instructions; unknown when the platform lists no files. */
  scripts?: boolean;
  /** Last change of SKILL.md, YYYY-MM-DD; filled by `lastChanged` when the hash changes. */
  updatedAt?: string;
  /** Location used to read the file, for lastChanged. */
  ref: { kind: "github"; repo: string; path: string; skillNames: string[] } | { kind: "clawhub"; updatedAt?: string };
}

const SCRIPT_EXT = /\.(py|sh|bash|js|mjs|cjs|ts|rb|go|rs|ps1|php|pl|lua)$/i;
const MAX_MARKDOWN = 200_000;

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Minimal YAML frontmatter reader: top-level `key: value` lines only. */
export function parseFrontmatter(md: string): { fields: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fields: {}, body: md };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: md.slice(m[0].length) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sibling skills SKILL.md calls by name: written as `name`, "name", /name or "name skill".
 * A bare word is not enough — names like "handoff" or "triage" are ordinary words.
 */
export function findDepends(body: string, self: string, siblings: readonly string[]): string[] {
  return siblings.filter((n) => {
    if (n.toLowerCase() === self.toLowerCase()) return false;
    const e = escapeRe(n);
    return new RegExp(`\`/?${e}\`|"${e}"|(?:^|[\\s(])/${e}\\b|\\b${e} skill\\b`, "i").test(body);
  });
}

export function invocationOf(fields: Record<string, string>): "manual" | "auto" {
  return fields["disable-model-invocation"]?.toLowerCase() === "true" ? "manual" : "auto";
}

/** Directory of the skill in a repo tree: the SKILL.md whose folder is named after the skill. */
export function findSkillDir(skillMdPaths: readonly string[], name: string): string | undefined {
  const lower = name.toLowerCase();
  const dirs = skillMdPaths.map((p) => p.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
  const named = dirs.filter((d) => (d.split("/").pop() ?? "").toLowerCase() === lower).sort((a, b) => a.length - b.length);
  if (named[0] !== undefined) return named[0];
  // A repo that is one skill keeps SKILL.md at its root.
  return dirs.length === 1 && dirs[0] === "" ? "" : undefined;
}

interface TreeEntry {
  path: string;
  type: string;
}

/** Fetches GitHub repo trees once per run. */
export class GitHubReader {
  private trees = new Map<string, Promise<string[] | undefined>>();
  private headers: Record<string, string>;
  requests = 0;

  constructor(token = githubToken()) {
    this.headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  }

  private tree(repo: string): Promise<string[] | undefined> {
    let t = this.trees.get(repo);
    if (!t) {
      this.requests++;
      t = fetchJson<{ tree?: TreeEntry[] }>(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
        headers: this.headers,
        retries: 2,
      })
        .then((d) => d.tree?.filter((e) => e.type === "blob").map((e) => e.path))
        .catch(() => undefined);
      this.trees.set(repo, t);
    }
    return t;
  }

  /** SKILL.md and facts for one skill; undefined when the repo or the skill folder is not found. */
  async read(repo: string, name: string): Promise<SkillSource | undefined> {
    const files = await this.tree(repo);
    if (!files) return undefined;
    const skillMds = files.filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"));
    const dir = findSkillDir(skillMds, name);
    if (dir === undefined) return undefined;
    const path = dir ? `${dir}/SKILL.md` : "SKILL.md";
    const markdown = (await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`, { retries: 2 })).slice(0, MAX_MARKDOWN);
    const { fields, body } = parseFrontmatter(markdown);
    const prefix = dir ? `${dir}/` : "";
    const siblings = skillMds.map((p) => (p.slice(0, -"/SKILL.md".length).split("/").pop() ?? "")).filter(Boolean);
    return {
      markdown,
      hash: sha256(markdown),
      invocation: invocationOf(fields),
      depends: findDepends(body, name, siblings),
      scripts: files.some((f) => f.startsWith(prefix) && SCRIPT_EXT.test(f) && (dir !== "" || !f.includes("/"))),
      ref: { kind: "github", repo, path, skillNames: siblings },
    };
  }

  /** Date of the last commit that touched SKILL.md. */
  async lastChanged(repo: string, path: string): Promise<string | undefined> {
    this.requests++;
    try {
      const commits = await fetchJson<Array<{ commit?: { committer?: { date?: string } } }>>(
        `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`,
        { headers: this.headers, retries: 2 },
      );
      return commits[0]?.commit?.committer?.date?.slice(0, 10);
    } catch {
      return undefined;
    }
  }
}

interface ClawHubSkill {
  skill?: { description?: string; updatedAt?: number };
  owner?: { handle?: string; displayName?: string };
}

/** ClawHub slugs are not unique across owners; without the owner an ambiguous slug is skipped. */
export async function readClawHub(slug: string, owner: string | undefined): Promise<SkillSource | undefined> {
  const url = new URL(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}`);
  if (owner) url.searchParams.set("owner", owner);
  let d: ClawHubSkill;
  try {
    d = await fetchJson<ClawHubSkill>(url.toString(), { retries: 2 });
  } catch {
    return undefined;
  }
  const markdown = d.skill?.description?.slice(0, MAX_MARKDOWN);
  if (!markdown) return undefined;
  const { fields } = parseFrontmatter(markdown);
  const updatedAt = d.skill?.updatedAt ? new Date(d.skill.updatedAt).toISOString().slice(0, 10) : undefined;
  return {
    markdown,
    hash: sha256(markdown),
    authorName: d.owner?.displayName || undefined,
    invocation: invocationOf(fields),
    depends: [],
    // The ClawHub API does not list a skill's files.
    updatedAt,
    ref: { kind: "clawhub", updatedAt },
  };
}
