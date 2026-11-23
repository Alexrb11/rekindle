import { shared } from "herdr";

export const LANGUAGE_KEY = "rekindle.language";

const english = {
  "Cancelar": "Cancel",
  "Codex restante": "Codex remaining",
  "Comandos": "Commands",
  "Configurar aviso de cuota baja": "Configure low quota alert",
  "Configurar aviso de cuota baja · umbral ": "Configure low quota alert · threshold ",
  "Consultando…": "Checking…",
  "Cuota baja de Codex": "Low Codex quota",
  "Disponible": "Available",
  "En caché": "Cached",
  "Entrada": "Input",
  "Escribe un número entero entre 0 y 100.": "Enter an integer between 0 and 100.",
  "Guardar": "Save",
  "Lectura de la cuenta": "Account reading",
  "Mayús+": "Shift+",
  "Paleta de comandos": "Command palette",
  "Pulsa para actualizar": "Click to refresh",
  "Salida": "Output",
  "Semanal": "Weekly",
  "Sin datos": "No data",
  "Umbral del aviso de cuota": "Quota alert threshold",
  "Uso restante de Codex. ": "Codex usage remaining. ",
  "Última lectura disponible": "Last available reading",
  "Último turno · +": "Last turn · +",
  "Avisarme al bajar de": "Notify me below",
  "Aviso de cuota": "Quota alert",
  "0 desactiva el aviso.": "Set to 0 to turn off alerts.",
  " % restante": "% remaining",
  "% restante": "% remaining",
  " agente": " agent",
  " agentes": " agents",
  " pendientes": " pending",
  " sesión de Codex registrada": " tracked Codex session",
  " sesiones de Codex registradas": " tracked Codex sessions",
  " tokens en ": " tokens across ",
  " tokens en este chat": " tokens in this chat",
  " · se restablece ": " · resets ",
  "· 1 pendiente": "· 1 pending",
  "\nUmbral de aviso · ": "\nAlert threshold · "
};

export function language() {
  return shared(LANGUAGE_KEY) === "es" ? "es" : "en";
}

export function tr(text) {
  return language() === "en" && Object.hasOwn(english, text) ? english[text] : text;
}
