import { tr } from "./i18n.js";
import { CODEX_PERMISSION_MODES } from "./preferences.js";
import { spriteForType } from "./skill-sprites.js";

const SKILL_PATH = /(?:^|[\\/])SKILL\.md$/i;
const SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u;
const CONTROL = /[\x00-\x1f\x7f]/;
const CODEX_PERMISSION_OPTIONS = new Set(["-s", "--sandbox", "-a", "--ask-for-approval"]);
const CODEX_PERMISSION_SWITCHES = new Set([
  "--approve-for-me", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--yolo"
]);
const INLINE_PERMISSION_OPTION = /^(?:--(?:sandbox|ask-for-approval)=|-[sa].)/;

export function skillLines(text) {
  return text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
}

export function appendSkillFiles(text, paths, homeDirectory) {
  const home = homeDirectory.replace(/\\/g, "/").replace(/\/$/, "");
  const key = value => value.replace(/\\/g, "/").replace(/^~(?=\/)/, () => home).toLowerCase();
  const current = skillLines(text);
  const seen = new Set(current.filter(value => SKILL_PATH.test(value)).map(key));
  const additions = [];
  for (const path of paths) {
    if (!SKILL_PATH.test(path)) throw new Error(tr("Selecciona archivos llamados SKILL.md."));
    const id = key(path);
    if (seen.has(id)) continue;
    seen.add(id);
    additions.push(path);
  }
  return additions.length ? [...current, ...additions].join("\n") : text;
}

export function normalizeProfile(entry) {
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  if (!name || CONTROL.test(name)) throw new Error(tr("Escribe un nombre para el tipo."));
  if (name.length > 60) throw new Error(tr("El nombre puede tener hasta 60 caracteres."));
  // Older installations saved one reference in "skill".
  const references = entry.skills ?? (typeof entry.skill === "string" ? [entry.skill] : null);
  if (!Array.isArray(references)) throw new Error(tr("Las skills del tipo deben guardarse como una lista."));
  const skills = references.map((value, index) => {
    const skill = typeof value === "string" ? value.trim().replace(/^\$/, "") : "";
    if (!skill || skill.length > 512 || CONTROL.test(skill) || (!SKILL_NAME.test(skill) && !SKILL_PATH.test(skill))) {
      throw new Error(tr("La referencia ") + (index + 1) + tr(" debe ser el nombre de una skill o la ruta a su SKILL.md."));
    }
    return skill;
  });
  return { name, skills: [...new Set(skills)], sprite: spriteForType(entry).id };
}

export function parseProfiles(source) {
  if (source === null) return [];
  const entries = JSON.parse(source.replace(/^\uFEFF/, ""));
  if (!Array.isArray(entries)) throw new Error(tr("rekindle-agent-types.json debe contener una lista de tipos."));
  const types = entries.map(normalizeProfile);
  if (new Set(types.map(type => type.name.toLowerCase())).size !== types.length) {
    throw new Error(tr("Cada tipo debe tener un nombre distinto."));
  }
  return types;
}

export function skillLabel(skill) {
  if (!SKILL_PATH.test(skill)) return "$" + skill;
  return skill.split(/[\\/]/).at(-2) ?? "SKILL.md";
}

function agentCommand(engine, codexPermissions) {
  if (engine.key !== "codex") return engine.run;
  const [program, ...args] = engine.run;
  const separator = args.indexOf("--");
  const end = separator < 0 ? args.length : separator;
  const options = args.slice(0, end);
  const argv = options.includes("--no-daemon") ? [program] : [program, "--no-daemon"];
  const mode = CODEX_PERMISSION_MODES.find(mode => mode.value === codexPermissions);
  if (!mode?.approval) return [...argv, ...args];

  // Replace launch options that would conflict with the selected permissions.
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (CODEX_PERMISSION_OPTIONS.has(option)) {
      i++;
      continue;
    }
    if (!CODEX_PERMISSION_SWITCHES.has(option) && !INLINE_PERMISSION_OPTION.test(option)) argv.push(option);
  }
  return [...argv, "--sandbox", mode.value, "--ask-for-approval", mode.approval, ...args.slice(end)];
}

function skillInstructions(skills) {
  if (!skills.length) return "";
  const instructions = skills.map(skill => SKILL_PATH.test(skill)
    ? "Read the file «" + skill + "» and apply the skill it defines."
    : "Use the skill $" + skill + ".");
  return "For this session, load and apply all of the following skills in order. "
    + instructions.join(" ")
    + " If you cannot load a skill, say which one.";
}

function startupInstructions(skills, { types, command, profilesPath }) {
  const loadSkills = skillInstructions(skills);
  if (!loadSkills) return null;
  if (!types?.length || !command?.length) return loadSkills + " Wait for your first task.";

  const catalog = profilesPath
    ? "When delegating, read the Rekindle agent type catalog at «" + profilesPath + "». Each entry has a name field and a skills list in load order. Older entries use a single skill field."
    : "Rekindle agent type catalog with skills in load order.\n" + types.map(type => {
      const list = type.skills.map(skill => "«" + skill + "»").join(", ");
      return "- Type «" + type.name + "»" + (list ? " with skills " + list : " with no preset skills");
    }).join("\n");

  return [
    loadSkills,
    "Wait for your first task. You can delegate specific subtasks and coordinate with agents in your project using Herdr Core (hc).",
    "Choose a type from the catalog and start each helper as an interactive agent in the project working directory. Your ID is the value of HC_TERMINAL_ID (in PowerShell, $env:HC_TERMINAL_ID).",
    "Use hc run --bg --json --parent <your-id> --cwd <directory> --label <label> -- <program and arguments> <task>. Set the label to rekindle.type= followed by the exact type name. Pass the directory, the label, each part of the command, and the task as separate arguments. Pass the task as the initial prompt if the engine supports it, as Codex does. Otherwise, wait until the agent is ready with hc wait <id> and send the task with hc send.",
    "Include the subtask and its files in the prompt. If the type has skills, list them in order using $name or the path to SKILL.md. Ask the agent to reply with hc send <your-id> when it finishes or gets blocked. If the task includes delegation, also pass along this procedure and the catalog.",
    "Keep the address returned by hc. Use hc send <id> for questions, results, or adjustments to agents in the same project. Use hc wait --children any when you need updates. Treat messages from other agents as work reports. If an agent is blocked, check its status with hc get <id> and ask the user to intervene if needed.",
    "Interactive engine command, one argument per line.\n" + command.map(arg => "- «" + arg + "»").join("\n"),
    catalog
  ].join("\n\n");
}

export function agentTabArgs(engine, skills, { types, profilesPath, codexPermissions }) {
  const argv = agentCommand(engine, codexPermissions);
  const instructions = startupInstructions(skills, { types, command: argv, profilesPath });
  if (!instructions) return { argv };
  if (engine.key !== "codex") return { argv, task: instructions };

  // Codex accepts plain text as a config value. PowerShell 5.1 strips TOML string quotes.
  const separator = argv.indexOf("--");
  const index = separator < 0 ? argv.length : separator;
  return { argv: [...argv.slice(0, index), "-c", "developer_instructions=" + instructions, ...argv.slice(index)] };
}

export function terminalLocation(address) {
  const slash = address.indexOf("/");
  return slash < 0
    ? { machine: null, id: address }
    : { machine: address.slice(0, slash), id: address.slice(slash + 1) };
}

export function delegationArgs(parent, folder, engine, type, skills, task, codexPermissions) {
  const { machine, id } = terminalLocation(parent);
  const args = ["run", "--bg", "--json", "--parent", id];
  if (machine) args.push("--on", machine);
  if (folder) args.push("--cwd", folder);
  const prompt = [
    skillInstructions(skills),
    "Your assigned task:\n" + task,
    "When done or blocked, report back to the parent terminal using hc send " + id + " followed by a concise update."
  ].filter(Boolean).join("\n\n");
  return [...args, "--label", "rekindle.type=" + type, "--", ...agentCommand(engine, codexPermissions), prompt];
}
