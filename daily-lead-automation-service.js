import crypto from "node:crypto";

/**
 * Automatic daily lead generation and caller queue allocation.
 *
 * Daily sequence:
 * 1. Release due missed/follow-up leads.
 * 2. Reuse eligible previously stored leads.
 * 3. Reuse unassigned leads.
 * 4. Generate only the remaining shortfall through Google Places.
 * 5. Assign exactly DAILY_LEADS_PER_CALLER eligible leads to each active caller
 *    when enough usable leads are available.
 * 6. Queue mini audits for newly assigned website leads.
 *
 * The service is idempotent per workspace/date. A second invocation on the
 * same date returns the existing run unless force=true.
 */
export function createDailyLeadAutomationService({
  store,
  workspaceService,
  leadFinder,
  leadAuditService = null,
  emit = null,
}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createDailyLeadAutomationService requires a store exposing read() and update()."
    );
  }

  if (!leadFinder?.findLeads) {
    throw new Error(
      "createDailyLeadAutomationService requires leadFinder.findLeads()."
    );
  }

  const runningWorkspaces = new Map();

  function getConfig(workspaceId, stateOverride = null) {
    const state = stateOverride || store.read();

    const stored =
      state.workspaceSettings?.[workspaceId]
        ?.dailyLeadAutomation || {};

    return {
      enabled:
        stored.enabled ??
        envFlag(
          "DAILY_LEAD_AUTOMATION_ENABLED",
          false
        ),

      leadsPerCaller:
        positiveInteger(
          stored.leadsPerCaller ??
          process.env.DAILY_LEADS_PER_CALLER,
          100,
          1,
          5000
        ),

      maxGenerationPerRun:
        positiveInteger(
          stored.maxGenerationPerRun ??
          process.env.DAILY_LEAD_MAX_GENERATION_PER_RUN,
          10000,
          1,
          50000
        ),

      generationBatchSize:
        positiveInteger(
          stored.generationBatchSize ??
          process.env.DAILY_LEAD_GENERATION_BATCH_SIZE,
          200,
          20,
          1000
        ),

      minimumQualityScore:
        positiveInteger(
          stored.minimumQualityScore ??
          process.env.DAILY_LEAD_MIN_QUALITY_SCORE,
          0,
          0,
          100
        ),

      recycleAfterHours:
        positiveInteger(
          stored.recycleAfterHours ??
          process.env.DAILY_LEAD_RECYCLE_AFTER_HOURS,
          24,
          1,
          720
        ),

      maxCallAttempts:
        positiveInteger(
          stored.maxCallAttempts ??
          process.env.DAILY_LEAD_MAX_CALL_ATTEMPTS,
          5,
          1,
          20
        ),

      niches:
        normalizeStringList(
          stored.niches ??
          process.env.DAILY_LEAD_NICHES ??
          ""
        ),

      locations:
        normalizeStringList(
          stored.locations ??
          process.env.DAILY_LEAD_LOCATIONS ??
          ""
        ),

      regionCode:
        clean(
          stored.regionCode ??
          process.env.DAILY_LEAD_REGION_CODE ??
          "US"
        ).toUpperCase(),

      radiusKm:
        positiveInteger(
          stored.radiusKm ??
          process.env.DAILY_LEAD_RADIUS_KM,
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

      autoMiniAudit:
        stored.autoMiniAudit ??
        envFlag(
          "DAILY_LEAD_AUTO_MINI_AUDIT",
          true
        ),

      timezone:
        clean(
          stored.timezone ??
          process.env.DAILY_LEAD_TIMEZONE ??
          "UTC"
        ) || "UTC",
    };
  }

  function saveConfig(user, input = {}) {
    const ctx = requireManager(user);
    const current = getConfig(ctx.workspaceId);

    const next = {
      ...current,

      enabled:
        input.enabled !== undefined
          ? Boolean(input.enabled)
          : current.enabled,

      leadsPerCaller:
        positiveInteger(
          input.leadsPerCaller,
          current.leadsPerCaller,
          1,
          5000
        ),

      maxGenerationPerRun:
        positiveInteger(
          input.maxGenerationPerRun,
          current.maxGenerationPerRun,
          1,
          50000
        ),

      generationBatchSize:
        positiveInteger(
          input.generationBatchSize,
          current.generationBatchSize,
          20,
          1000
        ),

      minimumQualityScore:
        positiveInteger(
          input.minimumQualityScore,
          current.minimumQualityScore,
          0,
          100
        ),

      recycleAfterHours:
        positiveInteger(
          input.recycleAfterHours,
          current.recycleAfterHours,
          1,
          720
        ),

      maxCallAttempts:
        positiveInteger(
          input.maxCallAttempts,
          current.maxCallAttempts,
          1,
          20
        ),

      niches:
        normalizeStringList(
          input.niches ?? current.niches
        ),

      locations:
        normalizeStringList(
          input.locations ?? current.locations
        ),

      regionCode:
        clean(
          input.regionCode ??
          current.regionCode
        ).toUpperCase(),

      radiusKm:
        positiveInteger(
          input.radiusKm,
          current.radiusKm,
          1,
          500
        ),

      qualityLevel:
        clean(
          input.qualityLevel ??
          current.qualityLevel
        ) || "balanced",

      autoMiniAudit:
        input.autoMiniAudit !== undefined
          ? Boolean(input.autoMiniAudit)
          : current.autoMiniAudit,

      timezone:
        clean(
          input.timezone ??
          current.timezone
        ) || "UTC",

      updatedAt:
        new Date().toISOString(),

      updatedBy:
        user.id,
    };

    store.update((draft) => {
      draft.workspaceSettings =
        draft.workspaceSettings || {};

      draft.workspaceSettings[
        ctx.workspaceId
      ] =
        draft.workspaceSettings[
          ctx.workspaceId
        ] || {};

      draft.workspaceSettings[
        ctx.workspaceId
      ].dailyLeadAutomation =
        next;
    });

    return {
      ok: true,
      config: next,
    };
  }

  async function runAllWorkspaces({
    force = false,
    source = "scheduler",
  } = {}) {
    const state = store.read();

    const workspaceIds = uniqueStrings([
      ...(state.workspaces || [])
        .filter(
          (workspace) =>
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
      const config = getConfig(
        workspaceId,
        state
      );

      if (!config.enabled) {
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
    {
      force = false,
    } = {}
  ) {
    const ctx = requireManager(user);

    return runWorkspace({
      workspaceId:
        ctx.workspaceId,
      force,
      source:
        "manual",
      requestedBy:
        user.id,
    });
  }

  async function runWorkspace({
    workspaceId,
    force = false,
    source = "scheduler",
    requestedBy = "",
  }) {
    if (!workspaceId) {
      throw httpError(
        400,
        "workspaceId is required."
      );
    }

    if (
      runningWorkspaces.has(
        workspaceId
      )
    ) {
      return runningWorkspaces.get(
        workspaceId
      );
    }

    const promise =
      performWorkspaceRun({
        workspaceId,
        force,
        source,
        requestedBy,
      }).finally(() => {
        runningWorkspaces.delete(
          workspaceId
        );
      });

    runningWorkspaces.set(
      workspaceId,
      promise
    );

    return promise;
  }

  async function performWorkspaceRun({
    workspaceId,
    force,
    source,
    requestedBy,
  }) {
    const initialState = store.read();
    const config = getConfig(
      workspaceId,
      initialState
    );

    if (!config.enabled && source !== "manual") {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        reason:
          "Daily lead automation is disabled.",
      };
    }

    if (
      !config.niches.length ||
      !config.locations.length
    ) {
      throw httpError(
        400,
        "Configure at least one niche and one location before running daily lead automation."
      );
    }

    const dateKey =
      getDateKey(
        new Date(),
        config.timezone
      );

    const existingRun =
      (
        initialState.dailyLeadRuns ||
        []
      ).find(
        (run) =>
          run.workspaceId ===
            workspaceId &&
          run.dateKey ===
            dateKey &&
          [
            "running",
            "completed",
            "completed_partial",
          ].includes(
            run.status
          )
      );

    if (
      existingRun &&
      !force
    ) {
      return {
        ok: true,
        skipped: true,
        workspaceId,
        run:
          publicRun(
            existingRun
          ),
        reason:
          "Today's automatic allocation has already run.",
      };
    }

    const callers =
      listActiveCallers(
        initialState,
        workspaceId
      );

    if (!callers.length) {
      throw httpError(
        409,
        "No active callers were found in this workspace."
      );
    }

    /*
     * Each caller may now have an individual limit configured from the
     * manager resource board. The workspace-level leadsPerCaller value
     * remains the fallback for callers without a custom setting.
     */
    const callerTargets =
      new Map(
        callers.map(
          (caller) => [
            caller.id,
            getCallerLeadLimit(
              initialState,
              workspaceId,
              caller,
              config.leadsPerCaller
            ),
          ]
        )
      );

    const totalTargetCount =
      [...callerTargets.values()]
        .reduce(
          (sum, value) =>
            sum + value,
          0
        );

    const now =
      new Date().toISOString();

    const run = {
      id:
        crypto.randomUUID(),
      workspaceId,
      dateKey,
      source,
      requestedBy,
      status:
        "running",
      callerCount:
        callers.length,
      leadsPerCaller:
        config.leadsPerCaller,
      resourceTargets:
        Object.fromEntries(
          callerTargets
        ),
      targetCount:
        totalTargetCount,
      recycledCount:
        0,
      reusedCount:
        0,
      generatedCount:
        0,
      assignedCount:
        0,
      auditQueuedCount:
        0,
      shortfall:
        0,
      errors: [],
      startedAt:
        now,
      completedAt:
        "",
      createdAt:
        now,
      updatedAt:
        now,
    };

    store.update((draft) => {
      draft.dailyLeadRuns =
        Array.isArray(
          draft.dailyLeadRuns
        )
          ? draft.dailyLeadRuns
          : [];

      draft.dailyLeadRuns.unshift(
        run
      );
    });

    emitEvent(
      workspaceId,
      "daily-leads:run-started",
      {
        run:
          publicRun(run),
      }
    );

    try {
      releaseDueLeads({
        workspaceId,
        config,
      });

      let state =
        store.read();

      const activeCounts =
        countCurrentDailyWorkload(
          state,
          workspaceId,
          callers,
          dateKey
        );

      const callerNeeds =
        new Map(
          callers.map(
            (caller) => [
              caller.id,
              Math.max(
                0,
                (
                  callerTargets.get(
                    caller.id
                  ) ||
                  config.leadsPerCaller
                ) -
                (
                  activeCounts.get(
                    caller.id
                  ) || 0
                )
              ),
            ]
          )
        );

      const totalNeeded =
        [...callerNeeds.values()]
          .reduce(
            (sum, value) =>
              sum + value,
            0
          );

      if (!totalNeeded) {
        finishRun(
          run.id,
          {
            status:
              "completed",
            assignedCount:
              0,
            shortfall:
              0,
          }
        );

        return {
          ok: true,
          workspaceId,
          run:
            publicRun(
              getRun(
                run.id
              )
            ),
        };
      }

      const reusable =
        collectReusableLeadRefs(
          state,
          {
            workspaceId,
            config,
            dateKey,
          }
        );

      const selected = reusable.slice(
        0,
        totalNeeded
      );

      const generatedNeeded =
        Math.min(
          Math.max(
            0,
            totalNeeded -
            selected.length
          ),
          config.maxGenerationPerRun
        );

      const generatedRefs =
        generatedNeeded
          ? await generateLeadShortfall({
              workspaceId,
              config,
              count:
                generatedNeeded,
              runId:
                run.id,
            })
          : [];

      const combinedRefs =
        dedupeLeadRefs([
          ...selected,
          ...generatedRefs,
        ]).slice(
          0,
          totalNeeded
        );

      const assignmentResult =
        assignDailyQueues({
          workspaceId,
          dateKey,
          callers,
          callerNeeds,
          leadRefs:
            combinedRefs,
          runId:
            run.id,
        });

      let auditQueuedCount =
        0;

      if (
        config.autoMiniAudit &&
        leadAuditService
      ) {
        auditQueuedCount =
          queueMiniAudits({
            workspaceId,
            assignmentResult,
            callers,
          });
      }

      finishRun(
        run.id,
        {
          status:
            assignmentResult.shortfall
              ? "completed_partial"
              : "completed",
          recycledCount:
            selected.filter(
              (ref) =>
                ref.recycled
            ).length,
          reusedCount:
            selected.length,
          generatedCount:
            generatedRefs.length,
          assignedCount:
            assignmentResult.assignedCount,
          auditQueuedCount,
          shortfall:
            assignmentResult.shortfall,
        }
      );

      const completed =
        getRun(
          run.id
        );

      emitEvent(
        workspaceId,
        "daily-leads:run-completed",
        {
          run:
            publicRun(
              completed
            ),
          callerQueues:
            assignmentResult
              .callerQueues,
        }
      );

      return {
        ok: true,
        workspaceId,
        run:
          publicRun(
            completed
          ),
        callerQueues:
          assignmentResult
            .callerQueues,
      };
    } catch (error) {
      finishRun(
        run.id,
        {
          status:
            "failed",
          errors: [
            error?.message ||
            String(error),
          ],
        }
      );

      emitEvent(
        workspaceId,
        "daily-leads:run-failed",
        {
          run:
            publicRun(
              getRun(
                run.id
              )
            ),
        }
      );

      throw error;
    }
  }

  function releaseDueLeads({
    workspaceId,
    config,
  }) {
    const now =
      Date.now();

    store.update((draft) => {
      for (
        const campaign
        of draft.campaigns ||
        []
      ) {
        if (
          !campaignBelongsToWorkspace(
            campaign,
            workspaceId
          )
        ) {
          continue;
        }

        for (
          const lead
          of campaign.leads ||
          []
        ) {
          const status =
            normalizeStatus(
              lead.status
            );

          if (
            ![
              "no_answer",
              "busy",
              "voicemail",
              "callback",
              "follow_up",
              "skipped",
            ].includes(
              status
            )
          ) {
            continue;
          }

          const attempts =
            Number(
              lead.callAttempts ||
              0
            );

          if (
            attempts >=
            config.maxCallAttempts &&
            ![
              "callback",
              "follow_up",
            ].includes(
              status
            )
          ) {
            lead.status =
              "exhausted";
            lead.queueStatus =
              "closed";
            lead.completedAt =
              lead.completedAt ||
              new Date()
                .toISOString();
            lead.completedReason =
              "maximum_attempts_reached";
            continue;
          }

          const nextAction =
            Date.parse(
              lead.nextActionAt ||
              lead.followUpAt ||
              lead.callbackAt ||
              0
            );

          const fallbackEligibleAt =
            Date.parse(
              lead.lastCallAt ||
              lead.updatedAt ||
              lead.assignedAt ||
              0
            ) +
            config.recycleAfterHours *
            60 *
            60 *
            1000;

          const eligibleAt =
            Number.isFinite(
              nextAction
            ) &&
            nextAction > 0
              ? nextAction
              : fallbackEligibleAt;

          if (
            eligibleAt <= now
          ) {
            lead.queueStatus =
              "ready";
            lead.dailyQueueDate =
              "";
            lead.dailyQueuePosition =
              null;
            lead.updatedAt =
              new Date()
                .toISOString();

            appendTimeline(
              lead,
              {
                type:
                  "queue_released",
                status,
                createdAt:
                  lead.updatedAt,
              }
            );
          }
        }
      }
    });
  }

  function collectReusableLeadRefs(
    state,
    {
      workspaceId,
      config,
      dateKey,
    }
  ) {
    const result = [];
    const seen =
      new Set();

    for (
      const campaign
      of state.campaigns ||
      []
    ) {
      if (
        !campaignBelongsToWorkspace(
          campaign,
          workspaceId
        )
      ) {
        continue;
      }

      for (
        const lead
        of campaign.leads ||
        []
      ) {
        const status =
          normalizeStatus(
            lead.status ||
            "new"
          );

        if (
          isClosedStatus(
            status
          )
        ) {
          continue;
        }

        if (
          Number(
            lead.callAttempts ||
              0
          ) >=
          config.maxCallAttempts &&
          ![
            "callback",
            "follow_up",
          ].includes(
            status
          )
        ) {
          continue;
        }

        const quality =
          Number(
            lead.qualityScore ||
              lead.confidence ||
              0
          );

        if (
          quality <
          config.minimumQualityScore
        ) {
          continue;
        }

        if (
          lead.dailyQueueDate ===
          dateKey
        ) {
          continue;
        }

        if (
          !isLeadEligibleNow(
            lead
          )
        ) {
          continue;
        }

        const key =
          leadIdentity(
            lead
          );

        if (
          !key ||
          seen.has(
            key
          )
        ) {
          continue;
        }

        seen.add(key);

        result.push({
          campaignId:
            campaign.id,
          leadId:
            lead.id,
          key,
          recycled:
            [
              "no_answer",
              "busy",
              "voicemail",
              "callback",
              "follow_up",
              "skipped",
            ].includes(
              status
            ),
          score:
            scoreLead(
              lead
            ),
        });
      }
    }

    return result.sort(
      (left, right) =>
        right.score -
        left.score
    );
  }

  async function generateLeadShortfall({
    workspaceId,
    config,
    count,
    runId,
  }) {
    const generated = [];
    const seen =
      new Set();

    const queryPairs =
      buildQueryPairs(
        config.niches,
        config.locations
      );

    let queryIndex = 0;

    while (
      generated.length <
        count &&
      queryIndex <
        queryPairs.length *
        4
    ) {
      const pair =
        queryPairs[
          queryIndex %
          queryPairs.length
        ];

      const remaining =
        count -
        generated.length;

      const batchSize =
        Math.min(
          config.generationBatchSize,
          remaining
        );

      const result =
        await leadFinder.findLeads({
          runId:
            `${runId}-${queryIndex + 1}`,
          niche:
            pair.niche,
          location:
            pair.location,
          limit:
            batchSize,
          radiusKm:
            config.radiusKm,
          qualityLevel:
            config.qualityLevel,
          regionCode:
            config.regionCode,
          exact:
            false,
        });

      const accepted =
        [];

      for (
        const rawLead
        of result?.leads ||
        []
      ) {
        const lead =
          normalizeGeneratedLead(
            rawLead
          );

        const key =
          leadIdentity(
            lead
          );

        if (
          !key ||
          seen.has(
            key
          ) ||
          leadExistsInWorkspace(
            store.read(),
            workspaceId,
            key
          )
        ) {
          continue;
        }

        seen.add(key);
        accepted.push(lead);
      }

      if (accepted.length) {
        const campaignId =
          saveGeneratedCampaign({
            workspaceId,
            pair,
            leads:
              accepted,
            runId,
          });

        for (
          const lead
          of accepted
        ) {
          generated.push({
            campaignId,
            leadId:
              lead.id,
            key:
              leadIdentity(
                lead
              ),
            recycled:
              false,
            score:
              scoreLead(
                lead
              ),
          });
        }
      }

      queryIndex += 1;

      if (
        !accepted.length &&
        queryIndex >=
          queryPairs.length
      ) {
        break;
      }
    }

    return generated.slice(
      0,
      count
    );
  }

  function saveGeneratedCampaign({
    workspaceId,
    pair,
    leads,
    runId,
  }) {
    const now =
      new Date().toISOString();

    const campaign = {
      id:
        crypto.randomUUID(),
      workspaceId,
      name:
        `Automatic daily leads · ${pair.niche} · ${pair.location}`,
      niche:
        pair.niche,
      location:
        pair.location,
      source:
        "automatic-google-places",
      status:
        "active",
      pipelineStatus:
        "ready",
      automatic:
        true,
      automaticRunId:
        runId,
      leadCount:
        leads.length,
      leads,
      createdAt:
        now,
      updatedAt:
        now,
    };

    store.update((draft) => {
      draft.campaigns =
        Array.isArray(
          draft.campaigns
        )
          ? draft.campaigns
          : [];

      draft.campaigns.unshift(
        campaign
      );

      draft.activity =
        Array.isArray(
          draft.activity
        )
          ? draft.activity
          : [];

      draft.activity.unshift({
        id:
          crypto.randomUUID(),
        workspaceId,
        type:
          "automatic_lead_generation",
        title:
          "Automatic Google Maps leads generated",
        sub:
          `${pair.niche} · ${pair.location} · ${leads.length} leads`,
        createdAt:
          now,
      });
    });

    return campaign.id;
  }

  function assignDailyQueues({
    workspaceId,
    dateKey,
    callers,
    callerNeeds,
    leadRefs,
    runId,
  }) {
    const callerQueues =
      Object.fromEntries(
        callers.map(
          (caller) => [
            caller.id,
            [],
          ]
        )
      );

    const orderedCallers =
      callers
        .map((caller) => ({
          ...caller,
          remaining:
            callerNeeds.get(
              caller.id
            ) || 0,
        }))
        .filter(
          (caller) =>
            caller.remaining > 0
        );

    let assignedCount =
      0;
    let cursor =
      0;

    const assignments = [];

    for (
      const ref
      of leadRefs
    ) {
      if (
        !orderedCallers.length
      ) {
        break;
      }

      let attempts =
        0;
      let caller =
        null;

      while (
        attempts <
        orderedCallers.length
      ) {
        const candidate =
          orderedCallers[
            cursor %
            orderedCallers.length
          ];

        cursor += 1;
        attempts += 1;

        if (
          candidate.remaining > 0
        ) {
          caller =
            candidate;
          break;
        }
      }

      if (!caller) {
        break;
      }

      caller.remaining -= 1;

      assignments.push({
        ...ref,
        callerId:
          caller.id,
        callerName:
          caller.name,
        position:
          callerQueues[
            caller.id
          ].length + 1,
      });

      callerQueues[
        caller.id
      ].push(
        ref.leadId
      );

      assignedCount += 1;
    }

    const now =
      new Date().toISOString();

    store.update((draft) => {
      for (
        const assignment
        of assignments
      ) {
        const campaign =
          (
            draft.campaigns ||
            []
          ).find(
            (item) =>
              item.id ===
                assignment.campaignId &&
              campaignBelongsToWorkspace(
                item,
                workspaceId
              )
          );

        const lead =
          (
            campaign?.leads ||
            []
          ).find(
            (item) =>
              item.id ===
                assignment.leadId
          );

        if (!lead) {
          continue;
        }

        lead.assignedTo =
          assignment.callerId;
        lead.assigneeId =
          assignment.callerId;
        lead.assignedToName =
          assignment.callerName;
        lead.assignedAt =
          now;
        lead.assignedBy =
          "daily-automation";
        lead.status =
          normalizeStatus(
            lead.status
          ) === "new"
            ? "assigned"
            : normalizeStatus(
                lead.status ||
                "assigned"
              );
        lead.queueStatus =
          "ready";
        lead.dailyQueueDate =
          dateKey;
        lead.dailyQueuePosition =
          assignment.position;
        lead.dailyRunId =
          runId;
        lead.updatedAt =
          now;

        appendTimeline(
          lead,
          {
            type:
              "daily_assignment",
            status:
              lead.status,
            actorId:
              "daily-automation",
            assignedTo:
              assignment.callerId,
            runId,
            createdAt:
              now,
          }
        );
      }
    });

    const targetCount =
      [...callerNeeds.values()]
        .reduce(
          (sum, value) =>
            sum + value,
          0
        );

    return {
      assignedCount,
      shortfall:
        Math.max(
          0,
          targetCount -
          assignedCount
        ),
      callerQueues:
        Object.fromEntries(
          callers.map(
            (caller) => [
              caller.id,
              {
                callerId:
                  caller.id,
                callerName:
                  caller.name,
                assigned:
                  callerQueues[
                    caller.id
                  ].length,
                target:
                  callerNeeds.get(
                    caller.id
                  ) || 0,
              },
            ]
          )
        ),
      assignments,
    };
  }

  function queueMiniAudits({
    assignmentResult,
    callers,
  }) {
    const callerById =
      new Map(
        callers.map(
          (caller) => [
            caller.id,
            caller,
          ]
        )
      );

    const grouped =
      new Map();

    for (
      const assignment
      of assignmentResult.assignments
    ) {
      const state =
        store.read();

      const campaign =
        (
          state.campaigns ||
          []
        ).find(
          (item) =>
            item.id ===
            assignment.campaignId
        );

      const lead =
        (
          campaign?.leads ||
          []
        ).find(
          (item) =>
            item.id ===
            assignment.leadId
        );

      if (
        !lead?.website ||
        lead.miniAudit ||
        [
          "queued",
          "processing",
          "running",
          "complete",
          "completed",
        ].includes(
          normalizeStatus(
            lead.miniAuditStatus
          )
        )
      ) {
        continue;
      }

      const caller =
        callerById.get(
          assignment.callerId
        );

      if (!caller) {
        continue;
      }

      const group =
        grouped.get(
          caller.id
        ) || {
          caller,
          leads: [],
        };

      group.leads.push(
        lead
      );

      grouped.set(
        caller.id,
        group
      );
    }

    let queued = 0;

    for (
      const {
        caller,
        leads,
      }
      of grouped.values()
    ) {
      try {
        const result =
          leadAuditService.queueMiniBatch(
            caller,
            {
              leads:
                leads.slice(
                  0,
                  1000
                ),
              source:
                "daily-automation",
            }
          );

        queued +=
          Number(
            result?.queued ||
            result?.count ||
            leads.length
          );
      } catch (error) {
        console.warn(
          "[daily-leads] mini-audit queue failed",
          {
            callerId:
              caller.id,
            message:
              error?.message ||
              String(error),
          }
        );
      }
    }

    return queued;
  }

  function getStatus(user) {
    const ctx =
      requireManager(user);

    const state =
      store.read();

    return {
      ok: true,
      config:
        getConfig(
          ctx.workspaceId,
          state
        ),
      running:
        runningWorkspaces.has(
          ctx.workspaceId
        ),
      latestRun:
        publicRun(
          (
            state.dailyLeadRuns ||
            []
          ).find(
            (run) =>
              run.workspaceId ===
              ctx.workspaceId
          ) ||
          null
        ),
    };
  }

  function getRun(runId) {
    return (
      (
        store.read()
          .dailyLeadRuns ||
        []
      ).find(
        (run) =>
          run.id === runId
      ) ||
      null
    );
  }

  function finishRun(
    runId,
    patch
  ) {
    store.update((draft) => {
      const run =
        (
          draft.dailyLeadRuns ||
          []
        ).find(
          (item) =>
            item.id ===
            runId
        );

      if (!run) {
        return;
      }

      Object.assign(
        run,
        patch,
        {
          completedAt:
            patch.status ===
              "running"
              ? ""
              : new Date()
                  .toISOString(),
          updatedAt:
            new Date()
              .toISOString(),
        }
      );
    });
  }

  function requireManager(user) {
    const ctx =
      workspaceService?.getContext?.(
        user,
        store.read()
      ) || {
        user,
        workspaceId:
          user.workspaceId,
        role:
          user.workspaceRole ||
          user.role,
        permissions:
          user.permissions ||
          [],
      };

    const role =
      normalizeStatus(
        ctx.role
      );

    if (
      ![
        "owner",
        "admin",
        "manager",
      ].includes(role) &&
      !ctx.permissions?.includes(
        "manage_campaigns"
      )
    ) {
      throw httpError(
        403,
        "Manager access is required."
      );
    }

    return ctx;
  }

  function emitEvent(
    workspaceId,
    event,
    payload
  ) {
    try {
      emit?.({
        workspaceId,
        event,
        payload,
      });
    } catch {
      // Realtime delivery must not stop allocation.
    }
  }

  return {
    getConfig,
    saveConfig,
    getStatus,
    runAllWorkspaces,
    runForUser,
    runWorkspace,
    releaseDueLeads,
  };
}


function getCallerLeadLimit(
  state,
  workspaceId,
  caller,
  fallback
) {
  return positiveInteger(
    state.resourceLeadLimits
      ?.[workspaceId]
      ?.[caller.id] ??
      caller.dailyLeadLimit ??
      caller.leadAssignmentLimit ??
      fallback,
    fallback,
    1,
    5000
  );
}

function listActiveCallers(
  state,
  workspaceId
) {
  return (
    state.users ||
    []
  )
    .filter(
      (user) =>
        user.workspaceId ===
          workspaceId &&
        user.active !==
          false &&
        normalizeStatus(
          user.workspaceRole ||
          user.role
        ) ===
          "caller"
    )
    .map(
      (user) => ({
        ...user,
        name:
          user.name ||
          user.fullName ||
          user.email ||
          "Caller",
      })
    );
}

function countCurrentDailyWorkload(
  state,
  workspaceId,
  callers,
  dateKey
) {
  const counts =
    new Map(
      callers.map(
        (caller) => [
          caller.id,
          0,
        ]
      )
    );

  for (
    const campaign
    of state.campaigns ||
    []
  ) {
    if (
      !campaignBelongsToWorkspace(
        campaign,
        workspaceId
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
        lead.dailyQueueDate !==
          dateKey ||
        !counts.has(
          lead.assignedTo
        ) ||
        isClosedStatus(
          normalizeStatus(
            lead.status
          )
        )
      ) {
        continue;
      }

      counts.set(
        lead.assignedTo,
        (
          counts.get(
            lead.assignedTo
          ) || 0
        ) + 1
      );
    }
  }

  return counts;
}

function normalizeGeneratedLead(
  rawLead
) {
  const now =
    new Date().toISOString();

  return {
    ...rawLead,
    id:
      rawLead.id ||
      crypto.randomUUID(),
    business:
      clean(
        rawLead.business ||
        rawLead.name
      ),
    name:
      clean(
        rawLead.name ||
        rawLead.business
      ),
    phone:
      clean(
        rawLead.phone
      ),
    email:
      clean(
        rawLead.email
      ),
    website:
      clean(
        rawLead.website
      ),
    address:
      clean(
        rawLead.address ||
        rawLead.location
      ),
    location:
      clean(
        rawLead.location ||
        rawLead.address
      ),
    status:
      "new",
    queueStatus:
      "ready",
    callAttempts:
      0,
    answeredCalls:
      0,
    timeline:
      Array.isArray(
        rawLead.timeline
      )
        ? rawLead.timeline
        : [],
    createdAt:
      rawLead.createdAt ||
      now,
    updatedAt:
      now,
  };
}

function campaignBelongsToWorkspace(
  campaign,
  workspaceId
) {
  return (
    campaign.workspaceId ===
      workspaceId ||
    (
      !campaign.workspaceId &&
      campaign.companyId ===
        workspaceId
    )
  );
}

function leadExistsInWorkspace(
  state,
  workspaceId,
  identity
) {
  return (
    state.campaigns ||
    []
  ).some(
    (campaign) =>
      campaignBelongsToWorkspace(
        campaign,
        workspaceId
      ) &&
      (
        campaign.leads ||
        []
      ).some(
        (lead) =>
          leadIdentity(
            lead
          ) ===
            identity
      )
  );
}

function dedupeLeadRefs(
  refs
) {
  const seen =
    new Set();

  return refs.filter(
    (ref) => {
      const key =
        ref.key ||
        `${ref.campaignId}:${ref.leadId}`;

      if (
        seen.has(
          key
        )
      ) {
        return false;
      }

      seen.add(key);
      return true;
    }
  );
}

function buildQueryPairs(
  niches,
  locations
) {
  const pairs = [];

  for (
    const niche
    of niches
  ) {
    for (
      const location
      of locations
    ) {
      pairs.push({
        niche,
        location,
      });
    }
  }

  return pairs;
}

function leadIdentity(
  lead
) {
  const placeId =
    clean(
      lead.placeId
    );

  const phone =
    String(
      lead.phone ||
      ""
    ).replace(
      /\D/g,
      ""
    );

  const website =
    normalizeHost(
      lead.website
    );

  const email =
    clean(
      lead.email
    ).toLowerCase();

  const business =
    clean(
      lead.business ||
      lead.name
    ).toLowerCase();

  const location =
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
          : business
            ? `business:${business}|${location}`
            : "";
}

function normalizeHost(
  value
) {
  const raw =
    clean(value);

  if (!raw) {
    return "";
  }

  try {
    return new URL(
      /^https?:\/\//i.test(
        raw
      )
        ? raw
        : `https://${raw}`
    ).hostname
      .replace(
        /^www\./i,
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

function isLeadEligibleNow(
  lead
) {
  if (
    isClosedStatus(
      normalizeStatus(
        lead.status
      )
    )
  ) {
    return false;
  }

  const nextAction =
    Date.parse(
      lead.nextActionAt ||
      lead.followUpAt ||
      lead.callbackAt ||
      0
    );

  if (
    Number.isFinite(
      nextAction
    ) &&
    nextAction >
      Date.now()
  ) {
    return false;
  }

  return (
    lead.queueStatus !==
    "held"
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

function scoreLead(
  lead
) {
  const status =
    normalizeStatus(
      lead.status
    );

  let score =
    Number(
      lead.qualityScore ||
      lead.confidence ||
      0
    );

  if (
    lead.priority ===
    "urgent"
  ) {
    score += 1000;
  }

  if (
    lead.priority ===
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

  if (
    [
      "no_answer",
      "busy",
      "voicemail",
    ].includes(
      status
    )
  ) {
    score += 150;
  }

  score -=
    Number(
      lead.callAttempts ||
      0
    ) * 20;

  return score;
}

function appendTimeline(
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

function publicRun(
  run
) {
  if (!run) {
    return null;
  }

  return {
    ...run,
    errors:
      Array.isArray(
        run.errors
      )
        ? run.errors
        : [],
  };
}

function getDateKey(
  date,
  timezone
) {
  try {
    const parts =
      new Intl.DateTimeFormat(
        "en-CA",
        {
          timeZone:
            timezone,
          year:
            "numeric",
          month:
            "2-digit",
          day:
            "2-digit",
        }
      ).formatToParts(
        date
      );

    const map =
      Object.fromEntries(
        parts.map(
          (part) => [
            part.type,
            part.value,
          ]
        )
      );

    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return date
      .toISOString()
      .slice(0, 10);
  }
}

function normalizeStringList(
  value
) {
  const list =
    Array.isArray(value)
      ? value
      : String(
          value ||
          ""
        ).split(",");

  return uniqueStrings(
    list
      .map(clean)
      .filter(Boolean)
  );
}

function uniqueStrings(
  values
) {
  return [
    ...new Set(
      values
        .map(clean)
        .filter(Boolean)
    ),
  ];
}

function positiveInteger(
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

function envFlag(
  name,
  fallback
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
