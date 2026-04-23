// @vitest-environment jsdom
/**
 * EdgeForm enum-fallback test (#88).
 *
 * Isolated in its own file so the vi.mock hoisting (which applies to the entire
 * module scope) does not interfere with the existing EdgeForm.test.tsx suite.
 *
 * Asserts that an enum value not listed in DATA_SOURCE_LABELS renders as a
 * RadioCard with the titleized fallback title.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock is hoisted to the top of the file by Vitest — this mock applies to
// all imports of @/lib/types/database.gen within this file only.
vi.mock("@/lib/types/database.gen", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/types/database.gen")>();
  return {
    ...actual,
    Constants: {
      public: {
        Enums: {
          edge_data_source: ["openems", "modbus_direct", "mqtt", "rest_api", "bacnet"] as const,
        },
      },
    },
  };
});

// Import EdgeForm AFTER the mock declaration so it picks up the patched Constants.
import { EdgeForm } from "../EdgeForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => ({ id: "microgrid-uuid-1" }),
}));

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const MICROGRID_ID = "aaaaaaaa-aaaa-4000-8002-000000000001";

describe("EdgeForm — enum fallback label (#88)", () => {
  it("renders a 5th RadioCard with titleized fallback title when bacnet is in the enum", () => {
    render(
      <EdgeForm
        mode="create"
        parentMicrogridId={MICROGRID_ID}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    // Known values still render with their labelled titles
    expect(screen.getByText("OpenEMS")).toBeDefined();
    expect(screen.getByText("Modbus Direct")).toBeDefined();
    expect(screen.getByText("MQTT")).toBeDefined();
    expect(screen.getByText("REST API")).toBeDefined();

    // Unknown value "bacnet" renders with the titleized fallback: "Bacnet"
    expect(screen.getByText("Bacnet")).toBeDefined();
  });
});
