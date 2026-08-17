import { createAttendanceService } from "./attendance-service.js";
import { createProfileService } from "./profile-service.js";
import { createRoleDashboardService } from "./role-dashboard-service.js";
import { createSocketService } from "./socket-service.js";
import { createTeamChatService } from "./team-chat-service.js";

/**
 * Registers the ReachFly role dashboards, internal communication,
 * WebRTC signalling, attendance, and profile-management modules.
 *
 * Required:
 * - app: Express application
 * - httpServer: Node HTTP server created with createServer(app)
 * - store: ReachFly data store
 * - authenticate: existing Express authentication middleware
 * - authSecret: same AUTH_SECRET used by the login token system
 *
 * Optional:
 * - workspaceService
 * - asyncRoute
 * - dataDir
 * - allowedOrigins
 */
export function registerWorkspacePlatform({
  app,
  httpServer,
  store,
  authenticate,
  authSecret,
  workspaceService = null,
  asyncRoute = defaultAsyncRoute,
  dataDir = process.env.DATA_DIR || "./data",
  allowedOrigins = parseAllowedOrigins(
    process.env.ALLOWED_ORIGINS ||
      process.env.APP_URL ||
      "http://localhost:5173"
  ),
  debug =
    process.env.WORKSPACE_PLATFORM_DEBUG ===
      "true" ||
    process.env.WORKSPACE_PLATFORM_DEBUG === "1",
}) {
  validateDependencies({
    app,
    httpServer,
    store,
    authenticate,
    authSecret,
  });

  /*
   * Socket.IO must be created first because the remaining services use it
   * to broadcast messages, profile changes, attendance updates, and calls.
   */
  const socketService = createSocketService({
    httpServer,
    store,
    authSecret,
    allowedOrigins,
    workspaceService,
    debug,
  });

  const teamChatService = createTeamChatService({
    store,
    workspaceService,
    socketService,
  });

  const attendanceService =
    createAttendanceService({
      store,
      workspaceService,
      socketService,
      dataDir,
    });

  const profileService = createProfileService({
    store,
    workspaceService,
    socketService,
    dataDir,
  });

  const roleDashboardService =
    createRoleDashboardService({
      store,
      workspaceService,
    });

  /*
   * Register all secured REST endpoints.
   */
  teamChatService.registerRoutes({
    app,
    authenticate,
    asyncRoute,
  });

  attendanceService.registerRoutes({
    app,
    authenticate,
    asyncRoute,
  });

  profileService.registerRoutes({
    app,
    authenticate,
    asyncRoute,
  });

  roleDashboardService.registerRoutes({
    app,
    authenticate,
    asyncRoute,
  });

  /*
   * Lightweight diagnostics. This route does not expose credentials,
   * SMTP configuration, Vonage secrets, private file paths, or socket
   * authentication details.
   */
  app.get(
    "/api/workspace-platform/status",
    authenticate,
    asyncRoute(async (req, res) => {
      const context = resolveContext({
        user: req.user,
        store,
        workspaceService,
      });

      const onlineUsers =
        socketService.getOnlineUsers(
          context.workspaceId
        );

      res.json({
        ok: true,

        platform: {
          dashboards: true,
          teamChat: true,
          internalWebRtcCalls: true,
          attendance: true,
          profiles: true,
        },

        socket: {
          connectedUsers: onlineUsers.length,

          users: onlineUsers.map((user) => ({
            id: user.id,
            name: user.name,
            role: user.role,
            avatarUrl: user.avatarUrl,
            availabilityStatus:
              user.availabilityStatus,
            status: user.status,
          })),
        },

        currentUser: {
          id: context.user.id,
          role: context.role,
          workspaceId: context.workspaceId,
        },

        serverTime: new Date().toISOString(),
      });
    })
  );

  if (debug) {
    console.log(
      "[workspace-platform] registered",
      {
        at: new Date().toISOString(),
        allowedOrigins,
        dataDir,
        services: [
          "role-dashboard",
          "team-chat",
          "socket",
          "webrtc-signalling",
          "attendance",
          "profile",
        ],
      }
    );
  }

  return {
    socketService,
    teamChatService,
    attendanceService,
    profileService,
    roleDashboardService,

    close: async () => {
      await socketService.close();
    },
  };
}

function validateDependencies({
  app,
  httpServer,
  store,
  authenticate,
  authSecret,
}) {
  if (
    !app ||
    typeof app.get !== "function" ||
    typeof app.post !== "function"
  ) {
    throw new Error(
      "registerWorkspacePlatform requires an Express application."
    );
  }

  if (
    !httpServer ||
    typeof httpServer.listen !== "function"
  ) {
    throw new Error(
      "registerWorkspacePlatform requires the Node HTTP server used to start Express."
    );
  }

  if (
    !store ||
    typeof store.read !== "function" ||
    typeof store.update !== "function"
  ) {
    throw new Error(
      "registerWorkspacePlatform requires a ReachFly store exposing read() and update()."
    );
  }

  if (typeof authenticate !== "function") {
    throw new Error(
      "registerWorkspacePlatform requires the existing authentication middleware."
    );
  }

  if (!String(authSecret || "").trim()) {
    throw new Error(
      "AUTH_SECRET is required to authenticate internal Socket.IO connections."
    );
  }
}

function resolveContext({
  user,
  store,
  workspaceService,
}) {
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
        user.workspaceId || user.id,

      workspace: (
        state.workspaces || []
      ).find(
        (workspace) =>
          workspace.id ===
          (user.workspaceId || user.id)
      ),

      role: normalizeRole(
        user.workspaceRole || user.role
      ),

      permissions:
        user.permissions || [],
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

function parseAllowedOrigins(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(",");

  return [
    ...new Set(
      values
        .map((origin) =>
          String(origin || "")
            .trim()
            .replace(/\/$/, "")
        )
        .filter(Boolean)
    ),
  ];
}

function normalizeRole(value) {
  const role = String(value || "")
    .trim()
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

function createError(
  statusCode,
  message
) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function defaultAsyncRoute(handler) {
  return function workspacePlatformAsyncRoute(
    req,
    res,
    next
  ) {
    Promise.resolve(
      handler(req, res, next)
    ).catch(next);
  };
}