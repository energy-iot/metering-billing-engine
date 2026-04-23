// @vitest-environment jsdom
//
// AddEdgeDialog tests (#103).
//
// Strategy:
//   - vi.stubGlobal("fetch", …) so each test controls Discover + register.
//   - vi.mock("next/navigation") → stub useRouter.
//   - Assert via the rendered list / buttons / fetch.mock.calls.
//
// Cases:
//   (a) Discovering state renders spinner + disabled primary.
//   (b) List state: rows rendered with checkboxes.
//   (c) Already-linked rows: pre-checked + disabled + tooltip.
//   (d) [Select all new] selects only non-already-linked rows.
//   (e) Empty state: Close button + copy.
//   (f) Error state: Retry button re-fires Discover.
//   (g) Register payload omits already-linked rows and `role`.
//   (h) Register error: destructive banner, primary re-enabled, dialog stays open.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

// ── Import after mocks ───────────────────────────────────────────────────

import { AddEdgeDialog } from "../AddEdgeDialog";

// ── Fetch helpers ────────────────────────────────────────────────────────

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function makeFetch(
  handlers: Array<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response
  >,
) {
  const calls: FetchCall[] = [];
  let idx = 0;
  const fn = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const handler = handlers[Math.min(idx, handlers.length - 1)];
      idx += 1;
      return handler(input, init);
    },
  );
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Fixture ──────────────────────────────────────────────────────────────

const FIXTURE_EDGES = [
  {
    openems_edge_id: "edge0",
    name: "edge0",
    metadata: { online: true },
    alreadyLinked: false,
  },
  {
    openems_edge_id: "edge1",
    name: "edge1",
    metadata: { online: false },
    alreadyLinked: true,
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AddEdgeDialog", () => {
  it("(a) discovering state: renders spinner text + primary disabled", async () => {
    // Fetch never resolves → stays in discovering.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Discovering edges/)).toBeTruthy();
    });
    const primary = screen.getByRole("button", { name: /Add selected/ });
    expect((primary as HTMLButtonElement).disabled).toBe(true);
  });

  it("(b) list state: rows render with checkboxes; live count updates", async () => {
    makeFetch([async () => jsonResponse({ status: "success", edges: FIXTURE_EDGES })]);

    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/2 edges found/)).toBeTruthy();
    });

    const primary = screen.getByRole("button", {
      name: /Add selected/,
    }) as HTMLButtonElement;
    // Nothing selected (non-already-linked) yet.
    expect(primary.textContent).toMatch(/\(0\)/);
    expect(primary.disabled).toBe(true);

    // Check the new edge.
    const checkboxes = screen.getAllByRole("checkbox");
    // edge0 (new) is first.
    const newCheckbox = checkboxes[0] as HTMLInputElement;
    fireEvent.click(newCheckbox);

    await waitFor(() => {
      const updated = screen.getByRole("button", {
        name: /Add selected/,
      }) as HTMLButtonElement;
      expect(updated.textContent).toMatch(/\(1\)/);
      expect(updated.disabled).toBe(false);
    });
  });

  it("(c) already-linked rows: pre-checked + disabled + carry 'Already linked' chip", async () => {
    makeFetch([async () => jsonResponse({ status: "success", edges: FIXTURE_EDGES })]);

    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Already linked/i)).toBeTruthy();
    });

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // First is edge0 (new, unchecked); second is edge1 (already linked).
    expect(checkboxes[1].checked).toBe(true);
    expect(checkboxes[1].disabled).toBe(true);
    expect(checkboxes[1].getAttribute("aria-disabled")).toBe("true");
  });

  it("(d) [Select all new] selects only non-already-linked rows", async () => {
    makeFetch([
      async () =>
        jsonResponse({
          status: "success",
          edges: [
            ...FIXTURE_EDGES,
            {
              openems_edge_id: "edge2",
              name: "edge2",
              metadata: { online: true },
              alreadyLinked: false,
            },
          ],
        }),
    ]);

    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );

    const selectAll = await screen.findByRole("button", {
      name: /Select all new/,
    });
    fireEvent.click(selectAll);

    await waitFor(() => {
      const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      // edge0 (new) checked, edge1 (linked) still pre-checked, edge2 (new) checked.
      expect(checkboxes[0].checked).toBe(true);
      expect(checkboxes[1].checked).toBe(true);
      expect(checkboxes[2].checked).toBe(true);
    });

    // Count = 2 (only non-already-linked).
    const primary = screen.getByRole("button", {
      name: /Add selected/,
    }) as HTMLButtonElement;
    expect(primary.textContent).toMatch(/\(2\)/);

    // Button flips label to "Deselect all new".
    expect(screen.getByRole("button", { name: /Deselect all new/ })).toBeTruthy();
  });

  it("(e) empty state: renders muted copy + Close button", async () => {
    makeFetch([async () => jsonResponse({ status: "zero_edges", edges: [] })]);

    const onOpenChange = vi.fn();
    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/no edges are registered/i)).toBeTruthy();
    });
    const closeBtn = screen.getByRole("button", { name: /^Close$/ });
    fireEvent.click(closeBtn);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("(f) error state: Retry re-fires Discover", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(
            { status: "unreachable", message: "Could not reach OpenEMS" },
            200,
          );
        }
        return jsonResponse({ status: "success", edges: FIXTURE_EDGES });
      }),
    );

    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );

    const retry = await screen.findByRole("button", { name: /Retry/ });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByText(/2 edges found/)).toBeTruthy();
    });
  });

  it("(g) register payload omits already-linked rows and `role`", async () => {
    const { fn } = makeFetch([
      async () => jsonResponse({ status: "success", edges: FIXTURE_EDGES }),
      async () => jsonResponse({ inserted: 1, updated: 0, edges: [] }),
    ]);

    const onOpenChange = vi.fn();
    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
    );

    // Select edge0 (new).
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    const addBtn = await screen.findByRole("button", { name: /Add selected \(1\)/ });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(mockRefresh).toHaveBeenCalled();
    });

    // Inspect register call (second call).
    const registerCall = fn.mock.calls[1];
    expect(String(registerCall[0])).toContain(
      "/api/microgrids/mg-1/edges/register",
    );
    const init = registerCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].openems_edge_id).toBe("edge0");
    expect(body.edges[0].name).toBe("edge0");
    expect("role" in body.edges[0]).toBe(false);
  });

  it("(h) register error: destructive banner shows; dialog stays open; primary re-enabled", async () => {
    makeFetch([
      async () => jsonResponse({ status: "success", edges: FIXTURE_EDGES }),
      async () =>
        jsonResponse(
          { error: "You do not have permission to register edges on this microgrid." },
          403,
        ),
    ]);

    const onOpenChange = vi.fn();
    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
    );

    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    fireEvent.click(
      await screen.findByRole("button", { name: /Add selected \(1\)/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/do not have permission to register edges/i),
      ).toBeTruthy();
    });

    // Dialog should NOT have auto-closed.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Primary button is re-enabled and back to "Add selected (1)".
    const primary = screen.getByRole("button", {
      name: /Add selected \(1\)/,
    }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
  });

  it("(i) adding state: dialog is locked (Escape does not close)", async () => {
    makeFetch([
      async () => jsonResponse({ status: "success", edges: FIXTURE_EDGES }),
      // Register never resolves → stays in adding.
      () => new Promise<Response>(() => {}),
    ]);

    const onOpenChange = vi.fn();
    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
    );

    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(
      await screen.findByRole("button", { name: /Add selected \(1\)/ }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Adding/ })).toBeTruthy();
    });

    // Try to close via Escape — locked dialog should suppress it.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    // Radix fires onOpenChange asynchronously; give it a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("(j) list row exposes the openems_edge_id via aria-describedby on the checkbox", async () => {
    makeFetch([async () => jsonResponse({ status: "success", edges: FIXTURE_EDGES })]);

    render(
      <AddEdgeDialog
        microgridId="mg-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/2 edges found/)).toBeTruthy();
    });
    const dialog = screen.getByRole("dialog");
    const firstCheckbox = within(dialog).getAllByRole("checkbox")[0];
    const describedBy = firstCheckbox.getAttribute("aria-describedby");
    expect(describedBy).toBe("edge-row-id-edge0");
    expect(document.getElementById(describedBy!)?.textContent).toBe("edge0");
  });
});
