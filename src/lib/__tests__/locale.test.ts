import { describe, it, expect } from "vitest";
import { detectLocale } from "../locale";

describe("detectLocale", () => {
  it("returns 'en' for null", () => {
    expect(detectLocale(null)).toBe("en");
  });

  it("returns 'en' for empty string", () => {
    expect(detectLocale("")).toBe("en");
  });

  it("returns 'en' for 'en'", () => {
    expect(detectLocale("en")).toBe("en");
  });

  it("returns 'en-US' for 'en-US'", () => {
    expect(detectLocale("en-US")).toBe("en-US");
  });

  it("returns 'en-US' for 'en-US,en;q=0.9'", () => {
    expect(detectLocale("en-US,en;q=0.9")).toBe("en-US");
  });

  it("returns 'en-US' for 'en-US;q=0.9,en;q=0.8'", () => {
    expect(detectLocale("en-US;q=0.9,en;q=0.8")).toBe("en-US");
  });

  it("returns 'fr-FR' for 'fr-FR,fr;q=0.9,en;q=0.8'", () => {
    expect(detectLocale("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr-FR");
  });
});
