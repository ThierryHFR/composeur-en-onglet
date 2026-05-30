function msg(name, substitutions) {
  const value = browser.i18n.getMessage(name, substitutions);
  return value || name;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = msg(el.dataset.i18n);
  });
  document.documentElement.lang = browser.i18n.getUILanguage().split("-")[0] || "fr";
}

applyI18n();

const statusBox = document.getElementById("status");
const editDraftButton = document.getElementById("editDraft");
const replyButton = document.getElementById("reply");
const replyAllButton = document.getElementById("replyAll");
const forwardButton = document.getElementById("forward");
let currentMessage = null;

function isDraftMessage(message) {
  const folder = message && message.folder ? message.folder : null;
  const specialUseRaw = folder ? folder.specialUse : [];
  const specialUse = Array.isArray(specialUseRaw) ? specialUseRaw : (specialUseRaw ? [specialUseRaw] : []);
  const path = String(folder && (folder.path || folder.name) || "");
  return specialUse.map(v => String(v).toLowerCase()).includes("drafts") || /(^|\/)(Drafts|Brouillons)$/i.test(path) || /^(Drafts|Brouillons)$/i.test(path);
}

async function getDisplayedMessage() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs && tabs[0] ? tabs[0].id : undefined;
  if (browser.messageDisplay.getDisplayedMessage) {
    return await browser.messageDisplay.getDisplayedMessage(tabId);
  }
  const list = await browser.messageDisplay.getDisplayedMessages(tabId);
  return list && list.messages ? list.messages[0] : (Array.isArray(list) ? list[0] : null);
}


function setButtonVisible(button, visible) {
  if (!button) return;
  button.hidden = !visible;
  button.style.display = visible ? "block" : "none";
}

async function refreshUi() {
  try {
    currentMessage = await getDisplayedMessage();
    const draft = isDraftMessage(currentMessage);
    setButtonVisible(editDraftButton, draft);
    setButtonVisible(replyButton, !draft);
    setButtonVisible(replyAllButton, !draft);
    setButtonVisible(forwardButton, !draft);
    const title = document.querySelector(".title");
    if (title) title.textContent = draft ? msg("editDraftShortTitle") : msg("messageActionTitle");
  } catch (e) {
    statusBox.textContent = String(e && e.message ? e.message : e);
  }
}

async function openMode(mode) {
  try {
    if (!currentMessage) currentMessage = await getDisplayedMessage();
    if (!currentMessage || !currentMessage.id) {
      statusBox.textContent = msg("noMessageSelected");
      return;
    }
    await browser.runtime.sendMessage({ type: "open-message-compose-tab", mode, messageId: currentMessage.id });
    window.close();
  } catch (e) {
    statusBox.textContent = String(e && e.message ? e.message : e);
  }
}

editDraftButton.addEventListener("click", () => openMode("draft"));
replyButton.addEventListener("click", () => openMode("reply"));
replyAllButton.addEventListener("click", () => openMode("replyAll"));
forwardButton.addEventListener("click", () => openMode("forward"));

refreshUi();
