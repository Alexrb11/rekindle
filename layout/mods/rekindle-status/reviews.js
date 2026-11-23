export const REVIEWS_KEY = "rekindle.reviews";

export function reviewRequest(state, since) {
  const tracked = Object.keys(state?.watching ?? {});
  const seen = Object.fromEntries(tracked.map(id => [id, state?.seen?.[id] ?? 0]));
  return { since: state?.since ?? since, tracked, seen };
}

export function reviewState(state, report, since, projects, agents, terminals) {
  const old = state ?? {};
  const watching = {};
  const seen = { ...old.seen };
  const items = [...(old.items ?? [])];
  const ids = new Set(items.map(item => item.id));
  const listed = new Map(agents.map(agent => [agent.address, agent]));
  const byAddress = new Map(terminals.map(terminal => [terminal.address, terminal]));
  const projectNames = new Map(projects.map(project => [project.id, project.name]));

  for (const [address, session] of Object.entries(report.links ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const terminal = byAddress.get(address);
    const visited = new Set();
    let owner;
    for (let cursor = address; cursor && !visited.has(cursor); cursor = byAddress.get(cursor)?.parent) {
      visited.add(cursor);
      owner = listed.get(cursor);
      if (owner?.space) break;
    }
    const tabName = listed.get(address)?.tab_name;
    watching[session] = {
      agent: terminal?.labels?.["rekindle.type"] || terminal?.labels?.["taller.type"] || (tabName && !/^\d+$/.test(tabName) ? tabName : "Codex"),
      project: projectNames.get(owner?.space) || ""
    };
  }

  for (const delivery of report.deliveries ?? []) {
    if (!delivery.session || !delivery.turn || !Number.isFinite(delivery.time)) continue;
    const id = delivery.session + ":" + delivery.turn;
    seen[delivery.session] = Math.max(delivery.time, seen[delivery.session] ?? 0);
    if (ids.has(id)) continue;
    ids.add(id);
    const owner = watching[delivery.session] ?? old.watching?.[delivery.session];
    items.push({ ...delivery, id, agent: owner?.agent || "Codex", project: owner?.project || "", reviewed: false });
  }
  items.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  return { since: old.since ?? since, watching, seen, items };
}
