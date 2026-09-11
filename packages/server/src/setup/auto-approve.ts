/**
 * Removing the Accept button, for the tools Reticle owns and nothing else.
 *
 * A drive that stops on a per-call approval dialog is not automated, and the dialog is per CALL:
 * a single verification run makes dozens, so a human sits there clicking through a loop that was
 * supposed to run without them. Every client below documents a way to pre-approve a named server,
 * and this writes exactly that rule, at install time, in the client's own spelling.
 *
 * Two limits, both deliberate:
 *
 * 1. ONLY `reticle` is allowed. Not `mcp(*)`, not a global auto-run switch. Reticle's tools drive
 *    the user's own dev server on their own machine, which is what makes pre-approving them
 *    defensible; the same edit made globally would hand the same pass to every other MCP server
 *    they ever install, including ones that reach the network. Their approval gate is not ours to
 *    dismantle, only ours to step out of.
 * 2. Nothing is CREATED where the file itself takes over settings we cannot read — Cursor's
 *    permissions.json supersedes its in-app allowlist and pins the run mode to Allowlist, so a user
 *    who ran everything without asking loses that and cannot switch back while the file exists.
 *    Merging into one they already have is fine; making one is not, so that case is DEFERRED with
 *    the in-app step to take instead. Nothing is written at all for an agent that is not installed:
 *    an absent agent has no Accept button to remove.
 *
 * Codex is absent by design: its approval policy is global (`approval_policy`), so there is no
 * reticle-shaped rule to write, and its config is TOML, which this repo never rewrites. Its
 * headless form, `codex exec`, does not prompt at all — which is the form the drive uses.
 */

import { joinFor, type PlatformPaths } from './agent-configs.js';
import type { AgentWriterIo } from './agent-writer.js';

const RETICLE_KEY = 'reticle';
const INDENT = 2;

/** A documented way to pre-approve one MCP server, in one client's own spelling. */
export interface ApprovalGrant {
  readonly id: string;
  readonly name: string;
  /** Home-relative, per platform. */
  readonly paths: PlatformPaths;
  /** Present if ANY of these exist. An agent that is not installed is not configured. */
  readonly markers: readonly PlatformPaths[];
  /** The rule, in the client's words, for the plan output. */
  readonly rule: string;
  /** Adds our rule to a parsed config, leaving everything else exactly as it was. */
  readonly grant: (current: Record<string, unknown>) => Record<string, unknown>;
  /**
   * True where CREATING this file supersedes in-app settings we can neither read nor restore. Such
   * a grant is only ever merged into a file the user already owns, never created.
   */
  readonly supersedesInApp?: boolean;
}

const home = (path: string): PlatformPaths => ({ darwin: path, linux: path, win32: path });

/** Append to a nested array, without duplicating and without disturbing what is already in it. */
function addToList(
  current: Record<string, unknown>,
  outer: string | null,
  key: string,
  value: string,
): Record<string, unknown> {
  const scope: Record<string, unknown> =
    null === outer
      ? current
      : 'object' === typeof current[outer] && null !== current[outer]
        ? { ...(current[outer] as Record<string, unknown>) }
        : {};
  const list = Array.isArray(scope[key]) ? (scope[key] as unknown[]) : [];
  if (list.includes(value)) return current;
  const next = { ...scope, [key]: [...list, value] };
  return null === outer ? next : { ...current, [outer]: next };
}

export const APPROVAL_GRANTS: readonly ApprovalGrant[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    paths: home('.claude/settings.json'),
    markers: [home('.claude')],
    rule: 'permissions.allow += "mcp__reticle"',
    grant: (c) => addToList(c, 'permissions', 'allow', 'mcp__reticle'),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    paths: home('.cursor/permissions.json'),
    markers: [home('.cursor')],
    rule: 'mcpAllowlist += "reticle:*"',
    // Documented: "when a key appears in permissions.json, it fully replaces the in-app allowlist
    // for that type" — and in practice it costs more than that. A non-empty mcpAllowlist also locks
    // the run mode to Allowlist, so a user who had Run Everything ("YOLO") on loses it and cannot
    // turn it back on while the file exists; Cursor has acknowledged that as their bug. Merging into
    // a file the user already made is safe — they are already in Allowlist mode. Creating one is
    // not, so we never do: see the DEFERRED branch below.
    supersedesInApp: true,
    grant: (c) => addToList(c, null, 'mcpAllowlist', `${RETICLE_KEY}:*`),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    paths: home('.gemini/antigravity-cli/settings.json'),
    markers: [
      {
        darwin: 'Library/Application Support/Antigravity',
        linux: '.config/Antigravity',
        win32: 'AppData/Roaming/Antigravity',
      },
      home('.gemini/antigravity-cli'),
    ],
    rule: 'permissions.allow += "mcp(reticle/*)"',
    grant: (c) => addToList(c, 'permissions', 'allow', `mcp(${RETICLE_KEY}/*)`),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    paths: home('.gemini/settings.json'),
    markers: [home('.gemini')],
    rule: 'mcpServers.reticle.trust = true',
    // Gemini has no allowlist: trust is a property of the server entry itself, so this reaches into
    // the entry init already wrote rather than adding a rule beside it.
    grant: (c) => {
      const servers =
        'object' === typeof c['mcpServers'] && null !== c['mcpServers']
          ? { ...(c['mcpServers'] as Record<string, unknown>) }
          : {};
      const entry =
        'object' === typeof servers[RETICLE_KEY] && null !== servers[RETICLE_KEY]
          ? (servers[RETICLE_KEY] as Record<string, unknown>)
          : {};
      return { ...c, mcpServers: { ...servers, [RETICLE_KEY]: { ...entry, trust: true } } };
    },
  },
];

export const ApprovalOutcome = {
  GRANTED: 'granted',
  ALREADY: 'already',
  ABSENT: 'absent',
  /** Deliberately left for an explicit run, because doing it unattended costs the user something. */
  DEFERRED: 'deferred',
  FAILED: 'failed',
} as const;
export type ApprovalOutcome = (typeof ApprovalOutcome)[keyof typeof ApprovalOutcome];

export interface ApprovalResult {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly outcome: ApprovalOutcome;
  readonly rule: string;
  /** Set where the user has to be told something the write alone does not say. */
  readonly warn?: string;
}

interface ApprovalWhere {
  readonly home: string;
  readonly platform: keyof PlatformPaths;
}

/**
 * Pre-approve Reticle's tools everywhere the machine has an agent that would otherwise ask.
 *
 * A client that cannot be written is reported, never thrown: one unwritable settings file is not a
 * reason to leave the other three prompting.
 */
export function grantAutoApproval(
  io: AgentWriterIo,
  where: ApprovalWhere,
  grants: readonly ApprovalGrant[] = APPROVAL_GRANTS,
): ApprovalResult[] {
  const join = joinFor(where.platform);
  return grants.map((grant): ApprovalResult => {
    const file = join(where.home, grant.paths[where.platform]);
    const base = { id: grant.id, name: grant.name, file, rule: grant.rule };
    const installed = grant.markers.some((m) => io.exists(join(where.home, m[where.platform])));
    if (!installed) return { ...base, outcome: ApprovalOutcome.ABSENT };
    try {
      const existed = io.exists(file);
      if (true === grant.supersedesInApp && !existed) {
        return {
          ...base,
          outcome: ApprovalOutcome.DEFERRED,
          warn: `left ${grant.name}'s approvals alone — creating ${file} would take over its in-app settings and pin the run mode to Allowlist. If ${grant.name} asks before every reticle tool call, add \`${RETICLE_KEY}:*\` under Settings → Agents → Approvals & Execution (nothing to do if you run everything already).`,
        };
      }
      // A settings file we cannot parse is left exactly as it is. Reformatting somebody's config to
      // add one line is a worse outcome than one dialog they have to click.
      const current = existed
        ? (JSON.parse(io.readFile(file)) as Record<string, unknown>)
        : ({} as Record<string, unknown>);
      const next = grant.grant(current);
      if (next === current) return { ...base, outcome: ApprovalOutcome.ALREADY };
      io.mkdirp(file.slice(0, Math.max(0, file.lastIndexOf('/'))));
      io.writeFile(file, `${JSON.stringify(next, null, INDENT)}\n`);
      return { ...base, outcome: ApprovalOutcome.GRANTED };
    } catch (err) {
      return {
        ...base,
        outcome: ApprovalOutcome.FAILED,
        warn: String((err as Error)?.message ?? err).slice(0, 120),
      };
    }
  });
}
