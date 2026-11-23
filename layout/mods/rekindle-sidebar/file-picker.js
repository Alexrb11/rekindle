import { tr } from "./i18n.js";
import { exec } from "herdr";

const FILE_DIALOG = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$picker = [System.Windows.Forms.OpenFileDialog]::new()",
  "$owner = [System.Windows.Forms.Form]::new()",
  "$owner.ShowInTaskbar = $false",
  "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None",
  "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual",
  "$owner.Location = [System.Windows.Forms.Cursor]::Position",
  "$owner.Size = [System.Drawing.Size]::new(1, 1)",
  "$owner.Opacity = 0",
  "$owner.TopMost = $true",
  "$skills = $options.kind -eq 'skills'",
  "$picker.Title = $options.title",
  "$picker.Filter = $options.filter",
  "$picker.Multiselect = $skills",
  "$picker.CheckFileExists = $true",
  "$picker.AddExtension = $false",
  "$picker.RestoreDirectory = $true",
  "foreach ($folder in @($options.folders)) { if ($folder -and (Test-Path -LiteralPath $folder -PathType Container)) { $picker.InitialDirectory = $folder; break } }",
  "try { $owner.Show(); $owner.Activate(); if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Write((ConvertTo-Json -InputObject @($picker.FileNames) -Compress)) } } finally { $picker.Dispose(); $owner.Dispose() }"
].join("; ");

export async function pickExplorerFiles(kind, folders = []) {
  // The PowerShell program reads the options as data, including paths with apostrophes.
  const skills = kind === "skills";
  const title = skills ? tr("Seleccionar archivos SKILL.md") : tr("Elegir logo del proyecto");
  const filter = skills ? tr("Archivos SKILL.md") + "|SKILL.md"
    : tr("Imágenes") + " (*.png;*.jpg;*.jpeg;*.webp;*.svg)|*.png;*.jpg;*.jpeg;*.webp;*.svg";
  const encoded = encodeURIComponent(JSON.stringify({ kind, folders, title, filter })).replace(/'/g, "%27");
  const command = "$ErrorActionPreference = 'Stop'; $options = ConvertFrom-Json ([Uri]::UnescapeDataString('" + encoded + "')); " + FILE_DIALOG;
  const result = await exec("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command", command
  ], { timeout: 600000 }).catch(error => {
    throw new Error(tr("No se pudo abrir el explorador de archivos. Vuelve a intentarlo."), { cause: error });
  });
  if (result.code !== 0) {
    throw new Error(tr("Windows no pudo abrir el explorador de archivos."), {
      cause: result.stderr.trim() || tr("Código de salida ") + result.code
    });
  }
  const output = result.stdout.trim();
  if (!output) return [];
  let files;
  try { files = JSON.parse(output); } catch (error) {
    throw new Error(tr("El explorador devolvió una selección ilegible. Vuelve a elegir los archivos."), { cause: error });
  }
  if (!Array.isArray(files) || !files.every(file => typeof file === "string" && file.trim())) {
    throw new Error(tr("El explorador devolvió una selección inválida. Vuelve a elegir los archivos."));
  }
  return files;
}
