/**
 * The HUD on macOS: the `reticle-hud` program draws it. One line of JSON goes to the program for
 * each thing to show, and the program writes one line when the person presses "Pause", "Stop", or
 * "Done" at the end of their turn.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { z } from 'zod';

import type { HudEffect, HudPort } from '../hud/port.js';

const Say = {
  APP: 'app',
  MOVE: 'move',
  GLOW: 'glow',
  ACT: 'act',
  EFFECT: 'effect',
  TURN: 'turn',
} as const;
const SaidSchema = z.object({
  paused: z.boolean().optional(),
  stopped: z.boolean().optional(),
  done: z.boolean().optional(),
});

/** The glide of the pointer to a near control, and the longest one, across the screen. */
export const GLIDE_SHORTEST = 80;
export const GLIDE_LONGEST = 250;
/** How much longer the glide is for each point of the way. */
const GLIDE_MS_PER_POINT = 0.12;

/**
 * How long the pointer takes to go from one place to another, as a hand takes longer for a longer
 * way. From no place (the pointer is not on the screen yet) it shows at the place at once.
 */
export function glideMs(
  from: readonly [number, number] | undefined,
  to: readonly [number, number],
): number {
  if (from === undefined) {
    return 0;
  }
  const way = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return Math.round(Math.min(GLIDE_LONGEST, GLIDE_SHORTEST + way * GLIDE_MS_PER_POINT));
}

/** The most times the program is started again: one that ends at each start is left ended. */
const RESTARTS = 5;

export function macHud(program: string, onStop?: () => void): HudPort {
  let paused = false;
  let stopped = false;
  let closed = false;
  let restarts = 0;
  /** The application the HUD shows. A program that is started again is told it again. */
  let app: string | undefined;
  /** Where the pointer is. Absent: it is not on the screen yet. */
  let at: [number, number] | undefined;
  const onDone: (() => void)[] = [];
  const hear = (line: string): void => {
    try {
      const said = SaidSchema.safeParse(JSON.parse(line));
      if (said.success) {
        paused = said.data.paused ?? paused;
        if (true === said.data.done) {
          onDone.forEach((listener) => {
            listener();
          });
        }
        if (true === said.data.stopped && !stopped) {
          stopped = true;
          onStop?.();
        }
      }
    } catch {
      // Not a line of the program's protocol: nothing to learn from it.
    }
  };
  const start = (): ChildProcessByStdio<Writable, Readable, null> => {
    const started = spawn(program, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    // The window must not keep the command open, and a window that is gone must not break an action.
    started.unref();
    started.on('error', () => undefined);
    started.stdin.on('error', () => undefined);
    let rest = '';
    started.stdout.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      lines.forEach(hear);
    });
    // The pointer is the program's window. A program that ended (it crashed, or it was quit) took
    // the pointer away for the rest of the session. It is started again, unless the person
    // stopped Reticle or the session closed it.
    started.on('exit', () => {
      if (closed || stopped || restarts >= RESTARTS) {
        return;
      }
      restarts += 1;
      child = start();
      if (app !== undefined) {
        send({ t: Say.APP, name: app });
      }
    });
    return started;
  };
  let child = start();
  const send = (message: Record<string, unknown>): void => {
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };
  return {
    app: (name) => {
      app = name;
      send({ t: Say.APP, name });
    },
    move: (x, y) => {
      const ms = glideMs(at, [x, y]);
      at = [x, y];
      send({ t: Say.MOVE, x, y, ms });
      return new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      });
    },
    glow: ([x, y, w, h]) => {
      send({ t: Say.GLOW, x, y, w, h });
    },
    act: (text) => {
      send({ t: Say.ACT, text });
    },
    effect: (text, kind: HudEffect) => {
      send({ t: Say.EFFECT, text, kind });
    },
    turn: ({ state, tone, text }) => {
      send({
        t: Say.TURN,
        state,
        ...(tone === undefined ? {} : { tone }),
        ...(text === undefined ? {} : { text }),
      });
    },
    onDone: (listener) => {
      onDone.push(listener);
    },
    paused: () => paused,
    stopped: () => stopped,
    close: () => {
      closed = true;
      child.stdin.end();
    },
  };
}
