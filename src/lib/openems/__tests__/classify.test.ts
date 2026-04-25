import { describe, it, expect } from "vitest";
import { classifyDeviceType } from "../classify";

describe("classifyDeviceType", () => {
  // Rule 1: GridMeter → 'grid_meter'
  it("returns grid_meter for factoryId containing GridMeter", () => {
    expect(classifyDeviceType("io.openems.impl.device.simulator.SimulatorGridMeter")).toBe("grid_meter");
    expect(classifyDeviceType("io.openems.edge.meter.socomec.acuniversal.MeterSocomecAcuniversalGridMeter")).toBe("grid_meter");
  });

  it("returns grid_meter when nature contains GridMeter", () => {
    expect(classifyDeviceType("io.openems.edge.meter.api.ElectricityMeter", "io.openems.edge.meter.api.GridMeter")).toBe("grid_meter");
  });

  // Rule 2: Pv or ProductionMeter → 'pv_meter'
  it("returns pv_meter for factoryId containing Pv", () => {
    expect(classifyDeviceType("io.openems.edge.meter.socomec.acuniversal.MeterSocomecAcuniversalPv")).toBe("pv_meter");
    expect(classifyDeviceType("io.openems.impl.device.PvInverter")).toBe("pv_meter");
  });

  it("returns pv_meter for factoryId containing ProductionMeter", () => {
    expect(classifyDeviceType("io.openems.edge.meter.api.ProductionMeter")).toBe("pv_meter");
  });

  // Rule 3: ConsumptionMeter → 'consumption_meter'
  it("returns consumption_meter for factoryId containing ConsumptionMeter", () => {
    expect(classifyDeviceType("io.openems.edge.meter.socomec.acuniversal.MeterSocomecAcuniversalConsumptionMeter")).toBe("consumption_meter");
    expect(classifyDeviceType("io.openems.edge.meter.api.ConsumptionMeter")).toBe("consumption_meter");
  });

  // Rule 4: Ess or Battery → 'battery'
  it("returns battery for factoryId containing Ess", () => {
    expect(classifyDeviceType("io.openems.edge.ess.core.power.EssDcCharger")).toBe("battery");
    expect(classifyDeviceType("io.openems.edge.ess.api.Ess")).toBe("battery");
  });

  it("returns battery for factoryId containing Battery", () => {
    expect(classifyDeviceType("io.openems.edge.battery.fenecon.home.BatteryFeneconHome")).toBe("battery");
  });

  it("returns battery when nature is Ess API", () => {
    expect(classifyDeviceType("io.openems.edge.ess.generic.symmetrical.EssGenericSymmetrical", "io.openems.edge.ess.api.Ess")).toBe("battery");
  });

  // Rule 5: Evcs → 'ev_charger'
  it("returns ev_charger for factoryId containing Evcs", () => {
    expect(classifyDeviceType("io.openems.edge.evcs.keba.EvcsKeba")).toBe("ev_charger");
    expect(classifyDeviceType("io.openems.edge.evcs.cluster.SelfConsumption.EvcsCluster")).toBe("ev_charger");
  });

  // Rule 6: Inverter → 'inverter'
  it("returns inverter for factoryId containing Inverter", () => {
    expect(classifyDeviceType("io.openems.edge.inverter.sunspec.SunSpecInverter")).toBe("inverter");
    // Note: PvInverterCluster contains "Pv" so rule 2 (pv_meter) wins over rule 6 (inverter).
    // Use a factory ID without "Pv" to test the inverter rule directly.
    expect(classifyDeviceType("io.openems.edge.inverter.fronius.SymoInverter")).toBe("inverter");
  });

  // Rule 7: else → 'other'
  it("returns other for unrecognized factoryId", () => {
    expect(classifyDeviceType("io.openems.edge.io.wago.IoWagoModbusTcp")).toBe("other");
    expect(classifyDeviceType("io.openems.edge.controller.asymmetric.BalancingStrictly")).toBe("other");
    expect(classifyDeviceType("")).toBe("other");
  });

  // Rule order: earlier rules win — GridMeter before ConsumptionMeter
  it("classifies GridMeter before ConsumptionMeter (rule order test)", () => {
    // A factory ID that could match both GridMeter and ConsumptionMeter rules
    // GridMeter should win because it's rule 1.
    expect(classifyDeviceType("GridMeterConsumptionMeter")).toBe("grid_meter");
  });

  // Rule order: Pv before ConsumptionMeter
  it("classifies Pv before ConsumptionMeter (rule order test)", () => {
    expect(classifyDeviceType("PvConsumptionMeter")).toBe("pv_meter");
  });

  // Rule 7: alias fallback for generic AC meter factories.
  //
  // GENERIC_AC_FACTORY: a real-world OpenEMS factory ID for a generic AC meter
  // that does NOT match any of rules 1-6 (no GridMeter, Pv, ProductionMeter,
  // ConsumptionMeter, Ess, Battery, Evcs, or Inverter substring). Without the
  // alias-fallback rule, a component using this factory would classify as
  // 'other' — even when its alias clearly indicates it's a consumption meter.
  describe("alias fallback (rule 7)", () => {
    const GENERIC_AC_FACTORY =
      "io.openems.edge.meter.socomec.singlephase.MeterSocomecSinglephase";
    const GENERIC_NATURE = "io.openems.edge.meter.api.ElectricityMeter";

    // Positive cases — alias matches → consumption_meter
    it("returns consumption_meter for alias 'Consumption' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Consumption")
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'Consumption Meter' + generic AC factory", () => {
      expect(
        classifyDeviceType(
          GENERIC_AC_FACTORY,
          GENERIC_NATURE,
          "Consumption Meter"
        )
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'Load' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Load")
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'Main Load' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Main Load")
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'main_load' (underscore boundary)", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "main_load")
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'meter-consumption' (hyphen boundary)", () => {
      expect(
        classifyDeviceType(
          GENERIC_AC_FACTORY,
          GENERIC_NATURE,
          "meter-consumption"
        )
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'Household 3' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Household 3")
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'House A' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "House A")
      ).toBe("consumption_meter");
    });

    it("returns consumption_meter for alias 'PV + Consumption Total' (multi-keyword, first-wins)", () => {
      expect(
        classifyDeviceType(
          GENERIC_AC_FACTORY,
          GENERIC_NATURE,
          "PV + Consumption Total"
        )
      ).toBe("consumption_meter");
    });

    // Negative cases — alias does NOT match → other
    it("returns other for alias 'Warehouse' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Warehouse")
      ).toBe("other");
    });

    it("returns other for alias 'Greenhouse' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Greenhouse")
      ).toBe("other");
    });

    it("returns other for alias 'Housekeeping' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Housekeeping")
      ).toBe("other");
    });

    it("returns other for alias 'Loadout' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Loadout")
      ).toBe("other");
    });

    it("returns other for alias 'Unconsummated' + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "Unconsummated")
      ).toBe("other");
    });

    it("returns other for empty-string alias + generic AC factory", () => {
      expect(classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "")).toBe(
        "other"
      );
    });

    it("returns other for whitespace-only alias + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, "   ")
      ).toBe("other");
    });

    it("returns other for undefined alias + generic AC factory", () => {
      expect(
        classifyDeviceType(GENERIC_AC_FACTORY, GENERIC_NATURE, undefined)
      ).toBe("other");
    });

    // Factory-wins cases — specific factory/nature beats alias
    it("returns grid_meter when alias 'Consumption' is paired with GridMeter factory", () => {
      expect(
        classifyDeviceType(
          "io.openems.edge.meter.socomec.acuniversal.MeterSocomecAcuniversalGridMeter",
          GENERIC_NATURE,
          "Consumption"
        )
      ).toBe("grid_meter");
    });

    it("returns pv_meter when alias 'Consumption' is paired with Pv factory", () => {
      expect(
        classifyDeviceType(
          "io.openems.edge.meter.socomec.acuniversal.MeterSocomecAcuniversalPv",
          GENERIC_NATURE,
          "Consumption"
        )
      ).toBe("pv_meter");
    });

    it("returns battery when alias 'Consumption' is paired with Battery factory", () => {
      expect(
        classifyDeviceType(
          "io.openems.edge.battery.fenecon.home.BatteryFeneconHome",
          undefined,
          "Consumption"
        )
      ).toBe("battery");
    });
  });
});
