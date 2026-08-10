import crypto from "node:crypto";

const CLOSED_LEAD_STATUSES = new Set([
  "completed",
  "converted",
  "qualified",
  "meeting_booked",
  "not_interested",
  "invalid_number",
  "do_not_contact",
  "do_not_call",
  "exhausted",
]);

const CLOSED_TASK_STATUSES = new Set([
  "completed",
  "cancelled",
]);

const DEFAULT_DAILY_LEAD_LIMIT = clampInteger(
  process.env.DEFAULT_RESOURCE_LEAD_LIMIT || 100,
  100,
  1,
  5000
);

/**
 * Manager resource whiteboard service.
 *
 * The service intentionally works with the existing ReachFly state model:
 * - callers are workspace users with role "caller"
 * - lead assignments live on campaign.leads via assignedTo / assigneeId
 * - tasks are managed by teamCommunicationService
 * - Telnyx credentials are managed by telnyxCallService
 * - connected email accounts remain owned by the workspace manager and are
 *   assigned to resources by sanitized account ID only
 */
export function createResourceBoardService({
  store,
  workspaceService,
  teamCommunicationService,
  teamControlService,
  telnyxCallService,
  email,
  hashPassword,
} = {}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createResourceBoardService requires a store exposing read() and update()."
    );
  }

  if (typeof hashPassword !== "function") {
    throw new Error(
      "createResourceBoardService requires the server hashPassword function."
    );
  }

  function getContext(user, state) {
    return workspaceService?.getContext?.(user, state) || {
      user,
      workspaceId: user?.workspaceId || "",
      workspace: (state.workspaces || []).find(
        (item) => item.id === user?.workspaceId
      ) || null,
      role: user?.workspaceRole || user?.role || "caller",
      permissions: user?.permissions || [],
    };
  }

  function requireManagerAccess(user, state) {
    const ctx = getContext(user, state);
    const role = normalizeRole(
      ctx.role || user?.workspaceRole || user?.role
    );

    if (!["owner", "admin", "manager"].includes(role)) {
      throw httpError(
        403,
        "Manager access is required for the resource board."
      );
    }

    if (!ctx.workspaceId) {
      throw httpError(403, "Workspace access is required.");
    }

    return ctx;
  }

  function getBoard(user, query = {}) {
    const state = store.read();
    const ctx = requireManagerAccess(user, state);
    const callers = listWorkspaceCallers(state, ctx.workspaceId);
    const assignments = collectAssignments(state, ctx.workspaceId);
    const tasks = safeListTasks(user, query);
    const presence = safeListPresence(user);
    const dialerMap = buildDialerMap(user, state, ctx.workspaceId);
    const senderMap = buildSenderMap(user, state, ctx.workspaceId);
    const emailAccounts = listSanitizedEmailAccounts(user, ctx);
    const phoneNumbers = buildPhonePool(state, ctx.workspaceId, callers);

    const presenceMap = new Map(
      presence.map((item) => [
        clean(item.userId || item.id),
        item,
      ])
    );

    const resources = callers.map((member) =>
      buildResource({
        member,
        state,
        workspaceId: ctx.workspaceId,
        assignments,
        tasks,
        presence: presenceMap.get(member.id) || null,
        dialer: dialerMap.get(member.id) || null,
        sender: senderMap.get(member.id) || null,
        emailAccounts,
      })
    );

    const activity = Array.isArray(state.resourceBoardActivity)
      ? state.resourceBoardActivity
          .filter((item) => item.workspaceId === ctx.workspaceId)
          .slice(0, 40)
          .map(publicActivity)
      : [];

    return {
      ok: true,
      workspace: publicWorkspace(ctx.workspace),
      generatedAt: new Date().toISOString(),
      summary: {
        resources: resources.length,
        leads: assignments.length,
        unassignedLeads: assignments.filter(
          (assignment) => !getAssignmentUserId(assignment)
        ).length,
        activeLeads: assignments.filter(
          (assignment) => !isLeadClosed(assignment.status)
        ).length,
        tasks: tasks.length,
        openTasks: tasks.filter(
          (task) => !CLOSED_TASK_STATUSES.has(normalizeStatus(task.status))
        ).length,
        connectedEmailAccounts: emailAccounts.length,
        configuredPhoneNumbers: phoneNumbers.length,
        sparePhoneNumbers: phoneNumbers.filter((item) => !item.assignedTo).length,
      },
      resources,
      assignments,
      tasks: tasks.map(publicTask),
      emailAccounts,
      phoneNumbers,
      activity,
    };
  }

  function assignLead(user, assignmentId, input = {}) {
    const state = store.read();
    const ctx = requireManagerAccess(user, state);
    const requestedResourceId = clean(
      input.resourceId || input.assigneeId || input.assignedTo
    );

    const target = requestedResourceId
      ? findWorkspaceCaller(state, ctx.workspaceId, requestedResourceId)
      : null;

    if (requestedResourceId && !target) {
      throw httpError(404, "The selected caller resource was not found.");
    }

    let result = null;

    store.update((draft) => {
      ensureBoardState(draft);

      const found = findLeadAssignment(
        draft,
        ctx.workspaceId,
        assignmentId
      );

      if (!found) {
        return;
      }

      const { campaign, lead } = found;
      const previousResourceId = clean(
        lead.assignedTo || lead.assigneeId
      );

      if (target && previousResourceId !== target.id) {
        const assignments = collectAssignments(draft, ctx.workspaceId);
        const currentOpenCount = assignments.filter(
          (assignment) =>
            getAssignmentUserId(assignment) === target.id &&
            !isLeadClosed(assignment.status) &&
            assignment.id !== stableAssignmentId(campaign, lead)
        ).length;

        const limit = getResourceLimit(
          draft,
          ctx.workspaceId,
          target
        );

        if (
          input.ignoreLimit !== true &&
          currentOpenCount >= limit
        ) {
          throw httpError(
            409,
            `${target.name || target.email} has reached the lead limit of ${limit}.`
          );
        }
      }

      const now = new Date().toISOString();
      lead.assignmentId = stableAssignmentId(campaign, lead, true);
      lead.assignedTo = target?.id || "";
      lead.assigneeId = target?.id || "";
      lead.assignedToName = target
        ? target.name || target.fullName || target.email || "Caller"
        : "";
      lead.assignedBy = user.id;
      lead.assignedByName = user.name || user.email || "Manager";
      lead.assignedAt = target ? now : "";
      lead.queueStatus = target
        ? lead.queueStatus === "unassigned"
          ? "ready"
          : lead.queueStatus || "ready"
        : "unassigned";
      lead.status = normalizeStatus(lead.status || "assigned");
      lead.updatedAt = now;
      campaign.updatedAt = now;

      appendLeadTimeline(lead, {
        type: target ? "lead_reassigned" : "lead_unassigned",
        actorId: user.id,
        actorName: user.name || user.email || "Manager",
        previousAssigneeId: previousResourceId,
        assigneeId: target?.id || "",
        assigneeName: target?.name || target?.email || "",
        createdAt: now,
      });

      appendActivity(draft, {
        workspaceId: ctx.workspaceId,
        type: target ? "lead_assigned" : "lead_unassigned",
        actorId: user.id,
        actorName: user.name || user.email || "Manager",
        resourceId: target?.id || "",
        resourceName: target?.name || target?.email || "Unassigned",
        assignmentId: lead.assignmentId,
        leadId: lead.id,
        title: `${lead.business || lead.name || lead.phone || "Lead"} ${
          target ? `assigned to ${target.name || target.email}` : "moved to unassigned"
        }`,
        createdAt: now,
      });

      result = publicAssignment(campaign, lead);
    });

    if (!result) {
      throw httpError(404, "Lead assignment not found.");
    }

    return {
      ok: true,
      assignment: result,
    };
  }

  function assignLeads(user, input = {}) {
    const ids = Array.isArray(input.assignmentIds)
      ? [...new Set(input.assignmentIds.map(clean).filter(Boolean))]
      : [];

    if (!ids.length) {
      throw httpError(400, "Select at least one lead assignment.");
    }

    const results = [];

    for (const assignmentId of ids.slice(0, 500)) {
      try {
        results.push({
          ok: true,
          ...assignLead(user, assignmentId, input),
        });
      } catch (error) {
        results.push({
          ok: false,
          assignmentId,
          error: error.message,
          statusCode: error.statusCode || 500,
        });

        if (Number(error.statusCode) === 409) {
          break;
        }
      }
    }

    return {
      ok: results.every((item) => item.ok),
      updated: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    };
  }

  function setResourceLimit(user, resourceId, input = {}) {
    const state = store.read();
    const ctx = requireManagerAccess(user, state);
    const resource = findWorkspaceCaller(
      state,
      ctx.workspaceId,
      resourceId
    );

    if (!resource) {
      throw httpError(404, "Caller resource not found.");
    }

    const dailyLeadLimit = clampInteger(
      input.dailyLeadLimit ?? input.leadLimit ?? input.limit,
      DEFAULT_DAILY_LEAD_LIMIT,
      1,
      5000
    );

    let updated = null;

    store.update((draft) => {
      ensureBoardState(draft);
      draft.resourceLeadLimits[ctx.workspaceId] =
        draft.resourceLeadLimits[ctx.workspaceId] || {};
      draft.resourceLeadLimits[ctx.workspaceId][resource.id] = dailyLeadLimit;

      const target = (draft.users || []).find(
        (item) => item.id === resource.id
      );

      if (target) {
        target.dailyLeadLimit = dailyLeadLimit;
        target.leadAssignmentLimit = dailyLeadLimit;
        target.updatedAt = new Date().toISOString();
        updated = publicMember(target);
      }

      appendActivity(draft, {
        workspaceId: ctx.workspaceId,
        type: "resource_limit_updated",
        actorId: user.id,
        actorName: user.name || user.email || "Manager",
        resourceId: resource.id,
        resourceName: resource.name || resource.email,
        title: `Lead limit set to ${dailyLeadLimit} for ${
          resource.name || resource.email
        }`,
        createdAt: new Date().toISOString(),
      });
    });

    return {
      ok: true,
      member: updated || publicMember(resource),
      dailyLeadLimit,
    };
  }

  async function assignTask(user, taskId, input = {}) {
    const state = store.read();
    const ctx = requireManagerAccess(user, state);
    const resourceId = clean(
      input.resourceId || input.assigneeId || input.assignedToUserId
    );

    const resource = resourceId
      ? findWorkspaceCaller(state, ctx.workspaceId, resourceId)
      : null;

    if (resourceId && !resource) {
      throw httpError(404, "The selected caller resource was not found.");
    }

    if (!teamCommunicationService?.updateTask) {
      throw httpError(503, "Task assignment service is unavailable.");
    }

    const currentTask = safeListTasks(user, {}).find(
      (task) => clean(task.id) === clean(taskId)
    );

    if (!currentTask) {
      throw httpError(404, "Task not found.");
    }

    const task = teamCommunicationService.updateTask(
      user,
      taskId,
      {
        assigneeId: resource?.id || "",
        assignedToUserId: resource?.id || "",
        assigneeName: resource?.name || resource?.email || "",
        status:
          input.status ||
          normalizeStatus(currentTask.status || "assigned"),
      }
    );

    store.update((draft) => {
      ensureBoardState(draft);
      appendActivity(draft, {
        workspaceId: ctx.workspaceId,
        type: resource ? "task_assigned" : "task_unassigned",
        actorId: user.id,
        actorName: user.name || user.email || "Manager",
        resourceId: resource?.id || "",
        resourceName: resource?.name || resource?.email || "Unassigned",
        taskId,
        title: `${currentTask.title || "Task"} ${
          resource ? `assigned to ${resource.name || resource.email}` : "unassigned"
        }`,
        createdAt: new Date().toISOString(),
      });
    });

    return {
      ok: true,
      task: publicTask(task),
    };
  }

  async function assignChannels(user, resourceId, input = {}) {
    const initialState = store.read();
    const ctx = requireManagerAccess(user, initialState);
    const resource = findWorkspaceCaller(
      initialState,
      ctx.workspaceId,
      resourceId
    );

    if (!resource) {
      throw httpError(404, "Caller resource not found.");
    }

    const requestedPhone = normalizePhone(
      input.phoneNumber ?? input.fromNumber ?? resource.telnyxFromNumber ?? ""
    );
    const requestedEmailAccountId = clean(
      input.emailAccountId ?? input.senderId ?? resource.emailAccountId ?? ""
    );

    const emailAccounts = listSanitizedEmailAccounts(user, ctx);
    const emailAccount = requestedEmailAccountId
      ? emailAccounts.find((item) => item.id === requestedEmailAccountId)
      : null;

    if (requestedEmailAccountId && !emailAccount) {
      throw httpError(
        400,
        "The selected email account is not connected to this workspace manager."
      );
    }

    if (requestedPhone) {
      const pool = configuredPhoneNumbers(initialState, ctx.workspaceId);

      if (pool.length && !pool.includes(requestedPhone)) {
        throw httpError(
          400,
          `${requestedPhone} is not included in the configured manual Telnyx caller-number pool.`
        );
      }

      /*
       * Do not save a number just because it exists in ReachFly. It must also
       * belong to the manual WebRTC Credential Connection in Telnyx. This
       * prevents a SIP/AI number or a number on another connection from being
       * assigned to a manual caller and then failing in the dialer.
       */
      if (
        telnyxCallService?.validateManualCallerNumber
      ) {
        const validation =
          await telnyxCallService
            .validateManualCallerNumber(
              requestedPhone
            );

        if (!validation?.ok) {
          throw httpError(
            409,
            validation?.message ||
              `${requestedPhone} is not available for the manual Telnyx dialer.`
          );
        }
      }

      const conflict = listWorkspaceCallers(initialState, ctx.workspaceId).find(
        (member) =>
          member.id !== resource.id &&
          normalizePhone(
            member.telnyxFromNumber ||
              member.dialerNumber ||
              member.phoneNumber ||
              member.phone
          ) === requestedPhone
      );

      const dialerConflict = (initialState.telnyxDialers || []).find(
        (dialer) =>
          dialer.workspaceId === ctx.workspaceId &&
          dialer.userId !== resource.id &&
          dialer.active !== false &&
          normalizePhone(dialer.fromNumber) === requestedPhone
      );

      if (conflict || dialerConflict) {
        throw httpError(
          409,
          `${requestedPhone} is already assigned to ${
            conflict?.name || conflict?.email || "another resource"
          }.`
        );
      }
    }

    let updatedUser = null;

    store.update((draft) => {
      ensureBoardState(draft);
      const target = (draft.users || []).find(
        (item) => item.id === resource.id
      );

      if (!target) {
        return;
      }

      const now = new Date().toISOString();
      target.telnyxFromNumber = requestedPhone;
      target.dialerNumber = requestedPhone;
      target.assignedPhoneNumber = requestedPhone;
      target.emailAccountId = requestedEmailAccountId;
      target.assignedEmailAccountId = requestedEmailAccountId;
      target.senderEmail = emailAccount?.fromEmail || "";
      target.assignedSenderEmail = emailAccount?.fromEmail || "";
      target.updatedAt = now;

      const existingDialer = (draft.telnyxDialers || []).find(
        (dialer) =>
          dialer.workspaceId === ctx.workspaceId &&
          dialer.userId === resource.id &&
          dialer.active !== false
      );

      if (existingDialer) {
        existingDialer.fromNumber = requestedPhone;
        existingDialer.updatedAt = now;
      }

      const existingEmailAssignment = draft.resourceEmailAssignments.find(
        (item) =>
          item.workspaceId === ctx.workspaceId &&
          item.userId === resource.id
      );

      const emailPatch = {
        workspaceId: ctx.workspaceId,
        userId: resource.id,
        emailAccountId: requestedEmailAccountId,
        fromEmail: emailAccount?.fromEmail || "",
        label: emailAccount?.label || emailAccount?.name || "",
        updatedAt: now,
      };

      if (existingEmailAssignment) {
        Object.assign(existingEmailAssignment, emailPatch);
      } else {
        draft.resourceEmailAssignments.push({
          id: crypto.randomUUID(),
          ...emailPatch,
          createdAt: now,
        });
      }

      appendActivity(draft, {
        workspaceId: ctx.workspaceId,
        type: "resource_channels_updated",
        actorId: user.id,
        actorName: user.name || user.email || "Manager",
        resourceId: resource.id,
        resourceName: resource.name || resource.email,
        title: `Channels updated for ${resource.name || resource.email}`,
        phoneNumber: requestedPhone,
        fromEmail: emailAccount?.fromEmail || "",
        createdAt: now,
      });

      updatedUser = { ...target };
    });

    if (!updatedUser) {
      throw httpError(404, "Caller resource not found.");
    }

    const warnings = [];
    let dialer = null;

    if (requestedPhone && telnyxCallService?.ensureCallerDialer) {
      try {
        dialer = await telnyxCallService.ensureCallerDialer(updatedUser);
      } catch (error) {
        warnings.push(
          `Phone assignment was saved, but Telnyx credential provisioning failed: ${error.message}`
        );
      }
    }

    if (requestedEmailAccountId && teamControlService?.saveSender) {
      try {
        teamControlService.saveSender(user, {
          userId: resource.id,
          memberId: resource.id,
          senderId: requestedEmailAccountId,
          emailAccountId: requestedEmailAccountId,
          fromEmail: emailAccount?.fromEmail || "",
          label: emailAccount?.label || emailAccount?.name || "",
          active: true,
        });
      } catch (error) {
        warnings.push(
          `Email assignment was saved, but the legacy sender registry could not be updated: ${error.message}`
        );
      }
    }

    return {
      ok: warnings.length === 0,
      resource: publicMember(updatedUser),
      phoneNumber: requestedPhone,
      emailAccount,
      dialer: dialer ? publicDialer(dialer) : null,
      warnings,
    };
  }

  async function createResource(user, input = {}) {
    const state = store.read();
    const ctx = requireManagerAccess(user, state);
    const name = clean(input.name || input.fullName).slice(0, 160);
    const emailAddress = normalizeEmail(input.email);
    const password = String(input.password || input.temporaryPassword || "");
    const dailyLeadLimit = clampInteger(
      input.dailyLeadLimit ?? input.leadLimit,
      DEFAULT_DAILY_LEAD_LIMIT,
      1,
      5000
    );

    if (!name) {
      throw httpError(400, "Resource name is required.");
    }

    if (!emailAddress || !emailAddress.includes("@")) {
      throw httpError(400, "A valid login email is required.");
    }

    if (password.length < 10) {
      throw httpError(
        400,
        "Temporary password must contain at least 10 characters."
      );
    }

    if (
      (state.users || []).some(
        (item) => normalizeEmail(item.email) === emailAddress
      )
    ) {
      throw httpError(409, "An account with this email already exists.");
    }

    const workspace = ctx.workspace || {};
    const callerTemplate = listWorkspaceCallers(state, ctx.workspaceId)[0] || {};
    const now = new Date().toISOString();
    const resource = {
      id: crypto.randomUUID(),
      name,
      fullName: name,
      email: emailAddress,
      passwordHash: hashPassword(password),
      accountType:
        workspace.accountType || user.accountType || "company",
      workspaceType:
        workspace.workspaceType || user.workspaceType || "company",
      companyName:
        workspace.companyName || workspace.name || user.companyName || "",
      workspaceName:
        workspace.name || user.workspaceName || user.companyName || "",
      workspaceId: ctx.workspaceId,
      companyId: workspace.companyId || user.companyId || "",
      role: "caller",
      workspaceRole: "caller",
      jobTitle: clean(input.jobTitle || "Caller").slice(0, 120),
      department: clean(input.department || "Sales").slice(0, 120),
      permissions: Array.isArray(callerTemplate.permissions)
        ? [...callerTemplate.permissions]
        : [
            "view_assigned_leads",
            "make_calls",
            "view_team_communication",
            "manage_own_attendance",
          ],
      active: true,
      isActive: true,
      status: "active",
      availabilityStatus: "offline",
      dailyLeadLimit,
      leadAssignmentLimit: dailyLeadLimit,
      mustChangePassword: input.mustChangePassword !== false,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      ensureBoardState(draft);
      draft.users = Array.isArray(draft.users) ? draft.users : [];
      draft.users.push(resource);
      draft.resourceLeadLimits[ctx.workspaceId] =
        draft.resourceLeadLimits[ctx.workspaceId] || {};
      draft.resourceLeadLimits[ctx.workspaceId][resource.id] = dailyLeadLimit;

      draft.activity = Array.isArray(draft.activity) ? draft.activity : [];
      draft.activity.unshift({
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        type: "team_member_created",
        title: `${name} was created as a caller resource`,
        actorId: user.id,
        userId: resource.id,
        createdAt: now,
      });

      appendActivity(draft, {
        workspaceId: ctx.workspaceId,
        type: "resource_created",
        actorId: user.id,
        actorName: user.name || user.email || "Manager",
        resourceId: resource.id,
        resourceName: resource.name,
        title: `${resource.name} was added as a caller resource`,
        createdAt: now,
      });
    });

    let channelResult = null;
    const warnings = [];

    if (input.phoneNumber || input.emailAccountId) {
      try {
        channelResult = await assignChannels(user, resource.id, {
          phoneNumber: input.phoneNumber || "",
          emailAccountId: input.emailAccountId || "",
        });
        warnings.push(...(channelResult.warnings || []));
      } catch (error) {
        warnings.push(error.message);
      }
    }

    return {
      ok: warnings.length === 0,
      resource: {
        ...publicMember(resource),
        phoneNumber: channelResult?.phoneNumber || "",
        emailAccount: channelResult?.emailAccount || null,
      },
      credentials: {
        email: emailAddress,
        temporaryPassword: password,
        mustChangePassword: resource.mustChangePassword,
      },
      warnings,
    };
  }

  function updateResource(user, resourceId, input = {}) {
    const state = store.read();
    const ctx = requireManagerAccess(user, state);
    const resource = findWorkspaceCaller(
      state,
      ctx.workspaceId,
      resourceId,
      { includeInactive: true }
    );

    if (!resource) {
      throw httpError(404, "Caller resource not found.");
    }

    let updated = null;

    store.update((draft) => {
      const target = (draft.users || []).find(
        (item) => item.id === resource.id
      );

      if (!target) {
        return;
      }

      if (input.name !== undefined) {
        const name = clean(input.name).slice(0, 160);
        if (!name) {
          throw httpError(400, "Resource name cannot be empty.");
        }
        target.name = name;
        target.fullName = name;
      }

      if (input.active !== undefined || input.isActive !== undefined) {
        const active = input.active ?? input.isActive;
        target.active = active !== false;
        target.isActive = active !== false;
        target.status = active === false ? "suspended" : "active";
      }

      if (input.password) {
        const password = String(input.password);
        if (password.length < 10) {
          throw httpError(400, "Password must contain at least 10 characters.");
        }
        target.passwordHash = hashPassword(password);
        target.mustChangePassword = input.mustChangePassword !== false;
      }

      target.updatedAt = new Date().toISOString();
      updated = { ...target };
    });

    return {
      ok: true,
      resource: publicMember(updated),
      credentials: input.password
        ? {
            email: updated.email,
            temporaryPassword: String(input.password),
            mustChangePassword: updated.mustChangePassword !== false,
          }
        : null,
    };
  }

  function listSanitizedEmailAccounts(user, ctx = null) {
    if (!email?.getSettings) {
      return [];
    }

    const ownerId =
      ctx?.workspace?.ownerId ||
      ctx?.workspace?.createdBy ||
      "";

    const accountOwners = [
      user?.id,
      ownerId,
    ].filter(Boolean);

    const merged = new Map();

    for (const accountOwnerId of [...new Set(accountOwners)]) {
      let settings = {};

      try {
        settings = email.getSettings(accountOwnerId) || {};
      } catch {
        continue;
      }

      const accounts = Array.isArray(settings.accounts)
        ? settings.accounts
        : settings.id || settings.fromEmail || settings.username
          ? [settings]
          : [];

      for (const rawAccount of accounts) {
        const account = sanitizeEmailAccount(rawAccount);
        if (account.id && account.fromEmail) {
          merged.set(account.id, account);
        }
      }
    }

    return [...merged.values()];
  }

  function safeListTasks(user, query) {
    try {
      const result = teamCommunicationService?.listTasks?.(user, query);
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  function safeListPresence(user) {
    try {
      const result = teamCommunicationService?.listPresence?.(user);
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  function buildDialerMap(user, state, workspaceId) {
    const map = new Map();

    try {
      const result = telnyxCallService?.listDialers?.(user);
      for (const member of result?.members || []) {
        map.set(clean(member.id || member.userId), member.dialer || member);
      }
    } catch {
      for (const dialer of state.telnyxDialers || []) {
        if (dialer.workspaceId === workspaceId && dialer.active !== false) {
          map.set(dialer.userId, dialer);
        }
      }
    }

    return map;
  }

  function buildSenderMap(user, state, workspaceId) {
    const map = new Map();

    try {
      const result = teamControlService?.listSenders?.(user);
      for (const sender of result || []) {
        map.set(
          clean(sender.userId || sender.memberId || sender.assigneeId),
          sender
        );
      }
    } catch {
      // The resourceEmailAssignments store is the authoritative fallback.
    }

    for (const assignment of state.resourceEmailAssignments || []) {
      if (assignment.workspaceId === workspaceId) {
        map.set(assignment.userId, {
          ...(map.get(assignment.userId) || {}),
          ...assignment,
        });
      }
    }

    return map;
  }

  return {
    getBoard,
    assignLead,
    assignLeads,
    assignTask,
    setResourceLimit,
    assignChannels,
    createResource,
    updateResource,
  };
}

function buildResource({
  member,
  state,
  workspaceId,
  assignments,
  tasks,
  presence,
  dialer,
  sender,
  emailAccounts,
}) {
  const memberAssignments = assignments.filter(
    (assignment) => getAssignmentUserId(assignment) === member.id
  );
  const memberTasks = tasks.filter(
    (task) =>
      clean(task.assigneeId || task.assignedToUserId) === member.id
  );
  const dailyLeadLimit = getResourceLimit(state, workspaceId, member);
  const activeLeadCount = memberAssignments.filter(
    (assignment) => !isLeadClosed(assignment.status)
  ).length;
  const completedLeadCount = memberAssignments.filter(
    (assignment) => isLeadClosed(assignment.status)
  ).length;
  const completedTaskCount = memberTasks.filter((task) =>
    CLOSED_TASK_STATUSES.has(normalizeStatus(task.status))
  ).length;
  const emailAccountId = clean(
    sender?.emailAccountId ||
      sender?.senderId ||
      member.assignedEmailAccountId ||
      member.emailAccountId
  );
  const emailAccount = emailAccounts.find(
    (account) => account.id === emailAccountId
  );

  return {
    ...publicMember(member),
    presence: publicPresence(presence),
    dailyLeadLimit,
    activeLeadCount,
    completedLeadCount,
    totalLeadCount: memberAssignments.length,
    remainingLeadCapacity: Math.max(0, dailyLeadLimit - activeLeadCount),
    leadUtilizationPercent: Math.min(
      100,
      Math.round((activeLeadCount / Math.max(1, dailyLeadLimit)) * 100)
    ),
    openTaskCount: memberTasks.length - completedTaskCount,
    completedTaskCount,
    totalTaskCount: memberTasks.length,
    phoneNumber: normalizePhone(
      dialer?.fromNumber ||
        member.telnyxFromNumber ||
        member.dialerNumber ||
        member.assignedPhoneNumber
    ),
    dialer: dialer ? publicDialer(dialer) : null,
    emailAccountId,
    emailAccount: emailAccount ||
      (sender?.fromEmail
        ? {
            id: emailAccountId,
            fromEmail: sender.fromEmail,
            label: sender.label || sender.fromEmail,
          }
        : null),
    leads: memberAssignments,
    tasks: memberTasks.map(publicTask),
  };
}

function collectAssignments(state, workspaceId) {
  const assignments = [];

  for (const campaign of state.campaigns || []) {
    if (campaign.workspaceId !== workspaceId) {
      continue;
    }

    for (const lead of campaign.leads || []) {
      assignments.push(publicAssignment(campaign, lead));
    }
  }

  return assignments.sort((left, right) => {
    const leftDate = Date.parse(left.updatedAt || left.assignedAt || 0) || 0;
    const rightDate = Date.parse(right.updatedAt || right.assignedAt || 0) || 0;
    return rightDate - leftDate;
  });
}

function findLeadAssignment(state, workspaceId, assignmentId) {
  const requestedId = clean(assignmentId);

  for (const campaign of state.campaigns || []) {
    if (campaign.workspaceId !== workspaceId) {
      continue;
    }

    for (const lead of campaign.leads || []) {
      if (
        stableAssignmentId(campaign, lead) === requestedId ||
        clean(lead.assignmentId) === requestedId ||
        clean(lead.id) === requestedId
      ) {
        return { campaign, lead };
      }
    }
  }

  return null;
}

function stableAssignmentId(campaign, lead, create = false) {
  if (lead.assignmentId) {
    return clean(lead.assignmentId);
  }

  if (create) {
    lead.assignmentId = `${campaign.id}:${lead.id}`;
    return lead.assignmentId;
  }

  return `${campaign.id}:${lead.id}`;
}

function publicAssignment(campaign, lead) {
  const assigneeId = clean(lead.assignedTo || lead.assigneeId);

  return {
    id: stableAssignmentId(campaign, lead),
    assignmentId: stableAssignmentId(campaign, lead),
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id,
    campaignName: campaign.name || campaign.title || "",
    leadId: lead.id,
    assigneeId,
    assignedTo: assigneeId,
    assignedToName: lead.assignedToName || "",
    assignedBy: lead.assignedBy || "",
    assignedByName: lead.assignedByName || "",
    assignedAt: lead.assignedAt || "",
    status: normalizeStatus(lead.status || "assigned"),
    queueStatus: lead.queueStatus || (assigneeId ? "ready" : "unassigned"),
    priority: normalizeStatus(lead.priority || "normal"),
    callAttempts: Number(lead.callAttempts || 0),
    answeredCalls: Number(lead.answeredCalls || 0),
    nextActionAt: lead.nextActionAt || "",
    followUpAt: lead.followUpAt || "",
    callbackAt: lead.callbackAt || "",
    lastCallAt: lead.lastCallAt || "",
    lastCallStatus: lead.lastCallStatus || "",
    notes: lead.notes || "",
    createdAt: lead.createdAt || campaign.createdAt || "",
    updatedAt: lead.updatedAt || campaign.updatedAt || "",
    lead: publicLead(lead),
  };
}

function publicLead(lead) {
  return {
    id: lead.id,
    business: lead.business || lead.company || "",
    name: lead.name || lead.contactName || "",
    phone: lead.phone || "",
    email: lead.email || "",
    website: lead.website || lead.url || "",
    address: lead.address || "",
    category: lead.category || lead.niche || "",
    status: normalizeStatus(lead.status || "assigned"),
  };
}

function publicTask(task) {
  if (!task || typeof task !== "object") {
    return task;
  }

  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title || "Untitled task",
    description: task.description || "",
    assigneeId: clean(task.assigneeId || task.assignedToUserId),
    assignedToUserId: clean(task.assignedToUserId || task.assigneeId),
    assigneeName: task.assigneeName || "",
    status: normalizeStatus(task.status || "assigned"),
    priority: normalizeStatus(task.priority || "normal"),
    dueAt: task.dueAt || "",
    assignmentId: task.assignmentId || "",
    leadId: task.leadId || task.lead?.id || "",
    campaignId: task.campaignId || "",
    lead: task.lead ? publicLead(task.lead) : null,
    createdAt: task.createdAt || "",
    updatedAt: task.updatedAt || "",
  };
}

function publicMember(member) {
  if (!member) {
    return null;
  }

  return {
    id: member.id,
    name: member.name || member.fullName || member.email || "Caller",
    fullName: member.fullName || member.name || "",
    email: member.email || "",
    role: normalizeRole(member.workspaceRole || member.role || "caller"),
    workspaceRole: normalizeRole(
      member.workspaceRole || member.role || "caller"
    ),
    jobTitle: member.jobTitle || "Caller",
    department: member.department || "",
    avatarUrl:
      member.avatarUrl || member.photoUrl || member.profileImage || "",
    active: member.active !== false && member.isActive !== false,
    status: member.status || (member.active === false ? "suspended" : "active"),
    lastLoginAt: member.lastLoginAt || member.loginAt || "",
    createdAt: member.createdAt || "",
    updatedAt: member.updatedAt || "",
  };
}

function publicPresence(value) {
  if (!value) {
    return {
      status: "offline",
      lastSeenAt: "",
      loginAt: "",
    };
  }

  return {
    status:
      value.status || value.availabilityStatus || value.availability || "offline",
    lastSeenAt:
      value.lastSeenAt || value.lastActiveAt || value.updatedAt || "",
    loginAt:
      value.loginAt || value.lastLoginAt || value.connectedAt || "",
  };
}

function publicDialer(dialer) {
  return {
    configured: Boolean(dialer?.credentialId),
    provider: "telnyx",
    credentialId: dialer?.credentialId || "",
    fromNumber: normalizePhone(dialer?.fromNumber),
    callerIdName: dialer?.callerIdName || "",
    active: dialer?.active !== false,
    updatedAt: dialer?.updatedAt || "",
  };
}

function sanitizeEmailAccount(account) {
  const fromEmail = normalizeEmail(
    account.fromEmail || account.username || account.email
  );

  return {
    id: clean(account.id || account.accountId || fromEmail),
    label:
      clean(account.label || account.name || account.displayName || fromEmail) ||
      fromEmail,
    name: clean(account.name || account.label || ""),
    fromEmail,
    provider: clean(account.provider || account.type || "smtp"),
    active: account.active !== false && account.enabled !== false,
    status: clean(account.status || (account.active === false ? "disabled" : "connected")),
  };
}

function buildPhonePool(state, workspaceId, callers) {
  const numbers = configuredPhoneNumbers(state, workspaceId);
  const assignedMap = new Map();

  for (const caller of callers) {
    const number = normalizePhone(
      caller.telnyxFromNumber ||
        caller.dialerNumber ||
        caller.assignedPhoneNumber ||
        caller.phoneNumber
    );

    if (number) {
      assignedMap.set(number, caller);
    }
  }

  for (const dialer of state.telnyxDialers || []) {
    if (dialer.workspaceId !== workspaceId || dialer.active === false) {
      continue;
    }

    const number = normalizePhone(dialer.fromNumber);
    if (!number) {
      continue;
    }

    if (!numbers.includes(number)) {
      numbers.push(number);
    }

    const caller = callers.find((item) => item.id === dialer.userId);
    if (caller) {
      assignedMap.set(number, caller);
    }
  }

  return numbers.map((number) => {
    const assigned = assignedMap.get(number);
    return {
      number,
      assignedTo: assigned?.id || "",
      assignedToName: assigned?.name || assigned?.email || "",
      spare: !assigned,
    };
  });
}

function configuredPhoneNumbers(state, workspaceId) {
  const reserved =
    new Set(
      String(
        process.env.TELNYX_RESERVED_FROM_NUMBERS ||
          process.env.TELNYX_AI_PHONE_NUMBER ||
          process.env.TELNYX_AI_AGENT_PHONE_NUMBER ||
          process.env.ELEVENLABS_TELNYX_PHONE_NUMBER ||
          ""
      )
        .split(",")
        .map(normalizePhone)
        .filter(Boolean)
    );

  const values = String(
    process.env.TELNYX_FROM_NUMBERS || process.env.TELNYX_FROM_NUMBER || ""
  )
    .split(",")
    .map(normalizePhone)
    .filter(
      (number) =>
        Boolean(number) &&
        !reserved.has(number)
    );

  for (const dialer of state.telnyxDialers || []) {
    if (
      dialer.workspaceId === workspaceId &&
      dialer.fromNumber
    ) {
      const number =
        normalizePhone(
          dialer.fromNumber
        );

      if (
        number &&
        !reserved.has(number)
      ) {
        values.push(number);
      }
    }
  }

  return [
    ...new Set(
      values.filter(Boolean)
    ),
  ];
}

function getResourceLimit(state, workspaceId, member) {
  return clampInteger(
    state.resourceLeadLimits?.[workspaceId]?.[member.id] ??
      member.dailyLeadLimit ??
      member.leadAssignmentLimit,
    DEFAULT_DAILY_LEAD_LIMIT,
    1,
    5000
  );
}

function listWorkspaceCallers(state, workspaceId) {
  return (state.users || [])
    .filter((item) => item.workspaceId === workspaceId)
    .filter(
      (item) => normalizeRole(item.workspaceRole || item.role) === "caller"
    )
    .filter((item) => item.active !== false && item.isActive !== false)
    .sort((left, right) =>
      normalizeEmail(left.email).localeCompare(normalizeEmail(right.email))
    );
}

function findWorkspaceCaller(
  state,
  workspaceId,
  userId,
  { includeInactive = false } = {}
) {
  return (state.users || []).find(
    (item) =>
      item.id === clean(userId) &&
      item.workspaceId === workspaceId &&
      normalizeRole(item.workspaceRole || item.role) === "caller" &&
      (includeInactive || (item.active !== false && item.isActive !== false))
  );
}

function getAssignmentUserId(assignment) {
  return clean(
    assignment.assigneeId || assignment.assignedTo || assignment.assignedToUserId
  );
}

function isLeadClosed(status) {
  return CLOSED_LEAD_STATUSES.has(normalizeStatus(status));
}

function appendLeadTimeline(lead, event) {
  lead.timeline = Array.isArray(lead.timeline) ? lead.timeline : [];
  lead.timeline.unshift({
    id: crypto.randomUUID(),
    ...event,
  });
  lead.timeline = lead.timeline.slice(0, 500);
}

function ensureBoardState(draft) {
  draft.resourceLeadLimits =
    draft.resourceLeadLimits && typeof draft.resourceLeadLimits === "object"
      ? draft.resourceLeadLimits
      : {};
  draft.resourceEmailAssignments = Array.isArray(
    draft.resourceEmailAssignments
  )
    ? draft.resourceEmailAssignments
    : [];
  draft.resourceBoardActivity = Array.isArray(draft.resourceBoardActivity)
    ? draft.resourceBoardActivity
    : [];
  draft.telnyxDialers = Array.isArray(draft.telnyxDialers)
    ? draft.telnyxDialers
    : [];
}

function appendActivity(draft, event) {
  ensureBoardState(draft);
  draft.resourceBoardActivity.unshift({
    id: crypto.randomUUID(),
    ...event,
  });
  draft.resourceBoardActivity = draft.resourceBoardActivity.slice(0, 500);
}

function publicActivity(item) {
  return {
    id: item.id,
    type: item.type || "activity",
    title: item.title || "Workspace updated",
    actorId: item.actorId || "",
    actorName: item.actorName || "",
    resourceId: item.resourceId || "",
    resourceName: item.resourceName || "",
    assignmentId: item.assignmentId || "",
    taskId: item.taskId || "",
    createdAt: item.createdAt || "",
  };
}

function publicWorkspace(workspace) {
  if (!workspace) {
    return null;
  }

  return {
    id: workspace.id,
    name: workspace.name || workspace.companyName || "Workspace",
    companyName: workspace.companyName || workspace.name || "",
    timezone: workspace.timezone || "UTC",
  };
}

function normalizeRole(value) {
  const role = normalizeStatus(value);
  if (role.includes("owner")) return "owner";
  if (role.includes("admin")) return "admin";
  if (role.includes("manager")) return "manager";
  if (
    role === "caller" ||
    role.includes("cold_caller") ||
    role.includes("sales_rep") ||
    role.includes("telemarketer")
  ) {
    return "caller";
  }
  return role || "caller";
}

function normalizeStatus(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizePhone(value) {
  const input = clean(value).replace(/[^\d+]/g, "");
  if (!input) return "";
  if (input.startsWith("+")) return input;
  if (input.startsWith("00")) return `+${input.slice(2)}`;
  if (input.length === 10) return `+1${input}`;
  if (input.length === 11 && input.startsWith("1")) return `+${input}`;
  return `+${input}`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
