"use client";

// Banner — project-specific informational/alert banner.
// Added in #71 (UX0 Shared UX-layer primitives).
//
// Usage:
//   <Banner tone="destructive" title="Edge offline">
//     The edge device has not reported in over 24 hours.
//     <Link href="/setup">Reconfigure</Link>
//   </Banner>
//
// `action` is rendered as-is; Banner does NOT wrap it in a button. Caller supplies a
// <Link>, <button>, or custom element so that routing and interactive semantics are
// owned by the call site.

import * as React from "react";
import { cn } from "@/lib/utils";

export type BannerTone = "info" | "success" | "warn" | "destructive";

export interface BannerProps {
  tone: BannerTone;
  title: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** HTML id — useful for aria-describedby linkage from related controls. */
  id?: string;
}

const toneClasses: Record<BannerTone, string> = {
  info: "bg-muted text-foreground border-l-4 border-border",
  success: "bg-success-muted text-success-fg border-l-4 border-success",
  warn: "bg-warning-muted text-warning-fg border-l-4 border-warning",
  destructive: "bg-destructive-muted text-destructive-fg border-l-4 border-destructive",
};

export function Banner({ tone, title, children, action, className, id }: BannerProps) {
  // Destructive banners are alert-level; others are status (or neutral informational).
  const role = tone === "destructive" ? "alert" : "status";

  return (
    <div
      id={id}
      role={role}
      className={cn("p-4 rounded-md", toneClasses[tone], className)}
    >
      {/* Title */}
      <h3 className="text-sm font-semibold leading-snug">
        {title}
      </h3>

      {/* Body */}
      <div className="mt-1 text-sm leading-relaxed">
        {children}
      </div>

      {/* Action — rendered as-is; caller supplies interactive element */}
      {action !== undefined && (
        <div className="mt-3">
          {action}
        </div>
      )}
    </div>
  );
}
