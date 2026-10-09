/**
 * The platform's Harness, seen from the daemon: the platform decides, this machine executes.
 *
 * Every turn is one HTTPS request this daemon makes: it posts what the last calls did, and the
 * platform answers with the next calls, chosen by its own model, persona and verification mode. The
 * loop around it (`runHarness`) is unchanged: it executes the calls through Reticle's own tools and
 * hands the outcomes back here. Nothing is held open between turns, a lost response is retried with
 * the same turn number, and the platform answers that from its record without a second model call.
 *
 * This is the only Harness driver: every decision is the platform's, for a workspace with a plan or
 * trial. A secret field travels by name only, and its value is filled in here before the call runs.
 */
import { ReticleEnv, cloudUrlFrom } from '@reticlehq/core';
import {
  DriveStoppedError,
  type HarnessTool,
  type ModelDriver,
  type ModelTurn,
  type ToolOutcome,
  type ToolRequest,
} from '../harness.js';
import { DRIVE_HEADER } from '../platform-config.js';

export { DRIVE_HEADER };

export const SERVER_DRIVER_NAME = 'server';
const RUNS_PATH = '/v1/harness/runs';
const TURN_TIMEOUT_MS = 110_000;
const RETRIES = 1;
/** The platform's code for a run whose project had autonomous driving switched off. */
const HARNESS_OFF = 'harness_off';
const FINISH = 'finish';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ServerDriverOptions {
  url: string;
  apiKey: string;
  persona?: string;
  /** The goal a drive with no persona is for: the platform names its flows after it. */
  journey?: string;
  /** journey | brute-force | stress | madman | security. The platform defaults to journey. */
  mode?: string;
  /** What `.reticle` already knows, as text: saved journeys and open intents. */
  plan?: string;
  /** The same plan, structured, for the platform's Jev engine. */
  planSteps?: readonly { kind: string; target: string; why: string }[];
  /** The signal names the app declares, so the engine can claim one by name. */
  vocabulary?: readonly string[];
  /** Where secret field values live. Only their NAMES go to the platform. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  maxSteps?: number;
  /** The free drive this run is billed to, sent as `DRIVE_HEADER` on every turn. */
  driveId?: string;
  fetch?: FetchLike;
}

interface TurnReply {
  turn: number;
  calls: ToolRequest[];
  text: string;
  done: boolean;
  status: string;
  summary?: string;
  goalMet?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Where to reach the platform, as which key, and for which free drive when there is one. */
export interface PlatformCredential {
  url: string;
  apiKey: string;
  driveId?: string;
}

/** The platform's url and this project's key, when the machine is linked. */
export function serverOptionsFromEnv(
  env: Record<string, string | undefined>,
): PlatformCredential | undefined {
  const url = cloudUrlFrom(env);
  const apiKey = env[ReticleEnv.API_KEY];
  const driveId = env[ReticleEnv.DRIVE_ID];
  return url === undefined || apiKey === undefined || 0 === apiKey.length
    ? undefined
    : {
        url: url.replace(/\/+$/, ''),
        apiKey,
        ...(driveId === undefined || 0 === driveId.length ? {} : { driveId }),
      };
}

/** The headers every Harness call carries: JSON, the key, and the free drive it is billed to. */
export function platformHeaders(platform: {
  apiKey: string;
  driveId?: string | undefined;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${platform.apiKey}`,
    ...(platform.driveId === undefined ? {} : { [DRIVE_HEADER]: platform.driveId }),
  };
}

export class ServerHarnessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function serverDriver(options: ServerDriverOptions): ModelDriver {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let runId: string | undefined;
  let turn = 0;
  let seen = 0;

  const call = async (path: string, body: unknown): Promise<unknown> => {
    let last: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const res = await doFetch(`${options.url}${path}`, {
          method: 'POST',
          headers: platformHeaders(options),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) {
          const refusal = refusalOf(text);
          const message = refusal.message ?? `the platform answered ${String(res.status)}`;
          // A person turned it off: the drive ends, and the result says that rather than "broken".
          if (HARNESS_OFF === refusal.code) throw new DriveStoppedError(message);
          // A refusal is an answer; only a network failure is worth asking again.
          throw new ServerHarnessError(message, res.status);
        }
        return JSON.parse(text) as unknown;
      } catch (error) {
        if (error instanceof ServerHarnessError || error instanceof DriveStoppedError) throw error;
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };

  return {
    async turn(input): Promise<ModelTurn> {
      if (runId === undefined) {
        const started = (await call(RUNS_PATH, {
          ...(options.persona === undefined ? {} : { persona: options.persona }),
          ...(options.journey === undefined ? {} : { journey: options.journey }),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.plan === undefined ? {} : { plan: options.plan }),
          ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
          ...(options.planSteps === undefined ? {} : { planSteps: options.planSteps }),
          ...(options.vocabulary === undefined ? {} : { vocabulary: options.vocabulary }),
          secrets: secretNames(options.env ?? process.env),
          tools: input.tools.filter((t) => FINISH !== t.name).map(toolSpec),
        })) as { runId?: unknown };
        if ('string' !== typeof started.runId)
          throw new ServerHarnessError('the platform started no run', 502);
        runId = started.runId;
      }
      // Only what happened since the last turn: the platform holds everything before it.
      const fresh = input.history.slice(seen);
      seen = input.history.length;
      const outcomes = fresh.flatMap((entry) =>
        'tool' === entry.role ? entry.outcomes.map(outcomeOf) : [],
      );
      // What somebody said to the drive since the last turn. The opening line is the loop's own and
      // the platform writes its own, so only words that arrived after it travel.
      const say = fresh.flatMap((entry, i) =>
        'user' === entry.role && (0 < turn || 0 < i) ? [entry.text] : [],
      );
      const reply = (await call(`${RUNS_PATH}/${encodeURIComponent(runId)}/turn`, {
        turn,
        outcomes,
        ...(0 === say.length ? {} : { say }),
      })) as TurnReply;
      turn = reply.turn + 1;
      // The platform's spend, reported so the drive's cost is visible here as it is for a local one.
      const usage = reply.usage === undefined ? {} : { usage: reply.usage };
      if (reply.done) {
        // The platform has finished: `finish` ends the local loop the same way a local model would.
        return {
          text: reply.text,
          ...usage,
          calls: [
            {
              id: `server-finish-${String(reply.turn)}`,
              name: FINISH,
              args: {
                summary: reply.summary ?? reply.text,
                ...('boolean' === typeof reply.goalMet ? { goalMet: reply.goalMet } : {}),
              },
            },
          ],
        };
      }
      // A field the platform knows only by name is filled here, from this machine, and never sent.
      const env = options.env ?? process.env;
      return {
        text: reply.text,
        calls: reply.calls.map((c) => ({ ...c, args: withSecrets(c.args, env) })),
        ...usage,
      };
    },
  };
}

function toolSpec(tool: HarnessTool): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function outcomeOf(o: ToolOutcome): {
  id: string;
  name: string;
  result: unknown;
  isError: boolean;
} {
  return { id: o.id, name: o.name, result: o.result, isError: o.isError };
}

/**
 * The refusal's code and message. Two shapes reach here: `{ error: { code, message } }` from most
 * routes, and the card wall's flat `{ error: 'needs_card', message }`. Reading only the first lost
 * the credits sentence of every mid-drive card wall to "the platform answered 402".
 */
function refusalOf(text: string): { code?: string; message?: string } {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const nested =
      'object' === typeof body.error && null !== body.error
        ? (body.error as { code?: unknown; message?: unknown })
        : {};
    const code = 'string' === typeof body.error ? body.error : nested.code;
    const message = 'string' === typeof nested.message ? nested.message : body.message;
    return {
      ...('string' === typeof code ? { code } : {}),
      ...('string' === typeof message ? { message } : {}),
    };
  } catch {
    return {};
  }
}

/** The prefix of a variable holding one secret field: `RETICLE_SECRET_AUTH_PASSWORD`. */
const SECRET_ENV_PREFIX = 'RETICLE_SECRET_';
/** What the platform types into a field whose secret this machine holds. */
const SECRET_PLACEHOLDER = 'reticle-secret:';

/** The secret fields this machine can fill, by name only. */
export function secretNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith(SECRET_ENV_PREFIX) && 0 < (env[key] ?? '').length)
    .map((key) => key.slice(SECRET_ENV_PREFIX.length));
}

/** The call's arguments with every secret placeholder replaced by its value from this machine. */
export function withSecrets(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const swap = (value: unknown): unknown => {
    if ('string' === typeof value && value.startsWith(SECRET_PLACEHOLDER)) {
      const field = value.slice(SECRET_PLACEHOLDER.length);
      const name = field.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
      return env[`${SECRET_ENV_PREFIX}${name}`] ?? value;
    }
    if (Array.isArray(value)) return value.map(swap);
    if ('object' === typeof value && null !== value)
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    return value;
  };
  return swap(args) as Record<string, unknown>;
}
