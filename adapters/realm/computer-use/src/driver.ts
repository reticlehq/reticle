/**
 * What the realm needs from an operating system: read an application, and act on one element.
 * The realm knows the application only through this port, so a test gives it a driver that is
 * not a real application.
 */
import type { Placed, UiNode } from './ui-node.js';

export const ActKind = {
  PRESS: 'press',
  /** Puts a value in the element. No key event is sent. */
  SET: 'set',
  /** Key events, one for each character of `value`. */
  TYPE: 'type',
  /** One key with its modifiers: `Return`, `Meta+s`. */
  KEY: 'key',
  /** The menu that a right-click gives, asked for by name. No pointer is used. */
  MENU: 'menu',
  /** Brings the application to the front and gives the element the keyboard. Foreground only. */
  RAISE: 'raise',
  /** The real pointer, at the middle of the element. Foreground only, each of these. */
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  RIGHTCLICK: 'rightclick',
  /** Moves the pointer to the element and leaves it there. */
  HOVER: 'hover',
  /** From the element to the point in `value`, as "x,y" on the screen. */
  DRAG: 'drag',
} as const;
export type ActKind = (typeof ActKind)[keyof typeof ActKind];

/** How an action reaches its element. */
export const Delivery = {
  /** Only when a person could click the element. The default. */
  USER_PATH: 'user-path',
  /** Also when the element is under another view or window. It proves less. */
  DIRECT: 'direct',
  /**
   * The application is brought to the front and the real pointer is used. It takes the pointer
   * and the keyboard of the person at the machine for a moment, and puts them back.
   */
  FOREGROUND: 'foreground',
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
  /** The action needs the real pointer, and the caller did not ask for the foreground. */
  NEEDS_FOREGROUND: 'needs-foreground',
  /**
   * The foreground was asked for while the person at the machine was typing or moving the
   * pointer. Their input would have gone to the application that is brought to the front.
   */
  PERSON_ACTIVE: 'person-active',
  /**
   * Real keys were asked for, and the application did not take the keyboard. A real key goes to
   * whatever application has it, so none was sent.
   */
  NO_KEYBOARD: 'no-keyboard',
} as const;
export type ActRefusal = (typeof ActRefusal)[keyof typeof ActRefusal];

export interface UiRead {
  root: UiNode;
  /** Elements the operating system refused to describe. More than zero means holes in the tree. */
  unread: number;
  /** Roles the reader does not know. Each such element is kept, as a `group`. */
  unmapped: readonly string[];
  /**
   * Windows of the application that are not on the screen now: on another Space, or made small.
   * The reader cannot read them. Absent when the reader does not know.
   */
  windowsNotOnScreen?: number;
}

export interface ActRequest {
  target: Placed;
  kind: ActKind;
  value?: string;
  delivery: Delivery;
  budgetMs: number;
  /**
   * How long the application must show no change before the action is called finished. Absent:
   * the driver's own time. A caller gives a shorter time only when it goes on looking after the
   * action, so that a later change is still seen.
   */
  quietMs?: number;
  /** Folders where a written file is an effect too. The wait ends when they and the tree are quiet. */
  watch: readonly string[];
}

export interface SettingChange {
  key: string;
  old: string;
  new: string;
  /** The values are longer than what is given here. They were compared whole. */
  cut?: boolean;
}

export interface ActOutcome {
  refused?: ActRefusal;
  /** More about a refusal: for `unreachable`, the element that is on top. */
  detail?: string;
  /** The operating system accepted the action. It says nothing about an effect. */
  delivered: boolean;
  /**
   * The application ended while the action ran: it quit, or it crashed. `delivered` is then not
   * to be believed: the application can end before it answers a press that it took.
   */
  appGone?: true;
  /** A person who clicks the middle of the element reaches it. */
  reachable: boolean;
  /** Two reads in a row agreed before the budget ran out. */
  settled: boolean;
  before: UiRead;
  after: UiRead;
  /**
   * The bytes that the application's process, and the processes it started, wrote to disk in the
   * action, as the operating system counts them. Zero says that they wrote nothing. It does not
   * say that no file was written: a helper that the system runs for the application is not
   * counted. Absent: the driver cannot count.
   */
  bytesWritten?: number;
  /**
   * The settings of the application that are different after the action. An empty list says that
   * the settings were read and none changed. Absent: the settings cannot be read from outside the
   * application (an application in a sandbox), and nothing is known about them.
   */
  settingsChanged?: readonly SettingChange[];
  /**
   * Something was put on the clipboard in the action. The driver reads only that it changed, never
   * what is on it. Absent: the driver cannot tell.
   */
  clipboardChanged?: boolean;
}

/** Whether a person can see and click an element now. */
export const Reach = {
  YES: 'yes',
  /** Another element is on top of it: a view in the same window, or another window. */
  NO: 'no',
  /** The operating system did not answer. Nothing is known. */
  UNKNOWN: 'unknown',
} as const;
export type Reach = (typeof Reach)[keyof typeof Reach];

export interface ReachAnswer {
  reach: Reach;
  /** For `no`: what is on top. For `unknown`: why. */
  detail?: string;
}

export interface UiDriver {
  /** The application and the process: `Notes` and `4312`. */
  subject(): { app: string; pid: number };
  read(): Promise<UiRead>;
  /** Asks about one element of the last read, and acts on nothing. */
  reach(target: Placed): Promise<ReachAnswer>;
  act(request: ActRequest): Promise<ActOutcome>;
  /**
   * A picture of the application's own window, as a PNG file. Absent: this driver takes none.
   * For an application that gives no elements, the picture is what a caller reads.
   */
  capture?(how?: CaptureHow): Promise<Captured>;
}

/** What a picture shows. Absent `screen`: the window of the application only. */
export interface CaptureHow {
  /** The whole display that holds the application, with every application on it. */
  screen?: boolean;
}

/** A picture that was taken, or the reason there is none. */
export type Captured =
  | {
      ok: true;
      path: string;
      /** What the picture shows on the screen, in points: x, y, width, height. */
      window: readonly [number, number, number, number];
      /** The pixels of the picture for each point of the screen. */
      scale: number;
      /** The application's window when the picture was taken. Absent: the picture is that window. */
      appWindow?: readonly [number, number, number, number];
    }
  | { ok: false; reason: string };
