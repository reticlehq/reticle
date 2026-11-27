import { Suspense } from 'react';
import { SlowHydrate } from './slow-hydrate';
import { Reveal } from './reveal';

/**
 * A server-rendered button whose Suspense boundary hydrates late (#1654).
 *
 * `?delay=<ms>` holds hydration of the boundary for that long on the client. The server renders the
 * button at once, so it is on the page and a query finds it. Until the boundary hydrates, React has
 * not attached its handler, and a click on it does nothing. Without `?delay`, nothing is held.
 */
export const dynamic = 'force-dynamic';

export default function HydratePage() {
  return (
    <main style={{ padding: 24 }}>
      <h1 data-testid="hydrate-heading">Slow hydration</h1>
      <Suspense fallback={<p>loading</p>}>
        <SlowHydrate>
          <Reveal />
        </SlowHydrate>
      </Suspense>
    </main>
  );
}
