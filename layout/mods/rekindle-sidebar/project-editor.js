import { tr } from "./i18n.js";
import { div } from "gpui-kit";
import { Button, Input, InputState, h_flex, v_flex } from "gpui-base";
import { closeOverlay, spaces, theme } from "herdr";
import { runChecked } from "./errors.js";

function button(id, label, t, action, { bg = t.raised, fg = t.foreground, disabled = false } = {}) {
  return Button.new(id).h(32).px(12).flex_none().rounded(6).text_size(12).font_medium()
    .bg(disabled ? t.raised : bg).text_color(disabled ? t.dim : fg).disabled(disabled)
    .when(!disabled, el => el.cursor_pointer().hover(el => el.opacity(0.86)))
    .on_click(action).child(label);
}

export class ProjectEditor {
  constructor(spaceId, overlay, cx) {
    this.spaceId = spaceId;
    this.overlay = overlay;
    this.confirming = false;
    this.pending = false;
    this.handle = cx.focus_handle();
    this.handle.focus();

    const name = this.project()?.name ?? "";
    this.nameInput = InputState.new({ value: name, placeholder: tr("Nombre automático") });
    if (name) this.nameInput.set_selected_range({ start: 0, end: name.length });
    this.nameInput.on("change", (_event, cx) => cx.notify());
    this.nameInput.on("submit", (_event, cx) => this.save(cx));
    this.focusName(cx);
  }

  project() {
    return spaces().find(space => space.id === this.spaceId);
  }

  focusName(cx) {
    cx.timer.after(100, () => {
      if (!this.confirming && !this.pending && this.project()) this.nameInput.focus();
    });
  }

  setConfirmation(confirming, cx) {
    if (this.pending) return;
    this.confirming = confirming;
    this.error = "";
    if (confirming) this.handle.focus();
    else this.focusName(cx);
    cx.notify();
  }

  canSave(project, name) {
    return name ? name !== project.name : project.named;
  }

  save(cx) {
    const project = this.project();
    const name = this.nameInput.value().trim();
    if (this.confirming || !project || !this.canSave(project, name)) return;
    this.apply("space.rename", { id: this.spaceId, name }, tr("No se pudo guardar el nombre."), cx);
  }

  remove(cx) {
    if (!this.confirming || !this.project()) return;
    this.apply("space.close", { id: this.spaceId, confirmed: true }, tr("No se pudo eliminar el proyecto."), cx);
  }

  apply(command, args, message, cx) {
    if (this.pending) return;
    this.pending = true;
    this.error = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        await runChecked(command, args);
      } catch (error) {
        this.error = [message, error?.message ?? String(error)].filter(Boolean).join(" ");
        this.pending = false;
        cx.notify();
        return;
      }
      closeOverlay(this.overlay);
    });
  }

  render() {
    const t = theme();
    const project = this.project();
    const title = this.confirming && project ? tr("¿Eliminar proyecto?") : tr("Editar proyecto");
    const close = () => closeOverlay(this.overlay);
    const cancel = (_event, cx) => this.confirming && project ? this.setConfirmation(false, cx) : close();
    const root = v_flex().id("editor-proyecto").track_focus(this.handle).size_full().min_h(0)
      .p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        cx.stop_propagation();
        if (!this.pending) cancel(event, cx);
      })
      .child(div().flex_none().text_size(18).font_semibold().child(title));
    if (!project) return root
      .child(div().flex_1().text_size(13).text_color(t.muted).child(tr("El proyecto ya está cerrado.")))
      .child(h_flex().justify_end().child(button("cerrar-editor-proyecto", tr("Cerrar"), t, close)));

    const content = v_flex().id("editor-proyecto-contenido").flex_1().min_h(0).gap(6).overflow_y_scrollbar();
    const footer = h_flex().flex_none().gap(8).items_center();
    if (this.confirming) {
      const location = [project.machine, project.folder].filter(Boolean).join(" · ");
      content.child(div().text_size(13).font_semibold().child(project.name))
        .when(Boolean(location), el => el.child(div().text_size(11).text_color(t.dim).child(location)))
        .child(div().pt(4).text_size(13).text_color(t.muted)
          .child(tr("Al quitar el proyecto de Herdr, se cerrarán sus agentes, subagentes y terminales.")));
      footer.justify_end()
        .child(button("cancelar-eliminar-proyecto", tr("Cancelar"), t, cancel, { disabled: this.pending }))
        .child(button("confirmar-eliminar-proyecto", this.pending ? "Eliminando…" : tr("Eliminar proyecto"),
          t, (_event, cx) => this.remove(cx), { bg: t.ansi1, fg: t.background, disabled: this.pending }));
    } else {
      content.child(div().text_size(12).font_medium().child(tr("Nombre del proyecto")))
        .child(Input.new(this.nameInput).w_full().h(34).px(9).rounded(6).border(1).border_color(t.input)
          .bg(t.background).text_color(t.foreground).text_size(13).accessibility_label(tr("Nombre del proyecto")))
        .child(div().text_size(11).text_color(t.muted).child(tr("Deja el campo vacío para usar el nombre automático.")));
      footer.child(button("pedir-eliminar-proyecto", tr("Eliminar proyecto…"), t, (_event, cx) => this.setConfirmation(true, cx),
        { fg: t.ansi1, disabled: this.pending }))
        .child(div().flex_1())
        .child(button("cancelar-editar-proyecto", tr("Cancelar"), t, cancel, { disabled: this.pending }))
        .child(button("guardar-proyecto", this.pending ? tr("Guardando…") : tr("Guardar"), t, (_event, cx) => this.save(cx),
          { bg: t.solid, fg: t.solid_foreground, disabled: this.pending || !this.canSave(project, this.nameInput.value().trim()) }));
    }
    return root.child(content.when(Boolean(this.error), el => el.child(div().pt(4).text_size(12)
      .text_color(t.ansi1).child(this.error)))).child(footer);
  }
}
