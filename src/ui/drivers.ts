// Who makes the decisions for a seat. The table asks each seat's driver for an
// action and only ever hands it that seat's own view, so the same loop works
// for a person on this phone, a bot, and (later) a player on another device.

import { type BotStyle, decide } from "../engine/bot";
import type { Action, LegalActions, PlayerView } from "../engine/game";
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

/** The person holding this phone. The buttons resolve the pending decision. */
export class LocalDriver implements SeatDriver {
  readonly kind = "local";
  private pending: { legal: LegalActions; resolve: (a: Action) => void } | null = null;

  constructor(private onWaiting: () => void) {}

  decide(view: PlayerView): Promise<Action> {
    return new Promise((resolve) => {
      this.pending = { legal: view.legal!, resolve };
      this.onWaiting();
    });
  }

  /** Legal actions while waiting for the player, otherwise null. */
  get waitingFor(): LegalActions | null {
    return this.pending?.legal ?? null;
  }

  submit(action: Action): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(action);
  }

  cancel(): void {
    this.pending = null;
  }
}
