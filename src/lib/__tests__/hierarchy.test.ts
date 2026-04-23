/**
 * hierarchy.test.ts — unit tests for getHierarchyLevels().
 *
 * Uses a mocked Supabase client to verify:
 *   - Correct shape for each scope variant
 *   - Counts match RLS-scoped rows
 *   - Siblings populate only where count > 1
 *   - Empty-state cases (0 orgs, 1 org + 0 communities, 1 org + 1 community + 0 microgrids)
 */
import { describe, it, expect } from "vitest";
import { getHierarchyLevels } from "@/lib/hierarchy";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Mock factory ────────────────────────────────────────────────────────────────

type MockQueryResult = { data: unknown; error: null };

/**
 * Create a minimal Supabase mock.
 * `tables` is a map from table name to the rows that `select()` returns.
 * `singleOverrides` maps "table:column=value" to a specific single row result.
 */
function makeMockSupabase(
  tables: Record<string, unknown[]>,
): SupabaseClient {
  const builder = (tableName: string) => {
    const _eq: [string, string][] = [];

    const proxy: {
      select: (cols: string) => typeof proxy;
      eq: (col: string, val: string) => typeof proxy;
      order: (col: string) => typeof proxy;
      returns: () => Promise<MockQueryResult>;
      single: () => Promise<MockQueryResult>;
      maybeSingle: () => Promise<MockQueryResult>;
    } = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      select(_cols: string) { return proxy; },
      eq(col: string, val: string) { _eq.push([col, val]); return proxy; },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      order(_col: string) { return proxy; },
      returns(): Promise<MockQueryResult> {
        let rows = (tables[tableName] ?? []) as Record<string, unknown>[];
        for (const [col, val] of _eq) {
          rows = rows.filter((r) => r[col] === val);
        }
        return Promise.resolve({ data: rows, error: null });
      },
      single(): Promise<MockQueryResult> {
        let rows = (tables[tableName] ?? []) as Record<string, unknown>[];
        for (const [col, val] of _eq) {
          rows = rows.filter((r) => r[col] === val);
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      maybeSingle(): Promise<MockQueryResult> {
        let rows = (tables[tableName] ?? []) as Record<string, unknown>[];
        for (const [col, val] of _eq) {
          rows = rows.filter((r) => r[col] === val);
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
    };
    return proxy;
  };

  return {
    from: (tableName: string) => builder(tableName),
  } as unknown as SupabaseClient;
}

// ── Fixture data ────────────────────────────────────────────────────────────────

const ORG_A = { id: "org-a", name: "Nearly Free Energy" };
const COMMUNITY_K = { id: "comm-k", name: "Kisakye", org_id: "org-a" };
const MICROGRID_1 = { id: "mg-1", name: "Block A", community_id: "comm-k" };
const EDGE_1 = { id: "edge-1", name: "Gateway 1", microgrid_id: "mg-1" };
const HH_1 = { id: "hh-1", display_name: "Household Alpha", microgrid_id: "mg-1" };

// ── Empty-state: 0 orgs ────────────────────────────────────────────────────────

describe("getHierarchyLevels — empty-state: 0 orgs", () => {
  const supabase = makeMockSupabase({ organizations: [] });

  it("communities scope: returns [Organization placeholder]", async () => {
    const levels = await getHierarchyLevels(supabase, { kind: "communities" });
    expect(levels).toHaveLength(1);
    expect(levels[0].kind).toBe("Organization");
    expect(levels[0].label).toBe("No organizations");
    expect(levels[0].count).toBe(0);
  });

  it("microgrids scope: returns [Organization placeholder]", async () => {
    const levels = await getHierarchyLevels(supabase, { kind: "microgrids" });
    expect(levels).toHaveLength(1);
    expect(levels[0].kind).toBe("Organization");
    expect(levels[0].count).toBe(0);
  });
});

// ── Empty-state: 1 org + 0 communities ────────────────────────────────────────

describe("getHierarchyLevels — empty-state: 1 org + 0 communities", () => {
  const supabase = makeMockSupabase({
    organizations: [ORG_A],
    communities: [],
    microgrids: [],
  });

  it("communities scope: returns [Organization(count=1)] only", async () => {
    const levels = await getHierarchyLevels(supabase, { kind: "communities" });
    expect(levels).toHaveLength(1);
    expect(levels[0].kind).toBe("Organization");
    expect(levels[0].count).toBe(1);
    expect(levels[0].label).toBe("Nearly Free Energy");
    // count=1 → no siblings.
    expect(levels[0].siblings).toBeUndefined();
  });

  it("microgrids scope without communityId: returns [Organization] only", async () => {
    const levels = await getHierarchyLevels(supabase, { kind: "microgrids" });
    expect(levels).toHaveLength(1);
    expect(levels[0].kind).toBe("Organization");
  });
});

// ── Empty-state: 1 org + 1 community + 0 microgrids ───────────────────────────

describe("getHierarchyLevels — empty-state: 1 org + 1 community + 0 microgrids", () => {
  const supabase = makeMockSupabase({
    organizations: [ORG_A],
    communities: [COMMUNITY_K],
    microgrids: [],
  });

  it("microgrids scope with communityId: returns [Organization, Community] only", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "microgrids",
      communityId: "comm-k",
    });
    expect(levels).toHaveLength(2);
    expect(levels[0].kind).toBe("Organization");
    expect(levels[1].kind).toBe("Community");
    expect(levels[1].label).toBe("Kisakye");
    expect(levels[1].count).toBe(1);
    expect(levels[1].siblings).toBeUndefined();
  });
});

// ── Siblings populate only when count > 1 ─────────────────────────────────────

describe("getHierarchyLevels — siblings branch", () => {
  const ORG_B = { id: "org-b", name: "Second Org" };
  const COMMUNITY_K2 = { id: "comm-k2", name: "Kisakye 2", org_id: "org-a" };
  const MICROGRID_2 = { id: "mg-2", name: "Block B", community_id: "comm-k" };

  const supabase = makeMockSupabase({
    organizations: [ORG_A, ORG_B],
    communities: [COMMUNITY_K, COMMUNITY_K2],
    microgrids: [MICROGRID_1, MICROGRID_2],
    edges: [EDGE_1],
    households: [HH_1],
  });

  it("org count > 1 → siblings populated for Organization level", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: "mg-1",
    });
    const orgLevel = levels.find((l) => l.kind === "Organization");
    expect(orgLevel).toBeDefined();
    expect(orgLevel!.count).toBe(2);
    expect(orgLevel!.siblings).toBeDefined();
    expect(orgLevel!.siblings!.length).toBe(2);
  });

  it("community count > 1 → siblings populated for Community level", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: "mg-1",
    });
    const commLevel = levels.find((l) => l.kind === "Community");
    expect(commLevel).toBeDefined();
    expect(commLevel!.count).toBe(2);
    expect(commLevel!.siblings).toBeDefined();
  });

  it("microgrid count > 1 → siblings populated for Microgrid level; excludes self", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: "mg-1",
    });
    const mgLevel = levels.find((l) => l.kind === "Microgrid");
    expect(mgLevel).toBeDefined();
    expect(mgLevel!.count).toBe(2);
    expect(mgLevel!.siblings).toBeDefined();
    // Self-exclusion: siblings should NOT contain mg-1.
    const siblingHrefs = mgLevel!.siblings!.map((s) => s.href);
    expect(siblingHrefs.some((h) => h.includes("mg-1"))).toBe(false);
    expect(siblingHrefs.some((h) => h.includes("mg-2"))).toBe(true);
  });

  it("microgrid count = 1 → no siblings for Microgrid level", async () => {
    const singleMgSupabase = makeMockSupabase({
      organizations: [ORG_A],
      communities: [COMMUNITY_K],
      microgrids: [MICROGRID_1],
      edges: [],
      households: [],
    });
    const levels = await getHierarchyLevels(singleMgSupabase, {
      kind: "microgrid",
      microgridId: "mg-1",
    });
    const mgLevel = levels.find((l) => l.kind === "Microgrid");
    expect(mgLevel!.count).toBe(1);
    expect(mgLevel!.siblings).toBeUndefined();
  });
});

// ── Scope variants ─────────────────────────────────────────────────────────────

describe("getHierarchyLevels — scope variants", () => {
  const supabase = makeMockSupabase({
    organizations: [ORG_A],
    communities: [COMMUNITY_K],
    microgrids: [MICROGRID_1],
    edges: [EDGE_1],
    households: [HH_1],
  });

  it("communities scope → 1-level [Organization]", async () => {
    const levels = await getHierarchyLevels(supabase, { kind: "communities" });
    expect(levels).toHaveLength(1);
    expect(levels[0].kind).toBe("Organization");
    expect(levels[0].active).toBe(false);
  });

  it("microgrid scope → 3-level [Org, Community, Microgrid] with Microgrid active", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: "mg-1",
    });
    expect(levels).toHaveLength(3);
    expect(levels[0].kind).toBe("Organization");
    expect(levels[1].kind).toBe("Community");
    expect(levels[2].kind).toBe("Microgrid");
    expect(levels[2].active).toBe(true);
    expect(levels[0].active).toBe(false);
  });

  it("edge scope → 4-level [Org, Community, Microgrid, Edge] with Edge active", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "edge",
      microgridId: "mg-1",
      edgeId: "edge-1",
    });
    expect(levels).toHaveLength(4);
    expect(levels[3].kind).toBe("Edge");
    expect(levels[3].active).toBe(true);
    expect(levels[2].active).toBe(false);
  });

  it("household scope → 4-level [Org, Community, Microgrid, Household] with Household active", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "household",
      microgridId: "mg-1",
      householdId: "hh-1",
    });
    expect(levels).toHaveLength(4);
    expect(levels[3].kind).toBe("Household");
    expect(levels[3].active).toBe(true);
  });
});

// ── href contracts ─────────────────────────────────────────────────────────────

describe("getHierarchyLevels — href contracts", () => {
  const supabase = makeMockSupabase({
    organizations: [ORG_A],
    communities: [COMMUNITY_K],
    microgrids: [MICROGRID_1],
    edges: [EDGE_1],
    households: [HH_1],
  });

  it("Organization href is /", async () => {
    const levels = await getHierarchyLevels(supabase, { kind: "communities" });
    expect(levels[0].href).toBe("/");
  });

  it("Community href points to /microgrids?community=<id>", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: "mg-1",
    });
    const commLevel = levels.find((l) => l.kind === "Community");
    expect(commLevel!.href).toBe("/microgrids?community=comm-k");
  });

  it("Microgrid href points to /microgrids/<id>", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: "mg-1",
    });
    const mgLevel = levels.find((l) => l.kind === "Microgrid");
    expect(mgLevel!.href).toBe("/microgrids/mg-1");
  });

  it("Edge href points to /microgrids/<mgId>/setup/edges/<edgeId>", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "edge",
      microgridId: "mg-1",
      edgeId: "edge-1",
    });
    const edgeLevel = levels.find((l) => l.kind === "Edge");
    expect(edgeLevel!.href).toBe("/microgrids/mg-1/setup/edges/edge-1");
  });

  it("Household href points to /microgrids/<mgId>/setup/households/<hhId>", async () => {
    const levels = await getHierarchyLevels(supabase, {
      kind: "household",
      microgridId: "mg-1",
      householdId: "hh-1",
    });
    const hhLevel = levels.find((l) => l.kind === "Household");
    expect(hhLevel!.href).toBe("/microgrids/mg-1/setup/households/hh-1");
  });
});
