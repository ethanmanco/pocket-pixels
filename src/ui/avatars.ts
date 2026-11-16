// Pixel-art portraits, 14 x 14, drawn for this project.

import { MONSTER_BASES, MONSTER_VARIANTS } from "./avatar-monsters";
import { type AvatarGroup, BASES, VARIANTS as FIRST_SET } from "./avatar-presets";
import { type Palette, pixelSVG } from "./pixels";

export interface AvatarArt {
  rows: string[];
  palette: Palette;
  /** Tile color behind the character. */
  bg: string;
}

const K = "#111111";

export const AVATARS: Record<string, AvatarArt> = {
  // You: a player in a yellow cap.
  you: {
    bg: "#26425e",
    palette: { K, c: "#ffd166", h: "#6b3e26", s: "#f2c79b", b: "#3a86ff" },
    rows: [
      "..............",
      "....KKKKKK....",
      "...KccccccK...",
      "..KccccccccK..",
      "..KKKKKKKKKKKK",
      "..KhssssssK...",
      "..KsssssssK...",
      "..KsKssKssK...",
      "..KsssssssK...",
      "..KssKKKssK...",
      "...KsssssK....",
      "..KKbbbbbKK...",
      ".KbbbbbbbbbK..",
      ".KbbbbbbbbbK..",
    ],
  },
  // Pebble: a sleepy stone that rarely takes risks.
  pebble: {
    bg: "#3d5a80",
    palette: { K, g: "#9aa5b1", w: "#dfe6ec", d: "#6c7781" },
    rows: [
      "..............",
      ".....KKKK.....",
      "...KKggggKK...",
      "..KggggggggK..",
      ".KgggwwgggggK.",
      ".KggwggggggdK.",
      ".KgKKggggKKdK.",
      ".KggggggggggK.",
      ".KggggggggggK.",
      ".KgggggKKggdK.",
      "..KggggggddK..",
      "...KKgggdKK...",
      ".....KKKK.....",
      "..............",
    ],
  },
  // Juniper: a fox who plays too many hands.
  juniper: {
    bg: "#2d6a4f",
    palette: { K, o: "#f08a24", w: "#fff4e0", d: "#b85f10" },
    rows: [
      "..............",
      ".K..........K.",
      ".KoK......KoK.",
      ".KodKKKKKKdoK.",
      ".KooooooooooK.",
      "KooooooooooooK",
      "KooKKooooKKooK",
      "KooooooooooooK",
      "KwwwooKKoowwwK",
      ".KwwwwwwwwwwK.",
      "..KwwwwwwwwK..",
      "...KKwwwwKK...",
      ".....KKKK.....",
      "..............",
    ],
  },
  // Blaze: a flame that loves to raise.
  blaze: {
    bg: "#5c1a1a",
    palette: { K, r: "#e4572e", y: "#ffd166", o: "#ff9f1c" },
    rows: [
      "......K.......",
      ".....KrK......",
      "..K..KrrK..K..",
      ".KrK.KrrK.KrK.",
      ".KrrKrrrrrKrrK",
      "KrrrrrrrrrrrrK",
      "KrroooooooorrK",
      "KroKyyyyyyKorK",
      "KroyKKyyKKyorK",
      "KroyyyyyyyyorK",
      ".KroyKKKKyorK.",
      "..KrroyyorrK..",
      "...KKrrrrKK...",
      ".....KKKK.....",
    ],
  },
  // Rook: a crow who plays it steady.
  rook: {
    bg: "#9aa7e6",
    palette: { K, p: "#4b3f72", P: "#2e2650", w: "#ffffff", y: "#f0a202" },
    rows: [
      "..............",
      "....KKKKK.....",
      "...KppppppK...",
      "..KppppppppK..",
      ".KppwKppppppK.",
      ".KppKKppppppK.",
      ".KpppppppppyyK",
      ".KppppppppyyyK",
      ".KpppppppppKK.",
      ".KpppPPPppppK.",
      "..KppPPPpppK..",
      "...KppppppK...",
      "....KyKKyK....",
      "..............",
    ],
  },
};

export interface AvatarChoice {
  key: string;
  name: string;
  space: boolean;
  group: AvatarGroup;
}

/** Every pickable avatar: the first set plus mutants, horror and aliens. */
const VARIANTS = [...FIRST_SET, ...MONSTER_VARIANTS];
const ALL_BASES = { ...BASES, ...MONSTER_BASES };
const GROUP_ORDER: AvatarGroup[] = ["space", "monster", "friends"];

export const AVATAR_GROUPS: { group: AvatarGroup; title: string }[] = [
  { group: "space", title: "Space" },
  { group: "monster", title: "Monsters" },
  { group: "friends", title: "Friends" },
];

/** Every avatar a player can pick: space, then monsters, then friends. */
export const AVATAR_CHOICES: AvatarChoice[] = [];

for (const v of VARIANTS) {
  const base = ALL_BASES[v.base]!;
  AVATARS[v.key] = { rows: base.rows, bg: v.bg, palette: { ...base.fixed, ...v.colors } };
  const group = base.group ?? (base.space ? "space" : "friends");
  AVATAR_CHOICES.push({ key: v.key, name: v.name, space: group === "space", group });
}
AVATAR_CHOICES.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));

export const DEFAULT_AVATAR = "cap-1";

// Older online seats used p0 to p4; keep them drawing.
["cap-1", "cap-2", "cap-3", "cap-4", "astronaut-2"].forEach((k, i) => (AVATARS[`p${i}`] = AVATARS[k]!));

/** An empty seat at an online table. */
AVATARS.open = { rows: [], palette: {}, bg: "transparent" };

/** Avatars a player may choose (not the bots' own faces). */
export function isAvatarKey(key: unknown): key is string {
  return typeof key === "string" && VARIANTS.some((v) => v.key === key);
}

export function avatarName(key: string): string {
  return VARIANTS.find((v) => v.key === key)?.name ?? "Avatar";
}

export function avatarSVG(key: string, scale = 3): string {
  const art = AVATARS[key] ?? AVATARS.you!;
  if (!art.rows.length) return "";
  return pixelSVG(art.rows, art.palette, scale, "avatar-art");
}

export function avatarBg(key: string): string {
  return (AVATARS[key] ?? AVATARS.you!).bg;
}
