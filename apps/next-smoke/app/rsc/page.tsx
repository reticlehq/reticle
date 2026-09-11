import { Suspense } from 'react';
import Link from 'next/link';

/**
 * A SERVER component that streams.
 *
 * Everything Reticle was previously proven against on Next was one `'use client'` page — which is
 * React, not Next. The parts that make Next different are here: content produced on the server, a
 * Suspense boundary that flushes AFTER the shell, and a soft navigation that fetches an RSC payload
 * rather than a document.
 *
 * The question this exists to answer: a streamed boundary lands ~900 ms after the page looks
 * finished. Does the SDK observe it as DOM movement, and does `settled` wait for it — or does the
 * shell going quiet read as "the page is done" while half the content is still in flight?
 */
export const dynamic = 'force-dynamic';

async function SlowRows() {
  // No client involvement at all: this resolves on the server and streams into the boundary.
  await new Promise((resolve) => setTimeout(resolve, 900));
  const rows = ['streamed-1', 'streamed-2', 'streamed-3'];
  return (
    <ul data-testid="streamed-rows">
      {rows.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

export default function RscPage() {
  return (
    <main style={{ padding: 24 }}>
      <h1 data-testid="rsc-heading">Server component</h1>
      <p data-testid="rsc-shell">This shell renders immediately.</p>
      <Suspense fallback={<p data-testid="rsc-fallback">loading rows…</p>}>
        <SlowRows />
      </Suspense>
      <nav style={{ marginTop: 24, display: 'flex', gap: 12 }}>
        <Link href="/" data-testid="link-home">
          Home
        </Link>
        <Link href="/actions" data-testid="link-actions">
          Server actions
        </Link>
      </nav>
    </main>
  );
}
