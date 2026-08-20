import crypto from "node:crypto";

const SUPPORT_MARKER_RE = /\[\[REACHFLY_SUPPORT:(billing|technical|account|data|other)\]\]/i;
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
const CLAUDE_MODEL_FALLBACKS = [
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

export function createReachFlyAI({
  store,
  campaigns,
  workspaceService,
  workspaceConnectionsService,
}) {
  async function command(raw = "", options = {}) {
    const text = String(raw || "").trim();
    const lower = text.toLowerCase();
    const user = options.user || null;
    const screen = sanitizeScreen(options.screen || {});
    const context = user
      ? buildWorkspaceContext({ store, workspaceService, user, screen })
      : { screen, pageGuide: pageGuide(screen.pathname) };

    if (isOutsideScope(lower)) {
      return {
        reply:
          "I’m your ReachFly assistant, so I stay focused on ReachFly pages, sales workflows, leads, campaigns, integrations, inbox, AI Voice, billing, CRM, team operations, and troubleshooting inside this product.",
      };
    }

    // Keep high-impact write actions deterministic. Claude can explain the action,
    // but ReachFly itself remains responsible for validating permissions and data.
    if (/(create|launch|start|build).*(campaign|leads|lead)/i.test(text)) {
      if (!user) return { reply: "Sign in before creating a campaign." };
      if (!can(context, "manage_campaigns") && context.role !== "owner") {
        return {
          reply:
            "Your workspace role cannot create campaigns. Ask an owner or manager to create and assign the lead list.",
        };
      }

      const parsed = parseCampaign(text);
      if (!parsed.niche || !parsed.location) {
        return {
          reply:
            "Tell me the niche and location. For example: Create a campaign for dental clinics in Miami with 100 leads.",
        };
      }

      const campaign = await campaigns.createCampaign({
        accountType: user?.accountType || "individual",
        role: user?.role || "growth consultant",
        niche: parsed.niche,
        location: parsed.location,
        limit: parsed.limit || 100,
        radiusKm: parsed.radiusKm || 10,
        qualityLevel: parsed.qualityLevel || "balanced",
        goal: "both",
        userId: user?.id,
        ownerId: context.workspace?.ownerId || user?.id,
        createdBy: user?.id,
        ownerEmail: user?.email,
        ownerName: user?.name,
        workspaceId: context.workspaceId,
      });

      return {
        action: "campaign_created",
        campaign,
        link: `/app/campaigns/${campaign.id}`,
        reply: `Campaign created for ${campaign.niche} in ${campaign.location}. Open it to review the lead run and pipeline.`,
      };
    }

    if (!text) {
      return {
        action: "screen_suggestions",
        reply: buildScreenSuggestions(context),
        suggestions: suggestionCards(context),
      };
    }

    try {
      const claude = await claudeReply({ text, context });
      return await finalizeClaudeResult({
        text,
        context,
        user,
        screen,
        claudeText: claude,
        store,
        workspaceConnectionsService,
      });
    } catch (error) {
      console.error("[reachfly-ai] claude request failed", error);
      const forcedCategory = supportCategoryFromRequest(text, screen);
      if (forcedCategory && user) {
        const support = await createSupportRequest({
          store,
          workspaceConnectionsService,
          user,
          screen,
          request: text,
          category: forcedCategory,
          reason: safeError(error),
        });
        return {
          reply:
            "I couldn’t complete that request automatically. I created a support request with the current page and your question so it can be reviewed without you repeating everything.",
          support,
        };
      }

      return {
        reply: [
          buildScreenSuggestions(context),
          `Live AI did not finish this response. ${anthropicSetupHint(error)}`,
        ].join("\n\n").trim(),
        degraded: true,
      };
    }
  }

  async function streamCommand(raw = "", options = {}, onDelta = () => {}) {
    const text = String(raw || "").trim();
    const lower = text.toLowerCase();
    const user = options.user || null;
    const screen = sanitizeScreen(options.screen || {});
    const context = user
      ? buildWorkspaceContext({ store, workspaceService, user, screen })
      : { screen, pageGuide: pageGuide(screen.pathname) };

    if (isOutsideScope(lower)) {
      const result = await command(text, options);
      onDelta(result.reply || "");
      return result;
    }

    if (/(create|launch|start|build).*(campaign|leads|lead)/i.test(text)) {
      const result = await command(text, options);
      onDelta(result.reply || "");
      return result;
    }

    if (!text) {
      const result = await command(text, options);
      onDelta(result.reply || "");
      return result;
    }

    try {
      const claudeText = await streamClaudeReply({ text, context, onDelta });
      return await finalizeClaudeResult({
        text,
        context,
        user,
        screen,
        claudeText,
        store,
        workspaceConnectionsService,
      });
    } catch (error) {
      console.error("[reachfly-ai] claude stream failed", error);

      const forcedCategory = supportCategoryFromRequest(text, screen);
      if (forcedCategory && user) {
        const support = await createSupportRequest({
          store,
          workspaceConnectionsService,
          user,
          screen,
          request: text,
          category: forcedCategory,
          reason: safeError(error),
        });
        const reply =
          "I couldn’t complete that account-specific request automatically. I sent the current page context to ReachFly support so you do not need to repeat the issue.";
        onDelta(`\n${reply}`);
        return { reply, support };
      }

      const reply = [
        buildScreenSuggestions(context),
        "Live AI did not finish this response, but I can still guide you using the current ReachFly screen. Retry the question once; the backend will automatically use the next available Claude model.",
      ].join("\n\n");
      onDelta(`\n${reply}`);
      return { reply, degraded: true };
    }
  }

  return { command, streamCommand };
}

async function finalizeClaudeResult({
  text,
  context,
  user,
  screen,
  claudeText,
  store,
  workspaceConnectionsService,
}) {
  const marker = extractSupportMarker(claudeText);
  const forcedCategory = supportCategoryFromRequest(text, screen);
  const category = forcedCategory || marker.category;
  const reply = marker.cleanText.trim() || buildScreenSuggestions(context);

  if (!category || !user) {
    return { reply };
  }

  const support = await createSupportRequest({
    store,
    workspaceConnectionsService,
    user,
    screen,
    request: text,
    category,
    reason:
      marker.category
        ? "ReachFly AI determined that human support is required."
        : `This request is in the ${category} support category.`,
  });

  return {
    reply: `${reply}\n\nI’ve also sent the relevant page context to ReachFly support, so you won’t need to repeat the issue.`,
    support,
  };
}

function buildWorkspaceContext({ store, workspaceService, user, screen }) {
  const wsContext = workspaceService.getContext(user);
  const state = store.read();
  const workspaceId = wsContext.workspaceId;
  const workspaceCampaigns = (state.campaigns || []).filter(
    (campaign) => campaign.workspaceId === workspaceId
  );
  const leads = workspaceService.listMyLeads(user);
  const inbox = (state.inbox || []).filter(
    (item) =>
      item.workspaceId === workspaceId ||
      item.userId === wsContext.workspace?.ownerId
  );
  const connections = (state.workspaceConnections || []).filter(
    (item) => item.workspaceId === workspaceId
  );
  const externalSources = (state.externalLeadSources || []).filter(
    (item) => item.workspaceId === workspaceId
  );
  const voiceAgents = (state.telnyxAiAgents || []).filter(
    (item) => item.workspaceId === workspaceId
  );
  const scrapedLeads = (state.scrapedLeads || []).filter(
    (item) => item.workspaceId === workspaceId
  );

  return {
    ...wsContext,
    screen,
    pageGuide: pageGuide(screen.pathname),
    campaigns: workspaceCampaigns,
    leads,
    inbox,
    connections,
    externalSources,
    voiceAgents,
    metrics: {
      campaigns: workspaceCampaigns.length,
      leads: workspaceCampaigns.reduce(
        (sum, campaign) => sum + (campaign.leadCount || campaign.leads?.length || 0),
        0
      ),
      scrapedLeads: scrapedLeads.length,
      assignedToMe: leads.length,
      dueToMe: leads.filter((lead) => isDue(lead.nextActionAt)).length,
      replies: inbox.filter((item) => item.direction === "inbound").length,
      integrations: connections.filter((item) => item.status === "connected").length,
      externalSources: externalSources.length,
      voiceAgents: voiceAgents.length,
    },
  };
}

function buildScreenSuggestions(context) {
  const suggestions = suggestionCards(context);
  const screenName =
    context.screen.title || context.pageGuide?.title || routeName(context.screen.pathname);
  return `On ${screenName}, the best next steps are:\n${suggestions
    .map((item, index) => `${index + 1}. ${item.title} — ${item.description}`)
    .join("\n")}`;
}

function suggestionCards(context) {
  const path = context.screen.pathname || "";
  const due = context.metrics?.dueToMe || 0;

  if (/leads/.test(path)) {
    return [
      { title: "Choose the right lead view", description: "Use Find Leads for new discovery, All Leads for saved results, and External Leads for imported sources." },
      { title: "Keep lead data saved", description: "Review saved or imported leads before launching a campaign so navigation does not interrupt your work." },
      { title: "Build outreach from verified fields", description: "Map email and phone fields before using Email, WhatsApp, or AI Voice." },
    ];
  }

  if (/connections|integrations/.test(path)) {
    return [
      { title: "Connect once", description: "Use the integration card for Google Workspace, WhatsApp, Calendly, or another supported provider." },
      { title: "Test the connection", description: "Confirm sending, calendar, or messaging access before assigning the connection to a workflow." },
      { title: "Keep credentials server-side", description: "Do not paste secrets into chat; use the dedicated connection form." },
    ];
  }

  if (/voice-agent/.test(path)) {
    return [
      { title: "Confirm a business number", description: "Use My Numbers, Buy Numbers, or Connect Existing Number before making outbound calls." },
      { title: "Check agent readiness", description: "Confirm the agent, disclosure, calling window, and available call credits." },
      { title: "Test before a campaign", description: "Run a controlled test call before assigning a large lead list." },
    ];
  }

  if (/dashboard|platform-admin/.test(path)) {
    if (context.role === "owner" || context.role === "manager") {
      return [
        { title: "Clear overdue work", description: "Review overdue lead activity before releasing more work." },
        { title: "Check meeting quality", description: "Compare qualified conversations, booked meetings, and attended meetings." },
        { title: "Review workspace readiness", description: "Keep integrations, credits, and Voice Agent setup healthy before launching campaigns." },
      ];
    }
    return [
      { title: `Work ${due} due leads`, description: "Complete callbacks and overdue actions first." },
      { title: "Update every outcome", description: "Save the call result, notes, status, and next action." },
      { title: "Send relevant follow-up", description: "Follow up from the lead context instead of sending a generic message." },
    ];
  }

  if (/inbox/.test(path)) {
    return [
      { title: "Sync replies", description: "Use the connected Google mailbox so campaign replies stay inside ReachFly." },
      { title: "Prioritise intent", description: "Handle meeting requests, questions, objections, and opt-outs first." },
      { title: "Update the lead", description: "Reflect the reply in CRM status and next action." },
    ];
  }

  if (/billing/.test(path)) {
    return [
      { title: "Check available balance", description: "Confirm the ReachFly or AI call credit balance before retrying a paid action." },
      { title: "Do not repeat a charged checkout", description: "If a payment was charged but credits or a number did not arrive, ask me to escalate it." },
      { title: "Share the visible error", description: "I can send the current page context to support without exposing payment credentials." },
    ];
  }

  return [
    { title: "Tell me the goal", description: "Ask what you are trying to accomplish on this screen." },
    { title: "Use the current page context", description: "I can read the route, headings, visible controls, and workspace status sent by ReachFly." },
    { title: "Escalate only when needed", description: "Payment and unresolved account-specific issues can be routed to ReachFly support." },
  ];
}

async function claudeReply({ text, context }) {
  const { response } = await openClaudeResponse({
    text,
    context,
    stream: false,
  });

  const body = await readAnthropicJson(response);
  return (body?.content || [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("")
    .trim();
}

async function streamClaudeReply({ text, context, onDelta }) {
  const { response } = await openClaudeResponse({
    text,
    context,
    stream: true,
  });

  if (!response.body) {
    throw new Error("Claude streaming response did not include a response body.");
  }

  const decoder = new TextDecoder();
  let lineBuffer = "";
  let fullText = "";
  let withheld = "";
  const tailLength = 56;

  for await (const chunk of response.body) {
    lineBuffer += decoder.decode(chunk, { stream: true });
    const lines = lineBuffer.split(/
?
/);
    lineBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }

      if (event?.type === "error") {
        throw new Error(
          event?.error?.message || "Claude streaming request failed."
        );
      }

      const delta =
        event?.type === "content_block_delta" &&
        event?.delta?.type === "text_delta"
          ? String(event.delta.text || "")
          : "";

      if (!delta) continue;

      fullText += delta;
      withheld += delta;

      if (withheld.length > tailLength) {
        const safeLength = withheld.length - tailLength;
        const emit = withheld.slice(0, safeLength);
        withheld = withheld.slice(safeLength);
        if (emit) onDelta(emit);
      }
    }
  }

  const marker = extractSupportMarker(fullText);
  const alreadyEmittedLength = Math.max(0, fullText.length - withheld.length);
  const remainder = marker.cleanText.slice(alreadyEmittedLength);
  if (remainder) onDelta(remainder);
  return fullText.trim();
}

async function openClaudeResponse({ text, context, stream }) {
  const apiKey = requireAnthropicKey();
  const models = getClaudeModelCandidates();
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: clampInt(
                process.env.ANTHROPIC_REACHFLY_MAX_TOKENS,
                900,
                200,
                2500
              ),
              stream: Boolean(stream),
              system: buildClaudeSystemPrompt(),
              messages: [
                {
                  role: "user",
                  content: JSON.stringify({
                    request: text,
                    reachflyContext: compactContext(context),
                  }),
                },
              ],
            }),
          },
          clampInt(process.env.ANTHROPIC_REACHFLY_TIMEOUT_MS, 30_000, 5_000, 90_000)
        );

        if (response.ok) {
          return { response, model };
        }

        const body = await readAnthropicJson(response);
        const message =
          body?.error?.message ||
          body?.message ||
          `Claude returned HTTP ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        error.model = model;
        lastError = error;

        // A model can be unavailable to one Anthropic account even while the API
        // key itself is valid. Move to the next supported model automatically.
        if (isClaudeModelAvailabilityError(response.status, message)) {
          break;
        }

        if (isRetryableClaudeStatus(response.status) && attempt === 0) {
          await wait(500);
          continue;
        }

        throw error;
      } catch (error) {
        lastError = error;

        if (isAbortError(error)) {
          if (attempt === 0) {
            await wait(350);
            continue;
          }
          break;
        }

        // Network/transient failures get one retry before falling back to the
        // next model. Authentication errors are not hidden by model fallback.
        if (isAuthenticationClaudeError(error)) {
          throw error;
        }

        if (attempt === 0) {
          await wait(350);
          continue;
        }

        break;
      }
    }
  }

  throw lastError || new Error("Claude did not return an available model response.");
}

function getClaudeModelCandidates() {
  const configured = String(
    process.env.ANTHROPIC_REACHFLY_MODEL ||
      process.env.CLAUDE_MODEL ||
      ""
  ).trim();

  return [...new Set([
    configured,
    DEFAULT_CLAUDE_MODEL,
    ...CLAUDE_MODEL_FALLBACKS,
  ].filter(Boolean))];
}

function isClaudeModelAvailabilityError(status, message) {
  if (![400, 403, 404].includes(Number(status))) return false;
  return /(model|not found|not available|access|permission|unsupported)/i.test(
    String(message || "")
  );
}

function isRetryableClaudeStatus(status) {
  return [408, 409, 429, 500, 502, 503, 504, 529].includes(Number(status));
}

function isAuthenticationClaudeError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "");
  return (
    status === 401 ||
    (/api key|authentication|unauthorized/i.test(message) &&
      !/model/i.test(message))
  );
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    /aborted|timeout|timed out/i.test(String(error?.message || ""))
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClaudeSystemPrompt() {
  return [
    "You are ReachFly AI, the in-product real-time assistant for ReachFlyAI.",
    "Your job is to keep users from getting stuck anywhere in the ReachFly application.",
    "Use only the supplied ReachFly context and visible page information. Never pretend you can see data that was not supplied.",
    "Explain exactly where the user is, what the controls on that page are for, why an error may be happening, and the safest next action.",
    "You know the ReachFly product areas: Dashboard; Find Leads; All Leads; External Leads; AI Audits; Campaigns; Inbox; WhatsApp; Dialer; Voice Agents; Calls; Phone Numbers; Contacts; Pipeline; Meetings; Team; Billing; Integrations; Settings; Analytics; Territories; Resource Board; Platform Admin.",
    "When page visibleText or visibleActions are supplied, treat them as the most current source of UI truth.",
    "Never ask for passwords, API secrets, card numbers, OAuth tokens, or other credentials in chat.",
    "Never claim a payment, refund, purchase, email, call, connection, or data mutation succeeded unless the supplied context confirms it.",
    "For normal product help, give concise step-by-step guidance and use the current route names.",
    "If the issue is a payment/refund/charge problem, an account-specific backend failure, possible lost data, or anything you cannot confidently resolve from the supplied context, append exactly one marker at the very end of your answer: [[REACHFLY_SUPPORT:billing]], [[REACHFLY_SUPPORT:technical]], [[REACHFLY_SUPPORT:account]], [[REACHFLY_SUPPORT:data]], or [[REACHFLY_SUPPORT:other]].",
    "Do not mention that marker to the user and do not add text after it.",
  ].join("\n");
}

function compactContext(context) {
  return {
    role: context.role,
    permissions: context.permissions,
    screen: context.screen,
    pageGuide: context.pageGuide,
    metrics: context.metrics,
    campaigns: (context.campaigns || []).slice(0, 8).map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      leadCount: campaign.leadCount || campaign.leads?.length || 0,
    })),
    leads: (context.leads || []).slice(0, 12).map((lead) => ({
      id: lead.id,
      business: lead.name || lead.business,
      status: lead.status,
      nextActionAt: lead.nextActionAt,
      tags: lead.tags,
    })),
    integrations: (context.connections || []).slice(0, 12).map((item) => ({
      provider: item.provider,
      type: item.type,
      accountEmail: item.accountEmail,
      status: item.status,
      capabilities: item.capabilities,
    })),
    externalLeadSources: (context.externalSources || []).slice(0, 12).map((item) => ({
      provider: item.provider,
      name: item.name,
      status: item.status,
      lastImportCount: item.lastImportCount,
      lastImportedAt: item.lastImportedAt,
    })),
  };
}

async function createSupportRequest({
  store,
  workspaceConnectionsService,
  user,
  screen,
  request,
  category,
  reason,
}) {
  const now = new Date().toISOString();
  const workspaceId = String(user.workspaceId || user.companyId || user.id || "");
  const normalizedRequest = String(request || "").trim().slice(0, 4000);
  let record = null;

  store.update((state) => {
    state.supportRequests = Array.isArray(state.supportRequests) ? state.supportRequests : [];
    const duplicate = state.supportRequests.find((item) => {
      const age = Date.now() - Date.parse(item.createdAt || 0);
      return (
        item.userId === user.id &&
        item.category === category &&
        item.request === normalizedRequest &&
        age >= 0 &&
        age < 5 * 60_000
      );
    });
    if (duplicate) {
      record = { ...duplicate };
      return;
    }

    record = {
      id: `support_${crypto.randomUUID()}`,
      workspaceId,
      userId: user.id,
      userEmail: String(user.email || ""),
      userName: String(user.name || ""),
      category,
      request: normalizedRequest,
      reason: String(reason || "").slice(0, 1200),
      pathname: screen.pathname || "",
      pageTitle: screen.title || "",
      status: "open",
      emailStatus: "pending",
      createdAt: now,
      updatedAt: now,
    };
    state.supportRequests.unshift(record);
    if (state.supportRequests.length > 2000) state.supportRequests.splice(2000);
  });

  if (!record) return null;

  const supportEmail = String(
    process.env.REACHFLY_SUPPORT_EMAIL ||
      process.env.SUPPORT_EMAIL ||
      "owner@codesynclabs.com"
  ).trim();

  let emailStatus = record.emailStatus || "pending";
  let emailError = "";
  if (workspaceConnectionsService?.sendSupportNotification && supportEmail) {
    try {
      await workspaceConnectionsService.sendSupportNotification(user, {
        to: supportEmail,
        replyTo: user.email,
        subject: `[ReachFly ${category} support] ${screen.title || screen.pathname || "User issue"}`,
        text: [
          "ReachFly AI escalated a user issue.",
          "",
          `Category: ${category}`,
          `User: ${user.name || ""} <${user.email || ""}>`,
          `Workspace: ${workspaceId}`,
          `Page: ${screen.title || ""} ${screen.pathname || ""}`,
          "",
          "User request:",
          normalizedRequest,
          "",
          `Reason: ${reason || "ReachFly AI requested human support."}`,
          "",
          `Support request ID: ${record.id}`,
        ].join("\n"),
      });
      emailStatus = "sent";
    } catch (error) {
      emailStatus = "queued";
      emailError = safeError(error);
    }
  } else {
    emailStatus = "queued";
  }

  store.update((state) => {
    state.supportRequests = Array.isArray(state.supportRequests) ? state.supportRequests : [];
    const target = state.supportRequests.find((item) => item.id === record.id);
    if (!target) return;
    target.emailStatus = emailStatus;
    target.emailError = emailError;
    target.updatedAt = new Date().toISOString();
  });

  return {
    id: record.id,
    category,
    status: "open",
    emailStatus,
  };
}

function supportCategoryFromRequest(text, screen) {
  const value = `${text || ""} ${screen?.pathname || ""}`.toLowerCase();
  if (/(payment|paid|charge|charged|refund|invoice|safepay|card declined|card failed|money|checkout|purchase failed|credits? (missing|not added)|number.*(charged|purchase|buy.*failed))/i.test(value)) {
    return "billing";
  }
  if (/(lost data|leads? (lost|missing|disappeared)|deleted unexpectedly|data missing)/i.test(value)) {
    return "data";
  }
  if (/(account locked|cannot login|can't login|login failed|permission issue|access denied)/i.test(value)) {
    return "account";
  }
  return "";
}

function extractSupportMarker(text) {
  const source = String(text || "");
  const match = source.match(SUPPORT_MARKER_RE);
  return {
    category: match?.[1]?.toLowerCase() || "",
    cleanText: source.replace(SUPPORT_MARKER_RE, "").trim(),
  };
}

function sanitizeScreen(screen) {
  return {
    pathname: String(screen.pathname || "").slice(0, 300),
    search: String(screen.search || "").slice(0, 500),
    title: String(screen.title || "").slice(0, 180),
    heading: String(screen.heading || "").slice(0, 300),
    entityId: String(screen.entityId || "").slice(0, 180),
    visibleText: String(screen.visibleText || "").replace(/\s+/g, " ").slice(0, 10_000),
    visibleActions: Array.isArray(screen.visibleActions)
      ? screen.visibleActions.map((item) => String(item || "").slice(0, 120)).filter(Boolean).slice(0, 40)
      : [],
    headings: Array.isArray(screen.headings)
      ? screen.headings.map((item) => String(item || "").slice(0, 200)).filter(Boolean).slice(0, 30)
      : [],
  };
}

function pageGuide(pathname) {
  const path = String(pathname || "");
  const pages = [
    [/\/app\/(dashboard|platform-admin)/, "Dashboard", "Workspace overview, credits, activity, performance, and shortcuts."],
    [/\/app\/leads/, "Leads", "Find new leads, review saved All Leads, or import External Leads."],
    [/\/app\/ai|\/app\/audits/, "AI Audits", "Create and review website/business audits for outreach context."],
    [/\/app\/campaigns/, "Campaigns", "Create, sequence, review, and monitor outreach campaigns."],
    [/\/app\/inbox/, "Inbox", "Campaign email activity and replies from the connected Google mailbox."],
    [/\/app\/whatsapp/, "WhatsApp", "Link WhatsApp Web and use messaging workflows."],
    [/\/app\/voice-agent/, "AI Voice", "Configure Voice Agents, calls, phone numbers, meetings, and dialer workflows."],
    [/\/app\/agents/, "Voice Agents", "Manage AI Voice Agent configuration and assignments."],
    [/\/app\/contacts/, "Contacts", "CRM contacts and lead records."],
    [/\/app\/pipeline/, "Pipeline", "Sales stages, sequences, and next actions."],
    [/\/app\/role-operations/, "Team", "Workspace members, communication, assignments, and role operations."],
    [/\/app\/billing/, "Billing", "ReachFly credits, AI call credits, usage, and checkout."],
    [/\/app\/(connections|integrations)/, "Integrations", "Connect Google Workspace, WhatsApp, Calendly, and email/calendar services."],
    [/\/app\/settings/, "Settings", "Workspace and company settings."],
    [/\/app\/analytics/, "Analytics", "Performance, outreach, and conversion reporting."],
    [/\/app\/territories/, "Territories", "Territory targeting and geographic sales planning."],
    [/\/app\/resource-board/, "Resource Board", "Team capacity and resource planning."],
  ];
  const match = pages.find(([pattern]) => pattern.test(path));
  return match ? { title: match[1], purpose: match[2] } : { title: "ReachFly", purpose: "ReachFly sales workspace page." };
}

function can(context, permission) {
  return context.permissions?.includes("*") || context.permissions?.includes(permission);
}
function isOutsideScope(lower) {
  return /(weather|sports|movie|recipe|politics|stock price|crypto price|medical diagnosis|legal advice|homework)/i.test(lower);
}
function parseCampaign(text) {
  const limitMatch = text.match(/(\d{1,4})\s*(leads?|contacts?|businesses?)/i);
  const limit = limitMatch ? Math.min(1000, Math.max(1, Number(limitMatch[1]))) : 100;
  const radiusMatch = text.match(/(\d{1,4})\s*(km|kilometres?|kilometers?)/i);
  const forMatch = text.match(/(?:for|targeting)\s+(.+?)\s+(?:in|near|around)\s+(.+?)(?:\s+with\s+\d+|\s+and\s+\d+|$)/i);
  if (!forMatch) return { limit };
  return {
    niche: cleanCampaignPart(forMatch[1]),
    location: cleanCampaignPart(forMatch[2]),
    limit,
    radiusKm: radiusMatch ? Number(radiusMatch[1]) : 10,
  };
}
function cleanCampaignPart(value) {
  return String(value || "").replace(/campaign|leads|lead|businesses/gi, "").trim().replace(/[.?!]+$/, "");
}
function isDue(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now();
}
function routeName(pathname) {
  return pageGuide(pathname).title;
}
function requireAnthropicKey() {
  const key = String(
    process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || ""
  ).trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured.");
  return key;
}
function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
async function readAnthropicJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 1000) } }; }
}
function safeError(error) {
  return String(error?.message || error || "Unknown error").replace(/\s+/g, " ").slice(0, 1000);
}
function anthropicSetupHint(error) {
  const message = safeError(error);
  if (/ANTHROPIC_API_KEY/i.test(message)) {
    return "Configure ANTHROPIC_API_KEY on the ReachFly API server to enable live Claude responses.";
  }
  return "Try again in a moment; if the problem continues, ReachFly can escalate it with the current page context.";
}
