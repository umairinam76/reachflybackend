import "./env.js";
import crypto from "node:crypto";
import { createStore } from "./store.js";

const DATA_DIR =
  process.env.DATA_DIR ||
  new URL("../../../../data", import.meta.url).pathname;
const WORKSPACE_ID =
  process.env.CODESYNC_WORKSPACE_ID ||
  "codesync-labs-workspace";
const WORKSPACE_NAME = "Codesync Labs";
const OWNER_EMAIL = normalizeEmail(
  process.env.CODESYNC_OWNER_EMAIL ||
    "owner@codesynclabs.com"
);
const OWNER_PASSWORD = String(
  process.env.CODESYNC_OWNER_PASSWORD || ""
);
const OWNER_NAME =
  process.env.CODESYNC_OWNER_NAME ||
  "Codesync Labs Owner";

if (OWNER_PASSWORD.length < 12) {
  throw new Error(
    "Set CODESYNC_OWNER_PASSWORD to a strong password of at least 12 characters before running this script."
  );
}

const store = createStore({ dataDir: DATA_DIR });
await store.ready();
const now = new Date().toISOString();
let ownerId = "";

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
  draft.companies = Array.isArray(draft.companies)
    ? draft.companies
    : [];
  draft.workspaceSettings =
    draft.workspaceSettings || {};

  let workspace = draft.workspaces.find(
    (item) => item.id === WORKSPACE_ID
  );
  if (!workspace) {
    workspace = {
      id: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
      slug: "codesync-labs",
      name: WORKSPACE_NAME,
      companyName: WORKSPACE_NAME,
      accountType: "company",
      workspaceType: "company",
      status: "active",
      active: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    draft.workspaces.push(workspace);
  } else {
    Object.assign(workspace, {
      workspaceId: WORKSPACE_ID,
      slug: "codesync-labs",
      name: WORKSPACE_NAME,
      companyName: WORKSPACE_NAME,
      accountType: "company",
      workspaceType: "company",
      status: "active",
      active: true,
      isActive: true,
      updatedAt: now,
    });
  }

  let company = draft.companies.find(
    (item) =>
      item.id === WORKSPACE_ID ||
      item.workspaceId === WORKSPACE_ID
  );
  if (!company) {
    company = {
      id: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
      slug: "codesync-labs",
      name: WORKSPACE_NAME,
      companyName: WORKSPACE_NAME,
      status: "active",
      active: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    draft.companies.push(company);
  }

  let owner = draft.users.find(
    (item) => normalizeEmail(item.email) === OWNER_EMAIL
  );
  if (
    owner?.workspaceId &&
    owner.workspaceId !== WORKSPACE_ID
  ) {
    throw new Error(
      `${OWNER_EMAIL} already belongs to another ReachFly workspace.`
    );
  }

  if (!owner) {
    owner = {
      id: crypto.randomUUID(),
      createdAt: now,
    };
    draft.users.push(owner);
  }
  ownerId = owner.id;

  const passwordHash = hashPassword(OWNER_PASSWORD);
  Object.assign(owner, {
    name: OWNER_NAME,
    fullName: OWNER_NAME,
    email: OWNER_EMAIL,
    passwordHash,
    passwordDigest: passwordHash,
    role: "owner",
    workspaceRole: "owner",
    permissions: ["*"],
    accountType: "company",
    workspaceType: "company",
    workspaceId: WORKSPACE_ID,
    accountId: WORKSPACE_ID,
    companyId: WORKSPACE_ID,
    companyName: WORKSPACE_NAME,
    workspaceName: WORKSPACE_NAME,
    jobTitle: "Owner",
    active: true,
    isActive: true,
    status: "active",
    emailVerified: true,
    emailVerifiedAt: owner.emailVerifiedAt || now,
    updatedAt: now,
  });
  delete owner.password;

  let membership = draft.workspaceMembers.find(
    (item) =>
      item.workspaceId === WORKSPACE_ID &&
      item.userId === owner.id
  );
  if (!membership) {
    membership = {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      userId: owner.id,
      createdAt: now,
    };
    draft.workspaceMembers.push(membership);
  }
  Object.assign(membership, {
    role: "owner",
    permissions: ["*"],
    active: true,
    status: "active",
    updatedAt: now,
  });

  workspace.ownerId = owner.id;
  workspace.ownerUserId = owner.id;
  workspace.updatedAt = now;
  company.ownerId = owner.id;
  company.ownerUserId = owner.id;
  company.updatedAt = now;

  draft.workspaceSettings[WORKSPACE_ID] = {
    ...(draft.workspaceSettings[WORKSPACE_ID] || {}),
    app: {
      ...(draft.workspaceSettings[WORKSPACE_ID]?.app || {}),
      workspaceName: WORKSPACE_NAME,
      brandTagline:
        "Natural AI-led outreach, qualification and meeting booking",
      complianceMode: true,
    },
    features: {
      ...(draft.workspaceSettings[WORKSPACE_ID]?.features || {}),
      telnyxVoiceAgent: true,
    },
  };

  // Explicitly keep the feature disabled for AH Growth even when the global
  // TELNYX_AI_AGENT_ENABLED flag is true.
  draft.workspaceSettings["ah-growth-workspace"] = {
    ...(draft.workspaceSettings["ah-growth-workspace"] || {}),
    features: {
      ...(draft.workspaceSettings["ah-growth-workspace"]?.features || {}),
      telnyxVoiceAgent: false,
    },
  };
});

console.log("Codesync Labs workspace is ready.");
console.log(`Workspace ID: ${WORKSPACE_ID}`);
console.log(`Owner user ID: ${ownerId}`);
console.log(`Login email: ${OWNER_EMAIL}`);
console.log(
  "The password was read from CODESYNC_OWNER_PASSWORD and was not printed."
);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(
  password,
  salt = crypto.randomBytes(16).toString("hex")
) {
  const hash = crypto
    .scryptSync(String(password), salt, 64)
    .toString("hex");
  return `${salt}:${hash}`;
}
