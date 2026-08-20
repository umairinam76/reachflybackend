import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const CONNECT_WAIT_MS = 2_500;
const STATUS_RECONCILE_MS = 2_500;
const AUTO_RESTART_DELAY_MS = 4_000;
const MAX_AUTO_RESTARTS = 4;

export function createWhatsAppService({
  store,
  workspaceService,
  dataDir = process.cwd(),
}) {
  const clients = new Map();
  const authRoot = path.resolve(
    process.env.WHATSAPP_WEBJS_AUTH_DIR || path.join(dataDir, "whatsapp-webjs")
  );

  function workspaceContext(user) {
    if (!user?.id) {
      const error = new Error("Authentication is required for WhatsApp.");
      error.statusCode = 401;
      throw error;
    }

    const context = workspaceService?.getContext?.(user) || {};
    const workspaceId = String(
      context.workspaceId || user.workspaceId || user.companyId || user.id || ""
    ).trim();

    if (!workspaceId) {
      const error = new Error("Workspace could not be resolved for WhatsApp.");
      error.statusCode = 400;
      throw error;
    }

    return { ...context, workspaceId };
  }

  function clientIdFor(workspaceId) {
    return String(workspaceId || "workspace")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80);
  }

  function sessionPathFor(workspaceId) {
    return path.join(authRoot, `session-${clientIdFor(workspaceId)}`);
  }

  function emptyStatus() {
    return {
      ready: false,
      authenticated: false,
      qr: "",
      qrFormat: "raw",
      phone: "",
      clientState: "",
      status: "disconnected",
      mode: "whatsapp-web.js",
      message: "WhatsApp is not linked yet.",
      checkedAt: new Date().toISOString(),
      updatedAt: "",
    };
  }

  function getStoredStatus(workspaceId) {
    const state = store.read();
    const current = state.whatsappSessions?.[workspaceId];

    if (!current) return emptyStatus();

    return {
      ready: Boolean(current.ready),
      authenticated: Boolean(current.authenticated || current.ready),
      qr: String(current.qr || ""),
      qrFormat: String(current.qrFormat || "raw"),
      phone: String(current.phone || ""),
      clientState: String(current.clientState || ""),
      status: String(current.status || ""),
      mode: "whatsapp-web.js",
      message: String(current.message || ""),
      checkedAt: current.checkedAt || current.updatedAt || "",
      updatedAt: current.updatedAt || "",
      qrGeneratedAt: current.qrGeneratedAt || "",
    };
  }

  function saveStatus(workspaceId, patch = {}) {
    const now = new Date().toISOString();
    let saved = null;

    store.update((state) => {
      state.whatsappSessions = state.whatsappSessions || {};
      const previous = state.whatsappSessions[workspaceId] || {};
      const next = {
        ...previous,
        workspaceId,
        mode: "whatsapp-web.js",
        qrFormat: "raw",
        ...patch,
        checkedAt: now,
        updatedAt: now,
      };

      state.whatsappSessions[workspaceId] = next;

      // Compatibility mirror for older ReachFly widgets.
      state.whatsapp = {
        ready: Boolean(next.ready),
        authenticated: Boolean(next.authenticated || next.ready),
        qr: String(next.qr || ""),
        qrFormat: "raw",
        phone: String(next.phone || ""),
        clientState: String(next.clientState || ""),
        status: String(next.status || ""),
        mode: "whatsapp-web.js",
        message: String(next.message || ""),
        checkedAt: now,
      };

      saved = { ...next };
    });

    return saved;
  }

  async function loadLibrary() {
    try {
      const module = await import("whatsapp-web.js");
      const Client = module.Client || module.default?.Client;
      const LocalAuth = module.LocalAuth || module.default?.LocalAuth;

      if (!Client || !LocalAuth) {
        throw new Error("whatsapp-web.js Client or LocalAuth export is unavailable.");
      }

      return { Client, LocalAuth };
    } catch (error) {
      const wrapped = new Error(
        `WhatsApp Web is not installed correctly. Run npm install in the API directory. ${error.message}`
      );
      wrapped.statusCode = 503;
      throw wrapped;
    }
  }

  function resolveBrowserExecutable() {
    const configured = String(process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
    if (configured && existsSync(configured)) return configured;

    const candidates = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];

    return candidates.find((candidate) => existsSync(candidate)) || "";
  }

  function readableBrowserLaunchError(error) {
    const raw = String(error?.message || error || "Unknown browser launch error");
    const missingLibrary = raw.match(
      /error while loading shared libraries:\s*([^:\s]+):/i
    )?.[1];

    if (missingLibrary) {
      return [
        `WhatsApp browser cannot start because the server is missing ${missingLibrary}.`,
        "Install the Chrome/Chromium runtime libraries on the EC2 instance and restart reachfly-api.",
      ].join(" ");
    }

    if (/failed to launch the browser process/i.test(raw)) {
      return [
        "WhatsApp browser could not start on this server.",
        "Install Chrome/Chromium with its Linux runtime dependencies or set PUPPETEER_EXECUTABLE_PATH to a working browser executable.",
      ].join(" ");
    }

    return `WhatsApp browser could not start: ${raw}`;
  }

  async function reconcileClientState(workspaceId, entry) {
    if (!entry?.client) return getStoredStatus(workspaceId);

    let stateName = "";
    try {
      stateName = String((await entry.client.getState?.()) || "").toUpperCase();
    } catch {}

    const phone = String(entry.client.info?.wid?.user || "").trim();
    const connected =
      stateName === "CONNECTED" ||
      Boolean(phone) ||
      entry.authenticated === true;

    if (connected) {
      entry.authenticated = true;
      entry.restartAttempts = 0;
      return saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
        phone,
        clientState: stateName || (phone ? "CONNECTED" : "AUTHENTICATED"),
        status: "connected",
        message: phone
          ? `WhatsApp ${phone} is connected.`
          : "WhatsApp is connected. Finishing account sync…",
      });
    }

    const current = getStoredStatus(workspaceId);
    if (stateName && stateName !== current.clientState) {
      return saveStatus(workspaceId, {
        clientState: stateName,
        status: normalizeClientState(stateName),
        message:
          current.authenticated && !current.ready
            ? "WhatsApp is authenticated. Finishing the saved browser session…"
            : current.message,
      });
    }

    return current;
  }

  function normalizeClientState(value) {
    const stateName = String(value || "").trim().toUpperCase();
    if (stateName === "CONNECTED" || stateName === "AUTHENTICATED") return "connected";
    if (stateName === "QR" || stateName === "STARTING" || stateName === "OPENING") return "linking";
    if (stateName === "AUTH_FAILURE" || stateName === "ERROR") return "error";
    if (stateName === "DISCONNECTED") return "disconnected";
    return stateName ? stateName.toLowerCase() : "";
  }

  async function destroyEntry(workspaceId, { logout = false } = {}) {
    const entry = clients.get(workspaceId);
    if (!entry?.client) {
      clients.delete(workspaceId);
      return;
    }

    if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);

    try {
      if (logout) await entry.client.logout();
    } catch {}

    try {
      await entry.client.destroy();
    } catch {}

    clients.delete(workspaceId);
  }

  function scheduleAutomaticRestore(user, workspaceId, entry) {
    if (!entry || entry.intentionalLogout) return;
    if ((entry.restartAttempts || 0) >= MAX_AUTO_RESTARTS) return;
    if (entry.restartTimer) return;

    entry.restartAttempts = Number(entry.restartAttempts || 0) + 1;
    entry.restartTimer = setTimeout(async () => {
      entry.restartTimer = null;
      try {
        await destroyEntry(workspaceId);
        await ensureClient(user);
      } catch (error) {
        saveStatus(workspaceId, {
          ready: false,
          clientState: "RESTORE_ERROR",
          status: "error",
          message: readableBrowserLaunchError(error),
        });
      }
    }, AUTO_RESTART_DELAY_MS);
    entry.restartTimer.unref?.();
  }

  async function ensureClient(user, { forceNew = false } = {}) {
    const context = workspaceContext(user);
    const workspaceId = context.workspaceId;

    if (forceNew) {
      await destroyEntry(workspaceId);
    }

    const existing = clients.get(workspaceId);
    if (existing?.client) return existing;

    await fs.mkdir(authRoot, { recursive: true });

    const { Client, LocalAuth } = await loadLibrary();
    const clientId = clientIdFor(workspaceId);

    const puppeteerOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
      ],
    };

    const browserExecutable = resolveBrowserExecutable();
    if (browserExecutable) puppeteerOptions.executablePath = browserExecutable;

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId,
        dataPath: authRoot,
      }),
      puppeteer: puppeteerOptions,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      qrMaxRetries: 12,
      authTimeoutMs: 60_000,
    });

    const entry = {
      workspaceId,
      clientId,
      user,
      client,
      initPromise: null,
      reconcileTimer: null,
      restartTimer: null,
      restartAttempts: 0,
      sawQr: false,
      authenticated: false,
      intentionalLogout: false,
    };

    clients.set(workspaceId, entry);

    client.on("qr", (qrText) => {
      entry.sawQr = true;
      entry.authenticated = false;
      saveStatus(workspaceId, {
        ready: false,
        authenticated: false,
        qr: String(qrText || ""),
        qrFormat: "raw",
        qrGeneratedAt: new Date().toISOString(),
        phone: "",
        clientState: "QR",
        status: "linking",
        message: "Scan this QR from WhatsApp → Linked devices → Link a device.",
      });
    });

    client.on("authenticated", () => {
      entry.authenticated = true;
      entry.restartAttempts = 0;
      saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
        clientState: "AUTHENTICATED",
        status: "connected",
        message: "WhatsApp connected. Finishing account sync…",
      });
    });

    client.on("ready", () => {
      entry.authenticated = true;
      entry.restartAttempts = 0;
      const phone = String(client.info?.wid?.user || "").trim();
      saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
        phone,
        clientState: "CONNECTED",
        status: "connected",
        message: phone
          ? `WhatsApp ${phone} is connected.`
          : "WhatsApp is connected and ready.",
      });
    });

    client.on("loading_screen", (percent, message) => {
      const current = getStoredStatus(workspaceId);
      if (current.ready || current.authenticated) return;
      saveStatus(workspaceId, {
        clientState: "OPENING",
        status: "linking",
        message: `Opening WhatsApp Web${Number.isFinite(Number(percent)) ? ` · ${percent}%` : ""}${message ? ` · ${message}` : ""}`,
      });
    });

    client.on("change_state", (stateName) => {
      const normalized = String(stateName || "").toUpperCase();
      if (normalized === "CONNECTED") {
        void reconcileClientState(workspaceId, entry);
        return;
      }

      const current = getStoredStatus(workspaceId);
      saveStatus(workspaceId, {
        clientState: normalized,
        status: normalizeClientState(normalized),
        message:
          current.authenticated || entry.authenticated
            ? "WhatsApp is connected. Finishing session sync…"
            : current.message,
      });
    });

    client.on("remote_session_saved", () => {
      entry.authenticated = true;
      saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
        clientState: "CONNECTED",
        status: "connected",
        message: "WhatsApp session saved. Restoring account details…",
      });
      void reconcileClientState(workspaceId, entry);
    });

    client.on("auth_failure", (message) => {
      entry.authenticated = false;
      saveStatus(workspaceId, {
        ready: false,
        authenticated: false,
        qr: "",
        phone: "",
        clientState: "AUTH_FAILURE",
        status: "error",
        message: `WhatsApp authentication failed: ${String(message || "Unknown error")}`,
      });
    });

    client.on("disconnected", (reason) => {
      entry.authenticated = false;
      saveStatus(workspaceId, {
        ready: false,
        authenticated: false,
        qr: "",
        phone: "",
        clientState: "DISCONNECTED",
        status: "disconnected",
        message: `WhatsApp connection was interrupted${reason ? `: ${reason}` : "."} Restoring the saved session automatically…`,
      });
      scheduleAutomaticRestore(user, workspaceId, entry);
    });

    entry.reconcileTimer = setInterval(() => {
      void reconcileClientState(workspaceId, entry).catch(() => {});
    }, STATUS_RECONCILE_MS);
    entry.reconcileTimer.unref?.();

    entry.initPromise = client.initialize().catch((error) => {
      const message = readableBrowserLaunchError(error);
      saveStatus(workspaceId, {
        ready: false,
        authenticated: false,
        qr: "",
        phone: "",
        clientState: "ERROR",
        status: "error",
        message,
      });
      if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
      clients.delete(workspaceId);
      const wrapped = new Error(message);
      wrapped.cause = error;
      throw wrapped;
    });

    entry.initPromise.catch(() => {});
    return entry;
  }

  async function waitForQrOrReady(workspaceId, timeoutMs = CONNECT_WAIT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const entry = clients.get(workspaceId);
      if (entry) await reconcileClientState(workspaceId, entry).catch(() => {});
      const current = getStoredStatus(workspaceId);

      if (
        current.ready ||
        current.authenticated ||
        current.qr ||
        current.status === "error"
      ) {
        return current;
      }

      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    return getStoredStatus(workspaceId);
  }

  async function status(user) {
    const { workspaceId } = workspaceContext(user);
    let current = getStoredStatus(workspaceId);
    const entry = clients.get(workspaceId);

    if (entry) {
      current = await reconcileClientState(workspaceId, entry).catch(() => current);
    } else {
      let hasSavedSession = false;
      try {
        hasSavedSession = existsSync(sessionPathFor(workspaceId));
      } catch {}

      // Rehydrate LocalAuth after an API restart without asking the user to scan again.
      if (current.ready || current.authenticated || current.phone || hasSavedSession) {
        void ensureClient(user).catch(() => {});
        current = {
          ...current,
          message: current.ready
            ? "WhatsApp is connected. Restoring the saved browser session…"
            : "Checking the saved WhatsApp session…",
        };
      }
    }

    return {
      ...current,
      checkedAt: new Date().toISOString(),
    };
  }

  async function connect(user) {
    const { workspaceId } = workspaceContext(user);
    let current = getStoredStatus(workspaceId);

    if (current.ready || current.authenticated) {
      const entry = await ensureClient(user).catch(() => null);
      if (entry) {
        current = await reconcileClientState(workspaceId, entry).catch(() => current);
      }
      return { ...current, checkedAt: new Date().toISOString() };
    }

    const hasInvalidSavedSession =
      current.clientState === "AUTH_FAILURE" ||
      /authentication failed/i.test(current.message || "");

    if (hasInvalidSavedSession) {
      await destroyEntry(workspaceId);
      try {
        await fs.rm(sessionPathFor(workspaceId), { recursive: true, force: true });
      } catch {}
    }

    saveStatus(workspaceId, {
      ready: false,
      authenticated: false,
      qr: "",
      phone: "",
      clientState: "STARTING",
      status: "linking",
      message: "Starting WhatsApp Web…",
    });

    await ensureClient(user);
    current = await waitForQrOrReady(workspaceId, CONNECT_WAIT_MS);

    if (!current.ready && !current.authenticated && !current.qr && current.status !== "error") {
      current = saveStatus(workspaceId, {
        clientState: current.clientState || "STARTING",
        status: "linking",
        message: "WhatsApp Web is starting. The QR will appear here automatically.",
      });
    }

    return {
      ...current,
      checkedAt: new Date().toISOString(),
    };
  }

  async function logout(user) {
    const { workspaceId } = workspaceContext(user);
    const entry = clients.get(workspaceId);
    if (entry) entry.intentionalLogout = true;

    await destroyEntry(workspaceId, { logout: true });

    try {
      await fs.rm(sessionPathFor(workspaceId), { recursive: true, force: true });
    } catch {}

    const next = saveStatus(workspaceId, {
      ready: false,
      authenticated: false,
      qr: "",
      phone: "",
      clientState: "DISCONNECTED",
      status: "disconnected",
      message: "WhatsApp session disconnected.",
    });

    return {
      ...next,
      checkedAt: new Date().toISOString(),
    };
  }

  return { status, connect, logout };
}
