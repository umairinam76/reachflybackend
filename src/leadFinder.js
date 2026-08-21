import crypto from "node:crypto";
import * as cheerio from "cheerio";

const DEBUG_LEADS =
  process.env.LEAD_DEBUG === "true" ||
  process.env.LEAD_DEBUG === "1";

const DEFAULT_TOTAL_BUDGET_MS = Number(
  process.env.LEAD_TOTAL_BUDGET_MS || 80_000
);

const DEFAULT_WEBSITE_TIMEOUT_MS = Number(
  process.env.LEAD_WEBSITE_TIMEOUT_MS || 2_500
);

const DEFAULT_ENRICH_CONCURRENCY = Number(
  process.env.LEAD_ENRICH_CONCURRENCY || 8
);

const DEFAULT_MAX_ENRICH = Number(
  process.env.LEAD_MAX_ENRICH || 40
);

const DEFAULT_ENRICH_HARD_TIMEOUT_MS = Number(
  process.env.LEAD_ENRICH_HARD_TIMEOUT_MS || 4_000
);

const MIN_RIGHT_LEAD_SCORE = Number(
  process.env.LEAD_MIN_RIGHT_SCORE || 35
);

const WEBSITE_HEADERS = {
  "user-agent":
    "ReachFlyLeadVerifier/1.0 (+https://reachfly.ai)",
  accept:
    "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const BAD_EMAIL_DOMAINS = new Set([
  "example.com",
  "domain.com",
  "yourdomain.com",
  "test.com",
  "sentry.io",
  "wixpress.com",
  "schema.org",
  "cloudflare.com",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "yoursite.com",
  "email.com",
]);

const COMMON_PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

const BLOCKED_WEBSITE_HOSTS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "linktr.ee",
  "yelp.com",
  "yellowpages.com",
]);

const NICHE_VARIANTS = [
  {
    match: ["dentist", "dental", "orthodont"],
    terms: ["dentist", "dental clinic", "dental care", "orthodontist"],
  },
  {
    match: ["doctor", "medical", "clinic", "healthcare"],
    terms: ["medical clinic", "doctor", "health clinic", "healthcare provider"],
  },
  {
    match: ["law", "lawyer", "attorney", "legal"],
    terms: ["law firm", "lawyer", "attorney", "legal services"],
  },
  {
    match: ["real estate", "realtor", "estate agent"],
    terms: ["real estate agency", "realtor", "estate agent", "property agency"],
  },
  {
    match: ["accountant", "accounting", "bookkeeping", "cpa", "tax"],
    terms: ["accounting firm", "accountant", "bookkeeper", "tax advisor"],
  },
  {
    match: ["restaurant", "cafe", "coffee", "food"],
    terms: ["restaurant", "cafe", "coffee shop", "food business"],
  },
  {
    match: ["plumber", "plumbing"],
    terms: ["plumber", "plumbing company", "plumbing contractor"],
  },
  {
    match: ["electrician", "electrical"],
    terms: ["electrician", "electrical company", "electrical contractor"],
  },
  {
    match: ["roof", "roofing", "roofer"],
    terms: ["roofing company", "roofer", "roofing contractor"],
  },
  {
    match: ["hvac", "heating", "cooling", "air conditioning"],
    terms: ["hvac company", "air conditioning contractor", "heating and cooling"],
  },
  {
    match: ["salon", "hair", "beauty"],
    terms: ["beauty salon", "hair salon", "salon"],
  },
  {
    match: ["gym", "fitness", "trainer"],
    terms: ["gym", "fitness center", "personal trainer"],
  },
  {
    match: ["auto repair", "mechanic", "car repair", "garage"],
    terms: ["auto repair shop", "mechanic", "car repair"],
  },
  {
    match: ["hotel", "motel", "lodging"],
    terms: ["hotel", "motel", "lodging"],
  },
  {
    match: ["school", "education", "training"],
    terms: ["school", "training center", "education center"],
  },
  {
    match: ["spa", "massage"],
    terms: ["spa", "massage therapy", "wellness center"],
  },
];

export function createLeadFinder(options = {}) {
  const placesProvider = options.placesProvider || null;

  const totalBudgetMs = clampNumber(
    options.totalBudgetMs || DEFAULT_TOTAL_BUDGET_MS,
    10_000,
    300_000
  );

  const websiteTimeoutMs = clampNumber(
    options.websiteTimeoutMs || DEFAULT_WEBSITE_TIMEOUT_MS,
    1_000,
    20_000
  );

  const enrichConcurrency = clampNumber(
    options.enrichConcurrency || DEFAULT_ENRICH_CONCURRENCY,
    1,
    20
  );

  const maxEnrich = clampNumber(
    options.maxEnrich || DEFAULT_MAX_ENRICH,
    0,
    500
  );

  if (DEBUG_LEADS) {
    leadLog("startup", "google-places:provider-status", {
      enabled: Boolean(placesProvider?.enabled?.()),
      diagnostics: placesProvider?.getDiagnostics?.() || null,
      totalBudgetMs,
      websiteTimeoutMs,
      enrichConcurrency,
      maxEnrich,
    });
  }

  async function findLeads(input = {}) {
    const runId =
      cleanText(input.runId) ||
      crypto.randomUUID().slice(0, 8);

    const startedAt = Date.now();

    const niche = cleanText(
      input.niche ||
        input.category ||
        input.businessType
    );

    const location = cleanText(input.location);

    const requestedLimit = clampNumber(
      input.limit || 100,
      1,
      1_000
    );

    const qualityLevel =
      cleanText(input.qualityLevel) || "balanced";

    const onProgress =
      typeof input.onProgress === "function"
        ? input.onProgress
        : null;

    const onLeadBatch =
      typeof input.onLeadBatch === "function"
        ? input.onLeadBatch
        : null;

    const signal =
      input.signal &&
      typeof input.signal === "object"
        ? input.signal
        : null;

    const excludedIdentityKeys = normalizeExcludedLeadKeys(
      input.excludeKeys || input.excludedKeys || input.seenLeadKeys
    );

    const isAborted = () =>
      Boolean(signal?.aborted);

    async function emitLeadBatch(leads, meta = {}) {
      if (!onLeadBatch) return;

      const normalized = filterExcludedLeads(
        dedupeLeads(
          (Array.isArray(leads) ? leads : [])
            .filter(Boolean)
            .map((lead) =>
              normalizeGoogleLead(lead, {
                niche,
                location,
              })
            )
        ).filter(isRightLead),
        excludedIdentityKeys
      );

      if (!normalized.length) return;

      try {
        await onLeadBatch({
          leads: normalized,
          phase: meta.phase || "discovery",
          total: Number(meta.total || normalized.length),
          query: cleanText(meta.query),
          queryIndex: Number(meta.queryIndex || 0),
          page: Number(meta.page || 0),
          index: Number(meta.index || 0),
          runId,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        leadLog(runId, "lead-batch:callback-failed", {
          error: error?.message || String(error),
          phase: meta.phase || "discovery",
        });
      }
    }

    if (!niche) {
      throw createError(
        400,
        "Target niche is required.",
        "LEAD_NICHE_REQUIRED"
      );
    }

    if (!location) {
      throw createError(
        400,
        "Location is required.",
        "LEAD_LOCATION_REQUIRED"
      );
    }

    if (
      !placesProvider ||
      typeof placesProvider.searchCandidates !== "function"
    ) {
      throw createError(
        503,
        "Google Places provider is not connected.",
        "GOOGLE_PLACES_PROVIDER_MISSING"
      );
    }

    if (!placesProvider.enabled?.()) {
      const error = createError(
        503,
        "GOOGLE_PLACES_API_KEY is not configured.",
        "GOOGLE_PLACES_NOT_CONFIGURED"
      );

      error.details =
        placesProvider.getDiagnostics?.() || null;

      throw error;
    }

    const minScore = getMinimumScore(qualityLevel);

    const nicheVariants = buildNicheVariants(niche);

    const exactMode =
      input.exact !== false;

    const discoveryTarget = Math.min(
      1_000,
      Math.max(
        requestedLimit,
        exactMode
          ? requestedLimit * (excludedIdentityKeys.size ? 6 : 3)
          : requestedLimit * (excludedIdentityKeys.size ? 4 : 2),
        requestedLimit +
          (excludedIdentityKeys.size
            ? Math.min(400, Math.max(160, requestedLimit * 2))
            : exactMode
              ? 80
              : 30)
      )
    );

    const deadlineAt =
      startedAt + totalBudgetMs;

    const remainingMs = () =>
      Math.max(
        0,
        deadlineAt - Date.now()
      );

    const exactFillPasses =
      exactMode
        ? Math.min(
            3,
            Math.max(
              excludedIdentityKeys.size ? 3 : 1,
              clampNumber(
                Number(
                  process.env
                    .LEAD_EXACT_FILL_PASSES ||
                    2
                ),
                1,
                3
              )
            )
          )
        : 1;

    leadLog(runId, "started", {
      niche,
      location,
      requestedLimit,
      discoveryTarget,
      qualityLevel,
      minScore,
      nicheVariants,
      excludedIdentityCount:
        excludedIdentityKeys.size,
      providerDiagnostics:
        placesProvider.getDiagnostics?.() || null,
    });

    progress(onProgress, {
      type: "lead-search-started",
      percent: 3,
      message:
        `Searching Google Places for ${niche} businesses in ${location}.`,
      meta: {
        runId,
        niche,
        location,
        requestedLimit,
        provider: "google-places",
        excludedIdentityCount:
          excludedIdentityKeys.size,
      },
    });

    const providerRuns = [];
    let seeds = [];

    for (
      let fillPass = 0;
      fillPass < exactFillPasses;
      fillPass += 1
    ) {
      if (
        isAborted() ||
        remainingMs() <= 5_000
      ) {
        break;
      }

      if (fillPass > 0) {
        const currentlyUsable =
          rankLeads(
            filterExcludedLeads(
              seeds.map((seed) =>
                normalizeGoogleLead(
                  seed,
                  {
                    niche,
                    location,
                  }
                )
              ),
              excludedIdentityKeys
            ),
            {
              niche,
              location,
              minScore,
              exact:
                exactMode,
            }
          ).length;

        if (
          currentlyUsable >=
          requestedLimit
        ) {
          break;
        }

        progress(onProgress, {
          type:
            "lead-exact-fill-pass",
          percent: Math.min(
            54,
            38 + fillPass * 8
          ),
          message:
            `Found ${currentlyUsable}/${requestedLimit} usable matching leads. Running another Google Places pass to fill the requested total.`,
          meta: {
            runId,
            fillPass:
              fillPass + 1,
            found:
              currentlyUsable,
            requested:
              requestedLimit,
          },
        });
      }

      const passTarget =
        Math.min(
          1_000,
          Math.max(
            discoveryTarget,
            requestedLimit *
              (3 + fillPass)
          )
        );

      const passResult =
        await placesProvider
          .searchCandidates({
            runId:
              `${runId}-p${fillPass + 1}`,
            niche,
            nicheVariants,
            location,
            limit:
              passTarget,
            regionCode:
              cleanText(
                input.regionCode
              ),
            locationVariants:
              Array.isArray(
                input.locationVariants
              )
                ? input
                    .locationVariants
                : [],
            exact:
              exactMode,
            deadlineAt,
            recoveryRoundOffset:
              fillPass * 2,
            forceRefresh:
              fillPass > 0 ||
              excludedIdentityKeys.size > 0,
            signal,
            onProgress,
            onCandidateBatch:
              async (batch) => {
                await emitLeadBatch(
                  batch?.candidates ||
                    [],
                  {
                    phase:
                      "discovery",
                    total:
                      batch?.total ||
                      0,
                    query:
                      batch?.query ||
                      "",
                    queryIndex:
                      batch
                        ?.queryIndex ||
                      0,
                    page:
                      batch?.page ||
                      0,
                  }
                );
              },
          });

      providerRuns.push(
        passResult
      );

      seeds = dedupeLeads([
        ...seeds,
        ...(
          passResult
            ?.candidates || []
        ),
      ]);

      const usableAfterPass =
        rankLeads(
          filterExcludedLeads(
            seeds.map((seed) =>
              normalizeGoogleLead(
                seed,
                {
                  niche,
                  location,
                }
              )
            ),
            excludedIdentityKeys
          ),
          {
            niche,
            location,
            minScore,
            exact:
              exactMode,
          }
        ).length;

      leadLog(
        runId,
        "google-places:fill-pass",
        {
          fillPass:
            fillPass + 1,
          passTarget,
          candidateCount:
            seeds.length,
          usableCount:
            usableAfterPass,
          requested:
            requestedLimit,
          providerMeta:
            passResult?.meta ||
            {},
        }
      );

      if (
        !exactMode ||
        usableAfterPass >=
          requestedLimit
      ) {
        break;
      }
    }

    const providerResult =
      providerRuns[
        providerRuns.length - 1
      ] || {
        candidates: [],
        meta: {},
      };

    leadLog(
      runId,
      "google-places:complete",
      {
        seeds:
          seeds.length,
        providerRuns:
          providerRuns.length,
        meta:
          providerResult?.meta ||
          {},
      }
    );

    progress(onProgress, {
      type:
        "lead-google-places-complete",
      percent: 55,
      message:
        `Google Places returned ${seeds.length} unique matching business candidates.`,
      meta: {
        runId,
        seedCount:
          seeds.length,
        providerRuns:
          providerRuns.length,
        providerMeta:
          providerResult?.meta ||
          {},
      },
    });

    const freshSeeds = filterExcludedLeads(
      seeds,
      excludedIdentityKeys
    );

    const enrichLimit =
      remainingMs() > websiteTimeoutMs
        ? Math.min(
            freshSeeds.length,
            requestedLimit,
            maxEnrich
          )
        : 0;

    let enriched = [];

    if (enrichLimit > 0) {
      progress(onProgress, {
        type: "lead-enrichment-started",
        percent: 58,
        message:
          `Checking ${enrichLimit} official business websites for public email and contact details.`,
        meta: {
          runId,
          enrichLimit,
        },
      });

      let enrichmentCompleted = 0;

      enriched = (
        await mapWithConcurrency(
          freshSeeds.slice(0, enrichLimit),
          enrichConcurrency,
          async (seed, index) => {
            const normalizedSeed =
              normalizeGoogleLead(seed, {
                niche,
                location,
              });

            if (
              isAborted() ||
              remainingMs() <= 1_000
            ) {
              enrichmentCompleted += 1;

              await emitLeadBatch([normalizedSeed], {
                phase: "enrichment",
                total: enrichLimit,
                index: enrichmentCompleted,
              });

              return normalizedSeed;
            }

            const hardTimeoutMs = Math.max(
              1_000,
              Math.min(
                DEFAULT_ENRICH_HARD_TIMEOUT_MS,
                remainingMs()
              )
            );

            const enrichedLead =
              await settleWithin(
                enrichGoogleSeed({
                  seed,
                  niche,
                  location,
                  timeoutMs: Math.min(
                    websiteTimeoutMs,
                    hardTimeoutMs
                  ),
                }),
                hardTimeoutMs,
                normalizedSeed
              );

            enrichmentCompleted += 1;

            progress(onProgress, {
              type: "lead-enriching",
              percent: Math.min(
                92,
                58 +
                  Math.round(
                    (enrichmentCompleted /
                      Math.max(1, enrichLimit)) *
                      34
                  )
              ),
              message:
                `Verified ${enrichmentCompleted}/${enrichLimit} business websites.`,
              meta: {
                runId,
                index: index + 1,
                completed:
                  enrichmentCompleted,
                enrichLimit,
              },
            });

            await emitLeadBatch([enrichedLead], {
              phase: "enrichment",
              total: enrichLimit,
              index: enrichmentCompleted,
            });

            return enrichedLead;
          }
        )
      ).filter(Boolean);
    }

    const enrichedByKey = new Map();

    for (const lead of enriched) {
      for (const key of leadKeys(lead)) {
        enrichedByKey.set(key, lead);
      }
    }

    const combined = freshSeeds.map((seed) => {
      const enrichedLead = leadKeys(seed)
        .map((key) => enrichedByKey.get(key))
        .find(Boolean);

      return enrichedLead ||
        normalizeGoogleLead(seed, {
          niche,
          location,
        });
    });

    const ranked = rankLeads(
      filterExcludedLeads(combined, excludedIdentityKeys),
      {
        niche,
        location,
        minScore,
        exact: exactMode,
      }
    );

    const leads = ranked.slice(
      0,
      requestedLimit
    );

    const delivered = leads.length;
    const shortfall = Math.max(
      0,
      requestedLimit - delivered
    );

    const exact =
      delivered === requestedLimit;

    const status = exact
      ? "completed_exact"
      : delivered
        ? "completed_partial"
        : "completed_empty";

    const message = exact
      ? `Found exactly ${delivered} fresh Google Places leads.`
      : delivered
        ? `Found ${delivered} fresh Google Places leads. ${shortfall} more were requested but no additional unseen matching businesses were available within the configured Google search limits.`
        : excludedIdentityKeys.size
          ? "No new matching businesses were available after excluding leads already seen by this workspace."
          : "Google Places did not return any usable matching business leads for this search.";

    progress(onProgress, {
      type: "lead-search-complete",
      percent: 100,
      message,
      meta: {
        runId,
        requested: requestedLimit,
        delivered,
        shortfall,
        exact,
      },
    });

    const result = {
      ok: true,
      status,
      exact,
      requested: requestedLimit,
      delivered,
      shortfall,
      message,
      leads,
      meta: {
        source: "google-places",
        provider: "google-places",
        rightLeadsOnly: true,
        noFakeLeads: true,
        niche,
        location,
        qualityLevel,
        minimumScore: minScore,
        candidateCount: seeds.length,
        freshCandidateCount: freshSeeds.length,
        excludedIdentityCount: excludedIdentityKeys.size,
        filteredPreviouslySeenCount: Math.max(0, seeds.length - freshSeeds.length),
        enrichedCount: enriched.length,
        elapsedMs: Date.now() - startedAt,
        providerMeta:
          providerResult?.meta || {},
        providerRuns:
          providerRuns.map(
            (item) =>
              item?.meta || {}
          ),
      },
    };

    leadLog(runId, "complete", {
      requested: requestedLimit,
      delivered,
      shortfall,
      exact,
      candidateCount: seeds.length,
      freshCandidateCount: freshSeeds.length,
      excludedIdentityCount: excludedIdentityKeys.size,
      enrichedCount: enriched.length,
      elapsedMs: Date.now() - startedAt,
    });

    return result;
  }

  return {
    findLeads,
    buildTargetedNicheSearchPlan,
    isRightLead,
  };
}

async function enrichGoogleSeed({
  seed,
  niche,
  location,
  timeoutMs,
}) {
  const base = normalizeGoogleLead(seed, {
    niche,
    location,
  });

  if (!base.website) {
    return base;
  }

  try {
    const homeHtml = await fetchText(
      base.website,
      {
        timeoutMs,
      }
    );

    const $ = cheerio.load(homeHtml);

    const contactLinks = findContactLinks(
      $,
      base.website
    ).slice(0, 2);

    const contactHtml = (
      await mapWithConcurrency(
        contactLinks,
        2,
        async (url) => {
          try {
            return await fetchText(url, {
              timeoutMs: Math.min(
                timeoutMs,
                4_000
              ),
            });
          } catch {
            return "";
          }
        }
      )
    ).filter(Boolean);

    const allHtml = [
      homeHtml,
      ...contactHtml,
    ].join("\n");

    const allText = cleanText(
      [
        $("body").text(),
        ...contactHtml.map((html) =>
          cheerio.load(html)("body").text()
        ),
      ].join(" ")
    );

    const schema = extractSchemaBusiness($);

    const emails = uniqueStrings([
      ...extractEmails(allHtml),
      ...extractEmails(allText),
    ]);

    const selectedEmail =
      selectBestBusinessEmail(
        emails,
        base.website
      );

    const websiteName = cleanBusinessName(
      schema.name ||
        $("meta[property='og:site_name']")
          .attr("content") ||
        $("meta[property='og:title']")
          .attr("content") ||
        $("title").first().text()
    );

    const lead = {
      ...base,
      name:
        base.name ||
        websiteName ||
        schema.name,
      business:
        base.business ||
        websiteName ||
        schema.name,
      email:
        base.email ||
        selectedEmail ||
        "",
      phone:
        base.phone ||
        schema.phone ||
        extractPhone(allText) ||
        extractPhone(allHtml),
      address:
        base.address ||
        schema.address ||
        location,
      source: "Business website",
      sourceAttribution:
        "Google Places discovery; official website verification",
      signals: uniqueStrings([
        ...(base.signals || []),
        "google_places_verified",
        "official_website",
        ...(selectedEmail
          ? ["email_found"]
          : []),
        ...(schema.name
          ? ["schema_found"]
          : []),
        ...(contactLinks.length
          ? ["contact_page_found"]
          : []),
      ]),
    };

    return scoreLead(lead, {
      niche,
      location,
    });
  } catch (error) {
    leadLog(
      cleanText(seed?.placeId) ||
        "website",
      "website:verification-failed",
      {
        website: base.website,
        error:
          error?.message ||
          String(error),
      }
    );

    return base;
  }
}

function normalizeGoogleLead(
  input = {},
  { niche = "", location = "" } = {}
) {
  const website = sanitizeBusinessWebsite(
    input.website
  );

  const name = cleanBusinessName(
    input.name ||
      input.business ||
      input.company ||
      ""
  );

  const lead = {
    id:
      input.id ||
      `lead_${crypto.randomUUID()}`,
    name,
    business:
      cleanBusinessName(
        input.business ||
          input.name ||
          input.company ||
          ""
      ) || name,
    contact_name: cleanText(
      input.contact_name ||
        input.contactName ||
        ""
    ),
    email:
      isLikelyBusinessEmail(
        input.email
      ) &&
      isEmailRelevantToWebsite(
        input.email,
        website
      )
        ? cleanText(input.email)
            .toLowerCase()
        : "",
    phone: normalizePhone(
      input.phone || ""
    ),
    website,
    domain: getHostname(website),
    address: cleanText(
      input.address || location
    ),
    location: cleanText(
      input.location || location
    ),
    category: cleanText(
      input.category || niche
    ),
    placeId: cleanText(
      input.placeId || ""
    ),
    source: cleanText(
      input.source ||
        "Google Places"
    ),
    sourceAttribution: cleanText(
      input.sourceAttribution ||
        "Google Places"
    ),
    sourceQuery: cleanText(
      input.sourceQuery || ""
    ),
    sourceFetchedAt: cleanText(
      input.sourceFetchedAt || ""
    ),
    businessStatus: cleanText(
      input.businessStatus || ""
    ),
    coordinates:
      input.coordinates &&
      Number.isFinite(
        input.coordinates.lat
      ) &&
      Number.isFinite(
        input.coordinates.lng
      )
        ? {
            lat: input.coordinates.lat,
            lng: input.coordinates.lng,
          }
        : null,
    status:
      input.status || "new",
    conversionStatus:
      input.conversionStatus ||
      "new",
    timeline: Array.isArray(
      input.timeline
    )
      ? input.timeline
      : [],
    stageStatus:
      input.stageStatus || {},
    signals: uniqueStrings([
      ...(Array.isArray(input.signals)
        ? input.signals
        : []),
      "google_places",
      ...(website
        ? ["website_found"]
        : []),
      ...(input.phone
        ? ["phone_found"]
        : []),
      ...(input.placeId
        ? ["place_id_found"]
        : []),
    ]),
  };

  return scoreLead(lead, {
    niche,
    location,
  });
}

function scoreLead(
  lead,
  { niche, location }
) {
  let score = 0;

  if (lead.name) score += 18;
  if (lead.website) score += 24;
  if (lead.phone) score += 18;
  if (lead.email) score += 22;
  if (lead.address) score += 8;
  if (lead.placeId) score += 6;

  const haystack = normalize(
    [
      lead.name,
      lead.business,
      lead.category,
      lead.address,
      lead.location,
      lead.website,
      lead.sourceQuery,
    ].join(" ")
  );

  const nicheWords = normalize(niche)
    .split(" ")
    .filter((word) => word.length >= 3);

  const locationWords = normalize(location)
    .split(" ")
    .filter((word) => word.length >= 3);

  if (
    nicheWords.some((word) =>
      haystack.includes(word)
    )
  ) {
    score += 8;
  }

  if (
    locationWords.some((word) =>
      haystack.includes(word)
    )
  ) {
    score += 4;
  }

  if (
    cleanText(lead.businessStatus)
      .toUpperCase() ===
    "CLOSED_PERMANENTLY"
  ) {
    score -= 60;
  }

  const qualityScore = clampNumber(
    score,
    0,
    100
  );

  return {
    ...lead,
    qualityScore,
    confidence: qualityScore,
    dataQuality:
      qualityScore >= 80
        ? "excellent"
        : qualityScore >= 60
          ? "good"
          : qualityScore >= 40
            ? "usable"
            : "weak",
  };
}

function rankLeads(
  leads,
  {
    niche,
    location,
    minScore,
    exact = false,
  }
) {
  const scored =
    dedupeLeads(leads)
      .map((lead) =>
        scoreLead(lead, {
          niche,
          location,
        })
      )
      .filter(isRightLead);

  const eligible = exact
    ? scored
    : scored.filter(
        (lead) =>
          lead.qualityScore >=
          minScore
      );

  return eligible.sort(
    (a, b) => {
      const aPreferred =
        a.qualityScore >=
        minScore
          ? 1
          : 0;

      const bPreferred =
        b.qualityScore >=
        minScore
          ? 1
          : 0;

      if (
        exact &&
        bPreferred !==
          aPreferred
      ) {
        return (
          bPreferred -
          aPreferred
        );
      }

      if (
        b.qualityScore !==
        a.qualityScore
      ) {
        return (
          b.qualityScore -
          a.qualityScore
        );
      }

      if (
        Boolean(b.email) !==
        Boolean(a.email)
      ) {
        return (
          Number(
            Boolean(b.email)
          ) -
          Number(
            Boolean(a.email)
          )
        );
      }

      if (
        Boolean(b.phone) !==
        Boolean(a.phone)
      ) {
        return (
          Number(
            Boolean(b.phone)
          ) -
          Number(
            Boolean(a.phone)
          )
        );
      }

      return String(
        a.name
      ).localeCompare(
        String(b.name)
      );
    }
  );
}

export function isRightLead(
  lead
) {
  if (!lead) return false;

  const name = cleanBusinessName(
    lead.name ||
      lead.business ||
      ""
  );

  if (!name || name.length < 2) {
    return false;
  }

  const hasUsableBusinessIdentity =
    Boolean(
      lead.website ||
      lead.phone ||
      lead.placeId ||
      lead.address
    );

  if (
    !hasUsableBusinessIdentity
  ) {
    return false;
  }

  if (
    cleanText(
      lead.businessStatus
    ).toUpperCase() ===
    "CLOSED_PERMANENTLY"
  ) {
    return false;
  }

  return (
    Number(
      lead.qualityScore ||
        lead.confidence ||
        0
    ) >= MIN_RIGHT_LEAD_SCORE
  );
}

export function buildTargetedNicheSearchPlan(
  {
    niche,
    location,
    limit = 100,
  } = {}
) {
  const cleanNiche =
    cleanText(niche);

  const cleanLocation =
    cleanText(location);

  const requestedLimit =
    clampNumber(
      limit,
      1,
      1_000
    );

  const nicheVariants =
    buildNicheVariants(
      cleanNiche
    );

  return {
    source: "google-places",
    primaryQuery:
      `${cleanNiche} in ${cleanLocation}`.trim(),
    nicheVariants,
    requestedLimit,
    discoveryTargetCount:
      Math.min(
        1_000,
        Math.max(
          requestedLimit * 2,
          requestedLimit + 30
        )
      ),
  };
}

function buildNicheVariants(
  niche
) {
  const normalized =
    normalize(niche);

  const matched = [];

  for (const group of NICHE_VARIANTS) {
    if (
      group.match.some((term) =>
        normalized.includes(
          normalize(term)
        )
      )
    ) {
      matched.push(
        ...group.terms
      );
    }
  }

  return uniqueStrings([
    niche,
    ...matched,
  ]).slice(0, 8);
}

async function fetchText(
  value,
  {
    timeoutMs =
      DEFAULT_WEBSITE_TIMEOUT_MS,
  } = {}
) {
  const url = normalizeUrl(value);

  if (!url) {
    throw new Error(
      "Invalid website URL."
    );
  }

  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response =
      await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal:
          controller.signal,
        headers:
          WEBSITE_HEADERS,
      });

    if (!response.ok) {
      throw new Error(
        `Website returned HTTP ${response.status}.`
      );
    }

    const contentType =
      String(
        response.headers.get(
          "content-type"
        ) || ""
      ).toLowerCase();

    if (
      contentType &&
      !contentType.includes(
        "text/html"
      ) &&
      !contentType.includes(
        "text/plain"
      ) &&
      !contentType.includes(
        "application/xhtml"
      )
    ) {
      throw new Error(
        `Unsupported website content type: ${contentType}.`
      );
    }

    return await response.text();
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        `Website request timed out after ${timeoutMs}ms.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function findContactLinks(
  $,
  baseUrl
) {
  const links = [];

  $("a[href]").each(
    (_index, element) => {
      const href =
        normalizeUrl(
          $(element).attr(
            "href"
          ),
          baseUrl
        );

      if (
        !href ||
        !sameOrigin(
          href,
          baseUrl
        )
      ) {
        return;
      }

      const text = cleanText(
        $(element).text()
      );

      if (
        /contact|about|team|staff|location|quote|estimate|appointment/i.test(
          `${text} ${href}`
        )
      ) {
        links.push(href);
      }
    }
  );

  return uniqueStrings(links);
}

function extractSchemaBusiness(
  $
) {
  const result = {};

  $(
    "script[type='application/ld+json']"
  ).each((_index, element) => {
    try {
      const parsed =
        JSON.parse(
          $(element).text()
        );

      const roots =
        Array.isArray(parsed)
          ? parsed
          : [parsed];

      const items =
        roots.flatMap(
          flattenSchema
        );

      for (const item of items) {
        const type =
          Array.isArray(
            item?.["@type"]
          )
            ? item["@type"].join(
                " "
              )
            : item?.["@type"] ||
              "";

        if (
          !/LocalBusiness|Organization|ProfessionalService|Store|Restaurant|Dentist|MedicalBusiness/i.test(
            type
          )
        ) {
          continue;
        }

        if (
          !result.name &&
          item.name
        ) {
          result.name =
            cleanBusinessName(
              item.name
            );
        }

        if (
          !result.phone &&
          item.telephone
        ) {
          result.phone =
            normalizePhone(
              item.telephone
            );
        }

        if (
          !result.address &&
          item.address
        ) {
          result.address =
            typeof item.address ===
            "string"
              ? cleanText(
                  item.address
                )
              : cleanText(
                  [
                    item.address
                      ?.streetAddress,
                    item.address
                      ?.addressLocality,
                    item.address
                      ?.addressRegion,
                    item.address
                      ?.postalCode,
                    item.address
                      ?.addressCountry,
                  ]
                    .filter(Boolean)
                    .join(", ")
                );
        }
      }
    } catch {
      // Invalid JSON-LD should not fail lead discovery.
    }
  });

  return result;
}

function flattenSchema(
  item
) {
  if (
    !item ||
    typeof item !== "object"
  ) {
    return [];
  }

  const output = [item];

  if (
    Array.isArray(
      item["@graph"]
    )
  ) {
    output.push(
      ...item["@graph"]
    );
  }

  return output;
}

function extractEmails(
  text
) {
  const normalized =
    String(text || "")
      .replace(
        /\s*\[at\]\s*/gi,
        "@"
      )
      .replace(
        /\s*\(at\)\s*/gi,
        "@"
      )
      .replace(
        /\s+at\s+/gi,
        "@"
      )
      .replace(
        /\s*\[dot\]\s*/gi,
        "."
      )
      .replace(
        /\s*\(dot\)\s*/gi,
        "."
      )
      .replace(
        /\s+dot\s+/gi,
        "."
      );

  const matches =
    normalized.match(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi
    ) || [];

  return uniqueStrings(
    matches
      .map((email) =>
        email
          .toLowerCase()
          .replace(
            /[),.;:'"`\]]+$/g,
            ""
          )
          .trim()
      )
      .filter(
        isLikelyBusinessEmail
      )
  );
}

function isLikelyBusinessEmail(
  value
) {
  const email = cleanText(
    value
  ).toLowerCase();

  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      email
    )
  ) {
    return false;
  }

  if (
    /\.\.|^\.|\.@|@\.|\.$/.test(
      email
    )
  ) {
    return false;
  }

  const [
    local,
    domain = "",
  ] = email.split("@");

  const tld =
    domain.split(".").pop() || "";

  if (
    !local ||
    !domain ||
    tld.length < 2 ||
    BAD_EMAIL_DOMAINS.has(domain) ||
    [...BAD_EMAIL_DOMAINS].some(
      (blocked) =>
        domain.endsWith(`.${blocked}`)
    ) ||
    [
      "join",
      "follow",
      "local",
      "invalid",
      "example",
    ].includes(tld)
  ) {
    return false;
  }

  if (
    /^(test|example|demo|sample|noreply|no-reply|donotreply|yourname|name)$/i.test(
      local
    )
  ) {
    return false;
  }

  return true;
}

function selectBestBusinessEmail(
  emails,
  website
) {
  return (
    (Array.isArray(emails)
      ? emails
      : []
    ).find((email) =>
      isEmailRelevantToWebsite(
        email,
        website
      )
    ) || ""
  );
}

function isEmailRelevantToWebsite(
  value,
  website
) {
  const email = cleanText(
    value
  ).toLowerCase();

  if (!isLikelyBusinessEmail(email)) {
    return false;
  }

  const domain =
    email.split("@")[1] || "";

  if (
    COMMON_PUBLIC_EMAIL_DOMAINS.has(
      domain
    )
  ) {
    return true;
  }

  const websiteHost =
    getHostname(website);

  if (!websiteHost) {
    return false;
  }

  const emailRoot =
    getComparableDomain(domain);
  const websiteRoot =
    getComparableDomain(
      websiteHost
    );

  return Boolean(
    emailRoot &&
      websiteRoot &&
      emailRoot === websiteRoot
  );
}

function getComparableDomain(
  value
) {
  const host = cleanText(value)
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");

  const parts = host
    .split(".")
    .filter(Boolean);

  if (parts.length <= 2) {
    return parts.join(".");
  }

  const secondLevelSuffixes =
    new Set([
      "co.uk",
      "org.uk",
      "com.au",
      "net.au",
      "co.nz",
      "co.ca",
    ]);

  const lastTwo =
    parts.slice(-2).join(".");

  if (
    secondLevelSuffixes.has(lastTwo) &&
    parts.length >= 3
  ) {
    return parts.slice(-3).join(".");
  }

  return lastTwo;
}

function extractPhone(
  text
) {
  const patterns = [
    /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/,
    /\+?\d[\d\s().-]{8,}\d/,
  ];

  for (const pattern of patterns) {
    const match =
      String(text || "").match(
        pattern
      );

    if (match) {
      const phone =
        normalizePhone(
          match[0]
        );

      if (phone) {
        return phone;
      }
    }
  }

  return "";
}

function normalizePhone(
  value
) {
  const raw = cleanText(
    value
  );

  if (!raw) return "";

  const digits =
    raw.replace(/\D/g, "");

  if (
    digits.length < 7 ||
    digits.length > 15
  ) {
    return "";
  }

  if (
    /^(\d)\1+$/.test(
      digits
    )
  ) {
    return "";
  }

  return raw;
}

function dedupeLeads(
  leads
) {
  const map = new Map();

  for (const raw of leads) {
    if (!raw) continue;

    const keys = leadKeys(raw);

    const existing =
      keys
        .map((key) =>
          map.get(key)
        )
        .find(Boolean);

    const merged = existing
      ? mergeLead(
          existing,
          raw
        )
      : raw;

    for (const key of leadKeys(merged)) {
      map.set(key, merged);
    }
  }

  return [
    ...new Set(map.values()),
  ];
}

function mergeLead(
  current,
  incoming
) {
  return {
    ...current,
    ...incoming,
    name:
      current.name ||
      incoming.name,
    business:
      current.business ||
      incoming.business,
    email:
      current.email ||
      incoming.email,
    phone:
      current.phone ||
      incoming.phone,
    website:
      current.website ||
      incoming.website,
    address:
      current.address ||
      incoming.address,
    placeId:
      current.placeId ||
      incoming.placeId,
    signals: uniqueStrings([
      ...(current.signals || []),
      ...(incoming.signals || []),
    ]),
  };
}

function leadKeys(
  lead
) {
  const keys = [];

  const placeId = cleanText(
    lead?.placeId || lead?.place_id
  ).toLowerCase();

  const host = getHostname(
    lead?.website || lead?.domain
  );

  const phone = cleanText(
    lead?.phone ||
      lead?.internationalPhoneNumber ||
      lead?.nationalPhoneNumber
  ).replace(/\D/g, "");

  const email = cleanText(
    lead?.email
  ).toLowerCase();

  const name = normalize(
    lead?.name ||
      lead?.business
  );

  const address = normalize(
    lead?.address ||
      [
        lead?.street,
        lead?.city,
        lead?.state,
        lead?.postalCode,
      ]
        .filter(Boolean)
        .join(" ")
  );

  if (placeId) {
    keys.push(
      `place:${placeId}`
    );
  }

  if (host) {
    keys.push(`host:${host}`);
    keys.push(`domain:${host}`);
  }

  if (email) {
    keys.push(
      `email:${email}`
    );
  }

  if (phone.length >= 7) {
    keys.push(
      `phone:${phone}`
    );
  }

  if (name && address) {
    keys.push(
      `business:${name}|${address}`
    );
  } else if (name) {
    keys.push(
      `name:${name}`
    );
  }

  return uniqueStrings(keys);
}

function normalizeExcludedLeadKeys(value) {
  const values =
    value instanceof Set
      ? [...value]
      : Array.isArray(value)
        ? value
        : value &&
          typeof value !== "string" &&
          typeof value[Symbol.iterator] === "function"
          ? [...value]
          : [];

  return new Set(
    values
      .map((item) => cleanText(item).toLowerCase())
      .filter(Boolean)
  );
}

function isExcludedLead(lead, excludedKeys) {
  if (!(excludedKeys instanceof Set) || !excludedKeys.size) {
    return false;
  }

  return leadKeys(lead).some((key) =>
    excludedKeys.has(cleanText(key).toLowerCase())
  );
}

function filterExcludedLeads(leads, excludedKeys) {
  if (!(excludedKeys instanceof Set) || !excludedKeys.size) {
    return Array.isArray(leads) ? leads.filter(Boolean) : [];
  }

  return (Array.isArray(leads) ? leads : [])
    .filter(Boolean)
    .filter((lead) => !isExcludedLead(lead, excludedKeys));
}

async function settleWithin(
  promise,
  timeoutMs,
  fallbackValue
) {
  const safeTimeoutMs = Math.max(
    250,
    Number(timeoutMs || 0)
  );

  let timer;

  try {
    return await Promise.race([
      Promise.resolve(promise).catch(
        () => fallbackValue
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(fallbackValue),
          safeTimeoutMs
        );

      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function mapWithConcurrency(
  items,
  limit,
  mapper
) {
  if (!items.length) {
    return [];
  }

  const output =
    new Array(items.length);

  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;

      try {
        output[index] =
          await mapper(
            items[index],
            index
          );
      } catch {
        output[index] = null;
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          limit,
          items.length
        ),
      },
      () => worker()
    )
  );

  return output;
}

function sanitizeBusinessWebsite(
  value
) {
  const url = normalizeUrl(value);

  if (!url) return "";

  const host = getHostname(url);

  if (
    !host ||
    BLOCKED_WEBSITE_HOSTS.has(host) ||
    [...BLOCKED_WEBSITE_HOSTS].some(
      (blocked) =>
        host.endsWith(`.${blocked}`)
    )
  ) {
    return "";
  }

  return url;
}

function normalizeUrl(
  value,
  baseUrl = ""
) {
  let input = cleanText(
    value
  );

  if (!input) return "";

  try {
    if (baseUrl) {
      input =
        new URL(
          input,
          baseUrl
        ).toString();
    } else if (
      !/^https?:\/\//i.test(
        input
      )
    ) {
      input = `https://${input}`;
    }

    const url =
      new URL(input);

    if (
      !["http:", "https:"].includes(
        url.protocol
      )
    ) {
      return "";
    }

    url.hash = "";

    return url.toString();
  } catch {
    return "";
  }
}

function sameOrigin(
  a,
  b
) {
  try {
    return (
      new URL(a).origin ===
      new URL(b).origin
    );
  } catch {
    return false;
  }
}

function getHostname(
  value
) {
  try {
    return new URL(
      String(value || "")
    )
      .hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanBusinessName(
  value
) {
  return cleanText(value)
    .replace(
      /\s*[-|•]\s*(official site|home|homepage|website).*$/i,
      ""
    )
    .replace(
      /\s*\|\s*.*$/i,
      ""
    )
    .replace(
      /^["'“”]+|["'“”]+$/g,
      ""
    )
    .trim();
}

function getMinimumScore(
  level
) {
  if (level === "strict") {
    return 65;
  }

  if (
    level === "expanded"
  ) {
    return 30;
  }

  return 45;
}

function progress(
  onProgress,
  event
) {
  if (!onProgress) return;

  try {
    onProgress({
      ...event,
      createdAt:
        new Date().toISOString(),
    });
  } catch {
    // Progress callbacks must never stop discovery.
  }
}

function cleanText(
  value
) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(
  value
) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(
  values
) {
  return [
    ...new Set(
      values
        .map(cleanText)
        .filter(Boolean)
    ),
  ];
}

function clampNumber(
  value,
  min,
  max
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return min;
  }

  return Math.max(
    min,
    Math.min(
      max,
      Math.floor(number)
    )
  );
}

function createError(
  statusCode,
  message,
  code
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  error.code = code;

  return error;
}

function leadLog(
  runId,
  event,
  data = {}
) {
  if (!DEBUG_LEADS) {
    return;
  }

  console.log(
    `[leadFinder:${runId}] ${event} ${JSON.stringify({
      at: new Date().toISOString(),
      runId,
      event,
      ...data,
    })}`
  );
}
