import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const CONNECT_WAIT_MS = 30_000;
const RECONCILE_INTERVAL_MS = 1_000;

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

  function getStoredStatus(workspaceId) {
    const state = store.read();
    const current = state.whatsappSessions?.[workspaceId];

    if (current) {
      return {
        ready: Boolean(current.ready),
        authenticated: Boolean(current.authenticated || current.ready),
        qr: String(current.qr || ""),
        phone: String(current.phone || ""),
        clientState: String(current.clientState || ""),
        mode: "whatsapp-web.js",
        message: String(current.message || ""),
        checkedAt: current.checkedAt || current.updatedAt || "",
        updatedAt: current.updatedAt || "",
      };
    }

    return {
      ready: false,
      authenticated: false,
      qr: "",
      phone: "",
      clientState: "",
      mode: "whatsapp-web.js",
      message: "WhatsApp is not linked yet.",
      checkedAt: new Date().toISOString(),
      updatedAt: "",
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
        ...patch,
        checkedAt: now,
        updatedAt: now,
      };

      state.whatsappSessions[workspaceId] = next;

      // Compatibility mirror for older widgets. Workspace-scoped status above is
      // still the source of truth.
      state.whatsapp = {
        ready: Boolean(next.ready),
        authenticated: Boolean(next.authenticated || next.ready),
        qr: String(next.qr || ""),
        phone: String(next.phone || ""),
        clientState: String(next.clientState || ""),
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

  async function createQrDataUrl(qrText) {
    const qrcode = await import("qrcode");
    const qrApi = qrcode.default || qrcode;
    return qrApi.toDataURL(String(qrText || ""), {
      margin: 2,
      width: 360,
      errorCorrectionLevel: "M",
      color: {
        dark: "#111827",
        light: "#ffffff",
      },
    });
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
        "Install the Chrome/Chromium runtime libraries on the EC2 instance, then restart reachfly-api.",
        "For Amazon Linux 2023 use: sudo dnf install -y atk at-spi2-atk cups-libs gtk3 libXcomposite libXcursor libXdamage libXrandr libXext libXi libXtst pango alsa-lib libdrm mesa-libgbm nss libXScrnSaver libxkbcommon",
      ].join(" ");
    }

    if (/failed to launch the browser process/i.test(raw)) {
      return [
        "WhatsApp browser could not start on this server.",
        "Install Chrome/Chromium and its Linux runtime dependencies, or set PUPPETEER_EXECUTABLE_PATH to a working browser executable, then restart reachfly-api.",
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
    const connected = stateName === "CONNECTED" || Boolean(phone);

    if (connected) {
      return saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
        phone,
        clientState: stateName || "CONNECTED",
        message: phone
          ? `WhatsApp ${phone} is connected.`
          : "WhatsApp is connected and ready.",
      });
    }

    const current = getStoredStatus(workspaceId);
    if (stateName && stateName !== current.clientState) {
      return saveStatus(workspaceId, {
        clientState: stateName,
        message:
          current.authenticated && !current.ready
            ? "WhatsApp is authenticated. Finishing the browser session…"
            : current.message,
      });
    }

    return current;
  }

  async function destroyEntry(workspaceId, { logout = false } = {}) {
    const entry = clients.get(workspaceId);
    if (!entry?.client) {
      clients.delete(workspaceId);
      return;
    }

    try {
      if (logout) await entry.client.logout();
    } catch {}

    try {
      await entry.client.destroy();
    } catch {}

    if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
    clients.delete(workspaceId);
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
        "--disable-software-rasterizer",
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
      qrMaxRetries: 8,
    });

    const entry = {
      workspaceId,
      clientId,
      client,
      initPromise: null,
      reconcileTimer: null,
      sawQr: false,
      authenticated: false,
    };

    clients.set(workspaceId, entry);

    client.on("qr", async (qrText) => {
      entry.sawQr = true;
      try {
        const qr = await createQrDataUrl(qrText);
        saveStatus(workspaceId, {
          ready: false,
          authenticated: false,
          qr,
          phone: "",
          clientState: "QR",
          message: "Scan this QR from WhatsApp → Linked devices → Link a device.",
        });
      } catch (error) {
        saveStatus(workspaceId, {
          ready: false,
          authenticated: false,
          qr: "",
          message: `QR generation failed: ${error.message}`,
        });
      }
    });

    client.on("authenticated", () => {
      entry.authenticated = true;
      // A successful scan means the phone has accepted this browser as a linked
      // device. Mark it connected immediately so the ReachFly UI does not remain
      // stuck on the QR screen while whatsapp-web.js finishes its ready event.
      saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
        clientState: "AUTHENTICATED",
        message: "WhatsApp connected. Finishing message sync…",
      });
    });

    client.on("ready", () => {
      const phone = String(client.info?.wid?.user || "").trim();
      saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
        phone,
        clientState: "CONNECTED",
        message: phone
          ? `WhatsApp ${phone} is connected.`
          : "WhatsApp is connected and ready.",
      });
    });

    client.on("change_state", (stateName) => {
      const normalized = String(stateName || "").toUpperCase();
      if (normalized === "CONNECTED") {
        void reconcileClientState(workspaceId, entry);
      } else {
        const current = getStoredStatus(workspaceId);
        saveStatus(workspaceId, {
          clientState: normalized,
          message:
            current.authenticated || entry.authenticated
              ? "WhatsApp is connected. Finishing session sync…"
              : current.message,
        });
      }
    });

    client.on("remote_session_saved", () => {
      saveStatus(workspaceId, {
        ready: true,
        authenticated: true,
        qr: "",
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
        message: `WhatsApp disconnected${reason ? `: ${reason}` : "."}`,
      });
      if (entry.reconcileTimer) clearInterval(entry.reconcileTimer);
      clients.delete(workspaceId);
    });

    entry.reconcileTimer = setInterval(() => {
      void reconcileClientState(workspaceId, entry).catch(() => {});
    }, 5_000);
    entry.reconcileTimer.unref?.();

    entry.initPromise = client.initialize().catch((error) => {
      const message = readableBrowserLaunchError(error);
      saveStatus(workspaceId, {
        ready: false,
        authenticated: false,
        qr: "",
        phone: "",
        clientState: "ERROR",
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
        /failed|could not start|missing .*library/i.test(current.message)
      ) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
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

      // Rehydrate any LocalAuth session after an API restart. This also covers
      // the case where the phone shows the device as linked but the API restarted
      // before ReachFly persisted a final ready event.
      if (current.ready || current.authenticated || current.phone || hasSavedSession) {
        void ensureClient(user).catch(() => {});
        current = {
          ...current,
          message: current.ready
            ? "Restoring the saved WhatsApp session…"
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

    saveStatus(workspaceId, {
      ready: false,
      authenticated: false,
      qr: "",
      phone: "",
      clientState: "STARTING",
      message: "Starting WhatsApp Web…",
    });

    let entry = await ensureClient(user);
    current = await waitForQrOrReady(workspaceId, CONNECT_WAIT_MS);

    // If an old LocalAuth session became invalid, remove only that workspace's
    // session and start a clean QR flow. This fixes the common case where the
    // phone no longer trusts the saved browser and whatsapp-web.js otherwise
    // loops without showing a new QR.
    if (
      !current.ready &&
      !current.authenticated &&
      !current.qr &&
      (current.clientState === "AUTH_FAILURE" || /authentication failed/i.test(current.message))
    ) {
      await destroyEntry(workspaceId);
      try {
        await fs.rm(sessionPathFor(workspaceId), { recursive: true, force: true });
      } catch {}
      saveStatus(workspaceId, {
        ready: false,
        authenticated: false,
        qr: "",
        phone: "",
        clientState: "RESTARTING",
        message: "The previous WhatsApp session expired. Generating a fresh QR…",
      });
      entry = await ensureClient(user);
      current = await waitForQrOrReady(workspaceId, 20_000);
    }

    // A Chromium process can occasionally start without ever reaching the QR
    // event. If there is no authenticated LocalAuth session, retry once with a
    // fresh browser instance instead of leaving the UI blank indefinitely.
    if (!current.ready && !current.authenticated && !current.qr && !entry.authenticated) {
      saveStatus(workspaceId, {
        clientState: "RESTARTING",
        message: "WhatsApp took too long to generate a QR. Restarting the browser once…",
      });
      entry = await ensureClient(user, { forceNew: true });
      current = await waitForQrOrReady(workspaceId, 20_000);
    }

    if (!current.ready && !current.authenticated && !current.qr) {
      current = saveStatus(workspaceId, {
        clientState: current.clientState || "WAITING",
        message:
          current.message && !/starting|restarting/i.test(current.message)
            ? current.message
            : "WhatsApp Web started but no QR was returned yet. Try Start linking again in a few seconds.",
      });
    }

    return {
      ...current,
      checkedAt: new Date().toISOString(),
    };
  }

  async function logout(user) {
    const { workspaceId } = workspaceContext(user);
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
      message: "WhatsApp session disconnected.",
    });

    return {
      ...next,
      checkedAt: new Date().toISOString(),
    };
  }

  return { status, connect, logout };
}
