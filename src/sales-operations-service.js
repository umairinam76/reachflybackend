import crypto from "node:crypto";

export function createSalesOperationsService({ store, workspaceService } = {}) {
  if (!store) throw new Error("createSalesOperationsService requires a store.");

  function context(user) {
    return workspaceService?.getContext(user) || {
      workspaceId: user?.workspaceId || user?.id || "",
      role: user?.role || "caller",
      permissions: user?.permissions || [],
    };
  }

  function requireManager(user) {
    const ctx = context(user);
    const allowed = ["owner", "admin", "manager"].includes(ctx.role) ||
      ["manage_team", "assign_leads"].some((p) => ctx.permissions?.includes(p));
    if (!allowed) throw httpError(403, "Manager permission is required.");
    return ctx;
  }

  function leadKey(lead = {}) {
    const phone = digits(lead.phone);
    const website = host(lead.website);
    const email = clean(lead.email).toLowerCase();
    const name = clean(lead.business || lead.name).toLowerCase();
    const address = clean(lead.address).toLowerCase();
    return phone ? `phone:${phone}` : website ? `host:${website}` : email ? `email:${email}` : `lead:${name}|${address}`;
  }

  function getContactPolicy(user, lead = {}) {
    const ctx = context(user);
    const key = leadKey(lead);
    const records = (store.read().callRecords || [])
      .filter((item) => item.workspaceId === ctx.workspaceId && item.leadKey === key)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const active = records.find((item) => ["queued", "started", "ringing", "answered", "connecting"].includes(item.status));
    const last = records[0] || null;
    const cooldownHours = Math.max(1, Number(process.env.LEAD_CONTACT_COOLDOWN_HOURS || 72));
    const cutoff = Date.now() - cooldownHours * 60 * 60 * 1000;
    const recent = records.find((item) => Date.parse(item.createdAt) >= cutoff && !["failed", "rejected", "busy", "unanswered", "cancelled"].includes(item.status));
    return {
      leadKey: key,
      canContact: !active && !recent,
      reason: active ? "A call to this lead is already active." : recent ? `This lead was contacted within the last ${cooldownHours} hours.` : "",
      activeCallId: active?.id || "",
      lastContact: last,
      cooldownHours,
    };
  }

  function createCallRecord(user, input = {}) {
    const ctx = context(user);
    const lead = sanitizeLead(input.lead || input);
    const policy = getContactPolicy(user, lead);
    const canOverride = ["owner", "admin", "manager"].includes(ctx.role) || ctx.permissions?.includes("override_contact_lock");
    if (!policy.canContact && !(input.force === true && canOverride)) {
      const error = httpError(409, policy.reason || "Lead contact is locked.");
      error.details = policy;
      throw error;
    }

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      workspaceId: ctx.workspaceId,
      campaignId: clean(input.campaignId),
      leadId: clean(input.leadId || lead.id),
      leadKey: policy.leadKey,
      lead,
      callerUserId: user.id,
      assignedTo: clean(input.assignedTo || user.id),
      callerNumber: normalizePhone(input.callerNumber || user.phone || user.mobile || process.env.VONAGE_DEFAULT_AGENT_NUMBER),
      destinationNumber: normalizePhone(input.destinationNumber || lead.phone),
      status: "queued",
      direction: "outbound",
      provider: "vonage",
      providerCallId: "",
      conversationUuid: "",
      startedAt: now,
      answeredAt: "",
      endedAt: "",
      durationSeconds: 0,
      outcome: "",
      notes: "",
      recordingUrl: "",
      events: [],
      createdAt: now,
      updatedAt: now,
    };

    if (!record.callerNumber) throw httpError(400, "Your caller phone number is missing. Add it to your profile or pass callerNumber.");
    if (!record.destinationNumber) throw httpError(400, "The lead phone number is missing.");

    store.update((draft) => {
      draft.callRecords = draft.callRecords || [];
      draft.callRecords.unshift(record);
    });
    return record;
  }

  function updateCall(callId, patch = {}) {
    let updated = null;
    store.update((draft) => {
      draft.callRecords = draft.callRecords || [];
      const item = draft.callRecords.find((record) => record.id === callId);
      if (!item) return;
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      if (patch.event) {
        item.events = item.events || [];
        item.events.push({ ...patch.event, receivedAt: new Date().toISOString() });
        delete item.event;
      }
      updated = { ...item };
    });
    return updated;
  }

  function getCall(user, callId) {
    const ctx = context(user);
    const item = (store.read().callRecords || []).find((record) => record.id === callId && record.workspaceId === ctx.workspaceId);
    if (!item) throw httpError(404, "Call session not found.");
    if (!["owner", "admin", "manager"].includes(ctx.role) && item.callerUserId !== user.id && item.assignedTo !== user.id) {
      throw httpError(403, "You cannot view this call.");
    }
    return item;
  }

  function listCalls(user, query = {}) {
    const ctx = context(user);
    const canViewAll = ["owner", "admin", "manager"].includes(ctx.role) || ctx.permissions?.includes("view_team_calls");
    return (store.read().callRecords || [])
      .filter((item) => item.workspaceId === ctx.workspaceId)
      .filter((item) => canViewAll || item.callerUserId === user.id || item.assignedTo === user.id)
      .filter((item) => !query.status || item.status === query.status)
      .slice(0, Math.min(2000, Number(query.limit || 500)));
  }

  function dashboard(user) {
    const ctx = context(user);
    const calls = listCalls(user, {
      limit: 2000,
    });

    const members =
      workspaceService?.listMembers?.(
        user
      ) || [];

    const assignments =
      listAssignments(user);

    const today =
      new Date()
        .toISOString()
        .slice(0, 10);

    const todayCalls =
      calls.filter(
        (item) =>
          String(
            item.createdAt ||
              item.startedAt ||
              ""
          ).startsWith(today)
      );

    const completedCalls =
      todayCalls.filter(
        (item) =>
          [
            "answered",
            "completed",
          ].includes(
            normalizeStatus(
              item.status
            )
          )
      );

    const followUpsDue =
      assignments.filter(
        (assignment) =>
          isAssignmentFollowUpDue(
            assignment
          )
      );

    const contactedLeadKeys =
      new Set(
        calls
          .map(
            (item) =>
              item.leadKey
          )
          .filter(Boolean)
      );

    const contactedToday =
      assignments.filter(
        (assignment) =>
          contactedLeadKeys.has(
            assignment.leadKey
          )
      ).length;

    const converted =
      assignments.filter(
        (assignment) =>
          [
            "qualified",
            "meeting_booked",
            "converted",
            "completed",
          ].includes(
            normalizeStatus(
              assignment.status
            )
          )
      ).length;

    return {
      ok: true,

      role:
        ctx.role,

      user:
        publicDashboardUser(
          user,
          ctx
        ),

      calls,

      members,

      assignments,

      records:
        assignments,

      metrics: {
        assignedLeads:
          assignments.length,

        pendingLeads:
          assignments.filter(
            (assignment) =>
              ![
                "completed",
                "converted",
                "do_not_contact",
                "do_not_call",
              ].includes(
                normalizeStatus(
                  assignment.status
                )
              )
          ).length,

        contactedToday,

        totalCalls:
          calls.length,

        callsToday:
          todayCalls.length,

        answeredToday:
          completedCalls.length,

        completedToday:
          todayCalls.filter(
            (item) =>
              normalizeStatus(
                item.status
              ) ===
              "completed"
          ).length,

        followUpsDue:
          followUpsDue.length,

        uniqueLeadsContacted:
          new Set(
            calls
              .map(
                (item) =>
                  item.leadKey
              )
              .filter(Boolean)
          ).size,

        averageDurationSeconds:
          average(
            calls
              .map(
                (item) =>
                  Number(
                    item.durationSeconds ||
                      0
                  )
              )
              .filter(Boolean)
          ),

        conversionRate:
          assignments.length
            ? Math.round(
                (
                  converted /
                  assignments.length
                ) *
                  100
              )
            : 0,
      },

      reportTemplate:
        getReportTemplate(
          user
        ),
    };
  }

  function assignLeads(
    user,
    input = {}
  ) {
    const ctx =
      requireManager(user);

    const assigneeId =
      clean(
        input.assigneeId ||
          input.assignedTo
      );

    const leads =
      Array.isArray(
        input.leads
      )
        ? input.leads
        : [];

    if (!assigneeId) {
      throw httpError(
        400,
        "assigneeId is required."
      );
    }

    const now =
      new Date()
        .toISOString();

    const assignments =
      leads
        .slice(
          0,
          1000
        )
        .map(
          (lead) =>
            createAssignmentRecord({
              ctx,
              user,
              assigneeId,
              campaignId:
                clean(
                  input.campaignId
                ),
              campaignName:
                clean(
                  input.campaignName
                ),
              lead,
              now,
            })
        );

    store.update(
      (draft) => {
        draft.leadAssignments =
          Array.isArray(
            draft.leadAssignments
          )
            ? draft.leadAssignments
            : [];

        for (
          const assignment
          of assignments
        ) {
          const index =
            draft.leadAssignments.findIndex(
              (item) =>
                item.workspaceId ===
                  assignment.workspaceId &&
                item.assigneeId ===
                  assignment.assigneeId &&
                (
                  item.leadId ===
                    assignment.leadId ||
                  item.leadKey ===
                    assignment.leadKey
                )
            );

          if (index >= 0) {
            draft.leadAssignments[
              index
            ] = {
              ...draft
                .leadAssignments[
                index
              ],
              ...assignment,
            };
          } else {
            draft.leadAssignments.unshift(
              assignment
            );
          }
        }
      }
    );

    return {
      ok: true,
      assigned:
        assignments.length,
      assignments,
    };
  }

  function listAssignments(
    user
  ) {
    const ctx =
      context(user);

    const canViewAll =
      [
        "owner",
        "admin",
        "manager",
      ].includes(
        normalizeStatus(
          ctx.role
        )
      ) ||
      ctx.permissions?.includes(
        "assign_leads"
      );

    const state =
      store.read();

    const storedAssignments =
      (
        state.leadAssignments ||
        []
      )
        .filter(
          (item) =>
            item.workspaceId ===
            ctx.workspaceId
        )
        .filter(
          (item) =>
            canViewAll ||
            item.assigneeId ===
              user.id ||
            item.assignedTo ===
              user.id
        )
        .map(
          normalizeStoredAssignment
        )
        .filter(Boolean);

    const campaignAssignments =
      collectCampaignAssignments(
        state,
        {
          workspaceId:
            ctx.workspaceId,
          userId:
            user.id,
          canViewAll,
        }
      );

    const merged =
      new Map();

    for (
      const assignment
      of [
        ...storedAssignments,
        ...campaignAssignments,
      ]
    ) {
      const key =
        assignmentIdentity(
          assignment
        );

      const existing =
        merged.get(key);

      if (!existing) {
        merged.set(
          key,
          assignment
        );

        continue;
      }

      merged.set(
        key,
        mergeAssignments(
          existing,
          assignment
        )
      );
    }

    return [
      ...merged.values(),
    ].sort(
      (left, right) =>
        Date.parse(
          right.updatedAt ||
            right.assignedAt ||
            right.createdAt ||
            0
        ) -
        Date.parse(
          left.updatedAt ||
            left.assignedAt ||
            left.createdAt ||
            0
        )
    );
  }

  function updateAssignment(
    user,
    assignmentId,
    input = {}
  ) {
    const ctx =
      context(user);

    const normalizedId =
      clean(
        assignmentId
      );

    if (!normalizedId) {
      throw httpError(
        400,
        "Assignment ID is required."
      );
    }

    const state =
      store.read();

    const canManage =
      [
        "owner",
        "admin",
        "manager",
      ].includes(
        normalizeStatus(
          ctx.role
        )
      ) ||
      ctx.permissions?.includes(
        "assign_leads"
      );

    const availableAssignments =
      listAssignments(
        user
      );

    const existing =
      availableAssignments.find(
        (assignment) =>
          assignment.id ===
            normalizedId ||
          assignment.assignmentId ===
            normalizedId
      );

    if (!existing) {
      throw httpError(
        404,
        "Lead assignment not found."
      );
    }

    if (
      !canManage &&
      existing.assigneeId !==
        user.id &&
      existing.assignedTo !==
        user.id
    ) {
      throw httpError(
        403,
        "You cannot update this assignment."
      );
    }

    const now =
      new Date()
        .toISOString();

    const nextStatus =
      input.status !==
      undefined
        ? normalizeAssignmentStatus(
            input.status
          )
        : existing.status;

    const nextPriority =
      input.priority !==
      undefined
        ? normalizePriority(
            input.priority
          )
        : existing.priority ||
          "normal";

    const nextNotes =
      input.notes !==
      undefined
        ? clean(
            input.notes
          ).slice(
            0,
            5000
          )
        : existing.notes ||
          "";

    const nextActionAt =
      input.nextActionAt !==
      undefined
        ? normalizeOptionalDate(
            input.nextActionAt,
            "nextActionAt"
          )
        : input.followUpAt !==
          undefined
          ? normalizeOptionalDate(
              input.followUpAt,
              "followUpAt"
            )
          : existing.nextActionAt ||
            existing.followUpAt ||
            "";

    const patch = {
      status:
        nextStatus,

      priority:
        nextPriority,

      notes:
        nextNotes,

      nextActionAt,

      followUpAt:
        nextActionAt,

      updatedAt:
        now,

      updatedBy:
        user.id,
    };

    let updatedStored =
      null;

    let updatedCampaign =
      null;

    store.update(
      (draft) => {
        draft.leadAssignments =
          Array.isArray(
            draft.leadAssignments
          )
            ? draft.leadAssignments
            : [];

        const storedIndex =
          draft.leadAssignments.findIndex(
            (assignment) =>
              assignment.id ===
                normalizedId ||
              assignment.assignmentId ===
                normalizedId ||
              (
                assignment.workspaceId ===
                  ctx.workspaceId &&
                assignment.campaignId ===
                  existing.campaignId &&
                assignment.leadId ===
                  existing.leadId &&
                (
                  assignment.assigneeId ===
                    existing.assigneeId ||
                  assignment.assignedTo ===
                    existing.assigneeId
                )
              )
          );

        if (
          storedIndex >=
          0
        ) {
          Object.assign(
            draft.leadAssignments[
              storedIndex
            ],
            patch
          );

          updatedStored =
            normalizeStoredAssignment(
              draft.leadAssignments[
                storedIndex
              ]
            );
        }

        const campaign =
          (
            draft.campaigns ||
            []
          ).find(
            (item) =>
              item.id ===
                existing.campaignId &&
              (
                !item.workspaceId ||
                item.workspaceId ===
                  ctx.workspaceId
              )
          );

        if (campaign) {
          const lead =
            (
              campaign.leads ||
              []
            ).find(
              (item) =>
                item.id ===
                  existing.leadId
            );

          if (lead) {
            Object.assign(
              lead,
              {
                assignmentStatus:
                  nextStatus,

                status:
                  nextStatus,

                priority:
                  nextPriority,

                assignmentNotes:
                  nextNotes,

                notes:
                  nextNotes,

                nextActionAt,

                followUpAt:
                  nextActionAt,

                updatedAt:
                  now,
              }
            );

            campaign.updatedAt =
              now;

            updatedCampaign =
              {
                ...existing,
                ...patch,

                lead: {
                  ...getAssignmentLead(
                    existing
                  ),
                  ...sanitizeLead(
                    lead
                  ),
                },
              };
          }
        }

        if (
          storedIndex <
            0 &&
          existing.campaignId &&
          existing.leadId
        ) {
          const created = {
            ...existing,
            ...patch,

            id:
              normalizedId,

            assignmentId:
              normalizedId,

            workspaceId:
              ctx.workspaceId,

            assigneeId:
              existing.assigneeId ||
              existing.assignedTo,

            assignedTo:
              existing.assigneeId ||
              existing.assignedTo,

            createdAt:
              existing.createdAt ||
              existing.assignedAt ||
              now,
          };

          draft.leadAssignments.unshift(
            created
          );

          updatedStored =
            normalizeStoredAssignment(
              created
            );
        }
      }
    );

    const assignment =
      mergeAssignments(
        updatedStored ||
          existing,
        updatedCampaign ||
          {
            ...existing,
            ...patch,
          }
      );

    return {
      ok: true,
      assignment,
    };
  }

  function getReportTemplate(user) {
    const ctx = context(user);
    return (store.read().auditReportTemplates || []).find((item) => item.workspaceId === ctx.workspaceId) || {
      workspaceId: ctx.workspaceId,
      name: "Default audit format",
      miniInstructions: "Keep the existing Mini Audit structure exactly: confidentiality header, Business Snapshot, Issues Found, and internal-use footer. Do not add or remove sections.",
      fullInstructions: "Use the approved internal full-audit structure while preserving evidence, competitor analysis, technical review, ranking review, SEO and trust findings.",
      claudeSystemPrompt: "Use only verified public evidence. Preserve the approved workspace format and dynamic workspace branding.",
      miniEnabled: true,
      competitorEnabled: true,
      fullEnabled: true,
      updatedAt: "",
    };
  }

  function updateReportTemplate(user, input = {}) {
    const ctx = requireManager(user);
    const template = {
      workspaceId: ctx.workspaceId,
      name: clean(input.name || "Workspace audit format"),
      miniInstructions: clean(input.miniInstructions).slice(0, 12000),
      fullInstructions: clean(input.fullInstructions).slice(0, 20000),
      claudeSystemPrompt: clean(input.claudeSystemPrompt).slice(0, 20000),
      miniEnabled: input.miniEnabled !== false,
      competitorEnabled: input.competitorEnabled !== false,
      fullEnabled: input.fullEnabled !== false,
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
    };
    store.update((draft) => {
      draft.auditReportTemplates = draft.auditReportTemplates || [];
      const index = draft.auditReportTemplates.findIndex((item) => item.workspaceId === ctx.workspaceId);
      if (index >= 0) draft.auditReportTemplates[index] = template;
      else draft.auditReportTemplates.push(template);
    });
    return template;
  }

  return { leadKey, getContactPolicy, createCallRecord, updateCall, getCall, listCalls, dashboard, assignLeads, listAssignments, updateAssignment, getReportTemplate, updateReportTemplate };
}


function collectCampaignAssignments(
  state,
  {
    workspaceId,
    userId,
    canViewAll,
  }
) {
  const assignments =
    [];

  for (
    const campaign
    of state.campaigns ||
      []
  ) {
    const campaignWorkspaceId =
      clean(
        campaign.workspaceId ||
          campaign.accountId ||
          campaign.companyId ||
          ""
      );

    if (
      campaignWorkspaceId &&
      campaignWorkspaceId !==
        workspaceId
    ) {
      continue;
    }

    for (
      const rawLead
      of campaign.leads ||
        []
    ) {
      const assigneeId =
        clean(
          rawLead.assigneeId ||
            rawLead.assignedTo ||
            rawLead.assignedUserId ||
            rawLead.assignment
              ?.assigneeId ||
            ""
        );

      if (!assigneeId) {
        continue;
      }

      if (
        !canViewAll &&
        assigneeId !==
          userId
      ) {
        continue;
      }

      const lead =
        sanitizeLead(
          rawLead
        );

      const assignedAt =
        clean(
          rawLead.assignedAt ||
            rawLead.assignment
              ?.assignedAt ||
            campaign.updatedAt ||
            campaign.createdAt ||
            ""
        );

      assignments.push({
        id:
          clean(
            rawLead.assignmentId ||
              rawLead.assignment
                ?.id
          ) ||
          `${campaign.id}:${lead.id}:${assigneeId}`,

        assignmentId:
          clean(
            rawLead.assignmentId ||
              rawLead.assignment
                ?.id
          ) ||
          `${campaign.id}:${lead.id}:${assigneeId}`,

        workspaceId,

        campaignId:
          clean(
            campaign.id
          ),

        campaignName:
          clean(
            campaign.name
          ),

        leadId:
          clean(
            lead.id
          ),

        leadKey:
          buildLeadKey(
            lead
          ),

        assigneeId,

        assignedTo:
          assigneeId,

        assignedToName:
          clean(
            rawLead.assignedToName ||
              rawLead.assigneeName ||
              rawLead.assignment
                ?.assigneeName ||
              ""
          ),

        assignedBy:
          clean(
            rawLead.assignedBy ||
              rawLead.assignment
                ?.assignedBy ||
              campaign.ownerId ||
              campaign.userId ||
              ""
          ),

        status:
          normalizeStatus(
            rawLead.assignmentStatus ||
              rawLead.status ||
              "assigned"
          ),

        priority:
          normalizePriority(
            rawLead.priority ||
              "normal"
          ),

        notes:
          clean(
            rawLead.assignmentNotes ||
              rawLead.notes ||
              ""
          ),

        followUpAt:
          clean(
            rawLead.followUpAt ||
              rawLead.nextFollowUpAt ||
              ""
          ),

        assignedAt,

        createdAt:
          assignedAt ||
          clean(
            campaign.createdAt
          ),

        updatedAt:
          clean(
            rawLead.updatedAt ||
              campaign.updatedAt ||
              assignedAt
          ),

        lead,

        business:
          lead.business,

        name:
          lead.name,

        phone:
          lead.phone,

        email:
          lead.email,

        website:
          lead.website,

        address:
          lead.address,

        category:
          lead.category,

        qualityScore:
          lead.qualityScore,
      });
    }
  }

  return assignments;
}

function normalizeStoredAssignment(
  assignment
) {
  if (
    !assignment ||
    typeof assignment !==
      "object"
  ) {
    return null;
  }

  const lead =
    sanitizeLead(
      assignment.lead ||
        assignment
    );

  const assigneeId =
    clean(
      assignment.assigneeId ||
        assignment.assignedTo ||
        ""
    );

  const campaignId =
    clean(
      assignment.campaignId
    );

  const leadId =
    clean(
      assignment.leadId ||
        lead.id
    );

  return {
    ...assignment,

    id:
      clean(
        assignment.id
      ) ||
      `${campaignId}:${leadId}:${assigneeId}`,

    assignmentId:
      clean(
        assignment.assignmentId ||
          assignment.id
      ) ||
      `${campaignId}:${leadId}:${assigneeId}`,

    campaignId,
    leadId,
    assigneeId,

    assignedTo:
      assigneeId,

    leadKey:
      clean(
        assignment.leadKey
      ) ||
      buildLeadKey(
        lead
      ),

    status:
      normalizeStatus(
        assignment.status ||
          "assigned"
      ),

    priority:
      normalizePriority(
        assignment.priority ||
          "normal"
      ),

    lead,

    business:
      lead.business,

    name:
      lead.name,

    phone:
      lead.phone,

    email:
      lead.email,

    website:
      lead.website,

    address:
      lead.address,

    category:
      lead.category,

    qualityScore:
      lead.qualityScore,
  };
}

function createAssignmentRecord({
  ctx,
  user,
  assigneeId,
  campaignId,
  campaignName,
  lead,
  now,
}) {
  const sanitizedLead =
    sanitizeLead(
      lead
    );

  return {
    id:
      crypto.randomUUID(),

    workspaceId:
      ctx.workspaceId,

    assigneeId,

    assignedTo:
      assigneeId,

    assignedBy:
      user.id,

    campaignId,

    campaignName,

    leadId:
      clean(
        sanitizedLead.id
      ),

    leadKey:
      buildLeadKey(
        sanitizedLead
      ),

    lead:
      sanitizedLead,

    status:
      "assigned",

    priority:
      normalizePriority(
        lead.priority ||
          "normal"
      ),

    notes:
      clean(
        lead.assignmentNotes ||
          ""
      ),

    followUpAt:
      clean(
        lead.followUpAt ||
          ""
      ),

    assignedAt:
      now,

    createdAt:
      now,

    updatedAt:
      now,
  };
}

function mergeAssignments(
  left,
  right
) {
  const leftTimestamp =
    Date.parse(
      left.updatedAt ||
        left.assignedAt ||
        0
    ) || 0;

  const rightTimestamp =
    Date.parse(
      right.updatedAt ||
        right.assignedAt ||
        0
    ) || 0;

  const newer =
    rightTimestamp >=
    leftTimestamp
      ? right
      : left;

  const older =
    newer === right
      ? left
      : right;

  return {
    ...older,
    ...newer,

    lead: {
      ...(older.lead ||
        {}),
      ...(newer.lead ||
        {}),
    },
  };
}

function assignmentIdentity(
  assignment
) {
  return [
    clean(
      assignment.workspaceId
    ),

    clean(
      assignment.campaignId
    ),

    clean(
      assignment.leadId
    ) ||
      clean(
        assignment.leadKey
      ),

    clean(
      assignment.assigneeId ||
        assignment.assignedTo
    ),
  ].join(":");
}

function buildLeadKey(
  lead = {}
) {
  const phone =
    digits(
      lead.phone
    );

  const website =
    host(
      lead.website
    );

  const email =
    clean(
      lead.email
    ).toLowerCase();

  const placeId =
    clean(
      lead.placeId
    );

  const name =
    clean(
      lead.business ||
        lead.name
    ).toLowerCase();

  const address =
    clean(
      lead.address ||
        lead.location
    ).toLowerCase();

  return placeId
    ? `place:${placeId}`
    : phone
      ? `phone:${phone}`
      : website
        ? `host:${website}`
        : email
          ? `email:${email}`
          : `lead:${name}|${address}`;
}

function normalizeStatus(
  value
) {
  return clean(
    value
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      "_"
    )
    .replace(
      /-/g,
      "_"
    );
}

function normalizePriority(
  value
) {
  const priority =
    normalizeStatus(
      value
    );

  return [
    "low",
    "normal",
    "high",
    "urgent",
  ].includes(
    priority
  )
    ? priority
    : "normal";
}

function isAssignmentFollowUpDue(
  assignment
) {
  const status =
    normalizeStatus(
      assignment.status
    );

  if (
    status ===
      "follow_up" ||
    status ===
      "followup"
  ) {
    return true;
  }

  if (
    !assignment.followUpAt
  ) {
    return false;
  }

  const timestamp =
    Date.parse(
      assignment.followUpAt
    );

  return (
    Number.isFinite(
      timestamp
    ) &&
    timestamp <=
      Date.now()
  );
}

function normalizeAssignmentStatus(
  value
) {
  const status =
    normalizeStatus(
      value
    );

  const allowed = [
    "assigned",
    "in_progress",
    "follow_up",
    "qualified",
    "meeting_booked",
    "completed",
    "do_not_contact",
    "do_not_call",
    "not_interested",
    "converted",
  ];

  if (
    !allowed.includes(
      status
    )
  ) {
    throw httpError(
      400,
      "The selected assignment status is invalid."
    );
  }

  return status;
}

function normalizeOptionalDate(
  value,
  fieldName
) {
  const raw =
    clean(
      value
    );

  if (!raw) {
    return "";
  }

  const timestamp =
    Date.parse(
      raw
    );

  if (
    !Number.isFinite(
      timestamp
    )
  ) {
    throw httpError(
      400,
      `${fieldName} must be a valid date.`
    );
  }

  return new Date(
    timestamp
  ).toISOString();
}

function getAssignmentLead(
  assignment
) {
  return assignment?.lead &&
    typeof assignment.lead ===
      "object"
    ? assignment.lead
    : {};
}

function publicDashboardUser(
  user,
  ctx
) {
  return {
    id:
      user?.id ||
      "",

    name:
      user?.name ||
      user?.fullName ||
      "",

    email:
      user?.email ||
      "",

    workspaceId:
      ctx.workspaceId,

    workspaceRole:
      ctx.role,

    role:
      ctx.role,

    accountType:
      user?.accountType ||
      user?.workspaceType ||
      "company",

    companyName:
      user?.companyName ||
      user?.workspaceName ||
      "",

    workspaceName:
      user?.workspaceName ||
      user?.companyName ||
      "",

    avatarUrl:
      user?.avatarUrl ||
      user?.photoUrl ||
      user?.profileImageUrl ||
      "",
  };
}

function sanitizeLead(
  lead = {}
) {
  return {
    id:
      clean(
        lead.id
      ),

    placeId:
      clean(
        lead.placeId
      ),

    business:
      clean(
        lead.business ||
          lead.name
      ),

    name:
      clean(
        lead.name ||
          lead.business
      ),

    contactName:
      clean(
        lead.contactName ||
          lead.contact_name
      ),

    phone:
      normalizePhone(
        lead.phone
      ),

    email:
      clean(
        lead.email
      ),

    website:
      clean(
        lead.website
      ),

    address:
      clean(
        lead.address ||
          lead.location
      ),

    location:
      clean(
        lead.location ||
          lead.address
      ),

    category:
      clean(
        lead.category
      ),

    notes:
      clean(
        lead.notes
      ),

    mapsUrl:
      clean(
        lead.mapsUrl
      ),

    qualityScore:
      Number(
        lead.qualityScore ||
          lead.confidence ||
          0
      ),

    confidence:
      Number(
        lead.confidence ||
          lead.qualityScore ||
          0
      ),

    source:
      clean(
        lead.source
      ),

    status:
      normalizeStatus(
        lead.status ||
          "new"
      ),

    conversionStatus:
      normalizeStatus(
        lead.conversionStatus ||
          "new"
      ),

    timeline:
      Array.isArray(
        lead.timeline
      )
        ? lead.timeline
        : [],

    signals:
      Array.isArray(
        lead.signals
      )
        ? lead.signals
        : [],
  };
}
function normalizePhone(value) { const raw = clean(value); const plus = raw.startsWith("+"); const number = raw.replace(/\D/g, ""); return number ? `${plus ? "+" : ""}${number}` : ""; }
function digits(value) { return String(value || "").replace(/\D/g, ""); }
function host(value) { try { return new URL(value).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function average(values) { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0; }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
