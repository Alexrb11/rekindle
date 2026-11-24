import { tr } from "./i18n.js";
import { exec, hc, notify, openOverlay } from "herdr";

function commandError(output, fallback) {
  try {
    const error = JSON.parse(output)?.error;
    if (typeof error === "string") return new Error(error || fallback);
    if (error?.message) return new Error(error.message);
  } catch {}
  return new Error(output || fallback);
}

export async function coreJson(args) {
  const result = await hc(args);
  if (result.code === 0) return JSON.parse(result.stdout);
  throw commandError(result.stderr.trim() || result.stdout.trim(), tr("Herdr Core devolvió el código ") + result.code + ".");
}

export function showError(title, message, error) {
  const detail = error == null ? "" : String(error.message ?? error).trim().slice(0, 1600);
  try {
    openOverlay({
      mod: "rekindle-sidebar", kind: "dialog", modal: true, width: 430, height: detail ? 265 : 190,
      props: { rekindleError: { title, message, detail } }
    });
  } catch {
    notify({ title, body: [message, detail].filter(Boolean).join("\n"), level: "error" });
  }
}

// The native run() queues commands. The CLI also returns the result of creating the space or tab.
export async function runChecked(command, args) {
  const result = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  if (result.code === 0) return;
  throw commandError(result.stdout.trim() || result.stderr.trim(), tr("Herdr devolvió el código ") + result.code + ".");
}
