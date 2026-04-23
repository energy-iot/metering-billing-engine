import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Chip } from "../chip";

describe("Chip", () => {
  it("renders bg-success-muted and text-success-fg for tone='success'", () => {
    const { container } = render(<Chip tone="success" dot>Test</Chip>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("bg-success-muted");
    expect(span?.className).toContain("text-success-fg");
  });

  it("dot span has aria-hidden='true'", () => {
    const { container } = render(<Chip tone="success" dot>Test</Chip>);
    const dotSpan = container.querySelector("span > span[aria-hidden='true']");
    expect(dotSpan).not.toBeNull();
    expect(dotSpan?.getAttribute("aria-hidden")).toBe("true");
  });

  it("forwards aria-label prop", () => {
    const { container } = render(
      <Chip tone="neutral" aria-label="Custom label">Test</Chip>
    );
    const span = container.querySelector("span");
    expect(span?.getAttribute("aria-label")).toBe("Custom label");
  });
});
