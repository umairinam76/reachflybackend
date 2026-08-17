// apps/api/src/team-communication-service.js

import crypto from "node:crypto";

const MANAGEMENT_ROLES = new Set([
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

  const now = () => new Date().toISOString();

  const clean = (value) =>
    String(value ?? "").trim();

  function context(user) {
    const resolved =
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
      ...resolved,
      workspaceId: clean(
        resolved.workspaceId ||
          user?.workspaceId ||
          user?.id
      ),
      role: normalizeRole(
        resolved.role ||
          user?.workspaceRole ||
          user?.role
      ),
      permissions: Array.isArray(
        resolved.permissions
      )
        ? resolved.permissions
        : [],
    };
  }

  function isManager(ctx) {
    return (
      MANAGEMENT_ROLES.has(
        normalizeRole(ctx.role)
      ) ||
      ctx.permissions?.includes("*") ||
      ctx.permissions?.includes(
        "manage_team"
      ) ||
      ctx.permissions?.includes(
        "assign_leads"
      )
    );
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

  function requireManager(user) {
    const ctx =
      requireWorkspace(user);

    if (!isManager(ctx)) {
      throw httpError(
        403,
        "Team management permission is required."
      );
    }

    return ctx;
  }

  function members(user) {
    try {
      const rows =
        workspaceService?.listMembers?.(
          user
        );

      if (Array.isArray(rows)) {
        return rows;
      }
    } catch {
      // Fallback below.
    }

    const ctx =
      requireWorkspace(user);

    return (
      store.read().users || []
    ).filter(
      (member) =>
        belongsToWorkspace(
          member,
          ctx.workspaceId
        )
    );
  }

  function ensureGeneral(workspaceId) {
    let channel = null;

    store.update((draft) => {
      if (!Array.isArray(draft.teamChannels)) {
        draft.teamChannels = [];
      }

      channel =
        draft.teamChannels.find(
          (item) =>
            item.workspaceId ===
              workspaceId &&
            item.slug === "general" &&
            !item.archivedAt
        );

      if (!channel) {
        const timestamp = now();

        channel = {
          id: crypto.randomUUID(),
          workspaceId,
          slug: "general",
          name: "General",
          description:
            "Workspace-wide operational communication.",
          type: "team",
          memberIds: [],
          createdBy: "system",
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: "",
        };

        draft.teamChannels.unshift(
          channel
        );
      }
    });

    return channel;
  }

  function canAccessChannel(
    user,
    channel
  ) {
    const ctx = context(user);

    if (
      !channel ||
      channel.workspaceId !==
        ctx.workspaceId ||
      channel.archivedAt
    ) {
      return false;
    }

    if (
      channel.type === "team" &&
      (!channel.memberIds?.length ||
        isManager(ctx))
    ) {
      return true;
    }

    return (
      channel.memberIds?.includes(
        user.id
      ) ||
      channel.createdBy === user.id ||
      isManager(ctx)
    );
  }

  function assertChannelAccess(
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
    const ctx =
      requireWorkspace(user);

    ensureGeneral(
      ctx.workspaceId
    );

    const state = store.read();

    const reads =
      state.teamChannelReads ||
      [];

    const messages =
      state.teamMessages || [];

    const workspaceMembers =
      members(user);

    return (
      state.teamChannels || []
    )
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

        const lastRead =
          reads.find(
            (record) =>
              record.channelId ===
                channel.id &&
              record.userId ===
                user.id
          )?.readAt || "";

        const unreadCount =
          channelMessages.filter(
            (message) =>
              message.userId !==
                user.id &&
              (!lastRead ||
                message.createdAt >
                  lastRead)
          ).length;

        const memberRows =
          workspaceMembers.filter(
            (member) =>
              channel.memberIds?.includes(
                member.id
              )
          );

        const otherMember =
          channel.type ===
          "direct"
            ? memberRows.find(
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
            memberRows.map(
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
        (a, b) =>
          Date.parse(
            b.lastMessage
              ?.createdAt ||
              b.updatedAt
          ) -
          Date.parse(
            a.lastMessage
              ?.createdAt ||
              a.updatedAt
          )
      );
  }

  function createChannel(
    user,
    input = {}
  ) {
    const ctx =
      requireWorkspace(user);

    const requestedType =
      normalizeStatus(
        input.type ||
          "team"
      );

    const type =
      requestedType === "group"
        ? "group"
        : requestedType === "direct"
          ? "direct"
          : "team";

    if (
      !CHANNEL_TYPES.has(type)
    ) {
      throw httpError(
        400,
        "Invalid channel type."
      );
    }

    if (
      ["team", "group"].includes(
        type
      ) &&
      !isManager(ctx)
    ) {
      throw httpError(
        403,
        "Only owners, administrators, and managers can create group channels."
      );
    }

    const requestedMemberIds =
      Array.isArray(
        input.memberIds
      )
        ? input.memberIds
        : [];

    const memberIds = [
      ...new Set(
        [
          user.id,
          ...requestedMemberIds,
        ]
          .map(clean)
          .filter(Boolean)
      ),
    ];

    const workspaceMembers =
      members(user);

    const validMemberIds =
      new Set(
        workspaceMembers.map(
          (member) =>
            member.id
        )
      );

    for (const memberId of memberIds) {
      if (
        !validMemberIds.has(
          memberId
        )
      ) {
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

    const state = store.read();

    if (type === "direct") {
      const existing =
        (
          state.teamChannels ||
          []
        ).find(
          (item) =>
            item.workspaceId ===
              ctx.workspaceId &&
            item.type ===
              "direct" &&
            !item.archivedAt &&
            sameMembers(
              item.memberIds || [],
              memberIds
            )
        );

      if (existing) {
        return enrichChannel(
          user,
          existing,
          state
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
      if (!Array.isArray(draft.teamChannels)) {
        draft.teamChannels = [];
      }

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
    const ctx =
      requireWorkspace(user);

    let updated = null;

    store.update((draft) => {
      if (!Array.isArray(draft.teamChannels)) {
        draft.teamChannels = [];
      }

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
        !isManager(ctx) &&
        channel.createdBy !==
          user.id
      ) {
        throw httpError(
          403,
          "You cannot update this conversation."
        );
      }

      if (
        patch.name !==
        undefined
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

        const nextIds = [
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
            members(user).map(
              (member) =>
                member.id
            )
          );

        for (const id of nextIds) {
          if (!validIds.has(id)) {
            throw httpError(
              400,
              "One or more selected members do not belong to this workspace."
            );
          }
        }

        channel.memberIds =
          nextIds;
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
    const ctx =
      requireManager(user);

    let archived = null;

    store.update((draft) => {
      if (!Array.isArray(draft.teamChannels)) {
        draft.teamChannels = [];
      }

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

      channel.archivedAt =
        now();

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
    assertChannelAccess(
      user,
      channelId
    );

    const limit = clampInteger(
      query.limit,
      1,
      250,
      100
    );

    const state = store.read();

    return (
      state.teamMessages ||
      []
    )
      .filter(
        (item) =>
          item.channelId ===
            channelId &&
          !item.deletedAt
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
      assertChannelAccess(
        user,
        channelId
      );

    const body =
      clean(input.body);

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

    if (
      body.length > 8000
    ) {
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
      if (!Array.isArray(draft.teamMessages)) {
        draft.teamMessages = [];
      }

      draft.teamMessages.push(
        message
      );

      if (!Array.isArray(draft.teamChannels)) {
        draft.teamChannels = [];
      }

      const target =
        draft.teamChannels.find(
          (item) =>
            item.id ===
            channelId
        );

      if (target) {
        target.updatedAt =
          message.createdAt;
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
    const ctx =
      requireWorkspace(user);

    assertChannelAccess(
      user,
      channelId
    );

    let deleted = null;

    store.update((draft) => {
      if (!Array.isArray(draft.teamMessages)) {
        draft.teamMessages = [];
      }

      const message =
        draft.teamMessages.find(
          (item) =>
            item.id ===
              messageId &&
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
        message.userId !==
          user.id &&
        !isManager(ctx)
      ) {
        throw httpError(
          403,
          "You cannot delete this message."
        );
      }

      message.deletedAt =
        now();

      message.updatedAt =
        message.deletedAt;

      deleted = {
        ...message,
      };
    });

    return deleted;
  }

  function markRead(
    user,
    channelId
  ) {
    const channel =
      assertChannelAccess(
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
      if (!Array.isArray(draft.teamChannelReads)) {
        draft.teamChannelReads = [];
      }

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
      assertChannelAccess(
        user,
        channelId
      );

    const url =
      clean(
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
      uploadedBy:
        user.id,
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
      size:
        Number(
          input.size ||
            0
        ),
      createdAt: now(),
    };

    store.update((draft) => {
      if (!Array.isArray(draft.teamAttachments)) {
        draft.teamAttachments = [];
      }

      draft.teamAttachments.push(
        attachment
      );
    });

    return attachment;
  }

  function listPresence(user) {
    const ctx =
      requireWorkspace(user);

    const state = store.read();

    const presence =
      state.teamPresence ||
      [];

    return members(user).map(
      (member) => {
        const record =
          presence.find(
            (item) =>
              item.workspaceId ===
                ctx.workspaceId &&
              item.userId ===
                member.id
          );

        return {
          userId: member.id,
          id: member.id,
          name:
            member.name ||
            member.email,
          avatarUrl:
            member.avatarUrl ||
            member.photoUrl ||
            "",
          role: normalizeRole(
            member.workspaceRole ||
              member.role
          ),
          status:
            record?.status ||
            member.availabilityStatus ||
            "offline",
          lastSeenAt:
            record?.lastSeenAt ||
            member.updatedAt ||
            "",
        };
      }
    );
  }

  function updatePresence(
    user,
    status
  ) {
    const ctx =
      requireWorkspace(user);

    const normalizedStatus =
      normalizePresenceStatus(
        status
      );

    const record = {
      workspaceId:
        ctx.workspaceId,
      userId: user.id,
      status:
        normalizedStatus,
      lastSeenAt: now(),
    };

    store.update((draft) => {
      if (!Array.isArray(draft.teamPresence)) {
        draft.teamPresence = [];
      }

      const index =
        draft.teamPresence.findIndex(
          (item) =>
            item.workspaceId ===
              ctx.workspaceId &&
            item.userId ===
              user.id
        );

      if (index >= 0) {
        draft.teamPresence[
          index
        ] = record;
      } else {
        draft.teamPresence.push(
          record
        );
      }
    });

    return record;
  }


  function taskAssigneeId(task = {}) {
    return clean(
      task.assigneeId ||
        task.assignedToUserId ||
        task.assignedTo ||
        task.assignedUserId
    );
  }

  function taskDueInput(value = {}) {
    if (
      Object.prototype.hasOwnProperty.call(value, "dueAt")
    ) {
      return value.dueAt;
    }

    if (
      Object.prototype.hasOwnProperty.call(value, "dueDateTime")
    ) {
      return value.dueDateTime;
    }

    if (
      Object.prototype.hasOwnProperty.call(value, "dueDate")
    ) {
      return value.dueDate;
    }

    if (
      Object.prototype.hasOwnProperty.call(value, "scheduledAt")
    ) {
      return value.scheduledAt;
    }

    if (
      Object.prototype.hasOwnProperty.call(value, "callbackAt")
    ) {
      return value.callbackAt;
    }

    if (
      Object.prototype.hasOwnProperty.call(value, "nextActionAt")
    ) {
      return value.nextActionAt;
    }

    return undefined;
  }

  function safeStoredDate(value) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      return "";
    }

    const date = new Date(value);

    return Number.isNaN(
      date.getTime()
    )
      ? ""
      : date.toISOString();
  }

  function taskKind(task = {}) {
    const explicit = normalizeStatus(
      task.kind ||
        task.taskType ||
        task.type
    );

    if (
      explicit === "callback" ||
      explicit === "call_back" ||
      task.callbackAt
    ) {
      return "callback";
    }

    if (
      explicit === "follow_up" ||
      explicit === "followup"
    ) {
      return "follow_up";
    }

    return explicit || "task";
  }

  function taskIsOpen(task) {
    return ![
      "completed",
      "cancelled",
    ].includes(
      normalizeStatus(
        task?.status
      )
    );
  }

  function taskView(
    task,
    memberById = new Map()
  ) {
    if (
      !task ||
      typeof task !== "object"
    ) {
      return task;
    }

    const assigneeId =
      taskAssigneeId(task);

    const assignee =
      assigneeId
        ? memberById.get(
            assigneeId
          )
        : null;

    const dueAt =
      safeStoredDate(
        task.dueAt ||
          task.dueDateTime ||
          task.dueDate ||
          task.scheduledAt ||
          task.callbackAt ||
          task.nextActionAt
      );

    const kind =
      taskKind(task);

    return {
      ...task,
      assigneeId,
      assignedToUserId:
        assigneeId,
      assignedTo:
        assigneeId,
      assignedUserId:
        assigneeId,
      assigneeName:
        clean(
          task.assigneeName ||
            task.assignedToName ||
            assignee?.name ||
            assignee?.fullName ||
            assignee?.email
        ),
      assignedToName:
        clean(
          task.assignedToName ||
            task.assigneeName ||
            assignee?.name ||
            assignee?.fullName ||
            assignee?.email
        ),
      dueAt,
      kind,
      taskType: kind,
      callbackAt:
        kind === "callback"
          ? dueAt
          : safeStoredDate(
              task.callbackAt
            ),
      nextActionAt:
        dueAt ||
        safeStoredDate(
          task.nextActionAt
        ),
    };
  }

  function findLeadForTask(
    draft,
    task
  ) {
    const campaigns =
      Array.isArray(
        draft.campaigns
      )
        ? draft.campaigns
        : [];

    for (const campaign of campaigns) {
      if (
        campaign.workspaceId &&
        campaign.workspaceId !==
          task.workspaceId
      ) {
        continue;
      }

      if (
        task.campaignId &&
        campaign.id !==
          task.campaignId
      ) {
        continue;
      }

      const leads =
        Array.isArray(
          campaign.leads
        )
          ? campaign.leads
          : [];

      for (const lead of leads) {
        const leadId =
          clean(
            lead.id ||
              lead.leadId
          );

        const assignmentId =
          clean(
            lead.assignmentId ||
              `${campaign.id}:${leadId}`
          );

        if (
          (task.leadId &&
            leadId ===
              task.leadId) ||
          (task.assignmentId &&
            assignmentId ===
              task.assignmentId)
        ) {
          return {
            campaign,
            lead,
          };
        }
      }
    }

    return null;
  }

  function syncTaskToLead(
    draft,
    task
  ) {
    if (
      !task?.leadId &&
      !task?.assignmentId
    ) {
      return;
    }

    const found =
      findLeadForTask(
        draft,
        task
      );

    if (!found) {
      return;
    }

    const { campaign, lead } =
      found;

    if (
      !Array.isArray(
        lead.taskIds
      )
    ) {
      lead.taskIds = [];
    }

    if (
      !lead.taskIds.includes(
        task.id
      )
    ) {
      lead.taskIds.unshift(
        task.id
      );
    }

    if (
      lead.taskIds.length >
      100
    ) {
      lead.taskIds.splice(
        100
      );
    }

    const allTasks =
      Array.isArray(
        draft.teamTasks
      )
        ? draft.teamTasks
        : [];

    const activeTasks =
      allTasks
        .filter(
          (candidate) =>
            candidate.workspaceId ===
              task.workspaceId &&
            taskIsOpen(
              candidate
            ) &&
            (
              (
                task.leadId &&
                clean(
                  candidate.leadId
                ) ===
                  clean(
                    task.leadId
                  )
              ) ||
              (
                task.assignmentId &&
                clean(
                  candidate.assignmentId
                ) ===
                  clean(
                    task.assignmentId
                  )
              )
            )
        )
        .map((candidate) => ({
          task: candidate,
          dueAt:
            safeStoredDate(
              candidate.dueAt ||
                candidate.callbackAt ||
                candidate.nextActionAt
            ),
        }))
        .sort((left, right) => {
          const leftTime =
            left.dueAt
              ? Date.parse(
                  left.dueAt
                )
              : Number.MAX_SAFE_INTEGER;

          const rightTime =
            right.dueAt
              ? Date.parse(
                  right.dueAt
                )
              : Number.MAX_SAFE_INTEGER;

          if (
            leftTime !==
            rightTime
          ) {
            return (
              leftTime -
              rightTime
            );
          }

          return (
            Date.parse(
              left.task.createdAt ||
                0
            ) -
            Date.parse(
              right.task.createdAt ||
                0
            )
          );
        });

    const next =
      activeTasks[0] ||
      null;

    if (next) {
      lead.activeTaskId =
        next.task.id;
      lead.nextActionTaskId =
        next.task.id;

      if (next.dueAt) {
        lead.nextActionAt =
          next.dueAt;
      }

      if (
        taskKind(
          next.task
        ) === "callback" &&
        next.dueAt
      ) {
        lead.callbackTaskId =
          next.task.id;
        lead.callbackAt =
          next.dueAt;
      }
    } else {
      if (
        lead.activeTaskId ===
          task.id
      ) {
        lead.activeTaskId =
          "";
      }

      if (
        lead.nextActionTaskId ===
          task.id
      ) {
        lead.nextActionTaskId =
          "";
        lead.nextActionAt =
          "";
      }

      if (
        lead.callbackTaskId ===
          task.id
      ) {
        lead.callbackTaskId =
          "";
        lead.callbackAt =
          "";
      }
    }

    lead.updatedAt =
      task.updatedAt ||
      now();

    campaign.updatedAt =
      lead.updatedAt;
  }

  function listTasks(
    user,
    query = {}
  ) {
    const ctx =
      requireWorkspace(user);

    const status =
      normalizeStatus(
        query.status
      );

    const requestedAssigneeId =
      clean(
        query.assigneeId ||
          query.assignedToUserId ||
          query.assignedTo
      );

    const memberRows =
      members(user);

    const memberById =
      new Map(
        memberRows.map(
          (member) => [
            member.id,
            member,
          ]
        )
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
      .filter((task) => {
        const assigneeId =
          taskAssigneeId(
            task
          );

        return (
          isManager(ctx) ||
          assigneeId ===
            user.id ||
          task.createdBy ===
            user.id
        );
      })
      .filter(
        (task) =>
          !status ||
          normalizeStatus(
            task.status
          ) === status
      )
      .filter(
        (task) =>
          !requestedAssigneeId ||
          taskAssigneeId(
            task
          ) ===
            requestedAssigneeId
      )
      .map(
        (task) =>
          taskView(
            task,
            memberById
          )
      )
      .sort(
        compareTasksForWorkday
      );
  }

  function createTask(
    user,
    input = {}
  ) {
    const ctx =
      requireManager(user);

    const assigneeId =
      clean(
        input.assigneeId ||
          input.assignedToUserId ||
          input.assignedTo ||
          input.assignedUserId
      );

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

    const workspaceMembers =
      members(user);

    const assignee =
      workspaceMembers.find(
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
      ctx.role ===
        "manager" &&
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

    const dueInput =
      taskDueInput(input);

    const dueAt =
      dueInput === undefined
        ? ""
        : normalizeOptionalDate(
            dueInput
          );

    const kind =
      taskKind({
        ...input,
        callbackAt:
          Object.prototype.hasOwnProperty.call(
            input,
            "callbackAt"
          )
            ? input.callbackAt
            : "",
      });

    const timestamp = now();

    const assigneeName =
      clean(
        assignee.name ||
          assignee.fullName ||
          assignee.email
      );

    const task = {
      id: crypto.randomUUID(),
      workspaceId:
        ctx.workspaceId,
      title,
      description:
        clean(
          input.description
        ),
      status:
        normalizeTaskStatus(
          input.status ||
            "assigned"
        ),
      priority:
        normalizeTaskPriority(
          input.priority
        ),
      kind,
      taskType: kind,
      assigneeId,
      assignedToUserId:
        assigneeId,
      assignedTo:
        assigneeId,
      assignedUserId:
        assigneeId,
      assigneeName,
      assignedToName:
        assigneeName,
      assignedBy: user.id,
      assignedByName:
        clean(
          user.name ||
            user.email
        ),
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
          input.lead ||
            {}
        ),
      dueAt,
      nextActionAt:
        dueAt,
      callbackAt:
        kind === "callback"
          ? dueAt
          : "",
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
          assigneeId,
          dueAt,
        },
      ],
    };

    store.update((draft) => {
      if (
        !Array.isArray(
          draft.teamTasks
        )
      ) {
        draft.teamTasks =
          [];
      }

      draft.teamTasks.unshift(
        task
      );

      syncTaskToLead(
        draft,
        task
      );
    });

    const general =
      ensureGeneral(
        ctx.workspaceId
      );

    sendMessage(
      user,
      general.id,
      {
        type: "task",
        taskId: task.id,
        leadId:
          task.leadId,
        body:
          `Work assignment created: ${task.title}`,
        metadata: {
          taskId: task.id,
          assigneeId:
            task.assigneeId,
          assigneeName:
            task.assigneeName,
          leadId:
            task.leadId,
          assignmentId:
            task.assignmentId,
          dueAt:
            task.dueAt,
          kind:
            task.kind,
        },
      }
    );

    return taskView(
      task,
      new Map(
        workspaceMembers.map(
          (member) => [
            member.id,
            member,
          ]
        )
      )
    );
  }

  function updateTask(
    user,
    taskId,
    patch = {}
  ) {
    const ctx =
      requireWorkspace(user);

    const workspaceMembers =
      members(user);

    const memberById =
      new Map(
        workspaceMembers.map(
          (member) => [
            member.id,
            member,
          ]
        )
      );

    let updated = null;

    store.update((draft) => {
      if (
        !Array.isArray(
          draft.teamTasks
        )
      ) {
        draft.teamTasks =
          [];
      }

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
        isManager(ctx);

      const currentAssigneeId =
        taskAssigneeId(
          task
        );

      if (
        !manager &&
        currentAssigneeId !==
          user.id
      ) {
        throw httpError(
          403,
          "You cannot update this work assignment."
        );
      }

      let historyAction =
        "updated";

      if (
        patch.status !==
        undefined
      ) {
        const status =
          normalizeTaskStatus(
            patch.status
          );

        task.status =
          status;

        task.completedAt =
          status ===
            "completed"
            ? now()
            : "";

        historyAction =
          status;
      }

      if (manager) {
        const assigneePatchPresent =
          Object.prototype.hasOwnProperty.call(
            patch,
            "assigneeId"
          ) ||
          Object.prototype.hasOwnProperty.call(
            patch,
            "assignedToUserId"
          ) ||
          Object.prototype.hasOwnProperty.call(
            patch,
            "assignedTo"
          ) ||
          Object.prototype.hasOwnProperty.call(
            patch,
            "assignedUserId"
          );

        if (
          assigneePatchPresent
        ) {
          const assigneeId =
            clean(
              patch.assigneeId ||
                patch.assignedToUserId ||
                patch.assignedTo ||
                patch.assignedUserId
            );

          let assignee =
            null;

          if (assigneeId) {
            assignee =
              workspaceMembers.find(
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
              ctx.role ===
                "manager" &&
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
          }

          const assigneeName =
            assignee
              ? clean(
                  assignee.name ||
                    assignee.fullName ||
                    assignee.email
                )
              : "";

          task.assigneeId =
            assigneeId;
          task.assignedToUserId =
            assigneeId;
          task.assignedTo =
            assigneeId;
          task.assignedUserId =
            assigneeId;
          task.assigneeName =
            assigneeName;
          task.assignedToName =
            assigneeName;

          historyAction =
            assigneeId
              ? "reassigned"
              : "unassigned";
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

        const duePatch =
          taskDueInput(
            patch
          );

        if (
          duePatch !==
          undefined
        ) {
          task.dueAt =
            normalizeOptionalDate(
              duePatch
            );

          task.nextActionAt =
            task.dueAt;

          if (
            taskKind({
              ...task,
              ...patch,
            }) ===
              "callback"
          ) {
            task.callbackAt =
              task.dueAt;
          }

          historyAction =
            "rescheduled";
        }

        if (
          patch.kind !==
            undefined ||
          patch.taskType !==
            undefined ||
          patch.type !==
            undefined
        ) {
          const kind =
            taskKind({
              ...task,
              ...patch,
            });

          task.kind =
            kind;
          task.taskType =
            kind;

          if (
            kind === "callback"
          ) {
            task.callbackAt =
              task.dueAt ||
              "";
          } else {
            task.callbackAt =
              "";
          }
        }

        if (
          patch.title !==
          undefined
        ) {
          task.title =
            clean(
              patch.title
            );

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

      task.updatedAt =
        now();

      if (
        !Array.isArray(
          task.history
        )
      ) {
        task.history =
          [];
      }

      task.history.push({
        action:
          historyAction,
        by: user.id,
        at: task.updatedAt,
        note:
          clean(patch.note),
        assigneeId:
          taskAssigneeId(
            task
          ),
        dueAt:
          safeStoredDate(
            task.dueAt
          ),
        status:
          normalizeStatus(
            task.status
          ),
      });

      if (
        task.history.length >
        500
      ) {
        task.history.splice(
          0,
          task.history.length -
            500
        );
      }

      syncTaskToLead(
        draft,
        task
      );

      updated =
        taskView(
          task,
          memberById
        );
    });

    return updated;
  }

  function createInternalCall(
    user,
    input = {}
  ) {
    const ctx =
      requireWorkspace(user);

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

    const target =
      members(user).find(
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

    if (
      targetUserId ===
      user.id
    ) {
      throw httpError(
        400,
        "You cannot call yourself."
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
            user.photoUrl
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
            target.photoUrl
        ),
      channelId:
        clean(
          input.channelId
        ),
      type:
        input.type ===
          "video"
          ? "video"
          : "audio",
      status: "ringing",
      startedAt:
        timestamp,
      acceptedAt: "",
      endedAt: "",
      durationSeconds: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    store.update((draft) => {
      if (!Array.isArray(draft.internalCalls)) {
        draft.internalCalls = [];
      }

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
    return updateInternalCallState(
      user,
      callId,
      "accepted"
    );
  }

  function rejectInternalCall(
    user,
    callId
  ) {
    return updateInternalCallState(
      user,
      callId,
      "rejected"
    );
  }

  function endInternalCall(
    user,
    callId
  ) {
    return updateInternalCallState(
      user,
      callId,
      "ended"
    );
  }

  function updateInternalCallState(
    user,
    callId,
    nextStatus
  ) {
    const ctx =
      requireWorkspace(user);

    if (
      !CALL_STATUSES.has(
        nextStatus
      )
    ) {
      throw httpError(
        400,
        "Invalid call status."
      );
    }

    let updated = null;

    store.update((draft) => {
      if (!Array.isArray(draft.internalCalls)) {
        draft.internalCalls = [];
      }

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
        !isManager(ctx)
      ) {
        throw httpError(
          403,
          "You cannot update this call."
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

        call.acceptedAt =
          now();
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
        call.endedAt =
          now();

        const start =
          Date.parse(
            call.acceptedAt ||
              call.startedAt
          );

        const end =
          Date.parse(
            call.endedAt
          );

        call.durationSeconds =
          Number.isFinite(start) &&
          Number.isFinite(end)
            ? Math.max(
                0,
                Math.floor(
                  (end - start) /
                    1000
                )
              )
            : 0;
      }

      call.status =
        nextStatus;

      call.updatedAt =
        now();

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
    const ctx =
      requireWorkspace(user);

    const call =
      (
        store.read()
          .internalCalls || []
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
      !isManager(ctx)
    ) {
      throw httpError(
        403,
        "You cannot view this call."
      );
    }

    return call;
  }

  function listInternalCalls(
    user,
    query = {}
  ) {
    const ctx =
      requireWorkspace(user);

    const limit =
      clampInteger(
        query.limit,
        1,
        500,
        100
      );

    return (
      store.read()
        .internalCalls || []
    )
      .filter(
        (call) =>
          call.workspaceId ===
            ctx.workspaceId
      )
      .filter(
        (call) =>
          isManager(ctx) ||
          [
            call.callerUserId,
            call.targetUserId,
          ].includes(user.id)
      )
      .sort(
        (a, b) =>
          Date.parse(
            b.createdAt
          ) -
          Date.parse(
            a.createdAt
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
          (sum, channel) =>
            sum +
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
            Date.parse(
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
    ).filter(
      (member) =>
        belongsToWorkspace(
          member,
          channel.workspaceId
        )
    );

  const memberRows =
    workspaceMembers.filter(
      (member) =>
        channel.memberIds?.includes(
          member.id
        )
    );

  const otherMember =
    channel.type ===
    "direct"
      ? memberRows.find(
          (member) =>
            member.id !== user.id
        ) || null
      : null;

  return {
    ...channel,
    members:
      memberRows.map(
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
    state.teamChannelReads ||
    [];

  const channel =
    (
      state.teamChannels ||
      []
    ).find(
      (item) =>
        item.id ===
        message.channelId
    );

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
    channelType:
      channel?.type ||
      "",
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
      member.email ||
      "",
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
      member.jobTitle ||
      "",
    availabilityStatus:
      member.availabilityStatus ||
      "offline",
  };
}

function sanitizeLead(
  lead = {}
) {
  return {
    id: String(
      lead.id ||
        lead.placeId ||
        ""
    ),
    name: String(
      lead.name ||
        lead.business ||
        ""
    ),
    business: String(
      lead.business ||
        lead.name ||
        ""
    ),
    phone: String(
      lead.phone ||
        ""
    ),
    email: String(
      lead.email ||
        ""
    ),
    website: String(
      lead.website ||
        ""
    ),
    address: String(
      lead.address ||
        ""
    ),
    category: String(
      lead.category ||
        ""
    ),
  };
}

function normalizeAttachments(
  value
) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => ({
      id:
        String(
          item?.id ||
            crypto.randomUUID()
        ),
      name:
        String(
          item?.name ||
            item?.filename ||
            "Attachment"
        ),
      url:
        String(
          item?.url ||
            item?.path ||
            ""
        ),
      path:
        String(
          item?.path ||
            ""
        ),
      mimeType:
        String(
          item?.mimeType ||
            item?.type ||
            ""
        ),
      size:
        Number(
          item?.size ||
            0
        ),
    }))
    .filter(
      (item) =>
        item.url
    );
}

function normalizeMetadata(
  value
) {
  if (
    !value ||
    typeof value !==
      "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return {
    ...value,
    lead:
      value.lead
        ? sanitizeLead(
            value.lead
          )
        : undefined,
  };
}

function normalizeMessageType(
  value
) {
  const type =
    normalizeStatus(
      value ||
        "text"
    );

  return MESSAGE_TYPES.has(
    type
  )
    ? type
    : "text";
}

function normalizeTaskPriority(
  value
) {
  const priority =
    normalizeStatus(
      value ||
        "normal"
    );

  return TASK_PRIORITIES.has(
    priority
  )
    ? priority
    : "normal";
}

function normalizeTaskStatus(
  value
) {
  const status =
    normalizeStatus(
      value ||
        "assigned"
    );

  if (
    !TASK_STATUSES.has(
      status
    )
  ) {
    throw httpError(
      400,
      "Invalid task status."
    );
  }

  return status;
}

function compareTasksForWorkday(
  left,
  right
) {
  const leftClosed = [
    "completed",
    "cancelled",
  ].includes(
    normalizeStatus(
      left?.status
    )
  );

  const rightClosed = [
    "completed",
    "cancelled",
  ].includes(
    normalizeStatus(
      right?.status
    )
  );

  if (
    leftClosed !==
    rightClosed
  ) {
    return leftClosed
      ? 1
      : -1;
  }

  if (
    !leftClosed &&
    !rightClosed
  ) {
    const leftDue =
      safeDateMs(
        left?.dueAt
      );

    const rightDue =
      safeDateMs(
        right?.dueAt
      );

    if (
      leftDue !==
      rightDue
    ) {
      return (
        leftDue -
        rightDue
      );
    }
  }

  return (
    safeDateMs(
      right?.updatedAt ||
        right?.createdAt
    ) -
    safeDateMs(
      left?.updatedAt ||
        left?.createdAt
    )
  );
}

function safeDateMs(value) {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed =
    Date.parse(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : Number.MAX_SAFE_INTEGER;
}

function normalizePresenceStatus(
  value
) {
  const status =
    normalizeStatus(
      value ||
        "offline"
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

  const date =
    new Date(value);

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
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function belongsToWorkspace(
  record,
  workspaceId
) {
  const recordWorkspaceId =
    String(
      record?.workspaceId ||
        record?.accountId ||
        ""
    ).trim();

  return (
    !recordWorkspaceId ||
    recordWorkspaceId ===
      workspaceId
  );
}

function sameMembers(a, b) {
  const left = [
    ...a,
  ].sort();

  const right = [
    ...b,
  ].sort();

  return (
    left.length ===
      right.length &&
    left.every(
      (value, index) =>
        value ===
        right[index]
    )
  );
}

function slugify(value) {
  return String(value || "")
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
  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
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
