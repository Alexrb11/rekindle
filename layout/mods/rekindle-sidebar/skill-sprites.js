import { div, image } from "gpui-kit";
import { home, shared, setShared, window } from "herdr";

const ROOT = "mods/rekindle-sidebar/art/";
const ASSIGNMENTS = "rekindle.skill-sprites";
export const TAB_SKILLS = "rekindle.tab-skills";
export const SPRITES = [
  { id: "indigo", name: "Índigo", color: "#818CF8", sheet: ROOT + "agent-frames.png" },
  { id: "menta", name: "Menta", color: "#2DD4BF", sheet: ROOT + "agent-frames-menta.svg" },
  { id: "celeste", name: "Celeste", color: "#38BDF8", sheet: ROOT + "agent-frames-celeste.svg" },
  { id: "coral", name: "Coral", color: "#FB7185", sheet: ROOT + "agent-frames-coral.svg" },
  { id: "dorado", name: "Dorado", color: "#FBBF24", sheet: ROOT + "agent-frames-dorado.svg" },
  { id: "violeta", name: "Violeta", color: "#C084FC", sheet: ROOT + "agent-frames-violeta.svg" }
];
const byId = new Map(SPRITES.map(choice => [choice.id, choice]));
const defaults = new Map([
  ["review-agent", "menta"],
  ["openai-docs", "celeste"],
  ["imagegen", "coral"],
  ["skill-creator", "dorado"]
]);

export function skillSpriteKey(skill) {
  const reference = skill.trim().replace(/^\$/, "").replace(/\\/g, "/");
  const path = reference.startsWith("~/") ? home().replace(/\\/g, "/").replace(/\/$/, "") + reference.slice(1) : reference;
  return window()?.platform === "windows" ? path.toLowerCase() : path;
}

export function spriteAssignments() {
  return shared(ASSIGNMENTS) ?? {};
}

export function assignedSprite(skill, assignments) {
  const key = skillSpriteKey(skill);
  const label = /(?:^|\/)SKILL\.md$/i.test(key) ? key.split("/").at(-2) : key;
  return byId.get(assignments[key]) ?? byId.get(defaults.get(label));
}

export function spriteForSkills(skills, assignments) {
  for (const skill of skills ?? []) {
    const sprite = assignedSprite(skill, assignments);
    if (sprite) return sprite;
  }
  return SPRITES[0];
}

export function spriteTile(sprite, size, column = 0, row = 0) {
  return div().size(size).flex_none().relative().overflow_hidden()
    .child(image(sprite.sheet).absolute().size(size * 4).left(-column * size).top(-row * size));
}

export function saveSpriteChoices(skills, changes) {
  const next = { ...spriteAssignments() };
  let updated = false;
  for (const skill of skills) {
    const id = skillSpriteKey(skill);
    const variant = changes.get(id);
    if (!byId.has(variant) || next[id] === variant) continue;
    next[id] = variant;
    updated = true;
  }
  if (updated) setShared(ASSIGNMENTS, next);
}
