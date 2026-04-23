import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo } from "../time-ago";

// Stable anchor date for deterministic output.
const NOW = new Date("2026-04-23T12:00:00.000Z").getTime();

describe("timeAgo()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stubNow() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  }

  it("returns 'just now' under 60 seconds", () => {
    stubNow();
    expect(timeAgo(new Date(NOW - 10 * 1000))).toBe("just now");
    expect(timeAgo(new Date(NOW - 59 * 1000))).toBe("just now");
  });

  it("formats minutes for 60s–1h (narrow style, past)", () => {
    stubNow();
    // 2 minutes ago → narrow format "2m ago" in en
    const out = timeAgo(new Date(NOW - 2 * 60 * 1000));
    expect(out).toMatch(/2\s?m/);
    expect(out.toLowerCase()).toContain("ago");
  });

  it("formats hours for 1h–24h", () => {
    stubNow();
    const out = timeAgo(new Date(NOW - 3 * 3600 * 1000));
    expect(out).toMatch(/3\s?h/);
    expect(out.toLowerCase()).toContain("ago");
  });

  it("formats days for 1d–30d", () => {
    stubNow();
    const out = timeAgo(new Date(NOW - 5 * 86400 * 1000));
    expect(out).toMatch(/5\s?d/);
    expect(out.toLowerCase()).toContain("ago");
  });

  it("formats months for 30d–365d", () => {
    stubNow();
    // ~2 months
    const out = timeAgo(new Date(NOW - 60 * 86400 * 1000));
    expect(out.toLowerCase()).toContain("mo");
  });

  it("formats years past 365d", () => {
    stubNow();
    const out = timeAgo(new Date(NOW - 2 * 365 * 86400 * 1000));
    // narrow en: "2y ago"
    expect(out.toLowerCase()).toMatch(/\d\s?y/);
    expect(out.toLowerCase()).toContain("ago");
  });

  it("accepts ISO string input", () => {
    stubNow();
    const out = timeAgo("2026-04-23T11:58:00.000Z"); // 2m ago
    expect(out).toMatch(/2\s?m/);
    expect(out.toLowerCase()).toContain("ago");
  });

  it("handles future dates", () => {
    stubNow();
    const out = timeAgo(new Date(NOW + 3 * 3600 * 1000));
    // Intl.RelativeTimeFormat with numeric:"auto" will produce an "in"-style
    // string for future units, e.g. "in 3 hr". We just assert it's not "ago".
    expect(out.toLowerCase()).not.toContain("ago");
  });
});
