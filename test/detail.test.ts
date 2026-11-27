import { test } from "node:test";
import assert from "node:assert/strict";
import { clawhubOwner, skillPath } from "../src/detail/details.js";
import { findDepends, findSkillDir, invocationOf, parseFrontmatter } from "../src/detail/source.js";
import { parseAbout } from "../src/detail/describe.js";
import { computeStats, trendShape } from "../src/detail/stats.js";
import { rowKey } from "../src/detail/history.js";
import type { DayPoint } from "../src/detail/history.js";

test("page paths keep the skills.sh source and prefix other platforms", () => {
  assert.equal(skillPath("ss:mattpocock/skills/grill-me"), "mattpocock/skills/grill-me");
  assert.equal(skillPath("ss:open.feishu.cn/lark-doc"), "open.feishu.cn/lark-doc");
  assert.equal(skillPath("ch:gog"), "clawhub/gog");
  assert.equal(skillPath("sh:self-improving"), "skillhub/self-improving");
  assert.equal(skillPath("sh:中文"), undefined);
  assert.equal(skillPath("xx:foo"), undefined);
});

test("ClawHub owner comes from the page URL", () => {
  assert.equal(clawhubOwner("https://clawhub.ai/steipete/skills/gog"), "steipete");
  assert.equal(clawhubOwner(undefined), undefined);
  assert.equal(clawhubOwner("https://example.com/x"), undefined);
});

test("frontmatter fields and manual invocation", () => {
  const { fields, body } = parseFrontmatter('---\nname: grill-me\ndescription: "Ask first"\ndisable-model-invocation: true\n---\n# Body\n');
  assert.equal(fields["name"], "grill-me");
  assert.equal(fields["description"], "Ask first");
  assert.equal(invocationOf(fields), "manual");
  assert.equal(body, "# Body\n");
  assert.equal(invocationOf({}), "auto");
});

test("skill folder is the one named after the skill; a lone root SKILL.md is the skill", () => {
  const paths = ["skills/a/SKILL.md", "skills/grill-me/SKILL.md", "deep/x/grill-me/SKILL.md"];
  assert.equal(findSkillDir(paths, "Grill-Me"), "skills/grill-me");
  assert.equal(findSkillDir(paths, "missing"), undefined);
  assert.equal(findSkillDir(["SKILL.md"], "anything"), "");
});

test("dependencies need a marked mention, not a bare word", () => {
  const siblings = ["grilling", "handoff", "tdd", "grill-me"];
  const body = 'Run the `grilling` skill. Then do a handoff to the user. Use the Skill tool for "tdd".';
  assert.deepEqual(findDepends(body, "grill-me", siblings), ["grilling", "tdd"]);
});

const about = (o: Record<string, unknown> = {}) => ({
  tagline: "t",
  summary: "s",
  problem: ["p"],
  fit: ["f"],
  unfit: ["u"],
  steps: ["1", "2"],
  ...o,
});

test("model reply is validated for both languages", () => {
  const ok = parseAbout("Here:\n" + JSON.stringify({ en: about(), zh: about() }));
  assert.equal(ok.zh.tagline, "t");
  assert.throws(() => parseAbout(JSON.stringify({ en: about() })), /missing zh/);
  assert.throws(() => parseAbout(JSON.stringify({ en: about({ steps: ["only one"] }), zh: about() })), /steps/);
  assert.throws(() => parseAbout("no json"), /no JSON/);
});

test("trend shape by the 30-day growth ratio", () => {
  assert.equal(trendShape(130, 100), "accelerating");
  assert.equal(trendShape(100, 100), "steady");
  assert.equal(trendShape(50, 100), "slowing");
  assert.equal(trendShape(10, 100), "stalled");
  assert.equal(trendShape(10, 0), "new");
  assert.equal(trendShape(undefined, 100), "new");
});

function daily(n: number, end: string, perDay: (i: number) => number, rank?: (i: number) => number | undefined): DayPoint[] {
  const out: DayPoint[] = [];
  let total = 1000;
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.parse(`${end}T00:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    total += perDay(i);
    const r = rank?.(i);
    out.push({ date, total, ...(r !== undefined && { rank: r }) });
  }
  return out;
}

test("stats: weekly growth, 30-day averages, rank 7 days ago", () => {
  const s = daily(70, "2026-11-26", (i) => (i < 40 ? 100 : 200), (i) => (i >= 60 ? 70 - i : undefined));
  const st = computeStats(s, "2026-11-26");
  assert.equal(st.week, 1400);
  assert.equal(st.prevWeek, 1400);
  assert.equal(st.avg30, 200);
  assert.equal(st.avgPrev30, 100);
  assert.equal(st.shape, "accelerating");
  assert.equal(st.rank, 1);
  assert.equal(st.rank7d, 8);
  assert.equal(st.best100Days, 10);
  assert.equal(st.days, 70);
});

test("stats: short history has no trend; a missing latest day is not today's rank", () => {
  const s = daily(20, "2026-11-25", () => 10, () => 5);
  const st = computeStats(s, "2026-11-26");
  assert.equal(st.shape, "new");
  assert.equal(st.rank, undefined);
  assert.equal(st.total, s.at(-1)!.total); // bridged across one missing day
});

test("ranking rows from before skill_key existed still map to entity keys", () => {
  assert.equal(rowKey({ skill: "grill-me", platform: "skills.sh", source_skillssh: "mattpocock/skills" }), "ss:mattpocock/skills/grill-me");
  assert.equal(rowKey({ skill: "gog", platform: "clawhub", slug_clawhub: "gog" }), "ch:gog");
  assert.equal(rowKey({ skill_key: "sh:x", skill: "y" }), "sh:x");
});

test("index carries the AI tagline and summary for hover cards", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeIndex } = await import("../src/detail/details.js");
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  try {
    mkdirSync(join(dir, "o/r"), { recursive: true });
    const text = (s: string) => ({ tagline: `t-${s}`, summary: `s-${s}`, problem: [], fit: [], unfit: [], steps: [] });
    writeFileSync(join(dir, "o/r/a.json"), JSON.stringify({ name: "a", platform: "skills.sh", date: "2026-11-27", stats: { rank: 3 }, about: { en: text("en"), zh: text("zh") } }));
    writeFileSync(join(dir, "o/r/b.json"), JSON.stringify({ name: "b", platform: "skills.sh", date: "2026-11-27", stats: {} }));
    const [a, b] = writeIndex(dir);
    assert.deepEqual(a, { path: "o/r/a", name: "a", platform: "skills.sh", date: "2026-11-27", rank: 3, tagline: { en: "t-en", zh: "t-zh" }, summary: { en: "s-en", zh: "s-zh" } });
    assert.deepEqual(b, { path: "o/r/b", name: "b", platform: "skills.sh", date: "2026-11-27" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
