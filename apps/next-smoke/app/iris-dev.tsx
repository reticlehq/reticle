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
      // G2 demo: expose a "store" the agent can read directly via iris_state.
      registerStore('demo', () => ({ ready: true, tasks: 2 }));
      // G5 demo: self-describe the testable surface so the agent learns it via iris_capabilities.
      registerCapabilities({
        testids: ['ping-button', 'add-task', 'edit-field', 'show-toast'],
        signals: ['field:committed'],
      });
      const token = process.env['NEXT_PUBLIC_IRIS_TOKEN'];
      iris.connect({
        session: 'next-smoke',
        present: true,
        ...(typeof token === 'string' && token.length > 0 ? { token } : {}),
      });
    })();
  }, []);
  return null;
}
