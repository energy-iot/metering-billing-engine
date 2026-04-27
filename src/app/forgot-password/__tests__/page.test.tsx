// @vitest-environment jsdom
/**
 * ForgotPasswordPage tests (UX5d / #190).
 *
 * Coverage (per AC9 of #190):
 *   - Renders email input + submit button.
 *   - Submit calls supabase.auth.resetPasswordForEmail with
 *     `{ redirectTo: '<origin>/reset-password' }`.
 *   - Success state renders identical copy regardless of email
 *     existence (enumeration defense — both mock-200 cases assert
 *     same output text for known + unknown emails).
 *   - 429 / over_email_send_rate_limit error renders the
 *     "Too many reset attempts" banner.
 *   - Generic error renders the generic banner; error.message is NOT
 *     echoed to the UI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────

const resetPasswordForEmailSpy = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      resetPasswordForEmail: (...args: unknown[]) =>
        resetPasswordForEmailSpy(...args),
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetPasswordForEmailSpy.mockReset();
  // jsdom defaults window.location.origin to http://localhost:3000.
});

async function loadPage() {
  vi.resetModules();
  const mod = await import("../page");
  return mod.default;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ForgotPasswordPage", () => {
  it("renders email input + submit button", async () => {
    const ForgotPasswordPage = await loadPage();
    render(<ForgotPasswordPage />);

    expect(screen.getByLabelText(/email/i)).toBeDefined();
    expect(
      screen.getByRole("button", { name: /send reset link/i })
    ).toBeDefined();
  });

  it("calls resetPasswordForEmail with redirectTo='${origin}/reset-password' on submit", async () => {
    resetPasswordForEmailSpy.mockResolvedValue({ data: {}, error: null });
    const ForgotPasswordPage = await loadPage();
    render(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /send reset link/i })
    );

    await waitFor(() => {
      expect(resetPasswordForEmailSpy).toHaveBeenCalledWith(
        "user@example.com",
        { redirectTo: `${window.location.origin}/reset-password` }
      );
    });
  });

  it("renders the same success copy for a known email (enumeration defense)", async () => {
    resetPasswordForEmailSpy.mockResolvedValue({ data: {}, error: null });
    const ForgotPasswordPage = await loadPage();
    render(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "known@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /send reset link/i })
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /check your inbox/i })
      ).toBeDefined();
    });
    expect(screen.getByText(/if an account exists for/i)).toBeDefined();
    expect(screen.getByText(/known@example.com/i)).toBeDefined();
  });

  it("renders the same success copy for an unknown email (enumeration defense)", async () => {
    // Supabase returns a 200 (success-shaped response) even for emails
    // that don't have an account. Mock that and assert the UI is
    // identical to the known-email case.
    resetPasswordForEmailSpy.mockResolvedValue({ data: {}, error: null });
    const ForgotPasswordPage = await loadPage();
    render(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "nobody-here@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /send reset link/i })
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /check your inbox/i })
      ).toBeDefined();
    });
    // Same conditional copy — does NOT confirm whether the account exists.
    expect(screen.getByText(/if an account exists for/i)).toBeDefined();
    expect(screen.getByText(/nobody-here@example.com/i)).toBeDefined();
  });

  it("renders the rate-limit banner on 429 / over_email_send_rate_limit", async () => {
    resetPasswordForEmailSpy.mockResolvedValue({
      data: {},
      error: {
        message: "Email rate limit exceeded",
        status: 429,
        code: "over_email_send_rate_limit",
      },
    });
    const ForgotPasswordPage = await loadPage();
    render(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /send reset link/i })
    );

    await waitFor(() => {
      expect(screen.getByText(/too many reset attempts/i)).toBeDefined();
    });
    // Form is still rendered (user can retry later).
    expect(
      screen.getByRole("button", { name: /send reset link/i })
    ).toBeDefined();
    // Internal error message must NOT leak to the UI.
    expect(screen.queryByText(/email rate limit exceeded/i)).toBeNull();
  });

  it("renders a generic error banner without echoing error.message", async () => {
    // Suppress the diagnostic console.error for this test.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    resetPasswordForEmailSpy.mockResolvedValue({
      data: {},
      error: {
        message: "internal-only-detail-DO-NOT-LEAK",
        status: 500,
      },
    });
    const ForgotPasswordPage = await loadPage();
    render(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /send reset link/i })
    );

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong\. please try again/i)
      ).toBeDefined();
    });
    // Internal error message must NOT leak to the UI.
    expect(
      screen.queryByText(/internal-only-detail-DO-NOT-LEAK/)
    ).toBeNull();

    consoleErrorSpy.mockRestore();
  });
});
