// Console preferences. Applied defaults are bounded by contracts.js; nothing
// here may contradict engine production policy (batch ceiling etc.).
const DEFAULTS = Object.freeze({
  theme: "system",
  reducedMotion: false,
  density: "comfortable",
  batchSize: 1000,
  approvalMinutes: 60,
  retentionDays: 365,
  diagnosticsRetentionDays: 30,
  supportConsent: false
});

export function createSettingsService({ store }) {
  function get() {
    const stored = store.allSettings();
    return { ...DEFAULTS, ...stored.settings, onboardingComplete: Boolean(stored.onboardingComplete) };
  }

  function update(patch) {
    const stored = store.getSetting("settings", {});
    const next = { ...DEFAULTS, ...stored, ...patch };
    store.setSetting("settings", next);
    return next;
  }

  function completeOnboarding({ workspaceRoot = null } = {}) {
    store.setSetting("onboardingComplete", true);
    if (workspaceRoot) store.setSetting("onboardingWorkspaceRoot", workspaceRoot);
    return { onboardingComplete: true };
  }

  return Object.freeze({ get, update, completeOnboarding });
}
