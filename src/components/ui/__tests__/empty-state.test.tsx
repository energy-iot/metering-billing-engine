// @vitest-environment jsdom
/**
 * EmptyState primitive tests (#139).
 *
 * Covers:
 *   (a) Renders title as <h3> with id wired to aria-labelledby on region wrapper
 *   (b) role="region" present on the wrapper
 *   (c) All slot props render: eyebrow above title, body below title,
 *       cta/secondary row below body, footnote at bottom
 *   (d) tone="warn" adds border-l-4 border-warning; tone="neutral" adds border-border
 *   (e) icon renders with aria-hidden="true"
 *   (f) Role-locked variant (no cta, only footnote): CTA row NOT rendered; footnote renders
 *   (g) Custom id prop propagates to the wrapper and to the title's id
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "../empty-state";

// ─── (a) + (b) ───────────────────────────────────────────────────────────────

describe("EmptyState — structure", () => {
  it("(a) renders title as <h3> and wires aria-labelledby", () => {
    const { container } = render(
      <EmptyState title="Add the first community" body="A community is a site." />,
    );
    const h3 = container.querySelector("h3");
    expect(h3).not.toBeNull();
    expect(h3?.textContent).toBe("Add the first community");

    const region = container.querySelector("[role='region']");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-labelledby")).toBe(h3?.id);
  });

  it("(b) wraps the card in role='region'", () => {
    render(<EmptyState title="Add the first edge" body="An edge connects." />);
    const region = screen.getByRole("region");
    expect(region).not.toBeNull();
  });
});

// ─── (c) slot props ──────────────────────────────────────────────────────────

describe("EmptyState — slot props", () => {
  it("(c) renders eyebrow above the title", () => {
    const { container } = render(
      <EmptyState eyebrow="Communities" title="Add the first community" body="A community is a site." />,
    );
    const eyebrow = container.querySelector("p.uppercase");
    expect(eyebrow?.textContent).toBe("Communities");
    const h3 = container.querySelector("h3");
    // eyebrow should appear before h3 in the DOM
    const eyebrowPos = Array.from(container.querySelectorAll("*")).indexOf(eyebrow!);
    const h3Pos = Array.from(container.querySelectorAll("*")).indexOf(h3!);
    expect(eyebrowPos).toBeLessThan(h3Pos);
  });

  it("(c) renders body text below the title", () => {
    render(
      <EmptyState title="Add the first community" body="A community is a place." />,
    );
    expect(screen.getByText("A community is a place.")).toBeTruthy();
  });

  it("(c) renders cta and secondary in the same flex row", () => {
    const { container } = render(
      <EmptyState
        title="Add edge"
        body="An edge."
        cta={<button>+ Add edge</button>}
        secondary={<a href="/setup">Configure →</a>}
      />,
    );
    const ctaRow = container.querySelector(".mt-4.flex");
    expect(ctaRow).not.toBeNull();
    expect(ctaRow?.querySelector("button")?.textContent).toBe("+ Add edge");
    expect(ctaRow?.querySelector("a")?.textContent).toBe("Configure →");
  });

  it("(c) renders footnote at the bottom", () => {
    render(
      <EmptyState
        title="Add edge"
        body="An edge."
        footnote="Ask a super admin to add edges."
      />,
    );
    expect(screen.getByText("Ask a super admin to add edges.")).toBeTruthy();
  });
});

// ─── (d) tone ────────────────────────────────────────────────────────────────

describe("EmptyState — tone", () => {
  it("(d) tone='warn' adds border-l-4 and border-warning classes", () => {
    const { container } = render(
      <EmptyState tone="warn" title="Edge offline" body="Can't discover." />,
    );
    const region = container.querySelector("[role='region']");
    expect(region?.className).toContain("border-l-4");
    expect(region?.className).toContain("border-warning");
  });

  it("(d) tone='neutral' (default) adds border-border class", () => {
    const { container } = render(
      <EmptyState title="Add the first community" body="A community is a site." />,
    );
    const region = container.querySelector("[role='region']");
    expect(region?.className).toContain("border-border");
    expect(region?.className).not.toContain("border-warning");
  });

  it("(d) explicit tone='neutral' adds border-border class", () => {
    const { container } = render(
      <EmptyState tone="neutral" title="Add the first community" body="A community is a site." />,
    );
    const region = container.querySelector("[role='region']");
    expect(region?.className).toContain("border-border");
    expect(region?.className).not.toContain("border-warning");
  });
});

// ─── (e) icon ────────────────────────────────────────────────────────────────

describe("EmptyState — icon", () => {
  it("(e) icon renders with aria-hidden='true' wrapper", () => {
    const { container } = render(
      <EmptyState
        title="Add edge"
        body="An edge."
        icon={<span data-testid="icon-glyph">⚡</span>}
      />,
    );
    const iconWrapper = container.querySelector("[aria-hidden='true']");
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.querySelector("[data-testid='icon-glyph']")).not.toBeNull();
  });

  it("(e) no icon slot = no aria-hidden wrapper", () => {
    const { container } = render(
      <EmptyState title="Add edge" body="An edge." />,
    );
    const iconWrapper = container.querySelector("[aria-hidden='true']");
    expect(iconWrapper).toBeNull();
  });
});

// ─── (f) role-locked variant ──────────────────────────────────────────────────

describe("EmptyState — role-locked variant", () => {
  it("(f) CTA row NOT rendered when no cta and no secondary", () => {
    const { container } = render(
      <EmptyState
        title="Add edge"
        body="An edge."
        footnote="Ask a super admin to add edges."
      />,
    );
    // The CTA row has both mt-4 and flex classes — it should not appear
    const ctaRow = container.querySelector(".mt-4.flex.flex-wrap");
    expect(ctaRow).toBeNull();
  });

  it("(f) footnote renders without cta", () => {
    render(
      <EmptyState
        title="Add edge"
        body="An edge."
        footnote="Ask a super admin to add edges."
      />,
    );
    expect(screen.getByText("Ask a super admin to add edges.")).toBeTruthy();
  });
});

// ─── (g) custom id ────────────────────────────────────────────────────────────

describe("EmptyState — custom id", () => {
  it("(g) custom id propagates to wrapper element", () => {
    const { container } = render(
      <EmptyState id="empty-households" title="Add household" body="A household." />,
    );
    const region = container.querySelector("[role='region']");
    expect(region?.id).toBe("empty-households");
  });

  it("(g) title id uses custom id as prefix", () => {
    const { container } = render(
      <EmptyState id="empty-households" title="Add household" body="A household." />,
    );
    const h3 = container.querySelector("h3");
    expect(h3?.id).toBe("empty-households-title");
    const region = container.querySelector("[role='region']");
    expect(region?.getAttribute("aria-labelledby")).toBe("empty-households-title");
  });
});

// ─── className merge ──────────────────────────────────────────────────────────

describe("EmptyState — className merge", () => {
  it("merges custom className with base classes", () => {
    const { container } = render(
      <EmptyState
        title="Rate schedule"
        body="Tiers define price bands."
        className="border-0 shadow-none bg-transparent p-0"
      />,
    );
    const region = container.querySelector("[role='region']");
    expect(region?.className).toContain("border-0");
    expect(region?.className).toContain("shadow-none");
    expect(region?.className).toContain("p-0");
  });
});
