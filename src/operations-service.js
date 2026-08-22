import crypto from "node:crypto";

/**
 * ReachFly dynamic business-operations service.
 *
 * One workspace-safe record model powers niche-specific outcomes such as:
 * - restaurant reservations and orders
 * - clinic / salon appointments
 * - property viewings
 * - hotel reservations
 * - service visits / consultations
 *
 * Voice-created records retain the originating AI agent, call, direction,
 * campaign and lead so the UI can show the complete journey instead of a
 * disconnected booking table.
 */
export function createOperationsService({ store, workspaceService, emit = () => {} } = {}) {
  if (!store?.read || !store?.update) {
    throw new Error("createOperationsService requires the ReachFly store.");
  }

  function context(user) {
    const state = store.read();
    const resolved =
      workspaceService?.getContext?.(user, state) ||
      workspaceService?.getContext?.(user) ||
      {};

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
    const agentsById = new Map(
      (state.telnyxAiAgents || [])
        .filter((item) => item?.workspaceId === ctx.workspaceId)
        .map((item) => [clean(item.id), item])
    );

    const explicit = (state.businessOperations || [])
      .filter((item) => item?.workspaceId === ctx.workspaceId)
      .map((item) => decorateAgent(publicRecord(item), agentsById));

    // Voice bookings are operational outcomes too. Surface them immediately
    // without requiring a migration or duplicate write.
    const meetings = (state.telnyxAiAgentMeetings || [])
      .filter((item) => item?.workspaceId === ctx.workspaceId)
      .map((item) => decorateAgent(meetingToOperation(item), agentsById));

    const callsById = new Map(
      (state.telnyxAiAgentCalls || [])
        .filter((item) => item?.workspaceId === ctx.workspaceId)
        .map((item) => [clean(item.id), item])
    );

    const linkedCalendarBookings = (state.workspaceConnectionActivity || [])
      .filter(
        (item) =>
          item?.workspaceId === ctx.workspaceId &&
          item?.type === "agent_calendar_event_created"
      )
      .map((item) =>
        decorateAgent(
          connectionActivityToOperation(item, callsById.get(clean(item.callId))),
          agentsById
        )
      );

    // De-dupe across explicit operational writes, Telnyx/ElevenLabs meeting
    // records and linked-calendar activity. Prefer the explicit operation
    // because it carries the richest order/fulfilment metadata.
    const map = new Map();
    for (const item of [...linkedCalendarBookings, ...meetings, ...explicit]) {
      if (!item?.id) continue;
      const key = operationIdentity(item);
      const current = map.get(key) || {};
      map.set(key, mergeOperation(current, item));
    }

    let records = [...map.values()].sort(sortByStart);

    const status = normalizeStatus(options.status);
    if (status && status !== "all") {
      records = records.filter((item) => normalizeStatus(item.status) === status);
    }

    const direction = normalizeDirection(options.direction);
    if (direction) {
      records = records.filter(
        (item) => normalizeDirection(item.direction) === direction
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
          item.operationType,
          item.agentName,
          ...(item.items || []).flatMap((row) => [row.name, row.instructions]),
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
        businessType: clean(ctx.workspace?.businessType || user?.businessType),
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
    const operationType = clean(payload.operationType || payload.type || "booking");
    const isOrder = isOrderOperation({ ...payload, operationType });
    const startAt =
      normalizeDate(payload.startAt || payload.start_at || payload.dateTime) ||
      (isOrder ? now : "");

    if (!startAt) {
      throw httpError(400, "A valid operation start date and time is required.");
    }

    const record = normalizeRecord({
      ...payload,
      operationType,
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
          createdBy: target.createdBy,
          createdAt: target.createdAt,
          updatedAt: new Date().toISOString(),
        });

        Object.assign(target, next);
        updated = { ...target };
        return;
      }

      // Meetings are also exposed as operations. Allow safe operational edits
      // without creating a duplicate businessOperations record.
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
        if (patch.endAt || patch.end_at) {
          const nextEnd = normalizeDate(patch.endAt || patch.end_at);
          if (nextEnd) meeting.endAt = nextEnd;
        }
        if (patch.service != null) {
          meeting.service = clean(patch.service).slice(0, 500);
        }
        if (patch.location != null) {
          meeting.location = clean(patch.location).slice(0, 1000);
        }
        if (patch.partySize != null || patch.party_size != null) {
          meeting.partySize = positiveInteger(patch.partySize || patch.party_size);
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

  /**
   * Upsert a booking/reservation/appointment created by an AI voice call.
   * Existing server routes can keep using this method unchanged.
   */
  function recordVoiceBooking({ callId = "", body = {}, booking = {} } = {}) {
    return recordVoiceOperation({
      callId,
      body,
      operation: booking,
      defaultOperationType: "booking",
      defaultStatus: "confirmed",
      defaultSource: booking.provider || "reachfly-ai-voice",
    });
  }

  /**
   * Upsert an order captured during a voice call. The id is stable for a call
   * (or explicit operation/order id), so draft -> confirmed -> fulfilled
   * updates mutate the same operational record.
   */
  function recordVoiceOrder({ callId = "", body = {}, order = {} } = {}) {
    return recordVoiceOperation({
      callId,
      body,
      operation: order,
      defaultOperationType: "order",
      defaultStatus: normalizeStatus(order.status || body.status || "draft") || "draft",
      defaultSource: order.provider || "reachfly-ai-voice",
    });
  }

  function recordVoiceOperation({
    callId = "",
    body = {},
    operation = {},
    defaultOperationType = "booking",
    defaultStatus = "confirmed",
    defaultSource = "reachfly-ai-voice",
  } = {}) {
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
    const agent = (state.telnyxAiAgents || []).find(
      (item) =>
        item?.workspaceId === call.workspaceId &&
        clean(item.id) === clean(call.agentId)
    );

    const operationType = clean(
      operation.operationType ||
        operation.operation_type ||
        operation.type ||
        body.operationType ||
        body.operation_type ||
        body.bookingType ||
        body.booking_type ||
        defaultOperationType
    ) || defaultOperationType;

    const providerId = clean(
      operation.operationId ||
        operation.operation_id ||
        operation.orderId ||
        operation.order_id ||
        operation.eventId ||
        operation.event_id ||
        operation.id ||
        body.operationId ||
        body.operation_id ||
        body.orderId ||
        body.order_id
    );

    const id = stableVoiceOperationId({
      callId: call.id,
      operationType,
      providerId,
    });
    const now = new Date().toISOString();

    const rawItems =
      operation.items ||
      operation.orderItems ||
      operation.lineItems ||
      body.items ||
      body.orderItems ||
      body.order_items ||
      body.lineItems ||
      body.line_items ||
      [];
    const items = normalizeOrderItems(rawItems);
    const calculatedTotal = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const explicitTotal = finiteMoney(
      operation.total ??
        operation.orderTotal ??
        operation.amount ??
        body.total ??
        body.orderTotal ??
        body.order_total ??
        body.amount
    );

    const record = normalizeRecord({
      id,
      workspaceId: call.workspaceId,
      createdBy: call.agentId || "voice-agent",
      operationType,
      customerName:
        body.attendeeName ||
        body.attendee_name ||
        body.customerName ||
        body.customer_name ||
        operation.customerName ||
        operation.customer_name ||
        call.leadName ||
        context.contactName ||
        context.name ||
        context.business,
      company:
        operation.company ||
        body.company ||
        context.business ||
        context.company ||
        call.leadName,
      phone:
        body.attendeePhone ||
        body.attendee_phone ||
        body.customerPhone ||
        body.customer_phone ||
        operation.phone ||
        operation.customerPhone ||
        context.phone ||
        call.toNumber ||
        call.fromNumber,
      email:
        operation.attendeeEmail ||
        operation.customerEmail ||
        operation.email ||
        body.attendeeEmail ||
        body.attendee_email ||
        body.customerEmail ||
        body.customer_email ||
        context.email,
      startAt:
        operation.startAt ||
        operation.start_at ||
        body.start ||
        body.startAt ||
        body.start_at ||
        body.confirmedStart ||
        body.confirmed_start ||
        body.proposed_start ||
        (isOrderOperation({ operationType, items }) ? now : ""),
      endAt:
        operation.endAt ||
        operation.end_at ||
        body.end ||
        body.endAt ||
        body.end_at,
      service:
        operation.service ||
        operation.serviceType ||
        operation.service_type ||
        operation.title ||
        body.service ||
        body.serviceType ||
        body.service_type ||
        body.title ||
        context.service ||
        (isOrderOperation({ operationType, items }) ? "Customer order" : "Booked service"),
      provider: clean(operation.provider || body.provider || defaultSource),
      partySize:
        operation.partySize ||
        operation.party_size ||
        body.partySize ||
        body.party_size,
      location:
        operation.location ||
        body.location ||
        body.meetingLocation ||
        body.meeting_location ||
        body.deliveryAddress ||
        body.delivery_address ||
        context.location ||
        context.address,
      notes:
        operation.notes ||
        operation.description ||
        body.notes ||
        body.description ||
        body.specialInstructions ||
        body.special_instructions ||
        context.privateContext ||
        context.notes,
      status:
        operation.status ||
        operation.orderStatus ||
        operation.order_status ||
        body.status ||
        body.orderStatus ||
        body.order_status ||
        defaultStatus,
      source: operation.source || body.source || defaultSource,
      channel: operation.channel || body.channel || "voice",
      direction: normalizeDirection(call.direction) || "outbound",
      campaignId: call.campaignId,
      leadId: call.leadId,
      callId: call.id,
      queueId: call.queueId,
      agentId: call.agentId,
      agentName: clean(
        operation.agentName ||
          body.agentName ||
          agent?.name ||
          agent?.agentName ||
          call.agentName ||
          "ReachFly AI"
      ),
      items,
      total: explicitTotal != null ? explicitTotal : calculatedTotal,
      currency:
        operation.currency ||
        body.currency ||
        context.currency ||
        "",
      fulfillmentType:
        operation.fulfillmentType ||
        operation.fulfillment_type ||
        body.fulfillmentType ||
        body.fulfillment_type ||
        body.orderType ||
        body.order_type,
      fulfillmentStatus:
        operation.fulfillmentStatus ||
        operation.fulfillment_status ||
        body.fulfillmentStatus ||
        body.fulfillment_status,
      confirmationCode:
        operation.confirmationCode ||
        operation.confirmation_code ||
        body.confirmationCode ||
        body.confirmation_code,
      providerRecordId: providerId,
      createdAt: now,
      updatedAt: now,
    });

    let created = false;
    let output = record;

    store.update((draft) => {
      ensureShape(draft);
      const existing = draft.businessOperations.find(
        (item) => item.id === id && item.workspaceId === call.workspaceId
      );

      if (existing) {
        const merged = normalizeRecord({
          ...existing,
          ...record,
          items: record.items.length ? record.items : existing.items,
          total:
            record.items.length || record.total > 0
              ? record.total
              : existing.total,
          createdAt: existing.createdAt || record.createdAt,
          updatedAt: now,
        });
        Object.assign(existing, merged);
        output = { ...existing };
        return;
      }

      draft.businessOperations.unshift(record);
      created = true;
    });

    safeEmit(
      call.workspaceId,
      created ? "operations:created" : "operations:updated",
      { record: publicRecord(output) }
    );

    return {
      ok: true,
      recorded: true,
      created,
      record: publicRecord(output),
    };
  }

  /**
   * Workspace-safe customer memory used by the voice layer when it needs to
   * provide recent business outcomes for the current caller.
   */
  function getCustomerMemoryForCall({ callId = "", limit = 20 } = {}) {
    const state = store.read();
    const call = (state.telnyxAiAgentCalls || []).find(
      (item) => item?.id === clean(callId)
    );

    if (!call?.workspaceId) {
      return { ok: false, records: [], reason: "call_not_found" };
    }

    const context = call.contextSnapshot || {};
    const phones = new Set(
      [call.toNumber, call.fromNumber, context.phone]
        .map(normalizePhoneKey)
        .filter(Boolean)
    );
    const emails = new Set(
      [context.email]
        .map((value) => clean(value).toLowerCase())
        .filter(Boolean)
    );

    const records = (state.businessOperations || [])
      .filter((item) => item?.workspaceId === call.workspaceId)
      .filter((item) => {
        const phone = normalizePhoneKey(item.phone);
        const email = clean(item.email).toLowerCase();
        return (phone && phones.has(phone)) || (email && emails.has(email));
      })
      .sort(sortNewest)
      .slice(0, clampInteger(limit, 20, 1, 100))
      .map(publicRecord);

    return { ok: true, records };
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
    recordVoiceOrder,
    recordVoiceOperation,
    getCustomerMemoryForCall,
  };
}

function connectionActivityToOperation(activity = {}, call = {}) {
  const context = call?.contextSnapshot || {};

  return normalizeRecord({
    id: clean(activity.eventId)
      ? `gcal_${clean(activity.eventId)}`
      : `gcal_activity_${clean(activity.id)}`,
    workspaceId: clean(activity.workspaceId || call?.workspaceId),
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
    direction: normalizeDirection(call?.direction) || "outbound",
    campaignId: clean(call?.campaignId),
    leadId: clean(call?.leadId),
    callId: clean(activity.callId || call?.id),
    queueId: clean(call?.queueId),
    agentId: clean(call?.agentId),
    agentName: clean(call?.agentName),
    providerRecordId: clean(activity.eventId),
    createdAt: normalizeDate(activity.createdAt) || clean(activity.createdAt),
    updatedAt: normalizeDate(activity.createdAt) || clean(activity.createdAt),
  });
}

function meetingToOperation(meeting = {}) {
  return normalizeRecord({
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
    direction: normalizeDirection(meeting.direction) || "outbound",
    campaignId: clean(meeting.campaignId),
    leadId: clean(meeting.leadId),
    callId: clean(meeting.callId),
    queueId: clean(meeting.queueId),
    agentId: clean(meeting.agentId),
    agentName: clean(meeting.agentName),
    confirmationCode: clean(
      meeting.confirmationCode || meeting.calendlyInviteeUri || ""
    ),
    providerRecordId: clean(
      meeting.providerRecordId || meeting.calendlyEventUri || ""
    ),
    createdAt: normalizeDate(meeting.createdAt) || clean(meeting.createdAt),
    updatedAt: normalizeDate(meeting.updatedAt) || clean(meeting.updatedAt),
  });
}

function normalizeRecord(value = {}) {
  const items = normalizeOrderItems(
    value.items || value.orderItems || value.lineItems || value.order?.items
  );
  const calculatedTotal = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );
  const explicitTotal = finiteMoney(
    value.total ?? value.orderTotal ?? value.amount ?? value.order?.total
  );

  return {
    id: clean(value.id),
    workspaceId: clean(value.workspaceId),
    createdBy: clean(value.createdBy),
    operationType: clean(value.operationType || value.type || (items.length ? "order" : "booking")),
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
    direction: normalizeDirection(value.direction),
    campaignId: clean(value.campaignId),
    leadId: clean(value.leadId),
    callId: clean(value.callId),
    queueId: clean(value.queueId),
    agentId: clean(value.agentId),
    agentName: clean(value.agentName || value.createdByAgentName),
    items,
    total: explicitTotal != null ? explicitTotal : roundMoney(calculatedTotal),
    currency: clean(value.currency).toUpperCase().slice(0, 8),
    fulfillmentType: normalizeStatus(
      value.fulfillmentType || value.fulfillment_type || value.orderType
    ),
    fulfillmentStatus: normalizeStatus(
      value.fulfillmentStatus || value.fulfillment_status
    ),
    confirmationCode: clean(
      value.confirmationCode || value.confirmation_code
    ).slice(0, 240),
    providerRecordId: clean(
      value.providerRecordId || value.provider_record_id
    ).slice(0, 500),
    createdAt: clean(value.createdAt) || new Date().toISOString(),
    updatedAt: clean(value.updatedAt) || new Date().toISOString(),
  };
}

function normalizeOrderItems(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === "string") {
        return {
          name: clean(item).slice(0, 500),
          quantity: 1,
          price: 0,
          instructions: "",
        };
      }

      const source = item && typeof item === "object" ? item : {};
      return {
        name: clean(
          source.name || source.item || source.product || source.title
        ).slice(0, 500),
        quantity: Math.max(
          1,
          clampInteger(source.quantity || source.qty, 1, 1, 10000)
        ),
        price: Math.max(
          0,
          finiteMoney(source.price ?? source.unitPrice ?? source.amount) || 0
        ),
        instructions: clean(
          source.instructions || source.notes || source.modifiers
        ).slice(0, 2000),
      };
    })
    .filter((item) => item.name)
    .slice(0, 250);
}

function decorateAgent(record, agentsById) {
  const agentId = clean(record?.agentId);
  const agent = agentId ? agentsById.get(agentId) : null;
  if (!agent) return record;

  return {
    ...record,
    agentName:
      clean(record.agentName) ||
      clean(agent.name || agent.agentName) ||
      "ReachFly AI",
  };
}

function operationIdentity(item = {}) {
  const callId = clean(item.callId);
  const providerId = clean(item.providerRecordId);
  const startAt = normalizeDate(item.startAt);

  if (providerId) return `provider:${providerId}`;
  if (callId && startAt) {
    return `call:${callId}:${operationBucket(item)}:${startAt}`;
  }
  if (callId && isOrderOperation(item)) {
    return `call:${callId}:order`;
  }
  return `id:${clean(item.id)}`;
}

function mergeOperation(current = {}, incoming = {}) {
  const mergedItems = Array.isArray(incoming.items) && incoming.items.length
    ? incoming.items
    : current.items || [];

  return {
    ...current,
    ...incoming,
    id: clean(incoming.id || current.id),
    items: mergedItems,
    total:
      Number(incoming.total) > 0 || mergedItems.length
        ? Number(incoming.total || 0)
        : Number(current.total || 0),
    notes: clean(incoming.notes || current.notes),
    agentName: clean(incoming.agentName || current.agentName),
  };
}

function stableVoiceOperationId({ callId, operationType, providerId }) {
  if (providerId) {
    return `op_voice_${safeId(providerId)}`;
  }

  return `op_call_${safeId(callId)}_${safeId(operationBucket({ operationType }))}`;
}

function operationBucket(record = {}) {
  return isOrderOperation(record) ? "order" : "booking";
}

function isOrderOperation(record = {}) {
  const type = normalizeStatus(record.operationType || record.type);
  return (
    Array.isArray(record.items) && record.items.length > 0
  ) || /(^|_)(order|takeout|takeaway|delivery|pickup|food)(_|$)/.test(type);
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

function normalizeDirection(value) {
  const direction = normalizeStatus(value);
  return ["inbound", "outbound"].includes(direction) ? direction : "";
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

  const now = Date.now();
  const aFuture = a >= now;
  const bFuture = b >= now;
  if (aFuture !== bFuture) return aFuture ? -1 : 1;
  if (aFuture && bFuture) return a - b;
  return b - a;
}

function sortNewest(left, right) {
  const a = Date.parse(left?.updatedAt || left?.createdAt || 0) || 0;
  const b = Date.parse(right?.updatedAt || right?.createdAt || 0) || 0;
  return b - a;
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

function finiteMoney(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? roundMoney(number) : null;
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function normalizePhoneKey(value) {
  return clean(value).replace(/\D/g, "").slice(-15);
}

function safeId(value) {
  return clean(value)
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180) || "operation";
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
