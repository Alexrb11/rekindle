import { div } from "gpui-kit";
import { Button, Input, InputState, h_flex, v_flex } from "gpui-base";
import { closeOverlay, hc, theme } from "herdr";
import { AGENT_NAME_LABEL, liveAgentTerminal } from "./project-team.js";
import { tr } from "./i18n.js";

function button(id, label, t, action, { primary = false, disabled = false } = {}) {
  return Button.new(id).h(32).px(12).rounded(6).text_size(12).font_medium()
    .bg(primary && !disabled ? t.solid : t.raised)
    .text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
    .disabled(disabled).when(!disabled, el => el.cursor_pointer().hover(el => el.opacity(0.86)))
    .on_click(action).child(label);
}

export class AgentNameEditor {
  constructor(target, overlay, cx) {
    this.target = target;
    this.overlay = overlay;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ value: target.name });
    this.input.set_selected_range({ start: 0, end: target.name.length });
    this.input.on("change", (_event, cx) => cx.notify());
    this.input.on("submit", (_event, cx) => this.save(cx));
    cx.timer.after(100, () => this.input.focus());
  }

  canSave(terminal, name) {
    const saved = terminal.labels?.[AGENT_NAME_LABEL];
    return name ? name !== this.target.name && name !== saved : Boolean(saved);
  }

  save(cx) {
    const terminal = liveAgentTerminal(this.target);
    const name = this.input.value().trim();
    if (this.saving || !terminal || !this.canSave(terminal, name)) return;
    this.saving = true;
    this.error = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await hc(["label", terminal.address, AGENT_NAME_LABEL + "=" + name]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
      } catch (error) {
        this.error = [tr("No se pudo guardar el nombre."), error?.message].filter(Boolean).join(" ");
        this.saving = false;
        cx.notify();
        return;
      }
      closeOverlay(this.overlay);
    });
  }

  render() {
    const t = theme();
    const terminal = liveAgentTerminal(this.target);
    const close = () => { if (!this.saving) closeOverlay(this.overlay); };
    const root = v_flex().id("editor-nombre-agente").track_focus(this.handle).size_full().min_h(0)
      .p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        cx.stop_propagation();
        close();
      })
      .child(div().text_size(17).font_semibold().child(tr("Cambiar nombre")));
    const footer = h_flex().flex_none().gap(8).justify_end();
    if (!terminal) return root
      .child(div().flex_1().text_size(13).text_color(t.muted).child(tr("El agente ya está cerrado.")))
      .child(footer.child(button("cerrar-nombre-agente", tr("Cerrar"), t, close, { disabled: this.saving })));

    const nameLabel = tr("Nombre del agente");
    return root
      .child(v_flex().id("nombre-agente-contenido").flex_1().min_h(0).gap(6).overflow_y_scrollbar()
        .child(div().text_size(12).font_medium().child(nameLabel))
        .child(Input.new(this.input).w_full().h(34).px(9).rounded(6).border(1).border_color(t.input)
          .bg(t.background).text_size(13).accessibility_label(nameLabel))
        .child(div().text_size(11).text_color(t.muted)
          .child(tr("Deja el campo vacío para usar el título de la conversación.")))
        .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error))))
      .child(footer
        .child(button("cancelar-nombre-agente", tr("Cancelar"), t, close, { disabled: this.saving }))
        .child(button("guardar-nombre-agente", this.saving ? tr("Guardando…") : tr("Guardar"),
          t, (_event, cx) => this.save(cx), { primary: true, disabled: this.saving || !this.canSave(terminal, this.input.value().trim()) })));
  }
}
