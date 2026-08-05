import crypto from "node:crypto";

export function createAuditJobService({ store, auditService, workspaceService }) {
  const runningJobs = new Set();
  const concurrency = clamp(
    process.env.AUDIT_JOB_CONCURRENCY || 2,
    1,
    6
  );

  function createBatchJob(user, campaignId, input = {}) {
    const context = workspaceService.requireUserPermission(
      user,
      "create_audits"
    );
    const state = store.read();
    const campaign = (state.campaigns || []).find(
      (item) =>
        item.id === campaignId &&
        workspaceService.canAccessCampaign(item, context)
    );

    if (!campaign) throw createError(404, "Campaign not found.");

    const requestedIds = new Set(
      (input.leadIds || []).map(String).filter(Boolean)
    );
    const limit = clamp(input.limit || 50, 1, 200);
    const onlyWithoutAudit = input.onlyWithoutAudit !== false;

    const eligible = (campaign.leads || [])
      .filter((lead) => lead.website)
      .filter((lead) => !requestedIds.size || requestedIds.has(String(lead.id)))
      .filter((lead) => !onlyWithoutAudit || !lead.auditId)
      .filter((lead) => !["do_not_call", "not_interested"].includes(lead.status))
      .sort((a, b) =>
        Number(b.qualityScore || b.confidence || 0) -
        Number(a.qualityScore || a.confidence || 0)
      )
      .slice(0, limit);

    if (!eligible.length) {
      throw createError(400, "No eligible website leads are available to audit.");
    }

    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      campaignId: campaign.id,
      campaignName: campaign.name,
      createdBy: context.user.id,
      createdAt: now,
      updatedAt: now,
      startedAt: "",
      completedAt: "",
      status: "queued",
      total: eligible.length,
      completed: 0,
      failed: 0,
      currentLead: "",
      leadIds: eligible.map((lead) => lead.id),
      settings: {
        offer: clean(input.offer || campaign.offer),
        benchmarkUrls: sanitizeUrls(input.benchmarkUrls),
        runPageSpeed: input.runPageSpeed === true,
      },
      errors: [],
    };

    store.update((draft) => {
      draft.auditJobs = draft.auditJobs || [];
      draft.auditJobs.unshift(job);

      const targetCampaign = (draft.campaigns || []).find(
        (item) => item.id === campaign.id
      );
      for (const lead of targetCampaign?.leads || []) {
        if (!job.leadIds.includes(lead.id)) continue;
        lead.auditStatus = "queued";
        lead.auditJobId = job.id;
        lead.updatedAt = now;
      }
    });

    schedule(job.id);
    return publicJob(job);
  }

  function getJob(user, jobId) {
    const context = workspaceService.getContext(user);
    const job = (store.read().auditJobs || []).find(
      (item) => item.id === jobId && item.workspaceId === context.workspaceId
    );
    if (!job) throw createError(404, "Audit job not found.");
    return publicJob(job);
  }

  function listJobs(user, campaignId = "") {
    const context = workspaceService.requireUserPermission(
      user,
      "view_audits"
    );
    return (store.read().auditJobs || [])
      .filter((job) => job.workspaceId === context.workspaceId)
      .filter((job) => !campaignId || job.campaignId === campaignId)
      .slice(0, 50)
      .map(publicJob);
  }

  function resumePendingJobs() {
    for (const job of store.read().auditJobs || []) {
      if (["queued", "running"].includes(job.status)) schedule(job.id);
    }
  }

  function schedule(jobId) {
    if (runningJobs.has(jobId)) return;
    runningJobs.add(jobId);
    setImmediate(() =>
      processJob(jobId)
        .catch((error) => failJob(jobId, error))
        .finally(() => runningJobs.delete(jobId))
    );
  }

  async function processJob(jobId) {
    let snapshot = (store.read().auditJobs || []).find(
      (item) => item.id === jobId
    );
    if (!snapshot || snapshot.status === "complete") return;

    const owner = (store.read().users || []).find(
      (item) => item.id === snapshot.createdBy
    );
    if (!owner) throw new Error("Audit job owner no longer exists.");

    updateJob(jobId, (job) => {
      job.status = "running";
      job.startedAt = job.startedAt || new Date().toISOString();
    });

    const remaining = snapshot.leadIds.filter((leadId) => {
      const lead = getLead(snapshot.campaignId, leadId);
      return lead && lead.auditStatus !== "complete";
    });

    await mapWithConcurrency(remaining, concurrency, async (leadId) => {
      const latestJob = (store.read().auditJobs || []).find(
        (item) => item.id === jobId
      );
      if (!latestJob || latestJob.status === "cancelled") return;

      const campaign = (store.read().campaigns || []).find(
        (item) => item.id === latestJob.campaignId
      );
      const lead = (campaign?.leads || []).find((item) => item.id === leadId);
      if (!lead) return recordFailure(jobId, leadId, "Lead was removed.");

      updateJob(jobId, (job) => {
        job.currentLead = lead.name || lead.business || lead.website;
      });
      updateLead(campaign.id, lead.id, (target) => {
        target.auditStatus = "running";
      });

      try {
        const audit = await auditService.createAudit(owner, {
          website: lead.website,
          companyName: lead.name || lead.business,
          niche: campaign.niche || lead.category,
          location: campaign.location || lead.location || lead.address,
          offer: latestJob.settings?.offer || campaign.offer,
          benchmarkUrls: latestJob.settings?.benchmarkUrls || [],
          runPageSpeed: latestJob.settings?.runPageSpeed === true,
          auditGoal:
            "identify evidence-grounded website, enquiry-flow, CRM, integration, automation, and product opportunities for a respectful sales conversation",
        });

        attachAuditToLead(campaign.id, lead.id, audit);
        updateJob(jobId, (job) => {
          job.completed += 1;
          job.currentLead = "";
        });
      } catch (error) {
        recordFailure(jobId, lead.id, error.message);
      }
    });

    snapshot = (store.read().auditJobs || []).find((item) => item.id === jobId);
    updateJob(jobId, (job) => {
      job.status = "complete";
      job.currentLead = "";
      job.completedAt = new Date().toISOString();
      job.completed = Math.min(job.total, Number(job.completed || 0));
      job.failed = Math.min(job.total, Number(job.failed || 0));
    });
  }

  function recordFailure(jobId, leadId, message) {
    const job = (store.read().auditJobs || []).find((item) => item.id === jobId);
    if (!job) return;
    updateLead(job.campaignId, leadId, (lead) => {
      lead.auditStatus = "failed";
      lead.auditError = String(message || "Audit failed").slice(0, 500);
    });
    updateJob(jobId, (target) => {
      target.failed += 1;
      target.currentLead = "";
      target.errors = Array.isArray(target.errors) ? target.errors : [];
      target.errors.unshift({
        leadId,
        message: String(message || "Audit failed").slice(0, 500),
        createdAt: new Date().toISOString(),
      });
      target.errors = target.errors.slice(0, 30);
    });
  }

  function failJob(jobId, error) {
    updateJob(jobId, (job) => {
      job.status = "failed";
      job.currentLead = "";
      job.completedAt = new Date().toISOString();
      job.error = String(error?.message || error || "Audit job failed").slice(
        0,
        1000
      );
    });
  }

  function attachAuditToLead(campaignId, leadId, audit) {
    updateLead(campaignId, leadId, (lead) => {
      const report = audit.report || {};
      lead.auditId = audit.id;
      lead.auditStatus = "complete";
      lead.auditScore = Number(report.score ?? audit.evidence?.target?.rawScore ?? 0);
      lead.auditSummary = clean(report.executiveSummary).slice(0, 1500);
      lead.auditCallOpening = clean(report.callOpening).slice(0, 1500);
      lead.auditEmailSubject = clean(report.emailSubject).slice(0, 180);
      lead.auditEmailBody = String(report.emailBody || "").slice(0, 12_000);
      lead.auditFindings = (report.priorityFindings || []).slice(0, 4);
      lead.auditUpdatedAt = new Date().toISOString();
      lead.auditError = "";
      lead.tags = unique([
        ...(lead.tags || []),
        "audit-ready",
        lead.auditScore >= 75
          ? "strong-digital-presence"
          : lead.auditScore >= 50
            ? "audit-opportunity"
            : "high-audit-opportunity",
      ]);
      lead.beforeCallNotes =
        lead.beforeCallNotes || lead.auditCallOpening || lead.auditSummary;
      lead.updatedAt = new Date().toISOString();
      lead.activities = Array.isArray(lead.activities) ? lead.activities : [];
      lead.activities.unshift({
        id: crypto.randomUUID(),
        type: "audit",
        actorId: audit.createdBy,
        actorName: "ReachFly Audit Agent",
        note: `Audit completed with score ${lead.auditScore}/100.`,
        auditId: audit.id,
        createdAt: new Date().toISOString(),
      });
    });
  }

  function updateLead(campaignId, leadId, mutate) {
    store.update((state) => {
      const campaign = (state.campaigns || []).find(
        (item) => item.id === campaignId
      );
      const lead = (campaign?.leads || []).find((item) => item.id === leadId);
      if (!lead) return;
      mutate(lead);
      campaign.updatedAt = new Date().toISOString();
    });
  }

  function getLead(campaignId, leadId) {
    const campaign = (store.read().campaigns || []).find(
      (item) => item.id === campaignId
    );
    return (campaign?.leads || []).find((item) => item.id === leadId) || null;
  }

  function updateJob(jobId, mutate) {
    store.update((state) => {
      const job = (state.auditJobs || []).find((item) => item.id === jobId);
      if (!job) return;
      mutate(job);
      job.updatedAt = new Date().toISOString();
    });
  }

  setImmediate(resumePendingJobs);

  return { createBatchJob, getJob, listJobs, resumePendingJobs };
}

function publicJob(job) {
  return {
    ...job,
    percent: job.total
      ? Math.round(((job.completed + job.failed) / job.total) * 100)
      : 0,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
}

function sanitizeUrls(values) {
  return unique((Array.isArray(values) ? values : []).map(String).filter(Boolean))
    .slice(0, 3);
}

function unique(values) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))];
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
