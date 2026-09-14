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

  it("renders header + 8 body rows + footer skeleton blocks", () => {
    const html = renderToStaticMarkup(<BillingPeriodDetailLoading />);
    const blocks = (html.match(/bg-muted/g) ?? []).length;
    // 3 breadcrumb + 3 header + 4 table-head + 8 rows × 4 + footer = 43.
    expect(blocks).toBe(43);
  });

  it("marks itself busy and hides blocks from assistive tech", () => {
    const html = renderToStaticMarkup(<BillingPeriodDetailLoading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
  });
});
