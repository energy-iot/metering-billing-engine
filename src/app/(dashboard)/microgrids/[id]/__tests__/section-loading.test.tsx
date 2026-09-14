// Microgrid section loading fallback test (node environment).
//
// Strategy: renderToStaticMarkup (pure server component, no data deps).

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import MicrogridSectionLoading from "../loading";

describe("MicrogridSectionLoading", () => {
  it("announces itself once via role=status", () => {
    const html = renderToStaticMarkup(<MicrogridSectionLoading />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading microgrid"');
    expect(html).toContain("Loading microgrid…");
  });

  it("stays generic — no overview-specific markers (pr-375)", () => {
    const html = renderToStaticMarkup(<MicrogridSectionLoading />);
    expect(html).not.toContain("Loading microgrid overview");
    // Only a handful of blocks: breadcrumb + two cards, not the ~40-block
    // overview frame.
    const blocks = (html.match(/bg-muted/g) ?? []).length;
    expect(blocks).toBeLessThan(15);
  });

  it("marks itself busy and hides blocks from assistive tech", () => {
    const html = renderToStaticMarkup(<MicrogridSectionLoading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
  });
});
