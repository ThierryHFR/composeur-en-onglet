
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
  return await browser.compose.beginNew(details);
}
async function sendDirect(message) {
  const details = await buildComposeDetails(message);

  // The Thunderbird preference mail.SpellCheckBeforeSend=false must be managed
  // through the Thunderbird configuration editor. The extension no longer modifies it.

  let composeTab = await browser.compose.beginNew(details);

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

browser.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return undefined;
  if (message.type === "get-contacts") return getContacts();
  if (message.type === "open-native-compose") return openNativeCompose(message);
  if (message.type === "send-direct") return sendDirect(message);
  return undefined;
});
