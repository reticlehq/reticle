import { MarkAnchorStrategy } from '@reticle/protocol';
import { AnchorStrategy, synthesizeAnchor, type AnchorInput } from '../dom/auto-anchor.js';
import { getAccessibleName, getRole } from '../dom/a11y.js';
import { identifyComponent } from '../registry/adapters.js';

/** Attribute names — defined locally per the recorder/query convention (no shared free string). */
const TESTID_ATTR = 'data-testid';
const SOURCE_ATTR = 'data-reticle-source';

/**
 * The element address carried by a human review mark: a re-resolvable anchor (auto-anchor's most
 * durable tier for this element), its durability strategy, a human-legible label, and — crucially —
 * the source file:line the agent should open. Source is reported INDEPENDENTLY of the anchor tier:
 * a role-anchored element still carries its babel-stamped source so the agent can jump to the code.
 */
export interface MarkAnchor {
  anchor: string;
  strategy: MarkAnchorStrategy;
  label: string;
  source?: { file: string; line: number };
}

/** AnchorStrategy and MarkAnchorStrategy share string values; map explicitly (no cross-cast). */
const STRATEGY: Record<AnchorStrategy, MarkAnchorStrategy> = {
  [AnchorStrategy.TESTID]: MarkAnchorStrategy.TESTID,
  [AnchorStrategy.COMPONENT]: MarkAnchorStrategy.COMPONENT,
  [AnchorStrategy.ROLE]: MarkAnchorStrategy.ROLE,
  [AnchorStrategy.POSITION]: MarkAnchorStrategy.POSITION,
};

/** Parse a `data-reticle-source="file:line:column"` value into `{ file, line }` (column dropped). */
function parseSourceAttr(value: string | null): { file: string; line: number } | undefined {
  if (value === null) return undefined;
  const m = /^(.*):(\d+):(\d+)$/.exec(value);
  if (m === null) return undefined;
  const file = m[1];
  const line = Number(m[2]);
  if (file === undefined || file.length === 0 || !Number.isFinite(line)) return undefined;
  return { file, line };
}

/** Best source for the element: the framework adapter's, else the nearest babel-stamped attribute. */
function sourceFor(
  el: Element,
  adapterSource: { file: string; line: number } | undefined,
): { file: string; line: number } | undefined {
  if (adapterSource !== undefined) return { file: adapterSource.file, line: adapterSource.line };
  const host = el.closest(`[${SOURCE_ATTR}]`);
  return host !== null ? parseSourceAttr(host.getAttribute(SOURCE_ATTR)) : undefined;
}

/** A short, human-legible label for the element: `role "name"`, falling back to role / tag name. */
function labelFor(el: Element, role: string, name: string): string {
  if (name.length > 0) return role.length > 0 ? `${role} "${name}"` : `"${name}"`;
  return role.length > 0 ? role : el.tagName.toLowerCase();
}

/**
 * Resolve a clicked element into the address a human review mark carries. Reuses the same
 * auto-anchor machinery a recorded flow uses, so a mark pins to the element the way Reticle addresses
 * it everywhere else — and always reports the source file:line when one is available.
 */
export function resolveMarkAnchor(el: Element): MarkAnchor {
  const testid = el.getAttribute(TESTID_ATTR) ?? undefined;
  const info = identifyComponent(el);
  const component = info?.componentStack[0];
  const source = sourceFor(el, info?.source);
  const role = getRole(el);
  const name = getAccessibleName(el);

  const input: AnchorInput = {};
  if (testid !== undefined) input.testid = testid;
  if (component !== undefined) input.component = component;
  if (source !== undefined) input.source = source;
  if (role.length > 0) input.role = role;
  if (name.length > 0) input.name = name;

  const synthesized = synthesizeAnchor(input);
  const out: MarkAnchor = {
    anchor: synthesized.value,
    strategy: STRATEGY[synthesized.strategy],
    label: labelFor(el, role, name),
  };
  if (source !== undefined) out.source = source;
  return out;
}
