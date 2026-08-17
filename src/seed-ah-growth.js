// apps/api/src/seed-ah-growth.js

import "./env.js";

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createStore } from "./store.js";

const scryptAsync = promisify(
  crypto.scrypt
);

const __filename =
  fileURLToPath(
    import.meta.url
  );

const __dirname =
  path.dirname(
    __filename
  );

const IS_PRODUCTION =
  String(
    process.env.NODE_ENV || ""
  )
    .trim()
    .toLowerCase() ===
  "production";

if (
  IS_PRODUCTION &&
  !process.argv.includes(
    "--force-production"
  )
) {
  console.error(
    "[seed-ah-growth] Refusing to seed development accounts in production."
  );

  process.exit(1);
}

/*
 * This must resolve to the same directory used by server.js.
 */
const DATA_DIR =
  process.env.DATA_DIR ||
  path.resolve(
    __dirname,
    "../../../data"
  );

const store = createStore({
  dataDir: DATA_DIR,
});
await store.ready();

if (
  typeof store?.read !==
    "function" ||
  typeof store?.update !==
    "function"
) {
  throw new Error(
    "The application store does not expose read() and update()."
  );
}

const COMPANY_NAME =
  "AH Growth";

const WORKSPACE_NAME =
  "AH Growth";

const WORKSPACE_ID =
  process.env
    .AH_GROWTH_WORKSPACE_ID ||
  "ah-growth-workspace";

const COMPANY_ID =
  process.env
    .AH_GROWTH_COMPANY_ID ||
  "ah-growth-company";

const PASSWORD =
  process.env
    .AH_GROWTH_SEED_PASSWORD ||
  process.env
    .AH_GROWTH_TEST_PASSWORD ||
  (IS_PRODUCTION
    ? ""
    : "AhGrowth@123");

if (
  String(PASSWORD).length < 12
) {
  throw new Error(
    "Set AH_GROWTH_SEED_PASSWORD to a strong password of at least 12 characters before seeding production."
  );
}

const DEFAULT_DAILY_NICHES = [
  "clinics",
  "dentists",
  "restaurants",
  "law firms",
  "real estate agencies",
];

const DEFAULT_INTERNATIONAL_LOCATIONS = [
  "California",
  "Texas",
  "Florida",
  "New York",
];

const DEFAULT_LOCAL_PAKISTAN_LOCATIONS = [
  "Karachi",
  "Lahore",
  "Islamabad",
  "Rawalpindi",
  "Faisalabad",
  "Multan",
  "Peshawar",
  "Sialkot",
  "Gujranwala",
];

/*
 * Owner permissions intentionally exclude:
 *
 * - generate_leads
 * - search_leads
 * - manage_campaigns
 * - create_campaigns
 * - launch_campaigns
 * - assign_leads
 *
 * The owner is responsible for workspace administration,
 * team oversight, reporting and configuration.
 */
const OWNER_PERMISSIONS = [
  "view_dashboard",

  "manage_workspace",
  "manage_company",
  "manage_team",
  "manage_roles",
  "invite_members",
  "remove_members",

  "view_team_calls",
  "view_team_performance",
  "view_team_leads",

  "manage_dialers",
  "manage_senders",

  "view_audits",
  "view_reports",
  "manage_report_formats",

  "create_groups",
  "team_chat",
  "use_chat",
  "use_internal_calls",

  "manage_tasks",
  "view_tasks",
  "update_tasks",

  "check_in",
  "check_out",
  "update_profile",
];

/*
 * Manager is the only role allowed to:
 *
 * - generate leads
 * - create and manage campaigns
 * - run lead searches
 * - assign and reassign leads to callers
 */
const MANAGER_PERMISSIONS = [
  "view_dashboard",

  "manage_team",

  "generate_leads",
  "search_leads",

  /*
   * Existing server middleware currently checks
   * manage_campaigns for lead generation routes.
   */
  "manage_campaigns",
  "create_campaigns",
  "launch_campaigns",
  "run_campaigns",
  "stop_campaigns",
  "edit_campaign_pipeline",

  "assign_leads",
  "reassign_leads",
  "unassign_leads",
  "view_team_leads",
  "view_all_leads",

  "view_team_calls",
  "view_team_performance",

  "manage_dialers",
  "manage_senders",

  "view_audits",
  "create_audits",
  "view_reports",

  "create_groups",
  "team_chat",
  "use_chat",
  "use_internal_calls",

  "manage_tasks",
  "view_tasks",
  "update_tasks",

  "check_in",
  "check_out",
  "update_profile",
];

/*
 * Caller permissions intentionally exclude campaign creation,
 * lead generation and lead assignment.
 */
const CALLER_PERMISSIONS = [
  "view_dashboard",

  "view_assigned_leads",
  "update_assigned_leads",

  "make_calls",

  "view_audits",
  "create_audits",
  "view_mini_audits",

  "team_chat",
  "use_chat",
  "use_internal_calls",

  "view_tasks",
  "update_tasks",

  "check_in",
  "check_out",
  "update_profile",
];

/*
 * ----------------------------------------------------------
 * ACCOUNTS
 * ----------------------------------------------------------
 *
 * 1 Owner
 * 1 Manager
 * 2 Local Pakistan callers
 * 6 International callers
 *
 * Total users = 10
 */
const ACCOUNTS = [
  {
    name:
      "AH Growth Owner",

    email:
      "owner@ahgrowth.test",

    role: "owner",

    jobTitle:
      "Company Owner",

    department:
      "Leadership",

    permissions:
      OWNER_PERMISSIONS,
  },

  {
    name:
      "AH Growth Manager",

    email:
      "manager@ahgrowth.test",

    role: "manager",

    jobTitle:
      "Sales Manager",

    department:
      "Sales",

    permissions:
      MANAGER_PERMISSIONS,
  },

  /*
   * LOCAL CALLER 1
   */
  {
    name:
      "AH Growth Local Caller One",

    email:
      "caller1@ahgrowth.test",

    role: "caller",

    resourceType:
      "local",

    jobTitle:
      "Local Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  /*
   * LOCAL CALLER 2
   */
  {
    name:
      "AH Growth Local Caller Two",

    email:
      "caller2@ahgrowth.test",

    role: "caller",

    resourceType:
      "local",

    jobTitle:
      "Local Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  /*
   * INTERNATIONAL CALLER 1
   */
  {
    name:
      "AH Growth International Caller One",

    email:
      "caller3@ahgrowth.test",

    role: "caller",

    resourceType:
      "international",

    jobTitle:
      "International Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  /*
   * INTERNATIONAL CALLER 2
   */
  {
    name:
      "AH Growth International Caller Two",

    email:
      "caller4@ahgrowth.test",

    role: "caller",

    resourceType:
      "international",

    jobTitle:
      "International Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  /*
   * INTERNATIONAL CALLER 3
   */
  {
    name:
      "AH Growth International Caller Three",

    email:
      "caller5@ahgrowth.test",

    role: "caller",

    resourceType:
      "international",

    jobTitle:
      "International Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  /*
   * INTERNATIONAL CALLER 4
   */
  {
    name:
      "AH Growth International Caller Four",

    email:
      "caller6@ahgrowth.test",

    role: "caller",

    resourceType:
      "international",

    jobTitle:
      "International Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  /*
   * INTERNATIONAL CALLER 5
   */
  {
    name:
      "AH Growth International Caller Five",

    email:
      "caller7@ahgrowth.test",

    role: "caller",

    resourceType:
      "international",

    jobTitle:
      "International Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  /*
   * INTERNATIONAL CALLER 6
   */
  {
    name:
      "AH Growth International Caller Six",

    email:
      "caller8@ahgrowth.test",

    role: "caller",

    resourceType:
      "international",

    jobTitle:
      "International Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },
];

/*
 * ----------------------------------------------------------
 * PASSWORD HASHING
 * ----------------------------------------------------------
 */
async function hashPassword(
  password
) {
  const salt = crypto
    .randomBytes(16)
    .toString("hex");

  const derivedKey =
    await scryptAsync(
      String(password),
      salt,
      64
    );

  return `${salt}:${Buffer.from(
    derivedKey
  ).toString("hex")}`;
}

/*
 * ----------------------------------------------------------
 * MAIN SEED
 * ----------------------------------------------------------
 */
async function seedAhGrowth() {
  const passwordHash =
    await hashPassword(
      PASSWORD
    );

  const timestamp =
    new Date().toISOString();

  const preparedAccounts =
    ACCOUNTS.map(
      (account) => ({
        ...account,

        email: String(
          account.email
        )
          .trim()
          .toLowerCase(),

        permissions: [
          ...new Set(
            account.permissions ||
              []
          ),
        ],

        passwordHash,
      })
    );

  const seededAccounts = [];

  store.update((draft) => {
    /*
     * ------------------------------------------------------
     * ENSURE STORE COLLECTIONS
     * ------------------------------------------------------
     */

    draft.users =
      Array.isArray(
        draft.users
      )
        ? draft.users
        : [];

    draft.workspaces =
      Array.isArray(
        draft.workspaces
      )
        ? draft.workspaces
        : [];

    draft.companies =
      Array.isArray(
        draft.companies
      )
        ? draft.companies
        : [];

    draft.workspaceMembers =
      Array.isArray(
        draft.workspaceMembers
      )
        ? draft.workspaceMembers
        : [];

    draft.teamChannels =
      Array.isArray(
        draft.teamChannels
      )
        ? draft.teamChannels
        : [];

    draft.teamMessages =
      Array.isArray(
        draft.teamMessages
      )
        ? draft.teamMessages
        : [];

    draft.teamChannelReads =
      Array.isArray(
        draft.teamChannelReads
      )
        ? draft.teamChannelReads
        : [];

    draft.teamTasks =
      Array.isArray(
        draft.teamTasks
      )
        ? draft.teamTasks
        : [];

    draft.leadAssignments =
      Array.isArray(
        draft.leadAssignments
      )
        ? draft.leadAssignments
        : [];

    draft.workspaceSettings =
      draft.workspaceSettings &&
      typeof draft.workspaceSettings ===
        "object" &&
      !Array.isArray(
        draft.workspaceSettings
      )
        ? draft.workspaceSettings
        : {};

    /*
     * ------------------------------------------------------
     * WORKSPACE
     * ------------------------------------------------------
     */

    let workspace =
      draft.workspaces.find(
        (item) =>
          item.id ===
          WORKSPACE_ID
      );

    if (!workspace) {
      workspace = {
        id:
          WORKSPACE_ID,

        name:
          WORKSPACE_NAME,

        workspaceName:
          WORKSPACE_NAME,

        companyName:
          COMPANY_NAME,

        companyId:
          COMPANY_ID,

        slug:
          "ah-growth",

        accountType:
          "company",

        workspaceType:
          "company",

        companyAccount:
          true,

        ownerId: "",
        ownerUserId: "",

        status:
          "active",

        active: true,
        isActive: true,

        plan:
          IS_PRODUCTION
            ? "production"
            : "test",

        createdAt:
          timestamp,

        updatedAt:
          timestamp,
      };

      draft.workspaces.push(
        workspace
      );
    } else {
      Object.assign(
        workspace,
        {
          name:
            WORKSPACE_NAME,

          workspaceName:
            WORKSPACE_NAME,

          companyName:
            COMPANY_NAME,

          companyId:
            COMPANY_ID,

          slug:
            "ah-growth",

          accountType:
            "company",

          workspaceType:
            "company",

          companyAccount:
            true,

          status:
            "active",

          active: true,
          isActive: true,

          plan:
            workspace.plan ||
            (IS_PRODUCTION
              ? "production"
              : "test"),

          updatedAt:
            timestamp,
        }
      );
    }

    /*
     * ------------------------------------------------------
     * COMPANY
     * ------------------------------------------------------
     */

    let company =
      draft.companies.find(
        (item) =>
          item.id ===
            COMPANY_ID ||
          item.workspaceId ===
            WORKSPACE_ID
      );

    if (!company) {
      company = {
        id:
          COMPANY_ID,

        workspaceId:
          WORKSPACE_ID,

        name:
          COMPANY_NAME,

        companyName:
          COMPANY_NAME,

        workspaceName:
          WORKSPACE_NAME,

        slug:
          "ah-growth",

        accountType:
          "company",

        workspaceType:
          "company",

        companyAccount:
          true,

        ownerId: "",
        ownerUserId: "",

        status:
          "active",

        active: true,
        isActive: true,

        createdAt:
          timestamp,

        updatedAt:
          timestamp,
      };

      draft.companies.push(
        company
      );
    } else {
      Object.assign(
        company,
        {
          workspaceId:
            WORKSPACE_ID,

          name:
            COMPANY_NAME,

          companyName:
            COMPANY_NAME,

          workspaceName:
            WORKSPACE_NAME,

          slug:
            "ah-growth",

          accountType:
            "company",

          workspaceType:
            "company",

          companyAccount:
            true,

          status:
            "active",

          active: true,
          isActive: true,

          updatedAt:
            timestamp,
        }
      );
    }

    /*
     * ------------------------------------------------------
     * USERS + MEMBERSHIPS
     * ------------------------------------------------------
     */

    for (
      const account
      of preparedAccounts
    ) {
      /*
       * Find by email so running the seed again does not
       * create duplicate accounts.
       */
      let user =
        draft.users.find(
          (item) =>
            String(
              item.email || ""
            )
              .trim()
              .toLowerCase() ===
            account.email
        );

      /*
       * Create user if it does not already exist.
       */
      if (!user) {
        user = {
          id:
            crypto.randomUUID(),

          createdAt:
            timestamp,
        };

        draft.users.push(
          user
        );
      }

      const callerResourceType =
        account.role === "caller"
          ? account.resourceType ||
            "international"
          : "";

      /*
       * Update the user.
       *
       * Existing IDs are preserved.
       * Existing avatars/profile information are preserved.
       */
      Object.assign(
        user,
        {
          name:
            account.name,

          fullName:
            account.name,

          email:
            account.email,

          /*
           * Only hashed passwords are stored.
           */
          passwordHash:
            account.passwordHash,

          /*
           * Older application modules may read passwordDigest.
           */
          passwordDigest:
            account.passwordHash,

          role:
            account.role,

          workspaceRole:
            account.role,

          permissions: [
            ...account.permissions,
          ],

          workspaceId:
            WORKSPACE_ID,

          companyId:
            COMPANY_ID,

          accountId:
            WORKSPACE_ID,

          accountType:
            "company",

          workspaceType:
            "company",

          companyAccount:
            true,

          companyName:
            COMPANY_NAME,

          workspaceName:
            WORKSPACE_NAME,

          jobTitle:
            account.jobTitle,

          department:
            account.department,

          /*
           * The daily automation and Manager dashboard can
           * use either resourceType or callerResourceType.
           */
          ...(account.role ===
          "caller"
            ? {
                resourceType:
                  callerResourceType,

                callerResourceType:
                  callerResourceType,
              }
            : {}),

          status:
            "active",

          active: true,
          isActive: true,

          emailVerified:
            true,

          emailVerifiedAt:
            user.emailVerifiedAt ||
            timestamp,

          avatarUrl:
            user.avatarUrl ||
            "",

          photoUrl:
            user.photoUrl ||
            "",

          profileImage:
            user.profileImage ||
            "",

          profileImageUrl:
            user.profileImageUrl ||
            user.profileImage ||
            user.avatarUrl ||
            "",

          availabilityStatus:
            user.availabilityStatus ||
            "offline",

          lastLoginAt:
            user.lastLoginAt ||
            "",

          updatedAt:
            timestamp,
        }
      );

      /*
       * Never store plaintext passwords.
       */
      delete user.password;
      delete user.plainPassword;

      /*
       * Owner IDs.
       */
      if (
        account.role ===
        "owner"
      ) {
        workspace.ownerId =
          user.id;

        workspace.ownerUserId =
          user.id;

        company.ownerId =
          user.id;

        company.ownerUserId =
          user.id;
      }

      /*
       * Workspace membership.
       */
      let membership =
        draft.workspaceMembers.find(
          (item) =>
            item.workspaceId ===
              WORKSPACE_ID &&
            item.userId ===
              user.id
        );

      if (!membership) {
        membership = {
          id:
            crypto.randomUUID(),

          workspaceId:
            WORKSPACE_ID,

          userId:
            user.id,

          createdAt:
            timestamp,
        };

        draft.workspaceMembers.push(
          membership
        );
      }

      Object.assign(
        membership,
        {
          workspaceId:
            WORKSPACE_ID,

          companyId:
            COMPANY_ID,

          userId:
            user.id,

          role:
            account.role,

          workspaceRole:
            account.role,

          permissions: [
            ...account.permissions,
          ],

          accountType:
            "company",

          workspaceType:
            "company",

          status:
            "active",

          active: true,
          isActive: true,

          joinedAt:
            membership.joinedAt ||
            timestamp,

          updatedAt:
            timestamp,
        }
      );

      seededAccounts.push({
        id:
          user.id,

        name:
          user.name,

        email:
          user.email,

        role:
          user.workspaceRole,

        resourceType:
          account.role ===
          "caller"
            ? callerResourceType
            : "",

        permissions: [
          ...user.permissions,
        ],
      });
    }

    /*
     * ------------------------------------------------------
     * DAILY LEAD AUTOMATION SETTINGS
     * ------------------------------------------------------
     *
     * Important:
     *
     * Existing Manager-selected settings are preserved.
     *
     * We only guarantee:
     *
     * caller1 = Local Pakistan
     * caller2 = Local Pakistan
     *
     * caller3 = International
     * caller4 = International
     * caller5 = International
     * caller6 = International
     * caller7 = International
     * caller8 = International
     *
     * Manager can still change:
     *
     * - refresh time
     * - timezone
     * - niche
     * - location
     * - country
     * - international market
     */

    const existingDailyLeadConfig =
      draft.workspaceSettings[
        WORKSPACE_ID
      ]?.dailyLeadAutomation ||
      {};

    const existingCallerPlans =
      existingDailyLeadConfig
        .callerPlans &&
      typeof existingDailyLeadConfig
        .callerPlans ===
        "object" &&
      !Array.isArray(
        existingDailyLeadConfig
          .callerPlans
      )
        ? existingDailyLeadConfig
            .callerPlans
        : {};

    const nextCallerPlans = {
      ...existingCallerPlans,
    };

    /*
     * Build/update a plan using each caller's real user ID.
     */
    for (
      const account
      of seededAccounts.filter(
        (item) =>
          item.role === "caller"
      )
    ) {
      const previousPlan =
        existingCallerPlans[
          account.id
        ] || {};

      /*
       * LOCAL CALLER
       */
      if (
        account.resourceType ===
        "local"
      ) {
        nextCallerPlans[
          account.id
        ] = {
          ...previousPlan,

          resourceType:
            "local",

          /*
           * Preserve an existing Pakistan city if the manager
           * previously selected one.
           *
           * If this caller was previously International,
           * clear the old international location.
           */
          location:
            previousPlan
              .resourceType ===
            "local"
              ? previousPlan.location ||
                ""
              : "",

          /*
           * Local always means Pakistan.
           */
          country:
            "Pakistan",

          regionCode:
            "PK",
        };
      }

      /*
       * INTERNATIONAL CALLER
       */
      else {
        const wasLocal =
          previousPlan
            .resourceType ===
          "local";

        nextCallerPlans[
          account.id
        ] = {
          ...previousPlan,

          resourceType:
            "international",

          /*
           * Do not accidentally carry Lahore/Karachi/etc into
           * an International caller after switching type.
           */
          location:
            wasLocal
              ? ""
              : previousPlan.location ||
                "",

          country:
            wasLocal
              ? ""
              : previousPlan.country ||
                "",

          regionCode:
            wasLocal
              ? existingDailyLeadConfig
                  .regionCode ||
                "US"
              : previousPlan
                  .regionCode ||
                existingDailyLeadConfig
                  .regionCode ||
                "US",
        };
      }
    }

    /*
     * Ensure the workspace settings object exists.
     */
    draft.workspaceSettings[
      WORKSPACE_ID
    ] =
      draft.workspaceSettings[
        WORKSPACE_ID
      ] ||
      {};

    /*
     * Save daily automation defaults.
     *
     * Existing manager-selected values always win.
     */
    draft.workspaceSettings[
      WORKSPACE_ID
    ].dailyLeadAutomation = {
      ...existingDailyLeadConfig,

      /*
       * Enabled by default.
       */
      enabled:
        existingDailyLeadConfig
          .enabled ??
        true,

      /*
       * Exactly 100 leads per caller by default.
       */
      leadsPerCaller:
        existingDailyLeadConfig
          .leadsPerCaller ??
        100,

      /*
       * Default business timezone.
       *
       * Manager can change this from dashboard.
       */
      timezone:
        existingDailyLeadConfig
          .timezone ||
        "Asia/Karachi",

      /*
       * Default refresh = 04:00 Pakistan time.
       *
       * Manager dashboard can change this later.
       */
      assignmentHour:
        existingDailyLeadConfig
          .assignmentHour ??
        4,

      assignmentMinute:
        existingDailyLeadConfig
          .assignmentMinute ??
        0,

      /*
       * Previous eligible leads become reusable after
       * the configured recycle threshold.
       */
      recycleAfterHours:
        existingDailyLeadConfig
          .recycleAfterHours ??
        24,

      /*
       * Stop endlessly recycling dead leads.
       */
      maxCallAttempts:
        existingDailyLeadConfig
          .maxCallAttempts ??
        5,

      /*
       * Default niches.
       *
       * Manager can replace these in Daily Caller Operations.
       */
      niches:
        Array.isArray(
          existingDailyLeadConfig
            .niches
        ) &&
        existingDailyLeadConfig
          .niches.length
          ? existingDailyLeadConfig
              .niches
          : [
              ...DEFAULT_DAILY_NICHES,
            ],

      /*
       * Default International markets.
       */
      locations:
        Array.isArray(
          existingDailyLeadConfig
            .locations
        ) &&
        existingDailyLeadConfig
          .locations.length
          ? existingDailyLeadConfig
              .locations
          : [
              ...DEFAULT_INTERNATIONAL_LOCATIONS,
            ],

      /*
       * Pakistan cities available to Local callers.
       */
      localPakistanLocations:
        Array.isArray(
          existingDailyLeadConfig
            .localPakistanLocations
        ) &&
        existingDailyLeadConfig
          .localPakistanLocations
          .length
          ? existingDailyLeadConfig
              .localPakistanLocations
          : [
              ...DEFAULT_LOCAL_PAKISTAN_LOCATIONS,
            ],

      /*
       * Default International Google Places region.
       *
       * Local callers override this with PK.
       */
      regionCode:
        existingDailyLeadConfig
          .regionCode ||
        "US",

      /*
       * Automatically queue the Mini Audit for daily leads.
       */
      autoMiniAudit:
        existingDailyLeadConfig
          .autoMiniAudit ??
        true,

      /*
       * Per-caller plans.
       */
      callerPlans:
        nextCallerPlans,
    };

    /*
     * Keep timestamps current.
     */
    workspace.updatedAt =
      timestamp;

    company.updatedAt =
      timestamp;

    /*
     * ------------------------------------------------------
     * GENERAL TEAM CHANNEL
     * ------------------------------------------------------
     */

    let generalChannel =
      draft.teamChannels.find(
        (channel) =>
          channel.workspaceId ===
            WORKSPACE_ID &&
          channel.slug ===
            "general" &&
          !channel.archivedAt
      );

    if (!generalChannel) {
      generalChannel = {
        id:
          crypto.randomUUID(),

        workspaceId:
          WORKSPACE_ID,

        type:
          "team",

        slug:
          "general",

        name:
          "General",

        description:
          "AH Growth company-wide communication.",

        /*
         * Empty membership means all workspace members.
         */
        memberIds: [],
        memberUserIds: [],

        createdBy:
          "system",

        active: true,

        createdAt:
          timestamp,

        updatedAt:
          timestamp,

        archivedAt: "",
      };

      draft.teamChannels.push(
        generalChannel
      );
    } else {
      Object.assign(
        generalChannel,
        {
          workspaceId:
            WORKSPACE_ID,

          type:
            "team",

          slug:
            "general",

          name:
            "General",

          description:
            "AH Growth company-wide communication.",

          memberIds: [],
          memberUserIds: [],

          active: true,

          archivedAt: "",

          updatedAt:
            timestamp,
        }
      );
    }
  });

  /*
   * --------------------------------------------------------
   * SUCCESS OUTPUT
   * --------------------------------------------------------
   */

  console.log(
    "\nAH Growth company and users were seeded successfully.\n"
  );

  console.table(
    seededAccounts.map(
      (account) => ({
        Role:
          formatRole(
            account.role
          ),

        Name:
          account.name,

        Email:
          account.email,

        Resource:
          account.role ===
          "caller"
            ? account.resourceType ===
              "local"
              ? "Local · Pakistan"
              : "International"
            : "-",

        /*
         * Never print the production password.
         */
        Password:
          IS_PRODUCTION
            ? "(private value from AH_GROWTH_SEED_PASSWORD)"
            : PASSWORD,

        Permissions:
          account.permissions.length,
      })
    )
  );

  console.log(
    `Company: ${COMPANY_NAME}`
  );

  console.log(
    `Workspace ID: ${WORKSPACE_ID}`
  );

  console.log(
    `Company ID: ${COMPANY_ID}`
  );

  console.log(
    `Data directory: ${DATA_DIR}`
  );

  console.log(
    "\nRole access summary:"
  );

  console.log(
    "- Owner: workspace administration and oversight"
  );

  console.log(
    "- Manager: lead generation, campaigns and lead assignment"
  );

  console.log(
    "- Callers: assigned leads, calling and task updates"
  );

  console.log(
    "\nCaller allocation:"
  );

  console.log(
    "- caller1@ahgrowth.test and caller2@ahgrowth.test: Local · Pakistan"
  );

  console.log(
    "- caller3@ahgrowth.test through caller8@ahgrowth.test: International"
  );

  console.log(
    "- Daily target: 100 leads per caller"
  );

  console.log(
    "- Default refresh: 04:00 Asia/Karachi (manager can change this from the dashboard)"
  );

  console.log(
    "\nAccount emails:"
  );

  console.log(
    "- Owner: owner@ahgrowth.test"
  );

  console.log(
    "- Manager: manager@ahgrowth.test"
  );

  console.log(
    "- Local Caller 1: caller1@ahgrowth.test"
  );

  console.log(
    "- Local Caller 2: caller2@ahgrowth.test"
  );

  console.log(
    "- International Caller 1: caller3@ahgrowth.test"
  );

  console.log(
    "- International Caller 2: caller4@ahgrowth.test"
  );

  console.log(
    "- International Caller 3: caller5@ahgrowth.test"
  );

  console.log(
    "- International Caller 4: caller6@ahgrowth.test"
  );

  console.log(
    "- International Caller 5: caller7@ahgrowth.test"
  );

  console.log(
    "- International Caller 6: caller8@ahgrowth.test"
  );

  console.log(
    "\nRestart the API and log in again before testing these accounts.\n"
  );
}

/*
 * ----------------------------------------------------------
 * FORMAT ROLE
 * ----------------------------------------------------------
 */
function formatRole(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (word) =>
        word
          .charAt(0)
          .toUpperCase() +
        word.slice(1)
    )
    .join(" ");
}

/*
 * ----------------------------------------------------------
 * RUN
 * ----------------------------------------------------------
 */
seedAhGrowth().catch(
  (error) => {
    console.error(
      "\nAH Growth seed failed:",
      error
    );

    process.exitCode = 1;
  }
);