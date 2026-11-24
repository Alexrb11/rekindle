import { language, LANGUAGE_KEY, tr } from "./i18n.js";
import { View, div, image, svg } from "gpui-kit";
import { Button, Popover, h_flex, v_flex } from "gpui-base";
import {
  agents, appHome, checking, closeOverlay, focused, layout, nextCommand, notify, openOverlay,
  pickFolder, props, readTextFile, run, setAgentOrder, setShared, shared, spaces, terminals, theme, watchFolder, window
} from "herdr";
import { AttentionRequests } from "./attention-requests.js";
import { AgentNameEditor } from "./agent-name-editor.js";
import { ErrorDialog } from "./error-dialog.js";
import { coreJson, runChecked, showError } from "./errors.js";
import { ProjectEditor } from "./project-editor.js";
import { DEFAULT_PROJECT_SPRITE, ProjectLogoEditor, projectLogo, projectSprite } from "./project-logos.js";
import {
  agentCounts, agentUseHistory, liveAgentTerminal, nextPendingAgent, openAgent, orderProjectTeam,
  projectNames, projectTeam, rememberAgentUse
} from "./project-team.js";
import { spriteForType, spriteTile } from "./skill-sprites.js";
import { WorkspaceSearch } from "./workspace-search.js";

const SPRITE_SIZE = 28;
const AGENTS_PER_PAGE = 4;
const FOLDS = "rekindle.sidebar-folds";
const CODEX_USAGE = "rekindle.codex-usage";
const REVIEWS = "rekindle.reviews";
const STOP_TASK_FEEDBACK = {
  stopped: { title: "Tarea detenida", level: "success" },
  still_working: { title: "El agente sigue trabajando", level: "warning" },
  exited: { title: "El agente se cerró", level: "warning" }
};
const STATES = {
  blocked: { text: "Te necesita", spriteRow: 2, frameEnds: [520, 710, 1030, 1240] },
  done: { text: "Terminado", spriteRow: 3, frameEnds: [1050, 1220, 1530, 1810] },
  working: { text: "En curso", spriteRow: 1, frameEnds: [160, 310, 470, 620] },
  idle: { text: "En espera", spriteRow: 0, frameEnds: [1500, 1760, 1880, 2230] }
};

function spriteFrame(status, timestamp) {
  const elapsed = timestamp % status.frameEnds.at(-1);
  return status.frameEnds.findIndex(end => elapsed < end);
}

function launcher(space, projectSkills = false, parent = null) {
  try {
    openOverlay({ mod: "rekindle-agents", kind: "dialog", width: 500, height: parent ? 645 : 550,
      props: { space: space?.id ?? null, projectSkills, ...parent } });
  } catch (error) {
    showError(tr("No se pudo abrir el selector"), tr("Vuelve a abrir ") + (parent ? tr("Delegar") : projectSkills ? "Skills" : tr("Nuevo agente")) + ".", error);
  }
}

function openProjectEditor(space) {
  try {
    openOverlay({ mod: "rekindle-sidebar", kind: "dialog", modal: true, width: 440, height: 224, props: { editProject: space.id } });
  } catch (error) {
    showError(tr("No se pudo abrir el editor"), tr("Vuelve a pulsar Editar en las opciones del proyecto."), error);
  }
}

function button(id, t, action, { enabled = true } = {}) {
  return Button.new(id).disabled(!enabled).h(27).px(6).gap(5).flex().items_center().justify_center().rounded(3)
    .flex_none().text_size(12).font_medium()
    .text_color(enabled ? t.muted : t.dim)
    .when(enabled, el => el.cursor_pointer().hover(el => el.bg(t.hover).text_color(t.foreground)))
    .when(enabled && Boolean(action), el => el.on_click(action));
}

function rowButton(id, label, t, action) {
  return button(id, t, (_event, cx) => {
    cx.stop_propagation();
    action(cx);
  }).h(24).px(5).accessibility_label(label).tooltip(label);
}

function icon(name, size = 14) {
  return svg("mods/workspace-chrome/" + name + ".svg").size(size).flex_none();
}

function foldButton(id, name, folded, t, action) {
  return rowButton(id, (folded ? tr("Desplegar ") : tr("Plegar ")) + name, t, action)
    .w(20).px(0).child(icon(folded ? "chevron-right" : "chevron-down", 13));
}

function workSummary({ working, blocked }) {
  return [
    working ? working + tr(" en curso") : "",
    blocked ? blocked + (blocked === 1 ? tr(" pendiente") : tr(" pendientes")) : ""
  ].filter(Boolean).join(" · ");
}

function projectMenu(space, overlay, t) {
  const action = callback => () => {
    closeOverlay(overlay);
    if (space) callback(space);
  };
  return v_flex().size_full().p(5).gap(3).bg(t.popover)
    .child(button("skills-en-" + space?.id, t, action(project => launcher(project, true)), { enabled: Boolean(space) })
      .w_full().justify_start().child(icon("file-text")).child(tr("Skills del proyecto")))
    .child(button("editar-" + space?.id, t, action(openProjectEditor), { enabled: Boolean(space) })
      .w_full().justify_start().child(icon("square-pen")).child(tr("Editar proyecto")));
}

function openAgentNameEditor(terminal, name) {
  if (!liveAgentTerminal(terminal)) return;
  openOverlay({
    mod: "rekindle-sidebar", kind: "dialog", modal: true, width: 400, height: 225,
    props: { renameAgent: { address: terminal.address, created_ms: terminal.created_ms, name } }
  });
}

function confirmAgentRemoval(terminal, name) {
  if (!liveAgentTerminal(terminal)) return;
  openOverlay({
    mod: "confirm", kind: "dialog", modal: true, width: 400, height: 160,
    props: {
      title: tr("¿Eliminar agente?"),
      detail: tr("Se cerrará «") + name + tr("» junto con sus subagentes."),
      command: { name: "terminal.kill", args: { terminal: terminal.address } }
    }
  });
}

function hasActiveTask(status) {
  return status === "working" || status === "blocked";
}

function canStopTask(terminal) {
  return terminal?.state === "live" && hasActiveTask(terminal.status);
}

function agentOptions(agent, t, actions) {
  const { terminal, foldKey: key, conversationTitle: name } = agent;
  const open = actions.agentMenuKey === key;
  const label = tr("Opciones de ") + name;
  const stopping = actions.stoppingTasks.has(key);
  const stopLabel = stopping ? tr("Deteniendo…") : tr("Detener la tarea actual");
  const choose = action => (_event, cx) => {
    cx.stop_propagation();
    actions.setAgentMenu(key, false, cx);
    action(cx);
  };
  return Popover.new("menu-agente-" + key).anchor("top_right").open(open)
    .on_open_change((opened, cx) => actions.setAgentMenu(key, opened, cx))
    .trigger(button("opciones-agente-" + agent.address, t)
      .size(24).px(0).text_size(16).accessibility_label(label).tooltip(label)
      .when(open, el => el.bg(t.hover).text_color(t.foreground)).child("⋯"))
    .content(v_flex().w(184).p(4).gap(2).rounded(6).border(1).border_color(t.border).bg(t.popover)
      .child(button("delegar-" + agent.address, t, choose(cx => actions.delegate(agent, cx)))
        .w_full().justify_start().text_color(t.foreground).child(icon("git-branch", 13)).child(tr("Delegar")))
      .child(button("renombrar-agente-" + agent.address, t, choose(() => openAgentNameEditor(terminal, name)))
        .w_full().justify_start().text_color(t.foreground).child(icon("square-pen", 13)).child(tr("Cambiar nombre")))
      .child(button("detener-tarea-" + agent.address, t, choose(cx => actions.stopTask(agent, cx)),
        { enabled: !stopping && canStopTask(terminal) }).w_full().justify_start()
        .child(icon("square", 13)).child(stopLabel))
      .child(button("eliminar-agente-" + agent.address, t, choose(() => confirmAgentRemoval(terminal, name)))
        .w_full().justify_start().text_color(t.ansi1).child(icon("x", 13)).child(tr("Eliminar"))));
}

function agentRow({ agent, depth, folded, descendants, usage, type, sprite }, t, spriteFrames, actions) {
  const status = STATES[agent.status] ?? STATES.idle;
  const frame = spriteFrames.get(status) ?? 0;
  const statusColor = agent.status === "blocked" || agent.status === "done" ? t[agent.status] : t.muted;
  const name = agent.conversationTitle;
  const spriteLabel = type ?? tr("Sin tipo asignado");
  const parent = agent.parentName && tr("De ") + agent.parentName;
  const statusText = tr(status.text);
  const program = agent.program?.name;
  const subtree = descendants.total ? workSummary(descendants)
    || descendants.total + (descendants.total === 1 ? tr(" subagente") : tr(" subagentes")) : "";
  const subtitle = folded && subtree ? statusText + " · " + subtree : statusText;
  const showUsage = Boolean(usage && usage.label !== "Tokens —");
  const summary = h_flex().id("abrir-agente-" + agent.address).flex_1().min_w(0).h_full().items_center().gap(6)
    .cursor_pointer()
    .accessibility_label([name, parent, statusText].filter(Boolean).join(", "))
    .on_click(() => openAgent(agent))
    .when(descendants.total > 0, el => el.child(foldButton("plegar-equipo-" + agent.address, tr("equipo de ") + name, folded, t,
      cx => actions.toggle("teams", agent.foldKey, cx))))
    .child(spriteTile(sprite, SPRITE_SIZE, frame, status.spriteRow)
      .id("sprite-agente-" + agent.address).tooltip(spriteLabel).accessibility_label(spriteLabel))
    .child(v_flex().id("detalle-agente-" + agent.address).flex_1().min_w(0)
      .tooltip([name, [program, agent.address].filter(Boolean).join(" · "), parent, statusText,
        subtree, agent.detail, usage?.detail].filter(Boolean).join("\n"))
      .child(div().text_size(12.5).font_medium().truncate().child(name))
      .child(div().id("estado-" + agent.address).text_size(10.5).text_color(statusColor).truncate().child(subtitle))
      .when(showUsage, el => el.child(div().id("tokens-chat-" + agent.address).text_size(10.5).text_color(t.dim)
        .truncate().tooltip(usage.detail).child(usage.label))));
  return h_flex().id("agente-" + agent.address).min_w(0).h(showUsage ? 48 : 36).flex_none().items_center().gap(6).px(5)
    .pl(22 + Math.min(depth, 3) * 9)
    .border_l(2).border_color(agent.focused ? t.accent : t.chrome)
    .when(agent.focused, el => el.bg(t.surface)).hover(el => el.bg(t.hover))
    .child(summary)
    .when(agent.terminal?.state === "live", el => el
      .child(rowButton("fijar-" + agent.address, (agent.pinned ? tr("Desfijar ") : tr("Fijar ")) + name, t,
        () => run("terminal.pin", { terminal: agent.address, pinned: !agent.pinned }))
        .w(20).px(0).text_color(agent.pinned ? t.accent : t.muted)
        .child(icon(agent.pinned ? "pin-off" : "pin", 12)))
      .child(agentOptions(agent, t, actions)));
}

function projectLogoTile(space, name, t) {
  const source = projectLogo(space?.id) ?? projectSprite(space?.id)?.path;
  const artwork = !source && space?.name === "~" ? icon("folder", 15).text_color(t.dim)
    : image(source ?? DEFAULT_PROJECT_SPRITE).size(22);
  if (!space) return div().size(24).flex_none().flex().items_center().justify_center().child(artwork);
  return rowButton("logo-" + space.id, tr("Logo y color de ") + name, t, () => {
    try {
      openOverlay({ mod: "rekindle-sidebar", kind: "dialog", width: 440, height: 322, props: { logoProject: space.id } });
    } catch (error) {
      showError(tr("No se pudo abrir el editor de logo"), tr("Vuelve a seleccionar el icono del proyecto."), error);
    }
  }).size(24).px(0).child(artwork);
}

function projectGrip(space, name, t, dragging, startDrag) {
  const dot = () => div().size(2).rounded(1).bg(t.muted);
  return v_flex().id("reordenar-proyecto-" + space.id).w(20).h(24).flex_none().gap(2)
    .items_center().justify_center().rounded(3)
    .when(dragging, el => el.cursor_grabbing().bg(t.hover))
    .when(!dragging, el => el.cursor_grab().hover(style => style.bg(t.hover)))
    .tooltip(tr("Arrastra para reordenar ") + name).accessibility_label(tr("Reordenar ") + name)
    .on_mouse_down("left", (_event, cx) => {
      cx.stop_propagation();
      startDrag(space, cx);
    })
    .children(Array.from({ length: 3 }, () => h_flex().gap(2).child(dot()).child(dot())));
}

function projectSection({ space, name, counts, rows, hasMore, folded, usage, reorder }, t, spriteFrames, actions) {
  const id = space?.id ?? "sin-proyecto";
  const context = [space?.machine, space?.branch].filter(Boolean).join(" · ");
  const activity = folded && counts.total ? workSummary(counts) || counts.total + (counts.total === 1 ? tr(" agente") : tr(" agentes")) : "";
  const projectUsage = space?.name === "~" ? null : usage;
  const title = v_flex().id("proyecto-" + id).flex_1().min_w(0)
    .when(Boolean(space), el => el.cursor_pointer()
      .tooltip([name, space.folder, context, usage?.detail].filter(Boolean).join("\n"))
      .on_click(() => run("space.select", { id: space.id }))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space.id } } });
      }))
    .child(div().text_size(13).font_medium().when(Boolean(space?.active), el => el.font_semibold())
      .truncate().text_color(space?.active || counts.total ? t.foreground : t.muted).child(name))
    .when(Boolean(activity || projectUsage), el => el.child(h_flex().min_w(0).gap(4)
      .when(Boolean(activity), line => line.child(div().min_w(0).text_size(10.5).truncate()
        .text_color(counts.blocked ? t.blocked : t.muted).child(activity)))
      .when(Boolean(activity && projectUsage), line => line.child(div().flex_none().text_size(10.5).text_color(t.dim).child("·")))
      .when(Boolean(projectUsage), line => line.child(div().id("tokens-proyecto-" + space?.id)
        .text_size(10.5).text_color(t.muted).truncate().tooltip(projectUsage.detail).child(projectUsage.label)))));

  return v_flex().id("equipo-proyecto-" + id).relative()
    .flex_none().min_w(0).py(4).gap(2).border_t(1).border_color(t.border)
    .when(reorder.dragging, el => el.opacity(0.55))
    .on_mouse_move((_event, cx) => actions.hoverProject(space, cx))
    .on_mouse_up("left", (_event, cx) => actions.dropProject(space, cx))
    .child(h_flex().min_h(30).items_center().gap(5)
      .child(counts.total ? foldButton("plegar-proyecto-" + id, name, folded, t,
        cx => actions.toggle("projects", space?.id ?? null, cx)) : div().w(20).flex_none())
      .child(projectLogoTile(space, name, t)).child(title)
      .when(reorder.movable, el => el.child(projectGrip(space, name, t, reorder.dragging, actions.startDrag)))
      .when(Boolean(space), el => el
        .child(rowButton("nuevo-en-" + space.id, tr("Nuevo agente en ") + name, t, () => launcher(space)).w(24).px(0).child(icon("plus")))
        .child(rowButton("opciones-proyecto-" + space.id, tr("Opciones de ") + name, t, () =>
          openOverlay({ mod: "rekindle-sidebar", kind: "popup", width: 205, height: 73, at: "pointer", props: { projectMenu: space.id } }))
          .w(24).px(0).child(icon("settings", 13)))))
    .when(rows.length > 0, el => el.child(v_flex().min_w(0).gap(2).children(rows.map(row => {
      const summary = agentRow(row, t, spriteFrames, actions);
      if (!row.request) return summary;
      return v_flex().flex_none().min_w(0).gap(4).child(summary)
        .child(row.request.ml(22 + Math.min(row.depth, 3) * 9).mr(3));
    }))))
    .when(hasMore, el => el.child(rowButton("ver-mas-agentes-" + id,
      tr("Ver más agentes en ") + name, t, cx => actions.showMore(space?.id ?? null, cx))
      .self_start().ml(22).justify_start().child(icon("chevron-down", 12)).child(tr("Ver más"))))
    .when(reorder.edge, el => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
      .when(reorder.edge === "top", line => line.top(0))
      .when(reorder.edge === "bottom", line => line.bottom(0))));
}

export default class Rekindle extends View {
  init(_props, cx) {
    const {
      rekindleError, editProject, logoProject, renameAgent, searchWorkspace, projectMenu: projectMenuId, overlay
    } = props() ?? {};
    if (typeof projectMenuId === "string") {
      this.projectMenuId = projectMenuId;
      this.overlay = overlay;
      return;
    }
    if (rekindleError) {
      this.errorDialog = new ErrorDialog(rekindleError, overlay, cx);
      return;
    }
    if (typeof editProject === "string") {
      this.projectEditor = new ProjectEditor(editProject, overlay, cx);
      return;
    }
    if (typeof logoProject === "string") {
      this.logoEditor = new ProjectLogoEditor(logoProject, cx);
      return;
    }
    if (renameAgent) {
      this.agentNameEditor = new AgentNameEditor(renameAgent, overlay, cx);
      return;
    }
    if (searchWorkspace) {
      this.workspaceSearch = new WorkspaceSearch(overlay, cx);
      return;
    }
    this.filter = "all";
    this.projectLimits = new Map();
    this.agentMenuKey = null;
    this.stoppingTasks = new Set();
    this.projectDrag = null;
    this.spriteFrames = new Map();
    this.spritesByType = new Map();
    this.attention = new AttentionRequests();
    if (checking()) return;
    cx.spawn(async cx => this.trackProfiles(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "next-pending") this.nextPending(cx);
        if (command === "language-en" || command === "language-es") setShared(LANGUAGE_KEY, command.slice(-2));
      }
    });
    this.attention.refresh(cx);
    cx.timer.every(1200, cx => {
      if (!layout()?.children?.find(node => node.id === "sidebar")?.hidden) this.attention.refresh(cx);
    });
    // One clock for the sprites, with no redraw between frames.
    cx.timer.every(100, cx => {
      if (!this.spriteFrames.size || !window()?.active || layout()?.children?.find(node => node.id === "sidebar")?.hidden) return;
      const now = Date.now();
      if ([...this.spriteFrames].some(([status, frame]) => spriteFrame(status, now) !== frame)) cx.notify();
    });
  }

  async close() {
    this.attention?.close();
    await this.logoEditor?.close();
  }

  async trackProfiles(cx) {
    const data = appHome() + "/data";
    try {
      for (;;) {
        const change = watchFolder(data);
        try {
          const source = await readTextFile(data + "/rekindle-agent-types.json");
          const profiles = source === null ? [] : JSON.parse(source.replace(/^\uFEFF/, ""));
          if (Array.isArray(profiles)) {
            this.spritesByType = new Map(profiles
              .filter(profile => typeof profile?.name === "string")
              .map(profile => [profile.name.trim().toLowerCase(), spriteForType(profile)]));
            cx.notify();
          }
        } catch {}
        if (!(await change).length) return;
      }
    } catch {}
  }

  newProject(_event, cx) {
    if (this.openingProject) return;
    this.openingProject = true;
    cx.notify();
    cx.spawn(async () => {
      let folder;
      try {
        folder = await pickFolder({ prompt: tr("Abrir como proyecto") });
        if (folder) await runChecked("space.new", { folder, machine: "" });
      } catch (error) {
        if (folder) {
          showError(tr("No se pudo abrir el proyecto"), tr("Comprueba que la carpeta sigue disponible y que tienes acceso a ella."), error);
        } else {
          showError(tr("No se pudo abrir el selector de carpetas"), tr("Pulsa Abrir carpeta para volver a intentarlo."), error);
        }
      } finally {
        this.openingProject = false;
        cx.notify();
      }
    });
  }

  toggleFold(key, id, cx) {
    const state = shared(FOLDS) ?? {};
    const folded = new Set(state[key] ?? []);
    if (!folded.delete(id)) folded.add(id);
    setShared(FOLDS, { ...state, [key]: [...folded] });
    cx.notify();
  }

  stopTask(agent, cx) {
    const { terminal, foldKey: key } = agent;
    if (this.stoppingTasks.has(key) || !canStopTask(liveAgentTerminal(terminal))) return;
    this.stoppingTasks.add(key);
    cx.notify();
    cx.spawn(async cx => {
      try {
        const current = await coreJson(["get", "--json", terminal.address]);
        if (current.created_ms !== terminal.created_ms || current.state !== "live" || !hasActiveTask(current.status?.state)) return;
        if (terminal.turn != null && current.turn !== terminal.turn) return;
        const { outcome } = await coreJson(["interrupt", "--json", terminal.address]);
        const { title, level } = STOP_TASK_FEEDBACK[outcome] ?? { title: "Interrupción enviada", level: "info" };
        notify({ title: tr(title), level, body: agent.conversationTitle });
      } catch (error) {
        showError(tr("No se pudo detener la tarea"), tr("Vuelve a intentarlo desde el menú del agente."), error);
      } finally {
        this.stoppingTasks.delete(key);
        cx.notify();
      }
    });
  }

  revealAgent(agent, team, filter, cx) {
    this.filter = filter;
    const byAddress = new Map(team.map(member => [member.address, member]));
    const revealed = new Set();
    for (let member = agent; member && !revealed.has(member.foldKey); member = byAddress.get(member.parent)) {
      revealed.add(member.foldKey);
    }
    const { projects = [], teams = [] } = shared(FOLDS) ?? {};
    const projectId = spaces().some(space => space.id === agent.space) ? agent.space : null;
    const nextProjects = projects.filter(id => id !== projectId);
    const nextTeams = teams.filter(id => !revealed.has(id));
    if (nextProjects.length !== projects.length || nextTeams.length !== teams.length) {
      setShared(FOLDS, { projects: nextProjects, teams: nextTeams });
    }
    cx.notify();
  }

  trackAgentUse(agent, cx) {
    const key = agent?.foldKey;
    const turn = agent?.terminal?.turn;
    const working = agent?.status === "working";
    const previous = this.lastFocus;
    if (previous?.key === key && previous?.turn === turn && previous?.working === working) return;
    const observation = { key, turn, working };
    this.lastFocus = observation;
    const changedAgent = previous?.key !== key;
    const startedWork = working && (!previous?.working || previous.turn !== turn);
    if (key && (changedAgent || startedWork)) {
      this.lastUse = observation;
      cx.spawn(async () => {
        if (this.lastUse === observation) rememberAgentUse(key);
      });
    }
  }

  nextPending(cx) {
    const here = focused();
    const address = here?.terminal ?? here?.agent;
    const live = terminals();
    const team = projectTeam(agents(), live, address);
    const waitingTimes = new Map(live.map(terminal => [terminal.address, this.attention.since(terminal)]));
    const pending = nextPendingAgent(team, address, waitingTimes);
    if (!pending) {
      notify({ title: tr("Ningún agente necesita tu atención") });
      return;
    }
    this.revealAgent(pending, team, "blocked", cx);
    openAgent(pending);
  }

  hoverProject(space, cx) {
    const drag = this.projectDrag;
    if (!drag) return;
    if (space) cx.stop_propagation();
    const target = space && space.id !== drag.source.id && space.machine === drag.source.machine ? space.id : null;
    if (target === drag.target) return;
    drag.target = target;
    cx.notify();
  }

  dropProject(space, cx) {
    const drag = this.projectDrag;
    if (!drag) return;
    this.projectDrag = null;
    cx.notify();
    if (!space || space.id !== drag.target) return;
    const projects = spaces();
    const current = projects.find(project => project.id === drag.source.id);
    const index = projects.findIndex(project => project.id === space.id);
    if (current && index >= 0 && projects[index].machine === current.machine) {
      run("space.move", { id: current.id, index: index + 1 });
    }
  }

  render(cx) {
    if (this.projectMenuId) return projectMenu(spaces().find(space => space.id === this.projectMenuId), this.overlay, theme());
    if (this.errorDialog) return this.errorDialog.render();
    if (this.projectEditor) return this.projectEditor.render();
    if (this.logoEditor) return this.logoEditor.render();
    if (this.agentNameEditor) return this.agentNameEditor.render();
    if (this.workspaceSearch) return this.workspaceSearch.render();
    const t = theme();
    const projects = spaces();
    const names = projectNames(projects);
    const here = focused();
    const address = here?.terminal ?? here?.agent;
    const liveTerminals = terminals();
    const team = projectTeam(agents(), liveTerminals, address);
    this.trackAgentUse(team.find(agent => agent.address === address), cx);
    const useHistory = agentUseHistory();
    const { total, working, blocked } = agentCounts(team);
    const folds = shared(FOLDS) ?? {};
    const usage = shared(CODEX_USAGE);
    const foldedProjects = new Set(folds.projects ?? []);
    const foldedTeams = new Set(folds.teams ?? []);
    const actions = {
      toggle: (key, id, cx) => this.toggleFold(key, id, cx),
      showMore: (id, cx) => {
        const limit = this.projectLimits.get(id) ?? AGENTS_PER_PAGE;
        this.projectLimits.set(id, limit + AGENTS_PER_PAGE);
        cx.notify();
      },
      startDrag: (space, cx) => {
        this.projectDrag = { source: space, target: null };
        cx.notify();
      },
      hoverProject: (space, cx) => this.hoverProject(space, cx),
      dropProject: (space, cx) => this.dropProject(space, cx),
      agentMenuKey: this.agentMenuKey,
      stoppingTasks: this.stoppingTasks,
      stopTask: (agent, cx) => this.stopTask(agent, cx),
      setAgentMenu: (key, open, cx) => {
        if (open === (this.agentMenuKey === key)) return;
        this.agentMenuKey = open ? key : null;
        cx.notify();
      },
      delegate: (agent, cx) => {
        this.revealAgent(agent, team, "all", cx);
        launcher(projects.find(space => space.id === agent.space), false, {
          parent: agent.address, parentName: agent.conversationTitle, parentType: agent.type ?? agent.tab_name,
          parentCreated: agent.terminal.created_ms ?? null
        });
      }
    };
    const grouped = new Map(projects.map(space => [space.id, { space, agents: [] }]));
    const unassigned = { space: null, agents: [] };
    for (const agent of team) {
      (grouped.get(agent.space) ?? unassigned).agents.push(agent);
    }
    if (unassigned.agents.length) grouped.set(null, unassigned);
    const shown = [];
    const navigable = new Set();
    const spriteStates = new Set();
    const visibleProjectsByMachine = new Map();
    for (const project of grouped.values()) {
      const counts = agentCounts(project.agents);
      if (this.filter !== "all" && counts[this.filter] === 0) continue;
      const space = project.space;
      const id = space?.id ?? null;
      const limit = this.projectLimits.get(id) ?? AGENTS_PER_PAGE;
      const folded = foldedProjects.has(id);
      const orderedRows = folded ? [] : orderProjectTeam(project.agents, this.filter, foldedTeams, useHistory);
      for (const row of orderedRows) navigable.add(row.agent.address);
      const rows = orderedRows.slice(0, limit).map(row => {
        const { agent } = row;
        const { terminal } = agent;
        const typeName = agent.type ?? agent.tab_name;
        const typeSprite = this.spritesByType.get(typeName?.trim().toLowerCase());
        const chat = usage?.chats?.[agent.address];
        const isCodex = agent.app === "codex" || agent.program?.key === "codex";
        const chatUsage = chat && chat.process === (terminal?.pid ?? null) ? chat : isCodex && !agent.address.includes("/")
          ? { label: "Tokens —", detail: tr("Todavía no hay un contador vinculado a este chat de Codex.") } : null;
        spriteStates.add(STATES[agent.status] ?? STATES.idle);
        return {
          ...row, usage: chatUsage,
          type: agent.type ?? (typeSprite ? typeName : null),
          sprite: typeSprite ?? spriteForType(),
          request: agent.status === "blocked" ? this.attention.card(agent, terminal, t) : null
        };
      });
      if (space) visibleProjectsByMachine.set(space.machine, (visibleProjectsByMachine.get(space.machine) ?? 0) + 1);
      shown.push({
        space, name: names.get(id) || tr("Sin proyecto"), counts, rows, folded,
        hasMore: orderedRows.length > limit, usage: usage?.projects?.[space?.id]
      });
    }
    const drag = this.projectDrag;
    const sourceIndex = drag ? projects.findIndex(space => space.id === drag.source.id) : -1;
    const targetIndex = drag?.target ? projects.findIndex(space => space.id === drag.target) : -1;
    const dropEdge = sourceIndex >= 0 && targetIndex >= 0 ? (sourceIndex < targetIndex ? "bottom" : "top") : null;
    const now = Date.now();
    this.spriteFrames = new Map([...spriteStates].map(status => [status, spriteFrame(status, now)]));
    // Keep Next and Previous in pane order and include agents on later pages.
    setAgentOrder(team.filter(agent => navigable.has(agent.address)).map(agent => agent.address));

    const filters = [
      ["all", tr("Todos"), total],
      ["working", tr("En curso"), working],
      ["blocked", tr("Atención"), blocked]
    ];
    const filterBar = h_flex().min_w(0).items_center().gap(4)
      .children(filters.map(([key, title, count]) => {
        const active = this.filter === key;
        return button("filtro-" + key, t, (_event, cx) => { this.filter = key; cx.notify(); })
          .selected(active).accessibility_label(title + ", " + count).rounded(0)
          .border_b(1).border_color(active ? t.accent : t.chrome)
          .text_color(active ? t.foreground : t.muted).text_size(11.5).child(title)
          .when(count > 0, el => el.child(div().flex_none().text_color(key === "blocked" ? t.blocked : t.muted)
            .child(String(count))));
      }))
      .child(div().flex_1())
      .when(blocked > 0, el => el.child(button("siguiente-pendiente", t, (_event, cx) => this.nextPending(cx))
        .w(27).px(0).text_color(t.blocked)
        .tooltip(tr("Siguiente pendiente")).accessibility_label(tr("Siguiente pendiente"))
        .child(icon("chevron-right", 15))));
    const empty = { all: tr("Abre una carpeta para empezar un proyecto."), working: tr("No hay agentes trabajando ahora."), blocked: tr("Ningún agente necesita tu atención.") };
    const reviews = (shared(REVIEWS)?.items ?? []).filter(item => !item.reviewed).length;
    const locale = language();
    const nextLocale = locale === "en" ? "es" : "en";
    const languageLabel = locale === "en" ? "Cambiar a español" : "Switch to English";
    const searchLabel = tr("Buscar conversaciones y proyectos");
    return v_flex().id("rekindle-sidebar").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(v_flex().flex_none().px(12).pt(window()?.platform === "macos" ? 35 : 12).gap(7)
        .child(h_flex().justify_between().items_center().gap(6)
          .child(div().text_size(18).font_semibold().child("Rekindle"))
          .child(div().flex_1())
          .child(button("rekindle-language", t, () => setShared(LANGUAGE_KEY, nextLocale))
            .tooltip(languageLabel).accessibility_label(languageLabel).child(locale.toUpperCase()))
          .child(button("abrir-busqueda", t, () =>
            openOverlay({ mod: "rekindle-sidebar", kind: "dialog", width: 480, height: 430, props: { searchWorkspace: true } }))
            .w(28).px(0).tooltip(searchLabel).accessibility_label(searchLabel).child(icon("search", 15)))
          .child(button("nuevo-agente", t, () => launcher(projects.find(space => space.active)))
            .border(1).border_color(t.border).text_color(t.foreground).px(8)
            .child(icon("plus", 13)).child(tr("Nuevo agente"))))
        .child(filterBar))
      .child(h_flex().flex_none().px(12).py(5).gap(5).items_center().border_t(1).border_color(t.border)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(tr("Proyectos")))
        .child(div().flex_1())
        .when(window()?.platform === "windows", el => el.child(button("abrir-entregas", t, () =>
          run("mod.open", { name: "rekindle-deliveries" }))
          .px(6).tooltip(tr("Entregas pendientes de revisión")).accessibility_label(tr("Entregas, ") + reviews + tr(" pendientes"))
          .child(icon("archive", 13)).child(reviews ? tr("Entregas (") + reviews + ")" : tr("Entregas"))))
        .child(button("abrir-proyecto", t, (event, cx) => this.newProject(event, cx), { enabled: !this.openingProject })
          .px(6).child(icon("folder-plus")).child(this.openingProject ? tr("Abriendo…") : tr("Abrir carpeta"))))
      .child(v_flex().id("rekindle-proyectos").flex_1().min_h(0).px(12).pb(10).overflow_y_scrollbar()
        .on_hover((hovered, cx) => { if (!hovered) this.dropProject(null, cx); })
        .on_mouse_down("left", (_event, cx) => this.dropProject(null, cx))
        .on_mouse_move((_event, cx) => this.hoverProject(null, cx))
        .on_mouse_up("left", (_event, cx) => this.dropProject(null, cx))
        .children(shown.map(project => {
          const { space } = project;
          const reorder = {
            movable: space && visibleProjectsByMachine.get(space.machine) > 1,
            dragging: space && space.id === drag?.source.id,
            edge: space?.id === drag?.target ? dropEdge : null
          };
          return projectSection({ ...project, reorder }, t, this.spriteFrames, actions);
        }))
        .when(!shown.length, el => el.child(div().px(6).py(11).text_size(12).text_color(t.muted).child(empty[this.filter]))));
  }
}
