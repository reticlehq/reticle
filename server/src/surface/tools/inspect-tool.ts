/**
 * `reticle_inspect` — everything about one element by ref, and the refusal it owes a caller who
 * named an element but gave no ref.
 *
 * A ref is REQUIRED here, and the merged surface cannot enforce it. `reticle_look` folds four
 * actions into one tool, so every action's parameters are optional — `page`, `find`, `state` and
 * `element` want different ones — and the requirement the schema states is lost exactly where an
 * agent meets it. The empty string then travelled to the browser and came back as "ref '' no longer
 * resolves to an element / That ref is stale: refs are invalidated whenever the DOM re-renders".
 * Nothing was stale and nothing re-rendered; there was no ref. The advice sent the reader to
 * re-snapshot a page that was fine.
 *
 * Measured on bench-app with `{ action: "element", testid: "awkward-icon" }`, which is the natural
 * call: `testid` IS a parameter of `reticle_look` and the sibling `find` action takes one. So the
 * refusal names that case specifically rather than saying "ref is required" at somebody who did
 * name the element, just not the way this action wants.
 */
import { z } from 'zod';
import { asString, ReticleCommand, ReticleTool } from '@reticlehq/core';
import { type ToolDef, sessionIdShape, commandOrThrow } from './tool-kit.js';

/**
 * The ways `reticle_query` names an element. Used only to tell somebody who reached for one of
 * these that they named the element the OTHER action's way, rather than naming none.
 */
const LOCATOR_ARGS: readonly string[] = [
  'testid',
  'text',
  'role',
  'label',
  'placeholder',
  'alt',
  'name',
  'value',
];

/** The error for a ref-less inspect, or `undefined` when a usable ref was given. */
export function missingRefRefusal(args: Record<string, unknown>): Error | undefined {
  const ref = asString(args['ref']);
  if (ref !== undefined && 0 !== ref.length) return undefined;
  const locator = LOCATOR_ARGS.find((key) => asString(args[key]) !== undefined);
  const named =
    locator === undefined
      ? ''
      : ` You gave \`${locator}\`, which is how ${ReticleTool.QUERY} finds an element; this call takes the ref that comes back from it.`;
  return new Error(
    `${ReticleTool.INSPECT} needs a \`ref\` and none was given, so nothing was inspected.${named} ` +
      `Get one from ${ReticleTool.QUERY} or ${ReticleTool.SNAPSHOT}, then pass it as \`ref\`.`,
  );
}

export const INSPECT_TOOL: ToolDef = {
  name: ReticleTool.INSPECT,
  example: { ref: 'e42' },
  description:
    'Deep info on one element by ref: full a11y props, visibility, box, and (with @reticlehq/react) component stack + source file.',
  inputSchema: {
    ref: z
      .string()
      .describe(
        `Element ref (e.g. 'e42') from reticle_snapshot/reticle_query — stable until the element leaves the DOM, so no re-snapshot between actions.`,
      ),
    ...sessionIdShape,
  },
  outputSchema: {
    ref: z.string(),
    role: z.string(),
    name: z.string(),
    value: z.string().optional(),
    states: z.array(z.string()),
    visible: z.boolean(),
    box: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .optional(),
    // True when another element covers this one's center (z-index/overlay bug — unclickable).
    occluded: z.boolean().optional(),
    // Computed style the a11y tree omits: cursor/display/visibility/color so a "present but
    // unusable" UI bug (dead cursor, invisible, recolored) is observable in one inspect.
    styles: z
      .object({
        color: z.string(),
        backgroundColor: z.string(),
        opacity: z.string(),
        cursor: z.string(),
        display: z.string(),
        visibility: z.string(),
      })
      .partial()
      .optional(),
    scroll: z
      .object({
        scrollTop: z.number(),
        scrollHeight: z.number(),
        clientHeight: z.number(),
        overflowY: z.string(),
      })
      .optional(),
    // Theme compliance vs the app's design tokens: { colorToken, colorTokens, backgroundToken,
    // backgroundTokens, offTheme, tokenCount, themeScope }. The plural fields carry EVERY token
    // matching the resolved colour; the singular ones abstain (null) when several tokens share it,
    // because returning an arbitrary winner was the defect (#313). `themeScope` names the theme
    // that was active at capture, so two inspects minutes apart are comparable at all.
    // Kept as unknown — the structured-content serializer can truncate a large inspect payload's
    // fields to strings, which a strict shape would reject; the full object is always present in
    // the text content the agent reads.
    theme: z.unknown().optional(),
    /**
     * Where this element is written, as `file:line`. Present when the app is built with the
     * Reticle build plugin in dev; absent in production builds.
     */
    source: z.string().optional(),
    /**
     * Why `source` is missing, when it is.
     *
     * Distinguishes "this element has no stamp" from "nothing on this page has one, so the
     * stamping loader is not running" — the second means `file:line` is unavailable for the
     * whole session and the fix is a build-config change, which used to be discoverable only by
     * reading the adapter's own source.
     */
    sourceUnavailable: z.string().optional(),
    /**
     * Component identity from the framework adapter (@reticlehq/react).
     *
     * Declared to match what the handler actually returns. It previously declared
     * `{ name, sourceFile }` while the runtime returned `{ componentStack, source }` — the SDK
     * passes structured content through, so the real shape won and the declaration was simply
     * wrong. An agent reads this schema to decide what to ask for, which makes a wrong schema worse
     * than a missing one.
     */
    component: z
      .object({
        componentStack: z.array(z.string()).optional(),
        source: z
          .object({ file: z.string(), line: z.number(), column: z.number().optional() })
          .optional(),
      })
      .optional(),
  },
  handler: (deps, args) => {
    // The merged surface makes every action's parameters optional, so this schema's `ref` stops
    // being required exactly where an agent meets it. See `missingRefRefusal`. Rejected rather
    // than thrown: a caller holding the promise would never see a synchronous throw.
    const refusal = missingRefRefusal(args);
    if (refusal !== undefined) return Promise.reject(refusal);
    return commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.INSPECT, {
      ref: asString(args['ref']),
    });
  },
};
