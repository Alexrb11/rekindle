import { div } from "gpui-kit";
import { Button, Input, InputState, Switch, h_flex, v_flex } from "gpui-base";
import { run } from "herdr";
import { tr } from "./i18n.js";
import {
  CODEX_PERMISSION_MODES, currentPreferences, enabledPanels, MAX_RUNNING_WARNING, PANELS, quotaAlertThreshold,
  resetPreferences, setPreferenceOptions, setPreferredPanels, setQuotaAlertThreshold
} from "./preferences.js";

function title(text, t) {
  return div().text_size(13).font_semibold().text_color(t.foreground).child(tr(text));
}

export function settingsButton(id, label, t, action, { disabled = false, selected = false } = {}) {
  return Button.new(id).disabled(disabled).selected(selected).h(29).px(9).flex_none().items_center().justify_center()
    .rounded(4).border(1).border_color(selected ? t.accent : t.border).bg(selected ? t.raised : t.popover)
    .text_size(12).text_color(disabled ? t.dim : t.foreground)
    .when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click(action)).child(label);
}

function toggle(id, label, on, change, t, disabled = false) {
  return Switch.new(id).checked(on).disabled(disabled).on_change(change).accessibility_label(label)
    .w_full().h(29).flex().items_center().justify_between().gap(12).text_color(disabled ? t.dim : t.foreground)
    .when(!disabled, el => el.cursor_pointer())
    .child(div().min_w(0).truncate().child(label))
    .child(h_flex().w(31).h(17).flex_none().items_center().px(3).rounded_full().border(1)
      .border_color(on && !disabled ? t.accent : t.border).bg(on && !disabled ? t.accent : t.input)
      .when(on, el => el.justify_end()).child(div().size(10).rounded_full().bg(t.foreground)));
}

function choices(id, label, value, options, change, t) {
  return h_flex().min_w(0).gap(10).justify_between().items_center()
    .child(div().flex_1().min_w(0).child(label))
    .child(h_flex().flex_none().gap(3).children(options.map(([option, text]) =>
      settingsButton(id + "-" + option, text, t, () => change(option), { selected: value === option }))));
}

function numericValue(input, maximum) {
  const text = input.value().trim();
  return /^\d{1,3}$/.test(text) && Number(text) <= maximum ? Number(text) : null;
}

function numberInput(id, label, input, max, t) {
  const invalid = numericValue(input, max) === null;
  const hint = invalid ? tr("Introduce un número entero entre 0 y ") + max + "." : tr("0 desactiva el aviso.");
  return h_flex().id(id).gap(12).justify_between().items_center()
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().child(label))
      .child(div().text_size(10.5).text_color(invalid ? t.blocked : t.muted).child(hint)))
    .child(Input.new(input).w(58).h(29).px(8).rounded(4).border(1).bg(t.background)
      .border_color(invalid ? t.blocked : t.input).accessibility_label(label));
}

function bindNumber(input, max, change) {
  input.on("change", (_event, cx) => {
    const value = numericValue(input, max);
    if (value !== null) change(value);
    cx.notify();
  });
}

export class PreferencesPanel {
  constructor() {
    this.runningLimit = InputState.new({ value: String(currentPreferences().runningAgentWarning) });
    this.quotaThreshold = InputState.new({ value: String(quotaAlertThreshold()) });
    bindNumber(this.runningLimit, MAX_RUNNING_WARNING, value => setPreferenceOptions({ runningAgentWarning: value }));
    bindNumber(this.quotaThreshold, 100, setQuotaAlertThreshold);
  }

  syncInputs() {
    this.runningLimit.set_value(String(currentPreferences().runningAgentWarning));
    this.quotaThreshold.set_value(String(quotaAlertThreshold()));
  }

  render(t) {
    const prefs = currentPreferences();
    const panels = enabledPanels();
    const change = key => value => setPreferenceOptions({ [key]: value });
    const togglePref = (key, label, disabled = false) => toggle(key, tr(label), prefs[key], change(key), t, disabled);
    const choosePref = (key, label, items) => choices(key, tr(label), prefs[key], items, change(key), t);
    const permission = CODEX_PERMISSION_MODES.find(mode => mode.value === prefs.codexPermissions);
    const togglePanel = (panel, checked) => {
      const shown = PANELS.filter(name => name === panel ? checked : enabledPanels().includes(name));
      setPreferredPanels(shown);
    };
    const group = label => v_flex().flex_none().gap(4).pt(6).pb(8).border_b(1).border_color(t.border)
      .child(title(label, t));
    const appearance = group("Apariencia")
      .child(choosePref("density", "Densidad", [["comfortable", tr("Cómoda")], ["compact", tr("Compacta")]]))
      .child(togglePref("showSprites", "Mostrar sprites"))
      .child(togglePref("animateSprites", "Animar sprites", !prefs.showSprites))
      .child(togglePref("showAgentStatus", "Mostrar texto de estado"));
    const projects = group("Proyectos y agentes")
      .child(v_flex().gap(4).pb(3)
        .child(div().child(tr("Permisos de inicio de Codex")))
        .child(h_flex().flex_wrap().gap(4).children(CODEX_PERMISSION_MODES.map(mode =>
          settingsButton("permisos-codex-" + mode.value, tr(mode.label), t, () => change("codexPermissions")(mode.value),
            { selected: mode === permission }))))
        .child(div().text_size(10.5).text_color(t.muted).child(tr(permission.detail))))
      .child(choosePref("agentsPerPage", "Agentes por proyecto", [[4, "4"], [8, "8"], [12, "12"], ["all", tr("Todos")]]))
      .child(choosePref("agentOrder", "Orden de los agentes", [
        ["recent", tr("Uso reciente")], ["created", tr("Creación")], ["name", tr("Nombre")]
      ]))
      .child(numberInput("aviso-agentes", tr("Avisar al lanzar con este número de agentes en curso"), this.runningLimit, MAX_RUNNING_WARNING, t));
    const workspace = group("Paneles")
      .child(toggle("mostrar-archivos", tr("Archivos"), panels.includes("files"), on => togglePanel("files", on), t))
      .child(toggle("mostrar-cambios", tr("Cambios"), panels.includes("changes"), on => togglePanel("changes", on), t))
      .child(togglePref("showDeliveries", "Entregas"));
    const codex = group("Codex y avisos")
      .child(togglePref("showTokens", "Tokens por conversación"))
      .child(togglePref("showWeeklyQuota", "Mostrar cuota semanal"))
      .child(choosePref("quotaRefreshMs", "Actualizar cuota", [
        [30_000, "30 s"], [60_000, "1 min"], [120_000, "2 min"], [0, tr("Manual")]
      ]))
      .child(numberInput("aviso-cuota-porcentaje", tr("Avisar cuando la cuota baje de (%)"), this.quotaThreshold, 100, t))
      .child(h_flex().justify_end().child(settingsButton("actualizar-cuota-ahora", tr("Consultar ahora"), t,
        () => run("rekindle-status.refresh-quota"))));
    return v_flex().flex_1().min_h(0).gap(8)
      .child(v_flex().id("contenido-preferencias").flex_1().min_h(0).pr(6).gap(8).text_size(12).overflow_y_scrollbar()
        .child(appearance).child(projects).child(workspace).child(codex))
      .child(h_flex().flex_none().justify_start().child(settingsButton("restablecer-preferencias", tr("Restablecer preferencias"), t,
        (_event, cx) => {
          resetPreferences();
          this.syncInputs();
          cx.notify();
        })));
  }
}
