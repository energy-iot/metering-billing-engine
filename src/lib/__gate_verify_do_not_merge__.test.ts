// #236 step 3 verification — DO NOT MERGE.
//
// Placed under `src/lib/` so the `lib` vitest project (include:
// "src/lib/**/*.test.{ts,tsx}") actually picks it up. The first
// verification attempt (PR #238) put this file directly at `src/` —
// not matched by ANY project's include — so vitest silently skipped it
// and the Test check reported SUCCESS, allowing the verification PR to
// merge. Lesson: gate verification artifacts must live inside an
// `include`-d project path.
//
// After confirming the gate behaves correctly here, the branch will be
// deleted and this file removed.

import { describe, it, expect } from "vitest";

describe("CI gate verification v2 (PR will be closed unmerged)", () => {
  it("intentionally fails so we can verify the Test gate blocks merge", () => {
    expect(true).toBe(false);
  });
});
