/**
 * The HUD on macOS: the `reticle-hud` program draws it. One line of JSON goes to the program for
 * each thing to show, and the program writes one line when the person presses "Pause".
 */
import { spawn } from 'node:child_process';

import { z } from 'zod';

import type { HudEffect, HudPort } from '../hud/port.js';

const Say = { APP: 'app', MOVE: 'move', ACT: 'act', EFFECT: 'effect' } as const;
const PausedSchema = z.object({ paused: z.boolean() });

export function macHud(program: string): HudPort {
  const child = spawn(program, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  // The window must not keep the command open, and a window that is gone must not break an action.
  child.unref();
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  let paused = false;
  let rest = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString('utf8')).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const said = PausedSchema.safeParse(JSON.parse(line));
        if (said.success) {
          paused = said.data.paused;
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
    act: (text) => {
      send({ t: Say.ACT, text });
    },
    effect: (text, kind: HudEffect) => {
      send({ t: Say.EFFECT, text, kind });
    },
    paused: () => paused,
    close: () => {
      child.stdin.end();
    },
  };
}
