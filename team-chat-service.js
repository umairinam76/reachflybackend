import crypto from "node:crypto";

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LENGTH = Number(
  process.env.TEAM_MESSAGE_MAX_LENGTH || 10_000
);
const MAX_CHANNEL_NAME_LENGTH = 80;
const MAX_RESOURCE_NAME_LENGTH = 180;

export function createTeamChatService({
  store,
  workspaceService = null,
  socketService = null,
}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createTeamChatService requires a store exposing read() and update()."
    );
  }

  initializeCollections();

  return {
    listMembers,
    listChannels,
    getChannel,
    createChannel,
    updateChannel,
    deleteChannel,
    addChannelMembers,
    removeChannelMember,

    listDirectConversations,
    getDirectConversation,

    listMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    markMessageRead,
    markConversationRead,

    listSharedResources,
    createSharedResource,
    updateSharedResource,
    deleteSharedResource,

    listInternalCalls,
    getInternalCall,

    getUnreadSummary,
    searchMessages,

    registerRoutes,
  };

  /* ------------------------------------------------------------------ */
  /* Express route registration                                         */
  /* ------------------------------------------------------------------ */

  function registerRoutes({
    app,
    authenticate,
    asyncRoute = defaultAsyncRoute,
  }) {
    if (!app) {
      throw new Error(
        "registerRoutes requires an Express application."
      );
    }

    if (typeof authenticate !== "function") {
      throw new Error(
        "registerRoutes requires authentication middleware."
      );
    }

    app.get(
      "/api/team-chat/members",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          members: listMembers(req.user),
        });
      })
    );

    app.get(
      "/api/team-chat/channels",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          channels: listChannels(req.user),
        });
      })
    );

    app.get(
      "/api/team-chat/channels/:channelId",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          channel: getChannel(
            req.user,
            req.params.channelId
          ),
        });
      })
    );

    app.post(
      "/api/team-chat/channels",
      authenticate,
      asyncRoute(async (req, res) => {
        const channel = createChannel(
          req.user,
          req.body || {}
        );

        res.status(201).json({
          ok: true,
          channel,
        });
      })
    );

    app.patch(
      "/api/team-chat/channels/:channelId",
      authenticate,
      asyncRoute(async (req, res) => {
        const channel = updateChannel(
          req.user,
          req.params.channelId,
          req.body || {}
        );

        res.json({
          ok: true,
          channel,
        });
      })
    );

    app.delete(
      "/api/team-chat/channels/:channelId",
      authenticate,
      asyncRoute(async (req, res) => {
        const channel = deleteChannel(
          req.user,
          req.params.channelId
        );

        res.json({
          ok: true,
          channel,
        });
      })
    );

    app.post(
      "/api/team-chat/channels/:channelId/members",
      authenticate,
      asyncRoute(async (req, res) => {
        const channel = addChannelMembers(
          req.user,
          req.params.channelId,
          req.body?.userIds || []
        );

        res.json({
          ok: true,
          channel,
        });
      })
    );

    app.delete(
      "/api/team-chat/channels/:channelId/members/:userId",
      authenticate,
      asyncRoute(async (req, res) => {
        const channel = removeChannelMember(
          req.user,
          req.params.channelId,
          req.params.userId
        );

        res.json({
          ok: true,
          channel,
        });
      })
    );

    app.get(
      "/api/team-chat/direct-conversations",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          conversations:
            listDirectConversations(req.user),
        });
      })
    );

    app.get(
      "/api/team-chat/direct/:userId",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          conversation: getDirectConversation(
            req.user,
            req.params.userId,
            {
              limit: req.query.limit,
              before: req.query.before,
            }
          ),
        });
      })
    );

    app.get(
      "/api/team-chat/messages",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          ...listMessages(req.user, {
            channelId: req.query.channelId,
            recipientUserId:
              req.query.recipientUserId,
            limit: req.query.limit,
            before: req.query.before,
            after: req.query.after,
          }),
        });
      })
    );

    app.post(
      "/api/team-chat/messages",
      authenticate,
      asyncRoute(async (req, res) => {
        const message = sendMessage(
          req.user,
          req.body || {}
        );

        res.status(201).json({
          ok: true,
          message,
        });
      })
    );

    app.patch(
      "/api/team-chat/messages/:messageId",
      authenticate,
      asyncRoute(async (req, res) => {
        const message = editMessage(
          req.user,
          req.params.messageId,
          req.body || {}
        );

        res.json({
          ok: true,
          message,
        });
      })
    );

    app.delete(
      "/api/team-chat/messages/:messageId",
      authenticate,
      asyncRoute(async (req, res) => {
        const message = deleteMessage(
          req.user,
          req.params.messageId
        );

        res.json({
          ok: true,
          message,
        });
      })
    );

    app.post(
      "/api/team-chat/messages/:messageId/read",
      authenticate,
      asyncRoute(async (req, res) => {
        const receipt = markMessageRead(
          req.user,
          req.params.messageId
        );

        res.json({
          ok: true,
          receipt,
        });
      })
    );

    app.post(
      "/api/team-chat/read",
      authenticate,
      asyncRoute(async (req, res) => {
        const result = markConversationRead(
          req.user,
          req.body || {}
        );

        res.json({
          ok: true,
          ...result,
        });
      })
    );

    app.get(
      "/api/team-chat/unread",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          unread: getUnreadSummary(req.user),
        });
      })
    );

    app.get(
      "/api/team-chat/search",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          results: searchMessages(req.user, {
            query: req.query.q,
            channelId: req.query.channelId,
            userId: req.query.userId,
            limit: req.query.limit,
          }),
        });
      })
    );

    app.get(
      "/api/team-chat/resources",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          resources: listSharedResources(
            req.user,
            {
              channelId: req.query.channelId,
              type: req.query.type,
            }
          ),
        });
      })
    );

    app.post(
      "/api/team-chat/resources",
      authenticate,
      asyncRoute(async (req, res) => {
        const resource = createSharedResource(
          req.user,
          req.body || {}
        );

        res.status(201).json({
          ok: true,
          resource,
        });
      })
    );

    app.patch(
      "/api/team-chat/resources/:resourceId",
      authenticate,
      asyncRoute(async (req, res) => {
        const resource = updateSharedResource(
          req.user,
          req.params.resourceId,
          req.body || {}
        );

        res.json({
          ok: true,
          resource,
        });
      })
    );

    app.delete(
      "/api/team-chat/resources/:resourceId",
      authenticate,
      asyncRoute(async (req, res) => {
        const resource = deleteSharedResource(
          req.user,
          req.params.resourceId
        );

        res.json({
          ok: true,
          resource,
        });
      })
    );

    app.get(
      "/api/team-chat/calls",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          calls: listInternalCalls(req.user, {
            limit: req.query.limit,
            userId: req.query.userId,
            channelId: req.query.channelId,
          }),
        });
      })
    );

    app.get(
      "/api/team-chat/calls/:callId",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          call: getInternalCall(
            req.user,
            req.params.callId
          ),
        });
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* Members                                                            */
  /* ------------------------------------------------------------------ */

  function listMembers(user) {
    const context = getContext(user);
    const state = store.read();

    return (state.users || [])
      .filter(
        (member) =>
          member.workspaceId ===
            context.workspaceId &&
          member.active !== false
      )
      .map((member) => {
        const presence = (
          state.teamPresence || []
        ).find(
          (item) =>
            item.workspaceId ===
              context.workspaceId &&
            item.userId === member.id
        );

        return {
          ...publicMember(member),
          presence: {
            status:
              presence?.status || "offline",
            lastSeenAt:
              presence?.lastSeenAt || "",
            lastConnectedAt:
              presence?.lastConnectedAt || "",
          },
        };
      })
      .sort((a, b) => {
        if (a.id === context.user.id) {
          return -1;
        }

        if (b.id === context.user.id) {
          return 1;
        }

        return a.name.localeCompare(b.name);
      });
  }

  /* ------------------------------------------------------------------ */
  /* Channels                                                           */
  /* ------------------------------------------------------------------ */

  function listChannels(user) {
    const context = getContext(user);
    const state = store.read();

    return (state.teamChannels || [])
      .filter(
        (channel) =>
          channel.workspaceId ===
            context.workspaceId &&
          channel.active !== false &&
          canAccessChannel(
            channel,
            context.user.id
          )
      )
      .map((channel) =>
        enrichChannel({
          channel,
          state,
          currentUserId: context.user.id,
        })
      )
      .sort((a, b) => {
        if (a.isDefault && !b.isDefault) {
          return -1;
        }

        if (!a.isDefault && b.isDefault) {
          return 1;
        }

        return String(
          b.lastMessageAt || b.updatedAt
        ).localeCompare(
          String(
            a.lastMessageAt || a.updatedAt
          )
        );
      });
  }

  function getChannel(user, channelId) {
    const context = getContext(user);
    const state = store.read();

    const channel = requireChannel({
      state,
      workspaceId: context.workspaceId,
      channelId,
    });

    requireChannelAccess(
      channel,
      context.user.id
    );

    return enrichChannel({
      channel,
      state,
      currentUserId: context.user.id,
    });
  }

  function createChannel(user, input = {}) {
    const context = requireChannelManagement(
      user
    );

    const name = cleanText(input.name).slice(
      0,
      MAX_CHANNEL_NAME_LENGTH
    );

    if (!name) {
      throw createError(
        400,
        "Channel name is required."
      );
    }

    const type = normalizeChannelType(
      input.type
    );

    const state = store.read();

    let memberUserIds = uniqueIds([
      context.user.id,
      ...(Array.isArray(input.memberUserIds)
        ? input.memberUserIds
        : []),
    ]);

    for (const memberId of memberUserIds) {
      requireWorkspaceMember({
        state,
        workspaceId: context.workspaceId,
        userId: memberId,
      });
    }

    if (type === "public") {
      memberUserIds = (state.users || [])
        .filter(
          (member) =>
            member.workspaceId ===
              context.workspaceId &&
            member.active !== false
        )
        .map((member) => member.id);
    }

    const now = serverTimestamp();

    const channel = {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,

      name,
      slug: createUniqueChannelSlug({
        state,
        workspaceId: context.workspaceId,
        name,
      }),

      description: cleanText(
        input.description
      ).slice(0, 500),

      type,
      memberUserIds,

      createdBy: context.user.id,
      createdByName: context.user.name,

      active: true,
      isDefault: false,

      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      draft.teamChannels =
        ensureArray(draft.teamChannels);

      draft.teamChannels.push(channel);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_channel_created",
        entityType: "team_channel",
        entityId: channel.id,
        metadata: {
          channelName: channel.name,
          channelType: channel.type,
          memberCount:
            channel.memberUserIds.length,
        },
      });
    });

    emitWorkspace(context.workspaceId, {
      event: "channel:created",
      payload: {
        channel: publicChannel(channel),
      },
    });

    return publicChannel(channel);
  }

  function updateChannel(
    user,
    channelId,
    input = {}
  ) {
    const context = requireChannelManagement(
      user
    );

    let updated = null;

    store.update((draft) => {
      const channel = (
        draft.teamChannels || []
      ).find(
        (item) =>
          item.id === cleanId(channelId) &&
          item.workspaceId ===
            context.workspaceId &&
          item.active !== false
      );

      if (!channel) {
        return;
      }

      if (
        channel.isDefault &&
        input.type &&
        normalizeChannelType(input.type) !==
          channel.type
      ) {
        throw createError(
          400,
          "The default channel type cannot be changed."
        );
      }

      if (input.name !== undefined) {
        const name = cleanText(
          input.name
        ).slice(0, MAX_CHANNEL_NAME_LENGTH);

        if (!name) {
          throw createError(
            400,
            "Channel name cannot be empty."
          );
        }

        channel.name = name;
      }

      if (input.description !== undefined) {
        channel.description = cleanText(
          input.description
        ).slice(0, 500);
      }

      if (
        input.type !== undefined &&
        !channel.isDefault
      ) {
        channel.type =
          normalizeChannelType(input.type);
      }

      channel.updatedAt = serverTimestamp();
      updated = publicChannel(channel);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_channel_updated",
        entityType: "team_channel",
        entityId: channel.id,
      });
    });

    if (!updated) {
      throw createError(
        404,
        "Team channel not found."
      );
    }

    emitWorkspace(context.workspaceId, {
      event: "channel:updated",
      payload: {
        channel: updated,
      },
    });

    return updated;
  }

  function deleteChannel(user, channelId) {
    const context = requireChannelManagement(
      user
    );

    let deleted = null;

    store.update((draft) => {
      const channel = (
        draft.teamChannels || []
      ).find(
        (item) =>
          item.id === cleanId(channelId) &&
          item.workspaceId ===
            context.workspaceId &&
          item.active !== false
      );

      if (!channel) {
        return;
      }

      if (channel.isDefault) {
        throw createError(
          400,
          "The default team channel cannot be deleted."
        );
      }

      const now = serverTimestamp();

      channel.active = false;
      channel.deletedAt = now;
      channel.deletedBy = context.user.id;
      channel.updatedAt = now;

      deleted = publicChannel(channel);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_channel_deleted",
        entityType: "team_channel",
        entityId: channel.id,
      });
    });

    if (!deleted) {
      throw createError(
        404,
        "Team channel not found."
      );
    }

    emitWorkspace(context.workspaceId, {
      event: "channel:deleted",
      payload: {
        channelId: deleted.id,
      },
    });

    return deleted;
  }

  function addChannelMembers(
    user,
    channelId,
    userIds = []
  ) {
    const context = requireChannelManagement(
      user
    );

    const normalizedUserIds =
      uniqueIds(userIds);

    if (!normalizedUserIds.length) {
      throw createError(
        400,
        "At least one team member is required."
      );
    }

    const state = store.read();

    for (const userId of normalizedUserIds) {
      requireWorkspaceMember({
        state,
        workspaceId: context.workspaceId,
        userId,
      });
    }

    let updated = null;

    store.update((draft) => {
      const channel = (
        draft.teamChannels || []
      ).find(
        (item) =>
          item.id === cleanId(channelId) &&
          item.workspaceId ===
            context.workspaceId &&
          item.active !== false
      );

      if (!channel) {
        return;
      }

      channel.memberUserIds = uniqueIds([
        ...(channel.memberUserIds || []),
        ...normalizedUserIds,
      ]);

      channel.updatedAt = serverTimestamp();
      updated = publicChannel(channel);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_channel_members_added",
        entityType: "team_channel",
        entityId: channel.id,
        metadata: {
          addedUserIds: normalizedUserIds,
        },
      });
    });

    if (!updated) {
      throw createError(
        404,
        "Team channel not found."
      );
    }

    emitWorkspace(context.workspaceId, {
      event: "channel:members-updated",
      payload: {
        channel: updated,
      },
    });

    return updated;
  }

  function removeChannelMember(
    user,
    channelId,
    memberUserId
  ) {
    const context = requireChannelManagement(
      user
    );

    const targetUserId = cleanId(memberUserId);

    let updated = null;

    store.update((draft) => {
      const channel = (
        draft.teamChannels || []
      ).find(
        (item) =>
          item.id === cleanId(channelId) &&
          item.workspaceId ===
            context.workspaceId &&
          item.active !== false
      );

      if (!channel) {
        return;
      }

      if (channel.isDefault) {
        throw createError(
          400,
          "Members cannot be removed from the default channel."
        );
      }

      if (channel.createdBy === targetUserId) {
        throw createError(
          400,
          "The channel creator cannot be removed."
        );
      }

      channel.memberUserIds = (
        channel.memberUserIds || []
      ).filter(
        (userId) => userId !== targetUserId
      );

      channel.updatedAt = serverTimestamp();
      updated = publicChannel(channel);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_channel_member_removed",
        entityType: "team_channel",
        entityId: channel.id,
        metadata: {
          removedUserId: targetUserId,
        },
      });
    });

    if (!updated) {
      throw createError(
        404,
        "Team channel not found."
      );
    }

    emitWorkspace(context.workspaceId, {
      event: "channel:members-updated",
      payload: {
        channel: updated,
      },
    });

    return updated;
  }

  /* ------------------------------------------------------------------ */
  /* Direct conversations                                               */
  /* ------------------------------------------------------------------ */

  function listDirectConversations(user) {
    const context = getContext(user);
    const state = store.read();

    const messages = (
      state.teamMessages || []
    )
      .filter(
        (message) =>
          message.workspaceId ===
            context.workspaceId &&
          !message.channelId &&
          (
            message.senderId ===
              context.user.id ||
            message.recipientUserId ===
              context.user.id
          )
      )
      .sort((a, b) =>
        String(b.createdAt).localeCompare(
          String(a.createdAt)
        )
      );

    const conversations = new Map();

    for (const message of messages) {
      const otherUserId =
        message.senderId === context.user.id
          ? message.recipientUserId
          : message.senderId;

      if (
        !otherUserId ||
        conversations.has(otherUserId)
      ) {
        continue;
      }

      const member = (state.users || []).find(
        (item) =>
          item.id === otherUserId &&
          item.workspaceId ===
            context.workspaceId
      );

      if (!member) {
        continue;
      }

      conversations.set(otherUserId, {
        user: publicMember(member),
        lastMessage: publicMessage(message),
        unreadCount: countUnreadDirectMessages({
          state,
          workspaceId: context.workspaceId,
          currentUserId: context.user.id,
          otherUserId,
        }),
      });
    }

    for (const member of state.users || []) {
      if (
        member.workspaceId !==
          context.workspaceId ||
        member.id === context.user.id ||
        member.active === false ||
        conversations.has(member.id)
      ) {
        continue;
      }

      conversations.set(member.id, {
        user: publicMember(member),
        lastMessage: null,
        unreadCount: 0,
      });
    }

    return [...conversations.values()].sort(
      (a, b) =>
        String(
          b.lastMessage?.createdAt || ""
        ).localeCompare(
          String(
            a.lastMessage?.createdAt || ""
          )
        )
    );
  }

  function getDirectConversation(
    user,
    otherUserId,
    options = {}
  ) {
    const context = getContext(user);
    const state = store.read();

    const otherUser = requireWorkspaceMember({
      state,
      workspaceId: context.workspaceId,
      userId: cleanId(otherUserId),
    });

    const messages = listMessages(user, {
      recipientUserId: otherUser.id,
      limit: options.limit,
      before: options.before,
    });

    return {
      user: publicMember(otherUser),
      ...messages,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Messages                                                           */
  /* ------------------------------------------------------------------ */

  function listMessages(user, filters = {}) {
    const context = getContext(user);
    const state = store.read();

    const channelId = cleanId(
      filters.channelId
    );

    const otherUserId = cleanId(
      filters.recipientUserId
    );

    if (
      Boolean(channelId) ===
      Boolean(otherUserId)
    ) {
      throw createError(
        400,
        "Specify either a channel or direct-message user."
      );
    }

    if (channelId) {
      const channel = requireChannel({
        state,
        workspaceId: context.workspaceId,
        channelId,
      });

      requireChannelAccess(
        channel,
        context.user.id
      );
    }

    if (otherUserId) {
      requireWorkspaceMember({
        state,
        workspaceId: context.workspaceId,
        userId: otherUserId,
      });
    }

    const limit = clampNumber(
      filters.limit,
      1,
      MAX_MESSAGE_LIMIT,
      DEFAULT_MESSAGE_LIMIT
    );

    const beforeTime = parseTimestamp(
      filters.before
    );

    const afterTime = parseTimestamp(
      filters.after
    );

    let messages = (
      state.teamMessages || []
    ).filter(
      (message) =>
        message.workspaceId ===
        context.workspaceId
    );

    if (channelId) {
      messages = messages.filter(
        (message) =>
          message.channelId === channelId
      );
    }

    if (otherUserId) {
      messages = messages.filter(
        (message) =>
          !message.channelId &&
          (
            (
              message.senderId ===
                context.user.id &&
              message.recipientUserId ===
                otherUserId
            ) ||
            (
              message.senderId ===
                otherUserId &&
              message.recipientUserId ===
                context.user.id
            )
          )
      );
    }

    if (beforeTime) {
      messages = messages.filter(
        (message) =>
          Date.parse(message.createdAt) <
          beforeTime
      );
    }

    if (afterTime) {
      messages = messages.filter(
        (message) =>
          Date.parse(message.createdAt) >
          afterTime
      );
    }

    messages.sort((a, b) =>
      String(b.createdAt).localeCompare(
        String(a.createdAt)
      )
    );

    const selected = messages.slice(0, limit);
    const hasMore = messages.length > limit;

    return {
      messages: selected
        .reverse()
        .map(publicMessage),

      hasMore,

      nextBefore: hasMore
        ? selected[selected.length - 1]
            ?.createdAt || ""
        : "",
    };
  }

  function sendMessage(user, input = {}) {
    const context = getContext(user);
    const state = store.read();

    const channelId = cleanId(input.channelId);
    const recipientUserId = cleanId(
      input.recipientUserId
    );

    if (
      Boolean(channelId) ===
      Boolean(recipientUserId)
    ) {
      throw createError(
        400,
        "Specify either a channel or direct-message recipient."
      );
    }

    if (channelId) {
      const channel = requireChannel({
        state,
        workspaceId: context.workspaceId,
        channelId,
      });

      requireChannelAccess(
        channel,
        context.user.id
      );
    }

    if (recipientUserId) {
      requireWorkspaceMember({
        state,
        workspaceId: context.workspaceId,
        userId: recipientUserId,
      });

      if (recipientUserId === context.user.id) {
        throw createError(
          400,
          "You cannot send a direct message to yourself."
        );
      }
    }

    const body = cleanMessageBody(input.body);
    const attachments = sanitizeAttachments(
      input.attachments
    );

    if (!body && attachments.length === 0) {
      throw createError(
        400,
        "A message or attachment is required."
      );
    }

    if (input.replyToMessageId) {
      const replyMessage = requireMessage({
        state,
        workspaceId: context.workspaceId,
        messageId: input.replyToMessageId,
      });

      validateReplyTarget({
        replyMessage,
        channelId,
        recipientUserId,
        currentUserId: context.user.id,
      });
    }

    const now = serverTimestamp();

    const message = {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,

      channelId,
      recipientUserId,

      senderId: context.user.id,
      senderName: context.user.name,
      senderAvatar: getAvatar(context.user),

      body,
      attachments,

      replyToMessageId: cleanId(
        input.replyToMessageId
      ),

      clientMessageId: cleanText(
        input.clientMessageId
      ).slice(0, 100),

      editedAt: "",
      deletedAt: "",
      deletedBy: "",

      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      draft.teamMessages =
        ensureArray(draft.teamMessages);

      draft.teamMessages.push(message);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_message_sent",
        entityType: "team_message",
        entityId: message.id,
        metadata: {
          channelId,
          recipientUserId,
          attachmentCount: attachments.length,
        },
      });
    });

    const publicRecord = publicMessage(message);

    emitMessageEvent({
      workspaceId: context.workspaceId,
      message: publicRecord,
      event: "message:new",
    });

    return publicRecord;
  }

  function editMessage(
    user,
    messageId,
    input = {}
  ) {
    const context = getContext(user);
    const body = cleanMessageBody(input.body);

    if (!body) {
      throw createError(
        400,
        "Message body is required."
      );
    }

    let updated = null;

    store.update((draft) => {
      const message = (
        draft.teamMessages || []
      ).find(
        (item) =>
          item.id === cleanId(messageId) &&
          item.workspaceId ===
            context.workspaceId
      );

      if (!message) {
        return;
      }

      if (
        message.senderId !== context.user.id
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

      const now = serverTimestamp();

      message.body = body;
      message.editedAt = now;
      message.updatedAt = now;

      updated = publicMessage(message);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_message_edited",
        entityType: "team_message",
        entityId: message.id,
      });
    });

    if (!updated) {
      throw createError(
        404,
        "Message not found."
      );
    }

    emitMessageEvent({
      workspaceId: context.workspaceId,
      message: updated,
      event: "message:updated",
    });

    return updated;
  }

  function deleteMessage(user, messageId) {
    const context = getContext(user);
    const canModerate = [
      "owner",
      "admin",
      "manager",
    ].includes(context.role);

    let deleted = null;

    store.update((draft) => {
      const message = (
        draft.teamMessages || []
      ).find(
        (item) =>
          item.id === cleanId(messageId) &&
          item.workspaceId ===
            context.workspaceId
      );

      if (!message) {
        return;
      }

      if (
        message.senderId !== context.user.id &&
        !canModerate
      ) {
        throw createError(
          403,
          "You cannot delete this message."
        );
      }

      const now = serverTimestamp();

      message.body = "";
      message.attachments = [];
      message.deletedAt = now;
      message.deletedBy = context.user.id;
      message.updatedAt = now;

      deleted = publicMessage(message);

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_message_deleted",
        entityType: "team_message",
        entityId: message.id,
      });
    });

    if (!deleted) {
      throw createError(
        404,
        "Message not found."
      );
    }

    emitMessageEvent({
      workspaceId: context.workspaceId,
      message: deleted,
      event: "message:deleted",
    });

    return deleted;
  }

  function markMessageRead(user, messageId) {
    const context = getContext(user);
    const state = store.read();

    const message = requireMessage({
      state,
      workspaceId: context.workspaceId,
      messageId,
    });

    validateMessageAccess({
      state,
      message,
      workspaceId: context.workspaceId,
      userId: context.user.id,
    });

    const receipt = createOrUpdateReadReceipt({
      workspaceId: context.workspaceId,
      messageId: message.id,
      userId: context.user.id,
    });

    if (message.senderId !== context.user.id) {
      socketService?.emitToUser?.({
        workspaceId: context.workspaceId,
        userId: message.senderId,
        event: "message:read",
        payload: receipt,
      });
    }

    return receipt;
  }

  function markConversationRead(
    user,
    input = {}
  ) {
    const context = getContext(user);
    const state = store.read();

    const channelId = cleanId(input.channelId);
    const otherUserId = cleanId(input.userId);

    if (
      Boolean(channelId) ===
      Boolean(otherUserId)
    ) {
      throw createError(
        400,
        "Specify either a channel or direct-message user."
      );
    }

    if (channelId) {
      const channel = requireChannel({
        state,
        workspaceId: context.workspaceId,
        channelId,
      });

      requireChannelAccess(
        channel,
        context.user.id
      );
    }

    if (otherUserId) {
      requireWorkspaceMember({
        state,
        workspaceId: context.workspaceId,
        userId: otherUserId,
      });
    }

    const messages = (
      state.teamMessages || []
    ).filter((message) => {
      if (
        message.workspaceId !==
        context.workspaceId
      ) {
        return false;
      }

      if (channelId) {
        return (
          message.channelId === channelId &&
          message.senderId !== context.user.id
        );
      }

      return (
        !message.channelId &&
        message.senderId === otherUserId &&
        message.recipientUserId ===
          context.user.id
      );
    });

    const now = serverTimestamp();
    let markedCount = 0;

    store.update((draft) => {
      draft.teamMessageReads =
        ensureArray(draft.teamMessageReads);

      for (const message of messages) {
        const existing =
          draft.teamMessageReads.find(
            (receipt) =>
              receipt.workspaceId ===
                context.workspaceId &&
              receipt.messageId === message.id &&
              receipt.userId === context.user.id
          );

        if (existing) {
          existing.readAt = now;
          continue;
        }

        draft.teamMessageReads.push({
          id: crypto.randomUUID(),
          workspaceId: context.workspaceId,
          messageId: message.id,
          userId: context.user.id,
          readAt: now,
          createdAt: now,
        });

        markedCount += 1;
      }
    });

    return {
      markedCount,
      readAt: now,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Shared resources                                                   */
  /* ------------------------------------------------------------------ */

  function listSharedResources(
    user,
    filters = {}
  ) {
    const context = getContext(user);
    const state = store.read();

    const channelId = cleanId(filters.channelId);

    if (channelId) {
      const channel = requireChannel({
        state,
        workspaceId: context.workspaceId,
        channelId,
      });

      requireChannelAccess(
        channel,
        context.user.id
      );
    }

    return (state.teamSharedResources || [])
      .filter(
        (resource) =>
          resource.workspaceId ===
            context.workspaceId &&
          resource.deletedAt === "" &&
          (
            !channelId ||
            resource.channelId === channelId
          ) &&
          (
            !filters.type ||
            resource.type ===
              normalizeResourceType(filters.type)
          )
      )
      .filter((resource) =>
        resource.channelId
          ? canAccessChannel(
              (state.teamChannels || []).find(
                (channel) =>
                  channel.id === resource.channelId
              ),
              context.user.id
            )
          : true
      )
      .sort((a, b) =>
        String(b.createdAt).localeCompare(
          String(a.createdAt)
        )
      )
      .map(publicResource);
  }

  function createSharedResource(
    user,
    input = {}
  ) {
    const context = getContext(user);
    const state = store.read();

    const name = cleanText(input.name).slice(
      0,
      MAX_RESOURCE_NAME_LENGTH
    );

    const url = validateResourceUrl(input.url);
    const channelId = cleanId(input.channelId);

    if (!name || !url) {
      throw createError(
        400,
        "Resource name and URL are required."
      );
    }

    if (channelId) {
      const channel = requireChannel({
        state,
        workspaceId: context.workspaceId,
        channelId,
      });

      requireChannelAccess(
        channel,
        context.user.id
      );
    }

    const now = serverTimestamp();

    const resource = {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      channelId,

      name,
      description: cleanText(
        input.description
      ).slice(0, 1000),

      type: normalizeResourceType(input.type),
      url,

      createdBy: context.user.id,
      createdByName: context.user.name,

      deletedAt: "",
      deletedBy: "",

      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      draft.teamSharedResources =
        ensureArray(
          draft.teamSharedResources
        );

      draft.teamSharedResources.unshift(
        resource
      );

      addActivity(draft, {
        workspaceId: context.workspaceId,
        userId: context.user.id,
        action: "team_resource_created",
        entityType: "team_resource",
        entityId: resource.id,
      });
    });

    emitWorkspace(context.workspaceId, {
      event: "resource:created",
      payload: {
        resource: publicResource(resource),
      },
    });

    return publicResource(resource);
  }

  function updateSharedResource(
    user,
    resourceId,
    input = {}
  ) {
    const context = getContext(user);
    let updated = null;

    store.update((draft) => {
      const resource = (
        draft.teamSharedResources || []
      ).find(
        (item) =>
          item.id === cleanId(resourceId) &&
          item.workspaceId ===
            context.workspaceId &&
          !item.deletedAt
      );

      if (!resource) {
        return;
      }

      const canManage =
        resource.createdBy === context.user.id ||
        ["owner", "admin", "manager"].includes(
          context.role
        );

      if (!canManage) {
        throw createError(
          403,
          "You cannot update this resource."
        );
      }

      if (input.name !== undefined) {
        const name = cleanText(input.name).slice(
          0,
          MAX_RESOURCE_NAME_LENGTH
        );

        if (!name) {
          throw createError(
            400,
            "Resource name cannot be empty."
          );
        }

        resource.name = name;
      }

      if (input.description !== undefined) {
        resource.description = cleanText(
          input.description
        ).slice(0, 1000);
      }

      if (input.url !== undefined) {
        resource.url = validateResourceUrl(
          input.url
        );
      }

      if (input.type !== undefined) {
        resource.type = normalizeResourceType(
          input.type
        );
      }

      resource.updatedAt = serverTimestamp();
      updated = publicResource(resource);
    });

    if (!updated) {
      throw createError(
        404,
        "Shared resource not found."
      );
    }

    emitWorkspace(context.workspaceId, {
      event: "resource:updated",
      payload: {
        resource: updated,
      },
    });

    return updated;
  }

  function deleteSharedResource(
    user,
    resourceId
  ) {
    const context = getContext(user);
    let deleted = null;

    store.update((draft) => {
      const resource = (
        draft.teamSharedResources || []
      ).find(
        (item) =>
          item.id === cleanId(resourceId) &&
          item.workspaceId ===
            context.workspaceId &&
          !item.deletedAt
      );

      if (!resource) {
        return;
      }

      const canManage =
        resource.createdBy === context.user.id ||
        ["owner", "admin", "manager"].includes(
          context.role
        );

      if (!canManage) {
        throw createError(
          403,
          "You cannot delete this resource."
        );
      }

      const now = serverTimestamp();

      resource.deletedAt = now;
      resource.deletedBy = context.user.id;
      resource.updatedAt = now;

      deleted = publicResource(resource);
    });

    if (!deleted) {
      throw createError(
        404,
        "Shared resource not found."
      );
    }

    emitWorkspace(context.workspaceId, {
      event: "resource:deleted",
      payload: {
        resourceId: deleted.id,
      },
    });

    return deleted;
  }

  /* ------------------------------------------------------------------ */
  /* Internal call history                                              */
  /* ------------------------------------------------------------------ */

  function listInternalCalls(
    user,
    filters = {}
  ) {
    const context = getContext(user);
    const limit = clampNumber(
      filters.limit,
      1,
      200,
      50
    );

    const targetUserId = cleanId(
      filters.userId
    );

    if (
      targetUserId &&
      targetUserId !== context.user.id &&
      !["owner", "admin", "manager"].includes(
        context.role
      )
    ) {
      throw createError(
        403,
        "You cannot view another member's call history."
      );
    }

    return (store.read().teamCalls || [])
      .filter(
        (call) =>
          call.workspaceId ===
            context.workspaceId
      )
      .filter((call) => {
        if (targetUserId) {
          return (
            call.participantUserIds || []
          ).includes(targetUserId);
        }

        if (
          ["owner", "admin", "manager"].includes(
            context.role
          )
        ) {
          return true;
        }

        return (
          call.participantUserIds || []
        ).includes(context.user.id);
      })
      .filter(
        (call) =>
          !filters.channelId ||
          call.channelId ===
            cleanId(filters.channelId)
      )
      .sort((a, b) =>
        String(b.startedAt).localeCompare(
          String(a.startedAt)
        )
      )
      .slice(0, limit)
      .map(publicCall);
  }

  function getInternalCall(user, callId) {
    const context = getContext(user);

    const call = (
      store.read().teamCalls || []
    ).find(
      (item) =>
        item.id === cleanId(callId) &&
        item.workspaceId ===
          context.workspaceId
    );

    if (!call) {
      throw createError(
        404,
        "Internal call not found."
      );
    }

    const canViewAll = [
      "owner",
      "admin",
      "manager",
    ].includes(context.role);

    const isParticipant = (
      call.participantUserIds || []
    ).includes(context.user.id);

    if (!canViewAll && !isParticipant) {
      throw createError(
        403,
        "You cannot view this call."
      );
    }

    return publicCall(call);
  }

  /* ------------------------------------------------------------------ */
  /* Unread and search                                                  */
  /* ------------------------------------------------------------------ */

  function getUnreadSummary(user) {
    const context = getContext(user);
    const state = store.read();

    const receipts = new Set(
      (state.teamMessageReads || [])
        .filter(
          (receipt) =>
            receipt.workspaceId ===
              context.workspaceId &&
            receipt.userId === context.user.id
        )
        .map((receipt) => receipt.messageId)
    );

    const channelCounts = {};
    const directCounts = {};

    let total = 0;

    for (const message of state.teamMessages || []) {
      if (
        message.workspaceId !==
          context.workspaceId ||
        message.senderId === context.user.id ||
        message.deletedAt ||
        receipts.has(message.id)
      ) {
        continue;
      }

      if (message.channelId) {
        const channel = (
          state.teamChannels || []
        ).find(
          (item) =>
            item.id === message.channelId
        );

        if (
          !channel ||
          !canAccessChannel(
            channel,
            context.user.id
          )
        ) {
          continue;
        }

        channelCounts[message.channelId] =
          (channelCounts[message.channelId] ||
            0) + 1;

        total += 1;
        continue;
      }

      if (
        message.recipientUserId ===
        context.user.id
      ) {
        directCounts[message.senderId] =
          (directCounts[message.senderId] ||
            0) + 1;

        total += 1;
      }
    }

    return {
      total,
      channels: channelCounts,
      direct: directCounts,
    };
  }

  function searchMessages(
    user,
    filters = {}
  ) {
    const context = getContext(user);
    const state = store.read();

    const query = normalizeSearchText(
      filters.query
    );

    if (query.length < 2) {
      return [];
    }

    const limit = clampNumber(
      filters.limit,
      1,
      100,
      30
    );

    const channelId = cleanId(
      filters.channelId
    );

    const userId = cleanId(filters.userId);

    if (channelId) {
      const channel = requireChannel({
        state,
        workspaceId: context.workspaceId,
        channelId,
      });

      requireChannelAccess(
        channel,
        context.user.id
      );
    }

    return (state.teamMessages || [])
      .filter(
        (message) =>
          message.workspaceId ===
            context.workspaceId &&
          !message.deletedAt &&
          normalizeSearchText(
            message.body
          ).includes(query)
      )
      .filter(
        (message) =>
          !channelId ||
          message.channelId === channelId
      )
      .filter((message) => {
        if (!userId) {
          return true;
        }

        return (
          message.senderId === userId ||
          message.recipientUserId === userId
        );
      })
      .filter((message) =>
        canViewMessage({
          state,
          message,
          workspaceId: context.workspaceId,
          userId: context.user.id,
        })
      )
      .sort((a, b) =>
        String(b.createdAt).localeCompare(
          String(a.createdAt)
        )
      )
      .slice(0, limit)
      .map(publicMessage);
  }

  /* ------------------------------------------------------------------ */
  /* Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  function initializeCollections() {
    store.update((draft) => {
      draft.teamChannels =
        ensureArray(draft.teamChannels);

      draft.teamMessages =
        ensureArray(draft.teamMessages);

      draft.teamMessageReads =
        ensureArray(draft.teamMessageReads);

      draft.teamCalls =
        ensureArray(draft.teamCalls);

      draft.teamPresence =
        ensureArray(draft.teamPresence);

      draft.teamSharedResources =
        ensureArray(
          draft.teamSharedResources
        );

      draft.activity = ensureArray(
        draft.activity
      );

      const workspaceIds = uniqueIds(
        (draft.users || [])
          .map((user) => user.workspaceId)
          .filter(Boolean)
      );

      for (const workspaceId of workspaceIds) {
        const existing =
          draft.teamChannels.find(
            (channel) =>
              channel.workspaceId ===
                workspaceId &&
              channel.isDefault &&
              channel.active !== false
          );

        if (existing) {
          continue;
        }

        const members = (draft.users || [])
          .filter(
            (user) =>
              user.workspaceId ===
                workspaceId &&
              user.active !== false
          )
          .map((user) => user.id);

        const owner = (draft.users || []).find(
          (user) =>
            user.workspaceId ===
              workspaceId &&
            normalizeRole(
              user.workspaceRole || user.role
            ) === "owner"
        );

        const now = serverTimestamp();

        draft.teamChannels.push({
          id: crypto.randomUUID(),
          workspaceId,

          name: "General",
          slug: "general",
          description:
            "Workspace-wide team communication.",

          type: "public",
          memberUserIds: members,

          createdBy: owner?.id || "",
          createdByName: owner?.name || "",

          active: true,
          isDefault: true,

          createdAt: now,
          updatedAt: now,
        });
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
        role: normalizeRole(
          user.workspaceRole || user.role
        ),
        permissions: user.permissions || [],
      };

    if (!context.workspaceId) {
      throw createError(
        403,
        "The account is not connected to a workspace."
      );
    }

    return {
      ...context,
      role: normalizeRole(context.role),
      user: context.user || user,
    };
  }

  function requireChannelManagement(user) {
    const context = getContext(user);

    if (
      !["owner", "admin", "manager"].includes(
        context.role
      )
    ) {
      throw createError(
        403,
        "Only an owner, administrator, or manager can manage team channels."
      );
    }

    return context;
  }

  function emitMessageEvent({
    workspaceId,
    message,
    event,
  }) {
    if (message.channelId) {
      socketService?.emitToChannel?.({
        workspaceId,
        channelId: message.channelId,
        event,
        payload: {
          message,
        },
      });

      return;
    }

    socketService?.emitToUser?.({
      workspaceId,
      userId: message.senderId,
      event,
      payload: {
        message,
      },
    });

    socketService?.emitToUser?.({
      workspaceId,
      userId: message.recipientUserId,
      event,
      payload: {
        message,
      },
    });
  }

  function emitWorkspace(
    workspaceId,
    { event, payload }
  ) {
    socketService?.emitToWorkspace?.({
      workspaceId,
      event,
      payload,
    });
  }

  function createOrUpdateReadReceipt({
    workspaceId,
    messageId,
    userId,
  }) {
    const now = serverTimestamp();
    let result = null;

    store.update((draft) => {
      draft.teamMessageReads =
        ensureArray(draft.teamMessageReads);

      let receipt =
        draft.teamMessageReads.find(
          (item) =>
            item.workspaceId === workspaceId &&
            item.messageId === messageId &&
            item.userId === userId
        );

      if (!receipt) {
        receipt = {
          id: crypto.randomUUID(),
          workspaceId,
          messageId,
          userId,
          createdAt: now,
          readAt: now,
        };

        draft.teamMessageReads.push(receipt);
      } else {
        receipt.readAt = now;
      }

      result = { ...receipt };
    });

    return result;
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function enrichChannel({
  channel,
  state,
  currentUserId,
}) {
  const messages = (
    state.teamMessages || []
  )
    .filter(
      (message) =>
        message.workspaceId ===
          channel.workspaceId &&
        message.channelId === channel.id
    )
    .sort((a, b) =>
      String(b.createdAt).localeCompare(
        String(a.createdAt)
      )
    );

  const lastMessage = messages[0] || null;

  const unreadCount = messages.filter(
    (message) =>
      message.senderId !== currentUserId &&
      !message.deletedAt &&
      !(state.teamMessageReads || []).some(
        (receipt) =>
          receipt.workspaceId ===
            channel.workspaceId &&
          receipt.messageId === message.id &&
          receipt.userId === currentUserId
      )
  ).length;

  return {
    ...publicChannel(channel),
    memberCount:
      channel.memberUserIds?.length || 0,
    lastMessage: lastMessage
      ? publicMessage(lastMessage)
      : null,
    lastMessageAt:
      lastMessage?.createdAt || "",
    unreadCount,
  };
}

function requireChannel({
  state,
  workspaceId,
  channelId,
}) {
  const channel = (
    state.teamChannels || []
  ).find(
    (item) =>
      item.id === cleanId(channelId) &&
      item.workspaceId === workspaceId &&
      item.active !== false
  );

  if (!channel) {
    throw createError(
      404,
      "Team channel not found."
    );
  }

  return channel;
}

function requireChannelAccess(
  channel,
  userId
) {
  if (!canAccessChannel(channel, userId)) {
    throw createError(
      403,
      "You do not have access to this channel."
    );
  }

  return channel;
}

function canAccessChannel(
  channel,
  userId
) {
  if (!channel || channel.active === false) {
    return false;
  }

  if (channel.type === "public") {
    return true;
  }

  return (channel.memberUserIds || []).includes(
    userId
  );
}

function requireWorkspaceMember({
  state,
  workspaceId,
  userId,
}) {
  const member = (state.users || []).find(
    (item) =>
      item.id === cleanId(userId) &&
      item.workspaceId === workspaceId &&
      item.active !== false
  );

  if (!member) {
    throw createError(
      404,
      "Workspace member not found."
    );
  }

  return member;
}

function requireMessage({
  state,
  workspaceId,
  messageId,
}) {
  const message = (
    state.teamMessages || []
  ).find(
    (item) =>
      item.id === cleanId(messageId) &&
      item.workspaceId === workspaceId
  );

  if (!message) {
    throw createError(
      404,
      "Message not found."
    );
  }

  return message;
}

function validateMessageAccess({
  state,
  message,
  workspaceId,
  userId,
}) {
  if (message.channelId) {
    const channel = requireChannel({
      state,
      workspaceId,
      channelId: message.channelId,
    });

    requireChannelAccess(channel, userId);
    return;
  }

  if (
    message.senderId !== userId &&
    message.recipientUserId !== userId
  ) {
    throw createError(
      403,
      "You do not have access to this message."
    );
  }
}

function canViewMessage({
  state,
  message,
  workspaceId,
  userId,
}) {
  try {
    validateMessageAccess({
      state,
      message,
      workspaceId,
      userId,
    });

    return true;
  } catch {
    return false;
  }
}

function validateReplyTarget({
  replyMessage,
  channelId,
  recipientUserId,
  currentUserId,
}) {
  if (channelId) {
    if (replyMessage.channelId !== channelId) {
      throw createError(
        400,
        "The replied message belongs to a different channel."
      );
    }

    return;
  }

  const replyParticipants = new Set([
    replyMessage.senderId,
    replyMessage.recipientUserId,
  ]);

  if (
    !replyParticipants.has(currentUserId) ||
    !replyParticipants.has(recipientUserId)
  ) {
    throw createError(
      400,
      "The replied message belongs to a different conversation."
    );
  }
}

function countUnreadDirectMessages({
  state,
  workspaceId,
  currentUserId,
  otherUserId,
}) {
  return (state.teamMessages || []).filter(
    (message) =>
      message.workspaceId === workspaceId &&
      !message.channelId &&
      message.senderId === otherUserId &&
      message.recipientUserId ===
        currentUserId &&
      !message.deletedAt &&
      !(state.teamMessageReads || []).some(
        (receipt) =>
          receipt.workspaceId === workspaceId &&
          receipt.messageId === message.id &&
          receipt.userId === currentUserId
      )
  ).length;
}

function publicChannel(channel) {
  return {
    id: channel.id,
    workspaceId: channel.workspaceId,

    name: channel.name,
    slug: channel.slug,
    description: channel.description || "",

    type: channel.type,
    memberUserIds:
      channel.memberUserIds || [],

    createdBy: channel.createdBy || "",
    createdByName:
      channel.createdByName || "",

    active: channel.active !== false,
    isDefault: Boolean(channel.isDefault),

    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    workspaceId: message.workspaceId,

    channelId: message.channelId || "",
    recipientUserId:
      message.recipientUserId || "",

    senderId: message.senderId,
    senderName: message.senderName || "",
    senderAvatar:
      message.senderAvatar || "",

    body: message.deletedAt
      ? ""
      : message.body || "",

    attachments: message.deletedAt
      ? []
      : message.attachments || [],

    replyToMessageId:
      message.replyToMessageId || "",

    clientMessageId:
      message.clientMessageId || "",

    editedAt: message.editedAt || "",
    deletedAt: message.deletedAt || "",

    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function publicMember(member) {
  return {
    id: member.id,
    name: member.name || "",
    email: member.email || "",

    role: normalizeRole(
      member.workspaceRole || member.role
    ),

    jobTitle: member.jobTitle || "",
    phone: member.phone || "",

    avatarUrl: getAvatar(member),

    timezone: member.timezone || "UTC",
    availabilityStatus:
      member.availabilityStatus ||
      "available",

    managerId: member.managerId || "",

    active: member.active !== false,
  };
}

function publicResource(resource) {
  return {
    id: resource.id,
    workspaceId: resource.workspaceId,
    channelId: resource.channelId || "",

    name: resource.name,
    description: resource.description || "",
    type: resource.type,
    url: resource.url,

    createdBy: resource.createdBy,
    createdByName:
      resource.createdByName || "",

    deletedAt: resource.deletedAt || "",

    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function publicCall(call) {
  const startedAt = Date.parse(
    call.startedAt || call.createdAt
  );

  const endedAt = Date.parse(call.endedAt);

  return {
    id: call.id,
    workspaceId: call.workspaceId,
    channelId: call.channelId || "",

    initiatedBy: call.initiatedBy,
    initiatedByName:
      call.initiatedByName || "",

    callType: call.callType || "audio",
    status: call.status || "unknown",

    participantUserIds:
      call.participantUserIds || [],

    participants: call.participants || [],

    startedAt: call.startedAt || "",
    answeredAt: call.answeredAt || "",
    endedAt: call.endedAt || "",
    endReason: call.endReason || "",

    durationSeconds:
      Number.isFinite(startedAt) &&
      Number.isFinite(endedAt)
        ? Math.max(
            0,
            Math.round(
              (endedAt - startedAt) / 1000
            )
          )
        : 0,

    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
}

function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .slice(0, 10)
    .map((attachment) => ({
      id:
        cleanId(attachment?.id) ||
        crypto.randomUUID(),

      name: cleanText(
        attachment?.name
      ).slice(0, 180),

      url: cleanText(
        attachment?.url
      ).slice(0, 2000),

      mimeType: cleanText(
        attachment?.mimeType
      ).slice(0, 120),

      size: Math.max(
        0,
        Number(attachment?.size || 0)
      ),
    }))
    .filter(
      (attachment) =>
        attachment.name && attachment.url
    );
}

function validateResourceUrl(value) {
  const raw = cleanText(value);

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);

    if (
      !["http:", "https:"].includes(
        url.protocol
      )
    ) {
      throw new Error();
    }

    return url.toString();
  } catch {
    throw createError(
      400,
      "Resource URL must be a valid HTTP or HTTPS URL."
    );
  }
}

function normalizeChannelType(value) {
  const type = cleanText(value).toLowerCase();

  if (type === "public") {
    return "public";
  }

  if (type === "private") {
    return "private";
  }

  return "private";
}

function normalizeResourceType(value) {
  const type = cleanText(value).toLowerCase();

  if (
    [
      "document",
      "link",
      "training",
      "script",
      "policy",
      "template",
      "other",
    ].includes(type)
  ) {
    return type;
  }

  return "link";
}

function createUniqueChannelSlug({
  state,
  workspaceId,
  name,
}) {
  const base =
    normalizeSearchText(name)
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "channel";

  const existing = new Set(
    (state.teamChannels || [])
      .filter(
        (channel) =>
          channel.workspaceId === workspaceId
      )
      .map((channel) => channel.slug)
  );

  if (!existing.has(base)) {
    return base;
  }

  let number = 2;

  while (existing.has(`${base}-${number}`)) {
    number += 1;
  }

  return `${base}-${number}`;
}

function addActivity(
  draft,
  {
    workspaceId,
    userId,
    action,
    entityType,
    entityId,
    metadata = {},
  }
) {
  draft.activity = ensureArray(draft.activity);

  draft.activity.unshift({
    id: crypto.randomUUID(),
    workspaceId,
    userId,
    type: action,
    action,
    entityType,
    entityId,
    metadata,
    createdAt: serverTimestamp(),
  });

  if (draft.activity.length > 20_000) {
    draft.activity.length = 20_000;
  }
}

function getAvatar(user) {
  return (
    user.avatarUrl ||
    user.profileImageUrl ||
    user.photoUrl ||
    ""
  );
}

function normalizeRole(value) {
  const role = cleanText(value).toLowerCase();

  if (
    ["owner", "admin", "manager", "caller", "viewer"].includes(
      role
    )
  ) {
    return role;
  }

  if (role.includes("owner")) return "owner";
  if (role.includes("admin")) return "admin";
  if (role.includes("manager")) return "manager";
  if (role.includes("caller")) return "caller";

  return "viewer";
}

function cleanMessageBody(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim();
}

function cleanId(value) {
  return cleanText(value).slice(0, 160);
}

function normalizeSearchText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(cleanId)
        .filter(Boolean)
    ),
  ];
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseTimestamp(value) {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

function clampNumber(
  value,
  minimum,
  maximum,
  fallback
) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(
    minimum,
    Math.min(maximum, Math.floor(number))
  );
}

function serverTimestamp() {
  return new Date().toISOString();
}

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function defaultAsyncRoute(handler) {
  return function asyncRouteHandler(
    req,
    res,
    next
  ) {
    Promise.resolve(handler(req, res, next)).catch(
      next
    );
  };
}