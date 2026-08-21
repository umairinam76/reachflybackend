import crypto from "node:crypto";
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
  6
);
const MAX_QUEUE_SIZE = clamp(process.env.AUDIT_MAX_QUEUE_SIZE || 500, 25, 2_000);
const REPORT_TTL_MS = Number(
  process.env.AUDIT_REPORT_TTL_MS || 14 * 24 * 60 * 60 * 1000
);
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
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

const queue = [];
const running = new Set();
let serviceRef = null;

export function createLeadAuditService({ store, workspaceService } = {}) {
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
  };

  serviceRef = service;
  resumeQueuedReports();

  function queueMiniBatch(user, input = {}) {
    const leads = Array.isArray(input.leads) ? input.leads : [];
    const accepted = [];

    for (const lead of leads.slice(0, 250)) {
      if (!lead?.website) continue;

      try {
        accepted.push(
          queueReport(user, {
            ...input,
            lead,
            website: lead.website,
            kind: "mini",
          })
        );
      } catch (error) {
        accepted.push({
          website: clean(lead.website),
          status: "failed",
          error: error.message,
          kind: "mini",
        });
      }
    }

    return {
      accepted: accepted.length,
      reports: accepted.map(publicReport),
    };
  }

  function queueMiniAudit(user, input = {}) {
    return publicReport(
      queueReport(user, {
        ...input,
        kind: "mini",
      })
    );
  }

  function queueGeneratedReport(user, input = {}) {
    const kind = normalizeKind(input.kind);

    if (!['competitor', 'full'].includes(kind)) {
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

  function queueReport(user, input = {}) {
    const context = workspaceService?.getContext(user) || {
      user,
      workspaceId: user.workspaceId || user.id,
      workspace: null,
    };
    const website = normalizeUrl(input.website || input.lead?.website);

    if (!website) {
      throw createError(400, "A valid website URL is required.");
    }

    const kind = normalizeKind(input.kind || "mini");
    const state = store.read();
    const workspaceProfile =
      state.workspaceSettings?.[context.workspaceId]?.app?.auditProfile || {};
    const auditProfile = normalizeAuditProfile({
      ...workspaceProfile,
      ...(input.auditProfile || input.profile || input.salesProfile || {}),
    });
    const profileHash = auditProfileHash(auditProfile);
    const cacheKey = reportCacheKey(
      context.workspaceId,
      website,
      kind,
      profileHash
    );
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
      lead: sanitizeLead(input.lead || input),
      niche: clean(input.niche || input.lead?.category),
      location: clean(input.location || input.lead?.address),
      brand: resolveBrand({ context, store }),
      auditProfile,
      profileHash,
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

    return (store.read().leadAudits || [])
      .filter((item) => item.workspaceId === context.workspaceId)
      .filter((item) => !website || item.website === website)
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
        `${report.lead?.business || report.lead?.name || hostname(report.website)}-${report.kind}-audit.pdf`
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

  function enqueue(id) {
    if (!id || queue.includes(id) || running.has(id)) return;
    if (queue.length >= MAX_QUEUE_SIZE) return;
    queue.push(id);
    scheduleWorkers();
  }

  function scheduleWorkers() {
    while (running.size < AUTO_MINI_CONCURRENCY && queue.length) {
      const id = queue.shift();
      if (!id || running.has(id)) continue;
      running.add(id);
      void processRecord(id).finally(() => {
        running.delete(id);
        scheduleWorkers();
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
      const evidence = await inspectLeadWebsite(record);
      let report;
      let provider = "anthropic";

      try {
        report = await generateWithClaude(record, evidence);
      } catch (error) {
        provider = "deterministic-fallback";
        report = buildFallbackReport(record, evidence, error);
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
    } catch (error) {
      updateRecord(id, {
        status: "failed",
        error: error.message || "Audit generation failed.",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  function updateRecord(id, changes) {
    store.update((draft) => {
      const target = (draft.leadAudits || []).find((item) => item.id === id);
      if (target) Object.assign(target, changes);
    });
  }
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
    lead: record.lead,
    niche: record.niche,
    location: record.location,
  };
}

async function generateWithClaude(record, evidence) {
  const apiKey = clean(process.env.ANTHROPIC_API_KEY);

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured on the server.");
  }

  const kind = record.kind;
  const prompt = buildClaudePrompt(record, evidence);
  const maxUses = kind === "mini" ? 4 : kind === "competitor" ? 7 : 8;
  const maxTokens = kind === "mini" ? 3_000 : 6_000;
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: maxUses,
    },
  ];
  const messages = [{ role: "user", content: prompt }];
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

  return [
    `You are a senior technical auditor and sales-intelligence analyst working for ${brandName} (${brandWebsite}).`,
    "You research only publicly accessible website content and public search results.",
    "Never invent a finding, performance score, ranking, owner, opening hours, address mismatch, competitor, technology, buying signal, intent signal, or prospect interest.",
    "When a workspace audit profile is supplied, use it only to evaluate commercial alignment and pitch relevance. Fit is not proof of buyer intent.",
    "Do not run active security scans. Do not claim legal, accessibility, privacy, or security compliance.",
    "Return one valid JSON object only. Do not use markdown fences and do not add prose before or after JSON.",
    "When the supplied homepage evidence conflicts with a search result, identify the conflict and cite the public source in the source field.",
  ].join(" ");
}

function buildClaudePrompt(record, evidence) {
  const brand = record.brand;
  const base = {
    reportKind: record.kind,
    website: record.website,
    lead: record.lead,
    niche: record.niche,
    location: record.location,
    brand,
    auditProfile: record.auditProfile || normalizeAuditProfile({}),
    verifiedHomepageEvidence: evidence,
    generatedDate: new Date().toISOString().slice(0, 10),
  };

  if (record.kind === "mini") {
    return `${JSON.stringify(base)}\n\nResearch the business using live web search before writing. Search for the business's Google, Yelp, and other public directory listings; compare their address and phone with the supplied website and lead evidence. Search for the primary category plus city and identify whether the business appears prominently and which 2-4 real competitors appear instead. Use only facts you can verify. Return exactly this JSON shape:\n${JSON.stringify(
      {
        header: {
          confidentiality: "INTERNAL - SALES TEAM USE ONLY - DO NOT SEND TO CLIENT",
          brandLine: `${brand.name.toUpperCase()} · MINI AUDIT REPORT · YYYY-MM-DD`,
          title: "Business Name - Mini Audit",
          subtitle: "One page. Everything you need before you dial.",
        },
        snapshot: {
          businessName: "",
          phone: "",
          email: "",
          website: "domain",
          platform: "",
          decisionMaker: "Not publicly identified - verify on call",
          businessHours: "Not publicly listed - verify on call",
          whatTheyDo: "",
        },
        salesFit: {
          fitScore: 0,
          alignment: "",
          summary: "",
          likelyNeeds: [""],
          pitchAngles: [""],
          suggestedOpener: "",
          caution: "Commercial fit is not proof of buyer intent.",
        },
        issues: [
          {
            tag: "precise technical label",
            finding: "One verified factual sentence the rep can say aloud.",
            pain: "One short plain-English business consequence sentence with no fix.",
            source: "Public URL or supplied homepage evidence",
          },
        ],
        footer: `INTERNAL USE ONLY. Do not forward this document to the client. Findings sourced from ${evidence.domain} public page source and public directories, YYYY-MM-DD. Send the Client Audit Report (technical, no recommendations) after the call. ${brand.name} - ${brand.website || "workspace"}`,
      },
      null,
      2
    )}\nRules: include 6-10 issues, prioritized with address/NAP conflicts, domain authority fragmentation, and search visibility before minor issues. Each issue finding must be exactly one sentence. Each issue pain must be exactly one sentence. salesFit must compare the verified business evidence to auditProfile.businessNiche, auditProfile.idealCustomer, auditProfile.offer, auditProfile.targetMarket, auditProfile.pitchGoal, auditProfile.customInstructions and the enabled auditProfile.criteria. fitScore is commercial alignment from 0-100, not buying intent. Do not say the prospect is interested, ready to buy, needs the offer, or has budget unless supplied CRM/public evidence explicitly proves it. suggestedOpener must be one short conversational opener that references at most one verified observation and then asks a question. pitchAngles must stay grounded in verified findings and the configured offer. Include no objection notes, founded/size field, unsupported recommendations, or extra sections.`;
  }

  if (record.kind === "competitor") {
    return `${JSON.stringify(base)}\n\nResearch live search results for the business's category and city. Identify 3-5 real direct competitors and compare only publicly verifiable website, local-search, review, conversion, and trust signals. Return exactly this JSON shape:\n${JSON.stringify(
      {
        title: "Competitor Analysis",
        executiveSummary: "",
        marketQuery: "",
        targetVisibility: "",
        competitors: [
          {
            name: "",
            domain: "",
            location: "",
            observedAdvantages: [""],
            evidence: ["public URL or search observation"],
          },
        ],
        competitiveGaps: [
          { title: "", evidence: "", businessImpact: "" },
        ],
        salesTalkingPoints: [""],
        disclaimer: "",
      },
      null,
      2
    )}`;
  }

  return `${JSON.stringify(base)}\n\nProduce a detailed evidence-grounded website audit using the supplied homepage evidence and live web research. Include technical, SEO, local visibility, conversion, trust, content, and competitor observations. Recommendations may appear only in this full report. Return exactly this JSON shape:\n${JSON.stringify(
    {
      title: "Full Website Audit",
      executiveSummary: "",
      score: 0,
      strengths: [""],
      priorityFindings: [
        {
          title: "",
          severity: "critical|high|medium|low",
          evidence: "",
          businessImpact: "",
          recommendation: "",
          source: "",
        },
      ],
      technicalReview: [
        { item: "", status: "pass|warning|fail", evidence: "" },
      ],
      seoAndLocalVisibility: [
        { item: "", status: "pass|warning|fail", evidence: "" },
      ],
      conversionAndTrust: [
        { item: "", status: "pass|warning|fail", evidence: "" },
      ],
      competitorSummary: "",
      roadmap: [
        { phase: "", timeframe: "", actions: [""] },
      ],
      disclaimer: "",
    },
    null,
    2
  )}`;
}

function normalizeGeneratedReport(record, evidence, value) {
  if (record.kind === "mini") {
    const issues = Array.isArray(value.issues) ? value.issues : [];
    const normalizedIssues = issues
      .map((item) => ({
        tag: clean(item.tag),
        finding: oneSentence(item.finding),
        pain: oneSentence(item.pain),
        source: clean(item.source),
      }))
      .filter((item) => item.tag && item.finding && item.pain)
      .slice(0, 10);

    const fallback = buildFallbackMini(record, evidence);
    const finalIssues = [...normalizedIssues];

    for (const item of fallback.issues) {
      if (finalIssues.length >= 6) break;
      if (!finalIssues.some((existing) => normalize(existing.tag) === normalize(item.tag))) {
        finalIssues.push(item);
      }
    }

    return {
      header: {
        confidentiality:
          "INTERNAL - SALES TEAM USE ONLY - DO NOT SEND TO CLIENT",
        brandLine: `${record.brand.name.toUpperCase()} · MINI AUDIT REPORT · ${new Date()
          .toISOString()
          .slice(0, 10)}`,
        title: `${clean(value.header?.title) || clean(value.snapshot?.businessName) || evidence.siteName} - Mini Audit`,
        subtitle: "One page. Everything you need before you dial.",
      },
      snapshot: {
        businessName:
          clean(value.snapshot?.businessName) || evidence.siteName,
        phone: clean(value.snapshot?.phone) || evidence.phone || "Not publicly listed - verify on call",
        email: clean(value.snapshot?.email) || evidence.email || "Not publicly listed - verify on call",
        website: clean(value.snapshot?.website) || evidence.domain,
        platform: clean(value.snapshot?.platform) || evidence.platform || "Not identifiable from public source",
        decisionMaker:
          clean(value.snapshot?.decisionMaker) ||
          evidence.decisionMaker ||
          "Not publicly identified - verify on call",
        businessHours:
          clean(value.snapshot?.businessHours) ||
          evidence.businessHours ||
          "Not publicly listed - verify on call",
        whatTheyDo:
          clean(value.snapshot?.whatTheyDo) ||
          evidence.description ||
          "Not clearly stated on the reviewed homepage.",
      },
      salesFit: normalizeSalesFit(
        value.salesFit,
        record,
        finalIssues,
        evidence
      ),
      issues: finalIssues.slice(0, 10),
      footer:
        clean(value.footer) ||
        `INTERNAL USE ONLY. Do not forward this document to the client. Findings sourced from ${evidence.domain} public page source and public directories, ${new Date()
          .toISOString()
          .slice(0, 10)}. Send the Client Audit Report (technical, no recommendations) after the call. ${record.brand.name} - ${record.brand.website || "workspace"}`,
    };
  }

  if (record.kind === "competitor") {
    return {
      title: clean(value.title) || "Competitor Analysis",
      executiveSummary: clean(value.executiveSummary),
      marketQuery: clean(value.marketQuery),
      targetVisibility: clean(value.targetVisibility),
      competitors: Array.isArray(value.competitors)
        ? value.competitors.slice(0, 5).map((item) => ({
            name: clean(item.name),
            domain: clean(item.domain),
            location: clean(item.location),
            observedAdvantages: toStringArray(item.observedAdvantages, 6),
            evidence: toStringArray(item.evidence, 6),
          }))
        : [],
      competitiveGaps: Array.isArray(value.competitiveGaps)
        ? value.competitiveGaps.slice(0, 10).map((item) => ({
            title: clean(item.title),
            evidence: clean(item.evidence),
            businessImpact: clean(item.businessImpact),
          }))
        : [],
      salesTalkingPoints: toStringArray(value.salesTalkingPoints, 8),
      disclaimer:
        clean(value.disclaimer) ||
        "Based only on publicly accessible websites and search results observed at the report date.",
    };
  }

  return {
    title: clean(value.title) || "Full Website Audit",
    executiveSummary: clean(value.executiveSummary),
    score: clamp(value.score || evidenceFallbackScore(evidence), 0, 100),
    strengths: toStringArray(value.strengths, 8),
    priorityFindings: Array.isArray(value.priorityFindings)
      ? value.priorityFindings.slice(0, 12).map((item) => ({
          title: clean(item.title),
          severity: normalizeSeverity(item.severity),
          evidence: clean(item.evidence),
          businessImpact: clean(item.businessImpact),
          recommendation: clean(item.recommendation),
          source: clean(item.source),
        }))
      : [],
    technicalReview: normalizeReviewRows(value.technicalReview),
    seoAndLocalVisibility: normalizeReviewRows(value.seoAndLocalVisibility),
    conversionAndTrust: normalizeReviewRows(value.conversionAndTrust),
    competitorSummary: clean(value.competitorSummary),
    roadmap: Array.isArray(value.roadmap)
      ? value.roadmap.slice(0, 4).map((item) => ({
          phase: clean(item.phase),
          timeframe: clean(item.timeframe),
          actions: toStringArray(item.actions, 6),
        }))
      : [],
    disclaimer:
      clean(value.disclaimer) ||
      "This report is based on publicly accessible pages and search results. It is not a security penetration test, legal review, accessibility certification, or guarantee of commercial performance.",
  };
}

function buildFallbackReport(record, evidence, error) {
  if (record.kind === "mini") {
    return {
      ...buildFallbackMini(record, evidence),
      generationNote: `Claude fallback used: ${error.message}`,
    };
  }

  if (record.kind === "competitor") {
    return {
      title: "Competitor Analysis",
      executiveSummary:
        "Live competitor research could not be completed. The report contains only verified observations from the target website.",
      marketQuery: [record.niche, record.location].filter(Boolean).join(" "),
      targetVisibility: "Not verified - rerun when Claude web search is available.",
      competitors: [],
      competitiveGaps: buildFallbackMini(record, evidence).issues.map((item) => ({
        title: item.tag,
        evidence: item.finding,
        businessImpact: item.pain,
      })),
      salesTalkingPoints: [],
      disclaimer: `Claude research unavailable: ${error.message}`,
    };
  }

  const mini = buildFallbackMini(record, evidence);
  return {
    title: "Full Website Audit",
    executiveSummary:
      "This fallback report contains verified homepage observations only. Live competitor research and expanded narrative generation were unavailable.",
    score: evidenceFallbackScore(evidence),
    strengths: fallbackStrengths(evidence),
    priorityFindings: mini.issues.map((item) => ({
      title: item.tag,
      severity: "medium",
      evidence: item.finding,
      businessImpact: item.pain,
      recommendation: fallbackRecommendation(item.tag),
      source: item.source,
    })),
    technicalReview: [],
    seoAndLocalVisibility: [],
    conversionAndTrust: [],
    competitorSummary: "Not verified - rerun when Claude web search is available.",
    roadmap: [],
    disclaimer: `Claude generation unavailable: ${error.message}`,
  };
}

function buildFallbackMini(record, evidence) {
  const issues = [];
  const add = (tag, finding, pain, source = evidence.finalUrl) => {
    if (issues.length >= 10) return;
    issues.push({ tag, finding: oneSentence(finding), pain: oneSentence(pain), source });
  };

  if (
    evidence.websiteAddress &&
    evidence.googleAddress &&
    normalize(evidence.websiteAddress) !== normalize(evidence.googleAddress)
  ) {
    add(
      "NAP citation conflict",
      `The website address is shown as ${evidence.websiteAddress}, while the Google lead record shows ${evidence.googleAddress}.`,
      "Customers can lose confidence or arrive at the wrong location."
    );
  }

  if (evidence.externalServiceLinks.length) {
    add(
      "domain authority fragmentation",
      `The website sends visitors to separate service domains including ${evidence.externalServiceLinks.slice(0, 3).join(", ")}.`,
      "The business experience is split across multiple destinations."
    );
  }

  if (evidence.titleLength > 60) {
    add(
      "title tag exceeds SERP display limit",
      `The homepage title contains ${evidence.titleLength} characters.`,
      "Important wording may be cut off before searchers see it."
    );
  }

  if (!evidence.metaDescription) {
    add(
      "missing meta description",
      "The reviewed homepage does not provide a meta description.",
      "Searchers may see an unclear or inconsistent preview."
    );
  }

  if (!evidence.hasBooking) {
    add(
      "no online booking mechanism detected",
      "No public online booking or scheduling link was detected on the reviewed homepage.",
      "Ready prospects may have to wait for someone to respond."
    );
  }

  if (!evidence.hasChat) {
    add(
      "no after-hours capture mechanism",
      "No live chat or AI assistant was detected on the reviewed homepage.",
      "Visitors outside business hours may leave without making contact."
    );
  }

  if (!evidence.hasStructuredReviews && evidence.testimonialCount <= 1) {
    add(
      "no structured review system",
      "No structured review display and no substantial testimonial section were detected on the reviewed homepage.",
      "New visitors receive limited proof before deciding to enquire."
    );
  }

  if (evidence.hasFax) {
    add(
      "outdated contact channel listed",
      "A fax contact method is publicly listed on the reviewed website.",
      "The contact experience can feel dated to prospective customers."
    );
  }

  if (evidence.hasContactForm && !evidence.hasBooking && !evidence.hasChat) {
    add(
      "static contact form dependency",
      "The primary detected conversion path is a static contact form without booking or live assistance.",
      "High-intent visitors cannot complete the next step immediately."
    );
  }

  if (!evidence.hasPhoneLink && evidence.phone) {
    add(
      "phone number is not click-to-call",
      "A phone number is available, but no clickable telephone link was detected on the homepage.",
      "Mobile visitors face extra effort before they can call."
    );
  }

  if (!evidence.hasEmailLink && evidence.email) {
    add(
      "email address is not click-to-email",
      "An email address is available, but no clickable email link was detected on the homepage.",
      "Visitors face extra friction when trying to contact the business."
    );
  }

  return {
    header: {
      confidentiality: "INTERNAL - SALES TEAM USE ONLY - DO NOT SEND TO CLIENT",
      brandLine: `${record.brand.name.toUpperCase()} · MINI AUDIT REPORT · ${new Date()
        .toISOString()
        .slice(0, 10)}`,
      title: `${evidence.siteName} - Mini Audit`,
      subtitle: "One page. Everything you need before you dial.",
    },
    snapshot: {
      businessName: evidence.siteName,
      phone: evidence.phone || "Not publicly listed - verify on call",
      email: evidence.email || "Not publicly listed - verify on call",
      website: evidence.domain,
      platform: evidence.platform || "Not identifiable from public source",
      decisionMaker:
        evidence.decisionMaker || "Not publicly identified - verify on call",
      businessHours:
        evidence.businessHours || "Not publicly listed - verify on call",
      whatTheyDo: evidence.description,
    },
    salesFit: buildFallbackSalesFit(record, evidence, issues),
    issues: issues.slice(0, 10),
    footer: `INTERNAL USE ONLY. Do not forward this document to the client. Findings sourced from ${evidence.domain} public page source and public directories, ${new Date()
      .toISOString()
      .slice(0, 10)}. Send the Client Audit Report (technical, no recommendations) after the call. ${record.brand.name} - ${record.brand.website || "workspace"}`,
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
    placeId: clean(input.placeId),
    qualityScore: Number(input.qualityScore || input.confidence || 0),
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
    website: record.website,
    lead: record.lead,
    niche: record.niche,
    location: record.location,
    brand: record.brand,
    auditProfile: record.auditProfile || null,
    report: record.report,
    provider: record.provider,
    error: record.error,
    ...(includeEvidence ? { evidence: record.evidence } : {}),
  };
}

function reportCacheKey(workspaceId, website, kind, profileHash = "") {
  return crypto
    .createHash("sha256")
    .update(`${workspaceId}|${kind}|${website}|${profileHash}`)
    .digest("hex");
}

function auditProfileHash(profile = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizeAuditProfile(profile)))
    .digest("hex")
    .slice(0, 20);
}

function normalizeAuditProfile(value = {}) {
  const criteria = value.criteria && typeof value.criteria === "object"
    ? value.criteria
    : {};

  return {
    businessNiche: clean(value.businessNiche).slice(0, 180),
    idealCustomer: clean(value.idealCustomer).slice(0, 600),
    offer: clean(value.offer).slice(0, 800),
    targetMarket: clean(value.targetMarket).slice(0, 240),
    pitchGoal: clean(value.pitchGoal).slice(0, 600),
    customInstructions: clean(value.customInstructions).slice(0, 1600),
    criteria: {
      nicheFit: criteria.nicheFit !== false,
      offerRelevance: criteria.offerRelevance !== false,
      websiteConversion: criteria.websiteConversion !== false,
      bookingFriction: criteria.bookingFriction !== false,
      localVisibility: criteria.localVisibility !== false,
      reviewsTrust: criteria.reviewsTrust !== false,
      performance: criteria.performance !== false,
      followUpOpportunity: criteria.followUpOpportunity !== false,
      competitorGaps: criteria.competitorGaps !== false,
    },
  };
}

function normalizeSalesFit(value = {}, record, issues = [], evidence = {}) {
  const fallback = buildFallbackSalesFit(record, evidence, issues);
  const score = Number(value?.fitScore ?? value?.score);

  return {
    fitScore: Number.isFinite(score)
      ? clamp(score, 0, 100)
      : fallback.fitScore,
    alignment: clean(value?.alignment) || fallback.alignment,
    summary: clean(value?.summary) || fallback.summary,
    likelyNeeds: toStringArray(value?.likelyNeeds, 8).length
      ? toStringArray(value?.likelyNeeds, 8)
      : fallback.likelyNeeds,
    pitchAngles: toStringArray(value?.pitchAngles, 8).length
      ? toStringArray(value?.pitchAngles, 8)
      : fallback.pitchAngles,
    suggestedOpener:
      oneSentence(value?.suggestedOpener) || fallback.suggestedOpener,
    caution:
      clean(value?.caution) ||
      "Commercial fit is based on public evidence and workspace targeting context; it is not proof of prospect interest or buying intent.",
  };
}

function buildFallbackSalesFit(record, evidence = {}, issues = []) {
  const profile = normalizeAuditProfile(record?.auditProfile || {});
  const issueList = Array.isArray(issues) ? issues : [];
  const businessNiche = normalize(profile.businessNiche);
  const leadNiche = normalize(record?.niche || record?.lead?.category);
  const nicheAligned =
    Boolean(businessNiche && leadNiche) &&
    (businessNiche.includes(leadNiche) || leadNiche.includes(businessNiche));
  const hasOffer = Boolean(profile.offer);
  const evidenceDepth = Math.min(10, issueList.length);
  const score = clamp(
    40 +
      (nicheAligned ? 20 : 0) +
      (hasOffer ? 10 : 0) +
      Math.min(20, evidenceDepth * 2),
    0,
    100
  );
  const likelyNeeds = issueList
    .map((item) => clean(item?.pain || item?.businessImpact))
    .filter(Boolean)
    .slice(0, 5);
  const pitchAngles = issueList
    .map((item) => {
      const finding = clean(item?.finding || item?.evidence);
      if (!finding) return "";
      return profile.offer
        ? `${finding} Connect the conversation to ${profile.offer} only if the prospect confirms this is a real priority.`
        : finding;
    })
    .filter(Boolean)
    .slice(0, 5);
  const firstFinding = clean(
    issueList.find((item) => item?.finding || item?.evidence)?.finding ||
      issueList.find((item) => item?.finding || item?.evidence)?.evidence
  );
  const business = clean(record?.lead?.business || record?.lead?.name || evidence?.siteName || "the business");

  return {
    fitScore: score,
    alignment: nicheAligned
      ? `Strong niche alignment with ${profile.businessNiche || record?.niche || "the workspace target"}`
      : profile.businessNiche
        ? `Potential fit to review against ${profile.businessNiche}`
        : "Commercial fit requires workspace targeting context",
    summary: hasOffer
      ? `Verified public findings can be compared with the configured offer: ${profile.offer}.`
      : "Verified public findings are ready for a specific sales conversation.",
    likelyNeeds,
    pitchAngles,
    suggestedOpener: firstFinding
      ? `I was looking at ${business} and noticed ${lowerFirst(firstFinding)} I wanted to ask how you are handling that today.`
      : `I wanted to ask how ${business} is currently handling lead conversion and follow-up.`,
    caution:
      "Commercial fit is based on public evidence and workspace targeting context; it is not proof of prospect interest or buying intent.",
  };
}

function lowerFirst(value) {
  const text = clean(value);
  return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : "";
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

  pdf.header(brand, `${audit.kind.toUpperCase()} AUDIT REPORT`, audit.website);

  if (audit.kind === "mini") {
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
    pdf.heading(report.title || "Full Website Audit", 19);
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
  const kind = normalize(value || "mini");
  return ["mini", "competitor", "full"].includes(kind) ? kind : "mini";
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
