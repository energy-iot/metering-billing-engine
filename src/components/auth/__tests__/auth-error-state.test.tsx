// @vitest-environment jsdom
/**
 * AuthErrorState tests (#194).
 *
 * Coverage:
 *   - Title + body only renders the destructive Banner (role=alert).
 *   - + primaryCta renders a primary button-link with href + label.
 *   - + secondaryCta renders both CTAs in primary-above-secondary order.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthErrorState } from "../auth-error-state";

describe("<AuthErrorState>", () => {
  it("renders title + body in a destructive Banner with no CTAs", () => {
    render(
      <AuthErrorState
        title="Something went wrong"
        body="Try again later."
      />
    );
    // Banner with destructive tone uses role="alert".
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/something went wrong/i)).toBeDefined();
    expect(screen.getByText(/try again later/i)).toBeDefined();
    // No CTAs present.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("renders a primary CTA as a token-styled button-link below the banner", () => {
    render(
      <AuthErrorState
        title="This invite link has already been used"
        body="Your account is set up. Sign in to access your dashboard."
        primaryCta={{ label: "Sign in →", href: "/login" }}
      />
    );
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link.getAttribute("href")).toBe("/login");
    // Token-class assertion: primary button uses bg-primary +
    // text-primary-foreground (matches <SetPasswordForm>'s submit button).
    const className = link.getAttribute("class") ?? "";
    expect(className).toContain("bg-primary");
    expect(className).toContain("text-primary-foreground");
  });

  it("renders both primary + secondary CTAs in primary-above-secondary order", () => {
    render(
      <AuthErrorState
        title="This reset link has already been used"
        body="If you didn't reset your password yet, request a new link."
        primaryCta={{ label: "Request a new link →", href: "/forgot-password" }}
        secondaryCta={{ label: "Back to sign in", href: "/login" }}
      />
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    // Primary is rendered first (above secondary).
    expect(links[0].getAttribute("href")).toBe("/forgot-password");
    expect(links[0].textContent).toMatch(/request a new link/i);
    expect(links[1].getAttribute("href")).toBe("/login");
    expect(links[1].textContent).toMatch(/back to sign in/i);
  });
});
