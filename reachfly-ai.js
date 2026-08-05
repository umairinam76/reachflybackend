export function createReachFlyAI({ store, campaigns, workspaceService }) {
  async function command(raw = "", options = {}) {
    const text = String(raw || "").trim();
    const lower = text.toLowerCase();
    const user = options.user || null;
    const screen = sanitizeScreen(options.screen || {});
    const context = user
      ? buildWorkspaceContext({ store, workspaceService, user, screen })
      : { screen };

    if (!text || /suggest|next step|what should i do|analyse|analyze/i.test(lower)) {
      return {
        action: "screen_suggestions",
        reply: buildScreenSuggestions(context),
        suggestions: suggestionCards(context),
      };
    }

    if (isOutsideScope(lower)) {
      return {
        reply:
          "I can only help inside ReachFly: campaigns, leads, assignments, call follow-ups, email, audits, inbox, analytics, territories, team performance, and workspace settings.",
      };
    }

    if (/(create|launch|start|build).*(campaign|leads|lead)/i.test(text)) {
      if (!can(context, "manage_campaigns") && context.role !== "owner") {
        return { reply: "Your workspace role cannot create campaigns. Ask an owner or manager to create and assign the lead list." };
      }

      const parsed = parseCampaign(text);
      if (!parsed.niche || !parsed.location) {
        return {
          reply:
            "Include a niche and location. Example: Create a campaign for dental clinics in Miami with 100 leads.",
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
        reply: `Campaign created for ${campaign.niche} in ${campaign.location}. Open it to review discovery progress before assigning leads.`,
      };
    }

    if (/my leads|assigned leads|what should i call/i.test(lower)) {
      const leads = workspaceService?.listMyLeads(user) || [];
      const due = leads.filter((lead) => isDue(lead.nextActionAt));
      const top = (due.length ? due : leads).slice(0, 5);
      if (!top.length) return { reply: "No assigned leads are ready. Ask the owner or manager to assign leads to you." };
      return {
        action: "show_assigned_leads",
        reply: `You have ${leads.length} assigned leads and ${due.length} due now. Start with:\n${top
          .map((lead) => `• ${lead.name || lead.business}: ${lead.status || "new"}${lead.nextActionAt ? `, next action ${formatDate(lead.nextActionAt)}` : ""}`)
          .join("\n")}`,
      };
    }

    if (/team performance|caller performance|leaderboard/i.test(lower)) {
      if (!can(context, "view_team_performance")) {
        return { reply: "Team performance is available to workspace owners and managers." };
      }
      const report = workspaceService.performance(user, {});
      const rows = [...report.rows].sort((a, b) => b.meetings - a.meetings || b.connected - a.connected);
      return {
        action: "team_performance",
        reply: rows.length
          ? `Team performance for the current period:\n${rows.slice(0, 6).map((row) => `• ${row.name}: ${row.callAttempts} calls, ${row.connected} connects, ${row.meetings} meetings, ${row.overdue} overdue`).join("\n")}`
          : "No team activity is available for the selected period.",
      };
    }

    if (/audit|website review|website report/i.test(lower)) {
      return {
        action: "open_audit",
        reply:
          "Open Website Audits, enter the lead website, niche, and location. Add 2–3 benchmark URLs when you have verified them; otherwise ReachFly can use strong matching websites already verified in this workspace. The report should be reviewed by a human before outreach.",
      };
    }

    if (/active campaigns|show.*campaign|campaigns/i.test(lower)) {
      const items = campaigns
        .listCampaigns()
        .filter((campaign) => !context.workspaceId || campaign.workspaceId === context.workspaceId)
        .slice(0, 5);
      if (!items.length) return { reply: "No campaigns are available in this workspace." };
      return {
        reply: `Recent campaigns:\n${items
          .map((campaign) => `• ${campaign.name}: ${campaign.status}, ${campaign.leadCount || 0} leads`)
          .join("\n")}`,
      };
    }

    if (/pipeline|sequence|follow.?up/i.test(lower)) {
      return {
        reply:
          "Recommended caller-led flow: call first, record the outcome, send the relevant audit email only after a meaningful call or voicemail, create a dated callback, and stop outreach immediately for do-not-call leads. Owners should measure attended meetings, not only booked meetings.",
      };
    }

    if (/email|smtp|gmail/i.test(lower)) {
      return {
        reply:
          "The workspace owner should connect and test a sender account. Team members then send lead emails through the campaign’s approved sender; they should not receive or view SMTP passwords.",
      };
    }

    if (/metric|analytics|dashboard|report/i.test(lower)) {
      return { reply: metricSummary(context) };
    }

    return await optionalOpenAIReply({ text, context }).catch(() => ({
      reply:
        "I can help with the current ReachFly screen, lead assignment, call outcomes, email follow-up, audits, campaigns, inbox activity, and team performance. Ask: ‘What should I do next on this screen?’",
    }));
  }

  return { command };
}

function buildWorkspaceContext({ store, workspaceService, user, screen }) {
  const wsContext = workspaceService.getContext(user);
  const state = store.read();
  const campaigns = (state.campaigns || []).filter(
    (campaign) => campaign.workspaceId === wsContext.workspaceId
  );
  const leads = workspaceService.listMyLeads(user);
  const inbox = (state.inbox || []).filter(
    (item) => item.workspaceId === wsContext.workspaceId || item.userId === wsContext.workspace?.ownerId
  );

  return {
    ...wsContext,
    screen,
    campaigns,
    leads,
    inbox,
    metrics: {
      campaigns: campaigns.length,
      leads: campaigns.reduce((sum, campaign) => sum + (campaign.leads?.length || 0), 0),
      assignedToMe: leads.length,
      dueToMe: leads.filter((lead) => isDue(lead.nextActionAt)).length,
      replies: inbox.filter((item) => item.direction === "inbound").length,
    },
  };
}

function buildScreenSuggestions(context) {
  const suggestions = suggestionCards(context);
  const screenName = context.screen.title || routeName(context.screen.pathname);
  return `On ${screenName}, the best next steps are:\n${suggestions
    .map((item, index) => `${index + 1}. ${item.title} — ${item.description}`)
    .join("\n")}`;
}

function suggestionCards(context) {
  const path = context.screen.pathname || "";
  const due = context.metrics?.dueToMe || 0;

  if (/dashboard/.test(path)) {
    if (context.role === "owner" || context.role === "manager") {
      return [
        { title: "Clear overdue work", description: "Open team performance and reassign overdue leads before releasing more new leads." },
        { title: "Check meeting quality", description: "Review qualified and meeting-booked tags, then compare attended meetings by caller." },
        { title: "Release capacity-matched leads", description: "Assign only enough leads for the team to complete the full follow-up cadence." },
      ];
    }
    return [
      { title: `Work ${due} due leads`, description: "Call overdue and callback leads before starting new assignments." },
      { title: "Update every outcome", description: "Save status, notes, tags, and the next action immediately after each call." },
      { title: "Send relevant follow-up", description: "Use the per-lead email button only after the call and personalise from the audit evidence." },
    ];
  }

  if (/campaigns\/.*|contacts|my-leads/.test(path)) {
    return [
      { title: "Prioritise Tier A", description: "Start with high-quality leads that have a verified website, business phone, and relevant audit observation." },
      { title: "Assign ownership", description: "Every active lead needs one responsible caller and one dated next action." },
      { title: "Protect suppression", description: "Do not call or email leads tagged do-not-call or not relevant." },
    ];
  }

  if (/team/.test(path)) {
    return [
      { title: "Invite with minimum role", description: "Use caller for outreach staff and manager only for people who need assignment and reporting access." },
      { title: "Measure outcomes", description: "Compare connects, qualified conversations, meetings, and overdue tasks rather than raw call volume." },
      { title: "Coach from evidence", description: "Review calls where the audit observation or exact-time meeting close was missed." },
    ];
  }

  if (/audit/.test(path)) {
    return [
      { title: "Verify the target", description: "Confirm the business website and niche before running tests." },
      { title: "Use fair benchmarks", description: "Compare only public, detectable features from 2–3 relevant sites." },
      { title: "Human-review the report", description: "Remove unsupported claims before attaching the report to outreach." },
    ];
  }

  if (/inbox/.test(path)) {
    return [
      { title: "Reply to intent first", description: "Prioritise meeting requests, referrals, questions, and objections." },
      { title: "Update the lead", description: "Reflect the reply in status, notes, and next action so callers do not duplicate outreach." },
      { title: "Stop negative outreach", description: "Apply suppression immediately when a recipient opts out." },
    ];
  }

  return [
    { title: "Review due leads", description: "Complete callbacks and overdue actions before adding more records." },
    { title: "Keep ownership clear", description: "Every lead needs an assignee, status, and next action." },
    { title: "Ask about this screen", description: "Tell ReachFly AI what outcome you want and it will stay within workspace data." },
  ];
}

function metricSummary(context) {
  const metrics = context.metrics || {};
  return `Workspace snapshot: ${metrics.campaigns || 0} campaigns, ${metrics.leads || 0} total leads, ${metrics.assignedToMe || 0} assigned to you, ${metrics.dueToMe || 0} due, and ${metrics.replies || 0} inbound replies.`;
}

async function optionalOpenAIReply({ text, context }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI not configured");
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.OPENAI_REACHFLY_MODEL || "gpt-5",
    store: false,
    input: [
      {
        role: "system",
        content:
          "You are ReachFly AI. Answer only about the supplied ReachFly workspace context. Do not claim to have browsed the web. Do not reveal credentials. Recommend reversible next steps and never execute an action unless the user explicitly asked for it.",
      },
      {
        role: "user",
        content: JSON.stringify({ request: text, context: compactContext(context) }),
      },
    ],
  });
  return { reply: response.output_text };
}

function compactContext(context) {
  return {
    role: context.role,
    permissions: context.permissions,
    screen: context.screen,
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
  };
}

function can(context, permission) {
  return context.permissions?.includes("*") || context.permissions?.includes(permission);
}

function sanitizeScreen(screen) {
  return {
    pathname: String(screen.pathname || "").slice(0, 300),
    title: String(screen.title || "").slice(0, 180),
    entityId: String(screen.entityId || "").slice(0, 180),
  };
}

function isOutsideScope(lower) {
  return /(weather|sports|movie|recipe|politics|stock|crypto price|medical diagnosis|legal advice|homework)/i.test(lower);
}

function parseCampaign(text) {
  const limitMatch = text.match(/(\d{1,4})\s*(leads?|contacts?|businesses?)/i);
  const limit = limitMatch ? Math.min(1000, Math.max(1, Number(limitMatch[1]))) : 100;
  const radiusMatch = text.match(/(\d{1,4})\s*(km|kilometres?|kilometers?)/i);
  const forMatch = text.match(/(?:for|targeting)\s+(.+?)\s+(?:in|near|around)\s+(.+?)(?:\s+with\s+\d+|\s+and\s+\d+|$)/i);
  if (!forMatch) return { limit };
  return {
    niche: clean(forMatch[1]),
    location: clean(forMatch[2]),
    limit,
    radiusKm: radiusMatch ? Number(radiusMatch[1]) : 10,
  };
}

function clean(value) {
  return String(value || "").replace(/campaign|leads|lead|businesses/gi, "").trim().replace(/[.?!]+$/, "");
}

function isDue(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now();
}

function formatDate(value) {
  try { return new Date(value).toLocaleString("en-GB"); } catch { return value; }
}

function routeName(pathname) {
  if (/dashboard/.test(pathname)) return "the dashboard";
  if (/my-leads/.test(pathname)) return "My Leads";
  if (/campaign/.test(pathname)) return "the campaign screen";
  if (/team/.test(pathname)) return "Team";
  if (/audit/.test(pathname)) return "Website Audits";
  if (/inbox/.test(pathname)) return "Inbox";
  return "this screen";
}
