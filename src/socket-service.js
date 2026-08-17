import crypto from "node:crypto";
import { Server } from "socket.io";

/**
 * ReachFly internal communication socket service.
 *
 * Features:
 * - Authenticated Socket.IO connections
 * - Workspace-isolated rooms
 * - Direct messaging
 * - Group/channel messaging
 * - Online presence and last-seen tracking
 * - Typing indicators
 * - Read receipts
 * - WebRTC signalling for internal audio/video calls
 * - Call history and participant tracking
 * - Server-authoritative timestamps
 * - Basic rate limiting
 *
 * The service expects the same token format used by ReachFly's API:
 *
 *   <base64url JSON body>.<HMAC SHA-256 signature>
 *
 * The token body is expected to contain:
 *
 *   {
 *     userId: "...",
 *     exp: 123456789
 *   }
 */
export function createSocketService({
  httpServer,
  store,
  authSecret,
  allowedOrigins = [],
  workspaceService = null,
  debug = false,
}) {
  if (!httpServer) {
    throw new Error(
      "createSocketService requires an HTTP server instance."
    );
  }

  if (!store?.read || !store?.update) {
    throw new Error(
      "createSocketService requires a store exposing read() and update()."
    );
  }

  const normalizedOrigins = new Set(
    allowedOrigins
      .map(normalizeOrigin)
      .filter(Boolean)
  );

  const io = new Server(httpServer, {
    path: "/socket.io",

    cors: {
      origin(origin, callback) {
        if (isAllowedOrigin(origin, normalizedOrigins)) {
          callback(null, true);
          return;
        }

        callback(
          new Error(
            `Socket origin is not allowed: ${origin || "unknown"}`
          )
        );
      },

      credentials: true,

      methods: [
        "GET",
        "POST",
      ],
    },

    transports: [
      "websocket",
      "polling",
    ],

    maxHttpBufferSize: Number(
      process.env.SOCKET_MAX_MESSAGE_BYTES ||
        1024 * 1024
    ),

    pingInterval: Number(
      process.env.SOCKET_PING_INTERVAL_MS ||
        25000
    ),

    pingTimeout: Number(
      process.env.SOCKET_PING_TIMEOUT_MS ||
        20000
    ),

    connectTimeout: Number(
      process.env.SOCKET_CONNECT_TIMEOUT_MS ||
        20000
    ),
  });

  const onlineUsers = new Map();
  const socketRateLimits = new Map();

  io.use(async (socket, next) => {
    try {
      const token = getSocketToken(socket);

      if (!token) {
        throw createError(
          401,
          "Authentication token is required."
        );
      }

      const payload = verifyToken(
        token,
        authSecret
      );

      if (!payload?.userId) {
        throw createError(
          401,
          "Authentication token is invalid."
        );
      }

      const state = store.read();

      const user = (state.users || []).find(
        (item) =>
          item.id === payload.userId
      );

      if (!user) {
        throw createError(
          401,
          "The authenticated account was not found."
        );
      }

      if (user.active === false) {
        throw createError(
          403,
          "This account is suspended."
        );
      }

      const context =
        workspaceService?.getContext?.(
          user,
          state
        ) || {
          user,
          workspaceId:
            user.workspaceId ||
            user.id,
          workspace: null,
          role:
            user.workspaceRole ||
            normalizeRole(user.role),
          permissions:
            user.permissions || [],
        };

      if (!context.workspaceId) {
        throw createError(
          403,
          "The account is not connected to a workspace."
        );
      }

      socket.data.user = publicUser(
        context.user || user
      );

      socket.data.workspaceId =
        context.workspaceId;

      socket.data.role =
        normalizeRole(
          context.role ||
            user.workspaceRole ||
            user.role
        );

      socket.data.permissions =
        Array.isArray(
          context.permissions
        )
          ? context.permissions
          : [];

      socket.data.authenticatedAt =
        new Date().toISOString();

      next();
    } catch (error) {
      log("authentication-failed", {
        socketId: socket.id,
        message:
          error?.message ||
          "Authentication failed",
      });

      next(
        new Error(
          error?.message ||
            "Socket authentication failed."
        )
      );
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    const workspaceId =
      socket.data.workspaceId;

    const workspaceRoom =
      getWorkspaceRoom(workspaceId);

    const userRoom = getUserRoom(
      workspaceId,
      user.id
    );

    socket.join(workspaceRoom);
    socket.join(userRoom);

    addOnlineSocket({
      onlineUsers,
      workspaceId,
      user,
      socketId: socket.id,
    });

    persistPresence({
      store,
      workspaceId,
      userId: user.id,
      status: "online",
      socketId: socket.id,
    });

    broadcastPresence(
      io,
      workspaceId,
      onlineUsers
    );

    socket.emit("socket:ready", {
      socketId: socket.id,
      connectedAt:
        new Date().toISOString(),
      user,
      workspaceId,
      onlineUsers:
        listOnlineUsers(
          onlineUsers,
          workspaceId
        ),
    });

    log("connected", {
      socketId: socket.id,
      workspaceId,
      userId: user.id,
      role: socket.data.role,
    });

    /*
     * Join all channels to which this user currently belongs.
     */
    joinUserChannels({
      socket,
      store,
      workspaceId,
      userId: user.id,
    });

    socket.on(
      "presence:list",
      withSocketHandler(
        socket,
        "presence:list",
        async () => {
          socket.emit(
            "presence:list",
            {
              users: listOnlineUsers(
                onlineUsers,
                workspaceId
              ),
              createdAt:
                new Date().toISOString(),
            }
          );
        }
      )
    );

    socket.on(
      "channel:join",
      withSocketHandler(
        socket,
        "channel:join",
        async (payload = {}) => {
          enforceRateLimit(
            socket,
            socketRateLimits,
            "channel:join",
            30,
            60000
          );

          const channel =
            requireChannelAccess({
              store,
              workspaceId,
              userId: user.id,
              channelId:
                payload.channelId,
            });

          socket.join(
            getChannelRoom(
              workspaceId,
              channel.id
            )
          );

          socket.emit(
            "channel:joined",
            {
              channelId: channel.id,
              joinedAt:
                new Date().toISOString(),
            }
          );
        }
      )
    );

    socket.on(
      "channel:leave",
      withSocketHandler(
        socket,
        "channel:leave",
        async (payload = {}) => {
          const channelId = cleanId(
            payload.channelId
          );

          if (!channelId) {
            throw createError(
              400,
              "Channel ID is required."
            );
          }

          socket.leave(
            getChannelRoom(
              workspaceId,
              channelId
            )
          );

          socket.emit(
            "channel:left",
            {
              channelId,
              leftAt:
                new Date().toISOString(),
            }
          );
        }
      )
    );

    socket.on(
      "message:send",
      withSocketHandler(
        socket,
        "message:send",
        async (payload = {}) => {
          enforceRateLimit(
            socket,
            socketRateLimits,
            "message:send",
            Number(
              process.env
                .SOCKET_MESSAGE_RATE_LIMIT ||
                60
            ),
            60000
          );

          const message =
            createMessage({
              store,
              workspaceId,
              sender: user,
              payload,
            });

          const event = {
            message,
            createdAt:
              new Date().toISOString(),
          };

          if (
            message.channelId
          ) {
            io.to(
              getChannelRoom(
                workspaceId,
                message.channelId
              )
            ).emit(
              "message:new",
              event
            );
          }

          if (
            message.recipientUserId
          ) {
            io.to(
              getUserRoom(
                workspaceId,
                message.recipientUserId
              )
            ).emit(
              "message:new",
              event
            );

            io.to(userRoom).emit(
              "message:new",
              event
            );
          }

          socket.emit(
            "message:sent",
            {
              clientMessageId:
                cleanText(
                  payload.clientMessageId
                ),
              message,
            }
          );
        }
      )
    );

    socket.on(
      "message:edit",
      withSocketHandler(
        socket,
        "message:edit",
        async (payload = {}) => {
          enforceRateLimit(
            socket,
            socketRateLimits,
            "message:edit",
            30,
            60000
          );

          const message =
            editMessage({
              store,
              workspaceId,
              user,
              messageId:
                payload.messageId,
              body: payload.body,
            });

          emitMessageUpdate({
            io,
            workspaceId,
            message,
            eventName:
              "message:updated",
          });
        }
      )
    );

    socket.on(
      "message:delete",
      withSocketHandler(
        socket,
        "message:delete",
        async (payload = {}) => {
          enforceRateLimit(
            socket,
            socketRateLimits,
            "message:delete",
            30,
            60000
          );

          const message =
            softDeleteMessage({
              store,
              workspaceId,
              user,
              role:
                socket.data.role,
              messageId:
                payload.messageId,
            });

          emitMessageUpdate({
            io,
            workspaceId,
            message,
            eventName:
              "message:deleted",
          });
        }
      )
    );

    socket.on(
      "message:read",
      withSocketHandler(
        socket,
        "message:read",
        async (payload = {}) => {
          const readReceipt =
            markMessageRead({
              store,
              workspaceId,
              userId: user.id,
              messageId:
                payload.messageId,
            });

          const message =
            getMessage({
              store,
              workspaceId,
              messageId:
                readReceipt.messageId,
            });

          if (
            message?.senderId
          ) {
            io.to(
              getUserRoom(
                workspaceId,
                message.senderId
              )
            ).emit(
              "message:read",
              readReceipt
            );
          }
        }
      )
    );

    socket.on(
      "typing:start",
      withSocketHandler(
        socket,
        "typing:start",
        async (payload = {}) => {
          emitTypingEvent({
            io,
            socket,
            store,
            workspaceId,
            user,
            payload,
            typing: true,
          });
        },
        {
          emitSuccess: false,
        }
      )
    );

    socket.on(
      "typing:stop",
      withSocketHandler(
        socket,
        "typing:stop",
        async (payload = {}) => {
          emitTypingEvent({
            io,
            socket,
            store,
            workspaceId,
            user,
            payload,
            typing: false,
          });
        },
        {
          emitSuccess: false,
        }
      )
    );

    /*
     * WebRTC signalling
     *
     * Socket.IO only carries signalling messages.
     * Audio/video media remains peer-to-peer through WebRTC.
     */
    socket.on(
      "webrtc:call:start",
      withSocketHandler(
        socket,
        "webrtc:call:start",
        async (payload = {}) => {
          enforceRateLimit(
            socket,
            socketRateLimits,
            "webrtc:call:start",
            20,
            60000
          );

          const call =
            startInternalCall({
              store,
              workspaceId,
              caller: user,
              role:
                socket.data.role,
              payload,
            });

          notifyCallParticipants({
            io,
            workspaceId,
            call,
            excludeUserId:
              user.id,
            eventName:
              "webrtc:call:incoming",
          });

          socket.emit(
            "webrtc:call:started",
            {
              call,
              createdAt:
                new Date().toISOString(),
            }
          );
        }
      )
    );

    socket.on(
      "webrtc:call:accept",
      withSocketHandler(
        socket,
        "webrtc:call:accept",
        async (payload = {}) => {
          const call =
            updateCallParticipant({
              store,
              workspaceId,
              callId:
                payload.callId,
              userId: user.id,
              status: "accepted",
            });

          io.to(
            getCallRoom(
              workspaceId,
              call.id
            )
          ).emit(
            "webrtc:call:accepted",
            {
              callId: call.id,
              user,
              acceptedAt:
                new Date().toISOString(),
            }
          );

          socket.join(
            getCallRoom(
              workspaceId,
              call.id
            )
          );
        }
      )
    );

    socket.on(
      "webrtc:call:decline",
      withSocketHandler(
        socket,
        "webrtc:call:decline",
        async (payload = {}) => {
          const call =
            updateCallParticipant({
              store,
              workspaceId,
              callId:
                payload.callId,
              userId: user.id,
              status: "declined",
            });

          notifyCallParticipants({
            io,
            workspaceId,
            call,
            eventName:
              "webrtc:call:declined",
            extra: {
              declinedBy: user,
              declinedAt:
                new Date().toISOString(),
            },
          });
        }
      )
    );

    socket.on(
      "webrtc:signal",
      withSocketHandler(
        socket,
        "webrtc:signal",
        async (payload = {}) => {
          enforceRateLimit(
            socket,
            socketRateLimits,
            "webrtc:signal",
            240,
            60000
          );

          const call =
            requireCallAccess({
              store,
              workspaceId,
              userId: user.id,
              callId:
                payload.callId,
            });

          const targetUserId =
            cleanId(
              payload.targetUserId
            );

          if (
            !targetUserId ||
            targetUserId === user.id
          ) {
            throw createError(
              400,
              "A valid target user is required."
            );
          }

          if (
            !call.participantUserIds.includes(
              targetUserId
            )
          ) {
            throw createError(
              403,
              "The target user is not a participant in this call."
            );
          }

          io.to(
            getUserRoom(
              workspaceId,
              targetUserId
            )
          ).emit(
            "webrtc:signal",
            {
              callId: call.id,
              fromUserId:
                user.id,
              fromUser: user,
              signalType:
                cleanText(
                  payload.signalType
                ),
              signal:
                sanitizeSignal(
                  payload.signal
                ),
              createdAt:
                new Date().toISOString(),
            }
          );
        },
        {
          emitSuccess: false,
        }
      )
    );

    socket.on(
      "webrtc:call:end",
      withSocketHandler(
        socket,
        "webrtc:call:end",
        async (payload = {}) => {
          const call =
            endInternalCall({
              store,
              workspaceId,
              userId: user.id,
              callId:
                payload.callId,
              reason:
                payload.reason,
            });

          notifyCallParticipants({
            io,
            workspaceId,
            call,
            eventName:
              "webrtc:call:ended",
            extra: {
              endedBy: user,
              endedAt:
                call.endedAt,
              reason:
                call.endReason,
            },
          });

          io.in(
            getCallRoom(
              workspaceId,
              call.id
            )
          ).socketsLeave(
            getCallRoom(
              workspaceId,
              call.id
            )
          );
        }
      )
    );

    socket.on(
      "disconnect",
      (reason) => {
        removeOnlineSocket({
          onlineUsers,
          workspaceId,
          userId: user.id,
          socketId: socket.id,
        });

        const stillOnline =
          isUserOnline(
            onlineUsers,
            workspaceId,
            user.id
          );

        if (!stillOnline) {
          persistPresence({
            store,
            workspaceId,
            userId: user.id,
            status: "offline",
            socketId: socket.id,
          });
        }

        socketRateLimits.delete(
          socket.id
        );

        broadcastPresence(
          io,
          workspaceId,
          onlineUsers
        );

        log("disconnected", {
          socketId: socket.id,
          workspaceId,
          userId: user.id,
          reason,
        });
      }
    );

    socket.on(
      "error",
      (error) => {
        log("socket-error", {
          socketId: socket.id,
          workspaceId,
          userId: user.id,
          message:
            error?.message ||
            String(error),
        });
      }
    );
  });

  return {
    io,

    getOnlineUsers(workspaceId) {
      return listOnlineUsers(
        onlineUsers,
        workspaceId
      );
    },

    isOnline(
      workspaceId,
      userId
    ) {
      return isUserOnline(
        onlineUsers,
        workspaceId,
        userId
      );
    },

    emitToUser({
      workspaceId,
      userId,
      event,
      payload,
    }) {
      io.to(
        getUserRoom(
          workspaceId,
          userId
        )
      ).emit(event, payload);
    },

    emitToWorkspace({
      workspaceId,
      event,
      payload,
    }) {
      io.to(
        getWorkspaceRoom(
          workspaceId
        )
      ).emit(event, payload);
    },

    emitToChannel({
      workspaceId,
      channelId,
      event,
      payload,
    }) {
      io.to(
        getChannelRoom(
          workspaceId,
          channelId
        )
      ).emit(event, payload);
    },

    close() {
      return io.close();
    },
  };

  function log(event, data = {}) {
    if (!debug) {
      return;
    }

    console.log(
      `[socket] ${event}`,
      {
        at: new Date().toISOString(),
        ...data,
      }
    );
  }
}

function getSocketToken(socket) {
  const authToken =
    socket.handshake?.auth?.token;

  if (authToken) {
    return stripBearer(authToken);
  }

  const authorization =
    socket.handshake?.headers
      ?.authorization;

  if (authorization) {
    return stripBearer(
      authorization
    );
  }

  const queryToken =
    socket.handshake?.query?.token;

  return stripBearer(queryToken);
}

function stripBearer(value) {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "");
}

function verifyToken(
  token,
  authSecret
) {
  if (
    !token ||
    !String(token).includes(".")
  ) {
    throw createError(
      401,
      "Authentication token is malformed."
    );
  }

  if (!authSecret) {
    throw new Error(
      "AUTH_SECRET is required for socket authentication."
    );
  }

  const [
    body,
    providedSignature,
  ] = String(token).split(".");

  if (
    !body ||
    !providedSignature
  ) {
    throw createError(
      401,
      "Authentication token is malformed."
    );
  }

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        authSecret
      )
      .update(body)
      .digest("base64url");

  const expected = Buffer.from(
    expectedSignature
  );

  const provided = Buffer.from(
    providedSignature
  );

  if (
    expected.length !==
      provided.length ||
    !crypto.timingSafeEqual(
      expected,
      provided
    )
  ) {
    throw createError(
      401,
      "Authentication token signature is invalid."
    );
  }

  let payload;

  try {
    payload = JSON.parse(
      Buffer.from(
        body,
        "base64url"
      ).toString("utf8")
    );
  } catch {
    throw createError(
      401,
      "Authentication token payload is invalid."
    );
  }

  if (
    payload.exp &&
    Number(payload.exp) <
      Date.now()
  ) {
    throw createError(
      401,
      "Authentication token has expired."
    );
  }

  return payload;
}

function createMessage({
  store,
  workspaceId,
  sender,
  payload,
}) {
  const channelId = cleanId(
    payload.channelId
  );

  const recipientUserId =
    cleanId(
      payload.recipientUserId
    );

  if (
    Boolean(channelId) ===
    Boolean(recipientUserId)
  ) {
    throw createError(
      400,
      "Specify either a channel or a direct-message recipient."
    );
  }

  const body = cleanMessageBody(
    payload.body
  );

  const attachments =
    sanitizeAttachments(
      payload.attachments
    );

  if (
    !body &&
    attachments.length === 0
  ) {
    throw createError(
      400,
      "A message or attachment is required."
    );
  }

  const state = store.read();

  if (channelId) {
    requireChannelAccess({
      store,
      workspaceId,
      userId: sender.id,
      channelId,
      stateOverride: state,
    });
  }

  if (recipientUserId) {
    requireWorkspaceUser({
      state,
      workspaceId,
      userId:
        recipientUserId,
    });
  }

  const now =
    new Date().toISOString();

  const message = {
    id: crypto.randomUUID(),
    workspaceId,

    channelId:
      channelId || "",

    recipientUserId:
      recipientUserId || "",

    senderId:
      sender.id,

    senderName:
      sender.name,

    senderAvatar:
      sender.avatarUrl ||
      sender.photoUrl ||
      sender.profileImage ||
      sender.profileImageUrl ||
      "",

    body,

    attachments,

    replyToMessageId:
      cleanId(
        payload.replyToMessageId
      ),

    clientMessageId:
      cleanText(
        payload.clientMessageId
      ).slice(0, 100),

    editedAt: "",
    deletedAt: "",
    deletedBy: "",

    createdAt: now,
    updatedAt: now,
  };

  store.update((draft) => {
    draft.teamMessages =
      Array.isArray(
        draft.teamMessages
      )
        ? draft.teamMessages
        : [];

    draft.teamMessages.push(
      message
    );
  });

  return publicMessage(message);
}

function editMessage({
  store,
  workspaceId,
  user,
  messageId,
  body,
}) {
  const normalizedMessageId =
    cleanId(messageId);

  const normalizedBody =
    cleanMessageBody(body);

  if (
    !normalizedMessageId ||
    !normalizedBody
  ) {
    throw createError(
      400,
      "Message ID and message body are required."
    );
  }

  let updated = null;

  store.update((draft) => {
    const message = (
      draft.teamMessages || []
    ).find(
      (item) =>
        item.id ===
          normalizedMessageId &&
        item.workspaceId ===
          workspaceId
    );

    if (!message) {
      return;
    }

    if (
      message.senderId !==
      user.id
    ) {
      throw createError(
        403,
        "You can only edit your own messages."
      );
    }

    if (message.deletedAt) {
      throw createError(
        409,
        "Deleted messages cannot be edited."
      );
    }

    const now =
      new Date().toISOString();

    message.body =
      normalizedBody;

    message.editedAt = now;
    message.updatedAt = now;

    updated =
      publicMessage(message);
  });

  if (!updated) {
    throw createError(
      404,
      "Message not found."
    );
  }

  return updated;
}

function softDeleteMessage({
  store,
  workspaceId,
  user,
  role,
  messageId,
}) {
  const normalizedMessageId =
    cleanId(messageId);

  if (!normalizedMessageId) {
    throw createError(
      400,
      "Message ID is required."
    );
  }

  let updated = null;

  store.update((draft) => {
    const message = (
      draft.teamMessages || []
    ).find(
      (item) =>
        item.id ===
          normalizedMessageId &&
        item.workspaceId ===
          workspaceId
    );

    if (!message) {
      return;
    }

    const canModerate = [
      "owner",
      "admin",
      "manager",
    ].includes(
      normalizeRole(role)
    );

    if (
      message.senderId !==
        user.id &&
      !canModerate
    ) {
      throw createError(
        403,
        "You cannot delete this message."
      );
    }

    const now =
      new Date().toISOString();

    message.body = "";
    message.attachments = [];
    message.deletedAt = now;
    message.deletedBy =
      user.id;
    message.updatedAt = now;

    updated =
      publicMessage(message);
  });

  if (!updated) {
    throw createError(
      404,
      "Message not found."
    );
  }

  return updated;
}

function markMessageRead({
  store,
  workspaceId,
  userId,
  messageId,
}) {
  const normalizedMessageId =
    cleanId(messageId);

  if (!normalizedMessageId) {
    throw createError(
      400,
      "Message ID is required."
    );
  }

  const state = store.read();

  const message = (
    state.teamMessages || []
  ).find(
    (item) =>
      item.id ===
        normalizedMessageId &&
      item.workspaceId ===
        workspaceId
  );

  if (!message) {
    throw createError(
      404,
      "Message not found."
    );
  }

  const now =
    new Date().toISOString();

  const receipt = {
    id: crypto.randomUUID(),
    workspaceId,
    messageId:
      normalizedMessageId,
    userId,
    readAt: now,
  };

  store.update((draft) => {
    draft.teamMessageReads =
      Array.isArray(
        draft.teamMessageReads
      )
        ? draft.teamMessageReads
        : [];

    const existing =
      draft.teamMessageReads.find(
        (item) =>
          item.workspaceId ===
            workspaceId &&
          item.messageId ===
            normalizedMessageId &&
          item.userId ===
            userId
      );

    if (existing) {
      existing.readAt = now;
      return;
    }

    draft.teamMessageReads.push(
      receipt
    );
  });

  return receipt;
}

function startInternalCall({
  store,
  workspaceId,
  caller,
  role,
  payload,
}) {
  const callType =
    payload.callType === "video"
      ? "video"
      : "audio";

  const channelId = cleanId(
    payload.channelId
  );

  let participantUserIds =
    uniqueStrings(
      Array.isArray(
        payload.participantUserIds
      )
        ? payload.participantUserIds
        : []
    );

  const state = store.read();

  if (channelId) {
    const channel =
      requireChannelAccess({
        store,
        workspaceId,
        userId: caller.id,
        channelId,
        stateOverride: state,
      });

    participantUserIds =
      uniqueStrings([
        ...participantUserIds,
        ...(channel.memberUserIds ||
          []),
      ]);
  }

  participantUserIds =
    participantUserIds.filter(
      (userId) =>
        userId !== caller.id
    );

  if (
    participantUserIds.length === 0
  ) {
    throw createError(
      400,
      "At least one call participant is required."
    );
  }

  if (
    participantUserIds.length >
    Number(
      process.env
        .INTERNAL_CALL_MAX_PARTICIPANTS ||
        12
    )
  ) {
    throw createError(
      400,
      "The internal call participant limit was exceeded."
    );
  }

  for (const participantUserId of participantUserIds) {
    requireWorkspaceUser({
      state,
      workspaceId,
      userId:
        participantUserId,
    });
  }

  validateCallPermission({
    state,
    workspaceId,
    caller,
    role,
    participantUserIds,
  });

  const now =
    new Date().toISOString();

  const call = {
    id: crypto.randomUUID(),
    workspaceId,
    channelId,

    initiatedBy:
      caller.id,

    initiatedByName:
      caller.name,

    callType,

    status: "ringing",

    participantUserIds: [
      caller.id,
      ...participantUserIds,
    ],

    participants: [
      {
        userId:
          caller.id,
        status: "accepted",
        joinedAt: now,
        leftAt: "",
      },

      ...participantUserIds.map(
        (userId) => ({
          userId,
          status: "ringing",
          joinedAt: "",
          leftAt: "",
        })
      ),
    ],

    startedAt: now,
    answeredAt: "",
    endedAt: "",
    endReason: "",

    createdAt: now,
    updatedAt: now,
  };

  store.update((draft) => {
    draft.teamCalls =
      Array.isArray(
        draft.teamCalls
      )
        ? draft.teamCalls
        : [];

    draft.teamCalls.unshift(
      call
    );
  });

  return publicCall(call);
}

function updateCallParticipant({
  store,
  workspaceId,
  callId,
  userId,
  status,
}) {
  const normalizedCallId =
    cleanId(callId);

  let updated = null;

  store.update((draft) => {
    const call = (
      draft.teamCalls || []
    ).find(
      (item) =>
        item.id ===
          normalizedCallId &&
        item.workspaceId ===
          workspaceId
    );

    if (!call) {
      return;
    }

    const participant =
      (
        call.participants || []
      ).find(
        (item) =>
          item.userId === userId
      );

    if (!participant) {
      throw createError(
        403,
        "You are not a participant in this call."
      );
    }

    const now =
      new Date().toISOString();

    participant.status =
      status;

    if (status === "accepted") {
      participant.joinedAt =
        participant.joinedAt ||
        now;

      call.status = "active";

      call.answeredAt =
        call.answeredAt || now;
    }

    if (status === "declined") {
      participant.leftAt = now;
    }

    call.updatedAt = now;

    updated =
      publicCall(call);
  });

  if (!updated) {
    throw createError(
      404,
      "Internal call not found."
    );
  }

  return updated;
}

function endInternalCall({
  store,
  workspaceId,
  userId,
  callId,
  reason,
}) {
  const normalizedCallId =
    cleanId(callId);

  let updated = null;

  store.update((draft) => {
    const call = (
      draft.teamCalls || []
    ).find(
      (item) =>
        item.id ===
          normalizedCallId &&
        item.workspaceId ===
          workspaceId
    );

    if (!call) {
      return;
    }

    if (
      !call.participantUserIds.includes(
        userId
      )
    ) {
      throw createError(
        403,
        "You are not a participant in this call."
      );
    }

    const now =
      new Date().toISOString();

    call.status = "ended";
    call.endedAt = now;

    call.endReason =
      cleanText(reason)
        .slice(0, 120) ||
      "ended_by_participant";

    call.updatedAt = now;

    for (const participant of
      call.participants || []) {
      if (
        !participant.leftAt
      ) {
        participant.leftAt =
          now;
      }

      if (
        participant.status ===
          "ringing"
      ) {
        participant.status =
          "missed";
      }
    }

    updated =
      publicCall(call);
  });

  if (!updated) {
    throw createError(
      404,
      "Internal call not found."
    );
  }

  return updated;
}

function requireCallAccess({
  store,
  workspaceId,
  userId,
  callId,
}) {
  const call = (
    store.read().teamCalls || []
  ).find(
    (item) =>
      item.id === cleanId(callId) &&
      item.workspaceId ===
        workspaceId
  );

  if (!call) {
    throw createError(
      404,
      "Internal call not found."
    );
  }

  if (
    !(
      call.participantUserIds ||
      []
    ).includes(userId)
  ) {
    throw createError(
      403,
      "You are not a participant in this call."
    );
  }

  return publicCall(call);
}

function requireChannelAccess({
  store,
  workspaceId,
  userId,
  channelId,
  stateOverride = null,
}) {
  const normalizedChannelId =
    cleanId(channelId);

  if (!normalizedChannelId) {
    throw createError(
      400,
      "Channel ID is required."
    );
  }

  const state =
    stateOverride ||
    store.read();

  const channel = (
    state.teamChannels || []
  ).find(
    (item) =>
      item.id ===
        normalizedChannelId &&
      item.workspaceId ===
        workspaceId &&
      item.active !== false
  );

  if (!channel) {
    throw createError(
      404,
      "Team channel not found."
    );
  }

  const members =
    channel.memberUserIds || [];

  if (
    channel.type !== "public" &&
    !members.includes(userId)
  ) {
    throw createError(
      403,
      "You do not have access to this channel."
    );
  }

  return channel;
}

function requireWorkspaceUser({
  state,
  workspaceId,
  userId,
}) {
  const user = (
    state.users || []
  ).find(
    (item) =>
      item.id === userId &&
      item.workspaceId ===
        workspaceId &&
      item.active !== false
  );

  if (!user) {
    throw createError(
      404,
      "Workspace member not found."
    );
  }

  return user;
}

function validateCallPermission({
  state,
  workspaceId,
  caller,
  role,
  participantUserIds,
}) {
  const normalizedRole =
    normalizeRole(role);

  if (
    [
      "owner",
      "admin",
    ].includes(
      normalizedRole
    )
  ) {
    return;
  }

  if (
    normalizedRole ===
    "manager"
  ) {
    const invalidParticipant =
      participantUserIds.find(
        (userId) => {
          const member =
            requireWorkspaceUser({
              state,
              workspaceId,
              userId,
            });

          return (
            member.managerId &&
            member.managerId !==
              caller.id &&
            member.id !==
              caller.id
          );
        }
      );

    if (invalidParticipant) {
      throw createError(
        403,
        "Managers may call only members within their workspace team."
      );
    }

    return;
  }

  if (
    normalizedRole ===
    "caller"
  ) {
    for (const userId of participantUserIds) {
      requireWorkspaceUser({
        state,
        workspaceId,
        userId,
      });
    }

    return;
  }

  throw createError(
    403,
    "Your role cannot initiate internal calls."
  );
}

function emitTypingEvent({
  io,
  socket,
  store,
  workspaceId,
  user,
  payload,
  typing,
}) {
  const channelId = cleanId(
    payload.channelId
  );

  const recipientUserId =
    cleanId(
      payload.recipientUserId
    );

  if (
    Boolean(channelId) ===
    Boolean(recipientUserId)
  ) {
    return;
  }

  const event = {
    typing,
    channelId,
    recipientUserId,
    user,
    createdAt:
      new Date().toISOString(),
  };

  if (channelId) {
    requireChannelAccess({
      store,
      workspaceId,
      userId: user.id,
      channelId,
    });

    socket.to(
      getChannelRoom(
        workspaceId,
        channelId
      )
    ).emit(
      "typing:update",
      event
    );

    return;
  }

  io.to(
    getUserRoom(
      workspaceId,
      recipientUserId
    )
  ).emit(
    "typing:update",
    event
  );
}

function emitMessageUpdate({
  io,
  workspaceId,
  message,
  eventName,
}) {
  const event = {
    message,
    createdAt:
      new Date().toISOString(),
  };

  if (message.channelId) {
    io.to(
      getChannelRoom(
        workspaceId,
        message.channelId
      )
    ).emit(
      eventName,
      event
    );
  }

  if (
    message.recipientUserId
  ) {
    io.to(
      getUserRoom(
        workspaceId,
        message.recipientUserId
      )
    ).emit(
      eventName,
      event
    );

    io.to(
      getUserRoom(
        workspaceId,
        message.senderId
      )
    ).emit(
      eventName,
      event
    );
  }
}

function notifyCallParticipants({
  io,
  workspaceId,
  call,
  excludeUserId = "",
  eventName,
  extra = {},
}) {
  for (const userId of
    call.participantUserIds ||
    []) {
    if (
      userId === excludeUserId
    ) {
      continue;
    }

    io.to(
      getUserRoom(
        workspaceId,
        userId
      )
    ).emit(eventName, {
      call,
      ...extra,
    });
  }
}

function joinUserChannels({
  socket,
  store,
  workspaceId,
  userId,
}) {
  const channels = (
    store.read().teamChannels ||
    []
  ).filter(
    (channel) =>
      channel.workspaceId ===
        workspaceId &&
      channel.active !== false &&
      (
        channel.type ===
          "public" ||
        (
          channel.memberUserIds ||
          []
        ).includes(userId)
      )
  );

  for (const channel of channels) {
    socket.join(
      getChannelRoom(
        workspaceId,
        channel.id
      )
    );
  }
}

function addOnlineSocket({
  onlineUsers,
  workspaceId,
  user,
  socketId,
}) {
  const workspaceMap =
    onlineUsers.get(
      workspaceId
    ) ||
    new Map();

  const existing =
    workspaceMap.get(
      user.id
    ) || {
      user,
      socketIds: new Set(),
      connectedAt:
        new Date().toISOString(),
    };

  existing.user = user;
  existing.socketIds.add(
    socketId
  );

  workspaceMap.set(
    user.id,
    existing
  );

  onlineUsers.set(
    workspaceId,
    workspaceMap
  );
}

function removeOnlineSocket({
  onlineUsers,
  workspaceId,
  userId,
  socketId,
}) {
  const workspaceMap =
    onlineUsers.get(
      workspaceId
    );

  if (!workspaceMap) {
    return;
  }

  const record =
    workspaceMap.get(userId);

  if (!record) {
    return;
  }

  record.socketIds.delete(
    socketId
  );

  if (
    record.socketIds.size === 0
  ) {
    workspaceMap.delete(
      userId
    );
  }

  if (
    workspaceMap.size === 0
  ) {
    onlineUsers.delete(
      workspaceId
    );
  }
}

function isUserOnline(
  onlineUsers,
  workspaceId,
  userId
) {
  return Boolean(
    onlineUsers
      .get(workspaceId)
      ?.get(userId)
      ?.socketIds?.size
  );
}

function listOnlineUsers(
  onlineUsers,
  workspaceId
) {
  const workspaceMap =
    onlineUsers.get(
      workspaceId
    );

  if (!workspaceMap) {
    return [];
  }

  return [
    ...workspaceMap.values(),
  ].map((record) => ({
    ...record.user,
    status: "online",
    connectedAt:
      record.connectedAt,
    connectionCount:
      record.socketIds.size,
  }));
}

function persistPresence({
  store,
  workspaceId,
  userId,
  status,
  socketId,
}) {
  const now =
    new Date().toISOString();

  store.update((draft) => {
    draft.teamPresence =
      Array.isArray(
        draft.teamPresence
      )
        ? draft.teamPresence
        : [];

    let record =
      draft.teamPresence.find(
        (item) =>
          item.workspaceId ===
            workspaceId &&
          item.userId ===
            userId
      );

    if (!record) {
      record = {
        id: crypto.randomUUID(),
        workspaceId,
        userId,
        createdAt: now,
      };

      draft.teamPresence.push(
        record
      );
    }

    record.status = status;
    record.socketId =
      socketId || "";
    record.updatedAt = now;

    if (status === "online") {
      record.lastConnectedAt =
        now;
    }

    if (status === "offline") {
      record.lastSeenAt = now;
    }
  });
}

function broadcastPresence(
  io,
  workspaceId,
  onlineUsers
) {
  io.to(
    getWorkspaceRoom(
      workspaceId
    )
  ).emit(
    "presence:update",
    {
      users: listOnlineUsers(
        onlineUsers,
        workspaceId
      ),
      createdAt:
        new Date().toISOString(),
    }
  );
}

function enforceRateLimit(
  socket,
  rateLimitMap,
  action,
  maxEvents,
  durationMs
) {
  const now = Date.now();

  let socketMap =
    rateLimitMap.get(
      socket.id
    );

  if (!socketMap) {
    socketMap = new Map();

    rateLimitMap.set(
      socket.id,
      socketMap
    );
  }

  let record =
    socketMap.get(action);

  if (
    !record ||
    now - record.startedAt >=
      durationMs
  ) {
    record = {
      startedAt: now,
      count: 0,
    };

    socketMap.set(
      action,
      record
    );
  }

  record.count += 1;

  if (
    record.count > maxEvents
  ) {
    throw createError(
      429,
      "You are performing this action too quickly."
    );
  }
}

function withSocketHandler(
  socket,
  eventName,
  handler,
  {
    emitSuccess = false,
  } = {}
) {
  return async (
    payload,
    acknowledgment
  ) => {
    try {
      const result =
        await handler(
          payload || {}
        );

      const response = {
        ok: true,
        event: eventName,
        data: result ?? null,
        createdAt:
          new Date().toISOString(),
      };

      if (
        typeof acknowledgment ===
        "function"
      ) {
        acknowledgment(response);
      }

      if (emitSuccess) {
        socket.emit(
          `${eventName}:success`,
          response
        );
      }
    } catch (error) {
      const response = {
        ok: false,
        event: eventName,
        error:
          error?.message ||
          "The socket action failed.",
        statusCode:
          Number(
            error?.statusCode
          ) || 500,
        createdAt:
          new Date().toISOString(),
      };

      if (
        typeof acknowledgment ===
        "function"
      ) {
        acknowledgment(response);
      }

      socket.emit(
        "socket:operation-error",
        response
      );
    }
  };
}

function sanitizeAttachments(
  attachments
) {
  if (
    !Array.isArray(
      attachments
    )
  ) {
    return [];
  }

  return attachments
    .slice(0, 10)
    .map((attachment) => ({
      id:
        cleanId(
          attachment?.id
        ) ||
        crypto.randomUUID(),

      name: cleanText(
        attachment?.name
      ).slice(0, 180),

      url: cleanText(
        attachment?.url
      ).slice(0, 2000),

      mimeType:
        cleanText(
          attachment?.mimeType
        ).slice(0, 120),

      size: Math.max(
        0,
        Number(
          attachment?.size || 0
        )
      ),
    }))
    .filter(
      (attachment) =>
        attachment.name &&
        attachment.url
    );
}

function sanitizeSignal(
  signal
) {
  if (
    signal === null ||
    signal === undefined
  ) {
    return null;
  }

  const serialized =
    JSON.stringify(signal);

  const maxBytes = Number(
    process.env
      .WEBRTC_SIGNAL_MAX_BYTES ||
      256000
  );

  if (
    Buffer.byteLength(
      serialized,
      "utf8"
    ) > maxBytes
  ) {
    throw createError(
      413,
      "The WebRTC signalling payload is too large."
    );
  }

  return JSON.parse(
    serialized
  );
}

function getMessage({
  store,
  workspaceId,
  messageId,
}) {
  const message = (
    store.read().teamMessages ||
    []
  ).find(
    (item) =>
      item.id ===
        cleanId(messageId) &&
      item.workspaceId ===
        workspaceId
  );

  return message
    ? publicMessage(message)
    : null;
}

function publicMessage(
  message
) {
  return {
    id: message.id,
    workspaceId:
      message.workspaceId,

    channelId:
      message.channelId || "",

    recipientUserId:
      message.recipientUserId ||
      "",

    senderId:
      message.senderId,

    senderName:
      message.senderName || "",

    senderAvatar:
      message.senderAvatar || "",

    body:
      message.deletedAt
        ? ""
        : message.body || "",

    attachments:
      message.deletedAt
        ? []
        : message.attachments ||
          [],

    replyToMessageId:
      message.replyToMessageId ||
      "",

    clientMessageId:
      message.clientMessageId ||
      "",

    editedAt:
      message.editedAt || "",

    deletedAt:
      message.deletedAt || "",

    createdAt:
      message.createdAt,

    updatedAt:
      message.updatedAt,
  };
}

function publicCall(call) {
  return {
    id: call.id,
    workspaceId:
      call.workspaceId,

    channelId:
      call.channelId || "",

    initiatedBy:
      call.initiatedBy,

    initiatedByName:
      call.initiatedByName ||
      "",

    callType:
      call.callType,

    status:
      call.status,

    participantUserIds:
      call.participantUserIds ||
      [],

    participants:
      call.participants || [],

    startedAt:
      call.startedAt,

    answeredAt:
      call.answeredAt || "",

    endedAt:
      call.endedAt || "",

    endReason:
      call.endReason || "",

    createdAt:
      call.createdAt,

    updatedAt:
      call.updatedAt,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name || "",
    email: user.email || "",

    role:
      normalizeRole(
        user.workspaceRole ||
          user.role
      ),

    jobTitle:
      user.jobTitle || "",

    avatarUrl:
      user.avatarUrl ||
      user.photoUrl ||
      user.profileImage ||
      user.profileImageUrl ||
      "",

    photoUrl:
      user.photoUrl ||
      user.avatarUrl ||
      "",

    profileImage:
      user.profileImage ||
      user.avatarUrl ||
      "",

    department:
      user.department || "",

    bio:
      user.bio ||
      user.biography ||
      "",

    availabilityStatus:
      user.availabilityStatus ||
      "available",

    timezone:
      user.timezone || "UTC",
  };
}

function isAllowedOrigin(
  origin,
  allowedOrigins
) {
  if (!origin) {
    return true;
  }

  const normalized =
    normalizeOrigin(origin);

  if (
    allowedOrigins.has(
      normalized
    )
  ) {
    return true;
  }

  if (
    process.env.NODE_ENV !==
    "production"
  ) {
    try {
      const url =
        new URL(normalized);

      return [
        "localhost",
        "127.0.0.1",
        "::1",
      ].includes(
        url.hostname
      );
    } catch {
      return false;
    }
  }

  return false;
}

function normalizeOrigin(value) {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

function getWorkspaceRoom(
  workspaceId
) {
  return `workspace:${workspaceId}`;
}

function getUserRoom(
  workspaceId,
  userId
) {
  return `workspace:${workspaceId}:user:${userId}`;
}

function getChannelRoom(
  workspaceId,
  channelId
) {
  return `workspace:${workspaceId}:channel:${channelId}`;
}

function getCallRoom(
  workspaceId,
  callId
) {
  return `workspace:${workspaceId}:call:${callId}`;
}

function cleanMessageBody(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(
      0,
      Number(
        process.env
          .TEAM_MESSAGE_MAX_LENGTH ||
          10000
      )
    );
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim();
}

function cleanId(value) {
  return cleanText(value)
    .slice(0, 160);
}

function normalizeRole(value) {
  const role = cleanText(value)
    .toLowerCase();

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

  if (
    role.includes("owner")
  ) {
    return "owner";
  }

  if (
    role.includes("admin")
  ) {
    return "admin";
  }

  if (
    role.includes("manager")
  ) {
    return "manager";
  }

  if (
    role.includes("caller")
  ) {
    return "caller";
  }

  return "viewer";
}

function uniqueStrings(values) {
  return [
    ...new Set(
      values
        .map(cleanId)
        .filter(Boolean)
    ),
  ];
}

function createError(
  statusCode,
  message
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  return error;
}