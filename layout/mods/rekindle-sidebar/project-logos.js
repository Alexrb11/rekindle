import { tr } from "./i18n.js";
import { div, image } from "gpui-kit";
import { Button, h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, closeOverlay, exec, props, setShared, shared, spaces, theme, window } from "herdr";
import { mkdir, readFile, unlink } from "fs/promises";
import { showError } from "./errors.js";
import { pickExplorerFiles } from "./file-picker.js";
import { SPRITES } from "./skill-sprites.js";

export const DEFAULT_PROJECT_SPRITE = "mods/rekindle-sidebar/art/project.png";
const LOGO_DIR = "data/rekindle/logos";
const LOGO_STATE = "rekindle.project-logos";
const COLOR_STATE = "rekindle.project-sprite-colors";
const LOGO_PATH = /^data\/rekindle\/logos\/[a-z0-9-]+\.(?:png|jpg|webp|svg)$/;
const MAX_LOGO_BYTES = 8 * 1024 * 1024;
const PALETTE = SPRITES.map(({ id, name, color }, index) => ({
  id, name, color,
  path: index === 0 ? DEFAULT_PROJECT_SPRITE : "mods/rekindle-sidebar/art/project-" + id + ".svg"
}));

export function projectLogo(spaceId) {
  const path = shared(LOGO_STATE)?.[spaceId];
  return typeof path === "string" && LOGO_PATH.test(path) ? path : null;
}

export function projectSprite(spaceId) {
  const id = shared(COLOR_STATE)?.[spaceId];
  return PALETTE.find(color => color.id === id) ?? null;
}

function setProjectLogo(spaceId, path) {
  const logos = { ...shared(LOGO_STATE) };
  if (path) logos[spaceId] = path;
  else delete logos[spaceId];
  setShared(LOGO_STATE, logos);
}

function hasImageSignature(ext, bytes) {
  switch (ext) {
    case "png":
      return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
    case "jpg":
      return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case "webp":
      return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
        && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    case "svg":
      return /^\s*(?:(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]/i.test(new TextDecoder().decode(bytes));
    default:
      return false;
  }
}

async function copyLogo(source, destination, bytes) {
  let copied = false;
  try {
    // Herdr 0.1.16 can truncate binary writes. Copy the native file and verify the bytes before using it.
    let result;
    if (window()?.platform === "windows") {
      // URI-encode the paths so the shell only ever sees literal data.
      const args = [source, destination].map(path => "[Uri]::UnescapeDataString('" + encodeURIComponent(path).replace(/'/g, "%27") + "')");
      const command = "$ErrorActionPreference = 'Stop'; "
        + "[IO.File]::Copy(" + args.join(", ") + ")";
      result = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command]);
    } else {
      result = await exec("cp", [source, destination]);
    }
    if (result.code !== 0) {
      throw new Error(tr("No se pudo guardar la copia del logo."), { cause: result.stderr.trim() || tr("Código de salida ") + result.code });
    }
    copied = true;
    const saved = await readFile(destination);
    if (saved.length !== bytes.length || !saved.every((byte, index) => byte === bytes[index])) {
      throw new Error(tr("La imagen cambió al copiarla. Vuelve a seleccionarla."));
    }
  } catch (error) {
    if (copied) {
      try { await unlink(destination); } catch {}
    }
    throw error;
  }
}

async function importLogo(rawPath) {
  const path = rawPath.trim().replace(/^"(.+)"$/, "$1");
  const extension = path.match(/\.(png|jpe?g|webp|svg)$/i)?.[1]?.toLowerCase();
  if (!path || !extension) throw new Error(tr("Selecciona una imagen PNG, JPG, WebP o SVG."));
  if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) throw new Error(tr("Escribe la ruta completa del archivo."));
  const ext = extension === "jpeg" ? "jpg" : extension;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(tr("Comprueba que la imagen siga en esa ruta y que puedas abrirla."), { cause: error });
  }
  if (bytes.length > MAX_LOGO_BYTES) throw new Error(tr("La imagen supera el límite de 8 MB."));
  if (!hasImageSignature(ext, bytes)) throw new Error(tr("El contenido del archivo no coincide con su formato de imagen."));
  // A fresh path lets Herdr see a replacement without reusing its cached image.
  const relative = LOGO_DIR + "/" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "." + ext;
  const root = appHome();
  try {
    await mkdir(root + "/" + LOGO_DIR, { recursive: true });
    await copyLogo(path, root + "/" + relative, bytes);
  } catch (error) {
    throw new Error(tr("No se pudo guardar la vista previa. Vuelve a seleccionar la imagen y comprueba que Herdr pueda escribir en data/rekindle/logos."), {
      cause: error.cause ?? error
    });
  }
  return relative;
}

async function discardLogoDraft(path) {
  if (!path || !LOGO_PATH.test(path)) return;
  try { await unlink(appHome() + "/" + path); } catch {}
}

function button(id, title, t, action, { primary = false, disabled = false } = {}) {
  return Button.new(id).disabled(disabled).h(29).px(8).flex().items_center().justify_center().flex_none().rounded(3)
    .text_size(12).font_medium().text_color(disabled ? t.dim : t.foreground)
    .when(primary, el => el.border(1).border_color(t.border).when(!disabled, el => el.bg(t.raised)))
    .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click(action))
    .child(title);
}

export class ProjectLogoEditor {
  constructor(spaceId, cx) {
    this.spaceId = spaceId;
    this.pathInput = InputState.new({ placeholder: tr("Pega una ruta y pulsa Intro") });
    this.pathInput.on("submit", (_event, cx) => this.load(() => this.pathInput.value(), cx));
    this.pathInput.on("change", (_event, cx) => {
      if (!this.phase) {
        this.message = "";
      }
      cx.notify();
    });
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  project() {
    return spaces().find(space => space.id === this.spaceId);
  }

  preview() {
    return this.pending?.source === this.pathInput.value().trim() ? this.pending : null;
  }

  async close() {
    this.closed = true;
    const pending = this.pending;
    this.pending = null;
    await discardLogoDraft(pending?.path);
  }

  choose(cx) {
    this.load(async () => {
      const project = this.project();
      const folders = project?.folder && !project.machine ? [project.folder] : [];
      const files = await pickExplorerFiles("logo", folders);
      return files[0] ?? null;
    }, cx);
  }

  load(getPath, cx) {
    if (this.phase || this.closed || !this.project()) return;
    this.phase = "selecting";
    this.message = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const selected = await getPath();
        if (selected === null || this.closed) return;
        const source = selected.trim();
        this.phase = "loading";
        if (!this.project()) throw new Error(tr("El proyecto se cerró. Vuelve a abrir su editor de logo."));
        if (!source) throw new Error(tr("Pega la ruta completa de una imagen."));
        cx.notify();
        const path = await importLogo(source);
        if (this.closed || !this.project()) {
          await discardLogoDraft(path);
          if (this.closed) return;
          throw new Error(tr("El proyecto se cerró. Vuelve a abrir su editor de logo."));
        }
        const previous = this.pending;
        this.pending = { path, source };
        this.pathInput.set_value(source);
        await discardLogoDraft(previous?.path);
      } catch (error) {
        if (!this.closed) {
          const title = this.phase === "selecting" ? tr("No se pudo elegir la imagen") : tr("No se pudo cargar la imagen");
          showError(title, error.message, error.cause);
        }
      } finally {
        this.phase = null;
        cx.notify();
      }
    });
  }

  useImage(cx) {
    const preview = this.preview();
    if (this.phase || !preview || !this.project()) return;
    try {
      setProjectLogo(this.spaceId, preview.path);
    } catch (error) {
      showError(tr("No se pudo aplicar el logo"), tr("La vista previa sigue disponible. Pulsa Usar imagen para intentarlo de nuevo."), error);
      return;
    }
    this.pending = null;
    this.pathInput.set_value("");
    this.message = tr("Logo guardado");
    cx.notify();
  }

  useSprite(id, cx) {
    if (this.phase || this.closed || !this.project() || this.preview() || projectLogo(this.spaceId)) return;
    if (!PALETTE.some(color => color.id === id)) return;
    const colors = shared(COLOR_STATE) ?? {};
    if (colors[this.spaceId] === id) return;
    try {
      setShared(COLOR_STATE, { ...colors, [this.spaceId]: id });
    } catch (error) {
      showError(tr("No se pudo guardar el color"), tr("Vuelve a seleccionar el color del sprite."), error);
      return;
    }
    this.message = "";
    cx.notify();
  }

  restore(cx) {
    if (this.phase || !this.project()) return;
    try {
      setProjectLogo(this.spaceId, null);
    } catch (error) {
      showError(tr("No se pudo restaurar el sprite"), tr("Vuelve a pulsar Volver al sprite para intentarlo de nuevo."), error);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    this.pathInput.set_value("");
    if (pending) cx.spawn(() => discardLogoDraft(pending.path));
    this.message = tr("Sprite restaurado");
    cx.notify();
  }

  palette(selected, t, busy) {
    return h_flex().gap(5).children(PALETTE.map(color => Button.new("color-proyecto-" + color.id)
      .selected(color.id === selected).disabled(busy).size(24).flex_none().rounded(3)
      .border(1).border_color(color.id === selected ? t.foreground : t.popover)
      .flex().items_center().justify_center().tooltip(tr(color.name)).accessibility_label(tr(color.name))
      .when(!busy, el => el.cursor_pointer().hover(el => el.border_color(t.muted))
        .on_click((_event, cx) => this.useSprite(color.id, cx)))
      .child(div().size(13).rounded_full().bg(color.color))));
  }

  render() {
    const t = theme();
    const project = this.project();
    const customLogo = projectLogo(this.spaceId);
    const preview = this.preview();
    const sprite = projectSprite(this.spaceId) ?? PALETTE[0];
    const showingSprite = !preview && !customLogo;
    const busy = Boolean(this.phase);
    const windows = window()?.platform === "windows";
    const root = v_flex().id("editor-logo-proyecto").track_focus(this.handle).size_full().min_h(0).p(16).gap(9).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().items_center().gap(8)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(16).font_semibold().child(tr("Logo del proyecto")))
          .child(div().text_size(12).truncate().text_color(t.muted).child(project?.name ?? tr("Proyecto cerrado"))))
        .child(button("cerrar-logo", "×", t, () => closeOverlay(props()?.overlay)).size(28).px(0).text_size(17).accessibility_label(tr("Cerrar"))));
    if (!project) return root;
    return root
      .child(h_flex().id("soltar-logo").flex_none().min_w(0).h(76).gap(14).items_center()
        .border_t(1).border_color(t.border)
        .tooltip(tr("Suelta una imagen aquí para previsualizarla"))
        .on_drop((event, cx) => {
          if (event.paths?.length) this.load(() => event.paths[0], cx);
        })
        .child(image(preview?.path ?? customLogo ?? sprite.path).size(56).flex_none())
        .child(v_flex().flex_1().min_w(0).gap(5)
          .child(div().text_size(12).font_medium().child(showingSprite ? tr("Color del sprite") : preview ? tr("Vista previa") : tr("Logo actual")))
          .when(showingSprite, el => el.child(this.palette(sprite.id, t, busy)))))
      .child(v_flex().flex_none().gap(5).pt(8).border_t(1).border_color(t.border)
        .child(div().text_size(12).font_medium().child(tr("Imagen propia")))
        .child(h_flex().items_center().gap(7)
          .child(div().flex_1().min_w(0)
            .child(Input.new(this.pathInput).w_full().h(29).px(8).rounded(3).border(1).border_color(t.input)
              .bg(t.background).text_color(t.foreground).text_size(12).accessibility_label(tr("Ruta de la imagen"))))
          .child(windows
            ? button("elegir-logo", "Explorar…", t, (_event, cx) => this.choose(cx), { disabled: busy })
            : button("cargar-ruta-logo", tr("Cargar ruta"), t, (_event, cx) => this.load(() => this.pathInput.value(), cx), { disabled: busy })))
        .child(div().text_size(11).text_color(t.muted).child(tr("PNG, JPG, WebP o SVG · hasta 8 MB"))))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_size(12)
        .text_color(busy ? t.muted : t.done)
        .child(this.phase === "loading" ? tr("Cargando imagen…") : this.message ?? ""))
      .child(h_flex().flex_none().items_center().gap(6).pt(7).border_t(1).border_color(t.border)
        .when(Boolean(customLogo), el => el.child(button("restaurar-sprite", tr("Volver al sprite"), t, (_event, cx) => this.restore(cx), { disabled: busy })))
        .child(div().flex_1())
        .child(button("usar-imagen-logo", tr("Usar imagen"), t, (_event, cx) => this.useImage(cx), { primary: true, disabled: busy || !preview })));
  }
}
