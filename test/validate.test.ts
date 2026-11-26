import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { precheckRaw, validate } from "../src/validate.js";
import { X_TOP_N } from "../src/buzz/collect-buzz.js";
import { day, tempDataDir, writeRaw, writeRows } from "./helpers.js";

const TODAY = day(0);
const about = (msgs: string[], needle: string): string[] => msgs.filter((m) => m.includes(needle));

/** clawhub-official sizes, oldest first, ending with today's. */
function driftCase(sizes: number[], allowDrift?: string[]) {
  const { dir, cleanup } = tempDataDir();
  try {
    sizes.forEach((n, i) => writeRows(dir, day(sizes.length - 1 - i), "clawhub-official", n));
    const r = precheckRaw(dir, TODAY, { allowDrift: allowDrift ? new Set(allowDrift) : undefined });
    return { errors: about(r.errors, "clawhub-official"), warnings: about(r.warnings, "clawhub-official") };
  } finally {
    cleanup();
  }
}

describe("row-count drift", () => {
  test("a small change passes silently", () => {
    assert.deepEqual(driftCase([1000, 950]), { errors: [], warnings: [] });
  });

  test("a change just under the limit warns instead of passing silently", () => {
    const r = driftCase([1000, 705]);
    assert.equal(r.errors.length, 0);
    assert.match(r.warnings[0] ?? "", /29\.5% .*under the 30% limit/);
  });

  test("a drop past the limit fails", () => {
    const r = driftCase([1000, 650]);
    assert.match(r.errors[0] ?? "", /drifted 35\.0%/);
  });

  test("a rise back to a recently published size is accepted with a warning", () => {
    const r = driftCase([1000, 705, 731, 1000]);
    assert.equal(r.errors.length, 0);
    assert.match(r.warnings[0] ?? "", /back to the size published on .* \(1000\)/);
  });

  test("a drop back to a recently published low still fails", () => {
    const r = driftCase([665, 731, 1000, 665]);
    assert.equal(r.errors.length, 1);
  });

  test("a rise to a size never published fails", () => {
    const r = driftCase([700, 700, 1000]);
    assert.equal(r.errors.length, 1);
  });

  test("--allow-drift turns the error into a warning", () => {
    const r = driftCase([731, 1000], ["clawhub-official"]);
    assert.equal(r.errors.length, 0);
    assert.match(r.warnings[0] ?? "", /accepted via --allow-drift/);
  });
});

describe("pre-check before the metered stages", () => {
  test("reports a missing source file", () => {
    const { dir, cleanup } = tempDataDir();
    try {
      const r = precheckRaw(dir, TODAY);
      assert.ok(r.errors.includes("raw/skillhub.csv missing"));
      assert.equal(about(r.errors, "buzz").length, 0, "buzz is written later and not pre-checked");
    } finally {
      cleanup();
    }
  });
});

/** buzz.csv for one day: `measured` X targets with `postsEach` posts, the rest blank. */
function writeBuzz(dir: string, date: string, measured: number, postsEach: number): void {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    skill: `s${i}`,
    hn_hits_7d: 1,
    x_pages: i < measured ? 1 : undefined,
    x_raw_7d: i < measured ? postsEach : undefined,
    x_mentions_7d: i < measured ? postsEach : undefined,
  }));
  writeRaw(dir, date, "buzz", ["skill", "hn_hits_7d", "x_pages", "x_raw_7d", "x_mentions_7d"], rows);
}

function xWarnings(history: Array<[number, number]>, today: [number, number]): string[] {
  const { dir, cleanup } = tempDataDir();
  try {
    history.forEach(([m, p], i) => writeBuzz(dir, day(history.length - i), m, p));
    writeBuzz(dir, TODAY, ...today);
    return about(validate(dir, TODAY).warnings, "X ");
  } finally {
    cleanup();
  }
}

describe("X coverage", () => {
  const normal: Array<[number, number]> = Array.from({ length: 7 }, () => [X_TOP_N, 40]);

  test("a normal day has no X warning", () => {
    assert.deepEqual(xWarnings(normal, [X_TOP_N, 40]), []);
  });

  test("too few measured targets warns", () => {
    assert.match(xWarnings(normal, [10, 40])[0] ?? "", /measured for only 10\/50/);
  });

  test("every target measured with zero posts warns", () => {
    assert.match(xWarnings(normal, [X_TOP_N, 0])[0] ?? "", /found 0 in-window posts/);
  });

  test("volume under half the weekly median warns", () => {
    assert.match(xWarnings(normal, [X_TOP_N, 10])[0] ?? "", /25% of the 7-day median/);
  });

  test("zero-post days do not drag the baseline down", () => {
    const history: Array<[number, number]> = [[X_TOP_N, 40], [X_TOP_N, 40], [X_TOP_N, 0], [X_TOP_N, 0], [X_TOP_N, 0], [X_TOP_N, 0]];
    assert.match(xWarnings(history, [X_TOP_N, 10])[0] ?? "", /of the 2-day median/);
  });
});
