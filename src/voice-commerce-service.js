import crypto from "node:crypto";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
const DEFAULT_QUOTE_TTL_MS = 10 * 60_000;
const DEFAULT_AI_CALL_PRICE_MINOR = 100;
const DEFAULT_VOICE_BUNDLE_CREDITS = [25, 100, 250];
const CODESYNC_WORKSPACE_ID = "codesync-labs-workspace";

/**
 * Paid Voice onboarding commerce.
 *
 * This service intentionally keeps provider secrets server-side and separates:
 *   1) number inventory/quote,
 *   2) Safepay payment,
 *   3) Telnyx provisioning,
 *   4) ElevenLabs SIP-trunk import/agent assignment.
 *
 * A customer is never treated as owning a number until the verified payment
 * webhook has been processed and provisioning reaches an active state.
 */

function normalizeCallingMode(value) {
  const mode = normalizeStatus(value || "outbound");
  return ["inbound", "outbound", "both"].includes(mode) ? mode : "outbound";
}

function callingModeIncludesInbound(value) {
  const mode = normalizeCallingMode(value);
  return mode === "inbound" || mode === "both";
}

function callingModeIncludesOutbound(value) {
  const mode = normalizeCallingMode(value);
  return mode === "outbound" || mode === "both";
}

export function createVoiceCommerceService({
  store,
  workspaceService,
  emit = () => {},
} = {}) {
  if (!store?.read || !store?.update) {
    throw new Error(
      "createVoiceCommerceService requires a store exposing read() and update()."
    );
  }

  function getContext(user, state = store.read()) {
    const serviceContext = workspaceService?.getContext?.(user);
    const workspaceId = clean(
      serviceContext?.workspaceId ||
        user?.workspaceId ||
        user?.companyId ||
        user?.id
    );
    const workspace =
      serviceContext?.workspace ||
      (state.workspaces || []).find((item) => item.id === workspaceId) ||
      null;
    const role = normalizeStatus(
      serviceContext?.role || user?.workspaceRole || user?.role || "owner"
    );
    const accountType =
      normalizeStatus(
        user?.accountType ||
          user?.workspaceType ||
          workspace?.accountType ||
          workspace?.workspaceType
      ) || (workspace ? "company" : "individual");

    return {
      workspaceId,
      workspace,
      role,
      accountType,
      ownerLike:
        ["owner", "admin"].includes(role) || accountType === "individual",
    };
  }

  function ensureStateShape(draft) {
    if (!Array.isArray(draft.voiceNumberQuotes)) draft.voiceNumberQuotes = [];
    if (!Array.isArray(draft.voiceNumberOrders)) draft.voiceNumberOrders = [];
    if (!Array.isArray(draft.voicePhoneNumbers)) draft.voicePhoneNumbers = [];
    if (!Array.isArray(draft.aiCallCreditWallets)) draft.aiCallCreditWallets = [];
    if (!Array.isArray(draft.aiCallCreditLedger)) draft.aiCallCreditLedger = [];
    if (!Array.isArray(draft.aiCallCreditPurchases)) draft.aiCallCreditPurchases = [];
    if (!Array.isArray(draft.activity)) draft.activity = [];
  }

  function appendActivity(draft, input = {}) {
    ensureStateShape(draft);
    draft.activity.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    });
    if (draft.activity.length > 5000) draft.activity.splice(5000);
  }

  function assertPurchaser(user) {
    const ctx = getContext(user);
    if (!ctx.workspaceId) {
      throw httpError(401, "Voice-commerce workspace could not be resolved.");
    }
    if (!ctx.ownerLike) {
      throw httpError(
        403,
        "Only a workspace owner or administrator can purchase a business number."
      );
    }
    return ctx;
  }

  function getDashboard(user) {
    const state = store.read();
    const ctx = getContext(user, state);
    if (!ctx.workspaceId) {
      throw httpError(401, "Voice-commerce workspace could not be resolved.");
    }

    const numbers = (state.voicePhoneNumbers || [])
      .filter((item) => item.workspaceId === ctx.workspaceId)
      .sort(byNewest)
      .map(publicNumber);

    // Keep the full immutable order history in storage, but do not make the UI
    // render a stack of identical failed attempts for the same phone number.
    // The latest unpaid failure is the only actionable payment record.
    const seenFailedPaymentNumbers = new Set();
    const orders = (state.voiceNumberOrders || [])
      .filter((item) => item.workspaceId === ctx.workspaceId)
      .sort(byNewest)
      .filter((item) => {
        if (normalizeStatus(item.status) !== "payment_failed") return true;
        const key = normalizePhone(item.phoneNumber) || clean(item.id);
        if (seenFailedPaymentNumbers.has(key)) return false;
        seenFailedPaymentNumbers.add(key);
        return true;
      })
      .slice(0, 30)
      .map(publicOrder);
    const activeNumber = numbers.find((item) => item.status === "active") || null;

    const codesyncWorkspace = clean(ctx.workspaceId) === CODESYNC_WORKSPACE_ID;
    const purchaseReadiness = getNumberCheckoutReadiness();

    return {
      canPurchase: ctx.ownerLike,
      requiresPurchasedNumber: !codesyncWorkspace,
      activeNumber,
      numbers,
      orders,
      configured: {
        telnyx:
          isVoiceCommerceTestMode() ||
          Boolean(getTelnyxCommerceApiKey()),
        telnyxConnection:
          isVoiceCommerceTestMode() ||
          Boolean(resolveTelnyxConnectionId(false)),
        elevenLabs: Boolean(clean(process.env.ELEVENLABS_API_KEY)),
        safepay: Boolean(
          clean(process.env.SAFEPAY_SECRET_KEY) &&
            clean(process.env.SAFEPAY_PUBLIC_KEY)
        ),
      },
      testMode: {
        enabled: isVoiceCommerceTestMode(),
        inventory: isVoiceCommerceTestMode() ? "simulated" : "telnyx",
        provisioning: isVoiceCommerceTestMode() ? "shared_test_route" : "telnyx",
        realInboundAvailable: !isVoiceCommerceTestMode(),
      },
      purchaseReadiness,
      numberConnection: {
        canBuy: ctx.ownerLike,
        canConnectExisting: ctx.ownerLike,
        methods: ["sip_byoc", "forwarding", "porting"],
      },
      quoteTtlSeconds: Math.round(getQuoteTtlMs() / 1000),
      bundleCatalog: getVoiceBundleCatalog(),
      pricing: {
        aiConnectedCallPriceMinor: getAiConnectedCallPriceMinor(),
        aiConnectedCallCurrency: getAiConnectedCallCurrency(),
        connectedCallBillingUnit: "connected_call",
      },
      billing: {
        type: "initial_activation",
        includesFirstMonthProviderCost: true,
        recurringRenewalCheckoutImplemented: false,
      },
    };
  }

  async function searchAvailableNumbers(user, input = {}) {
    const ctx = assertPurchaser(user);

    const countryCode = clean(input.countryCode || input.country || "US")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2);
    if (countryCode.length !== 2) {
      throw httpError(400, "A two-letter country code is required.");
    }

    if (isVoiceCommerceTestMode()) {
      const limit = clampInteger(input.limit, 8, 1, 12);
      const quoteId = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + getQuoteTtlMs()).toISOString();
      const items = buildTestNumberInventory(input, limit);

      store.update((draft) => {
        ensureStateShape(draft);
        draft.voiceNumberQuotes.unshift({
          id: quoteId,
          workspaceId: ctx.workspaceId,
          userId: clean(user?.id),
          countryCode,
          callingMode: normalizeCallingMode(input.callingMode),
          search: sanitizeSearch(input),
          items,
          testMode: true,
          createdAt: now.toISOString(),
          expiresAt,
        });
        if (draft.voiceNumberQuotes.length > 500) draft.voiceNumberQuotes.splice(500);
      });

      return {
        ok: true,
        quoteId,
        expiresAt,
        items,
        callingMode: normalizeCallingMode(input.callingMode),
        testMode: true,
        pricingNote:
          "Sandbox inventory is simulated for QA. Safepay checkout/webhooks remain real sandbox events; no Telnyx number is purchased.",
      };
    }

    requireTelnyxCommerceApiKey();
    const limit = clampInteger(input.limit, 12, 1, 25);
    const params = new URLSearchParams();
    params.set("filter[country_code]", countryCode);
    params.set("filter[limit]", String(limit));
    params.set("filter[features]", "voice");
    if (clean(input.areaCode || input.nationalDestinationCode)) {
      params.set(
        "filter[national_destination_code]",
        clean(input.areaCode || input.nationalDestinationCode).replace(/\D/g, "").slice(0, 8)
      );
    }
    if (clean(input.locality)) {
      params.set("filter[locality]", clean(input.locality).slice(0, 100));
    }
    if (clean(input.administrativeArea || input.state)) {
      params.set(
        "filter[administrative_area]",
        clean(input.administrativeArea || input.state).slice(0, 100)
      );
    }
    if (clean(input.phoneNumberType || input.type)) {
      params.set(
        "filter[phone_number_type]",
        normalizeStatus(input.phoneNumberType || input.type)
      );
    }

    const response = await telnyxRequest(
      `/available_phone_numbers?${params.toString()}`
    );
    const providerItems = Array.isArray(response?.data) ? response.data : [];
    const quoteId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + getQuoteTtlMs()).toISOString();
    const setupFeeMinor = nonNegativeInteger(
      process.env.VOICE_NUMBER_SETUP_FEE_MINOR,
      0
    );
    const markupMinor = nonNegativeInteger(
      process.env.VOICE_NUMBER_MARKUP_MINOR,
      0
    );

    const items = providerItems.map((item) => {
      const cost = item?.cost_information || {};
      const currency = clean(cost.currency || "USD").toUpperCase();
      const upfrontMinor = decimalMoneyToMinor(cost.upfront_cost);
      const monthlyMinor = decimalMoneyToMinor(cost.monthly_cost);
      const amountMinor = Math.max(
        1,
        upfrontMinor + monthlyMinor + setupFeeMinor + markupMinor
      );
      return {
        phoneNumber: normalizePhone(item.phone_number),
        vanityFormat: clean(item.vanity_format),
        quickship: Boolean(item.quickship),
        reservable: Boolean(item.reservable),
        bestEffort: Boolean(item.best_effort),
        regionInformation: Array.isArray(item.region_information)
          ? item.region_information.slice(0, 10).map((region) => ({
              type: clean(region?.region_type),
              name: clean(region?.region_name),
            }))
          : [],
        features: Array.isArray(item.features)
          ? item.features.map((feature) => clean(feature?.name)).filter(Boolean)
          : [],
        currency,
        providerUpfrontMinor: upfrontMinor,
        providerMonthlyMinor: monthlyMinor,
        setupFeeMinor,
        markupMinor,
        initialChargeMinor: amountMinor,
        bundles: getVoiceBundleCatalog()
          .filter((bundle) => bundle.currency === currency)
          .map((bundle) => ({
            ...bundle,
            numberInitialChargeMinor: amountMinor,
            totalInitialChargeMinor: amountMinor + bundle.callCreditAmountMinor,
          })),
      };
    }).filter((item) => item.phoneNumber);

    store.update((draft) => {
      ensureStateShape(draft);
      const quote = {
        id: quoteId,
        workspaceId: ctx.workspaceId,
        userId: clean(user?.id),
        countryCode,
        callingMode: normalizeCallingMode(input.callingMode),
        search: sanitizeSearch(input),
        items,
        createdAt: now.toISOString(),
        expiresAt,
      };
      draft.voiceNumberQuotes.unshift(quote);
      if (draft.voiceNumberQuotes.length > 500) draft.voiceNumberQuotes.splice(500);
    });

    return {
      ok: true,
      quoteId,
      expiresAt,
      items,
      callingMode: normalizeCallingMode(input.callingMode),
      pricingNote:
        "Initial checkout includes the provider upfront cost, the first provider monthly charge, and any server-configured ReachFly setup/markup fee.",
    };
  }

  async function createNumberCheckout(user, input = {}) {
    const ctx = assertPurchaser(user);
    assertNumberCheckoutReady();
    const quoteId = clean(input.quoteId);
    const phoneNumber = normalizePhone(input.phoneNumber);
    if (!quoteId || !phoneNumber) {
      throw httpError(400, "quoteId and phoneNumber are required.");
    }

    const state = store.read();
    const quote = (state.voiceNumberQuotes || []).find(
      (item) => item.id === quoteId && item.workspaceId === ctx.workspaceId
    );
    if (!quote) {
      throw httpError(404, "The phone-number quote was not found.", "NUMBER_QUOTE_NOT_FOUND");
    }
    if (Date.parse(quote.expiresAt || "") <= Date.now()) {
      throw httpError(409, "This phone-number quote has expired. Search again before checkout.", "NUMBER_QUOTE_EXPIRED");
    }
    const item = (quote.items || []).find(
      (candidate) => normalizePhone(candidate.phoneNumber) === phoneNumber
    );
    if (!item) {
      throw httpError(404, "The selected number is not part of this quote.", "NUMBER_NOT_IN_QUOTE");
    }

    const alreadyOwned = (state.voicePhoneNumbers || []).find(
      (number) =>
        number.workspaceId === ctx.workspaceId &&
        normalizePhone(number.phoneNumber) === phoneNumber &&
        ["active", "pending_activation", "provisioning"].includes(
          normalizeStatus(number.status)
        )
    );
    if (alreadyOwned) {
      throw httpError(409, "This workspace already has this business number.", "NUMBER_ALREADY_OWNED");
    }

    const existingPending = (state.voiceNumberOrders || []).find(
      (order) =>
        order.workspaceId === ctx.workspaceId &&
        normalizePhone(order.phoneNumber) === phoneNumber &&
        ["creating", "payment_pending", "paid", "provisioning", "pending_activation", "active"].includes(
          normalizeStatus(order.status)
        )
    );
    if (existingPending) {
      if (existingPending.checkoutUrl && existingPending.status === "payment_pending") {
        return { ok: true, reused: true, checkoutUrl: existingPending.checkoutUrl, order: publicOrder(existingPending) };
      }
      throw httpError(409, "A purchase already exists for this business number.", "NUMBER_ORDER_EXISTS");
    }

    const now = new Date().toISOString();

    // Payment retries must reuse the most recent unpaid failed order for this
    // workspace + phone number. Creating a fresh order on every declined card
    // produced duplicate rows and made recovery confusing.
    const reusableFailedOrder = (state.voiceNumberOrders || [])
      .filter(
        (candidate) =>
          candidate.workspaceId === ctx.workspaceId &&
          normalizePhone(candidate.phoneNumber) === phoneNumber &&
          normalizeStatus(candidate.status) === "payment_failed" &&
          !candidate.paidAt &&
          !candidate.telnyxOrderId
      )
      .sort(byNewest)[0] || null;

    const order = {
      ...(reusableFailedOrder || {}),
      id: reusableFailedOrder?.id || crypto.randomUUID(),
      workspaceId: ctx.workspaceId,
      userId: clean(user?.id),
      quoteId,
      phoneNumber,
      callingMode: normalizeCallingMode(input.callingMode || quote.callingMode),
      source: "reachfly_purchase",
      currency: clean(item.currency || "USD").toUpperCase(),
      amountMinor: Math.round(Number(item.initialChargeMinor || 0)),
      providerUpfrontMinor: Math.round(Number(item.providerUpfrontMinor || 0)),
      providerMonthlyMinor: Math.round(Number(item.providerMonthlyMinor || 0)),
      setupFeeMinor: Math.round(Number(item.setupFeeMinor || 0)),
      markupMinor: Math.round(Number(item.markupMinor || 0)),
      provider: item.testMode ? "test_telnyx" : "telnyx",
      testMode: Boolean(item.testMode || quote.testMode),
      paymentProvider: "safepay",
      providerTracker: "",
      checkoutUrl: "",
      checkoutCreatedAt: "",
      telnyxOrderId: "",
      elevenLabsPhoneNumberId: "",
      status: "creating",
      error: "",
      paymentFailureCode: "",
      paymentFailureCategory: "",
      paymentFailureAction: "",
      paymentFailureRetryable: true,
      paymentFailedAt: "",
      retryCount: Number(reusableFailedOrder?.retryCount || 0) +
        (reusableFailedOrder ? 1 : 0),
      lastRetryAt: reusableFailedOrder ? now : "",
      createdAt: reusableFailedOrder?.createdAt || now,
      updatedAt: now,
    };

    if (!order.amountMinor || order.amountMinor <= 0) {
      throw httpError(422, "The number checkout amount is not configured.", "NUMBER_PRICE_NOT_CONFIGURED");
    }

    store.update((draft) => {
      ensureStateShape(draft);
      if (reusableFailedOrder) {
        const target = draft.voiceNumberOrders.find(
          (candidate) => candidate.id === reusableFailedOrder.id
        );
        if (target) Object.assign(target, order);
      } else {
        draft.voiceNumberOrders.unshift(order);
      }
    });

    try {
      const returnPath = normalizeReturnPath(
        input.returnPath ||
          "/app/voice-agent?onboarding=1&tab=setup&view=buy-numbers"
      );
      const checkout = await createSafepayCheckout({
        amountMinor: order.amountMinor,
        currency: order.currency,
        orderId: order.id,
        redirectUrl: buildReturnUrl(returnPath, {
          numberPayment: "success",
          order: order.id,
        }),
        cancelUrl: buildReturnUrl(returnPath, {
          numberPayment: "cancelled",
          order: order.id,
        }),
        metadata: {
          order_id: order.id,
        },
      });

      let updated = null;
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find((candidate) => candidate.id === order.id);
        if (!target) return;
        target.providerTracker = checkout.tracker;
        target.checkoutUrl = checkout.checkoutUrl;
        target.checkoutCreatedAt = new Date().toISOString();
        target.status = "payment_pending";
        target.updatedAt = target.checkoutCreatedAt;
        updated = { ...target };
      });

      return {
        ok: true,
        checkoutUrl: checkout.checkoutUrl,
        order: publicOrder(updated || order),
      };
    } catch (error) {
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find((candidate) => candidate.id === order.id);
        if (!target) return;
        target.status = "payment_failed";
        target.error = clean(error?.message || String(error)).slice(0, 1200);
        target.updatedAt = new Date().toISOString();
      });
      throw httpError(
        error?.statusCode || 502,
        error?.message || "Could not create business-number checkout.",
        "VOICE_NUMBER_CHECKOUT_FAILED"
      );
    }
  }

  async function createBundleCheckout(user, input = {}) {
    const ctx = assertPurchaser(user);
    assertNumberCheckoutReady();
    const quoteId = clean(input.quoteId);
    const phoneNumber = normalizePhone(input.phoneNumber);
    const bundleId = clean(input.bundleId);
    if (!quoteId || !phoneNumber || !bundleId) {
      throw httpError(400, "quoteId, phoneNumber and bundleId are required.");
    }

    const state = store.read();
    const quote = (state.voiceNumberQuotes || []).find(
      (item) => item.id === quoteId && item.workspaceId === ctx.workspaceId
    );
    if (!quote) {
      throw httpError(404, "The phone-number quote was not found.", "NUMBER_QUOTE_NOT_FOUND");
    }
    if (Date.parse(quote.expiresAt || "") <= Date.now()) {
      throw httpError(
        409,
        "This phone-number quote has expired. Search again before checkout.",
        "NUMBER_QUOTE_EXPIRED"
      );
    }

    const item = (quote.items || []).find(
      (candidate) => normalizePhone(candidate.phoneNumber) === phoneNumber
    );
    if (!item) {
      throw httpError(
        404,
        "The selected number is not part of this quote.",
        "NUMBER_NOT_IN_QUOTE"
      );
    }

    const bundle = getVoiceBundleCatalog().find(
      (candidate) => candidate.id === bundleId && candidate.active !== false
    );
    if (!bundle) {
      throw httpError(
        422,
        "This Voice Agent bundle is not available.",
        "VOICE_BUNDLE_NOT_CONFIGURED"
      );
    }
    if (bundle.currency !== clean(item.currency || "USD").toUpperCase()) {
      throw httpError(
        422,
        "The selected bundle currency does not match the phone-number quote.",
        "VOICE_BUNDLE_CURRENCY_MISMATCH"
      );
    }

    const alreadyOwned = (state.voicePhoneNumbers || []).find(
      (number) =>
        number.workspaceId === ctx.workspaceId &&
        normalizePhone(number.phoneNumber) === phoneNumber &&
        ["active", "pending_activation", "provisioning"].includes(
          normalizeStatus(number.status)
        )
    );
    if (alreadyOwned) {
      throw httpError(
        409,
        "This workspace already has this business number.",
        "NUMBER_ALREADY_OWNED"
      );
    }

    const existingPending = (state.voiceNumberOrders || []).find(
      (order) =>
        order.workspaceId === ctx.workspaceId &&
        normalizePhone(order.phoneNumber) === phoneNumber &&
        ["creating", "payment_pending", "paid", "provisioning", "pending_activation", "active"].includes(
          normalizeStatus(order.status)
        )
    );
    if (existingPending) {
      if (
        existingPending.checkoutUrl &&
        normalizeStatus(existingPending.status) === "payment_pending" &&
        existingPending.productType === "voice_bundle" &&
        existingPending.bundleId === bundle.id
      ) {
        return {
          ok: true,
          reused: true,
          checkoutUrl: existingPending.checkoutUrl,
          order: publicOrder(existingPending),
        };
      }
      throw httpError(
        409,
        "A purchase already exists for this business number.",
        "NUMBER_ORDER_EXISTS"
      );
    }

    const numberAmountMinor = Math.round(Number(item.initialChargeMinor || 0));
    const callCreditAmountMinor = Math.round(Number(bundle.callCreditAmountMinor || 0));
    const amountMinor = numberAmountMinor + callCreditAmountMinor;
    if (!numberAmountMinor || numberAmountMinor <= 0 || !callCreditAmountMinor) {
      throw httpError(
        422,
        "The Voice Agent bundle price is not configured.",
        "VOICE_BUNDLE_PRICE_NOT_CONFIGURED"
      );
    }

    const now = new Date().toISOString();
    const order = {
      id: crypto.randomUUID(),
      workspaceId: ctx.workspaceId,
      userId: clean(user?.id),
      quoteId,
      phoneNumber,
      currency: clean(item.currency || "USD").toUpperCase(),
      productType: "voice_bundle",
      bundleId: bundle.id,
      bundleLabel: bundle.label,
      aiCallCredits: bundle.credits,
      numberAmountMinor,
      callCreditAmountMinor,
      amountMinor,
      providerUpfrontMinor: Math.round(Number(item.providerUpfrontMinor || 0)),
      providerMonthlyMinor: Math.round(Number(item.providerMonthlyMinor || 0)),
      setupFeeMinor: Math.round(Number(item.setupFeeMinor || 0)),
      markupMinor: Math.round(Number(item.markupMinor || 0)),
      provider: "telnyx",
      paymentProvider: "safepay",
      providerTracker: "",
      telnyxOrderId: "",
      elevenLabsPhoneNumberId: "",
      status: "creating",
      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      ensureStateShape(draft);
      draft.voiceNumberOrders.unshift(order);
    });

    try {
      const returnPath = normalizeReturnPath(
        input.returnPath ||
          "/app/voice-agent?onboarding=1&tab=setup&view=buy-numbers"
      );
      const checkout = await createSafepayCheckout({
        amountMinor: order.amountMinor,
        currency: order.currency,
        orderId: order.id,
        redirectUrl: buildReturnUrl(returnPath, {
          numberPayment: "success",
          order: order.id,
        }),
        cancelUrl: buildReturnUrl(returnPath, {
          numberPayment: "cancelled",
          order: order.id,
        }),
        metadata: {
          order_id: order.id,
        },
      });

      let updated = null;
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find(
          (candidate) => candidate.id === order.id
        );
        if (!target) return;
        target.providerTracker = checkout.tracker;
        target.checkoutUrl = checkout.checkoutUrl;
        target.checkoutCreatedAt = new Date().toISOString();
        target.status = "payment_pending";
        target.updatedAt = target.checkoutCreatedAt;
        updated = { ...target };
      });

      return {
        ok: true,
        checkoutUrl: checkout.checkoutUrl,
        order: publicOrder(updated || order),
      };
    } catch (error) {
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find(
          (candidate) => candidate.id === order.id
        );
        if (!target) return;
        target.status = "payment_failed";
        target.error = clean(error?.message || String(error)).slice(0, 1200);
        target.updatedAt = new Date().toISOString();
      });
      throw httpError(
        error?.statusCode || 502,
        error?.message || "Could not create Voice Agent bundle checkout.",
        "VOICE_BUNDLE_CHECKOUT_FAILED"
      );
    }
  }

  function getOrder(user, orderId) {
    const ctx = getContext(user);
    if (!ctx.workspaceId) throw httpError(401, "Workspace could not be resolved.");
    const order = (store.read().voiceNumberOrders || []).find(
      (item) => item.id === clean(orderId) && item.workspaceId === ctx.workspaceId
    );
    if (!order) throw httpError(404, "Business-number order not found.");
    return publicOrder(order);
  }

  async function retryProvision(user, orderId) {
    const ctx = assertPurchaser(user);
    const order = (store.read().voiceNumberOrders || []).find(
      (item) => item.id === clean(orderId) && item.workspaceId === ctx.workspaceId
    );
    if (!order) throw httpError(404, "Business-number order not found.");
    if (!order.paidAt) {
      throw httpError(409, "The business-number order has not been paid.", "NUMBER_ORDER_NOT_PAID");
    }
    if (order.status === "active") return publicOrder(order);
    return publicOrder(await provisionNumber(order.id));
  }

  async function handleVerifiedSafepayEvent({ event, eventId, eventType } = {}) {
    const data = event?.data || {};
    const metadata = data.metadata || {};
    const orderId = clean(metadata.order_id || metadata.orderId);
    const tracker = clean(data.tracker);
    const state = store.read();
    const order = (state.voiceNumberOrders || []).find(
      (item) =>
        (orderId && item.id === orderId) ||
        (tracker && item.providerTracker === tracker)
    );
    if (!order) return { matched: false };

    if (eventType === "payment.failed") {
      const failure = normalizeSafepayFailure(data);
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find((item) => item.id === order.id);
        if (!target || target.status === "active") return;
        target.status = "payment_failed";
        target.error = failure.message;
        target.paymentFailureCode = failure.code;
        target.paymentFailureCategory = failure.category;
        target.paymentFailureRetryable = failure.retryable;
        target.paymentFailureAction = failure.action;
        target.paymentFailedAt = new Date().toISOString();
        target.updatedAt = target.paymentFailedAt;
      });
      return {
        matched: true,
        orderId: order.id,
        status: "payment_failed",
        paymentFailure: failure,
      };
    }

    if (eventType === "payment.refunded") {
      if (order.productType === "voice_bundle" && order.creditsGrantedAt) {
        reverseBundleAiCredits(order, tracker, eventId);
      }
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find((item) => item.id === order.id);
        if (!target) return;
        target.refundEventId = clean(eventId);
        target.refundedAt = new Date().toISOString();
        target.status = target.telnyxOrderId ? "refund_review_required" : "refunded";
        target.updatedAt = target.refundedAt;
      });
      return {
        matched: true,
        orderId: order.id,
        status: order.telnyxOrderId ? "refund_review_required" : "refunded",
      };
    }

    if (eventType !== "payment.succeeded") {
      return { matched: true, orderId: order.id, ignored: true, eventType };
    }

    if (Number(data.amount) && Number(data.amount) !== Number(order.amountMinor)) {
      throw httpError(409, "Safepay amount does not match the business-number order.", "SAFEPAY_AMOUNT_MISMATCH");
    }
    if (
      clean(data.currency).toUpperCase() &&
      clean(data.currency).toUpperCase() !== clean(order.currency).toUpperCase()
    ) {
      throw httpError(409, "Safepay currency does not match the business-number order.", "SAFEPAY_CURRENCY_MISMATCH");
    }

    let paidOrder = null;
    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.voiceNumberOrders.find((item) => item.id === order.id);
      if (!target) return;
      const now = new Date().toISOString();
      if (!target.paidAt) target.paidAt = now;
      target.paymentEventId = clean(eventId);
      target.providerTracker = tracker || target.providerTracker;
      if (target.status !== "active") target.status = "paid";
      target.updatedAt = now;
      appendActivity(draft, {
        workspaceId: target.workspaceId,
        actorId: target.userId,
        type: "voice_number_payment_succeeded",
        title: `Business number payment received for ${target.phoneNumber}`,
        createdAt: now,
      });
      paidOrder = { ...target };
    });

    if (
      paidOrder?.productType === "voice_bundle" &&
      Number(paidOrder.aiCallCredits || 0) > 0
    ) {
      grantBundleAiCredits(paidOrder, tracker, eventId);
      paidOrder = (store.read().voiceNumberOrders || []).find(
        (item) => item.id === order.id
      ) || paidOrder;
    }

    if (paidOrder?.status === "active") {
      return {
        matched: true,
        orderId: order.id,
        duplicatePurchase: true,
        status: "active",
        aiCallCredits: Number(paidOrder.aiCallCredits || 0),
      };
    }

    const provisioned = await provisionNumber(order.id);
    return {
      matched: true,
      orderId: order.id,
      status: provisioned.status,
      phoneNumber: provisioned.phoneNumber,
      telnyxOrderId: provisioned.telnyxOrderId || "",
      elevenLabsPhoneNumberId: provisioned.elevenLabsPhoneNumberId || "",
    };
  }

  async function activateTestNumber(orderId) {
    const phoneNumberId = clean(
      process.env.VOICE_TEST_CALL_PHONE_NUMBER_ID ||
        process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID
    );
    const routingPhoneNumber = normalizePhone(
      process.env.VOICE_TEST_CALL_FROM_NUMBER ||
        process.env.TELNYX_AI_AGENT_FROM_NUMBER ||
        String(process.env.TELNYX_AI_AGENT_FROM_NUMBERS || "").split(",")[0]
    );

    if (!phoneNumberId || !routingPhoneNumber) {
      throw httpError(
        503,
        "VOICE_TEST_CALL_FROM_NUMBER and VOICE_TEST_CALL_PHONE_NUMBER_ID (or the existing ElevenLabs phone ID) are required for sandbox Voice Agent calling.",
        "VOICE_TEST_ROUTE_NOT_CONFIGURED"
      );
    }

    let activeOrder = null;
    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.voiceNumberOrders.find((item) => item.id === orderId);
      if (!target) return;
      const now = new Date().toISOString();
      target.status = "active";
      target.provider = "test_telnyx";
      target.testMode = true;
      target.telnyxOrderId = target.telnyxOrderId || `sandbox_${target.id}`;
      target.telnyxPhoneStatus = "test_active";
      target.requirementsMet = true;
      target.elevenLabsPhoneNumberId = phoneNumberId;
      target.testRoutingPhoneNumber = routingPhoneNumber;
      target.activatedAt = target.activatedAt || now;
      target.updatedAt = now;

      let number = draft.voicePhoneNumbers.find(
        (item) =>
          item.workspaceId === target.workspaceId &&
          normalizePhone(item.phoneNumber) === normalizePhone(target.phoneNumber)
      );
      if (!number) {
        number = {
          id: crypto.randomUUID(),
          workspaceId: target.workspaceId,
          orderId: target.id,
          phoneNumber: target.phoneNumber,
          countryCode: inferCountryCodeFromQuote(draft, target.quoteId),
          provider: "test_telnyx",
          source: "reachfly_purchase",
          testMode: true,
          callingMode: normalizeCallingMode(target.callingMode),
          inboundEnabled: callingModeIncludesInbound(target.callingMode),
          outboundEnabled: callingModeIncludesOutbound(target.callingMode),
          inboundStatus: callingModeIncludesInbound(target.callingMode)
            ? "sandbox_simulated"
            : "disabled",
          outboundStatus: callingModeIncludesOutbound(target.callingMode)
            ? "active_shared_test_route"
            : "disabled",
          ownershipVerified: true,
          testRoutingPhoneNumber: routingPhoneNumber,
          telnyxOrderId: target.telnyxOrderId,
          telnyxConnectionId: "shared_test_route",
          elevenLabsPhoneNumberId: phoneNumberId,
          status: "active",
          purchasedBy: target.userId,
          purchasedAt: target.paidAt,
          activatedAt: target.activatedAt,
          providerMonthlyMinor: 0,
          currency: target.currency,
          createdAt: now,
          updatedAt: now,
        };
        draft.voicePhoneNumbers.unshift(number);
      } else {
        number.status = "active";
        number.testMode = true;
        number.provider = "test_telnyx";
        number.source = number.source || "reachfly_purchase";
        number.callingMode = normalizeCallingMode(target.callingMode);
        number.inboundEnabled = callingModeIncludesInbound(target.callingMode);
        number.outboundEnabled = callingModeIncludesOutbound(target.callingMode);
        number.inboundStatus = number.inboundEnabled ? "sandbox_simulated" : "disabled";
        number.outboundStatus = number.outboundEnabled ? "active_shared_test_route" : "disabled";
        number.ownershipVerified = true;
        number.orderId = target.id;
        number.testRoutingPhoneNumber = routingPhoneNumber;
        number.elevenLabsPhoneNumberId = phoneNumberId;
        number.updatedAt = now;
      }

      appendActivity(draft, {
        workspaceId: target.workspaceId,
        actorId: target.userId,
        type: "voice_test_number_activated",
        title: `Sandbox business number ${target.phoneNumber} activated`,
        detail: "QA calls route through the configured shared ReachFly test caller.",
        createdAt: now,
      });
      activeOrder = { ...target };
    });

    if (!activeOrder) {
      throw httpError(404, "Sandbox business-number order not found.");
    }

    emit({
      workspaceId: activeOrder.workspaceId,
      event: "voice-commerce:number-active",
      payload: {
        order: publicOrder(activeOrder),
        phoneNumber: activeOrder.phoneNumber,
        testMode: true,
      },
    });

    return activeOrder;
  }

  async function provisionNumber(orderId) {
    let order = (store.read().voiceNumberOrders || []).find((item) => item.id === orderId);
    if (!order) throw httpError(404, "Business-number order not found.");
    if (!order.paidAt) throw httpError(409, "Business-number order must be paid before provisioning.");
    if (order.status === "active") return order;

    const provisioningToken = crypto.randomUUID();
    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.voiceNumberOrders.find((item) => item.id === orderId);
      if (!target) return;
      target.status = "provisioning";
      target.provisioningToken = provisioningToken;
      target.provisioningAt = new Date().toISOString();
      target.updatedAt = target.provisioningAt;
    });

    try {
      order = (store.read().voiceNumberOrders || []).find((item) => item.id === orderId) || order;
      if (order.testMode === true && isVoiceCommerceTestMode()) {
        return await activateTestNumber(orderId);
      }

      let telnyxOrderId = clean(order.telnyxOrderId);
      let telnyxPhoneStatus = clean(order.telnyxPhoneStatus);
      let requirementsMet = order.requirementsMet;

      if (!telnyxOrderId) {
        const telnyxResponse = await telnyxRequest("/number_orders", {
          method: "POST",
          body: {
            connection_id: resolveTelnyxConnectionId(true),
            customer_reference: `reachfly:${order.workspaceId}:${order.id}`.slice(0, 128),
            phone_numbers: [{ phone_number: order.phoneNumber }],
          },
        });
        const providerOrder = telnyxResponse?.data || {};
        const providerPhone = Array.isArray(providerOrder.phone_numbers)
          ? providerOrder.phone_numbers.find(
              (item) => normalizePhone(item?.phone_number) === normalizePhone(order.phoneNumber)
            ) || providerOrder.phone_numbers[0]
          : null;
        telnyxOrderId = clean(providerOrder.id);
        telnyxPhoneStatus = normalizeStatus(
          providerPhone?.status || providerOrder?.status || "pending"
        );
        requirementsMet = providerPhone?.requirements_met ?? providerOrder.requirements_met ?? null;

        store.update((draft) => {
          ensureStateShape(draft);
          const target = draft.voiceNumberOrders.find((item) => item.id === orderId);
          if (!target) return;
          target.telnyxOrderId = telnyxOrderId;
          target.telnyxPhoneStatus = telnyxPhoneStatus;
          target.requirementsMet = requirementsMet;
          target.telnyxOrderedAt = new Date().toISOString();
          target.updatedAt = target.telnyxOrderedAt;
        });
      } else if (telnyxPhoneStatus !== "success") {
        // Re-check an existing provider order instead of creating a duplicate.
        // This is how paid orders that were initially pending regulatory or
        // provider activation can later progress to active on Retry provisioning.
        const telnyxResponse = await telnyxRequest(
          `/number_orders/${encodeURIComponent(telnyxOrderId)}`
        );
        const providerOrder = telnyxResponse?.data || {};
        const providerPhone = Array.isArray(providerOrder.phone_numbers)
          ? providerOrder.phone_numbers.find(
              (item) => normalizePhone(item?.phone_number) === normalizePhone(order.phoneNumber)
            ) || providerOrder.phone_numbers[0]
          : null;
        telnyxPhoneStatus = normalizeStatus(
          providerPhone?.status || providerOrder?.status || telnyxPhoneStatus || "pending"
        );
        requirementsMet = providerPhone?.requirements_met ?? providerOrder.requirements_met ?? requirementsMet;

        store.update((draft) => {
          ensureStateShape(draft);
          const target = draft.voiceNumberOrders.find((item) => item.id === orderId);
          if (!target) return;
          target.telnyxPhoneStatus = telnyxPhoneStatus;
          target.requirementsMet = requirementsMet;
          target.telnyxStatusCheckedAt = new Date().toISOString();
          target.updatedAt = target.telnyxStatusCheckedAt;
        });
      }

      if (telnyxPhoneStatus && telnyxPhoneStatus !== "success") {
        const pendingStatus =
          telnyxPhoneStatus === "failure" ? "provision_failed" : "pending_activation";
        store.update((draft) => {
          ensureStateShape(draft);
          const target = draft.voiceNumberOrders.find((item) => item.id === orderId);
          if (!target) return;
          target.status = pendingStatus;
          target.updatedAt = new Date().toISOString();
        });
        return (store.read().voiceNumberOrders || []).find((item) => item.id === orderId);
      }

      order = (store.read().voiceNumberOrders || []).find((item) => item.id === orderId) || order;
      let elevenLabsPhoneNumberId = clean(order.elevenLabsPhoneNumberId);
      if (!elevenLabsPhoneNumberId) {
        elevenLabsPhoneNumberId = await importNumberIntoElevenLabs(order);
      }

      let activeOrder = null;
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find((item) => item.id === orderId);
        if (!target) return;
        const now = new Date().toISOString();
        target.elevenLabsPhoneNumberId = elevenLabsPhoneNumberId;
        target.status = "active";
        target.activatedAt = target.activatedAt || now;
        target.updatedAt = now;

        let number = draft.voicePhoneNumbers.find(
          (item) =>
            item.workspaceId === target.workspaceId &&
            normalizePhone(item.phoneNumber) === normalizePhone(target.phoneNumber)
        );
        if (!number) {
          number = {
            id: crypto.randomUUID(),
            workspaceId: target.workspaceId,
            orderId: target.id,
            phoneNumber: target.phoneNumber,
            countryCode: inferCountryCodeFromQuote(draft, target.quoteId),
            telnyxOrderId: target.telnyxOrderId,
            telnyxConnectionId: resolveTelnyxConnectionId(false),
            elevenLabsPhoneNumberId,
            status: "active",
            purchasedBy: target.userId,
            purchasedAt: target.paidAt,
            activatedAt: target.activatedAt,
            providerMonthlyMinor: target.providerMonthlyMinor,
            currency: target.currency,
            createdAt: now,
            updatedAt: now,
          };
          draft.voicePhoneNumbers.unshift(number);
        } else {
          number.status = "active";
          number.source = number.source || "reachfly_purchase";
          number.callingMode = normalizeCallingMode(target.callingMode);
          number.inboundEnabled = callingModeIncludesInbound(target.callingMode);
          number.outboundEnabled = callingModeIncludesOutbound(target.callingMode);
          number.inboundStatus = number.inboundEnabled ? "active" : "disabled";
          number.outboundStatus = number.outboundEnabled ? "active" : "disabled";
          number.ownershipVerified = true;
          number.orderId = target.id;
          number.telnyxOrderId = target.telnyxOrderId;
          number.telnyxConnectionId = resolveTelnyxConnectionId(false);
          number.elevenLabsPhoneNumberId = elevenLabsPhoneNumberId;
          number.updatedAt = now;
        }

        appendActivity(draft, {
          workspaceId: target.workspaceId,
          actorId: target.userId,
          type: "voice_number_activated",
          title: `Business number ${target.phoneNumber} activated for AI calling`,
          createdAt: now,
        });
        activeOrder = { ...target };
      });

      emit({
        workspaceId: activeOrder.workspaceId,
        event: "voice-commerce:number-active",
        payload: { order: publicOrder(activeOrder), phoneNumber: activeOrder.phoneNumber },
      });

      return activeOrder;
    } catch (error) {
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voiceNumberOrders.find((item) => item.id === orderId);
        if (!target) return;
        target.status = "provision_failed";
        target.error = clean(error?.message || String(error)).slice(0, 1600);
        target.updatedAt = new Date().toISOString();
      });
      return (store.read().voiceNumberOrders || []).find((item) => item.id === orderId);
    }
  }

  async function importNumberIntoElevenLabs(order) {
    const apiKey = requireEnv("ELEVENLABS_API_KEY");
    const outboundAddress = clean(
      process.env.ELEVENLABS_TELNYX_SIP_ADDRESS || "sip.telnyx.com"
    );
    const transport = normalizeStatus(
      process.env.ELEVENLABS_TELNYX_SIP_TRANSPORT || "tcp"
    );
    const mediaEncryption = normalizeStatus(
      process.env.ELEVENLABS_TELNYX_SIP_MEDIA_ENCRYPTION || "disabled"
    );
    const username = clean(process.env.ELEVENLABS_TELNYX_SIP_USERNAME);
    const password = clean(process.env.ELEVENLABS_TELNYX_SIP_PASSWORD);
    const inboundTrunkConfig = {
      transport,
      media_encryption: mediaEncryption,
    };
    const outboundTrunkConfig = {
      address: outboundAddress,
      transport,
      media_encryption: mediaEncryption,
    };
    if (username && password) {
      outboundTrunkConfig.credentials = { username, password };
    }

    // Import is idempotent. A provider request may succeed even if ReachFly is
    // interrupted before persisting the returned ID, so first reuse an existing
    // SIP-trunk number with the exact E.164 identity when one already exists.
    let phoneNumberId = "";
    try {
      const existingNumbers = await elevenLabsRequest(
        "/v1/convai/phone-numbers?provider=sip_trunk",
        { apiKey }
      );
      const list = Array.isArray(existingNumbers)
        ? existingNumbers
        : Array.isArray(existingNumbers?.phone_numbers)
          ? existingNumbers.phone_numbers
          : [];
      const existing = list.find(
        (item) =>
          normalizePhone(item?.phone_number) ===
          normalizePhone(order.phoneNumber)
      );
      phoneNumberId = clean(
        existing?.phone_number_id ||
          existing?.phoneNumberId ||
          existing?.id
      );
    } catch {
      // Listing is an idempotency optimization. If the key cannot list numbers
      // but can import them, continue with the normal create request.
    }

    if (!phoneNumberId) {
      const createResponse = await elevenLabsRequest("/v1/convai/phone-numbers", {
        method: "POST",
        apiKey,
        body: {
          phone_number: order.phoneNumber,
          label: `ReachFly ${order.phoneNumber}`,
          provider: "sip_trunk",
          inbound_trunk_config: inboundTrunkConfig,
          outbound_trunk_config: outboundTrunkConfig,
          livekit_stack: clean(process.env.ELEVENLABS_SIP_LIVEKIT_STACK) || "standard",
        },
      });
      phoneNumberId = clean(
        createResponse?.phone_number_id || createResponse?.phoneNumberId
      );
    }

    if (!phoneNumberId) {
      throw new Error("ElevenLabs did not return a phone number ID after SIP-trunk import.");
    }

    const codesyncWorkspaceId = clean(
      process.env.CODESYNC_WORKSPACE_ID || "codesync-labs-workspace"
    );
    const agentId =
      clean(order.workspaceId) === codesyncWorkspaceId
        ? clean(process.env.ELEVENLABS_AGENT_ID)
        : "";

    // Codesync may keep the preconfigured shared/default agent. Customer
    // workspaces are imported without a provider-agent assignment; their own
    // managed ElevenLabs agent is created and linked during Voice Agent
    // activation. Reused SIP records are also refreshed with the current trunk
    // configuration so retries converge on the desired state.
    await elevenLabsRequest(
      `/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`,
      {
        method: "PATCH",
        apiKey,
        body: {
          ...(agentId ? { agent_id: agentId } : {}),
          label: `ReachFly ${order.phoneNumber}`,
          outbound_trunk_config: outboundTrunkConfig,
          livekit_stack:
            clean(process.env.ELEVENLABS_SIP_LIVEKIT_STACK) || "standard",
        },
      }
    );

    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.voiceNumberOrders.find((item) => item.id === order.id);
      if (!target) return;
      target.elevenLabsPhoneNumberId = phoneNumberId;
      target.elevenLabsImportedAt = new Date().toISOString();
      target.updatedAt = target.elevenLabsImportedAt;
    });
    return phoneNumberId;
  }


  function grantBundleAiCredits(order, tracker, eventId) {
    if (!order?.id || !order?.workspaceId) return { granted: false };
    const credits = Math.max(0, Math.round(Number(order.aiCallCredits || 0)));
    if (!credits) return { granted: false };

    let output = { granted: false, credits, duplicate: false };
    store.update((draft) => {
      ensureStateShape(draft);
      const targetOrder = draft.voiceNumberOrders.find(
        (item) => item.id === order.id
      );
      if (!targetOrder) return;
      if (targetOrder.creditsGrantedAt) {
        output.duplicate = true;
        return;
      }

      const now = new Date().toISOString();
      let wallet = draft.aiCallCreditWallets.find(
        (item) => item.workspaceId === order.workspaceId
      );
      if (!wallet) {
        wallet = {
          id: crypto.randomUUID(),
          workspaceId: order.workspaceId,
          balance: 0,
          debt: 0,
          totalGranted: 0,
          totalPurchased: 0,
          totalConsumed: 0,
          createdAt: now,
          updatedAt: now,
        };
        draft.aiCallCreditWallets.push(wallet);
      }

      const currentDebt = Math.max(0, Math.round(Number(wallet.debt || 0)));
      const debtPaid = Math.min(currentDebt, credits);
      const availableGrant = credits - debtPaid;
      wallet.debt = currentDebt - debtPaid;
      wallet.balance =
        Math.max(0, Math.round(Number(wallet.balance || 0))) + availableGrant;
      wallet.totalPurchased =
        Math.max(0, Math.round(Number(wallet.totalPurchased || 0))) + credits;
      wallet.updatedAt = now;

      const purchaseId = `voice-bundle:${targetOrder.id}`;
      if (!draft.aiCallCreditPurchases.some((item) => item.id === purchaseId)) {
        draft.aiCallCreditPurchases.unshift({
          id: purchaseId,
          workspaceId: targetOrder.workspaceId,
          userId: targetOrder.userId,
          packId: targetOrder.bundleId,
          credits,
          amountMinor: Number(targetOrder.callCreditAmountMinor || 0),
          currency: targetOrder.currency,
          walletType: "ai_call_credits",
          provider: "safepay",
          providerTracker: tracker || targetOrder.providerTracker || "",
          status: "succeeded",
          source: "voice_bundle",
          bundleOrderId: targetOrder.id,
          paidAt: targetOrder.paidAt || now,
          creditsGrantedAt: now,
          createdAt: targetOrder.createdAt || now,
          updatedAt: now,
        });
      }

      draft.aiCallCreditLedger.unshift({
        id: crypto.randomUUID(),
        workspaceId: targetOrder.workspaceId,
        purchaseId,
        type: "purchase",
        delta: availableGrant,
        balanceAfter: wallet.balance,
        provider: "safepay",
        providerTracker: tracker || targetOrder.providerTracker || "",
        description: `${credits} AI call credits purchased with Voice Agent bundle${
          debtPaid ? `; ${debtPaid} applied to AI call-credit debt` : ""
        }.`,
        createdAt: now,
      });
      if (draft.aiCallCreditLedger.length > 5000) {
        draft.aiCallCreditLedger.splice(5000);
      }

      targetOrder.creditsGrantedAt = now;
      targetOrder.creditPurchaseId = purchaseId;
      targetOrder.creditPaymentEventId = clean(eventId);
      targetOrder.updatedAt = now;

      appendActivity(draft, {
        workspaceId: targetOrder.workspaceId,
        actorId: targetOrder.userId,
        type: "voice_bundle_credits_granted",
        title: `${credits} AI call credits activated with business-number bundle`,
        detail: targetOrder.phoneNumber,
        orderId: targetOrder.id,
        createdAt: now,
      });

      output = {
        granted: true,
        credits,
        availableGrant,
        debtPaid,
        balance: wallet.balance,
      };
    });
    return output;
  }

  function reverseBundleAiCredits(order, tracker, eventId) {
    if (!order?.id || !order?.workspaceId) return { reversed: false };
    const credits = Math.max(0, Math.round(Number(order.aiCallCredits || 0)));
    if (!credits) return { reversed: false };

    let output = { reversed: false, credits, duplicate: false };
    store.update((draft) => {
      ensureStateShape(draft);
      const targetOrder = draft.voiceNumberOrders.find(
        (item) => item.id === order.id
      );
      if (!targetOrder || !targetOrder.creditsGrantedAt) return;
      if (targetOrder.creditRefundProcessedAt) {
        output.duplicate = true;
        return;
      }

      const wallet = draft.aiCallCreditWallets.find(
        (item) => item.workspaceId === order.workspaceId
      );
      if (!wallet) return;

      const now = new Date().toISOString();
      const balance = Math.max(0, Math.round(Number(wallet.balance || 0)));
      const removed = Math.min(balance, credits);
      const debt = credits - removed;
      wallet.balance = balance - removed;
      wallet.debt = Math.max(0, Math.round(Number(wallet.debt || 0))) + debt;
      wallet.updatedAt = now;

      const purchaseId =
        targetOrder.creditPurchaseId || `voice-bundle:${targetOrder.id}`;
      const purchase = draft.aiCallCreditPurchases.find(
        (item) => item.id === purchaseId
      );
      if (purchase) {
        purchase.status = "refunded";
        purchase.refundProcessedAt = now;
        purchase.updatedAt = now;
      }

      draft.aiCallCreditLedger.unshift({
        id: crypto.randomUUID(),
        workspaceId: targetOrder.workspaceId,
        purchaseId,
        type: "refund",
        delta: -removed,
        balanceAfter: wallet.balance,
        provider: "safepay",
        providerTracker: tracker || targetOrder.providerTracker || "",
        description: debt
          ? `${removed} bundle AI call credits removed; ${debt} recorded as AI call-credit debt.`
          : `${removed} bundle AI call credits removed after refund.`,
        createdAt: now,
      });
      if (draft.aiCallCreditLedger.length > 5000) {
        draft.aiCallCreditLedger.splice(5000);
      }

      targetOrder.creditRefundProcessedAt = now;
      targetOrder.creditRefundEventId = clean(eventId);
      targetOrder.updatedAt = now;
      output = {
        reversed: true,
        credits,
        removed,
        debt,
        balance: wallet.balance,
      };
    });
    return output;
  }


  async function connectExistingNumber(user, input = {}) {
    const ctx = assertPurchaser(user);
    const phoneNumber = normalizePhone(input.phoneNumber);
    const callingMode = normalizeCallingMode(input.callingMode);
    const method = normalizeStatus(input.method || "sip_byoc");
    const allowedMethods = new Set(["sip_byoc", "forwarding", "porting"]);

    if (!phoneNumber || phoneNumber.length < 8) {
      throw httpError(400, "Enter a valid business phone number in international format.");
    }
    if (!allowedMethods.has(method)) {
      throw httpError(400, "Choose SIP/BYOC, forwarding, or porting.");
    }

    const state = store.read();

    // A business number can belong to only one ReachFly workspace at a time.
    // This prevents one tenant from taking over a number another tenant has
    // already verified or is currently verifying.
    const workspaceConflict = (state.voicePhoneNumbers || []).find(
      (item) =>
        item.workspaceId !== ctx.workspaceId &&
        normalizePhone(item.phoneNumber) === phoneNumber &&
        !["failed", "disconnected"].includes(normalizeStatus(item.status))
    );
    if (workspaceConflict) {
      throw httpError(
        409,
        "This business number is already linked to another ReachFly workspace.",
        "VOICE_EXISTING_NUMBER_WORKSPACE_CONFLICT"
      );
    }

    const existing = (state.voicePhoneNumbers || []).find(
      (item) =>
        item.workspaceId === ctx.workspaceId &&
        normalizePhone(item.phoneNumber) === phoneNumber &&
        !["failed", "disconnected"].includes(normalizeStatus(item.status))
    );
    if (existing) {
      const pendingVerification = ["pending_verification", "verifying"].includes(
        normalizeStatus(existing.status)
      );
      return {
        ok: true,
        reused: true,
        number: publicNumber(existing),
        testVerificationCode: "",
        requiresVerificationCode:
          pendingVerification &&
          normalizeStatus(existing.verificationProvider) === "telnyx_verified_numbers",
        verification: existingNumberNextStep(existing),
        sipDestination: existingSipDestination(existing),
      };
    }

    const now = new Date().toISOString();
    const testMode = isVoiceCommerceTestMode();
    const verificationCode = testMode
      ? String(Math.floor(100000 + Math.random() * 900000))
      : "";
    const verificationHash = verificationCode
      ? crypto.createHash("sha256").update(verificationCode).digest("hex")
      : "";

    const verificationMethod = testMode
      ? "sandbox_code"
      : ["call", "sms"].includes(normalizeStatus(input.verificationMethod))
        ? normalizeStatus(input.verificationMethod)
        : "call";

    if (!testMode) {
      requireTelnyxCommerceApiKey();

      // Verified Numbers is Telnyx's purpose-built API for proving ownership of
      // a non-Telnyx number before it is used as an outbound caller ID. This
      // does not require a Telnyx Verify Profile.
      await telnyxRequest("/verified_numbers", {
        method: "POST",
        body: {
          phone_number: phoneNumber,
          verification_method: verificationMethod,
        },
      });
    }

    const record = {
      id: crypto.randomUUID(),
      workspaceId: ctx.workspaceId,
      orderId: "",
      phoneNumber,
      countryCode: clean(input.countryCode).toUpperCase(),
      provider: testMode ? "existing_test" : "existing_number",
      source: "existing_number",
      connectionMethod: method,
      callingMode,
      inboundEnabled: callingModeIncludesInbound(callingMode),
      outboundEnabled: callingModeIncludesOutbound(callingMode),
      inboundStatus: callingModeIncludesInbound(callingMode)
        ? testMode
          ? "sandbox_pending_verification"
          : "ownership_verification"
        : "disabled",
      outboundStatus: callingModeIncludesOutbound(callingMode)
        ? testMode
          ? "sandbox_pending_verification"
          : "ownership_verification"
        : "disabled",
      ownershipVerified: false,
      verificationHash,
      verificationAttempts: 0,
      verificationMethod,
      verificationProvider: testMode
        ? "reachfly_sandbox"
        : "telnyx_verified_numbers",
      verificationStatus: testMode ? "code_required" : "code_required",
      status: testMode ? "verifying" : "pending_verification",
      testMode,
      createdAt: now,
      updatedAt: now,
    };

    store.update((draft) => {
      ensureStateShape(draft);
      draft.voicePhoneNumbers.unshift(record);
      appendActivity(draft, {
        workspaceId: ctx.workspaceId,
        actorId: clean(user?.id),
        type: "voice_existing_number_started",
        title: `Existing business number ${phoneNumber} added for verification`,
        detail: `${method} · ${callingMode} · ${verificationMethod}`,
      });
    });

    return {
      ok: true,
      number: publicNumber(record),
      testVerificationCode: testMode ? verificationCode : "",
      requiresVerificationCode: !testMode,
      verification: testMode
        ? "Enter the sandbox verification code to complete QA."
        : verificationMethod === "sms"
          ? "Telnyx sent an ownership-verification code by SMS. Enter the code below to connect this number."
          : "Answer the Telnyx ownership-verification call, note the verification code, then enter it below.",
      sipDestination: "",
    };
  }

  async function verifyExistingNumber(user, numberId, input = {}) {
    const ctx = assertPurchaser(user);
    const id = clean(numberId);
    const code = clean(input.code);
    const state = store.read();
    const current = (state.voicePhoneNumbers || []).find(
      (item) => item.id === id && item.workspaceId === ctx.workspaceId
    );
    if (!current) {
      throw httpError(404, "Existing business-number verification was not found.");
    }
    if (normalizeStatus(current.status) === "active" && current.ownershipVerified) {
      return {
        ok: true,
        number: publicNumber(current),
        reused: true,
        verification: existingNumberNextStep(current),
        sipDestination: existingSipDestination(current),
      };
    }

    if (current.testMode && isVoiceCommerceTestMode()) {
      const suppliedHash = crypto.createHash("sha256").update(code).digest("hex");
      if (!code || suppliedHash !== clean(current.verificationHash)) {
        store.update((draft) => {
          ensureStateShape(draft);
          const target = draft.voicePhoneNumbers.find((item) => item.id === id);
          if (target) {
            target.verificationAttempts = Number(target.verificationAttempts || 0) + 1;
            target.updatedAt = new Date().toISOString();
          }
        });
        throw httpError(422, "The sandbox ownership-verification code is incorrect.");
      }

      const sharedPhoneNumberId = clean(
        process.env.VOICE_TEST_CALL_PHONE_NUMBER_ID ||
          process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID
      );
      const sharedRoutingNumber = normalizePhone(
        process.env.VOICE_TEST_CALL_FROM_NUMBER ||
          process.env.TELNYX_AI_AGENT_FROM_NUMBER ||
          process.env.TELNYX_AI_AGENT_FROM_NUMBERS?.split(",")?.[0]
      );

      const now = new Date().toISOString();
      let updated = null;
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voicePhoneNumbers.find((item) => item.id === id);
        if (!target) return;
        target.status = "active";
        target.ownershipVerified = true;
        target.verifiedAt = now;
        target.verificationStatus = "accepted";
        target.verificationHash = "";
        target.testRoutingPhoneNumber = sharedRoutingNumber;
        target.elevenLabsPhoneNumberId = sharedPhoneNumberId;
        target.inboundStatus = target.inboundEnabled
          ? "sandbox_simulated"
          : "disabled";
        target.outboundStatus = target.outboundEnabled
          ? "active_shared_test_route"
          : "disabled";
        target.updatedAt = now;
        updated = { ...target };

        appendActivity(draft, {
          workspaceId: ctx.workspaceId,
          actorId: clean(user?.id),
          type: "voice_existing_number_verified",
          title: `Existing business number ${target.phoneNumber} verified`,
          detail:
            target.inboundEnabled
              ? "QA inbound is simulated; outbound test calls use the configured shared ReachFly route."
              : "Outbound test calls use the configured shared ReachFly route.",
        });
      });

      emit({
        workspaceId: ctx.workspaceId,
        event: "voice-commerce:number-active",
        payload: {
          phoneNumber: updated?.phoneNumber,
          number: publicNumber(updated || current),
        },
      });

      return {
        ok: true,
        number: publicNumber(updated || current),
        verification: "Sandbox ownership verification completed.",
        sipDestination: "",
      };
    }

    if (current.testMode || isVoiceCommerceTestMode()) {
      throw httpError(
        409,
        "This number was created in a different verification environment. Start the connection again.",
        "VOICE_EXISTING_NUMBER_ENVIRONMENT_MISMATCH"
      );
    }

    if (normalizeStatus(current.verificationProvider) !== "telnyx_verified_numbers") {
      throw httpError(
        409,
        "This number uses an older ownership-verification flow. Unlink it and connect it again.",
        "VOICE_EXISTING_NUMBER_LEGACY_VERIFICATION"
      );
    }

    if (!code) {
      throw httpError(
        422,
        "Enter the ownership-verification code sent by Telnyx.",
        "VOICE_EXISTING_NUMBER_CODE_REQUIRED"
      );
    }

    try {
      await telnyxRequest(
        `/verified_numbers/${encodeURIComponent(normalizePhone(current.phoneNumber))}/actions/verify`,
        {
          method: "POST",
          body: { verification_code: code },
        }
      );
    } catch (error) {
      store.update((draft) => {
        ensureStateShape(draft);
        const target = draft.voicePhoneNumbers.find((item) => item.id === id);
        if (!target) return;
        target.verificationAttempts = Number(target.verificationAttempts || 0) + 1;
        target.verificationStatus = "code_rejected";
        target.updatedAt = new Date().toISOString();
      });
      throw httpError(
        error?.statusCode || 422,
        error?.message || "The ownership-verification code was not accepted.",
        "VOICE_EXISTING_NUMBER_VERIFICATION_FAILED"
      );
    }

    return await activateVerifiedExistingNumber(current, user);
  }

  async function activateVerifiedExistingNumber(current, user) {
    const id = current.id;
    const now = new Date().toISOString();
    let phoneNumberId = clean(current.elevenLabsPhoneNumberId);

    if (current.connectionMethod === "sip_byoc" && !phoneNumberId) {
      phoneNumberId = await importNumberIntoElevenLabs({
        id: `existing:${id}`,
        workspaceId: current.workspaceId,
        phoneNumber: current.phoneNumber,
      });
    }

    const needsInboundRouting =
      current.connectionMethod === "sip_byoc" &&
      current.inboundEnabled === true;
    const assistedCarrierAction = ["forwarding", "porting"].includes(
      normalizeStatus(current.connectionMethod)
    );

    let updated = null;
    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.voicePhoneNumbers.find((item) => item.id === id);
      if (!target) return;
      target.ownershipVerified = true;
      target.verifiedAt = target.verifiedAt || now;
      target.verificationStatus = "accepted";
      target.elevenLabsPhoneNumberId = phoneNumberId || target.elevenLabsPhoneNumberId || "";
      target.outboundStatus = target.outboundEnabled ? "ownership_verified" : "disabled";

      if (assistedCarrierAction) {
        target.status = "carrier_action_required";
        target.inboundStatus = target.inboundEnabled ? "carrier_action_required" : "disabled";
      } else if (needsInboundRouting) {
        target.status = "routing_required";
        target.inboundStatus = "routing_required";
      } else {
        target.status = "active";
        target.inboundStatus = "disabled";
        target.outboundStatus = target.outboundEnabled ? "active" : "disabled";
        target.activatedAt = target.activatedAt || now;
      }
      target.updatedAt = now;
      updated = { ...target };

      appendActivity(draft, {
        workspaceId: target.workspaceId,
        actorId: clean(user?.id),
        type: "voice_existing_number_verified",
        title: `Ownership verified for ${target.phoneNumber}`,
        detail: assistedCarrierAction
          ? `${target.connectionMethod} requires the remaining carrier action.`
          : needsInboundRouting
            ? "SIP ownership verified. Waiting for the inbound carrier route test."
            : "Number ownership verified for outbound calling.",
      });
    });

    if (updated?.status === "active") {
      emit({
        workspaceId: updated.workspaceId,
        event: "voice-commerce:number-active",
        payload: { phoneNumber: updated.phoneNumber, number: publicNumber(updated) },
      });
    }

    return {
      ok: true,
      number: publicNumber(updated || current),
      verification: existingNumberNextStep(updated || current),
      sipDestination: existingSipDestination(updated || current),
    };
  }

  async function testExistingNumberRouting(user, numberId) {
    const ctx = assertPurchaser(user);
    const id = clean(numberId);
    const current = (store.read().voicePhoneNumbers || []).find(
      (item) => item.id === id && item.workspaceId === ctx.workspaceId
    );
    if (!current) throw httpError(404, "Existing business number was not found.");
    if (current.connectionMethod !== "sip_byoc") {
      throw httpError(
        409,
        "Automatic routing tests are available for SIP/BYOC numbers. Forwarding and porting continue through the guided carrier workflow.",
        "VOICE_EXISTING_NUMBER_ROUTING_TEST_UNSUPPORTED"
      );
    }
    if (!current.ownershipVerified) {
      throw httpError(409, "Verify number ownership before testing SIP routing.");
    }
    if (!current.inboundEnabled) {
      return {
        ok: true,
        number: publicNumber(current),
        routingVerified: true,
        message: "Inbound calling is disabled for this number, so no inbound SIP route test is required.",
      };
    }

    const phoneNumberId = clean(current.elevenLabsPhoneNumberId);
    if (!phoneNumberId) {
      throw httpError(409, "The SIP number has not been imported into the managed voice runtime yet.");
    }

    const response = await elevenLabsRequest(
      `/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}/sip-messages?page_size=20`,
      { apiKey: requireEnv("ELEVENLABS_API_KEY") }
    );
    const expected = normalizePhone(current.phoneNumber);
    const matched = (Array.isArray(response?.sip_messages) ? response.sip_messages : []).find(
      (message) =>
        normalizeStatus(message?.direction) === "in" &&
        (Array.isArray(message?.phone_numbers) ? message.phone_numbers : []).some(
          (number) => normalizePhone(number) === expected
        ) &&
        !clean(message?.error_message)
    );

    if (!matched) {
      return {
        ok: true,
        pending: true,
        routingVerified: false,
        number: publicNumber(current),
        sipDestination: existingSipDestination(current),
        message:
          "No successful inbound SIP test has reached ReachFly yet. Route the number to the destination shown, place one test call, then check again.",
      };
    }

    const now = new Date().toISOString();
    let updated = null;
    store.update((draft) => {
      ensureStateShape(draft);
      const target = draft.voicePhoneNumbers.find((item) => item.id === id);
      if (!target) return;
      target.routingVerified = true;
      target.routingVerifiedAt = now;
      target.inboundStatus = "active";
      target.outboundStatus = target.outboundEnabled ? "active" : "disabled";
      target.status = "active";
      target.activatedAt = target.activatedAt || now;
      target.updatedAt = now;
      updated = { ...target };

      appendActivity(draft, {
        workspaceId: target.workspaceId,
        actorId: clean(user?.id),
        type: "voice_existing_number_routing_verified",
        title: `Inbound SIP routing verified for ${target.phoneNumber}`,
        detail: "A successful inbound SIP INVITE reached the managed ReachFly voice runtime.",
      });
    });

    emit({
      workspaceId: ctx.workspaceId,
      event: "voice-commerce:number-active",
      payload: { phoneNumber: updated?.phoneNumber, number: publicNumber(updated || current) },
    });

    return {
      ok: true,
      routingVerified: true,
      number: publicNumber(updated || current),
      sipDestination: existingSipDestination(updated || current),
      message: "Inbound SIP routing verified. This existing business number is active in ReachFly.",
    };
  }

  async function unlinkExistingNumber(user, numberId) {
    const ctx = assertPurchaser(user);
    const id = clean(numberId);
    const state = store.read();
    const current = (state.voicePhoneNumbers || []).find(
      (item) => item.id === id && item.workspaceId === ctx.workspaceId
    );

    if (!current) {
      throw httpError(404, "Business number was not found.");
    }
    if (normalizeStatus(current.source) !== "existing_number") {
      throw httpError(
        409,
        "ReachFly-managed purchased numbers cannot be unlinked here. Use a dedicated number-release workflow so a paid carrier number is never released accidentally.",
        "VOICE_MANAGED_NUMBER_RELEASE_REQUIRED"
      );
    }

    const phoneNumber = normalizePhone(current.phoneNumber);
    const phoneNumberId = clean(current.elevenLabsPhoneNumberId);
    const activeCallStatuses = new Set([
      "creating",
      "queued",
      "initiated",
      "ringing",
      "answered",
      "assistant_active",
      "active",
      "streaming",
      "connected",
      "in_progress",
    ]);
    const activeCall = (state.telnyxAiAgentCalls || []).find(
      (call) =>
        call.workspaceId === ctx.workspaceId &&
        activeCallStatuses.has(normalizeStatus(call.status)) &&
        [call.fromNumber, call.displayFromNumber, call.requestedFromNumber]
          .map(normalizePhone)
          .includes(phoneNumber)
    );
    if (activeCall) {
      throw httpError(
        409,
        "End the active call using this business number before unlinking it.",
        "VOICE_NUMBER_ACTIVE_CALL"
      );
    }

    let telnyxVerifiedNumberRemoved = false;
    let elevenLabsPhoneNumberRemoved = false;

    // Sandbox records may reuse a shared test phone ID. Never delete that
    // provider record when unlinking a sandbox number.
    if (!current.testMode) {
      if (normalizeStatus(current.verificationProvider) === "telnyx_verified_numbers") {
        const telnyxResult = await deleteTelnyxVerifiedNumber(phoneNumber);
        telnyxVerifiedNumberRemoved = telnyxResult.removed || telnyxResult.notFound;
      }

      if (phoneNumberId) {
        const elevenResult = await deleteElevenLabsPhoneNumber(phoneNumberId);
        elevenLabsPhoneNumberRemoved = elevenResult.removed || elevenResult.notFound;
      }
    }

    const now = new Date().toISOString();
    store.update((draft) => {
      ensureStateShape(draft);

      draft.voicePhoneNumbers = (draft.voicePhoneNumbers || []).filter(
        (item) => !(item.id === id && item.workspaceId === ctx.workspaceId)
      );

      // Remove stale business-number references from every managed agent in
      // this workspace. Provider agent identity remains intact; the workspace
      // simply returns to "business number not connected" until another number
      // is selected.
      for (const agent of draft.telnyxAiAgents || []) {
        if (agent.workspaceId !== ctx.workspaceId) continue;
        const fromMatches = normalizePhone(agent.fromNumber) === phoneNumber;
        const idMatches =
          phoneNumberId && clean(agent.elevenLabsPhoneNumberId) === phoneNumberId;
        if (!fromMatches && !idMatches) continue;

        if (fromMatches) agent.fromNumber = "";
        if (fromMatches || idMatches) agent.elevenLabsPhoneNumberId = "";
        if (clean(agent.phoneNumberId) === phoneNumberId) agent.phoneNumberId = "";
        if (clean(agent.sipPhoneNumberId) === phoneNumberId) agent.sipPhoneNumberId = "";
        agent.numberDisconnectedAt = now;
        agent.updatedAt = now;
      }

      appendActivity(draft, {
        workspaceId: ctx.workspaceId,
        actorId: clean(user?.id),
        type: "voice_existing_number_unlinked",
        title: `Existing business number ${phoneNumber} unlinked`,
        detail: "Removed from ReachFly and disconnected from managed Telnyx/ElevenLabs number routing.",
        createdAt: now,
      });
    });

    emit({
      workspaceId: ctx.workspaceId,
      event: "voice-commerce:number-unlinked",
      payload: { id, phoneNumber },
    });

    return {
      ok: true,
      unlinked: true,
      id,
      phoneNumber,
      telnyxVerifiedNumberRemoved,
      elevenLabsPhoneNumberRemoved,
    };
  }

  function existingSipDestination(number) {
    if (!number || number.connectionMethod !== "sip_byoc" || !number.ownershipVerified) {
      return "";
    }
    return `sip:${normalizePhone(number.phoneNumber)}@sip.rtc.elevenlabs.io:5060`;
  }

  function existingNumberNextStep(number) {
    const status = normalizeStatus(number?.status);
    if (status === "active") {
      return "Ownership and routing are verified. This business number is active in ReachFly.";
    }
    if (status === "routing_required") {
      return "Ownership is verified. Configure your carrier/PBX to route inbound calls to the ReachFly SIP destination, place one test call, then run the routing check.";
    }
    if (status === "carrier_action_required") {
      return number?.connectionMethod === "porting"
        ? "Ownership is verified. The number is ready for the assisted porting workflow; it will not be marked active until the carrier completes the port."
        : "Ownership is verified. Complete the guided forwarding carrier step before activation.";
    }
    if (status === "pending_verification" || status === "verifying") {
      return "Complete ownership verification before this number can be activated.";
    }
    return "Continue the existing-number setup workflow.";
  }

  return {
    getDashboard,
    searchAvailableNumbers,
    createNumberCheckout,
    createBundleCheckout,
    connectExistingNumber,
    verifyExistingNumber,
    testExistingNumberRouting,
    unlinkExistingNumber,
    getOrder,
    retryProvision,
    handleVerifiedSafepayEvent,
  };
}

async function telnyxRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`${TELNYX_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireTelnyxCommerceApiKey()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    const providerMessage = clean(
      payload?.errors?.[0]?.detail ||
        payload?.errors?.[0]?.title ||
        payload?.message ||
        `Telnyx request failed with ${response.status}.`
    );

    // Never leak an upstream Telnyx 401/403 as a ReachFly authentication
    // failure. The browser globally logs out on ReachFly HTTP 401, so provider
    // credential failures must remain provider/service errors.
    const reachFlyStatus = [401, 403].includes(Number(response.status))
      ? 502
      : Number(response.status) || 502;

    throw httpError(
      reachFlyStatus,
      providerMessage,
      "TELNYX_NUMBER_COMMERCE_FAILED"
    );
  }
  return payload;
}

async function elevenLabsRequest(path, { method = "GET", body, apiKey } = {}) {
  const response = await fetch(`${ELEVENLABS_API_BASE}${path}`, {
    method,
    headers: {
      "xi-api-key": apiKey || requireEnv("ELEVENLABS_API_KEY"),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    const message = clean(
      payload?.detail?.[0]?.msg ||
        payload?.detail?.message ||
        payload?.detail ||
        payload?.message ||
        `ElevenLabs request failed with ${response.status}.`
    );

    // Same rule as Telnyx: provider authentication is not ReachFly user
    // authentication. Do not trigger the frontend's global logout handler.
    const reachFlyStatus = [401, 403].includes(Number(response.status))
      ? 502
      : Number(response.status) || 502;

    throw httpError(
      reachFlyStatus,
      message,
      "ELEVENLABS_NUMBER_IMPORT_FAILED"
    );
  }
  return payload;
}

async function deleteTelnyxVerifiedNumber(phoneNumber) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return { removed: false, notFound: true };

  const response = await fetch(
    `${TELNYX_API_BASE}/verified_numbers/${encodeURIComponent(normalized)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${requireTelnyxCommerceApiKey()}`,
        Accept: "application/json",
      },
    }
  );
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (response.status === 404) return { removed: false, notFound: true };
  if (!response.ok) {
    const message = clean(
      payload?.errors?.[0]?.detail ||
        payload?.errors?.[0]?.title ||
        payload?.message ||
        `Telnyx verified-number deletion failed with ${response.status}.`
    );
    throw httpError(
      [401, 403].includes(Number(response.status)) ? 502 : response.status || 502,
      message,
      "TELNYX_VERIFIED_NUMBER_UNLINK_FAILED"
    );
  }
  return { removed: true, notFound: false };
}

async function deleteElevenLabsPhoneNumber(phoneNumberId) {
  const id = clean(phoneNumberId);
  if (!id) return { removed: false, notFound: true };

  const response = await fetch(
    `${ELEVENLABS_API_BASE}/v1/convai/phone-numbers/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: {
        "xi-api-key": requireEnv("ELEVENLABS_API_KEY"),
        Accept: "application/json",
      },
    }
  );
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (response.status === 404) return { removed: false, notFound: true };
  if (!response.ok) {
    const message = clean(
      payload?.detail?.message ||
        payload?.detail ||
        payload?.message ||
        `ElevenLabs phone-number deletion failed with ${response.status}.`
    );
    throw httpError(
      [401, 403].includes(Number(response.status)) ? 502 : response.status || 502,
      message,
      "ELEVENLABS_PHONE_NUMBER_UNLINK_FAILED"
    );
  }
  return { removed: true, notFound: false };
}

function buildSafepayMetadata(metadata = {}, orderId = "") {
  // Do not send workspace_id/user_id/source/custom product keys to Safepay.
  // Some processor configurations reject unknown metadata keys before card
  // authorization (the legacy error was: unsupported meta key workspace_id).
  // ReachFly already stores workspace/user/product context on the local order.
  // We retain only the stable order identifier used to reconcile webhooks.
  const resolvedOrderId = clean(
    metadata?.order_id || metadata?.orderId || orderId
  ).slice(0, 200);
  return resolvedOrderId ? { order_id: resolvedOrderId } : {};
}

async function createSafepayCheckout({
  amountMinor,
  currency,
  orderId,
  redirectUrl,
  cancelUrl,
  metadata,
}) {
  const safepay = await getSafepayClient();
  const publicKey = requireEnv("SAFEPAY_PUBLIC_KEY");
  const sessionResponse = await safepay.payments.session.setup({
    merchant_api_key: publicKey,
    intent: clean(process.env.SAFEPAY_PAYMENT_INTENT) || "CYBERSOURCE",
    mode: "payment",
    entry_mode: "raw",
    currency,
    amount: amountMinor,
    metadata: buildSafepayMetadata(metadata, orderId),
    include_fees: false,
  });
  const tracker = clean(
    sessionResponse?.data?.tracker?.token ||
      sessionResponse?.tracker?.token ||
      sessionResponse?.data?.token
  );
  if (!tracker) throw new Error("Safepay did not return a payment tracker.");

  const passportResponse = await safepay.client.passport.create();
  const tbt = clean(
    passportResponse?.data?.token ||
      passportResponse?.token ||
      (typeof passportResponse?.data === "string" ? passportResponse.data : "")
  );
  if (!tbt) throw new Error("Safepay did not return an authentication token.");

  const checkoutUrl = clean(
    safepay.checkout.createCheckoutUrl({
      env: getSafepayEnvironment(),
      tracker,
      tbt,
      source: "hosted",
      order_id: orderId,
      redirect_url: redirectUrl,
      cancel_url: cancelUrl,
    })
  );
  if (!checkoutUrl || !/^https?:\/\//i.test(checkoutUrl)) {
    throw new Error("Safepay did not return a valid checkout URL.");
  }
  return { tracker, checkoutUrl };
}

async function getSafepayClient() {
  const secretKey = requireEnv("SAFEPAY_SECRET_KEY");
  const host =
    clean(process.env.SAFEPAY_HOST) ||
    (getSafepayEnvironment() === "production"
      ? "https://api.getsafepay.com"
      : "https://sandbox.api.getsafepay.com");
  let imported;
  try {
    imported = await import("@sfpy/node-core");
  } catch {
    throw httpError(
      503,
      "Safepay SDK is not installed. Run npm install @sfpy/node-core on the ReachFly API.",
      "SAFEPAY_SDK_MISSING"
    );
  }
  const factory = imported?.default || imported;
  if (typeof factory !== "function") {
    throw httpError(503, "Safepay SDK could not be initialized.", "SAFEPAY_SDK_INVALID");
  }
  return factory(secretKey, { authType: "secret", host });
}

function getNumberCheckoutReadiness() {
  const missing = [];

  if (!clean(process.env.SAFEPAY_SECRET_KEY)) missing.push("SAFEPAY_SECRET_KEY");
  if (!clean(process.env.SAFEPAY_PUBLIC_KEY)) missing.push("SAFEPAY_PUBLIC_KEY");

  if (isVoiceCommerceTestMode()) {
    if (
      !clean(
        process.env.VOICE_TEST_CALL_PHONE_NUMBER_ID ||
          process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID
      )
    ) {
      missing.push("VOICE_TEST_CALL_PHONE_NUMBER_ID");
    }
    if (
      !normalizePhone(
        process.env.VOICE_TEST_CALL_FROM_NUMBER ||
          process.env.TELNYX_AI_AGENT_FROM_NUMBER ||
          String(process.env.TELNYX_AI_AGENT_FROM_NUMBERS || "").split(",")[0]
      )
    ) {
      missing.push("VOICE_TEST_CALL_FROM_NUMBER");
    }
  } else {
    if (!getTelnyxCommerceApiKey()) missing.push("TELNYX_API_KEY");
    if (!resolveTelnyxConnectionId(false)) missing.push("TELNYX_AI_AGENT_SIP_CONNECTION_ID");
    if (!clean(process.env.ELEVENLABS_API_KEY)) missing.push("ELEVENLABS_API_KEY");
  }

  return {
    ready: missing.length === 0,
    missing,
    message: missing.length
      ? `Business-number checkout is waiting for server configuration: ${missing.join(", ")}.`
      : "Business-number checkout and provisioning are configured.",
  };
}

function assertNumberCheckoutReady() {
  const readiness = getNumberCheckoutReadiness();
  if (!readiness.ready) {
    throw httpError(
      503,
      readiness.message,
      "VOICE_NUMBER_CHECKOUT_NOT_CONFIGURED",
      { missing: readiness.missing }
    );
  }
  return readiness;
}

function normalizeReturnPath(value) {
  const raw = clean(value);
  if (!raw || !raw.startsWith("/app/")) {
    return "/app/voice-agent?onboarding=1&tab=setup&view=buy-numbers";
  }
  try {
    const parsed = new URL(raw, "https://reachfly.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/app/voice-agent?onboarding=1&tab=setup&view=buy-numbers";
  }
}

function buildReturnUrl(returnPath, params = {}) {
  const url = new URL(normalizeReturnPath(returnPath), getAppUrl());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function resolveTelnyxConnectionId(required = true) {
  const value = clean(
    process.env.TELNYX_COMMERCE_SIP_CONNECTION_ID ||
      process.env.TELNYX_AI_AGENT_SIP_CONNECTION_ID ||
      process.env.TELNYX_SIP_CONNECTION_ID ||
      process.env.TELNYX_CONNECTION_ID
  );
  if (!value && required) {
    throw httpError(
      503,
      "A ReachFly commerce SIP connection is required before purchased numbers can be provisioned.",
      "VOICE_NUMBER_CONNECTION_NOT_CONFIGURED"
    );
  }
  return value;
}

function getTelnyxCommerceApiKey() {
  return clean(
    process.env.TELNYX_COMMERCE_API_KEY ||
      process.env.TELNYX_API_KEY
  );
}

function requireTelnyxCommerceApiKey() {
  const value = getTelnyxCommerceApiKey();
  if (!value) {
    throw httpError(
      503,
      "ReachFly number commerce is not configured.",
      "TELNYX_COMMERCE_API_KEY_MISSING"
    );
  }
  return value;
}

function getAiConnectedCallPriceMinor() {
  const configured = Number(process.env.AI_CALL_CONNECTED_PRICE_MINOR);
  return Number.isFinite(configured) && configured > 0
    ? Math.round(configured)
    : DEFAULT_AI_CALL_PRICE_MINOR;
}

function getAiConnectedCallCurrency() {
  return clean(process.env.AI_CALL_CONNECTED_CURRENCY || "USD").toUpperCase();
}

function getVoiceBundleCatalog() {
  const currency = getAiConnectedCallCurrency();
  const configuredJson = clean(process.env.VOICE_BUNDLE_PACKS_JSON);
  if (configuredJson) {
    try {
      const parsed = JSON.parse(configuredJson);
      if (Array.isArray(parsed)) {
        const items = parsed
          .map((item, index) => {
            const credits = Math.max(0, Math.round(Number(item?.credits || 0)));
            const amountMinor = Math.round(
              Number(
                item?.callCreditAmountMinor ??
                  item?.amountMinor ??
                  credits * getAiConnectedCallPriceMinor()
              )
            );
            if (!credits || !Number.isFinite(amountMinor) || amountMinor <= 0) {
              return null;
            }
            return {
              id: clean(item?.id) || `voice-bundle-${credits}-${index + 1}`,
              label:
                clean(item?.label) || `Number + ${credits} AI call credits`,
              credits,
              callCreditAmountMinor: amountMinor,
              currency: clean(item?.currency || currency).toUpperCase(),
              active: item?.active !== false,
              recommended: item?.recommended === true,
            };
          })
          .filter(Boolean);
        if (items.length) return items;
      }
    } catch {
      // Fall through to the server-owned default bundle catalog.
    }
  }

  const configuredCredits = String(process.env.VOICE_BUNDLE_CREDIT_OPTIONS || "")
    .split(",")
    .map((value) => Math.max(0, Math.round(Number(value || 0))))
    .filter(Boolean);
  const creditsList = configuredCredits.length
    ? [...new Set(configuredCredits)]
    : DEFAULT_VOICE_BUNDLE_CREDITS;

  return creditsList.map((credits, index) => ({
    id: `voice-bundle-${credits}`,
    label:
      index === 0
        ? `Launch · Number + ${credits} calls`
        : index === 1
          ? `Growth · Number + ${credits} calls`
          : `Scale · Number + ${credits} calls`,
    credits,
    callCreditAmountMinor: credits * getAiConnectedCallPriceMinor(),
    currency,
    active: true,
    recommended: index === 1,
  }));
}

function getQuoteTtlMs() {
  return clampInteger(
    process.env.VOICE_NUMBER_QUOTE_TTL_MS,
    DEFAULT_QUOTE_TTL_MS,
    60_000,
    30 * 60_000
  );
}

function isVoiceCommerceTestMode() {
  const enabled = ["1", "true", "yes", "on"].includes(
    clean(process.env.VOICE_COMMERCE_TEST_MODE).toLowerCase()
  );
  return enabled && getSafepayEnvironment() === "sandbox";
}

function buildTestNumberInventory(input = {}, limit = 8) {
  const areaCode =
    clean(input.areaCode || input.nationalDestinationCode)
      .replace(/\D/g, "")
      .slice(0, 3) || "213";
  const locality = clean(input.locality) || "Los Angeles";
  const currency = clean(process.env.AI_CALL_CONNECTED_CURRENCY || "USD").toUpperCase();
  const initialChargeMinor = Math.max(1, nonNegativeInteger(
    process.env.VOICE_TEST_NUMBER_PRICE_MINOR,
    100
  ));

  return Array.from({ length: Math.max(1, Math.min(12, limit)) }, (_, index) => {
    const subscriber = String(101 + index).padStart(4, "0");
    return {
      phoneNumber: `+1${areaCode}555${subscriber}`,
      vanityFormat: "",
      quickship: true,
      reservable: true,
      bestEffort: false,
      testMode: true,
      regionInformation: [
        { type: "locality", name: locality },
        { type: "administrative_area", name: "Sandbox inventory" },
      ],
      features: ["voice"],
      currency,
      providerUpfrontMinor: 0,
      providerMonthlyMinor: 0,
      setupFeeMinor: initialChargeMinor,
      markupMinor: 0,
      initialChargeMinor,
      bundles: [],
    };
  });
}

function getSafepayEnvironment() {
  return normalizeStatus(process.env.SAFEPAY_ENV || "sandbox") === "production"
    ? "production"
    : "sandbox";
}

function getAppUrl() {
  return String(process.env.APP_URL || "https://www.reachflyai.com")
    .trim()
    .replace(/\/+$/, "");
}

function requireEnv(name) {
  const value = clean(process.env[name]);
  if (!value) throw httpError(503, `${name} is required for Voice commerce.`, "VOICE_COMMERCE_NOT_CONFIGURED");
  return value;
}

function publicOrder(item = {}) {
  return {
    id: item.id || "",
    workspaceId: item.workspaceId || "",
    quoteId: item.quoteId || "",
    phoneNumber: item.phoneNumber || "",
    callingMode: normalizeCallingMode(item.callingMode),
    source: item.source || "reachfly_purchase",
    productType: item.productType || "voice_number",
    bundleId: item.bundleId || "",
    bundleLabel: item.bundleLabel || "",
    aiCallCredits: Number(item.aiCallCredits || 0),
    numberAmountMinor: Number(item.numberAmountMinor || item.amountMinor || 0),
    callCreditAmountMinor: Number(item.callCreditAmountMinor || 0),
    amountMinor: Number(item.amountMinor || 0),
    currency: clean(item.currency || "USD").toUpperCase(),
    testMode: Boolean(item.testMode),
    providerUpfrontMinor: Number(item.providerUpfrontMinor || 0),
    providerMonthlyMinor: Number(item.providerMonthlyMinor || 0),
    setupFeeMinor: Number(item.setupFeeMinor || 0),
    markupMinor: Number(item.markupMinor || 0),
    status: normalizeStatus(item.status || "unknown"),
    telnyxOrderId: item.telnyxOrderId || "",
    telnyxPhoneStatus: item.telnyxPhoneStatus || "",
    requirementsMet: item.requirementsMet ?? null,
    elevenLabsPhoneNumberId: item.elevenLabsPhoneNumberId || "",
    createdAt: item.createdAt || "",
    paidAt: item.paidAt || "",
    activatedAt: item.activatedAt || "",
    updatedAt: item.updatedAt || "",
    error: publicOrderError(item),
    paymentFailedAt: item.paymentFailedAt || "",
    retryCount: Number(item.retryCount || 0),
    lastRetryAt: item.lastRetryAt || "",
    paymentFailure: publicPaymentFailure(item),
  };
}


function publicOrderError(item = {}) {
  const rawError = clean(item.error);
  if (/unsupported\s+meta(?:data)?\s+key\s+workspace_id/i.test(rawError)) {
    return "Older checkout configuration failed before payment authorization. Retry payment; ReachFly no longer sends unsupported workspace metadata to the processor.";
  }
  return rawError;
}

function publicPaymentFailure(item = {}) {
  const rawError = clean(item.error);
  const legacyMetadataFailure = /unsupported\s+meta(?:data)?\s+key\s+workspace_id/i.test(rawError);

  if (legacyMetadataFailure) {
    return {
      code: "legacy_checkout_metadata",
      category: "checkout_configuration",
      retryable: true,
      action: "retry_checkout",
      message:
        "This was an older ReachFly checkout configuration failure, not a card decline. Retry the payment; unsupported workspace metadata is no longer sent to the processor.",
    };
  }

  if (item.paymentFailureCode || item.paymentFailureCategory || item.paymentFailureAction) {
    return {
      code: clean(item.paymentFailureCode),
      category: clean(item.paymentFailureCategory),
      retryable: item.paymentFailureRetryable !== false,
      action: clean(item.paymentFailureAction),
      message: rawError,
    };
  }

  if (normalizeStatus(item.status) === "payment_failed" && rawError) {
    return {
      code: "",
      category: "payment_failed",
      retryable: true,
      action: "retry_checkout",
      message: rawError,
    };
  }

  return null;
}

function normalizeSafepayFailure(data = {}) {
  const rawCode = clean(
    data.reason_code ||
      data.reasonCode ||
      data.reason ||
      data.code ||
      data.processor_code ||
      data.processorCode ||
      data?.action?.reason ||
      data?.action?.reason_code ||
      data?.processor?.reason ||
      data?.processor?.reason_code
  );
  const rawCategory = clean(
    data.category ||
      data.error_category ||
      data.errorCategory ||
      data?.action?.category ||
      data?.processor?.category
  );
  const rawMessage = clean(
    data.message ||
      data.description ||
      data.error ||
      data?.action?.message ||
      data?.action?.description ||
      data?.processor?.message
  );
  const haystack = `${rawCode} ${rawCategory} ${rawMessage}`.toLowerCase();

  if (rawCode === "203" || haystack.includes("general decline")) {
    return {
      code: rawCode || "203",
      category: rawCategory || "authorization_declined",
      retryable: true,
      action: "different_card_or_contact_bank",
      message:
        "Your bank declined this card authorization. ReachFly did not provision the business number. Try another card, or ask the issuing bank to approve online/card-not-present payments before trying again.",
    };
  }

  if (rawCode === "208" || haystack.includes("inactive card") || haystack.includes("card-not-present")) {
    return {
      code: rawCode || "208",
      category: rawCategory || "card_not_authorized",
      retryable: true,
      action: "different_card",
      message:
        "This card is inactive or is not enabled for online/card-not-present payments. ReachFly did not provision the business number. Use another card or enable online payments with the issuing bank.",
    };
  }

  if (rawCode === "476" || haystack.includes("payer authentication") || haystack.includes("authentication failed")) {
    return {
      code: rawCode || "476",
      category: rawCategory || "payer_authentication_failed",
      retryable: true,
      action: "retry_authentication_or_different_card",
      message:
        "The bank could not complete cardholder authentication. ReachFly did not provision the business number. Retry the payment and complete the bank verification step, or use another card.",
    };
  }

  return {
    code: rawCode,
    category: rawCategory || "payment_declined",
    retryable: true,
    action: "retry_or_different_payment_method",
    message:
      rawMessage ||
      "The payment processor declined this payment. ReachFly did not provision the business number. Retry the payment or use another payment method.",
  };
}

function publicNumber(item = {}) {
  return {
    id: item.id || "",
    workspaceId: item.workspaceId || "",
    orderId: item.orderId || "",
    phoneNumber: item.phoneNumber || "",
    countryCode: item.countryCode || "",
    source: item.source || "reachfly_purchase",
    connectionMethod: item.connectionMethod || "",
    callingMode: normalizeCallingMode(item.callingMode),
    inboundEnabled: Boolean(item.inboundEnabled),
    outboundEnabled: item.outboundEnabled !== false,
    inboundStatus: normalizeStatus(item.inboundStatus || "disabled"),
    outboundStatus: normalizeStatus(item.outboundStatus || "disabled"),
    ownershipVerified: item.ownershipVerified === true,
    verificationStatus: normalizeStatus(item.verificationStatus || ""),
    verificationMethod: normalizeStatus(item.verificationMethod || ""),
    verificationProvider: normalizeStatus(item.verificationProvider || ""),
    routingVerified: item.routingVerified === true,
    elevenLabsPhoneNumberId: item.elevenLabsPhoneNumberId || "",
    testMode: Boolean(item.testMode),
    status: normalizeStatus(item.status || "unknown"),
    providerMonthlyMinor: Number(item.providerMonthlyMinor || 0),
    currency: clean(item.currency || "USD").toUpperCase(),
    purchasedAt: item.purchasedAt || "",
    activatedAt: item.activatedAt || "",
    updatedAt: item.updatedAt || "",
  };
}

function inferCountryCodeFromQuote(draft, quoteId) {
  return clean(
    (draft.voiceNumberQuotes || []).find((item) => item.id === quoteId)?.countryCode
  ).toUpperCase();
}

function sanitizeSearch(input = {}) {
  return {
    countryCode: clean(input.countryCode || input.country || "US").toUpperCase(),
    areaCode: clean(input.areaCode || input.nationalDestinationCode).replace(/\D/g, "").slice(0, 8),
    locality: clean(input.locality).slice(0, 100),
    administrativeArea: clean(input.administrativeArea || input.state).slice(0, 100),
    phoneNumberType: normalizeStatus(input.phoneNumberType || input.type || "local"),
  };
}

function decimalMoneyToMinor(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : 0;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return `+${digits}`;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function byNewest(left, right) {
  return String(right.createdAt || right.updatedAt || "").localeCompare(
    String(left.createdAt || left.updatedAt || "")
  );
}

function httpError(statusCode, message, code = "", details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}
