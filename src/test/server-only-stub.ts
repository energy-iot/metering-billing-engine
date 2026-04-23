// Vitest stub for the Next.js-provided `server-only` virtual module.
// Next.js implements `import 'server-only'` at the compiler level; the real
// package does not exist in node_modules. Vitest needs an alias so modules
// that import it (e.g. `src/lib/auth/access.ts`) can be loaded in the test
// environment. This file is intentionally empty — its presence is enough.
export {};
