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
const $ = id => document.getElementById(id);
const editor = $("editor");

for (const el of document.querySelectorAll(".recipient")) {
  el.addEventListener("focus", () => { activeRecipientField = el.id; });
}

function setStatus(text) { $("status").textContent = text || ""; }
function focusEditor() { editor.focus(); }

function exec(cmd, value = null) {
  focusEditor();
  document.execCommand(cmd, false, value);
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
});

function collectMessage() {
  return {
    to: $("to").value,
    cc: $("cc").value,
    bcc: $("bcc").value,
    subject: $("subject").value,
    htmlBody: editor.innerHTML,
    // beginNew() does not accept File objects directly in attachments.
    attachments: selectedAttachments.map(file => ({ file, name: file.name || msg("attachmentFallbackName") }))
  };
}

function resetForm() {
  $("to").value = "";
  $("cc").value = "";
  $("bcc").value = "";
  $("subject").value = "";
  editor.innerHTML = "";
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
    setStatus(msg("sentStatus"));
    resetForm();
  } catch (e) {
    setStatus(msg("sendError", [String(e && e.message ? e.message : e)]));
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});

$("reset").addEventListener("click", resetForm);
loadContacts();
