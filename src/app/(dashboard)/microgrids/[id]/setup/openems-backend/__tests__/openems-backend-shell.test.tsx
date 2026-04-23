// @vitest-environment jsdom
/**
 * OpenemsBackendShell tests (#102).
 *
 * Covers the AC-TESTS table:
 *  1. Empty state (super_admin): two-button row → Cloud/Direct reveal form
 *  2. Empty state (org_manager): info banner only
 *  3. Configured state (super_admin): chip, masked secret, Test again,
 *     Reconfigure
 *  4. Configured state (org_manager): no Reconfigure, info banner
 *  5. Reconfigure with draftPeriodsCount=0 → form expands
 *  6. Reconfigure with draftPeriodsCount>0 → mid-period banner, no form
 *  7. Save & test success → success banner, form collapses
 *  8. Save & test zero_edges → warn banner
 *  9. Save & test auth_failed → destructive banner, form stays
 * 10. Save & test 409 requires_typed_confirmation → dialog opens; typed
 *     confirm retries PUT with confirmed_name
 * 12. Secret-preserve: blank secret field → PUT payload omits
 *     secretAccessKey
 */

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
  act,
  within,
} from "@testing-library/react";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Stub Select to a native <select> so jsdom + user interaction works without
// Radix's portal + pointer-event layer.
vi.mock("@/components/ui/select", () => {
  function SelectRoot({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) {
    return (
      <div data-testid="select-root" data-value={value}>
        {children}
        <button
          type="button"
          data-testid="select-change"
          onClick={() => onValueChange?.("us-west-2")}
        >
          change
        </button>
      </div>
    );
  }
  return {
    Select: SelectRoot,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span>{placeholder}</span>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => <div data-value={value}>{children}</div>,
  };
});

// Stub Radix Dialog (ConfirmDialog) — our custom dialog uses Radix Portal
// which jsdom can't render into predictably. Render inline so tests can
// inspect the typed-input + confirm button.
vi.mock("@radix-ui/react-dialog", async () => {
  const React = await import("react");
  const Root = ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (o: boolean) => void;
    children: React.ReactNode;
  }) => (open ? <>{children}</> : null);
  const Portal = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const Overlay = (p: Record<string, unknown>) => <div {...p} />;
  const Content = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      onOpenAutoFocus?: (e: Event) => void;
    }
  >(({ children, onOpenAutoFocus: _unused, ...rest }, ref) => {
    void _unused;
    return (
      <div ref={ref} data-testid="dialog-content" {...rest}>
        {children}
      </div>
    );
  });
  Content.displayName = "DialogContent";
  const Title = ({ children, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...rest}>{children}</h2>
  );
  const Description = ({ children, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...rest}>{children}</p>
  );
  const Close = ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  );
  return { Root, Portal, Overlay, Content, Title, Description, Close };
});

import { OpenemsBackendShell } from "../openems-backend-shell";

const BASE_MG = {
  id: "mg-abc",
  name: "Kisakye",
  ems_type: null,
  ems_backend_url: null,
  ems_aws_region: null,
  ems_aws_access_key_id: null,
  ems_known_edge_ids: [] as string[],
  ems_last_discover_at: null,
  ems_last_discover_status: null,
  ems_last_discover_error: null,
  ems_last_discover_count: null,
};

const CONFIGURED_CLOUD = {
  id: "mg-abc",
  name: "Kisakye",
  ems_type: "cloud_aws" as const,
  ems_backend_url: "https://abc.lambda-url.us-east-1.on.aws/",
  ems_aws_region: "us-east-1",
  ems_aws_access_key_id: "AKIAIOSFODNN7EXAMPLE",
  ems_known_edge_ids: ["edge0", "edge1"],
  ems_last_discover_at: "2026-04-23T10:00:00Z",
  ems_last_discover_status: "success",
  ems_last_discover_error: null,
  ems_last_discover_count: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe("OpenemsBackendShell — empty state", () => {
  it("(1) super_admin sees the two-button row; clicking Cloud reveals Cloud form; clicking Direct reveals Direct form", () => {
    const { rerender } = render(
      <OpenemsBackendShell
        microgrid={BASE_MG}
        health="not_configured"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4={null}
        isSuperAdmin={true}
      />
    );

    const cloudBtn = screen.getByRole("button", { name: /cloud \(aws\)/i });
    const directBtn = screen.getByRole("button", { name: /direct url/i });
    expect(cloudBtn).toBeDefined();
    expect(directBtn).toBeDefined();

    fireEvent.click(cloudBtn);
    expect(screen.getByLabelText(/lambda function url/i)).toBeDefined();
    expect(screen.getByLabelText(/access key id/i)).toBeDefined();
    expect(screen.getByLabelText(/secret access key/i)).toBeDefined();

    // Re-render fresh for Direct assertion (can't toggle between forms without cancel)
    rerender(
      <OpenemsBackendShell
        microgrid={BASE_MG}
        health="not_configured"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4={null}
        isSuperAdmin={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /direct url/i }));
    expect(screen.getByLabelText(/backend url/i)).toBeDefined();
  });

  it("(2) org_manager sees an info banner, NOT the two-button row", () => {
    render(
      <OpenemsBackendShell
        microgrid={BASE_MG}
        health="not_configured"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4={null}
        isSuperAdmin={false}
      />
    );
    expect(screen.queryByRole("button", { name: /cloud \(aws\)/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /direct url/i })).toBeNull();
    expect(screen.getByText(/hasn't been connected to OpenEMS/i)).toBeDefined();
  });
});

describe("OpenemsBackendShell — configured state", () => {
  it("(3) super_admin: chip, masked secret (last 4), Test again, Reconfigure visible", () => {
    const { container } = render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    // Chip
    expect(container.textContent).toContain("Healthy");
    // Masked secret last-4
    expect(container.textContent).toContain("••••••••3ACH");
    // Test again + Reconfigure buttons
    expect(screen.getByRole("button", { name: /test again/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /reconfigure/i })).toBeDefined();
  });

  it("(4) org_manager: no Reconfigure, read-only info banner visible, secret '—'", () => {
    const { container } = render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4={null}
        isSuperAdmin={false}
      />
    );
    expect(screen.queryByRole("button", { name: /reconfigure/i })).toBeNull();
    expect(
      screen.getByText(/only super admins can update openems credentials/i)
    ).toBeDefined();
    // Secret row renders "—" when NULL secretLast4
    expect(container.textContent).toContain("—");
  });
});

describe("OpenemsBackendShell — reconfigure flow", () => {
  it("(5) draftPeriodsCount=0 expands the form on Reconfigure click", () => {
    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    // Form inputs should be present
    expect(screen.getByLabelText(/lambda function url/i)).toBeDefined();
    expect(screen.getByLabelText(/access key id/i)).toBeDefined();
  });

  it("(6) draftPeriodsCount>0 renders the mid-period banner and does NOT expand the form", () => {
    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={1}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    expect(screen.getByText(/there's an open billing period/i)).toBeDefined();
    // Form is not expanded.
    expect(screen.queryByLabelText(/lambda function url/i)).toBeNull();
  });
});

describe("OpenemsBackendShell — Save & test outcomes", () => {
  function mockFetch(response: {
    ok?: boolean;
    status?: number;
    body: unknown;
  }) {
    const res = {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () => Promise.resolve(response.body),
    } as unknown as Response;
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
  }

  async function openForm() {
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
  }

  async function submitForm() {
    const btn = screen.getByRole("button", { name: /save & test connection/i });
    // React's form submit handler is wrapped in act
    await act(async () => {
      fireEvent.click(btn);
    });
    // Flush any microtasks + setTimeout(1500) collapses
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("(7) Success → success banner renders, form collapses after timer", async () => {
    vi.useFakeTimers();
    mockFetch({
      status: 200,
      body: {
        status: "success",
        message: "Connected.",
        edgeCount: 3,
        edges: [],
      },
    });
    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    await openForm();
    await submitForm();
    // Success banner — message comes from the server response
    expect(screen.getByText(/connected\./i)).toBeDefined();
    // Advance past the 1500ms collapse timer
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    // Form should be gone (query by the Save button)
    expect(
      screen.queryByRole("button", { name: /save & test connection/i })
    ).toBeNull();
    vi.useRealTimers();
  });

  it("(8) zero_edges → warn banner, form stays editable, summary still renders", async () => {
    mockFetch({
      status: 200,
      body: {
        status: "zero_edges",
        message: "Connected, but zero edges.",
        edgeCount: 0,
        edges: [],
      },
    });
    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    await openForm();
    await submitForm();
    expect(screen.getByText(/no edges discovered/i)).toBeDefined();
    // Form still rendered
    expect(
      screen.getByRole("button", { name: /save & test connection/i })
    ).toBeDefined();
  });

  it("(9) auth_failed → destructive banner, form stays open", async () => {
    mockFetch({
      status: 200,
      body: {
        status: "auth_failed",
        message: "Authentication failed. Verify credentials.",
        edgeCount: 0,
      },
    });
    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    await openForm();
    await submitForm();
    // "Authentication failed" appears in both banner title and body — assert the title specifically.
    expect(
      screen.getByRole("heading", { name: /authentication failed/i })
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /save & test connection/i })
    ).toBeDefined();
  });

  it("(10) 409 requires_typed_confirmation → dialog opens; typing correct name + confirming retries PUT with confirmed_name", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // First call: 409 with requires_typed_confirmation
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          error: "Type microgrid name to confirm.",
          requires_typed_confirmation: { entity_name: "Kisakye" },
          closed_count: 1,
          draft_count: 0,
        }),
    } as unknown as Response);

    // Second call: success on retry
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          status: "success",
          message: "OK",
          edgeCount: 2,
          edges: [],
        }),
    } as unknown as Response);

    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={1}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    await openForm();
    await submitForm();

    // Dialog is open with typed-input
    const dialog = screen.getByTestId("dialog-content");
    expect(within(dialog).getByText(/confirm backend change/i)).toBeDefined();

    const typedInput = within(dialog).getByLabelText(
      /type the microgrid name to confirm/i
    );
    fireEvent.change(typedInput, { target: { value: "Kisakye" } });

    const confirmBtn = within(dialog).getByRole("button", {
      name: /save & test/i,
    });
    expect(confirmBtn.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Second fetch must include confirmed_name
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      fetchSpy.mock.calls[1][1]?.body as string
    );
    expect(secondBody.confirmed_name).toBe("Kisakye");
  });
});

describe("OpenemsBackendShell — secret preserve on blank (#102 AC-TEST-PRESERVE)", () => {
  it("(12) Reconfigure cloud_aws with blank secret → PUT payload OMITS secretAccessKey", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            status: "success",
            message: "ok",
            edgeCount: 0,
            edges: [],
          }),
      } as unknown as Response);

    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    // Don't touch the secret field. Submit.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /save & test connection/i })
      );
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.type).toBe("cloud_aws");
    expect("secretAccessKey" in body).toBe(false);
  });
});

describe("OpenemsBackendShell — Known edge IDs (#112)", () => {
  function mockFetch(response: {
    ok?: boolean;
    status?: number;
    body: unknown;
  }) {
    const res = {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () => Promise.resolve(response.body),
    } as unknown as Response;
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
  }

  async function openForm() {
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
  }

  async function submitForm() {
    const btn = screen.getByRole("button", { name: /save & test connection/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("Prefill case 1: empty-state (ems_type=null) → field initialized to 'edge0'", () => {
    render(
      <OpenemsBackendShell
        microgrid={BASE_MG}
        health="not_configured"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4={null}
        isSuperAdmin={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /cloud \(aws\)/i }));
    const field = screen.getByLabelText(/known edge ids/i) as HTMLInputElement;
    expect(field.value).toBe("edge0");
  });

  it("Prefill case 2: reconfigure with populated list → field shows joined list", () => {
    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    const field = screen.getByLabelText(/known edge ids/i) as HTMLInputElement;
    expect(field.value).toBe("edge0, edge1");
  });

  it("Prefill case 3: reconfigure with deliberately empty list → field is empty string", () => {
    render(
      <OpenemsBackendShell
        microgrid={{
          ...CONFIGURED_CLOUD,
          ems_known_edge_ids: [],
        }}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    const field = screen.getByLabelText(/known edge ids/i) as HTMLInputElement;
    expect(field.value).toBe("");
  });

  it("known_edge_ids is parsed and included in PUT payload as array", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      body: { status: "success", message: "Connected.", edgeCount: 2, edges: [] },
    });

    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    await openForm();

    // Set edge IDs with extra whitespace and duplicates
    const field = screen.getByLabelText(/known edge ids/i);
    fireEvent.change(field, { target: { value: " edge0 , edge1 , edge0 " } });

    await submitForm();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    // Trimmed, deduped
    expect(body.known_edge_ids).toEqual(["edge0", "edge1"]);
  });

  it("invalid_edges 400 → destructive banner listing invalid IDs, form stays open", async () => {
    mockFetch({
      ok: false,
      status: 400,
      body: {
        error: "Some edge IDs were not found on the backend. Remove or fix them before saving.",
        invalid_edges: ["edgeX", "edgeY"],
      },
    });

    render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    await openForm();
    await submitForm();

    // Destructive banner with "Edge IDs not found" title
    expect(screen.getByRole("heading", { name: /edge ids not found/i })).toBeDefined();
    // Lists the invalid IDs
    expect(screen.getByText(/edgex, edgey/i)).toBeDefined();
    // Form stays open
    expect(screen.getByRole("button", { name: /save & test connection/i })).toBeDefined();
  });

  it("Configured-state summary card shows Edge IDs line", () => {
    const { container } = render(
      <OpenemsBackendShell
        microgrid={CONFIGURED_CLOUD}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    expect(container.textContent).toContain("Edge IDs");
    expect(container.textContent).toContain("edge0, edge1");
  });

  it("Configured-state summary card shows '—' when edge list is empty", () => {
    const { container } = render(
      <OpenemsBackendShell
        microgrid={{ ...CONFIGURED_CLOUD, ems_known_edge_ids: [] }}
        health="healthy"
        draftPeriodsCount={0}
        closedPeriodsCount={0}
        secretLast4="3ACH"
        isSuperAdmin={true}
      />
    );
    expect(container.textContent).toContain("Edge IDs");
    // The — character for empty
    expect(container.textContent).toContain("—");
  });
});
