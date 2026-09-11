'use client';
import { useEffect } from 'react';

/** Dev-only: connect Reticle + install the React adapter, after hydration. */
export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void (async () => {
      const [browser, react] = await Promise.all([
        import('@reticlehq/browser'),
        import('@reticlehq/react'),
      ]);
      const { reticle, registerCapabilities } = browser;
      react.install();
      // The page's live state is registered from page.tsx via useReticleStore('page', ...) — the
      // correct pattern for Next's useState (no store object, and STATE_CHANGE diffs on every commit).
      // The old bare-getter placeholder here modelled the silent-store anti-pattern the docs warn
      // against, so it is gone; capabilities now advertises the real store name.
      registerCapabilities({
        testids: ['ping-button', 'add-task', 'edit-field', 'show-toast'],
        signals: ['field:committed'],
        stores: ['page'],
      });
      const token = process.env['NEXT_PUBLIC_RETICLE_TOKEN'];
      // This is a single-app E2E fixture: the test battery navigates to the bare URL and addresses it
      // by a known session id, so it pins a stable default ('next-smoke'). A real multi-app setup
      // should use the SDK's SESSION_AUTO default instead, so several apps/tabs on one machine never
      // collide on one session. Override the id per tab with ?session=<id>.
      const sessionParam = new URLSearchParams(window.location.search).get('session');
      reticle.connect({
        session: sessionParam !== null && sessionParam.length > 0 ? sessionParam : 'next-smoke',
        present: true,
        ...(typeof token === 'string' && token.length > 0 ? { token } : {}),
      });
    })();
  }, []);
  return null;
}
