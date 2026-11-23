import { shared } from "herdr";

export const LANGUAGE_KEY = "rekindle.language";

const english = {
  "Abriendo diff…": "Opening diff…",
  "Abrir diff": "Open diff",
  "Archivos del worktree": "Worktree files",
  "Archivos modificados": "Changed files",
  "Cerrar": "Close",
  "Cerrar Entregas": "Close Deliveries",
  "Correcto": "Passed",
  "Diff de la entrega": "Delivery diff",
  "Entregas": "Deliveries",
  "Falló": "Failed",
  "Marcar revisada": "Mark reviewed",
  "No hay diferencias disponibles para esta entrega.": "No diff is available for this delivery.",
  "No hay entregas pendientes.": "No deliveries are pending.",
  "No hay entregas revisadas.": "No deliveries have been reviewed.",
  "No se pudo abrir el diff.": "Couldn't open the diff.",
  "No se pudo recuperar el diff.": "Couldn't retrieve the diff.",
  "Pendientes": "Pending",
  "Pruebas": "Tests",
  "Resultado sin confirmar": "Unconfirmed result",
  "Resumen": "Summary",
  "Revisadas": "Reviewed",
  "Sin cambios registrados.": "No changes were recorded.",
  "Sin pruebas registradas.": "No tests were recorded.",
  "Sin resumen registrado.": "No summary was recorded.",
  "Vista previa recortada.": "Preview truncated.",
  "Volver a la entrega": "Back to delivery",
  "Volver a pendientes": "Move back to pending",
  " · código ": " · exit code "
};

export function language() {
  return shared(LANGUAGE_KEY) === "es" ? "es" : "en";
}

export function tr(text) {
  return language() === "en" && Object.hasOwn(english, text) ? english[text] : text;
}
