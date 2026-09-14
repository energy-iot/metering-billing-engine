// Billing period detail loading fallback test (node environment).
//
// Strategy: renderToStaticMarkup (pure server component, no data deps).

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import BillingPeriodDetailLoading from "../loading";

describe("BillingPeriodDetailLoading", () => {
  it("announces itself once via role=status", () => {
    const html = renderToStaticMarkup(<BillingPeriodDetailLoading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading billing period"');
    expect(html).toContain("Loading billing period…");
  });

  it("renders header + body rows + footer skeleton blocks", () => {
    const html = renderToStaticMarkup(<BillingPeriodDetailLoading />);
    const blocks = (html.match(/bg-muted/g) ?? []).length;
    // Threshold, not exact: adding/removing one block must not break this.
    expect(blocks).toBeGreaterThan(30);
  });

  it("marks itself busy and hides blocks from assistive tech", () => {
    const html = renderToStaticMarkup(<BillingPeriodDetailLoading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
  });
});
