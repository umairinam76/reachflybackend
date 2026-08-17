import crypto from "node:crypto";

export const TEAM_ROLES = ["owner", "manager", "caller", "viewer"];
export const LEAD_STATUSES = [
  "new",
  "call_due",
  "attempted",
  "no_answer",
  "gatekeeper",
  "connected",
  "send_information",
  "callback",
  "qualified",
  "meeting_booked",
  "not_interested",
  "wrong_number",
  "do_not_call",
];

export function createWorkspaceService({ store, email, appUrl }) {
  function workspaceIsReady(user, state) {
    if (!user?.id || !user.workspaceId) return false;

    const workspaceExists = (state.workspaces || []).some(
      (item) => item.id === user.workspaceId
    );

    if (!workspaceExists) return false;
    if (!TEAM_ROLES.includes(normalizeRole(user.workspaceRole))) return false;
    if (!Array.isArray(user.permissions) || user.permissions.length === 0) {
      return false;
    }

    return !(state.campaigns || []).some(
      (campaign) =>
        !campaign.workspaceId &&
        [campaign.userId, campaign.ownerId, campaign.createdBy].includes(user.id)
    );
  }

  function ensureWorkspaceForUser(userId, stateOverride = null) {
    const snapshot = stateOverride || store.read();
    const existingUser = (snapshot.users || []).find(
      (item) => item.id === userId
    );

    if (!existingUser) return null;

    // The previous implementation rewrote the complete JSON store and walked
    // every lead on every authenticated request. Return immediately once the
    // user and their campaigns have already been migrated.
    if (workspaceIsReady(existingUser, snapshot)) {
      return { ...existingUser };
    }

    let migratedUser = null;

    store.update((state) => {
      state.users = state.users || [];
      state.workspaces = state.workspaces || [];
      state.workspaceInvites = state.workspaceInvites || [];

      const user = state.users.find((item) => item.id === userId);
      if (!user) return;

      const now = new Date().toISOString();
      let workspace = user.workspaceId
        ? state.workspaces.find((item) => item.id === user.workspaceId)
        : null;

      if (!workspace) {
        const workspaceId = user.workspaceId || crypto.randomUUID();

        workspace = {
          id: workspaceId,
          name:
            user.companyName ||
            `${user.name || user.email || "ReachFly"} workspace`,
          accountType: user.accountType || "individual",
          ownerId: user.id,
          createdAt: now,
          updatedAt: now,
        };

        state.workspaces.push(workspace);
        user.workspaceId = workspaceId;
      }

      user.workspaceRole = normalizeRole(user.workspaceRole || "owner");
      user.permissions =
        Array.isArray(user.permissions) && user.permissions.length
          ? user.permissions
          : permissionsForRole(user.workspaceRole);
      user.updatedAt = user.updatedAt || now;

      // Only assign the workspace to campaigns owned by this user. Lead shape
      // migration is intentionally not performed here because doing it during
      // authentication makes every API request proportional to all stored leads.
      for (const campaign of state.campaigns || []) {
        if (
          !campaign.workspaceId &&
          [campaign.userId, campaign.ownerId, campaign.createdBy].includes(user.id)
        ) {
          campaign.workspaceId = user.workspaceId;
          campaign.updatedAt = campaign.updatedAt || now;
        }
      }

      migratedUser = { ...user };
    });

    return migratedUser;
  }

  function requireUserPermission(user, permission) {
    const context = getContext(user);
    if (!hasPermission(context, permission)) {
      throw createError(403, "You do not have permission to perform this action.");
    }
    return context;
  }

  function getContext(user, stateOverride = null) {
    let state = stateOverride || store.read();
    let currentUser = (state.users || []).find(
      (item) => item.id === user?.id
    ) || user;

    if (!workspaceIsReady(currentUser, state)) {
      currentUser = ensureWorkspaceForUser(currentUser?.id, state) || currentUser;
      state = store.read();
      currentUser = (state.users || []).find(
        (item) => item.id === currentUser?.id
      ) || currentUser;
    }

    const workspace = (state.workspaces || []).find(
      (item) => item.id === currentUser?.workspaceId
    );

    return {
      user: currentUser,
      workspace,
      workspaceId: currentUser?.workspaceId || "",
      role: normalizeRole(currentUser?.workspaceRole),
      permissions:
        currentUser?.permissions || permissionsForRole(currentUser?.workspaceRole),
    };
  }

  function listMembers(user) {
    const context = getContext(user);
    const state = store.read();

    return (state.users || [])
      .filter((member) => member.workspaceId === context.workspaceId)
      .map(publicMember)
      .sort((a, b) => {
        if (a.workspaceRole === "owner") return -1;
        if (b.workspaceRole === "owner") return 1;
        return a.name.localeCompare(b.name);
      });
  }

  async function inviteMember(user, input = {}) {
    const context = requireUserPermission(user, "manage_team");
    const invitedEmail = normalizeEmail(input.email);
    const role = normalizeRole(input.role || "caller");

    if (!invitedEmail || !invitedEmail.includes("@")) {
      throw createError(400, "A valid team-member email is required.");
    }

    if (!["manager", "caller", "viewer"].includes(role)) {
      throw createError(400, "Team role must be manager, caller, or viewer.");
    }

    const state = store.read();
    const existing = (state.users || []).find(
      (item) => normalizeEmail(item.email) === invitedEmail
    );

    if (existing?.workspaceId === context.workspaceId) {
      throw createError(409, "This person is already in the workspace.");
    }

    if (existing?.workspaceId && existing.workspaceId !== context.workspaceId) {
      throw createError(
        409,
        "This email already belongs to another ReachFly workspace."
      );
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const invite = {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      email: invitedEmail,
      role,
      tokenHash,
      invitedBy: context.user.id,
      createdAt: now,
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
    };

    store.update((draft) => {
      draft.workspaceInvites = draft.workspaceInvites || [];
      for (const item of draft.workspaceInvites) {
        if (
          item.workspaceId === context.workspaceId &&
          normalizeEmail(item.email) === invitedEmail &&
          !item.acceptedAt
        ) {
          item.revokedAt = now;
        }
      }
      draft.workspaceInvites.push(invite);
    });

    const inviteUrl = `${String(appUrl || "").replace(/\/$/, "")}/accept-invite?token=${rawToken}`;
    let emailSent = false;
    let emailMessage = "Invite created. Share the link securely.";

    try {
      const ownerId = context.workspace?.ownerId || context.user.id;
      await email.sendCampaignEmail(ownerId, {
        accountId: input.accountId || "",
        to: invitedEmail,
        subject: `You are invited to ${context.workspace?.name || "ReachFly"}`,
        body: [
          `Hi,`,
          ``,
          `${context.user.name} invited you to join ${
            context.workspace?.name || "their ReachFly workspace"
          } as a ${role}.`,
          ``,
          `Create your password and open your dashboard:`,
          inviteUrl,
          ``,
          `This invitation expires in 7 days.`,
        ].join("\n"),
      });
      emailSent = true;
      emailMessage = "Invitation email sent.";
    } catch (error) {
      emailMessage = `Invite created, but email was not sent: ${error.message}`;
    }

    return {
      invite: { ...invite, tokenHash: undefined },
      inviteUrl:
        emailSent && process.env.NODE_ENV === "production" ? "" : inviteUrl,
      emailSent,
      message: emailMessage,
    };
  }

  function acceptInvite(input = {}) {
    const token = String(input.token || "").trim();
    const name = clean(input.name);
    const password = String(input.password || "");

    if (!token || !name || password.length < 8) {
      throw createError(
        400,
        "A valid invitation, name, and password of at least 8 characters are required."
      );
    }

    const tokenHash = sha256(token);
    const state = store.read();
    const invite = (state.workspaceInvites || []).find(
      (item) => item.tokenHash === tokenHash
    );

    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      Date.parse(invite.expiresAt) <= Date.now()
    ) {
      throw createError(400, "This invitation is invalid or has expired.");
    }

    if (
      (state.users || []).some(
        (item) => normalizeEmail(item.email) === normalizeEmail(invite.email)
      )
    ) {
      throw createError(409, "An account with this email already exists.");
    }

    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      name,
      email: normalizeEmail(invite.email),
      passwordHash: hashPassword(password),
      accountType: "team",
      role: roleLabel(invite.role),
      companyName: "",
      workspaceId: invite.workspaceId,
      workspaceRole: invite.role,
      permissions: permissionsForRole(invite.role),
      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      draft.users = draft.users || [];
      draft.users.push(user);
      const target = (draft.workspaceInvites || []).find(
        (item) => item.id === invite.id
      );
      if (target) target.acceptedAt = now;
    });

    return user;
  }

  function updateMember(user, memberId, input = {}) {
    const context = requireUserPermission(user, "manage_team");
    const role = normalizeRole(input.role || "caller");

    if (!["manager", "caller", "viewer"].includes(role)) {
      throw createError(400, "Invalid team role.");
    }

    let updated = null;
    store.update((state) => {
      const member = (state.users || []).find(
        (item) => item.id === memberId && item.workspaceId === context.workspaceId
      );
      if (!member) return;
      if (member.workspaceRole === "owner") {
        throw createError(400, "The workspace owner role cannot be changed here.");
      }
      member.workspaceRole = role;
      member.role = roleLabel(role);
      member.permissions = permissionsForRole(role);
      member.active = input.active !== false;
      member.updatedAt = new Date().toISOString();
      updated = publicMember(member);
    });

    if (!updated) throw createError(404, "Team member not found.");
    return updated;
  }

  function assignLead(user, campaignId, leadId, input = {}) {
    const context = requireUserPermission(user, "assign_leads");
    const assigneeId = String(input.assignedTo || "").trim();
    const state = store.read();
    const member = (state.users || []).find(
      (item) => item.id === assigneeId && item.workspaceId === context.workspaceId
    );

    if (!member) throw createError(404, "Assignee is not in this workspace.");

    return mutateLead({
      store,
      context,
      campaignId,
      leadId,
      allowAll: true,
      mutate: (lead) => {
        lead.assignedTo = member.id;
        lead.assignedToName = member.name;
        lead.assignedAt = new Date().toISOString();
        lead.assignedBy = context.user.id;
        lead.status = lead.status === "new" ? "call_due" : lead.status;
        appendActivity(lead, {
          type: "assignment",
          actorId: context.user.id,
          actorName: context.user.name,
          note: `Assigned to ${member.name}`,
        });
      },
    });
  }

  function bulkAssignLeads(user, campaignId, input = {}) {
    const context = requireUserPermission(user, "assign_leads");
    const memberIds = [...new Set((input.memberIds || []).map(String).filter(Boolean))];
    if (!memberIds.length) throw createError(400, "Select at least one caller.");

    const state = store.read();
    const validMembers = (state.users || []).filter(
      (member) =>
        memberIds.includes(member.id) &&
        member.workspaceId === context.workspaceId &&
        ["caller", "manager"].includes(normalizeRole(member.workspaceRole))
    );
    if (!validMembers.length) throw createError(400, "No valid callers were selected.");

    const requestedLeadIds = new Set((input.leadIds || []).map(String));
    const onlyUnassigned = input.onlyUnassigned !== false;
    const strategy = input.strategy === "single" ? "single" : "round_robin";
    let updated = 0;

    store.update((draft) => {
      const campaign = (draft.campaigns || []).find(
        (item) => item.id === campaignId && canAccessCampaign(item, context)
      );
      if (!campaign) return;
      ensureLeadShape(campaign, context.user);

      const targets = (campaign.leads || []).filter((lead) => {
        if (requestedLeadIds.size && !requestedLeadIds.has(lead.id)) return false;
        if (onlyUnassigned && lead.assignedTo) return false;
        return !["do_not_call", "not_interested"].includes(lead.status);
      });

      targets.forEach((lead, index) => {
        const member = strategy === "single" ? validMembers[0] : validMembers[index % validMembers.length];
        lead.assignedTo = member.id;
        lead.assignedToName = member.name;
        lead.assignedAt = new Date().toISOString();
        lead.assignedBy = context.user.id;
        lead.status = lead.status === "new" ? "call_due" : lead.status;
        appendActivity(lead, {
          type: "assignment",
          actorId: context.user.id,
          actorName: context.user.name,
          note: `Bulk assigned to ${member.name}`,
        });
        updated += 1;
      });

      campaign.updatedAt = new Date().toISOString();
    });

    if (!updated) throw createError(404, "No eligible leads were available for assignment.");
    return { ok: true, updated, strategy, memberIds: validMembers.map((member) => member.id) };
  }

  function updateLead(user, campaignId, leadId, input = {}) {
    const context = requireUserPermission(user, "update_leads");
    const nextStatus = input.status ? normalizeLeadStatus(input.status) : "";

    return mutateLead({
      store,
      context,
      campaignId,
      leadId,
      mutate: (lead) => {
        if (nextStatus) lead.status = nextStatus;
        if (input.callNotes !== undefined) lead.callNotes = cleanMultiline(input.callNotes, 5000);
        if (input.beforeCallNotes !== undefined) lead.beforeCallNotes = cleanMultiline(input.beforeCallNotes, 5000);
        if (input.afterCallNotes !== undefined) lead.afterCallNotes = cleanMultiline(input.afterCallNotes, 5000);
        if (input.nextActionAt !== undefined) lead.nextActionAt = validDate(input.nextActionAt);
        if (Array.isArray(input.tags)) lead.tags = sanitizeTags(input.tags);
        if (input.contactName !== undefined) lead.contact_name = clean(input.contactName).slice(0, 160);
        if (input.email !== undefined) lead.email = normalizeEmail(input.email);
        if (input.phone !== undefined) lead.phone = clean(input.phone).slice(0, 80);
        lead.updatedAt = new Date().toISOString();

        appendActivity(lead, {
          type: "lead_update",
          actorId: context.user.id,
          actorName: context.user.name,
          status: lead.status,
          note: cleanMultiline(input.activityNote || input.afterCallNotes || "Lead updated", 1200),
        });
      },
    });
  }

  function logCall(user, campaignId, leadId, input = {}) {
    const context = requireUserPermission(user, "update_leads");
    const outcome = normalizeLeadStatus(input.outcome || input.status || "attempted");

    return mutateLead({
      store,
      context,
      campaignId,
      leadId,
      mutate: (lead) => {
        lead.status = outcome;
        lead.lastCallAt = new Date().toISOString();
        lead.lastCallBy = context.user.id;
        lead.callAttempts = Number(lead.callAttempts || 0) + 1;
        lead.afterCallNotes = cleanMultiline(input.notes, 5000);
        lead.nextActionAt = validDate(input.nextActionAt);
        if (Array.isArray(input.tags)) lead.tags = sanitizeTags(input.tags);
        lead.updatedAt = new Date().toISOString();
        appendActivity(lead, {
          type: "call",
          actorId: context.user.id,
          actorName: context.user.name,
          status: outcome,
          note: cleanMultiline(input.notes, 1200),
          durationSeconds: Math.max(0, Number(input.durationSeconds || 0)),
          nextActionAt: lead.nextActionAt || "",
        });
      },
    });
  }

  async function sendLeadEmail(user, campaignId, leadId, input = {}) {
    const context = requireUserPermission(user, "send_lead_email");
    const { campaign, lead } = getLeadForUser({
      store,
      context,
      campaignId,
      leadId,
    });

    if (lead.status === "do_not_call" || lead.suppressedAt) {
      throw createError(400, "Outreach is disabled for this lead.");
    }
    if (!normalizeEmail(lead.email)) {
      throw createError(400, "This lead does not have a valid email address.");
    }

    const ownerId = campaign.ownerId || context.workspace?.ownerId || context.user.id;
    const result = await email.sendCampaignEmail(ownerId, {
      accountId: input.accountId || campaign.emailAccountId || "",
      to: lead.email,
      subject: clean(input.subject).slice(0, 180),
      body: cleanMultiline(input.body, 20_000),
      campaignId,
      leadId,
    });

    mutateLead({
      store,
      context,
      campaignId,
      leadId,
      mutate: (target) => {
        target.lastEmailAt = new Date().toISOString();
        target.lastEmailBy = context.user.id;
        target.emailCount = Number(target.emailCount || 0) + 1;
        appendActivity(target, {
          type: "email",
          actorId: context.user.id,
          actorName: context.user.name,
          note: `Email sent: ${input.subject}`,
          messageId: result.messageId || "",
        });
      },
    });

    return result;
  }

  function listMyLeads(user, filters = {}) {
    const context = getContext(user);
    const isManager = hasPermission(context, "view_all_leads");
    const output = [];

    for (const campaign of store.read().campaigns || []) {
      if (campaign.workspaceId !== context.workspaceId) continue;
      ensureLeadShape(campaign, context.user);

      for (const lead of campaign.leads || []) {
        if (!isManager && lead.assignedTo !== context.user.id) continue;
        if (filters.status && lead.status !== filters.status) continue;
        if (filters.assignedTo && lead.assignedTo !== filters.assignedTo) continue;

        output.push({
          ...lead,
          campaignId: campaign.id,
          campaignName: campaign.name,
          emailAccountId: campaign.emailAccountId || "",
        });
      }
    }

    return output.sort((a, b) => {
      const aDue = Date.parse(a.nextActionAt || "9999-12-31");
      const bDue = Date.parse(b.nextActionAt || "9999-12-31");
      return aDue - bDue;
    });
  }

  function performance(user, input = {}) {
    const context = requireUserPermission(user, "view_team_performance");
    const state = store.read();
    const from = input.from ? Date.parse(input.from) : Date.now() - 7 * 86400000;
    const to = input.to ? Date.parse(input.to) : Date.now() + 86400000;
    const members = (state.users || []).filter(
      (item) => item.workspaceId === context.workspaceId
    );
    const rows = members.map((member) => ({
      memberId: member.id,
      name: member.name,
      email: member.email,
      role: member.workspaceRole,
      assigned: 0,
      callAttempts: 0,
      connected: 0,
      qualified: 0,
      meetings: 0,
      emails: 0,
      overdue: 0,
      statusCounts: {},
      tagCounts: {},
      topTags: [],
      lastActivityAt: "",
    }));
    const byId = new Map(rows.map((row) => [row.memberId, row]));

    for (const campaign of state.campaigns || []) {
      if (campaign.workspaceId !== context.workspaceId) continue;
      for (const lead of campaign.leads || []) {
        if (lead.assignedTo && byId.has(lead.assignedTo)) {
          const row = byId.get(lead.assignedTo);
          row.assigned += 1;
          row.statusCounts[lead.status || "new"] =
            Number(row.statusCounts[lead.status || "new"] || 0) + 1;
          for (const tag of lead.tags || []) {
            row.tagCounts[tag] = Number(row.tagCounts[tag] || 0) + 1;
          }
          if (lead.nextActionAt && Date.parse(lead.nextActionAt) < Date.now() && !["meeting_booked", "not_interested", "do_not_call"].includes(lead.status)) {
            row.overdue += 1;
          }
        }

        for (const activity of lead.activities || lead.timeline || []) {
          const at = Date.parse(activity.createdAt || activity.at || 0);
          if (!activity.actorId || !byId.has(activity.actorId) || at < from || at >= to) continue;
          const row = byId.get(activity.actorId);
          if (activity.type === "call") {
            row.callAttempts += 1;
            if (["connected", "send_information", "callback", "qualified", "meeting_booked"].includes(activity.status)) row.connected += 1;
            if (["qualified", "meeting_booked"].includes(activity.status)) row.qualified += 1;
            if (activity.status === "meeting_booked") row.meetings += 1;
          }
          if (activity.type === "email") row.emails += 1;
          if (!row.lastActivityAt || at > Date.parse(row.lastActivityAt)) row.lastActivityAt = new Date(at).toISOString();
        }
      }
    }

    for (const row of rows) {
      row.connectRate = row.callAttempts ? Math.round((row.connected / row.callAttempts) * 100) : 0;
      row.meetingRate = row.connected ? Math.round((row.meetings / row.connected) * 100) : 0;
      row.topTags = Object.entries(row.tagCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([tag, count]) => ({ tag, count }));
      delete row.tagCounts;
    }

    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      rows,
      totals: rows.reduce(
        (total, row) => {
          for (const key of ["assigned", "callAttempts", "connected", "qualified", "meetings", "emails", "overdue"]) total[key] += row[key];
          return total;
        },
        { assigned: 0, callAttempts: 0, connected: 0, qualified: 0, meetings: 0, emails: 0, overdue: 0 }
      ),
    };
  }

  return {
    ensureWorkspaceForUser,
    getContext,
    listMembers,
    inviteMember,
    acceptInvite,
    updateMember,
    assignLead,
    bulkAssignLeads,
    updateLead,
    logCall,
    sendLeadEmail,
    listMyLeads,
    performance,
    requireUserPermission,
    canAccessCampaign,
    permissionsForRole,
  };
}

export function permissionsForRole(roleValue) {
  const role = normalizeRole(roleValue);
  const base = ["view_assigned_leads", "update_leads", "send_lead_email", "use_ai"];
  if (role === "owner") return ["*"];
  if (role === "manager") return [
    ...base,
    "manage_team",
    "assign_leads",
    "view_all_leads",
    "view_team_performance",
    "manage_campaigns",
    "create_audits",
    "view_audits",
  ];
  if (role === "viewer") return ["view_assigned_leads", "use_ai"];
  return base;
}

export function canAccessCampaign(campaign, context) {
  if (!campaign || !context) return false;
  if (campaign.workspaceId && campaign.workspaceId === context.workspaceId) return true;
  return [campaign.userId, campaign.ownerId, campaign.createdBy].includes(context.user?.id);
}

function mutateLead({ store, context, campaignId, leadId, mutate, allowAll = false }) {
  let updated = null;
  store.update((state) => {
    const campaign = (state.campaigns || []).find(
      (item) => item.id === campaignId && canAccessCampaign(item, context)
    );
    if (!campaign) return;
    ensureLeadShape(campaign, context.user);
    const lead = (campaign.leads || []).find((item) => item.id === leadId);
    if (!lead) return;
    if (!allowAll && !hasPermission(context, "view_all_leads") && lead.assignedTo !== context.user.id) {
      throw createError(403, "This lead is not assigned to you.");
    }
    mutate(lead, campaign);
    campaign.updatedAt = new Date().toISOString();
    updated = { ...lead, campaignId: campaign.id, campaignName: campaign.name };
  });
  if (!updated) throw createError(404, "Lead not found.");
  return updated;
}

function getLeadForUser({ store, context, campaignId, leadId }) {
  const campaign = (store.read().campaigns || []).find(
    (item) => item.id === campaignId && canAccessCampaign(item, context)
  );
  if (!campaign) throw createError(404, "Campaign not found.");
  ensureLeadShape(campaign, context.user);
  const lead = (campaign.leads || []).find((item) => item.id === leadId);
  if (!lead) throw createError(404, "Lead not found.");
  if (!hasPermission(context, "view_all_leads") && lead.assignedTo !== context.user.id) {
    throw createError(403, "This lead is not assigned to you.");
  }
  return { campaign, lead };
}

function ensureLeadShape(campaign, owner) {
  campaign.leads = Array.isArray(campaign.leads) ? campaign.leads : [];
  for (const lead of campaign.leads) {
    lead.id = lead.id || `lead_${crypto.randomUUID()}`;
    lead.status = normalizeLeadStatus(lead.status || lead.pipelineStatus || "new");
    lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
    lead.activities = Array.isArray(lead.activities)
      ? lead.activities
      : Array.isArray(lead.timeline)
        ? lead.timeline
        : [];
    lead.callAttempts = Number(lead.callAttempts || 0);
    lead.emailCount = Number(lead.emailCount || 0);
    lead.createdAt = lead.createdAt || campaign.createdAt || new Date().toISOString();
    lead.updatedAt = lead.updatedAt || lead.createdAt;
    if (!lead.assignedTo && campaign.defaultAssigneeId) lead.assignedTo = campaign.defaultAssigneeId;
    if (!lead.assignedToName && lead.assignedTo === owner?.id) lead.assignedToName = owner?.name || "";
  }
}

function appendActivity(lead, input = {}) {
  lead.activities = Array.isArray(lead.activities) ? lead.activities : [];
  lead.activities.unshift({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  });
}


function hasPermission(context, permission) {
  return context.permissions?.includes("*") || context.permissions?.includes(permission);
}

function normalizeRole(value) {
  const role = String(value || "caller").toLowerCase().trim();
  return TEAM_ROLES.includes(role) ? role : "caller";
}

function normalizeLeadStatus(value) {
  const status = String(value || "new").toLowerCase().trim().replace(/\s+/g, "_");
  return LEAD_STATUSES.includes(status) ? status : "attempted";
}

function publicMember(user) {
  const avatarUrl =
    user.avatarUrl ||
    user.photoUrl ||
    user.profileImage ||
    "";

  return {
    id: user.id,
    name: user.name,
    fullName: user.fullName || user.name || "",
    email: user.email,
    workspaceRole: normalizeRole(user.workspaceRole || user.role),
    role: normalizeRole(user.workspaceRole || user.role),
    permissions: user.permissions || permissionsForRole(user.workspaceRole),
    active: user.active !== false,
    avatarUrl,
    photoUrl: avatarUrl,
    profileImage: avatarUrl,
    availabilityStatus: user.availabilityStatus || "offline",
    availabilityMessage: user.availabilityMessage || "",
    availabilityUpdatedAt: user.availabilityUpdatedAt || user.updatedAt || "",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function roleLabel(role) {
  return role === "manager" ? "Team manager" : role === "viewer" ? "Workspace viewer" : "Sales caller";
}

function sanitizeTags(values) {
  return [...new Set(values.map((value) => clean(value).toLowerCase()).filter(Boolean))].slice(0, 20);
}

function validDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanMultiline(value, max = 5000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
