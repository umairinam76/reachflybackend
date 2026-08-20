import crypto from "node:crypto";

/**
 * Durable archive for leads returned by ReachFly discovery.
 *
 * Records are stored per workspace + search run so a user can leave the page
 * while a stream is still running and later restore the latest search. The
 * All Leads view deduplicates those run records by business identity and keeps
 * the newest copy.
 */
export function createScrapedLeadsService({ store, workspaceService } = {}) {
  if (!store?.read || !store?.update) {
    throw new Error("createScrapedLeadsService requires the ReachFly store.");
  }

  function context(user) {
    const resolved = workspaceService?.getContext?.(user) || {};
    const workspaceId = clean(
      resolved.workspaceId || user?.workspaceId || user?.companyId || user?.id
    );
    if (!workspaceId) throw httpError(401, "Workspace could not be resolved.");
    return { workspaceId, userId: clean(user?.id) };
  }

  function ensureShape(draft) {
    if (!Array.isArray(draft.scrapedLeads)) draft.scrapedLeads = [];
  }

  function saveBatch(user, leads, metadata = {}) {
    const input = Array.isArray(leads) ? leads.filter(Boolean) : [];
    if (!input.length) return { saved: 0, total: countForWorkspace(user) };

    const ctx = context(user);
    const runId = clean(metadata.runId) || crypto.randomUUID();
    const now = new Date().toISOString();
    let saved = 0;

    store.update((draft) => {
      ensureShape(draft);
      const index = new Map();
      draft.scrapedLeads.forEach((record, position) => {
        if (record?.workspaceId !== ctx.workspaceId) return;
        index.set(`${clean(record.runId)}\u0000${clean(record.leadKey)}`, position);
      });

      for (const rawLead of input) {
        const key = leadIdentity(rawLead);
        if (!key) continue;
        const composite = `${runId}\u0000${key}`;
        const existingIndex = index.get(composite);
        const sourceLeadId = clean(rawLead.id);
        const recordId = stableRecordId(ctx.workspaceId, runId, key);
        const next = {
          ...sanitizeLead(rawLead),
          id: recordId,
          sourceLeadId,
          workspaceId: ctx.workspaceId,
          scrapedByUserId: ctx.userId,
          runId,
          leadKey: key,
          scrapeNiche: clean(metadata.niche),
          scrapeLocation: clean(metadata.location),
          scrapeSource: clean(metadata.source || "google-places"),
          requested: positiveInteger(metadata.requested),
          searchStatus: clean(metadata.status),
          firstScrapedAt: now,
          lastScrapedAt: now,
        };

        if (Number.isInteger(existingIndex)) {
          const previous = draft.scrapedLeads[existingIndex] || {};
          draft.scrapedLeads[existingIndex] = {
            ...previous,
            ...next,
            firstScrapedAt: previous.firstScrapedAt || now,
          };
        } else {
          draft.scrapedLeads.push(next);
          index.set(composite, draft.scrapedLeads.length - 1);
        }
        saved += 1;
      }
    });

    return { saved, runId, total: countForWorkspace(user) };
  }

  function finishRun(user, metadata = {}) {
    const ctx = context(user);
    const runId = clean(metadata.runId);
    if (!runId) return;
    const now = new Date().toISOString();
    store.update((draft) => {
      ensureShape(draft);
      for (const record of draft.scrapedLeads) {
        if (record.workspaceId !== ctx.workspaceId || record.runId !== runId) continue;
        record.searchStatus = clean(metadata.status || record.searchStatus);
        record.requested = positiveInteger(metadata.requested || record.requested);
        record.runFinishedAt = now;
      }
    });
  }

  function list(user, options = {}) {
    const ctx = context(user);
    const state = store.read();
    const allRecords = (state.scrapedLeads || [])
      .filter((record) => record?.workspaceId === ctx.workspaceId)
      .sort(byNewest);

    const latestOnly = options.latestOnly === true;
    let records = allRecords;
    let latestRunId = "";

    if (latestOnly && allRecords.length) {
      latestRunId = clean(allRecords[0]?.runId);
      records = allRecords.filter((record) => clean(record.runId) === latestRunId);
    } else if (!latestOnly) {
      const unique = new Map();
      for (const record of allRecords) {
        const key = clean(record.leadKey) || leadIdentity(record);
        if (!key || unique.has(key)) continue;
        unique.set(key, record);
      }
      records = [...unique.values()];
    }

    const query = clean(options.search).toLowerCase();
    if (query) {
      records = records.filter((lead) => searchableLeadText(lead).includes(query));
    }

    const total = records.length;
    const offset = clampInteger(options.offset, 0, 0, Math.max(0, total));
    const limit = clampInteger(options.limit, 500, 1, 5000);
    const items = records.slice(offset, offset + limit).map(publicLead);

    return {
      ok: true,
      workspaceId: ctx.workspaceId,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total,
      latestRunId: latestRunId || clean(allRecords[0]?.runId),
      items,
      leads: items,
    };
  }

  function countForWorkspace(user) {
    const ctx = context(user);
    const unique = new Set();
    for (const record of store.read().scrapedLeads || []) {
      if (record?.workspaceId !== ctx.workspaceId) continue;
      const key = clean(record.leadKey) || leadIdentity(record);
      if (key) unique.add(key);
    }
    return unique.size;
  }

  return { saveBatch, finishRun, list, countForWorkspace };
}

function publicLead(record) {
  const output = { ...record };
  delete output.leadKey;
  delete output.workspaceId;
  delete output.scrapedByUserId;
  return output;
}

function sanitizeLead(lead) {
  const output = {};
  for (const [key, value] of Object.entries(lead || {})) {
    if (key === "workspaceId" || key === "scrapedByUserId" || key === "runId") continue;
    output[key] = value;
  }
  return output;
}

function leadIdentity(lead) {
  const place = clean(lead?.placeId || lead?.place_id);
  if (place) return `place:${place.toLowerCase()}`;
  const domain = clean(lead?.domain || domainFromUrl(lead?.website));
  if (domain) return `domain:${domain.toLowerCase()}`;
  const email = clean(lead?.email).toLowerCase();
  if (email) return `email:${email}`;
  const phone = String(lead?.phone || "").replace(/\D/g, "");
  if (phone) return `phone:${phone}`;
  const name = clean(lead?.name || lead?.business).toLowerCase();
  const address = clean(lead?.address).toLowerCase();
  if (name || address) return `business:${name}|${address}`;
  return "";
}

function stableRecordId(workspaceId, runId, key) {
  return `scraped_${crypto
    .createHash("sha256")
    .update(`${workspaceId}|${runId}|${key}`)
    .digest("hex")
    .slice(0, 28)}`;
}

function domainFromUrl(value) {
  try {
    const raw = clean(value);
    if (!raw) return "";
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function searchableLeadText(lead) {
  return [
    lead?.business,
    lead?.name,
    lead?.website,
    lead?.domain,
    lead?.email,
    lead?.phone,
    lead?.address,
    lead?.city,
    lead?.state,
    lead?.category,
    lead?.scrapeNiche,
    lead?.scrapeLocation,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function byNewest(a, b) {
  return Date.parse(b?.lastScrapedAt || b?.firstScrapedAt || 0) -
    Date.parse(a?.lastScrapedAt || a?.firstScrapedAt || 0);
}

function clean(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}
