import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_AVATAR_BYTES = Number(
  process.env.PROFILE_MAX_AVATAR_BYTES || 3 * 1024 * 1024
);

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const ALLOWED_AVAILABILITY = new Set([
  "available",
  "busy",
  "away",
  "offline",
]);

export function createProfileService({
  store,
  workspaceService = null,
  socketService = null,
  dataDir = "./data",
}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createProfileService requires a store exposing read() and update()."
    );
  }

  const avatarRoot = path.resolve(
    dataDir,
    "profile-private"
  );

  fs.mkdirSync(avatarRoot, {
    recursive: true,
  });

  initialize();

  return {
    getMyProfile,
    updateMyProfile,
    updateAvailability,
    updateNotificationPreferences,
    uploadAvatar,
    removeAvatar,
    getAvatar,
    changePassword,
    listWorkspaceProfiles,
    getMemberProfile,
    updateManagedProfile,
    registerRoutes,
  };

  function registerRoutes({
    app,
    authenticate,
    asyncRoute = defaultAsyncRoute,
  }) {
    app.get(
      "/api/profile/me",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          profile: getMyProfile(req.user),
        });
      })
    );

    app.patch(
      "/api/profile/me",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          profile: updateMyProfile(
            req.user,
            req.body || {}
          ),
        });
      })
    );

    app.patch(
      "/api/profile/me/availability",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          profile: updateAvailability(
            req.user,
            req.body || {}
          ),
        });
      })
    );

    app.patch(
      "/api/profile/me/notifications",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          profile:
            updateNotificationPreferences(
              req.user,
              req.body || {}
            ),
        });
      })
    );

    app.post(
      "/api/profile/me/avatar",
      authenticate,
      asyncRoute(async (req, res) => {
        res.status(201).json({
          ok: true,
          profile: uploadAvatar(
            req.user,
            req.body || {}
          ),
        });
      })
    );

    app.delete(
      "/api/profile/me/avatar",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          profile: removeAvatar(req.user),
        });
      })
    );

    app.get(
      "/api/profile/avatar/:userId",
      authenticate,
      asyncRoute(async (req, res) => {
        const avatar = getAvatar(
          req.user,
          req.params.userId
        );

        res.setHeader(
          "Content-Type",
          avatar.mimeType
        );

        res.setHeader(
          "Content-Length",
          String(avatar.buffer.length)
        );

        res.setHeader(
          "Cache-Control",
          "private, max-age=300"
        );

        res.end(avatar.buffer);
      })
    );

    app.post(
      "/api/profile/me/password",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          ...changePassword(
            req.user,
            req.body || {}
          ),
        });
      })
    );

    app.get(
      "/api/profile/members",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          members: listWorkspaceProfiles(
            req.user
          ),
        });
      })
    );

    app.get(
      "/api/profile/members/:userId",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          profile: getMemberProfile(
            req.user,
            req.params.userId
          ),
        });
      })
    );

    app.patch(
      "/api/profile/members/:userId",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          profile: updateManagedProfile(
            req.user,
            req.params.userId,
            req.body || {}
          ),
        });
      })
    );
  }

  function getMyProfile(user) {
    const context = getContext(user);
    const member = requireMember(
      store.read(),
      context.workspaceId,
      context.user.id
    );

    return publicProfile(member, true);
  }

  function updateMyProfile(user, input = {}) {
    const context = getContext(user);
    let updated = null;

    store.update((draft) => {
      const member = findMember(
        draft,
        context.workspaceId,
        context.user.id
      );

      if (!member) return;

      if (input.name !== undefined) {
        const name = clean(input.name).slice(
          0,
          120
        );

        if (!name) {
          throw createError(
            400,
            "Full name is required."
          );
        }

        member.name = name;
      }

      if (input.phone !== undefined) {
        member.phone = normalizePhone(
          input.phone
        );
      }

      if (input.jobTitle !== undefined) {
        member.jobTitle = clean(
          input.jobTitle
        ).slice(0, 120);
      }

      if (input.bio !== undefined) {
        member.bio = clean(input.bio).slice(
          0,
          1_000
        );
      }

      if (input.timezone !== undefined) {
        member.timezone = validateTimezone(
          input.timezone
        );
      }

      if (input.language !== undefined) {
        member.language = clean(
          input.language
        )
          .toLowerCase()
          .slice(0, 12);
      }

      member.updatedAt = now();
      updated = publicProfile(member, true);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "profile_updated",
        entityId: member.id,
      });
    });

    if (!updated) {
      throw createError(
        404,
        "Profile not found."
      );
    }

    emitProfile(context.workspaceId, updated);

    return updated;
  }

  function updateAvailability(user, input = {}) {
    const context = getContext(user);
    const status = clean(
      input.availabilityStatus
    ).toLowerCase();

    if (!ALLOWED_AVAILABILITY.has(status)) {
      throw createError(
        400,
        "Invalid availability status."
      );
    }

    let updated = null;

    store.update((draft) => {
      const member = findMember(
        draft,
        context.workspaceId,
        context.user.id
      );

      if (!member) return;

      member.availabilityStatus = status;
      member.availabilityNote = clean(
        input.note
      ).slice(0, 240);
      member.updatedAt = now();

      updated = publicProfile(member, true);
    });

    if (!updated) {
      throw createError(
        404,
        "Profile not found."
      );
    }

    socketService?.emitToWorkspace?.({
      workspaceId: context.workspaceId,
      event: "profile:availability-updated",
      payload: {
        userId: context.user.id,
        availabilityStatus: status,
        availabilityNote:
          updated.availabilityNote,
      },
    });

    return updated;
  }

  function updateNotificationPreferences(
    user,
    input = {}
  ) {
    const context = getContext(user);
    let updated = null;

    store.update((draft) => {
      const member = findMember(
        draft,
        context.workspaceId,
        context.user.id
      );

      if (!member) return;

      member.notificationPreferences =
        sanitizeNotificationPreferences({
          ...defaultNotificationPreferences(),
          ...(member.notificationPreferences ||
            {}),
          ...input,
        });

      member.updatedAt = now();
      updated = publicProfile(member, true);
    });

    if (!updated) {
      throw createError(
        404,
        "Profile not found."
      );
    }

    return updated;
  }

  function uploadAvatar(user, input = {}) {
    const context = getContext(user);
    const image = decodeImage(input);

    validateImage(
      image.buffer,
      image.mimeType
    );

    const directory = path.join(
      avatarRoot,
      safeSegment(context.workspaceId),
      safeSegment(context.user.id)
    );

    fs.mkdirSync(directory, {
      recursive: true,
    });

    const filename = `avatar-${Date.now()}-${crypto
      .randomBytes(8)
      .toString("hex")}.${extensionForMime(
      image.mimeType
    )}`;

    const absolutePath = path.join(
      directory,
      filename
    );

    fs.writeFileSync(
      absolutePath,
      image.buffer,
      {
        flag: "wx",
        mode: 0o600,
      }
    );

    const relativePath = path.relative(
      avatarRoot,
      absolutePath
    );

    let previousPath = "";
    let updated = null;

    store.update((draft) => {
      const member = findMember(
        draft,
        context.workspaceId,
        context.user.id
      );

      if (!member) return;

      previousPath =
        member.avatarPrivatePath || "";

      member.avatarPrivatePath =
        relativePath;
      member.avatarMimeType =
        image.mimeType;
      member.avatarSize =
        image.buffer.length;
      member.avatarUrl = `/api/profile/avatar/${member.id}`;
      member.avatarUpdatedAt = now();
      member.updatedAt = now();

      updated = publicProfile(member, true);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "profile_avatar_updated",
        entityId: member.id,
      });
    });

    if (!updated) {
      safeDelete(absolutePath);

      throw createError(
        404,
        "Profile not found."
      );
    }

    if (previousPath) {
      safeDelete(
        resolveAvatarPath(previousPath)
      );
    }

    emitProfile(context.workspaceId, updated);

    return updated;
  }

  function removeAvatar(user) {
    const context = getContext(user);
    let previousPath = "";
    let updated = null;

    store.update((draft) => {
      const member = findMember(
        draft,
        context.workspaceId,
        context.user.id
      );

      if (!member) return;

      previousPath =
        member.avatarPrivatePath || "";

      member.avatarPrivatePath = "";
      member.avatarMimeType = "";
      member.avatarSize = 0;
      member.avatarUrl = "";
      member.avatarUpdatedAt = now();
      member.updatedAt = now();

      updated = publicProfile(member, true);
    });

    if (!updated) {
      throw createError(
        404,
        "Profile not found."
      );
    }

    if (previousPath) {
      safeDelete(
        resolveAvatarPath(previousPath)
      );
    }

    emitProfile(context.workspaceId, updated);

    return updated;
  }

  function getAvatar(user, targetUserId) {
    const context = getContext(user);
    const member = requireMember(
      store.read(),
      context.workspaceId,
      targetUserId
    );

    if (!member.avatarPrivatePath) {
      throw createError(
        404,
        "Profile image not found."
      );
    }

    const absolutePath = resolveAvatarPath(
      member.avatarPrivatePath
    );

    if (!fs.existsSync(absolutePath)) {
      throw createError(
        404,
        "Profile image file is unavailable."
      );
    }

    return {
      buffer: fs.readFileSync(absolutePath),
      mimeType:
        member.avatarMimeType ||
        mimeFromExtension(absolutePath),
    };
  }

  function changePassword(user, input = {}) {
    const context = getContext(user);
    const currentPassword = String(
      input.currentPassword || ""
    );
    const newPassword = String(
      input.newPassword || ""
    );

    validatePassword(newPassword);

    let changed = false;

    store.update((draft) => {
      const member = findMember(
        draft,
        context.workspaceId,
        context.user.id
      );

      if (!member) return;

      if (
        !verifyPassword(
          currentPassword,
          member.passwordHash
        )
      ) {
        throw createError(
          401,
          "Current password is incorrect."
        );
      }

      member.passwordHash =
        hashPassword(newPassword);
      member.passwordChangedAt = now();
      member.sessionVersion =
        Number(member.sessionVersion || 0) +
        1;
      member.updatedAt = now();

      changed = true;

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "password_changed",
        entityId: member.id,
      });
    });

    if (!changed) {
      throw createError(
        404,
        "Profile not found."
      );
    }

    return {
      message:
        "Password changed successfully.",
      passwordChangedAt: now(),
    };
  }

  function listWorkspaceProfiles(user) {
    const context = getContext(user);
    const state = store.read();

    let members = (state.users || []).filter(
      (member) =>
        member.workspaceId ===
          context.workspaceId &&
        member.active !== false
    );

    if (context.role === "manager") {
      members = members.filter(
        (member) =>
          member.id === context.user.id ||
          member.managerId ===
            context.user.id
      );
    }

    return members
      .map((member) =>
        publicProfile(
          member,
          ["owner", "admin", "manager"].includes(
            context.role
          )
        )
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      );
  }

  function getMemberProfile(user, userId) {
    const context = getContext(user);
    const member = requireMember(
      store.read(),
      context.workspaceId,
      userId
    );

    if (
      context.role === "manager" &&
      member.id !== context.user.id &&
      member.managerId !== context.user.id
    ) {
      throw createError(
        403,
        "You cannot view this team member."
      );
    }

    const includePrivate =
      member.id === context.user.id ||
      ["owner", "admin", "manager"].includes(
        context.role
      );

    return publicProfile(
      member,
      includePrivate
    );
  }

  function updateManagedProfile(
    user,
    targetUserId,
    input = {}
  ) {
    const context = getContext(user);

    if (
      ![
        "owner",
        "admin",
        "manager",
      ].includes(context.role)
    ) {
      throw createError(
        403,
        "You cannot manage team profiles."
      );
    }

    let updated = null;

    store.update((draft) => {
      const member = findMember(
        draft,
        context.workspaceId,
        targetUserId
      );

      if (!member) return;

      if (
        context.role === "manager" &&
        member.id !== context.user.id &&
        member.managerId !==
          context.user.id
      ) {
        throw createError(
          403,
          "You can update only members assigned to you."
        );
      }

      if (input.jobTitle !== undefined) {
        member.jobTitle = clean(
          input.jobTitle
        ).slice(0, 120);
      }

      if (
        input.managerId !== undefined &&
        ["owner", "admin"].includes(
          context.role
        )
      ) {
        member.managerId = clean(
          input.managerId
        ).slice(0, 160);
      }

      if (
        input.active !== undefined &&
        ["owner", "admin"].includes(
          context.role
        )
      ) {
        if (member.id === context.user.id) {
          throw createError(
            400,
            "You cannot suspend your own account."
          );
        }

        member.active =
          input.active !== false;
      }

      if (
        input.workspaceRole !== undefined &&
        ["owner", "admin"].includes(
          context.role
        )
      ) {
        const role = normalizeRole(
          input.workspaceRole
        );

        if (
          member.workspaceRole === "owner" &&
          role !== "owner"
        ) {
          throw createError(
            400,
            "The workspace owner role cannot be changed here."
          );
        }

        member.workspaceRole = role;
        member.role = roleLabel(role);
      }

      if (
        input.permissions !== undefined &&
        ["owner", "admin"].includes(
          context.role
        )
      ) {
        member.permissions = [
          ...new Set(
            (Array.isArray(
              input.permissions
            )
              ? input.permissions
              : []
            )
              .map((item) =>
                clean(item).slice(0, 100)
              )
              .filter(Boolean)
          ),
        ];
      }

      member.updatedAt = now();
      updated = publicProfile(member, true);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "managed_profile_updated",
        entityId: member.id,
      });
    });

    if (!updated) {
      throw createError(
        404,
        "Workspace member not found."
      );
    }

    emitProfile(context.workspaceId, updated);

    return updated;
  }

  function initialize() {
    store.update((draft) => {
      draft.users = Array.isArray(
        draft.users
      )
        ? draft.users
        : [];

      draft.activity = Array.isArray(
        draft.activity
      )
        ? draft.activity
        : [];

      for (const member of draft.users) {
        member.notificationPreferences = {
          ...defaultNotificationPreferences(),
          ...(member.notificationPreferences ||
            {}),
        };

        member.availabilityStatus =
          member.availabilityStatus ||
          "available";

        member.timezone =
          member.timezone || "UTC";

        member.language =
          member.language || "en";
      }
    });
  }

  function getContext(user) {
    if (!user?.id) {
      throw createError(
        401,
        "Authentication is required."
      );
    }

    const context =
      workspaceService?.getContext?.(user) || {
        user,
        workspaceId:
          user.workspaceId || user.id,
        workspace: null,
        role: normalizeRole(
          user.workspaceRole ||
            user.role
        ),
      };

    if (!context.workspaceId) {
      throw createError(
        403,
        "The account is not connected to a workspace."
      );
    }

    return {
      ...context,
      user: context.user || user,
      role: normalizeRole(
        context.role ||
          user.workspaceRole ||
          user.role
      ),
    };
  }

  function emitProfile(
    workspaceId,
    profile
  ) {
    socketService?.emitToWorkspace?.({
      workspaceId,
      event: "profile:updated",
      payload: {
        profile,
      },
    });
  }

  function resolveAvatarPath(relativePath) {
    const absolutePath = path.resolve(
      avatarRoot,
      relativePath
    );

    const relative = path.relative(
      avatarRoot,
      absolutePath
    );

    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw createError(
        400,
        "Invalid profile image path."
      );
    }

    return absolutePath;
  }
}

function publicProfile(
  member,
  includePrivate = false
) {
  const profile = {
    id: member.id,
    name: member.name || "",
    email: member.email || "",
    phone: includePrivate
      ? member.phone || ""
      : "",

    role: normalizeRole(
      member.workspaceRole || member.role
    ),

    workspaceRole: normalizeRole(
      member.workspaceRole || member.role
    ),

    jobTitle: member.jobTitle || "",
    bio: member.bio || "",

    avatarUrl:
      member.avatarPrivatePath
        ? `/api/profile/avatar/${member.id}`
        : member.avatarUrl || "",

    availabilityStatus:
      member.availabilityStatus ||
      "available",

    availabilityNote:
      member.availabilityNote || "",

    timezone: member.timezone || "UTC",
    language: member.language || "en",

    managerId: member.managerId || "",
    active: member.active !== false,
    updatedAt: member.updatedAt || "",
  };

  if (includePrivate) {
    profile.notificationPreferences = {
      ...defaultNotificationPreferences(),
      ...(member.notificationPreferences ||
        {}),
    };

    profile.permissions = Array.isArray(
      member.permissions
    )
      ? member.permissions
      : [];
  }

  return profile;
}

function findMember(
  state,
  workspaceId,
  userId
) {
  return (state.users || []).find(
    (item) =>
      item.id === clean(userId) &&
      item.workspaceId === workspaceId
  );
}

function requireMember(
  state,
  workspaceId,
  userId
) {
  const member = findMember(
    state,
    workspaceId,
    userId
  );

  if (!member || member.active === false) {
    throw createError(
      404,
      "Workspace member not found."
    );
  }

  return member;
}

function decodeImage(input) {
  if (input.dataUrl) {
    const match = String(
      input.dataUrl
    ).match(
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i
    );

    if (!match) {
      throw createError(
        400,
        "Invalid profile image."
      );
    }

    return {
      mimeType: match[1].toLowerCase(),
      buffer: Buffer.from(
        match[2].replace(/\s+/g, ""),
        "base64"
      ),
    };
  }

  const mimeType = clean(
    input.mimeType
  ).toLowerCase();

  if (!input.base64 || !mimeType) {
    throw createError(
      400,
      "A profile image is required."
    );
  }

  return {
    mimeType,
    buffer: Buffer.from(
      String(input.base64).replace(
        /\s+/g,
        ""
      ),
      "base64"
    ),
  };
}

function validateImage(
  buffer,
  mimeType
) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 32
  ) {
    throw createError(
      400,
      "Invalid profile image."
    );
  }

  if (buffer.length > MAX_AVATAR_BYTES) {
    throw createError(
      413,
      "Profile image is too large."
    );
  }

  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw createError(
      415,
      "Only JPEG, PNG, and WebP profile images are supported."
    );
  }

  if (
    detectImageMime(buffer) !==
    mimeType
  ) {
    throw createError(
      400,
      "Profile image content does not match its declared type."
    );
  }
}

function detectImageMime(buffer) {
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer[0] === 0x89 &&
    buffer
      .subarray(1, 4)
      .toString("ascii") === "PNG"
  ) {
    return "image/png";
  }

  if (
    buffer
      .subarray(0, 4)
      .toString("ascii") === "RIFF" &&
    buffer
      .subarray(8, 12)
      .toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return "";
}

function validatePassword(password) {
  if (password.length < 10) {
    throw createError(
      400,
      "Password must contain at least 10 characters."
    );
  }

  if (
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/\d/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw createError(
      400,
      "Password must contain uppercase, lowercase, number, and special characters."
    );
  }
}

function hashPassword(
  password,
  salt = crypto
    .randomBytes(16)
    .toString("hex")
) {
  const hash = crypto
    .scryptSync(
      password,
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
    !String(stored).includes(":")
  ) {
    return false;
  }

  const [salt, hash] =
    String(stored).split(":");

  const currentHash = crypto
    .scryptSync(
      password,
      salt,
      64
    )
    .toString("hex");

  const current = Buffer.from(
    currentHash,
    "hex"
  );

  const original = Buffer.from(
    hash,
    "hex"
  );

  return (
    current.length === original.length &&
    crypto.timingSafeEqual(
      current,
      original
    )
  );
}

function validateTimezone(value) {
  const timezone = clean(value);

  try {
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: timezone || "UTC",
      }
    ).format(new Date());

    return timezone || "UTC";
  } catch {
    throw createError(
      400,
      "Invalid timezone."
    );
  }
}

function normalizePhone(value) {
  const phone = clean(value);

  if (!phone) return "";

  const digits = phone.replace(/\D/g, "");

  if (
    digits.length < 7 ||
    digits.length > 15
  ) {
    throw createError(
      400,
      "Invalid phone number."
    );
  }

  return phone.slice(0, 40);
}

function sanitizeNotificationPreferences(
  input
) {
  return {
    chatMessages:
      input.chatMessages !== false,
    directMessages:
      input.directMessages !== false,
    groupMessages:
      input.groupMessages !== false,
    internalCalls:
      input.internalCalls !== false,
    missedCalls:
      input.missedCalls !== false,
    taskAssignments:
      input.taskAssignments !== false,
    attendanceReminders:
      input.attendanceReminders !== false,
    leadAssignments:
      input.leadAssignments !== false,
    emailDigest:
      input.emailDigest === true,
    browserNotifications:
      input.browserNotifications !== false,
  };
}

function defaultNotificationPreferences() {
  return {
    chatMessages: true,
    directMessages: true,
    groupMessages: true,
    internalCalls: true,
    missedCalls: true,
    taskAssignments: true,
    attendanceReminders: true,
    leadAssignments: true,
    emailDigest: false,
    browserNotifications: true,
  };
}

function normalizeRole(value) {
  const role = clean(value).toLowerCase();

  if (
    [
      "owner",
      "admin",
      "manager",
      "caller",
      "viewer",
    ].includes(role)
  ) {
    return role;
  }

  if (role.includes("owner")) return "owner";
  if (role.includes("admin")) return "admin";
  if (role.includes("manager"))
    return "manager";
  if (role.includes("caller"))
    return "caller";

  return "viewer";
}

function roleLabel(role) {
  return (
    role.charAt(0).toUpperCase() +
    role.slice(1)
  );
}

function addActivity(
  draft,
  {
    workspaceId,
    userId,
    action,
    entityId,
  }
) {
  draft.activity = Array.isArray(
    draft.activity
  )
    ? draft.activity
    : [];

  draft.activity.unshift({
    id: crypto.randomUUID(),
    workspaceId,
    userId,
    type: action,
    action,
    entityType: "user",
    entityId,
    createdAt: now(),
  });
}

function safeDelete(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore stale-file cleanup errors.
  }
}

function extensionForMime(mimeType) {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  return "jpg";
}

function mimeFromExtension(filename) {
  const extension = path
    .extname(filename)
    .toLowerCase();

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return "image/jpeg";
}

function safeSegment(value) {
  return (
    clean(value)
      .replace(
        /[^a-zA-Z0-9_-]/g,
        "_"
      )
      .slice(0, 120) ||
    crypto
      .randomBytes(8)
      .toString("hex")
  );
}

function clean(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim();
}

function now() {
  return new Date().toISOString();
}

function createError(
  statusCode,
  message
) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function defaultAsyncRoute(handler) {
  return function profileAsyncRoute(
    req,
    res,
    next
  ) {
    Promise.resolve(
      handler(req, res, next)
    ).catch(next);
  };
}
