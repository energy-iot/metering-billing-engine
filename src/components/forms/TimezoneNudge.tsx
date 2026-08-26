"use client";

/**
 * TimezoneNudge — safe-default guard against the silent-UTC footgun (#357,
 * tz-awareness anchor #353).
 *
 * Rendered in the microgrid shell (microgrids/[id]/layout.tsx) when the
 * microgrid's address implies a non-UTC zone (`impliedNonUtcZone`) while its
 * billing timezone is still the schema-default 'UTC'. Shows the current zone
 * and offers the fix in one click: the action opens the standard Edit
 * Microgrid dialog (EntityForm), where the TimezoneField carries the same
 * nudge inline plus the forward-only seam note — the copy at the actual
 * point of change lives there, not here.
 *
 * Renders nothing when there is nothing to nudge about, so the surface
 * stays quiet for correctly-configured microgrids.
 */

import * as React from "react";
import { Banner } from "@/components/ui/banner";
import { Timezone, formatTimezone } from "@/components/format/timezone";
import { impliedNonUtcZone } from "@/lib/timezone/shortlist";
import { EditEntityButton } from "./EditEntityButton";
import type { MicrogridPublic } from "@/lib/types/microgrid-columns";

export function TimezoneNudge({ microgrid }: { microgrid: MicrogridPublic }) {
  const implied = impliedNonUtcZone({
    address_country: microgrid.address_country,
    lat: microgrid.lat,
    lng: microgrid.lng,
    timezone: microgrid.timezone,
  });

  if (!implied) return null;

  const countryPhrase = microgrid.address_country?.trim()
    ? `is in ${microgrid.address_country.trim()} (${formatTimezone(implied)})`
    : `suggests ${formatTimezone(implied)}`;

  return (
    <Banner
      tone="warn"
      title="Billing timezone is still UTC"
      className="mb-4"
      action={
        <EditEntityButton
          entity="microgrid"
          initialValues={microgrid}
          label="Set timezone…"
        />
      }
    >
      This microgrid&apos;s address {countryPhrase} but its billing timezone
      is <Timezone iana={microgrid.timezone} className="font-medium" /> — set
      it? Billing days currently start and end at midnight UTC.
    </Banner>
  );
}
