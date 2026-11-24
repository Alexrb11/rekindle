import { div, svg } from "gpui-kit";
import { Button, Input, InputState, h_flex, v_flex } from "gpui-base";
import { agents, closeOverlay, run, spaces, terminals, theme } from "herdr";
import { openAgent, projectNames, projectTeam } from "./project-team.js";
import { tr } from "./i18n.js";

function searchText(value) {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function* workspaceResults(query) {
  const terms = searchText(query).split(/\s+/).filter(Boolean);
  const matches = (...parts) => {
    if (terms.length === 0) return true;
    const text = searchText(parts.filter(Boolean).join(" "));
    return terms.every(term => text.includes(term));
  };
  const projects = spaces();
  const names = projectNames(projects);
  for (const project of projects) {
    const title = names.get(project.id);
    if (!matches(title, project.folder)) continue;
    yield {
      key: "project-" + project.id, projectId: project.id, title,
      detail: [project.machine, project.folder].filter(Boolean).join(" · ")
    };
  }
  for (const agent of projectTeam(agents(), terminals(), null)) {
    const title = agent.conversationTitle;
    const project = names.get(agent.space);
    if (!matches(title, agent.originalTitle, project)) continue;
    yield {
      key: "conversation-" + agent.foldKey, agent, title,
      detail: [project, agent.originalTitle !== title && agent.originalTitle].filter(Boolean).join(" · ")
    };
  }
}

function icon(name, size = 16) {
  return svg("mods/workspace-chrome/" + name + ".svg").size(size).flex_none();
}

function resultButton(result, t, first, open) {
  const { key, title, detail, agent } = result;
  const label = [title, detail].filter(Boolean).join(" · ");
  return Button.new("resultado-" + key)
    .h(42).w_full().flex_none().min_w(0).px(9).gap(8).flex().items_center().justify_start()
    .rounded(5).cursor_pointer().when(first, el => el.bg(t.surface))
    .hover(el => el.bg(t.hover)).accessibility_label(label).tooltip(label)
    .on_click(open).child(icon(agent ? "file-text" : "folder").text_color(t.muted))
    .child(v_flex().min_w(0).flex_1()
      .child(div().text_size(13).font_medium().truncate().child(title))
      .when(Boolean(detail), el => el.child(div().text_size(10.5).text_color(t.muted).truncate().child(detail))));
}

export class WorkspaceSearch {
  constructor(overlay, cx) {
    this.overlay = overlay;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: tr("Título, nombre o proyecto") });
    this.input.on("change", (_event, cx) => cx.notify());
    this.input.on("submit", () => this.open(workspaceResults(this.input.value()).next().value));
    cx.timer.after(100, () => this.input.focus());
  }

  open(result) {
    if (!result) return;
    closeOverlay(this.overlay);
    if (result.agent) openAgent(result.agent);
    else run("space.select", { id: result.projectId });
  }

  render() {
    const t = theme();
    const label = tr("Buscar conversaciones y proyectos");
    const results = [...workspaceResults(this.input.value())];
    const close = () => closeOverlay(this.overlay);
    const closeLabel = tr("Cerrar búsqueda");
    return v_flex().id("buscador-del-espacio").track_focus(this.handle).size_full().min_h(0).p(14).gap(9)
      .bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        cx.stop_propagation();
        close();
      })
      .child(h_flex().items_center().gap(8).h(36).px(9).rounded(6).border(1).border_color(t.input).bg(t.background)
        .child(icon("search", 15).text_color(t.muted))
        .child(Input.new(this.input).h_full().flex_1().min_w(0).text_size(13).accessibility_label(label))
        .child(Button.new("cerrar-buscador").size(24).flex_none().rounded(4).cursor_pointer().text_color(t.muted)
          .hover(el => el.bg(t.hover).text_color(t.foreground)).accessibility_label(closeLabel)
          .tooltip(closeLabel).on_click(close).child(icon("x", 13))))
      .child(v_flex().id("resultados-busqueda").flex_1().min_h(0).gap(2).overflow_y_scrollbar()
        .when(results.length === 0, el => el.child(div().px(8).py(10).text_size(12).text_color(t.muted)
          .child(tr("No se encontraron conversaciones ni proyectos."))))
        .children(results.map((result, index) => resultButton(result, t, index === 0, () => this.open(result)))));
  }
}
