import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RadioGroup, RadioGroupItem } from "../radio-group";

describe("RadioGroup", () => {
  it("onValueChange fires with the selected value on item click", () => {
    const onValueChange = vi.fn();
    render(
      <RadioGroup onValueChange={onValueChange}>
        <RadioGroupItem value="alpha" id="item-alpha" />
        <RadioGroupItem value="beta" id="item-beta" />
      </RadioGroup>
    );

    const [alphaItem] = screen.getAllByRole("radio");
    fireEvent.click(alphaItem);

    // Radix RadioGroup fires onValueChange with the value of the clicked item
    expect(onValueChange).toHaveBeenCalledWith("alpha");
  });

  it("container has DOM role radiogroup", () => {
    const { container } = render(
      <RadioGroup>
        <RadioGroupItem value="x" id="item-x" />
      </RadioGroup>
    );
    // Radix Root renders with role="radiogroup"
    const radioGroup = container.querySelector("[role='radiogroup']");
    expect(radioGroup).not.toBeNull();
  });

  it("each item has DOM role radio", () => {
    render(
      <RadioGroup>
        <RadioGroupItem value="one" id="item-one" />
        <RadioGroupItem value="two" id="item-two" />
      </RadioGroup>
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
  });
});
