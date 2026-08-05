const DASHBOARD_ROLES = new Set([
  "owner",
  "admin",
  "manager",
  "caller",
  "viewer",
]);

export function createRoleDashboardService({
  store,
  workspaceService = null,
}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createRoleDashboardService requires a store exposing read() and update()."
    );
  }

  return {
    getDashboard,
    getOwnerDashboard,
    getAdminDashboard,
    getManagerDashboard,
    getCallerDashboard,
    getNavigation,
    registerRoutes,
  };

  function registerRoutes({
    app,
    authenticate,
    asyncRoute = defaultAsyncRoute,
  }) {
    if (!app) {
      throw new Error(
        "Dashboard route registration requires an Express application."
      );
    }

    if (typeof authenticate !== "function") {
      throw new Error(
        "Dashboard route registration requires authentication middleware."
      );
    }

    app.get(
      "/api/dashboard",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          dashboard: getDashboard(req.user),
        });
      })
    );

    app.get(
      "/api/dashboard/navigation",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          navigation: getNavigation(req.user),
        });
      })
    );

    app.get(
      "/api/dashboard/owner",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          dashboard: getOwnerDashboard(req.user),
        });
      })
    );

    app.get(
      "/api/dashboard/admin",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          dashboard: getAdminDashboard(req.user),
        });
      })
    );

    app.get(
      "/api/dashboard/manager",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          dashboard: getManagerDashboard(req.user),
        });
      })
    );

    app.get(
      "/api/dashboard/caller",
      authenticate,
      asyncRoute(async (req, res) => {
        res.json({
          ok: true,
          dashboard: getCallerDashboard(req.user),
        });
      })
    );
  }

  function getDashboard(user) {
    const context = getContext(user);

    if (context.role === "owner") {
      return getOwnerDashboard(user);
    }

    if (context.role === "admin") {
      return getAdminDashboard(user);
    }

    if (context.role === "manager") {
      return getManagerDashboard(user);
    }

    return getCallerDashboard(user);
  }

  function getOwnerDashboard(user) {
    const context = requireRole(user, [
      "owner",
    ]);

    const state = store.read();

    const members = getWorkspaceMembers(
      state,
      context.workspaceId
    );

    const attendance = getAttendanceForDate({
      state,
      workspaceId: context.workspaceId,
      date: getWorkspaceDate(context),
    });

    const calls = getWorkspaceCalls(
      state,
      context.workspaceId
    );

    const assignments = getWorkspaceAssignments(
      state,
      context.workspaceId
    );

    const tasks = getWorkspaceTasks(
      state,
      context.workspaceId
    );

    const audits = getWorkspaceAudits(
      state,
      context.workspaceId
    );

    const campaigns = getWorkspaceCampaigns(
      state,
      context.workspaceId
    );

    const teamPerformance = members.map(
      (member) =>
        buildMemberPerformance({
          state,
          workspaceId: context.workspaceId,
          member,
          attendance,
          calls,
          assignments,
          tasks,
        })
    );

    return {
      role: "owner",

      navigation: getNavigation(user),

      workspace: publicWorkspace(
        context.workspace
      ),

      currentUser: publicMember(
        context.user
      ),

      summary: {
        teamMembers: members.length,

        managers: members.filter(
          (member) =>
            normalizeRole(
              member.workspaceRole ||
                member.role
            ) === "manager"
        ).length,

        callers: members.filter(
          (member) =>
            normalizeRole(
              member.workspaceRole ||
                member.role
            ) === "caller"
        ).length,

        activeCampaigns: campaigns.filter(
          (campaign) =>
            [
              "active",
              "running",
              "processing",
            ].includes(
              normalizeStatus(
                campaign.status
              )
            )
        ).length,

        totalLeads:
          getWorkspaceLeads(
            state,
            context.workspaceId
          ).length,

        assignedLeads:
          assignments.filter(
            (assignment) =>
              assignment.status !==
              "unassigned"
          ).length,

        callsToday: countRecordsToday(
          calls,
          [
            "createdAt",
            "startedAt",
          ],
          context
        ),

        answeredCallsToday:
          countRecordsToday(
            calls.filter(isAnsweredCall),
            [
              "createdAt",
              "startedAt",
            ],
            context
          ),

        auditsGenerated:
          audits.filter(
            (audit) =>
              [
                "completed",
                "ready",
              ].includes(
                normalizeStatus(
                  audit.status
                )
              )
          ).length,

        checkedInToday:
          attendance.filter(
            (record) =>
              Boolean(
                record.checkedInAt
              )
          ).length,

        onlineNow:
          countOnlineMembers({
            state,
            workspaceId:
              context.workspaceId,
          }),
      },

      teamPerformance,

      attendance: {
        date: getWorkspaceDate(context),

        present: attendance.filter(
          (record) =>
            record.status ===
            "present"
        ).length,

        late: attendance.filter(
          (record) =>
            record.status ===
            "late"
        ).length,

        halfDay: attendance.filter(
          (record) =>
            record.status ===
            "half_day"
        ).length,

        checkedIn:
          attendance.filter(
            (record) =>
              Boolean(
                record.checkedInAt
              )
          ).length,

        checkedOut:
          attendance.filter(
            (record) =>
              Boolean(
                record.checkedOutAt
              )
          ).length,

        records: attendance
          .map(publicAttendance)
          .sort(sortByLatest),
      },

      recentCalls: calls
        .sort(sortByLatest)
        .slice(0, 20)
        .map(publicCall),

      recentTasks: tasks
        .sort(sortByLatest)
        .slice(0, 20)
        .map(publicTask),

      recentActivity: getWorkspaceActivity(
        state,
        context.workspaceId
      )
        .sort(sortByLatest)
        .slice(0, 30)
        .map(publicActivity),

      reportConfiguration:
        getReportConfiguration(
          state,
          context.workspaceId
        ),

      system: {
        dialers:
          getWorkspaceDialers(
            state,
            context.workspaceId
          ).map(publicDialer),

        senders:
          getWorkspaceSenders(
            state,
            context.workspaceId
          ).map(publicSender),

        chatChannels:
          getWorkspaceChannels(
            state,
            context.workspaceId
          ).map(publicChannel),
      },
    };
  }

  function getAdminDashboard(user) {
    const context = requireRole(user, [
      "owner",
      "admin",
    ]);

    const state = store.read();

    const members = getWorkspaceMembers(
      state,
      context.workspaceId
    );

    const calls = getWorkspaceCalls(
      state,
      context.workspaceId
    );

    const attendance = getAttendanceForDate({
      state,
      workspaceId: context.workspaceId,
      date: getWorkspaceDate(context),
    });

    return {
      role: "admin",

      navigation: getNavigation(user),

      workspace: publicWorkspace(
        context.workspace
      ),

      currentUser: publicMember(
        context.user
      ),

      summary: {
        activeMembers: members.filter(
          (member) =>
            member.active !== false
        ).length,

        suspendedMembers: members.filter(
          (member) =>
            member.active === false
        ).length,

        configuredDialers:
          getWorkspaceDialers(
            state,
            context.workspaceId
          ).length,

        configuredSenders:
          getWorkspaceSenders(
            state,
            context.workspaceId
          ).length,

        teamChannels:
          getWorkspaceChannels(
            state,
            context.workspaceId
          ).length,

        callsToday: countRecordsToday(
          calls,
          [
            "createdAt",
            "startedAt",
          ],
          context
        ),

        attendanceToday:
          attendance.length,

        unreadSecurityEvents:
          getSecurityEvents(
            state,
            context.workspaceId
          ).filter(
            (event) =>
              event.reviewed !== true
          ).length,
      },

      members: members.map(
        (member) => ({
          ...publicMember(member),

          attendance:
            attendance.find(
              (record) =>
                record.userId ===
                member.id
            )
              ? publicAttendance(
                  attendance.find(
                    (record) =>
                      record.userId ===
                      member.id
                  )
                )
              : null,

          performance:
            buildMemberPerformance({
              state,
              workspaceId:
                context.workspaceId,
              member,
              attendance,
              calls,
              assignments:
                getWorkspaceAssignments(
                  state,
                  context.workspaceId
                ),
              tasks:
                getWorkspaceTasks(
                  state,
                  context.workspaceId
                ),
            }),
        })
      ),

      securityEvents: getSecurityEvents(
        state,
        context.workspaceId
      )
        .sort(sortByLatest)
        .slice(0, 30)
        .map(publicActivity),

      systemActivity:
        getWorkspaceActivity(
          state,
          context.workspaceId
        )
          .sort(sortByLatest)
          .slice(0, 50)
          .map(publicActivity),
    };
  }

  function getManagerDashboard(user) {
    const context = requireRole(user, [
      "owner",
      "admin",
      "manager",
    ]);

    const state = store.read();

    const managedMembers =
      getManagedMembers({
        state,
        workspaceId:
          context.workspaceId,
        managerId:
          context.user.id,
        includeManager: true,
      });

    const memberIds = new Set(
      managedMembers.map(
        (member) => member.id
      )
    );

    const attendance = getAttendanceForDate({
      state,
      workspaceId: context.workspaceId,
      date: getWorkspaceDate(context),
    }).filter(
      (record) =>
        memberIds.has(record.userId)
    );

    const calls = getWorkspaceCalls(
      state,
      context.workspaceId
    ).filter(
      (call) =>
        memberIds.has(
          call.userId ||
            call.callerId ||
            call.createdBy
        )
    );

    const assignments =
      getWorkspaceAssignments(
        state,
        context.workspaceId
      ).filter(
        (assignment) =>
          memberIds.has(
            assignment.assignedUserId ||
              assignment.userId ||
              assignment.callerId
          )
      );

    const tasks = getWorkspaceTasks(
      state,
      context.workspaceId
    ).filter(
      (task) =>
        memberIds.has(
          task.assignedTo ||
            task.assignedUserId
        )
    );

    const performance =
      managedMembers.map(
        (member) =>
          buildMemberPerformance({
            state,
            workspaceId:
              context.workspaceId,
            member,
            attendance,
            calls,
            assignments,
            tasks,
          })
      );

    return {
      role: "manager",

      navigation: getNavigation(user),

      workspace: publicWorkspace(
        context.workspace
      ),

      currentUser: publicMember(
        context.user
      ),

      summary: {
        managedMembers:
          managedMembers.filter(
            (member) =>
              member.id !==
              context.user.id
          ).length,

        checkedIn:
          attendance.filter(
            (record) =>
              Boolean(
                record.checkedInAt
              )
          ).length,

        onlineNow:
          managedMembers.filter(
            (member) =>
              isMemberOnline({
                state,
                workspaceId:
                  context.workspaceId,
                userId: member.id,
              })
          ).length,

        assignedLeads:
          assignments.length,

        pendingTasks:
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

        callsToday:
          countRecordsToday(
            calls,
            [
              "createdAt",
              "startedAt",
            ],
            context
          ),

        answeredToday:
          countRecordsToday(
            calls.filter(
              isAnsweredCall
            ),
            [
              "createdAt",
              "startedAt",
            ],
            context
          ),

        followUpsDue:
          assignments.filter(
            isFollowUpDue
          ).length,
      },

      team: performance,

      attendance:
        attendance
          .map(publicAttendance)
          .sort(sortByLatest),

      assignments:
        assignments
          .sort(sortByLatest)
          .slice(0, 100)
          .map(publicAssignment),

      tasks: tasks
        .sort(sortByLatest)
        .slice(0, 100)
        .map(publicTask),

      recentCalls:
        calls
          .sort(sortByLatest)
          .slice(0, 40)
          .map(publicCall),

      overdueActions:
        buildOverdueActions({
          assignments,
          tasks,
        }),
    };
  }

  function getCallerDashboard(user) {
    const context = getContext(user);

    if (
      ![
        "owner",
        "admin",
        "manager",
        "caller",
        "viewer",
      ].includes(context.role)
    ) {
      throw createError(
        403,
        "Your role does not have dashboard access."
      );
    }

    const state = store.read();

    const attendance =
      getAttendanceForDate({
        state,
        workspaceId:
          context.workspaceId,
        date:
          getWorkspaceDate(context),
      }).find(
        (record) =>
          record.userId ===
          context.user.id
      ) || null;

    const assignments =
      getWorkspaceAssignments(
        state,
        context.workspaceId
      ).filter(
        (assignment) =>
          (
            assignment.assignedUserId ||
            assignment.userId ||
            assignment.callerId
          ) === context.user.id
      );

    const tasks = getWorkspaceTasks(
      state,
      context.workspaceId
    ).filter(
      (task) =>
        (
          task.assignedTo ||
          task.assignedUserId
        ) === context.user.id
      );

    const calls = getWorkspaceCalls(
      state,
      context.workspaceId
    ).filter(
      (call) =>
        (
          call.userId ||
          call.callerId ||
          call.createdBy
        ) === context.user.id
    );

    const todayCalls =
      filterRecordsToday(
        calls,
        [
          "createdAt",
          "startedAt",
        ],
        context
      );

    const todayAssignments =
      assignments.filter(
        (assignment) =>
          ![
            "completed",
            "converted",
            "do_not_contact",
          ].includes(
            normalizeStatus(
              assignment.status
            )
          )
      );

    return {
      role: "caller",

      navigation: getNavigation(user),

      workspace: publicWorkspace(
        context.workspace
      ),

      currentUser: publicMember(
        context.user
      ),

      attendance:
        attendance
          ? publicAttendance(
              attendance
            )
          : null,

      summary: {
        assignedLeads:
          todayAssignments.length,

        callsToday:
          todayCalls.length,

        answeredCalls:
          todayCalls.filter(
            isAnsweredCall
          ).length,

        callbacksDue:
          assignments.filter(
            isFollowUpDue
          ).length,

        pendingTasks:
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

        qualifiedLeads:
          assignments.filter(
            (assignment) =>
              [
                "qualified",
                "interested",
                "meeting_booked",
              ].includes(
                normalizeStatus(
                  assignment.status
                )
              )
          ).length,

        meetingsBooked:
          assignments.filter(
            (assignment) =>
              normalizeStatus(
                assignment.status
              ) ===
              "meeting_booked"
          ).length,

        totalCallSeconds:
          todayCalls.reduce(
            (sum, call) =>
              sum +
              getCallDuration(
                call
              ),
            0
          ),
      },

      assignedLeads:
        todayAssignments
          .sort(sortAssignments)
          .slice(0, 100)
          .map((assignment) =>
            enrichCallerAssignment({
              state,
              workspaceId:
                context.workspaceId,
              assignment,
            })
          ),

      tasks: tasks
        .sort(sortTasks)
        .slice(0, 100)
        .map(publicTask),

      recentCalls:
        calls
          .sort(sortByLatest)
          .slice(0, 30)
          .map(publicCall),

      upcomingCallbacks:
        assignments
          .filter(isFollowUpDue)
          .sort(
            (a, b) =>
              String(
                getFollowUpDate(a)
              ).localeCompare(
                String(
                  getFollowUpDate(b)
                )
              )
          )
          .slice(0, 30)
          .map(publicAssignment),

      communication: {
        unreadMessages:
          getUnreadMessageCount({
            state,
            workspaceId:
              context.workspaceId,
            userId:
              context.user.id,
          }),

        missedInternalCalls:
          getMissedInternalCallCount({
            state,
            workspaceId:
              context.workspaceId,
            userId:
              context.user.id,
          }),
      },

      assignedTools: {
        dialer:
          getAssignedDialer({
            state,
            workspaceId:
              context.workspaceId,
            user:
              context.user,
          }),

        sender:
          getAssignedSender({
            state,
            workspaceId:
              context.workspaceId,
            user:
              context.user,
          }),
      },
    };
  }

  function getNavigation(user) {
    const context = getContext(user);

    const common = [
      navigationItem(
        "dashboard",
        "Dashboard",
        "/app/dashboard",
        "dashboard"
      ),

      navigationItem(
        "team-chat",
        "Team communication",
        "/app/team-chat",
        "message-circle"
      ),

      navigationItem(
        "profile",
        "My profile",
        "/app/profile",
        "user"
      ),
    ];

    if (context.role === "owner") {
      return [
        ...common,

        navigationItem(
          "campaigns",
          "Campaigns",
          "/app/campaigns",
          "megaphone"
        ),

        navigationItem(
          "leads",
          "All leads",
          "/app/leads",
          "users"
        ),

        navigationItem(
          "team",
          "Team management",
          "/app/team",
          "user-cog"
        ),

        navigationItem(
          "assignments",
          "Lead assignments",
          "/app/assignments",
          "clipboard-list"
        ),

        navigationItem(
          "attendance",
          "Attendance",
          "/app/attendance",
          "clock"
        ),

        navigationItem(
          "calls",
          "Calls and performance",
          "/app/calls",
          "phone"
        ),

        navigationItem(
          "audits",
          "Audit reports",
          "/app/audits",
          "file-search"
        ),

        navigationItem(
          "report-formats",
          "Report formats",
          "/app/report-formats",
          "file-cog"
        ),

        navigationItem(
          "senders",
          "Sender identities",
          "/app/senders",
          "mail"
        ),

        navigationItem(
          "dialers",
          "Dialers",
          "/app/dialers",
          "phone-call"
        ),

        navigationItem(
          "security",
          "Security and activity",
          "/app/security",
          "shield"
        ),

        navigationItem(
          "workspace-settings",
          "Workspace settings",
          "/app/workspace-settings",
          "settings"
        ),
      ];
    }

    if (context.role === "admin") {
      return [
        ...common,

        navigationItem(
          "team",
          "Team accounts",
          "/app/team",
          "user-cog"
        ),

        navigationItem(
          "attendance",
          "Attendance",
          "/app/attendance",
          "clock"
        ),

        navigationItem(
          "calls",
          "Calls and performance",
          "/app/calls",
          "phone"
        ),

        navigationItem(
          "audits",
          "Audit monitoring",
          "/app/audits",
          "file-search"
        ),

        navigationItem(
          "report-formats",
          "Report formats",
          "/app/report-formats",
          "file-cog"
        ),

        navigationItem(
          "senders",
          "Sender identities",
          "/app/senders",
          "mail"
        ),

        navigationItem(
          "dialers",
          "Dialers",
          "/app/dialers",
          "phone-call"
        ),

        navigationItem(
          "security",
          "Security and activity",
          "/app/security",
          "shield"
        ),
      ];
    }

    if (context.role === "manager") {
      return [
        ...common,

        navigationItem(
          "team",
          "My team",
          "/app/team",
          "users"
        ),

        navigationItem(
          "assignments",
          "Lead assignments",
          "/app/assignments",
          "clipboard-list"
        ),

        navigationItem(
          "tasks",
          "Team tasks",
          "/app/tasks",
          "check-square"
        ),

        navigationItem(
          "attendance",
          "Team attendance",
          "/app/attendance",
          "clock"
        ),

        navigationItem(
          "calls",
          "Team calls",
          "/app/calls",
          "phone"
        ),

        navigationItem(
          "audits",
          "Audit reports",
          "/app/audits",
          "file-search"
        ),

        navigationItem(
          "senders",
          "Sender identities",
          "/app/senders",
          "mail"
        ),

        navigationItem(
          "dialers",
          "Dialers",
          "/app/dialers",
          "phone-call"
        ),
      ];
    }

    return [
      ...common,

      navigationItem(
        "my-leads",
        "My assigned leads",
        "/app/my-leads",
        "contact"
      ),

      navigationItem(
        "tasks",
        "My tasks",
        "/app/tasks",
        "check-square"
      ),

      navigationItem(
        "attendance",
        "Check-in and attendance",
        "/app/attendance",
        "clock"
      ),

      navigationItem(
        "calls",
        "My calls",
        "/app/calls",
        "phone"
      ),
    ];
  }

  function getContext(user) {
    if (!user?.id) {
      throw createError(
        401,
        "Authentication is required."
      );
    }

    const state = store.read();

    const context =
      workspaceService?.getContext?.(
        user,
        state
      ) || {
        user,
        workspaceId:
          user.workspaceId ||
          user.id,
        workspace: (
          state.workspaces || []
        ).find(
          (workspace) =>
            workspace.id ===
            (
              user.workspaceId ||
              user.id
            )
        ),
        role: normalizeRole(
          user.workspaceRole ||
            user.role
        ),
        permissions:
          user.permissions || [],
      };

    const role = normalizeRole(
      context.role ||
        user.workspaceRole ||
        user.role
    );

    if (!DASHBOARD_ROLES.has(role)) {
      throw createError(
        403,
        "The account role is not supported."
      );
    }

    if (!context.workspaceId) {
      throw createError(
        403,
        "The account is not connected to a workspace."
      );
    }

    return {
      ...context,
      role,
      user:
        context.user || user,
    };
  }

  function requireRole(
    user,
    allowedRoles
  ) {
    const context = getContext(user);

    if (
      !allowedRoles.includes(
        context.role
      )
    ) {
      throw createError(
        403,
        "You do not have permission to access this dashboard."
      );
    }

    return context;
  }
}

function buildMemberPerformance({
  state,
  workspaceId,
  member,
  attendance,
  calls,
  assignments,
  tasks,
}) {
  const memberCalls = calls.filter(
    (call) =>
      (
        call.userId ||
        call.callerId ||
        call.createdBy
      ) === member.id
  );

  const memberAssignments =
    assignments.filter(
      (assignment) =>
        (
          assignment.assignedUserId ||
          assignment.userId ||
          assignment.callerId
        ) === member.id
    );

  const memberTasks = tasks.filter(
    (task) =>
      (
        task.assignedTo ||
        task.assignedUserId
      ) === member.id
  );

  const memberAttendance =
    attendance.find(
      (record) =>
        record.userId === member.id
    ) || null;

  const answeredCalls =
    memberCalls.filter(
      isAnsweredCall
    );

  const qualifiedLeads =
    memberAssignments.filter(
      (assignment) =>
        [
          "qualified",
          "interested",
          "meeting_booked",
        ].includes(
          normalizeStatus(
            assignment.status
          )
        )
    );

  return {
    member: publicMember(member),

    attendance:
      memberAttendance
        ? publicAttendance(
            memberAttendance
          )
        : null,

    online: isMemberOnline({
      state,
      workspaceId,
      userId: member.id,
    }),

    metrics: {
      assignedLeads:
        memberAssignments.length,

      contactedLeads:
        memberAssignments.filter(
          (assignment) =>
            Boolean(
              assignment.lastContactedAt ||
                assignment.contactedAt
            )
        ).length,

      totalCalls:
        memberCalls.length,

      answeredCalls:
        answeredCalls.length,

      answerRate:
        memberCalls.length
          ? round(
              answeredCalls.length /
                memberCalls.length *
                100
            )
          : 0,

      averageCallDurationSeconds:
        answeredCalls.length
          ? round(
              answeredCalls.reduce(
                (sum, call) =>
                  sum +
                  getCallDuration(
                    call
                  ),
                0
              ) /
                answeredCalls.length
            )
          : 0,

      qualifiedLeads:
        qualifiedLeads.length,

      meetingsBooked:
        memberAssignments.filter(
          (assignment) =>
            normalizeStatus(
              assignment.status
            ) ===
            "meeting_booked"
        ).length,

      pendingTasks:
        memberTasks.filter(
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

      completedTasks:
        memberTasks.filter(
          (task) =>
            normalizeStatus(
              task.status
            ) === "completed"
        ).length,

      followUpsDue:
        memberAssignments.filter(
          isFollowUpDue
        ).length,
    },
  };
}

function enrichCallerAssignment({
  state,
  workspaceId,
  assignment,
}) {
  const lead = findLeadForAssignment({
    state,
    workspaceId,
    assignment,
  });

  const audit =
    findMiniAuditForLead({
      state,
      workspaceId,
      lead,
      assignment,
    });

  return {
    ...publicAssignment(
      assignment
    ),

    lead: lead
      ? publicLead(lead)
      : assignment.lead
        ? publicLead(
            assignment.lead
          )
        : null,

    miniAudit:
      audit
        ? publicAudit(audit)
        : null,
  };
}

function getWorkspaceMembers(
  state,
  workspaceId
) {
  return (state.users || []).filter(
    (member) =>
      member.workspaceId ===
        workspaceId
  );
}

function getManagedMembers({
  state,
  workspaceId,
  managerId,
  includeManager = false,
}) {
  return (state.users || []).filter(
    (member) =>
      member.workspaceId ===
        workspaceId &&
      member.active !== false &&
      (
        member.managerId ===
          managerId ||
        (
          includeManager &&
          member.id === managerId
        )
      )
  );
}

function getWorkspaceAssignments(
  state,
  workspaceId
) {
  return [
    ...(state.leadAssignments ||
      []),

    ...(state.assignments || []),
  ].filter(
    (assignment) =>
      assignment.workspaceId ===
        workspaceId
  );
}

function getWorkspaceTasks(
  state,
  workspaceId
) {
  return [
    ...(state.teamTasks || []),

    ...(state.tasks || []),
  ].filter(
    (task) =>
      task.workspaceId ===
        workspaceId
  );
}

function getWorkspaceCalls(
  state,
  workspaceId
) {
  return [
    ...(state.salesCalls || []),

    ...(state.calls || []),
  ].filter(
    (call) =>
      call.workspaceId ===
        workspaceId
  );
}

function getWorkspaceLeads(
  state,
  workspaceId
) {
  return (state.leads || []).filter(
    (lead) =>
      lead.workspaceId ===
        workspaceId
  );
}

function getWorkspaceAudits(
  state,
  workspaceId
) {
  return [
    ...(state.leadAudits || []),

    ...(state.auditReports || []),

    ...(state.audits || []),
  ].filter(
    (audit) =>
      audit.workspaceId ===
        workspaceId
  );
}

function getWorkspaceCampaigns(
  state,
  workspaceId
) {
  return (state.campaigns || []).filter(
    (campaign) =>
      campaign.workspaceId ===
        workspaceId
  );
}

function getWorkspaceDialers(
  state,
  workspaceId
) {
  return (state.dialers || []).filter(
    (dialer) =>
      dialer.workspaceId ===
        workspaceId
  );
}

function getWorkspaceSenders(
  state,
  workspaceId
) {
  return (state.senders || []).filter(
    (sender) =>
      sender.workspaceId ===
        workspaceId
  );
}

function getWorkspaceChannels(
  state,
  workspaceId
) {
  return (state.teamChannels || []).filter(
    (channel) =>
      channel.workspaceId ===
        workspaceId &&
      channel.active !== false
  );
}

function getWorkspaceActivity(
  state,
  workspaceId
) {
  return (state.activity || []).filter(
    (activity) =>
      activity.workspaceId ===
        workspaceId
  );
}

function getSecurityEvents(
  state,
  workspaceId
) {
  return getWorkspaceActivity(
    state,
    workspaceId
  ).filter(
    (activity) =>
      [
        "authentication_failed",
        "permission_denied",
        "account_suspended",
        "password_changed",
        "dialer_updated",
        "sender_updated",
        "role_changed",
        "attendance_status_changed",
      ].includes(
        activity.action ||
          activity.type
      )
  );
}

function getAttendanceForDate({
  state,
  workspaceId,
  date,
}) {
  return (
    state.attendanceRecords ||
    []
  ).filter(
    (record) =>
      record.workspaceId ===
        workspaceId &&
      record.workDate === date &&
      !record.deletedAt
  );
}

function getReportConfiguration(
  state,
  workspaceId
) {
  const template = (
    state.auditReportTemplates ||
    []
  ).find(
    (item) =>
      item.workspaceId ===
        workspaceId
  );

  if (!template) {
    return null;
  }

  return {
    id: template.id,
    name: template.name || "",
    miniEnabled:
      template.miniEnabled !== false,
    competitorEnabled:
      template.competitorEnabled !==
      false,
    fullEnabled:
      template.fullEnabled !== false,
    updatedAt:
      template.updatedAt || "",
  };
}

function findLeadForAssignment({
  state,
  workspaceId,
  assignment,
}) {
  const leadId =
    assignment.leadId ||
    assignment.contactId;

  if (!leadId) {
    return null;
  }

  return (state.leads || []).find(
    (lead) =>
      lead.id === leadId &&
      lead.workspaceId ===
        workspaceId
  );
}

function findMiniAuditForLead({
  state,
  workspaceId,
  lead,
  assignment,
}) {
  const leadId =
    lead?.id ||
    assignment.leadId ||
    assignment.contactId;

  const website =
    lead?.website ||
    assignment.lead?.website ||
    "";

  return getWorkspaceAudits(
    state,
    workspaceId
  )
    .filter(
      (audit) =>
        normalizeStatus(
          audit.type ||
            audit.reportType
        ) === "mini"
    )
    .find(
      (audit) =>
        (
          leadId &&
          (
            audit.leadId ===
              leadId ||
            audit.contactId ===
              leadId
          )
        ) ||
        (
          website &&
          normalizeWebsite(
            audit.website ||
              audit.url
          ) ===
            normalizeWebsite(
              website
            )
        )
    );
}

function getUnreadMessageCount({
  state,
  workspaceId,
  userId,
}) {
  const readIds = new Set(
    (state.teamMessageReads || [])
      .filter(
        (receipt) =>
          receipt.workspaceId ===
            workspaceId &&
          receipt.userId ===
            userId
      )
      .map(
        (receipt) =>
          receipt.messageId
      )
  );

  return (state.teamMessages || []).filter(
    (message) =>
      message.workspaceId ===
        workspaceId &&
      message.senderId !== userId &&
      !message.deletedAt &&
      !readIds.has(message.id) &&
      (
        message.recipientUserId ===
          userId ||
        (
          message.channelId &&
          (
            state.teamChannels ||
            []
          ).some(
            (channel) =>
              channel.id ===
                message.channelId &&
              (
                channel.type ===
                  "public" ||
                (
                  channel.memberUserIds ||
                  []
                ).includes(userId)
              )
          )
        )
      )
  ).length;
}

function getMissedInternalCallCount({
  state,
  workspaceId,
  userId,
}) {
  return (state.teamCalls || []).filter(
    (call) =>
      call.workspaceId ===
        workspaceId &&
      (
        call.participants ||
        []
      ).some(
        (participant) =>
          participant.userId ===
            userId &&
          participant.status ===
            "missed"
      )
  ).length;
}

function getAssignedDialer({
  state,
  workspaceId,
  user,
}) {
  const dialerId =
    user.dialerId ||
    user.assignedDialerId;

  const dialer =
    (state.dialers || []).find(
      (item) =>
        item.workspaceId ===
          workspaceId &&
        (
          item.id === dialerId ||
          (
            item.assignedUserIds ||
            []
          ).includes(user.id)
        )
    );

  return dialer
    ? publicDialer(dialer)
    : null;
}

function getAssignedSender({
  state,
  workspaceId,
  user,
}) {
  const senderId =
    user.senderId ||
    user.assignedSenderId;

  const sender =
    (state.senders || []).find(
      (item) =>
        item.workspaceId ===
          workspaceId &&
        (
          item.id === senderId ||
          (
            item.assignedUserIds ||
            []
          ).includes(user.id)
        )
    );

  return sender
    ? publicSender(sender)
    : null;
}

function countOnlineMembers({
  state,
  workspaceId,
}) {
  return (state.teamPresence || []).filter(
    (presence) =>
      presence.workspaceId ===
        workspaceId &&
      presence.status ===
        "online"
  ).length;
}

function isMemberOnline({
  state,
  workspaceId,
  userId,
}) {
  return (state.teamPresence || []).some(
    (presence) =>
      presence.workspaceId ===
        workspaceId &&
      presence.userId === userId &&
      presence.status ===
        "online"
  );
}

function isAnsweredCall(call) {
  return [
    "answered",
    "completed",
    "connected",
    "successful",
  ].includes(
    normalizeStatus(
      call.status ||
        call.outcome
    )
  );
}

function getCallDuration(call) {
  const directDuration = Number(
    call.durationSeconds ||
      call.duration ||
      0
  );

  if (
    Number.isFinite(
      directDuration
    ) &&
    directDuration > 0
  ) {
    return directDuration;
  }

  const startedAt = Date.parse(
    call.startedAt ||
      call.createdAt
  );

  const endedAt = Date.parse(
    call.endedAt ||
      call.completedAt
  );

  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt)
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.round(
      (endedAt - startedAt) /
        1000
    )
  );
}

function isFollowUpDue(record) {
  const date = getFollowUpDate(
    record
  );

  if (!date) {
    return false;
  }

  const timestamp = Date.parse(date);

  return (
    Number.isFinite(timestamp) &&
    timestamp <= Date.now() &&
    ![
      "completed",
      "converted",
      "cancelled",
      "do_not_contact",
    ].includes(
      normalizeStatus(
        record.status
      )
    )
  );
}

function getFollowUpDate(record) {
  return (
    record.nextActionAt ||
    record.followUpAt ||
    record.callbackAt ||
    record.dueAt ||
    ""
  );
}

function buildOverdueActions({
  assignments,
  tasks,
}) {
  const assignmentActions =
    assignments
      .filter(isFollowUpDue)
      .map(
        (assignment) => ({
          id: assignment.id,
          type: "lead_follow_up",
          title:
            assignment.lead?.business ||
            assignment.lead?.name ||
            "Lead follow-up",
          dueAt:
            getFollowUpDate(
              assignment
            ),
          assignment:
            publicAssignment(
              assignment
            ),
        })
      );

  const taskActions = tasks
    .filter(
      (task) =>
        isFollowUpDue(task)
    )
    .map((task) => ({
      id: task.id,
      type: "task",
      title:
        task.title ||
        task.name ||
        "Task",
      dueAt:
        getFollowUpDate(task),
      task: publicTask(task),
    }));

  return [
    ...assignmentActions,
    ...taskActions,
  ]
    .sort(
      (a, b) =>
        String(a.dueAt).localeCompare(
          String(b.dueAt)
        )
    )
    .slice(0, 100);
}

function countRecordsToday(
  records,
  dateFields,
  context
) {
  return filterRecordsToday(
    records,
    dateFields,
    context
  ).length;
}

function filterRecordsToday(
  records,
  dateFields,
  context
) {
  const today =
    getWorkspaceDate(context);

  return records.filter((record) => {
    const value = dateFields
      .map(
        (field) =>
          record[field]
      )
      .find(Boolean);

    if (!value) {
      return false;
    }

    return formatDateInTimezone(
      Date.parse(value),
      context.workspace?.timezone ||
        context.user.timezone ||
        "UTC"
    ) === today;
  });
}

function getWorkspaceDate(context) {
  return formatDateInTimezone(
    Date.now(),
    context.workspace?.timezone ||
      context.user.timezone ||
      "UTC"
  );
}

function formatDateInTimezone(
  timestamp,
  timezone
) {
  try {
    const formatter =
      new Intl.DateTimeFormat(
        "en-CA",
        {
          timeZone:
            timezone || "UTC",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }
      );

    const parts =
      formatter.formatToParts(
        new Date(timestamp)
      );

    const values =
      Object.fromEntries(
        parts.map((part) => [
          part.type,
          part.value,
        ])
      );

    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date(timestamp)
      .toISOString()
      .slice(0, 10);
  }
}

function navigationItem(
  id,
  label,
  path,
  icon
) {
  return {
    id,
    label,
    path,
    icon,
  };
}

function publicWorkspace(workspace) {
  if (!workspace) {
    return null;
  }

  return {
    id: workspace.id,
    name:
      workspace.name ||
      workspace.companyName ||
      "",
    companyName:
      workspace.companyName ||
      workspace.name ||
      "",
    timezone:
      workspace.timezone ||
      "UTC",
    accountType:
      workspace.accountType ||
      "company",
  };
}

function publicMember(member) {
  return {
    id: member.id,
    name: member.name || "",
    email: member.email || "",
    phone: member.phone || "",
    role: normalizeRole(
      member.workspaceRole ||
        member.role
    ),
    jobTitle:
      member.jobTitle || "",
    avatarUrl:
      member.avatarPrivatePath
        ? `/api/profile/avatar/${member.id}`
        : member.avatarUrl ||
          member.profileImageUrl ||
          "",
    managerId:
      member.managerId || "",
    active:
      member.active !== false,
    availabilityStatus:
      member.availabilityStatus ||
      "available",
  };
}

function publicAttendance(record) {
  return {
    id: record.id,
    userId: record.userId,
    userName:
      record.userName || "",
    workDate:
      record.workDate,
    checkedInAt:
      record.checkedInAt || "",
    checkedOutAt:
      record.checkedOutAt || "",
    status:
      record.status || "",
    totalWorkedSeconds:
      Number(
        record.totalWorkedSeconds ||
          0
      ),
    hasCheckInPhoto:
      Boolean(
        record.checkInPhotoPath
      ),
    hasCheckOutPhoto:
      Boolean(
        record.checkOutPhotoPath
      ),
  };
}

function publicCall(call) {
  return {
    id: call.id,
    userId:
      call.userId ||
      call.callerId ||
      call.createdBy ||
      "",
    leadId:
      call.leadId || "",
    destinationNumber:
      call.destinationNumber ||
      call.phone ||
      "",
    status:
      call.status || "",
    outcome:
      call.outcome || "",
    durationSeconds:
      getCallDuration(call),
    startedAt:
      call.startedAt ||
      call.createdAt ||
      "",
    endedAt:
      call.endedAt ||
      call.completedAt ||
      "",
    notes:
      call.notes || "",
  };
}

function publicTask(task) {
  return {
    id: task.id,
    title:
      task.title ||
      task.name ||
      "",
    description:
      task.description || "",
    status:
      task.status || "pending",
    priority:
      task.priority || "normal",
    assignedTo:
      task.assignedTo ||
      task.assignedUserId ||
      "",
    createdBy:
      task.createdBy || "",
    dueAt:
      task.dueAt ||
      task.nextActionAt ||
      "",
    completedAt:
      task.completedAt || "",
    createdAt:
      task.createdAt || "",
    updatedAt:
      task.updatedAt || "",
  };
}

function publicAssignment(
  assignment
) {
  return {
    id: assignment.id,
    leadId:
      assignment.leadId ||
      assignment.contactId ||
      "",
    assignedUserId:
      assignment.assignedUserId ||
      assignment.userId ||
      assignment.callerId ||
      "",
    status:
      assignment.status ||
      "assigned",
    priority:
      assignment.priority ||
      "normal",
    nextActionAt:
      getFollowUpDate(
        assignment
      ),
    notes:
      assignment.notes || "",
    assignedAt:
      assignment.assignedAt ||
      assignment.createdAt ||
      "",
    lastContactedAt:
      assignment.lastContactedAt ||
      assignment.contactedAt ||
      "",
  };
}

function publicLead(lead) {
  return {
    id: lead.id,
    name:
      lead.name ||
      lead.business ||
      "",
    business:
      lead.business ||
      lead.name ||
      "",
    phone:
      lead.phone || "",
    email:
      lead.email || "",
    website:
      lead.website || "",
    address:
      lead.address || "",
    category:
      lead.category || "",
    qualityScore:
      Number(
        lead.qualityScore ||
          lead.confidence ||
          0
      ),
  };
}

function publicAudit(audit) {
  return {
    id: audit.id,
    leadId:
      audit.leadId || "",
    type:
      audit.type ||
      audit.reportType ||
      "mini",
    status:
      audit.status || "",
    title:
      audit.title || "",
    report:
      audit.report ||
      audit.content ||
      null,
    pdfUrl:
      audit.pdfUrl || "",
    createdAt:
      audit.createdAt || "",
    updatedAt:
      audit.updatedAt || "",
  };
}

function publicDialer(dialer) {
  return {
    id: dialer.id,
    name: dialer.name || "",
    fromNumber:
      dialer.fromNumber || "",
    active:
      dialer.active !== false,
    assignedUserIds:
      dialer.assignedUserIds ||
      [],
  };
}

function publicSender(sender) {
  return {
    id: sender.id,
    name: sender.name || "",
    fromName:
      sender.fromName || "",
    fromEmail:
      sender.fromEmail || "",
    active:
      sender.active !== false,
    assignedUserIds:
      sender.assignedUserIds ||
      [],
  };
}

function publicChannel(channel) {
  return {
    id: channel.id,
    name: channel.name || "",
    type:
      channel.type ||
      "private",
    memberCount:
      (
        channel.memberUserIds ||
        []
      ).length,
    active:
      channel.active !== false,
  };
}

function publicActivity(activity) {
  return {
    id: activity.id,
    type:
      activity.type ||
      activity.action ||
      "",
    action:
      activity.action ||
      activity.type ||
      "",
    userId:
      activity.userId || "",
    entityType:
      activity.entityType || "",
    entityId:
      activity.entityId || "",
    metadata:
      activity.metadata ||
      activity.details ||
      {},
    createdAt:
      activity.createdAt || "",
  };
}

function sortByLatest(a, b) {
  return String(
    b.updatedAt ||
      b.createdAt ||
      b.startedAt ||
      b.checkedInAt ||
      ""
  ).localeCompare(
    String(
      a.updatedAt ||
        a.createdAt ||
        a.startedAt ||
        a.checkedInAt ||
        ""
    )
  );
}

function sortAssignments(a, b) {
  const priorityOrder = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
  };

  const aPriority =
    priorityOrder[
      normalizeStatus(
        a.priority
      )
    ] ?? 2;

  const bPriority =
    priorityOrder[
      normalizeStatus(
        b.priority
      )
    ] ?? 2;

  if (aPriority !== bPriority) {
    return aPriority - bPriority;
  }

  return String(
    getFollowUpDate(a) ||
      a.assignedAt ||
      a.createdAt ||
      ""
  ).localeCompare(
    String(
      getFollowUpDate(b) ||
        b.assignedAt ||
        b.createdAt ||
        ""
    )
  );
}

function sortTasks(a, b) {
  const aCompleted =
    normalizeStatus(a.status) ===
    "completed";

  const bCompleted =
    normalizeStatus(b.status) ===
    "completed";

  if (aCompleted !== bCompleted) {
    return Number(aCompleted) -
      Number(bCompleted);
  }

  return String(
    a.dueAt ||
      a.nextActionAt ||
      a.createdAt ||
      ""
  ).localeCompare(
    String(
      b.dueAt ||
        b.nextActionAt ||
        b.createdAt ||
        ""
    )
  );
}

function normalizeRole(value) {
  const role = String(value || "")
    .trim()
    .toLowerCase();

  if (
    DASHBOARD_ROLES.has(role)
  ) {
    return role;
  }

  if (role.includes("owner")) {
    return "owner";
  }

  if (role.includes("admin")) {
    return "admin";
  }

  if (role.includes("manager")) {
    return "manager";
  }

  if (role.includes("caller")) {
    return "caller";
  }

  return "viewer";
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function normalizeWebsite(value) {
  try {
    const url = new URL(
      /^https?:\/\//i.test(
        String(value || "")
      )
        ? String(value)
        : `https://${String(
            value || ""
          )}`
    );

    return url.hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return String(value || "")
      .trim()
      .toLowerCase();
  }
}

function round(value) {
  return Math.round(
    Number(value || 0) *
      100
  ) / 100;
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
  return function dashboardAsyncRoute(
    req,
    res,
    next
  ) {
    Promise.resolve(
      handler(req, res, next)
    ).catch(next);
  };
}