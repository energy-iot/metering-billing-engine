// locale.ts — server-side Accept-Language header parser.
//
// Contract:
//   - Split on ',' to get preference entries; take the first.
//   - Split that on ';' to strip q= weight parameters.
//   - Trim whitespace.
//   - Fall back to 'en' if input is null, empty, or parsing yields empty string.

export function detectLocale(acceptLanguage: string | null): string {
  if (!acceptLanguage) return "en";
  const first = acceptLanguage.split(",")[0];
  if (!first) return "en";
  const tag = first.split(";")[0]?.trim();
  return tag || "en";
}
