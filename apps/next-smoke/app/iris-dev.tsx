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
      const { iris, registerStore, registerCapabilities, SESSION_AUTO } = browser;
      react.install();
      // Expose a "store" the agent can read directly via iris_state.
      registerStore('demo', () => ({ ready: true, tasks: 2 }));
      // Self-describe the testable surface so the agent learns it via iris_capabilities.
      registerCapabilities({
        testids: ['ping-button', 'add-task', 'edit-field', 'show-toast'],
        signals: ['field:committed'],
      });
      const token = process.env['NEXT_PUBLIC_IRIS_TOKEN'];
      // SESSION_AUTO gives this tab/app a unique session id, so several Next apps (or tabs) on the
      // same machine never collide on one session and silently evict each other. Pass an explicit
      // ?session=<id> only when two tabs should intentionally share a session.
      iris.connect({
        session: SESSION_AUTO,
        present: true,
        ...(typeof token === 'string' && token.length > 0 ? { token } : {}),
      });
    })();
  }, []);
  return null;
}
