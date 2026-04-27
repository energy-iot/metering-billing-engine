// @vitest-environment jsdom
/**
 * LoginPage tests (UX5d / #190 — link addition only).
 *
 * Coverage (per AC9 of #190):
 *   - "Forgot password?" link is visible and points to /forgot-password.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: vi.fn(),
    },
  }),
}));

describe("LoginPage", () => {
  it("renders a 'Forgot password?' link to /forgot-password", async () => {
    const { default: LoginPage } = await import("../page");
    render(<LoginPage />);

    const link = screen.getByRole("link", { name: /forgot password/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("/forgot-password");
  });
});
