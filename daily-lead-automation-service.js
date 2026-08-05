import crypto from "node:crypto";

/**
 * Manager-controlled daily real-lead allocation.
 *
 * - The manager chooses the local assignment time, timezone, niches,
 *   locations, caller scope and target leads per caller.
 * - Every caller receives unique leads for the day.
 * - Existing real Google/imported leads are used before generating a shortage.
 * - Synthetic/test-seed campaigns are never allocated.
 * - Stale "running" records recover automatically.
 */
export function createDailyLeadAutomationService({
  store,
  workspaceService,
  leadFinder,
  leadAuditService = null,
  emit = null,
}) {
  if (!store?.read || !store?.update) {
    throw new Error("createDailyLeadAutomationService requires a store.");
  }

  if (!leadFinder?.findLeads) {
    throw new Error("createDailyLeadAutomationService requires leadFinder.findLeads().");
  }

  const runningWorkspaces = new Map();

  function getConfig(workspaceId, stateOverride = null) {
    const state = stateOverride || store.read();
    const stored =
      state.workspaceSettings?.[workspaceId]?.dailyLeadAutomation || {};

    return {
      enabled:
        stored.enabled ??
        envFlag("DAILY_LEAD_AUTOMATION_ENABLED", false),

      leadsPerCaller: integer(
        stored.leadsPerCaller ?? process.env.DAILY_LEADS_PER_CALLER,
        100,
        1,
        1000
      ),

      assignmentTime: normalizeTime(
        stored.assignmentTime ||
          process.env.DAILY_LEAD_ASSIGNMENT_TIME ||
          buildTimeFromLegacyEnv()
      ),

      timezone: validTimezone(
        stored.timezone ||
          process.env.DAILY_LEAD_TIMEZONE ||
          "Asia/Karachi"
      ),

      selectedCallerIds: unique(
        Array.isArray(stored.selectedCallerIds)
          ? stored.selectedCallerIds
          : []
      ),

      niches: normalizeList(
        stored.niches ??
          process.env.DAILY_LEAD_NICHES ??
          "clinics,dentists,restaurants,law firms,real estate agencies"
      ),

      locations: normalizeList(
        stored.locations ??
          process.env.DAILY_LEAD_LOCATIONS ??
          "California,Texas,Florida,New York"
      ),

      regionCode: clean(
        stored.regionCode ??
          process.env.DAILY_LEAD_REGION_CODE ??
          "US"
      ).toUpperCase(),

      radiusKm: integer(
        stored.radiusKm ?? process.env.DAILY_LEAD_RADIUS_KM,
        50,
        1,
        500
      ),

      qualityLevel:
        clean(
          stored.qualityLevel ??
            process.env.DAILY_LEAD_QUALITY_LEVEL ??
            "balanced"
        ) || "balanced",

      minimumQualityScore: integer(
        stored.minimumQualityScore ??
          process.env.DAILY_LEAD_MIN_QUALITY_SCORE,
        0,
        0,
        100
      ),

      recycleAfterHours: integer(
        stored.recycleAfterHours ??
          process.env.DAILY_LEAD_RECYCLE_AFTER_HOURS,
        24,
        1,
        720
      ),

      maxCallAttempts: integer(
        stored.maxCallAttempts ??
          process.env.DAILY_LEAD_MAX_CALL_ATTEMPTS,
        5,
        1,
        20
      ),

      maxGenerationPerRun: integer(
        stored.maxGenerationPerRun ??
          process.env.DAILY_LEAD_MAX_GENERATION_PER_RUN,
        2000,
        1,
        20000
      ),

      generationBatchSize: integer(
        stored.generationBatchSize ??
          process.env.DAILY_LEAD_GENERATION_BATCH_SIZE,
        200,
        20,
        1000
      ),

      autoMiniAudit:
        stored.autoMiniAudit ??
        envFlag("DAILY_LEAD_AUTO_MINI_AUDIT", true),

      uniquePerDay:
        stored.uniquePerDay !== false,

      keepUnfinishedWork:
        stored.keepUnfinishedWork !== false,

      staleRunMinutes: integer(
        stored.staleRunMinutes ??
          process.env.DAILY_LEAD_STALE_RUN_MINUTES,
        30,
        5,
        240
      ),
    };
  }

  function saveConfig(user, input = {}) {
    const ctx = requireManager(user);
    const current = getConfig(ctx.workspaceId);

    const next = {
      ...current,
      enabled:
        input.enabled === undefined
          ? current.enabled
          : Boolean(input.enabled),
      leadsPerCaller: integer(
        input.leadsPerCaller,
        current.leadsPerCaller,
        1,
        1000
      ),
      assignmentTime: normalizeTime(
        input.assignmentTime || current.assignmentTime
      ),
      timezone: validTimezone(
        input.timezone || current.timezone
      ),
      selectedCallerIds: unique(
        Array.isArray(input.selectedCallerIds)
          ? input.selectedCallerIds
          : current.selectedCallerIds
      ),
      niches: normalizeList(
        input.niches ?? current.niches
      ),
      locations: normalizeList(
        input.locations ?? current.locations
      ),
      regionCode: clean(
        input.regionCode ?? current.regionCode
      ).toUpperCase(),
      radiusKm: integer(
        input.radiusKm,
        current.radiusKm,
        1,
        500
      ),
      qualityLevel:
        clean(input.qualityLevel ?? current.qualityLevel) ||
        "balanced",
      minimumQualityScore: integer(
        input.minimumQualityScore,
        current.minimumQualityScore,
        0,
        100
      ),
      recycleAfterHours: integer(
        input.recycleAfterHours,
        current.recycleAfterHours,
        1,
        720
      ),
      maxCallAttempts: integer(
        input.maxCallAttempts,
        current.maxCallAttempts,
        1,
        20
      ),
      maxGenerationPerRun: integer(
        input.maxGenerationPerRun,
        current.maxGenerationPerRun,
        1,
        20000
      ),
      generationBatchSize: integer(
        input.generationBatchSize,
        current.generationBatchSize,
        20,
        1000
      ),
      autoMiniAudit:
        input.autoMiniAudit === undefined
          ? current.autoMiniAudit
          : Boolean(input.autoMiniAudit),
      uniquePerDay:
        input.uniquePerDay === undefined
          ? current.uniquePerDay
          : Boolean(input.uniquePerDay),
      keepUnfinishedWork:
        input.keepUnfinishedWork === undefined
          ? current.keepUnfinishedWork
          : Boolean(input.keepUnfinishedWork),
      staleRunMinutes: integer(
        input.staleRunMinutes,
        current.staleRunMinutes,
        5,
        240
      ),
      updatedAt: new Date().toISOString(),
      updatedBy: user.id,
    };

    if (!next.niches.length) {
      throw httpError(400, "Add at least one niche.");
    }

    if (!next.locations.length) {
      throw httpError(400, "Add at least one location.");
    }

    store.update((draft) => {
      draft.workspaceSettings =
        draft.workspaceSettings &&
        typeof draft.workspaceSettings === "object"
          ? draft.workspaceSettings
          : {};

      draft.workspaceSettings[ctx.workspaceId] =
        draft.workspaceSettings[ctx.workspaceId] || {};

      draft.workspaceSettings[
        ctx.workspaceId
      ].dailyLeadAutomation = next;
    });

    emitEvent(ctx.workspaceId, "daily-leads:config-updated", {
      config: next,
      updatedBy: user.id,
    });

    return {
      ok: true,
      config: next,
      nextRunAt: nextRunIso(next),
    };
  }

  function getStatus(user) {
    const ctx = requireManager(user);
    const state = store.read();
    const config = getConfig(ctx.workspaceId, state);
    const callers = selectCallers(
      listActiveCallers(state, ctx.workspaceId),
      config.selectedCallerIds
    );

    const latestRun = (state.dailyLeadRuns || [])
      .filter((run) => run.workspaceId === ctx.workspaceId)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0] || null;

    return {
      ok: true,
      config,
      callers: callers.map(publicCaller),
      activeCallerCount: callers.length,
      dailyTarget: callers.length * config.leadsPerCaller,
      running: runningWorkspaces.has(ctx.workspaceId),
      latestRun: publicRun(latestRun),
      nextRunAt: nextRunIso(config),
      now: new Date().toISOString(),
    };
  }

  async function runForUser(user, { force = false } = {}) {
    const ctx = requireManager(user);

    return runWorkspace({
      workspaceId: ctx.workspaceId,
      force,
      source: "manual",
      requestedBy: user.id,
    });
  }

  async function runAllWorkspaces({
    force = false,
    source = "schedule-check",
  } = {}) {
    const state = store.read();
    const workspaceIds = unique([
      ...(state.workspaces || [])
        .filter((workspace) =>
          workspace.active !== false &&
          workspace.isActive !== false
        )
        .map((workspace) => workspace.id),
      ...(state.users || [])
        .map((user) => user.workspaceId)
        .filter(Boolean),
    ]);

    const results = [];

    for (const workspaceId of workspaceIds) {
      const config = getConfig(workspaceId, state);

      if (!config.enabled) {
        continue;
      }

      const due = isRunDue({
        workspaceId,
        config,
        state,
        source,
        force,
      });

      if (!due.due) {
        results.push({
          ok: true,
          skipped: true,
          workspaceId,
          reason: due.reason,
          nextRunAt: nextRunIso(config),
        });
        continue;
      }

      try {
        results.push(
          await runWorkspace({
            workspaceId,
            force,
            source,
          })
        );
      } catch (error) {
        results.push({
          ok: false,
          workspaceId,
          error: error?.message || String(error),
        });
      }
    }

    return {
      ok: results.every((result) => result.ok !== false),
      results,
      completedAt: new Date().toISOString(),
    };
  }

  async function runWorkspace({
    workspaceId,
    force = false,
    source = "schedule-check",
    requestedBy = "",
  }) {
    if (!workspaceId) {
      throw httpError(400, "workspaceId is required.");
    }

    if (runningWorkspaces.has(workspaceId)) {
      return runningWorkspaces.get(workspaceId);
    }

    const task = performWorkspaceRun({
      workspaceId,
      force,
      source,
      requestedBy,
    }).finally(() => {
      runningWorkspaces.delete(workspaceId);
    });

    runningWorkspaces.set(workspaceId, task);
    return task;
  }

  async function performWorkspaceRun({
    workspaceId,
    force,
    source,
    requestedBy,
  }) {
    recoverStaleRuns(workspaceId);

    const initialState = store.read();
    const config = getConfig(workspaceId, initialState);

    if (!config.enabled && source !== "manual") {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        reason: "Daily allocation is disabled.",
      };
    }

    const allCallers = listActiveCallers(initialState, workspaceId);
    const callers = selectCallers(
      allCallers,
      config.selectedCallerIds
    );

    if (!callers.length) {
      throw httpError(
        409,
        "No active selected callers were found."
      );
    }

    const dateKey = zonedDateKey(new Date(), config.timezone);
    const existingComplete = (initialState.dailyLeadRuns || []).find(
      (run) =>
        run.workspaceId === workspaceId &&
        run.dateKey === dateKey &&
        ["completed", "completed_partial"].includes(run.status)
    );

    if (existingComplete && !force) {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        reason: "Today's daily allocation is already complete.",
        run: publicRun(existingComplete),
      };
    }

    const now = new Date().toISOString();
    const run = {
      id: crypto.randomUUID(),
      workspaceId,
      dateKey,
      timezone: config.timezone,
      assignmentTime: config.assignmentTime,
      source,
      requestedBy,
      status: "running",
      callerCount: callers.length,
      callerIds: callers.map((caller) => caller.id),
      leadsPerCaller: config.leadsPerCaller,
      targetCount: callers.length * config.leadsPerCaller,
      reusedCount: 0,
      recycledCount: 0,
      generatedCount: 0,
      assignedCount: 0,
      auditQueuedCount: 0,
      shortfall: 0,
      callerQueues: {},
      errors: [],
      startedAt: now,
      completedAt: "",
      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      draft.dailyLeadRuns = Array.isArray(draft.dailyLeadRuns)
        ? draft.dailyLeadRuns
        : [];
      draft.dailyLeadRuns.unshift(run);
      draft.dailyLeadRuns = draft.dailyLeadRuns.slice(0, 500);
    });

    emitEvent(workspaceId, "daily-leads:run-started", {
      run: publicRun(run),
    });

    try {
      releaseDueLeads({ workspaceId, config });

      let state = store.read();
      const currentCounts = countCurrentDailyWorkload({
        state,
        workspaceId,
        callers,
        dateKey,
        keepUnfinishedWork: config.keepUnfinishedWork,
      });

      const needs = new Map(
        callers.map((caller) => [
          caller.id,
          Math.max(
            0,
            config.leadsPerCaller -
              (currentCounts.get(caller.id) || 0)
          ),
        ])
      );

      const totalNeeded = [...needs.values()].reduce(
        (sum, value) => sum + value,
        0
      );

      if (!totalNeeded) {
        finishRun(run.id, {
          status: "completed",
          callerQueues: Object.fromEntries(
            callers.map((caller) => [
              caller.id,
              {
                callerId: caller.id,
                callerName: caller.name,
                existing: currentCounts.get(caller.id) || 0,
                assigned: 0,
                finalTotal: currentCounts.get(caller.id) || 0,
                target: config.leadsPerCaller,
              },
            ])
          ),
        });

        return {
          ok: true,
          workspaceId,
          run: publicRun(getRun(run.id)),
        };
      }

      const usedIdentityKeys = collectUsedIdentityKeysForDate(
        state,
        workspaceId,
        dateKey
      );

      const reusable = collectReusableLeadRefs({
        state,
        workspaceId,
        config,
        dateKey,
        usedIdentityKeys,
      });

      const selected = reusable.slice(0, totalNeeded);

      const shortage = Math.min(
        Math.max(0, totalNeeded - selected.length),
        config.maxGenerationPerRun
      );

      const generated = shortage
        ? await generateLeadShortfall({
            workspaceId,
            config,
            count: shortage,
            runId: run.id,
            usedIdentityKeys,
          })
        : [];

      state = store.read();

      const combined = dedupeLeadRefs(
        [...selected, ...generated],
        usedIdentityKeys
      ).slice(0, totalNeeded);

      const assignment = assignDailyQueues({
        workspaceId,
        dateKey,
        callers,
        needs,
        currentCounts,
        refs: combined,
        runId: run.id,
        leadsPerCaller: config.leadsPerCaller,
      });

      let auditQueuedCount = 0;

      if (config.autoMiniAudit && leadAuditService) {
        auditQueuedCount = queueMiniAudits({
          callers,
          assignment,
        });
      }

      finishRun(run.id, {
        status:
          assignment.shortfall > 0
            ? "completed_partial"
            : "completed",
        reusedCount: selected.length,
        recycledCount: selected.filter((ref) => ref.recycled).length,
        generatedCount: generated.length,
        assignedCount: assignment.assignedCount,
        auditQueuedCount,
        shortfall: assignment.shortfall,
        callerQueues: assignment.callerQueues,
      });

      const completed = getRun(run.id);

      emitEvent(workspaceId, "daily-leads:run-completed", {
        run: publicRun(completed),
        callerQueues: assignment.callerQueues,
      });

      return {
        ok: true,
        workspaceId,
        run: publicRun(completed),
        callerQueues: assignment.callerQueues,
      };
    } catch (error) {
      finishRun(run.id, {
        status: "failed",
        errors: [error?.message || String(error)],
      });

      emitEvent(workspaceId, "daily-leads:run-failed", {
        run: publicRun(getRun(run.id)),
      });

      throw error;
    }
  }

  function recoverStaleRuns(workspaceId) {
    const state = store.read();
    const config = getConfig(workspaceId, state);
    const cutoff =
      Date.now() - config.staleRunMinutes * 60 * 1000;

    const staleIds = (state.dailyLeadRuns || [])
      .filter(
        (run) =>
          run.workspaceId === workspaceId &&
          run.status === "running" &&
          Date.parse(run.updatedAt || run.startedAt || 0) < cutoff
      )
      .map((run) => run.id);

    if (!staleIds.length) {
      return;
    }

    store.update((draft) => {
      for (const run of draft.dailyLeadRuns || []) {
        if (!staleIds.includes(run.id)) {
          continue;
        }

        run.status = "failed";
        run.errors = [
          ...(Array.isArray(run.errors) ? run.errors : []),
          "Recovered stale running allocation.",
        ];
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
      }
    });
  }

  function releaseDueLeads({ workspaceId, config }) {
    const now = Date.now();

    store.update((draft) => {
      for (const campaign of draft.campaigns || []) {
        if (!belongsToWorkspace(campaign, workspaceId)) {
          continue;
        }

        for (const lead of campaign.leads || []) {
          const status = normalizeStatus(lead.status);

          if (
            ![
              "no_answer",
              "busy",
              "voicemail",
              "callback",
              "follow_up",
              "skipped",
            ].includes(status)
          ) {
            continue;
          }

          const attempts = Number(lead.callAttempts || 0);

          if (
            attempts >= config.maxCallAttempts &&
            !["callback", "follow_up"].includes(status)
          ) {
            lead.status = "exhausted";
            lead.queueStatus = "closed";
            lead.completedAt =
              lead.completedAt || new Date().toISOString();
            continue;
          }

          const explicitTime = Date.parse(
            lead.nextActionAt ||
              lead.callbackAt ||
              lead.followUpAt ||
              0
          );

          const recycleTime =
            Date.parse(
              lead.lastCallAt ||
                lead.updatedAt ||
                lead.assignedAt ||
                0
            ) +
            config.recycleAfterHours * 60 * 60 * 1000;

          const eligibleAt =
            Number.isFinite(explicitTime) && explicitTime > 0
              ? explicitTime
              : recycleTime;

          if (eligibleAt <= now) {
            lead.queueStatus = "ready";
            lead.dailyQueueDate = "";
            lead.dailyQueuePosition = null;
            lead.updatedAt = new Date().toISOString();
          }
        }
      }
    });
  }

  function collectReusableLeadRefs({
    state,
    workspaceId,
    config,
    dateKey,
    usedIdentityKeys,
  }) {
    const refs = [];
    const localSeen = new Set();

    for (const campaign of state.campaigns || []) {
      if (
        !belongsToWorkspace(campaign, workspaceId) ||
        isSyntheticCampaign(campaign)
      ) {
        continue;
      }

      for (const lead of campaign.leads || []) {
        const status = normalizeStatus(lead.status || "new");

        if (
          isTerminalStatus(status) ||
          Number(lead.callAttempts || 0) >= config.maxCallAttempts
        ) {
          continue;
        }

        if (
          Number(lead.qualityScore || lead.confidence || 0) <
          config.minimumQualityScore
        ) {
          continue;
        }

        if (!lead.phone && !lead.website && !lead.email) {
          continue;
        }

        if (lead.dailyQueueDate === dateKey) {
          continue;
        }

        const key = leadIdentity(lead);

        if (
          !key ||
          usedIdentityKeys.has(key) ||
          localSeen.has(key)
        ) {
          continue;
        }

        const assignedElsewhere =
          lead.assignedTo &&
          !isRecyclableStatus(status) &&
          lead.queueStatus !== "ready";

        if (assignedElsewhere) {
          continue;
        }

        localSeen.add(key);

        refs.push({
          campaignId: campaign.id,
          leadId: lead.id,
          identityKey: key,
          score: leadPriority(lead),
          recycled: Boolean(lead.assignedTo || lead.callAttempts),
        });
      }
    }

    return refs.sort((a, b) => b.score - a.score);
  }

  async function generateLeadShortfall({
    workspaceId,
    config,
    count,
    runId,
    usedIdentityKeys,
  }) {
    const generatedRefs = [];
    const generatedKeys = new Set();
    const combinations = [];

    for (const niche of config.niches) {
      for (const location of config.locations) {
        combinations.push({ niche, location });
      }
    }

    let combinationIndex = 0;

    while (
      generatedRefs.length < count &&
      combinationIndex < combinations.length * 4
    ) {
      const combination =
        combinations[combinationIndex % combinations.length];

      const remaining = count - generatedRefs.length;
      const batchLimit = Math.min(
        config.generationBatchSize,
        remaining
      );

      const result = await leadFinder.findLeads({
        runId: `${runId}-${combinationIndex + 1}`,
        niche: combination.niche,
        location: combination.location,
        limit: batchLimit,
        radiusKm: config.radiusKm,
        qualityLevel: config.qualityLevel,
        regionCode: config.regionCode,
        exact: false,
      });

      const usable = [];

      for (const rawLead of result?.leads || []) {
        const lead = normalizeGeneratedLead(rawLead);
        const key = leadIdentity(lead);

        if (
          !key ||
          usedIdentityKeys.has(key) ||
          generatedKeys.has(key)
        ) {
          continue;
        }

        if (!lead.phone && !lead.website && !lead.email) {
          continue;
        }

        generatedKeys.add(key);
        usable.push(lead);
      }

      if (usable.length) {
        const campaignId = crypto.randomUUID();
        const now = new Date().toISOString();

        store.update((draft) => {
          draft.campaigns = Array.isArray(draft.campaigns)
            ? draft.campaigns
            : [];

          draft.campaigns.push({
            id: campaignId,
            workspaceId,
            name: `Daily ${combination.niche} · ${combination.location}`,
            niche: combination.niche,
            location: combination.location,
            source: "automatic-google-places",
            automatic: true,
            dailyLeadRunId: runId,
            status: "active",
            pipelineStatus: "ready",
            leadCount: usable.length,
            leads: usable,
            createdAt: now,
            updatedAt: now,
          });
        });

        for (const lead of usable) {
          generatedRefs.push({
            campaignId,
            leadId: lead.id,
            identityKey: leadIdentity(lead),
            score: leadPriority(lead),
            recycled: false,
            generated: true,
          });

          if (generatedRefs.length >= count) {
            break;
          }
        }
      }

      combinationIndex += 1;
    }

    return generatedRefs.slice(0, count);
  }

  function assignDailyQueues({
    workspaceId,
    dateKey,
    callers,
    needs,
    currentCounts,
    refs,
    runId,
    leadsPerCaller,
  }) {
    const now = new Date().toISOString();
    const queues = Object.fromEntries(
      callers.map((caller) => [caller.id, []])
    );

    let cursor = 0;

    for (const caller of callers) {
      const needed = needs.get(caller.id) || 0;

      for (let index = 0; index < needed && cursor < refs.length; index += 1) {
        queues[caller.id].push(refs[cursor]);
        cursor += 1;
      }
    }

    const assignments = [];
    let assignedCount = 0;

    store.update((draft) => {
      draft.salesAssignments = Array.isArray(draft.salesAssignments)
        ? draft.salesAssignments
        : [];
      draft.leadAssignments = Array.isArray(draft.leadAssignments)
        ? draft.leadAssignments
        : [];
      draft.teamTasks = Array.isArray(draft.teamTasks)
        ? draft.teamTasks
        : [];

      for (const caller of callers) {
        let position = currentCounts.get(caller.id) || 0;

        for (const ref of queues[caller.id]) {
          const campaign = (draft.campaigns || []).find(
            (item) => item.id === ref.campaignId
          );
          const lead = (campaign?.leads || []).find(
            (item) => item.id === ref.leadId
          );

          if (!campaign || !lead) {
            continue;
          }

          position += 1;

          const assignmentId = crypto.randomUUID();
          const assignment = {
            id: assignmentId,
            workspaceId,
            campaignId: campaign.id,
            campaignName: campaign.name,
            leadId: lead.id,
            userId: caller.id,
            callerId: caller.id,
            assignedTo: caller.id,
            assigneeId: caller.id,
            assignedBy: "daily-automation",
            source: "daily-automation",
            dailyLeadRunId: runId,
            assignmentDate: dateKey,
            dailyQueueDate: dateKey,
            dailyQueuePosition: position,
            status: "assigned",
            queueStatus: "ready",
            priority: lead.priority || "normal",
            nextActionAt: now,
            createdAt: now,
            updatedAt: now,
          };

          draft.salesAssignments.push(assignment);

          // Compatibility with builds still reading leadAssignments.
          draft.leadAssignments.push({ ...assignment });

          draft.teamTasks.push({
            id: crypto.randomUUID(),
            workspaceId,
            campaignId: campaign.id,
            leadId: lead.id,
            assignmentId,
            assignedTo: caller.id,
            assignedToUserId: caller.id,
            createdBy: "daily-automation",
            source: "daily-automation",
            type: "lead_call",
            title: `Call ${lead.business || lead.name || "lead"}`,
            description:
              "Review the mini audit, call the lead and record the outcome.",
            status: "pending",
            priority: lead.priority || "normal",
            dueAt: now,
            createdAt: now,
            updatedAt: now,
          });

          lead.assignmentId = assignmentId;
          lead.assignedTo = caller.id;
          lead.assigneeId = caller.id;
          lead.assignedToName = caller.name;
          lead.assignedBy = "daily-automation";
          lead.assignedAt = now;
          lead.dailyQueueDate = dateKey;
          lead.dailyQueuePosition = position;
          lead.dailyLeadRunId = runId;
          lead.queueStatus = "ready";

          if (
            !lead.status ||
            ["unassigned", "new", "ready"].includes(
              normalizeStatus(lead.status)
            )
          ) {
            lead.status = "assigned";
          }

          lead.updatedAt = now;

          lead.timeline = Array.isArray(lead.timeline)
            ? lead.timeline
            : [];

          lead.timeline.unshift({
            id: crypto.randomUUID(),
            type: "daily_assignment",
            actorId: "daily-automation",
            assignedTo: caller.id,
            status: lead.status,
            runId,
            createdAt: now,
          });

          assignments.push(assignment);
          assignedCount += 1;
        }
      }
    });

    const callerQueues = Object.fromEntries(
      callers.map((caller) => {
        const existing = currentCounts.get(caller.id) || 0;
        const assigned = queues[caller.id].length;

        return [
          caller.id,
          {
            callerId: caller.id,
            callerName: caller.name,
            existing,
            assigned,
            finalTotal: existing + assigned,
            target: leadsPerCaller,
          },
        ];
      })
    );

    const target = [...needs.values()].reduce(
      (sum, value) => sum + value,
      0
    );

    return {
      assignedCount,
      shortfall: Math.max(0, target - assignedCount),
      callerQueues,
      assignments,
    };
  }

  function queueMiniAudits({ callers, assignment }) {
    const callerMap = new Map(
      callers.map((caller) => [caller.id, caller])
    );
    const state = store.read();
    const groups = new Map();

    for (const item of assignment.assignments) {
      const campaign = (state.campaigns || []).find(
        (candidate) => candidate.id === item.campaignId
      );
      const lead = (campaign?.leads || []).find(
        (candidate) => candidate.id === item.leadId
      );

      if (!lead?.website || lead.miniAudit) {
        continue;
      }

      const status = normalizeStatus(lead.miniAuditStatus);

      if (
        ["queued", "processing", "running", "complete", "completed"].includes(
          status
        )
      ) {
        continue;
      }

      const caller = callerMap.get(item.callerId);
      if (!caller) {
        continue;
      }

      const group = groups.get(caller.id) || {
        caller,
        leads: [],
      };

      group.leads.push(lead);
      groups.set(caller.id, group);
    }

    let queued = 0;

    for (const { caller, leads } of groups.values()) {
      try {
        const result = leadAuditService.queueMiniBatch(
          caller,
          {
            leads: leads.slice(0, 1000),
            source: "daily-automation",
          }
        );

        queued += Number(
          result?.queued ||
            result?.count ||
            leads.length
        );
      } catch (error) {
        console.warn("[daily-leads] mini audit queue failed", {
          callerId: caller.id,
          message: error?.message || String(error),
        });
      }
    }

    return queued;
  }

  function finishRun(runId, patch) {
    store.update((draft) => {
      const run = (draft.dailyLeadRuns || []).find(
        (item) => item.id === runId
      );

      if (!run) {
        return;
      }

      Object.assign(run, patch, {
        completedAt:
          patch.status === "running"
            ? ""
            : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  function getRun(runId) {
    return (
      (store.read().dailyLeadRuns || []).find(
        (run) => run.id === runId
      ) || null
    );
  }

  function requireManager(user) {
    const state = store.read();
    const ctx =
      workspaceService?.getContext?.(user, state) || {
        user,
        workspaceId: user.workspaceId,
        role: user.workspaceRole || user.role,
        permissions: user.permissions || [],
      };

    const role = normalizeStatus(ctx.role);

    if (
      !["owner", "admin", "manager"].includes(role) &&
      !ctx.permissions?.includes("manage_campaigns")
    ) {
      throw httpError(403, "Manager access is required.");
    }

    return ctx;
  }

  function emitEvent(workspaceId, event, payload) {
    try {
      emit?.({
        workspaceId,
        event,
        payload,
      });
    } catch (error) {
      console.warn("[daily-leads] event emit failed", {
        workspaceId,
        event,
        message: error?.message || String(error),
      });
    }
  }

  return {
    getConfig,
    saveConfig,
    getStatus,
    runForUser,
    runAllWorkspaces,
    runWorkspace,
  };
}

function listActiveCallers(state, workspaceId) {
  const membershipByUser = new Map(
    (state.workspaceMembers || [])
      .filter(
        (member) =>
          member.workspaceId === workspaceId &&
          member.active !== false &&
          member.isActive !== false
      )
      .map((member) => [member.userId, member])
  );

  return (state.users || [])
    .filter((user) => {
      const membership = membershipByUser.get(user.id);
      const role = normalizeStatus(
        membership?.workspaceRole ||
          membership?.role ||
          user.workspaceRole ||
          user.role
      );

      return (
        user.workspaceId === workspaceId &&
        user.active !== false &&
        user.isActive !== false &&
        role === "caller"
      );
    })
    .map((user) => ({
      ...user,
      workspaceRole: "caller",
      role: "caller",
      permissions:
        membershipByUser.get(user.id)?.permissions ||
        user.permissions ||
        [],
    }));
}

function selectCallers(callers, selectedCallerIds) {
  if (!selectedCallerIds.length) {
    return callers;
  }

  const selected = new Set(selectedCallerIds);
  return callers.filter((caller) => selected.has(caller.id));
}

function countCurrentDailyWorkload({
  state,
  workspaceId,
  callers,
  dateKey,
  keepUnfinishedWork,
}) {
  const counts = new Map(
    callers.map((caller) => [caller.id, 0])
  );
  const callerIds = new Set(callers.map((caller) => caller.id));
  const seen = new Set();

  for (const campaign of state.campaigns || []) {
    if (!belongsToWorkspace(campaign, workspaceId)) {
      continue;
    }

    for (const lead of campaign.leads || []) {
      if (
        !callerIds.has(lead.assignedTo) ||
        isTerminalStatus(normalizeStatus(lead.status))
      ) {
        continue;
      }

      const isToday = lead.dailyQueueDate === dateKey;
      const unfinished =
        keepUnfinishedWork &&
        Boolean(lead.assignedTo) &&
        lead.queueStatus !== "closed";

      if (!isToday && !unfinished) {
        continue;
      }

      const key = `${lead.assignedTo}:${leadIdentity(lead)}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      counts.set(
        lead.assignedTo,
        (counts.get(lead.assignedTo) || 0) + 1
      );
    }
  }

  return counts;
}

function collectUsedIdentityKeysForDate(
  state,
  workspaceId,
  dateKey
) {
  const keys = new Set();

  for (const campaign of state.campaigns || []) {
    if (!belongsToWorkspace(campaign, workspaceId)) {
      continue;
    }

    for (const lead of campaign.leads || []) {
      if (lead.dailyQueueDate !== dateKey) {
        continue;
      }

      const key = leadIdentity(lead);
      if (key) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function dedupeLeadRefs(refs, alreadyUsed = new Set()) {
  const seen = new Set(alreadyUsed);
  const result = [];

  for (const ref of refs || []) {
    const key = ref.identityKey || `${ref.campaignId}:${ref.leadId}`;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(ref);
  }

  return result;
}

function normalizeGeneratedLead(raw) {
  const now = new Date().toISOString();

  return {
    ...raw,
    id: raw.id || crypto.randomUUID(),
    business: clean(raw.business || raw.name),
    name: clean(raw.name || raw.business),
    phone: clean(
      raw.phone ||
        raw.internationalPhoneNumber ||
        raw.nationalPhoneNumber
    ),
    email: clean(raw.email),
    website: clean(raw.website || raw.websiteUri),
    address: clean(raw.address || raw.formattedAddress || raw.location),
    source: "google-places",
    status: "new",
    queueStatus: "ready",
    callAttempts: 0,
    createdAt: raw.createdAt || now,
    updatedAt: now,
  };
}

function leadIdentity(lead) {
  const placeId = clean(lead.placeId || lead.googlePlaceId).toLowerCase();
  if (placeId) {
    return `place:${placeId}`;
  }

  const website = normalizeWebsite(lead.website || lead.websiteUri);
  if (website) {
    return `web:${website}`;
  }

  const phone = clean(lead.phone).replace(/\D/g, "");
  if (phone) {
    return `phone:${phone}`;
  }

  const email = clean(lead.email).toLowerCase();
  if (email) {
    return `email:${email}`;
  }

  const name = clean(lead.business || lead.name).toLowerCase();
  const address = clean(lead.address).toLowerCase();

  return name || address
    ? `name:${name}|${address}`
    : "";
}

function normalizeWebsite(value) {
  const text = clean(value);
  if (!text) {
    return "";
  }

  try {
    const url = new URL(
      /^https?:\/\//i.test(text) ? text : `https://${text}`
    );

    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return text
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  }
}

function leadPriority(lead) {
  const status = normalizeStatus(lead.status || "new");
  let score = Number(lead.qualityScore || lead.confidence || 0);

  if (["callback", "follow_up"].includes(status)) {
    score += 500;
  }

  if (["no_answer", "busy", "voicemail"].includes(status)) {
    score += 300;
  }

  if (!lead.assignedTo) {
    score += 200;
  }

  if (lead.phone) {
    score += 80;
  }

  if (lead.website) {
    score += 40;
  }

  score -= Number(lead.callAttempts || 0) * 20;
  return score;
}

function isRecyclableStatus(status) {
  return [
    "new",
    "assigned",
    "ready",
    "no_answer",
    "busy",
    "voicemail",
    "callback",
    "follow_up",
    "skipped",
  ].includes(status);
}

function isTerminalStatus(status) {
  return [
    "qualified",
    "converted",
    "meeting_booked",
    "not_interested",
    "do_not_call",
    "invalid_number",
    "wrong_number",
    "closed",
    "completed",
    "exhausted",
  ].includes(status);
}

function belongsToWorkspace(campaign, workspaceId) {
  return campaign?.workspaceId === workspaceId;
}

function isSyntheticCampaign(campaign) {
  const source = normalizeStatus(campaign?.source);

  return (
    ["test_seed", "seed", "synthetic_seed", "demo_seed"].includes(source) ||
    campaign?.automaticSeed === true ||
    campaign?.seeded === true
  );
}

function isRunDue({
  workspaceId,
  config,
  state,
  source,
  force,
}) {
  if (force || source === "manual") {
    return { due: true, reason: "forced" };
  }

  const now = new Date();
  const dateKey = zonedDateKey(now, config.timezone);

  const completed = (state.dailyLeadRuns || []).some(
    (run) =>
      run.workspaceId === workspaceId &&
      run.dateKey === dateKey &&
      ["completed", "completed_partial"].includes(run.status)
  );

  if (completed) {
    return {
      due: false,
      reason: "Today's allocation is complete.",
    };
  }

  const currentMinutes = zonedMinuteOfDay(now, config.timezone);
  const scheduledMinutes = timeToMinutes(config.assignmentTime);

  if (source === "startup-catch-up") {
    return {
      due: currentMinutes >= scheduledMinutes,
      reason:
        currentMinutes >= scheduledMinutes
          ? "Startup catch-up is due."
          : "Today's configured time has not arrived.",
    };
  }

  // The server checks frequently; this five-minute window prevents a missed
  // run while the date-level completed record prevents duplicates.
  const difference = currentMinutes - scheduledMinutes;

  return {
    due: difference >= 0 && difference < 5,
    reason:
      difference >= 0 && difference < 5
        ? "Configured daily time is due."
        : "Configured daily time is not due.",
  };
}

function nextRunIso(config) {
  const now = new Date();
  const [hour, minute] = config.assignmentTime
    .split(":")
    .map(Number);

  const currentParts = zonedParts(now, config.timezone);
  let dateKey = `${currentParts.year}-${pad(currentParts.month)}-${pad(
    currentParts.day
  )}`;

  const currentMinutes =
    currentParts.hour * 60 + currentParts.minute;
  const targetMinutes = hour * 60 + minute;

  if (currentMinutes >= targetMinutes) {
    dateKey = addDays(dateKey, 1);
  }

  return zonedDateTimeToUtc({
    dateKey,
    hour,
    minute,
    timeZone: config.timezone,
  }).toISOString();
}

function zonedDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function zonedMinuteOfDay(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const map = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function zonedDateTimeToUtc({
  dateKey,
  hour,
  minute,
  timeZone,
}) {
  const [year, month, day] = dateKey.split("-").map(Number);
  let estimate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  );

  for (let index = 0; index < 4; index += 1) {
    const parts = zonedParts(estimate, timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const expected = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      0
    );

    estimate = new Date(
      estimate.getTime() + expected - represented
    );
  }

  return estimate;
}

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day + amount)
  )
    .toISOString()
    .slice(0, 10);
}

function buildTimeFromLegacyEnv() {
  return `${pad(
    integer(
      process.env.DAILY_LEAD_ASSIGNMENT_HOUR,
      0,
      0,
      23
    )
  )}:${pad(
    integer(
      process.env.DAILY_LEAD_ASSIGNMENT_MINUTE,
      0,
      0,
      59
    )
  )}`;
}

function normalizeTime(value) {
  const match = clean(value).match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return "00:00";
  }

  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));

  return `${pad(hour)}:${pad(minute)}`;
}

function timeToMinutes(value) {
  const [hour, minute] = normalizeTime(value)
    .split(":")
    .map(Number);

  return hour * 60 + minute;
}

function validTimezone(value) {
  const timezone = clean(value) || "UTC";

  try {
    new Intl.DateTimeFormat("en", {
      timeZone: timezone,
    }).format(new Date());

    return timezone;
  } catch {
    return "UTC";
  }
}

function publicCaller(caller) {
  return {
    id: caller.id,
    name: caller.name || caller.fullName || caller.email,
    email: caller.email || "",
    avatarUrl:
      caller.avatarUrl ||
      caller.photoUrl ||
      caller.profileImage ||
      "",
    active:
      caller.active !== false &&
      caller.isActive !== false,
  };
}

function publicRun(run) {
  if (!run) {
    return null;
  }

  return {
    ...run,
    errors: Array.isArray(run.errors) ? run.errors : [],
  };
}

function normalizeList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[,\n]/);

  return unique(values.map(clean).filter(Boolean));
}

function unique(values) {
  return [...new Set((values || []).map(clean).filter(Boolean))];
}

function integer(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeStatus(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function clean(value) {
  return String(value ?? "").trim();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function envFlag(name, fallback = false) {
  const value = clean(process.env[name]).toLowerCase();

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
