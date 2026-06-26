'use client';
import { useEffect } from 'react';

/** Dev-only: connect Iris after hydration (Next renders server-side; the SDK connects on the client). */
export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@syrin/iris').then(({ iris, install }) => {
      install();
      iris.connect({ projectId: 'example-next' });
    });
  }, []);
  return null;
}
