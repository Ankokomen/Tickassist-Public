/* Browser storage that never throws: private mode, a full quota or blocked
   site data just mean nothing is remembered. The program's keys live here. */

export const KEYS = {
  theme: "tickassist_theme",            // also read by the inline script in index.html
  callType: "tickassist_call_type_v1",
  draft: "tickassist_generator_v1",
  envCollapsed: "tickassist_env_collapsed_v1",
  d365Choices: "tickassist_d365_choices_v1",
  alerts: "tickassist_alerts_v1",
  settingsTab: "tickassist_settings_tab",
  fiOpenAll: "tickassist_fi_open_all",  // a copy of the fi_open_all setting, for the first paint
  // sessionStorage
  featuresSaved: "tickassist_feat_saved",
  autoUpdateSeen: "tickassist_auto_seen",
};

function area(session) {
  try { return session ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
}

export const store = {
  get(key, session = false) {
    try { const s = area(session); return s ? s.getItem(key) : null; } catch (e) { return null; }
  },
  set(key, value, session = false) {
    try { const s = area(session); if (s) s.setItem(key, value); } catch (e) { /* not remembered */ }
  },
  remove(key, session = false) {
    try { const s = area(session); if (s) s.removeItem(key); } catch (e) { /* nothing to do */ }
  },
  getJSON(key, fallback) {
    try { const v = JSON.parse(this.get(key) || "null"); return v === null ? fallback : v; } catch (e) { return fallback; }
  },
  setJSON(key, value) { this.set(key, JSON.stringify(value)); },
};
