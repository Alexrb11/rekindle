import { tr } from "./i18n.js";
export const USAGE_KEY = "rekindle.codex-usage";
export const QUOTA_KEY = "rekindle.codex-quota";

const SESSION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function codexTerminalRequests(terminals, agents) {
  const reported = new Set(agents.filter(agent => agent.app === "codex" || agent.program?.key === "codex")
    .map(agent => agent.address));
  return terminals.filter(terminal => terminal.state === "live" && !terminal.address.includes("/")
    && (reported.has(terminal.address) || terminal.program?.key === "codex"
      || terminal.report?.app === "codex" || terminal.status?.app === "codex"))
    .map(terminal => {
      const args = Array.isArray(terminal.argv) ? terminal.argv : [];
      const resume = args.indexOf("resume");
      const session = resume < 0 ? null : args.slice(resume + 1).find(arg => SESSION_ID.test(arg)) ?? null;
      return { address: terminal.address, process: terminal.pid ?? null, foreground: terminal.foreground?.pid ?? null, session };
    });
}

function windowsPath(path) {
  if (typeof path !== "string") return "";
  return path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "").toLowerCase();
}

function tokenValue(value) {
  return Number.isFinite(value) && value >= 0;
}

export function formatTokens(value, compact = false) {
  if (compact && value >= 1000) {
    const millions = value >= 1000000;
    const amount = value / (millions ? 1000000 : 1000);
    return amount.toFixed(amount >= 100 ? 0 : 1).replace(/\.0$/, "").replace(".", ",") + (millions ? " M" : " k");
  }
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function sessionUsage(session) {
  const lines = [formatTokens(session.total) + tr(" tokens en este chat")];
  const hasTurn = tokenValue(session.lastTurn);
  if (hasTurn) lines.push(tr("Último turno · +") + formatTokens(session.lastTurn) + " tokens");
  for (const [field, title] of [["input", tr("Entrada")], ["cached", tr("En caché")], ["output", tr("Salida")]]) {
    if (tokenValue(session[field])) lines.push(title + " · " + formatTokens(session[field]));
  }
  const total = formatTokens(session.total, true);
  const label = hasTurn ? total + " · +" + formatTokens(session.lastTurn, true) + " tokens" : total + " tokens";
  return { label, detail: lines.join("\n") };
}

export function usageSnapshot(report, spaces, requests) {
  const chats = {};
  const projects = {};
  const byId = new Map();
  const localSpaces = spaces.filter(space => !space.machine && windowsPath(space.folder));
  const roots = [...new Set(localSpaces.map(space => windowsPath(space.folder)))].sort((a, b) => b.length - a.length);
  const totals = new Map(roots.map(root => [root, { tokens: 0, chats: 0 }]));
  for (const session of report.sessions ?? []) {
    if (!session.id || byId.has(session.id) || !tokenValue(session.total)) continue;
    byId.set(session.id, session);
    const path = windowsPath(session.cwd);
    const root = roots.find(root => path === root || path.startsWith(root + "/"));
    if (!root) continue;
    const project = totals.get(root);
    project.tokens += session.total;
    project.chats++;
  }
  for (const space of localSpaces) {
    const total = totals.get(windowsPath(space.folder));
    projects[space.id] = {
      label: formatTokens(total.tokens, true) + " tokens",
      detail: formatTokens(total.tokens) + tr(" tokens en ")
        + total.chats + (total.chats === 1 ? tr(" sesión de Codex registrada") : tr(" sesiones de Codex registradas"))
    };
  }
  for (const terminal of requests) {
    const session = byId.get(report.links?.[terminal.address]);
    if (session) chats[terminal.address] = { ...sessionUsage(session), process: terminal.process };
  }
  return { projects, chats };
}

function windowName(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return tr("Disponible");
  if (minutes === 10080) return tr("Semanal");
  if (minutes % 1440 === 0) return minutes / 1440 + " d";
  if (minutes % 60 === 0) return minutes / 60 + " h";
  return minutes + " min";
}

export function remainingQuota(snapshot, now = Date.now()) {
  if (!Number.isFinite(snapshot?.captured)) return [];
  return (snapshot.windows ?? []).filter(bucket => Number.isFinite(bucket.used)
    && (!Number.isFinite(bucket.resets) || bucket.resets <= 0 || bucket.resets * 1000 > now))
    .map(bucket => {
      const percent = Math.round(Math.max(0, Math.min(100, 100 - bucket.used)));
      return { name: windowName(bucket.minutes), percent, resets: bucket.resets };
    });
}
