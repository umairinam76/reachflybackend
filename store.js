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

  function read() {
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

      const restored = structuredClone(defaultState);
      writeJson(filePath, restored);
      return restored;
    }
  }

  function write(next) {
    const normalized = mergeState(next);
    writeJson(filePath, normalized);
    return normalized;
  }

  function update(mutator) {
    const state = read();
    const next = mutator(state) || state;
    return write(next);
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

function writeJson(filePath, data) {
  const temporaryPath = `${filePath}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryPath, filePath);
}
