import crypto from "node:crypto";
import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";

const MAX_HTML_BYTES = Number(process.env.AUDIT_MAX_HTML_BYTES || 2_500_000);
const FETCH_TIMEOUT_MS = Number(process.env.AUDIT_FETCH_TIMEOUT_MS || 18_000);
const ANTHROPIC_TIMEOUT_MS = Number(
  process.env.ANTHROPIC_AUDIT_TIMEOUT_MS || 120_000
);
const AUTO_MINI_CONCURRENCY = clamp(
  process.env.AUDIT_AUTO_MINI_CONCURRENCY || 2,
  1,
  2
);
const MAX_QUEUE_SIZE = clamp(process.env.AUDIT_MAX_QUEUE_SIZE || 500, 25, 2_000);
const REPORT_TTL_MS = Number(
  process.env.AUDIT_REPORT_TTL_MS || 14 * 24 * 60 * 60 * 1000
);
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const GOOGLE_PLACES_TEXT_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACES_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PAGESPEED_TIMEOUT_MS = Number(process.env.AUDIT_PAGESPEED_TIMEOUT_MS || 45_000);
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL =
  process.env.ANTHROPIC_AUDIT_MODEL || "claude-sonnet-4-20250514";

const SOCIAL_HOSTS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "yelp.com",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "maps.google.com",
  "yellowpages.com",
]);

const INFRASTRUCTURE_HOSTS = new Set([
  "cloudflare.com",
  "cloudfront.net",
  "jsdelivr.net",
  "cdnjs.com",
  "unpkg.com",
  "w3.org",
  "schema.org",
  "gravatar.com",
  "doubleclick.net",
]);

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

const priorityQueue = [];
const miniQueue = [];
const running = new Map();
const BATCH_CHUNK_SIZE = clamp(
  process.env.AUDIT_BATCH_CHUNK_SIZE || 10,
  1,
  50
);
const AUDIT_LOGGING = ["1", "true", "yes", "on"].includes(
  String(process.env.AUDIT_DEBUG || "true").trim().toLowerCase()
);
let serviceRef = null;

export function createLeadAuditService({ store, workspaceService, reportTemplateProvider } = {}) {
  if (!store) {
    throw new Error("createLeadAuditService requires a store.");
  }

  const service = {
    queueMiniBatch,
    queueMiniAudit,
    queueGeneratedReport,
    listReports,
    getReport,
    createPdf,
    getQueueStats,
  };

  serviceRef = service;
  resumeQueuedReports();

  function queueMiniBatch(user, input = {}) {
    // This API is intentionally capped. Daily lead allocation must NOT call it
    // for hundreds of leads; Call Workspace generates the default Mini on demand.
    const leads = Array.isArray(input.leads) ? input.leads : [];
    const accepted = [];

    for (const lead of leads.slice(0, 25)) {
      const campaignType = normalizeCampaignType(
        lead?.dailyCampaignType || lead?.campaignType || input.campaignType || "website"
      );
      const canAudit = campaignType === "gmb"
        ? Boolean(lead?.id || lead?.placeId || lead?.business || lead?.name || lead?.address)
        : Boolean(lead?.website);
      if (!canAudit) continue;

      try {
        accepted.push(
          queueReport(user, {
            ...input,
            lead,
            leadId: lead?.id || "",
            website: lead?.website || "",
            campaignType,
            kind: "mini",
          })
        );
      } catch (error) {
        accepted.push({
          leadId: clean(lead?.id),
          website: clean(lead?.website),
          campaignType,
          status: "failed",
          error: error.message,
          kind: "mini",
        });
      }
    }

    return {
      accepted: accepted.length,
      batchSize: Math.min(BATCH_CHUNK_SIZE, 5),
      concurrency: AUTO_MINI_CONCURRENCY,
      queue: getQueueStats(),
      reports: accepted.map(publicReport),
    };
  }

  function queueMiniAudit(user, input = {}) {
    // Mini Audit is the universal pre-call report for both Website and GMB.
    // Campaign type stays separate and only changes what evidence is prioritized.
    return publicReport(
      queueReport(user, {
        ...input,
        kind: "mini",
        campaignType: normalizeCampaignType(
          input.campaignType ||
            input.auditKind ||
            input.lead?.dailyCampaignType ||
            input.lead?.campaignType ||
            "website"
        ),
      })
    );
  }

  function queueGeneratedReport(user, input = {}) {
    const kind = normalizeKind(input.kind);

    if (!["competitor", "full"].includes(kind)) {
      throw createError(400, "Report kind must be competitor or full.");
    }

    return publicReport(
      queueReport(user, {
        ...input,
        kind,
        force: input.force === true,
      })
    );
  }

  function getRuntimeTemplate(user, kind) {
    return typeof reportTemplateProvider === "function"
      ? reportTemplateProvider(user, kind)
      : null;
  }

  function templateIsCustomized(template) {
    return Boolean(
      Number(template?.version || 0) > 0 ||
      template?.examplePdf?.storagePath
    );
  }

  function resolveRuntimeTemplate(user, kind, campaignType) {
    // The production model exposes exactly three report types for BOTH tracks:
    // Mini Audit (default), Competitor Analysis, and Full Audit.
    // Website/GMB are tracks, not separate report kinds. PDFs are optional style references.
    return getRuntimeTemplate(user, kind);
  }

  function queueReport(user, input = {}) {
    const context = workspaceService?.getContext(user) || {
      user,
      workspaceId: user.workspaceId || user.id,
      workspace: null,
    };
    const kind = normalizeKind(input.kind || "mini");
    const campaignType = normalizeCampaignType(
      input.campaignType ||
        input.auditKind ||
        input.lead?.dailyCampaignType ||
        input.lead?.campaignType ||
        kind
    );
    const website = normalizeUrl(input.website || input.lead?.website);
    const leadIdentity = clean(
      input.leadId || input.lead?.id || input.placeId || input.lead?.placeId ||
        input.business || input.lead?.business || input.lead?.name ||
        input.location || input.lead?.address
    );
    const canResearchWithoutWebsite =
      campaignType === "gmb" && Boolean(leadIdentity);

    if (!website && !canResearchWithoutWebsite) {
      throw createError(
        400,
        "A valid website URL is required for Website campaign audits."
      );
    }

    const reportTemplate = resolveRuntimeTemplate(
      user,
      kind,
      campaignType
    );

    // No manager upload is required. The template service always supplies
    // a built-in ReachFly default and manager uploads only change format/style.


    const templateKey =
      reportTemplate?.templateId ||
      reportTemplate?.id ||
      `${reportTemplate?.name || "default"}:${reportTemplate?.version ?? 0}`;

    const auditIdentity = clean(input.leadId || input.lead?.id) ||
      (campaignType === "gmb"
        ? clean(input.placeId || input.lead?.placeId || leadIdentity)
        : website);
    const auditTarget = `${campaignType}:${auditIdentity || website || leadIdentity}`;
    const cacheKey = reportCacheKey(
      context.workspaceId,
      auditTarget,
      kind,
      templateKey,
      campaignType
    );
    const state = store.read();
    const existing = (state.leadAudits || []).find(
      (item) => item.cacheKey === cacheKey
    );

    if (
      existing &&
      input.force !== true &&
      ["queued", "generating", "complete"].includes(existing.status) &&
      (!existing.expiresAt || Date.parse(existing.expiresAt) > Date.now())
    ) {
      if (existing.status === "queued") enqueue(existing.id);
      if (existing.status === "complete") {
        syncAuditToLead(existing, {
          campaignId: clean(input.campaignId),
          leadId: clean(input.leadId || input.lead?.id),
        });
      }
      return existing;
    }

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      cacheKey,
      workspaceId: context.workspaceId,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      completedAt: "",
      expiresAt: new Date(Date.now() + REPORT_TTL_MS).toISOString(),
      status: "queued",
      kind,
      website,
      campaignId: clean(input.campaignId),
      leadId: clean(input.leadId || input.lead?.id),
      campaignType,
      auditType: clean(input.auditType) ||
        (kind === "mini"
          ? `${campaignType === "gmb" ? "GMB" : "Website"} Mini Audit`
          : kind === "competitor"
            ? `${campaignType === "gmb" ? "GMB" : "Website"} Competitor Analysis`
            : `${campaignType === "gmb" ? "GMB" : "Website"} Full Audit`),
      lead: sanitizeLead(input.lead || input),
      niche: clean(
        input.niche ||
          input.lead?.dailyNiche ||
          input.lead?.category
      ),
      location: clean(
        input.location ||
          input.lead?.dailyLocation ||
          input.lead?.address
      ),
      resourceType: normalizeResourceType(
        input.resourceType ||
          input.lead?.dailyResourceType ||
          input.lead?.resourceType ||
          inferResourceType(
            input.location ||
              input.lead?.dailyLocation ||
              input.lead?.address ||
              "",
            input.regionCode ||
              input.lead?.dailyRegionCode ||
              input.lead?.regionCode ||
              ""
          )
      ),
      country: clean(
        input.country ||
          input.lead?.dailyCountry ||
          input.lead?.country ||
          ""
      ),
      regionCode: clean(
        input.regionCode ||
          input.lead?.dailyRegionCode ||
          input.lead?.regionCode ||
          ""
      ).toUpperCase(),
      brand: resolveBrand({ context, store }),
      reportTemplate,
      templateId:
        reportTemplate?.templateId ||
        reportTemplate?.id ||
        "default",
      templateVersion:
        Number(reportTemplate?.version || 0),
      templateName:
        reportTemplate?.name ||
        "Default audit format",
      report: null,
      evidence: null,
      provider: "anthropic",
      error: "",
    };

    store.update((draft) => {
      draft.leadAudits = draft.leadAudits || [];

      if (existing) {
        const index = draft.leadAudits.findIndex((item) => item.id === existing.id);
        if (index >= 0) draft.leadAudits.splice(index, 1);
      }

      draft.leadAudits.unshift(record);
    });

    enqueue(record.id);
    return record;
  }

  function listReports(user, filters = {}) {
    const context = workspaceService?.getContext(user) || {
      workspaceId: user.workspaceId || user.id,
    };
    const website = filters.website ? normalizeUrl(filters.website) : "";
    const leadId = clean(filters.leadId || "");
    const track = clean(filters.track || filters.campaignType || "")
      ? normalizeCampaignType(filters.track || filters.campaignType)
      : "";

    return (store.read().leadAudits || [])
      .filter((item) => item.workspaceId === context.workspaceId)
      .filter((item) => !leadId || clean(item.leadId || item.lead?.id) === leadId)
      .filter((item) => !website || item.website === website)
      .filter((item) => !track || normalizeCampaignType(item.campaignType || item.kind) === track)
      .filter((item) => !filters.kind || item.kind === normalizeKind(filters.kind))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(publicReport);
  }

  function getReport(user, id) {
    const context = workspaceService?.getContext(user) || {
      workspaceId: user.workspaceId || user.id,
    };
    const report = (store.read().leadAudits || []).find(
      (item) => item.id === id && item.workspaceId === context.workspaceId
    );

    if (!report) throw createError(404, "Audit report not found.");
    return publicReport(report, { includeEvidence: true });
  }

  function createPdf(user, id) {
    const report = getReport(user, id);

    if (report.status !== "complete" || !report.report) {
      throw createError(409, "The audit report is not ready yet.");
    }

    return {
      filename: safeFilename(
        `${report.lead?.business || report.lead?.name || hostname(report.website)}-${report.campaignType || "website"}-${report.kind}-audit.pdf`
      ),
      buffer: renderAuditPdf(report),
    };
  }

  return service;

  function resumeQueuedReports() {
    for (const item of store.read().leadAudits || []) {
      if (["queued", "generating"].includes(item.status)) {
        store.update((draft) => {
          const target = (draft.leadAudits || []).find((entry) => entry.id === item.id);
          if (target) target.status = "queued";
        });
        enqueue(item.id);
      }
    }
  }

  function getQueueStats() {
    return {
      concurrency: AUTO_MINI_CONCURRENCY,
      batchSize: BATCH_CHUNK_SIZE,
      queued: priorityQueue.length + miniQueue.length,
      queuedMini: miniQueue.length,
      queuedPriority: priorityQueue.length,
      running: running.size,
      runningJobs: [...running.entries()].map(([id, kind]) => ({ id, kind })),
      capacity: MAX_QUEUE_SIZE,
    };
  }

  function enqueue(id) {
    if (!id || running.has(id)) return;
    if (priorityQueue.includes(id) || miniQueue.includes(id)) return;

    const record = (store.read().leadAudits || []).find((item) => item.id === id);
    if (!record) return;

    if (priorityQueue.length + miniQueue.length >= MAX_QUEUE_SIZE) {
      updateRecord(id, {
        status: "failed",
        error: "Audit queue is full. Try again shortly.",
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (["mini", "website", "gmb"].includes(record.kind)) miniQueue.push(id);
    else priorityQueue.push(id);

    auditLog("queued", { id, kind: record.kind, ...getQueueStats() });
    scheduleWorkers();
  }

  function nextQueuedId() {
    return priorityQueue.shift() || miniQueue.shift() || "";
  }

  function scheduleWorkers() {
    while (
      running.size < AUTO_MINI_CONCURRENCY &&
      (priorityQueue.length || miniQueue.length)
    ) {
      const id = nextQueuedId();
      if (!id || running.has(id)) continue;

      const record = (store.read().leadAudits || []).find((item) => item.id === id);
      if (!record) continue;

      running.set(id, record.kind);
      auditLog("worker-start", { id, kind: record.kind, ...getQueueStats() });

      void processRecord(id).finally(() => {
        running.delete(id);
        auditLog("worker-finish", { id, kind: record.kind, ...getQueueStats() });
        setImmediate(scheduleWorkers);
      });
    }
  }

  async function processRecord(id) {
    let record = (store.read().leadAudits || []).find((item) => item.id === id);
    if (!record || record.status === "complete") return;

    updateRecord(id, {
      status: "generating",
      updatedAt: new Date().toISOString(),
      error: "",
    });

    record = (store.read().leadAudits || []).find((item) => item.id === id);

    try {
      const track = normalizeCampaignType(record.campaignType || record.kind);
      const evidence = track === "gmb"
        ? await inspectGmbEvidence(record)
        : await inspectWebsiteEvidence(record);
      let report;
      let provider = "anthropic";

      try {
        report = await generateWithClaude(record, evidence);
      } catch (error) {
        provider = "deterministic-fallback";
        report = buildFallbackReport(record, evidence, error);
      }

      if (
        record.kind === "mini" &&
        (!Array.isArray(report?.issues) || report.issues.length === 0) &&
        !(report?.noMajorIssues === true && clean(report?.workingWell))
      ) {
        throw new Error(
          "Mini Audit returned neither a verified issue nor a verified positive finding. Regenerate after evidence is available."
        );
      }

      updateRecord(id, {
        status: "complete",
        report,
        evidence,
        provider,
        error: "",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const completed = (store.read().leadAudits || []).find((item) => item.id === id);
      syncAuditToLead(completed);
    } catch (error) {
      updateRecord(id, {
        status: "failed",
        error: error.message || "Audit generation failed.",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const failed = (store.read().leadAudits || []).find((item) => item.id === id);
      syncAuditToLead(failed);
    }
  }

  function syncAuditToLead(record, override = {}) {
    if (!record) return;
    const campaignId = clean(override.campaignId || record.campaignId);
    const leadId = clean(override.leadId || record.leadId || record.lead?.id);
    if (!leadId) return;

    store.update((draft) => {
      const campaigns = (draft.campaigns || []).filter((campaign) =>
        !campaignId || campaign.id === campaignId
      );
      for (const campaign of campaigns) {
        const lead = (campaign.leads || []).find((item) => item.id === leadId);
        if (!lead) continue;
        const campaignType = normalizeCampaignType(record.campaignType || record.kind);
        lead.dailyCampaignType = campaignType;
        lead.campaignType = campaignType;

        // The Mini Audit is the pre-call gate. Generating competitor/full reports
        // must never overwrite the Mini Audit or its readiness status.
        if (record.kind === "mini") {
          lead.auditKind = "mini";
          lead.auditTrack = campaignType;
          lead.auditType = campaignType === "gmb" ? "GMB Mini Audit" : "Website Mini Audit";
          lead.auditStatus = record.status === "complete" ? "ready" : record.status;
          lead.auditError = record.error || "";
          lead.auditReportId = record.id;
          lead.auditTemplateVersion = Number(record.templateVersion || 0);
          lead.auditReport = record.status === "complete" ? record.report : null;
          lead.miniAudit = record.status === "complete" ? record.report : lead.miniAudit;
          lead.miniAuditStatus = record.status === "complete" ? "completed" : record.status;
          lead.miniAuditError = record.error || "";
          lead.miniAuditReportId = record.id;
        } else if (record.kind === "competitor") {
          lead.competitorAuditTrack = campaignType;
          lead.competitorAuditType = campaignType === "gmb" ? "GMB Competitor Analysis" : "Website Competitor Analysis";
          lead.competitorAudit = record.status === "complete" ? record.report : lead.competitorAudit;
          lead.competitorAuditStatus = record.status;
          lead.competitorAuditError = record.error || "";
          lead.competitorAuditReportId = record.id;
        } else if (record.kind === "full") {
          lead.fullAuditTrack = campaignType;
          lead.fullAuditType = campaignType === "gmb" ? "GMB Full Audit" : "Website Full Audit";
          lead.fullAudit = record.status === "complete" ? record.report : lead.fullAudit;
          lead.fullAuditStatus = record.status;
          lead.fullAuditError = record.error || "";
          lead.fullAuditReportId = record.id;
        } else {
          lead.detailedAudit = record.status === "complete" ? record.report : lead.detailedAudit;
          lead.detailedAuditStatus = record.status;
          lead.detailedAuditReportId = record.id;
        }

        lead.updatedAt = new Date().toISOString();
        break;
      }
    });
  }

  function updateRecord(id, changes) {
    store.update((draft) => {
      const target = (draft.leadAudits || []).find((item) => item.id === id);
      if (target) Object.assign(target, changes);
    });
  }
}

function auditLog(event, data = {}) {
  if (!AUDIT_LOGGING) return;
  console.log(`[lead-audit] ${event} ${JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...data,
  })}`);
}

async function inspectLeadWebsite(record) {
  const url = await validatePublicUrl(record.website);
  const response = await safeFetch(url.toString());
  const $ = cheerio.load(response.html);
  const title = clean($("title").first().text());
  const metaDescription = clean($("meta[name='description']").attr("content"));
  const generator = clean($("meta[name='generator']").attr("content"));
  const bodyText = clean($("body").text()).slice(0, 140_000);
  const links = $("a[href]")
    .map((_, element) => normalizePageHref($(element).attr("href"), response.finalUrl))
    .get()
    .filter(Boolean);
  const scriptSources = $("script[src]")
    .map((_, element) => clean($(element).attr("src")))
    .get();
  const htmlLower = response.html.toLowerCase();
  const jsonLd = extractJsonLd($);
  const schemaNames = jsonLd
    .flatMap((item) => [item.name, item.legalName])
    .map(clean)
    .filter(Boolean);
  const schemaAddresses = jsonLd
    .flatMap((item) => collectSchemaAddresses(item))
    .filter(Boolean);
  const schemaHours = jsonLd
    .flatMap((item) => collectSchemaHours(item))
    .filter(Boolean);
  const schemaPeople = jsonLd
    .flatMap((item) => collectSchemaPeople(item))
    .filter(Boolean);
  const emails = uniqueStrings([
    record.lead?.email,
    ...links
      .filter((href) => href.startsWith("mailto:"))
      .map((href) => href.replace(/^mailto:/i, "").split("?")[0]),
    ...extractEmails(response.html),
  ]).filter(isLikelyEmail);
  const phones = uniqueStrings([
    record.lead?.phone,
    ...links
      .filter((href) => href.startsWith("tel:"))
      .map((href) => href.replace(/^tel:/i, "")),
    ...extractPhones(bodyText),
  ]);
  const rootHost = hostname(response.finalUrl);
  const externalServiceLinks = uniqueStrings(
    links
      .filter((href) => /^https?:/i.test(href))
      .map((href) => hostname(href))
      .filter((host) => host && host !== rootHost && !host.endsWith(`.${rootHost}`))
      .filter((host) => !isIgnoredExternalHost(host))
  ).slice(0, 12);
  const platform = detectPlatform({ generator, htmlLower, scriptSources });
  const bookingLinks = links.filter((href) =>
    /calendly|acuityscheduling|mindbody|vagaro|zocdoc|booksy|setmore|appointment|schedule|booking/i.test(
      href
    )
  );
  const hasChat =
    /intercom|crisp\.chat|tawk\.to|drift|hubspot|zendesk|freshchat|livechatinc|tidio/i.test(
      `${htmlLower} ${scriptSources.join(" ")}`
    );
  const testimonialCount = $(
    "[class*='testimonial'],[id*='testimonial'],[class*='review'],[id*='review']"
  ).length;
  const formCount = $("form").length;
  const formCtaCount = $("form button,form input[type='submit']").length;
  const faxMatches = bodyText.match(/\bfax\b[^\n]{0,45}/gi) || [];
  const h1 = $("h1")
    .map((_, element) => clean($(element).text()))
    .get()
    .filter(Boolean);
  const firstParagraph = $("main p, article p, .content p, body p")
    .map((_, element) => clean($(element).text()))
    .get()
    .find((value) => value.length >= 60 && value.length <= 450);
  const canonical = normalizePageHref($("link[rel='canonical']").attr("href"), response.finalUrl);
  const viewport = clean($("meta[name='viewport']").attr("content"));
  const imageCount = $("img").length;
  const imagesMissingAlt = $("img").filter((_, element) => !clean($(element).attr("alt"))).length;
  const schemaTypes = uniqueStrings(
    jsonLd.flatMap((item) => Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]]).filter(Boolean)
  ).slice(0, 20);

  return {
    fetchedAt: new Date().toISOString(),
    finalUrl: response.finalUrl,
    domain: rootHost,
    status: response.status,
    title,
    titleLength: title.length,
    metaDescription,
    generator,
    platform,
    siteName:
      clean(record.lead?.business || record.lead?.name) ||
      clean($("meta[property='og:site_name']").attr("content")) ||
      schemaNames[0] ||
      title.split(/[|—–-]/)[0]?.trim() ||
      hostToName(rootHost),
    phone: phones[0] || "",
    email: emails[0] || "",
    websiteAddress: schemaAddresses[0] || extractAddress(bodyText),
    googleAddress: clean(record.lead?.address),
    decisionMaker:
      schemaPeople[0] || extractDecisionMaker(bodyText) || "",
    businessHours:
      schemaHours.join("; ") || extractBusinessHours(bodyText) || "",
    description:
      metaDescription || firstParagraph || `${clean(record.niche || record.lead?.category)} business serving ${clean(record.location || record.lead?.address)}.`,
    h1: h1.slice(0, 4),
    externalServiceLinks,
    hasBooking: bookingLinks.length > 0,
    bookingLinks: bookingLinks.slice(0, 5),
    hasChat,
    testimonialCount,
    hasStructuredReviews: jsonLd.some((item) => hasReviewSchema(item)),
    hasFax: faxMatches.length > 0,
    faxEvidence: faxMatches.slice(0, 3),
    formCount,
    formCtaCount,
    hasContactForm: formCount > 0,
    hasPhoneLink: links.some((href) => href.startsWith("tel:")),
    hasEmailLink: links.some((href) => href.startsWith("mailto:")),
    hasPrivacy: links.some((href) => /privacy/i.test(href)),
    hasTerms: links.some((href) => /terms|conditions/i.test(href)),
    hasSchema: jsonLd.length > 0,
    schemaTypes,
    canonical,
    viewport,
    imageCount,
    imagesMissingAlt,
    lead: record.lead,
    niche: record.niche,
    location: record.location,
  };
}

async function inspectWebsiteEvidence(record) {
  const base = await inspectLeadWebsite(record);
  const [pageSpeed, robots, sitemap] = await Promise.all([
    inspectPageSpeed(record.website),
    probePublicTextFile(new URL("/robots.txt", base.finalUrl).toString()),
    probePublicTextFile(new URL("/sitemap.xml", base.finalUrl).toString()),
  ]);

  return {
    ...base,
    track: "website",
    pageSpeed,
    robots,
    sitemap,
  };
}

async function inspectPageSpeed(website) {
  const strategies = ["mobile", "desktop"];
  const output = {};

  for (const strategy of strategies) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGESPEED_TIMEOUT_MS);
    try {
      const url = new URL(PAGESPEED_ENDPOINT);
      url.searchParams.set("url", website);
      url.searchParams.set("strategy", strategy);
      url.searchParams.append("category", "performance");
      url.searchParams.append("category", "seo");
      url.searchParams.append("category", "accessibility");
      url.searchParams.append("category", "best-practices");

      const response = await fetch(url, { signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.lighthouseResult) {
        output[strategy] = {
          status: "not_confirmed",
          error: payload?.error?.message || `PageSpeed HTTP ${response.status}`,
        };
        continue;
      }

      const lighthouse = payload.lighthouseResult;
      const audits = lighthouse.audits || {};
      const categories = lighthouse.categories || {};
      const field = payload.loadingExperience?.metrics || {};
      const score = (key) => Number.isFinite(categories[key]?.score)
        ? Math.round(categories[key].score * 100)
        : null;
      const numeric = (key) => Number.isFinite(audits[key]?.numericValue)
        ? audits[key].numericValue
        : null;

      output[strategy] = {
        status: "confirmed",
        performance: score("performance"),
        seo: score("seo"),
        accessibility: score("accessibility"),
        bestPractices: score("best-practices"),
        lcpMs: field.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? numeric("largest-contentful-paint"),
        cls: field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ?? numeric("cumulative-layout-shift"),
        inpMs: field.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
        tbtMs: numeric("total-blocking-time"),
        totalByteWeight: numeric("total-byte-weight"),
        requestCount: Array.isArray(audits["network-requests"]?.details?.items)
          ? audits["network-requests"].details.items.length
          : null,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      output[strategy] = {
        status: "not_confirmed",
        error: error?.name === "AbortError"
          ? `PageSpeed timed out after ${PAGESPEED_TIMEOUT_MS}ms`
          : clean(error?.message) || "PageSpeed request failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return output;
}

async function probePublicTextFile(value) {
  try {
    let current = await validatePublicUrl(value);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT_MS, 12_000));
      try {
        const response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": "ReachFlyAuditBot/3.0 (+public audit evidence)" },
          signal: controller.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) return { found: false, status: response.status, url: current.toString(), sample: "", error: "Redirect had no location" };
          current = await validatePublicUrl(new URL(location, current).toString());
          continue;
        }
        const text = response.ok ? (await response.text()).slice(0, 12_000) : "";
        return { found: response.ok, status: response.status, url: current.toString(), sample: clean(text).slice(0, 2000) };
      } finally {
        clearTimeout(timer);
      }
    }
    return { found: false, status: 0, url: current.toString(), sample: "", error: "Too many redirects" };
  } catch (error) {
    return { found: false, status: 0, url: clean(value), sample: "", error: clean(error?.message) };
  }
}

async function inspectGmbEvidence(record) {
  const base = buildGmbSeedEvidence(record);
  const apiKey = clean(process.env.GOOGLE_PLACES_API_KEY);
  let target = null;
  let competitors = [];

  if (apiKey) {
    try {
      const placeId = clean(record.lead?.placeId || record.lead?.googlePlaceId);
      target = placeId
        ? await fetchGooglePlaceDetails(placeId, apiKey)
        : await searchGooglePlaces(`${base.siteName} ${record.location || base.googleAddress}`.trim(), apiKey, 1).then((items) => items[0] || null);

      const categoryQuery = clean(record.niche || record.lead?.category || target?.primaryType || "business");
      const market = clean(record.location || target?.formattedAddress || base.googleAddress);
      if (categoryQuery && market) {
        competitors = await searchGooglePlaces(`${categoryQuery} in ${market}`, apiKey, 8);
        competitors = competitors
          .filter((item) => item.id && item.id !== target?.id)
          .filter((item) => normalize(item.displayName) !== normalize(target?.displayName || base.siteName))
          .slice(0, 7);
      }
    } catch (error) {
      base.googlePlacesError = clean(error?.message) || "Google Places evidence lookup failed";
    }
  }

  const hours = target?.regularOpeningHours?.weekdayDescriptions || [];
  return {
    ...base,
    track: "gmb",
    placeId: target?.id || base.placeId || "",
    gmbProfileUrl: target?.googleMapsUri || base.gmbProfileUrl || "",
    siteName: target?.displayName || base.siteName,
    phone: target?.internationalPhoneNumber || target?.nationalPhoneNumber || base.phone,
    website: normalizeUrl(target?.websiteUri || record.website || record.lead?.website),
    googleAddress: target?.formattedAddress || base.googleAddress,
    category: clean(target?.primaryType || record.lead?.category || record.niche),
    rating: Number.isFinite(target?.rating) ? target.rating : null,
    reviewCount: Number.isFinite(target?.userRatingCount) ? target.userRatingCount : null,
    businessHours: hours.join("; ") || base.businessHours,
    businessStatus: clean(target?.businessStatus),
    competitors: competitors.map((item) => ({
      name: clean(item.displayName),
      placeId: clean(item.id),
      address: clean(item.formattedAddress),
      rating: Number.isFinite(item.rating) ? item.rating : null,
      reviewCount: Number.isFinite(item.userRatingCount) ? item.userRatingCount : null,
      website: normalizeUrl(item.websiteUri),
      mapsUrl: clean(item.googleMapsUri),
      category: clean(item.primaryType),
    })),
    source: target ? "Google Places API + public web research" : "Lead identity + public web research",
  };
}

async function fetchGooglePlaceDetails(placeId, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${GOOGLE_PLACES_DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "id,displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,rating,userRatingCount,regularOpeningHours,primaryType,types,googleMapsUri,businessStatus",
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Google Places details HTTP ${response.status}`);
    return normalizeGooglePlace(payload);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Google Places details timed out after ${FETCH_TIMEOUT_MS}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function searchGooglePlaces(textQuery, apiKey, maxResultCount = 7) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(GOOGLE_PLACES_TEXT_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.regularOpeningHours,places.primaryType,places.types,places.googleMapsUri,places.businessStatus",
      },
      body: JSON.stringify({ textQuery, maxResultCount: Math.max(1, Math.min(20, Number(maxResultCount || 7))) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Google Places search HTTP ${response.status}`);
    return (payload?.places || []).map(normalizeGooglePlace);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Google Places search timed out after ${FETCH_TIMEOUT_MS}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeGooglePlace(value = {}) {
  return {
    id: clean(value.id),
    displayName: clean(value.displayName?.text || value.displayName),
    formattedAddress: clean(value.formattedAddress),
    nationalPhoneNumber: clean(value.nationalPhoneNumber),
    internationalPhoneNumber: clean(value.internationalPhoneNumber),
    websiteUri: normalizeUrl(value.websiteUri),
    rating: Number(value.rating),
    userRatingCount: Number(value.userRatingCount),
    regularOpeningHours: value.regularOpeningHours || null,
    primaryType: clean(value.primaryType),
    types: Array.isArray(value.types) ? value.types.map(clean).filter(Boolean) : [],
    googleMapsUri: clean(value.googleMapsUri),
    businessStatus: clean(value.businessStatus),
  };
}

function buildGmbSeedEvidence(record) {
  const business = clean(record.lead?.business || record.lead?.name || "Business");
  const address = clean(record.lead?.address || record.location);
  return {
    finalUrl: "",
    domain: "",
    siteName: business,
    phone: clean(record.lead?.phone),
    email: clean(record.lead?.email),
    websiteAddress: "",
    googleAddress: address,
    decisionMaker: "",
    businessHours: "",
    description: `${business}${address ? ` serving ${address}` : ""}.`,
    h1: [],
    externalServiceLinks: [],
    hasBooking: null,
    bookingLinks: [],
    hasChat: null,
    testimonialCount: null,
    hasStructuredReviews: null,
    hasFax: false,
    faxEvidence: [],
    formCount: 0,
    formCtaCount: 0,
    hasContactForm: false,
    hasPhoneLink: false,
    hasEmailLink: false,
    hasPrivacy: false,
    hasTerms: false,
    hasSchema: false,
    titleLength: 0,
    metaDescription: "",
    platform: "",
    lead: record.lead,
    niche: record.niche,
    location: record.location,
    placeId: clean(record.lead?.placeId),
    gmbProfileUrl: clean(record.lead?.gmbProfileUrl || record.lead?.googleMapsUri),
  };
}

async function generateWithClaude(record, evidence) {
  const apiKey = clean(process.env.ANTHROPIC_API_KEY);

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured on the server.");
  }

  const kind = record.kind;
  const prompt = buildClaudePrompt(record, evidence);
  const maxUses = ["mini", "website"].includes(kind) ? 4 : kind === "gmb" ? 6 : kind === "competitor" ? 7 : 8;
  const maxTokens = ["mini", "website", "gmb"].includes(kind) ? 3_500 : 6_000;
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: maxUses,
    },
  ];
  const messages = [
    {
      role: "user",
      content: buildClaudeUserContent(
        record,
        prompt
      ),
    },
  ];
  let response = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await callAnthropic({
      apiKey,
      body: {
        model: DEFAULT_MODEL,
        max_tokens: maxTokens,
        temperature: 0.1,
        system: buildClaudeSystem(record),
        messages,
        tools,
      },
    });

    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  const text = (response?.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Claude returned no report content.");
  }

  const parsed = parseJsonObject(text);
  return normalizeGeneratedReport(record, evidence, parsed);
}

function buildClaudeUserContent(
  record,
  prompt
) {
  const blocks = [];
  const example =
    record.reportTemplate?.examplePdf;

  if (
    example?.storagePath &&
    fs.existsSync(example.storagePath)
  ) {
    try {
      const stat = fs.statSync(
        example.storagePath
      );

      if (
        stat.isFile() &&
        stat.size > 0 &&
        stat.size <= 15 * 1024 * 1024
      ) {
        const data = fs
          .readFileSync(
            example.storagePath
          )
          .toString("base64");

        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type:
              "application/pdf",
            data,
          },
          title:
            clean(
              example.originalName ||
                `${record.kind}-audit-reference.pdf`
            ).slice(0, 200),
          context:
            "Manager-approved formatting reference. Use it only for layout direction, section emphasis, writing style, and presentation conventions. Do not transfer facts from this example into the current lead report.",
        });
      }
    } catch (error) {
      auditLog(
        "example-pdf-read-failed",
        {
          kind: record.kind,
          templateVersion:
            record.templateVersion || 0,
          message:
            error?.message ||
            String(error),
        }
      );
    }
  }

  blocks.push({
    type: "text",
    text: prompt,
  });

  return blocks.length === 1
    ? prompt
    : blocks;
}

function normalizeResourceType(value) {
  const normalized = String(
    value || ""
  )
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

function inferResourceType(
  location,
  regionCode = ""
) {
  const region = String(
    regionCode || ""
  )
    .trim()
    .toUpperCase();

  if (region === "PK") {
    return "local";
  }

  const text = String(
    location || ""
  ).toLowerCase();

  return [
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
  ].some((item) =>
    text.includes(item)
  )
    ? "local"
    : "international";
}

function cleanMultiline(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\t ]+/g, " ")
        .trimEnd()
    )
    .join("\n")
    .trim();
}

async function callAnthropic({ apiKey, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          `Anthropic request failed with HTTP ${response.status}.`
      );
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Anthropic audit timed out after ${ANTHROPIC_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildClaudeSystem(record) {
  const brandName = record.brand.name;
  const brandWebsite = record.brand.website || "the parent workspace website";
  const managerGuidance = cleanMultiline(record.reportTemplate?.managerSystemPrompt || "");

  return [
    `You are a lead-audit analyst for ${brandName} (${brandWebsite}).`,
    "Website and Google Business Profile (GMB/GBP) are independent audit tracks. Never blend their scores or findings.",
    "Use only publicly accessible evidence retrieved during this run or verified evidence supplied in the input.",
    "Never invent ratings, review counts, rankings, competitors, owners, technologies, addresses, hours, PageSpeed scores, Core Web Vitals, or URLs.",
    "If a fact cannot be retrieved, write exactly: Not confirmed — verify on call.",
    "Do not run active security scans. Do not claim legal, accessibility, privacy, or security compliance.",
    "Competitor Analysis is client-facing: descriptive findings only, no internal service pitch or pricing.",
    "Full Audit is internal-only and may contain an opportunity/build plan.",
    "Return one valid JSON object only, with no markdown fences or prose outside JSON.",
    "Any manager PDF is optional and controls presentation/style only; never copy its facts into another lead.",
    managerGuidance ? `Workspace style guidance: ${managerGuidance}` : "",
  ].filter(Boolean).join(" ");
}

function buildClaudePrompt(record, evidence) {
  const brand = record.brand;
  const track = normalizeCampaignType(record.campaignType || record.lead?.dailyCampaignType || record.lead?.campaignType || "website");
  const isGmb = track === "gmb";
  const today = new Date().toISOString().slice(0, 10);
  const base = {
    reportKind: record.kind,
    auditTrack: track,
    business_name: clean(record.lead?.business || record.lead?.name || evidence.siteName),
    website_url: record.website || evidence.website || "",
    gmb_profile_url: clean(record.lead?.gmbProfileUrl || record.lead?.googleMapsUri || evidence.gmbProfileUrl),
    place_id: clean(record.lead?.placeId || evidence.placeId),
    city_market: clean(record.location || record.lead?.address),
    primary_search_term: clean(record.niche || record.lead?.category),
    industry: clean(record.niche || record.lead?.category),
    agency_name: brand.name || "ReachFly",
    audit_date: today,
    verifiedEvidence: evidence,
    template: {
      name: record.reportTemplate?.name || record.templateName || "ReachFly default",
      lengthGuidance: record.reportTemplate?.lengthGuidance || "",
      instructions: record.reportTemplate?.instructions || "",
    },
  };

  const gmbWeights = {
    reviewVolumeVsCompetitors: 25,
    ratingWeightedBySample: 15,
    hoursAccuracy: 10,
    businessNameCategoryKeywordPresence: 10,
    addressPrecision: 5,
    photosVisualAssets: 10,
    descriptionServicesCompleteness: 10,
    reviewRecencyVelocity: 10,
    ownerReviewResponses: 5,
  };
  const websiteWeights = {
    searchRankingPosition: 25,
    technicalSeoPerformance: 20,
    localServicePageDepth: 15,
    conversionPath: 15,
    domainConsolidation: 10,
    onPageTrustSignals: 15,
  };

  if (record.kind === "mini") {
    const shape = {
      track,
      title: `${isGmb ? "GMB" : "Website"} Mini Audit`,
      score10: 0,
      grade: "A|B|C|D|F",
      currentStanding: "",
      hook: "",
      suggestedOpener: "",
      noMajorIssues: false,
      workingWell: "",
      snapshot: isGmb ? {
        businessName: "", category: "", phone: "", address: "", website: "", rating: null, reviewCount: null, businessHours: "", whatTheyDo: "",
      } : {
        businessName: "", phone: "", email: "", website: "", platform: "", decisionMaker: "Not confirmed — verify on call", businessHours: "Not confirmed — verify on call", whatTheyDo: "", mobilePageSpeed: null, searchPosition: "",
      },
      issues: [{ tag: "", finding: "", pain: "", source: "" }],
      footer: "",
    };
    return `${JSON.stringify(base)}\n\nGenerate ONLY the ${isGmb ? "GMB" : "Website"} Mini Audit. It is the DEFAULT pre-call audit and must fit one screen / under 15 seconds to skim. ${isGmb ? `Use this GMB scoring framework: ${JSON.stringify(gmbWeights)}. Research the target profile and 5-7 nearby competitors when possible. Include current rating/review count, local standing, one sharp hook, up to 3 strongest talking points, and a suggested opener.` : `Use this Website scoring framework: ${JSON.stringify(websiteWeights)}. Use the supplied live PageSpeed/mobile-desktop technical evidence plus live search. Include search standing, mobile PageSpeed when confirmed, one sharp hook, up to 3 strongest talking points, and a suggested opener.`} Grade scale: A >= 8.0, B >= 6.5, C >= 5.0, D >= 3.5, F < 3.5. Every issue must be verified. If no material issue is verified, set noMajorIssues=true, issues=[], and workingWell to one concise verified strength so the caller sees "✓ No major issues found — [what is actually working]". If something cannot be confirmed, say Not confirmed — verify on call. Return exactly this JSON shape:\n${JSON.stringify(shape, null, 2)}`;
  }

  if (record.kind === "competitor") {
    const shape = isGmb ? {
      track,
      title: "GMB Competitor Analysis",
      atAGlance: { rating: null, reviewCount: null, hoursStatus: "", score10: 0, grade: "" },
      marketQuery: "",
      targetVisibility: "",
      competitors: [{ name: "", distance: "", rating: null, reviewCount: null, location: "", evidence: [""] }],
      profileFindings: [{ title: "", evidence: "", whyItMatters: "" }],
      competitiveGaps: [{ title: "", evidence: "", businessImpact: "" }],
      whatThisConfirms: "",
      disclaimer: "",
    } : {
      track,
      title: "Website Competitor Analysis",
      atAGlance: { searchStatus: "", localPageStatus: "", directoryStatus: "", mobilePageSpeed: null, score10: 0, grade: "" },
      marketQuery: "",
      targetVisibility: "",
      competitors: [{ name: "", domain: "", location: "", observedAdvantages: [""], evidence: [""] }],
      visibilityTable: [],
      directoryTable: [],
      technicalTable: [],
      scoreTable: [],
      competitiveGaps: [{ title: "", evidence: "", businessImpact: "" }],
      whatThisConfirms: "",
      disclaimer: "",
    };
    return `${JSON.stringify(base)}\n\nGenerate ONLY the ${isGmb ? "GMB" : "Website"} Competitor Analysis. This is CLIENT-FACING and must contain no internal service pitch, pricing, recommendations, or sales talking points. ${isGmb ? "Find 5-7 nearby competitors when possible and compare rating/reviews/hours/profile signals." : "Run the exact customer search, identify 3 competitors ranking above the target (or top 3 if target does not rank), compare local/service pages, directories, conversion/trust, and best-effort technical health."} Use only verified live evidence. Return exactly this JSON shape:\n${JSON.stringify(shape, null, 2)}`;
  }

  const shape = isGmb ? {
    track,
    title: "GMB Full Audit",
    internalHeader: `INTERNAL — ${String(brand.name || "REACHFLY").toUpperCase()} USE ONLY — DO NOT SEND TO CLIENT`,
    executiveSummary: "",
    score10: 0,
    grade: "",
    businessIdentification: {},
    sectionScores: [],
    priorityFindings: [{ title: "", severity: "critical|high|medium", evidence: "", businessImpact: "", recommendation: "", source: "" }],
    reviewAnalysis: [],
    competitors: [],
    keywordAnalysis: [],
    localSeoProminence: "",
    rankingOpportunity: "",
    notYetAssessed: [""],
    roadmap: [{ phase: "", timeframe: "", actions: [""] }],
    methodology: "",
    disclaimer: "",
  } : {
    track,
    title: "Website Full Audit",
    internalHeader: `INTERNAL — ${String(brand.name || "REACHFLY").toUpperCase()} USE ONLY — DO NOT SEND TO CLIENT`,
    executiveSummary: "",
    score10: 0,
    grade: "",
    businessIdentification: {},
    sectionScores: [],
    technicalLiveResults: {},
    priorityFindings: [{ title: "", severity: "critical|high|medium", evidence: "", businessImpact: "", recommendation: "", source: "" }],
    seoTrustAudit: [],
    competitors: [],
    keywordAnalysis: [],
    rankingTests: [],
    notYetAssessed: [""],
    roadmap: [{ phase: "", timeframe: "", actions: [""] }],
    methodology: "",
    disclaimer: "",
  };
  return `${JSON.stringify(base)}\n\nGenerate ONLY the ${isGmb ? "GMB" : "Website"} Full Audit. This is INTERNAL ONLY. ${isGmb ? `Use the GMB weighted score ${JSON.stringify(gmbWeights)} and include business identification, score table, issues, review analysis, local competitors, keyword/local SEO, prominence, ranking opportunity, not-yet-assessed fields, and a build plan.` : `Use the Website weighted score ${JSON.stringify(websiteWeights)} and include the actual PageSpeed mobile/desktop results, CWV, HTTPS, title/meta/H1, alt text, canonical, sitemap, robots, schema, mobile viewport, page weight/request count when confirmed; then SEO/trust, issues, competitors, keyword/ranking tests, not-yet-assessed fields, and a build plan.`} Grade scale: A >= 8.0, B >= 6.5, C >= 5.0, D >= 3.5, F < 3.5. Never estimate technical scores. Return exactly this JSON shape:\n${JSON.stringify(shape, null, 2)}`;
}

function normalizeGeneratedReport(record, evidence, value) {
  const track = normalizeCampaignType(record.campaignType || record.kind);
  const isGmb = track === "gmb";
  const score10 = normalizeScore10(value.score10 ?? value.score);
  const grade = clean(value.grade) || gradeFromTen(score10);

  if (["website", "gmb"].includes(record.kind)) {
    // Backward compatibility only for historical queued records. New requests never create these kinds.
    return {
      title: clean(value.title) || `${record.kind === "gmb" ? "GMB" : "Website"} Legacy Audit`,
      summary: clean(value.summary || value.executiveSummary),
      score: Math.round(score10 * 10),
      score10,
      grade,
      findings: Array.isArray(value.findings) ? value.findings.slice(0, 12) : [],
      disclaimer: clean(value.disclaimer) || "Historical compatibility report.",
    };
  }

  if (record.kind === "mini") {
    const normalizedIssues = (Array.isArray(value.issues) ? value.issues : [])
      .map((item) => ({
        tag: clean(item.tag || item.title),
        finding: oneSentence(item.finding || item.evidence),
        pain: oneSentence(item.pain || item.businessImpact || item.whyItMatters),
        source: clean(item.source),
      }))
      .filter((item) => item.tag && item.finding && item.pain && item.source)
      .slice(0, 3);

    const fallback = buildFallbackMini(record, evidence);
    const finalIssues = [...normalizedIssues];
    for (const item of fallback.issues || []) {
      if (finalIssues.length >= 3) break;
      if (!finalIssues.some((existing) => normalize(existing.tag) === normalize(item.tag))) finalIssues.push(item);
    }
    const noMajorIssues = Boolean(value.noMajorIssues) && !finalIssues.length;
    const workingWell = clean(value.workingWell);
    if (!finalIssues.length && !(noMajorIssues && workingWell)) {
      // Claude may return no issue when the verified evidence is genuinely healthy.
      // In that case the supplied audit contract requires an explicit positive
      // "No major issues found" talking point rather than inventing a problem.
      const fallbackPositive = clean(fallback.workingWell);
      if (!fallbackPositive) {
        throw new Error("Mini Audit returned neither a verified issue nor a verified positive finding.");
      }
    }

    const finalNoMajorIssues = !finalIssues.length;
    const finalWorkingWell = workingWell || clean(fallback.workingWell);
    const snapshotValue = value.snapshot || {};
    return {
      track,
      title: clean(value.title) || `${isGmb ? "GMB" : "Website"} Mini Audit`,
      score10,
      score: Math.round(score10 * 10),
      grade,
      currentStanding: clean(value.currentStanding),
      hook: clean(value.hook),
      suggestedOpener: clean(value.suggestedOpener),
      noMajorIssues: finalNoMajorIssues,
      workingWell: finalWorkingWell,
      header: {
        confidentiality: "INTERNAL - SALES TEAM USE ONLY - DO NOT SEND TO CLIENT",
        brandLine: `${record.brand.name.toUpperCase()} · ${isGmb ? "GMB" : "WEBSITE"} MINI AUDIT · ${new Date().toISOString().slice(0, 10)}`,
        title: clean(value.header?.title) || `${clean(snapshotValue.businessName) || evidence.siteName || record.lead?.business || "Business"} - ${isGmb ? "GMB" : "Website"} Mini Audit`,
        subtitle: "One screen. Everything you need before you dial.",
      },
      snapshot: {
        businessName: clean(snapshotValue.businessName) || evidence.siteName || record.lead?.business || record.lead?.name,
        phone: clean(snapshotValue.phone) || evidence.phone || "Not confirmed — verify on call",
        email: clean(snapshotValue.email) || evidence.email || "Not confirmed — verify on call",
        website: clean(snapshotValue.website) || evidence.website || evidence.domain || record.website || "Not confirmed — verify on call",
        platform: clean(snapshotValue.platform) || evidence.platform || (isGmb ? "Google Business Profile" : "Not confirmed — verify on call"),
        decisionMaker: clean(snapshotValue.decisionMaker) || evidence.decisionMaker || "Not confirmed — verify on call",
        businessHours: clean(snapshotValue.businessHours) || evidence.businessHours || "Not confirmed — verify on call",
        whatTheyDo: clean(snapshotValue.whatTheyDo) || evidence.description || "Not confirmed — verify on call",
        category: clean(snapshotValue.category) || evidence.category || record.niche || "",
        address: clean(snapshotValue.address) || evidence.googleAddress || record.location || "",
        rating: numberOrNull(snapshotValue.rating ?? evidence.rating),
        reviewCount: numberOrNull(snapshotValue.reviewCount ?? evidence.reviewCount),
        mobilePageSpeed: numberOrNull(snapshotValue.mobilePageSpeed ?? evidence.pageSpeed?.mobile?.performance),
        searchPosition: clean(snapshotValue.searchPosition),
      },
      issues: finalIssues,
      footer: clean(value.footer) || `INTERNAL USE ONLY. ${isGmb ? "GMB" : "Website"} findings are kept separate and based on public evidence observed ${new Date().toISOString().slice(0, 10)}.`,
    };
  }

  if (record.kind === "competitor") {
    const competitors = (Array.isArray(value.competitors) ? value.competitors : [])
      .slice(0, isGmb ? 7 : 5)
      .map((item) => ({
        name: clean(item.name),
        domain: clean(item.domain),
        distance: clean(item.distance),
        location: clean(item.location || item.address),
        rating: numberOrNull(item.rating),
        reviewCount: numberOrNull(item.reviewCount),
        observedAdvantages: toStringArray(item.observedAdvantages, 6),
        evidence: toStringArray(item.evidence, 8),
      }))
      .filter((item) => item.name || item.domain);
    if (!competitors.length) throw new Error("Competitor Analysis did not return verified competitors.");

    return {
      track,
      title: clean(value.title) || `${isGmb ? "GMB" : "Website"} Competitor Analysis`,
      atAGlance: value.atAGlance && typeof value.atAGlance === "object" ? value.atAGlance : {},
      score10,
      score: Math.round(score10 * 10),
      grade,
      executiveSummary: clean(value.executiveSummary),
      marketQuery: clean(value.marketQuery),
      targetVisibility: clean(value.targetVisibility),
      competitors,
      profileFindings: Array.isArray(value.profileFindings) ? value.profileFindings.slice(0, 10) : [],
      visibilityTable: Array.isArray(value.visibilityTable) ? value.visibilityTable.slice(0, 10) : [],
      directoryTable: Array.isArray(value.directoryTable) ? value.directoryTable.slice(0, 10) : [],
      technicalTable: Array.isArray(value.technicalTable) ? value.technicalTable.slice(0, 10) : [],
      scoreTable: Array.isArray(value.scoreTable) ? value.scoreTable.slice(0, 10) : [],
      competitiveGaps: (Array.isArray(value.competitiveGaps) ? value.competitiveGaps : []).slice(0, 10).map((item) => ({
        title: clean(item.title), evidence: clean(item.evidence), businessImpact: clean(item.businessImpact || item.whyItMatters),
      })),
      whatThisConfirms: clean(value.whatThisConfirms),
      salesTalkingPoints: [],
      disclaimer: clean(value.disclaimer) || "Client-facing comparison based only on verified public evidence; no recommendations or pricing included.",
    };
  }

  const findings = (Array.isArray(value.priorityFindings) ? value.priorityFindings : []).slice(0, 15).map((item) => ({
    title: clean(item.title),
    severity: normalizeSeverity(item.severity),
    evidence: clean(item.evidence),
    businessImpact: clean(item.businessImpact),
    recommendation: clean(item.recommendation),
    source: clean(item.source),
  })).filter((item) => item.title && item.evidence);
  if (!findings.length) throw new Error("Full Audit produced no verified priority findings.");

  return {
    track,
    title: clean(value.title) || `${isGmb ? "GMB" : "Website"} Full Audit`,
    internalHeader: clean(value.internalHeader) || `INTERNAL — ${String(record.brand.name || "REACHFLY").toUpperCase()} USE ONLY — DO NOT SEND TO CLIENT`,
    executiveSummary: clean(value.executiveSummary),
    score10,
    score: Math.round(score10 * 10),
    grade,
    businessIdentification: value.businessIdentification && typeof value.businessIdentification === "object" ? value.businessIdentification : {},
    sectionScores: Array.isArray(value.sectionScores) ? value.sectionScores.slice(0, 20) : [],
    strengths: toStringArray(value.strengths, 8),
    priorityFindings: findings,
    technicalLiveResults: value.technicalLiveResults && typeof value.technicalLiveResults === "object" ? value.technicalLiveResults : (evidence.pageSpeed || {}),
    technicalReview: normalizeReviewRows(value.technicalReview),
    seoAndLocalVisibility: normalizeReviewRows(value.seoAndLocalVisibility),
    conversionAndTrust: normalizeReviewRows(value.conversionAndTrust),
    reviewAnalysis: Array.isArray(value.reviewAnalysis) ? value.reviewAnalysis.slice(0, 20) : [],
    competitors: Array.isArray(value.competitors) ? value.competitors.slice(0, 10) : [],
    seoTrustAudit: Array.isArray(value.seoTrustAudit) ? value.seoTrustAudit.slice(0, 20) : [],
    keywordAnalysis: Array.isArray(value.keywordAnalysis) ? value.keywordAnalysis.slice(0, 30) : [],
    rankingTests: Array.isArray(value.rankingTests) ? value.rankingTests.slice(0, 20) : [],
    localSeoProminence: clean(value.localSeoProminence),
    rankingOpportunity: clean(value.rankingOpportunity),
    competitorSummary: clean(value.competitorSummary),
    notYetAssessed: toStringArray(value.notYetAssessed, 20),
    roadmap: Array.isArray(value.roadmap) ? value.roadmap.slice(0, 6).map((item) => ({ phase: clean(item.phase), timeframe: clean(item.timeframe), actions: toStringArray(item.actions, 8) })) : [],
    methodology: clean(value.methodology),
    disclaimer: clean(value.disclaimer) || "Internal evidence-grounded audit. Re-verify time-sensitive public metrics before the call.",
  };
}

function normalizeScore10(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(Math.max(0, Math.min(number > 10 ? number / 10 : number, 10)).toFixed(2));
}

function gradeFromTen(value) {
  const score = Number(value || 0);
  if (score >= 8) return "A";
  if (score >= 6.5) return "B";
  if (score >= 5) return "C";
  if (score >= 3.5) return "D";
  return "F";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildFallbackReport(record, evidence, error) {
  if (record.kind !== "mini") {
    throw new Error(`Live ${record.kind} research failed: ${error.message}`);
  }
  const mini = buildFallbackMini(record, evidence);
  if (!mini.issues?.length && !mini.workingWell) {
    throw new Error(`Mini Audit live research failed and no verified fallback findings or positive evidence were available: ${error.message}`);
  }
  return {
    ...mini,
    generationNote: `Claude fallback used: ${error.message}`,
  };
}

function buildFallbackMini(record, evidence) {
  const track = normalizeCampaignType(record.campaignType || record.kind);
  const isGmb = track === "gmb";
  const issues = [];
  const add = (tag, finding, pain, source = evidence.finalUrl || evidence.gmbProfileUrl || evidence.source || "Verified public evidence") => {
    if (issues.length >= 3 || !clean(finding) || !clean(pain)) return;
    issues.push({ tag, finding: oneSentence(finding), pain: oneSentence(pain), source: clean(source) || "Verified public evidence" });
  };

  if (isGmb) {
    const targetReviews = numberOrNull(evidence.reviewCount);
    const competitorReviews = (evidence.competitors || []).map((item) => Number(item.reviewCount)).filter(Number.isFinite);
    const maxCompetitorReviews = competitorReviews.length ? Math.max(...competitorReviews) : null;
    if (targetReviews !== null && maxCompetitorReviews !== null && targetReviews < maxCompetitorReviews) {
      add("review volume gap", `${evidence.siteName} has ${targetReviews} Google reviews while the strongest verified nearby competitor has ${maxCompetitorReviews}.`, "Lower review volume can reduce trust when customers compare nearby options.", evidence.gmbProfileUrl || "Google Places API");
    }
    const rating = numberOrNull(evidence.rating);
    const competitorRatings = (evidence.competitors || []).map((item) => Number(item.rating)).filter(Number.isFinite);
    const maxRating = competitorRatings.length ? Math.max(...competitorRatings) : null;
    if (rating !== null && maxRating !== null && rating < maxRating) {
      add("rating disadvantage", `${evidence.siteName} has a verified Google rating of ${rating}, below a nearby competitor at ${maxRating}.`, "A visible rating disadvantage can push comparison shoppers toward another listing.", evidence.gmbProfileUrl || "Google Places API");
    }
    if (evidence.businessStatus && normalize(evidence.businessStatus) !== "operational") {
      add("profile business status", `Google Places reports the business status as ${evidence.businessStatus}.`, "An unexpected public status can stop customers from choosing or contacting the business.", evidence.gmbProfileUrl || "Google Places API");
    }
    return makeFallbackMiniReport(record, evidence, issues, track);
  }

  if (evidence.websiteAddress && evidence.googleAddress && normalize(evidence.websiteAddress) !== normalize(evidence.googleAddress)) {
    add("NAP citation conflict", `The website address is shown as ${evidence.websiteAddress}, while the lead/Google address is ${evidence.googleAddress}.`, "Customers can lose confidence or arrive at the wrong location.");
  }
  if (evidence.pageSpeed?.mobile?.status === "confirmed" && Number(evidence.pageSpeed.mobile.performance) < 50) {
    add("slow mobile PageSpeed", `Google PageSpeed measured the mobile performance score at ${evidence.pageSpeed.mobile.performance}/100.`, "A slow mobile experience can lose high-intent visitors before they contact the business.", "Google PageSpeed Insights API");
  }
  if (!evidence.metaDescription) add("missing meta description", "The reviewed homepage does not provide a meta description.", "Searchers may see an unclear or inconsistent search preview.");
  if (!evidence.hasBooking && !evidence.hasChat && evidence.hasContactForm) add("static contact path", "The reviewed site relies on a contact form without detected booking or live chat.", "High-intent visitors cannot complete the next step immediately.");
  if (Number(evidence.imagesMissingAlt || 0) > 0) add("image alt text gaps", `${evidence.imagesMissingAlt} images on the reviewed homepage have no non-empty alt text.`, "Missing descriptive image text weakens page clarity for search engines and assistive technology.");

  return makeFallbackMiniReport(record, evidence, issues, track);
}

function makeFallbackMiniReport(record, evidence, issues, track) {
  const isGmb = track === "gmb";
  let workingWell = "";

  if (!issues.length && isGmb) {
    const rating = numberOrNull(evidence.rating);
    const reviews = numberOrNull(evidence.reviewCount);
    if (rating !== null && reviews !== null) {
      workingWell = `${evidence.siteName || record.lead?.business || "The business"} has a verified Google rating of ${rating} from ${reviews} reviews.`;
    } else if (normalize(evidence.businessStatus) === "operational") {
      workingWell = "Google Places confirms the business profile is operational.";
    }
  }

  if (!issues.length && !isGmb) {
    if (evidence.pageSpeed?.mobile?.status === "confirmed" && Number(evidence.pageSpeed.mobile.performance) >= 50) {
      workingWell = `Google PageSpeed measured mobile performance at ${evidence.pageSpeed.mobile.performance}/100.`;
    } else if (evidence.metaDescription) {
      workingWell = "The reviewed homepage has a verified meta description in place.";
    } else if (evidence.hasBooking || evidence.hasChat) {
      workingWell = "The reviewed website provides a verified direct booking or chat conversion path.";
    }
  }

  return {
    track,
    title: `${isGmb ? "GMB" : "Website"} Mini Audit`,
    score10: 0,
    score: 0,
    grade: "",
    currentStanding: "",
    hook: issues[0]?.finding || "",
    suggestedOpener: "",
    noMajorIssues: !issues.length && Boolean(workingWell),
    workingWell,
    header: {
      confidentiality: "INTERNAL - SALES TEAM USE ONLY - DO NOT SEND TO CLIENT",
      brandLine: `${record.brand.name.toUpperCase()} · ${isGmb ? "GMB" : "WEBSITE"} MINI AUDIT · ${new Date().toISOString().slice(0, 10)}`,
      title: `${evidence.siteName || record.lead?.business || "Business"} - ${isGmb ? "GMB" : "Website"} Mini Audit`,
      subtitle: "One screen. Everything you need before you dial.",
    },
    snapshot: {
      businessName: evidence.siteName || record.lead?.business || record.lead?.name,
      phone: evidence.phone || "Not confirmed — verify on call",
      email: evidence.email || "Not confirmed — verify on call",
      website: evidence.website || evidence.domain || record.website || "Not confirmed — verify on call",
      platform: isGmb ? "Google Business Profile" : (evidence.platform || "Not confirmed — verify on call"),
      decisionMaker: evidence.decisionMaker || "Not confirmed — verify on call",
      businessHours: evidence.businessHours || "Not confirmed — verify on call",
      whatTheyDo: evidence.description || "Not confirmed — verify on call",
      category: evidence.category || record.niche || "",
      address: evidence.googleAddress || record.location || "",
      rating: numberOrNull(evidence.rating),
      reviewCount: numberOrNull(evidence.reviewCount),
      mobilePageSpeed: numberOrNull(evidence.pageSpeed?.mobile?.performance),
    },
    issues: issues.slice(0, 3),
    footer: `INTERNAL USE ONLY. ${isGmb ? "GMB" : "Website"} findings only; verify time-sensitive public details before the call.`,
  };
}

function resolveBrand({ context, store }) {
  const appSettings =
    store.read().workspaceSettings?.[context.workspaceId]?.app || {};
  const user = context.user || {};
  const workspace = context.workspace || {};
  const emailDomain = String(user.email || "").split("@")[1]?.toLowerCase() || "";
  const inferredWebsite =
    emailDomain && !FREE_EMAIL_DOMAINS.has(emailDomain)
      ? `https://${emailDomain}`
      : "";

  return {
    name: clean(
      appSettings.workspaceName ||
        workspace.name ||
        user.companyName ||
        user.name ||
        "ReachFly.Ai"
    ),
    website: normalizeUrl(
      appSettings.brandWebsite ||
        user.companyWebsite ||
        inferredWebsite ||
        process.env.AUDIT_BRAND_WEBSITE ||
        ""
    ),
  };
}

function sanitizeLead(input = {}) {
  return {
    id: clean(input.id),
    business: clean(input.business || input.name),
    name: clean(input.name || input.business),
    website: normalizeUrl(input.website),
    email: isLikelyEmail(input.email) ? clean(input.email).toLowerCase() : "",
    phone: clean(input.phone),
    address: clean(input.address),
    category: clean(input.category),
    placeId: clean(input.placeId || input.googlePlaceId),
    gmbProfileUrl: clean(input.gmbProfileUrl || input.googleMapsUri || input.googleMapsUrl),
    qualityScore: Number(input.qualityScore || input.confidence || 0),
    dailyNiche: clean(input.dailyNiche || input.niche),
    dailyLocation: clean(input.dailyLocation || input.location),
    dailyResourceType: normalizeResourceType(
      input.dailyResourceType ||
        input.resourceType ||
        inferResourceType(
          input.dailyLocation ||
            input.location ||
            input.address ||
            "",
          input.dailyRegionCode ||
            input.regionCode ||
            ""
        )
    ),
    dailyCountry: clean(
      input.dailyCountry ||
        input.country ||
        ""
    ),
    dailyRegionCode: clean(
      input.dailyRegionCode ||
        input.regionCode ||
        ""
    ).toUpperCase(),
  };
}

function publicReport(record, { includeEvidence = false } = {}) {
  if (!record) return null;

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    status: record.status,
    kind: record.kind,
    campaignType: record.campaignType || normalizeCampaignType(record.kind),
    track: record.campaignType || normalizeCampaignType(record.kind),
    auditType: record.auditType || "",
    campaignId: record.campaignId || "",
    leadId: record.leadId || record.lead?.id || "",
    website: record.website,
    lead: record.lead,
    niche: record.niche,
    location: record.location,
    resourceType:
      record.resourceType ||
      "international",
    country: record.country || "",
    regionCode:
      record.regionCode || "",
    template: {
      id:
        record.templateId ||
        "default",
      version:
        Number(
          record.templateVersion || 0
        ),
      name:
        record.templateName ||
        "Default audit format",
    },
    brand: record.brand,
    report: record.report,
    provider: record.provider,
    error: record.error,
    ...(includeEvidence ? { evidence: record.evidence } : {}),
  };
}

function reportCacheKey(
  workspaceId,
  website,
  kind,
  templateKey = "default",
  campaignType = "website"
) {
  return crypto
    .createHash("sha256")
    .update(
      `${workspaceId}|${normalizeCampaignType(campaignType)}|${kind}|${website}|${templateKey}`
    )
    .digest("hex");
}

async function safeFetch(value) {
  let current = await validatePublicUrl(value);

  for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "ReachFlyAuditBot/2.0 (+public website audit)",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Website redirect did not include a location.");
        current = await validatePublicUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) {
        throw new Error(`Website returned HTTP ${response.status}.`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw new Error(`Unsupported website content type: ${contentType || "unknown"}.`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Website response body was unavailable.");
      const chunks = [];
      let size = 0;

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > MAX_HTML_BYTES) {
          await reader.cancel();
          throw new Error(`Website HTML exceeded ${MAX_HTML_BYTES} bytes.`);
        }
        chunks.push(Buffer.from(chunk));
      }

      return {
        finalUrl: current.toString(),
        status: response.status,
        html: Buffer.concat(chunks).toString("utf8"),
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Website request timed out after ${FETCH_TIMEOUT_MS}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Website redirected too many times.");
}

async function validatePublicUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) throw createError(400, "A valid public HTTP or HTTPS URL is required.");
  const url = new URL(normalized);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw createError(400, "Only HTTP and HTTPS websites can be audited.");
  }

  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    throw createError(400, "Local or private websites cannot be audited.");
  }

  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
    throw createError(400, "The website resolves to a private or unsupported address.");
  }

  return url;
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 0 ||
      parts[0] >= 224
    );
  }
  if (version === 6) {
    const value = address.toLowerCase();
    return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  }
  return true;
}

function extractJsonLd($) {
  const output = [];
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      flattenJsonLd(parsed, output);
    } catch {
      // Ignore invalid public JSON-LD.
    }
  });
  return output;
}

function flattenJsonLd(value, output) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return;
  }
  output.push(value);
  if (Array.isArray(value["@graph"])) {
    for (const item of value["@graph"]) flattenJsonLd(item, output);
  }
}

function collectSchemaAddresses(item) {
  const values = [];
  const addresses = [item.address, item.location?.address].filter(Boolean);
  for (const address of addresses) {
    if (typeof address === "string") values.push(clean(address));
    else if (address && typeof address === "object") {
      values.push(
        clean(
          [
            address.streetAddress,
            address.addressLocality,
            address.addressRegion,
            address.postalCode,
            address.addressCountry,
          ]
            .filter(Boolean)
            .join(", ")
        )
      );
    }
  }
  return values.filter(Boolean);
}

function collectSchemaHours(item) {
  const raw = item.openingHours || item.openingHoursSpecification;
  if (!raw) return [];
  if (typeof raw === "string") return [clean(raw)];
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (typeof entry === "string") return clean(entry);
        const days = Array.isArray(entry.dayOfWeek)
          ? entry.dayOfWeek.map((day) => String(day).split("/").pop()).join(", ")
          : String(entry.dayOfWeek || "").split("/").pop();
        return clean(`${days}: ${entry.opens || ""}-${entry.closes || ""}`);
      })
      .filter(Boolean);
  }
  return [];
}

function collectSchemaPeople(item) {
  const candidates = [item.founder, item.employee, item.member, item.author].flat().filter(Boolean);
  return candidates
    .map((person) => {
      if (typeof person === "string") return clean(person);
      const name = clean(person.name);
      const title = clean(person.jobTitle);
      return clean([name, title].filter(Boolean).join(" - "));
    })
    .filter(Boolean)
    .slice(0, 4);
}

function hasReviewSchema(item) {
  const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : item["@type"];
  return /review|aggregaterating/i.test(`${type || ""} ${JSON.stringify(item.aggregateRating || item.review || "")}`);
}

function detectPlatform({ generator, htmlLower, scriptSources }) {
  const haystack = `${generator} ${htmlLower.slice(0, 250_000)} ${scriptSources.join(" ")}`;
  const rules = [
    ["WordPress", /wordpress|wp-content|wp-includes/i],
    ["Wix", /wixstatic|wix\.com|wixsite/i],
    ["Squarespace", /squarespace/i],
    ["Shopify", /cdn\.shopify|shopify\.theme|myshopify/i],
    ["Webflow", /webflow/i],
    ["GoDaddy Website Builder", /godaddy|websitebuilder/i],
    ["HubSpot CMS", /hubspot|hs-sites/i],
    ["Duda", /duda\.co|dudamobile/i],
    ["Drupal", /drupal/i],
    ["Joomla", /joomla/i],
  ];
  return rules.find(([, pattern]) => pattern.test(haystack))?.[0] || clean(generator);
}

function extractEmails(value) {
  return uniqueStrings(
    String(value || "").match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  );
}

function extractPhones(value) {
  return uniqueStrings(
    (String(value || "").match(/(?:\+?\d[\d\s().-]{8,}\d)/g) || [])
      .map((item) => clean(item))
      .filter((item) => item.replace(/\D/g, "").length >= 10)
  ).slice(0, 8);
}

function extractAddress(text) {
  const match = String(text || "").match(
    /\d{1,6}\s+[A-Za-z0-9.' -]{3,70}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)\b[^.]{0,90}/i
  );
  return clean(match?.[0]);
}

function extractDecisionMaker(text) {
  const patterns = [
    /(?:owner|founder|president|chief executive officer|ceo|principal)\s*[:\-–—]\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/,
    /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s*,?\s+(?:owner|founder|president|ceo|principal)\b/,
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) return clean(match[0]);
  }
  return "";
}

function extractBusinessHours(text) {
  const match = String(text || "").match(
    /(?:hours|open)\s*[:\-]?\s*(?:monday|mon)[\s\S]{0,250}?(?:sunday|sun)[^.;]{0,50}/i
  );
  return clean(match?.[0]);
}

function isIgnoredExternalHost(host) {
  if (!host) return true;
  return [...SOCIAL_HOSTS, ...INFRASTRUCTURE_HOSTS].some(
    (blocked) => host === blocked || host.endsWith(`.${blocked}`)
  );
}

function parseJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || text;
  const start = source.indexOf("{");
  if (start < 0) throw new Error("Claude did not return a JSON object.");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1));
    }
  }

  throw new Error("Claude returned incomplete JSON.");
}

function renderAuditPdf(audit) {
  const pdf = new SimplePdf();
  const brand = audit.brand?.name || "ReachFly.Ai";
  const report = audit.report || {};

  const track = normalizeCampaignType(audit.campaignType || audit.track || audit.kind);
  pdf.header(brand, `${track.toUpperCase()} ${audit.kind.toUpperCase()} AUDIT REPORT`, audit.website || audit.lead?.gmbProfileUrl || audit.lead?.googleMapsUri || "");

  if (["website", "gmb"].includes(audit.kind)) {
    pdf.heading(
      report.title ||
        (audit.kind === "gmb" ? "GMB / Local Visibility Audit" : "Website / Technology Audit"),
      19
    );
    pdf.paragraph(report.summary || "");
    if (Number.isFinite(Number(report.score))) {
      pdf.score(Number(report.score || 0));
    }
    if (audit.kind === "gmb") {
      pdf.keyValue("Profile status", report.profileStatus || "Not verified");
      pdf.keyValue("Local visibility", report.localVisibility || "Not verified");
    }
    pdf.section("VERIFIED FINDINGS");
    (report.findings || []).forEach((item, index) => {
      pdf.subheading(`${index + 1}. ${item.title || "Finding"} [${String(item.severity || "medium").toUpperCase()}]`);
      pdf.keyValue("Evidence", item.evidence);
      pdf.keyValue("Business impact", item.businessImpact);
      if (item.approvedSalesWording) {
        pdf.keyValue("Approved sales wording", item.approvedSalesWording);
      }
      if (item.source) pdf.muted(item.source);
    });
    if (report.approvedOpeningLine) {
      pdf.section("APPROVED OPENING LINE");
      pdf.paragraph(report.approvedOpeningLine);
    }
    if (report.suggestedNextStep) {
      pdf.section("SUGGESTED NEXT STEP");
      pdf.paragraph(report.suggestedNextStep);
    }
    pdf.footerNote(report.disclaimer || "Public-source caller audit.");
  } else  if (audit.kind === "mini") {
    pdf.heading(report.header?.title || "Mini Audit", 18);
    pdf.muted(report.header?.subtitle || "One page. Everything you need before you dial.");
    pdf.section("BUSINESS SNAPSHOT");
    const snapshot = report.snapshot || {};
    pdf.keyValue("Business name", snapshot.businessName);
    pdf.keyValue("Phone", snapshot.phone);
    pdf.keyValue("Email", snapshot.email);
    pdf.keyValue("Website", `${snapshot.website || hostname(audit.website)} · built on ${snapshot.platform || "Not identified"}`);
    pdf.keyValue("Decision maker", snapshot.decisionMaker);
    pdf.keyValue("Business hours", snapshot.businessHours);
    pdf.keyValue("What they do", snapshot.whatTheyDo);
    pdf.section("ISSUES FOUND");
    (report.issues || []).forEach((item, index) => {
      pdf.issue(index + 1, item.tag, item.finding, item.pain);
    });
    pdf.footerNote(report.footer || "Internal use only.");
  } else if (audit.kind === "competitor") {
    pdf.heading(report.title || "Competitor Analysis", 19);
    pdf.paragraph(report.executiveSummary);
    pdf.keyValue("Market query", report.marketQuery);
    pdf.keyValue("Target visibility", report.targetVisibility);
    pdf.section("COMPETITORS");
    (report.competitors || []).forEach((item, index) => {
      pdf.subheading(`${index + 1}. ${item.name || item.domain}`);
      pdf.keyValue("Domain", item.domain);
      pdf.bullets(item.observedAdvantages || []);
      pdf.muted((item.evidence || []).join(" · "));
    });
    pdf.section("COMPETITIVE GAPS");
    (report.competitiveGaps || []).forEach((item) => {
      pdf.subheading(item.title);
      pdf.paragraph(`${item.evidence} ${item.businessImpact}`);
    });
    pdf.section("SALES TALKING POINTS");
    pdf.bullets(report.salesTalkingPoints || []);
    pdf.footerNote(report.disclaimer || "Public-source competitor analysis.");
  } else {
    pdf.heading(report.title || `${track === "gmb" ? "GMB" : "Website"} Full Audit`, 19);
    pdf.paragraph(report.executiveSummary);
    pdf.score(Number(report.score || 0));
    pdf.section("STRENGTHS");
    pdf.bullets(report.strengths || []);
    pdf.section("PRIORITY FINDINGS");
    (report.priorityFindings || []).forEach((item, index) => {
      pdf.subheading(`${index + 1}. ${item.title} [${String(item.severity || "medium").toUpperCase()}]`);
      pdf.keyValue("Evidence", item.evidence);
      pdf.keyValue("Business impact", item.businessImpact);
      pdf.keyValue("Recommendation", item.recommendation);
    });
    pdf.reviewSection("TECHNICAL REVIEW", report.technicalReview || []);
    pdf.reviewSection("SEO AND LOCAL VISIBILITY", report.seoAndLocalVisibility || []);
    pdf.reviewSection("CONVERSION AND TRUST", report.conversionAndTrust || []);
    pdf.section("COMPETITOR SUMMARY");
    pdf.paragraph(report.competitorSummary);
    pdf.section("ROADMAP");
    (report.roadmap || []).forEach((item) => {
      pdf.subheading(`${item.phase} · ${item.timeframe}`);
      pdf.bullets(item.actions || []);
    });
    pdf.footerNote(report.disclaimer || "Public-source website audit.");
  }

  return pdf.toBuffer();
}

class SimplePdf {
  constructor() {
    this.width = 595.28;
    this.height = 841.89;
    this.margin = 42;
    this.pages = [];
    this.page = null;
    this.cursor = 54;
    this.addPage();
  }

  addPage() {
    this.page = [];
    this.pages.push(this.page);
    this.cursor = 48;
    this.rect(0, 0, this.width, 18, [15, 23, 42]);
  }

  header(brand, label, website) {
    this.rect(0, 0, this.width, 82, [15, 23, 42]);
    this.drawText(brand, 42, 29, 18, true, [255, 255, 255]);
    this.drawText(label, 42, 54, 9, true, [134, 239, 172]);
    this.drawText(hostname(website), 553, 52, 8, false, [203, 213, 225], "right");
    this.cursor = 106;
  }

  heading(value, size = 18) {
    this.ensure(34);
    this.text(value, { size, bold: true, color: [15, 23, 42], after: 8 });
  }

  subheading(value) {
    this.ensure(24);
    this.text(value, { size: 10.5, bold: true, color: [30, 41, 59], after: 4 });
  }

  section(value) {
    this.ensure(29);
    this.cursor += 7;
    this.rect(this.margin, this.cursor, this.width - this.margin * 2, 20, [241, 245, 249]);
    this.drawText(value, this.margin + 8, this.cursor + 6, 8.5, true, [22, 101, 52]);
    this.cursor += 27;
  }

  paragraph(value) {
    if (!clean(value)) return;
    this.text(value, { size: 9.2, lineHeight: 12.5, color: [51, 65, 85], after: 7 });
  }

  muted(value) {
    if (!clean(value)) return;
    this.text(value, { size: 7.6, lineHeight: 10, color: [100, 116, 139], after: 5 });
  }

  keyValue(label, value) {
    if (!clean(value)) return;
    const labelWidth = 98;
    const lines = wrapText(clean(value), this.width - this.margin * 2 - labelWidth, 8.6);
    const height = Math.max(13, lines.length * 11);
    this.ensure(height + 2);
    this.drawText(`${label}:`, this.margin, this.cursor + 1, 8.4, true, [30, 41, 59]);
    lines.forEach((line, index) => {
      this.drawText(line, this.margin + labelWidth, this.cursor + 1 + index * 11, 8.6, false, [51, 65, 85]);
    });
    this.cursor += height;
  }

  issue(number, tag, finding, pain) {
    const contentWidth = this.width - this.margin * 2 - 28;
    const findingLines = wrapText(clean(finding), contentWidth, 8.1);
    const painLines = wrapText(clean(pain), contentWidth, 8.1);
    const height = 25 + (findingLines.length + painLines.length) * 10;
    this.ensure(height + 5);
    this.rect(this.margin, this.cursor, this.width - this.margin * 2, height, [248, 250, 252], [226, 232, 240]);
    this.circle(this.margin + 15, this.cursor + 16, 9, [22, 163, 74]);
    this.drawText(String(number), this.margin + 15, this.cursor + 13.1, 7.5, true, [255, 255, 255], "center");
    this.drawText(clean(tag).toUpperCase(), this.margin + 30, this.cursor + 9, 8.2, true, [15, 23, 42]);
    let y = this.cursor + 24;
    findingLines.forEach((line) => {
      this.drawText(line, this.margin + 30, y, 8.1, false, [51, 65, 85]);
      y += 10;
    });
    painLines.forEach((line) => {
      this.drawText(line, this.margin + 30, y, 8.1, true, [22, 101, 52]);
      y += 10;
    });
    this.cursor += height + 5;
  }

  bullets(items) {
    for (const item of items || []) {
      const lines = wrapText(clean(item), this.width - this.margin * 2 - 15, 8.7);
      if (!lines.length) continue;
      this.ensure(lines.length * 11 + 4);
      this.circle(this.margin + 4, this.cursor + 5, 2, [22, 163, 74]);
      lines.forEach((line, index) => {
        this.drawText(line, this.margin + 13, this.cursor + index * 11, 8.7, false, [51, 65, 85]);
      });
      this.cursor += lines.length * 11 + 3;
    }
  }

  score(value) {
    this.ensure(40);
    this.rect(this.margin, this.cursor, 110, 32, [236, 253, 245], [134, 239, 172]);
    this.drawText("AUDIT SCORE", this.margin + 10, this.cursor + 9, 7.5, true, [22, 101, 52]);
    this.drawText(`${clamp(value, 0, 100)}/100`, this.margin + 100, this.cursor + 8, 13, true, [21, 128, 61], "right");
    this.cursor += 40;
  }

  reviewSection(title, rows) {
    if (!rows?.length) return;
    this.section(title);
    rows.forEach((row) => {
      this.subheading(`${row.item} · ${String(row.status || "warning").toUpperCase()}`);
      this.paragraph(row.evidence);
    });
  }

  footerNote(value) {
    this.ensure(34);
    this.cursor += 5;
    this.line(this.margin, this.cursor, this.width - this.margin, this.cursor, [203, 213, 225]);
    this.cursor += 9;
    this.text(value, { size: 6.7, lineHeight: 8.5, color: [100, 116, 139], after: 0 });
  }

  text(value, { size = 9, bold = false, lineHeight = size * 1.35, color = [51, 65, 85], after = 0 } = {}) {
    const lines = wrapText(clean(value), this.width - this.margin * 2, size);
    if (!lines.length) return;
    this.ensure(lines.length * lineHeight + after);
    lines.forEach((line, index) => {
      this.drawText(line, this.margin, this.cursor + index * lineHeight, size, bold, color);
    });
    this.cursor += lines.length * lineHeight + after;
  }

  ensure(height) {
    if (this.cursor + height <= this.height - 45) return;
    this.addPage();
    this.cursor = 42;
  }

  drawText(value, x, top, size, bold, color, align = "left") {
    const safe = pdfEscape(toPdfText(value));
    let adjustedX = x;
    if (align !== "left") {
      const estimatedWidth = safe.length * size * 0.48;
      if (align === "right") adjustedX -= estimatedWidth;
      if (align === "center") adjustedX -= estimatedWidth / 2;
    }
    const y = this.height - top - size;
    const [r, g, b] = color.map((item) => Number(item) / 255);
    this.page.push(
      `BT /${bold ? "F2" : "F1"} ${size.toFixed(2)} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ${adjustedX.toFixed(2)} ${y.toFixed(2)} Td (${safe}) Tj ET`
    );
  }

  rect(x, top, width, height, fill, stroke = null) {
    const y = this.height - top - height;
    const [r, g, b] = fill.map((item) => Number(item) / 255);
    let command = `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`;
    if (stroke) {
      const [sr, sg, sb] = stroke.map((item) => Number(item) / 255);
      command += ` ${sr.toFixed(3)} ${sg.toFixed(3)} ${sb.toFixed(3)} RG ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`;
    }
    this.page.push(command);
  }

  circle(x, top, radius, fill) {
    const y = this.height - top;
    const c = radius * 0.5522847498;
    const [r, g, b] = fill.map((item) => Number(item) / 255);
    this.page.push(
      `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ` +
        `${(x + radius).toFixed(2)} ${y.toFixed(2)} m ` +
        `${(x + radius).toFixed(2)} ${(y + c).toFixed(2)} ${(x + c).toFixed(2)} ${(y + radius).toFixed(2)} ${x.toFixed(2)} ${(y + radius).toFixed(2)} c ` +
        `${(x - c).toFixed(2)} ${(y + radius).toFixed(2)} ${(x - radius).toFixed(2)} ${(y + c).toFixed(2)} ${(x - radius).toFixed(2)} ${y.toFixed(2)} c ` +
        `${(x - radius).toFixed(2)} ${(y - c).toFixed(2)} ${(x - c).toFixed(2)} ${(y - radius).toFixed(2)} ${x.toFixed(2)} ${(y - radius).toFixed(2)} c ` +
        `${(x + c).toFixed(2)} ${(y - radius).toFixed(2)} ${(x + radius).toFixed(2)} ${(y - c).toFixed(2)} ${(x + radius).toFixed(2)} ${y.toFixed(2)} c f`
    );
  }

  line(x1, top1, x2, top2, color) {
    const [r, g, b] = color.map((item) => Number(item) / 255);
    this.page.push(
      `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG ${x1.toFixed(2)} ${(this.height - top1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - top2).toFixed(2)} l S`
    );
  }

  toBuffer() {
    const objects = [];
    const pageRefs = this.pages.map((_, index) => 5 + index * 2);
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${pageRefs.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

    this.pages.forEach((commands, index) => {
      const pageId = 5 + index * 2;
      const contentId = pageId + 1;
      const stream = commands.join("\n");
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width.toFixed(2)} ${this.height.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
      objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    });

    let output = "%PDF-1.4\n%âãÏÓ\n";
    const offsets = [0];
    const maxId = objects.length - 1;

    for (let id = 1; id <= maxId; id += 1) {
      offsets[id] = Buffer.byteLength(output, "latin1");
      output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(output, "latin1");
    output += `xref\n0 ${maxId + 1}\n`;
    output += "0000000000 65535 f \n";
    for (let id = 1; id <= maxId; id += 1) {
      output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    output += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(output, "latin1");
  }
}

function wrapText(value, maxWidth, fontSize) {
  const text = clean(value);
  if (!text) return [];
  const maxChars = Math.max(10, Math.floor(maxWidth / (fontSize * 0.52)));
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function normalizeReviewRows(value) {
  return Array.isArray(value)
    ? value.slice(0, 16).map((item) => ({
        item: clean(item.item),
        status: ["pass", "warning", "fail"].includes(normalize(item.status))
          ? normalize(item.status)
          : "warning",
        evidence: clean(item.evidence),
      }))
    : [];
}

function evidenceFallbackScore(evidence) {
  const signals = [
    Boolean(evidence.metaDescription),
    evidence.titleLength > 0 && evidence.titleLength <= 60,
    evidence.hasBooking,
    evidence.hasChat,
    evidence.hasStructuredReviews || evidence.testimonialCount > 1,
    evidence.hasPhoneLink,
    evidence.hasEmailLink,
    evidence.hasPrivacy,
    evidence.hasTerms,
    evidence.hasSchema,
  ];
  return Math.round((signals.filter(Boolean).length / signals.length) * 100);
}

function fallbackStrengths(evidence) {
  const strengths = [];
  if (evidence.metaDescription) strengths.push("Homepage meta description is present");
  if (evidence.titleLength > 0 && evidence.titleLength <= 60) strengths.push("Homepage title length is within a typical search display range");
  if (evidence.hasBooking) strengths.push("Online booking or scheduling is available");
  if (evidence.hasChat) strengths.push("Live chat or an assistant is present");
  if (evidence.hasStructuredReviews || evidence.testimonialCount > 1) strengths.push("Public trust proof is displayed");
  if (evidence.hasPhoneLink) strengths.push("Click-to-call is available");
  return strengths;
}

function fallbackRecommendation(tag) {
  if (/title/i.test(tag)) return "Rewrite and validate the homepage title against the target search intent.";
  if (/description/i.test(tag)) return "Create a concise homepage meta description based on the primary service and location.";
  if (/booking|after-hours|form/i.test(tag)) return "Add an immediate next-step option and connect it to the lead follow-up workflow.";
  if (/review/i.test(tag)) return "Add a maintained review and testimonial display sourced from verified customers.";
  if (/NAP|address/i.test(tag)) return "Reconcile the business name, address, and phone across the website and major listings.";
  return "Validate the observation with the business owner and prioritize the change according to commercial impact.";
}

function normalizeSeverity(value) {
  const severity = normalize(value);
  return ["critical", "high", "medium", "low"].includes(severity)
    ? severity
    : "medium";
}

function toStringArray(value, limit = 10) {
  return Array.isArray(value) ? value.map(clean).filter(Boolean).slice(0, limit) : [];
}

function oneSentence(value) {
  const text = clean(value);
  if (!text) return "";
  const match = text.match(/^.*?[.!?](?:\s|$)/);
  return clean(match?.[0] || `${text.replace(/[.!?]+$/, "")}.`);
}

function isLikelyEmail(value) {
  const email = clean(value).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email)) return false;
  if (/\.\.|^\.|\.@|@\.|\.$/.test(email)) return false;
  if (/example|yoursite|yourdomain|test\.com|domain\.com/i.test(email)) return false;
  return true;
}

function normalizeKind(value) {
  const kind = normalize(value || "mini").replace(/ /g, "_");
  const aliases = {
    website: "website",
    website_audit: "website",
    technology: "website",
    technology_audit: "website",
    tech: "website",
    gmb: "gmb",
    gmb_audit: "gmb",
    google_business_profile: "gmb",
    local_visibility: "gmb",
    mini: "mini",
    mini_audit: "mini",
    competitor: "competitor",
    competitor_analysis: "competitor",
    full: "full",
    full_audit: "full",
  };
  return aliases[kind] || "mini";
}

function normalizeCampaignType(value) {
  const kind = normalizeKind(value);
  return kind === "gmb" ? "gmb" : "website";
}

function normalizePageHref(value, base = "") {
  const raw = clean(value);
  if (!raw) return "";
  if (/^(?:mailto|tel):/i.test(raw)) return raw;
  return normalizeUrl(raw, base);
}

function normalizeUrl(value, base = "") {
  let raw = clean(value);
  if (!raw) return "";
  try {
    if (base) raw = new URL(raw, base).toString();
    else if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hostToName(host) {
  return clean(
    String(host || "")
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

function safeFilename(value) {
  return `${String(value || "audit.pdf")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "audit-report.pdf"}`.replace(/\.pdf\.pdf$/i, ".pdf");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(clean).filter(Boolean))];
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toPdfText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function pdfEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");
}
