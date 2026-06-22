'use client';
import { useEffect } from 'react';

/** Dev-only: connect Iris + install the React adapter, after hydration. */
export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void (async () => {
      const [browser, react] = await Promise.all([
        import('@syrin/iris-browser'),
        import('@syrin/iris-react'),
      ]);
      const { iris, registerStore, registerCapabilities } = browser;
      react.install();
      // Expose a "store" the agent can read directly via iris_state.
      registerStore('demo', () => ({ ready: true, tasks: 2 }));
      // Self-describe the testable surface so the agent learns it via iris_capabilities.
      registerCapabilities({
        testids: ['ping-button', 'add-task', 'edit-field', 'show-toast'],
        signals: ['field:committed'],
      });
      const token = process.env['NEXT_PUBLIC_IRIS_TOKEN'];
      // This is a single-app E2E fixture: the test battery navigates to the bare URL and addresses it
      // by a known session id, so it pins a stable default ('next-smoke'). A real multi-app setup
      // should use the SDK's SESSION_AUTO default instead, so several apps/tabs on one machine never
      // collide on one session. Override the id per tab with ?session=<id>.
      const sessionParam = new URLSearchParams(window.location.search).get('session');
      iris.connect({
        session: sessionParam !== null && sessionParam.length > 0 ? sessionParam : 'next-smoke',
        present: true,
        ...(typeof token === 'string' && token.length > 0 ? { token } : {}),
      });
    })();
  }, []);
  return null;
}
