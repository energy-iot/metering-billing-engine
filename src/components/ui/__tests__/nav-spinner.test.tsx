// NavSpinner test — shared pending-navigation spinner.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import { NavSpinner } from "../nav-spinner";

describe("NavSpinner", () => {
  it("is decorative and motion-safe (pr-374 design review)", () => {
    const html = renderToStaticMarkup(<NavSpinner />);
    expect(html).toContain('aria-hidden="true"');
    // Reduced-motion users must not get a spinning spinner: the spin class
    // may only appear behind the motion-safe: variant, never as a bare token.
    const classAttr = html.match(/class="([^"]*)"/)?.[1] ?? "";
    const tokens = classAttr.split(/\s+/);
    expect(tokens).toContain("motion-safe:animate-spin");
    expect(tokens).not.toContain("animate-spin");
  });

  it("merges caller layout classes", () => {
    const html = renderToStaticMarkup(<NavSpinner className="ml-auto" />);
    expect(html).toContain("ml-auto");
  });
});
