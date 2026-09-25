/**
 * The plan's vocabulary: what a step IS, what status it can be in, and what a plan is built from.
 *
 * A leaf. Four modules that `plan.ts` calls — the framework adapters, the electron-vite steps, the
 * per-framework steps and the notices — each named these to declare their own signatures, and all
 * four had to import them back out of the module that calls them.
 */

import type { Detection, Framework, UiLibrary } from '@/detect/detect.js';
import type { FoundStore } from '@/detect/capabilities.js';
import type { McpClient } from '@/register/mcp-clients.js';

/** Exported so the init telemetry can tell an MCP-registration failure from a dependency install. */
export const MCP_TARGET = 'global (claude user scope)';

/** The step that runs the package manager — the other thing that commonly fails on a user's machine. */
export const DEPS_TARGET = 'package.json';

export const StepStatus = {
  APPLY: 'apply',
  MANUAL: 'manual',
  ALREADY: 'already',
  SKIP: 'skip',
  /**
   * Something the user should KNOW, not something they must DO. The UNVERIFIED lines are the case:
   * a Preact or SvelteKit app is wired and working, it just isn't covered by a gate. Reporting those
   * as `manual` made "steps left to do" a number that could never reach zero, and made a release gate
   * read two regressions that were not regressions.
   */
  NOTICE: 'notice',
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export interface Step {
  title: string;
  target: string;
  status: StepStatus;
  detail: string;
  /**
   * Present only when status is APPLY and a file must be written.
   *
   * `expect` is what must be READABLE BACK from the file afterwards, for a step whose write is a
   * PATCH of somebody else's file rather than a file we own outright. Existence is enough to
   * confirm a file we generated whole; it confirms nothing about a config we edited in place, and
   * that gap is what #882 cost: `vite.config.ts` never received `reticle()`, the tick printed
   * anyway, and the SDK was absent from the bundle with nothing pointing at the config.
   */
  write?: { path: string; content: string; expect?: readonly string[] };
  /** Present only when status is APPLY and a subprocess must run (the dependency install). */
  exec?: { command: string; args: string[]; fallback: string };
  /**
   * Weaker attempts to run when `exec` fails, IN ORDER, each with what to tell the user if it works.
   *
   * Ordered by how much each one gives up, cheapest concession first, because the first that
   * succeeds is the one that stands. Two causes are covered today and they cost different things:
   *
   * - **A peer-dependency conflict.** npm dies on ERESOLVE in repos that are built with
   *   `--legacy-peer-deps` everywhere else. Relaxing peers keeps the VERSION PIN, so it goes first.
   *   Reported from a CRA repo where the failed install also skipped the connect module and the
   *   entry snippet, so the first run produced no wiring at all.
   * - **A release-age hold.** The pinned install is refused outright by pnpm's `minimumReleaseAge`
   *   for as long as its window lasts — so for ~48 hours after every release, a project with that
   *   setting could not install Reticle. An unpinned install still works (it resolves the newest
   *   MATURE version), so it trades the exact version for a working install. That is the more
   *   expensive concession and it is last.
   *
   * A retry must never be silent: an older SDK against a newer daemon is the skew the pin exists to
   * prevent, and a peer override the user did not ask for is theirs to know about.
   */
  retries?: { command: string; args: string[]; note: string }[];
  /**
   * This step wires the app to a package the install step provides. If that install fails, applying
   * it anyway leaves the app importing a module that is not there — `next.config.ts` importing
   * `@reticlehq/next` took a dev server down exactly this way. Installing Reticle must never be the
   * reason an app stops booting.
   */
  dependsOnInstall?: boolean;
}

export interface Plan {
  framework: Framework;
  /**
   * The renderer this app actually uses, carried so every consumer agrees on WHICH packages the
   * plan installed. The retry guard checks node_modules for exactly those names; without this it
   * looked for `@reticlehq/react` in a Vue app that had correctly been given the sensor, decided the
   * install had failed, and skipped every wiring step on the retry.
   */
  uiLibrary: UiLibrary;
  steps: Step[];
}


export interface PlanInput {
  detection: Detection;
  /**
   * Write `captureNetworkBodies: true` into the app's config. Off unless the caller asked (#705).
   *
   * Optional so every existing caller and test keeps the safe default without naming it — the one
   * direction a default about somebody else's data should be wrong in.
   */
  captureBodies?: boolean | undefined;
  /**
   * The CSP-bearing files this project actually has, keyed by path — read once in `gatherPlanInput`.
   *
   * Pre-read rather than given a reader, because `PlanInput` is the pure input to a pure planner and
   * handing it an io would let any later step reach the disk from inside `buildPlan`.
   */
  cspSources?: Readonly<Record<string, string | undefined>> | undefined;
  /** Whether the `claude` CLI is installed (so we can register the MCP server globally). */
  claudeCli: boolean;
  /** Whether an `reticle` MCP server is already registered with Claude (any scope) — idempotency. */
  mcpExists: boolean;
  /**
   * Whether `init` is running inside Claude Code itself, which is the one case where writing its
   * project-scope `.mcp.json` is known to be wanted. See `CLAUDE_PROJECT_SPEC`.
   */
  insideClaudeCode?: boolean | undefined;
  /** The project `.mcp.json` at the agent's root, read so the merge stays idempotent. */
  claudeProjectConfig?: string | null | undefined;
  /** `process.platform`. Injected so this module stays pure. Windows is the only branch. */
  platform?: string;
  /**
   * The install channel the environment declared, or undefined when nothing declared one.
   *
   * Injected for the same reason as `platform`: reading the environment from inside a pure planner
   * is a hidden input. Only ever written when it is actually KNOWN — `unknown` in `.reticle.json`
   * is indistinguishable from a config written before the field existed, and those are different
   * facts.
   */
  installSource?: string | undefined;
  /** Whether THIS project has a .cursor/ directory — the signal that Cursor works on this repo. */
  cursorProjectPresent?: boolean | undefined;
  /**
   * Every OTHER MCP client detected on this machine, with its config path and current content.
   *
   * Claude Code and Cursor keep their own steps — Claude registers through its CLI, and Cursor's
   * predates this. Everything else is uniform: read the file, merge, write.
   */
  detectedClients?:
    readonly { id: McpClient; configPath: string; existing: string | null }[] | undefined;
  /** Discovered Vite config: its path + source, or null if none found. */
  viteConfig: { path: string; source: string } | null;
  /** Discovered electron-vite config: its path + source, or null if none found. */
  electronViteConfig?: { path: string; source: string } | null | undefined;
  /** Electron preload source we can patch, or null when none was found. */
  electronPreload?: { path: string; source: string } | null | undefined;
  /** Electron main-process source we can patch, or null when none was found. */
  electronMain?: { path: string; source: string } | null | undefined;
  /** Discovered Astro config: its path + source, or null if none found. */
  astroConfig?: { path: string; source: string } | null | undefined;
  /**
   * The single layout to instrument, or null when the choice is not obvious.
   *
   * WHICH page or layout to instrument is a real decision — so `init` only makes it when there is
   * exactly one candidate. Zero or several falls back to the printed recipe rather than guessing at
   * the file every page of the user's site inherits from.
   */
  astroLayout?: { path: string; source: string } | null | undefined;
  /**
   * Existing `src/env.d.ts` content, when present — where the Vite-define ambient declarations go
   * so `astro check` can see `__RETICLE_TOKEN__` / `__RETICLE_ROOT__` (#677).
   */
  astroEnvDts?: string | null | undefined;
  /** Discovered Next config filename (e.g. 'next.config.mjs'), or null. */
  nextConfigFile: string | null;
  /** Source of that Next config, so the export can be wrapped in withReticle. */
  nextConfigSource?: string | null | undefined;
  /** Discovered Next root layout: its path + source, or null (App Router only). */
  nextLayout?: { path: string; source: string } | null | undefined;
  /** Where the dev-only connect component goes — never inside `pages/`, which routes on presence. */
  nextReticleDevPath?: string | undefined;
  /** What the mount file should import — a sibling for App Router, `../components/…` for Pages. */
  nextReticleDevImport?: string | undefined;
  /** Whether the ReticleDev component file already exists. */
  nextReticleDevExists: boolean;
  /**
   * The existing ReticleDev component's source, when there is one.
   *
   * Read so an install predating daemon discovery can be told apart from a current one. Undefined
   * means NOT READ, and an unread file is reported as already-wired rather than as stale: inventing
   * work from missing information is how a plan grows steps that can never be completed.
   */
  nextReticleDevSource?: string | null | undefined;
  /** `data-testid` values scanned from the app's source, for the generated capabilities block. */
  testids?: readonly string[] | undefined;
  /** Ready-to-uncomment `registerStore` lines for the state libraries the app actually depends on. */
  storeHints?: readonly string[] | undefined;
  /** Store instances found in the app's own source — imported and registered outright, not hinted. */
  foundStores?: readonly FoundStore[] | undefined;
  /** The same stores, with specifiers resolved from Next's dev-module directory instead of `src/`. */
  nextFoundStores?: readonly FoundStore[] | undefined;
  /** Whether src/reticle-dev.ts already exists — it is the one generated file users are meant to edit. */
  viteDevModuleExists?: boolean | undefined;
  /** Whether src/hooks.client.ts already exists (SvelteKit idempotency). */
  svelteKitHooksExists?: boolean;
  /** Whether app/entry.client.tsx already exists — it decides whether init writes one or patches it. */
  reactRouterEntryExists?: boolean;
  /**
   * Its SOURCE, when it is there.
   *
   * Content rather than existence, because the two cases need different files: an absent entry is
   * written from React Router's own default plus our import, and an existing one gets that import
   * added to whatever the app already put in it. Existence alone could only ever print a recipe.
   */
  reactRouterEntrySource?: string | null | undefined;
  /** Discovered Nuxt config: its path + source, or null. It is where the pairing token is inlined. */
  nuxtConfig?: { path: string; source: string } | null | undefined;
  /** Whether the app has an `app/` directory — Nuxt 4's srcDir, and so where plugins are scanned. */
  nuxtHasAppDir?: boolean | undefined;
  /** Whether the Nuxt client plugin already exists (idempotency — the file is the owner's to edit). */
  nuxtPluginExists?: boolean | undefined;
  /**
   * TanStack Start's document module, when found (`src/routes/__root.tsx` or `app/routes/__root.tsx`).
   *
   * The recipe is printed rather than written either way — a static import on that file SSRs and
   * 500s — but the path has to be the one that actually exists, not a guess.
   */
  tanstackStartRoot?: string | undefined;
  /** CRA's bundled entry (src/index.tsx or .js) — where the connect import has to go. */
  craEntry?: { path: string; source: string } | null;
  /** Existing .env.development.local, so an unrelated variable in it survives. */
  craEnv?: string | null;
  /** The daemon's pairing token, inlined for CRA through the one channel it supports. */
  pairingToken?: string;
  /** Whether .reticle.json already exists in the project root (idempotency). */
  reticleConfigExists?: boolean;
  /**
   * The container marker found near the app (`Dockerfile`, `docker-compose.yml`, …), or undefined.
   *
   * Not proof the dev server runs in one — see containerised-dev-server.ts for why over-eager is the
   * right direction here, and for what goes wrong when it does.
   */
  containerMarker?: string | undefined;
  /**
   * Its CONTENT, so an existing config can be checked instead of trusted.
   *
   * Existence alone said "a file is present" and was reported as "this is configured correctly" —
   * see reticleConfigStep for the port that survived every re-run because of it.
   */
  reticleConfigSource?: string | null | undefined;
  /** Current project-root CLAUDE.md content (for the idempotent agent-rule merge), or null/undefined. */
  claudeMdContent?: string | null | undefined;
  /** Current project-root AGENTS.md content (the cross-agent rule), or null/undefined. */
  agentsMdContent?: string | null | undefined;
  /** Current project-root RETICLE.md content (the full rules), or null when absent. */
  reticleMdContent?: string | null | undefined;
  /**
   * Current .cursor/rules/reticle.mdc content, or null when absent.
   *
   * CONTENT, not existence. Gating on the file merely being there froze a Cursor project's rule at
   * whatever release wrote it — so the CLAUDE.md path refreshed itself while the Cursor one never
   * could, and a rule added later (`version_skew`) never reached a Cursor-only project at all.
   */
  cursorRuleContent?: string | null | undefined;
  /** Current .claude/commands/reticle.md content, or null when absent (slash-command idempotency). */
  claudeCommandContent?: string | null | undefined;
  /** Current .cursor/commands/reticle.md content, or null when absent. */
  cursorCommandContent?: string | null | undefined;
  /** `--hooks`: install the print-only Claude Code Stop hook. Off unless asked. */
  hooks?: boolean | undefined;
  /** Current .claude/settings.json content, or null when absent (the hook is MERGED into it). */
  claudeSettingsContent?: string | null | undefined;
  /**
   * Absolute directory the AGENT runs in, when that is not the app's directory.
   *
   * The rule and command files are read by the agent, not by the app, so a monorepo whose app is a
   * directory down must still get its `/reticle` where the human's session actually stands. Absent
   * (the single-package case) leaves every path project-relative exactly as before.
   */
  agentFileRoot?: string | undefined;
  /**
   * Content of the `.reticle.json` already sitting at that agent root, or null/undefined when there
   * is none. Content rather than existence, for the reason `reticleConfigSource` is: a root config
   * that disagrees with the app's is worse than no root config, and only reading it can tell.
   */
  agentRootConfigSource?: string | null | undefined;
  options: {
    port: number | undefined;
    mcp: boolean;
    install: boolean;
    /** Stable project identity derived at init (package.json name + root). Baked into snippets/.reticle.json. */
    projectId?: string;
    /** The CLI's own version, pinned onto the SDK install so a stale registry cache cannot skew it. */
    sdkVersion?: string;
  };
}
