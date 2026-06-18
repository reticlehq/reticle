import { ElementState, SnapshotMode } from '@syrin/iris-protocol';
import { getAccessibleName, getRole, getStates, getValue, isVisible } from './a11y.js';
import { refs } from './refs.js';
import { isIgnored } from './dom-ignore.js';

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'option',
]);

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link']);

/** Cap on inlined text content so a verbose node can't blow up the snapshot. */
const TEXT_MAX = 80;

/**
 * Concatenated DIRECT text of an element (its own text nodes, not descendants' — those are
 * captured when their own element is walked, so no duplication). Collapsed + truncated.
 * This is what makes a silent removal of non-interactive content (e.g. a KPI card) visible:
 * the accessibility role tree alone omits generic containers' text.
 */
function directText(el: Element): string {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) out += node.textContent ?? '';
  }
  const collapsed = out.replace(/\s+/g, ' ').trim();
  return collapsed.length > TEXT_MAX ? `${collapsed.slice(0, TEXT_MAX)}…` : collapsed;
}

export interface SnapshotStatus {
  route: string;
  title: string;
  visibleDialogs: string[];
}

export interface SnapshotResult {
  tree: string;
  status: SnapshotStatus;
  nodes: number;
  truncated: boolean;
}

export interface SnapshotOptions {
  scope?: string | undefined;
  mode?: SnapshotMode | undefined;
  maxNodes?: number | undefined;
  maxDepth?: number | undefined;
}

function skip(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
  if (isIgnored(el)) return true; // Iris overlay + known dev overlays
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el instanceof HTMLElement && el.hidden) return true;
  const view = el.ownerDocument.defaultView;
  if (view !== null) {
    const style = view.getComputedStyle(el);
    if (style.display === 'none') return true;
  }
  return false;
}

function stateSuffix(el: Element): string {
  const states = getStates(el).filter(
    (s) =>
      s === ElementState.DISABLED ||
      s === ElementState.CHECKED ||
      s === ElementState.EXPANDED ||
      s === ElementState.FOCUSED,
  );
  return states.length > 0 ? ` [${states.join(',')}]` : '';
}

function formatLine(el: Element, depth: number, role: string, name: string): string {
  const indent = '  '.repeat(depth);
  const value = getValue(el);
  const namePart = name.length > 0 ? ` "${name}"` : '';
  const refPart = INTERACTIVE.has(role) || name.length > 0 ? ` (ref=${refs.refFor(el)})` : '';
  const valuePart = value !== undefined && value.length > 0 ? ` [value="${value}"]` : '';
  return `${indent}- ${role}${namePart}${refPart}${valuePart}${stateSuffix(el)}`;
}

/** A generic container's own text content, with no ref (kept lean — text isn't actionable). */
function formatTextLine(depth: number, text: string): string {
  return `${'  '.repeat(depth)}- text "${text}"`;
}

interface WalkCtx {
  lines: string[];
  nodes: number;
  truncated: boolean;
  mode: SnapshotMode;
  maxNodes: number;
  maxDepth: number;
}

function walk(parent: Element, depth: number, ctx: WalkCtx): void {
  if (depth > ctx.maxDepth) return;
  for (const child of parent.children) {
    if (ctx.nodes >= ctx.maxNodes) {
      ctx.truncated = true;
      return;
    }
    if (skip(child)) continue;
    const role = getRole(child);
    const name = getAccessibleName(child);
    const interactive = INTERACTIVE.has(role);
    // A generic, unnamed container's own text content — only consulted outside INTERACTIVE mode,
    // so the actionable-only view stays lean while FULL/meaningful views see content regressions.
    const text =
      ctx.mode !== SnapshotMode.INTERACTIVE && role === 'generic' && name.length === 0
        ? directText(child)
        : '';
    const meaningful = interactive || role !== 'generic' || name.length > 0 || text.length > 0;
    const include = ctx.mode === SnapshotMode.INTERACTIVE ? interactive : meaningful;
    if (include) {
      ctx.nodes += 1;
      ctx.lines.push(
        text.length > 0 && name.length === 0
          ? formatTextLine(depth, text)
          : formatLine(child, depth, role, name),
      );
      walk(child, depth + 1, ctx);
    } else {
      walk(child, depth, ctx);
    }
  }
}

function collectDialogs(root: ParentNode): string[] {
  const nodes = root.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]');
  const names: string[] = [];
  for (const node of nodes) {
    if (isVisible(node)) names.push(getAccessibleName(node) || '(unnamed dialog)');
  }
  return names;
}

function buildStatus(root: ParentNode): SnapshotStatus {
  return {
    route: `${location.pathname}${location.search}${location.hash}`,
    title: document.title,
    visibleDialogs: collectDialogs(root),
  };
}

/** Build the semantic accessibility snapshot of the page or a subtree (plan/04). */
export function buildSnapshot(options: SnapshotOptions = {}): SnapshotResult {
  const mode = options.mode ?? SnapshotMode.FULL;
  const scopeEl =
    options.scope !== undefined
      ? (refs.resolve(options.scope) ?? document.querySelector(options.scope))
      : document.body;
  const root = scopeEl ?? document.body;
  const status = buildStatus(root);

  if (mode === SnapshotMode.STATUS) {
    return { tree: '', status, nodes: 0, truncated: false };
  }

  const ctx: WalkCtx = {
    lines: [],
    nodes: 0,
    truncated: false,
    mode,
    maxNodes: options.maxNodes ?? 400,
    maxDepth: options.maxDepth ?? 20,
  };
  walk(root, 0, ctx);
  return {
    tree: ctx.lines.join('\n'),
    status,
    nodes: ctx.nodes,
    truncated: ctx.truncated,
  };
}
