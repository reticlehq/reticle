/**
 * Which session to use for what, when a desktop application and a page are both connected.
 *
 * A computer-use session reads an application through the operating system. An SDK session is
 * inside its app. One agent can hold both, and the list said nothing about the difference: an
 * agent then drove a page through the desktop session, which sees no network, no state and no
 * source file, or it looked in the page for a dialog that belongs to the system.
 */
import { COMPUTER_USE_RUNTIME } from '@reticlehq/core';
import { z } from 'zod';

export const REALMS_FIELD = 'realms';
/** The role a desktop session is asked for, to get the names of its windows. */
const WINDOW_ROLE = 'window';

const REALMS_DESCRIPTION =
  'Present only when a desktop application (computer use) and an app with the Reticle SDK are both connected. Says which session to use for what, and how to pass work from one to the other.';

const SAME_PAGE_DESCRIPTION =
  'A window of a desktop session whose name holds the title of the page of an insideTheApp session. It is likely the same page, matched by title alone: drive the page with the insideTheApp session, and use the desktop session for what is round it.';

export const REALMS_OUTPUT = {
  [REALMS_FIELD]: z
    .object({
      desktop: z.array(z.string()),
      insideTheApp: z.array(z.string()),
      rule: z.string(),
      samePage: z
        .array(z.object({ desktop: z.string(), insideTheApp: z.string(), window: z.string() }))
        .optional()
        .describe(SAME_PAGE_DESCRIPTION),
    })
    .optional()
    .describe(REALMS_DESCRIPTION),
};

export const CAPABILITIES_FIELD = 'capabilities';

/** What a session is, for a plan that routes each step to one. */
export const CapabilityRealm = {
  /** A page read from the inside, by the SDK or the extension: network, state, source. */
  BROWSER: 'browser',
  /** A whole application, read through the operating system (computer use). */
  DESKTOP: 'desktop',
} as const;
export type CapabilityRealm = (typeof CapabilityRealm)[keyof typeof CapabilityRealm];

const APP_SCHEME = 'app:';

export const CAPABILITIES_OUTPUT = {
  [CAPABILITIES_FIELD]: z
    .array(
      z.object({
        sessionId: z.string(),
        realm: z.enum([CapabilityRealm.BROWSER, CapabilityRealm.DESKTOP]),
        url: z.string().optional(),
        app: z.string().optional(),
        platform: z.string().optional(),
      }),
    )
    .optional()
    .describe(
      'Each connected session, for a plan that routes steps: `browser` reads a page from the inside (give it the steps on its url), `desktop` reads a whole application through the operating system (give it the steps in `app`, a system dialog, or a page that no browser session is on).',
    ),
};

/**
 * Each session as a plan sees it: the realm, and the page or the application it acts on. A desktop
 * session names its application in its url (`app://Slack/`). `platform` is the operating system of
 * the machine of the bridge, where every desktop session runs.
 */
export function capabilitiesOf(
  sessions: readonly { sessionId: string; url?: string; runtime?: string }[],
  platform: string,
): {
  sessionId: string;
  realm: CapabilityRealm;
  url?: string;
  app?: string;
  platform?: string;
}[] {
  return sessions.map((s) => {
    if (COMPUTER_USE_RUNTIME !== s.runtime) {
      return {
        sessionId: s.sessionId,
        realm: CapabilityRealm.BROWSER,
        ...(s.url === undefined ? {} : { url: s.url }),
      };
    }
    let app: string | undefined;
    try {
      const url = new URL(s.url ?? '');
      app = APP_SCHEME === url.protocol ? decodeURIComponent(url.host) : undefined;
    } catch {
      app = undefined;
    }
    return {
      sessionId: s.sessionId,
      realm: CapabilityRealm.DESKTOP,
      ...(app === undefined ? {} : { app }),
      platform,
    };
  });
}

export const REALMS_RULE =
  'Two kinds of session are connected. Use an insideTheApp session first for the page of its app: it sees the network, the state and the source file. Use a desktop session for what is outside that page: another application, a system dialog, a file panel, a window of the operating system. To pass work across, end your step in one session with a consequence you can check in the other, then send the next call with the other sessionId. Give sessionId on every call.';

/** The two kinds of session, and the rule for choosing. Absent unless both kinds are connected. */
export function realmsOf(
  sessions: readonly { sessionId: string; runtime?: string }[],
): { desktop: string[]; insideTheApp: string[]; rule: string } | undefined {
  const desktop = sessions
    .filter((s) => COMPUTER_USE_RUNTIME === s.runtime)
    .map((s) => s.sessionId);
  const insideTheApp = sessions
    .filter((s) => COMPUTER_USE_RUNTIME !== s.runtime)
    .map((s) => s.sessionId);
  if (0 === desktop.length || 0 === insideTheApp.length) {
    return undefined;
  }
  return { desktop, insideTheApp, rule: REALMS_RULE };
}

/** The fewest letters of a title that make a pair. A shorter title is in too many window names. */
const TITLE_LETTERS = 4;

/**
 * The pairs of a desktop window and a page with the SDK that are likely the same page: the name
 * of the window holds the title of the page. A browser names its window after the page.
 */
export function samePage(
  pages: readonly { sessionId: string; title?: string }[],
  windows: ReadonlyMap<string, readonly string[]>,
): { desktop: string; insideTheApp: string; window: string }[] {
  const pairs: { desktop: string; insideTheApp: string; window: string }[] = [];
  for (const page of pages) {
    const title = page.title;
    if (title === undefined || title.length < TITLE_LETTERS) {
      continue;
    }
    for (const [desktop, names] of windows) {
      const window = names.find((name) => name.includes(title));
      if (window !== undefined) {
        pairs.push({ desktop, insideTheApp: page.sessionId, window });
      }
    }
  }
  return pairs;
}

const WindowsAnswer = z.object({ elements: z.array(z.object({ name: z.string() })) });

/**
 * The rule, and the pairs of the same page. It asks each desktop session for the names of its
 * windows. A session that does not answer gets no pair: the rule is still true without it.
 */
export async function realmsWithPairs(
  sessions: readonly { sessionId: string; runtime?: string; title?: string }[],
  query: (sessionId: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<
  | {
      desktop: string[];
      insideTheApp: string[];
      rule: string;
      samePage?: ReturnType<typeof samePage>;
    }
  | undefined
> {
  const realms = realmsOf(sessions);
  if (realms === undefined) {
    return undefined;
  }
  const windows = new Map<string, string[]>();
  for (const id of realms.desktop) {
    const answer = WindowsAnswer.safeParse(
      await query(id, { role: WINDOW_ROLE }).catch(() => undefined),
    );
    if (answer.success) {
      windows.set(
        id,
        answer.data.elements.map((e) => e.name),
      );
    }
  }
  const pairs = samePage(
    sessions.filter((s) => realms.insideTheApp.includes(s.sessionId)),
    windows,
  );
  return 0 === pairs.length ? realms : { ...realms, samePage: pairs };
}

/** What the session list adds after its rows: the realms rule and the capabilities. */
export const SESSION_LIST_EXTRAS_OUTPUT = { ...REALMS_OUTPUT, ...CAPABILITIES_OUTPUT };

export async function sessionListExtras(
  sessions: readonly { sessionId: string; url?: string; runtime?: string; title?: string }[],
  query: (sessionId: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const realms = await realmsWithPairs(sessions, query);
  return {
    ...(realms === undefined ? {} : { [REALMS_FIELD]: realms }),
    [CAPABILITIES_FIELD]: capabilitiesOf(sessions, process.platform),
  };
}
