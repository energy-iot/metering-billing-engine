import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Banner } from "../banner";

describe("Banner — tone class mapping", () => {
  it("tone='info' renders bg-muted and text-foreground", () => {
    const { container } = render(
      <Banner tone="info" title="Info banner">Body text</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("bg-muted");
    expect(el.className).toContain("text-foreground");
  });

  it("tone='success' renders bg-success-muted and text-success-fg", () => {
    const { container } = render(
      <Banner tone="success" title="Success banner">Body text</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("bg-success-muted");
    expect(el.className).toContain("text-success-fg");
  });

  it("tone='warn' renders bg-warning-muted and text-warning-fg", () => {
    const { container } = render(
      <Banner tone="warn" title="Warn banner">Body text</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("bg-warning-muted");
    expect(el.className).toContain("text-warning-fg");
  });

  it("tone='destructive' renders bg-destructive-muted and text-destructive-fg", () => {
    const { container } = render(
      <Banner tone="destructive" title="Destructive banner">Body text</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("bg-destructive-muted");
    expect(el.className).toContain("text-destructive-fg");
  });
});

describe("Banner — left-edge border tokens", () => {
  it("tone='info' has border-l-4 border-border", () => {
    const { container } = render(
      <Banner tone="info" title="Info">Body</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-l-4");
    expect(el.className).toContain("border-border");
  });

  it("tone='success' has border-l-4 border-success", () => {
    const { container } = render(
      <Banner tone="success" title="Success">Body</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-l-4");
    expect(el.className).toContain("border-success");
  });

  it("tone='warn' has border-l-4 border-warning", () => {
    const { container } = render(
      <Banner tone="warn" title="Warn">Body</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-l-4");
    expect(el.className).toContain("border-warning");
  });

  it("tone='destructive' has border-l-4 border-destructive", () => {
    const { container } = render(
      <Banner tone="destructive" title="Destructive">Body</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-l-4");
    expect(el.className).toContain("border-destructive");
  });
});

describe("Banner — role", () => {
  it("tone='destructive' renders role='alert'", () => {
    const { container } = render(
      <Banner tone="destructive" title="Alert!">Danger</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.getAttribute("role")).toBe("alert");
  });

  it("tone='info' renders role='status'", () => {
    const { container } = render(
      <Banner tone="info" title="Info">Info body</Banner>
    );
    const el = container.firstElementChild!;
    expect(el.getAttribute("role")).toBe("status");
  });
});

describe("Banner — action", () => {
  it("action click fires its own handler (Banner does not swallow it)", () => {
    const onActionClick = vi.fn();
    render(
      <Banner
        tone="info"
        title="Info banner"
        action={<button onClick={onActionClick}>Take action</button>}
      >
        Body text
      </Banner>
    );

    screen.getByRole("button", { name: "Take action" }).click();
    expect(onActionClick).toHaveBeenCalledTimes(1);
  });

  it("action is rendered as-is (not wrapped in an extra button)", () => {
    const { container } = render(
      <Banner
        tone="warn"
        title="Warning"
        action={<a href="/fix">Fix it</a>}
      >
        Body
      </Banner>
    );

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("Fix it");
    // Verify it's not inside a button (Banner doesn't wrap)
    expect(link?.closest("button")).toBeNull();
  });
});
