const statusBox = document.getElementById("status");
async function openMode(mode) {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs && tabs[0] ? tabs[0].id : undefined;
    let msg = null;
    if (browser.messageDisplay.getDisplayedMessage) {
      msg = await browser.messageDisplay.getDisplayedMessage(tabId);
    } else {
      const list = await browser.messageDisplay.getDisplayedMessages(tabId);
      msg = list && list.messages ? list.messages[0] : (Array.isArray(list) ? list[0] : null);
    }
    if (!msg || !msg.id) {
      statusBox.textContent = "Aucun message sélectionné.";
      return;
    }
    await browser.runtime.sendMessage({ type: "open-message-compose-tab", mode, messageId: msg.id });
    window.close();
  } catch (e) {
    statusBox.textContent = String(e && e.message ? e.message : e);
  }
}
document.getElementById("reply").addEventListener("click", () => openMode("reply"));
document.getElementById("replyAll").addEventListener("click", () => openMode("replyAll"));
document.getElementById("forward").addEventListener("click", () => openMode("forward"));
