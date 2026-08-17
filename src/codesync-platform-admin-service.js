import crypto from "node:crypto";

const CODESYNC_WORKSPACE_ID = "codesync-labs-workspace";
const PLATFORM_OWNER_EMAIL = "owner@codesynclabs.com";
const MARKETING_STATUSES = new Set([
  "review_required",
  "qualified",
  "contacted",
  "nurture",
  "converted",
  "not_a_fit",
  "do_not_contact",
]);
const SUBSCRIPTION_STATUSES = new Set([
  "none",
  "trialing",
  "active",
  "past_due",
  "paused",
  "cancelled",
]);
const SUBSCRIPTION_INTERVALS = new Set(["monthly", "yearly"]);
const OWNER_ROLES = new Set(["owner", "workspace_owner", "company_owner"]);

export function createCodesyncPlatformAdminService({ store, creditBillingService } = {}) {
  if (!store?.read || !store?.update) {
    throw new Error("createCodesyncPlatformAdminService requires a store.");
  }

  function getAccess(user, state = store.read()) {
    const users = Array.isArray(state.users) ? state.users : [];
    const requestEmail = normalizeEmail(user?.email);
    const persistedUser =
      users.find((item) => item.id && item.id === user?.id) ||
      users.find(
        (item) =>
          requestEmail && normalizeEmail(item.email) === requestEmail
      ) ||
      null;
    const effectiveUser = persistedUser || user || {};
    const email = normalizeEmail(effectiveUser.email || requestEmail);
    const authorized = email === PLATFORM_OWNER_EMAIL;

    return {
      available: authorized,
      authorized,
      platformOwner: authorized,
      email,
      workspaceId: clean(
        effectiveUser.workspaceId ||
          effectiveUser.companyId ||
          user?.workspaceId ||
          user?.companyId
      ),
      role: normalizeRole(
        effectiveUser.workspaceRole ||
          effectiveUser.role ||
          user?.workspaceRole ||
          user?.role ||
          ""
      ),
      reason: authorized
        ? ""
        : `Platform administration is restricted to ${PLATFORM_OWNER_EMAIL}.`,
    };
  }

  function requireAccess(user) {
    const access = getAccess(user);
    if (!access.available) {
      const error = new Error(
        access.reason || "Platform administration is not available."
      );
      error.statusCode = 404;
      throw error;
    }
    return access;
  }

  function getDashboard(user) {
    requireAccess(user);
    const state = store.read();
    const baseAccounts = buildAccounts(state);

    if (!creditBillingService?.getAdminSnapshot) {
      throw httpError(503, "Credit billing service is not available.");
    }

    const credits = creditBillingService.getAdminSnapshot(baseAccounts);
    const payments = buildPayments(state, baseAccounts);
    const subscriptions = buildSubscriptions(state, baseAccounts);
    const accounts = enrichAccounts({
      state,
      accounts: baseAccounts,
      credits,
      payments,
      subscriptions,
    });
    const marketing = buildMarketingLeads(state, accounts);
    const users = buildUsers(state, accounts);
    const activity = buildActivity(state, accounts);
    const companyAccounts = accounts.filter(
      (item) => item.accountType === "company"
    );
    const individualAccounts = accounts.filter(
      (item) => item.accountType === "individual"
    );
    const allCampaigns = state.campaigns || [];
    const allAudits = state.leadAudits || [];
    const aiCalls = state.telnyxAiAgentCalls || [];
    const meetings = state.telnyxAiAgentMeetings || [];
    const paymentRevenueByCurrency = sumSuccessfulRevenue(payments);

    return {
      access: getAccess(user, state),
      generatedAt: new Date().toISOString(),
      summary: {
        companies: companyAccounts.length,
        individualAccounts: individualAccounts.length,
        users: users.length,
        blockedUsers: users.filter((item) => item.accessBlocked).length,
        campaigns: allCampaigns.length,
        leads: accounts.reduce((sum, item) => sum + item.leads, 0),
        audits: allAudits.length,
        auditErrors: allAudits.filter((item) => item.status === "failed").length,
        aiCalls: aiCalls.length,
        aiMeetings: meetings.length,
        activeSubscriptions: subscriptions.filter(
          (item) => ["active", "trialing"].includes(item.status)
        ).length,
        pastDueSubscriptions: subscriptions.filter(
          (item) => item.status === "past_due"
        ).length,
        successfulPayments: payments.filter(
          (item) => item.paymentStatus === "succeeded"
        ).length,
        pendingPayments: payments.filter(
          (item) => item.paymentStatus === "pending"
        ).length,
        marketingProspects: marketing.filter(
          (item) => item.marketingStatus !== "do_not_contact"
        ).length,
        totalAvailableCredits: credits.totalAvailableCredits || 0,
        totalPurchasedCredits: credits.totalPurchasedCredits || 0,
        totalConsumedCredits: credits.totalConsumedCredits || 0,
        totalAiCallCreditsAvailable: credits.totalAiCallCreditsAvailable || 0,
        totalAiCallCreditsConsumed: credits.totalAiCallCreditsConsumed || 0,
        successfulCreditPurchases: credits.successfulPurchases || 0,
        revenueByCurrency: paymentRevenueByCurrency,
      },
      companies: companyAccounts,
      individuals: individualAccounts,
      users,
      subscriptions,
      payments: payments.slice(0, 500),
      marketingLeads: marketing,
      credits,
      revenue: {
        revenueByCurrency: paymentRevenueByCurrency,
        payments: payments.slice(0, 500),
      },
      activity,
      dataHealth: {
        billingConnected: Boolean(
          credits.safepayConfigured ||
            payments.some((item) => item.paymentStatus === "succeeded")
        ),
        subscriptionsTracked: subscriptions.some(
          (item) => item.status !== "none"
        ),
        note:
          "Payments are read from ReachFly credit purchases, AI-call-credit purchases, and paid Voice Agent number/bundle orders. Subscription records are commercial/admin records; recurring customer collection is not implied unless a recurring billing integration updates them.",
      },
    };
  }

  function updateMarketingLead(user, accountId, input = {}) {
    requireAccess(user);
    const state = store.read();
    const accounts = buildAccounts(state);
    const account = accounts.find((item) => item.id === accountId);
    if (!account || account.isCodesync) {
      throw httpError(404, "Marketing prospect not found.");
    }

    const status = normalizeStatus(
      input.status || input.marketingStatus || "review_required"
    );
    if (!MARKETING_STATUSES.has(status)) {
      throw httpError(400, "Unsupported marketing status.");
    }

    const now = new Date().toISOString();
    const tags = uniqueStrings(input.tags).slice(0, 20);
    const notes = clean(input.notes).slice(0, 4000);
    const doNotContact =
      status === "do_not_contact" || input.doNotContact === true;

    store.update((draft) => {
      draft.platformMarketingLeads = Array.isArray(
        draft.platformMarketingLeads
      )
        ? draft.platformMarketingLeads
        : [];
      let target = draft.platformMarketingLeads.find(
        (item) => item.accountId === accountId
      );
      if (!target) {
        target = {
          id: crypto.randomUUID(),
          accountId,
          createdAt: now,
        };
        draft.platformMarketingLeads.push(target);
      }
      Object.assign(target, {
        workspaceId: account.workspaceId,
        userId: account.ownerId,
        status: doNotContact ? "do_not_contact" : status,
        doNotContact,
        notes,
        tags,
        updatedBy: user.id,
        updatedAt: now,
      });
      appendAdminActivity(draft, {
        actorId: user.id,
        type: "platform_marketing",
        title: `${account.displayName} marketing status changed to ${target.status}`,
        targetWorkspaceId: account.workspaceId,
        targetAccountId: accountId,
        createdAt: now,
      });
    });

    return {
      ok: true,
      lead:
        buildMarketingLeads(store.read(), buildAccounts(store.read())).find(
          (item) => item.id === accountId
        ) || null,
    };
  }

  function updateCreditRate(user, feature, input = {}) {
    requireAccess(user);
    if (!creditBillingService?.updateRate) {
      throw httpError(503, "Credit billing service is not available.");
    }
    return {
      ok: true,
      rate: creditBillingService.updateRate(feature, input, user.id),
    };
  }

  function updateCreditPack(user, packId, input = {}) {
    requireAccess(user);
    if (!creditBillingService?.updatePack) {
      throw httpError(503, "Credit billing service is not available.");
    }
    return {
      ok: true,
      pack: creditBillingService.updatePack(packId, input, user.id),
    };
  }

  function adjustCredits(user, workspaceId, input = {}) {
    requireAccess(user);
    if (!creditBillingService?.adjustWorkspaceCredits) {
      throw httpError(503, "Credit billing service is not available.");
    }
    return {
      ok: true,
      wallet: creditBillingService.adjustWorkspaceCredits(
        workspaceId,
        input,
        user.id
      ),
    };
  }

  function updateSubscription(user, workspaceIdValue, input = {}) {
    requireAccess(user);
    const workspaceId = clean(workspaceIdValue);
    if (!workspaceId) {
      throw httpError(400, "workspaceId is required.");
    }

    const state = store.read();
    const account = buildAccounts(state).find(
      (item) => item.workspaceId === workspaceId
    );
    if (!account) {
      throw httpError(404, "Workspace was not found.");
    }

    const status = normalizeStatus(input.status || "none");
    if (!SUBSCRIPTION_STATUSES.has(status)) {
      throw httpError(400, "Unsupported subscription status.");
    }

    const interval = normalizeStatus(input.interval || "monthly");
    if (!SUBSCRIPTION_INTERVALS.has(interval)) {
      throw httpError(400, "Subscription interval must be monthly or yearly.");
    }

    const amountMinor = Math.max(0, Math.round(Number(input.amountMinor || 0)));
    const planName = clean(input.planName || input.plan || "").slice(0, 120);
    const currency = clean(input.currency || "USD").toUpperCase().slice(0, 8);
    const currentPeriodStart = normalizeDate(input.currentPeriodStart);
    const currentPeriodEnd = normalizeDate(input.currentPeriodEnd);
    const now = new Date().toISOString();
    let output = null;

    store.update((draft) => {
      draft.workspaceSubscriptions = Array.isArray(draft.workspaceSubscriptions)
        ? draft.workspaceSubscriptions
        : [];
      let target = draft.workspaceSubscriptions.find(
        (item) => item.workspaceId === workspaceId
      );
      if (!target) {
        target = {
          id: crypto.randomUUID(),
          workspaceId,
          createdAt: now,
        };
        draft.workspaceSubscriptions.push(target);
      }

      Object.assign(target, {
        planName,
        status,
        amountMinor,
        currency,
        interval,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd === true,
        paymentProvider: clean(input.paymentProvider || target.paymentProvider || "safepay").slice(0, 60),
        externalSubscriptionId: clean(
          input.externalSubscriptionId || target.externalSubscriptionId || ""
        ).slice(0, 240),
        notes: clean(input.notes).slice(0, 2000),
        source: clean(input.source || target.source || "platform_admin").slice(0, 80),
        updatedBy: user.id,
        updatedAt: now,
      });
      output = { ...target };

      appendAdminActivity(draft, {
        actorId: user.id,
        type: "workspace_subscription_updated",
        title: `${account.displayName} subscription set to ${status}`,
        targetWorkspaceId: workspaceId,
        detail: planName || "No plan name",
        createdAt: now,
      });
    });

    return {
      ok: true,
      subscription: publicSubscription(output, account),
    };
  }

  function setUserAccess(user, userIdValue, input = {}) {
    requireAccess(user);
    const userId = clean(userIdValue);
    const action = normalizeStatus(input.action || "block");
    if (!new Set(["block", "unblock"]).has(action)) {
      throw httpError(400, "Action must be block or unblock.");
    }

    const state = store.read();
    const target = (state.users || []).find((item) => item.id === userId);
    if (!target) {
      throw httpError(404, "User was not found.");
    }
    if (normalizeEmail(target.email) === PLATFORM_OWNER_EMAIL) {
      throw httpError(409, "The platform owner account cannot be blocked or unblocked here.");
    }

    const reason = clean(input.reason).slice(0, 1000);
    if (action === "block" && !reason) {
      throw httpError(400, "A block reason is required.");
    }

    const now = new Date().toISOString();
    store.update((draft) => {
      const draftTarget = (draft.users || []).find((item) => item.id === userId);
      if (!draftTarget) {
        throw httpError(404, "User was not found.");
      }

      if (action === "block") {
        Object.assign(draftTarget, {
          status: "blocked",
          active: false,
          isActive: false,
          platformAccessBlocked: true,
          blockedAt: now,
          blockedBy: user.id,
          blockedReason: reason,
          updatedAt: now,
        });
      } else {
        Object.assign(draftTarget, {
          status: "active",
          active: true,
          isActive: true,
          platformAccessBlocked: false,
          blockedAt: "",
          blockedBy: "",
          blockedReason: "",
          unblockedAt: now,
          unblockedBy: user.id,
          updatedAt: now,
        });
      }

      if (Array.isArray(draft.workspaceMembers)) {
        for (const member of draft.workspaceMembers) {
          if (member.userId !== userId) continue;
          member.status = action === "block" ? "blocked" : "active";
          member.active = action !== "block";
          member.isActive = action !== "block";
          member.updatedAt = now;
        }
      }

      appendAdminActivity(draft, {
        actorId: user.id,
        type: action === "block" ? "platform_user_blocked" : "platform_user_unblocked",
        title: `${clean(draftTarget.email || draftTarget.name || userId)} ${action === "block" ? "blocked" : "unblocked"}`,
        targetWorkspaceId: clean(draftTarget.workspaceId),
        targetUserId: userId,
        detail: reason,
        createdAt: now,
      });
    });

    const latest = store.read();
    const accounts = buildAccounts(latest);
    return {
      ok: true,
      user:
        buildUsers(latest, accounts).find((item) => item.id === userId) || null,
    };
  }

  function deleteUser(user, userIdValue, input = {}) {
    requireAccess(user);
    const userId = clean(userIdValue);
    const state = store.read();
    const target = (state.users || []).find((item) => item.id === userId);
    if (!target) {
      throw httpError(404, "User was not found.");
    }

    const targetEmail = normalizeEmail(target.email);
    if (targetEmail === PLATFORM_OWNER_EMAIL) {
      throw httpError(409, "The platform owner account cannot be deleted.");
    }
    if (OWNER_ROLES.has(normalizeRole(target.workspaceRole || target.role))) {
      throw httpError(
        409,
        "Workspace owners cannot be deleted from the Users action because that could orphan a company. Block the owner to suspend access, or transfer/delete the workspace with a dedicated account workflow."
      );
    }

    const confirmation = normalizeEmail(input.confirmEmail);
    if (!confirmation || confirmation !== targetEmail) {
      throw httpError(
        400,
        "Type the target user's exact email address to confirm deletion."
      );
    }

    const now = new Date().toISOString();
    const targetWorkspaceId = clean(target.workspaceId);
    const targetName = clean(target.name || target.fullName || target.email || userId);

    store.update((draft) => {
      draft.users = (draft.users || []).filter((item) => item.id !== userId);
      if (Array.isArray(draft.workspaceMembers)) {
        draft.workspaceMembers = draft.workspaceMembers.filter(
          (item) => item.userId !== userId
        );
      }
      if (Array.isArray(draft.teamMembers)) {
        draft.teamMembers = draft.teamMembers.filter(
          (item) => item.userId !== userId && item.id !== userId
        );
      }

      appendAdminActivity(draft, {
        actorId: user.id,
        type: "platform_user_deleted",
        title: `${targetName} deleted from ReachFly`,
        targetWorkspaceId,
        targetUserId: userId,
        detail: targetEmail,
        createdAt: now,
      });
    });

    return {
      ok: true,
      deleted: true,
      userId,
      email: targetEmail,
    };
  }

  return {
    getAccess,
    getDashboard,
    updateMarketingLead,
    updateCreditRate,
    updateCreditPack,
    adjustCredits,
    updateSubscription,
    setUserAccess,
    deleteUser,
  };
}

function buildAccounts(state) {
  const users = state.users || [];
  const workspaces = state.workspaces || [];
  const campaigns = state.campaigns || [];
  const audits = state.leadAudits || [];
  const aiCalls = state.telnyxAiAgentCalls || [];
  const meetings = state.telnyxAiAgentMeetings || [];
  const accountMap = new Map();

  for (const workspace of workspaces) {
    const workspaceId = clean(workspace.id || workspace.workspaceId);
    if (!workspaceId) continue;
    const workspaceUsers = users.filter(
      (user) => clean(user.workspaceId) === workspaceId
    );
    const owner =
      workspaceUsers.find(
        (user) => user.id === workspace.ownerId || user.id === workspace.ownerUserId
      ) ||
      workspaceUsers.find(
        (user) => OWNER_ROLES.has(normalizeRole(user.workspaceRole || user.role))
      ) ||
      workspaceUsers[0] ||
      null;
    const accountType = normalizeAccountType(
      workspace.accountType || workspace.workspaceType || owner?.accountType || owner?.workspaceType,
      workspace.companyName || workspace.name || owner?.companyName
    );
    accountMap.set(
      workspaceId,
      makeAccount({
        id: workspaceId,
        workspace,
        owner,
        workspaceUsers,
        accountType,
        campaigns,
        audits,
        aiCalls,
        meetings,
      })
    );
  }

  for (const user of users) {
    const workspaceId = clean(user.workspaceId);
    const key = workspaceId || `user:${user.id}`;
    if (accountMap.has(key)) continue;
    accountMap.set(
      key,
      makeAccount({
        id: key,
        workspace: null,
        owner: user,
        workspaceUsers: [user],
        accountType: normalizeAccountType(
          user.accountType || user.workspaceType,
          user.companyName
        ),
        campaigns,
        audits,
        aiCalls,
        meetings,
      })
    );
  }

  return [...accountMap.values()].sort((a, b) =>
    String(b.lastActivityAt || b.createdAt).localeCompare(
      String(a.lastActivityAt || a.createdAt)
    )
  );
}

function makeAccount({
  id,
  workspace,
  owner,
  workspaceUsers,
  accountType,
  campaigns,
  audits,
  aiCalls,
  meetings,
}) {
  const workspaceId = clean(workspace?.id || workspace?.workspaceId || owner?.workspaceId);
  const ownedCampaigns = campaigns.filter((item) => {
    if (workspaceId && item.workspaceId) return item.workspaceId === workspaceId;
    return owner && [item.ownerId, item.userId, item.createdBy].includes(owner.id);
  });
  const leads = ownedCampaigns.reduce(
    (sum, campaign) =>
      sum +
      (Array.isArray(campaign.leads)
        ? campaign.leads.length
        : Number(campaign.leadCount || 0)),
    0
  );
  const accountAudits = audits.filter(
    (item) => workspaceId && item.workspaceId === workspaceId
  );
  const accountCalls = aiCalls.filter(
    (item) => workspaceId && item.workspaceId === workspaceId
  );
  const accountMeetings = meetings.filter(
    (item) => workspaceId && item.workspaceId === workspaceId
  );
  const dates = [
    workspace?.updatedAt,
    workspace?.createdAt,
    owner?.updatedAt,
    owner?.createdAt,
    ...workspaceUsers.map((item) => item.updatedAt || item.createdAt),
    ...ownedCampaigns.map((item) => item.updatedAt || item.createdAt),
    ...accountAudits.map((item) => item.updatedAt || item.createdAt),
    ...accountCalls.map((item) => item.updatedAt || item.createdAt),
  ].filter(Boolean);
  const isCodesync = isCodesyncIdentity({ user: owner, workspace });

  return {
    id,
    workspaceId,
    displayName:
      clean(
        workspace?.companyName ||
          workspace?.name ||
          owner?.companyName ||
          owner?.name ||
          owner?.email
      ) || "Unnamed account",
    accountType,
    companyName: clean(workspace?.companyName || owner?.companyName),
    ownerId: owner?.id || workspace?.ownerId || "",
    ownerName: clean(owner?.name || owner?.fullName),
    ownerEmail: clean(owner?.email),
    ownerPhone: clean(owner?.phone || owner?.phoneNumber),
    users: workspaceUsers.length,
    blockedUsers: workspaceUsers.filter(isUserBlocked).length,
    campaigns: ownedCampaigns.length,
    leads,
    audits: accountAudits.length,
    auditErrors: accountAudits.filter((item) => item.status === "failed").length,
    aiCalls: accountCalls.length,
    meetings: accountMeetings.length,
    createdAt: workspace?.createdAt || owner?.createdAt || "",
    lastActivityAt: dates.sort().at(-1) || "",
    status:
      normalizeStatus(workspace?.status || owner?.status || "active") || "active",
    isCodesync,
  };
}

function enrichAccounts({ state, accounts, credits, payments, subscriptions }) {
  const generalWallets = new Map(
    (credits.wallets || []).map((item) => [item.workspaceId, item])
  );
  const aiWallets = new Map(
    (credits.aiCallWallets || []).map((item) => [item.workspaceId, item])
  );
  const subscriptionByWorkspace = new Map(
    subscriptions.map((item) => [item.workspaceId, item])
  );
  const paymentsByWorkspace = new Map();
  for (const payment of payments) {
    if (!paymentsByWorkspace.has(payment.workspaceId)) {
      paymentsByWorkspace.set(payment.workspaceId, []);
    }
    paymentsByWorkspace.get(payment.workspaceId).push(payment);
  }
  const activeNumbersByWorkspace = new Map();
  for (const number of state.voicePhoneNumbers || []) {
    if (normalizeStatus(number.status) !== "active") continue;
    const workspaceId = clean(number.workspaceId);
    if (!workspaceId) continue;
    const current = activeNumbersByWorkspace.get(workspaceId) || [];
    current.push({
      phoneNumber: clean(number.phoneNumber),
      status: normalizeStatus(number.status),
      providerMonthlyMinor: Number(number.providerMonthlyMinor || 0),
      currency: clean(number.currency || "USD").toUpperCase(),
    });
    activeNumbersByWorkspace.set(workspaceId, current);
  }

  return accounts.map((account) => {
    const general = generalWallets.get(account.workspaceId) || {};
    const ai = aiWallets.get(account.workspaceId) || {};
    const accountPayments = paymentsByWorkspace.get(account.workspaceId) || [];
    const revenueByCurrency = sumSuccessfulRevenue(accountPayments);
    return {
      ...account,
      subscription:
        subscriptionByWorkspace.get(account.workspaceId) ||
        publicSubscription({ workspaceId: account.workspaceId }, account),
      credits: {
        available: Number(general.balance || 0),
        reserved: Number(general.reserved || 0),
        consumed: Number(general.totalConsumed || 0),
        purchased: Number(general.totalPurchased || 0),
        debt: Number(general.debt || 0),
      },
      aiCallCredits: {
        available: Number(ai.balance || 0),
        consumed: Number(ai.totalConsumed || 0),
        purchased: Number(ai.totalPurchased || 0),
        granted: Number(ai.totalGranted || 0),
        debt: Number(ai.debt || 0),
      },
      payments: {
        total: accountPayments.length,
        successful: accountPayments.filter(
          (item) => item.paymentStatus === "succeeded"
        ).length,
        pending: accountPayments.filter(
          (item) => item.paymentStatus === "pending"
        ).length,
        lastPaymentAt:
          accountPayments.find((item) => item.paymentStatus === "succeeded")
            ?.paidAt || "",
        revenueByCurrency,
      },
      activeNumbers: activeNumbersByWorkspace.get(account.workspaceId) || [],
    };
  });
}

function buildUsers(state, accounts) {
  const accountByWorkspace = new Map(
    accounts.map((item) => [item.workspaceId, item])
  );
  return (state.users || [])
    .map((user) => {
      const account = accountByWorkspace.get(user.workspaceId) || null;
      const role = normalizeRole(user.workspaceRole || user.role || "member");
      const email = clean(user.email);
      return {
        id: user.id,
        name: clean(user.name || user.fullName),
        email,
        phone: clean(user.phone || user.phoneNumber),
        workspaceId: clean(user.workspaceId),
        workspaceName:
          account?.displayName || clean(user.companyName || user.workspaceName),
        accountType:
          account?.accountType ||
          normalizeAccountType(
            user.accountType || user.workspaceType,
            user.companyName
          ),
        role,
        status: isUserBlocked(user)
          ? "blocked"
          : normalizeStatus(user.status || "active"),
        accessBlocked: isUserBlocked(user),
        blockedAt: user.blockedAt || "",
        blockedReason: clean(user.blockedReason),
        createdAt: user.createdAt || "",
        updatedAt: user.updatedAt || user.createdAt || "",
        isCodesync: Boolean(account?.isCodesync),
        platformOwner: normalizeEmail(email) === PLATFORM_OWNER_EMAIL,
        deletable:
          normalizeEmail(email) !== PLATFORM_OWNER_EMAIL &&
          !OWNER_ROLES.has(role),
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function buildSubscriptions(state, accounts) {
  const stored = new Map(
    (state.workspaceSubscriptions || []).map((item) => [item.workspaceId, item])
  );
  return accounts
    .filter((account) => account.workspaceId)
    .map((account) =>
      publicSubscription(stored.get(account.workspaceId) || {}, account)
    )
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function publicSubscription(item = {}, account = {}) {
  const status = normalizeStatus(item.status || "none");
  return {
    id: clean(item.id),
    workspaceId: clean(item.workspaceId || account.workspaceId),
    accountName: clean(account.displayName),
    planName: clean(item.planName || item.plan || ""),
    status: SUBSCRIPTION_STATUSES.has(status) ? status : "none",
    amountMinor: Math.max(0, Math.round(Number(item.amountMinor || 0))),
    currency: clean(item.currency || "USD").toUpperCase(),
    interval: SUBSCRIPTION_INTERVALS.has(normalizeStatus(item.interval))
      ? normalizeStatus(item.interval)
      : "monthly",
    currentPeriodStart: item.currentPeriodStart || "",
    currentPeriodEnd: item.currentPeriodEnd || "",
    cancelAtPeriodEnd: item.cancelAtPeriodEnd === true,
    paymentProvider: clean(item.paymentProvider),
    externalSubscriptionId: clean(item.externalSubscriptionId),
    notes: clean(item.notes),
    source: clean(item.source || (item.id ? "platform_admin" : "none")),
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || item.createdAt || "",
  };
}

function buildPayments(state, accounts) {
  const accountNames = new Map(
    accounts.map((item) => [item.workspaceId, item.displayName])
  );
  const rows = [];

  for (const purchase of state.creditPurchases || []) {
    rows.push({
      id: `general:${purchase.id}`,
      sourceId: purchase.id,
      workspaceId: clean(purchase.workspaceId),
      accountName:
        accountNames.get(purchase.workspaceId) || clean(purchase.workspaceId),
      productType: "general_credits",
      productLabel: "ReachFly workspace credits",
      credits: Number(purchase.credits || 0),
      phoneNumber: "",
      amountMinor: Number(purchase.amountMinor || 0),
      currency: clean(purchase.currency || "USD").toUpperCase(),
      paymentStatus: normalizePaymentStatus(purchase.status),
      operationalStatus: normalizeStatus(purchase.status),
      provider: clean(purchase.provider || "safepay"),
      providerTracker: clean(purchase.providerTracker),
      paidAt: purchase.paidAt || "",
      createdAt: purchase.createdAt || "",
      updatedAt: purchase.updatedAt || purchase.paidAt || purchase.createdAt || "",
    });
  }

  for (const purchase of state.aiCallCreditPurchases || []) {
    if (normalizeStatus(purchase.source) === "voice_bundle" || purchase.bundleOrderId) {
      continue;
    }
    rows.push({
      id: `ai:${purchase.id}`,
      sourceId: purchase.id,
      workspaceId: clean(purchase.workspaceId),
      accountName:
        accountNames.get(purchase.workspaceId) || clean(purchase.workspaceId),
      productType: "ai_call_credits",
      productLabel: "AI call credits",
      credits: Number(purchase.credits || 0),
      phoneNumber: "",
      amountMinor: Number(purchase.amountMinor || 0),
      currency: clean(purchase.currency || "USD").toUpperCase(),
      paymentStatus: normalizePaymentStatus(purchase.status),
      operationalStatus: normalizeStatus(purchase.status),
      provider: clean(purchase.provider || "safepay"),
      providerTracker: clean(purchase.providerTracker),
      paidAt: purchase.paidAt || "",
      createdAt: purchase.createdAt || "",
      updatedAt: purchase.updatedAt || purchase.paidAt || purchase.createdAt || "",
    });
  }

  for (const order of state.voiceNumberOrders || []) {
    const productType =
      normalizeStatus(order.productType) === "voice_bundle"
        ? "voice_bundle"
        : "business_number";
    rows.push({
      id: `voice:${order.id}`,
      sourceId: order.id,
      workspaceId: clean(order.workspaceId),
      accountName:
        accountNames.get(order.workspaceId) || clean(order.workspaceId),
      productType,
      productLabel:
        productType === "voice_bundle"
          ? "Business number + AI calling bundle"
          : "Business number activation",
      credits: Number(order.aiCallCredits || 0),
      phoneNumber: clean(order.phoneNumber),
      amountMinor: Number(order.amountMinor || 0),
      currency: clean(order.currency || "USD").toUpperCase(),
      paymentStatus: normalizeVoiceOrderPaymentStatus(order),
      operationalStatus: normalizeStatus(order.status),
      provider: clean(order.paymentProvider || "safepay"),
      providerTracker: clean(order.providerTracker),
      paidAt: order.paidAt || "",
      createdAt: order.createdAt || "",
      updatedAt: order.updatedAt || order.paidAt || order.createdAt || "",
    });
  }

  return rows.sort((a, b) =>
    String(b.updatedAt || b.paidAt || b.createdAt).localeCompare(
      String(a.updatedAt || a.paidAt || a.createdAt)
    )
  );
}

function normalizePaymentStatus(value) {
  const status = normalizeStatus(value);
  if (["succeeded", "paid", "complete", "completed"].includes(status)) {
    return "succeeded";
  }
  if (["failed", "cancelled", "canceled"].includes(status)) return "failed";
  if (["refunded", "refund_review_required"].includes(status)) return "refunded";
  return "pending";
}

function normalizeVoiceOrderPaymentStatus(order = {}) {
  if (order.refundedAt || ["refunded", "refund_review_required"].includes(normalizeStatus(order.status))) {
    return "refunded";
  }
  if (order.paidAt) return "succeeded";
  const status = normalizeStatus(order.status);
  if (status === "payment_failed") return "failed";
  return "pending";
}

function sumSuccessfulRevenue(payments) {
  const output = {};
  for (const payment of payments || []) {
    if (payment.paymentStatus !== "succeeded") continue;
    const currency = clean(payment.currency || "USD").toUpperCase();
    output[currency] =
      (output[currency] || 0) + Number(payment.amountMinor || 0);
  }
  return output;
}

function buildMarketingLeads(state, accounts) {
  const stored = new Map(
    (state.platformMarketingLeads || []).map((item) => [item.accountId, item])
  );
  return accounts
    .filter((account) => !account.isCodesync)
    .map((account) => {
      const saved = stored.get(account.id) || {};
      const explicitlyBlocked = Boolean(
        saved.doNotContact ||
          saved.unsubscribed ||
          account.status === "deleted" ||
          account.status === "suspended" ||
          account.status === "blocked"
      );
      const marketingStatus = explicitlyBlocked
        ? "do_not_contact"
        : normalizeStatus(saved.status || "review_required");
      return {
        ...account,
        marketingStatus,
        doNotContact:
          explicitlyBlocked || marketingStatus === "do_not_contact",
        tags: uniqueStrings(saved.tags).slice(0, 20),
        notes: clean(saved.notes),
        marketingUpdatedAt: saved.updatedAt || "",
        marketingEligible: !explicitlyBlocked,
        reason: explicitlyBlocked
          ? "Suppressed from marketing."
          : "Platform account available for internal review. Confirm the appropriate lawful basis/consent before outreach.",
      };
    });
}

function buildActivity(state, accounts) {
  const accountNames = new Map(
    accounts.map((item) => [item.workspaceId, item.displayName])
  );
  const combined = [
    ...(state.activity || []).map((item) => ({ ...item, source: "platform" })),
    ...(state.telnyxAiAgentActivity || []).map((item) => ({
      ...item,
      source: "ai_caller",
    })),
    ...(state.leadAudits || []).map((item) => ({
      id: `audit:${item.id}`,
      workspaceId: item.workspaceId,
      type: `audit_${item.status || "updated"}`,
      title: `${item.auditType || item.kind || "Audit"}: ${
        item.status || "updated"
      }`,
      createdAt: item.updatedAt || item.createdAt,
      source: "audit",
    })),
  ];
  return combined
    .filter((item) => item.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 500)
    .map((item) => ({
      id: item.id || crypto.randomUUID(),
      type: clean(item.type || item.action || "activity"),
      title: clean(
        item.title || item.detail || item.message || item.type || "Activity"
      ),
      detail: clean(item.detail),
      workspaceId: clean(item.targetWorkspaceId || item.workspaceId),
      accountName:
        accountNames.get(item.targetWorkspaceId || item.workspaceId) || "",
      source: item.source || "platform",
      createdAt: item.createdAt,
    }));
}

function appendAdminActivity(draft, input = {}) {
  draft.activity = Array.isArray(draft.activity) ? draft.activity : [];
  draft.activity.unshift({
    id: crypto.randomUUID(),
    workspaceId: CODESYNC_WORKSPACE_ID,
    source: "platform_admin",
    ...input,
  });
  if (draft.activity.length > 5000) {
    draft.activity.splice(5000);
  }
}

function isUserBlocked(user = {}) {
  const status = normalizeStatus(user.status);
  return Boolean(
    user.platformAccessBlocked === true ||
      user.active === false ||
      user.isActive === false ||
      user.blockedAt ||
      ["blocked", "suspended", "disabled", "deleted"].includes(status)
  );
}

function isCodesyncIdentity({ user, workspace }) {
  const values = [
    user?.workspaceId,
    user?.companyId,
    user?.workspaceSlug,
    user?.companySlug,
    user?.workspaceName,
    user?.companyName,
    workspace?.id,
    workspace?.slug,
    workspace?.name,
    workspace?.companyName,
  ]
    .filter(Boolean)
    .map(normalizeIdentity);
  return (
    values.includes(normalizeIdentity(CODESYNC_WORKSPACE_ID)) ||
    values.includes("codesync_labs") ||
    values.includes("codesynclabs")
  );
}

function normalizeAccountType(value, companyName = "") {
  const normalized = normalizeStatus(value);
  if (normalized === "company") return "company";
  if (normalized === "individual") return "individual";
  return clean(companyName) ? "company" : "individual";
}

function normalizeIdentity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRole(value) {
  const normalized = normalizeStatus(value);
  const aliases = {
    administrator: "admin",
    company_owner: "owner",
    workspace_owner: "owner",
  };
  return aliases[normalized] || normalized;
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function uniqueStrings(value) {
  const input = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  return [...new Set(input.map(clean).filter(Boolean))];
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
