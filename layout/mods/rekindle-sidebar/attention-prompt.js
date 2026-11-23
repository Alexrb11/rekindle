const NUMBERED_OPTION = /^(›\s*|❯\s*|>\s*)?(\d{1,2})\.\s+(.+)$/;
const APPROVAL_TITLE = /^(?:Would you like to (?:run the following command|make the following edits|grant these permissions|send input to (?:the existing terminal|terminal .+))\?|Do you want to approve network access to .+\?|.+ needs your approval\.)$/i;
const QUESTION_TITLE = /^Question\s+\d+\/\d+\s+\(\d+ unanswered\)/i;

export function pendingReport(terminal) {
  const report = terminal?.report ?? terminal?.status;
  return terminal?.state === "live" && report?.state === "blocked" ? report : null;
}

export function promptStamp(terminal, report) {
  return JSON.stringify([terminal.created_ms, terminal.turn, terminal.status_ms, report.app, report.kind, report.title, report.msg]);
}

function displayLines(text) {
  return text.split(/\r?\n/).map(line => line.trim().replace(/^[│┃]\s?|\s?[│┃]$/g, "").trim())
    .filter(line => line && !/^[╭╮╯╰┌┐└┘─━│┃\s]+$/.test(line));
}

function menuRows(lines, heading) {
  const first = lines.findLastIndex((line, i) => i > heading && NUMBERED_OPTION.exec(line)?.[2] === "1");
  if (first < 0) return null;
  const choices = [];
  let highlighted = 0;
  for (const line of lines.slice(first)) {
    const option = NUMBERED_OPTION.exec(line);
    if (!option) {
      choices.at(-1).label += " " + line;
      continue;
    }
    if (Number(option[2]) !== choices.length + 1) return null;
    if (option[1]) highlighted++;
    choices.push({ number: option[2], label: option[3] });
  }
  if (highlighted !== 1 || choices.length < 2) return null;
  return { first, choices };
}

function codexApproval(lines) {
  const heading = lines.findLastIndex(line => APPROVAL_TITLE.test(line));
  if (heading < 0) return null;
  const question = lines[heading];
  if (!/^Press .+ to confirm\b.*\bto cancel\b/i.test(lines.at(-1))) return { question };
  const menu = menuRows(lines.slice(0, -1), heading);
  if (!menu) return { question };
  const details = lines.slice(heading + 1, menu.first).join("\n");
  const options = menu.choices.map(({ label }) => {
    const shortcut = label.match(/^(.+?)\s+\(([a-z0-9]|esc)\)$/i);
    return shortcut ? { label: shortcut[1], keys: [shortcut[2].toLowerCase()] } : null;
  });
  // Review the full request in the terminal if Codex truncated the approval banner.
  const clipped = /(?:…|\bview (?:all|full request|full command)\b)/i.test(details);
  const unique = new Set(options.map(option => option?.keys[0]));
  return { question, details, options: !clipped && options.every(Boolean) && unique.size === options.length ? options : [] };
}

function codexQuestion(lines) {
  const heading = lines.findLastIndex(line => QUESTION_TITLE.test(line));
  if (heading < 0) return null;
  const screen = lines.slice(0, -1);
  const menu = menuRows(screen, heading);
  const end = menu?.first ?? screen.findIndex((line, i) => i > heading && /^(?:[›❯>]|Type your answer|Add notes)/i.test(line));
  const question = screen.slice(heading + 1, end < 0 ? heading + 2 : end).join(" ");
  const browsingOptions = /(?:^|\|)\s*tab to add notes(?:\s*\||$)/i.test(lines.at(-1))
    && /\bto submit (?:answer|all)\b/i.test(lines.at(-1));
  const options = browsingOptions && menu
    ? menu.choices.map(({ label, number }) => ({
      label,
      keys: /^[1-9]$/.test(number) && !/^None of the above\b/i.test(label) ? [number] : []
    }))
    : [];
  return { question, progress: lines[heading].match(/\d+\/\d+/)?.[0], options };
}

export function attentionPrompt(report, screen = "") {
  const fallback = {
    question: report.msg || report.title || (report.kind === "permission"
      ? "El agente solicita permiso." : "El agente espera una respuesta."),
    options: []
  };
  if (report.kind === "auth") return { question: "El agente requiere autenticación.", options: [] };
  const lines = displayLines(screen);
  const binary = lines.at(-1)?.match(/^(.+?)\s*\[([sy])\s*\/\s*n\]\s*:?$/i);
  if (binary) return {
    question: binary[1],
    options: [
      { label: "Sí", keys: [binary[2].toLowerCase(), "enter"] },
      { label: "No", keys: ["n", "enter"] }
    ],
    compact: true
  };
  if (report.app === "codex" || report.app === "codex-cli") {
    const parsed = report.kind === "permission" ? codexApproval(lines) : codexQuestion(lines) ?? codexApproval(lines);
    if (parsed?.question) return { ...fallback, ...parsed };
  }
  return fallback;
}
