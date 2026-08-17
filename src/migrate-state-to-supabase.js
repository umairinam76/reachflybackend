import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { createSupabaseEntityClient } from "./supabase-entity-client.js";
import {
  mergeState,
  stateToDatabasePayload,
} from "./store.js";

const args = new Map(
  process.argv.slice(2).map((item) => {
    const [key, ...rest] = item.split("=");
    return [key, rest.join("=") || true];
  })
);

const defaultSource = path.resolve(
  process.env.DATA_DIR || "./data",
  "reachfly-store.json"
);
const source = path.resolve(
  String(args.get("--source") || defaultSource)
);
const force = args.has("--force");

if (!fs.existsSync(source)) {
  throw new Error(
    `Production source file not found: ${source}`
  );
}

const raw = JSON.parse(
  fs.readFileSync(source, "utf8")
);
const state = mergeState(raw);
const payload = stateToDatabasePayload(state);
const client = createSupabaseEntityClient();
const [existingEntities, existingSingletons] =
  await Promise.all([
    client.loadEntities(),
    client.loadSingletons(),
  ]);

if (
  !force &&
  (existingEntities.length || existingSingletons.length)
) {
  throw new Error(
    `Supabase already contains ${existingEntities.length} entity rows and ${existingSingletons.length} singleton rows. Re-run with --force only if you intentionally want to replace them.`
  );
}

console.log(
  `[migration] source ${JSON.stringify({
    source,
    campaigns: state.campaigns?.length || 0,
    users: state.users?.length || 0,
    assignments: state.salesAssignments?.length || 0,
    calls: state.calls?.length || 0,
    auditReports:
      state.leadAuditReports?.length || 0,
    entityRows: payload.entities.length,
    singletonRows: payload.singletons.length,
  })}`
);

const result = await client.replaceAll(payload);
const [verifyEntities, verifySingletons] =
  await Promise.all([
    client.loadEntities(),
    client.loadSingletons(),
  ]);

if (
  verifyEntities.length !== payload.entities.length ||
  verifySingletons.length !== payload.singletons.length
) {
  throw new Error(
    `Migration verification failed. Expected ${payload.entities.length}/${payload.singletons.length} rows but Supabase returned ${verifyEntities.length}/${verifySingletons.length}.`
  );
}

console.log(
  `[migration] complete ${JSON.stringify({
    result,
    entityRows: verifyEntities.length,
    singletonRows: verifySingletons.length,
  })}`
);
