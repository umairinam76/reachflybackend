// apps/api/src/seed-ah-growth.js

import "dotenv/config";

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
    .AH_GROWTH_TEST_PASSWORD ||
  "AhGrowth@123";

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

  {
    name:
      "AH Growth Caller One",

    email:
      "caller1@ahgrowth.test",

    role: "caller",

    jobTitle:
      "Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },

  {
    name:
      "AH Growth Caller Two",

    email:
      "caller2@ahgrowth.test",

    role: "caller",

    jobTitle:
      "Cold Caller",

    department:
      "Sales",

    permissions:
      CALLER_PERMISSIONS,
  },
];

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

    /*
     * Workspace
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
          "test",

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
            "test",

          updatedAt:
            timestamp,
        }
      );
    }

    /*
     * Company
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
     * Users and memberships
     */
    for (
      const account
      of preparedAccounts
    ) {
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
           * Store the application-compatible hash.
           * Do not store the raw password.
           */
          passwordHash:
            account.passwordHash,

          /*
           * Some older parts of the application may read
           * passwordDigest instead of passwordHash.
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
       * Remove incorrectly stored legacy password fields.
       */
      delete user.password;
      delete user.plainPassword;

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

        permissions: [
          ...user.permissions,
        ],
      });
    }

    workspace.updatedAt =
      timestamp;

    company.updatedAt =
      timestamp;

    /*
     * General team channel
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
         * An empty member list means every member of the
         * workspace may access the General channel.
         *
         * Both property names are included because different
         * parts of the application support either format.
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

        Password:
          PASSWORD,

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
    "\nRestart the API and log in again before testing these accounts.\n"
  );
}

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

seedAhGrowth().catch(
  (error) => {
    console.error(
      "\nAH Growth seed failed:",
      error
    );

    process.exitCode = 1;
  }
);