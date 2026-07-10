'use client';
import { useEffect } from 'react';

/** Dev-only: connect Reticle after hydration (Next renders server-side; the SDK connects on the client). */
export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    // withReticle forwards the daemon's pairing token as process.env.RETICLE_PAIRING_TOKEN (inlined
    // into the client bundle). The bridge requires it even on localhost; present it when it's there.
    const token = process.env.RETICLE_PAIRING_TOKEN;
    void import('@reticlehq/react').then(({ reticle, install }) => {
      install();
      reticle.connect({
        projectId: 'example-next',
        ...(token !== undefined && token.length > 0 ? { token } : {}),
      });
    });
  }, []);
  return null;
}
