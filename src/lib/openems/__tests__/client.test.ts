import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenEmsClient } from "../client";
import { BasicAuth } from "../auth";
import { OpenEmsError } from "../errors";
import type { DeviceConfig } from "@/lib/adapters/types";

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

/**
 * A response whose body is RAW TEXT, not a JSON-serialised object.
 *
 * `mockResponse` above stringifies whatever it is given, so it can only ever
 * produce well-formed JSON — it cannot express "the backend sent an HTML error
 * page", which is exactly the case #325 is about. Tests that need a non-JSON
 * body must use this one.
 */
function mockRawResponse(
  raw: string,
  status = 200,
  contentType = "text/html"
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
    headers: new Headers({ "content-type": contentType }),
    redirected: false,
    statusText: "",
    type: "basic" as ResponseType,
    url: "",
    clone: () => mockRawResponse(raw, status, contentType),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(raw),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

// Helper to build a DeviceConfig fixture.
// Post-#101: DeviceConfig no longer carries dataSourceType / openems_backend_url
// — the client is constructed with a microgrid-scoped URL.
function makeDeviceConfig(
  id: string,
  edgeOpenemsId: string,
  componentId: string
): DeviceConfig {
  return {
    id,
    edgeOpenemsId,
    componentId,
  };
}

describe("OpenEmsClient", () => {
  let client: OpenEmsClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new OpenEmsClient(
      "http://localhost:8075",
      new BasicAuth("admin", "testpass")
    );
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

  describe("getReadings (DeviceDataAdapter interface)", () => {
    it("groups devices by edgeOpenemsId and makes batched calls", async () => {
      // Two devices on edge0, one on edge1
      const devices: DeviceConfig[] = [
        makeDeviceConfig("device-uuid-1", "edge0", "meter0"),
        makeDeviceConfig("device-uuid-2", "edge0", "meter1"),
        makeDeviceConfig("device-uuid-3", "edge1", "meter0"),
      ];

      // Channel addresses derived as: ${componentId}/ActiveConsumptionEnergy
      // edge0 channels: meter0/ActiveConsumptionEnergy, meter1/ActiveConsumptionEnergy
      // edge1 channels: meter0/ActiveConsumptionEnergy

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

      const readings = await client.getReadings(devices, "2026-03-01", "2026-03-10");

      // Should have made exactly 2 fetch calls (one per edge)
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Verify Wh to kWh conversion
      expect(readings).toHaveLength(3);

      const reading1 = readings.find((r) => r.deviceId === "device-uuid-1");
      expect(reading1?.usageKwh).toBe(10);
      expect(reading1?.startDate).toBe("2026-03-01");
      expect(reading1?.endDate).toBe("2026-03-10");

      const reading2 = readings.find((r) => r.deviceId === "device-uuid-2");
      expect(reading2?.usageKwh).toBe(20);

      const reading3 = readings.find((r) => r.deviceId === "device-uuid-3");
      expect(reading3?.usageKwh).toBe(30);
    });

    it("converts Wh to kWh correctly", async () => {
      const devices: DeviceConfig[] = [
        makeDeviceConfig("device-uuid-1", "edge0", "meter0"),
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

      const readings = await client.getReadings(devices, "2026-03-01", "2026-03-02");
      expect(readings[0].usageKwh).toBe(1.5);
    });

    it("returns null usageKwh when energy value is null", async () => {
      const devices: DeviceConfig[] = [
        makeDeviceConfig("device-uuid-1", "edge0", "meter0"),
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
                  "meter0/ActiveConsumptionEnergy": null,
                },
              },
            },
          },
        })
      );

      const readings = await client.getReadings(devices, "2026-03-01", "2026-03-02");
      expect(readings[0].usageKwh).toBeNull();
    });

    it("returns null usageKwh when channel is missing from response entirely", async () => {
      const devices: DeviceConfig[] = [
        makeDeviceConfig("device-uuid-1", "edge0", "meter99"),
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

      const readings = await client.getReadings(devices, "2026-03-01", "2026-03-02");
      expect(readings[0].usageKwh).toBeNull();
    });

    it("throws DEVICE_INVALID_DATA_SOURCE for missing edgeOpenemsId", async () => {
      const devices: DeviceConfig[] = [
        {
          id: "device-uuid-1",
          edgeOpenemsId: "", // invalid — empty string
          componentId: "meter0",
        },
      ];

      await expect(
        client.getReadings(devices, "2026-03-01", "2026-03-02")
      ).rejects.toThrow(OpenEmsError);

      await expect(
        client.getReadings(devices, "2026-03-01", "2026-03-02")
      ).rejects.toMatchObject({ code: "DEVICE_INVALID_DATA_SOURCE" });
    });

    it("throws DEVICE_INVALID_DATA_SOURCE for missing componentId", async () => {
      const devices: DeviceConfig[] = [
        {
          id: "device-uuid-1",
          edgeOpenemsId: "edge0",
          componentId: "", // invalid — empty string
        },
      ];

      await expect(
        client.getReadings(devices, "2026-03-01", "2026-03-02")
      ).rejects.toMatchObject({ code: "DEVICE_INVALID_DATA_SOURCE" });
    });
  });

  describe("getDeviceEnergy (formerly getMeterEnergy)", () => {
    it("returns DeviceEnergyResult with both Wh and kWh values", async () => {
      const devices: DeviceConfig[] = [
        makeDeviceConfig("device-uuid-1", "edge0", "meter0"),
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
                  "meter0/ActiveConsumptionEnergy": 5000, // 5 kWh
                },
              },
            },
          },
        })
      );

      const results = await client.getDeviceEnergy(
        devices,
        "2026-03-01",
        "2026-03-10"
      );

      expect(results).toHaveLength(1);
      expect(results[0].deviceId).toBe("device-uuid-1");
      expect(results[0].edgeId).toBe("edge0");
      expect(results[0].channelAddress).toBe("meter0/ActiveConsumptionEnergy");
      expect(results[0].energyWh).toBe(5000);
      expect(results[0].energyKwh).toBe(5);
    });

    it("returns null Wh and kWh when channel value is null", async () => {
      const devices: DeviceConfig[] = [
        makeDeviceConfig("device-uuid-1", "edge0", "meter0"),
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
                  "meter0/ActiveConsumptionEnergy": null,
                },
              },
            },
          },
        })
      );

      const results = await client.getDeviceEnergy(
        devices,
        "2026-03-01",
        "2026-03-10"
      );

      expect(results[0].energyWh).toBeNull();
      expect(results[0].energyKwh).toBeNull();
    });

    it("groups devices by edgeOpenemsId and batches queries", async () => {
      const devices: DeviceConfig[] = [
        makeDeviceConfig("device-uuid-1", "edge0", "meter0"),
        makeDeviceConfig("device-uuid-2", "edge0", "meter1"),
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
                  "meter0/ActiveConsumptionEnergy": 10000,
                  "meter1/ActiveConsumptionEnergy": 20000,
                },
              },
            },
          },
        })
      );

      const results = await client.getDeviceEnergy(
        devices,
        "2026-03-01",
        "2026-03-10"
      );

      // Both devices on the same edge → single fetch call
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);

      const r1 = results.find((r) => r.deviceId === "device-uuid-1");
      expect(r1?.energyKwh).toBe(10);

      const r2 = results.find((r) => r.deviceId === "device-uuid-2");
      expect(r2?.energyKwh).toBe(20);
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

      // Verify param name is "ids" (not "edgeIds") per OpenEMS B2B API
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.params.ids).toEqual(["edge0"]);
      expect(body.params.channels).toEqual(["_sum/ConsumptionActivePower", "_sum/ProductionActivePower"]);

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

    it("throws OPENEMS_AUTH_FAILED on 403 response (SigV4 permission failure)", async () => {
      fetchSpy.mockResolvedValue(mockResponse({}, 403));

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toThrow(OpenEmsError);

      await expect(
        client.getEdgesStatus(["edge0"])
      ).rejects.toMatchObject({
        code: "OPENEMS_AUTH_FAILED",
        statusCode: 403,
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

  describe("getStatus (DeviceDataAdapter interface)", () => {
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

  // ── Sink-side URL validation (mbe-docs#8) ────────────────────────────────
  //
  // Defence in depth behind the save route's write-time check. The two cover
  // different data: write-time validation governs only rows written after it
  // shipped, so a URL stored before then reaches this client having never been
  // checked by anything. This is where those are caught.
  describe("stored URL validation at the sink", () => {
    it.each([
      ["http (non-localhost)", "http://openems.example.com"],
      ["loopback literal", "http://127.0.0.1:8075"],
      ["private 10/8", "https://10.0.0.5"],
      ["link-local metadata", "https://169.254.169.254"],
      ["IPv6 loopback", "https://[::1]:8075"],
      ["embedded credentials", "https://user:pass@openems.example.com"],
      ["not absolute", "openems.example.com"],
    ])(
      "rejects a legacy stored URL (%s) without contacting it",
      async (_label, storedUrl) => {
        const legacyClient = new OpenEmsClient(
          storedUrl,
          new BasicAuth("admin", "testpass")
        );

        try {
          await legacyClient.getEdgesStatus(["edge0"]);
          expect.fail("Should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(OpenEmsError);
          const e = err as OpenEmsError;
          // Distinguishable from a network fault, and points at re-saving.
          expect(e.code).toBe("OPENEMS_INVALID_BACKEND_URL");
          expect(e.code).not.toBe("OPENEMS_UNREACHABLE");
          expect(e.message).toContain("was not contacted");
          expect(e.message).toContain("save a valid URL");
        }

        // The whole point: no request left the process.
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    );

    it("does not signal an invalid URL as an auth or network failure", async () => {
      const legacyClient = new OpenEmsClient(
        "http://192.168.1.10:8075",
        new BasicAuth("admin", "testpass")
      );
      await expect(
        legacyClient.getEdgesStatus(["edge0"])
      ).rejects.toMatchObject({ code: "OPENEMS_INVALID_BACKEND_URL" });
    });

    it("lets a valid stored URL through to fetch unchanged", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse({ jsonrpc: "2.0", id: "id", result: {} })
      );

      // The default fixture client is http://localhost:8075 — the documented
      // development case, which must keep working.
      await client.getEdgesStatus(["edge0"]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:8075/jsonrpc");
    });
  });

  // ── Redirects are not followed (mbe-docs#8) ──────────────────────────────
  //
  // The stored URL must be the URL actually contacted. Following a redirect
  // re-sends the POST — body included — to a host that never passed the
  // write-time checks in `backend-url.ts`, and leaves the operator looking at
  // a config screen showing somewhere their data did not go.
  describe("redirect handling", () => {
    function redirectResponse(status: number, location?: string): Response {
      const headers = new Headers();
      if (location) headers.set("location", location);
      return {
        ...mockResponse({}, 200),
        ok: false,
        status,
        statusText: "Redirect",
        redirected: false,
        headers,
        json: () => Promise.reject(new Error("not JSON")),
      } as unknown as Response;
    }

    it("passes redirect: 'manual' to fetch on a normal request", async () => {
      fetchSpy.mockResolvedValue(
        mockResponse({ jsonrpc: "2.0", id: "id", result: {} })
      );

      await client.getEdgesStatus(["edge0"]);

      const [, options] = fetchSpy.mock.calls[0];
      expect(options?.redirect).toBe("manual");
    });

    it.each([301, 302, 307, 308])(
      "surfaces a %i as an actionable OpenEmsError instead of following it",
      async (status) => {
        fetchSpy.mockResolvedValue(
          redirectResponse(status, "https://elsewhere.example.com/jsonrpc")
        );

        await expect(client.getEdgesStatus(["edge0"])).rejects.toBeInstanceOf(
          OpenEmsError
        );

        fetchSpy.mockResolvedValue(
          redirectResponse(status, "https://elsewhere.example.com/jsonrpc")
        );
        try {
          await client.getEdgesStatus(["edge0"]);
          expect.fail("Should have thrown");
        } catch (err) {
          const e = err as OpenEmsError;
          expect(e.code).toBe("OPENEMS_REDIRECT");
          expect(e.message).toContain("redirect");
          // Actionable: names the destination and what the operator must do.
          expect(e.message).toContain("https://elsewhere.example.com/jsonrpc");
          expect(e.message).toContain("update the saved backend URL");
        }

        // Exactly one request per call — the redirect was not followed.
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      }
    );

    it("handles an opaque redirect (status 0, type 'opaqueredirect')", async () => {
      const opaque = {
        ...mockResponse({}, 200),
        ok: false,
        status: 0,
        type: "opaqueredirect" as ResponseType,
        headers: new Headers(),
        json: () => Promise.reject(new Error("not JSON")),
      } as unknown as Response;
      fetchSpy.mockResolvedValue(opaque);

      try {
        await client.getEdgesStatus(["edge0"]);
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as OpenEmsError).code).toBe("OPENEMS_REDIRECT");
      }
    });

    it("still succeeds normally on a 200 from a plain https endpoint", async () => {
      const httpsClient = new OpenEmsClient(
        "https://openems.example.com",
        new BasicAuth("admin", "testpass")
      );
      fetchSpy.mockResolvedValue(
        mockResponse({
          jsonrpc: "2.0",
          id: "id",
          result: { edge0: { online: true } },
        })
      );

      const result = await httpsClient.getEdgesStatus(["edge0"]);

      expect(result).toEqual([{ edgeId: "edge0", online: true }]);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://openems.example.com/jsonrpc");
      expect(options?.redirect).toBe("manual");
      expect(options?.method).toBe("POST");
    });
  });

  // ── #325: non-2xx and non-JSON responses must carry their evidence ────────
  //
  // Before this, both fell through to `response.json()` and threw a bare
  // SyntaxError — not an OpenEmsError — so the save route reported "Edge
  // validation failed with an unexpected error. Check server logs." Diagnosing
  // one real incident took three people probing the operator's host by hand.
  describe("#325 HTTP and body-shape errors", () => {
    it("405 with an HTML body → OPENEMS_HTTP_ERROR carrying status and body", async () => {
      fetchSpy.mockResolvedValue(
        mockRawResponse("<html><head><title>405 Not Allowed</title></head>", 405)
      );

      await expect(client.getEdgesStatus(["edge0"])).rejects.toMatchObject({
        code: "OPENEMS_HTTP_ERROR",
        statusCode: 502,
      });

      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(
        /returned HTTP 405/
      );
      // The body is the actionable part — without it "405" is a number.
      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(
        /405 Not Allowed/
      );
    });

    it("502 from a proxy whose upstream is down → status is in the message", async () => {
      fetchSpy.mockResolvedValue(
        mockRawResponse("<html><head><title>502 Bad Gateway</title></head>", 502)
      );
      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(
        /returned HTTP 502/
      );
      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(
        /502 Bad Gateway/
      );
    });

    it("an OpenEMS auth failure arrives as 500, NOT 401 — and says so", async () => {
      // OpenEMS Backend answers an unauthenticated JSON-RPC call this way. The
      // 401/403 branch never fires for it, which is why the generic bucket
      // used to swallow the one message that named the cause.
      fetchSpy.mockResolvedValue(
        mockRawResponse(
          "Error 500 io.openems.common.exceptions.OpenemsError$OpenemsNamedException: Authentication failed",
          500
        )
      );

      await expect(client.getEdgesStatus(["edge0"])).rejects.toMatchObject({
        code: "OPENEMS_HTTP_ERROR",
      });
      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(
        /Authentication failed/
      );
    });

    it("200 text/html (a UI catch-all) → OPENEMS_NOT_JSON naming the content type", async () => {
      fetchSpy.mockResolvedValue(
        mockRawResponse('<!DOCTYPE html><html lang="en"><base href="/">', 200)
      );

      await expect(client.getEdgesStatus(["edge0"])).rejects.toMatchObject({
        code: "OPENEMS_NOT_JSON",
        statusCode: 502,
      });
      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(/text\/html/);
      // The first bytes must actually be present. Reading the body via
      // `.text()` AFTER `.json()` would yield "" here — the message would
      // promise evidence and deliver none.
      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(/!DOCTYPE html/);
      await expect(client.getEdgesStatus(["edge0"])).rejects.toThrow(
        /rather than the OpenEMS UI/
      );
    });

    it("accepts valid JSON served WITHOUT a JSON content-type", async () => {
      // The reason the parse decides rather than the header: servers that send
      // correct JSON as text/plain are common, and a content-type gate would
      // invent a failure for a setup that works.
      fetchSpy.mockResolvedValue(
        mockRawResponse(
          JSON.stringify({ jsonrpc: "2.0", id: "x", result: { edge0: { online: true } } }),
          200,
          "text/plain"
        )
      );

      await expect(client.getEdgesStatus(["edge0"])).resolves.toEqual([
        { edgeId: "edge0", online: true },
      ]);
    });
  });

});
