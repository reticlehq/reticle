/**
 * Auto-anchor synthesis — derive a STABLE way to address any element WITHOUT a hand-added
 * data-testid. This is the brain of zero-config integration: given what the framework already knows
 * about an element (its component name + source location from the fiber, its role + accessible name,
 * its position), pick the most durable anchor so a flow can re-find the element across refactors.
 *
 * Pure and framework-agnostic: it takes a plain descriptor (the React adapter, or a future Vue/Svelte
 * adapter, fills it in) and returns the chosen anchor + whether it is stable. No DOM, no fiber here.
 *
 * Priority (most → least durable). Each tier is only used when the one above is unavailable:
 *   1. testid           — explicit, author-chosen, the gold standard. Stable.
 *   2. component@source  — component display name + source file:line. Survives text/markup/style
 *                          changes; uniquely identifies WHERE in the source the element comes from.
 *                          Stable (a move that changes the source line is a real change worth re-pinning).
 *   3. component+role/name — component name plus role/accessible-name when no source is available.
 *                          Stable enough: the component identity anchors it, role/name disambiguate.
 *   4. role+name         — semantic but content-dependent: an accessible name can change with copy.
 *                          NOT marked stable (a healed locator could drift to a renamed element).
 *   5. role / position   — last resort. NOT stable; surfaced so the element is still addressable, but
 *                          a flow built on it should be flagged (the recorder marks the step degraded).
 *
 * The point: tiers 1–3 are "stable" (a flow anchored on them can be trusted to re-resolve to the
 * same element); tiers 4–5 are best-effort. Today most elements without a testid fall to role/text
 * (degraded). With component+source, the SAME elements become tier-2 stable anchors — that is how
 * integration becomes universal without the app author adding a single testid.
 */

/** Which signal produced the anchor — also its durability tier. */
export const AnchorStrategy = {
  TESTID: 'testid',
  COMPONENT: 'component',
  ROLE: 'role',
  POSITION: 'position',
} as const;
export type AnchorStrategy = (typeof AnchorStrategy)[keyof typeof AnchorStrategy];

/** What an adapter knows about an element — any subset; richer input yields a more durable anchor. */
export interface AnchorInput {
  /** Explicit data-testid, if the author added one. */
  testid?: string;
  /** Nearest component display name (React fiber / Vue instance / …). */
  component?: string;
  /** Source location stamped by the framework's compiler/plugin. */
  source?: { file: string; line: number };
  /** ARIA role. */
  role?: string;
  /** Accessible name (label / text). */
  name?: string;
  /** Index among same-component-or-role siblings — a positional tiebreaker. */
  nth?: number;
}

interface SynthesizedAnchor {
  strategy: AnchorStrategy;
  /** A compact, human-legible, re-resolvable anchor string. */
  value: string;
  /** True when a flow can trust this anchor to re-resolve to the same element (tiers 1–3). */
  stable: boolean;
}

function nonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.length > 0;
}

/** Source as a compact `file:line` suffix; basename only to stay terse and path-independent. */
function sourceTag(source: { file: string; line: number }): string {
  const base = source.file.split('/').pop() ?? source.file;
  return `${base}:${source.line}`;
}

/**
 * Choose the most durable anchor for an element from whatever the adapter could observe. Always
 * returns something addressable (falls through to position), with `stable` marking tiers 1–3.
 */
export function synthesizeAnchor(input: AnchorInput): SynthesizedAnchor {
  if (nonEmpty(input.testid)) {
    return { strategy: AnchorStrategy.TESTID, value: input.testid, stable: true };
  }
  if (nonEmpty(input.component) && input.source !== undefined) {
    return {
      strategy: AnchorStrategy.COMPONENT,
      value: `${input.component}@${sourceTag(input.source)}`,
      stable: true,
    };
  }
  if (nonEmpty(input.component) && (nonEmpty(input.role) || nonEmpty(input.name))) {
    const qualifier = nonEmpty(input.name) ? input.name : input.role;
    return {
      strategy: AnchorStrategy.COMPONENT,
      value: `${input.component}[${qualifier ?? ''}]`,
      stable: true,
    };
  }
  if (nonEmpty(input.role) && nonEmpty(input.name)) {
    return { strategy: AnchorStrategy.ROLE, value: `${input.role}:${input.name}`, stable: false };
  }
  if (nonEmpty(input.role)) {
    const suffix = input.nth !== undefined ? `#${input.nth}` : '';
    return { strategy: AnchorStrategy.ROLE, value: `${input.role}${suffix}`, stable: false };
  }
  // Last resort: position only — addressable but never trusted.
  return { strategy: AnchorStrategy.POSITION, value: `el#${input.nth ?? 0}`, stable: false };
}
