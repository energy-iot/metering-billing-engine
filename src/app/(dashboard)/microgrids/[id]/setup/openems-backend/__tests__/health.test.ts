import { describe, it, expect } from "vitest";
import { deriveOpenemsBackendHealth } from "../health";

const NOW = new Date("2026-04-23T12:00:00Z");

describe("deriveOpenemsBackendHealth()", () => {
  it("returns not_configured for null row", () => {
    expect(deriveOpenemsBackendHealth(null, NOW)).toBe("not_configured");
  });

  it("returns not_configured when ems_type is null", () => {
    expect(
      deriveOpenemsBackendHealth(
        {
          ems_type: null,
          ems_last_discover_at: null,
          ems_last_discover_status: null,
        },
        NOW
      )
    ).toBe("not_configured");
  });

  it("returns healthy for success < 24h ago", () => {
    expect(
      deriveOpenemsBackendHealth(
        {
          ems_type: "cloud_aws",
          ems_last_discover_at: new Date(
            NOW.getTime() - 2 * 3600 * 1000
          ).toISOString(),
          ems_last_discover_status: "success",
        },
        NOW
      )
    ).toBe("healthy");
  });

  it("returns healthy for success >= 24h ago (24h cliff removed)", () => {
    expect(
      deriveOpenemsBackendHealth(
        {
          ems_type: "cloud_aws",
          ems_last_discover_at: new Date(
            NOW.getTime() - 48 * 3600 * 1000
          ).toISOString(),
          ems_last_discover_status: "success",
        },
        NOW
      )
    ).toBe("healthy");
  });

  it("returns failing for auth_failed/unreachable/zero_edges/unknown_error", () => {
    for (const s of [
      "auth_failed",
      "unreachable",
      "zero_edges",
      "unknown_error",
    ]) {
      expect(
        deriveOpenemsBackendHealth(
          {
            ems_type: "cloud_aws",
            ems_last_discover_at: new Date().toISOString(),
            ems_last_discover_status: s,
          },
          NOW
        )
      ).toBe("failing");
    }
  });

  it("returns healthy as a fail-open catch-all for configured-but-unknown status", () => {
    expect(
      deriveOpenemsBackendHealth(
        {
          ems_type: "cloud_aws",
          ems_last_discover_at: null,
          ems_last_discover_status: null,
        },
        NOW
      )
    ).toBe("healthy");
  });
});
