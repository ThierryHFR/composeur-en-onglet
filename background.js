
async function getSingleComposeTabSetting() {
  try {
    const stored = await browser.storage.local.get({ singleComposeTab: false });
    return stored.singleComposeTab === true;
  } catch (e) {
    return false;
  }
}

async function focusOrOpenComposeTab(params = {}) {
  const baseUrl = browser.runtime.getURL("compose-tab.html");
  const qs = encodeParams(params);
  const url = qs ? baseUrl + "?" + qs : baseUrl;

  if (await getSingleComposeTabSetting()) {
    const existing = await browser.tabs.query({ url: baseUrl + "*" });
    if (existing && existing.length) {
      const tab = existing[0];
      await browser.tabs.update(tab.id, { active: true, url });
      if (tab.windowId) await browser.windows.update(tab.windowId, { focused: true });
      return tab;
    }
  }

  return await browser.tabs.create({ url });
}

async function openComposeTab() {
  await focusOrOpenComposeTab();
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
  return await focusOrOpenComposeTab({ mode: message.mode, messageId: message.messageId });
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


function headerValueFromFull(full, name) {
  const wanted = String(name || "").toLowerCase();
  const headers = full && full.headers ? full.headers : null;
  if (!headers) return "";
  if (Array.isArray(headers)) {
    const found = headers.find(h => String(h.name || "").toLowerCase() === wanted);
    return found ? String(found.value || "") : "";
  }
  const value = headers[name] || headers[wanted] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value ? String(value) : "";
}

async function getMessageHeaderValue(id, name) {
  try {
    if (!browser.messages || !browser.messages.getFull) return "";
    const full = await browser.messages.getFull(id);
    return headerValueFromFull(full, name);
  } catch (e) {
    return "";
  }
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
  // Thunderbird 140+ ne donne pas acces directement a cette preference.
  // On utilise uniquement l'option locale de l'extension.
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

  if (mode === "draft") {
    const bcc = await getMessageHeaderValue(id, "Bcc");
    return {
      mode: "draft",
      sourceMessageId: id,
      draftKey: `draft-${id}`,
      to: recipients.join(", "),
      cc: ccList.join(", "),
      bcc,
      subject: m.subject || "",
      bodyHtml: originalBodyHtml || ""
    };
  }

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


// --- True Thunderbird drafts for TB 140+ (no native compose window) ---
const AUTO_DRAFTS = new Map();

function randomToken() {
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, n => n.toString(16).padStart(8, "0")).join("");
}

function foldHeaderLine(name, value) {
  const raw = `${name}: ${String(value || "")}`.replace(/\r?\n/g, " ");
  if (raw.length <= 76) return raw;
  const parts = [];
  let line = raw;
  while (line.length > 76) {
    let cut = line.lastIndexOf(" ", 76);
    if (cut < name.length + 2) cut = 76;
    parts.push(line.slice(0, cut));
    line = " " + line.slice(cut).trimStart();
  }
  parts.push(line);
  return parts.join("\r\n");
}

function encodeMimeHeader(value) {
  const text = String(value || "");
  if (!/[^\x00-\x7F]/.test(text)) return text.replace(/\r?\n/g, " ");
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function htmlToPlainForMime(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function normalizeNewlines(value) {
  return String(value || "").replace(/\r?\n/g, "\r\n");
}

function quotedPrintableUtf8(value) {
  const bytes = new TextEncoder().encode(normalizeNewlines(value));
  let line = "";
  const out = [];
  const hex = n => n.toString(16).toUpperCase().padStart(2, "0");
  function push(chunk) {
    if (line.length + chunk.length > 73) {
      out.push(line + "=");
      line = "";
    }
    line += chunk;
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 13 && bytes[i + 1] === 10) {
      out.push(line);
      line = "";
      i++;
      continue;
    }
    if ((b >= 33 && b <= 60) || (b >= 62 && b <= 126)) push(String.fromCharCode(b));
    else if (b === 9 || b === 32) {
      const next = bytes[i + 1];
      if (next === 13 || next === 10 || i === bytes.length - 1) push("=" + hex(b));
      else push(String.fromCharCode(b));
    } else {
      push("=" + hex(b));
    }
  }
  out.push(line);
  return out.join("\r\n");
}

async function fileToBase64Lines(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary).replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function cleanMimeFilename(name) {
  return String(name || "attachment").replace(/[\r\n"]/g, "_");
}

function shouldSaveDraftMessage(message) {
  const bodyHtmlWithoutSignature = String(message.htmlBody || "").replace(/<div[^>]*class=["'][^"']*moz-signature[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "");
  const body = htmlToPlainForMime(bodyHtmlWithoutSignature).trim();
  return Boolean(
    String(message.to || "").trim() ||
    String(message.cc || "").trim() ||
    String(message.bcc || "").trim() ||
    String(message.subject || "").trim() ||
    body ||
    (Array.isArray(message.attachments) && message.attachments.length)
  );
}

async function getDefaultIdentityAndAccount(preferredAccountId) {
  const accounts = await browser.accounts.list(true);
  let account = null;
  if (preferredAccountId) account = accounts.find(a => a.id === preferredAccountId) || null;
  if (!account) {
    try { account = await browser.accounts.getDefault(true); } catch (e) {}
  }
  if (!account) account = (accounts || []).find(a => (a.identities || []).length) || (accounts || [])[0];
  let identity = null;
  if (account && browser.identities && browser.identities.getDefault) {
    try { identity = await browser.identities.getDefault(account.id); } catch (e) {}
  }
  if (!identity) identity = account && account.identities && account.identities[0] ? account.identities[0] : null;
  return { account, identity, accounts };
}

function findFolderRecursive(folder, predicate) {
  if (!folder) return null;
  if (predicate(folder)) return folder;
  for (const child of (folder.subFolders || [])) {
    const found = findFolderRecursive(child, predicate);
    if (found) return found;
  }
  return null;
}

async function getPreferredAccountIdFromSource(message) {
  try {
    if (!message.sourceMessageId || !browser.messages || !browser.messages.get) return null;
    const src = await browser.messages.get(Number(message.sourceMessageId));
    return src && src.folder && src.folder.accountId ? src.folder.accountId : null;
  } catch (e) {
    return null;
  }
}

async function findDraftsFolder(message) {
  const preferredAccountId = await getPreferredAccountIdFromSource(message);
  const { account, identity, accounts } = await getDefaultIdentityAndAccount(preferredAccountId);
  const accountOrder = [account, ...(accounts || []).filter(a => !account || a.id !== account.id)].filter(Boolean);

  for (const acc of accountOrder) {
    const special = findFolderRecursive(acc.rootFolder, f => Array.isArray(f.specialUse) && f.specialUse.includes("drafts"));
    if (special) return { folder: special, identity: (acc.identities || [])[0] || identity };
  }

  for (const acc of accountOrder) {
    const named = findFolderRecursive(acc.rootFolder, f => /^(drafts|brouillons)$/i.test(String(f.name || "")) || /(^|\/)(Drafts|Brouillons)$/i.test(String(f.path || "")));
    if (named) return { folder: named, identity: (acc.identities || [])[0] || identity };
  }

  throw new Error("Dossier Brouillons introuvable pour les comptes Thunderbird.");
}

function buildIdentitySignatureHtml(identity) {
  if (!identity || !identity.signature) return "";
  const raw = String(identity.signature || "").trim();
  if (!raw) return "";

  const content = identity.signatureIsPlainText
    ? plainTextToHtml(raw)
    : raw;

  const plain = htmlToPlainForMime(content).trim();
  if (!plain) return "";
  const hasDelimiter = /^--\s*(\r?\n|$)/.test(plain);
  return hasDelimiter
    ? `<div class="moz-signature">${content}</div>`
    : `<div class="moz-signature">-- <br>${content}</div>`;
}

async function getDefaultSignature(message = {}) {
  try {
    const preferredAccountId = await getPreferredAccountIdFromSource(message);
    const { identity } = await getDefaultIdentityAndAccount(preferredAccountId);
    return { ok: true, signatureHtml: buildIdentitySignatureHtml(identity), identityId: identity && identity.id };
  } catch (e) {
    return { ok: false, signatureHtml: "", error: String(e && e.message ? e.message : e) };
  }
}

async function buildDraftMimeFile(message, state, identity) {
  const messageId = state.messageId || `<compose-tab-${randomToken()}@composeur-en-onglet.local>`;
  state.messageId = messageId;
  const fromEmail = identity && identity.email ? identity.email : "";
  const fromName = identity && identity.name ? identity.name : "";
  const from = fromEmail ? (fromName ? `${encodeMimeHeader(fromName)} <${fromEmail}>` : fromEmail) : "undisclosed-sender:;";
  const subject = String(message.subject || "").trim() || "(sans sujet)";
  const html = `<!doctype html><html><body>${message.htmlBody || ""}</body></html>`;
  const plain = htmlToPlainForMime(message.htmlBody || "");
  const altBoundary = `alt_${randomToken()}`;
  const mixedBoundary = `mixed_${randomToken()}`;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  const headers = [
    foldHeaderLine("From", from),
    message.to ? foldHeaderLine("To", message.to) : "To: undisclosed-recipients:;",
    message.cc ? foldHeaderLine("Cc", message.cc) : null,
    message.bcc ? foldHeaderLine("Bcc", message.bcc) : null,
    foldHeaderLine("Subject", encodeMimeHeader(subject)),
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0; DSN=0; uuencode=0; attachmentreminder=0"
  ].filter(Boolean);

  let alt = "";
  alt += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
  alt += `--${altBoundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintableUtf8(plain)}\r\n`;
  alt += `--${altBoundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintableUtf8(html)}\r\n`;
  alt += `--${altBoundary}--\r\n`;

  let raw = "";
  if (attachments.length) {
    raw = headers.concat([`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`]).join("\r\n") + "\r\n\r\n";
    raw += `--${mixedBoundary}\r\n${alt}\r\n`;
    for (const att of attachments) {
      const file = att && att.file ? att.file : att;
      if (!file || !file.arrayBuffer) continue;
      const name = cleanMimeFilename(att.name || file.name || "attachment");
      const type = file.type || "application/octet-stream";
      raw += `--${mixedBoundary}\r\n`;
      raw += `Content-Type: ${type}; name="${name}"\r\n`;
      raw += `Content-Disposition: attachment; filename="${name}"\r\n`;
      raw += "Content-Transfer-Encoding: base64\r\n\r\n";
      raw += await fileToBase64Lines(file);
      raw += "\r\n";
    }
    raw += `--${mixedBoundary}--\r\n`;
  } else {
    raw = headers.join("\r\n") + "\r\n" + alt;
  }

  return new File([raw], "compose-tab-draft.eml", { type: "message/rfc822" });
}

async function deleteDraftMessage(messageId) {
  if (!messageId || !browser.messages || !browser.messages.delete) return;
  try {
    await browser.messages.delete([Number(messageId)], { deletePermanently: true });
  } catch (e1) {
    try { await browser.messages.delete([Number(messageId)]); } catch (e2) {}
  }
}

async function saveImportedDraft(message) {
  if (!shouldSaveDraftMessage(message)) {
    await deleteImportedDraft(message);
    return { ok: true, empty: true };
  }
  if (!browser.messages || !browser.messages.import) {
    throw new Error("messages.import indisponible. Thunderbird 140 ou supérieur est requis.");
  }
  const key = message.draftKey || "default";
  const state = AUTO_DRAFTS.get(key) || {};
  const { folder, identity } = await findDraftsFolder(message);
  const file = await buildDraftMimeFile(message, state, identity);

  // The import API rejects duplicate Message-ID values in the destination folder.
  // Replacing the previous imported draft keeps a single visible draft.
  if (state.importedMessageId) await deleteDraftMessage(state.importedMessageId);

  const imported = await browser.messages.import(file, folder, { read: true, new: false });
  state.importedMessageId = imported && imported.id;
  state.folderId = folder.id;
  state.lastSavedAt = Date.now();

  if (message.composeMode === "draft" && message.sourceMessageId && !state.originalDraftDeleted) {
    const originalId = Number(message.sourceMessageId);
    if (originalId && originalId !== Number(state.importedMessageId)) {
      await deleteDraftMessage(originalId);
    }
    state.originalDraftDeleted = true;
  }

  AUTO_DRAFTS.set(key, state);
  return { ok: true, messageId: state.importedMessageId, lastSavedAt: state.lastSavedAt };
}

async function deleteImportedDraft(message) {
  const key = message.draftKey || "default";
  const state = AUTO_DRAFTS.get(key);
  if (state && state.importedMessageId) await deleteDraftMessage(state.importedMessageId);
  if (message && message.composeMode === "draft" && message.sourceMessageId && !(state && state.originalDraftDeleted)) {
    await deleteDraftMessage(Number(message.sourceMessageId));
  }
  AUTO_DRAFTS.delete(key);
  return { ok: true };
}



// --- Draft context menu: open a Thunderbird draft in the tab composer ---
const EDIT_DRAFT_MENU_ID = "open-draft-in-compose-tab";

function isDraftFolderLike(folder) {
  if (!folder) return false;
  const specialUse = Array.isArray(folder.specialUse) ? folder.specialUse : [];
  const name = String(folder.name || "");
  const path = String(folder.path || "");
  return specialUse.includes("drafts") || /^(Drafts|Brouillons)$/i.test(name) || /(^|\/)(Drafts|Brouillons)$/i.test(path);
}

function getFirstMessageFromList(list) {
  if (!list) return null;
  if (Array.isArray(list)) return list[0] || null;
  if (Array.isArray(list.messages)) return list.messages[0] || null;
  return null;
}

async function registerDraftContextMenu() {
  if (!browser.menus || !browser.menus.create) return;
  try { await browser.menus.remove(EDIT_DRAFT_MENU_ID); } catch (e) {}
  browser.menus.create({
    id: EDIT_DRAFT_MENU_ID,
    title: browser.i18n.getMessage("editDraftButton") || "Modifier dans Composeur en onglet",
    contexts: ["message_list"],
    visible: true
  });
}

async function updateDraftContextMenu(info) {
  if (!browser.menus || !browser.menus.update) return;
  if (!info || !Array.isArray(info.contexts) || !info.contexts.includes("message_list")) return;
  const message = getFirstMessageFromList(info.selectedMessages);
  const visible = isDraftFolderLike(message && message.folder);
  try {
    await browser.menus.update(EDIT_DRAFT_MENU_ID, { visible, enabled: visible });
    if (browser.menus.refresh) await browser.menus.refresh();
  } catch (e) {}
}

async function openDraftFromContextMenu(info) {
  if (!info || info.menuItemId !== EDIT_DRAFT_MENU_ID) return;
  const message = getFirstMessageFromList(info.selectedMessages);
  if (!message || !message.id) return;
  await openMessageComposeTab({ mode: "draft", messageId: message.id });
}

try {
  registerDraftContextMenu();
  if (browser.runtime.onInstalled) browser.runtime.onInstalled.addListener(registerDraftContextMenu);
  if (browser.runtime.onStartup) browser.runtime.onStartup.addListener(registerDraftContextMenu);
  if (browser.menus && browser.menus.onShown) browser.menus.onShown.addListener(updateDraftContextMenu);
  if (browser.menus && browser.menus.onClicked) browser.menus.onClicked.addListener(openDraftFromContextMenu);
} catch (e) {}



// --- Dynamic message action title ---
async function updateMessageActionTitleForMessage(tabId, message) {
  if (!browser.messageDisplayAction || !browser.messageDisplayAction.setTitle) return;
  const isDraft = isDraftFolderLike(message && message.folder);
  const title = isDraft
    ? (browser.i18n.getMessage("editDraftTitle") || "Modifier le brouillon")
    : (browser.i18n.getMessage("messageActionTitle") || "Répondre / Transférer");
  try {
    await browser.messageDisplayAction.setTitle({ tabId, title });
  } catch (e) {}
}

async function updateMessageActionTitleForActiveTab() {
  try {
    if (!browser.messageDisplay || !browser.tabs) return;
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0] ? tabs[0] : null;
    if (!tab || tab.id === undefined) return;
    let message = null;
    if (browser.messageDisplay.getDisplayedMessage) {
      message = await browser.messageDisplay.getDisplayedMessage(tab.id);
    } else if (browser.messageDisplay.getDisplayedMessages) {
      const list = await browser.messageDisplay.getDisplayedMessages(tab.id);
      message = getFirstMessageFromList(list);
    }
    if (message) await updateMessageActionTitleForMessage(tab.id, message);
  } catch (e) {}
}

try {
  if (browser.messageDisplay && browser.messageDisplay.onMessageDisplayed) {
    browser.messageDisplay.onMessageDisplayed.addListener((tab, message) => {
      updateMessageActionTitleForMessage(tab && tab.id, message);
    });
  }
  if (browser.messageDisplay && browser.messageDisplay.onMessagesDisplayed) {
    browser.messageDisplay.onMessagesDisplayed.addListener((tab, messages) => {
      updateMessageActionTitleForMessage(tab && tab.id, getFirstMessageFromList(messages));
    });
  }
  if (browser.tabs && browser.tabs.onActivated) {
    browser.tabs.onActivated.addListener(updateMessageActionTitleForActiveTab);
  }
} catch (e) {}

browser.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return undefined;
  if (message.type === "get-contacts") return getContacts();
  if (message.type === "open-message-compose-tab") return openMessageComposeTab(message);
  if (message.type === "get-message-compose-context") return getMessageComposeContext(message);
  if (message.type === "open-native-compose") return openNativeCompose(message);
  if (message.type === "send-direct") return sendDirect(message);
  if (message.type === "save-imported-draft") return saveImportedDraft(message);
  if (message.type === "delete-imported-draft") return deleteImportedDraft(message);
  if (message.type === "get-default-signature") return getDefaultSignature(message);
  return undefined;
});
