"use client";

import { useState } from "react";

export function CopyButton({ value }: { value: number }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(String(value));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-1 inline-flex items-center text-xs text-gray-400 hover:text-gray-600"
      title="Copy value"
    >
      {copied ? (
        <span className="text-green-600">Copied</span>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3.5 w-3.5"
        >
          <path
            fillRule="evenodd"
            d="M15.988 3.012A2.25 2.25 0 0118 5.25v6.5A2.25 2.25 0 0115.75 14H13.5v-3.25a3.25 3.25 0 00-3.25-3.25H7V5.25A2.25 2.25 0 019.25 3h4.488a2.25 2.25 0 011.25.012zM4 8.25A2.25 2.25 0 016.25 6h3.5A2.25 2.25 0 0112 8.25v6.5A2.25 2.25 0 019.75 17h-3.5A2.25 2.25 0 014 14.75v-6.5z"
            clipRule="evenodd"
          />
        </svg>
      )}
    </button>
  );
}
