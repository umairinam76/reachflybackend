import crypto from "node:crypto";

/**
 * Dynamic business-operations layer used by /app/operations.
 *
 * The frontend chooses niche-specific language (Reservations, Appointments,
 * Viewings, Service Visits, etc). This service keeps the stored record shape
 * generic so the same backend works for every niche.
 */
export function createOperationsService({ store, workspaceService, emit = () => {} } = {}) {
  if (!store?.read || !store?.update) {
    throw new Error("createOperationsService requires the ReachFly store.");
  }

  function context(user) {
    const state = store.read();
    const resolved = workspaceService?.getContext?.(user, state) ||
      workspaceService?.getContext?.(user) || {};

    const workspaceId = clean(
      resolved.workspaceId || user?.workspaceId || user?.companyId || user?.id
    );

    if (!workspaceId) {
      throw httpError(401, "Workspace could not be resolved.");
    }

    return {
      workspaceId,
      userId: clean(user?.id),
      workspace: resolved.workspace || findWorkspace(state, workspaceId) || {},
    };
  }

  function ensureShape(draft) {
    if (!Array.isArray(draft.businessOperations)) {
      draft.businessOperations = [];
    }
  }

  function list(user, options = {}) {
    const ctx = context(user);
    const state = store.read();
    const explicit = (state.businessOperations || [])
      .filter((item) => item?.workspaceId === ctx.workspaceId)
      .map(publicRecord);

    // Voice bookings already created by ReachFly are operational outcomes too.
    // Surface them immediately without requiring a migration or duplicate write.
    const meetings = (state.telnyxAiAgentMeetings || [])
      .filter((item) => item?.workspaceId === ctx.workspaceId)
      .map(meetingToOperation);

    const callsById = new Map(
      (state.telnyxAiAgentCalls || [])
        .filter((item) => item?.workspaceId === ctx.workspaceId)
        .map((item) => [item.id, item])
    );

    const linkedCalendarBookings = (state.workspaceConnectionActivity || [])
      .filter(
        (item) =>
          item?.workspaceId === ctx.workspaceId &&
          item?.type === "agent_calendar_event_created"
      )
      .map((item) =>
        connectionActivityToOperation(item, callsById.get(item.callId))
      );

    const map = new Map();
    for (const item of [...explicit, ...meetings, ...linkedCalendarBookings]) {
      if (!item?.id) continue;
      map.set(item.id, {
        ...(map.get(item.id) || {}),
        ...item,
      });
    }

    let records = [...map.values()].sort(sortByStart);

    const status = normalizeStatus(options.status);
    if (status && status !== "all") {
      records = records.filter(
        (item) => normalizeStatus(item.status) === status
      );
    }

    const search = clean(options.search).toLowerCase();
    if (search) {
      records = records.filter((item) =>
        [
          item.customerName,
          item.company,
          item.phone,
          item.email,
          item.service,
          item.location,
          item.notes,
          item.source,
          item.channel,
          item.status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(search)
      );
    }

    const limit = clampInteger(options.limit, 500, 1, 5000);
    const offset = clampInteger(options.offset, 0, 0, records.length);
    const items = records.slice(offset, offset + limit);

    return {
      ok: true,
      source: "reachfly-operations",
      workspace: {
        id: ctx.workspaceId,
        name:
          clean(ctx.workspace?.name || ctx.workspace?.companyName) ||
          clean(user?.companyName || user?.name),
        niche: clean(
          ctx.workspace?.niche ||
            ctx.workspace?.industry ||
            ctx.workspace?.businessType ||
            user?.niche ||
            user?.industry ||
            user?.businessType ||
            user?.companyIndustry
        ),
        industry: clean(ctx.workspace?.industry || user?.industry),
        businessType: clean(
          ctx.workspace?.businessType || user?.businessType
        ),
      },
      total: records.length,
      offset,
      limit,
      hasMore: offset + items.length < records.length,
      records: items,
      operations: items,
    };
  }

  function create(user, payload = {}) {
    const ctx = context(user);
    const now = new Date().toISOString();
    const startAt = normalizeDate(payload.startAt || payload.start_at || payload.dateTime);

    if (!startAt) {
      throw httpError(400, "A valid operation start date and time is required.");
    }

    const record = normalizeRecord({
      ...payload,
      id: clean(payload.id) || `op_${crypto.randomUUID()}`,
      workspaceId: ctx.workspaceId,
      createdBy: ctx.userId,
      startAt,
      createdAt: now,
      updatedAt: now,
    });

    store.update((draft) => {
      ensureShape(draft);
      draft.businessOperations.unshift(record);
    });

    safeEmit(ctx.workspaceId, "operations:created", {
      record: publicRecord(record),
    });

    return {
      ok: true,
      record: publicRecord(record),
    };
  }

  function update(user, id, patch = {}) {
    const ctx = context(user);
    const operationId = clean(id);
    let updated = null;

    store.update((draft) => {
      ensureShape(draft);
      const target = draft.businessOperations.find(
        (item) => item.id === operationId && item.workspaceId === ctx.workspaceId
      );

      if (target) {
        const next = normalizeRecord({
          ...target,
          ...patch,
          id: target.id,
          workspaceId: target.workspaceId,
          createdAt: target.createdAt,
          updatedAt: new Date().toISOString(),
        });

        Object.assign(target, next);
        updated = { ...target };
        return;
      }

      // Meetings are also exposed as operations. Allow status/notes changes on
      // those records so a restaurant can mark a reservation completed or a
      // clinic can mark an appointment cancelled without duplicating it.
      const meeting = (draft.telnyxAiAgentMeetings || []).find(
        (item) => item.id === operationId && item.workspaceId === ctx.workspaceId
      );

      if (meeting) {
        if (patch.status != null) {
          meeting.status = normalizeStatus(patch.status) || meeting.status;
        }
        if (patch.notes != null) {
          meeting.notes = clean(patch.notes).slice(0, 5000);
        }
        if (patch.startAt || patch.start_at) {
          const nextStart = normalizeDate(patch.startAt || patch.start_at);
          if (nextStart) meeting.startAt = nextStart;
        }
        meeting.updatedAt = new Date().toISOString();
        updated = meetingToOperation(meeting);
      }
    });

    if (!updated) {
      throw httpError(404, "Operation record not found.");
    }

    safeEmit(ctx.workspaceId, "operations:updated", {
      record: publicRecord(updated),
    });

    return {
      ok: true,
      record: publicRecord(updated),
    };
  }

  function recordVoiceBooking({ callId = "", body = {}, booking = {} } = {}) {
    const state = store.read();
    const resolvedCallId = clean(
      callId ||
        body.reachfly_call_id ||
        body.reachflyCallId ||
        body.call_id ||
        body.callId
    );

    const call = (state.telnyxAiAgentCalls || []).find(
      (item) => item?.id === resolvedCallId
    );

    if (!call?.workspaceId) {
      return { ok: false, recorded: false, reason: "call_not_found" };
    }

    const context = call.contextSnapshot || {};
    const providerId = clean(
      booking.eventId || booking.id || booking.event_id
    );
    const id = providerId
      ? `op_booking_${providerId}`
      : `op_call_${call.id}_${Date.parse(booking.startAt || body.start || body.startAt || Date.now()) || Date.now()}`;
    const now = new Date().toISOString();

    const record = normalizeRecord({
      id,
      workspaceId: call.workspaceId,
      createdBy: call.agentId || "voice-agent",
      operationType:
        body.operationType ||
        body.operation_type ||
        body.bookingType ||
        body.booking_type ||
        "booking",
      customerName:
        body.attendeeName ||
        body.attendee_name ||
        call.leadName ||
        context.contactName ||
        context.name ||
        context.business,
      company: context.business || context.company || call.leadName,
      phone:
        body.attendeePhone ||
        body.attendee_phone ||
        context.phone ||
        call.toNumber,
      email:
        booking.attendeeEmail ||
        body.attendeeEmail ||
        body.attendee_email ||
        context.email,
      startAt:
        booking.startAt ||
        body.start ||
        body.startAt ||
        body.confirmedStart ||
        body.proposed_start,
      endAt: booking.endAt || body.end || body.endAt,
      service:
        body.service ||
        body.serviceType ||
        body.service_type ||
        body.title ||
        context.service ||
        "Booked service",
      provider: booking.provider || "Google Calendar",
      partySize: body.partySize || body.party_size,
      location:
        body.location ||
        body.meetingLocation ||
        body.meeting_location ||
        context.location ||
        context.address,
      notes:
        body.notes ||
        body.description ||
        context.privateContext ||
        context.notes,
      status: "confirmed",
      source: booking.provider || "google-calendar",
      channel: "voice",
      campaignId: call.campaignId,
      leadId: call.leadId,
      callId: call.id,
      queueId: call.queueId,
      createdAt: now,
      updatedAt: now,
    });

    let recorded = false;
    let output = record;

    store.update((draft) => {
      ensureShape(draft);
      const existing = draft.businessOperations.find(
        (item) => item.id === id && item.workspaceId === call.workspaceId
      );

      if (existing) {
        Object.assign(existing, {
          ...existing,
          ...record,
          createdAt: existing.createdAt || record.createdAt,
          updatedAt: now,
        });
        output = { ...existing };
        return;
      }

      draft.businessOperations.unshift(record);
      recorded = true;
    });

    safeEmit(call.workspaceId, recorded ? "operations:created" : "operations:updated", {
      record: publicRecord(output),
    });

    return {
      ok: true,
      recorded: true,
      created: recorded,
      record: publicRecord(output),
    };
  }

  function safeEmit(workspaceId, event, payload) {
    try {
      emit({ workspaceId, event, payload });
    } catch {
      // Socket delivery must never make an operational write fail.
    }
  }

  return {
    list,
    create,
    update,
    recordVoiceBooking,
  };
}

function connectionActivityToOperation(activity = {}, call = {}) {
  const context = call?.contextSnapshot || {};

  return {
    id: clean(activity.eventId)
      ? `gcal_${clean(activity.eventId)}`
      : `gcal_activity_${clean(activity.id)}`,
    operationType: "meeting",
    customerName: clean(
      call?.leadName ||
        context?.contactName ||
        context?.name ||
        context?.business
    ),
    company: clean(context?.business || context?.company || call?.leadName),
    phone: clean(context?.phone || call?.toNumber),
    email: clean(activity.attendeeEmail || context?.email),
    startAt: normalizeDate(activity.startAt || activity.createdAt),
    endAt: "",
    service: clean(context?.service || context?.campaignName || "Booked meeting"),
    provider: "Google Calendar",
    partySize: 0,
    location: clean(context?.location || context?.address),
    notes: clean(context?.privateContext || context?.notes),
    status: "confirmed",
    source: "google-calendar",
    channel: "voice",
    campaignId: clean(call?.campaignId),
    leadId: clean(call?.leadId),
    callId: clean(activity.callId || call?.id),
    queueId: clean(call?.queueId),
    createdAt: normalizeDate(activity.createdAt) || clean(activity.createdAt),
    updatedAt: normalizeDate(activity.createdAt) || clean(activity.createdAt),
  };
}

function meetingToOperation(meeting = {}) {
  return {
    id: clean(meeting.id),
    workspaceId: clean(meeting.workspaceId),
    operationType: clean(meeting.operationType || meeting.bookingType || "meeting"),
    customerName: clean(
      meeting.customerName || meeting.attendeeName || meeting.leadName
    ),
    company: clean(meeting.company || meeting.business),
    phone: clean(meeting.phone || meeting.attendeePhone),
    email: clean(meeting.email || meeting.attendeeEmail),
    startAt: normalizeDate(meeting.startAt),
    endAt: normalizeDate(meeting.endAt),
    service: clean(
      meeting.service || meeting.calendlyEventTypeName || meeting.meetingType
    ),
    provider: clean(meeting.provider || meeting.agentName),
    partySize: positiveInteger(meeting.partySize || meeting.party_size),
    location: clean(meeting.location || meeting.meetingLocation),
    notes: clean(meeting.notes),
    status: normalizeStatus(meeting.status || "confirmed"),
    source: clean(meeting.source || "reachfly-ai-voice"),
    channel: clean(meeting.channel || "voice"),
    campaignId: clean(meeting.campaignId),
    leadId: clean(meeting.leadId),
    callId: clean(meeting.callId),
    queueId: clean(meeting.queueId),
    createdAt: normalizeDate(meeting.createdAt) || clean(meeting.createdAt),
    updatedAt: normalizeDate(meeting.updatedAt) || clean(meeting.updatedAt),
  };
}

function normalizeRecord(value = {}) {
  return {
    id: clean(value.id),
    workspaceId: clean(value.workspaceId),
    createdBy: clean(value.createdBy),
    operationType: clean(value.operationType || value.type || "booking"),
    customerName: clean(value.customerName || value.attendeeName || value.leadName),
    company: clean(value.company || value.business),
    phone: clean(value.phone || value.attendeePhone),
    email: clean(value.email || value.attendeeEmail).toLowerCase(),
    startAt: normalizeDate(value.startAt),
    endAt: normalizeDate(value.endAt),
    service: clean(value.service || value.serviceType || value.meetingType),
    provider: clean(value.provider),
    partySize: positiveInteger(value.partySize || value.party_size),
    location: clean(value.location),
    notes: clean(value.notes).slice(0, 5000),
    status: normalizeStatus(value.status || "confirmed"),
    source: clean(value.source || "reachfly"),
    channel: clean(value.channel || "workspace"),
    campaignId: clean(value.campaignId),
    leadId: clean(value.leadId),
    callId: clean(value.callId),
    queueId: clean(value.queueId),
    createdAt: clean(value.createdAt) || new Date().toISOString(),
    updatedAt: clean(value.updatedAt) || new Date().toISOString(),
  };
}

function publicRecord(record = {}) {
  const output = { ...record };
  delete output.workspaceId;
  delete output.createdBy;
  return output;
}

function findWorkspace(state, workspaceId) {
  return (
    (state.workspaces || []).find((item) => item?.id === workspaceId) ||
    state.workspaceSettings?.[workspaceId] ||
    null
  );
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeStatus(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function sortByStart(left, right) {
  const a = Date.parse(left?.startAt || left?.createdAt || 0) || 0;
  const b = Date.parse(right?.startAt || right?.createdAt || 0) || 0;
  return a - b;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  return error;
}
