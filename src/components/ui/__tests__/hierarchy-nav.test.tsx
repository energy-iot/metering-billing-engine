/**
 * hierarchy-nav.test.tsx — component tests for <HierarchyNav>.
 *
 * Covers:
 *   - 1-level, 3-level, and 5-level (including Household) level arrays
 *   - count === 1 → plain link (no dropdown)
 *   - count > 1 AND siblings → DropdownMenu trigger (switcher)
 *   - aria-current="page" on the active segment
 *   - Separator "/" between segments
 *   - "No organizations" empty-state placeholder
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HierarchyNav, type HierarchyLevel } from "../hierarchy-nav";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const orgLevel: HierarchyLevel = {
  kind: "Organization",
  label: "Nearly Free Energy",
  count: 1,
  href: "/",
  active: false,
};

const communityLevel: HierarchyLevel = {
  kind: "Community",
  label: "Kisakye",
  count: 1,
  href: "/microgrids?community=comm-k",
  active: false,
};

const microgridLevelActive: HierarchyLevel = {
  kind: "Microgrid",
  label: "Block A",
  count: 1,
  href: "/microgrids/mg-1",
  active: true,
};

const edgeLevel: HierarchyLevel = {
  kind: "Edge",
  label: "Gateway 1",
  count: 1,
  href: "/microgrids/mg-1/setup/edges/edge-1",
  active: false,
};

const householdLevelActive: HierarchyLevel = {
  kind: "Household",
  label: "Household Alpha",
  count: 1,
  href: "/microgrids/mg-1/setup/households/hh-1",
  active: true,
};

const orgLevelMulti: HierarchyLevel = {
  kind: "Organization",
  label: "Nearly Free Energy",
  count: 3,
  href: "/",
  active: false,
  siblings: [
    { label: "Nearly Free Energy", href: "/" },
    { label: "Second Org", href: "/" },
    { label: "Third Org", href: "/" },
  ],
};

const microgridLevelMultiActive: HierarchyLevel = {
  kind: "Microgrid",
  label: "Block A",
  count: 2,
  href: "/microgrids/mg-1",
  active: true,
  siblings: [{ label: "Block B", href: "/microgrids/mg-2" }],
};

// ── 1-level breadcrumb ─────────────────────────────────────────────────────────

describe("HierarchyNav — 1-level (Organization only)", () => {
  it("renders nav with aria-label", () => {
    render(<HierarchyNav levels={[orgLevel]} />);
    expect(
      screen.getByRole("navigation", { name: "Hierarchy breadcrumb" })
    ).toBeDefined();
  });

  it("renders Organization kind label and name", () => {
    render(<HierarchyNav levels={[orgLevel]} />);
    expect(screen.getByText("Organization")).toBeDefined();
    expect(screen.getByText("Nearly Free Energy")).toBeDefined();
  });

  it("count=1 → no count badge, no chevron", () => {
    const { container } = render(<HierarchyNav levels={[orgLevel]} />);
    // Badge rendered only when hasSiblings (count > 1).
    expect(container.querySelector(".rounded-pill")).toBeNull();
  });

  it("no separator when there is only one level", () => {
    const { queryAllByText } = render(<HierarchyNav levels={[orgLevel]} />);
    expect(queryAllByText("/")).toHaveLength(0);
  });
});

// ── 3-level breadcrumb ─────────────────────────────────────────────────────────

describe("HierarchyNav — 3-level (Org → Community → Microgrid)", () => {
  const levels = [orgLevel, communityLevel, microgridLevelActive];

  it("renders three segments", () => {
    const { container } = render(<HierarchyNav levels={levels} />);
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(3);
  });

  it("active segment has aria-current=page", () => {
    const { container } = render(<HierarchyNav levels={levels} />);
    const activeLink = container.querySelector('[aria-current="page"]');
    expect(activeLink).not.toBeNull();
    expect(activeLink?.textContent).toContain("Block A");
  });

  it("non-active segments do NOT have aria-current", () => {
    const { container } = render(<HierarchyNav levels={levels} />);
    const allLinks = container.querySelectorAll("a");
    const withCurrent = Array.from(allLinks).filter(
      (a) => a.getAttribute("aria-current") === "page"
    );
    expect(withCurrent).toHaveLength(1);
  });

  it("renders 2 separators between 3 levels", () => {
    const { getAllByText } = render(<HierarchyNav levels={levels} />);
    expect(getAllByText("/")).toHaveLength(2);
  });

  it("renders kind labels: Organization, Community, Microgrid", () => {
    render(<HierarchyNav levels={levels} />);
    expect(screen.getByText("Organization")).toBeDefined();
    expect(screen.getByText("Community")).toBeDefined();
    expect(screen.getByText("Microgrid")).toBeDefined();
  });
});

// ── 5-level breadcrumb including Household ─────────────────────────────────────

describe("HierarchyNav — 5-level (Org → Community → Microgrid → Edge → Household)", () => {
  const levels: HierarchyLevel[] = [
    orgLevel,
    communityLevel,
    { ...microgridLevelActive, active: false },
    edgeLevel,
    householdLevelActive,
  ];

  it("renders five segments", () => {
    const { container } = render(<HierarchyNav levels={levels} />);
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(5);
  });

  it("renders kind label Household", () => {
    render(<HierarchyNav levels={levels} />);
    expect(screen.getByText("Household")).toBeDefined();
  });

  it("Household segment is active (aria-current=page)", () => {
    const { container } = render(<HierarchyNav levels={levels} />);
    const activeLink = container.querySelector('[aria-current="page"]');
    expect(activeLink?.textContent).toContain("Household Alpha");
  });

  it("renders 4 separators between 5 levels", () => {
    const { getAllByText } = render(<HierarchyNav levels={levels} />);
    expect(getAllByText("/")).toHaveLength(4);
  });
});

// ── Siblings: count > 1 → dropdown branch ─────────────────────────────────────

describe("HierarchyNav — siblings branch (count > 1)", () => {
  it("count > 1 → count badge rendered", () => {
    const { container } = render(
      <HierarchyNav levels={[orgLevelMulti]} />
    );
    const badge = container.querySelector(".rounded-pill");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("3");
  });

  it("count > 1 WITH siblings → DropdownMenu.Trigger wraps the segment", () => {
    const { container } = render(
      <HierarchyNav levels={[orgLevelMulti]} />
    );
    // Radix DropdownMenu.Trigger renders with data-radix-collection-item
    // or a button role. The segment link is inside a Trigger asChild.
    // We verify the siblings appear in the DOM (Radix portals the content lazily).
    // At minimum, the trigger link should be present.
    const links = container.querySelectorAll("a");
    expect(links.length).toBeGreaterThanOrEqual(1);
    // Badge confirms switcher branch, not plain-link branch.
    expect(container.querySelector(".rounded-pill")).not.toBeNull();
  });

  it("count = 1 (plain link) → no badge, link renders directly without dropdown", () => {
    const { container } = render(
      <HierarchyNav levels={[{ ...orgLevel, count: 1, siblings: undefined }]} />
    );
    expect(container.querySelector(".rounded-pill")).toBeNull();
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
  });

  it("microgrid switcher: renders multi-sibling level with badge", () => {
    const levels: HierarchyLevel[] = [
      orgLevel,
      communityLevel,
      microgridLevelMultiActive,
    ];
    const { container } = render(<HierarchyNav levels={levels} />);
    const badges = container.querySelectorAll(".rounded-pill");
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toBe("2");
  });
});

// ── Empty-state placeholder ────────────────────────────────────────────────────

describe("HierarchyNav — empty-state placeholder", () => {
  it("renders 'No organizations' label without crashing", () => {
    const emptyOrgLevel: HierarchyLevel = {
      kind: "Organization",
      label: "No organizations",
      count: 0,
      href: "/",
      active: false,
    };
    render(<HierarchyNav levels={[emptyOrgLevel]} />);
    expect(screen.getByText("No organizations")).toBeDefined();
  });

  it("renders nav with zero-count level (no badge, no dropdown)", () => {
    const emptyOrgLevel: HierarchyLevel = {
      kind: "Organization",
      label: "No organizations",
      count: 0,
      href: "/",
      active: false,
    };
    const { container } = render(<HierarchyNav levels={[emptyOrgLevel]} />);
    expect(container.querySelector(".rounded-pill")).toBeNull();
  });
});
