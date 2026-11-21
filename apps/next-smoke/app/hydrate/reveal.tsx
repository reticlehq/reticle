'use client';
import { useState } from 'react';

/** A button that works only once React attached its handler. */
export function Reveal() {
  const [shown, setShown] = useState(false);
  return (
    <section>
      <button data-testid="reveal" onClick={() => setShown(true)}>
        Reveal
      </button>
      {shown ? <p data-testid="revealed">Revealed</p> : null}
    </section>
  );
}
