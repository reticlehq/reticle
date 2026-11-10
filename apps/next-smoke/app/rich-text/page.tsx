'use client';
import { useEffect, useRef } from 'react';
import type { EditorView } from 'prosemirror-view';

/**
 * A real ProseMirror editor, for the e2e proof that `insertText` changes the editor's OWN document.
 *
 * The unit tests drive a mock DOM and can show that the events fire. ProseMirror keeps its document
 * in its own model, so the honest question is whether that model holds the text afterwards.
 * `proseMirrorText` below answers it from the editor's state, not from `textContent`: a DOM write
 * that the model never saw reads as success in the DOM and as nothing here.
 *
 * This route is a fixture and is not linked from the home page, so no other spec's snapshot of the
 * app changes. `apps/e2e/specs/insert-text-rich-editor-test.mjs` drives it.
 */
export default function RichTextPage(): React.ReactElement {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let view: EditorView | null = null;
    let cancelled = false;
    // Imported in the browser, not at module scope: ProseMirror reads the DOM, and this page is
    // pre-rendered on the server before it hydrates.
    void (async () => {
      const [{ EditorState }, { EditorView: View }, { schema }] = await Promise.all([
        import('prosemirror-state'),
        import('prosemirror-view'),
        import('prosemirror-schema-basic'),
      ]);
      if (cancelled || null === host.current) {
        return;
      }
      view = new View(host.current, {
        state: EditorState.create({ schema }),
        attributes: {
          'data-testid': 'rich-text-editor',
          'aria-label': 'Rich text editor',
          style:
            'min-height:96px;padding:10px;border:1px solid #333;border-radius:6px;background:#12151c',
        },
      });
      (globalThis as unknown as { proseMirrorText?: () => string }).proseMirrorText = () =>
        null === view ? '' : view.state.doc.textBetween(0, view.state.doc.content.size, '\n');
    })();
    return () => {
      cancelled = true;
      view?.destroy();
      delete (globalThis as unknown as { proseMirrorText?: () => string }).proseMirrorText;
    };
  }, []);

  return (
    <main style={{ padding: 40, maxWidth: 720, margin: '0 auto' }}>
      <h1 data-testid="rich-text-heading">Rich-text editor</h1>
      <p style={{ color: '#9aa3b2' }}>
        A ProseMirror editor. Its own document holds the text; the DOM is only how it is shown.
      </p>
      <div ref={host} />
    </main>
  );
}
