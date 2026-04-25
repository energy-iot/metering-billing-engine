// @vitest-environment jsdom
/**
 * PaymentShell tests (#119).
 *
 * Covers:
 *  1. Empty state (super_admin): "Connect Pesapal" card + coming-soon footnote
 *  2. Empty state (org_manager): info banner, no form
 *  3. Configured state (super_admin): chip, masked secret, Test again,
 *     Reconfigure buttons visible
 *  4. Configured state (org_manager): no Reconfigure/Test again, read-only
 *     banner, secret renders "—"
 *  5. Reconfigure form opens with existing consumer_key + blank secret +
 *     sandbox toggle initialized from stored value
 *  6. Save & test success → success banner, form collapses
 *  7. Save & test auth_failed → destructive banner, form stays open
 *  8. Save & test unreachable → destructive banner
 *  9. Secret-preserve: blank secret field → PUT payload omits
 *     `secret_access_key`
 * 10. Sandbox checkbox round-trips through Reconfigure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

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

import { PaymentShell } from "../payment-shell";

const BASE_COMMUNITY = {
  id: "comm-abc",
  name: "Kisakye",
  payment_provider: null,
  payment_last_configured_at: null,
  config: { consumer_key: "", base_url: "", sandbox: false, ipn_id: "" },
  callback_url: "",
} as const;

const CONFIGURED_COMMUNITY = {
  id: "comm-abc",
  name: "Kisakye",
  payment_provider: "pesapal" as const,
  payment_last_configured_at: "2026-04-23T10:00:00Z",
  config: {
    consumer_key: "ck_live_example",
    base_url: "https://pay.pesapal.com/v3",
    sandbox: false,
    ipn_id: "f3a2b1c0-9d8e-7f6a-5b4c-3d2e1f0a9b8c",
  },
  callback_url: "https://app.example.com/api/payments/ipn",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Empty state ─────────────────────────────────────────────────────────

describe("PaymentShell — empty state", () => {
  it("(1) super_admin sees Connect Pesapal card + coming-soon footnote", () => {
    render(
      <PaymentShell
        community={BASE_COMMUNITY}
        health="not_configured"
        secretLast4={null}
        isSuperAdmin={true}
      />,
    );
    expect(
      screen.getByRole("button", { name: /connect pesapal/i }),
    ).toBeDefined();
    expect(screen.getByText(/more providers/i)).toBeDefined();
  });

  it("(2) org_manager sees info banner, no Connect button", () => {
    render(
      <PaymentShell
        community={BASE_COMMUNITY}
        health="not_configured"
        secretLast4={null}
        isSuperAdmin={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /connect pesapal/i }),
    ).toBeNull();
    expect(screen.getByText(/not configured yet/i)).toBeDefined();
  });
});

// ─── Configured state ────────────────────────────────────────────────────

describe("PaymentShell — configured state", () => {
  it("(3) super_admin: chip, masked secret, Test again + Reconfigure visible", () => {
    const { container } = render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("••••••••9xYZ");
    expect(screen.getByRole("button", { name: /test again/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /reconfigure/i })).toBeDefined();
  });

  it("(4) org_manager: read-only banner, no Reconfigure/Test, secret '—'", () => {
    const { container } = render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4={null}
        isSuperAdmin={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /reconfigure/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /test again/i })).toBeNull();
    expect(
      screen.getByText(/only super admins can update payment credentials/i),
    ).toBeDefined();
    expect(container.textContent).toContain("—");
  });

  it("(4b) super_admin: callback URL + truncated ipn_id rendered (#121)", () => {
    const { container } = render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    expect(container.textContent).toContain("IPN callback URL");
    expect(container.textContent).toContain(
      "https://app.example.com/api/payments/ipn",
    );
    // Truncated middle: 4 leading + ellipsis + 4 trailing chars.
    expect(container.textContent).toContain("f3a2…9b8c");
    // Full GUID never rendered as inline text — it's only on a `title` attr.
    expect(container.textContent).not.toContain(
      "f3a2b1c0-9d8e-7f6a-5b4c-3d2e1f0a9b8c",
    );
  });

  it("(4c) org_manager does not see callback URL / ipn_id (super_admin gated)", () => {
    const { container } = render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4={null}
        isSuperAdmin={false}
      />,
    );
    expect(container.textContent).not.toContain("IPN callback URL");
    expect(container.textContent).not.toContain("Registered IPN id");
  });

  it("(4d) super_admin sees 'Not registered yet' hint when ipn_id is missing", () => {
    const { container } = render(
      <PaymentShell
        community={{
          ...CONFIGURED_COMMUNITY,
          config: { ...CONFIGURED_COMMUNITY.config, ipn_id: "" },
        }}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    expect(container.textContent).toContain("Not registered yet");
  });
});

// ─── Reconfigure flow ────────────────────────────────────────────────────

describe("PaymentShell — reconfigure flow", () => {
  it("(5) Reconfigure opens form with existing consumer_key + blank secret + sandbox toggle from store", () => {
    render(
      <PaymentShell
        community={{ ...CONFIGURED_COMMUNITY, config: { ...CONFIGURED_COMMUNITY.config, sandbox: true } }}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));

    const keyInput = screen.getByLabelText(/consumer key/i) as HTMLInputElement;
    const secretInput = screen.getByLabelText(
      /consumer secret/i,
    ) as HTMLInputElement;
    const sandboxCb = screen.getByLabelText(
      /use sandbox environment/i,
    ) as HTMLInputElement;

    expect(keyInput.value).toBe("ck_live_example");
    expect(secretInput.value).toBe("");
    expect(sandboxCb.checked).toBe(true);
  });
});

// ─── Save & test outcomes ────────────────────────────────────────────────

function mockFetch(response: { status?: number; body: unknown }) {
  const res = {
    ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
    status: response.status ?? 200,
    json: () => Promise.resolve(response.body),
  } as unknown as Response;
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
}

async function submitForm() {
  const btn = screen.getByRole("button", {
    name: /save & test connection/i,
  });
  await act(async () => {
    fireEvent.click(btn);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("PaymentShell — Save & test outcomes", () => {
  it("(6) success → success banner + refresh after timer", async () => {
    vi.useFakeTimers();
    const fetchSpy = mockFetch({
      status: 200,
      body: {
        status: "success",
        message: "Connected. Pesapal authentication succeeded.",
      },
    });
    render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    // Re-enter a secret so we hit the non-preserve path.
    fireEvent.change(screen.getByLabelText(/consumer secret/i), {
      target: { value: "cs_live_replacement" },
    });
    await submitForm();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/connected\./i)).toBeDefined();
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(mockRefresh).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("(7) auth_failed → destructive banner, form stays open", async () => {
    mockFetch({
      status: 503,
      body: {
        error: "Authentication failed.",
        reason: "auth_failed",
      },
    });
    render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    fireEvent.change(screen.getByLabelText(/consumer secret/i), {
      target: { value: "cs_wrong" },
    });
    await submitForm();
    // Destructive banner title ("Authentication failed") renders as an h3.
    expect(
      screen.getByRole("heading", { name: /authentication failed/i }),
    ).toBeDefined();
    // Form still open — secret input still in DOM.
    expect(screen.getByLabelText(/consumer secret/i)).toBeDefined();
  });

  it("(8) unreachable → destructive banner", async () => {
    mockFetch({
      status: 503,
      body: { error: "Could not reach Pesapal.", reason: "unreachable" },
    });
    render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    fireEvent.change(screen.getByLabelText(/consumer secret/i), {
      target: { value: "cs" },
    });
    await submitForm();
    expect(screen.getByText(/pesapal unreachable/i)).toBeDefined();
  });
});

// ─── Secret-preserve ─────────────────────────────────────────────────────

describe("PaymentShell — secret-preserve", () => {
  it("(9) blank secret on Reconfigure → PUT body omits secret_access_key", async () => {
    const fetchSpy = mockFetch({
      status: 200,
      body: { status: "success", message: "Connected." },
    });
    render(
      <PaymentShell
        community={CONFIGURED_COMMUNITY}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    // Leave the secret input blank.
    await submitForm();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect("secret_access_key" in body).toBe(false);
    expect(body.config.consumer_key).toBe("ck_live_example");
  });
});

// ─── Sandbox round-trip ──────────────────────────────────────────────────

describe("PaymentShell — sandbox toggle", () => {
  it("(10) sandbox toggle in form reflects store and flips on user click", async () => {
    const fetchSpy = mockFetch({
      status: 200,
      body: { status: "success", message: "Connected." },
    });
    render(
      <PaymentShell
        community={{
          ...CONFIGURED_COMMUNITY,
          config: { ...CONFIGURED_COMMUNITY.config, sandbox: false },
        }}
        health="healthy"
        secretLast4="9xYZ"
        isSuperAdmin={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reconfigure/i }));
    const cb = screen.getByLabelText(
      /use sandbox environment/i,
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/consumer secret/i), {
      target: { value: "cs_live_rotated" },
    });
    await submitForm();
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.config.sandbox).toBe(true);
  });
});
