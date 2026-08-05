import crypto from "node:crypto";
import { Vonage } from "@vonage/server-sdk";

export function createVonageCallService({ salesOperationsService } = {}) {
  const applicationId = clean(process.env.VONAGE_APPLICATION_ID);
  const privateKey = String(process.env.VONAGE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  const virtualNumber = normalizePhone(process.env.VONAGE_VIRTUAL_NUMBER);
  const webhookBaseUrl = clean(process.env.VONAGE_WEBHOOK_BASE_URL).replace(/\/$/, "");
  const webhookSecret = clean(process.env.VONAGE_WEBHOOK_SECRET || process.env.AUTH_SECRET);
  const recordingEnabled = ["1", "true", "yes", "on"].includes(String(process.env.VONAGE_RECORD_CALLS || "false").toLowerCase());
  const client = applicationId && privateKey ? new Vonage({ applicationId, privateKey }) : null;

  function diagnostics() {
    return { configured: Boolean(client && virtualNumber && webhookBaseUrl), applicationIdPresent: Boolean(applicationId), privateKeyPresent: Boolean(privateKey), virtualNumberPresent: Boolean(virtualNumber), webhookBaseUrl, recordingEnabled };
  }

  async function startClickToCall(user, input = {}) {
    if (!diagnostics().configured) {
      const error = new Error("Vonage Voice is not configured."); error.statusCode = 503; error.details = diagnostics(); throw error;
    }
    const record = salesOperationsService.createCallRecord(user, input);
    const token = sign(record.id);
    const answerUrl = `${webhookBaseUrl}/api/vonage/webhooks/answer?sessionId=${encodeURIComponent(record.id)}&token=${encodeURIComponent(token)}`;
    const eventUrl = `${webhookBaseUrl}/api/vonage/webhooks/events?sessionId=${encodeURIComponent(record.id)}&token=${encodeURIComponent(token)}`;
    try {
      const response = await client.voice.createOutboundCall({
        to: [{ type: "phone", number: record.callerNumber }],
        from: { type: "phone", number: virtualNumber },
        answer_url: [answerUrl],
        answer_method: "GET",
        event_url: [eventUrl],
        event_method: "POST",
        machine_detection: "continue",
      });
      return salesOperationsService.updateCall(record.id, { status: "started", providerCallId: clean(response?.uuid), conversationUuid: clean(response?.conversation_uuid), providerResponse: response });
    } catch (error) {
      salesOperationsService.updateCall(record.id, { status: "failed", endedAt: new Date().toISOString(), outcome: clean(error.message), event: { status: "failed", reason: error.message } });
      throw error;
    }
  }

  function answerNcco({ sessionId, token }) {
    verify(sessionId, token);
    const state = salesOperationsService.updateCall(sessionId, { status: "connecting", answeredAt: new Date().toISOString(), event: { status: "agent-answered" } });
    if (!state) throw httpError(404, "Call session not found.");
    const eventUrl = `${webhookBaseUrl}/api/vonage/webhooks/events?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
    const ncco = [{ action: "talk", text: `Connecting you to ${state.lead.business || "the selected lead"}. The mini audit is open in ReachFly.` }];
    if (recordingEnabled) ncco.push({ action: "record", eventUrl: [`${webhookBaseUrl}/api/vonage/webhooks/recordings?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`], eventMethod: "POST", beepStart: true, split: "conversation" });
    ncco.push({ action: "connect", from: virtualNumber, timeout: 45, endpoint: [{ type: "phone", number: state.destinationNumber }], eventUrl: [eventUrl], eventMethod: "POST" });
    return ncco;
  }

  function handleEvent({ sessionId, token, payload = {} }) {
    verify(sessionId, token);
    const status = clean(payload.status || payload.type || "event").toLowerCase();
    const terminal = ["completed", "disconnected", "failed", "rejected", "busy", "unanswered", "cancelled", "timeout"].includes(status);
    const patch = {
      status: status === "answered" ? "answered" : status,
      providerCallId: clean(payload.uuid),
      conversationUuid: clean(payload.conversation_uuid),
      event: payload,
    };
    if (status === "answered") patch.answeredAt = new Date().toISOString();
    if (terminal) {
      patch.endedAt = new Date().toISOString();
      patch.durationSeconds = Number(payload.duration || payload.rate?.duration || 0);
      patch.outcome = status;
    }
    return salesOperationsService.updateCall(sessionId, patch);
  }

  function handleRecording({ sessionId, token, payload = {} }) {
    verify(sessionId, token);
    return salesOperationsService.updateCall(sessionId, { recordingUrl: clean(payload.recording_url), event: { type: "recording", ...payload } });
  }

  function completeCall(user, callId, input = {}) {
    salesOperationsService.getCall(user, callId);
    return salesOperationsService.updateCall(callId, { outcome: clean(input.outcome), notes: clean(input.notes).slice(0, 5000), status: input.status || "completed", endedAt: input.endedAt || new Date().toISOString() });
  }

  function sign(sessionId) { return crypto.createHmac("sha256", webhookSecret).update(sessionId).digest("hex"); }
  function verify(sessionId, token) {
    const expected = sign(sessionId);
    const a = Buffer.from(expected); const b = Buffer.from(String(token || ""));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(401, "Invalid Vonage webhook token.");
  }

  return { diagnostics, startClickToCall, answerNcco, handleEvent, handleRecording, completeCall };
}
function clean(value) { return String(value || "").trim(); }
function normalizePhone(value) { const raw = clean(value); const plus = raw.startsWith("+"); const digits = raw.replace(/\D/g, ""); return digits ? `${plus ? "+" : ""}${digits}` : ""; }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
