// @vitest-environment jsdom
/**
 * AcceptInvitePage tests (UX5c / #189).
 *
 * Coverage (per AC7 of #189):
 *   - Error state when token_hash is missing.
 *   - Error state when type is missing or != "invite".
 *   - Error state when ?error_description is present.
 *   - Calls verifyOtp({ token_hash, type: "invite" }) on mount with both
 *     params; renders the password form on success.
 *   - Error state when verifyOtp returns an error.
 *   - Error state when verifyOtp succeeds but getUser() returns no user.
 *   - Successful submit calls supabase.auth.updateUser({ password })
 *     and redirects to "/".
 *   - Submit error renders the destructive Banner from SetPasswordForm.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────

let mockSearchParams: URLSearchParams;

const pushSpy = vi.fn();
const replaceSpy = vi.fn();
const refreshSpy = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushSpy,
    replace: replaceSpy,
    refresh: refreshSpy,
  }),
  useSearchParams: () => mockSearchParams,
}));

const verifyOtpSpy = vi.fn();
const getUserSpy = vi.fn();
const updateUserSpy = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      verifyOtp: (...args: unknown[]) => verifyOtpSpy(...args),
      getUser: (...args: unknown[]) => getUserSpy(...args),
      updateUser: (...args: unknown[]) => updateUserSpy(...args),
    },
  }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────

const TOKEN_HASH = "abcdef1234567890";

function setSearchParams(query: Record<string, string>) {
  mockSearchParams = new URLSearchParams(query);
}

beforeEach(() => {
  vi.clearAllMocks();
  pushSpy.mockReset();
  replaceSpy.mockReset();
  refreshSpy.mockReset();
  verifyOtpSpy.mockReset();
  getUserSpy.mockReset();
  updateUserSpy.mockReset();
  mockSearchParams = new URLSearchParams();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("AcceptInvitePage", () => {
  it("renders error state when token_hash is missing", async () => {
    setSearchParams({ type: "invite" });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(screen.getByText(/invitation link problem/i)).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("renders error state when type is missing", async () => {
    setSearchParams({ token_hash: TOKEN_HASH });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(screen.getByText(/invitation link problem/i)).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("renders error state when type is not 'invite'", async () => {
    setSearchParams({ token_hash: TOKEN_HASH, type: "recovery" });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(screen.getByText(/invitation link problem/i)).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("renders error state when ?error_description is present", async () => {
    setSearchParams({
      token_hash: TOKEN_HASH,
      type: "invite",
      error_description: "Invite expired",
    });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(screen.getByText(/invitation link problem/i)).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("calls verifyOtp with token_hash + type:'invite' and renders the password form on success", async () => {
    setSearchParams({ token_hash: TOKEN_HASH, type: "invite" });
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "abc", email: "u@example.com" } },
      error: null,
    });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(verifyOtpSpy).toHaveBeenCalledWith({
        token_hash: TOKEN_HASH,
        type: "invite",
      });
    });
    await waitFor(() => {
      expect(
        screen.getByText(/welcome to metering & billing engine/i)
      ).toBeDefined();
    });
    // URL strip side-effect.
    expect(replaceSpy).toHaveBeenCalledWith("/accept-invite");
  });

  it("renders error state when verifyOtp returns an error", async () => {
    setSearchParams({ token_hash: TOKEN_HASH, type: "invite" });
    verifyOtpSpy.mockResolvedValue({
      data: {},
      error: { message: "expired" },
    });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(screen.getByText(/expired or has already been used/i)).toBeDefined();
    });
  });

  it("renders error state when verifyOtp succeeds but getUser returns no user", async () => {
    setSearchParams({ token_hash: TOKEN_HASH, type: "invite" });
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({ data: { user: null }, error: null });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(screen.getByText(/expired or has already been used/i)).toBeDefined();
    });
  });

  it("calls updateUser with the new password and redirects to / on submit success", async () => {
    setSearchParams({ token_hash: TOKEN_HASH, type: "invite" });
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "abc", email: "u@example.com" } },
      error: null,
    });
    updateUserSpy.mockResolvedValue({ data: {}, error: null });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(
        screen.getByText(/welcome to metering & billing engine/i)
      ).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "longenough1" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "longenough1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /set password and sign in/i })
    );

    await waitFor(() => {
      expect(updateUserSpy).toHaveBeenCalledWith({ password: "longenough1" });
    });
    expect(pushSpy).toHaveBeenCalledWith("/");
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("renders a destructive Banner when updateUser fails", async () => {
    setSearchParams({ token_hash: TOKEN_HASH, type: "invite" });
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "abc", email: "u@example.com" } },
      error: null,
    });
    updateUserSpy.mockResolvedValue({
      data: {},
      error: { message: "Password too weak" },
    });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(
        screen.getByText(/welcome to metering & billing engine/i)
      ).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "longenough1" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "longenough1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /set password and sign in/i })
    );

    await waitFor(() => {
      expect(screen.getByText(/password too weak/i)).toBeDefined();
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
