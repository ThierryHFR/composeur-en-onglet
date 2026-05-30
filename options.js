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
  document.documentElement.lang = browser.i18n.getUILanguage().split("-")[0] || "fr";
}

async function loadOptions() {
  const stored = await browser.storage.local.get({ singleComposeTab: false });
  document.getElementById("singleComposeTab").checked = stored.singleComposeTab === true;
}

async function saveOptions() {
  await browser.storage.local.set({ singleComposeTab: document.getElementById("singleComposeTab").checked });
  const status = document.getElementById("status");
  status.textContent = msg("optionsSaved");
  setTimeout(() => { status.textContent = ""; }, 1400);
}

applyI18n();
loadOptions();
document.getElementById("singleComposeTab").addEventListener("change", saveOptions);
