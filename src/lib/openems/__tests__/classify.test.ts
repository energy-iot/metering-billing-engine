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
});
