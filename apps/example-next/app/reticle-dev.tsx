'use client';
import { useEffect } from 'react';

/** Dev-only: connect Reticle after hydration (Next renders server-side; the SDK connects on the client). */
export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@reticlehq/react').then(({ reticle, install }) => {
      install();
      reticle.connect({ projectId: 'example-next' });
    });
  }, []);
  return null;
}
