/**
 * The HUD on macOS: the `reticle-hud` program draws it. One line of JSON goes to the program for
 * each thing to show, and the program writes one line when the person presses "Pause".
 */
import { spawn } from 'node:child_process';

import { z } from 'zod';

import type { HudEffect, HudPort } from '../hud/port.js';

const Say = { APP: 'app', MOVE: 'move', GLOW: 'glow', ACT: 'act', EFFECT: 'effect' } as const;
const SaidSchema = z.object({ paused: z.boolean().optional(), stopped: z.boolean().optional() });

export function macHud(program: string, onStop?: () => void): HudPort {
  const child = spawn(program, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  // The window must not keep the command open, and a window that is gone must not break an action.
  child.unref();
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  let paused = false;
  let stopped = false;
  let rest = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString('utf8')).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const said = SaidSchema.safeParse(JSON.parse(line));
        if (said.success) {
          paused = said.data.paused ?? paused;
          if (true === said.data.stopped && !stopped) {
            stopped = true;
            onStop?.();
          }
        }
      } catch {
        // Not a line of the program's protocol: nothing to learn from it.
      }
    }
  });
  const send = (message: Record<string, unknown>): void => {
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };
  return {
    app: (name) => {
      send({ t: Say.APP, name });
    },
    move: (x, y) => {
      send({ t: Say.MOVE, x, y });
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
    paused: () => paused,
    stopped: () => stopped,
    close: () => {
      child.stdin.end();
    },
  };
}
