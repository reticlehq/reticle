import type { ActionTarget } from '@/dom/realm.js';
import { isRichText } from './value-input.js';

/**
 * The `insertText` action: check the arguments and the surface, then perform the edit.
 *
 * Everything this action needs lives in this module, so the dispatcher only pays for a one-line
 * dynamic import and a page that never inserts text downloads none of it.
 */
export function insertText(el: ActionTarget, text: unknown): boolean {
  if (typeof text !== 'string') {
    throw new Error(
      "insertText requires a string `text` — pass it nested, as args: { text: '…' }.",
    );
  }
  if (!isRichText(el)) {
    throw new Error(
      `cannot insertText into a <${el.tagName.toLowerCase()}> — insertText needs a contenteditable rich-text editor (Tiptap, ProseMirror, Quill), not this surface`,
    );
  }
  if (hasEditContext(el)) {
    throw new Error(
      'cannot insertText into an EditContext editor (Monaco, CodeMirror 6): code that calls updateText does not fire textupdate, so the editor model would keep the old text. Use press for a key.',
    );
  }
  return insertTextInto(el, text);
}

/** True when the surface keeps its text in an EditContext object instead of the DOM. */
function hasEditContext(el: Element): boolean {
  if (!('editContext' in el)) {
    return false;
  }
  const surface = el as HTMLElement & { editContext?: object | null };
  return null !== surface.editContext && undefined !== surface.editContext;
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
 * 2. Dispatch `beforeinput` first. An editor that owns its input (Lexical, Slate, an input-owning
 *    Quill) cancels this and applies the text to its model. It sees nothing later: the native
 *    command below does not fire `beforeinput` when called from script. Measured in Chromium,
 *    `execCommand("insertText")` fires `input` with `cancelable: false` and no `beforeinput`, so
 *    announcing after the fact left those editors' models stale.
 * 3. Let the browser perform the edit with `execCommand("insertText", false, text)`. It fires
 *    `input`, the event a ProseMirror DOM observer reconciles from.
 * 4. Where the engine has no native command (jsdom), write the text at the caret and dispatch
 *    `input` with `inputType: "insertText"`. A command that EXISTS and fails is refused instead:
 *    the surface was not editable at that moment, so a DOM write would change `textContent` while
 *    the editor's model kept the old value — the false green this action exists to avoid.
 *
 * Returns the primary event's `defaultPrevented`. On an editor that owns its input (Lexical,
 * Slate), cancelling `beforeinput` is the SUCCESS path: the editor took the text. Read it with
 * `valueChanged`: `true` plus `valueChanged: true` means the editor applied the edit, not that it
 * refused it.
 *
 * This module is imported only when an `insertText` action runs, so none of it is downloaded by a
 * page that merely loads the SDK.
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

/** True when the current selection's anchor sits inside `el`. */
function selectionInside(selection: Selection, el: Element): boolean {
  const anchor = selection.anchorNode;
  return anchor !== null && el.contains(anchor);
}
