/**
 * shortlist.test.ts — address-derived timezone shortlist + nudge predicate
 * (#357).
 */

import { describe, it, expect } from "vitest";
import { timezoneShortlist, impliedNonUtcZone } from "../shortlist";
import { isSupportedTimezone } from "@/lib/validation/timezone";

describe("timezoneShortlist (#357)", () => {
  it("always starts with UTC", () => {
    expect(timezoneShortlist({})[0]).toBe("UTC");
    expect(timezoneShortlist({ address_country: "Uganda" })[0]).toBe("UTC");
  });

  it("derives from address_country (case/whitespace-insensitive)", () => {
    expect(timezoneShortlist({ address_country: "Uganda" })).toContain(
      "Africa/Kampala",
    );
    expect(timezoneShortlist({ address_country: "  uganda " })).toContain(
      "Africa/Kampala",
    );
    expect(timezoneShortlist({ address_country: "Kenya" })).toContain(
      "Africa/Nairobi",
    );
  });

  it("lists multiple zones for multi-zone countries", () => {
    const us = timezoneShortlist({ address_country: "United States" });
    expect(us).toContain("America/New_York");
    expect(us).toContain("America/Los_Angeles");
  });

  it("falls back to a lng-derived offset match for unmapped countries", () => {
    // 45°E → UTC+3. Coarse heuristic — meridian offset, not political zone.
    const list = timezoneShortlist({ address_country: "Atlantis", lng: 45 });
    expect(list[0]).toBe("UTC");
    expect(list.length).toBeGreaterThan(1);
    // Every derived zone currently sits at UTC+3 (e.g. Africa/Nairobi).
    expect(list).toContain("Africa/Nairobi");
  });

  it("returns just ['UTC'] with no signals at all", () => {
    expect(timezoneShortlist({})).toEqual(["UTC"]);
    expect(timezoneShortlist({ address_country: "Atlantis" })).toEqual([
      "UTC",
    ]);
  });

  it("only ever emits zones that pass server-side validation", () => {
    for (const country of ["Uganda", "United States", "Spain", "DRC"]) {
      for (const z of timezoneShortlist({ address_country: country })) {
        expect(isSupportedTimezone(z)).toBe(true);
      }
    }
  });
});

describe("impliedNonUtcZone (#357 nudge predicate)", () => {
  it("returns the implied zone when address is non-UTC and tz is still UTC", () => {
    expect(
      impliedNonUtcZone({ address_country: "Uganda", timezone: "UTC" }),
    ).toBe("Africa/Kampala");
  });

  it("treats a missing timezone as the UTC default", () => {
    expect(impliedNonUtcZone({ address_country: "Kenya" })).toBe(
      "Africa/Nairobi",
    );
  });

  it("returns null when the timezone is already set to a non-UTC zone", () => {
    expect(
      impliedNonUtcZone({
        address_country: "Uganda",
        timezone: "Africa/Kampala",
      }),
    ).toBeNull();
  });

  it("returns null when the address gives no non-UTC signal", () => {
    expect(impliedNonUtcZone({ timezone: "UTC" })).toBeNull();
    expect(
      impliedNonUtcZone({ address_country: "Atlantis", timezone: "UTC" }),
    ).toBeNull();
  });
});
