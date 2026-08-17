import "./env.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, "../../../data");

const WORKSPACE_ID = "ah-growth-workspace";

// IMPORTANT: Keep the existing caller IDs. Today's lead assignments are already
// attached to these IDs, so changing identity fields in-place gives callers a
// fresh login without moving or regenerating leads.
const CALLERS = [
  {
    id: "f9baff56-b63a-4dd4-a3d6-f6327c3a547a",
    slot: 1,
    name: "Umer Tahir Khan",
    email: "umarktahir@gmail.com",
    resourceType: "local",
    jobTitle: "Local Cold Caller",
  },
  {
    id: "f996c155-b3d6-4271-a702-488ec60f9eb9",
    slot: 2,
    name: "Muhammad Nouman Gulzar",
    email: "noumangulzar23@gmail.com",
    resourceType: "local",
    jobTitle: "Local Cold Caller",
  },
  {
    id: "fca9c12f-0491-4873-9c66-ec018375361f",
    slot: 3,
    name: "Noor Ul Huda",
    email: "nurr.hoda@gmail.com",
    resourceType: "international",
    jobTitle: "International Cold Caller",
  },
  {
    id: "f6d77055-0a54-467f-99a9-3130d3dd2089",
    slot: 4,
    name: "Adan Kashif",
    email: "adankashif969@gmail.com",
    resourceType: "international",
    jobTitle: "International Cold Caller",
  },
  {
    id: "6524085b-95b4-4944-a063-e08725ed5716",
    slot: 5,
    name: "Abbas Ikram",
    email: "abbasikram1818@gmail.com",
    resourceType: "international",
    jobTitle: "International Cold Caller",
  },
];

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function temporaryPassword() {
  return crypto.randomBytes(12).toString("base64url") + "!A9";
}

function splitPersonName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

const store = createStore({ dataDir: DATA_DIR });
await store.ready();

const state = store.read();
const existingEmails = new Map(
  (state.users || []).map((user) => [String(user.email || "").toLowerCase(), user.id])
);

for (const caller of CALLERS) {
  const ownerId = existingEmails.get(caller.email.toLowerCase());
  if (ownerId && ownerId !== caller.id) {
    throw new Error(
      `Cannot seed ${caller.email}: that email is already attached to another ReachFly user.`
    );
  }
}

const credentials = [];
const now = new Date().toISOString();

store.update((draft) => {
  draft.users = Array.isArray(draft.users) ? draft.users : [];
  draft.workspaceMembers = Array.isArray(draft.workspaceMembers)
    ? draft.workspaceMembers
    : [];
  draft.salesAssignments = Array.isArray(draft.salesAssignments)
    ? draft.salesAssignments
    : [];
  draft.campaigns = Array.isArray(draft.campaigns) ? draft.campaigns : [];

  const callerById = new Map(CALLERS.map((caller) => [caller.id, caller]));

  for (const caller of CALLERS) {
    const user = draft.users.find((item) => item.id === caller.id);
    if (!user) {
      throw new Error(`Existing AH Growth caller slot ${caller.slot} (${caller.id}) was not found.`);
    }

    const password = temporaryPassword();
    const digest = hashPassword(password);
    const { firstName, lastName } = splitPersonName(caller.name);

    user.name = caller.name;
    user.fullName = caller.name;
    user.firstName = firstName;
    user.lastName = lastName;
    user.email = caller.email.toLowerCase();
    user.role = "caller";
    user.workspaceRole = "caller";
    user.workspaceId = WORKSPACE_ID;
    user.accountId = WORKSPACE_ID;
    user.workspaceName = "AH Growth";
    user.companyName = "AH Growth";
    user.companyId = user.companyId || "ah-growth-company";
    user.department = "Sales";
    user.jobTitle = caller.jobTitle;
    user.resourceType = caller.resourceType;
    user.callerResourceType = caller.resourceType;
    user.dailyLeadLimit = 100;
    user.leadAssignmentLimit = 100;
    user.active = true;
    user.isActive = true;
    user.status = "active";
    user.emailVerified = true;
    user.emailVerifiedAt = user.emailVerifiedAt || now;
    user.passwordHash = digest;
    user.passwordDigest = digest;
    user.updatedAt = now;

    const member = draft.workspaceMembers.find(
      (item) => item.userId === caller.id && item.workspaceId === WORKSPACE_ID
    );
    if (member) {
      member.name = caller.name;
      member.email = caller.email.toLowerCase();
      member.role = "caller";
      member.status = "active";
      member.updatedAt = now;
    }

    credentials.push({
      slot: caller.slot,
      name: caller.name,
      email: caller.email.toLowerCase(),
      temporaryPassword: password,
    });
  }

  // Keep current lead ownership exactly where it is, but refresh visible names.
  for (const assignment of draft.salesAssignments) {
    const caller = callerById.get(assignment.assignedTo || assignment.userId);
    if (!caller) continue;
    assignment.assignedToName = caller.name;
    assignment.updatedAt = now;
  }

  for (const campaign of draft.campaigns) {
    for (const lead of campaign.leads || []) {
      const caller = callerById.get(lead.assignedTo || lead.assigneeId);
      if (!caller) continue;
      lead.assignedToName = caller.name;
      lead.updatedAt = now;
    }
  }
});

await store.flush();

const credentialsPath = path.resolve(
  process.cwd(),
  "ahgrowth-caller-credentials.txt"
);

const lines = [
  `AH Growth caller credentials generated ${now}`,
  `Workspace: ${WORKSPACE_ID}`,
  "",
  ...credentials.flatMap((item) => [
    `Caller slot ${item.slot}: ${item.name}`,
    `Email: ${item.email}`,
    `Temporary password: ${item.temporaryPassword}`,
    "",
  ]),
  "Require each caller to change the temporary password after first login.",
];

fs.writeFileSync(credentialsPath, lines.join("\n"), { mode: 0o600 });
fs.chmodSync(credentialsPath, 0o600);

console.log(
  JSON.stringify(
    {
      ok: true,
      workspaceId: WORKSPACE_ID,
      updatedCallerCount: CALLERS.length,
      credentialsFile: credentialsPath,
      note: "Caller IDs and lead ownership were preserved. No leads were regenerated or reassigned.",
    },
    null,
    2
  )
);
