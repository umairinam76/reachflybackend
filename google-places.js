import crypto from "node:crypto";

const PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText";

const DEFAULT_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.websiteUri",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.primaryType",
  "places.types",
  "places.businessStatus",
  "places.location",
  "nextPageToken",
].join(",");

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function numberFromEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function boolFromEnv(name, fallback = false) {
  const value = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRegionCode(value) {
  const code = cleanText(value).toUpperCase();

  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function safeHostname(value) {
  try {
    return new URL(String(value || ""))
      .hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fingerprintSecret(value) {
  if (!value) {
    return "not-configured";
  }

  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 10);
}

function isPlaceholderApiKey(value) {
  const normalized = cleanText(value).toLowerCase();

  return [
    "",
    "google_places_api_key",
    "your_google_places_api_key",
    "your-real-google-places-api-key",
    "replace-me",
    "changeme",
  ].includes(normalized);
}

function redactForLogs(value, depth = 0) {
  if (depth > 6) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => redactForLogs(item, depth + 1));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result = {};

  for (const [key, item] of Object.entries(value)) {
    if (
      /api[-_]?key|authorization|token|secret|password/i.test(
        key
      )
    ) {
      result[key] = "[redacted]";
      continue;
    }

    result[key] = redactForLogs(item, depth + 1);
  }

  return result;
}

function createLogger({
  level = "info",
  sampleRecords = false,
} = {}) {
  const configuredLevel =
    LOG_LEVELS[level] ?? LOG_LEVELS.info;

  function write(method, event, data = {}) {
    const eventLevel =
      LOG_LEVELS[method] ?? LOG_LEVELS.info;

    if (eventLevel < configuredLevel) {
      return;
    }

    const payload = redactForLogs({
      at: new Date().toISOString(),
      service: "google-places",
      event,
      ...data,
    });

    const output =
      `[google-places] ${event} ${JSON.stringify(payload)}`;

    if (method === "error") {
      console.error(output);
    } else if (method === "warn") {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  return {
    debug: (event, data) => write("debug", event, data),
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
    sampleRecords,
  };
}

function uniqueStrings(values) {
  return [
    ...new Set(
      values
        .map(cleanText)
        .filter(Boolean)
    ),
  ];
}

function buildQueries({
  niche,
  nicheVariants = [],
  location,
  locationVariants = [],
  maxQueries,
}) {
  const baseNiche = cleanText(niche);
  const baseLocation = cleanText(location);

  const niches = uniqueStrings([
    baseNiche,
    ...nicheVariants,
  ]).slice(0, 8);

  const locations = uniqueStrings([
    baseLocation,
    ...locationVariants,
  ]).slice(0, 8);

  const queries = [];

  for (const targetLocation of locations) {
    for (const targetNiche of niches) {
      queries.push(
        `${targetNiche} in ${targetLocation}`,
        `${targetNiche} near ${targetLocation}`
      );
    }
  }

  return uniqueStrings(queries).slice(0, maxQueries);
}

function mapPlaceToCandidate(
  place,
  {
    niche,
    location,
    query,
    fetchedAt,
  }
) {
  const website = cleanText(place?.websiteUri);
  const name = cleanText(place?.displayName?.text);

  const phone = cleanText(
    place?.internationalPhoneNumber ||
      place?.nationalPhoneNumber
  );

  const primaryType = cleanText(place?.primaryType);

  return {
    name,
    business: name,
    website,
    phone,
    address: cleanText(place?.formattedAddress),
    category: primaryType || cleanText(niche),
    location: cleanText(location),
    placeId: cleanText(place?.id),
    source: "Google Places seed",
    sourceAttribution: "Google Places",
    sourceQuery: cleanText(query),
    sourceFetchedAt: fetchedAt,
    transientSource: "google_places",
    transientQuery: cleanText(query),
    businessStatus: cleanText(place?.businessStatus),
    coordinates:
      Number.isFinite(place?.location?.latitude) &&
      Number.isFinite(place?.location?.longitude)
        ? {
            lat: place.location.latitude,
            lng: place.location.longitude,
          }
        : null,
    signals: [
      "google_places_seed",
      ...(website ? ["website_found"] : []),
      ...(phone ? ["phone_found"] : []),
      ...(place?.id ? ["place_id_found"] : []),
    ],
  };
}

function dedupeCandidates(candidates) {
  const seenPlaceIds = new Set();
  const seenHosts = new Set();
  const output = [];

  for (const candidate of candidates) {
    const placeId = cleanText(candidate?.placeId);
    const host = safeHostname(candidate?.website);

    if (placeId && seenPlaceIds.has(placeId)) {
      continue;
    }

    if (host && seenHosts.has(host)) {
      continue;
    }

    if (placeId) {
      seenPlaceIds.add(placeId);
    }

    if (host) {
      seenHosts.add(host);
    }

    output.push(candidate);
  }

  return output;
}

async function parseResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text.slice(0, 2_000),
    };
  }
}

function providerError({
  response,
  payload,
  elapsedMs,
  requestId,
}) {
  const message =
    cleanText(payload?.error?.message) ||
    cleanText(payload?.message) ||
    `Google Places returned HTTP ${response.status}.`;

  const error = new Error(message);

  error.statusCode = response.status;
  error.code = cleanText(
    payload?.error?.status ||
      payload?.error?.code
  );

  error.details = {
    provider: "google-places",
    requestId,
    httpStatus: response.status,
    providerCode: error.code,
    elapsedMs,
  };

  return error;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createGooglePlacesProvider(
  options = {}
) {
  const optionApiKey = cleanText(options.apiKey);
  const environmentApiKey = cleanText(
    process.env.GOOGLE_PLACES_API_KEY
  );

  const apiKeyCandidate =
    optionApiKey || environmentApiKey;

  const apiKey = isPlaceholderApiKey(apiKeyCandidate)
    ? ""
    : apiKeyCandidate;

  const apiKeySource = optionApiKey
    ? "options.apiKey"
    : environmentApiKey
      ? "process.env.GOOGLE_PLACES_API_KEY"
      : "missing";

  const timeoutMs = numberFromEnv(
    "GOOGLE_PLACES_TIMEOUT_MS",
    Number(options.timeoutMs || 20_000),
    1_000,
    120_000
  );

  const searchTimeoutMs = numberFromEnv(
    "GOOGLE_PLACES_SEARCH_TIMEOUT_MS",
    Number(options.searchTimeoutMs || 60_000),
    5_000,
    600_000
  );

  const maxPages = numberFromEnv(
    "GOOGLE_PLACES_MAX_PAGES",
    Number(options.maxPages || 3),
    1,
    3
  );

  const pageSize = numberFromEnv(
    "GOOGLE_PLACES_PAGE_SIZE",
    Number(options.pageSize || 20),
    1,
    20
  );

  const maxQueries = numberFromEnv(
    "GOOGLE_PLACES_MAX_QUERIES",
    Number(options.maxQueries || 8),
    1,
    50
  );

  const maxRequestsPerSearch = numberFromEnv(
    "GOOGLE_PLACES_MAX_REQUESTS_PER_SEARCH",
    Number(options.maxRequestsPerSearch || 10),
    1,
    100
  );

  const pageTokenDelayMs = numberFromEnv(
    "GOOGLE_PLACES_PAGE_TOKEN_DELAY_MS",
    Number(options.pageTokenDelayMs || 1_500),
    0,
    10_000
  );

  const fieldMask = cleanText(
    options.fieldMask ||
      process.env.GOOGLE_PLACES_FIELD_MASK ||
      DEFAULT_FIELD_MASK
  );

  const logLevel = cleanText(
    options.logLevel ||
      process.env.GOOGLE_PLACES_LOG_LEVEL ||
      (boolFromEnv("GOOGLE_PLACES_DEBUG")
        ? "debug"
        : "info")
  ).toLowerCase();

  const logger = createLogger({
    level: logLevel,
    sampleRecords: boolFromEnv(
      "GOOGLE_PLACES_LOG_SAMPLE_RECORDS",
      false
    ),
  });

  const runtime = {
    createdAt: new Date().toISOString(),
    searchCalls: 0,
    healthCheckCalls: 0,
    requestCalls: 0,
    activeRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastSearchAt: "",
    lastRequestAt: "",
    lastErrorAt: "",
    lastError: "",
  };

  function enabled() {
    return Boolean(apiKey);
  }

  function getRuntimeStats() {
    return {
      ...runtime,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  function getDiagnostics() {
    return {
      configured: enabled(),
      apiKeySource,
      environmentKeyPresent:
        Boolean(environmentApiKey),
      optionKeyPresent: Boolean(optionApiKey),
      endpoint: PLACES_TEXT_SEARCH_URL,
      keyFingerprint: fingerprintSecret(apiKey),
      timeoutMs,
      searchTimeoutMs,
      maxPages,
      pageSize,
      maxQueries,
      maxRequestsPerSearch,
      pageTokenDelayMs,
      logLevel,
      fieldMask,
      runtime: getRuntimeStats(),
    };
  }

  function recordProviderError(error) {
    runtime.lastErrorAt =
      new Date().toISOString();

    runtime.lastError =
      cleanText(error?.message) ||
      "Unknown provider error";
  }

  async function requestPage({
    textQuery,
    pageToken = "",
    regionCode = "",
    requestContext = {},
    deadlineAt = 0,
    externalSignal = null,
  }) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();

    runtime.requestCalls += 1;
    runtime.activeRequests += 1;
    runtime.lastRequestAt =
      new Date().toISOString();

    const body = {
      textQuery: cleanText(textQuery),
      pageSize,
      ...(pageToken
        ? {
            pageToken,
          }
        : {}),
      ...(cleanRegionCode(regionCode)
        ? {
            regionCode:
              cleanRegionCode(regionCode),
          }
        : {}),
    };

    logger.info("request:entered", {
      requestId,
      runId: requestContext.runId || "",
      healthCheck:
        Boolean(requestContext.healthCheck),
      queryIndex: requestContext.queryIndex,
      page: requestContext.page,
      textQuery: body.textQuery,
      regionCode: body.regionCode || "",
      hasPageToken: Boolean(pageToken),
      activeRequests: runtime.activeRequests,
    });

    try {
      if (!enabled()) {
        const error = new Error(
          "GOOGLE_PLACES_API_KEY is missing or still contains a placeholder value."
        );

        error.statusCode = 503;
        error.code =
          "GOOGLE_PLACES_NOT_CONFIGURED";
        error.details = getDiagnostics();

        throw error;
      }

      if (!body.textQuery) {
        const error = new Error(
          "Google Places textQuery cannot be empty."
        );

        error.statusCode = 400;
        error.code =
          "GOOGLE_PLACES_EMPTY_QUERY";

        throw error;
      }

      const remainingSearchMs = deadlineAt
        ? deadlineAt - Date.now()
        : timeoutMs;

      if (
        deadlineAt &&
        remainingSearchMs <= 0
      ) {
        const error = new Error(
          `Google Places search exceeded ${searchTimeoutMs}ms.`
        );

        error.statusCode = 504;
        error.code =
          "GOOGLE_PLACES_SEARCH_TIMEOUT";

        throw error;
      }

      const effectiveTimeoutMs = Math.max(
        1_000,
        Math.min(
          timeoutMs,
          remainingSearchMs || timeoutMs
        )
      );

      const controller =
        new AbortController();

      const abortFromExternal =
        () => controller.abort();

      if (externalSignal?.aborted) {
        controller.abort();
      } else {
        externalSignal?.addEventListener?.(
          "abort",
          abortFromExternal,
          { once: true }
        );
      }

      const timeout = setTimeout(
        () => controller.abort(),
        effectiveTimeoutMs
      );

      logger.info("request:fetch-start", {
        requestId,
        endpoint: PLACES_TEXT_SEARCH_URL,
        textQuery: body.textQuery,
        timeoutMs: effectiveTimeoutMs,
        pageSize,
        regionCode: body.regionCode || "",
        fieldMask,
      });

      try {
        const response = await fetch(
          PLACES_TEXT_SEARCH_URL,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type":
                "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask":
                fieldMask,
              "User-Agent":
                "ReachFly/1.0 GooglePlacesProvider",
            },
            body: JSON.stringify(body),
          }
        );

        logger.info(
          "request:response-received",
          {
            requestId,
            textQuery: body.textQuery,
            httpStatus: response.status,
            statusText: response.statusText,
            contentType:
              response.headers.get(
                "content-type"
              ) || "",
            elapsedMs:
              Date.now() - startedAt,
          }
        );

        const payload =
          await parseResponseBody(response);

        const elapsedMs =
          Date.now() - startedAt;

        if (!response.ok) {
          const error = providerError({
            response,
            payload,
            elapsedMs,
            requestId,
          });

          error.googlePlacesAlreadyLogged =
            true;

          logger.error("request:failed", {
            requestId,
            textQuery: body.textQuery,
            httpStatus: response.status,
            providerCode: error.code,
            message: error.message,
            elapsedMs,
            providerPayload: payload,
          });

          throw error;
        }

        const places = Array.isArray(
          payload?.places
        )
          ? payload.places
          : [];

        runtime.successfulRequests += 1;

        logger.info("request:complete", {
          requestId,
          textQuery: body.textQuery,
          httpStatus: response.status,
          returned: places.length,
          hasNextPage: Boolean(
            payload?.nextPageToken
          ),
          elapsedMs,
          ...(logger.sampleRecords
            ? {
                samples: places
                  .slice(0, 3)
                  .map((place) => ({
                    placeId:
                      cleanText(place?.id),
                    name: cleanText(
                      place?.displayName?.text
                    ),
                    websiteHost:
                      safeHostname(
                        place?.websiteUri
                      ),
                    hasPhone: Boolean(
                      place?.internationalPhoneNumber ||
                        place?.nationalPhoneNumber
                    ),
                  })),
              }
            : {}),
        });

        if (!places.length) {
          logger.warn("request:no-places", {
            requestId,
            textQuery: body.textQuery,
            regionCode:
              body.regionCode || "",
            elapsedMs,
          });
        }

        return {
          places,
          nextPageToken: cleanText(
            payload?.nextPageToken
          ),
          requestId,
          elapsedMs,
        };
      } catch (error) {
        if (error?.name === "AbortError") {
          const timeoutError = new Error(
            `Google Places timed out after ${effectiveTimeoutMs}ms.`
          );

          timeoutError.statusCode = 504;
          timeoutError.code =
            "GOOGLE_PLACES_TIMEOUT";

          timeoutError.details = {
            requestId,
            timeoutMs:
              effectiveTimeoutMs,
            textQuery: body.textQuery,
          };

          throw timeoutError;
        }

        throw error;
      } finally {
        clearTimeout(timeout);

        externalSignal?.removeEventListener?.(
          "abort",
          abortFromExternal
        );
      }
    } catch (error) {
      runtime.failedRequests += 1;
      recordProviderError(error);

      if (!error?.googlePlacesAlreadyLogged) {
        logger.error("request:exception", {
          requestId,
          textQuery: body.textQuery,
          elapsedMs:
            Date.now() - startedAt,
          errorName: error?.name || "",
          errorCode: error?.code || "",
          errorMessage:
            error?.message ||
            String(error),
          errorStack:
            error?.stack || "",
        });
      }

      throw error;
    } finally {
      runtime.activeRequests = Math.max(
        0,
        runtime.activeRequests - 1
      );

      logger.info("request:finished", {
        requestId,
        textQuery: body.textQuery,
        elapsedMs:
          Date.now() - startedAt,
        activeRequests:
          runtime.activeRequests,
        successfulRequests:
          runtime.successfulRequests,
        failedRequests:
          runtime.failedRequests,
      });
    }
  }

  async function searchCandidates(input = {}) {
    const searchCallId = crypto
      .randomUUID()
      .slice(0, 8);

    const niche = cleanText(input.niche);
    const location = cleanText(input.location);

    const requestedLimit = Math.max(
      1,
      Math.min(
        1_000,
        Number(input.limit || 100)
      )
    );

    const onProgress =
      typeof input.onProgress === "function"
        ? input.onProgress
        : null;

    const onCandidateBatch =
      typeof input.onCandidateBatch === "function"
        ? input.onCandidateBatch
        : null;

    runtime.searchCalls += 1;
    runtime.lastSearchAt =
      new Date().toISOString();

    logger.info("search:entered", {
      searchCallId,
      searchCallNumber:
        runtime.searchCalls,
      niche,
      location,
      requestedLimit,
      regionCode: input.regionCode,
      nicheVariants:
        input.nicheVariants,
      locationVariants:
        input.locationVariants,
      runId: input.runId,
      hasProgressCallback:
        Boolean(onProgress),
      hasCandidateBatchCallback:
        Boolean(onCandidateBatch),
    });

    if (!niche) {
      const error = new Error(
        "Google Places requires a target niche."
      );

      error.statusCode = 400;
      error.code =
        "GOOGLE_PLACES_NICHE_REQUIRED";

      throw error;
    }

    if (!location) {
      const error = new Error(
        "Google Places requires a target location."
      );

      error.statusCode = 400;
      error.code =
        "GOOGLE_PLACES_LOCATION_REQUIRED";

      throw error;
    }

    const queries = buildQueries({
      niche,
      nicheVariants:
        input.nicheVariants || [],
      location,
      locationVariants:
        input.locationVariants || [],
      maxQueries,
    });

    const runId =
      cleanText(input.runId) ||
      crypto.randomUUID().slice(0, 8);

    const startedAt = Date.now();
    const deadlineAt =
      startedAt + searchTimeoutMs;

    const allCandidates = [];
    const emittedCandidateKeys = new Set();
    let requestCount = 0;
    let stoppedReason = "";

    logger.info("search:query-plan", {
      searchCallId,
      runId,
      niche,
      location,
      requestedLimit,
      queryCount: queries.length,
      queries,
      maxPages,
      pageSize,
      maxRequestsPerSearch,
      maxPossibleRequests:
        queries.length * maxPages,
      searchTimeoutMs,
      regionCode:
        cleanRegionCode(input.regionCode),
      keyFingerprint:
        fingerprintSecret(apiKey),
    });

    outer:
    for (
      let queryIndex = 0;
      queryIndex < queries.length;
      queryIndex += 1
    ) {
      if (
        dedupeCandidates(allCandidates)
          .length >= requestedLimit
      ) {
        stoppedReason =
          "requested-limit-reached";
        break;
      }

      const query = queries[queryIndex];
      let pageToken = "";

      logger.info("search:query-start", {
        searchCallId,
        runId,
        query,
        queryIndex,
        queryNumber: queryIndex + 1,
        queryCount: queries.length,
        uniqueWebsiteSeeds:
          dedupeCandidates(allCandidates)
            .length,
      });

      for (
        let page = 1;
        page <= maxPages;
        page += 1
      ) {
        const uniqueBefore =
          dedupeCandidates(allCandidates)
            .length;

        if (
          uniqueBefore >= requestedLimit
        ) {
          stoppedReason =
            "requested-limit-reached";
          break outer;
        }

        if (
          requestCount >=
          maxRequestsPerSearch
        ) {
          stoppedReason =
            "max-requests-reached";

          logger.warn(
            "search:max-requests-reached",
            {
              searchCallId,
              runId,
              requestCount,
              maxRequestsPerSearch,
              delivered: uniqueBefore,
            }
          );

          break outer;
        }

        if (Date.now() >= deadlineAt) {
          stoppedReason =
            "search-timeout-reached";

          logger.warn(
            "search:deadline-reached",
            {
              searchCallId,
              runId,
              searchTimeoutMs,
              requestCount,
              delivered: uniqueBefore,
            }
          );

          break outer;
        }

        if (
          pageToken &&
          pageTokenDelayMs > 0
        ) {
          logger.debug(
            "search:page-token-delay",
            {
              searchCallId,
              runId,
              page,
              delayMs:
                pageTokenDelayMs,
            }
          );

          await delay(pageTokenDelayMs);
        }

        onProgress?.({
          type:
            "google-places-page-started",
          percent: Math.min(
            17,
            4 + queryIndex + page
          ),
          message:
            `Google Places query ${queryIndex + 1}/${queries.length}, page ${page}.`,
          meta: {
            runId,
            query,
            queryIndex,
            page,
          },
          createdAt:
            new Date().toISOString(),
        });

        logger.info("search:page-start", {
          searchCallId,
          runId,
          query,
          queryIndex,
          page,
          maxPages,
          hasPageToken:
            Boolean(pageToken),
          requestNumber:
            requestCount + 1,
          maxRequestsPerSearch,
          uniqueWebsiteSeeds:
            uniqueBefore,
        });

        const result = await requestPage({
          textQuery: query,
          pageToken,
          regionCode: input.regionCode,
          requestContext: {
            runId,
            queryIndex,
            page,
          },
          deadlineAt,
          externalSignal:
            input.signal || null,
        });

        requestCount += 1;

        const fetchedAt =
          new Date().toISOString();

        for (const place of result.places) {
          const candidate =
            mapPlaceToCandidate(place, {
              niche,
              location,
              query,
              fetchedAt,
            });

          if (candidate.website) {
            allCandidates.push(candidate);
          }
        }

        const uniqueCandidates =
          dedupeCandidates(allCandidates);

        const uniqueCount =
          uniqueCandidates.length;

        const freshCandidates =
          uniqueCandidates.filter((candidate) => {
            const key =
              cleanText(candidate.placeId) ||
              safeHostname(candidate.website) ||
              `${cleanText(candidate.name)}|${cleanText(candidate.address)}`;

            if (!key || emittedCandidateKeys.has(key)) {
              return false;
            }

            emittedCandidateKeys.add(key);
            return true;
          });

        if (freshCandidates.length && onCandidateBatch) {
          try {
            await onCandidateBatch({
              candidates: freshCandidates,
              total: uniqueCount,
              query,
              queryIndex,
              page,
              requestId: result.requestId,
              runId,
              createdAt: new Date().toISOString(),
            });
          } catch (error) {
            logger.warn("search:candidate-batch-callback-failed", {
              searchCallId,
              runId,
              query,
              page,
              error: cleanText(error?.message) || String(error),
            });
          }
        }

        logger.info("search:page-complete", {
          searchCallId,
          runId,
          query,
          queryIndex,
          page,
          requestId: result.requestId,
          rawReturned:
            result.places.length,
          uniqueWebsiteSeeds:
            uniqueCount,
          hasNextPage: Boolean(
            result.nextPageToken
          ),
          requestElapsedMs:
            result.elapsedMs,
        });

        onProgress?.({
          type:
            "google-places-page-complete",
          percent: Math.min(
            17,
            5 + queryIndex + page
          ),
          message:
            `Google Places returned ${result.places.length} places; ${uniqueCount} unique website seeds collected.`,
          meta: {
            runId,
            query,
            queryIndex,
            page,
            returned:
              result.places.length,
            uniqueWebsiteSeeds:
              uniqueCount,
            requestId:
              result.requestId,
          },
          createdAt:
            new Date().toISOString(),
        });

        pageToken =
          result.nextPageToken;

        if (!pageToken) {
          break;
        }
      }
    }

    const candidates =
      dedupeCandidates(allCandidates)
        .slice(0, requestedLimit);

    const elapsedMs =
      Date.now() - startedAt;

    logger.info("search:complete", {
      searchCallId,
      runId,
      niche,
      location,
      requestedLimit,
      delivered: candidates.length,
      requestCount,
      queryCount: queries.length,
      elapsedMs,
      stoppedReason:
        stoppedReason || "completed",
      ...(logger.sampleRecords
        ? {
            samples: candidates
              .slice(0, 5)
              .map((candidate) => ({
                placeId:
                  candidate.placeId,
                name:
                  candidate.name,
                websiteHost:
                  safeHostname(
                    candidate.website
                  ),
                hasPhone:
                  Boolean(candidate.phone),
              })),
          }
        : {}),
    });

    return {
      candidates,
      meta: {
        provider: "google-places",
        runId,
        requested: requestedLimit,
        delivered: candidates.length,
        requestCount,
        queryCount: queries.length,
        queries,
        maxPages,
        pageSize,
        maxRequestsPerSearch,
        searchTimeoutMs,
        stoppedReason:
          stoppedReason || "completed",
        elapsedMs,
      },
    };
  }

  async function healthCheck(input = {}) {
    const query = cleanText(
      input.query ||
        "software companies in Abu Dhabi"
    );

    runtime.healthCheckCalls += 1;

    logger.info("health-check:start", {
      callNumber:
        runtime.healthCheckCalls,
      query,
      regionCode:
        cleanRegionCode(input.regionCode),
    });

    if (!enabled()) {
      const result = {
        ok: false,
        configured: false,
        message:
          "GOOGLE_PLACES_API_KEY is missing or contains a placeholder value.",
        diagnostics: getDiagnostics(),
      };

      logger.error(
        "health-check:not-configured",
        result
      );

      return result;
    }

    try {
      const result = await requestPage({
        textQuery: query,
        regionCode: input.regionCode,
        requestContext: {
          healthCheck: true,
          page: 1,
          queryIndex: 0,
        },
        deadlineAt:
          Date.now() + timeoutMs,
      });

      const response = {
        ok: true,
        configured: true,
        query,
        returned: result.places.length,
        requestId: result.requestId,
        elapsedMs: result.elapsedMs,
        diagnostics: getDiagnostics(),
      };

      logger.info(
        "health-check:complete",
        response
      );

      return response;
    } catch (error) {
      logger.error(
        "health-check:failed",
        {
          query,
          errorCode:
            error?.code || "",
          errorMessage:
            error?.message ||
            String(error),
          diagnostics:
            getDiagnostics(),
        }
      );

      throw error;
    }
  }

  logger.info("provider:configured", {
    ...getDiagnostics(),
    message:
      "Provider loaded. The next expected event is search:entered or health-check:start.",
  });

  if (!enabled()) {
    logger.error(
      "provider:missing-api-key",
      {
        apiKeySource,
        environmentKeyPresent:
          Boolean(environmentApiKey),
        optionKeyPresent:
          Boolean(optionApiKey),
        message:
          "Add a real GOOGLE_PLACES_API_KEY to the API process environment and restart the backend.",
      }
    );
  }

  const idleWarningEnabled = boolFromEnv(
    "GOOGLE_PLACES_IDLE_WARNING",
    true
  );

  const idleWarningMs = numberFromEnv(
    "GOOGLE_PLACES_IDLE_WARNING_MS",
    5_000,
    1_000,
    120_000
  );

  if (idleWarningEnabled) {
    const idleTimer = setTimeout(() => {
      if (
        runtime.searchCalls === 0 &&
        runtime.healthCheckCalls === 0
      ) {
        logger.warn("provider:idle", {
          waitedMs: idleWarningMs,
          runtime: getRuntimeStats(),
          message:
            "google-places.js loaded, but searchCandidates() and healthCheck() were never called. Check the Express route and leadFinder wiring.",
        });
      }
    }, idleWarningMs);

    idleTimer.unref?.();
  }

  return {
    enabled,
    getDiagnostics,
    getRuntimeStats,
    healthCheck,
    searchCandidates,
  };
}
