import crypto from "node:crypto";

/**
 * Server-authoritative caller work queue.
 *
 * The frontend never decides whether a lead is ready, missed, due, or closed.
 * Every call result is stored on the lead timeline and automatically moves the
 * lead to the correct queue.
 */
export function createCallerQueueService({
  store,
  workspaceService,
}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createCallerQueueService requires a store exposing read() and update()."
    );
  }

  function listQueue(
    user,
    query = {}
  ) {
    const ctx =
      requireCallerOrManager(
        user
      );

    const targetUserId =
      canViewAll(ctx)
        ? clean(
            query.userId ||
            user.id
          )
        : user.id;

    const bucket =
      normalizeBucket(
        query.bucket ||
        "current"
      );

    const limit =
      clampInteger(
        query.limit,
        100,
        1,
        1000
      );

    const offset =
      clampInteger(
        query.offset,
        0,
        0,
        1000000
      );

    const all =
      collectAssignments(
        store.read(),
        {
          workspaceId:
            ctx.workspaceId,
          userId:
            targetUserId,
        }
      );

    const filtered =
      all
        .filter(
          (assignment) =>
            belongsToBucket(
              assignment,
              bucket
            )
        )
        .sort(
          compareAssignments
        );

    return {
      ok: true,
      bucket,
      total:
        filtered.length,
      records:
        filtered.slice(
          offset,
          offset + limit
        ),
      counts:
        buildCounts(
          all
        ),
      next:
        filtered[0] ||
        null,
    };
  }

  function nextLead(
    user,
    query = {}
  ) {
    const result =
      listQueue(
        user,
        {
          ...query,
          bucket:
            query.bucket ||
            "current",
          limit:
            1,
          offset:
            0,
        }
      );

    return {
      ok: true,
      assignment:
        result.records[0] ||
        null,
      counts:
        result.counts,
    };
  }

  function getAssignment(
    user,
    assignmentId
  ) {
    const found = findAssignment(
      store.read(),
      assignmentId
    );

    if (!found) {
      throw httpError(
        404,
        "Lead assignment not found."
      );
    }

    const ctx = requireCallerOrManager(user);
    assertAccess(ctx, user, found.lead);

    return {
      ok: true,
      assignment: publicAssignment(
        found.campaign,
        found.lead
      ),
    };
  }

  function markOpened(
    user,
    assignmentId
  ) {
    return mutateAssignment({
      user,
      assignmentId,
      mutate({
        lead,
        now,
      }) {
        if (
          normalizeStatus(
            lead.status
          ) ===
          "assigned"
        ) {
          lead.status =
            "in_progress";
        }

        lead.openedAt =
          now;
        lead.queueStatus =
          "ready";

        addTimeline(
          lead,
          {
            type:
              "lead_opened",
            actorId:
              user.id,
            status:
              lead.status,
            createdAt:
              now,
          }
        );
      },
    });
  }

  function startCall(
    user,
    assignmentId,
    input = {}
  ) {
    return mutateAssignment({
      user,
      assignmentId,
      mutate({
        lead,
        now,
      }) {
        lead.status =
          "calling";
        lead.queueStatus =
          "in_call";
        lead.callAttempts =
          Number(
            lead.callAttempts ||
            0
          ) + 1;
        lead.lastCallStartedAt =
          now;
        lead.lastCallAt =
          now;
        lead.activeCallId =
          clean(
            input.callId
          ) ||
          crypto.randomUUID();

        addTimeline(
          lead,
          {
            type:
              "call_started",
            actorId:
              user.id,
            callId:
              lead.activeCallId,
            attempt:
              lead.callAttempts,
            createdAt:
              now,
          }
        );
      },
    });
  }

  function completeCall(
    user,
    assignmentId,
    input = {}
  ) {
    const outcome =
      normalizeOutcome(
        input.outcome ||
        input.status
      );

    return mutateAssignment({
      user,
      assignmentId,
      mutate({
        lead,
        now,
      }) {
        const durationSeconds =
          Math.max(
            0,
            Number(
              input.durationSeconds ||
              0
            )
          );

        lead.lastCallAt =
          now;
        lead.lastCallEndedAt =
          now;
        lead.lastCallStatus =
          outcome;
        lead.lastCallDurationSeconds =
          durationSeconds;
        lead.totalCallDurationSeconds =
          Number(
            lead.totalCallDurationSeconds ||
            0
          ) +
          durationSeconds;
        lead.activeCallId =
          "";

        if (
          input.notes !==
          undefined
        ) {
          lead.notes =
            clean(
              input.notes
            ).slice(
              0,
              5000
            );
        }

        applyOutcome({
          lead,
          outcome,
          now,
          input,
        });

        addTimeline(
          lead,
          {
            type:
              "call_completed",
            actorId:
              user.id,
            callId:
              clean(
                input.callId
              ),
            outcome,
            durationSeconds,
            notes:
              clean(
                input.notes
              ),
            nextActionAt:
              lead.nextActionAt ||
              "",
            createdAt:
              now,
          }
        );
      },
    });
  }

  function skipLead(
    user,
    assignmentId,
    input = {}
  ) {
    return mutateAssignment({
      user,
      assignmentId,
      mutate({
        lead,
        now,
      }) {
        const delayMinutes =
          clampInteger(
            input.delayMinutes,
            60,
            10,
            1440
          );

        lead.status =
          "skipped";
        lead.queueStatus =
          "held";
        lead.nextActionAt =
          new Date(
            Date.now() +
            delayMinutes *
            60 *
            1000
          ).toISOString();
        lead.updatedAt =
          now;

        addTimeline(
          lead,
          {
            type:
              "lead_skipped",
            actorId:
              user.id,
            reason:
              clean(
                input.reason
              ),
            nextActionAt:
              lead.nextActionAt,
            createdAt:
              now,
          }
        );
      },
    });
  }

  function scheduleCallback(
    user,
    assignmentId,
    input = {}
  ) {
    const callbackAt =
      normalizeFutureDate(
        input.callbackAt ||
        input.nextActionAt,
        "callbackAt"
      );

    return mutateAssignment({
      user,
      assignmentId,
      mutate({
        lead,
        now,
      }) {
        lead.status =
          "callback";
        lead.queueStatus =
          "held";
        lead.callbackAt =
          callbackAt;
        lead.nextActionAt =
          callbackAt;
        lead.notes =
          input.notes !==
          undefined
            ? clean(
                input.notes
              ).slice(
                0,
                5000
              )
            : lead.notes ||
              "";

        addTimeline(
          lead,
          {
            type:
              "callback_scheduled",
            actorId:
              user.id,
            callbackAt,
            notes:
              lead.notes,
            createdAt:
              now,
          }
        );
      },
    });
  }

  function updateOutcome(
    user,
    assignmentId,
    input = {}
  ) {
    const outcome =
      normalizeOutcome(
        input.outcome ||
        input.status
      );

    return mutateAssignment({
      user,
      assignmentId,
      mutate({
        lead,
        now,
      }) {
        applyOutcome({
          lead,
          outcome,
          now,
          input,
        });

        if (
          input.notes !==
          undefined
        ) {
          lead.notes =
            clean(
              input.notes
            ).slice(
              0,
              5000
            );
        }

        addTimeline(
          lead,
          {
            type:
              "outcome_updated",
            actorId:
              user.id,
            outcome,
            notes:
              lead.notes ||
              "",
            nextActionAt:
              lead.nextActionAt ||
              "",
            createdAt:
              now,
          }
        );
      },
    });
  }

  function getHistory(
    user,
    assignmentId
  ) {
    const found =
      findAssignment(
        store.read(),
        assignmentId
      );

    if (!found) {
      throw httpError(
        404,
        "Lead assignment not found."
      );
    }

    const ctx =
      requireCallerOrManager(
        user
      );

    assertAccess(
      ctx,
      user,
      found.lead
    );

    return {
      ok: true,
      assignment:
        publicAssignment(
          found.campaign,
          found.lead
        ),
      timeline:
        Array.isArray(
          found.lead.timeline
        )
          ? found.lead.timeline
          : [],
    };
  }

  function mutateAssignment({
    user,
    assignmentId,
    mutate,
  }) {
    const ctx =
      requireCallerOrManager(
        user
      );

    let result =
      null;

    store.update((draft) => {
      const found =
        findAssignment(
          draft,
          assignmentId
        );

      if (!found) {
        return;
      }

      assertAccess(
        ctx,
        user,
        found.lead
      );

      const now =
        new Date().toISOString();

      mutate({
        ...found,
        now,
      });

      found.lead.updatedAt =
        now;
      found.campaign.updatedAt =
        now;

      result =
        publicAssignment(
          found.campaign,
          found.lead
        );
    });

    if (!result) {
      throw httpError(
        404,
        "Lead assignment not found."
      );
    }

    return {
      ok: true,
      assignment:
        result,
    };
  }

  function requireCallerOrManager(
    user
  ) {
    const ctx =
      workspaceService?.getContext?.(
        user,
        store.read()
      ) || {
        workspaceId:
          user.workspaceId,
        role:
          user.workspaceRole ||
          user.role,
        permissions:
          user.permissions ||
          [],
      };

    if (!ctx.workspaceId) {
      throw httpError(
        403,
        "Workspace access is required."
      );
    }

    return ctx;
  }

  return {
    listQueue,
    nextLead,
    getAssignment,
    markOpened,
    startCall,
    completeCall,
    skipLead,
    scheduleCallback,
    updateOutcome,
    getHistory,
  };
}

function collectAssignments(
  state,
  {
    workspaceId,
    userId,
  }
) {
  const result = [];

  for (
    const campaign
    of state.campaigns ||
    []
  ) {
    if (
      campaign.workspaceId !==
        workspaceId
    ) {
      continue;
    }

    for (
      const lead
      of campaign.leads ||
      []
    ) {
      if (
        lead.assignedTo !==
          userId &&
        lead.assigneeId !==
          userId
      ) {
        continue;
      }

      result.push(
        publicAssignment(
          campaign,
          lead
        )
      );
    }
  }

  return result;
}

function findAssignment(
  state,
  assignmentId
) {
  const normalized =
    clean(
      assignmentId
    );

  for (
    const campaign
    of state.campaigns ||
    []
  ) {
    for (
      const lead
      of campaign.leads ||
      []
    ) {
      const id =
        assignmentIdentity(
          campaign,
          lead
        );

      if (
        id === normalized ||
        lead.assignmentId ===
          normalized ||
        lead.id ===
          normalized
      ) {
        return {
          campaign,
          lead,
        };
      }
    }
  }

  return null;
}

function publicAssignment(
  campaign,
  lead
) {
  const assignmentId =
    assignmentIdentity(
      campaign,
      lead
    );

  return {
    id:
      assignmentId,
    assignmentId,
    workspaceId:
      campaign.workspaceId,
    campaignId:
      campaign.id,
    campaignName:
      campaign.name ||
      "",
    leadId:
      lead.id,
    assigneeId:
      lead.assignedTo ||
      lead.assigneeId ||
      "",
    assignedTo:
      lead.assignedTo ||
      lead.assigneeId ||
      "",
    assignedToName:
      lead.assignedToName ||
      "",
    status:
      normalizeStatus(
        lead.status ||
        "assigned"
      ),
    queueStatus:
      lead.queueStatus ||
      "ready",
    priority:
      lead.priority ||
      "normal",
    callAttempts:
      Number(
        lead.callAttempts ||
        0
      ),
    answeredCalls:
      Number(
        lead.answeredCalls ||
        0
      ),
    lastCallAt:
      lead.lastCallAt ||
      "",
    lastCallStatus:
      lead.lastCallStatus ||
      "",
    nextActionAt:
      lead.nextActionAt ||
      "",
    callbackAt:
      lead.callbackAt ||
      "",
    followUpAt:
      lead.followUpAt ||
      "",
    dailyQueueDate:
      lead.dailyQueueDate ||
      "",
    dailyQueuePosition:
      lead.dailyQueuePosition ??
      null,
    assignedAt:
      lead.assignedAt ||
      "",
    completedAt:
      lead.completedAt ||
      "",
    completedReason:
      lead.completedReason ||
      "",
    notes:
      lead.notes ||
      "",
    miniAudit:
      lead.miniAudit ||
      null,
    miniAuditStatus:
      lead.miniAuditStatus ||
      "",
    lead: {
      ...lead,
    },
    createdAt:
      lead.createdAt ||
      campaign.createdAt ||
      "",
    updatedAt:
      lead.updatedAt ||
      campaign.updatedAt ||
      "",
  };
}

function assignmentIdentity(
  campaign,
  lead
) {
  return (
    lead.assignmentId ||
    `${campaign.id}:${lead.id}:${
      lead.assignedTo ||
      lead.assigneeId ||
      "unassigned"
    }`
  );
}

function applyOutcome({
  lead,
  outcome,
  now,
  input,
}) {
  lead.status =
    outcome;

  lead.queueStatus =
    isClosedStatus(
      outcome
    )
      ? "closed"
      : [
          "no_answer",
          "busy",
          "voicemail",
          "callback",
          "follow_up",
          "skipped",
        ].includes(
          outcome
        )
        ? "held"
        : "ready";

  if (
    [
      "contacted",
      "qualified",
      "meeting_booked",
      "converted",
      "callback",
      "follow_up",
      "not_interested",
      "do_not_call",
    ].includes(
      outcome
    )
  ) {
    lead.answeredCalls =
      Number(
        lead.answeredCalls ||
        0
      ) + 1;

    lead.firstContactedAt =
      lead.firstContactedAt ||
      now;
    lead.lastContactedAt =
      now;
  }

  if (
    isClosedStatus(
      outcome
    )
  ) {
    lead.completedAt =
      now;
    lead.completedReason =
      outcome;
    lead.nextActionAt =
      "";
    lead.callbackAt =
      "";
    lead.followUpAt =
      "";
    return;
  }

  if (
    outcome ===
    "callback"
  ) {
    const callbackAt =
      normalizeFutureDate(
        input.callbackAt ||
        input.nextActionAt,
        "callbackAt"
      );

    lead.callbackAt =
      callbackAt;
    lead.nextActionAt =
      callbackAt;
    return;
  }

  if (
    outcome ===
    "follow_up"
  ) {
    const followUpAt =
      normalizeFutureDate(
        input.followUpAt ||
        input.nextActionAt,
        "followUpAt"
      );

    lead.followUpAt =
      followUpAt;
    lead.nextActionAt =
      followUpAt;
    return;
  }

  const retryDelay =
    retryDelayMinutes(
      outcome,
      Number(
        lead.callAttempts ||
        1
      )
    );

  if (
    retryDelay !==
    null
  ) {
    lead.nextActionAt =
      new Date(
        Date.now() +
        retryDelay *
        60 *
        1000
      ).toISOString();
  } else {
    lead.nextActionAt =
      "";
  }
}

function retryDelayMinutes(
  outcome,
  attempt
) {
  const rules = {
    no_answer: [
      120,
      1440,
      4320,
      10080,
    ],
    busy: [
      30,
      180,
      1440,
      4320,
    ],
    voicemail: [
      240,
      1440,
      4320,
    ],
    failed: [
      60,
      1440,
    ],
  };

  const delays =
    rules[outcome];

  if (!delays) {
    return null;
  }

  return delays[
    Math.min(
      Math.max(
        0,
        attempt - 1
      ),
      delays.length - 1
    )
  ];
}

function belongsToBucket(
  assignment,
  bucket
) {
  const status =
    normalizeStatus(
      assignment.status
    );

  const due =
    isDue(
      assignment.nextActionAt
    );

  if (
    bucket ===
    "all"
  ) {
    return true;
  }

  if (
    bucket ===
    "completed"
  ) {
    return isClosedStatus(
      status
    );
  }

  if (
    bucket ===
    "missed"
  ) {
    return [
      "no_answer",
      "busy",
      "voicemail",
      "failed",
      "exhausted",
    ].includes(
      status
    );
  }

  if (
    bucket ===
    "follow_ups"
  ) {
    return [
      "callback",
      "follow_up",
    ].includes(
      status
    );
  }

  if (
    bucket ===
    "due"
  ) {
    return (
      [
        "callback",
        "follow_up",
        "no_answer",
        "busy",
        "voicemail",
        "skipped",
      ].includes(
        status
      ) &&
      due
    );
  }

  if (
    bucket ===
    "current"
  ) {
    if (
      isClosedStatus(
        status
      )
    ) {
      return false;
    }

    if (
      assignment.nextActionAt &&
      !due
    ) {
      return false;
    }

    return [
      "assigned",
      "in_progress",
      "calling",
      "contacted",
      "no_answer",
      "busy",
      "voicemail",
      "callback",
      "follow_up",
      "skipped",
      "failed",
    ].includes(
      status
    );
  }

  return false;
}

function buildCounts(
  assignments
) {
  const buckets = [
    "current",
    "due",
    "follow_ups",
    "missed",
    "completed",
    "all",
  ];

  return Object.fromEntries(
    buckets.map(
      (bucket) => [
        bucket,
        assignments.filter(
          (assignment) =>
            belongsToBucket(
              assignment,
              bucket
            )
        ).length,
      ]
    )
  );
}

function compareAssignments(
  left,
  right
) {
  const leftDue =
    Date.parse(
      left.nextActionAt ||
      0
    );

  const rightDue =
    Date.parse(
      right.nextActionAt ||
      0
    );

  const leftScore =
    queueScore(
      left
    );

  const rightScore =
    queueScore(
      right
    );

  if (
    leftScore !==
    rightScore
  ) {
    return (
      rightScore -
      leftScore
    );
  }

  if (
    Number.isFinite(
      leftDue
    ) &&
    Number.isFinite(
      rightDue
    ) &&
    leftDue !==
      rightDue
  ) {
    return (
      leftDue -
      rightDue
    );
  }

  return (
    Number(
      left.dailyQueuePosition ??
      Number.MAX_SAFE_INTEGER
    ) -
    Number(
      right.dailyQueuePosition ??
      Number.MAX_SAFE_INTEGER
    )
  );
}

function queueScore(
  assignment
) {
  let score =
    Number(
      assignment.lead
        ?.qualityScore ||
      assignment.lead
        ?.confidence ||
      0
    );

  const status =
    normalizeStatus(
      assignment.status
    );

  if (
    assignment.priority ===
    "urgent"
  ) {
    score += 1000;
  }

  if (
    assignment.priority ===
    "high"
  ) {
    score += 500;
  }

  if (
    status ===
    "callback"
  ) {
    score += 450;
  }

  if (
    status ===
    "follow_up"
  ) {
    score += 400;
  }

  if (
    status ===
    "assigned"
  ) {
    score += 300;
  }

  score -=
    Number(
      assignment.callAttempts ||
      0
    ) * 20;

  return score;
}

function isDue(
  value
) {
  if (!value) {
    return true;
  }

  const timestamp =
    Date.parse(value);

  return (
    Number.isFinite(
      timestamp
    ) &&
    timestamp <=
      Date.now()
  );
}

function isClosedStatus(
  status
) {
  return [
    "qualified",
    "meeting_booked",
    "converted",
    "not_interested",
    "invalid_number",
    "do_not_contact",
    "do_not_call",
    "completed",
    "exhausted",
  ].includes(status);
}

function assertAccess(
  ctx,
  user,
  lead
) {
  if (
    canViewAll(ctx)
  ) {
    return;
  }

  if (
    lead.assignedTo !==
      user.id &&
    lead.assigneeId !==
      user.id
  ) {
    throw httpError(
      403,
      "This lead is not assigned to you."
    );
  }
}

function canViewAll(
  ctx
) {
  return (
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
      "*" 
    ) ||
    ctx.permissions?.includes(
      "view_all_leads"
    )
  );
}

function normalizeBucket(
  value
) {
  const bucket =
    normalizeStatus(
      value
    );

  return [
    "current",
    "due",
    "follow_ups",
    "missed",
    "completed",
    "all",
  ].includes(
    bucket
  )
    ? bucket
    : "current";
}

function normalizeOutcome(
  value
) {
  const outcome =
    normalizeStatus(
      value
    );

  const allowed = [
    "contacted",
    "qualified",
    "meeting_booked",
    "converted",
    "callback",
    "follow_up",
    "no_answer",
    "busy",
    "voicemail",
    "not_interested",
    "invalid_number",
    "do_not_call",
    "completed",
    "failed",
  ];

  if (
    !allowed.includes(
      outcome
    )
  ) {
    throw httpError(
      400,
      "A valid call outcome is required."
    );
  }

  return outcome;
}

function normalizeFutureDate(
  value,
  fieldName
) {
  const timestamp =
    Date.parse(
      value
    );

  if (
    !Number.isFinite(
      timestamp
    ) ||
    timestamp <=
      Date.now()
  ) {
    throw httpError(
      400,
      `${fieldName} must be a future date and time.`
    );
  }

  return new Date(
    timestamp
  ).toISOString();
}

function addTimeline(
  lead,
  event
) {
  lead.timeline =
    Array.isArray(
      lead.timeline
    )
      ? lead.timeline
      : [];

  lead.timeline.unshift({
    id:
      crypto.randomUUID(),
    ...event,
  });
}

function clampInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const number =
    Number.parseInt(
      value,
      10
    );

  if (
    !Number.isFinite(
      number
    )
  ) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      number
    )
  );
}

function normalizeStatus(
  value
) {
  return clean(value)
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

function clean(
  value
) {
  return String(
    value ??
    ""
  ).trim();
}

function httpError(
  statusCode,
  message
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  return error;
}

