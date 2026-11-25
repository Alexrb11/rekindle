import { focused, run, setShared, shared, terminals } from "herdr";
import { tr } from "./i18n.js";

const TYPE_LABEL = "rekindle.type";
const AGENT_LAST_USED = "rekindle.agent-last-used";
export const AGENT_NAME_LABEL = "rekindle.name";

function terminalType(terminal) {
  return terminal?.labels?.[TYPE_LABEL] ?? terminal?.labels?.["taller.type"];
}

export function agentUseHistory() {
  return shared(AGENT_LAST_USED)?.byTerminal ?? {};
}

export function rememberAgentUse(key) {
  const history = shared(AGENT_LAST_USED) ?? {};
  const usedAt = Math.max(Date.now(), (history.usedAt ?? 0) + 1);
  setShared(AGENT_LAST_USED, { usedAt, byTerminal: { ...history.byTerminal, [key]: usedAt } });
}

export function openAgent(agent) {
  const current = focused();
  // A regular focus change is recorded by the sidebar. Peeks and repeated
  // opens of the current agent also count, even when focus does not change.
  if (agent.detached || agent.address === (current?.terminal ?? current?.agent)) rememberAgentUse(agent.foldKey);
  run(agent.detached ? "terminal.peek" : "agent.focus", { terminal: agent.address });
}

export function liveAgentTerminal(target) {
  if (!target) return null;
  return terminals().find(terminal => terminal.address === target.address
    && terminal.created_ms === target.created_ms && terminal.state === "live");
}

export function projectNames(projects) {
  const names = new Map(projects.map(space => [space.id, space.name]));
  const homeSpaces = projects.filter(space => space.name === "~").sort((a, b) => a.id.localeCompare(b.id));
  homeSpaces.forEach((space, index) => {
    names.set(space.id, homeSpaces.length === 1 ? tr("Inicio") : tr("Inicio ") + (index + 1));
  });
  return names;
}

function conversationTitles(agent, terminal) {
  const title = (agent.title || terminal?.title || "").trim();
  const folder = terminal?.cwd?.split(/[\\/]+/).filter(Boolean).at(-1);
  const { program } = agent;
  const app = agent.app ?? terminal?.report?.app;
  const suffix = " | " + folder;
  const display = (app === "codex" || program?.key === "codex") && folder && title.endsWith(suffix)
    ? title.slice(0, -suffix.length).trim()
    : title;
  const normalized = display.toLowerCase();
  const defaults = [agent.address, program?.name, program?.key, app];
  const isDefault = !display || title === folder || /^(?:[~/\\]|[a-z]:[\\/])/i.test(title)
    || defaults.some(value => value?.toLowerCase() === normalized);
  const originalTitle = isDefault ? tr("Conversación sin título") : display;
  return { originalTitle, conversationTitle: terminal?.labels?.[AGENT_NAME_LABEL]?.trim() || originalTitle };
}

function childrenByParent(records) {
  const children = new Map();
  for (const record of records) {
    if (!record.parent) continue;
    if (!children.has(record.parent)) children.set(record.parent, []);
    children.get(record.parent).push(record);
  }
  return children;
}

function terminalKey(terminal) {
  return terminal?.created_ms == null ? terminal?.address : terminal.address + ":" + terminal.created_ms;
}

export function projectTeam(listed, liveTerminals, focusedAddress) {
  const byAddress = new Map(liveTerminals.map(terminal => [terminal.address, terminal]));
  const children = childrenByParent(liveTerminals.filter(terminal => terminal.state === "live"));
  const team = listed.map(agent => {
    const terminal = byAddress.get(agent.address);
    return {
      ...agent,
      terminal,
      parent: terminal?.parent,
      createdAt: terminal?.created_ms ?? 0,
      ...conversationTitles(agent, terminal),
      type: terminalType(terminal),
      foldKey: terminalKey(terminal) ?? agent.address
    };
  });
  const byAgent = new Map(team.map(agent => [agent.address, agent]));
  for (const parent of team) {
    for (const terminal of children.get(parent.address) ?? []) {
      const type = terminalType(terminal);
      if (byAgent.has(terminal.address) || (!type && !terminal.program?.agent && !terminal.status)) continue;
      const error = terminal.first_message?.sent === false || terminal.status === "error";
      const child = {
        address: terminal.address,
        terminal,
        space: parent.space,
        parent: parent.address,
        createdAt: terminal.created_ms ?? 0,
        type,
        program: terminal.program,
        ...conversationTitles(terminal, terminal),
        status: error ? "blocked" : terminal.status ?? "idle",
        detail: error ? terminal.first_message?.reason ?? terminal.reason : null,
        seq: terminal.status_ms ?? terminal.created_ms ?? 0,
        pinned: Boolean(terminal.labels?.["herdr.pinned"]),
        foldKey: terminalKey(terminal),
        focused: terminal.address === focusedAddress,
        detached: true
      };
      byAgent.set(child.address, child);
      team.push(child);
    }
  }
  for (const agent of team) {
    const parent = byAgent.get(agent.parent);
    if (parent) agent.parentName = parent.conversationTitle;
  }
  return team;
}

function taskStatus(agent) {
  // Herdr shows a seen completion as idle. The core keeps the agent's report.
  return agent.status === "idle" && agent.terminal?.status === "done" ? "done" : agent.status;
}

export function agentCounts(agents) {
  const counts = { total: agents.length, working: 0, blocked: 0, done: 0 };
  for (const agent of agents) {
    const status = taskStatus(agent);
    if (status === "working" || status === "blocked" || status === "done") counts[status]++;
  }
  return counts;
}

function recentActivity(projectAgents, history) {
  const byAddress = new Map(projectAgents.map(agent => [agent.address, agent]));
  const activity = new Map();
  for (const agent of projectAgents) {
    const usedAt = Math.max(agent.createdAt, history[agent.foldKey] ?? 0);
    // A team's position reflects its newest member's activity.
    for (let member = agent; member && usedAt > (activity.get(member.address) ?? -1); member = byAddress.get(member.parent)) {
      activity.set(member.address, usedAt);
    }
  }
  return activity;
}

export function orderProjectTeam(agents, filter, foldedTeams, history, order = "recent") {
  // Filter before building the hierarchy so matching children stay visible.
  const visible = filter === "all" ? [...agents] : agents.filter(agent => taskStatus(agent) === filter);
  if (visible.length > 1) {
    const activity = order === "created" || order === "name" ? null : recentActivity(agents, history);
    const compare = order === "name"
      ? (a, b) => a.conversationTitle.toLowerCase().localeCompare(b.conversationTitle.toLowerCase())
      : (a, b) => (activity?.get(b.address) ?? 0) - (activity?.get(a.address) ?? 0);
    visible.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || compare(a, b) || b.createdAt - a.createdAt || b.seq - a.seq);
  }
  const children = childrenByParent(visible);
  const present = new Set(visible.map(agent => agent.address));
  const seen = new Set();
  const ordered = [];
  function visit(agent, depth, hidden = false) {
    if (seen.has(agent.address)) return;
    seen.add(agent.address);
    const folded = foldedTeams.has(agent.foldKey);
    const descendants = { total: 0, working: 0, blocked: 0 };
    const status = filter === "done" ? "done" : agent.status;
    if (!hidden) ordered.push({ agent, status, depth, folded, descendants });
    for (const child of children.get(agent.address) ?? []) {
      const group = visit(child, depth + 1, hidden || folded);
      if (!group) continue;
      descendants.total += 1 + group.total;
      descendants.working += Number(child.status === "working") + group.working;
      descendants.blocked += Number(child.status === "blocked") + group.blocked;
    }
    return descendants;
  }
  for (const agent of visible) {
    if (!present.has(agent.parent)) visit(agent, 0);
  }
  for (const agent of visible) visit(agent, 0);
  return ordered;
}

export function nextPendingAgent(team, focused, waitingTimes) {
  const pending = team.filter(agent => agent.status === "blocked");
  pending.sort((a, b) => (waitingTimes.get(a.address) ?? Infinity) - (waitingTimes.get(b.address) ?? Infinity)
    || a.seq - b.seq || a.address.localeCompare(b.address));
  if (!pending.length) return null;
  const current = pending.findIndex(agent => agent.address === focused);
  return pending[(current + 1) % pending.length];
}
