function msg(name, substitutions) {
  const value = browser.i18n.getMessage(name, substitutions);
  return value || name;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const value = msg(el.dataset.i18n);
    if (el.tagName.toLowerCase() === "title") document.title = value;
    else el.textContent = value;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = msg(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = msg(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach(el => {
    el.setAttribute("aria-label", msg(el.dataset.i18nAriaLabel));
  });
  document.documentElement.lang = browser.i18n.getUILanguage().split("-")[0] || "fr";
}

applyI18n();

let activeRecipientField = "to";
let allContacts = [];
let selectedAttachments = [];
let composeMode = "new";
let sourceMessageId = null;
let draftKey = `compose-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let draftTimer = null;
let lastDraftFingerprint = "";
let messageWasSent = false;
let currentSignatureHtml = "";
const DRAFT_SAVE_DELAY_MS = 30000;
const $ = id => document.getElementById(id);
const editor = $("editor");


function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseHtmlDocument(html) {
  return new DOMParser().parseFromString(String(html || ""), "text/html");
}

function serializeNodes(nodes) {
  const container = document.createElement("div");
  for (const node of nodes) {
    container.appendChild(document.importNode(node, true));
  }
  return container.getHTML ? container.getHTML() : Array.from(container.childNodes).map(node => new XMLSerializer().serializeToString(node)).join("");
}

function htmlToPlainText(html) {
  const doc = parseHtmlDocument(html);
  const source = doc.body || doc.documentElement;
  return (source.innerText || source.textContent || "").replace(/\u00a0/g, " ").trimEnd();
}

function extractHtmlBody(html) {
  const doc = parseHtmlDocument(html);
  return serializeNodes(doc.body ? doc.body.childNodes : doc.childNodes);
}

function setHtmlContent(element, html) {
  const doc = parseHtmlDocument(html);
  element.replaceChildren(...Array.from(doc.body.childNodes).map(node => document.importNode(node, true)));
}

function quoteOriginalMessage(html) {
  const bodyHtml = extractHtmlBody(html);
  if (!htmlToPlainText(bodyHtml).trim()) return "";
  return `<blockquote type="cite" class="moz-cite-prefix">${bodyHtml}</blockquote>`;
}

function setEditorCursor(node, atEnd = false) {
  editor.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  if (!node) node = editor;
  if (atEnd) {
    range.selectNodeContents(node);
    range.collapse(false);
  } else {
    range.setStart(node, 0);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function applyReplyOrReplyAllBody(ctx) {
  const header = ctx && ctx.replyHeader ? ctx.replyHeader : "Le message original a écrit :";
  const quotedOriginal = quoteOriginalMessage(ctx && ctx.originalBodyHtml ? ctx.originalBodyHtml : "");
  const replyPosition = ctx && ctx.replyPosition ? ctx.replyPosition : "above";

  if (replyPosition === "below") {
    setHtmlContent(editor, `<div>${escapeHtml(header)}</div>${quotedOriginal}<div><br></div>${signatureBlockHtml()}<div><br></div>`);
    setEditorCursor(editor.lastChild, true);
    return;
  }

  setHtmlContent(editor, `<div><br></div><div>${escapeHtml(header)}</div>${quotedOriginal}<div><br></div>${signatureBlockHtml()}`);
  setEditorCursor(editor.firstChild, false);
}


function buildForwardedMessageHtml(ctx, original) {
  const parts = [];
  if (htmlToPlainText(original).trim()) {
    parts.push('<div>-------- Message transféré --------</div>');
    if (ctx && ctx.forwardFrom) parts.push(`<div><b>De :</b> ${escapeHtml(ctx.forwardFrom)}</div>`);
    if (ctx && ctx.forwardDate) parts.push(`<div><b>Date :</b> ${escapeHtml(ctx.forwardDate)}</div>`);
    if (ctx && ctx.forwardSubject) parts.push(`<div><b>Sujet :</b> ${escapeHtml(ctx.forwardSubject)}</div>`);
    if (ctx && ctx.forwardTo) parts.push(`<div><b>À :</b> ${escapeHtml(ctx.forwardTo)}</div>`);
    parts.push('<div><br></div>');
    parts.push(`<blockquote type="cite" class="moz-cite-prefix">${original}</blockquote>`);
  }
  return parts.join("");
}

function applyForwardBody(ctx) {
  const original = ctx && ctx.originalBodyHtml ? extractHtmlBody(ctx.originalBodyHtml) : "";
  const forwardedMessage = buildForwardedMessageHtml(ctx, original);
  const replyPosition = ctx && ctx.replyPosition ? ctx.replyPosition : "above";

  if (replyPosition === "below") {
    setHtmlContent(editor, `${forwardedMessage}<div><br></div>${signatureBlockHtml()}<div><br></div>`);
    setEditorCursor(editor.lastChild, true);
    return;
  }

  setHtmlContent(editor, `<div><br></div>${signatureBlockHtml()}<div><br></div>${forwardedMessage}`);
  setEditorCursor(editor.firstChild, false);
}

async function addOriginalAttachments(messageId) {
  try {
    if (!browser.messages || !browser.messages.listAttachments || !browser.messages.getAttachmentFile) return;
    const attachments = await browser.messages.listAttachments(Number(messageId));
    for (const att of attachments || []) {
      const partName = att.partName || att.name || att.filename;
      if (!partName) continue;
      const file = await browser.messages.getAttachmentFile(Number(messageId), partName);
      if (file) selectedAttachments.push(file);
    }
    renderAttachments();
  } catch (e) {
    setStatus(msg("genericError", ["Pièces jointes du message original non ajoutées : " + String(e && e.message ? e.message : e)]));
  }
}

function signatureBlockHtml() {
  return currentSignatureHtml || "";
}

async function loadDefaultSignature(messageId = null) {
  try {
    const res = await browser.runtime.sendMessage({ type: "get-default-signature", sourceMessageId: messageId });
    currentSignatureHtml = res && res.signatureHtml ? res.signatureHtml : "";
  } catch (e) {
    currentSignatureHtml = "";
  }
}

function applyDefaultSignature() {
  setHtmlContent(editor, `<div><br></div>${signatureBlockHtml()}`);
  const range = document.createRange();
  const sel = window.getSelection();
  range.setStart(editor.firstChild, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

for (const el of document.querySelectorAll(".recipient")) {
  el.addEventListener("focus", () => { activeRecipientField = el.id; });
}

function setStatus(text) { $("status").textContent = text || ""; }
function focusEditor() { editor.focus(); }

function exec(cmd, value = null) {
  focusEditor();
  document.execCommand(cmd, false, value);
  scheduleDraftSave();
}

function normalizeEmail(value) {
  const raw = String(value || "").trim().toLowerCase();
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).replace(/^mailto:/, "").trim();
}

function splitRecipients(value) {
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

function formatRecipient(contactOrEmail) {
  if (!contactOrEmail) return "";
  if (typeof contactOrEmail === "string") return contactOrEmail.trim();

  const email = String(contactOrEmail.email || "").trim();
  let name = String(contactOrEmail.name || "").trim();
  if (!email) return "";

  // If the name is missing, identical to the address, or looks like an email address, keep only the email address.
  if (!name || normalizeEmail(name) === normalizeEmail(email)) return email;

  // Prevents breaking recipient separation and the "Name <email>" format.
  name = name.replace(/[<>]/g, "").replace(/[;,]/g, " ").replace(/\s+/g, " ").trim();
  return name ? `${name} <${email}>` : email;
}

function getAllRecipientEmails() {
  const emails = new Set();
  for (const id of ["to", "cc", "bcc"]) {
    for (const part of splitRecipients($(id).value)) {
      const normalized = normalizeEmail(part);
      if (normalized) emails.add(normalized);
    }
  }
  return emails;
}

function addRecipient(contactOrEmail) {
  const email = formatRecipient(contactOrEmail);
  const normalized = normalizeEmail(email);
  if (!normalized) return;

  if (getAllRecipientEmails().has(normalized)) {
    setStatus(msg("duplicateAddress", [email]));
    const field = $(activeRecipientField || "to");
    field.focus();
    return;
  }

  const field = $(activeRecipientField || "to");
  const recipients = splitRecipients(field.value);
  recipients.push(email);
  field.value = recipients.join(", ");
  field.focus();
  setStatus("");
}

function renderContacts(list) {
  const ul = $("contacts");
  ul.textContent = "";
  for (const c of list) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    const email = document.createElement("span");
    const emailValue = String(c.email || "").trim();
    const initial = emailValue.charAt(0).toUpperCase() || "?";
    const colorIndex = initial.charCodeAt(0) % 8;

    li.dataset.initial = initial;
    li.classList.add(`avatarColor${colorIndex}`);
    name.className = "contactName";
    email.className = "contactEmail";
    name.textContent = c.name || c.email;
    email.textContent = c.email;
    li.append(name, email);
    li.addEventListener("click", () => addRecipient(c));
    ul.appendChild(li);
  }
  $("contactStatus").textContent = list.length ? msg("contactsCount", [String(list.length)]) : msg("noContacts");
}

async function loadContacts() {
  try {
    const res = await browser.runtime.sendMessage({ type: "get-contacts" });
    if (res && res.error) { $("contactStatus").textContent = msg("addressBookError", [res.error]); return; }
    allContacts = Array.isArray(res) ? res : [];
    renderContacts(allContacts);
  } catch (e) {
    $("contactStatus").textContent = msg("addressBookError", [String(e && e.message ? e.message : e)]);
  }
}

$("contactSearch").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  renderContacts(allContacts.filter(c => ((c.name || "") + " " + (c.email || "")).toLowerCase().includes(q)));
});

document.querySelectorAll("[data-cmd]").forEach(btn => {
  btn.addEventListener("click", () => exec(btn.dataset.cmd));
});

$("formatBlock").addEventListener("change", e => exec("formatBlock", e.target.value));
$("fontSize").addEventListener("change", e => exec("fontSize", e.target.value));
$("foreColor").addEventListener("change", e => exec("foreColor", e.target.value));
$("hiliteColor").addEventListener("change", e => exec("hiliteColor", e.target.value));
$("unlinkBtn").addEventListener("click", () => exec("unlink"));
$("clearFormatBtn").addEventListener("click", () => exec("removeFormat"));

$("linkBtn").addEventListener("click", () => {
  const url = prompt(msg("linkPrompt"), "https://");
  if (url && url !== "https://") exec("createLink", url);
});

$("imageUrlBtn").addEventListener("click", () => {
  const url = prompt(msg("imagePrompt"), "https://");
  if (url && url !== "https://") exec("insertImage", url);
});

$("imageFileBtn").addEventListener("click", () => $("inlineImageFile").click());
$("inlineImageFile").addEventListener("change", async () => {
  const file = $("inlineImageFile").files[0];
  if (!file) return;
  const dataUrl = await readFileAsDataURL(file);
  exec("insertImage", dataUrl);
  scheduleDraftSave();
  $("inlineImageFile").value = "";
});

const emojis = "😀 😃 😄 😁 😆 😊 🙂 😉 😍 😘 😎 🤔 😅 😂 🤣 😇 🙏 👍 👎 👏 👌 💪 ✅ ❌ ⚠️ 📎 📌 📅 📞 ✉️ ❤️ 💙 ⭐ 🔥 🎉".split(" ");
const emojiPanel = $("emojiPanel");
for (const emoji of emojis) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = emoji;
  b.addEventListener("click", () => { exec("insertText", emoji); });
  emojiPanel.appendChild(b);
}
$("emojiToggle").addEventListener("click", () => { emojiPanel.hidden = !emojiPanel.hidden; });

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(msg("fileReadError")));
    reader.readAsDataURL(file);
  });
}

function renderAttachments() {
  const box = $("attachmentList");
  box.textContent = "";
  selectedAttachments.forEach((f, i) => {
    const row = document.createElement("div");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = msg("removeAttachment");
    remove.addEventListener("click", () => { selectedAttachments.splice(i, 1); renderAttachments(); });
    row.textContent = msg("attachmentSize", [f.name, String(Math.ceil(f.size / 1024))]) + " ";
    row.appendChild(remove);
    box.appendChild(row);
  });
}

$("attachments").addEventListener("change", () => {
  selectedAttachments = [...selectedAttachments, ...Array.from($("attachments").files || [])];
  $("attachments").value = "";
  renderAttachments();
  scheduleDraftSave();
});

function collectMessage() {
  return {
    composeMode,
    sourceMessageId,
    to: $("to").value,
    cc: $("cc").value,
    bcc: $("bcc").value,
    subject: $("subject").value,
    htmlBody: editor.innerHTML,
    // beginNew() does not accept File objects directly in attachments.
    attachments: selectedAttachments.map(file => ({ file, name: file.name || msg("attachmentFallbackName") }))
  };
}

function collectDraftMessage() {
  return { draftKey, ...collectMessage() };
}

function draftFingerprint() {
  return JSON.stringify({
    to: $("to").value,
    cc: $("cc").value,
    bcc: $("bcc").value,
    subject: $("subject").value,
    htmlBody: editor.innerHTML,
    attachments: selectedAttachments.map(f => [f.name, f.size, f.lastModified || 0])
  });
}

function scheduleDraftSave() {
  if (messageWasSent) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, DRAFT_SAVE_DELAY_MS);
}

async function saveDraftNow() {
  if (messageWasSent) return;
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  const fp = draftFingerprint();
  if (fp === lastDraftFingerprint) return;
  try {
    await browser.runtime.sendMessage({ type: "save-imported-draft", ...collectDraftMessage() });
    lastDraftFingerprint = fp;
    setStatus("Brouillon sauvegardé.");
  } catch (e) {
    setStatus(msg("genericError", ["Sauvegarde brouillon : " + String(e && e.message ? e.message : e)]));
  }
}

async function deleteDraftNow() {
  messageWasSent = true;
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  try {
    await browser.runtime.sendMessage({ type: "delete-imported-draft", draftKey, composeMode, sourceMessageId });
  } catch (e) {}
}

function setupDraftAutosave() {
  ["to", "cc", "bcc", "subject"].forEach(id => $(id).addEventListener("input", scheduleDraftSave));
  editor.addEventListener("input", scheduleDraftSave);
  window.addEventListener("beforeunload", () => {
    // Best effort: the periodic save is the reliable part. This only tries to catch normal tab closing.
    saveDraftNow();
  });
}

function resetForm() {
  composeMode = "new";
  sourceMessageId = null;
  $("to").value = "";
  $("cc").value = "";
  $("bcc").value = "";
  $("subject").value = "";
  applyDefaultSignature();
  selectedAttachments = [];
  $("attachments").value = "";
  $("attachmentList").textContent = "";
  $("formatBlock").value = "div";
  $("fontSize").value = "3";
  activeRecipientField = "to";
  $("to").focus();
}

$("openNative").addEventListener("click", async () => {
  setStatus(msg("openingComposer"));
  try {
    await browser.runtime.sendMessage({ type: "open-native-compose", ...collectMessage() });
    setStatus("");
  } catch (e) {
    setStatus(msg("genericError", [String(e && e.message ? e.message : e)]));
  }
});

$("sendDirect").addEventListener("click", async () => {
  const btn = $("sendDirect");
  if (btn.disabled) return;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = msg("sendingButton");
  try {
    setStatus(msg("sendingStatus"));
    await browser.runtime.sendMessage({ type: "send-direct", ...collectMessage() });
    await deleteDraftNow();
    setStatus(msg("sentStatus"));
    resetForm();
  } catch (e) {
    setStatus(msg("sendError", [String(e && e.message ? e.message : e)]));
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});

$("reset").addEventListener("click", async () => { await deleteDraftNow(); resetForm(); messageWasSent = false; draftKey = `compose-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`; lastDraftFingerprint = ""; });
async function applyStartupContext() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") || "new";
  const messageId = params.get("messageId");
  await loadDefaultSignature(messageId);
  applyDefaultSignature();
  if (!messageId || mode === "new") return;
  try {
    const ctx = await browser.runtime.sendMessage({ type: "get-message-compose-context", mode, messageId });
    composeMode = ctx.mode || mode;
    sourceMessageId = ctx.sourceMessageId || messageId;
    if (ctx.draftKey) draftKey = ctx.draftKey;
    $("to").value = ctx.to || "";
    $("cc").value = ctx.cc || "";
    $("bcc").value = ctx.bcc || "";
    $("subject").value = ctx.subject || "";
    if (composeMode === "draft") {
      setHtmlContent(editor, ctx.bodyHtml || "");
      if (!htmlToPlainText(editor.innerHTML).trim()) applyDefaultSignature();
      lastDraftFingerprint = draftFingerprint();
    }
    if (composeMode === "reply" || composeMode === "replyAll") applyReplyOrReplyAllBody(ctx);
    if (composeMode === "forward") {
      applyForwardBody(ctx);
      await addOriginalAttachments(sourceMessageId);
    }
    const title = composeMode === "draft" ? msg("editDraftTitle") : (composeMode === "forward" ? msg("forwardTitle") : (composeMode === "replyAll" ? msg("replyAllTitle") : msg("replyTitle")));
    const h1 = document.querySelector("header h1");
    if (h1) h1.textContent = title;
    document.title = title;
    focusEditor();
  } catch (e) {
    setStatus(msg("genericError", [String(e && e.message ? e.message : e)]));
  }
}

setupDraftAutosave();
loadContacts();
applyStartupContext();
