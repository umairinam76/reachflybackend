import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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

  function getStoredStatus(workspaceId) {
    const state = store.read();
    const current = state.whatsappSessions?.[workspaceId];

    if (current) {
      return {
        ready: Boolean(current.ready),
        qr: String(current.qr || ""),
        phone: String(current.phone || ""),
        mode: "whatsapp-web.js",
        message: String(current.message || ""),
        checkedAt: current.checkedAt || current.updatedAt || "",
        updatedAt: current.updatedAt || "",
      };
    }

    return {
      ready: false,
      qr: "",
      phone: "",
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

      // Backward-compatible mirror for older dashboard widgets that still read
      // state.whatsapp directly. The workspace-scoped object above remains the
      // source of truth.
      state.whatsapp = {
        ready: Boolean(next.ready),
        qr: String(next.qr || ""),
        phone: String(next.phone || ""),
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
      margin: 1,
      width: 320,
      errorCorrectionLevel: "M",
    });
  }

  function resolveBrowserExecutable() {
    const configured = String(process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
    if (configured) return configured;

    // Prefer a system browser when one is installed. Installing Chrome/Chromium
    // through the operating-system package manager also installs its shared
    // libraries, which is more reliable on EC2 than Puppeteer's downloaded
    // Chromium binary.
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
    const missingLibrary = raw.match(/error while loading shared libraries:\s*([^:\s]+):/i)?.[1];

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

  async function ensureClient(user) {
    const context = workspaceContext(user);
    const workspaceId = context.workspaceId;
    const existing = clients.get(workspaceId);

    if (existing?.client) {
      return existing;
    }

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
      ],
    };

    const browserExecutable = resolveBrowserExecutable();
    if (browserExecutable) {
      puppeteerOptions.executablePath = browserExecutable;
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId,
        dataPath: authRoot,
      }),
      puppeteer: puppeteerOptions,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
    });

    const entry = {
      workspaceId,
      clientId,
      client,
      initPromise: null,
    };

    clients.set(workspaceId, entry);

    client.on("qr", async (qrText) => {
      try {
        const qr = await createQrDataUrl(qrText);
        saveStatus(workspaceId, {
          ready: false,
          qr,
          phone: "",
          message:
            "Scan this QR from WhatsApp → Linked devices → Link a device.",
        });
      } catch (error) {
        saveStatus(workspaceId, {
          ready: false,
          qr: "",
          message: `QR generation failed: ${error.message}`,
        });
      }
    });

    client.on("authenticated", () => {
      saveStatus(workspaceId, {
        ready: false,
        qr: "",
        message: "WhatsApp authenticated. Finishing the connection…",
      });
    });

    client.on("ready", () => {
      const phone = String(client.info?.wid?.user || "").trim();
      saveStatus(workspaceId, {
        ready: true,
        qr: "",
        phone,
        message: phone
          ? `WhatsApp ${phone} is connected.`
          : "WhatsApp is connected and ready.",
      });
    });

    client.on("auth_failure", (message) => {
      saveStatus(workspaceId, {
        ready: false,
        qr: "",
        phone: "",
        message: `WhatsApp authentication failed: ${String(message || "Unknown error")}`,
      });
    });

    client.on("disconnected", (reason) => {
      saveStatus(workspaceId, {
        ready: false,
        qr: "",
        phone: "",
        message: `WhatsApp disconnected${reason ? `: ${reason}` : "."}`,
      });
      clients.delete(workspaceId);
    });

    entry.initPromise = client
      .initialize()
      .catch((error) => {
        const message = readableBrowserLaunchError(error);
        saveStatus(workspaceId, {
          ready: false,
          qr: "",
          phone: "",
          message,
        });
        clients.delete(workspaceId);

        const wrapped = new Error(message);
        wrapped.cause = error;
        throw wrapped;
      });

    // Do not await initialize here. A fresh WhatsApp login intentionally waits
    // for the user to scan a QR code. The UI polls status while the client runs.
    entry.initPromise.catch(() => {});

    return entry;
  }

  async function waitForQrOrReady(workspaceId, timeoutMs = 20_000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const current = getStoredStatus(workspaceId);
      if (current.ready || current.qr || /failed|could not start/i.test(current.message)) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    return getStoredStatus(workspaceId);
  }

  async function status(user) {
    const { workspaceId } = workspaceContext(user);
    let current = getStoredStatus(workspaceId);

    // Rehydrate LocalAuth after an API restart when this workspace had a
    // previously authenticated session. This is intentionally background work
    // so the status endpoint remains responsive.
    if (!clients.has(workspaceId) && (current.ready || current.phone)) {
      void ensureClient(user).catch(() => {});
      current = {
        ...current,
        message: current.ready
          ? "Restoring the saved WhatsApp session…"
          : current.message,
      };
    }

    return {
      ...current,
      checkedAt: new Date().toISOString(),
    };
  }

  async function connect(user) {
    const { workspaceId } = workspaceContext(user);

    saveStatus(workspaceId, {
      ready: false,
      qr: "",
      phone: "",
      message: "Starting WhatsApp Web…",
    });

    await ensureClient(user);
    return waitForQrOrReady(workspaceId);
  }

  async function logout(user) {
    const { workspaceId } = workspaceContext(user);
    const entry = clients.get(workspaceId);

    if (entry?.client) {
      try {
        await entry.client.logout();
      } catch {}

      try {
        await entry.client.destroy();
      } catch {}
    }

    clients.delete(workspaceId);

    const sessionPath = path.join(
      authRoot,
      `session-${clientIdFor(workspaceId)}`
    );

    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch {}

    const next = saveStatus(workspaceId, {
      ready: false,
      qr: "",
      phone: "",
      message: "WhatsApp session disconnected.",
    });

    return {
      ...next,
      checkedAt: new Date().toISOString(),
    };
  }

  return { status, connect, logout };
}
