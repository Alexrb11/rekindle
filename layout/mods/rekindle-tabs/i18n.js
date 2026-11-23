import { shared } from "herdr";

export const LANGUAGE_KEY = "rekindle.language";

const english = {
  "Archivos": "Files",
  "Cambios": "Changes",
  "Nuevo agente o terminal": "New agent or terminal"
};

export function language() {
  return shared(LANGUAGE_KEY) === "es" ? "es" : "en";
}

export function tr(text) {
  return language() === "en" && Object.hasOwn(english, text) ? english[text] : text;
}
