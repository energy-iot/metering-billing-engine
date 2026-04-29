import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // PDF1b (#203): the PDF renderer registers Inter Regular/Bold via
  // `fontkit.open(<absolute-fs-path>)` at module-init (see
  // src/lib/invoices/render.tsx). Next.js's tracer cannot detect these
  // reads (no static `import` of the .ttf), so the deployed function would
  // ship without the fonts unless they are listed here explicitly.
  //
  // The PDF2 preview route (#204) shares the same renderer module and is
  // listed pre-emptively so #204's implementer doesn't have to retouch
  // this file. The two route globs are matched against route paths via
  // picomatch (`*` matches the `[lineItemId]` / `[id]` segments).
  outputFileTracingIncludes: {
    "/api/billing-line-items/*/pdf": ["./src/lib/invoices/fonts/**/*"],
    "/api/communities/*/invoice-preview": ["./src/lib/invoices/fonts/**/*"],
  },
};

export default nextConfig;
