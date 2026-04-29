// @vitest-environment jsdom
/**
 * ColorInput — integration tests (#204 / PDF2 AC-7).
 *
 * Verifies:
 *   - Hex sanitisation: uppercase input → lowercase storage; whitespace
 *     stripped; bad hex on blur reverts to last valid value.
 *   - Bidirectional binding: typing valid hex updates parent; clicking the
 *     swatch updates the text input.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ColorInput } from "../color-input";

describe("ColorInput", () => {
  it("uppercase input is normalised to lowercase on blur", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ColorInput
        id="primary"
        label="Primary"
        value="#163a5f"
        onChange={onChange}
        defaultValue="#163a5f"
      />,
    );
    const text = container.querySelector("#primary") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "#ABCDEF" } });
    fireEvent.blur(text);
    expect(onChange).toHaveBeenLastCalledWith("#abcdef");
  });

  it("whitespace is stripped on blur", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ColorInput
        id="primary"
        label="Primary"
        value="#163a5f"
        onChange={onChange}
        defaultValue="#163a5f"
      />,
    );
    const text = container.querySelector("#primary") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "  #abcdef  " } });
    fireEvent.blur(text);
    expect(onChange).toHaveBeenLastCalledWith("#abcdef");
  });

  it("bad hex on blur reverts to the last valid value (does NOT push up)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ColorInput
        id="primary"
        label="Primary"
        value="#163a5f"
        onChange={onChange}
        defaultValue="#163a5f"
      />,
    );
    const text = container.querySelector("#primary") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "garbage" } });
    fireEvent.blur(text);
    // onChange should NOT have been called with the garbage value.
    const calls = onChange.mock.calls.map((c) => c[0]);
    expect(calls.every((v) => v !== "garbage")).toBe(true);
    // Text input reverts to the previously-valid value.
    expect(text.value).toBe("#163a5f");
  });

  it("swatch change updates the parent (lowercase hex)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ColorInput
        id="primary"
        label="Primary"
        value="#163a5f"
        onChange={onChange}
        defaultValue="#163a5f"
      />,
    );
    const swatch = container.querySelector(
      "#primary-swatch",
    ) as HTMLInputElement;
    fireEvent.change(swatch, { target: { value: "#FF00AA" } });
    expect(onChange).toHaveBeenLastCalledWith("#ff00aa");
  });

  it("invalid persisted value falls back to defaultValue for the swatch", () => {
    const { container } = render(
      <ColorInput
        id="primary"
        label="Primary"
        value="garbage"
        onChange={vi.fn()}
        defaultValue="#163a5f"
      />,
    );
    const swatch = container.querySelector(
      "#primary-swatch",
    ) as HTMLInputElement;
    expect(swatch.value).toBe("#163a5f");
  });
});
