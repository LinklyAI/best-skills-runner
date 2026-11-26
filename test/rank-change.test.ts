import { test } from "node:test";
import assert from "node:assert/strict";
import { writeCsv } from "../src/lib/csv.js";
import { join } from "node:path";
import { previousRanks, rankChange } from "../src/rank/rank-change.js";
import { day, tempDataDir } from "./helpers.js";

const ids = (r: Record<string, unknown>) => [String(r["skill_key"] ?? "")];

function withList(columns: string[], rows: Array<Record<string, string | number>>, fn: (dir: string) => void): void {
  const { dir, cleanup } = tempDataDir();
  try {
    writeCsv(join(dir, day(7), "rankings", "best-100.csv"), columns, rows);
    fn(dir);
  } finally {
    cleanup();
  }
}

test("moves are reported against the list seven days earlier", () => {
  withList(["rank", "skill_key", "group_size"], [{ rank: 1, skill_key: "a", group_size: 1 }, { rank: 2, skill_key: "b", group_size: 1 }, { rank: 3, skill_key: "c", group_size: 1 }], (dir) => {
    const prev = previousRanks(dir, day(0), "best-100", ids, "group_size");
    assert.equal(rankChange(1, ["c"], prev), "+2");
    assert.equal(rankChange(3, ["a"], prev), "-2");
    assert.equal(rankChange(2, ["b"], prev), "0");
    assert.equal(rankChange(4, ["z"], prev), "new");
  });
});

test("a bundle keeps its history when a different member leads it", () => {
  withList(["rank", "skill_key"], [{ rank: 5, skill_key: "lead-then" }], (dir) => {
    const prev = previousRanks(dir, day(0), "best-100", ids);
    assert.equal(rankChange(3, ["lead-now", "lead-then"], prev), "+2");
  });
});

test("no marker when there is no list to compare with", () => {
  const { dir, cleanup } = tempDataDir();
  try {
    assert.equal(rankChange(1, ["a"], previousRanks(dir, day(0), "best-100", ids)), "");
  } finally {
    cleanup();
  }
});

test("a folded list is not compared with an unfolded one", () => {
  withList(["rank", "skill_key"], [{ rank: 1, skill_key: "a" }], (dir) => {
    assert.equal(previousRanks(dir, day(0), "best-100", ids, "group_size"), undefined);
  });
});
