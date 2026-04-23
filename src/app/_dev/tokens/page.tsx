"use client";

import { LocaleProvider } from "@/components/format/locale-context";
import { Currency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";
import { LocalDate } from "@/components/format/local-date";

export default function TokensPage() {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      <div className="p-8 space-y-4">
        <h1 className="text-xl font-semibold">Design Token Smoke Test</h1>

        <div className="space-y-2">
          <div>
            <span className="text-muted-foreground mr-2">Currency (UGX):</span>
            <Currency value={4216800} currency="UGX" />
          </div>
          <div>
            <span className="text-muted-foreground mr-2">Currency bareNumber:</span>
            <Currency value={4216800} currency="UGX" bareNumber />
          </div>
          <div>
            <span className="text-muted-foreground mr-2">Energy (kWh):</span>
            <Kwh value={47.3} />
          </div>
          <div>
            <span className="text-muted-foreground mr-2">Date:</span>
            <LocalDate value="2026-03-15" />
          </div>
        </div>

        <div className="bg-success-muted text-success-fg p-2 rounded-md">
          test — token color smoke check
        </div>
      </div>
    </LocaleProvider>
  );
}
