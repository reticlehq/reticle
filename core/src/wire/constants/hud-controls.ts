/**
 * What a person did with the in-page HUD, as names only.
 *
 * The HUD is where a human meets Reticle, and nothing measured it: which controls get used, which
 * panel is open, whether the HUD spends its life as a bubble or open, which settings get changed.
 * Every id is the name of a control Reticle rendered, never text from the page, a flow name or a
 * URL: the telemetry contract's "names, never values". A control whose id is not listed here is
 * dropped at the daemon rather than counted, so a new control cannot leak free text by accident;
 * the browser test that walks the rendered HUD fails if any control has no id in this list.
 */

/** Controls whose id is the attribute name alone (`data-reticle-pause` -> `pause`). */
const PLAIN_CONTROLS = [
  'fab',
  'pause',
  'chat-toggle',
  'markers-btn',
  'end',
  'clear-marks',
  'copy-marks',
  'copy',
  'export',
  'annotate-btn',
  'report-btn',
  'settings-btn',
  'min-btn',
  'chat-min',
  'chat-pill',
  'chat-impact',
  'copy-all-notes',
  'promo-link',
  'replay',
  'carousel-dot',
  'carousel-prev',
  'carousel-next',
  'carousel-close',
  'page-close',
  'offer-claim',
  'talk-book',
  'account-signin',
  'account-trigger',
  'account-signout',
  'account-dashboard',
  'sync-now',
  'report-scope',
  'report-close',
  'share-x',
  'share-in',
  'share-copy',
  'refer',
  'settings-close',
  'settings-help',
  'settings-reset',
  'settings-mcp',
  'settings-kill',
  'feedback-email',
  'feedback-call',
  'workspace-btn',
  'workspace-copy',
  'mark-cancel',
  'mark-send',
  // The Agent Log's own Harness switch; the Settings one is `setting.harnessEnabled`.
  'harness-switch',
  // Run Harness beside it, and Stop while the drive it started runs.
  'harness-run',
  'harness-stop',
  // The coding-agent block on the Agent Log: send a note, or copy a prompt when none is connected.
  'agent-send',
  'agent-copy',
  // "See all" beside the Agent Log's replay row, and below Impact's recent bugs.
  'flows-all',
  'defects-all',
  // "See the logs" beside a replay the person started from a chip.
  'see-logs',
  // The Harness plan board on the Agent Log: hide it, or open one journey's steps.
  'plan-close',
  'plan-journey',
] as const;

/** The attributes whose value is part of the id. Read by the browser to build one. */
export const HUD_KEYED_ATTRS = [
  'setting',
  'check',
  'settings-cycle',
  'theme',
  'tour-target',
  'link',
  'annotation-tab',
  'chat-view-btn',
] as const;

/** Controls whose id also carries a key Reticle authored (`data-reticle-setting="x"` -> `setting.x`). */
const KEYED_CONTROLS = {
  setting: [
    'autoOpenChat',
    'showTimestamps',
    'showTally',
    'reactComponents',
    'hideUntilRestart',
    'harnessEnabled',
    'reduceMotion',
    'ambientGlow',
  ],
  check: ['blockPageInteractions', 'clearOnCopy'],
  'settings-cycle': ['outputDetail'],
  theme: ['signal', 'traffic', 'mono', 'neon', 'ember'],
  'tour-target': ['copy', 'back', 'done', 'next', 'skip'],
  link: ['docs', 'github', 'site', 'discord', 'defect', 'dashboard'],
  'annotation-tab': ['current', 'history'],
  'chat-view-btn': ['activity', 'flows', 'annotations'],
} as const satisfies Record<(typeof HUD_KEYED_ATTRS)[number], readonly string[]>;

let controls: ReadonlySet<string> | undefined;

/**
 * Is this a control id the HUD renders?
 *
 * The set is built on first use rather than at module scope: core's root entry is on every page
 * load, and a Set constructed at the top of a module is a side effect no bundler can drop.
 */
export function isHudControl(id: string): boolean {
  controls ??= new Set<string>([
    ...PLAIN_CONTROLS,
    ...Object.entries(KEYED_CONTROLS).flatMap(([attr, keys]) =>
      (keys as readonly string[]).map((k) => `${attr}.${k}`),
    ),
  ]);
  return controls.has(id);
}
