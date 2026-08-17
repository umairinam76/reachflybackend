const DEFAULT_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 250;

export function createSupabaseEntityClient({
  url = process.env.SUPABASE_URL,
  key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  schema = process.env.SUPABASE_DB_SCHEMA || "public",
  entitiesTable =
    process.env.SUPABASE_ENTITIES_TABLE ||
    "reachfly_entities",
  singletonsTable =
    process.env.SUPABASE_SINGLETONS_TABLE ||
    "reachfly_singletons",
  timeoutMs = Number(
    process.env.SUPABASE_REQUEST_TIMEOUT_MS ||
      DEFAULT_TIMEOUT_MS
  ),
} = {}) {
  const baseUrl = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  const secret = String(key || "").trim();
  const schemaName = validateIdentifier(
    schema,
    "SUPABASE_DB_SCHEMA"
  );
  const entityTableName = validateIdentifier(
    entitiesTable,
    "SUPABASE_ENTITIES_TABLE"
  );
  const singletonTableName = validateIdentifier(
    singletonsTable,
    "SUPABASE_SINGLETONS_TABLE"
  );

  if (!baseUrl) {
    throw configurationError(
      "SUPABASE_URL is required."
    );
  }

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw configurationError(
      "SUPABASE_URL must be an HTTP or HTTPS URL."
    );
  }

  if (!secret) {
    throw configurationError(
      "SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY is required."
    );
  }

  if (typeof fetch !== "function") {
    throw configurationError(
      "Node.js 18+ is required because the backend uses global fetch()."
    );
  }

  const restBase = `${baseUrl}/rest/v1`;

  function headers({
    json = false,
    prefer = "",
    range = "",
  } = {}) {
    const next = {
      apikey: secret,
      Accept: "application/json",
      "Accept-Profile": schemaName,
      "Content-Profile": schemaName,
    };

    // Legacy service_role keys are JWTs. New sb_secret_* keys are opaque and
    // should be supplied through apikey rather than as a bearer token.
    if (looksLikeJwt(secret)) {
      next.Authorization = `Bearer ${secret}`;
    }

    if (json) {
      next["Content-Type"] = "application/json";
    }

    if (prefer) {
      next.Prefer = prefer;
    }

    if (range) {
      next.Range = range;
    }

    return next;
  }

  async function listAll(table, select) {
    const rows = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const query = new URLSearchParams({
        select,
        order: "collection_key.asc,position.asc,entity_id.asc",
      });

      if (table === singletonTableName) {
        query.set("order", "state_key.asc");
      }

      const response = await request(
        `${restBase}/${encodeURIComponent(table)}?${query.toString()}`,
        {
          method: "GET",
          headers: headers({
            range: `${offset}-${offset + PAGE_SIZE - 1}`,
          }),
        }
      );

      const page = await readJson(response);
      const batch = Array.isArray(page) ? page : [];
      rows.push(...batch);

      if (batch.length < PAGE_SIZE) {
        break;
      }
    }

    return rows;
  }

  async function loadEntities() {
    return listAll(
      entityTableName,
      "collection_key,entity_id,position,workspace_id,campaign_id,lead_id,user_id,status,kind,next_action_at,data,updated_at"
    );
  }

  async function loadSingletons() {
    return listAll(
      singletonTableName,
      "state_key,data,updated_at"
    );
  }

  async function applyChanges({
    upserts = [],
    deletes = [],
    singletonUpserts = [],
    singletonDeletes = [],
  } = {}) {
    let changed = 0;

    const upsertChunks = chunk(upserts, WRITE_BATCH_SIZE);
    const deleteChunks = chunk(deletes, WRITE_BATCH_SIZE);
    const singletonUpsertChunks = chunk(
      singletonUpserts,
      WRITE_BATCH_SIZE
    );
    const singletonDeleteChunks = chunk(
      singletonDeletes,
      WRITE_BATCH_SIZE
    );

    const total = Math.max(
      upsertChunks.length,
      deleteChunks.length,
      singletonUpsertChunks.length,
      singletonDeleteChunks.length,
      1
    );

    for (let index = 0; index < total; index += 1) {
      const body = {
        p_upserts: upsertChunks[index] || [],
        p_deletes: deleteChunks[index] || [],
        p_singleton_upserts:
          singletonUpsertChunks[index] || [],
        p_singleton_deletes:
          singletonDeleteChunks[index] || [],
      };

      if (
        !body.p_upserts.length &&
        !body.p_deletes.length &&
        !body.p_singleton_upserts.length &&
        !body.p_singleton_deletes.length
      ) {
        continue;
      }

      const response = await request(
        `${restBase}/rpc/reachfly_apply_changes`,
        {
          method: "POST",
          headers: headers({ json: true }),
          body: JSON.stringify(body),
        }
      );

      const result = await readJson(response);
      changed += Number(
        result?.changed ||
          result?.upserted ||
          result?.deleted ||
          0
      );
    }

    return { ok: true, changed };
  }

  async function replaceAll({
    entities = [],
    singletons = [],
  } = {}) {
    const response = await request(
      `${restBase}/rpc/reachfly_replace_all_state`,
      {
        method: "POST",
        headers: headers({ json: true }),
        body: JSON.stringify({
          p_entities: entities,
          p_singletons: singletons,
        }),
      }
    );

    return readJson(response);
  }

  async function health() {
    const startedAt = Date.now();
    const query = new URLSearchParams({
      select: "collection_key,entity_id,updated_at",
      limit: "1",
    });

    const response = await request(
      `${restBase}/${encodeURIComponent(
        entityTableName
      )}?${query.toString()}`,
      {
        method: "GET",
        headers: headers(),
      }
    );

    await readJson(response);

    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      schema: schemaName,
      entitiesTable: entityTableName,
      singletonsTable: singletonTableName,
    };
  }

  async function request(urlValue, options) {
    const controller = new AbortController();
    const effectiveTimeout = Math.max(
      1_000,
      Number(timeoutMs) || DEFAULT_TIMEOUT_MS
    );
    const timer = setTimeout(
      () => controller.abort(),
      effectiveTimeout
    );

    try {
      const response = await fetch(urlValue, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(
          `Supabase request failed with HTTP ${response.status}.`
        );
        error.code = "SUPABASE_REQUEST_FAILED";
        error.statusCode = response.status;
        error.details = safeErrorBody(text);
        throw error;
      }

      return response;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(
          `Supabase request timed out after ${effectiveTimeout}ms.`
        );
        timeoutError.code = "SUPABASE_TIMEOUT";
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    url: baseUrl,
    schema: schemaName,
    entitiesTable: entityTableName,
    singletonsTable: singletonTableName,
    loadEntities,
    loadSingletons,
    applyChanges,
    replaceAll,
    health,
  };
}

function chunk(values, size) {
  const list = Array.isArray(values) ? values : [];
  const result = [];

  for (let index = 0; index < list.length; index += size) {
    result.push(list.slice(index, index + size));
  }

  return result;
}

function looksLikeJwt(value) {
  return String(value || "").split(".").length === 3;
}

function validateIdentifier(value, envName) {
  const next = String(value || "").trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next)) {
    throw configurationError(
      `${envName} contains an invalid Postgres identifier.`
    );
  }

  return next;
}

function configurationError(message) {
  const error = new Error(message);
  error.code = "SUPABASE_CONFIGURATION_ERROR";
  return error;
}

async function readJson(response) {
  const text = await response.text();

  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(
      "Supabase returned invalid JSON."
    );
    error.code = "SUPABASE_INVALID_RESPONSE";
    throw error;
  }
}

function safeErrorBody(value) {
  const text = String(value || "").trim();

  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return {
      code: parsed?.code || "",
      message: parsed?.message || "",
      details: parsed?.details || "",
      hint: parsed?.hint || "",
    };
  } catch {
    return {
      message: text.slice(0, 1_000),
    };
  }
}
