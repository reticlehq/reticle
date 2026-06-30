import { useState } from 'react';

export function meta() {
  return [{ title: 'Reticle × React Router' }];
}

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Reticle × React Router 7</h1>
      <button data-testid="counter" onClick={() => setCount((c) => c + 1)}>
        count: {count}
      </button>
    </main>
  );
}
