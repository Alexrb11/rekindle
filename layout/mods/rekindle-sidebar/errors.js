import { tr } from "./i18n.js";
import { exec, notify, openOverlay } from "herdr";

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
  const output = result.stdout.trim() || result.stderr.trim();
  let message = output;
  try { message = JSON.parse(output).error ?? output; } catch {}
  throw new Error(message || tr("Herdr devolvió el código ") + result.code + ".");
}
