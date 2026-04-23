// @vitest-environment jsdom
/**
 * AddressFields tests (#76) — the six structured address inputs rendered
 * by both Organization/Community/Microgrid forms.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddressFields } from "../AddressFields";

describe("AddressFields", () => {
  it("renders all six address inputs with current values", () => {
    render(
      <AddressFields
        values={{
          address_line1: "1 Main St",
          address_line2: "Apt 2",
          address_city: "Kampala",
          address_region: "Central",
          address_country: "Uganda",
          address_postal_code: "00100",
        }}
        onChange={() => {}}
      />
    );

    expect(
      (screen.getByLabelText(/Address line 1/i) as HTMLInputElement).value
    ).toBe("1 Main St");
    expect(
      (screen.getByLabelText(/Apt 2|Address line 2/i) as HTMLInputElement).value
    ).toBe("Apt 2");
    expect(
      (screen.getByLabelText(/^City/i) as HTMLInputElement).value
    ).toBe("Kampala");
    expect(
      (screen.getByLabelText(/Region/i) as HTMLInputElement).value
    ).toBe("Central");
    expect(
      (screen.getByLabelText(/^Country/i) as HTMLInputElement).value
    ).toBe("Uganda");
    expect(
      (screen.getByLabelText(/Postal/i) as HTMLInputElement).value
    ).toBe("00100");
  });

  it("marks city and country required when requiredFields includes them", () => {
    render(
      <AddressFields
        values={{}}
        onChange={() => {}}
        requiredFields={["address_city", "address_country"]}
      />
    );

    // Required-asterisk sr-only span: find the two fields with required hints.
    const requiredLabels = screen.getAllByText(/\(required\)/);
    expect(requiredLabels.length).toBe(2);
  });

  it("does not mark any field required by default", () => {
    render(<AddressFields values={{}} onChange={() => {}} />);
    const requiredLabels = screen.queryAllByText(/\(required\)/);
    expect(requiredLabels.length).toBe(0);
  });

  it("fires onChange with the changed field name and new value", () => {
    const onChange = vi.fn();
    render(<AddressFields values={{ address_city: "" }} onChange={onChange} />);

    const cityInput = screen.getByLabelText(/^City/i);
    fireEvent.change(cityInput, { target: { value: "Kampala" } });

    expect(onChange).toHaveBeenCalledWith("address_city", "Kampala");
  });

  it("shows inline error messages from fieldErrors keyed by field name", () => {
    render(
      <AddressFields
        values={{}}
        onChange={() => {}}
        fieldErrors={{ address_country: "Country is required." }}
      />
    );

    expect(screen.getByRole("alert").textContent).toMatch(
      /Country is required/i
    );
  });
});
