import { describe, it, expect, vi, afterEach } from "vitest";
import { channelAddressFor } from "../channel-address";

describe("channelAddressFor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // consumption_meter → ActiveConsumptionEnergy
  it("returns ActiveConsumptionEnergy for consumption_meter", () => {
    expect(channelAddressFor("meter0", "consumption_meter")).toBe(
      "meter0/ActiveConsumptionEnergy"
    );
  });

  // ev_charger → ActiveConsumptionEnergy (EVCS inherits ElectricityMeter shape)
  it("returns ActiveConsumptionEnergy for ev_charger", () => {
    expect(channelAddressFor("evcs0", "ev_charger")).toBe(
      "evcs0/ActiveConsumptionEnergy"
    );
  });

  // grid_meter → null
  it("returns null for grid_meter", () => {
    expect(channelAddressFor("meter0", "grid_meter")).toBeNull();
  });

  // pv_meter → null
  it("returns null for pv_meter", () => {
    expect(channelAddressFor("pvMeter0", "pv_meter")).toBeNull();
  });

  // battery → null
  it("returns null for battery", () => {
    expect(channelAddressFor("ess0", "battery")).toBeNull();
  });

  // inverter → null
  it("returns null for inverter", () => {
    expect(channelAddressFor("inverter0", "inverter")).toBeNull();
  });

  // other → null + console.warn
  it("returns null for other and emits console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = channelAddressFor("unknown0", "other");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("other")
    );
  });
});
