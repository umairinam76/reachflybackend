import fs from "node:fs";
import path from "node:path";

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
  internalCalls: [],

  dailyLeadRuns: [],
  notifications: [],
  inbox: [],
  activity: [],

  // Temporary compatibility collections for older builds.
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

export function createStore({ dataDir = "./data" } = {}) {
  const absoluteDir = path.resolve(process.cwd(), dataDir);
  const filePath = path.join(absoluteDir, "reachfly-store.json");

  fs.mkdirSync(absoluteDir, { recursive: true });

  if (!fs.existsSync(filePath)) {
    writeJson(filePath, structuredClone(defaultState));
  }

  /*
   * Production performance note:
   * Older ReachFly builds synchronously read + parsed the complete JSON store
   * on every store.read() and again before every store.update(). Once daily
   * queues and audit reports became large, a simple caller-queue refresh or
   * outcome update could spend seconds repeatedly parsing the same file.
   *
   * Keep one authoritative in-process state for this Node process and preserve
   * the existing atomic synchronous write on every mutation. This removes the
   * repeated disk read/parse cost without weakening mutation durability.
   */
  let currentState = loadJson(filePath);

  function read() {
    return currentState;
  }

  function write(next) {
    currentState = mergeState(next);
    writeJson(filePath, currentState);
    return currentState;
  }

  function update(mutator) {
    const next = mutator(currentState) || currentState;

    if (next !== currentState) {
      currentState = mergeState(next);
    }

    writeJson(filePath, currentState);
    return currentState;
  }

  function reload() {
    currentState = loadJson(filePath);
    return currentState;
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

  return {
    filePath,
    read,
    write,
    update,
    reload,
    addActivity,
  };
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function mergeState(value) {
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

  for (const [key, fallback] of Object.entries(defaultState)) {
    if (Array.isArray(fallback)) {
      next[key] = Array.isArray(source[key])
        ? source[key]
        : [];
    }
  }

  // One-way migration from older collection names.
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

function loadJson(filePath) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    return mergeState(parsed);
  } catch (error) {
    console.error(
      "[store] read failed; restoring defaults",
      error
    );

    const restored =
      structuredClone(defaultState);

    writeJson(filePath, restored);
    return restored;
  }
}

function writeJson(filePath, data) {
  const temporaryPath = `${filePath}.tmp`;

  /*
   * Compact JSON is intentional in production. Pretty-printing a large state
   * file roughly doubles/triples the number of bytes written for every call
   * outcome, task update and queue mutation.
   */
  const pretty =
    String(
      process.env.STORE_PRETTY_JSON || ""
    ).trim().toLowerCase() === "true";

  fs.writeFileSync(
    temporaryPath,
    pretty
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data),
    "utf8"
  );

  fs.renameSync(
    temporaryPath,
    filePath
  );
}
