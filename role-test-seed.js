import crypto from "node:crypto";

/* ==========================================================================
   Environment configuration
   ========================================================================== */

const TEST_ACCOUNTS_ENABLED =
  process.env.NODE_ENV !== "production" &&
  envFlag("ENABLE_TEST_ACCOUNTS", false);

const DEFAULT_PASSWORD = String(
  process.env.REACHFLY_TEST_PASSWORD ||
    "ReachFlyTest!2026"
);

const DEFAULT_WORKSPACE_ID = String(
  process.env.REACHFLY_TEST_WORKSPACE_ID ||
    "ah-growth-workspace"
).trim();

const DEFAULT_WORKSPACE_NAME = String(
  process.env.REACHFLY_TEST_WORKSPACE_NAME ||
    "AH Growth"
).trim();

/**
 * Existing seeded users receive a new password hash on startup.
 *
 * Keep this true while fixing login credentials.
 * It is safe for development test accounts.
 */
const RESET_TEST_ACCOUNT_PASSWORDS = envFlag(
  "RESET_TEST_ACCOUNT_PASSWORDS",
  true
);

/**
 * Removes only old synthetic seed campaigns and records linked to them.
 *
 * It does not delete:
 * - Google Places campaigns
 * - imported campaigns
 * - real leads
 * - real call history
 * - real attendance
 */
const CLEAN_SYNTHETIC_SEED_DATA = envFlag(
  "CLEAN_SYNTHETIC_SEED_DATA",
  false
);

/* ==========================================================================
   Permissions
   ========================================================================== */

const OWNER_PERMISSIONS = ["*"];

const MANAGER_PERMISSIONS = [
  "manage_campaigns",
  "generate_leads",
  "view_all_leads",
  "assign_leads",

  "manage_team",
  "view_team_calls",
  "view_team_performance",
  "view_all_performance",

  "manage_dialers",
  "manage_senders",
  "manage_channels",

  "view_audits",
  "create_audits",
  "manage_report_templates",

  "view_attendance",
  "manage_attendance",

  "manage_workspace",
  "view_team_communication",
];

const CALLER_PERMISSIONS = [
  "view_assigned_leads",
  "update_assigned_leads",

  "make_calls",
  "log_calls",

  "view_audits",
  "create_audits",

  "view_team_communication",

  "manage_own_attendance",

  "view_own_tasks",
  "update_own_tasks",
];

/* ==========================================================================
   Accounts
   ========================================================================== */

const ROLE_DEFINITIONS = [
  {
    role: "owner",
    name: "AH Growth Owner",
    email: "owner@ahgrowth.test",
    permissions: OWNER_PERMISSIONS,
  },

  {
    role: "manager",
    name: "AH Growth Manager One",
    email: "manager1@ahgrowth.test",
    permissions: MANAGER_PERMISSIONS,
  },

  {
    role: "manager",
    name: "AH Growth Manager Two",
    email: "manager2@ahgrowth.test",
    permissions: MANAGER_PERMISSIONS,
  },

  ...Array.from(
    {
      length: 8,
    },
    (_, index) => {
      const callerNumber = index + 1;

      return {
        role: "caller",
        name: `AH Growth Caller ${callerNumber}`,
        email: `caller${callerNumber}@ahgrowth.test`,
        permissions: CALLER_PERMISSIONS,
      };
    }
  ),
];

/* ==========================================================================
   Main seed function
   ========================================================================== */

export function seedRoleTestAccounts({
  store,
} = {}) {
  if (
    !store?.read ||
    !store?.update
  ) {
    throw new Error(
      "seedRoleTestAccounts requires a store exposing read() and update()."
    );
  }

  if (!TEST_ACCOUNTS_ENABLED) {
    console.log(
      "[test-accounts] seeding disabled."
    );

    return {
      enabled: false,
      workspaceId: DEFAULT_WORKSPACE_ID,
      accounts: [],
    };
  }

  if (!DEFAULT_WORKSPACE_ID) {
    throw new Error(
      "REACHFLY_TEST_WORKSPACE_ID cannot be empty."
    );
  }

  if (
    !DEFAULT_PASSWORD ||
    DEFAULT_PASSWORD.length < 8
  ) {
    throw new Error(
      "REACHFLY_TEST_PASSWORD must contain at least 8 characters."
    );
  }

  const now = new Date().toISOString();
  const accountIds = {};

  let cleanupSummary = {
    campaigns: 0,
    assignments: 0,
    tasks: 0,
    calls: 0,
    auditReports: 0,
    auditJobs: 0,
    inboxItems: 0,
    activityItems: 0,
  };

  store.update((draft) => {
    initialiseStateCollections(draft);

    if (CLEAN_SYNTHETIC_SEED_DATA) {
      cleanupSummary =
        removeSyntheticSeedData(
          draft,
          DEFAULT_WORKSPACE_ID
        );
    }

    const workspace =
      upsertWorkspace({
        draft,
        now,
      });

    for (const definition of ROLE_DEFINITIONS) {
      const user =
        upsertUser({
          draft,
          definition,
          now,
        });

      accountIds[definition.email] =
        user.id;

      upsertWorkspaceMembership({
        draft,
        user,
        definition,
        now,
      });

      if (
        definition.role ===
        "owner"
      ) {
        workspace.ownerId =
          user.id;

        workspace.ownerUserId =
          user.id;
      }
    }

    workspace.updatedAt = now;

    seedAuditTemplate({
      draft,
      now,
      ownerId:
        accountIds[
          "owner@ahgrowth.test"
        ] || "",
    });

    seedGeneralChannel({
      draft,
      now,
      ownerId:
        accountIds[
          "owner@ahgrowth.test"
        ] || "",
    });

    seedPresenceRecords({
      draft,
      now,
      accountIds,
    });

    draft.activity.unshift({
      id: crypto.randomUUID(),

      workspaceId:
        DEFAULT_WORKSPACE_ID,

      userId:
        accountIds[
          "owner@ahgrowth.test"
        ] || "",

      type:
        "test_accounts_seeded",

      title:
        "AH Growth accounts configured",

      sub:
        "One owner, two managers, and eight callers were configured. No leads or tasks were generated by the account seed.",

      createdAt: now,
    });

    draft.activity =
      draft.activity.slice(0, 500);
  });

  const accounts =
    ROLE_DEFINITIONS.map(
      (definition) => ({
        role: definition.role,
        name: definition.name,
        email: definition.email,
        password: DEFAULT_PASSWORD,

        userId:
          accountIds[
            definition.email
          ] || "",
      })
    );

  const result = {
    enabled: true,

    workspaceId:
      DEFAULT_WORKSPACE_ID,

    workspaceName:
      DEFAULT_WORKSPACE_NAME,

    accountCount:
      accounts.length,

    ownerCount:
      accounts.filter(
        (account) =>
          account.role ===
          "owner"
      ).length,

    managerCount:
      accounts.filter(
        (account) =>
          account.role ===
          "manager"
      ).length,

    callerCount:
      accounts.filter(
        (account) =>
          account.role ===
          "caller"
      ).length,

    passwordReset:
      RESET_TEST_ACCOUNT_PASSWORDS,

    syntheticDataCleaned:
      CLEAN_SYNTHETIC_SEED_DATA,

    cleanupSummary,

    /**
     * Important:
     * This seed intentionally creates no leads.
     */
    seededLeads: 0,
    seededTasks: 0,

    accounts,
  };

  console.log(
    `[test-accounts] enabled ${JSON.stringify({
      workspaceId:
        result.workspaceId,

      workspaceName:
        result.workspaceName,

      accountCount:
        result.accountCount,

      ownerCount:
        result.ownerCount,

      managerCount:
        result.managerCount,

      callerCount:
        result.callerCount,

      passwordReset:
        result.passwordReset,

      syntheticDataCleaned:
        result.syntheticDataCleaned,

      cleanupSummary:
        result.cleanupSummary,

      seededLeads: 0,
      seededTasks: 0,

      accounts:
        accounts.map(
          ({
            password,
            ...safeAccount
          }) => safeAccount
        ),
    })}`
  );

  return result;
}

/* ==========================================================================
   Workspace
   ========================================================================== */

function upsertWorkspace({
  draft,
  now,
}) {
  let workspace =
    draft.workspaces.find(
      (item) =>
        item.id ===
        DEFAULT_WORKSPACE_ID
    );

  if (!workspace) {
    workspace = {
      id:
        DEFAULT_WORKSPACE_ID,

      slug:
        slugify(
          DEFAULT_WORKSPACE_NAME
        ),

      name:
        DEFAULT_WORKSPACE_NAME,

      workspaceName:
        DEFAULT_WORKSPACE_NAME,

      companyName:
        DEFAULT_WORKSPACE_NAME,

      companyId:
        "ah-growth-company",

      accountType:
        "company",

      workspaceType:
        "company",

      companyAccount:
        true,

      ownerId: "",
      ownerUserId: "",

      active: true,
      isActive: true,
      status: "active",
      plan: "test",

      createdAt: now,
      updatedAt: now,
    };

    draft.workspaces.push(workspace);
  } else {
    Object.assign(workspace, {
      slug:
        workspace.slug ||
        slugify(
          DEFAULT_WORKSPACE_NAME
        ),

      name:
        DEFAULT_WORKSPACE_NAME,

      workspaceName:
        DEFAULT_WORKSPACE_NAME,

      companyName:
        DEFAULT_WORKSPACE_NAME,

      companyId:
        workspace.companyId ||
        "ah-growth-company",

      accountType:
        "company",

      workspaceType:
        "company",

      companyAccount:
        true,

      active: true,
      isActive: true,
      status: "active",

      plan:
        workspace.plan ||
        "test",

      updatedAt: now,
    });
  }

  return workspace;
}

/* ==========================================================================
   Users
   ========================================================================== */

function upsertUser({
  draft,
  definition,
  now,
}) {
  const normalizedEmail =
    normalizeEmail(
      definition.email
    );

  let user =
    draft.users.find(
      (item) =>
        normalizeEmail(
          item.email
        ) ===
        normalizedEmail
    );

  const nameParts =
    splitName(
      definition.name
    );

  if (!user) {
    user = {
      id:
        crypto.randomUUID(),

      name:
        definition.name,

      fullName:
        definition.name,

      firstName:
        nameParts.firstName,

      lastName:
        nameParts.lastName,

      email:
        normalizedEmail,

      passwordHash:
        hashPassword(
          DEFAULT_PASSWORD
        ),

      accountType:
        "company",

      workspaceType:
        "company",

      companyAccount:
        true,

      companyName:
        DEFAULT_WORKSPACE_NAME,

      workspaceName:
        DEFAULT_WORKSPACE_NAME,

      companyId:
        "ah-growth-company",

      workspaceId:
        DEFAULT_WORKSPACE_ID,

      role:
        definition.role,

      workspaceRole:
        definition.role,

      permissions: [
        ...definition.permissions,
      ],

      phone: "",
      phoneNumber: "",

      avatarUrl: "",
      photoUrl: "",
      profileImage: "",

      availabilityStatus:
        "offline",

      availability:
        "offline",

      availabilityMessage: "",

      connectionStatus:
        "offline",

      emailVerified: true,

      active: true,
      isActive: true,

      createdAt: now,
      updatedAt: now,
    };

    draft.users.push(user);
  } else {
    const updates = {
      name:
        definition.name,

      fullName:
        definition.name,

      firstName:
        nameParts.firstName,

      lastName:
        nameParts.lastName,

      email:
        normalizedEmail,

      accountType:
        "company",

      workspaceType:
        "company",

      companyAccount:
        true,

      companyName:
        DEFAULT_WORKSPACE_NAME,

      workspaceName:
        DEFAULT_WORKSPACE_NAME,

      companyId:
        user.companyId ||
        "ah-growth-company",

      workspaceId:
        DEFAULT_WORKSPACE_ID,

      role:
        definition.role,

      workspaceRole:
        definition.role,

      permissions: [
        ...definition.permissions,
      ],

      emailVerified: true,

      active: true,
      isActive: true,

      updatedAt: now,
    };

    /**
     * Reset only the password.
     *
     * Existing avatar, profile, phone, availability and personal
     * preferences are intentionally preserved.
     */
    if (
      RESET_TEST_ACCOUNT_PASSWORDS
    ) {
      updates.passwordHash =
        hashPassword(
          DEFAULT_PASSWORD
        );
    }

    Object.assign(
      user,
      updates
    );
  }

  return user;
}

/* ==========================================================================
   Workspace membership
   ========================================================================== */

function upsertWorkspaceMembership({
  draft,
  user,
  definition,
  now,
}) {
  let membership =
    draft.workspaceMembers.find(
      (item) =>
        item.workspaceId ===
          DEFAULT_WORKSPACE_ID &&
        item.userId ===
          user.id
    );

  if (!membership) {
    membership = {
      id:
        crypto.randomUUID(),

      workspaceId:
        DEFAULT_WORKSPACE_ID,

      userId:
        user.id,

      email:
        user.email,

      name:
        user.name,

      role:
        definition.role,

      workspaceRole:
        definition.role,

      permissions: [
        ...definition.permissions,
      ],

      active: true,
      isActive: true,
      status: "active",

      invitedBy: "system",
      joinedAt: now,

      createdAt: now,
      updatedAt: now,
    };

    draft.workspaceMembers.push(
      membership
    );
  } else {
    Object.assign(membership, {
      email:
        user.email,

      name:
        user.name,

      role:
        definition.role,

      workspaceRole:
        definition.role,

      permissions: [
        ...definition.permissions,
      ],

      active: true,
      isActive: true,
      status: "active",

      joinedAt:
        membership.joinedAt ||
        now,

      updatedAt: now,
    });
  }

  return membership;
}

/* ==========================================================================
   Synthetic data cleanup
   ========================================================================== */

/**
 * Removes only fake campaigns created by older seed scripts.
 *
 * Real campaigns are preserved, including sources such as:
 * - google-places
 * - google_places
 * - places
 * - external-import
 * - automatic-google-places
 * - manually created campaigns
 */
function removeSyntheticSeedData(
  draft,
  workspaceId
) {
  const syntheticCampaigns =
    draft.campaigns.filter(
      (campaign) =>
        campaign.workspaceId ===
          workspaceId &&
        isSyntheticCampaign(
          campaign
        )
    );

  const syntheticCampaignIds =
    new Set(
      syntheticCampaigns.map(
        (campaign) =>
          campaign.id
      )
    );

  const syntheticLeadIds =
    new Set();

  for (const campaign of syntheticCampaigns) {
    for (const lead of campaign.leads || []) {
      if (lead?.id) {
        syntheticLeadIds.add(
          lead.id
        );
      }
    }
  }

  const summary = {
    campaigns:
      syntheticCampaigns.length,

    assignments:
      countMatching(
        draft.salesAssignments,
        (assignment) =>
          syntheticCampaignIds.has(
            assignment.campaignId
          ) ||
          syntheticLeadIds.has(
            assignment.leadId
          ) ||
          assignment.source ===
            "test-seed"
      ),

    tasks:
      countMatching(
        draft.teamTasks,
        (task) =>
          syntheticCampaignIds.has(
            task.campaignId
          ) ||
          syntheticLeadIds.has(
            task.leadId
          ) ||
          task.source ===
            "test-seed"
      ),

    calls:
      countMatching(
        draft.calls,
        (call) =>
          syntheticCampaignIds.has(
            call.campaignId
          ) ||
          syntheticLeadIds.has(
            call.leadId
          ) ||
          call.source ===
            "test-seed"
      ),

    auditReports:
      countMatching(
        draft.auditReports,
        (report) =>
          syntheticCampaignIds.has(
            report.campaignId
          ) ||
          syntheticLeadIds.has(
            report.leadId
          ) ||
          report.source ===
            "test-seed"
      ),

    auditJobs:
      countMatching(
        draft.auditJobs,
        (job) =>
          syntheticCampaignIds.has(
            job.campaignId
          ) ||
          job.source ===
            "test-seed"
      ),

    inboxItems:
      countMatching(
        draft.inbox,
        (item) =>
          syntheticCampaignIds.has(
            item.campaignId
          ) ||
          syntheticLeadIds.has(
            item.leadId
          ) ||
          item.source ===
            "test-seed"
      ),

    activityItems:
      countMatching(
        draft.activity,
        (item) =>
          syntheticCampaignIds.has(
            item.campaignId
          ) ||
          syntheticLeadIds.has(
            item.leadId
          ) ||
          item.source ===
            "test-seed"
      ),
  };

  draft.campaigns =
    draft.campaigns.filter(
      (campaign) =>
        !syntheticCampaignIds.has(
          campaign.id
        )
    );

  draft.salesAssignments =
    draft.salesAssignments.filter(
      (assignment) =>
        !syntheticCampaignIds.has(
          assignment.campaignId
        ) &&
        !syntheticLeadIds.has(
          assignment.leadId
        ) &&
        assignment.source !==
          "test-seed"
    );

  draft.teamTasks =
    draft.teamTasks.filter(
      (task) =>
        !syntheticCampaignIds.has(
          task.campaignId
        ) &&
        !syntheticLeadIds.has(
          task.leadId
        ) &&
        task.source !==
          "test-seed"
    );

  draft.calls =
    draft.calls.filter(
      (call) =>
        !syntheticCampaignIds.has(
          call.campaignId
        ) &&
        !syntheticLeadIds.has(
          call.leadId
        ) &&
        call.source !==
          "test-seed"
    );

  draft.auditReports =
    draft.auditReports.filter(
      (report) =>
        !syntheticCampaignIds.has(
          report.campaignId
        ) &&
        !syntheticLeadIds.has(
          report.leadId
        ) &&
        report.source !==
          "test-seed"
    );

  draft.auditJobs =
    draft.auditJobs.filter(
      (job) =>
        !syntheticCampaignIds.has(
          job.campaignId
        ) &&
        job.source !==
          "test-seed"
    );

  draft.leadAuditReports =
    draft.leadAuditReports.filter(
      (report) =>
        !syntheticCampaignIds.has(
          report.campaignId
        ) &&
        !syntheticLeadIds.has(
          report.leadId
        ) &&
        report.source !==
          "test-seed"
    );

  draft.inbox =
    draft.inbox.filter(
      (item) =>
        !syntheticCampaignIds.has(
          item.campaignId
        ) &&
        !syntheticLeadIds.has(
          item.leadId
        ) &&
        item.source !==
          "test-seed"
    );

  draft.activity =
    draft.activity.filter(
      (item) =>
        !syntheticCampaignIds.has(
          item.campaignId
        ) &&
        !syntheticLeadIds.has(
          item.leadId
        ) &&
        item.source !==
          "test-seed"
    );

  return summary;
}

function isSyntheticCampaign(
  campaign
) {
  const source =
    String(
      campaign.source ||
        ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "test-seed",
      "seed",
      "synthetic-seed",
      "demo-seed",
    ].includes(source)
  ) {
    return true;
  }

  if (
    campaign.automaticSeed ===
    true
  ) {
    return true;
  }

  if (
    campaign.seeded ===
    true
  ) {
    return true;
  }

  const name =
    String(
      campaign.name ||
        ""
    ).toLowerCase();

  return (
    name.includes(
      "ah growth daily calling queue"
    ) ||
    name.includes(
      "seed business"
    )
  );
}

/* ==========================================================================
   General communication channel
   ========================================================================== */

function seedGeneralChannel({
  draft,
  now,
  ownerId,
}) {
  const existing =
    draft.teamChannels.find(
      (channel) =>
        channel.workspaceId ===
          DEFAULT_WORKSPACE_ID &&
        (
          channel.slug ===
            "general" ||
          channel.name ===
            "General"
        )
    );

  if (existing) {
    existing.active = true;
    existing.archived = false;
    existing.updatedAt = now;

    return existing;
  }

  const channel = {
    id:
      crypto.randomUUID(),

    workspaceId:
      DEFAULT_WORKSPACE_ID,

    name: "General",
    slug: "general",

    description:
      "AH Growth company-wide communication.",

    type: "channel",
    visibility: "workspace",

    createdBy:
      ownerId ||
      "system",

    active: true,
    archived: false,

    createdAt: now,
    updatedAt: now,
  };

  draft.teamChannels.push(channel);

  return channel;
}

/* ==========================================================================
   Presence
   ========================================================================== */

function seedPresenceRecords({
  draft,
  now,
  accountIds,
}) {
  for (const definition of ROLE_DEFINITIONS) {
    const userId =
      accountIds[
        definition.email
      ];

    if (!userId) {
      continue;
    }

    const user =
      draft.users.find(
        (item) =>
          item.id ===
          userId
      );

    let presence =
      draft.teamPresence.find(
        (item) =>
          item.workspaceId ===
            DEFAULT_WORKSPACE_ID &&
          item.userId ===
            userId
      );

    const existingManualStatus =
      presence?.availabilityStatus ||
      user?.availabilityStatus ||
      "offline";

    const payload = {
      workspaceId:
        DEFAULT_WORKSPACE_ID,

      userId,

      name:
        user?.name ||
        definition.name,

      email:
        user?.email ||
        definition.email,

      role:
        definition.role,

      workspaceRole:
        definition.role,

      avatarUrl:
        user?.avatarUrl ||
        user?.photoUrl ||
        user?.profileImage ||
        "",

      photoUrl:
        user?.photoUrl ||
        user?.avatarUrl ||
        user?.profileImage ||
        "",

      profileImage:
        user?.profileImage ||
        user?.avatarUrl ||
        user?.photoUrl ||
        "",

      /**
       * Connection status is reset on backend startup.
       * Manual status such as on_break is preserved.
       */
      connectionStatus:
        "offline",

      status:
        "offline",

      availabilityStatus:
        existingManualStatus,

      availabilityMessage:
        presence?.availabilityMessage ||
        user?.availabilityMessage ||
        "",

      lastSeenAt:
        presence?.lastSeenAt ||
        now,

      updatedAt: now,
    };

    if (presence) {
      Object.assign(
        presence,
        payload
      );
    } else {
      presence = {
        id:
          crypto.randomUUID(),

        ...payload,

        createdAt: now,
      };

      draft.teamPresence.push(
        presence
      );
    }
  }
}

/* ==========================================================================
   Audit template
   ========================================================================== */

function seedAuditTemplate({
  draft,
  now,
  ownerId,
}) {
  let template =
    draft.auditReportTemplates.find(
      (item) =>
        item.workspaceId ===
        DEFAULT_WORKSPACE_ID
    );

  const payload = {
    workspaceId:
      DEFAULT_WORKSPACE_ID,

    name:
      "AH Growth default audit format",

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
      ownerId ||
      "system",

    updatedAt: now,
  };

  if (template) {
    Object.assign(
      template,
      payload
    );
  } else {
    template = {
      id:
        crypto.randomUUID(),

      ...payload,

      createdAt: now,
    };

    draft.auditReportTemplates.push(
      template
    );
  }

  return template;
}

/* ==========================================================================
   State initialization
   ========================================================================== */

function initialiseStateCollections(
  draft
) {
  const arrayCollections = [
    "users",
    "workspaces",
    "workspaceMembers",

    "campaigns",
    "salesAssignments",
    "calls",

    "attendanceRecords",

    "auditReports",
    "auditJobs",
    "leadAuditReports",
    "auditReportTemplates",

    "teamTasks",
    "teamChannels",
    "teamMessages",
    "teamPresence",

    "internalCalls",
    "dailyLeadRuns",

    "notifications",
    "inbox",
    "activity",
  ];

  for (const key of arrayCollections) {
    if (
      !Array.isArray(
        draft[key]
      )
    ) {
      draft[key] = [];
    }
  }

  draft.workspaceSettings =
    draft.workspaceSettings &&
    typeof draft.workspaceSettings ===
      "object" &&
    !Array.isArray(
      draft.workspaceSettings
    )
      ? draft.workspaceSettings
      : {};
}

/* ==========================================================================
   Utilities
   ========================================================================== */

function countMatching(
  list,
  predicate
) {
  return Array.isArray(list)
    ? list.filter(
        predicate
      ).length
    : 0;
}

function hashPassword(
  password,
  salt = crypto
    .randomBytes(16)
    .toString("hex")
) {
  const hash =
    crypto
      .scryptSync(
        String(password),
        salt,
        64
      )
      .toString("hex");

  return `${salt}:${hash}`;
}

function normalizeEmail(
  value
) {
  return String(
    value ||
      ""
  )
    .trim()
    .toLowerCase();
}

function splitName(
  value
) {
  const parts =
    String(
      value ||
        ""
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  return {
    firstName:
      parts[0] ||
      "",

    lastName:
      parts
        .slice(1)
        .join(" "),
  };
}

function slugify(
  value
) {
  return String(
    value ||
      ""
  )
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    );
}

function envFlag(
  name,
  fallback = false
) {
  const value =
    String(
      process.env[name] ??
        ""
    )
      .trim()
      .toLowerCase();

  if (!value) {
    return fallback;
  }

  return [
    "1",
    "true",
    "yes",
    "on",
  ].includes(value);
}