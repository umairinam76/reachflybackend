import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

const PROVIDERS = new Set([
  "google_sheets",
  "hubspot",
  "airtable",
  "json_api",
]);

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2_000;

export function createExternalLeadConnectorsService({ store, workspaceService }) {
  function requireContext(user) {
    if (!user?.id) throw httpError(401, "Authentication is required.");
    const ctx = workspaceService?.getContext?.(user) || {};
    const workspaceId = clean(
      ctx.workspaceId || user.workspaceId || user.companyId || user.id
    );
    if (!workspaceId) throw httpError(400, "Workspace could not be resolved.");
    return { ...ctx, workspaceId };
  }

  function ensureState(state) {
    if (!Array.isArray(state.externalLeadSources)) state.externalLeadSources = [];
  }

  function list(user) {
    const { workspaceId } = requireContext(user);
    const state = store.read();
    ensureState(state);
    return state.externalLeadSources
      .filter((item) => item.workspaceId === workspaceId)
      .map(publicConnection)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  async function create(user, input = {}) {
    const { workspaceId } = requireContext(user);
    const provider = normalizeProvider(input.provider);
    const prepared = prepareConnectionInput(provider, input);

    // Validate the external source before storing it. A connection only appears
    // as connected when ReachFly has successfully read real lead data from it.
    const previewRows = await fetchRowsForProvider(
      { provider, config: prepared.config, secrets: prepared.secrets },
      { limit: 5 }
    );

    const now = new Date().toISOString();
    const id = `extsrc_${crypto.randomUUID()}`;
    const encryptedSecrets = Object.keys(prepared.secrets).length
      ? encryptJson(prepared.secrets)
      : null;

    const record = {
      id,
      workspaceId,
      provider,
      name: clean(input.name) || providerLabel(provider),
      config: prepared.config,
      encryptedSecrets,
      status: "connected",
      lastImportedAt: "",
      lastImportCount: 0,
      lastError: "",
      createdAt: now,
      updatedAt: now,
    };

    store.update((state) => {
      ensureState(state);
      state.externalLeadSources.push(record);
    });

    return {
      connection: publicConnection(record),
      preview: previewRows.slice(0, 5),
    };
  }

  async function importLeads(user, connectionId, input = {}) {
    const { workspaceId } = requireContext(user);
    const state = store.read();
    ensureState(state);
    const connection = state.externalLeadSources.find(
      (item) => item.id === clean(connectionId) && item.workspaceId === workspaceId
    );
    if (!connection) throw httpError(404, "External lead source was not found.");

    const secrets = connection.encryptedSecrets
      ? decryptJson(connection.encryptedSecrets)
      : {};
    const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

    try {
      const rows = await fetchRowsForProvider(
        {
          provider: connection.provider,
          config: connection.config || {},
          secrets,
        },
        { limit }
      );

      const now = new Date().toISOString();
      store.update((draft) => {
        ensureState(draft);
        const target = draft.externalLeadSources.find(
          (item) => item.id === connection.id && item.workspaceId === workspaceId
        );
        if (!target) return;
        target.status = "connected";
        target.lastImportedAt = now;
        target.lastImportCount = rows.length;
        target.lastError = "";
        target.updatedAt = now;
      });

      return {
        connection: publicConnection({
          ...connection,
          status: "connected",
          lastImportedAt: now,
          lastImportCount: rows.length,
          lastError: "",
          updatedAt: now,
        }),
        records: rows,
        count: rows.length,
      };
    } catch (error) {
      const message = safeMessage(error);
      store.update((draft) => {
        ensureState(draft);
        const target = draft.externalLeadSources.find(
          (item) => item.id === connection.id && item.workspaceId === workspaceId
        );
        if (!target) return;
        target.status = "attention";
        target.lastError = message;
        target.updatedAt = new Date().toISOString();
      });
      throw error;
    }
  }

  function remove(user, connectionId) {
    const { workspaceId } = requireContext(user);
    let removed = false;
    store.update((state) => {
      ensureState(state);
      const before = state.externalLeadSources.length;
      state.externalLeadSources = state.externalLeadSources.filter(
        (item) => !(item.id === clean(connectionId) && item.workspaceId === workspaceId)
      );
      removed = state.externalLeadSources.length !== before;
    });
    if (!removed) throw httpError(404, "External lead source was not found.");
    return { ok: true };
  }

  return { list, create, importLeads, remove };
}

function prepareConnectionInput(provider, input) {
  if (provider === "google_sheets") {
    const url = clean(input.url || input.sheetUrl);
    if (!url) throw httpError(422, "Paste a Google Sheets sharing URL.");
    return { config: { url }, secrets: {} };
  }

  if (provider === "hubspot") {
    const accessToken = clean(input.accessToken || input.token);
    if (!accessToken) throw httpError(422, "Enter a HubSpot private app access token.");
    return { config: {}, secrets: { accessToken } };
  }

  if (provider === "airtable") {
    const accessToken = clean(input.accessToken || input.token);
    const baseId = clean(input.baseId);
    const tableName = clean(input.tableName || input.table);
    const view = clean(input.view);
    if (!accessToken || !baseId || !tableName) {
      throw httpError(422, "Enter the Airtable token, base ID, and table name.");
    }
    return {
      config: { baseId, tableName, view },
      secrets: { accessToken },
    };
  }

  const url = clean(input.url);
  const recordsPath = clean(input.recordsPath || input.path || "");
  const bearerToken = clean(input.bearerToken || input.accessToken || input.token);
  if (!url) throw httpError(422, "Enter the JSON API URL.");
  return {
    config: { url, recordsPath },
    secrets: bearerToken ? { bearerToken } : {},
  };
}

async function fetchRowsForProvider(connection, { limit }) {
  switch (connection.provider) {
    case "google_sheets":
      return fetchGoogleSheet(connection.config, limit);
    case "hubspot":
      return fetchHubSpot(connection.secrets, limit);
    case "airtable":
      return fetchAirtable(connection.config, connection.secrets, limit);
    case "json_api":
      return fetchJsonApi(connection.config, connection.secrets, limit);
    default:
      throw httpError(422, "Unsupported external lead provider.");
  }
}

async function fetchGoogleSheet(config, limit) {
  const exportUrl = googleSheetCsvUrl(config.url);
  const url = new URL(exportUrl);
  if (url.hostname !== "docs.google.com") {
    throw httpError(422, "Only Google Sheets URLs are accepted for this connector.");
  }
  const response = await fetchWithTimeout(exportUrl, {
    headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8" },
  });
  if (!response.ok) {
    throw httpError(
      response.status === 401 || response.status === 403 ? 422 : 502,
      response.status === 401 || response.status === 403
        ? "Google Sheet is not accessible. Share it with link access or publish it, then try again."
        : `Google Sheets returned HTTP ${response.status}.`
    );
  }
  const text = await response.text();
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html") || /^\s*<!doctype html|^\s*<html/i.test(text)) {
    throw httpError(
      422,
      "Google returned a sign-in page instead of sheet data. Enable link access or publish the sheet, then connect it again."
    );
  }
  const rows = parseCsv(text).slice(0, limit);
  if (!rows.length) {
    throw httpError(422, "Google Sheet did not contain any readable lead rows.");
  }
  return rows;
}

async function fetchHubSpot(secrets, limit) {
  const token = clean(secrets.accessToken);
  if (!token) throw httpError(409, "HubSpot credential is unavailable. Reconnect the source.");

  const rows = [];
  let after = "";
  const properties = [
    "firstname",
    "lastname",
    "email",
    "phone",
    "mobilephone",
    "company",
    "website",
    "city",
    "state",
    "country",
    "jobtitle",
  ].join(",");

  while (rows.length < limit) {
    const pageSize = Math.min(100, limit - rows.length);
    const url = new URL("https://api.hubapi.com/crm/v3/objects/contacts");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("properties", properties);
    if (after) url.searchParams.set("after", after);

    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw httpError(502, body?.message || `HubSpot returned HTTP ${response.status}.`);
    }

    for (const item of body?.results || []) {
      const p = item?.properties || {};
      rows.push({
        "HubSpot ID": item.id || "",
        "First name": p.firstname || "",
        "Last name": p.lastname || "",
        Email: p.email || "",
        Phone: p.phone || p.mobilephone || "",
        Company: p.company || "",
        Website: p.website || "",
        City: p.city || "",
        State: p.state || "",
        Country: p.country || "",
        "Job title": p.jobtitle || "",
      });
      if (rows.length >= limit) break;
    }

    after = clean(body?.paging?.next?.after);
    if (!after || !(body?.results || []).length) break;
  }

  return rows;
}

async function fetchAirtable(config, secrets, limit) {
  const token = clean(secrets.accessToken);
  if (!token) throw httpError(409, "Airtable credential is unavailable. Reconnect the source.");
  const baseId = clean(config.baseId);
  const tableName = clean(config.tableName);
  if (!/^app[a-zA-Z0-9]+$/.test(baseId)) throw httpError(422, "Airtable base ID is invalid.");

  const rows = [];
  let offset = "";
  while (rows.length < limit) {
    const url = new URL(
      `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`
    );
    url.searchParams.set("pageSize", String(Math.min(100, limit - rows.length)));
    if (config.view) url.searchParams.set("view", config.view);
    if (offset) url.searchParams.set("offset", offset);

    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw httpError(502, body?.error?.message || body?.error || `Airtable returned HTTP ${response.status}.`);
    }
    for (const record of body?.records || []) {
      rows.push({ "Airtable ID": record.id || "", ...(record.fields || {}) });
      if (rows.length >= limit) break;
    }
    offset = clean(body?.offset);
    if (!offset || !(body?.records || []).length) break;
  }
  return rows;
}

async function fetchJsonApi(config, secrets, limit) {
  const url = await validatePublicHttpsUrl(config.url);
  const headers = { Accept: "application/json" };
  if (secrets.bearerToken) headers.Authorization = `Bearer ${secrets.bearerToken}`;
  const response = await fetchWithTimeout(url, { headers, validateRedirects: true });
  const body = await readJson(response);
  if (!response.ok) {
    throw httpError(502, body?.message || body?.error || `External API returned HTTP ${response.status}.`);
  }
  const records = config.recordsPath ? getByPath(body, config.recordsPath) : findRecordArray(body);
  if (!Array.isArray(records)) {
    throw httpError(422, "The external API response does not contain a lead array. Set the records path, for example data.contacts.");
  }
  return records
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .slice(0, limit)
    .map((item) => flattenObject(item));
}

function publicConnection(item) {
  return {
    id: item.id,
    provider: item.provider,
    providerLabel: providerLabel(item.provider),
    name: item.name,
    config: item.config || {},
    status: item.status || "connected",
    lastImportedAt: item.lastImportedAt || "",
    lastImportCount: Number(item.lastImportCount || 0),
    lastError: item.lastError || "",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
  };
}

function providerLabel(provider) {
  return ({
    google_sheets: "Google Sheets",
    hubspot: "HubSpot",
    airtable: "Airtable",
    json_api: "JSON / REST API",
  })[provider] || provider;
}

function normalizeProvider(value) {
  const provider = clean(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (!PROVIDERS.has(provider)) throw httpError(422, "Choose a supported external lead source.");
  return provider;
}

function googleSheetCsvUrl(value) {
  const raw = clean(value);
  let url;
  try { url = new URL(raw); } catch { throw httpError(422, "Enter a valid Google Sheets URL."); }
  if (url.hostname !== "docs.google.com") throw httpError(422, "Enter a docs.google.com Google Sheets URL.");
  const match = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/i);
  if (!match?.[1]) throw httpError(422, "Google Sheets document ID could not be read from the URL.");
  const gid = url.searchParams.get("gid") || raw.match(/[?#&]gid=(\d+)/i)?.[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(match[1])}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const headers = (rows.shift() || []).map((value, index) => clean(value) || `Column ${index + 1}`);
  return rows
    .filter((values) => values.some((value) => clean(value)))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function flattenObject(input, prefix = "", output = {}, depth = 0) {
  if (depth > 3) return output;
  for (const [key, value] of Object.entries(input || {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) output[name] = "";
    else if (["string", "number", "boolean"].includes(typeof value)) output[name] = String(value);
    else if (Array.isArray(value)) output[name] = value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ");
    else if (typeof value === "object") flattenObject(value, name, output, depth + 1);
  }
  return output;
}

function findRecordArray(body) {
  if (Array.isArray(body)) return body;
  for (const key of ["records", "contacts", "leads", "items", "results", "data"]) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  if (body?.data && typeof body.data === "object") {
    for (const key of ["records", "contacts", "leads", "items", "results"]) {
      if (Array.isArray(body.data[key])) return body.data[key];
    }
  }
  return null;
}

function getByPath(value, pathValue) {
  return clean(pathValue).split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

async function validatePublicHttpsUrl(value) {
  let url;
  try { url = new URL(clean(value)); } catch { throw httpError(422, "Enter a valid HTTPS API URL."); }
  if (url.protocol !== "https:") throw httpError(422, "External API URLs must use HTTPS.");
  if (url.username || url.password) throw httpError(422, "Credentials must not be embedded in the URL.");
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) throw httpError(422, "Private network URLs are not allowed.");
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) throw httpError(422, "External API hostname could not be resolved.");
  if (addresses.some((item) => isPrivateAddress(item.address))) throw httpError(422, "Private network URLs are not allowed.");
  return url;
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) {
    const x = address.toLowerCase();
    return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80:");
  }
  return true;
}

async function fetchWithTimeout(url, options = {}) {
  const { validateRedirects = false, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    if (!validateRedirects) {
      return await fetch(url, { ...fetchOptions, redirect: "follow", signal: controller.signal });
    }

    let currentUrl = url instanceof URL ? url : new URL(String(url));
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await fetch(currentUrl, {
        ...fetchOptions,
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      currentUrl = await validatePublicHttpsUrl(new URL(location, currentUrl).toString());
    }

    throw httpError(422, "External API redirected too many times.");
  } catch (error) {
    if (error?.name === "AbortError") throw httpError(504, "External lead source timed out.");
    if (error?.statusCode) throw error;
    throw httpError(502, `External lead source could not be reached: ${safeMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function encryptJson(value) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString("base64"), tag: tag.toString("base64"), data: ciphertext.toString("base64") };
}

function decryptJson(payload) {
  try {
    const key = encryptionKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw httpError(500, "External lead source credential could not be decrypted. Reconnect the source.");
  }
}

function encryptionKey() {
  const value = clean(process.env.CONNECTION_ENCRYPTION_KEY || process.env.CREDENTIAL_ENCRYPTION_KEY);
  if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) return decoded;
  } catch {}
  throw httpError(503, "CONNECTION_ENCRYPTION_KEY must be configured before storing external source credentials.");
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
function clean(value) { return String(value ?? "").trim(); }
function safeMessage(error) { return clean(error?.message || error || "External lead source failed.").slice(0, 800); }
function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}
