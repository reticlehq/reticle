import Link from 'next/link';
import { revalidatePath } from 'next/cache';

/**
 * A SERVER ACTION — a mutation with no fetch and no JSON.
 *
 * Reticle's whole network picture comes from patching `fetch`/XHR in the page. A server action is
 * neither: React posts to the CURRENT url with a `Next-Action` header and a multipart body, and the
 * response is an RSC payload, not JSON. The question is whether a write that reaches the server this
 * way appears in `reticle_network` at all — because if it does not, every server-action app has its
 * entire mutation surface invisible, which is the desktop-IPC blind spot in a different costume.
 */
export const dynamic = 'force-dynamic';

const notes: string[] = [];

export default function ActionsPage() {
  async function addNote(formData: FormData) {
    'use server';
    const text = String(formData.get('note') ?? '').trim();
    // Deliberately server-side, deliberately silent on failure: the form still says it worked.
    if (text.length > 0) notes.push(text);
    revalidatePath('/actions');
  }

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
