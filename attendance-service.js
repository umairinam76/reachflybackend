import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createAttendanceService({
  store,
  workspaceService,
  dataDir,
}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createAttendanceService requires a store exposing read() and update()."
    );
  }

  const selfieDirectory =
    path.resolve(
      dataDir,
      "attendance-selfies"
    );

  fs.mkdirSync(
    selfieDirectory,
    {
      recursive: true,
    }
  );

  function context(user) {
    return (
      workspaceService?.getContext?.(
        user,
        store.read()
      ) || {
        user,
        workspaceId:
          user.workspaceId ||
          user.id,
        role:
          user.workspaceRole ||
          user.role ||
          "caller",
        permissions:
          user.permissions ||
          [],
      }
    );
  }

  function today(user) {
    const ctx =
      context(user);

    const dateKey =
      getDateKey(
        new Date()
      );

    const record =
      (
        store.read()
          .attendanceRecords ||
        []
      ).find(
        (item) =>
          item.workspaceId ===
            ctx.workspaceId &&
          item.userId ===
            user.id &&
          item.dateKey ===
            dateKey
      ) || null;

    return {
      ok: true,
      attendance:
        publicAttendance(
          record
        ),
    };
  }

  function history(
    user,
    {
      limit = 60,
    } = {}
  ) {
    const ctx =
      context(user);

    return {
      ok: true,
      records:
        (
          store.read()
            .attendanceRecords ||
          []
        )
          .filter(
            (item) =>
              item.workspaceId ===
                ctx.workspaceId &&
              item.userId ===
                user.id
          )
          .sort(
            (left, right) =>
              Date.parse(
                right.createdAt ||
                  0
              ) -
              Date.parse(
                left.createdAt ||
                  0
              )
          )
          .slice(
            0,
            Math.min(
              365,
              Math.max(
                1,
                Number(
                  limit ||
                  60
                )
              )
            )
          )
          .map(
            publicAttendance
          ),
    };
  }

  function team(
    user,
    {
      dateKey = "",
    } = {}
  ) {
    const ctx =
      context(user);

    if (
      ![
        "owner",
        "admin",
        "manager",
      ].includes(
        normalizeRole(
          ctx.role
        )
      )
    ) {
      throw httpError(
        403,
        "Manager access is required."
      );
    }

    const requestedDate =
      clean(
        dateKey
      ) ||
      getDateKey(
        new Date()
      );

    const state =
      store.read();

    const members =
      (
        workspaceService
          ?.listMembers?.(
            user
          ) ||
        state.users ||
        []
      )
        .filter(
          (member) =>
            (
              member.workspaceId ||
              ctx.workspaceId
            ) ===
              ctx.workspaceId &&
            normalizeRole(
              member.workspaceRole ||
                member.role
            ) ===
              "caller"
        );

    const records =
      (
        state.attendanceRecords ||
        []
      ).filter(
        (item) =>
          item.workspaceId ===
            ctx.workspaceId &&
          item.dateKey ===
            requestedDate
      );

    return {
      ok: true,
      dateKey:
        requestedDate,
      members:
        members.map(
          (member) => {
            const record =
              records.find(
                (item) =>
                  item.userId ===
                  member.id
              ) ||
              null;

            return {
              id:
                member.id,
              name:
                member.name ||
                member.fullName ||
                member.email ||
                "Caller",
              email:
                member.email ||
                "",
              avatarUrl:
                member.avatarUrl ||
                member.photoUrl ||
                "",
              attendance:
                publicAttendance(
                  record
                ),
            };
          }
        ),
    };
  }

  function checkIn(
    user,
    input = {}
  ) {
    const ctx =
      context(user);

    requireCaller(
      ctx
    );

    const now =
      new Date();

    const dateKey =
      getDateKey(
        now
      );

    const state =
      store.read();

    const existing =
      (
        state.attendanceRecords ||
        []
      ).find(
        (item) =>
          item.workspaceId ===
            ctx.workspaceId &&
          item.userId ===
            user.id &&
          item.dateKey ===
            dateKey
      );

    if (
      existing?.checkInAt &&
      !existing?.checkOutAt
    ) {
      throw httpError(
        409,
        "You are already checked in."
      );
    }

    if (
      existing?.checkOutAt
    ) {
      throw httpError(
        409,
        "Today's shift has already been completed."
      );
    }

    const selfie =
      saveSelfie(
        input.selfieDataUrl,
        {
          workspaceId:
            ctx.workspaceId,
          userId:
            user.id,
          kind:
            "check-in",
        }
      );

    const record = {
      id:
        crypto.randomUUID(),
      workspaceId:
        ctx.workspaceId,
      userId:
        user.id,
      dateKey,
      status:
        "checked_in",
      checkInAt:
        now.toISOString(),
      checkOutAt:
        "",
      checkInSelfieUrl:
        selfie.url,
      checkOutSelfieUrl:
        "",
      checkInLocation:
        normalizeLocation(
          input.location
        ),
      checkOutLocation:
        null,
      durationSeconds:
        0,
      createdAt:
        now.toISOString(),
      updatedAt:
        now.toISOString(),
    };

    store.update(
      (draft) => {
        draft.attendanceRecords =
          Array.isArray(
            draft.attendanceRecords
          )
            ? draft.attendanceRecords
            : [];

        draft.attendanceRecords.unshift(
          record
        );
      }
    );

    return {
      ok: true,
      attendance:
        publicAttendance(
          record
        ),
    };
  }

  function checkOut(
    user,
    input = {}
  ) {
    const ctx =
      context(user);

    requireCaller(
      ctx
    );

    const now =
      new Date();

    const dateKey =
      getDateKey(
        now
      );

    const selfie =
      saveSelfie(
        input.selfieDataUrl,
        {
          workspaceId:
            ctx.workspaceId,
          userId:
            user.id,
          kind:
            "check-out",
        }
      );

    let updated =
      null;

    store.update(
      (draft) => {
        draft.attendanceRecords =
          Array.isArray(
            draft.attendanceRecords
          )
            ? draft.attendanceRecords
            : [];

        const record =
          draft.attendanceRecords.find(
            (item) =>
              item.workspaceId ===
                ctx.workspaceId &&
              item.userId ===
                user.id &&
              item.dateKey ===
                dateKey
          );

        if (!record) {
          return;
        }

        if (
          record.checkOutAt
        ) {
          throw httpError(
            409,
            "You have already checked out."
          );
        }

        record.checkOutAt =
          now.toISOString();

        record.checkOutSelfieUrl =
          selfie.url;

        record.checkOutLocation =
          normalizeLocation(
            input.location
          );

        record.durationSeconds =
          Math.max(
            0,
            Math.round(
              (
                now.getTime() -
                Date.parse(
                  record.checkInAt
                )
              ) /
                1000
            )
          );

        record.status =
          "checked_out";

        record.updatedAt =
          now.toISOString();

        updated = {
          ...record,
        };
      }
    );

    if (!updated) {
      throw httpError(
        409,
        "Check in before checking out."
      );
    }

    return {
      ok: true,
      attendance:
        publicAttendance(
          updated
        ),
    };
  }

  function saveSelfie(
    dataUrl,
    {
      workspaceId,
      userId,
      kind,
    }
  ) {
    const value =
      clean(
        dataUrl
      );

    const match =
      value.match(
        /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/
      );

    if (!match) {
      throw httpError(
        400,
        "A live selfie image is required."
      );
    }

    const extension =
      match[1] ===
        "jpeg"
        ? "jpg"
        : match[1];

    const buffer =
      Buffer.from(
        match[2],
        "base64"
      );

    const maxBytes =
      Number(
        process.env
          .ATTENDANCE_SELFIE_MAX_BYTES ||
        3 * 1024 * 1024
      );

    if (
      buffer.length >
      maxBytes
    ) {
      throw httpError(
        413,
        "The attendance selfie is too large."
      );
    }

    const fileName = [
      sanitizeFilePart(
        workspaceId
      ),
      sanitizeFilePart(
        userId
      ),
      kind,
      Date.now(),
    ].join("-") +
      `.${extension}`;

    fs.writeFileSync(
      path.join(
        selfieDirectory,
        fileName
      ),
      buffer
    );

    return {
      fileName,
      url:
        `/attendance-selfies/${encodeURIComponent(
          fileName
        )}`,
    };
  }

  return {
    today,
    history,
    team,
    checkIn,
    checkOut,
    selfieDirectory,
  };
}

function requireCaller(
  ctx
) {
  if (
    normalizeRole(
      ctx.role
    ) !==
    "caller"
  ) {
    throw httpError(
      403,
      "Caller access is required."
    );
  }
}

function publicAttendance(
  record
) {
  if (!record) {
    return null;
  }

  const durationSeconds =
    record.checkOutAt
      ? Number(
          record.durationSeconds ||
            0
        )
      : record.checkInAt
        ? Math.max(
            0,
            Math.round(
              (
                Date.now() -
                Date.parse(
                  record.checkInAt
                )
              ) /
                1000
            )
          )
        : 0;

  return {
    ...record,
    durationSeconds,
  };
}

function normalizeLocation(
  value
) {
  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return null;
  }

  const latitude =
    Number(
      value.latitude
    );

  const longitude =
    Number(
      value.longitude
    );

  const accuracy =
    Number(
      value.accuracy ||
        0
    );

  if (
    !Number.isFinite(
      latitude
    ) ||
    !Number.isFinite(
      longitude
    )
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    accuracy:
      Number.isFinite(
        accuracy
      )
        ? accuracy
        : 0,
  };
}

function getDateKey(
  value
) {
  return new Date(
    value
  )
    .toISOString()
    .slice(
      0,
      10
    );
}

function normalizeRole(
  value
) {
  const role =
    clean(
      value
    )
      .toLowerCase()
      .replace(
        /\s+/g,
        "_"
      )
      .replace(
        /-/g,
        "_"
      );

  if (
    role.includes(
      "owner"
    )
  ) {
    return "owner";
  }

  if (
    role.includes(
      "admin"
    )
  ) {
    return "admin";
  }

  if (
    role.includes(
      "manager"
    )
  ) {
    return "manager";
  }

  if (
    role.includes(
      "caller"
    )
  ) {
    return "caller";
  }

  return role;
}

function sanitizeFilePart(
  value
) {
  return clean(
    value
  )
    .replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    )
    .slice(
      0,
      80
    ) ||
    "unknown";
}

function clean(
  value
) {
  return String(
    value ||
      ""
  ).trim();
}

function httpError(
  statusCode,
  message
) {
  const error =
    new Error(
      message
    );

  error.statusCode =
    statusCode;

  return error;
}
