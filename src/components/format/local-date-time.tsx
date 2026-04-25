// LocalDateTime — date+time wrapper over <LocalDate> (BC4, #176).
//
// Why: the audit-history page (BC4) needs a consistent date+time format
// across all entries. Pinning the Intl options in one place keeps the
// rendered separator (locale-defined: en-US "Apr 25, 2026, 2:14 PM" vs
// en-GB "25 Apr 2026, 14:14") consistent and lets future surfaces
// (e.g. notification timestamps) share the same shape.
//
// `<LocalDate>` already accepts `opts: Intl.DateTimeFormatOptions`, so
// this wrapper just forwards a fixed opts object — no new logic.
//
// DO NOT hand-format with " · " or any explicit separator. The whole
// point of routing through Intl.DateTimeFormat is the locale-aware
// glue character.

import * as React from "react";
import { LocalDate, type LocalDateProps } from "./local-date";

const DT_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

export type LocalDateTimeProps = Omit<LocalDateProps, "opts" | "relative">;

export function LocalDateTime(props: LocalDateTimeProps) {
  return <LocalDate {...props} opts={DT_OPTS} />;
}
