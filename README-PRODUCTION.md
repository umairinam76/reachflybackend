# ReachFly Production Backend — Supabase Persistence

This package is based on the `src` folder from the uploaded `opasrw.rar`.
Existing ReachFly routes/services were preserved. The persistence layer was
replaced so structured CRM state is no longer written to `reachfly-store.json`.

## What changed

- `src/store.js`
  - Supabase/Postgres is the durable state source.
  - Request-time reads stay in a hot Node.js memory projection for low latency.
  - Mutations are tracked by top-level collection and flushed immediately in
    small asynchronous batches.
  - Campaign leads are stored as individual rows instead of inside one global
    state document.
  - Graceful shutdown flushes pending writes.
- `src/supabase-entity-client.js`
  - Backend-only Supabase Data API client.
  - Uses the Supabase secret key/service-role key only on the server.
- `src/supabase/001_reachfly_entities.sql`
  - Production tables, indexes, RLS and transactional RPC functions.
- `src/migrate-state-to-supabase.js`
  - One-time migration from the current production `reachfly-store.json`.
- `src/server.js`
  - Waits for Supabase before starting services.
  - Adds `GET /api/health/storage`.
  - Flushes state before PM2 shutdown.
- `src/env.js` / `.env.example`
  - Reduced to the settings that actually matter for production.

The caller queue, Telnyx call lifecycle, Claude audit engine, Audit Studio,
daily lead automation, attendance, team communication, resource board and
other service code from the supplied backend remain present.

## Important production-data warning

The JSON snapshot bundled inside the uploaded RAR is not the same state shown
by the recent production logs. Do not use that bundled snapshot as your live
migration source.

Use the actual production file from the server, normally:

    $DATA_DIR/reachfly-store.json

## Deployment — safest replacement sequence

### 1. Stop writes to the old backend

    pm2 stop reachfly-api

### 2. Back up the current live state

    cp /YOUR/DATA_DIR/reachfly-store.json \
       /YOUR/DATA_DIR/reachfly-store.backup-$(date +%Y%m%d-%H%M%S).json

Do not delete the backup after migration.

### 3. Run the Supabase SQL

Open Supabase -> SQL Editor and execute:

    src/supabase/001_reachfly_entities.sql

### 4. Configure the new production `.env`

Use `src/.env.example` as the clean template. At minimum configure:

    NODE_ENV=production
    APP_URL=...
    ALLOWED_ORIGINS=...
    DATA_DIR=...
    AUTH_SECRET=...
    CREDENTIAL_ENCRYPTION_KEY=...
    SUPABASE_URL=...
    SUPABASE_SECRET_KEY=...

Then keep the Google/Anthropic/Telnyx/ElevenLabs values for the features you
actually use.

Never put the Supabase secret key in the frontend.

### 5. Migrate the CURRENT live JSON state

From the new backend directory:

    node src/migrate-state-to-supabase.js \
      --source=/YOUR/DATA_DIR/reachfly-store.json

The script refuses to overwrite a non-empty Supabase state unless `--force` is
explicitly supplied.

### 6. Verify the database

    node src/verify-supabase.js

You should see non-zero counts that match your real production state.

### 7. Replace the backend source

You can replace your current production `src` directory with the supplied
`src` directory. Keep your production `.env` outside source control.

If your existing deployment already has all Node dependencies installed, no
new npm dependency is required for Supabase persistence; it uses Node's native
`fetch()`.

### 8. Start the API

    pm2 start reachfly-api

or restart your existing PM2 ecosystem:

    pm2 restart reachfly-api --update-env

### 9. Check storage health

Authenticated or internal check:

    GET /api/health/storage

Healthy state should include:

    "ok": true
    "mode": "supabase-entity-cache"
    "pendingWrites": 0

Startup should log:

    [store] supabase-loaded ...

## Runtime architecture

    Browser
       |
       v
    ReachFly Node API
       |
       +--> in-process hot state (request reads)
       |
       +--> changed rows only
              |
              v
          Supabase/Postgres

This preserves the fast synchronous service model already used throughout the
backend while removing the repeated JSON-file read/write bottleneck.

## Database layout

`reachfly_entities` stores individual records using:

- `collection_key`
- `entity_id`
- `workspace_id`
- `campaign_id`
- `lead_id`
- `user_id`
- `status`
- `kind`
- `next_action_at`
- `data jsonb`

Campaign leads use `collection_key = campaignLeads` and are separate rows.
Assignments, calls, audits, users, channels, messages, tasks and the other
array collections are also individual rows.

`reachfly_singletons` stores application singleton/object values such as
settings and workspace maps.

The API itself still performs your current business logic from the hot state,
so caller queue/dashboard reads do not wait on a database query on every HTTP
request.

## Security

- RLS is enabled on the ReachFly tables.
- `anon` and `authenticated` are not granted direct access to these tables.
- Only the backend secret/service role can run the write RPC functions.
- The Supabase secret must never be exposed through Vite/frontend variables.

## Existing binary files

Structured CRM state is now in Supabase/Postgres.

The supplied backend still uses `DATA_DIR` for existing binary-file flows such
as attendance selfies, avatars, uploaded audit-template PDFs, team attachments
and downloaded Telnyx recordings. Keep `DATA_DIR` on persistent encrypted
server storage/backups. These files were intentionally not changed in this
replacement because their current API URLs and Telnyx/audit behavior depend on
those paths, and changing all of them at the same time would unnecessarily risk
your live caller workflow.

## PM2 process count

Run this cache-backed backend as one API process unless you add a shared cache
or cross-process invalidation layer. The uploaded production logs showed a
single `reachfly-api` PM2 process, which is the safe topology for this build.

## Validation performed on this package

- Every JavaScript file passes `node --check`.
- Supabase store tested against a mock Data API for:
  - first bootstrap from legacy JSON
  - reload from remote rows
  - campaign lead extraction
  - assignment updates
  - lead updates
  - lead deletion
  - singleton updates
  - health reporting
- Existing business-service files were left unchanged unless initialization
  needed to wait for Supabase.
