import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenEmsClient } from "../client";
import { OpenEmsError } from "../errors";
import type { MeterConfig } from "@/lib/adapters/types";

// Helper to create a mock Response
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    redirected: false,
    statusText: "OK",
    type: "basic" as ResponseType,
    url: "",
    clone: () => mockResponse(body, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(JSON.stringify(body)),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

describe("OpenEmsClient", () => {
  let client: OpenEmsClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new OpenEmsClient("http://localhost:8075", "admin", "testpass");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getEdgesStatus", () => {
    it("builds correct JSON-RPC envelope and parses response", async () => {
      const rpcResponse = {
        jsonrpc: "2.0",
        id: "test-id",
        result: {
          edge0: { online: true },
          edge1: { online: false },
        },
      };

      fetchSpy.mockResolvedValue(mockResponse(rpcResponse));

      const result = await client.getEdgesStatus(["edge0", "edge1"]);

      // Verify fetch was called correctly
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:8075/jsonrpc");
      expect(options?.method).toBe("POST");
      expect(options?.headers).toEqual(
        expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from("admin:testpass").toString("base64")}`,
        })
      );

      // Verify the JSON-RPC body
      const body = JSON.parse(options?.body as string);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBeDefined();
      expect(body.method).toBe("getEdgesStatus");
      expect(body.params).toEqual({ edgeIds: ["edge0", "edge1"] });

      // Verify parsed result
      expect(result).toEqual([
        { edgeId: "edge0", online: true },
        { edgeId: "edge1", online: false },
      ]);
    });
  });

  describe("queryHistoricEnergy", () => {
    it("builds correct nested edgeRpc envelope with timezone and YYYY-MM-DD dates", async () => {
      const rpcResponse = {
        jsonrpc: "2.0",
        id: "outer-id",
        result: {
          payload: {
            jsonrpc: "2.0",
            id: "inner-id",
            result: {
              data: {
                "meter0/ActiveConsumptionEnergy": 15000,
                "_sum/ConsumptionActiveEnergy": 25000,
              },
            },
          },
        },
      };

      fetchSpy.mockResolvedValue(mockResponse(rpcResponse));

      const result = await client.queryHistoricEnergy(
        "edge0",
        ["meter0/ActiveConsumptionEnergy", "_sum/ConsumptionActiveEnergy"],
        "2026-03-01",
        "2026-03-10"
      );

      // Verify the nested envelope structure
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.method).toBe("edgeRpc");
      expect(body.params.edgeId).toBe("edge0");

      // Inner payload must have its own jsonrpc and id
      const payload = body.params.payload;
      expect(payload.jsonrpc).toBe("2.0");
      expect(payload.id).toBeDefined();
      expect(payload.method).toBe("queryHistoricTimeseriesEnergy");
      expect(payload.params.fromDate).toBe("2026-03-01");
      expect(payload.params.toDate).toBe("2026-03-10");
      expect(payload.params.timezone).toBe("UTC");
      expect(payload.params.channels).toEqual([
        "meter0/ActiveConsumptionEnergy",
        "_sum/ConsumptionActiveEnergy",
      ]);

      // Verify result values (in Wh, raw from API)
      expect(result).toEqual({
        "meter0/ActiveConsumptionEnergy": 15000,
        "_sum/ConsumptionActiveEnergy": 25000,
      });
    });

    it("passes custom timezone when provided", async () => {
      const rpcResponse = {
        jsonrpc: "2.0",
        id: "id",
        result: {
          payload: {
            jsonrpc: "2.0",
            id: "id",
            result: { data: {} },
          },
        },
      };

      fetchSpy.mockResolvedValue(mockResponse(rpcResponse));

      await client.queryHistoricEnergy(
        "edge0",
        ["meter0/ActiveConsumptionEnergy"],
        "2026-03-01",
        "2026-03-10",
        "America/New_York"
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.params.payload.params.timezone).toBe("America/New_York");
    });

    it("handles null values (channel doesn't exist on edge)", async () => {
      const rpcResponse = {
        jsonrpc: "2.0",
        id: "id",
        result: {
          payload: {
            jsonrpc: "2.0",
            id: "id",
            result: {
              data: {
                "meter0/ActiveConsumptionEnergy": null,
                "_sum/ConsumptionActiveEnergy": 5000,
              },
            },
          },
        },
      };

      fetchSpy.mockResolvedValue(mockResponse(rpcResponse));

      const result = await client.queryHistoricEnergy(
        "edge0",
        ["meter0/ActiveConsumptionEnergy", "_sum/ConsumptionActiveEnergy"],
        "2026-03-01",
        "2026-03-10"
      );

      expect(result["meter0/ActiveConsumptionEnergy"]).toBeNull();
      expect(result["_sum/ConsumptionActiveEnergy"]).toBe(5000);
    });
  });

  describe("getReadings (MeterDataAdapter interface)", () => {
    it("groups meters by edgeId and makes batched calls", async () => {
      // Two meters on edge0, one on edge1
      const meters: MeterConfig[] = [
        {
          id: "meter-uuid-1",
          dataSourceType: "openems",
          dataSourceConfig: { edgeId: "edge0", channelAddress: "meter0/ActiveConsumptionEnergy" },
        },
        {
          id: "meter-uuid-2",
          dataSourceType: "openems",
          dataSourceConfig: { edgeId: "edge0", channelAddress: "meter1/ActiveConsumptionEnergy" },
        },
        {
          id: "meter-uuid-3",
          dataSourceType: "openems",
          dataSourceConfig: { edgeId: "edge1", channelAddress: "meter0/ActiveConsumptionEnergy" },
        },
      ];

      // Mock responses for two edge queries
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({
            jsonrpc: "2.0",
            id: "id1",
            result: {
              payload: {
                jsonrpc: "2.0",
                id: "id1",
                result: {
                  data: {
                    "meter0/ActiveConsumptionEnergy": 10000, // 10 kWh
                    "meter1/ActiveConsumptionEnergy": 20000, // 20 kWh
                  },
                },
              },
            },
          })
        )
        .mockResolvedValueOnce(
          mockResponse({
            jsonrpc: "2.0",
            id: "id2",
            result: {
              payload: {
                jsonrpc: "2.0",
                id: "id2",
                result: {
                  data: {
                    "meter0/ActiveConsumptionEnergy": 30000, // 30 kWh
                  },
                },
              },
            },
          })
        );

      const readings = await client.getReadings(meters, "2026-03-01", "2026-03-10");

      // Should have made exactly 2 fetch calls (one per edge)
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Verify Wh to kWh conversion
      expect(readings).toHaveLength(3);

      const reading1 = readings.find((r) => r.meterId === "meter-uuid-1");
      expect(reading1?.usageKwh).toBe(10);
      expect(reading1?.startDate).toBe("2026-03-01");
      expect(reading1?.endDate).toBe("2026-03-10");

      const reading2 = readings.find((r) => r.meterId === "meter-uuid-2");
      expect(reading2?.usageKwh).toBe(20);

      const reading3 = readings.find((r) => r.meterId === "meter-uuid-3");
      expect(reading3?.usageKwh).toBe(30);
    });

    it("converts Wh to kWh correctly", async () => {
      const meters: MeterConfig[] = [
        {
          id: "meter-uuid-1",
          dataSourceType: "openems",
          dataSourceConfig: { edgeId: "edge0", channelAddress: "meter0/ActiveConsumptionEnergy" },
        },
      ];

      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          result: {
            payload: {
              jsonrpc: "2.0",
              id: "id",
              result: {
                data: {
                  "meter0/ActiveConsumptionEnergy": 1500, // 1.5 kWh
                },
              },
            },
          },
        })
      );

      const readings = await client.getReadings(meters, "2026-03-01", "2026-03-02");
      expect(readings[0].usageKwh).toBe(1.5);
    });

    it("returns null usageKwh when energy value is null", async () => {
      const meters: MeterConfig[] = [
        {
          id: "meter-uuid-1",
          dataSourceType: "openems",
          dataSourceConfig: { edgeId: "edge0", channelAddress: "meter0/NonExistent" },
        },
      ];

      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          result: {
            payload: {
              jsonrpc: "2.0",
              id: "id",
              result: {
                data: {
                  "meter0/NonExistent": null,
                },
              },
            },
          },
        })
      );

      const readings = await client.getReadings(meters, "2026-03-01", "2026-03-02");
      expect(readings[0].usageKwh).toBeNull();
    });

    it("returns null usageKwh when channel is missing from response entirely", async () => {
      const meters: MeterConfig[] = [
        {
          id: "meter-uuid-1",
          dataSourceType: "openems",
          dataSourceConfig: { edgeId: "edge0", channelAddress: "meter0/NotInResponse" },
        },
      ];

      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          result: {
            payload: {
              jsonrpc: "2.0",
              id: "id",
              result: {
                data: {},
              },
            },
          },
        })
      );

      const readings = await client.getReadings(meters, "2026-03-01", "2026-03-02");
      expect(readings[0].usageKwh).toBeNull();
    });

    it("throws METER_INVALID_DATA_SOURCE for missing edgeId", async () => {
      const meters: MeterConfig[] = [
        {
          id: "meter-uuid-1",
          dataSourceType: "openems",
          dataSourceConfig: { channelAddress: "meter0/ActiveConsumptionEnergy" },
        },
      ];

      await expect(
        client.getReadings(meters, "2026-03-01", "2026-03-02")
      ).rejects.toThrow(OpenEmsError);

      await expect(
        client.getReadings(meters, "2026-03-01", "2026-03-02")
      ).rejects.toMatchObject({ code: "METER_INVALID_DATA_SOURCE" });
    });

    it("throws METER_INVALID_DATA_SOURCE for missing channelAddress", async () => {
      const meters: MeterConfig[] = [
        {
          id: "meter-uuid-1",
          dataSourceType: "openems",
          dataSourceConfig: { edgeId: "edge0" },
        },
      ];

      await expect(
        client.getReadings(meters, "2026-03-01", "2026-03-02")
      ).rejects.toMatchObject({ code: "METER_INVALID_DATA_SOURCE" });
    });
  });

  describe("getEdgesChannelsValues", () => {
    it("parses channel values correctly", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          result: {
            edge0: {
              "_sum/ConsumptionActivePower": 1500,
              "_sum/ProductionActivePower": 3000,
            },
          },
        })
      );

      const values = await client.getEdgesChannelsValues(
        ["edge0"],
        ["_sum/ConsumptionActivePower", "_sum/ProductionActivePower"]
      );

      expect(values).toEqual([
        { edgeId: "edge0", channelAddress: "_sum/ConsumptionActivePower", value: 1500 },
        { edgeId: "edge0", channelAddress: "_sum/ProductionActivePower", value: 3000 },
      ]);
    });

    it("handles null channel values", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          result: {
            edge0: {
              "_sum/ConsumptionActivePower": null,
            },
          },
        })
      );

      const values = await client.getEdgesChannelsValues(
        ["edge0"],
        ["_sum/ConsumptionActivePower"]
      );

      expect(values).toEqual([
        { edgeId: "edge0", channelAddress: "_sum/ConsumptionActivePower", value: null },
      ]);
    });
  });

  describe("error handling", () => {
    it("throws OPENEMS_UNREACHABLE on network failure", async () => {
      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toThrow(OpenEmsError);

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toMatchObject({
        code: "OPENEMS_UNREACHABLE",
        statusCode: 503,
      });
    });

    it("throws OPENEMS_AUTH_FAILED on 401 response", async () => {
      fetchSpy.mockResolvedValue(mockResponse({}, 401));

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toThrow(OpenEmsError);

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toMatchObject({
        code: "OPENEMS_AUTH_FAILED",
        statusCode: 401,
      });
    });

    it("throws OPENEMS_RPC_ERROR on JSON-RPC error response", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          error: {
            code: -32600,
            message: "Invalid Request",
          },
        })
      );

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toThrow(OpenEmsError);

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toMatchObject({
        code: "OPENEMS_RPC_ERROR",
        statusCode: 502,
      });
    });

    it("includes error message from JSON-RPC error", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          error: {
            code: -32600,
            message: "Edge 'edge99' is not connected",
          },
        })
      );

      try {
        await client.getEdgesStatus(["edge99"]);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(OpenEmsError);
        expect((err as OpenEmsError).message).toContain(
          "Edge 'edge99' is not connected"
        );
      }
    });
  });

  describe("getStatus (MeterDataAdapter interface)", () => {
    it("returns record keyed by edgeId", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          result: {
            edge0: { online: true },
            edge1: { online: false },
          },
        })
      );

      const status = await client.getStatus(["edge0", "edge1"]);
      expect(status).toEqual({
        edge0: { online: true },
        edge1: { online: false },
      });
    });
  });
});
