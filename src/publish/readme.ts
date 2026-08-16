import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RawTable } from "../sources/types.js";

const START = "<!-- RANKINGS:START -->";
const END = "<!-- RANKINGS:END -->";
const PREVIEW_ROWS = 10;

/** Columns shown in the README preview per list (full data stays in CSV). */
const PREVIEW: Record<string, { title: string; cols: Array<[key: string, label: string]> }> = {
  "best-100": {
    title: "🏆 Best 100 (Worth-Installing Score)",
    cols: [["rank", "#"], ["skill", "Skill"], ["vendor", "Vendor"], ["wis", "WIS"], ["coverage", "Cov"]],
  },
  "top-installs": {
    title: "📈 Top Installs (all ecosystems)",
    cols: [["rank", "#"], ["skill", "Skill"], ["installs_skillssh", "skills.sh"], ["downloads_clawhub", "ClawHub"], ["downloads_skillhub_cn", "SkillHub CN"]],
  },
  "trending-7d": {
    title: "🚀 Trending (7 days)",
    cols: [["rank", "#"], ["skill", "Skill"], ["installs_skillssh", "Installs"], ["growth_pct", "Weekly Δ%"]],
  },
  "social-buzz": {
    title: "💬 Social Buzz (X · HN · Bluesky · GitHub, 7 days)",
    cols: [["rank", "#"], ["skill", "Skill"], ["x_mentions_7d", "X"], ["hn_hits_7d", "HN"], ["bsky_hits_7d", "Bluesky"], ["gh_mentions_7d", "GitHub"]],
  },
  "most-active": {
    title: "🔧 Most Active (popular & frequently updated)",
    cols: [["rank", "#"], ["skill", "Skill"], ["last_update", "Updated"], ["versions_clawhub", "Versions"]],
  },
  "official-100": {
    title: "✅ Official 100 (verified publishers)",
    cols: [["rank", "#"], ["skill", "Skill"], ["vendor", "Vendor"], ["verified_by", "Verified by"]],
  },
  "official-vendors": {
    title: "🏢 Official Vendors (grouped by platform)",
    cols: [["rank", "#"], ["platform", "Platform"], ["vendor", "Vendor"], ["skills_count", "Skills"], ["total_installs_or_downloads", "Installs/Downloads"]],
  },
  "top-repos": {
    title: "⭐ Top Repositories",
    cols: [["rank", "#"], ["repo", "Repository"], ["stars", "Stars"], ["pushed_at", "Pushed"]],
  },
  "rising-stars": {
    title: "🌱 Rising Stars (under 30 days old)",
    cols: [["rank", "#"], ["skill", "Skill"], ["first_seen_days", "Age (days)"], ["pop_score", "Popularity"]],
  },
};

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "number" && Number.isInteger(v) && v >= 10_000) return v.toLocaleString("en-US");
  return String(v).replace(/\|/g, "\\|");
}

function renderTable(table: RawTable, date: string): string {
  const spec = PREVIEW[table.name];
  if (!spec) return "";
  const rows = table.rows.slice(0, PREVIEW_ROWS);
  const header = `| ${spec.cols.map(([, l]) => l).join(" | ")} |`;
  const sep = `| ${spec.cols.map(() => "---").join(" | ")} |`;
  const cell = (r: RawTable["rows"][number], k: string): string => {
    const v = fmt(r[k]);
    // X counts stop at the page cap — a capped 100 is "at least 100", not 100 (audit M9)
    const truncated = r["x_truncated"] === true || r["x_truncated"] === "true";
    return k === "x_mentions_7d" && truncated && v !== "—" ? `${v}+` : v;
  };
  const body = rows.map((r) => `| ${spec.cols.map(([k]) => cell(r, k)).join(" | ")} |`).join("\n");
  const csvLink = `data/${date}/rankings/${table.name}.csv`;
  return `<details${table.name === "best-100" ? " open" : ""}>\n<summary><b>${spec.title}</b></summary>\n\n${header}\n${sep}\n${body}\n\n➡️ Full list: [${table.name}.csv](${csvLink})\n\n</details>`;
}

/** Replace the marked rankings block in the data repo's README. */
export function renderReadme(repoPath: string, date: string, tables: RawTable[]): void {
  const readmePath = join(repoPath, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1) throw new Error("README markers not found — cannot render rankings");
  const order = Object.keys(PREVIEW);
  const sections = order
    .map((name) => tables.find((t) => t.name === name))
    .filter((t): t is RawTable => t !== undefined && t.rows.length > 0)
    .map((t) => renderTable(t, date))
    .join("\n\n");
  const block = `${START}\n\n> Last updated: **${date}** (UTC) · Top ${PREVIEW_ROWS} preview per list — full Top 100 in the CSVs.\n\n${sections}\n\n${END}`;
  writeFileSync(readmePath, readme.slice(0, startIdx) + block + readme.slice(endIdx + END.length), "utf8");
}
