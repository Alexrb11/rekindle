import { tr } from "./i18n.js";
import { div } from "gpui-kit";
import { Button, h_flex, v_flex, Input, InputState } from "gpui-base";
import { closeOverlay, notify, setShared, shared } from "herdr";
import { QUOTA_KEY, remainingQuota } from "./usage.js";

const ALERT_KEY = "rekindle.quota-alerts";
const DEFAULT_THRESHOLD = 20;

export function quotaThreshold() {
  return shared(ALERT_KEY)?.threshold ?? DEFAULT_THRESHOLD;
}

export function lowQuotaNotifications(snapshot, settings, now = Date.now()) {
  const threshold = settings.threshold ?? DEFAULT_THRESHOLD;
  const previous = new Set(settings.alerted ?? []);
  const alerted = [];
  const warnings = [];
  for (const period of remainingQuota(snapshot, now)) {
    if (period.percent >= threshold) continue;
    const key = period.name + ":" + (period.resets ?? "");
    alerted.push(key);
    if (!previous.has(key)) warnings.push(period);
  }
  return { alerted, warnings };
}

export function checkQuotaAlerts(snapshot) {
  if (snapshot?.source !== "account" || Date.now() - snapshot.captured > 180000) return;
  const settings = shared(ALERT_KEY) ?? {};
  const threshold = settings.threshold ?? DEFAULT_THRESHOLD;
  const { alerted, warnings } = lowQuotaNotifications(snapshot, settings);
  if (JSON.stringify(alerted) !== JSON.stringify(settings.alerted ?? [])) {
    setShared(ALERT_KEY, { ...settings, alerted });
  }
  if (!warnings.length) return;
  const limits = warnings.map(bucket => bucket.name + " · " + bucket.percent + tr(" % restante"));
  notify({
    title: tr("Cuota baja de Codex"),
    body: limits.join("\n") + tr("\nUmbral de aviso · ") + threshold + " %",
    level: "warning"
  });
}

function action(id, label, t, callback, primary = false) {
  return Button.new(id).px(10).h(29).rounded(3).cursor_pointer().text_size(12).font_medium()
    .flex().items_center().justify_center()
    .text_color(primary ? t.foreground : t.muted)
    .when(primary, el => el.border(1).border_color(t.border).bg(t.raised))
    .hover(el => el.bg(t.hover)).on_click(callback).child(label);
}

export class QuotaAlertSettings {
  constructor(overlay) {
    this.overlay = overlay;
    this.input = InputState.new({ value: String(quotaThreshold()) });
    this.input.on("submit", (_event, cx) => this.save(cx));
    this.input.on("change", (_event, cx) => {
      if (!this.error) return;
      this.error = "";
      cx.notify();
    });
  }

  save(cx) {
    const text = this.input.value().trim();
    const threshold = Number(text);
    if (!/^\d{1,3}$/.test(text) || threshold > 100) {
      this.error = tr("Escribe un número entero entre 0 y 100.");
      cx.notify();
      return;
    }
    const settings = shared(ALERT_KEY) ?? {};
    setShared(ALERT_KEY, { ...settings, threshold, alerted: threshold ? settings.alerted ?? [] : [] });
    checkQuotaAlerts(shared(QUOTA_KEY));
    closeOverlay(this.overlay);
  }

  close() {
    this.input.release();
  }

  render(t) {
    return v_flex().id("ajustes-aviso-cuota").size_full().min_h(0).p(16).gap(10)
      .bg(t.popover).text_color(t.foreground)
      .child(div().text_size(16).font_semibold().child(tr("Aviso de cuota")))
      .child(v_flex().pt(9).gap(6).border_t(1).border_color(t.border)
        .child(h_flex().items_center().gap(6)
          .child(div().flex_1().text_size(12).font_medium().child(tr("Avisarme al bajar de")))
          .child(Input.new(this.input).w(59).h(29).px(7).rounded(3).border(1).border_color(this.error ? t.blocked : t.input)
            .bg(t.background).text_color(t.foreground).accessibility_label(tr("Umbral del aviso de cuota")))
          .child(div().text_size(11.5).text_color(t.muted).child(tr("% restante"))))
        .child(div().text_size(11).text_color(this.error ? t.blocked : t.muted).child(this.error || tr("0 desactiva el aviso."))))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8)
        .child(action("cerrar-aviso-cuota", tr("Cancelar"), t, () => closeOverlay(this.overlay)))
        .child(action("guardar-aviso-cuota", tr("Guardar"), t, (_event, cx) => this.save(cx), true)));
  }
}
