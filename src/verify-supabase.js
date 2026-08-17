import "./env.js";
import { createSupabaseEntityClient } from "./supabase-entity-client.js";

const client = createSupabaseEntityClient();
const startedAt = Date.now();
const [entities, singletons, health] = await Promise.all([
  client.loadEntities(),
  client.loadSingletons(),
  client.health(),
]);

const counts = {};
for (const row of entities) {
  counts[row.collection_key] =
    (counts[row.collection_key] || 0) + 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      health,
      entityRows: entities.length,
      singletonRows: singletons.length,
      counts,
    },
    null,
    2
  )
);
