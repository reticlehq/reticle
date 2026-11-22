/**
 * What the person at the machine sees of the realm: a pointer of the realm's own, and a small
 * window that says what the realm does and what that did. The port has no window in it: the
 * macOS one starts a program that draws, and a test gives a list.
 */
export const HudEffect = { OK: 'ok', NONE: 'none', REFUSED: 'refused' } as const;
export type HudEffect = (typeof HudEffect)[keyof typeof HudEffect];

export interface HudPort {
  /** The application that is joined. */
  app(name: string): void;
  /** The pointer goes to this point of the screen: the middle of the element to act on. */
  move(x: number, y: number): void;
  /** A glow round the window the realm works in: x, y, width, height on the screen. */
  glow(frame: readonly [number, number, number, number]): void;
  /** What the realm does now, in a few words. */
  act(text: string): void;
  /** What that did. */
  effect(text: string, kind: HudEffect): void;
  /** The person pressed "Pause" in the window. The realm then does no action. */
  paused(): boolean;
  /** The person pressed "Stop" in the window. The realm does no action after it, and leaves. */
  stopped(): boolean;
  close(): void;
  /**
   * Whose turn it is, from the agent's `yield`: tone "ask" is the person's turn, with the question
   * in `text`. Absent: this HUD shows no turn.
   */
  turn?(turn: HudTurn): void;
  /** Calls `listener` when the person presses "Done" at the end of their turn. */
  onDone?(listener: () => void): void;
}

/** The state of the session, as the agent's `yield` set it. */
export interface HudTurn {
  state: string;
  tone?: string;
  text?: string;
}
