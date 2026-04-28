// @vitest-environment jsdom
/**
 * AcceptInvitePage tests (UX5c / #189 + implicit-flow fix).
 *
 * Coverage:
 *   - OTP token-hash flow (legacy path): error states for missing
 *     token_hash / wrong type / ?error_description; verifyOtp success
 *     renders the form; verifyOtp error + getUser-no-user error; submit
 *     success + failure.
 *   - Implicit flow (URL-fragment, the production path): error states
 *     for type mismatch and setSession failure; setSession success
 *     renders the form; submit success + failure on the implicit path.
 *   - Detection priority: fragment with valid tokens wins over query.
 *
 * The page no longer reads useSearchParams — it consumes the URL via
 * `window.location` (hash + search) inside the shared
 * `installSessionFromUrl` helper. Tests set `window.location` via
 * jsdom's `Object.defineProperty` workaround.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────

const pushSpy = vi.fn();
const replaceSpy = vi.fn();
const refreshSpy = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushSpy,
    replace: replaceSpy,
    refresh: refreshSpy,
  }),
}));

const setSessionSpy = vi.fn();
const verifyOtpSpy = vi.fn();
const getUserSpy = vi.fn();
const updateUserSpy = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      setSession: (...args: unknown[]) => setSessionSpy(...args),
      verifyOtp: (...args: unknown[]) => verifyOtpSpy(...args),
      getUser: (...args: unknown[]) => getUserSpy(...args),
      updateUser: (...args: unknown[]) => updateUserSpy(...args),
    },
  }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────

const TOKEN_HASH = "abcdef1234567890";
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0Ijoib2sifQ.sig";
const REFRESH_TOKEN = "rt-test-1234";

function setUrl({ search = "", hash = "" }: { search?: string; hash?: string }) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hash,
      search,
      // Provide harmless defaults for any code that reads other props.
      pathname: "/accept-invite",
      origin: "http://localhost:3000",
      href: `http://localhost:3000/accept-invite${search}${hash}`,
    },
  });
}

function fragmentFor(type: string, over: Record<string, string> = {}): string {
  return (
    "#" +
    new URLSearchParams({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: "3600",
      expires_at: "9999999999",
      token_type: "bearer",
      type,
      ...over,
    }).toString()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  pushSpy.mockReset();
  replaceSpy.mockReset();
  refreshSpy.mockReset();
  setSessionSpy.mockReset();
  verifyOtpSpy.mockReset();
  getUserSpy.mockReset();
  updateUserSpy.mockReset();
  setUrl({});
});

// ── Tests ────────────────────────────────────────────────────────────

describe("AcceptInvitePage — OTP token-hash flow (query string)", () => {
  it("renders error state when neither fragment nor query is present", async () => {
    setUrl({});
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(
        screen.getByText(/invite link is invalid or expired/i)
      ).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("renders type-mismatch error when type is missing in query", async () => {
    setUrl({ search: `?token_hash=${TOKEN_HASH}` });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(
        screen.getByText(/doesn't match the expected flow/i)
      ).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("renders type-mismatch error when type is not 'invite'", async () => {
    setUrl({ search: `?token_hash=${TOKEN_HASH}&type=recovery` });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(
        screen.getByText(/doesn't match the expected flow/i)
      ).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("renders error state when ?error_description is present", async () => {
    setUrl({
      search: `?token_hash=${TOKEN_HASH}&type=invite&error_description=Invite%20expired`,
    });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(
        screen.getByText(/invite link is invalid or expired/i)
      ).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("calls verifyOtp with token_hash + type:'invite' and renders the password form on success", async () => {
    setUrl({ search: `?token_hash=${TOKEN_HASH}&type=invite` });
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
    expect(replaceSpy).toHaveBeenCalledWith("/accept-invite");
  });

  it("renders error state when verifyOtp returns an error", async () => {
    setUrl({ search: `?token_hash=${TOKEN_HASH}&type=invite` });
    verifyOtpSpy.mockResolvedValue({
      data: {},
      error: { message: "expired" },
    });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(
        screen.getByText(/invite link is invalid or expired/i)
      ).toBeDefined();
    });
  });

  it("renders error state when verifyOtp succeeds but getUser returns no user", async () => {
    setUrl({ search: `?token_hash=${TOKEN_HASH}&type=invite` });
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({ data: { user: null }, error: null });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(
        screen.getByText(/invite link is invalid or expired/i)
      ).toBeDefined();
    });
  });

  it("calls updateUser with the new password and redirects to / on submit success", async () => {
    setUrl({ search: `?token_hash=${TOKEN_HASH}&type=invite` });
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
    setUrl({ search: `?token_hash=${TOKEN_HASH}&type=invite` });
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

describe("AcceptInvitePage — implicit flow (URL fragment)", () => {
  it("calls setSession with access+refresh tokens and renders form on success", async () => {
    setUrl({ hash: fragmentFor("invite") });
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "abc", email: "u@example.com" } },
      error: null,
    });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(setSessionSpy).toHaveBeenCalledWith({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
      });
    });
    await waitFor(() => {
      expect(
        screen.getByText(/welcome to metering & billing engine/i)
      ).toBeDefined();
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledWith("/accept-invite");
  });

  it("renders type-mismatch error when fragment type is 'recovery'", async () => {
    setUrl({ hash: fragmentFor("recovery") });
    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(
        screen.getByText(/doesn't match the expected flow/i)
      ).toBeDefined();
    });
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("renders error state when setSession fails", async () => {
    setUrl({ hash: fragmentFor("invite") });
    setSessionSpy.mockResolvedValue({
      data: {},
      error: { message: "invalid_token", code: "bad_jwt" },
    });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(
        screen.getByText(/invite link is invalid or expired/i)
      ).toBeDefined();
    });
  });

  it("renders error state when setSession ok but getUser returns no user", async () => {
    setUrl({ hash: fragmentFor("invite") });
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({ data: { user: null }, error: null });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);
    await waitFor(() => {
      expect(
        screen.getByText(/invite link is invalid or expired/i)
      ).toBeDefined();
    });
  });

  it("fragment without auth tokens falls through to query path", async () => {
    setUrl({
      hash: "#diagnostic=foo",
      search: `?token_hash=${TOKEN_HASH}&type=invite`,
    });
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "abc" } },
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
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("submits the new password successfully via implicit-flow session", async () => {
    setUrl({ hash: fragmentFor("invite") });
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
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
  });
});

describe("AcceptInvitePage — spent-token error state (#194)", () => {
  it("renders 'already been used' copy + Sign in CTA when fragment carries otp_expired", async () => {
    setUrl({
      hash:
        "#" +
        new URLSearchParams({
          error: "access_denied",
          error_code: "otp_expired",
          error_description: "Email link is invalid or has expired",
        }).toString(),
    });

    const { default: AcceptInvitePage } = await import("../page");
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(
        screen.getByText(/invite link has already been used/i)
      ).toBeDefined();
    });
    const cta = screen.getByRole("link", { name: /sign in/i });
    expect(cta.getAttribute("href")).toBe("/login");
    expect(setSessionSpy).not.toHaveBeenCalled();
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });
});
