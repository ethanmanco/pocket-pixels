// Who makes the decisions for a bot seat in solo play. A bot only ever gets
// its own seat's view. (Online, the server runs the bots; see src/online/room.ts.)

import { type BotStyle, decide } from "../engine/bot";
import type { Action, PlayerView } from "../engine/game";
import { Rng } from "../engine/rng";
import { sleep } from "./timing";

export interface SeatDriver {
  readonly kind: "local" | "bot" | "remote";
  decide(view: PlayerView): Promise<Action>;
  /** Stop waiting (for example when the table is reset). */
  cancel?(): void;
}


export class BotDriver implements SeatDriver {
  readonly kind = "bot";
  constructor(
    private style: BotStyle,
    private rng: Rng,
    /** Pause before acting so it feels like someone is thinking. */
    private thinkMs: () => number,
  ) {}

  async decide(view: PlayerView): Promise<Action> {
    const started = performance.now();
    const action = decide(view, this.style, this.rng);
    const wait = this.thinkMs() - (performance.now() - started);
    if (wait > 0) await sleep(wait);
    return action;
  }
}
