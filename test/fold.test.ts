import { test } from "node:test";
import assert from "node:assert/strict";
import { foldBundles } from "../src/rank/fold.js";

interface Item { name: string; repo?: string; weekly?: number }
const fold = (items: Item[]) =>
  foldBundles(items, (i) => ({ repo: i.repo, weekly: i.weekly })).map((b) => [b.lead.name, ...b.members.map((m) => m.name)]);

test("same-repo skills with near-equal weekly installs fold under the best-ranked one", () => {
  assert.deepEqual(
    fold([
      { name: "a1", repo: "org/a", weekly: 1000 },
      { name: "b", repo: "org/b", weekly: 990 },
      { name: "a2", repo: "org/a", weekly: 960 },
      { name: "a3", repo: "ORG/A", weekly: 1080 },
    ]),
    [["a1", "a2", "a3"], ["b"]],
  );
});

test("a same-repo skill installed on its own keeps its own row", () => {
  assert.deepEqual(
    fold([
      { name: "a1", repo: "org/a", weekly: 1000 },
      { name: "a2", repo: "org/a", weekly: 700 },
      { name: "a3", repo: "org/a", weekly: 690 },
    ]),
    [["a1"], ["a2", "a3"]],
  );
});

test("tolerance is measured against the bundle lead, so a bundle cannot drift", () => {
  assert.deepEqual(
    fold([
      { name: "a1", repo: "org/a", weekly: 1000 },
      { name: "a2", repo: "org/a", weekly: 905 },
      { name: "a3", repo: "org/a", weekly: 820 },
    ]),
    [["a1", "a2"], ["a3"]],
  );
});

test("rows without a repo or a weekly count never fold", () => {
  assert.deepEqual(
    fold([
      { name: "c1", weekly: 1000 },
      { name: "c2", weekly: 1000 },
      { name: "a1", repo: "org/a" },
      { name: "a2", repo: "org/a", weekly: 0 },
    ]),
    [["c1"], ["c2"], ["a1"], ["a2"]],
  );
});
