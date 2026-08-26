// @vitest-environment jsdom
/**
 * TimezoneField tests (#357).
 *
 * Covers:
 *   - trigger shows the current zone via formatTimezone
 *   - safe-default nudge: shown when address implies non-UTC and value is
 *     UTC; one-click adoption calls onChange with the implied zone
 *   - nudge absent when the zone is already non-UTC
 *   - forward-only seam note: shown only when the selection differs from
 *     the stored zone (edit mode); absent in create mode
 *
 * The Radix Select popover and the full-list SelectionDialog are exercised
 * lightly — Radix pointer interactions are unreliable in jsdom; the
 * shortlist derivation itself is unit-tested in
 * src/lib/timezone/__tests__/shortlist.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimezoneField } from "../TimezoneField";

const UGANDA = { address_country: "Uganda", lat: 0.35, lng: 32.6 };

describe("TimezoneField (#357)", () => {
  it("shows the current zone label via formatTimezone", () => {
    render(
      <TimezoneField
        value="Africa/Kampala"
        onChange={() => {}}
        address={UGANDA}
      />,
    );
    expect(screen.getByText("Africa/Kampala (UTC+3)")).toBeDefined();
  });

  it("nudges when the address implies non-UTC but the value is still UTC", () => {
    const onChange = vi.fn();
    render(
      <TimezoneField value="UTC" onChange={onChange} address={UGANDA} />,
    );

    const nudge = screen.getByRole("status");
    expect(nudge.textContent).toMatch(/is in Uganda/i);
    expect(nudge.textContent).toMatch(/Africa\/Kampala \(UTC\+3\)/);
    expect(nudge.textContent).toMatch(/set it\?/i);

    fireEvent.click(
      screen.getByRole("button", { name: /Use Africa\/Kampala/i }),
    );
    expect(onChange).toHaveBeenCalledWith("Africa/Kampala");
  });

  it("does not nudge when a non-UTC zone is already set", () => {
    render(
      <TimezoneField
        value="Africa/Kampala"
        onChange={() => {}}
        address={UGANDA}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not nudge when the address gives no signal", () => {
    render(<TimezoneField value="UTC" onChange={() => {}} address={{}} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the forward-only seam note once the selection differs from the stored zone", () => {
    render(
      <TimezoneField
        value="Africa/Kampala"
        onChange={() => {}}
        address={UGANDA}
        storedValue="UTC"
      />,
    );
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/next.*billing period/i);
    expect(note.textContent).toMatch(/extra or fewer hours/i);
    expect(note.textContent).toMatch(/closed ones, keep the timezone/i);
  });

  it("hides the seam note while the selection equals the stored zone", () => {
    render(
      <TimezoneField
        value="UTC"
        onChange={() => {}}
        address={{}}
        storedValue="UTC"
      />,
    );
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("hides the seam note in create mode (no storedValue — nothing to seam)", () => {
    render(
      <TimezoneField
        value="Africa/Kampala"
        onChange={() => {}}
        address={UGANDA}
      />,
    );
    expect(screen.queryByRole("note")).toBeNull();
  });
});
