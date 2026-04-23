import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { RadioGroup } from "../radio-group";
import { RadioCard } from "../radio-card";

describe("RadioCard", () => {
  it("clicking the card body selects the radio (label wraps item)", () => {
    const { container } = render(
      <RadioGroup defaultValue="">
        <RadioCard value="opt-a" title="Option A" id="card-a" />
      </RadioGroup>
    );

    // The label element should have htmlFor matching the radio input id
    const label = container.querySelector("label");
    const radio = container.querySelector("button[role='radio']") as HTMLElement | null
      ?? container.querySelector("[role='radio']") as HTMLElement | null;

    expect(label).not.toBeNull();
    expect(radio).not.toBeNull();
    expect(label?.getAttribute("for")).toBe(radio?.getAttribute("id"));
  });

  it("selected state applies border-primary and bg-primary/5 via has-[] selector classes", () => {
    const { container } = render(
      <RadioGroup defaultValue="opt-b">
        <RadioCard value="opt-b" title="Option B" id="card-b" />
      </RadioGroup>
    );

    const label = container.querySelector("label");
    // The has-[] selector classes must be present in the className string so Tailwind
    // can apply them at runtime when the inner radio is checked.
    expect(label?.className).toContain("has-[[data-state=checked]]:border-primary");
    expect(label?.className).toContain("has-[[data-state=checked]]:bg-primary/5");
  });

  it("disabled={true} renders data-disabled attribute and opacity-50 cursor-not-allowed classes", () => {
    const { container } = render(
      <RadioGroup>
        <RadioCard value="opt-c" title="Option C" disabled id="card-c" />
      </RadioGroup>
    );

    const label = container.querySelector("label");
    expect(label?.hasAttribute("data-disabled")).toBe(true);
    expect(label?.className).toContain("opacity-50");
    expect(label?.className).toContain("cursor-not-allowed");
  });

  it("focus-visible ring class is present in label className for keyboard focus", () => {
    const { container } = render(
      <RadioGroup>
        <RadioCard value="opt-d" title="Option D" id="card-d" />
      </RadioGroup>
    );

    const label = container.querySelector("label");
    // focus-within:ring-ring is the focus-visible class applied via focus-within
    expect(label?.className).toContain("focus-within:ring-ring");
  });

  it("useId() generates an id when id prop is omitted", () => {
    const { container } = render(
      <RadioGroup>
        <RadioCard value="opt-e" title="Option E" />
      </RadioGroup>
    );

    const label = container.querySelector("label");
    const radio = container.querySelector("[role='radio']");

    // Both should have a non-empty id / for attribute
    expect(label?.getAttribute("for")).toBeTruthy();
    expect(radio?.getAttribute("id")).toBeTruthy();
    // And they should match each other
    expect(label?.getAttribute("for")).toBe(radio?.getAttribute("id"));
  });
});
