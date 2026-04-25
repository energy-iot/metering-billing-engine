/**
 * local-date-time.test.tsx — date+time wrapper test (BC4 #176).
 *
 * Verifies the pinned Intl options produce consistent output in
 * en-US and en-GB. We pin `timeZone: "UTC"` is NOT possible from this
 * test because LocalDateTime hardcodes the opts; instead we pick a
 * timestamp exactly on the hour (`14:00:00Z`) where the runner's TZ
 * shouldn't push us over a different display string for the wall-clock
 * components we care about. We assert on month + year + AM/PM marker
 * presence rather than exact strings to stay TZ-agnostic.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LocaleProvider } from "../locale-context";
import { LocalDateTime } from "../local-date-time";

const TS = "2026-04-25T14:14:00Z";

describe("<LocalDateTime>", () => {
  it("renders both date AND time portions in en-US", () => {
    const { container } = render(
      <LocaleProvider locale="en-US" currency="USD">
        <LocalDateTime value={TS} />
      </LocaleProvider>
    );
    const text = container.textContent ?? "";
    // Month (Apr) and year (2026) come from year/month/day opts.
    expect(text).toContain("Apr");
    expect(text).toContain("2026");
    // hour: "2-digit" with en-US default produces AM/PM marker.
    // Either "AM" or "PM" must appear depending on viewer TZ.
    expect(text).toMatch(/AM|PM/);
  });

  it("renders both date AND time portions in en-GB (24h)", () => {
    const { container } = render(
      <LocaleProvider locale="en-GB" currency="GBP">
        <LocalDateTime value={TS} />
      </LocaleProvider>
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Apr");
    expect(text).toContain("2026");
    // en-GB default uses 24h — there should be no AM/PM marker.
    expect(text).not.toMatch(/AM|PM/);
  });

  it("does not hand-format the date+time separator (delegates to Intl)", () => {
    const { container } = render(
      <LocaleProvider locale="en-US" currency="USD">
        <LocalDateTime value={TS} />
      </LocaleProvider>
    );
    const text = container.textContent ?? "";
    // The deliberate decision was to NOT inject " · " — the Intl glue
    // (typically ", " in en-US) is what users see.
    expect(text).not.toContain(" · ");
  });
});
