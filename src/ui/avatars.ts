// Pixel-art portraits, 14 x 14, drawn for this project.

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

export function avatarSVG(key: string, scale = 3): string {
  const art = AVATARS[key] ?? AVATARS.you!;
  return pixelSVG(art.rows, art.palette, scale, "avatar-art");
}

export function avatarBg(key: string): string {
  return (AVATARS[key] ?? AVATARS.you!).bg;
}
