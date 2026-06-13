'use client';
import { useEffect } from 'react';

/** Dev-only: connect Iris + install the React adapter, after hydration. */
export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void (async () => {
      const [{ iris }, react] = await Promise.all([import('@iris/browser'), import('@iris/react')]);
      react.install();
      iris.connect({ session: 'next-smoke', present: true });
    })();
  }, []);
  return null;
}
