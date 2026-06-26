import { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Iris × Vite + React</h1>
      <button data-testid="counter" onClick={() => setCount((c) => c + 1)}>
        count: {count}
      </button>
    </main>
  );
}
