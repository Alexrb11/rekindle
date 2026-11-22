// Rekindle mod for Herdr Desktop
// SPDX-License-Identifier: MIT
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, props, setShared, shared, terminals, theme } from "herdr";

const languageKey = "rekindle.language";
const savedSession = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}@[0-9]{1,19}$/i;
const languages = [["en", "English"], ["es", "Español"]];
const text = {
  en: {
    close: "Close",
    intro: "Resume your Codex chats when you reopen Herdr.",
    language: "Language",
    saved: "Panes with saved chats",
    empty: "Send a message in a Codex pane to save its chat.",
    ready: "Saved chats reopen in their original panes after a restart.",
  },
  es: {
    close: "Cerrar",
    intro: "Retoma tus chats de Codex al volver a abrir Herdr.",
    language: "Idioma",
    saved: "Paneles con chats guardados",
    empty: "Envía un mensaje en un panel de Codex para guardar el chat.",
    ready: "Los chats guardados se reabren en su panel al reiniciar.",
  },
};

function button(id, label, colors, selected, onClick) {
  return h_flex().id(id).h(30).px(11).items_center().rounded(6)
    .bg(selected ? colors.solid : colors.raised)
    .text_color(selected ? colors.solid_foreground : colors.foreground)
    .hover((style) => selected ? style.opacity(0.88) : style.bg(colors.hover))
    .cursor_pointer().on_click(onClick).child(label);
}

export default class Rekindle extends View {
  init(_props, cx) {
    this.focus = cx.focus_handle();
    this.focus.focus();
  }

  render() {
    const colors = theme();
    const language = shared(languageKey) === "es" ? "es" : "en";
    const copy = text[language];
    const saved = terminals().filter((terminal) =>
      terminal.state === "live" && /^t[0-9a-z]+$/.test(terminal.address ?? "") &&
      typeof terminal.labels?.["codex.resume"] === "string" &&
      savedSession.test(terminal.labels["codex.resume"]),
    ).length;

    return v_flex().id("rekindle").track_focus(this.focus)
      .on_key_down((event, cx) => {
        if (event.key === "left") setShared(languageKey, "en");
        else if (event.key === "right") setShared(languageKey, "es");
        else return;
        cx.stop_propagation();
      })
      .size_full().p(18).gap(12).bg(colors.popover).text_color(colors.foreground).text_size(13)
      .child(v_flex().gap(5)
        .child(h_flex().items_center().gap(12)
          .child(div().flex_1().text_size(19).font_semibold().child("Rekindle"))
          .child(button("rekindle-close", copy.close, colors, false, () => closeOverlay(props().overlay))))
        .child(div().text_color(colors.muted).child(copy.intro)))
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().font_semibold().child(copy.language))
        .children(languages.map(([code, label]) =>
          button("rekindle-" + code, label, colors, language === code, () => setShared(languageKey, code)))))
      .child(v_flex().p(11).gap(5).rounded(8).bg(colors.surface)
        .border_1().border_color(colors.border)
        .child(h_flex().items_center().gap(10)
          .child(div().flex_1().font_semibold().child(copy.saved))
          .child(div().font_semibold().text_color(colors.accent).child(String(saved))))
        .child(div().text_color(colors.muted).child(saved ? copy.ready : copy.empty)));
  }
}
