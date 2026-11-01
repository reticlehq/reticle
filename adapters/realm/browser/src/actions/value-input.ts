import { captureValueSetter } from '@/patching/capture-method.js';
import { type ActionTarget, isHtmlElement, isTextArea, valuePrototypeOf } from '@/dom/realm.js';

/**
 * Writing a value into a field, and the two preconditions that make it honest.
 *
 * Every export here exists so that a value write either lands as a real user's edit would, or is
 * refused with a reason — never forced through while reporting success.
 */

/**
 * Set a value on a controlled input the way React expects (native setter + input event).
 * Returns the `input` event's dispatchEvent result (defaultPrevented of the primary event).
 */
/** The autocomplete tokens WebKit offers saved passwords for. */
const PASSWORD_AUTOCOMPLETE = /\b(current|new)-password\b/;
/** Blink and Gecko never raise WebKit's panel; Blink still spells its frozen `AppleWebKit/537.36`. */
const NOT_WEBKIT = /Chrome|Chromium|Edg\/|Firefox|Gecko\//;

/**
 * A fill that must not focus its field: a password field in WebKit, where focus raises the system
 * saved-password panel (a signed WKWebView app, Safari). The value setter and the input/change
 * events are what React, Vue and a plain form read, so the app still hears the value; an editor that
 * commits only on blur would not, which is why this is limited to password fields.
 */
export function isAutofillSafeTarget(el: Element, ua: string = navigator.userAgent): boolean {
  if (!(el instanceof HTMLInputElement)) {
    return false;
  }
  const password =
    'password' === el.type.toLowerCase() ||
    PASSWORD_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '');
  if (!password || NOT_WEBKIT.test(ua)) {
    return false;
  }
  // Real WebKit reports 600+; Blink froze 537.36, and so do test DOMs that borrow its string.
  return 600 <= Number(/AppleWebKit\/(\d+)/.exec(ua)?.[1] ?? 0);
}

export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  // Realm-aware: a controlled input inside a same-origin frame has its own prototype.
  const proto = valuePrototypeOf(el);
  const setter = proto === undefined ? undefined : captureValueSetter(proto);
  if (setter !== undefined) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  const notPrevented = el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return !notPrevented;
}

/**
 * Refuse to write to a field a person could not edit.
 *
 * `readonly` and `disabled` block USER input, not scripted assignment, so the prototype value setter
 * writes straight through both. Measured: filling a readonly input reported `ok:true` and
 * `valueChanged:true` with nothing in the effect block marking it read-only. That leaves the app in a
 * state no user could reach, and every conclusion drawn from what follows is about software nobody
 * can operate — the same reason the click path reports `occluded`, and the same choice Playwright
 * makes when it refuses to fill a non-editable element.
 */
/**
 * A rich-text target is unsupported for `fill` and `type`, not a mistake by the caller.
 *
 * TipTap, Quill, ProseMirror, Slate, and Lexical set `contenteditable`. Monaco and CodeMirror do
 * not: they are a `role="textbox"` with the document in the EditContext API. Both used to read as
 * "you picked the wrong element". One sentence covers both, and it stays short because this file
 * is on the SDK's first load. `insertText` is the action that does work on them.
 *
 * The attribute, not only `isContentEditable`: jsdom does not implement the property, so a test
 * would pass against a guard that never fires in the environment the unit suite runs in.
 */
export function isRichText(el: Element): boolean {
  const flag = el.getAttribute('contenteditable');
  if ((isHtmlElement(el) && el.isContentEditable) || (null !== flag && 'false' !== flag)) {
    return true;
  }
  if ('textbox' === el.getAttribute('role')) {
    return true;
  }
  if (!('editContext' in el)) {
    return false;
  }
  const surface = el as HTMLElement & { editContext?: object | null };
  return null !== surface.editContext && undefined !== surface.editContext;
}

/** The roots Monaco and CodeMirror render around the hidden `<textarea>` that receives their input. */
const EDITOR_ROOT = '.monaco-editor, .CodeMirror, .cm-editor';

/**
 * A `<textarea>` that is the input surface of a code editor, not a plain field.
 *
 * Monaco keeps its input in a hidden `<textarea role="textbox">` and merges whatever is written
 * there with its own model, so a direct value write reports `valueChanged:true` while the editor
 * ends up with the old and new text together. An explicit `role="textbox"` or a known editor root
 * marks it; a bare `<textarea>` is a real field and still fills.
 */
function isEditorTextArea(el: ActionTarget): boolean {
  if (!isTextArea(el)) {
    return false;
  }
  return 'textbox' === el.getAttribute('role') || null !== el.closest(EDITOR_ROOT);
}

function refuseEditor(action: string): never {
  throw new Error(
    `cannot ${action} a contenteditable or EditContext editor; use the insertText action, or press for a key`,
  );
}

export function assertNotRichText(el: ActionTarget, action: string): void {
  if (!isRichText(el)) {
    return;
  }
  refuseEditor(action);
}

/** Refuse a value write into an editor's `<textarea>` before the plain-field branch takes it. */
export function assertNotEditorTextArea(el: ActionTarget, action: string): void {
  if (isEditorTextArea(el)) {
    refuseEditor(action);
  }
}

export function assertEditable(el: HTMLInputElement | HTMLTextAreaElement, action: string): void {
  if (el.disabled) {
    throw new Error(
      `cannot ${action} a disabled <${el.tagName.toLowerCase()}> — a user could not edit it, so forcing the value would put the app in a state nobody can reach`,
    );
  }
  if (el.readOnly) {
    throw new Error(
      `cannot ${action} a readonly <${el.tagName.toLowerCase()}> — a user could not edit it, so forcing the value would put the app in a state nobody can reach`,
    );
  }
}

/**
 * Insert plain text into a rich-text surface through the browser editing pipeline, so the
 * editor's own model (ProseMirror, Tiptap, Quill, Lexical, Slate …) updates and the app sees a real
 * edit.
 *
 * Writing `textContent` directly would touch the DOM while the editor's model kept the old value
 * — a false green on exactly the surfaces this is for. Instead:
 *
 * 1. Focus the surface and collapse the selection to its end.
 * 2. On an EditContext surface (Monaco, CodeMirror 6), update the EditContext text and selection
 *    directly: that object IS the editor's model.
 * 3. Dispatch `beforeinput` first. An editor that owns its input (Lexical, Slate, an input-owning
 *    Quill) cancels this and applies the text to its model. It sees nothing later: the native
 *    command below does not fire `beforeinput` when called from script. Measured in Chromium,
 *    `execCommand("insertText")` fires `input` with `cancelable: false` and no `beforeinput`, so
 *    announcing after the fact left those editors' models stale.
 * 4. Let the browser perform the edit with `execCommand("insertText", false, text)`. It fires
 *    `input`, the event a ProseMirror DOM observer reconciles from.
 * 5. Where the engine has no native command (jsdom), write the text at the caret and dispatch
 *    `input` with `inputType: "insertText"`. A command that EXISTS and fails is refused instead:
 *    the surface was not editable at that moment, so a DOM write would change `textContent` while
 *    the editor's model kept the old value — the false green this action exists to avoid.
 *
 * Returns the primary event's `defaultPrevented`. On an editor that owns its input (Lexical,
 * Slate), cancelling `beforeinput` is the SUCCESS path: the editor took the text. Read it with
 * `valueChanged`: `true` plus `valueChanged: true` means the editor applied the edit, not that it
 * refused it.
 */
export function insertTextInto(el: ActionTarget, text: string): boolean {
  el.focus();
  // Put a collapsed range at the end of the surface when the selection is not already inside it,
  // so a fresh editor (no caret yet) receives the text after its existing content rather than at
  // an arbitrary place. A selection the caller set deliberately is left alone.
  const selection = window.getSelection();
  if (selection !== null && !selectionInside(selection, el)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // An EditContext surface is not contenteditable: its text lives in the EditContext object, not
  // the DOM. Update that model directly so the editor receives a real edit.
  const editContext = editContextOf(el);
  if (editContext !== null) {
    const start = editContext.selectionStart;
    const end = editContext.selectionEnd;
    editContext.updateText(start, end, text);
    editContext.updateSelection(start + text.length, start + text.length);
    return false;
  }

  // Announce the edit before performing it. The native command below never fires `beforeinput` from
  // script, so an editor that owns its model learns about the edit here or nowhere.
  const beforeInput = new InputEvent('beforeinput', {
    inputType: 'insertText',
    data: text,
    bubbles: true,
    cancelable: true,
  });
  if (!el.dispatchEvent(beforeInput)) {
    return true;
  }

  // The native command next: it is the one path ProseMirror's DOM observer reads, and it fires
  // `input` itself. It is also the only honest path in a real browser — writing the DOM when it
  // fails would change what `textContent` reads while the editor's model stayed on the old value.
  if ('function' !== typeof el.ownerDocument.execCommand) {
    // No native command (jsdom, an engine that dropped it): there is no editor model to
    // desynchronise, so the caret write is the honest path here.
    insertAtCaret(el, text);
    const input = new InputEvent('input', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
      cancelable: true,
    });
    return !el.dispatchEvent(input);
  }

  let sawInput = false;
  const recordInput = (event: Event): void => {
    if ('input' === event.type) {
      sawInput = true;
    }
  };
  window.addEventListener('input', recordInput, false);
  try {
    if (el.ownerDocument.execCommand('insertText', false, text)) {
      return false;
    }
  } catch {
    // A command that threw did not edit the surface either: fall through to the refusal.
  } finally {
    window.removeEventListener('input', recordInput, false);
  }
  if (sawInput) {
    return false;
  }

  throw new Error(
    'the editor did not accept the text: the native insertText command failed, so the editor model is unchanged. Check that the surface is editable and focused.',
  );
}

/** Write `text` at the current selection, or at the end when the selection is elsewhere. */
function insertAtCaret(el: ActionTarget, text: string): void {
  const selection = window.getSelection();
  const range = selection !== null && 0 < selection.rangeCount ? selection.getRangeAt(0) : null;
  if (range !== null && el.contains(range.commonAncestorContainer)) {
    range.deleteContents();
    const node = el.ownerDocument.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }
  el.appendChild(el.ownerDocument.createTextNode(text));
}

/** The subset of the EditContext API that inserting text needs. */
interface EditContextLike {
  selectionStart: number;
  selectionEnd: number;
  updateText(start: number, end: number, text: string): void;
  updateSelection(start: number, end: number): void;
}

/** The EditContext attached to `el`, when it has one (Monaco, CodeMirror 6). */
function editContextOf(el: Element): EditContextLike | null {
  if (!('editContext' in el)) {
    return null;
  }
  const surface = el as HTMLElement & { editContext?: EditContextLike | null };
  return surface.editContext ?? null;
}

/** True when the current selection's anchor sits inside `el`. */
function selectionInside(selection: Selection, el: Element): boolean {
  const anchor = selection.anchorNode;
  return anchor !== null && el.contains(anchor);
}
