import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LocaleProvider } from "../locale-context";
import { Currency } from "../currency";
import { formatCurrency, formatRate } from "../currency";
import { Kwh } from "../kwh";
import { formatKwh } from "../kwh";
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

describe("formatKwh", () => {
  it("returns em-dash for null", () => {
    expect(formatKwh(null, "en")).toBe("—");
  });

  it("default digits=1 renders one decimal place", () => {
    expect(formatKwh(47.3, "en")).toBe("47.3");
  });

  it("digits: 0 renders integer", () => {
    expect(formatKwh(47.321, "en", { digits: 0 })).toBe("47");
  });

  it("digits: 3 renders three decimal places", () => {
    expect(formatKwh(47.321, "en", { digits: 3 })).toBe("47.321");
  });

  it("bareNumber does not change number formatting", () => {
    expect(formatKwh(47.3, "en", { bareNumber: true })).toBe("47.3");
    expect(formatKwh(47.3, "en", { bareNumber: false })).toBe("47.3");
  });
});

describe("formatCurrency", () => {
  it("returns em-dash for null", () => {
    expect(formatCurrency(null, "en", "UGX")).toBe("—");
  });

  it("bareNumber: true renders decimal with 0 fraction digits and no UGX", () => {
    const result = formatCurrency(4216800, "en", "UGX", { bareNumber: true });
    expect(result.includes("4,216,800")).toBe(true);
    expect(result.includes("UGX")).toBe(false);
  });

  it("bareNumber: false with locale en renders ISO code and number (NBSP-tolerant)", () => {
    const result = formatCurrency(4216800, "en", "UGX", { bareNumber: false });
    expect(result.includes("UGX")).toBe(true);
    expect(result.includes("4,216,800")).toBe(true);
  });

  it("maxFractionDigits: 2 with bareNumber: false renders two decimal places", () => {
    const result = formatCurrency(4216800, "en", "UGX", { bareNumber: false, maxFractionDigits: 2, minFractionDigits: 2 });
    expect(result.includes("UGX")).toBe(true);
    expect(result.includes("4,216,800.00")).toBe(true);
  });
});

describe("formatRate", () => {
  it("returns em-dash for null", () => {
    expect(formatRate(null, "en")).toBe("—");
  });

  it("integer rate pads to minDigits=2", () => {
    expect(formatRate(250, "en")).toBe("250.00");
  });

  it("one-decimal rate pads to minDigits=2", () => {
    expect(formatRate(756.2, "en")).toBe("756.20");
  });

  it("three-decimal rate is preserved up to maxDigits=4", () => {
    expect(formatRate(100.555, "en")).toBe("100.555");
  });

  it("five-decimal rate rounds half-away to maxDigits=4", () => {
    expect(formatRate(100.55555, "en")).toBe("100.5556");
  });

  it("zero renders as 0.00", () => {
    expect(formatRate(0, "en")).toBe("0.00");
  });

  it("negative rate renders with leading minus and padding", () => {
    expect(formatRate(-250, "en")).toBe("-250.00");
  });

  it("custom minDigits/maxDigits override defaults (digits:3)", () => {
    expect(formatRate(123.456, "en", { minDigits: 3, maxDigits: 3 })).toBe("123.456");
  });

  it("custom digits=3 pads whole number to three zeros", () => {
    expect(formatRate(15, "en", { minDigits: 3, maxDigits: 3 })).toBe("15.000");
  });

  it("minDigits/maxDigits=0 rounds to integer", () => {
    expect(formatRate(7.5, "en", { minDigits: 0, maxDigits: 0 })).toBe("8");
  });
});
