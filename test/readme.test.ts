import assert from "node:assert/strict";
import test from "node:test";

import { refreshDateBadge } from "../src/publish/readme.js";

test("date badge carries the run date, shields-escaped", () => {
  const md = "[![Data updated](https://img.shields.io/badge/data%20updated-2026--11--26-brightgreen)](data/latest)";
  assert.equal(
    refreshDateBadge(md, "2026-11-27"),
    "[![Data updated](https://img.shields.io/badge/data%20updated-2026--11--27-brightgreen)](data/latest)",
  );
});

test("README without the badge is left as is", () => {
  const md = "# Title\n\nno badge here";
  assert.equal(refreshDateBadge(md, "2026-11-27"), md);
});
