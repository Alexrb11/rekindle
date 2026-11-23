import { tr } from "./i18n.js";
import { View, div, svg } from "gpui-kit";
import { Button, Editor, EditorState, TextView, h_flex, v_flex } from "gpui-base";
import { appHome, closeOverlay, exec, props, setShared, shared, theme } from "herdr";

const REVIEWS_KEY = "rekindle.reviews";
const TEST_LABELS = { passed: tr("Correcto"), failed: tr("Falló"), unknown: tr("Resultado sin confirmar") };

function icon(name, size = 14) {
  return svg("mods/workspace-chrome/" + name + ".svg").size(size).flex_none();
}

function button(id, label, t, handler, { primary = false, enabled = true, selected = false, glyph } = {}) {
  return Button.new(id).disabled(!enabled).selected(selected).flex_none().h(28).px(8).rounded(3).text_size(12).font_medium()
    .flex().items_center().gap(6).text_color(enabled ? t.foreground : t.dim)
    .when(primary, el => el.border(1).border_color(t.border).bg(t.raised))
    .when(enabled, el => el.cursor_pointer().hover(node => node.bg(t.hover)).on_click(handler))
    .when(Boolean(glyph), el => el.child(icon(glyph, 13)))
    .child(label);
}

function heading(title, t, count = 0) {
  return h_flex().gap(6).items_center()
    .child(div().text_size(12).font_semibold().text_color(t.foreground).child(title))
    .when(count > 0, el => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
}

function displayPath(file, cwd) {
  const path = file.replace(/\\/g, "/");
  const folder = cwd?.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return cwd && path.toLowerCase().startsWith(folder.toLowerCase()) ? path.slice(folder.length) : path;
}

function deliveryTitle(item) {
  return item.summary?.split(/\r?\n/).map(line => line.replace(/^\s*[#>*-]+\s*/, "").replace(/\*\*/g, "").trim())
    .find(Boolean) || item.agent;
}

export default class Deliveries extends View {
  init() {
    this.overlay = props()?.overlay;
    this.reviewed = false;
  }

  close() {
    this.patch?.editor?.release();
    this.patch = null;
  }

  closeDiff(cx) {
    this.close();
    cx.notify();
  }

  changeReviewed(id, reviewed, cx) {
    const state = shared(REVIEWS_KEY);
    if (!state?.items?.some(item => item.id === id)) return;
    setShared(REVIEWS_KEY, {
      ...state,
      items: state.items.map(item => item.id === id ? { ...item, reviewed } : item)
    });
    cx.notify();
  }

  openDiff(delivery, cx) {
    if (this.patch) return;
    const patch = { delivery, loading: true };
    this.patch = patch;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const query = encodeURIComponent(JSON.stringify({
          session: delivery.session, turn: delivery.turn, cwd: delivery.cwd
        }));
        const script = appHome() + "/mods/rekindle-status/codex-usage.ps1";
        const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script,
          "-Operation", "diff", "-ReviewSpec", query], { timeout: 23000 });
        if (this.patch !== patch) return;
        if (result.code !== 0) throw new Error(tr("No se pudo recuperar el diff."));
        const diff = JSON.parse(result.stdout);
        if (diff?.text) {
          patch.title = diff.title;
          patch.truncated = diff.truncated;
          patch.editor = EditorState.new({ value: diff.text, language: "diff", readonly: true });
        } else {
          patch.message = tr("No hay diferencias disponibles para esta entrega.");
        }
      } catch (error) {
        patch.message = error.message || tr("No se pudo abrir el diff.");
      } finally {
        patch.loading = false;
        if (this.patch === patch) cx.notify();
      }
    });
  }

  diffView(t) {
    const patch = this.patch;
    return v_flex().flex_1().min_h(0).gap(9)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(button("volver-a-entrega", tr("Volver a la entrega"), t, (_event, cx) => this.closeDiff(cx), { glyph: "chevron-left" }))
        .child(div().text_size(13).font_semibold().child(patch.title || tr("Diff de la entrega"))))
      .when(patch.truncated, el => el.child(div().text_size(11).text_color(t.muted).child(tr("Vista previa recortada."))))
      .when(Boolean(patch.editor), el => el.child(div().flex_1().min_h(0).overflow_hidden()
        .border(1).border_color(t.border).child(Editor.new(patch.editor).size_full())))
      .when(!patch.editor, el => el.child(div().py(12).text_size(12).text_color(t.muted)
        .child(patch.loading ? tr("Abriendo diff…") : patch.message)));
  }

  deliveryView(item, t) {
    const files = item.files ?? [];
    const tests = item.tests ?? [];
    return v_flex().flex_1().min_w(0).min_h(0).gap(11)
      .child(v_flex().flex_none().gap(2)
        .child(div().text_size(15).font_semibold().truncate().tooltip(item.agent).child(item.agent))
        .child(div().text_size(11.5).text_color(t.muted).truncate()
          .child([item.project || item.cwd, new Date(item.time).toLocaleString()].filter(Boolean).join(" · "))))
      .child(v_flex().id("detalle-entrega").flex_1().min_h(0).overflow_y_scrollbar().pr(6).gap(12)
        .child(v_flex().flex_none().gap(5)
          .child(heading(tr("Resumen"), t))
          .child(TextView.markdown("resumen-" + item.id, item.summary || tr("Sin resumen registrado."))
            .scrollable(false).selectable(true).w_full().min_w(0).text_size(12.5)))
        .child(v_flex().flex_none().pt(9).gap(5).border_t(1).border_color(t.border)
          .child(heading(item.filesSource === "worktree" ? tr("Archivos del worktree") : tr("Archivos modificados"), t, files.length))
          .children(files.map(file => div().min_w(0).text_size(12).truncate().tooltip(file).child(displayPath(file, item.cwd))))
          .when(!files.length, el => el.child(div().text_size(12).text_color(t.dim).child(tr("Sin cambios registrados.")))))
        .child(v_flex().flex_none().pt(9).gap(5).border_t(1).border_color(t.border)
          .child(heading(tr("Pruebas"), t, tests.length))
          .children(tests.map(test => h_flex().gap(8).justify_between().items_center()
            .child(div().min_w(0).text_size(12).truncate().child(test.label))
            .child(div().flex_none().text_size(11)
              .text_color(test.result === "passed" ? t.done : test.result === "failed" ? t.blocked : t.muted)
              .child(TEST_LABELS[test.result] + (test.result === "failed" ? tr(" · código ") + test.code : "")))))
          .when(!tests.length, el => el.child(div().text_size(12).text_color(t.dim).child(tr("Sin pruebas registradas."))))))
      .child(h_flex().flex_none().justify_end().gap(8).pt(9).border_t(1).border_color(t.border)
        .child(button("abrir-diff-entrega", tr("Abrir diff"), t, (_event, cx) => this.openDiff(item, cx),
          { enabled: files.length > 0 }))
        .child(button("marcar-entrega", item.reviewed ? tr("Volver a pendientes") : tr("Marcar revisada"), t,
          (_event, cx) => this.changeReviewed(item.id, !item.reviewed, cx), { primary: true })));
  }

  render() {
    const t = theme();
    const all = shared(REVIEWS_KEY)?.items ?? [];
    const items = all.filter(item => Boolean(item.reviewed) === this.reviewed);
    const selected = items.find(item => item.id === this.selectedId) ?? items[0];
    const pending = all.length - all.filter(item => item.reviewed).length;
    const tabs = h_flex().flex_none().gap(6).border_b(1).border_color(t.border)
      .children([
        ["pendientes", tr("Pendientes") + (pending ? " (" + pending + ")" : ""), false],
        ["revisadas", tr("Revisadas"), true]
      ].map(([id, label, reviewed]) => {
        const active = this.reviewed === reviewed;
        return button("entregas-" + id, label, t, (_event, cx) => { this.reviewed = reviewed; cx.notify(); }, { selected: active })
          .rounded(0).border_b(1).border_color(active ? t.accent : t.popover).text_color(active ? t.foreground : t.muted);
      }));
    const list = v_flex().id("lista-entregas").w(218).flex_none().min_h(0).overflow_y_scrollbar().pr(8)
      .border_r(1).border_color(t.border)
      .children(items.map(item => {
        const active = selected?.id === item.id;
        const title = deliveryTitle(item);
        return Button.new("entrega-" + item.id).selected(active)
          .flex().flex_col().items_start().w_full().flex_none().min_w(0).gap(2).px(8).py(6)
          .border_l(2).border_color(active ? t.accent : t.popover).when(active, el => el.bg(t.surface))
          .hover(el => el.bg(t.hover)).cursor_pointer()
          .on_click((_event, cx) => { this.selectedId = item.id; cx.notify(); })
          .tooltip(title)
          .child(div().w_full().min_w(0).text_size(12).font_medium().truncate().child(title))
          .child(div().w_full().min_w(0).text_size(10.5).text_color(t.muted).truncate()
            .child([item.agent, item.project].filter(Boolean).join(" · ") || new Date(item.time).toLocaleString()));
      }));
    const body = selected ? h_flex().items_stretch().flex_1().min_h(0).gap(13).child(list).child(this.deliveryView(selected, t))
      : div().py(8).text_size(12).text_color(t.muted)
        .child(this.reviewed ? tr("No hay entregas revisadas.") : tr("No hay entregas pendientes."));
    return v_flex().id("rekindle-deliveries").size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().justify_between().items_center()
        .child(div().text_size(17).font_semibold().child(tr("Entregas")))
        .child(button("cerrar-entregas", "", t, () => closeOverlay(this.overlay), { glyph: "x" })
          .size(28).px(0).justify_center().tooltip(tr("Cerrar")).accessibility_label(tr("Cerrar Entregas"))))
      .when(Boolean(this.patch), el => el.child(div().h(1).flex_none().bg(t.border)))
      .when(!this.patch, el => el.child(tabs))
      .child(this.patch ? this.diffView(t) : body);
  }
}
