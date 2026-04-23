// @vitest-environment jsdom
/**
 * EdgeForm component tests (UX4b / #77, #88).
 *
 * Covers:
 *   (a) OpenEMS fields show when data_source_type=openems (default)
 *   (b) Toggling to modbus_direct hides OpenEMS fields and clears their values
 *   (c) Save is blocked when data_source_type=openems and either OpenEMS field is empty
 *   (d) Save calls POST /api/edges with the correct payload in create mode
 *   (e) Edit mode pre-fills all fields including role
 *   (f) URL validation error cases shown inline
 *
 * (g) Titleized fallback for unknown enum values is tested in
 *     EdgeForm.enum-fallback.test.tsx to keep vi.mock hoisting isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EdgeForm } from "../EdgeForm";
import type { Edge } from "@/lib/types/domain";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => ({ id: "microgrid-uuid-1", edgeId: "edge-uuid-1" }),
}));

// Polyfill ResizeObserver — required by @radix-ui/react-use-size (used by RadioGroupItem indicator)
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const MICROGRID_ID = "aaaaaaaa-aaaa-4000-8002-000000000001";

const BASE_EDGE: Edge = {
  id: "aaaaaaaa-aaaa-4000-8003-000000000001",
  microgrid_id: MICROGRID_ID,
  name: "Metering Pi",
  data_source_type: "openems",
  openems_backend_url: "https://openems.example.com",
  openems_edge_id: "edge0",
  role: "metering",
  created_at: "2026-01-01T00:00:00Z",
};

function makeCreateProps() {
  return {
    mode: "create" as const,
    parentMicrogridId: MICROGRID_ID,
    onSuccess: vi.fn(),
    onCancel: vi.fn(),
  };
}

function makeEditProps(overrides: Partial<Edge> = {}) {
  return {
    mode: "edit" as const,
    edge: { ...BASE_EDGE, ...overrides },
    onSuccess: vi.fn(),
    onCancel: vi.fn(),
  };
}

describe("EdgeForm", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (a) OpenEMS fields are visible by default in create mode
  // ──────────────────────────────────────────────────────────────────────────
  describe("(a) OpenEMS fields visible by default", () => {
    it("renders Backend URL and Edge ID inputs when data_source_type is openems", () => {
      render(<EdgeForm {...makeCreateProps()} />);

      expect(screen.getByLabelText(/OpenEMS Backend URL/i)).toBeDefined();
      expect(screen.getByLabelText(/OpenEMS Edge ID/i)).toBeDefined();
    });

    it("shows all four data source radio options", () => {
      render(<EdgeForm {...makeCreateProps()} />);

      expect(screen.getByText("OpenEMS")).toBeDefined();
      expect(screen.getByText("Modbus Direct")).toBeDefined();
      expect(screen.getByText("MQTT")).toBeDefined();
      expect(screen.getByText("REST API")).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (b) Toggling to modbus_direct hides OpenEMS fields
  // ──────────────────────────────────────────────────────────────────────────
  describe("(b) Toggling data source type hides OpenEMS fields", () => {
    it("hides OpenEMS URL and Edge ID inputs when modbus_direct is selected", async () => {
      render(<EdgeForm {...makeCreateProps()} />);

      // Initially the OpenEMS fields are present
      expect(screen.getByLabelText(/OpenEMS Backend URL/i)).toBeDefined();

      // Click the Modbus Direct radio card — find the radio input
      const modbusRadio = screen.getByRole("radio", { name: /Modbus Direct/i });
      fireEvent.click(modbusRadio);

      // OpenEMS fields should now be absent from DOM
      await waitFor(() => {
        expect(screen.queryByLabelText(/OpenEMS Backend URL/i)).toBeNull();
        expect(screen.queryByLabelText(/OpenEMS Edge ID/i)).toBeNull();
      });
    });

    it("clears OpenEMS field values when toggling away from openems", async () => {
      render(<EdgeForm {...makeCreateProps()} />);

      // Fill in the OpenEMS URL
      const urlInput = screen.getByLabelText(/OpenEMS Backend URL/i) as HTMLInputElement;
      fireEvent.change(urlInput, { target: { value: "https://example.com" } });
      expect(urlInput.value).toBe("https://example.com");

      // Switch to MQTT
      const mqttRadio = screen.getByRole("radio", { name: /MQTT/i });
      fireEvent.click(mqttRadio);

      // Switch back to openems — fields should be empty
      const openemsRadio = screen.getByRole("radio", { name: /OpenEMS/i });
      fireEvent.click(openemsRadio);

      await waitFor(() => {
        const newUrlInput = screen.getByLabelText(/OpenEMS Backend URL/i) as HTMLInputElement;
        expect(newUrlInput.value).toBe("");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (c) Save is blocked when OpenEMS fields are empty in openems mode
  // ──────────────────────────────────────────────────────────────────────────
  describe("(c) Save blocked when openems fields are empty", () => {
    it("Save button is disabled when name is filled but OpenEMS fields are empty", () => {
      render(<EdgeForm {...makeCreateProps()} />);

      const nameInput = screen.getByLabelText(/Name/i);
      fireEvent.change(nameInput, { target: { value: "My Edge" } });

      // OpenEMS fields are empty by default — button should be disabled
      const saveButton = screen.getByRole("button", { name: /Add edge/i });
      expect(saveButton).toHaveProperty("disabled", true);
    });

    it("Save button is enabled when all required OpenEMS fields are filled", () => {
      render(<EdgeForm {...makeCreateProps()} />);

      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "My Edge" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Backend URL/i), {
        target: { value: "https://openems.example.com" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Edge ID/i), {
        target: { value: "edge0" },
      });

      const saveButton = screen.getByRole("button", { name: /Add edge/i });
      expect(saveButton).toHaveProperty("disabled", false);
    });

    it("Save button is enabled for non-OpenEMS type with just a name", () => {
      render(<EdgeForm {...makeCreateProps()} />);

      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "My Edge" },
      });

      // Switch to modbus_direct — no OpenEMS fields needed
      fireEvent.click(screen.getByRole("radio", { name: /Modbus Direct/i }));

      const saveButton = screen.getByRole("button", { name: /Add edge/i });
      expect(saveButton).toHaveProperty("disabled", false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (d) Save calls POST /api/edges with correct payload in create mode
  // ──────────────────────────────────────────────────────────────────────────
  describe("(d) Save calls POST /api/edges", () => {
    it("sends correct payload for openems edge creation", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ edge: { id: "new-edge-uuid" } }),
      } as Response);

      const onSuccess = vi.fn();
      render(
        <EdgeForm
          mode="create"
          parentMicrogridId={MICROGRID_ID}
          onSuccess={onSuccess}
          onCancel={vi.fn()}
        />
      );

      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "Test Edge" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Backend URL/i), {
        target: { value: "https://openems.example.com" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Edge ID/i), {
        target: { value: "edge0" },
      });
      fireEvent.change(screen.getByLabelText(/Role/i), {
        target: { value: "metering" },
      });

      fireEvent.click(screen.getByRole("button", { name: /Add edge/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/edges");
        expect(init?.method).toBe("POST");

        const body = JSON.parse(init?.body as string);
        expect(body.microgrid_id).toBe(MICROGRID_ID);
        expect(body.name).toBe("Test Edge");
        expect(body.data_source_type).toBe("openems");
        expect(body.openems_backend_url).toBe("https://openems.example.com");
        expect(body.openems_edge_id).toBe("edge0");
        expect(body.role).toBe("metering");
      });

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it("sends null for openems fields when data_source_type is modbus_direct", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ edge: { id: "new-edge-uuid-2" } }),
      } as Response);

      render(
        <EdgeForm
          mode="create"
          parentMicrogridId={MICROGRID_ID}
          onSuccess={vi.fn()}
          onCancel={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("radio", { name: /Modbus Direct/i }));
      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "Modbus Edge" },
      });

      fireEvent.click(screen.getByRole("button", { name: /Add edge/i }));

      await waitFor(() => {
        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init?.body as string);
        expect(body.data_source_type).toBe("modbus_direct");
        expect(body.openems_backend_url).toBeNull();
        expect(body.openems_edge_id).toBeNull();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (e) Edit mode pre-fills all fields including role
  // ──────────────────────────────────────────────────────────────────────────
  describe("(e) Edit mode pre-fills fields", () => {
    it("pre-fills name, openems_backend_url, openems_edge_id, and role", () => {
      render(<EdgeForm {...makeEditProps()} />);

      const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
      expect(nameInput.value).toBe("Metering Pi");

      const urlInput = screen.getByLabelText(/OpenEMS Backend URL/i) as HTMLInputElement;
      expect(urlInput.value).toBe("https://openems.example.com");

      const edgeIdInput = screen.getByLabelText(/OpenEMS Edge ID/i) as HTMLInputElement;
      expect(edgeIdInput.value).toBe("edge0");

      const roleInput = screen.getByLabelText(/Role/i) as HTMLInputElement;
      expect(roleInput.value).toBe("metering");
    });

    it("shows Save changes label (not Add edge) in edit mode", () => {
      render(<EdgeForm {...makeEditProps()} />);
      expect(screen.getByRole("button", { name: /Save changes/i })).toBeDefined();
      expect(screen.queryByRole("button", { name: /Add edge/i })).toBeNull();
    });

    it("pre-fills non-openems edge with OpenEMS fields hidden", () => {
      render(
        <EdgeForm
          {...makeEditProps({
            data_source_type: "modbus_direct",
            openems_backend_url: null,
            openems_edge_id: null,
          })}
        />
      );

      expect(screen.queryByLabelText(/OpenEMS Backend URL/i)).toBeNull();
      expect(screen.queryByLabelText(/OpenEMS Edge ID/i)).toBeNull();
    });

    it("sends PATCH to /api/edges/[id] in edit mode", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ edge: BASE_EDGE }),
      } as Response);

      render(<EdgeForm {...makeEditProps()} />);

      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "Updated Name" },
      });

      fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

      await waitFor(() => {
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`/api/edges/${BASE_EDGE.id}`);
        expect(init?.method).toBe("PATCH");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (f) URL validation error cases shown inline
  // ──────────────────────────────────────────────────────────────────────────
  describe("(f) URL validation error cases", () => {
    it("shows server error banner when API returns 422", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ error: "openems_backend_url: Invalid URL format." }),
      } as Response);

      render(<EdgeForm {...makeCreateProps()} />);

      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "Test" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Backend URL/i), {
        target: { value: "not-a-url" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Edge ID/i), {
        target: { value: "edge0" },
      });

      fireEvent.click(screen.getByRole("button", { name: /Add edge/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeDefined();
        expect(screen.getByText(/Invalid URL format/i)).toBeDefined();
      });
    });

    it("shows server error banner on 409 duplicate name", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: "An edge named 'Test' already exists on this microgrid.",
        }),
      } as Response);

      render(<EdgeForm {...makeCreateProps()} />);

      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "Test" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Backend URL/i), {
        target: { value: "https://openems.example.com" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Edge ID/i), {
        target: { value: "edge0" },
      });

      fireEvent.click(screen.getByRole("button", { name: /Add edge/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/An edge named 'Test' already exists/i)
        ).toBeDefined();
      });
    });

    it("shows 403 error when not authorized", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          error: "Not authorized to create an edge on this microgrid",
        }),
      } as Response);

      render(<EdgeForm {...makeCreateProps()} />);

      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: "Unauthorized Edge" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Backend URL/i), {
        target: { value: "https://openems.example.com" },
      });
      fireEvent.change(screen.getByLabelText(/OpenEMS Edge ID/i), {
        target: { value: "edge1" },
      });

      fireEvent.click(screen.getByRole("button", { name: /Add edge/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/Not authorized to create an edge/i)
        ).toBeDefined();
      });
    });
  });
});
