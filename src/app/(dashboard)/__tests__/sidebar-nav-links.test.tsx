// @vitest-environment jsdom
/**
 * SidebarNavLinks tests (#97).
 *
 * Strategy:
 *   - Render SidebarNavLinks directly with a fixed entries prop — no server
 *     parent involvement. The super_admin gate is exercised by including or
 *     excluding the Organizations entry in the prop.
 *   - Mock usePathname per test via vi.mock with a module-level getter so
 *     each test can control the pathname before rendering.
 *   - Use getByRole("navigation", { name: /primary/i }) for scoped queries
 *     so tests are immune to other navs on the page.
 *   - Assertions use getAttribute (no jest-dom required).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { SidebarEntry } from "../sidebar-nav-links";

// ─── Module-level pathname state ─────────────────────────────────────────────

let mockPathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

// next/link is a server component in Next.js; in jsdom tests we stub it as a
// plain <a> so RTL can find it via getByRole("link").
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ─── Lazy import after mocks ──────────────────────────────────────────────────

// Import after vi.mock calls so the module picks up the mocked dependencies.
import { SidebarNavLinks } from "../sidebar-nav-links";

// ─── Fixture entries ──────────────────────────────────────────────────────────

const baseEntries: SidebarEntry[] = [
  { label: "Dashboard", href: "/", matchPrefix: "/", exact: true },
  { label: "Communities", href: "/communities", matchPrefix: "/communities" },
  { label: "Microgrids", href: "/microgrids", matchPrefix: "/microgrids" },
  {
    label: "Settings",
    href: "/settings/profile",
    matchPrefix: "/settings",
  },
];

const entriesWithOrgs: SidebarEntry[] = [
  { label: "Dashboard", href: "/", matchPrefix: "/", exact: true },
  {
    label: "Organizations",
    href: "/organizations",
    matchPrefix: "/organizations",
  },
  { label: "Communities", href: "/communities", matchPrefix: "/communities" },
  { label: "Microgrids", href: "/microgrids", matchPrefix: "/microgrids" },
  {
    label: "Settings",
    href: "/settings/profile",
    matchPrefix: "/settings",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderNav(entries: SidebarEntry[] = entriesWithOrgs) {
  render(<SidebarNavLinks entries={entries} />);
  return within(screen.getByRole("navigation", { name: /primary/i }));
}

function getLink(nav: ReturnType<typeof renderNav>, name: string) {
  return nav.getByRole("link", { name });
}

beforeEach(() => {
  mockPathname = "/";
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SidebarNavLinks", () => {
  // (h) nav element carries aria-label="Primary"
  it("(h) nav has aria-label='Primary'", () => {
    mockPathname = "/";
    renderNav();
    expect(
      screen.getByRole("navigation", { name: /primary/i })
    ).toBeDefined();
  });

  // (a) exact match: pathname="/" → Dashboard active, others not
  it("(a) pathname='/' → Dashboard has aria-current='page'", () => {
    mockPathname = "/";
    const nav = renderNav();

    expect(getLink(nav, "Dashboard").getAttribute("aria-current")).toBe("page");
    expect(getLink(nav, "Communities").getAttribute("aria-current")).toBeNull();
    expect(getLink(nav, "Microgrids").getAttribute("aria-current")).toBeNull();
    expect(getLink(nav, "Settings").getAttribute("aria-current")).toBeNull();
    expect(getLink(nav, "Organizations").getAttribute("aria-current")).toBeNull();
  });

  // negative: "/" must NOT trigger prefix entries (Dashboard is exact-only)
  it("(a-neg) pathname='/' does NOT highlight Communities via prefix", () => {
    mockPathname = "/";
    const nav = renderNav();
    // Communities has matchPrefix="/communities" → must be idle at "/"
    expect(getLink(nav, "Communities").getAttribute("aria-current")).toBeNull();
  });

  // (b) direct pathname match
  it("(b) pathname='/communities' → Communities has aria-current='page'", () => {
    mockPathname = "/communities";
    const nav = renderNav();

    expect(getLink(nav, "Communities").getAttribute("aria-current")).toBe("page");
    expect(getLink(nav, "Dashboard").getAttribute("aria-current")).toBeNull();
    expect(getLink(nav, "Microgrids").getAttribute("aria-current")).toBeNull();
  });

  // (c) prefix match via child route
  it("(c) pathname='/communities/abc-123' → Communities still active", () => {
    mockPathname = "/communities/abc-123";
    const nav = renderNav();

    expect(getLink(nav, "Communities").getAttribute("aria-current")).toBe("page");
    expect(getLink(nav, "Dashboard").getAttribute("aria-current")).toBeNull();
  });

  // (d) Settings — exact child (/settings/profile) maps to matchPrefix=/settings
  it("(d) pathname='/settings/profile' → Settings active", () => {
    mockPathname = "/settings/profile";
    const nav = renderNav();

    expect(getLink(nav, "Settings").getAttribute("aria-current")).toBe("page");
    expect(getLink(nav, "Dashboard").getAttribute("aria-current")).toBeNull();
  });

  // (e) Settings — any /settings/* route keeps it highlighted
  it("(e) pathname='/settings/users' → Settings active", () => {
    mockPathname = "/settings/users";
    const nav = renderNav();

    expect(getLink(nav, "Settings").getAttribute("aria-current")).toBe("page");
    expect(getLink(nav, "Dashboard").getAttribute("aria-current")).toBeNull();
  });

  // (f) isSuperAdmin=false → Organizations NOT rendered
  it("(f) isSuperAdmin=false → Organizations link absent", () => {
    mockPathname = "/";
    renderNav(baseEntries); // baseEntries has no Organizations entry
    expect(
      screen.queryByRole("link", { name: "Organizations" })
    ).toBeNull();
  });

  // (g) isSuperAdmin=true → Organizations rendered
  it("(g) isSuperAdmin=true → Organizations link present", () => {
    mockPathname = "/";
    const nav = renderNav(entriesWithOrgs);
    expect(getLink(nav, "Organizations")).toBeDefined();
  });

  // active styling: active link carries bg-accent + text-accent-foreground
  it("active link carries correct CSS classes", () => {
    mockPathname = "/microgrids";
    const nav = renderNav();
    const link = getLink(nav, "Microgrids");
    expect(link.className).toContain("bg-accent");
    expect(link.className).toContain("text-accent-foreground");
  });

  // idle styling: idle link does NOT carry active class combo
  it("idle link carries text-muted-foreground", () => {
    mockPathname = "/microgrids";
    const nav = renderNav();
    const link = getLink(nav, "Communities");
    expect(link.className).toContain("text-muted-foreground");
    // bg-accent text-accent-foreground is not in a continuous sequence for idle links
    expect(link.getAttribute("aria-current")).toBeNull();
  });
});
