import crypto from "node:crypto";

/* ==========================================================================
   Daily lead automation
   ========================================================================== */

const TERMINAL_LEAD_STATUSES = new Set([
  "qualified",
  "converted",
  "meeting_booked",
  "not_interested",
  "do_not_call",
  "invalid_number",
  "wrong_number",
  "closed",
  "completed",
]);

const RETRYABLE_LEAD_STATUSES = new Set([
  "new",
  "assigned",
  "ready",
  "pending",
  "in_progress",
  "attempted",
  "no_answer",
  "busy",
  "voicemail",
  "callback",
  "follow_up",
  "missed",
]);

const RUN_COMPLETE_STATUSES = new Set([
  "complete",
  "completed",
  "completed_partial",
]);

const RUN_ACTIVE_STATUSES = new Set([
  "running",
  "processing",
]);

export function createDailyLeadAutomationService({
  store,
  workspaceService,
  leadFinder,
  leadAuditService = null,
  emit = null,
} = {}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createDailyLeadAutomationService requires a store exposing read() and update()."
    );
  }

  if (!workspaceService) {
    throw new Error(
      "createDailyLeadAutomationService requires workspaceService."
    );
  }

  if (!leadFinder?.findLeads) {
    throw new Error(
      "createDailyLeadAutomationService requires leadFinder.findLeads()."
    );
  }

  let schedulerTimer = null;
  let startupTimer = null;
  let stopped = false;
  let schedulerRunning = false;

  function getEnvironmentConfig() {
    return normalizeConfig({
      enabled: envFlag(
        "DAILY_LEAD_AUTOMATION_ENABLED",
        false
      ),

      leadsPerCaller: envInteger(
        "DAILY_LEADS_PER_CALLER",
        100,
        1,
        1000
      ),

      timezone:
        process.env.DAILY_LEAD_TIMEZONE ||
        "Asia/Karachi",

      assignmentHour: envInteger(
        "DAILY_LEAD_ASSIGNMENT_HOUR",
        0,
        0,
        23
      ),

      assignmentMinute: envInteger(
        "DAILY_LEAD_ASSIGNMENT_MINUTE",
        0,
        0,
        59
      ),

      startupDelayMs: envInteger(
        "DAILY_LEAD_STARTUP_DELAY_MS",
        15_000,
        0,
        10 * 60_000
      ),

      recycleAfterHours: envInteger(
        "DAILY_LEAD_RECYCLE_AFTER_HOURS",
        24,
        1,
        24 * 365
      ),

      maxCallAttempts: envInteger(
        "DAILY_LEAD_MAX_CALL_ATTEMPTS",
        5,
        1,
        100
      ),

      maxGenerationPerRun: envInteger(
        "DAILY_LEAD_MAX_GENERATION_PER_RUN",
        2000,
        1,
        20_000
      ),

      generationBatchSize: envInteger(
        "DAILY_LEAD_GENERATION_BATCH_SIZE",
        200,
        1,
        1000
      ),

      niches: splitCsv(
        process.env.DAILY_LEAD_NICHES
      ),

      locations: splitCsv(
        process.env.DAILY_LEAD_LOCATIONS
      ),

      regionCode:
        process.env.DAILY_LEAD_REGION_CODE ||
        "US",

      radiusKm: envInteger(
        "DAILY_LEAD_RADIUS_KM",
        50,
        1,
        500
      ),

      qualityLevel:
        process.env.DAILY_LEAD_QUALITY_LEVEL ||
        "balanced",

      autoMiniAudit: envFlag(
        "DAILY_LEAD_AUTO_MINI_AUDIT",
        true
      ),

      staleRunMinutes: envInteger(
        "DAILY_LEAD_STALE_RUN_MINUTES",
        30,
        5,
        24 * 60
      ),
    });
  }

  function getWorkspaceConfig(
    workspaceId,
    state = store.read()
  ) {
    const environmentConfig =
      getEnvironmentConfig();

    const stored =
      state.workspaceSettings?.[
        workspaceId
      ]?.dailyLeads || {};

    return normalizeConfig({
      ...environmentConfig,
      ...stored,

      enabled:
        stored.enabled ??
        environmentConfig.enabled,

      leadsPerCaller:
        stored.leadsPerCaller ??
        environmentConfig.leadsPerCaller,

      timezone:
        stored.timezone ||
        environmentConfig.timezone,

      assignmentHour:
        stored.assignmentHour ??
        environmentConfig.assignmentHour,

      assignmentMinute:
        stored.assignmentMinute ??
        environmentConfig.assignmentMinute,

      niches:
        Array.isArray(stored.niches) &&
        stored.niches.length
          ? stored.niches
          : environmentConfig.niches,

      locations:
        Array.isArray(stored.locations) &&
        stored.locations.length
          ? stored.locations
          : environmentConfig.locations,
    });
  }

  function status(user) {
    const state = store.read();
    ensureCollections(state);

    const context =
      getWorkspaceContext(
        workspaceService,
        user,
        state
      );

    const workspaceId =
      context.workspaceId;

    const config =
      getWorkspaceConfig(
        workspaceId,
        state
      );

    const runs =
      state.dailyLeadRuns
        .filter(
          (run) =>
            run.workspaceId ===
            workspaceId
        )
        .sort(
          (left, right) =>
            Date.parse(
              right.createdAt || 0
            ) -
            Date.parse(
              left.createdAt || 0
            )
        );

    const todayDateKey =
      getDateKey(
        new Date(),
        config.timezone
      );

    const todayRun =
      runs.find(
        (run) =>
          run.dateKey ===
          todayDateKey
      ) || null;

    return {
      ok: true,
      config,
      todayDateKey,
      todayRun,
      latestRun:
        runs[0] || null,
      nextRunAt:
        calculateNextRunAt(config)
          .toISOString(),
    };
  }

  function updateConfig(
    user,
    input = {}
  ) {
    const state = store.read();

    const context =
      getWorkspaceContext(
        workspaceService,
        user,
        state
      );

    requireManager(context);

    const workspaceId =
      context.workspaceId;

    const current =
      getWorkspaceConfig(
        workspaceId,
        state
      );

    const next =
      normalizeConfig({
        ...current,
        ...input,
      });

    store.update((draft) => {
      ensureCollections(draft);

      draft.workspaceSettings =
        isPlainObject(
          draft.workspaceSettings
        )
          ? draft.workspaceSettings
          : {};

      draft.workspaceSettings[
        workspaceId
      ] =
        isPlainObject(
          draft.workspaceSettings[
            workspaceId
          ]
        )
          ? draft.workspaceSettings[
              workspaceId
            ]
          : {};

      draft.workspaceSettings[
        workspaceId
      ].dailyLeads = {
        ...next,
        updatedBy:
          user.id,
        updatedAt:
          new Date().toISOString(),
      };
    });

    scheduleNextRun();

    return {
      ok: true,
      config: next,
    };
  }

  async function runForUser(
    user,
    {
      force = false,
      trigger = "manual",
    } = {}
  ) {
    const state = store.read();

    const context =
      getWorkspaceContext(
        workspaceService,
        user,
        state
      );

    requireManager(context);

    return runWorkspace({
      workspaceId:
        context.workspaceId,
      requestedBy:
        user.id,
      force,
      trigger,
    });
  }

  async function runWorkspace({
    workspaceId,
    requestedBy = "system",
    force = false,
    trigger = "scheduler",
  } = {}) {
    if (!workspaceId) {
      throw httpError(
        400,
        "workspaceId is required."
      );
    }

    const initialState =
      store.read();

    ensureCollections(
      initialState
    );

    const config =
      getWorkspaceConfig(
        workspaceId,
        initialState
      );

    if (
      !config.enabled &&
      !force
    ) {
      return {
        ok: true,
        skipped: true,
        reason:
          "Daily lead automation is disabled.",
        workspaceId,
      };
    }

    const now =
      new Date();

    const dateKey =
      getDateKey(
        now,
        config.timezone
      );

    recoverStaleRuns({
      workspaceId,
      dateKey,
      staleRunMinutes:
        config.staleRunMinutes,
    });

    const stateAfterRecovery =
      store.read();

    ensureCollections(
      stateAfterRecovery
    );

    const existingRun =
      getTodayRun(
        stateAfterRecovery,
        workspaceId,
        dateKey
      );

    if (
      existingRun &&
      RUN_COMPLETE_STATUSES.has(
        normalizeStatus(
          existingRun.status
        )
      ) &&
      !force
    ) {
      return {
        ok: true,
        skipped: true,
        reason:
          "Today's automatic allocation has already completed.",
        run: existingRun,
      };
    }

    if (
      existingRun &&
      RUN_ACTIVE_STATUSES.has(
        normalizeStatus(
          existingRun.status
        )
      ) &&
      !force
    ) {
      return {
        ok: true,
        skipped: true,
        reason:
          "Today's automatic allocation is already running.",
        run: existingRun,
      };
    }

    const runId =
      crypto.randomUUID();

    const startedAt =
      new Date().toISOString();

    const runRecord = {
      id: runId,
      workspaceId,
      dateKey,
      timezone:
        config.timezone,
      trigger,
      requestedBy,
      force:
        Boolean(force),
      status: "running",
      targetPerCaller:
        config.leadsPerCaller,
      callerCount: 0,
      requestedCount: 0,
      existingCount: 0,
      reusedCount: 0,
      generatedCount: 0,
      assignedCount: 0,
      shortageCount: 0,
      assignedByCaller: {},
      errors: [],
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
      completedAt: "",
    };

    store.update((draft) => {
      ensureCollections(draft);

      const oldRun =
        getTodayRun(
          draft,
          workspaceId,
          dateKey
        );

      if (oldRun) {
        oldRun.status =
          "superseded";
        oldRun.supersededBy =
          runId;
        oldRun.updatedAt =
          startedAt;
      }

      draft.dailyLeadRuns.unshift(
        runRecord
      );
    });

    emitEvent({
      workspaceId,
      event:
        "daily-leads:run-started",
      payload: {
        run: runRecord,
      },
    });

    try {
      const state =
        store.read();

      ensureCollections(state);

      const callers =
        getActiveCallers({
          state,
          workspaceId,
          workspaceService,
        });

      if (!callers.length) {
        throw httpError(
          422,
          "No active callers were found in this workspace."
        );
      }

      const targetTotal =
        callers.length *
        config.leadsPerCaller;

      updateRun(runId, {
        callerCount:
          callers.length,
        requestedCount:
          targetTotal,
      });

      const callerPlans =
        callers.map(
          (caller) => {
            const activeCount =
              countActiveAssignmentsForCaller({
                state,
                workspaceId,
                callerId:
                  caller.id,
                dateKey,
              });

            return {
              caller,
              activeCount,
              shortage:
                Math.max(
                  0,
                  config.leadsPerCaller -
                    activeCount
                ),
              assigned: 0,
            };
          }
        );

      const totalShortage =
        callerPlans.reduce(
          (sum, plan) =>
            sum +
            plan.shortage,
          0
        );

      if (!totalShortage) {
        const result =
          completeRun({
            runId,
            status:
              "completed",
            assignedCount: 0,
            shortageCount: 0,
            assignedByCaller:
              Object.fromEntries(
                callerPlans.map(
                  (plan) => [
                    plan.caller.id,
                    0,
                  ]
                )
              ),
          });

        emitEvent({
          workspaceId,
          event:
            "daily-leads:run-completed",
          payload: {
            run: result,
          },
        });

        return {
          ok: true,
          run: result,
        };
      }

      const reusableRefs =
        collectReusableLeadRefs({
          state,
          workspaceId,
          dateKey,
          config,
        });

      const selectedReusable =
        reusableRefs.slice(
          0,
          totalShortage
        );

      const remainingShortage =
        Math.max(
          0,
          totalShortage -
            selectedReusable.length
        );

      let generatedRefs = [];

      if (remainingShortage > 0) {
        generatedRefs =
          await generateLeadShortage({
            workspaceId,
            requestedBy,
            shortage:
              Math.min(
                remainingShortage,
                config
                  .maxGenerationPerRun
              ),
            config,
            runId,
          });
      }

      const allLeadRefs =
        deduplicateLeadRefs([
          ...selectedReusable,
          ...generatedRefs,
        ]);

      const assignmentResult =
        assignLeadRefsToCallers({
          workspaceId,
          dateKey,
          requestedBy,
          callerPlans,
          leadRefs:
            allLeadRefs,
          runId,
        });

      const assignedCount =
        assignmentResult
          .assignedCount;

      const finalShortage =
        Math.max(
          0,
          targetTotal -
            callerPlans.reduce(
              (sum, plan) =>
                sum +
                plan.activeCount,
              0
            ) -
            assignedCount
        );

      if (
        config.autoMiniAudit &&
        assignedCount > 0
      ) {
        queueMiniAudits({
          workspaceId,
          requestedBy,
          assignedRefs:
            assignmentResult
              .assignedRefs,
        });
      }

      const completedStatus =
        finalShortage > 0
          ? "completed_partial"
          : "completed";

      const completedRun =
        completeRun({
          runId,
          status:
            completedStatus,
          existingCount:
            selectedReusable.length,
          reusedCount:
            assignmentResult
              .reusedCount,
          generatedCount:
            generatedRefs.length,
          assignedCount,
          shortageCount:
            finalShortage,
          assignedByCaller:
            assignmentResult
              .assignedByCaller,
        });

      emitEvent({
        workspaceId,
        event:
          "daily-leads:run-completed",
        payload: {
          run:
            completedRun,
        },
      });

      return {
        ok: true,
        run:
          completedRun,
      };
    } catch (error) {
      const failedRun =
        failRun({
          runId,
          error,
        });

      emitEvent({
        workspaceId,
        event:
          "daily-leads:run-failed",
        payload: {
          run:
            failedRun,
          error:
            error.message,
        },
      });

      throw error;
    }
  }

  async function runAllWorkspaces({
    trigger = "scheduler",
    force = false,
  } = {}) {
    const state =
      store.read();

    ensureCollections(state);

    const workspaceIds =
      new Set();

    for (
      const workspace
      of state.workspaces
    ) {
      if (
        workspace?.id &&
        workspace.active !== false &&
        workspace.isActive !== false &&
        normalizeStatus(
          workspace.status
        ) !== "inactive"
      ) {
        workspaceIds.add(
          workspace.id
        );
      }
    }

    for (
      const user
      of state.users
    ) {
      if (
        user?.workspaceId &&
        user.active !== false &&
        user.isActive !== false
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
        getWorkspaceConfig(
          workspaceId,
          state
        );

      if (
        !config.enabled &&
        !force
      ) {
        continue;
      }

      try {
        const result =
          await runWorkspace({
            workspaceId,
            requestedBy:
              "system",
            force,
            trigger,
          });

        results.push({
          workspaceId,
          ok: true,
          result,
        });
      } catch (error) {
        console.error(
          `[daily-leads] workspace run failed ${JSON.stringify({
            workspaceId,
            trigger,
            error:
              error.message,
          })}`
        );

        results.push({
          workspaceId,
          ok: false,
          error:
            error.message,
        });
      }
    }

    return {
      ok:
        results.every(
          (item) =>
            item.ok
        ),
      results,
    };
  }

  function startScheduler() {
    stopped = false;

    clearSchedulerTimers();

    const environmentConfig =
      getEnvironmentConfig();

    if (
      !environmentConfig.enabled
    ) {
      console.log(
        "[daily-leads] scheduler disabled"
      );

      return {
        stop,
      };
    }

    const startupDelayMs =
      environmentConfig
        .startupDelayMs;

    startupTimer =
      setTimeout(
        async () => {
          try {
            await runStartupCatchUp();
          } catch (error) {
            console.error(
              "[daily-leads] startup catch-up failed",
              error
            );
          } finally {
            scheduleNextRun();
          }
        },
        startupDelayMs
      );

    startupTimer.unref?.();

    console.log(
      `[daily-leads] startup catch-up scheduled ${JSON.stringify({
        delayMs:
          startupDelayMs,
      })}`
    );

    return {
      stop,
    };
  }

  async function runStartupCatchUp() {
    if (
      stopped ||
      schedulerRunning
    ) {
      return;
    }

    schedulerRunning = true;

    try {
      const state =
        store.read();

      ensureCollections(state);

      const workspaceIds =
        getActiveWorkspaceIds(state);

      for (
        const workspaceId
        of workspaceIds
      ) {
        const config =
          getWorkspaceConfig(
            workspaceId,
            state
          );

        if (!config.enabled) {
          continue;
        }

        const currentParts =
          getZonedDateParts(
            new Date(),
            config.timezone
          );

        const afterScheduledTime =
          currentParts.hour >
            config.assignmentHour ||
          (
            currentParts.hour ===
              config.assignmentHour &&
            currentParts.minute >=
              config.assignmentMinute
          );

        if (!afterScheduledTime) {
          continue;
        }

        const dateKey =
          getDateKey(
            new Date(),
            config.timezone
          );

        recoverStaleRuns({
          workspaceId,
          dateKey,
          staleRunMinutes:
            config.staleRunMinutes,
        });

        const currentState =
          store.read();

        const currentRun =
          getTodayRun(
            currentState,
            workspaceId,
            dateKey
          );

        if (
          currentRun &&
          RUN_COMPLETE_STATUSES.has(
            normalizeStatus(
              currentRun.status
            )
          )
        ) {
          continue;
        }

        await runWorkspace({
          workspaceId,
          requestedBy:
            "system",
          trigger:
            "startup-catch-up",
          force:
            Boolean(
              currentRun &&
              RUN_ACTIVE_STATUSES.has(
                normalizeStatus(
                  currentRun.status
                )
              )
            ),
        });
      }
    } finally {
      schedulerRunning = false;
    }
  }

  function scheduleNextRun() {
    if (stopped) {
      return;
    }

    if (schedulerTimer) {
      clearTimeout(
        schedulerTimer
      );
    }

    const config =
      getEnvironmentConfig();

    const nextRun =
      calculateNextRunAt(
        config
      );

    const delayMs =
      Math.max(
        1000,
        nextRun.getTime() -
          Date.now()
      );

    console.log(
      `[daily-leads] next run scheduled ${JSON.stringify({
        nextRunAt:
          nextRun.toISOString(),
        timezone:
          config.timezone,
        assignmentHour:
          config.assignmentHour,
        assignmentMinute:
          config.assignmentMinute,
        delayMs,
      })}`
    );

    schedulerTimer =
      setTimeout(
        async () => {
          if (
            stopped ||
            schedulerRunning
          ) {
            scheduleNextRun();
            return;
          }

          schedulerRunning = true;

          try {
            await runAllWorkspaces({
              trigger:
                "midnight-scheduler",
              force: false,
            });
          } catch (error) {
            console.error(
              "[daily-leads] scheduled run failed",
              error
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

  function stop() {
    stopped = true;
    clearSchedulerTimers();
  }

  function clearSchedulerTimers() {
    if (startupTimer) {
      clearTimeout(
        startupTimer
      );
      startupTimer = null;
    }

    if (schedulerTimer) {
      clearTimeout(
        schedulerTimer
      );
      schedulerTimer = null;
    }
  }

  function emitEvent({
    workspaceId,
    event,
    payload,
  }) {
    if (!emit) {
      return;
    }

    try {
      if (
        typeof emit ===
        "function"
      ) {
        emit({
          workspaceId,
          event,
          payload,
        });

        return;
      }

      emit.emit?.({
        workspaceId,
        event,
        payload,
      });
    } catch (error) {
      console.error(
        "[daily-leads] emit failed",
        error
      );
    }
  }

  return {
    status,
    getStatus: status,

    updateConfig,
    saveConfig: updateConfig,

    runForUser,
    run: runForUser,

    runWorkspace,
    runAllWorkspaces,

    startScheduler,
    stop,
  };

  /* ========================================================================
     Run persistence
     ======================================================================== */

  function recoverStaleRuns({
    workspaceId,
    dateKey,
    staleRunMinutes,
  }) {
    const cutoff =
      Date.now() -
      staleRunMinutes *
        60_000;

    store.update((draft) => {
      ensureCollections(draft);

      for (
        const run
        of draft.dailyLeadRuns
      ) {
        if (
          run.workspaceId !==
            workspaceId ||
          run.dateKey !==
            dateKey ||
          !RUN_ACTIVE_STATUSES.has(
            normalizeStatus(
              run.status
            )
          )
        ) {
          continue;
        }

        const heartbeatTime =
          Date.parse(
            run.updatedAt ||
              run.startedAt ||
              run.createdAt ||
              0
          );

        if (
          !Number.isFinite(
            heartbeatTime
          ) ||
          heartbeatTime <=
            cutoff
        ) {
          run.status =
            "failed";

          run.failureReason =
            "The previous automation run became stale and was recovered automatically.";

          run.completedAt =
            new Date().toISOString();

          run.updatedAt =
            run.completedAt;

          run.errors =
            Array.isArray(
              run.errors
            )
              ? run.errors
              : [];

          run.errors.push({
            code:
              "STALE_RUN_RECOVERED",
            message:
              run.failureReason,
            createdAt:
              run.completedAt,
          });
        }
      }
    });
  }

  function updateRun(
    runId,
    updates
  ) {
    let updated = null;

    store.update((draft) => {
      ensureCollections(draft);

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
        updates,
        {
          updatedAt:
            new Date().toISOString(),
        }
      );

      updated = {
        ...run,
      };
    });

    return updated;
  }

  function completeRun({
    runId,
    status,
    existingCount,
    reusedCount,
    generatedCount,
    assignedCount,
    shortageCount,
    assignedByCaller,
  }) {
    const completedAt =
      new Date().toISOString();

    return updateRun(
      runId,
      removeUndefined({
        status,
        existingCount,
        reusedCount,
        generatedCount,
        assignedCount,
        shortageCount,
        assignedByCaller,
        completedAt,
      })
    );
  }

  function failRun({
    runId,
    error,
  }) {
    const completedAt =
      new Date().toISOString();

    return updateRun(runId, {
      status: "failed",
      completedAt,
      failureReason:
        error?.message ||
        "Daily lead automation failed.",
      errors: [
        {
          code:
            error?.code ||
            "DAILY_LEAD_RUN_FAILED",
          message:
            error?.message ||
            String(error),
          createdAt:
            completedAt,
        },
      ],
    });
  }

  /* ========================================================================
     Real lead collection
     ======================================================================== */

  function collectReusableLeadRefs({
    state,
    workspaceId,
    dateKey,
    config,
  }) {
    const assignedKeys =
      collectActiveAssignmentKeys({
        state,
        workspaceId,
        dateKey,
      });

    const now =
      Date.now();

    const recycleCutoff =
      now -
      config.recycleAfterHours *
        60 *
        60 *
        1000;

    const refs = [];

    for (
      const campaign
      of state.campaigns || []
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
        of campaign.leads || []
      ) {
        if (
          !lead?.id ||
          !isRealLead(lead)
        ) {
          continue;
        }

        const leadKey =
          `${campaign.id}:${lead.id}`;

        if (
          assignedKeys.has(
            leadKey
          )
        ) {
          continue;
        }

        const status =
          normalizeStatus(
            lead.status ||
              lead.queueStatus
          );

        if (
          TERMINAL_LEAD_STATUSES.has(
            status
          )
        ) {
          continue;
        }

        if (
          lead.doNotCall ===
          true
        ) {
          continue;
        }

        const attempts =
          Number(
            lead.callAttempts ||
              lead.attempts ||
              0
          );

        if (
          attempts >=
          config.maxCallAttempts
        ) {
          continue;
        }

        const nextActionTime =
          Date.parse(
            lead.nextActionAt ||
              lead.callbackAt ||
              lead.followUpAt ||
              0
          );

        if (
          Number.isFinite(
            nextActionTime
          ) &&
          nextActionTime >
            now
        ) {
          continue;
        }

        const assignmentTime =
          Date.parse(
            lead.assignedAt ||
              lead.lastAssignedAt ||
              0
          );

        const currentlyAssigned =
          Boolean(
            lead.assignedTo ||
              lead.assigneeId
          );

        if (
          currentlyAssigned &&
          Number.isFinite(
            assignmentTime
          ) &&
          assignmentTime >
            recycleCutoff
        ) {
          continue;
        }

        refs.push({
          campaignId:
            campaign.id,
          leadId:
            lead.id,
          lead,
          source:
            "existing",
          priority:
            getLeadPriority(
              lead
            ),
          dueAt:
            nextActionTime || 0,
          createdAt:
            Date.parse(
              lead.createdAt ||
                campaign.createdAt ||
                0
            ),
        });
      }
    }

    return refs.sort(
      compareLeadRefs
    );
  }

  async function generateLeadShortage({
    workspaceId,
    requestedBy,
    shortage,
    config,
    runId,
  }) {
    if (shortage <= 0) {
      return [];
    }

    if (
      !config.niches.length ||
      !config.locations.length
    ) {
      throw httpError(
        422,
        "Configure at least one niche and one location before running daily lead automation."
      );
    }

    const refs = [];
    const seenKeys =
      collectExistingLeadIdentityKeys(
        store.read(),
        workspaceId
      );

    let combinationIndex = 0;
    let remaining = shortage;

    while (
      remaining > 0 &&
      refs.length <
        config.maxGenerationPerRun
    ) {
      const niche =
        config.niches[
          combinationIndex %
            config.niches.length
        ];

      const location =
        config.locations[
          Math.floor(
            combinationIndex /
              config.niches.length
          ) %
            config.locations.length
        ];

      const batchSize =
        Math.min(
          remaining,
          config.generationBatchSize,
          1000
        );

      updateRun(runId, {
        currentNiche:
          niche,
        currentLocation:
          location,
        heartbeatAt:
          new Date().toISOString(),
      });

      let result;

      try {
        result =
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
              config.regionCode,
            exact: false,
          });
      } catch (error) {
        console.error(
          `[daily-leads] Google lead generation failed ${JSON.stringify({
            workspaceId,
            niche,
            location,
            batchSize,
            error:
              error.message,
          })}`
        );

        combinationIndex += 1;

        if (
          combinationIndex >=
          config.niches.length *
            config.locations.length
        ) {
          break;
        }

        continue;
      }

      const generatedLeads =
        Array.isArray(
          result?.leads
        )
          ? result.leads
          : [];

      const uniqueLeads = [];

      for (
        const rawLead
        of generatedLeads
      ) {
        const lead =
          normalizeGeneratedLead(
            rawLead
          );

        if (!isRealLead(lead)) {
          continue;
        }

        const identityKey =
          getLeadIdentityKey(
            lead
          );

        if (
          !identityKey ||
          seenKeys.has(
            identityKey
          )
        ) {
          continue;
        }

        seenKeys.add(
          identityKey
        );

        uniqueLeads.push(
          lead
        );
      }

      if (
        uniqueLeads.length
      ) {
        const campaign =
          persistGeneratedCampaign({
            workspaceId,
            requestedBy,
            niche,
            location,
            leads:
              uniqueLeads,
            runId,
          });

        for (
          const lead
          of campaign.leads
        ) {
          refs.push({
            campaignId:
              campaign.id,
            leadId:
              lead.id,
            lead,
            source:
              "generated",
            priority:
              getLeadPriority(
                lead
              ),
            dueAt: 0,
            createdAt:
              Date.parse(
                lead.createdAt ||
                  campaign.createdAt
              ),
          });
        }

        remaining =
          Math.max(
            0,
            shortage -
              refs.length
          );
      }

      combinationIndex += 1;

      if (
        combinationIndex >=
          config.niches.length *
            config.locations.length *
            3 &&
        refs.length === 0
      ) {
        break;
      }

      if (
        combinationIndex >=
          config.niches.length *
            config.locations.length *
            10
      ) {
        break;
      }
    }

    return refs.slice(
      0,
      shortage
    );
  }

  function persistGeneratedCampaign({
    workspaceId,
    requestedBy,
    niche,
    location,
    leads,
    runId,
  }) {
    const now =
      new Date().toISOString();

    const campaign = {
      id:
        crypto.randomUUID(),
      workspaceId,
      userId:
        requestedBy,
      ownerId:
        requestedBy,
      createdBy:
        requestedBy,
      name:
        `Automatic ${niche} leads · ${location} · ${now.slice(0, 10)}`,
      niche,
      location,
      source:
        "google-places",
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
        leads.length,
      leads:
        leads.map(
          (lead) => ({
            ...lead,
            id:
              lead.id ||
              crypto.randomUUID(),
            workspaceId,
            source:
              lead.source ||
              "google-places",
            provider:
              lead.provider ||
              "google-places",
            status:
              lead.status ||
              "new",
            queueStatus:
              lead.queueStatus ||
              "ready",
            assignedTo: "",
            assigneeId: "",
            assignedAt: "",
            createdAt:
              lead.createdAt ||
              now,
            updatedAt:
              now,
          })
        ),
      createdAt:
        now,
      updatedAt:
        now,
    };

    store.update((draft) => {
      ensureCollections(draft);

      draft.campaigns.push(
        campaign
      );
    });

    return campaign;
  }

  /* ========================================================================
     Assignment
     ======================================================================== */

  function assignLeadRefsToCallers({
    workspaceId,
    dateKey,
    requestedBy,
    callerPlans,
    leadRefs,
    runId,
  }) {
    const now =
      new Date().toISOString();

    const assignedByCaller = {};
    const assignedRefs = [];

    let leadIndex = 0;
    let reusedCount = 0;

    store.update((draft) => {
      ensureCollections(draft);

      for (
        const plan
        of callerPlans
      ) {
        assignedByCaller[
          plan.caller.id
        ] = 0;

        let callerAssigned = 0;

        while (
          callerAssigned <
            plan.shortage &&
          leadIndex <
            leadRefs.length
        ) {
          const ref =
            leadRefs[
              leadIndex
            ];

          leadIndex += 1;

          const campaign =
            draft.campaigns.find(
              (item) =>
                item.id ===
                ref.campaignId
            );

          const lead =
            campaign?.leads?.find(
              (item) =>
                item.id ===
                ref.leadId
            );

          if (!campaign || !lead) {
            continue;
          }

          if (
            hasActiveAssignment({
              draft,
              workspaceId,
              campaignId:
                campaign.id,
              leadId:
                lead.id,
              dateKey,
            })
          ) {
            continue;
          }

          const assignmentId =
            crypto.randomUUID();

          const previousAssignee =
            lead.assignedTo ||
            lead.assigneeId ||
            "";

          lead.assignedTo =
            plan.caller.id;

          lead.assigneeId =
            plan.caller.id;

          lead.assignedToName =
            plan.caller.name ||
            plan.caller.email ||
            "Caller";

          lead.assignedBy =
            requestedBy;

          lead.assignedAt =
            now;

          lead.lastAssignedAt =
            now;

          lead.assignmentId =
            assignmentId;

          lead.dailyQueueDate =
            dateKey;

          lead.dailyLeadRunId =
            runId;

          lead.status =
            normalizeAssignableStatus(
              lead.status
            );

          lead.queueStatus =
            "ready";

          lead.nextActionAt =
            now;

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
              previousAssignee
                ? "lead_reassigned"
                : "lead_assigned",
            actorId:
              requestedBy,
            assignedTo:
              plan.caller.id,
            previousAssignee,
            dailyLeadRunId:
              runId,
            createdAt:
              now,
          });

          const assignment = {
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
              plan.caller.id,
            assignedTo:
              plan.caller.id,
            assigneeId:
              plan.caller.id,
            assignedBy:
              requestedBy,
            status:
              "assigned",
            queueStatus:
              "ready",
            priority:
              getLeadPriority(
                lead
              ),
            assignmentDate:
              dateKey,
            dailyQueueDate:
              dateKey,
            dailyLeadRunId:
              runId,
            nextActionAt:
              now,
            source:
              ref.source,
            createdAt:
              now,
            updatedAt:
              now,
          };

          draft.salesAssignments.push(
            assignment
          );

          draft.teamTasks.push({
            id:
              crypto.randomUUID(),
            workspaceId,
            campaignId:
              campaign.id,
            leadId:
              lead.id,
            assignmentId,
            title:
              `Call ${
                lead.name ||
                lead.business ||
                "assigned lead"
              }`,
            description:
              "Review the mini audit, call the lead, record the outcome and schedule the next action when required.",
            type:
              "lead_call",
            status:
              "pending",
            priority:
              assignment.priority,
            assignedTo:
              plan.caller.id,
            assignedToUserId:
              plan.caller.id,
            createdBy:
              requestedBy,
            dueAt:
              now,
            dailyQueueDate:
              dateKey,
            dailyLeadRunId:
              runId,
            createdAt:
              now,
            updatedAt:
              now,
          });

          callerAssigned += 1;

          assignedByCaller[
            plan.caller.id
          ] += 1;

          if (
            ref.source ===
            "existing"
          ) {
            reusedCount += 1;
          }

          assignedRefs.push({
            campaignId:
              campaign.id,
            leadId:
              lead.id,
            assignmentId,
            callerId:
              plan.caller.id,
            lead: {
              ...lead,
            },
          });
        }

        plan.assigned =
          callerAssigned;
      }
    });

    return {
      assignedCount:
        assignedRefs.length,
      reusedCount,
      assignedByCaller,
      assignedRefs,
    };
  }

  function queueMiniAudits({
    assignedRefs,
  }) {
    if (
      !leadAuditService ||
      !assignedRefs.length
    ) {
      return;
    }

    const auditCandidates =
      assignedRefs
        .filter(
          (ref) =>
            Boolean(
              ref.lead.website ||
              ref.lead.websiteUri
            )
        )
        .slice(0, 500);

    for (
      const ref
      of auditCandidates
    ) {
      Promise.resolve()
        .then(() => {
          if (
            typeof leadAuditService
              .queueMiniAudit ===
            "function"
          ) {
            return leadAuditService
              .queueMiniAudit(
                getSystemUser(
                  ref.callerId
                ),
                {
                  campaignId:
                    ref.campaignId,
                  leadId:
                    ref.leadId,
                  website:
                    ref.lead.website ||
                    ref.lead.websiteUri,
                  businessName:
                    ref.lead.name ||
                    ref.lead.business ||
                    "",
                  source:
                    "daily-lead-automation",
                }
              );
          }

          return null;
        })
        .catch((error) => {
          console.warn(
            `[daily-leads] mini audit queue failed ${JSON.stringify({
              campaignId:
                ref.campaignId,
              leadId:
                ref.leadId,
              error:
                error.message,
            })}`
          );
        });
    }
  }

  function getSystemUser(
    preferredUserId
  ) {
    const state =
      store.read();

    return (
      state.users.find(
        (user) =>
          user.id ===
          preferredUserId
      ) ||
      state.users.find(
        (user) =>
          normalizeRole(
            user.workspaceRole ||
              user.role
          ) ===
          "manager"
      ) ||
      state.users[0] ||
      {
        id: "system",
        role: "manager",
        workspaceRole:
          "manager",
      }
    );
  }
}

/* ==========================================================================
   Workspace and caller helpers
   ========================================================================== */

function getActiveWorkspaceIds(
  state
) {
  const workspaceIds =
    new Set();

  for (
    const workspace
    of state.workspaces || []
  ) {
    if (
      workspace?.id &&
      workspace.active !== false &&
      workspace.isActive !== false &&
      normalizeStatus(
        workspace.status
      ) !== "inactive"
    ) {
      workspaceIds.add(
        workspace.id
      );
    }
  }

  for (
    const user
    of state.users || []
  ) {
    if (
      user?.workspaceId &&
      user.active !== false &&
      user.isActive !== false
    ) {
      workspaceIds.add(
        user.workspaceId
      );
    }
  }

  return [
    ...workspaceIds,
  ];
}

function getWorkspaceContext(
  workspaceService,
  user,
  state
) {
  const context =
    workspaceService.getContext(
      user,
      state
    );

  if (
    !context?.workspaceId
  ) {
    throw httpError(
      400,
      "Workspace context could not be resolved."
    );
  }

  return context;
}

function getActiveCallers({
  state,
  workspaceId,
  workspaceService,
}) {
  const members = [];

  try {
    const manager =
      (state.users || []).find(
        (user) =>
          user.workspaceId ===
            workspaceId &&
          [
            "manager",
            "owner",
            "admin",
          ].includes(
            normalizeRole(
              user.workspaceRole ||
                user.role
            )
          )
      );

    if (
      manager &&
      typeof workspaceService
        .listMembers ===
        "function"
    ) {
      members.push(
        ...(
          workspaceService.listMembers(
            manager
          ) || []
        )
      );
    }
  } catch {
    // Fall back to state.users.
  }

  if (!members.length) {
    members.push(
      ...(
        state.users || []
      ).filter(
        (user) =>
          user.workspaceId ===
          workspaceId
      )
    );
  }

  const byId =
    new Map();

  for (
    const member
    of members
  ) {
    if (!member?.id) {
      continue;
    }

    byId.set(
      member.id,
      member
    );
  }

  return [
    ...byId.values(),
  ].filter(
    (member) =>
      normalizeRole(
        member.workspaceRole ||
          member.role
      ) === "caller" &&
      member.active !== false &&
      member.isActive !== false &&
      normalizeStatus(
        member.status
      ) !== "inactive"
  );
}

function requireManager(
  context
) {
  const role =
    normalizeRole(
      context?.role ||
      context?.user
        ?.workspaceRole ||
      context?.user?.role
    );

  if (
    ![
      "owner",
      "admin",
      "manager",
    ].includes(role)
  ) {
    throw httpError(
      403,
      "Manager access is required."
    );
  }
}

/* ==========================================================================
   Assignment helpers
   ========================================================================== */

function countActiveAssignmentsForCaller({
  state,
  workspaceId,
  callerId,
  dateKey,
}) {
  const assignments =
    getAssignments(state);

  const uniqueLeadIds =
    new Set();

  for (
    const assignment
    of assignments
  ) {
    if (
      assignment.workspaceId !==
        workspaceId ||
      (
        assignment.assignedTo !==
          callerId &&
        assignment.assigneeId !==
          callerId &&
        assignment.userId !==
          callerId
      )
    ) {
      continue;
    }

    const status =
      normalizeStatus(
        assignment.status ||
          assignment.queueStatus
      );

    if (
      TERMINAL_LEAD_STATUSES.has(
        status
      ) ||
      [
        "cancelled",
        "unassigned",
        "archived",
      ].includes(status)
    ) {
      continue;
    }

    const assignmentDate =
      assignment.assignmentDate ||
      assignment.dailyQueueDate ||
      String(
        assignment.assignedAt ||
          assignment.createdAt ||
          ""
      ).slice(0, 10);

    if (
      assignmentDate !==
      dateKey
    ) {
      continue;
    }

    if (
      assignment.leadId
    ) {
      uniqueLeadIds.add(
        assignment.leadId
      );
    }
  }

  return uniqueLeadIds.size;
}

function collectActiveAssignmentKeys({
  state,
  workspaceId,
}) {
  const keys =
    new Set();

  for (
    const assignment
    of getAssignments(state)
  ) {
    if (
      assignment.workspaceId !==
      workspaceId
    ) {
      continue;
    }

    const status =
      normalizeStatus(
        assignment.status ||
          assignment.queueStatus
      );

    if (
      TERMINAL_LEAD_STATUSES.has(
        status
      ) ||
      [
        "cancelled",
        "unassigned",
        "archived",
      ].includes(status)
    ) {
      continue;
    }

    if (
      assignment.campaignId &&
      assignment.leadId
    ) {
      keys.add(
        `${assignment.campaignId}:${assignment.leadId}`
      );
    }
  }

  return keys;
}

function hasActiveAssignment({
  draft,
  workspaceId,
  campaignId,
  leadId,
  dateKey,
}) {
  return getAssignments(
    draft
  ).some(
    (assignment) => {
      if (
        assignment.workspaceId !==
          workspaceId ||
        assignment.campaignId !==
          campaignId ||
        assignment.leadId !==
          leadId
      ) {
        return false;
      }

      const status =
        normalizeStatus(
          assignment.status ||
            assignment.queueStatus
        );

      if (
        TERMINAL_LEAD_STATUSES.has(
          status
        ) ||
        [
          "cancelled",
          "unassigned",
          "archived",
        ].includes(status)
      ) {
        return false;
      }

      const assignmentDate =
        assignment.assignmentDate ||
        assignment.dailyQueueDate ||
        String(
          assignment.createdAt ||
            ""
        ).slice(0, 10);

      return (
        assignmentDate ===
        dateKey
      );
    }
  );
}

function getAssignments(
  state
) {
  if (
    Array.isArray(
      state.salesAssignments
    )
  ) {
    return state
      .salesAssignments;
  }

  if (
    Array.isArray(
      state.leadAssignments
    )
  ) {
    return state
      .leadAssignments;
  }

  return [];
}

/* ==========================================================================
   Lead helpers
   ========================================================================== */

function isRealLead(
  lead
) {
  if (!lead) {
    return false;
  }

  const source =
    normalizeStatus(
      lead.source ||
        lead.provider
    );

  if (
    [
      "test_seed",
      "seed",
      "synthetic_seed",
      "demo_seed",
    ].includes(source)
  ) {
    return false;
  }

  const name =
    String(
      lead.name ||
        lead.business ||
        ""
    )
      .trim()
      .toLowerCase();

  if (
    !name ||
    name.includes(
      "seed business"
    )
  ) {
    return false;
  }

  return Boolean(
    lead.placeId ||
    lead.phone ||
    lead.nationalPhoneNumber ||
    lead.internationalPhoneNumber ||
    lead.website ||
    lead.websiteUri ||
    lead.email ||
    lead.address ||
    lead.formattedAddress
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
      "seed",
      "synthetic_seed",
      "demo_seed",
    ].includes(source)
  ) {
    return true;
  }

  if (
    campaign?.automaticSeed ===
      true ||
    campaign?.seeded ===
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
      "daily calling queue"
    )
  );
}

function normalizeGeneratedLead(
  raw
) {
  const now =
    new Date().toISOString();

  return {
    ...raw,

    id:
      raw?.id ||
      crypto.randomUUID(),

    placeId:
      raw?.placeId ||
      raw?.googlePlaceId ||
      "",

    name:
      raw?.name ||
      raw?.business ||
      raw?.displayName ||
      "Google business",

    business:
      raw?.business ||
      raw?.name ||
      raw?.displayName ||
      "Google business",

    address:
      raw?.address ||
      raw?.formattedAddress ||
      "",

    formattedAddress:
      raw?.formattedAddress ||
      raw?.address ||
      "",

    phone:
      raw?.phone ||
      raw?.internationalPhoneNumber ||
      raw?.nationalPhoneNumber ||
      "",

    website:
      raw?.website ||
      raw?.websiteUri ||
      "",

    websiteUri:
      raw?.websiteUri ||
      raw?.website ||
      "",

    source:
      "google-places",

    provider:
      "google-places",

    status:
      "new",

    queueStatus:
      "ready",

    assignedTo: "",
    assigneeId: "",

    callAttempts:
      Number(
        raw?.callAttempts || 0
      ),

    createdAt:
      raw?.createdAt ||
      now,

    updatedAt:
      now,
  };
}

function collectExistingLeadIdentityKeys(
  state,
  workspaceId
) {
  const keys =
    new Set();

  for (
    const campaign
    of state.campaigns || []
  ) {
    if (
      campaign.workspaceId !==
      workspaceId
    ) {
      continue;
    }

    for (
      const lead
      of campaign.leads || []
    ) {
      const key =
        getLeadIdentityKey(
          lead
        );

      if (key) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function getLeadIdentityKey(
  lead
) {
  const placeId =
    clean(
      lead?.placeId ||
        lead?.googlePlaceId
    ).toLowerCase();

  if (placeId) {
    return `place:${placeId}`;
  }

  const website =
    normalizeWebsite(
      lead?.website ||
        lead?.websiteUri
    );

  if (website) {
    return `website:${website}`;
  }

  const phone =
    normalizePhone(
      lead?.phone ||
        lead?.internationalPhoneNumber ||
        lead?.nationalPhoneNumber
    );

  if (phone) {
    return `phone:${phone}`;
  }

  const name =
    clean(
      lead?.name ||
        lead?.business
    ).toLowerCase();

  const address =
    clean(
      lead?.address ||
        lead?.formattedAddress
    ).toLowerCase();

  if (name && address) {
    return `name-address:${name}|${address}`;
  }

  return "";
}

function deduplicateLeadRefs(
  refs
) {
  const seen =
    new Set();

  const result = [];

  for (
    const ref
    of refs
  ) {
    const identity =
      getLeadIdentityKey(
        ref.lead
      ) ||
      `${ref.campaignId}:${ref.leadId}`;

    if (
      seen.has(identity)
    ) {
      continue;
    }

    seen.add(identity);
    result.push(ref);
  }

  return result;
}

function compareLeadRefs(
  left,
  right
) {
  if (
    left.dueAt &&
    right.dueAt &&
    left.dueAt !==
      right.dueAt
  ) {
    return (
      left.dueAt -
      right.dueAt
    );
  }

  if (
    left.priority !==
    right.priority
  ) {
    return (
      right.priority -
      left.priority
    );
  }

  return (
    left.createdAt -
    right.createdAt
  );
}

function getLeadPriority(
  lead
) {
  const value =
    String(
      lead?.priority ||
        ""
    ).toLowerCase();

  if (value === "urgent") {
    return 4;
  }

  if (value === "high") {
    return 3;
  }

  if (value === "low") {
    return 1;
  }

  const score =
    Number(
      lead?.qualityScore ||
        lead?.score ||
        0
    );

  if (score >= 85) {
    return 3;
  }

  if (score >= 60) {
    return 2;
  }

  return 1;
}

function normalizeAssignableStatus(
  value
) {
  const status =
    normalizeStatus(value);

  if (
    !status ||
    TERMINAL_LEAD_STATUSES.has(
      status
    )
  ) {
    return "assigned";
  }

  if (
    RETRYABLE_LEAD_STATUSES.has(
      status
    )
  ) {
    return status === "new"
      ? "assigned"
      : status;
  }

  return "assigned";
}

/* ==========================================================================
   Run helpers
   ========================================================================== */

function getTodayRun(
  state,
  workspaceId,
  dateKey
) {
  return (
    (state.dailyLeadRuns || [])
      .filter(
        (run) =>
          run.workspaceId ===
            workspaceId &&
          run.dateKey ===
            dateKey &&
          normalizeStatus(
            run.status
          ) !== "superseded"
      )
      .sort(
        (left, right) =>
          Date.parse(
            right.createdAt || 0
          ) -
          Date.parse(
            left.createdAt || 0
          )
      )[0] || null
  );
}

/* ==========================================================================
   Scheduler date helpers
   ========================================================================== */

function calculateNextRunAt(
  config
) {
  const now =
    new Date();

  const current =
    getZonedDateParts(
      now,
      config.timezone
    );

  let dateKey =
    [
      current.year,
      String(
        current.month
      ).padStart(2, "0"),
      String(
        current.day
      ).padStart(2, "0"),
    ].join("-");

  const scheduledPassed =
    current.hour >
      config.assignmentHour ||
    (
      current.hour ===
        config.assignmentHour &&
      current.minute >=
        config.assignmentMinute
    );

  if (scheduledPassed) {
    dateKey =
      addDaysToDateKey(
        dateKey,
        1
      );
  }

  return zonedDateTimeToUtc({
    dateKey,
    hour:
      config.assignmentHour,
    minute:
      config.assignmentMinute,
    timeZone:
      config.timezone,
  });
}

function getDateKey(
  date,
  timeZone
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
    ).padStart(2, "0"),
    String(
      parts.day
    ).padStart(2, "0"),
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
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }
    ).formatToParts(date);

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
      Number(values.year),
    month:
      Number(values.month),
    day:
      Number(values.day),
    hour:
      Number(values.hour),
    minute:
      Number(values.minute),
    second:
      Number(values.second),
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
  ] = dateKey
    .split("-")
    .map(Number);

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
    const parts =
      getZonedDateParts(
        estimate,
        timeZone
      );

    const represented =
      Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
      );

    const expected =
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
          expected -
          represented
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
  ] = dateKey
    .split("-")
    .map(Number);

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day + days
    )
  )
    .toISOString()
    .slice(0, 10);
}

/* ==========================================================================
   State and configuration
   ========================================================================== */

function ensureCollections(
  state
) {
  const collections = [
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
    "activity",
  ];

  for (
    const key
    of collections
  ) {
    if (
      !Array.isArray(
        state[key]
      )
    ) {
      state[key] = [];
    }
  }

  state.workspaceSettings =
    isPlainObject(
      state.workspaceSettings
    )
      ? state.workspaceSettings
      : {};
}

function normalizeConfig(
  input
) {
  return {
    enabled:
      Boolean(
        input.enabled
      ),

    leadsPerCaller:
      clampInteger(
        input.leadsPerCaller,
        100,
        1,
        1000
      ),

    timezone:
      clean(
        input.timezone
      ) ||
      "Asia/Karachi",

    assignmentHour:
      clampInteger(
        input.assignmentHour,
        0,
        0,
        23
      ),

    assignmentMinute:
      clampInteger(
        input.assignmentMinute,
        0,
        0,
        59
      ),

    startupDelayMs:
      clampInteger(
        input.startupDelayMs,
        15_000,
        0,
        10 * 60_000
      ),

    recycleAfterHours:
      clampInteger(
        input.recycleAfterHours,
        24,
        1,
        24 * 365
      ),

    maxCallAttempts:
      clampInteger(
        input.maxCallAttempts,
        5,
        1,
        100
      ),

    maxGenerationPerRun:
      clampInteger(
        input.maxGenerationPerRun,
        2000,
        1,
        20_000
      ),

    generationBatchSize:
      clampInteger(
        input.generationBatchSize,
        200,
        1,
        1000
      ),

    niches:
      normalizeStringArray(
        input.niches
      ),

    locations:
      normalizeStringArray(
        input.locations
      ),

    regionCode:
      clean(
        input.regionCode
      ) ||
      "US",

    radiusKm:
      clampInteger(
        input.radiusKm,
        50,
        1,
        500
      ),

    qualityLevel:
      clean(
        input.qualityLevel
      ) ||
      "balanced",

    autoMiniAudit:
      input.autoMiniAudit !==
      false,

    staleRunMinutes:
      clampInteger(
        input.staleRunMinutes,
        30,
        5,
        24 * 60
      ),
  };
}

/* ==========================================================================
   General utilities
   ========================================================================== */

function splitCsv(
  value
) {
  return String(
    value || ""
  )
    .split(",")
    .map(
      (item) =>
        item.trim()
    )
    .filter(Boolean);
}

function normalizeStringArray(
  value
) {
  if (
    Array.isArray(value)
  ) {
    return [
      ...new Set(
        value
          .map(
            (item) =>
              clean(item)
          )
          .filter(Boolean)
      ),
    ];
  }

  return splitCsv(value);
}

function normalizeRole(
  value
) {
  const role =
    normalizeStatus(value);

  if (
    role.includes("owner")
  ) {
    return "owner";
  }

  if (
    role.includes("admin")
  ) {
    return "admin";
  }

  if (
    role.includes("manager")
  ) {
    return "manager";
  }

  if (
    role.includes("caller")
  ) {
    return "caller";
  }

  return role;
}

function normalizeStatus(
  value
) {
  return clean(value)
    .toLowerCase()
    .replace(
      /[\s-]+/g,
      "_"
    );
}

function normalizePhone(
  value
) {
  return String(
    value || ""
  ).replace(
    /\D/g,
    ""
  );
}

function normalizeWebsite(
  value
) {
  const raw =
    clean(value);

  if (!raw) {
    return "";
  }

  try {
    const url =
      new URL(
        raw.startsWith("http")
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

function clean(
  value
) {
  return String(
    value ?? ""
  ).trim();
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

function envInteger(
  name,
  fallback,
  minimum,
  maximum
) {
  return clampInteger(
    process.env[name],
    fallback,
    minimum,
    maximum
  );
}

function envFlag(
  name,
  fallback = false
) {
  const value =
    clean(
      process.env[name]
    ).toLowerCase();

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

function isPlainObject(
  value
) {
  return Boolean(
    value &&
    typeof value ===
      "object" &&
    !Array.isArray(value)
  );
}

function removeUndefined(
  value
) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([, item]) =>
          item !== undefined
      )
  );
}

function httpError(
  statusCode,
  message,
  code = ""
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  if (code) {
    error.code = code;
  }

  return error;
}