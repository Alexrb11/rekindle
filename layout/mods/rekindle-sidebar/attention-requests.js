import { tr } from "./i18n.js";
import { div } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { hc, run, terminals } from "herdr";
import { attentionPrompt, pendingReport, promptStamp } from "./attention-prompt.js";
import { showError } from "./errors.js";

async function coreJson(args) {
  const result = await hc(args);
  if (result.code === 0) return JSON.parse(result.stdout);
  const output = result.stderr.trim() || result.stdout.trim();
  let message = output;
  try { message = JSON.parse(output).error?.message ?? output; } catch {}
  throw new Error(message || tr("Herdr Core devolvió el código ") + result.code + ".");
}

async function readPrompt(address, report) {
  if (report.kind === "auth") return attentionPrompt(report);
  const screen = await coreJson(["read", "--json", "--lines", "0", address]);
  return attentionPrompt(report, screen.complete && typeof screen.text === "string" ? screen.text : "");
}

function statusTime(terminal) {
  const time = terminal?.status_ms;
  return Number.isFinite(time) && time > 0 ? time : null;
}

function waitingLabel(since) {
  const minutes = Math.max(0, Math.floor((Date.now() - since) / 60000));
  return minutes ? minutes + " min" : tr("Ahora");
}

async function readRequest(address) {
  // The app's terminal list can omit status_ms. Capture the request and validate
  // its reply using the same full Herdr Core status.
  const terminal = await coreJson(["get", "--json", address]);
  const report = pendingReport(terminal);
  if (!report) return null;
  const prompt = await readPrompt(address, report);
  return { prompt, since: statusTime(terminal), key: JSON.stringify([promptStamp(terminal, report), prompt]) };
}

function choiceButton(id, label, t, enabled, action) {
  return Button.new(id).disabled(!enabled).min_w(0).min_h(26).px(8).py(4).rounded(3)
    .border(1).border_color(t.border).text_size(12).font_medium()
    .text_color(enabled ? t.foreground : t.dim)
    .accessibility_label(label)
    .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_event, cx) => {
      cx.stop_propagation();
      action(cx);
    }))
    .child(label);
}

export class AttentionRequests {
  entries = new Map();

  close() {
    this.entries.clear();
  }

  since(terminal) {
    return this.entries.get(terminal?.address)?.since ?? statusTime(terminal);
  }

  refresh(cx) {
    const waiting = new Set();
    for (const terminal of terminals()) {
      const report = pendingReport(terminal);
      if (!report) continue;
      const address = terminal.address;
      const viewStamp = promptStamp(terminal, report);
      waiting.add(address);
      let entry = this.entries.get(address);
      if (entry?.viewStamp !== viewStamp) {
        entry = { viewStamp, since: statusTime(terminal) ?? Date.now() };
        this.entries.set(address, entry);
      }
      if (entry.reading || entry.sending) continue;
      entry.reading = true;
      cx.spawn(async cx => {
        let request;
        try {
          request = await readRequest(address);
        } catch {
          const prompt = attentionPrompt(report);
          request = { prompt, key: JSON.stringify([null, prompt]) };
        } finally {
          entry.reading = false;
        }
        if (this.entries.get(address) !== entry) return;
        const since = request?.since ?? entry.since;
        if (entry.request === undefined || entry.request?.key !== request?.key || entry.since !== since) {
          entry.request = request;
          entry.since = since;
          cx.notify();
        }
      });
    }
    for (const address of this.entries.keys()) {
      if (!waiting.has(address)) this.entries.delete(address);
    }
  }

  answer(address, expected, key, index, cx) {
    const entry = this.entries.get(address);
    if (!entry || entry !== expected || entry.request?.key !== key || entry.sending || entry.sent === key
      || !entry.request?.prompt.options[index]?.keys.length) return;
    entry.sending = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const request = await readRequest(address);
        if (!request) throw new Error(tr("La solicitud ya se resolvió en la terminal."));
        if (request.key !== key || this.entries.get(address) !== entry) {
          throw new Error(tr("La solicitud cambió en la terminal."));
        }
        await coreJson(["keys", "--json", address, ...request.prompt.options[index].keys]);
        entry.sent = key;
      } catch (error) {
        if (this.entries.get(address) === entry) {
          showError(tr("No se pudo enviar la respuesta"), tr("Revisa la solicitud actual del agente y elige una opción."), error);
        }
      } finally {
        entry.sending = false;
        if (this.entries.get(address) === entry) {
          this.refresh(cx);
          cx.notify();
        }
      }
    });
  }

  card(agent, terminal, t) {
    const report = pendingReport(terminal);
    if (!report) return null;
    const address = agent.address;
    const entry = this.entries.get(address);
    const current = entry?.viewStamp === promptStamp(terminal, report) ? entry : null;
    const request = current?.request;
    if (request === null) return null;
    const prompt = request?.prompt;
    const key = request?.key;
    const sent = Boolean(prompt && current.sent === key);
    const open = () => run(agent.detached ? "terminal.peek" : "agent.focus", { terminal: address });
    const button = (option, i) => choiceButton("respuesta-" + address + "-" + i, tr(option.label), t, !current.sending && !sent,
      cx => option.keys.length ? this.answer(address, current, key, i, cx) : open())
      .when(Boolean(prompt.compact), el => el.flex_1().text_center());
    const choices = prompt?.compact ? h_flex() : v_flex();
    const kind = { permission: tr("Permiso"), question: tr("Pregunta"), auth: tr("Autenticación") }[report.kind] ?? tr("Atención");
    return v_flex().id("solicitud-" + address).min_w(0).flex_none().pl(8).pr(4).py(5).gap(5)
      .border_l(1).border_color(t.blocked)
      .child(h_flex().gap(6).items_center().justify_between()
        .child(div().text_size(10.8).font_semibold().text_color(t.blocked).child(kind + (prompt?.progress ? " " + prompt.progress : "")))
        .when(Boolean(current), el => el.child(div().flex_none().text_size(10.5).text_color(t.muted).child(waitingLabel(current.since)))))
      .child(div().min_w(0).text_size(12).font_medium().text_color(t.foreground)
        .child(tr(prompt?.question ?? "Cargando solicitud…")))
      .when(Boolean(prompt?.details), el => el.child(div().id("detalle-" + address).max_h(76).overflow_y_scrollbar()
        .pr(4).text_size(11).text_color(t.muted).child(prompt.details)))
      .when(Boolean(prompt?.options.length), el => el.child(choices.gap(5).children(prompt.options.map(button))))
      .when(Boolean(prompt && (current.sending || sent)), el => el.child(div().text_size(11).text_color(t.muted)
        .child(sent ? tr("Respuesta enviada") : tr("Enviando respuesta…"))))
      .when(Boolean(prompt && !prompt.options.length), el => el.child(choiceButton("abrir-solicitud-" + address, tr("Abrir terminal"), t, true, open)));
  }
}
