import { uid } from "./store.js";

const cityCoords = {
  london: [51.5072, -0.1276],
  miami: [25.7617, -80.1918],
  dubai: [25.2048, 55.2708],
  "new york": [40.7128, -74.006],
  lahore: [31.5204, 74.3587],
  karachi: [24.8607, 67.0011],
  toronto: [43.6532, -79.3832],
  sydney: [-33.8688, 151.2093],
  berlin: [52.52, 13.405],
  paris: [48.8566, 2.3522],
};

const issues = [
  "weak call-to-action",
  "slow mobile page speed",
  "missing booking flow",
  "no visible testimonials",
  "unclear service positioning",
  "missing lead capture form",
  "limited local SEO signals",
];

const improvements = [
  "add a stronger above-the-fold CTA",
  "create a simple booking funnel",
  "compress images and improve Core Web Vitals",
  "add proof blocks and case studies",
  "build location-specific landing pages",
  "add a lead magnet and follow-up automation",
];

export function createCampaignManager({
  store,
  broadcast,
  leadFinder,
  email,
  scrapedLeadsService,
}) {
  const running = new Set();
  const sending = new Set();

  function listCampaigns(status) {
    const campaigns = store.read().campaigns || [];

    if (!status) return campaigns;

    return campaigns.filter((campaign) => campaign.status === status);
  }

  function getCampaign(id) {
    return (store.read().campaigns || []).find(
      (campaign) => campaign.id === id
    );
  }

  async function createCampaign(payload = {}) {
    const rawImportedLeads = Array.isArray(payload.leads) ? payload.leads : [];

    const isExternalImport =
      payload.source === "external-import" ||
      payload.externalImport === true ||
      rawImportedLeads.length > 0;

    validateCampaign(payload, isExternalImport);

    const id = uid("camp");
    const now = new Date().toISOString();

    const niche =
      cleanText(payload.niche) ||
      cleanText(payload.selectedSegment) ||
      (isExternalImport ? "External leads" : "");

    const location =
      cleanText(payload.location) ||
      (isExternalImport ? "External imported leads" : "");

    const goal = payload.goal || "both";

    const importedLeads = isExternalImport
      ? normalizeImportedLeads(rawImportedLeads, {
          niche,
          location,
          selectedSegment: payload.selectedSegment,
        })
      : [];

    if (isExternalImport && !importedLeads.length) {
      const error = new Error(
        "No valid leads were found in the imported data."
      );

      error.statusCode = 400;

      throw error;
    }

    const limit = isExternalImport
      ? clampNumber(payload.limit || importedLeads.length || 1, 1, 100000)
      : clampNumber(payload.limit || 100, 1, 1000);

    const radiusKm = clampNumber(payload.radiusKm || 10, 1, 1000);

    const requestedRows = Number(payload.totalRows || rawImportedLeads.length);
    const validEmails = Number(payload.validEmails || importedLeads.length);
    const missingEmails = Number(payload.missingEmails || 0);
    const duplicateEmails = Number(payload.duplicateEmails || 0);
    const validPhones = Number(
      payload.validPhones ??
        importedLeads.filter((lead) => cleanText(lead.phone)).length
    );
    const missingPhones = Number(
      payload.missingPhones ??
        Math.max(0, importedLeads.length - validPhones)
    );

    const primaryChannel = normalizeCampaignChannel(
      payload.primaryChannel ||
        (payload.voiceEnabled || payload.aiVoiceEnabled ? "voice" : "email")
    );

    const campaignType = cleanText(
      payload.campaignType ||
        (primaryChannel === "voice" ? "ai-calling" : "email")
    );

    const voiceEnabled = Boolean(
      payload.voiceEnabled === true ||
        payload.aiVoiceEnabled === true ||
        payload.outreachPlan?.aiVoice === true ||
        primaryChannel === "voice"
    );

    const aiVoiceEnabled = Boolean(
      payload.aiVoiceEnabled === true ||
        payload.outreachPlan?.aiVoice === true ||
        voiceEnabled
    );

    const aiManagedEmailFollowUp = Boolean(
      payload.aiManagedEmailFollowUp === true ||
        payload.outreachPlan?.aiManagedEmailFollowUp === true ||
        payload.outreachPlan?.aiChoosesFollowUpTiming === true
    );

    const emailEnabled = Boolean(
      payload.emailEnabled === true ||
        payload.outreachPlan?.emailEnabled === true ||
        primaryChannel === "email" ||
        aiManagedEmailFollowUp ||
        cleanText(payload.emailAccountId || payload.senderEmail || payload.fromEmail)
    );

    const dailyLimit = clampNumber(
      payload.dailyLimit ||
        payload.dailySendingLimit ||
        payload.sendingLimit ||
        limit,
      1,
      100000
    );

    const campaign = {
      id,

      userId: cleanText(payload.userId || payload.ownerId || ""),
      ownerId: cleanText(payload.ownerId || payload.userId || ""),

      name:
        cleanText(payload.name) ||
        (isExternalImport
          ? `Imported leads — ${niche}`
          : `${niche} — ${location}`),

      accountType: payload.accountType || "individual",
      role: cleanText(payload.role || ""),
      companyName: cleanText(payload.companyName || ""),
      ownerName: cleanText(payload.ownerName || ""),
      ownerEmail: cleanText(payload.ownerEmail || ""),

      source: isExternalImport
        ? "external-import"
        : "google-places",
      externalImport: isExternalImport,
      workspaceId: cleanText(payload.workspaceId || ""),

      campaignType,
      primaryChannel,
      voiceEnabled,
      aiVoiceEnabled,
      emailEnabled,
      aiManagedEmailFollowUp,
      outreachPlan: sanitizeOutreachPlan(payload.outreachPlan, {
        primaryChannel,
        voiceEnabled,
        aiVoiceEnabled,
        emailEnabled,
        aiManagedEmailFollowUp,
      }),

      niche,
      category: niche,
      location,
      radiusKm,
      limit,
      dailyLimit,
      sendDelayMs: clampNumber(payload.sendDelayMs || 1500, 250, 600000),
      qualityLevel: payload.qualityLevel || "balanced",
      goal,
      offer: cleanText(payload.offer || ""),

      emailAccountId: cleanText(payload.emailAccountId || ""),
      senderEmail: cleanText(payload.senderEmail || payload.fromEmail || ""),

      status: isExternalImport ? "active" : "queued",
      pipelineStatus: isExternalImport ? "ready" : "discovering",

      leadCount: isExternalImport ? importedLeads.length : 0,
      leads: isExternalImport ? importedLeads : [],

      totalRows: isExternalImport ? requestedRows : 0,
      validEmails: isExternalImport ? validEmails : 0,
      missingEmails: isExternalImport ? missingEmails : 0,
      duplicateEmails: isExternalImport ? duplicateEmails : 0,
      validPhones: isExternalImport ? validPhones : 0,
      missingPhones: isExternalImport ? missingPhones : 0,
      selectedSegment: cleanText(payload.selectedSegment || ""),

      leadMeta: isExternalImport
        ? {
            source: "external-import",
            requested: requestedRows || importedLeads.length,
            delivered: importedLeads.length,
            shortfall: Math.max(
              0,
              (requestedRows || importedLeads.length) - importedLeads.length
            ),
            exact: true,
            totalRows: requestedRows,
            validEmails,
            missingEmails,
            duplicateEmails,
            validPhones,
            missingPhones,
            selectedSegment: cleanText(payload.selectedSegment || ""),
          }
        : {
            source: "google-places",
            requested: limit,
            delivered: 0,
            shortfall: limit,
            exact: false,
          },

      pipeline:
        Array.isArray(payload.pipeline) && payload.pipeline.length
          ? sanitizePipeline(payload.pipeline)
          : defaultPipeline(goal),

      progress: {
        percent: isExternalImport ? 100 : 1,
        message: isExternalImport
          ? `Imported campaign ready with ${importedLeads.length} leads`
          : "Queued for Google Places lead discovery",
      },

      outreachProgress: {
        percent: 0,
        message: "Pipeline not started",
      },

      sendingStats: {
        total: 0,
        processed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        pendingFollowups: 0,
      },

      replies: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    };

    store.update((state) => {
      state.campaigns = state.campaigns || [];
      state.campaigns.unshift(campaign);
    });

    store.addActivity(
      isExternalImport ? "Imported campaign ready" : "Campaign queued",
      isExternalImport
        ? `${campaign.name} · ${importedLeads.length} leads`
        : campaign.name,
      isExternalImport ? "📥" : "🚀"
    );

    broadcast(id, {
      type: isExternalImport ? "complete" : "created",
      campaign,
      percent: campaign.progress.percent,
      message: campaign.progress.message,
    });

    if (!isExternalImport) {
      runDiscovery(id);
    }

    return campaign;
  }

  function deleteCampaign(id) {
    store.update((state) => {
      state.campaigns = (state.campaigns || []).filter(
        (campaign) => campaign.id !== id
      );

      state.inbox = (state.inbox || []).filter(
        (message) => message.campaignId !== id
      );
    });
  }

  function updatePipeline(id, pipeline) {
    const safe = sanitizePipeline(pipeline);

    let updated;

    store.update((state) => {
      state.campaigns = (state.campaigns || []).map((campaign) => {
        if (campaign.id !== id) return campaign;

        updated = {
          ...campaign,
          pipeline: safe,
          updatedAt: new Date().toISOString(),
        };

        return updated;
      });
    });

    if (!updated) {
      throw new Error("Campaign not found.");
    }

    store.addActivity("Pipeline saved", updated.name, "🧩");

    broadcast(id, {
      type: "pipeline_saved",
      campaign: updated,
    });

    return updated;
  }

  async function runDiscovery(id) {
    if (running.has(id)) return;

    running.add(id);

    try {
      const campaign = getCampaign(id);

      if (!campaign) {
        throw new Error("Campaign not found.");
      }

      if (
        campaign.externalImport ||
        campaign.source === "external-import"
      ) {
        return campaign;
      }

      if (!leadFinder?.findLeads) {
        throw new Error(
          "Lead finder is not connected. Pass createLeadFinder() into createCampaignManager({ store, broadcast, leadFinder })."
        );
      }

      await updateCampaignProgress(
        id,
        4,
        "Starting Google Places lead discovery",
        "queued",
        "discovering"
      );

      const campaignLeadRunId = `campaign-${campaign.id}`;
      const campaignUser = {
        id: campaign.userId || campaign.ownerId || "",
        workspaceId: campaign.workspaceId || "",
      };
      const excludedIdentityKeys = scrapedLeadsService?.getIdentityKeys
        ? scrapedLeadsService.getIdentityKeys(campaignUser)
        : new Set();

      const result = await leadFinder.findLeads({
        runId: campaignLeadRunId,
        niche: campaign.niche,
        location: campaign.location,
        radiusKm: campaign.radiusKm,
        limit: campaign.limit,
        qualityLevel: campaign.qualityLevel,
        exact: true,
        excludeKeys: excludedIdentityKeys,
        onProgress: (event = {}) => {
          updateCampaignProgress(
            id,
            event.percent || 10,
            event.message || "Finding Google Places leads",
            "queued",
            "discovering",
            event.type || "lead_progress"
          );
        },
      });

      const leads = normalizeDiscoveredLeads(
        result.leads || [],
        campaign
      );

      if (leads.length && scrapedLeadsService?.saveBatch) {
        scrapedLeadsService.saveBatch(campaignUser, result.leads || leads, {
          runId: campaignLeadRunId,
          niche: campaign.niche,
          location: campaign.location,
          requested: campaign.limit,
          status: result.status || "complete",
          source: "google-places-campaign",
        });
        scrapedLeadsService.finishRun?.(campaignUser, {
          runId: campaignLeadRunId,
          requested: campaign.limit,
          status: result.status || "complete",
        });
      }

      if (!leads.length) {
        const error = new Error(
          result.message ||
            "Google Places did not return any usable leads for this campaign."
        );

        error.statusCode = 404;
        error.details = {
          ...(result.meta || {}),
          requested: campaign.limit,
          delivered: 0,
          shortfall: campaign.limit,
          availableLeads: [],
          status: result.status || "completed_empty",
        };

        throw error;
      }

      const shortfall = Math.max(
        0,
        campaign.limit - leads.length
      );

      const exact = shortfall === 0;

      let completed;

      store.update((state) => {
        state.campaigns = (state.campaigns || []).map((item) => {
          if (item.id !== id) return item;

          completed = {
            ...item,
            status: "active",
            pipelineStatus: "ready",
            error: "",
            leads,
            leadCount: leads.length,
            leadMeta: {
              ...(result.meta || {}),
              source: "google-places",
              requested: result.requested || item.limit,
              delivered: result.delivered ?? leads.length,
              shortfall:
                result.shortfall ??
                Math.max(0, item.limit - leads.length),
              exact,
              status:
                result.status ||
                (exact
                  ? "completed_exact"
                  : "completed_partial"),
            },
            progress: {
              percent: 100,
              message: exact
                ? `Google Places discovery complete: ${leads.length} leads ready`
                : `Google Places discovery complete: ${leads.length}/${item.limit} leads ready`,
            },
            updatedAt: new Date().toISOString(),
          };

          return completed;
        });
      });

      store.addActivity(
        exact
          ? "Google Places discovery finished"
          : "Google Places discovery completed with partial results",
        `${completed.name} · ${leads.length} real leads`,
        exact ? "🎯" : "📍"
      );

      broadcast(id, {
        type: "complete",
        campaign: completed,
        percent: 100,
        message: completed.progress.message,
        exact,
        shortfall,
      });

      return completed;
    } catch (error) {
      let failed;

      const partialLeads = normalizeDiscoveredLeads(
        error.details?.availableLeads || [],
        getCampaign(id) || {}
      );

      store.update((state) => {
        state.campaigns = (state.campaigns || []).map((campaign) => {
          if (campaign.id !== id) return campaign;

          failed = {
            ...campaign,
            status: "failed",
            pipelineStatus: "failed",
            error: error.message,
            leads: partialLeads,
            leadCount: partialLeads.length,
            leadMeta: {
              ...(campaign.leadMeta || {}),
              ...(error.details || {}),
              source: "google-places",
              requested: campaign.limit,
              delivered: partialLeads.length,
              shortfall: Math.max(
                0,
                campaign.limit - partialLeads.length
              ),
              exact: false,
            },
            progress: {
              percent: 100,
              message:
                error.message ||
                "Google Places lead discovery failed",
            },
            updatedAt: new Date().toISOString(),
          };

          return failed;
        });
      });

      store.addActivity(
        "Google Places discovery needs review",
        `${failed?.name || "Campaign"} · ${error.message}`,
        "⚠️"
      );

      broadcast(id, {
        type: "error",
        error: error.message,
        details: error.details,
        campaign: failed,
        percent: 100,
        message: error.message,
      });

      return failed;
    } finally {
      running.delete(id);
    }
  }

  async function runPipeline(id) {
    if (sending.has(id)) {
      const campaign = getCampaign(id);

      if (campaign) return campaign;

      throw new Error("Campaign is already running.");
    }

    const campaign = getCampaign(id);

    if (!campaign) {
      throw new Error("Campaign not found.");
    }

    if (!campaign.leads?.length) {
      throw new Error("Campaign has no leads yet.");
    }

    if (
      normalizeCampaignChannel(campaign.primaryChannel) === "voice" ||
      campaign.voiceEnabled === true ||
      campaign.aiVoiceEnabled === true
    ) {
      throw new Error(
        "This is an AI Calling campaign. Launch it from the Dialer/AI Voice workflow; email follow-up is triggered from call outcomes when configured."
      );
    }

    if (!email?.sendCampaignEmail) {
      throw new Error(
        "Email sending service is not connected. Pass email into createCampaignManager({ store, broadcast, leadFinder, email })."
      );
    }

    const userId = getCampaignUserId(campaign);

    if (!userId) {
      throw new Error(
        "Campaign user id is missing. Create the campaign again after updating the backend to pass userId."
      );
    }

    const account = await resolveSendingAccount(campaign, userId);

    if (!account.senderEmail) {
      throw new Error(
        "No sender email is linked with this campaign. Please select an email account before running outreach."
      );
    }

    const stages = (campaign.pipeline || []).filter(
      (stage) =>
        stage.enabled !== false &&
        stage.aiTriggered !== true &&
        stage.executionMode !== "ai_triggered"
    );

    const immediateEmailStages = stages.filter(
      (stage) =>
        stage.channel === "email" && Number(stage.delayMinutes || 0) <= 0
    );

    const pendingFollowups = stages.filter(
      (stage) =>
        stage.channel === "email" && Number(stage.delayMinutes || 0) > 0
    ).length;

    if (!immediateEmailStages.length) {
      throw new Error(
        "No immediate email stage found. Add an email step with 0 delay before running the campaign."
      );
    }

    const dailyLimit = clampNumber(
      campaign.dailyLimit || campaign.sendingLimit || campaign.limit || 100,
      1,
      100000
    );

    const leadsForToday = campaign.leads.slice(0, dailyLimit);
    const total = leadsForToday.length * immediateEmailStages.length;

    let started;

    sending.add(id);

    store.update((state) => {
      state.campaigns = (state.campaigns || []).map((item) => {
        if (item.id !== id) return item;

        started = {
          ...item,
          userId,
          ownerId: item.ownerId || userId,
          emailAccountId: account.accountId || item.emailAccountId || "",
          senderEmail: account.senderEmail,
          status: "active",
          pipelineStatus: "running",
          error: "",
          sendingStats: {
            total,
            processed: 0,
            sent: 0,
            failed: 0,
            skipped: 0,
            pendingFollowups,
          },
          outreachProgress: {
            percent: 1,
            message: `Campaign started. Sending from ${account.senderEmail}`,
          },
          updatedAt: new Date().toISOString(),
        };

        return started;
      });
    });

    store.addActivity(
      "Campaign sending started",
      `${campaign.name} · sending from ${account.senderEmail}`,
      "🚀"
    );

    broadcast(id, {
      type: "pipeline_started",
      campaign: started,
      percent: 1,
      message: started.outreachProgress.message,
    });

    runPipelineInBackground({
      id,
      userId,
      campaign: {
        ...campaign,
        userId,
        ownerId: campaign.ownerId || userId,
        emailAccountId: account.accountId || campaign.emailAccountId || "",
        senderEmail: account.senderEmail,
      },
      stages: immediateEmailStages,
      senderEmail: account.senderEmail,
      accountId: account.accountId,
      leads: leadsForToday,
      total,
      pendingFollowups,
    });

    return started;
  }

  async function runPipelineInBackground({
    id,
    userId,
    campaign,
    stages,
    senderEmail,
    accountId,
    leads,
    total,
    pendingFollowups,
  }) {
    let done = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let current;

    try {
      for (const stage of stages) {
        for (const lead of leads) {
          const rendered = renderStage(stage, lead, campaign);
          const recipientEmail = normalizeEmail(
            lead.email || lead.leadEmail || lead.toEmail || ""
          );

          let status = "skipped";
          let providerMessageId = "";
          let providerResponse = "";
          let errorMessage = "";

          if (!recipientEmail) {
            skipped += 1;
            errorMessage = "Recipient email is missing.";
          } else {
            try {
              const result = await email.sendCampaignEmail(userId, {
                accountId,
                campaignId: id,
                leadId: lead.id,
                to: recipientEmail,
                subject: rendered.subject,
                body: rendered.body,
              });

              status = "sent";
              sent += 1;
              providerMessageId = result.messageId || "";
              providerResponse = result.response || "";
            } catch (error) {
              status = "failed";
              failed += 1;
              errorMessage = error.message || "Email failed to send.";
            }
          }

          done += 1;

          const percent = Math.min(99, Math.round((done / total) * 100));

          store.update((state) => {
            state.inbox = state.inbox || [];

            state.inbox.unshift({
              id: uid("msg"),

              userId,
              ownerId: userId,

              campaignId: id,
              campaignName: campaign.name,

              leadId: lead.id,
              leadName: lead.name || lead.business || "Imported lead",
              leadEmail: recipientEmail,

              emailAccountId: accountId || campaign.emailAccountId || "",
              senderEmail,
              fromEmail: senderEmail,
              toEmail: recipientEmail,

              providerMessageId,
              providerResponse,

              channel: stage.channel,
              direction: "outbound",
              source: "campaign",
              status,

              subject: rendered.subject,
              title: stage.name,
              body: rendered.body,

              error: errorMessage,

              sentAt: status === "sent" ? new Date().toISOString() : "",
              createdAt: new Date().toISOString(),
            });

            state.inbox = state.inbox.slice(0, 5000);
          });

          store.update((state) => {
            state.campaigns = (state.campaigns || []).map((item) => {
              if (item.id !== id) return item;

              current = {
                ...item,
                userId,
                ownerId: item.ownerId || userId,
                emailAccountId: accountId || item.emailAccountId || "",
                senderEmail,
                status: "active",
                pipelineStatus: "running",
                sendingStats: {
                  total,
                  processed: done,
                  sent,
                  failed,
                  skipped,
                  pendingFollowups,
                },
                sentCount: sent,
                failedCount: failed,
                skippedCount: skipped,
                outreachProgress: {
                  percent,
                  message: `${stage.name}: ${done}/${total} processed · ${sent} sent · ${failed} failed`,
                },
                updatedAt: new Date().toISOString(),
              };

              return current;
            });
          });

          broadcast(id, {
            type: "pipeline_progress",
            campaign: current,
            percent,
            message: current.outreachProgress.message,
          });

          await wait(getSendDelayMs(campaign));
        }
      }

      const finalStatus = sent > 0 ? "history" : "failed";
      const finalPipelineStatus = sent > 0 ? "complete" : "failed";
      const finalMessage =
        sent > 0
          ? `Sending complete. ${sent} sent, ${failed} failed, ${skipped} skipped.`
          : `No emails were sent. ${failed} failed, ${skipped} skipped.`;

      store.update((state) => {
        state.campaigns = (state.campaigns || []).map((item) => {
          if (item.id !== id) return item;

          current = {
            ...item,
            userId,
            ownerId: item.ownerId || userId,
            emailAccountId: accountId || item.emailAccountId || "",
            senderEmail,
            status: finalStatus,
            pipelineStatus: finalPipelineStatus,
            error: sent > 0 ? "" : finalMessage,
            sendingStats: {
              total,
              processed: done,
              sent,
              failed,
              skipped,
              pendingFollowups,
            },
            sentCount: sent,
            failedCount: failed,
            skippedCount: skipped,
            outreachProgress: {
              percent: 100,
              message: finalMessage,
            },
            replies: item.replies || 0,
            updatedAt: new Date().toISOString(),
          };

          return current;
        });
      });

      store.addActivity(
        sent > 0 ? "Campaign emails sent" : "Campaign sending failed",
        `${campaign.name} · ${sent} sent · ${failed} failed`,
        sent > 0 ? "📧" : "⚠️"
      );

      broadcast(id, {
        type: sent > 0 ? "pipeline_complete" : "error",
        campaign: current,
        percent: 100,
        message: finalMessage,
        error: sent > 0 ? "" : finalMessage,
      });
    } catch (error) {
      let failedCampaign;

      store.update((state) => {
        state.campaigns = (state.campaigns || []).map((item) => {
          if (item.id !== id) return item;

          failedCampaign = {
            ...item,
            status: "failed",
            pipelineStatus: "failed",
            error: error.message,
            sendingStats: {
              total,
              processed: done,
              sent,
              failed,
              skipped,
              pendingFollowups,
            },
            sentCount: sent,
            failedCount: failed,
            skippedCount: skipped,
            outreachProgress: {
              percent: 100,
              message: error.message,
            },
            updatedAt: new Date().toISOString(),
          };

          return failedCampaign;
        });
      });

      broadcast(id, {
        type: "error",
        error: error.message,
        campaign: failedCampaign,
        percent: 100,
        message: error.message,
      });
    } finally {
      sending.delete(id);
    }
  }

  async function updateCampaignProgress(
    id,
    percent,
    message,
    status,
    pipelineStatus,
    eventType = "progress"
  ) {
    let updated;

    store.update((state) => {
      state.campaigns = (state.campaigns || []).map((campaign) => {
        if (campaign.id !== id) return campaign;

        updated = {
          ...campaign,
          status: status || campaign.status,
          pipelineStatus: pipelineStatus || campaign.pipelineStatus,
          progress: {
            percent: clampNumber(percent || 1, 1, 100),
            message,
          },
          updatedAt: new Date().toISOString(),
        };

        return updated;
      });
    });

    if (updated) {
      broadcast(id, {
        type: eventType,
        campaign: updated,
        percent: updated.progress.percent,
        message: updated.progress.message,
      });
    }

    return updated;
  }

  async function resolveSendingAccount(campaign, userId) {
    let accountId = cleanText(campaign.emailAccountId || "");
    let senderEmail = cleanText(
      campaign.senderEmail ||
        campaign.fromEmail ||
        campaign.replyToEmail ||
        campaign.ownerEmail ||
        ""
    );

    if (email?.getSettings && userId) {
      try {
        const settings = await email.getSettings(userId);
        const accounts = Array.isArray(settings.accounts)
          ? settings.accounts
          : [];

        const selected =
          accounts.find((account) => account.id === accountId) ||
          settings.activeAccount ||
          accounts[0] ||
          settings ||
          {};

        accountId = accountId || selected.id || settings.activeAccountId || "";
        senderEmail =
          senderEmail ||
          selected.fromEmail ||
          selected.username ||
          settings.fromEmail ||
          settings.username ||
          "";
      } catch {
        // Keep direct campaign sender if settings cannot be loaded.
      }
    }

    return {
      accountId,
      senderEmail: cleanText(senderEmail),
    };
  }

  function getCampaignUserId(campaign = {}) {
    const direct = cleanText(
      campaign.userId || campaign.ownerId || campaign.createdBy || ""
    );

    if (direct) return direct;

    const ownerEmail = normalizeEmail(campaign.ownerEmail || "");

    if (!ownerEmail) return "";

    const users = store.read().users || [];
    const user = users.find((item) => normalizeEmail(item.email) === ownerEmail);

    return cleanText(user?.id || "");
  }

  return {
    listCampaigns,
    getCampaign,
    createCampaign,
    deleteCampaign,
    updatePipeline,
    runPipeline,
  };
}

export function defaultPipeline(goal = "both") {
  const stages = [
    {
      name: "Value-first intro",
      channel: "email",
      delayMinutes: 0,
      subject: "Quick idea for {business}",
      body:
        "Hi {name},\n\nI noticed a quick growth opportunity for {business}: {firstIssue}.\n\nWould you be open to a 10-minute walkthrough?",
      enabled: true,
    },
    {
      name: "Helpful follow-up",
      channel: "email",
      delayMinutes: 2880,
      subject: "One practical fix for {business}",
      body:
        "Hi {name},\n\nOne simple improvement would be to {firstImprovement}.\n\nI can send a short fix list if useful.",
      enabled: true,
    },
  ];

  if (goal === "whatsapp" || goal === "both") {
    stages.push({
      name: "Short WhatsApp nudge",
      channel: "whatsapp",
      delayMinutes: 4320,
      subject: "",
      body:
        "Hi {name}, I found one conversion opportunity for {business}. Want me to send the quick notes?",
      enabled: true,
    });
  }

  return stages.map((stage, index) => ({
    ...stage,
    id: uid("stage"),
    order: index,
  }));
}

export function generateLeadsForCampaign() {
  return [];
}

export function getTerritoryCoordinates(location = "") {
  const normalized = normalize(location);
  const key = Object.keys(cityCoords).find((name) =>
    normalized.includes(normalize(name))
  );

  if (key) return cityCoords[key];

  const hash = Array.from(location).reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0
  );

  return [20 + (hash % 45), -100 + (hash % 160)];
}

function validateCampaign(
  payload,
  isExternalImport = false
) {
  const missing = [];

  if (isExternalImport) {
    if (!Array.isArray(payload.leads) || payload.leads.length === 0) {
      missing.push("leads");
    }

    if (!payload.name && !payload.niche) {
      missing.push("name");
    }
  } else {
    if (!payload?.niche || cleanText(payload.niche).length < 2) {
      missing.push("niche");
    }

    if (!payload?.location || cleanText(payload.location).length < 2) {
      missing.push("location");
    }
  }

  if (missing.length) {
    const error = new Error(`Missing required fields: ${missing.join(", ")}`);
    error.fields = missing;
    throw error;
  }
}


function sanitizePipeline(pipeline = []) {
  if (!Array.isArray(pipeline)) return [];

  return pipeline.map((stage, index) => {
    const channel = normalizeCampaignChannel(stage.channel || "email");
    const aiTriggered = Boolean(
      stage.aiTriggered === true ||
        stage.executionMode === "ai_triggered" ||
        stage.triggerPolicy?.mode === "ai_decides"
    );

    return {
      id: stage.id || uid("stage"),
      order: index,
      name: String(stage.name || `Stage ${index + 1}`).slice(0, 90),
      channel,
      delayMinutes: Math.max(0, Number(stage.delayMinutes || 0)),
      subject: String(stage.subject || "").slice(0, 180),
      body: String(stage.body || "").slice(0, 5000),
      enabled: stage.enabled !== false,
      aiTriggered,
      executionMode: aiTriggered ? "ai_triggered" : "scheduled",
      triggerPolicy: sanitizeTriggerPolicy(stage.triggerPolicy),
    };
  });
}

function sanitizeOutreachPlan(value = {}, defaults = {}) {
  const source = value && typeof value === "object" ? value : {};

  return {
    strategy: cleanText(source.strategy || ""),
    primaryChannel: normalizeCampaignChannel(
      source.primaryChannel || defaults.primaryChannel || "email"
    ),
    aiVoice: Boolean(source.aiVoice === true || defaults.aiVoiceEnabled),
    emailEnabled: Boolean(source.emailEnabled === true || defaults.emailEnabled),
    aiManagedEmailFollowUp: Boolean(
      source.aiManagedEmailFollowUp === true || defaults.aiManagedEmailFollowUp
    ),
    aiChoosesFollowUpTiming: Boolean(
      source.aiChoosesFollowUpTiming === true ||
        source.aiManagedEmailFollowUp === true ||
        defaults.aiManagedEmailFollowUp
    ),
    digitalChannel: cleanText(source.digitalChannel || ""),
    disclosureRequired: source.disclosureRequired === true,
    recordingPolicy: cleanText(source.recordingPolicy || ""),
    pipeline: Array.isArray(source.pipeline)
      ? sanitizePipeline(source.pipeline)
      : [],
  };
}

function sanitizeTriggerPolicy(value = {}) {
  if (!value || typeof value !== "object") return null;

  const outcomes = Array.isArray(value.outcomes)
    ? value.outcomes
        .map((item) => cleanText(item).slice(0, 80))
        .filter(Boolean)
        .slice(0, 20)
    : [];

  return {
    mode: cleanText(value.mode || "ai_decides").slice(0, 80),
    outcomes,
    requireConsent: value.requireConsent !== false,
    description: cleanText(value.description || "").slice(0, 500),
  };
}

function normalizeCampaignChannel(value) {
  const channel = cleanText(value).toLowerCase().replace(/[-\s]+/g, "_");

  if (["voice", "ai_voice", "ai_calling", "phone", "call"].includes(channel)) {
    return "voice";
  }

  if (["whatsapp", "wa"].includes(channel)) {
    return "whatsapp";
  }

  return "email";
}

function normalizeImportedLeads(
  leads = [],
  campaign = {}
) {
  const seen =
    new Set();

  return leads
    .filter(Boolean)
    .map(
      (
        lead,
        index
      ) => {
        const business =
          cleanText(
            lead.business ||
              lead.company ||
              lead.companyName ||
              lead.name ||
              `Imported lead ${
                index + 1
              }`
          );

        const contactName =
          cleanText(
            lead.contact_name ||
              lead.contactName ||
              lead.firstName ||
              ""
          );

        const email =
          normalizeEmail(
            lead.email ||
              lead.publicEmail ||
              lead.workEmail ||
              ""
          );

        const phone =
          cleanText(
            lead.phone ||
              lead.mobile ||
              lead.telephone ||
              ""
          );

        const website =
          cleanText(
            lead.website ||
              lead.domain ||
              lead.url ||
              ""
          );

        const placeId =
          cleanText(
            lead.placeId ||
              lead.googlePlaceId ||
              ""
          );

        const city =
          cleanText(
            lead.city ||
              ""
          );

        const state =
          cleanText(
            lead.state ||
              ""
          );

        const location =
          cleanText(
            lead.location ||
              lead.address ||
              [
                city,
                state,
              ]
                .filter(
                  Boolean
                )
                .join(", ")
          );

        const validEmail =
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            email
          );

        const identity =
          placeId ||
          normalizeWebsiteHost(
            website
          ) ||
          normalizePhoneDigits(
            phone
          ) ||
          (
            validEmail
              ? email
              : ""
          ) ||
          (
            business
              ? `${business.toLowerCase()}|${location.toLowerCase()}`
              : ""
          );

        if (
          !identity ||
          seen.has(
            identity
          )
        ) {
          return null;
        }

        const hasUsableLeadData =
          Boolean(
            placeId ||
            phone ||
            website ||
            validEmail ||
            (
              business &&
              location
            )
          );

        if (
          !hasUsableLeadData
        ) {
          return null;
        }

        seen.add(
          identity
        );

        const signals =
          Array.isArray(
            lead.signals
          )
            ? [
                ...lead.signals,
              ]
            : [];

        signals.push(
          "external_import"
        );

        if (validEmail) {
          signals.push(
            "email_found"
          );
        }

        if (phone) {
          signals.push(
            "phone_found"
          );
        }

        if (website) {
          signals.push(
            "website_found"
          );
        }

        const now =
          new Date()
            .toISOString();

        return {
          id:
            lead.id ||
            uid("lead"),

          placeId,

          name:
            contactName ||
            business,

          business,

          contact_name:
            contactName,

          category:
            cleanText(
              lead.category ||
                lead.niche ||
                campaign.selectedSegment ||
                campaign.niche ||
                ""
            ),

          address:
            location ||
            cleanText(
              campaign.location ||
                ""
            ),

          location:
            location ||
            cleanText(
              campaign.location ||
                ""
            ),

          city,
          state,
          phone,

          email:
            validEmail
              ? email
              : "",

          website,

          domain:
            cleanText(
              lead.domain ||
                ""
            ),

          notes:
            cleanText(
              lead.notes ||
                lead.description ||
                lead.summary ||
                ""
            ),

          directoryUrl:
            cleanText(
              lead.directoryUrl ||
                ""
            ),

          rating:
            cleanText(
              lead.rating ||
                ""
            ),

          reviews:
            cleanText(
              lead.reviews ||
                ""
            ),

          source:
            cleanText(
              lead.source ||
                "External import"
            ),

          confidence:
            Number(
              lead.confidence ||
                lead.qualityScore ||
                100
            ),

          qualityScore:
            Number(
              lead.qualityScore ||
                lead.confidence ||
                100
            ),

          dataQuality:
            lead.dataQuality ||
            (
              validEmail
                ? "email_available"
                : phone
                  ? "phone_available"
                  : website
                    ? "website_available"
                    : "imported"
            ),

          firstIssue:
            cleanText(
              lead.firstIssue ||
                ""
            ) ||
            "manual follow-up, scattered lead data, or disconnected workflow",

          firstImprovement:
            cleanText(
              lead.firstImprovement ||
                ""
            ) ||
            "replace one manual workflow with automation",

          mapsUrl:
            cleanText(
              lead.mapsUrl ||
                ""
            ) ||
            (
              placeId
                ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(
                    placeId
                  )}`
                : `https://www.google.com/search?q=${encodeURIComponent(
                    `${business} ${
                      location ||
                      campaign.location ||
                      ""
                    }`
                  )}`
            ),

          status:
            lead.status ||
            "new",

          conversionStatus:
            lead.conversionStatus ||
            "new",

          pipelineStatus:
            lead.pipelineStatus ||
            "new",

          assignedTo:
            cleanText(
              lead.assignedTo ||
                lead.assigneeId ||
                ""
            ),

          assignedToName:
            cleanText(
              lead.assignedToName ||
                lead.assigneeName ||
                ""
            ),

          assignedAt:
            cleanText(
              lead.assignedAt ||
                ""
            ),

          assignedBy:
            cleanText(
              lead.assignedBy ||
                ""
            ),

          timeline:
            Array.isArray(
              lead.timeline
            )
              ? lead.timeline
              : [],

          stageStatus:
            lead.stageStatus &&
            typeof lead.stageStatus ===
              "object"
              ? lead.stageStatus
              : {},

          signals: [
            ...new Set(
              signals.filter(
                Boolean
              )
            ),
          ],

          createdAt:
            lead.createdAt ||
            now,

          updatedAt:
            now,
        };
      }
    )
    .filter(Boolean);
}

function normalizeWebsiteHost(
  value
) {
  const raw =
    cleanText(value);

  if (!raw) {
    return "";
  }

  try {
    const url =
      new URL(
        /^https?:\/\//i.test(
          raw
        )
          ? raw
          : `https://${raw}`
      );

    return url.hostname
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

function normalizePhoneDigits(
  value
) {
  return String(
    value ||
      ""
  ).replace(
    /\D/g,
    ""
  );
}

function normalizeDiscoveredLeads(leads = [], campaign = {}) {
  return leads.filter(Boolean).map((lead, index) => {
    const name = cleanText(
      lead.name || lead.business || lead.company || `Lead ${index + 1}`
    );

    const website = cleanText(lead.website);
    const source = cleanText(lead.source || "Google Places");
    const issue = lead.firstIssue || issues[index % issues.length];
    const improvement =
      lead.firstImprovement || improvements[index % improvements.length];

    return {
      id: lead.id || uid("lead"),
      name,
      business: cleanText(lead.business || name),
      contact_name: cleanText(lead.contact_name || lead.contactName || ""),
      category: cleanText(lead.category || campaign.niche || ""),
      address: cleanText(lead.address || campaign.location || ""),
      phone: cleanText(lead.phone || ""),
      email: cleanText(lead.email || ""),
      website,
      domain: cleanText(lead.domain || ""),
      sourceUrl: cleanText(lead.sourceUrl || campaign.sourceUrl || ""),
      context: cleanText(lead.context || ""),
      directoryUrl: cleanText(lead.directoryUrl || ""),
      rating: cleanText(lead.rating || ""),
      reviews: cleanText(lead.reviews || ""),
      source,
      confidence: Number(lead.confidence || lead.qualityScore || 0),
      qualityScore: Number(lead.qualityScore || lead.confidence || 0),
      dataQuality: lead.dataQuality || getDataQuality(lead),
      firstIssue: issue,
      firstImprovement: improvement,
      mapsUrl:
        lead.mapsUrl ||
        `https://www.google.com/search?q=${encodeURIComponent(
          `${name} ${campaign.location || ""}`
        )}`,
      status: lead.status || "new",
      conversionStatus: lead.conversionStatus || "new",
      pipelineStatus: lead.pipelineStatus || "new",
      timeline: Array.isArray(lead.timeline) ? lead.timeline : [],
      stageStatus: lead.stageStatus || {},
      signals: Array.isArray(lead.signals) ? lead.signals : [],
    };
  });
}

function getDataQuality(lead = {}) {
  const score = Number(lead.qualityScore || lead.confidence || 0);

  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "usable";

  return "weak";
}

function renderStage(stage, lead, campaign) {
  const firstName =
    cleanText(lead.contact_name || lead.name).split(" ")[0] || "there";

  const business = cleanText(lead.business || lead.name || "your business");

  const replacements = {
    name: firstName,
    firstname: firstName,
    first_name: firstName,
    business,
    company: business,
    firstissue: lead.firstIssue || "a workflow or conversion opportunity",
    first_issue: lead.firstIssue || "a workflow or conversion opportunity",
    firstimprovement:
      lead.firstImprovement || "improve one manual workflow with automation",
    first_improvement:
      lead.firstImprovement || "improve one manual workflow with automation",
    location: lead.location || lead.address || campaign.location || "",
    website: lead.website || "your website",
    category: lead.category || campaign.niche || "",
    niche: lead.category || campaign.niche || "",
    notes: lead.notes || "",
  };

  const replace = (value = "") =>
    String(value)
      .replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
        return replacements[normalizeVariableKey(key)] || "";
      })
      .replace(/{\s*([^}]+)\s*}/g, (match, key) => {
        return replacements[normalizeVariableKey(key)] || match;
      });

  return {
    subject: replace(stage.subject),
    body: replace(stage.body),
  };
}

function normalizeVariableKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "_");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function clampNumber(value, min, max) {
  const number = Number(value || min);

  if (Number.isNaN(number)) return min;

  return Math.max(min, Math.min(max, number));
}

function getSendDelayMs(campaign = {}) {
  return clampNumber(campaign.sendDelayMs || 1500, 250, 600000);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}