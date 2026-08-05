// apps/api/src/team-communication-service.js

import crypto from "node:crypto";

const MANAGER_ROLES = new Set([
  "owner",
  "admin",
  "manager",
]);

const CHANNEL_TYPES = new Set([
  "direct",
  "group",
  "team",
]);

const MESSAGE_TYPES = new Set([
  "text",
  "message",
  "image",
  "file",
  "lead",
  "task",
  "system",
]);

const TASK_STATUSES = new Set([
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);

const TASK_PRIORITIES = new Set([
  "low",
  "normal",
  "high",
  "urgent",
]);

const CALL_STATUSES = new Set([
  "ringing",
  "accepted",
  "rejected",
  "ended",
  "missed",
  "failed",
]);

export function createTeamCommunicationService({
  store,
  workspaceService,
} = {}) {
  if (!store) {
    throw new Error(
      "createTeamCommunicationService requires a store."
    );
  }

  function context(user) {
    const result =
      workspaceService?.getContext?.(
        user,
        store.read()
      ) || {
        workspaceId:
          user?.workspaceId ||
          user?.id ||
          "",
        role:
          user?.workspaceRole ||
          user?.role ||
          "caller",
        permissions:
          user?.permissions ||
          [],
      };

    return {
      ...result,
      workspaceId: clean(
        result.workspaceId ||
          user?.workspaceId ||
          user?.id
      ),
      role: normalizeRole(
        result.role ||
          user?.workspaceRole ||
          user?.role
      ),
      permissions: Array.isArray(
        result.permissions
      )
        ? result.permissions
        : [],
    };
  }

  function requireWorkspace(user) {
    const ctx = context(user);

    if (!ctx.workspaceId) {
      throw httpError(
        403,
        "A workspace is required."
      );
    }

    return ctx;
  }

  function canManage(ctx) {
    return (
      MANAGER_ROLES.has(ctx.role) ||
      ctx.permissions.includes("*") ||
      ctx.permissions.includes(
        "manage_team"
      ) ||
      ctx.permissions.includes(
        "assign_leads"
      )
    );
  }

  function requireManager(user) {
    const ctx = requireWorkspace(user);

    if (!canManage(ctx)) {
      throw httpError(
        403,
        "Team management permission is required."
      );
    }

    return ctx;
  }

  function listWorkspaceMembers(user) {
    try {
      const result =
        workspaceService?.listMembers?.(
          user
        );

      if (Array.isArray(result)) {
        return result;
      }
    } catch {
      // Use the local store fallback.
    }

    const ctx = requireWorkspace(user);

    return (
      store.read().users || []
    ).filter((member) =>
      belongsToWorkspace(
        member,
        ctx.workspaceId
      )
    );
  }

  function ensureGeneral(workspaceId) {
    let channel = null;

    store.update((draft) => {
      draft.teamChannels =
        draft.teamChannels || [];

      channel =
        draft.teamChannels.find(
          (item) =>
            item.workspaceId ===
              workspaceId &&
            item.slug === "general" &&
            !item.archivedAt
        );

      if (channel) {
        return;
      }

      const timestamp = now();

      channel = {
        id: crypto.randomUUID(),
        workspaceId,
        type: "team",
        slug: "general",
        name: "General",
        description:
          "Workspace-wide operational communication.",
        memberIds: [],
        createdBy: "system",
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: "",
      };

      draft.teamChannels.unshift(
        channel
      );
    });

    return channel;
  }

  function canAccessChannel(
    user,
    channel
  ) {
    if (!channel) {
      return false;
    }

    const ctx = context(user);

    if (
      channel.workspaceId !==
        ctx.workspaceId ||
      channel.archivedAt
    ) {
      return false;
    }

    if (
      channel.type === "team" &&
      !channel.memberIds?.length
    ) {
      return true;
    }

    return (
      channel.memberIds?.includes(
        user.id
      ) ||
      channel.createdBy === user.id ||
      canManage(ctx)
    );
  }

  function requireChannel(
    user,
    channelId
  ) {
    const channel =
      (
        store.read().teamChannels ||
        []
      ).find(
        (item) =>
          item.id === channelId
      );

    if (
      !canAccessChannel(
        user,
        channel
      )
    ) {
      throw httpError(
        403,
        "You cannot access this conversation."
      );
    }

    return channel;
  }

  function listChannels(user) {
    const ctx = requireWorkspace(user);

    ensureGeneral(ctx.workspaceId);

    const state = store.read();

    const channels =
      state.teamChannels || [];

    const messages =
      state.teamMessages || [];

    const reads =
      state.teamChannelReads || [];

    const workspaceMembers =
      listWorkspaceMembers(user);

    return channels
      .filter((channel) =>
        canAccessChannel(
          user,
          channel
        )
      )
      .map((channel) => {
        const channelMessages =
          messages.filter(
            (message) =>
              message.channelId ===
                channel.id &&
              !message.deletedAt
          );

        const lastMessage =
          channelMessages.at(-1) ||
          null;

        const readRecord =
          reads.find(
            (record) =>
              record.channelId ===
                channel.id &&
              record.userId === user.id
          );

        const unreadCount =
          channelMessages.filter(
            (message) =>
              message.userId !==
                user.id &&
              (!readRecord?.readAt ||
                message.createdAt >
                  readRecord.readAt)
          ).length;

        const channelMembers =
          workspaceMembers.filter(
            (member) =>
              channel.memberIds?.includes(
                member.id
              )
          );

        const otherMember =
          channel.type === "direct"
            ? channelMembers.find(
                (member) =>
                  member.id !== user.id
              ) || null
            : null;

        return {
          ...channel,

          lastMessage:
            lastMessage
              ? enrichMessage(
                  state,
                  lastMessage
                )
              : null,

          unreadCount,

          members:
            channelMembers.map(
              sanitizeMember
            ),

          otherMember:
            otherMember
              ? sanitizeMember(
                  otherMember
                )
              : null,
        };
      })
      .sort(
        (left, right) =>
          dateValue(
            right.lastMessage
              ?.createdAt ||
              right.updatedAt
          ) -
          dateValue(
            left.lastMessage
              ?.createdAt ||
              left.updatedAt
          )
      );
  }

  function createChannel(
    user,
    input = {}
  ) {
    const ctx = requireWorkspace(user);

    const requestedType =
      normalizeStatus(
        input.type ||
          "team"
      );

    const type =
      requestedType === "direct"
        ? "direct"
        : requestedType === "group"
          ? "group"
          : "team";

    if (!CHANNEL_TYPES.has(type)) {
      throw httpError(
        400,
        "Invalid channel type."
      );
    }

    if (
      ["group", "team"].includes(
        type
      ) &&
      !canManage(ctx)
    ) {
      throw httpError(
        403,
        "Only owners, administrators, and managers can create group channels."
      );
    }

    const memberIds = [
      ...new Set(
        [
          user.id,
          ...(Array.isArray(
            input.memberIds
          )
            ? input.memberIds
            : []),
        ]
          .map(clean)
          .filter(Boolean)
      ),
    ];

    const workspaceMembers =
      listWorkspaceMembers(user);

    const validIds =
      new Set(
        workspaceMembers.map(
          (member) => member.id
        )
      );

    for (const memberId of memberIds) {
      if (!validIds.has(memberId)) {
        throw httpError(
          400,
          "One or more selected members do not belong to this workspace."
        );
      }
    }

    if (
      type === "direct" &&
      memberIds.length !== 2
    ) {
      throw httpError(
        400,
        "A direct conversation requires exactly two members."
      );
    }

    const currentState = store.read();

    if (type === "direct") {
      const existing =
        (
          currentState.teamChannels ||
          []
        ).find(
          (channel) =>
            channel.workspaceId ===
              ctx.workspaceId &&
            channel.type ===
              "direct" &&
            !channel.archivedAt &&
            sameMembers(
              channel.memberIds || [],
              memberIds
            )
        );

      if (existing) {
        return enrichChannel(
          user,
          existing,
          currentState
        );
      }
    }

    const timestamp = now();

    const channel = {
      id: crypto.randomUUID(),
      workspaceId:
        ctx.workspaceId,
      type,

      slug:
        type === "direct"
          ? ""
          : slugify(
              input.name ||
                "team-channel"
            ),

      name:
        clean(input.name) ||
        (type === "direct"
          ? "Direct conversation"
          : "Team channel"),

      description:
        clean(
          input.description
        ),

      memberIds,
      createdBy: user.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: "",
    };

    store.update((draft) => {
      draft.teamChannels =
        draft.teamChannels || [];

      draft.teamChannels.unshift(
        channel
      );
    });

    return enrichChannel(
      user,
      channel,
      store.read()
    );
  }

  function updateChannel(
    user,
    channelId,
    patch = {}
  ) {
    const ctx = requireWorkspace(user);

    let updated = null;

    store.update((draft) => {
      draft.teamChannels =
        draft.teamChannels || [];

      const channel =
        draft.teamChannels.find(
          (item) =>
            item.id === channelId &&
            item.workspaceId ===
              ctx.workspaceId
        );

      if (!channel) {
        throw httpError(
          404,
          "Conversation not found."
        );
      }

      if (
        !canManage(ctx) &&
        channel.createdBy !== user.id
      ) {
        throw httpError(
          403,
          "You cannot update this conversation."
        );
      }

      if (
        patch.name !== undefined
      ) {
        channel.name =
          clean(patch.name) ||
          channel.name;
      }

      if (
        patch.description !==
        undefined
      ) {
        channel.description =
          clean(
            patch.description
          );
      }

      if (
        patch.memberIds !==
        undefined
      ) {
        if (
          channel.type ===
          "direct"
        ) {
          throw httpError(
            400,
            "Direct conversation members cannot be changed."
          );
        }

        const nextMemberIds = [
          ...new Set(
            [
              user.id,
              ...(Array.isArray(
                patch.memberIds
              )
                ? patch.memberIds
                : []),
            ]
              .map(clean)
              .filter(Boolean)
          ),
        ];

        const validIds =
          new Set(
            listWorkspaceMembers(
              user
            ).map(
              (member) =>
                member.id
            )
          );

        for (const memberId of nextMemberIds) {
          if (
            !validIds.has(
              memberId
            )
          ) {
            throw httpError(
              400,
              "One or more selected members do not belong to this workspace."
            );
          }
        }

        channel.memberIds =
          nextMemberIds;
      }

      channel.updatedAt = now();

      updated = {
        ...channel,
      };
    });

    return enrichChannel(
      user,
      updated,
      store.read()
    );
  }

  function archiveChannel(
    user,
    channelId
  ) {
    const ctx = requireManager(user);

    let archived = null;

    store.update((draft) => {
      draft.teamChannels =
        draft.teamChannels || [];

      const channel =
        draft.teamChannels.find(
          (item) =>
            item.id === channelId &&
            item.workspaceId ===
              ctx.workspaceId
        );

      if (!channel) {
        throw httpError(
          404,
          "Conversation not found."
        );
      }

      if (
        channel.slug === "general"
      ) {
        throw httpError(
          400,
          "The General channel cannot be archived."
        );
      }

      channel.archivedAt = now();
      channel.updatedAt =
        channel.archivedAt;

      archived = {
        ...channel,
      };
    });

    return archived;
  }

  function listMessages(
    user,
    channelId,
    query = {}
  ) {
    requireChannel(
      user,
      channelId
    );

    const state = store.read();

    const limit = clampInteger(
      query.limit,
      1,
      250,
      100
    );

    return (
      state.teamMessages || []
    )
      .filter(
        (message) =>
          message.channelId ===
            channelId &&
          !message.deletedAt
      )
      .slice(-limit)
      .map((message) =>
        enrichMessage(
          state,
          message
        )
      );
  }

  function sendMessage(
    user,
    channelId,
    input = {}
  ) {
    const channel =
      requireChannel(
        user,
        channelId
      );

    const body = clean(input.body);

    const attachments =
      normalizeAttachments(
        input.attachments
      );

    const metadata =
      normalizeMetadata(
        input.metadata
      );

    const type =
      normalizeMessageType(
        input.type
      );

    if (
      !body &&
      !attachments.length &&
      type !== "system"
    ) {
      throw httpError(
        400,
        "Message text or an attachment is required."
      );
    }

    if (body.length > 8000) {
      throw httpError(
        400,
        "Messages are limited to 8,000 characters."
      );
    }

    const timestamp = now();

    const message = {
      id: crypto.randomUUID(),
      workspaceId:
        channel.workspaceId,
      channelId,

      userId: user.id,
      authorId: user.id,

      authorName:
        clean(
          user.name ||
            user.fullName ||
            user.email
        ),

      authorRole:
        context(user).role,

      authorAvatarUrl:
        clean(
          user.avatarUrl ||
            user.photoUrl ||
            user.profileImage
        ),

      body,
      type,

      taskId:
        clean(input.taskId),

      leadId:
        clean(
          input.leadId ||
            metadata.leadId
        ),

      attachments,
      metadata,

      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: "",
    };

    store.update((draft) => {
      draft.teamMessages =
        draft.teamMessages || [];

      draft.teamMessages.push(
        message
      );

      draft.teamChannels =
        draft.teamChannels || [];

      const targetChannel =
        draft.teamChannels.find(
          (item) =>
            item.id === channelId
        );

      if (targetChannel) {
        targetChannel.updatedAt =
          timestamp;
      }
    });

    return enrichMessage(
      store.read(),
      message
    );
  }

  function deleteMessage(
    user,
    channelId,
    messageId
  ) {
    const ctx = requireWorkspace(user);

    requireChannel(
      user,
      channelId
    );

    let removed = null;

    store.update((draft) => {
      draft.teamMessages =
        draft.teamMessages || [];

      const message =
        draft.teamMessages.find(
          (item) =>
            item.id === messageId &&
            item.channelId ===
              channelId &&
            item.workspaceId ===
              ctx.workspaceId
        );

      if (!message) {
        throw httpError(
          404,
          "Message not found."
        );
      }

      if (
        message.userId !== user.id &&
        !canManage(ctx)
      ) {
        throw httpError(
          403,
          "You cannot delete this message."
        );
      }

      message.deletedAt = now();
      message.updatedAt =
        message.deletedAt;

      removed = {
        ...message,
      };
    });

    return removed;
  }

  function markRead(
    user,
    channelId
  ) {
    const channel =
      requireChannel(
        user,
        channelId
      );

    const record = {
      workspaceId:
        channel.workspaceId,
      channelId,
      userId: user.id,
      readAt: now(),
    };

    store.update((draft) => {
      draft.teamChannelReads =
        draft.teamChannelReads ||
        [];

      const index =
        draft.teamChannelReads.findIndex(
          (item) =>
            item.channelId ===
              channelId &&
            item.userId === user.id
        );

      if (index >= 0) {
        draft.teamChannelReads[
          index
        ] = record;
      } else {
        draft.teamChannelReads.push(
          record
        );
      }
    });

    return record;
  }

  function registerAttachment(
    user,
    channelId,
    input = {}
  ) {
    const channel =
      requireChannel(
        user,
        channelId
      );

    const url = clean(
      input.url ||
        input.path
    );

    if (!url) {
      throw httpError(
        400,
        "An attachment URL is required."
      );
    }

    const attachment = {
      id: crypto.randomUUID(),
      workspaceId:
        channel.workspaceId,
      channelId,
      uploadedBy: user.id,

      name:
        clean(
          input.name ||
            input.filename ||
            "Attachment"
        ),

      url,
      path:
        clean(input.path),

      mimeType:
        clean(
          input.mimeType ||
            input.type
        ),

      size: Math.max(
        0,
        Number(input.size || 0)
      ),

      createdAt: now(),
    };

    store.update((draft) => {
      draft.teamAttachments =
        draft.teamAttachments ||
        [];

      draft.teamAttachments.push(
        attachment
      );
    });

    return attachment;
  }

  function listPresence(user) {
    const ctx = requireWorkspace(user);
    const state = store.read();
    const presenceRecords = state.teamPresence || [];

    return listWorkspaceMembers(user).map((member) => {
      const record = presenceRecords.find(
        (item) =>
          item.workspaceId === ctx.workspaceId &&
          item.userId === member.id
      );

      const avatarUrl =
        member.avatarUrl ||
        member.photoUrl ||
        member.profileImage ||
        record?.avatarUrl ||
        "";

      return {
        id: member.id,
        userId: member.id,
        name: member.name || member.email || "Team member",
        email: member.email || "",
        avatarUrl,
        photoUrl: avatarUrl,
        profileImage: avatarUrl,
        role: normalizeRole(member.workspaceRole || member.role),
        workspaceRole: normalizeRole(member.workspaceRole || member.role),
        connectionStatus: record?.connectionStatus || "offline",
        status:
          record?.status ||
          member.availabilityStatus ||
          "offline",
        availabilityStatus:
          record?.status ||
          member.availabilityStatus ||
          "offline",
        availabilityMessage:
          record?.message ||
          member.availabilityMessage ||
          "",
        lastSeenAt: record?.lastSeenAt || member.updatedAt || "",
        updatedAt: record?.updatedAt || member.updatedAt || "",
      };
    });
  }

  function updatePresence(user, input) {
    const ctx = requireWorkspace(user);
    const state = store.read();
    const currentUser = (state.users || []).find((item) => item.id === user.id) || user;
    const previous = (state.teamPresence || []).find(
      (item) =>
        item.workspaceId === ctx.workspaceId &&
        item.userId === user.id
    );

    const payload =
      input && typeof input === "object"
        ? input
        : { connectionStatus: input };

    const requestedStatus = payload.status || payload.availabilityStatus;
    const connectionStatus = normalizePresenceStatus(
      payload.connectionStatus ||
      (typeof input === "string" ? input : previous?.connectionStatus || "online")
    );

    const manualStatuses = new Set(["available", "busy", "on_call", "on_break", "away"]);
    const previousStatus = normalizePresenceStatus(
      previous?.status || currentUser.availabilityStatus || "offline"
    );

    const status = requestedStatus
      ? normalizePresenceStatus(requestedStatus)
      : manualStatuses.has(previousStatus)
        ? previousStatus
        : connectionStatus === "offline"
          ? "offline"
          : "available";

    const avatarUrl =
      currentUser.avatarUrl ||
      currentUser.photoUrl ||
      currentUser.profileImage ||
      previous?.avatarUrl ||
      "";

    const timestamp = now();
    const record = {
      workspaceId: ctx.workspaceId,
      userId: user.id,
      name: currentUser.name || currentUser.email || "Team member",
      avatarUrl,
      role: normalizeRole(currentUser.workspaceRole || currentUser.role),
      connectionStatus,
      status,
      message: clean(payload.message || payload.availabilityMessage || previous?.message || ""),
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    };

    store.update((draft) => {
      draft.teamPresence = draft.teamPresence || [];
      const index = draft.teamPresence.findIndex(
        (item) =>
          item.workspaceId === ctx.workspaceId &&
          item.userId === user.id
      );

      if (index >= 0) {
        draft.teamPresence[index] = record;
      } else {
        draft.teamPresence.push(record);
      }

      const target = (draft.users || []).find((item) => item.id === user.id);
      if (target) {
        target.availabilityStatus = status;
        target.availabilityMessage = record.message;
        target.availabilityUpdatedAt = timestamp;
        target.updatedAt = timestamp;
      }
    });

    return {
      ...record,
      availabilityStatus: status,
      availabilityMessage: record.message,
      photoUrl: avatarUrl,
      profileImage: avatarUrl,
    };
  }

  function listTasks(
    user,
    query = {}
  ) {
    const ctx = requireWorkspace(user);

    const status =
      normalizeStatus(
        query.status
      );

    return (
      store.read().teamTasks ||
      []
    )
      .filter(
        (task) =>
          task.workspaceId ===
          ctx.workspaceId
      )
      .filter(
        (task) =>
          canManage(ctx) ||
          task.assigneeId ===
            user.id ||
          task.createdBy ===
            user.id
      )
      .filter(
        (task) =>
          !status ||
          normalizeStatus(
            task.status
          ) === status
      )
      .sort(
        (left, right) =>
          dateValue(
            right.updatedAt
          ) -
          dateValue(
            left.updatedAt
          )
      );
  }

  function createTask(
    user,
    input = {}
  ) {
    const ctx = requireManager(user);

    const assigneeId =
      clean(input.assigneeId);

    const title =
      clean(input.title);

    if (
      !assigneeId ||
      !title
    ) {
      throw httpError(
        400,
        "Assignee and task title are required."
      );
    }

    const assignee =
      listWorkspaceMembers(
        user
      ).find(
        (member) =>
          member.id ===
          assigneeId
      );

    if (!assignee) {
      throw httpError(
        400,
        "The selected assignee is not a workspace member."
      );
    }

    if (
      ctx.role === "manager" &&
      normalizeRole(
        assignee.workspaceRole ||
          assignee.role
      ) !== "caller"
    ) {
      throw httpError(
        403,
        "Managers can only assign work to callers."
      );
    }

    const timestamp = now();

    const task = {
      id: crypto.randomUUID(),
      workspaceId:
        ctx.workspaceId,

      title,

      description:
        clean(
          input.description
        ),

      status: "assigned",

      priority:
        normalizeTaskPriority(
          input.priority
        ),

      assigneeId,
      assignedToUserId:
        assigneeId,

      assignedBy: user.id,
      createdBy: user.id,

      campaignId:
        clean(
          input.campaignId
        ),

      assignmentId:
        clean(
          input.assignmentId
        ),

      leadId:
        clean(
          input.leadId ||
            input.lead?.id
        ),

      lead:
        sanitizeLead(
          input.lead || {}
        ),

      dueAt:
        normalizeOptionalDate(
          input.dueAt
        ),

      completedAt: "",
      createdAt: timestamp,
      updatedAt: timestamp,

      history: [
        {
          action: "assigned",
          by: user.id,
          at: timestamp,
          note:
            clean(input.note),
        },
      ],
    };

    store.update((draft) => {
      draft.teamTasks =
        draft.teamTasks || [];

      draft.teamTasks.unshift(
        task
      );
    });

    const generalChannel =
      ensureGeneral(
        ctx.workspaceId
      );

    sendMessage(
      user,
      generalChannel.id,
      {
        type: "task",
        taskId: task.id,
        leadId: task.leadId,
        body:
          `Work assignment created: ${task.title}`,

        metadata: {
          taskId: task.id,
          assigneeId:
            task.assigneeId,
          leadId: task.leadId,
        },
      }
    );

    return task;
  }

  function updateTask(
    user,
    taskId,
    patch = {}
  ) {
    const ctx = requireWorkspace(user);

    let updated = null;

    store.update((draft) => {
      draft.teamTasks =
        draft.teamTasks || [];

      const task =
        draft.teamTasks.find(
          (item) =>
            item.id === taskId &&
            item.workspaceId ===
              ctx.workspaceId
        );

      if (!task) {
        throw httpError(
          404,
          "Work assignment not found."
        );
      }

      const manager =
        canManage(ctx);

      if (
        !manager &&
        task.assigneeId !==
          user.id
      ) {
        throw httpError(
          403,
          "You cannot update this work assignment."
        );
      }

      if (
        patch.status !==
        undefined
      ) {
        task.status =
          normalizeTaskStatus(
            patch.status
          );

        task.completedAt =
          task.status ===
            "completed"
            ? now()
            : "";
      }

      if (manager) {
        if (
          patch.assigneeId !==
          undefined
        ) {
          const assigneeId =
            clean(
              patch.assigneeId
            );

          const assignee =
            listWorkspaceMembers(
              user
            ).find(
              (member) =>
                member.id ===
                assigneeId
            );

          if (!assignee) {
            throw httpError(
              400,
              "The selected assignee is not a workspace member."
            );
          }

          task.assigneeId =
            assigneeId;

          task.assignedToUserId =
            assigneeId;
        }

        if (
          patch.priority !==
          undefined
        ) {
          task.priority =
            normalizeTaskPriority(
              patch.priority
            );
        }

        if (
          patch.dueAt !==
          undefined
        ) {
          task.dueAt =
            normalizeOptionalDate(
              patch.dueAt
            );
        }

        if (
          patch.title !==
          undefined
        ) {
          task.title =
            clean(patch.title);

          if (!task.title) {
            throw httpError(
              400,
              "Task title is required."
            );
          }
        }

        if (
          patch.description !==
          undefined
        ) {
          task.description =
            clean(
              patch.description
            );
        }
      }

      task.updatedAt = now();

      task.history =
        task.history || [];

      task.history.push({
        action:
          patch.status ||
          "updated",
        by: user.id,
        at: task.updatedAt,
        note:
          clean(patch.note),
      });

      updated = {
        ...task,
      };
    });

    return updated;
  }

  function createInternalCall(
    user,
    input = {}
  ) {
    const ctx = requireWorkspace(user);

    const targetUserId =
      clean(
        input.targetUserId
      );

    if (!targetUserId) {
      throw httpError(
        400,
        "A target user is required."
      );
    }

    if (
      targetUserId === user.id
    ) {
      throw httpError(
        400,
        "You cannot call yourself."
      );
    }

    const target =
      listWorkspaceMembers(
        user
      ).find(
        (member) =>
          member.id ===
          targetUserId
      );

    if (!target) {
      throw httpError(
        404,
        "The selected team member was not found."
      );
    }

    const timestamp = now();

    const call = {
      id: crypto.randomUUID(),
      workspaceId:
        ctx.workspaceId,

      callerUserId:
        user.id,

      fromUserId:
        user.id,

      callerName:
        clean(
          user.name ||
            user.email
        ),

      callerAvatarUrl:
        clean(
          user.avatarUrl ||
            user.photoUrl ||
            user.profileImage
        ),

      targetUserId,
      toUserId:
        targetUserId,

      targetName:
        clean(
          target.name ||
            target.email
        ),

      targetAvatarUrl:
        clean(
          target.avatarUrl ||
            target.photoUrl ||
            target.profileImage
        ),

      channelId:
        clean(
          input.channelId
        ),

      type:
        input.type === "video"
          ? "video"
          : "audio",

      status: "ringing",

      startedAt: timestamp,
      acceptedAt: "",
      endedAt: "",
      durationSeconds: 0,

      createdAt: timestamp,
      updatedAt: timestamp,
    };

    store.update((draft) => {
      draft.internalCalls =
        draft.internalCalls ||
        [];

      draft.internalCalls.unshift(
        call
      );
    });

    return call;
  }

  function acceptInternalCall(
    user,
    callId
  ) {
    return updateInternalCall(
      user,
      callId,
      "accepted"
    );
  }

  function rejectInternalCall(
    user,
    callId
  ) {
    return updateInternalCall(
      user,
      callId,
      "rejected"
    );
  }

  function endInternalCall(
    user,
    callId
  ) {
    return updateInternalCall(
      user,
      callId,
      "ended"
    );
  }

  function updateInternalCall(
    user,
    callId,
    nextStatus
  ) {
    const ctx = requireWorkspace(user);

    if (
      !CALL_STATUSES.has(
        nextStatus
      )
    ) {
      throw httpError(
        400,
        "Invalid internal call status."
      );
    }

    let updated = null;

    store.update((draft) => {
      draft.internalCalls =
        draft.internalCalls ||
        [];

      const call =
        draft.internalCalls.find(
          (item) =>
            item.id === callId &&
            item.workspaceId ===
              ctx.workspaceId
        );

      if (!call) {
        throw httpError(
          404,
          "Internal call not found."
        );
      }

      const participant =
        [
          call.callerUserId,
          call.targetUserId,
        ].includes(user.id);

      if (
        !participant &&
        !canManage(ctx)
      ) {
        throw httpError(
          403,
          "You cannot update this internal call."
        );
      }

      if (
        nextStatus ===
        "accepted"
      ) {
        if (
          user.id !==
          call.targetUserId
        ) {
          throw httpError(
            403,
            "Only the called team member can accept this call."
          );
        }

        call.acceptedAt = now();
      }

      if (
        [
          "rejected",
          "ended",
          "missed",
          "failed",
        ].includes(
          nextStatus
        )
      ) {
        call.endedAt = now();

        const startedAt =
          dateValue(
            call.acceptedAt ||
              call.startedAt
          );

        const endedAt =
          dateValue(
            call.endedAt
          );

        call.durationSeconds =
          startedAt &&
          endedAt
            ? Math.max(
                0,
                Math.floor(
                  (endedAt -
                    startedAt) /
                    1000
                )
              )
            : 0;
      }

      call.status =
        nextStatus;

      call.updatedAt = now();

      updated = {
        ...call,
      };
    });

    return updated;
  }

  function getInternalCall(
    user,
    callId
  ) {
    const ctx = requireWorkspace(user);

    const call =
      (
        store.read().internalCalls ||
        []
      ).find(
        (item) =>
          item.id === callId &&
          item.workspaceId ===
            ctx.workspaceId
      );

    if (!call) {
      throw httpError(
        404,
        "Internal call not found."
      );
    }

    const participant =
      [
        call.callerUserId,
        call.targetUserId,
      ].includes(user.id);

    if (
      !participant &&
      !canManage(ctx)
    ) {
      throw httpError(
        403,
        "You cannot view this internal call."
      );
    }

    return call;
  }

  function listInternalCalls(
    user,
    query = {}
  ) {
    const ctx = requireWorkspace(user);

    const limit = clampInteger(
      query.limit,
      1,
      500,
      100
    );

    return (
      store.read().internalCalls ||
      []
    )
      .filter(
        (call) =>
          call.workspaceId ===
          ctx.workspaceId
      )
      .filter(
        (call) =>
          canManage(ctx) ||
          [
            call.callerUserId,
            call.targetUserId,
          ].includes(user.id)
      )
      .sort(
        (left, right) =>
          dateValue(
            right.createdAt
          ) -
          dateValue(
            left.createdAt
          )
      )
      .slice(0, limit);
  }

  function summary(user) {
    const channels =
      listChannels(user);

    const tasks =
      listTasks(user);

    return {
      unreadMessages:
        channels.reduce(
          (total, channel) =>
            total +
            Number(
              channel.unreadCount ||
                0
            ),
          0
        ),

      openTasks:
        tasks.filter(
          (task) =>
            ![
              "completed",
              "cancelled",
            ].includes(
              normalizeStatus(
                task.status
              )
            )
        ).length,

      overdueTasks:
        tasks.filter(
          (task) =>
            task.dueAt &&
            dateValue(
              task.dueAt
            ) < Date.now() &&
            ![
              "completed",
              "cancelled",
            ].includes(
              normalizeStatus(
                task.status
              )
            )
        ).length,
    };
  }

  return {
    listChannels,
    createChannel,
    updateChannel,
    archiveChannel,

    listMessages,
    sendMessage,
    deleteMessage,
    markRead,
    registerAttachment,

    listPresence,
    updatePresence,

    listTasks,
    createTask,
    updateTask,

    createInternalCall,
    acceptInternalCall,
    rejectInternalCall,
    endInternalCall,
    getInternalCall,
    listInternalCalls,

    summary,
  };
}

function enrichChannel(
  user,
  channel,
  state
) {
  const workspaceMembers =
    (
      state.users || []
    ).filter((member) =>
      belongsToWorkspace(
        member,
        channel.workspaceId
      )
    );

  const members =
    workspaceMembers.filter(
      (member) =>
        channel.memberIds?.includes(
          member.id
        )
    );

  const otherMember =
    channel.type === "direct"
      ? members.find(
          (member) =>
            member.id !== user.id
        ) || null
      : null;

  return {
    ...channel,

    members:
      members.map(
        sanitizeMember
      ),

    otherMember:
      otherMember
        ? sanitizeMember(
            otherMember
          )
        : null,
  };
}

function enrichMessage(
  state,
  message
) {
  const reads =
    state.teamChannelReads || [];

  const readBy =
    reads
      .filter(
        (record) =>
          record.channelId ===
            message.channelId &&
          record.userId !==
            message.userId &&
          record.readAt >=
            message.createdAt
      )
      .map(
        (record) =>
          record.userId
      );

  return {
    ...message,

    attachments:
      normalizeAttachments(
        message.attachments
      ),

    metadata:
      normalizeMetadata(
        message.metadata
      ),

    readBy,
    readCount:
      readBy.length,
  };
}

function sanitizeMember(
  member
) {
  return {
    id: member.id,

    name:
      member.name ||
      member.email ||
      "Team member",

    email:
      member.email || "",

    role: normalizeRole(
      member.workspaceRole ||
        member.role
    ),

    workspaceRole:
      normalizeRole(
        member.workspaceRole ||
          member.role
      ),

    avatarUrl:
      member.avatarUrl ||
      member.photoUrl ||
      member.profileImage ||
      "",

    jobTitle:
      member.jobTitle || "",

    availabilityStatus:
      member.availabilityStatus ||
      "offline",
  };
}

function sanitizeLead(
  lead = {}
) {
  return {
    id: clean(
      lead.id ||
        lead.placeId
    ),

    name: clean(
      lead.name ||
        lead.business
    ),

    business: clean(
      lead.business ||
        lead.name
    ),

    phone:
      clean(lead.phone),

    email:
      clean(lead.email),

    website:
      clean(lead.website),

    address:
      clean(lead.address),

    category:
      clean(lead.category),
  };
}

function normalizeAttachments(
  attachments
) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((attachment) => ({
      id:
        clean(attachment?.id) ||
        crypto.randomUUID(),

      name:
        clean(
          attachment?.name ||
            attachment?.filename
        ) ||
        "Attachment",

      url:
        clean(
          attachment?.url ||
            attachment?.path
        ),

      path:
        clean(attachment?.path),

      mimeType:
        clean(
          attachment?.mimeType ||
            attachment?.type
        ),

      size: Math.max(
        0,
        Number(
          attachment?.size ||
            0
        )
      ),
    }))
    .filter(
      (attachment) =>
        attachment.url
    );
}

function normalizeMetadata(
  metadata
) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return {};
  }

  return {
    ...metadata,

    lead:
      metadata.lead
        ? sanitizeLead(
            metadata.lead
          )
        : undefined,
  };
}

function normalizeMessageType(
  value
) {
  const type =
    normalizeStatus(
      value || "text"
    );

  return MESSAGE_TYPES.has(type)
    ? type
    : "text";
}

function normalizeTaskStatus(
  value
) {
  const status =
    normalizeStatus(
      value || "assigned"
    );

  if (
    !TASK_STATUSES.has(status)
  ) {
    throw httpError(
      400,
      "Invalid task status."
    );
  }

  return status;
}

function normalizeTaskPriority(
  value
) {
  const priority =
    normalizeStatus(
      value || "normal"
    );

  return TASK_PRIORITIES.has(
    priority
  )
    ? priority
    : "normal";
}

function normalizePresenceStatus(
  value
) {
  const status =
    normalizeStatus(
      value || "offline"
    );

  return [
    "online",
    "available",
    "busy",
    "away",
    "offline",
  ].includes(status)
    ? status
    : "offline";
}

function normalizeOptionalDate(
  value
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return "";
  }

  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    throw httpError(
      400,
      "A valid date and time is required."
    );
  }

  return date.toISOString();
}

function normalizeRole(value) {
  const role =
    normalizeStatus(value);

  if (role.includes("owner")) {
    return "owner";
  }

  if (role.includes("admin")) {
    return "admin";
  }

  if (role.includes("manager")) {
    return "manager";
  }

  if (
    role === "caller" ||
    role.includes(
      "cold_caller"
    ) ||
    role.includes(
      "sales_rep"
    ) ||
    role.includes(
      "telemarketer"
    )
  ) {
    return "caller";
  }

  return role || "caller";
}

function normalizeStatus(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function belongsToWorkspace(
  record,
  workspaceId
) {
  const recordWorkspaceId =
    clean(
      record?.workspaceId ||
        record?.accountId
    );

  return (
    !recordWorkspaceId ||
    recordWorkspaceId ===
      workspaceId
  );
}

function sameMembers(
  leftMembers,
  rightMembers
) {
  const left = [
    ...leftMembers,
  ].sort();

  const right = [
    ...rightMembers,
  ].sort();

  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value === right[index]
    )
  );
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-|-$/g,
      ""
    )
    .slice(0, 64);
}

function clampInteger(
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
    Math.min(
      maximum,
      Math.floor(number)
    )
  );
}

function dateValue(value) {
  const timestamp =
    Date.parse(value || "");

  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(
    value ?? ""
  ).trim();
}

function httpError(
  statusCode,
  message
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  return error;
}