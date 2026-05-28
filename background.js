
async function openComposeTab() {
  await browser.tabs.create({ url: browser.runtime.getURL("compose-tab.html") });
}

browser.browserAction.onClicked.addListener(openComposeTab);

function splitRecipients(value) {
  if (!value) return [];
  const text = String(value || "");
  const out = [];
  let cur = "";
  let inAngle = false;
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === "<") inAngle = true;
    if (!inQuote && ch === ">") inAngle = false;
    if (!inQuote && !inAngle && (ch === "," || ch === ";")) {
      const v = cur.trim();
      if (v) out.push(v);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const v = cur.trim();
  if (v) out.push(v);
  return out;
}

function normalizeEmail(value) {
  const raw = String(value || "").trim().toLowerCase();
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).replace(/^mailto:/, "").trim();
}

async function getOwnEmailSet() {
  const emails = new Set();
  try {
    if (!browser.accounts || !browser.accounts.list) return emails;
    const accounts = await browser.accounts.list();
    for (const account of accounts || []) {
      for (const identity of (account.identities || [])) {
        const email = normalizeEmail(identity.email);
        if (email) emails.add(email);
      }
    }
  } catch (e) {}
  return emails;
}

function uniqueRecipientsExcludingOwn(list, ownEmails) {
  const seen = new Set();
  const out = [];
  for (const recipient of list || []) {
    const value = String(recipient || "").trim();
    if (!value) continue;
    const email = normalizeEmail(value);
    if (!email) continue;
    if (ownEmails && ownEmails.has(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(value);
  }
  return out;
}

async function getContacts() {
  try {
    const books = await browser.addressBooks.list(true);
    const contacts = [];
    for (const book of books || []) {
      for (const child of book.contacts || []) {
        const p = child.properties || {};
        const email = p.PrimaryEmail || p.SecondEmail || p.email || "";
        if (!email) continue;
        const name = p.DisplayName || [p.FirstName, p.LastName].filter(Boolean).join(" ") || email;
        contacts.push({ name, email, book: book.name || "" });
      }
    }
    contacts.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    return contacts;
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

async function buildComposeDetails(message) {
  const details = {
    to: splitRecipients(message.to),
    cc: splitRecipients(message.cc),
    bcc: splitRecipients(message.bcc),
    subject: message.subject || "",
    body: message.htmlBody || "",
    isPlainText: false
  };
  // Thunderbird expects a list of FileAttachment objects: { file: File, name?: string }.
  // The HTML file picker returns raw File objects; beginNew() rejects them directly.
  if (Array.isArray(message.attachments) && message.attachments.length) {
    details.attachments = message.attachments
      .map(att => {
        if (!att) return null;
        // Fixed case: raw file coming from the tab.
        if (typeof File !== "undefined" && att instanceof File) {
          return { file: att, name: att.name || "attachment" };
        }
        // Case already in the correct format.
        if (att.file) {
          return { file: att.file, name: att.name || (att.file && att.file.name) || "attachment" };
        }
        return null;
      })
      .filter(Boolean);
  }
  return details;
}

async function openNativeCompose(message) {
  const details = await buildComposeDetails(message);
  if (message.sourceMessageId && (message.composeMode === "reply" || message.composeMode === "replyAll")) {
    const replyType = message.composeMode === "replyAll" ? "replyToAll" : "replyToSender";
    return await browser.compose.beginReply(Number(message.sourceMessageId), replyType, details);
  }
  // For transfers opened from the tab editor, use beginNew() with the body and
  // attachments prepared by the tab. This avoids Thunderbird replacing the
  // custom editor content with its native forward template.
  return await browser.compose.beginNew(details);
}
async function sendDirect(message) {
  const details = await buildComposeDetails(message);

  // The Thunderbird preference mail.SpellCheckBeforeSend=false must be managed
  // through the Thunderbird configuration editor. The extension no longer modifies it.

  let composeTab;
  if (message.sourceMessageId && (message.composeMode === "reply" || message.composeMode === "replyAll")) {
    const replyType = message.composeMode === "replyAll" ? "replyToAll" : "replyToSender";
    composeTab = await browser.compose.beginReply(Number(message.sourceMessageId), replyType, details);
  } else {
    // Forward is sent as a new composed message because compose-tab.js already
    // injects the forwarded body and original attachments.
    composeTab = await browser.compose.beginNew(details);
  }

  try {
    if (composeTab && composeTab.windowId) {
      await browser.windows.update(composeTab.windowId, { state: "minimized" });
    }
  } catch (e) {
    // Non-fatal: continue sending even if the window cannot be minimized.
  }

  try {
    await browser.compose.sendMessage(composeTab.id, { mode: "sendNow" });
  } catch (e) {
    // Fallback for Thunderbird versions where options are not supported.
    await browser.compose.sendMessage(composeTab.id);
  }

  try {
    if (composeTab && composeTab.id) await browser.tabs.remove(composeTab.id);
  } catch (e) {}

  return { ok: true };
}


function encodeParams(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  return qs.toString();
}

async function openMessageComposeTab(message) {
  const url = browser.runtime.getURL("compose-tab.html") + "?" + encodeParams({ mode: message.mode, messageId: message.messageId });
  await browser.tabs.create({ url });
}

function cleanSubject(subject, prefix) {
  const s = String(subject || "").trim();
  if (!s) return prefix + ":";
  const re = prefix === "Re" ? /^\s*re\s*:/i : /^\s*(fwd?|tr)\s*:/i;
  return re.test(s) ? s : prefix + ": " + s;
}


function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextToHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function extractBodyFromPart(part) {
  if (!part) return { html: "", text: "" };
  const ct = String(part.contentType || "").toLowerCase();
  if (ct.startsWith("text/html") && part.body) return { html: String(part.body), text: "" };
  if (ct.startsWith("text/plain") && part.body) return { html: "", text: String(part.body) };
  let best = { html: "", text: "" };
  for (const child of (part.parts || [])) {
    const found = extractBodyFromPart(child);
    if (found.html) return found;
    if (found.text && !best.text) best = found;
  }
  return best;
}

async function getOriginalMessageBodyHtml(id) {
  try {
    if (!browser.messages || !browser.messages.getFull) return "";
    const full = await browser.messages.getFull(id);
    const found = extractBodyFromPart(full);
    if (found.html) return found.html;
    if (found.text) return plainTextToHtml(found.text);
  } catch (e) {}
  return "";
}

function formatReplyDate(dateValue) {
  const d = dateValue ? new Date(dateValue) : new Date();
  if (isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatReplyAuthor(author) {
  const raw = String(author || "").trim();
  const match = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  return (match ? match[1] : raw).trim() || raw;
}

async function getReplyPosition() {
  // Thunderbird stores the reply position as an integer preference:
  // 1 = reply above the quoted message, 0 = reply below it.
  // Some installations/extensions expose this through LegacyPrefs.
  // If it is not available, keep the current extension behavior: above.
  try {
    if (browser.LegacyPrefs && browser.LegacyPrefs.getPref) {
      const value = await browser.LegacyPrefs.getPref("mail.identity.default.reply_on_top");
      if (String(value) === "0") return "below";
      if (String(value) === "1") return "above";
    }
  } catch (e) {}

  try {
    const stored = await browser.storage.local.get("replyPosition");
    if (stored && stored.replyPosition === "below") return "below";
  } catch (e) {}

  return "above";
}

async function getMessageComposeContext(message) {
  const mode = message.mode || "new";
  const id = Number(message.messageId);
  if (!id || !browser.messages || !browser.messages.get) return { mode };
  const m = await browser.messages.get(id);
  const author = m.author || "";
  const recipients = Array.isArray(m.recipients) ? m.recipients : [];
  const ccList = Array.isArray(m.ccList) ? m.ccList : [];
  const originalBodyHtml = await getOriginalMessageBodyHtml(id);
  const replyHeader = `Le ${formatReplyDate(m.date)}, ${formatReplyAuthor(author)} a écrit :`;
  const replyPosition = await getReplyPosition();
  if (mode === "forward") {
    return {
      mode,
      sourceMessageId: id,
      to: "",
      cc: "",
      bcc: "",
      subject: cleanSubject(m.subject, "Fwd"),
      originalBodyHtml,
      replyHeader,
      forwardFrom: author,
      forwardDate: formatReplyDate(m.date),
      forwardSubject: m.subject || "",
      forwardTo: recipients.join(", "),
      replyPosition
    };
  }
  if (mode === "replyAll") {
    const ownEmails = await getOwnEmailSet();
    const toList = uniqueRecipientsExcludingOwn([author, ...recipients], ownEmails);
    const ccFiltered = uniqueRecipientsExcludingOwn(ccList, ownEmails)
      .filter(cc => !toList.map(normalizeEmail).includes(normalizeEmail(cc)));
    return { mode, sourceMessageId: id, to: toList.join(", "), cc: ccFiltered.join(", "), bcc: "", subject: cleanSubject(m.subject, "Re"), originalBodyHtml, replyHeader, replyPosition };
  }
  return { mode: "reply", sourceMessageId: id, to: author, cc: "", bcc: "", subject: cleanSubject(m.subject, "Re"), originalBodyHtml, replyHeader, replyPosition };
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return undefined;
  if (message.type === "get-contacts") return getContacts();
  if (message.type === "open-message-compose-tab") return openMessageComposeTab(message);
  if (message.type === "get-message-compose-context") return getMessageComposeContext(message);
  if (message.type === "open-native-compose") return openNativeCompose(message);
  if (message.type === "send-direct") return sendDirect(message);
  return undefined;
});
