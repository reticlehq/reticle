import { useState } from 'react';

export function meta() {
  return [{ title: 'Iris × React Router' }];
}

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Iris × React Router 7</h1>
      <button data-testid="counter" onClick={() => setCount((c) => c + 1)}>
        count: {count}
      </button>
    </main>
  );
}
