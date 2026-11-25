import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, closeOverlay, exec, readTextFile, setShared, shared, spaces, theme, writeTextFile } from "herdr";
import { unlink } from "fs/promises";
import { parseProfiles } from "./agent-types.js";
import { showError } from "./errors.js";
import { pickSettingsArchive } from "./file-picker.js";
import { language, LANGUAGE_KEY, tr } from "./i18n.js";
import { PreferencesPanel, settingsButton } from "./preferences-panel.js";
import {
  CODEX_PERMISSION_MODES, currentPreferences, enabledPanels, PANELS, quotaAlertThreshold, readPreferenceOptions,
  setPreferenceOptions, setPreferredPanels, setQuotaAlertThreshold
} from "./preferences.js";
import { SPRITES } from "./skill-sprites.js";

const FORMAT = "rekindle-settings";
const THEME = "rekindle";
const AGENT_MOD = "rekindle-agents";
const PROFILES_FILE = "/data/rekindle-agent-types.json";
const LOGO_KEY = THEME + ".project-logos";
const SPRITE_KEY = THEME + ".project-sprite-colors";
const QUEUED_PROJECTS = THEME + ".pending-project-appearance";
const PROJECT_SPRITES = new Set(SPRITES.map(sprite => sprite.id));
const ARCHIVE_LOGO = /^logos\/[a-z0-9-]+\.(?:png|jpg|webp|svg)$/;
const LOCAL_LOGO = new RegExp("^data/" + THEME + "/logos/[a-z0-9-]+\\.(?:png|jpg|webp|svg)$");

function projectAppearance() {
  const logos = shared(LOGO_KEY) ?? {};
  const sprites = shared(SPRITE_KEY) ?? {};
  const projects = new Map();
  for (const { id, name, folder, machine } of spaces()) {
    const logo = LOCAL_LOGO.test(logos[id] ?? "") ? logos[id] : null;
    const sprite = PROJECT_SPRITES.has(sprites[id]) ? sprites[id] : null;
    if (logo || sprite) projects.set(id, { id, name, folder, machine, logo, sprite });
  }
  for (const project of shared(QUEUED_PROJECTS) ?? []) projects.set(project.id, project);
  return [...projects.values()];
}

function readManifest(manifest) {
  const invalid = () => new Error(tr("La copia contiene ajustes inválidos."));
  if (manifest?.format !== FORMAT || manifest.version !== 1 ||
    !Array.isArray(manifest.agentTypes) || !Array.isArray(manifest.projects)) throw invalid();
  const { language: locale, quotaThreshold, panels, options } = manifest.preferences ?? {};
  if (!["en", "es"].includes(locale) || !Number.isInteger(quotaThreshold) || quotaThreshold < 0 || quotaThreshold > 100 ||
    !Array.isArray(panels) || !panels.every(panel => PANELS.includes(panel))) throw invalid();
  const ids = new Set();
  const projects = manifest.projects.map(project => {
    if (!project) throw invalid();
    const { id, name, folder, machine, sprite, logo } = project;
    if (typeof id !== "string" || !id || ids.has(id) || typeof name !== "string" || typeof folder !== "string" ||
      (machine !== null && typeof machine !== "string") || (sprite !== null && !PROJECT_SPRITES.has(sprite)) ||
      (logo !== null && (typeof logo !== "string" || !ARCHIVE_LOGO.test(logo))) || (!sprite && !logo)) throw invalid();
    ids.add(id);
    return { id, name, folder, machine, sprite, logo };
  });
  return {
    preferences: { locale, quotaThreshold, panels: [...new Set(panels)], options: readPreferenceOptions(options) },
    agentTypes: parseProfiles(JSON.stringify(manifest.agentTypes)),
    projects
  };
}

async function archiveCommand(operation, path, args = []) {
  const root = appHome();
  const result = await exec("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", root + "/mods/" + AGENT_MOD + "/settings-archive.ps1",
    "-Operation", operation, "-ArchivePath", path, "-AppDirectory", root, "-Theme", THEME, ...args
  ], { timeout: 120000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
  return operation === "Export" ? null : JSON.parse(result.stdout);
}

async function saveArchive(path) {
  const root = appHome();
  const manifest = {
    format: FORMAT,
    version: 1,
    preferences: {
      language: language(),
      quotaThreshold: quotaAlertThreshold(),
      panels: enabledPanels().filter(panel => PANELS.includes(panel)),
      options: currentPreferences()
    },
    agentTypes: parseProfiles(await readTextFile(root + PROFILES_FILE)),
    projects: projectAppearance()
  };
  const temporary = root + "/data/settings-export-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + ".json";
  await writeTextFile(temporary, JSON.stringify(manifest), null);
  try {
    await archiveCommand("Export", path, ["-ManifestPath", temporary]);
  } finally {
    try { await unlink(temporary); } catch {}
  }
}

function mergeProfiles(current, imported) {
  const types = new Map(current.map(type => [type.name.toLowerCase(), type]));
  for (const type of imported) types.set(type.name.toLowerCase(), type);
  return [...types.values()];
}

async function restoreArchive(preview, stillOpen) {
  const files = await archiveCommand("Restore", preview.path, ["-Fingerprint", preview.fingerprint]);
  const projects = preview.projects.map(project => {
    const logo = project.logo ? files[project.logo] : null;
    if (project.logo && (typeof logo !== "string" || !LOCAL_LOGO.test(logo))) throw new Error(tr("Falta un logo en la copia."));
    return { ...project, logo };
  });
  if (!stillOpen()) return;
  const path = appHome() + PROFILES_FILE;
  if (preview.agentTypes.length) {
    const source = await readTextFile(path);
    const profiles = mergeProfiles(parseProfiles(source), preview.agentTypes);
    if (!stillOpen()) return;
    await writeTextFile(path, JSON.stringify(profiles, null, 2), source);
  }
  const { locale, quotaThreshold, panels, options } = preview.preferences;
  setShared(LANGUAGE_KEY, locale);
  setQuotaAlertThreshold(quotaThreshold);
  setPreferredPanels(panels);
  if (options) setPreferenceOptions(options);
  if (projects.length) {
    const pending = new Map((shared(QUEUED_PROJECTS) ?? []).map(project => [project.id, project]));
    for (const project of projects) pending.set(project.id, project);
    setShared(QUEUED_PROJECTS, [...pending.values()]);
  }
}

export class SettingsDialog {
  constructor(overlay, cx) {
    this.overlay = overlay;
    this.section = "preferences";
    this.preferences = new PreferencesPanel();
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() {
    this.closed = true;
  }

  start(message, errorTitle, task, cx) {
    if (this.busy || this.closed) return;
    this.busy = message;
    this.message = "";
    cx.notify();
    cx.spawn(async cx => {
      try { await task(); }
      catch (error) {
        if (!this.closed) showError(tr(errorTitle), tr("Comprueba la copia y vuelve a intentarlo."), error.cause ?? error);
      } finally {
        this.busy = null;
        if (!this.closed) cx.notify();
      }
    });
  }

  exportSettings(cx) {
    this.start("Guardando copia…", "No se pudo exportar la copia", async () => {
      const path = await pickSettingsArchive(true);
      if (!path || this.closed) return;
      await saveArchive(path);
      this.message = "Copia de ajustes guardada.";
    }, cx);
  }

  chooseImport(cx) {
    this.start("Revisando copia…", "No se pudo abrir la copia", async () => {
      const path = await pickSettingsArchive(false);
      if (!path || this.closed) return;
      const { manifest, fingerprint } = await archiveCommand("Inspect", path);
      if (!this.closed) this.preview = { ...readManifest(manifest), path, fingerprint };
    }, cx);
  }

  applyImport(cx) {
    if (!this.preview) return;
    this.start("Importando ajustes…", "No se pudieron importar los ajustes", async () => {
      await restoreArchive(this.preview, () => !this.closed);
      if (this.closed) return;
      this.preferences.syncInputs();
      this.preview = null;
      this.message = "Ajustes importados.";
    }, cx);
  }

  render() {
    const t = theme();
    const busy = Boolean(this.busy);
    const close = () => { if (!busy) closeOverlay(this.overlay); };
    return v_flex().id("rekindle-settings-dialog").track_focus(this.handle).size_full().min_h(0)
      .p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        cx.stop_propagation();
        close();
      })
      .child(h_flex().items_center().gap(12)
        .child(div().flex_1().text_size(17).font_semibold().child(tr("Ajustes de Rekindle")))
        .child(settingsButton("cerrar-copia-ajustes", svg("mods/workspace-chrome/x.svg").size(13), t, close, { disabled: busy })
          .size(26).px(0).accessibility_label(tr("Cerrar"))))
      .child(h_flex().gap(6).children([
        ["preferences", tr("Preferencias")],
        ["backups", tr("Copias")]
      ].map(([section, label]) => settingsButton("ajustes-" + section, label, t, (_event, cx) => {
        if (section === "preferences") this.preferences.syncInputs();
        this.section = section;
        cx.notify();
      }, { selected: this.section === section, disabled: busy }))))
      .child(this.section === "backups" ? this.backups(t, busy) : this.preferences.render(t));
  }

  backups(t, busy) {
    const preview = this.preview;
    const body = v_flex().id("contenido-copia-ajustes").flex_1().min_h(0).gap(7).overflow_y_scrollbar().text_size(12);
    if (preview) {
      const permission = CODEX_PERMISSION_MODES.find(mode => mode.value === preview.preferences.options?.codexPermissions);
      body.child(div().font_semibold().child(tr("Revisar copia")))
        .child(div().text_color(t.muted).truncate().child(preview.path.split(/[\\/]/).at(-1)))
        .child(div().child(tr("Tipos de agente") + " · " + preview.agentTypes.length))
        .child(div().child(tr("Proyectos con logo o color") + " · " + preview.projects.length))
        .when(Boolean(permission), el => el.child(div().child(tr("Permisos de inicio de Codex") + " · " + tr(permission.label))))
        .child(div().text_color(t.muted).child(tr("La importación combina los tipos por nombre y actualiza los que coinciden.")))
        .child(div().text_color(t.muted).child(tr("Los logos y colores se aplican al abrir sus proyectos.")));
    } else {
      body.child(div().text_color(t.muted).child(tr("Guarda una copia de tus tipos de agente, sprites, logos y preferencias.")));
    }
    const footer = h_flex().gap(8).justify_end().items_center();
    if (preview) {
      footer.child(settingsButton("cancelar-importacion-ajustes", tr("Cancelar"), t, (_event, cx) => {
        this.preview = null;
        cx.notify();
      }, { disabled: busy }))
        .child(settingsButton("confirmar-importacion-ajustes", tr("Importar ajustes"), t,
          (_event, cx) => this.applyImport(cx), { disabled: busy, selected: true }));
    } else {
      footer.child(settingsButton("exportar-ajustes", tr("Exportar ajustes…"), t, (_event, cx) => this.exportSettings(cx), { disabled: busy }))
        .child(settingsButton("elegir-copia-ajustes", tr("Importar ajustes…"), t, (_event, cx) => this.chooseImport(cx),
          { disabled: busy, selected: true }));
    }
    const status = this.busy || this.message;
    return v_flex().flex_1().min_h(0).gap(10).child(body)
      .when(Boolean(status), el => el.child(div().text_size(12).text_color(this.busy ? t.muted : t.done).child(tr(status))))
      .child(footer);
  }
}
