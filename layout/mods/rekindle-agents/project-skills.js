import { tr } from "./i18n.js";
import { exec, home, readTextFile } from "herdr";

export const PROJECT_SKILLS_DIR = ".agents/skills";

const WINDOWS_SCAN = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "$start = Get-Item -LiteralPath $folder -Force",
  "if (!$start.PSIsContainer) { throw 'Project folder is not a directory' }",
  "$roots = @($start.FullName)",
  "for ($root = $start; $root -and $root.FullName -ne $HOME; $root = $root.Parent) {",
  "  if (Test-Path -LiteralPath (Join-Path $root.FullName '.git')) { $roots += $root.FullName; break }",
  "}",
  "$paths = @(foreach ($root in ($roots | Select-Object -Unique)) {",
  "  if ($root -eq $HOME) { continue }",
  "  $directory = Join-Path $root '" + PROJECT_SKILLS_DIR + "'",
  "  if (!(Test-Path -LiteralPath $directory -PathType Container)) { continue }",
  "  foreach ($skill in (Get-ChildItem -LiteralPath $directory -Directory -Force)) {",
  "    $path = Join-Path $skill.FullName 'SKILL.md'",
  "    if (Test-Path -LiteralPath $path -PathType Leaf) { $path }",
  "  }",
  "})",
  "[Console]::Write((ConvertTo-Json -InputObject $paths -Compress))"
].join("\n");

const UNIX_SCAN = [
  'start=$(CDPATH= cd -P "$1" && pwd -P) || exit 1',
  'user_home=$(CDPATH= cd -P "${HOME:-/}" && pwd -P) || user_home=$HOME',
  'scan() {',
  '  [ "$1" != "$user_home" ] || return 0',
  '  directory="${1%/}/' + PROJECT_SKILLS_DIR + '"',
  '  [ -d "$directory" ] || return 0',
  '  [ -r "$directory" ] && [ -x "$directory" ] || return 1',
  '  for path in "$directory"/*/SKILL.md; do',
  '    if [ -f "$path" ]; then printf "%s\\0" "$path"; fi',
  '  done',
  '}',
  'scan "$start" || exit 1',
  'root=$start',
  'while [ "$root" != "$user_home" ]; do',
  '  if [ -e "${root%/}/.git" ]; then',
  '    if [ "$root" != "$start" ]; then scan "$root" || exit 1; fi',
  '    break',
  '  fi',
  '  [ "$root" != / ] || break',
  '  root=${root%/*}',
  '  root=${root:-/}',
  'done'
].join("\n");

function isWindowsPath(folder) {
  return /^[a-z]:[\\/]|^[\\/]{2}[^\\/]/i.test(folder);
}

function referenceKey(reference, windows) {
  return windows ? reference.replace(/\\/g, "/").toLowerCase() : reference;
}

export function hasProjectFolder(project) {
  const folder = project?.folder;
  if (!folder || folder === "~") return false;
  if (project.machine) return true;
  const windows = isWindowsPath(folder);
  const key = path => referenceKey(path, windows).replace(/\/+$/, "");
  return key(folder) !== key(home());
}

function metadata(source, path, windows) {
  const header = (source ?? "").slice(0, 8192).replace(/^\uFEFF/, "")
    .match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
  const lines = header?.split(/\r?\n/) ?? [];
  const field = key => {
    const prefix = key + ":";
    const index = lines.findIndex(line => line.startsWith(prefix));
    if (index < 0) return "";
    const value = lines[index].slice(prefix.length).trim();
    if (!/^[>|][+-]?$/.test(value)) return value.replace(/^(['"])(.*)\1$/, "$2");
    const block = [];
    for (const line of lines.slice(index + 1)) {
      if (line && !/^[ \t]/.test(line)) break;
      block.push(line.trim());
    }
    return block.filter(Boolean).join(" ");
  };
  return {
    path,
    name: (field("name") || path.split(windows ? /[\\/]/ : "/").at(-2)).slice(0, 100),
    description: field("description").slice(0, 360)
  };
}

export async function listProjectSkills(project) {
  if (!hasProjectFolder(project)) return [];
  const { folder, machine: on } = project;
  const windows = isWindowsPath(folder);
  const options = { on, timeout: 10000 };
  const result = windows
    ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$folder = [Uri]::UnescapeDataString('" + encodeURIComponent(folder).replace(/'/g, "%27") + "')\n" + WINDOWS_SCAN], options)
    : await exec("sh", ["-c", UNIX_SCAN, "rekindle-skills", folder], options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || tr("Comprueba que la carpeta del proyecto siga disponible."));
  }
  const paths = windows ? JSON.parse(result.stdout) : result.stdout.split("\0");
  const entries = await Promise.all([...new Set(paths)].filter(path => path && !/[\x00-\x1f\x7f]/.test(path)).map(async path =>
    metadata(await readTextFile(path, { on }).catch(() => null), path, windows)));
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export function launchSkills(typeSkills, selected, folder) {
  if (!selected.length) return typeSkills;
  const byName = new Map();
  for (const skill of selected) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill.path);
  }
  const ordered = [...typeSkills.map(reference => byName.get(reference) ?? reference), ...selected.map(skill => skill.path)];
  const seen = new Set();
  const windows = isWindowsPath(folder);
  return ordered.filter(reference => {
    const key = referenceKey(reference, windows);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
