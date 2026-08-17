# Change manifest

Modified from the uploaded RAR backend:

- `src/store.js` — replaced JSON-file persistence with Supabase row persistence + hot cache.
- `src/server.js` — waits for Supabase before service initialization, adds storage health, flushes on shutdown.
- `src/env.js` — simplified production env loading/validation.
- `src/seed-ah-growth.js` — waits for store initialization.
- `src/seed-codesync-labs.js` — loads env and waits for store initialization.
- `src/seed-test-accounts.js` — waits for store initialization.

Added:

- `src/supabase-entity-client.js`
- `src/supabase/001_reachfly_entities.sql`
- `src/migrate-state-to-supabase.js`
- `src/verify-supabase.js`
- `src/.env.example`
- `package.json`
- `README-PRODUCTION.md`

All other supplied backend service files are byte-for-byte unchanged from the
uploaded RAR `src` folder, including:

- `telnyx-call-service.js`
- `telnyx-ai-agent-service.js`
- `caller-queue-service.js`
- `lead-audit-service.js`
- `audit-template-service.js`
- `daily-lead-automation-service.js`
- `resource-board-service.js`
- `attendance-service.js`
- team communication/control/chat services
- campaign, lead-finder, Google Places and workspace services

The bundled RAR `src/data/reachfly-store.json` is intentionally NOT included in
this replacement package because it is not the current live production state.
