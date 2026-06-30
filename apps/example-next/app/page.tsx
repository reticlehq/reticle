'use client';
import { useState } from 'react';

export default function Page() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Reticle × Next.js</h1>
      <button data-testid="counter" onClick={() => setCount((c) => c + 1)}>
        count: {count}
      </button>
    </main>
  );
}
