# AGENTS.md — Metering & Billing Engine

Configuration for AI coding agents (Codex, Cursor, etc.). This file mirrors the intent of `CLAUDE.md` for tools that read `AGENTS.md`.

## Before You Start

**Read the operating model:** `../mbe-docs/docs/operating-model.md` (private repo: `energy-iot/mbe-docs`)

This document defines how we think, decide, and work:
- Four personas (Architect, PM, Designer, Infra Lead) with evaluation lenses
- Architectural invariants that must never be violated
- Implementation pipeline and review process
- Multi-contributor conventions

If `../mbe-docs/` is not available, you need access to the private `energy-iot/mbe-docs` repo. Ask the project lead.

## Context Files (in `../mbe-docs/docs/`)

Read these at the start of every session:
1. `operating-model.md` — how we operate (personas, invariants, pipeline)
2. `learnings.md` — institutional memory from prior sessions
3. `project-status.md` — active work, blockers, team

When working in a specific role, also read:
- `architect-context.md` — for system design, PR review, security
- `pm-context.md` — for feature planning, user stories, roadmap
- `designer-context.md` — for UX evaluation, design system
- `infra-context.md` — for AWS, Terraform, deployment

## Stack & Build

- **Framework:** Next.js 15 (App Router) + TypeScript
- **Auth + DB:** Supabase (Postgres + Auth + RLS)
- **Hosting:** Vercel (free tier)
- **Testing:** Vitest
- **Dev:** `npm run dev`
- **Build:** `npm run build`
- **Test:** `npm test`
- **Lint:** `npm run lint`
- **Type check:** `npx tsc --noEmit`

## Critical Rules

1. **OpenEMS calls are server-side only** — `src/app/api/openems/*` routes. Never expose `OPENEMS_B2B_*` credentials to the browser.
2. **RLS on every table** — Supabase Row Level Security enforces org isolation.
3. **This is a public repo** — never commit credentials, AWS resource names, strategy docs, or infrastructure metadata.
4. **Billing periods are manual** — the entrepreneur triggers "Close Period." Never automate this.
5. **Adapter pattern** — billing logic uses `MeterDataAdapter` interface, not OpenEMS-specific types.
6. **Read `../mbe-docs/docs/learnings.md`** before implementing — it contains patterns and pitfalls from prior sessions.

## Adding Learnings

After a session that produces insights, add entries to `../mbe-docs/docs/learnings.md`:
- Format: `YYYY-MM: [category] lesson learned`
- Commit to the `mbe-docs` repo (not this repo)
