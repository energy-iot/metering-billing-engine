/**
 * SetPasswordForm tests (UX5c / #189).
 *
 * Coverage:
 *   - Renders title + subtitle from props.
 *   - Inline length error after blur.
 *   - Inline mismatch error after blur on confirm.
 *   - Submit button disabled while invalid.
 *   - Calls onSubmit(password) with the validated password.
 *   - Surfaces a thrown onSubmit error as a destructive Banner.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SetPasswordForm } from "../set-password-form";

const TITLE = "Welcome to Metering & Billing Engine";
const SUBTITLE = "Set a password to finish setting up your account.";

function renderForm(onSubmit: (password: string) => Promise<void>) {
  return render(
    <SetPasswordForm title={TITLE} subtitle={SUBTITLE} onSubmit={onSubmit} />
  );
}

describe("<SetPasswordForm>", () => {
  it("renders title and subtitle", () => {
    renderForm(async () => {});
    expect(screen.getByText(TITLE)).toBeDefined();
    expect(screen.getByText(SUBTITLE)).toBeDefined();
  });

  it("disables submit while password is empty", () => {
    renderForm(async () => {});
    const submit = screen.getByRole("button", {
      name: /set password and sign in/i,
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows inline length error after blur for password < 8 chars", () => {
    renderForm(async () => {});
    const password = screen.getByLabelText(/^password$/i);
    fireEvent.change(password, { target: { value: "short" } });
    fireEvent.blur(password);
    expect(screen.getByText(/at least 8 characters/i)).toBeDefined();
  });

  it("shows mismatch error when confirm differs after blur", () => {
    renderForm(async () => {});
    const password = screen.getByLabelText(/^password$/i);
    const confirm = screen.getByLabelText(/confirm password/i);
    fireEvent.change(password, { target: { value: "longenough1" } });
    fireEvent.change(confirm, { target: { value: "different1" } });
    fireEvent.blur(confirm);
    expect(screen.getByText(/passwords don't match/i)).toBeDefined();
  });

  it("disables submit when password and confirm don't match", () => {
    renderForm(async () => {});
    const password = screen.getByLabelText(/^password$/i);
    const confirm = screen.getByLabelText(/confirm password/i);
    fireEvent.change(password, { target: { value: "longenough1" } });
    fireEvent.change(confirm, { target: { value: "different1" } });
    const submit = screen.getByRole("button", {
      name: /set password and sign in/i,
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onSubmit with the validated password when both fields match", async () => {
    const onSubmit = vi.fn(async () => {});
    renderForm(onSubmit);
    const password = screen.getByLabelText(/^password$/i);
    const confirm = screen.getByLabelText(/confirm password/i);
    fireEvent.change(password, { target: { value: "longenough1" } });
    fireEvent.change(confirm, { target: { value: "longenough1" } });
    const submit = screen.getByRole("button", {
      name: /set password and sign in/i,
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("longenough1");
    });
  });

  it("renders a destructive Banner when onSubmit throws", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Server rejected the password");
    });
    renderForm(onSubmit);
    const password = screen.getByLabelText(/^password$/i);
    const confirm = screen.getByLabelText(/confirm password/i);
    fireEvent.change(password, { target: { value: "longenough1" } });
    fireEvent.change(confirm, { target: { value: "longenough1" } });
    fireEvent.click(
      screen.getByRole("button", { name: /set password and sign in/i })
    );
    await waitFor(() => {
      expect(screen.getByText(/server rejected the password/i)).toBeDefined();
    });
    // The Banner has role=alert for destructive tone.
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("respects a custom submitLabel prop", () => {
    render(
      <SetPasswordForm
        title={TITLE}
        subtitle={SUBTITLE}
        submitLabel="Reset password"
        onSubmit={async () => {}}
      />
    );
    expect(
      screen.getByRole("button", { name: /reset password/i })
    ).toBeDefined();
  });
});
