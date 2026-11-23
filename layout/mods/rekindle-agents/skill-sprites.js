import { div, image } from "gpui-kit";

const ROOT = "mods/rekindle-sidebar/art/";
export const SPRITES = [
  { id: "indigo", name: "Índigo", color: "#818CF8", sheet: ROOT + "agent-frames.png" },
  { id: "menta", name: "Menta", color: "#2DD4BF", sheet: ROOT + "agent-frames-menta.svg" },
  { id: "celeste", name: "Celeste", color: "#38BDF8", sheet: ROOT + "agent-frames-celeste.svg" },
  { id: "coral", name: "Coral", color: "#FB7185", sheet: ROOT + "agent-frames-coral.svg" },
  { id: "dorado", name: "Dorado", color: "#FBBF24", sheet: ROOT + "agent-frames-dorado.svg" },
  { id: "violeta", name: "Violeta", color: "#C084FC", sheet: ROOT + "agent-frames-violeta.svg" }
];
export const TYPE_SPRITES = [
  ...SPRITES,
  { id: "cobalto", name: "Azul cobalto", color: "#3B82F6", sheet: ROOT + "agent-frames-cobalto.png" },
  { id: "bosque", name: "Verde bosque", color: "#22C55E", sheet: ROOT + "agent-frames-bosque.png" },
  { id: "lima", name: "Lima", color: "#A3E635", sheet: ROOT + "agent-frames-lima.png" },
  { id: "naranja", name: "Naranja", color: "#F97316", sheet: ROOT + "agent-frames-naranja.png" },
  { id: "rosa", name: "Rosa", color: "#F472B6", sheet: ROOT + "agent-frames-rosa.png" },
  { id: "pizarra", name: "Pizarra", color: "#94A3B8", sheet: ROOT + "agent-frames-pizarra.png" }
];
const typeById = new Map(TYPE_SPRITES.map(choice => [choice.id, choice]));

export function spriteForType(type) {
  return typeById.get(type?.sprite) ?? TYPE_SPRITES[0];
}

export function spriteTile(sprite, size, column = 0, row = 0) {
  return div().size(size).flex_none().relative().overflow_hidden()
    .child(image(sprite.sheet).absolute().size(size * 4).left(-column * size).top(-row * size));
}
