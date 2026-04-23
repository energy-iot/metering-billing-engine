"use client";

/**
 * AddressFields — shared 6-input address subcomponent (#76 UX4a).
 *
 * Fields (all optional at the schema level):
 *   address_line1, address_line2, address_city, address_region,
 *   address_country, address_postal_code.
 *
 * Required-field marking is driven by the `requiredFields` prop so Org can
 * require `address_city` + `address_country` while Community / Microgrid do
 * not. The server is the authoritative validator — this is UI affordance only.
 */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type AddressValues = {
  address_line1?: string | null;
  address_line2?: string | null;
  address_city?: string | null;
  address_region?: string | null;
  address_country?: string | null;
  address_postal_code?: string | null;
};

export type AddressFieldName =
  | "address_line1"
  | "address_line2"
  | "address_city"
  | "address_region"
  | "address_country"
  | "address_postal_code";

interface AddressFieldsProps {
  values: AddressValues;
  onChange: (field: AddressFieldName, value: string) => void;
  /** Fields to mark with a required asterisk. Server enforces actual required-ness. */
  requiredFields?: readonly AddressFieldName[];
  /** Field-level error messages keyed by field name. */
  fieldErrors?: Partial<Record<AddressFieldName, string>>;
  disabled?: boolean;
}

const FIELD_LABELS: Record<AddressFieldName, string> = {
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  address_city: "City",
  address_region: "Region / state",
  address_country: "Country",
  address_postal_code: "Postal code",
};

export function AddressFields({
  values,
  onChange,
  requiredFields = [],
  fieldErrors = {},
  disabled,
}: AddressFieldsProps) {
  const requiredSet = new Set<AddressFieldName>(requiredFields);

  return (
    <div className="space-y-3">
      {(Object.keys(FIELD_LABELS) as AddressFieldName[]).map((field) => {
        const isRequired = requiredSet.has(field);
        const err = fieldErrors[field];
        const inputId = `field-${field}`;

        return (
          <div key={field}>
            <label
              htmlFor={inputId}
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              {FIELD_LABELS[field]}
              {isRequired && (
                <span
                  aria-hidden="true"
                  className="ml-0.5 text-destructive-fg"
                >
                  *
                </span>
              )}
              {isRequired && <span className="sr-only"> (required)</span>}
            </label>
            <Input
              id={inputId}
              type="text"
              value={values[field] ?? ""}
              onChange={(e) => onChange(field, e.target.value)}
              disabled={disabled}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${inputId}-err` : undefined}
              className={cn(err && "border-destructive")}
            />
            {err && (
              <p
                id={`${inputId}-err`}
                role="alert"
                className="mt-1 text-xs text-destructive-fg"
              >
                {err}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
