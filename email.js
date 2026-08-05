import crypto, { randomUUID } from "node:crypto";

export function createEmailService({ store }) {
  const transportCache = new Map();

  function closeCachedTransports(ownerId = "", accountId = "") {
    for (const [key, transport] of transportCache.entries()) {
      const [keyOwnerId, keyAccountId] = key.split(":");

      const ownerMatches = !ownerId || keyOwnerId === ownerId;
      const accountMatches = !accountId || keyAccountId === accountId;

      if (!ownerMatches || !accountMatches) continue;

      try {
        transport.close?.();
      } catch {}

      transportCache.delete(key);
    }
  }

  function getTransportKey(settings = {}) {
    return [
      settings.ownerId || "",
      settings.id || "",
      settings.host || "",
      settings.port || "",
      settings.username || "",
      getSmtpSecure(settings) ? "secure" : "plain",
    ].join(":");
  }

  async function getPooledTransport(settings = {}) {
    const key = getTransportKey(settings);
    const existing = transportCache.get(key);

    if (existing) return existing;

    const nodemailer = await import("nodemailer");

    const isGmail =
      String(settings.provider || "").includes("gmail") ||
      String(settings.host || "").includes("gmail");

    const transport = nodemailer.default.createTransport({
      pool: true,

      // These settings control this application's sending speed only.
      // The SMTP provider still enforces its own quota and abuse policies.
      maxConnections: clampNumber(
        settings.maxConnections ||
          process.env.SMTP_MAX_CONNECTIONS ||
          (isGmail ? 1 : 5),
        1,
        20
      ),
      maxMessages: clampNumber(
        settings.maxMessages || process.env.SMTP_MAX_MESSAGES || 100,
        10,
        10000
      ),
      rateDelta: clampNumber(
        settings.rateDelta || process.env.SMTP_RATE_DELTA || 60000,
        1000,
        3600000
      ),
      rateLimit: clampNumber(
        settings.rateLimit ||
          process.env.SMTP_RATE_LIMIT ||
          (isGmail ? 5 : 60),
        1,
        1000
      ),

      connectionTimeout: clampNumber(
        process.env.SMTP_CONNECTION_TIMEOUT || 30000,
        5000,
        120000
      ),
      greetingTimeout: clampNumber(
        process.env.SMTP_GREETING_TIMEOUT || 20000,
        5000,
        120000
      ),
      socketTimeout: clampNumber(
        process.env.SMTP_SOCKET_TIMEOUT || 120000,
        10000,
        600000
      ),

      host: settings.host,
      port: Number(settings.port || 587),
      secure: getSmtpSecure(settings),
      auth: {
        user: settings.username,
        pass: settings.password,
      },
      tls: {
        rejectUnauthorized:
          String(process.env.SMTP_REJECT_UNAUTHORIZED || "true") !== "false",
      },
    });

    transport.on?.("error", () => {
      transportCache.delete(key);
    });

    transportCache.set(key, transport);

    return transport;
  }

  async function saveSettings(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const now = new Date().toISOString();
    let savedAccountId = "";

    store.update((state) => {
      const emailSettings = ensureUserEmailSettings(state, ownerId);

      const accounts = getAccountsFromSettings(emailSettings);
      const requestedId = String(input.accountId || input.id || "").trim();

      const existing =
        accounts.find((account) => account.id === requestedId) ||
        accounts.find(
          (account) =>
            input.fromEmail &&
            normalizeEmail(account.fromEmail) === normalizeEmail(input.fromEmail)
        ) ||
        null;

      const account = sealStoredCredentials({
        ...existing,
        ...sanitizeEmailSettings(input, existing || {}),
        id: existing?.id || requestedId || randomUUID(),
        ownerId,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      });

      savedAccountId = account.id;

      const nextAccounts = existing
        ? accounts.map((item) => (item.id === existing.id ? account : item))
        : [account, ...accounts];

      emailSettings.emailAccounts = nextAccounts;
      emailSettings.activeEmailAccountId = account.id;
      emailSettings.email = account;
    });

    closeCachedTransports(ownerId, savedAccountId);

    return getSettings(ownerId);
  }

  function getSettings(userId) {
    const ownerId = requireUserId(userId);
    const state = store.read();

    const emailSettings = getUserEmailSettings(state, ownerId);
    const accounts = getAccountsFromSettings(emailSettings);
    const activeAccount = getActiveAccountFromSettings(emailSettings, accounts);

    return publicEmailBundle(accounts, activeAccount);
  }

  async function deleteAccount(userId, accountId) {
    const ownerId = requireUserId(userId);
    const id = String(accountId || "").trim();

    if (!id) return getSettings(ownerId);

    store.update((state) => {
      const emailSettings = ensureUserEmailSettings(state, ownerId);

      const accounts = getAccountsFromSettings(emailSettings).filter(
        (account) => account.id !== id
      );

      const nextActive =
        accounts.find(
          (account) => account.id === emailSettings.activeEmailAccountId
        ) ||
        accounts[0] ||
        null;

      emailSettings.emailAccounts = accounts;
      emailSettings.activeEmailAccountId = nextActive?.id || "";
      emailSettings.email = nextActive || {};

      state.userEmailInbox = state.userEmailInbox || {};
      state.userEmailInbox[ownerId] = (
        state.userEmailInbox[ownerId] || []
      ).filter((item) => item.accountId !== id);
    });

    closeCachedTransports(ownerId, id);

    return getSettings(ownerId);
  }

  async function testSettings(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const settings = resolveSettings(ownerId, input);
    const smtpPassword = input.password || settings.password;

    if (!settings.host || !settings.port || !settings.username) {
      return {
        ok: true,
        dryRun: true,
        message:
          "Saved as a dry-run setup. Add SMTP host, username, and app password to send a real test email.",
      };
    }

    if (!smtpPassword) {
      return {
        ok: true,
        dryRun: true,
        message:
          "SMTP details look complete. Paste your app password to verify the SMTP connection.",
      };
    }

    let transport;

    try {
      const nodemailer = await import("nodemailer");

      transport = nodemailer.default.createTransport({
        host: settings.host,
        port: Number(settings.port || 587),
        secure: getSmtpSecure(settings),
        auth: {
          user: settings.username,
          pass: smtpPassword,
        },
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
      });

      await transport.verify();

      return {
        ok: true,
        message: "SMTP connection verified successfully.",
      };
    } catch (error) {
      return {
        ok: false,
        message: `SMTP verification failed: ${error.message}`,
      };
    } finally {
      try {
        transport?.close?.();
      } catch {}
    }
  }

  async function sendCampaignEmail(userId, input = {}) {
    const ownerId = requireUserId(userId);

    const recipientEmail = firstValidEmail(input.to || input.toEmail);

    if (!recipientEmail) {
      throw new Error("Recipient email is missing or invalid.");
    }

    const settings = resolveSettings(ownerId, {
      accountId: input.accountId,
      id: input.accountId,
    });

    const smtpPassword = settings.password;

    if (!settings.host || !settings.port || !settings.username) {
      throw new Error(
        "SMTP is not fully configured. Please save SMTP host, port, and username."
      );
    }

    if (!smtpPassword) {
      throw new Error(
        "SMTP password/app password is missing. Please save your email app password first."
      );
    }

    const fromEmail = settings.fromEmail || settings.username;
    const fromName = settings.fromName || "ReachFly.Ai";
    const replyTo = settings.replyTo || fromEmail;

    const subject = String(input.subject || "Quick idea").slice(0, 180);
    const body = String(input.body || "").trim();

    if (!body) {
      throw new Error("Email body is missing.");
    }

    const transport = await getPooledTransport(settings);

    const mail = {
      from: `"${escapeEmailName(fromName)}" <${fromEmail}>`,
      to: recipientEmail,
      replyTo,
      subject,
      text: body,
      html: textToHtml(body),
      headers: {
        "X-ReachFly-Campaign-Id": String(input.campaignId || ""),
        "X-ReachFly-Lead-Id": String(input.leadId || ""),
      },
    };

    if (input.unsubscribeUrl) {
      mail.headers["List-Unsubscribe"] = `<${String(input.unsubscribeUrl)}>`;
      mail.headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }

    const delivery = await sendMailWithRetry(transport, mail, {
      retries: clampNumber(
        input.retries ?? process.env.SMTP_RETRY_ATTEMPTS ?? 3,
        0,
        8
      ),
      baseDelayMs: clampNumber(
        process.env.SMTP_RETRY_BASE_DELAY_MS || 1500,
        250,
        60000
      ),
    });

    if (!delivery.ok) {
      const error = new Error(delivery.message);
      error.statusCode = delivery.httpStatus;
      error.code = delivery.code;
      error.smtp = delivery;
      throw error;
    }

    const result = delivery.result;

    return {
      ok: true,
      messageId: result.messageId || "",
      accepted: result.accepted || [],
      rejected: result.rejected || [],
      pending: result.pending || [],
      response: result.response || "",
      envelope: result.envelope || null,
      attempts: delivery.attempts,
      fromEmail,
      toEmail: recipientEmail,
      accountId: settings.id || input.accountId || "",
      provider: settings.provider || "custom",
    };
  }

  async function sendBulkCampaignEmails(userId, messages = [], options = {}) {
    const ownerId = requireUserId(userId);
    const queue = Array.isArray(messages) ? messages.filter(Boolean) : [];

    if (!queue.length) {
      return {
        ok: true,
        total: 0,
        sent: 0,
        failed: 0,
        results: [],
      };
    }

    const concurrency = clampNumber(
      options.concurrency || process.env.BULK_EMAIL_CONCURRENCY || 3,
      1,
      20
    );

    const results = new Array(queue.length);
    let cursor = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= queue.length) return;

        const message = queue[index];

        try {
          const result = await sendCampaignEmail(ownerId, {
            ...message,
            retries: message.retries ?? options.retries,
          });

          results[index] = {
            ok: true,
            index,
            toEmail: result.toEmail,
            messageId: result.messageId,
            response: result.response,
            attempts: result.attempts,
          };
        } catch (error) {
          const smtp = error?.smtp || classifySmtpError(error);

          results[index] = {
            ok: false,
            index,
            toEmail: firstValidEmail(message.to || message.toEmail),
            code: smtp.code,
            category: smtp.category,
            retryable: smtp.retryable,
            responseCode: smtp.responseCode,
            message: smtp.message,
          };

          // Stop this worker briefly when the provider is throttling.
          if (smtp.category === "rate_limit" || smtp.category === "quota") {
            await sleep(
              clampNumber(
                options.throttlePauseMs ||
                  process.env.SMTP_THROTTLE_PAUSE_MS ||
                  60000,
                1000,
                3600000
              )
            );
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
    );

    const sent = results.filter((item) => item?.ok).length;
    const failed = results.length - sent;

    return {
      ok: failed === 0,
      total: results.length,
      sent,
      failed,
      results,
    };
  }

  async function testIncomingSettings(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const settings = resolveSettings(ownerId, input);

    const incomingPassword =
      input.incomingPassword || settings.incomingPassword || settings.password;

    if (
      !settings.incomingHost ||
      !settings.incomingPort ||
      !settings.incomingUsername
    ) {
      return {
        ok: false,
        message:
          "Incoming mailbox details are incomplete. Add IMAP host, port, username, and app password.",
      };
    }

    if (!incomingPassword) {
      return {
        ok: false,
        message:
          "Incoming mailbox password is missing. Paste an app password or mailbox password.",
      };
    }

    try {
      const { ImapFlow } = await import("imapflow");

      const client = new ImapFlow({
        host: settings.incomingHost,
        port: Number(settings.incomingPort || 993),
        secure: settings.incomingSecure !== false,
        auth: {
          user: settings.incomingUsername,
          pass: incomingPassword,
        },
        logger: false,
      });

      await client.connect();
      await client.mailboxOpen("INBOX");
      await client.logout();

      return {
        ok: true,
        message: "Incoming mailbox connection verified successfully.",
      };
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND") {
        return {
          ok: false,
          message: "Install inbox packages first: npm i imapflow mailparser",
        };
      }

      return {
        ok: false,
        message: `Incoming mailbox verification failed: ${error.message}`,
      };
    }
  }

  async function listInbox(userId) {
    const ownerId = requireUserId(userId);
    const state = store.read();

    const campaignActivity = (state.inbox || [])
      .filter((item) => item.userId === ownerId)
      .filter((item) => item.channel === "email")
      .filter(
        (item) =>
          item.direction === "outbound" ||
          (item.direction === "inbound" && item.replyToSentId)
      )
      .map((item) => ({
        ...item,
        source:
          item.direction === "outbound"
            ? "sent"
            : item.source || "campaign-reply",
      }));

    const matchedMailboxReplies = (state.userEmailInbox?.[ownerId] || [])
      .filter((item) => item.direction === "inbound" && item.replyToSentId)
      .map((item) => ({
        ...item,
        source: "campaign-reply",
      }));

    return dedupeInboxItems([...matchedMailboxReplies, ...campaignActivity]).sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime()
    );
  }

  async function syncInbox(userId, options = {}) {
    const ownerId = requireUserId(userId);
    const state = store.read();
    const sentCampaignEmails = getSentCampaignEmails(state, ownerId);

    const emailSettings = getUserEmailSettings(state, ownerId);
    const accounts = getAccountsFromSettings(emailSettings);
    const settings = hydrateCredentials(
      getAccountByIdOrActive(emailSettings, options.accountId, accounts)
    );

    const incomingPassword = settings.incomingPassword || settings.password;
    const limit = clampNumber(options.limit || 25, 5, 100);

    if (
      !settings.incomingHost ||
      !settings.incomingPort ||
      !settings.incomingUsername
    ) {
      return {
        ok: false,
        synced: 0,
        items: await listInbox(ownerId),
        message:
          "Incoming mailbox is not configured yet. Save Gmail, Outlook, or custom IMAP settings first.",
      };
    }

    if (!incomingPassword) {
      return {
        ok: false,
        synced: 0,
        items: await listInbox(ownerId),
        message:
          "Incoming mailbox password is missing. Save an app password before syncing inbox.",
      };
    }

    try {
      const { ImapFlow } = await import("imapflow");
      const { simpleParser } = await import("mailparser");

      const client = new ImapFlow({
        host: settings.incomingHost,
        port: Number(settings.incomingPort || 993),
        secure: settings.incomingSecure !== false,
        auth: {
          user: settings.incomingUsername,
          pass: incomingPassword,
        },
        logger: false,
      });

      await client.connect();

      const mailbox = await client.mailboxOpen("INBOX");
      const total = Number(mailbox.exists || 0);

      if (!total) {
        await client.logout();

        return {
          ok: true,
          synced: 0,
          items: await listInbox(ownerId),
          message: "Inbox connected, but no emails were found.",
        };
      }

      const from = Math.max(1, total - limit + 1);
      const range = `${from}:*`;
      const fetched = [];

      for await (const message of client.fetch(range, {
        uid: true,
        envelope: true,
        source: true,
        flags: true,
      })) {
        const parsed = message.source ? await simpleParser(message.source) : null;

        const fromAddress = firstAddress(
          parsed?.from?.value || message.envelope?.from
        );

        const toAddress = firstAddress(parsed?.to?.value || message.envelope?.to);

        const createdAt =
          parsed?.date?.toISOString?.() ||
          message.envelope?.date?.toISOString?.() ||
          new Date().toISOString();

        const body = cleanBody(parsed?.text || parsed?.html || "");

        fetched.push({
          id: buildInboxId(ownerId, settings.id, message.uid),
          userId: ownerId,
          uid: message.uid,
          accountId: settings.id,
          accountLabel:
            settings.label || settings.fromEmail || settings.username || "",
          accountEmail: settings.fromEmail || settings.username || "",
          provider: settings.provider || "custom",
          channel: "email",
          direction: "inbound",
          source: "mailbox",
          mailbox: "INBOX",
          unread: !Array.from(message.flags || []).includes("\\Seen"),
          fromName: fromAddress.name || fromAddress.address || "Unknown sender",
          fromEmail: fromAddress.address || "",
          toEmail: toAddress.address || settings.fromEmail || "",
          subject: parsed?.subject || message.envelope?.subject || "No subject",
          messageId: normalizeMessageId(parsed?.messageId || ""),
          inReplyTo: normalizeMessageId(parsed?.inReplyTo || ""),
          references: normalizeReferences(parsed?.references),
          body,
          snippet: body.slice(0, 260),
          createdAt,
        });
      }

      await client.logout();

      const matchedReplies = fetched
        .map((item) => attachSentEmailMatch(item, sentCampaignEmails))
        .filter(Boolean);

      store.update((state) => {
        state.userEmailInbox = state.userEmailInbox || {};

        state.userEmailInbox[ownerId] = mergeInboxItems(
          matchedReplies,
          state.userEmailInbox[ownerId] || []
        ).slice(0, 500);
      });

      const items = await listInbox(ownerId);

      return {
        ok: true,
        synced: matchedReplies.length,
        scanned: fetched.length,
        items,
        message: `Scanned ${fetched.length} inbox email${
          fetched.length === 1 ? "" : "s"
        } and found ${matchedReplies.length} campaign repl${
          matchedReplies.length === 1 ? "y" : "ies"
        }.`,
      };
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND") {
        return {
          ok: false,
          synced: 0,
          items: await listInbox(ownerId),
          message: "Install inbox packages first: npm i imapflow mailparser",
        };
      }

      return {
        ok: false,
        synced: 0,
        items: await listInbox(ownerId),
        message: `Inbox sync failed: ${error.message}`,
      };
    }
  }

  function resolveSettings(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const state = store.read();

    const emailSettings = getUserEmailSettings(state, ownerId);
    const accounts = getAccountsFromSettings(emailSettings);
    const existing = getAccountByIdOrActive(
      emailSettings,
      input.accountId || input.id,
      accounts
    );

    return hydrateCredentials({
      ...existing,
      ...sanitizeEmailSettings(input, existing),
      ownerId,
    });
  }

  return {
    saveSettings,
    getSettings,
    deleteAccount,
    testSettings,
    sendCampaignEmail,
    sendBulkCampaignEmails,
    testIncomingSettings,
    listInbox,
    syncInbox,
  };
}

function getSentCampaignEmails(state = {}, ownerId) {
  return (state.inbox || [])
    .filter((item) => item.userId === ownerId)
    .filter((item) => item.channel === "email")
    .filter((item) => item.direction === "outbound")
    .map((item) => ({
      ...item,
      normalizedToEmail: normalizeEmail(
        item.toEmail || item.email || item.leadEmail || item.recipientEmail
      ),
      normalizedSubject: normalizeThreadSubject(item.subject || item.title),
      normalizedMessageId: normalizeMessageId(
        item.messageId || item.providerMessageId || item.smtpMessageId
      ),
    }))
    .filter((item) => item.normalizedToEmail)
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime()
    );
}

function attachSentEmailMatch(reply, sentItems = []) {
  const senderEmail = normalizeEmail(reply.fromEmail);
  if (!senderEmail) return null;

  const replySubject = normalizeThreadSubject(reply.subject);
  const replyThreadIds = new Set(
    [reply.inReplyTo, ...(reply.references || [])]
      .map(normalizeMessageId)
      .filter(Boolean)
  );

  const sentToSender = sentItems.filter(
    (item) => item.normalizedToEmail === senderEmail
  );

  if (!sentToSender.length) return null;

  const matchedByThread = sentToSender.find(
    (item) =>
      item.normalizedMessageId && replyThreadIds.has(item.normalizedMessageId)
  );

  const matchedBySubject = sentToSender.find(
    (item) =>
      item.normalizedSubject &&
      replySubject &&
      item.normalizedSubject === replySubject
  );

  // A reply from a contacted lead is accepted only when it belongs to the
  // same email thread/subject. This keeps unrelated mailbox email out.
  const sent = matchedByThread || matchedBySubject;
  if (!sent) return null;

  return {
    ...reply,
    source: "campaign-reply",
    replyToSentId: sent.id,
    campaignId: sent.campaignId || "",
    campaignName: sent.campaignName || sent.campaign || "Campaign",
    leadId: sent.leadId || "",
    leadName:
      sent.leadName || sent.toName || reply.fromName || reply.fromEmail || "Lead",
    sentSubject: sent.subject || sent.title || "",
    sentAt: sent.createdAt || "",
  };
}

function normalizeThreadSubject(value) {
  return String(value || "")
    .trim()
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/gi, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeMessageId(value) {
  return String(value || "")
    .trim()
    .replace(/^<|>$/g, "")
    .toLowerCase();
}

function normalizeReferences(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeMessageId).filter(Boolean);
  }

  return String(value || "")
    .split(/\s+/)
    .map(normalizeMessageId)
    .filter(Boolean);
}

function dedupeInboxItems(items = []) {
  const map = new Map();

  for (const item of items) {
    if (!item?.id) continue;
    map.set(item.id, item);
  }

  return Array.from(map.values());
}

async function sendMailWithRetry(transport, mail, options = {}) {
  const retries = clampNumber(options.retries ?? 3, 0, 8);
  const baseDelayMs = clampNumber(options.baseDelayMs ?? 1500, 250, 60000);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await transport.sendMail(mail);

      const rejected = Array.isArray(result.rejected) ? result.rejected : [];
      const accepted = Array.isArray(result.accepted) ? result.accepted : [];

      if (!accepted.length && rejected.length) {
        return {
          ok: false,
          attempts: attempt + 1,
          code: "EREJECTED",
          category: "recipient_rejected",
          retryable: false,
          responseCode: 550,
          httpStatus: 422,
          message: `SMTP rejected recipient: ${rejected.join(", ")}`,
          result,
        };
      }

      return {
        ok: true,
        attempts: attempt + 1,
        result,
      };
    } catch (error) {
      const classified = classifySmtpError(error);

      if (!classified.retryable || attempt >= retries) {
        return {
          ok: false,
          attempts: attempt + 1,
          ...classified,
        };
      }

      const exponentialDelay = baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * Math.max(250, baseDelayMs));
      await sleep(Math.min(300000, exponentialDelay + jitter));
    }
  }

  return {
    ok: false,
    attempts: retries + 1,
    code: "EUNKNOWN",
    category: "unknown",
    retryable: false,
    responseCode: 0,
    httpStatus: 502,
    message: "SMTP delivery failed.",
  };
}

function classifySmtpError(error = {}) {
  const responseCode = Number(error.responseCode || error.statusCode || 0);
  const code = String(error.code || "ESMTP");
  const response = String(error.response || error.message || "").trim();
  const normalized = response.toLowerCase();

  const rateLimited =
    responseCode === 421 ||
    responseCode === 429 ||
    /\b(rate|throttl|too many|slow down|4\.7\.)\b/i.test(response);

  const quotaExceeded =
    responseCode === 452 ||
    responseCode === 454 ||
    /\b(quota|daily limit|sending limit|limit exceeded|resource exhausted)\b/i.test(
      response
    );

  const authFailed =
    code === "EAUTH" ||
    responseCode === 530 ||
    responseCode === 534 ||
    responseCode === 535 ||
    /\b(authentication|credentials|username and password|app password)\b/i.test(
      response
    );

  const recipientRejected =
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 552 ||
    responseCode === 553 ||
    responseCode === 554 ||
    /\b(user unknown|mailbox unavailable|recipient rejected|does not exist)\b/i.test(
      response
    );

  const contentRejected =
    /\b(spam|policy|content rejected|message blocked|unsolicited)\b/i.test(
      response
    );

  const connectionFailure =
    ["ECONNECTION", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(
      code
    ) ||
    /\b(timeout|timed out|connection reset|socket|network)\b/i.test(response);

  let category = "smtp_error";
  let retryable = responseCode >= 400 && responseCode < 500;
  let httpStatus = retryable ? 503 : 502;

  if (rateLimited) {
    category = "rate_limit";
    retryable = true;
    httpStatus = 429;
  } else if (quotaExceeded) {
    category = "quota";
    retryable = false;
    httpStatus = 429;
  } else if (authFailed) {
    category = "authentication";
    retryable = false;
    httpStatus = 401;
  } else if (recipientRejected) {
    category = "recipient_rejected";
    retryable = false;
    httpStatus = 422;
  } else if (contentRejected) {
    category = "content_or_policy";
    retryable = false;
    httpStatus = 422;
  } else if (connectionFailure) {
    category = "connection";
    retryable = true;
    httpStatus = 503;
  }

  return {
    code,
    category,
    retryable,
    responseCode,
    httpStatus,
    message: response || "SMTP delivery failed.",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireUserId(userId) {
  const id = String(userId || "").trim();

  if (!id) {
    const error = new Error("User id is required for email settings.");
    error.statusCode = 401;
    throw error;
  }

  return id;
}

function ensureUserEmailSettings(state = {}, userId) {
  state.userEmailSettings = state.userEmailSettings || {};
  state.userEmailSettings[userId] = state.userEmailSettings[userId] || {};

  return state.userEmailSettings[userId];
}

function getUserEmailSettings(state = {}, userId) {
  return state.userEmailSettings?.[userId] || {};
}

function getAccountsFromSettings(emailSettings = {}) {
  const accounts = Array.isArray(emailSettings.emailAccounts)
    ? emailSettings.emailAccounts.filter(Boolean)
    : [];

  if (accounts.length) return accounts;

  if (hasEmailConfig(emailSettings.email)) {
    return [
      {
        ...emailSettings.email,
        id: emailSettings.email.id || "default-email-account",
        label:
          emailSettings.email.label ||
          emailSettings.email.fromEmail ||
          emailSettings.email.username ||
          "Primary email",
      },
    ];
  }

  return [];
}

function getActiveAccountFromSettings(emailSettings = {}, accounts = []) {
  const activeId = emailSettings.activeEmailAccountId;

  return (
    accounts.find((account) => account.id === activeId) ||
    accounts[0] ||
    emailSettings.email ||
    {}
  );
}

function getAccountByIdOrActive(emailSettings = {}, accountId = "", accounts = []) {
  const id = String(accountId || "").trim();

  return (
    accounts.find((account) => account.id === id) ||
    getActiveAccountFromSettings(emailSettings, accounts) ||
    {}
  );
}

function hasEmailConfig(value = {}) {
  return Boolean(
    value?.fromEmail || value?.username || value?.host || value?.incomingHost
  );
}

function sanitizeEmailSettings(input = {}, previous = {}) {
  const provider = ["gmail", "outlook", "custom"].includes(input.provider)
    ? input.provider
    : previous.provider || "custom";

  const username = String(input.username ?? previous.username ?? "").slice(
    0,
    180
  );

  const incomingUsername = String(
    input.incomingUsername ?? previous.incomingUsername ?? username
  ).slice(0, 180);

  const safe = {
    provider,
    label: String(
      input.label ||
        previous.label ||
        input.fromEmail ||
        previous.fromEmail ||
        "Email account"
    ).slice(0, 120),

    fromName: String(input.fromName ?? previous.fromName ?? "ReachFly.Ai").slice(
      0,
      120
    ),
    fromEmail: String(input.fromEmail ?? previous.fromEmail ?? "").slice(0, 180),
    replyTo: String(input.replyTo ?? previous.replyTo ?? "").slice(0, 180),

    host: String(input.host ?? previous.host ?? "").slice(0, 180),
    port: Number(input.port ?? previous.port ?? 587),
    secure: input.secure === true || input.secure === "true",

    username,

    incomingHost: String(input.incomingHost ?? previous.incomingHost ?? "").slice(
      0,
      180
    ),
    incomingPort: Number(input.incomingPort ?? previous.incomingPort ?? 993),
    incomingSecure:
      input.incomingSecure === false || input.incomingSecure === "false"
        ? false
        : true,
    incomingUsername,

    // Optional per-account bulk controls. Provider quotas still apply.
    maxConnections: clampNumber(
      input.maxConnections ?? previous.maxConnections ?? 1,
      1,
      20
    ),
    maxMessages: clampNumber(
      input.maxMessages ?? previous.maxMessages ?? 100,
      10,
      10000
    ),
    rateDelta: clampNumber(
      input.rateDelta ?? previous.rateDelta ?? 60000,
      1000,
      3600000
    ),
    rateLimit: clampNumber(
      input.rateLimit ?? previous.rateLimit ?? 5,
      1,
      1000
    ),
  };

  if (String(input.password || "").trim()) {
    safe.password = String(input.password);
  }

  if (String(input.incomingPassword || "").trim()) {
    safe.incomingPassword = String(input.incomingPassword);
  }

  return safe;
}

const ENCRYPTED_PREFIX = "enc:v1:";

function credentialKey() {
  const configured = String(process.env.CREDENTIAL_ENCRYPTION_KEY || "").trim();
  if (!configured) {
    const error = new Error(
      "CREDENTIAL_ENCRYPTION_KEY is required before saving SMTP or IMAP credentials."
    );
    error.statusCode = 500;
    throw error;
  }

  if (/^[a-f0-9]{64}$/i.test(configured)) {
    return Buffer.from(configured, "hex");
  }

  try {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length === 32) return decoded;
  } catch {}

  // This keeps configuration ergonomic while still producing a 256-bit key.
  // A randomly generated 32-byte base64 value is strongly preferred.
  return crypto.createHash("sha256").update(configured).digest();
}

function encryptSecret(value) {
  const plaintext = String(value || "");
  if (!plaintext || plaintext.startsWith(ENCRYPTED_PREFIX)) return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", credentialKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return (
    ENCRYPTED_PREFIX +
    [
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(":")
  );
}

function decryptSecret(value) {
  const stored = String(value || "");
  if (!stored || !stored.startsWith(ENCRYPTED_PREFIX)) return stored;

  const payload = stored.slice(ENCRYPTED_PREFIX.length);
  const [ivValue, tagValue, ciphertextValue] = payload.split(":");
  if (!ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Stored email credential is malformed.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    credentialKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function sealStoredCredentials(settings = {}) {
  return {
    ...settings,
    password: settings.password ? encryptSecret(settings.password) : "",
    incomingPassword: settings.incomingPassword
      ? encryptSecret(settings.incomingPassword)
      : "",
  };
}

function hydrateCredentials(settings = {}) {
  return {
    ...settings,
    password: decryptSecret(settings.password),
    incomingPassword: decryptSecret(settings.incomingPassword),
  };
}

function publicEmailBundle(accounts = [], activeAccount = {}) {
  const publicAccounts = accounts.map(publicEmailSettings);
  const publicActive = publicEmailSettings(activeAccount);
  const activeAccountId = publicActive.id || publicAccounts[0]?.id || "";

  return {
    ...publicActive,
    accounts: publicAccounts,
    activeAccountId,
    activeAccount: publicActive,
  };
}

function publicEmailSettings(settings = {}) {
  const { password, incomingPassword, ownerId, userId, ...publicSettings } =
    settings;

  return {
    ...publicSettings,
    hasPassword: Boolean(password),
    hasIncomingPassword: Boolean(incomingPassword || password),
  };
}

function buildInboxId(userId, accountId, uid) {
  return `mailbox:${userId || "user"}:${accountId || "default"}:${uid}`;
}

function mergeInboxItems(newItems, oldItems) {
  const map = new Map();

  for (const item of [...newItems, ...oldItems]) {
    if (!item?.id) continue;
    map.set(item.id, item);
  }

  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(b.createdAt || 0).getTime() -
      new Date(a.createdAt || 0).getTime()
  );
}

function firstAddress(value) {
  const item = Array.isArray(value) ? value[0] : value;

  if (!item) {
    return {
      name: "",
      address: "",
    };
  }

  return {
    name: item.name || "",
    address: item.address || "",
  };
}

function firstValidEmail(value) {
  const parts = String(value || "")
    .split(/[;,\s|]+/)
    .map((item) => normalizeEmail(item))
    .filter(Boolean);

  return parts.find((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)) || "";
}

function cleanBody(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textToHtml(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`
    )
    .join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeEmailName(value) {
  return String(value || "")
    .replace(/"/g, "")
    .replace(/[<>]/g, "")
    .trim();
}

function getSmtpSecure(settings = {}) {
  const port = Number(settings.port || 587);

  if (port === 465) return true;
  if (port === 587) return false;

  return Boolean(settings.secure);
}

function clampNumber(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) return min;

  return Math.max(min, Math.min(max, number));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}