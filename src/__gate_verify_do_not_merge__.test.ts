// PR #237 / issue #236 verification — DO NOT MERGE.
// This file exists solely to prove that the `Test` required status
// check blocks merge when vitest reports a failure. After confirming
// the gate behaves correctly on the verification PR, the branch will
// be deleted and this file removed.

import { describe, it, expect } from "vitest";

describe("CI gate verification (PR will be closed unmerged)", () => {
  it("intentionally fails so we can verify the Test gate blocks merge", () => {
    expect(true).toBe(false);
  });
});
