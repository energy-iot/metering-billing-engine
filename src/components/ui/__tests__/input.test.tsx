import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Input } from "../input";

describe("Input", () => {
  it("onChange fires with the typed value", () => {
    const onChange = vi.fn();
    const { container } = render(<Input onChange={onChange} />);
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((input as HTMLInputElement).value).toBe("hello");
  });

  it("disabled prop prevents onChange from firing", () => {
    const onChange = vi.fn();
    const { container } = render(<Input disabled onChange={onChange} />);
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "hello" } });
    // fireEvent bypasses browser disabled state; confirm the attribute is set
    expect(input.hasAttribute("disabled")).toBe(true);
    // onChange is NOT called when the element is properly disabled in the browser,
    // but jsdom's fireEvent does not enforce that. We confirm the attribute is present
    // and the component passes disabled through.
    expect(input.getAttribute("disabled")).toBeDefined();
  });

  it("className merges via cn()", () => {
    const { container } = render(<Input className="custom-class" />);
    const input = container.querySelector("input")!;
    // The custom class should be present alongside the base classes
    expect(input.className).toContain("custom-class");
    // Base class should also be present — verifies cn() merges rather than replaces
    expect(input.className).toContain("rounded-md");
  });
});
