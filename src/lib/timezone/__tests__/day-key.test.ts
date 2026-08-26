// day-key.test.ts — tz-aware calendar-day keys (#359, anchor #353).

import { describe, it, expect } from "vitest";
import { dayKeyInZone, addDaysToDateKey } from "../day-key";

describe("dayKeyInZone", () => {
  it("names the UTC day for the literal 'UTC' zone", () => {
    expect(dayKeyInZone(new Date("2026-03-09T21:00:00Z"), "UTC")).toBe(
      "2026-03-09",
    );
  });

  it("names the NEXT day east of UTC when the instant is past local midnight", () => {
    // 21:00Z is 00:00 in Kampala (UTC+3) — already 2026-03-10 there.
    expect(
      dayKeyInZone(new Date("2026-03-09T21:00:00Z"), "Africa/Kampala"),
    ).toBe("2026-03-10");
  });

  it("names the PREVIOUS day west of UTC before local midnight", () => {
    // 03:00Z on the 10th is 22:00/23:00 on the 9th in New York.
    expect(
      dayKeyInZone(new Date("2026-03-10T03:00:00Z"), "America/New_York"),
    ).toBe("2026-03-09");
  });

  it("accepts an epoch-ms number", () => {
    expect(dayKeyInZone(Date.UTC(2026, 2, 9, 21, 0, 0), "Africa/Kampala")).toBe(
      "2026-03-10",
    );
  });

  it("resolves DST from the IANA name (no fixed-offset math)", () => {
    // Europe/Berlin: UTC+1 in January, UTC+2 in July.
    expect(dayKeyInZone(new Date("2026-01-15T23:30:00Z"), "Europe/Berlin")).toBe(
      "2026-01-16",
    );
    expect(dayKeyInZone(new Date("2026-07-15T21:30:00Z"), "Europe/Berlin")).toBe(
      "2026-07-15",
    );
  });

  it("throws on an unknown zone id (callers own validation)", () => {
    expect(() => dayKeyInZone(new Date(), "Mars/OlympusMons")).toThrow(
      RangeError,
    );
  });
});

describe("addDaysToDateKey", () => {
  it("adds days across a month boundary", () => {
    expect(addDaysToDateKey("2026-03-30", 3)).toBe("2026-04-02");
  });

  it("subtracts days across a year boundary", () => {
    expect(addDaysToDateKey("2026-01-02", -3)).toBe("2025-12-30");
  });

  it("handles leap-year February", () => {
    expect(addDaysToDateKey("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("is pure calendar arithmetic — a 30-day axis is contiguous", () => {
    const dates: string[] = [];
    for (let i = 0; i < 30; i++) dates.push(addDaysToDateKey("2026-02-15", i));
    expect(dates[0]).toBe("2026-02-15");
    expect(dates[29]).toBe("2026-03-16");
    expect(new Set(dates).size).toBe(30);
  });
});
