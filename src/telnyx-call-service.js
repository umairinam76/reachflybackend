import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const ACTIVE_CALL_STATES = new Set([
  "created",
  "initiated",
  "ringing",
  "answered",
  "active",
  "held",
  "recording",
]);

export function createTelnyxCallService({
  store,
  workspaceService,
  dataDir,
  emit = () => {},
} = {}) {
  if (!store?.read || !store?.update) {
    throw new Error("createTelnyxCallService requires a store.");
  }

  const apiKey = clean(process.env.TELNYX_API_KEY);
  // This MUST be the ID of a Telnyx Credential Connection.
  // It is not a Call Control Application ID, Voice API Application ID,
  // outbound voice profile ID, or telephony credential ID.
  const connectionId = clean(
    process.env.TELNYX_CREDENTIAL_CONNECTION_ID ||
      process.env.TELNYX_CONNECTION_ID
  );
  const publicKey = clean(process.env.TELNYX_PUBLIC_KEY).replace(/\\n/g, "\n");
  const webhookBaseUrl = clean(process.env.TELNYX_WEBHOOK_BASE_URL).replace(/\/$/, "");
  const recordingEnabled = envFlag("TELNYX_RECORD_CALLS", true);
  const autoProvision = envFlag("TELNYX_AUTO_PROVISION_CALLERS", true);
  const recordingFormat = ["wav", "mp3"].includes(clean(process.env.TELNYX_RECORDING_FORMAT).toLowerCase())
    ? clean(process.env.TELNYX_RECORDING_FORMAT).toLowerCase()
    : "mp3";
  const recordingChannels = ["single", "dual"].includes(clean(process.env.TELNYX_RECORDING_CHANNELS).toLowerCase())
    ? clean(process.env.TELNYX_RECORDING_CHANNELS).toLowerCase()
    : "dual";
  const recordingDirectory = path.resolve(
    dataDir || process.env.DATA_DIR || "./data",
    "call-recordings"
  );
  const recordingMaxBytes = Math.max(
    1024 * 1024,
    Number(process.env.TELNYX_RECORDING_MAX_BYTES || 100 * 1024 * 1024)
  );

  fs.mkdirSync(recordingDirectory, { recursive: true });

  async function diagnostics(user = null) {
    const state = store.read();
    const dialers = Array.isArray(state.telnyxDialers) ? state.telnyxDialers : [];
    const ctx = user ? context(user, state) : null;
    const result = {
      ok: Boolean(apiKey && connectionId),
      provider: "telnyx",
      configured: Boolean(apiKey && connectionId),
      apiKeyPresent: Boolean(apiKey),
      connectionIdPresent: Boolean(connectionId),
      publicKeyPresent: Boolean(publicKey),
      webhookBaseUrl,
      webhookUrl: webhookBaseUrl
        ? `${webhookBaseUrl}/api/telnyx/webhooks/call-control`
        : "",
      recordingEnabled,
      recordingFormat,
      recordingChannels,
      autoProvision,
      dialerCount: ctx
        ? dialers.filter((item) => item.workspaceId === ctx.workspaceId).length
        : dialers.length,
      connectionReachable: false,
      connectionActive: false,
      connectionType: "",
      outboundVoiceProfilePresent: false,
      callParkingEnabled: false,
      connectionWebhookUrl: "",
      fromNumbers: [],
      errors: [],
    };

    if (!apiKey || !connectionId) return result;

    try {
      const response = await telnyxRequest(
        `/credential_connections/${encodeURIComponent(connectionId)}`
      );
      const connection = response?.data || response || {};
      result.connectionReachable = Boolean(connection.id);
      result.connectionActive = connection.active !== false;
      result.connectionType = connection.record_type || "credential_connection";
      result.outboundVoiceProfilePresent = Boolean(
        connection.outbound?.outbound_voice_profile_id ||
        connection.outbound_voice_profile_id
      );
      result.callParkingEnabled = connection.outbound?.call_parking_enabled === true;
      result.connectionWebhookUrl = clean(connection.webhook_event_url);

      const configuredNumbers = configuredFromNumbers();
      result.fromNumbers = await Promise.all(
        configuredNumbers.map(async (number) => {
          try {
            const assignment = await getPhoneNumberAssignment(number);
            return {
              number,
              found: Boolean(assignment),
              connectionId: clean(assignment?.connection_id),
              assignedToConfiguredConnection:
                clean(assignment?.connection_id) === clean(connectionId),
              status: clean(assignment?.status),
            };
          } catch (error) {
            return { number, found: false, error: error.message };
          }
        })
      );

      if (!result.connectionActive) {
        result.ok = false;
        result.errors.push("The Telnyx credential connection is inactive.");
      }
      if (!result.outboundVoiceProfilePresent) {
        result.ok = false;
        result.errors.push("The Telnyx credential connection has no outbound voice profile.");
      }
      if (recordingEnabled && !result.callParkingEnabled) {
        result.errors.push("Call recording/webhook control requires Park Outbound Calls on the credential connection.");
      }
      if (result.fromNumbers.some((item) => !item.assignedToConfiguredConnection)) {
        result.ok = false;
        result.errors.push("One or more TELNYX_FROM_NUMBERS are not assigned to TELNYX_CONNECTION_ID.");
      }
    } catch (error) {
      result.ok = false;
      result.errors.push(error.message);
    }

    return result;
  }

  async function getBrowserSession(user) {
    requireCaller(user);
    assertConfigured();

    const dialer = await ensureCallerDialer(user);
    const tokenResponse = await telnyxRequest(
      `/telephony_credentials/${encodeURIComponent(dialer.credentialId)}/token`,
      { method: "POST" }
    );
    const loginToken = extractLoginToken(tokenResponse);

    if (!loginToken) {
      throw httpError(502, "Telnyx did not return a WebRTC login token.");
    }

    if (!dialer.fromNumber) {
      throw httpError(409, "No Telnyx caller ID number is assigned to this caller.");
    }

    const connection = await getConnectionConfiguration();
    const outboundVoiceProfileId = clean(
      connection.outbound?.outbound_voice_profile_id ||
      connection.outbound_voice_profile_id
    );

    if (connection.active === false) {
      throw httpError(409, "The Telnyx credential connection is inactive.");
    }

    if (!outboundVoiceProfileId) {
      throw httpError(409, "Assign an Outbound Voice Profile to the Telnyx credential connection.");
    }

    const phoneNumber = await getPhoneNumberAssignment(dialer.fromNumber);
    if (!phoneNumber) {
      throw httpError(409, `The Telnyx caller ID ${dialer.fromNumber} was not found in this account.`);
    }

    if (clean(phoneNumber.connection_id) !== clean(connectionId)) {
      throw httpError(409, `Assign ${dialer.fromNumber} to Telnyx credential connection ${connectionId}.`);
    }

    const callParkingEnabled = connection.outbound?.call_parking_enabled === true;

    return {
      ok: true,
      provider: "telnyx",
      loginToken,
      expiresInSeconds: 23 * 60 * 60,
      callerIdNumber: dialer.fromNumber,
      callerIdName: dialer.callerIdName || user.name || "ReachFly",
      credentialId: dialer.credentialId,
      recordingEnabled: recordingEnabled && callParkingEnabled,
      recordingConfigured: recordingEnabled,
      callParkingEnabled,
      recordingRequiresConsent: recordingEnabled && callParkingEnabled,
    };
  }

  async function ensureCallerDialer(user) {
    const state = store.read();
    const ctx = context(user, state);
    const existing = (state.telnyxDialers || []).find(
      (item) =>
        item.workspaceId === ctx.workspaceId &&
        item.userId === user.id &&
        item.active !== false
    );

    if (existing?.credentialId) {
      try {
        const response = await telnyxRequest(
          `/telephony_credentials/${encodeURIComponent(existing.credentialId)}`
        );
        const credential = response?.data || response || {};

        const credentialConnectionId =
          getCredentialConnectionId(credential);

        if (
          credentialConnectionId &&
          credentialConnectionId !== connectionId
        ) {
          throw httpError(
            409,
            `The saved Telnyx credential belongs to connection ${credentialConnectionId}, not ${connectionId}.`
          );
        }

        const preferredFromNumber =
          chooseFromNumber(
            user,
            state,
            ctx
          );

        /*
         * Resource Board is authoritative for the caller's manual number.
         * Older builds kept returning a previously saved dialer.fromNumber even
         * after the manager changed the caller's number. Synchronize it here.
         */
        if (
          preferredFromNumber &&
          normalizePhone(
            existing.fromNumber
          ) !==
            preferredFromNumber
        ) {
          return saveDialer({
            workspaceId:
              ctx.workspaceId,
            user,
            credentialId:
              existing.credentialId,
            sipUsername:
              existing.sipUsername ||
              credential.sip_username ||
              "",
            fromNumber:
              preferredFromNumber,
            callerIdName:
              existing.callerIdName ||
              user.name ||
              "ReachFly",
            source:
              existing.source ||
              "stored",
          });
        }

        if (
          !existing.fromNumber &&
          preferredFromNumber
        ) {
          return saveDialer({
            workspaceId:
              ctx.workspaceId,
            user,
            credentialId:
              existing.credentialId,
            sipUsername:
              existing.sipUsername ||
              credential.sip_username ||
              "",
            fromNumber:
              preferredFromNumber,
            callerIdName:
              existing.callerIdName ||
              user.name ||
              "ReachFly",
            source:
              existing.source ||
              "stored",
          });
        }

        return existing;
      } catch (error) {
        if (![404, 422].includes(Number(error.statusCode))) throw error;

        store.update((draft) => {
          const stale = (draft.telnyxDialers || []).find(
            (item) => item.id === existing.id
          );
          if (stale) stale.active = false;
        });
      }
    }

    const configured = configuredDialerForUser(user, state, ctx);
    if (configured?.credentialId) {
      return saveDialer({
        workspaceId: ctx.workspaceId,
        user,
        credentialId: configured.credentialId,
        fromNumber: configured.fromNumber,
        callerIdName: configured.callerIdName,
        source: "environment",
      });
    }

    if (!autoProvision) {
      throw httpError(
        409,
        "No Telnyx dialer is assigned to this caller. Configure TELNYX_CALLER_CREDENTIALS_JSON or enable TELNYX_AUTO_PROVISION_CALLERS."
      );
    }

    // Fail with a useful message before attempting to create the
    // per-caller credential. Telnyx only accepts an active Credential
    // Connection ID for POST /telephony_credentials.
    const connection = await getConnectionConfiguration();

    if (connection.active === false) {
      throw httpError(
        409,
        `Telnyx credential connection ${connectionId} is inactive.`
      );
    }

    let created;

    try {
      created = await telnyxRequest("/telephony_credentials", {
        method: "POST",
        body: {
          connection_id: connectionId,
          name: `ReachFly ${user.name || user.email || user.id}`.slice(
            0,
            128
          ),
          tag: sanitizeTelnyxTag(`reachfly-${ctx.workspaceId}`),
        },
      });
    } catch (error) {
      if (Number(error?.statusCode) === 422) {
        throw httpError(
          422,
          [
            `Telnyx rejected credential creation for connection ${connectionId}.`,
            error.message,
            "Set TELNYX_CREDENTIAL_CONNECTION_ID to the ID shown under Voice > SIP Trunking > Credential Connections.",
            "Do not use a Call Control Application ID, Voice API Application ID, outbound voice profile ID, or telephony credential ID.",
          ]
            .filter(Boolean)
            .join(" ")
        );
      }

      throw error;
    }

    const credential = created?.data || created;
    if (!credential?.id) {
      throw httpError(502, "Telnyx did not return a telephony credential ID.");
    }

    return saveDialer({
      workspaceId: ctx.workspaceId,
      user,
      credentialId: credential.id,
      sipUsername: credential.sip_username || "",
      fromNumber: chooseFromNumber(user, state, ctx),
      callerIdName: user.name || "ReachFly",
      source: "auto-provisioned",
    });
  }

  function listDialers(user) {
    const state = store.read();
    const ctx = context(user, state);
    requireManagerOrOwner(ctx);

    const callers = listWorkspaceCallers(state, ctx.workspaceId);
    const dialers = state.telnyxDialers || [];

    return {
      ok: true,
      members: callers.map((caller) => {
        const dialer = dialers.find(
          (item) => item.workspaceId === ctx.workspaceId && item.userId === caller.id
        );
        return {
          id: caller.id,
          name: caller.name || caller.email,
          email: caller.email || "",
          workspaceRole: "caller",
          dialer: dialer
            ? publicDialer(dialer)
            : {
                configured: false,
                fromNumber: "",
                credentialId: "",
              },
        };
      }),
    };
  }

  async function provisionAllCallers(user) {
    const state = store.read();
    const ctx = context(user, state);
    requireManagerOrOwner(ctx);
    assertConfigured();

    const callers = listWorkspaceCallers(state, ctx.workspaceId);
    const results = [];
    for (const caller of callers) {
      try {
        const dialer = await ensureCallerDialer(caller);
        results.push({ ok: true, userId: caller.id, dialer: publicDialer(dialer) });
      } catch (error) {
        results.push({ ok: false, userId: caller.id, error: error.message });
      }
    }

    return {
      ok: results.every((item) => item.ok),
      provisioned: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    };
  }

  function createCall(user, input = {}) {
    requireCaller(user);
    const state = store.read();
    const ctx = context(user, state);
    const toNumber = normalizePhone(input.toNumber || input.phone);
    if (!toNumber) throw httpError(400, "A valid destination phone number is required.");

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const dialer = (state.telnyxDialers || []).find(
      (item) =>
        item.workspaceId === ctx.workspaceId &&
        item.userId === user.id &&
        item.active !== false
    );
    const fromNumber = normalizePhone(input.fromNumber || dialer?.fromNumber);

    if (!dialer?.credentialId) {
      throw httpError(409, "Open the dialer once to provision a Telnyx credential before creating a call.");
    }

    if (!fromNumber) {
      throw httpError(409, "No valid Telnyx caller ID number is assigned to this caller.");
    }

    const call = {
      id,
      provider: "telnyx",
      workspaceId: ctx.workspaceId,
      callerUserId: user.id,
      callerName: user.name || user.email || "Caller",
      campaignId: clean(input.campaignId),
      leadId: clean(input.leadId),
      assignmentId: clean(input.assignmentId),
      fromNumber,
      toNumber,
      status: "created",
      direction: "outbound",
      recordingRequested: recordingEnabled && input.recordingConsent === true,
      recordingConsent: input.recordingConsent === true,
      recordingConsentAt: input.recordingConsent === true ? now : "",
      recordingDisclosureVersion: clean(input.recordingDisclosureVersion || "v1"),
      recordingStatus: input.recordingConsent === true ? "pending" : "disabled",
      recordingId: "",
      recordingUrl: "",
      recordingFilePath: "",
      recordingMimeType: "",
      providerCallId: "",
      callControlId: "",
      callSessionId: "",
      startedAt: now,
      ringingAt: "",
      answeredAt: "",
      endedAt: "",
      durationSeconds: 0,
      outcome: "",
      disposition: "",
      notes: "",
      lastEventAt: now,
      events: [
        {
          id: crypto.randomUUID(),
          type: "call.created",
          occurredAt: now,
          source: "reachfly",
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      ensureState(draft);
      draft.calls.unshift(call);
    });

    emitCall(call, "call:created");

    return {
      ok: true,
      call: publicCall(call),
      customHeaders: [
        { name: "X-ReachFly-Call-Id", value: id },
        ...(call.assignmentId
          ? [{ name: "X-ReachFly-Assignment-Id", value: call.assignmentId }]
          : []),
      ],
    };
  }

  function linkCall(user, callId, input = {}) {
    const updated = mutateAccessibleCall(user, callId, (call) => {
      call.providerCallId = clean(input.providerCallId || input.id || call.providerCallId);
      call.callControlId = clean(input.callControlId || input.call_control_id || call.callControlId);
      call.callSessionId = clean(input.callSessionId || input.call_session_id || call.callSessionId);
      call.status = normalizeSdkState(input.state || call.status);
      call.updatedAt = new Date().toISOString();
    });
    emitCall(updated, "call:updated");
    return { ok: true, call: publicCall(updated) };
  }

  function updateClientState(user, callId, input = {}) {
    const updated = mutateAccessibleCall(user, callId, (call) => {
      const now = new Date().toISOString();
      const status = normalizeSdkState(input.state || input.status);
      if (status) call.status = status;
      if (status === "ringing" && !call.ringingAt) call.ringingAt = now;
      if (["active", "answered"].includes(status) && !call.answeredAt) call.answeredAt = now;
      if (["ended", "completed", "destroyed", "hangup", "failed"].includes(status)) {
        call.endedAt = call.endedAt || now;
        call.durationSeconds = computeDuration(call);
      }
      call.cause = clean(input.cause || call.cause);
      call.sipCode = Number(input.sipCode || call.sipCode || 0) || 0;
      call.lastEventAt = now;
      call.updatedAt = now;
      pushEvent(call, `client.${status || "update"}`, input);
    });
    emitCall(updated, "call:updated");
    return { ok: true, call: publicCall(updated) };
  }

  async function hangupCall(user, callId) {
    const accessible =
      findAccessibleCall(
        user,
        callId
      );

    const status =
      normalizeSdkState(
        accessible.status
      );

    if (
      [
        "ended",
        "completed",
        "destroyed",
        "hangup",
        "failed",
      ].includes(status)
    ) {
      return {
        ok: true,
        alreadyEnded: true,
        commandSent: false,
        call:
          publicCall(
            accessible
          ),
      };
    }

    const callControlId =
      clean(
        accessible.callControlId
      );

    if (!callControlId) {
      throw httpError(
        409,
        "The Telnyx call-control ID is not available yet. The browser hangup is still the primary termination path."
      );
    }

    await telnyxRequest(
      `/calls/${encodeURIComponent(
        callControlId
      )}/actions/hangup`,
      {
        method: "POST",
        body: {
          command_id:
            crypto.randomUUID(),
        },
      }
    );

    const updated =
      mutateAccessibleCall(
        user,
        callId,
        (call) => {
          const now =
            new Date().toISOString();

          call.status =
            "ending";

          call.hangupRequestedAt =
            now;

          call.hangupRequestedBy =
            user.id;

          call.updatedAt =
            now;

          call.lastEventAt =
            now;

          pushEvent(
            call,
            "server.hangup_requested",
            {
              callControlId:
                call.callControlId,
            }
          );
        }
      );

    emitCall(
      updated,
      "call:updated"
    );

    return {
      ok: true,
      commandSent: true,
      call:
        publicCall(updated),
    };
  }

  async function sendDtmf(
    user,
    callId,
    input = {}
  ) {
    const accessible =
      findAccessibleCall(
        user,
        callId
      );

    const digits =
      clean(
        input.digits ||
          input.digit
      );

    if (
      !digits ||
      !/^[0-9A-D*#wW]+$/.test(
        digits
      )
    ) {
      throw httpError(
        400,
        "DTMF digits may contain only 0-9, A-D, *, #, w, or W."
      );
    }

    const status =
      normalizeSdkState(
        accessible.status
      );

    if (
      ![
        "active",
        "answered",
        "held",
        "recording",
      ].includes(status)
    ) {
      throw httpError(
        409,
        "DTMF can only be sent after the call is answered."
      );
    }

    const callControlId =
      clean(
        accessible.callControlId
      );

    if (!callControlId) {
      throw httpError(
        409,
        "The Telnyx call-control ID is not available yet."
      );
    }

    const durationMillis =
      Math.min(
        500,
        Math.max(
          100,
          Number(
            input.durationMillis ||
              input.duration_millis ||
              250
          ) || 250
        )
      );

    await telnyxRequest(
      `/calls/${encodeURIComponent(
        callControlId
      )}/actions/send_dtmf`,
      {
        method: "POST",
        body: {
          digits,
          duration_millis:
            durationMillis,
          command_id:
            crypto.randomUUID(),
        },
      }
    );

    const updated =
      mutateAccessibleCall(
        user,
        callId,
        (call) => {
          const now =
            new Date().toISOString();

          call.updatedAt =
            now;

          call.lastEventAt =
            now;

          pushEvent(
            call,
            "server.dtmf_sent",
            {
              digits,
              durationMillis,
            }
          );
        }
      );

    emitCall(
      updated,
      "call:updated"
    );

    return {
      ok: true,
      digits,
      call:
        publicCall(updated),
    };
  }

  function completeCall(user, callId, input = {}) {
    const updated = mutateAccessibleCall(user, callId, (call) => {
      const now = new Date().toISOString();
      call.status = clean(input.status || "completed");
      call.outcome = clean(input.outcome || input.disposition || call.outcome);
      call.disposition = clean(input.disposition || input.outcome || call.disposition);
      call.notes = clean(input.notes || call.notes).slice(0, 5000);
      call.endedAt = call.endedAt || now;
      call.durationSeconds = Number(input.durationSeconds || computeDuration(call));
      call.updatedAt = now;
      call.lastEventAt = now;
      pushEvent(call, "call.completed", input);
    });

    updateLeadFromCall(updated);
    emitCall(updated, "call:completed");
    return { ok: true, call: publicCall(updated) };
  }

  function listCalls(user, query = {}) {
    const state = store.read();
    const ctx = context(user, state);
    const role = normalizeRole(ctx.role);
    const limit = Math.min(500, Math.max(1, Number(query.limit || 100)));

    const calls = (state.calls || [])
      .filter((call) => call.workspaceId === ctx.workspaceId)
      .filter((call) => role !== "caller" || call.callerUserId === user.id)
      .filter((call) => !query.leadId || call.leadId === query.leadId)
      .filter((call) => !query.assignmentId || call.assignmentId === query.assignmentId)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(0, limit)
      .map(publicCall);

    return { ok: true, calls };
  }

  function getCall(user, callId) {
    const call = findAccessibleCall(user, callId);
    return { ok: true, call: publicCall(call) };
  }

  function getRecording(user, callId) {
    const call = findAccessibleCall(user, callId);
    if (!call.recordingFilePath || !fs.existsSync(call.recordingFilePath)) {
      throw httpError(404, "Call recording is not available yet.");
    }
    return {
      call,
      filePath: call.recordingFilePath,
      mimeType: call.recordingMimeType || mimeForPath(call.recordingFilePath),
      filename: path.basename(call.recordingFilePath),
    };
  }

  async function handleWebhook({ rawBody, headers, body }) {
    verifyWebhook(rawBody, headers);
    const event = body?.data || body;
    const eventId = clean(event?.id);
    const eventType = clean(event?.event_type);
    const payload = event?.payload || {};
    const occurredAt = clean(event?.occurred_at) || new Date().toISOString();

    if (!eventId || !eventType) return { ok: true, ignored: true };

    const state = store.read();
    if ((state.telnyxWebhookEvents || []).some((item) => item.id === eventId)) {
      return { ok: true, duplicate: true };
    }

    let call = findCallForWebhook(state, payload);
    if (!call) {
      store.update((draft) => {
        ensureState(draft);
        draft.telnyxWebhookEvents.unshift({ id: eventId, eventType, occurredAt });
        draft.telnyxWebhookEvents = draft.telnyxWebhookEvents.slice(0, 5000);
      });
      return { ok: true, unmatched: true };
    }

    store.update((draft) => {
      ensureState(draft);
      const target = draft.calls.find((item) => item.id === call.id);
      if (!target) return;

      target.providerCallId = clean(payload.call_leg_id || target.providerCallId);
      target.callControlId = clean(payload.call_control_id || target.callControlId);
      target.callSessionId = clean(payload.call_session_id || target.callSessionId);
      target.lastEventAt = occurredAt;
      target.updatedAt = new Date().toISOString();

      applyWebhookState(target, eventType, payload, occurredAt);
      pushEvent(target, eventType, { eventId, occurredAt, payload: compactWebhookPayload(payload) });

      draft.telnyxWebhookEvents.unshift({ id: eventId, eventType, occurredAt, callId: target.id });
      draft.telnyxWebhookEvents = draft.telnyxWebhookEvents.slice(0, 5000);
      call = { ...target };
    });

    if (eventType === "call.answered" && call.recordingRequested && call.callControlId) {
      await startRecording(call).catch((error) => saveRecordingError(call.id, error));
    }

    if (eventType === "call.recording.saved") {
      setImmediate(() => {
        ingestRecording(call.id, payload).catch((error) =>
          saveRecordingError(call.id, error)
        );
      });
    }

    if (["call.hangup", "call.machine.detection.ended"].includes(eventType)) {
      updateLeadFromCall(call);
    }

    emitCall(call, "call:updated");
    return { ok: true, eventType, callId: call.id };
  }

  async function startRecording(call) {
    await telnyxRequest(
      `/calls/${encodeURIComponent(call.callControlId)}/actions/record_start`,
      {
        method: "POST",
        body: {
          channels: recordingChannels,
          format: recordingFormat,
        },
      }
    );

    store.update((draft) => {
      const target = (draft.calls || []).find((item) => item.id === call.id);
      if (!target) return;
      target.recordingStatus = "recording";
      target.status = target.status === "answered" ? "active" : target.status;
      target.updatedAt = new Date().toISOString();
    });
  }

  async function ingestRecording(callId, payload) {
    const urls = payload.recording_urls || payload.recording_url || {};
    const remoteUrl = clean(
      (recordingFormat === "mp3" ? urls.mp3 : urls.wav) ||
        urls.mp3 ||
        urls.wav ||
        (typeof urls === "string" ? urls : "")
    );
    if (!remoteUrl) throw new Error("Telnyx recording webhook did not include a recording URL.");

    const response = await fetch(remoteUrl, { headers: { Accept: "audio/*" } });
    if (!response.ok || !response.body) {
      throw new Error(`Recording download failed with HTTP ${response.status}.`);
    }

    const extension = recordingFormat === "wav" ? "wav" : "mp3";
    const filePath = path.join(recordingDirectory, `${sanitize(callId)}.${extension}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > recordingMaxBytes) {
        throw new Error("Call recording exceeded the configured size limit.");
      }
      chunks.push(Buffer.from(chunk));
    }
    fs.writeFileSync(filePath, Buffer.concat(chunks));

    let updated = null;
    store.update((draft) => {
      const target = (draft.calls || []).find((item) => item.id === callId);
      if (!target) return;
      target.recordingStatus = "saved";
      target.recordingId = clean(payload.recording_id || payload.id);
      target.recordingFilePath = filePath;
      target.recordingMimeType = response.headers.get("content-type") || mimeForPath(filePath);
      target.recordingUrl = `/api/telnyx/recordings/${encodeURIComponent(callId)}`;
      target.recordingSavedAt = new Date().toISOString();
      target.updatedAt = target.recordingSavedAt;
      updated = { ...target };
    });
    if (updated) emitCall(updated, "call:recording-saved");
  }

  function saveRecordingError(callId, error) {
    let updated = null;
    store.update((draft) => {
      const target = (draft.calls || []).find((item) => item.id === callId);
      if (!target) return;
      target.recordingStatus = "failed";
      target.recordingError = clean(error?.message || error).slice(0, 1000);
      target.updatedAt = new Date().toISOString();
      updated = { ...target };
    });
    console.error(`[telnyx] recording failed for ${callId}:`, error?.message || error);
    if (updated) emitCall(updated, "call:recording-failed");
  }

  function verifyWebhook(rawBody, headers = {}) {
    if (!publicKey) {
      if (envFlag("TELNYX_ALLOW_UNSIGNED_WEBHOOKS", false)) return true;
      throw httpError(503, "TELNYX_PUBLIC_KEY is required for webhook verification.");
    }

    const signature = clean(headers["telnyx-signature-ed25519"] || headers["Telnyx-Signature-Ed25519"]);
    const timestamp = clean(headers["telnyx-timestamp"] || headers["Telnyx-Timestamp"]);
    if (!signature || !timestamp) throw httpError(403, "Missing Telnyx webhook signature headers.");

    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
      throw httpError(403, "Telnyx webhook timestamp is outside the allowed tolerance.");
    }

    const message = Buffer.from(`${timestamp}|${rawBody || ""}`);
    const signatureBuffer = Buffer.from(signature, "base64");
    let key = publicKey;
    if (!publicKey.includes("BEGIN PUBLIC KEY")) {
      const der = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey, "base64"),
      ]);
      key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    }

    if (!crypto.verify(null, message, key, signatureBuffer)) {
      throw httpError(403, "Invalid Telnyx webhook signature.");
    }
    return true;
  }

  async function telnyxRequest(endpoint, { method = "GET", body } = {}) {
    assertConfigured();

    const response = await fetch(`${TELNYX_API_BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const telnyxRequestId = clean(
        response.headers.get("x-request-id") ||
          response.headers.get("telnyx-request-id")
      );
      const message = extractTelnyxErrorMessage(payload, response.status);
      const error = httpError(
        response.status >= 500 ? 502 : response.status,
        telnyxRequestId
          ? `${message} Telnyx request ID: ${telnyxRequestId}.`
          : message
      );

      error.code = extractTelnyxErrorCode(payload);
      error.details = {
        provider: "telnyx",
        method,
        endpoint,
        telnyxRequestId,
        errors: normalizeTelnyxErrors(payload),
      };

      console.error("[telnyx] api:error", {
        method,
        endpoint,
        status: response.status,
        telnyxRequestId,
        message,
        errors: error.details.errors,
      });

      throw error;
    }

    return payload;
  }

  function configuredDialerForUser(user, state, ctx) {
    let map = {};
    try { map = JSON.parse(process.env.TELNYX_CALLER_CREDENTIALS_JSON || "{}"); } catch { map = {}; }
    const value = map[user.id] || map[normalizeEmail(user.email)] || null;
    if (!value) return null;
    if (typeof value === "string") {
      return { credentialId: value, fromNumber: chooseFromNumber(user, state, ctx) };
    }
    return {
      credentialId: clean(value.credentialId || value.telephonyCredentialId),
      // Manager/Resource Board assignment is authoritative over legacy env maps.
      fromNumber:
        chooseFromNumber(
          user,
          state,
          ctx
        ) ||
        normalizePhone(
          value.fromNumber ||
            value.callerIdNumber
        ),
      callerIdName: clean(value.callerIdName || user.name),
    };
  }

  function chooseFromNumber(user, state, ctx) {
    /*
     * Resource Board is authoritative. Resolve the freshest stored user instead
     * of relying on the login/session snapshot so a manager's phone assignment
     * takes effect immediately without forcing the caller to sign out/in.
     *
     * Only explicit manual-dialer fields are accepted here. user.phoneNumber
     * may be the employee's personal/contact number and must never silently
     * become the outbound PSTN caller ID.
     */
    const storedUser =
      (state.users || []).find(
        (item) =>
          item.id === user.id
      ) || user;

    const reservedNumbers =
      configuredReservedNumbers();

    const explicit =
      normalizePhone(
        storedUser.telnyxFromNumber ||
          storedUser.dialerNumber ||
          storedUser.assignedPhoneNumber ||
          user.telnyxFromNumber ||
          user.dialerNumber ||
          user.assignedPhoneNumber ||
          ""
      );

    if (
      explicit &&
      !reservedNumbers.has(
        explicit
      )
    ) {
      return explicit;
    }

    if (
      explicit &&
      reservedNumbers.has(
        explicit
      )
    ) {
      console.warn(
        `[telnyx] Ignoring reserved manual caller ID ${explicit} for user ${user.id}.`
      );
    }

    const numbers =
      configuredFromNumbers()
        .filter(
          (number) =>
            !reservedNumbers.has(
              number
            )
        );

    if (!numbers.length) {
      return "";
    }

    const callers =
      listWorkspaceCallers(
        state,
        ctx.workspaceId
      );

    const index =
      Math.max(
        0,
        callers.findIndex(
          (item) =>
            item.id === user.id
        )
      );

    return numbers[
      index % numbers.length
    ];
  }

  function saveDialer({ workspaceId, user, credentialId, sipUsername = "", fromNumber = "", callerIdName = "", source }) {
    const now = new Date().toISOString();
    let result = null;
    store.update((draft) => {
      ensureState(draft);
      let dialer = draft.telnyxDialers.find(
        (item) => item.workspaceId === workspaceId && item.userId === user.id
      );
      const patch = {
        provider: "telnyx",
        workspaceId,
        userId: user.id,
        userEmail: normalizeEmail(user.email),
        credentialId,
        sipUsername,
        fromNumber: normalizePhone(fromNumber),
        callerIdName: callerIdName || user.name || "ReachFly",
        source,
        active: true,
        updatedAt: now,
      };
      if (dialer) Object.assign(dialer, patch);
      else {
        dialer = { id: crypto.randomUUID(), ...patch, createdAt: now };
        draft.telnyxDialers.push(dialer);
      }
      result = { ...dialer };
    });
    return result;
  }

  function findCallForWebhook(state, payload) {
    const calls = state.calls || [];
    const callControlId = clean(payload.call_control_id);
    const callSessionId = clean(payload.call_session_id);
    const callLegId = clean(payload.call_leg_id);
    const customHeaders = Array.isArray(payload.custom_headers) ? payload.custom_headers : [];
    const reachFlyHeader = customHeaders.find((header) => clean(header.name).toLowerCase() === "x-reachfly-call-id");
    const localId = clean(reachFlyHeader?.value || payload.client_state);
    return calls.find((call) =>
      (localId && call.id === localId) ||
      (callControlId && call.callControlId === callControlId) ||
      (callSessionId && call.callSessionId === callSessionId) ||
      (callLegId && call.providerCallId === callLegId)
    );
  }

  function applyWebhookState(call, eventType, payload, occurredAt) {
    if (eventType === "call.initiated") call.status = "initiated";
    if (eventType === "call.ringing") {
      call.status = "ringing";
      call.ringingAt = call.ringingAt || occurredAt;
    }
    if (eventType === "call.answered") {
      call.status = "answered";
      call.answeredAt = call.answeredAt || occurredAt;
    }
    if (eventType === "call.bridged") call.status = "active";
    if (eventType === "call.hangup") {
      call.status = payload.hangup_cause === "normal_clearing" ? "completed" : "ended";
      call.endedAt = call.endedAt || occurredAt;
      call.durationSeconds = computeDuration(call);
      call.hangupCause = clean(payload.hangup_cause);
      call.hangupSource = clean(payload.hangup_source);
      call.sipCode = Number(payload.sip_hangup_cause || 0) || 0;
    }
    if (eventType === "call.recording.saved") call.recordingStatus = "processing";
    if (eventType === "call.recording.error") call.recordingStatus = "failed";
  }

  function updateLeadFromCall(call) {
    if (!call?.leadId) return;
    store.update((draft) => {
      for (const campaign of draft.campaigns || []) {
        const lead = (campaign.leads || []).find((item) => item.id === call.leadId);
        if (!lead) continue;
        lead.callAttempts = Number(lead.callAttempts || 0) + (lead.lastRecordedCallId === call.id ? 0 : 1);
        lead.lastRecordedCallId = call.id;
        lead.lastCallAt = call.endedAt || call.updatedAt || new Date().toISOString();
        lead.lastCallStatus = call.outcome || call.status;
        lead.contacted = Boolean(call.answeredAt) || lead.contacted;
        lead.updatedAt = new Date().toISOString();
        lead.timeline = Array.isArray(lead.timeline) ? lead.timeline : [];
        if (!lead.timeline.some((item) => item.callId === call.id && item.type === "telnyx_call")) {
          lead.timeline.unshift({
            id: crypto.randomUUID(),
            type: "telnyx_call",
            callId: call.id,
            callerUserId: call.callerUserId,
            status: call.status,
            outcome: call.outcome || "",
            durationSeconds: call.durationSeconds || 0,
            recordingUrl: call.recordingUrl || "",
            createdAt: new Date().toISOString(),
          });
        }
        break;
      }
    });
  }

  function findAccessibleCall(user, callId) {
    const state = store.read();
    const ctx = context(user, state);
    const call = (state.calls || []).find((item) => item.id === callId && item.workspaceId === ctx.workspaceId);
    if (!call) throw httpError(404, "Call not found.");
    if (normalizeRole(ctx.role) === "caller" && call.callerUserId !== user.id) {
      throw httpError(403, "You cannot access another caller's call.");
    }
    return call;
  }

  function mutateAccessibleCall(user, callId, mutator) {
    const accessible = findAccessibleCall(user, callId);
    let updated = null;
    store.update((draft) => {
      const call = (draft.calls || []).find((item) => item.id === accessible.id);
      if (!call) return;
      mutator(call);
      updated = { ...call };
    });
    return updated;
  }

  function emitCall(call, event) {
    if (!call?.workspaceId) return;
    emit({ workspaceId: call.workspaceId, event, payload: { call: publicCall(call) } });
  }

  function context(user, state = store.read()) {
    return workspaceService?.getContext?.(user, state) || {
      workspaceId: user.workspaceId || user.id,
      role: user.workspaceRole || user.role || "caller",
      permissions: user.permissions || [],
    };
  }

  function requireCaller(user) {
    const ctx = context(user);
    if (normalizeRole(ctx.role) !== "caller") {
      throw httpError(403, "Caller access is required to use the dialer.");
    }
    return ctx;
  }

  function requireManagerOrOwner(ctx) {
    if (!["owner", "admin", "manager"].includes(normalizeRole(ctx.role))) {
      throw httpError(403, "Manager access is required.");
    }
  }

  async function getConnectionConfiguration() {
    let response;

    try {
      response = await telnyxRequest(
        `/credential_connections/${encodeURIComponent(connectionId)}`
      );
    } catch (error) {
      if ([404, 422].includes(Number(error?.statusCode))) {
        throw httpError(
          422,
          [
            `TELNYX_CREDENTIAL_CONNECTION_ID=${connectionId} is not a usable Telnyx Credential Connection.`,
            error.message,
            "Copy the ID from Voice > SIP Trunking > Credential Connections in the Telnyx portal.",
          ]
            .filter(Boolean)
            .join(" ")
        );
      }

      throw error;
    }

    const connection = response?.data || response || {};

    if (!connection.id) {
      throw httpError(
        502,
        "Telnyx did not return the configured credential connection."
      );
    }

    return connection;
  }

  async function getPhoneNumberAssignment(number) {
    const normalized = normalizePhone(number);
    if (!normalized) return null;

    const response = await telnyxRequest(
      `/phone_numbers?filter[phone_number]=${encodeURIComponent(normalized)}&page[size]=1`
    );
    const records = Array.isArray(response?.data) ? response.data : [];
    return records.find((item) => normalizePhone(item.phone_number) === normalized) || records[0] || null;
  }

  async function validateManualCallerNumber(number) {
    assertConfigured();

    const normalized =
      normalizePhone(number);

    if (!normalized) {
      return {
        ok: true,
        number: "",
        connectionId: "",
        assignedConnectionId: "",
      };
    }

    if (
      configuredReservedNumbers().has(
        normalized
      )
    ) {
      return {
        ok: false,
        number: normalized,
        connectionId,
        assignedConnectionId: "",
        message:
          `${normalized} is reserved for another ReachFly voice channel and cannot be used by the manual caller dialer.`,
      };
    }

    const phoneNumber =
      await getPhoneNumberAssignment(
        normalized
      );

    if (!phoneNumber) {
      return {
        ok: false,
        number: normalized,
        connectionId,
        assignedConnectionId: "",
        message:
          `The Telnyx number ${normalized} was not found in this account.`,
      };
    }

    const assignedConnectionId =
      clean(
        phoneNumber.connection_id
      );

    if (
      assignedConnectionId !==
      clean(connectionId)
    ) {
      return {
        ok: false,
        number: normalized,
        connectionId:
          clean(connectionId),
        assignedConnectionId,
        message:
          assignedConnectionId
            ? `${normalized} belongs to Telnyx connection ${assignedConnectionId}, not the manual caller credential connection ${connectionId}. Choose a manual-calling number instead.`
            : `${normalized} is not assigned to the manual caller credential connection ${connectionId}.`,
      };
    }

    return {
      ok: true,
      number: normalized,
      connectionId:
        clean(connectionId),
      assignedConnectionId,
      status:
        clean(
          phoneNumber.status
        ),
    };
  }

  function configuredReservedNumbers() {
    return new Set(
      String(
        process.env.TELNYX_RESERVED_FROM_NUMBERS ||
          process.env.TELNYX_AI_PHONE_NUMBER ||
          process.env.TELNYX_AI_AGENT_PHONE_NUMBER ||
          process.env.ELEVENLABS_TELNYX_PHONE_NUMBER ||
          ""
      )
        .split(",")
        .map(normalizePhone)
        .filter(Boolean)
    );
  }

  function configuredFromNumbers() {
    return String(process.env.TELNYX_FROM_NUMBERS || process.env.TELNYX_FROM_NUMBER || "")
      .split(",")
      .map(normalizePhone)
      .filter(Boolean);
  }

  function assertConfigured() {
    if (!apiKey) {
      throw httpError(503, "TELNYX_API_KEY is not configured.");
    }

    if (!connectionId) {
      throw httpError(
        503,
        "TELNYX_CREDENTIAL_CONNECTION_ID is not configured. TELNYX_CONNECTION_ID is accepted only as a legacy fallback."
      );
    }
  }

  return {
    diagnostics,
    getBrowserSession,
    ensureCallerDialer,
    validateManualCallerNumber,
    listDialers,
    provisionAllCallers,
    createCall,
    linkCall,
    updateClientState,
    hangupCall,
    sendDtmf,
    completeCall,
    listCalls,
    getCall,
    getRecording,
    handleWebhook,
    recordingDirectory,
  };
}

function ensureState(draft) {
  for (const key of ["calls", "telnyxDialers", "telnyxWebhookEvents"]) {
    draft[key] = Array.isArray(draft[key]) ? draft[key] : [];
  }
}

function listWorkspaceCallers(state, workspaceId) {
  return (state.users || [])
    .filter((item) => item.workspaceId === workspaceId)
    .filter((item) => normalizeRole(item.workspaceRole || item.role) === "caller")
    .filter((item) => item.active !== false && item.isActive !== false)
    .sort((a, b) => normalizeEmail(a.email).localeCompare(normalizeEmail(b.email)));
}

function publicDialer(dialer) {
  return {
    configured: Boolean(dialer?.credentialId),
    provider: "telnyx",
    credentialId: dialer?.credentialId || "",
    fromNumber: dialer?.fromNumber || "",
    callerIdName: dialer?.callerIdName || "",
    active: dialer?.active !== false,
    source: dialer?.source || "",
  };
}

function publicCall(call) {
  const { recordingFilePath, ...safe } = call || {};
  return {
    ...safe,
    hasRecording: Boolean(call?.recordingFilePath || call?.recordingUrl),
  };
}

function pushEvent(call, type, data = {}) {
  call.events = Array.isArray(call.events) ? call.events : [];
  call.events.unshift({
    id: crypto.randomUUID(),
    type,
    occurredAt: clean(data.occurredAt) || new Date().toISOString(),
    ...data,
  });
  call.events = call.events.slice(0, 200);
}

function computeDuration(call) {
  const start = Date.parse(call.answeredAt || call.startedAt || 0);
  const end = Date.parse(call.endedAt || Date.now());
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.round((end - start) / 1000))
    : 0;
}


function compactWebhookPayload(payload) {
  return {
    call_control_id: clean(payload.call_control_id),
    call_session_id: clean(payload.call_session_id),
    call_leg_id: clean(payload.call_leg_id),
    from: clean(payload.from),
    to: clean(payload.to),
    hangup_cause: clean(payload.hangup_cause),
    hangup_source: clean(payload.hangup_source),
    recording_id: clean(payload.recording_id),
  };
}

function normalizeSdkState(value) {
  const state = clean(value).toLowerCase();
  if (["new", "trying"].includes(state)) return "initiated";
  if (["early", "ringing"].includes(state)) return "ringing";
  if (["active", "answered"].includes(state)) return "active";
  if (state === "held") return "held";
  if (["hangup", "destroy", "destroyed", "purge", "ended"].includes(state)) return "ended";
  return state;
}

function normalizeRole(value) {
  const role = clean(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (role.includes("owner")) return "owner";
  if (role.includes("admin")) return "admin";
  if (role.includes("manager")) return "manager";
  if (role.includes("caller")) return "caller";
  return role;
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return `+${digits}`;
}

function extractLoginToken(payload) {
  if (typeof payload === "string") return clean(payload);
  if (typeof payload?.data === "string") return clean(payload.data);
  return clean(
    payload?.data?.token ||
    payload?.token ||
    payload?.data?.login_token ||
    payload?.login_token
  );
}

function getCredentialConnectionId(credential) {
  const direct = clean(credential?.connection_id);
  if (direct) return direct;

  const resourceId = clean(credential?.resource_id);
  const match = /^connection:(.+)$/i.exec(resourceId);
  return clean(match?.[1]);
}

function sanitizeTelnyxTag(value) {
  return clean(value)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 128) || "reachfly";
}

function normalizeTelnyxErrors(payload) {
  if (Array.isArray(payload?.errors)) {
    return payload.errors.map((item) => ({
      code: clean(item?.code),
      title: clean(item?.title),
      detail: clean(item?.detail),
      pointer: clean(item?.source?.pointer),
      parameter: clean(item?.source?.parameter),
    }));
  }

  if (payload?.errors && typeof payload.errors === "object") {
    return Object.entries(payload.errors).map(([key, value]) => ({
      code: clean(key),
      title: "",
      detail:
        typeof value === "string"
          ? clean(value)
          : clean(value?.detail || value?.message || JSON.stringify(value)),
      pointer: "",
      parameter: "",
    }));
  }

  if (payload && typeof payload === "object") {
    const detail = clean(
      payload.detail || payload.message || payload.error || payload.title
    );

    return detail
      ? [
          {
            code: clean(payload.code),
            title: clean(payload.title),
            detail,
            pointer: clean(payload?.source?.pointer),
            parameter: clean(payload?.source?.parameter),
          },
        ]
      : [];
  }

  return typeof payload === "string" && clean(payload)
    ? [
        {
          code: "",
          title: "",
          detail: clean(payload),
          pointer: "",
          parameter: "",
        },
      ]
    : [];
}

function extractTelnyxErrorMessage(payload, status) {
  const errors = normalizeTelnyxErrors(payload);
  const messages = errors
    .map((item) => {
      const base = item.detail || item.title;
      const location = item.pointer || item.parameter;
      return [base, location ? `(${location})` : ""]
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean);

  return messages.length
    ? `Telnyx request failed (${status}): ${messages.join("; ")}`
    : `Telnyx request failed (${status}).`;
}

function extractTelnyxErrorCode(payload) {
  return clean(normalizeTelnyxErrors(payload)[0]?.code);
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function mimeForPath(filePath) {
  return path.extname(filePath).toLowerCase() === ".wav" ? "audio/wav" : "audio/mpeg";
}

function sanitize(value) {
  return clean(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || crypto.randomUUID();
}

function envFlag(name, fallback = false) {
  const value = clean(process.env[name]).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
