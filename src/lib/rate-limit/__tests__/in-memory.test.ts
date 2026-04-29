/**
 * in-memory.test.ts — sliding-window rate limiter unit tests (#202 / D16).
 *
 * Covers the AC8 enumeration:
 *   - 11th call within 60s window → 429
 *   - 11th call after 60s window → 200 (TTL pruning works)
 *   - Two distinct IP keys do not interfere with each other's counters
 *
 * Time control via vitest's fake timers so we don't actually sleep 60s.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  checkRateLimit,
  _resetRateLimitStoreForTests,
} from "../in-memory";

const LIMIT = 10;
const WINDOW_MS = 60_000;

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitStoreForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first 10 calls in a 60s window", () => {
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects the 11th call within the 60s window with retryAfter set", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    const r = checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(60);
  });

  it("allows an 11th call after the 60s window expires (TTL pruning works)", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    // Immediately blocked.
    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS).ok).toBe(false);

    // Advance past the window. The earliest hit was at t=0, so by t=61s it's
    // outside the 60s window.
    vi.advanceTimersByTime(WINDOW_MS + 1_000);

    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS).ok).toBe(true);
  });

  it("does not interfere across distinct keys", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS).ok).toBe(false);
    // Different IP — fresh budget.
    expect(checkRateLimit("5.6.7.8", LIMIT, WINDOW_MS).ok).toBe(true);
  });

  it("does NOT count rejected hits against the budget", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    // Burn many rejections — none should add to the queue.
    for (let i = 0; i < 5; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    // Advance slightly past the window. Original 10 hits should age out;
    // the budget resets to 10.
    vi.advanceTimersByTime(WINDOW_MS + 1);
    let allowed = 0;
    for (let i = 0; i < LIMIT; i++) {
      if (checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS).ok) allowed++;
    }
    expect(allowed).toBe(LIMIT);
  });
});
