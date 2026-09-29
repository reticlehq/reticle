import Link from 'next/link';
import { addNote } from './actions';
import { SaveBoth } from './save-both';
import { notes, tags } from './store';

/**
 * A SERVER ACTION — a mutation with no fetch and no JSON.
 *
 * Reticle's whole network picture comes from patching `fetch`/XHR in the page. A server action is
 * neither: React posts to the CURRENT url with a `Next-Action` header and a multipart body, and the
 * response is an RSC payload, not JSON. The question is whether a write that reaches the server this
 * way appears in `reticle_network` at all — because if it does not, every server-action app has its
 * entire mutation surface invisible, which is the desktop-IPC blind spot in a different costume.
 *
 * TWO actions live here and one button fires both, so the page also proves that distinct action ids
 * stay distinct writes when the bodies are the multipart bodies Reticle cannot fingerprint.
 */
export const dynamic = 'force-dynamic';

export default function ActionsPage() {
  return (
    <main style={{ padding: 24 }}>
      <h1 data-testid="actions-heading">Server actions</h1>
      <form action={addNote} style={{ display: 'flex', gap: 8 }}>
        <input data-testid="note-input" name="note" placeholder="a note" />
        <button data-testid="save-note" type="submit">
          Save note
        </button>
      </form>
      <ul data-testid="note-list">
        {notes.map((n, i) => (
          <li key={`${n}-${String(i)}`}>{n}</li>
        ))}
      </ul>
      <p data-testid="note-count">{notes.length} notes</p>
      <div style={{ marginTop: 12 }}>
        <SaveBoth />
      </div>
      <ul data-testid="tag-list">
        {tags.map((t, i) => (
          <li key={`${t}-${String(i)}`}>{t}</li>
        ))}
      </ul>
      <p data-testid="tag-count">{tags.length} tags</p>
      <nav style={{ marginTop: 24, display: 'flex', gap: 12 }}>
        <Link href="/" data-testid="link-home">
          Home
        </Link>
        <Link href="/rsc" data-testid="link-rsc">
          Server component
        </Link>
      </nav>
    </main>
  );
}
