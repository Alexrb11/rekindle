import { tr } from "./i18n.js";
import { View, div, svg } from "gpui-kit";
import { Button, h_flex } from "gpui-base";
import { agents, appHome, checking, exec, keys, nextCommand, openOverlay, props, run, setShared, shared, spaces, terminals, theme, window } from "herdr";
import { codexTerminalRequests, QUOTA_KEY, remainingQuota, usageSnapshot, USAGE_KEY } from "./usage.js";
import { checkQuotaAlerts, QuotaAlertSettings, quotaThreshold } from "./quota-alerts.js";
import { REVIEWS_KEY, reviewRequest, reviewState } from "./reviews.js";

const WEEKLY_BAR_WIDTH = 56;
const PREFERENCES = "rekindle.preferences";
const DEFAULT_QUOTA_REFRESH_MS = 30_000;

function quotaRefreshInterval() {
  const interval = shared(PREFERENCES)?.quotaRefreshMs;
  return [0, 60_000, 120_000].includes(interval) ? interval : DEFAULT_QUOTA_REFRESH_MS;
}

export default class RekindleStatus extends View {
  init(_props, cx) {
    const options = props();
    if (options?.quotaAlerts) {
      this.alertSettings = new QuotaAlertSettings(options.overlay);
      return;
    }
    if (checking() || window()?.platform !== "windows") return;
    this.reviewSince = Date.now();
    this.alertThreshold = quotaThreshold();
    this.refreshUsage(cx);
    this.pollQuota(cx);
    cx.timer.every(12000, cx => this.refreshUsage(cx));
    cx.timer.every(1000, cx => this.pollQuota(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh-quota") this.refreshQuota(cx);
      }
    });
  }

  close() {
    this.alertSettings?.close();
  }

  pollQuota(cx) {
    const threshold = quotaThreshold();
    if (threshold !== this.alertThreshold) {
      this.alertThreshold = threshold;
      checkQuotaAlerts(shared(QUOTA_KEY));
    }
    const interval = quotaRefreshInterval();
    if (interval && Date.now() - (this.lastQuotaRequest ?? -Infinity) >= interval) this.refreshQuota(cx);
  }

  async readUsage(operation, args = []) {
    const script = appHome() + "/mods/rekindle-status/codex-usage.ps1";
    const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Operation", operation, ...args],
      { timeout: 23000 });
    if (result.code !== 0) return null;
    return JSON.parse(result.stdout);
  }

  refreshUsage(cx) {
    if (this.readingUsage) return;
    this.readingUsage = true;
    cx.spawn(async cx => {
      try {
        const liveTerminals = terminals();
        const liveAgents = agents();
        const requests = codexTerminalRequests(liveTerminals, liveAgents);
        const payload = encodeURIComponent(JSON.stringify(requests));
        const reviewInput = reviewRequest(shared(REVIEWS_KEY), this.reviewSince);
        const report = await this.readUsage("usage", [
          "-TerminalList", payload, "-ReviewSpec", encodeURIComponent(JSON.stringify(reviewInput))
        ]);
        if (!report) return;
        const snapshot = usageSnapshot(report, spaces(), requests);
        const serialized = JSON.stringify(snapshot);
        if (serialized !== this.lastUsage) {
          setShared(USAGE_KEY, snapshot);
          this.lastUsage = serialized;
        }
        const saved = shared(REVIEWS_KEY);
        const reviews = reviewState(saved, report, this.reviewSince, spaces(), liveAgents, liveTerminals);
        if (JSON.stringify(reviews) !== JSON.stringify(saved)) setShared(REVIEWS_KEY, reviews);
        this.historyQuota = report.quota;
      } catch {} finally {
        this.readingUsage = false;
        cx.notify();
      }
    });
  }

  refreshQuota(cx) {
    if (this.readingQuota) return;
    this.readingQuota = true;
    this.lastQuotaRequest = Date.now();
    cx.notify();
    cx.spawn(async cx => {
      try {
        const snapshot = await this.readUsage("quota");
        if (snapshot?.windows?.length) {
          setShared(QUOTA_KEY, snapshot);
          checkQuotaAlerts(snapshot);
        }
      } catch {} finally {
        this.readingQuota = false;
        cx.notify();
      }
    });
  }

  quotaIndicator(t, showWeekly) {
    const account = shared(QUOTA_KEY);
    const history = quotaRefreshInterval() === 0 ? null : this.historyQuota;
    const now = Date.now();
    const freshAccount = now - account?.captured < 180000 && remainingQuota(account, now).length;
    const snapshot = freshAccount ? account : [account, history].filter(value => remainingQuota(value, now).length)
      .sort((a, b) => b.captured - a.captured)[0];
    const weekly = tr("Semanal");
    const windows = remainingQuota(snapshot, now).filter(bucket => showWeekly || bucket.name !== weekly);
    if (!showWeekly && !windows.length) return null;
    const lines = windows.map(bucket => {
      const reset = Number.isFinite(bucket.resets) && bucket.resets > 0
        ? tr(" · se restablece ") + new Date(bucket.resets * 1000).toLocaleString() : "";
      return bucket.name + " · " + bucket.percent + tr(" % restante") + reset;
    });
    if (snapshot) {
      const label = freshAccount ? tr("Lectura de la cuenta") : tr("Última lectura disponible");
      lines.push(label + " · " + new Date(snapshot.captured).toLocaleString());
    }
    lines.push(tr("Pulsa para actualizar"));
    const labels = windows.map(bucket => bucket.name + " " + bucket.percent + " %");
    const status = labels.length ? labels.join(" · ")
      : this.readingQuota ? tr("Consultando…") : tr("Sin datos");
    const periods = h_flex().min_w(0).gap(6).items_center().children(windows.map((bucket, index) =>
      h_flex().min_w(0).gap(6).items_center()
        .when(index > 0, el => el.child(div().flex_none().child("·")))
        .child(div().min_w(0).truncate().child(bucket.name))
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(bucket.percent + " %"))
        .when(bucket.name === weekly, el => el.child(div().id("rekindle-cuota-semanal-" + index)
          .flex_none().w(WEEKLY_BAR_WIDTH).h(4).bg(t.input).overflow_hidden()
          .when(bucket.percent > 0, bar => bar.child(div().w(WEEKLY_BAR_WIDTH * bucket.percent / 100)
            .h_full().bg(t.muted)))))));
    return Button.new("rekindle-cuota-codex").h(23).px(4).min_w(0).gap(6).flex().items_center().rounded(3).cursor_pointer()
      .hover(el => el.bg(t.hover)).on_click((_event, cx) => this.refreshQuota(cx))
      .tooltip(lines.join("\n")).accessibility_label(tr("Uso restante de Codex. ") + status)
      .child(div().flex_none().text_color(t.dim).child(tr("Codex restante")))
      .child(windows.length ? periods : div().min_w(0).truncate().child(status));
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : tr("Mayús+"), alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ?? "";
  }

  render() {
    const t = theme();
    if (this.alertSettings) return this.alertSettings.render(t);
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const showWeekly = shared(PREFERENCES)?.showWeeklyQuota !== false;
    const quota = window()?.platform === "windows" ? this.quotaIndicator(t, showWeekly) : null;
    const threshold = quotaThreshold();
    const commandKey = this.hint();
    const label = (icon, text) => h_flex().min_w(0).gap(5).items_center()
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(12).flex_none().text_color(t.dim))
      .child(div().min_w(0).max_w(120).truncate().tooltip(text).child(text));
    return h_flex().size_full().min_w(0).px(10).gap(12).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "Local"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().flex_none().gap(5).items_center()
        .child(list.length + (list.length === 1 ? tr(" agente") : tr(" agentes")))
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(needs === 1 ? tr("· 1 pendiente") : "· " + needs + tr(" pendientes")))))
      .child(div().flex_1().min_w(0))
      .when(Boolean(quota), el => el.child(h_flex().min_w(0).gap(2).items_center()
        .child(quota)
        .child(Button.new("configurar-aviso-cuota").size(22).flex_none().flex().items_center().justify_center()
          .rounded(3).cursor_pointer().hover(button => button.bg(t.hover).text_color(t.foreground))
          .tooltip(threshold ? tr("Configurar aviso de cuota baja · umbral ") + threshold + " %" : tr("Configurar aviso de cuota baja"))
          .accessibility_label(tr("Configurar aviso de cuota baja"))
          .on_click(() => openOverlay({ mod: "rekindle-status", kind: "dialog", width: 390, height: 200, props: { quotaAlerts: true } }))
          .child(svg("mods/workspace-chrome/settings.svg").size(13)))))
      .child(Button.new("palette").flex_none().px(4).h(23).rounded(3).text_color(t.dim).cursor_pointer()
        .hover(el => el.bg(t.hover).text_color(t.foreground)).tooltip(tr("Paleta de comandos") + (commandKey ? " · " + commandKey : ""))
        .on_click(() => run("app.palette")).child(tr("Comandos")));
  }
}
