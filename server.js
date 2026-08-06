import "./env.js";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCampaignManager, getTerritoryCoordinates } from "./campaigns.js";
import { createEmailService } from "./email.js";
import { createStore } from "./store.js";
import { createWhatsAppService } from "./whatsapp.js";
import { createReachFlyAI } from "./reachfly-ai.js";
import { createLeadFinder } from "./leadFinder.js";
import { createGooglePlacesProvider } from "./google-places.js";
import { createWorkspaceService } from "./workspace-service.js";
import { createAuditService } from "./audit-service.js";
import { createAuditJobService } from "./audit-job-service.js";
import { createLeadAuditService } from "./lead-audit-service.js";
import { createSalesOperationsService } from "./sales-operations-service.js";
import { createAttendanceService } from "./attendance-service.js";
import {
  createDailyLeadAutomationService,
} from "./daily-lead-automation-service.js";
import {
  createCallerQueueService,
} from "./caller-queue-service.js";
import { createTeamControlService } from "../src/team-control-service.js";
import { createResourceBoardService } from "./resource-board-service.js";
import { seedRoleTestAccounts } from "./role-test-seed.js";
import { createTelnyxCallService } from "./telnyx-call-service.js";
import { createTelnyxAIAgentService } from "./telnyx-ai-agent-service.js";
import multer from "multer";
import { Server as SocketIOServer } from "socket.io";
import fs from "node:fs";

import {
  createTeamCommunicationService,
} from "./team-communication-service.js";
import dns from "node:dns/promises";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);

const API_HOST =
  process.env.API_HOST ||
  "0.0.0.0";

const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, "../../../data");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const AUTH_SECRET =
  process.env.AUTH_SECRET || "reachfly-local-dev-secret";

const APP_URL =
  process.env.APP_URL || "http://localhost:5173";

function envFlag(name, fallback = false) {
  const value = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value);
}
function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/$/, "");
}

const LOCAL_DEVELOPMENT_ORIGINS = [
  APP_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].map(normalizeOrigin);

const CONFIGURED_ORIGINS = String(
  process.env.ALLOWED_ORIGINS || ""
)
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([
  ...LOCAL_DEVELOPMENT_ORIGINS,
  ...CONFIGURED_ORIGINS,
]);

const CORS_ALLOW_ALL = envFlag(
  "CORS_ALLOW_ALL",
  !IS_PRODUCTION
);

function isPrivateDevelopmentHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);

  if (CORS_ALLOW_ALL) {
    return true;
  }

  if (ALLOWED_ORIGINS.has(normalizedOrigin)) {
    return true;
  }

  if (!IS_PRODUCTION) {
    try {
      const url = new URL(normalizedOrigin);

      return (
        ["http:", "https:"].includes(url.protocol) &&
        isPrivateDevelopmentHost(url.hostname)
      );
    } catch {
      return false;
    }
  }

  return false;
}

const corsOptions = {
  credentials: true,

  origin(origin, callback) {
    callback(null, isAllowedCorsOrigin(origin));
  },

  methods: [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Accept",
    "Authorization",
    "Content-Type",
    "Origin",
    "X-Requested-With",
    "X-Request-Id",
  ],

  exposedHeaders: ["X-Request-Id"],

  optionsSuccessStatus: 204,

  preflightContinue: false,
};

const HTTP_DEBUG = envFlag(
  "HTTP_DEBUG",
  !IS_PRODUCTION
);

const API_REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(
    process.env.API_REQUEST_TIMEOUT_MS || 90_000
  )
);

const PENDING_REQUEST_LOG_INTERVAL_MS = Math.max(
  5_000,
  Number(
    process.env.PENDING_REQUEST_LOG_INTERVAL_MS || 15_000
  )
);

if (
  IS_PRODUCTION &&
  AUTH_SECRET === "reachfly-local-dev-secret"
) {
  throw new Error(
    "AUTH_SECRET must be configured in production."
  );
}


process.on("unhandledRejection", (reason) => {
  console.error(
    `[process] unhandled-rejection ${JSON.stringify({
      at: new Date().toISOString(),
      reason:
        reason instanceof Error
          ? {
              name: reason.name,
              message: reason.message,
              stack: reason.stack || "",
            }
          : String(reason),
    })}`
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    `[process] uncaught-exception ${JSON.stringify({
      at: new Date().toISOString(),
      name: error?.name || "",
      message: error?.message || String(error),
      stack: error?.stack || "",
    })}`
  );
});

const app = express();

// API responses must not produce 304 responses with an empty body.
app.disable("etag");

const store = createStore({
  dataDir: DATA_DIR,
});

const sseClients = new Map();
const pendingRequests = new Map();
const workspaceContextCache = new WeakMap();
const requestStateCache = new WeakMap();

const OCR_MAX_IMAGE_BYTES = Number(
  process.env.OCR_MAX_IMAGE_BYTES ||
    8 * 1024 * 1024
);

const OCR_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.OCR_DOWNLOAD_TIMEOUT_MS ||
    15_000
);

const OCR_ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/bmp",
]);

function isPrivateIpAddress(address) {
  const ipVersion = net.isIP(address);

  if (ipVersion === 4) {
    const parts = address
      .split(".")
      .map(Number);

    const [a, b] = parts;

    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (ipVersion === 6) {
    const normalized = address.toLowerCase();

    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  return false;
}

async function validateOcrImageUrl(value) {
  let url;

  try {
    url = new URL(String(value || ""));
  } catch {
    const error = new Error(
      "A valid imageUrl is required."
    );

    error.statusCode = 400;

    throw error;
  }

  if (
    !["http:", "https:"].includes(url.protocol)
  ) {
    const error = new Error(
      "Only HTTP and HTTPS image URLs are supported."
    );

    error.statusCode = 400;

    throw error;
  }

  if (url.username || url.password) {
    const error = new Error(
      "Image URLs containing credentials are not allowed."
    );

    error.statusCode = 400;

    throw error;
  }

  const verificationPattern =
    /(captcha|human[-_ ]?verification|challenge|recaptcha|hcaptcha)/i;

  // if (
  //   verificationPattern.test(url.pathname) ||
  //   verificationPattern.test(url.search)
  // ) {
  //   const error = new Error(
  //     "CAPTCHA and human-verification images cannot be processed."
  //   );
  //   error.statusCode = 400;
  //   throw error;
  // }

  let addresses;

  try {
    addresses = await dns.lookup(
      url.hostname,
      {
        all: true,
        verbatim: true,
      }
    );
  } catch {
    const error = new Error(
      "The image hostname could not be resolved."
    );

    error.statusCode = 400;

    throw error;
  }

  if (!addresses.length) {
    const error = new Error(
      "The image hostname could not be resolved."
    );

    error.statusCode = 400;

    throw error;
  }

  if (
    addresses.some(({ address }) =>
      isPrivateIpAddress(address)
    )
  ) {
    const error = new Error(
      "Private, local, and internal image addresses are not allowed."
    );

    error.statusCode = 400;

    throw error;
  }

  return url;
}

async function downloadOcrImage(imageUrl) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    OCR_DOWNLOAD_TIMEOUT_MS
  );

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: Array.from(
          OCR_ALLOWED_CONTENT_TYPES
        ).join(","),

        "User-Agent":
          "ReachFly-OCR/1.0",
      },
    });

    if (!response.ok) {
      const error = new Error(
        `Image server returned HTTP ${response.status}.`
      );

      error.statusCode = 502;

      throw error;
    }

    const contentType = String(
      response.headers.get("content-type") ||
        ""
    )
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (
      !OCR_ALLOWED_CONTENT_TYPES.has(
        contentType
      )
    ) {
      const error = new Error(
        `Unsupported image content type: ${
          contentType || "unknown"
        }.`
      );

      error.statusCode = 415;

      throw error;
    }

    const declaredLength = Number(
      response.headers.get(
        "content-length"
      ) || 0
    );

    if (
      declaredLength >
      OCR_MAX_IMAGE_BYTES
    ) {
      const error = new Error(
        `Image exceeds the ${OCR_MAX_IMAGE_BYTES}-byte limit.`
      );

      error.statusCode = 413;

      throw error;
    }

    if (!response.body) {
      const error = new Error(
        "The image response was empty."
      );

      error.statusCode = 502;

      throw error;
    }

    const chunks = [];

    let totalBytes = 0;

    for await (const chunk of response.body) {
      totalBytes += chunk.length;

      if (
        totalBytes >
        OCR_MAX_IMAGE_BYTES
      ) {
        await response.body.cancel();

        const error = new Error(
          `Image exceeds the ${OCR_MAX_IMAGE_BYTES}-byte limit.`
        );

        error.statusCode = 413;

        throw error;
      }

      chunks.push(Buffer.from(chunk));
    }

    if (!totalBytes) {
      const error = new Error(
        "The downloaded image was empty."
      );

      error.statusCode = 422;

      throw error;
    }

    return Buffer.concat(chunks);
  } catch (error) {
    if (
      error.name === "AbortError"
    ) {
      const timeoutError = new Error(
        "Image download timed out."
      );

      timeoutError.statusCode = 504;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const PADDLE_OCR_URL =
  process.env.PADDLE_OCR_URL ||
  "http://127.0.0.1:8001";

async function extractTextFromImageUrl(
  imageUrlValue
) {
  if (!imageUrlValue) {
    const error = new Error(
      "Image URL is required."
    );

    error.statusCode = 400;

    throw error;
  }

  const imageUrl =
    await validateOcrImageUrl(
      imageUrlValue
    );

  const imageBuffer =
    await downloadOcrImage(
      imageUrl.toString()
    );

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    60_000
  );

  try {
    const response = await fetch(
      `${PADDLE_OCR_URL}/ocr`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          image:
            imageBuffer.toString(
              "base64"
            ),
          minimum_confidence: 0.35,
        }),
      }
    );

    const result = await response
      .json()
      .catch(() => null);

    if (!response.ok) {
      const error = new Error(
        result?.detail ||
          result?.error ||
          "PaddleOCR service could not process the image."
      );

      error.statusCode =
        response.status >= 400 &&
        response.status < 500
          ? response.status
          : 502;

      throw error;
    }

    return {
      text: String(
        result?.text || ""
      ).trim(),

      confidence: Number(
        result?.confidence || 0
      ),

      lines: Array.isArray(
        result?.lines
      )
        ? result.lines
        : [],
    };
  } catch (error) {
    if (
      error.name === "AbortError"
    ) {
      const timeoutError = new Error(
        "PaddleOCR request timed out."
      );

      timeoutError.statusCode = 504;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createRateLimit({
  windowMs,
  max,
}) {
  const hits = new Map();

  let lastCleanup = Date.now();

  return (req, res, next) => {
    const now = Date.now();

    const tokenIdentity =
      String(
        req.user?.id ||
        req.headers[
          "x-user-id"
        ] ||
        ""
      );

    const requestPath =
      String(
        req.route?.path ||
        req.path ||
        req.originalUrl ||
        req.baseUrl ||
        "unknown"
      )
        .split("?")[0]
        .replace(
          /\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,
          "/:id"
        );

    const key = [
      req.ip ||
        req.socket
          ?.remoteAddress ||
        "unknown",
      tokenIdentity ||
        "anonymous",
      req.method ||
        "GET",
      requestPath,
    ].join(":");

    const current = hits.get(key);

    if (
      !current ||
      current.resetAt <= now
    ) {
      hits.set(key, {
        count: 1,
        resetAt:
          now + windowMs,
      });
    } else {
      current.count += 1;

      if (current.count > max) {
        res.setHeader(
          "Retry-After",
          Math.ceil(
            (current.resetAt - now) /
              1000
          )
        );

        return res.status(429).json({
          error:
            "Too many requests. Please try again later.",
        });
      }
    }

    if (
      now - lastCleanup >
      windowMs
    ) {
      for (const [
        storedKey,
        value,
      ] of hits.entries()) {
        if (
          value.resetAt <= now
        ) {
          hits.delete(storedKey);
        }
      }

      lastCleanup = now;
    }

    next();
  };
}

function requireLegacyWhatsAppEnabled(
  _req,
  res,
  next
) {
  if (
    String(
      process.env
        .ENABLE_LEGACY_GLOBAL_WHATSAPP ||
        "false"
    ) !== "true"
  ) {
    return res.status(503).json({
      error:
        "WhatsApp is disabled in multi-tenant mode until the session service is workspace-scoped. Set ENABLE_LEGACY_GLOBAL_WHATSAPP=true only for a reviewed single-tenant deployment.",
    });
  }

  next();
}

function broadcast(
  campaignId,
  event
) {
  const clients =
    sseClients.get(campaignId) ||
    new Set();

  const payload =
    `data: ${JSON.stringify(
      event
    )}\n\n`;

  for (const res of clients) {
    res.write(payload);
  }
}

const placesProvider =
  createGooglePlacesProvider();

const leadFinder =
  createLeadFinder({
    placesProvider,
  });

const email =
  createEmailService({
    store,
  });

const whatsapp =
  createWhatsAppService({
    store,
  });

const campaigns =
  createCampaignManager({
    store,
    broadcast,
    leadFinder,
    email,
  });

const workspaceService =
  createWorkspaceService({
    store,
    email,
    appUrl: APP_URL,
  });

const auditService =
  createAuditService({
    store,
  });

const auditJobService =
  createAuditJobService({
    store,
    auditService,
    workspaceService,
  });

const salesOperationsService =
  createSalesOperationsService({
    store,
    workspaceService,
  });

const attendanceService =
  createAttendanceService({
    store,
    workspaceService,
    dataDir:
      DATA_DIR,
  });

const teamControlService =
  createTeamControlService({
    store,
    workspaceService,
  });
const teamCommunicationService =
  createTeamCommunicationService({
    store,
    workspaceService,
  });
const seededTestAccounts = seedRoleTestAccounts({ store });

const telnyxCallService =
  createTelnyxCallService({
    store,
    workspaceService,
    dataDir: DATA_DIR,
    emit({ workspaceId, event, payload }) {
      emitToWorkspace(workspaceId, event, payload);
    },
  });

const telnyxAiAgentService =
  createTelnyxAIAgentService({
    store,
    workspaceService,
    emit({ workspaceId, event, payload }) {
      emitToWorkspace(workspaceId, event, payload);
    },
  });

const leadAuditService =
  createLeadAuditService({
    store,
    workspaceService,
    reportTemplateProvider: (user) =>
      salesOperationsService.getReportTemplate(user),
  });

const callerQueueService =
  createCallerQueueService({
    store,
    workspaceService,
  });

const resourceBoardService =
  createResourceBoardService({
    store,
    workspaceService,
    teamCommunicationService,
    teamControlService,
    telnyxCallService,
    email,
    hashPassword,
  });

const dailyLeadAutomationService =
  createDailyLeadAutomationService({
    store,
    workspaceService,
    leadFinder,
    leadAuditService,

    emit({
      workspaceId,
      event,
      payload,
    }) {
      emitToWorkspace(
        workspaceId,
        event,
        payload
      );
    },
  });

const ai = createReachFlyAI({
  store,
  campaigns,
  workspaceService,
});
const TEAM_UPLOAD_DIR = path.resolve(
  DATA_DIR,
  "team-attachments"
);

fs.mkdirSync(TEAM_UPLOAD_DIR, {
  recursive: true,
});

const TEAM_ATTACHMENT_MAX_BYTES = Math.max(
  1024,
  Number(
    process.env.TEAM_ATTACHMENT_MAX_BYTES ||
      15 * 1024 * 1024
  )
);

const teamAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      callback(null, TEAM_UPLOAD_DIR);
    },

    filename(_req, file, callback) {
      const extension = path.extname(
        file.originalname || ""
      );

      callback(
        null,
        `${crypto.randomUUID()}${extension}`
      );
    },
  }),

  limits: {
    fileSize:
      TEAM_ATTACHMENT_MAX_BYTES,
    files: 1,
  },

  fileFilter(_req, file, callback) {
    const allowedTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "application/pdf",
      "text/plain",
      "text/csv",
      "application/zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "audio/webm",
      "audio/ogg",
      "audio/mpeg",
      "audio/mp4",
      "audio/x-m4a",
      "audio/wav",
      "audio/x-wav",
    ]);

    if (
      !allowedTypes.has(
        String(
          file.mimetype || ""
        ).toLowerCase()
      )
    ) {
      const error = new Error(
        "This attachment type is not supported."
      );

      error.statusCode = 415;

      callback(error);
      return;
    }

    callback(null, true);
  },
});


/* ==========================================================
   Profile avatar storage
   ========================================================== */

const PROFILE_AVATAR_DIR = path.resolve(
  DATA_DIR,
  "profile-avatars"
);

fs.mkdirSync(PROFILE_AVATAR_DIR, {
  recursive: true,
});

const PROFILE_AVATAR_MAX_BYTES = Math.max(
  256 * 1024,
  Number(
    process.env.PROFILE_AVATAR_MAX_BYTES ||
      5 * 1024 * 1024
  )
);

const PROFILE_AVATAR_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const profileAvatarUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      callback(null, PROFILE_AVATAR_DIR);
    },

    filename(_req, file, callback) {
      const mimeType = String(
        file.mimetype || ""
      ).toLowerCase();

      const extensionByMime = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
      };

      const extension =
        extensionByMime[mimeType] ||
        path.extname(
          file.originalname || ""
        ) ||
        ".jpg";

      callback(
        null,
        `${crypto.randomUUID()}${extension}`
      );
    },
  }),

  limits: {
    fileSize: PROFILE_AVATAR_MAX_BYTES,
    files: 1,
  },

  fileFilter(_req, file, callback) {
    const mimeType = String(
      file.mimetype || ""
    ).toLowerCase();

    if (!PROFILE_AVATAR_TYPES.has(mimeType)) {
      const error = new Error(
        "Only JPG, PNG, WebP, and GIF profile images are supported."
      );

      error.statusCode = 415;
      callback(error);
      return;
    }

    callback(null, true);
  },
});
app.set(
  "trust proxy",
  Number(process.env.TRUST_PROXY || 1)
);

function requestDiagnosticsMiddleware(req, res, next) {
  const requestId = String(
    req.headers["x-request-id"] ||
      crypto.randomUUID()
  );

  const startedAt = Date.now();
  const method = req.method;
  const requestPath =
    req.originalUrl || req.url || "";
  const origin = String(
    req.headers.origin || ""
  );

  req.requestId = requestId;

  res.setHeader(
    "X-Request-Id",
    requestId
  );

  const requestRecord = {
    requestId,
    method,
    path: requestPath,
    origin,
    ip:
      req.ip ||
      req.socket?.remoteAddress ||
      "",
    startedAt,
  };

  pendingRequests.set(
    requestId,
    requestRecord
  );

  console.log(
    `[http] request:start ${JSON.stringify({
      at: new Date().toISOString(),
      ...requestRecord,
      pendingCount:
        pendingRequests.size,
    })}`
  );

  const requestAccept = String(
    req.headers.accept || ""
  ).toLowerCase();

  const isEventStream =
    requestPath.endsWith("/events") ||
    requestPath.endsWith("/stream") ||
    requestAccept.includes(
      "text/event-stream"
    ) ||
    requestAccept.includes(
      "application/x-ndjson"
    );

  let watchdog = null;

  if (!isEventStream) {
    watchdog = setTimeout(() => {
      const elapsedMs =
        Date.now() - startedAt;

      console.error(
        `[http] request:stuck ${JSON.stringify({
          at: new Date().toISOString(),
          requestId,
          method,
          path: requestPath,
          origin,
          elapsedMs,
          timeoutMs:
            API_REQUEST_TIMEOUT_MS,
          headersSent:
            res.headersSent,
          writableEnded:
            res.writableEnded,
          pendingCount:
            pendingRequests.size,
        })}`
      );

      if (
        !res.headersSent &&
        !res.writableEnded
      ) {
        res.status(504).json({
          error:
            "The API request timed out.",
          requestId,
          path: requestPath,
          timeoutMs:
            API_REQUEST_TIMEOUT_MS,
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }, API_REQUEST_TIMEOUT_MS);

    watchdog.unref?.();
  }

  let completed = false;

  function completeRequest(eventName) {
    if (completed) {
      return;
    }

    completed = true;

    if (watchdog) {
      clearTimeout(watchdog);
    }

    pendingRequests.delete(requestId);

    const elapsedMs =
      Date.now() - startedAt;

    const payload = {
      at: new Date().toISOString(),
      event: eventName,
      requestId,
      method,
      path: requestPath,
      origin,
      statusCode:
        res.statusCode,
      elapsedMs,
      headersSent:
        res.headersSent,
      writableEnded:
        res.writableEnded,
      pendingCount:
        pendingRequests.size,
    };

    if (
      eventName === "finish" &&
      res.statusCode < 500
    ) {
      console.log(
        `[http] request:complete ${JSON.stringify(payload)}`
      );
    } else {
      console.warn(
        `[http] request:${eventName} ${JSON.stringify(payload)}`
      );
    }
  }

  res.once("finish", () => {
    completeRequest("finish");
  });

  res.once("close", () => {
    completeRequest("close");
  });

  req.once("aborted", () => {
    completeRequest("aborted");
  });

  next();
}

app.use(requestDiagnosticsMiddleware);

app.use(
  "/api/profile/avatars",
  express.static(PROFILE_AVATAR_DIR, {
    fallthrough: false,
    index: false,
    maxAge: "1h",
    immutable: false,
  })
);

app.use(
  "/api/team-communication/attachments/files",
  requireAuth,
  express.static(TEAM_UPLOAD_DIR, {
    fallthrough: false,
    index: false,
    maxAge: 0,
  })
);
app.use((req, res, next) => {
  const origin = String(
    req.headers.origin || ""
  );

  const allowed =
    isAllowedCorsOrigin(origin);

  if (origin && allowed) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Vary",
      "Origin"
    );

    res.setHeader(
      "Access-Control-Allow-Credentials",
      "true"
    );
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    String(
      req.headers[
        "access-control-request-headers"
      ] ||
        "Accept, Authorization, Content-Type, Origin, X-Requested-With, X-Request-Id"
    )
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Request-Id"
  );

  if (req.method === "OPTIONS") {
    console.log(
      `[cors] preflight ${JSON.stringify({
        at: new Date().toISOString(),
        requestId:
          req.requestId || "",
        path:
          req.originalUrl || req.url,
        origin,
        allowed,
        requestedMethod:
          req.headers[
            "access-control-request-method"
          ] || "",
        requestedHeaders:
          req.headers[
            "access-control-request-headers"
          ] || "",
      })}`
    );

    if (!allowed) {
      return res.status(403).json({
        error:
          "Origin is not allowed by CORS.",
        origin,
        allowedOrigins:
          IS_PRODUCTION
            ? [...ALLOWED_ORIGINS]
            : undefined,
        requestId:
          req.requestId || "",
      });
    }

    return res.status(204).end();
  }

  if (origin && !allowed) {
    console.warn(
      `[cors] blocked ${JSON.stringify({
        at: new Date().toISOString(),
        requestId:
          req.requestId || "",
        method: req.method,
        path:
          req.originalUrl || req.url,
        origin,
      })}`
    );

    return res.status(403).json({
      error:
        "Origin is not allowed by CORS.",
      origin,
      requestId:
        req.requestId || "",
    });
  }

  next();
});

app.use(cors(corsOptions));

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

const BODY_LIMIT =
  process.env.BODY_LIMIT || "5mb";

const API_RATE_LIMIT_WINDOW_MS =
  Math.max(
    10_000,
    Number(
      process.env
        .API_RATE_LIMIT_WINDOW_MS ||
      (
        IS_PRODUCTION
          ? 15 * 60_000
          : 60_000
      )
    )
  );

const API_RATE_LIMIT_MAX =
  Math.max(
    100,
    Number(
      process.env
        .API_RATE_LIMIT_MAX ||
      (
        IS_PRODUCTION
          ? 1200
          : 5000
      )
    )
  );

const AUTH_RATE_LIMIT_WINDOW_MS =
  Math.max(
    10_000,
    Number(
      process.env
        .AUTH_RATE_LIMIT_WINDOW_MS ||
      (
        IS_PRODUCTION
          ? 15 * 60_000
          : 60_000
      )
    )
  );

const AUTH_RATE_LIMIT_MAX =
  Math.max(
    20,
    Number(
      process.env
        .AUTH_RATE_LIMIT_MAX ||
      (
        IS_PRODUCTION
          ? 80
          : 500
      )
    )
  );

app.use(
  "/api",
  createRateLimit({
    windowMs:
      API_RATE_LIMIT_WINDOW_MS,

    max:
      API_RATE_LIMIT_MAX,
  })
);

app.use(
  "/api/auth",
  createRateLimit({
    windowMs:
      AUTH_RATE_LIMIT_WINDOW_MS,

    max:
      AUTH_RATE_LIMIT_MAX,
  })
);

app.use(
  "/api/audits",
  createRateLimit({
    windowMs:
      Number(
        process.env
          .AUDIT_RATE_LIMIT_WINDOW_MS ||
        60 * 60_000
      ),

    max:
      Number(
        process.env
          .AUDIT_RATE_LIMIT_MAX ||
        (
          IS_PRODUCTION
            ? 100
            : 1000
        )
      ),
  })
);

app.use(
  "/api/ai",
  createRateLimit({
    windowMs:
      Number(
        process.env
          .AI_RATE_LIMIT_WINDOW_MS ||
        15 * 60_000
      ),

    max:
      Number(
        process.env
          .AI_RATE_LIMIT_MAX ||
        (
          IS_PRODUCTION
            ? 240
            : 1000
        )
      ),
  })
);

app.use(
  express.json({
    limit: BODY_LIMIT,
    verify(req, _res, buffer) {
      // Telnyx webhook signatures must be verified against the exact raw body.
      if (req.originalUrl?.startsWith("/api/telnyx/")) {
        req.rawBody = buffer.toString("utf8");
      }
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: BODY_LIMIT,
  })
);

/* ==========================================================
   Team communication routes
   ========================================================== */

app.get(
  "/api/team-communication/channels",
  requireAuth,
  asyncRoute(async (req, res) => {
    const channels =
      teamCommunicationService.listChannels(
        req.user
      );

    res.json({
      channels,
    });
  })
);

app.post(
  "/api/team-communication/channels",
  requireAuth,
  asyncRoute(async (req, res) => {
    const channel =
      teamCommunicationService.createChannel(
        req.user,
        req.body
      );

    emitChannelEvent(
      channel,
      "chat:channel-created"
    );

    res.status(201).json({
      channel,
      ...channel,
    });
  })
);

app.patch(
  "/api/team-communication/channels/:channelId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const channel =
      teamCommunicationService.updateChannel(
        req.user,
        req.params.channelId,
        req.body
      );

    emitChannelEvent(
      channel,
      "chat:channel-updated"
    );

    res.json({
      channel,
      ...channel,
    });
  })
);

app.delete(
  "/api/team-communication/channels/:channelId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const channel =
      teamCommunicationService.archiveChannel(
        req.user,
        req.params.channelId
      );

    emitChannelEvent(
      channel,
      "chat:channel-updated"
    );

    res.json({
      channel,
    });
  })
);

app.get(
  "/api/team-communication/channels/:channelId/messages",
  requireAuth,
  asyncRoute(async (req, res) => {
    const messages =
      teamCommunicationService.listMessages(
        req.user,
        req.params.channelId,
        req.query
      );

    res.json({
      messages,
    });
  })
);

app.post(
  "/api/team-communication/channels/:channelId/messages",
  requireAuth,
  asyncRoute(async (req, res) => {
    const message =
      teamCommunicationService.sendMessage(
        req.user,
        req.params.channelId,
        req.body
      );

    emitToChannel(
      req.params.channelId,
      "chat:message-created",
      {
        message,
      }
    );

    res.status(201).json({
      message,
      ...message,
    });
  })
);

app.delete(
  "/api/team-communication/channels/:channelId/messages/:messageId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const message =
      teamCommunicationService.deleteMessage(
        req.user,
        req.params.channelId,
        req.params.messageId
      );

    emitToChannel(
      req.params.channelId,
      "chat:message-deleted",
      {
        message,
      }
    );

    res.json({
      message,
    });
  })
);

app.post(
  "/api/team-communication/channels/:channelId/read",
  requireAuth,
  asyncRoute(async (req, res) => {
    const read =
      teamCommunicationService.markRead(
        req.user,
        req.params.channelId
      );

    emitToChannel(
      req.params.channelId,
      "chat:read-updated",
      {
        channelId:
          req.params.channelId,
        userId: req.user.id,
        readAt: read.readAt,
      }
    );

    res.json({
      read,
    });
  })
);

app.post(
  "/api/team-communication/channels/:channelId/attachments",
  requireAuth,
  teamAttachmentUpload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error:
          "An attachment file is required.",
      });
    }

    const encodedFilename =
      encodeURIComponent(
        req.file.filename
      );

    const attachmentUrl =
      `/api/team-communication/attachments/files/${encodedFilename}`;

    const attachment =
      teamCommunicationService.registerAttachment(
        req.user,
        req.params.channelId,
        {
          name:
            req.file.originalname ||
            req.file.filename,

          filename:
            req.file.filename,

          path:
            req.file.path,

          url:
            attachmentUrl,

          mimeType:
            req.file.mimetype,

          size:
            req.file.size,
        }
      );

    res.status(201).json({
      attachment,
      file: attachment,
    });
  })
);

app.get(
  "/api/team-communication/presence",
  requireAuth,
  asyncRoute(async (req, res) => {
    const members =
      teamCommunicationService.listPresence(
        req.user
      );

    res.json({
      members,
    });
  })
);

app.post(
  "/api/team-communication/presence",
  requireAuth,
  asyncRoute(async (req, res) => {
    const presence =
      teamCommunicationService.updatePresence(
        req.user,
        req.body.status
      );

    emitToWorkspace(
      presence.workspaceId,
      "presence:updated",
      presence
    );

    res.json({
      presence,
      ...presence,
    });
  })
);

app.get(
  "/api/team-communication/tasks",
  requireAuth,
  asyncRoute(async (req, res) => {
    const tasks =
      teamCommunicationService.listTasks(
        req.user,
        req.query
      );

    res.json({
      tasks,
    });
  })
);

app.post(
  "/api/team-communication/tasks",
  requireAuth,
  asyncRoute(async (req, res) => {
    const task =
      teamCommunicationService.createTask(
        req.user,
        req.body
      );

    emitToWorkspace(
      task.workspaceId,
      "team:task-created",
      {
        task,
      }
    );

    res.status(201).json({
      task,
      ...task,
    });
  })
);

app.patch(
  "/api/team-communication/tasks/:taskId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const task =
      teamCommunicationService.updateTask(
        req.user,
        req.params.taskId,
        req.body
      );

    emitToWorkspace(
      task.workspaceId,
      "team:task-updated",
      {
        task,
      }
    );

    res.json({
      task,
      ...task,
    });
  })
);

app.get(
  "/api/team-communication/summary",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(
      teamCommunicationService.summary(
        req.user
      )
    );
  })
);

app.get(
  "/api/team-communication/internal-calls",
  requireAuth,
  asyncRoute(async (req, res) => {
    const calls =
      teamCommunicationService.listInternalCalls(
        req.user,
        req.query
      );

    res.json({
      calls,
    });
  })
);

app.get(
  "/api/team-communication/internal-calls/:callId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const call =
      teamCommunicationService.getInternalCall(
        req.user,
        req.params.callId
      );

    res.json({
      call,
      ...call,
    });
  })
);

app.post(
  "/api/team-communication/internal-calls",
  requireAuth,
  asyncRoute(async (req, res) => {
    const call =
      teamCommunicationService.createInternalCall(
        req.user,
        req.body
      );

    emitToUser(
      call.targetUserId,
      "internal-call:incoming",
      {
        call,
      }
    );

    res.status(201).json({
      call,
      ...call,
    });
  })
);

app.post(
  "/api/team-communication/internal-calls/:callId/accept",
  requireAuth,
  asyncRoute(async (req, res) => {
    const call =
      teamCommunicationService.acceptInternalCall(
        req.user,
        req.params.callId
      );

    emitToUser(
      call.callerUserId,
      "internal-call:accepted",
      {
        call,
      }
    );

    emitToUser(
      call.targetUserId,
      "internal-call:accepted",
      {
        call,
      }
    );

    res.json({
      call,
      ...call,
    });
  })
);

app.post(
  "/api/team-communication/internal-calls/:callId/reject",
  requireAuth,
  asyncRoute(async (req, res) => {
    const call =
      teamCommunicationService.rejectInternalCall(
        req.user,
        req.params.callId
      );

    emitToUser(
      call.callerUserId,
      "internal-call:rejected",
      {
        call,
      }
    );

    res.json({
      call,
      ...call,
    });
  })
);

app.post(
  "/api/team-communication/internal-calls/:callId/end",
  requireAuth,
  asyncRoute(async (req, res) => {
    const call =
      teamCommunicationService.endInternalCall(
        req.user,
        req.params.callId
      );

    emitToUser(
      call.callerUserId,
      "internal-call:ended",
      {
        call,
      }
    );

    emitToUser(
      call.targetUserId,
      "internal-call:ended",
      {
        call,
      }
    );

    res.json({
      call,
      ...call,
    });
  })
);

app.get(
  "/api/debug/ping",
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
    );

    res.json({
      ok: true,
      name: "ReachFly API",
      requestId:
        req.requestId || "",
      now:
        new Date().toISOString(),
      uptimeSeconds:
        Math.round(process.uptime()),
      origin:
        req.headers.origin || "",
      corsAllowed:
        isAllowedCorsOrigin(
          req.headers.origin
        ),
      pendingRequests:
        pendingRequests.size,
      googlePlaces:
        placesProvider.getDiagnostics(),
    });
  }
);

app.get(
  "/api/debug/pending",
  requireAuth,
  (req, res) => {
    const now = Date.now();

    res.json({
      now:
        new Date().toISOString(),
      count:
        pendingRequests.size,
      requests: [
        ...pendingRequests.values(),
      ].map((item) => ({
        ...item,
        elapsedMs:
          now - item.startedAt,
      })),
    });
  }
);

const pendingRequestTimer = setInterval(() => {
  if (!pendingRequests.size) {
    return;
  }

  const now = Date.now();

  const requests = [
    ...pendingRequests.values(),
  ]
    .map((item) => ({
      requestId:
        item.requestId,
      method: item.method,
      path: item.path,
      origin: item.origin,
      elapsedMs:
        now - item.startedAt,
    }))
    .sort(
      (left, right) =>
        right.elapsedMs -
        left.elapsedMs
    )
    .slice(0, 20);

  console.warn(
    `[http] pending-requests ${JSON.stringify({
      at: new Date().toISOString(),
      count:
        pendingRequests.size,
      requests,
    })}`
  );
}, PENDING_REQUEST_LOG_INTERVAL_MS);

pendingRequestTimer.unref?.();

/* ==========================================================
   Auth helpers
   ========================================================== */

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function publicUser(
  user,
  contextOverride = null
) {
  if (!user) {
    return null;
  }

  const state = store.read();

  const workspace =
    contextOverride?.workspace ||
    (state.workspaces || []).find(
      (item) =>
        item.id === user.workspaceId
    ) ||
    null;

  const workspaceRole =
    contextOverride?.role ||
    user.workspaceRole ||
    user.role ||
    "caller";

  const companyName =
    user.companyName ||
    user.workspaceName ||
    workspace?.companyName ||
    workspace?.name ||
    "";

  const accountType =
    user.accountType ||
    user.workspaceType ||
    workspace?.accountType ||
    workspace?.workspaceType ||
    (workspace || companyName
      ? "company"
      : "individual");

  const nameParts = splitPersonName(
    user.name || user.fullName
  );

  return {
    id: user.id,

    name:
      user.name ||
      user.fullName ||
      "",

    fullName:
      user.fullName ||
      user.name ||
      "",

    firstName:
      user.firstName ||
      nameParts.firstName,

    lastName:
      user.lastName ||
      nameParts.lastName,

    email: user.email || "",

    phone:
      user.phone ||
      user.phoneNumber ||
      "",

    phoneNumber:
      user.phoneNumber ||
      user.phone ||
      "",

    jobTitle: user.jobTitle || "",
    department: user.department || "",

    bio:
      user.bio ||
      user.biography ||
      "",

    biography:
      user.biography ||
      user.bio ||
      "",

    avatarUrl:
      user.avatarUrl ||
      user.photoUrl ||
      user.profileImage ||
      "",

    photoUrl:
      user.photoUrl ||
      user.avatarUrl ||
      user.profileImage ||
      "",

    profileImage:
      user.profileImage ||
      user.avatarUrl ||
      user.photoUrl ||
      "",

    accountType,

    workspaceType:
      user.workspaceType ||
      accountType,

    companyAccount:
      accountType === "company",

    companyName,

    workspaceName:
      user.workspaceName ||
      workspace?.name ||
      companyName,

    workspaceId:
      user.workspaceId ||
      workspace?.id ||
      "",

    companyId:
      user.companyId ||
      workspace?.companyId ||
      "",

    role: workspaceRole,
    workspaceRole,

    permissions:
      contextOverride?.permissions ||
      user.permissions ||
      [],

    timezone: user.timezone || "UTC",

    availabilityStatus:
      user.availabilityStatus ||
      "offline",

    availability:
      user.availability ||
      user.availabilityStatus ||
      "offline",

    workingHours:
      user.workingHours || null,

    notificationPreferences:
      user.notificationPreferences || {},

    callPreferences:
      user.callPreferences || {},

    emailVerified:
      user.emailVerified === true,

    memberSince:
      user.joinedAt ||
      user.createdAt ||
      "",

    createdAt: user.createdAt || "",
    updatedAt: user.updatedAt || "",
  };
}

function splitPersonName(value) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function cleanProfileText(
  value,
  maximumLength
) {
  return String(value ?? "")
    .trim()
    .slice(0, maximumLength);
}

function hashPassword(
  password,
  salt = crypto
    .randomBytes(16)
    .toString("hex")
) {
  const hash = crypto
    .scryptSync(
      String(password),
      salt,
      64
    )
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(
  password,
  stored
) {
  if (
    !stored ||
    !stored.includes(":")
  ) {
    return false;
  }

  const [salt, originalHash] =
    stored.split(":");

  const hash = crypto
    .scryptSync(
      String(password),
      salt,
      64
    )
    .toString("hex");

  const current = Buffer.from(
    hash,
    "hex"
  );

  const original = Buffer.from(
    originalHash,
    "hex"
  );

  if (
    current.length !==
    original.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    current,
    original
  );
}

function signToken(payload) {
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      exp:
        Date.now() +
        1000 *
          60 *
          60 *
          24 *
          7,
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac(
      "sha256",
      AUTH_SECRET
    )
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}

function verifyToken(token) {
  try {
    if (
      !token ||
      !token.includes(".")
    ) {
      return null;
    }

    const [body, signature] =
      token.split(".");

    const expectedSignature =
      crypto
        .createHmac(
          "sha256",
          AUTH_SECRET
        )
        .update(body)
        .digest("base64url");

    const received =
      Buffer.from(signature);

    const expected =
      Buffer.from(
        expectedSignature
      );

    if (
      received.length !==
      expected.length
    ) {
      return null;
    }

    if (
      !crypto.timingSafeEqual(
        received,
        expected
      )
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(
        body,
        "base64url"
      ).toString("utf8")
    );

    if (
      !payload.exp ||
      Date.now() > payload.exp
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getAuthToken(req) {
  const header =
    req.headers.authorization ||
    "";

  if (
    header.startsWith(
      "Bearer "
    )
  ) {
    return header.slice(7);
  }

  if (req.query?.token) {
    return String(
      req.query.token
    );
  }

  return "";
}

function getWorkspaceContext(user) {
  if (!user || typeof user !== "object") {
    return {
      user,
      workspace: null,
      workspaceId: "",
      role: "caller",
      permissions: [],
    };
  }

  const cached = workspaceContextCache.get(user);
  if (cached) return cached;

  const state = requestStateCache.get(user) || store.read();
  const context = workspaceService.getContext(user, state);
  workspaceContextCache.set(user, context);
  requestStateCache.set(context.user, state);
  return context;
}

function getRequestState(req) {
  return req.state || requestStateCache.get(req.user) || store.read();
}

function requireAuth(req, res, next) {
  const authStartedAt = Date.now();
  const token = getAuthToken(req);
  const payload = verifyToken(token);

  if (!payload?.userId) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const stateReadStartedAt = Date.now();
    const state = store.read();
    const stateReadMs = Date.now() - stateReadStartedAt;
    const user = (state.users || []).find((item) => item.id === payload.userId);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const contextStartedAt = Date.now();
    const context = workspaceService.getContext(user, state);
    const contextMs = Date.now() - contextStartedAt;

    req.user = context.user || user;
    req.workspaceContext = context;
    req.state = state;

    workspaceContextCache.set(req.user, context);
    requestStateCache.set(req.user, state);

    const elapsedMs = Date.now() - authStartedAt;
    if (elapsedMs >= 250 || HTTP_DEBUG) {
      console.log(
        `[auth] resolved ${JSON.stringify({
          at: new Date().toISOString(),
          requestId: req.requestId || "",
          path: req.originalUrl || req.url,
          userId: req.user.id,
          workspaceId: context.workspaceId || "",
          stateReadMs,
          contextMs,
          elapsedMs,
          campaignCount: Array.isArray(state.campaigns) ? state.campaigns.length : 0,
          userCount: Array.isArray(state.users) ? state.users.length : 0,
        })}`
      );
    }

    next();
  } catch (error) {
    next(error);
  }
}

function hasWorkspacePermission(user, permission, contextOverride = null) {
  const context = contextOverride || getWorkspaceContext(user);
  return (
    context.permissions.includes("*") ||
    context.permissions.includes(permission)
  );
}

function requireWorkspacePermission(
  permission
) {
  return (req, res, next) => {
    if (
      !hasWorkspacePermission(
        req.user,
        permission,
        req.workspaceContext
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to access this workspace feature.",
      });
    }

    next();
  };
}

/**
 * Lead generation and campaign mutation are intentionally manager-only.
 * Owners retain workspace oversight, while callers work only assigned leads.
 */
function requireLeadGenerationManager(
  req,
  res,
  next
) {
  const context =
    req.workspaceContext ||
    getWorkspaceContext(req.user);

  const role = String(
    context?.role ||
      req.user?.workspaceRole ||
      req.user?.role ||
      ""
  )
    .trim()
    .toLowerCase();

  if (role !== "manager") {
    return res.status(403).json({
      error:
        "Only workspace managers can generate leads and manage campaigns.",
      code:
        "MANAGER_LEAD_ACCESS_REQUIRED",
    });
  }

  const permissions =
    Array.isArray(
      context?.permissions
    )
      ? context.permissions
      : [];

  if (
    !permissions.includes(
      "manage_campaigns"
    )
  ) {
    return res.status(403).json({
      error:
        "Your manager account does not have campaign management permission.",
      code:
        "MANAGE_CAMPAIGNS_PERMISSION_REQUIRED",
    });
  }

  next();
}

/**
 * Assigning and reassigning leads is manager-only.
 */
function requireLeadAssignmentManager(
  req,
  res,
  next
) {
  const context =
    req.workspaceContext ||
    getWorkspaceContext(req.user);

  const role = String(
    context?.role ||
      req.user?.workspaceRole ||
      req.user?.role ||
      ""
  )
    .trim()
    .toLowerCase();

  if (role !== "manager") {
    return res.status(403).json({
      error:
        "Only workspace managers can assign leads.",
      code:
        "MANAGER_ASSIGNMENT_ACCESS_REQUIRED",
    });
  }

  const permissions =
    Array.isArray(
      context?.permissions
    )
      ? context.permissions
      : [];

  if (
    !permissions.includes(
      "assign_leads"
    )
  ) {
    return res.status(403).json({
      error:
        "Your manager account does not have lead assignment permission.",
      code:
        "ASSIGN_LEADS_PERMISSION_REQUIRED",
    });
  }

  next();
}

function campaignViewForUser(
  campaign,
  user,
  contextOverride = null
) {
  if (!campaign) return campaign;

  const context = contextOverride || getWorkspaceContext(user);

  if (hasWorkspacePermission(user, "view_all_leads", context)) {
    return campaign;
  }

  const assignedLeads = (campaign.leads || []).filter(
    (lead) => lead.assignedTo === user.id
  );

  return {
    ...campaign,
    leads: assignedLeads,
    leadCount: assignedLeads.length,
    emailAccountId: "",
    senderEmail: "",
    fromEmail: "",
  };
}

function campaignSummaryView(campaign) {
  if (!campaign) return campaign;

  const { leads, ...summary } = campaign;

  return {
    ...summary,
    leadCount: Number(campaign.leadCount ?? leads?.length ?? 0),
  };
}

function contactSummaryView(lead, campaign) {
  const {
    activities,
    timeline,
    rawHtml,
    websiteContent,
    auditEvidence,
    ...contact
  } = lead || {};

  return {
    ...contact,
    campaignId: campaign.id,
    campaignName: campaign.name,
    activityCount: Array.isArray(activities)
      ? activities.length
      : Array.isArray(timeline)
        ? timeline.length
        : 0,
    hasAuditEvidence: Boolean(auditEvidence),
  };
}

function isUserCampaign(
  campaign,
  user,
  contextOverride = null
) {
  if (!campaign || !user) return false;

  const context = contextOverride || getWorkspaceContext(user);

  if (
    campaign.workspaceId &&
    campaign.workspaceId === context.workspaceId
  ) {
    return true;
  }

  const userId = String(user.id || "");
  const userEmail = normalizeEmail(user.email);

  const ownerIds = [
    campaign.userId,
    campaign.ownerId,
    campaign.createdBy,
  ]
    .map((value) => String(value || ""))
    .filter(Boolean);

  if (ownerIds.includes(userId)) return true;

  const campaignEmails = [
    campaign.ownerEmail,
    campaign.senderEmail,
    campaign.fromEmail,
    campaign.createdByEmail,
  ]
    .map(normalizeEmail)
    .filter(Boolean);

  return campaignEmails.includes(userEmail);
}

function isUserInboxItem(
  item,
  user,
  contextOverride = null,
  stateOverride = null
) {
  if (!item || !user) return false;

  const context = contextOverride || getWorkspaceContext(user);
  const state = stateOverride || requestStateCache.get(user) || store.read();
  const canViewWorkspaceInbox =
    context.permissions.includes("*") ||
    context.permissions.includes("manage_campaigns");

  if (item.workspaceId && item.workspaceId === context.workspaceId) {
    if (canViewWorkspaceInbox) return true;
  }

  if (item.campaignId) {
    const campaign = (state.campaigns || []).find(
      (entry) => entry.id === item.campaignId
    );

    if (campaign && isUserCampaign(campaign, user, context)) {
      if (canViewWorkspaceInbox) return true;

      const lead = (campaign.leads || []).find(
        (entry) => entry.id === item.leadId
      );

      if (lead?.assignedTo === user.id) return true;
    }
  }

  if (
    canViewWorkspaceInbox &&
    item.userId === (context.workspace?.ownerId || user.id)
  ) {
    return true;
  }

  const userId = String(user.id || "");
  const userEmail = normalizeEmail(user.email);

  const ownerIds = [item.userId, item.ownerId, item.createdBy]
    .map((value) => String(value || ""))
    .filter(Boolean);

  if (ownerIds.includes(userId)) return true;

  const itemEmails = [
    item.ownerEmail,
    item.accountEmail,
    item.fromEmail,
    item.toEmail,
    item.email,
  ]
    .map(normalizeEmail)
    .filter(Boolean);

  return itemEmails.includes(userEmail);
}

function getAccessibleCampaign(
  req,
  res
) {
  const campaign =
    campaigns.getCampaign(
      req.params.id
    );

  if (!campaign) {
    res.status(404).json({
      error:
        "Campaign not found.",
    });

    return null;
  }

  if (
    !isUserCampaign(
      campaign,
      req.user
    )
  ) {
    res.status(403).json({
      error:
        "You do not have access to this campaign.",
    });

    return null;
  }

  return campaign;
}

function ensureCampaignOwnership(
  campaign,
  user
) {
  if (!campaign || !user) {
    return campaign;
  }

  if (
    campaign.userId &&
    campaign.ownerId &&
    campaign.ownerEmail
  ) {
    return campaign;
  }

  const now =
    new Date().toISOString();

  store.update((state) => {
    const target = (
      state.campaigns || []
    ).find(
      (item) =>
        item.id ===
        campaign.id
    );

    if (!target) {
      return;
    }

    target.userId =
      target.userId ||
      user.id;

    target.ownerId =
      target.ownerId ||
      user.id;

    target.createdBy =
      target.createdBy ||
      user.id;

    target.ownerEmail =
      target.ownerEmail ||
      user.email;

    target.ownerName =
      target.ownerName ||
      user.name;

    target.updatedAt = now;
  });

  return (
    campaigns.getCampaign(
      campaign.id
    ) || campaign
  );
}

/* ==========================================================
   Auth routes
   ========================================================== */

app.post(
  "/api/auth/signup",
  (req, res) => {
    try {
      const name = String(
        req.body.name || ""
      ).trim();

      const emailValue =
        normalizeEmail(
          req.body.email
        );

      const password = String(
        req.body.password || ""
      );

      const accountType =
        req.body.accountType ===
        "company"
          ? "company"
          : "individual";

      const role = String(
        req.body.role || ""
      ).trim();

      const companyName =
        String(
          req.body.companyName ||
            ""
        ).trim();

      if (!name) {
        return res
          .status(400)
          .json({
            error:
              "Name is required.",
          });
      }

      if (
        !emailValue ||
        !emailValue.includes("@")
      ) {
        return res
          .status(400)
          .json({
            error:
              "Valid email is required.",
          });
      }

      if (
        password.length < 8
      ) {
        return res
          .status(400)
          .json({
            error:
              "Password must be at least 8 characters.",
          });
      }

      if (!role) {
        return res
          .status(400)
          .json({
            error:
              "Role is required.",
          });
      }

      if (
        accountType ===
          "company" &&
        !companyName
      ) {
        return res
          .status(400)
          .json({
            error:
              "Company name is required.",
          });
      }

      const state =
        store.read();

      const existing = (
        state.users || []
      ).find(
        (user) =>
          normalizeEmail(
            user.email
          ) === emailValue
      );

      if (existing) {
        return res
          .status(409)
          .json({
            error:
              "An account with this email already exists.",
          });
      }

      const now =
        new Date().toISOString();

      const user = {
        id: crypto.randomUUID(),
        name,
        email: emailValue,
        passwordHash:
          hashPassword(password),
        accountType,
        role,
        companyName:
          accountType ===
          "company"
            ? companyName
            : "",
        createdAt: now,
        updatedAt: now,
      };

      store.update((state) => {
        state.users =
          state.users || [];

        state.users.push(user);

        state.activity =
          state.activity || [];

        state.activity.unshift({
          id:
            crypto.randomUUID(),
          type: "auth",
          title:
            `${name} created a workspace`,
          createdAt: now,
        });
      });

      const workspaceUser =
        workspaceService.ensureWorkspaceForUser(
          user.id
        ) || user;

      const token = signToken({
        userId:
          workspaceUser.id,
      });

      res.status(201).json({
        token,
        user:
          publicUser(
            workspaceUser
          ),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not create account.",
      });
    }
  }
);

app.post(
  "/api/auth/login",
  (req, res) => {
    try {
      const emailValue =
        normalizeEmail(
          req.body.email
        );

      const password = String(
        req.body.password || ""
      );

      const state =
        store.read();

      const user = (
        state.users || []
      ).find(
        (item) =>
          normalizeEmail(
            item.email
          ) === emailValue
      );

      if (
        !user ||
        !verifyPassword(
          password,
          user.passwordHash
        )
      ) {
        return res
          .status(401)
          .json({
            error:
              "Invalid email or password.",
          });
      }

      const workspaceUser =
        workspaceService.ensureWorkspaceForUser(
          user.id
        ) || user;

      const token = signToken({
        userId:
          workspaceUser.id,
      });

      res.json({
        token,
        user:
          publicUser(
            workspaceUser
          ),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not sign in.",
      });
    }
  }
);
app.use(
  "/api/team-communication/attachments/files",
  requireAuth,
  express.static(TEAM_UPLOAD_DIR, {
    fallthrough: false,
    index: false,
    maxAge: 0,
  })
);
app.post(
  "/api/ocr/image-url",
  requireAuth,
  async (req, res) => {
    try {
      const imageUrl = String(
        req.body.imageUrl || ""
      ).trim();

      const result =
        await extractTextFromImageUrl(
          imageUrl
        );

      return res.json({
        success: true,
        imageUrl,
        text: result.text,
        confidence:
          Math.round(
            result.confidence *
              10000
          ) / 10000,
        lines: result.lines,
      });
    } catch (error) {
      console.error(
        "OCR image URL error:",
        error
      );

      return res
        .status(
          error.statusCode ||
            500
        )
        .json({
          success: false,
          error:
            error.statusCode &&
            error.statusCode <
              500
              ? error.message
              : "Could not extract text from the image.",
        });
    }
  }
);

app.get(
  "/api/auth/me",
  requireAuth,
  (req, res) => {
    res.json({
      user: publicUser(
        req.user,
        req.workspaceContext
      ),
      workspace:
        req.workspaceContext?.workspace ||
        null,
    });
  }
);

/* ==========================================================
   Current-user profile routes
   ========================================================== */

app.get(
  "/api/profile/me",
  requireAuth,
  (req, res) => {
    const profile = publicUser(
      req.user,
      req.workspaceContext
    );

    res.json({
      profile,
      user: profile,
    });
  }
);

async function updateCurrentProfile(req, res) {
  const currentUserId = req.user.id;

  const firstName = cleanProfileText(
    req.body.firstName,
    100
  );

  const lastName = cleanProfileText(
    req.body.lastName,
    100
  );

  const providedName = cleanProfileText(
    req.body.name || req.body.fullName,
    200
  );

  const fullName =
    providedName ||
    [firstName, lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

  const now = new Date().toISOString();
  let updatedUser = null;

  store.update((state) => {
    const target = (state.users || []).find(
      (item) => item.id === currentUserId
    );

    if (!target) {
      const error = new Error(
        "Profile not found."
      );
      error.statusCode = 404;
      throw error;
    }

    if (Object.hasOwn(req.body, "firstName")) {
      target.firstName = firstName;
    }

    if (Object.hasOwn(req.body, "lastName")) {
      target.lastName = lastName;
    }

    if (
      fullName &&
      (Object.hasOwn(req.body, "name") ||
        Object.hasOwn(req.body, "fullName") ||
        Object.hasOwn(req.body, "firstName") ||
        Object.hasOwn(req.body, "lastName"))
    ) {
      target.name = fullName;
      target.fullName = fullName;
    }

    if (
      Object.hasOwn(req.body, "phone") ||
      Object.hasOwn(req.body, "phoneNumber")
    ) {
      const phone = cleanProfileText(
        req.body.phone ?? req.body.phoneNumber,
        50
      );
      target.phone = phone;
      target.phoneNumber = phone;
    }

    if (Object.hasOwn(req.body, "jobTitle")) {
      target.jobTitle = cleanProfileText(
        req.body.jobTitle,
        150
      );
    }

    if (Object.hasOwn(req.body, "department")) {
      target.department = cleanProfileText(
        req.body.department,
        150
      );
    }

    if (
      Object.hasOwn(req.body, "bio") ||
      Object.hasOwn(req.body, "biography")
    ) {
      const biography = cleanProfileText(
        req.body.bio ?? req.body.biography,
        600
      );
      target.bio = biography;
      target.biography = biography;
    }

    if (Object.hasOwn(req.body, "timezone")) {
      target.timezone =
        cleanProfileText(
          req.body.timezone,
          100
        ) || "UTC";
    }

    if (
      req.body.workingHours &&
      typeof req.body.workingHours === "object" &&
      !Array.isArray(req.body.workingHours)
    ) {
      target.workingHours = {
        ...(target.workingHours || {}),
        ...req.body.workingHours,
      };
    }

    if (
      req.body.notificationPreferences &&
      typeof req.body.notificationPreferences === "object" &&
      !Array.isArray(
        req.body.notificationPreferences
      )
    ) {
      target.notificationPreferences = {
        ...(target.notificationPreferences || {}),
        ...req.body.notificationPreferences,
      };
    }

    if (
      req.body.callPreferences &&
      typeof req.body.callPreferences === "object" &&
      !Array.isArray(req.body.callPreferences)
    ) {
      target.callPreferences = {
        ...(target.callPreferences || {}),
        ...req.body.callPreferences,
      };
    }

    target.updatedAt = now;
    updatedUser = { ...target };
  });

  const context = workspaceService.getContext(
    updatedUser,
    store.read()
  );

  const profile = publicUser(
    context.user || updatedUser,
    context
  );

  emitToWorkspace(
    context.workspaceId ||
      updatedUser.workspaceId,
    "profile:updated",
    {
      userId:
        updatedUser.id,
      profile,
      user: profile,
    }
  );

  res.json({
    message: "Profile updated successfully.",
    profile,
    user: profile,
  });
}

app.patch(
  "/api/profile/me",
  requireAuth,
  asyncRoute(updateCurrentProfile)
);

app.put(
  "/api/profile/me",
  requireAuth,
  asyncRoute(updateCurrentProfile)
);

function resolveUploadedAvatar(req) {
  return (
    req.files?.avatar?.[0] ||
    req.files?.file?.[0] ||
    req.files?.image?.[0] ||
    null
  );
}

app.post(
  "/api/profile/avatar",
  requireAuth,
  profileAvatarUpload.fields([
    { name: "avatar", maxCount: 1 },
    { name: "file", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  asyncRoute(async (req, res) => {
    const uploadedFile =
      resolveUploadedAvatar(req);

    if (!uploadedFile) {
      return res.status(400).json({
        error: "Select an image to upload.",
      });
    }

    const currentUserId = req.user.id;
    const encodedFilename = encodeURIComponent(
      uploadedFile.filename
    );

    const relativeAvatarUrl =
      `/api/profile/avatars/${encodedFilename}`;

    const publicAvatarUrl =
      `${req.protocol}://${req.get("host")}${relativeAvatarUrl}`;

    const now = new Date().toISOString();
    let previousAvatarPath = "";
    let updatedUser = null;

    store.update((state) => {
      const target = (state.users || []).find(
        (item) => item.id === currentUserId
      );

      if (!target) {
        const error = new Error(
          "Profile not found."
        );
        error.statusCode = 404;
        throw error;
      }

      previousAvatarPath =
        target.avatarFilePath || "";

      target.avatarUrl = publicAvatarUrl;
      target.photoUrl = publicAvatarUrl;
      target.profileImage = publicAvatarUrl;
      target.avatarFilePath =
        uploadedFile.path;
      target.updatedAt = now;

      updatedUser = { ...target };
    });

    if (
      previousAvatarPath &&
      previousAvatarPath !== uploadedFile.path &&
      path.resolve(previousAvatarPath).startsWith(
        PROFILE_AVATAR_DIR
      )
    ) {
      fs.promises
        .unlink(previousAvatarPath)
        .catch(() => {});
    }

    const context = workspaceService.getContext(
      updatedUser,
      store.read()
    );

    const profile = publicUser(
      context.user || updatedUser,
      context
    );

    emitToWorkspace(
      context.workspaceId ||
        updatedUser.workspaceId,
      "profile:avatar-updated",
      {
        userId:
          updatedUser.id,
        avatarUrl:
          updatedUser.avatarUrl ||
          profile.avatarUrl ||
          "",
        profile,
        user: profile,
      }
    );

    emitToWorkspace(
      context.workspaceId ||
        updatedUser.workspaceId,
      "profile:updated",
      {
        userId:
          updatedUser.id,
        profile,
        user: profile,
      }
    );

    res.status(201).json({
      message:
        "Profile picture updated successfully.",
      avatarUrl: publicAvatarUrl,
      profile,
      user: profile,
    });
  })
);

app.delete(
  "/api/profile/avatar",
  requireAuth,
  asyncRoute(async (req, res) => {
    const currentUserId = req.user.id;
    let previousAvatarPath = "";
    let updatedUser = null;

    store.update((state) => {
      const target = (state.users || []).find(
        (item) => item.id === currentUserId
      );

      if (!target) {
        const error = new Error(
          "Profile not found."
        );
        error.statusCode = 404;
        throw error;
      }

      previousAvatarPath =
        target.avatarFilePath || "";

      target.avatarUrl = "";
      target.photoUrl = "";
      target.profileImage = "";
      target.avatarFilePath = "";
      target.updatedAt =
        new Date().toISOString();

      updatedUser = { ...target };
    });

    if (
      previousAvatarPath &&
      path.resolve(previousAvatarPath).startsWith(
        PROFILE_AVATAR_DIR
      )
    ) {
      fs.promises
        .unlink(previousAvatarPath)
        .catch(() => {});
    }

    const context = workspaceService.getContext(
      updatedUser,
      store.read()
    );

    const profile = publicUser(
      context.user || updatedUser,
      context
    );

    emitToWorkspace(
      context.workspaceId ||
        updatedUser.workspaceId,
      "profile:avatar-updated",
      {
        userId:
          updatedUser.id,
        avatarUrl: "",
        profile,
        user: profile,
      }
    );

    emitToWorkspace(
      context.workspaceId ||
        updatedUser.workspaceId,
      "profile:updated",
      {
        userId:
          updatedUser.id,
        profile,
        user: profile,
      }
    );

    res.json({
      message: "Profile picture removed.",
      avatarUrl: "",
      profile,
      user: profile,
    });
  })
);

app.post(
  "/api/auth/forgot-password",
  (req, res) => {
    try {
      const emailValue =
        normalizeEmail(
          req.body.email
        );

      const state =
        store.read();

      const user = (
        state.users || []
      ).find(
        (item) =>
          normalizeEmail(
            item.email
          ) === emailValue
      );

      const message =
        "If an account exists for this email, password reset instructions are ready.";

      if (!user) {
        return res.json({
          message,
        });
      }

      const rawToken =
        crypto
          .randomBytes(32)
          .toString("hex");

      const tokenHash =
        crypto
          .createHash("sha256")
          .update(rawToken)
          .digest("hex");

      const now =
        new Date().toISOString();

      const expiresAt =
        new Date(
          Date.now() +
            1000 * 60 * 30
        ).toISOString();

      store.update((state) => {
        state.passwordResets =
          state.passwordResets ||
          [];

        state.passwordResets.push(
          {
            id:
              crypto.randomUUID(),
            userId: user.id,
            tokenHash,
            expiresAt,
            usedAt: null,
            createdAt: now,
          }
        );
      });

      const resetUrl =
        `${APP_URL}/reset-password?token=${rawToken}`;

      res.json({
        message,
        resetUrl,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not create reset link.",
      });
    }
  }
);

app.post(
  "/api/auth/reset-password",
  (req, res) => {
    try {
      const token = String(
        req.body.token || ""
      );

      const password = String(
        req.body.password || ""
      );

      if (!token) {
        return res
          .status(400)
          .json({
            error:
              "Reset token is required.",
          });
      }

      if (
        password.length < 8
      ) {
        return res
          .status(400)
          .json({
            error:
              "Password must be at least 8 characters.",
          });
      }

      const tokenHash =
        crypto
          .createHash("sha256")
          .update(token)
          .digest("hex");

      const state =
        store.read();

      const reset = (
        state.passwordResets ||
        []
      ).find(
        (item) =>
          item.tokenHash ===
            tokenHash &&
          !item.usedAt
      );

      if (!reset) {
        return res
          .status(400)
          .json({
            error:
              "Invalid or expired reset token.",
          });
      }

      if (
        new Date(
          reset.expiresAt
        ).getTime() <
        Date.now()
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid or expired reset token.",
          });
      }

      const user = (
        state.users || []
      ).find(
        (item) =>
          item.id ===
          reset.userId
      );

      if (!user) {
        return res
          .status(400)
          .json({
            error:
              "Invalid or expired reset token.",
          });
      }

      const now =
        new Date().toISOString();

      store.update((state) => {
        const targetUser = (
          state.users || []
        ).find(
          (item) =>
            item.id === user.id
        );

        if (targetUser) {
          targetUser.passwordHash =
            hashPassword(
              password
            );

          targetUser.updatedAt =
            now;
        }

        const targetReset = (
          state.passwordResets ||
          []
        ).find(
          (item) =>
            item.id ===
            reset.id
        );

        if (targetReset) {
          targetReset.usedAt =
            now;
        }
      });

      res.json({
        message:
          "Password updated successfully.",
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not reset password.",
      });
    }
  }
);

/* ==========================================================
   Core routes
   ========================================================== */

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      name: "ReachFly API",
      version: "5.6.1",
      googlePlaces:
        placesProvider.getDiagnostics(),
    });
  }
);

app.get(
  "/api/health/google-places",
  requireAuth,
  requireWorkspacePermission(
    "manage_campaigns"
  ),
  async (req, res, next) => {
    try {
      const result =
        await placesProvider.healthCheck(
          {
            query:
              req.query.query ||
              "software companies in Abu Dhabi",

            regionCode:
              req.query
                .regionCode || "",
          }
        );

      res
        .status(
          result.ok ? 200 : 503
        )
        .json(result);
    } catch (error) {
      error.details = {
        ...(error.details || {}),
        requestId:
          req.requestId,
      };

      next(error);
    }
  }
);

app.get(
  "/api/dashboard",
  requireAuth,
  (req, res, next) => {
    try {
      const startedAt = Date.now();
      const state = getRequestState(req);
      const context = req.workspaceContext || getWorkspaceContext(req.user);
      const canViewAll = hasWorkspacePermission(
        req.user,
        "view_all_leads",
        context
      );

      const all = (state.campaigns || [])
        .filter((campaign) => isUserCampaign(campaign, req.user, context))
        .map((campaign) => campaignViewForUser(campaign, req.user, context))
        .filter((campaign) => (campaign.leads || []).length || canViewAll);

      const inbox = (state.inbox || []).filter((item) =>
        isUserInboxItem(item, req.user, context, state)
      );

      const ownerId = context.workspace?.ownerId || req.user.id;
      const emailBundle = hasWorkspacePermission(
        req.user,
        "manage_channels",
        context
      )
        ? email.getSettings(ownerId)
        : { activeAccount: {} };
      const emailSettings = emailBundle.activeAccount || {};
      const appSettings =
        state.workspaceSettings?.[context.workspaceId]?.app || {};
      const whatsappSettings =
        state.workspaceWhatsApp?.[context.workspaceId] || {};

      const emailsSent = inbox.filter(
        (message) =>
          message.direction === "outbound" && message.channel === "email"
      ).length;
      const whatsappSent = inbox.filter(
        (message) =>
          message.direction === "outbound" && message.channel === "whatsapp"
      ).length;
      const replies = inbox.filter(
        (message) => message.direction === "inbound"
      ).length;
      const totalOutbound = Math.max(1, emailsSent + whatsappSent);
      const totalLeads = all.reduce(
        (sum, campaign) => sum + Number(campaign.leadCount || campaign.leads?.length || 0),
        0
      );

      console.log(
        `[route] dashboard:complete ${JSON.stringify({
          requestId: req.requestId || "",
          campaignCount: all.length,
          inboxCount: inbox.length,
          elapsedMs: Date.now() - startedAt,
        })}`
      );

      res.json({
        totalLeads,
        emailsSent,
        whatsappSent,
        replies,
        openRate: totalOutbound
          ? Math.min(86, 38 + Math.round(replies * 2))
          : 0,
        replyRate: Math.round((replies / totalOutbound) * 1000) / 10,
        activeCampaigns: all
          .filter((campaign) => ["active", "queued"].includes(campaign.status))
          .slice(0, 6)
          .map(campaignSummaryView),
        activity: (state.activity || [])
          .filter((activity) => !activity.userId || activity.userId === req.user.id)
          .slice(0, 8)
          .map((activity) => ({
            ...activity,
            time: relativeTime(activity.createdAt),
          })),
        channelHealth: [
          {
            name: "Email",
            status: emailSettings.fromEmail ? "Configured" : "Not configured",
            color: emailSettings.fromEmail ? "green" : "amber",
          },
          {
            name: "Inbox sync",
            status: emailSettings.incomingHost ? "IMAP configured" : "Not linked",
            color: emailSettings.incomingHost ? "green" : "amber",
          },
          {
            name: "WhatsApp",
            status: whatsappSettings.ready ? "Session active" : "QR not linked",
            color: whatsappSettings.ready ? "green" : "amber",
          },
          {
            name: "Compliance",
            status: appSettings.complianceMode ? "Enabled" : "Off",
            color: appSettings.complianceMode ? "green" : "red",
          },
        ],
        weekly: buildWeeklySeries(all),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/analytics",
  requireAuth,
  (req, res, next) => {
    try {
      const state = getRequestState(req);
      const context = req.workspaceContext || getWorkspaceContext(req.user);
      const canViewAll = hasWorkspacePermission(
        req.user,
        "view_all_leads",
        context
      );

      const campaignsList = (state.campaigns || [])
        .filter((campaign) => isUserCampaign(campaign, req.user, context))
        .map((campaign) => campaignViewForUser(campaign, req.user, context))
        .filter((campaign) => (campaign.leads || []).length || canViewAll);

      const inbox = (state.inbox || []).filter((item) =>
        isUserInboxItem(item, req.user, context, state)
      );

      const leads = campaignsList.reduce(
        (sum, campaign) => sum + Number(campaign.leadCount || campaign.leads?.length || 0),
        0
      );
      const outbound = inbox.filter(
        (message) => message.direction === "outbound"
      ).length;
      const replies = inbox.filter(
        (message) => message.direction === "inbound"
      ).length;
      const completedCount = campaignsList.filter(
        (campaign) => campaign.pipelineStatus === "complete"
      ).length;

      res.json({
        metrics: [
          { label: "Campaigns", value: campaignsList.length, note: "total created" },
          { label: "Leads", value: leads, note: "discovered/imported" },
          { label: "Messages", value: outbound, note: "processed" },
          { label: "Replies", value: replies, note: "inbound" },
        ],
        funnel: [
          { label: "Leads discovered", value: leads, percent: 100 },
          {
            label: "Messages sent",
            value: outbound,
            percent: leads ? Math.min(100, Math.round((outbound / leads) * 100)) : 0,
          },
          {
            label: "Replies",
            value: replies,
            percent: outbound ? Math.round((replies / outbound) * 100) : 0,
          },
          {
            label: "Pipeline complete",
            value: completedCount,
            percent: campaignsList.length
              ? Math.round((completedCount / campaignsList.length) * 100)
              : 0,
          },
        ],
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/campaigns",
  requireAuth,
  (req, res, next) => {
    try {
      const startedAt = Date.now();
      const state = getRequestState(req);
      const context = req.workspaceContext || getWorkspaceContext(req.user);
      const canViewAll = hasWorkspacePermission(
        req.user,
        "view_all_leads",
        context
      );
      const requestedStatus = String(req.query.status || "").trim();
      const includeLeads = String(req.query.includeLeads || "false") === "true";

      const items = (state.campaigns || [])
        .filter((campaign) => !requestedStatus || campaign.status === requestedStatus)
        .filter((campaign) => isUserCampaign(campaign, req.user, context))
        .map((campaign) => campaignViewForUser(campaign, req.user, context))
        .filter((campaign) => (campaign.leads || []).length || canViewAll)
        .map((campaign) => includeLeads ? campaign : campaignSummaryView(campaign));

      console.log(
        `[route] campaigns:list ${JSON.stringify({
          requestId: req.requestId || "",
          count: items.length,
          includeLeads,
          elapsedMs: Date.now() - startedAt,
        })}`
      );

      res.json(items);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/campaigns",
  requireAuth,
  requireLeadGenerationManager,
  async (req, res) => {
    try {
      const context =
        req.workspaceContext ||
        getWorkspaceContext(req.user);

      const campaign =
        await campaigns.createCampaign(
          {
            ...req.body,
            userId: req.user.id,

            ownerId:
              context.workspace
                ?.ownerId ||
              req.user.id,

            createdBy:
              req.user.id,

            ownerEmail:
              req.user.email,

            ownerName:
              req.user.name,

            workspaceId:
              context.workspaceId,

            accountType:
              req.user
                .accountType,

            companyName:
              req.user
                .companyName,
          }
        );

      res
        .status(201)
        .json(campaign);
    } catch (error) {
      res
        .status(
          error.statusCode ||
            400
        )
        .json({
          error:
            error.message,
          fields:
            error.fields,
          details:
            error.details,
        });
    }
  }
);

app.post(
  "/api/leads/find/stream",
  requireAuth,
  requireLeadGenerationManager,
  async (req, res) => {
    const requestStartedAt = Date.now();

    const niche = String(
      req.body?.niche ||
        req.body?.category ||
        req.body?.businessType ||
        ""
    ).trim();

    const location = String(
      req.body?.location || ""
    ).trim();

    const limit = Number(
      req.body?.limit ?? 100
    );

    const radiusKm = Number(
      req.body?.radiusKm ?? 10
    );

    const qualityLevel = String(
      req.body?.qualityLevel ||
        "balanced"
    ).trim();

    const regionCode = String(
      req.body?.regionCode || ""
    ).trim();

    const locationVariants =
      Array.isArray(
        req.body?.locationVariants
      )
        ? req.body.locationVariants
            .map((value) =>
              String(value || "").trim()
            )
            .filter(Boolean)
            .slice(0, 20)
        : [];

    if (niche.length < 2) {
      return res.status(400).json({
        error:
          "niche is required and must contain at least 2 characters.",
        code: "LEAD_NICHE_REQUIRED",
      });
    }

    if (location.length < 2) {
      return res.status(400).json({
        error:
          "location is required and must contain at least 2 characters.",
        code: "LEAD_LOCATION_REQUIRED",
      });
    }

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      return res.status(400).json({
        error:
          "limit must be an integer between 1 and 1000.",
        code: "LEAD_LIMIT_INVALID",
      });
    }

    req.setTimeout?.(0);
    res.setTimeout?.(0);
    res.socket?.setTimeout?.(0);

    res.status(200);
    res.set({
      "Content-Type":
        "application/x-ndjson; charset=utf-8",
      "Cache-Control":
        "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.flushHeaders?.();

    let clientClosed = false;

    const streamController =
      new AbortController();

    const closeStream = () => {
      clientClosed = true;

      if (
        !streamController.signal.aborted
      ) {
        streamController.abort();
      }
    };

    req.on("aborted", closeStream);
    res.on("close", closeStream);

    const streamedLeadMap =
      new Map();

    const rememberStreamedLeads = (
      leads
    ) => {
      for (
        const lead of Array.isArray(leads)
          ? leads
          : []
      ) {
        if (!lead) continue;

        const key = String(
          lead.placeId ||
            lead.domain ||
            lead.website ||
            lead.email ||
            lead.phone ||
            `${lead.name || lead.business || ""}|${lead.address || ""}`
        )
          .trim()
          .toLowerCase();

        if (!key) continue;

        streamedLeadMap.set(
          key,
          {
            ...(streamedLeadMap.get(key) || {}),
            ...lead,
          }
        );
      }

      return [
        ...streamedLeadMap.values(),
      ].slice(0, limit);
    };

    const sendEvent = (payload) => {
      if (
        clientClosed ||
        res.destroyed ||
        res.writableEnded
      ) {
        return false;
      }

      try {
        res.write(
          `${JSON.stringify({
            ...payload,
            at:
              payload?.at ||
              new Date().toISOString(),
          })}\n`
        );

        return true;
      } catch {
        return false;
      }
    };

    const heartbeat = setInterval(
      () => {
        sendEvent({ type: "heartbeat" });
      },
      12_000
    );

    heartbeat.unref?.();

    sendEvent({
      type: "started",
      requestId: req.requestId || "",
      requested: limit,
      niche,
      location,
      message:
        `Starting Google Places search for ${limit} ${niche} leads in ${location}.`,
    });

    console.log(
      `[leads] google-stream:start ${JSON.stringify({
        at: new Date().toISOString(),
        requestId: req.requestId || "",
        userId: req.user?.id || "",
        niche,
        location,
        limit,
        radiusKm,
        qualityLevel,
        regionCode,
        locationVariants,
        providerDiagnostics:
          placesProvider.getDiagnostics(),
      })}`
    );

    const streamMaxDurationMs =
      Math.max(
        30_000,
        Number(
          process.env
            .LEAD_STREAM_MAX_DURATION_MS ||
            110_000
        )
      );

    let streamDeadlineTimer = null;
    let leadPromise = null;

    try {
      leadPromise =
        leadFinder.findLeads({
          runId:
            req.requestId ||
            crypto.randomUUID().slice(
              0,
              8
            ),
          niche,
          location,
          limit,
          radiusKm,
          qualityLevel,
          regionCode,
          locationVariants,
          exact:
            req.body?.exact !== false,
          signal:
            streamController.signal,
          onProgress: (event) => {
            sendEvent({
              type: "progress",
              progress: event,
            });
          },
          onLeadBatch: async (batch) => {
            const batchLeads =
              Array.isArray(batch?.leads)
                ? batch.leads
                : [];

            rememberStreamedLeads(
              batchLeads
            );

            sendEvent({
              type: "leads",
              phase:
                batch?.phase ||
                "discovery",
              total:
                Number(batch?.total || 0),
              leads: batchLeads,
              query:
                batch?.query || "",
              page:
                Number(batch?.page || 0),
              index:
                Number(batch?.index || 0),
            });
          },
        });

      const streamTimeoutPromise =
        new Promise((_, reject) => {
          streamDeadlineTimer =
            setTimeout(() => {
              const timeoutError =
                new Error(
                  `Live lead search reached the ${streamMaxDurationMs}ms stream limit.`
                );

              timeoutError.code =
                "LEAD_STREAM_TIMEOUT";
              timeoutError.statusCode =
                504;

              reject(timeoutError);
            }, streamMaxDurationMs);

          streamDeadlineTimer.unref?.();
        });

      const result =
        await Promise.race([
          leadPromise,
          streamTimeoutPromise,
        ]);

      rememberStreamedLeads(
        result?.leads || []
      );

      sendEvent({
        type: "complete",
        result,
      });

      console.log(
        `[leads] google-stream:complete ${JSON.stringify({
          at: new Date().toISOString(),
          requestId: req.requestId || "",
          requested: result.requested,
          delivered: result.delivered,
          shortfall: result.shortfall,
          exact: result.exact,
          status: result.status,
          elapsedMs:
            Date.now() -
            requestStartedAt,
        })}`
      );
    } catch (error) {
      if (
        error?.code ===
        "LEAD_STREAM_TIMEOUT"
      ) {
        if (
          !streamController.signal.aborted
        ) {
          streamController.abort();
        }

        leadPromise?.catch?.(() => {});

        const partialLeads = [
          ...streamedLeadMap.values(),
        ].slice(0, limit);

        const partialResult = {
          ok: true,
          status:
            partialLeads.length
              ? "completed_partial"
              : "completed_empty",
          exact:
            partialLeads.length ===
            limit,
          requested: limit,
          delivered:
            partialLeads.length,
          shortfall: Math.max(
            0,
            limit -
              partialLeads.length
          ),
          message:
            partialLeads.length
              ? `Search finished with ${partialLeads.length} leads before the live verification deadline.`
              : "No usable leads were returned before the live verification deadline.",
          leads: partialLeads,
          meta: {
            source:
              "google-places",
            provider:
              "google-places",
            timedOut: true,
            streamMaxDurationMs,
            elapsedMs:
              Date.now() -
              requestStartedAt,
          },
        };

        sendEvent({
          type: "complete",
          result: partialResult,
        });

        console.warn(
          `[leads] google-stream:partial-timeout ${JSON.stringify({
            at:
              new Date().toISOString(),
            requestId:
              req.requestId || "",
            requested: limit,
            delivered:
              partialLeads.length,
            elapsedMs:
              Date.now() -
              requestStartedAt,
            streamMaxDurationMs,
          })}`
        );

        return;
      }

      console.error(
        `[leads] google-stream:failed ${JSON.stringify({
          at: new Date().toISOString(),
          requestId: req.requestId || "",
          errorName:
            error?.name || "",
          errorCode:
            error?.code || "",
          errorMessage:
            error?.message ||
            String(error),
          statusCode:
            error?.statusCode ||
            error?.status ||
            500,
          elapsedMs:
            Date.now() -
            requestStartedAt,
        })}`
      );

      sendEvent({
        type: "error",
        error:
          error?.message ||
          "Could not retrieve Google Places leads.",
        code: error?.code || "",
        statusCode:
          error?.statusCode ||
          error?.status ||
          500,
        details:
          error?.details || null,
      });
    } finally {
      clearInterval(heartbeat);

      if (streamDeadlineTimer) {
        clearTimeout(
          streamDeadlineTimer
        );
      }

      if (
        !clientClosed &&
        !res.writableEnded
      ) {
        res.end();
      }
    }
  }
);

app.post(
  "/api/leads/find",
  requireAuth,
  requireLeadGenerationManager,
  async (req, res) => {
    const requestStartedAt = Date.now();

    try {
      const niche = String(
        req.body?.niche ||
          req.body?.category ||
          req.body?.businessType ||
          ""
      ).trim();

      const location = String(
        req.body?.location || ""
      ).trim();

      const limit = Number(
        req.body?.limit ?? 100
      );

      const radiusKm = Number(
        req.body?.radiusKm ?? 10
      );

      const qualityLevel = String(
        req.body?.qualityLevel ||
          "balanced"
      ).trim();

      const regionCode = String(
        req.body?.regionCode || ""
      ).trim();

      const locationVariants =
        Array.isArray(
          req.body?.locationVariants
        )
          ? req.body.locationVariants
              .map((value) =>
                String(value || "").trim()
              )
              .filter(Boolean)
              .slice(0, 8)
          : [];

      if (niche.length < 2) {
        return res.status(400).json({
          error:
            "niche is required and must contain at least 2 characters.",
          code: "LEAD_NICHE_REQUIRED",
        });
      }

      if (location.length < 2) {
        return res.status(400).json({
          error:
            "location is required and must contain at least 2 characters.",
          code: "LEAD_LOCATION_REQUIRED",
        });
      }

      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1_000
      ) {
        return res.status(400).json({
          error:
            "limit must be an integer between 1 and 1000.",
          code: "LEAD_LIMIT_INVALID",
        });
      }

      console.log(
        `[leads] google-search:start ${JSON.stringify({
          at: new Date().toISOString(),
          requestId: req.requestId || "",
          userId: req.user?.id || "",
          niche,
          location,
          limit,
          radiusKm,
          qualityLevel,
          regionCode,
          locationVariants,
          providerDiagnostics:
            placesProvider.getDiagnostics(),
        })}`
      );

      const result =
        await leadFinder.findLeads({
          runId:
            req.requestId ||
            crypto.randomUUID().slice(
              0,
              8
            ),
          niche,
          location,
          limit,
          radiusKm,
          qualityLevel,
          regionCode,
          locationVariants,
          exact:
            req.body?.exact !== false,
        });

      res.set(
        "Cache-Control",
        "no-store"
      );

      console.log(
        `[leads] google-search:complete ${JSON.stringify({
          at: new Date().toISOString(),
          requestId: req.requestId || "",
          niche,
          location,
          requested: result.requested,
          delivered: result.delivered,
          shortfall: result.shortfall,
          exact: result.exact,
          status: result.status,
          elapsedMs:
            Date.now() -
            requestStartedAt,
        })}`
      );

      return res.json(result);
    } catch (error) {
      console.error(
        `[leads] google-search:failed ${JSON.stringify({
          at: new Date().toISOString(),
          requestId: req.requestId || "",
          errorName:
            error?.name || "",
          errorCode:
            error?.code || "",
          errorMessage:
            error?.message ||
            String(error),
          statusCode:
            error?.statusCode ||
            error?.status ||
            500,
          details:
            error?.details || null,
          elapsedMs:
            Date.now() -
            requestStartedAt,
        })}`
      );

      const status =
        error?.statusCode ||
        error?.status ||
        500;

      return res
        .status(status)
        .json({
          error:
            status >= 500 &&
            IS_PRODUCTION
              ? "Could not retrieve Google Places leads."
              : error?.message ||
                "Could not retrieve Google Places leads.",
          code:
            error?.code ||
            "GOOGLE_LEAD_SEARCH_FAILED",
          requestId:
            req.requestId || "",
          ...(
            !IS_PRODUCTION &&
            error?.details
              ? {
                  details:
                    error.details,
                }
              : {}
          ),
        });
    }
  }
);


app.get(
  "/api/campaigns/:id",
  requireAuth,
  (req, res) => {
    const campaign =
      getAccessibleCampaign(
        req,
        res
      );

    if (!campaign) {
      return;
    }

    res.json(
      campaignViewForUser(
        campaign,
        req.user
      )
    );
  }
);

app.delete(
  "/api/campaigns/:id",
  requireAuth,
  requireLeadGenerationManager,
  (req, res) => {
    const campaign =
      getAccessibleCampaign(
        req,
        res
      );

    if (!campaign) {
      return;
    }

    campaigns.deleteCampaign(
      req.params.id
    );

    res.status(204).end();
  }
);

app.patch(
  "/api/campaigns/:id/pipeline",
  requireAuth,
  requireLeadGenerationManager,
  (req, res) => {
    try {
      const campaign =
        getAccessibleCampaign(
          req,
          res
        );

      if (!campaign) {
        return;
      }

      ensureCampaignOwnership(
        campaign,
        req.user
      );

      res.json(
        campaigns.updatePipeline(
          req.params.id,
          req.body.pipeline
        )
      );
    } catch (error) {
      res.status(400).json({
        error: error.message,
      });
    }
  }
);

app.post(
  "/api/campaigns/:id/run-pipeline",
  requireAuth,
  requireLeadGenerationManager,
  async (req, res) => {
    try {
      const campaign =
        getAccessibleCampaign(
          req,
          res
        );

      if (!campaign) {
        return;
      }

      ensureCampaignOwnership(
        campaign,
        req.user
      );

      res.json(
        await campaigns.runPipeline(
          req.params.id
        )
      );
    } catch (error) {
      res.status(400).json({
        error: error.message,
      });
    }
  }
);

app.get(
  "/api/campaigns/:id/events",
  requireAuth,
  (req, res) => {
    const id = req.params.id;

    const campaign =
      getAccessibleCampaign(
        req,
        res
      );

    if (!campaign) {
      return;
    }

    res.writeHead(200, {
      "Content-Type":
        "text/event-stream",

      "Cache-Control":
        "no-cache, no-transform",

      Connection: "keep-alive",

      "X-Accel-Buffering":
        "no",
    });

    res.write(
      `data: ${JSON.stringify(
        {
          type: "connected",
          campaign,
        }
      )}\n\n`
    );

    const clients =
      sseClients.get(id) ||
      new Set();

    clients.add(res);

    sseClients.set(
      id,
      clients
    );

    req.on("close", () => {
      clients.delete(res);

      if (!clients.size) {
        sseClients.delete(id);
      }
    });
  }
);

app.get(
  "/api/territories",
  requireAuth,
  (req, res) => {
    const territories = (
      store.read().campaigns ||
      []
    )
      .filter((campaign) =>
        isUserCampaign(
          campaign,
          req.user
        )
      )
      .filter(
        (campaign) =>
          campaign.status ===
            "history" ||
          campaign.status ===
            "complete"
      )
      .map((campaign) => {
        const [lat, lng] =
          getTerritoryCoordinates(
            campaign.location
          );

        return {
          id: campaign.id,
          niche:
            campaign.niche,
          location:
            campaign.location,
          radiusKm:
            campaign.radiusKm ||
            10,
          leadCount:
            campaign.leadCount ||
            0,
          status:
            campaign.status,
          lat,
          lng,
        };
      });

    res.json(territories);
  }
);

app.get(
  "/api/contacts",
  requireAuth,
  (req, res, next) => {
    try {
      const startedAt = Date.now();
      const state = getRequestState(req);
      const context = req.workspaceContext || getWorkspaceContext(req.user);
      const canViewAll = hasWorkspacePermission(
        req.user,
        "view_all_leads",
        context
      );
      const full = String(req.query.full || "false") === "true";
      const offset = Math.max(0, Number.parseInt(req.query.offset || "0", 10) || 0);
      const limit = Math.max(1, Math.min(5_000, Number.parseInt(req.query.limit || "1000", 10) || 1000));
      const contacts = [];
      let matchedCount = 0;
      let scannedLeads = 0;

      console.log(
        `[route] contacts:start ${JSON.stringify({
          requestId: req.requestId || "",
          campaignCount: Array.isArray(state.campaigns) ? state.campaigns.length : 0,
          offset,
          limit,
          full,
          canViewAll,
        })}`
      );

      for (const campaign of state.campaigns || []) {
        if (!isUserCampaign(campaign, req.user, context)) continue;

        for (const lead of campaign.leads || []) {
          scannedLeads += 1;

          if (!canViewAll && lead.assignedTo !== req.user.id) continue;

          if (matchedCount >= offset && contacts.length < limit) {
            contacts.push(
              full
                ? {
                    ...lead,
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                  }
                : contactSummaryView(lead, campaign)
            );
          }

          matchedCount += 1;

          // Once the requested page is full, stop. Counting every remaining
          // lead would make the endpoint slow again on very large stores.
          if (contacts.length >= limit) break;
        }

        if (contacts.length >= limit) break;
      }

      res.setHeader("X-Result-Offset", String(offset));
      res.setHeader("X-Result-Limit", String(limit));
      res.setHeader("X-Returned-Count", String(contacts.length));
      res.setHeader("X-Has-More", String(contacts.length === limit));

      console.log(
        `[route] contacts:complete ${JSON.stringify({
          requestId: req.requestId || "",
          returned: contacts.length,
          matchedBeforeStop: matchedCount,
          scannedLeads,
          elapsedMs: Date.now() - startedAt,
        })}`
      );

      res.json(contacts);
    } catch (error) {
      next(error);
    }
  }
);

/* ==========================================================
   Inbox + email settings routes
   ========================================================== */

app.get(
  "/api/inbox",
  requireAuth,
  requireWorkspacePermission(
    "manage_campaigns"
  ),
  async (req, res) => {
    const context =
      req.workspaceContext ||
      getWorkspaceContext(req.user);

    const ownerId =
      context.workspace
        ?.ownerId ||
      req.user.id;

    res.json(
      await email.listInbox(
        ownerId
      )
    );
  }
);

app.post(
  "/api/inbox/sync",
  requireAuth,
  requireWorkspacePermission(
    "manage_campaigns"
  ),
  async (req, res) => {
    const context =
      req.workspaceContext ||
      getWorkspaceContext(req.user);

    const ownerId =
      context.workspace
        ?.ownerId ||
      req.user.id;

    res.json(
      await email.syncInbox(
        ownerId,
        {
          limit:
            req.body.limit ||
            25,

          accountId:
            req.body
              .accountId || "",
        }
      )
    );
  }
);

app.get(
  "/api/settings/email",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  (req, res) => {
    res.json(
      email.getSettings(
        req.user.id
      )
    );
  }
);

app.put(
  "/api/settings/email",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  async (req, res) => {
    res.json(
      await email.saveSettings(
        req.user.id,
        req.body
      )
    );
  }
);

app.post(
  "/api/settings/email/test",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  async (req, res) => {
    res.json(
      await email.testSettings(
        req.user.id,
        req.body
      )
    );
  }
);

app.post(
  "/api/settings/email/test-inbox",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  async (req, res) => {
    res.json(
      await email.testIncomingSettings(
        req.user.id,
        req.body
      )
    );
  }
);

app.delete(
  "/api/settings/email/accounts/:id",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  async (req, res) => {
    res.json(
      await email.deleteAccount(
        req.user.id,
        req.params.id
      )
    );
  }
);

/* ==========================================================
   App settings + channel routes
   ========================================================== */

app.get(
  "/api/settings/app",
  requireAuth,
  requireWorkspacePermission(
    "manage_workspace"
  ),
  (req, res) => {
    const context =
      req.workspaceContext ||
      getWorkspaceContext(req.user);

    res.json(
      store.read()
        .workspaceSettings?.[
        context.workspaceId
      ]?.app || {}
    );
  }
);

app.put(
  "/api/settings/app",
  requireAuth,
  requireWorkspacePermission(
    "manage_workspace"
  ),
  (req, res) => {
    const context =
      req.workspaceContext ||
      getWorkspaceContext(req.user);

    const safe = {
      workspaceName: String(
        req.body
          .workspaceName ||
          "ReachFly.Ai Growth Workspace"
      ).slice(0, 120),

      brandTagline: String(
        req.body
          .brandTagline || ""
      ).slice(0, 180),

      brandWebsite: String(
        req.body
          .brandWebsite || ""
      )
        .trim()
        .slice(0, 240),

      defaultRadiusKm:
        Number(
          req.body
            .defaultRadiusKm ||
            10
        ),

      defaultLeadLimit:
        Number(
          req.body
            .defaultLeadLimit ||
            100
        ),

      complianceMode:
        req.body
          .complianceMode !==
        false,

      allowDemoFallback:
        req.body
          .allowDemoFallback !==
        false,
    };

    store.update((state) => {
      state.workspaceSettings =
        state.workspaceSettings ||
        {};

      state.workspaceSettings[
        context.workspaceId
      ] =
        state.workspaceSettings[
          context.workspaceId
        ] || {};

      state.workspaceSettings[
        context.workspaceId
      ].app = safe;
    });

    res.json(safe);
  }
);

app.get(
  "/api/whatsapp/status",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  requireLegacyWhatsAppEnabled,
  async (_req, res) => {
    res.json(
      await whatsapp.status()
    );
  }
);

app.post(
  "/api/whatsapp/connect",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  requireLegacyWhatsAppEnabled,
  async (_req, res) => {
    res.json(
      await whatsapp.connect()
    );
  }
);

app.post(
  "/api/whatsapp/logout",
  requireAuth,
  requireWorkspacePermission(
    "manage_channels"
  ),
  requireLegacyWhatsAppEnabled,
  async (_req, res) => {
    res.json(
      await whatsapp.logout()
    );
  }
);

app.post(
  "/api/ai/command",
  requireAuth,
  async (req, res) => {
    res.json(
      await ai.command(
        req.body.command,
        {
          user: req.user,
          screen:
            req.body.screen ||
            {},
        }
      )
    );
  }
);

/* ==========================================================
   ReachFly upgrade routes
   ========================================================== */

function registerReachFlyUpgradeRoutes({
  app,
  requireAuth,
  workspaceService,
  auditService,
  auditJobService,
  ai,
  signToken,
  publicUser,
}) {
  app.post(
    "/api/auth/accept-invite",
    (req, res, next) => {
      try {
        const user =
          workspaceService.acceptInvite(
            req.body || {}
          );

        const token =
          signToken({
            userId: user.id,
          });

        res.status(201).json({
          token,
          user:
            publicUser(user),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/team",
    requireAuth,
    (req, res, next) => {
      try {
        workspaceService.requireUserPermission(
          req.user,
          "manage_team"
        );

        res.json({
          workspace:
            workspaceService.getContext(
              req.user
            ).workspace,

          members:
            workspaceService.listMembers(
              req.user
            ),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/team/invites",
    requireAuth,
    async (req, res, next) => {
      try {
        const invitation =
          await workspaceService.inviteMember(
            req.user,
            req.body
          );

        res
          .status(201)
          .json(invitation);
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/team/:memberId",
    requireAuth,
    (req, res, next) => {
      try {
        const member =
          workspaceService.updateMember(
            req.user,
            req.params.memberId,
            req.body
          );

        res.json(member);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/team/performance",
    requireAuth,
    (req, res, next) => {
      try {
        const performance =
          workspaceService.performance(
            req.user,
            {
              from:
                req.query.from,
              to: req.query.to,
            }
          );

        res.json(performance);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/my-leads",
    requireAuth,
    (req, res, next) => {
      try {
        const leads =
          workspaceService.listMyLeads(
            req.user,
            {
              status:
                req.query.status,

              assignedTo:
                req.query
                  .assignedTo,
            }
          );

        res.json(leads);
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/campaigns/:campaignId/leads/bulk-assign",
    requireAuth,
    requireLeadAssignmentManager,
    (req, res, next) => {
      try {
        const result =
          workspaceService.bulkAssignLeads(
            req.user,
            req.params
              .campaignId,
            req.body
          );

        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/campaigns/:campaignId/leads/:leadId/assignment",
    requireAuth,
    requireLeadAssignmentManager,
    (req, res, next) => {
      try {
        const lead =
          workspaceService.assignLead(
            req.user,
            req.params
              .campaignId,
            req.params.leadId,
            req.body
          );

        res.json(lead);
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/campaigns/:campaignId/leads/:leadId",
    requireAuth,
    (req, res, next) => {
      try {
        const lead =
          workspaceService.updateLead(
            req.user,
            req.params
              .campaignId,
            req.params.leadId,
            req.body
          );

        res.json(lead);
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/campaigns/:campaignId/leads/:leadId/calls",
    requireAuth,
    (req, res, next) => {
      try {
        const call =
          workspaceService.logCall(
            req.user,
            req.params
              .campaignId,
            req.params.leadId,
            req.body
          );

        res
          .status(201)
          .json(call);
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/campaigns/:campaignId/leads/:leadId/email",
    requireAuth,
    async (req, res, next) => {
      try {
        const emailResult =
          await workspaceService.sendLeadEmail(
            req.user,
            req.params
              .campaignId,
            req.params.leadId,
            req.body
          );

        res
          .status(201)
          .json(emailResult);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/audits",
    requireAuth,
    (req, res, next) => {
      try {
        workspaceService.requireUserPermission(
          req.user,
          "view_audits"
        );

        res.json(
          auditService.listAudits(
            req.user
          )
        );
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/audits",
    requireAuth,
    async (req, res, next) => {
      try {
        workspaceService.requireUserPermission(
          req.user,
          "create_audits"
        );

        const audit =
          await auditService.createAudit(
            req.user,
            req.body
          );

        res
          .status(201)
          .json(audit);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/audits/:id",
    requireAuth,
    (req, res, next) => {
      try {
        workspaceService.requireUserPermission(
          req.user,
          "view_audits"
        );

        const audit =
          auditService.getAudit(
            req.user,
            req.params.id
          );

        if (!audit) {
          return res
            .status(404)
            .json({
              error:
                "Audit not found.",
            });
        }

        return res.json(audit);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.get(
    "/api/audit-jobs",
    requireAuth,
    (req, res, next) => {
      try {
        workspaceService.requireUserPermission(
          req.user,
          "view_audits"
        );

        const jobs =
          auditJobService.listJobs(
            req.user,
            req.query
              .campaignId || ""
          );

        res.json(jobs);
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/campaigns/:campaignId/audit-jobs",
    requireAuth,
    (req, res, next) => {
      try {
        workspaceService.requireUserPermission(
          req.user,
          "create_audits"
        );

        const job =
          auditJobService.createBatchJob(
            req.user,
            req.params
              .campaignId,
            req.body || {}
          );

        res
          .status(202)
          .json(job);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/audit-jobs/:id",
    requireAuth,
    (req, res, next) => {
      try {
        workspaceService.requireUserPermission(
          req.user,
          "view_audits"
        );

        const job =
          auditJobService.getJob(
            req.user,
            req.params.id
          );

        res.json(job);
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/ai/contextual-command",
    requireAuth,
    async (req, res, next) => {
      try {
        const result =
          await ai.command(
            req.body.command,
            {
              user: req.user,
              screen:
                req.body
                  .screen || {},
            }
          );

        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );
}

registerReachFlyUpgradeRoutes({
  app,
  requireAuth,
  workspaceService,
  auditService,
  auditJobService,
  ai,
  signToken,
  publicUser,
});





/* ==========================================================
   Automatic daily lead allocation and caller work queue
   ========================================================== */

app.get(
  "/api/daily-leads/status",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        dailyLeadAutomationService.getStatus(
          req.user
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.put(
  "/api/daily-leads/config",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        dailyLeadAutomationService.saveConfig(
          req.user,
          req.body || {}
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/daily-leads/run",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      await dailyLeadAutomationService.runForUser(
        req.user,
        {
          force: Boolean(
            req.body?.force
          ),
        }
      );

    res.status(202).json(result);
  })
);

app.get(
  "/api/caller-queue",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        callerQueueService.listQueue(
          req.user,
          req.query || {}
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/caller-queue/next",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        callerQueueService.nextLead(
          req.user,
          req.query || {}
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/caller-queue/:id/history",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        callerQueueService.getHistory(
          req.user,
          req.params.id
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/caller-queue/:id/open",
  requireAuth,
  (req, res, next) => {
    try {
      const result =
        callerQueueService.markOpened(
          req.user,
          req.params.id
        );

      emitToWorkspace(
        req.workspaceContext?.workspaceId,
        "lead:updated",
        result
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/caller-queue/:id/call/start",
  requireAuth,
  (req, res, next) => {
    try {
      const result =
        callerQueueService.startCall(
          req.user,
          req.params.id,
          req.body || {}
        );

      emitToWorkspace(
        req.workspaceContext?.workspaceId,
        "lead:call-updated",
        result
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/caller-queue/:id/call/complete",
  requireAuth,
  (req, res, next) => {
    try {
      const result =
        callerQueueService.completeCall(
          req.user,
          req.params.id,
          req.body || {}
        );

      emitToWorkspace(
        req.workspaceContext?.workspaceId,
        "lead:call-updated",
        result
      );

      emitToWorkspace(
        req.workspaceContext?.workspaceId,
        "lead:updated",
        result
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/caller-queue/:id/outcome",
  requireAuth,
  (req, res, next) => {
    try {
      const result =
        callerQueueService.updateOutcome(
          req.user,
          req.params.id,
          req.body || {}
        );

      emitToWorkspace(
        req.workspaceContext?.workspaceId,
        "lead:updated",
        result
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/caller-queue/:id/skip",
  requireAuth,
  (req, res, next) => {
    try {
      const result =
        callerQueueService.skipLead(
          req.user,
          req.params.id,
          req.body || {}
        );

      emitToWorkspace(
        req.workspaceContext?.workspaceId,
        "lead:updated",
        result
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/caller-queue/:id/callback",
  requireAuth,
  (req, res, next) => {
    try {
      const result =
        callerQueueService.scheduleCallback(
          req.user,
          req.params.id,
          req.body || {}
        );

      emitToWorkspace(
        req.workspaceContext?.workspaceId,
        "lead:updated",
        result
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);


/* ==========================================================
   Telnyx browser dialer, call tracking and recordings
   ========================================================== */

app.use(
  "/attendance-selfies",
  express.static(
    attendanceService.selfieDirectory,
    {
      fallthrough: false,
      index: false,
      maxAge: IS_PRODUCTION ? "7d" : 0,
    }
  )
);

app.get(
  "/api/telnyx/diagnostics",
  requireAuth,
  (req, res) => {
    res.json(telnyxCallService.diagnostics(req.user));
  }
);

app.get(
  "/api/telnyx/session",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await telnyxCallService.getBrowserSession(req.user));
  })
);

app.get(
  "/api/telnyx/dialers",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxCallService.listDialers(req.user));
  })
);

app.post(
  "/api/telnyx/dialers/provision",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.status(201).json(await telnyxCallService.provisionAllCallers(req.user));
  })
);

app.post(
  "/api/telnyx/calls",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.status(201).json(telnyxCallService.createCall(req.user, req.body || {}));
  })
);

app.get(
  "/api/telnyx/calls",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxCallService.listCalls(req.user, req.query || {}));
  })
);

app.get(
  "/api/telnyx/calls/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxCallService.getCall(req.user, req.params.id));
  })
);

app.patch(
  "/api/telnyx/calls/:id/link",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxCallService.linkCall(req.user, req.params.id, req.body || {}));
  })
);

app.patch(
  "/api/telnyx/calls/:id/state",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxCallService.updateClientState(req.user, req.params.id, req.body || {}));
  })
);

app.patch(
  "/api/telnyx/calls/:id/complete",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxCallService.completeCall(req.user, req.params.id, req.body || {}));
  })
);

app.get(
  "/api/telnyx/recordings/:callId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const recording = telnyxCallService.getRecording(req.user, req.params.callId);
    res.setHeader("Content-Type", recording.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${recording.filename}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.sendFile(recording.filePath);
  })
);

app.post(
  "/api/telnyx/webhooks/call-control",
  asyncRoute(async (req, res) => {
    // Respond only after signature verification and durable event storage.
    const result = await telnyxCallService.handleWebhook({
      rawBody: req.rawBody || JSON.stringify(req.body || {}),
      headers: req.headers,
      body: req.body || {},
    });
    res.status(200).json(result);
  })
);

/* ==========================================================
   Workspace-scoped Telnyx AI voice agent
   ========================================================== */

app.get(
  "/api/telnyx/ai-agent/access",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxAiAgentService.getAccess(req.user));
  })
);

app.get(
  "/api/telnyx/ai-agent/dashboard",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(telnyxAiAgentService.getDashboard(req.user));
  })
);

app.get(
  "/api/telnyx/ai-agent/voices",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(
      await telnyxAiAgentService.listVoices(req.user, {
        force: String(req.query.force || "") === "true",
      })
    );
  })
);

app.put(
  "/api/telnyx/ai-agent",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(
      await telnyxAiAgentService.saveAgent(
        req.user,
        req.body || {}
      )
    );
  })
);

app.post(
  "/api/telnyx/ai-agent/leads/assign",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.status(201).json(
      telnyxAiAgentService.assignLeads(
        req.user,
        req.body || {}
      )
    );
  })
);

app.post(
  "/api/telnyx/ai-agent/campaigns/start",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.status(202).json(
      await telnyxAiAgentService.startCampaign(
        req.user,
        req.body || {}
      )
    );
  })
);

app.post(
  "/api/telnyx/ai-agent/calls/:id/cancel",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(
      await telnyxAiAgentService.cancelCall(
        req.user,
        req.params.id
      )
    );
  })
);

/*
 * These two tool routes are called by the Telnyx AI Assistant itself.
 * They are protected by TELNYX_AI_AGENT_TOOL_SECRET configured as a
 * custom header on each Telnyx webhook tool.
 */
app.post(
  "/api/telnyx/ai-agent/tools/book-meeting",
  asyncRoute(async (req, res) => {
    res.json(
      telnyxAiAgentService.bookMeeting({
        headers: req.headers,
        body: req.body || {},
      })
    );
  })
);

app.post(
  "/api/telnyx/ai-agent/tools/update-lead",
  asyncRoute(async (req, res) => {
    res.json(
      telnyxAiAgentService.updateLeadOutcome({
        headers: req.headers,
        body: req.body || {},
      })
    );
  })
);

/*
 * Telnyx call lifecycle and AI-conversation webhooks. Signature verification
 * is performed inside telnyxAiAgentService using req.rawBody.
 */
app.post(
  "/api/telnyx/ai-agent/webhooks",
  asyncRoute(async (req, res) => {
    const result =
      await telnyxAiAgentService.handleWebhook({
        rawBody:
          req.rawBody || JSON.stringify(req.body || {}),
        headers: req.headers,
        body: req.body || {},
      });
    res.status(200).json(result);
  })
);

app.get(
  "/api/telnyx/contact-policy",
  requireAuth,
  asyncRoute(async (req, res) => {
    const lead = req.query.lead ? JSON.parse(String(req.query.lead)) : req.query;
    res.json(salesOperationsService.getContactPolicy(req.user, lead));
  })
);

app.get(
  "/api/attendance/today",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        attendanceService.today(
          req.user
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/attendance/history",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        attendanceService.history(
          req.user,
          {
            limit:
              req.query.limit,
          }
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/attendance/team",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        attendanceService.team(
          req.user,
          {
            dateKey:
              req.query.dateKey,
          }
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/attendance/check-in",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        attendanceService.checkIn(
          req.user,
          req.body || {}
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/attendance/check-out",
  requireAuth,
  (req, res, next) => {
    try {
      res.json(
        attendanceService.checkOut(
          req.user,
          req.body || {}
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.get("/api/sales/dashboard", requireAuth, (req, res, next) => {
  try { res.json(salesOperationsService.dashboard(req.user)); }
  catch (error) { next(error); }
});

app.get("/api/sales/assignments", requireAuth, (req, res, next) => {
  try { res.json({ assignments: salesOperationsService.listAssignments(req.user) }); }
  catch (error) { next(error); }
});

app.patch("/api/sales/assignments/:id", requireAuth, (req, res, next) => {
  try {
    res.json(
      salesOperationsService.updateAssignment(
        req.user,
        req.params.id,
        req.body || {}
      )
    );
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/sales/assignments",
  requireAuth,
  requireLeadAssignmentManager,
  (req, res, next) => {
  try { res.status(201).json(salesOperationsService.assignLeads(req.user, req.body || {})); }
    catch (error) { next(error); }
  }
);

app.get("/api/sales/report-template", requireAuth, (req, res, next) => {
  try { res.json(salesOperationsService.getReportTemplate(req.user)); }
  catch (error) { next(error); }
});

app.put("/api/sales/report-template", requireAuth, (req, res, next) => {
  try { res.json(salesOperationsService.updateReportTemplate(req.user, req.body || {})); }
  catch (error) { next(error); }
});

/* ==========================================================
   Role-aware team, sender, dialer and owner control routes
   ========================================================== */

app.get("/api/team", requireAuth, (req, res, next) => {
  try { res.json({ members: teamControlService.listTeam(req.user) }); } catch (error) { next(error); }
});

app.patch("/api/team/:id", requireAuth, (req, res, next) => {
  try { res.json(teamControlService.updateMember(req.user, req.params.id, req.body || {})); } catch (error) { next(error); }
});

app.get("/api/dialers", requireAuth, (req, res, next) => {
  try { res.json({ dialers: teamControlService.listDialers(req.user) }); } catch (error) { next(error); }
});

app.post("/api/dialers", requireAuth, (req, res, next) => {
  try { res.status(201).json(teamControlService.saveDialer(req.user, req.body || {})); } catch (error) { next(error); }
});

app.get("/api/senders", requireAuth, (req, res, next) => {
  try { res.json({ senders: teamControlService.listSenders(req.user) }); } catch (error) { next(error); }
});

app.post("/api/senders", requireAuth, (req, res, next) => {
  try { res.status(201).json(teamControlService.saveSender(req.user, req.body || {})); } catch (error) { next(error); }
});

app.get("/api/owner/overview", requireAuth, (req, res, next) => {
  try { res.json(teamControlService.ownerOverview(req.user)); } catch (error) { next(error); }
});

/* ==========================================================
   Manager resource whiteboard
   ========================================================== */

app.get(
  "/api/resource-board",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(
      resourceBoardService.getBoard(
        req.user,
        req.query || {}
      )
    );
  })
);

app.patch(
  "/api/resource-board/leads/:assignmentId/assignee",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      resourceBoardService.assignLead(
        req.user,
        req.params.assignmentId,
        req.body || {}
      );

    emitToWorkspace(
      req.workspaceContext?.workspaceId ||
        result.assignment?.workspaceId,
      "resource-board:lead-updated",
      result
    );

    emitToWorkspace(
      req.workspaceContext?.workspaceId ||
        result.assignment?.workspaceId,
      "lead:updated",
      {
        assignment: result.assignment,
        lead: result.assignment?.lead,
      }
    );

    res.json(result);
  })
);

app.post(
  "/api/resource-board/leads/assign",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      resourceBoardService.assignLeads(
        req.user,
        req.body || {}
      );

    emitToWorkspace(
      req.workspaceContext?.workspaceId,
      "resource-board:updated",
      {
        type: "bulk_lead_assignment",
        updated: result.updated,
      }
    );

    res.json(result);
  })
);

app.patch(
  "/api/resource-board/tasks/:taskId/assignee",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      await resourceBoardService.assignTask(
        req.user,
        req.params.taskId,
        req.body || {}
      );

    emitToWorkspace(
      req.workspaceContext?.workspaceId ||
        result.task?.workspaceId,
      "team:task-updated",
      { task: result.task }
    );

    emitToWorkspace(
      req.workspaceContext?.workspaceId ||
        result.task?.workspaceId,
      "resource-board:updated",
      {
        type: "task_assignment",
        task: result.task,
      }
    );

    res.json(result);
  })
);

app.patch(
  "/api/resource-board/resources/:resourceId/limit",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      resourceBoardService.setResourceLimit(
        req.user,
        req.params.resourceId,
        req.body || {}
      );

    emitToWorkspace(
      req.workspaceContext?.workspaceId,
      "resource-board:resource-updated",
      result
    );

    res.json(result);
  })
);

app.patch(
  "/api/resource-board/resources/:resourceId/channels",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      await resourceBoardService.assignChannels(
        req.user,
        req.params.resourceId,
        req.body || {}
      );

    emitToWorkspace(
      req.workspaceContext?.workspaceId,
      "resource-board:resource-updated",
      result
    );

    res.json(result);
  })
);

app.post(
  "/api/resource-board/resources",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      await resourceBoardService.createResource(
        req.user,
        req.body || {}
      );

    emitToWorkspace(
      req.workspaceContext?.workspaceId,
      "resource-board:resource-updated",
      {
        type: "resource_created",
        resource: result.resource,
      }
    );

    res.status(201).json(result);
  })
);

app.patch(
  "/api/resource-board/resources/:resourceId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result =
      resourceBoardService.updateResource(
        req.user,
        req.params.resourceId,
        req.body || {}
      );

    emitToWorkspace(
      req.workspaceContext?.workspaceId,
      "resource-board:resource-updated",
      result
    );

    res.json(result);
  })
);

app.get("/api/dev/test-accounts", (req, res) => {
  if (process.env.NODE_ENV === "production" || String(process.env.ENABLE_TEST_ACCOUNTS || "false") !== "true") {
    return res.status(404).json({ error: "Not found." });
  }
  const supplied = String(req.headers["x-test-seed-token"] || req.query.token || "");
  if (!process.env.TEST_ACCOUNT_SEED_TOKEN || supplied !== process.env.TEST_ACCOUNT_SEED_TOKEN) {
    return res.status(403).json({ error: "Invalid test seed token." });
  }
  res.json(seededTestAccounts);
});

/* ==========================================================
   Lead mini-audit, competitor, full-audit and PDF routes
   ========================================================== */

app.get(
  "/api/lead-audits",
  requireAuth,
  (req, res, next) => {
    try {
      workspaceService.requireUserPermission(
        req.user,
        "view_audits"
      );

      res.json({
        reports:
          leadAuditService.listReports(
            req.user,
            {
              website:
                req.query.website || "",
              kind:
                req.query.kind || "",
            }
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/lead-audits/mini/batch",
  requireAuth,
  (req, res, next) => {
    try {
      workspaceService.requireUserPermission(
        req.user,
        "create_audits"
      );

      const result =
        leadAuditService.queueMiniBatch(
          req.user,
          req.body || {}
        );

      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/lead-audits/mini",
  requireAuth,
  (req, res, next) => {
    try {
      workspaceService.requireUserPermission(
        req.user,
        "create_audits"
      );

      const report =
        leadAuditService.queueMiniAudit(
          req.user,
          req.body || {}
        );

      res
        .status(
          report.status === "complete"
            ? 200
            : 202
        )
        .json(report);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/lead-audits/generate",
  requireAuth,
  (req, res, next) => {
    try {
      workspaceService.requireUserPermission(
        req.user,
        "create_audits"
      );

      const report =
        leadAuditService.queueGeneratedReport(
          req.user,
          req.body || {}
        );

      res.status(202).json(report);
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/lead-audits/:id/pdf",
  requireAuth,
  (req, res, next) => {
    try {
      workspaceService.requireUserPermission(
        req.user,
        "view_audits"
      );

      const pdf =
        leadAuditService.createPdf(
          req.user,
          req.params.id
        );

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${pdf.filename}"`
      );
      res.setHeader(
        "Content-Length",
        String(pdf.buffer.length)
      );
      res.send(pdf.buffer);
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/lead-audits/status/queue",
  requireAuth,
  (req, res, next) => {
    try {
      workspaceService.requireUserPermission(
        req.user,
        "view_audits"
      );

      res.json(leadAuditService.getQueueStats());
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/lead-audits/:id",
  requireAuth,
  (req, res, next) => {
    try {
      workspaceService.requireUserPermission(
        req.user,
        "view_audits"
      );

      res.json(
        leadAuditService.getReport(
          req.user,
          req.params.id
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

/* ==========================================================
   Static web build
   ========================================================== */

const staticDir = path.resolve(
  __dirname,
  "../../../dist/web"
);

app.use(
  express.static(staticDir)
);

app.get(
  /^\/(?!api).*/,
  (_req, res) => {
    res.sendFile(
      path.join(
        staticDir,
        "index.html"
      ),
      (error) => {
        if (error) {
          res.status(404).json({
            error:
              "Web build not found. Run npm run build or use npm run dev.",
          });
        }
      }
    );
  }
);


/* ==========================================================
   Utils
   ========================================================== */

function buildWeeklySeries(
  campaignsList
) {
  const series = [
    20,
    28,
    36,
    44,
    52,
    64,
    72,
  ];

  const activeBoost =
    campaignsList.filter(
      (campaign) =>
        campaign.status ===
        "active"
    ).length * 8;

  const leadBoost = Math.min(
    22,
    Math.round(
      campaignsList.reduce(
        (sum, campaign) =>
          sum +
          (campaign.leadCount ||
            0),
        0
      ) / 30
    )
  );

  return series.map(
    (number, index) =>
      Math.min(
        96,
        number +
          activeBoost +
          leadBoost +
          (index % 2 ? 6 : 0)
      )
  );
}


function relativeTime(value) {
  const then = new Date(
    value
  ).getTime();

  const diff = Math.max(
    1,
    Date.now() - then
  );

  const mins = Math.floor(
    diff / 60000
  );

  if (mins < 1) {
    return "just now";
  }

  if (mins < 60) {
    return `${mins} min ago`;
  }

  const hrs = Math.floor(
    mins / 60
  );

  if (hrs < 24) {
    return `${hrs} hr ago`;
  }

  return `${Math.floor(
    hrs / 24
  )} day ago`;
}

/* ==========================================================
   Final error handling and server startup
   ========================================================== */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    if (
      error?.type ===
      "entity.too.large"
    ) {
      return res.status(413).json({
        error:
          "Uploaded request body is too large. Reduce the payload or increase BODY_LIMIT.",
        limit: BODY_LIMIT,
        requestId:
          req?.requestId || "",
      });
    }

    next(error);
  }
);

app.use(
  (
    error,
    req,
    res,
    _next
  ) => {
    if (res.headersSent) {
      console.error(
        `[api-error] headers-already-sent ${JSON.stringify({
          at: new Date().toISOString(),
          requestId:
            req?.requestId || "",
          method:
            req?.method || "",
          path:
            req?.originalUrl ||
            req?.url ||
            "",
          message:
            error?.message ||
            String(error),
        })}`
      );

      return;
    }

    const status =
      error?.statusCode ||
      error?.status ||
      500;

    const requestId =
      req?.requestId || "";

    console.error(
      `[api-error] ${JSON.stringify({
        at: new Date().toISOString(),
        requestId,
        method:
          req?.method || "",
        path:
          req?.originalUrl ||
          req?.url ||
          "",
        status,
        code:
          error?.code || "",
        message:
          error?.message ||
          "Internal server error.",
        details:
          error?.details ||
          null,
        stack:
          error?.stack || "",
      })}`
    );

    res.status(status).json({
      error:
        status >= 500
          ? (
              IS_PRODUCTION
                ? "Internal server error."
                : error?.message ||
                  "Internal server error."
            )
          : error?.message,
      requestId,
      ...(error?.code
        ? {
            code: error.code,
          }
        : {}),
      ...(
        !IS_PRODUCTION &&
        error?.details
          ? {
              details:
                error.details,
            }
          : {}
      ),
    });
  }
);

const httpServer =
  app.listen(
    PORT,
    API_HOST,
    () => {
      console.log(
        `ReachFly API listening on ${API_HOST}:${PORT}`
      );
    }
  );



const DAILY_LEAD_TIMEZONE =
  process.env.DAILY_LEAD_TIMEZONE ||
  "Asia/Karachi";

const DAILY_LEAD_ASSIGNMENT_HOUR = clampInteger(
  process.env.DAILY_LEAD_ASSIGNMENT_HOUR,
  0,
  0,
  23
);

const DAILY_LEAD_ASSIGNMENT_MINUTE = clampInteger(
  process.env.DAILY_LEAD_ASSIGNMENT_MINUTE,
  0,
  0,
  59
);

let dailyLeadSchedulerTimer = null;
let dailyLeadStartupTimer = null;
let dailyLeadRunInProgress = false;
let dailyLeadSchedulerStopped = false;

async function runDailyLeadAutomation(
  source = "scheduler",
  { force = false } = {}
) {
  if (dailyLeadRunInProgress) {
    console.log(
      `[daily-leads] skipped ${JSON.stringify({
        at: new Date().toISOString(),
        source,
        reason: "A daily lead run is already in progress.",
      })}`
    );

    return null;
  }

  dailyLeadRunInProgress = true;

  try {
    const result =
      await dailyLeadAutomationService.runAllWorkspaces({
        source,
        force,
      });

    console.log(
      `[daily-leads] completed ${JSON.stringify({
        at: new Date().toISOString(),
        source,
        result,
      })}`
    );

    return result;
  } catch (error) {
    console.error(
      `[daily-leads] failed ${JSON.stringify({
        at: new Date().toISOString(),
        source,
        message:
          error?.message ||
          String(error),
        stack:
          error?.stack || "",
      })}`
    );

    return null;
  } finally {
    dailyLeadRunInProgress = false;
  }
}

function scheduleNextDailyLeadRun() {
  if (
    dailyLeadSchedulerStopped ||
    !envFlag(
      "DAILY_LEAD_AUTOMATION_ENABLED",
      false
    )
  ) {
    return;
  }

  if (dailyLeadSchedulerTimer) {
    clearTimeout(dailyLeadSchedulerTimer);
  }

  const delayMs = millisecondsUntilNextZonedTime({
    timeZone: DAILY_LEAD_TIMEZONE,
    hour: DAILY_LEAD_ASSIGNMENT_HOUR,
    minute: DAILY_LEAD_ASSIGNMENT_MINUTE,
  });

  const nextRunAt = new Date(
    Date.now() + delayMs
  ).toISOString();

  console.log(
    `[daily-leads] scheduled ${JSON.stringify({
      at: new Date().toISOString(),
      timeZone: DAILY_LEAD_TIMEZONE,
      hour: DAILY_LEAD_ASSIGNMENT_HOUR,
      minute: DAILY_LEAD_ASSIGNMENT_MINUTE,
      nextRunAt,
      delayMs,
    })}`
  );

  dailyLeadSchedulerTimer = setTimeout(
    async () => {
      try {
        await runDailyLeadAutomation(
          "midnight-scheduler"
        );
      } finally {
        scheduleNextDailyLeadRun();
      }
    },
    delayMs
  );

  dailyLeadSchedulerTimer.unref?.();
}

function startDailyLeadScheduler() {
  if (
    !envFlag(
      "DAILY_LEAD_AUTOMATION_ENABLED",
      false
    )
  ) {
    console.log(
      "[daily-leads] automation disabled"
    );

    return;
  }

  dailyLeadSchedulerStopped = false;

  const startupDelayMs = Math.max(
    5_000,
    Number(
      process.env
        .DAILY_LEAD_STARTUP_DELAY_MS ||
        15_000
    )
  );

  dailyLeadStartupTimer = setTimeout(
    () => {
      // The service is date-idempotent, so this safely catches a missed
      // midnight run after a server restart without duplicating assignments.
      void runDailyLeadAutomation(
        "startup-catch-up"
      );
    },
    startupDelayMs
  );

  dailyLeadStartupTimer.unref?.();
  scheduleNextDailyLeadRun();
}

function stopDailyLeadScheduler() {
  dailyLeadSchedulerStopped = true;

  if (dailyLeadStartupTimer) {
    clearTimeout(dailyLeadStartupTimer);
    dailyLeadStartupTimer = null;
  }

  if (dailyLeadSchedulerTimer) {
    clearTimeout(dailyLeadSchedulerTimer);
    dailyLeadSchedulerTimer = null;
  }
}

function millisecondsUntilNextZonedTime({
  timeZone,
  hour,
  minute,
}) {
  const now = new Date();
  const local = getZonedDateParts(
    now,
    timeZone
  );

  let dateKey = [
    local.year,
    String(local.month).padStart(2, "0"),
    String(local.day).padStart(2, "0"),
  ].join("-");

  const targetAlreadyPassed =
    local.hour > hour ||
    (
      local.hour === hour &&
      local.minute >= minute
    );

  if (targetAlreadyPassed) {
    dateKey = addDaysToDateKey(
      dateKey,
      1
    );
  }

  const target = zonedDateTimeToUtc({
    dateKey,
    hour,
    minute,
    timeZone,
  });

  return Math.max(
    1_000,
    target.getTime() - now.getTime()
  );
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

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [
      type,
      value,
    ])
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function zonedDateTimeToUtc({
  dateKey,
  hour,
  minute,
  timeZone,
}) {
  const [year, month, day] = dateKey
    .split("-")
    .map(Number);

  let estimate = new Date(
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
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    const represented = getZonedDateParts(
      estimate,
      timeZone
    );

    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second
    );

    const requestedUtc = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      0
    );

    estimate = new Date(
      estimate.getTime() +
        requestedUtc -
        representedUtc
    );
  }

  return estimate;
}

function addDaysToDateKey(
  dateKey,
  days
) {
  const [year, month, day] = dateKey
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

function clampInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const number = Number.parseInt(
    value,
    10
  );

  if (!Number.isFinite(number)) {
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

startDailyLeadScheduler();


const io = new SocketIOServer(
  httpServer,
  {
    cors: {
      credentials: true,

      origin(origin, callback) {
        if (
          !origin ||
          isAllowedCorsOrigin(origin)
        ) {
          callback(null, true);
          return;
        }

        callback(
          new Error(
            "Origin is not allowed by Socket.IO CORS."
          )
        );
      },

      methods: [
        "GET",
        "POST",
      ],
    },

    transports: [
      "websocket",
      "polling",
    ],

    maxHttpBufferSize:
      TEAM_ATTACHMENT_MAX_BYTES,
  }
);

function workspaceRoom(
  workspaceId
) {
  return `workspace:${workspaceId}`;
}

function userRoom(userId) {
  return `user:${userId}`;
}

function channelRoom(
  channelId
) {
  return `channel:${channelId}`;
}

function emitToWorkspace(
  workspaceId,
  eventName,
  payload
) {
  if (!workspaceId) {
    return;
  }

  io.to(
    workspaceRoom(workspaceId)
  ).emit(eventName, payload);
}

function emitToUser(
  userId,
  eventName,
  payload
) {
  if (!userId) {
    return;
  }

  io.to(
    userRoom(userId)
  ).emit(eventName, payload);
}

function emitToChannel(
  channelId,
  eventName,
  payload
) {
  if (!channelId) {
    return;
  }

  io.to(
    channelRoom(channelId)
  ).emit(eventName, payload);
}

function emitChannelEvent(
  channel,
  eventName
) {
  if (!channel) {
    return;
  }

  emitToWorkspace(
    channel.workspaceId,
    eventName,
    {
      channel,
    }
  );
}

function resolveSocketUser(
  socket
) {
  const authorization =
    String(
      socket.handshake.headers
        ?.authorization ||
        ""
    );

  const bearerToken =
    authorization.startsWith(
      "Bearer "
    )
      ? authorization.slice(7)
      : "";

  const token =
    String(
      socket.handshake.auth?.token ||
        socket.handshake.query?.token ||
        bearerToken ||
        ""
    );

  const payload =
    verifyToken(token);

  if (!payload?.userId) {
    return null;
  }

  const state = store.read();

  const user =
    (state.users || []).find(
      (item) =>
        item.id ===
        payload.userId
    );

  if (!user) {
    return null;
  }

  const workspaceContext =
    workspaceService.getContext(
      user,
      state
    );

  return {
    user:
      workspaceContext.user ||
      user,

    context:
      workspaceContext,
  };
}

io.use((socket, next) => {
  try {
    const resolved =
      resolveSocketUser(socket);

    if (!resolved) {
      const error =
        new Error(
          "Unauthorized socket connection."
        );

      error.data = {
        status: 401,
      };

      next(error);
      return;
    }

    socket.data.user =
      resolved.user;

    socket.data.workspaceContext =
      resolved.context;

    next();
  } catch (error) {
    next(error);
  }
});

io.on("connection", (socket) => {
  const user =
    socket.data.user;

  const workspaceContext =
    socket.data.workspaceContext;

  const workspaceId =
    workspaceContext.workspaceId;

  socket.join(
    workspaceRoom(
      workspaceId
    )
  );

  socket.join(
    userRoom(user.id)
  );

  const presence =
    teamCommunicationService.updatePresence(
      user,
      "online"
    );

  emitToWorkspace(
    workspaceId,
    "presence:updated",
    presence
  );

  socket.on(
    "workspace:join",
    (payload = {}, acknowledge) => {
      try {
        if (
          payload.workspaceId &&
          payload.workspaceId !==
            workspaceId
        ) {
          throw Object.assign(
            new Error(
              "You cannot join another workspace."
            ),
            {
              statusCode: 403,
            }
          );
        }

        socket.join(
          workspaceRoom(
            workspaceId
          )
        );

        acknowledge?.({
          ok: true,
          data: {
            workspaceId,
          },
        });
      } catch (error) {
        acknowledge?.({
          ok: false,
          error:
            error.message,
        });
      }
    }
  );

  socket.on(
    "chat:conversation:join",
    (payload = {}, acknowledge) => {
      try {
        const channelId =
          String(
            payload.conversationId ||
              payload.channelId ||
              ""
          );

        teamCommunicationService.listMessages(
          user,
          channelId,
          {
            limit: 1,
          }
        );

        socket.join(
          channelRoom(
            channelId
          )
        );

        acknowledge?.({
          ok: true,
          data: {
            channelId,
          },
        });
      } catch (error) {
        acknowledge?.({
          ok: false,
          error:
            error.message,
        });
      }
    }
  );

  socket.on(
    "chat:conversation:leave",
    (payload = {}) => {
      const channelId =
        String(
          payload.conversationId ||
            payload.channelId ||
            ""
        );

      if (channelId) {
        socket.leave(
          channelRoom(
            channelId
          )
        );
      }
    }
  );

  socket.on(
    "chat:typing",
    (payload = {}) => {
      const channelId =
        String(
          payload.conversationId ||
            payload.channelId ||
            ""
        );

      if (!channelId) {
        return;
      }

      try {
        teamCommunicationService.listMessages(
          user,
          channelId,
          {
            limit: 1,
          }
        );

        socket
          .to(
            channelRoom(
              channelId
            )
          )
          .emit(
            "chat:typing",
            {
              channelId,
              conversationId:
                channelId,
              userId:
                user.id,
              name:
                user.name ||
                user.email,
              typing:
                Boolean(
                  payload.typing
                ),
            }
          );
      } catch {
        // Ignore unauthorized typing events.
      }
    }
  );

  socket.on(
    "internal-call:signal",
    (payload = {}) => {
      const targetUserId =
        String(
          payload.targetUserId ||
            ""
        );

      if (!targetUserId) {
        return;
      }

      emitToUser(
        targetUserId,
        "internal-call:signal",
        {
          fromUserId:
            user.id,

          fromUserName:
            user.name ||
            user.email,

          callId:
            payload.callId,

          type:
            payload.type,

          signal:
            payload.signal,
        }
      );
    }
  );

  socket.on(
    "presence:update",
    (payload = {}, acknowledge) => {
      try {
        const updated =
          teamCommunicationService.updatePresence(
            user,
            payload.status
          );

        emitToWorkspace(
          workspaceId,
          "presence:updated",
          updated
        );

        acknowledge?.({
          ok: true,
          data:
            updated,
        });
      } catch (error) {
        acknowledge?.({
          ok: false,
          error:
            error.message,
        });
      }
    }
  );

  socket.on("disconnect", () => {
    const offline =
      teamCommunicationService.updatePresence(
        user,
        "offline"
      );

    emitToWorkspace(
      workspaceId,
      "presence:updated",
      offline
    );
  });
});

httpServer.requestTimeout =
  API_REQUEST_TIMEOUT_MS + 5_000;

httpServer.headersTimeout =
  API_REQUEST_TIMEOUT_MS + 10_000;

httpServer.keepAliveTimeout = 5_000;

httpServer.on("error", (error) => {
  console.error(
    `[startup] server-error ${JSON.stringify({
      at: new Date().toISOString(),
      code:
        error?.code || "",
      message:
        error?.message ||
        String(error),
      stack:
        error?.stack || "",
    })}`
  );
});



process.once("SIGINT", () => {
  stopDailyLeadScheduler();
});

process.once("SIGTERM", () => {
  stopDailyLeadScheduler();
});
