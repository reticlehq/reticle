import { renderFrame, type HudPhase, type HudState } from './frame.js';
import type { Change } from '../workspace/snapshot.js';
import type { ExitStatus } from '../process/supervisor.js';

/**
 * The screen half: hold the state, paint it, repaint in place.
 *
 * Split from `renderFrame` so the frame stays a pure function of state. Everything that makes a
 * terminal a terminal -- cursor control, a repaint timer, whether there is even a TTY -- lives
 * here, and none of it can leak into what the pane SAYS.
 *
 * It is a SUBSCRIBER and never a participant. It reads events, holds no opinion, and cannot change
 * what happens: closing the pane leaves the run identical. A view that could affect the subject
 * would be an observer contaminating its own observation, which is the confusion this project
 * exists to refuse.
 */

/** What the pane needs to hear. Everything else about a run is the artifact's business. */
export type HudEvent =
  | { kind: 'started'; command: string; argv: readonly string[]; watching: readonly string[] }
  | { kind: 'stdout'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'changed'; changes: readonly Change[] }
  | { kind: 'dialled'; host: string; port: number }
  | { kind: 'ended'; exit: ExitStatus | undefined }
  | { kind: 'verdict'; verdict: HudState['verdict'] };

export interface LiveHudInput {
  readonly expectation: string;
  readonly workspaceRoot: string;
  /** Injected, so the elapsed time in a frame is reproducible in a test. */
  readonly now: () => number;
  /** Where to paint. Absent means nowhere, which is how a non-interactive run stays silent. */
  readonly write?: (frame: string) => void;
}

export interface LiveHud {
  send(event: HudEvent): void;
  /** The current frame, for a caller that wants the text rather than the screen. */
  frame(): string;
  stop(): void;
}

/** The terminal control codes this pane uses, named so no reader has to decode them. */
const ESC = String.fromCharCode(27);
const cursorUp = (n: number): string => `${ESC}[${String(n)}A`;
const clearBelow = `${ESC}[0J`;

/**
 * Repaint by rewinding exactly as many lines as were painted.
 *
 * Not a screen clear, which throws away scrollback somebody may be reading, and not a fresh block
 * per tick, which fills a terminal with hundreds of near-identical frames and makes the run
 * unreadable afterwards.
 */
function repainter(write: (s: string) => void): (frame: string) => void {
  let painted = 0;
  return (frame) => {
    const rewind = painted > 0 ? `${cursorUp(painted)}${clearBelow}` : '';
    write(`${rewind}${frame}\n`);
    painted = frame.split('\n').length + 1;
  };
}

export function createLiveHud(input: LiveHudInput): LiveHud {
  const startedAt = input.now();
  let phase: HudPhase = 'running';
  const state = {
    expectation: input.expectation,
    command: '',
    argv: [] as readonly string[],
    watching: [] as readonly string[],
    stdout: [] as string[],
    stderr: [] as string[],
    changes: [] as readonly Change[],
    dials: [] as { host: string; port: number }[],
    exit: undefined as ExitStatus | undefined,
    verdict: undefined as HudState['verdict'],
  };

  const paint = input.write === undefined ? undefined : repainter(input.write);
  const build = (): HudState => ({
    ...state,
    elapsedMs: input.now() - startedAt,
    phase,
    workspaceRoot: input.workspaceRoot,
  });

  /*
   * A ticking repaint, so elapsed time and the spinner move while a slow tool is thinking.
   * Without it the pane freezes on a tool that takes twenty seconds to say anything, which reads
   * as a hang rather than as work. Unref'd: a view must never hold a process open.
   */
  const timer =
    paint === undefined
      ? undefined
      : setInterval(() => {
          if ('running' === phase) paint(renderFrame(build()));
        }, 120);
  timer?.unref?.();

  return {
    send(event) {
      switch (event.kind) {
        case 'started':
          state.command = event.command;
          state.argv = event.argv;
          state.watching = event.watching;
          break;
        case 'stdout':
          state.stdout.push(event.text);
          break;
        case 'stderr':
          state.stderr.push(event.text);
          break;
        case 'changed':
          state.changes = event.changes;
          break;
        case 'dialled':
          state.dials.push({ host: event.host, port: event.port });
          break;
        case 'ended':
          state.exit = event.exit;
          phase = 'done';
          break;
        case 'verdict':
          state.verdict = event.verdict;
          phase = 'done';
          break;
      }
      paint?.(renderFrame(build()));
    },
    frame: () => renderFrame(build()),
    stop() {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
