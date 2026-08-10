import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANAGER_ROLES = new Set([
  "owner",
  "admin",
  "manager",
]);

const REPORT_KINDS = [
  "website",
  "gmb",
  "mini",
  "competitor",
  "full",
];

const DEFAULT_TEMPLATES = {
  website: {
    name: "Website / Technology Audit",
    enabled: true,
    lengthGuidance: "1-3 pages; caller-ready website and technology pre-call audit",
    instructions:
      "Generate a factual Website / Technology Audit for the current lead only. Focus on publicly verifiable website, technical, conversion, trust, SEO, usability, and visible technology observations. Include evidence, plain-language business impact, controlled sales wording, and a safe next step. Never copy facts from the manager PDF example; use it only as a format and presentation reference.",
  },
  gmb: {
    name: "GMB / Local Visibility Audit",
    enabled: true,
    lengthGuidance: "1-3 pages; caller-ready Google Business Profile and local visibility audit",
    instructions:
      "Generate a factual GMB / Local Visibility Audit for the current lead only. Research the business's public Google Business Profile and local-search presence, NAP consistency, reviews, profile completeness, category/positioning, conversion paths, and visible local competitors. Include evidence, plain-language business impact, controlled sales wording, and a safe next step. Never copy facts from the manager PDF example; use it only as a format and presentation reference.",
  },
  mini: {
    name: "Mini Audit",
    enabled: true,
    lengthGuidance: "1-2 pages; concise pre-call intelligence",
    instructions:
      "Keep the Mini Audit concise, factual, easy for a caller to scan before dialing, and focused on verified business-impact issues. Preserve the approved business snapshot and issue-first structure. Do not include recommendations in the Mini Audit.",
  },
  competitor: {
    name: "Competitor Analysis",
    enabled: true,
    lengthGuidance: "2-4 pages; concise market comparison",
    instructions:
      "Compare only real, verifiable competitors in the same market. Focus on local-search visibility, website conversion, trust signals, reviews, positioning, and observable advantages. Keep claims evidence-grounded and useful for a sales conversation.",
  },
  full: {
    name: "Full Audit",
    enabled: true,
    lengthGuidance: "4-8 pages; detailed evidence-grounded audit",
    instructions:
      "Produce a mature, detailed audit covering technical observations, SEO and local visibility, conversion and trust, content, competitors, business impact, and a prioritized roadmap. Recommendations are allowed in the Full Audit.",
  },
};

const DEFAULT_MANAGER_SYSTEM_PROMPT =
  "Write in a mature, professional, commercially useful tone. Keep the approved report structure consistent across leads. Prefer concise evidence and clear business impact over generic marketing language. Never weaken ReachFly's fixed factual-verification rules.";

export function createAuditTemplateService({
  store,
  workspaceService,
  dataDir = "",
  legacyTemplateProvider = null,
  emit = null,
} = {}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createAuditTemplateService requires a store exposing read() and update()."
    );
  }

  const templateDirectory = path.resolve(
    dataDir || process.cwd(),
    "audit-template-examples"
  );

  fs.mkdirSync(templateDirectory, {
    recursive: true,
  });

  function getContext(user) {
    const context =
      workspaceService?.getContext?.(
        user,
        store.read()
      ) || {
        user,
        workspaceId:
          user?.workspaceId ||
          user?.id ||
          "",
        role:
          user?.workspaceRole ||
          user?.role ||
          "caller",
      };

    return {
      ...context,
      workspaceId: clean(
        context.workspaceId ||
          user?.workspaceId ||
          user?.id
      ),
      role: normalizeRole(
        context.role ||
          user?.workspaceRole ||
          user?.role
      ),
    };
  }

  function requireManager(user) {
    const context = getContext(user);

    if (
      !context.workspaceId ||
      !MANAGER_ROLES.has(context.role)
    ) {
      throw httpError(
        403,
        "Manager access is required."
      );
    }

    return context;
  }

  function getStudio(user) {
    const context = requireManager(user);
    const state = store.read();
    const studio = getStudioSettings(
      state,
      context.workspaceId
    );

    return {
      ok: true,
      workspaceId: context.workspaceId,
      managerSystemPrompt:
        studio.managerSystemPrompt ||
        DEFAULT_MANAGER_SYSTEM_PROMPT,
      updatedAt:
        studio.updatedAt || "",
      templates: Object.fromEntries(
        REPORT_KINDS.map((kind) => [
          kind,
          buildStudioTemplate(
            state,
            context.workspaceId,
            kind,
            user
          ),
        ])
      ),
    };
  }

  function saveStudioSettings(
    user,
    input = {}
  ) {
    const context = requireManager(user);
    const now = new Date().toISOString();
    const managerSystemPrompt = cleanMultiline(
      input.managerSystemPrompt ||
        DEFAULT_MANAGER_SYSTEM_PROMPT
    ).slice(0, 12000);

    store.update((draft) => {
      ensureState(draft);
      const settings = ensureStudioSettings(
        draft,
        context.workspaceId
      );

      settings.managerSystemPrompt =
        managerSystemPrompt;
      settings.updatedBy = user.id;
      settings.updatedAt = now;
    });

    emitStudioEvent(
      context.workspaceId,
      "audit-studio:updated",
      {
        updatedBy: user.id,
        updatedAt: now,
      }
    );

    return getStudio(user);
  }

  function saveTemplate(
    user,
    kindInput,
    input = {}
  ) {
    const context = requireManager(user);
    const kind = normalizeKind(kindInput);
    const state = store.read();
    const active = getActiveVersionRecord(
      state,
      context.workspaceId,
      kind
    );
    const legacy = active
      ? null
      : getLegacyTemplate(user);
    const defaults = DEFAULT_TEMPLATES[kind];
    const now = new Date().toISOString();
    const version =
      getNextVersionNumber(
        state,
        context.workspaceId,
        kind
      );

    const record = {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      kind,
      version,
      name: clean(
        input.name ??
          active?.name ??
          legacyName(legacy, kind) ??
          defaults.name
      ).slice(0, 160),
      enabled:
        input.enabled !== undefined
          ? parseBoolean(
              input.enabled,
              active?.enabled !== false
            )
          : active?.enabled !== false,
      lengthGuidance: clean(
        input.lengthGuidance ??
          active?.lengthGuidance ??
          defaults.lengthGuidance
      ).slice(0, 500),
      instructions: cleanMultiline(
        input.instructions ??
          active?.instructions ??
          legacyInstructions(
            legacy,
            kind
          ) ??
          defaults.instructions
      ).slice(0, 24000),
      examplePdf:
        input.examplePdf !== undefined
          ? normalizeStoredPdf(
              input.examplePdf
            )
          : clonePdf(active?.examplePdf),
      restoredFromVersion:
        Number(
          input.restoredFromVersion ||
            0
        ) || 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      ensureState(draft);
      draft.auditTemplateVersions.unshift(
        record
      );

      const settings = ensureStudioSettings(
        draft,
        context.workspaceId
      );
      settings.activeVersionByKind =
        settings.activeVersionByKind || {};
      settings.activeVersionByKind[kind] =
        record.id;
      settings.updatedBy = user.id;
      settings.updatedAt = now;
    });

    emitStudioEvent(
      context.workspaceId,
      "audit-studio:template-updated",
      {
        kind,
        version,
        templateId: record.id,
        updatedBy: user.id,
        updatedAt: now,
      }
    );

    return {
      ok: true,
      template: publicTemplate(record),
      studio: getStudio(user),
    };
  }

  function attachExamplePdf(
    user,
    kindInput,
    file = {},
    input = {}
  ) {
    const context = requireManager(user);
    const kind = normalizeKind(kindInput);

    const storedPath = path.resolve(
      clean(file.path)
    );

    if (
      !storedPath ||
      !fs.existsSync(storedPath)
    ) {
      throw httpError(
        400,
        "Uploaded PDF file was not found."
      );
    }

    const mimeType = clean(
      file.mimetype ||
        "application/pdf"
    ).toLowerCase();

    if (
      mimeType !== "application/pdf"
    ) {
      throw httpError(
        415,
        "Only PDF example reports are supported."
      );
    }

    const size = Number(
      file.size ||
        fs.statSync(storedPath).size ||
        0
    );

    if (
      size <= 0 ||
      size > 15 * 1024 * 1024
    ) {
      throw httpError(
        413,
        "Example PDF must be between 1 byte and 15 MB."
      );
    }

    const active = getActiveTemplateForAudit(
      user,
      kind
    );

    const examplePdf = {
      id: crypto.randomUUID(),
      originalName: clean(
        file.originalname ||
          `${kind}-example.pdf`
      ).slice(0, 240),
      storedName: clean(
        file.filename ||
          path.basename(storedPath)
      ),
      storagePath: storedPath,
      mimeType:
        "application/pdf",
      size,
      uploadedBy: user.id,
      uploadedAt:
        new Date().toISOString(),
    };

    return saveTemplate(
      user,
      kind,
      {
        name:
          input.name ??
          active.name,
        enabled:
          input.enabled !== undefined
            ? parseBoolean(
                input.enabled,
                active.enabled !== false
              )
            : active.enabled,
        lengthGuidance:
          input.lengthGuidance ??
          active.lengthGuidance,
        instructions:
          input.instructions ??
          active.instructions,
        examplePdf,
      }
    );
  }

  function restoreVersion(
    user,
    kindInput,
    versionInput
  ) {
    const context = requireManager(user);
    const kind = normalizeKind(kindInput);
    const version = Number(versionInput);

    const source = (
      store.read().auditTemplateVersions ||
      []
    ).find(
      (item) =>
        item.workspaceId ===
          context.workspaceId &&
        item.kind === kind &&
        Number(item.version) === version
    );

    if (!source) {
      throw httpError(
        404,
        "Audit template version was not found."
      );
    }

    return saveTemplate(
      user,
      kind,
      {
        name: source.name,
        enabled:
          source.enabled !== false,
        lengthGuidance:
          source.lengthGuidance,
        instructions:
          source.instructions,
        examplePdf:
          clonePdf(source.examplePdf),
        restoredFromVersion:
          source.version,
      }
    );
  }

  function getExampleFile(
    user,
    kindInput
  ) {
    requireManager(user);
    const template =
      getActiveTemplateForAudit(
        user,
        kindInput
      );
    const example =
      template.examplePdf;

    if (
      !example?.storagePath ||
      !fs.existsSync(
        example.storagePath
      )
    ) {
      throw httpError(
        404,
        "No example PDF is configured for this report type."
      );
    }

    return {
      path:
        example.storagePath,
      filename:
        example.originalName ||
        `${template.kind}-example.pdf`,
      mimeType:
        "application/pdf",
      size:
        Number(example.size || 0),
    };
  }

  function getActiveTemplateForAudit(
    user,
    kindInput
  ) {
    const context = getContext(user);

    if (!context.workspaceId) {
      throw httpError(
        400,
        "Workspace context is required."
      );
    }

    const kind = normalizeKind(kindInput);
    const state = store.read();
    const active = getActiveVersionRecord(
      state,
      context.workspaceId,
      kind
    );
    const studio = getStudioSettings(
      state,
      context.workspaceId
    );
    const legacy = active
      ? null
      : getLegacyTemplate(user);
    const defaults = DEFAULT_TEMPLATES[kind];

    if (active) {
      return {
        templateId: active.id,
        version:
          Number(active.version) || 1,
        kind,
        name:
          active.name ||
          defaults.name,
        enabled:
          active.enabled !== false,
        lengthGuidance:
          active.lengthGuidance ||
          defaults.lengthGuidance,
        instructions:
          active.instructions ||
          defaults.instructions,
        managerSystemPrompt:
          studio.managerSystemPrompt ||
          DEFAULT_MANAGER_SYSTEM_PROMPT,
        examplePdf:
          clonePdf(active.examplePdf),
      };
    }

    return {
      templateId:
        "legacy-default",
      version: 0,
      kind,
      name:
        legacyName(legacy, kind) ||
        defaults.name,
      enabled:
        legacyEnabled(
          legacy,
          kind
        ),
      lengthGuidance:
        defaults.lengthGuidance,
      instructions:
        legacyInstructions(
          legacy,
          kind
        ) ||
        defaults.instructions,
      managerSystemPrompt:
        studio.managerSystemPrompt ||
        cleanMultiline(
          legacy?.claudeSystemPrompt ||
            ""
        ) ||
        DEFAULT_MANAGER_SYSTEM_PROMPT,
      examplePdf: null,
    };
  }

  function buildStudioTemplate(
    state,
    workspaceId,
    kind,
    user
  ) {
    const active = getActiveVersionRecord(
      state,
      workspaceId,
      kind
    );
    const defaults = DEFAULT_TEMPLATES[kind];
    const legacy = active
      ? null
      : getLegacyTemplate(user);

    const activePublic = active
      ? publicTemplate(active)
      : {
          id: "legacy-default",
          kind,
          version: 0,
          name:
            legacyName(
              legacy,
              kind
            ) || defaults.name,
          enabled:
            legacyEnabled(
              legacy,
              kind
            ),
          lengthGuidance:
            defaults.lengthGuidance,
          instructions:
            legacyInstructions(
              legacy,
              kind
            ) || defaults.instructions,
          examplePdf: null,
          createdAt: "",
          updatedAt: "",
        };

    const versions = (
      state.auditTemplateVersions ||
      []
    )
      .filter(
        (item) =>
          item.workspaceId ===
            workspaceId &&
          item.kind === kind
      )
      .sort(
        (left, right) =>
          Number(right.version) -
          Number(left.version)
      )
      .slice(0, 20)
      .map(publicTemplate);

    return {
      kind,
      active: activePublic,
      versions,
    };
  }

  function getLegacyTemplate(user) {
    if (
      typeof legacyTemplateProvider !==
      "function"
    ) {
      return null;
    }

    try {
      return (
        legacyTemplateProvider(user) ||
        null
      );
    } catch {
      return null;
    }
  }

  function getActiveVersionRecord(
    state,
    workspaceId,
    kind
  ) {
    const settings =
      getStudioSettings(
        state,
        workspaceId
      );
    const activeId =
      settings.activeVersionByKind?.[
        kind
      ];

    if (activeId) {
      const found = (
        state.auditTemplateVersions ||
        []
      ).find(
        (item) =>
          item.id === activeId &&
          item.workspaceId ===
            workspaceId &&
          item.kind === kind
      );

      if (found) return found;
    }

    return (
      state.auditTemplateVersions ||
      []
    )
      .filter(
        (item) =>
          item.workspaceId ===
            workspaceId &&
          item.kind === kind
      )
      .sort(
        (left, right) =>
          Number(right.version) -
          Number(left.version)
      )[0] || null;
  }

  function getNextVersionNumber(
    state,
    workspaceId,
    kind
  ) {
    const versions = (
      state.auditTemplateVersions ||
      []
    )
      .filter(
        (item) =>
          item.workspaceId ===
            workspaceId &&
          item.kind === kind
      )
      .map(
        (item) =>
          Number(item.version) || 0
      );

    return (
      Math.max(0, ...versions) + 1
    );
  }

  function getStudioSettings(
    state,
    workspaceId
  ) {
    return (
      state.workspaceSettings?.[
        workspaceId
      ]?.auditStudio || {}
    );
  }

  function ensureStudioSettings(
    draft,
    workspaceId
  ) {
    draft.workspaceSettings[
      workspaceId
    ] =
      draft.workspaceSettings[
        workspaceId
      ] || {};

    draft.workspaceSettings[
      workspaceId
    ].auditStudio =
      draft.workspaceSettings[
        workspaceId
      ].auditStudio || {
        managerSystemPrompt:
          DEFAULT_MANAGER_SYSTEM_PROMPT,
        activeVersionByKind: {},
      };

    return draft.workspaceSettings[
      workspaceId
    ].auditStudio;
  }

  function ensureState(draft) {
    if (
      !draft.workspaceSettings ||
      typeof draft.workspaceSettings !==
        "object" ||
      Array.isArray(
        draft.workspaceSettings
      )
    ) {
      draft.workspaceSettings = {};
    }

    if (
      !Array.isArray(
        draft.auditTemplateVersions
      )
    ) {
      draft.auditTemplateVersions = [];
    }
  }

  function emitStudioEvent(
    workspaceId,
    event,
    payload
  ) {
    if (
      typeof emit !== "function"
    ) {
      return;
    }

    try {
      emit({
        workspaceId,
        event,
        payload,
      });
    } catch {
      // Audit Studio persistence must not fail because a realtime client disconnected.
    }
  }

  return {
    getStudio,
    saveStudioSettings,
    saveTemplate,
    attachExamplePdf,
    restoreVersion,
    getExampleFile,
    getActiveTemplateForAudit,
    templateDirectory,
    reportKinds: [
      ...REPORT_KINDS,
    ],
  };
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(
    value ?? ""
  )
    .trim()
    .toLowerCase();

  if (!normalized) return fallback;

  if ([
    "1",
    "true",
    "yes",
    "on",
    "enabled",
  ].includes(normalized)) {
    return true;
  }

  if ([
    "0",
    "false",
    "no",
    "off",
    "disabled",
  ].includes(normalized)) {
    return false;
  }

  return fallback;
}

function publicTemplate(record) {
  if (!record) return null;

  return {
    id: record.id,
    kind: record.kind,
    version:
      Number(record.version) || 0,
    name: record.name || "",
    enabled:
      record.enabled !== false,
    lengthGuidance:
      record.lengthGuidance || "",
    instructions:
      record.instructions || "",
    examplePdf: record.examplePdf
      ? {
          id:
            record.examplePdf.id || "",
          originalName:
            record.examplePdf.originalName ||
            "example.pdf",
          mimeType:
            "application/pdf",
          size:
            Number(
              record.examplePdf.size || 0
            ),
          uploadedAt:
            record.examplePdf.uploadedAt ||
            "",
          uploadedBy:
            record.examplePdf.uploadedBy ||
            "",
        }
      : null,
    restoredFromVersion:
      Number(
        record.restoredFromVersion || 0
      ) || 0,
    createdBy:
      record.createdBy || "",
    createdAt:
      record.createdAt || "",
    updatedAt:
      record.updatedAt || "",
  };
}

function normalizeStoredPdf(value) {
  if (!value) return null;

  return {
    id:
      clean(value.id) ||
      crypto.randomUUID(),
    originalName:
      clean(value.originalName ||
        "example.pdf"),
    storedName:
      clean(value.storedName || ""),
    storagePath:
      clean(value.storagePath || ""),
    mimeType:
      "application/pdf",
    size:
      Number(value.size || 0),
    uploadedBy:
      clean(value.uploadedBy || ""),
    uploadedAt:
      clean(value.uploadedAt || ""),
  };
}

function clonePdf(value) {
  return value
    ? normalizeStoredPdf(value)
    : null;
}

function normalizeKind(value) {
  const normalized = String(
    value || ""
  )
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

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
    competitor_analysis:
      "competitor",
    full: "full",
    full_audit: "full",
  };

  const kind = aliases[normalized];

  if (!kind) {
    throw httpError(
      400,
      "Report type must be website, gmb, mini, competitor, or full."
    );
  }

  return kind;
}

function legacyName(
  legacy,
  kind
) {
  if (!legacy) return "";
  if (["website", "gmb"].includes(kind)) return undefined;

  if (
    legacy.name &&
    kind === "mini"
  ) {
    return clean(legacy.name);
  }

  return "";
}

function legacyInstructions(
  legacy,
  kind
) {
  if (!legacy) return "";
  if (["website", "gmb"].includes(kind)) return undefined;

  if (kind === "mini") {
    return cleanMultiline(
      legacy.miniInstructions
    );
  }

  if (
    kind === "competitor"
  ) {
    return cleanMultiline(
      legacy.competitorInstructions
    );
  }

  return cleanMultiline(
    legacy.fullInstructions
  );
}

function legacyEnabled(
  legacy,
  kind
) {
  if (!legacy) return true;

  if (kind === "mini") {
    return legacy.miniEnabled !== false;
  }

  if (
    kind === "competitor"
  ) {
    return (
      legacy.competitorEnabled !==
      false
    );
  }

  return legacy.fullEnabled !== false;
}

function normalizeRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMultiline(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) =>
      line.replace(/[\t ]+/g, " ").trimEnd()
    )
    .join("\n")
    .trim();
}

function httpError(
  statusCode,
  message
) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  return error;
}
