# Metering & Billing Engine (MBE)

Multi-tenant billing engine for microgrid energy management. Tracks energy consumption per tenant, applies time-of-use rate schedules, and generates billing summaries for microgrid entrepreneurs.

**Stack:** Next.js (App Router) + Supabase (Postgres, Auth, RLS) + OpenEMS (meter data via B2B REST API)

## Getting Started

See [docs/setup.md](docs/setup.md) for prerequisites and setup instructions.

```bash
./setup.sh      # bootstrap local Supabase + .env.local
npm run dev     # start dev server at http://localhost:3000
```

## Related

- [energy-iot/docker-openems](https://github.com/energy-iot/docker-openems) -- OpenEMS energy platform (Edge + Backend + UI)
