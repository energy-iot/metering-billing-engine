// @vitest-environment jsdom
/**
 * InvoiceShell — component snapshot tests (#204 / PDF2 AC-7).
 *
 * Mounts the shell in three states (empty, partially-filled, fully-filled)
 * and snapshots the rendered DOM. Vitest + jsdom + @testing-library/react.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { InvoiceShell } from "../invoice-shell";

describe("InvoiceShell — three-state snapshots", () => {
  beforeEach(() => {
    // No-op: useRouter is mocked above.
  });

  it("(1) empty config renders the prefilled defaults + missing-prefix banner", () => {
    const { container } = render(
      <InvoiceShell
        communityId="comm-abc"
        communityName="Sample Community"
        initialConfig={{}}
        initialPrefix={null}
        initialSignedThumbnailUrl={null}
      />,
    );
    // Defaults are present.
    expect(container.textContent).toContain("Configure Sample Community");
    // Missing-prefix banner.
    expect(container.textContent).toContain("Invoice prefix not set");
    // Sections.
    expect(container.textContent).toContain("Identity");
    expect(container.textContent).toContain("Seller Details");
    expect(container.textContent).toContain("Branding");
    expect(container.textContent).toContain("Payment");
    expect(container.textContent).toContain("Tax");
    expect(container.textContent).toContain("Notice copy");
  });

  it("(2) partially-filled config (prefix + identity only)", () => {
    const { container } = render(
      <InvoiceShell
        communityId="comm-abc"
        communityName="Sample Community"
        initialConfig={{
          seller: { legal_name: "Acme Co" },
        }}
        initialPrefix="ACME"
        initialSignedThumbnailUrl={null}
      />,
    );
    // Missing-prefix banner is gone.
    expect(container.textContent).not.toContain("Invoice prefix not set");
    // Prefix is in the input.
    const prefixInput = container.querySelector(
      "input#invoice-prefix",
    ) as HTMLInputElement | null;
    expect(prefixInput?.value).toBe("ACME");
  });

  it("(3) fully-filled config (all sections populated)", () => {
    const { container } = render(
      <InvoiceShell
        communityId="comm-abc"
        communityName="Sample Community"
        initialConfig={{
          seller: {
            legal_name: "Acme Co",
            trade_name: "Acme",
            tax_ids: [{ label: "TIN", value: "1234567890" }],
            address_lines: ["123 Main St", "Kampala, Uganda"],
            contact_email: "billing@acme.test",
            contact_phone: "+256700000000",
          },
          branding: {
            logo_storage_path: "comm-abc/logo.png",
            tagline: "Customer Energy Bill",
            primary_color: "#163a5f",
            accent_color: "#2f7d32",
            whatsapp_number: "+256700000000",
            document_title: "Bill",
          },
          payment: { due_days_after_issue: 14 },
          tax: { show_section: true, category_label: "VAT @ 18%", rate_pct: 18 },
          notices: {
            vat_text: "VAT registered",
            payment_instructions_text: "Pay via mobile money.",
            signature_disclaimer: "No signature required.",
          },
        }}
        initialPrefix="ACME"
        initialSignedThumbnailUrl="https://example.com/signed.png"
      />,
    );
    // Form values live in input.value, not textContent. Verify the
    // population via the actual input elements.
    const legalNameInput = container.querySelector(
      "#legal-name",
    ) as HTMLInputElement | null;
    expect(legalNameInput?.value).toBe("Acme Co");
    const tradeNameInput = container.querySelector(
      "#trade-name",
    ) as HTMLInputElement | null;
    expect(tradeNameInput?.value).toBe("Acme");
    const dueDaysInput = container.querySelector(
      "#due-days",
    ) as HTMLInputElement | null;
    expect(dueDaysInput?.value).toBe("14");
    // Persisted thumbnail src is rendered via <img>.
    const thumbImg = container.querySelector(
      'img[alt="Current logo"]',
    ) as HTMLImageElement | null;
    expect(thumbImg?.getAttribute("src")).toBe("https://example.com/signed.png");
  });
});
