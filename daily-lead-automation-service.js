import crypto from "node:crypto";

/* ==========================================================================
   Constants
   ========================================================================== */

const ACTIVE_CALLER_ROLES = new Set([
  "caller",
]);

const TERMINAL_LEAD_STATUSES = new Set([
  "qualified",
  "converted",
  "customer",
  "closed",
  "completed",
  "meeting_booked",
  "appointment_booked",
  "not_interested",
  "do_not_call",
  "invalid_number",
  "wrong_number",
  "duplicate",
  "blocked",
]);

const RECYCLABLE_LEAD_STATUSES = new Set([
  "",
  "new",
  "assigned",
  "pending",
  "ready",
  "in_progress",
  "no_answer",
  "busy",
  "voicemail",
  "callback",
  "follow_up",
  "missed",
  "unreachable",
]);

const ACTIVE_ASSIGNMENT_STATUSES = new Set([
  "",
  "assigned",
  "pending",
  "ready",
  "current",
  "in_progress",
  "callback",
  "follow_up",
]);

const FINISHED_RUN_STATUSES = new Set([
  "completed",
  "completed_partial",
]);

const DEFAULT_TIMEZONE =
  process.env.DAILY_LEAD_TIMEZONE ||
  "Asia/Karachi";

const DEFAULT_ASSIGNMENT_HOUR =
  clampInteger(
    process.env.DAILY_LEAD_ASSIGNMENT_HOUR,
    4,
    0,
    23
  );

const DEFAULT_ASSIGNMENT_MINUTE =
  clampInteger(
    process.env.DAILY_LEAD_ASSIGNMENT_MINUTE,
    0,
    0,
    59
  );

const DEFAULT_LEADS_PER_CALLER =
  clampInteger(
    process.env.DAILY_LEADS_PER_CALLER,
    100,
    1,
    5000
  );

const DEFAULT_RECYCLE_AFTER_HOURS =
  clampInteger(
    process.env.DAILY_LEAD_RECYCLE_AFTER_HOURS,
    24,
    1,
    24 * 365
  );

const DEFAULT_MAX_CALL_ATTEMPTS =
  clampInteger(
    process.env.DAILY_LEAD_MAX_CALL_ATTEMPTS,
    5,
    1,
    100
  );

const DEFAULT_GENERATION_BATCH_SIZE =
  clampInteger(
    process.env.DAILY_LEAD_GENERATION_BATCH_SIZE,
    200,
    1,
    1000
  );

const DEFAULT_MAX_GENERATION_PER_RUN =
  clampInteger(
    process.env.DAILY_LEAD_MAX_GENERATION_PER_RUN,
    2000,
    1,
    100000
  );

const DEFAULT_STARTUP_DELAY_MS =
  clampInteger(
    process.env.DAILY_LEAD_STARTUP_DELAY_MS,
    15000,
    0,
    60 * 60 * 1000
  );

const DEFAULT_STALE_RUN_MINUTES =
  clampInteger(
    process.env.DAILY_LEAD_STALE_RUN_MINUTES,
    30,
    1,
    24 * 60
  );

const DEFAULT_NICHES =
  parseCsv(
    process.env.DAILY_LEAD_NICHES ||
      "clinics,dentists,restaurants,law firms,real estate agencies"
  );

const DEFAULT_LOCATIONS =
  parseCsv(
    process.env.DAILY_LEAD_LOCATIONS ||
      "California,Texas,Florida,New York"
  );

const DEFAULT_LOCAL_PAKISTAN_LOCATIONS =
  parseCsv(
    process.env.DAILY_LEAD_LOCAL_PAKISTAN_LOCATIONS ||
      "Karachi,Lahore,Islamabad,Rawalpindi,Faisalabad,Multan,Peshawar,Sialkot,Gujranwala"
  );

const DEFAULT_REGION_CODE =
  String(
    process.env.DAILY_LEAD_REGION_CODE ||
      "US"
  ).trim();

const DEFAULT_RADIUS_KM =
  clampNumber(
    process.env.DAILY_LEAD_RADIUS_KM,
    50,
    1,
    500
  );

const DEFAULT_QUALITY_LEVEL =
  String(
    process.env.DAILY_LEAD_QUALITY_LEVEL ||
      "balanced"
  ).trim();

const AUTO_MINI_AUDIT =
  envFlag(
    "DAILY_LEAD_AUTO_MINI_AUDIT",
    true
  );

/* ==========================================================================
   Service
   ========================================================================== */

export function createDailyLeadAutomationService({
  store,
  workspaceService,
  leadFinder,
  leadAuditService = null,
  emitToWorkspace = null,
  emit = null,
} = {}) {
  if (
    !store?.read ||
    !store?.update
  ) {
    throw new Error(
      "createDailyLeadAutomationService requires a store exposing read() and update()."
    );
  }

  if (
    !leadFinder?.findLeads
  ) {
    throw new Error(
      "createDailyLeadAutomationService requires leadFinder.findLeads()."
    );
  }

  const workspaceEmitter =
    typeof emitToWorkspace === "function"
      ? emitToWorkspace
      : typeof emit === "function"
        ? (workspaceId, eventName, payload) =>
            emit({ workspaceId, event: eventName, payload })
        : null;

  let stopped = false;
  let schedulerTimer = null;
  let startupTimer = null;
  let schedulerRunning = false;

  const workspaceLocks =
    new Map();

  /* ------------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------------ */

  function getConfig(
    workspaceId = ""
  ) {
    const state =
      store.read();

    const stored =
      state.workspaceSettings?.[
        workspaceId
      ]?.dailyLeadAutomation ||
      {};

    return normalizeConfig({
      enabled:
        stored.enabled ??
        envFlag(
          "DAILY_LEAD_AUTOMATION_ENABLED",
          false
        ),

      leadsPerCaller:
        stored.leadsPerCaller ??
        DEFAULT_LEADS_PER_CALLER,

      timezone:
        stored.timezone ||
        DEFAULT_TIMEZONE,

      assignmentHour:
        stored.assignmentHour ??
        DEFAULT_ASSIGNMENT_HOUR,

      assignmentMinute:
        stored.assignmentMinute ??
        DEFAULT_ASSIGNMENT_MINUTE,

      recycleAfterHours:
        stored.recycleAfterHours ??
        DEFAULT_RECYCLE_AFTER_HOURS,

      maxCallAttempts:
        stored.maxCallAttempts ??
        DEFAULT_MAX_CALL_ATTEMPTS,

      generationBatchSize:
        stored.generationBatchSize ??
        DEFAULT_GENERATION_BATCH_SIZE,

      maxGenerationPerRun:
        stored.maxGenerationPerRun ??
        DEFAULT_MAX_GENERATION_PER_RUN,

      niches:
        Array.isArray(
          stored.niches
        ) &&
        stored.niches.length
          ? stored.niches
          : DEFAULT_NICHES,

      locations:
        Array.isArray(
          stored.locations
        ) &&
        stored.locations.length
          ? stored.locations
          : DEFAULT_LOCATIONS,

      localPakistanLocations:
        Array.isArray(
          stored.localPakistanLocations
        ) &&
        stored.localPakistanLocations.length
          ? stored.localPakistanLocations
          : DEFAULT_LOCAL_PAKISTAN_LOCATIONS,

      regionCode:
        stored.regionCode ||
        DEFAULT_REGION_CODE,

      radiusKm:
        stored.radiusKm ??
        DEFAULT_RADIUS_KM,

      qualityLevel:
        stored.qualityLevel ||
        DEFAULT_QUALITY_LEVEL,

      autoMiniAudit:
        stored.autoMiniAudit ??
        AUTO_MINI_AUDIT,

      callerPlans:
        stored.callerPlans ||
        {},

      staleRunMinutes:
        stored.staleRunMinutes ??
        DEFAULT_STALE_RUN_MINUTES,
    });
  }

  function saveConfig(
    user,
    input = {}
  ) {
    const context =
      getContext(user);

    requireManager(context);

    const current =
      getConfig(
        context.workspaceId
      );

    const next =
      normalizeConfig({
        ...current,
        ...input,
      });

    store.update(
      (draft) => {
        ensureState(
          draft
        );

        draft.workspaceSettings[
          context.workspaceId
        ] =
          draft.workspaceSettings[
            context.workspaceId
          ] ||
          {};

        draft.workspaceSettings[
          context.workspaceId
        ].dailyLeadAutomation =
          next;
      }
    );

    emitWorkspaceEvent(
      context.workspaceId,
      "daily-leads:config-updated",
      {
        config: next,
        updatedBy: user.id,
        updatedAt: new Date().toISOString(),
      }
    );

    // Manager timing changes take effect immediately. The scheduler is rebuilt
    // from persisted workspace configuration instead of stale environment values.
    scheduleNextRun();

    // If the manager moves today's cutoff to a time that has already passed,
    // safely catch up now. Completed daily runs remain idempotent and are skipped.
    void runDueWorkspaces({
      source:
        "manager-config-catch-up",
    }).catch((error) => {
      console.error(
        `[daily-leads] manager config catch-up failed ${JSON.stringify({
          at:
            new Date().toISOString(),
          workspaceId:
            context.workspaceId,
          message:
            error?.message ||
            String(error),
        })}`
      );
    });

    return {
      ok: true,
      config: next,
      nextRunAt:
        getNextScheduledRunDate(
          new Date(),
          next
        ).toISOString(),
    };
  }

  function status(
    user
  ) {
    const context =
      getContext(user);

    requireManager(context);

    const state =
      store.read();

    const config =
      getConfig(
        context.workspaceId
      );

    const runs =
      (
        state.dailyLeadRuns ||
        []
      )
        .filter(
          (run) =>
            run.workspaceId ===
            context.workspaceId
        )
        .sort(
          (left, right) =>
            Date.parse(
              right.createdAt ||
                0
            ) -
            Date.parse(
              left.createdAt ||
                0
            )
        );

    const callers =
      getActiveCallers(
        state,
        context.workspaceId
      );

    const dateKey =
      getBusinessDateKey(
        new Date(),
        config
      );

    const nextRunAt =
      getNextScheduledRunDate(
        new Date(),
        config
      ).toISOString();

    return {
      ok: true,

      workspaceId:
        context.workspaceId,

      config,

      callerCount:
        callers.length,

      dateKey,

      nextRunAt,

      callers:
        callers.map(
          (caller, index) => {
            const plan =
              resolveCallerPlan(
                config,
                caller,
                index
              );

            const dayStats =
              getCallerDayStats({
                state,
                workspaceId:
                  context.workspaceId,
                callerId:
                  caller.id,
                dateKey,
              });

            const submission =
              getCallerSubmission({
                state,
                workspaceId:
                  context.workspaceId,
                callerId:
                  caller.id,
                dateKey,
              });

            return {
              id: caller.id,
              name:
                caller.name ||
                caller.fullName ||
                caller.email ||
                "Caller",
              email:
                caller.email ||
                "",
              currentNiche:
                dayStats.niche ||
                "",
              currentResourceType:
                dayStats.resourceType ||
                "",
              currentLocation:
                dayStats.location ||
                "",
              currentCountry:
                dayStats.country ||
                "",
              nextNiche:
                plan.niche ||
                "",
              nextResourceType:
                plan.resourceType ||
                "international",
              nextLocation:
                plan.location ||
                "",
              nextCountry:
                plan.country ||
                "",
              nextRegionCode:
                plan.regionCode ||
                "",
              assignedToday:
                dayStats.assigned,
              workedToday:
                dayStats.worked,
              remainingToday:
                dayStats.remaining,
              submission:
                submission ||
                null,
            };
          }
        ),

      todayRun:
        runs.find(
          (run) =>
            run.dateKey ===
            dateKey
        ) ||
        null,

      latestRun:
        runs[0] ||
        null,

      recentRuns:
        runs.slice(
          0,
          20
        ),
    };
  }

  function myDay(
    user
  ) {
    const context =
      getContext(user);

    const role =
      normalizeRole(
        context?.role ||
        user?.workspaceRole ||
        user?.role
      );

    if (role !== "caller") {
      throw httpError(
        403,
        "Caller access is required."
      );
    }

    const config =
      getConfig(
        context.workspaceId
      );

    const state =
      store.read();

    const callers =
      getActiveCallers(
        state,
        context.workspaceId
      );

    const callerIndex =
      Math.max(
        0,
        callers.findIndex(
          (caller) =>
            caller.id ===
            user.id
        )
      );

    const caller =
      callers[callerIndex] ||
      user;

    const dateKey =
      getBusinessDateKey(
        new Date(),
        config
      );

    const stats =
      getCallerDayStats({
        state,
        workspaceId:
          context.workspaceId,
        callerId:
          user.id,
        dateKey,
      });

    const plan =
      resolveCallerPlan(
        config,
        caller,
        callerIndex
      );

    const submission =
      getCallerSubmission({
        state,
        workspaceId:
          context.workspaceId,
        callerId:
          user.id,
        dateKey,
      });

    return {
      ok: true,
      workspaceId:
        context.workspaceId,
      dateKey,
      timezone:
        config.timezone,
      assignmentHour:
        config.assignmentHour,
      assignmentMinute:
        config.assignmentMinute,
      leadsPerCaller:
        config.leadsPerCaller,
      nextRefreshAt:
        getNextScheduledRunDate(
          new Date(),
          config
        ).toISOString(),
      currentNiche:
        stats.niche ||
        "",
      currentResourceType:
        stats.resourceType ||
        "",
      currentLocation:
        stats.location ||
        "",
      currentCountry:
        stats.country ||
        "",
      nextNiche:
        plan.niche ||
        "",
      nextResourceType:
        plan.resourceType ||
        "international",
      nextLocation:
        plan.location ||
        "",
      nextCountry:
        plan.country ||
        "",
      nextRegionCode:
        plan.regionCode ||
        "",
      assigned:
        stats.assigned,
      worked:
        stats.worked,
      closed:
        stats.closed,
      remaining:
        stats.remaining,
      submission:
        submission ||
        null,
    };
  }

  function submitMyDay(
    user,
    input = {}
  ) {
    const context =
      getContext(user);

    const role =
      normalizeRole(
        context?.role ||
        user?.workspaceRole ||
        user?.role
      );

    if (role !== "caller") {
      throw httpError(
        403,
        "Caller access is required."
      );
    }

    const config =
      getConfig(
        context.workspaceId
      );

    const dateKey =
      getBusinessDateKey(
        new Date(),
        config
      );

    const submittedAt =
      new Date().toISOString();

    let saved = null;

    store.update(
      (draft) => {
        ensureState(draft);

        const stats =
          getCallerDayStats({
            state: draft,
            workspaceId:
              context.workspaceId,
            callerId:
              user.id,
            dateKey,
          });

        const existing =
          draft.dailyCallerSubmissions.find(
            (item) =>
              item.workspaceId ===
                context.workspaceId &&
              item.callerId ===
                user.id &&
              item.dateKey ===
                dateKey
          );

        const record = {
          id:
            existing?.id ||
            crypto.randomUUID(),
          workspaceId:
            context.workspaceId,
          callerId:
            user.id,
          callerName:
            user.name ||
            user.fullName ||
            user.email ||
            "Caller",
          dateKey,
          status:
            "submitted",
          assigned:
            stats.assigned,
          worked:
            stats.worked,
          closed:
            stats.closed,
          remaining:
            stats.remaining,
          notes:
            String(
              input.notes ||
              ""
            ).slice(0, 2000),
          submittedAt,
          deadlineAt:
            getNextScheduledRunDate(
              new Date(),
              config
            ).toISOString(),
          createdAt:
            existing?.createdAt ||
            submittedAt,
          updatedAt:
            submittedAt,
        };

        if (existing) {
          Object.assign(
            existing,
            record
          );
          saved = {
            ...existing,
          };
        } else {
          draft.dailyCallerSubmissions.unshift(
            record
          );
          saved = {
            ...record,
          };
        }
      }
    );

    emitWorkspaceEvent(
      context.workspaceId,
      "daily-leads:submitted",
      {
        submission: saved,
      }
    );

    return {
      ok: true,
      submission: saved,
    };
  }

  function getWorkspaceIds() {
    const state = store.read();
    const ids = new Set();

    for (const workspace of state.workspaces || []) {
      if (
        workspace?.id &&
        workspace.active !== false &&
        workspace.isActive !== false &&
        workspace.status !== "inactive"
      ) {
        ids.add(workspace.id);
      }
    }

    for (const user of state.users || []) {
      if (user?.workspaceId) {
        ids.add(user.workspaceId);
      }
    }

    return [...ids];
  }

  async function runDueWorkspaces({
    source = "scheduler",
  } = {}) {
    const now = new Date();
    const results = [];

    for (const workspaceId of getWorkspaceIds()) {
      const config = getConfig(workspaceId);
      if (!config.enabled) continue;

      const local =
        getZonedDateParts(
          now,
          config.timezone
        );

      const isPastCutoff =
        local.hour >
          config.assignmentHour ||
        (
          local.hour ===
            config.assignmentHour &&
          local.minute >=
            config.assignmentMinute
        );

      if (!isPastCutoff) {
        continue;
      }

      const dateKey =
        getDateKey(
          now,
          config.timezone
        );

      const existing =
        findTodayRun(
          store.read(),
          workspaceId,
          dateKey
        );

      if (
        existing &&
        FINISHED_RUN_STATUSES.has(
          normalizeStatus(
            existing.status
          )
        ) &&
        Number(
          existing.assignedCount ||
          0
        ) > 0
      ) {
        continue;
      }

      try {
        results.push(
          await runWorkspace({
            workspaceId,
            source,
            force: false,
          })
        );
      } catch (error) {
        results.push({
          ok: false,
          workspaceId,
          error:
            error?.message ||
            String(error),
        });
      }
    }

    return {
      ok:
        results.every(
          (item) =>
            item.ok !== false
        ),
      results,
      completedAt:
        new Date().toISOString(),
    };
  }

  async function runForUser(
    user,
    input = {}
  ) {
    const context =
      getContext(user);

    requireManager(context);

    return runWorkspace({
      workspaceId:
        context.workspaceId,

      requestedBy:
        user.id,

      source:
        input.source ||
        "manual",

      force:
        input.force === true,
    });
  }

  async function runAllWorkspaces({
    source =
      "scheduler",

    force =
      false,
  } = {}) {
    const state =
      store.read();

    const workspaceIds =
      new Set();

    for (
      const workspace
      of state.workspaces ||
      []
    ) {
      if (
        workspace?.id &&
        workspace.active !== false &&
        workspace.isActive !== false &&
        workspace.status !==
          "inactive"
      ) {
        workspaceIds.add(
          workspace.id
        );
      }
    }

    for (
      const user
      of state.users ||
      []
    ) {
      if (
        user?.workspaceId
      ) {
        workspaceIds.add(
          user.workspaceId
        );
      }
    }

    const results = [];

    for (
      const workspaceId
      of workspaceIds
    ) {
      const config =
        getConfig(
          workspaceId
        );

      if (!config.enabled) {
        continue;
      }

      try {
        results.push(
          await runWorkspace({
            workspaceId,
            source,
            force,
          })
        );
      } catch (error) {
        results.push({
          ok: false,
          workspaceId,
          error:
            error?.message ||
            String(error),
        });
      }
    }

    return {
      ok:
        results.every(
          (result) =>
            result.ok !== false
        ),

      results,

      completedAt:
        new Date().toISOString(),
    };
  }

  async function runWorkspace({
    workspaceId,
    requestedBy = "",
    source = "automatic",
    force = false,
  }) {
    if (!workspaceId) {
      throw httpError(
        400,
        "workspaceId is required."
      );
    }

    if (
      workspaceLocks.has(
        workspaceId
      )
    ) {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        reason:
          "An allocation run is already active for this workspace.",
      };
    }

    const execution =
      executeWorkspaceRun({
        workspaceId,
        requestedBy,
        source,
        force,
      }).finally(
        () => {
          workspaceLocks.delete(
            workspaceId
          );
        }
      );

    workspaceLocks.set(
      workspaceId,
      execution
    );

    return execution;
  }

  function startScheduler() {
    if (stopped) {
      stopped = false;
    }

    scheduleNextRun();

    if (startupTimer) {
      clearTimeout(startupTimer);
    }

    startupTimer =
      setTimeout(
        async () => {
          try {
            const result =
              await runDueWorkspaces({
                source:
                  "startup-catch-up",
              });

            console.log(
              `[daily-leads] completed ${JSON.stringify({
                at:
                  new Date().toISOString(),
                source:
                  "startup-catch-up",
                result,
              })}`
            );
          } catch (error) {
            console.error(
              `[daily-leads] startup failed ${JSON.stringify({
                at:
                  new Date().toISOString(),
                message:
                  error?.message ||
                  String(error),
                stack:
                  error?.stack ||
                  "",
              })}`
            );
          } finally {
            scheduleNextRun();
          }
        },
        DEFAULT_STARTUP_DELAY_MS
      );

    startupTimer.unref?.();

    return {
      stop,
    };
  }

  function stop() {
    stopped = true;

    if (schedulerTimer) {
      clearTimeout(
        schedulerTimer
      );

      schedulerTimer = null;
    }

    if (startupTimer) {
      clearTimeout(
        startupTimer
      );

      startupTimer = null;
    }
  }

  /* ------------------------------------------------------------------------
     Workspace execution
     ------------------------------------------------------------------------ */

  async function executeWorkspaceRun({
    workspaceId,
    requestedBy,
    source,
    force,
  }) {
    const startedAt =
      new Date().toISOString();

    const config =
      getConfig(
        workspaceId
      );

    if (
      !config.enabled &&
      !force
    ) {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        reason:
          "Daily lead automation is disabled.",
      };
    }

    const dateKey =
      getBusinessDateKey(
        new Date(),
        config
      );

    recoverStaleRuns({
      workspaceId,
      dateKey,
      staleRunMinutes:
        config.staleRunMinutes,
    });

    const currentState =
      store.read();

    const previousRun =
      findTodayRun(
        currentState,
        workspaceId,
        dateKey
      );

    if (
      previousRun &&
      FINISHED_RUN_STATUSES.has(
        normalizeStatus(
          previousRun.status
        )
      ) &&
      Number(
        previousRun.assignedCount ||
        0
      ) > 0 &&
      !force
    ) {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        run:
          previousRun,
        reason:
          "Today's automatic allocation has already completed.",
      };
    }

    if (
      previousRun &&
      normalizeStatus(
        previousRun.status
      ) === "running" &&
      !force
    ) {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        run:
          previousRun,
        reason:
          "Today's allocation is currently running.",
      };
    }

    const callers =
      getActiveCallers(
        currentState,
        workspaceId
      );

    if (!callers.length) {
      throw httpError(
        422,
        "No active callers were found in this workspace."
      );
    }

    // At the configured manager cutoff, close the previous reporting window.
    // Missing submissions are recorded, but useful leads are still eligible to
    // roll forward into the new 100-lead queue.
    finalizePreviousDaySubmissions({
      workspaceId,
      dateKey,
      callers,
      config,
    });

    const targetCount =
      callers.length *
      config.leadsPerCaller;

    const run =
      createRunRecord({
        workspaceId,
        dateKey,
        source,
        requestedBy,
        callerCount:
          callers.length,
        leadsPerCaller:
          config.leadsPerCaller,
        targetCount,
        startedAt,
      });

    try {
      const reusable =
        collectReusableLeads({
          state:
            store.read(),
          workspaceId,
          dateKey,
          config,
        });

      const available = [
        ...reusable.items,
      ];

      const workload =
        countCurrentAssignmentsByCaller({
          state:
            store.read(),
          workspaceId,
          dateKey,
          callers,
        });

      const assignedByCaller = {};
      const assignedLeadRefs = [];
      let assignedCount = 0;
      let generatedCount = 0;

      for (
        let callerIndex = 0;
        callerIndex < callers.length;
        callerIndex += 1
      ) {
        const caller =
          callers[callerIndex];

        const plan =
          resolveCallerPlan(
            config,
            caller,
            callerIndex
          );

        const current =
          workload.get(
            caller.id
          ) ||
          0;

        const required =
          Math.max(
            0,
            config.leadsPerCaller -
              current
          );

        assignedByCaller[
          caller.id
        ] = 0;

        if (!required) {
          continue;
        }

        const reusableForCaller =
          takeCandidatesForCaller({
            available,
            caller,
            plan,
            limit: required,
          });

        let callerCandidates = [
          ...reusableForCaller,
        ];

        const missing =
          required -
          callerCandidates.length;

        if (
          missing > 0 &&
          generatedCount <
            config.maxGenerationPerRun
        ) {
          const allowed =
            Math.min(
              missing,
              config.maxGenerationPerRun -
                generatedCount
            );

          const generated =
            await generateRealLeads({
              workspaceId,
              requestedBy,
              config,
              requested: allowed,
              existingKeys:
                reusable.usedKeys,
              runId:
                run.id,
              nichesOverride:
                plan.niche
                  ? [plan.niche]
                  : config.niches,
              locationsOverride:
                plan.location
                  ? [plan.location]
                  : config.locations,
              regionCodeOverride:
                plan.regionCode ||
                config.regionCode,
              resourceType:
                plan.resourceType,
              country:
                plan.country,
            });

          generatedCount +=
            generated.length;

          callerCandidates = [
            ...callerCandidates,
            ...generated,
          ];
        }

        const callerResult =
          assignLeadsToCaller({
            workspaceId,
            dateKey,
            caller,
            candidates:
              callerCandidates,
            required,
            requestedBy,
            source,
            runId:
              run.id,
            plan,
          });

        assignedCount +=
          callerResult.assignedCount;

        assignedByCaller[
          caller.id
        ] +=
          callerResult.assignedCount;

        assignedLeadRefs.push(
          ...callerResult.assignedLeadRefs
        );
      }

      let auditQueuedCount = 0;

      if (
        config.autoMiniAudit &&
        assignedLeadRefs.length
      ) {
        auditQueuedCount =
          queueMiniAudits(
            assignedLeadRefs
          );
      }

      const shortfall =
        Math.max(
          0,
          targetCount -
            callers.reduce(
              (total, caller) =>
                total +
                (
                  workload.get(
                    caller.id
                  ) ||
                  0
                ),
              0
            ) -
            assignedCount
        );

      const finalStatus =
        shortfall > 0
          ? "completed_partial"
          : "completed";

      const completedRun =
        updateRunRecord(
          run.id,
          {
            status:
              finalStatus,
            recycledCount:
              reusable.recycledCount,
            reusedCount:
              reusable.reusedCount,
            generatedCount,
            assignedCount,
            auditQueuedCount,
            shortfall,
            assignedByCaller,
            callerPlans:
              Object.fromEntries(
                callers.map(
                  (caller, index) => [
                    caller.id,
                    resolveCallerPlan(
                      config,
                      caller,
                      index
                    ),
                  ]
                )
              ),
            completedAt:
              new Date().toISOString(),
            updatedAt:
              new Date().toISOString(),
          }
        );

      emitWorkspaceEvent(
        workspaceId,
        "daily-leads:completed",
        {
          run:
            completedRun,
          dateKey,
        }
      );

      console.log(
        `[daily-leads] workspace completed ${JSON.stringify({
          at:
            new Date().toISOString(),
          workspaceId,
          dateKey,
          callerCount:
            callers.length,
          leadsPerCaller:
            config.leadsPerCaller,
          reusedCount:
            reusable.reusedCount,
          recycledCount:
            reusable.recycledCount,
          generatedCount,
          assignedCount,
          shortfall,
          status:
            finalStatus,
        })}`
      );

      return {
        ok: true,
        workspaceId,
        run:
          completedRun,
      };
    } catch (error) {
      const failedRun =
        updateRunRecord(
          run.id,
          {
            status:
              "failed",
            errors: [
              error?.message ||
                String(error),
            ],
            completedAt:
              new Date().toISOString(),
            updatedAt:
              new Date().toISOString(),
          }
        );

      emitWorkspaceEvent(
        workspaceId,
        "daily-leads:failed",
        {
          run:
            failedRun,
          error:
            error?.message ||
            String(error),
        }
      );

      throw error;
    }
  }

  /* ------------------------------------------------------------------------
     Run records
     ------------------------------------------------------------------------ */

  function createRunRecord({
    workspaceId,
    dateKey,
    source,
    requestedBy,
    callerCount,
    leadsPerCaller,
    targetCount,
    startedAt,
  }) {
    const run = {
      id:
        crypto.randomUUID(),

      workspaceId,
      dateKey,
      source,
      requestedBy,

      status:
        "running",

      callerCount,
      leadsPerCaller,
      targetCount,

      recycledCount: 0,
      reusedCount: 0,
      generatedCount: 0,
      assignedCount: 0,
      auditQueuedCount: 0,
      shortfall:
        targetCount,

      assignedByCaller:
        {},

      errors: [],

      startedAt,

      completedAt: "",

      createdAt:
        startedAt,

      updatedAt:
        startedAt,
    };

    store.update(
      (draft) => {
        ensureState(
          draft
        );

        const previous =
          draft.dailyLeadRuns.find(
            (item) =>
              item.workspaceId ===
                workspaceId &&
              item.dateKey ===
                dateKey
          );

        if (previous) {
          Object.assign(
            previous,
            run,
            {
              id:
                previous.id ||
                run.id,

              createdAt:
                previous.createdAt ||
                run.createdAt,
            }
          );
        } else {
          draft.dailyLeadRuns.unshift(
            run
          );
        }
      }
    );

    return (
      findRunById(
        run.id
      ) ||
      findTodayRun(
        store.read(),
        workspaceId,
        dateKey
      )
    );
  }

  function updateRunRecord(
    runId,
    updates
  ) {
    let updated =
      null;

    store.update(
      (draft) => {
        ensureState(
          draft
        );

        const run =
          draft.dailyLeadRuns.find(
            (item) =>
              item.id ===
              runId
          );

        if (!run) {
          return;
        }

        Object.assign(
          run,
          updates
        );

        updated = {
          ...run,
        };
      }
    );

    return (
      updated ||
      findRunById(
        runId
      )
    );
  }

  function findRunById(
    runId
  ) {
    return (
      store
        .read()
        .dailyLeadRuns
        ?.find(
          (run) =>
            run.id ===
            runId
        ) ||
      null
    );
  }

  function recoverStaleRuns({
    workspaceId,
    dateKey,
    staleRunMinutes,
  }) {
    const now =
      Date.now();

    const staleAfterMs =
      staleRunMinutes *
      60 *
      1000;

    store.update(
      (draft) => {
        ensureState(
          draft
        );

        for (
          const run
          of draft.dailyLeadRuns
        ) {
          if (
            run.workspaceId !==
              workspaceId ||
            run.dateKey !==
              dateKey ||
            normalizeStatus(
              run.status
            ) !== "running"
          ) {
            continue;
          }

          const started =
            Date.parse(
              run.startedAt ||
                run.updatedAt ||
                run.createdAt ||
                0
            );

          const stale =
            !Number.isFinite(
              started
            ) ||
            now - started >=
              staleAfterMs;

          const emptyRun =
            Number(
              run.assignedCount ||
                0
            ) === 0 &&
            Number(
              run.generatedCount ||
                0
            ) === 0;

          if (
            stale ||
            emptyRun
          ) {
            run.status =
              "failed";

            run.errors =
              Array.isArray(
                run.errors
              )
                ? run.errors
                : [];

            run.errors.push(
              "Recovered an incomplete daily lead run after backend restart."
            );

            run.completedAt =
              new Date()
                .toISOString();

            run.updatedAt =
              run.completedAt;
          }
        }
      }
    );
  }

  /* ------------------------------------------------------------------------
     Existing lead collection
     ------------------------------------------------------------------------ */

  function collectReusableLeads({
    state,
    workspaceId,
    dateKey,
    config,
  }) {
    const items = [];
    const usedKeys =
      new Set();

    let reusedCount =
      0;

    let recycledCount =
      0;

    const activeAssignmentLeadIds =
      new Set(
        getAssignments(
          state
        )
          .filter(
            (assignment) =>
              assignment.workspaceId ===
                workspaceId &&
              isActiveAssignment(
                assignment
              )
          )
          .map(
            (assignment) =>
              String(
                assignment.leadId ||
                  ""
              )
          )
          .filter(
            Boolean
          )
      );

    const cutoff =
      Date.now() -
      config.recycleAfterHours *
        60 *
        60 *
        1000;

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

      if (
        isSyntheticCampaign(
          campaign
        )
      ) {
        continue;
      }

      for (
        const lead
        of campaign.leads ||
        []
      ) {
        if (
          !lead?.id ||
          !isRealLead(
            lead,
            campaign
          )
        ) {
          continue;
        }

        const key =
          leadUniqueKey(
            lead
          );

        if (
          !key ||
          usedKeys.has(
            key
          )
        ) {
          continue;
        }

        if (
          isTerminalLead(
            lead
          )
        ) {
          continue;
        }

        const attempts =
          getCallAttempts(
            lead
          );

        if (
          attempts >=
          config.maxCallAttempts
        ) {
          continue;
        }

        const assignedTo =
          String(
            lead.assignedTo ||
              lead.assigneeId ||
              ""
          );

        const hasActiveAssignment =
          activeAssignmentLeadIds.has(
            String(
              lead.id
            )
          );

        if (
          !assignedTo &&
          !hasActiveAssignment
        ) {
          usedKeys.add(
            key
          );

          items.push({
            campaignId:
              campaign.id,

            campaignName:
              campaign.name ||
              "",

            leadId:
              lead.id,

            lead,

            source:
              "existing-unassigned",

            niche:
              campaign.niche ||
              lead.niche ||
              lead.category ||
              "",

            location:
              campaign.location ||
              lead.dailyLocation ||
              lead.location ||
              lead.address ||
              "",

            resourceType:
              normalizeResourceType(
                lead.dailyResourceType ||
                  campaign.resourceType ||
                  inferResourceTypeFromLocation(
                    campaign.location ||
                      lead.location ||
                      lead.address ||
                      "",
                    campaign.regionCode ||
                      lead.dailyRegionCode ||
                      lead.regionCode ||
                      ""
                  )
              ),

            country:
              lead.dailyCountry ||
              campaign.country ||
              lead.country ||
              "",

            regionCode:
              String(
                lead.dailyRegionCode ||
                  campaign.regionCode ||
                  lead.regionCode ||
                  ""
              )
                .trim()
                .toUpperCase(),

            previousAssigneeId:
              assignedTo ||
              "",

            priority:
              calculateLeadPriority(
                lead
              ),
          });

          reusedCount += 1;

          continue;
        }

        const latestAction =
          Date.parse(
            lead.nextActionAt ||
              lead.callbackAt ||
              lead.followUpAt ||
              lead.lastCallAt ||
              lead.assignedAt ||
              lead.updatedAt ||
              lead.createdAt ||
              0
          );

        const due =
          isLeadDue(
            lead,
            dateKey,
            config.timezone
          );

        const oldEnough =
          Number.isFinite(
            latestAction
          ) &&
          latestAction <=
            cutoff;

        const fromPreviousDailyQueue =
          Boolean(
            lead.dailyQueueDate &&
            lead.dailyQueueDate <
              dateKey
          );

        if (
          due ||
          oldEnough ||
          fromPreviousDailyQueue
        ) {
          usedKeys.add(
            key
          );

          items.push({
            campaignId:
              campaign.id,

            campaignName:
              campaign.name ||
              "",

            leadId:
              lead.id,

            lead,

            source:
              due
                ? "due-follow-up"
                : fromPreviousDailyQueue
                  ? "previous-daily-queue"
                  : "recycled",

            niche:
              campaign.niche ||
              lead.dailyNiche ||
              lead.niche ||
              lead.category ||
              "",

            location:
              campaign.location ||
              lead.dailyLocation ||
              lead.location ||
              lead.address ||
              "",

            resourceType:
              normalizeResourceType(
                lead.dailyResourceType ||
                  campaign.resourceType ||
                  inferResourceTypeFromLocation(
                    campaign.location ||
                      lead.dailyLocation ||
                      lead.location ||
                      lead.address ||
                      "",
                    lead.dailyRegionCode ||
                      campaign.regionCode ||
                      lead.regionCode ||
                      ""
                  )
              ),

            country:
              lead.dailyCountry ||
              campaign.country ||
              lead.country ||
              "",

            regionCode:
              String(
                lead.dailyRegionCode ||
                  campaign.regionCode ||
                  lead.regionCode ||
                  ""
              )
                .trim()
                .toUpperCase(),

            previousAssigneeId:
              assignedTo ||
              "",

            priority:
              due
                ? 1000 +
                  calculateLeadPriority(
                    lead
                  )
                : calculateLeadPriority(
                    lead
                  ),
          });

          recycledCount += 1;
        }
      }
    }

    items.sort(
      (
        left,
        right
      ) =>
        right.priority -
        left.priority
    );

    return {
      items,
      usedKeys,
      reusedCount,
      recycledCount,
    };
  }

  function finalizePreviousDaySubmissions({
    workspaceId,
    dateKey,
    callers,
    config,
  }) {
    const previousDateKey =
      addDaysToDateKey(
        dateKey,
        -1
      );

    const now =
      new Date().toISOString();

    store.update(
      (draft) => {
        ensureState(draft);

        for (const caller of callers) {
          const existing =
            getCallerSubmission({
              state: draft,
              workspaceId,
              callerId:
                caller.id,
              dateKey:
                previousDateKey,
            });

          if (existing) {
            continue;
          }

          const stats =
            getCallerDayStats({
              state: draft,
              workspaceId,
              callerId:
                caller.id,
              dateKey:
                previousDateKey,
            });

          if (!stats.assigned) {
            continue;
          }

          draft.dailyCallerSubmissions.unshift({
            id:
              crypto.randomUUID(),
            workspaceId,
            callerId:
              caller.id,
            callerName:
              caller.name ||
              caller.fullName ||
              caller.email ||
              "Caller",
            dateKey:
              previousDateKey,
            status:
              "missed_deadline",
            assigned:
              stats.assigned,
            worked:
              stats.worked,
            closed:
              stats.closed,
            remaining:
              stats.remaining,
            submittedAt:
              "",
            deadlineAt:
              zonedDateTimeToUtc({
                dateKey,
                hour:
                  config.assignmentHour,
                minute:
                  config.assignmentMinute,
                timeZone:
                  config.timezone,
              }).toISOString(),
            createdAt:
              now,
            updatedAt:
              now,
          });
        }
      }
    );
  }

  /* ------------------------------------------------------------------------
     Google Places generation
     ------------------------------------------------------------------------ */

  async function generateRealLeads({
    workspaceId,
    requestedBy,
    config,
    requested,
    existingKeys,
    runId,
    nichesOverride = null,
    locationsOverride = null,
    regionCodeOverride = "",
    resourceType = "international",
    country = "",
  }) {
    const niches =
      normalizeStringArray(
        nichesOverride ||
        config.niches
      );

    const locations =
      normalizeStringArray(
        locationsOverride ||
        config.locations
      );

    if (
      !niches.length ||
      !locations.length
    ) {
      throw httpError(
        422,
        "Configure at least one niche and one location before running daily lead automation."
      );
    }

    const generated = [];
    let combinationIndex = 0;
    let remaining =
      Math.min(
        requested,
        config.maxGenerationPerRun
      );

    while (
      remaining > 0 &&
      generated.length <
        config.maxGenerationPerRun
    ) {
      const niche =
        niches[
          combinationIndex %
            niches.length
        ];

      const location =
        locations[
          Math.floor(
            combinationIndex /
              niches.length
          ) %
            locations.length
        ];

      const batchSize =
        Math.min(
          remaining,
          config.generationBatchSize,
          1000
        );

      const result =
        await leadFinder.findLeads({
          runId:
            `${runId}-${combinationIndex + 1}`,
          niche,
          location,
          limit:
            batchSize,
          radiusKm:
            config.radiusKm,
          qualityLevel:
            config.qualityLevel,
          regionCode:
            String(
              regionCodeOverride ||
                config.regionCode ||
                ""
            )
              .trim()
              .toUpperCase(),
          exact: false,
        });

      const leads =
        Array.isArray(
          result?.leads
        )
          ? result.leads
          : [];

      const inserted =
        insertGeneratedCampaign({
          workspaceId,
          requestedBy,
          niche,
          location,
          leads,
          existingKeys,
          runId,
          resourceType,
          country,
          regionCode:
            String(
              regionCodeOverride ||
                config.regionCode ||
                ""
            )
              .trim()
              .toUpperCase(),
        });

      generated.push(
        ...inserted
      );

      remaining =
        Math.max(
          0,
          requested -
            generated.length
        );

      combinationIndex += 1;

      const totalCombinations =
        niches.length *
        locations.length;

      if (
        combinationIndex >=
          totalCombinations &&
        inserted.length === 0
      ) {
        break;
      }

      if (
        combinationIndex >=
        totalCombinations * 3
      ) {
        break;
      }
    }

    return generated.slice(
      0,
      requested
    );
  }

  function insertGeneratedCampaign({
    workspaceId,
    requestedBy,
    niche,
    location,
    leads,
    existingKeys,
    runId,
    resourceType = "international",
    country = "",
    regionCode = "",
  }) {
    const now =
      new Date().toISOString();

    const accepted = [];

    for (
      const candidate
      of leads
    ) {
      if (
        !candidate ||
        !isUsableGeneratedLead(
          candidate
        )
      ) {
        continue;
      }

      const normalizedLead =
        normalizeGeneratedLead(
          candidate,
          now
        );

      const key =
        leadUniqueKey(
          normalizedLead
        );

      if (
        !key ||
        existingKeys.has(
          key
        )
      ) {
        continue;
      }

      existingKeys.add(
        key
      );

      normalizedLead.dailyResourceType =
        normalizeResourceType(
          resourceType
        );
      normalizedLead.dailyCountry =
        cleanMarketValue(
          country ||
            (normalizeResourceType(
              resourceType
            ) === "local"
              ? "Pakistan"
              : "")
        );
      normalizedLead.dailyRegionCode =
        String(
          regionCode ||
            (normalizeResourceType(
              resourceType
            ) === "local"
              ? "PK"
              : "")
        )
          .trim()
          .toUpperCase();

      accepted.push(
        normalizedLead
      );
    }

    if (!accepted.length) {
      return [];
    }

    const campaignId =
      crypto.randomUUID();

    const campaign = {
      id:
        campaignId,

      workspaceId,

      userId:
        requestedBy ||
        "",

      ownerId:
        requestedBy ||
        "",

      createdBy:
        requestedBy ||
        "",

      name:
        `Daily Google leads · ${niche} · ${location}`,

      niche,
      location,
      resourceType:
        normalizeResourceType(
          resourceType
        ),
      country:
        cleanMarketValue(
          country ||
            (normalizeResourceType(
              resourceType
            ) === "local"
              ? "Pakistan"
              : "")
        ),
      regionCode:
        String(
          regionCode ||
            (normalizeResourceType(
              resourceType
            ) === "local"
              ? "PK"
              : "")
        )
          .trim()
          .toUpperCase(),

      source:
        "automatic-google-places",

      provider:
        "google-places",

      automatic:
        true,

      dailyLeadRunId:
        runId,

      status:
        "active",

      pipelineStatus:
        "ready",

      leadCount:
        accepted.length,

      leads:
        accepted,

      createdAt:
        now,

      updatedAt:
        now,
    };

    store.update(
      (draft) => {
        ensureState(
          draft
        );

        draft.campaigns.push(
          campaign
        );
      }
    );

    return accepted.map(
      (lead) => ({
        campaignId,
        campaignName:
          campaign.name,
        leadId:
          lead.id,
        lead,
        source:
          "generated-google-places",
        niche,
        location,
        resourceType:
          campaign.resourceType,
        country:
          campaign.country,
        regionCode:
          campaign.regionCode,
        previousAssigneeId:
          "",
        priority:
          calculateLeadPriority(
            lead
          ),
      })
    );
  }

  /* ------------------------------------------------------------------------
     Assignment
     ------------------------------------------------------------------------ */

  function assignLeadsToCaller({
    workspaceId,
    dateKey,
    caller,
    candidates,
    required,
    requestedBy,
    source,
    runId,
    plan,
  }) {
    const assignedLeadRefs = [];
    let assignedCount = 0;

    for (
      const candidate
      of candidates
    ) {
      if (
        assignedCount >=
        required
      ) {
        break;
      }

      const assigned =
        assignSingleLead({
          workspaceId,
          dateKey,
          caller,
          candidate,
          requestedBy,
          source,
          runId,
          plan,
        });

      if (!assigned) {
        continue;
      }

      assignedCount += 1;

      assignedLeadRefs.push({
        ...candidate,
        assignedTo:
          caller.id,
        niche:
          plan.niche ||
          candidate.niche ||
          "",
        location:
          plan.location ||
          candidate.location ||
          "",
        resourceType:
          plan.resourceType ||
          candidate.resourceType ||
          "international",
        country:
          plan.country ||
          candidate.country ||
          "",
        regionCode:
          plan.regionCode ||
          candidate.regionCode ||
          "",
      });
    }

    return {
      assignedCount,
      shortfall:
        Math.max(
          0,
          required -
            assignedCount
        ),
      assignedLeadRefs,
    };
  }

  function assignSingleLead({
    workspaceId,
    dateKey,
    caller,
    candidate,
    requestedBy,
    source,
    runId,
    plan = {},
  }) {
    const now =
      new Date().toISOString();

    let created =
      false;

    store.update(
      (draft) => {
        ensureState(
          draft
        );

        const campaign =
          draft.campaigns.find(
            (item) =>
              item.id ===
              candidate.campaignId
          );

        const lead =
          campaign?.leads?.find(
            (item) =>
              item.id ===
              candidate.leadId
          );

        if (
          !campaign ||
          !lead
        ) {
          return;
        }

        if (
          isTerminalLead(
            lead
          )
        ) {
          return;
        }

        const duplicate =
          draft.salesAssignments.some(
            (assignment) =>
              assignment.workspaceId ===
                workspaceId &&
              assignment.leadId ===
                lead.id &&
              assignment.assignedTo ===
                caller.id &&
              assignment.assignmentDate ===
                dateKey &&
              isActiveAssignment(
                assignment
              )
          );

        if (duplicate) {
          return;
        }

        for (
          const assignment
          of draft.salesAssignments
        ) {
          if (
            assignment.workspaceId ===
              workspaceId &&
            assignment.leadId ===
              lead.id &&
            isActiveAssignment(
              assignment
            )
          ) {
            assignment.status =
              "reassigned";

            assignment.queueStatus =
              "removed";

            assignment.completedAt =
              now;

            assignment.updatedAt =
              now;
          }
        }

        const assignmentId =
          crypto.randomUUID();

        lead.assignedTo =
          caller.id;

        lead.assigneeId =
          caller.id;

        lead.assignedToName =
          caller.name ||
          caller.fullName ||
          caller.email ||
          "Caller";

        lead.assignedBy =
          requestedBy ||
          "system";

        lead.assignedAt =
          now;

        lead.assignmentDate =
          dateKey;

        lead.dailyQueueDate =
          dateKey;

        lead.dailyLeadRunId =
          runId;

        lead.dailyNiche =
          plan.niche ||
          candidate.niche ||
          campaign.niche ||
          lead.niche ||
          lead.category ||
          "";

        lead.dailyLocation =
          plan.location ||
          candidate.location ||
          campaign.location ||
          lead.location ||
          "";

        lead.dailyResourceType =
          normalizeResourceType(
            plan.resourceType ||
              candidate.resourceType ||
              campaign.resourceType ||
              "international"
          );

        lead.dailyCountry =
          cleanMarketValue(
            plan.country ||
              candidate.country ||
              campaign.country ||
              (lead.dailyResourceType ===
              "local"
                ? "Pakistan"
                : "")
          );

        lead.dailyRegionCode =
          String(
            plan.regionCode ||
              candidate.regionCode ||
              campaign.regionCode ||
              (lead.dailyResourceType ===
              "local"
                ? "PK"
                : "")
          )
            .trim()
            .toUpperCase();

        lead.queueStatus =
          "current";

        if (
          !lead.status ||
          normalizeStatus(
            lead.status
          ) === "new"
        ) {
          lead.status =
            "assigned";
        }

        lead.updatedAt =
          now;

        lead.timeline =
          Array.isArray(
            lead.timeline
          )
            ? lead.timeline
            : [];

        lead.timeline.unshift({
          id:
            crypto.randomUUID(),

          type:
            "daily_assignment",

          actorId:
            requestedBy ||
            "system",

          assignedTo:
            caller.id,

          assignmentDate:
            dateKey,

          runId,

          niche:
            lead.dailyNiche ||
            "",

          location:
            lead.dailyLocation ||
            "",

          resourceType:
            lead.dailyResourceType ||
            "international",

          country:
            lead.dailyCountry ||
            "",

          regionCode:
            lead.dailyRegionCode ||
            "",

          createdAt:
            now,
        });

        draft.salesAssignments.unshift({
          id:
            assignmentId,

          workspaceId,

          campaignId:
            campaign.id,

          campaignName:
            campaign.name ||
            "",

          leadId:
            lead.id,

          userId:
            caller.id,

          assignedTo:
            caller.id,

          assigneeId:
            caller.id,

          assignedToName:
            lead.assignedToName,

          assignedBy:
            requestedBy ||
            "system",

          assignmentDate:
            dateKey,

          dailyQueueDate:
            dateKey,

          dailyLeadRunId:
            runId,

          niche:
            lead.dailyNiche ||
            "",

          location:
            lead.dailyLocation ||
            "",

          resourceType:
            lead.dailyResourceType ||
            "international",

          country:
            lead.dailyCountry ||
            "",

          regionCode:
            lead.dailyRegionCode ||
            "",

          status:
            "assigned",

          queueStatus:
            "current",

          priority:
            normalizePriority(
              lead.priority
            ),

          source:
            source ||
            candidate.source ||
            "daily-automation",

          nextActionAt:
            lead.nextActionAt ||
            now,

          createdAt:
            now,

          updatedAt:
            now,
        });

        draft.teamTasks.unshift({
          id:
            crypto.randomUUID(),

          workspaceId,

          campaignId:
            campaign.id,

          campaignName:
            campaign.name ||
            "",

          leadId:
            lead.id,

          assignmentId,

          dailyLeadRunId:
            runId,

          title:
            `Call ${
              lead.business ||
              lead.name ||
              "assigned lead"
            }`,

          description:
            "Review the mini audit, contact the lead, record the outcome, and schedule a follow-up when required.",

          type:
            "lead_call",

          status:
            "pending",

          queueStatus:
            "current",

          priority:
            normalizePriority(
              lead.priority
            ),

          assignedTo:
            caller.id,

          assignedToUserId:
            caller.id,

          createdBy:
            requestedBy ||
            "system",

          assignmentDate:
            dateKey,

          niche:
            lead.dailyNiche ||
            "",

          location:
            lead.dailyLocation ||
            "",

          resourceType:
            lead.dailyResourceType ||
            "international",

          country:
            lead.dailyCountry ||
            "",

          regionCode:
            lead.dailyRegionCode ||
            "",

          dueAt:
            lead.nextActionAt ||
            now,

          completedAt:
            "",

          source:
            "daily-automation",

          createdAt:
            now,

          updatedAt:
            now,
        });

        created =
          true;
      }
    );

    return created;
  }

  /* ------------------------------------------------------------------------
     Mini audits
     ------------------------------------------------------------------------ */

  function queueMiniAudits(
    assignedLeadRefs
  ) {
    if (
      !leadAuditService
    ) {
      return 0;
    }

    let queued =
      0;

    for (
      const reference
      of assignedLeadRefs
    ) {
      try {
        if (
          typeof leadAuditService
            .queueMiniAudit !==
          "function"
        ) {
          break;
        }

        const systemUser =
          resolveSystemUser(
            reference
              .assignedTo
          );

        if (!systemUser) {
          continue;
        }

        leadAuditService.queueMiniAudit(
          systemUser,
          {
            campaignId:
              reference.campaignId,

            leadId:
              reference.leadId,

            website:
              reference.lead
                ?.website ||
              "",

            business:
              reference.lead
                ?.business ||
              reference.lead
                ?.name ||
              "",

            niche:
              reference.niche ||
              reference.lead
                ?.dailyNiche ||
              reference.lead
                ?.category ||
              "",

            location:
              reference.location ||
              reference.lead
                ?.dailyLocation ||
              reference.lead
                ?.address ||
              "",

            resourceType:
              reference.resourceType ||
              reference.lead
                ?.dailyResourceType ||
              "international",

            country:
              reference.country ||
              reference.lead
                ?.dailyCountry ||
              "",

            regionCode:
              reference.regionCode ||
              reference.lead
                ?.dailyRegionCode ||
              "",

            automatic:
              true,

            source:
              "daily-lead-automation",
          }
        );

        queued += 1;
      } catch (error) {
        console.warn(
          `[daily-leads] mini audit queue failed ${JSON.stringify({
            campaignId:
              reference.campaignId,

            leadId:
              reference.leadId,

            message:
              error?.message ||
              String(error),
          })}`
        );
      }
    }

    return queued;
  }

  function resolveSystemUser(
    userId
  ) {
    return (
      store
        .read()
        .users
        ?.find(
          (user) =>
            user.id ===
            userId
        ) ||
      null
    );
  }

  /* ------------------------------------------------------------------------
     Scheduler
     ------------------------------------------------------------------------ */

  function scheduleNextRun() {
    if (stopped) {
      return;
    }

    if (schedulerTimer) {
      clearTimeout(
        schedulerTimer
      );
      schedulerTimer = null;
    }

    const now = new Date();

    const targets =
      getWorkspaceIds()
        .map(
          (workspaceId) => {
            const config =
              getConfig(
                workspaceId
              );

            if (!config.enabled) {
              return null;
            }

            const nextRun =
              getNextScheduledRunDate(
                now,
                config
              );

            return {
              workspaceId,
              config,
              nextRun,
            };
          }
        )
        .filter(Boolean)
        .sort(
          (left, right) =>
            left.nextRun.getTime() -
            right.nextRun.getTime()
        );

    if (!targets.length) {
      // Keep a lightweight watcher alive so a manager can enable automation
      // without requiring a backend restart.
      schedulerTimer =
        setTimeout(
          scheduleNextRun,
          60_000
        );
      schedulerTimer.unref?.();
      return;
    }

    const next = targets[0];
    const delayMs =
      Math.max(
        1000,
        next.nextRun.getTime() -
          now.getTime()
      );

    console.log(
      `[daily-leads] scheduled ${JSON.stringify({
        at:
          now.toISOString(),
        workspaceId:
          next.workspaceId,
        timeZone:
          next.config.timezone,
        hour:
          next.config.assignmentHour,
        minute:
          next.config.assignmentMinute,
        nextRunAt:
          next.nextRun.toISOString(),
        delayMs,
      })}`
    );

    schedulerTimer =
      setTimeout(
        async () => {
          if (schedulerRunning) {
            scheduleNextRun();
            return;
          }

          schedulerRunning = true;

          try {
            const result =
              await runDueWorkspaces({
                source:
                  "manager-scheduled-refresh",
              });

            console.log(
              `[daily-leads] completed ${JSON.stringify({
                at:
                  new Date().toISOString(),
                source:
                  "manager-scheduled-refresh",
                result,
              })}`
            );
          } catch (error) {
            console.error(
              `[daily-leads] scheduled run failed ${JSON.stringify({
                at:
                  new Date().toISOString(),
                message:
                  error?.message ||
                  String(error),
                stack:
                  error?.stack ||
                  "",
              })}`
            );
          } finally {
            schedulerRunning = false;
            scheduleNextRun();
          }
        },
        delayMs
      );

    schedulerTimer.unref?.();
  }

  /* ------------------------------------------------------------------------
     Context and events
     ------------------------------------------------------------------------ */

  function getContext(
    user
  ) {
    return (
      workspaceService
        ?.getContext?.(
          user,
          store.read()
        ) || {
        user,

        workspaceId:
          user?.workspaceId ||
          "",

        role:
          user?.workspaceRole ||
          user?.role ||
          "",

        permissions:
          user?.permissions ||
          [],
      }
    );
  }

  function emitWorkspaceEvent(
    workspaceId,
    eventName,
    payload
  ) {
    try {
      workspaceEmitter?.(
        workspaceId,
        eventName,
        payload
      );
    } catch {
      // Socket updates must not stop allocation.
    }
  }

  return {
    getConfig,
    saveConfig,
    status,
    getStatus: status,
    myDay,
    submitMyDay,
    runForUser,
    runWorkspace,
    runAllWorkspaces,
    runDueWorkspaces,
    startScheduler,
    reschedule: scheduleNextRun,
    stop,
  };
}

/* ==========================================================================
   Assignment helpers
   ========================================================================== */

function getActiveCallers(
  state,
  workspaceId
) {
  const membershipByUser =
    new Map();

  for (
    const membership
    of state.workspaceMembers ||
    []
  ) {
    if (
      membership.workspaceId ===
      workspaceId
    ) {
      membershipByUser.set(
        membership.userId,
        membership
      );
    }
  }

  return (
    state.users ||
    []
  )
    .filter(
      (user) => {
        if (
          user.workspaceId !==
          workspaceId
        ) {
          return false;
        }

        const membership =
          membershipByUser.get(
            user.id
          );

        const role =
          normalizeRole(
            membership?.workspaceRole ||
              membership?.role ||
              user.workspaceRole ||
              user.role
          );

        const active =
          user.active !==
            false &&
          user.isActive !==
            false &&
          membership?.active !==
            false &&
          membership?.isActive !==
            false &&
          membership?.status !==
            "inactive";

        return (
          active &&
          ACTIVE_CALLER_ROLES.has(
            role
          )
        );
      }
    )
    .sort(
      (left, right) =>
        String(
          left.name ||
            left.email ||
            ""
        ).localeCompare(
          String(
            right.name ||
              right.email ||
              ""
          )
        )
    );
}

function countCurrentAssignmentsByCaller({
  state,
  workspaceId,
  dateKey,
  callers,
}) {
  const callerIds =
    new Set(
      callers.map(
        (caller) =>
          caller.id
      )
    );

  const result =
    new Map(
      callers.map(
        (caller) => [
          caller.id,
          0,
        ]
      )
    );

  const seen =
    new Set();

  for (
    const assignment
    of getAssignments(
      state
    )
  ) {
    if (
      assignment.workspaceId !==
      workspaceId
    ) {
      continue;
    }

    const callerId =
      String(
        assignment.assignedTo ||
          assignment.assigneeId ||
          assignment.userId ||
          ""
      );

    if (
      !callerIds.has(
        callerId
      )
    ) {
      continue;
    }

    if (
      !isActiveAssignment(
        assignment
      )
    ) {
      continue;
    }

    const assignmentDate =
      assignment.assignmentDate ||
      assignment.dailyQueueDate ||
      "";

    if (
      assignmentDate &&
      assignmentDate !==
        dateKey
    ) {
      continue;
    }

    const key =
      `${callerId}:${assignment.leadId}`;

    if (
      seen.has(
        key
      )
    ) {
      continue;
    }

    seen.add(
      key
    );

    result.set(
      callerId,
      (
        result.get(
          callerId
        ) ||
        0
      ) + 1
    );
  }

  return result;
}

function getAssignments(
  state
) {
  if (
    Array.isArray(
      state.salesAssignments
    )
  ) {
    return state.salesAssignments;
  }

  if (
    Array.isArray(
      state.leadAssignments
    )
  ) {
    return state.leadAssignments;
  }

  return [];
}

function isActiveAssignment(
  assignment
) {
  const status =
    normalizeStatus(
      assignment?.queueStatus ||
      assignment?.status
    );

  return (
    ACTIVE_ASSIGNMENT_STATUSES.has(
      status
    ) &&
    !assignment?.completedAt
  );
}

/* ==========================================================================
   Lead helpers
   ========================================================================== */

function isRealLead(
  lead,
  campaign
) {
  if (
    lead.synthetic ===
      true ||
    lead.seeded ===
      true ||
    lead.automaticSeed ===
      true
  ) {
    return false;
  }

  if (
    isSyntheticCampaign(
      campaign
    )
  ) {
    return false;
  }

  const source =
    normalizeStatus(
      lead.source ||
      campaign.source
    );

  if (
    [
      "test_seed",
      "synthetic_seed",
      "demo_seed",
      "seed",
    ].includes(
      source
    )
  ) {
    return false;
  }

  return Boolean(
    lead.placeId ||
    lead.googlePlaceId ||
    lead.website ||
    lead.phone ||
    lead.email ||
    lead.address
  );
}

function isSyntheticCampaign(
  campaign
) {
  const source =
    normalizeStatus(
      campaign?.source
    );

  if (
    [
      "test_seed",
      "synthetic_seed",
      "demo_seed",
      "seed",
    ].includes(
      source
    )
  ) {
    return true;
  }

  if (
    campaign?.seeded ===
      true ||
    campaign?.automaticSeed ===
      true
  ) {
    return true;
  }

  const name =
    String(
      campaign?.name ||
        ""
    ).toLowerCase();

  return (
    name.includes(
      "seed business"
    ) ||
    name.includes(
      "daily calling queue ·"
    )
  );
}

function isTerminalLead(
  lead
) {
  if (
    lead?.doNotCall ===
    true
  ) {
    return true;
  }

  const status =
    normalizeStatus(
      lead?.status ||
      lead?.queueStatus
    );

  return TERMINAL_LEAD_STATUSES.has(
    status
  );
}

function isLeadDue(
  lead,
  dateKey,
  timeZone
) {
  const dueValue =
    lead.nextActionAt ||
    lead.callbackAt ||
    lead.followUpAt ||
    lead.nextFollowUpAt ||
    "";

  if (!dueValue) {
    return false;
  }

  const timestamp =
    Date.parse(
      dueValue
    );

  if (
    !Number.isFinite(
      timestamp
    )
  ) {
    return false;
  }

  const dueDateKey =
    getDateKey(
      new Date(
        timestamp
      ),
      timeZone
    );

  return (
    dueDateKey <=
    dateKey
  );
}

function getCallAttempts(
  lead
) {
  const direct =
    Number(
      lead.callAttempts ||
      lead.attempts ||
      0
    );

  if (
    Number.isFinite(
      direct
    ) &&
    direct > 0
  ) {
    return direct;
  }

  if (
    Array.isArray(
      lead.calls
    )
  ) {
    return lead.calls.length;
  }

  if (
    Array.isArray(
      lead.callHistory
    )
  ) {
    return lead.callHistory.length;
  }

  return 0;
}

function calculateLeadPriority(
  lead
) {
  let score =
    Number(
      lead.qualityScore ||
      lead.score ||
      0
    );

  const priority =
    normalizePriority(
      lead.priority
    );

  if (
    priority ===
    "high"
  ) {
    score += 300;
  }

  if (
    priority ===
    "urgent"
  ) {
    score += 500;
  }

  if (
    lead.phone
  ) {
    score += 100;
  }

  if (
    lead.website
  ) {
    score += 50;
  }

  if (
    lead.email
  ) {
    score += 25;
  }

  const status =
    normalizeStatus(
      lead.status
    );

  if (
    [
      "callback",
      "follow_up",
    ].includes(
      status
    )
  ) {
    score += 400;
  }

  return score;
}

function leadUniqueKey(
  lead
) {
  const placeId =
    String(
      lead?.placeId ||
      lead?.googlePlaceId ||
      ""
    )
      .trim()
      .toLowerCase();

  if (placeId) {
    return `place:${placeId}`;
  }

  const website =
    normalizeWebsite(
      lead?.website ||
      lead?.websiteUri
    );

  if (website) {
    return `web:${website}`;
  }

  const phone =
    normalizePhone(
      lead?.phone ||
      lead?.phoneNumber
    );

  if (phone) {
    return `phone:${phone}`;
  }

  const email =
    String(
      lead?.email ||
      ""
    )
      .trim()
      .toLowerCase();

  if (email) {
    return `email:${email}`;
  }

  const name =
    String(
      lead?.business ||
      lead?.name ||
      ""
    )
      .trim()
      .toLowerCase();

  const address =
    String(
      lead?.address ||
      lead?.formattedAddress ||
      ""
    )
      .trim()
      .toLowerCase();

  if (
    name ||
    address
  ) {
    return `name:${name}|${address}`;
  }

  return "";
}

function isUsableGeneratedLead(
  lead
) {
  return Boolean(
    lead?.phone ||
    lead?.phoneNumber ||
    lead?.website ||
    lead?.websiteUri ||
    lead?.email
  );
}

function normalizeGeneratedLead(
  lead,
  now
) {
  const business =
    String(
      lead.business ||
      lead.name ||
      lead.displayName ||
      "Business"
    ).trim();

  return {
    ...lead,

    id:
      lead.id ||
      crypto.randomUUID(),

    business,

    name:
      business,

    placeId:
      lead.placeId ||
      lead.googlePlaceId ||
      "",

    phone:
      lead.phone ||
      lead.phoneNumber ||
      lead.internationalPhoneNumber ||
      lead.nationalPhoneNumber ||
      "",

    website:
      lead.website ||
      lead.websiteUri ||
      "",

    address:
      lead.address ||
      lead.formattedAddress ||
      "",

    source:
      "google-places",

    provider:
      "google-places",

    status:
      "new",

    queueStatus:
      "ready",

    assignedTo:
      "",

    assigneeId:
      "",

    callAttempts:
      Number(
        lead.callAttempts ||
        0
      ),

    timeline:
      Array.isArray(
        lead.timeline
      )
        ? lead.timeline
        : [],

    createdAt:
      lead.createdAt ||
      now,

    updatedAt:
      now,
  };
}

/* ==========================================================================
   State helpers
   ========================================================================== */

function ensureState(
  draft
) {
  const arrays = [
    "users",
    "workspaces",
    "workspaceMembers",
    "campaigns",
    "salesAssignments",
    "leadAssignments",
    "calls",
    "callRecords",
    "teamTasks",
    "dailyLeadRuns",
    "dailyCallerSubmissions",
    "auditReports",
    "leadAuditReports",
    "activity",
  ];

  for (
    const key
    of arrays
  ) {
    if (
      !Array.isArray(
        draft[key]
      )
    ) {
      draft[key] = [];
    }
  }

  if (
    !draft.workspaceSettings ||
    typeof draft.workspaceSettings !==
      "object" ||
    Array.isArray(
      draft.workspaceSettings
    )
  ) {
    draft.workspaceSettings =
      {};
  }
}

function findTodayRun(
  state,
  workspaceId,
  dateKey
) {
  return (
    state.dailyLeadRuns
      ?.filter(
        (run) =>
          run.workspaceId ===
            workspaceId &&
          run.dateKey ===
            dateKey
      )
      .sort(
        (left, right) =>
          Date.parse(
            right.createdAt ||
              0
          ) -
          Date.parse(
            left.createdAt ||
              0
          )
      )[0] ||
    null
  );
}

function resolveCallerPlan(
  config,
  caller,
  index = 0
) {
  const stored =
    config.callerPlans?.[
      caller?.id
    ] ||
    {};

  const fallbackNiche =
    config.niches.length
      ? config.niches[
          index %
            config.niches.length
        ]
      : "";

  const fallbackLocation =
    config.locations.length
      ? config.locations[
          index %
            config.locations.length
        ]
      : "";

  const resourceType =
    normalizeResourceType(
      stored.resourceType ||
        "international"
    );

  const localLocations =
    config.localPakistanLocations?.length
      ? config.localPakistanLocations
      : DEFAULT_LOCAL_PAKISTAN_LOCATIONS;

  const automaticPakistanLocation =
    localLocations.length
      ? localLocations[
          index % localLocations.length
        ]
      : "Pakistan";

  const location =
    resourceType === "local"
      ? String(
          stored.location ||
            automaticPakistanLocation ||
            "Pakistan"
        ).trim()
      : String(
          stored.location ||
            fallbackLocation ||
            ""
        ).trim();

  return {
    niche:
      String(
        stored.niche ||
        fallbackNiche ||
        ""
      ).trim(),
    resourceType,
    location,
    country:
      resourceType === "local"
        ? "Pakistan"
        : cleanMarketValue(
            stored.country ||
              ""
          ),
    regionCode:
      resourceType === "local"
        ? "PK"
        : String(
            stored.regionCode ||
              config.regionCode ||
              "US"
          )
            .trim()
            .toUpperCase(),
  };
}

function normalizeCallerPlans(
  value
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  const result = {};

  for (
    const [callerId, plan]
    of Object.entries(value)
  ) {
    const id =
      String(
        callerId ||
        ""
      ).trim();

    if (!id) continue;

    result[id] = {
      niche:
        String(
          plan?.niche ||
          ""
        ).trim(),
      resourceType:
        normalizeResourceType(
          plan?.resourceType ||
            "international"
        ),
      location:
        String(
          plan?.location ||
          ""
        ).trim(),
      country:
        cleanMarketValue(
          plan?.country ||
            ""
        ),
      regionCode:
        String(
          plan?.regionCode ||
            ""
        )
          .trim()
          .toUpperCase(),
    };
  }

  return result;
}

function normalizeResourceType(
  value
) {
  const normalized =
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "_");

  return [
    "local",
    "pakistan",
    "pk",
    "domestic",
  ].includes(normalized)
    ? "local"
    : "international";
}

function cleanMarketValue(
  value
) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferResourceTypeFromLocation(
  location,
  regionCode = ""
) {
  const region =
    String(regionCode || "")
      .trim()
      .toUpperCase();

  if (region === "PK") {
    return "local";
  }

  const text =
    String(location || "")
      .toLowerCase();

  const pakistanMarkers = [
    "pakistan",
    "karachi",
    "lahore",
    "islamabad",
    "rawalpindi",
    "faisalabad",
    "multan",
    "peshawar",
    "sialkot",
    "gujranwala",
    "quetta",
    "hyderabad, sindh",
  ];

  return pakistanMarkers.some(
    (marker) =>
      text.includes(marker)
  )
    ? "local"
    : "international";
}

function resourceTypeMatches(
  candidate = {},
  plan = {}
) {
  const requested =
    normalizeResourceType(
      plan.resourceType ||
        "international"
    );

  const actual =
    normalizeResourceType(
      candidate.resourceType ||
        inferResourceTypeFromLocation(
          candidate.location ||
            candidate.lead?.dailyLocation ||
            candidate.lead?.address ||
            "",
          candidate.regionCode ||
            candidate.lead?.dailyRegionCode ||
            candidate.lead?.regionCode ||
            ""
        )
    );

  return requested === actual;
}

function normalizeNicheKey(
  value
) {
  return String(
    value ||
    ""
  )
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b(services?|business|company|companies)\b/g, " ")
    .replace(/\s+/g, " ")
    .replace(/s\b/g, "")
    .trim();
}

function nicheMatches(
  candidate,
  requested
) {
  const left =
    normalizeNicheKey(candidate);
  const right =
    normalizeNicheKey(requested);

  if (!right) return true;
  if (!left) return false;

  return (
    left === right ||
    left.includes(right) ||
    right.includes(left)
  );
}

function takeCandidatesForCaller({
  available,
  caller,
  plan,
  limit,
}) {
  const ranked = [];

  for (
    let index = 0;
    index < available.length;
    index += 1
  ) {
    const candidate =
      available[index];

    if (
      !nicheMatches(
        candidate.niche,
        plan.niche
      )
    ) {
      continue;
    }

    if (
      !resourceTypeMatches(
        candidate,
        plan
      )
    ) {
      continue;
    }

    ranked.push({
      index,
      candidate,
      sameCaller:
        candidate.previousAssigneeId ===
        caller.id,
    });
  }

  ranked.sort(
    (left, right) =>
      Number(right.sameCaller) -
        Number(left.sameCaller) ||
      Number(
        right.candidate.priority ||
        0
      ) -
        Number(
          left.candidate.priority ||
          0
        )
  );

  const chosen =
    ranked.slice(
      0,
      limit
    );

  const selectedIndexes =
    new Set(
      chosen.map(
        (item) =>
          item.index
      )
    );

  const selected =
    chosen.map(
      (item) =>
        item.candidate
    );

  for (
    let index =
      available.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (
      selectedIndexes.has(
        index
      )
    ) {
      available.splice(
        index,
        1
      );
    }
  }

  return selected;
}

function getBusinessDateKey(
  date,
  config
) {
  const local =
    getZonedDateParts(
      date,
      config.timezone
    );

  let dateKey =
    getDateKey(
      date,
      config.timezone
    );

  const beforeCutoff =
    local.hour <
      config.assignmentHour ||
    (
      local.hour ===
        config.assignmentHour &&
      local.minute <
        config.assignmentMinute
    );

  if (beforeCutoff) {
    dateKey =
      addDaysToDateKey(
        dateKey,
        -1
      );
  }

  return dateKey;
}

function getNextScheduledRunDate(
  now,
  config
) {
  const delayMs =
    millisecondsUntilNextRun({
      timeZone:
        config.timezone,
      hour:
        config.assignmentHour,
      minute:
        config.assignmentMinute,
    });

  return new Date(
    now.getTime() +
      delayMs
  );
}

function getCallerDayStats({
  state,
  workspaceId,
  callerId,
  dateKey,
}) {
  const leads = [];

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
      const assignedTo =
        String(
          lead.assignedTo ||
          lead.assigneeId ||
          ""
        );

      if (
        assignedTo !==
        callerId ||
        String(
          lead.dailyQueueDate ||
          lead.assignmentDate ||
          ""
        ) !== dateKey
      ) {
        continue;
      }

      leads.push(lead);
    }
  }

  const worked =
    leads.filter(
      (lead) => {
        const status =
          normalizeStatus(
            lead.status
          );

        return (
          Number(
            lead.callAttempts ||
            0
          ) > 0 ||
          ![
            "",
            "new",
            "assigned",
            "pending",
            "ready",
          ].includes(status)
        );
      }
    ).length;

  const closed =
    leads.filter(
      (lead) =>
        isTerminalLead(lead)
    ).length;

  const niches =
    leads
      .map(
        (lead) =>
          lead.dailyNiche ||
          lead.niche ||
          lead.category ||
          ""
      )
      .filter(Boolean);

  const niche =
    mostCommonString(niches);

  const resourceType =
    mostCommonString(
      leads
        .map(
          (lead) =>
            normalizeResourceType(
              lead.dailyResourceType ||
                inferResourceTypeFromLocation(
                  lead.dailyLocation ||
                    lead.address ||
                    "",
                  lead.dailyRegionCode ||
                    lead.regionCode ||
                    ""
                )
            )
        )
        .filter(Boolean)
    );

  const location =
    mostCommonString(
      leads
        .map(
          (lead) =>
            lead.dailyLocation ||
            lead.location ||
            lead.address ||
            ""
        )
        .filter(Boolean)
    );

  const country =
    mostCommonString(
      leads
        .map(
          (lead) =>
            lead.dailyCountry ||
            lead.country ||
            (normalizeResourceType(
              lead.dailyResourceType
            ) === "local"
              ? "Pakistan"
              : "")
        )
        .filter(Boolean)
    );

  return {
    assigned:
      leads.length,
    worked,
    closed,
    remaining:
      Math.max(
        0,
        leads.length -
          worked
      ),
    niche,
    resourceType,
    location,
    country,
  };
}

function mostCommonString(
  values
) {
  const counts =
    new Map();

  for (const value of values) {
    const key =
      String(value || "").trim();
    if (!key) continue;
    counts.set(
      key,
      (counts.get(key) || 0) + 1
    );
  }

  return (
    [...counts.entries()]
      .sort(
        (left, right) =>
          right[1] - left[1]
      )[0]?.[0] ||
    ""
  );
}

function getCallerSubmission({
  state,
  workspaceId,
  callerId,
  dateKey,
}) {
  return (
    (
      state.dailyCallerSubmissions ||
      []
    ).find(
      (item) =>
        item.workspaceId ===
          workspaceId &&
        item.callerId ===
          callerId &&
        item.dateKey ===
          dateKey
    ) ||
    null
  );
}

/* ==========================================================================
   Configuration
   ========================================================================== */

function normalizeConfig(
  value
) {
  return {
    enabled:
      value.enabled ===
      true,

    leadsPerCaller:
      clampInteger(
        value.leadsPerCaller,
        DEFAULT_LEADS_PER_CALLER,
        1,
        5000
      ),

    timezone:
      String(
        value.timezone ||
        DEFAULT_TIMEZONE
      ).trim(),

    assignmentHour:
      clampInteger(
        value.assignmentHour,
        DEFAULT_ASSIGNMENT_HOUR,
        0,
        23
      ),

    assignmentMinute:
      clampInteger(
        value.assignmentMinute,
        DEFAULT_ASSIGNMENT_MINUTE,
        0,
        59
      ),

    recycleAfterHours:
      clampInteger(
        value.recycleAfterHours,
        DEFAULT_RECYCLE_AFTER_HOURS,
        1,
        24 * 365
      ),

    maxCallAttempts:
      clampInteger(
        value.maxCallAttempts,
        DEFAULT_MAX_CALL_ATTEMPTS,
        1,
        100
      ),

    generationBatchSize:
      clampInteger(
        value.generationBatchSize,
        DEFAULT_GENERATION_BATCH_SIZE,
        1,
        1000
      ),

    maxGenerationPerRun:
      clampInteger(
        value.maxGenerationPerRun,
        DEFAULT_MAX_GENERATION_PER_RUN,
        1,
        100000
      ),

    niches:
      normalizeStringArray(
        value.niches
      ),

    locations:
      normalizeStringArray(
        value.locations
      ),

    localPakistanLocations:
      normalizeStringArray(
        value.localPakistanLocations?.length
          ? value.localPakistanLocations
          : DEFAULT_LOCAL_PAKISTAN_LOCATIONS
      ),

    regionCode:
      String(
        value.regionCode ||
        DEFAULT_REGION_CODE
      )
        .trim()
        .toUpperCase(),

    radiusKm:
      clampNumber(
        value.radiusKm,
        DEFAULT_RADIUS_KM,
        1,
        500
      ),

    qualityLevel:
      String(
        value.qualityLevel ||
        DEFAULT_QUALITY_LEVEL
      ).trim(),

    autoMiniAudit:
      value.autoMiniAudit !==
      false,

    callerPlans:
      normalizeCallerPlans(
        value.callerPlans
      ),

    staleRunMinutes:
      clampInteger(
        value.staleRunMinutes,
        DEFAULT_STALE_RUN_MINUTES,
        1,
        24 * 60
      ),
  };
}

/* ==========================================================================
   Timezone scheduler helpers
   ========================================================================== */

function millisecondsUntilNextRun({
  timeZone,
  hour,
  minute,
}) {
  const now =
    new Date();

  const local =
    getZonedDateParts(
      now,
      timeZone
    );

  let dateKey =
    [
      local.year,
      String(
        local.month
      ).padStart(
        2,
        "0"
      ),
      String(
        local.day
      ).padStart(
        2,
        "0"
      ),
    ].join("-");

  const passed =
    local.hour > hour ||
    (
      local.hour ===
        hour &&
      local.minute >=
        minute
    );

  if (passed) {
    dateKey =
      addDaysToDateKey(
        dateKey,
        1
      );
  }

  const target =
    zonedDateTimeToUtc({
      dateKey,
      hour,
      minute,
      timeZone,
    });

  return Math.max(
    1000,
    target.getTime() -
      now.getTime()
  );
}

function getDateKey(
  date,
  timeZone =
    DEFAULT_TIMEZONE
) {
  const parts =
    getZonedDateParts(
      date,
      timeZone
    );

  return [
    parts.year,

    String(
      parts.month
    ).padStart(
      2,
      "0"
    ),

    String(
      parts.day
    ).padStart(
      2,
      "0"
    ),
  ].join("-");
}

function getZonedDateParts(
  date,
  timeZone
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone,
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit",
        hour:
          "2-digit",
        minute:
          "2-digit",
        second:
          "2-digit",
        hourCycle:
          "h23",
      }
    ).formatToParts(
      date
    );

  const values =
    Object.fromEntries(
      parts.map(
        ({
          type,
          value,
        }) => [
          type,
          value,
        ]
      )
    );

  return {
    year:
      Number(
        values.year
      ),

    month:
      Number(
        values.month
      ),

    day:
      Number(
        values.day
      ),

    hour:
      Number(
        values.hour
      ),

    minute:
      Number(
        values.minute
      ),

    second:
      Number(
        values.second
      ),
  };
}

function zonedDateTimeToUtc({
  dateKey,
  hour,
  minute,
  timeZone,
}) {
  const [
    year,
    month,
    day,
  ] =
    dateKey
      .split("-")
      .map(
        Number
      );

  let estimate =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        0,
        0
      )
    );

  for (
    let index = 0;
    index < 4;
    index += 1
  ) {
    const represented =
      getZonedDateParts(
        estimate,
        timeZone
      );

    const representedUtc =
      Date.UTC(
        represented.year,
        represented.month -
          1,
        represented.day,
        represented.hour,
        represented.minute,
        represented.second
      );

    const expectedUtc =
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        0
      );

    estimate =
      new Date(
        estimate.getTime() +
        expectedUtc -
        representedUtc
      );
  }

  return estimate;
}

function addDaysToDateKey(
  dateKey,
  days
) {
  const [
    year,
    month,
    day,
  ] =
    dateKey
      .split("-")
      .map(
        Number
      );

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day + days
    )
  )
    .toISOString()
    .slice(
      0,
      10
    );
}

/* ==========================================================================
   General utilities
   ========================================================================== */

function requireManager(
  context
) {
  const role =
    normalizeRole(
      context?.role ||
      context?.user
        ?.workspaceRole ||
      context?.user
        ?.role
    );

  if (
    ![
      "owner",
      "admin",
      "manager",
    ].includes(
      role
    )
  ) {
    throw httpError(
      403,
      "Manager access is required."
    );
  }
}

function normalizeRole(
  value
) {
  const role =
    normalizeStatus(
      value
    );

  if (
    role.includes(
      "owner"
    )
  ) {
    return "owner";
  }

  if (
    role.includes(
      "admin"
    )
  ) {
    return "admin";
  }

  if (
    role.includes(
      "manager"
    )
  ) {
    return "manager";
  }

  if (
    role.includes(
      "caller"
    )
  ) {
    return "caller";
  }

  return role;
}

function normalizeStatus(
  value
) {
  return String(
    value ||
      ""
  )
    .trim()
    .toLowerCase()
    .replace(
      /[\s-]+/g,
      "_"
    );
}

function normalizePriority(
  value
) {
  if (
    typeof value ===
    "number"
  ) {
    if (
      value >= 90
    ) {
      return "urgent";
    }

    if (
      value >= 70
    ) {
      return "high";
    }

    return "normal";
  }

  const priority =
    normalizeStatus(
      value
    );

  if (
    [
      "urgent",
      "high",
      "normal",
      "low",
    ].includes(
      priority
    )
  ) {
    return priority;
  }

  return "normal";
}

function normalizeWebsite(
  value
) {
  const raw =
    String(
      value ||
        ""
    ).trim();

  if (!raw) {
    return "";
  }

  try {
    const url =
      new URL(
        raw.startsWith(
          "http"
        )
          ? raw
          : `https://${raw}`
      );

    return url.hostname
      .replace(
        /^www\./,
        ""
      )
      .toLowerCase();
  } catch {
    return raw
      .replace(
        /^https?:\/\//i,
        ""
      )
      .replace(
        /^www\./i,
        ""
      )
      .split("/")[0]
      .toLowerCase();
  }
}

function normalizePhone(
  value
) {
  return String(
    value ||
      ""
  ).replace(
    /[^\d+]/g,
    ""
  );
}

function normalizeStringArray(
  value
) {
  const source =
    Array.isArray(
      value
    )
      ? value
      : parseCsv(
          value
        );

  return [
    ...new Set(
      source
        .map(
          (item) =>
            String(
              item ||
                ""
            ).trim()
        )
        .filter(
          Boolean
        )
    ),
  ];
}

function parseCsv(
  value
) {
  return String(
    value ||
      ""
  )
    .split(",")
    .map(
      (item) =>
        item.trim()
    )
    .filter(
      Boolean
    );
}

function clampInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const parsed =
    Number.parseInt(
      value,
      10
    );

  if (
    !Number.isFinite(
      parsed
    )
  ) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      parsed
    )
  );
}

function clampNumber(
  value,
  fallback,
  minimum,
  maximum
) {
  const parsed =
    Number(
      value
    );

  if (
    !Number.isFinite(
      parsed
    )
  ) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      parsed
    )
  );
}

function envFlag(
  name,
  fallback = false
) {
  const value =
    String(
      process.env[
        name
      ] ??
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
  ].includes(
    value
  );
}

function httpError(
  statusCode,
  message
) {
  const error =
    new Error(
      message
    );

  error.statusCode =
    statusCode;

  return error;
}