const grantButton = document.getElementById("grant");
const status = document.getElementById("status");
const msg = (name, substitutions) => browser.i18n.getMessage(name, substitutions) || name;

document.querySelectorAll("[data-i18n]").forEach(element => {
  element.textContent = msg(element.dataset.i18n);
});
document.documentElement.lang = browser.i18n.getUILanguage().split("-")[0] || "fr";

grantButton.addEventListener("click", async () => {
  grantButton.disabled = true;
  try {
    const requested = { permissions: ["messages.send"] };
    const apis = [];
    if (browser.permissions && browser.permissions.request) apis.push(browser.permissions);
    if (typeof messenger !== "undefined" && messenger.permissions && messenger.permissions.request && !apis.includes(messenger.permissions)) {
      apis.push(messenger.permissions);
    }
    if (!apis.length) throw new Error("Permission API unavailable");

    let lastError = null;
    for (const permissionsApi of apis) {
      try {
        if (await permissionsApi.request(requested)) {
          status.textContent = msg("onboardingGranted");
          return;
        }
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    status.textContent = msg("onboardingDenied");
  } catch (e) {
    status.textContent = msg("onboardingPermissionError", [String(e && e.message ? e.message : e)]);
  } finally {
    grantButton.disabled = false;
  }
});
