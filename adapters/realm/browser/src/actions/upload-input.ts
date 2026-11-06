import { parentAcrossShadowBoundary } from '@/dom/shadow-registry.js';
import { type ActionTarget, isForm, isInput, isLabel } from '@/dom/realm.js';

/** Every file input inside a scope, in document order. */
function fileInputsIn(scope: Element | ShadowRoot): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll('input[type="file"]')).filter(isInput);
}

/** The refusal every upload resolution failure shares: the target is not a file input. */
const UPLOAD_TARGET_MUST_BE_FILE_INPUT = 'upload target must be a <input type="file">';

/**
 * The interactive controls that bound the upload walk: a decision past one of these is a
 * guess. A `label`, a `summary`, and anything focusable or given a role count as controls:
 * a header whose only control is a label that wraps its file input is still another part
 * of the page, not part of the dropzone.
 */
const INTERACTIVE_CONTROL_SELECTOR =
  'button, a, input, select, textarea, label, summary, [role], [tabindex], [contenteditable]';

/**
 * Whether `queryRoot` holds an interactive control that is neither the upload target nor a
 * file input. The target and the file inputs are the two things the walk is allowed to see.
 * Anything else — the header's avatar menu button, a form's Save button — means the input the
 * walk would decide on belongs to another part of the page, so the walk stops here. One
 * exception keeps a file input a control: an input with its own wrapping label is that
 * label's control, so it counts when the label does not also wrap the target.
 */
function holdsOtherInteractiveControl(
  queryRoot: Element | ShadowRoot,
  target: ActionTarget,
): boolean {
  const controls = queryRoot.querySelectorAll(INTERACTIVE_CONTROL_SELECTOR);
  return Array.from(controls).some((control) => {
    if (control === target) {
      return false;
    }
    if (isInput(control) && 'file' === control.type) {
      const wrappingLabel = control.closest('label');
      return null !== wrappingLabel && !wrappingLabel.contains(target);
    }
    return true;
  });
}

/**
 * The file input an `upload` on a non-input target means (#1249).
 *
 * The standard dropzone pattern hides the input (`sr-only`, `aria-hidden`) behind a Browse
 * button. The snapshot skips `aria-hidden` subtrees, so the input never gets a ref and the
 * button is the only target the agent can name. Resolve the input the target labels first (a
 * label target, or the label that wraps the target), then walk outward from the target.
 *
 * The walk is bounded two ways. It stops at the first ancestor that holds an interactive
 * control other than the target and the file inputs: a button, link, input, select,
 * textarea, label, summary, or anything with a role, a tabindex, or contenteditable. Past
 * that point the input the walk would decide on belongs to another part of
 * the page — most apps wrap the whole page in a `<div id="root">`, so a wrapper scope
 * would otherwise hand a Browse button with an empty dropzone the header's avatar input,
 * and the upload would report a success the app never saw. The nearest enclosing form is
 * the last scope it queries, and it never decides at `body` or `html`, for the same
 * reason. More than one input in the deciding scope is a refusal, never a guess. At the
 * top of a shadow tree the walk queries the shadow root itself before hopping to the host,
 * so a dropzone inside a shadow root resolves.
 */
export function resolveUploadInput(el: ActionTarget): HTMLInputElement {
  const label = isLabel(el) ? el : el.closest('label');
  const labeled = label?.control;
  if (isInput(labeled) && 'file' === labeled.type) {
    return labeled;
  }

  let scope: Element | null = el;
  let aboveTarget = false;
  while (null !== scope) {
    if ('BODY' !== scope.tagName && 'HTML' !== scope.tagName) {
      const shadowRoot = shadowRootAbove(scope);
      const queryRoot = shadowRoot ?? scope;
      // The control check runs on any pass past the target, and on the first pass when the
      // target sits directly under a shadow root: that pass reads the whole shadow root,
      // so a root that holds another control must refuse here, not decide on its input.
      if ((aboveTarget || null !== shadowRoot) && holdsOtherInteractiveControl(queryRoot, el)) {
        throw new Error(UPLOAD_TARGET_MUST_BE_FILE_INPUT);
      }
      const only = onlyFileInputIn(scope);
      if (undefined !== only) {
        return only;
      }
    }
    if (isForm(scope)) {
      break;
    }
    scope = parentAcrossShadowBoundary(scope);
    aboveTarget = true;
  }
  throw new Error(UPLOAD_TARGET_MUST_BE_FILE_INPUT);
}

/**
 * The single file input `scope` holds, or undefined when it holds none. Throws when it holds
 * more than one: setting files on the wrong input reports a success the app never saw.
 */
function onlyFileInputIn(scope: Element): HTMLInputElement | undefined {
  // At the top of a shadow tree, query the root itself: the composed parent is the host, but
  // the host's `querySelectorAll` cannot see shadow children. The root contains the scope, so
  // one query covers both.
  const found = fileInputsIn(shadowRootAbove(scope) ?? scope);
  if (1 < found.length) {
    throw new Error(
      `upload target is not a file input and its scope holds ${found.length} file inputs — ` +
        'target the file input itself so the upload cannot land on the wrong one',
    );
  }
  return found[0];
}

/**
 * The shadow root `scope` sits directly under, or null. Duck-typed on `host` the way a11y.ts
 * does: `instanceof ShadowRoot` fails across realms, and `host` exists on a ShadowRoot and not
 * on a Document.
 */
function shadowRootAbove(scope: Element): ShadowRoot | null {
  if (null !== scope.parentElement) {
    return null;
  }
  const root = scope.getRootNode() as Partial<ShadowRoot>;
  return undefined === root.host ? null : (root as ShadowRoot);
}
