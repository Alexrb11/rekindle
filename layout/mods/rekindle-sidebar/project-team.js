import { tr } from "./i18n.js";
const TYPE_LABEL = "rekindle.type";

function terminalType(terminal) {
  return terminal?.labels?.[TYPE_LABEL] ?? terminal?.labels?.["taller.type"];
}

export function agentName(agent) {
  if (agent.type || agent.name) return agent.type || agent.name;
  if (agent.tab_name && !/^\d+$/.test(agent.tab_name)) return agent.tab_name;
  return agent.program?.name ?? tr("Agente");
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

export function projectTeam(listed, terminals, focused) {
  const byAddress = new Map(terminals.map(terminal => [terminal.address, terminal]));
  const children = childrenByParent(terminals.filter(terminal => terminal.state === "live"));
  const team = listed.map(agent => {
    const terminal = byAddress.get(agent.address);
    return {
      ...agent,
      parent: terminal?.parent,
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
        space: parent.space,
        parent: parent.address,
        type,
        name: terminal.name || terminal.template,
        program: terminal.program,
        title: terminal.title,
        status: error ? "blocked" : terminal.status ?? "idle",
        detail: error ? terminal.first_message?.reason ?? terminal.reason : null,
        seq: terminal.status_ms ?? terminal.created_ms ?? 0,
        pinned: Boolean(terminal.labels?.["herdr.pinned"]),
        foldKey: terminalKey(terminal),
        focused: terminal.address === focused,
        detached: true
      };
      byAgent.set(child.address, child);
      team.push(child);
    }
  }
  for (const agent of team) {
    const parent = byAgent.get(agent.parent);
    if (parent) agent.parentName = agentName(parent);
  }
  return team;
}

export function agentCounts(agents) {
  return {
    total: agents.length,
    working: agents.filter(agent => agent.status === "working").length,
    blocked: agents.filter(agent => agent.status === "blocked").length
  };
}

// Sort and filter the input first so a child can still appear when its parent is outside the filter.
export function orderProjectTeam(agents, foldedTeams = new Set()) {
  const children = childrenByParent(agents);
  const present = new Set(agents.map(agent => agent.address));
  const seen = new Set();
  const ordered = [];
  function visit(agent, depth, hidden = false) {
    if (seen.has(agent.address)) return;
    seen.add(agent.address);
    const folded = foldedTeams.has(agent.foldKey);
    const descendants = { total: 0, working: 0, blocked: 0 };
    if (!hidden) ordered.push({ agent, depth, folded, descendants });
    for (const child of children.get(agent.address) ?? []) {
      const group = visit(child, depth + 1, hidden || folded);
      if (!group) continue;
      descendants.total += 1 + group.total;
      descendants.working += Number(child.status === "working") + group.working;
      descendants.blocked += Number(child.status === "blocked") + group.blocked;
    }
    return descendants;
  }
  for (const agent of agents) {
    if (!present.has(agent.parent)) visit(agent, 0);
  }
  for (const agent of agents) visit(agent, 0);
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
