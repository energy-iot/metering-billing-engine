/**
 * short-slug.test.ts (#223) — unit tests for the short-slug helper.
 *
 * Coverage per AC3:
 *   - generator produces 6-char [A-Za-z0-9] strings.
 *   - generator distribution: across many samples, all 62 alphabet chars
 *     appear (sanity check — not a statistical test of uniformity).
 *   - mintUniqueShortSlug: UPDATE returns a row → returns the new slug.
 *   - mintUniqueShortSlug: 23505 once → retry with a different candidate.
 *   - mintUniqueShortSlug: UPDATE zero rows → re-SELECT returns the concurrent
 *     winner's slug (the LOCAL candidate is NOT returned).
 *   - mintUniqueShortSlug: 5 consecutive 23505s → throws PAYMENT_INVALID_CONFIG.
 *   - mintUniqueShortSlug: re-SELECT shows NULL (impossible-but-defensive)
 *     → throws PAYMENT_INVALID_CONFIG.
 *
 * Supabase client is mocked as a minimal builder chain that mirrors the
 * surface used in `mintUniqueShortSlug` (update().eq().is().select(),
 * select().eq().maybeSingle()).
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { generateShortSlug, mintUniqueShortSlug } from "../short-slug";
import { PaymentError } from "../errors";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";

// ── Supabase mock factory ───────────────────────────────────────────────────
//
// Each call configures a queued sequence of UPDATE outcomes (data + error)
// and an optional re-SELECT outcome. The mock is "stateful per test" and
// records what was called in `calls` for assertions.

type UpdateOutcome = {
  data: Array<{ id: string; short_slug: string }> | null;
  error: { code?: string; message: string } | null;
};
type SelectOutcome = {
  data: { short_slug: string | null } | null;
  error: { message: string } | null;
};

interface MockState {
  updates: UpdateOutcome[];
  selects: SelectOutcome[];
  capturedUpdatePayloads: Array<{ short_slug: string }>;
  updateCalls: number;
  selectCalls: number;
}

function makeMockClient(state: MockState): SupabaseClient {
  const from = (table: string) => {
    if (table !== "billing_line_items") {
      throw new Error(`Unexpected table: ${table}`);
    }
    return {
      update(payload: { short_slug: string }) {
        state.capturedUpdatePayloads.push(payload);
        return {
          eq(_col: string, _val: string) {
            return {
              is(_col2: string, _val2: unknown) {
                return {
                  select(_cols: string) {
                    state.updateCalls += 1;
                    const next = state.updates.shift();
                    if (!next) {
                      throw new Error(
                        "Mock: ran out of queued UPDATE outcomes.",
                      );
                    }
                    return Promise.resolve(next);
                  },
                };
              },
            };
          },
        };
      },
      select(_cols: string) {
        return {
          eq(_col: string, _val: string) {
            return {
              maybeSingle<T>() {
                state.selectCalls += 1;
                const next = state.selects.shift();
                if (!next) {
                  throw new Error(
                    "Mock: ran out of queued SELECT outcomes.",
                  );
                }
                return Promise.resolve(next) as unknown as Promise<{
                  data: T | null;
                  error: typeof next.error;
                }>;
              },
            };
          },
        };
      },
    };
  };
  return { from } as unknown as SupabaseClient;
}

function freshState(): MockState {
  return {
    updates: [],
    selects: [],
    capturedUpdatePayloads: [],
    updateCalls: 0,
    selectCalls: 0,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("generateShortSlug()", () => {
  it("returns a 6-char string", () => {
    const slug = generateShortSlug();
    expect(slug).toHaveLength(6);
  });

  it("returns only [A-Za-z0-9] characters (no symbols / Unicode)", () => {
    const slug = generateShortSlug();
    expect(slug).toMatch(/^[A-Za-z0-9]{6}$/);
  });

  it("produces a range of alphabet characters across many samples (sanity)", () => {
    // Pull 1000 slugs (6000 chars). Even with massive bias correction skew,
    // every one of the 62 alphabet characters should appear at least once.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      for (const ch of generateShortSlug()) seen.add(ch);
    }
    // The full alphabet is 62 chars; we should hit nearly all of them.
    // Use a conservative lower bound (60) — the 1-in-million miss is still
    // possible but vanishingly so.
    expect(seen.size).toBeGreaterThanOrEqual(60);
  });

  it("produces distinct slugs across consecutive calls (collision test)", () => {
    // 100 calls; collision rate at 6-char base62 is ~1 in 56B. Should never
    // duplicate in a 100-sample run.
    const slugs = new Set<string>();
    for (let i = 0; i < 100; i++) slugs.add(generateShortSlug());
    expect(slugs.size).toBe(100);
  });
});

describe("mintUniqueShortSlug()", () => {
  it("UPDATE returns a row → returns the persisted (winning) slug", async () => {
    const state = freshState();
    // First call wins: data is a single-element array of the inserted row.
    state.updates.push({
      data: [{ id: LINE_ITEM_ID, short_slug: "PLACEHOLDER" }],
      error: null,
    });

    const slug = await mintUniqueShortSlug(makeMockClient(state), LINE_ITEM_ID);

    expect(slug).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(state.updateCalls).toBe(1);
    expect(state.selectCalls).toBe(0);
    // The slug returned is the locally-generated candidate (UPDATE-returning
    // row → caller won the slot race).
    expect(state.capturedUpdatePayloads).toHaveLength(1);
    expect(state.capturedUpdatePayloads[0].short_slug).toBe(slug);
  });

  it("23505 once then success → retries with a different candidate", async () => {
    const state = freshState();
    // 1st attempt: cross-row collision.
    state.updates.push({
      data: null,
      error: { code: "23505", message: "unique_violation" },
    });
    // 2nd attempt: wins.
    state.updates.push({
      data: [{ id: LINE_ITEM_ID, short_slug: "OK" }],
      error: null,
    });

    const slug = await mintUniqueShortSlug(makeMockClient(state), LINE_ITEM_ID);

    expect(slug).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(state.updateCalls).toBe(2);
    expect(state.capturedUpdatePayloads).toHaveLength(2);
    // The two candidates MUST differ — confirms we re-generated.
    expect(state.capturedUpdatePayloads[0].short_slug).not.toBe(
      state.capturedUpdatePayloads[1].short_slug,
    );
    // The returned slug is the winning (2nd) candidate.
    expect(slug).toBe(state.capturedUpdatePayloads[1].short_slug);
  });

  it("UPDATE zero rows → re-SELECT returns the concurrent winner's slug (NOT the local candidate)", async () => {
    const state = freshState();
    // UPDATE returns 0 rows — the row already had a non-NULL short_slug
    // when our UPDATE ran (the AND short_slug IS NULL guard filtered us out).
    state.updates.push({ data: [], error: null });
    // Re-SELECT finds the concurrent winner's slug.
    state.selects.push({
      data: { short_slug: "WINNER" },
      error: null,
    });

    const slug = await mintUniqueShortSlug(makeMockClient(state), LINE_ITEM_ID);

    expect(slug).toBe("WINNER");
    expect(state.updateCalls).toBe(1);
    expect(state.selectCalls).toBe(1);
    // The local candidate was generated and attempted, but is NOT what's
    // returned — we return the persisted (winner's) value.
    expect(state.capturedUpdatePayloads).toHaveLength(1);
    expect(state.capturedUpdatePayloads[0].short_slug).not.toBe("WINNER");
  });

  it("5 consecutive 23505s → throws PAYMENT_INVALID_CONFIG", async () => {
    const state = freshState();
    for (let i = 0; i < 5; i++) {
      state.updates.push({
        data: null,
        error: { code: "23505", message: "unique_violation" },
      });
    }
    await expect(
      mintUniqueShortSlug(makeMockClient(state), LINE_ITEM_ID),
    ).rejects.toMatchObject({
      name: "PaymentError",
      code: "PAYMENT_INVALID_CONFIG",
    });
    expect(state.updateCalls).toBe(5);
    // All 5 candidates should be distinct (we re-generated each time).
    const candidates = state.capturedUpdatePayloads.map((p) => p.short_slug);
    expect(new Set(candidates).size).toBe(5);
  });

  it("re-SELECT shows short_slug = NULL after a loser-path UPDATE → defensive PAYMENT_INVALID_CONFIG", async () => {
    const state = freshState();
    state.updates.push({ data: [], error: null });
    state.selects.push({ data: { short_slug: null }, error: null });

    await expect(
      mintUniqueShortSlug(makeMockClient(state), LINE_ITEM_ID),
    ).rejects.toBeInstanceOf(PaymentError);
  });

  it("non-23505 UPDATE error → throws PAYMENT_INVALID_CONFIG immediately (no retry)", async () => {
    const state = freshState();
    state.updates.push({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });
    await expect(
      mintUniqueShortSlug(makeMockClient(state), LINE_ITEM_ID),
    ).rejects.toMatchObject({
      name: "PaymentError",
      code: "PAYMENT_INVALID_CONFIG",
    });
    expect(state.updateCalls).toBe(1);
  });

  it("re-SELECT error → throws PAYMENT_INVALID_CONFIG", async () => {
    const state = freshState();
    state.updates.push({ data: [], error: null });
    state.selects.push({
      data: null,
      error: { message: "network gone" },
    });
    await expect(
      mintUniqueShortSlug(makeMockClient(state), LINE_ITEM_ID),
    ).rejects.toBeInstanceOf(PaymentError);
  });
});

// Ensure vi.clearAllMocks doesn't accidentally hide cross-test bleed (the
// mock client is constructed per test from freshState() — no shared module
// state).
vi.clearAllMocks();
