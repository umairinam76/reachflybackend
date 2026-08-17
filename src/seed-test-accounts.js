import "./env.js";

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_PRODUCTION =
  String(process.env.NODE_ENV || "")
    .trim()
    .toLowerCase() === "production";

if (
  IS_PRODUCTION &&
  !process.argv.includes("--force-production")
) {
  console.error(
    "[seed] Refusing to seed test accounts in production. " +
      "Use --force-production only when you intentionally want test users there."
  );

  process.exit(1);
}

/*
  Resolve DATA_DIR in the same project context as the API.

  apps/api/src/seed-test-accounts.js
  ../../.. points to the project root.
*/
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

const configuredDataDir = String(
  process.env.DATA_DIR || "./data"
).trim();

const DATA_DIR = path.isAbsolute(configuredDataDir)
  ? configuredDataDir
  : path.resolve(PROJECT_ROOT, configuredDataDir);

const WORKSPACE_ID =
  String(
    process.env.REACHFLY_TEST_WORKSPACE_ID ||
      "reachfly-demo-workspace"
  ).trim();

const WORKSPACE_NAME =
  String(
    process.env.REACHFLY_TEST_WORKSPACE_NAME ||
      "ReachFly Demo Company"
  ).trim();

const PASSWORD = String(
  process.env.REACHFLY_TEST_PASSWORD ||
    "ReachFlyTest!2026"
);

const ACCOUNTS = [
  {
    role: "owner",
    roleLabel: "Owner",
    name: "ReachFly Test Owner",
    email: "owner@reachfly.test",
    permissions: ["*"],
  },
  {
    role: "admin",
    roleLabel: "Admin",
    name: "ReachFly Test Admin",
    email: "admin@reachfly.test",
    permissions: [
      "manage_team",
      "assign_leads",
      "view_team_calls",
      "manage_dialers",
      "manage_senders",
      "manage_report_templates",
      "view_audits",
      "create_audits",
      "override_contact_lock",
      "view_all_performance",
      "team_chat",
      "manage_tasks",
    ],
  },
  {
    role: "manager",
    roleLabel: "Manager",
    name: "ReachFly Test Manager",
    email: "manager@reachfly.test",
    permissions: [
      "manage_team",
      "assign_leads",
      "view_team_calls",
      "manage_dialers",
      "manage_senders",
      "view_audits",
      "create_audits",
      "view_team_performance",
      "team_chat",
      "manage_tasks",
    ],
  },
  {
    role: "caller",
    roleLabel: "Caller",
    name: "ReachFly Test Caller One",
    email: "caller1@reachfly.test",
    permissions: [
      "view_assigned_leads",
      "make_calls",
      "view_audits",
      "create_audits",
      "team_chat",
      "view_tasks",
      "update_tasks",
    ],
  },
  {
    role: "caller",
    roleLabel: "Caller",
    name: "ReachFly Test Caller Two",
    email: "caller2@reachfly.test",
    permissions: [
      "view_assigned_leads",
      "make_calls",
      "view_audits",
      "create_audits",
      "team_chat",
      "view_tasks",
      "update_tasks",
    ],
  },
];

const store = createStore({
  dataDir: DATA_DIR,
});
await store.ready();

if (
  typeof store?.read !== "function" ||
  typeof store?.update !== "function"
) {
  throw new Error(
    "The ReachFly store does not expose read() and update(). " +
      "Confirm this file is inside apps/api/src and imports ./store.js."
  );
}

const now = new Date().toISOString();
const seededAccounts = [];

store.update((draft) => {
  draft.users = Array.isArray(draft.users)
    ? draft.users
    : [];

  draft.workspaces = Array.isArray(draft.workspaces)
    ? draft.workspaces
    : [];

  draft.workspaceMembers = Array.isArray(
    draft.workspaceMembers
  )
    ? draft.workspaceMembers
    : [];

  draft.auditReportTemplates = Array.isArray(
    draft.auditReportTemplates
  )
    ? draft.auditReportTemplates
    : [];

  let workspace = draft.workspaces.find(
    (item) => item.id === WORKSPACE_ID
  );

  if (!workspace) {
    workspace = {
      id: WORKSPACE_ID,
      name: WORKSPACE_NAME,
      companyName: WORKSPACE_NAME,
      accountType: "company",
      ownerId: "",
      ownerUserId: "",
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    draft.workspaces.push(workspace);
  } else {
    Object.assign(workspace, {
      name: WORKSPACE_NAME,
      companyName: WORKSPACE_NAME,
      accountType: "company",
      active: true,
      updatedAt: now,
    });
  }

  for (const definition of ACCOUNTS) {
    const email = normalizeEmail(definition.email);

    let user = draft.users.find(
      (item) =>
        normalizeEmail(item.email) === email
    );

    /*
      A new password hash is generated every time the seed runs.

      This ensures existing test accounts are reset to the
      password shown below.
    */
    const passwordHash = hashPassword(PASSWORD);

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        createdAt: now,
      };

      draft.users.push(user);
    }

    Object.assign(user, {
      name: definition.name,
      email,
      passwordHash,

      accountType: "company",
      companyName: WORKSPACE_NAME,

      role: definition.roleLabel,
      workspaceRole: definition.role,
      workspaceId: WORKSPACE_ID,

      permissions: definition.permissions,

      phone: user.phone || "",
      active: true,
      updatedAt: now,
    });

    if (definition.role === "owner") {
      workspace.ownerId = user.id;
      workspace.ownerUserId = user.id;
    }

    let membership =
      draft.workspaceMembers.find(
        (item) =>
          item.workspaceId === WORKSPACE_ID &&
          item.userId === user.id
      );

    if (!membership) {
      membership = {
        id: crypto.randomUUID(),
        workspaceId: WORKSPACE_ID,
        userId: user.id,
        createdAt: now,
      };

      draft.workspaceMembers.push(membership);
    }

    Object.assign(membership, {
      role: definition.role,
      permissions: definition.permissions,
      active: true,
      invitedBy:
        workspace.ownerId ||
        "development-seed",
      updatedAt: now,
    });

    seededAccounts.push({
      role: definition.roleLabel,
      email,
      password: PASSWORD,
      id: user.id,
    });
  }

  let template =
    draft.auditReportTemplates.find(
      (item) =>
        item.workspaceId === WORKSPACE_ID
    );

  if (!template) {
    template = {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      createdAt: now,
    };

    draft.auditReportTemplates.push(template);
  }

  Object.assign(template, {
    name: "Default ReachFly audit format",

    miniInstructions:
      "Keep the existing Mini Audit structure exactly: confidentiality header, Business Snapshot, Issues Found, and internal-use footer. Do not add or remove sections.",

    fullInstructions:
      "Use the approved internal full-audit structure with competitor analysis, performance review, ranking review, SEO and trust findings, opportunity analysis, and internal pitch language.",

    claudeSystemPrompt:
      "Use only verified public evidence. Preserve the workspace-approved report structure and dynamic workspace branding.",

    miniEnabled: true,
    competitorEnabled: true,
    fullEnabled: true,

    updatedBy:
      workspace.ownerId ||
      "development-seed",

    updatedAt: now,
  });
});

const state = store.read();

const verification = seededAccounts.map(
  (account) => {
    const user = (state.users || []).find(
      (item) =>
        normalizeEmail(item.email) ===
        account.email
    );

    return {
      role: account.role,
      email: account.email,
      password: account.password,

      stored: Boolean(user),

      passwordVerified: Boolean(
        user &&
          verifyPassword(
            account.password,
            user.passwordHash
          )
      ),

      workspaceRole:
        user?.workspaceRole || "",

      workspaceId:
        user?.workspaceId || "",
    };
  }
);

const failed = verification.filter(
  (item) =>
    !item.stored ||
    !item.passwordVerified ||
    item.workspaceId !== WORKSPACE_ID
);

console.log("");
console.log(
  `[seed] Data directory: ${DATA_DIR}`
);

console.log(
  `[seed] Workspace: ${WORKSPACE_NAME} (${WORKSPACE_ID})`
);

console.table(verification);

if (failed.length) {
  console.error(
    "[seed] Verification failed for one or more accounts:",
    failed
  );

  process.exitCode = 1;
} else {
  console.log(
    "[seed] All test accounts were created or updated."
  );

  console.log(
    "[seed] Password verification passed for every account."
  );

  console.log(
    "[seed] Fully stop and restart npm run dev before logging in."
  );
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function hashPassword(
  password,
  salt = crypto
    .randomBytes(16)
    .toString("hex")
) {
  const hash = crypto
    .scryptSync(
      String(password),
      salt,
      64
    )
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(
  password,
  stored
) {
  if (
    !stored ||
    !String(stored).includes(":")
  ) {
    return false;
  }

  const [salt, originalHash] =
    String(stored).split(":");

  const currentHash = crypto
    .scryptSync(
      String(password),
      salt,
      64
    )
    .toString("hex");

  const current = Buffer.from(
    currentHash,
    "hex"
  );

  const original = Buffer.from(
    originalHash,
    "hex"
  );

  return (
    current.length === original.length &&
    crypto.timingSafeEqual(
      current,
      original
    )
  );
}