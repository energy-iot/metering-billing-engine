import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Timezone, formatTimezone } from "../timezone";

// Fixed reference dates — formatTimezone's offset is date-dependent for DST
// zones, so every assertion pins the instant instead of reading the clock.
const SUMMER = new Date("2026-07-15T12:00:00Z");
const WINTER = new Date("2026-01-15T12:00:00Z");

describe("formatTimezone", () => {
  it("no-DST zone: Africa/Kampala is UTC+3 year-round", () => {
    expect(formatTimezone("Africa/Kampala", SUMMER)).toBe("Africa/Kampala (UTC+3)");
    expect(formatTimezone("Africa/Kampala", WINTER)).toBe("Africa/Kampala (UTC+3)");
  });

  it("literal UTC renders bare — the id already IS the offset", () => {
    expect(formatTimezone("UTC", SUMMER)).toBe("UTC");
  });

  it("zero-offset non-UTC zone keeps the parenthetical: Atlantic/Reykjavik", () => {
    expect(formatTimezone("Atlantic/Reykjavik", SUMMER)).toBe("Atlantic/Reykjavik (UTC+0)");
    expect(formatTimezone("Atlantic/Reykjavik", WINTER)).toBe("Atlantic/Reykjavik (UTC+0)");
  });

  it("DST zone: Europe/Berlin offset follows the reference date", () => {
    expect(formatTimezone("Europe/Berlin", SUMMER)).toBe("Europe/Berlin (UTC+2)");
    expect(formatTimezone("Europe/Berlin", WINTER)).toBe("Europe/Berlin (UTC+1)");
  });

  it("negative offset zone: America/New_York", () => {
    expect(formatTimezone("America/New_York", WINTER)).toBe("America/New_York (UTC-5)");
    expect(formatTimezone("America/New_York", SUMMER)).toBe("America/New_York (UTC-4)");
  });

  it("fractional offset zone: Asia/Kolkata keeps its minutes", () => {
    expect(formatTimezone("Asia/Kolkata", SUMMER)).toBe("Asia/Kolkata (UTC+5:30)");
  });

  it("output always contains the IANA id (never offset-only / abbrev-only)", () => {
    const out = formatTimezone("America/Chicago", WINTER);
    expect(out.startsWith("America/Chicago ")).toBe(true);
    expect(out.includes("CST")).toBe(false);
  });

  it("returns em-dash for null / undefined / empty", () => {
    expect(formatTimezone(null, SUMMER)).toBe("—");
    expect(formatTimezone(undefined, SUMMER)).toBe("—");
    expect(formatTimezone("", SUMMER)).toBe("—");
  });

  it("returns em-dash for an unrecognized IANA id (corrupt stored value must not throw)", () => {
    expect(formatTimezone("Not/A_Zone", SUMMER)).toBe("—");
    expect(formatTimezone("Kampala", SUMMER)).toBe("—");
  });

  it("returns em-dash for an Invalid Date reference", () => {
    expect(formatTimezone("Africa/Kampala", new Date("garbage"))).toBe("—");
  });
});

describe("Timezone", () => {
  it("renders the helper output", () => {
    const { container } = render(<Timezone iana="Africa/Kampala" referenceDate={SUMMER} />);
    expect(container.textContent).toBe("Africa/Kampala (UTC+3)");
  });

  it("composes className and forwards span props", () => {
    const { container } = render(
      <Timezone
        iana="Europe/Berlin"
        referenceDate={WINTER}
        className="text-muted-foreground"
        data-testid="tz"
      />,
    );
    const span = container.querySelector('[data-testid="tz"]');
    expect(span?.textContent).toBe("Europe/Berlin (UTC+1)");
    expect(span?.className).toContain("text-muted-foreground");
  });
});
