import { tr } from "./i18n.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, theme } from "herdr";

export class ErrorDialog {
  constructor(alert, overlay, cx) {
    this.alert = alert;
    this.overlay = overlay;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  dismiss() {
    closeOverlay(this.overlay);
  }

  render() {
    const t = theme();
    const { title, message, detail } = this.alert;
    return v_flex().id("rekindle-aviso").size_full().min_h(0).p(16).gap(10).bg(t.popover)
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key !== "enter" && event.key !== "escape") return;
        cx.stop_propagation();
        this.dismiss();
      })
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().size(25).flex_none().flex().items_center().justify_center()
          .rounded_full().border(1).border_color(t.blocked).text_color(t.blocked).font_semibold().child("!"))
        .child(div().flex_1().min_w(0).text_size(16).font_semibold().text_color(t.foreground).child(title)))
      .child(v_flex().id("rekindle-aviso-mensaje").flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .child(div().text_size(13).text_color(t.foreground).child(message))
        .when(Boolean(detail), el => el.child(v_flex().gap(3).p(8).rounded(6).bg(t.surface)
          .child(div().text_size(11).font_semibold().text_color(t.muted).child(tr("Detalles técnicos")))
          .child(div().min_w(0).text_size(11.5).text_color(t.muted).child(detail)))))
      .child(h_flex().flex_none().pt(8).border_t(1).border_color(t.border).justify_end()
        .child(div().id("cerrar-aviso").h(30).px(13).flex().items_center().rounded(6)
          .bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium().cursor_pointer()
          .hover(el => el.opacity(0.86)).on_click(() => this.dismiss()).child(tr("Entendido"))));
  }
}
