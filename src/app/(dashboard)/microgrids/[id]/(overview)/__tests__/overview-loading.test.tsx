// Microgrid overview loading fallback test (node environment).
//
// Strategy: renderToStaticMarkup (pure server component, no data deps).

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import MicrogridOverviewLoading from "../loading";

describe("MicrogridOverviewLoading", () => {
  it("announces itself once via role=status", () => {
    const html = renderToStaticMarkup(<MicrogridOverviewLoading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading microgrid overview"');
    expect(html).toContain("Loading microgrid overview…");
  });

  it("renders skeleton blocks mirroring the page frame", () => {
    const html = renderToStaticMarkup(<MicrogridOverviewLoading />);
    // Breadcrumb + health card + 5-cell strip + 2-col grid + activity log.
    const blocks = (html.match(/bg-muted/g) ?? []).length;
    expect(blocks).toBeGreaterThan(20);
  });

  it("marks itself busy and hides blocks from assistive tech", () => {
    const html = renderToStaticMarkup(<MicrogridOverviewLoading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
  });
});
