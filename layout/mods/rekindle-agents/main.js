import { tr } from "./i18n.js";
import { View, div, svg, image } from "gpui-kit";
import { Button, h_flex, v_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { agents, appHome, checking, closeOverlay, focused, hc, home, knownAgents, openOverlay, panes, props, readTextFile, spaces, terminals, theme, window, writeTextFile } from "herdr";
import { agentTabArgs, appendSkillFiles, delegationArgs, normalizeProfile, parseProfiles, skillLabel, skillLines, terminalLocation } from "./agent-types.js";
import { runChecked, showError } from "./errors.js";
import { pickExplorerFiles } from "./file-picker.js";
import { currentPreferences } from "./preferences.js";
import { hasProjectFolder, launchSkills, listProjectSkills, PROJECT_SKILLS_DIR } from "./project-skills.js";
import { SettingsDialog } from "./settings-backup.js";
import { TYPE_SPRITES, spriteForType, spriteTile } from "./skill-sprites.js";

function button(id, label, t, action, { primary = false, enabled = true } = {}) {
  return h_flex().id(id).flex_none().h(28).px(8).gap(5).rounded(3).items_center().justify_center()
    .text_size(12).font_medium().text_color(enabled ? t.foreground : t.dim)
    .when(primary, el => el.border(1).border_color(t.border).when(enabled, button => button.bg(t.raised)))
    .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click(action))
    .child(label);
}

function runningAgentsInProject(project) {
  const listed = agents();
  const owners = new Map(listed.map(agent => [agent.address, agent.space]));
  const running = new Set(listed.filter(agent => agent.space === project && agent.status === "working").map(agent => agent.address));
  const live = new Map(terminals().filter(terminal => terminal.state === "live").map(terminal => [terminal.address, terminal]));
  for (const terminal of live.values()) {
    if (terminal.status !== "working" || owners.has(terminal.address)) continue;
    const seen = new Set([terminal.address]);
    for (let parent = terminal.parent; parent && !seen.has(parent); parent = live.get(parent)?.parent) {
      if (owners.has(parent)) {
        if (owners.get(parent) === project) running.add(terminal.address);
        break;
      }
      seen.add(parent);
    }
  }
  return running.size;
}

export default class AgentPicker extends View {
  init(_props, cx) {
    const options = props() ?? {};
    if (options.settingsBackup) {
      this.settingsDialog = new SettingsDialog(options.overlay, cx);
      return;
    }
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.parent = options.parent ?? null;
    this.parentName = options.parentName;
    this.parentType = options.parentType;
    this.parentCreated = options.parentCreated;
    this.target = options.space ?? (this.parent ? null : spaces().find(space => space.active)?.id ?? null);
    if (this.parent) {
      this.task = TextareaState.new({ placeholder: tr("Describe la tarea y el resultado esperado"), rows: 3 });
      this.task.on("change", (_event, cx) => cx.notify());
    }
    this.skillsOpen = options.projectSkills === true;
    this.projectSkills = [];
    this.selectedProjectSkills = new Set();
    this.path = appHome() + "/data/rekindle-agent-types.json";
    this.types = [];
    this.engines = [];
    this.selected = -1;
    if (checking()) return;
    this.loadProfiles(cx);
    this.loadEngines(cx);
    this.loadProjectSkills(cx);
  }

  close() {
    this.settingsDialog?.close();
    this.closed = true;
  }

  problem(title, message, error) {
    if (!this.closed) showError(title, message, error);
  }

  loadProfiles(cx) {
    if (this.loadingTypes) return;
    this.loadingTypes = true;
    this.profileError = false;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const source = await readTextFile(this.path);
        this.types = parseProfiles(source);
        if (this.parent && this.selected < 0) this.selected = this.types.findIndex(type => type.name === this.parentType);
        this.source = source;
      } catch (error) {
        this.profileError = true;
        this.problem(tr("No se pudieron cargar los tipos"), tr("Revisa que data/rekindle-agent-types.json se pueda leer y contenga una lista de tipos válida. Después pulsa Reintentar."), error);
      } finally {
        this.loadingTypes = false;
        cx.notify();
      }
    });
  }

  loadEngines(cx) {
    if (this.loadingEngines) return;
    this.loadingEngines = true;
    this.agentError = false;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const parent = this.parentTerminal();
        const on = this.parent ? terminalLocation(this.parent).machine : this.project()?.machine ?? null;
        const available = await knownAgents({ on });
        this.engines = available.filter(agent => agent.installed && agent.run?.length > 0);
        this.engine = this.engines.find(agent => agent.key === parent?.program?.key) ?? this.engines[0];
      } catch (error) {
        this.agentError = true;
        this.problem(tr("No se pudieron consultar los agentes"), tr("Comprueba que el equipo del proyecto esté disponible y pulsa Reintentar."), error);
      } finally {
        this.loadingEngines = false;
        cx.notify();
      }
    });
  }

  project() {
    return spaces().find(space => space.id === this.target);
  }

  parentTerminal() {
    if (!this.parent) return null;
    return terminals().find(terminal => terminal.address === this.parent && terminal.state === "live"
      && (this.parentCreated == null || terminal.created_ms === this.parentCreated));
  }

  loadProjectSkills(cx) {
    const project = this.project();
    if (this.loadingSkills) return;
    if (!hasProjectFolder(project)) {
      this.projectSkills = [];
      this.selectedProjectSkills.clear();
      this.skillFolder = project?.folder;
      this.skillError = "";
      return;
    }
    if (this.skillFolder !== project.folder) {
      this.projectSkills = [];
      this.selectedProjectSkills.clear();
    }
    this.skillFolder = project.folder;
    this.loadingSkills = true;
    this.skillError = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        this.projectSkills = await listProjectSkills(project);
        this.selectedProjectSkills = new Set(this.projectSkills.filter(skill => this.selectedProjectSkills.has(skill.path)).map(skill => skill.path));
      } catch (error) {
        this.projectSkills = [];
        this.selectedProjectSkills.clear();
        this.skillError = String(error?.message ?? error).trim().slice(0, 360);
      } finally {
        this.loadingSkills = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  showSkills(open, cx) {
    this.skillsOpen = open;
    if (open && this.skillFolder !== this.project()?.folder) this.loadProjectSkills(cx);
    this.handle.focus();
    cx.notify();
  }

  toggleProjectSkill(path, cx) {
    if (this.loadingSkills || !this.project()) return;
    if (!this.selectedProjectSkills.delete(path)) this.selectedProjectSkills.add(path);
    cx.notify();
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  startEdit(index, cx) {
    if (this.loadingTypes || this.profileError || this.creating) return;
    const current = this.types[index];
    this.edit = {
      index,
      name: InputState.new({ value: current?.name ?? "", placeholder: tr("Por ejemplo, Revisión de código") }),
      skills: TextareaState.new({ value: current?.skills.join("\n") ?? "", placeholder: tr("Una skill por línea"), rows: 5 }),
      sprite: spriteForType(current).id,
      confirmingRemoval: false
    };
    this.edit.name.on("submit", () => this.edit?.skills.focus());
    this.edit.skills.on("submit", (event, cx) => { if (event?.secondary) this.save(cx); });
    this.edit.name.focus();
    cx.notify();
  }

  finishEdit(cx) {
    this.edit = null;
    this.handle.focus();
    cx.notify();
  }

  setRemovalConfirmation(confirming, cx) {
    if (!this.edit || this.saving || this.pickingSkills) return;
    this.edit.confirmingRemoval = confirming;
    if (confirming) this.handle.focus();
    else this.edit.name.focus();
    cx.notify();
  }

  chooseSkills(cx) {
    const edit = this.edit;
    if (!edit || edit.confirmingRemoval || this.pickingSkills || this.saving) return;
    const userHome = home();
    const project = this.project();
    const folders = project?.folder && !project.machine ? [project.folder + "/.agents/skills"] : [];
    folders.push(userHome + "/.agents/skills", userHome + "/.codex/skills");
    this.pickingSkills = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const paths = await pickExplorerFiles("skills", folders);
        if (!this.closed && this.edit === edit && paths.length) {
          edit.skills.set_value(appendSkillFiles(edit.skills.value(), paths, userHome));
        }
      } catch (error) {
        if (this.edit === edit) {
          this.problem(tr("No se pudieron añadir las skills"), error.message, error.cause);
        }
      } finally {
        this.pickingSkills = false;
        cx.notify();
      }
    });
  }

  save(cx) {
    if (!this.edit || this.edit.confirmingRemoval || this.saving || this.pickingSkills) return;
    const edit = this.edit;
    const { index, name, skills, sprite } = edit;
    const nameText = name.value();
    const skillsText = skills.value();
    let updated;
    try {
      updated = normalizeProfile({ name: nameText, skills: skillLines(skillsText), sprite });
      if (this.types.some((type, i) => i !== index && type.name.toLowerCase() === updated.name.toLowerCase())) {
        throw new Error(tr("Ya existe un tipo con ese nombre."));
      }
    } catch (error) {
      this.problem(tr("Revisa el tipo de agente"), error.message);
      return;
    }
    const types = [...this.types];
    const slot = index < 0 ? types.length : index;
    types[slot] = updated;
    this.writeTypes(types, edit, cx, cx => {
      edit.index = slot;
      this.selected = slot;
      if (!this.closed && edit.sprite === sprite && name.value() === nameText && skills.value() === skillsText) this.finishEdit(cx);
    });
  }

  removeType(cx) {
    const edit = this.edit;
    if (!edit?.confirmingRemoval || this.saving || this.pickingSkills || !this.types[edit.index]) return;
    const selected = this.types[this.selected];
    const types = this.types.filter((_type, index) => index !== edit.index);
    this.writeTypes(types, edit, cx, cx => {
      this.selected = this.selected === edit.index ? Math.min(edit.index, types.length - 1) : types.indexOf(selected);
      if (!this.closed) this.finishEdit(cx);
    });
  }

  writeTypes(types, edit, cx, onSaved) {
    const next = JSON.stringify(types, null, 2) + "\n";
    this.saving = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        try {
          await writeTextFile(this.path, next, this.source);
        } catch (error) {
          await this.recoverWrite(edit, error, cx);
          return;
        }
        this.types = types;
        this.source = next;
        onSaved(cx);
      } finally {
        this.saving = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  async recoverWrite(edit, error, cx) {
    const removing = edit.confirmingRemoval;
    const title = removing ? tr("No se pudo eliminar el tipo") : tr("No se pudo guardar el tipo");
    let source, types;
    try {
      source = await readTextFile(this.path);
      types = parseProfiles(source);
    } catch (reloadError) {
      this.problem(title, tr("Revisa que data/rekindle-agent-types.json sea válido y se pueda leer antes de volver a intentarlo."), reloadError);
      return;
    }
    if (source === this.source) {
      this.problem(title, tr("Comprueba que Herdr pueda escribir en data/rekindle-agent-types.json y vuelve a intentarlo."), error);
      return;
    }
    const originalName = this.types[edit.index]?.name.toLowerCase();
    const selectedName = this.types[this.selected]?.name.toLowerCase();
    this.source = source;
    this.types = types;
    edit.index = types.findIndex(type => type.name.toLowerCase() === originalName);
    if (removing) {
      this.selected = types.findIndex(type => type.name.toLowerCase() === selectedName);
      if (edit.index < 0) {
        if (!this.closed) this.finishEdit(cx);
        return;
      }
      edit.confirmingRemoval = false;
      this.problem(tr("La lista de tipos cambió"), tr("Se recargó la lista. Revisa el tipo antes de volver a eliminarlo."));
      return;
    }
    this.selected = edit.index;
    this.problem(tr("La lista de tipos cambió"), originalName && edit.index < 0
      ? tr("El tipo original ya no está en la lista. Si guardas el borrador, se añadirá como un tipo nuevo.")
      : tr("Se recargó la lista y tu borrador sigue abierto. Revísalo antes de volver a guardar."));
  }

  launch(cx, confirmed = false) {
    const type = this.types[this.selected];
    if (this.creating || this.skillsOpen || !type || !this.engine || this.loadingTypes || this.loadingEngines || this.profileError || this.agentError) return;
    const project = this.project();
    if (this.selectedProjectSkills.size) {
      if (this.loadingSkills) return;
      if (project && this.skillFolder !== project.folder) {
        this.showSkills(true, cx);
        return;
      }
    }
    if (this.parent && !this.task.value().trim()) return;
    const { runningAgentWarning: limit, codexPermissions } = currentPreferences();
    if (!confirmed && limit && project) {
      const running = runningAgentsInProject(project.id);
      if (running >= limit) {
        this.launchWarning = running;
        cx.notify();
        return;
      }
    }
    this.launchWarning = null;
    const selected = this.projectSkills.filter(skill => this.selectedProjectSkills.has(skill.path));
    const skills = launchSkills(type.skills, selected, project?.folder);
    if (this.parent) {
      this.createSubagent(type, skills, project, codexPermissions, cx);
      return;
    }
    const profilesPath = project?.machine ? null : this.path;
    this.createTab("agent", {
      name: type.name,
      ...agentTabArgs(this.engine, skills, { types: this.types, profilesPath, codexPermissions })
    }, cx);
  }

  createSubagent(type, skills, project, codexPermissions, cx) {
    const task = this.task.value().trim();
    if (!task) return;
    const parent = this.parentTerminal();
    if (!parent) {
      this.problem(tr("El agente padre se cerró"), tr("Abre Delegar desde un agente que siga activo."));
      return;
    }
    const folder = panes().find(pane => pane.terminal === parent.address)?.cwd || parent.cwd || project?.folder;
    const args = delegationArgs(parent.address, folder, this.engine, type.name, skills, task, codexPermissions);
    this.creating = "subagent";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await hc(args);
        if (result.code !== 0) {
          const output = result.stderr.trim() || result.stdout.trim();
          let detail = output;
          try { detail = JSON.parse(output).error?.message ?? output; } catch {}
          throw new Error(detail || tr("Herdr Core devolvió el código ") + result.code + ".");
        }
        if (!this.closed) this.dismiss();
      } catch (error) {
        this.problem(tr("No se pudo iniciar el subagente"), tr("Comprueba que el agente padre, su carpeta y el motor seleccionado sigan disponibles."), error);
      } finally {
        this.creating = null;
        if (!this.closed) cx.notify();
      }
    });
  }

  createTab(kind, args, cx) {
    if (this.creating) return;
    if (this.target && !this.project()) {
      this.problem(tr("El proyecto se cerró"), tr("Abre Nuevo agente desde un proyecto activo."));
      return;
    }
    this.creating = kind;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await runChecked("tab.new", { ...args, ...(this.target ? { space: this.target } : {}) });
        if (!this.closed) this.dismiss();
      } catch (error) {
        if (kind === "agent") {
          this.problem(tr("No se pudo iniciar el agente"), tr("Comprueba que el agente elegido siga instalado y que el proyecto esté disponible."), error);
        } else {
          this.problem(tr("No se pudo abrir la terminal"), tr("Comprueba que la carpeta del proyecto y su equipo estén disponibles."), error);
        }
      } finally {
        this.creating = null;
        if (!this.closed) cx.notify();
      }
    });
  }

  worktree(action) {
    const project = this.project();
    if (!project || this.creating) return;
    const here = focused();
    try {
      openOverlay({
        mod: "worktree", kind: "dialog", width: action === "new" ? 460 : 560, height: action === "new" ? 280 : 480,
        props: { action, space: project.id, folder: here?.space === project.id ? here.cwd : project.folder }
      });
      this.dismiss();
    } catch (error) {
      this.problem(tr("No se pudo abrir el selector de worktrees"), tr("Confirma que el proyecto siga abierto y vuelve a intentarlo."), error);
    }
  }

  onKey(event, cx) {
    if (this.launchWarning) {
      if (event.key === "escape") {
        this.launchWarning = null;
        cx.notify();
      }
      if (event.key === "escape" || event.key === "enter") cx.stop_propagation();
      return;
    }
    if (event.key === "escape" && this.edit?.confirmingRemoval) {
      cx.stop_propagation();
      this.setRemovalConfirmation(false, cx);
      return;
    }
    if (this.parent || this.edit || this.skillsOpen || event.modifiers.alt || event.modifiers.control || event.modifiers.platform) return;
    if (event.key === "enter") {
      this.launch(cx);
      cx.stop_propagation();
      return;
    }
    if (!/^[1-9]$/.test(event.key)) return;
    const index = Number(event.key) - 1;
    if (index >= this.types.length) return;
    this.selected = index;
    cx.notify();
    cx.stop_propagation();
  }

  typeRow(type, index, t) {
    const active = index === this.selected;
    const labels = type.skills.map(skillLabel).join(" · ");
    const summary = labels || tr("Sin skills preasignadas");
    return h_flex().flex_none().min_w(0).gap(5).items_center().pr(5)
      .border_l(2).border_color(active ? t.accent : t.popover).when(active, el => el.bg(t.surface))
      .child(h_flex().id("tipo-" + index).h(38).flex_1().min_w(0).px(6).gap(8).items_center()
        .cursor_pointer().hover(el => el.bg(t.hover)).tooltip(type.skills.join("\n") || summary)
        .accessibility_label(type.name + ", " + summary)
        .on_click((_event, cx) => {
          this.selected = index;
          this.handle.focus();
          cx.notify();
        })
        .when(!this.parent, el => el.child(div().w(12).flex_none().text_color(t.muted)
          .text_center().text_size(10.5).child(index < 9 ? String(index + 1) : "")))
        .child(spriteTile(spriteForType(type), 25))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(13).font_medium().truncate().child(type.name))
          .when(Boolean(labels), el => el.child(div().text_size(11).truncate().text_color(t.muted).child(labels)))))
      .child(button("editar-" + index, tr("Editar"), t, (_event, cx) => this.startEdit(index, cx), { enabled: !this.creating })
        .text_color(this.creating ? t.dim : t.muted).accessibility_label(tr("Editar ") + type.name));
  }

  typeSpriteEditor(t, enabled) {
    const edit = this.edit;
    const preview = spriteForType(edit);
    const label = tr("Color del tipo");
    const swatches = TYPE_SPRITES.map(sprite => {
      const selected = sprite.id === preview.id;
      const name = tr(sprite.name);
      return Button.new("sprite-tipo-" + sprite.id).size(21).flex_none().rounded_full()
        .border(1).border_color(selected ? t.foreground : t.border)
        .flex().justify_center().items_center().selected(selected).disabled(!enabled)
        .child(div().size(13).rounded_full().bg(sprite.color))
        .tooltip(name).accessibility_label(name + tr(" para ") + label)
        .when(enabled, el => el.cursor_pointer().hover(s => s.border_color(t.accent))
          .on_click((_event, cx) => { edit.sprite = sprite.id; cx.notify(); }));
    });
    return v_flex().flex_none().gap(5).pb(5).border_b(1).border_color(t.border)
      .child(h_flex().min_w(0).items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(label))
        .child(spriteTile(preview, 24))
        .child(div().w(86).min_w(0).truncate().text_size(11).text_color(t.muted).child(tr(preview.name))))
      .child(h_flex().flex_wrap().min_w(0).gap(6).children(swatches));
  }

  editForm(t) {
    const field = element => element.px(9).rounded(3)
      .border(1).border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
    const ready = !this.saving && !this.pickingSkills;
    const editable = ready && !this.edit.confirmingRemoval;
    return v_flex().flex_1().min_h(0).gap(12)
      .child(v_flex().gap(5).child(div().text_size(12).child(tr("Nombre del tipo"))).child(field(Input.new(this.edit.name)).h(36)))
      .child(v_flex().flex_1().min_h(0).gap(5)
        .child(h_flex().items_center().justify_between().gap(6)
          .child(div().text_size(12).child(tr("Skills de inicio (opcionales)")))
          .when(window()?.platform === "windows", el => el.child(
            button("explorar-skills", this.pickingSkills ? tr("Explorador abierto…") : tr("Añadir SKILL.md…"), t,
              (_event, cx) => this.chooseSkills(cx), { enabled: editable })
              .tooltip(tr("Selecciona uno o varios archivos en el explorador")))))
        .child(field(Textarea.new(this.edit.skills)).flex_1().min_h(96))
        .child(div().text_size(11.5).text_color(t.muted)
          .child(tr("Escribe una skill por línea, en el orden de inicio. Usa su nombre o la ruta a su SKILL.md."))))
      .child(this.typeSpriteEditor(t, editable))
      .child(this.editFooter(t, ready));
  }

  editFooter(t, ready) {
    const type = this.types[this.edit.index];
    const footer = h_flex().flex_none().mt(4).gap(8).items_center();
    if (type && this.edit.confirmingRemoval) {
      const question = tr("¿Eliminar «") + type.name + "»?";
      return footer
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).tooltip(question).child(question))
        .child(button("cancelar-eliminar-tipo", tr("Cancelar"), t, (_event, cx) => this.setRemovalConfirmation(false, cx), { enabled: ready }))
        .child(button("confirmar-eliminar-tipo", this.saving ? tr("Eliminando…") : tr("Eliminar tipo"), t,
          (_event, cx) => this.removeType(cx), { primary: true, enabled: ready }).text_color(ready ? t.ansi1 : t.dim));
    }
    return footer
      .when(Boolean(type), el => el.child(button("pedir-eliminar-tipo", tr("Eliminar tipo…"), t,
        (_event, cx) => this.setRemovalConfirmation(true, cx), { enabled: ready }).text_color(ready ? t.ansi1 : t.dim)))
      .child(div().flex_1())
      .child(button("cancelar-edicion", tr("Cancelar"), t, (_event, cx) => this.finishEdit(cx), { enabled: ready }))
      .child(button("guardar-tipo", this.saving ? tr("Guardando…") : tr("Guardar tipo"), t, (_event, cx) => this.save(cx), { primary: true, enabled: ready }));
  }

  skillSelectionLabel() {
    const count = this.selectedProjectSkills.size;
    return count === 1 ? tr("1 seleccionada") : count + tr(" seleccionadas");
  }

  skillsSummary(t) {
    const count = this.projectSkills.length;
    const summary = this.loadingSkills ? tr("Buscando…") : this.skillError ? tr("Error al buscar skills")
      : this.selectedProjectSkills.size ? this.skillSelectionLabel() : count === 1 ? tr("1 disponible") : count + tr(" disponibles");
    return h_flex().flex_none().gap(8).items_center().pt(5).border_t(1).border_color(t.border)
      .child(div().min_w(0).truncate().text_size(12).font_medium().child(tr("Skills del proyecto")))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(summary))
      .child(button("elegir-skills-proyecto", tr("Elegir skills"), t, (_event, cx) => this.showSkills(true, cx),
        { enabled: !this.creating }));
  }

  skillRow(skill, t) {
    const selected = this.selectedProjectSkills.has(skill.path);
    return Button.new("proyecto-skill-" + skill.path).w_full().flex_none().h(43).px(6).border_b(1)
      .border_color(t.border).text_color(t.foreground)
      .selected(selected).disabled(this.loadingSkills).accessibility_label(skill.name)
      .tooltip([skill.name, skill.description, skill.path].filter(Boolean).join("\n"))
      .when(!this.loadingSkills, el => el.cursor_pointer().hover(el => el.bg(t.hover)))
      .on_click((_event, cx) => this.toggleProjectSkill(skill.path, cx))
      .child(h_flex().w_full().min_w(0).gap(9).items_center()
        .child(div().size(16).flex_none().rounded(2).border(1).border_color(selected ? t.accent : t.input)
          .flex().items_center().justify_center()
          .when(selected, el => el.child(svg("mods/workspace-chrome/check.svg").size(12).text_color(t.accent))))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(13).font_medium().truncate().child(skill.name))
          .child(div().text_size(11).truncate().text_color(t.muted).child(skill.description || skill.path))));
  }

  skillsPicker(project, t) {
    const canScan = hasProjectFolder(project);
    const message = !project ? tr("El proyecto se cerró.") : !canScan ? tr("Abre la carpeta de tu proyecto desde Rekindle para ver sus skills.")
      : this.loadingSkills ? tr("Buscando skills…") : this.skillError ? tr("No se pudieron leer las skills del proyecto.")
        : tr("Guarda las skills en ") + PROJECT_SKILLS_DIR + tr("/<nombre>/SKILL.md y pulsa Actualizar.");
    return v_flex().flex_1().min_h(0).gap(8)
      .when(canScan, el => el.child(h_flex().flex_none().justify_end()
        .child(button("actualizar-skills-proyecto", this.skillError ? tr("Reintentar") : tr("Actualizar"), t,
          (_event, cx) => this.loadProjectSkills(cx), { enabled: !this.loadingSkills }))))
      .child(v_flex().id("lista-skills-proyecto").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(project && this.projectSkills.length), el => el.children(this.projectSkills.map(skill => this.skillRow(skill, t))))
        .when(!project || !this.projectSkills.length, el => el.child(div().py(8).text_size(12)
          .text_color(this.skillError ? t.blocked : t.muted).tooltip(this.skillError || message).child(message))))
      .child(h_flex().flex_none().pt(8).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(12).text_color(t.muted).child(this.skillSelectionLabel()))
        .child(button("continuar-nuevo-agente", this.parent ? tr("Volver a la tarea") : tr("Continuar a Nuevo agente"), t, (_event, cx) => this.showSkills(false, cx),
          { primary: true }).px(12)));
  }

  picker(project, t) {
    const missingProject = Boolean(this.target && !project);
    const missingParent = Boolean(this.parent && !this.parentTerminal());
    const ready = Boolean(this.types[this.selected] && this.engine && !missingProject && !missingParent && !this.creating
      && !this.loadingTypes && !this.loadingEngines && !this.profileError && !this.agentError
      && (!this.task || this.task.value().trim())
      && !(this.loadingSkills && this.selectedProjectSkills.size));
    const engines = h_flex().id("motores").gap(5).min_w(0).overflow_x_scrollbar()
      .children(this.engines.map(engine => {
        const icon = engine.icon && (engine.tint ? svg(engine.icon).size(13) : image(engine.icon).size(13));
        return button("motor-" + engine.key, engine.name, t, (_event, cx) => { this.engine = engine; cx.notify(); })
          .rounded(0).border_b(1).border_color(this.engine === engine ? t.accent : t.popover)
          .text_color(this.engine === engine ? t.foreground : t.muted)
          .when(Boolean(icon), el => el.child(icon));
      }));
    return v_flex().flex_1().min_h(0).gap(8)
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(tr("Tipo de agente")))
        .child(button("crear-tipo", tr("+ Nuevo tipo"), t, (_event, cx) => this.startEdit(-1, cx), { enabled: !this.loadingTypes && !this.profileError && !this.creating })))
      .child(v_flex().id("tipos").min_h(0).flex_1().gap(2).overflow_y_scrollbar()
        .children(this.types.map((type, i) => this.typeRow(type, i, t)))
        .when(!this.types.length, el => el.child(div().px(2).py(8).text_size(12).text_color(this.profileError ? t.blocked : t.muted)
          .child(this.profileError ? tr("No se pudieron cargar los tipos.") : this.loadingTypes ? tr("Cargando tipos…") : tr("Crea un tipo de agente para empezar.")))))
      .when(this.profileError, el => el.child(h_flex()
        .child(button("reintentar-tipos", tr("Reintentar"), t, (_event, cx) => this.loadProfiles(cx))
          .accessibility_label(tr("Reintentar cargar tipos")))))
      .when(Boolean(project), el => el.child(this.skillsSummary(t)))
      .when(Boolean(this.task), el => el.child(v_flex().flex_none().gap(5)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(tr("Tarea del subagente")))
        .child(Textarea.new(this.task).h(88).px(9).rounded(3).border(1).border_color(t.input)
          .bg(t.background).text_size(13).text_color(t.foreground).accessibility_label(tr("Tarea del subagente")))))
      .child(v_flex().flex_none().min_w(0).gap(5).pb(4)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(tr("Agente instalado")))
        .when(this.engines.length > 0, el => el.child(engines))
        .when(!this.engines.length, el => el.child(div().text_size(12).text_color(this.agentError ? t.blocked : t.muted)
          .child(this.agentError ? tr("No se pudieron consultar los agentes.") : this.loadingEngines ? tr("Buscando agentes…") : tr("No se encontraron agentes instalados en este equipo."))))
        .when(this.agentError && !missingProject, el => el.child(h_flex()
          .child(button("reintentar-agentes", tr("Reintentar"), t, (_event, cx) => this.loadEngines(cx))
            .accessibility_label(tr("Reintentar consultar agentes"))))))
      .when(missingProject, el => el.child(div().text_size(12).text_color(t.blocked).child(tr("El proyecto se cerró. Vuelve a abrir el selector."))))
      .when(missingParent, el => el.child(div().text_size(12).text_color(t.blocked).child(tr("El agente padre ya no está activo."))))
      .child(h_flex().flex_none().pt(8).gap(5).border_t(1).border_color(t.border).items_center()
        .when(!this.parent, el => el.child(button("terminal", this.creating === "terminal" ? tr("Abriendo…") : "Terminal", t,
          (_event, cx) => this.createTab("terminal", {}, cx), { enabled: !missingProject && !this.creating }))
          .child(button("crear-worktree", tr("Crear worktree"), t, () => this.worktree("new"), { enabled: Boolean(project && !this.creating) }))
          .child(button("abrir-worktree", tr("Abrir worktree"), t, () => this.worktree("open"), { enabled: Boolean(project && !this.creating) })))
        .child(div().flex_1())
        .child(button("lanzar-tipo", this.creating === "agent" || this.creating === "subagent" ? tr("Iniciando…") : this.parent ? tr("Delegar") : tr("Iniciar agente"), t,
          (_event, cx) => this.launch(cx), { primary: true, enabled: ready }).px(12)));
  }

  confirmLaunch(t) {
    return v_flex().flex_1().min_h(0).gap(10)
      .child(div().text_size(14).font_semibold().child(tr("Aviso antes de iniciar otro agente")))
      .child(div().text_size(12).text_color(t.muted)
        .child(tr("Agentes en curso en este proyecto") + " · " + this.launchWarning))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(7)
        .child(button("cancelar-aviso-agentes", tr("Volver"), t, (_event, cx) => {
          this.launchWarning = null;
          cx.notify();
        }))
        .child(button("confirmar-lanzamiento", tr("Continuar"), t, (_event, cx) => this.launch(cx, true), { primary: true })));
  }

  render() {
    if (this.settingsDialog) return this.settingsDialog.render();
    const t = theme();
    const project = this.project();
    const title = this.edit ? (this.edit.index < 0 ? tr("Nuevo tipo") : tr("Editar tipo"))
      : this.skillsOpen ? tr("Skills del proyecto") : this.parent ? tr("Delegar") : tr("Nuevo agente");
    const context = this.parent ? tr("Subagente de ") + (this.parentName || this.parent)
      : project ? [project.name, project.machine].filter(Boolean).join(" · ") : this.target ? tr("Proyecto cerrado") : tr("Nuevo proyecto");
    return v_flex().id("rekindle-agent-picker").size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((event, cx) => this.onKey(event, cx))
      .child(h_flex().flex_none().items_center().justify_between().gap(6)
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(17).font_semibold().child(title))
          .when(!this.edit, el => el.child(h_flex().items_center().gap(5).text_color(t.muted)
            .child(svg(this.parent ? "mods/workspace-chrome/git-branch.svg" : "mods/workspace-chrome/folder.svg").size(13).flex_none())
            .child(div().text_size(12).truncate().child(context)))))
        .child(button("cerrar-selector", "×", t, () => this.dismiss()).w(28).px(0).text_size(19).accessibility_label(tr("Cerrar"))))
      .child(div().flex_none().h(1).bg(t.border))
      .child(this.launchWarning ? this.confirmLaunch(t)
        : this.edit ? this.editForm(t) : this.skillsOpen ? this.skillsPicker(project, t) : this.picker(project, t));
  }
}
