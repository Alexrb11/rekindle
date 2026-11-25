import { setShared, shared } from "herdr";
import { tr } from "./i18n.js";

export const PREFERENCES_KEY = "rekindle.preferences";
export const PANELS_KEY = "workspace.panels";
export const PANELS = ["files", "changes"];
export const QUOTA_ALERT_KEY = "rekindle.quota-alerts";
export const DEFAULT_QUOTA_THRESHOLD = 20;
export const MAX_RUNNING_WARNING = 99;

export const CODEX_PERMISSION_MODES = [
  { value: "inherit", label: "Según Codex", detail: "Usa los permisos configurados en Codex." },
  { value: "read-only", label: "Solo lectura", approval: "on-request",
    detail: "Puede leer archivos y pedir aprobación para ampliar el acceso." },
  { value: "workspace-write", label: "Proyecto", approval: "on-request",
    detail: "Puede editar el proyecto y pedir aprobación para ampliar el acceso." },
  { value: "danger-full-access", label: "Acceso completo", approval: "never",
    detail: "Accede al equipo y ejecuta comandos sin pedir aprobación." }
];

export const DEFAULT_PREFERENCES = {
  density: "comfortable",
  showSprites: true,
  animateSprites: true,
  showAgentStatus: true,
  agentsPerPage: 4,
  agentOrder: "recent",
  runningAgentWarning: 0,
  codexPermissions: "inherit",
  showDeliveries: true,
  showTokens: true,
  showWeeklyQuota: true,
  quotaRefreshMs: 30_000
};

const CHOICES = {
  density: ["comfortable", "compact"],
  agentsPerPage: [4, 8, 12, "all"],
  agentOrder: ["recent", "created", "name"],
  codexPermissions: CODEX_PERMISSION_MODES.map(mode => mode.value),
  quotaRefreshMs: [30_000, 60_000, 120_000, 0]
};

function validPreference(key, value) {
  if (Object.hasOwn(CHOICES, key)) return CHOICES[key].includes(value);
  if (key === "runningAgentWarning") return Number.isInteger(value) && value >= 0 && value <= MAX_RUNNING_WARNING;
  return typeof value === "boolean";
}

export function currentPreferences() {
  const preferences = shared(PREFERENCES_KEY) ?? {};
  return Object.fromEntries(Object.entries(DEFAULT_PREFERENCES).map(([key, fallback]) =>
    [key, validPreference(key, preferences[key]) ? preferences[key] : fallback]));
}

export function readPreferenceOptions(value) {
  if (value === undefined) return null;
  const invalid = () => new Error(tr("La copia contiene preferencias inválidas."));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const options = {};
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    if (!Object.hasOwn(value, key)) continue;
    if (!validPreference(key, value[key])) throw invalid();
    options[key] = value[key];
  }
  return options;
}

export function setPreferenceOptions(options) {
  const current = currentPreferences();
  if (Object.entries(options).some(([key, value]) => current[key] !== value)) {
    setShared(PREFERENCES_KEY, { ...current, ...options });
  }
}

export function enabledPanels() {
  return shared(PANELS_KEY) ?? PANELS;
}

export function setPreferredPanels(panels) {
  const otherPanels = enabledPanels().filter(panel => !PANELS.includes(panel));
  setShared(PANELS_KEY, [...otherPanels, ...panels]);
}

export function quotaAlertThreshold() {
  return shared(QUOTA_ALERT_KEY)?.threshold ?? DEFAULT_QUOTA_THRESHOLD;
}

export function setQuotaAlertThreshold(threshold) {
  const state = shared(QUOTA_ALERT_KEY) ?? {};
  if ((state.threshold ?? DEFAULT_QUOTA_THRESHOLD) === threshold) return;
  setShared(QUOTA_ALERT_KEY, { ...state, threshold, alerted: threshold ? state.alerted ?? [] : [] });
}

export function resetPreferences() {
  setPreferenceOptions(DEFAULT_PREFERENCES);
  setPreferredPanels(PANELS);
  setQuotaAlertThreshold(DEFAULT_QUOTA_THRESHOLD);
}
