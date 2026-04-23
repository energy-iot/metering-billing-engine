"use client";

import { usePathname } from "next/navigation";

const tabs = [
  { label: "Tenants", segment: "tenants" },
  { label: "Rates", segment: "rates" },
  { label: "Billing", segment: "billing" },
] as const;

export function TabNav({ microgridId }: { microgridId: string }) {
  const pathname = usePathname();

  return (
    <nav className="flex space-x-1 border-b border-border">
      {tabs.map((tab) => {
        const href = `/microgrids/${microgridId}/${tab.segment}`;
        const isActive = pathname.startsWith(href);

        return (
          <a
            key={tab.segment}
            href={href}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            }`}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
