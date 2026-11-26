import { test } from "node:test";
import assert from "node:assert/strict";
import { checkXSearch } from "../src/buzz/collect-buzz.js";

test("an ok response returns its timeline, empty or not", () => {
  assert.equal(checkXSearch({ status: "ok", timeline: [{ tweet_id: "1" }] }).length, 1);
  assert.equal(checkXSearch({ status: "ok", timeline: [] }).length, 0);
});

test("a failed body behind HTTP 200 is an error, not zero posts", () => {
  assert.throws(
    () => checkXSearch({ status: "failed", timeline: [], error: "Temporary unavaialble" }),
    /X search failed: status=failed/,
  );
});

test("a missing timeline is an error", () => {
  assert.throws(() => checkXSearch({ status: "ok" }), /no timeline array/);
});
