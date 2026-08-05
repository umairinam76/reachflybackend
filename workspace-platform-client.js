import { io } from "socket.io-client";

const RAW_API_URL = String(
  import.meta.env.VITE_API_URL ||
    "http://localhost:8787/api"
)
  .trim()
  .replace(/\/+$/, "");

export const API_BASE_URL = /\/api$/i.test(
  RAW_API_URL
)
  ? RAW_API_URL
  : `${RAW_API_URL}/api`;

export const SERVER_BASE_URL =
  API_BASE_URL.replace(/\/api$/i, "");

const SOCKET_PATH =
  import.meta.env.VITE_SOCKET_PATH ||
  "/socket.io";

let socket = null;
let socketToken = "";
let socketListenersRegistered = false;

const globalSocketListeners = new Map();

/* ------------------------------------------------------------------ */
/* Authentication                                                     */
/* ------------------------------------------------------------------ */

export function getAccessToken() {
  return (
    localStorage.getItem("token") ||
    localStorage.getItem(
      "accessToken"
    ) ||
    sessionStorage.getItem(
      "token"
    ) ||
    sessionStorage.getItem(
      "accessToken"
    ) ||
    ""
  );
}

export function setAccessToken(
  token,
  {
    persistent = true,
  } = {}
) {
  const value = String(
    token || ""
  ).trim();

  clearAccessToken();

  if (!value) {
    disconnectWorkspaceSocket();
    return;
  }

  const storage = persistent
    ? localStorage
    : sessionStorage;

  storage.setItem(
    "token",
    value
  );

  reconnectWorkspaceSocket();
}

export function clearAccessToken() {
  localStorage.removeItem(
    "token"
  );

  localStorage.removeItem(
    "accessToken"
  );

  sessionStorage.removeItem(
    "token"
  );

  sessionStorage.removeItem(
    "accessToken"
  );
}

/* ------------------------------------------------------------------ */
/* REST client                                                        */
/* ------------------------------------------------------------------ */

export async function apiRequest(
  path,
  {
    method = "GET",
    body,
    headers = {},
    signal,
    responseType = "json",
    authenticate = true,
  } = {}
) {
  const token = getAccessToken();

  const response = await fetch(
    createApiUrl(path),
    {
      method,

      headers: {
        Accept:
          responseType === "blob"
            ? "*/*"
            : "application/json",

        ...(body !== undefined
          ? {
              "Content-Type":
                "application/json",
            }
          : {}),

        ...(authenticate &&
        token
          ? {
              Authorization:
                `Bearer ${token}`,
            }
          : {}),

        ...headers,
      },

      ...(body !== undefined
        ? {
            body: JSON.stringify(
              body
            ),
          }
        : {}),

      signal,
    }
  );

  if (responseType === "blob") {
    if (!response.ok) {
      throw await createResponseError(
        response
      );
    }

    return response.blob();
  }

  if (responseType === "text") {
    const text =
      await response.text();

    if (!response.ok) {
      throw createApiError({
        message:
          text ||
          `Request failed with status ${response.status}.`,

        statusCode:
          response.status,
      });
    }

    return text;
  }

  const data = await response
    .json()
    .catch(() => null);

  if (!response.ok) {
    throw createApiError({
      message:
        data?.error ||
        data?.message ||
        `Request failed with status ${response.status}.`,

      statusCode:
        response.status,

      details:
        data?.details ||
        data ||
        null,
    });
  }

  return data;
}

export function createApiUrl(
  path
) {
  const cleanPath = String(
    path || ""
  ).trim();

  if (
    /^https?:\/\//i.test(
      cleanPath
    )
  ) {
    return cleanPath;
  }

  const normalizedPath =
    cleanPath.startsWith("/")
      ? cleanPath
      : `/${cleanPath}`;

  if (
    normalizedPath.startsWith(
      "/api/"
    ) ||
    normalizedPath === "/api"
  ) {
    return `${SERVER_BASE_URL}${normalizedPath}`;
  }

  return `${API_BASE_URL}${normalizedPath}`;
}

export async function downloadProtectedFile(
  path,
  filename
) {
  const blob = await apiRequest(
    path,
    {
      responseType: "blob",
    }
  );

  const objectUrl =
    URL.createObjectURL(blob);

  const anchor =
    document.createElement("a");

  anchor.href = objectUrl;
  anchor.download =
    filename || "download";

  document.body.appendChild(
    anchor
  );

  anchor.click();
  anchor.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(
      objectUrl
    );
  }, 1_000);
}

export async function getProtectedImageUrl(
  path
) {
  const blob = await apiRequest(
    path,
    {
      responseType: "blob",
    }
  );

  return URL.createObjectURL(
    blob
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard APIs                                                     */
/* ------------------------------------------------------------------ */

export async function getRoleDashboard() {
  const data = await apiRequest(
    "/dashboard"
  );

  return data.dashboard;
}

export async function getRoleNavigation() {
  const data = await apiRequest(
    "/dashboard/navigation"
  );

  return data.navigation || [];
}

export async function getWorkspacePlatformStatus() {
  const data = await apiRequest(
    "/workspace-platform/status"
  );

  return data;
}

/* ------------------------------------------------------------------ */
/* Profile APIs                                                       */
/* ------------------------------------------------------------------ */

export async function getMyProfile() {
  const data = await apiRequest(
    "/profile/me"
  );

  return data.profile;
}

export async function updateMyProfile(
  patch
) {
  const data = await apiRequest(
    "/profile/me",
    {
      method: "PATCH",
      body: patch,
    }
  );

  return data.profile;
}

export async function updateMyAvailability(
  availabilityStatus,
  note = ""
) {
  const data = await apiRequest(
    "/profile/me/availability",
    {
      method: "PATCH",

      body: {
        availabilityStatus,
        note,
      },
    }
  );

  return data.profile;
}

export async function updateNotificationPreferences(
  preferences
) {
  const data = await apiRequest(
    "/profile/me/notifications",
    {
      method: "PATCH",
      body: preferences,
    }
  );

  return data.profile;
}

export async function uploadProfileAvatar(
  dataUrl
) {
  const data = await apiRequest(
    "/profile/me/avatar",
    {
      method: "POST",

      body: {
        dataUrl,
      },
    }
  );

  return data.profile;
}

export async function removeProfileAvatar() {
  const data = await apiRequest(
    "/profile/me/avatar",
    {
      method: "DELETE",
    }
  );

  return data.profile;
}

export async function changeMyPassword({
  currentPassword,
  newPassword,
}) {
  return apiRequest(
    "/profile/me/password",
    {
      method: "POST",

      body: {
        currentPassword,
        newPassword,
      },
    }
  );
}

export async function listWorkspaceProfiles() {
  const data = await apiRequest(
    "/profile/members"
  );

  return data.members || [];
}

export async function getMemberProfile(
  userId
) {
  const data = await apiRequest(
    `/profile/members/${encodeURIComponent(
      userId
    )}`
  );

  return data.profile;
}

export async function updateManagedProfile(
  userId,
  patch
) {
  const data = await apiRequest(
    `/profile/members/${encodeURIComponent(
      userId
    )}`,
    {
      method: "PATCH",
      body: patch,
    }
  );

  return data.profile;
}

/* ------------------------------------------------------------------ */
/* Attendance APIs                                                    */
/* ------------------------------------------------------------------ */

export async function createAttendanceChallenge(
  purpose
) {
  const data = await apiRequest(
    "/attendance/photo-challenge",
    {
      method: "POST",

      body: {
        purpose,
      },
    }
  );

  return data.challenge;
}

export async function getTodayAttendance() {
  const data = await apiRequest(
    "/attendance/today"
  );

  return data.attendance;
}

export async function getMyAttendance(
  filters = {}
) {
  return apiRequest(
    buildQueryPath(
      "/attendance/me",
      filters
    )
  );
}

export async function checkIn({
  challengeId,
  photoDataUrl,
  location,
}) {
  const data = await apiRequest(
    "/attendance/check-in",
    {
      method: "POST",

      body: {
        challengeId,
        photoDataUrl,
        location:
          location || null,
      },
    }
  );

  return data.attendance;
}

export async function checkOut({
  challengeId,
  photoDataUrl,
  location,
}) {
  const data = await apiRequest(
    "/attendance/check-out",
    {
      method: "POST",

      body: {
        challengeId,
        photoDataUrl,
        location:
          location || null,
      },
    }
  );

  return data.attendance;
}

export async function listAttendance(
  filters = {}
) {
  return apiRequest(
    buildQueryPath(
      "/attendance",
      filters
    )
  );
}

export async function getAttendanceSummary(
  filters = {}
) {
  const data = await apiRequest(
    buildQueryPath(
      "/attendance/summary",
      filters
    )
  );

  return data.summary;
}

export async function reviewAttendance(
  attendanceId,
  note
) {
  const data = await apiRequest(
    `/attendance/${encodeURIComponent(
      attendanceId
    )}/review`,
    {
      method: "PATCH",

      body: {
        note,
      },
    }
  );

  return data.attendance;
}

export async function updateAttendanceStatus(
  attendanceId,
  status,
  note
) {
  const data = await apiRequest(
    `/attendance/${encodeURIComponent(
      attendanceId
    )}/status`,
    {
      method: "PATCH",

      body: {
        status,
        note,
      },
    }
  );

  return data.attendance;
}

/* ------------------------------------------------------------------ */
/* Team-chat REST APIs                                                */
/* ------------------------------------------------------------------ */

export async function listTeamMembers() {
  const data = await apiRequest(
    "/team-chat/members"
  );

  return data.members || [];
}

export async function listChatChannels() {
  const data = await apiRequest(
    "/team-chat/channels"
  );

  return data.channels || [];
}

export async function createChatChannel(
  input
) {
  const data = await apiRequest(
    "/team-chat/channels",
    {
      method: "POST",
      body: input,
    }
  );

  return data.channel;
}

export async function updateChatChannel(
  channelId,
  patch
) {
  const data = await apiRequest(
    `/team-chat/channels/${encodeURIComponent(
      channelId
    )}`,
    {
      method: "PATCH",
      body: patch,
    }
  );

  return data.channel;
}

export async function deleteChatChannel(
  channelId
) {
  const data = await apiRequest(
    `/team-chat/channels/${encodeURIComponent(
      channelId
    )}`,
    {
      method: "DELETE",
    }
  );

  return data.channel;
}

export async function addChatChannelMembers(
  channelId,
  userIds
) {
  const data = await apiRequest(
    `/team-chat/channels/${encodeURIComponent(
      channelId
    )}/members`,
    {
      method: "POST",

      body: {
        userIds,
      },
    }
  );

  return data.channel;
}

export async function removeChatChannelMember(
  channelId,
  userId
) {
  const data = await apiRequest(
    `/team-chat/channels/${encodeURIComponent(
      channelId
    )}/members/${encodeURIComponent(
      userId
    )}`,
    {
      method: "DELETE",
    }
  );

  return data.channel;
}

export async function listDirectConversations() {
  const data = await apiRequest(
    "/team-chat/direct-conversations"
  );

  return data.conversations || [];
}

export async function loadChannelMessages({
  channelId,
  limit = 50,
  before = "",
}) {
  return apiRequest(
    buildQueryPath(
      "/team-chat/messages",
      {
        channelId,
        limit,
        before,
      }
    )
  );
}

export async function loadDirectMessages({
  userId,
  limit = 50,
  before = "",
}) {
  return apiRequest(
    buildQueryPath(
      "/team-chat/messages",
      {
        recipientUserId:
          userId,
        limit,
        before,
      }
    )
  );
}

export async function sendChatMessage(
  input
) {
  const data = await apiRequest(
    "/team-chat/messages",
    {
      method: "POST",
      body: input,
    }
  );

  return data.message;
}

export async function editChatMessage(
  messageId,
  body
) {
  const data = await apiRequest(
    `/team-chat/messages/${encodeURIComponent(
      messageId
    )}`,
    {
      method: "PATCH",

      body: {
        body,
      },
    }
  );

  return data.message;
}

export async function deleteChatMessage(
  messageId
) {
  const data = await apiRequest(
    `/team-chat/messages/${encodeURIComponent(
      messageId
    )}`,
    {
      method: "DELETE",
    }
  );

  return data.message;
}

export async function markChatMessageRead(
  messageId
) {
  const data = await apiRequest(
    `/team-chat/messages/${encodeURIComponent(
      messageId
    )}/read`,
    {
      method: "POST",
    }
  );

  return data.receipt;
}

export async function markConversationRead({
  channelId = "",
  userId = "",
}) {
  return apiRequest(
    "/team-chat/read",
    {
      method: "POST",

      body: {
        channelId,
        userId,
      },
    }
  );
}

export async function getUnreadChatSummary() {
  const data = await apiRequest(
    "/team-chat/unread"
  );

  return data.unread;
}

export async function searchChatMessages(
  query,
  filters = {}
) {
  const data = await apiRequest(
    buildQueryPath(
      "/team-chat/search",
      {
        q: query,
        ...filters,
      }
    )
  );

  return data.results || [];
}

export async function listSharedResources(
  filters = {}
) {
  const data = await apiRequest(
    buildQueryPath(
      "/team-chat/resources",
      filters
    )
  );

  return data.resources || [];
}

export async function createSharedResource(
  input
) {
  const data = await apiRequest(
    "/team-chat/resources",
    {
      method: "POST",
      body: input,
    }
  );

  return data.resource;
}

export async function listInternalCalls(
  filters = {}
) {
  const data = await apiRequest(
    buildQueryPath(
      "/team-chat/calls",
      filters
    )
  );

  return data.calls || [];
}

/* ------------------------------------------------------------------ */
/* Socket.IO client                                                   */
/* ------------------------------------------------------------------ */

export function getWorkspaceSocket() {
  const token = getAccessToken();

  if (!token) {
    return null;
  }

  if (
    socket &&
    socketToken === token
  ) {
    return socket;
  }

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  socketToken = token;

  socket = io(
    SERVER_BASE_URL,
    {
      path: SOCKET_PATH,

      auth: {
        token,
      },

      transports: [
        "websocket",
        "polling",
      ],

      autoConnect: true,

      reconnection: true,

      reconnectionAttempts:
        Infinity,

      reconnectionDelay: 800,

      reconnectionDelayMax:
        8_000,

      timeout: 20_000,

      withCredentials: true,
    }
  );

  socketListenersRegistered =
    false;

  registerGlobalSocketListeners(
    socket
  );

  return socket;
}

export function connectWorkspaceSocket() {
  const activeSocket =
    getWorkspaceSocket();

  if (
    activeSocket &&
    !activeSocket.connected
  ) {
    activeSocket.connect();
  }

  return activeSocket;
}

export function disconnectWorkspaceSocket() {
  if (!socket) {
    return;
  }

  socket.removeAllListeners();
  socket.disconnect();

  socket = null;
  socketToken = "";
  socketListenersRegistered =
    false;
}

export function reconnectWorkspaceSocket() {
  disconnectWorkspaceSocket();

  return connectWorkspaceSocket();
}

export function onWorkspaceSocket(
  event,
  listener
) {
  if (
    typeof listener !==
    "function"
  ) {
    return () => {};
  }

  let listeners =
    globalSocketListeners.get(
      event
    );

  if (!listeners) {
    listeners = new Set();

    globalSocketListeners.set(
      event,
      listeners
    );
  }

  listeners.add(listener);

  const activeSocket =
    connectWorkspaceSocket();

  if (
    activeSocket &&
    !socketListenersRegistered
  ) {
    registerGlobalSocketListeners(
      activeSocket
    );
  }

  return () => {
    listeners.delete(listener);

    if (!listeners.size) {
      globalSocketListeners.delete(
        event
      );
    }
  };
}

export function emitSocketEvent(
  event,
  payload = {},
  {
    timeoutMs = 15_000,
  } = {}
) {
  const activeSocket =
    connectWorkspaceSocket();

  if (!activeSocket) {
    return Promise.reject(
      createApiError({
        message:
          "You must be signed in to use team communication.",
        statusCode: 401,
      })
    );
  }

  return new Promise(
    (resolve, reject) => {
      const timer =
        window.setTimeout(() => {
          reject(
            createApiError({
              message:
                "The real-time request timed out.",
              statusCode: 408,
            })
          );
        }, timeoutMs);

      activeSocket.emit(
        event,
        payload,
        (response) => {
          window.clearTimeout(
            timer
          );

          if (
            !response ||
            response.ok === false
          ) {
            reject(
              createApiError({
                message:
                  response?.error ||
                  "The real-time action failed.",

                statusCode:
                  response?.statusCode ||
                  500,

                details:
                  response || null,
              })
            );

            return;
          }

          resolve(
            response.data ??
              response
          );
        }
      );
    }
  );
}

function registerGlobalSocketListeners(
  activeSocket
) {
  if (
    !activeSocket ||
    socketListenersRegistered
  ) {
    return;
  }

  socketListenersRegistered =
    true;

  const events = [
    "connect",
    "disconnect",
    "connect_error",
    "socket:ready",
    "socket:operation-error",

    "presence:update",
    "presence:list",

    "channel:created",
    "channel:updated",
    "channel:deleted",
    "channel:members-updated",

    "message:new",
    "message:updated",
    "message:deleted",
    "message:read",
    "message:sent",

    "typing:update",

    "resource:created",
    "resource:updated",
    "resource:deleted",

    "webrtc:call:incoming",
    "webrtc:call:started",
    "webrtc:call:accepted",
    "webrtc:call:declined",
    "webrtc:call:ended",
    "webrtc:signal",

    "attendance:checked-in",
    "attendance:checked-out",
    "attendance:reviewed",
    "attendance:status-updated",

    "profile:updated",
    "profile:availability-updated",
  ];

  for (const event of events) {
    activeSocket.on(
      event,
      (...args) => {
        notifyGlobalListeners(
          event,
          ...args
        );
      }
    );
  }
}

function notifyGlobalListeners(
  event,
  ...args
) {
  const listeners =
    globalSocketListeners.get(
      event
    );

  if (!listeners) {
    return;
  }

  for (const listener of [
    ...listeners,
  ]) {
    try {
      listener(...args);
    } catch (error) {
      console.error(
        `[workspace-socket] listener failed for ${event}`,
        error
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* WebRTC signalling helpers                                          */
/* ------------------------------------------------------------------ */

export function startInternalCall({
  participantUserIds,
  channelId = "",
  callType = "audio",
}) {
  return emitSocketEvent(
    "webrtc:call:start",
    {
      participantUserIds,
      channelId,
      callType,
    }
  );
}

export function acceptInternalCall(
  callId
) {
  return emitSocketEvent(
    "webrtc:call:accept",
    {
      callId,
    }
  );
}

export function declineInternalCall(
  callId
) {
  return emitSocketEvent(
    "webrtc:call:decline",
    {
      callId,
    }
  );
}

export function endInternalCall(
  callId,
  reason = "ended_by_participant"
) {
  return emitSocketEvent(
    "webrtc:call:end",
    {
      callId,
      reason,
    }
  );
}

export function sendWebRtcSignal({
  callId,
  targetUserId,
  signalType,
  signal,
}) {
  const activeSocket =
    connectWorkspaceSocket();

  if (!activeSocket) {
    throw createApiError({
      message:
        "The team communication socket is unavailable.",
      statusCode: 503,
    });
  }

  activeSocket.emit(
    "webrtc:signal",
    {
      callId,
      targetUserId,
      signalType,
      signal,
    }
  );
}

/* ------------------------------------------------------------------ */
/* Utility functions                                                  */
/* ------------------------------------------------------------------ */

export function buildQueryPath(
  path,
  values = {}
) {
  const query =
    new URLSearchParams();

  for (const [
    key,
    value,
  ] of Object.entries(values)) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        query.append(
          key,
          String(item)
        );
      }

      continue;
    }

    query.set(
      key,
      String(value)
    );
  }

  const queryString =
    query.toString();

  return queryString
    ? `${path}?${queryString}`
    : path;
}

async function createResponseError(
  response
) {
  const text =
    await response
      .text()
      .catch(() => "");

  let parsed = null;

  try {
    parsed = text
      ? JSON.parse(text)
      : null;
  } catch {
    parsed = null;
  }

  return createApiError({
    message:
      parsed?.error ||
      parsed?.message ||
      text ||
      `Request failed with status ${response.status}.`,

    statusCode:
      response.status,

    details:
      parsed || null,
  });
}

function createApiError({
  message,
  statusCode = 500,
  details = null,
}) {
  const error = new Error(
    message ||
      "The request failed."
  );

  error.statusCode =
    statusCode;

  error.details =
    details;

  return error;
}