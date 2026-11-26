import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeCsv } from "../src/lib/csv.js";
import { buildEntities } from "../src/rank/entity.js";
import { tempDataDir } from "./helpers.js";

const COLS = ["view", "rank", "source", "name", "installs", "is_official", "installs_yesterday", "change", "weekly_installs"];

function entities(rows: Array<Record<string, string | number>>) {
  const { dir, cleanup } = tempDataDir();
  try {
    writeCsv(join(dir, "raw", "skills-sh.csv"), COLS, rows);
    return buildEntities(join(dir, "raw"));
  } finally {
    cleanup();
  }
}

test("cumulative installs come from the all-time view, not a larger window count", () => {
  const e = entities([
    { view: "all-time", rank: 9, source: "org/repo", name: "a", installs: 300, weekly_installs: "10|20" },
    { view: "trending", rank: 1, source: "org/repo", name: "a", installs: 447 },
  ]).get("ss:org/repo/a");
  assert.equal(e?.ssInstalls, 300);
  assert.deepEqual(e?.ssWeekly, [10, 20]);
  assert.equal(e?.ssTrendingRank, 1);
});

test("a skill seen only in trending or hot has no cumulative installs", () => {
  const all = entities([
    { view: "trending", rank: 3, source: "org/repo", name: "b", installs: 447 },
    { view: "hot", rank: 5, source: "org/repo", name: "c", installs: 11 },
  ]);
  assert.equal(all.get("ss:org/repo/b")?.ssInstalls, undefined);
  assert.equal(all.get("ss:org/repo/b")?.ssTrendingRank, 3);
  assert.equal(all.get("ss:org/repo/c")?.ssInstalls, undefined);
});
