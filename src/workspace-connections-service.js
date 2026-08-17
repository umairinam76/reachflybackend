import crypto from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const CALENDAR_FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];

export function createWorkspaceConnectionsService({ store, workspaceService, email }) {
  function ensureStateShape(draft) {
    draft.workspaceConnections = Array.isArray(draft.workspaceConnections)
      ? draft.workspaceConnections
      : [];
    draft.workspaceConnectionOAuthStates = Array.isArray(draft.workspaceConnectionOAuthStates)
      ? draft.workspaceConnectionOAuthStates
      : [];
    draft.workspaceConnectionActivity = Array.isArray(draft.workspaceConnectionActivity)
      ? draft.workspaceConnectionActivity
      : [];
  }

  function requireContext(user) {
    if (!user?.id) throw httpError(401, "Authentication is required.");
    const ctx = workspaceService.getContext?.(user) || {};
    const workspaceId = clean(ctx.workspaceId || user.workspaceId || user.companyId || user.id);
    if (!workspaceId) throw httpError(401, "Workspace could not be resolved.");
    const role = normalizeStatus(ctx.role || user.workspaceRole || user.role);
    const ownerLike = ["owner", "admin", "manager"].includes(role) || !ctx.workspace;
    if (!ownerLike) {
      throw httpError(403, "Workspace owner, administrator or manager access is required.");
    }
    return { ...ctx, workspaceId, role };
  }

  function getDashboard(user) {
    const ctx = requireContext(user);
    const state = store.read();
    const googleConnections = (state.workspaceConnections || [])
      .filter((item) => item.workspaceId === ctx.workspaceId)
      .sort(byNewest)
      .map(publicConnection);
    const emailboxConnections = listWorkspaceEmailboxConnections(
      state,
      ctx,
      user
    );
    const connections = [...googleConnections, ...emailboxConnections];

    return {
      ok: true,
      workspaceId: ctx.workspaceId,
      googleConfigured: Boolean(
        clean(process.env.GOOGLE_WORKSPACE_CLIENT_ID) &&
        clean(process.env.GOOGLE_WORKSPACE_CLIENT_SECRET) &&
        clean(process.env.GOOGLE_WORKSPACE_REDIRECT_URI) &&
        hasEncryptionKey()
      ),
      connections,
      emailConnections: connections.filter((item) => item.capabilities.emailSend),
      calendarConnections: connections.filter((item) => item.capabilities.calendar),
      recommended: {
        email: connections.find((item) => item.status === "connected" && item.capabilities.emailSend) || null,
        calendar: googleConnections.find((item) => item.status === "connected" && item.capabilities.calendar) || null,
      },
    };
  }

  function beginGoogleOAuth(user, input = {}) {
    const ctx = requireContext(user);
    const clientId = requireEnv("GOOGLE_WORKSPACE_CLIENT_ID");
    requireEnv("GOOGLE_WORKSPACE_CLIENT_SECRET");
    const redirectUri = requireEnv("GOOGLE_WORKSPACE_REDIRECT_URI");
    requireEncryptionKey();

    const nonce = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = new Date(now + 10 * 60_000).toISOString();
    const returnTo = normalizeReturnPath(input.returnTo || "/app/connections");

    store.update((draft) => {
      ensureStateShape(draft);
      draft.workspaceConnectionOAuthStates = draft.workspaceConnectionOAuthStates.filter(
        (item) => Date.parse(item.expiresAt || 0) > now
      );
      draft.workspaceConnectionOAuthStates.push({
        id: nonce,
        provider: "google",
        workspaceId: ctx.workspaceId,
        userId: user.id,
        returnTo,
        createdAt: new Date(now).toISOString(),
        expiresAt,
      });
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: GOOGLE_SCOPES.join(" "),
      state: nonce,
    });

    return {
      ok: true,
      authorizationUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
      expiresAt,
    };
  }

  async function handleGoogleOAuthCallback(input = {}) {
    const code = clean(input.code);
    const stateId = clean(input.state);
    if (!code || !stateId) {
      throw httpError(400, "Google authorization code or state is missing.");
    }

    const snapshot = store.read();
    const pending = (snapshot.workspaceConnectionOAuthStates || []).find(
      (item) => item.id === stateId && item.provider === "google"
    );
    if (!pending || Date.parse(pending.expiresAt || 0) <= Date.now()) {
      throw httpError(400, "This Google connection session expired. Start the connection again.");
    }

    const clientId = requireEnv("GOOGLE_WORKSPACE_CLIENT_ID");
    const clientSecret = requireEnv("GOOGLE_WORKSPACE_CLIENT_SECRET");
    const redirectUri = requireEnv("GOOGLE_WORKSPACE_REDIRECT_URI");
    requireEncryptionKey();

    const tokenResponse = await fetchJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    const accessToken = clean(tokenResponse.access_token);
    const refreshToken = clean(tokenResponse.refresh_token);
    if (!accessToken) {
      throw httpError(502, "Google did not return an access token.");
    }

    const profile = await fetchJson(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const accountEmail = normalizeEmail(profile.email);
    if (!accountEmail) {
      throw httpError(502, "Google did not return the connected account email.");
    }

    const expiresAt = new Date(
      Date.now() + Math.max(60, Number(tokenResponse.expires_in || 3600)) * 1000
    ).toISOString();
    const grantedScopes = uniqueStrings(
      clean(tokenResponse.scope).split(/\s+/).filter(Boolean)
    );
    const now = new Date().toISOString();
    let saved = null;

    store.update((draft) => {
      ensureStateShape(draft);
      draft.workspaceConnectionOAuthStates = draft.workspaceConnectionOAuthStates.filter(
        (item) => item.id !== stateId
      );

      let connection = draft.workspaceConnections.find(
        (item) =>
          item.workspaceId === pending.workspaceId &&
          item.provider === "google" &&
          normalizeEmail(item.accountEmail) === accountEmail
      );

      if (!connection) {
        connection = {
          id: crypto.randomUUID(),
          workspaceId: pending.workspaceId,
          provider: "google",
          type: "google_workspace",
          accountEmail,
          displayName: clean(profile.name),
          pictureUrl: clean(profile.picture),
          createdBy: pending.userId,
          createdAt: now,
        };
        draft.workspaceConnections.push(connection);
      }

      const previousRefreshToken = decryptOptional(connection.refreshTokenEncrypted);
      Object.assign(connection, {
        accountEmail,
        displayName: clean(profile.name) || connection.displayName || accountEmail,
        pictureUrl: clean(profile.picture),
        scopes: grantedScopes,
        status: "connected",
        accessTokenEncrypted: encryptSecret(accessToken),
        refreshTokenEncrypted: encryptSecret(refreshToken || previousRefreshToken),
        accessTokenExpiresAt: expiresAt,
        tokenType: clean(tokenResponse.token_type || "Bearer"),
        updatedAt: now,
        lastError: "",
        capabilities: {
          emailSend: grantedScopes.includes("https://www.googleapis.com/auth/gmail.send"),
          calendar: grantedScopes.some((scope) => scope.includes("calendar")),
          calendarFreeBusy: grantedScopes.some((scope) =>
            [
              "https://www.googleapis.com/auth/calendar.events.freebusy",
              "https://www.googleapis.com/auth/calendar.readonly",
              "https://www.googleapis.com/auth/calendar",
            ].includes(scope)
          ),
          calendarEvents: grantedScopes.some((scope) =>
            [
              "https://www.googleapis.com/auth/calendar.events",
              "https://www.googleapis.com/auth/calendar.events.owned",
              "https://www.googleapis.com/auth/calendar",
            ].includes(scope)
          ),
        },
      });

      draft.workspaceConnectionActivity.unshift({
        id: crypto.randomUUID(),
        workspaceId: pending.workspaceId,
        connectionId: connection.id,
        type: "google_connected",
        actorId: pending.userId,
        detail: accountEmail,
        createdAt: now,
      });
      if (draft.workspaceConnectionActivity.length > 3000) {
        draft.workspaceConnectionActivity.splice(3000);
      }
      saved = { ...connection };
    });

    return {
      ok: true,
      connection: publicConnection(saved),
      returnTo: pending.returnTo || "/app/connections",
    };
  }

  function disconnect(user, connectionId) {
    const ctx = requireContext(user);
    const id = clean(connectionId);
    if (isEmailboxConnectionId(id)) {
      throw httpError(409, "Manage Emailbox accounts from Advanced email setup.", "EMAILBOX_MANAGED_SEPARATELY");
    }
    let removed = null;
    store.update((draft) => {
      ensureStateShape(draft);
      const index = draft.workspaceConnections.findIndex(
        (item) => item.id === id && item.workspaceId === ctx.workspaceId
      );
      if (index < 0) return;
      removed = draft.workspaceConnections[index];
      draft.workspaceConnections.splice(index, 1);

      for (const agent of draft.telnyxAiAgents || []) {
        if (agent.workspaceId !== ctx.workspaceId) continue;
        if (agent.emailConnectionId === id) agent.emailConnectionId = "";
        if (agent.calendarConnectionId === id) agent.calendarConnectionId = "";
      }
    });
    if (!removed) throw httpError(404, "Connection not found.");
    return { ok: true };
  }

  async function testEmail(user, connectionId, input = {}) {
    const ctx = requireContext(user);
    const to = normalizeEmail(input.to || user.email);
    if (!to) throw httpError(422, "Enter a test recipient email.");

    if (isEmailboxConnectionId(connectionId)) {
      const assigned = requireEmailboxConnection(ctx.workspaceId, connectionId);
      const result = await sendEmailboxMessage(assigned, {
        to,
        subject: clean(input.subject) || "ReachFly Emailbox connection test",
        text:
          clean(input.text) ||
          "Your ReachFly Emailbox sender is working correctly.",
      });
      return { ok: true, messageId: result.messageId || "", to };
    }

    const connection = requireConnection(ctx.workspaceId, connectionId, "email");
    const result = await sendEmailWithConnection(connection, {
      to,
      subject: clean(input.subject) || "ReachFly email connection test",
      text:
        clean(input.text) ||
        "Your ReachFly Google Workspace email connection is working correctly.",
    });
    return { ok: true, messageId: result.id || "", to };
  }

  async function testCalendar(user, connectionId, input = {}) {
    const ctx = requireContext(user);
    const connection = requireConnection(ctx.workspaceId, connectionId, "calendar");
    const timeMin = safeIso(input.timeMin) || new Date().toISOString();
    const timeMax = safeIso(input.timeMax) || new Date(Date.now() + 24 * 3600_000).toISOString();
    return queryFreeBusy(connection, {
      timeMin,
      timeMax,
      timeZone: clean(input.timeZone || "UTC"),
    });
  }

  async function sendAgentEmail({ headers = {}, body = {} } = {}) {
    verifyAgentToolSecret(headers);
    const { call, agent } = resolveCallAgent(body);
    const direction = normalizeStatus(call.direction || "outbound");
    const actions = direction === "inbound" ? agent.inboundActions : agent.outboundActions;
    if (actions?.sendEmail !== true) {
      throw httpError(403, "This agent is not allowed to send email.");
    }
    const assignedEmail = resolveAssignedEmailConnection(
      call.workspaceId,
      agent.emailConnectionId
    );
    const to = normalizeEmail(
      body.to_email ||
      body.to ||
      body.email ||
      call.contextSnapshot?.email ||
      call.contextSnapshot?.leadEmail
    );
    if (!to) throw httpError(422, "A recipient email is required before sending details.");

    const messageText = clean(body.body || body.text || body.message);
    if (!messageText) {
      throw httpError(
        422,
        "Email content is required before sending.",
        "AGENT_EMAIL_BODY_REQUIRED"
      );
    }

    const result = assignedEmail.kind === "emailbox"
      ? await sendEmailboxMessage(assignedEmail.connection, {
          to,
          subject: clean(body.subject) || `Information from ${agent.companyName || "the team"}`,
          text: messageText,
        })
      : await sendEmailWithConnection(assignedEmail.connection, {
          to,
          subject: clean(body.subject) || `Information from ${agent.companyName || "the team"}`,
          text: messageText,
          replyTo: normalizeEmail(body.replyTo),
        });

    const messageId = clean(result.id || result.messageId);
    const fromEmail = normalizeEmail(
      result.fromEmail || assignedEmail.connection.accountEmail
    );
    appendCallActivity(call, {
      type: "agent_email_sent",
      connectionId: assignedEmail.connection.id,
      connectionType: assignedEmail.kind,
      fromEmail,
      to,
      subject: clean(body.subject),
      providerMessageId: messageId,
    });

    return {
      ok: true,
      sent: true,
      fromEmail,
      to,
      messageId,
      connectionId: assignedEmail.connection.id,
    };
  }

  async function checkAgentCalendar({ headers = {}, body = {} } = {}) {
    verifyAgentToolSecret(headers);
    const { call, agent } = resolveCallAgent(body);
    const connection = requireConnection(
      call.workspaceId,
      agent.calendarConnectionId,
      "calendar"
    );
    const timeMin = safeIso(body.timeMin || body.start) || new Date().toISOString();
    const timeMax = safeIso(body.timeMax || body.end) || new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    return queryFreeBusy(connection, {
      timeMin,
      timeMax,
      timeZone: clean(body.timeZone || agent.bookingTimezone || "UTC"),
    });
  }

  async function bookAgentMeeting({ headers = {}, body = {} } = {}) {
    verifyAgentToolSecret(headers);
    const { call, agent } = resolveCallAgent(body);
    const actions = normalizeStatus(call.direction) === "inbound"
      ? agent.inboundActions
      : agent.outboundActions;
    if (actions?.bookMeeting === false) {
      throw httpError(403, "This agent is not allowed to book meetings.");
    }
    const connection = requireConnection(
      call.workspaceId,
      agent.calendarConnectionId,
      "calendar"
    );
    const start = safeIso(body.start || body.startAt || body.confirmedStart);
    const end = safeIso(body.end || body.endAt) ||
      (start
        ? new Date(Date.parse(start) + Math.max(10, Number(body.durationMinutes || agent.meetingDurationMinutes || 30)) * 60_000).toISOString()
        : "");
    if (!start || !end) throw httpError(422, "Confirmed meeting start and end are required.");

    const attendeeEmail = normalizeEmail(body.attendeeEmail || body.email || call.contextSnapshot?.email);
    const calendarId = clean(body.calendarId || "primary");
    const event = await createCalendarEvent(connection, calendarId, {
      summary: clean(body.title) || `${agent.companyName || "ReachFly"} discovery meeting`,
      description: clean(body.description || body.notes || `Booked by ${agent.name || "ReachFly AI Agent"}.`),
      start: {
        dateTime: start,
        timeZone: clean(body.timeZone || agent.bookingTimezone || "UTC"),
      },
      end: {
        dateTime: end,
        timeZone: clean(body.timeZone || agent.bookingTimezone || "UTC"),
      },
      attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    });

    appendCallActivity(call, {
      type: "agent_calendar_event_created",
      connectionId: connection.id,
      eventId: clean(event.id),
      attendeeEmail,
      startAt: start,
    });

    return {
      ok: true,
      booked: true,
      eventId: clean(event.id),
      htmlLink: clean(event.htmlLink),
      startAt: start,
      endAt: end,
      attendeeEmail,
    };
  }

  function listWorkspaceEmailboxConnections(state, ctx, currentUser) {
    if (!email?.getSettings) return [];
    const ownerIds = uniqueStrings([
      clean(currentUser?.id),
      clean(ctx?.workspace?.ownerId || ctx?.workspace?.ownerUserId),
      ...(state.users || [])
        .filter(
          (item) =>
            clean(item.workspaceId) === clean(ctx.workspaceId) &&
            ["owner", "admin", "manager"].includes(
              normalizeStatus(item.workspaceRole || item.role)
            )
        )
        .map((item) => clean(item.id)),
    ]);
    const rows = [];
    const seen = new Set();
    for (const ownerId of ownerIds) {
      if (!ownerId) continue;
      let settings;
      try {
        settings = email.getSettings(ownerId) || {};
      } catch {
        continue;
      }
      const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
      for (const account of accounts) {
        const accountId = clean(account.id);
        const accountEmail = normalizeEmail(account.fromEmail || account.username);
        if (!accountId || !accountEmail) continue;
        const id = buildEmailboxConnectionId(ownerId, accountId);
        if (seen.has(id)) continue;
        seen.add(id);
        const connected = Boolean(
          clean(account.host) &&
          Number(account.port || 0) > 0 &&
          clean(account.username) &&
          account.hasPassword === true
        );
        rows.push({
          id,
          workspaceId: ctx.workspaceId,
          provider: clean(account.provider) || "emailbox",
          type: "emailbox_smtp",
          accountEmail,
          displayName: clean(account.fromName) || accountEmail,
          pictureUrl: "",
          status: connected ? "connected" : "attention",
          scopes: [],
          capabilities: { emailSend: connected, calendar: false },
          lastError: connected ? "" : "Finish SMTP setup in Advanced email setup.",
          createdAt: clean(account.createdAt),
          updatedAt: clean(account.updatedAt),
          managedIn: "/app/email",
        });
      }
    }
    return rows;
  }

  function resolveAssignedEmailConnection(workspaceId, connectionId) {
    if (isEmailboxConnectionId(connectionId)) {
      return {
        kind: "emailbox",
        connection: requireEmailboxConnection(workspaceId, connectionId),
      };
    }
    return {
      kind: "google",
      connection: requireConnection(workspaceId, connectionId, "email"),
    };
  }

  function requireEmailboxConnection(workspaceId, connectionId) {
    if (!email?.getSettings || !email?.sendCampaignEmail) {
      throw httpError(503, "ReachFly Emailbox is not available.", "EMAILBOX_UNAVAILABLE");
    }
    const parsed = parseEmailboxConnectionId(connectionId);
    if (!parsed.ownerId || !parsed.accountId) {
      throw httpError(409, "The assigned Emailbox sender is invalid.", "AGENT_EMAIL_CONNECTION_REQUIRED");
    }
    const state = store.read();
    const owner = (state.users || []).find(
      (item) => item.id === parsed.ownerId && clean(item.workspaceId) === clean(workspaceId)
    );
    if (!owner) {
      throw httpError(409, "The assigned Emailbox owner is unavailable.", "AGENT_CONNECTION_UNAVAILABLE");
    }
    const settings = email.getSettings(parsed.ownerId) || {};
    const account = (Array.isArray(settings.accounts) ? settings.accounts : []).find(
      (item) => clean(item.id) === parsed.accountId
    );
    const accountEmail = normalizeEmail(account?.fromEmail || account?.username);
    if (!account || !accountEmail || !clean(account.host) || !clean(account.username) || account.hasPassword !== true) {
      throw httpError(
        409,
        "The assigned Emailbox sender is unavailable or incomplete. Reconnect it in Advanced email setup.",
        "AGENT_CONNECTION_UNAVAILABLE"
      );
    }
    return {
      id: buildEmailboxConnectionId(parsed.ownerId, parsed.accountId),
      workspaceId,
      ownerId: parsed.ownerId,
      accountId: parsed.accountId,
      accountEmail,
      provider: clean(account.provider) || "emailbox",
      type: "emailbox_smtp",
      capabilities: { emailSend: true, calendar: false },
      status: "connected",
    };
  }

  async function sendEmailboxMessage(connection, { to, subject, text }) {
    try {
      return await email.sendCampaignEmail(connection.ownerId, {
        accountId: connection.accountId,
        to,
        subject,
        body: text,
      });
    } catch (error) {
      throw httpError(
        502,
        clean(error?.message) || "Emailbox could not send this email.",
        "EMAILBOX_SEND_FAILED"
      );
    }
  }

  function buildEmailboxConnectionId(ownerId, accountId) {
    return `emailbox:${encodeURIComponent(clean(ownerId))}:${encodeURIComponent(clean(accountId))}`;
  }

  function parseEmailboxConnectionId(value) {
    const raw = clean(value);
    if (!raw.startsWith("emailbox:")) return { ownerId: "", accountId: "" };
    const parts = raw.split(":");
    try {
      return {
        ownerId: decodeURIComponent(parts[1] || ""),
        accountId: decodeURIComponent(parts.slice(2).join(":") || ""),
      };
    } catch {
      return { ownerId: "", accountId: "" };
    }
  }

  function isEmailboxConnectionId(value) {
    return clean(value).startsWith("emailbox:");
  }

  function requireConnection(workspaceId, connectionId, capability = "") {
    const id = clean(connectionId);
    if (!id) {
      throw httpError(
        409,
        capability === "email"
          ? "Connect and assign an email account to this agent first."
          : "Connect and assign a calendar to this agent first.",
        capability === "email"
          ? "AGENT_EMAIL_CONNECTION_REQUIRED"
          : "AGENT_CALENDAR_CONNECTION_REQUIRED"
      );
    }
    const connection = (store.read().workspaceConnections || []).find(
      (item) =>
        item.id === id &&
        item.workspaceId === workspaceId &&
        item.status === "connected"
    );
    if (!connection) {
      throw httpError(
        409,
        "The assigned workspace connection is unavailable.",
        "AGENT_CONNECTION_UNAVAILABLE"
      );
    }
    if (capability === "email" && connection.capabilities?.emailSend !== true) {
      throw httpError(
        409,
        "The assigned connection does not have email sending permission.",
        "AGENT_EMAIL_PERMISSION_REQUIRED"
      );
    }
    if (capability === "calendar" && connection.capabilities?.calendar !== true) {
      throw httpError(
        409,
        "The assigned connection does not have calendar permission.",
        "AGENT_CALENDAR_PERMISSION_REQUIRED"
      );
    }
    return connection;
  }

  function resolveCallAgent(body) {
    const callId = clean(body.reachfly_call_id || body.reachflyCallId || body.callId);
    const conversationId = clean(
      body.conversation_id || body.conversationId || body.system__conversation_id
    );
    if (!callId && !conversationId) {
      throw httpError(422, "ReachFly call or conversation ID is required.");
    }
    const state = store.read();
    const call = (state.telnyxAiAgentCalls || []).find(
      (item) =>
        (callId && item.id === callId) ||
        (conversationId && clean(item.conversationId) === conversationId)
    );
    if (!call) throw httpError(404, "ReachFly call was not found.");

    // V6 calls persist a local agentId. Historical calls created before V6 can
    // still use the workspace's primary/first managed agent.
    const workspaceAgents = (state.telnyxAiAgents || [])
      .filter((item) => item.workspaceId === call.workspaceId)
      .sort((left, right) => {
        if (left.primary === true && right.primary !== true) return -1;
        if (right.primary === true && left.primary !== true) return 1;
        return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
      });
    const agent =
      workspaceAgents.find((item) => item.id === call.agentId) ||
      (!call.agentId ? workspaceAgents[0] : null);

    if (!agent) {
      throw httpError(
        409,
        "The Voice Agent linked to this call is unavailable.",
        "CALL_AGENT_UNAVAILABLE"
      );
    }
    return { call, agent };
  }

  function appendCallActivity(call, entry) {
    const now = new Date().toISOString();
    store.update((draft) => {
      ensureStateShape(draft);
      const target = (draft.telnyxAiAgentCalls || []).find((item) => item.id === call.id);
      if (target) {
        target.actionTimeline = Array.isArray(target.actionTimeline) ? target.actionTimeline : [];
        target.actionTimeline.unshift({ id: crypto.randomUUID(), ...entry, createdAt: now });
        target.updatedAt = now;
      }
      draft.workspaceConnectionActivity.unshift({
        id: crypto.randomUUID(),
        workspaceId: call.workspaceId,
        callId: call.id,
        agentId: call.agentId,
        ...entry,
        createdAt: now,
      });
    });
  }

  async function sendEmailWithConnection(connection, { to, subject, text, replyTo = "" }) {
    const accessToken = await getValidAccessToken(connection);
    const from = connection.accountEmail;
    const headers = [
      `From: ${sanitizeHeader(from)}`,
      `To: ${sanitizeHeader(to)}`,
      `Subject: ${sanitizeHeader(subject || "ReachFly information")}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
    ];
    if (replyTo) headers.push(`Reply-To: ${sanitizeHeader(replyTo)}`);
    const raw = `${headers.join("\r\n")}\r\n\r\n${String(text || "Requested information from ReachFly.")}`;
    const encoded = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    return fetchJson(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: encoded }),
    });
  }

  async function queryFreeBusy(connection, { timeMin, timeMax, timeZone }) {
    const accessToken = await getValidAccessToken(connection);
    const result = await fetchJson(CALENDAR_FREEBUSY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        timeZone: timeZone || "UTC",
        items: [{ id: "primary" }],
      }),
    });
    const busy = result?.calendars?.primary?.busy || [];
    return {
      ok: true,
      timeMin,
      timeMax,
      timeZone: timeZone || "UTC",
      busy,
    };
  }

  async function createCalendarEvent(connection, calendarId, event) {
    const accessToken = await getValidAccessToken(connection);
    return fetchJson(
      `${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(calendarId || "primary")}/events?sendUpdates=all`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      }
    );
  }

  async function getValidAccessToken(connection) {
    const current = decryptOptional(connection.accessTokenEncrypted);
    if (current && Date.parse(connection.accessTokenExpiresAt || 0) > Date.now() + 60_000) {
      return current;
    }
    const refreshToken = decryptOptional(connection.refreshTokenEncrypted);
    if (!refreshToken) {
      markConnectionError(connection.id, "Google refresh token is unavailable. Reconnect the account.");
      throw httpError(401, "Google connection expired. Reconnect the account.");
    }

    const response = await fetchJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: requireEnv("GOOGLE_WORKSPACE_CLIENT_ID"),
        client_secret: requireEnv("GOOGLE_WORKSPACE_CLIENT_SECRET"),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const accessToken = clean(response.access_token);
    if (!accessToken) throw httpError(502, "Google token refresh failed.");
    const expiresAt = new Date(
      Date.now() + Math.max(60, Number(response.expires_in || 3600)) * 1000
    ).toISOString();

    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.workspaceConnections.find((item) => item.id === connection.id);
      if (!target) return;
      target.accessTokenEncrypted = encryptSecret(accessToken);
      target.accessTokenExpiresAt = expiresAt;
      target.status = "connected";
      target.lastError = "";
      target.updatedAt = new Date().toISOString();
    });
    return accessToken;
  }

  function markConnectionError(connectionId, message) {
    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.workspaceConnections.find((item) => item.id === connectionId);
      if (!target) return;
      target.status = "attention";
      target.lastError = clean(message).slice(0, 1000);
      target.updatedAt = new Date().toISOString();
    });
  }

  function verifyAgentToolSecret(headers) {
    const expected = clean(process.env.TELNYX_AI_AGENT_TOOL_SECRET);
    const supplied = clean(
      headers["x-reachfly-agent-secret"] || headers["X-ReachFly-Agent-Secret"]
    );
    if (!expected || !supplied) throw httpError(403, "Agent tool authentication failed.");
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw httpError(403, "Agent tool authentication failed.");
    }
  }

  return {
    getDashboard,
    beginGoogleOAuth,
    handleGoogleOAuthCallback,
    disconnect,
    testEmail,
    testCalendar,
    sendAgentEmail,
    checkAgentCalendar,
    bookAgentMeeting,
  };
}

function publicConnection(item = {}) {
  return {
    id: item.id || "",
    workspaceId: item.workspaceId || "",
    provider: item.provider || "",
    type: item.type || "",
    accountEmail: item.accountEmail || "",
    displayName: item.displayName || "",
    pictureUrl: item.pictureUrl || "",
    status: item.status || "",
    scopes: Array.isArray(item.scopes) ? item.scopes : [],
    capabilities: item.capabilities || {},
    lastError: item.lastError || "",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
  };
}

function encryptSecret(value) {
  const plain = String(value || "");
  if (!plain) return "";
  const key = requireEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptOptional(value) {
  const encoded = clean(value);
  if (!encoded) return "";
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  try {
    const key = requireEncryptionKey();
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const encrypted = Buffer.from(parts[3], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function requireEncryptionKey() {
  const raw = String(process.env.CONNECTION_ENCRYPTION_KEY || "").trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, "hex");
  else {
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      key = Buffer.alloc(0);
    }
  }
  if (key.length !== 32) {
    throw httpError(
      503,
      "Workspace connection encryption is not configured.",
      "CONNECTION_ENCRYPTION_NOT_CONFIGURED"
    );
  }
  return key;
}

function hasEncryptionKey() {
  try {
    requireEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message =
      body?.error_description ||
      body?.error?.message ||
      body?.message ||
      `Upstream request failed (${response.status}).`;
    throw httpError(502, message, "CONNECTION_PROVIDER_ERROR");
  }
  return body || {};
}

function safeIso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function normalizeReturnPath(value) {
  const raw = clean(value);
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/app/connections";
  return raw.slice(0, 500);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(clean).filter(Boolean))];
}

function byNewest(a, b) {
  return String(b.updatedAt || b.createdAt || "").localeCompare(
    String(a.updatedAt || a.createdAt || "")
  );
}

function requireEnv(name) {
  const value = clean(process.env[name]);
  if (!value) throw httpError(503, `${name} is not configured on the ReachFly backend.`, `${name}_MISSING`);
  return value;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function httpError(statusCode, message, code = "", details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}
