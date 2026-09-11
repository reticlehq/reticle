import { useEffect, useRef } from 'react';
import { pushStore, registerStore, unregisterStore } from '@reticlehq/browser';

/**
 * Register React state that has no readable store object — Context, `useState`, `useReducer`.
 *
 * Every other state library can be adapted because it owns a store instance you can call `getState`
 * on from anywhere. React's built-in state owns nothing of the kind: the value lives inside the fiber
 * tree, and the only "subscription" is a re-render. There is no public API to read it from outside a
 * component, so no adapter over React's surface can exist — the direction has to be inverted. The
 * component that holds the value pushes it out on every render where it changed.
 *
 * That inversion is why this is a hook and lives in `@reticlehq/react/store` rather than beside the
 * other adapters: it is the one case that requires running inside React. This subpath is also the only
 * module in the package that imports `react` at all — the main entry stays import-free so the adapter
 * keeps working in builds where React is not resolvable.
 *
 * ```tsx
 * function CartProvider({ children }) {
 *   const [cart, dispatch] = useReducer(cartReducer, initial);
 *   useReticleStore('cart', cart);            // one line; agent can now read + assert on cart
 *   return <CartContext.Provider value={cart}>{children}</CartContext.Provider>;
 * }
 * ```
 */
export function useReticleStore(name: string, value: unknown): void {
  // Created once and kept in a ref: a store rebuilt each render would hand every listener a dead
  // closure, so STATE_CHANGE would fire against a store nothing is subscribed to any more.
  const handle = useRef<ReturnType<typeof pushStore> | null>(null);
  handle.current ??= pushStore(value);

  useEffect(() => {
    const current = handle.current;
    if (null === current) return;
    registerStore(name, current.store);
    return () => unregisterStore(name);
  }, [name]);

  // Push AFTER commit, not during render. Notifying subscribers mid-render would emit a state change
  // for a value the DOM has not shown yet, and an agent comparing store against screen at that moment
  // would see a desync that does not exist — a false positive manufactured by the instrumentation.
  useEffect(() => {
    handle.current?.push(value);
  }, [value]);
}
