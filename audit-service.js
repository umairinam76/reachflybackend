import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";

const MAX_HTML_BYTES = Number(process.env.AUDIT_MAX_HTML_BYTES || 2_500_000);
const FETCH_TIMEOUT_MS = Number(process.env.AUDIT_FETCH_TIMEOUT_MS || 18_000);
const MAX_BENCHMARKS = 3;
const PAGESPEED_ENDPOINT =
  "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";
const PAGESPEED_TIMEOUT_MS = Number(
  process.env.PAGESPEED_TIMEOUT_MS || 45_000
);

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "executiveSummary",
    "score",
    "strengths",
    "priorityFindings",
    "opportunities",
    "benchmarkSummary",
    "recommendedRoadmap",
    "callOpening",
    "emailSubject",
    "emailBody",
    "disclaimer",
  ],
  properties: {
    executiveSummary: { type: "string" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    strengths: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
    },
    priorityFindings: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "evidence", "businessImpact", "recommendation"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          evidence: { type: "string" },
          businessImpact: { type: "string" },
          recommendation: { type: "string" },
        },
      },
    },
    opportunities: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "whyItFits", "effort", "expectedOutcome"],
        properties: {
          title: { type: "string" },
          whyItFits: { type: "string" },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          expectedOutcome: { type: "string" },
        },
      },
    },
    benchmarkSummary: { type: "string" },
    recommendedRoadmap: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "timeframe", "actions"],
        properties: {
          phase: { type: "string" },
          timeframe: { type: "string" },
          actions: { type: "array", items: { type: "string" }, maxItems: 5 },
        },
      },
    },
    callOpening: { type: "string" },
    emailSubject: { type: "string" },
    emailBody: { type: "string" },
    disclaimer: { type: "string" },
  },
};

export function createAuditService({ store } = {}) {
  async function createAudit(user, input = {}) {
    const targetUrl = await validatePublicUrl(input.website);
    const benchmarkUrls = await resolveBenchmarkUrls({
      targetUrl,
      input,
      store,
      user,
    });

    const target = await inspectWebsite(targetUrl.toString(), {
      runPageSpeed: input.runPageSpeed !== false && shouldRunPageSpeed(),
    });
    const benchmarks = [];

    for (const benchmarkUrl of benchmarkUrls.slice(0, MAX_BENCHMARKS)) {
      try {
        benchmarks.push(
          await inspectWebsite(benchmarkUrl, {
            runPageSpeed:
              shouldRunPageSpeed() &&
              String(process.env.AUDIT_PAGESPEED_BENCHMARKS || "false") === "true",
          })
        );
      } catch (error) {
        benchmarks.push({
          url: benchmarkUrl,
          failed: true,
          error: error.message,
          checks: [],
          features: {},
        });
      }
    }

    const evidence = buildEvidence({ target, benchmarks, input });
    const deterministic = buildDeterministicReport(evidence);
    const generated = await generateReportWithOpenAI(evidence).catch((error) => ({
      ...deterministic,
      generationNote: `AI narrative fallback used: ${error.message}`,
    }));

    const now = new Date().toISOString();
    const audit = {
      id: crypto.randomUUID(),
      workspaceId: user.workspaceId || user.id,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      targetUrl: target.url,
      niche: clean(input.niche),
      location: clean(input.location),
      companyName: clean(input.companyName) || target.siteName || target.host,
      benchmarkUrls,
      evidence,
      report: generated,
      status: "complete",
    };

    if (store) {
      store.update((state) => {
        state.audits = state.audits || [];
        state.audits.unshift(audit);
      });
    }

    return audit;
  }

  function listAudits(user) {
    const workspaceId = user.workspaceId || user.id;
    return (store?.read().audits || []).filter(
      (audit) => audit.workspaceId === workspaceId
    );
  }

  function getAudit(user, id) {
    const workspaceId = user.workspaceId || user.id;
    return (store?.read().audits || []).find(
      (audit) => audit.id === id && audit.workspaceId === workspaceId
    );
  }

  return { createAudit, listAudits, getAudit };
}

async function resolveBenchmarkUrls({ targetUrl, input, store, user }) {
  const explicit = uniqueUrls(input.benchmarkUrls || [])
    .filter((url) => hostname(url) !== targetUrl.hostname)
    .slice(0, MAX_BENCHMARKS);

  if (explicit.length >= 2 || !store) return explicit;

  const workspaceId = user.workspaceId || user.id;
  const niche = normalize(input.niche);
  const location = normalize(input.location);
  const candidates = [];

  for (const campaign of store.read().campaigns || []) {
    if (campaign.workspaceId !== workspaceId) continue;

    const campaignNiche = normalize(campaign.niche);
    const campaignLocation = normalize(campaign.location);
    if (niche && campaignNiche && !overlaps(niche, campaignNiche)) continue;
    if (location && campaignLocation && !overlaps(location, campaignLocation)) continue;

    for (const lead of campaign.leads || []) {
      if (!lead.website) continue;
      candidates.push({
        url: lead.website,
        score:
          Number(lead.qualityScore || lead.confidence || 0) +
          Math.min(20, Number(lead.rating || 0) * 2),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return uniqueUrls([...explicit, ...candidates.map((item) => item.url)])
    .filter((url) => hostname(url) !== targetUrl.hostname)
    .slice(0, MAX_BENCHMARKS);
}

function overlaps(a, b) {
  return a.includes(b) || b.includes(a) ||
    a.split(/\s+/).some((token) => token.length > 3 && b.includes(token));
}

async function inspectWebsite(value, { runPageSpeed = false } = {}) {
  const url = await validatePublicUrl(value);
  const startedAt = Date.now();
  const response = await safeFetch(url.toString());
  const html = response.html;
  const $ = cheerio.load(html);

  const title = clean($("title").first().text());
  const description = clean($("meta[name='description']").attr("content"));
  const h1 = $("h1").map((_, el) => clean($(el).text())).get().filter(Boolean);
  const headings = $("h2,h3").length;
  const forms = $("form").length;
  const inputs = $("input,select,textarea").length;
  const buttons = $("button,input[type='submit'],a").filter((_, el) =>
    /book|schedule|contact|get started|request|quote|call|appointment|demo/i.test(
      clean($(el).text()) || clean($(el).attr("value"))
    )
  ).length;
  const bodyText = clean($("body").text()).slice(0, 120_000);
  const scripts = $("script[src]").map((_, el) => $(el).attr("src")).get();
  const links = $("a[href]").map((_, el) => $(el).attr("href")).get();
  const images = $("img");
  const imagesMissingAlt = images.filter((_, el) => !clean($(el).attr("alt"))).length;
  const internalLinks = links.filter((href) => isInternalLink(href, url)).length;
  const schemaTypes = extractSchemaTypes($);
  const siteName =
    clean($("meta[property='og:site_name']").attr("content")) ||
    title.split(/[|—–-]/)[0]?.trim() ||
    hostToName(url.hostname);

  const features = {
    https: url.protocol === "https:",
    responsiveViewport: Boolean($("meta[name='viewport']").attr("content")),
    hasTitle: title.length >= 12,
    hasMetaDescription: description.length >= 50,
    hasSingleH1: h1.length === 1,
    hasContactForm: forms > 0 && inputs > 0,
    hasStrongCta: buttons > 0,
    hasPhoneLink: links.some((href) => String(href).startsWith("tel:")),
    hasEmailLink: links.some((href) => String(href).startsWith("mailto:")),
    hasWhatsApp: links.some((href) => /wa\.me|whatsapp/i.test(String(href))),
    hasBooking: links.some((href) =>
      /calendly|acuityscheduling|zocdoc|book|appointment|schedule/i.test(String(href))
    ),
    hasAnalytics: scripts.some((src) =>
      /googletagmanager|google-analytics|segment|mixpanel|hotjar|clarity/i.test(String(src))
    ),
    hasChat: scripts.some((src) =>
      /intercom|crisp|tawk|drift|hubspot|zendesk|freshchat/i.test(String(src))
    ),
    hasSchema: schemaTypes.length > 0,
    hasFaqContent: /frequently asked|faq/i.test(bodyText),
    hasTestimonials: /testimonial|what our clients|patient stories|reviews/i.test(bodyText),
    hasPrivacy: links.some((href) => /privacy/i.test(String(href))),
    hasTerms: links.some((href) => /terms/i.test(String(href))),
    hasSitemapLink: links.some((href) => /sitemap/i.test(String(href))),
  };

  const checks = [
    check("HTTPS enabled", features.https, "The primary URL should use HTTPS."),
    check("Responsive viewport", features.responsiveViewport, "Add a mobile viewport meta tag."),
    check("Descriptive page title", features.hasTitle, `Current title: ${title || "missing"}`),
    check("Meta description", features.hasMetaDescription, `Current length: ${description.length}`),
    check("One clear H1", features.hasSingleH1, `Detected ${h1.length} H1 elements.`),
    check("Lead capture form", features.hasContactForm, `Detected ${forms} form elements.`),
    check("Conversion CTA", features.hasStrongCta, `Detected ${buttons} likely CTA elements.`),
    check("Clickable phone", features.hasPhoneLink, "No tel: link detected."),
    check("Clickable email", features.hasEmailLink, "No mailto: link detected."),
    check("Booking flow", features.hasBooking, "No obvious appointment/demo booking link detected."),
    check("Analytics tag", features.hasAnalytics, "No common analytics script detected."),
    check("Live chat", features.hasChat, "No common chat widget detected."),
    check("Structured data", features.hasSchema, `Schema types: ${schemaTypes.join(", ") || "none"}`),
    check("FAQ content", features.hasFaqContent, "No FAQ language detected on the reviewed page."),
    check("Trust proof", features.hasTestimonials, "No testimonial/review section detected."),
    check("Privacy link", features.hasPrivacy, "No privacy link detected."),
    check("Terms link", features.hasTerms, "No terms link detected."),
    check(
      "Image accessibility",
      images.length === 0 || imagesMissingAlt / images.length <= 0.15,
      `${imagesMissingAlt}/${images.length} images appear to lack alt text.`
    ),
  ];

  const pageSpeed = runPageSpeed
    ? await runPageSpeedAudit(response.finalUrl).catch((error) => ({
        available: false,
        error: error.message,
      }))
    : { available: false, skipped: true };

  if (pageSpeed.available) {
    const { performance, accessibility, seo, bestPractices } = pageSpeed.scores;

    checks.push(
      scoreCheck(
        "Mobile performance",
        performance,
        65,
        "Improve loading, rendering, and main-thread work using the detailed Lighthouse opportunities."
      ),
      scoreCheck(
        "Automated accessibility",
        accessibility,
        85,
        "Review Lighthouse accessibility findings and validate them with manual keyboard and screen-reader testing."
      ),
      scoreCheck(
        "Technical SEO",
        seo,
        85,
        "Resolve the failed Lighthouse SEO audits and verify indexing configuration."
      ),
      scoreCheck(
        "Web best practices",
        bestPractices,
        85,
        "Resolve failed Lighthouse best-practice checks and retest after deployment."
      )
    );
  }

  return {
    url: response.finalUrl,
    host: url.hostname,
    siteName,
    status: response.status,
    contentType: response.contentType,
    loadMs: Date.now() - startedAt,
    htmlBytes: Buffer.byteLength(html),
    title,
    description,
    h1: h1.slice(0, 5),
    headingCount: headings,
    formCount: forms,
    inputCount: inputs,
    ctaCount: buttons,
    imageCount: images.length,
    imagesMissingAlt,
    internalLinkCount: internalLinks,
    schemaTypes,
    securityHeaders: response.securityHeaders,
    pageSpeed,
    features,
    checks,
    rawScore: calculateScore(checks),
  };
}

function buildEvidence({ target, benchmarks, input }) {
  const successfulBenchmarks = benchmarks.filter((item) => !item.failed);
  const benchmarkFeatureFrequency = {};

  for (const benchmark of successfulBenchmarks) {
    for (const [key, value] of Object.entries(benchmark.features || {})) {
      benchmarkFeatureFrequency[key] =
        (benchmarkFeatureFrequency[key] || 0) + Number(Boolean(value));
    }
  }

  const opportunityGaps = Object.entries(benchmarkFeatureFrequency)
    .filter(([key, count]) => count >= 2 && !target.features[key])
    .map(([key, count]) => ({ feature: key, benchmarkCount: count }));

  return {
    target,
    benchmarks,
    benchmarkFeatureFrequency,
    opportunityGaps,
    context: {
      niche: clean(input.niche),
      location: clean(input.location),
      companyName: clean(input.companyName) || target.siteName,
      offer: clean(input.offer),
      auditGoal: clean(input.auditGoal) || "identify practical digital and workflow opportunities",
    },
    generatedAt: new Date().toISOString(),
  };
}

async function generateReportWithOpenAI(evidence) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_AUDIT_MODEL || "gpt-5";

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      {
        role: "system",
        content: [
          "You create evidence-grounded B2B website and technology audit reports.",
          "Never invent traffic, revenue loss, conversion rates, compliance status, or technologies that are not in the evidence.",
          "Describe automated checks as observations, not certainty.",
          "Benchmark comparisons must only use the supplied benchmark evidence.",
          "Keep outreach concise, respectful, and suitable for a cold call followed by email.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify(evidence),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "reachfly_audit_report",
        strict: true,
        schema: REPORT_SCHEMA,
      },
    },
  });

  return JSON.parse(response.output_text);
}

function buildDeterministicReport(evidence) {
  const failed = evidence.target.checks.filter((item) => !item.pass);
  const passed = evidence.target.checks.filter((item) => item.pass);
  const priorityFindings = failed.slice(0, 6).map((item) => ({
    title: item.name,
    severity: severityForCheck(item.name),
    evidence: item.evidence,
    businessImpact: genericImpact(item.name),
    recommendation: item.recommendation,
  }));

  const opportunities = evidence.opportunityGaps.slice(0, 6).map((gap) => ({
    title: humanize(gap.feature),
    whyItFits: `${gap.benchmarkCount} reviewed benchmark sites use this capability while it was not detected on the target page.`,
    effort: /analytics|privacy|terms|phone|email/i.test(gap.feature) ? "small" : "medium",
    expectedOutcome: "Improve clarity, lead handling, measurement, or visitor trust after validation with the business owner.",
  }));

  const company = evidence.context.companyName || evidence.target.siteName;
  const firstFinding = priorityFindings[0];

  return {
    executiveSummary: `${company} has a website foundation score of ${evidence.target.rawScore}/100 from the automated checks performed. The strongest next step is to validate the highest-priority gaps with the business before proposing implementation.`,
    score: evidence.target.rawScore,
    strengths: passed.slice(0, 6).map((item) => item.name),
    priorityFindings,
    opportunities,
    benchmarkSummary: evidence.benchmarks.length
      ? `${evidence.benchmarks.filter((item) => !item.failed).length} benchmark sites were checked. Comparisons are limited to detectable public-page features.`
      : "No benchmark URLs were available; the report uses only the target website evidence.",
    recommendedRoadmap: [
      {
        phase: "Validate",
        timeframe: "Week 1",
        actions: ["Confirm enquiry sources", "Confirm response ownership", "Validate the highest-impact audit observations"],
      },
      {
        phase: "Improve",
        timeframe: "Weeks 2–4",
        actions: priorityFindings.slice(0, 3).map((item) => item.recommendation),
      },
      {
        phase: "Automate and measure",
        timeframe: "Month 2+",
        actions: ["Connect lead sources", "Track follow-up stages", "Measure response and meeting outcomes"],
      },
    ],
    callOpening: `Hi, I reviewed ${company}'s website and noticed ${firstFinding?.title || "a few practical lead-flow opportunities"}. How are new enquiries currently captured and followed up when the team is busy?`,
    emailSubject: `A few practical observations for ${company}`,
    emailBody: `Hi,\n\nI reviewed ${company}'s public website and noted a few practical opportunities. The most relevant observation was: ${firstFinding?.evidence || "the enquiry flow may benefit from a short review"}.\n\nThese are automated observations, so I would first validate them with you before recommending any work. Would a short workflow review be useful?\n\nBest,\nCodeSync Labs`,
    disclaimer: "This audit is based on automated checks of publicly accessible pages at a specific time. It is not a security penetration test, legal review, accessibility certification, or guarantee of commercial impact.",
  };
}

function shouldRunPageSpeed() {
  return (
    Boolean(process.env.PAGESPEED_API_KEY) ||
    String(process.env.AUDIT_ENABLE_PAGESPEED || "false") === "true"
  );
}

async function runPageSpeedAudit(value) {
  const url = await validatePublicUrl(value);
  const requestUrl = new URL(PAGESPEED_ENDPOINT);
  requestUrl.searchParams.set("url", url.toString());
  requestUrl.searchParams.set("strategy", "mobile");

  for (const category of [
    "PERFORMANCE",
    "ACCESSIBILITY",
    "SEO",
    "BEST_PRACTICES",
  ]) {
    requestUrl.searchParams.append("category", category);
  }

  if (process.env.PAGESPEED_API_KEY) {
    requestUrl.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGESPEED_TIMEOUT_MS);

  try {
    const response = await fetch(requestUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "ReachFlyAudit/1.0 (+https://reachfly.ai)",
      },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          `PageSpeed Insights returned HTTP ${response.status}.`
      );
    }

    const categories = payload?.lighthouseResult?.categories || {};
    const percent = (key) => {
      const score = Number(categories[key]?.score);
      return Number.isFinite(score) ? Math.round(score * 100) : null;
    };

    return {
      available: true,
      strategy: "mobile",
      fetchedAt: new Date().toISOString(),
      analysisUrl: payload?.id || url.toString(),
      scores: {
        performance: percent("performance"),
        accessibility: percent("accessibility"),
        seo: percent("seo"),
        bestPractices: percent("best-practices"),
      },
      coreWebVitals: extractPageSpeedMetrics(payload),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("PageSpeed Insights audit timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractPageSpeedMetrics(payload) {
  const audits = payload?.lighthouseResult?.audits || {};
  const metric = (key) => {
    const audit = audits[key];
    if (!audit) return null;
    return {
      value: Number.isFinite(Number(audit.numericValue))
        ? Number(audit.numericValue)
        : null,
      displayValue: clean(audit.displayValue),
      score: Number.isFinite(Number(audit.score))
        ? Math.round(Number(audit.score) * 100)
        : null,
    };
  };

  return {
    firstContentfulPaint: metric("first-contentful-paint"),
    largestContentfulPaint: metric("largest-contentful-paint"),
    cumulativeLayoutShift: metric("cumulative-layout-shift"),
    totalBlockingTime: metric("total-blocking-time"),
    speedIndex: metric("speed-index"),
  };
}

function scoreCheck(name, score, threshold, recommendation) {
  const available =
    score !== null && score !== undefined && score !== "" &&
    Number.isFinite(Number(score));
  return {
    name,
    pass: available && Number(score) >= threshold,
    evidence: available
      ? `Lighthouse mobile score: ${Number(score)}/100.`
      : "Lighthouse did not return a score.",
    recommendation,
  };
}

async function safeFetch(value) {
  let currentUrl = await validatePublicUrl(value);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "ReachFlyAudit/1.0 (+https://reachfly.ai)",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          const error = new Error(
            `Website returned redirect HTTP ${response.status} without a location.`
          );
          error.statusCode = 422;
          throw error;
        }
        if (redirectCount >= 5) {
          const error = new Error("Website exceeded the redirect limit.");
          error.statusCode = 422;
          throw error;
        }

        const nextUrl = new URL(location, currentUrl);
        currentUrl = await validatePublicUrl(nextUrl.toString());
        continue;
      }

      if (!response.ok) {
        const error = new Error(`Website returned HTTP ${response.status}.`);
        error.statusCode = 422;
        throw error;
      }

      const contentType = String(response.headers.get("content-type") || "");
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        const error = new Error("The URL did not return an HTML page.");
        error.statusCode = 415;
        throw error;
      }

      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_HTML_BYTES) {
        const error = new Error("Website HTML is too large to audit safely.");
        error.statusCode = 413;
        throw error;
      }

      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body || []) {
        bytes += chunk.length;
        if (bytes > MAX_HTML_BYTES) {
          const error = new Error("Website HTML exceeded the audit size limit.");
          error.statusCode = 413;
          throw error;
        }
        chunks.push(Buffer.from(chunk));
      }

      return {
        html: Buffer.concat(chunks).toString("utf8"),
        status: response.status,
        finalUrl: currentUrl.toString(),
        contentType,
        securityHeaders: {
          contentSecurityPolicy: Boolean(
            response.headers.get("content-security-policy")
          ),
          strictTransportSecurity: Boolean(
            response.headers.get("strict-transport-security")
          ),
          xContentTypeOptions: Boolean(
            response.headers.get("x-content-type-options")
          ),
          referrerPolicy: Boolean(response.headers.get("referrer-policy")),
          permissionsPolicy: Boolean(
            response.headers.get("permissions-policy")
          ),
        },
      };
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("Website audit timed out.");
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Website audit could not resolve the final URL.");
}

async function validatePublicUrl(value) {
  let url;
  try {
    const raw = String(value || "").trim();
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    const error = new Error("A valid public website URL is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    const error = new Error("Only public HTTP and HTTPS URLs are supported.");
    error.statusCode = 400;
    throw error;
  }

  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    const error = new Error("Private, local, or unresolved website addresses are not allowed.");
    error.statusCode = 400;
    throw error;
  }

  return url;
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version === 6) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  }
  return true;
}

function check(name, pass, evidence) {
  return {
    name,
    pass: Boolean(pass),
    evidence,
    recommendation: recommendationForCheck(name),
  };
}

function calculateScore(checks) {
  if (!checks.length) return 0;
  return Math.round((checks.filter((item) => item.pass).length / checks.length) * 100);
}

function recommendationForCheck(name) {
  const recommendations = {
    "HTTPS enabled": "Redirect all traffic to HTTPS and verify certificate configuration.",
    "Responsive viewport": "Add a responsive viewport and test key flows on mobile devices.",
    "Descriptive page title": "Write a specific title describing the business and primary service.",
    "Meta description": "Add a clear search description with the service, audience, and location.",
    "One clear H1": "Use one clear page-level heading aligned with visitor intent.",
    "Lead capture form": "Add a concise, privacy-aware enquiry or booking form.",
    "Conversion CTA": "Add a visible next action above the fold and near decision points.",
    "Clickable phone": "Use a tel: link for mobile visitors.",
    "Clickable email": "Use a monitored contact method or structured enquiry form.",
    "Booking flow": "Add a clear appointment or consultation booking path where appropriate.",
    "Analytics tag": "Implement privacy-aware analytics and conversion events.",
    "Live chat": "Consider chat only when ownership, response time, and escalation are defined.",
    "Structured data": "Add valid organisation/service schema and test it before release.",
    "FAQ content": "Answer common buyer questions using accurate, specific content.",
    "Trust proof": "Add verifiable testimonials, case studies, credentials, or process proof.",
    "Privacy link": "Publish a privacy notice matching actual data collection and handling.",
    "Terms link": "Publish terms suitable for the services and jurisdiction after legal review.",
    "Image accessibility": "Add meaningful alt text to informative images and empty alt text to decorative images.",
    "Mobile performance": "Improve loading, rendering, image delivery, caching, and JavaScript execution based on Lighthouse evidence.",
    "Automated accessibility": "Resolve automated accessibility failures and perform manual keyboard and assistive-technology checks.",
    "Technical SEO": "Resolve failed technical SEO audits and verify crawlability, metadata, and indexing configuration.",
    "Web best practices": "Resolve Lighthouse best-practice failures and retest after deployment.",
  };
  return recommendations[name] || "Review and improve this area after validating business requirements.";
}

function severityForCheck(name) {
  if (/https|privacy/i.test(name)) return "high";
  if (/form|cta|booking|phone|email/i.test(name)) return "high";
  if (/performance|accessibility|best practices/i.test(name)) return "medium";
  if (/title|description|h1|structured|seo/i.test(name)) return "medium";
  return "low";
}

function genericImpact(name) {
  if (/form|cta|booking|phone|email/i.test(name)) return "Visitors may have difficulty taking or completing the intended next action.";
  if (/analytics/i.test(name)) return "The team may lack reliable evidence about which channels and pages create enquiries.";
  if (/privacy|terms|https/i.test(name)) return "Trust, governance, or risk management may be weaker than expected.";
  return "The issue may reduce clarity, discoverability, usability, or trust and should be validated with real users.";
}

function extractSchemaTypes($) {
  const values = [];
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      collectSchemaTypes(data, values);
    } catch {}
  });
  return [...new Set(values)].slice(0, 20);
}

function collectSchemaTypes(value, output) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectSchemaTypes(item, output));
    return;
  }
  if (value["@type"]) {
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    output.push(...types.map(clean).filter(Boolean));
  }
  Object.values(value).forEach((item) => collectSchemaTypes(item, output));
}

function isInternalLink(href, base) {
  try {
    const url = new URL(href, base);
    return url.hostname === base.hostname;
  } catch {
    return false;
  }
}

function uniqueUrls(values) {
  const urls = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const raw = String(value || "").trim();
      if (!raw) continue;
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      url.hash = "";
      const key = `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url.toString());
    } catch {}
  }
  return urls;
}

function hostname(value) {
  try { return new URL(value).hostname; } catch { return ""; }
}

function hostToName(host) {
  return String(host || "").replace(/^www\./, "").split(".")[0].replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanize(value) {
  return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
