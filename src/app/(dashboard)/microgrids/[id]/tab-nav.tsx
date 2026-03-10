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
    <nav className="flex space-x-1 border-b border-gray-200">
      {tabs.map((tab) => {
        const href = `/microgrids/${microgridId}/${tab.segment}`;
        const isActive = pathname.startsWith(href);

        return (
          <a
            key={tab.segment}
            href={href}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
