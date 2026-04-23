// @vitest-environment jsdom
/**
 * EdgeForm edit-mode tests (#104).
 *
 * Covers:
 *   - Renders Name (editable), OpenEMS Edge ID (readonly, non-input), Role (editable).
 *   - Rediscover, Cancel, and Save Changes buttons are present.
 *   - Submit sends PATCH body { name, role } — NOT openems_edge_id.
 *   - Rediscover → found + online → success banner, no PATCH.
 *   - Rediscover → not found → warning banner.
 *   - Rediscover → discover error (status: "auth_failed") → destructive banner.
 *   - While Rediscover is in flight: button label "Rediscovering…", Save disabled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EdgeForm } from "../EdgeForm";
import type { Edge } from "@/lib/types/domain";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const MOCK_EDGE: Edge = {
  id: "660e8400-e29b-41d4-a716-446655440001",
  name: "Metering Pi",
  openems_edge_id: "edge0",
  role: "metering",
  microgrid_id: "mg-uuid-1234",
  created_at: "2026-04-23T00:00:00Z",
};

describe("EdgeForm (edit mode)", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderForm(overrides?: Partial<Edge>) {
    const edge = overrides ? { ...MOCK_EDGE, ...overrides } : MOCK_EDGE;
    const onSuccess = vi.fn();
    const onCancel = vi.fn();
    render(<EdgeForm edge={edge} onSuccess={onSuccess} onCancel={onCancel} />);
    return { onSuccess, onCancel };
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  it("renders Name as an editable input", () => {
    renderForm();
    const nameInput = screen.getByLabelText(/^Name/i);
    expect(nameInput.tagName).toBe("INPUT");
    expect((nameInput as HTMLInputElement).value).toBe("Metering Pi");
  });

  it("renders OpenEMS Edge ID as readonly (not an input)", () => {
    renderForm();
    expect(screen.getByText("edge0")).toBeTruthy();
    // Should NOT be an input element
    const inputs = document.querySelectorAll("input");
    const inputValues = Array.from(inputs).map((i) => i.value);
    expect(inputValues).not.toContain("edge0");
  });

  it("renders readonly edge-id tooltip/helper text", () => {
    renderForm();
    expect(screen.getByText(/From OpenEMS Discover/i)).toBeTruthy();
  });

  it("renders Role as an editable input", () => {
    renderForm();
    const roleInput = screen.getByLabelText(/^Role/i);
    expect(roleInput.tagName).toBe("INPUT");
    expect((roleInput as HTMLInputElement).value).toBe("metering");
  });

  it("renders Rediscover, Cancel, and Save Changes buttons", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /^Rediscover$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Save changes$/i })).toBeTruthy();
  });

  // ── Submit payload ───────────────────────────────────────────────────────

  it("sends PATCH with { name, role } — never openems_edge_id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ edge: MOCK_EDGE }),
    } as Response);

    renderForm();

    fireEvent.change(screen.getByLabelText(/^Name/i), {
      target: { value: "Updated Pi" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save changes$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/edges/${MOCK_EDGE.id}`);
    expect(init?.method).toBe("PATCH");
    const body = JSON.parse(init?.body as string);
    expect(body).toHaveProperty("name", "Updated Pi");
    expect(body).toHaveProperty("role", "metering");
    expect(body).not.toHaveProperty("openems_edge_id");
  });

  it("nulls role when whitespace-only", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ edge: MOCK_EDGE }),
    } as Response);

    renderForm();

    fireEvent.change(screen.getByLabelText(/^Role/i), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save changes$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.role).toBeNull();
  });

  // ── Rediscover: success (found + online) ─────────────────────────────────

  it("shows success banner when edge is found online", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "success",
        message: "Connected. 1 edge discovered.",
        edges: [
          {
            openems_edge_id: "edge0",
            name: "edge0",
            metadata: { online: true },
            alreadyLinked: true,
          },
        ],
      }),
    } as Response);

    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^Rediscover$/i }));

    await waitFor(() =>
      expect(screen.getByText(/edge is reachable on the configured backend/i)).toBeTruthy()
    );

    // online: true should appear in the banner
    expect(screen.getByText(/online: true/i)).toBeTruthy();

    // Rediscover should NOT have triggered a PATCH
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/discover");
  });

  it("shows success banner when edge is found offline", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "success",
        message: "Connected. 1 edge discovered.",
        edges: [
          {
            openems_edge_id: "edge0",
            name: "edge0",
            metadata: { online: false },
            alreadyLinked: true,
          },
        ],
      }),
    } as Response);

    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^Rediscover$/i }));

    await waitFor(() =>
      expect(screen.getByText(/edge is reachable on the configured backend/i)).toBeTruthy()
    );
    expect(screen.getByText(/online: false/i)).toBeTruthy();
  });

  // ── Rediscover: not found ─────────────────────────────────────────────────

  it("shows warning banner when edge is not found on the backend", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "success",
        message: "Connected. 1 edge discovered.",
        edges: [
          {
            openems_edge_id: "edge1", // different — edge0 is not here
            name: "edge1",
            metadata: { online: true },
            alreadyLinked: false,
          },
        ],
      }),
    } as Response);

    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^Rediscover$/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/this edge no longer appears on the configured openems backend/i)
      ).toBeTruthy()
    );
  });

  // ── Rediscover: error (non-success status) ────────────────────────────────

  it("shows destructive banner when discover returns auth_failed", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "auth_failed",
        message:
          "Authentication failed. Verify your AWS credentials and region.",
        edges: [],
      }),
    } as Response);

    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^Rediscover$/i }));

    await waitFor(() =>
      expect(screen.getByText(/rediscover failed/i)).toBeTruthy()
    );
    expect(
      screen.getByText(/Authentication failed\. Verify your AWS credentials/i)
    ).toBeTruthy();
  });

  it("shows destructive banner on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^Rediscover$/i }));

    await waitFor(() =>
      expect(screen.getByText(/rediscover failed/i)).toBeTruthy()
    );
    expect(screen.getByText(/Network error/i)).toBeTruthy();
  });

  // ── Rediscover: busy state ────────────────────────────────────────────────

  it("disables Save and relabels Rediscover while in-flight", async () => {
    let resolveDiscover!: (value: unknown) => void;
    const pendingPromise = new Promise((res) => {
      resolveDiscover = res;
    });

    fetchMock.mockReturnValueOnce(pendingPromise as Promise<Response>);

    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^Rediscover$/i }));

    // While pending, button should show "Rediscovering…" and Save should be disabled
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Rediscovering…/i })).toBeTruthy()
    );

    const saveButton = screen.getByRole("button", { name: /^Save changes$/i });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    // Resolve the fetch so the test doesn't leak
    resolveDiscover({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", message: "", edges: [] }),
    });
  });
});
