import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LocaleProvider } from "../locale-context";
import { Currency } from "../currency";
import { Kwh } from "../kwh";
import { LocalDate } from "../local-date";

function Wrapper({ children }: { children: React.ReactNode }) {
  // Use locale="en" so that UGX currency renders the ISO code "UGX" (not "USh").
  // en-UG uses the Uganda Shilling symbol "USh" which would break the "contains UGX" assertion.
  return <LocaleProvider locale="en">{children}</LocaleProvider>;
}

describe("Currency", () => {
  it("renders currency code and formatted number (UGX)", () => {
    const { container } = render(
      <Wrapper>
        <Currency value={4216800} currency="UGX" />
      </Wrapper>
    );
    const text = container.textContent ?? "";
    expect(text.includes("UGX")).toBe(true);
    expect(text.includes("4,216,800")).toBe(true);
  });

  it("bareNumber: renders number without currency symbol", () => {
    const { container } = render(
      <Wrapper>
        <Currency value={4216800} currency="UGX" bareNumber />
      </Wrapper>
    );
    const text = container.textContent ?? "";
    expect(text.includes("4,216,800")).toBe(true);
    expect(text.includes("UGX")).toBe(false);
  });
});

describe("Kwh", () => {
  it("renders value and kWh suffix", () => {
    const { container } = render(
      <Wrapper>
        <Kwh value={47.3} />
      </Wrapper>
    );
    const text = container.textContent ?? "";
    expect(text.includes("47.3")).toBe(true);
    expect(text.includes("kWh")).toBe(true);
  });
});

describe("LocalDate", () => {
  it("renders month abbreviation and year", () => {
    const { container } = render(
      <Wrapper>
        <LocalDate value="2026-03-15" />
      </Wrapper>
    );
    const text = container.textContent ?? "";
    expect(text.includes("Mar")).toBe(true);
    expect(text.includes("2026")).toBe(true);
  });
});
