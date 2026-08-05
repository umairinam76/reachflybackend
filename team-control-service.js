// apps/api/src/team-control-service.js

import crypto from "node:crypto";

const MANAGEMENT_ROLES = new Set([
  "owner",
  "admin",
  "manager",
]);

const OWNER_ADMIN_ROLES = new Set([
  "owner",
  "admin",
]);

const CALLER_ROLES = new Set([
  "caller",
  "cold_caller",
  "sales_representative",
  "sales_rep",
  "telemarketer",
]);

const ACTIVE_ASSIGNMENT_STATUSES = new Set([
  "assigned",
  "in_progress",
  "follow_up",
  "qualified",
  "meeting_booked",
]);

const FINAL_ASSIGNMENT_STATUSES = new Set([
  "completed",
  "cancelled",
  "do_not_contact",
]);

const ASSIGNMENT_STATUSES = new Set([
  ...ACTIVE_ASSIGNMENT_STATUSES,
  ...FINAL_ASSIGNMENT_STATUSES,
]);

const TASK_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

const PRIORITIES = new Set([
  "low",
  "normal",
  "high",
  "urgent",
]);

const REPORT_TYPES = new Set([
  "mini_audit",
  "competitor_analysis",
  "full_audit",
]);

export function createTeamControlService({
  store,
  workspaceService,
} = {}) {
  if (!store) {
    throw new Error(
      "createTeamControlService requires a store."
    );
  }

  const ctx = (user) => {
    const context =
      workspaceService?.getContext?.(user) || {
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
      ...context,
      role: normalizeRole(
        context.role ||
          user?.workspaceRole ||
          user?.role
      ),
      workspaceId: clean(
        context.workspaceId ||
          user?.workspaceId ||
          user?.id
      ),
      permissions: Array.isArray(
        context.permissions
      )
        ? context.permissions
        : [],
    };
  };

  const allowed = (
    context,
    roles,
    permission
  ) => {
    const normalizedRoles =
      roles.map(normalizeRole);

    return (
      normalizedRoles.includes(
        context.role
      ) ||
      context.permissions.includes("*") ||
      context.permissions.includes(
        permission
      )
    );
  };

  function requireRole(
    user,
    roles,
    permission
  ) {
    const context = ctx(user);

    if (
      !allowed(
        context,
        roles,
        permission
      )
    ) {
      throw httpError(
        403,
        "You do not have permission for this action."
      );
    }

    return context;
  }

  function requireWorkspaceUser(user) {
    const context = ctx(user);

    if (!context.workspaceId) {
      throw httpError(
        403,
        "A workspace is required for this action."
      );
    }

    return context;
  }

  /*
   * Team members
   */

  function listTeam(user) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_team"
    );

    const state = store.read();

    const members = getWorkspaceUsers(
      state,
      context.workspaceId
    );

    const calls = getWorkspaceRecords(
      state.callRecords,
      context.workspaceId
    );

    const assignments =
      getWorkspaceRecords(
        state.leadAssignments,
        context.workspaceId
      );

    const attendance =
      getWorkspaceRecords(
        state.attendanceRecords,
        context.workspaceId
      );

    const dialers =
      getWorkspaceRecords(
        state.dialerProfiles,
        context.workspaceId
      );

    const senders =
      getWorkspaceRecords(
        state.senderProfiles,
        context.workspaceId
      );

    return members
      .filter((member) =>
        canManagerViewMember({
          actorRole: context.role,
          actorUserId: user?.id,
          member,
        })
      )
      .map((member) => {
        const memberCalls =
          calls.filter(
            (call) =>
              getCallerId(call) ===
              member.id
          );

        const answered =
          memberCalls.filter((call) =>
            isAnsweredCall(call)
          );

        const completed =
          memberCalls.filter((call) =>
            [
              "completed",
              "ended",
            ].includes(
              normalizeStatus(
                call.status
              )
            )
          );

        const memberAssignments =
          assignments.filter(
            (assignment) =>
              getAssigneeId(
                assignment
              ) === member.id
          );

        const currentAttendance =
          getLatestAttendance(
            attendance,
            member.id
          );

        const dialer =
          dialers.find(
            (item) =>
              item.id ===
              member.dialerId
          );

        const sender =
          senders.find(
            (item) =>
              item.id ===
              member.senderId
          );

        return {
          id: member.id,
          workspaceId:
            member.workspaceId,
          name: member.name,
          firstName:
            member.firstName ||
            firstName(member.name),
          lastName:
            member.lastName ||
            lastName(member.name),
          email: member.email,
          phone:
            member.phone ||
            member.mobile ||
            "",
          avatarUrl:
            member.avatarUrl ||
            member.photoUrl ||
            member.profileImage ||
            "",
          jobTitle:
            member.jobTitle ||
            "",
          department:
            member.department ||
            "",
          role: normalizeRole(
            member.workspaceRole ||
              member.role ||
              "caller"
          ),
          workspaceRole:
            normalizeRole(
              member.workspaceRole ||
                member.role ||
                "caller"
            ),
          managerId:
            member.managerId ||
            "",
          permissions:
            member.permissions ||
            [],
          active:
            member.active !== false,
          status:
            member.status ||
            (member.active === false
              ? "inactive"
              : "active"),
          availabilityStatus:
            member.availabilityStatus ||
            "offline",
          assignedLeadCount:
            memberAssignments.filter(
              (item) =>
                !FINAL_ASSIGNMENT_STATUSES.has(
                  normalizeStatus(
                    item.status
                  )
                )
            ).length,
          dialerId:
            member.dialerId ||
            "",
          senderId:
            member.senderId ||
            "",
          assignedDialer:
            dialer
              ? sanitizeDialer(dialer)
              : null,
          assignedSender:
            sender
              ? redactSender(sender)
              : null,
          attendance:
            currentAttendance,
          performance: {
            totalCalls:
              memberCalls.length,
            answeredCalls:
              answered.length,
            completedCalls:
              completed.length,
            answerRate:
              memberCalls.length
                ? Math.round(
                    (answered.length /
                      memberCalls.length) *
                      100
                  )
                : 0,
            averageDurationSeconds:
              average(
                memberCalls
                  .map((item) =>
                    Number(
                      item.durationSeconds ||
                        item.duration ||
                        0
                    )
                  )
                  .filter(
                    (value) =>
                      Number.isFinite(
                        value
                      ) && value > 0
                  )
              ),
            totalCallSeconds:
              memberCalls.reduce(
                (total, item) =>
                  total +
                  Number(
                    item.durationSeconds ||
                      item.duration ||
                      0
                  ),
                0
              ),
            uniqueLeads:
              new Set(
                memberCalls
                  .map((item) =>
                    clean(
                      item.leadId ||
                        item.leadKey
                    )
                  )
                  .filter(Boolean)
              ).size,
            qualifiedLeads:
              memberAssignments.filter(
                (item) =>
                  [
                    "qualified",
                    "meeting_booked",
                  ].includes(
                    normalizeStatus(
                      item.status
                    )
                  )
              ).length,
            meetingsBooked:
              memberAssignments.filter(
                (item) =>
                  normalizeStatus(
                    item.status
                  ) ===
                  "meeting_booked"
              ).length,
          },
          createdAt:
            member.createdAt ||
            "",
          updatedAt:
            member.updatedAt ||
            "",
        };
      });
  }

  function updateMember(
    user,
    memberId,
    input = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_team"
    );

    const actorRole =
      context.role;

    const requestedRole =
      input.role !== undefined
        ? normalizeRole(input.role)
        : "";

    if (
      requestedRole === "owner" &&
      actorRole !== "owner"
    ) {
      throw httpError(
        403,
        "Only the owner can assign the owner role."
      );
    }

    if (
      actorRole === "manager" &&
      requestedRole &&
      requestedRole !== "caller"
    ) {
      throw httpError(
        403,
        "Managers can only manage caller accounts."
      );
    }

    let updated = null;

    store.update((draft) => {
      draft.users =
        draft.users || [];

      const member =
        draft.users.find(
          (item) =>
            item.id === memberId &&
            item.workspaceId ===
              context.workspaceId
        );

      if (!member) {
        return;
      }

      const memberRole =
        normalizeRole(
          member.workspaceRole ||
            member.role
        );

      if (
        actorRole === "manager" &&
        memberRole !== "caller"
      ) {
        throw httpError(
          403,
          "Managers can only edit caller accounts."
        );
      }

      if (
        actorRole === "manager" &&
        member.managerId &&
        member.managerId !== user.id
      ) {
        throw httpError(
          403,
          "This caller is assigned to another manager."
        );
      }

      if (requestedRole) {
        member.role =
          requestedRole;
        member.workspaceRole =
          requestedRole;
      }

      if (
        Array.isArray(
          input.permissions
        )
      ) {
        if (
          actorRole === "manager"
        ) {
          throw httpError(
            403,
            "Managers cannot modify workspace permissions."
          );
        }

        member.permissions =
          input.permissions
            .map(clean)
            .filter(Boolean);
      }

      if (
        input.active !== undefined
      ) {
        member.active =
          Boolean(input.active);
      }

      if (
        input.phone !== undefined
      ) {
        const phone =
          normalizeOptionalPhone(
            input.phone
          );

        member.phone = phone;
      }

      if (
        input.managerId !==
        undefined
      ) {
        if (
          actorRole === "manager"
        ) {
          member.managerId =
            user.id;
        } else {
          member.managerId =
            clean(
              input.managerId
            );
        }
      }

      if (
        input.dialerId !==
        undefined
      ) {
        validateResourceAssignment({
          draft,
          workspaceId:
            context.workspaceId,
          collection:
            "dialerProfiles",
          resourceId:
            clean(input.dialerId),
          label: "Dialer",
        });

        member.dialerId =
          clean(input.dialerId);
      }

      if (
        input.senderId !==
        undefined
      ) {
        validateResourceAssignment({
          draft,
          workspaceId:
            context.workspaceId,
          collection:
            "senderProfiles",
          resourceId:
            clean(input.senderId),
          label: "Sender identity",
        });

        member.senderId =
          clean(input.senderId);
      }

      if (
        input.jobTitle !==
        undefined
      ) {
        member.jobTitle =
          clean(input.jobTitle);
      }

      if (
        input.department !==
        undefined
      ) {
        member.department =
          clean(input.department);
      }

      member.updatedAt =
        nowIso();

      updated = {
        ...member,
      };
    });

    if (!updated) {
      throw httpError(
        404,
        "Team member not found."
      );
    }

    return sanitizeMember(updated);
  }

  function updateMemberTools(
    user,
    memberId,
    input = {}
  ) {
    return updateMember(
      user,
      memberId,
      {
        dialerId:
          input.dialerId,
        senderId:
          input.senderId,
      }
    );
  }

  /*
   * Performance
   */

  function getPerformance(user) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "view_team_performance"
    );

    return listTeam(user).map(
      (member) => ({
        userId: member.id,
        member,
        metrics:
          member.performance,
      })
    );
  }

  function getMyPerformance(user) {
    const context =
      requireWorkspaceUser(user);

    const state = store.read();

    const calls =
      getWorkspaceRecords(
        state.callRecords,
        context.workspaceId
      ).filter(
        (call) =>
          getCallerId(call) ===
          user.id
      );

    const assignments =
      getWorkspaceRecords(
        state.leadAssignments,
        context.workspaceId
      ).filter(
        (assignment) =>
          getAssigneeId(
            assignment
          ) === user.id
      );

    const totalCalls =
      calls.length;

    const answeredCalls =
      calls.filter(
        isAnsweredCall
      ).length;

    const qualifiedLeads =
      assignments.filter(
        (item) =>
          [
            "qualified",
            "meeting_booked",
          ].includes(
            normalizeStatus(
              item.status
            )
          )
      ).length;

    const meetingsBooked =
      assignments.filter(
        (item) =>
          normalizeStatus(
            item.status
          ) ===
          "meeting_booked"
      ).length;

    return {
      userId: user.id,
      totalCalls,
      answeredCalls,
      answerRate:
        totalCalls > 0
          ? Math.round(
              (answeredCalls /
                totalCalls) *
                100
            )
          : 0,
      totalCallSeconds:
        calls.reduce(
          (total, item) =>
            total +
            Number(
              item.durationSeconds ||
                item.duration ||
                0
            ),
          0
        ),
      averageDurationSeconds:
        average(
          calls
            .map((item) =>
              Number(
                item.durationSeconds ||
                  item.duration ||
                  0
              )
            )
            .filter(
              (value) =>
                Number.isFinite(
                  value
                ) && value > 0
            )
        ),
      qualifiedLeads,
      meetingsBooked,
      assignedLeads:
        assignments.length,
      activeAssignments:
        assignments.filter(
          (item) =>
            !FINAL_ASSIGNMENT_STATUSES.has(
              normalizeStatus(
                item.status
              )
            )
        ).length,
    };
  }

  /*
   * Leads and assignments
   */

  function listLeads(
    user,
    options = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "assign_leads"
    );

    const state = store.read();

    const leads =
      getAllWorkspaceLeads(
        state,
        context.workspaceId
      );

    const assignments =
      getWorkspaceRecords(
        state.leadAssignments,
        context.workspaceId
      );

    const assignmentStatus =
      normalizeStatus(
        options.assignmentStatus
      );

    const search =
      clean(options.search)
        .toLowerCase();

    const limit =
      clampInteger(
        options.limit,
        1,
        1000,
        500
      );

    return leads
      .filter((lead) => {
        const activeAssignment =
          assignments.find(
            (assignment) =>
              assignment.leadId ===
                lead.id &&
              ACTIVE_ASSIGNMENT_STATUSES.has(
                normalizeStatus(
                  assignment.status
                )
              )
          );

        if (
          assignmentStatus ===
            "unassigned" &&
          activeAssignment
        ) {
          return false;
        }

        if (
          assignmentStatus ===
            "assigned" &&
          !activeAssignment
        ) {
          return false;
        }

        if (search) {
          const haystack = [
            lead.business,
            lead.name,
            lead.email,
            lead.phone,
            lead.website,
            lead.address,
            lead.location,
            lead.category,
          ]
            .join(" ")
            .toLowerCase();

          if (
            !haystack.includes(
              search
            )
          ) {
            return false;
          }
        }

        return true;
      })
      .slice(0, limit)
      .map((lead) => {
        const activeAssignment =
          assignments.find(
            (assignment) =>
              assignment.leadId ===
                lead.id &&
              ACTIVE_ASSIGNMENT_STATUSES.has(
                normalizeStatus(
                  assignment.status
                )
              )
          );

        return {
          ...lead,
          assignmentStatus:
            activeAssignment
              ? normalizeStatus(
                  activeAssignment.status
                )
              : "unassigned",
          activeAssignmentId:
            activeAssignment?.id ||
            "",
        };
      });
  }

  function listAssignments(
    user,
    options = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "assign_leads"
    );

    const state = store.read();

    let assignments =
      getWorkspaceRecords(
        state.leadAssignments,
        context.workspaceId
      );

    if (
      context.role === "manager"
    ) {
      const managedUserIds =
        new Set(
          getWorkspaceUsers(
            state,
            context.workspaceId
          )
            .filter(
              (member) =>
                normalizeRole(
                  member.workspaceRole ||
                    member.role
                ) === "caller" &&
                (!member.managerId ||
                  member.managerId ===
                    user.id)
            )
            .map(
              (member) =>
                member.id
            )
        );

      assignments =
        assignments.filter(
          (assignment) =>
            managedUserIds.has(
              getAssigneeId(
                assignment
              )
            ) ||
            assignment.createdBy ===
              user.id
        );
    }

    return prepareAssignments({
      state,
      assignments,
      workspaceId:
        context.workspaceId,
      options,
    });
  }

  function listMyAssignments(
    user,
    options = {}
  ) {
    const context =
      requireWorkspaceUser(user);

    const state = store.read();

    const assignments =
      getWorkspaceRecords(
        state.leadAssignments,
        context.workspaceId
      ).filter(
        (assignment) =>
          getAssigneeId(
            assignment
          ) === user.id
      );

    return prepareAssignments({
      state,
      assignments,
      workspaceId:
        context.workspaceId,
      options,
    });
  }

  function getAssignment(
    user,
    assignmentId
  ) {
    const context =
      requireWorkspaceUser(user);

    const state = store.read();

    const assignment =
      getWorkspaceRecords(
        state.leadAssignments,
        context.workspaceId
      ).find(
        (item) =>
          item.id === assignmentId
      );

    if (!assignment) {
      throw httpError(
        404,
        "Lead assignment not found."
      );
    }

    assertAssignmentAccess({
      user,
      context,
      assignment,
      state,
    });

    return enrichAssignment({
      state,
      assignment,
      workspaceId:
        context.workspaceId,
    });
  }

  function createAssignments(
    user,
    input = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "assign_leads"
    );

    const leadIds =
      uniqueStrings(
        Array.isArray(
          input.leadIds
        )
          ? input.leadIds
          : [
              input.leadId,
            ]
      );

    const assigneeId =
      clean(
        input.assigneeId ||
          input.assignedToUserId
      );

    if (!assigneeId) {
      throw httpError(
        400,
        "An assignee is required."
      );
    }

    if (!leadIds.length) {
      throw httpError(
        400,
        "Select at least one lead."
      );
    }

    const priority =
      normalizePriority(
        input.priority
      );

    const status =
      normalizeAssignmentStatus(
        input.status ||
          "assigned"
      );

    const instructions =
      clean(
        input.instructions
      );

    const dueAt =
      normalizeOptionalDate(
        input.dueAt
      );

    const nextActionAt =
      normalizeOptionalDate(
        input.nextActionAt
      );

    const created = [];

    store.update((draft) => {
      draft.leadAssignments =
        draft.leadAssignments ||
        [];

      const assignee =
        (draft.users || []).find(
          (member) =>
            member.id ===
              assigneeId &&
            member.workspaceId ===
              context.workspaceId
        );

      if (!assignee) {
        throw httpError(
          404,
          "The selected team member was not found."
        );
      }

      const assigneeRole =
        normalizeRole(
          assignee.workspaceRole ||
            assignee.role
        );

      if (
        !CALLER_ROLES.has(
          assigneeRole
        ) &&
        assigneeRole !==
          "manager"
      ) {
        throw httpError(
          400,
          "Leads can only be assigned to a caller or manager."
        );
      }

      if (
        context.role ===
          "manager" &&
        assigneeRole !==
          "caller"
      ) {
        throw httpError(
          403,
          "Managers can only assign leads to callers."
        );
      }

      if (
        context.role ===
          "manager" &&
        assignee.managerId &&
        assignee.managerId !==
          user.id
      ) {
        throw httpError(
          403,
          "The selected caller belongs to another manager."
        );
      }

      for (const leadId of leadIds) {
        const lead =
          findLeadById(
            draft,
            context.workspaceId,
            leadId
          );

        if (!lead) {
          throw httpError(
            404,
            `Lead ${leadId} was not found.`
          );
        }

        const duplicate =
          draft.leadAssignments.find(
            (assignment) =>
              assignment.workspaceId ===
                context.workspaceId &&
              assignment.leadId ===
                leadId &&
              ACTIVE_ASSIGNMENT_STATUSES.has(
                normalizeStatus(
                  assignment.status
                )
              )
          );

        if (duplicate) {
          const duplicateLeadName =
            lead.business ||
            lead.name ||
            leadId;

          throw httpError(
            409,
            `${duplicateLeadName} already has an active assignment.`
          );
        }

        const now =
          nowIso();

        const assignment = {
          id: crypto.randomUUID(),
          workspaceId:
            context.workspaceId,
          leadId,
          assigneeId,
          assignedToUserId:
            assigneeId,
          status,
          priority,
          instructions,
          dueAt,
          nextActionAt,
          assignedAt: now,
          lastContactedAt: null,
          contactCount: 0,
          callCount: 0,
          createdBy:
            user.id,
          createdAt: now,
          updatedAt: now,
        };

        draft.leadAssignments.unshift(
          assignment
        );

        created.push(
          enrichAssignment({
            state: draft,
            assignment,
            workspaceId:
              context.workspaceId,
          })
        );
      }
    });

    return created;
  }

  function updateAssignment(
    user,
    assignmentId,
    input = {}
  ) {
    const context =
      requireWorkspaceUser(user);

    let updated = null;

    store.update((draft) => {
      draft.leadAssignments =
        draft.leadAssignments ||
        [];

      const assignment =
        draft.leadAssignments.find(
          (item) =>
            item.id ===
              assignmentId &&
            item.workspaceId ===
              context.workspaceId
        );

      if (!assignment) {
        return;
      }

      assertAssignmentAccess({
        user,
        context,
        assignment,
        state: draft,
        write: true,
      });

      if (
        input.status !==
        undefined
      ) {
        assignment.status =
          normalizeAssignmentStatus(
            input.status
          );
      }

      if (
        input.priority !==
        undefined
      ) {
        if (
          !MANAGEMENT_ROLES.has(
            context.role
          )
        ) {
          throw httpError(
            403,
            "Only managers can change assignment priority."
          );
        }

        assignment.priority =
          normalizePriority(
            input.priority
          );
      }

      if (
        input.instructions !==
        undefined
      ) {
        if (
          !MANAGEMENT_ROLES.has(
            context.role
          )
        ) {
          throw httpError(
            403,
            "Only managers can change assignment instructions."
          );
        }

        assignment.instructions =
          clean(
            input.instructions
          );
      }

      if (
        input.assigneeId !==
          undefined ||
        input.assignedToUserId !==
          undefined
      ) {
        if (
          !MANAGEMENT_ROLES.has(
            context.role
          )
        ) {
          throw httpError(
            403,
            "Only managers can reassign leads."
          );
        }

        const newAssigneeId =
          clean(
            input.assigneeId ||
              input.assignedToUserId
          );

        const newAssignee =
          (draft.users || []).find(
            (member) =>
              member.id ===
                newAssigneeId &&
              member.workspaceId ===
                context.workspaceId
          );

        if (!newAssignee) {
          throw httpError(
            404,
            "The selected assignee was not found."
          );
        }

        if (
          context.role ===
            "manager" &&
          normalizeRole(
            newAssignee.workspaceRole ||
              newAssignee.role
          ) !== "caller"
        ) {
          throw httpError(
            403,
            "Managers can only assign leads to callers."
          );
        }

        assignment.assigneeId =
          newAssigneeId;

        assignment.assignedToUserId =
          newAssigneeId;
      }

      if (
        input.dueAt !==
        undefined
      ) {
        assignment.dueAt =
          normalizeOptionalDate(
            input.dueAt
          );
      }

      if (
        input.nextActionAt !==
        undefined
      ) {
        assignment.nextActionAt =
          normalizeOptionalDate(
            input.nextActionAt
          );
      }

      if (
        input.notes !==
        undefined
      ) {
        assignment.notes =
          clean(input.notes);
      }

      if (
        input.lastContactedAt !==
        undefined
      ) {
        assignment.lastContactedAt =
          normalizeOptionalDate(
            input.lastContactedAt
          );
      }

      if (
        input.incrementCallCount
      ) {
        assignment.callCount =
          Number(
            assignment.callCount ||
              0
          ) + 1;

        assignment.contactCount =
          Number(
            assignment.contactCount ||
              0
          ) + 1;

        assignment.lastContactedAt =
          nowIso();
      }

      assignment.updatedAt =
        nowIso();

      updated =
        enrichAssignment({
          state: draft,
          assignment,
          workspaceId:
            context.workspaceId,
        });
    });

    if (!updated) {
      throw httpError(
        404,
        "Lead assignment not found."
      );
    }

    return updated;
  }

  function deleteAssignment(
    user,
    assignmentId
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "assign_leads"
    );

    let removed = null;

    store.update((draft) => {
      draft.leadAssignments =
        draft.leadAssignments ||
        [];

      const index =
        draft.leadAssignments.findIndex(
          (item) =>
            item.id ===
              assignmentId &&
            item.workspaceId ===
              context.workspaceId
        );

      if (index < 0) {
        return;
      }

      const assignment =
        draft.leadAssignments[
          index
        ];

      if (
        context.role ===
          "manager" &&
        assignment.createdBy !==
          user.id
      ) {
        const assignee =
          (draft.users || []).find(
            (member) =>
              member.id ===
              getAssigneeId(
                assignment
              )
          );

        if (
          assignee?.managerId &&
          assignee.managerId !==
            user.id
        ) {
          throw httpError(
            403,
            "This assignment belongs to another manager."
          );
        }
      }

      removed =
        draft.leadAssignments.splice(
          index,
          1
        )[0];
    });

    if (!removed) {
      throw httpError(
        404,
        "Lead assignment not found."
      );
    }

    return removed;
  }

  /*
   * Tasks
   */

  function listTasks(
    user,
    options = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_tasks"
    );

    const state = store.read();

    let tasks =
      getWorkspaceRecords(
        state.teamTasks,
        context.workspaceId
      );

    if (
      context.role ===
        "manager"
    ) {
      const managedUserIds =
        new Set(
          getWorkspaceUsers(
            state,
            context.workspaceId
          )
            .filter(
              (member) =>
                normalizeRole(
                  member.workspaceRole ||
                    member.role
                ) ===
                  "caller" &&
                (!member.managerId ||
                  member.managerId ===
                    user.id)
            )
            .map(
              (member) =>
                member.id
            )
        );

      tasks = tasks.filter(
        (task) =>
          managedUserIds.has(
            getAssigneeId(task)
          ) ||
          task.createdBy ===
            user.id
      );
    }

    return prepareTasks({
      state,
      tasks,
      workspaceId:
        context.workspaceId,
      options,
    });
  }

  function listMyTasks(
    user,
    options = {}
  ) {
    const context =
      requireWorkspaceUser(user);

    const state = store.read();

    const tasks =
      getWorkspaceRecords(
        state.teamTasks,
        context.workspaceId
      ).filter(
        (task) =>
          getAssigneeId(task) ===
          user.id
      );

    return prepareTasks({
      state,
      tasks,
      workspaceId:
        context.workspaceId,
      options,
    });
  }

  function createTask(
    user,
    input = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_tasks"
    );

    const title =
      clean(input.title);

    const assigneeId =
      clean(
        input.assigneeId ||
          input.assignedToUserId
      );

    if (!title) {
      throw httpError(
        400,
        "A task title is required."
      );
    }

    if (!assigneeId) {
      throw httpError(
        400,
        "A task assignee is required."
      );
    }

    let created = null;

    store.update((draft) => {
      draft.teamTasks =
        draft.teamTasks || [];

      const assignee =
        (draft.users || []).find(
          (member) =>
            member.id ===
              assigneeId &&
            member.workspaceId ===
              context.workspaceId
        );

      if (!assignee) {
        throw httpError(
          404,
          "The selected team member was not found."
        );
      }

      if (
        context.role ===
          "manager" &&
        normalizeRole(
          assignee.workspaceRole ||
            assignee.role
        ) !== "caller"
      ) {
        throw httpError(
          403,
          "Managers can only assign tasks to callers."
        );
      }

      if (
        context.role ===
          "manager" &&
        assignee.managerId &&
        assignee.managerId !==
          user.id
      ) {
        throw httpError(
          403,
          "The selected caller belongs to another manager."
        );
      }

      const now =
        nowIso();

      const task = {
        id: crypto.randomUUID(),
        workspaceId:
          context.workspaceId,
        title,
        description:
          clean(
            input.description
          ),
        assigneeId,
        assignedToUserId:
          assigneeId,
        status:
          normalizeTaskStatus(
            input.status ||
              "pending"
          ),
        priority:
          normalizePriority(
            input.priority
          ),
        dueAt:
          normalizeOptionalDate(
            input.dueAt
          ),
        relatedLeadId:
          clean(
            input.relatedLeadId ||
              input.leadId
          ),
        relatedAssignmentId:
          clean(
            input.relatedAssignmentId ||
              input.assignmentId
          ),
        createdBy:
          user.id,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };

      draft.teamTasks.unshift(
        task
      );

      created = enrichTask({
        state: draft,
        task,
        workspaceId:
          context.workspaceId,
      });
    });

    return created;
  }

  function updateTask(
    user,
    taskId,
    input = {}
  ) {
    const context =
      requireWorkspaceUser(user);

    let updated = null;

    store.update((draft) => {
      draft.teamTasks =
        draft.teamTasks || [];

      const task =
        draft.teamTasks.find(
          (item) =>
            item.id === taskId &&
            item.workspaceId ===
              context.workspaceId
        );

      if (!task) {
        return;
      }

      const assigneeId =
        getAssigneeId(task);

      const canManageTask =
        MANAGEMENT_ROLES.has(
          context.role
        );

      const isAssignee =
        assigneeId === user.id;

      if (
        !canManageTask &&
        !isAssignee
      ) {
        throw httpError(
          403,
          "You cannot update this task."
        );
      }

      if (
        input.status !==
        undefined
      ) {
        task.status =
          normalizeTaskStatus(
            input.status
          );

        task.completedAt =
          task.status ===
            "completed"
            ? nowIso()
            : null;
      }

      if (canManageTask) {
        if (
          input.title !==
          undefined
        ) {
          task.title =
            clean(input.title);

          if (!task.title) {
            throw httpError(
              400,
              "A task title is required."
            );
          }
        }

        if (
          input.description !==
          undefined
        ) {
          task.description =
            clean(
              input.description
            );
        }

        if (
          input.priority !==
          undefined
        ) {
          task.priority =
            normalizePriority(
              input.priority
            );
        }

        if (
          input.dueAt !==
          undefined
        ) {
          task.dueAt =
            normalizeOptionalDate(
              input.dueAt
            );
        }

        if (
          input.assigneeId !==
            undefined ||
          input.assignedToUserId !==
            undefined
        ) {
          const newAssigneeId =
            clean(
              input.assigneeId ||
                input.assignedToUserId
            );

          const assignee =
            (draft.users || []).find(
              (member) =>
                member.id ===
                  newAssigneeId &&
                member.workspaceId ===
                  context.workspaceId
            );

          if (!assignee) {
            throw httpError(
              404,
              "The selected assignee was not found."
            );
          }

          if (
            context.role ===
              "manager" &&
            normalizeRole(
              assignee.workspaceRole ||
                assignee.role
            ) !== "caller"
          ) {
            throw httpError(
              403,
              "Managers can only assign tasks to callers."
            );
          }

          task.assigneeId =
            newAssigneeId;

          task.assignedToUserId =
            newAssigneeId;
        }
      }

      task.updatedAt =
        nowIso();

      updated = enrichTask({
        state: draft,
        task,
        workspaceId:
          context.workspaceId,
      });
    });

    if (!updated) {
      throw httpError(
        404,
        "Task not found."
      );
    }

    return updated;
  }

  function deleteTask(
    user,
    taskId
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_tasks"
    );

    let removed = null;

    store.update((draft) => {
      draft.teamTasks =
        draft.teamTasks || [];

      const index =
        draft.teamTasks.findIndex(
          (item) =>
            item.id === taskId &&
            item.workspaceId ===
              context.workspaceId
        );

      if (index < 0) {
        return;
      }

      const task =
        draft.teamTasks[index];

      if (
        context.role ===
          "manager" &&
        task.createdBy !==
          user.id
      ) {
        throw httpError(
          403,
          "Managers can only delete tasks they created."
        );
      }

      removed =
        draft.teamTasks.splice(
          index,
          1
        )[0];
    });

    if (!removed) {
      throw httpError(
        404,
        "Task not found."
      );
    }

    return removed;
  }

  /*
   * Dialers
   */

  function listDialers(user) {
    const context =
      requireWorkspaceUser(user);

    const all =
      getWorkspaceRecords(
        store.read().dialerProfiles,
        context.workspaceId
      ).filter(
        (item) =>
          item.active !== false
      );

    if (
      allowed(
        context,
        [
          "owner",
          "admin",
          "manager",
        ],
        "manage_dialers"
      )
    ) {
      return all.map(
        sanitizeDialer
      );
    }

    const assigned =
      clean(
        user.dialerId ||
          user.assignedDialerId
      );

    return all
      .filter(
        (item) =>
          item.id === assigned ||
          item.assignedUserIds?.includes(
            user.id
          )
      )
      .map(sanitizeDialer);
  }

  function saveDialer(
    user,
    input = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_dialers"
    );

    const now =
      nowIso();

    const record = {
      id:
        clean(input.id) ||
        crypto.randomUUID(),
      workspaceId:
        context.workspaceId,
      name:
        clean(
          input.name ||
            "Vonage dialer"
        ),
      provider:
        clean(
          input.provider ||
            "vonage"
        ).toLowerCase(),
      applicationId:
        clean(
          input.applicationId
        ),
      fromNumber:
        normalizePhone(
          input.fromNumber
        ),
      webhookBaseUrl:
        clean(
          input.webhookBaseUrl
        ).replace(/\/$/, ""),
      privateKeyEnvName:
        clean(
          input.privateKeyEnvName ||
            "VONAGE_PRIVATE_KEY"
        ),
      assignedUserIds:
        uniqueStrings(
          input.assignedUserIds
        ),
      active:
        input.active !== false,
      createdBy:
        user.id,
      createdAt: now,
      updatedAt: now,
    };

    if (
      !record.applicationId ||
      !record.fromNumber
    ) {
      throw httpError(
        400,
        "Vonage applicationId and fromNumber are required."
      );
    }

    if (
      record.webhookBaseUrl &&
      !/^https:\/\//i.test(
        record.webhookBaseUrl
      ) &&
      !/^http:\/\/localhost(?::\d+)?/i.test(
        record.webhookBaseUrl
      )
    ) {
      throw httpError(
        400,
        "The webhook base URL must use HTTPS."
      );
    }

    store.update((draft) => {
      draft.dialerProfiles =
        draft.dialerProfiles ||
        [];

      const index =
        draft.dialerProfiles.findIndex(
          (item) =>
            item.id ===
              record.id &&
            item.workspaceId ===
              context.workspaceId
        );

      if (index >= 0) {
        record.createdAt =
          draft.dialerProfiles[
            index
          ].createdAt || now;

        draft.dialerProfiles[
          index
        ] = record;
      } else {
        draft.dialerProfiles.unshift(
          record
        );
      }

      synchronizeAssignedResource({
        users:
          draft.users || [],
        workspaceId:
          context.workspaceId,
        resourceId:
          record.id,
        assignedUserIds:
          record.assignedUserIds,
        userField:
          "dialerId",
      });
    });

    return sanitizeDialer(
      record
    );
  }

  function deleteDialer(
    user,
    dialerId
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_dialers"
    );

    let removed = null;

    store.update((draft) => {
      draft.dialerProfiles =
        draft.dialerProfiles ||
        [];

      const index =
        draft.dialerProfiles.findIndex(
          (item) =>
            item.id ===
              dialerId &&
            item.workspaceId ===
              context.workspaceId
        );

      if (index < 0) {
        return;
      }

      removed =
        draft.dialerProfiles.splice(
          index,
          1
        )[0];

      for (const member of
        draft.users || []) {
        if (
          member.workspaceId ===
            context.workspaceId &&
          member.dialerId ===
            dialerId
        ) {
          member.dialerId = "";
          member.updatedAt =
            nowIso();
        }
      }
    });

    if (!removed) {
      throw httpError(
        404,
        "Dialer not found."
      );
    }

    return sanitizeDialer(
      removed
    );
  }

  /*
   * SMTP sender identities
   */

  function listSenders(user) {
    const context =
      requireWorkspaceUser(user);

    const all =
      getWorkspaceRecords(
        store.read().senderProfiles,
        context.workspaceId
      ).filter(
        (item) =>
          item.active !== false
      );

    if (
      allowed(
        context,
        [
          "owner",
          "admin",
          "manager",
        ],
        "manage_senders"
      )
    ) {
      return all.map(
        redactSender
      );
    }

    const assigned =
      clean(
        user.senderId ||
          user.assignedSenderId
      );

    return all
      .filter(
        (item) =>
          item.id === assigned ||
          item.assignedUserIds?.includes(
            user.id
          )
      )
      .map(redactSender);
  }

  function saveSender(
    user,
    input = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_senders"
    );

    const now =
      nowIso();

    const existing =
      getWorkspaceRecords(
        store.read().senderProfiles,
        context.workspaceId
      ).find(
        (item) =>
          item.id ===
          clean(input.id)
      );

    const record = {
      id:
        clean(input.id) ||
        crypto.randomUUID(),
      workspaceId:
        context.workspaceId,
      name:
        clean(
          input.name ||
            input.fromEmail ||
            "SMTP sender"
        ),
      host:
        clean(input.host),
      port:
        normalizePort(
          input.port
        ),
      secure:
        Boolean(
          input.secure
        ),
      username:
        clean(
          input.username
        ),
      password:
        clean(
          input.password
        ) ||
        existing?.password ||
        "",
      fromName:
        clean(
          input.fromName
        ),
      fromEmail:
        normalizeEmail(
          input.fromEmail
        ),
      replyTo:
        input.replyTo
          ? normalizeEmail(
              input.replyTo
            )
          : "",
      assignedUserIds:
        uniqueStrings(
          input.assignedUserIds
        ),
      active:
        input.active !== false,
      createdBy:
        existing?.createdBy ||
        user.id,
      createdAt:
        existing?.createdAt ||
        now,
      updatedAt: now,
    };

    if (
      !record.host ||
      !record.username ||
      !record.fromEmail
    ) {
      throw httpError(
        400,
        "SMTP host, username and fromEmail are required."
      );
    }

    if (!record.password) {
      throw httpError(
        400,
        "An SMTP password is required."
      );
    }

    store.update((draft) => {
      draft.senderProfiles =
        draft.senderProfiles ||
        [];

      const index =
        draft.senderProfiles.findIndex(
          (item) =>
            item.id ===
              record.id &&
            item.workspaceId ===
              context.workspaceId
        );

      if (index >= 0) {
        draft.senderProfiles[
          index
        ] = record;
      } else {
        draft.senderProfiles.unshift(
          record
        );
      }

      synchronizeAssignedResource({
        users:
          draft.users || [],
        workspaceId:
          context.workspaceId,
        resourceId:
          record.id,
        assignedUserIds:
          record.assignedUserIds,
        userField:
          "senderId",
      });
    });

    return redactSender(record);
  }

  function deleteSender(
    user,
    senderId
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
        "manager",
      ],
      "manage_senders"
    );

    let removed = null;

    store.update((draft) => {
      draft.senderProfiles =
        draft.senderProfiles ||
        [];

      const index =
        draft.senderProfiles.findIndex(
          (item) =>
            item.id ===
              senderId &&
            item.workspaceId ===
              context.workspaceId
        );

      if (index < 0) {
        return;
      }

      removed =
        draft.senderProfiles.splice(
          index,
          1
        )[0];

      for (const member of
        draft.users || []) {
        if (
          member.workspaceId ===
            context.workspaceId &&
          member.senderId ===
            senderId
        ) {
          member.senderId = "";
          member.updatedAt =
            nowIso();
        }
      }
    });

    if (!removed) {
      throw httpError(
        404,
        "Sender identity not found."
      );
    }

    return redactSender(
      removed
    );
  }

  /*
   * Report templates
   */

  function getReportTemplate(user) {
    const context =
      requireWorkspaceUser(user);

    const template =
      getWorkspaceRecords(
        store.read()
          .auditReportTemplates,
        context.workspaceId
      )[0];

    return (
      template || {
        id: "",
        workspaceId:
          context.workspaceId,
        name:
          "Default audit format",
        claudeSystemPrompt:
          "",
        miniInstructions:
          "",
        competitorInstructions:
          "",
        fullInstructions:
          "",
        miniEnabled: true,
        competitorEnabled: true,
        fullEnabled: true,
      }
    );
  }

  function saveReportTemplate(
    user,
    input = {}
  ) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
      ],
      "manage_report_templates"
    );

    const now =
      nowIso();

    let saved = null;

    store.update((draft) => {
      draft.auditReportTemplates =
        draft.auditReportTemplates ||
        [];

      const existingIndex =
        draft.auditReportTemplates.findIndex(
          (item) =>
            item.workspaceId ===
              context.workspaceId
        );

      const existing =
        existingIndex >= 0
          ? draft.auditReportTemplates[
              existingIndex
            ]
          : null;

      saved = {
        id:
          existing?.id ||
          crypto.randomUUID(),
        workspaceId:
          context.workspaceId,
        name:
          clean(
            input.name ||
              existing?.name ||
              "Default audit format"
          ),
        claudeSystemPrompt:
          clean(
            input.claudeSystemPrompt
          ),
        miniInstructions:
          clean(
            input.miniInstructions
          ),
        competitorInstructions:
          clean(
            input.competitorInstructions
          ),
        fullInstructions:
          clean(
            input.fullInstructions
          ),
        miniEnabled:
          input.miniEnabled !==
          false,
        competitorEnabled:
          input.competitorEnabled !==
          false,
        fullEnabled:
          input.fullEnabled !==
          false,
        updatedBy:
          user.id,
        createdAt:
          existing?.createdAt ||
          now,
        updatedAt: now,
      };

      if (existingIndex >= 0) {
        draft.auditReportTemplates[
          existingIndex
        ] = saved;
      } else {
        draft.auditReportTemplates.unshift(
          saved
        );
      }
    });

    return saved;
  }

  /*
   * Dashboard
   */

  function salesDashboard(user) {
    const context =
      requireWorkspaceUser(user);

    const state = store.read();

    const role =
      context.role;

    const assignments =
      MANAGEMENT_ROLES.has(role)
        ? listAssignments(
            user,
            {
              limit: 250,
            }
          )
        : listMyAssignments(
            user,
            {
              limit: 250,
            }
          );

    const tasks =
      MANAGEMENT_ROLES.has(role)
        ? listTasks(user, {
            limit: 250,
          })
        : listMyTasks(user, {
            limit: 250,
          });

    const calls =
      getWorkspaceRecords(
        state.callRecords,
        context.workspaceId
      ).filter((call) => {
        if (
          MANAGEMENT_ROLES.has(
            role
          )
        ) {
          return true;
        }

        return (
          getCallerId(call) ===
          user.id
        );
      });

    const members =
      MANAGEMENT_ROLES.has(role)
        ? listTeam(user)
        : [];

    return {
      role,
      members,
      assignments,
      tasks,
      calls: sortByDateDescending(
        calls,
        [
          "startedAt",
          "createdAt",
          "updatedAt",
        ]
      ).slice(0, 100),
      reportTemplate:
        getReportTemplate(user),
      totals: {
        assignments:
          assignments.length,
        activeAssignments:
          assignments.filter(
            (item) =>
              ACTIVE_ASSIGNMENT_STATUSES.has(
                normalizeStatus(
                  item.status
                )
              )
          ).length,
        followUps:
          assignments.filter(
            (item) =>
              normalizeStatus(
                item.status
              ) === "follow_up"
          ).length,
        qualified:
          assignments.filter(
            (item) =>
              [
                "qualified",
                "meeting_booked",
              ].includes(
                normalizeStatus(
                  item.status
                )
              )
          ).length,
        tasks:
          tasks.length,
        pendingTasks:
          tasks.filter(
            (item) =>
              ![
                "completed",
                "cancelled",
              ].includes(
                normalizeStatus(
                  item.status
                )
              )
          ).length,
        calls:
          calls.length,
      },
    };
  }

  function ownerOverview(user) {
    const context = requireRole(
      user,
      [
        "owner",
        "admin",
      ],
      "view_all_performance"
    );

    const state = store.read();

    const team =
      listTeam(user);

    const calls =
      getWorkspaceRecords(
        state.callRecords,
        context.workspaceId
      );

    const assignments =
      getWorkspaceRecords(
        state.leadAssignments,
        context.workspaceId
      );

    const tasks =
      getWorkspaceRecords(
        state.teamTasks,
        context.workspaceId
      );

    const audits =
      getWorkspaceAudits(
        state,
        context.workspaceId
      );

    const attendance =
      getWorkspaceRecords(
        state.attendanceRecords,
        context.workspaceId
      );

    const currentAttendance =
      getTodayAttendance(
        attendance
      );

    return {
      team,
      totals: {
        members:
          team.length,
        callers:
          team.filter(
            (item) =>
              item.role ===
              "caller"
          ).length,
        managers:
          team.filter(
            (item) =>
              item.role ===
              "manager"
          ).length,
        activeMembers:
          team.filter(
            (item) =>
              item.active !== false
          ).length,
        checkedInToday:
          currentAttendance.filter(
            (item) =>
              [
                "checked_in",
                "present",
                "late",
              ].includes(
                normalizeStatus(
                  item.status
                )
              )
          ).length,
        totalCalls:
          calls.length,
        answeredCalls:
          calls.filter(
            isAnsweredCall
          ).length,
        assignedLeads:
          assignments.length,
        activeAssignments:
          assignments.filter(
            (item) =>
              ACTIVE_ASSIGNMENT_STATUSES.has(
                normalizeStatus(
                  item.status
                )
              )
          ).length,
        completedAssignments:
          assignments.filter(
            (item) =>
              normalizeStatus(
                item.status
              ) ===
              "completed"
          ).length,
        qualifiedLeads:
          assignments.filter(
            (item) =>
              [
                "qualified",
                "meeting_booked",
              ].includes(
                normalizeStatus(
                  item.status
                )
              )
          ).length,
        meetingsBooked:
          assignments.filter(
            (item) =>
              normalizeStatus(
                item.status
              ) ===
              "meeting_booked"
          ).length,
        pendingTasks:
          tasks.filter(
            (item) =>
              ![
                "completed",
                "cancelled",
              ].includes(
                normalizeStatus(
                  item.status
                )
              )
          ).length,
        generatedAudits:
          audits.filter(
            (item) =>
              [
                "completed",
                "ready",
              ].includes(
                normalizeStatus(
                  item.status ||
                    "completed"
                )
              )
          ).length,
      },
      recentCalls:
        sortByDateDescending(
          calls,
          [
            "startedAt",
            "createdAt",
          ]
        ).slice(0, 100),
      recentAssignments:
        prepareAssignments({
          state,
          assignments,
          workspaceId:
            context.workspaceId,
          options: {
            limit: 100,
          },
        }),
      recentTasks:
        prepareTasks({
          state,
          tasks,
          workspaceId:
            context.workspaceId,
          options: {
            limit: 100,
          },
        }),
      auditTemplate:
        getReportTemplate(user),
    };
  }

  return {
    listTeam,
    updateMember,
    updateMemberTools,

    getPerformance,
    getMyPerformance,

    listLeads,
    listAssignments,
    listMyAssignments,
    getAssignment,
    createAssignments,
    updateAssignment,
    deleteAssignment,

    listTasks,
    listMyTasks,
    createTask,
    updateTask,
    deleteTask,

    listDialers,
    saveDialer,
    deleteDialer,

    listSenders,
    saveSender,
    deleteSender,

    getReportTemplate,
    saveReportTemplate,

    salesDashboard,
    ownerOverview,
  };
}

/*
 * Assignment helpers
 */

function prepareAssignments({
  state,
  assignments,
  workspaceId,
  options = {},
}) {
  const status =
    normalizeStatus(
      options.status
    );

  const assigneeId =
    clean(
      options.assigneeId
    );

  const search =
    clean(options.search)
      .toLowerCase();

  const limit =
    clampInteger(
      options.limit,
      1,
      1000,
      250
    );

  return sortByDateDescending(
    assignments,
    [
      "updatedAt",
      "assignedAt",
      "createdAt",
    ]
  )
    .filter((assignment) => {
      if (
        status &&
        normalizeStatus(
          assignment.status
        ) !== status
      ) {
        return false;
      }

      if (
        assigneeId &&
        getAssigneeId(
          assignment
        ) !== assigneeId
      ) {
        return false;
      }

      if (search) {
        const lead =
          findLeadById(
            state,
            workspaceId,
            assignment.leadId
          ) || {};

        const haystack = [
          lead.business,
          lead.name,
          lead.phone,
          lead.email,
          lead.website,
          lead.address,
          assignment.instructions,
          assignment.notes,
        ]
          .join(" ")
          .toLowerCase();

        if (
          !haystack.includes(
            search
          )
        ) {
          return false;
        }
      }

      return true;
    })
    .slice(0, limit)
    .map((assignment) =>
      enrichAssignment({
        state,
        assignment,
        workspaceId,
      })
    );
}

function enrichAssignment({
  state,
  assignment,
  workspaceId,
}) {
  const lead =
    findLeadById(
      state,
      workspaceId,
      assignment.leadId
    );

  const assignee =
    (state.users || []).find(
      (member) =>
        member.id ===
          getAssigneeId(
            assignment
          ) &&
        member.workspaceId ===
          workspaceId
    );

  const createdBy =
    (state.users || []).find(
      (member) =>
        member.id ===
          assignment.createdBy &&
        member.workspaceId ===
          workspaceId
    );

  return {
    ...assignment,
    assigneeId:
      getAssigneeId(
        assignment
      ),
    assignedToUserId:
      getAssigneeId(
        assignment
      ),
    leadId:
      assignment.leadId,
    lead:
      lead || {
        id:
          assignment.leadId,
        business:
          assignment.leadName ||
          "Business lead",
        name:
          assignment.leadName ||
          "Business lead",
        phone: "",
        email: "",
        website: "",
        address: "",
        category: "",
        miniAudit: null,
        miniAuditStatus:
          "not_started",
        miniAuditPdfUrl:
          "",
      },
    assignee:
      assignee
        ? sanitizeMember(
            assignee
          )
        : null,
    createdByUser:
      createdBy
        ? sanitizeMember(
            createdBy
          )
        : null,
  };
}

function assertAssignmentAccess({
  user,
  context,
  assignment,
  state,
  write = false,
}) {
  if (
    context.role ===
      "owner" ||
    context.role ===
      "admin"
  ) {
    return;
  }

  const assigneeId =
    getAssigneeId(
      assignment
    );

  if (
    assigneeId === user.id
  ) {
    return;
  }

  if (
    context.role ===
      "manager"
  ) {
    const assignee =
      (state.users || []).find(
        (member) =>
          member.id ===
            assigneeId &&
          member.workspaceId ===
            context.workspaceId
      );

    if (
      !assignee?.managerId ||
      assignee.managerId ===
        user.id ||
      assignment.createdBy ===
        user.id
    ) {
      return;
    }
  }

  throw httpError(
    403,
    write
      ? "You cannot update this lead assignment."
      : "You cannot view this lead assignment."
  );
}

/*
 * Task helpers
 */

function prepareTasks({
  state,
  tasks,
  workspaceId,
  options = {},
}) {
  const status =
    normalizeStatus(
      options.status
    );

  const limit =
    clampInteger(
      options.limit,
      1,
      1000,
      250
    );

  return sortByDateDescending(
    tasks,
    [
      "updatedAt",
      "createdAt",
    ]
  )
    .filter(
      (task) =>
        !status ||
        normalizeStatus(
          task.status
        ) === status
    )
    .slice(0, limit)
    .map((task) =>
      enrichTask({
        state,
        task,
        workspaceId,
      })
    );
}

function enrichTask({
  state,
  task,
  workspaceId,
}) {
  const assignee =
    (state.users || []).find(
      (member) =>
        member.id ===
          getAssigneeId(task) &&
        member.workspaceId ===
          workspaceId
    );

  const creator =
    (state.users || []).find(
      (member) =>
        member.id ===
          task.createdBy &&
        member.workspaceId ===
          workspaceId
    );

  const lead =
    task.relatedLeadId
      ? findLeadById(
          state,
          workspaceId,
          task.relatedLeadId
        )
      : null;

  return {
    ...task,
    assigneeId:
      getAssigneeId(task),
    assignee:
      assignee
        ? sanitizeMember(
            assignee
          )
        : null,
    createdByUser:
      creator
        ? sanitizeMember(
            creator
          )
        : null,
    createdBy:
      task.createdBy,
    manager:
      creator
        ? sanitizeMember(
            creator
          )
        : null,
    lead,
  };
}

/*
 * Lead helpers
 */

function getAllWorkspaceLeads(
  state,
  workspaceId
) {
  const collections = [
    state.leads,
    state.externalLeads,
    state.googlePlacesLeads,
    state.campaignLeads,
    state.contacts,
  ];

  const map =
    new Map();

  for (const collection of collections) {
    for (const item of
      Array.isArray(collection)
        ? collection
        : []) {
      if (
        !recordBelongsToWorkspace(
          item,
          workspaceId
        )
      ) {
        continue;
      }

      const id =
        clean(
          item.id ||
            item.leadId ||
            item.placeId ||
            item.googlePlaceId
        );

      if (!id) {
        continue;
      }

      const current =
        map.get(id) || {};

      map.set(id, {
        ...current,
        ...normalizeLeadRecord(
          item,
          state,
          workspaceId
        ),
        id,
      });
    }
  }

  return [
    ...map.values(),
  ];
}

function findLeadById(
  state,
  workspaceId,
  leadId
) {
  const cleanedId =
    clean(leadId);

  if (!cleanedId) {
    return null;
  }

  const lead =
    getAllWorkspaceLeads(
      state,
      workspaceId
    ).find(
      (item) =>
        item.id ===
        cleanedId
    );

  return lead || null;
}

function normalizeLeadRecord(
  item,
  state,
  workspaceId
) {
  const id =
    clean(
      item.id ||
        item.leadId ||
        item.placeId ||
        item.googlePlaceId
    );

  const audit =
    findLeadAudit({
      state,
      workspaceId,
      leadId: id,
      embeddedAudit:
        item.miniAudit ||
        item.audit ||
        null,
    });

  const auditStatus =
    normalizeStatus(
      item.miniAuditStatus ||
        item.auditStatus ||
        audit?.status ||
        (audit
          ? "completed"
          : "not_started")
    );

  const website =
    clean(
      item.website ||
        item.websiteUri ||
        item.domain ||
        item.url
    );

  return {
    ...item,
    id,
    workspaceId:
      item.workspaceId ||
      workspaceId,
    business:
      clean(
        item.business ||
          item.businessName ||
          item.displayName ||
          item.name
      ),
    name:
      clean(
        item.name ||
          item.business ||
          item.businessName ||
          item.displayName
      ),
    phone:
      clean(
        item.phone ||
          item.phoneNumber ||
          item.internationalPhoneNumber ||
          item.nationalPhoneNumber
      ),
    email:
      clean(
        item.email ||
          item.contactEmail
      ),
    website,
    address:
      clean(
        item.address ||
          item.formattedAddress ||
          item.location
      ),
    location:
      clean(
        item.location ||
          item.address ||
          item.formattedAddress
      ),
    category:
      clean(
        item.category ||
          item.primaryType ||
          item.type
      ),
    description:
      clean(
        item.description ||
          item.summary
      ),
    miniAudit:
      audit || null,
    miniAuditStatus:
      auditStatus ||
      "not_started",
    miniAuditPdfUrl:
      clean(
        item.miniAuditPdfUrl ||
          audit?.pdfUrl ||
          audit?.downloadUrl
      ),
    competitorAnalysis:
      item.competitorAnalysis ||
      null,
    fullAudit:
      item.fullAudit ||
      null,
  };
}

function findLeadAudit({
  state,
  workspaceId,
  leadId,
  embeddedAudit,
}) {
  if (embeddedAudit) {
    return embeddedAudit;
  }

  const audits =
    getWorkspaceAudits(
      state,
      workspaceId
    );

  return (
    sortByDateDescending(
      audits.filter(
        (audit) =>
          clean(
            audit.leadId ||
              audit.entityId
          ) === leadId &&
          normalizeReportType(
            audit.type ||
              audit.reportType ||
              "mini_audit"
          ) ===
            "mini_audit"
      ),
      [
        "completedAt",
        "updatedAt",
        "createdAt",
      ]
    )[0] || null
  );
}

function getWorkspaceAudits(
  state,
  workspaceId
) {
  return [
    ...(Array.isArray(
      state.leadAuditReports
    )
      ? state.leadAuditReports
      : []),
    ...(Array.isArray(
      state.leadAudits
    )
      ? state.leadAudits
      : []),
    ...(Array.isArray(
      state.auditJobs
    )
      ? state.auditJobs
      : []),
  ].filter((item) =>
    recordBelongsToWorkspace(
      item,
      workspaceId
    )
  );
}

/*
 * General helpers
 */

function getWorkspaceUsers(
  state,
  workspaceId
) {
  const memberships = Array.isArray(
    state.workspaceMembers
  )
    ? state.workspaceMembers
    : [];

  const users = Array.isArray(
    state.users
  )
    ? state.users
    : [];

  const memberUserIds = new Set(
    memberships
      .filter(
        (membership) =>
          membership.workspaceId ===
            workspaceId &&
          membership.status !==
            "removed" &&
          membership.active !==
            false &&
          membership.isActive !==
            false
      )
      .map(
        (membership) =>
          membership.userId
      )
  );

  return users.filter((user) => {
    if (
      user.workspaceId === workspaceId
    ) {
      return true;
    }

    return memberUserIds.has(
      user.id
    );
  });
}

function getWorkspaceRecords(
  collection,
  workspaceId
) {
  return (
    Array.isArray(collection)
      ? collection
      : []
  ).filter((item) =>
    recordBelongsToWorkspace(
      item,
      workspaceId
    )
  );
}

function recordBelongsToWorkspace(
  item,
  workspaceId
) {
  const recordWorkspaceId =
    clean(
      item?.workspaceId ||
        item?.accountId ||
        item?.ownerWorkspaceId
    );

  return (
    !recordWorkspaceId ||
    recordWorkspaceId ===
      workspaceId
  );
}

function canManagerViewMember({
  actorRole,
  actorUserId,
  member,
}) {
  if (actorRole !== "manager") {
    return true;
  }

  const memberRole =
    normalizeRole(
      member.workspaceRole ||
        member.role
    );

  return (
    member.id ===
      actorUserId ||
    (memberRole === "caller" &&
      (!member.managerId ||
        member.managerId ===
          actorUserId))
  );
}

function validateResourceAssignment({
  draft,
  workspaceId,
  collection,
  resourceId,
  label,
}) {
  if (!resourceId) {
    return;
  }

  const exists =
    (
      draft[collection] ||
      []
    ).some(
      (item) =>
        item.id ===
          resourceId &&
        item.workspaceId ===
          workspaceId &&
        item.active !== false
    );

  if (!exists) {
    throw httpError(
      404,
      `${label} not found.`
    );
  }
}

function synchronizeAssignedResource({
  users,
  workspaceId,
  resourceId,
  assignedUserIds,
  userField,
}) {
  const assignedSet =
    new Set(
      assignedUserIds
    );

  for (const member of users) {
    if (
      member.workspaceId !==
      workspaceId
    ) {
      continue;
    }

    if (
      assignedSet.has(
        member.id
      )
    ) {
      member[userField] =
        resourceId;

      member.updatedAt =
        nowIso();
    } else if (
      member[userField] ===
      resourceId
    ) {
      member[userField] =
        "";

      member.updatedAt =
        nowIso();
    }
  }
}

function getLatestAttendance(
  records,
  userId
) {
  return (
    sortByDateDescending(
      records.filter(
        (record) =>
          getAttendanceUserId(
            record
          ) === userId
      ),
      [
        "checkedInAt",
        "createdAt",
        "updatedAt",
      ]
    )[0] || null
  );
}

function getTodayAttendance(
  records
) {
  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  return records.filter(
    (record) => {
      const value =
        record.checkedInAt ||
        record.createdAt ||
        "";

      return String(value).startsWith(
        today
      );
    }
  );
}

function getAssigneeId(item) {
  return clean(
    item?.assigneeId ||
      item?.assignedToUserId ||
      item?.assignedTo ||
      item?.userId ||
      item?.assignee?.id ||
      item?.user?.id
  );
}

function getCallerId(call) {
  return clean(
    call?.callerUserId ||
      call?.callerId ||
      call?.assignedTo ||
      call?.userId ||
      call?.createdByUserId ||
      call?.caller?.id ||
      call?.user?.id
  );
}

function getAttendanceUserId(
  record
) {
  return clean(
    record?.userId ||
      record?.memberId ||
      record?.profileId ||
      record?.member?.id ||
      record?.user?.id ||
      record?.profile?.id
  );
}

function isAnsweredCall(call) {
  return [
    "answered",
    "connected",
    "completed",
    "qualified",
    "meeting_booked",
  ].includes(
    normalizeStatus(
      call?.outcome ||
        call?.status
    )
  );
}

function sanitizeMember(member) {
  return {
    id: member.id,
    workspaceId:
      member.workspaceId,
    name: member.name,
    firstName:
      member.firstName ||
      firstName(member.name),
    lastName:
      member.lastName ||
      lastName(member.name),
    email: member.email,
    phone:
      member.phone ||
      member.mobile ||
      "",
    avatarUrl:
      member.avatarUrl ||
      member.photoUrl ||
      member.profileImage ||
      "",
    jobTitle:
      member.jobTitle ||
      "",
    department:
      member.department ||
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
    managerId:
      member.managerId ||
      "",
    active:
      member.active !== false,
    status:
      member.status ||
      "active",
    availabilityStatus:
      member.availabilityStatus ||
      "offline",
    dialerId:
      member.dialerId ||
      "",
    senderId:
      member.senderId ||
      "",
  };
}

function sanitizeDialer(item) {
  return {
    ...item,
    privateKey:
      undefined,
  };
}

function redactSender(item) {
  return {
    ...item,
    password:
      item.password
        ? "********"
        : "",
  };
}

function normalizeRole(value) {
  const role =
    normalizeStatus(value);

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
    role === "caller" ||
    role.includes(
      "cold_caller"
    ) ||
    role.includes(
      "sales_representative"
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

function normalizeAssignmentStatus(
  value
) {
  const status =
    normalizeStatus(
      value ||
        "assigned"
    );

  if (
    !ASSIGNMENT_STATUSES.has(
      status
    )
  ) {
    throw httpError(
      400,
      `Invalid assignment status: ${status}.`
    );
  }

  return status;
}

function normalizeTaskStatus(
  value
) {
  const status =
    normalizeStatus(
      value ||
        "pending"
    );

  if (
    !TASK_STATUSES.has(
      status
    )
  ) {
    throw httpError(
      400,
      `Invalid task status: ${status}.`
    );
  }

  return status;
}

function normalizePriority(
  value
) {
  const priority =
    normalizeStatus(
      value ||
        "normal"
    );

  if (
    !PRIORITIES.has(
      priority
    )
  ) {
    throw httpError(
      400,
      `Invalid priority: ${priority}.`
    );
  }

  return priority;
}

function normalizeReportType(
  value
) {
  const type =
    normalizeStatus(
      value ||
        "mini_audit"
    );

  return REPORT_TYPES.has(type)
    ? type
    : "mini_audit";
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function normalizePhone(value) {
  const text =
    clean(value).replace(
      /[\s().-]/g,
      ""
    );

  if (
    !/^\+[1-9]\d{7,14}$/.test(
      text
    )
  ) {
    throw httpError(
      400,
      "Phone numbers must use E.164 format, for example +14155552671."
    );
  }

  return text;
}

function normalizeOptionalPhone(
  value
) {
  const text =
    clean(value);

  if (!text) {
    return "";
  }

  return normalizePhone(text);
}

function normalizeEmail(value) {
  const email =
    clean(value).toLowerCase();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email
    )
  ) {
    throw httpError(
      400,
      "A valid email address is required."
    );
  }

  return email;
}

function normalizePort(value) {
  const port =
    Number(value || 587);

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw httpError(
      400,
      "SMTP port must be between 1 and 65535."
    );
  }

  return port;
}

function normalizeOptionalDate(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
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

function sortByDateDescending(
  records,
  fields
) {
  return [
    ...records,
  ].sort((a, b) => {
    const aTime =
      getFirstDateValue(
        a,
        fields
      );

    const bTime =
      getFirstDateValue(
        b,
        fields
      );

    return bTime - aTime;
  });
}

function getFirstDateValue(
  record,
  fields
) {
  for (const field of fields) {
    const value =
      Date.parse(
        record?.[field] ||
          ""
      );

    if (
      Number.isFinite(value)
    ) {
      return value;
    }
  }

  return 0;
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
    !Number.isFinite(number)
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

function uniqueStrings(values) {
  return [
    ...new Set(
      (
        Array.isArray(values)
          ? values
          : []
      )
        .map(clean)
        .filter(Boolean)
    ),
  ];
}

function firstName(value) {
  return (
    String(value || "")
      .trim()
      .split(/\s+/)[0] ||
    ""
  );
}

function lastName(value) {
  const words =
    String(value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  return words.length > 1
    ? words.slice(1).join(" ")
    : "";
}

function average(values) {
  return values.length
    ? Math.round(
        values.reduce(
          (total, value) =>
            total + value,
          0
        ) / values.length
      )
    : 0;
}

function clean(value) {
  return String(
    value ?? ""
  ).trim();
}

function nowIso() {
  return new Date().toISOString();
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