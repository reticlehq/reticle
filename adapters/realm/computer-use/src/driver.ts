/**
 * What the realm needs from an operating system: read an application, and act on one element.
 * The realm knows the application only through this port, so a test gives it a driver that is
 * not a real application.
 */
import type { Placed, UiNode } from './ui-node.js';

export const ActKind = { PRESS: 'press', SET: 'set' } as const;
export type ActKind = (typeof ActKind)[keyof typeof ActKind];

/** How an action reaches its element. */
export const Delivery = {
  /** Only when a person could click the element. The default. */
  USER_PATH: 'user-path',
  /** Also when the element is under another view or window. It proves less. */
  DIRECT: 'direct',
} as const;
export type Delivery = (typeof Delivery)[keyof typeof Delivery];

export const ActRefusal = {
  /** A different element is where the chosen one was. */
  STALE: 'stale',
  DISABLED: 'disabled',
  /** A person could not click it, and the caller did not ask for a direct action. */
  UNREACHABLE: 'unreachable',
  /** The operating system did not say whether a person could click it. Nothing is known. */
  REACH_UNKNOWN: 'reach-unknown',
} as const;
export type ActRefusal = (typeof ActRefusal)[keyof typeof ActRefusal];

export interface UiRead {
  root: UiNode;
  /** Elements the operating system refused to describe. More than zero means holes in the tree. */
  unread: number;
  /** Roles the reader does not know. Each such element is kept, as a `group`. */
  unmapped: readonly string[];
}

export interface ActRequest {
  target: Placed;
  kind: ActKind;
  value?: string;
  delivery: Delivery;
  budgetMs: number;
  /** Folders where a written file is an effect too. The wait ends when they and the tree are quiet. */
  watch: readonly string[];
}

export interface ActOutcome {
  refused?: ActRefusal;
  /** More about a refusal: for `unreachable`, the element that is on top. */
  detail?: string;
  /** The operating system accepted the action. It says nothing about an effect. */
  delivered: boolean;
  /** A person who clicks the middle of the element reaches it. */
  reachable: boolean;
  /** Two reads in a row agreed before the budget ran out. */
  settled: boolean;
  before: UiRead;
  after: UiRead;
}

export interface UiDriver {
  /** The application and the process: `Notes` and `4312`. */
  subject(): { app: string; pid: number };
  read(): Promise<UiRead>;
  act(request: ActRequest): Promise<ActOutcome>;
}
