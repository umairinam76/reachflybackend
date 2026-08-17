import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSupabaseEntityClient } from "./supabase-entity-client.js";

const DEFAULT_ARRAY_KEYS = [
  "users",
  "workspaces",
  "workspaceMembers",
  "workspaceInvites",
  "campaigns",
  "salesAssignments",
  "calls",
  "attendanceRecords",
  "auditReports",
  "auditJobs",
  "leadAuditReports",
  "auditReportTemplates",
  "teamChannels",
  "teamMessages",
  "teamTasks",
  "teamPresence",
  "teamAttachments",
  "teamChannelReads",
  "internalCalls",
  "teamCalls",
  "dailyLeadRuns",
  "notifications",
  "inbox",
  "activity",
  "telnyxDialers",
  "telnyxWebhookEvents",
  "dialerProfiles",
  "senderProfiles",
  "companies",
  // Compatibility collections kept because older routes/services still read them.
  "leadAssignments",
  "callRecords",
];

const defaultState = {
  users: [],
  workspaces: [],
  workspaceMembers: [],
  workspaceInvites: [],

  campaigns: [],
  salesAssignments: [],
  calls: [],
  attendanceRecords: [],

  auditReports: [],
  auditJobs: [],
  leadAuditReports: [],
  auditReportTemplates: [],

  teamChannels: [],
  teamMessages: [],
  teamTasks: [],
  teamPresence: [],
  teamAttachments: [],
  teamChannelReads: [],
  internalCalls: [],
  teamCalls: [],

  dailyLeadRuns: [],
  notifications: [],
  inbox: [],
  activity: [],

  telnyxDialers: [],
  telnyxWebhookEvents: [],
  dialerProfiles: [],
  senderProfiles: [],
  companies: [],

  leadAssignments: [],
  callRecords: [],

  workspaceSettings: {},
  workspaceWhatsApp: {},

  settings: {
    app: {
      workspaceName: "ReachFly.Ai Growth Workspace",
      defaultRadiusKm: 10,
      defaultLeadLimit: 100,
      complianceMode: true,
      allowDemoFallback: true,
      brandTagline: "From territory to client inbox in 5 clicks",
    },
    email: {
      provider: "gmail",
      fromName: "ReachFly.Ai",
      fromEmail: "",
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      username: "",
      replyTo: "",
    },
  },

  whatsapp: {
    ready: false,
    qr: "",
    mode: "demo",
    message: "WhatsApp not linked.",
  },
};

/**
 * Low-latency ReachFly state store backed by Supabase/Postgres.
 *
 * The existing ReachFly services are intentionally synchronous and expect
 * store.read()/store.update() to be immediate. Rewriting every call path to be
 * async would create a very large regression surface, so this store keeps a hot
 * in-process projection for reads while persisting changed entities to
 * Supabase in small batches.
 *
 * Persistence is no longer one giant JSON document. Top-level array records are
 * individual Postgres rows. Campaign leads are extracted into their own rows so
 * changing one lead does not rewrite an entire CRM snapshot. Singleton objects
 * such as settings are stored in reachfly_singletons.
 */
export function createStore({ dataDir = "./data" } = {}) {
  const absoluteDir = path.resolve(process.cwd(), dataDir);
  const legacyFilePath = path.join(
    absoluteDir,
    "reachfly-store.json"
  );
  const writeDebounceMs = clampInteger(
    process.env.SUPABASE_WRITE_DEBOUNCE_MS,
    0,
    0,
    2_000
  );
  const retryMs = clampInteger(
    process.env.SUPABASE_WRITE_RETRY_MS,
    250,
    2_000,
    60_000
  );
  const allowEmptyBootstrap = envFlag(
    process.env.SUPABASE_ALLOW_EMPTY_BOOTSTRAP,
    false
  );
  const debug = envFlag(
    process.env.SUPABASE_STORE_DEBUG,
    false
  );

  fs.mkdirSync(absoluteDir, { recursive: true });

  let client = null;
  let currentState = mergeState(
    structuredClone(defaultState)
  );
  let readyPromise = null;
  let readyComplete = false;
  let flushTimer = null;
  let flushPromise = null;
  let retryTimer = null;
  let lastLoadedAt = "";
  let lastPersistedAt = "";
  let lastError = null;
  let totalFlushes = 0;
  let totalPersistedRows = 0;

  const dirtyRoots = new Map();
  const baselineByRoot = new Map();

  async function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = initialize();
    return readyPromise;
  }

  async function initialize() {
    client = createSupabaseEntityClient();

    try {
      const [entities, singletons] = await Promise.all([
        client.loadEntities(),
        client.loadSingletons(),
      ]);

      if (entities.length || singletons.length) {
        currentState = mergeState(
          databaseRowsToState({
            entities,
            singletons,
          })
        );
        lastLoadedAt = new Date().toISOString();

        console.log(
          `[store] supabase-loaded ${JSON.stringify({
            entities: entities.length,
            singletons: singletons.length,
            schema: client.schema,
          })}`
        );
      } else {
        const legacy = loadLegacyFile(legacyFilePath);

        if (!legacy && !allowEmptyBootstrap) {
          const error = new Error(
            `Supabase is empty and no production reachfly-store.json was found at ${legacyFilePath}. Set DATA_DIR correctly or run migrate-state-to-supabase.js before starting the API.`
          );
          error.code = "SUPABASE_BOOTSTRAP_SOURCE_MISSING";
          throw error;
        }

        currentState = mergeState(
          legacy || structuredClone(defaultState)
        );
        const payload = stateToDatabasePayload(
          currentState
        );

        await client.replaceAll(payload);
        lastPersistedAt = new Date().toISOString();

        console.log(
          `[store] supabase-bootstrapped ${JSON.stringify({
            source: legacy
              ? legacyFilePath
              : "defaults",
            entities: payload.entities.length,
            singletons: payload.singletons.length,
          })}`
        );
      }

      rebuildBaseline();
      readyComplete = true;
      lastError = null;
      return currentState;
    } catch (error) {
      lastError = normalizeStoreError(error);

      console.error(
        `[store] supabase-initialize-failed ${JSON.stringify({
          message: lastError.message,
          code: lastError.code,
          details: lastError.details,
        })}`
      );

      throw error;
    }
  }

  function read() {
    assertReady();
    return currentState;
  }

  function write(next) {
    assertReady();
    currentState = mergeState(next);

    for (const key of Object.keys(currentState)) {
      markRootDirty(key);
    }

    scheduleFlush();
    return currentState;
  }

  function update(mutator) {
    assertReady();

    if (typeof mutator !== "function") {
      throw new TypeError(
        "store.update requires a mutation function."
      );
    }

    const touched = new Set();
    const tracked = createTrackedProxy(
      currentState,
      touched
    );
    let result;

    try {
      result = mutator(tracked);
    } finally {
      for (const key of touched) {
        markRootDirty(key);
      }
    }

    if (
      result &&
      result !== tracked &&
      result !== currentState
    ) {
      currentState = mergeState(result);

      for (const key of Object.keys(currentState)) {
        markRootDirty(key);
      }
    }

    if (touched.size || result !== undefined) {
      scheduleFlush();
    }

    return currentState;
  }

  async function reload() {
    assertReady();
    await flush();

    const [entities, singletons] = await Promise.all([
      client.loadEntities(),
      client.loadSingletons(),
    ]);

    currentState = mergeState(
      databaseRowsToState({
        entities,
        singletons,
      })
    );
    dirtyRoots.clear();
    rebuildBaseline();
    lastLoadedAt = new Date().toISOString();
    lastError = null;
    return currentState;
  }

  function markRootDirty(rootKey) {
    const key = String(rootKey || "").trim();
    if (!key) return;
    dirtyRoots.set(
      key,
      (dirtyRoots.get(key) || 0) + 1
    );
  }

  function scheduleFlush() {
    if (!readyComplete) return;
    if (flushTimer || flushPromise) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch(() => {});
    }, writeDebounceMs);
    flushTimer.unref?.();
  }

  async function flush() {
    assertReady();

    if (flushPromise) {
      return flushPromise;
    }

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    flushPromise = (async () => {
      while (dirtyRoots.size) {
        const roots = [...dirtyRoots.entries()];
        const snapshots = new Map();
        const aggregate = {
          upserts: [],
          deletes: [],
          singletonUpserts: [],
          singletonDeletes: [],
        };

        for (const [rootKey] of roots) {
          const snapshot = serializeRoot(
            rootKey,
            currentState[rootKey]
          );
          snapshots.set(rootKey, snapshot);
          const previous =
            baselineByRoot.get(rootKey) ||
            emptyRootSnapshot();
          appendDiff(
            aggregate,
            previous,
            snapshot
          );
        }

        try {
          if (
            aggregate.upserts.length ||
            aggregate.deletes.length ||
            aggregate.singletonUpserts.length ||
            aggregate.singletonDeletes.length
          ) {
            await client.applyChanges(aggregate);
          }

          totalFlushes += 1;
          totalPersistedRows +=
            aggregate.upserts.length +
            aggregate.deletes.length +
            aggregate.singletonUpserts.length +
            aggregate.singletonDeletes.length;
          lastPersistedAt = new Date().toISOString();
          lastError = null;

          for (const [rootKey, generation] of roots) {
            baselineByRoot.set(
              rootKey,
              snapshots.get(rootKey)
            );

            if (
              dirtyRoots.get(rootKey) === generation
            ) {
              dirtyRoots.delete(rootKey);
            }
          }

          if (debug) {
            console.log(
              `[store] supabase-flush ${JSON.stringify({
                roots: roots.map(([key]) => key),
                upserts: aggregate.upserts.length,
                deletes: aggregate.deletes.length,
                singletonUpserts:
                  aggregate.singletonUpserts.length,
                singletonDeletes:
                  aggregate.singletonDeletes.length,
              })}`
            );
          }
        } catch (error) {
          lastError = normalizeStoreError(error);

          console.error(
            `[store] supabase-persist-failed ${JSON.stringify({
              message: lastError.message,
              code: lastError.code,
              details: lastError.details,
              roots: roots.map(([key]) => key),
            })}`
          );

          scheduleRetry();
          throw error;
        }
      }

      return currentState;
    })().finally(() => {
      flushPromise = null;

      if (dirtyRoots.size && !retryTimer) {
        scheduleFlush();
      }
    });

    return flushPromise;
  }

  function scheduleRetry() {
    if (retryTimer) return;

    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush().catch(() => {});
    }, retryMs);
    retryTimer.unref?.();
  }

  async function health() {
    assertReady();

    let remote = null;

    try {
      remote = await client.health();
    } catch (error) {
      lastError = normalizeStoreError(error);
    }

    return {
      ok: Boolean(remote?.ok) && !lastError,
      mode: "supabase-entity-cache",
      ready: readyComplete,
      dirtyRoots: [...dirtyRoots.keys()],
      pendingWrites: dirtyRoots.size,
      lastLoadedAt,
      lastPersistedAt,
      lastError,
      totalFlushes,
      totalPersistedRows,
      remote,
    };
  }

  function addActivity(
    title,
    sub,
    icon = "🎯",
    extra = {}
  ) {
    update((state) => {
      state.activity = Array.isArray(state.activity)
        ? state.activity
        : [];

      state.activity.unshift({
        id: uid("act"),
        title,
        sub,
        icon,
        time: "just now",
        createdAt: new Date().toISOString(),
        ...extra,
      });

      state.activity = state.activity.slice(0, 500);
    });
  }

  function rebuildBaseline() {
    baselineByRoot.clear();

    for (const key of Object.keys(currentState)) {
      baselineByRoot.set(
        key,
        serializeRoot(
          key,
          currentState[key]
        )
      );
    }
  }

  function assertReady() {
    if (!readyComplete) {
      const error = new Error(
        "ReachFly store is not ready. Call await store.ready() before using services."
      );
      error.code = "STORE_NOT_READY";
      throw error;
    }
  }

  return {
    filePath: legacyFilePath,
    legacyFilePath,
    ready,
    read,
    write,
    update,
    reload,
    flush,
    health,
    addActivity,
  };
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

export function mergeState(value) {
  const source =
    value && typeof value === "object" ? value : {};

  const next = {
    ...structuredClone(defaultState),
    ...source,

    settings: {
      ...defaultState.settings,
      ...(source.settings || {}),

      app: {
        ...defaultState.settings.app,
        ...(source.settings?.app || {}),
      },

      email: {
        ...defaultState.settings.email,
        ...(source.settings?.email || {}),
      },
    },

    workspaceSettings:
      source.workspaceSettings &&
      typeof source.workspaceSettings === "object"
        ? source.workspaceSettings
        : {},

    workspaceWhatsApp:
      source.workspaceWhatsApp &&
      typeof source.workspaceWhatsApp === "object"
        ? source.workspaceWhatsApp
        : {},
  };

  for (const key of DEFAULT_ARRAY_KEYS) {
    next[key] = Array.isArray(source[key])
      ? source[key]
      : [];
  }

  // Preserve additional collections introduced by newer builds.
  for (const [key, item] of Object.entries(source)) {
    if (!(key in next)) {
      next[key] = item;
    }
  }

  if (
    next.salesAssignments.length === 0 &&
    Array.isArray(source.leadAssignments) &&
    source.leadAssignments.length
  ) {
    next.salesAssignments = structuredClone(
      source.leadAssignments
    );
  }

  if (
    next.calls.length === 0 &&
    Array.isArray(source.callRecords) &&
    source.callRecords.length
  ) {
    next.calls = structuredClone(source.callRecords);
  }

  return next;
}

export function stateToDatabasePayload(stateInput) {
  const state = mergeState(stateInput);
  const entities = [];
  const singletons = [];

  for (const [rootKey, value] of Object.entries(state)) {
    const snapshot = serializeRoot(rootKey, value);

    for (const item of snapshot.entities.values()) {
      entities.push(stripFingerprint(item));
    }

    for (const item of snapshot.singletons.values()) {
      singletons.push(stripFingerprint(item));
    }
  }

  return { entities, singletons };
}

export function databaseRowsToState({
  entities = [],
  singletons = [],
} = {}) {
  const state = {};
  const grouped = new Map();
  const campaignLeads = new Map();

  for (const row of entities) {
    const collectionKey = clean(row.collection_key);
    if (!collectionKey) continue;

    if (collectionKey === "campaignLeads") {
      const campaignId = clean(
        row.campaign_id || row.data?.campaignId
      );
      if (!campaignId) continue;
      const list = campaignLeads.get(campaignId) || [];
      list.push(row);
      campaignLeads.set(campaignId, list);
      continue;
    }

    const list = grouped.get(collectionKey) || [];
    list.push(row);
    grouped.set(collectionKey, list);
  }

  for (const [collectionKey, rows] of grouped) {
    rows.sort(compareDatabaseRows);

    if (collectionKey === "campaigns") {
      state.campaigns = rows.map((row) => {
        const campaign = cloneJson(row.data) || {};
        const leads = (
          campaignLeads.get(clean(campaign.id)) || []
        )
          .sort(compareDatabaseRows)
          .map((leadRow) => cloneJson(leadRow.data));

        campaign.leads = leads;
        return campaign;
      });
      continue;
    }

    state[collectionKey] = rows.map((row) =>
      cloneJson(row.data)
    );
  }

  for (const row of singletons) {
    const key = clean(row.state_key);
    if (!key) continue;
    state[key] = cloneJson(row.data);
  }

  return mergeState(state);
}

function serializeRoot(rootKey, value) {
  const result = emptyRootSnapshot();

  if (Array.isArray(value)) {
    if (rootKey === "campaigns") {
      serializeCampaigns(value, result);
      return result;
    }

    const usedIds = new Map();

    value.forEach((item, position) => {
      const entityId = stableEntityId(
        rootKey,
        item,
        position,
        usedIds
      );
      const row = entityRow({
        collectionKey: rootKey,
        entityId,
        position,
        data: item,
      });
      result.entities.set(
        `${row.collection_key}\u0000${row.entity_id}`,
        row
      );
    });

    return result;
  }

  const row = singletonRow(rootKey, value);
  result.singletons.set(row.state_key, row);
  return result;
}

function serializeCampaigns(campaigns, result) {
  const campaignIds = new Map();

  campaigns.forEach((campaign, position) => {
    const campaignId = stableEntityId(
      "campaigns",
      campaign,
      position,
      campaignIds
    );
    const campaignData = {
      ...(cloneJson(campaign) || {}),
    };
    const leads = Array.isArray(campaignData.leads)
      ? campaignData.leads
      : [];
    delete campaignData.leads;

    const campaignRow = entityRow({
      collectionKey: "campaigns",
      entityId: campaignId,
      position,
      data: campaignData,
    });
    result.entities.set(
      `${campaignRow.collection_key}\u0000${campaignRow.entity_id}`,
      campaignRow
    );

    const leadIds = new Map();

    leads.forEach((lead, leadPosition) => {
      const leadId = stableEntityId(
        "campaignLeads",
        lead,
        leadPosition,
        leadIds
      );
      const compositeId = `${campaignId}::${leadId}`;
      const leadRow = entityRow({
        collectionKey: "campaignLeads",
        entityId: compositeId,
        position: leadPosition,
        data: lead,
        campaignId,
        leadId: clean(lead?.id) || leadId,
        workspaceId:
          lead?.workspaceId ||
          campaignData.workspaceId ||
          "",
      });
      result.entities.set(
        `${leadRow.collection_key}\u0000${leadRow.entity_id}`,
        leadRow
      );
    });
  });
}

function entityRow({
  collectionKey,
  entityId,
  position,
  data,
  campaignId = "",
  leadId = "",
  workspaceId = "",
}) {
  const payload = cloneJson(data);
  const metadata = extractMetadata(
    payload,
    {
      campaignId,
      leadId,
      workspaceId,
    }
  );
  const row = {
    collection_key: collectionKey,
    entity_id: entityId,
    position: Number(position || 0),
    workspace_id: metadata.workspaceId || null,
    campaign_id: metadata.campaignId || null,
    lead_id: metadata.leadId || null,
    user_id: metadata.userId || null,
    status: metadata.status || null,
    kind: metadata.kind || null,
    next_action_at: metadata.nextActionAt || null,
    data: payload,
    updated_at: new Date().toISOString(),
  };

  row.__fingerprint = fingerprintRow(row);
  return row;
}

function singletonRow(stateKey, data) {
  const row = {
    state_key: stateKey,
    data: cloneJson(data),
    updated_at: new Date().toISOString(),
  };
  row.__fingerprint = hashJson(row.data);
  return row;
}

function appendDiff(
  aggregate,
  previous,
  next
) {
  for (const [key, row] of next.entities) {
    const old = previous.entities.get(key);

    if (
      !old ||
      old.__fingerprint !== row.__fingerprint ||
      old.position !== row.position
    ) {
      aggregate.upserts.push(
        stripFingerprint(row)
      );
    }
  }

  for (const [key, row] of previous.entities) {
    if (!next.entities.has(key)) {
      aggregate.deletes.push({
        collection_key: row.collection_key,
        entity_id: row.entity_id,
      });
    }
  }

  for (const [key, row] of next.singletons) {
    const old = previous.singletons.get(key);

    if (
      !old ||
      old.__fingerprint !== row.__fingerprint
    ) {
      aggregate.singletonUpserts.push(
        stripFingerprint(row)
      );
    }
  }

  for (const [key] of previous.singletons) {
    if (!next.singletons.has(key)) {
      aggregate.singletonDeletes.push(key);
    }
  }
}

function createTrackedProxy(root, touchedRoots) {
  const cache = new WeakMap();

  function wrap(target, rootKey = "") {
    if (
      !target ||
      typeof target !== "object"
    ) {
      return target;
    }

    if (cache.has(target)) {
      return cache.get(target);
    }

    const proxy = new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(
          object,
          property,
          receiver
        );
        const nextRoot = rootKey ||
          (typeof property === "string"
            ? property
            : "");
        return wrap(value, nextRoot);
      },

      set(object, property, value, receiver) {
        const key = rootKey ||
          (typeof property === "string"
            ? property
            : "");
        if (key) touchedRoots.add(key);
        return Reflect.set(
          object,
          property,
          value,
          receiver
        );
      },

      deleteProperty(object, property) {
        const key = rootKey ||
          (typeof property === "string"
            ? property
            : "");
        if (key) touchedRoots.add(key);
        return Reflect.deleteProperty(
          object,
          property
        );
      },

      defineProperty(object, property, descriptor) {
        const key = rootKey ||
          (typeof property === "string"
            ? property
            : "");
        if (key) touchedRoots.add(key);
        return Reflect.defineProperty(
          object,
          property,
          descriptor
        );
      },
    });

    cache.set(target, proxy);
    return proxy;
  }

  return wrap(root);
}

function extractMetadata(value, overrides = {}) {
  const item =
    value && typeof value === "object"
      ? value
      : {};
  const lead =
    item.lead && typeof item.lead === "object"
      ? item.lead
      : {};
  const nextAction = firstClean(
    item.nextActionAt,
    item.followUpAt,
    item.callbackAt,
    item.scheduledAt,
    item.dueAt
  );

  return {
    workspaceId: firstClean(
      overrides.workspaceId,
      item.workspaceId,
      item.companyId,
      lead.workspaceId
    ),
    campaignId: firstClean(
      overrides.campaignId,
      item.campaignId,
      lead.campaignId
    ),
    leadId: firstClean(
      overrides.leadId,
      item.leadId,
      lead.id,
      item.contactId
    ),
    userId: firstClean(
      item.userId,
      item.assignedTo,
      item.callerId,
      item.memberId,
      item.createdBy,
      item.ownerId
    ),
    status: firstClean(
      item.status,
      item.queueStatus,
      item.state
    ).slice(0, 120),
    kind: firstClean(
      item.kind,
      item.type,
      item.auditKind,
      item.campaignType
    ).slice(0, 120),
    nextActionAt: normalizeDate(nextAction),
  };
}

function stableEntityId(
  collectionKey,
  item,
  position,
  usedIds
) {
  const candidate = firstClean(
    item?.id,
    item?.callId,
    item?.assignmentId,
    item?.reportId,
    item?.jobId,
    item?.runId,
    item?.channelId,
    item?.messageId,
    item?.taskId,
    item?.inviteId,
    item?.workspaceId,
    item?.userId,
    item?.memberId,
    item?.email
  );
  const base = candidate ||
    `row_${hashJson(item).slice(0, 24)}`;
  const count = usedIds.get(base) || 0;
  usedIds.set(base, count + 1);

  return count === 0
    ? base
    : `${base}__${count}_${position}`;
}

function databaseRowsFingerprint(row) {
  return fingerprintRow({
    ...row,
    data: row.data,
  });
}

function fingerprintRow(row) {
  return hashJson({
    collection_key: row.collection_key,
    entity_id: row.entity_id,
    position: row.position,
    workspace_id: row.workspace_id,
    campaign_id: row.campaign_id,
    lead_id: row.lead_id,
    user_id: row.user_id,
    status: row.status,
    kind: row.kind,
    next_action_at: row.next_action_at,
    data: row.data,
  });
}

function hashJson(value) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(sortForHash(value));
}

function sortForHash(value) {
  if (Array.isArray(value)) {
    return value.map(sortForHash);
  }

  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          sortForHash(value[key]),
        ])
    );
  }

  return value;
}

function loadLegacyFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
    return mergeState(parsed);
  } catch (error) {
    const wrapped = new Error(
      `The legacy ReachFly store at ${filePath} could not be parsed.`
    );
    wrapped.code = "LEGACY_STORE_INVALID";
    wrapped.cause = error;
    throw wrapped;
  }
}

function emptyRootSnapshot() {
  return {
    entities: new Map(),
    singletons: new Map(),
  };
}

function compareDatabaseRows(left, right) {
  const position =
    Number(left.position || 0) -
    Number(right.position || 0);
  if (position) return position;
  return String(left.entity_id || "").localeCompare(
    String(right.entity_id || "")
  );
}

function stripFingerprint(row) {
  const { __fingerprint, ...cleanRow } = row;
  return cleanRow;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeDate(value) {
  const text = clean(value);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function firstClean(...values) {
  for (const value of values) {
    const next = clean(value);
    if (next) return next;
  }
  return "";
}

function clean(value) {
  return String(value ?? "").trim();
}

function envFlag(value, fallback = false) {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "on"].includes(text);
}

function clampInteger(value, min, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(
    min,
    Math.min(max, Math.round(parsed))
  );
}

function normalizeStoreError(error) {
  if (!error) return null;

  return {
    message: error?.message || String(error),
    code: error?.code || "",
    statusCode: error?.statusCode || 0,
    details: error?.details || null,
  };
}
